import type { Pool } from 'pg';
import { z } from 'zod';
import {
  BILLING_PROVIDER,
  billingCheckoutSellablePlanSchema,
  billingIntervalSchema,
  billingSyncStateSchema,
  commercialPlanIdSchema,
  internalPlanForCommercialPlan,
  subscriptionStatusSchema,
  userPlanSchema,
  type BillingPortalCommercialIdentity,
  type BillingPortalFacts,
  type SubscriptionStatus,
} from '@veltrixeye/contracts';

/**
 * Billing Portal v1 — the READ-ONLY overview read.
 *
 * This module owns exactly one job: read the authenticated user's OWN billing
 * rows and hand `BillingPortalFacts` (contracts) to the pure projection. It
 * takes a `userId` that the CALLER derived from the authenticated session —
 * there is no route, body field or query parameter through which a browser
 * could choose the subject — and it never writes anything:
 *
 * ```text
 * subscriptions (1 row per user)              → plan, status, provider, commercial identity,
 *                                               period end, cancellation state, review flags
 * billing_subscription_activations  (EXISTS)  → activated   (the ONLY payment authority)
 * billing_verified_transactions     (EXISTS)  → evidenceRecorded (a receipt, never authority)
 * ```
 *
 * WHAT IT DOES NOT DO
 *  - It does not ACTIVATE, confirm, verify or synchronize anything: all three
 *    reads are `SELECT`s, and the activation fact is only ever written by the
 *    out-of-band operator CLI (`BillingActivationService`).
 *  - It does not call a provider: no adapter, no registry, no credential, no
 *    HTTP. The portal cannot observe the provider, so it cannot claim anything
 *    the provider would have to confirm.
 *  - It does not compute a renewal date: `current_period_end` is read as it was
 *    persisted, and a missing one stays `null`.
 *  - It does not touch entitlements: it never writes `users.plan`,
 *    `subscriptions.plan` or `subscriptions.status`, never resolves an
 *    entitlement and never grants one. The liveness question below decides only
 *    whether a row may be DESCRIBED as carrying a paid period, and it is pinned
 *    against the entitlement matrix by `test/billing-portal.test.ts` so the two
 *    can never drift apart.
 *  - It does not leak. Everything it reads that a DTO must not carry (row ids,
 *    provider codes, pricing locks, event keys) is dropped before the facts
 *    object exists — the query does not even select those columns.
 *
 * A row this build does not understand is a hard failure (the row schema is
 * `.strict()` and every vocabulary is the canonical one), so the API answers
 * `UNAVAILABLE_BILLING_PORTAL_SUMMARY` instead of forwarding a partially
 * understood row.
 */

/* -------------------------------------------------------------------------- */
/* Row contract                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Exactly the columns this read needs. The list is the boundary: the query
 * selects these and nothing else, so a sensitive column (a provider code, a
 * reference, an idempotency key, a pricing-lock id) cannot reach the facts by
 * accident.
 */
const portalRowSchema = z
  .object({
    plan: userPlanSchema,
    status: subscriptionStatusSchema,
    provider: z.literal(BILLING_PROVIDER).nullable(),
    catalogue_plan: commercialPlanIdSchema.nullable(),
    billing_interval: billingIntervalSchema.nullable(),
    current_period_end: z.union([z.date(), z.string().datetime()]).nullable(),
    cancel_at_period_end: z.boolean(),
    sync_state: billingSyncStateSchema,
    sync_required: z.boolean(),
    activated: z.boolean(),
    evidence_recorded: z.boolean(),
  })
  .strict();

/** The columns the read selects, in one place so the contract and SQL cannot drift. */
export const BILLING_PORTAL_ROW_COLUMNS = [
  'plan', 'status', 'provider', 'catalogue_plan', 'billing_interval',
  'current_period_end', 'cancel_at_period_end', 'sync_state', 'sync_required',
] as const;

/**
 * The facts for an account with no `subscriptions` row — Model C's free state.
 * Nothing is provider-backed, nothing is activated and nothing is owed; the
 * commercial fields are absent because there is nothing to state.
 */
function absentSubscriptionFacts(): BillingPortalFacts {
  return {
    subscriptionPresent: false,
    providerBacked: false,
    internalPlan: 'free',
    commercial: null,
    // No row means no lifecycle: `free` is not a paid period, and nothing is
    // claimed about a period that does not exist.
    lifecycleLive: false,
    activated: false,
    evidenceRecorded: false,
    requiresOperatorReview: false,
    periodEnd: null,
    cancelAtPeriodEnd: false,
  };
}

