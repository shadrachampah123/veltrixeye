import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BACKTEST_STEPS,
  backtestMetricsSchema,
  backtestTradeDtoSchema,
  strategyVersionConfigSchema,
  type BacktestEngineResult,
  type CandleDto,
  type StrategyRuleGroup,
  type StrategyVersionConfig,
  type Timeframe,
} from '@veltrixeye/contracts';
import { isDomainError, runBacktest } from '../src/index.js';

// ---------------------------------------------------------------------------
// Deterministic builders (no wall clock anywhere)
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 86_400_000;
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

/** Flat 100s series (never pins, never touches 10-pip levels around 100). */
function flat(count: number, price = 100): CandleDto[] {
  return Array.from({ length: count }, (_, i) => candle(T0 + i * HOUR, price, price, price, price));
}

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

function mkConfig(
  ruleGroups: StrategyRuleGroup[],
  riskOverrides: Record<string, unknown> = {},
  timeframes: { htf_bias: Timeframe; setup: Timeframe; entry: Timeframe } = {
    htf_bias: '1h',
    setup: '1h',
    entry: '1h',
  },
): StrategyVersionConfig {
  return strategyVersionConfigSchema.parse({
    timeframes,
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
    ruleGroups,
  });
}

/** Passes on both directions whenever ≥2 setup candles exist (body-range ≥ 0 always holds). */
const alwaysPass = () =>
  mkConfig([
    group('Pass', 'AND', [cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 })]),
  ]);

/** Long-only signals on bullish pins (lowerWick/body ≥ 2). */
const longPins = () =>
  mkConfig([
    group('Pins', 'AND', [cond('rejection_candle', 'required', 'setup', { direction: 'bullish', minWickBodyRatio: 2 })]),
  ]);

/** Short-only signals on bearish pins. */
const shortPins = () =>
  mkConfig([
    group('Pins', 'AND', [cond('rejection_candle', 'required', 'setup', { direction: 'bearish', minWickBodyRatio: 2 })]),
  ]);

const INSTRUMENT = { assetClass: 'forex', symbol: 'EURUSD' };

/**
 * Fixed 10-pip stops on EURUSD: entry E ⇒ stop E−0.001, tp1 E+0.001,
 * tp2 E+0.002, tp3 E+0.003, riskDistance 0.001 (short legs mirrored).
 */
function run(opts: {
  config: StrategyVersionConfig;
  setup: CandleDto[];
  htf?: CandleDto[];
  entry?: CandleDto[];
  fromMs: number;
  toMs: number;
  direction?: 'long' | 'short' | 'both';
  exitPolicy?: unknown;
  costPolicy?: unknown;
}): BacktestEngineResult {
  return runBacktest({
    config: opts.config,
    instrument: INSTRUMENT,
    candles: { htf_bias: opts.htf ?? opts.setup, setup: opts.setup, entry: opts.entry ?? opts.setup },
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    direction: opts.direction ?? 'both',
    exitPolicy: opts.exitPolicy,
    costPolicy: opts.costPolicy,
  });
}

/** Every engine output must satisfy its contract schema. */
function assertValidResult(result: BacktestEngineResult): void {
  for (const t of result.trades) backtestTradeDtoSchema.parse(t);
  backtestMetricsSchema.parse(result.metrics);
}

/** Signal identity (excludes exits): the look-ahead-sensitive part of a result. */
function signalsOf(result: BacktestEngineResult): Array<[number, string, number | null, number | null, number | null]> {
  return result.trades.map((t) => [t.signalAsOfMs, t.direction, t.entryPrice, t.stopLossPrice, t.qualityScore]);
}

const NORMAL: [number, number, number, number] = [100, 100.0005, 99.9998, 100.0002];
const BULL_PIN: [number, number, number, number] = [100, 100.0005, 99.998, 100];
const BEAR_PIN: [number, number, number, number] = [100, 100.002, 99.9995, 100];

function first<T>(arr: readonly T[]): T {
  const item = arr[0];
  assert.ok(item !== undefined);
  return item;
}

// ---------------------------------------------------------------------------
// Input validation (pure — no I/O, deterministic errors)
// ---------------------------------------------------------------------------

