/**
 * M7.1 — setup list + setup detail render tests.
 *
 * The rules these pin down:
 *  - an empty list never implies a scanner exists, and a filtered empty list
 *    says so instead of looking like "no setups";
 *  - the detail panels render only API values (levels, anchors, grades,
 *    component points, event history);
 *  - a terminal setup offers NO actions — scoring is refused by the API and the
 *    state machine has no outbound transition;
 *  - a replayed score and a skipped alert are never described as new;
 *  - the alert card keeps M6's truthful stub wording (nothing is delivered).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  alertDtoSchema,
  setupDtoSchema,
  setupScoreDtoSchema,
  setupStateEventDtoSchema,
  type AlertDto,
  type SetupDto,
  type SetupScoreDto,
  type SetupStateEventDto,
} from '@veltrixeye/contracts';
import {
  SetupsNeverDetectedState,
  SetupsTable,
  SetupAlertPanel,
  SetupEventTimeline,
  SetupLevelsCard,
  SetupScorePanel,
  SetupSummaryCard,
  SetupTransitionPanel,
} from '../components/setup-panels';
import { classifyGenerateOutcome } from '../lib/alerts-view';

const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const SETUP_ID = '33333333-3333-4333-8333-333333333333';
const ALERT_ID = '44444444-4444-4444-8444-444444444444';
const ANCHOR = Date.UTC(2024, 4, 20, 12, 0, 0);
const noop = () => {};

function setupFixture(overrides: Record<string, unknown> = {}): SetupDto {
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
    expiresAt: '2024-05-21T12:00:00.000Z',
    entryPrice: 1.085,
    stopLossPrice: 1.08,
    tp1Price: 1.09,
    tp2Price: 1.095,
    tp3Price: 1.1,
    qualityScore: 82,
    metadata: { detectorVersion: 'm4-setup-detect-1' },
    ...overrides,
  });
}

function scoreFixture(overrides: Record<string, unknown> = {}): SetupScoreDto {
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
        weight: 0.4,
        score: 90,
        points: 36,
        maxPoints: 40,
        explanation: 'structure confirmed with displacement',
      },
      {
        name: 'level_quality',
        label: 'Level quality',
        weight: 0.6,
        score: 77,
        points: 46,
        maxPoints: 60,
        explanation: 'entry sits on an unmitigated zone',
      },
    ],
    createdAt: new Date(ANCHOR).toISOString(),
    ...overrides,
  });
}

function eventFixture(overrides: Record<string, unknown> = {}): SetupStateEventDto {
  return setupStateEventDtoSchema.parse({
    id: 1,
    setupId: SETUP_ID,
    fromState: null,
    toState: 'confirmed',
    reason: null,
    payload: { detectorVersion: 'm4-setup-detect-1', asOfMs: ANCHOR },
    createdAt: new Date(ANCHOR).toISOString(),
    ...overrides,
  });
}

function alertFixture(overrides: Record<string, unknown> = {}): AlertDto {
  return alertDtoSchema.parse({
    id: ALERT_ID,
    setupId: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'long',
    triggerState: 'confirmed',
    qualityScore: 82,
    minQualityScore: 65,
    title: 'EURUSD long confirmed (score 82/A)',
    body: { qualityGrade: 'A', entryPrice: 1.085 },
    status: 'pending',
    acknowledgedAt: null,
    createdAt: new Date(ANCHOR).toISOString(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

test('SetupsTable distinguishes “nothing detected yet” from “no filter matches”', () => {
  const unfiltered = renderToStaticMarkup(React.createElement(SetupsTable, { setups: [] }));
  assert.match(unfiltered, /No setups yet\./);
  assert.match(unfiltered, /no background scanner/);

  const filtered = renderToStaticMarkup(React.createElement(SetupsTable, { setups: [], filtered: true }));
  assert.match(filtered, /No setups match these filters\./);
  assert.doesNotMatch(filtered, /no background scanner/);
});

test('SetupsTable renders the API’s values and links each row to its detail page', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupsTable, {
      setups: [setupFixture(), setupFixture({ id: '33333333-3333-4333-8333-333333333334', state: 'completed', qualityScore: null })],
    }),
  );
  assert.match(html, /EURUSD/);
  assert.match(html, /long/);
  assert.match(html, /Confirmed/);
  assert.match(html, /Completed/);
  assert.match(html, /v3/);
  assert.match(html, /82/);
  assert.match(html, /1\.085 \/ 1\.08/);
  assert.match(html, new RegExp(`/setups/${SETUP_ID}`), 'rows link to the setup detail page');
  assert.match(html, /—/, 'an unscored setup renders an em dash, never a fabricated zero');
});

test('SetupsNeverDetectedState says how setups come to exist', () => {
  const html = renderToStaticMarkup(React.createElement(SetupsNeverDetectedState));
  assert.match(html, /run of detection|running detection on a published strategy version/);
  assert.match(html, /Open the strategy workbench/);
});

// ---------------------------------------------------------------------------
// Detail cards
// ---------------------------------------------------------------------------

test('SetupSummaryCard shows identity, the raw anchor and the detector version', () => {
  const html = renderToStaticMarkup(React.createElement(SetupSummaryCard, { setup: setupFixture() }));
  assert.match(html, /EURUSD · forex/);
  assert.match(html, /1716206400000 epoch ms/);
  assert.match(html, new RegExp(SETUP_ID));
  assert.match(html, /m4-setup-detect-1/);
  assert.match(html, /82/);
});

test('SetupSummaryCard says “not scored yet” instead of inventing a score', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupSummaryCard, { setup: setupFixture({ qualityScore: null, metadata: {} }) }),
  );
  assert.match(html, /not scored yet/);
  assert.doesNotMatch(html, /Detector version/);
});

test('SetupLevelsCard renders the persisted levels only', () => {
  const html = renderToStaticMarkup(React.createElement(SetupLevelsCard, { setup: setupFixture() }));
  assert.match(html, /Entry/);
  assert.match(html, /Stop loss/);
  assert.match(html, /1\.085/);
  assert.match(html, /1\.1/);
});

test('SetupEventTimeline renders the append-only history, including the creation event', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupEventTimeline, {
      events: [
        eventFixture(),
        eventFixture({ id: 2, fromState: 'confirmed', toState: 'triggered', reason: 'entry hit' }),
      ],
    }),
  );
  assert.match(html, /created/);
  assert.match(html, /Confirmed/);
  assert.match(html, /Triggered/);
  assert.match(html, /entry hit/);
  assert.doesNotMatch(html, /No lifecycle events/);
});

test('SetupEventTimeline states plainly when there is no history', () => {
  const html = renderToStaticMarkup(React.createElement(SetupEventTimeline, { events: [] }));
  assert.match(html, /No lifecycle events recorded for this setup\./);
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test('SetupScorePanel offers scoring with the setup’s own anchor and shows the M5 breakdown', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupScorePanel, {
      setup: setupFixture(),
      scores: [scoreFixture()],
      scoresError: null,
      pending: false,
      error: null,
      notice: null,
      anchorValue: '2024-05-20T12:00',
      anchorError: null,
      onAnchorChange: noop,
      onUseSetupAnchor: noop,
      onUseNow: noop,
      onScore: noop,
    }),
  );
  assert.match(html, /Score setup/);
  assert.match(html, /1716206400000 epoch ms/, 'the default anchor is the setup’s own detection anchor');
  assert.match(html, /Use the setup’s own detection anchor/);
  assert.match(html, /m5-quality-score-1/);
  assert.match(html, /Structure quality/);
  assert.match(html, /36 \/ 40 pts/);
  assert.match(html, /M5 engine is authoritative/);
  assert.doesNotMatch(html, /disabled=""/, 'an active setup can be scored');
});

test('SetupScorePanel keeps a replayed score truthful and reports in-flight scoring', () => {
  const replayed = renderToStaticMarkup(
    React.createElement(SetupScorePanel, {
      setup: setupFixture(),
      scores: [scoreFixture()],
      scoresError: null,
      pending: false,
      error: null,
      notice: 'Existing score returned — no new score row — A score already existed for this setup, engine version and anchor.',
      anchorValue: '2024-05-20T12:00',
      anchorError: null,
      onAnchorChange: noop,
      onUseSetupAnchor: noop,
      onUseNow: noop,
      onScore: noop,
    }),
  );
  assert.match(replayed, /no new score row/);

  const pending = renderToStaticMarkup(
    React.createElement(SetupScorePanel, {
      setup: setupFixture(),
      scores: [],
      scoresError: null,
      pending: true,
      error: null,
      notice: null,
      anchorValue: '2024-05-20T12:00',
      anchorError: null,
      onAnchorChange: noop,
      onUseSetupAnchor: noop,
      onUseNow: noop,
      onScore: noop,
    }),
  );
  assert.match(pending, /Scoring…/);
  assert.match(pending, /disabled=""/);
  assert.match(pending, /no score at any anchor yet/);
});

test('SetupScorePanel refuses to offer scoring for a terminal setup', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupScorePanel, {
      setup: setupFixture({ state: 'invalidated' }),
      scores: [],
      scoresError: null,
      pending: false,
      error: null,
      notice: null,
      anchorValue: '2024-05-20T12:00',
      anchorError: null,
      onAnchorChange: noop,
      onUseSetupAnchor: noop,
      onUseNow: noop,
      onScore: noop,
    }),
  );
  assert.match(html, /Invalidated is a terminal state/);
  assert.match(html, /refuses to score terminal setups/);
  assert.match(html, /disabled=""/);
});

test('SetupScorePanel surfaces score-history and scoring errors as alerts', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupScorePanel, {
      setup: setupFixture(),
      scores: null,
      scoresError: 'Could not load the score history.',
      pending: false,
      error: 'Setup is in terminal state "expired" — terminal setups are never scored.',
      notice: null,
      anchorValue: '2024-05-20T12:00',
      anchorError: null,
      onAnchorChange: noop,
      onUseSetupAnchor: noop,
      onUseNow: noop,
      onScore: noop,
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /terminal setups are never scored/);
  assert.match(html, /Could not load the score history\./);
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

test('SetupTransitionPanel offers exactly the state machine’s outbound transitions', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupTransitionPanel, {
      setup: setupFixture(),
      toState: '',
      onToStateChange: noop,
      reason: '',
      onReasonChange: noop,
      pending: false,
      error: null,
      notice: null,
      anchorValue: '2024-05-20T13:00',
      anchorError: null,
      onAnchorChange: noop,
      onUseNow: noop,
      onTransition: noop,
    }),
  );
  assert.match(html, /Triggered/);
  assert.match(html, /Invalidated/);
  assert.match(html, /Expired/);
  assert.doesNotMatch(html, /value="completed"/, 'a forbidden target is never offered');
  assert.doesNotMatch(html, /value="watching"/, 'backwards transitions are never offered');
  assert.match(html, /maxlength="280"/i);
  assert.match(html, /same-state repeat is an idempotent no-op/);
});

test('SetupTransitionPanel offers nothing from a terminal state and explains why', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupTransitionPanel, {
      setup: setupFixture({ state: 'expired' }),
      toState: '',
      onToStateChange: noop,
      reason: '',
      onReasonChange: noop,
      pending: false,
      error: null,
      notice: null,
      anchorValue: '2024-05-20T13:00',
      anchorError: null,
      onAnchorChange: noop,
      onUseNow: noop,
      onTransition: noop,
    }),
  );
  assert.match(html, /Expired is a terminal state — the lifecycle has no further transitions from here\./);
  assert.match(html, /No transitions available/);
  assert.match(html, /disabled=""/);
});

test('SetupTransitionPanel reports a rejected transition and a no-op result distinctly', () => {
  const base = {
    setup: setupFixture(),
    toState: 'triggered' as const,
    onToStateChange: noop,
    reason: '',
    onReasonChange: noop,
    pending: false,
    anchorValue: '2024-05-20T13:00',
    anchorError: null,
    onAnchorChange: noop,
    onUseNow: noop,
    onTransition: noop,
  };
  const rejected = renderToStaticMarkup(
    React.createElement(SetupTransitionPanel, {
      ...base,
      error: 'Cannot transition setup from "confirmed" to "completed". Allowed: triggered, invalidated, expired.',
      notice: null,
    }),
  );
  assert.match(rejected, /role="alert"/);
  assert.match(rejected, /Allowed: triggered, invalidated, expired/);

  const noopResult = renderToStaticMarkup(
    React.createElement(SetupTransitionPanel, {
      ...base,
      error: null,
      notice: 'Already in Confirmed — nothing changed — This request repeated the setup’s current state, which the API treats as an idempotent no-op: no event was written.',
    }),
  );
  assert.match(noopResult, /nothing changed/);
  assert.match(noopResult, /no event was written/);
});

// ---------------------------------------------------------------------------
// Alert generation (reuses the M6 components unchanged)
// ---------------------------------------------------------------------------

test('SetupAlertPanel reuses the M6 eligibility rule and stub wording', () => {
  const eligible = renderToStaticMarkup(
    React.createElement(SetupAlertPanel, {
      setup: setupFixture(),
      pending: false,
      error: null,
      outcome: null,
      onGenerate: noop,
    }),
  );
  assert.match(eligible, /Generate alert/);
  assert.match(eligible, /Stub delivery only/);
  assert.match(eligible, /No email, webhook, push, SMS or broker notification is sent/);
  assert.doesNotMatch(eligible, /disabled=""/);

  const terminal = renderToStaticMarkup(
    React.createElement(SetupAlertPanel, {
      setup: setupFixture({ state: 'completed' }),
      pending: false,
      error: null,
      outcome: null,
      onGenerate: noop,
    }),
  );
  assert.match(terminal, /no alert can be generated for a terminal setup/);
  assert.match(terminal, /disabled=""/);
});

test('SetupAlertPanel renders created, replayed and skipped outcomes truthfully', () => {
  const created = renderToStaticMarkup(
    React.createElement(SetupAlertPanel, {
      setup: setupFixture(),
      pending: false,
      error: null,
      outcome: classifyGenerateOutcome({ alert: alertFixture(), created: true, deliveries: [] }),
      onGenerate: noop,
    }),
  );
  assert.match(created, /Alert generated/);
  assert.match(created, new RegExp(`/alerts/${ALERT_ID}`), 'the generated alert links to its detail/acknowledge page');

  const replayed = renderToStaticMarkup(
    React.createElement(SetupAlertPanel, {
      setup: setupFixture(),
      pending: false,
      error: null,
      outcome: classifyGenerateOutcome({ alert: alertFixture(), created: false, deliveries: [] }),
      onGenerate: noop,
    }),
  );
  assert.match(replayed, /Alert already exists/);
  assert.match(replayed, /no second alert and no second delivery row/);
  assert.doesNotMatch(replayed, /Alert generated/);

  const skipped = renderToStaticMarkup(
    React.createElement(SetupAlertPanel, {
      setup: setupFixture(),
      pending: false,
      error: null,
      outcome: classifyGenerateOutcome({ alert: null, created: false, skippedReason: 'below_min_quality' }),
      onGenerate: noop,
    }),
  );
  assert.match(skipped, /No alert generated — below the minimum quality score/);
  assert.match(skipped, /No alert row was written/);
});

test('SetupAlertPanel announces generation errors and in-flight generation', () => {
  const error = renderToStaticMarkup(
    React.createElement(SetupAlertPanel, {
      setup: setupFixture(),
      pending: false,
      error: 'The alert could not be generated. Nothing was created.',
      outcome: null,
      onGenerate: noop,
    }),
  );
  assert.match(error, /role="alert"/);
  assert.match(error, /Nothing was created/);

  const pending = renderToStaticMarkup(
    React.createElement(SetupAlertPanel, { setup: setupFixture(), pending: true, error: null, outcome: null, onGenerate: noop }),
  );
  assert.match(pending, /Generating…/);
  assert.match(pending, /disabled=""/);
});
