/**
 * Paystack adapter — LIVE provider-domain mode (the mode-aware half of
 * migration 0035's application support).
 *
 * Everything here runs against injected stub transports: no socket, no
 * network, no real credential (the keys below are the same synthetic shapes
 * the test suite has always used).
 *
 * What this suite pins:
 *
 *  1. CONSTRUCTION — `mode: 'live'` requires an `sk_live_` key (and rejects
 *     `sk_test_`), `mode: 'test'` (the default) keeps refusing live keys with
 *     the original sandbox-only message, `describe()` reports the configured
 *     mode without ever carrying the key, and the honest `live: false`
 *     execution posture is unchanged in BOTH modes.
 *  2. DOMAIN GUARDS — verify/find accept the configured domain and refuse the
 *     other one in both directions; the test-mode messages keep their
 *     sandbox-only wording byte-for-byte.
 *  3. EVENTS — a live-mode adapter normalizes live-domain deliveries and
 *     refuses test-domain ones (and vice versa for the default).
 *  4. PLAN AUTHORIZATION — a live adapter states `mode: 'live'` in its
 *     expectation, so a test epoch can never authorize a live checkout (and
 *     the default test adapter still refuses live epochs, pinned elsewhere).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BILLING_CATALOGUE_VERSION, type BillingPricingSnapshot } from '@veltrixeye/contracts';
import { priceCommercialPlan, type BillingProviderPlan } from '@veltrixeye/core';
import {
  PAYSTACK_LIVE,
  PAYSTACK_LIVE_KEY_PREFIX,
  PAYSTACK_TEST_KEY_PREFIX,
  PaystackClient,
  createPaystackProvider,
  isPaystackAdapterError,
  type PaystackFetchFn,
} from '../src/index.js';

const TEST_KEY = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const LIVE_KEY = 'sk_live_notarealkey01';
const USER_ID = '1f000000-0000-4000-8000-000000000001';
const REFERENCE = `ve-chk-${'ab'.repeat(32)}`;
const OBSERVED_AT = new Date('2026-09-24T10:00:00.000Z');
const SUBSCRIPTION_CODE = 'SUB_vsyqdmlzble3uii';
const EMAIL_TOKEN = 'd7gofp6yppn3qz7';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type StubResponse = { status: number; body: unknown } | { throws: true } | { unreadable: number };

function stub(responses: StubResponse[]): { fetchFn: PaystackFetchFn; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetchFn: PaystackFetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const response = responses[index] ?? responses[responses.length - 1]!;
    index += 1;
    if ('throws' in response) throw new Error('socket hang up');
    if ('unreadable' in response) {
      return { status: response.unreadable, json: async () => { throw new Error('not json'); } };
    }
    return { status: response.status, json: async () => response.body };
  };
  return { fetchFn, calls };
}

const reason = (expected: string) => (error: unknown) => {
  assert.ok(isPaystackAdapterError(error), `expected a PaystackAdapterError, got ${String(error)}`);
  assert.equal(error.reason, expected, `expected ${expected}, got ${error.reason}: ${error.message}`);
  return true;
};

/* ========================================================================== */
/* 1. Construction                                                            */
/* ========================================================================== */

