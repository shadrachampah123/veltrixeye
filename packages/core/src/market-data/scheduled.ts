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
import { ProviderBudgetExhaustedError } from './request-budget.js';
import {
  acquireSessionAdvisoryLock,
  DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS,
  holderLogMeta,
  type AdvisoryLockRelease,
} from '../db/advisory-lock.js';
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
 *    universe when any live version uses scope 'all'), narrowed to the
 *    instruments that actually have a provider-symbol mapping on an active
 *    provider — an unsupported/unlicensed instrument (e.g. `index/SPX500`)
 *    is never warmed.
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
   * True when the cycle stopped early because the *provider* reported a rate
   * limit — remaining pairs were not attempted and the cooldown applies.
   *
   * A spent per-cycle request budget is NOT a rate limit: it is a planned
   * deferral, reported through {@link budgetExhausted} / {@link pairsDeferred}.
   */
  abortedDueToRateLimit: boolean;
  /**
   * True when the cycle stopped early because the configured per-cycle
   * provider-request budget was spent. The remaining pairs stay cached-as-was
   * and are attempted first on a later cycle (the pair order rotates), so a
   * fixed slice of the universe can never starve.
   */
  budgetExhausted: boolean;
  /**
   * Pairs not attempted by this cycle because the request budget was spent.
   * They are deferred, not failed: nothing about them is known to be broken.
   */
  pairsDeferred: number;
  /** Index into the rotated pair order this cycle started at (fairness cursor). */
  rotationOffset: number;
}

/**
 * True when a pair should stop the scheduled cycle because the *provider*
 * reported a rate limit. `IngestionService` maps provider failures to domain
 * errors, so the usual provider-limit shape is a `DomainError` with code
 * `rate_limited`; the raw `ProviderError` and a bare HTTP 429 are also
 * recognized. Everything else (unknown instrument, provider unavailable,
 * network blip, …) remains an ordinary per-pair failure.
 *
 * A spent per-cycle request budget is deliberately NOT this condition: it is a
 * planned deferral (`budgetExhausted` / `pairsDeferred`), not a provider
 * refusal, and it must not start the cooldown or mark the cycle aborted.
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
export const SCHEDULED_INGESTION_ADVISORY_LOCK_KEY = 875_421_010;

/** Max instruments the scheduled ingestion will process per cycle. */
export const MAX_SCHEDULED_INSTRUMENTS = 50;

/**
 * Advance the persisted fairness cursor for the next warm cycle.
 *
 * The cursor walks the flat instrument × timeframe pair list by one budget's
 * worth of pairs per cycle, wrapping at the end. With `maxRequestsPerCycle`
 * requests per cycle and `totalPairs` pairs, every pair is reached within
 * `ceil(totalPairs / budget)` cycles — no pair can starve, whatever the
 * universe ordering happens to be.
 *
 * Deterministic and total: out-of-range, negative and non-finite inputs are
 * normalised, so a stale cursor from a larger universe (or an edited config)
 * can never index outside the list.
 */
