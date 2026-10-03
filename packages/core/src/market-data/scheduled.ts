import type pg from 'pg';
import {
  type AssetClass,
  type Timeframe,
  ERROR_CODES,
  isProviderError,
  timeframeMinutes,
  retentionCutoffMs,
} from '@veltrixeye/contracts';
import { isDomainError } from '../errors.js';
import type { IngestionService } from './ingestion.js';

/**
 * Scheduled / pre-emptive candle ingestion (P1).
 *
 * Warming the candle store before each scanner cycle turns the scanner's
 * fetch-through reads into pure cache hits — no provider calls during the
 * scan itself (for already-cached ranges). This decouples data availability
 * from scan timing and reduces provider credit usage.
 *
 * Design:
 *  - Reads the instrument universe reachable by an active strategy's
 *    published version (scope 'instruments' rows, or the whole platform
 *    universe when any live version uses scope 'all').
 *  - For each instrument × timeframe, calls `IngestionService.getCandles()`
 *    which triggers fetch-through for any missing head/tail ranges.
 *  - Bounded: lookback is limited to a configurable number of candles per
 *    timeframe (default 500, enough for scanner evaluation windows).
 *  - Retention-aware: ranges are clamped to the retention cutoff.
 *  - Never throws: individual pair failures are logged and the rest continue
 *    — except a provider rate limit, which aborts the rest of the cycle so a
 *    saturated provider is not hammered with the remaining pairs.
 *  - Records each run in `ingestion_runs` with trigger = 'scheduled'.
 */

export interface ScheduledIngestionOptions {
  /** Max candles to fetch per instrument × timeframe (bounds provider usage). */
  lookbackCandles?: number;
  /** Override for "now" (tests). */
  nowMs?: number;
}

export interface ScheduledIngestionResult {
  /** When the warm cycle started (ISO-8601). */
  startedAt: string;
  /** When the warm cycle finished (ISO-8601). */
  finishedAt: string;
  /** Total instruments processed. */
  instrumentsProcessed: number;
  /** Total timeframes processed (across all instruments). */
  timeframesProcessed: number;
  /** Pairs that completed successfully. */
  pairsCompleted: number;
  /** Pairs that failed (provider error, unknown instrument, etc.). */
  pairsFailed: number;
  /** Total candles upserted across all pairs. */
  candlesUpserted: number;
  /** Pairs that were already fully cached (no provider fetch needed). */
  pairsAlreadyCached: number;
  /**
   * True when the cycle stopped early because a pair hit a provider rate
   * limit — remaining instruments/timeframes were deliberately not attempted.
   */
  abortedDueToRateLimit: boolean;
}

/**
 * True when a pair failed *specifically* because the provider is rate limited.
 *
 * `IngestionService` maps provider failures to domain errors, so the usual
 * shape is a `DomainError` with code `rate_limited`; the raw `ProviderError`
 * and a bare HTTP 429 are also recognized so a rate limit is never mistaken
 * for an ordinary pair failure. Everything else (unknown instrument, provider
 * unavailable, network blip, …) is an ordinary failure and must keep the
 * existing continue-on-error handling.
 */
export function isRateLimitedError(err: unknown): boolean {
  if (isDomainError(err)) return err.code === ERROR_CODES.RATE_LIMITED;
  if (isProviderError(err)) return err.kind === 'rate_limited';
  return (err as { statusCode?: unknown } | null | undefined)?.statusCode === 429;
}

/**
 * Default timeframes to warm. Covers the scanner's common roles:
 * - HTF bias: 4h, 1d
 * - Setup: 1h
 * - Entry: 5m, 15m
 *
 * This is intentionally smaller than the full 14-timeframe canonical set:
 * warming all timeframes for all instruments would be wasteful when the
 * scanner only needs a subset. Additional timeframes are fetched on-demand
 * via fetch-through when a strategy requires them.
 */
export const DEFAULT_SCHEDULED_TIMEFRAMES: readonly Timeframe[] = [
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
];

export const DEFAULT_SCHEDULED_LOOKBACK_CANDLES = 500;

/** Max instruments the scheduled ingestion will process per cycle. */
export const MAX_SCHEDULED_INSTRUMENTS = 50;

