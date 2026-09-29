import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BILLING_CURRENCY,
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  BILLING_PROVIDER,
  billingCustomerIdentitySchema,
  billingPaymentAmountSchema,
  billingPaymentCurrencySchema,
  providerSubscriptionStateSchema,
  billingEventCategory,
  billingPricingSnapshotSchema,
  providerEventIdentitySchema,
  providerEventReferenceSchema,
  type BillingCustomerIdentity,
  type BillingPaymentAmount,
  type BillingPricingSnapshot,
  type BillingProviderId,
  type NormalizedBillingEvent,
  type ProviderSubscriptionState,
  type SubscriptionSyncResult,
} from '@veltrixeye/contracts';
// The billing provider SEAM (the interface this adapter satisfies, its request
// schemas and the checkout session contract) lives in core. Core never imports
// a provider package, so this dependency cannot create a cycle.
import {
  assertProviderPlanMatches,
  billingCheckoutRequestSchema,
  billingCheckoutSessionSchema,
  billingCustomerCreateRequestSchema,
  billingCustomerQuerySchema,
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  billingProviderRawEventSchema,
  billingSubscriptionCancelRequestSchema,
  billingSubscriptionQuerySchema,
  billingSubscriptionVerifyRequestSchema,
  isBillingProviderPlanError,
  parseNormalizedBillingEvent,
  providerPlanExpectationFromSnapshot,
  verifyPricingSnapshot,
  type BillingProviderPlan,
  type BillingCheckoutRequest,
  type BillingCheckoutSession,
  type BillingCustomerCreateRequest,
  type BillingCustomerQuery,
  type BillingProvider,
  type BillingProviderRawEvent,
  type BillingSubscriptionCancelRequest,
  type BillingSubscriptionQuery,
  type BillingSubscriptionSyncRequest,
  type BillingSubscriptionVerifyRequest,
} from '@veltrixeye/core';
import {
  PaystackAdapterError,
  paystackInvalidRequest,
  paystackUnauthorizedAmount,
} from './errors.js';
import {
  PAYSTACK_CANONICAL_EVENT_TYPES,
  PAYSTACK_SUPPORTED_EVENTS,
  PAYSTACK_UNSUPPORTED_EVENT_REASONS,
  normalizePaystackEventPayload,
  paystackLifecycleState,
} from './events.js';
import {
  PAYSTACK_LIVE,
  PaystackClient,
  type PaystackClientConfig,
  type PaystackFetchFn,
  type PaystackSubscriptionRecord,
} from './client.js';

