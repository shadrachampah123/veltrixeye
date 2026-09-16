import { PLATFORM_RISK_CEILINGS } from '@veltrixeye/contracts';
import { Dec, DecimalOverflowError, type Dec as DecT } from './decimal.js';

/**
 * Deterministic reward:risk (M8.2).
 *
 *   long:  risk = entry − SL     (must be > 0)   reward = TP − entry (must be > 0)
 *   short: risk = SL − entry     (must be > 0)   reward = entry − TP (must be > 0)
 *
 *   rr = reward / risk
 *
 * Rejects missing / wrong-side / zero-distance / negative / below-minimum RR.
 * The client cannot override the minimum: effectiveMin = max(platform, policy, strategy).
 *
 * Comparison is exact at 10 decimal places. Exactly at the minimum is
 * APPROVED; anything strictly below is REJECTED.
 */

export type RrFailure =
  | 'MISSING_SL'
  | 'MISSING_TP'
  | 'INVALID_PRICES'
  | 'INVALID_DIRECTION'
  | 'SL_WRONG_SIDE'
  | 'TP_WRONG_SIDE'
  | 'ZERO_RISK_DISTANCE'
  | 'STOP_DISTANCE_NOT_POSITIVE'
  | 'RR_INVALID'
  | 'RR_BELOW_MINIMUM'
  | 'OVERFLOW';

export interface RrInput {
  direction: 'long' | 'short' | string;
  entry: number | null | undefined;
  stopLoss: number | null | undefined;
  takeProfit: number | null | undefined;
  /** Effective minimum (already max'd against the platform ceiling). */
  minRr: number;
}

export interface RrSuccess {
  ok: true;
  rr: DecT;
  riskDistance: DecT;
  rewardDistance: DecT;
  minRr: DecT;
}

export interface RrReject {
  ok: false;
  code: RrFailure;
}

export type RrResult = RrSuccess | RrReject;

function fail(code: RrFailure): RrReject {
  return { ok: false, code };
}

/** Platform-enforced floor: never below PLATFORM_RISK_CEILINGS.minRr. */
export function effectiveMinRr(policyMin: number, strategyMin: number | null): number {
  const floor = PLATFORM_RISK_CEILINGS.minRr;
  const policy = Number.isFinite(policyMin) ? policyMin : floor;
  const strategy = strategyMin !== null && Number.isFinite(strategyMin) ? strategyMin : floor;
  return Math.max(floor, policy, strategy);
}

export function calculateRr(input: RrInput): RrResult {
  try {
    return calculateRrInner(input);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return fail('OVERFLOW');
    throw err;
  }
}

function calculateRrInner(input: RrInput): RrResult {
  if (input.direction !== 'long' && input.direction !== 'short') return fail('INVALID_DIRECTION');
  if (input.stopLoss === null || input.stopLoss === undefined) return fail('MISSING_SL');
  if (input.takeProfit === null || input.takeProfit === undefined) return fail('MISSING_TP');

  const entry = Dec.fromNumber(input.entry as number);
  const sl = Dec.fromNumber(input.stopLoss);
  const tp = Dec.fromNumber(input.takeProfit);
  if (!entry || !sl || !tp) return fail('INVALID_PRICES');
  if (!entry.isPositive || !sl.isPositive || !tp.isPositive) return fail('INVALID_PRICES');

  let risk: DecT;
  let reward: DecT;
  if (input.direction === 'long') {
    if (!sl.lt(entry)) return fail('SL_WRONG_SIDE');
    if (!tp.gt(entry)) return fail('TP_WRONG_SIDE');
    risk = entry.sub(sl);
    reward = tp.sub(entry);
  } else {
    if (!sl.gt(entry)) return fail('SL_WRONG_SIDE');
    if (!tp.lt(entry)) return fail('TP_WRONG_SIDE');
    risk = sl.sub(entry);
    reward = entry.sub(tp);
  }

  if (!risk.isPositive) return fail('ZERO_RISK_DISTANCE');
  if (!reward.isPositive) return fail('RR_INVALID');

  const rr = reward.div(risk);
  if (!rr || !rr.isPositive) return fail('RR_INVALID');

  const min = Dec.fromNumber(input.minRr);
  if (!min || !min.isPositive) return fail('RR_INVALID');
  if (rr.lt(min)) return fail('RR_BELOW_MINIMUM');

  return { ok: true, rr, riskDistance: risk, rewardDistance: reward, minRr: min };
}
