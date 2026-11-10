import type pg from 'pg';
import {
  DEFAULT_SCANNER_LEASE_MS,
  DEFAULT_SCANNER_RUN_RETENTION_DAYS,
  MAX_SCANNER_RUN_RETENTION_DAYS,
  MIN_SCANNER_RUN_RETENTION_DAYS,
  SCANNER_ADVISORY_LOCK_KEY,
  SCANNER_MAX_RETRIES,
  SCANNER_RETRY_BASE_MS,
  SCANNER_RETRY_MAX_MS,
  SCANNER_PROVIDER_TIMEOUT_MS,
  SCANNER_MAX_INSTRUMENTS_PER_RUN,
  SCANNER_MAX_STRATEGIES_PER_RUN,
  SCANNER_EXPECTED_INTERVAL_MS,
  type Timeframe,
  type ScannerRunDto,
  type ScannerHealthDto,
  type ScannerRunListQueryInput,
  type ScannerInternalRunResponse,
  type ScannerInternalMaintenanceResponse,
  type AssetClass,
  type ConditionSummary,
  type ScannerPairOutcome,
  type ScannerRunPairs,
  SCANNER_RUN_PAIR_ITEMS_MAX,
  SCANNER_RUN_PAIR_REASONS_MAX,
  SCANNER_RUN_PAIR_REASON_MAX_CHARS,
  SCANNER_RUN_PAIR_REASON_TEXT_MAX_CHARS,
  SCANNER_PAIR_DIRECTION_STATES,
  SCANNER_RUN_PAIR_CODE_MAX_CHARS,
  SCANNER_RUN_PAIR_DIAGNOSTIC_CODES_MAX,
  SCANNER_RUN_PAIR_FAILING_MAX,
  conditionFailingCode,
  parseConditionFailingCode,
  scannerPairDiagnosticsSchema,
  type ScannerPairData,
  type ScannerPairDiagnostics,
  type ScannerPairDirectionDiagnostic,
  type ScannerPairRoleData,
  type ScannerPairStage,
  timeframeMinutes,
} from '@veltrixeye/contracts';
import { DomainError, Errors } from '../errors.js';
import type { ProviderRegistry } from '../market-data/registry.js';
import type { CandleStore } from '../market-data/candles.js';
import type { IngestionService } from '../market-data/ingestion.js';
import type { EvaluationService } from '../strategies/evaluation/service.js';
import type { SetupService } from '../setups/service.js';
import type { ScoringService } from '../scoring/service.js';
import type { AlertService } from '../alerts/service.js';
import { resolveEntitlements } from '../billing/entitlement-resolution.js';
import {
  acquireSessionAdvisoryLock,
  deriveAdvisoryLockTiming,
  holderLogMeta,
  type AdvisoryLockRelease,
  type SessionAdvisoryLock,
} from '../db/advisory-lock.js';
import type { UserPlan } from '@veltrixeye/contracts';
import { normalizeSymbol, normalizeTimeframe, normalizeCandleBatch } from './normalization.js';
import { validateCandleBatch, validateMultiTimeframe } from './validation.js';
import { checkFreshness, checkMultiTimeframeFreshness } from './freshness.js';

/**
 * Live scanner service (M7.5) — production market-data and scanner pipeline.
 *
 * Pipeline:
 *   Market Data → Normalization → Validation/Freshness → Strategy Detection
 *   → Setup Qualification → Scoring → Risk/Quality Validation → Alert Generation
 *   → Notification Outbox
 *
 * Guarantees:
 *  - No mock/demo data in production: provider must exist, otherwise 502
 *  - Advisory locking prevents overlapping scans
 *  - Cursors prevent re-processing same candle
 *  - Setup idempotency (version, instrument, direction, asOf) prevents duplicate setups
 *  - Alert idempotency (setup_id, trigger_state) prevents duplicate alerts
 *  - Stale/invalid data never generates alerts
 *  - Entitlements enforced server-side
 *  - Bounded retries with backoff
 *  - Safe on restart (stale running runs recovered)
 *  - Structured operational logging (no secrets)
 */

/**
 * One retention sweep attempt, handed to the optional `onRetentionSweep`
 * observer after EVERY sweep — including one that deleted nothing (the normal
 * case in a young ledger) and one that failed.
 *
 * WHY THIS EXISTS. Before this observation existed, a sweep left a trace only
 * when it deleted at least one row (a single info log). "No log line" was
 * therefore indistinguishable between "the sweep ran and found nothing to do"
 * and "the sweep never ran at all", and the operator surface exposed no sweep
 * timing whatsoever. Observing every attempt closes that gap without reading
 * logs or holding a worker token.
 *
 * PRIVACY CONTRACT — the observation carries counts, timings and the applied
 * window only. Never a row id, a tenant/strategy identifier, an SQL statement,
 * a provider payload or an error message (`failed` carries the thrown value
 * only so a caller can reduce it to a bounded machine code).
 */
export type RetentionSweepObservation =
  | {
      outcome: 'completed';
      /** Rows deleted by this sweep; 0 means nothing was eligible. */
      deleted: number;
      /** Terminal-run retention window the sweep applied, in days. */
      retentionDays: number;
      /** Bounded statements the sweep issued. */
      batches: number;
      /**
       * True when the final permitted statement deleted a full batch, i.e. the
       * sweep stopped at its ceiling and eligible rows may remain for the next
       * sweep. False means the ledger is fully drained for this window.
       */
      batchCeilingReached: boolean;
      /** Sweep duration in milliseconds. */
      durationMs: number;
      /** Completion time (epoch ms). */
      sweptAtMs: number;
    }
  | {
      outcome: 'failed';
      /** Terminal-run retention window the sweep attempted to apply, in days. */
      retentionDays: number;
      /** Duration until the failure, in milliseconds. */
      durationMs: number;
      /** Failure time (epoch ms). */
      sweptAtMs: number;
      /** The thrown value, for the observer to reduce to a machine code. */
      error: unknown;
    };

export interface ScannerServiceOptions {
  providerTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  expectedIntervalMs?: number;
  leaseMs?: number;
  /** Terminal (completed/failed) scanner-run retention in days (F15). */
  runRetentionDays?: number;
  logger?: ScannerLogger;
  /**
   * Optional secret-redaction callback (defence in depth) applied to error
   * strings before they are stored on `scanner_runs` or written to logs.
   */
  redact?: (text: string) => string;
  /**
   * Optional observer invoked after every retention sweep attempt (including a
   * zero-delete sweep and a failed one) so an operator surface can prove the
   * maintenance path actually executes. Observability must never break
   * maintenance: a throwing observer is caught, counted as a warn-level log and
   * never propagates into `pruneTerminalRuns`.
   */
  onRetentionSweep?: (observation: RetentionSweepObservation) => void;
  /**
   * How often (ms) the running scan re-proves that it still owns the advisory
   * lock. `0` disables the heartbeat. Defaults to a quarter of `leaseMs`
   * (minimum 1s), so ownership is re-checked several times per lease window
   * without adding measurable database load.
   */
  advisoryLockHeartbeatMs?: number;
  /**
   * Idle age (ms) at which the session currently holding the scanner lock is
   * reported as *suspected orphaned* when a cycle cannot acquire it. This is
   * diagnostic only — nothing is terminated automatically.
   */
  advisoryLockOrphanIdleMs?: number;
}

export interface ScannerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Rows deleted per statement by the terminal-run retention sweep (F15). */
const SCANNER_RUN_PRUNE_BATCH_SIZE = 500;
/** Upper bound on statements per sweep so one maintenance call stays short. */
const SCANNER_RUN_PRUNE_MAX_BATCHES = 20;

/**
 * Reduce any thrown value to a short, message-free machine code for logging.
 *
 * Only `name` (never `message`, whose text can echo row values or a connection
 * string) is read, and it must match a strict bounded shape — so a hostile or
 * merely unusual `name` cannot smuggle arbitrary text into a log line. This
 * mirrors the normalization the API applies to the codes it serves
 * unauthenticated, so an operator sees the same token in both places.
 */
function boundedErrorCode(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/.test(name) ? name.toLowerCase() : 'unknown';
}

/** Clamp a retention window to the documented bounds; invalid ⇒ default. */
export function clampRetentionDays(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SCANNER_RUN_RETENTION_DAYS;
  return Math.min(
    MAX_SCANNER_RUN_RETENTION_DAYS,
    Math.max(MIN_SCANNER_RUN_RETENTION_DAYS, Math.trunc(value)),
  );
}

const DEFAULT_LOGGER: ScannerLogger = {
  info: (msg, meta) => console.info(`[scanner] ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg, meta) => console.warn(`[scanner] ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg, meta) => console.error(`[scanner] ${msg}`, meta ? JSON.stringify(meta) : ''),
};

export interface ScanTriggerArgs {
  strategyId?: string;
  instruments?: { assetClass: string; symbol: string }[];
  force?: boolean;
  initiatedBy?: string;
  nowMs?: number;
}

/**
 * Tenant-privacy: `scanner_runs` is a single global ledger shared by every
 * tenant and by the scheduled system runner, and `metadata` records
 * tenant-identifying values. These keys must never be returned to a viewer who
 * does not own the run (M7 final verification audit, finding F4):
 *
 *  - `triggeredBy` — UUID of the user who initiated the run (or `'system'`).
 *  - `strategyId`  — UUID of the strategy the run was scoped to.
 *  - `errors`      — entries are serialized as `strategy <uuid>: <message>`
 *                    (see `executeScan`), so the strings embed strategy UUIDs.
 *
 * Owner-scoped reads (see `listRuns`) already filter rows down to the caller's
 * own runs; redaction is the second layer, applied to the shared/global read
 * paths (health) that must keep showing the whole ledger's operational state.
 */
export const SCANNER_TENANT_SENSITIVE_METADATA_KEYS = ['triggeredBy', 'strategyId', 'errors'] as const;

/**
 * Options for {@link redactScannerRunMetadata}. Omitting them yields the
 * tenant-facing projection, which is the safe default.
 */
export interface ScannerRunMetadataRedactionOptions {
  /**
   * Keep `metadata.pairs.items[]` (the per-pair observations). Only trusted
   * internal/operator reads set this; tenant-facing reads never do, because a
   * single observation fingerprints one tenant's strategy activity.
   */
  keepPairObservations?: boolean;
}

/**
 * Strip tenant-identifying scanner-run metadata unless the run belongs to
 * `viewerUserId`. Pure and deterministic — no I/O.
 *
 * A run is the viewer's own when `metadata.triggeredBy` equals their user id;
 * system runs (`triggeredBy = 'system'`) belong to no tenant and are redacted
 * for every tenant viewer. Everything non-identifying (status-bearing counts,
 * `force`, and any future non-sensitive key) is preserved so the run stays
 * operationally useful for triage.
 *
 * For a run the viewer does not own, `metadata.pairs` is reduced to its
 * aggregate half: `v`, `totals`, `conditions` and `truncated` survive, while the
 * individual observations in `items` are dropped. Those observations describe
 * one `(strategy, instrument, timeframe)` each — `symbol`, `timeframe`,
 * `outcome`, `cursorMs`/`anchorMs` and `reason` reveal tenant-specific strategy
 * activity even with every strategy UUID stripped. System runs aggregate pairs
 * from every tenant, so their observations are never tenant-facing. Operator
 * reads pass `keepPairObservations` to retain the detail.
 *
 * Fails closed on an unexpected shape: if `pairs` is an array, a primitive,
 * `null`, or an object whose aggregate fields are not numeric counters, the key
 * is removed instead of being forwarded, so no malformed value can bypass the
 * allowlist. A run with no `pairs` key at all (historical) is left as it is.
 */
export function redactScannerRunMetadata(
  metadata: Record<string, unknown>,
  viewerUserId: string,
  options: ScannerRunMetadataRedactionOptions = {},
): Record<string, unknown> {
  if (metadata.triggeredBy === viewerUserId) return { ...metadata };
  const stripped = stripSensitiveMetadata(metadata, 0) as Record<string, unknown>;
  return options.keepPairObservations === true ? stripped : dropPairObservations(stripped);
}

/** `{}`-style value: not `null` and not an array. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A counters object — every value is a finite number. Rejects arrays, `null`,
 * primitives and any nested payload, so the projection can never forward a shape
 * it did not whitelist field by field.
 */
function isNumericRecord(value: unknown): value is Record<string, number> {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

/**
 * Project `metadata.pairs` down to the aggregate half (`v`, `totals`,
 * `conditions`, `truncated`) — an ALLOWLIST: a field added to the block later
 * stays tenant-invisible until it is added here deliberately.
 *
 * **Fails closed.** Only a plain object carrying a finite numeric `v`,
 * numeric-only `totals` and `conditions`, and a boolean `truncated` is accepted.
 * An array, a primitive, `null`, or an object with any unexpected field type
 * returns `null`, and the caller removes the key entirely. Returning such a
 * value unchanged (or partially projected) would let an unexpected shape reach a
 * tenant viewer without passing the allowlist; removing it makes readers render
 * "unavailable" instead of guessing.
 */
function aggregatePairCounters(pairs: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(pairs)) return null;
  const { v, totals, conditions, truncated } = pairs;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (!isNumericRecord(totals) || !isNumericRecord(conditions)) return null;
  if (typeof truncated !== 'boolean') return null;
  // Deep-copies, so the caller cannot reach the dropped record through a shared
  // reference (the input is never mutated).
  return { v, totals: { ...totals }, conditions: { ...conditions }, truncated };
}

