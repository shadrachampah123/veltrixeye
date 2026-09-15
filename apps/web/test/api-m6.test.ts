/**
 * M6 Phase 4 — API client request shapes for backtests, setups and alerts.
 *
 * The client must stay same-origin (`/api/...`, credentials via the session
 * cookie) and must never send a body-less request with a JSON content-type:
 * Fastify rejects that combination with 400 FST_ERR_CTP_EMPTY_JSON_BODY before
 * the route runs, which is exactly how logout silently broke once before (see
 * test/api-client.test.ts). `acknowledgeAlert` and `generateAlert` therefore
 * always send an explicit `{}`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ALERTS_LIMIT, MAX_BACKTESTS_LIMIT, MAX_BACKTEST_TRADES, MAX_SETUPS_LIMIT } from '@veltrixeye/contracts';
import { api, ApiError, type BacktestCreateInput } from '../lib/api';
import { classifyApiError, describeApiError, fieldErrorsFromApiError } from '../lib/api-errors';

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: RecordedCall[] = [];
let originalFetch: typeof globalThis.fetch;

function respond(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const contentTypeOf = (call: RecordedCall): string | null => new Headers(call.init?.headers).get('content-type');
const only = (): RecordedCall => {
  assert.equal(calls.length, 1, 'exactly one fetch call');
  const call = calls[0];
  assert.ok(call, 'fetch was called');
  return call;
};

/** Every M6 call must be same-origin and session-credentialed. */
test('every M6 call is same-origin /api and uses same-origin credentials', async () => {
  await api.listBacktests();
  await api.listSetups();
  await api.listAlerts();
  await api.getAlert('44444444-4444-4444-8444-444444444444');
  for (const call of calls) {
    assert.ok(call.url.startsWith('/api/'), `same-origin path: ${call.url}`);
    assert.equal(call.init?.credentials, 'same-origin', `credentials on ${call.url}`);
  }
});

// ---------------------------------------------------------------------------
// Backtests
// ---------------------------------------------------------------------------

test('api.listBacktests() — GET /api/backtests, body-less, optional filters', async () => {
  await api.listBacktests();
  let call = only();
  assert.equal(call.url, '/api/backtests');
  assert.equal(call.init?.body, undefined);
  assert.equal(contentTypeOf(call), null);

  calls = [];
  await api.listBacktests({ strategyId: 's-1', versionId: 'v-1', limit: 25 });
  call = only();
  assert.equal(call.url, '/api/backtests?strategyId=s-1&versionId=v-1&limit=25');
  assert.equal(call.init?.body, undefined);
});

test('api.listBacktests() — limit is clamped to the contract maximum', async () => {
  await api.listBacktests({ limit: 5000 });
  assert.equal(only().url, `/api/backtests?limit=${MAX_BACKTESTS_LIMIT}`);
  calls = [];
  await api.listBacktests({ limit: 0 });
  assert.equal(only().url, '/api/backtests?limit=1', 'a nonsense limit is clamped, not forwarded');
});

test('api.createBacktest() — POST /api/backtests with a JSON body', async () => {
  const input: BacktestCreateInput = {
    strategyId: '11111111-1111-4111-8111-111111111111',
    versionId: '22222222-2222-4222-8222-222222222222',
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'both',
    from: 1_700_000_000_000,
    to: 1_700_086_400_000,
    exitPolicy: { stopLoss: 'level', takeProfit: 'tp3', maxHoldCandles: 100 },
    costPolicy: { feePerSide: 0, slippagePerSide: 0, spread: 0 },
  };
  await api.createBacktest(input);
  const call = only();
  assert.equal(call.url, '/api/backtests');
  assert.equal(call.init?.method, 'POST');
  assert.equal(contentTypeOf(call), 'application/json');
  assert.deepEqual(JSON.parse(String(call.init?.body)), input);
});

test('api.getBacktest() / api.getBacktestTrades() — GET, encoded id, no body', async () => {
  await api.getBacktest('run-1');
  let call = only();
  assert.equal(call.url, '/api/backtests/run-1');
  assert.equal(call.init?.body, undefined);
  assert.equal(contentTypeOf(call), null);

  calls = [];
  await api.getBacktestTrades('run-1', 250);
  call = only();
  assert.equal(call.url, '/api/backtests/run-1/trades?limit=250');
  assert.equal(call.init?.body, undefined);

  calls = [];
  await api.getBacktestTrades('run-1');
  assert.ok(!only().url.includes('limit='), 'limit omitted when not requested');

  calls = [];
  await api.getBacktestTrades('run-1', 10_000);
  assert.equal(only().url, `/api/backtests/run-1/trades?limit=${MAX_BACKTEST_TRADES}`);
});

// ---------------------------------------------------------------------------
// Setups (read-only source for alert generation)
// ---------------------------------------------------------------------------

