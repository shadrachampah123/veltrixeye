/**
 * M7.1 — API client request shapes for the core browser workflow.
 *
 * The workflow's correctness depends on the client sending exactly what the
 * routes accept, so these tests pin the wire contract for the six M7.1 calls:
 *   - same-origin `/api/...` paths with `credentials: 'same-origin'`;
 *   - the exact HTTP method and body (`{ asOf }` for evaluate, the full
 *     `{ instrument, asOf, direction? }` for detect, `{ toState, asOf, reason? }`
 *     for transitions);
 *   - a body-bearing POST always declares a JSON content-type, and a body-less
 *     GET never does (Fastify rejects an empty JSON body with a 400 before the
 *     route runs — see test/api-client.test.ts);
 *   - the API's `created: false` replay flag survives the client untouched, so
 *     the UI can never mistake a replay for something new.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCORE_HISTORY_LIMIT,
  detectionRequestSchema,
  detectionResponseDtoSchema,
  evaluationRequestSchema,
  setupTransitionRequestSchema,
} from '@veltrixeye/contracts';
import { api, ApiError } from '../lib/api';
import { classifyApiError, describeApiError, fieldErrorsFromApiError } from '../lib/api-errors';

const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const SETUP_ID = '33333333-3333-4333-8333-333333333333';
const ANCHOR = 1716206400000;

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

/** Every M7.1 call must be same-origin and session-credentialed. */
test('every M7.1 call is same-origin /api with same-origin credentials', async () => {
  await api.evaluateVersion(STRATEGY_ID, VERSION_ID, { asOf: ANCHOR });
  await api.detectSetup(STRATEGY_ID, VERSION_ID, {
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    asOf: ANCHOR,
  });
  await api.getSetup(SETUP_ID);
  await api.listSetupScores(SETUP_ID);
  await api.scoreSetup(SETUP_ID, { asOf: ANCHOR });
  await api.transitionSetup(SETUP_ID, { toState: 'triggered', asOf: ANCHOR });

  assert.equal(calls.length, 6, 'six calls issued');
  for (const call of calls) {
    assert.ok(call.url.startsWith('/api/'), `same-origin path: ${call.url}`);
    assert.equal(call.init?.credentials, 'same-origin', `credentials on ${call.url}`);
  }
  // The session cookie is the only credential the browser holds — no headers
  // carrying tokens or keys are ever attached by the client.
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('x-api-key'), null);
  }
});

// ---------------------------------------------------------------------------
// Evaluate (M3)
// ---------------------------------------------------------------------------

test('api.evaluateVersion() — POST …/evaluate with exactly { asOf }', async () => {
  await api.evaluateVersion(STRATEGY_ID, VERSION_ID, { asOf: ANCHOR });
  const call = only();
  assert.equal(call.url, `/api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/evaluate`);
  assert.equal(call.init?.method, 'POST');
  assert.equal(contentTypeOf(call), 'application/json');
  const body = JSON.parse(String(call.init?.body));
  assert.deepEqual(body, { asOf: ANCHOR });
  assert.deepEqual(evaluationRequestSchema.parse(body), { asOf: ANCHOR }, 'body matches the shared contract schema');

  // The evaluator takes no client-side instrument or scope input at all.
  assert.deepEqual(Object.keys(body), ['asOf']);
});

test('api.evaluateVersion() — omitting the anchor still sends an explicit {} body', async () => {
  await api.evaluateVersion(STRATEGY_ID, VERSION_ID);
  const call = only();
  assert.equal(call.init?.body, '{}', 'never a body-less POST with a JSON content-type');
  assert.equal(contentTypeOf(call), 'application/json');
  assert.deepEqual(evaluationRequestSchema.parse(JSON.parse(String(call.init?.body))), {});
});

// ---------------------------------------------------------------------------
// Detect (M4)
// ---------------------------------------------------------------------------

test('api.detectSetup() — POST …/detect with the exact detection body', async () => {
  await api.detectSetup(STRATEGY_ID, VERSION_ID, {
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'long',
    asOf: ANCHOR,
  });
  const call = only();
  assert.equal(call.url, `/api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/detect`);
  assert.equal(call.init?.method, 'POST');
  assert.equal(contentTypeOf(call), 'application/json');
  const body = JSON.parse(String(call.init?.body));
  assert.deepEqual(body, {
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'long',
    asOf: ANCHOR,
  });
  assert.equal(detectionRequestSchema.safeParse(body).success, true);
});

