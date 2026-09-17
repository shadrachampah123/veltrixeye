import {
  PAPER_MAX_EVALUATION_CANDLES,
  PAPER_SIMULATOR_VERSION,
  TIMEFRAMES,
  executionDecisionSchema,
  type ExecutionDecisionInput,
  type InstrumentRiskSpec,
  type PaperExitReason,
  type PaperFillType,
  type Timeframe,
} from '@veltrixeye/contracts';
import { Dec, DecimalOverflowError } from '../risk/decimal.js';

/**
 * M8.3 — deterministic paper execution engine (pure).
 *
 * Everything here is a pure function over plain values and the M8.2 fixed-point
 * `Dec` decimal type: no I/O, no clock, no randomness, no floats for money.
 * Given the same decision, market price and cost model, the engine always
 * produces byte-identical fills, positions and P&L. The service layer
 * (`paper-service.ts`) is the only component allowed to persist the results,
 * and only after the server-issued risk decision and every gate has passed.
 *
 * Valuation conventions (identical to the M8.2 sizer, so risk and execution
 * agree on the meaning of a price move):
 *   quote_linear:  money_per_price_unit = quantity × contractSize
 *   base_linear:   money_per_price_unit = quantity × contractSize ÷ price
 *   gross P&L     = (exit − entry) × money_per_price_unit(entry)  [long]
 *                   (entry − exit) × money_per_price_unit(entry)  [short]
 *   fees          = feePipsPerSide × pipSize × money_per_price_unit(entry)
 *   slippage cost = |fill − reference| × money_per_price_unit(reference)
 *
 * Slippage is embedded in the FILL PRICES (so realized P&L already reflects
 * it) and additionally reported as a monetary figure for audit. Fees are
 * charged per side and subtracted from gross P&L to give net P&L.
 */

/* -------------------------------------------------------------------------- */
/* Cost model                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Server-side simulation cost model. M8.3 defaults to a frictionless model
 * (all zeros) so results are exactly reproducible; tests and future
 * deployments may inject non-zero values. It is NEVER client-supplied.
 */
export interface PaperCostModel {
  /** Adverse slippage applied to the entry fill, in pips. */
  entrySlippagePips: number;
  /** Adverse slippage applied to stop/close exits, in pips. */
  exitSlippagePips: number;
  /** Commission charged per side, in pips. */
  feePipsPerSide: number;
}

export const PAPER_COST_MODEL_NONE: PaperCostModel = Object.freeze({
  entrySlippagePips: 0,
  exitSlippagePips: 0,
  feePipsPerSide: 0,
});

/* -------------------------------------------------------------------------- */
/* Value helpers                                                               */
/* -------------------------------------------------------------------------- */

function dec(value: unknown): Dec | null {
  return Dec.fromUnknown(value);
}

/** Money moved by a 1.0 price move, for `quantity` units. Null ⇒ fail closed. */
export function moneyPerPriceUnit(
  spec: InstrumentRiskSpec | null,
  price: Dec,
  quantity: Dec,
): Dec | null {
  if (!spec) return null;
  try {
    const contract = dec(spec.contractSize);
    if (!contract || !contract.isPositive) return null;
    if (!quantity.isPositive) return null;
    const perUnit = quantity.mul(contract);
    if (spec.pnlMode === 'quote_linear') return perUnit;
    if (!price.isPositive) return null;
    return perUnit.div(price);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return null;
    throw err;
  }
}

/** |price| distance in pips, expressed as a price delta. */
export function pipsToPrice(spec: InstrumentRiskSpec | null, pips: number): Dec | null {
  if (!Number.isFinite(pips) || pips < 0) return null;
  if (pips === 0) return Dec.zero();
  const pip = spec ? dec(spec.pipSize) : null;
  if (!pip || !pip.isPositive) return null;
  const p = dec(pips);
  if (!p) return null;
  return pip.mul(p);
}

