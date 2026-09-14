import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluationResultSchema,
  riskConfigurationSchema,
  strategyVersionConfigSchema,
  type CandleDto,
  type StrategyVersionConfig,
  type StrategyRuleGroup,
} from '@veltrixeye/contracts';
import {
  atrWilder,
  bufferToPrice,
  candleAnatomy,
  countTouches,
  createEvaluationEngine,
  deriveCandidate,
  findFvg,
  findOrderBlock,
  findPivots,
  hourInSession,
  isEngulfing,
  isDisplacement,
  lastPivotHighAbove,
  lastPivotLowBelow,
  pipSizeFor,
  requiredWindows,
  sma,
  structuralTarget,
  structureBias,
  timeInSession,
  CONDITION_HANDLERS,
  LEVEL_TOLERANCE_PCT,
  type HandlerContext,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Deterministic builders
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
/** Fixed anchor. Every candle below is built around it — no wall clock anywhere. */
const AS_OF = 1_800_000_000_000;

function candle(time: number, open: number, high: number, low: number, close: number): CandleDto {
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close), 'test candle violates OHLC invariant');
  return { time, open, high, low, close, volume: null };
}

/** Shapes (oldest first): [open, high, low, close]; the LAST shape closes exactly at AS_OF. */
function series(shapes: Array<[number, number, number, number]>, periodMs = HOUR): CandleDto[] {
  const n = shapes.length;
  return shapes.map(([o, h, l, c], idx) => candle(AS_OF - (n - idx) * periodMs, o, h, l, c));
}

/**
 * Zigzag builder from [high, low] pairs (oldest first). open = close = midpoint,
 * so every candle is OHLC-valid by construction; swing geometry is carried by
 * the highs/lows only. Pivot detection needs strictly higher/lower extremes,
 * which these pairs provide.
 */
function zz(pairs: Array<[number, number]>, periodMs = HOUR): CandleDto[] {
  return series(pairs.map(([h, l]) => [(h + l) / 2, h, l, (h + l) / 2] as [number, number, number, number]), periodMs);
}

/** Replace the last candle's OHLC (keeps its time). */
function withLast(candles: CandleDto[], open: number, high: number, low: number, close: number): CandleDto[] {
  const last = candles[candles.length - 1];
  assert.ok(last);
  const copy = candles.slice();
  copy[copy.length - 1] = candle(last.time, open, high, low, close);
  return copy;
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

function mkConfig(overrides: Partial<StrategyVersionConfig> & { ruleGroups: StrategyRuleGroup[] }): StrategyVersionConfig {
  return strategyVersionConfigSchema.parse({
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'all' },
    risk: {},
    ...overrides,
  });
}

function handlerCtx(candles: CandleDto[], extra: Partial<HandlerContext> = {}): HandlerContext {
  return {
    candles: { htf_bias: candles, setup: candles, entry: candles },
    timeframeRole: 'setup',
    params: {},
    direction: 'long',
    risk: riskConfigurationSchema.parse({}),
    asOfMs: AS_OF,
    candidate: null,
    ...extra,
  };
}

/** Series with constant true range 2 (flat close-to-close moves): ATR(14) === 2. */
function constantTrSeries(count: number, body = 0.5): CandleDto[] {
  const shapes: Array<[number, number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const mid = 100;
    shapes.push([mid - body / 2, mid + 1, mid - 1, mid + body / 2]); // TR = 2 every candle
  }
  return series(shapes);
}

// Reusable engine fixtures: 16 flat candles + a bullish (resp. bearish)
// engulfing pair on the last two closed candles. 18 candles give ATR(14)
// enough history for volatility_filter to evaluate.
const longTrueShapes: Array<[number, number, number, number]> = [
  ...Array.from({ length: 16 }, () => [100, 100.5, 99.5, 100] as [number, number, number, number]),
  [101, 101.2, 100, 100.2], // bearish
  [100, 101.5, 99.9, 101.3], // bullish engulfing
];

const longTrue = cond('engulfing_candle', 'required', 'setup', { direction: 'bullish' });
const shortTrue = cond('engulfing_candle', 'required', 'setup', { direction: 'bearish' });
/** Direction-neutral and satisfiable on any series with 15+ closed candles. */
const volNeutral = cond('volatility_filter', 'required', 'any', { metric: 'atr', period: 14, min: 0 });
const newsCond = cond('news_filter', 'required', 'any');

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