export interface ScheduledIngestionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: ScheduledIngestionLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class ScheduledIngestionService {
  private readonly lookbackCandles: number;
  private readonly logger: ScheduledIngestionLogger;

  constructor(
    private readonly pool: pg.Pool,
    private readonly ingestion: IngestionService,
    options?: {
      lookbackCandles?: number;
      logger?: ScheduledIngestionLogger;
    },
  ) {
    this.lookbackCandles = Math.max(
      10,
      Math.min(options?.lookbackCandles ?? DEFAULT_SCHEDULED_LOOKBACK_CANDLES, 5000),
    );
    this.logger = options?.logger ?? NOOP_LOGGER;
  }

  /**
   * Warm the candle cache for the active instrument universe.
   *
   * Safe to call even when no provider is registered — all pairs will fail
   * gracefully and the result will report zero upserts.
   *
   * Never throws: individual pair failures are caught and logged. A pair that
   * fails *because the provider is rate limited* stops the cycle immediately
   * (`abortedDueToRateLimit: true`) instead of walking the remaining pairs
   * into the same wall; every other failure keeps the continue-on-error
   * behaviour.
   */
  async warmCache(
    args?: {
      timeframes?: readonly Timeframe[];
      nowMs?: number;
    },
  ): Promise<ScheduledIngestionResult> {
    const nowMs = args?.nowMs ?? Date.now();
    const startedAt = new Date(nowMs).toISOString();
    const timeframes = args?.timeframes ?? DEFAULT_SCHEDULED_TIMEFRAMES;

    // Resolve the active instrument universe
    const instruments = await this.resolveUniverse();

    if (instruments.length === 0) {
      this.logger.info('scheduled ingestion: no instruments in universe');
      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        instrumentsProcessed: 0,
        timeframesProcessed: 0,
        pairsCompleted: 0,
        pairsFailed: 0,
        candlesUpserted: 0,
        pairsAlreadyCached: 0,
        abortedDueToRateLimit: false,
      };
    }

    this.logger.info('scheduled ingestion: warming cache', {
      instruments: instruments.length,
      timeframes: timeframes.length,
      lookbackCandles: this.lookbackCandles,
    });

    let pairsCompleted = 0;
    let pairsFailed = 0;
    let candlesUpserted = 0;
    let pairsAlreadyCached = 0;
    let abortedDueToRateLimit = false;

    for (const inst of instruments) {
      for (const tf of timeframes) {
        try {
          const result = await this.warmPair(inst, tf, nowMs);
          candlesUpserted += result.candlesUpserted;
          if (result.fetchedFromProvider) {
            pairsCompleted++;
          } else {
            pairsAlreadyCached++;
            pairsCompleted++;
          }
        } catch (err) {
          pairsFailed++;
          const rateLimited = isRateLimitedError(err);
          this.logger.warn(
            rateLimited
              ? 'scheduled ingestion: provider rate limited — stopping warm cycle'
              : 'scheduled ingestion: pair failed',
            {
              assetClass: inst.assetClass,
              symbol: inst.symbol,
              timeframe: tf,
              error: err instanceof Error ? err.message : 'unknown',
            },
          );
          // A rate limit is provider-wide: every remaining pair would fail the
          // same way (and burn credits), so stop the cycle here. Any other
          // failure stays per-pair and the cycle continues.
          if (rateLimited) {
            abortedDueToRateLimit = true;
            break;
          }
        }
      }
      if (abortedDueToRateLimit) break;
    }

    const finishedAt = new Date().toISOString();
    this.logger.info('scheduled ingestion: warm cycle complete', {
      instruments: instruments.length,
      timeframes: timeframes.length,
      pairsCompleted,
      pairsFailed,
      pairsAlreadyCached,
      candlesUpserted,
      abortedDueToRateLimit,
    });

    // Record the run in ingestion_runs for observability
    await this.recordRun({
      instruments,
      timeframes: [...timeframes],
      pairsCompleted,
      pairsFailed,
      pairsAlreadyCached,
      candlesUpserted,
      abortedDueToRateLimit,
      startedAt,
      finishedAt,
    }).catch((err) => {
      this.logger.error('scheduled ingestion: failed to record run', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    });

    return {
      startedAt,
      finishedAt,
      instrumentsProcessed: instruments.length,
      timeframesProcessed: instruments.length * timeframes.length,
      pairsCompleted,
      pairsFailed,
      candlesUpserted,
      pairsAlreadyCached,
      abortedDueToRateLimit,
    };
  }

