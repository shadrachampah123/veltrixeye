import { z } from 'zod';
import {
  PAYSTACK_ERROR_MESSAGE_MAX,
  PaystackAdapterError,
  paystackConfigurationError,
  paystackInvalidRequest,
  redactPaystackMessage,
} from './errors.js';

/**
 * Paystack REST client — SANDBOX ONLY, documented operations only, one HTTP
 * attempt per call.
 *
 * The platform's payment provider is used exclusively in TEST MODE. This client
 * therefore:
 *
 *  * accepts ONLY a `sk_test_` secret key. A live key (`sk_live_`) — or any
 *    other key shape — is refused at construction time, so no code path,
 *    configuration mistake or deployment can put live money through this build;
 *  * talks to exactly one host, `https://api.paystack.co`, which is a constant.
 *    There is no environment variable for it: no deployment can point the
 *    adapter at a different host, and no test can accidentally reach the real
 *    API (the fetch implementation is injected, and the test suite injects a
 *    stub that records calls instead of opening sockets);
 *  * calls only operations that appear in the provider's published API
 *    documentation: create customer, fetch customer, initialize transaction,
 *    verify transaction (a READ) and fetch subscription (a READ). Nothing else
 *    exists here — in particular there is NO plan creation, NO
 *    plan update, NO plan deletion, NO charge, NO refund, NO transfer and NO
 *    subscription-management WRITE (no create/enable/disable/update link).
 *    Provider behaviour that is not documented is never guessed: it is left
 *    unimplemented and fails closed.
 *  * performs exactly ONE attempt per call. The provider's idempotency
 *    semantics are not documented, so this client does not assume idempotency
 *    headers exist and does NOT retry: a retry is a business decision made
 *    above this layer against our own deterministic keys.
 *  * never types, logs or stores a credential, a card detail or an access code.
 *    Errors are bounded and redacted.
 *
 * Amounts crossing this boundary are ALREADY-AUTHORIZED integers in the payment
 * currency's minor units (GHS pesewas). The client performs no conversion, reads
 * no FX rate and never derives an amount.
 */

/** The only host this build may talk to (test and live keys share it). */
export const PAYSTACK_API_BASE_URL = 'https://api.paystack.co' as const;

/** The only key prefix this build accepts (sandbox/test mode). */
export const PAYSTACK_TEST_KEY_PREFIX = 'sk_test_' as const;

/** Pinned: this adapter is not a live-payment path. */
export const PAYSTACK_LIVE = false as const;

export type PaystackFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface PaystackClientConfig {
  /** Test-mode secret key (`sk_test_…`). Never logged, never persisted. */
  secretKey: string;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** Injected transport. Defaults to global fetch; tests inject a stub. */
  fetchFn?: PaystackFetchFn;
  /** Injected clock for local bookkeeping timestamps (defaults to real time). */
  clock?: () => Date;
}

/**
 * What a 404 is being classified ABOUT. A read whose subject is a customer must
 * never be answered "no subscription" by a 404, and vice versa: only a message
 * that names the subject of the read and states its absence is `not_found`.
 */
export type PaystackNotFoundSubject = 'customer' | 'subscription';

/**
 * Per subject, what a provider message must say for a 404 to be classified as
 * "this does not exist" rather than as an ambiguity. The customer patterns are
 * the original, conservative ones; the subscription pattern is the same rule
 * applied to the subscription read, with no overlap: `customer` cannot satisfy
 * the subscription test and `subscription` cannot satisfy the customer test.
 */
const PAYSTACK_NOT_FOUND_SUBJECTS: Readonly<
  Record<PaystackNotFoundSubject, { names: RegExp; absence: RegExp }>
> = Object.freeze({
  customer: { names: /customer/, absence: /not\s*found|does\s*not\s*exist|no\s*customer/ },
  subscription: { names: /subscription/, absence: /not\s*found|does\s*not\s*exist|no\s*subscription/ },
});

/* -------------------------------------------------------------------------- */
/* Documented envelopes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The documented response envelope: `{ status, message, data }`. Provider
 * payloads carry more fields than we read, so `passthrough()` is used — but
 * every field the adapter ACTS on is validated below.
 */