/**
 * The Paystack billing provider — SANDBOX ONLY, fail-closed, no hidden I/O.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ADAPTER IMPLEMENTS (documented provider operations only)
 * ---------------------------------------------------------------------------
 *  - `findCustomer`         → `GET  /customer/:email_or_code` (documented),
 *                             with conservative 404 classification;
 *  - `createCustomer`       → `POST /customer` (documented);
 *  - `initializeCheckout`   → `POST /transaction/initialize` (documented), using
 *                             an ALREADY-AUTHORIZED amount: the adapter never
 *                             prices, never converts and never invents one.
 *  - `findSubscription`     → `GET /subscription/:id_or_code` (documented,
 *                             Billing Step 9b Part 1): the documented
 *                             single-subscription READ. It reports what the
 *                             provider documents about the subscription the
 *                             caller named — its own code/id, the owning
 *                             customer, the plan it was sold as, its
 *                             documented status mapped through the ONE shared
 *                             status mapping, and the payment amount exactly as
 *                             reported. `null` is returned ONLY for a 404 that
 *                             clearly says the subscription does not exist; an
 *                             ambiguous 404 is an error, never "no
 *                             subscription". Nothing is retained.
 *  - `verifySubscription`   → `GET /transaction/verify/:reference` (documented,
 *                             Later-billing-PR #7): the checkout read. It
 *                             verifies OUR checkout reference and reports what
 *                             the provider documents for it (customer, amount,
 *                             currency). The published verify response carries
 *                             NO subscription status and NO subscription code,
 *                             so the lifecycle state it reports is always the
 *                             canonical `unknown` (manual review) — never a
 *                             state inferred from a transaction status. It
 *                             remains the read that confirms a PAYMENT; the
 *                             subscription read above reports subscription
 *                             state and confirms no payment.
 *  - `cancelSubscription`   → `POST /subscription/disable` (documented,
 *                             Billing Step 9b Part 2): NON-IMMEDIATE
 *                             cancellation only. The provider documents ONE
 *                             subscription-cancellation operation and it
 *                             requires BOTH the subscription code AND that
 *                             subscription's email token, so the credential is
 *                             obtained inside the client, from the documented
 *                             subscription read, spent on that one call and
 *                             dropped. It never crosses this seam: not on a
 *                             request, not on the canonical state, not in a log
 *                             and not in an error message. `immediate: true`
 *                             FAILS CLOSED — nothing published ends access
 *                             mid-period, so it is refused rather than
 *                             approximated by an irreversible verb.
 *  - `normalizeEvent`       → NO provider call: a pure function of a delivered
 *                             webhook payload (`./events.ts`). It normalizes
 *                             only the four events whose payload shapes the
 *                             provider publishes (`charge.success`,
 *                             `subscription.create`, `invoice.update`,
 *                             `invoice.payment_failed`); every other event name
 *                             becomes the canonical `unrecognized` event, and a
 *                             supported event with a malformed payload is
 *                             refused. It performs no verification, no
 *                             confirmation and no I/O. THERE IS STILL NO
 *                             WEBHOOK RECEIVER: nothing in this repository
 *                             accepts a delivery, verifies a signature or
 *                             persists an event — that is the next step, and it
 *                             is what will call this normalizer.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT IMPLEMENT (and why)
 * ---------------------------------------------------------------------------
 *  - `synchronizeSubscription`: synchronization is performed by core's
 *    `BillingSubscriptionSyncService`, which owns the database write, the
 *    canonical status mapping and the ledger transitions. The adapter holds no
 *    database access and never applies state, so this operation FAILS CLOSED.
 *    Reading a subscription is not applying one, and cancelling one is not
 *    reconciling one.
 *
 * `implemented` therefore stays `false`, honestly: the adapter makes real
 * provider calls for six of the eight seam operations and normalizes events
 * locally for a seventh; the remaining one refuses.
 *
 * ---------------------------------------------------------------------------
 * FAIL-CLOSED RULES ENFORCED HERE
 * ---------------------------------------------------------------------------
 *  1. Sandbox only: `sk_test_` keys only; live keys are refused at construction
 *     and `live` is pinned `false`.
 *  2. An authorized pricing snapshot is REQUIRED to initialize a payment. A
 *     missing, malformed, mismatched or provider-plan-inconsistent snapshot
 *     means nothing is sent.
 *  3. Amounts are integers in payment-currency minor units with the expected
 *     exponent. No floats cross this boundary and no amount is derived here.
 *  4. A recurring (plan-bound) charge requires a locally authorized plan epoch:
 *     the provider plan identifier, mode, status, amount, currency, interval,
 *     commercial plan, FX version and pricing-policy version must ALL match the
 *     authorization. Any mismatch fails closed (no fallback mapping, no
 *     re-rate).
 *  5. The provider's acknowledgement must echo OUR reference. A different
 *     reference is a conflict, never an accepted success.
 *  6. Provider idempotency is NOT assumed: no idempotency header is sent, no
 *     retry is performed, and local deterministic idempotency keys stay with
 *     the caller (`./pricing.ts` / migration 0032).
 *  7. No raw provider payload is stored, logged, or embedded in an error.
 *  8. A delivered event is normalized only against a PUBLISHED payload shape
 *     (`./events.ts`). An event name whose shape is not published becomes the
 *     canonical `unrecognized` event; a supported event with a missing,
 *     mis-typed, self-contradictory or non-sandbox payload is refused. Event
 *     identity (payload hash + idempotency key) is derived deterministically by
 *     core, never invented here.
 *  9. Normalizing an event is not confirming a payment, not verifying a
 *     subscription and not resolving a local subject: it grants nothing, and
 *     `grantsExecution` stays pinned `false` by the canonical contract.
 * 10. The subscription read (`findSubscription`) is sandbox-guarded (a
 *     non-sandbox domain is refused), requires the caller to have named a
 *     subscription id or code (a user id alone is not a lookup key, so it
 *     refuses BEFORE any call), and requires the provider to ECHO that
 *     identifier — a response describing a different subscription is a
 *     conflict, never this subscription. It asserts no catalogue plan, no
 *     interval and no commercial currency (only a locally authorized plan epoch
 *     may say what a provider plan MEANS), and reports no billing period: the
 *     published read documents neither a period start nor a period end.
 * 11. The provider's subscription `email_token` — the credential it documents
 *     as required to CANCEL a subscription — exists ONLY in memory, inside the
 *     one client method that spends it. It is never returned, never normalized
 *     onto any contract, never logged, never persisted and never put in an
 *     error message (it is registered as a redaction literal for the call, so
 *     a provider that echoes it back cannot leak it through a refusal). The
 *     general subscription read does not declare it at all, so no other
 *     operation, record or state can ever carry it.
 * 12. A read is not an application: `findSubscription` changes nothing, grants
 *     nothing and confirms no payment. Applying verified state to the
 *     authoritative subscription row remains core's synchronization step.
 * 13. Cancellation is fail-closed on its prerequisites and non-immediate
 *     only: an identifier that is not reference-shaped, a missing
 *     subscription, a response that does not echo the subscription that was
 *     named, a non-sandbox domain, or a response carrying no credential all
 *     mean the disable is NEVER attempted. An immediate cancellation is
 *     refused before any call, because the provider publishes no operation
 *     that would do it and this verb would be a different, irreversible act.
 *
 * The adapter holds no database access: the two local directories below are
 * supplied by composition (apps/api), so this package cannot read or write
 * billing state behind the seam's back.
 */

/* -------------------------------------------------------------------------- */
/* Composition-supplied local directories                                     */
/* -------------------------------------------------------------------------- */

/** What the adapter needs to know about the local billing customer. */
export interface PaystackCustomerDirectory {
  /**
   * The local record of this user's provider customer, or `null` when the user
   * has not been provisioned with the provider yet.
   */
  find(
    userId: string,
  ): Promise<{ email: string; providerCustomerCode: string | null } | null>;
}

/**
 * A locally AUTHORIZED provider-plan epoch. Composition reads the durable
 * `billing_provider_plans` row (migration 0032) and validates it with core's
 * `parseProviderPlan`, so an epoch this build does not fully understand can
 * never reach the adapter; the adapter then compares that same validated value
 * against the authorized payment with core's `assertProviderPlanMatches`. One
 * implementation of the rule, used by the adapter and covered by tests.
 */
export interface PaystackPlanDirectory {
  /** The authorized epoch for a provider plan identifier, or `null`. */
  find(providerPlanId: string): Promise<BillingProviderPlan | null>;
}

export interface PaystackProviderConfig extends PaystackClientConfig {
  customers: PaystackCustomerDirectory;
  plans: PaystackPlanDirectory;
}

const PAYSTACK_OPERATIONS = [
  'findCustomer',
  'createCustomer',
  'initializeCheckout',
  'findSubscription',
  'verifySubscription',
  'synchronizeSubscription',
  'cancelSubscription',
  'normalizeEvent',
] as const;
export type PaystackOperation = (typeof PAYSTACK_OPERATIONS)[number];

/**
 * Operations this adapter really performs: six documented provider calls
 * (customer fetch, customer create, transaction initialize, the subscription
 * fetch read, the transaction-verify read and the non-immediate subscription
 * cancellation), and one purely local normalization of delivered event
 * payloads.
 */
export const PAYSTACK_IMPLEMENTED_OPERATIONS: readonly PaystackOperation[] = [
  'findCustomer',
  'createCustomer',
  'initializeCheckout',
  'findSubscription',
  'verifySubscription',
  'cancelSubscription',
  'normalizeEvent',
] as const;