/** Commission for one side, charged in money. */
export function feeMoney(
  spec: InstrumentRiskSpec | null,
  entryPrice: Dec,
  quantity: Dec,
  feePips: number,
): Dec | null {
  if (!Number.isFinite(feePips) || feePips < 0) return null;
  if (feePips === 0) return Dec.zero();
  const vpu = moneyPerPriceUnit(spec, entryPrice, quantity);
  const delta = pipsToPrice(spec, feePips);
  if (!vpu || !delta) return null;
  try {
    return vpu.mul(delta);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return null;
    throw err;
  }
}

/** Signed monetary value of a price move for `quantity` units. */
export function signedPriceMoveValue(
  spec: InstrumentRiskSpec | null,
  referencePrice: Dec,
  from: Dec,
  to: Dec,
  quantity: Dec,
): Dec | null {
  const vpu = moneyPerPriceUnit(spec, referencePrice, quantity);
  if (!vpu) return null;
  try {
    return to.sub(from).mul(vpu);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return null;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Fills                                                                       */
/* -------------------------------------------------------------------------- */

export interface EntryFillInput {
  direction: 'long' | 'short';
  referencePrice: Dec;
  quantity: Dec;
  spec: InstrumentRiskSpec | null;
  costs: PaperCostModel;
}

export interface FillComputation {
  /** Actual fill price (slippage already applied in the adverse direction). */
  price: Dec;
  /** Monetary cost of the slippage applied (0 when none). */
  slippageCost: Dec;
  fees: Dec;
}

/**
 * Deterministic entry fill: the server market reference moved adversely by the
 * configured entry slippage. A buy pays up, a sell receives less.
 */
export function computeEntryFill(input: EntryFillInput): FillComputation | null {
  if (!input.referencePrice.isPositive) return null;
  const slip = pipsToPrice(input.spec, input.costs.entrySlippagePips);
  if (!slip) return null;
  const price = input.direction === 'long'
    ? input.referencePrice.add(slip)
    : input.referencePrice.sub(slip);
  if (!price.isPositive) return null;
  const slippageCost = signedPriceMoveValue(
    input.spec,
    input.referencePrice,
    input.referencePrice,
    price,
    input.quantity,
  );
  const fees = feeMoney(input.spec, price, input.quantity, input.costs.feePipsPerSide);
  if (!slippageCost || !fees) return null;
  return { price, slippageCost: slippageCost.abs(), fees };
}

export interface ExitFillInput {
  direction: 'long' | 'short';
  reason: PaperExitReason;
  /** Stop-loss / take-profit level (for stop_loss / take_profit exits). */
  level: Dec;
  /** Server market reference used for `close` exits. */
  referencePrice: Dec;
  quantity: Dec;
  spec: InstrumentRiskSpec | null;
  costs: PaperCostModel;
}

/**
 * Deterministic exit fill.
 *  - `stop_loss`  fills AT the stop level, slipped further against the trader
 *    (a stop is a market order in every venue that matters).
 *  - `take_profit` fills AT the target (a resting limit: no adverse slippage).
 *  - `close` fills at the server market reference, slipped adversely.
 */
export function computeExitFill(input: ExitFillInput): FillComputation | null {
  const base = input.reason === 'close' ? input.referencePrice : input.level;
  if (!base.isPositive) return null;

  let price = base;
  if (input.reason !== 'take_profit') {
    const slip = pipsToPrice(input.spec, input.costs.exitSlippagePips);
    if (!slip) return null;
    price = input.direction === 'long' ? base.sub(slip) : base.add(slip);
  }
  if (!price.isPositive) return null;

  const slippageCost = signedPriceMoveValue(
    input.spec,
    base,
    base,
    price,
    input.quantity,
  );
  const fees = feeMoney(input.spec, base, input.quantity, input.costs.feePipsPerSide);
  if (!slippageCost || !fees) return null;
  return { price, slippageCost: slippageCost.abs(), fees };
}

/* -------------------------------------------------------------------------- */
/* P&L                                                                         */
/* -------------------------------------------------------------------------- */

export interface PnlInput {
  direction: 'long' | 'short';
  entryPrice: Dec;
  exitPrice: Dec;
  quantity: Dec;
  spec: InstrumentRiskSpec | null;
}

/** Gross (pre-fee) P&L for a closed position. Null ⇒ fail closed. */
export function grossRealizedPl(input: PnlInput): Dec | null {
  const move = input.direction === 'long'
    ? input.exitPrice.sub(input.entryPrice)
    : input.entryPrice.sub(input.exitPrice);
  return signedPriceMoveValue(input.spec, input.entryPrice, Dec.zero(), move, input.quantity);
}

/** Gross mark-to-market P&L for an open position at `markPrice`. */
export function unrealizedPl(input: PnlInput & { markPrice: Dec }): Dec | null {
  return grossRealizedPl({ ...input, exitPrice: input.markPrice });
}

/** Net realized P&L = gross − entry fees − exit fees. */
export function netRealizedPl(args: {
  gross: Dec;
  entryFees: Dec;
  exitFees: Dec;
}): Dec | null {
  try {
    return args.gross.sub(args.entryFees).sub(args.exitFees);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return null;
    throw err;
  }
}

/** Reward:risk implied by three levels, as a plain ratio (display/audit only). */
export function impliedRr(entry: number, stopLoss: number, takeProfit: number): number | null {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (!(risk > 0) || !Number.isFinite(reward)) return null;
  return reward / risk;
}

/* -------------------------------------------------------------------------- */
/* Market path → SL/TP decisions                                               */
/* -------------------------------------------------------------------------- */

export interface PaperCandle {
  /** epoch ms of the candle open (candles store `ts` as the open time). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ExitDetection {
  reason: 'stop_loss' | 'take_profit';
  level: number;
  candleTime: number;
  /** True when one candle touched BOTH levels (resolved conservatively). */
  conflict: boolean;
  candlesEvaluated: number;
  /** Candles dropped for invalid OHLC (non-positive / inverted). */
  invalidCandles: number;
}

export function isUsableCandle(candle: PaperCandle): boolean {
  return (
    Number.isFinite(candle.time) &&
    candle.time > 0 &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    candle.high > 0 &&
    candle.low > 0 &&
    candle.high >= candle.low
  );
}

/**
 * Walk the supplied candles chronologically and decide whether the stop or the
 * target was reached first. Deterministic and CONSERVATIVE: when a single
 * candle touches both levels the stop wins and `conflict` is reported, so an
 * ambiguous bar can never manufacture a winning trade.
 */
export function detectExit(args: {
  direction: 'long' | 'short';
  stopLossPrice: number;
  takeProfitPrice: number;
  candles: readonly PaperCandle[];
  maxCandles?: number;
}): ExitDetection | null {
  const sl = args.stopLossPrice;
  const tp = args.takeProfitPrice;
  if (!(sl > 0) || !(tp > 0)) return null;

  const limit = Math.min(args.maxCandles ?? PAPER_MAX_EVALUATION_CANDLES, PAPER_MAX_EVALUATION_CANDLES);
  const window = args.candles.slice(0, limit);
  let invalid = 0;
  let evaluated = 0;

  for (const candle of window) {
    if (!isUsableCandle(candle)) {
      invalid += 1;
      continue;
    }
    evaluated += 1;
    const slHit = args.direction === 'long' ? candle.low <= sl : candle.high >= sl;
    const tpHit = args.direction === 'long' ? candle.high >= tp : candle.low <= tp;
    if (slHit && tpHit) {
      return {
        reason: 'stop_loss',
        level: sl,
        candleTime: candle.time,
        conflict: true,
        candlesEvaluated: evaluated,
        invalidCandles: invalid,
      };
    }
    if (slHit) {
      return {
        reason: 'stop_loss',
        level: sl,
        candleTime: candle.time,
        conflict: false,
        candlesEvaluated: evaluated,
        invalidCandles: invalid,
      };
    }
    if (tpHit) {
      return {
        reason: 'take_profit',
        level: tp,
        candleTime: candle.time,
        conflict: false,
        candlesEvaluated: evaluated,
        invalidCandles: invalid,
      };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Identities (deterministic — a retry can never mint a second identity)        */
/* -------------------------------------------------------------------------- */

export type PaperOrderKind = PaperFillType;

/** Client order id for a paper order. Entry ids match M8.1's derivation. */
export function paperClientOrderId(idempotencyHash: string, kind: PaperOrderKind): string {
  if (kind === 'entry') return `ve-${idempotencyHash.slice(0, 24)}`;
  const suffix = kind === 'stop_loss' ? 'sl' : kind === 'take_profit' ? 'tp' : 'cl';
  return `ve-${idempotencyHash.slice(0, 16)}-x-${suffix}`;
}

/** Provider position id for the paper position opened by an entry order. */
export function paperProviderPositionId(idempotencyHash: string): string {
  return `paper-${idempotencyHash.slice(0, 24)}`;
}

/* -------------------------------------------------------------------------- */
/* Server-built execution decision                                             */
/* -------------------------------------------------------------------------- */

/** Setup provenance as read from the database (all values server-side). */
export interface SetupDecisionSource {
  setupId: string;
  strategyId: string;
  strategyVersionId: string;
  assetClass: string;
  symbol: string;
  direction: 'long' | 'short';
  state: string;
  asOfMs: number;
  entryPrice: number | null;
  stopLossPrice: number | null;
  tp1Price: number | null;
  qualityScore: number | null;
  minQualityScore: number | null;
  timeframe: string | null;
}

export type DecisionBuildResult =
  | { ok: true; decision: ExecutionDecisionInput }
  | { ok: false; reason: string };

/**
 * Build the execution decision SERVER-SIDE from a persisted setup.
 *
 * This is the M8.1 "Execution Decision" step: the client never supplies a
 * decision, and every field is either stored on the setup (levels, direction,
 * anchor, quality) or on the frozen version configuration (minimum quality).
 * Anything missing or inconsistent fails closed with a reason — no defaults.
 */
export function buildServerExecutionDecision(src: SetupDecisionSource): DecisionBuildResult {
  if (src.state !== 'confirmed' && src.state !== 'triggered') {
    return { ok: false, reason: `setup state "${src.state}" is not eligible for execution` };
  }
  const entry = src.entryPrice;
  const stop = src.stopLossPrice;
  const target = src.tp1Price;
  if (entry === null || !(entry > 0)) return { ok: false, reason: 'setup has no valid entry price' };
  if (stop === null || !(stop > 0)) return { ok: false, reason: 'setup has no valid stop loss' };
  if (target === null || !(target > 0)) return { ok: false, reason: 'setup has no valid take profit' };
  if (src.qualityScore === null) return { ok: false, reason: 'setup has not been scored' };
  if (src.minQualityScore === null) {
    return { ok: false, reason: 'strategy version has no risk configuration' };
  }
  if (src.qualityScore < src.minQualityScore) {
    return { ok: false, reason: 'setup quality is below the configured minimum' };
  }
  if (!src.timeframe || !(TIMEFRAMES as readonly string[]).includes(src.timeframe)) {
    return { ok: false, reason: 'strategy version has no usable setup timeframe' };
  }
  const rr = impliedRr(entry, stop, target);
  if (rr === null || !(rr > 0)) return { ok: false, reason: 'setup levels imply an invalid reward:risk' };

  const parsed = executionDecisionSchema.safeParse({
    strategyId: src.strategyId,
    strategyVersionId: src.strategyVersionId,
    setupId: src.setupId,
    action: src.direction === 'long' ? 'open_long' : 'open_short',
    assetClass: src.assetClass,
    symbol: src.symbol,
    timeframe: src.timeframe as Timeframe,
    direction: src.direction,
    entryPrice: entry,
    stopLossPrice: stop,
    takeProfitPrice: target,
    expectedRr: rr,
    qualityScore: src.qualityScore,
    minQualityScore: src.minQualityScore,
    asOfMs: src.asOfMs,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, reason: `setup levels do not form a valid execution decision (${detail})` };
  }
  return { ok: true, decision: parsed.data };
}

/** The decision snapshot carried by an EXIT order (same levels, closing action). */
export function exitDecisionSnapshot(entryDecision: ExecutionDecisionInput): ExecutionDecisionInput {
  return { ...entryDecision, action: 'close_position' };
}

/** Simulator version pinned onto every simulated row. */
export const PAPER_SIMULATOR = PAPER_SIMULATOR_VERSION;
