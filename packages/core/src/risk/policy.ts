import {
  DEFAULT_RISK_POLICY,
  PLATFORM_RISK_CEILINGS,
  type RiskPolicyUpdateInput,
  type RiskSessionWindow,
} from '@veltrixeye/contracts';

/**
 * Effective, server-owned risk policy after applying platform ceilings.
 *
 * User values may only TIGHTEN the envelope. Anything above a ceiling is
 * dropped to the ceiling at evaluation time (defence in depth — the API
 * already rejects such writes). minRr is raised to the platform floor.
 *
 * M8.7 adds drawdown protection fields (warning < hard-stop).
 */

export interface EffectiveRiskPolicy {
  enabled: boolean;
  policyVersion: number;
  riskPctPerTrade: number;
  maxMonetaryRiskPerTrade: number | null;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxConsecutiveLosses: number;
  maxSimultaneousPositions: number;
  maxTotalOpenRiskPct: number;
  maxExposurePerInstrumentPct: number;
  maxExposurePerDirectionPct: number;
  minRr: number;
  maxSpreadPips: number | null;
  maxSlippagePips: number | null;
  allowedSessions: readonly RiskSessionWindow[] | null;
  correlationRequired: boolean;
  maxCorrelationGroupExposurePct: number;
  paperEquity: number;
  /* M8.7 — drawdown protection thresholds */
  dailyDrawdownWarningPct: number;
  dailyDrawdownLimitPct: number;
  weeklyDrawdownWarningPct: number;
  weeklyDrawdownLimitPct: number;
  maxDrawdownWarningPct: number;
  maxDrawdownLimitPct: number;
}

export interface StrategyRiskOverride {
  enabled: boolean;
  blocked: boolean;
  minRr: number | null;
  maxRiskPct: number | null;
}

function capPct(value: number, ceiling: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return Math.min(fallback, ceiling);
  return Math.min(value, ceiling);
}

function capInt(value: number, ceiling: number, fallback: number): number {
  if (!Number.isInteger(value) || value <= 0) return Math.min(fallback, ceiling);
  return Math.min(value, ceiling);
}

