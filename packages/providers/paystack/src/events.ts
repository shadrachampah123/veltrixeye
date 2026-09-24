import { z } from 'zod';
import {
  BILLING_CREDENTIAL_SHAPED_RE,
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  billingEventDataSchema,
  billingEventSubjectSchema,
  billingPaymentAmountSchema,
  billingPaymentCurrencySchema,
  providerEventReferenceSchema,
  providerReferenceSchema,
  type BillingEventData,
  type BillingEventSubject,
  type BillingEventType,
  type BillingLifecycleState,
  type BillingPaymentAmount,
} from '@veltrixeye/contracts';
import {
  PAYSTACK_ERROR_MESSAGE_MAX,
  PaystackAdapterError,
  redactPaystackMessage,
} from './errors.js';

/**
 * The VERIFIED Paystack webhook event contract — payload shapes, canonical
 * mapping and normalization. Billing Step 5.1.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE IS SMALL
 * ---------------------------------------------------------------------------
 * Every provider event normalized here has a payload shape taken from
 * Paystack's own published documentation (see
 * docs/paystack-provider-contract.md §2.1 for the exact source of each field
 * set). An event whose payload shape could NOT be established from that
 * documentation is NOT supported: it normalizes to the canonical
 * `unrecognized` type, which asserts nothing, changes nothing and is stored
 * for review. Event NAMES alone are never treated as evidence of a payload
 * shape — a name says nothing about which fields a delivery carries.
 *
 * The four supported events are therefore the billing-cycle events whose
 * payloads are published:
 *
 *   charge.success          a transaction (including a subscription charge)
 *                           completed successfully
 *   subscription.create     a subscription was created
 *   invoice.update          the FINAL status of an invoice for a subscription
 *                           billing cycle (paid or not paid)
 *   invoice.payment_failed  the payment for an invoice failed
 *
 * Deliberately unsupported (each with a recorded reason in
 * `PAYSTACK_UNSUPPORTED_EVENT_REASONS`): `subscription.disable`,
 * `subscription.not_renew`, `subscription.expiring_cards`, `invoice.create`,
 * `subscription.enable`, and every non-billing event family (transfers,
 * refunds, disputes, payment requests, dedicated accounts, customer
 * identification). A cancellation therefore CANNOT be normalized by this
 * build: no supported event asserts one, and nothing here invents one.
 *
 * ---------------------------------------------------------------------------
 * WHAT NORMALIZATION NEVER DOES
 * ---------------------------------------------------------------------------
 *  - it never grants anything. The canonical event it produces is pinned
 *    `grantsExecution: false` by the contract, and this module produces no
 *    plan, no entitlement and no confirmation of payment: receiving an event
 *    is not verifying a transaction.
 *  - it never persists or forwards the delivery. Only canonical fields and a
 *    payload hash (computed by the caller) leave this module; the raw body is
 *    dropped.
 *  - it never reads a provider secret or card detail. Documented payloads
 *    carry `authorization` objects (authorization codes, BINs, last4, expiry,
 *    signatures) and a subscription `email_token` (the provider's
 *    cancellation credential). NONE of those fields is read, mapped, logged or
 *    echoed into an error message.
 *  - it never guesses. A field this contract does not understand is ignored;
 *    a field it requires and does not find (or finds with the wrong type) is
 *    a typed refusal, never a default.
 *  - it never coerces or computes. An amount is used exactly as delivered, as
 *    an integer in the payment currency's minor unit; a string amount, a
 *    float, a zero, a negative or an unsupported currency is refused. There is
 *    no arithmetic in this file.
 *  - it performs no I/O of any kind: no transport, no clock, no directory and
 *    no database. Normalization is a pure function of the delivery and the
 *    seam request that carried it.
 *
 * Provider-specific field names exist ONLY here (and in the fixtures under
 * `test/fixtures/webhook`). Nothing above the seam sees them: the canonical
 * output contracts are `.strict()`, so a provider-shaped field cannot cross.
 */

