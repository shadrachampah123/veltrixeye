import { z } from 'zod';
import { conditionFailingCodeSchema, conditionSummarySchema } from './detection.js';

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
    id: z.string().guid(),
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

/* ------------------------------------------------------------------------- */
/* Phase B — per-pair evaluation observability                                */
/* ------------------------------------------------------------------------- */

/**
 * Why one (strategy, instrument) pair ended where it did.
 *
 * The four outcomes are MUTUALLY EXCLUSIVE: every pair that the scanner walks
 * produces exactly one, so `totals.pairs` always equals their sum.
 *
 *  - `evaluated`      — the pair reached the M3 engine; `conditions` is set.
 *  - `cursor_skipped` — the closed setup candle at `cursorMs` was already
 *                       processed for this pair (`scanner_cursors` hit).
 *                       This is an idempotent no-op, NOT an evaluation.
 *  - `stale`          — rejected before evaluation (MTF validation, freshness,
 *                       or no closed setup candle at the anchor).
 *  - `failed`         — an error aborted the pair (fetch, provider, detect).
 */
export const SCANNER_PAIR_OUTCOMES = ['evaluated', 'cursor_skipped', 'stale', 'failed'] as const;
export type ScannerPairOutcome = (typeof SCANNER_PAIR_OUTCOMES)[number];
export const scannerPairOutcomeSchema = z.enum(SCANNER_PAIR_OUTCOMES);

/** Bounded detail sample stored on a run. Totals are NEVER derived from it. */
export const SCANNER_RUN_PAIR_ITEMS_MAX = 200;
/** Short machine-ish cause codes (`cursor_hit`, `stale_candle`, …). */
export const SCANNER_RUN_PAIR_REASON_MAX_CHARS = 64;
/** Sanitized engine reasons kept per evaluated pair. */
export const SCANNER_RUN_PAIR_REASONS_MAX = 2;
export const SCANNER_RUN_PAIR_REASON_TEXT_MAX_CHARS = 160;

/* ------------------------------------------------------------------------- */
/* PR A — evaluation diagnostics                                             */
/* ------------------------------------------------------------------------- */

/**
 * The lifecycle stage a pair reached before it stopped.
 *
 * A pair walks these in order and the recorded value is the LAST one it
 * reached, so the stage alone answers "how far did this pair get?":
 *
 *   candles → validation → freshness → anchor → cursor → detection → persistence → complete
 *
 *  - `candles`     — fetching one of the three role batches failed.
 *  - `validation`  — `validateMultiTimeframe` rejected the data.
 *  - `freshness`   — a role's newest closed candle was too old.
 *  - `anchor`      — no fully-closed setup candle existed at scan time.
 *  - `cursor`      — the closed bar had already been processed (idempotent skip).
 *  - `detection`   — M3/M4 was invoked but produced no usable direction item.
 *  - `persistence` — detection qualified but the setup could not be persisted
 *                    (e.g. the plan's saved-setup limit).
 *  - `complete`    — both directions were evaluated; the pair is `evaluated`.
 */
export const SCANNER_PAIR_STAGES = [
  'candles',
  'validation',
  'freshness',
  'anchor',
  'cursor',
  'detection',
  'persistence',
  'complete',
] as const;
export type ScannerPairStage = (typeof SCANNER_PAIR_STAGES)[number];
export const scannerPairStageSchema = z.enum(SCANNER_PAIR_STAGES);

/**
 * Per-direction evaluation state.
 *
 *  - `qualified`     — the engine passed this direction (a setup was persisted).
 *  - `not_qualified` — the engine ran and rejected it; `failing` names why.
 *  - `blocked`       — the engine qualified it but persistence was refused by a
 *                      limit. A limit is not a strategy outcome.
 *  - `error`         — detection threw; the pair is `failed`.
 *  - `not_run`       — the detector returned no item for this direction, which
 *                      is NOT an evaluation.
 */
export const SCANNER_PAIR_DIRECTION_STATES = ['qualified', 'not_qualified', 'blocked', 'error', 'not_run'] as const;
export type ScannerPairDirectionState = (typeof SCANNER_PAIR_DIRECTION_STATES)[number];
export const scannerPairDirectionStateSchema = z.enum(SCANNER_PAIR_DIRECTION_STATES);

