import { STALE_THRESHOLDS_MS, type Timeframe } from '@veltrixeye/contracts';
import { timeframeMinutes } from '@veltrixeye/contracts';

/**
 * Data freshness & integrity (M7.5).
 *
 * Production-safe validation for stale market data.
 * Never generates a trading alert from invalid or stale market data.
 */

export interface FreshnessCheckInput {
  candles: { time: number }[];
  timeframe: Timeframe;
  nowMs: number;
}

export interface FreshnessResult {
  fresh: boolean;
  reason?: string;
  ageMs: number;
  latestCandleTime: number | null;
  thresholdMs: number;
  details?: Record<string, unknown>;
}

/**
 * Check if candle data is fresh enough for production use.
 * Returns fresh=false if latest closed candle is older than threshold.
 */
export function checkFreshness(input: FreshnessCheckInput): FreshnessResult {
  const thresholdMs = STALE_THRESHOLDS_MS[input.timeframe] ?? timeframeMinutes(input.timeframe) * 60_000 * 3;

  if (input.candles.length === 0) {
    return {
      fresh: false,
      reason: 'no_candles',
      ageMs: Infinity,
      latestCandleTime: null,
      thresholdMs,
      details: { timeframe: input.timeframe },
    };
  }

  const latest = input.candles[input.candles.length - 1];
  if (!latest) {
    return {
      fresh: false,
      reason: 'no_latest_candle',
      ageMs: Infinity,
      latestCandleTime: null,
      thresholdMs,
      details: { timeframe: input.timeframe },
    };
  }

  const latestTime = latest.time;
  const ageMs = input.nowMs - latestTime;

  if (ageMs < 0) {
    // Future candle — clock skew or bad data
    return {
      fresh: false,
      reason: 'future_candle',
      ageMs,
      latestCandleTime: latestTime,
      thresholdMs,
      details: {
        timeframe: input.timeframe,
        nowMs: input.nowMs,
        latestTime,
        clockSkewMs: -ageMs,
      },
    };
  }

  if (ageMs > thresholdMs) {
    return {
      fresh: false,
      reason: 'stale_candle',
      ageMs,
      latestCandleTime: latestTime,
      thresholdMs,
      details: {
        timeframe: input.timeframe,
        nowMs: input.nowMs,
        latestTime,
        ageMs,
        thresholdMs,
      },
    };
  }

  return {
    fresh: true,
    ageMs,
    latestCandleTime: latestTime,
    thresholdMs,
  };
}

export interface MultiTimeframeFreshnessInput {
  htf: { time: number }[];
  setup: { time: number }[];
  entry: { time: number }[];
  htfTimeframe: Timeframe;
  setupTimeframe: Timeframe;
  entryTimeframe: Timeframe;
  nowMs: number;
}

export interface MultiTimeframeFreshnessResult {
  fresh: boolean;
  reason?: string;
  htf: FreshnessResult;
  setup: FreshnessResult;
  entry: FreshnessResult;
}

/**
 * Check freshness across all required timeframes.
 * All must be fresh for a setup to be generated.
 */
export function checkMultiTimeframeFreshness(input: MultiTimeframeFreshnessInput): MultiTimeframeFreshnessResult {
  const htf = checkFreshness({ candles: input.htf, timeframe: input.htfTimeframe, nowMs: input.nowMs });
  const setup = checkFreshness({ candles: input.setup, timeframe: input.setupTimeframe, nowMs: input.nowMs });
  const entry = checkFreshness({ candles: input.entry, timeframe: input.entryTimeframe, nowMs: input.nowMs });

  const fresh = htf.fresh && setup.fresh && entry.fresh;
  let reason: string | undefined;

  if (!fresh) {
    if (!htf.fresh) reason = `htf_${htf.reason}`;
    else if (!setup.fresh) reason = `setup_${setup.reason}`;
    else if (!entry.fresh) reason = `entry_${entry.reason}`;
  }

  return { fresh, reason, htf, setup, entry };
}

/**
 * Determine if provider response is incomplete.
 * For example, if we requested 500 candles but got only 2, it may be incomplete
 * unless we're at the edge of available data.
 */
export function isIncompleteResponse(args: {
  requestedFrom: number;
  requestedTo: number;
  receivedCount: number;
  timeframe: Timeframe;
  isEdgeOfData?: boolean;
}): boolean {
  const periodMs = timeframeMinutes(args.timeframe) * 60_000;
  const expectedCount = Math.ceil((args.requestedTo - args.requestedFrom) / periodMs);

  // If we expected many candles but got very few, and it's not edge of data, it's incomplete
  if (expectedCount > 10 && args.receivedCount < expectedCount * 0.1 && !args.isEdgeOfData) {
    return true;
  }

  return false;
}