test('api.listSetups() — GET /api/setups with state filter, limit clamped', async () => {
  await api.listSetups({ state: 'confirmed', limit: 100 });
  assert.equal(only().url, '/api/setups?state=confirmed&limit=100');
  calls = [];
  await api.listSetups({ limit: 9999 });
  assert.equal(only().url, `/api/setups?limit=${MAX_SETUPS_LIMIT}`);
  calls = [];
  await api.listSetups();
  assert.equal(only().url, '/api/setups');
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

test('api.listAlerts() — GET /api/alerts with status/strategy filters', async () => {
  await api.listAlerts();
  assert.equal(only().url, '/api/alerts');
  calls = [];
  await api.listAlerts({ status: 'pending', strategyId: 's-1', limit: 10 });
  assert.equal(only().url, '/api/alerts?strategyId=s-1&status=pending&limit=10');
  calls = [];
  await api.listAlerts({ limit: 10_000 });
  assert.equal(only().url, `/api/alerts?limit=${MAX_ALERTS_LIMIT}`);
});

test('api.getAlert() — GET /api/alerts/:id, body-less', async () => {
  await api.getAlert('alert-1');
  const call = only();
  assert.equal(call.url, '/api/alerts/alert-1');
  assert.equal(call.init?.body, undefined);
  assert.equal(contentTypeOf(call), null);
});

test('api.acknowledgeAlert() — POST with an explicit {} JSON body (Fastify rejects empty JSON bodies)', async () => {
  await api.acknowledgeAlert('alert-1');
  const call = only();
  assert.equal(call.url, '/api/alerts/alert-1/acknowledge');
  assert.equal(call.init?.method, 'POST');
  assert.equal(call.init?.body, '{}', 'an explicit empty object, never an empty body');
  assert.equal(contentTypeOf(call), 'application/json');
});

test('api.generateAlert() — POST /api/setups/:setupId/alerts, {} when no trigger state', async () => {
  await api.generateAlert('setup-1');
  let call = only();
  assert.equal(call.url, '/api/setups/setup-1/alerts');
  assert.equal(call.init?.method, 'POST');
  assert.equal(call.init?.body, '{}');
  assert.equal(contentTypeOf(call), 'application/json');

  calls = [];
  await api.generateAlert('setup-1', 'triggered');
  call = only();
  assert.equal(call.url, '/api/setups/setup-1/alerts');
  assert.deepEqual(JSON.parse(String(call.init?.body)), { triggerState: 'triggered' });
});

// ---------------------------------------------------------------------------
// Error surfacing — safe copy, per-field messages, no invented detail
// ---------------------------------------------------------------------------

test('API failures surface as ApiError with code/status/message and safe copy', async () => {
  respond({ error: { code: 'not_found', message: 'Backtest not found' } }, 404);
  await assert.rejects(
    () => api.getBacktest('nope'),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 404);
      assert.equal(e.code, 'not_found');
      assert.equal(classifyApiError(e), 'not_found');
      assert.equal(describeApiError(e), 'Backtest not found');
      return true;
    },
  );

  respond({ error: { code: 'rate_limited', message: 'Rate limit exceeded. Try again in 42s.' } }, 429);
  await assert.rejects(
    () => api.generateAlert('setup-1'),
    (e: unknown) => {
      assert.equal(classifyApiError(e), 'rate_limited');
      assert.match(describeApiError(e), /Rate limit exceeded/);
      return true;
    },
  );

  respond({ error: { code: 'unauthorized', message: 'Invalid or expired session' } }, 401);
  await assert.rejects(
    () => api.listAlerts(),
    (e: unknown) => {
      assert.equal(classifyApiError(e), 'unauthorized');
      assert.match(describeApiError(e), /sign in again/i, '401 asks for a re-sign-in');
      return true;
    },
  );
});

test('a 500 renders the generic fallback — never a stack trace', async () => {
  respond({ error: { code: 'internal', message: 'An unexpected error occurred' } }, 500);
  await assert.rejects(
    () => api.createBacktest({
      strategyId: 's',
      versionId: 'v',
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      from: 1,
      to: 2,
    }),
    (e: unknown) => {
      assert.equal(classifyApiError(e), 'server');
      const text = describeApiError(e, 'The backtest could not be run.');
      assert.equal(text, 'The backtest could not be run.');
      assert.ok(!/at |stack|postgres|pg_/i.test(text), 'no internals leak into the copy');
      assert.deepEqual(fieldErrorsFromApiError(e), {}, 'a server error is never painted as a field mistake');
      return true;
    },
  );
});

test('a 400 carries per-field messages for the form', async () => {
  respond(
    {
      error: {
        code: 'invalid_input',
        message: 'Invalid request body',
        fields: { from: ['`from` must be earlier than `to`'], 'costPolicy.spread': ['must be >= 0'] },
      },
    },
    400,
  );
  await assert.rejects(
    () => api.listBacktests(),
    (e: unknown) => {
      assert.equal(classifyApiError(e), 'invalid_input');
      assert.deepEqual(fieldErrorsFromApiError(e), {
        from: '`from` must be earlier than `to`',
        'costPolicy.spread': 'must be >= 0',
      });
      assert.equal(describeApiError(e), 'Invalid request body');
      return true;
    },
  );
});

test('a non-ApiError (network failure) renders as the safe fallback', () => {
  assert.equal(classifyApiError(new TypeError('fetch failed')), 'server');
  assert.equal(describeApiError(new TypeError('fetch failed'), 'Could not load your alerts.'), 'Could not load your alerts.');
  assert.deepEqual(fieldErrorsFromApiError(new TypeError('fetch failed')), {});
});
