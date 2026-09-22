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
 *    documentation: create customer, fetch customer, initialize transaction.
 *    Nothing else exists here — in particular there is NO plan creation, NO
 *    plan update, NO plan deletion, NO charge, NO refund, NO transfer and NO
 *    subscription-management call. Provider behaviour that is not documented is
 *    never guessed: it is left unimplemented and fails closed.
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

export interface PaystackCustomerRecord {
  /** Provider customer identifier (`id`), when the envelope carries one. */
  providerCustomerId: string | null;
  /** Provider customer reference (`customer_code`), when the envelope carries one. */
  providerCustomerCode: string | null;
  /** Email the provider reports, when the envelope carries one. */
  email: string | null;
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

  /* ------------------------------------------------------------------------ */
  /* Transport                                                                */
  /* ------------------------------------------------------------------------ */

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${PAYSTACK_API_BASE_URL}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
          'The provider answered 404 with an unreadable body; a missing customer is never assumed from an unreadable response.',
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
        ? redactPaystackMessage(envelope.data.message, this.secretKey)
        : '';

    if (response.status === 404) {
      throw this.classifyNotFound(providerMessage);
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

    if (envelope.data.data === undefined) {
      throw new PaystackAdapterError(
        'unexpected_response',
        'The provider reported success without returning any data.',
      );
    }

    return envelope.data.data;
  }

  /**
   * Classify a documented-ambiguous 404.
   *
   * Only a message that clearly identifies a MISSING CUSTOMER becomes
   * `not_found` (which `fetchCustomer` maps to `null`). An authorization-shaped
   * 404 becomes `provider_rejected`; anything else — including an empty or
   * unclassifiable message — becomes `ambiguous_not_found`, which callers must
   * treat as an error. The provider's two documented 404 envelopes are never
   * collapsed into "the customer does not exist".
   */
  private classifyNotFound(message: string): PaystackAdapterError {
    const lower = message.toLowerCase();
    if (lower.includes('unauthoriz') || lower.includes('forbidden') || lower.includes('invalid key')) {
      return new PaystackAdapterError(
        'provider_rejected',
        `The provider refused the request (HTTP 404 with an authorization-shaped response): ${message}`,
      );
    }
    if (/customer/.test(lower) && /not\s*found|does\s*not\s*exist|no\s*customer/.test(lower)) {
      return new PaystackAdapterError(
        'not_found',
        `The provider has no customer for the requested identifier: ${message}`,
      );
    }
    return new PaystackAdapterError(
      'ambiguous_not_found',
      message === ''
        ? 'The provider answered 404 with no message; a missing customer is never assumed from an unclassified 404.'
        : `The provider answered 404 with an unclassified message; a missing customer is never assumed: ${message}`,
    );
  }
}
