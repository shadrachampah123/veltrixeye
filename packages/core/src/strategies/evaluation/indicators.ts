/**
 * Deterministic evaluation primitives (M3).
 *
 * Every function in this file is PURE: same inputs ⇒ same outputs, no wall
 * clock, no database, no provider, no I/O, no hidden state. These are the
 * only market-geometry building blocks the condition handlers may use, so
 * their behavior is pinned here and unit-tested against hand-built series.
 *
 * Candle inputs are the stored `CandleDto` shape (epoch-ms open time, OHLC,
 * nullable volume). Functions are index-based: gaps (weekends, missing bars)
 * do not affect them — "lookback" means "the last N CLOSED candles", never
 * "candles within a time span".
 *
 * Pinned conventions (see docs/strategy-engine-contract.md):
 *  - ATR uses Wilder's smoothing with TRs from consecutive closes.
 *  - Swings are confirmed fractal pivots with a strict-comparison half-width
 *    of k=2 (ties are NOT pivots — keeps detection deterministic on flat data).
 *  - Level tolerance is percentage-of-level (LEVEL_TOLERANCE_PCT = 0.1%).
 *  - Sessions are fixed UTC hour windows; no exchange calendars exist in M3.
 *  - A "pip" is 0.0001, or 0.01 for JPY-quoted symbols (symbol ends "JPY").
 */

import type { CandleDto } from '@veltrixeye/contracts';

export type Candle = CandleDto;

/** Percentage-of-level tolerance used for support/resistance/zone touches. */
export const LEVEL_TOLERANCE_PCT = 0.1;

/** Fractal pivot half-width: a pivot needs k lower highs / higher lows on EACH side. */
export const PIVOT_HALF_WIDTH = 2;

/** Fixed UTC session windows, [startHour, endHour); sydney wraps midnight. */
export const SESSION_WINDOWS_UTC: Record<string, { start: number; end: number }> = {
  asia: { start: 0, end: 9 },
  london: { start: 7, end: 16 },
  new_york: { start: 12, end: 21 },
  sydney: { start: 21, end: 30 }, // 21:00–06:00 next day (end > 24 means wrap)
};

// ---------------------------------------------------------------------------
// Candle anatomy
// ---------------------------------------------------------------------------

export interface CandleAnatomy {
  range: number;
  body: number;
  upperWick: number;
  lowerWick: number;
  bullish: boolean;
  bearish: boolean;
}

/** Body/wick decomposition of one candle. Pure arithmetic, no edge cases. */
export function candleAnatomy(c: Candle): CandleAnatomy {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const top = Math.max(c.open, c.close);
  const bottom = Math.min(c.open, c.close);
  return {
    range,
    body,
    upperWick: c.high - top,
    lowerWick: bottom - c.low,
    bullish: c.close > c.open,
    bearish: c.close < c.open,
  };
}

// ---------------------------------------------------------------------------
// ATR (Wilder)
// ---------------------------------------------------------------------------

/**
 * ATR with Wilder's smoothing (PINNED).
 *
 * True range i (for i ≥ 1): max(high−low, |high−prevClose|, |low−prevClose|).
 * Seed = simple average of the first `period` TRs; then
 * ATR_i = (ATR_{i−1}·(period−1) + TR_i) / period over the remaining TRs.
 *
 * Returns null when there is not enough history: candles.length < period + 1
 * (at least `period` true ranges are required).
 */
export function atrWilder(candles: readonly Candle[], period: number): number | null {
  if (!Number.isInteger(period) || period < 2) return null;
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const c = candles[i];
    if (!prev || !c) return null; // unreachable given the length guard
    const prevClose = prev.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const seed = trs.slice(0, period);
  if (seed.length < period) return null;
  let atr = seed.reduce((sum, t) => sum + t, 0) / period;
  for (let i = period; i < trs.length; i++) {
    const t = trs[i];
    if (t === undefined) return null; // unreachable: trs.length >= period
    atr = (atr * (period - 1) + t) / period;
  }
  return atr;
}

// ---------------------------------------------------------------------------
// Swings / pivots
// ---------------------------------------------------------------------------

