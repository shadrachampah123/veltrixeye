import { timeframeMinutes, type Timeframe } from '@veltrixeye/contracts';
import type { NormalizedCandle } from './normalization.js';

/**
 * Production-safe validation for market data (M7.5).
 *
 * Validates:
 *  - missing candles
 *  - duplicate candles
 *  - out-of-order candles
 *  - invalid OHLC relationships
 *  - impossible/zero prices
 *  - stale market data (via freshness module, but also basic checks here)
 *  - incomplete candle responses
 *
 * Never generates a trading alert from invalid or stale data.
 */

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  details?: Record<string, unknown>;
  stats: {
    count: number;
    duplicates: number;
    outOfOrder: number;
    gaps: number;
    invalidOhlc: number;
    zeroPrices: number;
  };
}

export interface CandleBatchInput {
  candles: NormalizedCandle[];
  timeframe: Timeframe;
  expectedFrom?: number;
  expectedTo?: number;
  allowGaps?: boolean; // true for HTF where gaps may be expected (e.g., weekends)
}

export function validateCandleBatch(input: CandleBatchInput): ValidationResult {
  const { candles, timeframe } = input;
  const periodMs = timeframeMinutes(timeframe) * 60_000;

  const stats = {
    count: candles.length,
    duplicates: 0,
    outOfOrder: 0,
    gaps: 0,
    invalidOhlc: 0,
    zeroPrices: 0,
  };

  if (candles.length === 0) {
    return {
      valid: false,
      reason: 'empty_candle_response',
      details: { timeframe },
      stats,
    };
  }

  // Check sorted ascending
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.time <= candles[i - 1]!.time) {
      if (candles[i]!.time === candles[i - 1]!.time) {
        stats.duplicates += 1;
      } else {
        stats.outOfOrder += 1;
      }
    }
  }

  if (stats.duplicates > 0) {
    return {
      valid: false,
      reason: 'duplicate_candles',
      details: { duplicates: stats.duplicates, timeframe },
      stats,
    };
  }

  if (stats.outOfOrder > 0) {
    return {
      valid: false,
      reason: 'out_of_order_candles',
      details: { outOfOrder: stats.outOfOrder, timeframe },
      stats,
    };
  }

  // Validate each candle's OHLC and prices
  for (const c of candles) {
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) {
      stats.zeroPrices += 1;
    }
    if (!(c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close))) {
      stats.invalidOhlc += 1;
    }
  }

  if (stats.zeroPrices > 0) {
    return {
      valid: false,
      reason: 'impossible_zero_prices',
      details: { zeroCount: stats.zeroPrices, timeframe },
      stats,
    };
  }

  if (stats.invalidOhlc > 0) {
    return {
      valid: false,
      reason: 'invalid_ohlc_relationship',
      details: { invalidCount: stats.invalidOhlc, timeframe },
      stats,
    };
  }

  // Check for missing candles (gaps)
  // For production, we allow some tolerance for market closures, but flag large gaps
  if (!input.allowGaps) {
    let gaps = 0;
    for (let i = 1; i < candles.length; i++) {
      const diff = candles[i]!.time - candles[i - 1]!.time;
      // Allow up to 1.5x period for minor jitter, but flag > 2x as gap
      if (diff > periodMs * 2) {
        // Check if gap is explainable by weekend (for forex, crypto trades 24/7)
        // For simplicity, we count it as gap if > 2 periods
        gaps += 1;
      } else if (diff < periodMs * 0.5) {
        // Too close together, possible duplicate timeframe
        gaps += 1;
      }
    }
    stats.gaps = gaps;
    if (gaps > candles.length * 0.1) {
      // More than 10% gaps is suspicious
      return {
        valid: false,
        reason: 'missing_candles',
        details: { gaps, total: candles.length, timeframe, periodMs },
        stats,
      };
    }
  }

  // Check expected range if provided
  if (input.expectedFrom !== undefined && input.expectedTo !== undefined) {
    const first = candles[0]!.time;
    const last = candles[candles.length - 1]!.time;
    // If expected range is much larger than actual, it's incomplete
    const expectedSpan = input.expectedTo - input.expectedFrom;
    const actualSpan = last - first + periodMs;
    if (expectedSpan > actualSpan * 2 && candles.length < 10) {
      return {
        valid: false,
        reason: 'incomplete_candle_response',
        details: {
          expectedFrom: input.expectedFrom,
          expectedTo: input.expectedTo,
          firstCandle: first,
          lastCandle: last,
          expectedSpan,
          actualSpan,
        },
        stats,
      };
    }
  }

  return { valid: true, stats };
}

