/**
 * Sequential anchors (`anchorOffsetCandles`) — focused regression tests.
 *
 * THE PROBLEM. Every M3 condition was evaluated against the LATEST closed
 * candle of its `timeframeRole`, so a multi-timeframe sequence could not be
 * expressed:
 *
 *     4h liquidity sweep  →  later 1h break & retest  →  later 15m rejection
 *
 * On one anchor the 4h sweep had to hold on the 4h candle that closed WITH the
 * anchor, which is a different (and later) event than "a 4h sweep completed
 * before the 1h/15m trigger". The engine could only ever say "all three are
 * true on the same anchor", never "the coarse event came first".
 *
 * THE FIX (m3-deterministic-eval-3, additive). Every condition accepts an
 * optional integer `anchorOffsetCandles` (>= 0, default 0). The ENGINE — never
 * a handler — evaluates the condition against its role's candle series
 * truncated by that many candles (the role's anchor moves back N bars).
 * `0` is the pre-existing behaviour, so every config stored before the param
 * existed evaluates byte-identically.
 *
 * The "Gold MTF sequential" fixture below is the reference configuration the
 * platform's Gold strategy uses: the 4h sweep at offset 1 (it must have
 * completed on the PREVIOUS closed 4h candle), the 1h break/retest and the 15m
 * rejection at offset 0 (the anchor). Its tests pin both directions of the
 * contract: the sequence PASSES with the offsets and FAILS without them, on
 * identical candles.
 *
 * No database, no provider, no wall clock: everything here is a pure function
 * of hand-built candles and a fixed anchor.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_OFFSET_PARAM,
  anchorOffsetOf,
  getConditionType,
  listConditionTypes,
  strategyConditionSchema,
  strategyVersionConfigSchema,
  type CandleDto,
  type StrategyRuleGroup,
  type StrategyVersionConfig,
  type Timeframe,
} from '@veltrixeye/contracts';
import { createEvaluationEngine, requiredWindows, runBacktest } from '../src/index.js';
import { roleCoverageWindow, setupCoverageWindow } from '../src/backtest/engine.js';

// ---------------------------------------------------------------------------
// Deterministic builders (fixed anchor, no clock)
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const H4 = 4 * HOUR;
const M15 = 15 * MINUTE;

/** Fixed anchor (2027-01-15T00:00:00Z). Every fixture candle closes at or before it. */
const AS_OF = 1_800_000_000_000;

function candle(time: number, open: number, high: number, low: number, close: number): CandleDto {
  assert.ok(low <= Math.min(open, close) && high >= Math.max(open, close), 'fixture violates OHLC invariant');
  return { time, open, high, low, close, volume: null };
}

/**
 * Series shapes (oldest first: [open, high, low, close]) whose LAST candle
 * closes EXACTLY at `anchorMs`, on the given period grid.
 */
