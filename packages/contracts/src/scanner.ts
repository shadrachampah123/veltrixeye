import { z } from 'zod';

/**
 * Live scanner contracts (M7.5) — production market-data and scanner pipeline.
 *
 * M7.5 turns the explicitly-invoked detection path (M4) into a live scanner:
 *
 *   Market Data → Normalization → Validation/Freshness → Strategy Detection
 *   → Setup Qualification → Scoring → Risk/Quality Validation → Alert Generation
 *   → Notification Outbox
 *
 * This file defines:
 *  - scanner run statuses and DTOs
 *  - health/status API contracts
 *  - normalization and validation helpers (pure, no I/O)
 *  - freshness policy constants
 *  - advisory lock key (pinned, never change)
 */

/** Advisory lock key for scanner execution — pinned, arbitrary but stable. */
export const SCANNER_ADVISORY_LOCK_KEY = 875_421_009;

/** How often the scanner is expected to run (documented, not enforced in SQL). */
export const SCANNER_EXPECTED_INTERVAL_MS = 5 * 60_000; // 5 minutes

/** Scanner run statuses. */
export const SCANNER_RUN_STATUSES = ['running', 'completed', 'failed', 'partial'] as const;
export type ScannerRunStatus = (typeof SCANNER_RUN_STATUSES)[number];

export const scannerRunStatusSchema = z.enum(SCANNER_RUN_STATUSES);

/** One row of scanner_runs. */
export const scannerRunDtoSchema = z
  .object({
    id: z.string().uuid(),
    status: scannerRunStatusSchema,
    providerSlug: z.string().min(1).max(64),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    strategiesScanned: z.number().int().min(0),
    instrumentsScanned: z.number().int().min(0),
    candlesFetched: z.number().int().min(0),
    setupsDetected: z.number().int().min(0),
    setupsCreated: z.number().int().min(0),
    alertsCreated: z.number().int().min(0),
    staleRejections: z.number().int().min(0),
    providerFailures: z.number().int().min(0),
    symbolsProcessed: z.array(z.string()).max(500),
    timeframesProcessed: z.array(z.string()).max(50),
    error: z.string().max(2000).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ScannerRunDto = z.infer<typeof scannerRunDtoSchema>;

/** Per-cursor state (last processed candle). */
export const scannerCursorDtoSchema = z
  .object({
    strategyVersionId: z.string().uuid(),
    instrumentId: z.string().uuid(),
    timeframe: z.string().min(1).max(8),
    lastCandleTime: z.number().int().positive(),
    lastScanAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ScannerCursorDto = z.infer<typeof scannerCursorDtoSchema>;

/** Health/status response for UI/API. */
export const scannerHealthDtoSchema = z
  .object({
    status: z.enum(['idle', 'running', 'degraded', 'unavailable']),
    lastRun: scannerRunDtoSchema.nullable(),
    lastSuccessfulRun: scannerRunDtoSchema.nullable(),
    provider: z.string().min(1).max(64).nullable(),
    isProviderAvailable: z.boolean(),
    expectedIntervalMs: z.number().int().positive(),
    activeRuns: z.number().int().min(0),
    recentFailures: z.number().int().min(0),
    dataFreshness: z
      .object({
        newestCandleTime: z.number().int().positive().nullable(),
        oldestStaleRejection: z.number().int().positive().nullable(),
        staleRejectionCount: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type ScannerHealthDto = z.infer<typeof scannerHealthDtoSchema>;

/** List runs query. */
export const scannerRunListQuerySchema = z
  .object({
    status: scannerRunStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ScannerRunListQuery = z.infer<typeof scannerRunListQuerySchema>;

/** Trigger request (manual scan). */
export const scannerTriggerRequestSchema = z
  .object({
    /** Optional: scan only this strategy (must be owned + active + published). */
    strategyId: z.string().uuid().optional(),
    /** Optional: scan only these instruments (must be within market universe). */
    instruments: z
      .array(
        z
          .object({
            assetClass: z.string().min(1).max(24),
            symbol: z.string().min(1).max(32),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    /** Force re-scan even if cursors indicate no new candle. */
    force: z.boolean().optional(),
  })
  .strict();
export type ScannerTriggerRequest = z.infer<typeof scannerTriggerRequestSchema>;
export type ScannerTriggerRequestInput = z.input<typeof scannerTriggerRequestSchema>;

/** Trigger response. */
export const scannerTriggerResponseSchema = z
  .object({
    run: scannerRunDtoSchema,
    skipped: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ScannerTriggerResponse = z.infer<typeof scannerTriggerResponseSchema>;

/** Scanner run list response. */
export const scannerRunListResponseSchema = z
  .object({
    runs: z.array(scannerRunDtoSchema).max(100),
  })
  .strict();
export type ScannerRunListResponse = z.infer<typeof scannerRunListResponseSchema>;

/**
 * Stale-data policy per timeframe (max age of latest closed candle before
 * it is considered stale and rejected for alert generation).
 *
 * Values are conservative: e.g. 5m candle should be at most 15m old, 1h at
 * most 2h old, 4h at most 8h old, 1d at most 36h old. These are production
 * safety thresholds — stale data never generates an alert.
 */
export const STALE_THRESHOLDS_MS: Record<string, number> = {
  '1m': 5 * 60_000,
  '3m': 10 * 60_000,
  '5m': 15 * 60_000,
  '15m': 45 * 60_000,
  '30m': 90 * 60_000,
  '1h': 2 * 60 * 60_000,
  '2h': 4 * 60 * 60_000,
  '4h': 8 * 60 * 60_000,
  '8h': 16 * 60 * 60_000,
  '12h': 24 * 60 * 60_000,
  '1d': 36 * 60 * 60_000,
  '3d': 4 * 24 * 60 * 60_000,
  '1w': 8 * 24 * 60 * 60_000,
  '1M': 35 * 24 * 60 * 60_000,
};

/**
 * Timeframe normalization map — supports common display variants.
 * The canonical set is TIMEFRAMES from timeframes.ts; this map handles
 * user/provider variants like "4H", "1D", "60m", etc.
 */
export const TIMEFRAME_ALIASES: Record<string, string> = {
  '1M': '1M',
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '60m': '1h',
  '1H': '1h',
  '2h': '2h',
  '2H': '2h',
  '120m': '2h',
  '4h': '4h',
  '4H': '4h',
  '240m': '4h',
  '8h': '8h',
  '8H': '8h',
  '12h': '12h',
  '12H': '12h',
  '1d': '1d',
  '1D': '1d',
  '1440m': '1d',
  '3d': '3d',
  '3D': '3d',
  '1w': '1w',
  '1W': '1w',
  '1M_MONTH': '1M',
};

/** Max provider retries with bounded backoff. */
export const SCANNER_MAX_RETRIES = 3;
export const SCANNER_RETRY_BASE_MS = 1000;
export const SCANNER_RETRY_MAX_MS = 10_000;

/** Provider timeout for scanner-initiated fetches. */
export const SCANNER_PROVIDER_TIMEOUT_MS = 15_000;

/** Max instruments per scan batch (prevents runaway). */
export const SCANNER_MAX_INSTRUMENTS_PER_RUN = 100;

/** Max strategies per scan batch. */
export const SCANNER_MAX_STRATEGIES_PER_RUN = 50;
