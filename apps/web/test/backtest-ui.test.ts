/**
 * M6 Phase 4 — backtest UI render tests.
 *
 * These render the real components with `react-dom/server` (no browser, no
 * extra test dependency) and assert on the produced markup, so the checks run
 * the shipped render path rather than a re-implementation of it. Fixtures are
 * parsed through the shared contract schemas, which means a DTO change in
 * `@veltrixeye/contracts` breaks these tests instead of the production UI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MAX_BACKTEST_TRADES,
  backtestRunDtoSchema,
  backtestTradeDtoSchema,
  type BacktestRunDto,
  type BacktestTrade,
} from '@veltrixeye/contracts';
import { BacktestForm, type BacktestStrategyOption } from '../components/backtest-form';
import {
  BacktestHistoryTable,
} from '../components/backtest-history';
import {
  BacktestMetricsGrid,
  BacktestNotesList,
  BacktestRunSummary,
  BacktestTradesTable,
} from '../components/backtest-results';
import { createBacktestFormState, type BacktestFormState } from '../lib/backtest-form';

const NOW_MS = Date.UTC(2024, 5, 1, 0, 0, 0);
const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '55555555-5555-4555-8555-555555555555';

const noop = () => {};

function formState(overrides: Partial<BacktestFormState> = {}): BacktestFormState {
  return {
    ...createBacktestFormState(NOW_MS),
    strategyId: STRATEGY_ID,
    versionId: VERSION_ID,
    assetClass: 'forex',
    symbol: 'EURUSD',
    ...overrides,
  };
}

function strategies(): BacktestStrategyOption[] {
  return [
    {
      id: STRATEGY_ID,
      name: 'London Breakout',
      publishedVersions: [
        { id: VERSION_ID, versionNumber: 3, isCurrent: true },
        { id: '22222222-2222-4222-8222-222222222223', versionNumber: 2, isCurrent: false },
      ],
    },
    { id: '11111111-1111-4111-8111-111111111112', name: 'Draft Only', publishedVersions: [] },
  ];
}

function runFixture(overrides: Partial<BacktestRunDto> = {}): BacktestRunDto {
  return backtestRunDtoSchema.parse({
    id: RUN_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'both',
    engineVersion: 'm6-backtest-1',
    fromMs: 1_704_067_200_000, // 2024-01-01T00:00:00Z
    toMs: 1_706_745_600_000, // 2024-02-01T00:00:00Z
    exitPolicy: { stopLoss: 'level', takeProfit: 'tp3', maxHoldCandles: 100 },
    costPolicy: { feePerSide: 0.0001, slippagePerSide: 0.0002, spread: 0.0003, riskPerTrade: 250 },
    configHash: 'b'.repeat(64),
    status: 'completed',
    metrics: {
      stepsEvaluated: 220,
      setupsDetected: 12,
      tradesClosed: 10,
      wins: 6,
      losses: 4,
      winRate: 0.6,
      expectancyR: 0.35,
      profitFactor: 1.8,
      maxDrawdownR: 2.5,
      avgWinR: 1.5,
      avgLossR: -1,
      totalR: 3.5,
      totalCurrency: 875,
    },
    notes: ['Setup series contains 2 gaps wider than 2× the setup timeframe; exits spanning gaps use the next available candle (no interpolation).'],
    createdAt: '2024-06-01T09:00:00.000Z',
    ...overrides,
  });
}

function tradeFixture(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return backtestTradeDtoSchema.parse({
    seq: 0,
    direction: 'long',
    signalAsOfMs: 1_704_153_600_000,
    entryPrice: 1.085,
    stopLossPrice: 1.08,
    tp1Price: 1.095,
    tp2Price: 1.105,
    tp3Price: 1.12,
    qualityScore: 82,
    qualityGrade: 'A',
    exitReason: 'take_profit_3',
    exitPrice: 1.12,
    exitAsOfMs: 1_704_326_400_000,
    pnlR: 6.75,
    pnlCurrency: 1687.5,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. The form renders
// ---------------------------------------------------------------------------

test('BacktestForm renders every input the API accepts, with accessible labels', () => {
  const html = renderToStaticMarkup(
    React.createElement(BacktestForm, {
      state: formState(),
      onChange: noop,
      errors: {},
      submitting: false,
      onSubmit: noop,
      strategies: strategies(),
      instruments: [
        { assetClass: 'forex', symbol: 'EURUSD', displayName: 'Euro / US Dollar' },
        { assetClass: 'crypto', symbol: 'BTC/USD', displayName: null },
      ],
      versionConfig: { timeframes: { htf_bias: '4h', setup: '1h', entry: '15m' }, minQualityScore: 70, minRr: 1.5 },
      loadingOptions: false,
      optionsError: null,
      submitError: null,
      onPreset: noop,
    }),
  );

  for (const label of [
    'Strategy',
    'Published version',
    'Instrument',
    'Direction',
    'From (inclusive)',
    'To (exclusive)',
    'Stop-loss',
    'Take-profit leg',
    'Max hold (setup candles)',
    'Fee per side',
    'Slippage per side',
    'Spread (entry only)',
    'Risk per trade (optional)',
  ]) {
    assert.ok(html.includes(label), `missing field label: ${label}`);
  }

  // Selectable options come from the API, not from hard-coded values.
  assert.ok(html.includes('London Breakout'), 'strategy option rendered');
  assert.ok(html.includes('Draft Only'), 'strategy without a published version is listed');
  assert.ok(html.includes('no published version'), 'a strategy with no published version says so');
  assert.ok(html.includes('v3'), 'published versions offered');
  assert.ok(html.includes('EURUSD (forex)'), 'instrument option rendered');
  assert.ok(html.includes('BTC/USD (crypto)'), 'second instrument rendered');

  // The pinned engine rules are surfaced as read-only facts, not as controls.
  assert.ok(html.includes('Same-candle stop-first and signal-close entry are pinned'), 'pinned rules explained');
  assert.ok(html.includes('4h bias'), 'version timeframes displayed read-only');
  assert.ok(html.includes('1h setup'));
  assert.ok(html.includes('min score 70'), 'version min quality score displayed');
  assert.ok(html.includes('Run backtest'), 'submit control');
  assert.ok(html.includes('datetime-local'), 'range inputs are datetime controls');
  assert.ok(html.includes('aria-busy="false"'), 'form reports its busy state');
});

// ---------------------------------------------------------------------------
// 2. Validation errors render
// ---------------------------------------------------------------------------

test('BacktestForm renders per-field validation errors and marks fields invalid', () => {
  const html = renderToStaticMarkup(
    React.createElement(BacktestForm, {
      state: formState({ maxHoldCandles: '0' }),
      onChange: noop,
      errors: {
        strategyVersion: 'Choose a strategy and one of its published versions.',
        instrument: 'Choose an instrument with stored market data.',
        from: 'The start must be earlier than the end.',
        to: 'The end must not be in the future.',
        maxHoldCandles: 'Max hold must be between 1 and 5000 candles.',
        riskPerTrade: 'Risk per trade must be a positive number (or left blank).',
      },
      submitting: false,
      onSubmit: noop,
      strategies: strategies(),
      instruments: [],
      versionConfig: null,
      loadingOptions: false,
      optionsError: null,
      submitError: null,
      onPreset: noop,
    }),
  );

  for (const message of [
    'Choose a strategy and one of its published versions.',
    'Choose an instrument with stored market data.',
    'The start must be earlier than the end.',
    'The end must not be in the future.',
    'Max hold must be between 1 and 5000 candles.',
    'Risk per trade must be a positive number (or left blank).',
  ]) {
    assert.ok(html.includes(message), `missing error: ${message}`);
  }
  assert.ok(html.includes('aria-invalid="true"'), 'invalid fields are exposed to assistive tech');
  assert.ok(html.includes('Last 30 days'), 'range presets are offered');
});

test('BacktestForm shows a submitting state and a safe API failure message', () => {
  const html = renderToStaticMarkup(
    React.createElement(BacktestForm, {
      state: formState(),
      onChange: noop,
      errors: {},
      submitting: true,
      onSubmit: noop,
      strategies: strategies(),
      instruments: [],
      versionConfig: null,
      loadingOptions: true,
      optionsError: 'Could not load your strategies or the instrument list.',
      submitError: 'Only published versions can be backtested — a draft is still mutable. Publish the version first.',
      onPreset: noop,
    }),
  );
  assert.ok(html.includes('Running backtest…'), 'submit label reflects progress');
  assert.ok(html.includes('disabled'), 'controls are disabled while submitting');
  assert.ok(html.includes('aria-busy="true"'));
  assert.ok(html.includes('Backtest failed'), 'failure has a heading');
  assert.ok(html.includes('Only published versions can be backtested'), 'the API message is surfaced verbatim');
  assert.ok(html.includes('Could not load your strategies or the instrument list.'), 'options error surfaced');
  assert.ok(!/at [A-Za-z]+ \(/.test(html), 'no stack traces');
});

// ---------------------------------------------------------------------------
// 3. Successful results render
// ---------------------------------------------------------------------------

test('BacktestRunSummary renders the run inputs, engine version and config hash', () => {
  const html = renderToStaticMarkup(React.createElement(BacktestRunSummary, { run: runFixture(), created: true }));
  assert.ok(html.includes('EURUSD'), 'instrument');
  assert.ok(html.includes('Long + short'), 'direction');
  assert.ok(html.includes('v3'), 'version number');
  assert.ok(html.includes('m6-backtest-1'), 'engine version');
  assert.ok(html.includes('b'.repeat(64)), 'config hash shown for traceability');
  assert.ok(html.includes('2024-01-01 00:00 UTC'), 'from bound labelled UTC');
  assert.ok(html.includes('2024-02-01 00:00 UTC'), 'to bound labelled UTC');
  assert.ok(html.includes('Signal close (pinned)'), 'pinned entry timing');
  assert.ok(html.includes('Stop first (pinned)'), 'pinned same-candle rule');
  assert.ok(html.includes('0.0003'), 'spread input echoed back');
  assert.ok(html.includes('Backtest completed'), 'created badge');
});

test('BacktestRunSummary flags a deterministic replay instead of claiming a new run', () => {
  const replayed = renderToStaticMarkup(React.createElement(BacktestRunSummary, { run: runFixture(), created: false }));
  assert.ok(replayed.includes('Identical run replayed'), 'replay badge');
  assert.ok(!replayed.includes('Backtest completed'), 'a replay is not presented as a new run');
});

test('BacktestMetricsGrid renders the API metrics, and em dashes for undefined ones', () => {
  const run = runFixture();
  const html = renderToStaticMarkup(
    React.createElement(BacktestMetricsGrid, { metrics: run.metrics, showsCurrency: true }),
  );
  assert.ok(html.includes('60.0%'), 'win rate');
  assert.ok(html.includes('+3.50R'), 'net result in R');
  assert.ok(html.includes('1.80'), 'profit factor');
  assert.ok(html.includes('2.50R'), 'max drawdown');
  assert.ok(html.includes('875.00'), 'currency total when risk sizing was supplied');
  assert.ok(html.includes('Setups detected') && html.includes('12'));
  assert.ok(html.includes('Trades closed') && html.includes('10'));

  // Null metrics (no losing trades → no profit factor; no risk → no currency)
  const nulls = renderToStaticMarkup(
    React.createElement(BacktestMetricsGrid, {
      metrics: { ...run.metrics, profitFactor: null, winRate: null, maxDrawdownR: null, totalCurrency: null },
      showsCurrency: false,
    }),
  );
  assert.ok(nulls.includes('No losing trades — undefined'), 'a null profit factor is explained, not zeroed');
  assert.ok(!nulls.includes('875.00'), 'no currency tile without a risk per trade');
  assert.ok((nulls.match(/—/g) ?? []).length >= 3, 'null metrics render as em dashes');
});

test('BacktestTradesTable renders each trade the API returned', () => {
  const trades = [
    tradeFixture(),
    tradeFixture({
      seq: 1,
      direction: 'short',
      exitReason: 'stop_loss',
      exitPrice: 1.08,
      pnlR: -1,
      pnlCurrency: -250,
    }),
    tradeFixture({
      seq: 2,
      exitReason: 'no_levels',
      entryPrice: null,
      stopLossPrice: null,
      tp1Price: null,
      tp2Price: null,
      tp3Price: null,
      qualityScore: null,
      qualityGrade: null,
      exitPrice: null,
      exitAsOfMs: null,
      pnlR: null,
      pnlCurrency: null,
    }),
  ];
  const html = renderToStaticMarkup(
    React.createElement(BacktestTradesTable, { trades, truncated: false, limit: 50 }),
  );
  assert.ok(html.includes('Take profit 3'), 'exit reason label');
  assert.ok(html.includes('Stop loss'));
  assert.ok(html.includes('No levels'));
  assert.ok(html.includes('+6.75R'), 'winning R');
  assert.ok(html.includes('-1.00R'), 'losing R');
  assert.ok(html.includes('1687.50'), 'currency P&L');
  assert.ok(html.includes('82'), 'quality score');
  assert.ok(html.includes('Trades (3)'), 'trade count');
  assert.ok(!html.includes('truncated'), 'no truncation badge when the API reported none');
});

test('BacktestTradesTable — empty state, truncation badge and load-more control', () => {
  const empty = renderToStaticMarkup(React.createElement(BacktestTradesTable, { trades: [], truncated: false }));
  assert.ok(empty.includes('No setups qualified in this range'), 'honest empty state');

  const truncated = renderToStaticMarkup(
    React.createElement(BacktestTradesTable, {
      trades: [tradeFixture()],
      truncated: true,
      limit: 1,
      onLoadMore: noop,
      loadingMore: false,
    }),
  );
  assert.ok(truncated.includes('truncated'), 'truncation badge');
  assert.ok(truncated.includes(`at most ${MAX_BACKTEST_TRADES} per run`), 'truncation limit stated');
  assert.ok(truncated.includes('Load more trades'), 'paging control offered');

  const loading = renderToStaticMarkup(
    React.createElement(BacktestTradesTable, {
      trades: [tradeFixture()],
      truncated: true,
      limit: 1,
      onLoadMore: noop,
      loadingMore: true,
    }),
  );
  assert.ok(loading.includes('Loading…'), 'paging shows progress');
});

test('BacktestNotesList surfaces engine notes verbatim, with an honest empty state', () => {
  const run = runFixture();
  const html = renderToStaticMarkup(React.createElement(BacktestNotesList, { notes: run.notes }));
  assert.ok(html.includes('gaps wider than 2× the setup timeframe'), 'engine note text preserved');
  const empty = renderToStaticMarkup(React.createElement(BacktestNotesList, { notes: [] }));
  assert.ok(empty.includes('No engine notes for this run.'));
});

// ---------------------------------------------------------------------------
// 4. History list
// ---------------------------------------------------------------------------

test('BacktestHistoryTable renders owned runs and links to their detail pages', () => {
  const runs = [
    runFixture(),
    runFixture({ id: '55555555-5555-4555-8555-555555555556', metrics: { ...runFixture().metrics, totalR: -2 } }),
  ];
  const html = renderToStaticMarkup(React.createElement(BacktestHistoryTable, { runs }));
  assert.ok(html.includes(`href="/backtests/${RUN_ID}"`), 'detail link for the first run');
  assert.ok(html.includes('Recent runs (2)'), 'run count');
  assert.ok(html.includes('60.0%'), 'win rate column');
  assert.ok(html.includes('+3.50R'), 'net R column');
  assert.ok(html.includes('-2.00R'), 'a losing run is shown as negative');
});

test('BacktestHistoryTable — useful empty state pointing at the workflow', () => {
  const html = renderToStaticMarkup(React.createElement(BacktestHistoryTable, { runs: [] }));
  assert.ok(html.includes('No backtests yet.'));
  assert.ok(html.includes('never calls a market-data provider') || html.includes('Nothing is fetched from a'));
  assert.ok(html.includes('href="/backtests/new"'), 'link into the create flow');
});
