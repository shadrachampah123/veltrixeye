import {
  PLATFORM_RISK_CEILINGS,
  RISK_ENGINE_VERSION,
  RISK_REJECTION_CODES,
  type InstrumentRiskSpec,
  type RiskRejectionCode,
  type RiskSessionWindow,
} from '@veltrixeye/contracts';
import { SESSION_WINDOWS_UTC, hourInSession } from '../strategies/evaluation/indicators.js';
import { Dec, DecimalOverflowError, DEC_HUNDRED, DEC_ZERO, type Dec as DecT } from './decimal.js';
import { calculateRr, effectiveMinRr } from './rr.js';
import { monetaryRiskFor, sizePosition, valuePerUnit } from './sizing.js';
import type { EffectiveRiskPolicy, StrategyRiskOverride } from './policy.js';
import { applyStrategyOverride } from './policy.js';

/**
 * Pure risk engine (M8.2).
 *
 * Same authoritative inputs ⇒ same verdict. No clock, no I/O, no random.
 * `evaluatedAtMs` is an input (the service supplies it) so session and
 * window-roll logic stays deterministic under test.
 *
 * Fail-closed: anything unknown, missing or uncomputable is a rejection.
 * A client boolean is not an input.
 */

export interface OpenPositionSnapshot {
  symbol: string;
  direction: 'long' | 'short';
  quantity: DecT;
  entry: DecT;
  stopLoss: DecT | null;
  spec: InstrumentRiskSpec | null;
}

export interface CorrelationGroupSnapshot {
  id: string;
  slug: string;
  maxExposurePct: number | null;
  members: readonly string[];
}

export interface RiskCandidate {
  action: 'open_long' | 'open_short' | 'close_position';
  symbol: string;
  assetClass: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  expectedRr: number;
  asOfMs: number;
  spreadPips?: number | null;
  slippagePips?: number | null;
}

export interface RiskEngineInput {
  policy: EffectiveRiskPolicy;
  strategyOverride: StrategyRiskOverride | null;
  strategyMinRr: number | null;
  account: {
    equity: DecT;
    dailyRealizedPl: DecT;
    weeklyRealizedPl: DecT;
    consecutiveLosses: number;
  };
  openPositions: readonly OpenPositionSnapshot[];
  reservations: readonly {
    symbol: string;
    direction: 'long' | 'short';
    monetaryRisk: DecT;
  }[];
  instrument: InstrumentRiskSpec | null;
  correlationGroups: readonly CorrelationGroupSnapshot[];
  /** Groups the candidate symbol belongs to. Empty + correlationRequired ⇒ fail. */
  candidateGroupIds: readonly string[];
  killSwitchActive: boolean;
  killSwitchReason?: string | null;
  candidate: RiskCandidate;
  evaluatedAtMs: number;
}

export interface ExposureView {
  openPositions: number;
  reservedPositions: number;
  totalOpenRisk: DecT;
  instrumentOpenRisk: DecT;
  directionOpenRisk: DecT;
}

export interface RiskEngineVerdict {
  outcome: 'approved' | 'rejected';
  rejectionCode: RiskRejectionCode | null;
  reason: string;
  violations: RiskRejectionCode[];
  riskPct: DecT | null;
  monetaryRisk: DecT | null;
  positionSize: DecT | null;
  rr: DecT | null;
  effectiveMinRr: number;
  currentExposure: ExposureView;
  projectedExposure: ExposureView;
  policyVersion: number;
  engineVersion: typeof RISK_ENGINE_VERSION;
  exposureWithinLimits: boolean;
}