/**
 * The canonical lifecycle state a transaction verification reports. The
 * provider's published verify response documents a TRANSACTION status only —
 * no subscription status and no subscription code — so there is no provider
 * subscription status to map through `PAYSTACK_LIFECYCLE_STATE_FOR_STATUS`.
 * A missing status fails closed to `unknown`, which the canonical contract
 * defines as never changing authoritative state and always requiring review.
 * A transaction status (for example `success`) is never promoted to a
 * subscription state: that relationship is not published.
 */
export const PAYSTACK_VERIFIED_TRANSACTION_LIFECYCLE_STATE = 'unknown' as const;

/** Operations that fail closed, with the reason, for operators. */
export const PAYSTACK_UNIMPLEMENTED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  synchronizeSubscription:
    'synchronization is performed by core (BillingSubscriptionSyncService); the adapter never applies state',
});

export class PaystackNotImplementedError extends PaystackAdapterError {
  readonly operation: PaystackOperation;

  constructor(operation: PaystackOperation) {
    super(
      'not_implemented',
      `The Paystack adapter does not implement "${operation}": ${
        PAYSTACK_UNIMPLEMENTED_REASONS[operation] ?? 'no verified provider operation exists for it'
      }. Nothing was called.`,
    );
    this.name = 'PaystackNotImplementedError';
    this.operation = operation;
  }
}

export function isPaystackNotImplementedError(error: unknown): error is PaystackNotImplementedError {
  return error instanceof PaystackNotImplementedError;
}

/* -------------------------------------------------------------------------- */
/* Deterministic local identity                                               */
/* -------------------------------------------------------------------------- */

/**
 * A deterministic local identifier for a provider customer, derived from
 * (provider, user). A retried provisioning attempt therefore produces the SAME
 * local identity instead of a second one — local determinism, never provider
 * idempotency (which is not documented and never assumed).
 */