/** Bounded counts, so one run's metadata cannot be inflated by a pair. */
export const SCANNER_RUN_PAIR_DIAGNOSTIC_CODES_MAX = 6;
export const SCANNER_RUN_PAIR_FAILING_MAX = 4;
export const SCANNER_RUN_PAIR_CODE_MAX_CHARS = 64;

/**
 * Candidate-volume evidence for one role: how much history the pair actually
 * had. `candles` is the batch length handed to validation; `newestMs` is the
 * open time of its newest candle (null when the batch was empty). Small,
 * non-identifying numbers that make "insufficient history" distinguishable
 * from "conditions not met".
 */
const scannerPairRoleDataSchema = z
  .object({
    candles: z.number().int().min(0).max(1_000_000),
    newestMs: z.number().int().positive().nullable(),
  })
  .strict();
export type ScannerPairRoleData = z.infer<typeof scannerPairRoleDataSchema>;

const scannerPairDataSchema = z
  .object({ htf: scannerPairRoleDataSchema, setup: scannerPairRoleDataSchema, entry: scannerPairRoleDataSchema })
  .strict();
export type ScannerPairData = z.infer<typeof scannerPairDataSchema>;

/**
 * One direction's evaluation evidence.
 *
 * `failing` entries are `<conditionType>:<status>` and are validated against
 * the real enums (`conditionFailingCodeSchema`: the condition-type registry and
 * `CONDITION_FAILURE_STATUSES`), so an arbitrary machine-like token can never be
 * presented as condition evidence. Pair-level `codes` stay token-bounded rather
 * than enum-bounded, because provider failure kinds are extensible.
 */
const scannerPairDirectionDiagnosticSchema = z
  .object({
    state: scannerPairDirectionStateSchema,
    conditions: conditionSummarySchema.optional(),
    failing: z.array(conditionFailingCodeSchema).max(SCANNER_RUN_PAIR_FAILING_MAX).optional(),
  })
  .strict();
export type ScannerPairDirectionDiagnostic = z.infer<typeof scannerPairDirectionDiagnosticSchema>;

/**
 * Everything a pair can say about *why* it ended where it did, beyond its
 * outcome and reason code.
 *
 * Bounded, deterministic and identifier-free: `codes` are machine codes from a
 * fixed vocabulary, `data` is three pairs of numbers, and `directions` holds at
 * most two entries. Nothing here is free text, so nothing here can carry a
 * tenant identifier, a credential or a provider payload. Like the rest of
 * `items[]` it is only ever present in a run the viewer owns.
 */
