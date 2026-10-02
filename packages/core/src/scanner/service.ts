import type pg from 'pg';
import {
  DEFAULT_SCANNER_LEASE_MS,
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
  type ScannerRunListQuery,
  type ScannerInternalRunResponse,
  type ScannerInternalMaintenanceResponse,
  type AssetClass,
  timeframeMinutes,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { ProviderRegistry } from '../market-data/registry.js';
import type { CandleStore } from '../market-data/candles.js';
import type { IngestionService } from '../market-data/ingestion.js';
import type { EvaluationService } from '../strategies/evaluation/service.js';
import type { SetupService } from '../setups/service.js';
import type { ScoringService } from '../scoring/service.js';
import type { AlertService } from '../alerts/service.js';
import { resolveEntitlements } from '../billing/entitlement-resolution.js';
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

export interface ScannerServiceOptions {
  providerTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  expectedIntervalMs?: number;
  leaseMs?: number;
  logger?: ScannerLogger;
  /**
   * Optional secret-redaction callback (defence in depth) applied to error
   * strings before they are stored on `scanner_runs` or written to logs.
   */
  redact?: (text: string) => string;
}

export interface ScannerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
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
 * Strip tenant-identifying scanner-run metadata unless the run belongs to
 * `viewerUserId`. Pure and deterministic — no I/O.
 *
 * A run is the viewer's own when `metadata.triggeredBy` equals their user id;
 * system runs (`triggeredBy = 'system'`) belong to no tenant and are redacted
 * for every tenant viewer. Everything non-identifying (status-bearing counts,
 * `force`, and any future non-sensitive key) is preserved so the run stays
 * operationally useful for triage.
 */
export function redactScannerRunMetadata(
  metadata: Record<string, unknown>,
  viewerUserId: string,
): Record<string, unknown> {
  if (metadata.triggeredBy === viewerUserId) return { ...metadata };
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((SCANNER_TENANT_SENSITIVE_METADATA_KEYS as readonly string[]).includes(key)) continue;
    redacted[key] = value;
  }
  return redacted;
}

/** Redact a fully-mapped run DTO for a tenant viewer. Pure — no I/O. */
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
 * Strips all tenant-identifying metadata (`triggeredBy`, `strategyId`, `errors`)
 * and sanitizes `error` so no tenant/strategy UUIDs or secrets are returned.
 * Pure and deterministic — no I/O.
 */