/* -------------------------------------------------------------------------- */
/* The verified vocabulary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The provider event names this build supports, i.e. the ones whose payload
 * shape is published by the provider AND which have a faithful canonical
 * mapping. Sorted; the normalizer dispatches on exact string equality, so a
 * delivery whose name differs in case, spacing or punctuation is unsupported
 * by construction (never "close enough").
 */
export const PAYSTACK_SUPPORTED_EVENTS = [
  'charge.success',
  'invoice.payment_failed',
  'invoice.update',
  'subscription.create',
] as const;
export type PaystackSupportedEvent = (typeof PAYSTACK_SUPPORTED_EVENTS)[number];

/**
 * The canonical event type(s) each supported provider event can produce.
 * `invoice.update` is the only data-dependent one: the provider documents it as
 * carrying the FINAL status of the invoice, so the canonical type follows the
 * invoice's own documented `paid` flag rather than the event name.
 */
export const PAYSTACK_CANONICAL_EVENT_TYPES: Readonly<
  Record<PaystackSupportedEvent, readonly BillingEventType[]>
> = Object.freeze({
  'charge.success': ['payment.succeeded'],
  'invoice.payment_failed': ['invoice.failed'],
  'invoice.update': ['invoice.processed', 'invoice.failed'],
  'subscription.create': ['subscription.created'],
});

/**
 * Provider events that are known to exist but are NOT supported, with the
 * reason. Each of these normalizes to `unrecognized` — recorded, asserted
 * nothing, applied to nothing — until the missing evidence exists.
 */
export const PAYSTACK_UNSUPPORTED_EVENT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'subscription.disable':
    'the provider publishes the event name but no payload shape this repository could verify, and a cancellation is never guessed',
  'subscription.not_renew':
    'the provider publishes the event name but no payload shape this repository could verify',
  'subscription.expiring_cards':
    'the published payload carries an ARRAY of subscriptions in "data", not one subject, and the canonical contract models one subject per event',
  'subscription.enable':
    'documented only in the provider\'s superseded event list, absent from the current one, and no payload shape is published',
  'invoice.create':
    'the published payload is verified, but the event announces a FUTURE charge attempt (sent days before the payment date); the canonical vocabulary has no "invoice created" type, and neither invoice.processed nor invoice.failed may be asserted from it',
  'charge.failed':
    'not present in the provider\'s published event vocabulary at all, so no payload shape exists to verify',
});

/** True when a delivery's event name is one this build really understands. */
export function isPaystackSupportedEvent(event: string): event is PaystackSupportedEvent {
  return (PAYSTACK_SUPPORTED_EVENTS as readonly string[]).includes(event);
}

/* -------------------------------------------------------------------------- */
/* Provider status → canonical lifecycle state                                */
/* -------------------------------------------------------------------------- */

/**
 * The provider's documented subscription status vocabulary, mapped onto the
 * canonical lifecycle states. The five documented statuses are `active`,
 * `non-renewing`, `attention`, `completed` and `cancelled`.
 *
 * `attention` is deliberately NOT mapped. The provider's own documentation
 * contradicts itself about it: the subscription guide says an `attention`
 * subscription "is still active" and that the card "will be attempted again on
 * the next payment date", while the same guide states that subscriptions are
 * not retried. An ambiguous state is normalized to `unknown`, which the
 * canonical contract defines as never changing authoritative state and always
 * requiring review — the fail-safe direction. Any status outside the documented
 * vocabulary also becomes `unknown`, never a guess.
 */
export const PAYSTACK_LIFECYCLE_STATE_FOR_STATUS: Readonly<Record<string, BillingLifecycleState>> =
  Object.freeze({
    active: 'active',
    cancelled: 'cancelled',
    completed: 'expired',
    'non-renewing': 'unsubscribed',
  });

/** Canonical lifecycle state for a provider-reported subscription status. */
export function paystackLifecycleState(status: string): BillingLifecycleState {
  return PAYSTACK_LIFECYCLE_STATE_FOR_STATUS[status] ?? 'unknown';
}

/* -------------------------------------------------------------------------- */
/* Failure detail: bounded, redacted, never credential-shaped                 */
/* -------------------------------------------------------------------------- */