export function applyPlatformCeilings(raw: {
  enabled: boolean;
  policyVersion: number;
  riskPctPerTrade: number;
  maxMonetaryRiskPerTrade: number | null;
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxConsecutiveLosses: number;
  maxSimultaneousPositions: number;
  maxTotalOpenRiskPct: number;
  maxExposurePerInstrumentPct: number;
  maxExposurePerDirectionPct: number;
  minRr: number;
  maxSpreadPips: number | null;
  maxSlippagePips: number | null;
  allowedSessions: readonly RiskSessionWindow[] | null;
  correlationRequired: boolean;
  maxCorrelationGroupExposurePct: number;
  paperEquity: number;
  /* M8.7 — drawdown protection thresholds */
  dailyDrawdownWarningPct?: number;
  dailyDrawdownLimitPct?: number;
  weeklyDrawdownWarningPct?: number;
  weeklyDrawdownLimitPct?: number;
  maxDrawdownWarningPct?: number;
  maxDrawdownLimitPct?: number;
}): EffectiveRiskPolicy {
  const c = PLATFORM_RISK_CEILINGS;
  const d = DEFAULT_RISK_POLICY;
  const equity = Number.isFinite(raw.paperEquity)
    ? Math.min(Math.max(raw.paperEquity, c.minPaperEquity), c.maxPaperEquity)
    : c.defaultPaperEquity;
  const minRr = Number.isFinite(raw.minRr) ? Math.max(raw.minRr, c.minRr) : c.minRr;
  const maxMoney =
    raw.maxMonetaryRiskPerTrade === null
      ? null
      : Number.isFinite(raw.maxMonetaryRiskPerTrade) && raw.maxMonetaryRiskPerTrade > 0
        ? Math.min(raw.maxMonetaryRiskPerTrade, c.maxMonetaryRiskPerTrade)
        : d.maxMonetaryRiskPerTrade;

  /* M8.7 — drawdown: warning ≤ hard-stop ≤ ceiling, default if invalid */
  const ddRaw = {
    dailyWarn: raw.dailyDrawdownWarningPct ?? d.dailyDrawdownWarningPct,
    dailyLimit: raw.dailyDrawdownLimitPct ?? d.dailyDrawdownLimitPct,
    weeklyWarn: raw.weeklyDrawdownWarningPct ?? d.weeklyDrawdownWarningPct,
    weeklyLimit: raw.weeklyDrawdownLimitPct ?? d.weeklyDrawdownLimitPct,
    maxWarn: raw.maxDrawdownWarningPct ?? d.maxDrawdownWarningPct,
    maxLimit: raw.maxDrawdownLimitPct ?? d.maxDrawdownLimitPct,
  };
  const capDrawdown = (val: number, ceil: number, fallback: number): number =>
    Number.isFinite(val) && val > 0 ? Math.min(val, ceil) : fallback;

  let dailyDrawdownWarningPct = capDrawdown(ddRaw.dailyWarn, c.maxDailyDrawdownPct, d.dailyDrawdownWarningPct);
  const dailyDrawdownLimitPct = capDrawdown(ddRaw.dailyLimit, c.maxDailyDrawdownPct, d.dailyDrawdownLimitPct);
  let weeklyDrawdownWarningPct = capDrawdown(ddRaw.weeklyWarn, c.maxWeeklyDrawdownPct, d.weeklyDrawdownWarningPct);
  const weeklyDrawdownLimitPct = capDrawdown(ddRaw.weeklyLimit, c.maxWeeklyDrawdownPct, d.weeklyDrawdownLimitPct);
  let maxDrawdownWarningPct = capDrawdown(ddRaw.maxWarn, c.maxMaxDrawdownPct, d.maxDrawdownWarningPct);
  const maxDrawdownLimitPct = capDrawdown(ddRaw.maxLimit, c.maxMaxDrawdownPct, d.maxDrawdownLimitPct);

  // Enforce warning ≤ hard-stop (tighten the warning if it exceeds the limit).
  if (dailyDrawdownWarningPct > dailyDrawdownLimitPct) dailyDrawdownWarningPct = dailyDrawdownLimitPct;
  if (weeklyDrawdownWarningPct > weeklyDrawdownLimitPct) weeklyDrawdownWarningPct = weeklyDrawdownLimitPct;
  if (maxDrawdownWarningPct > maxDrawdownLimitPct) maxDrawdownWarningPct = maxDrawdownLimitPct;

  return {
    enabled: raw.enabled,
    policyVersion: raw.policyVersion > 0 ? Math.trunc(raw.policyVersion) : 1,
    riskPctPerTrade: capPct(raw.riskPctPerTrade, c.maxRiskPctPerTrade, d.riskPctPerTrade),
    maxMonetaryRiskPerTrade: maxMoney,
    maxDailyLossPct: capPct(raw.maxDailyLossPct, c.maxDailyLossPct, d.maxDailyLossPct),
    maxWeeklyLossPct: capPct(raw.maxWeeklyLossPct, c.maxWeeklyLossPct, d.maxWeeklyLossPct),
    maxConsecutiveLosses: capInt(raw.maxConsecutiveLosses, c.maxConsecutiveLosses, d.maxConsecutiveLosses),
    maxSimultaneousPositions: capInt(
      raw.maxSimultaneousPositions,
      c.maxSimultaneousPositions,
      d.maxSimultaneousPositions,
    ),
    maxTotalOpenRiskPct: capPct(raw.maxTotalOpenRiskPct, c.maxTotalOpenRiskPct, d.maxTotalOpenRiskPct),
    maxExposurePerInstrumentPct: capPct(
      raw.maxExposurePerInstrumentPct,
      c.maxExposurePerInstrumentPct,
      d.maxExposurePerInstrumentPct,
    ),
    maxExposurePerDirectionPct: capPct(
      raw.maxExposurePerDirectionPct,
      c.maxExposurePerDirectionPct,
      d.maxExposurePerDirectionPct,
    ),
    minRr,
    maxSpreadPips:
      raw.maxSpreadPips === null || raw.maxSpreadPips === undefined
        ? null
        : Number.isFinite(raw.maxSpreadPips) && raw.maxSpreadPips > 0
          ? raw.maxSpreadPips
          : null,
    maxSlippagePips:
      raw.maxSlippagePips === null || raw.maxSlippagePips === undefined
        ? null
        : Number.isFinite(raw.maxSlippagePips) && raw.maxSlippagePips > 0
          ? raw.maxSlippagePips
          : null,
    allowedSessions: raw.allowedSessions,
    correlationRequired: raw.correlationRequired === true,
    maxCorrelationGroupExposurePct: capPct(
      raw.maxCorrelationGroupExposurePct,
      c.maxTotalOpenRiskPct,
      d.maxCorrelationGroupExposurePct,
    ),
    paperEquity: equity,
    /* M8.7 */
    dailyDrawdownWarningPct,
    dailyDrawdownLimitPct,
    weeklyDrawdownWarningPct,
    weeklyDrawdownLimitPct,
    maxDrawdownWarningPct,
    maxDrawdownLimitPct,
  };
}

