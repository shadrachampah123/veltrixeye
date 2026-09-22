import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  billingEventIdempotencyCanonicalString,
  billingIntervalSchema,
  billingPaymentAmountSchema,
  billingPricingSnapshotSchema,
  billingPlanIdentity,
  billingPlanPrice,
  commercialPlanIdSchema,
  normalizedBillingEventSchema,
  providerSubscriptionStateSchema,
  sha256HexSchema,
  type BillingCustomerIdentity,
  type BillingEventIdempotencyInput,
  type BillingPlanIdentity,
  type BillingProviderId,
  type BillingProviderOperation,
  type NormalizedBillingEvent,
  type ProviderSubscriptionState,
  type SubscriptionSyncResult,
} from '@veltrixeye/contracts';
import { SERVER_BILLING_CATALOGUE, cataloguePriceMinor } from './catalogue.js';

/**
 * Billing PR2 — the billing PROVIDER SEAM (Paystack-ready, unimplemented).
 *
 * This module is the ONLY place in the repository that knows an external
 * billing provider exists. Everything above it — routes, services, the
 * subscription row persisted by migration `0031_provider_billing.sql` —
 * speaks the canonical contracts in
 * `packages/contracts/src/billing-provider.ts`, never provider vocabulary.
 *
 * ---------------------------------------------------------------------------
 * WHAT PR2 SHIPS: the boundary, and nothing else.
 * ---------------------------------------------------------------------------
 *  - the `BillingProvider` interface a future Paystack adapter must satisfy
 *    (customer lookup/creation, checkout initialization, subscription lookup,
 *    verification/synchronization, cancellation/management, webhook event
 *    normalization);
 *  - the request/result schemas those operations speak, all Zod-validated and
 *    all `.strict()`, so provider-shaped extra fields are rejected rather than
 *    passed through;
 *  - a registry that starts EMPTY (mirroring the market-data and notification
 *    registries) — nothing anywhere registers a Paystack provider;
 *  - a fail-closed placeholder whose every operation throws, so a caller that
 *    reaches for the seam today gets a loud, honest error instead of a silent
 *    no-op or an accidental network call;
 *  - the pure, deterministic idempotency/payload hashing a future receiver
 *    needs (no I/O).
 *
 * ---------------------------------------------------------------------------
 * WHAT PR2 DELIBERATELY DOES NOT SHIP
 * ---------------------------------------------------------------------------
 *  - NO Paystack API integration and NO HTTP call of any kind: this module
 *    imports `node:crypto` (hashing), `zod` (validation), the shared contracts
 *    and the catalogue authority — nothing else. There is no `fetch`, no
 *    client, no base URL, no timeout, no retry policy and no transport.
 *  - NO checkout route, NO billing portal route, NO webhook route, NO webhook
 *    processing and NO signature verification.
 *  - NO subscription synchronization worker, no scheduler, no queue claim.
 *  - NO credential or API-key handling, and no environment/config change.
 *  - NO persistence: nothing here reads or writes the database. Migration 0031
 *    creates the columns; a later PR writes them through this seam.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MUST NEVER DO (later PRs included)
 * ---------------------------------------------------------------------------
 *  - widen an entitlement. Entitlements are resolved exclusively from the
 *    internal `plan` + `status` pair by `./entitlements.ts`; the provider
 *    columns persisted by 0031 are commercial/provider bookkeeping.
 *  - enable execution. `canAccessAutomation` stays `false` for every plan,
 *    Gate 9 / B1 / B2 are untouched, and `live` is pinned to `false` below:
 *    billing is not an execution transport and Elite's "priority execution"
 *    remains a commercial catalogue descriptor only.
 */

/**
 * Coherence check, evaluated once at module load: the seam and the
 * authoritative commercial catalogue must agree on the provider. A mismatch is
 * a boot failure, never a silent fallback.
 */
if (SERVER_BILLING_CATALOGUE.provider !== BILLING_PROVIDER) {
  throw new Error(
    `Billing provider seam disagrees with the commercial catalogue: catalogue provider is ` +
      `"${SERVER_BILLING_CATALOGUE.provider}", seam provider is "${BILLING_PROVIDER}".`,
  );
}