/**
 * The fixed, credential-free text used when a provider-reported failure detail
 * cannot be made safe to persist. It contains none of the words the canonical
 * contract (and migration 0031's CHECK) reject, so it is always storable, and
 * it tells an operator that a detail existed and was withheld rather than
 * silently claiming there was none.
 */
export const PAYSTACK_WITHHELD_FAILURE_DETAIL = 'provider failure detail withheld';

/**
 * Sanitize provider-authored failure text (`invoice.description`, the field the
 * provider documents as carrying "more information about what went wrong when
 * attempting to charge the card"):
 *
 *  1. whitespace is collapsed and the text trimmed, so no control character or
 *     newline reaches a durable column;
 *  2. the package's redaction pass removes key-shaped strings, bearer values
 *     and `field: value` credential assignments;
 *  3. the result is hard-bounded to the durable failure-reason bound;
 *  4. if the result is STILL credential-shaped — the redaction pass preserves
 *     ordinary prose such as "invalid authorization", which the canonical
 *     contract refuses — the text is replaced by
 *     `PAYSTACK_WITHHELD_FAILURE_DETAIL`.
 *
 * A credential-shaped failure reason is therefore never produced, and an
 * unsafe detail is never half-persisted.
 */
export function sanitizePaystackFailureDetail(detail: string): string {
  const collapsed = detail.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return PAYSTACK_WITHHELD_FAILURE_DETAIL;
  const redacted = redactPaystackMessage(collapsed);
  const bounded =
    redacted.length > PAYSTACK_ERROR_MESSAGE_MAX ? redacted.slice(0, PAYSTACK_ERROR_MESSAGE_MAX) : redacted;
  // The canonical contract (and migration 0031's CHECK) refuse credential-shaped
  // failure text outright, so a detail that cannot be made safe is withheld
  // whole rather than persisted in part.
  return BILLING_CREDENTIAL_SHAPED_RE.test(bounded) ? PAYSTACK_WITHHELD_FAILURE_DETAIL : bounded;
}

/* -------------------------------------------------------------------------- */
/* Documented payload shapes                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Provider payloads carry more fields than this contract reads, so every
 * payload object below is `passthrough()` — the same posture as the REST client
 * (`client.ts`): unknown fields are ignored, never persisted and never
 * forwarded, while every field this contract ACTS ON is validated. Ignoring an
 * unknown field is safe because the canonical output contracts are `.strict()`;
 * a required field that is missing, mis-typed or contradictory is a refusal.
 */
const isoDateTime = z.string().datetime();

/** Fields shared by every documented invoice-shaped payload. */
const invoiceDataSchema = z
  .object({
    domain: z.string().min(1).max(16),
    invoice_code: z.string().min(1).max(128),
    /**
     * The documented invoice amount is an integer in minor units. Its SHAPE is
     * validated (a float, a string or a negative amount means the delivery is
     * not the documented payload), but it is never MAPPED: an invoice payload
     * documents no currency of its own — the only currency on it sits inside
     * the `transaction` object, which the provider documents as sometimes
     * EMPTY — and an amount without a known minor unit is never reported.
     */
    amount: z
      .number()
      .int()
      .nonnegative()
      .refine(Number.isSafeInteger, { message: 'an invoice amount must be a safe integer' }),
    period_start: isoDateTime.nullish(),
    period_end: isoDateTime.nullish(),
    status: z.string().min(1).max(32),
    paid: z.boolean(),
    paid_at: isoDateTime.nullish(),
    description: z.string().nullish(),
    subscription: z
      .object({
        status: z.string().min(1).max(32),
        subscription_code: z.string().min(1).max(128),
      })
      .passthrough(),
    customer: z
      .object({
        customer_code: z.string().min(1).max(128),
      })
      .passthrough(),
    transaction: z
      .object({
        reference: z.string().min(1).max(190).optional(),
      })
      .passthrough()
      .nullish(),
    created_at: isoDateTime,
  })
  .passthrough();