export function nextRotationOffset(
  previousOffset: number,
  budget: number,
  totalPairs: number,
): number {
  if (!Number.isFinite(totalPairs) || totalPairs <= 0) return 0;
  const size = Math.max(0, Math.floor(totalPairs));
  const advance = Number.isFinite(budget) ? Math.max(1, Math.floor(budget)) : 1;
  const previous = Number.isFinite(previousOffset) ? Math.floor(previousOffset) : 0;
  return (((previous + advance) % size) + size) % size;
}

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
  private readonly advisoryLockOrphanIdleMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly ingestion: IngestionService,
    options?: {
      lookbackCandles?: number;
      maxRequestsPerCycle?: number;
      minIntervalMs?: number;
      logger?: ScheduledIngestionLogger;
      /**
       * Idle age (ms) at which the session holding the warm-cycle lock is
       * reported as *suspected orphaned* when a cycle cannot acquire it.
       * Diagnostic only — nothing is terminated automatically.
       */
      advisoryLockOrphanIdleMs?: number;
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
    const orphanIdleMs = options?.advisoryLockOrphanIdleMs ?? DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS;
    this.advisoryLockOrphanIdleMs = Number.isFinite(orphanIdleMs)
      ? Math.max(0, Math.floor(orphanIdleMs))
      : DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS;
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
   * Prior scheduled attempt (for the cooldown) together with the fairness
   * cursor it recorded, in one read. A row written before the cursor existed
   * (or with a non-numeric value) yields offset 0; `nextRotationOffset`
   * normalises it against the current pair count.
   */
  private async lastScheduledRunState(
    queryable: MarketDataQueryable = this.pool,
  ): Promise<{ attemptedAtMs: number | null; rotationOffset: number }> {
    const res = await queryable.query<{ attempted_at: Date | string | null; rotation_offset: unknown }>(
      `SELECT COALESCE(finished_at, started_at) AS attempted_at,
              CASE
                WHEN jsonb_typeof(request) = 'object' AND (request ->> 'rotationOffset') ~ '^[0-9]{1,9}$'
                  THEN (request ->> 'rotationOffset')::int
                ELSE 0
              END AS rotation_offset
         FROM ingestion_runs
        WHERE trigger = 'scheduled'
        ORDER BY COALESCE(finished_at, started_at) DESC
        LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) return { attemptedAtMs: null, rotationOffset: 0 };
    const attemptedAt = row.attempted_at;
    const attemptedAtMs =
      attemptedAt == null
        ? null
        : attemptedAt instanceof Date
          ? attemptedAt.getTime()
          : Date.parse(attemptedAt);
    if (attemptedAtMs !== null && !Number.isFinite(attemptedAtMs)) {
      throw new Error('Most recent scheduled ingestion attempt has an invalid timestamp.');
    }
    const raw = row.rotation_offset;
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    return { attemptedAtMs, rotationOffset: Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0 };
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

    let destroyLockClient = false;
    let lock: Awaited<ReturnType<typeof acquireSessionAdvisoryLock>>['lock'] = null;
    try {
      const lockRes = await acquireSessionAdvisoryLock(lockClient, SCHEDULED_INGESTION_ADVISORY_LOCK_KEY, {
        orphanIdleMs: this.advisoryLockOrphanIdleMs,
        logger: this.logger,
        label: 'scheduled ingestion warm-cycle lock',
      });

      if (!lockRes.acquired) {
        if (lockRes.mustDestroyClient) {
          // The server may hold the lock on a session this client can no
          // longer address (failed/misdirected acquire). Evict the session so
          // it cannot retain an orphaned lock that would skip every cycle.
          destroyLockClient = true;
          this.logger.error('scheduled ingestion: failed to acquire warm-cycle lock; skipping cycle', {
            lockKey: SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
            reason: lockRes.reason ?? 'not_owned',
            ...(lockRes.code !== undefined ? { code: lockRes.code } : {}),
            connectionDestroyed: true,
          });
          return this.skippedResult(startedAt, false);
        }
        this.logger.info('scheduled ingestion: warm-cycle lock is already held; skipping cycle', {
          lockKey: SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
          ...holderLogMeta(lockRes.holder ?? null),
        });
        return this.skippedResult(startedAt, false);
      }

      lock = lockRes.lock;
      // Keep the session-scoped lock held through the interval check, warming,
      // and the final ingestion_runs write.
      return await this.warmCacheLocked(args, lockClient);
    } finally {
      try {
        if (lock !== null) {
          const release = await lock.release();
          if (!release.released) {
            destroyLockClient = true;
            this.logWarmCycleReleaseFailure(release);
          }
        }
      } finally {
        lockClient.release(destroyLockClient || undefined);
      }
    }
  }

  /**
   * Log a non-clean warm-cycle lock release with a bounded machine-readable
   * reason and the (readable) holder session. No secrets, no tenant data.
   */
  private logWarmCycleReleaseFailure(release: AdvisoryLockRelease): void {
    const reason =
      release.reason === 'not_owned'
        ? 'unlock_returned_false'
        : release.reason === 'session_changed'
          ? 'session_changed'
          : 'query_error';
    this.logger.error('scheduled ingestion: warm-cycle advisory unlock failed', {
      lockKey: SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
      unlocked: false,
      reason,
      ...(release.code !== undefined ? { code: release.code } : {}),
      ...holderLogMeta(release.holder),
      connectionDestroyed: true,
    });
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
    let previousRotationOffset = 0;
    try {
      const prior = await this.lastScheduledRunState(lockClient);
      lastAttemptAtMs = prior.attemptedAtMs;
      previousRotationOffset = prior.rotationOffset;
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
        budgetExhausted: false,
        pairsDeferred: 0,
        rotationOffset: 0,
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
    let budgetExhausted = false;
    let pairsDeferred = 0;

    // One flat, deterministic pair order (instrument × timeframe), rotated by a
    // persisted cursor. Previously this was a fixed nested loop, so whenever the
    // per-cycle budget ran out mid-way the SAME trailing pairs were the ones
    // never attempted (a chronic `BTCUSD 1d` warm failure in production) while
    // the head of the list was re-warmed every cycle.
    const pairs: { inst: { assetClass: AssetClass; symbol: string }; tf: Timeframe }[] = [];
    for (const inst of instruments) {
      for (const tf of timeframes) pairs.push({ inst, tf });
    }
    const totalPairs = pairs.length;
    const rotationOffset = nextRotationOffset(previousRotationOffset, this.maxRequestsPerCycle, totalPairs);

    const beforeProviderRequest = (): void => {
      if (providerRequests >= this.maxRequestsPerCycle) {
        // Planned stop, not an error: the remaining pairs are deferred to a
        // later cycle, where the rotation makes them the head of the order.
        throw new ProviderBudgetExhaustedError(this.maxRequestsPerCycle);
      }
      providerRequests++;
    };

    for (let i = 0; i < totalPairs; i += 1) {
      const pair = pairs[(rotationOffset + i) % totalPairs]!;
      const inst = pair.inst;
      const tf = pair.tf;
      try {
        const result = await this.warmPair(inst, tf, nowMs, beforeProviderRequest, lockClient);
        candlesUpserted += result.candlesUpserted;
        pairsCompleted += 1;
        if (!result.fetchedFromProvider) pairsAlreadyCached += 1;
      } catch (err) {
        if (err instanceof ProviderBudgetExhaustedError) {
          budgetExhausted = true;
          // The current pair made no provider request (the guard throws before
          // it), so it is deferred along with the pairs after it — never
          // counted as a failure.
          pairsDeferred = totalPairs - i;
          break;
        }
        pairsFailed += 1;
        const rateLimited = isRateLimitedError(err);
        this.logger.warn(
          rateLimited
            ? 'scheduled ingestion: provider rate limit reached — stopping warm cycle'
            : 'scheduled ingestion: pair failed',
          {
            assetClass: inst.assetClass,
            symbol: inst.symbol,
            timeframe: tf,
            error: err instanceof Error ? err.message : 'unknown',
          },
        );
        // A provider rate limit stops the cycle; any other failure stays
        // per-pair and the cycle continues.
        if (rateLimited) {
          abortedDueToRateLimit = true;
          pairsDeferred = totalPairs - i - 1;
          break;
        }
      }
    }

    this.logger.info('scheduled ingestion: warm cycle pairs complete', {
      instruments: instruments.length,
      timeframes: timeframes.length,
      totalPairs,
      rotationOffset,
      pairsCompleted,
      pairsFailed,
      pairsAlreadyCached,
      pairsDeferred,
      budgetExhausted,
      abortedDueToRateLimit,
      providerRequests,
      maxRequestsPerCycle: this.maxRequestsPerCycle,
    });

    const finishedAt = new Date().toISOString();
    this.logger.info('scheduled ingestion: warm cycle complete', {
      instruments: instruments.length,
      timeframes: timeframes.length,
      pairsCompleted,
      pairsFailed,
      pairsAlreadyCached,
      pairsDeferred,
      candlesUpserted,
      providerRequests,
      abortedDueToRateLimit,
      budgetExhausted,
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
      budgetExhausted,
      pairsDeferred,
      rotationOffset,
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
      budgetExhausted,
      pairsDeferred,
      rotationOffset,
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
      budgetExhausted: false,
      pairsDeferred: 0,
      rotationOffset: 0,
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
   *
   * One narrowing DOES apply, and only to warming: an instrument is skipped
   * unless it has a provider-symbol mapping on an `active` provider. An
   * unmapped instrument is, by definition, one the platform does not source
   * data for — `index/SPX500` is the canonical case (S&P index licensing keeps
   * it out of the ingestion universe; see docs/provider-licensing.md). Warming
   * it would spend a provider request on an unsupported symbol, so it is
   * excluded here rather than attempted and failed. The scanner is untouched:
   * it keeps its own universe and still surfaces such instruments as having no
   * coverage.
   */
  private async resolveUniverse(
    queryable: MarketDataQueryable = this.pool,
  ): Promise<{ assetClass: AssetClass; symbol: string }[]> {
    const res = await queryable.query<{ asset_class: string; symbol: string }>(
      `SELECT i.asset_class, i.symbol
         FROM instruments i
        WHERE EXISTS (
                SELECT 1
                  FROM instrument_provider_symbols ips
                  JOIN data_providers dp ON dp.id = ips.provider_id AND dp.status = 'active'
                 WHERE ips.instrument_id = i.id)
          AND (
                EXISTS (
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
                   WHERE ms.mode = 'all'))
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
      budgetExhausted: boolean;
      pairsDeferred: number;
      rotationOffset: number;
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
          maxRequestsPerCycle: this.maxRequestsPerCycle,
          abortedDueToRateLimit: args.abortedDueToRateLimit,
          budgetExhausted: args.budgetExhausted,
          pairsDeferred: args.pairsDeferred,
          rotationOffset: args.rotationOffset,
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