const envelopeSchema = z
  .object({
    status: z.boolean(),
    message: z.string().max(PAYSTACK_ERROR_MESSAGE_MAX).optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const customerDataSchema = z
  .object({
    id: z.union([z.number().int(), z.string().min(1).max(128)]).optional(),
    customer_code: z.string().min(1).max(128).optional(),
    email: z.string().max(254).optional(),
  })
  .passthrough();

const initializeDataSchema = z
  .object({
    authorization_url: z.string().min(1).max(2048),
    reference: z.string().min(1).max(190),
  })
  .passthrough();

/**
 * The documented transaction-verify payload (`GET /transaction/verify/:reference`),
 * restricted to the fields this build ACTS on. The provider publishes more
 * (card authorization, fees, logs, IP address, metadata): none of it is read,
 * typed, returned or retained here. In particular the `authorization` object is
 * never touched — it carries reusable-charge material.
 *
 * Deliberately absent: any subscription status or subscription code. The
 * provider's published verify response carries neither, so nothing here can
 * report one (see docs/paystack-provider-contract.md §2).
 *
 * Step 7 adds the documented `paid_at` field (an ISO datetime) and the
 * provider's own numeric `id` (the transaction identifier where available).
 * Both are validated strictly; a missing or malformed `paid_at` is a typed
 * refusal, and no card/authorization detail is ever read.
 */
const verifyTransactionDataSchema = z
  .object({
    id: z.union([z.number().int(), z.string().min(1).max(128)]).optional(),
    domain: z.string().min(1).max(16),
    status: z.string().min(1).max(64),
    reference: z.string().min(1).max(190),
    amount: z.number().int(),
    currency: z.string().min(1).max(8),
    paid_at: z.string().datetime(),
    customer: z
      .object({
        id: z.union([z.number().int(), z.string().min(1).max(128)]).optional(),
        customer_code: z.string().min(1).max(128).optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * The characters the provider documents for a transaction reference
 * ("Only `-`, `.`, `=` and alphanumeric characters allowed"). Anything else is
 * refused before a request is built, so a reference can never reshape the path.
 */
const PAYSTACK_REFERENCE_SHAPE = /^[A-Za-z0-9.=-]{1,190}$/;

/**
 * The characters a documented subscription id-or-code may be built from. The
 * provider documents this path parameter as "the subscription ID or code you
 * want to fetch" — a numeric id or a `SUB_…` code — and nothing else. Restricting
 * it to reference characters means a value can neither reshape the path (it is
 * encoded as well) nor smuggle a query string, and a value carrying credential
 * material cannot be turned into a request at all.
 */
const PAYSTACK_SUBSCRIPTION_IDENTIFIER_SHAPE = /^[A-Za-z0-9_.=-]{1,128}$/;

/**
 * The documented plan object on a fetched subscription, restricted to the
 * fields this build ACTS on. It is a separate schema because the provider is
 * documented as carrying the plan as an OBJECT on the fetch read while other
 * documented subscription shapes carry a bare plan identifier; only the object
 * form is read here, and the other form is ignored rather than guessed at.
 */
const subscriptionPlanSchema = z
  .object({
    plan_code: z.string().min(1).max(128).optional(),
    amount: z
      .number()
      .int()
      .nonnegative()
      .refine(Number.isSafeInteger, { message: 'a plan amount must be a safe integer' })
      .optional(),
    currency: z.string().min(1).max(8).optional(),
  })
  .passthrough();

/**
 * The documented subscription-fetch payload (`GET /subscription/:id_or_code`),
 * restricted to the fields this build ACTS on. The provider publishes far more
 * (invoices, cron schedule, integration id, quantity, timestamps): none of it
 * is read, typed, returned or retained here.
 *
 * DELIBERATELY NEVER READ (see `PaystackSubscriptionRecord` below):
 *  - `email_token` — the provider's CANCELLATION CREDENTIAL. It is not declared
 *    in this schema, so it cannot be read, typed, returned, logged or stored;
 *  - the `authorization` object — reusable-charge material (authorization code,
 *    BIN, last4, expiry, signature). It is not declared here either.
 *
 * Fields this build acts on and why:
 *  - `subscription_code` and `id` — the two documented ways a subscription is
 *    addressed; the caller must be echoed back by one of them;
 *  - `status` — the provider's own subscription status, passed through
 *    verbatim and interpreted only by the adapter's documented mapping;
 *  - `domain` — the sandbox guard (`test`);
 *  - `customer` / `plan` — the owning customer code and the plan the
 *    subscription was sold as;
 *  - `amount` (with the plan's own `amount` cross-check and `plan.currency`) —
 *    the payment amount, used exactly as reported and never converted.
 */
const subscriptionDataSchema = z
  .object({
    id: z.union([z.number().int(), z.string().min(1).max(128)]).optional(),
    domain: z.string().min(1).max(16),
    status: z.string().min(1).max(32),
    subscription_code: z.string().min(1).max(128),
    amount: z
      .number()
      .int()
      .nonnegative()
      .refine(Number.isSafeInteger, { message: 'a subscription amount must be a safe integer' })
      .optional(),
    customer: z
      .object({
        id: z.union([z.number().int(), z.string().min(1).max(128)]).optional(),
        customer_code: z.string().min(1).max(128).optional(),
      })
      .passthrough(),
    /** Read only in its documented OBJECT form; see `subscriptionPlanSchema`. */
    plan: z.unknown().nullish(),
  })
  .passthrough();

/**
 * The subscription-fetch payload read by the CANCELLATION path only.
 *
 * This is the ONE place in this package that reads the provider's cancellation
 * credential (`email_token`), and it is a separate schema on purpose: the
 * general subscription read (`subscriptionDataSchema`) must stay free of it, so
 * no other operation, record or contract can ever carry it. Here the value is
 * bound to a local variable, submitted to the one documented operation that
 * requires it, and dropped when the call returns.
 *
 * `authorization` and every card field are not declared here either.
 */
const subscriptionCancellationDataSchema = z
  .object({
    id: z.union([z.number().int(), z.string().min(1).max(128)]).optional(),
    domain: z.string().min(1).max(16),
    subscription_code: z.string().min(1).max(128),
    /**
     * The provider documents the cancellation credential as REQUIRED to
     * disable a subscription. It is optional in the SCHEMA so that its absence
     * is a distinct, clearly-reported refusal rather than a generic parse
     * failure — and it is never returned from any method in this class.
     */
    email_token: z.string().min(1).max(190).optional(),
  })
  .passthrough();

/**
 * A verified transaction, as the provider reported it — documented fields only.
 * `status` is the provider's own transaction status string, passed through
 * verbatim: the provider does not publish an exhaustive transaction status
 * vocabulary, so this client interprets none of it.
 *
 * `paidAt` is the documented instant the transaction was paid (provider's
 * `paid_at`). Required for payment evidence: a transaction without it is not
 * evidence, and reconciliation refuses it. `providerTransactionId` is the
 * provider's own numeric/string identifier where the payload carries one.
 */
export interface PaystackVerifiedTransaction {
  /** The transaction reference the provider verified (should be ours). */
  reference: string;
  /** Provider transaction status, uninterpreted (e.g. the documented `success`). */
  status: string;
  /** Provider environment of the transaction (`test` in sandbox). */
  domain: string;
  /** Amount in the currency's minor unit, exactly as reported (never converted). */
  amountMinor: number;
  /** Currency code exactly as reported. */
  currency: string;
  providerCustomerId: string | null;
  providerCustomerCode: string | null;
  /** Provider-reported paid instant (paid_at), ISO datetime string. Required for evidence. */
  paidAt: string;
  /** The provider's own transaction identifier (id), where available. */
  providerTransactionId: string | null;
}

export interface PaystackCustomerRecord {
  /** Provider customer identifier (`id`), when the envelope carries one. */
  providerCustomerId: string | null;
  /** Provider customer reference (`customer_code`), when the envelope carries one. */
  providerCustomerCode: string | null;
  /** Email the provider reports, when the envelope carries one. */
  email: string | null;
}

/**
 * A subscription, as the provider's documented fetch read reports it — documented
 * fields only.
 *
 * There is deliberately NO field for the provider's `email_token`: that value is
 * the credential the provider documents as REQUIRED to cancel a subscription, so
 * it is never read out of a response, never typed here, never returned to a
 * caller and therefore cannot be persisted or logged. Cancellation is a
 * separate, still unimplemented operation that must not be enabled by accident
 * through a field that happened to be on the way past.
 *
 * The `authorization` object is likewise never read: it carries reusable-charge
 * material.
 */
export interface PaystackSubscriptionRecord {
  /** Provider subscription id (`id`), when the payload carries one. */
  providerSubscriptionId: string | null;
  /** Provider subscription code (`subscription_code`). Required by the shape. */
  providerSubscriptionCode: string;
  /** Provider subscription status, uninterpreted (e.g. the documented `active`). */
  providerStatus: string;
  /** Provider environment of the subscription (`test` in sandbox). */
  domain: string;
  providerCustomerId: string | null;
  providerCustomerCode: string | null;
  /** Provider plan code (`plan.plan_code`), when the payload carries one. */
  providerPlanCode: string | null;
  /** The subscription amount, exactly as reported (never converted). */
  amountMinor: number | null;
  /** The plan's own amount, kept only to cross-check `amountMinor`. */
  planAmountMinor: number | null;
  /** Currency the plan reports, exactly as reported. */
  currency: string | null;
}

/**
 * A completed cancellation, as the provider acknowledged it.
 *
 * The documented disable response carries no data: there is no post-cancel
 * status, no instant and no reason to read, and the cancellation credential is
 * not part of this object — it existed only inside the call that used it.
 */
export interface PaystackSubscriptionDisableResult {
  /** The subscription the provider acknowledged disabling (the code submitted). */
  providerSubscriptionCode: string;
  /** The documented response envelope reported success. */
  acknowledged: true;
}

/** How one request encodes its body and what it may carry in an error. */
export interface PaystackRequestOptions {
  /**
   * The documented response carries no `data` object (the disable operation
   * answers with `status`/`message` only). Defaults to `true`, which is every
   * other operation's published shape.
   */
  requireData?: boolean;
  /**
   * Extra literals stripped VERBATIM from provider-authored text before it can
   * become an error message. Used for a transient credential, so a provider
   * that echoes it back cannot leak it through a refusal.
   */
  secrets?: readonly string[];
  /** The provider documents this operation as form-encoded. Defaults to `json`. */
  encoding?: 'json' | 'form';
}

export interface PaystackInitializedTransaction {
  authorizationUrl: string;
  /** The transaction reference the provider acknowledges (should be ours). */
  reference: string;
}

export class PaystackClient {
  private readonly secretKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: PaystackFetchFn;
  private readonly clock: () => Date;

  constructor(config: PaystackClientConfig) {
    const key = config.secretKey ?? '';
    if (key === '') {
      throw paystackConfigurationError(
        'Paystack is not configured: a sandbox test secret key is required.',
      );
    }
    if (!key.startsWith(PAYSTACK_TEST_KEY_PREFIX)) {
      throw paystackConfigurationError(
        `Only sandbox (test-mode) Paystack credentials are accepted by this build (a key starting ` +
          `"${PAYSTACK_TEST_KEY_PREFIX}"); live credentials are refused.`,
      );
    }
    if (/^sk_test_\s*$/.test(key)) {
      throw paystackConfigurationError('The configured Paystack test key is empty.');
    }
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw paystackConfigurationError('A positive Paystack request timeout (ms) is required.');
    }

    this.secretKey = key;
    this.timeoutMs = config.timeoutMs;
    this.fetchFn =
      config.fetchFn ??
      ((url, init) =>
        fetch(url, init as RequestInit) as Promise<{ status: number; json(): Promise<unknown> }>);
    this.clock = config.clock ?? (() => new Date());
  }

  /** Local bookkeeping timestamp (never a provider fact). */
  now(): Date {
    return this.clock();
  }

  /** Never returns the key. Operator-safe description for boot logs. */
  describe(): Record<string, unknown> {
    return {
      provider: 'paystack',
      baseUrl: PAYSTACK_API_BASE_URL,
      mode: 'test',
      live: PAYSTACK_LIVE,
      timeoutMs: this.timeoutMs,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Documented operations only                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * Create a customer (documented: `POST /customer`, email required).
   * Returns the provider's identifiers; the caller persists them locally.
   */
  async createCustomer(input: { email: string }): Promise<PaystackCustomerRecord> {
    const email = input.email.trim().toLowerCase();
    if (email === '' || !email.includes('@')) {
      throw paystackInvalidRequest('A customer email is required to create a provider customer.');
    }

    const data = await this.request('POST', '/customer', { email });
    const parsed = customerDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider response to customer creation did not carry the identifiers this build requires.',
      );
    }

    const record: PaystackCustomerRecord = {
      providerCustomerId:
        parsed.data.id === undefined ? null : String(parsed.data.id),
      providerCustomerCode: parsed.data.customer_code ?? null,
      email: parsed.data.email === undefined ? null : parsed.data.email.toLowerCase(),
    };

    if (record.providerCustomerId === null && record.providerCustomerCode === null) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider created a customer but returned neither a customer identifier nor a customer code.',
      );
    }
    if (record.email !== null && record.email !== email) {
      throw new PaystackAdapterError(
        'response_conflict',
        'The provider returned a customer whose email does not match the email this platform sent.',
      );
    }

    return record;
  }

  /**
   * Fetch a customer by email or code (documented: `GET /customer/:email_or_code`).
   *
   * A missing customer is `null` — but ONLY when the response unambiguously says
   * the customer does not exist. The provider documents two different 404
   * envelopes (`404 Unauthorized` and `404 Not Found`), so a 404 that does not
   * clearly identify a missing customer is an ERROR, never "no customer"
   * (fail closed: an authorization problem must never look like an empty
   * account).
   */
  async fetchCustomer(emailOrCode: string): Promise<PaystackCustomerRecord | null> {
    const identifier = emailOrCode.trim();
    if (identifier === '') {
      throw paystackInvalidRequest('A customer email or code is required to fetch a provider customer.');
    }

    let data: unknown;
    try {
      data = await this.request('GET', `/customer/${encodeURIComponent(identifier)}`);
    } catch (error) {
      if (error instanceof PaystackAdapterError && error.reason === 'not_found') {
        return null;
      }
      throw error;
    }

    const parsed = customerDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider customer response did not carry the identifiers this build requires.',
      );
    }

    const record: PaystackCustomerRecord = {
      providerCustomerId: parsed.data.id === undefined ? null : String(parsed.data.id),
      providerCustomerCode: parsed.data.customer_code ?? null,
      email: parsed.data.email === undefined ? null : parsed.data.email.toLowerCase(),
    };
    if (record.providerCustomerId === null && record.providerCustomerCode === null) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider returned a customer record with neither a customer identifier nor a customer code.',
      );
    }
    return record;
  }

  /**
   * Initialize a transaction (documented: `POST /transaction/initialize`).
   *
   * `amountMinor` is an ALREADY-AUTHORIZED integer in payment-currency minor
   * units and `currency` the payment currency; both are sent explicitly (the
   * provider would otherwise default to the integration's own currency, which
   * this build never relies on). `plan` is sent only when an authorized plan
   * identifier exists.
   */
  async initializeTransaction(input: {
    amountMinor: number;
    currency: string;
    email: string;
    reference: string;
    callbackUrl?: string | null;
    plan?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<PaystackInitializedTransaction> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw paystackInvalidRequest('An initialized transaction requires a positive integer amount.');
    }
    if (input.currency.trim() === '' || input.reference.trim() === '') {
      throw paystackInvalidRequest('A currency and a reference are required to initialize a transaction.');
    }

    const body: Record<string, unknown> = {
      amount: input.amountMinor,
      currency: input.currency,
      email: input.email.trim().toLowerCase(),
      reference: input.reference,
    };
    if (input.callbackUrl) body.callback_url = input.callbackUrl;
    if (input.plan) body.plan = input.plan;
    if (input.metadata) body.metadata = input.metadata;

    const data = await this.request('POST', '/transaction/initialize', body);
    const parsed = initializeDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider did not return a usable authorization URL for the initialized transaction.',
      );
    }
    return { authorizationUrl: parsed.data.authorization_url, reference: parsed.data.reference };
  }

  /**
   * Verify a transaction (documented: `GET /transaction/verify/:reference`).
   *
   * A pure READ: one attempt, no retry, nothing retained. Only the documented
   * fields listed on `verifyTransactionDataSchema` are read; a response missing
   * one of them (or carrying it with the wrong type) is a typed refusal, never
   * a default. A 404 is never "no transaction": the documented-ambiguous 404
   * classification applies, so an unknown reference is an error the caller
   * must resolve, not an empty result.
   */
  async verifyTransaction(reference: string): Promise<PaystackVerifiedTransaction> {
    const trimmed = reference.trim();
    if (!PAYSTACK_REFERENCE_SHAPE.test(trimmed)) {
      throw paystackInvalidRequest(
        'A transaction reference made only of the documented characters (alphanumeric, "-", "." and "=") is required to verify a transaction.',
      );
    }

    const data = await this.request('GET', `/transaction/verify/${encodeURIComponent(trimmed)}`);
    const parsed = verifyTransactionDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The provider transaction-verify response did not carry the documented fields this build requires (${[
          ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '<root>')),
        ].join(', ')}).`,
      );
    }

    const verified: PaystackVerifiedTransaction = {
      reference: parsed.data.reference,
      status: parsed.data.status,
      domain: parsed.data.domain,
      amountMinor: parsed.data.amount,
      currency: parsed.data.currency,
      providerCustomerId:
        parsed.data.customer.id === undefined ? null : String(parsed.data.customer.id),
      providerCustomerCode: parsed.data.customer.customer_code ?? null,
      paidAt: parsed.data.paid_at,
      providerTransactionId: parsed.data.id === undefined ? null : String(parsed.data.id),
    };
    return verified;
  }

  /**
   * Fetch a subscription by its id or code (documented:
   * `GET /subscription/:id_or_code`).
   *
   * A pure READ: one attempt, no retry, nothing retained, and no state changed
   * on the provider. Only the documented fields listed on
   * `subscriptionDataSchema` are read.
   *
   * The provider's CANCELLATION CREDENTIAL (`email_token`) is never read: it is
   * not part of the schema above, so it cannot be returned from here even by
   * accident, and no cancellation path exists in this build. The `authorization`
   * object is never read either.
   *
   * `null` means "the provider has no such subscription", and ONLY for a 404
   * that clearly says so: the documented-ambiguous 404 classification applies,
   * so an unclassified or authorization-shaped 404 is an ERROR the caller must
   * resolve — never an empty result that would read as "this user has no
   * subscription".
   */
  async fetchSubscription(idOrCode: string): Promise<PaystackSubscriptionRecord | null> {
    const identifier = idOrCode.trim();
    if (!PAYSTACK_SUBSCRIPTION_IDENTIFIER_SHAPE.test(identifier)) {
      throw paystackInvalidRequest(
        'A subscription id or code made only of reference characters (alphanumeric, "_", ".", "-" and "=") is ' +
          'required to fetch a subscription.',
      );
    }

    let data: unknown;
    try {
      data = await this.request('GET', `/subscription/${encodeURIComponent(identifier)}`, undefined, 'subscription');
    } catch (error) {
      if (error instanceof PaystackAdapterError && error.reason === 'not_found') {
        return null;
      }
      throw error;
    }

    const parsed = subscriptionDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The provider subscription response did not carry the documented fields this build requires (${[
          ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '<root>')),
        ].join(', ')}).`,
      );
    }

    // The plan is read only in its documented object form; a documented shape
    // that carries a bare plan identifier contributes nothing rather than being
    // interpreted.
    const planCandidate = parsed.data.plan;
    const plan =
      typeof planCandidate === 'object' && planCandidate !== null && !Array.isArray(planCandidate)
        ? subscriptionPlanSchema.safeParse(planCandidate)
        : null;

    const record: PaystackSubscriptionRecord = {
      providerSubscriptionId: parsed.data.id === undefined ? null : String(parsed.data.id),
      providerSubscriptionCode: parsed.data.subscription_code,
      providerStatus: parsed.data.status,
      domain: parsed.data.domain,
      providerCustomerId:
        parsed.data.customer.id === undefined ? null : String(parsed.data.customer.id),
      providerCustomerCode: parsed.data.customer.customer_code ?? null,
      providerPlanCode: plan?.success === true ? (plan.data.plan_code ?? null) : null,
      amountMinor: parsed.data.amount ?? null,
      planAmountMinor: plan?.success === true ? (plan.data.amount ?? null) : null,
      currency: plan?.success === true ? (plan.data.currency ?? null) : null,
    };
    return record;
  }

  /**
   * Disable a subscription (documented: `POST /subscription/disable`), which
   * takes the subscription code AND that subscription's cancellation
   * credential.
   *
   * THE CREDENTIAL NEVER LEAVES THIS METHOD. It is obtained from the
   * documented subscription read, held in a local variable, submitted in the
   * body of the one operation that requires it, and dropped when the call
   * returns. It is not returned to the caller, not part of any record or
   * contract in this package, not written to any log, and not carried into an
   * error message: `secrets` below strips it verbatim from provider-authored
   * text, so even a provider that echoes it back cannot leak it through a
   * refusal.
   *
   * Fails CLOSED, calling nothing further, when the operation's prerequisites
   * cannot be established: an identifier that is not reference-shaped, a 404
   * (there is no subscription to cancel), a response that does not echo the
   * subscription that was asked for, a non-sandbox domain, or a response that
   * carries no credential. In every one of those cases the disable is NEVER
   * attempted, so a provider subscription is never cancelled on a guess.
   *
   * Exactly two documented calls, no retry, nothing retained.
   */
  async disableSubscription(input: { idOrCode: string }): Promise<PaystackSubscriptionDisableResult> {
    const identifier = input.idOrCode.trim();
    if (!PAYSTACK_SUBSCRIPTION_IDENTIFIER_SHAPE.test(identifier)) {
      throw paystackInvalidRequest(
        'A subscription id or code made only of reference characters (alphanumeric, "_", ".", "-" and "=") is ' +
          'required to cancel a subscription.',
      );
    }

    // 1. The documented read. The credential exists only as a local below.
    let data: unknown;
    try {
      data = await this.request('GET', `/subscription/${encodeURIComponent(identifier)}`, undefined, 'subscription');
    } catch (error) {
      if (error instanceof PaystackAdapterError && error.reason === 'not_found') {
        throw new PaystackAdapterError(
          'not_found',
          'The provider has no subscription for the requested identifier, so no cancellation was attempted.',
        );
      }
      throw error;
    }

    const parsed = subscriptionCancellationDataSchema.safeParse(data);
    if (!parsed.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The provider subscription response did not carry the documented fields this operation requires (${[
          ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '<root>')),
        ].join(', ')}).`,
      );
    }

    // 2. The provider must echo the subscription that was asked for.
    const echoedId = parsed.data.id === undefined ? null : String(parsed.data.id);
    if (parsed.data.subscription_code !== identifier && echoedId !== identifier) {
      throw new PaystackAdapterError(
        'response_conflict',
        'The provider returned a different subscription than the one cancellation was requested for. ' +
          'Nothing was cancelled.',
      );
    }
    if (parsed.data.domain !== 'test') {
      throw new PaystackAdapterError(
        'response_conflict',
        'The provider reported a non-sandbox subscription domain; this build is sandbox-only, so the cancellation ' +
          'is refused.',
      );
    }

    // 3. The credential the documented operation requires. Missing, blank or
    //    unusable means the operation is not attempted at all.
    const token = parsed.data.email_token;
    if (token === undefined || token.trim() === '') {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider did not return the credential this operation requires, so no cancellation was attempted. ' +
          'Nothing was changed.',
      );
    }

    // 4. The documented disable: the code the provider itself reported, and
    //    the credential, submitted once, form-encoded as documented, with the
    //    credential registered as a redaction literal for this call only.
    await this.request(
      'POST',
      '/subscription/disable',
      { code: parsed.data.subscription_code, token },
      'subscription',
      { requireData: false, secrets: [token], encoding: 'form' },
    );

    return { providerSubscriptionCode: parsed.data.subscription_code, acknowledged: true };
  }

  /* ------------------------------------------------------------------------ */
  /* Transport                                                                */
  /* ------------------------------------------------------------------------ */

  private async request(
    method: string,
    path: string,
    body?: unknown,
    notFoundSubject: PaystackNotFoundSubject = 'customer',
    options: PaystackRequestOptions = {},
  ): Promise<unknown> {
    const url = `${PAYSTACK_API_BASE_URL}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const encoding = options.encoding ?? 'json';
    const contentType = encoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
    const encodeBody = (value: unknown): string =>
      encoding === 'form'
        ? new URLSearchParams(value as Record<string, string>).toString()
        : JSON.stringify(value);

    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': contentType,
          Accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: encodeBody(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new PaystackAdapterError(
        'provider_unavailable',
        `The payment provider could not be reached (${method} ${path}); no result is assumed.`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (response.status === 404) {
        // A 404 we cannot read is ambiguous: never "not found".
        throw new PaystackAdapterError(
          'ambiguous_not_found',
          `The provider answered 404 with an unreadable body; a missing ${notFoundSubject} is never assumed from an unreadable response.`,
          { cause: error },
        );
      }
      throw new PaystackAdapterError(
        'unexpected_response',
        `The provider answered ${response.status} with an unreadable body.`,
        { cause: error },
      );
    }

    const envelope = envelopeSchema.safeParse(json);
    const providerMessage =
      envelope.success && typeof envelope.data.message === 'string'
        ? redactPaystackMessage(envelope.data.message, this.secretKey, options.secrets)
        : '';

    if (response.status === 404) {
      throw this.classifyNotFound(providerMessage, notFoundSubject);
    }

    if (!envelope.success) {
      throw new PaystackAdapterError(
        'unexpected_response',
        `The provider answered ${response.status} with a body this build cannot read.`,
      );
    }

    if (response.status >= 500) {
      throw new PaystackAdapterError(
        'provider_unavailable',
        `The provider is unavailable (HTTP ${response.status}).`,
      );
    }

    if (response.status >= 400 || !envelope.data.status) {
      throw new PaystackAdapterError(
        'provider_rejected',
        providerMessage === ''
          ? `The provider rejected the request (HTTP ${response.status}).`
          : `The provider rejected the request (HTTP ${response.status}): ${providerMessage}`,
      );
    }

    if (options.requireData !== false && envelope.data.data === undefined) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider reported success without returning any data.',
      );
    }

    return options.requireData === false ? null : envelope.data.data;
  }

  /**
   * Classify a documented-ambiguous 404.
   *
   * Only a message that clearly identifies a MISSING CUSTOMER becomes
   * `not_found` (which `fetchCustomer` / `fetchSubscription` map to `null`).
   * An authorization-shaped 404 becomes `provider_rejected`; anything else —
   * including an empty or unclassifiable message — becomes
   * `ambiguous_not_found`, which callers must treat as an error.
   *
   * The subject matters: a message is only read as "this <subject> does not
   * exist" when it names THAT subject AND states its absence. A "Customer not
   * found" 404 on a subscription read (or the reverse) is unclassified, and the
   * provider's documented 404 envelopes are never collapsed into "the
   * subscription does not exist" — nor into "it does".
   */
  private classifyNotFound(message: string, subject: PaystackNotFoundSubject): PaystackAdapterError {
    const lower = message.toLowerCase();
    if (lower.includes('unauthoriz') || lower.includes('forbidden') || lower.includes('invalid key')) {
      return new PaystackAdapterError(
        'provider_rejected',
        `The provider refused the request (HTTP 404 with an authorization-shaped response): ${message}`,
      );
    }
    const { names, absence } = PAYSTACK_NOT_FOUND_SUBJECTS[subject];
    if (names.test(lower) && absence.test(lower)) {
      return new PaystackAdapterError(
        'not_found',
        `The provider has no ${subject} for the requested identifier: ${message}`,
      );
    }
    return new PaystackAdapterError(
      'ambiguous_not_found',
      message === ''
        ? `The provider answered 404 with no message; a missing ${subject} is never assumed from an unclassified 404.`
        : `The provider answered 404 with an unclassified message; a missing ${subject} is never assumed: ${message}`,
    );
  }
}
