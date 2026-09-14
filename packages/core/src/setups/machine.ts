import { SETUP_TERMINAL_STATES, SETUP_TRANSITIONS, type SetupState } from '@veltrixeye/contracts';
import { Errors } from '../errors.js';

/**
 * M4 setup state machine (pure logic — no I/O, no clock).
 *
 * The transition table itself lives in contracts (`SETUP_TRANSITIONS`) so
 * the API and core layers can never disagree; this module is the single
 * validator every transition path must call before writing.
 */
export function isTerminalState(state: SetupState): boolean {
  return (SETUP_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * Return the allowed outbound transitions for `from`.
 * Terminal states allow none; repeats are handled by the caller as
 * idempotent no-ops (a same-state "transition" never reaches this check).
 */
export function allowedTransitions(from: SetupState): readonly SetupState[] {
  return SETUP_TRANSITIONS[from] ?? [];
}

/**
 * Throw `invalid_input` unless `to` is a legal outbound transition from
 * `from`. Same-state repeats must be short-circuited by the caller BEFORE
 * calling this (they are idempotent successes, not transitions).
 */
export function assertTransition(from: SetupState, to: SetupState): void {
  if (from === to) {
    throw Errors.invalidInput(
      `Setup is already in state "${from}" — repeat the request for an idempotent no-op.`,
    );
  }
  if (!allowedTransitions(from).includes(to)) {
    const allowed = allowedTransitions(from);
    throw Errors.invalidInput(
      allowed.length === 0
        ? `Setup is in terminal state "${from}" and cannot transition to "${to}".`
        : `Cannot transition setup from "${from}" to "${to}". Allowed: ${allowed.join(', ')}.`,
    );
  }
}