/**
 * Reduce `metadata.pairs` to its aggregate half, dropping the per-pair
 * observations. Never mutates the input and never throws: a block that is not a
 * valid aggregate projection is removed rather than forwarded (see
 * {@link aggregatePairCounters}).
 */
function dropPairObservations(metadata: Record<string, unknown>): Record<string, unknown> {
  // No block at all is a historical run, not malformed data: leave the key absent.
  if (!Object.prototype.hasOwnProperty.call(metadata, 'pairs')) return { ...metadata };
  const { pairs, ...rest } = metadata;
  const aggregate = aggregatePairCounters(pairs);
  return aggregate === null ? rest : { ...rest, pairs: aggregate };
}

/**
 * Keys that must never reach a viewer who does not own the run, **at any
 * depth**. Phase B added `metadata.pairs.items[]`, whose entries carry the
 * strategy UUID and the engine's failure reasons for that strategy — both are
 * tenant information, and a top-level-only filter would have leaked them into
 * `getHealth` (which is global) and into the operator/scheduler responses.
 *
 * `errors` and `failureReasons` are dropped too: their strings describe one
 * tenant's strategy internals even when no UUID appears in the text.
 */
const SCANNER_REDACTED_METADATA_KEYS = new Set<string>([
  ...SCANNER_TENANT_SENSITIVE_METADATA_KEYS,
  'versionId',
  'failureReasons',
]);

/** Recursion bound: current metadata nests 3 levels (`pairs.items[]`). */
const SCANNER_METADATA_MAX_DEPTH = 6;

/**
 * Deep-copy `value`, dropping every redacted key. Never mutates the input.
 * Bounded depth and array-safe, so a malformed/oversized metadata blob cannot
 * cause unbounded work.
 */
function stripSensitiveMetadata(value: unknown, depth: number): unknown {
  if (depth > SCANNER_METADATA_MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => stripSensitiveMetadata(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SCANNER_REDACTED_METADATA_KEYS.has(key)) continue;
    out[key] = stripSensitiveMetadata(entry, depth + 1);
  }
  return out;
}

/**
 * Redact a fully-mapped run DTO for a tenant viewer. Pure — no I/O.
 *
 * This is the only shape that reaches a tenant: identifiers stripped, and for
 * runs the viewer does not own (system runs, other tenants' runs) the per-pair
 * observations are replaced by their aggregate totals.
 */
export function redactScannerRunForViewer(run: ScannerRunDto, viewerUserId: string): ScannerRunDto {
  const isOwner = run.metadata.triggeredBy === viewerUserId;
  return {
    ...run,
    error:
      run.error === null
        ? null
        : isOwner
          ? sanitizeScannerError(run.error, undefined, SCANNER_RUN_ERROR_MAX_CHARS, false)
          : sanitizeScannerError(run.error, undefined, SCANNER_RUN_ERROR_MAX_CHARS, true),
    metadata: redactScannerRunMetadata(run.metadata, viewerUserId),
  };
}

/**
 * Redact a fully-mapped run DTO for operator/scheduler consumption
 * (e.g. `POST /api/internal/scanner/run`).
 *
 * Strips all tenant-identifying metadata (`triggeredBy`, `strategyId`, `errors`,
 * `versionId`, `failureReasons`) and sanitizes `error` so no tenant/strategy
 * UUIDs or secrets are returned. This is a trusted path, so the per-pair
 * observations (`metadata.pairs.items[]`) are preserved for triage — only the
 * identifiers inside them are removed. Pure and deterministic — no I/O.
 */
export function redactScannerRunForOperator(
  run: ScannerRunDto,
  redact?: (text: string) => string,
): ScannerRunDto {
  return {
    ...run,
    error: run.error === null ? null : sanitizeScannerError(run.error, redact, SCANNER_RUN_ERROR_MAX_CHARS, true),
    // Operator read: keep the per-pair observations (identifiers already gone).
    metadata: redactScannerRunMetadata(run.metadata, '', { keepPairObservations: true }),
  };
}

/**
 * Bounded cause code for a pair that threw (Phase B).
 *
 * Reuses the domain error code when there is one, so a triage view can tell a
 * provider outage from an invalid configuration without storing the message.
 * Never returns free text, never contains tenant identifiers.
 */
function classifyPairFailure(err: unknown): string {
  if (err instanceof DomainError) return String(err.code).slice(0, SCANNER_RUN_PAIR_REASON_MAX_CHARS);
  // Provider failures carry a bounded `kind` (`rate_limited`, `unavailable`, …)
  // rather than a domain code; it is exactly the triage signal we want.
  if (err instanceof Error && err.name === 'ProviderError' && typeof (err as { kind?: unknown }).kind === 'string') {
    return String((err as unknown as { kind: string }).kind).slice(0, SCANNER_RUN_PAIR_REASON_MAX_CHARS);
  }
  return 'error';
}

/**
 * Build the persisted `metadata.pairs` block (Phase B).
 *
 * Guarantees, all covered by tests:
 *  - **Mutually exclusive**: each observation contributes to exactly one of the
 *    four outcome counters, so their sum is `totals.pairs`.
 *  - **Totals are computed over ALL pairs**, never over the stored sample.
 *  - **Deterministic sample**: `items` is the first `SCANNER_RUN_PAIR_ITEMS_MAX`
 *    observations in a content-derived order (assetClass, symbol, timeframe,
 *    strategyId, outcome) — independent of strategy iteration order, so the
 *    same run always persists the same sample.
 *  - **Bounded**: reasons are truncated, and `failureReasons` is only ever set
 *    for `evaluated` pairs (a skip is not an evaluation and carries no engine
 *    reasons).
 *
 * Pure and deterministic — no I/O, no clock, no input mutation.
 */
export function buildScannerRunPairs(observations: readonly PairObservation[]): ScannerRunPairs {
  const totals: ScannerRunPairs['totals'] = {
    pairs: observations.length,
    evaluated: 0,
    cursor_skipped: 0,
    stale: 0,
    failed: 0,
  };
  const conditions: ConditionSummary = { satisfied: 0, unsatisfied: 0, insufficient_data: 0, unsupported: 0 };

  for (const observation of observations) {
    totals[observation.outcome] += 1;
    if (observation.outcome === 'evaluated' && observation.conditions) {
      conditions.satisfied += observation.conditions.satisfied;
      conditions.unsatisfied += observation.conditions.unsatisfied;
      conditions.insufficient_data += observation.conditions.insufficient_data;
      conditions.unsupported += observation.conditions.unsupported;
    }
  }

  const ordered = [...observations].sort(comparePairObservations);
  const sampled = ordered.slice(0, SCANNER_RUN_PAIR_ITEMS_MAX);

  return {
    // PR A writes block version 2: the item shape gained the optional
    // `diagnostics` object. Version 1 blocks stay readable.
    v: 2,
    totals,
    conditions,
    truncated: observations.length > sampled.length,
    items: sampled.map((observation) => {
      const item: ScannerRunPairs['items'][number] = {
        strategyId: observation.strategyId,
        assetClass: observation.assetClass,
        symbol: observation.symbol,
        timeframe: observation.timeframe,
        outcome: observation.outcome,
        cursorMs: observation.cursorMs,
        anchorMs: observation.anchorMs,
        reason: observation.reason === null ? null : observation.reason.slice(0, SCANNER_RUN_PAIR_REASON_MAX_CHARS),
      };
      if (observation.outcome === 'evaluated' && observation.conditions) item.conditions = observation.conditions;
      if (observation.outcome === 'evaluated' && observation.failureReasons && observation.failureReasons.length > 0) {
        item.failureReasons = observation.failureReasons
          .slice(0, SCANNER_RUN_PAIR_REASONS_MAX)
          .map((reason) => reason.slice(0, SCANNER_RUN_PAIR_REASON_TEXT_MAX_CHARS));
      }
      // Normalised here too, so a caller-built observation can never persist a
      // block that violates the contract's bounds.
      const diagnostics = normalisePairDiagnostics(observation.diagnostics);
      if (diagnostics) item.diagnostics = diagnostics;
      return item;
    }),
  };
}

/** Content-derived total order: deterministic regardless of scan order. */
function comparePairObservations(a: PairObservation, b: PairObservation): number {
  return (
    a.assetClass.localeCompare(b.assetClass) ||
    a.symbol.localeCompare(b.symbol) ||
    a.timeframe.localeCompare(b.timeframe) ||
    a.strategyId.localeCompare(b.strategyId) ||
    a.outcome.localeCompare(b.outcome)
  );
}

/**
 * A diagnostic code is a machine token: lowercase words joined by `_`, `:` or
 * `-` (e.g. `setup_limit_reached`, `rate_limited`). Anything else — spaces,
 * uppercase prose, `…` from a truncated message — is not evidence, and is
 * refused instead of being stored.
 *
 * Pair-level codes stay token-bounded rather than enum-bounded so provider
 * failure kinds can grow without a contract change. Direction `failing` codes
 * are stricter: they must parse as `<conditionType>:<status>` from the real
 * enums (see `uniqueFailingCodes`).
 */
const DIAGNOSTIC_CODE_PATTERN = /^[a-z][a-z0-9_:-]*$/;

/** Upper bound for any diagnostic counter, so one value cannot distort a block. */
const DIAGNOSTIC_COUNT_MAX = 1_000_000;

/**
 * A non-null, non-array object — i.e. something whose properties are safe to
 * read. The normaliser is a *runtime* boundary for caller-built observations,
 * so it can never rely on TypeScript types alone: `codes: 42`, `failing: {}` or
 * `directions: "x"` all reach here from untyped JSON-shaped callers.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * PR A — bound, validate and canonicalise one pair's diagnostics.
 *
 * **Fail-closed by construction and by runtime guard.** Every container and
 * every nested value is checked before it is touched, the object is rebuilt
 * from the verified parts, and the result is then re-parsed against
 * `scannerPairDiagnosticsSchema`. If anything is malformed the offending part is
 * dropped — and if the rebuilt object still fails the contract parse, the whole
 * diagnostics object is dropped. The function never throws, so a hand-built or
 * corrupt observation cannot abort a scan run's persistence.
 *
 *  - a non-object, an unknown `stage`, or a `stage` that fails the contract
 *    parse drops everything (we cannot say where the pair stopped);
 *  - `codes` / `failing` must be **actual arrays**; a string, number or object
 *    is rejected outright instead of being iterated. Entries are trimmed,
 *    de-duplicated and capped, and each must be a bounded machine token —
 *    `failing` entries must additionally name a real condition type and a real
 *    failure status. **Nothing is truncated into an apparently valid code**;
 *  - `data` is all-or-nothing: the three roles are required by the contract, so
 *    one malformed role drops the whole object rather than half of it;
 *  - a direction entry must be a non-null plain object with a known `state`,
 *    otherwise it is dropped; a malformed `conditions` block is dropped while
 *    the verified `state` survives.
 *
 * Valid input is preserved exactly and the function is idempotent, so the
 * persisted form is deterministic.
 */