export interface MultiTimeframeValidationInput {
  htf: NormalizedCandle[];
  setup: NormalizedCandle[];
  entry: NormalizedCandle[];
  htfTimeframe: Timeframe;
  setupTimeframe: Timeframe;
  entryTimeframe: Timeframe;
  nowMs: number;
}

export interface MultiTimeframeValidationResult {
  valid: boolean;
  reason?: string;
  details?: Record<string, unknown>;
  htfResult: ValidationResult;
  setupResult: ValidationResult;
  entryResult: ValidationResult;
}

/**
 * Ensure multi-timeframe data is correlated and all required timeframes have data.
 * A setup should not be generated simply because one timeframe has data.
 */
export function validateMultiTimeframe(input: MultiTimeframeValidationInput): MultiTimeframeValidationResult {
  const htfResult = validateCandleBatch({
    candles: input.htf,
    timeframe: input.htfTimeframe,
    allowGaps: true, // HTF may have gaps
  });

  const setupResult = validateCandleBatch({
    candles: input.setup,
    timeframe: input.setupTimeframe,
    allowGaps: false,
  });

  const entryResult = validateCandleBatch({
    candles: input.entry,
    timeframe: input.entryTimeframe,
    allowGaps: false,
  });

  // All must be valid
  if (!htfResult.valid) {
    return {
      valid: false,
      reason: `htf_${htfResult.reason}`,
      details: { htf: htfResult.details, timeframe: input.htfTimeframe },
      htfResult,
      setupResult,
      entryResult,
    };
  }

  if (!setupResult.valid) {
    return {
      valid: false,
      reason: `setup_${setupResult.reason}`,
      details: { setup: setupResult.details, timeframe: input.setupTimeframe },
      htfResult,
      setupResult,
      entryResult,
    };
  }

  if (!entryResult.valid) {
    return {
      valid: false,
      reason: `entry_${entryResult.reason}`,
      details: { entry: entryResult.details, timeframe: input.entryTimeframe },
      htfResult,
      setupResult,
      entryResult,
    };
  }

  // Check timestamp alignment: HTF context should be available, setup confirms, entry confirms
  // Latest candles should be reasonably aligned in time
  const htfLatest = input.htf[input.htf.length - 1]?.time ?? 0;
  const setupLatest = input.setup[input.setup.length - 1]?.time ?? 0;
  const entryLatest = input.entry[input.entry.length - 1]?.time ?? 0;

  // HTF can be older than setup/entry, but not too old (e.g., 2x HTF period)
  const htfPeriodMs = timeframeMinutes(input.htfTimeframe) * 60_000;
  const setupPeriodMs = timeframeMinutes(input.setupTimeframe) * 60_000;
  const entryPeriodMs = timeframeMinutes(input.entryTimeframe) * 60_000;

  if (input.nowMs - htfLatest > htfPeriodMs * 3) {
    return {
      valid: false,
      reason: 'htf_context_missing',
      details: {
        htfLatest,
        nowMs: input.nowMs,
        ageMs: input.nowMs - htfLatest,
        htfTimeframe: input.htfTimeframe,
      },
      htfResult,
      setupResult,
      entryResult,
    };
  }

  // Setup and entry should be recent
  if (input.nowMs - setupLatest > setupPeriodMs * 3) {
    return {
      valid: false,
      reason: 'setup_timeframe_missing',
      details: {
        setupLatest,
        nowMs: input.nowMs,
        ageMs: input.nowMs - setupLatest,
        setupTimeframe: input.setupTimeframe,
      },
      htfResult,
      setupResult,
      entryResult,
    };
  }

  if (input.nowMs - entryLatest > entryPeriodMs * 3) {
    return {
      valid: false,
      reason: 'entry_timeframe_missing',
      details: {
        entryLatest,
        nowMs: input.nowMs,
        ageMs: input.nowMs - entryLatest,
        entryTimeframe: input.entryTimeframe,
      },
      htfResult,
      setupResult,
      entryResult,
    };
  }

  // Check that we have minimum required candles per role
  const minCandles = { htf: 50, setup: 100, entry: 100 };
  if (input.htf.length < minCandles.htf || input.setup.length < minCandles.setup || input.entry.length < minCandles.entry) {
    return {
      valid: false,
      reason: 'insufficient_candles_for_correlation',
      details: {
        htfCount: input.htf.length,
        setupCount: input.setup.length,
        entryCount: input.entry.length,
        minRequired: minCandles,
      },
      htfResult,
      setupResult,
      entryResult,
    };
  }

  return {
    valid: true,
    htfResult,
    setupResult,
    entryResult,
  };
}
