import { getConditionType } from '@veltrixeye/contracts';
import type {
  CandidateLevels,
  ConditionOutcome,
  EvaluationCandleSet,
  EvaluationOutcomeStatus,
} from '@veltrixeye/contracts';
import type { RiskConfiguration } from '@veltrixeye/contracts';
import {
  atrWilder,
  candleAnatomy,
  countTouches,
  findFvg,
  findOrderBlock,
  isDisplacement,
  isEngulfing,
  lastPivotHighAbove,
  lastPivotLowBelow,
  levelTolerance,
  sma,
  structureBias,
  findPivots,
  timeInSession,
  LEVEL_TOLERANCE_PCT,
  PIVOT_HALF_WIDTH,
  type Candle,
} from './indicators.js';

/**
 * Condition handlers (M3) — one deterministic handler per entry in
 * `CONDITION_TYPE_REGISTRY`. Handlers are pure: `(closed candles, params,
 * direction, risk, candidate, asOfMs) → outcome`. No I/O, no wall clock,
 * no persistence, no provider access.
 *
 * Pinned semantics (docs/strategy-engine-contract.md, "M3 semantics"):
 *  - Handlers receive ONLY closed candles (ts + period ≤ asOfMs), ascending.
 *  - `timeframeRole: 'any'` evaluates against the SETUP role's candles,
 *    except `htf_alignment`, which uses the HTF role's candles.
 *  - The engine calls every handler once per direction (long, short);
 *    direction-sensitive conditions evaluate each side independently and
 *    `direction: 'either'` params satisfy both.
 *  - Not enough history ⇒ `insufficient_data`; no data source or no handler
 *    ⇒ `unsupported`. Both fail CLOSED: a required/confirmation condition in
 *    either state blocks the direction, and so does a disqualifying one
 *    (a veto that cannot be ruled out still vetoes).
 *  - `news_filter` and `spread_filter` have NO platform data source in M3:
 *    they always return `insufficient_data` and can never pass.
 *  - Context conditions are directional by construction: support/demand are
 *    long-context, resistance/supply are short-context, liquidity sweeps of
 *    highs are short-context / of lows long-context, bullish zones
 *    (order_block/fvg kind) are long-context.
 */

export interface HandlerContext {
  /** Closed, time-ascending candles per role. */
  candles: EvaluationCandleSet;
  timeframeRole: 'htf_bias' | 'setup' | 'entry' | 'any';
  /** Params already re-validated against the registry schema by the engine. */
  params: Record<string, unknown>;
  direction: 'long' | 'short';
  risk: RiskConfiguration;
  /** Evaluation anchor (epoch-ms). Available for reference; handlers never call the clock. */
  asOfMs: number;
  /** Engine-derived candidate entry/stop/targets for this instrument+anchor. */
  candidate: CandidateLevels | null;
}

export interface HandlerResult {
  status: EvaluationOutcomeStatus;
  detail: string;
}

export type ConditionHandler = (ctx: HandlerContext) => HandlerResult;

const ok = (detail: string): HandlerResult => ({ status: 'satisfied', detail });
const no = (detail: string): HandlerResult => ({ status: 'unsatisfied', detail });
const insufficient = (detail: string): HandlerResult => ({ status: 'insufficient_data', detail });
const unsupported = (detail: string): HandlerResult => ({ status: 'unsupported', detail });

/** Minimum candles for any pattern evaluation (pivots with k=2 need ≥5). */
const MIN_CANDLES = 5;
/** Window (candles) used by zone handlers that do not declare a lookback param. */
const ZONE_WINDOW = 200;
/** Window used by supply/demand (pinned; no lookback param in the schema). */
const SD_WINDOW = 300;
/** Displacement threshold reused by CHoCH's requireDisplacement (pinned). */
const DISPLACEMENT_ATR_MULT = 1.5;

function roleCandles(ctx: HandlerContext, preferHtf = false): Candle[] {
  if (ctx.timeframeRole === 'any') {
    return preferHtf ? ctx.candles.htf_bias : ctx.candles.setup;
  }
  return ctx.candles[ctx.timeframeRole];
}

/** Last candle or undefined (callers guard before use). */
function lastOf(candles: readonly Candle[]): Candle | undefined {
  return candles[candles.length - 1];
}

/** Does a bullish|bearish|either param match the evaluated direction? */
function dirMatches(param: 'bullish' | 'bearish' | 'either', direction: 'long' | 'short'): boolean {
  if (param === 'either') return true;
  return param === 'bullish' ? direction === 'long' : direction === 'short';
}

