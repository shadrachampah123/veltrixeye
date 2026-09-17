import type { InstrumentRiskSpec, PaperReconciliationFinding } from '@veltrixeye/contracts';
import { Dec, DecimalOverflowError } from '../risk/decimal.js';

/**
 * M8.3 — simulator-side reconciliation (the M8.5 foundation).
 *
 * Pure functions comparing the EXPECTED order/position state (derived from the
 * orders + append-only fill ledger) with the ACTUAL persisted rows, plus the
 * structural invariants that must never hold in a correct simulator.
 *
 * Two rules dominate:
 *  1. NO SILENT CORRECTION. Findings are reported, never "fixed" — the caller
 *     fails closed (it refuses the write / rolls the transaction back) and
 *     records the finding in the append-only reconciliation trail.
 *  2. IMPOSSIBLE STATES ARE FINDINGS, not tolerated quirks: a filled order
 *     whose fills do not sum to its quantity, an open position carrying exit
 *     data, a closed position without an exit price, a cross-tenant link, a
 *     duplicate exit fill, or realized P&L that does not equal the
 *     entry/exit/quantity/fee arithmetic.
 *
 * This is deliberately NOT the full M8.5 subsystem: it is synchronous,
 * simulator-scoped (paper orders/positions only) and never talks to a broker.
 */

export interface ReconciliationOrderState {
  id: string;
  userId: string;
  executionProfileId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  filledQuantity: string;
  averageFillPrice: string | null;
  status: string;
  rejectReason: string | null;
  simulated: boolean;
}

export interface ReconciliationFillState {
  orderId: string;
  positionId: string | null;
  userId: string;
  executionProfileId: string;
  sequence: number;
  fillType: string;
  quantity: string;
  price: string;
  fees: string;
  slippage: string;
}

export interface ReconciliationPositionState {
  id: string;
  userId: string;
  executionProfileId: string;
  symbol: string;
  direction: 'long' | 'short';
  quantity: string;
  averageEntryPrice: string;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  exitPrice: string | null;
  exitReason: string | null;
  realizedPl: string | null;
  status: string;
  closedAt: Date | null;
  openedByOrderId: string | null;
  closedByOrderId: string | null;
  simulated: boolean;
}

export interface ReconciliationResult {
  findings: PaperReconciliationFinding[];
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
}

const num = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

export function reconcileOrderState(args: {
  order: ReconciliationOrderState;
  fills: readonly ReconciliationFillState[];
}): ReconciliationResult {
  const findings: PaperReconciliationFinding[] = [];
  const { order } = args;
  const orderFills = args.fills.filter((f) => f.orderId === order.id);

  const filled = num(order.filledQuantity);
  const quantity = num(order.quantity);
  const fillSum = orderFills.reduce((acc, f) => acc + (num(f.quantity) ?? 0), 0);

  const expected = {
    quantity,
    filledQuantity: filled,
    status: filled !== null && quantity !== null && filled === quantity ? 'filled' : order.status,
    fillCount: orderFills.length,
    fillQuantitySum: fillSum,
    averageFillPrice: order.averageFillPrice,
  };
  const actual = {
    quantity,
    filledQuantity: filled,
    status: order.status,
    fillCount: orderFills.length,
    fillQuantitySum: fillSum,
    averageFillPrice: order.averageFillPrice,
  };

  // Cross-tenant / cross-profile links in the fill ledger are impossible.
  for (const fill of orderFills) {
    if (fill.userId !== order.userId || fill.executionProfileId !== order.executionProfileId) {
      findings.push('position_order_tenant_mismatch');
      break;
    }
  }

  // The ledger must explain the row exactly.
  if (filled !== null && Math.abs(fillSum - filled) > 1e-9) {
    findings.push('fill_ledger_sum_mismatch');
  }
  if (quantity !== null && fillSum - quantity > 1e-9) {
    findings.push('order_fill_exceeds_quantity');
  }
  if (quantity !== null && filled !== null && filled - quantity > 1e-9) {
    findings.push('order_fill_quantity_mismatch');
  }

  const filledLike = order.status === 'filled' || order.status === 'partially_filled';
  if (filledLike && orderFills.length === 0) {
    findings.push('order_filled_but_no_fill_row');
  }
  if (order.status === 'filled' && order.averageFillPrice === null) {
    findings.push('order_filled_without_price');
  }
  if (
    order.status === 'filled' &&
    quantity !== null &&
    filled !== null &&
    Math.abs(filled - quantity) > 1e-9
  ) {
    findings.push('order_fill_quantity_mismatch');
  }
  if (
    (order.status === 'failed' || order.status === 'rejected') &&
    (order.rejectReason === null || order.rejectReason.length === 0)
  ) {
    findings.push('order_terminal_without_reason');
  }
  if (filled !== null && filled > 0 && order.status !== 'filled' && order.status !== 'partially_filled') {
    findings.push('order_fill_quantity_mismatch');
  }
  if (
    order.simulated &&
    orderFills.length > 0 &&
    orderFills.some((f) => f.sequence < 1)
  ) {
    findings.push('fill_ledger_sum_mismatch');
  }

  return { findings: dedupe(findings), expected, actual };
}

/* -------------------------------------------------------------------------- */
/* Positions                                                                   */
/* -------------------------------------------------------------------------- */