describe('m6 backtest engine input validation', () => {
  test('rejects inverted/empty bounds and non-positive anchors', () => {
    const setup = hourly([NORMAL, NORMAL]);
    const pairs: Array<[number, number]> = [
      [closeOf(1), closeOf(1)],
      [closeOf(2), closeOf(1)],
      [0, closeOf(1)],
      [-5, closeOf(1)],
      [closeOf(0), 0],
    ];
    for (const [fromMs, toMs] of pairs) {
      try {
        run({ config: alwaysPass(), setup, fromMs, toMs });
        assert.fail(`expected rejection for [${fromMs}, ${toMs})`);
      } catch (err) {
        assert.equal(isDomainError(err), true);
        assert.match((err as Error).message, /fromMs|positive integer/);
      }
    }
  });

  test('rejects versions without timeframes/risk and malformed policies', () => {
    const setup = hourly([NORMAL, NORMAL, NORMAL]);
    const noTf = { ...alwaysPass(), timeframes: undefined };
    assert.throws(() => run({ config: noTf, setup, fromMs: closeOf(0), toMs: closeOf(2) }), /config\.timeframes/);
    const noRisk = { ...alwaysPass(), risk: undefined };
    assert.throws(() => run({ config: noRisk, setup, fromMs: closeOf(0), toMs: closeOf(2) }), /config\.risk/);
    assert.throws(
      () => run({ config: alwaysPass(), setup, fromMs: closeOf(0), toMs: closeOf(2), exitPolicy: { stopLoss: 'x' } }),
      /Invalid backtest exit policy/,
    );
    assert.throws(
      () => run({ config: alwaysPass(), setup, fromMs: closeOf(0), toMs: closeOf(2), costPolicy: { feePerSide: -1 } }),
      /Invalid backtest cost policy/,
    );
    // The pinned literals are not configurable, even at the engine boundary.
    assert.throws(
      () =>
        run({ config: alwaysPass(), setup, fromMs: closeOf(0), toMs: closeOf(2), exitPolicy: { sameCandleRule: 'tp_first' } }),
      /Invalid backtest exit policy/,
    );
  });

  test('empty range (no setup closes) evaluates nothing and stays schema-valid', () => {
    const setup = hourly([NORMAL, NORMAL]);
    const result = run({ config: alwaysPass(), setup, fromMs: T0, toMs: T0 + 1 });
    assert.equal(result.stepsEvaluated, 0);
    assert.deepEqual(result.trades, []);
    assert.deepEqual(result.metrics, {
      stepsEvaluated: 0,
      setupsDetected: 0,
      tradesClosed: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      expectancyR: null,
      profitFactor: null,
      maxDrawdownR: null,
      avgWinR: null,
      avgLossR: null,
      totalR: 0,
      totalCurrency: null,
    });
    assert.equal(result.notes.length, 1);
    assert.match(first(result.notes), /nothing evaluated/);
    assertValidResult(result);
  });
});

// ---------------------------------------------------------------------------
// Anchors, determinism, warm-up
// ---------------------------------------------------------------------------

describe('m6 anchors, determinism and warm-up', () => {
  test('anchors are setup closes in [fromMs, toMs): from inclusive, to exclusive', () => {
    const setup = hourly([NORMAL, BULL_PIN, NORMAL, NORMAL]);
    const result = run({ config: longPins(), setup, fromMs: closeOf(1), toMs: closeOf(2), direction: 'long' });
    assert.equal(result.stepsEvaluated, 1);
    assert.equal(result.trades.length, 1);
    assert.equal(first(result.trades).signalAsOfMs, closeOf(1));

    const wider = run({ config: longPins(), setup, fromMs: closeOf(0), toMs: closeOf(3), direction: 'long' });
    assert.equal(wider.stepsEvaluated, 3);
    assert.deepEqual(
      wider.trades.map((t) => t.signalAsOfMs),
      [closeOf(1)],
    );
  });

  test('identical inputs replay byte-identically (and stay schema-valid)', () => {
    const setup = hourly([NORMAL, BULL_PIN, [100, 100.0025, 99.9995, 100.0015], NORMAL]);
    const opts = {
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(3),
      direction: 'long' as const,
      exitPolicy: { takeProfit: 'tp2' },
      costPolicy: { feePerSide: 0.0001 },
    };
    const a = run(opts);
    const b = run(opts);
    assert.deepEqual(a, b);
    assertValidResult(a);
  });

  test('ranges over MAX_BACKTEST_STEPS keep the first 2000 anchors and note the truncation', () => {
    const shapes: Array<[number, number, number, number]> = Array.from({ length: 2100 }, () => NORMAL);
    shapes[5] = BULL_PIN;
    shapes[6] = BULL_PIN;
    const setup = hourly(shapes);
    const full = run({ config: longPins(), setup, fromMs: closeOf(0), toMs: closeOf(2099) + 1, direction: 'long' });
    assert.equal(full.stepsEvaluated, MAX_BACKTEST_STEPS);
    assert.ok(full.notes.some((n) => n.includes('2100') && n.includes('2000')));

    // The truncated run replayed exactly the first-2000 prefix: same trades/metrics
    // as a run whose whole range fits under the cap (exits resolve early).
    const prefix = hourly(shapes.slice(0, 2000));
    const bounded = run({ config: longPins(), setup: prefix, fromMs: closeOf(0), toMs: closeOf(1999) + 1, direction: 'long' });
    assert.equal(bounded.stepsEvaluated, 2000);
    assert.ok(!bounded.notes.some((n) => n.includes('MAX_BACKTEST_STEPS')));
    assert.deepEqual(full.trades, bounded.trades);
    assert.deepEqual(full.metrics, bounded.metrics);
  });

  test('warm-up reuses the M3 window math and is reported, never skipped', () => {
    // support lookback 500 ⇒ required setup window 560; the series starts below it.
    const wide = mkConfig(
      [
        group('Wide', 'AND', [
          cond('support', 'required', 'setup', { minTouches: 2, lookbackCandles: 500 }),
          cond('rejection_candle', 'required', 'setup', { direction: 'bullish', minWickBodyRatio: 2 }),
        ]),
      ],
      {},
    );
    const setup = flat(600);
    const result = run({ config: wide, setup, fromMs: closeOf(0), toMs: closeOf(599) + 1, direction: 'long' });
    assert.equal(result.stepsEvaluated, 600);
    assert.equal(result.trades.length, 0); // flat 100s never satisfy support+pin
    const warm = result.notes.find((n) => n.includes('warm-up window'));
    assert.ok(warm);
    assert.ok(warm.includes('559 of 600') && warm.includes('560'));

    // Anchors already past the window produce no warm-up note.
    const warmed = run({ config: wide, setup, fromMs: closeOf(559), toMs: closeOf(599) + 1, direction: 'long' });
    assert.equal(warmed.stepsEvaluated, 41); // closes 559..599 inclusive
    assert.ok(!warmed.notes.some((n) => n.includes('warm-up window')));
  });
});