describe('Paystack live mode — construction matrix', () => {
  test('the default stays test: sk_test_ accepted, sk_live_ refused with the original message', () => {
    const client = new PaystackClient({ secretKey: TEST_KEY, timeoutMs: 2000 });
    assert.equal(client.mode, 'test');
    assert.equal(client.expectedDomain, 'test');
    assert.deepEqual(client.describe(), {
      provider: 'paystack',
      baseUrl: 'https://api.paystack.co',
      mode: 'test',
      live: false,
      timeoutMs: 2000,
    });
    assert.throws(
      () => new PaystackClient({ secretKey: LIVE_KEY, timeoutMs: 2000 }),
      /Only sandbox \(test-mode\) Paystack credentials are accepted by this build/,
      'the test-mode key refusal keeps its exact sandbox-only wording',
    );
    assert.throws(
      () => new PaystackClient({ secretKey: '', timeoutMs: 2000 }),
      /Paystack is not configured: a sandbox test secret key is required\./,
    );
  });

  test('live mode requires an sk_live_ key and rejects test keys and empties', () => {
    const client = new PaystackClient({ secretKey: LIVE_KEY, timeoutMs: 1500, mode: 'live' });
    assert.equal(client.mode, 'live');
    assert.equal(client.expectedDomain, 'live');
    assert.deepEqual(client.describe(), {
      provider: 'paystack',
      baseUrl: 'https://api.paystack.co',
      mode: 'live',
      live: false,
      timeoutMs: 1500,
    });

    assert.throws(
      () => new PaystackClient({ secretKey: TEST_KEY, timeoutMs: 2000, mode: 'live' }),
      /Only live-mode Paystack credentials are accepted when mode is live/,
      'a test key in live mode is a configuration failure, never a fallback',
    );
    assert.throws(
      () => new PaystackClient({ secretKey: '', timeoutMs: 2000, mode: 'live' }),
      /Paystack is not configured: a live secret key is required\./,
    );
    assert.throws(
      () => new PaystackClient({ secretKey: 'sk_live_   ', timeoutMs: 2000, mode: 'live' }),
      /The configured Paystack live key is empty\./,
    );
  });

  test('the key vocabulary and the execution posture are pinned', () => {
    assert.equal(PAYSTACK_TEST_KEY_PREFIX, 'sk_test_');
    assert.equal(PAYSTACK_LIVE_KEY_PREFIX, 'sk_live_');
    assert.equal(PAYSTACK_LIVE, false, 'billing is never an execution path, in either mode');
  });

  test('the adapter names the configured domain and still claims no execution', () => {
    const sandbox = createPaystackProvider({
      secretKey: TEST_KEY, timeoutMs: 2000, fetchFn: async () => { throw new Error('idle'); },
      customers: { find: async () => null }, plans: { find: async () => null },
    });
    assert.equal(sandbox.name, 'paystack-sandbox');
    assert.equal(sandbox.mode, 'test');
    assert.equal(sandbox.live, false);
    assert.equal(sandbox.describe().mode, 'test');

    const live = createPaystackProvider({
      secretKey: LIVE_KEY, timeoutMs: 2000, mode: 'live',
      fetchFn: async () => { throw new Error('idle'); },
      customers: { find: async () => null }, plans: { find: async () => null },
    });
    assert.equal(live.name, 'paystack-live');
    assert.equal(live.mode, 'live');
    assert.equal(live.live, false, 'mode never turns billing into an execution path');
    assert.equal(live.implemented, false);
    const described = live.describe();
    assert.equal(described.mode, 'live');
    assert.equal(described.live, false);
    assert.equal(JSON.stringify(described).includes('sk_live_'), false, 'describe never carries the key');
  });
});

/* ========================================================================== */
/* 2. Verify + find domain guards (both directions)                           */
/* ========================================================================== */

/** The documented verify sample, trimmed to the fields the read documents. */
function verifiedData(overrides: Record<string, unknown> = {}) {
  return {
    id: 4099260516,
    domain: 'live',
    status: 'success',
    reference: REFERENCE,
    amount: 48_750,
    message: null,
    gateway_response: 'Successful',
    paid_at: '2026-09-24T09:15:02.000Z',
    created_at: '2026-09-24T09:14:24.000Z',
    channel: 'card',
    currency: 'GHS',
    ip_address: '197.210.54.33',
    metadata: '',
    fees: 731,
    authorization: {
      authorization_code: 'AUTH_uh8bcl3zbn',
      bin: '408408',
      last4: '4081',
      exp_month: '12',
      exp_year: '2030',
      reusable: true,
      signature: 'SIG_yEXu7dLBeqG0kU7g95Ke',
    },
    customer: {
      id: 181873746,
      first_name: null,
      last_name: null,
      email: 'demo@test.com',
      customer_code: 'CUS_1rkzaqsv4rrhqo6',
      phone: null,
      metadata: null,
      risk_action: 'default',
    },
    plan: null,
    plan_object: {},
    ...overrides,
  };
}

const ok = (data: unknown) => ({ status: 200, body: { status: true, message: 'ok', data } });

function liveProvider(responses: StubResponse[]) {
  const t = stub(responses);
  const adapter = createPaystackProvider({
    secretKey: LIVE_KEY,
    timeoutMs: 2000,
    mode: 'live',
    fetchFn: t.fetchFn,
    clock: () => OBSERVED_AT,
    customers: { find: async () => ({ email: 'demo@test.com', providerCustomerCode: 'CUS_1rkzaqsv4rrhqo6' }) },
    plans: { find: async () => null },
  });
  return { calls: t.calls, adapter };
}

