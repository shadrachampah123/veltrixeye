/**
 * Billing Step 9b Part 1 — the documented subscription READ.
 *
 * Client: `GET /subscription/:id_or_code`, documented fields only, one attempt,
 * typed fail-closed errors, nothing retained. The provider's cancellation
 * credential (`email_token`) is never read: it is not part of the response
 * schema, so it cannot be returned, logged or persisted.
 *
 * Provider: `findSubscription` built on that read, normalized onto the existing
 * `ProviderSubscriptionState` contract. A user id alone is not a lookup key, the
 * provider must echo the subscription that was asked for, the sandbox domain is
 * enforced, an ambiguous 404 is an error rather than "no subscription", and no
 * catalogue plan, interval, commercial currency or billing period is guessed.
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

/**
 * The provider's documented Fetch Subscription sample, carrying the field set
 * this build acts on plus the material it must never read.
 */
function subscriptionData(overrides: Record<string, unknown> = {}) {
  return {
    id: 292646,
    domain: 'test',
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
      domain: 'test',
    },
    plan: {
      id: 100971,
      plan_code: 'PLN_gx2wn530m0i3w3m',
      name: 'Monthly retainer',
      amount: 48_750,
      currency: 'GHS',
      interval: 'monthly',
      domain: 'test',
    },
    createdAt: '2026-09-24T10:34:57.000Z',
    updatedAt: '2026-09-24T10:34:57.000Z',
    ...overrides,
  };
}

const ok = (data: unknown) => ({ status: 200, body: { status: true, message: 'Subscription retrieved', data } });

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

const query = (overrides: Record<string, unknown> = {}) => ({
  provider: 'paystack' as const,
  userId: USER_ID,
  providerSubscriptionId: SUBSCRIPTION_CODE,
  ...overrides,
});

/* ========================================================================== */
/* Client                                                                    */
/* ========================================================================== */

