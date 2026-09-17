import type pg from 'pg';
import {
  EXECUTION_ARCHITECTURE_VERSION,
  SAFETY_CONTROLS_VERSION,
  type KillSwitchEntryDto,
  type KillSwitchEventAction,
  type KillSwitchEventDto,
  type KillSwitchSource,
  type KillSwitchStatusDto,
  type KillSwitchScope,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';

/**
 * M8.1 — emergency kill-switch contract (four scopes, upserted state).
 * M8.6 strengthens it into a full safety control surface:
 *
 *   - `globalForced` option (from EXECUTION_GLOBAL_KILL_SWITCH): pins the
 *     global switch ON regardless of the table. A forced global switch makes
 *     gate 6 fail for EVERY user and CANNOT be cleared through this service —
 *     it is an environment/ops lever, deliberately unreachable via API.
 *   - Every change attempt is appended to the `kill_switch_events` ledger
 *     (append-only; `activate`/`clear` record even no-op calls with
 *     `changed=false`, while the lower-level operator `set` records only real
 *     transitions). The ledger stores scope, target, resolved owner, actor,
 *     source and reason — enough to answer "who stopped what, when, and why"
 *     after the fact.
 *   - `activate` / `clear` are the USER-facing paths: they enforce ownership
 *     (strategy/profile targets must belong to the acting user — masked 404
 *     otherwise), refuse `global` (platform-operator territory), and require
 *     a reason. Stopping is always allowed; there is no entitlement gate on
 *     the safe direction.
 *   - `tripCircuitBreaker` is the M8.6 automatic path: the risk engine's
 *     loss-limit rejections leave a DURABLE stop (source `circuit_breaker`)
 *     instead of a per-decision refusal. It is idempotent — an active switch
 *     is never re-tripped, so an active breaker cannot flood its own ledger.
 *
 * Semantics (unchanged from M8.1): a switch row is only meaningful when
 * `active = true`; ANY active switch covering an execution attempt refuses
 * it — and the gate layer treats a kill-switch READ ERROR as refusing too
 * (fail-closed). A kill switch is never sufficient for execution, only
 * necessary; it must also NEVER block risk-reducing actions (position exits),
 * which is why only entry paths consult it.
 */

/** Shared read/write executor type (pool or transaction client). */
type Queryable = Pick<pg.Pool, 'query'>;

export interface KillSwitchRow {
  id: string;
  scope: KillSwitchScope;
  target_id: string | null;
  active: boolean;
  reason: string | null;
  source: KillSwitchSource;
  actor_user_id: string | null;
  activated_at: Date | null;
  updated_at: Date;
}

export interface KillSwitchState {
  active: boolean;
  global: boolean;
  user: boolean;
  strategy: boolean;
  profile: boolean;
}

/** Internal description of one switch mutation. */
interface SwitchWrite {
  scope: KillSwitchScope;
  targetId: string | null;
  active: boolean;
  reason: string | null;
  source: KillSwitchSource;
  actorUserId: string | null;
  action: KillSwitchEventAction;
  /** true ⇒ append an event even when state did not change (API calls do). */
  alwaysRecord: boolean;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

export class KillSwitchService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options?: { globalForced?: boolean },
  ) {}

  /** True when the deployment pins the global switch via the environment. */
  isGlobalForced(): boolean {
    return this.options?.globalForced === true;
  }

  async isActive(scope: KillSwitchScope, targetId?: string | null): Promise<boolean> {
    const res = await this.pool.query<{ active: boolean }>(
      `SELECT active FROM kill_switches
       WHERE scope = $1 AND ($2::uuid IS NULL AND target_id IS NULL OR target_id = $2::uuid)`,
      [scope, targetId ?? null],
    );
    return res.rows.some((r) => r.active);
  }

  /** Environment pinning OR a DB row — either alone activates the global stop. */
  async isGlobalActive(): Promise<boolean> {
    if (this.isGlobalForced()) return true;
    return this.isActive('global');
  }

  async isUserActive(userId: string): Promise<boolean> {
    return this.isActive('user', userId);
  }

  async isStrategyActive(strategyId: string): Promise<boolean> {
    return this.isActive('strategy', strategyId);
  }

  async isProfileActive(executionProfileId: string): Promise<boolean> {
    return this.isActive('execution_profile', executionProfileId);
  }

  /**
   * Combined check for an execution attempt: true ⇔ SOME applicable switch
   * is active and execution must be refused. Includes the environment-pinned
   * global switch. A DB error must propagate — the gate layer refuses
   * execution whenever this throws (fail-closed).
   */
  async anyActive(args: {
    userId: string;
    strategyId?: string | null;
    executionProfileId?: string | null;
  }): Promise<KillSwitchState> {
    const global = await this.isGlobalActive();
    const user = await this.isUserActive(args.userId);
    const strategy = args.strategyId ? await this.isStrategyActive(args.strategyId) : false;
    const profile = args.executionProfileId
      ? await this.isProfileActive(args.executionProfileId)
      : false;
    return { active: global || user || strategy || profile, global, user, strategy, profile };
  }

  /* ---------------------------------------------------------------------- */
  /* low-level operator path (M8.1 compatible)                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Upsert a switch state (operator/admin operation — used by tests and any
   * future platform tooling). Never deletes: flipping `active` back to false
   * leaves an auditable row with reason. Appends ONE `kill_switch_events`
   * row only when state actually CHANGES (M8.6).
   */
  async set(
    scope: KillSwitchScope,
    args: {
      targetId?: string | null;
      active: boolean;
      reason?: string | null;
      source?: KillSwitchSource;
      actorUserId?: string | null;
    },
  ): Promise<{ changed: boolean }> {
    return this.apply({
      scope,
      targetId: args.targetId ?? null,
      active: args.active,
      reason: args.reason ?? null,
      source: args.source ?? 'operator',
      actorUserId: args.actorUserId ?? null,
      action: args.active ? 'activated' : 'cleared',
      alwaysRecord: false,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* user-facing safety controls (M8.6)                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Activate a switch for the ACTING user. Always allowed (no entitlement —
   * stopping is never a paid feature). Ownership of strategy/profile targets
   * is proven here; `global` is refused (operator/environment scope only).
   */
  async activate(
    actorUserId: string,
    input: { scope: KillSwitchScope; targetId?: string | null; reason: string },
  ): Promise<{ changed: boolean }> {
    this.assertMutableScope(input.scope);
    const { scope, targetId } = await this.resolveTarget(actorUserId, input.scope, input.targetId);
    return this.apply({
      scope,
      targetId,
      active: true,
      reason: input.reason.trim(),
      source: 'user',
      actorUserId,
      action: 'activated',
      alwaysRecord: true,
    });
  }

  /**
   * Clear a switch the acting user owns. Refused while the environment pins
   * the global switch (defense in depth — the API schema never allows a
   * user-scope global mutation anyway).
   */
  async clear(
    actorUserId: string,
    input: { scope: KillSwitchScope; targetId?: string | null; reason: string },
  ): Promise<{ changed: boolean }> {
    this.assertMutableScope(input.scope);
    if (this.isGlobalForced()) {
      // Only reachable for scope==='global', which assertMutableScope already
      // refuses — kept as a guard so a future caller can never un-pin it.
      throw Errors.conflict(
        'The global kill switch is pinned ON by the deployment environment and cannot be cleared here',
      );
    }
    const { scope, targetId } = await this.resolveTarget(actorUserId, input.scope, input.targetId);
    return this.apply({
      scope,
      targetId,
      active: false,
      reason: input.reason.trim(),
      source: 'user',
      actorUserId,
      action: 'cleared',
      alwaysRecord: true,
    });
  }

  /**
   * M8.6 circuit breaker — called by the risk engine after a loss-limit
   * rejection. Trips the user kill switch with a durable, auditable stop.
   * Idempotent: an already-active switch is left untouched (no event spam,
   * no reason overwrite — the FIRST trip reason is the one on record).
   */
  async tripCircuitBreaker(userId: string, reason: string): Promise<{ changed: boolean }> {
    if (await this.isUserActive(userId)) return { changed: false };
    return this.apply({
      scope: 'user',
      targetId: userId,
      active: true,
      reason: reason.slice(0, 400),
      source: 'circuit_breaker',
      actorUserId: null,
      action: 'activated',
      alwaysRecord: false,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* read models                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Full owner-scoped switch state for one user: the platform global switch
   * (read-only), the user switch, one entry per strategy and per execution
   * profile they own, and the automation summary that produces `effective`.
   * One query set, one transaction-free read — the UI renders exactly this.
   */
  async statusFor(userId: string): Promise<Omit<KillSwitchStatusDto, 'automation'>> {
    const [globalRow, userRow, strategyRows, profileRows] = await Promise.all([
      this.findRow('global', null),
      this.findRow('user', userId),
      this.pool.query<KillSwitchRow & { strategy_id: string; name: string }>(
        `SELECT s.id AS strategy_id, s.name, k.id, k.scope, k.target_id, k.active, k.reason,
                k.source, k.actor_user_id, k.activated_at, k.updated_at
           FROM strategies s
           LEFT JOIN kill_switches k ON k.scope = 'strategy' AND k.target_id = s.id
          WHERE s.user_id = $1
          ORDER BY s.name ASC`,
        [userId],
      ),
      this.pool.query<KillSwitchRow & { profile_id: string; provider_slug: string; environment: string }>(
        `SELECT p.id AS profile_id, p.provider_slug, p.environment, k.id, k.scope, k.target_id,
                k.active, k.reason, k.source, k.actor_user_id, k.activated_at, k.updated_at
           FROM execution_profiles p
           LEFT JOIN kill_switches k ON k.scope = 'execution_profile' AND k.target_id = p.id
          WHERE p.user_id = $1
          ORDER BY p.created_at ASC`,
        [userId],
      ),
    ]);

    const { scope: _gs, ...globalDto } = entryDto('global', null, 'platform', globalRow, this.isGlobalForced());
    void _gs;
    const { scope: _us, ...userDto } = entryDto('user', userId, null, userRow, false);
    void _us;
    const strategies = strategyRows.rows.map((r) => {
      const { scope: _s, ...rest } = entryDto('strategy', r.strategy_id, r.name, rowFromJoin(r));
      void _s;
      return { strategyId: r.strategy_id, ...rest };
    });
    const profiles = profileRows.rows.map((r) => {
      const { scope: _s, ...rest } = entryDto('execution_profile', r.profile_id, r.provider_slug, rowFromJoin(r));
      void _s;
      return { executionProfileId: r.profile_id, providerSlug: r.provider_slug, environment: r.environment, ...rest };
    });

    const breakerActive = userDto.active && userDto.source === 'circuit_breaker';
    return {
      safetyVersion: SAFETY_CONTROLS_VERSION,
      architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
      globalForcedByEnvironment: this.isGlobalForced(),
      global: { ...globalDto, scope: 'global' },
      user: { ...userDto, scope: 'user' },
      strategies,
      profiles,
      anyActive:
        globalDto.active ||
        userDto.active ||
        strategies.some((s) => s.active) ||
        profiles.some((p) => p.active),
      circuitBreaker: {
        active: breakerActive,
        trippedAt: breakerActive ? (userDto.activatedAt ?? null) : null,
        reason: breakerActive ? userDto.reason : null,
      },
    };
  }

  /** Owner-scoped event history (the tenant sees only THEIR switches). */
  async historyForUser(userId: string, limit: number): Promise<{ events: KillSwitchEventDto[] }> {
    const res = await this.pool.query<KillSwitchEventRow>(
      `SELECT e.id, e.scope, e.target_id, e.action, e.source, e.reason, e.changed,
              e.created_at,
              s.name AS strategy_name,
              p.provider_slug AS profile_provider
         FROM kill_switch_events e
         LEFT JOIN strategies s ON e.scope = 'strategy' AND s.id = e.target_id
         LEFT JOIN execution_profiles p ON e.scope = 'execution_profile' AND p.id = e.target_id
        WHERE e.user_id = $1
        ORDER BY e.id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return { events: res.rows.map(eventDto) };
  }

  /* ---------------------------------------------------------------------- */
  /* internals                                                                */
  /* ---------------------------------------------------------------------- */

  /** The user API may never touch the platform-wide switch. */
  private assertMutableScope(scope: KillSwitchScope): void {
    if (scope === 'global') {
      throw Errors.forbidden(
        'The global kill switch is platform-operated (deployment environment or operator tooling) — accounts can only stop themselves',
      );
    }
    if (scope !== 'user' && scope !== 'strategy' && scope !== 'execution_profile') {
      throw Errors.invalidInput(`Unknown kill switch scope "${scope}"`);
    }
  }

  /**
   * Resolve + authorize the target for a user-facing mutation.
   * - `user`      → always the acting user (a client cannot aim at another).
   * - `strategy`  → must exist and belong to the actor (masked 404).
   * - `execution_profile` → same, through execution_profiles.user_id.
   */
  private async resolveTarget(
    actorUserId: string,
    scope: KillSwitchScope,
    targetId?: string | null,
  ): Promise<{ scope: KillSwitchScope; targetId: string | null }> {
    if (scope === 'user') {
      if (targetId && targetId !== actorUserId) {
        throw Errors.invalidInput('The user-scope kill switch always targets the session account');
      }
      return { scope, targetId: actorUserId };
    }
    if (!targetId) throw Errors.invalidInput(`Kill switch scope "${scope}" requires a targetId`);
    const table = scope === 'strategy' ? 'strategies' : 'execution_profiles';
    const res = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM ${table} WHERE id = $1`,
      [targetId],
    );
    const row = res.rows[0];
    if (!row || row.user_id !== actorUserId) {
      // Identical to "does not exist" — no existence leak across tenants.
      throw Errors.notFound(`${scope === 'strategy' ? 'Strategy' : 'Execution profile'} not found`);
    }
    return { scope, targetId };
  }

  private async findRow(scope: KillSwitchScope, targetId: string | null): Promise<KillSwitchRow | null> {
    const res = await this.pool.query<KillSwitchRow>(
      `SELECT * FROM kill_switches
       WHERE scope = $1 AND ($2::uuid IS NULL AND target_id IS NULL OR target_id = $2::uuid)`,
      [scope, targetId],
    );
    return res.rows[0] ?? null;
  }

  /** Resolve the affected owner for the event ledger (fail-open to NULL only for global). */
  private async ownerFor(q: Queryable, scope: KillSwitchScope, targetId: string | null): Promise<string | null> {
    if (scope === 'global') return null;
    if (scope === 'user') return targetId;
    const table = scope === 'strategy' ? 'strategies' : 'execution_profiles';
    const res = await q.query<{ user_id: string }>(
      `SELECT user_id FROM ${table} WHERE id = $1`,
      [targetId],
    );
    return res.rows[0]?.user_id ?? null;
  }

  /**
   * One transaction: read current state → upsert → append the event row.
   * The upsert semantics from M8.1 are preserved exactly (partial unique
   * indexes cannot share one ON CONFLICT clause, hence insert-then-update).
   */
  private async apply(args: SwitchWrite): Promise<{ changed: boolean }> {
    if (args.scope === 'global' && args.targetId) {
      throw new Error('The global kill switch takes no target');
    }
    if (args.scope !== 'global' && !args.targetId) {
      throw new Error(`Kill switch scope "${args.scope}" requires a target id`);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ active: boolean }>(
        `SELECT active FROM kill_switches
          WHERE scope = $1 AND ($2::uuid IS NULL AND target_id IS NULL OR target_id = $2::uuid)
          FOR UPDATE`,
        [args.scope, args.targetId],
      );
      const previous = existing.rows[0];
      const changed = (previous?.active ?? false) !== args.active;

      await client.query(
        `INSERT INTO kill_switches (scope, target_id, active, reason, source, actor_user_id, activated_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 THEN now() ELSE NULL END)
         ON CONFLICT DO NOTHING`,
        [args.scope, args.targetId, args.active, args.reason, args.source, args.actorUserId],
      );
      if (changed) {
        // Only a REAL transition rewrites the state row. `activated_at` stamps
        // the moment the switch newly goes ON; a redundant "arm again" call
        // must not rewrite the stop's provenance (the first reason stands —
        // the attempt itself is on the event ledger instead).
        await client.query(
          `UPDATE kill_switches
              SET active = $3, reason = $4, source = $5, actor_user_id = $6,
                  activated_at = CASE WHEN $3::boolean THEN now() ELSE activated_at END
            WHERE scope = $1 AND ($2::uuid IS NULL AND target_id IS NULL OR target_id = $2::uuid)`,
          [args.scope, args.targetId, args.active, args.reason, args.source, args.actorUserId],
        );
      }

      if (changed || args.alwaysRecord) {
        const ownerUserId = await this.ownerFor(client, args.scope, args.targetId);
        await client.query(
          `INSERT INTO kill_switch_events
             (user_id, actor_user_id, scope, target_id, action, source, reason, changed, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            ownerUserId,
            args.actorUserId,
            args.scope,
            args.targetId,
            args.action,
            args.source,
            args.reason,
            changed,
            JSON.stringify({ safetyVersion: SAFETY_CONTROLS_VERSION }),
          ],
        );
      }
      await client.query('COMMIT');
      return { changed };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* DTO mapping                                                                  */
/* -------------------------------------------------------------------------- */

function rowFromJoin(
  r: Partial<KillSwitchRow>,
): KillSwitchRow | null {
  if (!r.id) return null; // LEFT JOIN miss → synthesize the safe default below
  return r as KillSwitchRow;
}

function entryDto(
  scope: KillSwitchScope,
  targetId: string | null,
  entityLabel: string | null,
  row: KillSwitchRow | null,
  forced = false,
): KillSwitchEntryDto {
  const nowIso = new Date(0).toISOString();
  return {
    scope,
    targetId,
    entityLabel,
    active: forced ? true : (row?.active ?? false),
    source: forced ? 'operator' : (row?.source ?? 'operator'),
    // When the deployment pins the switch, THAT is why it is on — whatever the
    // last operator note on the (possibly stale) row said.
    reason: forced
      ? 'Deployment environment pins the global kill switch ON'
      : (row?.reason ?? null),
    activatedAt: iso(row?.activated_at ?? null),
    // An untouched switch has no update row; surface epoch-0 rather than
    // inventing a timestamp (the UI renders "never" for it).
    updatedAt: row ? row.updated_at.toISOString() : nowIso,
  };
}

interface KillSwitchEventRow {
  id: string | number;
  scope: KillSwitchScope;
  target_id: string | null;
  action: KillSwitchEventAction;
  source: KillSwitchSource;
  reason: string | null;
  changed: boolean;
  created_at: Date;
  strategy_name: string | null;
  profile_provider: string | null;
}

function eventDto(row: KillSwitchEventRow): KillSwitchEventDto {
  const label =
    row.scope === 'strategy'
      ? (row.strategy_name ?? null)
      : row.scope === 'execution_profile'
        ? (row.profile_provider ?? null)
        : row.scope === 'global'
          ? 'platform'
          : null;
  return {
    id: String(row.id),
    scope: row.scope,
    targetId: row.target_id,
    entityLabel: label,
    action: row.action,
    source: row.source,
    reason: row.reason,
    changed: row.changed,
    createdAt: row.created_at.toISOString(),
  };
}