const chargeSuccessDataSchema = z
  .object({
    domain: z.string().min(1).max(16),
    status: z.string().min(1).max(32),
    reference: z.string().min(1).max(190),
    amount: z.number(),
    currency: z.string().min(1).max(8),
    paid_at: isoDateTime,
    customer: z
      .object({
        customer_code: z.string().min(1).max(128),
      })
      .passthrough(),
  })
  .passthrough();

const subscriptionCreateDataSchema = z
  .object({
    domain: z.string().min(1).max(16),
    status: z.string().min(1).max(32),
    subscription_code: z.string().min(1).max(128),
    amount: z.number(),
    /**
     * The documented payload carries BOTH `createdAt` and `created_at`, with
     * different values. `created_at` is the field every documented event
     * payload carries, so it is the one used; the camelCase twin is ignored
     * rather than reconciled by guesswork.
     */
    created_at: isoDateTime,
    /**
     * A subscription amount has no currency of its own in the documented
     * payload: the currency is documented on the plan. It is read there and
     * cross-checked against the subscription amount, so no currency is ever
     * assumed.
     */
    plan: z
      .object({
        plan_code: z.string().min(1).max(128),
        amount: z.number(),
        currency: z.string().min(1).max(8),
        interval: z.string().min(1).max(32),
      })
      .passthrough(),
    customer: z
      .object({
        customer_code: z.string().min(1).max(128),
      })
      .passthrough(),
  })
  .passthrough();

/** The documented delivery envelope: an event name and its data. */
const envelopeSchema = z
  .object({
    event: z.string().min(1).max(190),
    data: z.unknown().optional(),
  })
  .passthrough();

/* -------------------------------------------------------------------------- */
/* Normalized facts                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The canonical facts one delivery carries, as established by this contract.
 * `subject` and `data` are `null` for an unsupported/unknown event: nothing is
 * asserted about a payload this build does not understand.
 */
export interface PaystackEventFacts {
  eventType: BillingEventType;
  /** Documented instant the event occurred, or `null` when none is published. */
  occurredAt: string | null;
  subject: BillingEventSubject | null;
  data: BillingEventData | null;
}

/** Canonical event data with every field this contract does not assert. */
function eventData(asserted: Partial<BillingEventData>): BillingEventData {
  const data: BillingEventData = {
    // Catalogue identity is NEVER derived from a provider payload: the
    // provider's plan code and interval string are not an authorization, and
    // the only authority that maps a provider plan onto a catalogue plan is the
    // locally registered plan epoch, which the synchronization step owns.
    cataloguePlan: null,
    interval: null,
    state: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    // Nothing in the supported vocabulary documents a cancellation.
    cancelAtPeriodEnd: null,
    cancellationReason: null,
    // The COMMERCIAL (USD) amount is never reported by a provider event; the
    // catalogue stays the only price authority.
    amountMinor: null,
    currency: null,
    payment: null,
    failureReason: null,
    ...asserted,
  };
  const parsed = billingEventDataSchema.safeParse(data);
  if (!parsed.success) throw contractViolation('event data', parsed.error);
  return parsed.data;
}

/**
 * Canonical event subject. Local subject fields are ALWAYS null here, by
 * construction: resolving a provider identifier to a local user, subscription
 * or billing customer is a directory lookup keyed by provider identifiers,
 * which this build does not have (the injected customer directory is keyed by
 * local user id). The receiver that lands with the webhook step must resolve
 * them before anything is persisted — the durable ledger binds an event to its
 * owner with a composite key that is either fully resolved or fully null.
 */
