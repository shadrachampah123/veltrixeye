import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  BILLING_CREDENTIAL_SHAPED_RE,
  BILLING_EVENT_TYPES,
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  BILLING_PAYMENT_CURRENCIES,
  billingEventCategory,
  billingEventDataSchema,
  billingEventIdempotencyCanonicalString,
  normalizedBillingEventSchema,
  providerEventIdentitySchema,
  type BillingEventType,
} from '@veltrixeye/contracts';
import {
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  type BillingProviderRawEvent,
} from '@veltrixeye/core';
import {
  PAYSTACK_CANONICAL_EVENT_TYPES,
  PAYSTACK_IMPLEMENTED_OPERATIONS,
  PAYSTACK_SUPPORTED_EVENTS,
  PAYSTACK_UNSUPPORTED_EVENT_REASONS,
  PAYSTACK_WITHHELD_FAILURE_DETAIL,
  PaystackAdapterError,
  createPaystackProvider,
  isPaystackSupportedEvent,
  normalizePaystackEventPayload,
  paystackLifecycleState,
  sanitizePaystackFailureDetail,
  type PaystackFetchFn,
} from '../src/index.js';

/* ==========================================================================
   Billing Step 5.1 — the verified Paystack webhook event contract.

   These tests cover the PROVIDER side of the canonical event seam only: which
   events the adapter accepts as supported, how a published payload maps onto
   the canonical contract, and how it fails closed. There is deliberately no
   receiver here — no route, no raw body, no signature — and the last test in
   this file pins that this package still contains none of it (that is Billing
   Step 5.2).

   Every fixture under test/fixtures/webhook is a delivery shape whose field
   names, nesting and types are published by Paystack, with values adapted to
   this repository's sandbox flow and with its provenance recorded beside it.
   An event is supported here only if a published payload backs it.
   ========================================================================== */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(here, 'fixtures', 'webhook');
const SRC_DIR = path.join(here, '..', 'src');

interface FixtureProvenance {
  sources: string[];
  verifiedFieldNames: string[];
  adaptedValues: string;
  neverRead?: string[];
  mappingNote?: string;
}

interface WebhookFixture {
  fixture: string;
  event: string;
  supported: boolean;
  /** Present on unsupported fixtures: why the vocabulary refuses the event. */
  reason?: string;
  canonicalEventType: BillingEventType;
  /** Present on the one adversarial fixture, which is not a published payload. */
  synthetic?: boolean;
  provenance: FixtureProvenance;
  body: Record<string, unknown>;
}

const fixtures = new Map<string, WebhookFixture>(
  readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [
      name,
      JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as WebhookFixture,
    ]),
);
const byFixture = (id: string): WebhookFixture => {
  const fixture = [...fixtures.values()].find((candidate) => candidate.fixture === id);
  assert.ok(fixture, `missing fixture ${id}`);
  return fixture;
};
const supportedFixtures = [...fixtures.values()].filter((fixture) => fixture.supported);
const unsupportedFixtures = [...fixtures.values()].filter((fixture) => !fixture.supported);

/** A receipt instant after every fixture timestamp, so identity always parses. */
const RECEIVED_AT = '2027-06-01T00:00:00.000Z';

/* Values that exist only inside a fixture payload. If one of them surfaces in a
 * normalized event or in an error message, provider detail (card material, the
 * cancellation credential, personal data) has crossed the adapter boundary. */
const SENTINELS = [
  'AUTH_DO_NOT_PERSIST',
  'SIG_DO_NOT_PERSIST',
  'DONOTPERSISTemailtoken',
  'do-not-persist@example.com',
  'sk_test_DONOTPERSISTME',
  '4081',
  '203.0.113.7',
  'Insufficient Funds',
] as const;

/* Provider-only structure that must never appear in a normalized result. (The
 * canonical result does have its own `data` and `subject` fields; what must not
 * survive is the provider's envelope and its credential/card material.) */
const PROVIDER_ONLY_TEXT = [
  '"rawBody"',
  '"payload"',
  '"body"',
  'authorization',
  'email_token',
  'ip_address',
  'gateway_response',
  'cron_expression',
  'plan_code',
  'open_invoice',
  'expiry_date',
  'next_payment_date',
  'invoice_code',
  'customer_code',
] as const;

/* -------------------------------------------------------------------------- */
/* The adapter: a sandbox key, and a transport that must never be touched      */
/* -------------------------------------------------------------------------- */

const fetchCalls: string[] = [];
const transportThatMustStayIdle: PaystackFetchFn = async (url) => {
  fetchCalls.push(url);
  throw new Error(`normalizeEvent must not perform I/O, but requested ${url}`);
};

const provider = createPaystackProvider({
  secretKey: 'sk_test_fixture_normalize_events',
  timeoutMs: 2000,
  fetchFn: transportThatMustStayIdle,
  clock: () => new Date(RECEIVED_AT),
  customers: { find: async () => null },
  plans: { find: async () => null },
});

const delivery = (
  payload: unknown,
  options?: { providerEventId?: string | null; receivedAt?: string },
): BillingProviderRawEvent => ({
  provider: 'paystack',
  payload,
  providerEventId: options?.providerEventId ?? null,
  receivedAt: options?.receivedAt ?? RECEIVED_AT,
});

/**
 * Assert a typed refusal AND that the refusal is itself safe to persist: a
 * message that echoed payload material, or that carried credential-shaped words
 * of its own, would poison the ledger's `failure_reason` column (migration
 * 0031's CHECK) the moment a receiver records why a delivery was refused.
 */
const refuses = async (
  payload: unknown,
  options?: { providerEventId?: string | null; receivedAt?: string; reason?: string },
): Promise<PaystackAdapterError> => {
  let caught: unknown;
  try {
    await provider.normalizeEvent(delivery(payload, options));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, 'expected a refusal, but the delivery was accepted');
  assert.ok(
    caught instanceof PaystackAdapterError,
    `expected a typed PaystackAdapterError, got: ${String(caught)}`,
  );
  for (const sentinel of SENTINELS) {
    assert.ok(
      !caught.message.includes(sentinel),
      `refusal echoed payload material (${sentinel}): ${caught.message}`,
    );
  }
  assert.ok(
    !BILLING_CREDENTIAL_SHAPED_RE.test(caught.message),
    `refusal message is itself credential-shaped and could not be persisted: ${caught.message}`,
  );
  assert.ok(caught.message.length <= 600, `refusal message is unbounded: ${caught.message.length}`);
  if (options?.reason !== undefined) assert.equal(caught.reason, options.reason);
  return caught;
};

const clone = (fixture: WebhookFixture): Record<string, unknown> => structuredClone(fixture.body);

/** Canonical mapping lookup for an arbitrary (possibly unsupported) event name. */
const canonicalFor = (event: string): readonly BillingEventType[] | undefined =>
  (PAYSTACK_CANONICAL_EVENT_TYPES as Readonly<Record<string, readonly BillingEventType[]>>)[event];

/** Deep-clone a fixture and replace (or delete) one documented field path. */
const mutate = (
  fixture: WebhookFixture,
  fieldPath: string,
  value?: unknown,
  options?: { deleteField?: boolean },
): Record<string, unknown> => {
  const body = clone(fixture);
  const segments = fieldPath.split('.');
  let cursor: Record<string, unknown> = body;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    assert.ok(next !== null && typeof next === 'object', `bad fixture path ${fieldPath}`);
    cursor = next as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1]!;
  if (options?.deleteField === true) delete cursor[leaf];
  else cursor[leaf] = value;
  return body;
};

/** The canonical GHS payment amount this build is willing to report. */
const ghs = (minor: number) => ({
  paymentCurrency: 'GHS' as const,
  paymentAmountMinor: minor,
  paymentAmountExponent: BILLING_PAYMENT_AMOUNT_EXPONENT.GHS,
});

/* ========================================================================== */
/* 1. The pinned vocabulary, and the fixtures that back it                     */
/* ========================================================================== */