export interface Pivot {
  /** Index into the candle array passed to findPivots. */
  index: number;
  price: number;
  time: number;
}

/**
 * Confirmed fractal pivots (PINNED, strict comparisons).
 *
 * Candle i is a pivot high iff high[i] is strictly greater than the highs of
 * the k candles before AND after it (k = PIVOT_HALF_WIDTH); mirrors for lows.
 * Strict comparison makes flat/equal data deterministically pivot-free.
 * The last k candles can never be pivots (unconfirmed) — they need future bars.
 */
export function findPivots(
  candles: readonly Candle[],
  k: number = PIVOT_HALF_WIDTH,
): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  if (k < 1) return { highs, lows };
  for (let i = k; i < candles.length - k; i++) {
    const ci = candles[i];
    if (!ci) continue;
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      const cj = candles[j];
      if (!cj) continue;
      if (cj.high >= ci.high) isHigh = false;
      if (cj.low <= ci.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: ci.high, time: ci.time });
    if (isLow) lows.push({ index: i, price: ci.low, time: ci.time });
  }
  return { highs, lows };
}

/**
 * Structure bias from the most recent confirmed pivots (PINNED):
 * bullish iff the last two pivot highs AND last two pivot lows are both
 * ascending (HH + HL); bearish iff both descending (LH + LL); anything else
 * (including insufficient pivots) is "range".
 */
export function structureBias(
  candles: readonly Candle[],
  k: number = PIVOT_HALF_WIDTH,
): 'bullish' | 'bearish' | 'range' {
  const { highs, lows } = findPivots(candles, k);
  if (highs.length < 2 || lows.length < 2) return 'range';
  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  if (!lastHigh || !prevHigh || !lastLow || !prevLow) return 'range';
  const hh = lastHigh.price > prevHigh.price;
  const hl = lastLow.price > prevLow.price;
  const lh = lastHigh.price < prevHigh.price;
  const ll = lastLow.price < prevLow.price;
  if (hh && hl) return 'bullish';
  if (lh && ll) return 'bearish';
  return 'range';
}

/** Most recent confirmed pivot high strictly above `ref`, else null. */
export function lastPivotHighAbove(candles: readonly Candle[], ref: number, k = PIVOT_HALF_WIDTH): Pivot | null {
  const { highs } = findPivots(candles, k);
  for (let i = highs.length - 1; i >= 0; i--) {
    const h = highs[i];
    if (h && h.price > ref) return h;
  }
  return null;
}

/** Most recent confirmed pivot low strictly below `ref`, else null. */
export function lastPivotLowBelow(candles: readonly Candle[], ref: number, k = PIVOT_HALF_WIDTH): Pivot | null {
  const { lows } = findPivots(candles, k);
  for (let i = lows.length - 1; i >= 0; i--) {
    const l = lows[i];
    if (l && l.price < ref) return l;
  }
  return null;
}

/**
 * Nearest opposing swing level beyond `entry` used for structural targets:
 * for long, the LOWEST pivot high strictly above entry within the window;
 * for short, the HIGHEST pivot low strictly below entry. Null when absent.
 */
export function structuralTarget(
  candles: readonly Candle[],
  direction: 'long' | 'short',
  entry: number,
  k = PIVOT_HALF_WIDTH,
): number | null {
  const { highs, lows } = findPivots(candles, k);
  if (direction === 'long') {
    let best: number | null = null;
    for (const h of highs) {
      if (h.price > entry && (best === null || h.price < best)) best = h.price;
    }
    return best;
  }
  let bestShort: number | null = null;
  for (const l of lows) {
    if (l.price < entry && (bestShort === null || l.price > bestShort)) bestShort = l.price;
  }
  return bestShort;
}

// ---------------------------------------------------------------------------
// Simple averages
// ---------------------------------------------------------------------------

/** Arithmetic mean of the last `period` values; null when fewer exist. */
export function sma(values: readonly number[], period: number): number | null {
  if (period < 1 || values.length < period) return null;
  const window = values.slice(-period);
  return window.reduce((sum, v) => sum + v, 0) / window.length;
}

