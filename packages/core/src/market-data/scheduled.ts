import type pg from 'pg';
import { type AssetClass, type Timeframe, timeframeMinutes, retentionCutoffMs } from '@veltrixeye/contracts';
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
 *  - Reads the active instrument universe from the `instruments` table.
 *  - For each instrument × timeframe, calls `IngestionService.getCandles()`
 *    which triggers fetch-through for any missing head/tail ranges.
 *  - Bounded: lookback is limited to a configurable number of candles per
 *    timeframe (default 500, enough for scanner evaluation windows).
 *  - Retention-aware: ranges are clamped to the retention cutoff.
 *  - Never throws: individual pair failures are logged and the rest continue.
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
   * Never throws: individual pair failures are caught and logged.
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
          this.logger.warn('scheduled ingestion: pair failed', {
            assetClass: inst.assetClass,
            symbol: inst.symbol,
            timeframe: tf,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }

    const finishedAt = new Date().toISOString();
    this.logger.info('scheduled ingestion: warm cycle complete', {
      instruments: instruments.length,
      timeframes: timeframes.length,
      pairsCompleted,
      pairsFailed,
      pairsAlreadyCached,
      candlesUpserted,
    });

    // Record the run in ingestion_runs for observability
    await this.recordRun({
      instruments,
      timeframes: [...timeframes],
      pairsCompleted,
      pairsFailed,
      pairsAlreadyCached,
      candlesUpserted,
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

  private async resolveUniverse(): Promise<{ assetClass: AssetClass; symbol: string }[]> {
    const res = await this.pool.query<{ asset_class: string; symbol: string }>(
      `SELECT asset_class, symbol FROM instruments ORDER BY asset_class, symbol LIMIT $1`,
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
        }),
        args.candlesUpserted,
        args.pairsFailed > 0 ? `${args.pairsFailed} of ${totalPairs} pairs failed` : null,
        args.finishedAt,
      ],
    );
  }
}