/* -------------------------------------------------------------------------- */
/* Seam request/result schemas (canonical, provider-neutral, strict)          */
/* -------------------------------------------------------------------------- */

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime();

/** Lookup a provider customer by local user (and optionally by email). */
export const billingCustomerQuerySchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    userId: uuid,
    email: z.string().email().max(254).nullish(),
  })
  .strict();
export type BillingCustomerQuery = z.infer<typeof billingCustomerQuerySchema>;

/** Create (provision) a provider customer for a local user. */
export const billingCustomerCreateRequestSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    userId: uuid,
    /** Normalized lowercase account email; the adapter never invents one. */
    email: z
      .string()
      .email()
      .max(254)
      .refine((value) => value === value.toLowerCase(), { message: 'email must be lowercase' }),
    /** Caller-derived idempotency key so a retry cannot provision twice. */
    idempotencyKey: sha256HexSchema,
    requestedAt: isoDateTime,
  })
  .strict();
export type BillingCustomerCreateRequest = z.infer<typeof billingCustomerCreateRequestSchema>;

/**
 * Initialize a checkout for a catalogue plan.
 *
 * The PRICE is still never carried as a bare number and never supplied by the
 * caller as a choice: the amount a provider is allowed to charge arrives as
 * `pricing` — an authorized pricing snapshot produced by the server-side
 * pricing boundary (`pricing.ts`), which resolved the commercial amount from
 * the authoritative catalogue and the payment amount through the authorized FX
 * version. An adapter that cannot see that snapshot must refuse (PR3's Paystack
 * adapter does: it never prices and never converts).
 */
export const billingCheckoutRequestSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    userId: uuid,
    plan: z.object({ cataloguePlan: commercialPlanIdSchema, interval: billingIntervalSchema }).strict(),
    /** Our own transaction reference (surfaced back by the provider). */
    reference: z.string().trim().min(1).max(190),
    /**
     * PR3: the ALREADY-AUTHORIZED pricing snapshot (commercial USD amount +
     * payment-currency amount + FX rate/version). Optional for backward
     * compatibility with PR2 callers; an adapter that requires an amount MUST
     * fail closed when it is absent rather than resolve a price itself.
     */
    pricing: billingPricingSnapshotSchema.optional(),
    idempotencyKey: sha256HexSchema,
    /** Where the provider returns the customer after payment. */
    callbackUrl: z.string().url().max(2048),
    requestedAt: isoDateTime,
  })
  .strict();
export type BillingCheckoutRequest = z.infer<typeof billingCheckoutRequestSchema>;

export const BILLING_CHECKOUT_SESSION_STATUSES = ['initialized', 'unavailable', 'failed'] as const;
export type BillingCheckoutSessionStatus = (typeof BILLING_CHECKOUT_SESSION_STATUSES)[number];

export const billingCheckoutSessionSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    status: z.enum(BILLING_CHECKOUT_SESSION_STATUSES),
    reference: z.string().trim().min(1).max(190),
    providerReference: z.string().trim().min(1).max(190).nullable(),
    /** Where the customer authorizes the payment; null unless initialized. */
    authorizationUrl: z.string().url().max(2048).nullable(),
    /** Catalogue-resolved amount, in integer minor units (USD cents). */
    amountMinor: z.number().int().nonnegative(),
    currency: z.literal(BILLING_CURRENCY),
    /**
     * PR3: the PAYMENT amount the provider was asked to charge (payment
     * currency, integer minor units). `amountMinor` above stays the COMMERCIAL
     * amount; this is what the customer actually pays.
     */
    payment: billingPaymentAmountSchema.nullable().optional(),
    /** PR3: the authorized pricing snapshot this session was initialized from. */
    pricing: billingPricingSnapshotSchema.nullable().optional(),
    idempotencyKey: sha256HexSchema,
    initializedAt: isoDateTime,
  })
  .strict()
  .superRefine((session, ctx) => {
    if (session.status === 'initialized' && session.authorizationUrl === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an initialized checkout must carry an authorization URL',
      });
    }
    if (session.status !== 'initialized' && session.authorizationUrl !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only an initialized checkout carries an authorization URL',
      });
    }
  });
export type BillingCheckoutSession = z.infer<typeof billingCheckoutSessionSchema>;