/**
 * The lifecycle statuses that carry a PAID period: `active`, `trialing` and
 * `past_due`. They are exactly the statuses for which the entitlement matrix
 * (`./entitlements.ts`) returns a paid tier, and `test/billing-portal.test.ts`
 * pins this list against that matrix — the matrix stays the enforcement
 * authority and this module never becomes a second one.
 *
 * Read it only as a DISPLAY rule: it decides whether a row may be described as
 * carrying a paid subscription. It resolves no entitlement, widens no limit and
 * is never consulted by an enforcement path.
 */
export const BILLING_PORTAL_LIVE_LIFECYCLE_STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'trialing',
  'past_due',
];

/** Whether the row's authoritative lifecycle still carries a paid period. */
export function billingPortalLifecycleLive(status: SubscriptionStatus): boolean {
  return BILLING_PORTAL_LIVE_LIFECYCLE_STATUSES.includes(status);
}

/**
 * The commercial identity the row may state: a SELLABLE catalogue plan (Starter
 * has no internal plan value and is never persisted) whose canonical mapping
 * equals the row's internal plan, with an interval. Anything else — a missing
 * catalogue plan, a rogue `starter` row, a mapping disagreement, a plan without
 * an interval — is not a commercial identity, and the portal says `unknown`
 * rather than publishing a plan it cannot vouch for.
 */
function commercialIdentity(
  cataloguePlan: string | null,
  interval: string | null,
  internalPlan: string,
): BillingPortalCommercialIdentity | null {
  const sellable = billingCheckoutSellablePlanSchema.safeParse(cataloguePlan);
  const parsedInterval = billingIntervalSchema.safeParse(interval);
  if (!sellable.success || !parsedInterval.success) return null;
  if (internalPlanForCommercialPlan(sellable.data) !== internalPlan) return null;
  return { cataloguePlan: sellable.data, interval: parsedInterval.data };
}

/* -------------------------------------------------------------------------- */
/* The read                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Read the overview facts for ONE user id, which the caller derived from the
 * authenticated session. Read-only and fail-closed: an unparseable row raises
 * (the API then answers `unavailable`) and nothing is ever written.
 */
export async function readBillingPortalFacts(db: Pool, userId: string): Promise<BillingPortalFacts> {
  const { rows } = await db.query(
    `SELECT plan, status, provider, catalogue_plan, billing_interval,
            current_period_end, cancel_at_period_end, sync_state, sync_required,
            EXISTS (
              SELECT 1 FROM billing_subscription_activations a
               WHERE a.subscription_id = s.id
            ) AS activated,
            EXISTS (
              SELECT 1 FROM billing_verified_transactions t
               WHERE t.subscription_id = s.id
            ) AS evidence_recorded
       FROM subscriptions s
      WHERE s.user_id = $1`,
    [userId],
  );

  // Model C: a user without a `subscriptions` row IS the free state.
  if (rows.length === 0) return absentSubscriptionFacts();

  const row = portalRowSchema.safeParse(rows[0]);
  if (!row.success) {
    // A row this build does not fully understand is refused, never degraded
    // into a permissive default. The reason stays server-side.
    throw new Error(
      `The stored subscription is not usable by the billing portal: ${row.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const r = row.data;
  const periodEnd =
    r.current_period_end === null
      ? null
      : (r.current_period_end instanceof Date ? r.current_period_end : new Date(r.current_period_end)).toISOString();

  return {
    subscriptionPresent: true,
    providerBacked: r.provider !== null,
    internalPlan: r.plan,
    // Only a provider-backed row has a commercial identity to state: a
    // historical (`provider IS NULL`) row is never presented as commercial.
    commercial: r.provider === null
      ? null
      : commercialIdentity(r.catalogue_plan, r.billing_interval, r.plan),
    lifecycleLive: billingPortalLifecycleLive(r.status),
    activated: r.activated,
    evidenceRecorded: r.evidence_recorded,
    requiresOperatorReview: r.sync_state === 'conflict' || r.sync_required,
    periodEnd,
    cancelAtPeriodEnd: r.cancel_at_period_end,
  };
}
