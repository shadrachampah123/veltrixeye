import type pg from 'pg';
import {
  DEFAULT_RISK_POLICY,
  PLATFORM_RISK_CEILINGS,
  RISK_ENGINE_VERSION,
  RISK_RESERVATION_TTL_MS,
  isCircuitBreakerCode,
  platformCeilingsDto,
  riskSessionWindowSchema,
  type ExecutionDecisionInput,
  type InstrumentRiskSpec,
  type RiskAccountSnapshotDto,
  type RiskDecisionDto,
  type RiskExposureSnapshot,
  type RiskPolicyDto,
  type RiskPolicyStatusDto,
  type RiskPolicyUpdateInput,
  type RiskRejectionCode,
  type RiskSessionWindow,
} from '@veltrixeye/contracts';
import { Dec, DEC_ZERO, type Dec as DecT } from './decimal.js';
import { Errors } from '../errors.js';
import type { AuditService } from '../audit.js';
import type { KillSwitchService } from '../execution/kill-switch.js';
import { evaluateRisk, type RiskEngineVerdict } from './engine.js';
import { applyPlatformCeilings, defaultEffectivePolicy, type StrategyRiskOverride } from './policy.js';

/** Pool or a transaction client. */
export type RiskQueryable = Pick<pg.Pool, 'query'>;

export interface RiskLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const SILENT: RiskLogger = { info: () => {}, warn: () => {} };

/** Drawdown state older than this is not authoritative for a new entry. */
const RISK_ACCOUNT_STATE_STALE_MS = 24 * 60 * 60 * 1000;

/** numeric(18,4) baseline, rounded toward zero so initialization never grants an uplift. */
function conservativeStoredEquity(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value * 10_000) / 10_000 : value;
}

export interface RiskEvaluateArgs {
  userId: string;
  executionProfileId: string;
  decision: ExecutionDecisionInput;
  spreadPips?: number | null;
  slippagePips?: number | null;
  /**
   * Injected clock (epoch ms). Defaults to Date.now.
   * Drives session windows, loss-window rolls, reservation TTL, and the
   * engine's `evaluatedAtMs`.
   */
  nowMs?: number;
  /** When true, an approval inserts a reservation (intake holds it until gates settle). */
  reserveOnApprove?: boolean;
}

export interface PersistedRiskDecision extends RiskDecisionDto {
  exposureWithinLimits: boolean;
  effectiveMinRr: number;
  violations: RiskRejectionCode[];
}

/**
 * M8.2 — risk engine service.
 *
 * Loads authoritative server-side state, runs the pure engine, persists the
 * verdict, and (optionally) reserves approved exposure so concurrent twins
 * cannot both pass on stale counts. Client-supplied P&L / open-position /
 * loss-counter fields are ignored — they are not even accepted as arguments.
 */
