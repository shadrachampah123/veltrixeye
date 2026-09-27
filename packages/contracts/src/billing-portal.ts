import { z } from 'zod';
import { billingIntervalSchema, type BillingInterval } from './billing-catalogue.js';
import {
  billingCheckoutSellablePlanSchema,
  type BillingCheckoutSellablePlan,
} from './billing-checkout.js';
import { billingIsoDateTimeSchema } from './billing-refs.js';
import type { UserPlan } from './users.js';

/**
 * Billing Portal v1 — the READ-ONLY billing overview contracts.
 *
 * WHAT THIS MODULE IS
 *
 * One strict, minimal response shape (`BillingPortalSummaryDto`) for
 * `GET /api/billing/portal`, plus the two pure functions that produce it from
 * server-derived facts:
 *
 *   `readBillingPortalFacts()` (core, DB)   →  `resolveBillingPortalState()`
 *                                           →  `projectBillingPortalSummary()`
 *
 * The DTO is a PROJECTION, never a pass-through of the billing tables. It
 * carries exactly four display facts — the state, the commercial plan + billing
 * interval, the trusted PERSISTED period end and the authoritative cancellation
 * state — and nothing else. It deliberately does not reuse the broader
 * `GET /api/billing/me` shape (subscription row + entitlements + provider
 * status): that shape carries the subscription id and provider-facing display
 * values this surface has no use for.
 *
 * WHAT IT MUST NEVER CONTAIN (the sensitive-field boundary)
 *  - no internal identity: no user, customer, subscription, pricing-snapshot or
 *    evidence id;
 *  - no provider identity: no provider customer/subscription/plan code, no
 *    transaction or checkout reference, no provider name or state;
 *  - no reusable material: no email verification token, no authorization code,
 *    no key, no secret and no reusable authorization value;
 *  - no card/bank data, no raw provider payload, no raw provider error;
 *  - no evidence hash, no idempotency key, no pricing snapshot (amount, FX rate,
 *    rounding, catalogue/policy version), no operator activation detail.
 *
 * Every object below is `.strict()`, so an unknown field is a validation
 * failure rather than a silent pass-through, and the projection input interface
 * does not even NAME the omitted fields — which is what makes the omission a
 * property of the code rather than a convention at a call site.
 *
 * WHAT IT MUST NEVER DO
 *  - It never ACTIVATES anything. `activated` is not a decision this module
 *    makes: it is read from the durable activation fact (migration 0034) that
 *    only the out-of-band operator CLI writes. A locally stored
 *    `status = 'active'` is NOT a payment confirmation, and neither verified
 *    payment evidence nor a provider state is authority.
 *  - It never CALCULATES a renewal date. There is no interval arithmetic
 *    anywhere in this file: a period end is published only when the server
 *    already persisted one, and a missing one is reported as `null` (the
 *    UI renders "unavailable" rather than a guess).
 *  - It never grants execution. `canAccessAutomation` and `grantsExecution` are
 *    `z.literal(false)`, and entitlement resolution is untouched: every invariant
 *    of `packages/core/src/billing/entitlement-resolution.ts` still holds.
 */

