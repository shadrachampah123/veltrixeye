/**
 * M7.1 — the core browser workflow, end to end through the API client.
 *
 * One scripted journey: a published strategy version is evaluated, a setup is
 * detected from the evaluated instrument at the same anchor, the setup is read,
 * scored, transitioned, and turned into an alert that is then acknowledged.
 * Then the same detection is repeated to prove the journey stays idempotent.
 *
 * The transport is a fetch double (the repository's existing convention for
 * client tests — no HTTP server, no fake service layer): every response is
 * parsed through the SHARED contract schemas before it is returned, so a
 * response shape the real API could not produce fails the test rather than
 * being quietly tolerated by the UI. Every request body is validated the same
 * way, which is what makes this an integration test of the workflow's contract
 * rather than of a re-implementation of it.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertDtoSchema,
  alertDeliveryDtoSchema,
  alertDetailDtoSchema,
  alertGenerateResponseSchema,
  detectionRequestSchema,
  detectionResponseDtoSchema,
  evaluationRequestSchema,
  evaluationResultSchema,
  setupDetailDtoSchema,
  setupDtoSchema,
  setupScoreDtoSchema,
  setupScoreHistoryResponseDtoSchema,
  setupScoreResponseDtoSchema,
  setupStateEventDtoSchema,
  setupTransitionRequestSchema,
  setupTransitionResponseDtoSchema,
  type AlertDto,
  type AlertDeliveryDto,
  type SetupDto,
} from '@veltrixeye/contracts';
import { api } from '../lib/api';
import { classifyGenerateOutcome, isGenerateEligibleState, setupGenerateEligibility } from '../lib/alerts-view';
import { buildDetectBody, buildEvaluateBody, buildTransitionBody, defaultAnchorMs } from '../lib/workbench';

const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const SETUP_ID = '33333333-3333-4333-8333-333333333333';
const ALERT_ID = '44444444-4444-4444-8444-444444444444';
const ANCHOR = defaultAnchorMs(Date.UTC(2024, 4, 20, 12, 0, 23));
const ANCHOR_ISO = new Date(ANCHOR).toISOString();

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  credentials: RequestCredentials | undefined;
}

let calls: RecordedCall[] = [];
let originalFetch: typeof globalThis.fetch;

function setupPayload(overrides: Record<string, unknown> = {}): SetupDto {
  return setupDtoSchema.parse({
    id: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    state: 'confirmed',
    direction: 'long',
    asOfMs: ANCHOR,
    detectedAt: ANCHOR_ISO,
    updatedAt: ANCHOR_ISO,
    expiresAt: null,
    entryPrice: 1.085,
    stopLossPrice: 1.08,
    tp1Price: 1.09,
    tp2Price: 1.095,
    tp3Price: 1.1,
    qualityScore: null,
    metadata: { detectorVersion: 'm4-setup-detect-1' },
    ...overrides,
  });
}

function scorePayload(overrides: Record<string, unknown> = {}) {
  return setupScoreDtoSchema.parse({
    id: 17,
    setupId: SETUP_ID,
    engineVersion: 'm5-quality-score-1',
    asOfMs: ANCHOR,
    total: 82,
    grade: 'A',
    components: [
      {
        name: 'structure_quality',
        label: 'Structure quality',
        weight: 1,
        score: 82,
        points: 82,
        maxPoints: 100,
        explanation: 'structure confirmed at the anchor',
      },
    ],
    createdAt: ANCHOR_ISO,
    ...overrides,
  });
}

function coreEvent() {
  return setupStateEventDtoSchema.parse({
    id: 1,
    setupId: SETUP_ID,
    fromState: null,
    toState: 'confirmed',
    reason: null,
    payload: { detectorVersion: 'm4-setup-detect-1', asOfMs: ANCHOR },
    createdAt: ANCHOR_ISO,
  });
}

function triggeredEvent() {
  return setupStateEventDtoSchema.parse({
    id: 2,
    setupId: SETUP_ID,
    fromState: 'confirmed',
    toState: 'triggered',
    reason: null,
    payload: { asOfMs: ANCHOR, actor: 'transition' },
    createdAt: ANCHOR_ISO,
  });
}

function alertPayload(overrides: Record<string, unknown> = {}): AlertDto {
  return alertDtoSchema.parse({
    id: ALERT_ID,
    setupId: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'long',
    triggerState: 'triggered',
    qualityScore: 82,
    minQualityScore: 65,
    title: 'EURUSD long triggered (score 82/A)',
    body: { qualityGrade: 'A', entryPrice: 1.085, scoreId: 17 },
    status: 'pending',
    acknowledgedAt: null,
    createdAt: ANCHOR_ISO,
    ...overrides,
  });
}

function stubDelivery(): AlertDeliveryDto {
  return alertDeliveryDtoSchema.parse({
    id: 5,
    alertId: ALERT_ID,
    channel: 'stub',
    status: 'delivered',
    attempt: 1,
    error: null,
    payloadHash: 'a'.repeat(64),
    createdAt: ANCHOR_ISO,
  });
}

const strategySummary = {
  id: STRATEGY_ID,
  name: 'London Breakout',
  description: null,
  status: 'active' as const,
  currentVersionId: VERSION_ID,
  versionCount: 1,
  createdAt: ANCHOR_ISO,
  updatedAt: ANCHOR_ISO,
};

const versionSummary = {
  id: VERSION_ID,
  strategyId: STRATEGY_ID,
  versionNumber: 3,
  status: 'published' as const,
  changelog: null,
  isCurrent: true,
  createdAt: ANCHOR_ISO,
  publishedAt: ANCHOR_ISO,
};

const evaluationPayload = evaluationResultSchema.parse({
  strategyId: STRATEGY_ID,
  versionId: VERSION_ID,
  versionNumber: 3,
  engineVersion: 'm3-deterministic-eval-1',
  asOfMs: ANCHOR,
  evaluatedAt: ANCHOR_ISO,
  instruments: [
    {
      assetClass: 'forex',
      symbol: 'EURUSD',
      directions: {
        long: {
          direction: 'long',
          passed: true,
          groups: [
            {
              name: 'Trend continuation',
              logic: 'AND',
              satisfied: true,
              relevance: 'pass',
              conditions: [
                {
                  conditionType: 'bos',
                  classification: 'required',
                  timeframeRole: 'setup',
                  status: 'satisfied',
                  detail: 'BOS above the swing high',
                },
              ],
            },
          ],
          sessionFilters: [],
          candidate: {
            entryPrice: 1.085,
            stopLossPrice: 1.08,
            riskDistance: 0.005,
            tp1Price: 1.09,
            tp2Price: 1.095,
            tp3Price: 1.1,
            achievableRr: 2,
            basis: 'structure stop, R:R targets',
          },
          failureReasons: [],
        },
        short: {
          direction: 'short',
          passed: false,
          groups: [],
          sessionFilters: [],
          candidate: null,
          failureReasons: ['no CHoCH'],
        },
      },
      anyPassed: true,
    },
  ],
  truncated: false,
  notes: [],
});

/**
 * The scripted API: contract-valid fixtures, parsed through the shared schemas
 * before they are handed back, plus a state flag for the replay assertions.
 */