const REASONS: Record<RiskRejectionCode, string> = {
  KILL_SWITCH_ACTIVE: 'an applicable kill switch is active',
  POLICY_DISABLED: 'risk policy is disabled',
  INVALID_DIRECTION: 'direction is not long or short',
  INVALID_SYMBOL: 'symbol is invalid',
  UNSUPPORTED_SYMBOL: 'symbol has no instrument risk specification',
  INVALID_ENTRY: 'entry price is not a positive finite number',
  INVALID_STOP_LOSS: 'stop-loss price is not a positive finite number',
  INVALID_TAKE_PROFIT: 'take-profit price is not a positive finite number',
  INVALID_PRICES: 'entry, stop loss or take profit is not a valid price',
  MISSING_SL: 'stop loss is required',
  MISSING_TP: 'take profit is required',
  SL_WRONG_SIDE: 'stop loss is on the wrong side of the entry for this direction',
  TP_WRONG_SIDE: 'take profit is on the wrong side of the entry for this direction',
  STOP_DISTANCE_NOT_POSITIVE: 'stop distance must be positive',
  ZERO_RISK_DISTANCE: 'risk distance is zero',
  MISSING_INSTRUMENT_METADATA: 'instrument risk metadata is unavailable',
  INVALID_CONTRACT_SPEC: 'instrument contract specification is invalid',
  ZERO_OR_NEGATIVE_EQUITY: 'account equity is zero or negative',
  OVERFLOW: 'numeric overflow in a risk calculation',
  SESSION_NOT_ALLOWED: 'the evaluation time is outside the allowed trading sessions',
  RR_INVALID: 'reward:risk could not be computed from the levels',
  RR_BELOW_MINIMUM: 'reward:risk is below the required minimum',
  SPREAD_EXCEEDS_MAXIMUM: 'spread exceeds the configured maximum',
  SLIPPAGE_EXCEEDS_MAXIMUM: 'slippage exceeds the configured maximum',
  STRATEGY_RESTRICTION: 'a strategy-specific risk restriction blocked this trade',
  POSITION_SIZE_UNCOMPUTABLE: 'position size could not be derived from the inputs',
  POSITION_SIZE_BELOW_MINIMUM: 'derived position size is below the instrument minimum',
  POSITION_SIZE_EXCEEDS_MAXIMUM: 'derived position size exceeds the platform or instrument maximum',
  MONETARY_RISK_EXCEEDS_LIMIT: 'monetary risk exceeds the permitted budget',
  DAILY_LOSS_LIMIT: 'the daily loss limit has been reached',
  WEEKLY_LOSS_LIMIT: 'the weekly loss limit has been reached',
  CONSECUTIVE_LOSS_LIMIT: 'the consecutive-loss limit has been reached',
  SIMULTANEOUS_POSITION_LIMIT: 'the simultaneous-position limit would be exceeded',
  TOTAL_OPEN_RISK_LIMIT: 'total open risk would exceed the policy limit',
  INSTRUMENT_EXPOSURE_LIMIT: 'instrument exposure would exceed the policy limit',
  DIRECTION_EXPOSURE_LIMIT: 'directional exposure would exceed the policy limit',
  CORRELATION_METADATA_UNAVAILABLE: 'correlation metadata is required but unavailable',
  CORRELATION_EXPOSURE_LIMIT: 'correlated-group exposure would exceed the policy limit',
  OPEN_POSITION_RISK_UNCOMPUTABLE: 'open-position risk could not be computed (fail-closed)',
};

const emptyExposure = (): ExposureView => ({
  openPositions: 0,
  reservedPositions: 0,
  totalOpenRisk: DEC_ZERO,
  instrumentOpenRisk: DEC_ZERO,
  directionOpenRisk: DEC_ZERO,
});

function reject(
  code: RiskRejectionCode,
  violations: RiskRejectionCode[],
  extra: Partial<RiskEngineVerdict> & { policyVersion: number; effectiveMinRr: number },
): RiskEngineVerdict {
  const unique = orderedUnique([code, ...violations]);
  return {
    outcome: 'rejected',
    rejectionCode: unique[0] ?? code,
    reason: REASONS[unique[0] ?? code],
    violations: unique,
    riskPct: extra.riskPct ?? null,
    monetaryRisk: extra.monetaryRisk ?? null,
    positionSize: extra.positionSize ?? null,
    rr: extra.rr ?? null,
    effectiveMinRr: extra.effectiveMinRr,
    currentExposure: extra.currentExposure ?? emptyExposure(),
    projectedExposure: extra.projectedExposure ?? extra.currentExposure ?? emptyExposure(),
    policyVersion: extra.policyVersion,
    engineVersion: RISK_ENGINE_VERSION,
    exposureWithinLimits: extra.exposureWithinLimits ?? false,
  };
}

