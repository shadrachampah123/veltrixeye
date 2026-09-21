import { z } from 'zod';
import {
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  billingIntervalSchema,
  commercialPlanForInternalPlan,
  commercialPlanIdSchema,
  commercialPlanPrice,
  internalPlanForCommercialPlan,
  type BillingInterval,
  type CommercialPlanId,
  type PlanPrice,
} from './billing-catalogue.js';
import { subscriptionStatusSchema, type SubscriptionStatus } from './billing.js';
import { userPlanSchema } from './users.js';

/**
 * Billing PR2 — provider-seam contracts (canonical, provider-neutral).
 *
 * These schemas describe the INTERNAL representations that cross the billing
 * provider boundary: customer identity, subscription state, plan/interval
 * identity, provider event identity, provider-reported subscription state,
 * normalized billing events and synchronization results. They are the
 * vocabulary migration `0031_provider_billing.sql` persists and the vocabulary
 * the provider seam in `packages/core/src/billing/provider.ts` speaks.
 *
 * Provider-specific detail stays BEHIND the boundary. Nothing here knows a
 * Paystack field name, endpoint, header, signature scheme or payload shape: a
 * future adapter normalizes what the provider says into these contracts, and
 * everything above the seam (routes, services, persistence) only ever sees
 * canonical values. `.strict()` on every object is what makes that enforceable
 * — an unknown (i.e. provider-shaped) field is a validation failure, not a
 * silent pass-through.
 *
 * WHAT DOES NOT EXIST YET (PR2 establishes the boundary only):
 *  - no Paystack API integration, no HTTP call of any kind;
 *  - no checkout, no billing portal, no webhook route, no signature
 *    verification, no subscription synchronization worker;
 *  - no credential, no API key, no environment change.
 *
 * WHAT THIS MUST NEVER DO:
 *  - it does not define prices, plan limits or commercial terms — the
 *    authoritative catalogue (`./billing-catalogue.ts`) is the single source
 *    and is referenced, never duplicated;
 *  - it is not an entitlement system — entitlements are resolved exclusively
 *    from the internal `plan` + `status` pair by
 *    `packages/core/src/billing/entitlements.ts`;
 *  - it cannot grant execution. `canAccessAutomation` stays `false` for every
 *    plan, and the pins below (`grantsExecution`, `planChanged`,
 *    `entitlementsChanged` typed as `z.literal(false)`) make a capability
 *    grant unrepresentable in billing state.
 */

/* -------------------------------------------------------------------------- */
/* Provider identity                                                          */
/* -------------------------------------------------------------------------- */

/** Billing providers that exist. Paystack is the only one (PR1 decision). */
export const BILLING_PROVIDERS = [BILLING_PROVIDER] as const;
export type BillingProviderId = (typeof BILLING_PROVIDERS)[number];
export const billingProviderIdSchema = z.enum(BILLING_PROVIDERS);

/**
 * The operations a billing provider seam must eventually offer. Declared here
 * so the boundary is a contract, not an ad-hoc method list; PR2 implements
 * NONE of them (see `packages/core/src/billing/provider.ts`).
 */
export const BILLING_PROVIDER_OPERATIONS = [
  'findCustomer',
  'createCustomer',
  'initializeCheckout',
  'findSubscription',
  'verifySubscription',
  'synchronizeSubscription',
  'cancelSubscription',
  'normalizeEvent',
] as const;
export type BillingProviderOperation = (typeof BILLING_PROVIDER_OPERATIONS)[number];
export const billingProviderOperationSchema = z.enum(BILLING_PROVIDER_OPERATIONS);

/** SHA-256 hex — the format used for every billing hash/idempotency key. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const sha256HexSchema = z.string().regex(SHA256_HEX_RE);

/**
 * Credential-shaped material. A provider REFERENCE is an identifier
 * (`cus_…`, `sub_…`, a transaction reference) — never a key, token or
 * password. Reference values matching this pattern are rejected, mirroring the
 * database-level posture in migration 0031 (and 0029 for execution receipts).
 */
export const BILLING_CREDENTIAL_SHAPED_RE =
  /(password|passwd|token|secret|api[_-]?key|authorization|private[_-]?key|credential|bearer)/i;