test('api.detectSetup() — the direction key is absent when both directions are requested', async () => {
  await api.detectSetup(STRATEGY_ID, VERSION_ID, {
    instrument: { assetClass: 'index', symbol: 'US500' },
    asOf: ANCHOR,
  });
  const body = JSON.parse(String(only().init?.body));
  assert.deepEqual(body, { instrument: { assetClass: 'index', symbol: 'US500' }, asOf: ANCHOR });
  assert.ok(!('direction' in body), 'an omitted direction is the API default (both)');
});

test('api.detectSetup() — the replay flag is passed through untouched', async () => {
  respond(
    detectionResponseDtoSchema.parse({
      strategyId: STRATEGY_ID,
      versionId: VERSION_ID,
      versionNumber: 3,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      asOfMs: ANCHOR,
      detectorVersion: 'm4-setup-detect-1',
      engineVersion: 'm3-deterministic-eval-1',
      detections: [
        { direction: 'long', qualified: false, setup: null, created: false, failureReasons: ['no BOS at the anchor'] },
      ],
    }),
  );
  const result = await api.detectSetup(STRATEGY_ID, VERSION_ID, {
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    asOf: ANCHOR,
  });
  assert.equal(result.detections[0]?.setup, null);
  assert.equal(result.detections[0]?.created, false, 'a non-qualifying detection is never a created setup');
  assert.equal(result.detectorVersion, 'm4-setup-detect-1');
});

// ---------------------------------------------------------------------------
// Setups (M4 read) + scores (M5)
// ---------------------------------------------------------------------------

test('api.getSetup() — GET /api/setups/:id, body-less and URL-encoded', async () => {
  await api.getSetup(SETUP_ID);
  let call = only();
  assert.equal(call.url, `/api/setups/${SETUP_ID}`);
  assert.equal(call.init?.body, undefined);
  assert.equal(contentTypeOf(call), null);

  calls = [];
  await api.getSetup('not/a-uuid');
  call = only();
  assert.equal(call.url, '/api/setups/not%2Fa-uuid', 'the id is encoded into a single path segment');
});

test('api.listSetupScores() — GET /api/setups/:id/scores, limit clamped to the contract maximum', async () => {
  await api.listSetupScores(SETUP_ID);
  const call = only();
  assert.equal(call.url, `/api/setups/${SETUP_ID}/scores`);
  assert.equal(call.init?.body, undefined);

  calls = [];
  await api.listSetupScores(SETUP_ID, 1000);
  assert.equal(only().url, `/api/setups/${SETUP_ID}/scores?limit=${MAX_SCORE_HISTORY_LIMIT}`);

  calls = [];
  await api.listSetupScores(SETUP_ID, 0);
  assert.equal(only().url, `/api/setups/${SETUP_ID}/scores?limit=1`, 'a nonsense limit is clamped, not forwarded');
});

test('api.scoreSetup() — POST /api/setups/:id/score with {} or an explicit anchor', async () => {
  await api.scoreSetup(SETUP_ID);
  let call = only();
  assert.equal(call.url, `/api/setups/${SETUP_ID}/score`);
  assert.equal(call.init?.method, 'POST');
  assert.equal(call.init?.body, '{}', 'omitting asOf means "the setup’s own detection anchor"');
  assert.equal(contentTypeOf(call), 'application/json');

  calls = [];
  await api.scoreSetup(SETUP_ID, { asOf: ANCHOR });
  call = only();
  assert.deepEqual(JSON.parse(String(call.init?.body)), { asOf: ANCHOR });
});

test('api.scoreSetup() — the created/replay flag and score row are passed through', async () => {
  respond({
    setup: {
      id: SETUP_ID,
      strategyId: STRATEGY_ID,
      strategyVersionId: VERSION_ID,
      versionNumber: 3,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      state: 'confirmed',
      direction: 'long',
      asOfMs: ANCHOR,
      detectedAt: '2024-05-20T12:00:00.000Z',
      updatedAt: '2024-05-20T12:00:00.000Z',
      expiresAt: null,
      entryPrice: 1.085,
      stopLossPrice: 1.08,
      tp1Price: 1.095,
      tp2Price: 1.105,
      tp3Price: 1.12,
      qualityScore: 82,
      metadata: { detectorVersion: 'm4-setup-detect-1' },
    },
    score: {
      id: 17,
      setupId: SETUP_ID,
      engineVersion: 'm5-quality-score-1',
      asOfMs: ANCHOR,
      total: 82,
      grade: 'A',
      components: [
        { name: 'structure_quality', label: 'Structure quality', weight: 1, score: 82, points: 82, maxPoints: 100, explanation: 'structure confirmed' },
      ],
      createdAt: '2024-05-20T12:00:00.000Z',
    },
    created: false,
  });
  const res = await api.scoreSetup(SETUP_ID, { asOf: ANCHOR });
  assert.equal(res.created, false, 'a replay stays a replay');
  assert.equal(res.score.total, 82);
  assert.equal(res.score.engineVersion, 'm5-quality-score-1');
});

