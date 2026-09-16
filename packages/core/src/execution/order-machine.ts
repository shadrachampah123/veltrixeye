import {
  ORDER_STATUSES,
  ORDER_TERMINAL_STATUSES,
  type OrderStatus,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';

/**
 * M8.1 — order lifecycle state machine (pure).
 *
 * Mirrors the M4 setup-lifecycle pattern: an explicit transition table, a
 * validator that throws on anything illegal, terminal states absorbing.
 * M8.1 defines and TESTS the machine; a future executor (M8.2+) is the only
 * component that will ever drive transitions, and it must call
 * `assertOrderTransition` before persisting one.
 *
 *   requested → validating → submitted → accepted → partially_filled → filled
 *       ↘ rejected/failed/cancelled at pre-submission stages
 *                       ↘ rejected/cancelled/expired/failed after submission
 * Terminal: filled, rejected, cancelled, expired, failed (no exits).
 */
const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  requested: ['validating', 'rejected', 'failed', 'cancelled'],
  validating: ['submitted', 'rejected', 'failed', 'cancelled'],
  submitted: ['accepted', 'rejected', 'cancelled', 'expired', 'failed'],
  accepted: ['partially_filled', 'filled', 'cancelled', 'expired', 'failed'],
  partially_filled: ['partially_filled', 'filled', 'cancelled', 'expired', 'failed'],
  filled: [],
  rejected: [],
  cancelled: [],
  expired: [],
  failed: [],
};

/** All statuses a given state may legally move to (terminal ⇒ none). */
export function allowedOrderTransitions(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_TRANSITIONS[from];
}

/** Whether a transition is legal without throwing. */
export function isOrderTransitionAllowed(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isOrderTerminal(value: OrderStatus): boolean {
  return (ORDER_TERMINAL_STATUSES as readonly string[]).includes(value);
}

/**
 * Validate a transition, throwing a domain error when it is illegal.
 * Same-state repeats are rejected UNLESS the table explicitly allows them:
 * only `partially_filled → partially_filled` qualifies (a progressive fill
 * changes quantity while staying in-state). Every other repeat is a caller
 * no-op, never a stored event (matches M4 semantics).
 */
export function assertOrderTransition(from: OrderStatus, to: OrderStatus): void {
  if (!isOrderStatus(from)) throw Errors.invalidInput(`Unknown order status "${from}"`);
  if (!isOrderStatus(to)) throw Errors.invalidInput(`Unknown order status "${to}"`);
  if (from === to && !isOrderTransitionAllowed(from, to)) {
    throw Errors.invalidInput(`Order is already in status "${from}" — repeats are caller no-ops`);
  }
  if (isOrderTerminal(from)) {
    throw Errors.invalidInput(`Cannot transition order from terminal status "${from}" to "${to}"`);
  }
  if (!isOrderTransitionAllowed(from, to)) {
    const allowed = ORDER_TRANSITIONS[from].join(', ');
    throw Errors.invalidInput(
      `Cannot transition order from "${from}" to "${to}". Allowed: ${allowed}`,
    );
  }
}