/** A provider-side identifier for a customer/subscription/plan. */
export const providerReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !BILLING_CREDENTIAL_SHAPED_RE.test(value), {
    message: 'a provider reference must be an identifier, never credential-shaped material',
  });

/** A provider-side reference carried by an event/transaction (wider bound). */
export const providerEventReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(190)
  .refine((value) => !BILLING_CREDENTIAL_SHAPED_RE.test(value), {
    message: 'a provider reference must be an identifier, never credential-shaped material',
  });

const isoDateTime = z.string().datetime();
const uuid = z.string().uuid();

/* -------------------------------------------------------------------------- */
/* Canonical vocabularies (the only ones that ever reach the database)        */
/* -------------------------------------------------------------------------- */

/** Lifecycle of a provider customer record. */
export const BILLING_CUSTOMER_STATUSES = ['unprovisioned', 'provisioned', 'suspended', 'unavailable'] as const;
export type BillingCustomerStatus = (typeof BILLING_CUSTOMER_STATUSES)[number];
export const billingCustomerStatusSchema = z.enum(BILLING_CUSTOMER_STATUSES);

/**
 * Canonical provider-reported subscription lifecycle. Provider-specific status
 * words are normalized onto this vocabulary behind the seam, so a vendor
 * string is never persisted and never compared against directly.
 *
 * Deliberately absent: states this platform does not model (for example a
 * provider-specific "paused"). An unmodelled provider state normalizes to
 * `unknown`, which never changes authoritative state and always requires
 * review — the fail-safe direction.
 */
export const BILLING_LIFECYCLE_STATES = [
  'unprovisioned',
  'pending',
  'active',
  'trialing',
  'past_due',
  'cancelled',
  'unsubscribed',
  'expired',
  'unknown',
] as const;
export type BillingLifecycleState = (typeof BILLING_LIFECYCLE_STATES)[number];
export const billingLifecycleStateSchema = z.enum(BILLING_LIFECYCLE_STATES);

/** Bookkeeping for provider synchronization (written by a later PR). */
export const BILLING_SYNC_STATES = ['never_synced', 'pending', 'synced', 'conflict'] as const;
export type BillingSyncState = (typeof BILLING_SYNC_STATES)[number];
export const billingSyncStateSchema = z.enum(BILLING_SYNC_STATES);

export const BILLING_SYNC_SOURCES = ['none', 'webhook', 'verification', 'reconciliation', 'manual'] as const;
export type BillingSyncSource = (typeof BILLING_SYNC_SOURCES)[number];
export const billingSyncSourceSchema = z.enum(BILLING_SYNC_SOURCES);

export const BILLING_SYNC_OUTCOMES = [
  'unchanged',
  'created',
  'updated',
  'ignored',
  'conflict',
  'requires_manual_review',
  'failed',
] as const;
export type BillingSyncOutcome = (typeof BILLING_SYNC_OUTCOMES)[number];
export const billingSyncOutcomeSchema = z.enum(BILLING_SYNC_OUTCOMES);

export const BILLING_CANCELLATION_REASONS = [
  'user',
  'provider',
  'payment_failure',
  'expired',
  'fraud',
  'other',
] as const;
export type BillingCancellationReason = (typeof BILLING_CANCELLATION_REASONS)[number];
export const billingCancellationReasonSchema = z.enum(BILLING_CANCELLATION_REASONS);

/**
 * Canonical (provider-neutral) billing event types. A provider event name is
 * mapped onto one of these behind the seam; anything unmappable becomes
 * `unrecognized` and is stored as-is rather than guessed at.
 */
export const BILLING_EVENT_TYPES = [
  'customer.created',
  'customer.updated',
  'payment.succeeded',
  'payment.failed',
  'payment.pending',
  'subscription.created',
  'subscription.updated',
  'subscription.activated',
  'subscription.renewed',
  'subscription.not_renewing',
  'subscription.cancelled',
  'subscription.expired',
  'invoice.processed',
  'invoice.failed',
  'unrecognized',
] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];
export const billingEventTypeSchema = z.enum(BILLING_EVENT_TYPES);

