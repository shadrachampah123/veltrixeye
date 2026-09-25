/**
 * Later-billing-PR #7 — the documented transaction-verify READ.
 *
 * Client: `GET /transaction/verify/:reference`, documented fields only, one
 * attempt, typed fail-closed errors, nothing retained.
 * Provider: `verifySubscription` built on that read. The published verify
 * response carries NO subscription status, so the canonical lifecycle state is
 * always `unknown` (manual review) — a transaction status is never promoted to
 * a subscription state. `findSubscription` stays refused.
 *
 * Every call goes through an injected stub transport: no socket is opened.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { providerSubscriptionStateSchema } from '@veltrixeye/contracts';
import {
  PAYSTACK_IMPLEMENTED_OPERATIONS,
  PAYSTACK_LIFECYCLE_STATE_FOR_STATUS,
  PAYSTACK_VERIFIED_TRANSACTION_LIFECYCLE_STATE,
  PaystackClient,
  PaystackNotImplementedError,
  createPaystackProvider,
  isPaystackAdapterError,
  type PaystackFetchFn,
} from '../src/index.js';

const TEST_KEY = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const USER_ID = '1f000000-0000-4000-8000-000000000001';
const REFERENCE = `ve-chk-${'ab'.repeat(32)}`;
const OBSERVED_AT = new Date('2026-09-24T10:00:00.000Z');

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

/** The provider's documented sample, trimmed to a representative field set. */
function verifiedData(overrides: Record<string, unknown> = {}) {
  return {
    id: 4099260516,
    domain: 'test',
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

const ok = (data: unknown) => ({ status: 200, body: { status: true, message: 'Verification successful', data } });

const reason = (expected: string) => (error: unknown) => {
  assert.ok(isPaystackAdapterError(error), `expected a PaystackAdapterError, got ${String(error)}`);
  assert.equal(error.reason, expected, `expected ${expected}, got ${error.reason}: ${error.message}`);
  return true;
};

function client(responses: StubResponse[]) {
  const t = stub(responses);
  return { calls: t.calls, adapter: new PaystackClient({ secretKey: TEST_KEY, timeoutMs: 2000, fetchFn: t.fetchFn }) };
}

function provider(responses: StubResponse[]) {
  const t = stub(responses);
  const adapter = createPaystackProvider({
    secretKey: TEST_KEY,
    timeoutMs: 2000,
    fetchFn: t.fetchFn,
    clock: () => OBSERVED_AT,
    customers: { find: async () => ({ email: 'demo@test.com', providerCustomerCode: 'CUS_1rkzaqsv4rrhqo6' }) },
    plans: { find: async () => null },
  });
  return { calls: t.calls, adapter };
}

const verifyRequest = (overrides: Record<string, unknown> = {}) => ({
  provider: 'paystack' as const,
  userId: USER_ID,
  providerReference: REFERENCE,
  idempotencyKey: 'c'.repeat(64),
  requestedAt: '2026-09-24T09:59:00.000Z',
  ...overrides,
});

/* ========================================================================== */
/* Client                                                                     */
/* ========================================================================== */

describe('Paystack client — verifyTransaction (documented read)', () => {
  test('sends exactly one GET to the documented path with the bearer key and no body', async () => {
    const { adapter, calls } = client([ok(verifiedData())]);
    const verified = await adapter.verifyTransaction(REFERENCE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.url, `https://api.paystack.co/transaction/verify/${REFERENCE}`);
    assert.equal(calls[0]!.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.equal(calls[0]!.body, undefined);
    assert.deepEqual(verified, {
      reference: REFERENCE,
      status: 'success',
      domain: 'test',
      amountMinor: 48_750,
      currency: 'GHS',
      providerCustomerId: '181873746',
      providerCustomerCode: 'CUS_1rkzaqsv4rrhqo6',
      paidAt: '2026-09-24T09:15:02.000Z',
      providerTransactionId: '4099260516',
    });
  });

  test('returns documented fields only: no card, authorization, email or metadata crosses back', async () => {
    const { adapter } = client([ok(verifiedData())]);
    const verified = await adapter.verifyTransaction(REFERENCE);
    const text = JSON.stringify(verified);
    for (const leaked of ['AUTH_', 'SIG_', '408408', '4081', 'demo@test.com', '197.210', 'gateway', 'fees']) {
      assert.ok(!text.includes(leaked), `verify result must not carry ${leaked}`);
    }
    assert.deepEqual(Object.keys(verified).sort(), [
      'amountMinor', 'currency', 'domain', 'paidAt', 'providerCustomerCode', 'providerCustomerId', 'providerTransactionId', 'reference', 'status',
    ]);
  });

  test('passes a transaction status through uninterpreted', async () => {
    for (const status of ['success', 'failed', 'abandoned', 'reversed', 'something-new']) {
      const { adapter } = client([ok(verifiedData({ status }))]);
      assert.equal((await adapter.verifyTransaction(REFERENCE)).status, status);
    }
  });

  test('refuses a reference outside the documented character set before any call', async () => {
    for (const bad of ['', '   ', '../customer', 'ref/with/slash', 'ref?x=1', 'ref#frag', 'ref with space', 'r'.repeat(191)]) {
      const { adapter, calls } = client([ok(verifiedData())]);
      await assert.rejects(() => adapter.verifyTransaction(bad), reason('invalid_request'));
      assert.equal(calls.length, 0, `no call for ${JSON.stringify(bad)}`);
    }
    // The documented characters are accepted (and the path segment is still
    // percent-encoded, so no character can reshape the request path).
    const { adapter, calls } = client([ok(verifiedData({ reference: 'Ab-1.2=3' }))]);
    await adapter.verifyTransaction('Ab-1.2=3');
    assert.equal(calls[0]!.url, 'https://api.paystack.co/transaction/verify/Ab-1.2%3D3');
  });

  test('a response missing a documented field, or carrying a wrong type, is a typed refusal', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['status missing', { status: undefined }],
      ['reference missing', { reference: undefined }],
      ['domain missing', { domain: undefined }],
      ['amount as string', { amount: '48750' }],
      ['amount as float', { amount: 487.5 }],
      ['currency missing', { currency: undefined }],
      ['customer missing', { customer: undefined }],
      ['customer not an object', { customer: 'CUS_x' }],
    ];
    for (const [label, overrides] of cases) {
      const data = verifiedData(overrides);
      for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete (data as Record<string, unknown>)[key];
      const { adapter } = client([ok(data)]);
      await assert.rejects(() => adapter.verifyTransaction(REFERENCE), reason('unexpected_response'), label);
    }
  });

  test('transport and provider failures are typed, one attempt, never a default', async () => {
    const matrix: Array<[StubResponse, string]> = [
      [{ throws: true }, 'provider_unavailable'],
      [{ status: 500, body: { status: false, message: 'Server error' } }, 'provider_unavailable'],
      [{ status: 400, body: { status: false, message: 'Transaction reference not found' } }, 'provider_rejected'],
      [{ status: 200, body: { status: false, message: 'Invalid' } }, 'provider_rejected'],
      [{ status: 404, body: { status: false, message: 'Transaction reference not found' } }, 'ambiguous_not_found'],
      [{ status: 404, body: { status: false, message: 'Unauthorized' } }, 'provider_rejected'],
      [{ unreadable: 404 }, 'ambiguous_not_found'],
      [{ unreadable: 200 }, 'unexpected_response'],
      [{ status: 200, body: { status: true, message: 'ok' } }, 'unexpected_response'],
    ];
    for (const [response, expected] of matrix) {
      const { adapter, calls } = client([response]);
      await assert.rejects(() => adapter.verifyTransaction(REFERENCE), reason(expected));
      assert.equal(calls.length, 1, `exactly one attempt for ${expected}`);
    }
  });

  test('a provider message never echoes the secret key', async () => {
    const { adapter } = client([{ status: 400, body: { status: false, message: `bad key ${TEST_KEY}` } }]);
    await assert.rejects(
      () => adapter.verifyTransaction(REFERENCE),
      (error: unknown) => isPaystackAdapterError(error) && !error.message.includes(TEST_KEY),
    );
  });
});

/* ========================================================================== */
/* Provider                                                                   */
/* ========================================================================== */

describe('Paystack provider — verifySubscription via transaction verify', () => {
  test('is implemented, while findSubscription stays refused without any call', async () => {
    assert.ok(PAYSTACK_IMPLEMENTED_OPERATIONS.includes('verifySubscription'));
    assert.ok(!PAYSTACK_IMPLEMENTED_OPERATIONS.includes('findSubscription'));
    const { adapter, calls } = provider([ok(verifiedData())]);
    assert.equal(adapter.implemented, false, 'capability reporting stays honest');
    assert.equal(adapter.live, false);
    await assert.rejects(
      () => adapter.findSubscription({ provider: 'paystack', userId: USER_ID, providerSubscriptionId: 'SUB_x' }),
      PaystackNotImplementedError,
    );
    assert.equal(calls.length, 0);
  });

  test('a verified sandbox transaction normalizes to a canonical state that is ALWAYS unknown', async () => {
    const { adapter, calls } = provider([ok(verifiedData())]);
    const state = await adapter.verifySubscription(verifyRequest());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://api.paystack.co/transaction/verify/${REFERENCE}`);
    assert.deepEqual(providerSubscriptionStateSchema.parse(state), state, 'canonical .strict() contract');
    assert.deepEqual(state, {
      provider: 'paystack',
      state: 'unknown',
      providerSubscriptionId: null,
      providerSubscriptionCode: null,
      providerCustomerId: '181873746',
      providerCustomerCode: 'CUS_1rkzaqsv4rrhqo6',
      providerPlanId: null,
      providerReference: REFERENCE,
      cataloguePlan: null,
      interval: null,
      currency: null,
      payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      cancelledAt: null,
      cancellationReason: null,
      sourceEventIdempotencyKey: null,
      observedAt: OBSERVED_AT.toISOString(),
      paidAt: '2026-09-24T09:15:02.000Z',
      providerTransactionId: '4099260516',
      providerTransactionStatus: 'success',
    });
    assert.equal(PAYSTACK_VERIFIED_TRANSACTION_LIFECYCLE_STATE, 'unknown');
  });

  test('no transaction status — documented or not — is promoted to a subscription state', async () => {
    // Includes every documented SUBSCRIPTION status: even if a transaction
    // reported one of those strings, it is not a subscription status here.
    const statuses = ['success', 'failed', 'abandoned', 'reversed', 'pending', 'ongoing', 'queued', ...Object.keys(PAYSTACK_LIFECYCLE_STATE_FOR_STATUS), 'attention', ''];
    for (const status of statuses.filter((value) => value !== '')) {
      const { adapter } = provider([ok(verifiedData({ status }))]);
      const state = await adapter.verifySubscription(verifyRequest());
      assert.equal(state.state, 'unknown', `transaction status ${status} must not become a subscription state`);
      assert.equal(state.cancelledAt, null);
      assert.equal(state.cancellationReason, null);
      assert.equal(state.cancelAtPeriodEnd, false);
    }
  });

  test('refuses before any call without a checkout reference (no subscription read exists)', async () => {
    for (const request of [
      verifyRequest({ providerReference: undefined }),
      verifyRequest({ providerReference: null }),
      verifyRequest({ providerReference: undefined, providerSubscriptionId: 'SUB_abc' }),
    ]) {
      const { adapter, calls } = provider([ok(verifiedData())]);
      await assert.rejects(() => adapter.verifySubscription(request), reason('invalid_request'));
      assert.equal(calls.length, 0);
    }
  });

  test('refuses a non-canonical request before any call', async () => {
    for (const request of [
      verifyRequest({ provider: 'stripe' }),
      verifyRequest({ userId: 'not-a-uuid' }),
      verifyRequest({ idempotencyKey: 'short' }),
      verifyRequest({ extra: 'field' }),
    ]) {
      const { adapter, calls } = provider([ok(verifiedData())]);
      await assert.rejects(() => adapter.verifySubscription(request as never), reason('invalid_request'));
      assert.equal(calls.length, 0);
    }
  });

  test('a different echoed reference is a conflict, never this checkout', async () => {
    const { adapter } = provider([ok(verifiedData({ reference: 've-chk-other' }))]);
    await assert.rejects(() => adapter.verifySubscription(verifyRequest()), reason('reference_conflict'));
  });

  test('a non-sandbox domain is refused', async () => {
    for (const domain of ['live', 'LIVE', 'production']) {
      const { adapter } = provider([ok(verifiedData({ domain }))]);
      await assert.rejects(() => adapter.verifySubscription(verifyRequest()), reason('response_conflict'));
    }
  });

  test('an amount or currency this build does not understand is refused, never converted', async () => {
    for (const overrides of [{ currency: 'NGN' }, { currency: 'ghs' }, { amount: 0 }, { amount: -5 }]) {
      const { adapter } = provider([ok(verifiedData(overrides))]);
      await assert.rejects(() => adapter.verifySubscription(verifyRequest()), reason('unexpected_response'));
    }
  });

  test('credential-shaped provider identifiers never cross the seam', async () => {
    const { adapter } = provider([ok(verifiedData({ customer: { id: 1, customer_code: 'secret_token_value' } }))]);
    await assert.rejects(() => adapter.verifySubscription(verifyRequest()), reason('unexpected_response'));
  });

  test('client failures surface as typed errors (unknown outcome), after exactly one call', async () => {
    for (const [response, expected] of [
      [{ throws: true }, 'provider_unavailable'],
      [{ status: 503, body: { status: false } }, 'provider_unavailable'],
      [{ status: 404, body: { status: false, message: 'Transaction reference not found' } }, 'ambiguous_not_found'],
    ] as Array<[StubResponse, string]>) {
      const { adapter, calls } = provider([response]);
      await assert.rejects(() => adapter.verifySubscription(verifyRequest()), reason(expected));
      assert.equal(calls.length, 1);
    }
  });

  test('synchronizeSubscription and cancelSubscription still refuse without a call', async () => {
    const { adapter, calls } = provider([ok(verifiedData())]);
    await assert.rejects(
      () => adapter.synchronizeSubscription({
        provider: 'paystack', userId: USER_ID, source: 'verification', eventIdempotencyKeys: [],
        requestedAt: '2026-09-24T09:59:00.000Z',
      }),
      PaystackNotImplementedError,
    );
    await assert.rejects(
      () => adapter.cancelSubscription({
        provider: 'paystack', userId: USER_ID, providerSubscriptionId: 'SUB_x', immediate: false,
        reason: 'user', idempotencyKey: 'a'.repeat(64), requestedAt: '2026-09-24T09:59:00.000Z',
      }),
      PaystackNotImplementedError,
    );
    assert.equal(calls.length, 0);
  });
});
