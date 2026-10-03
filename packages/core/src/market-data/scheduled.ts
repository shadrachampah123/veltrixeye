import type pg from 'pg';
import {
  type AssetClass,
  type Timeframe,
  ERROR_CODES,
  isProviderError,
  timeframeMinutes,
  retentionCutoffMs,
} from '@veltrixeye/contracts';
import { Errors, isDomainError } from '../errors.js';
import type { MarketDataQueryable } from './candles.js';
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
 *    timeframe (default 500, enough for scanner evaluation windows), and runs
 *    respect a minimum interval since the last scheduled warm-cycle attempt —
 *    failed and partial attempts included, so a broken provider or an
 *    exhausted budget cannot be retried on every scanner tick.
 *  - Retention-aware: ranges are clamped to the retention cutoff.
 *  - Never throws: individual pair failures are logged and the rest continue
 *    — except a provider rate limit or an exhausted request budget, which
 *    aborts the rest of the cycle before another provider request starts.
 *  - Records each run in `ingestion_runs` with trigger = 'scheduled'.
 */

export interface ScheduledIngestionOptions {
  /** Max candles to fetch per instrument × timeframe (bounds provider usage). */
  lookbackCandles?: number;
  /** Maximum actual provider requests allowed in one warm cycle. */
  maxRequestsPerCycle?: number;
  /** Minimum time between scheduled warm-cycle attempts (any outcome). */
  minIntervalMs?: number;
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
  /** Actual provider requests started during this cycle. */
  providerRequests: number;
  /** Pairs that were already fully cached (no provider fetch needed). */
  pairsAlreadyCached: number;
  /** True when the minimum-interval guard skipped the cycle, including fail-closed state-read errors. */
  skippedDueToMinInterval: boolean;
  /**
   * True when the cycle stopped early because of a provider rate limit or the
   * scheduled provider-request budget — remaining pairs were not attempted.
   */
  abortedDueToRateLimit: boolean;
}

