import type pg from 'pg';
import type {
  DrawdownProtectionStatus,
  EmergencyStopResultDto,
  KillSwitchMutationResultDto,
  KillSwitchScope,
  KillSwitchStatusDto,
} from '@veltrixeye/contracts';
import {
  DEFAULT_RISK_POLICY,
  EMERGENCY_STOP_DEFAULT_REASON,
  PLATFORM_RISK_CEILINGS,
} from '@veltrixeye/contracts';
import type { AuditEntry } from '../audit.js';
import type { AuditService } from '../audit.js';
import type { AutomationService } from './automation.js';
import type { KillSwitchService } from './kill-switch.js';

/**
 * M8.6 — safety-controls service: the composition the API layer talks to.
 *
 * It adds ONE durable behavior on top of the kill-switch service — the
 * emergency stop — and merges the automation summary into the safety status
 * so the UI (and any operator tooling) reads a single authoritative picture:
 *
 *   GET status     = kill switches (global/user/strategy/profile)
 *                  + circuit-breaker summary
 *                  + automation { entitled, switch, effective }
 *
 * `emergencyStop` runs three steps IN ORDER inside a single transaction:
 *   1. activate the user kill switch   (blocks entries at gate 6 / paper gate)
 *   2. force the automation switch OFF  (safe direction; needs no entitlement)
 *   3. disable every execution profile  (gate 5 refuses, and provider-side
 *                                         profile state stops claiming ready)
 * The kill switch is armed FIRST because it is the strongest brake: if any
 * later step fails and the whole transaction rolls back, the switch is still
 * armed by the retry — the user's intent ("stop me") can never be partially
 * lost silently. Position exits deliberately stay AVAILABLE throughout:
 * a stop must reduce risk, never strand it.
 *
 * There is no reverse "panic release": clearing is always an explicit,
 * per-scope, reason-carrying call — that asymmetry is the point.
 */