function orderedUnique(codes: RiskRejectionCode[]): RiskRejectionCode[] {
  const seen = new Set<RiskRejectionCode>();
  const out: RiskRejectionCode[] = [];
  for (const pinned of RISK_REJECTION_CODES) {
    if (codes.includes(pinned) && !seen.has(pinned)) {
      seen.add(pinned);
      out.push(pinned);
    }
  }
  return out;
}

export function utcHourFromMs(ms: number): number {
  return Math.floor((((ms % 86_400_000) + 86_400_000) % 86_400_000) / 3_600_000);
}

export function sessionAllows(windows: readonly RiskSessionWindow[] | null, atMs: number): boolean {
  if (windows === null || windows === undefined) return true;
  if (windows.length === 0) return false;
  const hour = utcHourFromMs(atMs);
  for (const w of windows) {
    if (w.kind === 'named') {
      if (hourInSession(hour, w.name)) return true;
      continue;
    }
    const start = w.startHour;
    const end = w.endHour;
    if (end === start) continue;
    if (end > start) {
      if (hour >= start && hour < end) return true;
    } else if (end === 24) {
      if (hour >= start) return true;
    } else {
      // wrapping window
      if (hour >= start || hour < end) return true;
    }
  }
  return false;
}

export function openRiskOf(position: OpenPositionSnapshot): DecT | null {
  if (!position.spec || !position.stopLoss || !position.quantity.isPositive || !position.entry.isPositive) {
    return null;
  }
  const distance = position.entry.sub(position.stopLoss).abs();
  if (!distance.isPositive) return null;
  const vpu = valuePerUnit(position.spec, position.entry, distance);
  if (!vpu) return null;
  return monetaryRiskFor(position.quantity, vpu);
}

export function evaluateRisk(input: RiskEngineInput): RiskEngineVerdict {
  try {
    return evaluateRiskInner(input);
  } catch (err) {
    if (err instanceof DecimalOverflowError) {
      return reject('OVERFLOW', ['OVERFLOW'], {
        policyVersion: input.policy.policyVersion,
        effectiveMinRr: PLATFORM_RISK_CEILINGS.minRr,
      });
    }
    throw err;
  }
}