function fmt(n: number): string {
  return String(Number(n.toFixed(10)));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Liquidity sweep: wick through the window's opposing extreme, close back inside. */
const liquiditySweep: ConditionHandler = (ctx) => {
  const p = ctx.params as { side: 'above' | 'below'; lookbackCandles: number; minWickRatio: number };
  // side 'above' sweeps highs ⇒ short context; 'below' sweeps lows ⇒ long context.
  const wanted: 'long' | 'short' = p.side === 'above' ? 'short' : 'long';
  if (ctx.direction !== wanted) {
    return no(`sweep ${p.side} is a ${wanted}-context condition`);
  }
  const candles = roleCandles(ctx);
  if (candles.length < MIN_CANDLES + 1) return insufficient(`need at least ${MIN_CANDLES + 1} closed candles, have ${candles.length}`);
  const window = candles.slice(-p.lookbackCandles);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  const ref = window.slice(0, -1);
  const a = candleAnatomy(anchor);
  if (a.range <= 0) return no('anchor candle has no range');
  if (p.side === 'above') {
    const refHigh = Math.max(...ref.map((c) => c.high));
    const swept = anchor.high > refHigh && anchor.close < refHigh;
    const wickOk = a.upperWick / a.range >= p.minWickRatio;
    return swept && wickOk
      ? ok(`swept high ${fmt(refHigh)} (anchor high ${fmt(anchor.high)}, closed ${fmt(anchor.close)}, wick ${(a.upperWick / a.range).toFixed(3)})`)
      : no(`no sweep above ${fmt(refHigh)} (swept=${swept}, wickRatio=${(a.upperWick / a.range).toFixed(3)} < ${p.minWickRatio}?)`);
  }
  const refLow = Math.min(...ref.map((c) => c.low));
  const swept = anchor.low < refLow && anchor.close > refLow;
  const wickOk = a.lowerWick / a.range >= p.minWickRatio;
  return swept && wickOk
    ? ok(`swept low ${fmt(refLow)} (anchor low ${fmt(anchor.low)}, closed ${fmt(anchor.close)}, wick ${(a.lowerWick / a.range).toFixed(3)})`)
    : no(`no sweep below ${fmt(refLow)} (swept=${swept}, wickRatio=${(a.lowerWick / a.range).toFixed(3)} < ${p.minWickRatio}?)`);
};

/** Shared pivot-event evaluation for choch/bos. */
function pivotBreakEvent(
  ctx: HandlerContext,
  kind: 'choch' | 'bos',
): HandlerResult {
  const p = ctx.params as { direction: 'bullish' | 'bearish' | 'either'; lookbackCandles: number; requireDisplacement?: boolean };
  const candles = roleCandles(ctx);
  if (candles.length < MIN_CANDLES + 1) return insufficient(`need at least ${MIN_CANDLES + 1} closed candles, have ${candles.length}`);
  const window = candles.slice(-p.lookbackCandles);
  const bias = structureBias(window);
  if (bias === 'range') return insufficient('structure bias is not established (need two comparable swing highs and lows)');
  const { highs, lows } = findPivots(window, PIVOT_HALF_WIDTH);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  let bullishEvent: boolean;
  let bearishEvent: boolean;
  let level: number;
  if (kind === 'choch') {
    // CHoCH: structure flips against the prevailing bias.
    bullishEvent = bias === 'bearish' && lastHigh !== undefined && anchor.close > lastHigh.price;
    bearishEvent = bias === 'bullish' && lastLow !== undefined && anchor.close < lastLow.price;
    level = bullishEvent && lastHigh ? lastHigh.price : bearishEvent && lastLow ? lastLow.price : NaN;
  } else {
    // BOS: continuation — close beyond the last swing in the bias direction.
    bullishEvent = bias === 'bullish' && lastHigh !== undefined && anchor.close > lastHigh.price;
    bearishEvent = bias === 'bearish' && lastLow !== undefined && anchor.close < lastLow.price;
    level = bullishEvent && lastHigh ? lastHigh.price : bearishEvent && lastLow ? lastLow.price : NaN;
  }
  if (p.requireDisplacement && (bullishEvent || bearishEvent)) {
    const atr = atrWilder(window, 14);
    if (atr === null) return insufficient('displacement check needs 15+ closed candles for ATR(14)');
    const displaced =
      isDisplacement(anchor, atr, DISPLACEMENT_ATR_MULT, bullishEvent ? 'bullish' : 'bearish');
    if (!displaced) {
      return no(`structure break occurred without displacement (body < ${DISPLACEMENT_ATR_MULT} × ATR)`);
    }
  }
  const eventForDirection = ctx.direction === 'long' ? bullishEvent : bearishEvent;
  const paramOk = dirMatches(p.direction, ctx.direction);
  if (eventForDirection && paramOk) {
    const label = kind === 'choch' ? 'CHoCH' : 'BOS';
    return ok(`${label} ${ctx.direction} confirmed through ${fmt(level)} (close ${fmt(anchor.close)})`);
  }
  if (!eventForDirection) {
    return no(`no ${kind === 'choch' ? 'CHoCH' : 'BOS'} for ${ctx.direction} (bias ${bias}, close ${fmt(anchor.close)})`);
  }
  return no(`${kind} occurred but its direction does not match param "${p.direction}"`);
}

const choch: ConditionHandler = (ctx) => pivotBreakEvent(ctx, 'choch');
const bos: ConditionHandler = (ctx) => pivotBreakEvent(ctx, 'bos');

/** Break & retest: a pivot level was closed through, retested, and held. */
const breakRetest: ConditionHandler = (ctx) => {
  const p = ctx.params as { direction: 'bullish' | 'bearish' | 'either'; maxRetestCandles: number; retestTolerancePct: number };
  if (!dirMatches(p.direction, ctx.direction)) {
    return no(`break_retest direction "${p.direction}" does not include ${ctx.direction}`);
  }
  const candles = roleCandles(ctx);
  const windowSize = p.maxRetestCandles + 40;
  if (candles.length < MIN_CANDLES + 2) return insufficient(`need at least ${MIN_CANDLES + 2} closed candles, have ${candles.length}`);
  const window = candles.slice(-windowSize);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  const tolOf = (level: number) => levelTolerance(level, p.retestTolerancePct);

  if (ctx.direction === 'long') {
    const { highs } = findPivots(window, PIVOT_HALF_WIDTH);
    for (let i = highs.length - 1; i >= 0; i--) {
      const pivot = highs[i];
      if (!pivot) continue;
      const level = pivot.price;
      if (level >= anchor.close) continue; // must have been broken (and hold) below anchor close
      let breakIdx = -1;
      for (let b = pivot.index + 1; b < window.length; b++) {
        const cb = window[b];
        if (cb && cb.close > level) {
          breakIdx = b;
          break;
        }
      }
      if (breakIdx === -1) continue;
      const tol = tolOf(level);
      const retestEnd = Math.min(window.length - 1, breakIdx + p.maxRetestCandles);
      for (let r = breakIdx + 1; r <= retestEnd; r++) {
        const cr = window[r];
        if (cr && cr.low <= level + tol && cr.close > level) {
          return ok(`broke and retested pivot high ${fmt(level)} (close ${fmt(anchor.close)}, tolerance ${p.retestTolerancePct}%)`);
        }
      }
      return no(`pivot high ${fmt(level)} was broken but not retested within ${p.maxRetestCandles} candles`);
    }
    return no('no broken pivot high available for a long break&retest');
  }
  const { lows } = findPivots(window, PIVOT_HALF_WIDTH);
  for (let i = lows.length - 1; i >= 0; i--) {
    const pivot = lows[i];
    if (!pivot) continue;
    const level = pivot.price;
    if (level <= anchor.close) continue;
    let breakIdx = -1;
    for (let b = pivot.index + 1; b < window.length; b++) {
      const cb = window[b];
      if (cb && cb.close < level) {
        breakIdx = b;
        break;
      }
    }
    if (breakIdx === -1) continue;
    const tol = tolOf(level);
    const retestEnd = Math.min(window.length - 1, breakIdx + p.maxRetestCandles);
    for (let r = breakIdx + 1; r <= retestEnd; r++) {
      const cr = window[r];
      if (cr && cr.high >= level - tol && cr.close < level) {
        return ok(`broke and retested pivot low ${fmt(level)} (close ${fmt(anchor.close)}, tolerance ${p.retestTolerancePct}%)`);
      }
    }
    return no(`pivot low ${fmt(level)} was broken but not retested within ${p.maxRetestCandles} candles`);
  }
  return no('no broken pivot low available for a short break&retest');
};

/** Order block: last opposing candle before a displacement; mitigation or break. */
const orderBlock: ConditionHandler = (ctx) => {
  const p = ctx.params as { kind: 'bullish' | 'bearish'; validation: 'mitigation' | 'break'; maxAgeCandles: number };
  const wanted: 'long' | 'short' = p.kind === 'bullish' ? 'long' : 'short';
  if (ctx.direction !== wanted) return no(`order_block kind "${p.kind}" is a ${wanted}-context condition`);
  const candles = roleCandles(ctx);
  if (candles.length < MIN_CANDLES) return insufficient(`need at least ${MIN_CANDLES} closed candles, have ${candles.length}`);
  const window = candles.slice(-p.maxAgeCandles);
  const zone = findOrderBlock(window, p.kind, p.maxAgeCandles);
  if (!zone) return no(`no ${p.kind} order block within the last ${p.maxAgeCandles} candles`);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  if (p.validation === 'mitigation') {
    const retraced = window.slice(zone.index + 2).some((c) => c.low <= zone.top && c.high >= zone.bottom);
    const holding = p.kind === 'bullish' ? anchor.close > zone.top : anchor.close < zone.bottom;
    return retraced && holding
      ? ok(`${p.kind} OB ${fmt(zone.bottom)}–${fmt(zone.top)} was mitigated and price holds ${p.kind === 'bullish' ? 'above' : 'below'} it (close ${fmt(anchor.close)})`)
      : no(`OB ${fmt(zone.bottom)}–${fmt(zone.top)}: mitigated=${retraced}, holding=${holding}`);
  }
  const broken = window
    .slice(zone.index + 2)
    .some((c) => (p.kind === 'bullish' ? c.close > zone.top : c.close < zone.bottom));
  return broken
    ? ok(`${p.kind} OB ${fmt(zone.bottom)}–${fmt(zone.top)} was broken in its direction`)
    : no(`OB ${fmt(zone.bottom)}–${fmt(zone.top)} has not been broken`);
};

/** Fair value gap: unfilled three-candle imbalance price returned to. */
const fvg: ConditionHandler = (ctx) => {
  const p = ctx.params as { kind: 'bullish' | 'bearish'; minGapSizePct?: number; requireMitigation: boolean };
  const wanted: 'long' | 'short' = p.kind === 'bullish' ? 'long' : 'short';
  if (ctx.direction !== wanted) return no(`fvg kind "${p.kind}" is a ${wanted}-context condition`);
  const candles = roleCandles(ctx);
  if (candles.length < 3) return insufficient(`need at least 3 closed candles, have ${candles.length}`);
  const window = candles.slice(-ZONE_WINDOW);
  const zone = findFvg(window, p.kind, p.minGapSizePct);
  if (!zone) return no(`no ${p.kind} FVG${p.minGapSizePct !== undefined ? ` ≥ ${p.minGapSizePct}%` : ''} in the last ${ZONE_WINDOW} candles`);
  const mitigated = window.slice(zone.index + 1).some((c) => c.low <= zone.top && c.high >= zone.bottom);
  if (p.requireMitigation && !mitigated) return no(`FVG ${fmt(zone.bottom)}–${fmt(zone.top)} formed but was never revisited`);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  const onSide = p.kind === 'bullish' ? anchor.close > zone.bottom : anchor.close < zone.top;
  return onSide
    ? ok(`${p.kind} FVG ${fmt(zone.bottom)}–${fmt(zone.top)} present${mitigated ? ' (mitigated)' : ' (unmitigated)'}, price closes on the valid side`)
    : no(`FVG ${fmt(zone.bottom)}–${fmt(zone.top)} present but price closed through it`);
};

/** Support: prior accumulation low tested ≥ minTouches times and currently holding. */
const support: ConditionHandler = (ctx) => {
  if (ctx.direction !== 'long') return no('support is a long-context condition');
  const p = ctx.params as { minTouches: number; lookbackCandles: number };
  const candles = roleCandles(ctx);
  if (candles.length < MIN_CANDLES + 5) return insufficient(`need at least ${MIN_CANDLES + 5} closed candles, have ${candles.length}`);
  const window = candles.slice(-p.lookbackCandles);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  const level = Math.min(...window.map((c) => c.low));
  const tol = levelTolerance(level, LEVEL_TOLERANCE_PCT);
  const touches = countTouches(window, level, 'low');
  const testedNow = anchor.low <= level + tol;
  const held = anchor.close > level;
  return touches >= p.minTouches && testedNow && held
    ? ok(`support ${fmt(level)} held (${touches} touches ≥ ${p.minTouches}, close ${fmt(anchor.close)})`)
    : no(`support ${fmt(level)}: touches=${touches}/${p.minTouches}, testedNow=${testedNow}, held=${held}`);
};

/** Resistance: prior distribution high tested ≥ minTouches times and currently rejecting. */
const resistance: ConditionHandler = (ctx) => {
  if (ctx.direction !== 'short') return no('resistance is a short-context condition');
  const p = ctx.params as { minTouches: number; lookbackCandles: number };
  const candles = roleCandles(ctx);
  if (candles.length < MIN_CANDLES + 5) return insufficient(`need at least ${MIN_CANDLES + 5} closed candles, have ${candles.length}`);
  const window = candles.slice(-p.lookbackCandles);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  const level = Math.max(...window.map((c) => c.high));
  const tol = levelTolerance(level, LEVEL_TOLERANCE_PCT);
  const touches = countTouches(window, level, 'high');
  const testedNow = anchor.high >= level - tol;
  const held = anchor.close < level;
  return touches >= p.minTouches && testedNow && held
    ? ok(`resistance ${fmt(level)} rejected (${touches} touches ≥ ${p.minTouches}, close ${fmt(anchor.close)})`)
    : no(`resistance ${fmt(level)}: touches=${touches}/${p.minTouches}, testedNow=${testedNow}, held=${held}`);
};

/** Supply zone (short-context) located from swing highs, bearish OBs or consolidation. */
const supply: ConditionHandler = (ctx) => {
  if (ctx.direction !== 'short') return no('supply is a short-context condition');
  const p = ctx.params as { source: 'swing_high' | 'order_block' | 'consolidation'; minTouches: number };
  const candles = roleCandles(ctx);
  if (candles.length < MIN_CANDLES + 5) return insufficient(`need at least ${MIN_CANDLES + 5} closed candles, have ${candles.length}`);
  const window = candles.slice(-SD_WINDOW);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  if (p.source === 'swing_high') {
    const level = lastPivotHighAbove(window, anchor.close, PIVOT_HALF_WIDTH);
    if (!level) return no('no overhead swing high above the current close');
    const tol = levelTolerance(level.price, LEVEL_TOLERANCE_PCT);
    const touches = countTouches(window, level.price, 'high');
    const testedNow = anchor.high >= level.price - tol;
    const below = anchor.close < level.price;
    return touches >= p.minTouches && testedNow && below
      ? ok(`supply at swing high ${fmt(level.price)} revisited (${touches} touches ≥ ${p.minTouches})`)
      : no(`supply ${fmt(level.price)}: touches=${touches}/${p.minTouches}, testedNow=${testedNow}, below=${below}`);
  }
  if (p.source === 'order_block') {
    const zone = findOrderBlock(window, 'bearish', SD_WINDOW);
    if (!zone || zone.top <= anchor.close) return no('no bearish order block overhead');
    const testedNow = anchor.high >= zone.bottom;
    return testedNow
      ? ok(`supply from bearish OB ${fmt(zone.bottom)}–${fmt(zone.top)} revisited`)
      : no(`bearish OB ${fmt(zone.bottom)}–${fmt(zone.top)} not yet revisited`);
  }
  // consolidation: most recent run of ≥3 low-range candles above the close
  const atr = atrWilder(window.slice(-50), 14);
  if (atr === null) return insufficient('consolidation detection needs 15+ closed candles for ATR(14)');
  let run: Candle[] = [];
  const runs: { bottom: number; top: number; end: number }[] = [];
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (!c) continue;
    if (candleAnatomy(c).range <= 0.5 * atr) {
      run.push(c);
    } else {
      if (run.length >= 3) {
        runs.push({ bottom: Math.min(...run.map((x) => x.low)), top: Math.max(...run.map((x) => x.high)), end: i - 1 });
      }
      run = [];
    }
  }
  if (run.length >= 3) {
    runs.push({ bottom: Math.min(...run.map((x) => x.low)), top: Math.max(...run.map((x) => x.high)), end: window.length - 1 });
  }
  const overhead = runs.filter((r) => r.bottom > anchor.close).pop();
  if (!overhead) return no('no consolidation zone overhead');
  const testedNow = anchor.high >= overhead.bottom;
  return testedNow
    ? ok(`supply from consolidation ${fmt(overhead.bottom)}–${fmt(overhead.top)} revisited`)
    : no(`consolidation ${fmt(overhead.bottom)}–${fmt(overhead.top)} not yet revisited`);
};

