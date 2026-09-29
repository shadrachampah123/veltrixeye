/**
 * Billing Step 9b Part 2 — the documented subscription CANCELLATION.
 *
 * Client: `POST /subscription/disable`, which the provider documents as taking
 * the subscription code AND that subscription's email token. The token is
 * obtained inside the client from the documented subscription read, spent on
 * that one call and dropped: it is not returned, not on any record, not logged
 * and not in an error message.
 *
 * Provider: `cancelSubscription` built on it, NON-IMMEDIATE ONLY. An immediate
 * cancellation is refused before any call, and the operation fails closed when
 * the subscription identity or the credential cannot be safely established.
 *
 * Every call goes through an injected stub transport: no socket is opened.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { providerSubscriptionStateSchema } from '@veltrixeye/contracts';
import {
  PAYSTACK_IMPLEMENTED_OPERATIONS,
  PaystackClient,
  createPaystackProvider,
  isPaystackAdapterError,
  type PaystackFetchFn,
} from '../src/index.js';

const TEST_KEY = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const USER_ID = '1f000000-0000-4000-8000-000000000001';
const SUBSCRIPTION_CODE = 'SUB_vsyqdmlzble3uii';
const EMAIL_TOKEN = 'd7gofp6yppn3qz7';
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

/** The documented fetch payload, carrying the credential to be spent. */
function subscriptionData(overrides: Record<string, unknown> = {}) {
  return {
    id: 292646,
    domain: 'test',
    status: 'active',
    subscription_code: SUBSCRIPTION_CODE,
    email_token: EMAIL_TOKEN,
    amount: 48_750,
    customer: { id: 178433, customer_code: 'CUS_1rkzaqsv4rrhqo6' },
    plan: { id: 100971, plan_code: 'PLN_gx2wn530m0i3w3m', amount: 48_750, currency: 'GHS', interval: 'monthly' },
    authorization: { authorization_code: 'AUTH_6tmt288t0o', last4: '4081', signature: 'SIG_uSYN4fv1ad' },
    ...overrides,
  };
}

const fetched = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  body: { status: true, message: 'Subscription retrieved', data: subscriptionData(overrides) },
});
/** The documented disable response: an envelope with no `data` at all. */
const disabled = { status: 200, body: { status: true, message: 'Subscription disabled' } };

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

const cancelRequest = (overrides: Record<string, unknown> = {}) => ({
  provider: 'paystack' as const,
  userId: USER_ID,
  providerSubscriptionId: SUBSCRIPTION_CODE,
  immediate: false,
  reason: 'user' as const,
  idempotencyKey: 'c'.repeat(64),
  requestedAt: '2026-09-24T09:59:00.000Z',
  ...overrides,
});

/* ========================================================================== */
/* Client                                                                    */
/* ========================================================================== */