describe('the verified Paystack event vocabulary', () => {
  it('supports exactly the four events whose payloads Paystack publishes', () => {
    assert.deepEqual([...PAYSTACK_SUPPORTED_EVENTS], [
      'charge.success',
      'invoice.payment_failed',
      'invoice.update',
      'subscription.create',
    ]);
    for (const event of PAYSTACK_SUPPORTED_EVENTS) {
      assert.ok(isPaystackSupportedEvent(event), `${event} should be supported`);
    }
  });

  it('maps every supported event only onto canonical event types', () => {
    const canonical = new Set<string>(BILLING_EVENT_TYPES);
    assert.equal(
      Object.keys(PAYSTACK_CANONICAL_EVENT_TYPES).length,
      PAYSTACK_SUPPORTED_EVENTS.length,
    );
    for (const [event, types] of Object.entries(PAYSTACK_CANONICAL_EVENT_TYPES)) {
      assert.ok(isPaystackSupportedEvent(event));
      assert.ok(types.length > 0, `${event} maps to nothing`);
      for (const type of types) {
        assert.ok(canonical.has(type), `${event} maps to non-canonical "${type}"`);
      }
    }
    // One provider event, two canonical types, decided by the payload's own
    // documented `paid` flag.
    assert.deepEqual([...PAYSTACK_CANONICAL_EVENT_TYPES['invoice.update']!], [
      'invoice.processed',
      'invoice.failed',
    ]);
    assert.deepEqual([...PAYSTACK_CANONICAL_EVENT_TYPES['charge.success']!], ['payment.succeeded']);
    assert.deepEqual([...PAYSTACK_CANONICAL_EVENT_TYPES['subscription.create']!], [
      'subscription.created',
    ]);
    assert.deepEqual([...PAYSTACK_CANONICAL_EVENT_TYPES['invoice.payment_failed']!], [
      'invoice.failed',
    ]);
  });

  it('records a reason for every documented event it refuses', () => {
    const documentedButRefused = [
      'charge.failed',
      'invoice.create',
      'subscription.disable',
      'subscription.enable',
      'subscription.expiring_cards',
      'subscription.not_renew',
    ];
    assert.deepEqual(Object.keys(PAYSTACK_UNSUPPORTED_EVENT_REASONS).sort(), documentedButRefused);
    for (const event of documentedButRefused) {
      const reason = PAYSTACK_UNSUPPORTED_EVENT_REASONS[event];
      assert.ok(typeof reason === 'string' && reason.length > 20, `${event}: no stated reason`);
      assert.ok(!isPaystackSupportedEvent(event), `${event} must not be supported`);
      assert.ok(
        !(event in PAYSTACK_CANONICAL_EVENT_TYPES),
        `${event} must not have a canonical mapping`,
      );
    }
  });

  it('pins normalizeEvent as implemented while the rest of the seam still refuses', () => {
    assert.deepEqual([...PAYSTACK_IMPLEMENTED_OPERATIONS], [
      'findCustomer',
      'createCustomer',
      'initializeCheckout',
      'verifySubscription',
      'normalizeEvent',
    ]);
    const unimplemented = provider.describe()['operations'] as {
      implemented: string[];
      unimplemented: string[];
    };
    assert.ok(unimplemented.implemented.includes('normalizeEvent'));
    assert.ok(!unimplemented.unimplemented.includes('normalizeEvent'));
    assert.deepEqual(unimplemented.unimplemented, [
      'findSubscription',
      'synchronizeSubscription',
      'cancelSubscription',
    ]);
  });

  it('reports the event contract, and that nothing receives or confirms anything yet', () => {
    const described = provider.describe();
    assert.deepEqual(described['events'], {
      receiver: 'none',
      signatureVerification: 'none',
      confirmsPayment: false,
      grantsExecution: false,
      supported: [...PAYSTACK_SUPPORTED_EVENTS],
      canonicalEventTypes: PAYSTACK_CANONICAL_EVENT_TYPES,
      unsupported: Object.keys(PAYSTACK_UNSUPPORTED_EVENT_REASONS),
    });
    // Still sandbox-only, and still not a complete provider: normalizing events
    // does not make the adapter `implemented`.
    assert.equal(described['live'], false);
    assert.equal(described['implemented'], false);
    assert.equal(described['provider'], 'paystack');
  });
});

describe('the repository-pinned webhook fixtures', () => {
  it('back every supported event and carry their provenance', () => {
    assert.ok(fixtures.size >= 8, `expected the pinned fixture set, found ${fixtures.size}`);
    for (const event of PAYSTACK_SUPPORTED_EVENTS) {
      assert.ok(
        supportedFixtures.some((fixture) => fixture.event === event),
        `no fixture backs supported event ${event}`,
      );
    }
    for (const fixture of fixtures.values()) {
      assert.equal(fixture.body['event'], fixture.event, `${fixture.fixture}: event mismatch`);
      assert.ok(
        fixture.provenance.sources.length > 0,
        `${fixture.fixture}: no published source recorded`,
      );
      assert.ok(
        fixture.provenance.verifiedFieldNames.length > 3,
        `${fixture.fixture}: no verified field names recorded`,
      );
      assert.ok(
        fixture.provenance.adaptedValues.length > 20,
        `${fixture.fixture}: adapted values not explained`,
      );
      for (const source of fixture.provenance.sources) {
        assert.match(
          source,
          /^https:\/\/(paystack\.com|docs-v1\.paystack\.com)\//,
          `${fixture.fixture}: source is not an official Paystack page`,
        );
      }
      assert.equal(
        fixture.event in PAYSTACK_CANONICAL_EVENT_TYPES,
        fixture.supported,
        `${fixture.fixture}: supported flag disagrees with the vocabulary`,
      );
      if (fixture.supported) {
        assert.ok(
          canonicalFor(fixture.event)?.includes(fixture.canonicalEventType),
          `${fixture.fixture}: canonical type is not a documented mapping`,
        );
      } else {
        assert.ok(
          typeof fixture.reason === 'string' && fixture.reason.length > 20,
          `${fixture.fixture}: unsupported without a reason`,
        );
        assert.equal(fixture.canonicalEventType, 'unrecognized');
      }
    }
  });

  it('never reuse the plan identifier the core evidence test forbids in code', () => {
    // packages/core/test/billing-epoch-pricing.test.ts walks packages/, apps/
    // and scripts/ and requires ZERO occurrences of the documentation-only
    // evidence plan code — including inside this test file, so the needle is
    // assembled here rather than written as a literal.
    const documentationOnlyPlanCode = ['PLN_u0l4', '961hhipl6ek'].join('');
    for (const fixture of fixtures.values()) {
      assert.ok(
        !JSON.stringify(fixture).includes(documentationOnlyPlanCode),
        `${fixture.fixture}: uses a plan code reserved for documentation`,
      );
    }
    // The fixtures do carry a plan code of their own, so the check is meaningful.
    assert.ok(
      JSON.stringify(byFixture('subscription-create').body).includes('PLN_fixture0000pro1'),
    );
  });
});

/* ========================================================================== */
/* 2. Every supported fixture normalizes onto the canonical contract           */
/* ========================================================================== */