// ---------------------------------------------------------------------------
// Long exits
// ---------------------------------------------------------------------------

describe('m6 long exits (signal_close entry, setup-TF scan)', () => {
  /** Pin at idx 1 (entry 100, stop 99.999, tp1/2/3 100.001/2/3), crafted exit at idx 2. */
  function longSetup(exit: [number, number, number, number]): CandleDto[] {
    return hourly([NORMAL, BULL_PIN, exit, NORMAL]);
  }
  const range = { fromMs: closeOf(0), toMs: closeOf(3) };

  test('stop touched ⇒ stop_loss at the stop (−1R frictionless)', () => {
    const setup = longSetup([100, 100.0005, 99.998, 99.9992]);
    const result = run({ config: longPins(), setup, ...range, direction: 'long' });
    assert.equal(result.trades.length, 1);
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'stop_loss');
    assert.equal(trade.entryPrice, 100);
    assert.ok(trade.stopLossPrice !== null && Math.abs(trade.stopLossPrice - 99.999) < 1e-9);
    assert.equal(trade.exitPrice, trade.stopLossPrice);
    assert.equal(trade.exitAsOfMs, closeOf(2));
    assert.equal(trade.pnlR, -1);
    assert.equal(trade.pnlCurrency, null);
    assertValidResult(result);
  });

  test('tp1/tp2/tp3 touched ⇒ matching take-profit reason (+1/+2/+3R)', () => {
    const cases = [
      { takeProfit: 'tp1', high: 100.0015, reason: 'take_profit_1', pnlR: 1 },
      { takeProfit: 'tp2', high: 100.0025, reason: 'take_profit_2', pnlR: 2 },
      { takeProfit: 'tp3', high: 100.0035, reason: 'take_profit_3', pnlR: 3 },
    ] as const;
    for (const { takeProfit, high, reason, pnlR } of cases) {
      const setup = longSetup([100, high, 99.9995, 100.001]);
      const result = run({
        config: longPins(),
        setup,
        ...range,
        direction: 'long',
        exitPolicy: { takeProfit },
      });
      assert.equal(result.trades.length, 1);
      const trade = first(result.trades);
      assert.equal(trade.exitReason, reason);
      assert.equal(trade.pnlR, pnlR);
      assertValidResult(result);
    }
  });

  test('default policy is tp3 with zero costs', () => {
    const setup = longSetup([100, 100.0035, 99.9995, 100.001]);
    const result = run({ config: longPins(), setup, ...range, direction: 'long' });
    assert.equal(first(result.trades).exitReason, 'take_profit_3');
    assert.equal(first(result.trades).pnlR, 3);
  });

  test('max_hold exits at the Nth subsequent close when no level is touched', () => {
    const setup = longSetup([100, 100.0004, 99.9995, 100.0002]);
    const result = run({
      config: longPins(),
      setup,
      ...range,
      direction: 'long',
      exitPolicy: { maxHoldCandles: 1 },
    });
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'max_hold');
    assert.equal(trade.exitPrice, 100.0002);
    assert.equal(trade.exitAsOfMs, closeOf(2));
    assert.equal(trade.pnlR, 0.2);
  });

  test('range_end exits at the last in-range close when nothing resolves first', () => {
    const setup = hourly([NORMAL, BULL_PIN, [100, 100.0004, 99.9995, 100.0003], NORMAL]);
    const result = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(2) + 1,
      direction: 'long',
      exitPolicy: { maxHoldCandles: 100 },
    });
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'range_end');
    assert.equal(trade.exitPrice, 100.0003);
    assert.equal(trade.exitAsOfMs, closeOf(2));
    assert.equal(trade.pnlR, 0.3);
  });

  test('signal on the last in-range candle exits range_end at entry (breakeven, costs still apply)', () => {
    const setup = hourly([NORMAL, BULL_PIN]);
    const result = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(1) + 1,
      direction: 'long',
    });
    assert.equal(result.trades.length, 1);
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'range_end');
    assert.equal(trade.exitPrice, 100);
    assert.equal(trade.exitAsOfMs, closeOf(1));
    assert.equal(trade.pnlR, 0);
    assert.equal(result.metrics.tradesClosed, 1);
    assert.equal(result.metrics.wins, 0);
    assert.equal(result.metrics.losses, 0);
  });

  test('same candle touching SL and TP resolves to stop_loss (stop_first, pinned)', () => {
    const setup = longSetup([100, 100.01, 99.99, 100.005]);
    const result = run({
      config: longPins(),
      setup,
      ...range,
      direction: 'long',
      exitPolicy: { takeProfit: 'tp1' },
    });
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'stop_loss');
    assert.equal(trade.exitPrice, trade.stopLossPrice);
    assert.equal(trade.pnlR, -1);
  });

  test('intra-candle touches precede the max-hold close on the same candle', () => {
    const slFirst = run({
      config: longPins(),
      setup: longSetup([100, 100.0005, 99.998, 99.9992]),
      ...range,
      direction: 'long',
      exitPolicy: { maxHoldCandles: 1 },
    });
    assert.equal(first(slFirst.trades).exitReason, 'stop_loss');

    const tpFirst = run({
      config: longPins(),
      setup: longSetup([100, 100.0015, 99.9995, 100.001]),
      ...range,
      direction: 'long',
      exitPolicy: { takeProfit: 'tp1', maxHoldCandles: 1 },
    });
    assert.equal(first(tpFirst.trades).exitReason, 'take_profit_1');
  });

  test('exact touches count; just-inside extremes do not', () => {
    // Probe the engine's own level values so equality is exact by construction.
    const probe = run({ config: longPins(), setup: longSetup(NORMAL), ...range, direction: 'long' });
    const levels = first(probe.trades);
    assert.ok(levels.stopLossPrice !== null && levels.tp1Price !== null);
    const { stopLossPrice: stop, tp1Price: tp1 } = levels;

    const exactSl = run({
      config: longPins(),
      setup: longSetup([100, 100.0005, stop, 99.9992]),
      ...range,
      direction: 'long',
    });
    assert.equal(first(exactSl.trades).exitReason, 'stop_loss');

    const exactTp = run({
      config: longPins(),
      setup: longSetup([100, tp1, stop + 1e-9, 100.0005]),
      ...range,
      direction: 'long',
      exitPolicy: { takeProfit: 'tp1' },
    });
    assert.equal(first(exactTp.trades).exitReason, 'take_profit_1');

    // 1e-9 inside both levels (representable: spacing near 100 is ~1.4e-14).
    const inside = run({
      config: longPins(),
      setup: longSetup([100, tp1 - 1e-9, stop + 1e-9, 100.0001]),
      ...range,
      direction: 'long',
      exitPolicy: { takeProfit: 'tp1', maxHoldCandles: 1 },
    });
    assert.equal(first(inside.trades).exitReason, 'max_hold');
  });

  test("stopLoss 'none' ignores the stop but still normalizes R from it", () => {
    const setup = hourly([
      NORMAL,
      BULL_PIN,
      [100, 100.0005, 99.998, 99.9992], // would stop out — ignored
      [100, 100.0015, 99.9995, 100.001], // tp1
    ]);
    const result = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(3) + 1,
      direction: 'long',
      exitPolicy: { stopLoss: 'none', takeProfit: 'tp1' },
    });
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'take_profit_1');
    assert.equal(trade.pnlR, 1);
  });

  test("takeProfit 'none' ignores targets (stop still exits)", () => {
    const setup = hourly([
      NORMAL,
      BULL_PIN,
      [100, 100.005, 99.9995, 100.001], // would take profit — ignored
      [100, 100.0005, 99.998, 99.9992], // stop
    ]);
    const result = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(3) + 1,
      direction: 'long',
      exitPolicy: { takeProfit: 'none' },
    });
    const trade = first(result.trades);
    assert.equal(trade.exitReason, 'stop_loss');
    assert.equal(trade.exitAsOfMs, closeOf(3));
  });

  test('a null target leg can never be touched (fixed stop + structural targets)', () => {
    const config = mkConfig(
      [group('Pins', 'AND', [cond('rejection_candle', 'required', 'setup', { direction: 'bullish', minWickBodyRatio: 2 })])],
      { takeProfitMethod: 'structure' },
    );
    const setup = hourly([NORMAL, BULL_PIN, NORMAL, NORMAL]);
    const result = run({
      config,
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(3) + 1,
      direction: 'long',
      exitPolicy: { takeProfit: 'tp1', maxHoldCandles: 1 },
    });
    const trade = first(result.trades);
    assert.equal(trade.tp1Price, null);
    assert.equal(trade.exitReason, 'max_hold');
  });
});

