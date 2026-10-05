/**
 * M6.3 — backtest cost units (focused regression tests, engine `m6-backtest-3`).
 *
 * THE BUG THESE TESTS PIN. Cost policies carried three bare numbers
 * (`feePerSide`, `slippagePerSide`, `spread`) and the engine read all of them
 * as RAW PRICE UNITS. For XAUUSD that silently misreads a pip-minded author:
 * a run reported on the platform entered long at 4380.01175 with a stop at
 * 4379.9708 (a 0.04095 price-unit risk distance) and TP3 at 4380.1346 — a
 * gross +3R trade — and was charged "30" of cost as 30 *price units* of gold,
 * reporting **−729.60R** for a trade that hit its take profit.
 *
 * THE FIX. `costPolicy.costUnit` makes the denomination explicit and
 * instrument-aware:
 *  - `'price'` (default) — unchanged historical behaviour, so FX and every
 *    stored run replay byte-identically;
 *  - `'pips'` — converted with the instrument's pip size, via the SAME pinned
 *    convention (`pipSizeFor`) that derived the candidate levels, so costs and
 *    the R denominator can never be expressed in two different units.
 *
 * No database, no provider, no wall clock: `runBacktest` is pure.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKTEST_ENGINE_VERSION,
  backtestCostPolicySchema,
  backtestMetricsSchema,
  backtestTradeDtoSchema,
  strategyVersionConfigSchema,
  type BacktestCostPolicy,
  type BacktestEngineResult,
  type CandleDto,
  type StrategyRuleGroup,
  type StrategyVersionConfig,
} from '@veltrixeye/contracts';
import { resolveBacktestCosts, runBacktest } from '../src/backtest/engine.js';
import { pipSizeFor } from '../src/strategies/evaluation/indicators.js';
import { isDomainError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// Deterministic builders (no wall clock anywhere)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
/** Grid base: every hourly fixture candle opens at T0 + i*HOUR. */
const T0 = 1_800_000_000_000;

function candle(time: number, open: number, high: number, low: number, close: number): CandleDto {
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close), 'fixture violates OHLC invariant');
  return { time, open, high, low, close, volume: null };
}

/** Hourly series from [open, high, low, close] shapes (first opens at T0). */
function hourly(shapes: Array<[number, number, number, number]>): CandleDto[] {
  return shapes.map(([o, h, l, c], i) => candle(T0 + i * HOUR, o, h, l, c));
}

/** Close time of hourly candle i. */
const closeOf = (i: number): number => T0 + (i + 1) * HOUR;

function cond(
  conditionType: string,
  classification: 'required' | 'optional' | 'confirmation' | 'disqualifying',
  timeframeRole: 'htf_bias' | 'setup' | 'entry' | 'any',
  params: Record<string, unknown> = {},
): StrategyRuleGroup['conditions'][number] {
  return { conditionType, classification, timeframeRole, params, position: 0 };
}

function group(name: string, logic: 'AND' | 'OR', conditions: StrategyRuleGroup['conditions']): StrategyRuleGroup {
  return { name, logic, position: 0, conditions };
}

/**
 * Every anchor qualifies on both directions (body range ≥ 0 always holds), so
 * the levels — and therefore the cost arithmetic — are the only variable.
 */
function mkConfig(riskOverrides: Record<string, unknown> = {}): StrategyVersionConfig {
  return strategyVersionConfigSchema.parse({
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'all' },
    risk: {
      minRr: 2,
      stopLossMethod: 'fixed',
      stopLossBuffer: 10,
      stopLossBufferUnit: 'pips',
      takeProfitMethod: 'rr',
      tp1Rr: 1,
      tp2Rr: 2,
      tp3Rr: 3,
      minQualityScore: 65,
      ...riskOverrides,
    },
    ruleGroups: [
      group('Pass', 'AND', [cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 })]),
    ],
  });
}

const XAUUSD = { assetClass: 'commodity', symbol: 'XAUUSD' };
const EURUSD = { assetClass: 'forex', symbol: 'EURUSD' };

function run(opts: {
  config: StrategyVersionConfig;
  instrument: { assetClass: string; symbol: string };
  setup: CandleDto[];
  fromMs: number;
  toMs: number;
  direction?: 'long' | 'short' | 'both';
  exitPolicy?: unknown;
  costPolicy?: unknown;
}): BacktestEngineResult {
  return runBacktest({
    config: opts.config,
    instrument: opts.instrument,
    candles: { htf_bias: opts.setup, setup: opts.setup, entry: opts.setup },
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    direction: opts.direction ?? 'long',
    exitPolicy: opts.exitPolicy,
    costPolicy: opts.costPolicy,
  });
}

function first<T>(arr: readonly T[]): T {
  const item = arr[0];
  assert.ok(item !== undefined, 'expected at least one trade');
  return item;
}