  private async warmPair(
    inst: { assetClass: AssetClass; symbol: string },
    tf: Timeframe,
    nowMs: number,
  ): Promise<{ candlesUpserted: number; fetchedFromProvider: boolean }> {
    const periodMs = timeframeMinutes(tf) * 60_000;
    const lookbackMs = this.lookbackCandles * periodMs;
    const retentionCutoff = retentionCutoffMs(tf, nowMs);
    const from = Math.max(nowMs - lookbackMs, retentionCutoff + 1);
    const to = nowMs;

    const result = await this.ingestion.getCandles({
      assetClass: inst.assetClass,
      symbol: inst.symbol,
      timeframe: tf,
      from,
      to,
      limit: this.lookbackCandles,
      nowMs,
    });

    return {
      candlesUpserted: result.candles.length,
      fetchedFromProvider: result.fetchedFromProvider,
    };
  }

  /**
   * Instruments a scan can actually reach: those referenced by the published
   * version of an active strategy, plus the whole platform universe whenever
   * any such version uses scope mode 'all'.
   *
   * Mirrors the scanner's eligibility read (active strategy + published
   * version). The scanner's JS-side entitlement gate is deliberately NOT
   * replicated here: this set is a superset of what any scan will touch, so
   * it can only warm instruments that *might* be needed — never miss one.
   */
  private async resolveUniverse(): Promise<{ assetClass: AssetClass; symbol: string }[]> {
    const res = await this.pool.query<{ asset_class: string; symbol: string }>(
      `SELECT i.asset_class, i.symbol
         FROM instruments i
        WHERE EXISTS (
                SELECT 1
                  FROM strategy_market_scope_instruments smsi
                  JOIN strategy_versions v ON v.id = smsi.version_id AND v.status = 'published'
                  JOIN strategies s ON s.id = v.strategy_id AND s.status = 'active'
                 WHERE smsi.instrument_id = i.id)
           OR EXISTS (
                SELECT 1
                  FROM strategy_market_scopes ms
                  JOIN strategy_versions v ON v.id = ms.version_id AND v.status = 'published'
                  JOIN strategies s ON s.id = v.strategy_id AND s.status = 'active'
                 WHERE ms.mode = 'all')
        ORDER BY i.asset_class, i.symbol
        LIMIT $1`,
      [MAX_SCHEDULED_INSTRUMENTS],
    );
    return res.rows.map((r) => ({
      assetClass: r.asset_class as AssetClass,
      symbol: r.symbol,
    }));
  }

  private async recordRun(args: {
    instruments: { assetClass: AssetClass; symbol: string }[];
    timeframes: Timeframe[];
    pairsCompleted: number;
    pairsFailed: number;
    pairsAlreadyCached: number;
    candlesUpserted: number;
    abortedDueToRateLimit: boolean;
    startedAt: string;
    finishedAt: string;
  }): Promise<void> {
    const status = args.pairsFailed === 0 ? 'completed' : args.pairsCompleted === 0 ? 'failed' : 'partial';
    const totalPairs = args.pairsCompleted + args.pairsFailed;
    await this.pool.query(
      `INSERT INTO ingestion_runs (trigger, status, provider_slug, request, candles_upserted, error, finished_at)
       VALUES ('scheduled', $1, 'scheduled', $2, $3, $4, $5)`,
      [
        status,
        JSON.stringify({
          instruments: args.instruments.map((i) => `${i.assetClass}/${i.symbol}`),
          timeframes: args.timeframes,
          lookbackCandles: this.lookbackCandles,
          pairsCompleted: args.pairsCompleted,
          pairsFailed: args.pairsFailed,
          pairsAlreadyCached: args.pairsAlreadyCached,
          totalPairs,
          abortedDueToRateLimit: args.abortedDueToRateLimit,
        }),
        args.candlesUpserted,
        args.pairsFailed > 0
          ? `${args.pairsFailed} of ${totalPairs} pairs failed${
              args.abortedDueToRateLimit ? ' (cycle stopped early: provider rate limited)' : ''
            }`
          : null,
        args.finishedAt,
      ],
    );
  }
}