export const scannerPairDiagnosticsSchema = z
  .object({
    stage: scannerPairStageSchema,
    /** Pair-level causes (`setup_limit_reached`, `insufficient_history`, …). */
    codes: z.array(z.string().min(1).max(SCANNER_RUN_PAIR_CODE_MAX_CHARS)).max(SCANNER_RUN_PAIR_DIAGNOSTIC_CODES_MAX).optional(),
    data: scannerPairDataSchema.optional(),
    directions: z
      .object({
        long: scannerPairDirectionDiagnosticSchema.optional(),
        short: scannerPairDirectionDiagnosticSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ScannerPairDiagnostics = z.infer<typeof scannerPairDiagnosticsSchema>;

/**
 * Well-known pair-level diagnostic codes. Not a closed enum (the `reason` field
 * has always been a bounded code, and provider failures contribute their own
 * `kind`), but the UI and the tests share this list so new codes are documented
 * in one place.
 *
 *  - `cursor_hit`             — the bar was already processed.
 *  - `no_closed_candle`       — nothing had closed at scan time.
 *  - `insufficient_history`   — too few candles for the roles to be correlated.
 *  - `setup_limit_reached`    — the plan's saved-setup limit refused persistence.
 *  - `detector_unavailable`   — the detector produced no direction item.
 *  - `setup_not_persisted`    — detection qualified but no setup row exists.
 */
export const SCANNER_PAIR_DIAGNOSTIC_CODES = [
  'cursor_hit',
  'no_closed_candle',
  'insufficient_history',
  'setup_limit_reached',
  'detector_unavailable',
  'setup_not_persisted',
] as const;
export type ScannerPairDiagnosticCode = (typeof SCANNER_PAIR_DIAGNOSTIC_CODES)[number];


const scannerPairTotalsSchema = z
  .object({
    pairs: z.number().int().min(0),
    evaluated: z.number().int().min(0),
    cursor_skipped: z.number().int().min(0),
    stale: z.number().int().min(0),
    failed: z.number().int().min(0),
  })
  .strict();

const scannerPairItemSchema = z
  .object({
    /** Owner-scrubbed by `redactScannerRunMetadata` for non-owners. */
    strategyId: z.string().guid(),
    assetClass: z.string().min(1).max(24),
    symbol: z.string().min(1).max(32),
    /** The cursor/setup timeframe this pair is keyed by. */
    timeframe: z.string().min(1).max(8),
    outcome: scannerPairOutcomeSchema,
    /** Closed setup-candle open time (ms) the cursor compares; null when none. */
    cursorMs: z.number().int().positive().nullable(),
    /** MTF anchor = cursorMs + setup period (ms); null when none. */
    anchorMs: z.number().int().positive().nullable(),
    reason: z.string().max(SCANNER_RUN_PAIR_REASON_MAX_CHARS).nullable(),
    conditions: conditionSummarySchema.optional(),
    /** Sanitized M3 reasons for `evaluated` pairs only (never for skips). */
    failureReasons: z
      .array(z.string().max(SCANNER_RUN_PAIR_REASON_TEXT_MAX_CHARS))
      .max(SCANNER_RUN_PAIR_REASONS_MAX)
      .optional(),
    /**
     * PR A: bounded evaluation evidence (stage, cause codes, per-role history,
     * per-direction state). Optional so every run recorded before PR A — and
     * every pair recorded without it — keeps parsing exactly as it did.
     */
    diagnostics: scannerPairDiagnosticsSchema.optional(),
  })
  .strict();

/**
 * The reconciliation every reader relies on: the four outcomes are mutually
 * exclusive, so they must add up to `totals.pairs`. Shared by the full block
 * and the aggregate-only projection so both refuse a corrupt ledger value.
 */
function assertPairTotalsReconcile(
  block: { totals: { pairs: number; evaluated: number; cursor_skipped: number; stale: number; failed: number } },
  ctx: z.RefinementCtx,
): void {
  const { totals } = block;
  const sum = totals.evaluated + totals.cursor_skipped + totals.stale + totals.failed;
  if (sum !== totals.pairs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totals'],
      message: 'pair outcomes are mutually exclusive: their sum must equal totals.pairs',
    });
  }
}

/**
 * Block versions a reader accepts.
 *
 *  - `1` — Phase B: outcomes, condition counts, sanitized reasons.
 *  - `2` — PR A: the same, plus the optional per-pair `diagnostics` object.
 *
 * A writer always stamps the newest version it produces (`2`). Readers accept
 * both because the new field is optional and because historical rows must keep
 * rendering; anything else is refused rather than guessed.
 */
export const SCANNER_RUN_PAIRS_VERSIONS = [1, 2] as const;
export type ScannerRunPairsVersion = (typeof SCANNER_RUN_PAIRS_VERSIONS)[number];

/**
 * `scanner_runs.metadata.pairs` (Phase B, extended by PR A). Additive: runs
 * recorded before this block existed carry no `pairs` key at all, so every
 * reader must treat a null parse as "detail unavailable" — never as zero.
 */
export const scannerRunPairsSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    /** Computed over ALL pairs, including those beyond the item cap. */
    totals: scannerPairTotalsSchema,
    /** Summed over `evaluated` pairs only (skips/stale/failed contribute 0). */
    conditions: conditionSummarySchema,
    /** True when `items` is a bounded sample of `totals.pairs`. */
    truncated: z.boolean(),
    items: z.array(scannerPairItemSchema).max(SCANNER_RUN_PAIR_ITEMS_MAX),
  })
  .strict()
  .superRefine((block, ctx) => {
    assertPairTotalsReconcile(block, ctx);
    if (block.items.length !== Math.min(SCANNER_RUN_PAIR_ITEMS_MAX, block.totals.pairs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'items must be exactly min(cap, totals.pairs)',
      });
    }
  });
export type ScannerRunPairs = z.infer<typeof scannerRunPairsSchema>;
export type ScannerPairItem = z.infer<typeof scannerPairItemSchema>;

/**
 * The aggregate half of `metadata.pairs`: counters, condition totals and the
 * truncation flag — no per-pair observations.
 *
 * This is everything a tenant viewer may see for a run they do not own. A single
 * `items[]` entry names one strategy's instrument, timeframe, candle timings and
 * outcome, which is enough to fingerprint a tenant's strategy activity even
 * after `strategyId`/`versionId`/`failureReasons` are stripped. System runs mix
 * pairs from every tenant, so tenant-facing responses publish this projection
 * only (see `redactScannerRunForViewer`); operator reads keep the full block.
 */