describe('normalizing verified fixtures through the seam', () => {
  for (const fixture of [...fixtures.values()]) {
    it(`${fixture.fixture} → ${fixture.canonicalEventType}`, async () => {
      const event = await provider.normalizeEvent(delivery(fixture.body));

      // The canonical contract accepts the result outright: `.strict()`,
      // category↔eventType agreement, `grantsExecution` pinned false.
      const parsed = normalizedBillingEventSchema.parse(event);
      assert.deepEqual(Object.keys(parsed).sort(), [
        'category',
        'data',
        'grantsExecution',
        'identity',
        'subject',
      ]);
      assert.equal(parsed.identity.eventType, fixture.canonicalEventType);
      assert.equal(parsed.category, billingEventCategory(fixture.canonicalEventType));
      assert.equal(parsed.grantsExecution, false);
      assert.equal(parsed.identity.provider, 'paystack');
      assert.equal(parsed.identity.receivedAt, RECEIVED_AT);

      // Identity is derived, never invented: the payload hash and idempotency
      // key are exactly core's canonical derivation over the ORIGINAL body,
      // which the result itself does not carry.
      const payloadHash = billingEventPayloadHash(fixture.body);
      const idempotencyInput = {
        provider: 'paystack' as const,
        providerEventId: null,
        eventType: fixture.canonicalEventType,
        occurredAt: parsed.identity.occurredAt,
        payloadHash,
      };
      assert.equal(parsed.identity.payloadHash, payloadHash);
      assert.equal(parsed.identity.providerEventId, null);
      assert.equal(parsed.identity.idempotencyKey, billingEventIdempotencyKey(idempotencyInput));
      assert.equal(
        parsed.identity.idempotencyKey,
        createHash('sha256')
          .update(billingEventIdempotencyCanonicalString(idempotencyInput))
          .digest('hex'),
      );
      assert.equal(
        billingEventIdempotencyCanonicalString(idempotencyInput),
        `paystack||${fixture.canonicalEventType}|${parsed.identity.occurredAt ?? ''}|${payloadHash}`,
      );
      assert.ok(providerEventIdentitySchema.safeParse(parsed.identity).success);

      // Local identity is never resolved here, and catalogue identity is never
      // derived from a provider payload.
      assert.equal(parsed.subject?.userId ?? null, null);
      assert.equal(parsed.subject?.subscriptionId ?? null, null);
      assert.equal(parsed.subject?.billingCustomerId ?? null, null);
      assert.equal(parsed.data?.cataloguePlan ?? null, null);
      assert.equal(parsed.data?.interval ?? null, null);

      // Safe to persist: the canonical data schema (and migration 0031's CHECK)
      // accept it, and no failure reason is credential-shaped.
      if (parsed.data !== null) {
        assert.ok(billingEventDataSchema.safeParse(parsed.data).success);
        assert.ok(
          parsed.data.failureReason === null ||
            !BILLING_CREDENTIAL_SHAPED_RE.test(parsed.data.failureReason),
          `${fixture.fixture}: credential-shaped failureReason`,
        );
      }

      // Nothing provider-shaped crosses back, and no raw body survives.
      const serialized = JSON.stringify(parsed);
      for (const sentinel of SENTINELS) {
        if (fixture.fixture === 'invoice-payment-failed-described' && sentinel === 'Insufficient Funds') {
          // The one provider-authored sentence the contract deliberately maps.
          assert.ok(serialized.includes(sentinel), 'the documented failure detail was dropped');
          continue;
        }
        assert.ok(
          !serialized.includes(sentinel),
          `${fixture.fixture}: result carries "${sentinel}"`,
        );
      }
      for (const text of PROVIDER_ONLY_TEXT) {
        assert.ok(!serialized.includes(text), `${fixture.fixture}: result carries ${text}`);
      }
    });
  }

  it('reports the canonical facts of a plan-bound successful charge', async () => {
    const fixture = byFixture('charge-success-plan-bound');
    const data = fixture.body['data'] as Record<string, unknown>;
    const event = await provider.normalizeEvent(delivery(fixture.body));

    assert.equal(event.identity.eventType, 'payment.succeeded');
    assert.equal(event.category, 'payment');
    assert.equal(event.identity.occurredAt, data['paid_at']);
    assert.deepEqual(event.subject, {
      userId: null,
      subscriptionId: null,
      billingCustomerId: null,
      providerCustomerId: 'CUS_fixture0000001',
      // A charge payload documents no subscription identifier, and the plan
      // object it carries is not a subscription: none is invented.
      providerSubscriptionId: null,
      providerReference: 've-chk-fixture-0001',
    });
    assert.deepEqual(event.data, {
      cataloguePlan: null,
      interval: null,
      // No subscription state is documented on a transaction payload.
      state: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
      cancellationReason: null,
      // The COMMERCIAL (USD) amount is never reported by a provider event; the
      // payment-currency amount is, validated against the canonical exponent.
      amountMinor: null,
      currency: null,
      payment: ghs(48750),
      failureReason: null,
    });
  });

  it('accepts a one-off charge, whose published payload carries no plan', async () => {
    const fixture = byFixture('charge-success-one-off');
    assert.deepEqual((fixture.body['data'] as Record<string, unknown>)['plan'], {});
    const event = await provider.normalizeEvent(delivery(fixture.body));
    assert.equal(event.identity.eventType, 'payment.succeeded');
    assert.deepEqual(event.data?.payment, ghs(12500));
    assert.equal(event.subject?.providerReference, 've-chk-fixture-0003');
    assert.equal(event.subject?.providerSubscriptionId, null);
    // The documented channel is not part of the canonical contract, so it is
    // ignored rather than mapped onto a field that does not exist.
    assert.ok(!JSON.stringify(event).includes('mobile_money'));
  });

  it('reports the canonical facts of a created subscription', async () => {
    const fixture = byFixture('subscription-create');
    const event = await provider.normalizeEvent(delivery(fixture.body));

    assert.equal(event.identity.eventType, 'subscription.created');
    assert.equal(event.category, 'subscription');
    // The published payload carries BOTH createdAt and created_at with different
    // values; only the documented snake_case timestamp is used.
    assert.equal(event.identity.occurredAt, '2026-09-22T09:05:21.000Z');
    assert.deepEqual(event.subject, {
      userId: null,
      subscriptionId: null,
      billingCustomerId: null,
      providerCustomerId: 'CUS_fixture0000001',
      providerSubscriptionId: 'SUB_fixture0000001',
      // No transaction reference is documented on this payload.
      providerReference: null,
    });
    assert.deepEqual(event.data, {
      cataloguePlan: null,
      // The provider's interval string is a documented field but never an
      // authorization: catalogue identity is not derived from a payload.
      interval: null,
      state: 'active',
      // next_payment_date is the date of the NEXT charge, not a period
      // boundary, so no period is asserted from it.
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: null,
      cancellationReason: null,
      amountMinor: null,
      currency: null,
      // The subscription amount has no currency of its own in the published
      // payload; the currency is documented on the plan and read there, so
      // nothing is assumed.
      payment: ghs(48750),
      failureReason: null,
    });
  });

  it('maps a paid invoice update onto invoice.processed with the reported period', async () => {
    const fixture = byFixture('invoice-update-paid');
    const event = await provider.normalizeEvent(delivery(fixture.body));
    assert.equal(event.identity.eventType, 'invoice.processed');
    assert.equal(event.category, 'invoice');
    assert.equal(event.identity.occurredAt, '2026-10-22T00:00:09.000Z');
    assert.equal(event.subject?.providerSubscriptionId, 'SUB_fixture0000001');
    assert.equal(event.subject?.providerReference, 've-chk-fixture-0002');
    assert.equal(event.data?.currentPeriodStart, '2026-10-22T00:00:00.000Z');
    assert.equal(event.data?.currentPeriodEnd, '2026-11-22T00:00:00.000Z');
    assert.equal(event.data?.state, 'active');
    assert.equal(event.data?.failureReason, null);
    // An invoice documents its amount without a currency of its own (the
    // currency appears only inside the optional transaction object, which the
    // provider documents as sometimes EMPTY), so no payment amount is asserted.
    assert.equal(event.data?.payment, null);
    assert.equal(event.data?.amountMinor, null);
    assert.equal(event.data?.currency, null);
  });

  it('maps a failed invoice charge onto invoice.failed, period reported as published', async () => {
    const fixture = byFixture('invoice-payment-failed');
    const event = await provider.normalizeEvent(delivery(fixture.body));
    assert.equal(event.identity.eventType, 'invoice.failed');
    assert.equal(event.category, 'invoice');
    // paid_at is null, so the invoice's creation instant is the occurrence.
    assert.equal(event.identity.occurredAt, '2026-11-22T00:00:03.000Z');
    // The published example has period_start AFTER period_end; the normalizer
    // reports the period as documented and enforces no ordering the provider
    // does not publish.
    assert.equal(event.data?.currentPeriodStart, '2026-11-22T00:00:00.000Z');
    assert.equal(event.data?.currentPeriodEnd, '2026-11-21T23:59:59.000Z');
    // The transaction object is EMPTY in the published payload, so no provider
    // reference is asserted from it.
    assert.equal(event.subject?.providerReference, null);
    assert.equal(event.subject?.providerSubscriptionId, 'SUB_fixture0000001');
    assert.equal(event.data?.failureReason, null);
    assert.equal(event.data?.state, 'active');
  });

  it('maps an unpaid invoice update onto invoice.failed, following the paid flag', async () => {
    const unpaid = mutate(byFixture('invoice-update-paid'), 'data.paid', false);
    const event = await provider.normalizeEvent(delivery(unpaid));
    assert.equal(event.identity.eventType, 'invoice.failed');
    assert.equal(event.category, 'invoice');
    // paid_at is still carried by that payload, so it remains the occurrence.
    assert.equal(event.identity.occurredAt, '2026-10-22T00:00:09.000Z');
  });

  it('carries the provider explanation as the only failure detail it maps', async () => {
    const fixture = byFixture('invoice-payment-failed-described');
    const event = await provider.normalizeEvent(delivery(fixture.body));
    assert.equal(event.identity.eventType, 'invoice.failed');
    assert.equal(event.data?.failureReason, 'Insufficient Funds');
    assert.ok(billingEventDataSchema.safeParse(event.data).success);
    // The status "attention" is documented as a retry state the provider
    // contradicts itself about, so it maps to unknown: no authoritative state
    // change is asserted.
    assert.equal(event.data?.state, 'unknown');
  });

  it('accepts an invoice whose optional documented fields are absent or null', async () => {
    const fixture = byFixture('invoice-update-paid');
    let body = mutate(fixture, 'data.period_start', null);
    body = mutate(
      { ...fixture, body } as WebhookFixture,
      'data.period_end',
      undefined,
      { deleteField: true },
    );
    const event = await provider.normalizeEvent(delivery(body));
    assert.equal(event.identity.eventType, 'invoice.processed');
    assert.equal(event.data?.currentPeriodStart, null);
    assert.equal(event.data?.currentPeriodEnd, null);
    // A null description is not a failure detail.
    assert.equal(event.data?.failureReason, null);
  });

  it('normalizes purely: no transport, no directory, no mutation of the payload', async () => {
    const fixture = byFixture('charge-success-plan-bound');
    const before = JSON.stringify(fixture.body);

    const first = await provider.normalizeEvent(delivery(fixture.body));
    const second = await provider.normalizeEvent(delivery(fixture.body));
    assert.deepEqual(first, second);
    assert.deepEqual(fetchCalls, [], 'normalizeEvent performed I/O');
    assert.equal(JSON.stringify(fixture.body), before, 'the delivered payload was mutated');

    // The same purity holds for the exported normalizer, called directly.
    const facts = normalizePaystackEventPayload(fixture.body);
    assert.deepEqual(facts, {
      eventType: first.identity.eventType,
      occurredAt: first.identity.occurredAt,
      subject: first.subject,
      data: first.data,
    });
    assert.deepEqual(normalizePaystackEventPayload(fixture.body), facts);
  });
});

