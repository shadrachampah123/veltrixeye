/**
 * M7.1 — workbench render tests.
 *
 * Rendered with `react-dom/server`, so these run the real components through
 * their real render path. Fixtures are parsed through the shared contract
 * schemas first: if a DTO changes in `@veltrixeye/contracts`, these tests fail
 * instead of the production UI.
 *
 * The behaviours pinned here are the ones a trader could be misled by:
 *  - a draft version blocks evaluation and detection (the API refuses it);
 *  - a replayed detection is never rendered as a newly created setup;
 *  - "no setup" is stated plainly, with the evaluation's failure reasons;
 *  - results carry the engine version and the exact anchor they were produced
 *    at, and a result pinned to a different anchor says so;
 *  - in-flight controls are disabled so a double-click cannot fire twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  detectionResponseDtoSchema,
  evaluationResultSchema,
  setupDtoSchema,
  type DetectionResponseDto,
  type EvaluationResultDto,
  type SetupDto,
} from '@veltrixeye/contracts';
import { AnchorField } from '../components/anchor-field';
import { EvaluationResultView } from '../components/evaluation-result';
import { DetectionResultView } from '../components/detection-result';
import { EvaluatePanel, DetectPanel, DRAFT_BLOCKED_REASON } from '../components/version-workbench';
import { detectInstrumentChoices } from '../lib/workbench';
import type { StrategyVersionDetailDto } from '@veltrixeye/contracts';

const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const SETUP_ID = '33333333-3333-4333-8333-333333333333';
const ANCHOR = Date.UTC(2024, 4, 20, 12, 0, 0);
const OTHER_ANCHOR = ANCHOR + 3_600_000;
const noop = () => {};

function evaluationFixture(overrides: Record<string, unknown> = {}): EvaluationResultDto {
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
            groups: [
              {
                name: 'Trend continuation',
                logic: 'AND',
                satisfied: true,
                relevance: 'pass',
                conditions: [
                  { conditionType: 'bos', classification: 'required', timeframeRole: 'setup', status: 'satisfied', detail: 'BOS above the swing high' },
                  { conditionType: 'liquidity_sweep', classification: 'confirmation', timeframeRole: 'entry', status: 'satisfied', detail: 'sweep of the prior low' },
                ],
              },
            ],
            sessionFilters: [
              { session: 'london', mode: 'include', timezone: 'utc', status: 'satisfied', detail: 'inside the London session' },
            ],
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
            groups: [
              {
                name: 'Trend continuation',
                logic: 'AND',
                satisfied: false,
                relevance: 'pass',
                conditions: [
                  { conditionType: 'choch', classification: 'required', timeframeRole: 'setup', status: 'unsatisfied', detail: 'no CHoCH' },
                  { conditionType: 'fvg', classification: 'confirmation', timeframeRole: 'entry', status: 'insufficient_data', detail: 'only 40 closed candles' },
                  { conditionType: 'news_filter', classification: 'disqualifying', timeframeRole: 'any', status: 'unsupported', detail: 'no news calendar source' },
                ],
              },
            ],
            sessionFilters: [],
            candidate: null,
            failureReasons: ['required condition "choch" was not satisfied', 'confirmation condition "fvg" had insufficient data'],
          },
        },
        anyPassed: true,
      },
    ],
    truncated: false,
    notes: [],
    ...overrides,
  });
}

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

function detectionFixture(items: Array<Record<string, unknown>>): DetectionResponseDto {
  return detectionResponseDtoSchema.parse({
    strategyId: STRATEGY_ID,
    versionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    asOfMs: ANCHOR,
    detectorVersion: 'm4-setup-detect-1',
    engineVersion: 'm3-deterministic-eval-1',
    detections: items,
  });
}

function versionFixture(): StrategyVersionDetailDto {
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
      marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }] },
      sessionFilters: [],
      filters: [],
      ruleGroups: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Anchor field
// ---------------------------------------------------------------------------

test('AnchorField prints the exact epoch-ms that will be sent', () => {
  const html = renderToStaticMarkup(
    React.createElement(AnchorField, { value: '2024-05-20T12:00', onChange: noop, onUseNow: noop }),
  );
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /2024-05-20T12:00/);
  assert.match(html, /1716206400000 epoch ms/, 'the raw anchor is visible, never implicit');
  assert.match(html, /Use current time/);
  assert.ok(!/role="alert"/.test(html), 'no error styling when the anchor is valid');
});

test('AnchorField exposes an invalid anchor as an alert and disables the now-button when busy', () => {
  const html = renderToStaticMarkup(
    React.createElement(AnchorField, {
      value: '',
      onChange: noop,
      onUseNow: noop,
      disabled: true,
      error: 'Set an anchor date and time.',
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Set an anchor date and time\./);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /disabled=""/, 'the control is disabled while a request is in flight');
});

// ---------------------------------------------------------------------------
// Evaluation result rendering
// ---------------------------------------------------------------------------

test('EvaluationResultView renders only API-returned fields', () => {
  const html = renderToStaticMarkup(React.createElement(EvaluationResultView, { result: evaluationFixture() }));

  assert.match(html, /m3-deterministic-eval-1/, 'engine version is shown');
  assert.match(html, /1716206400000/, 'the anchor is shown as epoch ms');
  assert.match(html, /EURUSD/);
  assert.match(html, /long passed/);
  assert.match(html, /short failed/);
  assert.match(html, /Trend continuation/);
  assert.match(html, /BOS above the swing high/);
  assert.match(html, /Satisfied/);
  assert.match(html, /Not satisfied/);
  assert.match(html, /Insufficient data/, 'data sufficiency is surfaced, not hidden');
  assert.match(html, /Unsupported/, 'unsupported conditions are surfaced, never silently passed');
  assert.match(html, /Candidate levels/);
  assert.match(html, /Achievable risk:reward/);
  assert.match(html, /Why this direction failed/);
  assert.match(html, /inside the London session/, 'session filtering is shown');
});

test('EvaluationResultView states truncation and engine notes when the API reports them', () => {
  const html = renderToStaticMarkup(
    React.createElement(EvaluationResultView, {
      result: evaluationFixture({
        truncated: true,
        notes: ['Market scope "all" exceeds the 50-instrument evaluation cap'],
      }),
    }),
  );
  assert.match(html, /instrument evaluation cap/);
  assert.match(html, /Engine notes/);
});

// ---------------------------------------------------------------------------
// Detection result rendering
// ---------------------------------------------------------------------------

test('DetectionResultView says “Setup created” only for created: true', () => {
  const created = renderToStaticMarkup(
    React.createElement(DetectionResultView, {
      result: detectionFixture([{ direction: 'long', qualified: true, setup: setupFixture(), created: true, failureReasons: [] }]),
    }),
  );
  assert.match(created, /Setup created/);
  assert.match(created, /m4-setup-detect-1/);
  assert.match(created, /m3-deterministic-eval-1/);
  assert.match(created, new RegExp(`/setups/${SETUP_ID}`), 'the created setup links to its detail page');
  assert.match(created, /not scored yet/);
  assert.match(created, /1 created · 0 already existing · 0 without a setup/);
});

test('DetectionResultView renders a replay as an existing setup, never as created', () => {
  const html = renderToStaticMarkup(
    React.createElement(DetectionResultView, {
      result: detectionFixture([{ direction: 'long', qualified: true, setup: setupFixture(), created: false, failureReasons: [] }]),
    }),
  );
  assert.match(html, /Existing setup returned — no new setup/);
  assert.doesNotMatch(html, /Setup created/);
  assert.match(html, /0 created · 1 already existing · 0 without a setup/);
  assert.match(html, /nothing was written/);
});

test('DetectionResultView represents “no setup” with the evaluation’s failure reasons', () => {
  const html = renderToStaticMarkup(
    React.createElement(DetectionResultView, {
      result: detectionFixture([
        { direction: 'short', qualified: false, setup: null, created: false, failureReasons: ['required condition "choch" was not satisfied'] },
      ]),
    }),
  );
  assert.match(html, /No setup — this direction did not qualify/);
  assert.match(html, /required condition &quot;choch&quot; was not satisfied/);
  assert.match(html, /no setup row exists/);
});

// ---------------------------------------------------------------------------
// Panels: action states
// ---------------------------------------------------------------------------

test('EvaluatePanel renders the idle state, then the in-flight state with a disabled control', () => {
  const idle = renderToStaticMarkup(
    React.createElement(EvaluatePanel, {
      anchorError: null,
      currentAnchorMs: ANCHOR,
      resultAnchorMs: null,
      pending: false,
      result: null,
      error: null,
      blockedReason: null,
      onEvaluate: noop,
    }),
  );
  assert.match(idle, /Nothing has been evaluated at this anchor yet/);
  assert.match(idle, /no provider key configured/);

  const pending = renderToStaticMarkup(
    React.createElement(EvaluatePanel, {
      anchorError: null,
      currentAnchorMs: ANCHOR,
      resultAnchorMs: null,
      pending: true,
      result: null,
      error: null,
      blockedReason: null,
      onEvaluate: noop,
    }),
  );
  assert.match(pending, /Evaluating…/);
  assert.match(pending, /disabled=""/, 'a second evaluation cannot be fired while one is running');
  assert.match(pending, /role="status"/);
  assert.match(pending, /Evaluating the strategy version/);
});

test('EvaluatePanel blocks a draft version and shows the API-level reason', () => {
  const html = renderToStaticMarkup(
    React.createElement(EvaluatePanel, {
      anchorError: null,
      currentAnchorMs: ANCHOR,
      resultAnchorMs: null,
      pending: false,
      result: null,
      error: null,
      blockedReason: DRAFT_BLOCKED_REASON,
      onEvaluate: noop,
    }),
  );
  assert.match(html, /Only published versions can be evaluated or detected/);
  assert.match(html, /Publish it first/);
  assert.match(html, /disabled=""/);
});

test('EvaluatePanel surfaces an API error as an alert and a stale result as a re-run prompt', () => {
  const failed = renderToStaticMarkup(
    React.createElement(EvaluatePanel, {
      anchorError: null,
      currentAnchorMs: ANCHOR,
      resultAnchorMs: null,
      pending: false,
      result: null,
      error: 'Only published versions can be evaluated — this one is a draft.',
      blockedReason: null,
      onEvaluate: noop,
    }),
  );
  assert.match(failed, /role="alert"/);
  assert.match(failed, /Only published versions can be evaluated/);

  const stale = renderToStaticMarkup(
    React.createElement(EvaluatePanel, {
      anchorError: null,
      currentAnchorMs: OTHER_ANCHOR,
      resultAnchorMs: ANCHOR,
      pending: false,
      result: evaluationFixture(),
      error: null,
      blockedReason: null,
      onEvaluate: noop,
    }),
  );
  assert.match(stale, /produced at anchor/);
  assert.match(stale, /Evaluate again to re-pin it/);
});

test('EvaluatePanel shows the rendered result once the API returns one', () => {
  const html = renderToStaticMarkup(
    React.createElement(EvaluatePanel, {
      anchorError: null,
      currentAnchorMs: ANCHOR,
      resultAnchorMs: ANCHOR,
      pending: false,
      result: evaluationFixture(),
      error: null,
      blockedReason: null,
      onEvaluate: noop,
    }),
  );
  assert.match(html, /m3-deterministic-eval-1/);
  assert.match(html, /Trend continuation/);
  assert.ok(!/produced at anchor/.test(html), 'a result at the current anchor is not flagged as stale');
});

test('DetectPanel offers only the version-scope instruments and the direction choice', () => {
  const choices = detectInstrumentChoices({ version: versionFixture(), evaluation: null, platformInstruments: [] });
  const html = renderToStaticMarkup(
    React.createElement(DetectPanel, {
      choices,
      instrumentKeyValue: 'forex/EURUSD',
      onInstrumentChange: noop,
      direction: '',
      onDirectionChange: noop,
      anchorError: null,
      currentAnchorMs: ANCHOR,
      resultAnchorMs: null,
      pending: false,
      result: null,
      error: null,
      blockedReason: null,
      onDetect: noop,
    }),
  );
  assert.match(html, /forex\/EURUSD/);
  assert.match(html, /Both directions/);
  assert.match(html, /Long only/);
  assert.match(html, /Short only/);
  assert.match(html, /market scope lists 1 instrument/);
  assert.match(html, /Nothing has been detected at this anchor yet/);
});

test('DetectPanel disables detection when the scope yields no instruments', () => {
  const choices = detectInstrumentChoices({ version: versionFixture(), evaluation: null, platformInstruments: [] });
  const empty = { ...choices, options: [], source: 'none' as const };
  const html = renderToStaticMarkup(
    React.createElement(DetectPanel, {
      choices: empty,
      instrumentKeyValue: '',
      onInstrumentChange: noop,
      direction: '',
      onDirectionChange: noop,
      anchorError: null,
      currentAnchorMs: ANCHOR,
      resultAnchorMs: null,
      pending: false,
      result: null,
      error: null,
      blockedReason: null,
      onDetect: noop,
    }),
  );
  assert.match(html, /No instruments available/);
  assert.match(html, /disabled=""/);
});

test('DetectPanel is disabled by an invalid anchor and announces an in-flight detection', () => {
  const choices = detectInstrumentChoices({ version: versionFixture(), evaluation: null, platformInstruments: [] });
  const base = {
    choices,
    instrumentKeyValue: 'forex/EURUSD',
    onInstrumentChange: noop,
    direction: '' as const,
    onDirectionChange: noop,
    currentAnchorMs: ANCHOR,
    resultAnchorMs: null,
    result: null,
    error: null,
    blockedReason: null,
    onDetect: noop,
  };
  const invalidAnchor = renderToStaticMarkup(
    React.createElement(DetectPanel, { ...base, anchorError: 'Set an anchor date and time.', pending: false }),
  );
  assert.match(invalidAnchor, /disabled=""/);

  const pending = renderToStaticMarkup(React.createElement(DetectPanel, { ...base, anchorError: null, pending: true }));
  assert.match(pending, /Detecting…/);
  assert.match(pending, /Detecting setups/);
  assert.match(pending, /role="status"/);
});

test('DetectPanel renders the detection outcome and flags a stale run', () => {
  const choices = detectInstrumentChoices({ version: versionFixture(), evaluation: null, platformInstruments: [] });
  const html = renderToStaticMarkup(
    React.createElement(DetectPanel, {
      choices,
      instrumentKeyValue: 'forex/EURUSD',
      onInstrumentChange: noop,
      direction: 'long',
      onDirectionChange: noop,
      anchorError: null,
      currentAnchorMs: OTHER_ANCHOR,
      resultAnchorMs: ANCHOR,
      pending: false,
      result: detectionFixture([{ direction: 'long', qualified: true, setup: setupFixture(), created: true, failureReasons: [] }]),
      error: null,
      blockedReason: null,
      onDetect: noop,
    }),
  );
  assert.match(html, /Setup created/);
  assert.match(html, /ran at anchor/);
  assert.match(html, /Detect again to run at the current anchor/);
});