/* -------------------------------------------------------------------------- */
/* The six states                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The states the read-only overview must keep visibly distinct:
 *
 *  - `free` — no commercial subscription exists for this account (Model C: the
 *    absent `subscriptions` row IS the free state), or the row on file is a
 *    non-commercial (`provider IS NULL`, `plan = 'free'`) one. Nothing is owed
 *    and no paid entitlement is in force.
 *  - `awaiting_verification` — a provider-backed row exists (a checkout was
 *    created) and neither verified evidence nor an activation fact has been
 *    recorded. The row's `status = 'active'` is a checkout artefact, not a
 *    payment, so the account is stated as awaiting verification and the free
 *    tier is what the server enforces.
 *  - `evidence_awaiting_activation` — verified payment EVIDENCE exists for this
 *    checkout (migration 0033) and the immutable ACTIVATION fact does not. A
 *    receipt is not an activation: the account is still free-entitled until an
 *    operator authorizes the activation out of band.
 *  - `activated` — the durable activation fact exists AND the row's
 *    authoritative lifecycle still carries a paid entitlement. This is the only
 *    state in which the portal states a paid subscription, and it restates a
 *    server-side fact: nothing a browser sends can produce it.
 *  - `unknown` — the server holds a row it cannot honestly classify: a
 *    commercial row with no coherent commercial identity, a row flagged for
 *    operator review (`sync_state = 'conflict'` / `sync_required`), a row whose
 *    authoritative lifecycle no longer carries a paid entitlement, or a
 *    non-commercial (`provider IS NULL`) row whose internal plan is paid. The
 *    portal claims nothing in this state — no plan, no renewal, no cancellation.
 *  - `unavailable` — the billing summary could not be produced at all (the read
 *    failed, or the row could not be projected safely). Nothing is claimed, no
 *    reason is published, and the surface shows unavailable copy instead of
 *    guessing.
 */
export const BILLING_PORTAL_STATES = [
  'free',
  'awaiting_verification',
  'evidence_awaiting_activation',
  'activated',
  'unknown',
  'unavailable',
] as const;
export type BillingPortalState = (typeof BILLING_PORTAL_STATES)[number];
export const billingPortalStateSchema = z.enum(BILLING_PORTAL_STATES);

/**
 * The states in which the server is stating a subscription, and therefore the
 * only states that may carry a plan, a period end or a cancellation state.
 * `free`, `unknown` and `unavailable` state NO subscription: every optional
 * field is `null` in those states (enforced by the DTO's `superRefine`).
 */
export const BILLING_PORTAL_SUBSCRIPTION_STATES = [
  'awaiting_verification',
  'evidence_awaiting_activation',
  'activated',
] as const satisfies readonly BillingPortalState[];

function statesASubscription(state: BillingPortalState): boolean {
  return (BILLING_PORTAL_SUBSCRIPTION_STATES as readonly string[]).includes(state);
}

/* -------------------------------------------------------------------------- */
/* The summary DTO                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The commercial plan and billing interval a provider-backed subscription was
 * sold as — the SAME two facts a checkout locks, read back from the
 * authoritative row.
 *
 * The plan vocabulary is the sellable catalogue set (`pro` / `elite`, the only
 * plans with an internal plan value). Starter has no internal plan value and is
 * refused by the checkout and by the database, so it can never be stated here;
 * a row carrying anything else is `unknown`.
 *
 * Deliberately absent: the amount, the currency, the FX rate, the catalogue
 * version and the provider plan code. The overview shows WHAT is subscribed,
 * never what it was priced at.
 */
export const billingPortalPlanDtoSchema = z
  .object({
    cataloguePlan: billingCheckoutSellablePlanSchema,
    interval: billingIntervalSchema,
  })
  .strict();
export type BillingPortalPlanDto = z.infer<typeof billingPortalPlanDtoSchema>;

/**
 * The ONE billing shape this surface publishes. Strict in both directions: the
 * projection cannot add a field, and a client that receives an unknown field is
 * looking at something this build did not produce.
 *
 * `periodEnd` is the trusted PERSISTED `subscriptions.current_period_end` —
 * null when the server has no such fact. It is never derived, never recomputed
 * from the interval and never extrapolated from the last activation: a missing
 * period end is reported as unavailable.
 *
 * `cancelAtPeriodEnd` is the authoritative cancellation state of the row. It is
 * `null` when the server is not stating a subscription; `false` means "stated:
 * the subscription is not scheduled to end at its period end".
 */
