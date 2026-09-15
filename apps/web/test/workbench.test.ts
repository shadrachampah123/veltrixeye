/**
 * M7.1 — core-workflow helpers.
 *
 * These are the rules the UI must not get wrong:
 *  - the anchor is explicit (parsed from the field, echoed as raw epoch-ms) and
 *    request bodies are validated with the SHARED contract schemas;
 *  - lifecycle options come from `SETUP_TRANSITIONS`, and terminal states offer
 *    nothing;
 *  - a replayed detection or score is never described as new.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_STATES,
  SETUP_TERMINAL_STATES,
  SETUP_TRANSITIONS,
  detectionItemDtoSchema,
  detectionResponseDtoSchema,
  directionEvaluationSchema,
  evaluationResultSchema,
  setupDtoSchema,
  type DirectionEvaluation,
  type EvaluationResultDto,
  type SetupDto,
  type StrategyDetailDto,
  type StrategyVersionDetailDto,
} from '@veltrixeye/contracts';
import {
  anchorInputValue,
  anchorReadout,
  anchorValidationError,
  allowedTransitions,
  buildDetectBody,
  buildEvaluateBody,
  buildTransitionBody,
  defaultAnchorMs,
  describeDetectionItem,
  describeScoreOutcome,
  describeTransitionOutcome,
  detectInstrumentChoices,
  detectionSummaryText,
  directionSummaryText,
  evaluationSummaryText,
  evaluableVersions,
  instrumentKey,
  isTerminalSetupState,
  parseAnchorValue,
  setupAnchorText,
  setupDetectorVersion,
  setupLevelRows,
  setupStateLabel,
  summariseDirection,
  tallyDetections,
  transitionOptions,
  versionLabel,
} from '../lib/workbench';

const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const SETUP_ID = '33333333-3333-4333-8333-333333333333';
const ANCHOR = Date.UTC(2024, 4, 20, 12, 0, 0);
const ANCHOR_INPUT = '2024-05-20T12:00';

// ---------------------------------------------------------------------------
// Anchor
// ---------------------------------------------------------------------------

test('the default anchor is the current minute, never a drifting clock read', () => {
  assert.equal(defaultAnchorMs(Date.UTC(2024, 4, 20, 12, 0, 37, 512)), ANCHOR);
  assert.equal(defaultAnchorMs(1716206437999), 1716206400000);
});

test('anchor values round-trip through the datetime-local field', () => {
  assert.equal(anchorInputValue(ANCHOR), ANCHOR_INPUT);
  assert.equal(parseAnchorValue(ANCHOR_INPUT), ANCHOR);
  assert.equal(parseAnchorValue(''), null);
  assert.equal(parseAnchorValue('not a date'), null);
});

test('the anchor readout prints the exact instant that will be sent', () => {
  assert.equal(anchorReadout(ANCHOR), '2024-05-20T12:00:00.000Z · 1716206400000 epoch ms');
});

test('anchor validation distinguishes an empty field from an unparseable one', () => {
  assert.equal(anchorValidationError('', null), 'Set an anchor date and time.');
  assert.match(String(anchorValidationError('???', null)), /not a valid date/);
  assert.equal(anchorValidationError(ANCHOR_INPUT, ANCHOR), null);
});

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

test('buildEvaluateBody pins the anchor and rejects a missing one', () => {
  const built = buildEvaluateBody(ANCHOR);
  assert.equal(built.ok, true);
  assert.deepEqual(built.ok && built.body, { asOf: ANCHOR });

  const missing = buildEvaluateBody(null);
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.error : '', /anchor/i);
});

test('buildDetectBody sends { instrument, asOf } and omits an unset direction', () => {
  const built = buildDetectBody({ assetClass: 'forex', symbol: 'eurusd', direction: '', asOfMs: ANCHOR });
  assert.equal(built.ok, true);
  assert.deepEqual(built.ok && built.body, {
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    asOf: ANCHOR,
  });
  assert.ok(built.ok && !('direction' in built.body), 'both directions means the key is absent');

  const directed = buildDetectBody({ assetClass: 'forex', symbol: 'EURUSD', direction: 'short', asOfMs: ANCHOR });
  assert.deepEqual(directed.ok && directed.body, {
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'short',
    asOf: ANCHOR,
  });
});

test('buildDetectBody refuses to guess an instrument or an anchor', () => {
  const noInstrument = buildDetectBody({ assetClass: '', symbol: '', direction: '', asOfMs: ANCHOR });
  assert.equal(noInstrument.ok, false);
  assert.match(noInstrument.ok === false ? noInstrument.error : '', /instrument/i);

  const noAnchor = buildDetectBody({ assetClass: 'forex', symbol: 'EURUSD', direction: '', asOfMs: null });
  assert.equal(noAnchor.ok, false);
  assert.match(noAnchor.ok === false ? noAnchor.error : '', /anchor/i);
});

test('buildTransitionBody requires a state and an anchor, and trims or omits the reason', () => {
  const withReason = buildTransitionBody({ toState: 'triggered', asOfMs: ANCHOR, reason: '  entry hit  ' });
  assert.deepEqual(withReason.ok && withReason.body, { toState: 'triggered', asOf: ANCHOR, reason: 'entry hit' });

  const withoutReason = buildTransitionBody({ toState: 'invalidated', asOfMs: ANCHOR, reason: '   ' });
  assert.deepEqual(withoutReason.ok && withoutReason.body, { toState: 'invalidated', asOf: ANCHOR });

  assert.equal(buildTransitionBody({ toState: '', asOfMs: ANCHOR, reason: '' }).ok, false);
  assert.equal(buildTransitionBody({ toState: 'triggered', asOfMs: null, reason: '' }).ok, false);
  assert.equal(buildTransitionBody({ toState: 'triggered', asOfMs: ANCHOR, reason: 'x'.repeat(281) }).ok, false);
});

// ---------------------------------------------------------------------------
// Lifecycle vocabulary
// ---------------------------------------------------------------------------

test('transition options are exactly the state machine’s, and terminal states offer none', () => {
  for (const state of SETUP_STATES) {
    assert.deepEqual(transitionOptions(state), [...SETUP_TRANSITIONS[state]], `options for ${state}`);
    assert.ok(!transitionOptions(state).includes(state), 'a state never transitions to itself in the UI');
  }
  for (const terminal of SETUP_TERMINAL_STATES) {
    assert.equal(isTerminalSetupState(terminal), true);
    assert.deepEqual(allowedTransitions(terminal), [], `${terminal} is terminal`);
  }
  assert.deepEqual(transitionOptions('confirmed'), ['triggered', 'invalidated', 'expired']);
  assert.equal(isTerminalSetupState('watching'), false);
});

test('state labels are human-readable and unknown states are passed through', () => {
  assert.equal(setupStateLabel('almost_ready'), 'Almost ready');
  assert.equal(setupStateLabel('mystery'), 'mystery');
});

// ---------------------------------------------------------------------------
// Version selection
// ---------------------------------------------------------------------------

function strategyFixture(): StrategyDetailDto {
  return {
    id: STRATEGY_ID,
    name: 'London Breakout',
    description: null,
    status: 'active',
    currentVersionId: VERSION_ID,
    versionCount: 3,
    createdAt: '2024-05-01T00:00:00.000Z',
    updatedAt: '2024-05-01T00:00:00.000Z',
    versions: [
      { id: VERSION_ID, strategyId: STRATEGY_ID, versionNumber: 3, status: 'published', changelog: null, isCurrent: true, createdAt: '2024-05-01T00:00:00.000Z', publishedAt: '2024-05-02T00:00:00.000Z' },
      { id: '22222222-2222-4222-8222-222222222223', strategyId: STRATEGY_ID, versionNumber: 2, status: 'deprecated', changelog: null, isCurrent: false, createdAt: '2024-04-01T00:00:00.000Z', publishedAt: '2024-04-02T00:00:00.000Z' },
      { id: '22222222-2222-4222-8222-222222222224', strategyId: STRATEGY_ID, versionNumber: 4, status: 'draft', changelog: null, isCurrent: false, createdAt: '2024-05-10T00:00:00.000Z', publishedAt: null },
    ],
    currentVersion: null,
  };
}

test('only published or deprecated versions are offered to the engines', () => {
  const versions = evaluableVersions(strategyFixture());
  assert.deepEqual(
    versions.map((v) => v.versionNumber),
    [3, 2],
    'the draft is not evaluable',
  );
  assert.equal(versionLabel(versions[0]!), 'v3 · published · current');
  assert.equal(versionLabel(versions[1]!), 'v2 · deprecated');
});

function versionFixture(overrides: Partial<StrategyVersionDetailDto['config']> = {}): StrategyVersionDetailDto {
  return {
    id: VERSION_ID,
    strategyId: STRATEGY_ID,
    versionNumber: 3,
    status: 'published',
    changelog: null,
    isCurrent: true,
    createdAt: '2024-05-01T00:00:00.000Z',
    publishedAt: '2024-05-02T00:00:00.000Z',
    config: {
      sessionFilters: [],
      filters: [],
      ruleGroups: [],
      ...overrides,
    },
  };
}

function evaluationFixture(): EvaluationResultDto {
  return evaluationResultSchema.parse({
    strategyId: STRATEGY_ID,
    versionId: VERSION_ID,
    versionNumber: 3,
    engineVersion: 'm3-deterministic-eval-1',
    asOfMs: ANCHOR,
    evaluatedAt: new Date(ANCHOR).toISOString(),
    instruments: [
      {
        assetClass: 'forex',
        symbol: 'EURUSD',
        directions: {
          long: {
            direction: 'long',
            passed: true,
            groups: [],
            sessionFilters: [],
            candidate: null,
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
      {
        assetClass: 'forex',
        symbol: 'GBPUSD',
        directions: {
          long: { direction: 'long', passed: false, groups: [], sessionFilters: [], candidate: null, failureReasons: [] },
          short: { direction: 'short', passed: false, groups: [], sessionFilters: [], candidate: null, failureReasons: [] },
        },
        anyPassed: false,
      },
    ],
    truncated: false,
    notes: [],
  });
}

test('detect instrument choices prefer the version’s declared scope', () => {
  const version = versionFixture({
    marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }] },
  });
  const choices = detectInstrumentChoices({ version, evaluation: evaluationFixture(), platformInstruments: [] });
  assert.equal(choices.source, 'scope');
  assert.deepEqual(choices.options, [{ assetClass: 'forex', symbol: 'EURUSD' }]);
  assert.match(choices.note, /market scope lists 1 instrument/);
});

test('scope “all” uses the instruments the evaluation actually covered', () => {
  const choices = detectInstrumentChoices({
    version: versionFixture({ marketScope: { mode: 'all' } }),
    evaluation: evaluationFixture(),
    platformInstruments: [{ assetClass: 'crypto', symbol: 'BTCUSD' }],
  });
  assert.equal(choices.source, 'evaluated');
  assert.deepEqual(
    choices.options.map(instrumentKey),
    ['forex/EURUSD', 'forex/GBPUSD'],
    'only the evaluated set — the platform list is not offered once a run exists',
  );
  assert.match(choices.note, /covered 2 instruments/);
});

test('before the first evaluation, scope “all” falls back to the platform list with a warning', () => {
  const choices = detectInstrumentChoices({
    version: versionFixture({ marketScope: { mode: 'all' } }),
    evaluation: null,
    platformInstruments: [{ assetClass: 'crypto', symbol: 'BTCUSD' }],
  });
  assert.equal(choices.source, 'platform');
  assert.deepEqual(choices.options, [{ assetClass: 'crypto', symbol: 'BTCUSD' }]);
  assert.match(choices.note, /evaluate at this anchor first/);
});

test('no instruments at all is an explicit empty state, not an invented list', () => {
  const choices = detectInstrumentChoices({
    version: versionFixture({ marketScope: { mode: 'all' } }),
    evaluation: null,
    platformInstruments: [],
  });
  assert.equal(choices.source, 'none');
  assert.deepEqual(choices.options, []);
  assert.match(choices.note, /Ingest candles/);
});

// ---------------------------------------------------------------------------
// Evaluation summaries
// ---------------------------------------------------------------------------

function directionFixture(): DirectionEvaluation {
  return directionEvaluationSchema.parse({
    direction: 'long',
    passed: false,
    groups: [
      {
        name: 'Trend',
        logic: 'AND',
        satisfied: false,
        relevance: 'pass',
        conditions: [
          { conditionType: 'bos', classification: 'required', timeframeRole: 'setup', status: 'satisfied', detail: 'BOS up' },
          { conditionType: 'fvg', classification: 'confirmation', timeframeRole: 'entry', status: 'insufficient_data', detail: 'not enough candles' },
          { conditionType: 'news_filter', classification: 'disqualifying', timeframeRole: 'any', status: 'unsupported', detail: 'no news calendar' },
        ],
      },
    ],
    sessionFilters: [],
    candidate: null,
    failureReasons: ['confirmation condition in insufficient_data'],
  });
}

test('direction summaries count the API’s own statuses', () => {
  const summary = summariseDirection(directionFixture());
  assert.deepEqual(summary, {
    direction: 'long',
    passed: false,
    satisfied: 1,
    unsatisfied: 0,
    insufficientData: 1,
    unsupported: 1,
  });
  assert.equal(directionSummaryText(summary), 'failed · 1 satisfied · 0 not satisfied · 1 insufficient data · 1 unsupported');
});

test('the run summary counts instruments with at least one passing direction', () => {
  assert.equal(evaluationSummaryText(evaluationFixture()), '2 instruments evaluated · 1 with a passing direction · 1 without');
});

// ---------------------------------------------------------------------------
// Detection outcomes
// ---------------------------------------------------------------------------

function setupFixture(): SetupDto {
  return setupDtoSchema.parse({
    id: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    state: 'confirmed',
    direction: 'long',
    asOfMs: ANCHOR,
    detectedAt: new Date(ANCHOR).toISOString(),
    updatedAt: new Date(ANCHOR).toISOString(),
    expiresAt: null,
    entryPrice: 1.085,
    stopLossPrice: 1.08,
    tp1Price: 1.095,
    tp2Price: 1.105,
    tp3Price: 1.12,
    qualityScore: 82,
    metadata: { detectorVersion: 'm4-setup-detect-1' },
  });
}

test('a created setup, a replay and a non-qualifying direction read differently', () => {
  const created = describeDetectionItem(
    detectionItemDtoSchema.parse({
      direction: 'long',
      qualified: true,
      setup: setupFixture(),
      created: true,
      failureReasons: [],
    }),
  );
  assert.equal(created.tone, 'success');
  assert.equal(created.title, 'Setup created');

  const replayed = describeDetectionItem(
    detectionItemDtoSchema.parse({
      direction: 'long',
      qualified: true,
      setup: setupFixture(),
      created: false,
      failureReasons: [],
    }),
  );
  assert.equal(replayed.tone, 'info');
  assert.match(replayed.title, /Existing setup returned/);
  assert.doesNotMatch(replayed.title + replayed.detail, /Setup created/i, 'a replay is never called created');

  const none = describeDetectionItem(
    detectionItemDtoSchema.parse({
      direction: 'short',
      qualified: false,
      setup: null,
      created: false,
      failureReasons: ['no CHoCH'],
    }),
  );
  assert.equal(none.tone, 'warning');
  assert.match(none.title, /No setup/);
});

test('the detection tally separates created, existing and no-setup outcomes', () => {
  const result = detectionResponseDtoSchema.parse({
    strategyId: STRATEGY_ID,
    versionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    asOfMs: ANCHOR,
    detectorVersion: 'm4-setup-detect-1',
    engineVersion: 'm3-deterministic-eval-1',
    detections: [
      { direction: 'long', qualified: true, setup: setupFixture(), created: false, failureReasons: [] },
      { direction: 'short', qualified: false, setup: null, created: false, failureReasons: ['no CHoCH'] },
    ],
  });
  assert.deepEqual(tallyDetections(result), { created: 0, existing: 1, none: 1 });
  assert.equal(detectionSummaryText(result), '0 created · 1 already existing · 1 without a setup');
});

// ---------------------------------------------------------------------------
// Score + transition outcomes
// ---------------------------------------------------------------------------

test('a replayed score is never described as new', () => {
  const created = describeScoreOutcome(true);
  assert.equal(created.tone, 'success');
  assert.equal(created.title, 'New score recorded');

  const replayed = describeScoreOutcome(false);
  assert.equal(replayed.tone, 'info');
  assert.match(replayed.title, /no new score row/);
  assert.doesNotMatch(replayed.detail, /new score row was written/);
});

test('a same-state transition is reported as a no-op', () => {
  const moved = describeTransitionOutcome({ transitioned: true, setup: setupFixture() });
  assert.equal(moved.tone, 'success');
  assert.match(moved.title, /moved to Confirmed/);

  const noop = describeTransitionOutcome({ transitioned: false, setup: setupFixture() });
  assert.equal(noop.tone, 'info');
  assert.match(noop.title, /nothing changed/);
  assert.match(noop.detail, /no event was written/);
});

// ---------------------------------------------------------------------------
// Setup facts
// ---------------------------------------------------------------------------

test('setup facts come from the DTO without inventing values', () => {
  const setup = setupFixture();
  assert.equal(setupDetectorVersion(setup), 'm4-setup-detect-1');
  assert.equal(setupDetectorVersion(setupDtoSchema.parse({ ...setup, metadata: {} })), null);
  assert.deepEqual(setupLevelRows(setup).map((row) => row.label), [
    'Entry',
    'Stop loss',
    'Take profit 1',
    'Take profit 2',
    'Take profit 3',
  ]);
  const unscored = setupDtoSchema.parse({ ...setup, qualityScore: null, tp3Price: null });
  assert.deepEqual(setupLevelRows(unscored)[4], { label: 'Take profit 3', value: null });
  assert.equal(setupAnchorText(setup), '2024-05-20T12:00:00.000Z · 1716206400000 epoch ms');
});