// ---------------------------------------------------------------------------
// Short exits (mirrored levels)
// ---------------------------------------------------------------------------

describe('m6 short exits (mirrored levels)', () => {
  /** Bear pin at idx 1 (entry 100, stop 100.001, tp1 99.999), crafted exit at idx 2. */
  function shortSetup(exit: [number, number, number, number]): CandleDto[] {
    return hourly([NORMAL, BEAR_PIN, exit, NORMAL]);
  }
  const range = { fromMs: closeOf(0), toMs: closeOf(3) };

  test('short stop/target touches resolve with mirrored arithmetic', () => {
    const sl = run({
      config: shortPins(),
      setup: shortSetup([100, 100.0015, 99.9995, 100.0008]),
      ...range,
      direction: 'short',
    });
    const slTrade = first(sl.trades);
    assert.equal(slTrade.direction, 'short');
    assert.equal(slTrade.exitReason, 'stop_loss');
    assert.ok(slTrade.stopLossPrice !== null && Math.abs(slTrade.stopLossPrice - 100.001) < 1e-9);
    assert.equal(slTrade.exitPrice, slTrade.stopLossPrice);
    assert.equal(slTrade.pnlR, -1);
    assertValidResult(sl);

    const tp = run({
      config: shortPins(),
      setup: shortSetup([100, 100.0005, 99.9985, 99.9992]),
      ...range,
      direction: 'short',
      exitPolicy: { takeProfit: 'tp1' },
    });
    const tpTrade = first(tp.trades);
    assert.equal(tpTrade.exitReason, 'take_profit_1');
    assert.equal(tpTrade.pnlR, 1);
    assertValidResult(tp);
  });

  test('short same-candle SL+TP resolves to stop_loss (stop_first)', () => {
    const setup = shortSetup([100, 100.01, 99.99, 99.995]);
    const result = run({ config: shortPins(), setup, ...range, direction: 'short', exitPolicy: { takeProfit: 'tp1' } });
    assert.equal(first(result.trades).exitReason, 'stop_loss');
    assert.equal(first(result.trades).pnlR, -1);
  });

  test('short exact touches count', () => {
    const probe = run({ config: shortPins(), setup: shortSetup(NORMAL), ...range, direction: 'short' });
    const levels = first(probe.trades);
    assert.ok(levels.stopLossPrice !== null && levels.tp1Price !== null);
    const { stopLossPrice: stop, tp1Price: tp1 } = levels;

    const exactSl = run({
      config: shortPins(),
      setup: shortSetup([100, stop, 99.9995, 100.0005]),
      ...range,
      direction: 'short',
    });
    assert.equal(first(exactSl.trades).exitReason, 'stop_loss');

    const exactTp = run({
      config: shortPins(),
      setup: shortSetup([100, stop - 1e-9, tp1, 99.9998]),
      ...range,
      direction: 'short',
      exitPolicy: { takeProfit: 'tp1' },
    });
    assert.equal(first(exactTp.trades).exitReason, 'take_profit_1');
  });

  test("direction 'short' replays shorts only; 'long' replays longs only", () => {
    const setup = hourly([NORMAL, BULL_PIN, NORMAL, NORMAL]);
    const longs = run({ config: longPins(), setup, ...range, direction: 'long' });
    assert.ok(longs.trades.length > 0 && longs.trades.every((t) => t.direction === 'long'));
    const shorts = run({ config: longPins(), setup, ...range, direction: 'short' });
    assert.equal(shorts.trades.length, 0); // bullish pins never qualify shorts
  });
});