export const billingPortalSummaryDtoSchema = z
  .object({
    state: billingPortalStateSchema,
    plan: billingPortalPlanDtoSchema.nullable(),
    periodEnd: billingIsoDateTimeSchema.nullable(),
    cancelAtPeriodEnd: z.boolean().nullable(),
    /**
     * Pinned by type: a billing overview is not an execution grant. Automation,
     * live execution and broker execution stay OFF on every plan, whatever this
     * response says.
     */
    canAccessAutomation: z.literal(false),
    grantsExecution: z.literal(false),
  })
  .strict()
  .superRefine((summary, ctx) => {
    const subscription = statesASubscription(summary.state);
    if (subscription && summary.plan === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a "${summary.state}" summary must carry the commercial plan it states`,
      });
    }
    if (!subscription && summary.plan !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a "${summary.state}" summary states no subscription, so it cannot carry a plan`,
      });
    }
    if (summary.plan === null && summary.periodEnd !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a period end without a stated subscription is meaningless',
      });
    }
    if (summary.plan === null && summary.cancelAtPeriodEnd !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a cancellation state without a stated subscription is meaningless',
      });
    }
  });
export type BillingPortalSummaryDto = z.infer<typeof billingPortalSummaryDtoSchema>;

/**
 * The summary for a portal that could not be produced. Frozen and exported so
 * the API, a test and any future caller answer with the SAME object: the
 * unavailable state is a first-class answer (nothing is claimed), never an
 * error body, a retry hint or a partially filled summary.
 */
export const UNAVAILABLE_BILLING_PORTAL_SUMMARY: BillingPortalSummaryDto = Object.freeze(
  billingPortalSummaryDtoSchema.parse({
    state: 'unavailable',
    plan: null,
    periodEnd: null,
    cancelAtPeriodEnd: null,
    canAccessAutomation: false,
    grantsExecution: false,
  }),
);

/* -------------------------------------------------------------------------- */
/* The server-derived facts (never published)                                 */
/* -------------------------------------------------------------------------- */

/** The commercial identity of a row, as the server can state it. */
export interface BillingPortalCommercialIdentity {
  cataloguePlan: BillingCheckoutSellablePlan;
  interval: BillingInterval;
}

/**
 * The facts the overview is built from. Every one of them is derived
 * server-side from the authenticated user's OWN rows by
 * `readBillingPortalFacts()` (core) — none is accepted from a client, and this
 * interface deliberately has no room for one: there is no user, customer,
 * subscription or provider field here to bind a request to.
 *
 * There is also no field for a raw provider payload, a provider error, a
 * reference, a hash or a pricing snapshot, and the projection below reads this
 * object field by field — so an extra key on a facts object cannot reach the
 * DTO.
 */
export interface BillingPortalFacts {
  /** Whether the account has a `subscriptions` row at all. */
  subscriptionPresent: boolean;
  /** Whether that row was created by a commercial (provider) checkout. */
  providerBacked: boolean;
  /**
   * The row's INTERNAL plan value (`free` / `pro` / `premium`). Read to tell a
   * non-commercial free row apart from a non-commercial paid one; never
   * published.
   */
  internalPlan: UserPlan;
  /**
   * The commercial plan + interval, only when the authoritative row carries a
   * COHERENT commercial identity (sellable catalogue plan that maps onto the
   * row's internal plan, with an interval). `null` otherwise: an identity the
   * server cannot state is never invented.
   */
  commercial: BillingPortalCommercialIdentity | null;
  /**
   * Whether the row's authoritative lifecycle status still carries a paid
   * period. This is a DISPLAY classification (a live `active` / `trialing` /
   * `past_due` row), not an entitlement decision: the entitlement matrix stays
   * the enforcement authority, and the status list behind this fact is pinned
   * against `getEntitlements()` by the core test suite so the two cannot drift
   * apart. Nothing here resolves, widens or grants an entitlement.
   */
  lifecycleLive: boolean;
  /**
   * Whether the immutable activation fact exists (migration 0034). The ONLY
   * payment-confirmation authority in this build.
   */
  activated: boolean;
  /** Whether verified payment evidence exists for this subscription. A receipt. */
  evidenceRecorded: boolean;
  /**
   * Whether the server explicitly flagged the row as needing a human decision
   * (`sync_state = 'conflict'` or `sync_required`). Such a row is never
   * presented as a live checkout.
   */
  requiresOperatorReview: boolean;
  /** The trusted PERSISTED period end, or `null`. Never computed. */
  periodEnd: string | null;
  /** The authoritative (persisted) cancellation state of the row. */
  cancelAtPeriodEnd: boolean;
}