export function normalisePairDiagnostics(diagnostics: unknown): ScannerPairDiagnostics | undefined {
  if (!isPlainObject(diagnostics)) return undefined;

  const codes = uniqueBoundedCodes(diagnostics.codes, SCANNER_RUN_PAIR_DIAGNOSTIC_CODES_MAX);
  const data = normalisePairData(diagnostics.data);
  const directions = normaliseDirections(diagnostics.directions);

  const candidate = {
    stage: diagnostics.stage,
    ...(codes.length > 0 ? { codes } : {}),
    ...(data ? { data } : {}),
    ...(directions ? { directions } : {}),
  };

  // Final gate: if the rebuilt object is still not a valid contract block (an
  // unknown stage, for example), nothing is persisted rather than something
  // that merely looks like diagnostics.
  const parsed = scannerPairDiagnosticsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function normaliseDirections(directions: unknown): ScannerPairDiagnostics['directions'] | undefined {
  if (!isPlainObject(directions)) return undefined;
  const out: NonNullable<ScannerPairDiagnostics['directions']> = {};
  for (const direction of ['long', 'short'] as const) {
    const entry = directions[direction];
    // A missing, null, array or primitive entry is not a direction observation.
    if (!isPlainObject(entry)) continue;
    const state: unknown = entry.state;
    if (typeof state !== 'string' || !(SCANNER_PAIR_DIRECTION_STATES as readonly string[]).includes(state)) continue;
    const conditions = normaliseConditions(entry.conditions);
    const failing = uniqueFailingCodes(entry.failing, SCANNER_RUN_PAIR_FAILING_MAX);
    out[direction] = {
      state: state as (typeof SCANNER_PAIR_DIRECTION_STATES)[number],
      ...(conditions ? { conditions } : {}),
      ...(failing.length > 0 ? { failing } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Three verified per-role counts, or nothing: a partial `data` is not stored. */
function normalisePairData(data: unknown): ScannerPairData | undefined {
  if (!isPlainObject(data)) return undefined;
  const htf = normaliseRoleData(data.htf);
  const setup = normaliseRoleData(data.setup);
  const entry = normaliseRoleData(data.entry);
  if (!htf || !setup || !entry) return undefined;
  return { htf, setup, entry };
}

function normaliseRoleData(role: unknown): ScannerPairRoleData | undefined {
  if (!isPlainObject(role)) return undefined;
  const candles: unknown = role.candles;
  if (!isDiagnosticCount(candles)) return undefined;
  // A timestamp is validated as a positive safe integer, not as a bounded
  // counter: epoch milliseconds are legitimately far above `DIAGNOSTIC_COUNT_MAX`.
  const newestMs: unknown = role.newestMs;
  if (newestMs === null) return { candles, newestMs: null };
  if (typeof newestMs !== 'number' || !Number.isSafeInteger(newestMs) || newestMs <= 0) return undefined;
  return { candles, newestMs };
}

function normaliseConditions(conditions: unknown): ConditionSummary | undefined {
  if (!isPlainObject(conditions)) return undefined;
  const keys = ['satisfied', 'unsatisfied', 'insufficient_data', 'unsupported'] as const;
  const out = {} as ConditionSummary;
  for (const key of keys) {
    const value: unknown = conditions[key];
    if (!isDiagnosticCount(value)) return undefined;
    out[key] = value;
  }
  return out;
}

function isDiagnosticCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= DIAGNOSTIC_COUNT_MAX;
}

/**
 * Trim, validate, de-duplicate and cap pair-level codes — order preserved.
 *
 * `value` is deliberately `unknown`: a non-array (including a string, which is
 * iterable and would otherwise decompose into single characters) is rejected
 * outright. Individual entries that are not bounded machine tokens are dropped,
 * never shortened into something the contract would accept.
 */
function uniqueBoundedCodes(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (out.length >= max) break;
    if (typeof raw !== 'string') continue;
    const code = raw.trim();
    if (code.length === 0 || code.length > SCANNER_RUN_PAIR_CODE_MAX_CHARS) continue;
    if (!DIAGNOSTIC_CODE_PATTERN.test(code)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * Validate, de-duplicate and cap `failing` entries — order preserved.
 *
 * Each entry must parse as `<conditionType>:<status>` from the real enums, so a
 * machine-*like* token (`foo:bar`, `liquidity_sweep:satisfied`) is refused
 * rather than presented as condition evidence. Same non-array guard as the
 * pair-level codes: a string or object is not iterated.
 */
function uniqueFailingCodes(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (out.length >= max) break;
    const code = parseConditionFailingCode(raw);
    if (!code) continue;
    const formatted = `${code.conditionType}:${code.status}`;
    if (!out.includes(formatted)) out.push(formatted);
  }
  return out;
}

/** One role's candle volume: the count handed to validation and its newest open. */
function roleDataOf(candles: readonly { time: number }[]): ScannerPairRoleData {
  const newest = candles[candles.length - 1];
  const newestMs = newest && Number.isInteger(newest.time) && newest.time > 0 ? newest.time : null;
  return { candles: candles.length, newestMs };
}

/**
 * Turn M4's bounded condition diagnostics into `<type>:<status>` codes.
 *
 * Closed vocabulary, enforced at write time: `conditionFailingCode` accepts
 * only a condition type from `CONDITION_TYPE_REGISTRY` and a status from
 * `CONDITION_FAILURE_STATUSES`, so no user or provider text can reach run
 * metadata and an arbitrary token can never look like condition evidence.
 */
function failingConditionCodes(outcomes: readonly { conditionType: string; status: string }[] | undefined): string[] {
  const codes: string[] = [];
  for (const outcome of outcomes ?? []) {
    if (codes.length >= SCANNER_RUN_PAIR_FAILING_MAX) break;
    // Enum-validated by the shared helper: a condition type that is not in the
    // registry, or a status that is not a failure status, produces nothing.
    const code = conditionFailingCode(outcome.conditionType, outcome.status);
    if (!code || code.length > SCANNER_RUN_PAIR_CODE_MAX_CHARS) continue;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

const UNLOCK_ERROR_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UNLOCK_ERROR_URL_CREDENTIALS_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const UNLOCK_ERROR_BEARER_PATTERN = /\b(bearer)\s+[^\s,;]+/gi;
const UNLOCK_ERROR_SECRET_ASSIGNMENT_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*)([^\s,;]+)/gi;
const SCANNER_SECRET_ASSIGNMENT_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|authorization|x-veltrixeye-worker-token)\b(\s*[:=]\s*)([^\s,&;]+)/gi;
const SCANNER_SECRET_KEY_PREFIX_PATTERN = /\bsk_(?:live|test)_[A-Za-z0-9_-]+/g;
const UNLOCK_ERROR_MAX_CHARS = 256;
export const SCANNER_ERROR_MAX_CHARS = 500;
export const SCANNER_RUN_ERROR_MAX_CHARS = 2000;

/**
 * Sanitize and bound a scanner / provider / worker error string without leaking
 * URL credentials, Bearer tokens, API keys, worker tokens, configured secrets,
 * or (when `redactUuids` is true) tenant/strategy UUIDs (M7 audit findings F3/F4/F5).
 * Pure and deterministic — no I/O.
 */
export function sanitizeScannerError(
  err: unknown,
  redact?: (text: string) => string,
  maxChars = SCANNER_ERROR_MAX_CHARS,
  redactUuids = true,
): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown_error';
  const collapsed = raw.replace(/\s+/g, ' ').trim() || 'unknown_error';
  const customRedacted = redact ? redact(collapsed) : collapsed;
  const patternRedacted = customRedacted
    .replace(UNLOCK_ERROR_URL_CREDENTIALS_PATTERN, '$1[redacted]@')
    .replace(UNLOCK_ERROR_BEARER_PATTERN, '$1 [redacted]')
    .replace(SCANNER_SECRET_ASSIGNMENT_PATTERN, '$1$2[redacted]')
    .replace(SCANNER_SECRET_KEY_PREFIX_PATTERN, '[redacted]');
  const finalRedacted = redactUuids
    ? patternRedacted.replace(UNLOCK_ERROR_UUID_PATTERN, '[redacted-id]')
    : patternRedacted;
  const limit = Math.max(2, Math.trunc(maxChars));
  return finalRedacted.length > limit
    ? `${finalRedacted.slice(0, limit - 1)}…`
    : finalRedacted;
}

/**
 * Extract safe, bounded diagnostic details from an advisory-unlock error
 * without leaking credentials, tokens, connection strings, or tenant/strategy
 * UUIDs (M7 audit finding F5). Pure and deterministic — no I/O.
 */
export function sanitizeScannerUnlockError(err: unknown): { error: string; code?: string } {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown_error';
  const collapsed = raw.replace(/\s+/g, ' ').trim() || 'unknown_error';
  const redacted = collapsed
    .replace(UNLOCK_ERROR_URL_CREDENTIALS_PATTERN, '$1[redacted]@')
    .replace(UNLOCK_ERROR_BEARER_PATTERN, '$1 [redacted]')
    .replace(UNLOCK_ERROR_SECRET_ASSIGNMENT_PATTERN, '$1$2[redacted]')
    .replace(UNLOCK_ERROR_UUID_PATTERN, '[redacted-id]');
  const error =
    redacted.length > UNLOCK_ERROR_MAX_CHARS
      ? `${redacted.slice(0, UNLOCK_ERROR_MAX_CHARS)}…`
      : redacted;
  const code =
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string' &&
    /^[A-Z0-9_]{1,32}$/i.test((err as { code: string }).code)
      ? (err as { code: string }).code
      : undefined;
  return code !== undefined ? { error, code } : { error };
}

export interface ScanRunResult {
  run: ScannerRunDto;
  skipped?: boolean;
  reason?: string;
}

interface EligibleStrategy {
  strategyId: string;
  versionId: string;
  versionNumber: number;
  userId: string;
  plan: UserPlan;
  status: string;
  timeframes: { htf_bias: Timeframe; setup: Timeframe; entry: Timeframe };
  marketScope: { mode: 'all' | 'instruments'; instruments?: { assetClass: AssetClass; symbol: string; instrumentId: string }[] };
}

/**
 * Phase B observability: what happened to ONE (strategy, instrument) pair.
 *
 * Exactly one of these is produced per pair the scanner walks, and its
 * `outcome` is one of four mutually exclusive values. The scanner's existing
 * counters remain the source of truth for the run columns; these observations
 * are the per-pair breakdown and are cross-checked against them (see
 * `buildScannerRunPairs`).
 */
interface PairObservation {
  strategyId: string;
  assetClass: string;
  symbol: string;
  /** The cursor/setup timeframe this pair is keyed by. */
  timeframe: Timeframe;
  outcome: ScannerPairOutcome;
  /** Closed setup-candle open (ms) compared against the cursor; null if none. */
  cursorMs: number | null;
  /** MTF anchor (ms) = cursorMs + setup period. */
  anchorMs: number | null;
  /** Short cause code: `cursor_hit`, `mtf_invalid`, `stale_candle`, … */
  reason: string | null;
  /** `evaluated` only: summed condition statuses across both directions. */
  conditions?: ConditionSummary;
  /** `evaluated` only: sanitized M3 reasons (bounded). Never set for skips. */
  failureReasons?: string[];
  /**
   * PR A: bounded evaluation evidence — the stage the pair stopped at, cause
   * codes, per-role candle counts and per-direction states.
   *
   * Set on every exit path (see `flushDiagnostics` in `scanPairCore`), so a
   * pair that never reached the detector is distinguishable from one the
   * detector rejected. Optional for backward compatibility with observations
   * built by older callers and tests.
   */
  diagnostics?: ScannerPairDiagnostics;
}

interface ScanMetrics {
  strategiesScanned: number;
  instrumentsScanned: number;
  /**
   * TOTAL candles handed to the pipeline this run
   * (`candlesFromStore + candlesFromProvider`).
   *
   * Phase A observability: this is what `scanner_runs.candles_fetched` and the
   * Scanner UI's "Candles" metric report. Before Phase A the counter was
   * incremented only on the provider fetch-through path, so a scan served
   * entirely by the shared CandleStore reported zero candles processed.
   */
  candlesFetched: number;
  /** Candles served by the CandleStore fast path (read, normalized, validated, fresh). */
  candlesFromStore: number;
  /** Candles returned by the market-data provider (fetch-through) — the historical meaning of `candlesFetched`. */
  candlesFromProvider: number;
  setupsDetected: number;
  setupsCreated: number;
  alertsCreated: number;
  staleRejections: number;
  providerFailures: number;
  symbolsProcessed: Set<string>;
  timeframesProcessed: Set<string>;
  errors: string[];
  /**
   * Phase B: one observation per (strategy, instrument) pair walked.
   *
   * Single source of truth for the cursor-skip count: `metadata.duplicateCandleSkips`
   * is DERIVED from `pairs` (`totals.cursor_skipped`) when the run completes, so
   * the per-pair detail and the historical counter cannot drift apart.
   */
  pairs: PairObservation[];
}

/**
 * Attribute `count` candles to exactly one source and to the run total.
 *
 * This is the single funnel for candle accounting: the total is advanced
 * exactly once here, on whichever path actually loaded the candles, so
 * `candlesFetched === candlesFromStore + candlesFromProvider` always holds and
 * no candle can be counted twice. Per-cycle cache hits are re-uses of a batch
 * the loading pair already counted, so they deliberately add nothing.
 */
function recordCandleLoad(metrics: ScanMetrics, source: 'store' | 'provider', count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  if (source === 'store') metrics.candlesFromStore += count;
  else metrics.candlesFromProvider += count;
  metrics.candlesFetched += count;
}

/**
 * P2 — per-scan-cycle candle cache.
 *
 * When multiple strategies share the same instrument × timeframe (common:
 * EURUSD/4h used by both strategy A's HTF bias and strategy B's setup),
 * the scanner fetches the same candles multiple times. This cache deduplicates
 * those fetches within a single scan cycle: the first request does the full
 * fetch-through, subsequent requests for the same key get the cached result.
 *
 * The cache is scoped to one scan cycle (created in `executeScan`, discarded
 * after it completes) so it never serves stale data across cycles.
 */
type ScanCycleCacheKey = string; // `${assetClass}/${symbol}/${timeframe}`
interface CachedCandleBatch {
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number | null }[];
}
type ScanCycleCache = Map<ScanCycleCacheKey, CachedCandleBatch>;

function makeCacheKey(assetClass: string, symbol: string, timeframe: string): ScanCycleCacheKey {
  return `${assetClass}/${symbol}/${timeframe}`;
}

export class ScannerService {
  private readonly providerTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly expectedIntervalMs: number;
  private readonly leaseMs: number;
  private readonly advisoryLockHeartbeatMs: number;
  private readonly advisoryLockOrphanIdleMs: number;
  private readonly runRetentionDays: number;
  private readonly logger: ScannerLogger;
  private readonly redact: (text: string) => string;
  private readonly onRetentionSweep?: (observation: RetentionSweepObservation) => void;
  private readonly inFlightRuns = new Set<Promise<unknown>>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly providerRegistry: ProviderRegistry,
    private readonly candleStore: CandleStore,
    private readonly ingestion: IngestionService,
    private readonly evaluation: EvaluationService,
    private readonly setups: SetupService,
    private readonly scoring: ScoringService,
    private readonly alerts: AlertService,
    options: ScannerServiceOptions = {},
  ) {
    this.providerTimeoutMs = options.providerTimeoutMs ?? SCANNER_PROVIDER_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? SCANNER_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? SCANNER_RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? SCANNER_RETRY_MAX_MS;
    this.expectedIntervalMs = options.expectedIntervalMs ?? SCANNER_EXPECTED_INTERVAL_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_SCANNER_LEASE_MS;
    // One derivation for both values (db/advisory-lock.ts): the heartbeat is
    // capped at 60s so a lost lock is detected inside the lease, and the orphan
    // threshold is at least two heartbeats so a *healthy* job that is merely
    // idle between checks is never reported as abandoned.
    const lockTiming = deriveAdvisoryLockTiming({
      leaseMs: this.leaseMs,
      ...(options.advisoryLockHeartbeatMs !== undefined
        ? { heartbeatMs: options.advisoryLockHeartbeatMs }
        : {}),
      ...(options.advisoryLockOrphanIdleMs !== undefined
        ? { orphanIdleMs: options.advisoryLockOrphanIdleMs }
        : {}),
    });
    this.advisoryLockHeartbeatMs = lockTiming.heartbeatMs;
    this.advisoryLockOrphanIdleMs = lockTiming.orphanIdleMs;
    this.runRetentionDays = clampRetentionDays(options.runRetentionDays);
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.redact = options.redact ?? ((text: string) => text);
    this.onRetentionSweep = options.onRetentionSweep;
  }

  /** Number of currently in-flight scan invocations on this service instance. */
  get activeInFlightCount(): number {
    return this.inFlightRuns.size;
  }

  /**
   * Wait for all currently in-flight scan invocations to finish and release
   * their advisory locks before shutdown closes the database pool.
   */
  async waitForInFlight(): Promise<void> {
    while (this.inFlightRuns.size > 0) {
      await Promise.allSettled([...this.inFlightRuns]);
    }
  }

  /**
   * Get scanner health/status for UI/API.
   * Reflects real production state, not mock/static.
   *
   * `viewerUserId` (tenant read) keeps the health view global — the scanner is
   * one shared pipeline and its operational state is not per-tenant — but
   * redacts tenant-identifying metadata from the embedded `lastRun` /
   * `lastSuccessfulRun` DTOs (M7 audit finding F4). Omit it for trusted
   * internal/operator reads that need the unredacted ledger.
   */
  async getHealth(viewerUserId?: string): Promise<ScannerHealthDto> {
    const toRunDto = (row: ScannerRunRow): ScannerRunDto =>
      viewerUserId === undefined ? toScannerRunDto(row) : redactScannerRunForViewer(toScannerRunDto(row), viewerUserId);

    const provider = this.requireProviderSafe();
    const isProviderAvailable = provider !== null;

    const activeRunsRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text as count FROM scanner_runs WHERE status = 'running'`,
    );
    const activeRuns = Number(activeRunsRes.rows[0]?.count ?? 0);

    const recentFailuresRes = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text as count FROM scanner_runs WHERE status = 'failed' AND started_at > now() - interval '1 hour'`,
    );
    const recentFailures = Number(recentFailuresRes.rows[0]?.count ?? 0);

    const lastRunRes = await this.pool.query<ScannerRunRow>(
      `SELECT * FROM scanner_runs ORDER BY started_at DESC LIMIT 1`,
    );
    const lastRun = lastRunRes.rows[0] ? toRunDto(lastRunRes.rows[0]) : null;

    const lastSuccessfulRes = await this.pool.query<ScannerRunRow>(
      `SELECT * FROM scanner_runs WHERE status = 'completed' ORDER BY finished_at DESC LIMIT 1`,
    );
    const lastSuccessfulRun = lastSuccessfulRes.rows[0] ? toRunDto(lastSuccessfulRes.rows[0]) : null;

    const newestCandleRes = await this.pool.query<{ latest: string | null }>(
      `SELECT max(ts)::text as latest FROM candles`,
    );
    const newestCandleTime = newestCandleRes.rows[0]?.latest ? Number(newestCandleRes.rows[0].latest) : null;

    const staleStatsRes = await this.pool.query<{ count: string; oldest: string | null }>(
      `SELECT count(*)::text as count, min(started_at)::text as oldest FROM scanner_runs WHERE stale_rejections > 0 AND started_at > now() - interval '24 hours'`,
    );

    let status: ScannerHealthDto['status'] = 'idle';
    if (activeRuns > 0) status = 'running';
    else if (!isProviderAvailable) status = 'unavailable';
    else if (recentFailures > 3) status = 'degraded';

    return {
      status,
      lastRun,
      lastSuccessfulRun,
      provider: provider?.id ?? null,
      isProviderAvailable,
      expectedIntervalMs: this.expectedIntervalMs,
      activeRuns,
      recentFailures,
      dataFreshness: {
        newestCandleTime,
        oldestStaleRejection: null,
        staleRejectionCount: Number(staleStatsRes.rows[0]?.count ?? 0),
      },
    };
  }

  /**
   * List recent scanner runs.
   *
   * `scanner_runs` is a global ledger, and `metadata` records the
   * tenant-identifying `triggeredBy` user UUID and `strategyId` strategy UUID,
   * so an unscoped read would expose other tenants' identifiers to any
   * entitled caller (M7 final verification audit, finding F4).
   *
   * Pass `viewerUserId` for every tenant-facing read. `query.scope` decides the
   * slice, and it defaults to `mine`, which is the original privacy boundary:
   *
   *  - `mine`   — only runs that user initiated;
   *  - `system` — system runs only (`triggeredBy = 'system'`), which belong to no
   *               tenant and are the automatic 5-minute scan cycle;
   *  - `all`    — the caller's own runs plus system runs, never another tenant's.
   *
   * Whatever the scope, every returned row is passed through
   * `redactScannerRunForViewer`, so `triggeredBy`/`strategyId`/`versionId`/
   * `errors`/`failureReasons` are stripped (at any depth) from any run the
   * viewer does not own — including every system run.
   *
   * Omit `viewerUserId` only for trusted internal/operator reads that must see
   * the whole ledger (ops scripts, diagnostics).
   */
  async listRuns(query: ScannerRunListQueryInput, viewerUserId?: string): Promise<{ runs: ScannerRunDto[] }> {
    const values: unknown[] = [];
    const where: string[] = [];
    // Default `mine` reproduces the pre-scope behaviour exactly: an old client
    // that never sends `scope` keeps seeing precisely what it saw before.
    const scope = query.scope ?? 'mine';

    if (viewerUserId !== undefined) {
      switch (scope) {
        case 'mine':
          values.push(viewerUserId);
          where.push(`metadata->>'triggeredBy' = $${values.length}`);
          break;
        case 'system':
          // A literal, never caller-supplied: system runs belong to no tenant.
          where.push(`metadata->>'triggeredBy' = 'system'`);
          break;
        case 'all':
          values.push(viewerUserId);
          where.push(`(metadata->>'triggeredBy' = $${values.length} OR metadata->>'triggeredBy' = 'system')`);
          break;
      }
    } else if (scope === 'system') {
      // Trusted in-process/operator callers may narrow the whole ledger too.
      where.push(`metadata->>'triggeredBy' = 'system'`);
    }

    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    values.push(query.limit);
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const res = await this.pool.query<ScannerRunRow>(
      `SELECT * FROM scanner_runs ${whereClause} ORDER BY started_at DESC LIMIT $${values.length}`,
      values,
    );

    // Defence in depth: every tenant-facing row goes through the redactor, even
    // the caller's own (`mine`) rows and even system rows that already carry no
    // tenant identifiers. Redaction therefore does not depend on the WHERE
    // clause being right — a future scope that widens the selection cannot leak
    // by accident.
    //
    // For system rows this also drops `metadata.pairs.items[]` (see
    // `redactScannerRunMetadata`): those observations are per-strategy, and a
    // system run mixes every tenant's strategies. The caller's own rows keep
    // them, and `pairs.totals`/`conditions` stay visible for every row.
    const runs = res.rows.map((row) => {
      const dto = toScannerRunDto(row);
      return viewerUserId === undefined ? dto : redactScannerRunForViewer(dto, viewerUserId);
    });
    return { runs };
  }

  /**
   * Recover stale running runs (e.g., after process restart or container sleep).
   * Marks runs older than lease as failed.
   */
  async recoverStaleRuns(leaseMs = this.leaseMs): Promise<{ recovered: number }> {
    const res = await this.pool.query(
      `UPDATE scanner_runs SET status = 'failed', finished_at = now(), error = 'recovered: stale running run after restart', updated_at = now()
       WHERE status = 'running' AND started_at < now() - ($1::bigint * interval '1 millisecond')
       RETURNING id`,
      [leaseMs],
    );
    const recovered = res.rowCount ?? 0;
    if (recovered > 0) {
      this.logger.warn('recovered stale scanner runs', { recovered, leaseMs });
    }
    return { recovered };
  }

  /**
   * Bounded retention for the `scanner_runs` ledger (M7 audit finding F15).
   *
   * Deletes `completed` and `failed` runs whose `started_at` is older than the
   * configured retention window. Safety rules:
   *  - `running` and `partial` rows are never deleted (only the two terminal
   *    statuses the retention policy names are candidates);
   *  - `scanner_cursors` is a separate table and is never touched;
   *  - the newest terminal run and the newest completed run (the rows behind
   *    `getHealth().lastRun` / `lastSuccessfulRun`) are always kept, so health
   *    output does not regress when the system has been idle past retention;
   *  - at most `SCANNER_RUN_PRUNE_BATCH_SIZE` rows per statement, at most
   *    `SCANNER_RUN_PRUNE_MAX_BATCHES` statements per sweep, `FOR UPDATE SKIP
   *    LOCKED` so a concurrent sweep or writer never blocks;
   *  - idempotent: a repeat sweep deletes only rows that became eligible since
   *    the last one (none, if nothing aged out). Terminal rows never change
   *    status, so there is no race with `completeRun` / `recoverStaleRuns`,
   *    which only touch `running` rows.
   *
   * Logs counts only (no run ids, tenant or strategy data). Returns the number
   * of rows deleted in this sweep.
   */
  async pruneTerminalRuns(args: { retentionDays?: number } = {}): Promise<number> {
    const retentionDays = clampRetentionDays(args.retentionDays ?? this.runRetentionDays);
    const startedAtMs = Date.now();
    let deleted = 0;
    let batches = 0;
    let batchCeilingReached = false;
    try {
      for (let batch = 0; batch < SCANNER_RUN_PRUNE_MAX_BATCHES; batch++) {
        const res = await this.pool.query(
          `DELETE FROM scanner_runs
            WHERE id IN (
              SELECT r.id FROM scanner_runs r
               WHERE r.status IN ('completed', 'failed')
                 AND r.started_at < now() - ($1::int * interval '1 day')
                 AND r.id NOT IN (
                   SELECT k.id FROM scanner_runs k
                    WHERE k.status IN ('completed', 'failed')
                    ORDER BY k.started_at DESC LIMIT 1
                 )
                 AND r.id NOT IN (
                   SELECT k.id FROM scanner_runs k
                    WHERE k.status = 'completed'
                    ORDER BY k.finished_at DESC NULLS LAST LIMIT 1
                 )
               ORDER BY r.started_at ASC
               LIMIT $2
               FOR UPDATE SKIP LOCKED
            )`,
          [retentionDays, SCANNER_RUN_PRUNE_BATCH_SIZE],
        );
        batches += 1;
        const n = res.rowCount ?? 0;
        deleted += n;
        if (n < SCANNER_RUN_PRUNE_BATCH_SIZE) break;
        // A full batch on the final permitted statement means the ceiling
        // stopped us with eligible rows possibly still pending.
        batchCeilingReached = batch === SCANNER_RUN_PRUNE_MAX_BATCHES - 1;
      }
    } catch (error) {
      // Never swallow: the maintenance caller decides how to handle a failed
      // sweep. The observation is recorded first so the failure is visible on
      // the operator surface even though this call rejects.
      this.notifyRetentionSweep({
        outcome: 'failed',
        retentionDays,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        sweptAtMs: Date.now(),
        error,
      });
      throw error;
    }
    if (deleted > 0) {
      this.logger.info('scanner run retention', { deleted, retentionDays });
    }
    this.notifyRetentionSweep({
      outcome: 'completed',
      deleted,
      retentionDays,
      batches,
      batchCeilingReached,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      sweptAtMs: Date.now(),
    });
    return deleted;
  }

  /**
   * Hand one sweep observation to the optional observer. Observability is
   * strictly subordinate to maintenance: a throwing observer is reduced to a
   * bounded machine code in a warn-level log and never propagates, so a broken
   * metrics sink can never stop retention or a scan cycle.
   */
  private notifyRetentionSweep(observation: RetentionSweepObservation): void {
    const observer = this.onRetentionSweep;
    if (observer === undefined) return;
    try {
      observer(observation);
    } catch (err) {
      this.logger.warn('retention sweep observer failed', {
        error: boundedErrorCode(err),
        outcome: observation.outcome,
      });
    }
  }

  /**
   * Trigger a scan (manual or scheduled).
   * Uses advisory locking to prevent overlapping scans and tracks in-flight
   * executions so graceful shutdown can await completion before pool teardown.
   */
  async triggerScan(args: ScanTriggerArgs = {}): Promise<ScanRunResult> {
    const p = this.triggerScanInternal(args);
    this.inFlightRuns.add(p);
    try {
      return await p;
    } finally {
      this.inFlightRuns.delete(p);
    }
  }

  private async triggerScanInternal(args: ScanTriggerArgs = {}): Promise<ScanRunResult> {
    const nowMs = args.nowMs ?? Date.now();

    // Try advisory lock (hardened: pid-recorded acquire, proven ownership,
    // classified release — see db/advisory-lock.ts).
    const lockClient = await this.pool.connect();
    let destroyLockClient = false;
    try {
      const lockRes = await acquireSessionAdvisoryLock(lockClient, SCANNER_ADVISORY_LOCK_KEY, {
        orphanIdleMs: this.advisoryLockOrphanIdleMs,
        logger: this.logger,
        label: 'scanner advisory lock',
      });

      if (!lockRes.acquired) {
        // An acquire that could not be proven (query error, or a lock that is
        // not visible on the acquiring backend — e.g. a transaction-mode
        // connection pooler) must never be treated as ordinary contention:
        // the session is evicted so it cannot retain an orphaned lock, and the
        // cycle is reported as skipped rather than silently overlapping.
        if (lockRes.mustDestroyClient) {
          destroyLockClient = true;
          this.logger.error('scanner advisory lock acquire failed', {
            lockKey: SCANNER_ADVISORY_LOCK_KEY,
            reason: lockRes.reason ?? 'not_owned',
            ...(lockRes.code !== undefined ? { code: lockRes.code } : {}),
            connectionDestroyed: true,
          });
          const lastRun = await this.lastRunOrNull();
          if (lastRun) {
            return { run: lastRun, skipped: true, reason: 'already_running' };
          }
          throw Errors.conflict('Scanner lock could not be acquired safely');
        }

        this.logger.info('scan skipped: already running', {
          lockKey: SCANNER_ADVISORY_LOCK_KEY,
          ...holderLogMeta(lockRes.holder ?? null),
        });
        // Return last run info
        const lastRun = await this.lastRunOrNull();
        if (lastRun) {
          return { run: lastRun, skipped: true, reason: 'already_running' };
        }
        throw Errors.conflict('Scanner is already running');
      }

      const lock = lockRes.lock!;
      const heartbeat = this.startAdvisoryLockHeartbeat(lock);
      try {
        return await this.executeScan(args, nowMs, heartbeat);
      } finally {
        heartbeat.stop();
        const release = await lock.release();
        if (!release.released) {
          destroyLockClient = true;
          this.logAdvisoryLockReleaseFailure(release);
        }
      }
    } finally {
      if (destroyLockClient) {
        if (typeof (lockClient as { end?: unknown }).end === 'function') {
          await (lockClient as unknown as { end: () => Promise<void> }).end().catch(() => {});
        }
        lockClient.release(true);
      } else {
        lockClient.release();
      }
    }
  }

  /** Most recent scanner run (operator-safe DTO), or null when none exists. */
  private async lastRunOrNull(): Promise<ScannerRunDto | null> {
    const lastRunRes = await this.pool.query<ScannerRunRow>(
      `SELECT * FROM scanner_runs ORDER BY started_at DESC LIMIT 1`,
    );
    return lastRunRes.rows[0] ? toScannerRunDto(lastRunRes.rows[0]) : null;
  }

  /**
   * Re-verify lock ownership while a scan runs.
   *
   * A scan can hold the advisory lock for minutes while its lock session sits
   * idle, so ownership must be re-proven rather than assumed: if the session
   * that holds the lock disappears (server-side kill, idle timeout, pooler
   * reassignment, or an operator terminating the backend) PostgreSQL drops the
   * lock, and a *second* scan can then acquire it. Continuing here would mean
   * two scans detecting the same setups concurrently. The heartbeat therefore
   * flips `lost` and the scan aborts at the next strategy boundary.
   *
   * The timer is `unref`'d so it never keeps the process alive, and the check
   * is serialized: a slow database cannot stack overlapping verifications.
   */
  private startAdvisoryLockHeartbeat(lock: SessionAdvisoryLock): {
    /** True once ownership has been disproven (cheap, non-blocking). */
    isLost(): boolean;
    /** Prove ownership again *now*; false when it is gone (blocking). */
    verifyNow(): Promise<boolean>;
    stop(): void;
  } {
    const state = { lost: false };
    const intervalMs = this.advisoryLockHeartbeatMs;
    const markLost = (reason: string | undefined, code: string | undefined): void => {
      if (state.lost) return;
      state.lost = true;
      this.logger.error('scanner advisory lock lost while scanning', {
        lockKey: SCANNER_ADVISORY_LOCK_KEY,
        reason: reason ?? 'not_owned',
        ...(code !== undefined ? { code } : {}),
      });
    };

    // One verification at a time: the timer and the in-run checkpoints share
    // this lock session, and `pg` must not interleave queries on one client.
    // Every call is appended to a chain, so a slow database cannot stack
    // overlapping verifications either.
    let queue: Promise<unknown> = Promise.resolve();
    const verify = (): Promise<boolean> => {
      const run = queue.then(async () => {
        if (state.lost) return false;
        try {
          const check = await lock.verify();
          if (!check.owned) {
            markLost(check.reason, check.code);
            return false;
          }
          return true;
        } catch {
          // An unreadable verification is not proof of ownership: fail closed.
          markLost('query_error', undefined);
          return false;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    };

    const timer = intervalMs > 0 ? setInterval(() => void verify(), intervalMs) : null;
    timer?.unref?.();
    return {
      // A method (not a readonly property) so TypeScript cannot narrow the
      // result of an earlier check across later `await` boundaries — the flag
      // genuinely can change while the scan runs.
      isLost: () => state.lost,
      verifyNow: verify,
      stop() {
        if (timer !== null) clearInterval(timer);
      },
    };
  }

  /**
   * Prove this run still owns the advisory lock, immediately before recording a
   * terminal status. Throws a `conflict` error (which the run's catch block
   * records as `failed`) when ownership cannot be proven.
   *
   * Every path that writes a *successful* run must go through this: a cached
   * heartbeat flag can be stale by the time the status is decided, and a
   * zero-work run ("no eligible strategies") is still a run that must not be
   * reported as successful while another scan may hold the lock.
   */
  private async assertLockOwnership(
    lockGuard?: { isLost(): boolean; verifyNow(): Promise<boolean> },
  ): Promise<void> {
    if (lockGuard === undefined) return;
    if (await lockGuard.verifyNow()) return;
    throw Errors.conflict('Scanner advisory lock was lost; aborting this run');
  }

  /**
   * Log a non-clean advisory-lock release with a bounded machine-readable
   * reason and, when readable, the session that holds the lock instead. No
   * secrets, no connection string, no tenant identifiers.
   */
  private logAdvisoryLockReleaseFailure(release: AdvisoryLockRelease): void {
    const reason =
      release.reason === 'not_owned'
        ? 'unlock_returned_false'
        : release.reason === 'session_changed'
          ? 'session_changed'
          : release.reason === 'still_held'
            ? 'still_held'
            : 'query_error';
    // A thrown unlock keeps its redacted message/SQLSTATE (M7 audit F5): the
    // message is sanitized here, never logged raw.
    const sanitized =
      release.error !== undefined ? sanitizeScannerUnlockError(release.error) : undefined;
    this.logger.error('scanner advisory unlock failed', {
      lockKey: SCANNER_ADVISORY_LOCK_KEY,
      unlocked: false,
      reason,
      ...(sanitized !== undefined ? { error: sanitized.error } : {}),
      ...(sanitized?.code !== undefined
        ? { code: sanitized.code }
        : release.code !== undefined
          ? { code: release.code }
          : {}),
      ...holderLogMeta(release.holder),
      connectionDestroyed: true,
    });
  }

  /**
   * Alias for triggerScan — used by worker ticker.
   */
  async runOnce(args: ScanTriggerArgs = {}): Promise<ScanRunResult> {
    return this.triggerScan(args);
  }

  /**
   * Sleep-safe worker invocation (M7 audit finding F3).
   *
   * Safe to invoke from an external cron scheduler (`POST /api/internal/scanner/run`)
   * or the in-process ticker simultaneously:
   *  1. Recovers stale `running` runs past `leaseMs` (crash / sleep-resume recovery).
   *  2. Fails closed (`skipped: true, reason: 'provider_unavailable'`) if no
   *     market-data provider is registered.
   *  3. Executes one system scan cycle under `SCANNER_ADVISORY_LOCK_KEY`,
   *     returning `skipped: true, reason: 'already_running'` on contention.
   *  4. Redacts all tenant/strategy identifiers and sanitizes error text on the
   *     returned run DTO.
   */
  async runWorkerOnce(
    args: { force?: boolean; leaseMs?: number; nowMs?: number } = {},
  ): Promise<ScannerInternalRunResponse> {
    const leaseMs = args.leaseMs ?? this.leaseMs;
    const { recovered } = await this.recoverStaleRuns(leaseMs);

    if (!this.requireProviderSafe()) {
      this.logger.warn('scanner worker skipped: provider unavailable', { recovered });
      return {
        run: null,
        skipped: true,
        reason: 'provider_unavailable',
        recovered,
      };
    }

    try {
      const result = await this.triggerScan({
        force: args.force,
        initiatedBy: 'system',
        nowMs: args.nowMs,
      });
      if (result.skipped) {
        return {
          run: null,
          skipped: true,
          reason: result.reason ?? 'already_running',
          recovered,
        };
      }
      return {
        run: redactScannerRunForOperator(result.run, this.redact),
        skipped: false,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        recovered,
      };
    } catch (err) {
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: unknown }).code === 'conflict'
      ) {
        return {
          run: null,
          skipped: true,
          reason: 'already_running',
          recovered,
        };
      }
      throw err;
    }
  }

  /**
   * Internal scanner maintenance (`POST /api/internal/scanner/maintenance`, F3):
   * recovers stale `running` runs and returns bounded, tenant-free operational
   * status.
   */
  async runMaintenance(
    args: { leaseMs?: number } = {},
  ): Promise<ScannerInternalMaintenanceResponse> {
    const leaseMs = args.leaseMs ?? this.leaseMs;
    const { recovered } = await this.recoverStaleRuns(leaseMs);
    await this.pruneTerminalRuns();
    const health = await this.getHealth();
    return {
      recovered,
      activeRuns: health.activeRuns,
      recentFailures: health.recentFailures,
      status: health.status,
      isProviderAvailable: health.isProviderAvailable,
    };
  }

  private async executeScan(
    args: ScanTriggerArgs,
    nowMs: number,
    lockGuard?: { isLost(): boolean; verifyNow(): Promise<boolean> },
  ): Promise<ScanRunResult> {
    const provider = this.requireProvider();
    const runId = await this.createRun(provider.id, args);

    this.logger.info('scan started', {
      runId,
      provider: provider.id,
      strategyId: args.strategyId ?? null,
      force: args.force ?? false,
      nowMs,
    });

    const metrics: ScanMetrics = {
      strategiesScanned: 0,
      instrumentsScanned: 0,
      candlesFetched: 0,
      candlesFromStore: 0,
      candlesFromProvider: 0,
      setupsDetected: 0,
      setupsCreated: 0,
      alertsCreated: 0,
      staleRejections: 0,
      providerFailures: 0,
      symbolsProcessed: new Set<string>(),
      timeframesProcessed: new Set<string>(),
      errors: [],
      pairs: [],
    };

    let finalStatus: 'completed' | 'failed' | 'partial' = 'completed';
    let finalError: string | null = null;

    try {
      const eligibleStrategies = await this.getEligibleStrategies(args.strategyId, args.instruments);

      if (lockGuard?.isLost() === true) {
        throw Errors.conflict('Scanner advisory lock was lost; aborting this run');
      }

      if (eligibleStrategies.length === 0) {
        // This path records a *successful* run, so it owes the same proof as the
        // main path: ownership is re-verified synchronously here too. Otherwise a
        // lock lost while strategies were loading would be written as a clean
        // `completed` run by the one success path that never reached the final
        // gate.
        await this.assertLockOwnership(lockGuard);
        this.logger.info('scan completed: no eligible strategies', { runId });
        await this.completeRun(runId, 'completed', metrics, null);
        const run = await this.getRun(runId);
        return { run };
      }

      // Enforce max per run
      const strategiesToScan = eligibleStrategies.slice(0, SCANNER_MAX_STRATEGIES_PER_RUN);
      metrics.strategiesScanned = strategiesToScan.length;

      // P2: per-cycle candle cache — deduplicates identical instrument×timeframe
      // fetches across strategies within this scan cycle.
      const cycleCache: ScanCycleCache = new Map();

      for (const strategy of strategiesToScan) {
        // Fail closed: if the advisory lock was lost while this run was in
        // flight, another scan may already be executing. Continuing would
        // duplicate detection/alert work under two "exclusive" runs.
        if (lockGuard?.isLost() === true) {
          throw Errors.conflict('Scanner advisory lock was lost; aborting this run');
        }
        try {
          await this.scanStrategy(strategy, args, nowMs, metrics, cycleCache);
        } catch (err) {
          const safeMsg = sanitizeScannerError(err, this.redact);
          metrics.errors.push(`strategy ${strategy.strategyId}: ${safeMsg}`);
          metrics.providerFailures += 1;
          this.logger.warn('strategy scan failed', {
            runId,
            strategyId: strategy.strategyId,
            versionId: strategy.versionId,
            error: safeMsg,
          });
          finalStatus = 'partial';
        }
      }

      // Final fail-closed gate: prove ownership once more, synchronously,
      // before recording a terminal status. A run that believes it is
      // exclusive but is not must never be written as a clean success, and a
      // wall-clock heartbeat alone could miss a loss that happened between the
      // last tick and this decision.
      await this.assertLockOwnership(lockGuard);

      if (metrics.providerFailures > 0 && metrics.setupsDetected === 0 && metrics.alertsCreated === 0) {
        if (metrics.providerFailures >= strategiesToScan.length) {
          finalStatus = 'failed';
          finalError = `All ${strategiesToScan.length} strategies failed: ${metrics.errors.slice(0, 3).join('; ')}`;
        }
      }

      await this.completeRun(runId, finalStatus, metrics, finalError);
      const run = await this.getRun(runId);

      this.logger.info('scan completed', {
        runId,
        status: finalStatus,
        strategiesScanned: metrics.strategiesScanned,
        instrumentsScanned: metrics.instrumentsScanned,
        setupsDetected: metrics.setupsDetected,
        setupsCreated: metrics.setupsCreated,
        alertsCreated: metrics.alertsCreated,
        staleRejections: metrics.staleRejections,
        providerFailures: metrics.providerFailures,
        durationMs: Date.now() - nowMs,
      });

      return { run };
    } catch (err) {
      const safeMsg = sanitizeScannerError(err, this.redact);
      this.logger.error('scan failed', { runId, error: safeMsg });
      await this.completeRun(runId, 'failed', metrics, safeMsg);
      const run = await this.getRun(runId);
      return { run };
    }
  }

  private async scanStrategy(
    strategy: EligibleStrategy,
    args: ScanTriggerArgs,
    nowMs: number,
    metrics: ScanMetrics,
    cycleCache: ScanCycleCache,
  ): Promise<void> {
    // Resolve instruments for this strategy
    const instruments = await this.resolveInstrumentsForStrategy(strategy, args.instruments);
    const limitedInstruments = instruments.slice(0, SCANNER_MAX_INSTRUMENTS_PER_RUN);

    for (const inst of limitedInstruments) {
      try {
        await this.scanInstrument(strategy, inst, args, nowMs, metrics, cycleCache);
      } catch (err) {
        const safeMsg = sanitizeScannerError(err, this.redact);
        // Don't fail whole strategy for one instrument failure
        metrics.errors.push(`instrument ${inst.assetClass}/${inst.symbol}: ${safeMsg}`);
        if (isRetryableScannerFetchFailure(err)) {
          metrics.providerFailures += 1;
        }
        this.logger.warn('instrument scan failed', {
          strategyId: strategy.strategyId,
          instrument: `${inst.assetClass}/${inst.symbol}`,
          error: safeMsg,
        });
      }
    }
  }

  /**
   * Phase B: wrap the pair scan so EXACTLY ONE observation is recorded per
   * pair, on every exit path (skip, stale, evaluated, throw).
   *
   * The observation starts as `failed` and is overwritten by the core path as
   * soon as it decides otherwise, so an unexpected throw can never produce a
   * pair that is silently missing from `metadata.pairs`.
   */
  private async scanInstrument(
    strategy: EligibleStrategy,
    instrument: { assetClass: AssetClass; symbol: string; instrumentId: string },
    args: ScanTriggerArgs,
    nowMs: number,
    metrics: ScanMetrics,
    cycleCache: ScanCycleCache,
  ): Promise<void> {
    const setupTf = normalizeTimeframe(strategy.timeframes.setup);
    const observation: PairObservation = {
      strategyId: strategy.strategyId,
      assetClass: instrument.assetClass,
      symbol: instrument.symbol,
      timeframe: setupTf ?? strategy.timeframes.setup,
      outcome: 'failed',
      cursorMs: null,
      anchorMs: null,
      reason: 'error',
    };
    try {
      await this.scanPairCore(strategy, instrument, args, nowMs, metrics, cycleCache, observation);
    } catch (err) {
      observation.outcome = 'failed';
      observation.reason = classifyPairFailure(err);
      throw err;
    } finally {
      metrics.pairs.push(observation);
    }
  }

  private async scanPairCore(
    strategy: EligibleStrategy,
    instrument: { assetClass: AssetClass; symbol: string; instrumentId: string },
    args: ScanTriggerArgs,
    nowMs: number,
    metrics: ScanMetrics,
    cycleCache: ScanCycleCache,
    observation: PairObservation,
  ): Promise<void> {
    /* --------------------------------------------------------------------- *
     * PR A — evaluation diagnostics.
     *
     * Tracked locally and flushed on every exit path, so the stored evidence
     * always describes the stage the pair actually reached. Nothing here
     * changes a decision: qualification, counters, cursor advancement and
     * persistence policy are untouched. The values are bounded (see
     * `normalisePairDiagnostics`) and drawn from closed vocabularies, so they
     * can never carry tenant text.
     * --------------------------------------------------------------------- */
    // One mutable holder keeps the tracker readable: every field is final by
    // the time `flushDiagnostics()` copies it onto the observation.
    const tracker: {
      stage: ScannerPairStage;
      codes: string[];
      data?: ScannerPairData;
      directions: { long?: ScannerPairDirectionDiagnostic; short?: ScannerPairDirectionDiagnostic };
    } = { stage: 'candles', codes: [], directions: {} };

    /**
     * Record one cause code. The value is sanitized (redaction, single line)
     * but deliberately NOT shortened: a code that is too long or not a machine
     * token is dropped by `normalisePairDiagnostics`, never truncated into
     * something that reads as valid evidence.
     */
    const addCode = (raw: string | null | undefined): void => {
      if (!raw || tracker.codes.length >= SCANNER_RUN_PAIR_DIAGNOSTIC_CODES_MAX) return;
      const code = sanitizeScannerError(raw, this.redact, SCANNER_RUN_PAIR_CODE_MAX_CHARS * 4, true).trim();
      if (code.length === 0 || tracker.codes.includes(code)) return;
      tracker.codes.push(code);
    };

    /** Persist the evidence gathered so far onto the observation. */
    const flushDiagnostics = (): void => {
      observation.diagnostics = normalisePairDiagnostics({
        stage: tracker.stage,
        ...(tracker.codes.length > 0 ? { codes: [...tracker.codes] } : {}),
        ...(tracker.data ? { data: tracker.data } : {}),
        ...(Object.keys(tracker.directions).length > 0 ? { directions: { ...tracker.directions } } : {}),
      });
    };

    // Baseline: a pair that fails before it can gather any other evidence (a
    // provider error on the very first fetch, for example) still records that
    // it never got past `candles`, rather than carrying no diagnostics at all.
    flushDiagnostics();

    const { htf_bias, setup, entry } = strategy.timeframes;

    // Normalize timeframes
    const htfTf = normalizeTimeframe(htf_bias);
    const setupTf = normalizeTimeframe(setup);
    const entryTf = normalizeTimeframe(entry);

    if (!htfTf || !setupTf || !entryTf) {
      throw Errors.invalidInput(`Invalid timeframe configuration for strategy ${strategy.strategyId}`);
    }

    // Check cursor to avoid re-processing same candle
    if (!args.force) {
      const cursor = await this.getCursor(strategy.versionId, instrument.instrumentId, setupTf);
      if (cursor) {
        // We will fetch latest candle and compare; skip if same
        // We still need to fetch to know latest time, but we can skip heavy work later
      }
    }

    // Fetch candles for each timeframe with retry/backoff and validation.
    // P2: pass the per-cycle cache to deduplicate identical fetches across strategies.
    const htfCandles = await this.fetchValidatedCandles({
      assetClass: instrument.assetClass,
      symbol: instrument.symbol,
      timeframe: htfTf,
      nowMs,
      instrumentId: instrument.instrumentId,
      minimumCandles: 50,
      metrics,
      cycleCache,
    });

    const setupCandles = await this.fetchValidatedCandles({
      assetClass: instrument.assetClass,
      symbol: instrument.symbol,
      timeframe: setupTf,
      nowMs,
      instrumentId: instrument.instrumentId,
      minimumCandles: 100,
      metrics,
      cycleCache,
    });

    const entryCandles = await this.fetchValidatedCandles({
      assetClass: instrument.assetClass,
      symbol: instrument.symbol,
      timeframe: entryTf,
      nowMs,
      instrumentId: instrument.instrumentId,
      minimumCandles: 100,
      metrics,
      cycleCache,
    });

    metrics.instrumentsScanned += 1;
    metrics.symbolsProcessed.add(`${instrument.assetClass}/${instrument.symbol}`);
    metrics.timeframesProcessed.add(htfTf);
    metrics.timeframesProcessed.add(setupTf);
    metrics.timeframesProcessed.add(entryTf);

    // PR A: how much history each role actually handed to validation. These are
    // the numbers that make "insufficient history" distinguishable from
    // "conditions not met" without storing a single candle.
    tracker.data = {
      htf: roleDataOf(htfCandles),
      setup: roleDataOf(setupCandles),
      entry: roleDataOf(entryCandles),
    };

    // Multi-timeframe validation
    const mtfValidation = validateMultiTimeframe({
      htf: htfCandles,
      setup: setupCandles,
      entry: entryCandles,
      htfTimeframe: htfTf,
      setupTimeframe: setupTf,
      entryTimeframe: entryTf,
      nowMs,
    });

    if (!mtfValidation.valid) {
      metrics.staleRejections += 1;
      observation.outcome = 'stale';
      observation.reason = 'mtf_invalid';
      tracker.stage = 'validation';
      // `validateMultiTimeframe` returns a bounded reason of its own
      // (`setup_missing_candles`, `htf_context_missing`, …). The stable
      // `reason` code stays `mtf_invalid` for historical readers; the specific
      // cause goes to diagnostics, with a category the UI can group on.
      if (mtfValidation.reason) addCode(mtfValidation.reason);
      if (mtfValidation.reason === 'insufficient_candles_for_correlation') addCode('insufficient_history');
      flushDiagnostics();
      this.logger.info('multi-timeframe validation failed', {
        strategyId: strategy.strategyId,
        instrument: `${instrument.assetClass}/${instrument.symbol}`,
        reason: mtfValidation.reason,
        details: mtfValidation.details,
      });
      return;
    }

    // Freshness checks
    const freshness = checkMultiTimeframeFreshness({
      htf: htfCandles,
      setup: setupCandles,
      entry: entryCandles,
      htfTimeframe: htfTf,
      setupTimeframe: setupTf,
      entryTimeframe: entryTf,
      nowMs,
    });

    if (!freshness.fresh) {
      metrics.staleRejections += 1;
      observation.outcome = 'stale';
      // `checkMultiTimeframeFreshness` already role-prefixes the cause
      // (`setup_stale_candle`), which is the exact code we want to store.
      observation.reason = (freshness.reason ?? 'stale_candle').slice(0, SCANNER_RUN_PAIR_REASON_MAX_CHARS);
      tracker.stage = 'freshness';
      addCode(freshness.reason ?? 'stale_candle');
      flushDiagnostics();
      this.logger.info('stale data rejected', {
        strategyId: strategy.strategyId,
        instrument: `${instrument.assetClass}/${instrument.symbol}`,
        reason: freshness.reason,
        htfAge: freshness.htf.ageMs,
        setupAge: freshness.setup.ageMs,
        entryAge: freshness.entry.ageMs,
      });
      return;
    }

    // F14 MTF Anchor Alignment (no lookahead):
    // The detection anchor (`asOfMs`) must be the CLOSE time (`time + period`)
    // of the latest fully-closed setup candle (`c.time + setupPeriodMs <= nowMs`),
    // never a forming bar's open or future close. Both `EvaluationService.readRole`
    // (`ts < asOfMs`) and `EvaluationEngine.closedCandles` (`time + period <= asOfMs`)
    // evaluate candles closed at `asOfMs`, matching backtest anchor semantics.
    // Cursors store the OPEN time (`latestClosedSetupCandle.time`) of that last
    // closed candle so duplicate forming-bar polls are skipped and the cursor
    // re-arms as soon as the next setup bar closes.
    const setupPeriodMs = timeframeMinutes(setupTf) * 60_000;
    let latestClosedSetupCandle: (typeof setupCandles)[number] | undefined;
    for (let i = setupCandles.length - 1; i >= 0; i--) {
      const c = setupCandles[i];
      if (!c) continue;
      if (c.time + setupPeriodMs <= nowMs) {
        latestClosedSetupCandle = c;
        break;
      }
    }

    if (!latestClosedSetupCandle) {
      metrics.staleRejections += 1;
      observation.outcome = 'stale';
      observation.reason = 'no_closed_candle';
      tracker.stage = 'anchor';
      addCode('no_closed_candle');
      flushDiagnostics();
      this.logger.info('no closed setup candle at scan time', {
        strategyId: strategy.strategyId,
        instrument: `${instrument.assetClass}/${instrument.symbol}`,
        timeframe: setupTf,
        nowMs,
      });
      return;
    }

    const asOfMs = latestClosedSetupCandle.time + setupPeriodMs;

    observation.cursorMs = latestClosedSetupCandle.time;
    observation.anchorMs = asOfMs;

    // Cursor check: avoid re-processing same closed candle
    if (!args.force) {
      const cursor = await this.getCursor(strategy.versionId, instrument.instrumentId, setupTf);
      if (cursor && cursor.last_candle_time === latestClosedSetupCandle.time) {
        // Phase B: the skip is recorded as `cursor_skipped` — an idempotent
        // no-op that is explicitly NOT an evaluation, so no `conditions` and no
        // `failureReasons` are attached. The cursor semantics are unchanged.
        observation.outcome = 'cursor_skipped';
        observation.reason = 'cursor_hit';
        tracker.stage = 'cursor';
        addCode('cursor_hit');
        flushDiagnostics();
        this.logger.info('skipping duplicate candle', {
          strategyId: strategy.strategyId,
          instrument: `${instrument.assetClass}/${instrument.symbol}`,
          timeframe: setupTf,
          lastCandleTime: latestClosedSetupCandle.time,
          anchor: asOfMs,
        });
        return;
      }
    }

    // Run through existing strategy pipeline:
    // Market structure detection, liquidity sweep, ChoCH, break & retest,
    // S/R confirmation, order-block logic, etc. are all inside the evaluation engine.
    // We use SetupService.detect which internally calls EvaluationService.

    // Detect long and short. `includeDiagnostics` asks M4 for per-condition
    // status counts so this pair's outcome is explainable after the fact; the
    // M4 HTTP endpoint does not request them, so its response is unchanged.
    const directions: ('long' | 'short')[] = ['long', 'short'];
    const conditionTotals: ConditionSummary = { satisfied: 0, unsatisfied: 0, insufficient_data: 0, unsupported: 0 };
    const engineReasons: string[] = [];
    let directionsEvaluated = 0;
    /** PR A: directions the engine qualified but a limit refused to persist. */
    let directionsBlocked = 0;
    tracker.stage = 'detection';
    for (const direction of directions) {
      try {
        const detection = await this.setups.detect({
          userId: strategy.userId,
          strategyId: strategy.strategyId,
          versionId: strategy.versionId,
          assetClass: instrument.assetClass,
          symbol: instrument.symbol,
          direction,
          asOf: asOfMs,
          includeDiagnostics: true,
        });

        const item = detection.detections.find((d) => d.direction === direction);
        if (!item) {
          // PR A: the detector ran but returned nothing for this direction, so
          // this direction was NOT evaluated. Recorded as `not_run` rather than
          // being folded into an `evaluated` pair.
          tracker.directions[direction] = { state: 'not_run' };
          continue;
        }
        directionsEvaluated += 1;
        const summary = item.conditionSummary;
        const failing = failingConditionCodes(item.conditionOutcomes);
        tracker.directions[direction] = {
          state: item.qualified ? 'qualified' : 'not_qualified',
          ...(summary ? { conditions: { ...summary } } : {}),
          ...(failing.length > 0 ? { failing } : {}),
        };
        if (summary) {
          conditionTotals.satisfied += summary.satisfied;
          conditionTotals.unsatisfied += summary.unsatisfied;
          conditionTotals.insufficient_data += summary.insufficient_data;
          conditionTotals.unsupported += summary.unsupported;
        }
        if (!item.qualified && engineReasons.length < SCANNER_RUN_PAIR_REASONS_MAX) {
          // `failureReasons` is required by the DTO but is read defectively
          // here: a third-party/stubbed detector must never break a scan.
          for (const reason of item.failureReasons ?? []) {
            if (engineReasons.length >= SCANNER_RUN_PAIR_REASONS_MAX) break;
            engineReasons.push(sanitizeScannerError(reason, this.redact, SCANNER_RUN_PAIR_REASON_TEXT_MAX_CHARS, true));
          }
        }

      if (!item?.qualified || !item.setup) {
        continue;
      }

      metrics.setupsDetected += 1;
      if (item.created) metrics.setupsCreated += 1;

      // Scoring — deterministic quality score, preserves M5 requirements
      await this.scoring.scoreSetup({
        userId: strategy.userId,
        setupId: item.setup.id,
        asOf: asOfMs,
      });

      // Risk/Quality validation: minQualityScore gate is enforced in AlertService
      // Preserve existing quality/RR requirements

      // Alert generation
      const alertResult = await this.alerts.generateAlert({
        userId: strategy.userId,
        setupId: item.setup.id,
        triggerState: 'confirmed',
      });

      if (alertResult.alert && alertResult.created) {
        metrics.alertsCreated += 1;
        this.logger.info('alert created from live scan', {
          strategyId: strategy.strategyId,
          setupId: item.setup.id,
          alertId: alertResult.alert.id,
          instrument: `${instrument.assetClass}/${instrument.symbol}`,
          direction,
          qualityScore: alertResult.alert.qualityScore,
        });
      }
      } catch (err) {
        // Entitlement limits: if max setups reached, skip.
        //
        // PR A: a limit is a persistence decision, not a strategy outcome. The
        // direction is recorded as `blocked` and the pair carries
        // `setup_limit_reached`, so a capped account no longer looks like a
        // strategy that simply never qualifies. The skip itself — and therefore
        // cursor advancement below — is unchanged.
        if (err instanceof Error && err.message.includes('limit reached')) {
          directionsBlocked += 1;
          tracker.directions[direction] = { state: 'blocked' };
          tracker.stage = 'persistence';
          addCode('setup_limit_reached');
          this.logger.warn('entitlement limit reached', {
            strategyId: strategy.strategyId,
            userId: strategy.userId,
            error: err.message,
          });
          continue;
        }
        tracker.directions[direction] = { state: 'error' };
        addCode(classifyPairFailure(err));
        flushDiagnostics();
        throw err;
      }
    }

    // Update cursor — store OPEN of the latest closed setup candle so cursor
    // re-arms when the next setup candle closes.
    await this.upsertCursor(strategy.versionId, instrument.instrumentId, setupTf, latestClosedSetupCandle.time, nowMs);

    if (directionsEvaluated === 0) {
      // PR A: no direction produced a detector item, so nothing was evaluated.
      // Reporting this as `evaluated` (the pre-PR-A behaviour) made a refused
      // evaluation indistinguishable from a completed one.
      //
      // The cursor above has already advanced, exactly as before: PR A records
      // this state, it does not change cursor advancement or idempotency.
      observation.outcome = 'failed';
      if (directionsBlocked > 0) {
        observation.reason = 'setup_limit_reached';
        tracker.stage = 'persistence';
        addCode('setup_not_persisted');
      } else {
        observation.reason = 'detector_unavailable';
        tracker.stage = 'detection';
      }
      flushDiagnostics();
      return;
    }

    // Reaching here means at least one direction ran through M3. That is an
    // EVALUATION, distinct from a cursor skip.
    observation.outcome = 'evaluated';
    observation.reason = directionsEvaluated === directions.length ? null : 'partial_evaluation';
    observation.conditions = conditionTotals;
    if (engineReasons.length > 0) observation.failureReasons = engineReasons;
    tracker.stage = 'complete';
    flushDiagnostics();
  }

  private async fetchValidatedCandles(args: {
    assetClass: AssetClass;
    symbol: string;
    timeframe: Timeframe;
    nowMs: number;
    instrumentId: string;
    /** Minimum candles required by this timeframe's scanner role (HTF/setup/entry). */
    minimumCandles: number;
    metrics: ScanMetrics;
    /** P2: per-cycle cache to deduplicate identical fetches across strategies. */
    cycleCache?: ScanCycleCache;
  }): Promise<{ time: number; open: number; high: number; low: number; close: number; volume: number | null }[]> {
    const periodMs = timeframeMinutes(args.timeframe) * 60_000;
    // Request last N candles covering required windows
    // Use max window similar to evaluation service: 500 + margin
    const windowCandles = 500;
    const from = args.nowMs - windowCandles * periodMs;
    const to = args.nowMs;

    // P2: check per-cycle cache first. If another strategy already fetched this
    // exact instrument × timeframe in this scan cycle, reuse the result.
    if (args.cycleCache) {
      const cacheKey = makeCacheKey(args.assetClass, args.symbol, args.timeframe);
      const cached = args.cycleCache.get(cacheKey);
      if (cached && cached.candles.length >= args.minimumCandles) {
        return cached.candles;
      }
    }

    // Prefer a complete, valid, fresh batch already in the shared CandleStore.
    // Only closed candles are eligible so a cache hit cannot introduce a
    // forming-bar lookahead; otherwise keep the existing ingestion fetch-through
    // path below as the source of truth.
    const storedCandles = await this.candleStore.queryCandles({
      instrumentId: args.instrumentId,
      timeframe: args.timeframe,
      from,
      to,
      limit: windowCandles + 1,
    });

    if (storedCandles.length <= windowCandles) {
      const closedCandles = storedCandles.filter((c) => c.time + periodMs <= args.nowMs);
      const normalizedBatch = normalizeCandleBatch(closedCandles);
      if (normalizedBatch) {
        const normalized = normalizedBatch.normalized;
        const validation = validateCandleBatch({
          candles: normalized,
          timeframe: args.timeframe,
          expectedFrom: from,
          expectedTo: to,
          allowGaps: args.timeframe === '1d' || args.timeframe === '1w' || args.timeframe === '1M',
        });
        const freshness = checkFreshness({
          candles: normalized,
          timeframe: args.timeframe,
          nowMs: args.nowMs,
        });

        if (normalized.length >= args.minimumCandles && validation.valid && freshness.fresh) {
          // Phase A: store-served candles are candles processed. Counted once,
          // here, on the only path that returns them.
          recordCandleLoad(args.metrics, 'store', normalized.length);
          if (args.cycleCache) {
            const cacheKey = makeCacheKey(args.assetClass, args.symbol, args.timeframe);
            args.cycleCache.set(cacheKey, { candles: normalized });
          }
          return normalized;
        }
      }
    }

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.withTimeout(
          this.ingestion.getCandles({
            assetClass: args.assetClass,
            symbol: args.symbol,
            timeframe: args.timeframe,
            from,
            to,
            limit: windowCandles,
            nowMs: args.nowMs,
          }),
          this.providerTimeoutMs,
        );

        const candles = result.candles;

        // Normalize batch
        const normalizedBatch = normalizeCandleBatch(candles);
        if (!normalizedBatch) {
          throw Errors.invalidInput(`Invalid candle batch for ${args.assetClass}/${args.symbol} ${args.timeframe}`);
        }

        if (normalizedBatch.hadDuplicates) {
          this.logger.warn('duplicate candles detected', {
            instrument: `${args.assetClass}/${args.symbol}`,
            timeframe: args.timeframe,
          });
          // Treat as invalid for production safety — but we already deduped
          // So we allow deduped version but log
        }

        if (normalizedBatch.hadOutOfOrder) {
          this.logger.warn('out-of-order candles detected', {
            instrument: `${args.assetClass}/${args.symbol}`,
            timeframe: args.timeframe,
          });
          // We sorted, but flag
        }

        const normalized = normalizedBatch.normalized;

        // Validate
        const validation = validateCandleBatch({
          candles: normalized,
          timeframe: args.timeframe,
          expectedFrom: from,
          expectedTo: to,
          allowGaps: args.timeframe === '1d' || args.timeframe === '1w' || args.timeframe === '1M',
        });

        if (!validation.valid) {
          throw Errors.invalidInput(`Candle validation failed for ${args.assetClass}/${args.symbol} ${args.timeframe}: ${validation.reason}`);
        }

        // Freshness
        const freshness = checkFreshness({
          candles: normalized,
          timeframe: args.timeframe,
          nowMs: args.nowMs,
        });

        if (!freshness.fresh) {
          // For HTF, allow slightly stale? No, per requirement never generate alert from stale data
          // But we still return candles for observability; caller will check multi-timeframe freshness
          // For now, log and continue — caller decides
          this.logger.info('candle freshness check', {
            instrument: `${args.assetClass}/${args.symbol}`,
            timeframe: args.timeframe,
            fresh: freshness.fresh,
            reason: freshness.reason,
            ageMs: freshness.ageMs,
          });
        }

        // Phase A: same funnel as the store path, attributed to the provider.
        // `candlesFetched` keeps advancing here, so provider fetches remain
        // visible exactly as before (also surfaced as `candlesFromProvider`).
        recordCandleLoad(args.metrics, 'provider', normalized.length);

        // P2: store in per-cycle cache for subsequent strategies in this scan.
        if (args.cycleCache) {
          const cacheKey = makeCacheKey(args.assetClass, args.symbol, args.timeframe);
          args.cycleCache.set(cacheKey, { candles: normalized });
        }

        return normalized;
      } catch (err) {
        lastError = err;
        if (isRetryableScannerFetchFailure(err)) {
          if (attempt < this.maxRetries) {
            const delayMs = Math.min(this.retryBaseMs * 2 ** attempt + Math.random() * 500, this.retryMaxMs);
            this.logger.warn('provider fetch failed, retrying', {
              instrument: `${args.assetClass}/${args.symbol}`,
              timeframe: args.timeframe,
              attempt: attempt + 1,
              maxRetries: this.maxRetries,
              delayMs: Math.round(delayMs),
              error: sanitizeScannerError(err, this.redact),
            });
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
        }
        // Non-retryable or retries exhausted
        throw err;
      }
    }

    throw lastError ?? Errors.providerUnavailable('Failed to fetch market data after retries');
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new ScannerFetchTimeoutError(timeoutMs)), timeoutMs);
    });
    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutId!);
      return result as T;
    } catch (err) {
      clearTimeout(timeoutId!);
      throw err;
    }
  }

  private requireProvider() {
    const provider = this.providerRegistry.get('twelve-data');
    if (provider?.capabilities.historical) return provider;
    // Fallback to any historical provider
    for (const info of this.providerRegistry.list()) {
      const candidate = this.providerRegistry.get(info.id);
      if (candidate?.capabilities.historical) return candidate;
    }
    throw Errors.providerUnavailable('No market-data provider is registered — scanner is unavailable.');
  }

  private requireProviderSafe() {
    try {
      return this.requireProvider();
    } catch {
      return null;
    }
  }

  private async createRun(providerSlug: string, args: ScanTriggerArgs): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO scanner_runs (status, provider_slug, metadata)
       VALUES ('running', $1, $2) RETURNING id`,
      [providerSlug, JSON.stringify({ triggeredBy: args.initiatedBy ?? 'system', strategyId: args.strategyId ?? null, force: args.force ?? false })],
    );
    const id = res.rows[0]?.id;
    if (!id) throw Errors.internal('Failed to create scanner run');
    return id;
  }

  private async completeRun(
    runId: string,
    status: 'completed' | 'failed' | 'partial',
    metrics: ScanMetrics,
    error: string | null,
  ): Promise<void> {
    const safeError =
      error === null
        ? null
        : sanitizeScannerError(error, this.redact, SCANNER_RUN_ERROR_MAX_CHARS, false);
    const safeErrors = metrics.errors
      .slice(0, 10)
      .map((entry) => sanitizeScannerError(entry, this.redact, SCANNER_ERROR_MAX_CHARS, false));
    // Phase B: build the bounded per-pair block once; it is the derivation
    // source for `duplicateCandleSkips` as well as the stored detail.
    const pairsBlock = buildScannerRunPairs(metrics.pairs);

    await this.pool.query(
      `UPDATE scanner_runs SET status = $2, finished_at = now(),
              strategies_scanned = $3, instruments_scanned = $4, candles_fetched = $5,
              setups_detected = $6, setups_created = $7, alerts_created = $8,
              stale_rejections = $9, provider_failures = $10,
              symbols_processed = $11, timeframes_processed = $12,
              error = $13, metadata = metadata || $14::jsonb,
              updated_at = now()
       WHERE id = $1`,
      [
        runId,
        status,
        metrics.strategiesScanned,
        metrics.instrumentsScanned,
        metrics.candlesFetched,
        metrics.setupsDetected,
        metrics.setupsCreated,
        metrics.alertsCreated,
        metrics.staleRejections,
        metrics.providerFailures,
        JSON.stringify([...metrics.symbolsProcessed]),
        JSON.stringify([...metrics.timeframesProcessed]),
        safeError,
        JSON.stringify({
          errors: safeErrors,
          // Phase A observability: candle provenance for this run. Non-identifying,
          // so it survives tenant redaction (unlike `errors`/`strategyId`).
          // Invariant: total === store + provider (each candle counted once).
          candles: {
            store: metrics.candlesFromStore,
            provider: metrics.candlesFromProvider,
            total: metrics.candlesFetched,
          },
          // Phase B: DERIVED from the pair observations, never from a second
          // counter, so the skip count and the per-pair detail cannot disagree.
          duplicateCandleSkips: pairsBlock.totals.cursor_skipped,
          pairs: pairsBlock,
        }),
      ],
    );
  }

  private async getRun(runId: string): Promise<ScannerRunDto> {
    const res = await this.pool.query<ScannerRunRow>(`SELECT * FROM scanner_runs WHERE id = $1`, [runId]);
    const row = res.rows[0];
    if (!row) throw Errors.notFound('Scanner run not found');
    return toScannerRunDto(row);
  }

  private async getEligibleStrategies(
    filterStrategyId?: string,
    _filterInstruments?: { assetClass: string; symbol: string }[],
  ): Promise<EligibleStrategy[]> {
    // Query strategies that are active, have published version, and owner has scanner entitlement
    // The subscription is LEFT-joined (not inner-joined) because a granted
    // account characteristically has NO subscription row at all: since Model C
    // that absence IS the free state, and a non-commercial operator grant
    // (migration 0036) is an ACCOUNT-level authority that must still reach this
    // read. The resolver is the single gate, so a row-less account resolves
    // through exactly the same rules as one with a row.
    let query = `
      SELECT s.id as strategy_id, s.user_id, s.status as strategy_status,
             v.id as version_id, v.version_number,
             sub.plan, sub.status as sub_status, sub.provider as sub_provider,
             EXISTS (SELECT 1 FROM billing_subscription_activations a
                      WHERE a.subscription_id = sub.id) AS sub_activated,
             (SELECT g.plan FROM billing_entitlement_grants g
               WHERE g.user_id = s.user_id) AS granted_plan,
             (SELECT timeframe FROM strategy_timeframes WHERE version_id = v.id AND role = 'htf_bias') as htf_bias,
             (SELECT timeframe FROM strategy_timeframes WHERE version_id = v.id AND role = 'setup') as setup_tf,
             (SELECT timeframe FROM strategy_timeframes WHERE version_id = v.id AND role = 'entry') as entry_tf,
             ms.mode as scope_mode
      FROM strategies s
      JOIN strategy_versions v ON v.strategy_id = s.id AND v.status = 'published'
      LEFT JOIN subscriptions sub ON sub.user_id = s.user_id
      LEFT JOIN strategy_market_scopes ms ON ms.version_id = v.id
      WHERE s.status = 'active'
    `;
    const values: unknown[] = [];
    if (filterStrategyId) {
      values.push(filterStrategyId);
      query += ` AND s.id = $${values.length}`;
    }
    query += ` ORDER BY s.updated_at DESC LIMIT ${SCANNER_MAX_STRATEGIES_PER_RUN * 2}`;

    const res = await this.pool.query<{
      strategy_id: string;
      user_id: string;
      strategy_status: string;
      version_id: string;
      version_number: number;
      plan: string | null;
      sub_status: string | null;
      sub_provider: string | null;
      sub_activated: boolean;
      granted_plan: string | null;
      htf_bias: string | null;
      setup_tf: string | null;
      entry_tf: string | null;
      scope_mode: string | null;
    }>(query, values);

    const eligible: EligibleStrategy[] = [];
    for (const row of res.rows) {
      // A provider-backed owner row is an unconfirmed checkout until an
      // immutable activation fact exists for it (Billing Step 8, migration
      // 0034): without one it resolves to the free tier, so its strategies are
      // never eligible for a scan. A non-commercial operator grant (migration
      // 0036) is a separate, account-level authority and is read alongside it.
      const entitlements = resolveEntitlements(
        (row.plan ?? 'free') as UserPlan,
        row.sub_status ?? 'active',
        row.sub_provider,
        row.sub_activated === true,
        row.granted_plan as UserPlan | null,
      );
      if (!entitlements.canAccessScanner) continue;

      // Validate timeframes — must support required HTF/setup/entry
      const htf = row.htf_bias ? normalizeTimeframe(row.htf_bias) : null;
      const setup = row.setup_tf ? normalizeTimeframe(row.setup_tf) : null;
      const entry = row.entry_tf ? normalizeTimeframe(row.entry_tf) : null;

      if (!htf || !setup || !entry) continue;

      // Enforce strategy requirements: HTF 4H/1D, Setup 1H, Entry 15M/5M
      // But allow other timeframes too — preserve existing architecture
      // Just ensure they are valid canonical timeframes
      eligible.push({
        strategyId: row.strategy_id,
        versionId: row.version_id,
        versionNumber: row.version_number,
        userId: row.user_id,
        plan: (row.plan ?? 'free') as UserPlan,
        status: row.strategy_status,
        timeframes: { htf_bias: htf, setup, entry },
        marketScope: { mode: (row.scope_mode as 'all' | 'instruments') ?? 'all' },
      });

      if (eligible.length >= SCANNER_MAX_STRATEGIES_PER_RUN) break;
    }

    // For each eligible, resolve instruments if mode is instruments
    for (const strat of eligible) {
      if (strat.marketScope.mode === 'instruments') {
        const instRes = await this.pool.query<{ asset_class: string; symbol: string; instrument_id: string }>(
          `SELECT i.asset_class, i.symbol, i.id as instrument_id
           FROM strategy_market_scope_instruments smsi
           JOIN instruments i ON i.id = smsi.instrument_id
           WHERE smsi.version_id = $1`,
          [strat.versionId],
        );
        strat.marketScope.instruments = instRes.rows.map((r) => ({
          assetClass: r.asset_class as AssetClass,
          symbol: r.symbol,
          instrumentId: r.instrument_id,
        }));
      }
    }

    return eligible;
  }

  private async resolveInstrumentsForStrategy(
    strategy: EligibleStrategy,
    filterInstruments?: { assetClass: string; symbol: string }[],
  ): Promise<{ assetClass: AssetClass; symbol: string; instrumentId: string }[]> {
    let instruments: { assetClass: AssetClass; symbol: string; instrumentId: string }[] = [];

    if (strategy.marketScope.mode === 'all') {
      const res = await this.pool.query<{ asset_class: string; symbol: string; id: string }>(
        `SELECT asset_class, symbol, id FROM instruments ORDER BY asset_class, symbol LIMIT $1`,
        [SCANNER_MAX_INSTRUMENTS_PER_RUN],
      );
      instruments = res.rows.map((r) => ({
        assetClass: r.asset_class as AssetClass,
        symbol: r.symbol,
        instrumentId: r.id,
      }));
    } else {
      instruments = strategy.marketScope.instruments ?? [];
    }

    // Apply filter if provided, but validate against universe
    if (filterInstruments && filterInstruments.length > 0) {
      const normalizedFilters = filterInstruments
        .map((f) => normalizeSymbol({ assetClass: f.assetClass, symbol: f.symbol }))
        .filter((f): f is NonNullable<typeof f> => f !== null);

      // Only allow instruments that exist in platform universe
      const allowed = new Set(instruments.map((i) => `${i.assetClass}/${i.symbol}`));
      instruments = instruments.filter((inst) => {
        if (normalizedFilters.length === 0) return true;
        return normalizedFilters.some((nf) => nf.assetClass === inst.assetClass && nf.symbol === inst.symbol) && allowed.has(`${inst.assetClass}/${inst.symbol}`);
      });

      // Security: reject arbitrary unsupported symbols
      for (const f of normalizedFilters) {
        const exists = instruments.some((i) => i.assetClass === f.assetClass && i.symbol === f.symbol);
        if (!exists) {
          // Check if symbol exists in global universe at all
          const globalCheck = await this.pool.query(`SELECT id FROM instruments WHERE asset_class = $1 AND symbol = $2`, [f.assetClass, f.symbol]);
          if (globalCheck.rows.length === 0) {
            throw Errors.invalidInput(`Unsupported instrument "${f.assetClass}/${f.symbol}" — not in market universe`);
          }
        }
      }
    }

    return instruments;
  }

  private async getCursor(versionId: string, instrumentId: string, timeframe: Timeframe) {
    const res = await this.pool.query<{
      strategy_version_id: string;
      instrument_id: string;
      timeframe: string;
      last_candle_time: string;
      last_scan_at: Date;
    }>(
      `SELECT * FROM scanner_cursors WHERE strategy_version_id = $1 AND instrument_id = $2 AND timeframe = $3`,
      [versionId, instrumentId, timeframe],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...row,
      last_candle_time: Number(row.last_candle_time),
    };
  }

  private async upsertCursor(versionId: string, instrumentId: string, timeframe: Timeframe, lastCandleTime: number, nowMs: number) {
    await this.pool.query(
      `INSERT INTO scanner_cursors (strategy_version_id, instrument_id, timeframe, last_candle_time, last_scan_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (strategy_version_id, instrument_id, timeframe) DO UPDATE SET
         last_candle_time = EXCLUDED.last_candle_time,
         last_scan_at = EXCLUDED.last_scan_at,
         updated_at = now()`,
      [versionId, instrumentId, timeframe, lastCandleTime, new Date(nowMs)],
    );
  }
}

interface ScannerRunRow {
  id: string;
  status: string;
  provider_slug: string;
  started_at: Date;
  finished_at: Date | null;
  strategies_scanned: number;
  instruments_scanned: number;
  candles_fetched: number;
  setups_detected: number;
  setups_created: number;
  alerts_created: number;
  stale_rejections: number;
  provider_failures: number;
  symbols_processed: unknown;
  timeframes_processed: unknown;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function toScannerRunDto(row: ScannerRunRow): ScannerRunDto {
  return {
    id: row.id,
    status: row.status as ScannerRunDto['status'],
    providerSlug: row.provider_slug,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    strategiesScanned: row.strategies_scanned,
    instrumentsScanned: row.instruments_scanned,
    candlesFetched: row.candles_fetched,
    setupsDetected: row.setups_detected,
    setupsCreated: row.setups_created,
    alertsCreated: row.alerts_created,
    staleRejections: row.stale_rejections,
    providerFailures: row.provider_failures,
    symbolsProcessed: Array.isArray(row.symbols_processed) ? (row.symbols_processed as string[]) : [],
    timeframesProcessed: Array.isArray(row.timeframes_processed) ? (row.timeframes_processed as string[]) : [],
    error: row.error,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Only the scanner's own deadline and ingestion's mapped transient provider errors are retryable.
 * No message text (including provider-controlled text in a cause) is trusted for classification. */
class ScannerFetchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider timeout after ${timeoutMs}ms`);
    this.name = 'ScannerFetchTimeoutError';
  }
}

export function isRetryableScannerFetchFailure(err: unknown): boolean {
  return err instanceof ScannerFetchTimeoutError ||
    (err instanceof DomainError && (err.code === 'provider_unavailable' || err.code === 'rate_limited'));
}
