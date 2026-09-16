import type { InstrumentRiskSpec } from '@veltrixeye/contracts';
import { PLATFORM_RISK_CEILINGS } from '@veltrixeye/contracts';
import { Dec, DecimalOverflowError, DEC_HUNDRED, type Dec as DecT } from './decimal.js';

/**
 * Deterministic position sizing (M8.2).
 *
 *   monetary_risk_budget = min(
 *     equity × riskPct / 100,
 *     maxMonetaryRiskPerTrade,          // if configured
 *     remaining daily / weekly / open-risk budgets  // supplied by the engine
 *   )
 *
 *   stop_distance = |entry − stopLoss|            (must be > 0)
 *
 *   quote_linear:  value_per_unit = contractSize × stop_distance
 *   base_linear:   value_per_unit = contractSize × stop_distance / entry
 *
 *   raw_qty = monetary_risk_budget / value_per_unit
 *   qty     = floor(raw_qty onto quantityStep)
 *
 * Fail-closed (never a silent default size) when:
 *  - equity ≤ 0, stop distance ≤ 0, invalid prices
 *  - missing / invalid contract spec
 *  - overflow / underflow
 *  - qty < minQuantity after rounding
 *  - qty > platform maxPositionSize (and the instrument's own max)
 *  - resulting monetary risk still exceeds the budget (should be impossible
 *    after ROUND_DOWN, but checked anyway)
 */

export type SizingFailure =
  | 'ZERO_OR_NEGATIVE_EQUITY'
  | 'INVALID_PRICES'
  | 'STOP_DISTANCE_NOT_POSITIVE'
  | 'MISSING_INSTRUMENT_METADATA'
  | 'INVALID_CONTRACT_SPEC'
  | 'OVERFLOW'
  | 'POSITION_SIZE_UNCOMPUTABLE'
  | 'POSITION_SIZE_BELOW_MINIMUM'
  | 'POSITION_SIZE_EXCEEDS_MAXIMUM'
  | 'MONETARY_RISK_EXCEEDS_LIMIT';

export interface SizingInput {
  equity: DecT;
  riskPct: DecT;
  maxMonetaryRisk: DecT | null;
  extraCaps: readonly DecT[];
  entry: DecT;
  stopLoss: DecT;
  spec: InstrumentRiskSpec | null;
}

export interface SizingSuccess {
  ok: true;
  quantity: DecT;
  monetaryRisk: DecT;
  riskPctOfEquity: DecT;
  stopDistance: DecT;
}

export interface SizingReject {
  ok: false;
  code: SizingFailure;
}

export type SizingResult = SizingSuccess | SizingReject;

function fail(code: SizingFailure): SizingReject {
  return { ok: false, code };
}

export function valuePerUnit(spec: InstrumentRiskSpec, entry: DecT, stopDistance: DecT): DecT | null {
  const contract = Dec.fromNumber(spec.contractSize);
  if (!contract || !contract.isPositive) return null;
  try {
    const product = contract.mul(stopDistance);
    if (spec.pnlMode === 'quote_linear') return product;
    if (!entry.isPositive) return null;
    return product.div(entry);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return null;
    throw err;
  }
}

export function monetaryRiskFor(quantity: DecT, valuePer: DecT): DecT | null {
  try {
    return quantity.mul(valuePer);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return null;
    throw err;
  }
}

export function sizePosition(input: SizingInput): SizingResult {
  try {
    return sizePositionInner(input);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return fail('OVERFLOW');
    throw err;
  }
}

function sizePositionInner(input: SizingInput): SizingResult {
  if (!input.equity.isPositive) return fail('ZERO_OR_NEGATIVE_EQUITY');
  if (!input.entry.isPositive || !input.stopLoss.isPositive) return fail('INVALID_PRICES');

  const stopDistance = input.entry.sub(input.stopLoss).abs();
  if (!stopDistance.isPositive) return fail('STOP_DISTANCE_NOT_POSITIVE');

  const spec = input.spec;
  if (!spec) return fail('MISSING_INSTRUMENT_METADATA');
  if (
    !(spec.contractSize > 0) ||
    !(spec.pipSize > 0) ||
    !(spec.minQuantity > 0) ||
    !(spec.quantityStep > 0) ||
    !(spec.maxQuantity > 0) ||
    spec.maxQuantity < spec.minQuantity
  ) {
    return fail('INVALID_CONTRACT_SPEC');
  }

  const pctBudget = input.equity.mul(input.riskPct).div(DEC_HUNDRED);
  if (!pctBudget) return fail('OVERFLOW');

  let budget = pctBudget;
  if (input.maxMonetaryRisk) {
    if (!input.maxMonetaryRisk.isPositive) return fail('MONETARY_RISK_EXCEEDS_LIMIT');
    budget = budget.min(input.maxMonetaryRisk);
  }
  for (const cap of input.extraCaps) {
    if (cap.isNegative) return fail('MONETARY_RISK_EXCEEDS_LIMIT');
    budget = budget.min(cap);
  }
  if (!budget.isPositive) return fail('MONETARY_RISK_EXCEEDS_LIMIT');

  const vpu = valuePerUnit(spec, input.entry, stopDistance);
  if (!vpu || !vpu.isPositive) return fail('POSITION_SIZE_UNCOMPUTABLE');

  const rawQty = budget.div(vpu, 'down');
  if (!rawQty) return fail('POSITION_SIZE_UNCOMPUTABLE');

  const step = Dec.fromNumber(spec.quantityStep);
  const minQ = Dec.fromNumber(spec.minQuantity);
  const specMax = Dec.fromNumber(spec.maxQuantity);
  const platformMax = Dec.fromNumber(PLATFORM_RISK_CEILINGS.maxPositionSize);
  if (!step || !minQ || !specMax || !platformMax) return fail('INVALID_CONTRACT_SPEC');

  const qty = rawQty.floorToStep(step);
  if (!qty || !qty.isPositive) return fail('POSITION_SIZE_BELOW_MINIMUM');
  if (qty.lt(minQ)) return fail('POSITION_SIZE_BELOW_MINIMUM');

  const maxQ = specMax.min(platformMax);
  if (qty.gt(maxQ)) return fail('POSITION_SIZE_EXCEEDS_MAXIMUM');

  const risk = monetaryRiskFor(qty, vpu);
  if (!risk) return fail('OVERFLOW');
  if (risk.gt(budget)) return fail('MONETARY_RISK_EXCEEDS_LIMIT');

  const riskPctOfEquity = risk.div(input.equity)!.mul(DEC_HUNDRED);
  return {
    ok: true,
    quantity: qty,
    monetaryRisk: risk,
    riskPctOfEquity,
    stopDistance,
  };
}