// ---------------------------------------------------------------------------
// Missing levels, costs, metrics
// ---------------------------------------------------------------------------

describe('m6 missing levels, costs and metrics', () => {
  test('setups without deterministic levels record no_levels (never skipped)', () => {
    // ATR stops need 15+ candles; 6 flat candles ⇒ null candidate at every anchor.
    const config = mkConfig(
      [
        group('Pass', 'AND', [
          cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 }),
        ]),
      ],
      { stopLossMethod: 'atr' },
    );
    const setup = flat(6);
    const result = run({ config, setup, fromMs: closeOf(0), toMs: closeOf(5) + 1, direction: 'both' });
    assert.equal(result.trades.length, 10); // 5 anchors × both directions
    for (const trade of result.trades) {
      assert.equal(trade.exitReason, 'no_levels');
      assert.equal(trade.entryPrice, null);
      assert.equal(trade.exitPrice, null);
      assert.equal(trade.exitAsOfMs, null);
      assert.equal(trade.pnlR, null);
      // Scoring still ran (null candidate ⇒ partial completeness ⇒ 68/C).
      assert.equal(trade.qualityScore, 68);
      assert.equal(trade.qualityGrade, 'C');
    }
    assert.equal(result.metrics.setupsDetected, 10);
    assert.equal(result.metrics.tradesClosed, 0);
    assert.equal(result.metrics.totalR, 0);
    assert.ok(result.notes.some((n) => n.includes('no_levels')));
    assertValidResult(result);
  });

  test('fees, slippage and spread shift R adversely and exactly', () => {
    const setup = hourly([NORMAL, BULL_PIN, [100, 100.0005, 99.998, 99.9992], NORMAL]);
    const costPolicy = { feePerSide: 0.0002, slippagePerSide: 0.0001, spread: 0.0002 };
    const result = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(3),
      direction: 'long',
      costPolicy,
    });
    // signed −0.001, costs 2×0.0003+0.0002=0.0008 ⇒ (−0.001−0.0008)/0.001 = −1.8
    assert.equal(first(result.trades).pnlR, -1.8);

    const tpSetup = hourly([NORMAL, BULL_PIN, [100, 100.0015, 99.9995, 100.001], NORMAL]);
    const tp = run({
      config: longPins(),
      setup: tpSetup,
      fromMs: closeOf(0),
      toMs: closeOf(3),
      direction: 'long',
      exitPolicy: { takeProfit: 'tp1' },
      costPolicy,
    });
    assert.equal(first(tp.trades).pnlR, 0.2);
  });

  test('riskPerTrade derives currency P&L without changing R', () => {
    const setup = hourly([NORMAL, BULL_PIN, [100, 100.0005, 99.998, 99.9992], NORMAL]);
    const without = run({ config: longPins(), setup, fromMs: closeOf(0), toMs: closeOf(3), direction: 'long' });
    const withRisk = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(3),
      direction: 'long',
      costPolicy: { riskPerTrade: 250 },
    });
    assert.equal(first(without.trades).pnlCurrency, null);
    assert.equal(without.metrics.totalCurrency, null);
    assert.equal(first(withRisk.trades).pnlR, first(without.trades).pnlR);
    assert.equal(first(withRisk.trades).pnlCurrency, -250);
    assert.equal(withRisk.metrics.totalCurrency, -250);
  });

  test('metrics arithmetic is exact on a hand-computed [+2R, −1R, +2R] run', () => {
    const tp2Exit: [number, number, number, number] = [100, 100.0025, 99.9995, 100.0015];
    const slExit: [number, number, number, number] = [100, 100.0005, 99.9985, 99.9992];
    const setup = hourly([NORMAL, BULL_PIN, tp2Exit, BULL_PIN, slExit, BULL_PIN, tp2Exit, NORMAL]);
    const result = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(6) + 1,
      direction: 'long',
      exitPolicy: { takeProfit: 'tp2' },
    });
    assert.deepEqual(
      result.trades.map((t) => t.exitReason),
      ['take_profit_2', 'stop_loss', 'take_profit_2'],
    );
    assert.deepEqual(
      result.trades.map((t) => t.pnlR),
      [2, -1, 2],
    );
    // M5 reuse proof: single satisfied required + complete candidate ⇒ 75/B.
    for (const trade of result.trades) {
      assert.equal(trade.qualityScore, 75);
      assert.equal(trade.qualityGrade, 'B');
    }
    assert.deepEqual(result.metrics, {
      stepsEvaluated: 7,
      setupsDetected: 3,
      tradesClosed: 3,
      wins: 2,
      losses: 1,
      winRate: 0.6667,
      expectancyR: 1,
      profitFactor: 4,
      maxDrawdownR: 1, // equity 2 → 1 → 3: peak 2, trough 1
      avgWinR: 2,
      avgLossR: -1,
      totalR: 3,
      totalCurrency: null,
    });
    assertValidResult(result);
  });

  test('profit factor is null (with a note) when there are no losing trades', () => {
    const setup = hourly([NORMAL, BULL_PIN, [100, 100.0015, 99.9995, 100.001], NORMAL]);
    const result = run({
      config: longPins(),
      setup,
      fromMs: closeOf(0),
      toMs: closeOf(3),
      direction: 'long',
      exitPolicy: { takeProfit: 'tp1' },
    });
    assert.equal(result.metrics.profitFactor, null);
    assert.ok(result.notes.some((n) => n.includes('Profit factor is undefined')));
  });
});