/**
 * True when a pair should stop the scheduled cycle: for a provider rate limit
 * or the scheduled provider-request budget. `IngestionService` maps provider
 * failures to domain errors, so the usual provider-limit shape is a
 * `DomainError` with code `rate_limited`; the raw `ProviderError` and a bare
 * HTTP 429 are also recognized. Everything else (unknown instrument, provider
 * unavailable, network blip, …) remains an ordinary per-pair failure.
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
export const DEFAULT_SCHEDULED_MAX_REQUESTS_PER_CYCLE = 8;
export const DEFAULT_SCHEDULED_MIN_INTERVAL_MS = 900_000;

/** Dedicated database advisory lock for one scheduled-ingestion warm cycle. */
const SCHEDULED_INGESTION_ADVISORY_LOCK_KEY = 875_421_010;

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
  private readonly maxRequestsPerCycle: number;
  private readonly minIntervalMs: number;
  private readonly logger: ScheduledIngestionLogger;

  constructor(
    private readonly pool: pg.Pool,
    private readonly ingestion: IngestionService,
    options?: {
      lookbackCandles?: number;
      maxRequestsPerCycle?: number;
      minIntervalMs?: number;
      logger?: ScheduledIngestionLogger;
    },
  ) {
    this.lookbackCandles = Math.max(
      10,
      Math.min(options?.lookbackCandles ?? DEFAULT_SCHEDULED_LOOKBACK_CANDLES, 5000),
    );
    const maxRequestsPerCycle = options?.maxRequestsPerCycle ?? DEFAULT_SCHEDULED_MAX_REQUESTS_PER_CYCLE;
    this.maxRequestsPerCycle = Number.isFinite(maxRequestsPerCycle)
      ? Math.max(0, Math.floor(maxRequestsPerCycle))
      : DEFAULT_SCHEDULED_MAX_REQUESTS_PER_CYCLE;
    const minIntervalMs = options?.minIntervalMs ?? DEFAULT_SCHEDULED_MIN_INTERVAL_MS;
    this.minIntervalMs = Number.isFinite(minIntervalMs)
      ? Math.max(0, Math.floor(minIntervalMs))
      : DEFAULT_SCHEDULED_MIN_INTERVAL_MS;
    this.logger = options?.logger ?? NOOP_LOGGER;
  }

  /**
   * End time of the most recent scheduled warm-cycle attempt, in epoch ms —
   * whatever its outcome (completed, partial, failed).
   *
   * The cooldown is measured from the last *attempt*, not the last success:
   * a failed or partial cycle still spent provider requests, so re-running it
   * on the next scanner tick would burn credits against the same broken
   * state. A run row that never finished (still `running`, e.g. left behind by
   * a killed process) counts at its start time, which is the conservative
   * reading of "when the attempt happened".
   *
   * Returns null only when no scheduled run has ever been recorded.
   */
  async lastScheduledRunAttemptAtMs(queryable: MarketDataQueryable = this.pool): Promise<number | null> {
    const res = await queryable.query<{ attempted_at: Date | string | null }>(
      `SELECT COALESCE(finished_at, started_at) AS attempted_at
         FROM ingestion_runs
        WHERE trigger = 'scheduled'
        ORDER BY COALESCE(finished_at, started_at) DESC
        LIMIT 1`,
    );
    const attemptedAt = res.rows[0]?.attempted_at;
    if (attemptedAt == null) return null;

    const attemptedAtMs = attemptedAt instanceof Date ? attemptedAt.getTime() : Date.parse(attemptedAt);
    if (!Number.isFinite(attemptedAtMs)) {
      throw new Error('Most recent scheduled ingestion attempt has an invalid timestamp.');
    }
    return attemptedAtMs;
  }

  /**
   * Warm the candle cache for the active instrument universe.
   *
   * Safe to call even when no provider is registered — all pairs will fail
   * gracefully and the result will report zero upserts. A recent scheduled
   * attempt (or an unreadable prior-run state) skips this cycle without
   * recording a run.
   *
   * Never throws: individual pair failures are caught and logged. A provider
   * rate limit or exhausted request budget stops the cycle immediately
   * (`abortedDueToRateLimit: true`) instead of attempting another provider
   * request; every other failure keeps the continue-on-error behaviour.
   */
  async warmCache(
    args?: {
      timeframes?: readonly Timeframe[];
      nowMs?: number;
    },
  ): Promise<ScheduledIngestionResult> {
    const startedAt = new Date(args?.nowMs ?? Date.now()).toISOString();
    let lockClient: pg.PoolClient;
    try {
      lockClient = await this.pool.connect();
    } catch (err) {
      this.logger.error('scheduled ingestion: failed to connect for warm-cycle lock; skipping cycle', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      return this.skippedResult(startedAt, false);
    }

    let lockAcquired = false;
    let destroyLockClient = false;
    try {
      let lockRes;
      try {
        lockRes = await lockClient.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS acquired',
          [SCHEDULED_INGESTION_ADVISORY_LOCK_KEY],
        );
      } catch (err) {
        // The server may have acquired the lock before the connection failed;
        // evict this session so it cannot retain an orphaned advisory lock.
        destroyLockClient = true;
        this.logger.error('scheduled ingestion: failed to acquire warm-cycle lock; skipping cycle', {
          lockKey: SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
          error: err instanceof Error ? err.message : 'unknown',
        });
        return this.skippedResult(startedAt, false);
      }

      lockAcquired = lockRes.rows[0]?.acquired ?? false;
      if (!lockAcquired) {
        this.logger.info('scheduled ingestion: warm-cycle lock is already held; skipping cycle', {
          lockKey: SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
        });
        return this.skippedResult(startedAt, false);
      }

      // Keep the session-scoped lock held through the interval check, warming,
      // and the final ingestion_runs write.
      return await this.warmCacheLocked(args, lockClient);
    } finally {
      try {
        if (lockAcquired) {
          try {
            const unlockRes = await lockClient.query<{
              unlocked?: boolean;
              pg_advisory_unlock?: boolean;
            }>('SELECT pg_advisory_unlock($1) AS unlocked', [SCHEDULED_INGESTION_ADVISORY_LOCK_KEY]);
            const row = unlockRes?.rows?.[0];
            const unlocked =
              typeof row?.unlocked === 'boolean'
                ? row.unlocked
                : typeof row?.pg_advisory_unlock === 'boolean'
                  ? row.pg_advisory_unlock
                  : false;
            if (!unlocked) {
              destroyLockClient = true;
              this.logger.error('scheduled ingestion: warm-cycle advisory unlock failed', {
                lockKey: SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
                reason: 'unlock_returned_false',
              });
            }
          } catch (err) {
            destroyLockClient = true;
            this.logger.error('scheduled ingestion: warm-cycle advisory unlock failed', {
              lockKey: SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
              reason: 'query_error',
              error: err instanceof Error ? err.message : 'unknown',
            });
          }
        }
      } finally {
        lockClient.release(destroyLockClient || undefined);
      }
    }
  }

  private async warmCacheLocked(
    args: {
      timeframes?: readonly Timeframe[];
      nowMs?: number;
    } | undefined,
    lockClient: pg.PoolClient,
  ): Promise<ScheduledIngestionResult> {
    const nowMs = args?.nowMs ?? Date.now();
    const startedAt = new Date(nowMs).toISOString();

    let lastAttemptAtMs: number | null;
    try {
      lastAttemptAtMs = await this.lastScheduledRunAttemptAtMs(lockClient);
    } catch (err) {
      this.logger.error('scheduled ingestion: failed to read prior run state; skipping cycle', {
        error: err instanceof Error ? err.message : 'unknown',
      });
      return this.skippedResult(startedAt);
    }

    if (
      this.minIntervalMs > 0 &&
      lastAttemptAtMs !== null &&
      nowMs - lastAttemptAtMs < this.minIntervalMs
    ) {
      this.logger.info('scheduled ingestion: skipping cycle because minimum interval has not elapsed', {
        lastScheduledRunAttemptAtMs: lastAttemptAtMs,
        minIntervalMs: this.minIntervalMs,
      });
      return this.skippedResult(startedAt);
    }

    const timeframes = args?.timeframes ?? DEFAULT_SCHEDULED_TIMEFRAMES;

    // Resolve the active instrument universe
    const instruments = await this.resolveUniverse(lockClient);

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
        providerRequests: 0,
        pairsAlreadyCached: 0,
        skippedDueToMinInterval: false,
        abortedDueToRateLimit: false,
      };
    }

    this.logger.info('scheduled ingestion: warming cache', {
      instruments: instruments.length,
      timeframes: timeframes.length,
      lookbackCandles: this.lookbackCandles,
      maxRequestsPerCycle: this.maxRequestsPerCycle,
      minIntervalMs: this.minIntervalMs,
    });

    let pairsCompleted = 0;
    let pairsFailed = 0;
    let candlesUpserted = 0;
    let providerRequests = 0;
    let pairsAlreadyCached = 0;
    let abortedDueToRateLimit = false;

    const beforeProviderRequest = (): void => {
      if (providerRequests >= this.maxRequestsPerCycle) {
        throw Errors.rateLimited('Scheduled ingestion provider request budget exhausted.');
      }
      providerRequests++;
    };

    for (const inst of instruments) {
      for (const tf of timeframes) {
        try {
          const result = await this.warmPair(inst, tf, nowMs, beforeProviderRequest, lockClient);
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
              ? 'scheduled ingestion: provider rate limit or request budget reached — stopping warm cycle'
              : 'scheduled ingestion: pair failed',
            {
              assetClass: inst.assetClass,
              symbol: inst.symbol,
              timeframe: tf,
              error: err instanceof Error ? err.message : 'unknown',
            },
          );
          // Provider rate limits and an exhausted request budget both stop the
          // cycle here; any other failure stays per-pair and the cycle continues.
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
      providerRequests,
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
      providerRequests,
      abortedDueToRateLimit,
      startedAt,
      finishedAt,
    }, lockClient).catch((err) => {
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
      providerRequests,
      pairsAlreadyCached,
      skippedDueToMinInterval: false,
      abortedDueToRateLimit,
    };
  }

  private async warmPair(
    inst: { assetClass: AssetClass; symbol: string },
    tf: Timeframe,
    nowMs: number,
    beforeProviderRequest: () => void,
    queryable: pg.PoolClient,
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
      beforeProviderRequest,
      dbClient: queryable,
    });

    return {
      candlesUpserted: result.candles.length,
      fetchedFromProvider: result.fetchedFromProvider,
    };
  }

  private skippedResult(
    startedAt: string,
    skippedDueToMinInterval = true,
  ): ScheduledIngestionResult {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      instrumentsProcessed: 0,
      timeframesProcessed: 0,
      pairsCompleted: 0,
      pairsFailed: 0,
      candlesUpserted: 0,
      providerRequests: 0,
      pairsAlreadyCached: 0,
      skippedDueToMinInterval,
      abortedDueToRateLimit: false,
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
  private async resolveUniverse(
    queryable: MarketDataQueryable = this.pool,
  ): Promise<{ assetClass: AssetClass; symbol: string }[]> {
    const res = await queryable.query<{ asset_class: string; symbol: string }>(
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

  private async recordRun(
    args: {
      instruments: { assetClass: AssetClass; symbol: string }[];
      timeframes: Timeframe[];
      pairsCompleted: number;
      pairsFailed: number;
      pairsAlreadyCached: number;
      candlesUpserted: number;
      providerRequests: number;
      abortedDueToRateLimit: boolean;
      startedAt: string;
      finishedAt: string;
    },
    queryable: MarketDataQueryable = this.pool,
  ): Promise<void> {
    const status = args.pairsFailed === 0 ? 'completed' : args.pairsCompleted === 0 ? 'failed' : 'partial';
    const totalPairs = args.pairsCompleted + args.pairsFailed;
    await queryable.query(
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
          providerRequests: args.providerRequests,
          abortedDueToRateLimit: args.abortedDueToRateLimit,
        }),
        args.candlesUpserted,
        args.pairsFailed > 0
          ? `${args.pairsFailed} of ${totalPairs} pairs failed${
              args.abortedDueToRateLimit
                ? ' (cycle stopped early: provider rate limited or request budget exhausted)'
                : ''
            }`
          : null,
        args.finishedAt,
      ],
    );
  }
}