/** Look up a provider subscription for a local user. */
export const billingSubscriptionQuerySchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    userId: uuid,
    providerSubscriptionId: z.string().trim().min(1).max(128).nullish(),
  })
  .strict();
export type BillingSubscriptionQuery = z.infer<typeof billingSubscriptionQuerySchema>;

/** Verify a subscription against the provider (single read, normalized). */
export const billingSubscriptionVerifyRequestSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    userId: uuid,
    providerSubscriptionId: z.string().trim().min(1).max(128).nullish(),
    /** Provider transaction/reference to verify against, when there is one. */
    providerReference: z.string().trim().min(1).max(190).nullish(),
    idempotencyKey: sha256HexSchema,
    requestedAt: isoDateTime,
  })
  .strict();
export type BillingSubscriptionVerifyRequest = z.infer<typeof billingSubscriptionVerifyRequestSchema>;

/**
 * Reconcile verified provider state into the authoritative subscription row.
 * The result contract pins `planChanged` / `entitlementsChanged` /
 * `grantsExecution` to `false`: synchronization moves status, period and
 * cancellation state, never the plan value and never an execution capability.
 */
export const billingSubscriptionSyncRequestSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    userId: uuid,
    subscriptionId: uuid.nullish(),
    /** Provider state to apply, as normalized by the seam. */
    observed: providerSubscriptionStateSchema.optional(),
    /** Idempotency keys of the provider events driving this sync. */
    eventIdempotencyKeys: z.array(sha256HexSchema).max(64).default([]),
    source: z.enum(['webhook', 'verification', 'reconciliation', 'manual']),
    requestedAt: isoDateTime,
  })
  .strict();
export type BillingSubscriptionSyncRequest = z.infer<typeof billingSubscriptionSyncRequestSchema>;

/** Cancel / manage a provider subscription. */
export const billingSubscriptionCancelRequestSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    userId: uuid,
    providerSubscriptionId: z.string().trim().min(1).max(128),
    /** `false` = keep access until the period ends (cancel_at_period_end). */
    immediate: z.boolean(),
    reason: z.enum(['user', 'provider', 'payment_failure', 'expired', 'fraud', 'other']),
    idempotencyKey: sha256HexSchema,
    requestedAt: isoDateTime,
  })
  .strict();
export type BillingSubscriptionCancelRequest = z.infer<typeof billingSubscriptionCancelRequestSchema>;

/**
 * A raw provider event as delivered (later: by a webhook receiver). The
 * payload is `unknown` on purpose: the adapter validates and normalizes it
 * into `NormalizedBillingEvent`, and the raw body is never persisted — only a
 * hash of it (migration 0031).
 */
export const billingProviderRawEventSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    payload: z.unknown(),
    /** The provider's own event id, when the delivery carries one. */
    providerEventId: z.string().trim().min(1).max(190).nullish(),
    receivedAt: isoDateTime,
  })
  .strict();
export type BillingProviderRawEvent = z.infer<typeof billingProviderRawEventSchema>;

/* -------------------------------------------------------------------------- */
/* The seam                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a billing provider adapter must satisfy. PR2 declares the operations;
 * a later PR implements them for Paystack. Every value that crosses this
 * boundary is a canonical contract type — an adapter that cannot normalize a
 * provider response MUST fail rather than pass provider detail upwards.
 */
export interface BillingProvider {
  /** Which provider this adapter serves (`paystack`). */
  readonly id: BillingProviderId;
  /** Short adapter name for logs/rows. */
  readonly name: string;
  /**
   * Honest capability flag: `false` until the operations below really work.
   * Callers must treat a non-implemented provider as unavailable, never as
   * "no subscription".
   */
  readonly implemented: boolean;
  /**
   * Pinned `false` by the type: the billing seam is not an execution path and
   * can never become one.
   */
  readonly live: false;
  /**
   * Operator-safe description for boot logs. MUST NOT contain a credential:
   * the seam holds no keys in PR2, and a later adapter describes itself
   * without them.
   */
  describe(): Record<string, unknown>;

  /** Customer lookup — `null` when the provider has no customer for the user. */
  findCustomer(request: BillingCustomerQuery): Promise<BillingCustomerIdentity | null>;
  /** Customer creation/provisioning (idempotent on `idempotencyKey`). */
  createCustomer(request: BillingCustomerCreateRequest): Promise<BillingCustomerIdentity>;