describe('Paystack client — the documented subscription read', () => {
  test('reads exactly the documented endpoint, with one GET and no body', async () => {
    const { adapter, calls } = client([ok(subscriptionData())]);
    const record = await adapter.fetchSubscription(SUBSCRIPTION_CODE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.url, `https://api.paystack.co/subscription/${SUBSCRIPTION_CODE}`);
    assert.equal(calls[0]!.body, undefined, 'a read sends no body');
    assert.equal('Idempotency-Key' in calls[0]!.headers, false, 'no provider idempotency is assumed');
    assert.deepEqual(record, {
      providerSubscriptionId: '292646',
      providerSubscriptionCode: SUBSCRIPTION_CODE,
      providerStatus: 'active',
      domain: 'test',
      providerCustomerId: '178433',
      providerCustomerCode: 'CUS_1rkzaqsv4rrhqo6',
      providerPlanCode: 'PLN_gx2wn530m0i3w3m',
      amountMinor: 48_750,
      planAmountMinor: 48_750,
      currency: 'GHS',
    });
  });

  test('never returns the cancellation credential or card material', async () => {
    const { adapter } = client([ok(subscriptionData())]);
    const record = await adapter.fetchSubscription(SUBSCRIPTION_CODE);
    const serialized = JSON.stringify(record);
    for (const secret of [
      EMAIL_TOKEN,
      'AUTH_6tmt288t0o',
      'SIG_uSYN4fv1adlAuoij8QXh',
      '4081',
      '408408',
    ]) {
      assert.equal(serialized.includes(secret), false, `${secret} must never cross the client boundary`);
    }
  });

  test('encodes the identifier and refuses one that is not reference-shaped, without calling', async () => {
    const { adapter, calls } = client([ok(subscriptionData())]);
    // A path-reshaping or query-injecting value never becomes a request.
    for (const identifier of [
      '../customer/abc',
      'SUB_x?x=1',
      'SUB_x/../../plan',
      'SUB_x#frag',
      '',
      '   ',
      'x'.repeat(129),
    ]) {
      await assert.rejects(() => adapter.fetchSubscription(identifier), reason('invalid_request'), identifier);
    }
    assert.equal(calls.length, 0);
    // A documented numeric id and a documented code are both accepted, and the
    // identifier is URL-encoded into the path.
    await adapter.fetchSubscription('292646');
    assert.equal(calls[0]!.url, 'https://api.paystack.co/subscription/292646');
  });

  test('a clearly missing subscription is null, and only that', async () => {
    for (const message of [
      'Subscription not found',
      'The subscription does not exist',
      'No subscription found',
    ]) {
      const { adapter } = client([{ status: 404, body: { status: false, message } }]);
      assert.equal(await adapter.fetchSubscription(SUBSCRIPTION_CODE), null, message);
    }
  });

  test('an ambiguous or authorization-shaped 404 is an ERROR, never "no subscription"', async () => {
    const matrix: Array<[StubResponse, string]> = [
      [{ status: 404, body: { status: false, message: 'Something went wrong' } }, 'ambiguous_not_found'],
      [{ status: 404, body: { status: false } }, 'ambiguous_not_found'],
      [{ status: 404, body: { unexpected: true } }, 'ambiguous_not_found'],
      [{ unreadable: 404 }, 'ambiguous_not_found'],
      [{ status: 404, body: { status: false, message: 'Unauthorized: invalid key' } }, 'provider_rejected'],
      // A 404 about something else is not evidence about a subscription.
      [{ status: 404, body: { status: false, message: 'Customer not found' } }, 'ambiguous_not_found'],
    ];
    for (const [response, expected] of matrix) {
      const { adapter, calls } = client([response]);
      await assert.rejects(() => adapter.fetchSubscription(SUBSCRIPTION_CODE), reason(expected));
      assert.equal(calls.length, 1, 'exactly one attempt');
    }
  });

  test('transport and provider failures are typed, one attempt, never a default', async () => {
    const matrix: Array<[StubResponse, string]> = [
      [{ throws: true }, 'provider_unavailable'],
      [{ status: 500, body: { status: false, message: 'Server error' } }, 'provider_unavailable'],
      [{ status: 400, body: { status: false, message: 'Invalid subscription code' } }, 'provider_rejected'],
      [{ status: 200, body: { status: false, message: 'Invalid' } }, 'provider_rejected'],
      [{ status: 200, body: { status: true, message: 'ok' } }, 'unexpected_response'],
      [{ unreadable: 200 }, 'unexpected_response'],
    ];
    for (const [response, expected] of matrix) {
      const { adapter, calls } = client([response]);
      await assert.rejects(() => adapter.fetchSubscription(SUBSCRIPTION_CODE), reason(expected));
      assert.equal(calls.length, 1, `exactly one attempt for ${expected}: no retry loop`);
    }
  });

  test('a provider message never echoes the secret key', async () => {
    const { adapter } = client([{ status: 400, body: { status: false, message: `bad key ${TEST_KEY}` } }]);
    await assert.rejects(
      () => adapter.fetchSubscription(SUBSCRIPTION_CODE),
      (error: unknown) => isPaystackAdapterError(error) && !error.message.includes(TEST_KEY),
    );
  });

  test('a response missing a documented field this build acts on is refused', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['domain', { domain: undefined }],
      ['status', { status: undefined }],
      ['subscription_code', { subscription_code: undefined }],
      ['status not a string', { status: 7 }],
      ['customer not an object', { customer: 'CUS_x' }],
      ['amount not an integer', { amount: 48_750.5 }],
      ['amount is a string', { amount: '48750' }],
    ];
    for (const [label, overrides] of cases) {
      const data = subscriptionData(overrides);
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete (data as Record<string, unknown>)[key];
      }
      const { adapter } = client([ok(data)]);
      await assert.rejects(() => adapter.fetchSubscription(SUBSCRIPTION_CODE), reason('unexpected_response'), label);
    }
    // A `data` that is not the documented subscription object at all.
    for (const body of [null, 'a string', 42, []]) {
      const { adapter } = client([ok(body)]);
      await assert.rejects(
        () => adapter.fetchSubscription(SUBSCRIPTION_CODE),
        reason('unexpected_response'),
        JSON.stringify(body),
      );
    }
  });

  test('a plan the documented read does not express as an object contributes nothing', async () => {
    // The provider is documented as carrying the plan as an object on the fetch
    // read and as a bare identifier on other shapes. Nothing is guessed from
    // the shape this build does not read.
    for (const plan of [100971, 'PLN_gx2wn530m0i3w3m', null, undefined, { nonsense: true }]) {
      const data = subscriptionData(plan === undefined ? {} : { plan });
      if (plan === undefined) delete (data as Record<string, unknown>).plan;
      const { adapter } = client([ok(data)]);
      const record = await adapter.fetchSubscription(SUBSCRIPTION_CODE);
      assert.equal(record?.providerPlanCode, null);
      assert.equal(record?.currency, null);
      assert.equal(record?.amountMinor, 48_750, 'the amount itself is still reported as delivered');
    }
  });
});

/* ========================================================================== */
/* Provider                                                                  */
/* ========================================================================== */