export const BILLING_EVENT_CATEGORIES = ['customer', 'payment', 'subscription', 'invoice', 'unrecognized'] as const;
export type BillingEventCategory = (typeof BILLING_EVENT_CATEGORIES)[number];
export const billingEventCategorySchema = z.enum(BILLING_EVENT_CATEGORIES);

/** Processing state of a persisted provider event. */
export const BILLING_EVENT_PROCESSING_STATES = ['received', 'ignored', 'processed', 'failed'] as const;
export type BillingEventProcessingState = (typeof BILLING_EVENT_PROCESSING_STATES)[number];
export const billingEventProcessingStateSchema = z.enum(BILLING_EVENT_PROCESSING_STATES);

/** Category of a canonical event type (`payment.succeeded` → `payment`). */
export function billingEventCategory(eventType: BillingEventType): BillingEventCategory {
  if (eventType === 'unrecognized') return 'unrecognized';
  const [category] = eventType.split('.');
  switch (category) {
    case 'customer':
      return 'customer';
    case 'payment':
      return 'payment';
    case 'subscription':
      return 'subscription';
    case 'invoice':
      return 'invoice';
    default:
      return 'unrecognized';
  }
}

/* -------------------------------------------------------------------------- */
/* Provider state → authoritative subscription status                         */
/* -------------------------------------------------------------------------- */

/**
 * The ONLY path from a provider-reported lifecycle state to the authoritative
 * `subscriptions.status` vocabulary of migration 0014
 * (`active | trialing | past_due | canceled | expired`).
 *
 * `null` means "this provider state does not authorize a status change": the
 * authoritative status is left exactly as it is and the sync result must be
 * flagged for manual review. An ambiguous or unmodelled provider state can
 * therefore never widen an entitlement — the fail-safe direction.
 *
 * This mapping changes no entitlement by itself: `getEntitlements()` still
 * reads `plan` + `status`, and `canAccessAutomation` stays `false`.
 */
export const SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE: Readonly<
  Record<BillingLifecycleState, SubscriptionStatus | null>
> = Object.freeze({
  unprovisioned: null,
  pending: null,
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  cancelled: 'canceled',
  unsubscribed: 'canceled',
  expired: 'expired',
  unknown: null,
});

/** Authoritative status a provider state maps onto, or `null` when it maps to none. */
export function subscriptionStatusForProviderState(state: BillingLifecycleState): SubscriptionStatus | null {
  return SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE[state];
}

/**
 * True when a provider state cannot be applied without a human decision.
 * `unprovisioned` is not a review case — it simply means nothing exists
 * upstream yet.
 */
export function providerStateRequiresReview(state: BillingLifecycleState): boolean {
  return state !== 'unprovisioned' && SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE[state] === null;
}

/* -------------------------------------------------------------------------- */
/* Billing plan identity — derived from the catalogue, never a second price   */
/* -------------------------------------------------------------------------- */

/**
 * What a subscription is billed as: the COMMERCIAL catalogue plan, the
 * INTERNAL plan value it maps onto today (or `null` when it has none), and the
 * interval. No amount appears here — prices are read from the catalogue.
 */
export const billingPlanIdentitySchema = z
  .object({
    cataloguePlan: commercialPlanIdSchema,
    internalPlan: userPlanSchema.nullable(),
    interval: billingIntervalSchema,
    currency: z.literal(BILLING_CURRENCY),
  })
  .strict()
  .superRefine((identity, ctx) => {
    const expected = internalPlanForCommercialPlan(identity.cataloguePlan);
    if (identity.internalPlan !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `catalogue plan "${identity.cataloguePlan}" maps to internal plan ` +
          `${expected === null ? 'null' : `"${expected}"`} (canonical compatibility mapping)`,
      });
    }
  });
export type BillingPlanIdentity = z.infer<typeof billingPlanIdentitySchema>;

/** Build a plan identity from the canonical catalogue mapping. */
export function billingPlanIdentity(
  cataloguePlan: CommercialPlanId,
  interval: BillingInterval,
): BillingPlanIdentity {
  return {
    cataloguePlan,
    internalPlan: internalPlanForCommercialPlan(cataloguePlan),
    interval,
    currency: BILLING_CURRENCY,
  };
}

