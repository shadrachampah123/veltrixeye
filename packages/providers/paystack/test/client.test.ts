/**
 * Paystack sandbox REST client — request shaping, credential rejection and the
 * documented-404 classification, with an INJECTED transport.
 *
 * No socket is opened anywhere in this suite: every call goes through a stub
 * that records what the adapter tried to send. That is the point — the adapter's
 * network behaviour must be fully observable and testable without a provider.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYSTACK_API_BASE_URL,
  PaystackClient,
  isPaystackAdapterError,
  redactPaystackMessage,
  type PaystackFetchFn,
} from '../src/index.js';

const TEST_KEY = 'sk_test_0123456789abcdef0123456789abcdef01234567';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function stubTransport(
  responses: Array<{ status: number; body: unknown } | { hang: true }>,
): { fetchFn: PaystackFetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetchFn: PaystackFetchFn = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const response = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (response && 'hang' in response) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return {
      status: response?.status ?? 500,
      json: async () => response?.body,
    };
  };

  return { fetchFn, calls };
}

const client = (responses: Parameters<typeof stubTransport>[0], timeoutMs = 5000) => {
  const transport = stubTransport(responses);
  return {
    calls: transport.calls,
    adapter: new PaystackClient({ secretKey: TEST_KEY, timeoutMs, fetchFn: transport.fetchFn }),
  };
};

describe('Paystack client — sandbox-only construction', () => {
  test('accepts a test key and refuses everything else', () => {
    assert.doesNotThrow(
      () => new PaystackClient({ secretKey: TEST_KEY, timeoutMs: 1000, fetchFn: async () => ({ status: 200, json: async () => ({}) }) }),
    );

    for (const [label, key] of [
      ['empty', ''],
      ['live', 'sk_live_0123456789abcdef'],
      ['public', 'pk_test_0123456789abcdef'],
      ['test-prefix-only', 'sk_test_'],
      ['garbage', 'not-a-key'],
    ] as const) {
      assert.throws(
        () => new PaystackClient({ secretKey: key, timeoutMs: 1000 }),
        (error: unknown) => isPaystackAdapterError(error) && error.reason === 'invalid_configuration',
        `${label} key must be refused`,
      );
    }
  });

  test('refuses a non-positive timeout', () => {
    assert.throws(
      () => new PaystackClient({ secretKey: TEST_KEY, timeoutMs: 0 }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'invalid_configuration',
    );
  });

  test('describe() is operator-safe: host, mode, live flag and timeout — no key', () => {
    const described = new PaystackClient({ secretKey: TEST_KEY, timeoutMs: 1234 }).describe();
    assert.deepEqual(described, {
      provider: 'paystack',
      baseUrl: PAYSTACK_API_BASE_URL,
      mode: 'test',
      live: false,
      timeoutMs: 1234,
    });
    assert.equal(JSON.stringify(described).includes(TEST_KEY), false);
    assert.equal(PAYSTACK_API_BASE_URL, 'https://api.paystack.co');
  });
});

describe('Paystack client — documented operations', () => {
  test('initializeTransaction posts the documented body to the documented path', async () => {
    const { adapter, calls } = client([
      { status: 200, body: { status: true, message: 'ok', data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'abc', reference: 've-ref-1' } } },
    ]);

    const result = await adapter.initializeTransaction({
      amountMinor: 48_750,
      currency: 'GHS',
      email: ' Trader@Example.com ',
      reference: 've-ref-1',
      callbackUrl: 'https://app.example.com/billing/callback',
      plan: 'PLN_pro_monthly',
      metadata: { local_reference: 've-ref-1' },
    });

    assert.deepEqual(result, { authorizationUrl: 'https://checkout.paystack.com/x', reference: 've-ref-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers.Authorization, `Bearer ${TEST_KEY}`);
    assert.deepEqual(calls[0]!.body, {
      amount: 48_750,
      currency: 'GHS',
      email: 'trader@example.com',
      reference: 've-ref-1',
      callback_url: 'https://app.example.com/billing/callback',
      plan: 'PLN_pro_monthly',
      metadata: { local_reference: 've-ref-1' },
    });
    // The access code is a provider authorization handle: it is never returned.
    assert.equal(JSON.stringify(result).includes('abc'), false);
  });

  test('omits optional fields that were not authorized', async () => {
    const { adapter, calls } = client([
      { status: 200, body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/y', reference: 've-ref-2' } } },
    ]);

    await adapter.initializeTransaction({
      amountMinor: 1_000,
      currency: 'GHS',
      email: 'a@b.com',
      reference: 've-ref-2',
    });

    assert.deepEqual(Object.keys(calls[0]!.body ?? {}).sort(), ['amount', 'currency', 'email', 'reference']);
  });

  test('refuses a non-positive or non-integer amount before any call', async () => {
    const { adapter, calls } = client([{ status: 200, body: { status: true, data: {} } }]);
    for (const amountMinor of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        adapter.initializeTransaction({ amountMinor, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
        (error: unknown) => isPaystackAdapterError(error) && error.reason === 'invalid_request',
      );
    }
    assert.equal(calls.length, 0, 'nothing is sent for an invalid amount');
  });

  test('createCustomer normalizes the email and requires a provider identifier', async () => {
    const ok = client([
      { status: 200, body: { status: true, data: { id: 42, customer_code: 'CUS_abc', email: 'Trader@Example.com' } } },
    ]);
    const record = await ok.adapter.createCustomer({ email: 'Trader@Example.com ' });
    assert.deepEqual(record, { providerCustomerId: '42', providerCustomerCode: 'CUS_abc', email: 'trader@example.com' });
    assert.equal(ok.calls[0]!.url, 'https://api.paystack.co/customer');
    assert.deepEqual(ok.calls[0]!.body, { email: 'trader@example.com' });

    const identifierless = client([{ status: 200, body: { status: true, data: { email: 'a@b.com' } } }]);
    await assert.rejects(
      identifierless.adapter.createCustomer({ email: 'a@b.com' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'unexpected_response',
    );

    const mismatch = client([
      { status: 200, body: { status: true, data: { customer_code: 'CUS_x', email: 'someoneelse@example.com' } } },
    ]);
    await assert.rejects(
      mismatch.adapter.createCustomer({ email: 'a@b.com' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'response_conflict',
    );
  });

  test('createCustomer refuses an email that is not an email, without calling the provider', async () => {
    const { adapter, calls } = client([{ status: 200, body: { status: true, data: {} } }]);
    await assert.rejects(
      adapter.createCustomer({ email: 'not-an-email' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'invalid_request',
    );
    assert.equal(calls.length, 0);
  });
});

describe('Paystack client — documented 404 ambiguity', () => {
  test('a clearly missing customer is null', async () => {
    const { adapter } = client([
      { status: 404, body: { status: false, message: 'Customer not found' } },
    ]);
    assert.equal(await adapter.fetchCustomer('missing@example.com'), null);
  });

  test('an authorization-shaped 404 is an ERROR, never "no customer"', async () => {
    const { adapter } = client([
      { status: 404, body: { status: false, message: 'Unauthorized: invalid key' } },
    ]);
    await assert.rejects(
      adapter.fetchCustomer('someone@example.com'),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'provider_rejected',
    );
  });

  test('an unclassified 404 is ambiguous and never treated as "no customer"', async () => {
    for (const body of [
      { status: false, message: 'Something went wrong' },
      { status: false },
      { unexpected: true },
    ]) {
      const { adapter } = client([{ status: 404, body }]);
      await assert.rejects(
        adapter.fetchCustomer('someone@example.com'),
        (error: unknown) => isPaystackAdapterError(error) && error.reason === 'ambiguous_not_found',
        `${JSON.stringify(body)} must not be classified as a missing customer`,
      );
    }
  });

  test('an unreadable 404 body is ambiguous', async () => {
    const transport: PaystackFetchFn = async () => ({
      status: 404,
      json: async () => {
        throw new Error('not json');
      },
    });
    const adapter = new PaystackClient({ secretKey: TEST_KEY, timeoutMs: 1000, fetchFn: transport });
    await assert.rejects(
      adapter.fetchCustomer('someone@example.com'),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'ambiguous_not_found',
    );
  });
});

describe('Paystack client — one attempt, no assumed idempotency', () => {
  test('a provider rejection is surfaced and never retried', async () => {
    const { adapter, calls } = client([
      { status: 400, body: { status: false, message: 'Invalid amount' } },
    ]);
    await assert.rejects(
      adapter.initializeTransaction({ amountMinor: 100, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'provider_rejected',
    );
    assert.equal(calls.length, 1, 'exactly one attempt: no retry loop');
    assert.equal('Idempotency-Key' in calls[0]!.headers, false, 'no idempotency header is assumed to exist');
  });

  test('a 5xx is unavailable, not a rejection, and is still attempted once', async () => {
    const { adapter, calls } = client([{ status: 503, body: { status: false, message: 'Service unavailable' } }]);
    await assert.rejects(
      adapter.initializeTransaction({ amountMinor: 100, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'provider_unavailable',
    );
    assert.equal(calls.length, 1);
  });

  test('a timeout aborts and reports unavailable, with no result assumed', async () => {
    const { adapter, calls } = client([{ hang: true }], 30);
    await assert.rejects(
      adapter.initializeTransaction({ amountMinor: 100, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'provider_unavailable',
    );
    assert.equal(calls.length, 1);
  });

  test('success without data, and an unreadable body, are both rejected', async () => {
    const noData = client([{ status: 200, body: { status: true, message: 'ok' } }]);
    await assert.rejects(
      noData.adapter.initializeTransaction({ amountMinor: 100, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'unexpected_response',
    );

    const unreadable = new PaystackClient({
      secretKey: TEST_KEY,
      timeoutMs: 1000,
      fetchFn: async () => ({
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      }),
    });
    await assert.rejects(
      unreadable.initializeTransaction({ amountMinor: 100, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'unexpected_response',
    );
  });

  test('a success envelope without a usable authorization URL is rejected', async () => {
    const { adapter } = client([{ status: 200, body: { status: true, data: { reference: 'r' } } }]);
    await assert.rejects(
      adapter.initializeTransaction({ amountMinor: 100, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
      (error: unknown) => isPaystackAdapterError(error) && error.reason === 'unexpected_response',
    );
  });
});

describe('Paystack client — redaction', () => {
  test('the configured key, key shapes, bearer values and credential assignments never reach a message', () => {
    const raw = `failed for ${TEST_KEY} with Bearer sk_live_deadbeef and secret: hunter2`;
    const redacted = redactPaystackMessage(raw, TEST_KEY);
    assert.equal(redacted.includes(TEST_KEY), false);
    assert.equal(redacted.includes('sk_live_deadbeef'), false);
    assert.equal(redacted.includes('hunter2'), false);
    assert.match(redacted, /\[redacted\]/);
  });

  test('prose is preserved and the message is bounded', () => {
    assert.equal(
      redactPaystackMessage('Invalid authorization for this transaction', TEST_KEY),
      'Invalid authorization for this transaction',
    );
    const long = redactPaystackMessage('x'.repeat(5000), TEST_KEY);
    assert.ok(long.length <= 601, 'message is bounded');
    assert.match(long, /…$/);
  });

  test('a provider error message is redacted before it is surfaced', async () => {
    const { adapter } = client([
      { status: 400, body: { status: false, message: `bad request secret: ${TEST_KEY}` } },
    ]);
    await assert.rejects(
      adapter.initializeTransaction({ amountMinor: 100, currency: 'GHS', email: 'a@b.com', reference: 'r' }),
      (error: unknown) => {
        assert.ok(isPaystackAdapterError(error));
        assert.equal(error.message.includes(TEST_KEY), false);
        return error.reason === 'provider_rejected';
      },
    );
  });
});
