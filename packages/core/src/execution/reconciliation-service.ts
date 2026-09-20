import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  EXECUTION_ARCHITECTURE_VERSION,
  EXECUTION_FAILURE_CATEGORIES,
  ExecutionProviderError,
  isExecutionProviderError,
  PAPER_EXECUTION_PROVIDER_ID,
  type ExecutionProvider,
} from '@veltrixeye/contracts';
import {
  RECONCILIATION_VERSION,
  type ReconciliationFindingDto,
  type ReconciliationFindingResolveInput,
  type ReconciliationHealthState,
  type ReconciliationMismatchCode,
  type ReconciliationProviderOrder,
  type ReconciliationProviderPosition,
  type ReconciliationProviderSnapshot,
  type ReconciliationRunDetailDto,
  type ReconciliationRunDto,
  type ReconciliationRunStatus,
  type ReconciliationRunTrigger,
  type ReconciliationStatusDto,
  type ReconciliationTriggerResponse,
} from '@veltrixeye/contracts';
import type { AuditService } from '../audit.js';
import { Errors } from '../errors.js';
import { toSafeProviderHealth } from './provider-health.js';

/**
 * M8.5 — Provider-neutral order & position reconciliation service.
 *
 * Compares internal `execution_orders` / `execution_positions` (the EXPECTED
 * state) against an owner-scoped snapshot obtained from the provider (the
 * OBSERVED state) and produces an immutable run + findings trail.
 *
 * Safety invariants pinned for M8.5:
 *  - Fail-closed on provider unavailability.
 *  - Deterministic matching by stable identifiers; never guesses.
 *  - Timeouts/network failures preserve UNCERTAIN state; a missing provider
 *    record is NEVER treated as "safe to resubmit".
 *  - Destructive corrective actions are GATED OFF.
 *  - Runs are idempotent and concurrency-safe (pg_advisory_xact_lock).
 *  - Tenant ownership is enforced on every read/write.
 *  - DisabledMT5Transport remains disabled (returns provider_unavailable).
 */

export interface ReconciliationSnapshotProvider {
  /**
   * Retrieve a normalized snapshot for (userId, profileId, providerId).
   * Throws ExecutionProviderError when the snapshot cannot be obtained; the
   * reconciliation service catches this and records provider_unavailable.
   */
  getSnapshot(args: {
    userId: string;
    executionProfileId: string;
    providerId: string;
  }): Promise<ReconciliationProviderSnapshot>;
}

export interface ReconciliationServiceDeps {
  /** Used to locate a plain ExecutionProvider for metadata/health (optional). */
  getProvider?: (id: string) => ExecutionProvider | undefined;
  /**
   * Owner-scoped snapshot provider. For broker-style adapters this delegates
   * to the ExecutionProvider after verifying ownership; for paper it reads
   * simulated rows from the DB in the context of that profile.
   */
  snapshots: ReconciliationSnapshotProvider;
  audit: AuditService;
  now?: () => Date;
}

export interface TriggerRunOptions {
  userId: string;
  executionProfileId: string;
  trigger: ReconciliationRunTrigger;
  providerId?: string;
  meta?: { ip?: string | null; userAgent?: string | null };
}

interface LoadedProfile {
  id: string;
  user_id: string;
  provider_slug: string;
  environment: string;
  enabled: boolean;
}

interface LoadedOrder {
  id: string;
  execution_profile_id: string;
  client_order_id: string;
  provider_slug: string;
  provider_order_id: string | null;
  asset_class: string;
  symbol: string;
  side: 'buy' | 'sell';
  order_type: string;
  quantity: string;
  requested_price: string | null;
  filled_quantity: string;
  average_fill_price: string | null;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  status: string;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  filled_at: Date | null;
}

interface LoadedPosition {
  id: string;
  execution_profile_id: string;
  provider_slug: string;
  provider_position_id: string | null;
  asset_class: string;
  symbol: string;
  direction: 'long' | 'short';
  quantity: string;
  average_entry_price: string;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  unrealized_pl: string | null;
  realized_pl: string | null;
  status: 'open' | 'closed';
  opened_at: Date;
  closed_at: Date | null;
  updated_at: Date;
}

type Mismatch = {
  code: ReconciliationMismatchCode;
  severity: 'info' | 'warning' | 'error' | 'critical';
  scope: 'order' | 'position' | 'provider' | 'snapshot' | 'run';
  internalOrderId: string | null;
  internalPositionId: string | null;
  providerOrderId: string | null;
  providerPositionId: string | null;
  expectedField: string | null;
  expectedValue: unknown;
  actualValue: unknown;
  detail: Record<string, unknown> | null;
};

const NUM_TOLERANCE = 1e-6;