export function deterministicLocalId(...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // RFC 4122 shape (version 4 variant 8) so the value is a valid uuid.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export class PaystackBillingProvider implements BillingProvider {
  readonly id: BillingProviderId = BILLING_PROVIDER;
  readonly name = 'paystack-sandbox';
  /**
   * Honest capability flag. The seam defines eight operations; six are
   * implemented against documented endpoints (plus local event
   * normalization), so this is `false` until the rest are — callers must treat
   * a non-implemented provider as unavailable.
   */
  readonly implemented = false;
  readonly live = PAYSTACK_LIVE;

  private readonly client: PaystackClient;

  constructor(private readonly config: PaystackProviderConfig) {
    this.client = new PaystackClient(config);
  }

  describe(): Record<string, unknown> {
    return {
      ...this.client.describe(),
      implemented: this.implemented,
      operations: {
        implemented: [...PAYSTACK_IMPLEMENTED_OPERATIONS],
        unimplemented: PAYSTACK_OPERATIONS.filter(
          (operation) => !PAYSTACK_IMPLEMENTED_OPERATIONS.includes(operation),
        ),
      },
      /**
       * Operator-facing summary of the verification read (Later-billing-PR #7):
       * the documented transaction-verify operation, which reports no
       * subscription status, so every verified state is `unknown` (review).
       * It confirms nothing to an entitlement and grants nothing.
       */
      verification: {
        operation: 'transaction.verify',
        subscriptionRead: 'none',
        reportedLifecycleState: PAYSTACK_VERIFIED_TRANSACTION_LIFECYCLE_STATE,
        grantsEntitlements: false,
        grantsExecution: false,
      },
      /**
       * Operator-facing summary of the event contract. `receiver: 'none'` is
       * the honest state of this build: the normalizer exists, nothing accepts
       * a delivery yet, and normalizing one would neither confirm a payment nor
       * grant anything.
       */
      events: {
        receiver: 'none',
        signatureVerification: 'none',
        confirmsPayment: false,
        grantsExecution: false,
        supported: [...PAYSTACK_SUPPORTED_EVENTS],
        canonicalEventTypes: PAYSTACK_CANONICAL_EVENT_TYPES,
        unsupported: Object.keys(PAYSTACK_UNSUPPORTED_EVENT_REASONS),
      },
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Customers                                                                */
  /* ------------------------------------------------------------------------ */

  async findCustomer(request: BillingCustomerQuery): Promise<BillingCustomerIdentity | null> {
    const parsed = billingCustomerQuerySchema.safeParse(request);
    if (!parsed.success) {
      throw paystackInvalidRequest('findCustomer was called with a request that is not canonical.');
    }

    const local = await this.config.customers.find(parsed.data.userId);
    const identifier = local?.providerCustomerCode ?? local?.email ?? parsed.data.email ?? null;
    if (identifier === null || identifier === '') {
      // Without a locally recorded provider customer or a caller-supplied email
      // there is nothing to look up. Fail closed rather than guess an email.
      throw paystackInvalidRequest(
        'findCustomer needs a locally recorded provider customer or an email; none was available.',
      );
    }

    const record = await this.client.fetchCustomer(identifier);
    if (record === null) return null;

    const email = (record.email ?? local?.email ?? parsed.data.email ?? '').toLowerCase();
    if (email === '') {
      throw paystackInvalidRequest(
        'The provider customer could not be associated with a local email address.',
      );
    }

    return this.identity({
      userId: parsed.data.userId,
      email,
      providerCustomerId: record.providerCustomerId,
      providerCustomerCode: record.providerCustomerCode,
      status: 'provisioned',
      lastReference: null,
    });
  }

  async createCustomer(request: BillingCustomerCreateRequest): Promise<BillingCustomerIdentity> {
    const parsed = billingCustomerCreateRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw paystackInvalidRequest('createCustomer was called with a request that is not canonical.');
    }

    const record = await this.client.createCustomer({ email: parsed.data.email });
    return this.identity({
      userId: parsed.data.userId,
      email: parsed.data.email,
      providerCustomerId: record.providerCustomerId,
      providerCustomerCode: record.providerCustomerCode,
      status: 'provisioned',
      lastReference: null,
    });
  }

  private identity(input: {
    userId: string;
    email: string;
    providerCustomerId: string | null;
    providerCustomerCode: string | null;
    status: 'provisioned';
    lastReference: string | null;
  }): BillingCustomerIdentity {
    const now = this.client.now().toISOString();
    const identity: BillingCustomerIdentity = {
      id: deterministicLocalId('billing-customer', this.id, input.userId),
      userId: input.userId,
      provider: this.id,
      email: input.email,
      providerCustomerId: input.providerCustomerId,
      providerCustomerCode: input.providerCustomerCode,
      status: input.status,
      lastReference: input.lastReference,
      provisionedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const validated = billingCustomerIdentitySchema.safeParse(identity);
    if (!validated.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The provider customer could not be normalized onto the canonical identity contract: ${validated.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return validated.data;
  }

  /* ------------------------------------------------------------------------ */
  /* Checkout initialization                                                  */
  /* ------------------------------------------------------------------------ */

  async initializeCheckout(request: BillingCheckoutRequest): Promise<BillingCheckoutSession> {
    const parsedRequest = billingCheckoutRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw paystackInvalidRequest('initializeCheckout was called with a request that is not canonical.');
    }

    // (2) An authorized pricing snapshot is mandatory: this adapter never
    // prices. Without one, nothing is sent and nothing is charged.
    const snapshotInput = (request as { pricing?: unknown }).pricing;
    if (snapshotInput === undefined || snapshotInput === null) {
      throw paystackUnauthorizedAmount(
        'initializeCheckout requires an already-authorized pricing snapshot; the adapter never resolves a price itself.',
      );
    }
    const snapshot = this.authorizeSnapshot(snapshotInput, parsedRequest.data);

    // (4) A plan-bound (recurring) charge must match a locally authorized epoch.
    if (snapshot.providerPlanId !== null) {
      await this.assertPlanAuthorized(snapshot);
    }

    // The provider needs the customer's email; it comes from the local
    // directory, never from a request field this seam does not have.
    const local = await this.config.customers.find(parsedRequest.data.userId);
    const email = local?.email ?? null;
    if (email === null || email === '') {
      throw new PaystackAdapterError(
        'customer_not_provisioned',
        'The user has no locally recorded provider customer, so no payment can be initialized. Nothing was charged.',
      );
    }

    const callbackUrl = this.callbackUrl(parsedRequest.data.callbackUrl);

    try {
      const initialized = await this.client.initializeTransaction({
        amountMinor: snapshot.payment.paymentAmountMinor,
        currency: snapshot.payment.paymentCurrency,
        email,
        reference: parsedRequest.data.reference,
        callbackUrl,
        plan: snapshot.providerPlanId,
        metadata: {
          local_reference: parsedRequest.data.reference,
          pricing_policy_version: snapshot.pricingPolicyVersion,
          fx_rate_version_id: snapshot.fx.fxRateVersionId,
        },
      });

      // (5) The provider must acknowledge OUR reference.
      if (initialized.reference !== parsedRequest.data.reference) {
        throw new PaystackAdapterError(
          'reference_conflict',
          `The provider acknowledged a different reference ("${initialized.reference}") than the one submitted. ` +
            'The result is not treated as this checkout: this is a conflict requiring review.',
        );
      }

      return this.session({
        request: parsedRequest.data,
        snapshot,
        status: 'initialized',
        providerReference: initialized.reference,
        authorizationUrl: initialized.authorizationUrl,
      });
    } catch (error) {
      if (error instanceof PaystackAdapterError) {
        if (error.reason === 'provider_rejected') {
          // A documented provider rejection: nothing was initialized.
          return this.session({
            request: parsedRequest.data,
            snapshot,
            status: 'failed',
            providerReference: null,
            authorizationUrl: null,
          });
        }
        if (error.reason === 'provider_unavailable' || error.reason === 'unexpected_response') {
          // Unknown outcome: report unavailable. A caller must never treat this
          // as an initialization, and must never retry blindly.
          return this.session({
            request: parsedRequest.data,
            snapshot,
            status: 'unavailable',
            providerReference: null,
            authorizationUrl: null,
          });
        }
      }
      throw error;
    }
  }

  /** Validate the authorized snapshot and its relationship to the request. */
  private authorizeSnapshot(
    snapshotInput: unknown,
    request: BillingCheckoutRequest,
  ): BillingPricingSnapshot {
    const requested = request.plan;
    const parsed = billingPricingSnapshotSchema.safeParse(snapshotInput);
    if (!parsed.success) {
      throw paystackUnauthorizedAmount(
        `The authorized pricing snapshot is not usable: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const snapshot = parsed.data;

    if (snapshot.cataloguePlan !== requested.cataloguePlan || snapshot.interval !== requested.interval) {
      throw paystackUnauthorizedAmount(
        `The authorized pricing snapshot is for ${snapshot.cataloguePlan}/${snapshot.interval}, not for the ` +
          `${requested.cataloguePlan}/${requested.interval} that was requested. Nothing was sent.`,
      );
    }
    if (snapshot.commercialCurrency !== BILLING_CURRENCY) {
      throw paystackUnauthorizedAmount(
        `The authorized pricing snapshot is not denominated in ${BILLING_CURRENCY}. Nothing was sent.`,
      );
    }

    const expectedExponent = BILLING_PAYMENT_AMOUNT_EXPONENT[snapshot.payment.paymentCurrency];
    if (expectedExponent === undefined) {
      throw paystackUnauthorizedAmount(
        `The authorized pricing snapshot quotes an unsupported payment currency ` +
          `("${snapshot.payment.paymentCurrency}"). Nothing was sent.`,
      );
    }
    if (snapshot.payment.paymentAmountExponent !== expectedExponent) {
      throw paystackUnauthorizedAmount(
        `The authorized payment amount exponent (${snapshot.payment.paymentAmountExponent}) does not match ` +
          `${snapshot.payment.paymentCurrency} (${expectedExponent}). Nothing was sent.`,
      );
    }
    // The snapshot may carry our reference (traceability). When it does, it must
    // be THIS request's reference: a snapshot quoted for another purchase is
    // never charged here.
    if (snapshot.providerReference !== null && snapshot.providerReference !== request.reference) {
      throw paystackUnauthorizedAmount(
        'The authorized pricing snapshot was quoted for a different reference than this checkout. Nothing was sent.',
      );
    }

    // Defense in depth: the snapshot must be internally coherent (the recorded
    // commercial amount and FX rate really do produce the recorded payment
    // amount, and the amount clears the documented minimum). Core owns that
    // arithmetic — the adapter never recomputes or converts anything itself.
    try {
      verifyPricingSnapshot(snapshot);
    } catch (error) {
      throw paystackUnauthorizedAmount(
        `The authorized pricing snapshot did not verify before charging: ${
          error instanceof Error ? error.message : 'unknown reason'
        }`,
      );
    }

    return snapshot;
  }

  /**
   * (4) A recurring charge requires the local epoch to authorize EXACTLY this
   * amount, currency, interval, provider plan and FX/pricing epoch. Retirement,
   * a missing mapping or any mismatch fails closed: there is no fallback and no
   * re-rate.
   */
  private async assertPlanAuthorized(snapshot: BillingPricingSnapshot): Promise<void> {
    const providerPlanId = snapshot.providerPlanId;
    if (providerPlanId === null) return;

    const plan = await this.config.plans.find(providerPlanId);
    if (plan === null) {
      throw new PaystackAdapterError(
        'plan_not_registered',
        `Provider plan "${providerPlanId}" has no locally authorized epoch. A recurring charge is refused.`,
      );
    }

    try {
      // Core owns this comparison: provider, mode, commercial plan, interval,
      // currency + exponent, exact amount, provider plan identifier, FX version,
      // pricing policy and ACTIVE status. Retirement, a mismatch or an unknown
      // value fails closed — there is no fallback epoch and no re-rate.
      assertProviderPlanMatches(plan, providerPlanExpectationFromSnapshot(snapshot, providerPlanId));
    } catch (error) {
      if (isBillingProviderPlanError(error)) {
        throw new PaystackAdapterError('plan_mismatch', error.message);
      }
      throw error;
    }
  }

  private callbackUrl(value: string): string {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') {
      throw paystackInvalidRequest('A checkout callback URL must use https.');
    }
    return parsed.toString();
  }

  private session(input: {
    request: BillingCheckoutRequest;
    snapshot: BillingPricingSnapshot;
    status: BillingCheckoutSession['status'];
    providerReference: string | null;
    authorizationUrl: string | null;
  }): BillingCheckoutSession {
    const now = this.client.now().toISOString();
    const session: BillingCheckoutSession = {
      provider: this.id,
      status: input.status,
      reference: input.request.reference,
      providerReference: input.providerReference,
      authorizationUrl: input.authorizationUrl,
      amountMinor: input.snapshot.commercialAmountMinor,
      currency: BILLING_CURRENCY,
      payment: input.snapshot.payment,
      pricing: input.snapshot,
      idempotencyKey: input.request.idempotencyKey,
      initializedAt: now,
    };

    const validated = billingCheckoutSessionSchema.safeParse(session);
    if (!validated.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The checkout session could not be normalized onto the canonical contract: ${validated.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return validated.data;
  }

  /* ------------------------------------------------------------------------ */
  /* Verification (documented transaction-verify read only)                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Verify the provider's view of a checkout, through the ONE documented read:
   * `GET /transaction/verify/:reference`.
   *
   * What it guarantees:
   *  - a canonical request carrying OUR transaction reference is required; a
   *    request with only a provider subscription identifier is refused before
   *    any call (there is no documented subscription read to use it with);
   *  - exactly one provider call, no retry; transport/provider failures surface
   *    as the client's typed errors (unknown outcome, never a default);
   *  - the provider must echo OUR reference (a different one is a conflict)
   *    and report the sandbox domain (anything else is refused);
   *  - the amount is used exactly as reported, in a supported payment currency
   *    with its documented exponent — never converted, never re-rated;
   *  - the reported lifecycle state is ALWAYS `unknown`: the published verify
   *    response carries no subscription status, and a transaction status is
   *    never promoted to a subscription state;
   *  - no cancellation, period, plan or catalogue fact is asserted (none is
   *    published on this response), and no card/authorization field is read;
   *  - the result is re-validated by the canonical `.strict()` contract, so
   *    nothing provider-shaped crosses the seam, and nothing is retained.
   */
  async verifySubscription(request: BillingSubscriptionVerifyRequest): Promise<ProviderSubscriptionState> {
    const parsed = billingSubscriptionVerifyRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw paystackInvalidRequest('verifySubscription was called with a request that is not canonical.');
    }
    const reference = parsed.data.providerReference ?? null;
    if (reference === null) {
      throw paystackInvalidRequest(
        'verifySubscription needs the checkout transaction reference: the provider publishes no subscription read, ' +
          'so a subscription identifier alone cannot be verified. Nothing was called.',
      );
    }

    const verified = await this.client.verifyTransaction(reference);

    if (verified.reference !== reference) {
      throw new PaystackAdapterError(
        'reference_conflict',
        'The provider verified a different reference than the one requested. ' +
          'The result is not treated as this checkout: this is a conflict requiring review.',
      );
    }
    if (verified.domain !== 'test') {
      throw new PaystackAdapterError(
        'response_conflict',
        'The provider reported a non-sandbox transaction domain; this build is sandbox-only, so the verification is refused.',
      );
    }

    const currency = billingPaymentCurrencySchema.safeParse(verified.currency);
    const payment = currency.success
      ? billingPaymentAmountSchema.safeParse({
          paymentCurrency: currency.data,
          paymentAmountMinor: verified.amountMinor,
          paymentAmountExponent: BILLING_PAYMENT_AMOUNT_EXPONENT[currency.data],
        })
      : null;
    if (payment === null || !payment.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider reported an amount or currency this build does not understand for the verified transaction. ' +
          'Nothing is assumed from it.',
      );
    }

    // Step 7: paid_at is required for payment evidence. The client already
    // validates it is a datetime, but the seam defensively ensures it is
    // present and valid before normalizing.
    if (
      typeof verified.paidAt !== 'string' ||
      verified.paidAt.trim() === '' ||
      !z.string().datetime().safeParse(verified.paidAt).success
    ) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider verified transaction is missing required paid_at.',
      );
    }

    const state = providerSubscriptionStateSchema.safeParse({
      provider: this.id,
      state: PAYSTACK_VERIFIED_TRANSACTION_LIFECYCLE_STATE,
      providerSubscriptionId: null,
      providerSubscriptionCode: null,
      providerCustomerId: verified.providerCustomerId,
      providerCustomerCode: verified.providerCustomerCode,
      providerPlanId: null,
      providerReference: verified.reference,
      cataloguePlan: null,
      interval: null,
      currency: null,
      payment: payment.data,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      cancelledAt: null,
      cancellationReason: null,
      sourceEventIdempotencyKey: null,
      observedAt: this.client.now().toISOString(),
      paidAt: verified.paidAt,
      providerTransactionId: verified.providerTransactionId,
      providerTransactionStatus: verified.status,
    });
    if (!state.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The verified transaction could not be normalized onto the canonical provider state at: ${[
          ...new Set(state.error.issues.map((issue) => issue.path.join('.') || '<root>')),
        ].join(', ')}.`,
      );
    }
    return state.data;
  }

  /* ------------------------------------------------------------------------ */
  /* Subscription read (the documented single-subscription fetch)              */
  /* ------------------------------------------------------------------------ */

  /**
   * Read ONE provider subscription (documented: `GET /subscription/:id_or_code`).
   *
   * What it guarantees:
   *  - a canonical request is required, and it must NAME the subscription
   *    (an id or a code). There is no documented "find the subscription of this
   *    user" operation here — a subscription listing is not implemented — so a
   *    request carrying only a local user id is refused BEFORE any call rather
   *    than resolved by guessing which subscription the user meant;
   *  - exactly one provider call, no retry, nothing written and nothing
   *    retained;
   *  - the provider must ECHO the identifier that was asked for, as either the
   *    subscription code or the subscription id. A response that describes a
   *    DIFFERENT subscription is a `response_conflict`, never this
   *    subscription;
   *  - the sandbox posture holds: a non-sandbox `domain` is refused;
   *  - `null` means "the provider has no such subscription", and only for a 404
   *    that clearly says so. An ambiguous or authorization-shaped 404 is a typed
   *    ERROR: an unresolved 404 must never read as "this user has no
   *    subscription";
   *  - the lifecycle state comes from the ONE documented status mapping
   *    (`paystackLifecycleState`, shared with event normalization); an
   *    undocumented status becomes the canonical `unknown` (manual review),
   *    never a guess;
   *  - the payment amount is reported exactly as the provider states it,
   *    in a payment currency this build understands with its documented
   *    exponent; an amount whose currency is not understood is NOT reported
   *    (never converted), and a subscription that contradicts its own plan
   *    amount is refused rather than halved or averaged;
   *  - NO catalogue plan, NO interval and NO commercial currency is asserted:
   *    only a locally authorized plan epoch may say what a provider plan means,
   *    and that is core's synchronization step, not a provider read;
   *  - NO billing period is asserted: the published read documents no period
   *    start and no period end (its `start` is the subscription start instant
   *    and `next_payment_date` is the NEXT charge date — neither is documented
   *    as a period boundary);
   *  - the provider's `email_token` — its cancellation credential — is never
   *    read, never normalized, never logged and never persisted; the result is
   *    re-validated by the canonical `.strict()` contract, so no
   *    provider-shaped field can cross the seam;
   *  - reading a subscription is not confirming a payment and not applying
   *    state: it grants nothing, changes nothing locally, and the transaction
   *    fields of the contract are left null because this read publishes no
   *    transaction.
   */
  async findSubscription(request: BillingSubscriptionQuery): Promise<ProviderSubscriptionState | null> {
    const parsed = billingSubscriptionQuerySchema.safeParse(request);
    if (!parsed.success) {
      throw paystackInvalidRequest('findSubscription was called with a request that is not canonical.');
    }

    const identifier = parsed.data.providerSubscriptionId ?? null;
    if (identifier === null || identifier === '') {
      // No documented "list the subscriptions of this user" read exists in this
      // build, so a local user id is not a lookup key. Refuse before any call
      // rather than fetch a subscription nobody named.
      throw paystackInvalidRequest(
        'findSubscription needs the provider subscription id or code: this build implements only the documented ' +
          'single-subscription read, so a local user id alone cannot be looked up. Nothing was called.',
      );
    }

    const record = await this.client.fetchSubscription(identifier);
    if (record === null) return null;

    // (10) The provider must echo the subscription that was asked for.
    if (record.providerSubscriptionCode !== identifier && record.providerSubscriptionId !== identifier) {
      throw new PaystackAdapterError(
        'response_conflict',
        'The provider returned a different subscription than the one requested. ' +
          'The result is not treated as this subscription: this is a conflict requiring review.',
      );
    }
    if (record.domain !== 'test') {
      throw new PaystackAdapterError(
        'response_conflict',
        'The provider reported a non-sandbox subscription domain; this build is sandbox-only, so the read is refused.',
      );
    }

    const state = providerSubscriptionStateSchema.safeParse({
      provider: this.id,
      // The provider's own status word, mapped by the single documented table
      // shared with event normalization. Anything undocumented is `unknown`,
      // which changes no authoritative state and always requires review.
      state: paystackLifecycleState(record.providerStatus),
      providerSubscriptionId: record.providerSubscriptionId,
      providerSubscriptionCode: record.providerSubscriptionCode,
      providerCustomerId: record.providerCustomerId,
      providerCustomerCode: record.providerCustomerCode,
      providerPlanId: record.providerPlanCode,
      // A subscription read publishes no transaction reference.
      providerReference: null,
      // Only a locally authorized plan epoch may say what a provider plan
      // means; a provider read never resolves a commercial plan.
      cataloguePlan: null,
      interval: null,
      // The COMMERCIAL currency is never provider-reported; the catalogue is
      // the only authority for it.
      currency: null,
      payment: this.subscriptionPayment(record),
      // No period is documented on this read (see the method documentation).
      currentPeriodStart: null,
      currentPeriodEnd: null,
      // The provider publishes no cancellation flag on this read, so none is
      // asserted. A `non-renewing` status is reported through the lifecycle
      // state above, never turned into a cancellation fact.
      cancelAtPeriodEnd: false,
      cancelAt: null,
      cancelledAt: null,
      cancellationReason: null,
      // This state was read, not received as an event.
      sourceEventIdempotencyKey: null,
      observedAt: this.client.now().toISOString(),
      // This read publishes no transaction, so it evidences no payment: the
      // transaction fields stay null and the payment confirmation remains the
      // separate, documented transaction-verify read.
      paidAt: null,
      providerTransactionId: null,
      providerTransactionStatus: null,
    });
    if (!state.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The subscription could not be normalized onto the canonical provider state at: ${[
          ...new Set(state.error.issues.map((issue) => issue.path.join('.') || '<root>')),
        ].join(', ')}.`,
      );
    }
    return state.data;
  }

  /**
   * The payment amount a subscription read reports, or `null` when no amount
   * can be reported honestly.
   *
   * `null` (nothing reported, never a default) when the payload carries no
   * amount, no currency, or a currency this build does not understand: an
   * amount without a known minor unit is never reported. A REFUSAL when the
   * subscription amount and the plan amount it carries disagree — the same
   * documented fact reported twice, contradicting itself.
   */
  private subscriptionPayment(record: PaystackSubscriptionRecord): BillingPaymentAmount | null {
    if (record.amountMinor === null) return null;
    if (record.planAmountMinor !== null && record.planAmountMinor !== record.amountMinor) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider reports a subscription amount that disagrees with the amount on its own plan, so no amount is ' +
          'reported. Nothing was assumed from it.',
      );
    }
    if (record.currency === null) return null;
    const currency = billingPaymentCurrencySchema.safeParse(record.currency);
    if (!currency.success) return null;
    const amount = billingPaymentAmountSchema.safeParse({
      paymentCurrency: currency.data,
      paymentAmountMinor: record.amountMinor,
      paymentAmountExponent: BILLING_PAYMENT_AMOUNT_EXPONENT[currency.data],
    });
    return amount.success ? amount.data : null;
  }

  /* ------------------------------------------------------------------------ */
  /* Cancellation (the documented non-immediate disable only)                  */
  /* ------------------------------------------------------------------------ */

  /**
   * Cancel a provider subscription (documented: `POST /subscription/disable`).
   *
   * NON-IMMEDIATE ONLY. `immediate: true` is refused before any call: the
   * provider publishes exactly one subscription-cancellation operation, and it
   * is this one — it stops future renewals while the period already paid for
   * continues. Nothing published would end access mid-period, so ending it
   * immediately is left unimplemented and fails closed rather than approximated
   * by this verb (which would silently be a different, and irreversible, act
   * than the caller asked for).
   *
   * What it guarantees:
   *  - a canonical request is required, naming the subscription to cancel. A
   *    subscription is never resolved by email, by customer, or by "the
   *    subscription this user seems to have";
   *  - the provider's cancellation credential is obtained INSIDE the client,
   *    from the documented subscription read, and never crosses this seam: it
   *    is not on this request, not on the returned state, not in a log and not
   *    in an error message. Nothing here reads, stores or returns it;
   *  - the operation fails CLOSED when its prerequisites cannot be established:
   *    a non-reference-shaped identifier, a missing subscription, a response
   *    that does not echo the subscription that was named, a non-sandbox
   *    domain, or a response carrying no credential. In each case the disable
   *    is never attempted, so a live provider subscription is never cancelled
   *    on a guess;
   *  - the returned state reports what the operation MEANT and what the
   *    provider ACKNOWLEDGED — nothing more. The documented disable response
   *    publishes no status, no instant and no reason, so none is invented:
   *    `state` is the canonical mapping of the documented "will not renew"
   *    status, `cancelAtPeriodEnd` is `true` (that is what this operation IS),
   *    and `cancelledAt` stays null because access continues to the end of the
   *    paid period;
   *  - `cancellationReason` is OUR reason for asking (the canonical
   *    vocabulary the request already carries), not a provider-reported fact.
   *    The provider publishes no reason for a disable;
   *  - exactly one disable, no retry, no idempotency assumption, and the
   *    result is re-validated by the canonical `.strict()` contract so nothing
   *    provider-shaped crosses back.
   */
  async cancelSubscription(request: BillingSubscriptionCancelRequest): Promise<ProviderSubscriptionState> {
    const parsed = billingSubscriptionCancelRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw paystackInvalidRequest('cancelSubscription was called with a request that is not canonical.');
    }
    if (parsed.data.immediate) {
      throw paystackInvalidRequest(
        'cancelSubscription implements non-immediate cancellation only: the provider documents one subscription ' +
          'operation, which stops future renewals, and publishes nothing that ends access mid-period. Nothing was called.',
      );
    }
    const identifier = parsed.data.providerSubscriptionId ?? null;
    if (identifier === null || identifier === '') {
      throw paystackInvalidRequest(
        'cancelSubscription needs the provider subscription id or code of the subscription to cancel. ' +
          'Nothing was called.',
      );
    }

    // The documented operation, and the only call: the credential is obtained
    // and spent inside the client and never reaches this method.
    const disabled = await this.client.disableSubscription({ idOrCode: identifier });

    const state = providerSubscriptionStateSchema.safeParse({
      provider: this.id,
      // The documented status of a subscription that will not renew, mapped by
      // the SINGLE table shared with event normalization (never restated
      // here): `non-renewing` → `unsubscribed`.
      state: paystackLifecycleState('non-renewing'),
      // The disable operation addresses a subscription by its CODE; the
      // provider's numeric id was not part of the operation and is not claimed.
      providerSubscriptionId: null,
      providerSubscriptionCode: disabled.providerSubscriptionCode,
      // The disable response publishes no customer, plan or plan identity, and
      // this build asserts nothing the operation did not return.
      providerCustomerId: null,
      providerCustomerCode: null,
      providerPlanId: null,
      providerReference: null,
      cataloguePlan: null,
      interval: null,
      currency: null,
      payment: null,
      // The published response documents no period, and a period ending is
      // not a cancellation instant.
      currentPeriodStart: null,
      currentPeriodEnd: null,
      // This IS the documented "stop renewing" operation: access continues to
      // the end of the period already paid for.
      cancelAtPeriodEnd: true,
      cancelAt: null,
      // Access continues, so nothing is cancelled YET and no cancellation
      // instant is published or inferred.
      cancelledAt: null,
      // Our reason for asking, in the canonical vocabulary. The provider
      // publishes no reason for a disable, so none is claimed as its own.
      cancellationReason: parsed.data.reason,
      // The cancellation was requested, not received as an event.
      sourceEventIdempotencyKey: null,
      observedAt: this.client.now().toISOString(),
      // A cancellation evidences no payment and publishes no transaction.
      paidAt: null,
      providerTransactionId: null,
      providerTransactionStatus: null,
    });
    if (!state.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The cancellation could not be normalized onto the canonical provider state at: ${[
          ...new Set(state.error.issues.map((issue) => issue.path.join('.') || '<root>')),
        ].join(', ')}.`,
      );
    }
    return state.data;
  }

  /* ------------------------------------------------------------------------ */
  /* Operations this adapter refuses (fail closed, never guessed)              */
  /* ------------------------------------------------------------------------ */

  synchronizeSubscription(
    _request: BillingSubscriptionSyncRequest,
  ): Promise<SubscriptionSyncResult> {
    return Promise.reject(new PaystackNotImplementedError('synchronizeSubscription'));
  }

  /* ------------------------------------------------------------------------ */
  /* Event normalization (pure: no transport, no clock, no directory, no DB)   */
  /* ------------------------------------------------------------------------ */

  /**
   * Normalize one delivered provider event onto the canonical contract.
   *
   * This is a PURE function of the seam request: it opens no socket, reads no
   * clock, consults neither injected directory and touches no database. It is
   * the seam the (still unwritten) webhook receiver will call after it has
   * verified a delivery's signature — signature verification, raw-body
   * handling, rate limiting and persistence all belong to that receiver, not
   * here.
   *
   * What it guarantees:
   *  - a supported event (`charge.success`, `subscription.create`,
   *    `invoice.update`, `invoice.payment_failed`) is validated against its
   *    published payload shape and mapped onto canonical event types, subject
   *    references and sanitized data;
   *  - a supported event whose payload is missing a required field, carries a
   *    wrong type, contradicts itself, reports a non-sandbox domain or quotes a
   *    currency/amount this build does not understand is REFUSED with a typed
   *    error — it is never silently downgraded to `unrecognized`;
   *  - any other event name (unverified, out of scope or invented) becomes the
   *    canonical `unrecognized` event with no subject and no data, so it can be
   *    recorded without asserting anything;
   *  - identity is deterministic: the payload hash and the idempotency key are
   *    derived by core's single implementation of the canonical rule, so two
   *    deliveries of the same event produce the same key and collapse onto one
   *    ledger row;
   *  - nothing provider-shaped crosses back: the raw body is dropped (only its
   *    hash survives), provider card/authorization/email-token fields are never
   *    read, and the result is re-validated by the canonical `.strict()`
   *    contract with `grantsExecution` pinned `false`.
   *
   * WHAT THIS IS NOT: it is not a payment confirmation, not a transaction
   * verification, not a subscription synchronization and not a local subject
   * resolution (`subject.userId`, `subject.subscriptionId` and
   * `subject.billingCustomerId` are always null here — resolving them is the
   * receiver's job, against the local directories).
   */
  async normalizeEvent(request: BillingProviderRawEvent): Promise<NormalizedBillingEvent> {
    const parsedRequest = billingProviderRawEventSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw paystackInvalidRequest(
        'normalizeEvent was called with a delivery that is not canonical (provider, payload and receivedAt are required).',
      );
    }
    const delivery = parsedRequest.data;

    // Paystack deliveries publish no event id, so this is normally absent and
    // identity rests on the payload hash. When a caller does supply one it must
    // still be a reference-shaped identifier, never credential-shaped material.
    const providerEventId = this.eventReference(delivery.providerEventId);

    // Pure normalization: canonical facts, or a typed refusal.
    const facts = normalizePaystackEventPayload(delivery.payload);

    // Deterministic identity. Core owns both derivations (one implementation of
    // the rule, already covered by core's tests); the payload is hashed, never
    // carried onwards.
    const payloadHash = billingEventPayloadHash(delivery.payload);
    const idempotencyInput = {
      provider: this.id,
      providerEventId,
      eventType: facts.eventType,
      occurredAt: facts.occurredAt,
      payloadHash,
    };
    const identity = providerEventIdentitySchema.safeParse({
      ...idempotencyInput,
      idempotencyKey: billingEventIdempotencyKey(idempotencyInput),
      receivedAt: delivery.receivedAt,
    });
    if (!identity.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The delivery could not be given a canonical event identity at: ${[...new Set(
          identity.error.issues.map((issue) => issue.path.join('.') || '<root>'),
        )].join(', ')}. Nothing was normalized.`,
      );
    }

    try {
      // Re-validated by the canonical contract before crossing back over the
      // seam: `.strict()` rejects any provider-shaped field, the category must
      // follow the event type, and `grantsExecution` can only be `false`.
      return parseNormalizedBillingEvent({
        identity: identity.data,
        category: billingEventCategory(facts.eventType),
        subject: facts.subject,
        data: facts.data,
        grantsExecution: false,
      });
    } catch (error) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The normalized event did not satisfy the canonical contract, so no provider detail crosses the seam.',
        { cause: error },
      );
    }
  }

  /** A caller-supplied provider event id must be reference-shaped. */
  private eventReference(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const parsed = providerEventReferenceSchema.safeParse(value);
    if (!parsed.success) {
      throw paystackInvalidRequest(
        'A provider event id must be a reference-shaped identifier of at most 190 characters; the value supplied is not one, so the delivery is refused before any payload is read.',
      );
    }
    return parsed.data;
  }
}

/** Build the sandbox adapter. Configuration is validated before any call. */
export function createPaystackProvider(config: PaystackProviderConfig): PaystackBillingProvider {
  return new PaystackBillingProvider(config);
}

export type { PaystackFetchFn };