/* -------------------------------------------------------------------------- */
/* Facts → state                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Classify the facts into one of the six states.
 *
 * The precedence is deliberately "the strongest server fact first", and every
 * ambiguous combination falls to `unknown` rather than to a claim:
 *
 * ```text
 * no row                                          → free
 * non-commercial row, internal plan free          → free
 * non-commercial row, internal plan paid          → unknown  (no payment authority exists for it)
 * commercial row, no coherent commercial identity → unknown
 * activation fact + live lifecycle                → activated
 * activation fact + lifecycle no longer live      → unknown  (the paid entitlement has ended)
 * no activation, lifecycle no longer live         → unknown
 * no activation, flagged for operator review      → unknown
 * no activation, verified evidence recorded       → evidence_awaiting_activation
 * no activation, no evidence                      → awaiting_verification
 * ```
 *
 * `activated` is reachable ONLY from `activated === true` (the durable
 * activation fact): a stored `status = 'active'`, a provider state, verified
 * evidence or any client input can never produce it.
 */
export function resolveBillingPortalState(facts: BillingPortalFacts): BillingPortalState {
  if (!facts.subscriptionPresent) return 'free';
  if (!facts.providerBacked) {
    // A row with no provider is the historical, non-commercial shape. A free
    // row is simply free; a paid one has no payment authority in the commercial
    // model, so the portal refuses to read a confirmation into it (`status`,
    // `plan` and `users.plan` are not payment facts).
    return facts.internalPlan === 'free' ? 'free' : 'unknown';
  }
  // From here on the row is provider-backed: it exists because a checkout
  // created it, which is not a purchase.
  if (facts.commercial === null) return 'unknown';
  if (facts.activated) return facts.lifecycleLive ? 'activated' : 'unknown';
  if (!facts.lifecycleLive) return 'unknown';
  if (facts.requiresOperatorReview) return 'unknown';
  return facts.evidenceRecorded ? 'evidence_awaiting_activation' : 'awaiting_verification';
}

/* -------------------------------------------------------------------------- */
/* Facts → DTO                                                                */
/* -------------------------------------------------------------------------- */

/** A facts object the DTO cannot represent safely is never forwarded. */
export class BillingPortalProjectionError extends Error {
  readonly code = 'billing_portal_projection_refused' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BillingPortalProjectionError';
  }
}

export function isBillingPortalProjectionError(error: unknown): error is BillingPortalProjectionError {
  return error instanceof BillingPortalProjectionError;
}

/**
 * Project the facts onto the strict summary DTO.
 *
 * Fail-closed by construction: the projection publishes the commercial identity
 * and the persisted commercial facts ONLY while the server is stating a
 * subscription, and it publishes nothing at all (`unavailable`-shaped: every
 * optional field `null`) in `free`, `unknown` and `unavailable`. A facts object
 * the DTO rejects (an incoherent combination, a plan the catalogue does not
 * sell, a malformed period end) is refused with
 * `BillingPortalProjectionError` rather than forwarded — the API maps that
 * refusal onto `UNAVAILABLE_BILLING_PORTAL_SUMMARY`.
 */
export function projectBillingPortalSummary(facts: BillingPortalFacts): BillingPortalSummaryDto {
  const state = resolveBillingPortalState(facts);
  const subscription = statesASubscription(state);
  const candidate = {
    state,
    plan: subscription ? facts.commercial : null,
    // The persisted fact, verbatim. No interval arithmetic, no fallback, no
    // "renews monthly" guess: a missing period end stays null.
    periodEnd: subscription ? facts.periodEnd : null,
    cancelAtPeriodEnd: subscription ? facts.cancelAtPeriodEnd : null,
    canAccessAutomation: false,
    grantsExecution: false,
  };

  const parsed = billingPortalSummaryDtoSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new BillingPortalProjectionError(
      `The billing facts could not be projected onto the portal summary: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
