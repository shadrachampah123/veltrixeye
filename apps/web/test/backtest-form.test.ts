/**
 * M6 Phase 4 — backtest form model + result formatting.
 *
 * These tests pin the browser-side contract for the backtest workflow:
 *  - the form's defaults match the pinned engine defaults (max hold 100,
 *    `stop_first`, `signal_close`, zero costs);
 *  - every input rule the API enforces is mirrored, so an invalid form never
 *    reaches the network;
 *  - the submitted body is the *parsed output of the shared contract schema*,
 *    so what the browser sends is what the route accepts;
 *  - result rendering only re-formats API values — nullable metrics stay an em
 *    dash and no metric is invented.
 *
 * Run: npm run test --workspace @veltrixeye/web
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BACKTESTS_LIMIT,
  DEFAULT_MAX_HOLD_CANDLES,
  MAX_BACKTEST_TRADES,
  MAX_BACKTESTS_LIMIT,
  backtestRequestSchema,
  backtestTradeDtoSchema,
  type BacktestTrade,
} from '@veltrixeye/contracts';
import {
  BACKTEST_RANGE_PRESETS,
  DEFAULT_BACKTESTS_PAGE_SIZE,
  MAX_BACKTEST_RANGE_MS,
  TRADES_PAGE_SIZES,
  applyRangePreset,
  applyTradesPage,
  backtestHistoryCopy,
  buildBacktestRequest,
  createBacktestFormState,
  directionLabel,
  exitReasonLabel,
  exitReasonTone,
  formatEpochMsUtc,
  formatR,
  formatRate,
  fromDateTimeLocalValue,
  mergeTrades,
  metricTiles,
  nextTradesPageSize,
  toDateTimeLocalValue,
  tradesHasMore,
  tradesTruncationMessage,
  truncationIndicators,
  type BacktestFormState,
  type TradesPageState,
} from '../lib/backtest-form';

/** 2024-06-01T00:00:00.000Z — a fixed "now" so range rules are deterministic. */
const NOW_MS = Date.UTC(2024, 5, 1, 0, 0, 0);
const DAY_MS = 24 * 3600 * 1000;

/** A state that passes every rule; tests mutate one field at a time. */
function validState(): BacktestFormState {
  return {
    ...createBacktestFormState(NOW_MS),
    strategyId: '11111111-1111-4111-8111-111111111111',
    versionId: '22222222-2222-4222-8222-222222222222',
    assetClass: 'forex',
    symbol: 'EURUSD',
  };
}

// ---------------------------------------------------------------------------
// Defaults + datetime helpers
// ---------------------------------------------------------------------------

test('createBacktestFormState() — pinned defaults, 90-day range ending at "now"', () => {
  const s = createBacktestFormState(NOW_MS);
  assert.equal(s.maxHoldCandles, String(DEFAULT_MAX_HOLD_CANDLES), 'max hold default is 100');
  assert.equal(s.stopLoss, 'level');
  assert.equal(s.takeProfit, 'tp3');
  assert.equal(s.direction, 'both');
  assert.equal(s.feePerSide, '0');
  assert.equal(s.slippagePerSide, '0');
  assert.equal(s.spread, '0');
  assert.equal(s.riskPerTrade, '', 'risk sizing is opt-in — blank means R only');
  assert.equal(fromDateTimeLocalValue(s.toValue), Math.floor(NOW_MS / 60_000) * 60_000);
  assert.equal(
    fromDateTimeLocalValue(s.fromValue),
    Math.floor(NOW_MS / 60_000) * 60_000 - 90 * DAY_MS,
    'default preset is the last 90 days',
  );
});

test('datetime-local round trip preserves minute precision', () => {
  const ms = Date.UTC(2024, 0, 15, 13, 45, 0);
  const value = toDateTimeLocalValue(ms);
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(fromDateTimeLocalValue(value), new Date(value).getTime());
  assert.equal(fromDateTimeLocalValue(''), null, 'blank is null, not epoch 0');
  assert.equal(fromDateTimeLocalValue('not-a-date'), null, 'garbage is null, never NaN');
});