  /** Checkout initialization for a catalogue plan (no route, no redirect here). */
  initializeCheckout(request: BillingCheckoutRequest): Promise<BillingCheckoutSession>;

  /** Subscription lookup — `null` when the provider has none. */
  findSubscription(request: BillingSubscriptionQuery): Promise<ProviderSubscriptionState | null>;
  /** Subscription verification: one authoritative read, normalized. */
  verifySubscription(request: BillingSubscriptionVerifyRequest): Promise<ProviderSubscriptionState>;
  /** Synchronization: apply verified provider state, report the outcome. */
  synchronizeSubscription(request: BillingSubscriptionSyncRequest): Promise<SubscriptionSyncResult>;

  /** Cancellation / management. */
  cancelSubscription(request: BillingSubscriptionCancelRequest): Promise<ProviderSubscriptionState>;

  /** Webhook event normalization (raw delivery → canonical event). */
  normalizeEvent(request: BillingProviderRawEvent): Promise<NormalizedBillingEvent>;
}

export interface RegisteredBillingProviderInfo {
  id: BillingProviderId;
  name: string;
  implemented: boolean;
  live: false;
}

/**
 * Runtime registry of billing providers, keyed by provider id. Mirrors the
 * market-data (M1) and notification (M7.3) registries: it starts EMPTY and
 * implementations are registered at boot by a later PR. Nothing in this
 * repository registers a Paystack provider today, so resolving one fails
 * loudly instead of silently doing nothing.
 */
export class BillingProviderRegistry {
  private readonly providers = new Map<BillingProviderId, BillingProvider>();

  register(provider: BillingProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`A billing provider is already registered for "${provider.id}"`);
    }
    if (provider.live !== false) {
      // Defensive: `live` is `false` by type, and billing must never be wired
      // as a live path. Kept as a runtime guard so a future adapter cannot
      // claim otherwise.
      throw new Error(`Billing provider "${provider.id}" cannot be registered as live: billing is not an execution path`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: BillingProviderId): BillingProvider | undefined {
    return this.providers.get(id);
  }

  list(): RegisteredBillingProviderInfo[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      name: provider.name,
      implemented: provider.implemented,
      live: provider.live,
    }));
  }

  /** Providers whose operations actually work right now (empty in PR2). */
  implementedProviders(): BillingProviderId[] {
    return [...this.providers.values()].filter((provider) => provider.implemented).map((provider) => provider.id);
  }

  get size(): number {
    return this.providers.size;
  }
}

export function createBillingProviderRegistry(): BillingProviderRegistry {
  return new BillingProviderRegistry();
}

/* -------------------------------------------------------------------------- */
/* Fail-closed placeholder — the seam exists, the integration does not        */
/* -------------------------------------------------------------------------- */

/** Thrown by every operation of an unimplemented provider. */
export class BillingProviderNotImplementedError extends Error {
  readonly code = 'billing_provider_not_implemented' as const;
  readonly provider: BillingProviderId;
  readonly operation: BillingProviderOperation;

  constructor(provider: BillingProviderId, operation: BillingProviderOperation) {
    super(
      `Billing provider "${provider}" does not implement "${operation}". ` +
        'No Paystack API integration exists yet: Billing PR2 defines the provider seam only ' +
        '(no HTTP call, no checkout, no portal, no webhook, no synchronization).',
    );
    this.name = 'BillingProviderNotImplementedError';
    this.provider = provider;
    this.operation = operation;
  }
}

export function isBillingProviderNotImplemented(error: unknown): error is BillingProviderNotImplementedError {
  return error instanceof BillingProviderNotImplementedError;
}

function notImplemented<T>(provider: BillingProviderId, operation: BillingProviderOperation): Promise<T> {
  return Promise.reject(new BillingProviderNotImplementedError(provider, operation));
}

/**
 * The fail-closed placeholder for the Paystack seam. Every operation rejects
 * with `BillingProviderNotImplementedError`; there is no code path from here
 * to a network, a credential or a database write. Later PRs replace it with a
 * real adapter — and until one is registered, this is what a caller gets.
 */