/**
 * A plan can only be sold once it has an internal plan value. Today that
 * excludes Starter (`internalPlanForCommercialPlan('starter') === null`);
 * migration 0031 enforces the same rule at the database level.
 */
export function isSellableBillingPlan(identity: BillingPlanIdentity): boolean {
  return identity.internalPlan !== null;
}

/**
 * Price for a plan identity — delegated to the authoritative catalogue. This
 * function exists so no consumer ever restates an amount.
 */
export function billingPlanPrice(identity: BillingPlanIdentity): PlanPrice {
  return commercialPlanPrice(identity.cataloguePlan, identity.interval);
}

/* -------------------------------------------------------------------------- */
/* Customer identity                                                          */
/* -------------------------------------------------------------------------- */

export const billingCustomerIdentitySchema = z
  .object({
    id: uuid,
    userId: uuid,
    provider: billingProviderIdSchema,
    /** Normalized (lowercase) account email presented to the provider. */
    email: z
      .string()
      .email()
      .max(254)
      .refine((value) => value === value.toLowerCase(), { message: 'email must be normalized to lowercase' }),
    providerCustomerId: providerReferenceSchema.nullable(),
    providerCustomerCode: providerReferenceSchema.nullable(),
    status: billingCustomerStatusSchema,
    lastReference: providerEventReferenceSchema.nullable(),
    provisionedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict()
  .superRefine((customer, ctx) => {
    if (
      customer.status === 'provisioned' &&
      customer.providerCustomerId === null &&
      customer.providerCustomerCode === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a provisioned customer must carry a provider customer id or code',
      });
    }
    if (customer.status === 'unprovisioned' && customer.provisionedAt !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an unprovisioned customer cannot carry a provisioned timestamp',
      });
    }
  });
export type BillingCustomerIdentity = z.infer<typeof billingCustomerIdentitySchema>;

/* -------------------------------------------------------------------------- */
/* Provider-reported subscription state (normalized, provider-neutral)        */
/* -------------------------------------------------------------------------- */

export const providerSubscriptionStateSchema = z
  .object({
    provider: billingProviderIdSchema,
    state: billingLifecycleStateSchema,
    providerSubscriptionId: providerReferenceSchema.nullable(),
    providerSubscriptionCode: providerReferenceSchema.nullable(),
    providerCustomerId: providerReferenceSchema.nullable(),
    providerCustomerCode: providerReferenceSchema.nullable(),
    providerPlanId: providerReferenceSchema.nullable(),
    providerReference: providerEventReferenceSchema.nullable(),
    /** Catalogue plan the provider subscription was sold as, when resolvable. */
    cataloguePlan: commercialPlanIdSchema.nullable(),
    interval: billingIntervalSchema.nullable(),
    currency: z.literal(BILLING_CURRENCY).nullable(),
    currentPeriodStart: isoDateTime.nullable(),
    currentPeriodEnd: isoDateTime.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    cancelAt: isoDateTime.nullable(),
    cancelledAt: isoDateTime.nullable(),
    cancellationReason: billingCancellationReasonSchema.nullable(),
    /** Identity of the provider response/event this state was read from. */
    sourceEventIdempotencyKey: sha256HexSchema.nullable(),
    observedAt: isoDateTime,
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.interval !== null && state.cataloguePlan === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an interval requires a catalogue plan',
      });
    }
    if (
      state.currentPeriodStart !== null &&
      state.currentPeriodEnd !== null &&
      state.currentPeriodStart >= state.currentPeriodEnd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'currentPeriodStart must precede currentPeriodEnd',
      });
    }
    if (state.cancelledAt !== null && !state.cancelAtPeriodEnd && state.state !== 'cancelled' && state.state !== 'unsubscribed' && state.state !== 'expired') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cancelledAt requires a cancelled/expired state or cancelAtPeriodEnd',
      });
    }
    if (state.cancellationReason !== null && state.cancelledAt === null && !state.cancelAtPeriodEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a cancellation reason requires cancellation state',
      });
    }
  });
export type ProviderSubscriptionState = z.infer<typeof providerSubscriptionStateSchema>;

/* -------------------------------------------------------------------------- */
/* Authoritative subscription state (what migration 0031 persists)            */
/* -------------------------------------------------------------------------- */