/** Demand zone (long-context) — mirror of supply. */
const demand: ConditionHandler = (ctx) => {
  if (ctx.direction !== 'long') return no('demand is a long-context condition');
  const p = ctx.params as { source: 'swing_low' | 'order_block' | 'consolidation'; minTouches: number };
  const candles = roleCandles(ctx);
  if (candles.length < MIN_CANDLES + 5) return insufficient(`need at least ${MIN_CANDLES + 5} closed candles, have ${candles.length}`);
  const window = candles.slice(-SD_WINDOW);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  if (p.source === 'swing_low') {
    const level = lastPivotLowBelow(window, anchor.close, PIVOT_HALF_WIDTH);
    if (!level) return no('no underlying swing low below the current close');
    const tol = levelTolerance(level.price, LEVEL_TOLERANCE_PCT);
    const touches = countTouches(window, level.price, 'low');
    const testedNow = anchor.low <= level.price + tol;
    const above = anchor.close > level.price;
    return touches >= p.minTouches && testedNow && above
      ? ok(`demand at swing low ${fmt(level.price)} revisited (${touches} touches ≥ ${p.minTouches})`)
      : no(`demand ${fmt(level.price)}: touches=${touches}/${p.minTouches}, testedNow=${testedNow}, above=${above}`);
  }
  if (p.source === 'order_block') {
    const zone = findOrderBlock(window, 'bullish', SD_WINDOW);
    if (!zone || zone.bottom >= anchor.close) return no('no bullish order block underneath');
    const testedNow = anchor.low <= zone.top;
    return testedNow
      ? ok(`demand from bullish OB ${fmt(zone.bottom)}–${fmt(zone.top)} revisited`)
      : no(`bullish OB ${fmt(zone.bottom)}–${fmt(zone.top)} not yet revisited`);
  }
  const atr = atrWilder(window.slice(-50), 14);
  if (atr === null) return insufficient('consolidation detection needs 15+ closed candles for ATR(14)');
  let run: Candle[] = [];
  const runs: { bottom: number; top: number }[] = [];
  for (const c of window) {
    if (candleAnatomy(c).range <= 0.5 * atr) {
      run.push(c);
    } else {
      if (run.length >= 3) {
        runs.push({ bottom: Math.min(...run.map((x) => x.low)), top: Math.max(...run.map((x) => x.high)) });
      }
      run = [];
    }
  }
  if (run.length >= 3) {
    runs.push({ bottom: Math.min(...run.map((x) => x.low)), top: Math.max(...run.map((x) => x.high)) });
  }
  const underneath = runs.filter((r) => r.top < anchor.close).pop();
  if (!underneath) return no('no consolidation zone underneath');
  const testedNow = anchor.low <= underneath.top;
  return testedNow
    ? ok(`demand from consolidation ${fmt(underneath.bottom)}–${fmt(underneath.top)} revisited`)
    : no(`consolidation ${fmt(underneath.bottom)}–${fmt(underneath.top)} not yet revisited`);
};