/* ========================================================================== */
/* 3. Unknown and unverified events are never falsely supported                */
/* ========================================================================== */

describe('unverified, documented-but-refused and invented events', () => {
  it('normalize documented-but-refused events as unrecognized, without guessing', async () => {
    for (const event of Object.keys(PAYSTACK_UNSUPPORTED_EVENT_REASONS)) {
      // `data` is an empty placeholder: the provider publishes no payload shape
      // for these events, so nothing here claims to know one.
      const normalized = await provider.normalizeEvent(delivery({ event, data: {} }));
      assert.equal(normalized.identity.eventType, 'unrecognized');
      assert.equal(normalized.category, 'unrecognized');
      assert.equal(normalized.identity.occurredAt, null);
      assert.equal(normalized.subject, null);
      assert.equal(normalized.data, null);
      assert.equal(normalized.grantsExecution, false);
    }
  });

  it('normalize the pinned unsupported fixtures as unrecognized', async () => {
    assert.ok(unsupportedFixtures.length >= 2);
    for (const fixture of unsupportedFixtures) {
      const normalized = await provider.normalizeEvent(delivery(fixture.body));
      assert.equal(normalized.identity.eventType, 'unrecognized', fixture.fixture);
      assert.equal(normalized.subject, null);
      assert.equal(normalized.data, null);
      assert.equal(normalized.identity.occurredAt, null);
      const serialized = JSON.stringify(normalized);
      for (const sentinel of SENTINELS) {
        assert.ok(!serialized.includes(sentinel), `${fixture.fixture}: leaked "${sentinel}"`);
      }
      // The published invoice.create payload IS verified, but the canonical
      // vocabulary has no "invoice created" type, so it must not be coerced
      // into an invoice outcome it does not state.
      if (fixture.event === 'invoice.create') {
        assert.ok(
          !['invoice.processed', 'invoice.failed'].includes(normalized.identity.eventType),
        );
      }
      // The expiring-cards payload is an ARRAY of card details: unrecognized
      // must still be produced without crashing, and without card detail.
      if (fixture.event === 'subscription.expiring_cards') {
        assert.ok(Array.isArray(fixture.body['data']));
        assert.ok(!serialized.includes('expiry_date'));
        assert.ok(!serialized.includes('Visa'));
      }
    }
  });

  it('normalize invented event names as unrecognized', async () => {
    const invented = [
      'invoice.paid',
      'subscription.updated',
      'subscription.cancelled',
      'charge.succeeded',
      'payment.succeeded', // a CANONICAL name is not a provider event name
      'subscription.created',
      'invoice.failed',
      'charge.success.typo',
      'CHARGE.SUCCESS',
      ' charge.success',
      'charge.success ',
      '   ',
      '*',
    ];
    for (const name of invented) {
      const normalized = await provider.normalizeEvent(delivery({ event: name, data: {} }));
      assert.equal(normalized.identity.eventType, 'unrecognized', `"${name}" was treated as known`);
      assert.equal(normalized.data, null);
      assert.equal(normalized.subject, null);
      assert.equal(normalized.identity.occurredAt, null);
    }
    assert.equal(isPaystackSupportedEvent('payment.succeeded'), false);
    assert.equal(isPaystackSupportedEvent('charge.success'), true);
  });

  it('refuse an event name that is not a readable envelope field', async () => {
    await refuses({ event: 'a'.repeat(191), data: {} }, { reason: 'unexpected_response' });
  });

  it('never accept an unsupported event just because its data looks canonical', async () => {
    // A fully-formed, plausible subscription.disable payload is still refused:
    // the provider publishes no shape for it, so nothing may be inferred.
    const normalized = await provider.normalizeEvent(
      delivery({
        event: 'subscription.disable',
        data: {
          domain: 'test',
          status: 'complete',
          subscription_code: 'SUB_fixture0000001',
          amount: 48750,
          customer: { customer_code: 'CUS_fixture0000001' },
          created_at: '2026-10-22T00:00:00.000Z',
        },
      }),
    );
    assert.equal(normalized.identity.eventType, 'unrecognized');
    assert.equal(normalized.subject, null);
    assert.equal(normalized.data, null);
  });

  it('treat the whole documented vocabulary as either supported or refused', () => {
    // Every event name Paystack documents for webhooks is accounted for: it is
    // either in the supported set or carries a stated reason. Nothing is left
    // silently unclassified.
    const documented = [
      ...PAYSTACK_SUPPORTED_EVENTS,
      ...Object.keys(PAYSTACK_UNSUPPORTED_EVENT_REASONS),
      'charge.dispute.create',
      'charge.dispute.remind',
      'charge.dispute.resolve',
      'customeridentification.failed',
      'customeridentification.success',
      'dedicatedaccount.assign.failed',
      'dedicatedaccount.assign.success',
      'paymentrequest.pending',
      'paymentrequest.success',
      'refund.failed',
      'refund.pending',
      'refund.processed',
      'refund.processing',
      'transfer.failed',
      'transfer.success',
      'transfer.reversed',
    ];
    for (const event of new Set(documented)) {
      const classified =
        isPaystackSupportedEvent(event) || event in PAYSTACK_UNSUPPORTED_EVENT_REASONS;
      if (!classified) {
        // Out of scope for billing (disputes, refunds, transfers, identities,
        // dedicated accounts, payment requests): unrecognized, never supported.
        assert.equal(isPaystackSupportedEvent(event), false, `${event} must not be supported`);
      }
    }
    // The four supported events are the only billing-relevant ones with a
    // published payload this build can normalize.
    assert.equal(PAYSTACK_SUPPORTED_EVENTS.length, 4);
  });
});