/**
 * Canonical internal view of the ONE authoritative subscription row per user
 * (`subscriptions`, migration 0014 + 0031). `plan` and `status` are the
 * entitlement inputs; every other field is commercial/provider bookkeeping
 * that entitlement enforcement never reads.
 */
export const billingSubscriptionStateSchema = z
  .object({
    id: uuid,
    userId: uuid,
    /** INTERNAL plan value (`free | pro | premium`) — the enforced vocabulary. */
    plan: userPlanSchema,
    /** COMMERCIAL catalogue plan, or null when nothing was sold. */
    cataloguePlan: commercialPlanIdSchema.nullable(),
    interval: billingIntervalSchema.nullable(),
    currency: z.literal(BILLING_CURRENCY),
    /** AUTHORITATIVE lifecycle status (migration 0014 vocabulary). */
    status: subscriptionStatusSchema,
    catalogueVersion: z.string().min(1).max(64).nullable(),
    provider: billingProviderIdSchema.nullable(),
    billingCustomerId: uuid.nullable(),
    providerCustomerId: providerReferenceSchema.nullable(),
    providerSubscriptionId: providerReferenceSchema.nullable(),
    providerSubscriptionCode: providerReferenceSchema.nullable(),
    providerPlanId: providerReferenceSchema.nullable(),
    providerReference: providerEventReferenceSchema.nullable(),
    /** Canonical provider-reported state; never a provider-specific string. */
    providerState: billingLifecycleStateSchema.nullable(),
    currentPeriodStart: isoDateTime.nullable(),
    currentPeriodEnd: isoDateTime.nullable(),
    cancelAtPeriodEnd: z.boolean(),
    cancelAt: isoDateTime.nullable(),
    cancelledAt: isoDateTime.nullable(),
    cancellationReason: billingCancellationReasonSchema.nullable(),
    syncState: billingSyncStateSchema,
    lastSyncSource: billingSyncSourceSchema,
    lastSyncedAt: isoDateTime.nullable(),
    syncRequired: z.boolean(),
    lastEventIdempotencyKey: sha256HexSchema.nullable(),
    stateVersion: z.number().int().min(1),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .strict()
  .superRefine((subscription, ctx) => {
    // Catalogue identity must follow the canonical compatibility mapping.
    if (subscription.cataloguePlan !== null) {
      const expected = commercialPlanForInternalPlan(subscription.plan);
      if (expected !== subscription.cataloguePlan) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `internal plan "${subscription.plan}" maps to catalogue plan ` +
            `${expected === null ? 'null' : `"${expected}"`}, not "${subscription.cataloguePlan}"`,
        });
      }
    }
    if (subscription.interval !== null && subscription.cataloguePlan === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an interval requires a catalogue plan',
      });
    }
    // Provider detail requires a provider.
    if (
      subscription.provider === null &&
      (subscription.providerState !== null ||
        subscription.providerCustomerId !== null ||
        subscription.providerSubscriptionId !== null ||
        subscription.providerSubscriptionCode !== null ||
        subscription.providerPlanId !== null ||
        subscription.providerReference !== null ||
        subscription.billingCustomerId !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'provider state requires a provider',
      });
    }
    if (
      subscription.currentPeriodStart !== null &&
      subscription.currentPeriodEnd !== null &&
      subscription.currentPeriodStart >= subscription.currentPeriodEnd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'currentPeriodStart must precede currentPeriodEnd',
      });
    }
    if (
      subscription.cancelledAt !== null &&
      !subscription.cancelAtPeriodEnd &&
      subscription.status !== 'canceled' &&
      subscription.status !== 'expired'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cancelledAt requires cancelAtPeriodEnd or a canceled/expired status',
      });
    }
    if (
      subscription.lastSyncedAt !== null &&
      (subscription.syncState === 'never_synced' || subscription.lastSyncSource === 'none')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'lastSyncedAt requires a sync state and source',
      });
    }
  });
export type BillingSubscriptionState = z.infer<typeof billingSubscriptionStateSchema>;

/* -------------------------------------------------------------------------- */
/* Provider event identity + normalized events                                */
/* -------------------------------------------------------------------------- */