/** Rejection candle (pin bar): dominant wick on the current anchor candle. */
const rejectionCandle: ConditionHandler = (ctx) => {
  const p = ctx.params as { direction: 'bullish' | 'bearish'; minWickBodyRatio: number };
  const candles = roleCandles(ctx);
  if (candles.length < 1) return insufficient('no closed candles at the anchor');
  const anchor = candles[candles.length - 1];
  if (!anchor) return insufficient('no closed candles at the anchor');
  const a = candleAnatomy(anchor);
  const denom = Math.max(a.body, a.range * 1e-9);
  const isBullishParam = p.direction === 'bullish';
  const matchesDirection = isBullishParam === (ctx.direction === 'long');
  if (!matchesDirection) return no(`rejection ${p.direction} does not apply to ${ctx.direction}`);
  const ratio = (isBullishParam ? a.lowerWick : a.upperWick) / denom;
  return ratio >= p.minWickBodyRatio
    ? ok(`${p.direction} rejection wick ratio ${ratio.toFixed(3)} ≥ ${p.minWickBodyRatio}`)
    : no(`${p.direction} wick ratio ${ratio.toFixed(3)} < ${p.minWickBodyRatio}`);
};

/** Engulfing candle on the anchor vs the previous candle. */
const engulfingCandle: ConditionHandler = (ctx) => {
  const p = ctx.params as { direction: 'bullish' | 'bearish' | 'either'; minBodyRatio?: number };
  const candles = roleCandles(ctx);
  if (candles.length < 2) return insufficient(`need at least 2 closed candles, have ${candles.length}`);
  const prev = candles[candles.length - 2];
  const anchor = candles[candles.length - 1];
  if (!anchor) return insufficient('no closed candles at the anchor');
  if (!prev || !anchor) return insufficient('no closed candles at the anchor');
  const bullish = isEngulfing(prev, anchor, 'bullish', p.minBodyRatio);
  const bearish = isEngulfing(prev, anchor, 'bearish', p.minBodyRatio);
  const event = ctx.direction === 'long' ? bullish : bearish;
  const paramOk = dirMatches(p.direction, ctx.direction);
  return event && paramOk
    ? ok(`${ctx.direction} engulfing at anchor (body ${fmt(candleAnatomy(anchor).body)})`)
    : no(`no ${ctx.direction} engulfing${p.minBodyRatio !== undefined ? ` with body ratio ≥ ${p.minBodyRatio}` : ''}`);
};