export function defaultEffectivePolicy(): EffectiveRiskPolicy {
  return applyPlatformCeilings({
    enabled: DEFAULT_RISK_POLICY.enabled,
    policyVersion: 1,
    riskPctPerTrade: DEFAULT_RISK_POLICY.riskPctPerTrade,
    maxMonetaryRiskPerTrade: DEFAULT_RISK_POLICY.maxMonetaryRiskPerTrade,
    maxDailyLossPct: DEFAULT_RISK_POLICY.maxDailyLossPct,
    maxWeeklyLossPct: DEFAULT_RISK_POLICY.maxWeeklyLossPct,
    maxConsecutiveLosses: DEFAULT_RISK_POLICY.maxConsecutiveLosses,
    maxSimultaneousPositions: DEFAULT_RISK_POLICY.maxSimultaneousPositions,
    maxTotalOpenRiskPct: DEFAULT_RISK_POLICY.maxTotalOpenRiskPct,
    maxExposurePerInstrumentPct: DEFAULT_RISK_POLICY.maxExposurePerInstrumentPct,
    maxExposurePerDirectionPct: DEFAULT_RISK_POLICY.maxExposurePerDirectionPct,
    minRr: DEFAULT_RISK_POLICY.minRr,
    maxSpreadPips: DEFAULT_RISK_POLICY.maxSpreadPips,
    maxSlippagePips: DEFAULT_RISK_POLICY.maxSlippagePips,
    allowedSessions: DEFAULT_RISK_POLICY.allowedSessions,
    correlationRequired: DEFAULT_RISK_POLICY.correlationRequired,
    maxCorrelationGroupExposurePct: DEFAULT_RISK_POLICY.maxCorrelationGroupExposurePct,
    paperEquity: PLATFORM_RISK_CEILINGS.defaultPaperEquity,
    /* M8.7 */
    dailyDrawdownWarningPct: DEFAULT_RISK_POLICY.dailyDrawdownWarningPct,
    dailyDrawdownLimitPct: DEFAULT_RISK_POLICY.dailyDrawdownLimitPct,
    weeklyDrawdownWarningPct: DEFAULT_RISK_POLICY.weeklyDrawdownWarningPct,
    weeklyDrawdownLimitPct: DEFAULT_RISK_POLICY.weeklyDrawdownLimitPct,
    maxDrawdownWarningPct: DEFAULT_RISK_POLICY.maxDrawdownWarningPct,
    maxDrawdownLimitPct: DEFAULT_RISK_POLICY.maxDrawdownLimitPct,
  });
}