// ---------------------------------------------------------------------------
// Overlaps, gaps, multi-role visibility
// ---------------------------------------------------------------------------

describe('m6 overlaps, gaps and multi-role visibility', () => {
  test('overlapping trades are tracked independently (no netting in M6 core)', () => {
    const setup = flat(4);
    const result = run({ config: alwaysPass(), setup, fromMs: closeOf(0), toMs: closeOf(3) + 1, direction: 'both' });
    // Anchors B, C, D × both directions (anchor A has <2 candles ⇒ insufficient_data).
    assert.equal(result.trades.length, 6);
    assert.deepEqual(
      result.trades.map((t) => t.signalAsOfMs),
      [closeOf(1), closeOf(1), closeOf(2), closeOf(2), closeOf(3), closeOf(3)],
    );
    assert.deepEqual(
      result.trades.map((t) => t.direction),
      ['long', 'short', 'long', 'short', 'long', 'short'],
    );
    // The anchor-B trades are still open when anchor C signals — and each
    // resolves on its own scan (flat ⇒ range_end).
    for (const trade of result.trades) {
      assert.equal(trade.exitReason, 'range_end');
      assert.equal(trade.pnlR, 0);
    }
    const last = result.trades.slice(-2);
    assert.equal(first(last).exitPrice, 100);
    assert.equal(first(last).exitAsOfMs, closeOf(3)); // signal on last candle ⇒ exit at entry
    assert.equal(result.metrics.setupsDetected, 6);
    assert.equal(result.metrics.tradesClosed, 6);
    assert.equal(result.metrics.wins, 0);
    assert.equal(result.metrics.losses, 0); // breakeven counts in neither
    assertValidResult(result);
  });

  test('gaps are noted and exits use the next available candle (no interpolation)', () => {
    // Five hourly candles, then a 6h jump (median spacing stays 1h ⇒ gap noted).
    const gap: CandleDto[] = [
      candle(T0, 100, 100.0005, 99.9998, 100.0002),
      candle(T0 + HOUR, 100, 100.0005, 99.998, 100), // pin ⇒ signal at close
      candle(T0 + 2 * HOUR, 100, 100.0005, 99.9998, 100.0002),
      candle(T0 + 3 * HOUR, 100, 100.0005, 99.9998, 100.0002),
      candle(T0 + 4 * HOUR, 100, 100.0005, 99.9998, 100.0002),
      candle(T0 + 10 * HOUR, 100, 100.0005, 99.998, 99.9992), // gap, then SL touch
    ];
    const result = run({
      config: longPins(),
      setup: gap,
      fromMs: closeOf(0),
      toMs: T0 + 11 * HOUR + 1,
      direction: 'long',
    });
    assert.equal(result.trades.length, 1);
    assert.equal(first(result.trades).exitReason, 'stop_loss');
    assert.equal(first(result.trades).exitAsOfMs, T0 + 11 * HOUR);
    assert.ok(result.notes.some((n) => n.includes('gaps wider than 2×')));
  });

  test('HTF candles unclosed at an anchor are excluded from every evaluation', () => {
    const config = mkConfig(
      [
        group('Trend', 'AND', [
          cond('volatility_filter', 'required', 'setup', { metric: 'body_range', period: 2, min: 0 }),
          cond('htf_alignment', 'required', 'htf_bias', { direction: 'either', source: 'trend' }),
        ]),
      ],
      {},
      { htf_bias: '1d', setup: '1h', entry: '1h' },
    );
    const setup = flat(48); // 2 days of hourly closes
    const fromMs = closeOf(0);
    const toMs = closeOf(47) + 1;
    // 19 closed daily bars + one extreme bar that never closes in range.
    const rising = (n: number, last: CandleDto): CandleDto[] =>
      Array.from({ length: n }, (_, i) =>
        candle(T0 + i * DAY, 90 + i, 91 + i, 89 + i, 90 + i),
      ).concat([last]);
    const unclosed = candle(toMs - HOUR, 1, 1.01, 0.99, 1); // closes after toMs
    const withUnclosed = run({ config, setup, htf: rising(19, unclosed), fromMs, toMs, direction: 'both' });
    const withoutUnclosed = run({
      config,
      setup,
      htf: rising(19, unclosed).slice(0, 19),
      fromMs,
      toMs,
      direction: 'both',
    });
    assert.deepEqual(withUnclosed, withoutUnclosed);
    // …and with <20 closed HTF bars the trend gate fails closed everywhere.
    assert.equal(withUnclosed.trades.length, 0);

    // Sanity: HTF data IS consumed — 20 closed rising bars align longs.
    const aligned = run({
      config,
      setup,
      htf: Array.from({ length: 20 }, (_, i) => candle(T0 - 20 * DAY + i * DAY, 90 + i, 91 + i, 89 + i, 90 + i)),
      fromMs,
      toMs,
      direction: 'both',
    });
    assert.ok(aligned.trades.length > 0);
    assert.ok(aligned.trades.every((t) => t.direction === 'long')); // trend up ⇒ shorts blocked
  });
});