export class RiskEngineService {
  private readonly logger: RiskLogger;
  private approvals = 0;
  private rejections = 0;
  private readonly rejectionCounts = new Map<string, number>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: {
      killSwitches: KillSwitchService;
      audit: AuditService;
    },
    options?: { logger?: RiskLogger },
  ) {
    this.logger = options?.logger ?? SILENT;
  }

  /** In-process counters (process-local; never include secrets). */
  metrics(): { approvals: number; rejections: number; byCode: Record<string, number> } {
    return {
      approvals: this.approvals,
      rejections: this.rejections,
      byCode: Object.fromEntries(this.rejectionCounts),
    };
  }

  async getPolicyStatus(userId: string, executionProfileId?: string | null): Promise<RiskPolicyStatusDto> {
    const policy = await this.ensurePolicy(userId);
    const account = await this.loadAccountSnapshot(userId, executionProfileId ?? null, policy.paperEquity);
    return {
      policy,
      platformCeilings: platformCeilingsDto(),
      account,
      engineVersion: RISK_ENGINE_VERSION,
    };
  }

  async updatePolicy(
    userId: string,
    input: RiskPolicyUpdateInput,
    meta?: { ip?: string | null; userAgent?: string | null },
  ): Promise<RiskPolicyStatusDto> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Policy edits and first-time account initialization share a user-wide
      // lock. In particular, paperEquity cannot race state creation.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'risk-policy',
        userId,
      ]);
      await this.ensurePolicyRow(userId, client);

      if (input.paperEquity !== undefined) {
        const tracked = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM risk_account_states WHERE user_id = $1`,
          [userId],
        );
        if (Number(tracked.rows[0]?.n ?? 0) > 0) {
          throw Errors.invalidInput('paperEquity is immutable after risk tracking begins');
        }
      }
      const assignments: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown) => {
        values.push(value);
        assignments.push(`${column} = $${values.length}`);
      };

      if (input.enabled !== undefined) push('enabled', input.enabled);
      if (input.riskPctPerTrade !== undefined) push('risk_pct_per_trade', input.riskPctPerTrade);
      if (input.maxMonetaryRiskPerTrade !== undefined) push('max_monetary_risk_per_trade', input.maxMonetaryRiskPerTrade);
      if (input.maxDailyLossPct !== undefined) push('max_daily_loss_pct', input.maxDailyLossPct);
      if (input.maxWeeklyLossPct !== undefined) push('max_weekly_loss_pct', input.maxWeeklyLossPct);
      if (input.maxConsecutiveLosses !== undefined) push('max_consecutive_losses', input.maxConsecutiveLosses);
      if (input.maxSimultaneousPositions !== undefined) push('max_simultaneous_positions', input.maxSimultaneousPositions);
      if (input.maxTotalOpenRiskPct !== undefined) push('max_total_open_risk_pct', input.maxTotalOpenRiskPct);
      if (input.maxExposurePerInstrumentPct !== undefined) push('max_exposure_per_instrument_pct', input.maxExposurePerInstrumentPct);
      if (input.maxExposurePerDirectionPct !== undefined) push('max_exposure_per_direction_pct', input.maxExposurePerDirectionPct);
      if (input.minRr !== undefined) push('min_rr', input.minRr);
      if (input.maxSpreadPips !== undefined) push('max_spread_pips', input.maxSpreadPips);
      if (input.maxSlippagePips !== undefined) push('max_slippage_pips', input.maxSlippagePips);
      if (input.allowedSessions !== undefined) {
        push('allowed_sessions', input.allowedSessions === null ? null : JSON.stringify(input.allowedSessions));
      }
      if (input.correlationRequired !== undefined) push('correlation_required', input.correlationRequired);
      if (input.maxCorrelationGroupExposurePct !== undefined) push('max_correlation_group_exposure_pct', input.maxCorrelationGroupExposurePct);
      if (input.paperEquity !== undefined) push('paper_equity', input.paperEquity);
      /* M8.7 — drawdown thresholds */
      if (input.dailyDrawdownWarningPct !== undefined) push('daily_drawdown_warning_pct', input.dailyDrawdownWarningPct);
      if (input.dailyDrawdownLimitPct !== undefined) push('daily_drawdown_limit_pct', input.dailyDrawdownLimitPct);
      if (input.weeklyDrawdownWarningPct !== undefined) push('weekly_drawdown_warning_pct', input.weeklyDrawdownWarningPct);
      if (input.weeklyDrawdownLimitPct !== undefined) push('weekly_drawdown_limit_pct', input.weeklyDrawdownLimitPct);
      if (input.maxDrawdownWarningPct !== undefined) push('max_drawdown_warning_pct', input.maxDrawdownWarningPct);
      if (input.maxDrawdownLimitPct !== undefined) push('max_drawdown_limit_pct', input.maxDrawdownLimitPct);

      if (assignments.length > 0) {
        values.push(userId);
        assignments.push('policy_version = policy_version + 1');
        try {
          await client.query(
            `UPDATE risk_policies SET ${assignments.join(', ')} WHERE user_id = $${values.length}`,
            values,
          );
        } catch (err) {
          if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23514') {
            throw Errors.invalidInput('Risk setting exceeds the platform safety ceiling');
          }
          throw err;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (Object.keys(input).length > 0) {
      await this.deps.audit.log({
        userId,
        action: 'risk.policy_updated',
        entityType: 'risk_policy',
        entityId: userId,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        metadata: { fields: Object.keys(input) },
      });
    }
    return this.getPolicyStatus(userId);
  }

  async listDecisions(userId: string, limit: number): Promise<{ decisions: RiskDecisionDto[] }> {
    const res = await this.pool.query<DecisionRow>(
      `SELECT * FROM risk_decisions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return { decisions: res.rows.map(toDecisionDto) };
  }

  /**
   * Evaluate a candidate execution decision against the server-side policy.
   *
   * Runs under a transaction + advisory lock keyed on (user, profile) so two
   * concurrent calls cannot both approve based on stale exposure.
   */
  async evaluate(args: RiskEvaluateArgs): Promise<PersistedRiskDecision> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'risk-policy',
        args.userId,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `risk:${args.userId}`,
        args.executionProfileId,
      ]);

      const nowMs = args.nowMs ?? Date.now();
      const policyRow = await this.ensurePolicyRow(args.userId, client);
      const policy = policyFromRow(policyRow);

      const kill = await this.deps.killSwitches.anyActive({
        userId: args.userId,
        strategyId: args.decision.strategyId,
        executionProfileId: args.executionProfileId,
      });

      const account = await this.loadOrCreateAccountState(args.userId, args.executionProfileId, nowMs, client, Number(policyRow.paper_equity));
      const openPositions = await this.loadOpenPositions(args.userId, args.executionProfileId, client);
      await this.reclaimExpiredReservations(args.executionProfileId, nowMs, client);
      const reservations = await this.loadReservations(args.executionProfileId, nowMs, client);
      const spec = await this.loadInstrumentSpec(args.decision.assetClass, args.decision.symbol, client);
      const { groups, candidateGroupIds } = await this.loadCorrelation(
        args.decision.assetClass,
        args.decision.symbol,
        client,
      );
      const override = await this.loadStrategyOverride(args.userId, args.decision.strategyId, client);
      const strategyMinRr = await this.loadStrategyMinRr(args.decision.strategyVersionId, client);

      /* M8.7 — drawdown uses the immutable per-profile baseline, never the
       * mutable policy paper-equity setting after tracking begins. */
      const policyEquity = Dec.fromUnknown(policyRow.paper_equity);
      const trackedEquity = account.equity_initialized
        ? Dec.fromUnknown(account.initial_equity)
        : null;
      const equity = trackedEquity?.isPositive
        ? trackedEquity
        : (policyEquity ?? Dec.fromInt(PLATFORM_RISK_CEILINGS.defaultPaperEquity));
      const drawdown = await this.loadDrawdownInput(
        args.userId,
        args.executionProfileId,
        account,
        equity,
        nowMs,
        client,
      );

      const verdict = evaluateRisk({
        policy: applyPlatformCeilings({
          enabled: policy.enabled,
          policyVersion: policy.policyVersion,
          riskPctPerTrade: policy.riskPctPerTrade,
          maxMonetaryRiskPerTrade: policy.maxMonetaryRiskPerTrade,
          maxDailyLossPct: policy.maxDailyLossPct,
          maxWeeklyLossPct: policy.maxWeeklyLossPct,
          maxConsecutiveLosses: policy.maxConsecutiveLosses,
          maxSimultaneousPositions: policy.maxSimultaneousPositions,
          maxTotalOpenRiskPct: policy.maxTotalOpenRiskPct,
          maxExposurePerInstrumentPct: policy.maxExposurePerInstrumentPct,
          maxExposurePerDirectionPct: policy.maxExposurePerDirectionPct,
          minRr: policy.minRr,
          maxSpreadPips: policy.maxSpreadPips,
          maxSlippagePips: policy.maxSlippagePips,
          allowedSessions: policy.allowedSessions,
          correlationRequired: policy.correlationRequired,
          maxCorrelationGroupExposurePct: policy.maxCorrelationGroupExposurePct,
          paperEquity: equity.toNumber(4),
        }),
        strategyOverride: override,
        strategyMinRr,
        account: {
          equity,
          dailyRealizedPl: Dec.fromUnknown(account.daily_realized_pl) ?? DEC_ZERO,
          weeklyRealizedPl: Dec.fromUnknown(account.weekly_realized_pl) ?? DEC_ZERO,
          consecutiveLosses: account.consecutive_losses,
        },
        openPositions,
        reservations,
        instrument: spec,
        correlationGroups: groups,
        candidateGroupIds,
        killSwitchActive: kill.active,
        killSwitchReason: kill.active ? 'kill switch active' : null,
        candidate: {
          action: args.decision.action,
          symbol: args.decision.symbol,
          assetClass: args.decision.assetClass,
          direction: args.decision.direction,
          entryPrice: args.decision.entryPrice,
          stopLossPrice: args.decision.stopLossPrice,
          takeProfitPrice: args.decision.takeProfitPrice,
          expectedRr: args.decision.expectedRr,
          asOfMs: args.decision.asOfMs,
          spreadPips: args.spreadPips ?? null,
          slippagePips: args.slippagePips ?? null,
        },
        evaluatedAtMs: nowMs,
        /* M8.7 — invalid/stale/contradictory data becomes unavailable. */
        drawdown,
      });

      const persisted = await this.persistDecision(client, args, verdict, nowMs);
      if (verdict.outcome === 'approved' && args.reserveOnApprove !== false && args.decision.action !== 'close_position') {
        await client.query(
          `INSERT INTO risk_reservations
             (user_id, execution_profile_id, risk_decision_id, symbol, direction, monetary_risk, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
          [
            args.userId,
            args.executionProfileId,
            persisted.id,
            args.decision.symbol,
            args.decision.direction,
            verdict.monetaryRisk ? verdict.monetaryRisk.toFixed(10) : '0',
            nowMs + RISK_RESERVATION_TTL_MS,
          ],
        );
      }

      await client.query('COMMIT');
      // M8.6 — automatic circuit breaker. A loss-limit rejection is more than
      // "not this trade": it DURABLY trips the user's kill switch (until an
      // explicit, audited clear). The trip runs OUTSIDE the decision
      // transaction so a ledger hiccup can never corrupt or block the
      // persisted verdict; and because rejections repeat while the breach
      // holds, an idempotent trip is guaranteed to land on the next decision
      // (eventual, never silent). It can never GRANT anything — worst case is
      // one extra refused decision.
      if (
        verdict.outcome === 'rejected'
        && policy.circuitBreakerEnabled
        && verdict.violations.some((v) => isCircuitBreakerCode(v))
      ) {
        const code = verdict.violations.find((v) => isCircuitBreakerCode(v)) ?? 'LOSS_LIMIT';
        try {
          const trip = await this.deps.killSwitches.tripCircuitBreaker(
            args.userId,
            `Risk circuit breaker: ${code} limit reached — trading is stopped until this switch is cleared`,
          );
          if (trip.changed) {
            this.logger.warn('risk circuit breaker tripped', {
              userId: args.userId,
              code,
              decisionId: persisted.id,
              engineVersion: RISK_ENGINE_VERSION,
            });
            await this.deps.audit.log({
              userId: args.userId,
              action: 'safety.circuit_breaker_tripped',
              entityType: 'kill_switch',
              entityId: args.userId,
              metadata: { code, riskDecisionId: persisted.id, scope: 'user' },
            });
          }
        } catch (err) {
          // Fail-CLOSED bias: a failed trip never crashes the risk call, and
          // the rejection itself already refused the trade. Loud + auditable.
          this.logger.warn('risk circuit breaker trip failed', {
            userId: args.userId,
            code,
            error: (err as Error)?.message ?? 'unknown',
          });
        }
      }
      this.recordMetrics(verdict);
      this.logger.info(verdict.outcome === 'approved' ? 'risk approved' : 'risk rejected', {
        decisionId: persisted.id,
        outcome: verdict.outcome,
        code: verdict.rejectionCode,
        policyVersion: verdict.policyVersion,
        engineVersion: RISK_ENGINE_VERSION,
        setupId: args.decision.setupId,
      });
      await this.deps.audit.log({
        userId: args.userId,
        action: verdict.outcome === 'approved' ? 'risk.approved' : 'risk.rejected',
        entityType: 'risk_decision',
        entityId: persisted.id,
        metadata: {
          setupId: args.decision.setupId,
          strategyId: args.decision.strategyId,
          executionProfileId: args.executionProfileId,
          outcome: verdict.outcome,
          rejectionCode: verdict.rejectionCode,
          policyVersion: verdict.policyVersion,
          engineVersion: RISK_ENGINE_VERSION,
          violations: verdict.violations,
        },
      });
      return persisted;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Drop the in-flight reservation for an approved decision that will not execute. */
  async releaseReservation(decisionId: string): Promise<void> {
    await this.pool.query('DELETE FROM risk_reservations WHERE risk_decision_id = $1', [decisionId]);
  }

  /**
   * B1 (H4) — read the live reservation backing an approved decision.
   *
   * Read-only: used by the execution composition's final safety fence (the
   * reservation must still be live at submit time) and by the Gate 9 risk
   * handoff (the durable intent takes over the exact decimal exposure).
   * Returns null when no unexpired reservation exists for this decision and
   * profile. This creates no second risk authority — it reads the existing
   * `risk_reservations` rows that `evaluate` wrote.
   */
  async getActiveReservation(args: {
    riskDecisionId: string;
    executionProfileId: string;
    nowMs?: number;
  }): Promise<{ id: string; monetaryRisk: string; expiresAt: Date } | null> {
    const nowMs = args.nowMs ?? Date.now();
    const res = await this.pool.query<{ id: string; monetary_risk: string; expires_at: Date }>(
      `SELECT id, monetary_risk::text AS monetary_risk, expires_at
         FROM risk_reservations
        WHERE risk_decision_id = $1
          AND execution_profile_id = $2
          AND expires_at > to_timestamp($3 / 1000.0)`,
      [args.riskDecisionId, args.executionProfileId, nowMs],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, monetaryRisk: row.monetary_risk, expiresAt: row.expires_at };
  }

  /**
   * Internal (tests / future executor): record a realized P&L against the
   * server-owned account snapshot. Not exposed over HTTP.
   *
   * The public wrapper owns its transaction. Paper execution uses the
   * transaction-scoped variant below so closing the position and updating the
   * risk ledger commit or roll back together.
   */
  async recordRealizedPl(args: {
    userId: string;
    executionProfileId: string;
    realizedPl: number;
    nowMs?: number;
    /** @deprecated retained for internal callers; never used as equity. */
    paperEquity?: number;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'risk-policy',
        args.userId,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `risk:${args.userId}`,
        args.executionProfileId,
      ]);
      await this.recordRealizedPlInTransaction(client, args);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Record P&L inside a caller-owned transaction. The caller MUST already
   * hold the same `risk:(user, profile)` advisory transaction lock used by
   * evaluate(). This is the atomic paper-close path.
   */
  async recordRealizedPlInTransaction(
    q: RiskQueryable,
    args: { userId: string; executionProfileId: string; realizedPl: number; nowMs?: number },
  ): Promise<void> {
    if (!Number.isFinite(args.realizedPl)) {
      throw Errors.invalidInput('Realized P&L must be finite');
    }
    const nowMs = args.nowMs ?? Date.now();
    const policy = await q.query<{ paper_equity: string }>(
      'SELECT paper_equity FROM risk_policies WHERE user_id = $1',
      [args.userId],
    );
    const policyEquity = Number(policy.rows[0]?.paper_equity);
    const pe = Number.isFinite(policyEquity)
      ? policyEquity
      : PLATFORM_RISK_CEILINGS.defaultPaperEquity;
    const state = await this.loadOrCreateAccountState(
      args.userId,
      args.executionProfileId,
      nowMs,
      q,
      pe,
    );
    const initialEquity = Number(state.initial_equity);
    const previousCumulative = Number(state.cumulative_realized_pl);
    const previousDaily = Number(state.daily_realized_pl);
    const previousWeekly = Number(state.weekly_realized_pl);
    if (![initialEquity, previousCumulative, previousDaily, previousWeekly].every(Number.isFinite)) {
      throw Errors.internal('Risk account state contains invalid numeric data');
    }

    const pl = args.realizedPl;
    const nextDaily = previousDaily + pl;
    const nextWeekly = previousWeekly + pl;
    const nextStreak = pl < 0 ? state.consecutive_losses + 1 : 0;
    const previousCumulativeDec = Dec.fromNumber(previousCumulative);
    const realizedPlDec = Dec.fromNumber(pl);
    if (!previousCumulativeDec || !realizedPlDec) {
      throw Errors.internal('Risk account P&L cannot be represented safely');
    }
    // cumulative_realized_pl is numeric(18,4); quantize before calculating
    // peaks and percentages so the stored ledger and derived state agree.
    const rawNextCumulative = previousCumulativeDec.add(realizedPlDec).toNumber(10);
    const nextCumulative = Math.sign(rawNextCumulative)
      * Math.round(Math.abs(rawNextCumulative) * 10_000)
      / 10_000;
    const previousAccountValue = initialEquity + previousCumulative;
    const currentAccountValue = initialEquity + nextCumulative;
    const prevPeak = Number(state.peak_equity);
    const prevDailyHigh = Number(state.daily_high_value);
    const weeklyOpen = Number(state.weekly_open_value);
    if (
      !(initialEquity > 0)
      || ![prevPeak, prevDailyHigh, weeklyOpen].every(Number.isFinite)
      || prevPeak < previousAccountValue
      || prevDailyHigh < previousAccountValue
      || prevDailyHigh > prevPeak
      || weeklyOpen > prevPeak
    ) {
      throw Errors.internal('Risk drawdown state contains invalid or contradictory data');
    }

    const newPeak = Math.max(prevPeak, currentAccountValue);
    const newDailyHigh = Math.max(prevDailyHigh, currentAccountValue);
    const peakDdPct = newPeak > 0 ? Math.max(0, ((newPeak - currentAccountValue) / newPeak) * 100) : 0;
    const dailyDdPct = newDailyHigh > 0 ? Math.max(0, ((newDailyHigh - currentAccountValue) / newDailyHigh) * 100) : 0;
    const weeklyDdPct = weeklyOpen > 0 ? Math.max(0, ((weeklyOpen - currentAccountValue) / weeklyOpen) * 100) : 0;

    const updated = await q.query(
      `UPDATE risk_account_states
          SET daily_realized_pl = $2, weekly_realized_pl = $3, consecutive_losses = $4,
              cumulative_realized_pl = $5,
              peak_equity = $6, daily_high_value = $7,
              current_drawdown_pct = $8, daily_drawdown_pct = $9, weekly_drawdown_pct = $10,
              equity_initialized = true,
              version = version + 1
        WHERE id = $1`,
      [
        state.id, nextDaily, nextWeekly, nextStreak,
        nextCumulative,
        newPeak, newDailyHigh,
        peakDdPct, dailyDdPct, weeklyDdPct,
      ],
    );
    if (updated.rowCount !== 1) {
      throw Errors.internal('Risk account state was not updated atomically');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* internals                                                              */
  /* ---------------------------------------------------------------------- */

  private recordMetrics(verdict: RiskEngineVerdict): void {
    if (verdict.outcome === 'approved') {
      this.approvals += 1;
    } else {
      this.rejections += 1;
      const code = verdict.rejectionCode ?? 'unknown';
      this.rejectionCounts.set(code, (this.rejectionCounts.get(code) ?? 0) + 1);
    }
  }

  private async ensurePolicy(userId: string): Promise<RiskPolicyDto> {
    const row = await this.ensurePolicyRow(userId, this.pool);
    return policyFromRow(row);
  }

  private async ensurePolicyRow(userId: string, q: RiskQueryable): Promise<PolicyRow> {
    const existing = await q.query<PolicyRow>('SELECT * FROM risk_policies WHERE user_id = $1', [userId]);
    if (existing.rows[0]) return existing.rows[0];
    const d = DEFAULT_RISK_POLICY;
    const inserted = await q.query<PolicyRow>(
      `INSERT INTO risk_policies (
         user_id, enabled, risk_pct_per_trade, max_monetary_risk_per_trade,
         max_daily_loss_pct, max_weekly_loss_pct, max_consecutive_losses,
         max_simultaneous_positions, max_total_open_risk_pct,
         max_exposure_per_instrument_pct, max_exposure_per_direction_pct,
         min_rr, max_spread_pips, max_slippage_pips, allowed_sessions,
         correlation_required, max_correlation_group_exposure_pct, paper_equity
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *`,
      [
        userId,
        d.enabled,
        d.riskPctPerTrade,
        d.maxMonetaryRiskPerTrade,
        d.maxDailyLossPct,
        d.maxWeeklyLossPct,
        d.maxConsecutiveLosses,
        d.maxSimultaneousPositions,
        d.maxTotalOpenRiskPct,
        d.maxExposurePerInstrumentPct,
        d.maxExposurePerDirectionPct,
        d.minRr,
        d.maxSpreadPips,
        d.maxSlippagePips,
        null,
        d.correlationRequired,
        d.maxCorrelationGroupExposurePct,
        PLATFORM_RISK_CEILINGS.defaultPaperEquity,
      ],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const again = await q.query<PolicyRow>('SELECT * FROM risk_policies WHERE user_id = $1', [userId]);
    const row = again.rows[0];
    if (!row) throw Errors.internal('Failed to initialize risk policy');
    return row;
  }

  private async loadOrCreateAccountState(
    userId: string,
    executionProfileId: string,
    nowMs: number,
    q: RiskQueryable,
    /** When provided, used to initialize drawdown baselines for a new state. */
    paperEquity?: number,
  ): Promise<AccountRow> {
    const utc = utcDateParts(nowMs);
    const existing = await q.query<AccountRow>(
      `SELECT * FROM risk_account_states WHERE execution_profile_id = $1 FOR UPDATE`,
      [executionProfileId],
    );
    let row = existing.rows[0];
    if (!row) {
      const equityInit = conservativeStoredEquity(
        paperEquity ?? PLATFORM_RISK_CEILINGS.defaultPaperEquity,
      );
      const inserted = await q.query<AccountRow>(
        `INSERT INTO risk_account_states
           (user_id, execution_profile_id, daily_window_start, weekly_window_start,
            initial_equity, peak_equity, daily_high_value, weekly_open_value, equity_initialized)
         VALUES ($1, $2, $3::date, $4::date, $5, $5, $5, $5, true)
         ON CONFLICT (execution_profile_id) DO NOTHING
         RETURNING *`,
        [userId, executionProfileId, utc.day, utc.weekStart, equityInit],
      );
      row = inserted.rows[0];
      if (!row) {
        const again = await q.query<AccountRow>(
          `SELECT * FROM risk_account_states WHERE execution_profile_id = $1 FOR UPDATE`,
          [executionProfileId],
        );
        row = again.rows[0];
      }
    }
    if (!row) throw Errors.internal('Failed to initialize risk account state');

    // Rows created by M8.1-M8.6 have no trustworthy drawdown baseline. Use
    // only the policy value and already-recorded losses; never grant an
    // uplift. Invalid inputs remain uninitialized and fail closed.
    if (!row.equity_initialized) {
      const baseline = conservativeStoredEquity(
        paperEquity ?? PLATFORM_RISK_CEILINGS.defaultPaperEquity,
      );
      const priorCumulative = Number(row.cumulative_realized_pl ?? 0);
      const priorDaily = Number(row.daily_realized_pl ?? 0);
      const priorWeekly = Number(row.weekly_realized_pl ?? 0);
      if (
        Number.isFinite(baseline) && baseline > 0
        && Number.isFinite(priorCumulative)
        && Number.isFinite(priorDaily)
        && Number.isFinite(priorWeekly)
      ) {
        const conservativeLoss = Math.min(0, priorCumulative, priorDaily, priorWeekly);
        const current = baseline + conservativeLoss;
        const initialized = await q.query<AccountRow>(
          `UPDATE risk_account_states
              SET initial_equity = $2,
                  peak_equity = $2,
                  daily_high_value = $3,
                  weekly_open_value = $3,
                  current_drawdown_pct = $4,
                  daily_drawdown_pct = $4,
                  weekly_drawdown_pct = $4,
                  equity_initialized = true,
                  version = version + 1
            WHERE id = $1
            RETURNING *`,
          [
            row.id,
            baseline,
            baseline,
            baseline > 0 ? Math.max(0, ((baseline - current) / baseline) * 100) : 0,
          ],
        );
        row = initialized.rows[0] ?? row;
      }
    }

    const dailyStart = toIsoDate(row.daily_window_start);
    const weeklyStart = toIsoDate(row.weekly_window_start);
    let dailyPl = row.daily_realized_pl;
    let weeklyPl = row.weekly_realized_pl;
    let nextDaily = dailyStart;
    let nextWeekly = weeklyStart;

    /* M8.7 — on window rollover, update drawdown baselines */
    const trackedBaseline = Number(row.initial_equity);
    const pe = Number.isFinite(trackedBaseline) && trackedBaseline > 0
      ? trackedBaseline
      : (paperEquity ?? PLATFORM_RISK_CEILINGS.defaultPaperEquity);
    const currentAccountValue = pe + Number(row.cumulative_realized_pl ?? 0);
    let dailyHighValue = row.daily_high_value;
    let weeklyOpenValue = row.weekly_open_value;

    if (dailyStart !== utc.day) {
      dailyPl = '0';
      nextDaily = utc.day;
      dailyHighValue = String(currentAccountValue);
    }
    if (weeklyStart !== utc.weekStart) {
      weeklyPl = '0';
      nextWeekly = utc.weekStart;
      weeklyOpenValue = String(currentAccountValue);
    }
    if (nextDaily !== dailyStart || nextWeekly !== weeklyStart) {
      const peakValue = Number(row.peak_equity);
      const currentDd = peakValue > 0 ? Math.max(0, ((peakValue - currentAccountValue) / peakValue) * 100) : 0;
      const dailyHighNumber = Number(dailyHighValue);
      const dailyDd = dailyHighNumber > 0
        ? Math.max(0, ((dailyHighNumber - currentAccountValue) / dailyHighNumber) * 100)
        : 0;
      const weeklyOpenNumber = Number(weeklyOpenValue);
      const weeklyDd = weeklyOpenNumber > 0
        ? Math.max(0, ((weeklyOpenNumber - currentAccountValue) / weeklyOpenNumber) * 100)
        : 0;
      const updated = await q.query<AccountRow>(
        `UPDATE risk_account_states
            SET daily_realized_pl = $2, weekly_realized_pl = $3,
                daily_window_start = $4::date, weekly_window_start = $5::date,
                daily_high_value = $6, weekly_open_value = $7,
                current_drawdown_pct = $8, daily_drawdown_pct = $9, weekly_drawdown_pct = $10,
                version = version + 1
          WHERE id = $1
          RETURNING *`,
        [row.id, dailyPl, weeklyPl, nextDaily, nextWeekly, dailyHighValue, weeklyOpenValue, currentDd, dailyDd, weeklyDd],
      );
      row = updated.rows[0] ?? {
        ...row,
        daily_realized_pl: dailyPl,
        weekly_realized_pl: weeklyPl,
        daily_high_value: dailyHighValue,
        daily_drawdown_pct: String(dailyDd),
        weekly_open_value: weeklyOpenValue,
        current_drawdown_pct: String(currentDd),
        weekly_drawdown_pct: String(weeklyDd),
      };
    }
    return row;
  }

  private async loadOpenPositions(
    userId: string,
    executionProfileId: string,
    q: RiskQueryable,
  ): Promise<
    Array<{
      symbol: string;
      direction: 'long' | 'short';
      quantity: DecT;
      entry: DecT;
      stopLoss: DecT | null;
      spec: InstrumentRiskSpec | null;
    }>
  > {
    const res = await q.query<{
      symbol: string;
      direction: 'long' | 'short';
      quantity: string;
      average_entry_price: string;
      stop_loss_price: string | null;
      asset_class: string;
    }>(
      `SELECT symbol, direction, quantity, average_entry_price, stop_loss_price, asset_class
         FROM execution_positions
        WHERE user_id = $1 AND execution_profile_id = $2 AND status = 'open'`,
      [userId, executionProfileId],
    );
    const out = [];
    for (const row of res.rows) {
      const spec = await this.loadInstrumentSpec(row.asset_class, row.symbol, q);
      out.push({
        symbol: row.symbol,
        direction: row.direction,
        quantity: Dec.fromUnknown(row.quantity) ?? DEC_ZERO,
        entry: Dec.fromUnknown(row.average_entry_price) ?? DEC_ZERO,
        stopLoss: row.stop_loss_price === null ? null : (Dec.fromUnknown(row.stop_loss_price) ?? null),
        spec,
      });
    }
    return out;
  }

  /**
   * Drop reservations whose TTL has elapsed. Must run under the same
   * advisory lock as `evaluate` so a concurrent twin cannot observe a
   * half-reclaimed set. Uses the injected clock, never wall-clock, so
   * tests stay deterministic.
   */
  private async reclaimExpiredReservations(
    executionProfileId: string,
    nowMs: number,
    q: RiskQueryable,
  ): Promise<void> {
    await q.query(
      `DELETE FROM risk_reservations
        WHERE execution_profile_id = $1
          AND expires_at <= to_timestamp($2 / 1000.0)`,
      [executionProfileId, nowMs],
    );
  }

  private async loadReservations(
    executionProfileId: string,
    nowMs: number,
    q: RiskQueryable,
  ): Promise<Array<{ symbol: string; direction: 'long' | 'short'; monetaryRisk: DecT }>> {
    const res = await q.query<{ symbol: string; direction: 'long' | 'short'; monetary_risk: string }>(
      `SELECT symbol, direction, monetary_risk FROM risk_reservations
        WHERE execution_profile_id = $1
          AND expires_at > to_timestamp($2 / 1000.0)`,
      [executionProfileId, nowMs],
    );
    return res.rows.map((r) => ({
      symbol: r.symbol,
      direction: r.direction,
      monetaryRisk: Dec.fromUnknown(r.monetary_risk) ?? DEC_ZERO,
    }));
  }

  private async loadInstrumentSpec(
    assetClass: string,
    symbol: string,
    q: RiskQueryable,
  ): Promise<InstrumentRiskSpec | null> {
    const res = await q.query<{
      asset_class: string;
      symbol: string;
      contract_size: string;
      pip_size: string;
      pnl_mode: 'quote_linear' | 'base_linear';
      quote_currency: string;
      min_quantity: string;
      quantity_step: string;
      max_quantity: string;
    }>(
      `SELECT i.asset_class, i.symbol, s.contract_size, s.pip_size, s.pnl_mode, s.quote_currency,
              s.min_quantity, s.quantity_step, s.max_quantity
         FROM instruments i
         JOIN instrument_risk_specs s ON s.instrument_id = i.id
        WHERE i.asset_class = $1 AND i.symbol = $2`,
      [assetClass, symbol],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      assetClass: row.asset_class as InstrumentRiskSpec['assetClass'],
      symbol: row.symbol,
      contractSize: Number(row.contract_size),
      pipSize: Number(row.pip_size),
      pnlMode: row.pnl_mode,
      quoteCurrency: row.quote_currency,
      minQuantity: Number(row.min_quantity),
      quantityStep: Number(row.quantity_step),
      maxQuantity: Number(row.max_quantity),
    };
  }

  private async loadCorrelation(
    assetClass: string,
    symbol: string,
    q: RiskQueryable,
  ): Promise<{
    groups: Array<{ id: string; slug: string; maxExposurePct: number | null; members: string[] }>;
    candidateGroupIds: string[];
  }> {
    const mine = await q.query<{ group_id: string }>(
      `SELECT icg.group_id
         FROM instrument_correlation_groups icg
         JOIN instruments i ON i.id = icg.instrument_id
        WHERE i.asset_class = $1 AND i.symbol = $2`,
      [assetClass, symbol],
    );
    const candidateGroupIds = mine.rows.map((r) => r.group_id);
    if (candidateGroupIds.length === 0) return { groups: [], candidateGroupIds: [] };

    const groupsRes = await q.query<{
      id: string;
      slug: string;
      max_exposure_pct: string | null;
    }>(`SELECT id, slug, max_exposure_pct FROM correlation_groups WHERE id = ANY($1::uuid[])`, [candidateGroupIds]);

    const membersRes = await q.query<{ group_id: string; symbol: string }>(
      `SELECT icg.group_id, i.symbol
         FROM instrument_correlation_groups icg
         JOIN instruments i ON i.id = icg.instrument_id
        WHERE icg.group_id = ANY($1::uuid[])`,
      [candidateGroupIds],
    );
    const membersByGroup = new Map<string, string[]>();
    for (const m of membersRes.rows) {
      const list = membersByGroup.get(m.group_id) ?? [];
      list.push(m.symbol);
      membersByGroup.set(m.group_id, list);
    }
    const groups = groupsRes.rows.map((g) => ({
      id: g.id,
      slug: g.slug,
      maxExposurePct: g.max_exposure_pct === null ? null : Number(g.max_exposure_pct),
      members: membersByGroup.get(g.id) ?? [],
    }));
    return { groups, candidateGroupIds };
  }

  private async loadStrategyOverride(
    userId: string,
    strategyId: string,
    q: RiskQueryable,
  ): Promise<StrategyRiskOverride | null> {
    const res = await q.query<{
      enabled: boolean;
      blocked: boolean;
      min_rr: string | null;
      max_risk_pct: string | null;
    }>(`SELECT enabled, blocked, min_rr, max_risk_pct FROM risk_strategy_overrides WHERE strategy_id = $1 AND user_id = $2`, [
      strategyId,
      userId,
    ]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      enabled: row.enabled,
      blocked: row.blocked,
      minRr: row.min_rr === null ? null : Number(row.min_rr),
      maxRiskPct: row.max_risk_pct === null ? null : Number(row.max_risk_pct),
    };
  }

  private async loadStrategyMinRr(strategyVersionId: string, q: RiskQueryable): Promise<number | null> {
    const res = await q.query<{ min_rr: string }>(
      `SELECT min_rr FROM strategy_risk_config WHERE version_id = $1`,
      [strategyVersionId],
    );
    const row = res.rows[0];
    if (!row) return null;
    const n = Number(row.min_rr);
    return Number.isFinite(n) ? n : null;
  }

  private async persistDecision(
    q: RiskQueryable,
    args: RiskEvaluateArgs,
    verdict: RiskEngineVerdict,
    nowMs: number,
  ): Promise<PersistedRiskDecision> {
    const current = toExposureDto(verdict.currentExposure);
    const projected = toExposureDto(verdict.projectedExposure);
    const res = await q.query<{ id: string; evaluated_at: Date }>(
      `INSERT INTO risk_decisions
         (user_id, execution_profile_id, setup_id, strategy_id, outcome, rejection_code, reason, violations,
          risk_pct, monetary_risk, position_size, entry_price, stop_loss_price, take_profit_price, rr,
          current_exposure, projected_exposure, policy_version, engine_version, evaluated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, to_timestamp($20 / 1000.0))
       RETURNING id, evaluated_at`,
      [
        args.userId,
        args.executionProfileId,
        args.decision.setupId,
        args.decision.strategyId,
        verdict.outcome,
        verdict.rejectionCode,
        verdict.reason,
        JSON.stringify(verdict.violations),
        verdict.riskPct ? verdict.riskPct.toFixed(6) : null,
        verdict.monetaryRisk ? verdict.monetaryRisk.toFixed(10) : null,
        verdict.positionSize ? verdict.positionSize.toFixed(10) : null,
        args.decision.entryPrice,
        args.decision.stopLossPrice,
        args.decision.takeProfitPrice,
        verdict.rr ? verdict.rr.toFixed(6) : null,
        JSON.stringify(current),
        JSON.stringify(projected),
        verdict.policyVersion,
        RISK_ENGINE_VERSION,
        nowMs,
      ],
    );
    const row = res.rows[0];
    if (!row) throw Errors.internal('Failed to persist risk decision');
    return {
      id: row.id,
      outcome: verdict.outcome,
      rejectionCode: verdict.rejectionCode,
      reason: verdict.reason,
      riskPct: verdict.riskPct ? verdict.riskPct.toNumber(4) : null,
      monetaryRisk: verdict.monetaryRisk ? verdict.monetaryRisk.toNumber(2) : null,
      positionSize: verdict.positionSize ? verdict.positionSize.toNumber(8) : null,
      entryPrice: args.decision.entryPrice,
      stopLossPrice: args.decision.stopLossPrice,
      takeProfitPrice: args.decision.takeProfitPrice,
      rr: verdict.rr ? verdict.rr.toNumber(4) : null,
      currentExposure: current,
      projectedExposure: projected,
      policyVersion: verdict.policyVersion,
      engineVersion: RISK_ENGINE_VERSION,
      evaluatedAt: row.evaluated_at.toISOString(),
      exposureWithinLimits: verdict.exposureWithinLimits,
      effectiveMinRr: verdict.effectiveMinRr,
      violations: verdict.violations,
    };
  }

  private async loadDrawdownInput(
    userId: string,
    executionProfileId: string,
    account: AccountRow,
    equity: DecT,
    nowMs: number,
    q: RiskQueryable,
  ): Promise<{
    currentAccountValue: DecT;
    peakEquity: DecT;
    dailyHighValue: DecT;
    weeklyOpenValue: DecT;
    initialized: boolean;
  } | null> {
    if (!account.equity_initialized) return null;

    const initial = Dec.fromUnknown(account.initial_equity);
    const cumulative = Dec.fromUnknown(account.cumulative_realized_pl);
    const peak = Dec.fromUnknown(account.peak_equity);
    const storedCurrentDd = Dec.fromUnknown(account.current_drawdown_pct);
    const dailyHigh = Dec.fromUnknown(account.daily_high_value);
    const storedDailyDd = Dec.fromUnknown(account.daily_drawdown_pct);
    const weeklyOpen = Dec.fromUnknown(account.weekly_open_value);
    const storedWeeklyDd = Dec.fromUnknown(account.weekly_drawdown_pct);
    const updatedMs = account.updated_at instanceof Date ? account.updated_at.getTime() : NaN;

    if (
      !initial?.isPositive ||
      !cumulative ||
      !peak?.isPositive ||
      !storedCurrentDd ||
      !dailyHigh?.isPositive ||
      !storedDailyDd ||
      !weeklyOpen?.isPositive ||
      !storedWeeklyDd ||
      !Number.isFinite(updatedMs) ||
      (Number.isFinite(nowMs) && updatedMs < nowMs - RISK_ACCOUNT_STATE_STALE_MS)
    ) {
      return null;
    }

    let current: DecT;
    try {
      current = initial.add(cumulative);
    } catch {
      return null;
    }
    // A tracked profile must use its immutable baseline for sizing and
    // drawdown. A policy edit or a corrupted row must not change it.
    if (!equity.eq(initial)) return null;

    // Relational contradictions are data failures, not zero drawdown.
    if (
      peak.lt(current)
      || dailyHigh.lt(current)
      || weeklyOpen.gt(peak)
      || dailyHigh.gt(peak)
    ) {
      return null;
    }
    const drawdownPct = (baseline: DecT): DecT => {
      if (!baseline.isPositive) return Dec.zero();
      const drop = baseline.sub(current);
      return (drop.isPositive ? drop.mul(Dec.fromInt(100)).div(baseline) : Dec.zero()) ?? Dec.zero();
    };
    try {
      if (
        !storedCurrentDd.eq(drawdownPct(peak).roundTo(6, 'half_even'))
        || !storedDailyDd.eq(drawdownPct(dailyHigh).roundTo(6, 'half_even'))
        || !storedWeeklyDd.eq(drawdownPct(weeklyOpen).roundTo(6, 'half_even'))
      ) {
        return null;
      }
    } catch {
      return null;
    }

    // Once paper positions exist, the account ledger must agree with the
    // append-only execution records. A mismatch means the account state is
    // stale or was changed outside the authoritative close transaction.
    const closed = await q.query<{
      closed_count: string;
      missing_realized_count: string;
      closed_sum: string;
    }>(
      `SELECT count(*)::text AS closed_count,
              count(*) FILTER (WHERE realized_pl IS NULL)::text AS missing_realized_count,
              round(coalesce(sum(realized_pl), 0), 4)::text AS closed_sum
         FROM execution_positions
        WHERE user_id = $1 AND execution_profile_id = $2
          AND simulated = true AND status = 'closed'`,
      [userId, executionProfileId],
    );
    const ledger = closed.rows[0];
    const closedSum = ledger ? Dec.fromUnknown(ledger.closed_sum) : null;
    if (
      !ledger
      || !closedSum
      || Number(ledger.missing_realized_count) > 0
      || (Number(ledger.closed_count) > 0 && !closedSum.eq(cumulative))
    ) {
      return null;
    }

    return {
      currentAccountValue: current,
      peakEquity: peak,
      dailyHighValue: dailyHigh,
      weeklyOpenValue: weeklyOpen,
      initialized: true,
    };
  }

  private async loadAccountSnapshot(
    userId: string,
    executionProfileId: string | null,
    paperEquity: number,
  ): Promise<RiskAccountSnapshotDto> {
    if (!executionProfileId) {
      const nowDate = new Date().toISOString().slice(0, 10);
      return {
        equity: paperEquity,
        dailyRealizedPl: 0,
        weeklyRealizedPl: 0,
        consecutiveLosses: 0,
        openPositions: 0,
        reservedPositions: 0,
        totalOpenRisk: 0,
        dailyWindowStart: nowDate,
        weeklyWindowStart: mondayUtc(Date.now()),
        /* M8.7 — no profile = no drawdown data; base values only */
        currentAccountValue: paperEquity,
        peakEquity: paperEquity,
        currentDrawdownPct: 0,
        dailyHighValue: paperEquity,
        dailyDrawdownPct: 0,
        weeklyOpenValue: paperEquity,
        weeklyDrawdownPct: 0,
      };
    }
    const state = await this.pool.query<AccountRow>(
      `SELECT * FROM risk_account_states WHERE execution_profile_id = $1`,
      [executionProfileId],
    );
    const open = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM execution_positions
        WHERE user_id = $1 AND execution_profile_id = $2 AND status = 'open'`,
      [userId, executionProfileId],
    );
    const reserved = await this.pool.query<{ n: string; risk: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(monetary_risk), 0)::text AS risk
         FROM risk_reservations
        WHERE execution_profile_id = $1
          AND expires_at > now()`,
      [executionProfileId],
    );
    const row = state.rows[0];
    const trackedBaseline = row ? Number(row.initial_equity) : NaN;
    const effectiveEquity = row?.equity_initialized && Number.isFinite(trackedBaseline) && trackedBaseline > 0
      ? trackedBaseline
      : paperEquity;
    const currentAccountValue = effectiveEquity + (row ? Number(row.cumulative_realized_pl ?? 0) : 0);
    const peakEquity = row ? Number(row.peak_equity ?? effectiveEquity) : effectiveEquity;
    const dailyHighValue = row ? Number(row.daily_high_value ?? currentAccountValue) : currentAccountValue;
    const weeklyOpenValue = row ? Number(row.weekly_open_value ?? currentAccountValue) : currentAccountValue;
    return {
      equity: effectiveEquity,
      dailyRealizedPl: row ? Number(row.daily_realized_pl) : 0,
      weeklyRealizedPl: row ? Number(row.weekly_realized_pl) : 0,
      consecutiveLosses: row ? row.consecutive_losses : 0,
      openPositions: Number(open.rows[0]?.n ?? 0),
      reservedPositions: Number(reserved.rows[0]?.n ?? 0),
      totalOpenRisk: Number(reserved.rows[0]?.risk ?? 0),
      dailyWindowStart: row ? toIsoDate(row.daily_window_start) : new Date().toISOString().slice(0, 10),
      weeklyWindowStart: row ? toIsoDate(row.weekly_window_start) : mondayUtc(Date.now()),
      /* M8.7 — drawdown protection state */
      currentAccountValue,
      peakEquity,
      currentDrawdownPct: peakEquity > 0 ? Math.max(0, ((peakEquity - currentAccountValue) / peakEquity) * 100) : 0,
      dailyHighValue,
      dailyDrawdownPct: dailyHighValue > 0 ? Math.max(0, ((dailyHighValue - currentAccountValue) / dailyHighValue) * 100) : 0,
      weeklyOpenValue,
      weeklyDrawdownPct: weeklyOpenValue > 0 ? Math.max(0, ((weeklyOpenValue - currentAccountValue) / weeklyOpenValue) * 100) : 0,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* row mapping                                                                 */
/* -------------------------------------------------------------------------- */

interface PolicyRow {
  id: string;
  user_id: string;
  enabled: boolean;
  policy_version: number;
  risk_pct_per_trade: string;
  max_monetary_risk_per_trade: string | null;
  max_daily_loss_pct: string;
  max_weekly_loss_pct: string;
  max_consecutive_losses: number;
  max_simultaneous_positions: number;
  max_total_open_risk_pct: string;
  max_exposure_per_instrument_pct: string;
  max_exposure_per_direction_pct: string;
  min_rr: string;
  max_spread_pips: string | null;
  max_slippage_pips: string | null;
  allowed_sessions: unknown;
  correlation_required: boolean;
  max_correlation_group_exposure_pct: string;
  paper_equity: string;
  circuit_breaker_enabled: boolean;
  /* M8.7 — drawdown protection columns */
  daily_drawdown_warning_pct: string;
  daily_drawdown_limit_pct: string;
  weekly_drawdown_warning_pct: string;
  weekly_drawdown_limit_pct: string;
  max_drawdown_warning_pct: string;
  max_drawdown_limit_pct: string;
  created_at: Date;
  updated_at: Date;
}

interface AccountRow {
  id: string;
  daily_realized_pl: string;
  weekly_realized_pl: string;
  consecutive_losses: number;
  daily_window_start: Date | string;
  weekly_window_start: Date | string;
  version: number;
  /* M8.7 — drawdown tracking columns */
  initial_equity: string;
  peak_equity: string;
  current_drawdown_pct: string;
  daily_high_value: string;
  daily_drawdown_pct: string;
  weekly_open_value: string;
  weekly_drawdown_pct: string;
  cumulative_realized_pl: string;
  equity_initialized: boolean;
  updated_at: Date;
}

interface DecisionRow {
  id: string;
  outcome: 'approved' | 'rejected';
  rejection_code: string | null;
  reason: string;
  risk_pct: string | null;
  monetary_risk: string | null;
  position_size: string | null;
  entry_price: string;
  stop_loss_price: string;
  take_profit_price: string;
  rr: string | null;
  current_exposure: RiskExposureSnapshot;
  projected_exposure: RiskExposureSnapshot;
  policy_version: number;
  engine_version: string;
  evaluated_at: Date;
}

function policyFromRow(row: PolicyRow): RiskPolicyDto {
  return {
    id: row.id,
    enabled: row.enabled,
    policyVersion: row.policy_version,
    riskPctPerTrade: Number(row.risk_pct_per_trade),
    maxMonetaryRiskPerTrade: row.max_monetary_risk_per_trade === null ? null : Number(row.max_monetary_risk_per_trade),
    maxDailyLossPct: Number(row.max_daily_loss_pct),
    maxWeeklyLossPct: Number(row.max_weekly_loss_pct),
    maxConsecutiveLosses: row.max_consecutive_losses,
    maxSimultaneousPositions: row.max_simultaneous_positions,
    maxTotalOpenRiskPct: Number(row.max_total_open_risk_pct),
    maxExposurePerInstrumentPct: Number(row.max_exposure_per_instrument_pct),
    maxExposurePerDirectionPct: Number(row.max_exposure_per_direction_pct),
    minRr: Number(row.min_rr),
    maxSpreadPips: row.max_spread_pips === null ? null : Number(row.max_spread_pips),
    maxSlippagePips: row.max_slippage_pips === null ? null : Number(row.max_slippage_pips),
    allowedSessions: parseSessions(row.allowed_sessions),
    correlationRequired: row.correlation_required,
    maxCorrelationGroupExposurePct: Number(row.max_correlation_group_exposure_pct),
    paperEquity: Number(row.paper_equity),
    // M8.6 — platform-controlled; absent column (pre-0021 row cache) reads ON.
    circuitBreakerEnabled: row.circuit_breaker_enabled !== false,
    /* M8.7 — drawdown protection thresholds (default if column absent in older rows) */
    dailyDrawdownWarningPct: row.daily_drawdown_warning_pct != null ? Number(row.daily_drawdown_warning_pct) : DEFAULT_RISK_POLICY.dailyDrawdownWarningPct,
    dailyDrawdownLimitPct: row.daily_drawdown_limit_pct != null ? Number(row.daily_drawdown_limit_pct) : DEFAULT_RISK_POLICY.dailyDrawdownLimitPct,
    weeklyDrawdownWarningPct: row.weekly_drawdown_warning_pct != null ? Number(row.weekly_drawdown_warning_pct) : DEFAULT_RISK_POLICY.weeklyDrawdownWarningPct,
    weeklyDrawdownLimitPct: row.weekly_drawdown_limit_pct != null ? Number(row.weekly_drawdown_limit_pct) : DEFAULT_RISK_POLICY.weeklyDrawdownLimitPct,
    maxDrawdownWarningPct: row.max_drawdown_warning_pct != null ? Number(row.max_drawdown_warning_pct) : DEFAULT_RISK_POLICY.maxDrawdownWarningPct,
    maxDrawdownLimitPct: row.max_drawdown_limit_pct != null ? Number(row.max_drawdown_limit_pct) : DEFAULT_RISK_POLICY.maxDrawdownLimitPct,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseSessions(raw: unknown): RiskSessionWindow[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const out: RiskSessionWindow[] = [];
  for (const item of raw) {
    const parsed = riskSessionWindowSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function toDecisionDto(row: DecisionRow): RiskDecisionDto {
  return {
    id: row.id,
    outcome: row.outcome,
    rejectionCode: row.rejection_code as RiskDecisionDto['rejectionCode'],
    reason: row.reason,
    riskPct: row.risk_pct === null ? null : Number(row.risk_pct),
    monetaryRisk: row.monetary_risk === null ? null : Number(row.monetary_risk),
    positionSize: row.position_size === null ? null : Number(row.position_size),
    entryPrice: Number(row.entry_price),
    stopLossPrice: Number(row.stop_loss_price),
    takeProfitPrice: Number(row.take_profit_price),
    rr: row.rr === null ? null : Number(row.rr),
    currentExposure: row.current_exposure,
    projectedExposure: row.projected_exposure,
    policyVersion: row.policy_version,
    engineVersion: row.engine_version as typeof RISK_ENGINE_VERSION,
    evaluatedAt: row.evaluated_at.toISOString(),
  };
}

function toExposureDto(view: RiskEngineVerdict['currentExposure']): RiskExposureSnapshot {
  return {
    openPositions: view.openPositions,
    reservedPositions: view.reservedPositions,
    totalOpenRisk: view.totalOpenRisk.toNumber(2),
    instrumentOpenRisk: view.instrumentOpenRisk.toNumber(2),
    directionOpenRisk: view.directionOpenRisk.toNumber(2),
  };
}

function utcDateParts(ms: number): { day: string; weekStart: string } {
  const d = new Date(ms);
  const day = d.toISOString().slice(0, 10);
  return { day, weekStart: mondayUtc(ms) };
}

function mondayUtc(ms: number): string {
  const d = new Date(ms);
  const iso = d.getUTCDay(); // 0 Sun … 6 Sat
  const offset = iso === 0 ? 6 : iso - 1;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  return monday.toISOString().slice(0, 10);
}

function toIsoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export { defaultEffectivePolicy };