export function reconcilePositionState(args: {
  position: ReconciliationPositionState;
  openingOrder: ReconciliationOrderState | null;
  closingOrder: ReconciliationOrderState | null;
  fills: readonly ReconciliationFillState[];
  spec: InstrumentRiskSpec | null;
}): ReconciliationResult {
  const findings: PaperReconciliationFinding[] = [];
  const { position, openingOrder, closingOrder } = args;
  const positionFills = args.fills.filter((f) => f.positionId === position.id);
  const exitFills = positionFills.filter((f) => f.fillType !== 'entry');
  const entryFills = positionFills.filter((f) => f.fillType === 'entry');

  const quantity = num(position.quantity);
  const entryPrice = num(position.averageEntryPrice);
  const exitPrice = num(position.exitPrice);
  const realizedPl = num(position.realizedPl);
  const fees = positionFills.reduce((acc, f) => acc + (num(f.fees) ?? 0), 0);

  const expectedPl = computeExpectedNetPl({
    direction: position.direction,
    quantity,
    entryPrice,
    exitPrice,
    spec: args.spec,
    fees,
  });

  const expected = {
    status: exitPrice !== null ? 'closed' : 'open',
    quantity,
    averageEntryPrice: entryPrice,
    exitPrice,
    exitReason: position.exitReason,
    realizedPl: expectedPl,
    entryFillCount: entryFills.length,
    exitFillCount: exitFills.length,
    fees,
  };
  const actual = {
    status: position.status,
    quantity,
    averageEntryPrice: entryPrice,
    exitPrice,
    exitReason: position.exitReason,
    realizedPl,
    entryFillCount: entryFills.length,
    exitFillCount: exitFills.length,
    fees,
  };

  if (quantity === null || !(quantity > 0)) findings.push('position_quantity_not_positive');
  if (entryPrice === null || !(entryPrice > 0)) findings.push('position_entry_price_invalid');

  if (position.status === 'open') {
    if (position.exitPrice !== null || position.exitReason !== null) {
      findings.push('position_open_with_exit_data');
    }
    if (position.closedAt !== null) findings.push('position_open_with_exit_data');
    if (position.openedByOrderId === null) findings.push('position_open_without_order');
  } else if (position.status === 'closed') {
    if (position.exitPrice === null) findings.push('position_closed_without_exit_price');
    if (position.realizedPl === null) findings.push('position_closed_without_realized_pl');
    if (position.exitReason === null) findings.push('position_closed_without_exit_price');
  }

  if (exitFills.length > 1) findings.push('position_duplicate_exit_fills');
  if (positionFills.length > 0 && entryFills.length !== 1) {
    findings.push('position_open_without_order');
  }
  if (position.openedByOrderId === null && position.status === 'open') {
    findings.push('position_metadata_missing');
  }

  if (openingOrder) {
    if (openingOrder.userId !== position.userId || openingOrder.executionProfileId !== position.executionProfileId) {
      findings.push('position_order_tenant_mismatch');
    }
    if (openingOrder.symbol !== position.symbol) {
      findings.push('position_symbol_conflicts_with_order');
    }
    const expectedDirection = openingOrder.side === 'buy' ? 'long' : 'short';
    if (openingOrder.side !== undefined && position.direction !== expectedDirection) {
      findings.push('position_direction_conflicts_with_order');
    }
  }
  if (closingOrder && closingOrder.symbol !== position.symbol) {
    findings.push('position_symbol_conflicts_with_order');
  }

  // Realized P&L must equal the entry/exit/quantity/fee arithmetic exactly.
  if (
    position.status === 'closed' &&
    expectedPl !== null &&
    realizedPl !== null &&
    Math.abs(expectedPl - realizedPl) > 1e-6
  ) {
    findings.push('position_realized_pl_mismatch');
  }

  return { findings: dedupe(findings), expected, actual };
}

/** Expected NET realized P&L in money, or null when it cannot be computed. */
export function computeExpectedNetPl(args: {
  direction: 'long' | 'short';
  quantity: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  spec: InstrumentRiskSpec | null;
  fees: number;
}): number | null {
  const { direction, quantity, entryPrice, exitPrice, spec } = args;
  if (!spec || quantity === null || entryPrice === null || exitPrice === null) return null;
  if (!(quantity > 0) || !(entryPrice > 0) || !(exitPrice > 0)) return null;
  const qty = Dec.fromNumber(quantity);
  const contract = Dec.fromNumber(spec.contractSize);
  const entry = Dec.fromNumber(entryPrice);
  const exit = Dec.fromNumber(exitPrice);
  if (!qty || !contract || !entry || !exit) return null;
  try {
    const move = direction === 'long' ? exit.sub(entry) : entry.sub(exit);
    const perUnit = spec.pnlMode === 'quote_linear' ? qty.mul(contract) : qty.mul(contract).div(entry);
    if (!perUnit) return null;
    const gross = move.mul(perUnit);
    const feeDec = Dec.fromNumber(args.fees);
    if (!feeDec) return null;
    return gross.sub(feeDec).toNumber(10);
  } catch (err) {
    if (err instanceof DecimalOverflowError) return null;
    throw err;
  }
}

function dedupe(findings: PaperReconciliationFinding[]): PaperReconciliationFinding[] {
  return [...new Set(findings)];
}