/** Float-tolerant price equality (levels are derived, so they carry ULP noise). */
function assertPrice(actual: number | null, expected: number, label: string): void {
  assert.ok(actual !== null, `${label} must be derived`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${String(actual)} ≈ ${expected}`);
}

/** Every engine output must satisfy its contract schema. */
function assertValidResult(result: BacktestEngineResult): void {
  for (const t of result.trades) backtestTradeDtoSchema.parse(t);
  backtestMetricsSchema.parse(result.metrics);
}

// ---------------------------------------------------------------------------
// The reported XAUUSD run: entry 4380.01175, SL 4379.9708, TP3 4380.1346
// ---------------------------------------------------------------------------

/**
 * Gold levels exactly as reported. The version's fixed stop buffer is 409.5
 * "pips", which under the platform's pinned pip convention for XAUUSD
 * (`pipSizeFor('XAUUSD') === 0.0001`) is 0.04095 price units — the same
 * convention produced the reported levels, and it is the convention the cost
 * conversion must share (see `resolveBacktestCosts`).
 */
const REPORTED_ENTRY = 4380.01175;
const REPORTED_STOP = 4379.9708;
const REPORTED_TP3 = 4380.1346;
/** 30 units of cost: fee 5 + slippage 5 per side (2 × 10) + spread 10. */
const REPORTED_COST_INPUTS = { feePerSide: 5, slippagePerSide: 5, spread: 10 };

const goldConfig = () => mkConfig({ stopLossBuffer: 409.5, stopLossBufferUnit: 'pips' });

/** Signal at candle 1, TP3 touch at candle 2 (never touching the stop). */
const goldSeries = () =>
  hourly([
    [4379.5, 4380.2, 4379.3, 4380.0],
    [4379.8, 4380.25, 4379.7, REPORTED_ENTRY], // signal candle: entry = close
    [4380.05, 4380.15, 4380.0, 4380.1], // exits at TP3 (high ≥ 4380.1346, low > stop)
    [4380.1, 4380.3, 4380.05, 4380.2],
  ]);

const runGold = (costPolicy: unknown) =>
  run({
    config: goldConfig(),
    instrument: XAUUSD,
    setup: goldSeries(),
    fromMs: closeOf(1),
    toMs: closeOf(2),
    direction: 'long',
    exitPolicy: { takeProfit: 'tp3' },
    costPolicy,
  });

describe('m6.3 backtest cost units — XAUUSD regression', () => {
  test('engine identity is the cost-unit version', () => {
    assert.equal(BACKTEST_ENGINE_VERSION, 'm6-backtest-3');
  });

  test('REGRESSION: pip-denominated XAUUSD costs keep the TP3 trade positive (+2.9267R, never −729.60R)', () => {
    const result = runGold({ costUnit: 'pips', ...REPORTED_COST_INPUTS });
    assertValidResult(result);
    assert.equal(result.trades.length, 1);

    const trade = first(result.trades);
    assert.equal(trade.direction, 'long');
    // The reported levels, derived by the real M3/M4 math.
    assertPrice(trade.entryPrice, REPORTED_ENTRY, 'entryPrice');
    assertPrice(trade.stopLossPrice, REPORTED_STOP, 'stopLossPrice');
    assertPrice(trade.tp3Price, REPORTED_TP3, 'tp3Price');
    assert.equal(trade.exitReason, 'take_profit_3');
    assertPrice(trade.exitPrice, REPORTED_TP3, 'exitPrice');

    // Gross move is +3R (0.12285 / 0.04095); 30 pips of gold cost 0.003 price
    // units ⇒ (0.12285 − 0.003) / 0.04095 = +2.9267R.
    assert.equal(trade.pnlR, 2.9267);
    assert.ok((trade.pnlR ?? 0) > 0, 'a take-profit exit must not report a catastrophic loss');
    assert.equal(result.metrics.tradesClosed, 1);
    assert.equal(result.metrics.wins, 1);
    assert.equal(result.metrics.losses, 0);
    assert.equal(result.metrics.totalR, 2.9267);
  });

  test('the same numbers stay a price-unit cost only when the author says so (the −729.60R reading is explicit)', () => {
    // `costUnit` defaults to 'price', so an author who really means 30 price
    // units of gold still gets exactly the historical (huge) charge — the
    // interpretation is now chosen, never assumed.
    const result = runGold(REPORTED_COST_INPUTS);
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'take_profit_3');
    assert.equal(trade.pnlR, -729.6007, 'the reported figure, reachable only as an explicit price-unit cost');
    assert.ok(!result.notes.some((n) => n.includes('pip-denominated')), 'price-unit runs add no conversion note');

    // And an explicit `costUnit: 'price'` is byte-identical to the default.
    assert.deepEqual(runGold({ costUnit: 'price', ...REPORTED_COST_INPUTS }), result);
  });

  test('a pip-denominated run records the conversion it used (deterministic note)', () => {
    const result = runGold({ costUnit: 'pips', ...REPORTED_COST_INPUTS });
    const note = result.notes.find((n) => n.includes('pip-denominated'));
    assert.ok(note, 'the run must state the pip conversion it applied');
    assert.ok(note.includes("costUnit \"pips\""), 'names the unit');
    assert.ok(note.includes('XAUUSD'), 'names the instrument');
    assert.ok(note.includes('1 pip = 0.0001'), 'states the pip size used');
    assert.ok(note.includes('0.003 price units'), 'states the resulting per-trade cost');
    // Determinism: an identical replay is byte-identical, notes included.
    assert.deepEqual(runGold({ costUnit: 'pips', ...REPORTED_COST_INPUTS }), result);
  });

  test('riskPerTrade is an account-currency amount — never pip-scaled', () => {
    const result = runGold({ costUnit: 'pips', ...REPORTED_COST_INPUTS, riskPerTrade: 250 });
    const trade = first(result.trades);
    assert.equal(trade.pnlR, 2.9267);
    assert.equal(trade.pnlCurrency, 731.68, 'round2(2.9267 × 250)');
    assert.equal(result.metrics.totalCurrency, 731.68);
  });
});

// ---------------------------------------------------------------------------
// Instrument-aware conversion, and FX behaviour preserved
// ---------------------------------------------------------------------------

describe('m6.3 backtest cost units — conversion + FX preservation', () => {
  const policy = (input: unknown): BacktestCostPolicy => backtestCostPolicySchema.parse(input);

  test('costUnit defaults to price, so existing payloads are unchanged', () => {
    const parsed = policy({});
    assert.equal(parsed.costUnit, 'price');
    assert.deepEqual(parsed, { costUnit: 'price', feePerSide: 0, slippagePerSide: 0, spread: 0 });
  });

  test('unknown cost units are rejected at the engine boundary', () => {
    for (const costUnit of ['bps', 'percent', 'PIPS', '']) {
      try {
        runGold({ costUnit, ...REPORTED_COST_INPUTS });
        assert.fail(`costUnit ${JSON.stringify(costUnit)} must be refused`);
      } catch (err) {
        assert.equal(isDomainError(err), true);
        assert.match((err as Error).message, /Invalid backtest cost policy/);
      }
    }
    assert.equal(backtestCostPolicySchema.safeParse({ costUnit: 'bps' }).success, false);
  });

  test('resolveBacktestCosts scales pips by the instrument pip size only', () => {
    // price units: no scaling, whatever the instrument.
    for (const symbol of ['EURUSD', 'USDJPY', 'XAUUSD', 'BTCUSD']) {
      const price = resolveBacktestCosts(policy({ ...REPORTED_COST_INPUTS }), pipSizeFor(symbol));
      assert.equal(price.unit, 'price');
      assert.equal(price.total, 30, `${symbol}: price-unit costs are not scaled`);
    }
    // pips: value × pipSize, per instrument.
    const cases: Array<[string, number]> = [
      ['EURUSD', 30 * 0.0001],
      ['GBPUSD', 30 * 0.0001],
      ['USDJPY', 30 * 0.01],
      ['XAUUSD', 30 * 0.0001],
    ];
    for (const [symbol, expected] of cases) {
      const pips = resolveBacktestCosts(policy({ costUnit: 'pips', ...REPORTED_COST_INPUTS }), pipSizeFor(symbol));
      assert.equal(pips.unit, 'pips');
      assert.equal(pips.pipSize, pipSizeFor(symbol));
      assert.ok(Math.abs(pips.total - expected) < 1e-12, `${symbol}: 30 pips = ${expected} price units`);
    }
  });

  test('FX behaviour is preserved: pips on EURUSD equal the explicit price-unit costs', () => {
    const setup = hourly([
      [100, 100.0005, 99.9998, 100.0002],
      [100, 100.0005, 99.998, 100], // signal (entry = close = 100)
      [100, 100.0035, 99.9995, 100.0015], // touches TP3 (100.003), never the stop (99.999)
      [100, 100.0005, 99.9998, 100.0002],
    ]);
    const opts = {
      config: mkConfig(), // fixed 10-pip stop ⇒ riskDistance 0.001 on EURUSD
      instrument: EURUSD,
      setup,
      fromMs: closeOf(1),
      toMs: closeOf(2),
      direction: 'long' as const,
    };
    const inPips = run({ ...opts, costPolicy: { costUnit: 'pips', feePerSide: 2, slippagePerSide: 1, spread: 2 } });
    const inPrice = run({ ...opts, costPolicy: { feePerSide: 0.0002, slippagePerSide: 0.0001, spread: 0.0002 } });

    assert.equal(first(inPips.trades).exitReason, 'take_profit_3');
    // 8 pips of EURUSD cost = 0.0008 price units ⇒ (0.003 − 0.0008)/0.001 = +2.2R.
    assert.equal(first(inPips.trades).pnlR, 2.2);
    assert.deepEqual(inPips.trades, inPrice.trades, 'same R, whichever unit expressed it');
    assert.deepEqual(inPips.metrics, inPrice.metrics);
    assert.ok(!inPrice.notes.some((n) => n.includes('pip-denominated')));
    assert.ok(inPips.notes.some((n) => n.includes('1 pip = 0.0001')));
  });

  test('a frictionless run is identical in both units (zero scales to zero)', () => {
    const zeroPips = runGold({ costUnit: 'pips' });
    const zeroPrice = runGold({});
    assert.deepEqual(zeroPips.trades, zeroPrice.trades);
    assert.equal(first(zeroPips.trades).pnlR, 3, 'gross +3R with no costs');
  });
});