describe('Paystack client — the documented cancellation', () => {
  test('reads the subscription, then POSTs the documented disable with code and credential', async () => {
    const { adapter, calls } = client([fetched(), disabled]);
    const result = await adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE });

    assert.equal(calls.length, 2);
    // 1. The documented read that yields the credential.
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.url, `https://api.paystack.co/subscription/${SUBSCRIPTION_CODE}`);
    assert.equal(calls[0]!.body, undefined);
    // 2. The documented disable — exactly the endpoint and the two documented
    //    parameters, form-encoded as the provider documents them.
    assert.equal(calls[1]!.method, 'POST');
    assert.equal(calls[1]!.url, 'https://api.paystack.co/subscription/disable');
    assert.equal(calls[1]!.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const body = new URLSearchParams(calls[1]!.body ?? '');
    assert.equal(body.get('code'), SUBSCRIPTION_CODE);
    assert.equal(body.get('token'), EMAIL_TOKEN);
    assert.deepEqual([...body.keys()], ['code', 'token'], 'the documented operation takes exactly these two');

    // …and the credential is NOT part of what comes back.
    assert.deepEqual(result, { providerSubscriptionCode: SUBSCRIPTION_CODE, acknowledged: true });
    assert.equal(JSON.stringify(result).includes(EMAIL_TOKEN), false);
  });

  test('never returns, records or echoes the credential', async () => {
    const { adapter } = client([fetched(), disabled]);
    const result = await adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE });
    for (const value of [JSON.stringify(result), String(result.providerSubscriptionCode)]) {
      assert.equal(value.includes(EMAIL_TOKEN), false);
    }
  });

  test('submits the code the PROVIDER reported, not the one the caller typed', async () => {
    // A numeric id is accepted by the documented path parameter; the disable
    // then carries the provider's own code.
    const { adapter, calls } = client([fetched(), disabled]);
    await adapter.disableSubscription({ idOrCode: '292646' });
    assert.equal(calls[0]!.url, 'https://api.paystack.co/subscription/292646');
    assert.equal(new URLSearchParams(calls[1]!.body ?? '').get('code'), SUBSCRIPTION_CODE);
  });

  test('refuses a subscription identity that is not reference-shaped, without calling', async () => {
    const { adapter, calls } = client([fetched(), disabled]);
    for (const identifier of [
      '../subscription/disable',
      'SUB_x?token=abc',
      'SUB_x/../../plan',
      'token:abc',
      '',
      '   ',
      'x'.repeat(129),
    ]) {
      await assert.rejects(() => adapter.disableSubscription({ idOrCode: identifier }), reason('invalid_request'), identifier);
    }
    assert.equal(calls.length, 0, 'a cancellation is never attempted on an unusable identifier');
  });

  test('fails closed — and disables nothing — when the subscription does not exist', async () => {
    const { adapter, calls } = client([{ status: 404, body: { status: false, message: 'Subscription not found' } }]);
    await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason('not_found'));
    assert.equal(calls.length, 1, 'no disable is attempted for a subscription that is not there');
  });

  test('fails closed on an ambiguous 404: an unresolved 404 never becomes a cancellation', async () => {
    for (const body of [
      { status: false, message: 'Something went wrong' },
      { status: false },
      { unexpected: true },
    ]) {
      const { adapter, calls } = client([{ status: 404, body }]);
      await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason('ambiguous_not_found'));
      assert.equal(calls.length, 1);
    }
    const { adapter, calls } = client([{ unreadable: 404 }]);
    await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason('ambiguous_not_found'));
    assert.equal(calls.length, 1);
  });

  test('fails closed when the response describes a DIFFERENT subscription', async () => {
    const { adapter, calls } = client([fetched({ subscription_code: 'SUB_someoneelse00000' })]);
    await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason('response_conflict'));
    assert.equal(calls.length, 1, 'the credential of another subscription is never submitted');
  });

  test('fails closed on a non-sandbox subscription', async () => {
    const { adapter, calls } = client([fetched({ domain: 'live' })]);
    await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason('response_conflict'));
    assert.equal(calls.length, 1);
  });

  test('fails closed, and calls nothing, when the credential is missing or unusable', async () => {
    for (const emailToken of [undefined, '', '   ']) {
      const data = subscriptionData();
      if (emailToken === undefined) delete (data as Record<string, unknown>).email_token;
      else (data as Record<string, unknown>).email_token = emailToken;
      const { adapter, calls } = client([
        { status: 200, body: { status: true, message: 'Subscription retrieved', data } },
        disabled,
      ]);
      await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason('unexpected_response'));
      assert.equal(calls.length, 1, 'the documented disable is never sent without its credential');
    }
  });

  test('fails closed on a response missing the documented identity fields', async () => {
    for (const overrides of [
      { domain: undefined },
      { subscription_code: undefined },
      { domain: 7 },
      { subscription_code: 292646 },
      { id: 292646.5 },
    ]) {
      const data = subscriptionData(overrides);
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete (data as Record<string, unknown>)[key];
      }
      const { adapter, calls } = client([{ status: 200, body: { status: true, data } }, disabled]);
      await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason('unexpected_response'));
      assert.equal(calls.length, 1, 'nothing is sent on an unreadable subscription');
    }
  });

  test('surfaces a provider refusal, one attempt, never a retry', async () => {
    for (const [response, expected] of [
      [{ status: 400, body: { status: false, message: 'Subscription not found' } }, 'provider_rejected'],
      [{ status: 401, body: { status: false, message: 'Invalid key' } }, 'provider_rejected'],
      [{ status: 500, body: { status: false, message: 'Server error' } }, 'provider_unavailable'],
      [{ throws: true }, 'provider_unavailable'],
    ] as Array<[StubResponse, string]>) {
      const { adapter, calls } = client([fetched(), response]);
      await assert.rejects(() => adapter.disableSubscription({ idOrCode: SUBSCRIPTION_CODE }), reason(expected));
      assert.equal(calls.length, 2, `exactly one disable attempt for ${expected}: no retry loop`);
    }
  });

  test('a provider message that echoes the credential never carries it out', async () => {
    // The provider is the one place the token could come back: the redaction
    // literal for that call strips it verbatim.
    for (const message of [
      `Invalid token ${EMAIL_TOKEN}`,
      `token=${EMAIL_TOKEN} rejected`,
      `The value ${EMAIL_TOKEN} is not valid for this subscription`,
    ]) {
      const { adapter } = client([
        fetched(),
        { status: 400, body: { status: false, message } },
      ]);
      const error = await adapter
        .disableSubscription({ idOrCode: SUBSCRIPTION_CODE })
        .then(() => undefined, (cause: unknown) => cause);
      assert.ok(isPaystackAdapterError(error));
      assert.equal(error.message.includes(EMAIL_TOKEN), false, `the credential leaked: ${error.message}`);
      assert.equal(error.message.includes(TEST_KEY), false);
      assert.ok(error.message.length <= 600, 'the message stays within the durable bound');
    }
  });
});

/* ========================================================================== */
/* Provider                                                                  */
/* ========================================================================== */

