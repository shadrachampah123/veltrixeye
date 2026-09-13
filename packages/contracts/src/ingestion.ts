import { z } from 'zod';
import { timeframeSchema, type Timeframe } from './timeframes.js';
import { assetClassSchema, instrumentSymbolSchema, type AssetClass } from './assets.js';

/**
 * Market-data ingestion contracts (M2).
 *
 * The candle store is GLOBAL and shared: every authenticated user reads the
 * same ingested candles (market data is not per-user). Ingestion happens in
 * two ways, both writing through the same validation + upsert path:
 *
 *  - fetch-through: a candle read whose range is not (fully) cached fetches
 *    the missing head/tail from the registered provider, persists it, then
 *    serves from the database.
 *  - backfill: an explicit, audited request to ingest a bounded range for
 *    chosen instruments × timeframes (manual — M2 has no scheduler).
 *
 * Retention caps how far back any range may reach. Values were approved for
 * M2; finer anchor timeframes interpolate conservatively (see table).
 */

/** Approved M2 retention: max lookback in days per canonical timeframe. */
export const RETENTION_DAYS: Record<Timeframe, number> = {
  '1m': 30,
  '3m': 30,
  '5m': 90,
  '15m': 180,
  '30m': 180,
  '1h': 365,
  '2h': 365,
  '4h': 365,
  '8h': 365,
  '12h': 365,
  '1d': 1825, // 5 years
  '3d': 1825,
  '1w': 1825,
  '1M': 1825,
};

/** Earliest epoch-ms a range may start at for `timeframe`, given `nowMs`. Pure. */
export function retentionCutoffMs(timeframe: Timeframe, nowMs: number): number {
  return nowMs - RETENTION_DAYS[timeframe] * 86_400_000;
}

/** Max candles served/stored per single candle read (matches vendor page size). */
export const MAX_CANDLES_PER_REQUEST = 5000;
/** Default page when the caller does not specify a limit. */
export const DEFAULT_CANDLES_LIMIT = 500;
/** Max estimated candles per backfill request (bounds provider credits + time). */
export const MAX_BACKFILL_CANDLES = 50_000;
/** Max instruments per backfill request (the M2 universe is 8). */
export const MAX_BACKFILL_INSTRUMENTS = 8;

export const INGESTION_TRIGGERS = ['fetch_through', 'backfill'] as const;
export type IngestionTrigger = (typeof INGESTION_TRIGGERS)[number];

export const INGESTION_STATUSES = ['running', 'completed', 'failed', 'partial'] as const;
export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

/** One instrument reference inside ingestion requests (normalized, never provider tickers). */
export const ingestionInstrumentSchema = z
  .object({
    assetClass: assetClassSchema,
    symbol: instrumentSymbolSchema,
  })
  .strict();
export type IngestionInstrument = z.infer<typeof ingestionInstrumentSchema>;

/**
 * GET /api/market-data/candles query. `from` is inclusive, `to` exclusive,
 * both epoch-ms (UTC). Retention + range-size checks happen in the service
 * (they need wall-clock time and the timeframe duration).
 */
export const candleQuerySchema = z
  .object({
    assetClass: assetClassSchema,
    symbol: instrumentSymbolSchema,
    timeframe: timeframeSchema,
    from: z.coerce.number().int().positive().max(9_999_999_999_999),
    to: z.coerce.number().int().positive().max(9_999_999_999_999),
    limit: z.coerce.number().int().positive().max(MAX_CANDLES_PER_REQUEST).default(DEFAULT_CANDLES_LIMIT),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.from >= q.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '`from` must be earlier than `to`' });
    }
  });
export type CandleQuery = z.infer<typeof candleQuerySchema>;

/** One stored candle as served by the API (open time, epoch-ms UTC). */
export const candleDtoSchema = z
  .object({
    time: z.number().int().positive(),
    open: z.number().positive().finite(),
    high: z.number().positive().finite(),
    low: z.number().positive().finite(),
    close: z.number().positive().finite(),
    volume: z.number().nonnegative().finite().nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!(c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['low'], message: 'OHLC invariant violated (low ≤ open/close ≤ high)' });
    }
  });
export type CandleDto = z.infer<typeof candleDtoSchema>;

export interface CandlesResponseDto {
  instrument: { assetClass: AssetClass; symbol: string; displayName: string | null };
  timeframe: Timeframe;
  from: number;
  to: number;
  /** True when this request fetched missing data from the provider first. */
  fetchedFromProvider: boolean;
  candles: CandleDto[];
}

/**
 * POST /api/market-data/backfill body. Bounded and audited; the service
 * additionally enforces per-timeframe retention and MAX_BACKFILL_CANDLES.
 */
export const backfillRequestSchema = z
  .object({
    instruments: z.array(ingestionInstrumentSchema).min(1).max(MAX_BACKFILL_INSTRUMENTS),
    timeframes: z.array(timeframeSchema).min(1).max(14),
    from: z.number().int().positive().max(9_999_999_999_999),
    to: z.number().int().positive().max(9_999_999_999_999),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.from >= b.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '`from` must be earlier than `to`' });
    }
    const seen = new Set(b.timeframes);
    if (seen.size !== b.timeframes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timeframes'], message: 'timeframes must not repeat' });
    }
    const instrumentsSeen = new Set(b.instruments.map((i) => `${i.assetClass}/${i.symbol}`));
    if (instrumentsSeen.size !== b.instruments.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['instruments'], message: 'instruments must not repeat' });
    }
  });
export type BackfillRequest = z.infer<typeof backfillRequestSchema>;

export interface BackfillPairResult {
  assetClass: AssetClass;
  symbol: string;
  timeframe: Timeframe;
  status: 'completed' | 'failed';
  candlesUpserted: number;
  error: string | null;
}

export interface BackfillResponseDto {
  runId: string;
  status: IngestionStatus;
  provider: string;
  from: number;
  to: number;
  candlesUpserted: number;
  pairs: BackfillPairResult[];
  startedAt: string;
  finishedAt: string;
}

/** One row of the coverage ledger: what the store holds per instrument × timeframe. */
export const coverageDtoSchema = z
  .object({
    assetClass: assetClassSchema,
    symbol: instrumentSymbolSchema,
    displayName: z.string().nullable(),
    timeframe: timeframeSchema,
    candleCount: z.number().int().nonnegative(),
    earliestTime: z.number().int().positive().nullable(),
    latestTime: z.number().int().positive().nullable(),
  })
  .strict();
export type CoverageDto = z.infer<typeof coverageDtoSchema>;

export interface CoverageResponseDto {
  coverage: CoverageDto[];
}

export interface IngestionRunDto {
  id: string;
  trigger: IngestionTrigger;
  status: IngestionStatus;
  provider: string;
  candlesUpserted: number;
  error: string | null;
  initiatedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}