function eventSubject(asserted: Partial<BillingEventSubject>): BillingEventSubject {
  const subject: BillingEventSubject = {
    userId: asserted.userId ?? null,
    subscriptionId: asserted.subscriptionId ?? null,
    billingCustomerId: asserted.billingCustomerId ?? null,
    providerCustomerId: asserted.providerCustomerId ?? null,
    providerSubscriptionId: asserted.providerSubscriptionId ?? null,
    providerReference: asserted.providerReference ?? null,
  };
  const parsed = billingEventSubjectSchema.safeParse(subject);
  if (!parsed.success) throw contractViolation('event subject', parsed.error);
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Typed refusals (no payload value is ever echoed into a message)            */
/* -------------------------------------------------------------------------- */

function issuesAt(error: z.ZodError): string {
  const paths = [...new Set(error.issues.map((issue) => issue.path.join('.') || '<root>'))];
  return paths.length === 0 ? '<root>' : paths.map((path) => `data.${path}`).join(', ');
}

/** A delivery that does not carry what the documented shape requires. */
function malformed(event: string, at: string): PaystackAdapterError {
  return new PaystackAdapterError(
    'unexpected_response',
    `The "${event}" delivery could not be normalized: the payload is missing or malformed at ${at}. ` +
      'Nothing was recorded as a supported event and no provider detail was forwarded.',
  );
}

function malformedFromZod(event: string, error: z.ZodError): PaystackAdapterError {
  return malformed(event, issuesAt(error));
}

/** A delivery that contradicts itself, or this build's sandbox-only posture. */
function contradiction(event: string, reason: string): PaystackAdapterError {
  return new PaystackAdapterError(
    'unexpected_response',
    `The "${event}" delivery could not be normalized: ${reason}. Nothing was recorded as a supported event.`,
  );
}

function contractViolation(what: string, error: z.ZodError): PaystackAdapterError {
  const paths = [...new Set(error.issues.map((issue) => issue.path.join('.') || '<root>'))].join(', ');
  return new PaystackAdapterError(
    'unexpected_response',
    `The normalized ${what} could not be validated against the canonical contract at: ${paths}. ` +
      'No provider detail crosses the seam.',
  );
}

/**
 * This build is sandbox-only (`PAYSTACK_LIVE` is pinned false and only
 * `sk_test_` credentials are accepted), so a delivery that reports any other
 * domain is a configuration contradiction, not an event: it is refused with a
 * configuration reason and never normalized.
 */
function assertSandboxDomain(event: string, domain: string): void {
  if (domain !== 'test') {
    throw new PaystackAdapterError(
      'invalid_configuration',
      `The "${event}" delivery does not report the sandbox domain. This build is sandbox-only and normalizes ` +
        'sandbox deliveries; a delivery from another domain means the webhook is not configured for this build. ' +
        'Nothing was normalized.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Field-level canonical validation                                           */
/* -------------------------------------------------------------------------- */

/** A provider identifier (`CUS_…`, `SUB_…`), validated canonically. */
function providerReference(value: string, event: string, at: string): string {
  const parsed = providerReferenceSchema.safeParse(value);
  if (!parsed.success) throw malformed(event, at);
  return parsed.data;
}

/** A provider/transaction reference carried by an event (wider bound). */
function eventReference(value: string, event: string, at: string): string {
  const parsed = providerEventReferenceSchema.safeParse(value);
  if (!parsed.success) throw malformed(event, at);
  return parsed.data;
}

/**
 * The amount a delivery reports, as an integer in the payment currency's minor
 * unit. The currency must be one this build understands (GHS) and the exponent
 * comes from the canonical currency table — never from arithmetic here. A
 * string amount, a float, a zero, a negative amount or an unsupported currency
 * is refused: no coercion, no conversion, no default.
 */
function paymentAmount(
  amount: number,
  currency: string,
  event: string,
  at: string,
): BillingPaymentAmount {
  const parsedCurrency = billingPaymentCurrencySchema.safeParse(currency);
  if (!parsedCurrency.success) {
    throw contradiction(
      event,
      `the payment currency reported at data.${at} is not one this sandbox build understands, and an amount ` +
        'without a known minor unit is never recorded',
    );
  }
  const parsedAmount = billingPaymentAmountSchema.safeParse({
    paymentCurrency: parsedCurrency.data,
    paymentAmountMinor: amount,
    paymentAmountExponent: BILLING_PAYMENT_AMOUNT_EXPONENT[parsedCurrency.data],
  });
  if (!parsedAmount.success) throw malformed(event, `data.${at}`);
  return parsedAmount.data;
}

/* -------------------------------------------------------------------------- */
/* Per-event normalizers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `charge.success` → `payment.succeeded`.
 *
 * Documented as "a successful charge was made"; the payload is the transaction
 * object. This is a RECEIPT of a provider-reported success — it is not a
 * verification. Confirming a payment still requires the documented transaction
 * verification read, which this build does not implement.
 */
function normalizeChargeSuccess(data: unknown): PaystackEventFacts {
  const event = 'charge.success';
  const parsed = chargeSuccessDataSchema.safeParse(data);
  if (!parsed.success) throw malformedFromZod(event, parsed.error);
  const payload = parsed.data;

  assertSandboxDomain(event, payload.domain);
  if (payload.status !== 'success') {
    // The canonical type is payment.succeeded; a delivery whose own transaction
    // status contradicts that is refused rather than recorded as a success.
    throw contradiction(
      event,
      'the transaction status it reports is not a success, so it cannot be normalized as payment.succeeded',
    );
  }

  return {
    eventType: 'payment.succeeded',
    // `paid_at` is the documented instant the charge succeeded and is required:
    // a successful charge without one is not normalized.
    occurredAt: payload.paid_at,
    subject: eventSubject({
      providerCustomerId: providerReference(payload.customer.customer_code, event, 'customer.customer_code'),
      // A charge payload documents no subscription identifier, so none is
      // asserted (the plan object it may carry is not a subscription).
      providerSubscriptionId: null,
      providerReference: eventReference(payload.reference, event, 'reference'),
    }),
    data: eventData({
      // No subscription state is documented on a transaction payload.
      state: null,
      payment: paymentAmount(payload.amount, payload.currency, event, 'amount'),
    }),
  };
}

/**
 * `subscription.create` → `subscription.created`.
 *
 * Documented as "a subscription has been created"; the payload is the
 * subscription object with its plan, authorization and customer.
 */
function normalizeSubscriptionCreate(data: unknown): PaystackEventFacts {
  const event = 'subscription.create';
  const parsed = subscriptionCreateDataSchema.safeParse(data);
  if (!parsed.success) throw malformedFromZod(event, parsed.error);
  const payload = parsed.data;

  assertSandboxDomain(event, payload.domain);
  if (payload.plan.amount !== payload.amount) {
    // The subscription amount and its plan amount are the same documented fact;
    // a delivery that disagrees with itself is refused, never averaged.
    throw contradiction(
      event,
      'the subscription amount and the plan amount it reports disagree, so the reported amount is not usable',
    );
  }

  return {
    eventType: 'subscription.created',
    occurredAt: payload.created_at,
    subject: eventSubject({
      providerCustomerId: providerReference(payload.customer.customer_code, event, 'customer.customer_code'),
      providerSubscriptionId: providerReference(payload.subscription_code, event, 'subscription_code'),
      // No transaction reference is documented on this payload.
      providerReference: null,
    }),
    data: eventData({
      state: paystackLifecycleState(payload.status),
      payment: paymentAmount(payload.amount, payload.plan.currency, event, 'amount'),
      // `next_payment_date` is the documented date of the NEXT charge, not a
      // period boundary, so no period is asserted from it.
    }),
  };
}

/** Shared normalization for the two documented invoice-shaped payloads. */
function invoiceFacts(
  event: 'invoice.update' | 'invoice.payment_failed',
  data: unknown,
  eventTypeFor: (paid: boolean) => BillingEventType,
): PaystackEventFacts {
  const parsed = invoiceDataSchema.safeParse(data);
  if (!parsed.success) throw malformedFromZod(event, parsed.error);
  const payload = parsed.data;

  assertSandboxDomain(event, payload.domain);
  const eventType = eventTypeFor(payload.paid);
  const failureDetail =
    eventType === 'invoice.failed' && payload.description !== undefined && payload.description !== null
      ? sanitizePaystackFailureDetail(payload.description)
      : null;
  const transactionReference = payload.transaction?.reference;

  return {
    eventType,
    // The invoice's paid instant when the delivery carries one, otherwise the
    // invoice's own creation instant: the only two timestamps an invoice
    // payload documents. (`paid_at` is null for an unpaid invoice.)
    occurredAt: payload.paid_at ?? payload.created_at,
    subject: eventSubject({
      providerCustomerId: providerReference(payload.customer.customer_code, event, 'customer.customer_code'),
      providerSubscriptionId: providerReference(
        payload.subscription.subscription_code,
        event,
        'subscription.subscription_code',
      ),
      providerReference:
        transactionReference === undefined
          ? null
          : eventReference(transactionReference, event, 'transaction.reference'),
    }),
    data: eventData({
      state: paystackLifecycleState(payload.subscription.status),
      // The invoice period IS the billing period the invoice covers, so it is
      // mapped as reported. The provider's own documented example carries a
      // period_start AFTER its period_end, so no ordering is inferred here and
      // none is enforced: the canonical event data records what was reported.
      currentPeriodStart: payload.period_start ?? null,
      currentPeriodEnd: payload.period_end ?? null,
      failureReason: failureDetail,
    }),
  };
}

/**
 * `invoice.update` → `invoice.processed` when the invoice is documented as
 * paid, `invoice.failed` when it is not. The provider documents this event as
 * carrying "the final status of the invoice for this subscription payment" and
 * instructs the integrator to inspect the invoice object, so the canonical type
 * follows the invoice's own `paid` flag rather than the event name.
 *
 * NOTE: this is an invoice outcome, NOT a payment confirmation. A paid invoice
 * is a provider-reported receipt; confirming the underlying transaction is a
 * separate, documented read this build does not perform.
 */
function normalizeInvoiceUpdate(data: unknown): PaystackEventFacts {
  return invoiceFacts('invoice.update', data, (paid) => (paid ? 'invoice.processed' : 'invoice.failed'));
}

/** `invoice.payment_failed` → `invoice.failed`. */
function normalizeInvoicePaymentFailed(data: unknown): PaystackEventFacts {
  return invoiceFacts('invoice.payment_failed', data, () => 'invoice.failed');
}

const NORMALIZERS: Readonly<Record<PaystackSupportedEvent, (data: unknown) => PaystackEventFacts>> =
  Object.freeze({
    'charge.success': normalizeChargeSuccess,
    'invoice.payment_failed': normalizeInvoicePaymentFailed,
    'invoice.update': normalizeInvoiceUpdate,
    'subscription.create': normalizeSubscriptionCreate,
  });

/* -------------------------------------------------------------------------- */
/* The normalizer                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Normalize one delivered payload into canonical facts.
 *
 * Two different outcomes for two different problems, deliberately:
 *
 *  - an event name this build does NOT support (unverified, out of scope, or
 *    invented) is NOT an error: it returns the canonical `unrecognized` event
 *    with no subject and no data, so the delivery is recorded, asserts nothing
 *    and is never mistaken for a supported event;
 *  - a SUPPORTED event name whose payload is missing a required field, carries
 *    a wrong type, or contradicts itself (or this build's sandbox posture) IS
 *    an error: it throws a typed `PaystackAdapterError`, so the caller can
 *    record a FAILED event with a reason instead of silently degrading a
 *    payment or subscription fact into "unrecognized".
 *
 * The payload itself is never returned, stored or logged by this function.
 */
export function normalizePaystackEventPayload(payload: unknown): PaystackEventFacts {
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new PaystackAdapterError(
      'unexpected_response',
      'The delivery is not a readable provider event envelope: it must be a JSON object carrying a non-empty ' +
        'string event name. Nothing was normalized.',
    );
  }

  const name = envelope.data.event;
  if (!isPaystackSupportedEvent(name)) {
    // Unknown, unverified or out-of-scope: recorded as unrecognized, never
    // coerced into a supported canonical type.
    return { eventType: 'unrecognized', occurredAt: null, subject: null, data: null };
  }

  if (envelope.data.data === undefined) {
    throw malformed(name, 'data');
  }
  return NORMALIZERS[name](envelope.data.data);
}