/** Displacement: anchor body ≥ minAtrMultiple × ATR(atrPeriod) in the direction. */
const displacement: ConditionHandler = (ctx) => {
  const p = ctx.params as { direction: 'bullish' | 'bearish' | 'either'; atrPeriod: number; minAtrMultiple: number };
  const candles = roleCandles(ctx);
  const atr = atrWilder(candles, p.atrPeriod);
  if (atr === null) return insufficient(`ATR(${p.atrPeriod}) needs ${p.atrPeriod + 1}+ closed candles, have ${candles.length}`);
  const anchor = candles[candles.length - 1];
  if (!anchor) return insufficient('no closed candles at the anchor');
  const body = Math.abs(anchor.close - anchor.open);
  const event = isDisplacement(anchor, atr, p.minAtrMultiple, p.direction);
  const paramOk = dirMatches(p.direction, ctx.direction);
  return event && paramOk
    ? ok(`displacement ${ctx.direction}: body ${fmt(body)} ≥ ${p.minAtrMultiple} × ATR ${fmt(atr)}`)
    : no(`body ${fmt(body)} < ${p.minAtrMultiple} × ATR ${fmt(atr)}${p.direction !== 'either' ? ` or wrong polarity for ${p.direction}` : ''}`);
};

/**
 * R:R requirement — evaluated against the engine's deterministic candidate
 * levels (derived from the version's risk config at the anchor).
 */