test('applyRangePreset() changes only the range', () => {
  const base = validState();
  const next = applyRangePreset(base, '30d', NOW_MS);
  assert.equal(next.strategyId, base.strategyId);
  assert.equal(next.symbol, base.symbol);
  assert.equal(
    (fromDateTimeLocalValue(next.toValue) ?? 0) - (fromDateTimeLocalValue(next.fromValue) ?? 0),
    30 * DAY_MS,
  );
  assert.equal(applyRangePreset(base, 'nope' as '30d', NOW_MS), base, 'unknown preset is a no-op');
  assert.equal(BACKTEST_RANGE_PRESETS.length, 4);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validateBacktestForm() — a complete form is valid', () => {
  const built = buildBacktestRequest(validState(), NOW_MS);
  assert.equal(built.ok, true, JSON.stringify(built.ok ? {} : built.errors));
});

test('validateBacktestForm() — missing strategy/version is rejected before any request', () => {
  const built = buildBacktestRequest({ ...validState(), strategyId: '', versionId: '' }, NOW_MS);
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.errors.strategyVersion ?? '', /published version/);
});

test('validateBacktestForm() — missing instrument is rejected', () => {
  const built = buildBacktestRequest({ ...validState(), symbol: '  ' }, NOW_MS);
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.errors.instrument ?? '', /instrument/);
});

test('validateBacktestForm() — from >= to is rejected', () => {
  const same = toDateTimeLocalValue(NOW_MS - DAY_MS);
  const built = buildBacktestRequest({ ...validState(), fromValue: same, toValue: same }, NOW_MS);
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.errors.from ?? '', /earlier than the end/);
});

test('validateBacktestForm() — a future `to` is rejected (the service rejects it too)', () => {
  const future = toDateTimeLocalValue(NOW_MS + 2 * DAY_MS);
  const built = buildBacktestRequest({ ...validState(), toValue: future }, NOW_MS);
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.errors.to ?? '', /must not be in the future/);
});

test('validateBacktestForm() — a span over 10 years is rejected', () => {
  const from = toDateTimeLocalValue(NOW_MS - (MAX_BACKTEST_RANGE_MS + DAY_MS));
  const built = buildBacktestRequest({ ...validState(), fromValue: from, toValue: toDateTimeLocalValue(NOW_MS) }, NOW_MS);
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.errors.to ?? '', /10-year maximum/);
});

test('validateBacktestForm() — maxHoldCandles must be a whole number in 1..5000', () => {
  for (const bad of ['0', '5001', '12.5', 'abc', '']) {
    const built = buildBacktestRequest({ ...validState(), maxHoldCandles: bad }, NOW_MS);
    assert.equal(built.ok, false, `maxHoldCandles=${bad} must fail`);
    if (!built.ok) assert.ok(built.errors.maxHoldCandles, `error reported for ${bad}`);
  }
  const ok = buildBacktestRequest({ ...validState(), maxHoldCandles: '5000' }, NOW_MS);
  assert.equal(ok.ok, true);
});

test('validateBacktestForm() — negative or non-numeric costs are rejected', () => {
  for (const [field, value] of [
    ['feePerSide', '-1'],
    ['slippagePerSide', 'abc'],
    ['spread', '-0.5'],
  ] as const) {
    const built = buildBacktestRequest({ ...validState(), [field]: value }, NOW_MS);
    assert.equal(built.ok, false, `${field}=${value} must fail`);
    if (!built.ok) assert.ok(built.errors[field], `error reported for ${field}`);
  }
});

test('validateBacktestForm() — riskPerTrade must be positive when supplied, optional when blank', () => {
  for (const bad of ['0', '-10', 'xyz']) {
    const built = buildBacktestRequest({ ...validState(), riskPerTrade: bad }, NOW_MS);
    assert.equal(built.ok, false, `riskPerTrade=${bad} must fail`);
    if (!built.ok) assert.match(built.errors.riskPerTrade ?? '', /positive number/);
  }
  const blank = buildBacktestRequest({ ...validState(), riskPerTrade: '' }, NOW_MS);
  assert.equal(blank.ok, true);
  if (blank.ok) assert.equal('riskPerTrade' in blank.body.costPolicy!, false, 'blank risk is omitted, not sent as null');
});

// ---------------------------------------------------------------------------
// Request body == the shared contract's parsed output
// ---------------------------------------------------------------------------