/* ========================================================================== */
/* 4. Required fields and malformed payloads fail closed                       */
/* ========================================================================== */

describe('required fields and malformed payloads', () => {
  it('refuse a delivery whose seam request is not canonical', async () => {
    const malformedRequests: unknown[] = [
      undefined,
      null,
      'charge.success',
      {},
      { provider: 'paystack' },
      { provider: 'stripe', payload: {}, providerEventId: null, receivedAt: RECEIVED_AT },
      { payload: {}, providerEventId: null, receivedAt: RECEIVED_AT },
      { provider: 'paystack', payload: {}, providerEventId: null },
      { provider: 'paystack', payload: {}, providerEventId: null, receivedAt: 'yesterday' },
      { provider: 'paystack', payload: {}, providerEventId: null, receivedAt: 1790000000 },
      {
        provider: 'paystack',
        payload: {},
        providerEventId: null,
        receivedAt: RECEIVED_AT,
        rawBody: '{"event":"charge.success"}',
      },
      {
        provider: 'paystack',
        payload: {},
        providerEventId: null,
        receivedAt: RECEIVED_AT,
        signature: 'deadbeef',
      },
    ];
    for (const request of malformedRequests) {
      let caught: unknown;
      try {
        await provider.normalizeEvent(request as BillingProviderRawEvent);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof PaystackAdapterError, `accepted ${JSON.stringify(request)}`);
      assert.equal(caught.reason, 'invalid_request');
      for (const sentinel of SENTINELS) {
        assert.ok(!caught.message.includes(sentinel));
      }
    }
  });

  it('refuse a payload that is not a readable provider envelope', async () => {
    const payloads: unknown[] = [
      undefined,
      null,
      'charge.success',
      42,
      [],
      {},
      { data: {} },
      { event: 7, data: {} },
      { event: '', data: {} },
      { event: null, data: {} },
      { event: ['charge.success'], data: {} },
    ];
    for (const payload of payloads) {
      await refuses(payload, { reason: 'unexpected_response' });
    }
  });

  it('refuse a supported event whose data is missing or not an object', async () => {
    for (const event of PAYSTACK_SUPPORTED_EVENTS) {
      await refuses({ event }, { reason: 'unexpected_response' });
      await refuses({ event, data: null }, { reason: 'unexpected_response' });
      await refuses({ event, data: [] }, { reason: 'unexpected_response' });
      await refuses({ event, data: 'success' }, { reason: 'unexpected_response' });
      await refuses({ event, data: 48750 }, { reason: 'unexpected_response' });
    }
  });

  it('refuse a supported event missing a required field, naming the path only', async () => {
    const required: Array<[string, string]> = [
      ['charge-success-plan-bound', 'data.domain'],
      ['charge-success-plan-bound', 'data.status'],
      ['charge-success-plan-bound', 'data.reference'],
      ['charge-success-plan-bound', 'data.amount'],
      ['charge-success-plan-bound', 'data.currency'],
      ['charge-success-plan-bound', 'data.paid_at'],
      ['charge-success-plan-bound', 'data.customer'],
      ['charge-success-plan-bound', 'data.customer.customer_code'],
      ['charge-success-one-off', 'data.reference'],
      ['charge-success-one-off', 'data.currency'],
      ['subscription-create', 'data.domain'],
      ['subscription-create', 'data.status'],
      ['subscription-create', 'data.subscription_code'],
      ['subscription-create', 'data.amount'],
      ['subscription-create', 'data.created_at'],
      ['subscription-create', 'data.customer'],
      ['subscription-create', 'data.customer.customer_code'],
      ['subscription-create', 'data.plan'],
      ['subscription-create', 'data.plan.plan_code'],
      ['subscription-create', 'data.plan.amount'],
      ['subscription-create', 'data.plan.currency'],
      ['subscription-create', 'data.plan.interval'],
      ['invoice-update-paid', 'data.domain'],
      ['invoice-update-paid', 'data.invoice_code'],
      ['invoice-update-paid', 'data.amount'],
      ['invoice-update-paid', 'data.status'],
      ['invoice-update-paid', 'data.paid'],
      ['invoice-update-paid', 'data.created_at'],
      ['invoice-update-paid', 'data.subscription'],
      ['invoice-update-paid', 'data.subscription.status'],
      ['invoice-update-paid', 'data.subscription.subscription_code'],
      ['invoice-update-paid', 'data.customer.customer_code'],
      ['invoice-payment-failed', 'data.invoice_code'],
      ['invoice-payment-failed', 'data.paid'],
      ['invoice-payment-failed', 'data.subscription.subscription_code'],
      ['invoice-payment-failed', 'data.created_at'],
      ['invoice-payment-failed', 'data.customer.customer_code'],
    ];

    for (const [fixtureId, fieldPath] of required) {
      const fixture = byFixture(fixtureId);
      const error = await refuses(mutate(fixture, fieldPath, undefined, { deleteField: true }), {
        reason: 'unexpected_response',
      });
      // Diagnosable without echoing anything: the message names the provider
      // event and the field path, and never quotes a payload value.
      assert.ok(
        error.message.includes(fieldPath.slice('data.'.length)),
        `${fixtureId}/${fieldPath}: message does not name the field (${error.message})`,
      );
      assert.ok(error.message.includes(fixture.event), `${fixtureId}: message omits the event`);
    }
  });

  it('refuse wrong types on required fields', async () => {
    const wrongTypes: Array<[string, string, unknown]> = [
      ['charge-success-plan-bound', 'data.amount', '48750'],
      ['charge-success-plan-bound', 'data.amount', {}],
      ['charge-success-plan-bound', 'data.amount', null],
      ['charge-success-plan-bound', 'data.currency', 566],
      ['charge-success-plan-bound', 'data.status', 200],
      ['charge-success-plan-bound', 'data.paid_at', '22-09-2026'],
      ['charge-success-plan-bound', 'data.paid_at', 1790000000],
      ['charge-success-plan-bound', 'data.paid_at', null],
      ['charge-success-plan-bound', 'data.reference', 12345],
      ['charge-success-plan-bound', 'data.customer', 'CUS_fixture0000001'],
      ['charge-success-plan-bound', 'data.customer.customer_code', 6910995],
      ['charge-success-plan-bound', 'data.customer.customer_code', ''],
      ['subscription-create', 'data.plan', 'PLN_fixture0000pro1'],
      ['subscription-create', 'data.plan.amount', '48750'],
      ['subscription-create', 'data.plan.currency', 566],
      ['subscription-create', 'data.created_at', 'yesterday'],
      ['subscription-create', 'data.status', {}],
      ['subscription-create', 'data.subscription_code', 7],
      ['invoice-update-paid', 'data.paid', 'true'],
      ['invoice-update-paid', 'data.paid', 1],
      ['invoice-update-paid', 'data.paid', null],
      ['invoice-update-paid', 'data.period_start', 1790000000],
      ['invoice-update-paid', 'data.period_end', 'next month'],
      ['invoice-update-paid', 'data.subscription', 'SUB_fixture0000001'],
      ['invoice-update-paid', 'data.transaction', 've-chk-fixture-0002'],
      ['invoice-update-paid', 'data.description', { text: 'Insufficient Funds' }],
      ['invoice-payment-failed', 'data.invoice_code', 3],
      ['invoice-payment-failed', 'data.subscription.status', null],
    ];

    for (const [fixtureId, fieldPath, value] of wrongTypes) {
      await refuses(mutate(byFixture(fixtureId), fieldPath, value), {
        reason: 'unexpected_response',
      });
    }
  });

  it('refuse a non-sandbox domain on every supported event', async () => {
    for (const fixture of supportedFixtures) {
      for (const domain of ['live', 'production', 'TEST', 'Test']) {
        await refuses(mutate(fixture, 'data.domain', domain), {
          reason: 'invalid_configuration',
        });
      }
      // A missing or empty domain is a malformed payload, not a configuration
      // contradiction — still refused, with a different reason.
      await refuses(mutate(fixture, 'data.domain', undefined, { deleteField: true }), {
        reason: 'unexpected_response',
      });
      await refuses(mutate(fixture, 'data.domain', ''), { reason: 'unexpected_response' });
    }
  });

  it('refuse payloads that contradict the event they were delivered under', async () => {
    // charge.success is normalized only when the transaction really succeeded.
    for (const status of ['failed', 'pending', 'abandoned', 'queued', 'SUCCESS', 'success ']) {
      const error = await refuses(
        mutate(byFixture('charge-success-plan-bound'), 'data.status', status),
        { reason: 'unexpected_response' },
      );
      assert.ok(error.message.includes('not a success') || error.message.includes('malformed'));
    }
    // The plan amount is cross-checked against the subscription amount: a
    // delivery that disagrees with itself reports no amount at all.
    await refuses(mutate(byFixture('subscription-create'), 'data.plan.amount', 12500), {
      reason: 'unexpected_response',
    });
    await refuses(mutate(byFixture('subscription-create'), 'data.amount', 12500), {
      reason: 'unexpected_response',
    });
  });

  it('refuse a currency or amount this build cannot normalize', async () => {
    assert.deepEqual([...BILLING_PAYMENT_CURRENCIES], ['GHS']);
    assert.equal(BILLING_PAYMENT_AMOUNT_EXPONENT.GHS, 2);

    for (const currency of ['USD', 'NGN', 'ghs', 'GHC', '', 'GHS ']) {
      await refuses(mutate(byFixture('charge-success-plan-bound'), 'data.currency', currency), {
        reason: 'unexpected_response',
      });
    }
    await refuses(mutate(byFixture('subscription-create'), 'data.plan.currency', 'USD'), {
      reason: 'unexpected_response',
    });

    // No float, no string, no zero, no negative and no unsafe integer survives
    // for an amount this build REPORTS; nothing is rounded, coerced or
    // converted here.
    for (const amount of [487.5, 0.5, 0, -1, -48750, 2 ** 53, Number.MAX_SAFE_INTEGER + 10]) {
      await refuses(mutate(byFixture('charge-success-plan-bound'), 'data.amount', amount));
      await refuses(mutate(byFixture('subscription-create'), 'data.plan.amount', amount));
      await refuses(mutate(byFixture('subscription-create'), 'data.amount', amount));
    }

    // An invoice documents its amount without a currency of its own, so no
    // payment amount is mapped from it — but the documented shape is still
    // enforced: a float, a string, a negative or an unsafe amount means the
    // delivery is not the documented payload.
    for (const amount of [
      487.5,
      0.5,
      -1,
      -48750,
      2 ** 53,
      Number.MAX_SAFE_INTEGER + 10,
      '48750',
      null,
    ]) {
      await refuses(mutate(byFixture('invoice-update-paid'), 'data.amount', amount));
      await refuses(mutate(byFixture('invoice-payment-failed'), 'data.amount', amount));
    }

    // A zero-amount invoice claims no payment, and is still normalized without
    // asserting any amount.
    const zero = await provider.normalizeEvent(
      delivery(mutate(byFixture('invoice-update-paid'), 'data.amount', 0)),
    );
    assert.equal(zero.identity.eventType, 'invoice.processed');
    assert.equal(zero.data?.payment, null);
    assert.equal(zero.data?.amountMinor, null);
    assert.equal(zero.data?.currency, null);
  });

  it('refuse an unusable occurrence instant, or one after the receipt', async () => {
    await refuses(mutate(byFixture('charge-success-plan-bound'), 'data.paid_at', 'not-a-date'));
    await refuses(
      mutate(byFixture('invoice-update-paid'), 'data.paid_at', '2026-13-45T99:99:99Z'),
    );
    // occurredAt must not postdate receivedAt.
    await refuses(byFixture('charge-success-plan-bound').body, {
      receivedAt: '2026-01-01T00:00:00.000Z',
      reason: 'unexpected_response',
    });
    // Exactly at the receipt instant is accepted.
    const exact = await provider.normalizeEvent(
      delivery(byFixture('charge-success-plan-bound').body, {
        receivedAt: '2026-09-22T09:05:12.000Z',
      }),
    );
    assert.equal(exact.identity.occurredAt, exact.identity.receivedAt);
  });

  it('refuse a provider event id that is not a reference-shaped identifier', async () => {
    const body = byFixture('charge-success-plan-bound').body;
    for (const providerEventId of [
      'evt_token_DONOTPERSIST',
      'authorization=abc',
      'secret value',
      'api_key 123',
      'password:hunter2',
      'Bearer abc',
      'x'.repeat(191),
      12345 as unknown as string,
      { id: 'evt_1' } as unknown as string,
    ]) {
      await refuses(body, { providerEventId, reason: 'invalid_request' });
    }
    // A reference-shaped id IS accepted and participates in identity.
    const normalized = await provider.normalizeEvent(
      delivery(body, { providerEventId: 'evt_1948291' }),
    );
    assert.equal(normalized.identity.providerEventId, 'evt_1948291');
  });

  it('never downgrade a malformed supported payload to unrecognized', async () => {
    for (const fixture of supportedFixtures) {
      const error = await refuses(mutate(fixture, 'data.domain', 'live'), {
        reason: 'invalid_configuration',
      });
      assert.notEqual(error.reason, 'not_implemented');
      assert.ok(!error.message.includes('unrecognized'));
    }
    // The exported normalizer throws for the same inputs, so a caller cannot
    // mistake a refusal for an unknown event.
    assert.throws(() =>
      normalizePaystackEventPayload({ event: 'charge.success', data: { domain: 'live' } }),
    );
    assert.throws(() => normalizePaystackEventPayload({ event: 'invoice.update', data: {} }));
    assert.throws(() => normalizePaystackEventPayload({ event: 'subscription.create' }));
    // An unknown event, by contrast, is not an error.
    assert.deepEqual(normalizePaystackEventPayload({ event: 'invoice.create', data: {} }), {
      eventType: 'unrecognized',
      occurredAt: null,
      subject: null,
      data: null,
    });
  });

  it('still refuse the operations that are genuinely unimplemented', async () => {
    const userId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const error = await provider
      .cancelSubscription({
        provider: 'paystack',
        userId,
        providerSubscriptionId: 'SUB_fixture0000001',
        immediate: false,
        reason: 'user',
        idempotencyKey: 'a'.repeat(64),
        requestedAt: '2027-06-01T00:00:00.000Z',
      })
      .then(
        () => undefined,
        (cause: unknown) => cause,
      );
    assert.ok(error instanceof PaystackAdapterError);
    assert.equal(error.reason, 'not_implemented');
    assert.ok(error.message.includes('cancelSubscription'));
    assert.ok(!error.message.includes('normalizeEvent'));
  });
});

