import { createHash } from 'node:crypto';
import {
  BILLING_CURRENCY,
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  BILLING_PROVIDER,
  billingCustomerIdentitySchema,
  billingPricingSnapshotSchema,
  type BillingCustomerIdentity,
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
  isBillingProviderPlanError,
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
  PAYSTACK_LIVE,
  PaystackClient,
  type PaystackClientConfig,
  type PaystackFetchFn,
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
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT IMPLEMENT (and why)
 * ---------------------------------------------------------------------------
 *  - `findSubscription` / `verifySubscription`: the platform's verified facts
 *    do not include a subscription READ operation. Reading a subscription is
 *    therefore left unimplemented rather than guessed, and FAILS CLOSED.
 *  - `synchronizeSubscription`: excluded from this change (no subscription
 *    synchronization), and it needs verified provider state that does not exist
 *    yet.
 *  - `cancelSubscription`: cancellation is documented as requiring BOTH the
 *    subscription code and the subscription's email token, and no build here
 *    persists that token (there is no subscription writer yet). Rather than
 *    guess a cancellation path — the provider also documents a
 *    `PUT /plan` update whose default cancels or reprices existing
 *    subscriptions — cancellation FAILS CLOSED with an explicit reason.
 *  - `normalizeEvent`: irrelevant without a webhook receiver (excluded from this
 *    change), and the payload shapes of provider events are not among the
 *    verified facts, so no event is normalized here. FAILS CLOSED.
 *
 * `implemented` therefore stays `false`, honestly: the adapter makes real
 * provider calls for the three operations above and refuses the rest.
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

/** Operations this adapter really performs (documented provider operations). */
export const PAYSTACK_IMPLEMENTED_OPERATIONS: readonly PaystackOperation[] = [
  'findCustomer',
  'createCustomer',
  'initializeCheckout',
] as const;

/** Operations that fail closed, with the reason, for operators. */
export const PAYSTACK_UNIMPLEMENTED_REASONS: Readonly<Record<string, string>> = Object.freeze({
  findSubscription: 'the platform has no verified subscription read operation',
  verifySubscription: 'the platform has no verified subscription read operation',
  synchronizeSubscription: 'subscription synchronization is out of scope for this change',
  cancelSubscription:
    'cancellation is documented as needing the subscription code AND its email token, which this build does not persist',
  normalizeEvent: 'no webhook receiver exists and event payload shapes are not verified',
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
   * Honest capability flag. The seam defines eight operations; three are
   * implemented against documented endpoints, so this is `false` until the rest
   * are — callers must treat a non-implemented provider as unavailable.
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
  /* Operations this adapter refuses (fail closed, never guessed)              */
  /* ------------------------------------------------------------------------ */

  findSubscription(_request: BillingSubscriptionQuery): Promise<ProviderSubscriptionState | null> {
    return Promise.reject(new PaystackNotImplementedError('findSubscription'));
  }

  verifySubscription(_request: BillingSubscriptionVerifyRequest): Promise<ProviderSubscriptionState> {
    return Promise.reject(new PaystackNotImplementedError('verifySubscription'));
  }

  synchronizeSubscription(
    _request: BillingSubscriptionSyncRequest,
  ): Promise<SubscriptionSyncResult> {
    return Promise.reject(new PaystackNotImplementedError('synchronizeSubscription'));
  }

  cancelSubscription(
    _request: BillingSubscriptionCancelRequest,
  ): Promise<ProviderSubscriptionState> {
    return Promise.reject(new PaystackNotImplementedError('cancelSubscription'));
  }

  normalizeEvent(_request: BillingProviderRawEvent): Promise<NormalizedBillingEvent> {
    return Promise.reject(new PaystackNotImplementedError('normalizeEvent'));
  }
}

/** Build the sandbox adapter. Configuration is validated before any call. */
export function createPaystackProvider(config: PaystackProviderConfig): PaystackBillingProvider {
  return new PaystackBillingProvider(config);
}

export type { PaystackFetchFn };