test('buildBacktestRequest() — body parses with backtestRequestSchema and carries the pinned literals', () => {
  const state = { ...validState(), riskPerTrade: '250' };
  const built = buildBacktestRequest(state, NOW_MS);
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const { strategyId, versionId, ...rest } = built.body;
  assert.equal(strategyId, state.strategyId);
  assert.equal(versionId, state.versionId);

  const parsed = backtestRequestSchema.safeParse(rest);
  assert.equal(parsed.success, true, 'the body minus ids must satisfy the shared schema');

  assert.equal(built.body.exitPolicy?.sameCandleRule, 'stop_first', 'pinned same-candle rule');
  assert.equal(built.body.exitPolicy?.entryTiming, 'signal_close', 'pinned entry timing');
  assert.equal(built.body.exitPolicy?.maxHoldCandles, DEFAULT_MAX_HOLD_CANDLES);
  assert.equal(built.body.costPolicy?.riskPerTrade, 250);
  assert.equal(built.body.from, fromDateTimeLocalValue(state.fromValue));
  assert.equal(built.body.to, fromDateTimeLocalValue(state.toValue));
  assert.ok(built.body.from! < built.body.to!, 'from < to');
  assert.deepEqual(built.body.instrument, { assetClass: 'forex', symbol: 'EURUSD' });
});

test('buildBacktestRequest() — every preset range produces a contract-valid body', () => {
  for (const preset of BACKTEST_RANGE_PRESETS) {
    const state = applyRangePreset(validState(), preset.id, NOW_MS);
    const built = buildBacktestRequest(state, NOW_MS);
    assert.equal(built.ok, true, `preset ${preset.id} must be submittable`);
  }
});

// ---------------------------------------------------------------------------
// Result formatting — API values only
// ---------------------------------------------------------------------------

test('formatR() / formatRate() — signed R, percent rates, null-safe', () => {
  assert.equal(formatR(1.25), '+1.25R');
  assert.equal(formatR(-0.5), '-0.50R');
  assert.equal(formatR(0), '0.00R');
  assert.equal(formatR(null), '—', 'null metric is an em dash, never zero');
  assert.equal(formatR(undefined), '—');
  assert.equal(formatRate(0.425), '42.5%');
  assert.equal(formatRate(1), '100.0%');
  assert.equal(formatRate(0), '0.0%');
  assert.equal(formatRate(null), '—');
});

test('formatEpochMsUtc() — UTC-labelled, null-safe', () => {
  assert.equal(formatEpochMsUtc(Date.UTC(2024, 4, 1, 13, 5)), '2024-05-01 13:05 UTC');
  assert.equal(formatEpochMsUtc(null), '—');
});

test('exit reason labels/tones cover every contract value', () => {
  assert.equal(exitReasonLabel('stop_loss'), 'Stop loss');
  assert.equal(exitReasonLabel('take_profit_3'), 'Take profit 3');
  assert.equal(exitReasonLabel('max_hold'), 'Max hold');
  assert.equal(exitReasonLabel('range_end'), 'Range end');
  assert.equal(exitReasonLabel('no_levels'), 'No levels');
  assert.equal(exitReasonTone('stop_loss'), 'danger');
  assert.equal(exitReasonTone('take_profit_1'), 'success');
  assert.equal(exitReasonTone('max_hold'), 'warning');
  assert.equal(directionLabel('both'), 'Long + short');
  assert.equal(directionLabel('long'), 'Long');
  assert.equal(directionLabel('short'), 'Short');
});

test('truncationIndicators() — reports the engine anchor cap only, never trade truncation', () => {
  const anchorNote = `Anchor range holds 2400 setup closes — evaluated the first 2000 in ascending order (MAX_BACKTEST_STEPS). Split the range to cover the rest.`;
  const withNote = truncationIndicators({ notes: [anchorNote, 'unrelated note'] });
  assert.equal(withNote.length, 1);
  assert.match(withNote[0]!, /Anchor limit reached/);
  assert.deepEqual(truncationIndicators({ notes: [] }), [], 'no indicators when nothing was limited');
  assert.equal(truncationIndicators({ notes: ['warm-up note'] }).length, 0);
  // Trade truncation is the trades table's job (the two read endpoints define
  // `truncated` differently), so it must not leak into the run summary.
  for (const line of withNote) assert.ok(!/trades are stored per run/.test(line));
});