export class ReconciliationService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: ReconciliationServiceDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  async getStatus(userId: string): Promise<ReconciliationStatusDto> {
    const lastRunRes = await this.pool.query<{
      id: string;
      health_state: ReconciliationHealthState;
    }>(
      `SELECT id, health_state FROM reconciliation_runs
        WHERE user_id = $1
        ORDER BY started_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    const counts = await this.pool.query<{ open_findings: string; total_runs: string }>(
      `SELECT
         (SELECT count(*)::text FROM reconciliation_findings
            WHERE user_id = $1 AND resolution_state IN ('open','acknowledged')) AS open_findings,
         (SELECT count(*)::text FROM reconciliation_runs WHERE user_id = $1) AS total_runs`,
      [userId],
    );
    const openFindings = Number(counts.rows[0]?.open_findings ?? 0);
    const totalRuns = Number(counts.rows[0]?.total_runs ?? 0);
    let healthState: ReconciliationHealthState = 'synchronized';
    let lastRun: ReconciliationRunDto | null = null;
    if (lastRunRes.rows[0]) {
      healthState = deriveHealthState(lastRunRes.rows[0].health_state, openFindings);
      lastRun = await this.loadRun(userId, lastRunRes.rows[0].id);
    }
    return {
      lastRun,
      healthState,
      openFindings,
      totalRuns,
      architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
      reconciliationVersion: RECONCILIATION_VERSION,
      automationOff: true,
      liveExecutionAvailable: false,
    };
  }

  async listRuns(
    userId: string,
    opts: { limit: number; executionProfileId?: string },
  ): Promise<{ runs: ReconciliationRunDto[] }> {
    const limit = clampLimit(opts.limit);
    const params: (string | number)[] = [userId, limit];
    let where = 'user_id = $1';
    if (opts.executionProfileId) {
      params.push(opts.executionProfileId);
      where += ` AND execution_profile_id = $3`;
    }
    const res = await this.pool.query(
      `SELECT * FROM reconciliation_runs WHERE ${where}
        ORDER BY started_at DESC, id DESC LIMIT $2`,
      params,
    );
    return { runs: res.rows.map((r) => toRunDto(r)) };
  }

  async getRunDetail(userId: string, runId: string): Promise<ReconciliationRunDetailDto> {
    const run = await this.loadRun(userId, runId);
    if (!run) throw Errors.notFound('Reconciliation run not found');
    const findingsRes = await this.pool.query(
      `SELECT * FROM reconciliation_findings WHERE run_id = $1 AND user_id = $2
        ORDER BY created_at ASC, id ASC`,
      [runId, userId],
    );
    const extraRes = await this.pool.query<{
      expected_order_refs: string[];
      expected_position_refs: string[];
      provider_order_ids: string[];
      provider_position_ids: string[];
      matched_order_pairs: { internalOrderId: string; providerOrderId: string }[];
      matched_position_pairs: { internalPositionId: string; providerPositionId: string }[];
    }>(
      `SELECT expected_order_refs, expected_position_refs, provider_order_ids,
              provider_position_ids, matched_order_pairs, matched_position_pairs
         FROM reconciliation_runs WHERE id = $1 AND user_id = $2`,
      [runId, userId],
    );
    const extra = extraRes.rows[0];
    return {
      ...run,
      findings: findingsRes.rows.map((f) => toFindingDto(f)),
      expectedOrderRefs: extra?.expected_order_refs ?? [],
      expectedPositionRefs: extra?.expected_position_refs ?? [],
      providerOrderIds: extra?.provider_order_ids ?? [],
      providerPositionIds: extra?.provider_position_ids ?? [],
      matchedOrderPairs: extra?.matched_order_pairs ?? [],
      matchedPositionPairs: extra?.matched_position_pairs ?? [],
    };
  }

  async listFindings(
    userId: string,
    opts: {
      limit: number;
      executionProfileId?: string;
      state?: 'open' | 'acknowledged' | 'resolved' | 'ignored';
    },
  ): Promise<{ findings: ReconciliationFindingDto[] }> {
    const limit = clampLimit(opts.limit);
    const params: (string | number)[] = [userId, limit];
    let where = 'user_id = $1';
    if (opts.executionProfileId) {
      params.push(opts.executionProfileId);
      where += ` AND execution_profile_id = $3`;
    }
    if (opts.state) {
      params.push(opts.state);
      where += ` AND resolution_state = $${params.length}`;
    }
    const res = await this.pool.query(
      `SELECT * FROM reconciliation_findings WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      params,
    );
    return { findings: res.rows.map((f) => toFindingDto(f)) };
  }

  async triggerRun(opts: TriggerRunOptions): Promise<ReconciliationTriggerResponse> {
    const client = await this.pool.connect();
    try {
      const profileRes = await client.query<LoadedProfile>(
        `SELECT id, user_id, provider_slug, environment, enabled
           FROM execution_profiles WHERE id = $1 AND user_id = $2`,
        [opts.executionProfileId, opts.userId],
      );
      const profile = profileRes.rows[0];
      if (!profile) throw Errors.notFound('Execution profile not found');
      if (profile.user_id !== opts.userId) {
        throw Errors.forbidden('You do not have access to this execution profile');
      }
      const providerId = opts.providerId ?? profile.provider_slug;
      const lockKey = advisoryLockKey(profile.id, providerId);

      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [String(lockKey)]);

      // Short idempotency window.
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM reconciliation_runs
          WHERE execution_profile_id = $1 AND provider_id = $2 AND trigger = $3
            AND started_at > now() - interval '30 seconds'
          ORDER BY started_at DESC LIMIT 1`,
        [profile.id, providerId, opts.trigger],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        const existingId = existing.rows[0].id;
        await waitForRunCompletion(this.pool, existingId, 5_000);
        const existingRun = await this.loadRun(opts.userId, existingId);
        if (existingRun) {
          return {
            run: existingRun,
            findingsCreated: existingRun.summary.findingsTotal,
            correctiveActionsTaken: false,
          };
        }
      }

      const runId = randomUUID();
      const now = this.now();
      await client.query(
        `INSERT INTO reconciliation_runs
           (id, user_id, execution_profile_id, provider_id, status, trigger, health_state,
            started_at, architecture_version, reconciliation_version, lock_key)
         VALUES ($1,$2,$3,$4,'started',$5,'synchronized',$6,$7,$8,$9)`,
        [
          runId,
          opts.userId,
          profile.id,
          providerId,
          opts.trigger,
          now,
          EXECUTION_ARCHITECTURE_VERSION,
          RECONCILIATION_VERSION,
          String(lockKey),
        ],
      );

      // 1. Provider snapshot (fail-closed on error).
      let snapshot: ReconciliationProviderSnapshot;
      try {
        snapshot = await this.deps.snapshots.getSnapshot({
          userId: opts.userId,
          executionProfileId: profile.id,
          providerId,
        });
      } catch (err) {
        // Persisted failure reasons come from a closed vocabulary keyed by the
        // normalized category. Error/provider message text is never stored.
        snapshot = {
          providerId,
          accountRef: null,
          retrievedAt: this.now().toISOString(),
          orders: [],
          positions: [],
          providerUnavailable: true,
          providerUnavailableReason: providerFailureReason(err),
        };
      }
      // Whichever snapshot provider produced the record, the persisted reason
      // is a closed token; free text from a returned snapshot is withheld too.
      const unavailableReason = snapshot.providerUnavailable ? persistedFailureReason(snapshot.providerUnavailableReason) : null;

      await this.updateStatus(client, runId, 'provider_snapshot_acquired');
      await client.query(
        `INSERT INTO reconciliation_snapshots
           (run_id, user_id, execution_profile_id, provider_id, retrieved_at,
            provider_unavailable, provider_unavailable_reason, orders_snapshot, positions_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          runId,
          opts.userId,
          profile.id,
          providerId,
          new Date(snapshot.retrievedAt),
          snapshot.providerUnavailable,
          unavailableReason,
          JSON.stringify(snapshot.orders),
          JSON.stringify(snapshot.positions),
        ],
      );

      // 2. Load expected internal state.
      const internalOrders = await client.query<LoadedOrder>(
        `SELECT * FROM execution_orders
          WHERE execution_profile_id = $1 AND user_id = $2
          ORDER BY created_at ASC`,
        [profile.id, opts.userId],
      );
      const internalPositions = await client.query<LoadedPosition>(
        `SELECT * FROM execution_positions
          WHERE execution_profile_id = $1 AND user_id = $2
          ORDER BY opened_at ASC`,
        [profile.id, opts.userId],
      );

      await this.updateStatus(client, runId, 'matching');

      // 3. Match + compare.
      const { findings, matchedOrderPairs, matchedPositionPairs } = this.compareStates({
        internalOrders: internalOrders.rows,
        internalPositions: internalPositions.rows,
        snapshot,
      });

      if (snapshot.providerUnavailable) {
        findings.unshift({
          code: 'provider_unavailable',
          severity: 'critical',
          scope: 'provider',
          internalOrderId: null,
          internalPositionId: null,
          providerOrderId: null,
          providerPositionId: null,
          expectedField: 'provider_available',
          expectedValue: true,
          actualValue: false,
          detail: { reason: unavailableReason ?? PROVIDER_FAILURE_UNKNOWN },
        });
      }

      await this.updateStatus(client, runId, 'findings_created');

      // 4. Persist findings.
      for (const f of findings) {
        await client.query(
          `INSERT INTO reconciliation_findings
             (run_id, user_id, execution_profile_id, code, severity, scope,
              internal_order_id, internal_position_id, provider_order_id, provider_position_id,
              expected_field, expected_value, actual_value, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            runId,
            opts.userId,
            profile.id,
            f.code,
            f.severity,
            f.scope,
            f.internalOrderId,
            f.internalPositionId,
            f.providerOrderId,
            f.providerPositionId,
            f.expectedField,
            f.expectedValue === undefined || f.expectedValue === null
              ? null
              : JSON.stringify(f.expectedValue),
            f.actualValue === undefined || f.actualValue === null
              ? null
              : JSON.stringify(f.actualValue),
            f.detail ? JSON.stringify(f.detail) : null,
          ],
        );
      }

      const openCount = findings.filter((f) => needsAttention(f.code)).length;
      const totalCount = findings.length;
      let finalStatus: ReconciliationRunStatus;
      let healthState: ReconciliationHealthState;
      let failureReason: string | null = null;

      if (snapshot.providerUnavailable) {
        finalStatus = 'failed';
        healthState = 'provider_unavailable';
        failureReason = unavailableReason ?? PROVIDER_FAILURE_UNKNOWN;
      } else if (totalCount === 0) {
        finalStatus = 'no_action';
        healthState = 'synchronized';
      } else {
        finalStatus = 'resolved';
        healthState = openCount > 0 ? 'manual_resolution_required' : 'synchronized';
        if (findings.some((f) => f.code === 'uncertain_outcome')) healthState = 'uncertain';
        else if (findings.some((f) => f.severity === 'error' || f.severity === 'critical'))
          healthState = 'mismatch_detected';
      }

      await client.query(
        `UPDATE reconciliation_runs SET
           status = $2, health_state = $3, finished_at = $4, failure_reason = $5,
           expected_orders = $6, expected_positions = $7,
           provider_orders = $8, provider_positions = $9,
           matched_orders = $10, matched_positions = $11,
           findings_total = $12, findings_open = $13,
           provider_unavailable = $14,
           expected_order_refs = $15::jsonb, expected_position_refs = $16::jsonb,
           provider_order_ids = $17::jsonb, provider_position_ids = $18::jsonb,
           matched_order_pairs = $19::jsonb, matched_position_pairs = $20::jsonb
         WHERE id = $1`,
        [
          runId,
          finalStatus,
          healthState,
          now,
          failureReason,
          internalOrders.rows.length,
          internalPositions.rows.length,
          snapshot.orders.length,
          snapshot.positions.length,
          matchedOrderPairs.length,
          matchedPositionPairs.length,
          totalCount,
          openCount,
          snapshot.providerUnavailable,
          JSON.stringify(internalOrders.rows.map((o) => o.client_order_id)),
          JSON.stringify(
            internalPositions.rows.map((p) => p.provider_position_id ?? p.id),
          ),
          JSON.stringify(snapshot.orders.map((o) => o.providerOrderId)),
          JSON.stringify(snapshot.positions.map((p) => p.providerPositionId)),
          JSON.stringify(matchedOrderPairs),
          JSON.stringify(matchedPositionPairs),
        ],
      );

      await client.query('COMMIT');

      await this.deps.audit.log({
        userId: opts.userId,
        action: 'execution.reconciliation_run_completed',
        entityType: 'execution_profile',
        entityId: profile.id,
        ip: opts.meta?.ip ?? null,
        userAgent: opts.meta?.userAgent ?? null,
        metadata: {
          runId,
          providerId,
          trigger: opts.trigger,
          status: finalStatus,
          healthState,
          findingsTotal: totalCount,
          findingsOpen: openCount,
          correctiveActionsTaken: false,
          reconciliationVersion: RECONCILIATION_VERSION,
          automationOff: true,
          simulated: profile.provider_slug === PAPER_EXECUTION_PROVIDER_ID,
        },
      });

      const run = await this.loadRun(opts.userId, runId);
      if (!run) throw Errors.internal('Reconciliation run could not be loaded after creation');
      return { run, findingsCreated: totalCount, correctiveActionsTaken: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async resolveFinding(
    userId: string,
    findingId: string,
    input: ReconciliationFindingResolveInput,
    meta?: { ip?: string | null; userAgent?: string | null },
  ): Promise<ReconciliationFindingDto> {
    const res = await this.pool.query<{
      run_id: string;
      execution_profile_id: string;
      code: string;
    }>(
      'SELECT run_id, execution_profile_id, code FROM reconciliation_findings WHERE id = $1 AND user_id = $2',
      [findingId, userId],
    );
    const row = res.rows[0];
    if (!row) throw Errors.notFound('Reconciliation finding not found');

    let state: 'acknowledged' | 'resolved' | 'ignored';
    switch (input.action) {
      case 'acknowledge':
        state = 'acknowledged';
        break;
      case 'mark_resolved':
        state = 'resolved';
        break;
      case 'ignore':
        state = 'ignored';
        break;
      default:
        throw Errors.invalidInput('Unsupported resolution action');
    }

    const now = this.now();
    const upd = await this.pool.query(
      `UPDATE reconciliation_findings
          SET resolution_state = $2,
              resolved_by = $3,
              resolved_at = CASE WHEN $2 = 'acknowledged' THEN NULL ELSE $4::timestamptz END,
              resolution_note = $5
        WHERE id = $1 AND user_id = $3
        RETURNING *`,
      [findingId, state, userId, now.toISOString(), input.note ?? null],
    );
    await this.recomputeRunHealth(row.run_id, userId);

    await this.deps.audit.log({
      userId,
      action: 'execution.reconciliation_finding_resolved',
      entityType: 'execution_profile',
      entityId: row.execution_profile_id,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      metadata: {
        findingId,
        action: input.action,
        state,
        code: row.code,
        note: input.note ?? null,
        reconciliationVersion: RECONCILIATION_VERSION,
      },
    });

    return toFindingDto(upd.rows[0]);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async loadRun(userId: string, runId: string): Promise<ReconciliationRunDto | null> {
    const res = await this.pool.query(
      'SELECT * FROM reconciliation_runs WHERE id = $1 AND user_id = $2',
      [runId, userId],
    );
    return res.rows[0] ? toRunDto(res.rows[0]) : null;
  }

  private async updateStatus(
    client: pg.PoolClient,
    runId: string,
    status: ReconciliationRunStatus,
  ): Promise<void> {
    await client.query(
      `UPDATE reconciliation_runs SET status = $2, updated_at = now() WHERE id = $1`,
      [runId, status],
    );
  }

  private async recomputeRunHealth(runId: string, userId: string): Promise<void> {
    const counts = await this.pool.query<{ open: string; total: string }>(
      `SELECT
         count(*) FILTER (WHERE resolution_state IN ('open','acknowledged'))::text AS open,
         count(*)::text AS total
       FROM reconciliation_findings WHERE run_id = $1 AND user_id = $2`,
      [runId, userId],
    );
    const open = Number(counts.rows[0]?.open ?? 0);
    const total = Number(counts.rows[0]?.total ?? 0);
    const run = await this.pool.query<{ provider_unavailable: boolean }>(
      'SELECT provider_unavailable FROM reconciliation_runs WHERE id = $1 AND user_id = $2',
      [runId, userId],
    );
    const providerUnavailable = run.rows[0]?.provider_unavailable ?? false;
    let health: ReconciliationHealthState;
    if (providerUnavailable) health = 'provider_unavailable';
    else if (total === 0) health = 'synchronized';
    else if (open === 0) health = 'synchronized';
    else health = 'manual_resolution_required';
    await this.pool.query(
      `UPDATE reconciliation_runs
          SET findings_open = $2, findings_total = $3, health_state = $4, updated_at = now()
        WHERE id = $1`,
      [runId, open, total, health],
    );
  }

  private compareStates(args: {
    internalOrders: readonly LoadedOrder[];
    internalPositions: readonly LoadedPosition[];
    snapshot: ReconciliationProviderSnapshot;
  }): {
    findings: Mismatch[];
    matchedOrderPairs: Array<{ internalOrderId: string; providerOrderId: string }>;
    matchedPositionPairs: Array<{ internalPositionId: string; providerPositionId: string }>;
  } {
    const findings: Mismatch[] = [];
    const matchedOrderPairs: Array<{ internalOrderId: string; providerOrderId: string }> = [];
    const matchedPositionPairs: Array<{
      internalPositionId: string;
      providerPositionId: string;
    }> = [];

    const unmatchedProviderOrders = new Map(
      args.snapshot.orders.map((o) => [o.providerOrderId, o]),
    );
    const matchedProviderOrderIds = new Set<string>();

    for (const internal of args.internalOrders) {
      const isUncertain = awaitIsUncertain(internal);
      const terminalWithoutOutcome = isTerminalWithoutOutcome(internal);

      let match: ReconciliationProviderOrder | null = null;

      // 1. Exact providerOrderId match.
      if (
        internal.provider_order_id &&
        unmatchedProviderOrders.has(internal.provider_order_id)
      ) {
        match = unmatchedProviderOrders.get(internal.provider_order_id)!;
      }
      // 2. clientOrderId / idempotencyKey match.
      if (!match) {
        for (const [pid, o] of unmatchedProviderOrders) {
          if (matchedProviderOrderIds.has(pid)) continue;
          const clientMatches =
            o.clientOrderId && o.clientOrderId === internal.client_order_id;
          const idempMatches =
            o.idempotencyKey && o.idempotencyKey === internal.idempotency_key;
          if (clientMatches || idempMatches) {
            if (match) {
              findings.push({
                code: 'ambiguous_match',
                severity: 'error',
                scope: 'order',
                internalOrderId: internal.id,
                internalPositionId: null,
                providerOrderId: null,
                providerPositionId: null,
                expectedField: 'provider_order_id',
                expectedValue: 'unambiguous match',
                actualValue: { candidates: [match.providerOrderId, pid] },
                detail: { clientOrderId: internal.client_order_id },
              });
              match = null;
              break;
            }
            match = o;
          }
        }
      }

      if (match) {
        matchedProviderOrderIds.add(match.providerOrderId);
        unmatchedProviderOrders.delete(match.providerOrderId);
        matchedOrderPairs.push({
          internalOrderId: internal.id,
          providerOrderId: match.providerOrderId,
        });
        compareOrderFields(findings, internal, match);
      } else {
        if (isUncertain) {
          findings.push({
            code: 'uncertain_outcome',
            severity: 'critical',
            scope: 'order',
            internalOrderId: internal.id,
            internalPositionId: null,
            providerOrderId: internal.provider_order_id,
            providerPositionId: null,
            expectedField: 'provider_order',
            expectedValue: 'order present at provider or deterministically rejected',
            actualValue: 'not found and outcome cannot be determined',
            detail: {
              clientOrderId: internal.client_order_id,
              note: 'M8.5 safety: never auto-retry or resubmit — manual resolution required',
            },
          });
        } else if (!terminalWithoutOutcome && requiresProviderPresence(internal.status)) {
          findings.push({
            code: 'internal_order_missing_at_provider',
            severity: 'error',
            scope: 'order',
            internalOrderId: internal.id,
            internalPositionId: null,
            providerOrderId: internal.provider_order_id,
            providerPositionId: null,
            expectedField: 'provider_order',
            expectedValue: internal.status,
            actualValue: 'not found',
            detail: {
              clientOrderId: internal.client_order_id,
              status: internal.status,
              safetyNote: 'do NOT resubmit without operator review',
            },
          });
        }
      }
    }

    for (const o of unmatchedProviderOrders.values()) {
      findings.push({
        code: 'provider_order_missing_internally',
        severity: 'warning',
        scope: 'order',
        internalOrderId: null,
        internalPositionId: null,
        providerOrderId: o.providerOrderId,
        providerPositionId: null,
        expectedField: 'internal_order',
        expectedValue: 'matching internal order exists',
        actualValue: 'no internal record',
        detail: {
          clientOrderId: o.clientOrderId ?? null,
          status: o.status ?? null,
          symbol: o.symbol ?? null,
        },
      });
    }

    const unmatchedProviderPositions = new Map(
      args.snapshot.positions.map((p) => [p.providerPositionId, p]),
    );
    const matchedProviderPositionIds = new Set<string>();

    for (const internal of args.internalPositions) {
      if (internal.status === 'closed') {
        if (internal.provider_position_id) {
          const stillOpen = unmatchedProviderPositions.get(internal.provider_position_id) ?? null;
          if (stillOpen) {
            findings.push({
              code: 'unexpected_provider_state',
              severity: 'error',
              scope: 'position',
              internalOrderId: null,
              internalPositionId: internal.id,
              providerOrderId: null,
              providerPositionId: internal.provider_position_id,
              expectedField: 'position_status',
              expectedValue: 'closed',
              actualValue: 'open at provider',
              detail: {
                symbol: internal.symbol,
                direction: internal.direction,
                safetyNote: 'do NOT auto-close',
              },
            });
            matchedProviderPositionIds.add(stillOpen.providerPositionId);
            unmatchedProviderPositions.delete(stillOpen.providerPositionId);
            matchedPositionPairs.push({
              internalPositionId: internal.id,
              providerPositionId: stillOpen.providerPositionId,
            });
          }
        }
        continue;
      }

      let match: ReconciliationProviderPosition | null = null;
      if (internal.provider_position_id) {
        const existing = unmatchedProviderPositions.get(internal.provider_position_id);
        if (existing) match = existing;
      }
      if (!match) {
        const candidates: ReconciliationProviderPosition[] = [];
        for (const [, p] of unmatchedProviderPositions) {
          if (matchedProviderPositionIds.has(p.providerPositionId)) continue;
          if (p.symbol && p.symbol !== internal.symbol) continue;
          if (p.direction && p.direction !== internal.direction) continue;
          if (
            p.quantity !== undefined &&
            Math.abs(p.quantity - Number(internal.quantity)) > NUM_TOLERANCE
          )
            continue;
          candidates.push(p);
        }
        if (candidates.length === 1 && candidates[0]) {
          match = candidates[0];
        } else if (candidates.length > 1) {
          findings.push({
            code: 'ambiguous_match',
            severity: 'error',
            scope: 'position',
            internalOrderId: null,
            internalPositionId: internal.id,
            providerOrderId: null,
            providerPositionId: null,
            expectedField: 'provider_position_id',
            expectedValue: 'unambiguous match',
            actualValue: { candidateCount: candidates.length },
            detail: { symbol: internal.symbol, direction: internal.direction },
          });
        }
      }

      if (match) {
        matchedProviderPositionIds.add(match.providerPositionId);
        unmatchedProviderPositions.delete(match.providerPositionId);
        matchedPositionPairs.push({
          internalPositionId: internal.id,
          providerPositionId: match.providerPositionId,
        });
        comparePositionFields(findings, internal, match);
      } else {
        findings.push({
          code: 'internal_position_missing_at_provider',
          severity: 'error',
          scope: 'position',
          internalOrderId: null,
          internalPositionId: internal.id,
          providerOrderId: null,
          providerPositionId: internal.provider_position_id,
          expectedField: 'provider_position',
          expectedValue: 'open position present',
          actualValue: 'not found',
          detail: {
            symbol: internal.symbol,
            direction: internal.direction,
            safetyNote: 'do NOT re-open without operator review',
          },
        });
      }
    }

    for (const p of unmatchedProviderPositions.values()) {
      findings.push({
        code: 'provider_position_missing_internally',
        severity: 'warning',
        scope: 'position',
        internalOrderId: null,
        internalPositionId: null,
        providerOrderId: null,
        providerPositionId: p.providerPositionId,
        expectedField: 'internal_position',
        expectedValue: 'matching internal position exists',
        actualValue: 'no internal record',
        detail: {
          symbol: p.symbol ?? null,
          direction: p.direction ?? null,
          quantity: p.quantity ?? null,
        },
      });
    }

    return { findings, matchedOrderPairs, matchedPositionPairs };
  }
}

/* -------------------------------------------------------------------------- */
/* Paper snapshot provider (DB-backed for the deterministic simulator).       */
/* -------------------------------------------------------------------------- */

export class PaperReconciliationSnapshotProvider implements ReconciliationSnapshotProvider {
  constructor(private readonly pool: pg.Pool) {}

  async getSnapshot(args: {
    userId: string;
    executionProfileId: string;
    providerId: string;
  }): Promise<ReconciliationProviderSnapshot> {
    if (args.providerId !== PAPER_EXECUTION_PROVIDER_ID) {
      throw new ExecutionProviderError(
        'unavailable',
        `Paper snapshot provider cannot serve provider "${args.providerId}"`,
      );
    }
    // Paper: the provider state is exactly the simulated rows in the DB
    // that are flagged simulated = true for this profile/user. The
    // reconciliation engine will therefore find everything synchronized
    // under normal operation; tests inject corrupted state to exercise
    // mismatch detection.
    const ordersRes = await this.pool.query<{
      id: string;
      client_order_id: string;
      idempotency_key: string;
      asset_class: string;
      symbol: string;
      side: 'buy' | 'sell';
      order_type: string;
      quantity: string;
      requested_price: string | null;
      filled_quantity: string;
      average_fill_price: string | null;
      stop_loss_price: string | null;
      take_profit_price: string | null;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, client_order_id, idempotency_key, asset_class, symbol, side, order_type,
              quantity, requested_price, filled_quantity, average_fill_price,
              stop_loss_price, take_profit_price, status, created_at, updated_at
         FROM execution_orders
        WHERE execution_profile_id = $1 AND user_id = $2 AND simulated = true
          AND status NOT IN ('failed')
        ORDER BY created_at ASC`,
      [args.executionProfileId, args.userId],
    );
    const positionsRes = await this.pool.query<{
      id: string;
      provider_position_id: string | null;
      asset_class: string;
      symbol: string;
      direction: 'long' | 'short';
      quantity: string;
      average_entry_price: string;
      stop_loss_price: string | null;
      take_profit_price: string | null;
      unrealized_pl: string | null;
      status: 'open' | 'closed';
      opened_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, provider_position_id, asset_class, symbol, direction, quantity,
              average_entry_price, stop_loss_price, take_profit_price, unrealized_pl,
              status, opened_at, updated_at
         FROM execution_positions
        WHERE execution_profile_id = $1 AND user_id = $2 AND simulated = true AND status = 'open'
        ORDER BY opened_at ASC`,
      [args.executionProfileId, args.userId],
    );

    return {
      providerId: args.providerId,
      accountRef: 'paper',
      retrievedAt: new Date().toISOString(),
      orders: ordersRes.rows.map((o) => ({
        providerOrderId: o.id,
        clientOrderId: o.client_order_id,
        idempotencyKey: o.idempotency_key,
        assetClass: o.asset_class as ReconciliationProviderOrder['assetClass'],
        symbol: o.symbol,
        side: o.side,
        orderType: o.order_type as ReconciliationProviderOrder['orderType'],
        quantity: Number(o.quantity),
        requestedPrice: o.requested_price ? Number(o.requested_price) : null,
        filledQuantity: Number(o.filled_quantity),
        averagePrice: o.average_fill_price ? Number(o.average_fill_price) : null,
        stopLossPrice: o.stop_loss_price ? Number(o.stop_loss_price) : null,
        takeProfitPrice: o.take_profit_price ? Number(o.take_profit_price) : null,
        status: o.status as ReconciliationProviderOrder['status'],
        createdAt: o.created_at.toISOString(),
        updatedAt: o.updated_at.toISOString(),
      })),
      positions: positionsRes.rows.map((p) => ({
        providerPositionId: p.provider_position_id ?? p.id,
        assetClass: p.asset_class as ReconciliationProviderPosition['assetClass'],
        symbol: p.symbol,
        direction: p.direction,
        quantity: Number(p.quantity),
        averageEntryPrice: Number(p.average_entry_price),
        stopLossPrice: p.stop_loss_price ? Number(p.stop_loss_price) : null,
        takeProfitPrice: p.take_profit_price ? Number(p.take_profit_price) : null,
        unrealizedPl: p.unrealized_pl ? Number(p.unrealized_pl) : null,
        openedAt: p.opened_at.toISOString(),
        updatedAt: p.updated_at.toISOString(),
      })),
      providerUnavailable: false,
    };
  }
}

/**
 * Generic provider snapshot adapter. Calls ExecutionProvider.listOrders /
 * listPositions and maps the results. If the provider is unhealthy the call
 * throws and reconciliation records provider_unavailable.
 */
export class ProviderReconciliationSnapshotProvider implements ReconciliationSnapshotProvider {
  constructor(private readonly getProvider: (id: string) => ExecutionProvider | undefined) {}

  async getSnapshot(args: {
    userId: string;
    executionProfileId: string;
    providerId: string;
  }): Promise<ReconciliationProviderSnapshot> {
    void args.userId;
    void args.executionProfileId;
    const provider = this.getProvider(args.providerId);
    if (!provider) {
      throw new ExecutionProviderError('unavailable', 'Execution provider is not registered');
    }
    // Only the safe projection is consulted; the adapter's `reason`/`detail`
    // never enter an error message.
    const health = toSafeProviderHealth(await provider.health());
    if (!health.available || !health.healthy) {
      throw new ExecutionProviderError('unavailable', 'Execution provider is not available');
    }
    let orders: ReconciliationProviderOrder[] = [];
    let positions: ReconciliationProviderPosition[] = [];
    try {
      const [pOrders, pPositions] = await Promise.all([
        provider.listOrders(),
        provider.listPositions(),
      ]);
      orders = pOrders.map((o) => ({
        providerOrderId: o.providerOrderId,
        status: o.status,
        filledQuantity: o.filledQuantity,
        averagePrice: o.averagePrice,
        raw: o.raw,
      }));
      positions = pPositions.map((p) => ({
        providerPositionId: p.providerPositionId,
        assetClass: p.assetClass,
        symbol: p.symbol,
        direction: p.direction,
        quantity: p.quantity,
        averageEntryPrice: p.averageEntryPrice,
        stopLossPrice: p.stopLossPrice,
        takeProfitPrice: p.takeProfitPrice,
        unrealizedPl: p.unrealizedPl,
      }));
    } catch (err) {
      if (isExecutionProviderError(err)) throw err;
      throw new ExecutionProviderError('unavailable', 'Execution provider listing failed');
    }
    return {
      providerId: args.providerId,
      accountRef: null,
      retrievedAt: new Date().toISOString(),
      orders,
      positions,
      providerUnavailable: false,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Closed vocabulary for the persisted `provider_unavailable_reason` /
 * `failure_reason` / finding `detail.reason` values. Keyed by the normalized
 * failure category only; provider or error message text is never persisted.
 */
function providerFailureReason(err: unknown): string {
  const category = isExecutionProviderError(err) && (EXECUTION_FAILURE_CATEGORIES as readonly string[]).includes(err.category)
    ? err.category
    : 'unknown';
  return `provider_error:${category}`;
}
const PROVIDER_FAILURE_UNKNOWN = 'provider_error:unknown';
const PERSISTED_REASON_TOKEN = /^[a-z0-9_:.-]{1,128}$/;
/** A reason supplied by a snapshot provider is persisted only if it is already a machine token. */
function persistedFailureReason(reason: string | null | undefined): string {
  return typeof reason === 'string' && PERSISTED_REASON_TOKEN.test(reason) ? reason : PROVIDER_FAILURE_UNKNOWN;
}

function compareOrderFields(
  findings: Mismatch[],
  internal: LoadedOrder,
  provider: ReconciliationProviderOrder,
): void {
  const add = (
    code: ReconciliationMismatchCode,
    field: string,
    expected: unknown,
    actual: unknown,
    severity: 'warning' | 'error' = 'error',
  ) => {
    findings.push({
      code,
      severity,
      scope: 'order',
      internalOrderId: internal.id,
      internalPositionId: null,
      providerOrderId: provider.providerOrderId,
      providerPositionId: null,
      expectedField: field,
      expectedValue: expected,
      actualValue: actual,
      detail: null,
    });
  };

  if (provider.status && provider.status !== internal.status) {
    const hard = hardStatusDrift(internal.status, provider.status);
    if (hard) add('status_mismatch', 'status', internal.status, provider.status, 'warning');
  }
  if (provider.filledQuantity !== undefined) {
    const expectedFilled = Number(internal.filled_quantity);
    if (Math.abs(provider.filledQuantity - expectedFilled) > NUM_TOLERANCE) {
      const isFull =
        (internal.status === 'filled' &&
          Math.abs(provider.filledQuantity - Number(internal.quantity)) > NUM_TOLERANCE) ||
        (Math.abs(expectedFilled - Number(internal.quantity)) < NUM_TOLERANCE &&
          provider.filledQuantity < Number(internal.quantity) - NUM_TOLERANCE);
      add(
        isFull ? 'filled_quantity_mismatch' : 'partial_fill_quantity_mismatch',
        'filledQuantity',
        expectedFilled,
        provider.filledQuantity,
      );
    }
  }
  if (provider.side && provider.side !== internal.side) {
    add('direction_mismatch', 'side', internal.side, provider.side);
  }
  if (provider.symbol && provider.symbol !== internal.symbol) {
    add('symbol_mismatch', 'symbol', internal.symbol, provider.symbol);
  }
  if (
    provider.averagePrice !== undefined &&
    provider.averagePrice !== null &&
    internal.average_fill_price
  ) {
    const exp = Number(internal.average_fill_price);
    if (exp > 0 && Math.abs(provider.averagePrice - exp) / exp > 1e-4) {
      add('entry_price_mismatch', 'averagePrice', exp, provider.averagePrice, 'warning');
    }
  }
  if (provider.stopLossPrice !== undefined && internal.stop_loss_price !== null) {
    const sl = Number(internal.stop_loss_price);
    if (
      provider.stopLossPrice === null ||
      Math.abs(provider.stopLossPrice - sl) > NUM_TOLERANCE
    ) {
      add('stop_loss_mismatch', 'stopLossPrice', sl, provider.stopLossPrice);
    }
  }
  if (provider.takeProfitPrice !== undefined && internal.take_profit_price !== null) {
    const tp = Number(internal.take_profit_price);
    if (
      provider.takeProfitPrice === null ||
      Math.abs(provider.takeProfitPrice - tp) > NUM_TOLERANCE
    ) {
      add('take_profit_mismatch', 'takeProfitPrice', tp, provider.takeProfitPrice);
    }
  }
}

function comparePositionFields(
  findings: Mismatch[],
  internal: LoadedPosition,
  provider: ReconciliationProviderPosition,
): void {
  const add = (
    code: ReconciliationMismatchCode,
    field: string,
    expected: unknown,
    actual: unknown,
    severity: 'warning' | 'error' = 'error',
  ) => {
    findings.push({
      code,
      severity,
      scope: 'position',
      internalOrderId: null,
      internalPositionId: internal.id,
      providerOrderId: null,
      providerPositionId: provider.providerPositionId,
      expectedField: field,
      expectedValue: expected,
      actualValue: actual,
      detail: null,
    });
  };
  if (provider.direction && provider.direction !== internal.direction) {
    add('direction_mismatch', 'direction', internal.direction, provider.direction);
  }
  if (provider.symbol && provider.symbol !== internal.symbol) {
    add('symbol_mismatch', 'symbol', internal.symbol, provider.symbol);
  }
  if (
    provider.quantity !== undefined &&
    Math.abs(provider.quantity - Number(internal.quantity)) > NUM_TOLERANCE
  ) {
    add('filled_quantity_mismatch', 'quantity', Number(internal.quantity), provider.quantity);
  }
  if (provider.averageEntryPrice !== undefined) {
    const exp = Number(internal.average_entry_price);
    if (exp > 0 && Math.abs(provider.averageEntryPrice - exp) / exp > 1e-4) {
      add('entry_price_mismatch', 'averageEntryPrice', exp, provider.averageEntryPrice, 'warning');
    }
  }
  if (provider.stopLossPrice !== undefined && internal.stop_loss_price !== null) {
    const sl = Number(internal.stop_loss_price);
    if (
      provider.stopLossPrice === null ||
      Math.abs(provider.stopLossPrice - sl) > NUM_TOLERANCE
    ) {
      add('stop_loss_mismatch', 'stopLossPrice', sl, provider.stopLossPrice);
    }
  }
  if (provider.takeProfitPrice !== undefined && internal.take_profit_price !== null) {
    const tp = Number(internal.take_profit_price);
    if (
      provider.takeProfitPrice === null ||
      Math.abs(provider.takeProfitPrice - tp) > NUM_TOLERANCE
    ) {
      add('take_profit_mismatch', 'takeProfitPrice', tp, provider.takeProfitPrice);
    }
  }
}

function hardStatusDrift(internal: string, provider: string): boolean {
  const terminal = new Set(['filled', 'rejected', 'cancelled', 'expired', 'failed']);
  if (internal === 'filled' && provider !== 'filled' && provider !== 'partially_filled') return true;
  if (internal === 'rejected' && provider !== 'rejected') return true;
  if (provider === 'rejected' && internal !== 'rejected' && internal !== 'failed') return true;
  if (terminal.has(internal) && terminal.has(provider) && internal !== provider) return true;
  return false;
}

function awaitIsUncertain(order: LoadedOrder): boolean {
  const uncertain = new Set(['requested', 'validating', 'submitted']);
  return uncertain.has(order.status) && !order.provider_order_id;
}

function isTerminalWithoutOutcome(order: LoadedOrder): boolean {
  return (
    (order.status === 'failed' ||
      order.status === 'rejected' ||
      order.status === 'cancelled' ||
      order.status === 'expired') &&
    !order.provider_order_id
  );
}

function requiresProviderPresence(status: string): boolean {
  // Non-terminal or filled/accepted/partially filled orders should have a provider record.
  return (
    status === 'submitted' ||
    status === 'accepted' ||
    status === 'partially_filled' ||
    status === 'filled'
  );
}

function needsAttention(code: ReconciliationMismatchCode): boolean {
  switch (code) {
    case 'provider_unavailable':
    case 'internal_order_missing_at_provider':
    case 'internal_position_missing_at_provider':
    case 'provider_order_missing_internally':
    case 'provider_position_missing_internally':
    case 'status_mismatch':
    case 'partial_fill_quantity_mismatch':
    case 'filled_quantity_mismatch':
    case 'direction_mismatch':
    case 'symbol_mismatch':
    case 'entry_price_mismatch':
    case 'stop_loss_mismatch':
    case 'take_profit_mismatch':
    case 'unexpected_provider_state':
    case 'stale_state':
    case 'uncertain_outcome':
    case 'ambiguous_match':
    case 'tenant_mismatch':
      return true;
    default:
      return false;
  }
}

function deriveHealthState(
  last: ReconciliationHealthState,
  openFindings: number,
): ReconciliationHealthState {
  if (last === 'provider_unavailable') return 'provider_unavailable';
  if (last === 'uncertain') return 'uncertain';
  if (openFindings > 0) return 'manual_resolution_required';
  if (last === 'mismatch_detected') return 'mismatch_detected';
  return 'synchronized';
}

function advisoryLockKey(profileId: string, providerId: string): bigint {
  const hash = createHash('sha256')
    .update(`reconciliation:${profileId}:${providerId}`, 'utf8')
    .digest();
  return hash.readBigInt64BE(0);
}

async function waitForRunCompletion(
  pool: pg.Pool,
  runId: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await pool.query<{ status: string }>(
      `SELECT status FROM reconciliation_runs WHERE id = $1`,
      [runId],
    );
    const s = res.rows[0]?.status;
    if (
      s &&
      s !== 'started' &&
      s !== 'provider_snapshot_acquired' &&
      s !== 'matching' &&
      s !== 'findings_created'
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  return Math.min(Math.max(1, Math.trunc(limit)), 200);
}

function toRunDto(row: Record<string, unknown>): ReconciliationRunDto {
  return {
    id: row.id as string,
    executionProfileId: row.execution_profile_id as string,
    providerId: row.provider_id as string,
    status: row.status as ReconciliationRunStatus,
    trigger: row.trigger as ReconciliationRunTrigger,
    healthState: row.health_state as ReconciliationHealthState,
    startedAt: (row.started_at as Date).toISOString(),
    finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
    failureReason: (row.failure_reason as string | null) ?? null,
    summary: {
      expectedOrders: Number(row.expected_orders),
      expectedPositions: Number(row.expected_positions),
      providerOrders: Number(row.provider_orders),
      providerPositions: Number(row.provider_positions),
      matchedOrders: Number(row.matched_orders),
      matchedPositions: Number(row.matched_positions),
      findingsTotal: Number(row.findings_total),
      findingsOpen: Number(row.findings_open),
    },
    architectureVersion: row.architecture_version as string,
    reconciliationVersion: row.reconciliation_version as string,
    providerUnavailable: Boolean(row.provider_unavailable),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function toFindingDto(row: Record<string, unknown>): ReconciliationFindingDto {
  const parseJson = (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v) as unknown;
      } catch {
        return v;
      }
    }
    return v;
  };
  return {
    id: row.id as string,
    runId: row.run_id as string,
    code: row.code as ReconciliationMismatchCode,
    severity: row.severity as ReconciliationFindingDto['severity'],
    scope: row.scope as ReconciliationFindingDto['scope'],
    internalOrderId: (row.internal_order_id as string | null) ?? null,
    internalPositionId: (row.internal_position_id as string | null) ?? null,
    providerOrderId: (row.provider_order_id as string | null) ?? null,
    providerPositionId: (row.provider_position_id as string | null) ?? null,
    expectedField: (row.expected_field as string | null) ?? null,
    expectedValue: parseJson(row.expected_value),
    actualValue: parseJson(row.actual_value),
    detail: parseJson(row.detail) as Record<string, unknown> | null,
    resolutionState: row.resolution_state as ReconciliationFindingDto['resolutionState'],
    resolvedBy: (row.resolved_by as string | null) ?? null,
    resolvedAt: row.resolved_at ? (row.resolved_at as Date).toISOString() : null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