/** Merge a strategy override: only TIGHTENS (higher minRr, lower risk %). */
export function applyStrategyOverride(
  policy: EffectiveRiskPolicy,
  override: StrategyRiskOverride | null,
): { policy: EffectiveRiskPolicy; blocked: boolean } {
  if (!override || !override.enabled) return { policy, blocked: false };
  const next: EffectiveRiskPolicy = { ...policy };
  if (override.minRr !== null && Number.isFinite(override.minRr) && override.minRr > next.minRr) {
    next.minRr = override.minRr;
  }
  if (override.maxRiskPct !== null && Number.isFinite(override.maxRiskPct) && override.maxRiskPct > 0) {
    next.riskPctPerTrade = Math.min(next.riskPctPerTrade, override.maxRiskPct);
  }
  return { policy: next, blocked: override.blocked === true };
}

/** True when a PATCH body would exceed a ceiling (API rejects rather than clamp). */
export function updateExceedsCeiling(input: RiskPolicyUpdateInput): string | null {
  const c = PLATFORM_RISK_CEILINGS;
  const checks: Array<[number | undefined, number, string]> = [
    [input.riskPctPerTrade, c.maxRiskPctPerTrade, 'riskPctPerTrade'],
    [input.maxDailyLossPct, c.maxDailyLossPct, 'maxDailyLossPct'],
    [input.maxWeeklyLossPct, c.maxWeeklyLossPct, 'maxWeeklyLossPct'],
    [input.maxTotalOpenRiskPct, c.maxTotalOpenRiskPct, 'maxTotalOpenRiskPct'],
    [input.maxExposurePerInstrumentPct, c.maxExposurePerInstrumentPct, 'maxExposurePerInstrumentPct'],
    [input.maxExposurePerDirectionPct, c.maxExposurePerDirectionPct, 'maxExposurePerDirectionPct'],
    [input.maxCorrelationGroupExposurePct, c.maxTotalOpenRiskPct, 'maxCorrelationGroupExposurePct'],
  ];
  for (const [value, ceiling, name] of checks) {
    if (value !== undefined && value > ceiling) return name;
  }
  if (input.maxMonetaryRiskPerTrade !== undefined && input.maxMonetaryRiskPerTrade !== null) {
    if (input.maxMonetaryRiskPerTrade > c.maxMonetaryRiskPerTrade) return 'maxMonetaryRiskPerTrade';
  }
  if (input.maxConsecutiveLosses !== undefined && input.maxConsecutiveLosses > c.maxConsecutiveLosses) {
    return 'maxConsecutiveLosses';
  }
  if (input.maxSimultaneousPositions !== undefined && input.maxSimultaneousPositions > c.maxSimultaneousPositions) {
    return 'maxSimultaneousPositions';
  }
  if (input.minRr !== undefined && input.minRr < c.minRr) return 'minRr';
  if (input.paperEquity !== undefined) {
    if (input.paperEquity < c.minPaperEquity || input.paperEquity > c.maxPaperEquity) return 'paperEquity';
  }
  /* M8.7 — drawdown ceiling checks */
  if (input.dailyDrawdownWarningPct !== undefined && input.dailyDrawdownWarningPct > c.maxDailyDrawdownPct) return 'dailyDrawdownWarningPct';
  if (input.dailyDrawdownLimitPct !== undefined && input.dailyDrawdownLimitPct > c.maxDailyDrawdownPct) return 'dailyDrawdownLimitPct';
  if (input.weeklyDrawdownWarningPct !== undefined && input.weeklyDrawdownWarningPct > c.maxWeeklyDrawdownPct) return 'weeklyDrawdownWarningPct';
  if (input.weeklyDrawdownLimitPct !== undefined && input.weeklyDrawdownLimitPct > c.maxWeeklyDrawdownPct) return 'weeklyDrawdownLimitPct';
  if (input.maxDrawdownWarningPct !== undefined && input.maxDrawdownWarningPct > c.maxMaxDrawdownPct) return 'maxDrawdownWarningPct';
  if (input.maxDrawdownLimitPct !== undefined && input.maxDrawdownLimitPct > c.maxMaxDrawdownPct) return 'maxDrawdownLimitPct';
  return null;
}