describe('Paystack provider — findSubscription via the documented fetch', () => {
  test('is implemented, and still reports honestly that the provider is incomplete', () => {
    assert.ok(PAYSTACK_IMPLEMENTED_OPERATIONS.includes('findSubscription'));
    const { adapter } = provider([ok(subscriptionData())]);
    assert.equal(adapter.implemented, false, 'synchronization still refuses');
    assert.equal(adapter.live, false);
    const operations = adapter.describe()['operations'] as {
      implemented: string[];
      unimplemented: string[];
    };
    assert.ok(operations.implemented.includes('findSubscription'));
    assert.deepEqual(operations.unimplemented, ['synchronizeSubscription']);
  });

  test('normalizes the documented read onto the canonical contract', async () => {
    const { adapter, calls } = provider([ok(subscriptionData())]);
    const state = await adapter.findSubscription(query());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.url, `https://api.paystack.co/subscription/${SUBSCRIPTION_CODE}`);
    assert.deepEqual(providerSubscriptionStateSchema.parse(state), state, 'canonical .strict() contract');
    assert.deepEqual(state, {
      provider: 'paystack',
      state: 'active',
      providerSubscriptionId: '292646',
      providerSubscriptionCode: SUBSCRIPTION_CODE,
      providerCustomerId: '178433',
      providerCustomerCode: 'CUS_1rkzaqsv4rrhqo6',
      providerPlanId: 'PLN_gx2wn530m0i3w3m',
      // A subscription read publishes no transaction.
      providerReference: null,
      // Never resolved from a provider payload: only a locally authorized plan
      // epoch may say what a provider plan means.
      cataloguePlan: null,
      interval: null,
      // The commercial currency is never provider-reported.
      currency: null,
      payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
      // The published read documents no billing period.
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      cancelledAt: null,
      cancellationReason: null,
      sourceEventIdempotencyKey: null,
      observedAt: OBSERVED_AT.toISOString(),
      paidAt: null,
      providerTransactionId: null,
      providerTransactionStatus: null,
    });
  });

  test('the normalized state can never carry the cancellation credential or raw provider detail', async () => {
    const { adapter } = provider([ok(subscriptionData())]);
    const state = await adapter.findSubscription(query());
    const serialized = JSON.stringify(state);
    for (const secret of [EMAIL_TOKEN, 'AUTH_6tmt288t0o', 'SIG_uSYN4fv1adlAuoij8QXh', '4081', '408408']) {
      assert.equal(serialized.includes(secret), false, `${secret} must never cross the seam`);
    }
    // No raw payload field survives: the object carries exactly the canonical
    // contract's keys, nothing more.
    const canonical = providerSubscriptionStateSchema.parse(state);
    assert.deepEqual(
      Object.keys(state as object).sort(),
      Object.keys(canonical).sort(),
      'no provider-shaped field crosses the seam',
    );
  });

  test('maps only the documented statuses, and never guesses an undocumented one', async () => {
    const matrix: Array<[string, string]> = [
      ['active', 'active'],
      ['non-renewing', 'unsubscribed'],
      ['completed', 'expired'],
      ['cancelled', 'cancelled'],
      // `attention` is documented but self-contradictory in the provider's own
      // guide, and these are not documented at all: all are `unknown`.
      ['attention', 'unknown'],
      ['complete', 'unknown'],
      ['paused', 'unknown'],
      ['ACTIVE', 'unknown'],
    ];
    for (const [status, expected] of matrix) {
      const { adapter } = provider([ok(subscriptionData({ status }))]);
      const state = await adapter.findSubscription(query());
      assert.equal(state?.state, expected, `status ${status} must normalize to ${expected}`);
    }
    // A status that is missing or is not a string is a refusal, not a default.
    for (const status of ['', 7, null]) {
      const data = subscriptionData({ status });
      if (status === null) delete (data as Record<string, unknown>).status;
      const { adapter } = provider([ok(data)]);
      await assert.rejects(() => adapter.findSubscription(query()), reason('unexpected_response'));
    }
  });

  test('the read touches no local directory: it is one provider read and nothing else', async () => {
    let customerLookups = 0;
    let planLookups = 0;
    const t = stub([ok(subscriptionData())]);
    const adapter = createPaystackProvider({
      secretKey: TEST_KEY,
      timeoutMs: 2000,
      fetchFn: t.fetchFn,
      clock: () => OBSERVED_AT,
      customers: {
        find: async () => {
          customerLookups += 1;
          return { email: 'demo@test.com', providerCustomerCode: 'CUS_1rkzaqsv4rrhqo6' };
        },
      },
      plans: {
        find: async () => {
          planLookups += 1;
          return null;
        },
      },
    });
    const state = await adapter.findSubscription(query());
    assert.equal(t.calls.length, 1);
    assert.equal(customerLookups, 0, 'a subscription read resolves no local customer');
    assert.equal(planLookups, 0, 'a provider plan is never resolved to a catalogue plan here');
    // A plan code the provider reports is reported as a provider reference
    // only: resolving what it MEANS is core's synchronization step.
    assert.equal(state?.providerPlanId, 'PLN_gx2wn530m0i3w3m');
    assert.equal(state?.cataloguePlan, null);
  });

  test('refuses a request that is not canonical, without calling the provider', async () => {
    const { adapter, calls } = provider([ok(subscriptionData())]);
    const cases: Array<[string, unknown]> = [
      ['wrong provider', { ...query(), provider: 'stripe' }],
      ['not a uuid user', { ...query(), userId: 'nope' }],
      ['an unknown field', { ...query(), extra: true }],
      ['a non-string identifier', { ...query(), providerSubscriptionId: 292646 }],
      // A value that is not reference-shaped (here: credential-shaped) is
      // refused by the client's identifier check before a request is built.
      ['a credential-shaped identifier', { ...query(), providerSubscriptionId: 'token:abc' }],
      ['a blank identifier', { ...query(), providerSubscriptionId: '   ' }],
      ['a null request', null],
    ];
    for (const [label, request] of cases) {
      await assert.rejects(
        () => adapter.findSubscription(request as never),
        reason('invalid_request'),
        label,
      );
    }
    assert.equal(calls.length, 0);
  });

  test('a user id alone is not a lookup key: it refuses before any call', async () => {
    for (const request of [query({ providerSubscriptionId: undefined }), query({ providerSubscriptionId: null })]) {
      const { adapter, calls } = provider([ok(subscriptionData())]);
      await assert.rejects(() => adapter.findSubscription(request), reason('invalid_request'));
      assert.equal(calls.length, 0, 'nothing is fetched on a guess');
    }
  });

  test('refuses a response describing a different subscription', async () => {
    const { adapter, calls } = provider([ok(subscriptionData({ subscription_code: 'SUB_someoneelse00000' }))]);
    await assert.rejects(() => adapter.findSubscription(query()), reason('response_conflict'));
    assert.equal(calls.length, 1);
  });

  test('accepts a response addressed by the subscription id that was asked for', async () => {
    const { adapter } = provider([ok(subscriptionData())]);
    const state = await adapter.findSubscription(query({ providerSubscriptionId: '292646' }));
    assert.equal(state?.providerSubscriptionCode, SUBSCRIPTION_CODE);
    assert.equal(state?.providerSubscriptionId, '292646');
  });

  test('refuses a non-sandbox subscription domain', async () => {
    const { adapter } = provider([ok(subscriptionData({ domain: 'live' }))]);
    await assert.rejects(() => adapter.findSubscription(query()), reason('response_conflict'));
  });

  test('reports no amount when the currency is one this build cannot normalize', async () => {
    // An amount without a known minor unit is never reported, and is never
    // converted: the subscription identity and lifecycle state still are.
    for (const currency of ['NGN', 'USD', 'ghs', null, undefined]) {
      const data = subscriptionData(currency === null ? { plan: { plan_code: 'PLN_x', amount: 48_750 } } : { plan: { plan_code: 'PLN_x', amount: 48_750, currency } });
      if (currency === undefined) delete (data as Record<string, unknown>).plan;
      const { adapter } = provider([ok(data)]);
      const state = await adapter.findSubscription(query());
      assert.equal(state?.payment, null, `currency ${String(currency)} must not produce an amount`);
      assert.equal(state?.state, 'active');
    }
    // A plan that reports no amount at all: nothing to report.
    const { adapter } = provider([ok(subscriptionData({ amount: undefined, plan: null }))]);
    assert.equal((await adapter.findSubscription(query()))?.payment, null);
  });

  test('refuses a subscription that contradicts the amount on its own plan', async () => {
    const { adapter } = provider([
      ok(subscriptionData({ amount: 48_750, plan: { plan_code: 'PLN_x', amount: 96_000, currency: 'GHS' } })),
    ]);
    await assert.rejects(() => adapter.findSubscription(query()), reason('unexpected_response'));
  });

  test('a missing or malformed response is refused, never normalized from a default', async () => {
    const { adapter } = provider([ok(subscriptionData({ subscription_code: undefined }))]);
    await assert.rejects(() => adapter.findSubscription(query()), reason('unexpected_response'));
  });

  test('null means the provider has no such subscription — and nothing else does', async () => {
    const { adapter } = provider([
      { status: 404, body: { status: false, message: 'Subscription not found' } },
    ]);
    assert.equal(await adapter.findSubscription(query()), null);

    // An unresolved 404 is an error, never a silent "this user has no
    // subscription".
    const { adapter: ambiguous } = provider([
      { status: 404, body: { status: false, message: 'Something went wrong' } },
    ]);
    await assert.rejects(() => ambiguous.findSubscription(query()), reason('ambiguous_not_found'));
  });

  test('the read changes nothing: no write verb, no body, no second attempt', async () => {
    const { adapter, calls } = provider([
      { throws: true },
      { throws: true },
    ]);
    await assert.rejects(() => adapter.findSubscription(query()), reason('provider_unavailable'));
    assert.equal(calls.length, 1, 'a failed read is never retried here');
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.body, undefined);
  });
});