const rrRequirement: ConditionHandler = (ctx) => {
  const p = ctx.params as { minRr: number };
  if (!ctx.candidate) {
    return insufficient('no deterministic candidate entry/stop could be derived at the anchor');
  }
  const c = ctx.candidate;
  if (ctx.risk.takeProfitMethod === 'rr') {
    const offered = ctx.risk.tp3Rr;
    return offered >= p.minRr
      ? ok(`rr method offers final target ${offered}R ≥ ${p.minRr}R (risk distance ${fmt(c.riskDistance)})`)
      : no(`rr method final target ${offered}R < ${p.minRr}R`);
  }
  if (ctx.risk.takeProfitMethod === 'structure') {
    if (c.achievableRr === null) return insufficient('no structural target within the setup window to measure R:R against');
    return c.achievableRr >= p.minRr
      ? ok(`structural target offers ${c.achievableRr.toFixed(3)}R ≥ ${p.minRr}R`)
      : no(`structural target offers ${c.achievableRr.toFixed(3)}R < ${p.minRr}R`);
  }
  return unsupported('takeProfitMethod "manual" has no levels in the version model — use "rr" or "structure"');
};

/** Session requirement — pinned UTC windows; exchange calendars do not exist in M3. */
const sessionRequirement: ConditionHandler = (ctx) => {
  const p = ctx.params as { sessions: ('asia' | 'london' | 'new_york' | 'sydney')[]; mode: 'include' | 'exclude'; timezone: 'utc' | 'exchange' };
  if (p.timezone === 'exchange') {
    return unsupported('timezone "exchange" needs an exchange calendar the platform does not have — set timezone "utc"');
  }
  const candles = roleCandles(ctx);
  if (candles.length < 1) return insufficient('no closed candles at the anchor');
  const anchor = candles[candles.length - 1];
  if (!anchor) return insufficient('no closed candles at the anchor');
  const inAny = p.sessions.some((s) => timeInSession(anchor.time, s));
  const satisfied = p.mode === 'include' ? inAny : !inAny;
  const hour = new Date(anchor.time).toISOString().slice(11, 13);
  return satisfied
    ? ok(`anchor candle ${anchor.time} (UTC ${hour}:00) is ${p.mode === 'include' ? 'inside' : 'outside'} [${p.sessions.join(', ')}]`)
    : no(`anchor candle ${anchor.time} (UTC ${hour}:00) is not ${p.mode === 'include' ? 'inside' : 'outside'} [${p.sessions.join(', ')}]`);
};

