import type pg from 'pg';
import type { AutomationStatusDto, UserPlan } from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import { type Entitlements } from '../billing/entitlements.js';
import { resolveEntitlements } from '../billing/entitlement-resolution.js';
import type { AuditService } from '../audit.js';
import type { KillSwitchService } from './kill-switch.js';

/**
 * M8.1 — explicit automation control.
 *
 * Two independent facts define the automation state, BOTH server-side:
 *  1. `entitlements.canAccessAutomation` — the subscription allows it.
 *     In M8.1 this is false for every plan, and no code path changes that.
 *  2. `users.automation_enabled` — the user's explicit switch (default OFF).
 *
 * The switch can only be flipped through `setAutomationEnabled`, which
 * requires the entitlement FIRST — so while the entitlement is off, no
 * request (crafted cookie, forged body, direct retry) can turn automation
 * on. Database state alone is likewise insufficient: the gates always
 * re-check the entitlement at decision time, never just the flag.
 */
export interface AutomationStatus extends AutomationStatusDto {
  /** The raw entitlement (kept out of the public DTO). */
  entitlements: Entitlements;
}

export class AutomationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly killSwitches: KillSwitchService,
    private readonly audit: AuditService,
  ) {}

  /** Server-authoritative automation state for one user. */
  async getStatus(userId: string): Promise<AutomationStatusDto> {
    const { entitlements, automationEnabled } = await this.readState(userId);
    const globalKillSwitch = await this.killSwitches.isGlobalActive();
    const userKillSwitch = await this.killSwitches.isUserActive(userId);

    const reasons: string[] = [];
    if (!entitlements.canAccessAutomation) reasons.push('entitlement_not_granted');
    if (!automationEnabled) reasons.push('automation_switch_off');
    if (globalKillSwitch) reasons.push('global_kill_switch_active');
    if (globalKillSwitch && this.killSwitches.isGlobalForced()) {
      reasons.push('global_kill_switch_forced_by_environment');
    }
    if (userKillSwitch) reasons.push('user_kill_switch_active');

    return {
      entitled: entitlements.canAccessAutomation,
      automationEnabled,
      globalKillSwitch,
      userKillSwitch,
      effective:
        entitlements.canAccessAutomation &&
        automationEnabled &&
        !globalKillSwitch &&
        !userKillSwitch,
      reasons,
    };
  }

  /**
   * The ONLY mutation path for the automation switch.
   *
   * M8.6 strengthens its safety asymmetry:
   *  - Turning automation ON remains entitlement-gated (in this platform no
   *    plan grants it, so an ON attempt always 403s), AND is additionally
   *    refused (409) while any kill switch is active: emergency stop means
   *    "automation cannot be re-armed", not "automation blocks the stop".
   *  - Turning automation OFF is a safety control, never a feature — it is
   *    always allowed without an entitlement (also for `emergency-stop`, and
   *    for a user de-arming themselves after a breaker trip). The flag can
   *    only go off; gates still re-check entitlement at execution time, so
   *    this path can never arm execution.
   */
  async setAutomationEnabled(
    userId: string,
    enabled: boolean,
    meta?: { ip?: string | null; userAgent?: string | null },
  ): Promise<AutomationStatusDto> {
    const { entitlements } = await this.readState(userId);
    if (enabled) {
      // M8.6 ordering: an armed switch outranks any plan claim. Checking it
      // FIRST means the emergency stop is enforced identically for every
      // account and this path can only ever REFUSE more, never grant.
      const [globalKill, userKill] = await Promise.all([
        this.killSwitches.isGlobalActive(),
        this.killSwitches.isUserActive(userId),
      ]);
      if (globalKill || userKill) {
        throw Errors.conflict(
          'A kill switch is active — it must be cleared (with a reason) before automation can be re-armed',
        );
      }
      if (!entitlements.canAccessAutomation) {
        throw Errors.forbidden(
          'Automation is not available on your subscription plan — the switch cannot be changed',
        );
      }
    }
    await this.pool.query('UPDATE users SET automation_enabled = $2 WHERE id = $1', [
      userId,
      enabled,
    ]);
    await this.audit.log({
      userId,
      action: enabled ? 'execution.automation_enabled' : 'execution.automation_disabled',
      entityType: 'user',
      entityId: userId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      metadata: { enabled },
    });
    return this.getStatus(userId);
  }

  /** Raw state used by the gate layer (entitlement + switch, no kill checks). */
  async readState(userId: string): Promise<{ entitlements: Entitlements; automationEnabled: boolean }> {
    // `sub.provider` is read for the fail-closed entitlement gate: a
    // provider-backed subscription row is an unconfirmed checkout, not a
    // purchase, and resolves to the free tier.
    const res = await this.pool.query<{
      plan: string; status: string; provider: string | null; automation_enabled: boolean;
    }>(
      `SELECT sub.plan, sub.status, sub.provider, u.automation_enabled
       FROM users u
       LEFT JOIN subscriptions sub ON sub.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) throw Errors.notFound('User not found');
    const plan = (row.plan ?? 'free') as UserPlan;
    const status = row.status ?? 'active';
    return {
      entitlements: resolveEntitlements(plan, status, row.provider),
      automationEnabled: row.automation_enabled,
    };
  }
}