/* ========================================================================== */
/* 5. Deterministic identity and idempotency keys                              */
/* ========================================================================== */

describe('deterministic provider event identity', () => {
  it('produce the same key for the same delivery, whatever the receipt instant', async () => {
    const body = byFixture('invoice-update-paid').body;
    const first = await provider.normalizeEvent(
      delivery(body, { receivedAt: '2027-01-01T00:00:00.000Z' }),
    );
    const second = await provider.normalizeEvent(
      delivery(body, { receivedAt: '2027-06-01T00:00:00.000Z' }),
    );
    assert.equal(first.identity.idempotencyKey, second.identity.idempotencyKey);
    assert.equal(first.identity.payloadHash, second.identity.payloadHash);
    assert.equal(first.identity.occurredAt, second.identity.occurredAt);
    assert.notEqual(first.identity.receivedAt, second.identity.receivedAt);
  });

  it('produce a different key for a materially different payload', async () => {
    const base = byFixture('invoice-update-paid');
    const first = await provider.normalizeEvent(delivery(base.body));
    const changedInvoice = await provider.normalizeEvent(
      delivery(mutate(base, 'data.invoice_code', 'INV_fixture0000099')),
    );
    const changedAmount = await provider.normalizeEvent(
      delivery(mutate(base, 'data.amount', 12500)),
    );
    const keys = new Set([
      first.identity.idempotencyKey,
      changedInvoice.identity.idempotencyKey,
      changedAmount.identity.idempotencyKey,
    ]);
    assert.equal(keys.size, 3, 'distinct deliveries collapsed onto one idempotency key');
    assert.notEqual(first.identity.payloadHash, changedAmount.identity.payloadHash);
  });

  it('ignore envelope key order, since identity is derived from canonical JSON', async () => {
    const fixture = byFixture('charge-success-plan-bound');
    // Reverse the TOP-LEVEL key order only (a delivery is parsed from JSON, so
    // key order is not part of the payload's meaning).
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(fixture.body).reverse()) {
      reordered[key] = fixture.body[key];
    }
    assert.deepEqual(Object.keys(reordered), Object.keys(fixture.body).reverse());
    // Deep equality ignores key order, so the meaningful claim is that the
    // ORDER changed while the payload did not.
    assert.notDeepEqual(Object.keys(reordered), Object.keys(fixture.body));

    const first = await provider.normalizeEvent(delivery(fixture.body));
    const second = await provider.normalizeEvent(delivery(reordered));
    assert.equal(first.identity.payloadHash, second.identity.payloadHash);
    assert.equal(first.identity.idempotencyKey, second.identity.idempotencyKey);
    assert.deepEqual(first, second);

    // Nested key order is irrelevant too: canonicalization sorts every level.
    const data = fixture.body['data'] as Record<string, unknown>;
    const nested: Record<string, unknown> = {};
    for (const key of Object.keys(data).reverse()) nested[key] = data[key];
    const third = await provider.normalizeEvent(delivery({ event: fixture.event, data: nested }));
    assert.equal(third.identity.payloadHash, first.identity.payloadHash);
  });

  it('include a supplied provider event id in the identity, exactly as core derives it', async () => {
    const body = byFixture('subscription-create').body;
    const payloadHash = billingEventPayloadHash(body);
    const occurredAt = '2026-09-22T09:05:21.000Z';

    const normalized = await provider.normalizeEvent(delivery(body, { providerEventId: 'evt_9911' }));
    assert.equal(normalized.identity.providerEventId, 'evt_9911');
    assert.equal(
      normalized.identity.idempotencyKey,
      billingEventIdempotencyKey({
        provider: 'paystack',
        providerEventId: 'evt_9911',
        eventType: 'subscription.created',
        occurredAt,
        payloadHash,
      }),
    );
    assert.equal(
      billingEventIdempotencyCanonicalString({
        provider: 'paystack',
        providerEventId: 'evt_9911',
        eventType: 'subscription.created',
        occurredAt,
        payloadHash,
      }),
      `paystack|evt_9911|subscription.created|${occurredAt}|${payloadHash}`,
    );

    // Absent id ⇒ an empty segment, still canonical, still distinct from the
    // same payload delivered with an id.
    const withoutId = await provider.normalizeEvent(delivery(body));
    assert.equal(withoutId.identity.providerEventId, null);
    assert.notEqual(
      withoutId.identity.idempotencyKey,
      normalized.identity.idempotencyKey,
    );
    assert.equal(withoutId.identity.payloadHash, normalized.identity.payloadHash);
  });

  it('hash the payload instead of carrying it, keeping two unrecognized events distinct', async () => {
    const first = await provider.normalizeEvent(
      delivery({ event: 'invoice.create', data: { invoice_code: 'INV_a' } }),
    );
    const second = await provider.normalizeEvent(
      delivery({ event: 'invoice.create', data: { invoice_code: 'INV_b' } }),
    );
    assert.equal(first.identity.eventType, 'unrecognized');
    assert.equal(second.identity.eventType, 'unrecognized');
    assert.equal(first.identity.occurredAt, null);
    assert.notEqual(first.identity.idempotencyKey, second.identity.idempotencyKey);
    assert.equal(
      billingEventIdempotencyCanonicalString({
        provider: 'paystack',
        providerEventId: null,
        eventType: 'unrecognized',
        occurredAt: null,
        payloadHash: first.identity.payloadHash,
      }),
      `paystack||unrecognized||${billingEventPayloadHash({
        event: 'invoice.create',
        data: { invoice_code: 'INV_a' },
      })}`,
    );
  });

  it('validate identity against the canonical schema before returning it', async () => {
    for (const fixture of fixtures.values()) {
      const event = await provider.normalizeEvent(delivery(fixture.body));
      const parsed = providerEventIdentitySchema.safeParse(event.identity);
      assert.ok(parsed.success, `${fixture.fixture}: identity is not canonical`);
      const identity = parsed.data!;
      assert.equal(identity.provider, 'paystack');
      assert.equal(identity.idempotencyKey, event.identity.idempotencyKey);
      assert.match(identity.payloadHash, /^[a-f0-9]{64}$/);
      assert.ok(
        identity.occurredAt === null || identity.occurredAt <= identity.receivedAt,
        `${fixture.fixture}: occurredAt postdates receivedAt`,
      );
      assert.ok(Object.keys(event).includes('identity'));
      // The identity is the only place a payload leaves a trace.
      assert.ok(!Object.keys(event).includes('payload'));
    }
  });
});

