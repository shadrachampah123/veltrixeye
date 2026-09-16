import type pg from 'pg';
import type { KillSwitchScope } from '@veltrixeye/contracts';

/**
 * M8.1 — emergency kill-switch contract.
 *
 * Four scopes, one row each (upserted, never duplicated):
 *   - `global`            — platform-wide stop (target_id NULL)
 *   - `user`              — per-user stop
 *   - `strategy`          — per-strategy stop
 *   - `execution_profile` — per-profile stop
 *
 * Semantics: a switch row is only meaningful when `active = true`; absence
 * of a row means OFF. ANY active switch covering an execution attempt makes
 * that attempt unacceptable — the gate layer treats kill-switch state as
 * fail-closed (a read error refuses execution rather than allowing it).
 *
 * M8.1 exposes read helpers + a setter used by tests/operators; no UI and no
 * public API mutate switches in this milestone. The default state (no rows)
 * is the safe state for CONTINUING reads — but note: a kill switch being OFF
 * is necessary, never sufficient, for execution.
 */
export class KillSwitchService {
  constructor(private readonly pool: pg.Pool) {}

  async isActive(scope: KillSwitchScope, targetId?: string | null): Promise<boolean> {
    const res = await this.pool.query<{ active: boolean }>(
      `SELECT active FROM kill_switches
       WHERE scope = $1 AND ($2::uuid IS NULL AND target_id IS NULL OR target_id = $2::uuid)`,
      [scope, targetId ?? null],
    );
    return res.rows.some((r) => r.active);
  }

  async isGlobalActive(): Promise<boolean> {
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
   * is active and execution must be refused.
   */
  async anyActive(args: {
    userId: string;
    strategyId?: string | null;
    executionProfileId?: string | null;
  }): Promise<{
    active: boolean;
    global: boolean;
    user: boolean;
    strategy: boolean;
    profile: boolean;
  }> {
    const global = await this.isGlobalActive();
    const user = await this.isUserActive(args.userId);
    const strategy = args.strategyId ? await this.isStrategyActive(args.strategyId) : false;
    const profile = args.executionProfileId
      ? await this.isProfileActive(args.executionProfileId)
      : false;
    return { active: global || user || strategy || profile, global, user, strategy, profile };
  }

  /**
   * Upsert a switch state (operator/future-admin operation). Never deletes:
   * flipping `active` back to false leaves an auditable row with reason.
   */
  async set(
    scope: KillSwitchScope,
    args: { targetId?: string | null; active: boolean; reason?: string | null },
  ): Promise<void> {
    if (scope === 'global' && args.targetId) {
      throw new Error('The global kill switch takes no target');
    }
    if (scope !== 'global' && !args.targetId) {
      throw new Error(`Kill switch scope "${scope}" requires a target id`);
    }
    await this.pool.query(
      `INSERT INTO kill_switches (scope, target_id, active, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [scope, args.targetId ?? null, args.active, args.reason ?? null],
    );
    // The two partial unique indexes cannot be named in a single ON CONFLICT
    // clause for both scopes, so upsert via a guarded update when the insert
    // found an existing row.
    await this.pool.query(
      `UPDATE kill_switches SET active = $3, reason = $4
       WHERE scope = $1 AND ($2::uuid IS NULL AND target_id IS NULL OR target_id = $2::uuid)`,
      [scope, args.targetId ?? null, args.active, args.reason ?? null],
    );
  }
}