describe('Paystack live mode — the verify read is domain-scoped', () => {
  test('a live-domain verification is accepted by a live adapter', async () => {
    const { adapter, calls } = liveProvider([ok(verifiedData())]);
    const state = await adapter.verifySubscription({
      provider: 'paystack',
      userId: USER_ID,
      providerReference: REFERENCE,
      idempotencyKey: 'c'.repeat(64),
      requestedAt: '2026-09-24T09:59:00.000Z',
    });
    assert.equal(calls.length, 1);
    assert.equal(state.providerReference, REFERENCE);
    assert.equal(state.providerCustomerId, '181873746');
  });

  test('a test-domain verification is refused by a live adapter', async () => {
    const { adapter, calls } = liveProvider([ok(verifiedData({ domain: 'test' }))]);
    await assert.rejects(
      () => adapter.verifySubscription({
        provider: 'paystack',
        userId: USER_ID,
        providerReference: REFERENCE,
        idempotencyKey: 'c'.repeat(64),
        requestedAt: '2026-09-24T09:59:00.000Z',
      }),
      reason('response_conflict'),
    );
    assert.equal(calls.length, 1, 'the read happened; the DOMAIN is what refused');
  });
});

/* ========================================================================== */
/* 3. Find-subscription domain guards                                         */
/* ========================================================================== */

function subscriptionData(overrides: Record<string, unknown> = {}) {
  return {
    id: 292646,
    domain: 'live',
    status: 'active',
    subscription_code: SUBSCRIPTION_CODE,
    email_token: EMAIL_TOKEN,
    amount: 48_750,
    quantity: 1,
    start: 1459296064,
    next_payment_date: '2026-10-24T07:00:00.000Z',
    open_invoice: null,
    cron_expression: '0 0 28 * *',
    easy_cron_id: null,
    invoices: [],
    integration: 100032,
    authorization: {
      authorization_code: 'AUTH_6tmt288t0o',
      bin: '408408',
      last4: '4081',
      exp_month: '12',
      exp_year: '2030',
      reusable: true,
      signature: 'SIG_uSYN4fv1adlAuoij8QXh',
    },
    customer: {
      id: 178433,
      customer_code: 'CUS_1rkzaqsv4rrhqo6',
      email: 'demo@test.com',
      domain: 'live',
    },
    plan: {
      id: 100971,
      plan_code: 'PLN_gx2wn530m0i3w3m',
      name: 'Monthly retainer',
      amount: 48_750,
      currency: 'GHS',
      interval: 'monthly',
      domain: 'live',
    },
    createdAt: '2026-09-24T10:34:57.000Z',
    updatedAt: '2026-09-24T10:34:57.000Z',
    ...overrides,
  };
}

describe('Paystack live mode — the subscription read is domain-scoped', () => {
  test('a live-domain subscription is accepted by a live adapter', async () => {
    const { adapter } = liveProvider([ok(subscriptionData())]);
    const state = await adapter.findSubscription({
      provider: 'paystack',
      userId: USER_ID,
      providerSubscriptionId: SUBSCRIPTION_CODE,
    });
    assert.ok(state !== null);
    assert.equal(state.providerSubscriptionCode, SUBSCRIPTION_CODE);
  });

  test('a test-domain subscription is refused by a live adapter', async () => {
    const { adapter } = liveProvider([ok(subscriptionData({ domain: 'test' }))]);
    await assert.rejects(
      () => adapter.findSubscription({
        provider: 'paystack',
        userId: USER_ID,
        providerSubscriptionId: SUBSCRIPTION_CODE,
      }),
      reason('response_conflict'),
    );
  });
});

/* ========================================================================== */
/* 4. Event normalization is domain-scoped                                    */
/* ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const chargeFixture = JSON.parse(
  readFileSync(path.join(HERE, 'fixtures', 'webhook', 'charge-success-plan-bound.json'), 'utf8'),
) as { body: Record<string, unknown> };

describe('Paystack live mode — webhook normalization is domain-scoped', () => {
  const idle: PaystackFetchFn = async () => {
    throw new Error('normalizeEvent must not perform I/O');
  };
  const liveAdapter = createPaystackProvider({
    secretKey: LIVE_KEY, timeoutMs: 2000, mode: 'live', fetchFn: idle,
    clock: () => OBSERVED_AT,
    customers: { find: async () => null }, plans: { find: async () => null },
  });
  const delivery = (payload: unknown) => ({
    provider: 'paystack' as const,
    payload,
    providerEventId: null,
    receivedAt: '2026-09-24T11:00:00.000Z',
  });

  test('a live-domain delivery normalizes in live mode', async () => {
    const body = structuredClone(chargeFixture.body);
    const data = body.data as Record<string, unknown>;
    assert.equal(typeof data.domain, 'string', 'the fixture carries a domain');
    data.domain = 'live';
    const event = await liveAdapter.normalizeEvent(delivery(body));
    assert.equal(event.identity.eventType, 'payment.succeeded');
    assert.equal(event.grantsExecution, false);
  });

  test('a test-domain delivery is refused in live mode, without echoing the value', async () => {
    const body = structuredClone(chargeFixture.body);
    const data = body.data as Record<string, unknown>;
    data.domain = 'test';
    let caught: unknown;
    try {
      await liveAdapter.normalizeEvent(delivery(body));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught !== null && isPaystackAdapterError(caught), `expected a PaystackAdapterError: ${String(caught)}`);
    assert.equal(caught.reason, 'invalid_configuration');
    assert.ok(caught.message.includes('live domain'), caught.message);
    assert.equal(caught.message.includes('sk_test'), false, 'the refusal never echoes payload material');
  });
});

/* ========================================================================== */
/* 5. Plan authorization states the configured mode                           */
/* ========================================================================== */