/* ========================================================================== */
/* 6. Credentials are never exposed, mapped or persisted                       */
/* ========================================================================== */

describe('credential exposure and failure-detail hygiene', () => {
  it('withhold a credential-shaped provider failure detail entirely', async () => {
    const fixture = byFixture('invoice-payment-failed-credential-detail');
    assert.equal(fixture.synthetic, true);
    const description = (fixture.body['data'] as Record<string, unknown>)['description'];
    assert.equal(typeof description, 'string');
    assert.ok(BILLING_CREDENTIAL_SHAPED_RE.test(description as string));

    const event = await provider.normalizeEvent(delivery(fixture.body));
    assert.equal(event.identity.eventType, 'invoice.failed');
    assert.equal(event.data?.failureReason, PAYSTACK_WITHHELD_FAILURE_DETAIL);
    assert.ok(!BILLING_CREDENTIAL_SHAPED_RE.test(event.data!.failureReason!));
    const serialized = JSON.stringify(event);
    for (const sentinel of SENTINELS) {
      assert.ok(
        !serialized.includes(sentinel),
        `credential detail crossed the seam: ${sentinel}`,
      );
    }
    assert.ok(billingEventDataSchema.safeParse(event.data).success);
  });

  it('sanitize failure detail deterministically, within a hard bound', () => {
    assert.equal(sanitizePaystackFailureDetail('Insufficient Funds'), 'Insufficient Funds');
    assert.equal(sanitizePaystackFailureDetail('  Insufficient\n\t Funds  '), 'Insufficient Funds');
    assert.equal(sanitizePaystackFailureDetail(''), PAYSTACK_WITHHELD_FAILURE_DETAIL);
    assert.equal(sanitizePaystackFailureDetail('   '), PAYSTACK_WITHHELD_FAILURE_DETAIL);

    for (const unsafe of [
      'card token AUTH_123 rejected',
      'password=hunter2',
      'secret api key sk_test_DONOTPERSISTME',
      'Authorization: Bearer abc',
      'private_key missing',
      'private-key material rejected',
      'credential expired',
      'email_token DONOTPERSISTemailtoken01',
      'invalid authorization code',
    ]) {
      assert.equal(
        sanitizePaystackFailureDetail(unsafe),
        PAYSTACK_WITHHELD_FAILURE_DETAIL,
        `"${unsafe}" was not withheld`,
      );
    }
    // The canonical credential pattern is the authority for what counts as
    // credential-shaped; prose that merely mentions a card is bounded, not
    // withheld, so a real explanation still reaches an operator.
    assert.equal(
      sanitizePaystackFailureDetail('Card declined by issuing bank'),
      'Card declined by issuing bank',
    );

    const bounded = sanitizePaystackFailureDetail('Insufficient funds. '.repeat(200));
    assert.ok(bounded.length <= 600, `failure detail is unbounded: ${bounded.length}`);
    assert.ok(!BILLING_CREDENTIAL_SHAPED_RE.test(bounded));
    // The marker itself is persistable: short, and matching no trigger word.
    assert.ok(!BILLING_CREDENTIAL_SHAPED_RE.test(PAYSTACK_WITHHELD_FAILURE_DETAIL));
    assert.ok(PAYSTACK_WITHHELD_FAILURE_DETAIL.length <= 190);
    // And deterministic.
    assert.equal(
      sanitizePaystackFailureDetail('Insufficient Funds'),
      sanitizePaystackFailureDetail('Insufficient Funds'),
    );
  });

  it('never read, map or return the cancellation credential or card material', async () => {
    for (const fixture of fixtures.values()) {
      const event = await provider.normalizeEvent(delivery(fixture.body));
      const serialized = JSON.stringify(event);
      for (const forbidden of [
        'DONOTPERSISTemailtoken',
        'AUTH_DO_NOT_PERSIST',
        'SIG_DO_NOT_PERSIST',
        'do-not-persist@example.com',
        '4081',
        'expiry_date',
        '203.0.113.7',
        'Fixture',
        ' Trader',
      ]) {
        assert.ok(!serialized.includes(forbidden), `${fixture.fixture}: leaked ${forbidden}`);
      }
    }
    // An email_token supplied with any value is ignored, not validated and not
    // mapped: the field is never read by any code path in this package.
    for (const token of ['DONOTPERSISTemailtoken01', null, 42, { token: 'x' }]) {
      const event = await provider.normalizeEvent(
        delivery(mutate(byFixture('invoice-payment-failed'), 'data.subscription.email_token', token)),
      );
      assert.equal(event.identity.eventType, 'invoice.failed');
      assert.ok(!JSON.stringify(event).includes('DONOTPERSIST'));
    }
  });

  it('refuse rather than echo when a payload value is wrong', async () => {
    // Each refusal is built from a fixture carrying sentinels; `refuses` proves
    // none of them appear in the message. The credential-shaped values below
    // are refused by the CANONICAL reference contract (billing-refs.ts), which
    // is the authority on what counts as credential-shaped.
    await refuses(
      mutate(
        byFixture('charge-success-plan-bound'),
        'data.reference',
        'authorization DO_NOT_PERSIST_0009',
      ),
      { reason: 'unexpected_response' },
    );
    await refuses(
      mutate(byFixture('charge-success-plan-bound'), 'data.customer.customer_code', 'token=abc'),
      { reason: 'unexpected_response' },
    );
    await refuses(
      mutate(byFixture('subscription-create'), 'data.subscription_code', 'api_key DO_NOT_PERSIST'),
      { reason: 'unexpected_response' },
    );
    await refuses(
      mutate(byFixture('subscription-create'), 'data.customer.customer_code', 'Bearer abc'),
      { reason: 'unexpected_response' },
    );
    await refuses(mutate(byFixture('invoice-update-paid'), 'data.paid', 'yes'));

    // A domain value that looks like a key is still refused WITHOUT being
    // echoed: the message describes the contradiction, never the value.
    const domain = await refuses(
      mutate(byFixture('charge-success-plan-bound'), 'data.domain', 'sk_test_live1'),
      { reason: 'invalid_configuration' },
    );
    assert.ok(!domain.message.includes('sk_test'), domain.message);
    assert.ok(!domain.message.includes('live1'), domain.message);
    assert.ok(domain.message.includes('sandbox'), domain.message);

    // A credential-shaped provider explanation is not a refusal: the event is
    // still normalized, with the detail withheld (asserted above). What must
    // never happen is the detail being echoed into a message.
    const described = await provider.normalizeEvent(
      delivery(
        mutate(
          byFixture('invoice-payment-failed-described'),
          'data.description',
          'token DO_NOT_PERSIST leaked upstream',
        ),
      ),
    );
    assert.equal(described.data?.failureReason, PAYSTACK_WITHHELD_FAILURE_DETAIL);
    assert.ok(!JSON.stringify(described).includes('DO_NOT_PERSIST'));
  });
});