test('metricTiles() — one tile per API metric, currency only with a risk per trade', () => {
  const metrics = {
    stepsEvaluated: 250,
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
  };
  const withoutCurrency = metricTiles(metrics, { showsCurrency: false });
  assert.equal(withoutCurrency.some((t) => t.label === 'Total currency'), false);
  const withCurrency = metricTiles(metrics, { showsCurrency: true });
  assert.ok(withCurrency.find((t) => t.label === 'Total currency')?.value === '875.00');

  const labels = withoutCurrency.map((t) => t.label);
  for (const expected of [
    'Setups detected',
    'Trades closed',
    'Wins',
    'Losses',
    'Win rate',
    'Average R',
    'Avg win',
    'Avg loss',
    'Net result',
    'Max drawdown',
    'Profit factor',
    'Steps evaluated',
  ]) {
    assert.ok(labels.includes(expected), `missing tile: ${expected}`);
  }

  // A null profit factor (no losing trades) must read as undefined, not 0.
  const noLoss = metricTiles({ ...metrics, profitFactor: null }, { showsCurrency: false });
  const pf = noLoss.find((t) => t.label === 'Profit factor');
  assert.equal(pf?.value, '—');
  assert.match(pf?.hint ?? '', /undefined/);
});

// ---------------------------------------------------------------------------
// Trade paging — the API's `truncated` flag is the only authority
// ---------------------------------------------------------------------------

/** A minimal, schema-valid trade; `seq` is the paging identity. */
function pagingTrade(seq: number): BacktestTrade {
  return backtestTradeDtoSchema.parse({
    seq,
    direction: 'long',
    signalAsOfMs: 1_704_153_600_000 + seq * 3_600_000,
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
  });
}

function tradesUpTo(count: number): BacktestTrade[] {
  return Array.from({ length: count }, (_, i) => pagingTrade(i + 1));
}

/** Page state as produced by `GET /api/backtests/:id` (every stored trade). */
function completeRunPage(count: number): TradesPageState {
  return { trades: tradesUpTo(count), truncated: false, limit: TRADES_PAGE_SIZES[TRADES_PAGE_SIZES.length - 1] };
}

test('mergeTrades() — a smaller page never replaces the trades already loaded', () => {
  // Regression for the review finding: the detail endpoint returns all 230
  // stored trades with `truncated: false`; `?limit=100` returns 100 with
  // `truncated: true`. Replacing instead of merging dropped 130 visible rows.
  const loaded = tradesUpTo(230);
  const smaller = tradesUpTo(100);
  const merged = mergeTrades(loaded, smaller);
  assert.equal(merged.length, 230, 'the visible count must not decrease');
  assert.deepEqual(merged.map((t) => t.seq), Array.from({ length: 230 }, (_, i) => i + 1), 'ascending, no gaps');

  assert.equal(mergeTrades([], smaller).length, 100, 'first page loads as-is');
  assert.equal(mergeTrades(smaller, tradesUpTo(230)).length, 230, 'a bigger page grows the view');
  assert.deepEqual(mergeTrades(smaller, smaller).map((t) => t.seq), Array.from({ length: 100 }, (_, i) => i + 1), 'identical pages dedupe by seq');
});

test('applyTradesPage() — paging grows the visible set and keeps the truncation signal', () => {
  const start = completeRunPage(230);

  // The bug path: a 100-row response arriving over a complete 230-row view.
  const afterSmaller = applyTradesPage(start, { trades: tradesUpTo(100), truncated: true, limit: 100 });
  assert.equal(afterSmaller.trades.length, 230, '230 visible trades are not replaced by 100');
  // The complete detail result is the larger page, so its `truncated: false`
  // stands: the stale 100-row page must not invent missing rows.
  assert.equal(afterSmaller.truncated, false, 'a smaller page cannot un-truncate nothing');
  assert.equal(afterSmaller.limit, 500, 'the largest page requested so far is remembered');
  assert.equal(tradesHasMore(afterSmaller), false, 'so no Load more control is offered');
  assert.equal(tradesTruncationMessage({ truncated: afterSmaller.truncated, loaded: afterSmaller.trades.length }), null, 'and no warning caption is rendered');

  // Genuine pagination of a 300-trade run: every intermediate page is
  // truncated (300 > limit) until the 500-slot page returns all 300 rows with
  // `truncated: false`. The last response must win, or the table would keep
  // offering a control that can never return another row.
  const stored = 300;
  let state: TradesPageState = { trades: tradesUpTo(50), truncated: true, limit: 50 };
  const seen = [50];
  for (const size of [100, 250, MAX_BACKTEST_TRADES] as const) {
    const rows = Math.min(size, stored);
    // The API's own formula: setups > rows returned, or setups > limit asked for.
    const truncated = stored > rows || stored > size;
    state = applyTradesPage(state, { trades: tradesUpTo(rows), truncated, limit: size });
    seen.push(state.trades.length);
    assert.equal(state.limit, size, 'the requested page size is recorded');
  }
  assert.deepEqual(seen, [50, 100, 250, stored], 'each page strictly grows the view');
  assert.equal(state.trades.length, stored);
  assert.equal(state.truncated, false, 'a page covering every stored trade clears the flag');
  assert.equal(tradesHasMore(state), false, 'so no dead control is offered');
  assert.equal(tradesTruncationMessage({ truncated: state.truncated, loaded: state.trades.length }), null);

  // A run with more setups than the API stores stays honestly truncated at the cap.
  const capped = applyTradesPage(
    { trades: tradesUpTo(250), truncated: true, limit: 250 },
    { trades: tradesUpTo(MAX_BACKTEST_TRADES), truncated: true, limit: MAX_BACKTEST_TRADES },
  );
  assert.equal(capped.trades.length, MAX_BACKTEST_TRADES);
  assert.equal(capped.truncated, true, 'the cap message remains truthful');
  assert.equal(tradesHasMore(capped), false, 'nothing further can be fetched');
  assert.match(tradesTruncationMessage({ truncated: capped.truncated, loaded: capped.trades.length })!, /at most 500 trades are kept/);
});