const FX_VERSION_ID = '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01';
const CAPTURED_AT = '2026-09-22T09:00:00.000Z';
const AS_OF = new Date('2026-09-22T09:05:00.000Z');

function snapshot(providerPlanId: string): BillingPricingSnapshot {
  return priceCommercialPlan({
    planId: 'pro',
    interval: 'monthly',
    fx: {
      baseCurrency: 'USD',
      quoteCurrency: 'GHS',
      fxRateScaled: 12_500_000,
      fxRateScale: 6,
      fxRateVersionId: FX_VERSION_ID,
      fxRateEffectiveFrom: CAPTURED_AT,
      fxRateCapturedAt: CAPTURED_AT,
      fxRateSource: 'ops',
      roundingMode: 'half_up',
    },
    asOf: AS_OF,
    providerPlanId,
    providerReference: 've-chk-0001',
  });
}

const epochFor = (s: BillingPricingSnapshot, mode: 'test' | 'live'): BillingProviderPlan => ({
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'paystack',
  mode,
  cataloguePlan: s.cataloguePlan,
  interval: s.interval,
  paymentCurrency: s.payment.paymentCurrency,
  paymentAmountMinor: BigInt(s.payment.paymentAmountMinor),
  paymentAmountExponent: s.payment.paymentAmountExponent,
  providerPlanId: s.providerPlanId ?? 'PLN_pro_monthly',
  providerPlanReference: null,
  fxRateVersionId: s.fx.fxRateVersionId,
  pricingPolicyVersion: s.pricingPolicyVersion,
  catalogueVersion: BILLING_CATALOGUE_VERSION,
  status: 'active',
  validFrom: new Date('2026-09-22T09:00:00.000Z'),
  retiredAt: null,
});

describe('Paystack live mode — the plan epoch must be in the configured mode', () => {
  const checkout = (epoch: BillingProviderPlan | null) => {
    const t = stub([{
      status: 200,
      body: {
        status: true,
        data: { authorization_url: 'https://checkout.paystack.com/authorize', reference: 've-chk-0001' },
      },
    }]);
    const provider = createPaystackProvider({
      secretKey: LIVE_KEY, timeoutMs: 2000, mode: 'live', fetchFn: t.fetchFn,
      clock: () => new Date('2026-09-22T09:10:00.000Z'),
      customers: { find: async () => ({ email: 'trader@example.com', providerCustomerCode: 'CUS_abc' }) },
      plans: { find: async () => epoch },
    });
    const s = snapshot('PLN_pro_monthly');
    const request = {
      provider: 'paystack' as const,
      userId: USER_ID,
      plan: { cataloguePlan: s.cataloguePlan, interval: s.interval },
      reference: 've-chk-0001',
      pricing: s,
      idempotencyKey: 'a'.repeat(64),
      callbackUrl: 'https://app.example.com/billing/callback',
      requestedAt: '2026-09-22T09:05:00.000Z',
    };
    return { provider, request, calls: t.calls };
  };

  test('a test epoch can never authorize a live checkout', async () => {
    const { provider, request, calls } = checkout(epochFor(snapshot('PLN_pro_monthly'), 'test'));
    await assert.rejects(() => provider.initializeCheckout(request), reason('plan_mismatch'));
    assert.equal(calls.length, 0, 'the provider is never called without a matching epoch');
  });

  test('a live epoch in the live mode proceeds to the provider', async () => {
    const { provider, request, calls } = checkout(epochFor(snapshot('PLN_pro_monthly'), 'live'));
    const session = await provider.initializeCheckout(request);
    assert.equal(calls.length, 1);
    assert.equal(session.status, 'initialized');
    assert.equal(session.reference, 've-chk-0001');
  });
});