export const scannerRunPairAggregateSchema = z
  .object({
    v: z.union([z.literal(1), z.literal(2)]),
    totals: scannerPairTotalsSchema,
    conditions: conditionSummarySchema,
    truncated: z.boolean(),
  })
  .strict()
  .superRefine(assertPairTotalsReconcile);
export type ScannerRunPairAggregate = z.infer<typeof scannerRunPairAggregateSchema>;

/**
 * Read `metadata.pairs` without throwing.
 *
 * Returns null for historical runs (no key), malformed blocks, or a future
 * schema version — callers render "detail unavailable" instead of guessing.
 * Also null for the aggregate-only projection tenants receive for runs they do
 * not own: there is no per-pair sample to read. Use
 * {@link readScannerRunPairAggregate} for the counters.
 */
export function readScannerRunPairs(metadata: Record<string, unknown> | null | undefined): ScannerRunPairs | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const parsed = scannerRunPairsSchema.safeParse((metadata as Record<string, unknown>).pairs);
  return parsed.success ? parsed.data : null;
}

/**
 * Read the aggregate half of `metadata.pairs` without throwing.
 *
 * Accepts both shapes: a complete block (owner and operator reads) and the
 * aggregate-only projection a tenant receives for a run they do not own, where
 * `items` is absent by design rather than corrupt. Returns null when there is no
 * usable block — historical run, unknown version, malformed or unreconciled
 * counters — so callers render "unavailable" instead of zeros.
 */
export function readScannerRunPairAggregate(
  metadata: Record<string, unknown> | null | undefined,
): ScannerRunPairAggregate | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const pairs = (metadata as Record<string, unknown>).pairs;
  if (pairs === null || typeof pairs !== 'object' || Array.isArray(pairs)) return null;
  const { v, totals, conditions, truncated } = pairs as Record<string, unknown>;
  const parsed = scannerRunPairAggregateSchema.safeParse({ v, totals, conditions, truncated });
  return parsed.success ? parsed.data : null;
}