export class SafetyControlsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: {
      killSwitches: KillSwitchService;
      automation: AutomationService;
      audit: AuditService;
    },
  ) {}

  /** Owner-scoped safety status: switches + breaker + automation summary + drawdown protection. */
  async getStatus(userId: string): Promise<KillSwitchStatusDto> {
    const [status, automation] = await Promise.all([
      this.deps.killSwitches.statusFor(userId),
      this.deps.automation.getStatus(userId),
    ]);
    return {
      ...status,
      automation: {
        entitled: automation.entitled,
        automationEnabled: automation.automationEnabled,
        effective: automation.effective,
      },
      drawdownProtection: await this.loadDrawdownProtection(userId),
    };
  }

  /**
   * M8.7 — load drawdown protection state for the safety panel.
   * Uses authoritative internal risk policy + account state.
   * Returns undefined if no risk data exists yet (safe default).
   */
  private async loadDrawdownProtection(userId: string): Promise<DrawdownProtectionStatus | undefined> {
    try {
      // Read the risk policy for drawdown thresholds
      const policyRes = await this.pool.query<{
        daily_drawdown_warning_pct: string;
        daily_drawdown_limit_pct: string;
        weekly_drawdown_warning_pct: string;
        weekly_drawdown_limit_pct: string;
        max_drawdown_warning_pct: string;
        max_drawdown_limit_pct: string;
        paper_equity: string;
      }>(
        `SELECT daily_drawdown_warning_pct, daily_drawdown_limit_pct,
                weekly_drawdown_warning_pct, weekly_drawdown_limit_pct,
                max_drawdown_warning_pct, max_drawdown_limit_pct,
                paper_equity
           FROM risk_policies WHERE user_id = $1`,
        [userId],
      );
      const policyRow = policyRes.rows[0];
      if (!policyRow) return undefined;

      const ddWarn = Number(policyRow.daily_drawdown_warning_pct ?? DEFAULT_RISK_POLICY.dailyDrawdownWarningPct);
      const ddLimit = Number(policyRow.daily_drawdown_limit_pct ?? DEFAULT_RISK_POLICY.dailyDrawdownLimitPct);
      const wdWarn = Number(policyRow.weekly_drawdown_warning_pct ?? DEFAULT_RISK_POLICY.weeklyDrawdownWarningPct);
      const wdLimit = Number(policyRow.weekly_drawdown_limit_pct ?? DEFAULT_RISK_POLICY.weeklyDrawdownLimitPct);
      const mdWarn = Number(policyRow.max_drawdown_warning_pct ?? DEFAULT_RISK_POLICY.maxDrawdownWarningPct);
      const mdLimit = Number(policyRow.max_drawdown_limit_pct ?? DEFAULT_RISK_POLICY.maxDrawdownLimitPct);
      const paperEquity = Number(
        policyRow.paper_equity ?? PLATFORM_RISK_CEILINGS.defaultPaperEquity,
      );

      // Read the account state for current drawdown values (latest across all profiles).
      // Once initialized, paper_equity is policy metadata only and is never
      // used to rewrite the tracked account value.
      const stateRes = await this.pool.query<{
        initial_equity: string;
        peak_equity: string;
        daily_high_value: string;
        weekly_open_value: string;
        cumulative_realized_pl: string;
        equity_initialized: boolean;
      }>(
        `SELECT initial_equity, peak_equity, daily_high_value, weekly_open_value,
                cumulative_realized_pl, equity_initialized
           FROM risk_account_states WHERE user_id = $1
           ORDER BY version DESC LIMIT 1`,
        [userId],
      );
      const stateRow = stateRes.rows[0];
      if (!stateRow || !stateRow.equity_initialized) {
        // No tracked state yet — policy-only display, never a risk input.
        return {
          currentAccountValue: paperEquity,
          peakEquity: paperEquity,
          currentDrawdownPct: 0,
          maxDrawdownWarningPct: mdWarn,
          maxDrawdownLimitPct: mdLimit,
          maxDrawdownWarningActive: false,
          maxDrawdownLimitActive: false,
          dailyDrawdownPct: 0,
          dailyDrawdownWarningPct: ddWarn,
          dailyDrawdownLimitPct: ddLimit,
          dailyDrawdownWarningActive: false,
          dailyDrawdownLimitActive: false,
          weeklyDrawdownPct: 0,
          weeklyDrawdownWarningPct: wdWarn,
          weeklyDrawdownLimitPct: wdLimit,
          weeklyDrawdownWarningActive: false,
          weeklyDrawdownLimitActive: false,
          anyHardStopActive: false,
          dataAvailable: false,
        };
      }

      const initialEquity = Number(stateRow.initial_equity);
      const currentAccountValue = initialEquity + Number(stateRow.cumulative_realized_pl ?? 0);
      const peakEquity = Number(stateRow.peak_equity);
      const dailyHigh = Number(stateRow.daily_high_value);
      const weeklyOpen = Number(stateRow.weekly_open_value);
      if (
        ![initialEquity, currentAccountValue, peakEquity, dailyHigh, weeklyOpen].every(Number.isFinite)
        || initialEquity <= 0
        || currentAccountValue > peakEquity
        || dailyHigh < currentAccountValue
        || dailyHigh > peakEquity
        || weeklyOpen > peakEquity
      ) {
        return undefined;
      }
      const pctOf = (base: number) => base > 0 ? Math.max(0, ((base - currentAccountValue) / base) * 100) : 0;

      const currentDd = pctOf(peakEquity);
      const dailyDd = pctOf(dailyHigh);
      const weeklyDd = pctOf(weeklyOpen);

      return {
        currentAccountValue,
        peakEquity,
        currentDrawdownPct: currentDd,
        maxDrawdownWarningPct: mdWarn,
        maxDrawdownLimitPct: mdLimit,
        maxDrawdownWarningActive: currentDd >= mdWarn,
        maxDrawdownLimitActive: currentDd >= mdLimit,
        dailyDrawdownPct: dailyDd,
        dailyDrawdownWarningPct: ddWarn,
        dailyDrawdownLimitPct: ddLimit,
        dailyDrawdownWarningActive: dailyDd >= ddWarn,
        dailyDrawdownLimitActive: dailyDd >= ddLimit,
        weeklyDrawdownPct: weeklyDd,
        weeklyDrawdownWarningPct: wdWarn,
        weeklyDrawdownLimitPct: wdLimit,
        weeklyDrawdownWarningActive: weeklyDd >= wdWarn,
        weeklyDrawdownLimitActive: weeklyDd >= wdLimit,
        anyHardStopActive: currentDd >= mdLimit || dailyDd >= ddLimit || weeklyDd >= wdLimit,
        dataAvailable: true,
      };
    } catch {
      // Fail-closed: if we can't read drawdown state, don't block the status
      // but indicate data is unavailable.
      return undefined;
    }
  }

  /** Activate a switch (scope must be user/strategy/execution_profile). */
  async activate(
    actorUserId: string,
    input: { scope: KillSwitchScope; targetId?: string | null; reason: string },
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>,
  ): Promise<KillSwitchMutationResultDto> {
    const { changed } = await this.deps.killSwitches.activate(actorUserId, input);
    await this.deps.audit.log({
      userId: actorUserId,
      action: 'safety.kill_switch_activated',
      entityType: 'kill_switch',
      entityId: input.targetId ?? actorUserId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      metadata: { scope: input.scope, changed },
    });
    return { action: 'activated', changed, status: await this.getStatus(actorUserId) };
  }

  /** Clear a switch the actor owns. Always audited with the clear reason. */
  async clear(
    actorUserId: string,
    input: { scope: KillSwitchScope; targetId?: string | null; reason: string },
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>,
  ): Promise<KillSwitchMutationResultDto> {
    const { changed } = await this.deps.killSwitches.clear(actorUserId, input);
    await this.deps.audit.log({
      userId: actorUserId,
      action: 'safety.kill_switch_cleared',
      entityType: 'kill_switch',
      entityId: input.targetId ?? actorUserId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      metadata: { scope: input.scope, changed },
    });
    return { action: 'cleared', changed, status: await this.getStatus(actorUserId) };
  }

  /**
   * The account panic button. One call, one transaction, three brakes — and
   * the transaction-level writes below are the ATOMIC part (steps 2–3 are
   * plain statements; step 1 reuses the kill-switch ledger writes). On commit
   * we still record the platform audit row best-effort (an audit failure must
   * never roll the stop back).
   */
  async emergencyStop(
    userId: string,
    reason: string = EMERGENCY_STOP_DEFAULT_REASON,
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>,
  ): Promise<EmergencyStopResultDto> {
    const client = await this.pool.connect();
    let automationWasEnabled = false;
    let profilesDisabled = 0;
    let killSwitchChanged = false;
    try {
      await client.query('BEGIN');

      // Lock the account's switch row region first: a concurrent emergency
      // stop (double-click, replayed fetch) serializes behind us and sees the
      // armed switch (changed=false), not a second activation event.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('safety:emergency-stop'), hashtext($1))`,
        [userId],
      );

      // 1. Arm the user kill switch (durable entry-block).
      const current = await client.query<{ active: boolean }>(
        `SELECT active FROM kill_switches WHERE scope = 'user' AND target_id = $1 FOR UPDATE`,
        [userId],
      );
      const previous = current.rows[0];
      killSwitchChanged = (previous?.active ?? false) !== true;
      await client.query(
        `INSERT INTO kill_switches (scope, target_id, active, reason, source, actor_user_id, activated_at)
         VALUES ('user', $1, true, $2, 'user', $1, now())
         ON CONFLICT DO NOTHING`,
        [userId, reason],
      );
      if (killSwitchChanged) {
        await client.query(
          `UPDATE kill_switches
              SET active = true, reason = $2, source = 'user', actor_user_id = $1,
                  activated_at = now()
            WHERE scope = 'user' AND target_id = $1`,
          [userId, reason],
        );
      }
      await client.query(
        `INSERT INTO kill_switch_events
           (user_id, actor_user_id, scope, target_id, action, source, reason, changed, metadata)
         VALUES ($1, $1, 'user', $1, 'activated', 'user', $2, $3,
                 jsonb_build_object('path', 'emergency_stop'))`,
        [userId, reason, killSwitchChanged],
      );

      // 2. Force the automation switch OFF (safe direction — no entitlement
      //    is ever required to stop).
      const users = await client.query<{ automation_enabled: boolean }>(
        `SELECT automation_enabled FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      automationWasEnabled = users.rows[0]?.automation_enabled === true;
      if (automationWasEnabled) {
        await client.query(`UPDATE users SET automation_enabled = false WHERE id = $1`, [userId]);
      }

      // 3. Disable every execution profile (gate 5 refuses; paper profiles
      //    included — the user said STOP, not STOP-sometimes).
      const profiles = await client.query(
        `UPDATE execution_profiles SET enabled = false
          WHERE user_id = $1 AND enabled = true
          RETURNING id`,
        [userId],
      );
      profilesDisabled = profiles.rowCount ?? 0;

      // Mirror into the execution audit trail (same vocabulary as M8.1:
      // the trail already lists profile/automation lifecycle events).
      await client.query(
        `INSERT INTO execution_events (user_id, event, reason, metadata)
         VALUES ($1, 'emergency_stop', $2, $3::jsonb)`,
        [userId, reason, JSON.stringify({ automationWasEnabled, profilesDisabled })],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await this.deps.audit.log({
      userId,
      action: 'safety.emergency_stop',
      entityType: 'user',
      entityId: userId,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      metadata: {
        killSwitchChanged,
        automationWasEnabled,
        profilesDisabled,
      },
    });

    return {
      stopped: true,
      killSwitchActivated: killSwitchChanged,
      automationWasEnabled,
      automationDisabled: automationWasEnabled,
      profilesDisabled,
      status: await this.getStatus(userId),
    };
  }

  /** Owner-scoped append-only switch history. */
  async history(userId: string, limit: number) {
    return this.deps.killSwitches.historyForUser(userId, limit);
  }
}