export function createUnimplementedBillingProvider(id: BillingProviderId = BILLING_PROVIDER): BillingProvider {
  return {
    id,
    name: `${id}-unimplemented`,
    implemented: false,
    live: false as const,
    describe() {
      return Object.freeze({
        id,
        implemented: false,
        live: false,
        // No credential, key, URL or transport detail exists to describe.
        integration: 'none',
        catalogueVersion: SERVER_BILLING_CATALOGUE.version,
        currency: SERVER_BILLING_CATALOGUE.currency,
      });
    },
    findCustomer() {
      return notImplemented<BillingCustomerIdentity | null>(id, 'findCustomer');
    },
    createCustomer() {
      return notImplemented<BillingCustomerIdentity>(id, 'createCustomer');
    },
    initializeCheckout() {
      return notImplemented<BillingCheckoutSession>(id, 'initializeCheckout');
    },
    findSubscription() {
      return notImplemented<ProviderSubscriptionState | null>(id, 'findSubscription');
    },
    verifySubscription() {
      return notImplemented<ProviderSubscriptionState>(id, 'verifySubscription');
    },
    synchronizeSubscription() {
      return notImplemented<SubscriptionSyncResult>(id, 'synchronizeSubscription');
    },
    cancelSubscription() {
      return notImplemented<ProviderSubscriptionState>(id, 'cancelSubscription');
    },
    normalizeEvent() {
      return notImplemented<NormalizedBillingEvent>(id, 'normalizeEvent');
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Catalogue integration (the seam resolves plans from the catalogue only)    */
/* -------------------------------------------------------------------------- */

/**
 * Plan identity for a checkout/subscription, derived from the authoritative
 * catalogue mapping. The seam never carries its own plan table.
 */
export function seamPlanIdentity(
  cataloguePlan: BillingPlanIdentity['cataloguePlan'],
  interval: BillingPlanIdentity['interval'],
): BillingPlanIdentity {
  return billingPlanIdentity(cataloguePlan, interval);
}

/**
 * Amount a checkout would be initialized for, in integer minor units — read
 * from the authoritative catalogue (validated at module load), never restated
 * here. A later PR passes this to the provider; PR2 only resolves it.
 */
export function seamAmountMinor(plan: BillingPlanIdentity): number {
  return billingPlanPrice(plan).amountMinor;
}

/** Convenience accessor over the same catalogue authority. */
export function seamCataloguePriceMinor(
  cataloguePlan: BillingPlanIdentity['cataloguePlan'],
  interval: BillingPlanIdentity['interval'],
): number {
  return cataloguePriceMinor(cataloguePlan, interval);
}

/* -------------------------------------------------------------------------- */
/* Deterministic hashing (pure; no I/O)                                       */
/* -------------------------------------------------------------------------- */

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Canonical JSON of an unknown provider payload: object keys sorted
 * recursively, arrays kept in order, `undefined` dropped. Deterministic, so
 * the same delivery always hashes identically — the property the ledger's
 * `payload_hash` depends on.
 */
export function canonicalizeBillingPayload(payload: unknown): string {
  const canonical = JSON.stringify(sortValue(payload));
  // JSON.stringify returns undefined for a bare `undefined`; canonicalize it
  // explicitly so the hash of an absent payload is still deterministic.
  return canonical === undefined ? 'undefined' : canonical;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const nested = sortValue(source[key]);
      if (nested !== undefined) sorted[key] = nested;
    }
    return sorted;
  }
  return value;
}

/** sha256 of a provider payload. The payload itself is never persisted. */
export function billingEventPayloadHash(payload: unknown): string {
  return sha256(canonicalizeBillingPayload(payload));
}

/**
 * The durable idempotency key of one provider event: sha256 over the canonical
 * field string defined by the contract (`provider | providerEventId |
 * eventType | occurredAt | payloadHash`). Two deliveries of the same provider
 * event produce the same key, which is what makes migration 0031's UNIQUE
 * index collapse a replay onto one row.
 */
export function billingEventIdempotencyKey(input: BillingEventIdempotencyInput): string {
  return sha256(billingEventIdempotencyCanonicalString(input));
}

/** Validates a normalized event before it may cross back over the seam. */
export function parseNormalizedBillingEvent(event: unknown): NormalizedBillingEvent {
  return normalizedBillingEventSchema.parse(event);
}