/** News filter — NO data source in M3: fails closed, never passes. */
const newsFilter: ConditionHandler = () =>
  insufficient('no news-calendar data source is connected — news_filter cannot be evaluated and fails closed');

/** Spread filter — NO data source in M3: fails closed, never passes. */
const spreadFilter: ConditionHandler = () =>
  insufficient('no spread feed is connected — spread_filter cannot be evaluated and fails closed');

/** Volatility band over ATR or mean body range. */
const volatilityFilter: ConditionHandler = (ctx) => {
  const p = ctx.params as { metric: 'atr' | 'body_range'; period: number; min: number; max?: number };
  const candles = roleCandles(ctx);
  let value: number | null;
  if (p.metric === 'atr') {
    value = atrWilder(candles, p.period);
    if (value === null) return insufficient(`ATR(${p.period}) needs ${p.period + 1}+ closed candles, have ${candles.length}`);
  } else {
    if (candles.length < p.period) return insufficient(`need ${p.period} closed candles for body_range, have ${candles.length}`);
    const slice = candles.slice(-p.period);
    value = slice.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / slice.length;
  }
  const within = value >= p.min && (p.max === undefined || value <= p.max);
  return within
    ? ok(`${p.metric} ${fmt(value)} within [${fmt(p.min)}, ${p.max === undefined ? '∞' : fmt(p.max)}]`)
    : no(`${p.metric} ${fmt(value)} outside [${fmt(p.min)}, ${p.max === undefined ? '∞' : fmt(p.max)}]`);
};