function seriesEndingAt(
  anchorMs: number,
  periodMs: number,
  shapes: Array<[number, number, number, number]>,
): CandleDto[] {
  const n = shapes.length;
  return shapes.map(([o, h, l, c], i) => candle(anchorMs - (n - i) * periodMs, o, h, l, c));
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

// ---------------------------------------------------------------------------
// The Gold MTF sequential reference fixture
// ---------------------------------------------------------------------------

/**
 * 4h candles. Candle #6 (second-to-last) wicks through the 99.4 low of every
 * candle before it and closes back above it — a sweep of resting liquidity;
 * candle #7 (the latest CLOSED 4h candle) is an ordinary candle that sweeps
 * nothing. That asymmetry is exactly what `anchorOffsetCandles: 1` reads:
 * the offset condition sees #6, a 0-offset condition sees #7 and fails.
 */
const HTF_SHAPES: Array<[number, number, number, number]> = [
  [100.0, 100.6, 99.6, 100.2],
  [100.2, 100.8, 99.8, 100.4],
  [100.4, 100.9, 99.9, 100.3],
  [100.3, 100.7, 99.7, 100.1],
  [100.1, 100.5, 99.5, 100.0],
  [100.0, 100.4, 99.4, 99.9],
  [99.9, 100.3, 98.9, 100.05], // ← the 4h sweep (low 98.9 < 99.4, closes 100.05 above)
  [100.05, 100.35, 99.95, 100.25], // ← latest closed 4h candle: no sweep
];

/**
 * 1h candles: a pivot high at 101.0 (index 2), a close through it (index 7),
 * then a retest that holds it (index 8) and a close back above it — the
 * breakout-and-retest leg.
 */
const SETUP_SHAPES: Array<[number, number, number, number]> = [
  [100.0, 100.5, 99.9, 100.4],
  [100.4, 100.9, 100.2, 100.6],
  [100.6, 101.0, 100.4, 100.8], // pivot high 101.0
  [100.8, 100.9, 100.3, 100.5],
  [100.5, 100.8, 100.2, 100.4],
  [100.4, 100.6, 100.1, 100.3],
  [100.3, 101.6, 100.2, 101.5], // break: close 101.5 > 101.0
  [101.5, 101.7, 100.95, 101.3], // retest: low 100.95 ≤ 101.0 + 0.1% and holds
  [101.3, 101.8, 101.2, 101.6],
  [101.6, 102.0, 101.4, 101.9], // anchor: close 101.9 > 101.0
];

/**
 * 15m candles: the latest closed candle is a bullish rejection (lower wick 0.30
 * vs body 0.10 ⇒ ratio 3 ≥ 2); the one BEFORE it (ratio 1.0) is not — the pair
 * proves the entry offset reads the 15m candle it claims to.
 */
const ENTRY_SHAPES: Array<[number, number, number, number]> = [
  [100.0, 100.15, 99.9, 100.0],
  [100.0, 100.2, 99.95, 100.1],
  [100.1, 100.2, 100.0, 100.05], // ← not a rejection (ratio 1.0)
  [100.05, 100.2, 99.75, 100.15], // ← bullish rejection (ratio 3.0)
];

const GOLD_TIMEFRAMES: { htf_bias: Timeframe; setup: Timeframe; entry: Timeframe } = {
  htf_bias: '4h',
  setup: '1h',
  entry: '15m',
};

/**
 * The Gold strategy's sequential configuration: 4h liquidity sweep → 1h break
 * & retest → 15m rejection, with one offset per leg. `sweepLookback` is
 * parameterised so the same builder can prove the window math (a lookback
 * below the 120-candle floor would hide the offset in the floor).
 */
function goldConfig(args: {
  sweepOffset: number;
  breakRetestOffset?: number;
  rejectionOffset?: number;
  sweepLookback?: number;
}): StrategyVersionConfig {
  return strategyVersionConfigSchema.parse({
    timeframes: GOLD_TIMEFRAMES,
    marketScope: {
      mode: 'instruments',
      instruments: [{ assetClass: 'commodity', symbol: 'XAUUSD' }],
    },
    risk: {
      minRr: 2,
      stopLossMethod: 'fixed',
      stopLossBuffer: 0.5,
      stopLossBufferUnit: 'pct',
      takeProfitMethod: 'rr',
      tp1Rr: 1,
      tp2Rr: 2,
      tp3Rr: 3,
      minQualityScore: 65,
    },
    ruleGroups: [
      group(
        '4h liquidity sweep',
        'AND',
        [
          cond('liquidity_sweep', 'required', 'htf_bias', {
            side: 'below',
            lookbackCandles: args.sweepLookback ?? 8,
            minWickRatio: 0.3,
            [ANCHOR_OFFSET_PARAM]: args.sweepOffset,
          }),
        ],
      ),
      group(
        '1h break & retest',
        'AND',
        [
          cond('break_retest', 'required', 'setup', {
            direction: 'bullish',
            maxRetestCandles: 24,
            retestTolerancePct: 0.1,
            [ANCHOR_OFFSET_PARAM]: args.breakRetestOffset ?? 0,
          }),
        ],
      ),
      group(
        '15m rejection',
        'AND',
        [
          cond('rejection_candle', 'required', 'entry', {
            direction: 'bullish',
            minWickBodyRatio: 2,
            [ANCHOR_OFFSET_PARAM]: args.rejectionOffset ?? 0,
          }),
        ],
      ),
    ],
  });
}

/**
 * A single setup-role structure condition whose lookback (200) clears the
 * 120-candle floor, so the offset is observable in the window math (a
 * `break_retest` alone asks for 84 < 120 and hides small offsets in the floor).
 */
function setupWindowConfig(offset: number): StrategyVersionConfig {
  return strategyVersionConfigSchema.parse({
    timeframes: GOLD_TIMEFRAMES,
    marketScope: { mode: 'all' },
    risk: {},
    ruleGroups: [
      group('1h structure', 'AND', [
        cond('choch', 'required', 'setup', { lookbackCandles: 200, [ANCHOR_OFFSET_PARAM]: offset }),
      ]),
    ],
  });
}

function goldCandles(): { htf_bias: CandleDto[]; setup: CandleDto[]; entry: CandleDto[] } {
  return {
    htf_bias: seriesEndingAt(AS_OF, H4, HTF_SHAPES),
    setup: seriesEndingAt(AS_OF, HOUR, SETUP_SHAPES),
    entry: seriesEndingAt(AS_OF, M15, ENTRY_SHAPES),
  };
}

const engine = createEvaluationEngine();

function evaluateGold(config: StrategyVersionConfig) {
  return engine.evaluate({
    config,
    instrument: { assetClass: 'commodity', symbol: 'XAUUSD' },
    pipSize: 0.01, // XAUUSD `instrument_risk_specs.pip_size` (migration 0017)
    candles: goldCandles(),
    asOfMs: AS_OF,
  });
}

function outcomeOf(result: ReturnType<typeof evaluateGold>, groupName: string, conditionType: string) {
  const group = result.long.groups.find((g) => g.name === groupName);
  assert.ok(group, `missing rule group ${groupName}`);
  const outcome = group.conditions.find((c) => c.conditionType === conditionType);
  assert.ok(outcome, `missing condition ${conditionType} in group ${groupName}`);
  return outcome;
}

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

describe('sequential anchors — contract surface', () => {
  test('every condition type accepts an optional anchorOffsetCandles, defaulting to 0', () => {
    const types = listConditionTypes();
    assert.ok(types.length >= 19);
    for (const def of types) {
      // `spread_filter` requires `max` (it has no default), so its zero-offset
      // baseline is supplied explicitly — everything else accepts `{}`.
      const baseline = def.type === 'spread_filter' ? { max: 2 } : {};
      const parsed = def.paramSchema.safeParse(baseline);
      assert.equal(
        parsed.success,
        true,
        `${def.type} must still accept its baseline params (offset defaults to 0)`,
      );
      if (parsed.success) {
        assert.equal(
          (parsed.data as Record<string, unknown>)[ANCHOR_OFFSET_PARAM],
          0,
          `${def.type} must default the anchor offset to 0`,
        );
      }
      assert.equal(
        def.paramSchema.safeParse({ ...baseline, [ANCHOR_OFFSET_PARAM]: 1 }).success,
        true,
        `${def.type} must accept a positive anchor offset`,
      );
      assert.equal(
        def.paramSchema.safeParse({ ...baseline, [ANCHOR_OFFSET_PARAM]: 0 }).success,
        true,
        `${def.type} must accept a zero anchor offset`,
      );
    }
  });

  test('anchorOffsetCandles rejects negative, fractional, non-numeric and oversized values', () => {
    const sweep = getConditionType('liquidity_sweep')!;
    for (const bad of [-1, 0.5, '1', null, 5001, Number.NaN]) {
      assert.equal(
        sweep.paramSchema.safeParse({ [ANCHOR_OFFSET_PARAM]: bad }).success,
        false,
        `anchorOffsetCandles ${String(bad)} must be rejected`,
      );
    }
    assert.equal(sweep.paramSchema.safeParse({ [ANCHOR_OFFSET_PARAM]: 5000 }).success, true);
  });

  test('strategyConditionSchema carries the offset and still rejects unknown params', () => {
    const base = { conditionType: 'liquidity_sweep', classification: 'required', timeframeRole: 'htf_bias' };
    const ok = strategyConditionSchema.safeParse({
      ...base,
      params: { side: 'below', lookbackCandles: 100, [ANCHOR_OFFSET_PARAM]: 1 },
    });
    assert.equal(ok.success, true, JSON.stringify(ok.success ? '' : ok.error?.issues));
    const unknown = strategyConditionSchema.safeParse({ ...base, params: { __unknown_key__: 1 } });
    assert.equal(unknown.success, false);
  });

  test('anchorOffsetOf reads a stored config defensively (absent/invalid ⇒ 0)', () => {
    assert.equal(anchorOffsetOf(undefined), 0);
    assert.equal(anchorOffsetOf({}), 0);
    assert.equal(anchorOffsetOf({ [ANCHOR_OFFSET_PARAM]: 0 }), 0);
    assert.equal(anchorOffsetOf({ [ANCHOR_OFFSET_PARAM]: 3 }), 3);
    // A corrupted row must degrade to the pre-offset behaviour, never to NaN
    // indexing or a negative slice.
    for (const bad of [-2, 1.5, '2', null, Number.NaN, Infinity]) {
      assert.equal(anchorOffsetOf({ [ANCHOR_OFFSET_PARAM]: bad }), 0, `offset ${String(bad)} ⇒ 0`);
    }
  });
});

// ---------------------------------------------------------------------------
// Engine semantics
// ---------------------------------------------------------------------------

describe('sequential anchors — engine semantics', () => {
  test('Gold MTF sequential: the 4h sweep (offset 1) precedes the 1h/15m triggers at the anchor', () => {
    const result = evaluateGold(goldConfig({ sweepOffset: 1 }));

    const sweep = outcomeOf(result, '4h liquidity sweep', 'liquidity_sweep');
    assert.equal(sweep.status, 'satisfied');
    // The outcome names the offset it was computed with, so a result can always
    // be read back to the exact candles behind it.
    assert.match(sweep.detail, /anchor offset 1 × 4h/);
    assert.match(sweep.detail, /swept low 99\.4/);

    assert.equal(outcomeOf(result, '1h break & retest', 'break_retest').status, 'satisfied');
    assert.equal(outcomeOf(result, '15m rejection', 'rejection_candle').status, 'satisfied');
    assert.equal(result.long.passed, true);
    assert.deepEqual(result.long.failureReasons, []);
    // Every leg is long-context (sweep of lows, bullish break/retest, bullish
    // rejection) — the short direction is not what this strategy expresses.
    assert.equal(result.short.passed, false);
  });

  test('the same candles FAIL without the offset — the offset is what expresses the sequence', () => {
    const noOffset = evaluateGold(goldConfig({ sweepOffset: 0 }));
    const sweep = outcomeOf(noOffset, '4h liquidity sweep', 'liquidity_sweep');
    assert.equal(sweep.status, 'unsatisfied');
    assert.equal(sweep.status === 'unsatisfied' && sweep.detail.includes('anchor offset'), false);
    assert.equal(noOffset.long.passed, false);
    assert.ok(
      noOffset.long.failureReasons.some((r) => r.includes('4h liquidity sweep')),
      `expected the sweep group to block the direction, got ${JSON.stringify(noOffset.long.failureReasons)}`,
    );
    // The 1h and 15m legs are untouched by the sweep's offset: same anchor,
    // same read, satisfied in both runs.
    assert.equal(outcomeOf(noOffset, '1h break & retest', 'break_retest').status, 'satisfied');
    assert.equal(outcomeOf(noOffset, '15m rejection', 'rejection_candle').status, 'satisfied');
  });

  test('the offset shifts ONLY the condition\'s own role series', () => {
    // entry offset 0 → the latest 15m candle is a rejection; the 4h sweep at
    // offset 1 keeps working (its role is htf_bias, not entry).
    const entryAtAnchor = evaluateGold(goldConfig({ sweepOffset: 1, rejectionOffset: 0 }));
    assert.equal(outcomeOf(entryAtAnchor, '15m rejection', 'rejection_candle').status, 'satisfied');
    assert.equal(outcomeOf(entryAtAnchor, '4h liquidity sweep', 'liquidity_sweep').status, 'satisfied');
    assert.equal(entryAtAnchor.long.passed, true);

    // entry offset 1 → the PREVIOUS 15m candle (not a rejection) is read, so
    // the entry leg fails while the htf leg is still evaluated on its own
    // shifted series and stays satisfied: one offset never leaks into another
    // role.
    const entryBack = evaluateGold(goldConfig({ sweepOffset: 1, rejectionOffset: 1 }));
    const entryOutcome = outcomeOf(entryBack, '15m rejection', 'rejection_candle');
    assert.equal(entryOutcome.status, 'unsatisfied');
    assert.match(entryOutcome.detail, /anchor offset 1 × 15m/);
    assert.equal(outcomeOf(entryBack, '4h liquidity sweep', 'liquidity_sweep').status, 'satisfied');
    assert.equal(outcomeOf(entryBack, '1h break & retest', 'break_retest').status, 'satisfied');
    assert.equal(entryBack.long.passed, false);
    assert.ok(entryBack.long.failureReasons.some((r) => r.includes('15m rejection')));
  });

  test('an offset deeper than the stored history fails closed (insufficient_data)', () => {
    const tooDeep = evaluateGold(goldConfig({ sweepOffset: 1, rejectionOffset: 100 }));
    const entryOutcome = outcomeOf(tooDeep, '15m rejection', 'rejection_candle');
    assert.equal(entryOutcome.status, 'insufficient_data');
    assert.equal(tooDeep.long.passed, false);
    assert.ok(
      tooDeep.long.failureReasons.some((r) => r.includes('could not be evaluated (insufficient_data)')),
      JSON.stringify(tooDeep.long.failureReasons),
    );
  });

  test('a corrupted offset value is fail-closed, never silently ignored', () => {
    // Raw construction (bypassing the contracts schema, which rejects this at
    // write time) to exercise the engine's defensive param re-validation.
    const raw = {
      timeframes: GOLD_TIMEFRAMES,
      marketScope: { mode: 'all' },
      sessionFilters: [],
      risk: goldConfig({ sweepOffset: 1 }).risk,
      filters: [],
      ruleGroups: [
        group('sweep', 'AND', [
          {
            conditionType: 'liquidity_sweep',
            classification: 'required',
            timeframeRole: 'htf_bias',
            params: { side: 'below', [ANCHOR_OFFSET_PARAM]: 'one' },
            position: 0,
          },
        ]),
      ],
    } as unknown as StrategyVersionConfig;
    const result = engine.evaluate({
      config: raw,
      instrument: { assetClass: 'commodity', symbol: 'XAUUSD' },
      pipSize: 0.01,
      candles: goldCandles(),
      asOfMs: AS_OF,
    });
    assert.equal(result.long.groups[0]!.conditions[0]!.status, 'unsupported');
    assert.equal(result.long.passed, false);
  });

  test('offset 0 is byte-identical to the pre-offset engine (no detail decoration)', () => {
    const explicitZero = evaluateGold(goldConfig({ sweepOffset: 1, rejectionOffset: 0 }));
    const decorated = evaluateGold(goldConfig({ sweepOffset: 1, rejectionOffset: 1 }));
    // 15m offset 0 keeps the historical detail string; offset 1 annotates it.
    assert.doesNotMatch(
      outcomeOf(explicitZero, '15m rejection', 'rejection_candle').detail,
      /anchor offset/,
    );
    assert.match(outcomeOf(decorated, '15m rejection', 'rejection_candle').detail, /\[anchor offset 1 × 15m\]$/);
  });
});

// ---------------------------------------------------------------------------
// Window / warm-up math (requiredWindows feeds every loader)
// ---------------------------------------------------------------------------

describe('sequential anchors — history windows', () => {
  test('requiredWindows adds the offset to the condition\'s own role only', () => {
    const base = requiredWindows(goldConfig({ sweepOffset: 0, sweepLookback: 200 }));
    const shifted = requiredWindows(goldConfig({ sweepOffset: 1, sweepLookback: 200 }));

    // 200 lookback + 1 offset + 60 margin = 261 (the 120 floor is exceeded).
    assert.equal(base.htf_bias, 260);
    assert.equal(shifted.htf_bias, 261);
    assert.equal(shifted.setup, base.setup);
    assert.equal(shifted.entry, base.entry);

    // A setup-role offset grows the setup window by exactly that offset.
    const setupBase = requiredWindows(setupWindowConfig(0));
    const setupShifted = requiredWindows(setupWindowConfig(5));
    assert.equal(setupBase.setup, 260); // 200 lookback + 60 margin
    assert.equal(setupShifted.setup, 265);
    assert.equal(setupShifted.htf_bias, setupBase.htf_bias);
    assert.equal(setupShifted.entry, setupBase.entry);
  });

  test('the offset never breaks the 5000-candle ceiling', () => {
    const config = strategyVersionConfigSchema.parse({
      timeframes: GOLD_TIMEFRAMES,
      marketScope: { mode: 'all' },
      risk: {},
      ruleGroups: [
        group('g', 'AND', [
          cond('support', 'required', 'setup', { lookbackCandles: 5000, [ANCHOR_OFFSET_PARAM]: 5000 }),
        ]),
      ],
    });
    assert.equal(requiredWindows(config).setup, 5000);
  });

  test('backtest warm-up/coverage windows inherit the offset', () => {
    const from = AS_OF - 30 * 24 * HOUR;
    const before = requiredWindows(goldConfig({ sweepOffset: 0, sweepLookback: 200 })).htf_bias;
    const after = requiredWindows(goldConfig({ sweepOffset: 1, sweepLookback: 200 })).htf_bias;
    assert.equal(after - before, 1);

    const warmupBefore = roleCoverageWindow({
      role: 'htf_bias',
      config: goldConfig({ sweepOffset: 0, sweepLookback: 200 }),
      fromMs: from,
      horizonMs: AS_OF,
    });
    const warmupAfter = roleCoverageWindow({
      role: 'htf_bias',
      config: goldConfig({ sweepOffset: 1, sweepLookback: 200 }),
      fromMs: from,
      horizonMs: AS_OF,
    });
    // One extra 4h candle of warm-up; the load limit grows by two: the extra
    // warm-up candle plus the extra period the (earlier) window now spans.
    assert.equal(warmupBefore.from - warmupAfter.from, H4);
    assert.equal(warmupAfter.limit, warmupBefore.limit + 2);

    // The setup role's own coverage window follows a setup-role offset: five
    // extra 1h candles of warm-up, and five more candles of load limit.
    const setupBefore = setupCoverageWindow({
      config: setupWindowConfig(0),
      fromMs: from,
      toMs: AS_OF,
      maxHoldCandles: 0,
    });
    const setupAfter = setupCoverageWindow({
      config: setupWindowConfig(5),
      fromMs: from,
      toMs: AS_OF,
      maxHoldCandles: 0,
    });
    assert.equal(setupBefore.from - setupAfter.from, 5 * HOUR);
    assert.equal(setupAfter.limit, setupBefore.limit + 5);
  });
});

// ---------------------------------------------------------------------------
// Replay (M6) — the same series, offset vs no offset
// ---------------------------------------------------------------------------

describe('sequential anchors — backtest replay', () => {
  const instrument = { assetClass: 'commodity', symbol: 'XAUUSD' };

  function replay(config: StrategyVersionConfig) {
    return runBacktest({
      config,
      instrument,
      pipSize: 0.01,
      candles: goldCandles(),
      // The last 1h candle closes exactly at the anchor: one evaluated step.
      fromMs: AS_OF,
      toMs: AS_OF + HOUR,
      direction: 'long',
    });
  }

  test('the replay takes the setup only with the sequential anchor', () => {
    const withOffset = replay(goldConfig({ sweepOffset: 1 }));
    assert.equal(withOffset.stepsEvaluated, 1);
    assert.equal(withOffset.trades.length, 1);
    const trade = withOffset.trades[0]!;
    assert.equal(trade.direction, 'long');
    assert.equal(trade.signalAsOfMs, AS_OF);
    // The signal candle is the anchor 1h candle; entry is its close.
    assert.equal(trade.entryPrice, 101.9);

    const withoutOffset = replay(goldConfig({ sweepOffset: 0 }));
    assert.equal(withoutOffset.stepsEvaluated, 1);
    assert.equal(withoutOffset.trades.length, 0);
  });
});