/** Per-cursor state (last processed candle). */
export const scannerCursorDtoSchema = z
  .object({
    strategyVersionId: z.string().guid(),
    instrumentId: z.string().guid(),
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

/**
 * Which slice of the run ledger a tenant read may see.
 *
 * `scanner_runs` is a single global table: automatic runs carry
 * `metadata.triggeredBy = 'system'` and belong to no tenant, while manual runs
 * carry the UUID of the user who triggered them.
 *
 *  - `mine`   — only the caller's own runs (the pre-existing behaviour, and the
 *               default, so an old client keeps exactly what it had).
 *  - `system` — only system-triggered runs. They contain no tenant identifiers,
 *               but their metadata is still passed through
 *               `redactScannerRunForViewer` so the safety does not depend on
 *               that remaining true.
 *  - `all`    — the caller's own runs plus system runs. Never another tenant's.
 *
 * Every scope is available only to a scanner-entitled caller: the route rejects
 * free users before the query is even parsed.
 *
 * Tenant-facing responses never carry `metadata.pairs.items[]` for a run the
 * caller does not own — system runs mix pairs from every tenant, and one
 * observation fingerprints a strategy's instrument, timeframe and timing even
 * without its UUID. The aggregate half of the block (`v`, `totals`,
 * `conditions`, `truncated`) is preserved, so outcome breakdowns stay available;
 * read it with `readScannerRunPairAggregate`. Owner runs and trusted operator
 * reads keep the per-pair detail.
 */
export const SCANNER_RUN_SCOPES = ['mine', 'system', 'all'] as const;
export type ScannerRunScope = (typeof SCANNER_RUN_SCOPES)[number];
export const scannerRunScopeSchema = z.enum(SCANNER_RUN_SCOPES);

/** List runs query. */
export const scannerRunListQuerySchema = z
  .object({
    status: scannerRunStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    scope: scannerRunScopeSchema.default('mine'),
  })
  .strict();
export type ScannerRunListQuery = z.infer<typeof scannerRunListQuerySchema>;
/**
 * The same query with `scope` optional.
 *
 * HTTP callers always parse through `scannerRunListQuerySchema` (so they carry
 * the default), but in-process callers that predate scopes — and tests written
 * before them — keep compiling against the pre-scope shape.
 */
export type ScannerRunListQueryInput = Omit<ScannerRunListQuery, 'scope'> & { scope?: ScannerRunScope };

/** Trigger request (manual scan). */
export const scannerTriggerRequestSchema = z
  .object({
    /** Optional: scan only this strategy (must be owned + active + published). */
    strategyId: z.string().guid().optional(),
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

/**
 * Stale-run recovery lease bounds (M7 audit finding F3).
 *
 * A `scanner_runs` row still in `status = 'running'` past its lease is an
 * orphaned run from a crashed or sleeping instance and is recovered to
 * `failed` before new scans execute.
 */
export const DEFAULT_SCANNER_LEASE_MS = 30 * 60_000;
export const MIN_SCANNER_LEASE_MS = 30_000;
export const MAX_SCANNER_LEASE_MS = 2 * 60 * 60_000;

/**
 * Terminal scanner-run retention (M7 audit finding F15).
 *
 * `scanner_runs` gains ~288 rows/day at the 5-minute cadence. Completed and
 * failed runs older than this many days are pruned by the scanner maintenance
 * sweep. `running` runs and `scanner_cursors` are never pruned.
 */
export const DEFAULT_SCANNER_RUN_RETENTION_DAYS = 90;
export const MIN_SCANNER_RUN_RETENTION_DAYS = 1;
export const MAX_SCANNER_RUN_RETENTION_DAYS = 3650;

/**
 * Body of the internal scanner worker trigger (`POST /api/internal/scanner/run`).
 *
 * Strictly forbids tenant/content parameters (`strategyId`, `userId`,
 * `instruments`, `payload`, etc.): an external scheduler can only ask to run
 * a platform scan cycle, never target a tenant.
 */
export const scannerInternalRunRequestSchema = z
  .object({
    /** Force re-scan even if cursors indicate no new closed candle. */
    force: z.boolean().optional(),
    /** Optional stale-run recovery lease override (ms). */
    leaseMs: z.number().int().min(MIN_SCANNER_LEASE_MS).max(MAX_SCANNER_LEASE_MS).optional(),
  })
  .strict();
export type ScannerInternalRunRequest = z.infer<typeof scannerInternalRunRequestSchema>;
export type ScannerInternalRunRequestInput = z.input<typeof scannerInternalRunRequestSchema>;

/**
 * Result of one internal scanner worker invocation (`POST /api/internal/scanner/run`).
 *
 * `run` is redacted for operator/scheduler consumption (no tenant or strategy
 * UUIDs, no unredacted error text) and is `null` when skipped before a run row
 * exists (e.g. provider unavailable or lock contention on an empty ledger).
 */
export const scannerInternalRunResponseSchema = z
  .object({
    run: scannerRunDtoSchema.nullable(),
    skipped: z.boolean(),
    reason: z.string().min(1).max(64).optional(),
    /** Stale `running` runs recovered prior to this invocation. */
    recovered: z.number().int().min(0),
  })
  .strict();
export type ScannerInternalRunResponse = z.infer<typeof scannerInternalRunResponseSchema>;

/**
 * Body of the internal scanner maintenance trigger (`POST /api/internal/scanner/maintenance`).
 */
export const scannerInternalMaintenanceRequestSchema = z
  .object({
    /** Stale-run recovery lease (ms). */
    leaseMs: z.number().int().min(MIN_SCANNER_LEASE_MS).max(MAX_SCANNER_LEASE_MS).optional(),
  })
  .strict();
export type ScannerInternalMaintenanceRequest = z.infer<typeof scannerInternalMaintenanceRequestSchema>;
export type ScannerInternalMaintenanceRequestInput = z.input<typeof scannerInternalMaintenanceRequestSchema>;

/**
 * Result of internal scanner maintenance (`POST /api/internal/scanner/maintenance`).
 *
 * Reports stale recovery and operational counts only — never tenant identifiers,
 * credentials, or raw error text.
 */
export const scannerInternalMaintenanceResponseSchema = z
  .object({
    recovered: z.number().int().min(0),
    activeRuns: z.number().int().min(0),
    recentFailures: z.number().int().min(0),
    status: z.enum(['idle', 'running', 'degraded', 'unavailable']),
    isProviderAvailable: z.boolean(),
  })
  .strict();
export type ScannerInternalMaintenanceResponse = z.infer<typeof scannerInternalMaintenanceResponseSchema>;