/**
 * Fields the event idempotency key is derived from, in canonical order. The
 * derivation is pure and total: the same provider event always produces the
 * same key, so a replayed delivery collapses onto one ledger row.
 */
export const BILLING_EVENT_IDEMPOTENCY_FIELDS = [
  'provider',
  'providerEventId',
  'eventType',
  'occurredAt',
  'payloadHash',
] as const;

export const billingEventIdempotencyInputSchema = z
  .object({
    provider: billingProviderIdSchema,
    providerEventId: providerEventReferenceSchema.nullable(),
    eventType: billingEventTypeSchema,
    occurredAt: isoDateTime.nullable(),
    payloadHash: sha256HexSchema,
  })
  .strict();
export type BillingEventIdempotencyInput = z.infer<typeof billingEventIdempotencyInputSchema>;

/**
 * Canonical string an idempotency key is the SHA-256 of. Exported so the
 * derivation is testable without a hashing implementation; the server-side
 * hash lives in `packages/core/src/billing/provider.ts`.
 */
export function billingEventIdempotencyCanonicalString(input: BillingEventIdempotencyInput): string {
  const parsed = billingEventIdempotencyInputSchema.parse(input);
  return [
    parsed.provider,
    parsed.providerEventId ?? '',
    parsed.eventType,
    parsed.occurredAt ?? '',
    parsed.payloadHash,
  ].join('|');
}

export const providerEventIdentitySchema = billingEventIdempotencyInputSchema
  .extend({
    idempotencyKey: sha256HexSchema,
    receivedAt: isoDateTime,
  })
  .strict()
  .superRefine((identity, ctx) => {
    if (identity.occurredAt !== null && identity.occurredAt > identity.receivedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'occurredAt cannot be after receivedAt',
      });
    }
  });
export type ProviderEventIdentity = z.infer<typeof providerEventIdentitySchema>;

/** Local/provider subject an event was resolved to (all optional). */
export const billingEventSubjectSchema = z
  .object({
    userId: uuid.nullable(),
    subscriptionId: uuid.nullable(),
    billingCustomerId: uuid.nullable(),
    providerCustomerId: providerReferenceSchema.nullable(),
    providerSubscriptionId: providerReferenceSchema.nullable(),
    providerReference: providerEventReferenceSchema.nullable(),
  })
  .strict();
export type BillingEventSubject = z.infer<typeof billingEventSubjectSchema>;

/**
 * Normalized facts an event carries. Provider payloads are never stored or
 * forwarded — only these canonical fields plus a payload hash.
 *
 * `amountMinor` is the provider-reported amount for THIS event (a receipt
 * fact). It is not a price definition and never a price source: the catalogue
 * remains authoritative.
 */
export const billingEventDataSchema = z
  .object({
    cataloguePlan: commercialPlanIdSchema.nullable(),
    interval: billingIntervalSchema.nullable(),
    state: billingLifecycleStateSchema.nullable(),
    currentPeriodStart: isoDateTime.nullable(),
    currentPeriodEnd: isoDateTime.nullable(),
    cancelAtPeriodEnd: z.boolean().nullable(),
    cancellationReason: billingCancellationReasonSchema.nullable(),
    amountMinor: z.number().int().nonnegative().nullable(),
    currency: z.literal(BILLING_CURRENCY).nullable(),
    failureReason: z.string().min(1).max(600).nullable(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.failureReason !== null && BILLING_CREDENTIAL_SHAPED_RE.test(data.failureReason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a failure reason must be redacted: credential-shaped material is rejected',
      });
    }
  });
export type BillingEventData = z.infer<typeof billingEventDataSchema>;

export const normalizedBillingEventSchema = z
  .object({
    identity: providerEventIdentitySchema,
    category: billingEventCategorySchema,
    subject: billingEventSubjectSchema.nullable(),
    data: billingEventDataSchema.nullable(),
    /**
     * Pinned to `false`: normalizing a provider event can never grant an
     * execution capability. Billing state is not an execution entitlement.
     */
    grantsExecution: z.literal(false),
  })
  .strict()
  .superRefine((event, ctx) => {
    const expected = billingEventCategory(event.identity.eventType);
    if (event.category !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `event type "${event.identity.eventType}" belongs to category "${expected}"`,
      });
    }
  });