/** HTF alignment: higher-timeframe structure or trend agrees with the direction. */
const htfAlignment: ConditionHandler = (ctx) => {
  const p = ctx.params as { direction: 'bullish' | 'bearish' | 'either'; source: 'trend' | 'structure' | 'bias' };
  if (!dirMatches(p.direction, ctx.direction)) {
    return no(`htf_alignment direction "${p.direction}" does not include ${ctx.direction}`);
  }
  // role 'any' means "the strategy's higher timeframe" for this type.
  const candles = ctx.timeframeRole === 'any' ? ctx.candles.htf_bias : roleCandles(ctx);
  const window = candles.slice(-100);
  const anchor = lastOf(window);
  if (!anchor) return insufficient('no closed candles at the anchor');
  if (!anchor) return insufficient('no closed HTF candles at the anchor');
  if (p.source === 'trend') {
    const mean = sma(window.map((c) => c.close), 20);
    if (mean === null) return insufficient(`trend source needs 20+ closed HTF candles, have ${window.length}`);
    const aligned = ctx.direction === 'long' ? anchor.close > mean : anchor.close < mean;
    return aligned
      ? ok(`HTF close ${fmt(anchor.close)} is ${ctx.direction === 'long' ? 'above' : 'below'} SMA20 ${fmt(mean)}`)
      : no(`HTF close ${fmt(anchor.close)} is not ${ctx.direction === 'long' ? 'above' : 'below'} SMA20 ${fmt(mean)}`);
  }
  const bias = structureBias(window);
  if (bias === 'range') return insufficient('HTF structure bias is not established (need two comparable swing highs and lows)');
  const aligned = ctx.direction === 'long' ? bias === 'bullish' : bias === 'bearish';
  return aligned
    ? ok(`HTF structure bias ${bias} aligns with ${ctx.direction}`)
    : no(`HTF structure bias ${bias} does not align with ${ctx.direction}`);
};

/**
 * The handler registry — keyed exactly by `CONDITION_TYPE_REGISTRY` keys.
 * `news_filter` and `spread_filter` are intentionally fail-closed.
 */
export const CONDITION_HANDLERS: Readonly<Record<string, ConditionHandler>> = {
  liquidity_sweep: liquiditySweep,
  choch,
  bos,
  break_retest: breakRetest,
  order_block: orderBlock,
  fvg,
  support,
  resistance,
  supply,
  demand,
  rejection_candle: rejectionCandle,
  engulfing_candle: engulfingCandle,
  displacement,
  rr_requirement: rrRequirement,
  session_requirement: sessionRequirement,
  news_filter: newsFilter,
  volatility_filter: volatilityFilter,
  spread_filter: spreadFilter,
  htf_alignment: htfAlignment,
};

/** Re-exported for the engine's outcome construction. */
export type { ConditionOutcome };

/**
 * Defensive param validation used by the engine before dispatch: params were
 * baked at write time, but a stored config is still re-validated here so a
 * corrupted row can never crash the engine (it degrades to `unsupported`).
 * Returns the parsed params or null.
 */
export function parseParams(conditionType: string, params: Record<string, unknown>): Record<string, unknown> | null {
  const def = getConditionType(conditionType);
  if (!def) return null;
  const parsed = def.paramSchema.safeParse(params);
  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}