test('tradesHasMore() — follows the API flag and stops at the storage cap', () => {
  // A complete run of 230: the old `trades.length >= limit` heuristic offered a
  // control that could only shrink the table.
  assert.equal(tradesHasMore({ trades: tradesUpTo(230), truncated: false }), false, 'complete run — nothing more to fetch');
  assert.equal(tradesHasMore({ trades: tradesUpTo(100), truncated: true }), true, 'truncated below the cap — more available');
  assert.equal(tradesHasMore({ trades: tradesUpTo(MAX_BACKTEST_TRADES), truncated: true }), false, 'at the cap — no request can return another row');
  assert.equal(tradesHasMore({ trades: [], truncated: false }), false);
  assert.equal(MAX_BACKTEST_TRADES, 500, 'the backend maximum this UI must preserve');
});

test('nextTradesPageSize() — always asks for a strictly larger page', () => {
  assert.equal(nextTradesPageSize(0), 50);
  assert.equal(nextTradesPageSize(50), 100);
  assert.equal(nextTradesPageSize(100), 250);
  assert.equal(nextTradesPageSize(250), MAX_BACKTEST_TRADES);
  assert.equal(nextTradesPageSize(MAX_BACKTEST_TRADES), undefined, 'no larger page exists at the cap');
  assert.equal(nextTradesPageSize(230), 250, 'a complete 230-row view would still ask for a bigger page, never a smaller one');
  for (const size of TRADES_PAGE_SIZES) assert.ok(size <= MAX_BACKTEST_TRADES, 'every page size respects the 500-trade maximum');
});

test('tradesTruncationMessage() — only the real 500-trade cap is described as a cap', () => {
  assert.equal(tradesTruncationMessage({ truncated: false, loaded: 230 }), null, 'a complete result gets no warning');
  const paging = tradesTruncationMessage({ truncated: true, loaded: 100 });
  assert.match(paging!, /Showing the first 100 trades of this run/);
  assert.match(paging!, /load more to see the rest/);
  assert.ok(!paging!.includes(String(MAX_BACKTEST_TRADES)), 'no false "at most 500" claim mid-paging');
  const atCap = tradesTruncationMessage({ truncated: true, loaded: MAX_BACKTEST_TRADES });
  assert.match(atCap!, new RegExp(`at most ${MAX_BACKTEST_TRADES} trades are kept`));
});

test('backtestHistoryCopy() — the advertised page size is the one actually requested', () => {
  const copy = backtestHistoryCopy();
  assert.equal(DEFAULT_BACKTESTS_PAGE_SIZE, DEFAULT_BACKTESTS_LIMIT, 'the list requests the contract default');
  assert.ok(copy.subtitle.includes(`most recent ${DEFAULT_BACKTESTS_PAGE_SIZE} runs`), `subtitle: ${copy.subtitle}`);
  assert.ok(copy.footnote.includes(`most recent ${DEFAULT_BACKTESTS_PAGE_SIZE} runs`), `footnote: ${copy.footnote}`);
  assert.ok(copy.footnote.includes(`caps a single page at ${MAX_BACKTESTS_LIMIT}`), 'the API maximum is stated separately and truthfully');
  assert.ok(!copy.subtitle.includes('100'), 'the copy must not over-promise relative to the request');
});