// ---------------------------------------------------------------------------
// Look-ahead protection (structural)
// ---------------------------------------------------------------------------

describe('m6 look-ahead protection', () => {
  const tp2Exit: [number, number, number, number] = [100, 100.0025, 99.9995, 100.0015];
  const slExit: [number, number, number, number] = [100, 100.0005, 99.9985, 99.9992];
  const shapes: Array<[number, number, number, number]> = [NORMAL, BULL_PIN, tp2Exit, BULL_PIN, slExit, NORMAL];
  const baseOpts = () => ({
    config: longPins(),
    setup: hourly(shapes),
    fromMs: closeOf(0),
    toMs: closeOf(5),
    direction: 'long' as const,
    exitPolicy: { takeProfit: 'tp2' as const },
  });

  test('candles beyond toMs are invisible: mutation and deletion change nothing', () => {
    const extra = (mutate: (c: CandleDto) => CandleDto): CandleDto[] =>
      hourly(shapes).concat([
        mutate(candle(T0 + 6 * HOUR, 100, 100.0005, 99.9998, 100.0002)),
        mutate(candle(T0 + 7 * HOUR, 100, 100.0005, 99.9998, 100.0002)),
      ]);
    const base = run(baseOpts());
    const identity = (c: CandleDto): CandleDto => c;
    assert.deepEqual(run({ ...baseOpts(), setup: extra(identity) }), base);
    const corrupted = (c: CandleDto): CandleDto => ({ ...c, open: 1, high: 500, low: 0.5, close: 499 });
    assert.deepEqual(run({ ...baseOpts(), setup: extra(corrupted) }), base);
  });

  test('in-range future mutations never alter earlier signals (entry/stop/score fixed at the anchor)', () => {
    const base = run(baseOpts());
    assert.ok(base.trades.length >= 2);
    // Signals at/before close(3) cannot see candle 4 in any prefix.
    const earlySignals = (r: BacktestEngineResult) => signalsOf(r).filter(([asOf]) => asOf <= closeOf(3));
    const baseSignals = earlySignals(base);
    assert.ok(baseSignals.length >= 2);

    // Corrupt a mid-range candle (valid OHLC, wildly different values, not a pin).
    const mutated = hourly(shapes).map((c, i) => (i === 4 ? candle(c.time, 95, 96, 94.6, 95.5) : c));
    assert.deepEqual(earlySignals(run({ ...baseOpts(), setup: mutated })), baseSignals);

    // Delete a mid-range candle: anchors shift but surviving signals are identical.
    const deleted = hourly(shapes).filter((_, i) => i !== 4);
    assert.deepEqual(earlySignals(run({ ...baseOpts(), setup: deleted })), baseSignals);
  });

  test('shuffled input replays identically (defensive sort)', () => {
    const base = run(baseOpts());
    const reversed = hourly(shapes).slice().reverse();
    assert.deepEqual(run({ ...baseOpts(), setup: reversed }), base);
    const rotated = hourly(shapes).slice(2).concat(hourly(shapes).slice(0, 2));
    assert.deepEqual(run({ ...baseOpts(), setup: rotated }), base);
  });

  test('duplicate timestamps deduplicate deterministically (last wins, like store upserts)', () => {
    const base = run(baseOpts());
    const series = hourly(shapes);
    assert.deepEqual(run({ ...baseOpts(), setup: series.concat(series) }), base);

    // Conflicting duplicates: the last occurrence wins, exactly as upserts.
    const modified = series.map((c, i) => (i === 2 ? { ...c, high: 100.009, close: 100.008 } : c));
    const withDupes = series.concat(modified.filter((_, i) => i === 2));
    assert.deepEqual(run({ ...baseOpts(), setup: withDupes }), run({ ...baseOpts(), setup: modified }));
  });
});