function evaluateRiskInner(input: RiskEngineInput): RiskEngineVerdict {
  const { policy: tightened, blocked } = applyStrategyOverride(input.policy, input.strategyOverride);
  const minRr = effectiveMinRr(tightened.minRr, input.strategyMinRr);
  const policyVersion = tightened.policyVersion;
  const violations: RiskRejectionCode[] = [];
  const base = { policyVersion, effectiveMinRr: minRr };

  const c = input.candidate;
  const isClose = c.action === 'close_position';

  // --- kill switch (never bypassed) ---
  if (input.killSwitchActive) violations.push('KILL_SWITCH_ACTIVE');
  if (!tightened.enabled) violations.push('POLICY_DISABLED');
  if (blocked) violations.push('STRATEGY_RESTRICTION');

  if (c.direction !== 'long' && c.direction !== 'short') violations.push('INVALID_DIRECTION');
  if (typeof c.symbol !== 'string' || c.symbol.length === 0 || c.symbol.length > 32) {
    violations.push('INVALID_SYMBOL');
  }

  const entry = Dec.fromNumber(c.entryPrice);
  const sl = Dec.fromNumber(c.stopLossPrice);
  const tp = Dec.fromNumber(c.takeProfitPrice);
  if (!entry || !entry.isPositive) violations.push('INVALID_ENTRY');
  if (!sl || !sl.isPositive) violations.push('INVALID_STOP_LOSS');
  if (!tp || !tp.isPositive) violations.push('INVALID_TAKE_PROFIT');

  const rr = calculateRr({
    direction: c.direction,
    entry: c.entryPrice,
    stopLoss: c.stopLossPrice,
    takeProfit: c.takeProfitPrice,
    minRr,
  });
  if (!rr.ok) violations.push(rr.code);

  if (!input.account.equity.isPositive) violations.push('ZERO_OR_NEGATIVE_EQUITY');

  // Session windows are evaluated against the server clock (`evaluatedAtMs`),
  // not the setup's detection anchor. A London-detected setup evaluated at
  // 03:00 UTC is outside London hours. Invalid clocks fail closed.
  if (!Number.isFinite(input.evaluatedAtMs) || input.evaluatedAtMs <= 0) {
    violations.push('SESSION_NOT_ALLOWED');
  } else if (!sessionAllows(tightened.allowedSessions, input.evaluatedAtMs)) {
    violations.push('SESSION_NOT_ALLOWED');
  }

  if (tightened.maxSpreadPips !== null) {
    if (c.spreadPips === null || c.spreadPips === undefined || !Number.isFinite(c.spreadPips)) {
      violations.push('SPREAD_EXCEEDS_MAXIMUM');
    } else if (c.spreadPips > tightened.maxSpreadPips) {
      violations.push('SPREAD_EXCEEDS_MAXIMUM');
    }
  }
  if (tightened.maxSlippagePips !== null) {
    if (c.slippagePips === null || c.slippagePips === undefined || !Number.isFinite(c.slippagePips)) {
      violations.push('SLIPPAGE_EXCEEDS_MAXIMUM');
    } else if (c.slippagePips > tightened.maxSlippagePips) {
      violations.push('SLIPPAGE_EXCEEDS_MAXIMUM');
    }
  }

  if (!input.instrument) {
    violations.push('MISSING_INSTRUMENT_METADATA');
  }

  // --- exposure from authoritative open positions + reservations ---
  const current = emptyExposure();
  current.openPositions = input.openPositions.length;
  current.reservedPositions = input.reservations.length;
  let openRiskUncomputable = false;
  const instrumentRisk = (symbol: string): DecT => {
    let sum = DEC_ZERO;
    for (const p of input.openPositions) {
      if (p.symbol !== symbol) continue;
      const r = openRiskOf(p);
      if (r === null) {
        openRiskUncomputable = true;
        continue;
      }
      sum = sum.add(r);
    }
    for (const r of input.reservations) {
      if (r.symbol === symbol) sum = sum.add(r.monetaryRisk);
    }
    return sum;
  };
  const directionRisk = (direction: 'long' | 'short'): DecT => {
    let sum = DEC_ZERO;
    for (const p of input.openPositions) {
      if (p.direction !== direction) continue;
      const r = openRiskOf(p);
      if (r === null) {
        openRiskUncomputable = true;
        continue;
      }
      sum = sum.add(r);
    }
    for (const r of input.reservations) {
      if (r.direction === direction) sum = sum.add(r.monetaryRisk);
    }
    return sum;
  };
  let total = DEC_ZERO;
  for (const p of input.openPositions) {
    const r = openRiskOf(p);
    if (r === null) {
      openRiskUncomputable = true;
      continue;
    }
    total = total.add(r);
  }
  for (const r of input.reservations) total = total.add(r.monetaryRisk);
  current.totalOpenRisk = total;
  current.instrumentOpenRisk = instrumentRisk(c.symbol);
  current.directionOpenRisk = directionRisk(c.direction);
  if (openRiskUncomputable) violations.push('OPEN_POSITION_RISK_UNCOMPUTABLE');

  const equity = input.account.equity;
  const pctOf = (pct: number): DecT => equity.mul(Dec.fromNumber(pct) ?? DEC_ZERO).div(DEC_HUNDRED) ?? DEC_ZERO;

  const dailyLoss = input.account.dailyRealizedPl.isNegative ? input.account.dailyRealizedPl.abs() : DEC_ZERO;
  const weeklyLoss = input.account.weeklyRealizedPl.isNegative ? input.account.weeklyRealizedPl.abs() : DEC_ZERO;
  const dailyCap = pctOf(tightened.maxDailyLossPct);
  const weeklyCap = pctOf(tightened.maxWeeklyLossPct);
  if (dailyLoss.gte(dailyCap) && dailyCap.isPositive) violations.push('DAILY_LOSS_LIMIT');
  if (weeklyLoss.gte(weeklyCap) && weeklyCap.isPositive) violations.push('WEEKLY_LOSS_LIMIT');
  if (input.account.consecutiveLosses >= tightened.maxConsecutiveLosses) {
    violations.push('CONSECUTIVE_LOSS_LIMIT');
  }

  // Close: no new risk. Still fail on kill switch / policy / invalid levels.
  if (isClose) {
    const exposureOk = !violations.some((v) =>
      [
        'SIMULTANEOUS_POSITION_LIMIT',
        'TOTAL_OPEN_RISK_LIMIT',
        'INSTRUMENT_EXPOSURE_LIMIT',
        'DIRECTION_EXPOSURE_LIMIT',
        'CORRELATION_EXPOSURE_LIMIT',
        'OPEN_POSITION_RISK_UNCOMPUTABLE',
      ].includes(v),
    );
    if (violations.length > 0) {
      return reject(violations[0]!, violations, {
        ...base,
        rr: rr.ok ? rr.rr : null,
        currentExposure: current,
        projectedExposure: current,
        exposureWithinLimits: exposureOk,
      });
    }
    return {
      outcome: 'approved',
      rejectionCode: null,
      reason: 'risk checks passed (close does not add exposure)',
      violations: [],
      riskPct: DEC_ZERO,
      monetaryRisk: DEC_ZERO,
      positionSize: DEC_ZERO,
      rr: rr.ok ? rr.rr : null,
      effectiveMinRr: minRr,
      currentExposure: current,
      projectedExposure: current,
      policyVersion,
      engineVersion: RISK_ENGINE_VERSION,
      exposureWithinLimits: true,
    };
  }

  const remainingDaily = dailyCap.sub(dailyLoss);
  const remainingWeekly = weeklyCap.sub(weeklyLoss);
  const totalCap = pctOf(tightened.maxTotalOpenRiskPct);
  const remainingTotal = totalCap.sub(current.totalOpenRisk);
  const instCap = pctOf(tightened.maxExposurePerInstrumentPct);
  const remainingInst = instCap.sub(current.instrumentOpenRisk);
  const dirCap = pctOf(tightened.maxExposurePerDirectionPct);
  const remainingDir = dirCap.sub(current.directionOpenRisk);

  const extraCaps = [remainingDaily, remainingWeekly, remainingTotal, remainingInst, remainingDir].filter((x) =>
    x.gte(DEC_ZERO),
  );
  // A negative remaining budget means the limit is already at/over — treat as a 0 cap.
  const caps = extraCaps.map((x) => (x.isNegative ? DEC_ZERO : x));

  const sized = sizePosition({
    equity,
    riskPct: Dec.fromNumber(tightened.riskPctPerTrade) ?? DEC_ZERO,
    maxMonetaryRisk: tightened.maxMonetaryRiskPerTrade
      ? (Dec.fromNumber(tightened.maxMonetaryRiskPerTrade) ?? null)
      : null,
    extraCaps: caps,
    entry: entry ?? DEC_ZERO,
    stopLoss: sl ?? DEC_ZERO,
    spec: input.instrument,
  });
  if (!sized.ok) violations.push(sized.code);

  const candidateRisk = sized.ok ? sized.monetaryRisk : DEC_ZERO;
  const projected: ExposureView = {
    openPositions: current.openPositions + 1,
    reservedPositions: current.reservedPositions,
    totalOpenRisk: current.totalOpenRisk.add(candidateRisk),
    instrumentOpenRisk: current.instrumentOpenRisk.add(candidateRisk),
    directionOpenRisk: current.directionOpenRisk.add(candidateRisk),
  };

  const liveCount = current.openPositions + current.reservedPositions;
  if (liveCount + 1 > tightened.maxSimultaneousPositions) {
    violations.push('SIMULTANEOUS_POSITION_LIMIT');
  }
  if (projected.totalOpenRisk.gt(totalCap)) violations.push('TOTAL_OPEN_RISK_LIMIT');
  if (projected.instrumentOpenRisk.gt(instCap)) violations.push('INSTRUMENT_EXPOSURE_LIMIT');
  if (projected.directionOpenRisk.gt(dirCap)) violations.push('DIRECTION_EXPOSURE_LIMIT');

  // Correlation groups: configuration-driven, never invented.
  if (tightened.correlationRequired && input.candidateGroupIds.length === 0) {
    violations.push('CORRELATION_METADATA_UNAVAILABLE');
  }
  const groupCapPct = tightened.maxCorrelationGroupExposurePct;
  const groupCap = pctOf(groupCapPct);
  for (const gid of input.candidateGroupIds) {
    const group = input.correlationGroups.find((g) => g.id === gid);
    if (!group) {
      if (tightened.correlationRequired) violations.push('CORRELATION_METADATA_UNAVAILABLE');
      continue;
    }
    const memberSet = new Set(group.members);
    let groupRisk = candidateRisk;
    for (const p of input.openPositions) {
      if (!memberSet.has(p.symbol)) continue;
      const r = openRiskOf(p);
      if (r === null) {
        violations.push('OPEN_POSITION_RISK_UNCOMPUTABLE');
        continue;
      }
      groupRisk = groupRisk.add(r);
    }
    for (const r of input.reservations) {
      if (memberSet.has(r.symbol)) groupRisk = groupRisk.add(r.monetaryRisk);
    }
    const cap = group.maxExposurePct !== null ? pctOf(group.maxExposurePct) : groupCap;
    if (groupRisk.gt(cap)) violations.push('CORRELATION_EXPOSURE_LIMIT');
  }

  const exposureCodes: RiskRejectionCode[] = [
    'SIMULTANEOUS_POSITION_LIMIT',
    'TOTAL_OPEN_RISK_LIMIT',
    'INSTRUMENT_EXPOSURE_LIMIT',
    'DIRECTION_EXPOSURE_LIMIT',
    'CORRELATION_EXPOSURE_LIMIT',
    'CORRELATION_METADATA_UNAVAILABLE',
    'OPEN_POSITION_RISK_UNCOMPUTABLE',
  ];
  const exposureWithinLimits = !violations.some((v) => exposureCodes.includes(v));

  if (violations.length > 0) {
    return reject(violations[0]!, violations, {
      ...base,
      riskPct: sized.ok ? sized.riskPctOfEquity : null,
      monetaryRisk: sized.ok ? sized.monetaryRisk : null,
      positionSize: sized.ok ? sized.quantity : null,
      rr: rr.ok ? rr.rr : null,
      currentExposure: current,
      projectedExposure: projected,
      exposureWithinLimits,
    });
  }

  if (!sized.ok) {
    // Unreachable if violations collected correctly, but fail closed.
    return reject(sized.code, [sized.code], { ...base, currentExposure: current, projectedExposure: projected });
  }

  return {
    outcome: 'approved',
    rejectionCode: null,
    reason: 'risk checks passed',
    violations: [],
    riskPct: sized.riskPctOfEquity,
    monetaryRisk: sized.monetaryRisk,
    positionSize: sized.quantity,
    rr: rr.ok ? rr.rr : null,
    effectiveMinRr: minRr,
    currentExposure: current,
    projectedExposure: projected,
    policyVersion,
    engineVersion: RISK_ENGINE_VERSION,
    exposureWithinLimits: true,
  };
}

/** Exported so tests can pin the named UTC windows the engine uses. */
export const RISK_NAMED_SESSION_WINDOWS = SESSION_WINDOWS_UTC;