describe('Paystack provider — cancelSubscription (non-immediate only)', () => {
  test('is implemented, and still reports honestly that the provider is incomplete', () => {
    assert.ok(PAYSTACK_IMPLEMENTED_OPERATIONS.includes('cancelSubscription'));
    const { adapter } = provider([fetched(), disabled]);
    assert.equal(adapter.implemented, false, 'synchronization still refuses');
    const operations = adapter.describe()['operations'] as { unimplemented: string[] };
    assert.deepEqual(operations.unimplemented, ['synchronizeSubscription']);
  });

  test('a successful disable normalizes to the canonical contract', async () => {
    const { adapter, calls } = provider([fetched(), disabled]);
    const state = await adapter.cancelSubscription(cancelRequest());
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, 'https://api.paystack.co/subscription/disable');
    assert.deepEqual(providerSubscriptionStateSchema.parse(state), state, 'canonical .strict() contract');
    assert.deepEqual(state, {
      provider: 'paystack',
      // The documented "will not renew" status, through the one shared mapping.
      state: 'unsubscribed',
      providerSubscriptionId: null,
      providerSubscriptionCode: SUBSCRIPTION_CODE,
      providerCustomerId: null,
      providerCustomerCode: null,
      providerPlanId: null,
      providerReference: null,
      cataloguePlan: null,
      interval: null,
      currency: null,
      payment: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      // This IS the documented stop-renewing operation.
      cancelAtPeriodEnd: true,
      cancelAt: null,
      // Access continues to the end of the paid period: nothing is cancelled yet.
      cancelledAt: null,
      cancellationReason: 'user',
      sourceEventIdempotencyKey: null,
      observedAt: OBSERVED_AT.toISOString(),
      paidAt: null,
      providerTransactionId: null,
      providerTransactionStatus: null,
    });
  });

  test('the credential never crosses the provider-state boundary', async () => {
    for (const reason of ['user', 'provider', 'payment_failure', 'expired', 'fraud', 'other'] as const) {
      const { adapter } = provider([fetched(), disabled]);
      const state = await adapter.cancelSubscription(cancelRequest({ reason }));
      const serialized = JSON.stringify(state);
      for (const secret of [
        EMAIL_TOKEN,
        'AUTH_6tmt288t0o',
        'SIG_uSYN4fv1ad',
        '4081',
      ]) {
        assert.equal(serialized.includes(secret), false, `${secret} must never cross the seam`);
      }
      assert.equal(serialized.includes('token'), false, 'no token-shaped word reaches the state');
    }
  });

  test('refuses an IMMEDIATE cancellation before any call', async () => {
    const { adapter, calls } = provider([fetched(), disabled]);
    const error = await adapter
      .cancelSubscription(cancelRequest({ immediate: true }))
      .then(() => undefined, (cause: unknown) => cause);
    assert.ok(isPaystackAdapterError(error));
    assert.equal(error.reason, 'invalid_request');
    assert.match(error.message, /non-immediate/i);
    assert.equal(calls.length, 0, 'the subscription read is not even attempted');
  });

  test('refuses a request that is not canonical, without calling', async () => {
    const { adapter, calls } = provider([fetched(), disabled]);
    const cases: Array<[string, unknown]> = [
      ['wrong provider', { ...cancelRequest(), provider: 'stripe' }],
      ['not a uuid user', { ...cancelRequest(), userId: 'nope' }],
      ['a non-string subscription', { ...cancelRequest(), providerSubscriptionId: 292646 }],
      ['a blank subscription', { ...cancelRequest(), providerSubscriptionId: '  ' }],
      ['an unknown field', { ...cancelRequest(), extra: true }],
      ['an unknown reason', { ...cancelRequest(), reason: 'because' }],
      ['a null request', null],
    ];
    for (const [label, request] of cases) {
      await assert.rejects(() => adapter.cancelSubscription(request as never), reason('invalid_request'), label);
    }
    assert.equal(calls.length, 0);
  });

  test('fails closed when the provider cannot be reached, having changed nothing', async () => {
    const { adapter, calls } = provider([{ throws: true }]);
    await assert.rejects(() => adapter.cancelSubscription(cancelRequest()), reason('provider_unavailable'));
    assert.equal(calls.length, 1);
  });

  test('a refused disable is an error, never a cancelled-looking state', async () => {
    const { adapter, calls } = provider([
      fetched(),
      { status: 400, body: { status: false, message: 'Subscription already disabled' } },
    ]);
    const error = await adapter
      .cancelSubscription(cancelRequest())
      .then(() => undefined, (cause: unknown) => cause);
    assert.ok(isPaystackAdapterError(error));
    assert.equal(error.reason, 'provider_rejected');
    assert.equal(calls.length, 2, 'one attempt, never a retry');
  });

  test('a disable response the build cannot read is refused', async () => {
    for (const response of [
      { status: 200, body: { unexpected: true } },
      { status: 200, body: 'not an envelope' },
      { unreadable: 200 },
    ] as StubResponse[]) {
      const { adapter } = provider([fetched(), response]);
      await assert.rejects(() => adapter.cancelSubscription(cancelRequest()), reason('unexpected_response'));
    }
    // The documented disable answers with no `data`; that is a SUCCESS, not a
    // malformed response.
    const { adapter } = provider([fetched(), { status: 200, body: { status: true, message: 'Subscription disabled' } }]);
    assert.equal((await adapter.cancelSubscription(cancelRequest())).providerSubscriptionCode, SUBSCRIPTION_CODE);
  });
});