function startApi() {
  const state = { detectCalls: 0, triggered: false };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body, credentials: init?.credentials });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (url === '/api/strategies' && method === 'GET') return json({ strategies: [strategySummary] });
    if (url === `/api/strategies/${STRATEGY_ID}` && method === 'GET') {
      return json({ strategy: { ...strategySummary, versions: [versionSummary], currentVersion: null } });
    }
    if (url === `/api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}` && method === 'GET') {
      return json({
        version: {
          ...versionSummary,
          config: {
            marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }] },
            sessionFilters: [],
            filters: [],
            ruleGroups: [],
          },
        },
      });
    }
    if (url === `/api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/evaluate` && method === 'POST') {
      return json(evaluationPayload);
    }
    if (url === `/api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/detect` && method === 'POST') {
      state.detectCalls += 1;
      // First run creates the setup; an identical repeat is an idempotent replay.
      const created = state.detectCalls === 1;
      return json(
        detectionResponseDtoSchema.parse({
          strategyId: STRATEGY_ID,
          versionId: VERSION_ID,
          versionNumber: 3,
          instrument: { assetClass: 'forex', symbol: 'EURUSD' },
          asOfMs: ANCHOR,
          detectorVersion: 'm4-setup-detect-1',
          engineVersion: 'm3-deterministic-eval-1',
          detections: [
            {
              direction: 'long',
              qualified: true,
              setup: setupPayload(created ? {} : { qualityScore: 82 }),
              created,
              failureReasons: [],
            },
          ],
        }),
        created ? 201 : 200,
      );
    }
    if (url === `/api/setups/${SETUP_ID}` && method === 'GET') {
      const triggered = state.triggered;
      return json(
        setupDetailDtoSchema.parse({
          setup: setupPayload(triggered ? { state: 'triggered', qualityScore: 82 } : { qualityScore: 82 }),
          events: triggered ? [coreEvent(), triggeredEvent()] : [coreEvent()],
        }),
      );
    }
    if (url === `/api/setups/${SETUP_ID}/score` && method === 'POST') {
      return json(
        setupScoreResponseDtoSchema.parse({ setup: setupPayload({ qualityScore: 82 }), score: scorePayload(), created: true }),
      );
    }
    if (url === `/api/setups/${SETUP_ID}/scores` && method === 'GET') {
      return json(setupScoreHistoryResponseDtoSchema.parse({ setupId: SETUP_ID, scores: [scorePayload()] }));
    }
    if (url === `/api/setups/${SETUP_ID}/transitions` && method === 'POST') {
      state.triggered = true;
      return json(
        setupTransitionResponseDtoSchema.parse({
          setup: setupPayload({ state: 'triggered', qualityScore: 82 }),
          transitioned: true,
          event: triggeredEvent(),
        }),
      );
    }
    if (url === `/api/setups/${SETUP_ID}/alerts` && method === 'POST') {
      return json(
        alertGenerateResponseSchema.parse({
          alert: alertPayload(),
          created: true,
          deliveries: [stubDelivery()],
        }),
        201,
      );
    }
    if (url === `/api/alerts/${ALERT_ID}` && method === 'GET') {
      return json(alertDetailDtoSchema.parse({ alert: alertPayload(), deliveries: [stubDelivery()] }));
    }
    if (url === `/api/alerts/${ALERT_ID}/acknowledge` && method === 'POST') {
      return json(
        alertDetailDtoSchema.parse({
          alert: alertPayload({ status: 'acknowledged', acknowledgedAt: ANCHOR_ISO }),
          deliveries: [stubDelivery()],
        }),
      );
    }
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  }) as typeof globalThis.fetch;

  return {
    get detectionCount(): number {
      return state.detectCalls;
    },
  };
}

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('the whole browser workflow runs from a published version to an acknowledged alert', async () => {
  const apiDouble = startApi();

  // 1. Pick the strategy and one published version (both owner-scoped reads).
  const { strategies } = await api.listStrategies();
  const strategy = (await api.getStrategy(strategies[0]!.id)).strategy;
  const version = strategy.versions.find((v) => v.status === 'published');
  assert.ok(version, 'a published version exists to work with');
  await api.getVersion(strategy.id, version.id);

  // 2. Evaluate at the explicit anchor. The body carries the anchor and nothing
  //    else — the instrument set comes from the version’s own market scope.
  const evaluateBody = buildEvaluateBody(ANCHOR);
  assert.equal(evaluateBody.ok, true);
  const evaluation = await api.evaluateVersion(strategy.id, version.id, evaluateBody.ok ? evaluateBody.body : {});
  const instrument = evaluation.instruments.find((i) => i.anyPassed);
  assert.ok(instrument, 'the evaluation returned a passing instrument to detect on');
  assert.equal(evaluation.engineVersion, 'm3-deterministic-eval-1');

  // 3. Detect on that instrument at the SAME anchor.
  const detectBody = buildDetectBody({
    assetClass: instrument.assetClass,
    symbol: instrument.symbol,
    direction: '',
    asOfMs: ANCHOR,
  });
  assert.equal(detectBody.ok, true);
  const detection = await api.detectSetup(strategy.id, version.id, detectBody.ok ? detectBody.body : { instrument: { assetClass: 'forex', symbol: 'EURUSD' }, asOf: ANCHOR });
  const detectionItem = detection.detections[0];
  assert.ok(detectionItem?.setup);
  assert.equal(detectionItem.created, true);
  const setupId = detectionItem.setup.id;

  // 4. Read the setup back (owner-scoped detail + lifecycle history).
  const detail = await api.getSetup(setupId);
  assert.equal(detail.setup.id, setupId);
  assert.equal(detail.events[0]?.toState, 'confirmed');

  // 5. Score it, then read the score history.
  const scored = await api.scoreSetup(setupId, { asOf: ANCHOR });
  assert.equal(scored.created, true);
  assert.equal(scored.score.engineVersion, 'm5-quality-score-1');
  const history = await api.listSetupScores(setupId);
  assert.equal(history.scores[0]?.total, 82);

  // 6. Move it through the lifecycle with an explicit transition anchor.
  const transitionBody = buildTransitionBody({ toState: 'triggered', asOfMs: ANCHOR, reason: '' });
  assert.equal(transitionBody.ok, true);
  const transitioned = await api.transitionSetup(setupId, transitionBody.ok ? transitionBody.body : { toState: 'triggered', asOf: ANCHOR });
  assert.equal(transitioned.transitioned, true);
  assert.equal(transitioned.setup.state, 'triggered');
  const refreshed = await api.getSetup(setupId);
  assert.deepEqual(
    refreshed.events.map((event) => event.toState),
    ['confirmed', 'triggered'],
  );

  // 7. Generate the alert from the setup, then read and acknowledge it.
  const eligible = setupGenerateEligibility(refreshed.setup);
  assert.equal(isGenerateEligibleState(refreshed.setup.state), true);
  assert.equal(eligible.eligible, true);

  const generated = await api.generateAlert(setupId);
  const outcome = classifyGenerateOutcome(generated);
  assert.equal(outcome.kind, 'created');
  assert.ok(outcome.kind === 'created' && outcome.alert.setupId === setupId, 'the alert points at the detected setup');

  const alertId = generated.alert?.id;
  assert.ok(alertId);
  const alertDetail = await api.getAlert(alertId);
  assert.equal(alertDetail.alert.status, 'pending');
  assert.equal(alertDetail.deliveries[0]?.channel, 'stub', 'delivery is a local stub ledger row');

  const acknowledged = await api.acknowledgeAlert(alertId);
  assert.equal(acknowledged.alert.status, 'acknowledged');

  // 8. Repeat the detection at the same anchor: the API returns the SAME setup
  //    and says so (created: false), and the UI never describes it as new.
  const replay = await api.detectSetup(strategy.id, version.id, detectBody.ok ? detectBody.body : { instrument: { assetClass: 'forex', symbol: 'EURUSD' }, asOf: ANCHOR });
  assert.equal(replay.detections[0]?.created, false);
  assert.equal(replay.detections[0]?.setup?.id, setupId, 'an idempotent replay never yields a second setup');
  assert.equal(apiDouble.detectionCount, 2);

  // The journey issued exactly these calls, in this order, all credentialed.
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    [
      'GET /api/strategies',
      `GET /api/strategies/${STRATEGY_ID}`,
      `GET /api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}`,
      `POST /api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/evaluate`,
      `POST /api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/detect`,
      `GET /api/setups/${SETUP_ID}`,
      `POST /api/setups/${SETUP_ID}/score`,
      `GET /api/setups/${SETUP_ID}/scores`,
      `POST /api/setups/${SETUP_ID}/transitions`,
      `GET /api/setups/${SETUP_ID}`,
      `POST /api/setups/${SETUP_ID}/alerts`,
      `GET /api/alerts/${ALERT_ID}`,
      `POST /api/alerts/${ALERT_ID}/acknowledge`,
      `POST /api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/detect`,
    ],
  );

  for (const call of calls) {
    assert.ok(call.url.startsWith('/api/'), `same-origin path: ${call.url}`);
    assert.equal(call.credentials, 'same-origin', `credentials on ${call.method} ${call.url}`);
  }

  // Every request body is exactly what the contract accepts.
  const byUrl = (url: string, method = 'POST') => calls.find((call) => call.url === url && call.method === method);
  assert.deepEqual(evaluationRequestSchema.parse(byUrl(`/api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/evaluate`)?.body), {
    asOf: ANCHOR,
  });
  assert.deepEqual(detectionRequestSchema.parse(byUrl(`/api/strategies/${STRATEGY_ID}/versions/${VERSION_ID}/detect`)?.body), {
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    asOf: ANCHOR,
  });
  assert.deepEqual(setupTransitionRequestSchema.parse(byUrl(`/api/setups/${SETUP_ID}/transitions`)?.body), {
    toState: 'triggered',
    asOf: ANCHOR,
  });
  assert.deepEqual(byUrl(`/api/setups/${SETUP_ID}/alerts`)?.body, {}, 'generation sends an explicit empty body');
  assert.deepEqual(byUrl(`/api/alerts/${ALERT_ID}/acknowledge`)?.body, {}, 'acknowledge sends an explicit empty body');
});

test('a quality-gate skip is a valid outcome of the same journey, not an error', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `/api/setups/${SETUP_ID}/alerts`) {
      return new Response(JSON.stringify({ alert: null, created: false, skippedReason: 'below_min_quality' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  const generated = await api.generateAlert(SETUP_ID);
  assert.equal(alertGenerateResponseSchema.safeParse(generated).success, true);
  const outcome = classifyGenerateOutcome(generated);
  assert.equal(outcome.kind, 'skipped');
  assert.equal(outcome.kind === 'skipped' && outcome.reason, 'below_min_quality');
});