// ---------------------------------------------------------------------------
// Candle-pattern primitives
// ---------------------------------------------------------------------------

/**
 * Engulfing (PINNED): `cur`'s body fully covers `prev`'s body, both candles
 * direction-consistent (bullish engulfing: prev bearish, cur bullish), and —
 * when `minBodyRatio` is given — cur.body ≥ ratio × prev.body (a zero previous
 * body fails the ratio unless minBodyRatio is undefined, where pure
 * containment suffices).
 */
export function isEngulfing(
  prev: Candle,
  cur: Candle,
  direction: 'bullish' | 'bearish',
  minBodyRatio?: number,
): boolean {
  const p = candleAnatomy(prev);
  const c = candleAnatomy(cur);
  if (direction === 'bullish') {
    if (!p.bearish || !c.bullish) return false;
    if (!(cur.open <= prev.close && cur.close >= prev.open)) return false;
    if (minBodyRatio !== undefined) {
      if (p.body <= 0) return false;
      if (c.body < minBodyRatio * p.body) return false;
    }
    return true;
  }
  if (!p.bullish || !c.bearish) return false;
  if (!(cur.open >= prev.close && cur.close <= prev.open)) return false;
  if (minBodyRatio !== undefined) {
    if (p.body <= 0) return false;
    if (c.body < minBodyRatio * p.body) return false;
  }
  return true;
}

/**
 * Displacement (PINNED): candle body ≥ `minAtrMultiple` × `atr`, closing in
 * the given direction. `direction: 'either'` accepts either polarity.
 */
export function isDisplacement(
  candle: Candle,
  atr: number,
  minAtrMultiple: number,
  direction: 'bullish' | 'bearish' | 'either',
): boolean {
  if (!(atr > 0)) return false;
  const body = Math.abs(candle.close - candle.open);
  if (body < minAtrMultiple * atr) return false;
  if (direction === 'either') return true;
  return direction === 'bullish' ? candle.close > candle.open : candle.close < candle.open;
}

// ---------------------------------------------------------------------------
// Levels, zones and touches
// ---------------------------------------------------------------------------

/** Absolute tolerance around a level for a given tolerance-in-percent. */
export function levelTolerance(level: number, tolerancePct: number): number {
  return (Math.abs(level) * tolerancePct) / 100;
}

/**
 * Count candles whose extreme (`side`) is within tolerance of `level`.
 * Deterministic; counts every candle in the window (consecutive touches each
 * count once).
 */
export function countTouches(
  candles: readonly Candle[],
  level: number,
  side: 'high' | 'low',
  tolerancePct: number = LEVEL_TOLERANCE_PCT,
): number {
  const tol = levelTolerance(level, tolerancePct);
  let n = 0;
  for (const c of candles) {
    const v = side === 'high' ? c.high : c.low;
    if (Math.abs(v - level) <= tol) n++;
  }
  return n;
}

export interface Zone {
  bottom: number;
  top: number;
  /** Index of the candle that formed the zone's origin. */
  index: number;
  time: number;
}

/**
 * Most recent fair-value gap (PINNED 3-candle definition).
 * Bullish FVG at i (i ≥ 2): low[i] > high[i−2]; zone = [high[i−2], low[i]].
 * Bearish FVG at i: high[i] < low[i−2]; zone = [high[i], low[i−2]].
 * Scanned from the end, so the FIRST hit is the most recent gap.
 * `minGapSizePct` (gap height relative to the zone TOP, percent) filters tiny
 * gaps when provided. Returns null when no gap qualifies.
 */
export function findFvg(
  candles: readonly Candle[],
  kind: 'bullish' | 'bearish',
  minGapSizePct?: number,
): Zone | null {
  for (let i = candles.length - 1; i >= 2; i--) {
    const a = candles[i - 2];
    const c = candles[i];
    if (!a || !c) continue;
    if (kind === 'bullish') {
      if (c.low > a.high) {
        const zone: Zone = { bottom: a.high, top: c.low, index: i, time: c.time };
        if (minGapSizePct !== undefined) {
          const gapPct = zone.top > 0 ? ((zone.top - zone.bottom) / zone.top) * 100 : 0;
          if (gapPct < minGapSizePct) continue;
        }
        return zone;
      }
    } else if (c.high < a.low) {
      const zone: Zone = { bottom: c.high, top: a.low, index: i, time: c.time };
      if (minGapSizePct !== undefined) {
        const gapPct = zone.top > 0 ? ((zone.top - zone.bottom) / zone.top) * 100 : 0;
        if (gapPct < minGapSizePct) continue;
      }
      return zone;
    }
  }
  return null;
}