export type NormalizedBillingEvent = z.infer<typeof normalizedBillingEventSchema>;

/* -------------------------------------------------------------------------- */
/* Synchronization results                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of reconciling provider state into the authoritative
 * subscription row. PR2 defines the contract only — no synchronization runs,
 * and nothing writes these values yet.
 *
 * `planChanged`, `entitlementsChanged` and `grantsExecution` are typed as
 * `z.literal(false)`: a synchronization result cannot claim to have changed a
 * plan or an entitlement, because it must not. Provider state moves `status`,
 * period and cancellation fields; it can never move `plan` (the entitlement
 * identity) or enable execution.
 */
export const subscriptionSyncResultSchema = z
  .object({
    provider: billingProviderIdSchema,
    userId: uuid,
    subscriptionId: uuid.nullable(),
    outcome: billingSyncOutcomeSchema,
    fromStatus: subscriptionStatusSchema.nullable(),
    toStatus: subscriptionStatusSchema.nullable(),
    providerState: billingLifecycleStateSchema.nullable(),
    /** Idempotency keys of the provider events this result applied. */
    appliedEventIdempotencyKeys: z.array(sha256HexSchema).max(64),
    requiresManualReview: z.boolean(),
    reason: z.string().min(1).max(200).nullable(),
    syncedAt: isoDateTime,
    stateVersion: z.number().int().min(1),
    planChanged: z.literal(false),
    entitlementsChanged: z.literal(false),
    grantsExecution: z.literal(false),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.outcome === 'created' && (result.subscriptionId === null || result.fromStatus !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a created subscription requires an id and no previous status',
      });
    }
    if (result.outcome === 'updated' && result.toStatus === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an updated subscription requires the status it moved to',
      });
    }
    if (result.outcome === 'unchanged' && result.toStatus !== null && result.toStatus !== result.fromStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an unchanged result cannot move the authoritative status',
      });
    }
    if ((result.outcome === 'conflict' || result.outcome === 'requires_manual_review' || result.outcome === 'failed') && !result.requiresManualReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `outcome "${result.outcome}" requires manual review`,
      });
    }
    if (result.outcome === 'failed' && result.reason === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a failed synchronization requires a reason',
      });
    }
    // The canonical mapping is the only path from provider state to status.
    if (result.providerState !== null && (result.outcome === 'updated' || result.outcome === 'created')) {
      const expected = subscriptionStatusForProviderState(result.providerState);
      if (result.toStatus !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `provider state "${result.providerState}" maps to ` +
            `${expected === null ? 'no authoritative status' : `"${expected}"`}`,
        });
      }
    }
    // An unapplicable provider state must never be silently dropped.
    if (result.providerState !== null && providerStateRequiresReview(result.providerState) && !result.requiresManualReview) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `provider state "${result.providerState}" cannot be applied without review`,
      });
    }
  });
export type SubscriptionSyncResult = z.infer<typeof subscriptionSyncResultSchema>;

/**
 * A synchronization result that changes nothing: the safe default for an
 * unapplicable or unrecognized provider state.
 */
export function unappliedSyncResult(input: {
  provider: BillingProviderId;
  userId: string;
  subscriptionId?: string | null;
  providerState?: BillingLifecycleState | null;
  outcome?: BillingSyncOutcome;
  reason?: string | null;
  syncedAt: string;
  stateVersion: number;
}): SubscriptionSyncResult {
  const outcome = input.outcome ?? 'requires_manual_review';
  return subscriptionSyncResultSchema.parse({
    provider: input.provider,
    userId: input.userId,
    subscriptionId: input.subscriptionId ?? null,
    outcome,
    fromStatus: null,
    toStatus: null,
    providerState: input.providerState ?? null,
    appliedEventIdempotencyKeys: [],
    requiresManualReview: outcome === 'conflict' || outcome === 'requires_manual_review' || outcome === 'failed',
    reason: input.reason ?? null,
    syncedAt: input.syncedAt,
    stateVersion: input.stateVersion,
    planChanged: false,
    entitlementsChanged: false,
    grantsExecution: false,
  });
}