// ---------------------------------------------------------------------------
// Transitions (M4 lifecycle)
// ---------------------------------------------------------------------------

test('api.transitionSetup() — POST /api/setups/:id/transitions with { toState, asOf, reason? }', async () => {
  await api.transitionSetup(SETUP_ID, { toState: 'triggered', asOf: ANCHOR, reason: 'entry hit at the anchor' });
  const call = only();
  assert.equal(call.url, `/api/setups/${SETUP_ID}/transitions`);
  assert.equal(call.init?.method, 'POST');
  assert.equal(contentTypeOf(call), 'application/json');
  const body = JSON.parse(String(call.init?.body));
  assert.deepEqual(body, { toState: 'triggered', asOf: ANCHOR, reason: 'entry hit at the anchor' });
  assert.equal(setupTransitionRequestSchema.safeParse(body).success, true);

  calls = [];
  await api.transitionSetup(SETUP_ID, { toState: 'invalidated', asOf: ANCHOR });
  const withoutReason = JSON.parse(String(only().init?.body));
  assert.deepEqual(withoutReason, { toState: 'invalidated', asOf: ANCHOR });
  assert.ok(!('reason' in withoutReason), 'an empty reason is omitted rather than sent as an empty string');
});

// ---------------------------------------------------------------------------
// Error surfacing
// ---------------------------------------------------------------------------

test('a masked 404 on a setup surfaces the API’s own safe message', async () => {
  respond({ error: { code: 'not_found', message: 'Setup not found' } }, 404);
  await assert.rejects(
    () => api.getSetup(SETUP_ID),
    (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 404);
      assert.equal(classifyApiError(e), 'not_found');
      assert.equal(describeApiError(e), 'Setup not found');
      return true;
    },
  );
});

test('a rate-limited detect surfaces as a rate-limit message, not a generic failure', async () => {
  respond({ error: { code: 'rate_limited', message: 'Rate limit exceeded. Try again in 42s.' } }, 429);
  await assert.rejects(
    () => api.detectSetup(STRATEGY_ID, VERSION_ID, { instrument: { assetClass: 'forex', symbol: 'EURUSD' }, asOf: ANCHOR }),
    (e: unknown) => {
      assert.equal(classifyApiError(e), 'rate_limited');
      assert.match(describeApiError(e), /Rate limit exceeded/);
      return true;
    },
  );
});

test('a rejected transition keeps the API’s state-machine message and field errors', async () => {
  respond(
    {
      error: {
        code: 'invalid_input',
        message: 'Cannot transition setup from "confirmed" to "completed". Allowed: triggered, invalidated, expired.',
        fields: { body: ['Invalid transition'] },
      },
    },
    400,
  );
  await assert.rejects(
    () => api.transitionSetup(SETUP_ID, { toState: 'completed', asOf: ANCHOR }),
    (e: unknown) => {
      assert.equal(classifyApiError(e), 'invalid_input');
      assert.match(describeApiError(e), /Allowed: triggered, invalidated, expired/);
      assert.deepEqual(fieldErrorsFromApiError(e), { body: 'Invalid transition' });
      return true;
    },
  );
});

test('a 500 on evaluate renders the generic fallback — no internals, no field errors', async () => {
  respond({ error: { code: 'internal', message: 'An unexpected error occurred' } }, 500);
  await assert.rejects(
    () => api.evaluateVersion(STRATEGY_ID, VERSION_ID, { asOf: ANCHOR }),
    (e: unknown) => {
      assert.equal(classifyApiError(e), 'server');
      const text = describeApiError(e, 'The evaluation could not be run. Nothing was stored.');
      assert.equal(text, 'The evaluation could not be run. Nothing was stored.');
      assert.ok(!/at |stack|postgres|pg_/i.test(text), 'no internals leak into the copy');
      assert.deepEqual(fieldErrorsFromApiError(e), {}, 'a server error is never painted as a field mistake');
      return true;
    },
  );
});