/**
 * Most recent order block (PINNED).
 * Bullish OB: last candle j (within `maxAgeCandles` of the end) that is
 * bearish and immediately followed by a bullish candle whose body ≥
 * BODY_MULT (1.5) × j's body and which closes above j's high. Zone = j's
 * full range [low, high]. Bearish OB mirrors. Returns the most recent match.
 */
export const ORDER_BLOCK_BODY_MULT = 1.5;

export function findOrderBlock(
  candles: readonly Candle[],
  kind: 'bullish' | 'bearish',
  maxAgeCandles: number,
): Zone | null {
  const start = Math.max(1, candles.length - maxAgeCandles);
  for (let j = candles.length - 2; j >= start; j--) {
    const origin = candles[j];
    const next = candles[j + 1];
    if (!origin || !next) continue;
    const o = candleAnatomy(origin);
    const n = candleAnatomy(next);
    if (kind === 'bullish') {
      if (o.bearish && n.bullish && next.close > origin.high && n.body >= ORDER_BLOCK_BODY_MULT * o.body) {
        return { bottom: origin.low, top: origin.high, index: j, time: origin.time };
      }
    } else if (o.bullish && n.bearish && next.close < origin.low && n.body >= ORDER_BLOCK_BODY_MULT * o.body) {
      return { bottom: origin.low, top: origin.high, index: j, time: origin.time };
    }
  }
  return null;
}

/** True when any candle AFTER `zone.index` traded into the zone. */
export function zoneWasRetracedInto(candles: readonly Candle[], zone: Zone): boolean {
  for (let i = zone.index + 2; i < candles.length; i++) {
    const c = candles[i];
    if (c && c.low <= zone.top && c.high >= zone.bottom) return true;
  }
  return false;
}

/** True when any candle AFTER the origin closed beyond the zone in `direction`. */
export function zoneWasBroken(candles: readonly Candle[], zone: Zone, direction: 'up' | 'down'): boolean {
  for (let i = zone.index + 2; i < candles.length; i++) {
    const c = candles[i];
    if (c && (direction === 'up' ? c.close > zone.top : c.close < zone.bottom)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sessions (UTC)
// ---------------------------------------------------------------------------

/**
 * Is hour-of-day `hour` (0–23, UTC) inside the pinned session window?
 * Windows wrap midnight when end > 24 (sydney: 21:00–06:00).
 */
export function hourInSession(hour: number, session: string): boolean {
  const w = SESSION_WINDOWS_UTC[session];
  if (!w) return false;
  const h = ((hour % 24) + 24) % 24;
  if (w.end <= 24) return h >= w.start && h < w.end;
  return h >= w.start || h < w.end - 24;
}

/** Session membership of an epoch-ms timestamp, by its UTC open hour. */
export function timeInSession(timeMs: number, session: string): boolean {
  const hour = Math.floor((((timeMs % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000);
  return hourInSession(hour, session);
}

// ---------------------------------------------------------------------------
// Pip / buffer math
// ---------------------------------------------------------------------------

/** Pinned pip size: 0.01 for JPY-quoted symbols, 0.0001 otherwise. */
export function pipSizeFor(symbol: string): number {
  return symbol.toUpperCase().endsWith('JPY') ? 0.01 : 0.0001;
}

/**
 * Convert a risk-config buffer to price units.
 * pips → buffer × pipSize(symbol); pct → buffer/100 × entryPrice.
 */
export function bufferToPrice(
  buffer: number,
  unit: 'pips' | 'pct',
  entryPrice: number,
  symbol: string,
): number {
  if (unit === 'pct') return (buffer / 100) * entryPrice;
  return buffer * pipSizeFor(symbol);
}