describe('m3 indicators', () => {
  test('atrWilder: constant true-range series yields exactly the TR', () => {
    const atr = atrWilder(constantTrSeries(30), 14);
    assert.equal(atr, 2);
  });

  test('atrWilder: Wilder smoothing matches a hand-computed case (TRs 1,1,3,3)', () => {
    const shapes: Array<[number, number, number, number]> = [
      [100, 100.5, 99.5, 100],
      [100, 101, 100, 100.5], // TR 1
      [100.5, 101, 100, 100.5], // TR 1
      [100.5, 103.5, 100.5, 103], // TR 3
      [103, 106, 103, 105.5], // TR 3
    ];
    const atr = atrWilder(series(shapes), 3);
    assert.ok(atr !== null);
    // seed = mean(1,1,3) = 5/3; then (5/3·2 + 3)/3 = 19/9
    assert.ok(Math.abs(atr - 19 / 9) < 1e-12, `expected 19/9, got ${atr}`);
  });

  test('atrWilder: insufficient history and degenerate periods return null', () => {
    assert.equal(atrWilder(constantTrSeries(14), 14), null); // needs 15
    assert.equal(atrWilder(constantTrSeries(15), 1), null); // period < 2
    assert.equal(atrWilder(constantTrSeries(0), 14), null);
  });

  test('findPivots: detects confirmed fractal swings, ignores ties and the unconfirmed tail', () => {
    const shapes: Array<[number, number, number, number]> = [
      [100, 100, 99, 100],
      [100, 100, 99, 100],
      [100, 102, 99, 100], // pivot high (2 lower highs each side)
      [100, 100, 99, 100],
      [100, 100, 97, 100], // pivot low (strictly lower than neighbors)
      [100, 100, 99, 100],
      [100, 100, 99, 100],
      [100, 100, 99, 100],
    ];
    const { highs, lows } = findPivots(series(shapes));
    assert.equal(highs.length, 1);
    assert.equal(highs[0]!.price, 102);
    assert.equal(lows.length, 1);
    assert.equal(lows[0]!.price, 97);
  });

  test('findPivots: flat series has no pivots; last k candles are never pivots', () => {
    const flat = series(Array.from({ length: 12 }, () => [100, 100.5, 99.5, 100] as [number, number, number, number]));
    const { highs, lows } = findPivots(flat);
    assert.equal(highs.length, 0);
    assert.equal(lows.length, 0);
    const spiky = series([
      [100, 100, 99, 100],
      [100, 100, 99, 100],
      [100, 100, 99, 100],
      [100, 100, 99, 100],
      [100, 105, 99, 100], // index 4 of 5 — inside the unconfirmed tail for k=2
    ]);
    assert.equal(findPivots(spiky).highs.length, 0);
  });

  test('candleAnatomy: decomposes body and wicks deterministically', () => {
    const a = candleAnatomy(candle(0, 100, 103, 98, 102));
    assert.equal(a.body, 2);
    assert.equal(a.upperWick, 1);
    assert.equal(a.lowerWick, 2);
    assert.equal(a.bullish, true);
    assert.equal(a.bearish, false);
    const b = candleAnatomy(candle(0, 102, 103, 98, 100));
    assert.equal(b.bullish, false);
    assert.equal(b.bearish, true);
  });

  test('isEngulfing: requires body containment, polarity and the optional ratio', () => {
    const prev = candle(0, 101, 101.2, 100, 100.2); // bearish body 0.8
    const good = candle(HOUR, 100, 101.5, 99.9, 101.3); // bullish body 1.3, covers prev body
    assert.equal(isEngulfing(prev, good, 'bullish'), true);
    assert.equal(isEngulfing(prev, good, 'bullish', 2), false); // 1.3 < 2 × 0.8
    assert.equal(isEngulfing(prev, good, 'bearish'), false);
    const small = candle(HOUR, 100.1, 101.5, 99.9, 100.5); // body 0.4 < prev 0.8
    assert.equal(isEngulfing(prev, small, 'bullish', 1), false);
  });

  test('isDisplacement: body vs ATR multiple with polarity', () => {
    const big = candle(0, 100, 104.2, 99.9, 104);
    assert.equal(isDisplacement(big, 2, 1.5, 'bullish'), true); // body 4 ≥ 3
    assert.equal(isDisplacement(big, 2, 1.5, 'bearish'), false);
    assert.equal(isDisplacement(big, 2, 1.5, 'either'), true);
    assert.equal(isDisplacement(big, 3, 1.5, 'bullish'), false); // 4 < 4.5
    assert.equal(isDisplacement(big, 0, 1.5, 'bullish'), false); // degenerate ATR
  });

  test('countTouches: counts extremes within percentage tolerance', () => {
    const candles = series([
      [100, 100.5, 99.0, 100],
      [100, 100.5, 100, 100],
      [100, 100.5, 99.05, 100],
      [100.6, 100.7, 100.5, 100.6],
      [100, 100.5, 99.2, 100], // outside the 0.1% band (tol 0.099)
    ]);
    assert.equal(countTouches(candles, 99.0, 'low'), 2);
    assert.equal(countTouches(candles, 99.0, 'low', 0.25), 3);
    assert.equal(countTouches(candles, 99.0, 'low', LEVEL_TOLERANCE_PCT), 2);
  });

  test('findFvg: detects the most recent 3-candle gap and honors minGapSizePct', () => {
    const candles = series([
      [100, 100.5, 99.5, 100],
      [100, 101, 100, 100.5],
      [101.2, 102, 100.8, 101.5], // gap [100.5, 100.8]
      [101, 101.2, 100.6, 101], // revisits the gap
    ]);
    const zone = findFvg(candles, 'bullish');
    assert.ok(zone);
    assert.equal(zone.bottom, 100.5);
    assert.equal(zone.top, 100.8);
    assert.equal(findFvg(candles, 'bearish'), null);
    assert.equal(findFvg(candles, 'bullish', 0.5), null); // gap ≈ 0.297% < 0.5%
    assert.ok(findFvg(candles, 'bullish', 0.2));
  });

  test('findOrderBlock: last opposing candle before displacement becomes the zone', () => {
    const candles = series([
      [100, 100.5, 99.5, 100],
      [100, 100.2, 98.5, 99], // bearish origin (body 1)
      [99, 103, 98.8, 102.8], // bullish displacement, closes above origin high
      [101, 101.2, 99.5, 101], // mitigation touch
    ]);
    const zone = findOrderBlock(candles, 'bullish', 100);
    assert.ok(zone);
    assert.equal(zone.bottom, 98.5);
    assert.equal(zone.top, 100.2);
    assert.equal(findOrderBlock(candles, 'bearish', 100), null);
  });

  test('structureBias: HH+HL bullish, LH+LL bearish, mixed range', () => {
    const up = zz([
      [100, 99],
      [100, 99],
      [102, 100], // PH1
      [101, 99.5],
      [99, 98], // PL1
      [102, 100],
      [104, 102], // PH2 (HH)
      [103, 101],
      [101, 99], // PL2 (HL)
      [102, 100],
      [103, 101.5],
    ]);
    assert.equal(structureBias(up), 'bullish');
    assert.ok(lastPivotHighAbove(up, 103));
    assert.equal(lastPivotHighAbove(up, 105), null);
    assert.ok(lastPivotLowBelow(up, 98.5));
    assert.equal(lastPivotLowBelow(up, 97), null);
    assert.ok(structuralTarget(up, 'long', 100) !== null);

    const down = zz([
      [100, 99],
      [100, 99],
      [102, 100], // PH1
      [100, 98],
      [97, 95], // PL1
      [99, 97],
      [100, 98], // PH2 (LH)
      [98, 96],
      [96, 94], // PL2 (LL)
      [98, 97],
      [99, 97],
    ]);
    assert.equal(structureBias(down), 'bearish');
    const chop = zz(Array.from({ length: 10 }, () => [100.4, 99.6] as [number, number]));
    assert.equal(structureBias(chop), 'range');
  });

  test('sma: mean of the last period values; null when short', () => {
    assert.equal(sma([1, 2, 3, 4], 2), 3.5);
    assert.equal(sma([1, 2], 3), null);
    assert.equal(sma([], 1), null);
  });

  test('UTC sessions: pinned windows including the sydney wrap', () => {
    assert.equal(hourInSession(3, 'asia'), true);
    assert.equal(hourInSession(9, 'asia'), false);
    assert.equal(hourInSession(7, 'london'), true);
    assert.equal(hourInSession(16, 'london'), false);
    assert.equal(hourInSession(12, 'new_york'), true);
    assert.equal(hourInSession(21, 'new_york'), false);
    assert.equal(hourInSession(22, 'sydney'), true);
    assert.equal(hourInSession(5, 'sydney'), true);
    assert.equal(hourInSession(6, 'sydney'), false);
    const at13 = Date.UTC(2026, 0, 15, 13, 0, 0, 0);
    assert.equal(timeInSession(at13, 'london'), true);
    assert.equal(timeInSession(at13, 'new_york'), true);
    assert.equal(timeInSession(at13, 'asia'), false);
  });

  test('pip and buffer math: JPY quotes use 0.01 pips; pct scales off entry', () => {
    assert.equal(pipSizeFor('EURUSD'), 0.0001);
    assert.equal(pipSizeFor('USDJPY'), 0.01);
    assert.equal(bufferToPrice(2, 'pips', 100, 'EURUSD'), 0.0002);
    assert.equal(bufferToPrice(2, 'pips', 100, 'USDJPY'), 0.02);
    assert.equal(bufferToPrice(1, 'pct', 200, 'EURUSD'), 2);
  });

  test('time gaps between candles do not affect index-based primitives', () => {
    const withGap = [
      candle(AS_OF - 10 * HOUR, 100, 102, 99, 100),
      candle(AS_OF - 7 * HOUR, 100, 100, 98, 100), // 3h gap
      candle(AS_OF - 6 * HOUR, 100, 100, 97, 100), // pivot low
      candle(AS_OF - 5 * HOUR, 100, 100, 99, 100),
      candle(AS_OF - 4 * HOUR, 100, 100, 99, 100),
    ];
    assert.equal(findPivots(withGap).lows.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Condition handlers
// ---------------------------------------------------------------------------

describe('m3 condition handlers', () => {
  test('news_filter and spread_filter fail closed (insufficient_data) for every direction', () => {
    for (const direction of ['long', 'short'] as const) {
      const news = CONDITION_HANDLERS.news_filter!(handlerCtx(constantTrSeries(20), { direction }));
      assert.equal(news.status, 'insufficient_data');
      const spread = CONDITION_HANDLERS.spread_filter!(handlerCtx(constantTrSeries(20), { direction }));
      assert.equal(spread.status, 'insufficient_data');
    }
  });

  test('session_requirement: utc include/exclude around the anchor candle; exchange unsupported', () => {
    const at13 = Date.UTC(2026, 0, 15, 13, 0, 0, 0);
    const asOf = at13 + HOUR; // anchor candle opens 13:00 UTC, closes 14:00
    const candles = [candle(asOf - HOUR, 100, 100.5, 99.5, 100)];
    const base = { candles: { htf_bias: candles, setup: candles, entry: candles }, asOfMs: asOf };
    const inside = CONDITION_HANDLERS.session_requirement!(
      handlerCtx(candles, { ...base, params: { sessions: ['london'], mode: 'include', timezone: 'utc' } }),
    );
    assert.equal(inside.status, 'satisfied');
    const outside = CONDITION_HANDLERS.session_requirement!(
      handlerCtx(candles, { ...base, params: { sessions: ['asia'], mode: 'include', timezone: 'utc' } }),
    );
    assert.equal(outside.status, 'unsatisfied');
    const excluded = CONDITION_HANDLERS.session_requirement!(
      handlerCtx(candles, { ...base, params: { sessions: ['asia'], mode: 'exclude', timezone: 'utc' } }),
    );
    assert.equal(excluded.status, 'satisfied');
    const exchange = CONDITION_HANDLERS.session_requirement!(
      handlerCtx(candles, { ...base, params: { sessions: ['london'], mode: 'include', timezone: 'exchange' } }),
    );
    assert.equal(exchange.status, 'unsupported');
    const noCandles = CONDITION_HANDLERS.session_requirement!(
      handlerCtx([], { params: { sessions: ['london'], mode: 'include', timezone: 'utc' } }),
    );
    assert.equal(noCandles.status, 'insufficient_data');
  });

  test('volatility_filter: ATR and body_range metrics within a pinned band', () => {
    const candles = constantTrSeries(20);
    const within = CONDITION_HANDLERS.volatility_filter!(
      handlerCtx(candles, { params: { metric: 'atr', period: 14, min: 0, max: 3 } }),
    );
    assert.equal(within.status, 'satisfied');
    const above = CONDITION_HANDLERS.volatility_filter!(
      handlerCtx(candles, { params: { metric: 'atr', period: 14, min: 2.5, max: 4 } }),
    );
    assert.equal(above.status, 'unsatisfied');
    const bodies = CONDITION_HANDLERS.volatility_filter!(
      handlerCtx(candles, { params: { metric: 'body_range', period: 10, min: 0, max: 1 } }),
    );
    assert.equal(bodies.status, 'satisfied');
    const short = CONDITION_HANDLERS.volatility_filter!(
      handlerCtx(constantTrSeries(5), { params: { metric: 'atr', period: 14, min: 0, max: 3 } }),
    );
    assert.equal(short.status, 'insufficient_data');
  });

  test('liquidity_sweep: sweep of lows is long-context; highs short; wick ratio enforced', () => {
    const candles = series([
      [100, 101, 99.7, 100.5],
      [100, 101, 99.7, 100.5],
      [100, 101, 99.7, 100.5],
      [100, 101, 99.7, 100.5],
      [100, 101, 99.7, 100.5],
      [100.4, 100.6, 99.0, 100.4], // sweeps the 99.7 low, closes back inside, wick ratio 0.875
    ]);
    const long = CONDITION_HANDLERS.liquidity_sweep!(
      handlerCtx(candles, { direction: 'long', params: { side: 'below', lookbackCandles: 100, minWickRatio: 0.3 } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.liquidity_sweep!(
      handlerCtx(candles, { direction: 'short', params: { side: 'below', lookbackCandles: 100, minWickRatio: 0.3 } }),
    );
    assert.equal(short.status, 'unsatisfied');
    const strictWick = CONDITION_HANDLERS.liquidity_sweep!(
      handlerCtx(candles, { direction: 'long', params: { side: 'below', lookbackCandles: 100, minWickRatio: 0.95 } }),
    );
    assert.equal(strictWick.status, 'unsatisfied');
    const noSweep = CONDITION_HANDLERS.liquidity_sweep!(
      handlerCtx(series([
        [100, 101, 99.7, 100.5],
        [100, 101, 99.7, 100.5],
        [100, 101, 99.7, 100.5],
        [100, 101, 99.7, 100.5],
        [100, 101, 99.7, 100.5],
        [100.4, 100.6, 99.8, 100.4],
      ]), { direction: 'long', params: { side: 'below', lookbackCandles: 100, minWickRatio: 0.3 } }),
    );
    assert.equal(noSweep.status, 'unsatisfied');
    const tiny = CONDITION_HANDLERS.liquidity_sweep!(
      handlerCtx(candles.slice(0, 3), { direction: 'long', params: { side: 'below', lookbackCandles: 100, minWickRatio: 0.3 } }),
    );
    assert.equal(tiny.status, 'insufficient_data');
  });

  test('choch: bearish structure broken upward satisfies long; range bias is insufficient', () => {
    const base = zz([
      [100, 99],
      [100, 99],
      [102, 100], // PH1 102
      [100, 98],
      [97, 95], // PL1 95
      [99, 97],
      [100, 98], // PH2 100 (LH)
      [98, 96],
      [96, 94], // PL2 94 (LL)
      [98, 97],
      [99, 97],
    ]);
    const candles = withLast(base, 100, 100.5, 99, 100.5); // closes above PH2 → bullish CHoCH
    const long = CONDITION_HANDLERS.choch!(
      handlerCtx(candles, { direction: 'long', params: { direction: 'either', lookbackCandles: 200 } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.choch!(
      handlerCtx(candles, { direction: 'short', params: { direction: 'either', lookbackCandles: 200 } }),
    );
    assert.equal(short.status, 'unsatisfied');
    const noBreak = CONDITION_HANDLERS.choch!(
      handlerCtx(withLast(base, 99, 99.5, 98, 99), { direction: 'long', params: { direction: 'either', lookbackCandles: 200 } }),
    );
    assert.equal(noBreak.status, 'unsatisfied');
    const needDisplacement = CONDITION_HANDLERS.choch!(
      handlerCtx(candles, { direction: 'long', params: { direction: 'either', lookbackCandles: 200, requireDisplacement: true } }),
    );
    assert.equal(needDisplacement.status, 'insufficient_data'); // ATR(14) needs 15+ candles
    const flat = CONDITION_HANDLERS.choch!(
      handlerCtx(constantTrSeries(20), { direction: 'long', params: { direction: 'either', lookbackCandles: 200 } }),
    );
    assert.equal(flat.status, 'insufficient_data');
  });

  test('bos: continuation break in an established uptrend satisfies long', () => {
    const base = zz([
      [100, 99],
      [100, 99],
      [102, 100], // PH1
      [101, 99.5],
      [99, 98], // PL1
      [102, 100],
      [104, 102], // PH2 (HH)
      [103, 101],
      [101, 99], // PL2 (HL)
      [103, 101.5],
      [103.5, 102],
    ]);
    const candles = withLast(base, 103.6, 104.5, 103, 104.5); // closes above PH2 → bullish BOS
    const long = CONDITION_HANDLERS.bos!(
      handlerCtx(candles, { direction: 'long', params: { direction: 'either', lookbackCandles: 200 } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.bos!(
      handlerCtx(candles, { direction: 'short', params: { direction: 'either', lookbackCandles: 200 } }),
    );
    assert.equal(short.status, 'unsatisfied');
    const noBreak = CONDITION_HANDLERS.bos!(
      handlerCtx(withLast(base, 103, 103.8, 102.5, 103.2), { direction: 'long', params: { direction: 'either', lookbackCandles: 200 } }),
    );
    assert.equal(noBreak.status, 'unsatisfied');
  });

  test('break_retest: broken pivot retested within tolerance satisfies long; missing retest fails', () => {
    const candles = series([
      [99, 99.5, 98, 99],
      [99, 99.5, 98, 99],
      [99.5, 100.5, 99, 100], // pivot high 100.5
      [99.5, 100, 99, 99.5],
      [99.5, 100, 99, 99.5],
      [100, 101, 100, 100.8], // break close > 100.5
      [100.5, 100.9, 100.45, 100.7], // retest wick into level, closes back above
      [100.6, 101, 100.4, 100.9], // anchor holds above
    ]);
    const long = CONDITION_HANDLERS.break_retest!(
      handlerCtx(candles, { direction: 'long', params: { direction: 'either', maxRetestCandles: 24, retestTolerancePct: 0.1 } }),
    );
    assert.equal(long.status, 'satisfied');
    const noRetest = CONDITION_HANDLERS.break_retest!(
      handlerCtx(series([
        [99, 99.5, 98, 99],
        [99, 99.5, 98, 99],
        [99.5, 100.5, 99, 100],
        [99.5, 100, 99, 99.5],
        [99.5, 100, 99, 99.5],
        [100, 101, 100, 100.8],
        [100.7, 101.2, 100.65, 101], // stays above the retest band (100.6005)
        [100.9, 101.4, 100.7, 101.2],
      ]), { direction: 'long', params: { direction: 'either', maxRetestCandles: 24, retestTolerancePct: 0.1 } }),
    );
    assert.equal(noRetest.status, 'unsatisfied');
  });

  test('order_block: mitigated bullish OB with price holding above satisfies long', () => {
    const candles = series([
      [100, 100.5, 99.5, 100],
      [100, 100.2, 98.5, 99], // bearish origin
      [99, 103, 98.8, 102.8], // displacement
      [101, 101.2, 99.5, 101], // mitigation
      [101.5, 102, 101, 101.8], // anchor holds above zone top
    ]);
    const long = CONDITION_HANDLERS.order_block!(
      handlerCtx(candles, { direction: 'long', params: { kind: 'bullish', validation: 'mitigation', maxAgeCandles: 100 } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.order_block!(
      handlerCtx(candles, { direction: 'short', params: { kind: 'bullish', validation: 'mitigation', maxAgeCandles: 100 } }),
    );
    assert.equal(short.status, 'unsatisfied');
    const broken = CONDITION_HANDLERS.order_block!(
      handlerCtx(candles, { direction: 'long', params: { kind: 'bullish', validation: 'break', maxAgeCandles: 100 } }),
    );
    assert.equal(broken.status, 'satisfied');
  });

  test('fvg: mitigated bullish gap satisfies long; minGapSizePct and mitigation enforced', () => {
    const candles = series([
      [100, 100.5, 99.5, 100],
      [100, 101, 100, 100.5],
      [101.2, 102, 100.8, 101.5], // gap [100.5, 100.8]
      [101, 101.2, 100.6, 101], // mitigation
      [101, 101.4, 100.7, 101.2],
    ]);
    const long = CONDITION_HANDLERS.fvg!(
      handlerCtx(candles, { direction: 'long', params: { kind: 'bullish', requireMitigation: true } }),
    );
    assert.equal(long.status, 'satisfied');
    const unmitigated = CONDITION_HANDLERS.fvg!(
      handlerCtx(series([
        [100, 100.5, 99.5, 100],
        [100, 101, 100, 100.5],
        [101.2, 102, 100.8, 101.5],
        [101.4, 102.2, 101, 102],
        [101.8, 102.6, 101.2, 102.4],
      ]), { direction: 'long', params: { kind: 'bullish', requireMitigation: true } }),
    );
    assert.equal(unmitigated.status, 'unsatisfied');
    const smallGap = CONDITION_HANDLERS.fvg!(
      handlerCtx(series([
        [100, 100.5, 99.5, 100],
        [100, 101, 100, 100.5],
        [101.2, 102, 100.8, 101.5],
        [101, 101.2, 100.6, 101],
        [101, 101.4, 100.7, 101.2],
      ]), { direction: 'long', params: { kind: 'bullish', requireMitigation: false, minGapSizePct: 0.5 } }),
    );
    assert.equal(smallGap.status, 'unsatisfied'); // 0.297% gap < 0.5%
  });

  test('support and resistance: touches + holding/rejecting at the level, direction-scoped', () => {
    const lows = series([
      [100, 100.5, 99.0, 100],
      [100.3, 100.5, 100.2, 100.4],
      [100, 100.5, 100, 100],
      [100, 100.5, 99.05, 100],
      [100.3, 100.5, 100.2, 100.4],
      [100, 100.5, 100, 100],
      [100.3, 100.5, 100.2, 100.4],
      [100, 100.5, 100, 100],
      [100.3, 100.5, 100.2, 100.4],
      [100, 100.5, 99.08, 100.1], // anchor tests and holds
    ]);
    const long = CONDITION_HANDLERS.support!(
      handlerCtx(lows, { direction: 'long', params: { minTouches: 2, lookbackCandles: 500 } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.support!(
      handlerCtx(lows, { direction: 'short', params: { minTouches: 2, lookbackCandles: 500 } }),
    );
    assert.equal(short.status, 'unsatisfied');
    const tooFew = CONDITION_HANDLERS.support!(
      handlerCtx(lows, { direction: 'long', params: { minTouches: 5, lookbackCandles: 500 } }),
    );
    assert.equal(tooFew.status, 'unsatisfied');

    const highs = series([
      [100, 101.0, 99.5, 100],
      [99.8, 100, 99.5, 99.9],
      [100, 100.95, 99.5, 100],
      [99.8, 100, 99.5, 99.9],
      [100, 100, 99.5, 100],
      [99.8, 100, 99.5, 99.9],
      [100, 100, 99.5, 100],
      [99.8, 100, 99.5, 99.9],
      [100, 100, 99.5, 100],
      [100, 100.92, 99.5, 99.9], // anchor tests and rejects
    ]);
    const shortRes = CONDITION_HANDLERS.resistance!(
      handlerCtx(highs, { direction: 'short', params: { minTouches: 2, lookbackCandles: 500 } }),
    );
    assert.equal(shortRes.status, 'satisfied');
    const longRes = CONDITION_HANDLERS.resistance!(
      handlerCtx(highs, { direction: 'long', params: { minTouches: 2, lookbackCandles: 500 } }),
    );
    assert.equal(longRes.status, 'unsatisfied');
  });

  test('supply and demand: swing zones revisited satisfy their direction', () => {
    const supplyCandles = withLast(
      zz([
        [100, 99],
        [100, 99],
        [105, 103], // swing high 105
        [104, 102],
        [103, 101],
        [104, 102],
        [103, 101],
        [104, 102],
        [103, 101],
        [104, 102],
      ]),
      102.5, 104.95, 102, 103, // anchor revisits from below
    );
    const short = CONDITION_HANDLERS.supply!(
      handlerCtx(supplyCandles, { direction: 'short', params: { source: 'swing_high', minTouches: 1 } }),
    );
    assert.equal(short.status, 'satisfied');
    const long = CONDITION_HANDLERS.supply!(
      handlerCtx(supplyCandles, { direction: 'long', params: { source: 'swing_high', minTouches: 1 } }),
    );
    assert.equal(long.status, 'unsatisfied');

    const demandCandles = withLast(
      zz([
        [101, 100],
        [101, 100],
        [97, 95], // swing low 95
        [98, 96],
        [99, 97],
        [98, 96],
        [99, 97],
        [98, 96],
        [99, 97],
        [98, 96],
      ]),
      97.5, 98, 95.05, 97, // anchor revisits from above
    );
    const longDemand = CONDITION_HANDLERS.demand!(
      handlerCtx(demandCandles, { direction: 'long', params: { source: 'swing_low', minTouches: 1 } }),
    );
    assert.equal(longDemand.status, 'satisfied');
    const shortDemand = CONDITION_HANDLERS.demand!(
      handlerCtx(demandCandles, { direction: 'short', params: { source: 'swing_low', minTouches: 1 } }),
    );
    assert.equal(shortDemand.status, 'unsatisfied');
  });

  test('rejection_candle: wick dominance per direction with ratio extremes', () => {
    const pin = series([
      [100, 100.5, 99.5, 100],
      [100, 100.3, 98.8, 100.2], // bullish pin: lower wick 1.2, body 0.2 → ratio 6
    ]);
    const long = CONDITION_HANDLERS.rejection_candle!(
      handlerCtx(pin, { direction: 'long', params: { direction: 'bullish', minWickBodyRatio: 2 } }),
    );
    assert.equal(long.status, 'satisfied');
    const strict = CONDITION_HANDLERS.rejection_candle!(
      handlerCtx(pin, { direction: 'long', params: { direction: 'bullish', minWickBodyRatio: 10 } }),
    );
    assert.equal(strict.status, 'unsatisfied');
    const wrongSide = CONDITION_HANDLERS.rejection_candle!(
      handlerCtx(pin, { direction: 'short', params: { direction: 'bullish', minWickBodyRatio: 2 } }),
    );
    assert.equal(wrongSide.status, 'unsatisfied');
  });

  test('engulfing_candle: polarity, either-semantics and body ratio', () => {
    const candles = series([
      [101, 101.2, 100, 100.2], // bearish
      [100, 101.5, 99.9, 101.3], // bullish engulfing body 1.3 ≥ 0.8
    ]);
    const long = CONDITION_HANDLERS.engulfing_candle!(
      handlerCtx(candles, { direction: 'long', params: { direction: 'either' } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.engulfing_candle!(
      handlerCtx(candles, { direction: 'short', params: { direction: 'either' } }),
    );
    assert.equal(short.status, 'unsatisfied');
    const ratio = CONDITION_HANDLERS.engulfing_candle!(
      handlerCtx(candles, { direction: 'long', params: { direction: 'either', minBodyRatio: 2 } }),
    );
    assert.equal(ratio.status, 'unsatisfied');
    const noCandles = CONDITION_HANDLERS.engulfing_candle!(handlerCtx([], { params: { direction: 'either' } }));
    assert.equal(noCandles.status, 'insufficient_data');
  });

  test('displacement: constant-ATR series with param extremes and insufficient history', () => {
    const candles = constantTrSeries(20);
    const anchor = candle(AS_OF, 100, 104.2, 99.9, 104); // body 4 ≥ 1.5 × ATR 2
    const full = [...candles.slice(0, -1), anchor];
    const long = CONDITION_HANDLERS.displacement!(
      handlerCtx(full, { direction: 'long', params: { direction: 'bullish', atrPeriod: 14, minAtrMultiple: 1.5 } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.displacement!(
      handlerCtx(full, { direction: 'short', params: { direction: 'bullish', atrPeriod: 14, minAtrMultiple: 1.5 } }),
    );
    assert.equal(short.status, 'unsatisfied');
    const huge = CONDITION_HANDLERS.displacement!(
      handlerCtx(full, { direction: 'long', params: { direction: 'bullish', atrPeriod: 14, minAtrMultiple: 5 } }),
    );
    assert.equal(huge.status, 'unsatisfied');
    const tiny = CONDITION_HANDLERS.displacement!(
      handlerCtx(constantTrSeries(5), { direction: 'long', params: { direction: 'bullish', atrPeriod: 14, minAtrMultiple: 1.5 } }),
    );
    assert.equal(tiny.status, 'insufficient_data');
  });

  test('rr_requirement: rr method compares config target; structure measures; manual unsupported; no candidate insufficient', () => {
    const candidate = {
      entryPrice: 100,
      stopLossPrice: 99,
      riskDistance: 1,
      tp1Price: 101,
      tp2Price: 102,
      tp3Price: 103,
      achievableRr: null,
      basis: 'test',
    };
    const rrRisk = riskConfigurationSchema.parse({});
    const okCase = CONDITION_HANDLERS.rr_requirement!(
      handlerCtx(constantTrSeries(20), { params: { minRr: 2 }, risk: rrRisk, candidate }),
    );
    assert.equal(okCase.status, 'satisfied'); // tp3Rr 3 ≥ 2
    const strict = CONDITION_HANDLERS.rr_requirement!(
      handlerCtx(constantTrSeries(20), { params: { minRr: 4 }, risk: rrRisk, candidate }),
    );
    assert.equal(strict.status, 'unsatisfied');
    const structureRisk = riskConfigurationSchema.parse({ takeProfitMethod: 'structure' });
    const measured = CONDITION_HANDLERS.rr_requirement!(
      handlerCtx(constantTrSeries(20), {
        params: { minRr: 2 },
        risk: structureRisk,
        candidate: { ...candidate, achievableRr: 2.5, tp1Price: null, tp2Price: null, tp3Price: null },
      }),
    );
    assert.equal(measured.status, 'satisfied');
    const unmeasurable = CONDITION_HANDLERS.rr_requirement!(
      handlerCtx(constantTrSeries(20), {
        params: { minRr: 2 },
        risk: structureRisk,
        candidate: { ...candidate, achievableRr: null, tp1Price: null, tp2Price: null, tp3Price: null },
      }),
    );
    assert.equal(unmeasurable.status, 'insufficient_data');
    const manual = CONDITION_HANDLERS.rr_requirement!(
      handlerCtx(constantTrSeries(20), {
        params: { minRr: 2 },
        risk: riskConfigurationSchema.parse({ takeProfitMethod: 'manual' }),
        candidate,
      }),
    );
    assert.equal(manual.status, 'unsupported');
    const none = CONDITION_HANDLERS.rr_requirement!(
      handlerCtx(constantTrSeries(20), { params: { minRr: 2 }, risk: rrRisk, candidate: null }),
    );
    assert.equal(none.status, 'insufficient_data');
  });

  test('htf_alignment: structure source on the HTF role; role any uses htf candles', () => {
    const up = zz([
      [100, 99],
      [100, 99],
      [102, 100],
      [101, 99.5],
      [99, 98],
      [102, 100],
      [104, 102],
      [103, 101],
      [101, 99],
      [102, 100],
      [103, 101.5],
    ]);
    const long = CONDITION_HANDLERS.htf_alignment!(
      handlerCtx(up, { direction: 'long', timeframeRole: 'htf_bias', params: { direction: 'either', source: 'structure' } }),
    );
    assert.equal(long.status, 'satisfied');
    const short = CONDITION_HANDLERS.htf_alignment!(
      handlerCtx(up, { direction: 'short', timeframeRole: 'htf_bias', params: { direction: 'either', source: 'structure' } }),
    );
    assert.equal(short.status, 'unsatisfied');
    // role 'any' resolves to the HTF candles for this type
    const anyRole = CONDITION_HANDLERS.htf_alignment!(
      handlerCtx(up, { direction: 'long', timeframeRole: 'any', params: { direction: 'either', source: 'structure' } }),
    );
    assert.equal(anyRole.status, 'satisfied');
    const flat = CONDITION_HANDLERS.htf_alignment!(
      handlerCtx(constantTrSeries(20), { direction: 'long', timeframeRole: 'htf_bias', params: { direction: 'either', source: 'structure' } }),
    );
    assert.equal(flat.status, 'insufficient_data');
  });
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

describe('m3 engine', () => {
  const engine = createEvaluationEngine();

  function evaluate(config: StrategyVersionConfig, candles: CandleDto[] = series(longTrueShapes)) {
    return engine.evaluate({ config, instrument: { assetClass: 'forex', symbol: 'EURUSD' }, candles: { htf_bias: candles, setup: candles, entry: candles }, asOfMs: AS_OF });
  }

  test('AND group: every member must be satisfied; per-direction outcomes differ', () => {
    const result = evaluate(mkConfig({ ruleGroups: [group('g', 'AND', [longTrue])] }));
    assert.equal(result.long.passed, true);
    assert.equal(result.short.passed, false);
    assert.ok(result.short.failureReasons[0]!.includes('rule group "g"'));
    assert.equal(result.long.groups[0]!.satisfied, true);
    assert.equal(result.long.groups[0]!.relevance, 'pass');
  });

  test('OR group: any satisfied member passes the group for that direction', () => {
    const result = evaluate(mkConfig({ ruleGroups: [group('g', 'OR', [longTrue, volNeutral])] }));
    assert.equal(result.long.passed, true); // longTrue satisfied
    assert.equal(result.short.passed, true); // volNeutral satisfied (direction-neutral)
    const statuses = result.short.groups[0]!.conditions.map((c) => `${c.conditionType}:${c.status}`).join(',');
    assert.equal(statuses, 'engulfing_candle:unsatisfied,volatility_filter:satisfied');
  });

  test('mixed groups combine with top-level AND', () => {
    const result = evaluate(
      mkConfig({ ruleGroups: [group('g1', 'AND', [longTrue]), group('g2', 'OR', [volNeutral, { ...newsCond, classification: 'optional' as const }])] }),
    );
    // long: g1 satisfied, g2 satisfied via volatility → passes
    assert.equal(result.long.passed, true);
    // short: g1 unsatisfied (bullish engulfing only) → fails even though g2 passes
    assert.equal(result.short.passed, false);
    assert.ok(result.short.failureReasons.some((r) => r.includes('g1')));
  });

  test('optional-only groups are ignored for pass/fail but reported', () => {
    const result = evaluate(
      mkConfig({ ruleGroups: [group('g1', 'AND', [longTrue]), group('g2', 'AND', [cond('news_filter', 'optional', 'any')])] }),
    );
    assert.equal(result.long.passed, true);
    assert.equal(result.long.groups[1]!.relevance, 'ignore');
    assert.equal(result.long.groups[1]!.conditions[0]!.status, 'insufficient_data');
  });

  test('confirmation classification must pass like required', () => {
    const result = evaluate(
      mkConfig({ ruleGroups: [group('g', 'AND', [longTrue, { ...longTrue, classification: 'confirmation' as const }])] }),
    );
    assert.equal(result.long.passed, true);
    const failing = evaluate(
      mkConfig({ ruleGroups: [group('g', 'AND', [longTrue, { ...shortTrue, classification: 'confirmation' as const }])] }),
    );
    assert.equal(failing.long.passed, false);
  });

  test('disqualifying satisfied vetoes at condition level even inside a passing OR group', () => {
    const result = evaluate(
      mkConfig({
        ruleGroups: [group('g1', 'AND', [longTrue]), group('g2', 'OR', [{ ...longTrue, classification: 'disqualifying' as const }, volNeutral])],
      }),
    );
    // long: g1 satisfied; g2 satisfied; but the disqualifying condition IS satisfied → veto.
    assert.equal(result.long.passed, false);
    assert.ok(result.long.failureReasons.some((r) => r.includes('disqualifying')));
  });

  test('insufficient data fails closed: required blocked even in a satisfied OR group', () => {
    const result = evaluate(mkConfig({ ruleGroups: [group('g', 'OR', [longTrue, newsCond])] }));
    assert.equal(result.long.passed, false);
    assert.ok(result.long.failureReasons.some((r) => r.includes('could not be evaluated')));
  });

  test('disqualifying condition that cannot be ruled out still vetoes', () => {
    const result = evaluate(
      mkConfig({ ruleGroups: [group('g1', 'AND', [longTrue]), group('g2', 'AND', [cond('news_filter', 'disqualifying', 'any')])] }),
    );
    assert.equal(result.long.passed, false);
    assert.ok(result.long.failureReasons.some((r) => r.includes('could not be ruled out')));
  });

  test('empty groups are vacuously satisfied', () => {
    const result = evaluate(mkConfig({ ruleGroups: [group('g1', 'AND', [longTrue]), group('empty', 'AND', [])] }));
    assert.equal(result.long.passed, true);
    assert.equal(result.long.groups[1]!.satisfied, true);
  });

  test('version-level session filters gate the direction; exchange timezone fails closed', () => {
    const asOf = AS_OF; // matches the series builder's fixed anchor
    const candlesFull = series(longTrueShapes);
    const result = engine.evaluate({
      config: mkConfig({
        sessionFilters: [{ session: 'asia', mode: 'exclude', timezone: 'utc' }],
        ruleGroups: [group('g', 'AND', [longTrue])],
      }),
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      candles: { htf_bias: candlesFull, setup: candlesFull, entry: candlesFull },
      asOfMs: asOf,
    });
    const anchorHour = new Date(asOf - HOUR).getUTCHours();
    const expectedInsideAsia = anchorHour >= 0 && anchorHour < 9;
    assert.equal(result.long.sessionFilters[0]!.status, expectedInsideAsia ? 'unsatisfied' : 'satisfied');
    assert.equal(result.long.passed, !expectedInsideAsia);

    const exchange = engine.evaluate({
      config: mkConfig({
        sessionFilters: [{ session: 'london', mode: 'include', timezone: 'exchange' }],
        ruleGroups: [group('g', 'AND', [longTrue])],
      }),
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      candles: { htf_bias: candlesFull, setup: candlesFull, entry: candlesFull },
      asOfMs: asOf,
    });
    assert.equal(exchange.long.passed, false);
    assert.equal(exchange.long.sessionFilters[0]!.status, 'unsupported');
  });

  test('timeframeRole any evaluates the setup-role candles', () => {
    const at13 = Date.UTC(2026, 0, 15, 13, 0, 0, 0);
    const asOf = at13 + HOUR;
    // Entry role has NO candles; the 'any'-role session condition must still
    // evaluate against the setup anchor.
    const setupCandles = [candle(asOf - HOUR, 100, 100.5, 99.5, 100)];
    const result = engine.evaluate({
      config: mkConfig({ ruleGroups: [group('g', 'AND', [cond('session_requirement', 'required', 'any', { sessions: ['london'], mode: 'include', timezone: 'utc' })])] }),
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      candles: { htf_bias: [], setup: setupCandles, entry: [] },
      asOfMs: asOf,
    });
    assert.equal(result.long.groups[0]!.conditions[0]!.status, 'satisfied');
  });

  test('evaluation is deterministic: identical inputs produce identical results', () => {
    const config = mkConfig({
      ruleGroups: [group('g', 'AND', [longTrue, cond('volatility_filter', 'optional', 'any', { metric: 'atr', period: 14, min: 0 })])],
    });
    const a = evaluate(config);
    const b = evaluate(config);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('asOfMs only sees candles that are fully closed at the anchor', () => {
    const config = mkConfig({ ruleGroups: [group('g', 'AND', [longTrue])] });
    const early = engine.evaluate({
      config,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      candles: { htf_bias: series(longTrueShapes), setup: series(longTrueShapes), entry: series(longTrueShapes) },
      asOfMs: AS_OF - HOUR, // the engulfing candle now closes AFTER the anchor → excluded
    });
    assert.equal(early.long.passed, false); // not enough closed candles for the pattern
  });

  test('candidate levels: fixed stop derives pips-precise risk and rr targets', () => {
    const candles = series(longTrueShapes);
    const risk = riskConfigurationSchema.parse({ stopLossMethod: 'fixed', stopLossBuffer: 1, stopLossBufferUnit: 'pips', takeProfitMethod: 'rr' });
    const candidate = deriveCandidate(risk, candles, 'EURUSD');
    assert.ok(candidate);
    assert.ok(candidate.stopLossPrice !== null);
    assert.ok(candidate.riskDistance !== null);
    assert.ok(candidate.tp3Price !== null);
    assert.equal(candidate.entryPrice, 101.3);
    assert.ok(Math.abs(candidate.stopLossPrice - (101.3 - 0.0001)) < 1e-12);
    assert.ok(Math.abs(candidate.riskDistance - 0.0001) < 1e-12);
    assert.ok(Math.abs(candidate.tp3Price - (101.3 + 3 * 0.0001)) < 1e-9);
    assert.equal(candidate.achievableRr, 3);
  });

  test('candidate levels: structure stop uses the most recent swing; structural target measures rr', () => {
    const candles = zz([
      [100, 99],
      [100, 99],
      [100, 97], // swing low 97
      [100, 98],
      [100, 99],
      [101.5, 100,],
    ]);
    const risk = riskConfigurationSchema.parse({ stopLossMethod: 'structure', takeProfitMethod: 'structure' });
    const candidate = deriveCandidate(risk, candles, 'EURUSD');
    assert.ok(candidate);
    assert.equal(candidate.entryPrice, 100.75);
    assert.ok(candidate.stopLossPrice < 100.75); // beyond the swing
    assert.ok(candidate.achievableRr === null || candidate.achievableRr > 0);
  });

  test('candidate levels: insufficient ATR history for atr stops yields null + engine note', () => {
    const risk = riskConfigurationSchema.parse({ stopLossMethod: 'atr' });
    const candles = series(longTrueShapes); // 18 candles < ATR(14) requirement of 15? 18 ≥ 15 — use fewer
    const shortCandles = candles.slice(0, 10);
    const candidate = deriveCandidate(risk, shortCandles, 'EURUSD');
    assert.equal(candidate, null);
    const result = engine.evaluate({
      config: mkConfig({ risk: { ...riskConfigurationSchema.parse({}), stopLossMethod: 'atr' }, ruleGroups: [group('g', 'AND', [longTrue])] }),
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      candles: { htf_bias: shortCandles, setup: shortCandles, entry: shortCandles },
      asOfMs: AS_OF,
    });
    assert.ok(result.notes.some((n) => n.includes('candidate')));
  });

  test('rr_requirement evaluates end-to-end against the derived candidate', () => {
    const config = mkConfig({
      risk: { ...riskConfigurationSchema.parse({}), stopLossMethod: 'fixed', stopLossBuffer: 1, stopLossBufferUnit: 'pips', takeProfitMethod: 'rr' },
      ruleGroups: [group('g', 'AND', [longTrue, cond('rr_requirement', 'required', 'setup', { minRr: 2 })])],
    });
    const result = evaluate(config);
    assert.equal(result.long.passed, true);
    assert.ok(result.long.candidate);
    const rrOutcome = result.long.groups[0]!.conditions.find((c) => c.conditionType === 'rr_requirement');
    assert.ok(rrOutcome);
    assert.equal(rrOutcome.status, 'satisfied');
    assert.ok(rrOutcome.detail.includes('3R'));
  });

  test('unknown condition types surface as unsupported without crashing (fail-closed)', () => {
    // Built RAW (bypassing the contracts schema, which rejects unknown types at
    // write time) to exercise the engine's defensive branch.
    const raw = {
      timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
      marketScope: { mode: 'all' },
      sessionFilters: [],
      risk: riskConfigurationSchema.parse({}),
      filters: [],
      ruleGroups: [group('g', 'AND', [{ ...longTrue, conditionType: 'time_travel' }])],
    } as unknown as StrategyVersionConfig;
    const result = evaluate(raw);
    assert.equal(result.long.passed, false);
    assert.equal(result.long.groups[0]!.conditions[0]!.status, 'unsupported');
  });

  test('full result payload validates against the published zod contract', () => {
    const config = mkConfig({
      marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'eurusd' }] },
      ruleGroups: [group('g', 'AND', [longTrue, cond('volatility_filter', 'optional', 'any', { metric: 'atr', period: 14, min: 0 })])],
    });
    const result = evaluate(config);
    const dto = evaluationResultSchema.parse({
      strategyId: '11111111-1111-1111-1111-111111111111',
      versionId: '22222222-2222-2222-2222-222222222222',
      versionNumber: 3,
      engineVersion: engine.engineVersion,
      asOfMs: AS_OF,
      evaluatedAt: new Date(AS_OF).toISOString(),
      instruments: [
        {
          assetClass: 'forex',
          symbol: 'EURUSD',
          directions: { long: result.long, short: result.short },
          anyPassed: result.long.passed || result.short.passed,
        },
      ],
      truncated: false,
      notes: result.notes,
    });
    assert.equal(dto.instruments[0]!.symbol, 'EURUSD');
  });
});

describe('m3 requiredWindows', () => {
  test('window sizing follows the largest declared lookback per role, capped and floored', () => {
    const config = mkConfig({
      ruleGroups: [
        group('g', 'AND', [
          cond('support', 'required', 'setup', { minTouches: 2, lookbackCandles: 500 }),
          cond('choch', 'required', 'htf_bias', { direction: 'either', lookbackCandles: 200 }),
          cond('engulfing_candle', 'required', 'entry'),
          cond('fvg', 'required', 'any', { kind: 'bullish' }),
          cond('htf_alignment', 'required', 'htf_bias', { source: 'structure' }),
        ]),
      ],
    });
    const windows = requiredWindows(config);
    assert.equal(windows.setup, 560); // 500 + 60 margin
    assert.ok(windows.htf_bias >= 260); // 200 + 60
    assert.ok(windows.entry >= 120); // floor
    // capped at the store ceiling
    const huge = mkConfig({
      ruleGroups: [group('g', 'AND', [cond('support', 'required', 'setup', { minTouches: 2, lookbackCandles: 5000 })])],
    });
    assert.equal(requiredWindows(huge).setup, 5000);
  });
});
