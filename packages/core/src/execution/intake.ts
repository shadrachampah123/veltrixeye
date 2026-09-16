import { createHash } from 'node:crypto';
import type pg from 'pg';
import {
  ALERT_TRIGGER_STATES,
  EXECUTION_ARCHITECTURE_VERSION,
  executionDecisionSchema,
  executionIdempotencyKey,
  type ExecutionAction,
  type ExecutionDecisionInput,
  type ExecutionRequestDto,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { AuditService } from '../audit.js';
import type { AutomationService } from './automation.js';
import type { KillSwitchService } from './kill-switch.js';
import { evaluateExecutionGates, type ExecutionGateResult } from './gates.js';
import type { ExecutionProviderRegistry } from './registry.js';

/**
 * M8.1 — execution decision intake (the ONLY door toward a future order).
 *
 * Pipeline position (nothing upstream is bypassed):
 *   Market Data → Strategy Detection → Setup Qualification → Signal/Quality
 *   Validation → Risk Engine → **Execution Decision (here)** → Provider…
 *
 * Guarantees:
 *  - the decision is zod-validated BEFORE anything else touches the DB;
 *  - ownership is proven from the DB (setup → version → strategy → user);
 *    foreign setups are masked 404s, exactly like every other resource;
 *  - the decision must MATCH the stored setup (version, instrument,
 *    direction) — the execution layer never invents or reinterprets a trade;
 *  - all 15 safety gates run; in M8.1 gate `risk_decision` can never pass
 *    (no risk engine exists yet), so no intake can be ACCEPTED — the
 *    architecture is proven without a single executable path;
 *  - idempotency: UNIQUE (setup_id, execution_profile_id, action) + a UNIQUE
 *    sha256 identity key. Replays, retries and concurrent twins collapse onto
 *    the first row and return it (`replayed: true`), never a duplicate;
 *  - every outcome lands in `execution_events` (append-only) AND the
 *    platform audit log; neither ever carries credentials.
 */
export interface ExecutionIntakeMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export interface ExecutionIntakeResult {
  accepted: boolean;
  /** True when an existing request row was returned instead of a new one. */
  replayed: boolean;
  request: ExecutionRequestDto;
  gate: ExecutionGateResult;
}

export interface ExecutionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const SILENT_EXECUTION_LOGGER: ExecutionLogger = { info: () => {}, warn: () => {} };

/** Stable 64-char idempotency key: sha256 of the derived identity. */
export function executionIdempotencyHash(args: {
  userId: string;
  setupId: string;
  executionProfileId: string;
  action: ExecutionAction;
}): string {
  return createHash('sha256').update(executionIdempotencyKey(args), 'utf8').digest('hex');
}

/**
 * Stable platform order identity for FUTURE orders (M8.2+). Derived from the
 * same identity as the idempotency key, so a retried execution can never
 * mint a second client order id. 27 chars, well under the 64-char cap.
 */
export function deriveClientOrderId(idempotencyHash: string): string {
  return `ve-${idempotencyHash.slice(0, 24)}`;
}

interface SetupProvenanceRow {
  setup_id: string;
  state: string;
  direction: 'long' | 'short';
  as_of_ms: string;
  strategy_version_id: string;
  strategy_id: string;
  strategy_owner: string;
  asset_class: string;
  symbol: string;
}

export class ExecutionIntakeService {
  private readonly logger: ExecutionLogger;

  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: {
      automation: AutomationService;
      killSwitches: KillSwitchService;
      providers: ExecutionProviderRegistry;
      audit: AuditService;
    },
    options?: { logger?: ExecutionLogger },
  ) {
    this.logger = options?.logger ?? SILENT_EXECUTION_LOGGER;
  }

  /**
   * Submit a server-produced execution decision for evaluation.
   *
   * Never throws for a gate refusal — it returns the persisted, rejected
   * request so callers (and audits) see the exact gate and reason. Throws
   * only for malformed decisions, missing/foreign resources, and true
   * internal errors.
   */
  async submitExecutionDecision(args: {
    userId: string;
    executionProfileId: string;
    decision: unknown;
    meta?: ExecutionIntakeMeta;
  }): Promise<ExecutionIntakeResult> {
    // 1. Validate the decision contract first — garbage never reaches state.
    const parsed = executionDecisionSchema.safeParse(args.decision);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw Errors.invalidInput(`Invalid execution decision — ${detail}`);
    }
    const decision: ExecutionDecisionInput = parsed.data;

    // 2. Profile: owner-scoped (masked 404), resolved from the DB.
    const profileRes = await this.pool.query<{
      id: string;
      enabled: boolean;
      environment: string;
      provider_slug: string;
    }>(
      `SELECT id, enabled, environment, provider_slug FROM execution_profiles
       WHERE id = $1 AND user_id = $2`,
      [args.executionProfileId, args.userId],
    );
    const profile = profileRes.rows[0];
    if (!profile) throw Errors.notFound('Execution profile not found');

    // 3. Setup provenance: the decision must cite a real, owned setup and
    //    agree with everything the pipeline already persisted for it.
    const setupRes = await this.pool.query<SetupProvenanceRow>(
      `SELECT st.id AS setup_id, st.state, st.direction, st.as_of_ms,
              st.strategy_version_id, v.strategy_id, s.user_id AS strategy_owner,
              i.asset_class, i.symbol
       FROM setups st
       JOIN strategy_versions v ON v.id = st.strategy_version_id
       JOIN strategies s ON s.id = v.strategy_id
       JOIN instruments i ON i.id = st.instrument_id
       WHERE st.id = $1`,
      [decision.setupId],
    );
    const setup = setupRes.rows[0];
    if (!setup || setup.strategy_owner !== args.userId) {
      throw Errors.notFound('Setup not found');
    }
    if (setup.strategy_id !== decision.strategyId || setup.strategy_version_id !== decision.strategyVersionId) {
      throw Errors.invalidInput('Execution decision does not match the setup it references');
    }
    if (setup.asset_class !== decision.assetClass || setup.symbol !== decision.symbol) {
      throw Errors.invalidInput('Execution decision instrument does not match the setup');
    }
    if (Number(setup.as_of_ms) !== decision.asOfMs) {
      throw Errors.invalidInput('Execution decision anchor does not match the setup');
    }

    // 4. Idempotency: same identity ⇒ same row, forever.
    const idempotencyHash = executionIdempotencyHash({
      userId: args.userId,
      setupId: decision.setupId,
      executionProfileId: profile.id,
      action: decision.action,
    });
    const existing = await this.findByKey(idempotencyHash);
    if (existing) {
      this.logger.info('execution request replayed', {
        requestId: existing.id,
        status: existing.status,
        gate: existing.rejectionGate ?? null,
      });
      return {
        accepted: existing.status === 'requested',
        replayed: true,
        request: existing,
        gate: {
          passed: existing.status === 'requested',
          failedGate: existing.rejectionGate,
          reason: existing.rejectionReason,
          evaluated: [],
        },
      };
    }

    // 5. Safety gates — server-authoritative, fail-closed.
    const automationState = await this.deps.automation.readState(args.userId);
    const killSwitches = await this.deps.killSwitches.anyActive({
      userId: args.userId,
      strategyId: decision.strategyId,
      executionProfileId: profile.id,
    });
    const provider = this.deps.providers.get(profile.provider_slug);
    const providerHealth = provider ? await provider.health() : null;

    const gate = evaluateExecutionGates({
      authenticated: true, // enforced by the API layer before this service runs
      authorized: true, // proven above via DB ownership joins
      entitlements: automationState.entitlements,
      automation: {
        entitled: automationState.entitlements.canAccessAutomation,
        automationEnabled: automationState.automationEnabled,
      },
      profile: { enabled: profile.enabled, environment: profile.environment as 'paper' | 'demo' | 'live' },
      killSwitches: {
        global: killSwitches.global,
        user: killSwitches.user,
        strategy: killSwitches.strategy,
        profile: killSwitches.profile,
      },
      decision,
      setup: { id: setup.setup_id, direction: setup.direction, state: setup.state },
      // The setup join above resolved the instrument from the platform
      // universe (`instruments`), so the symbol is known by construction.
      instrumentKnown: true,
      // M8.1: no risk engine exists, therefore no risk decision can exist —
      // the gate fails closed and nothing can be accepted. M8.2 produces it.
      riskDecision: null,
      minRr: null,
      // M8.1: no exposure engine — fail closed until M8.2 evaluates it.
      exposureWithinLimits: null,
      providerHealth,
    });

    const accepted = gate.passed;
    const status = accepted ? 'requested' : 'rejected';

    // 6. Persist the request. A concurrent twin with the same identity may
    //    win the race — the unique constraints serialize them and the loser
    //    simply reads the winner's row below (idempotent by construction).
    try {
      await this.pool.query(
        `INSERT INTO execution_requests
           (user_id, execution_profile_id, setup_id, action, status,
            rejection_gate, rejection_reason, decision, idempotency_key, architecture_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          args.userId,
          profile.id,
          decision.setupId,
          decision.action,
          status,
          gate.failedGate,
          gate.reason,
          JSON.stringify(decision),
          idempotencyHash,
          EXECUTION_ARCHITECTURE_VERSION,
        ],
      );
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505')) {
        throw err;
      }
    }

    const request = await this.findByKey(idempotencyHash);
    if (!request) throw Errors.internal('Execution request could not be resolved after insert');

    // 7. Append-only execution audit trail + platform audit log.
    await this.pool.query(
      `INSERT INTO execution_events
         (user_id, execution_profile_id, setup_id, event, to_status, reason, metadata, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        args.userId,
        profile.id,
        decision.setupId,
        accepted ? 'execution_requested' : 'execution_rejected',
        status,
        gate.reason,
        JSON.stringify({
          requestId: request.id,
          gate: gate.failedGate ?? null,
          evaluated: gate.evaluated,
          action: decision.action,
          replayed: false,
          architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
        }),
        args.meta?.ip ?? null,
        args.meta?.userAgent ?? null,
      ],
    );
    await this.deps.audit.log({
      userId: args.userId,
      action: accepted ? 'execution.requested' : 'execution.rejected',
      entityType: 'execution_request',
      entityId: request.id,
      ip: args.meta?.ip ?? null,
      userAgent: args.meta?.userAgent ?? null,
      metadata: {
        setupId: decision.setupId,
        executionProfileId: profile.id,
        action: decision.action,
        gate: gate.failedGate ?? null,
        reason: gate.reason ?? null,
      },
    });

    this.logger.info(accepted ? 'execution request accepted' : 'execution request rejected', {
      requestId: request.id,
      setupId: decision.setupId,
      action: decision.action,
      gate: gate.failedGate ?? null,
    });

    return { accepted, replayed: false, request, gate };
  }

  /** Owner-scoped request list (most recent first). */
  async listForUser(userId: string, limit: number): Promise<{ requests: ExecutionRequestDto[] }> {
    const res = await this.pool.query<ExecutionRequestRow>(
      `SELECT * FROM execution_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return { requests: res.rows.map(toRequestDto) };
  }

  private async findByKey(idempotencyHash: string): Promise<ExecutionRequestDto | null> {
    const res = await this.pool.query<ExecutionRequestRow>(
      `SELECT * FROM execution_requests WHERE idempotency_key = $1`,
      [idempotencyHash],
    );
    const row = res.rows[0];
    return row ? toRequestDto(row) : null;
  }
}

interface ExecutionRequestRow {
  id: string;
  user_id: string;
  execution_profile_id: string;
  setup_id: string;
  action: ExecutionAction;
  status: 'requested' | 'rejected';
  rejection_gate: string | null;
  rejection_reason: string | null;
  decision: unknown;
  idempotency_key: string;
  architecture_version: string;
  created_at: Date;
}

function toRequestDto(row: ExecutionRequestRow): ExecutionRequestDto {
  return {
    id: row.id,
    executionProfileId: row.execution_profile_id,
    setupId: row.setup_id,
    action: row.action,
    status: row.status,
    rejectionGate: (row.rejection_gate as ExecutionRequestDto['rejectionGate']) ?? null,
    rejectionReason: row.rejection_reason,
    decision: row.decision as ExecutionRequestDto['decision'],
    architectureVersion: row.architecture_version,
    createdAt: row.created_at.toISOString(),
  };
}

/** Setup states allowed to originate an execution (same as alert triggers). */
export const EXECUTION_ELIGIBLE_STATES: readonly string[] = ALERT_TRIGGER_STATES;