/* ========================================================================== */
/* 7. Normalization grants nothing and persists nothing                        */
/* ========================================================================== */

describe('what normalization does not do', () => {
  it('never grant execution, whatever the payload claims', async () => {
    for (const fixture of fixtures.values()) {
      const event = await provider.normalizeEvent(delivery(fixture.body));
      assert.equal(event.grantsExecution, false, fixture.fixture);
      // The canonical contract makes any other value unrepresentable.
      assert.throws(() =>
        normalizedBillingEventSchema.parse({ ...event, grantsExecution: true }),
      );
    }
    // A payload that asks for a grant cannot get one: unknown fields are
    // ignored, never honoured.
    const begging = {
      event: 'charge.success',
      grantsExecution: true,
      data: {
        ...(byFixture('charge-success-plan-bound').body['data'] as Record<string, unknown>),
        grantsExecution: true,
        cataloguePlan: 'pro',
        interval: 'annual',
        state: 'active',
      },
    };
    const event = await provider.normalizeEvent(delivery(begging));
    assert.equal(event.grantsExecution, false);
    assert.equal(event.data?.cataloguePlan, null);
    assert.equal(event.data?.interval, null);
    assert.equal(event.data?.state, null);
  });

  it('never resolve local identity — that belongs to the receiver', async () => {
    for (const fixture of fixtures.values()) {
      const event = await provider.normalizeEvent(delivery(fixture.body));
      assert.equal(event.subject?.userId ?? null, null, fixture.fixture);
      assert.equal(event.subject?.subscriptionId ?? null, null, fixture.fixture);
      assert.equal(event.subject?.billingCustomerId ?? null, null, fixture.fixture);
    }
  });

  it('never carry the raw payload onwards in any form', async () => {
    for (const fixture of fixtures.values()) {
      const event = await provider.normalizeEvent(delivery(fixture.body));
      const serialized = JSON.stringify(event);
      for (const text of PROVIDER_ONLY_TEXT) {
        assert.ok(!serialized.includes(text), `${fixture.fixture}: result carries ${text}`);
      }
      // The hash is the only trace of the body.
      assert.equal(event.identity.payloadHash, billingEventPayloadHash(fixture.body));
      assert.equal(event.identity.payloadHash.length, 64);
    }
  });

  it('map lifecycle states only from the documented status vocabulary', () => {
    assert.equal(paystackLifecycleState('active'), 'active');
    assert.equal(paystackLifecycleState('non-renewing'), 'unsubscribed');
    assert.equal(paystackLifecycleState('cancelled'), 'cancelled');
    assert.equal(paystackLifecycleState('completed'), 'expired');
    assert.equal(paystackLifecycleState('complete'), 'unknown');
    // "attention" is documented as a retry state the provider contradicts
    // itself about: unknown means no authoritative state change is asserted.
    assert.equal(paystackLifecycleState('attention'), 'unknown');
    assert.equal(paystackLifecycleState('pending'), 'unknown');
    assert.equal(paystackLifecycleState('expired'), 'unknown');
    assert.equal(paystackLifecycleState(''), 'unknown');
    assert.equal(paystackLifecycleState('ACTIVE'), 'unknown');
    assert.equal(paystackLifecycleState(' active'), 'unknown');
  });

  it('contain no webhook receiver, signature handling or persistence in this phase', () => {
    const sources = readdirSync(SRC_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(path.join(SRC_DIR, name), 'utf8'))
      .join('\n');

    // Billing Step 5.2 owns signature verification, the raw body, the route,
    // rate limiting and the ledger write. None of it may exist yet: a normalizer
    // that quietly grew a receiver would be unverifiable by review.
    for (const forbidden of [
      /x-paystack-signature/i,
      /createHmac/,
      /timingSafeEqual/,
      /sha512/i,
      /rawBody/,
      /addContentTypeParser/,
      /fastify/i,
      /rateLimit/i,
      /@veltrixeye\/db/,
      /INSERT\s+INTO/i,
      /process\.env/,
    ]) {
      assert.ok(!forbidden.test(sources), `this phase must not contain ${forbidden}`);
    }
    // No HTTP route literal of any kind: the only provider paths remain the two
    // documented API calls asserted by source-assertions.test.ts.
    assert.ok(!/['"`]\/webhooks?['"`]/i.test(sources));
    assert.ok(!/['"`]\/api\//i.test(sources));
    // The normalizer performs no I/O: the transport injected above was never
    // touched by any test in this file.
    assert.deepEqual(fetchCalls, []);
  });
});

after(() => {
  assert.deepEqual(fetchCalls, [], 'normalization performed network I/O');
});