export function redactScannerRunForOperator(
  run: ScannerRunDto,
  redact?: (text: string) => string,
): ScannerRunDto {
  return {
    ...run,
    error: run.error === null ? null : sanitizeScannerError(run.error, redact, SCANNER_RUN_ERROR_MAX_CHARS, true),
    metadata: redactScannerRunMetadata(run.metadata, ''),
  };
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

interface ScanMetrics {
  strategiesScanned: number;
  instrumentsScanned: number;
  candlesFetched: number;
  setupsDetected: number;
  setupsCreated: number;
  alertsCreated: number;
  staleRejections: number;
  providerFailures: number;
  symbolsProcessed: Set<string>;
  timeframesProcessed: Set<string>;
  errors: string[];
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
  private readonly logger: ScannerLogger;
  private readonly redact: (text: string) => string;
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
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.redact = options.redact ?? ((text: string) => text);
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
   * Pass `viewerUserId` for every tenant-facing read: the result is restricted
   * to runs that user initiated, which is both the privacy boundary and the
   * only meaningful subset for them. System runs (`triggeredBy = 'system'`)
   * belong to no tenant and are therefore not returned to any tenant viewer —
   * global operational state remains visible via `getHealth`.
   *
   * Omit `viewerUserId` only for trusted internal/operator reads that must see
   * the whole ledger (ops scripts, diagnostics).
   */
  async listRuns(query: ScannerRunListQuery, viewerUserId?: string): Promise<{ runs: ScannerRunDto[] }> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (viewerUserId !== undefined) {
      values.push(viewerUserId);
      where.push(`metadata->>'triggeredBy' = $${values.length}`);
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
    return { runs: res.rows.map(toScannerRunDto) };
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

    // Try advisory lock
    const lockClient = await this.pool.connect();
    let destroyLockClient = false;
    try {
      const lockRes = await lockClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock($1) as acquired`,
        [SCANNER_ADVISORY_LOCK_KEY],
      );
      const acquired = lockRes.rows[0]?.acquired ?? false;
      if (!acquired) {
        this.logger.info('scan skipped: already running', { lockKey: SCANNER_ADVISORY_LOCK_KEY });
        // Return last run info
        const lastRunRes = await this.pool.query<ScannerRunRow>(
          `SELECT * FROM scanner_runs ORDER BY started_at DESC LIMIT 1`,
        );
        const lastRun = lastRunRes.rows[0] ? toScannerRunDto(lastRunRes.rows[0]) : null;
        if (lastRun) {
          return { run: lastRun, skipped: true, reason: 'already_running' };
        }
        throw Errors.conflict('Scanner is already running');
      }

      try {
        return await this.executeScan(args, nowMs);
      } finally {
        destroyLockClient = !(await this.releaseAdvisoryLock(lockClient));
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

  /**
   * Release the session-level scanner advisory lock held by `lockClient`.
   *
   * `pg_try_advisory_lock` is session-scoped: if `pg_advisory_unlock` throws or
   * reports `unlocked = false` and the client is returned to `pg.Pool` intact,
   * the pooled backend session keeps holding `SCANNER_ADVISORY_LOCK_KEY` and
   * silently blocks all future scans (M7 audit finding F5).
   *
   * Returns `true` when PostgreSQL confirms the lock was released, or `false`
   * after logging safe diagnostics (no secrets, no tenant identifiers) so the
   * caller destroys and evicts the pooled client instead of returning it to
   * the pool.
   */
  private async releaseAdvisoryLock(lockClient: pg.PoolClient): Promise<boolean> {
    try {
      const unlockRes = await lockClient.query<{ unlocked?: boolean; pg_advisory_unlock?: boolean }>(
        `SELECT pg_advisory_unlock($1) as unlocked`,
        [SCANNER_ADVISORY_LOCK_KEY],
      );
      const row = unlockRes?.rows?.[0];
      const unlocked =
        typeof row?.unlocked === 'boolean'
          ? row.unlocked
          : typeof row?.pg_advisory_unlock === 'boolean'
            ? row.pg_advisory_unlock
            : false;
      if (!unlocked) {
        this.logger.error('scanner advisory unlock failed', {
          lockKey: SCANNER_ADVISORY_LOCK_KEY,
          unlocked: false,
          reason: 'unlock_returned_false',
          connectionDestroyed: true,
        });
        return false;
      }
      return true;
    } catch (err) {
      const { error, code } = sanitizeScannerUnlockError(err);
      this.logger.error('scanner advisory unlock failed', {
        lockKey: SCANNER_ADVISORY_LOCK_KEY,
        unlocked: false,
        reason: 'query_error',
        error,
        ...(code !== undefined ? { code } : {}),
        connectionDestroyed: true,
      });
      return false;
    }
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
    const health = await this.getHealth();
    return {
      recovered,
      activeRuns: health.activeRuns,
      recentFailures: health.recentFailures,
      status: health.status,
      isProviderAvailable: health.isProviderAvailable,
    };
  }

  private async executeScan(args: ScanTriggerArgs, nowMs: number): Promise<ScanRunResult> {
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
      setupsDetected: 0,
      setupsCreated: 0,
      alertsCreated: 0,
      staleRejections: 0,
      providerFailures: 0,
      symbolsProcessed: new Set<string>(),
      timeframesProcessed: new Set<string>(),
      errors: [],
    };

    let finalStatus: 'completed' | 'failed' | 'partial' = 'completed';
    let finalError: string | null = null;

    try {
      const eligibleStrategies = await this.getEligibleStrategies(args.strategyId, args.instruments);

      if (eligibleStrategies.length === 0) {
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
        if (isProviderFailure(err)) {
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

  private async scanInstrument(
    strategy: EligibleStrategy,
    instrument: { assetClass: AssetClass; symbol: string; instrumentId: string },
    args: ScanTriggerArgs,
    nowMs: number,
    metrics: ScanMetrics,
    cycleCache: ScanCycleCache,
  ): Promise<void> {
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
      metrics,
      cycleCache,
    });

    const setupCandles = await this.fetchValidatedCandles({
      assetClass: instrument.assetClass,
      symbol: instrument.symbol,
      timeframe: setupTf,
      nowMs,
      instrumentId: instrument.instrumentId,
      metrics,
      cycleCache,
    });

    const entryCandles = await this.fetchValidatedCandles({
      assetClass: instrument.assetClass,
      symbol: instrument.symbol,
      timeframe: entryTf,
      nowMs,
      instrumentId: instrument.instrumentId,
      metrics,
      cycleCache,
    });

    metrics.instrumentsScanned += 1;
    metrics.symbolsProcessed.add(`${instrument.assetClass}/${instrument.symbol}`);
    metrics.timeframesProcessed.add(htfTf);
    metrics.timeframesProcessed.add(setupTf);
    metrics.timeframesProcessed.add(entryTf);

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
      this.logger.info('no closed setup candle at scan time', {
        strategyId: strategy.strategyId,
        instrument: `${instrument.assetClass}/${instrument.symbol}`,
        timeframe: setupTf,
        nowMs,
      });
      return;
    }

    const asOfMs = latestClosedSetupCandle.time + setupPeriodMs;

    // Cursor check: avoid re-processing same closed candle
    if (!args.force) {
      const cursor = await this.getCursor(strategy.versionId, instrument.instrumentId, setupTf);
      if (cursor && cursor.last_candle_time === latestClosedSetupCandle.time) {
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

    // Detect long and short
    const directions: ('long' | 'short')[] = ['long', 'short'];
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
        });

        const item = detection.detections.find((d) => d.direction === direction);
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
        // Entitlement limits: if max setups reached, skip
        if (err instanceof Error && err.message.includes('limit reached')) {
          this.logger.warn('entitlement limit reached', {
            strategyId: strategy.strategyId,
            userId: strategy.userId,
            error: err.message,
          });
          continue;
        }
        throw err;
      }
    }

    // Update cursor — store OPEN of the latest closed setup candle so cursor
    // re-arms when the next setup candle closes.
    await this.upsertCursor(strategy.versionId, instrument.instrumentId, setupTf, latestClosedSetupCandle.time, nowMs);
  }

  private async fetchValidatedCandles(args: {
    assetClass: AssetClass;
    symbol: string;
    timeframe: Timeframe;
    nowMs: number;
    instrumentId: string;
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
      if (cached) {
        return cached.candles;
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

        args.metrics.candlesFetched += normalized.length;

        // P2: store in per-cycle cache for subsequent strategies in this scan.
        if (args.cycleCache) {
          const cacheKey = makeCacheKey(args.assetClass, args.symbol, args.timeframe);
          args.cycleCache.set(cacheKey, { candles: normalized });
        }

        return normalized;
      } catch (err) {
        lastError = err;
        if (isProviderFailure(err) || isTimeoutError(err)) {
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
      timeoutId = setTimeout(() => reject(new Error(`Provider timeout after ${timeoutMs}ms`)), timeoutMs);
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
        JSON.stringify({ errors: safeErrors }),
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

function isProviderFailure(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('provider') || msg.includes('rate limit') || msg.includes('unavailable') || msg.includes('timeout');
  }
  return false;
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.toLowerCase().includes('timeout');
  }
  return false;
}
