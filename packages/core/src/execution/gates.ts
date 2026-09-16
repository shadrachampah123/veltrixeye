import {
  EXECUTION_GATE_IDS,
  type ExecutionDecisionInput,
  type ExecutionGateId,
  type ExecutionMode,
} from '@veltrixeye/contracts';
import type { Entitlements } from '../billing/entitlements.js';

/**
 * M8.1 — the safety gate contract.
 *
 * `evaluateExecutionGates` is the single authoritative checklist an execution
 * attempt must pass. It is pure, ordered, and FAIL-CLOSED: evaluation stops
 * at the first gate that cannot be proven satisfied, and anything UNKNOWN is
 * treated as failing (missing decision, missing risk decision, unknown
 * provider health, unevaluated exposure). A future executor may persist an
 * order ONLY when this function returns `passed: true`.
 *
 * All inputs are server-produced (session identity, entitlement rows,
 * DB-resolved setup/profile, risk engine output). Nothing here reads raw
 * client input — the decision arrives pre-validated from the intake service.
 */

/** Setup states that may produce an execution (same eligibility as alerts). */
const EXECUTION_ELIGIBLE_SETUP_STATES = new Set(['confirmed', 'triggered']);

export interface ExecutionGateInput {
  /** Gate 1 — session authenticated (set by the API layer from the session). */
  authenticated: boolean;
  /** Gate 2 — the acting user owns the setup/profile in question. */
  authorized: boolean;
  /** Gate 3 — subscription entitlement. */
  entitlements: Entitlements;
  /** Gate 4 — explicit automation state (entitled AND switch ON). */
  automation: { entitled: boolean; automationEnabled: boolean };
  /** Gate 5 — the execution profile the attempt targets. */
  profile: { enabled: boolean; environment: ExecutionMode } | null;
  /** Gate 6 — kill-switch state across every applicable scope. */
  killSwitches: { global: boolean; user: boolean; strategy: boolean; profile: boolean };
  /** Gate 7/9–13 — the parsed decision + the DB-resolved setup it cites. */
  decision: ExecutionDecisionInput | null;
  setup: { id: string; direction: 'long' | 'short'; state: string } | null;
  /** The platform knows the decision's instrument (universe membership). */
  instrumentKnown: boolean;
  /** Gate 8 — the M8.2 risk engine's verdict. null ⇔ not produced ⇒ fail. */
  riskDecision: { approved: boolean; reason?: string } | null;
  /** The version's configured minimum RR (null ⇒ platform default 1:2). */
  minRr: number | null;
  /** Gate 14 — exposure verdict. null ⇔ not evaluated yet ⇒ fail-closed. */
  exposureWithinLimits: boolean | null;
  /** Gate 15 — provider health. null ⇔ unknown ⇒ fail-closed. */
  providerHealth: { healthy: boolean } | null;
}

export interface ExecutionGateResult {
  passed: boolean;
  /** First failing gate in pinned order; null when all pass. */
  failedGate: ExecutionGateId | null;
  reason: string | null;
  /** Gates evaluated before stopping (inclusive of the failing one). */
  evaluated: ExecutionGateId[];
}

/** Platform default minimum RR (matches the strategy risk foundation). */
const DEFAULT_MIN_RR = 2;

export function evaluateExecutionGates(input: ExecutionGateInput): ExecutionGateResult {
  const evaluated: ExecutionGateId[] = [];
  const fail = (gate: ExecutionGateId, reason: string): ExecutionGateResult => {
    evaluated.push(gate);
    return { passed: false, failedGate: gate, reason, evaluated };
  };

  for (const gate of EXECUTION_GATE_IDS) {
    switch (gate) {
      case 'authenticated':
        if (!input.authenticated) return fail(gate, 'authentication required');
        break;
      case 'authorized':
        if (!input.authorized) return fail(gate, 'caller does not own the referenced resources');
        break;
      case 'entitlement':
        if (!input.entitlements.canAccessAutomation) {
          return fail(gate, 'subscription plan does not include automation');
        }
        break;
      case 'automation_on':
        if (!input.automation.entitled || !input.automation.automationEnabled) {
          return fail(gate, 'automation is OFF (entitlement and explicit switch are both required)');
        }
        break;
      case 'profile_enabled': {
        if (!input.profile) return fail(gate, 'execution profile not found');
        if (!input.profile.enabled) return fail(gate, 'execution profile is disabled');
        if (input.profile.environment !== 'paper') {
          return fail(gate, `execution environment "${input.profile.environment}" is not permitted in this platform version`);
        }
        break;
      }
      case 'kill_switch': {
        const ks = input.killSwitches;
        if (ks.global) return fail(gate, 'global kill switch is active');
        if (ks.user) return fail(gate, 'user kill switch is active');
        if (ks.strategy) return fail(gate, 'strategy kill switch is active');
        if (ks.profile) return fail(gate, 'execution profile kill switch is active');
        break;
      }
      case 'valid_signal': {
        const d = input.decision;
        const s = input.setup;
        if (!d) return fail(gate, 'no validated execution decision present');
        if (!s) return fail(gate, 'setup referenced by the decision was not found');
        if (s.id !== d.setupId) return fail(gate, 'decision does not reference the resolved setup');
        if (!EXECUTION_ELIGIBLE_SETUP_STATES.has(s.state)) {
          return fail(gate, `setup state "${s.state}" is not eligible for execution`);
        }
        if (s.direction !== d.direction) {
          return fail(gate, 'decision direction conflicts with the setup direction');
        }
        if (d.qualityScore < d.minQualityScore) {
          return fail(gate, 'setup quality is below the configured minimum');
        }
        break;
      }
      case 'risk_decision': {
        if (!input.riskDecision) {
          return fail(gate, 'no risk decision available (risk engine required before execution)');
        }
        if (!input.riskDecision.approved) {
          return fail(gate, input.riskDecision.reason ?? 'risk decision rejected the execution');
        }
        break;
      }
      case 'valid_symbol':
        if (!input.instrumentKnown) {
          return fail(gate, 'symbol is not in the platform market universe');
        }
        break;
      case 'valid_order_params': {
        const d = input.decision;
        if (!d) return fail(gate, 'no validated execution decision present');
        // M8.1: entry/SL/TP positivity + anchor sanity (quantity sizing is
        // M8.2 territory and will extend this gate, not bypass it).
        if (!(d.entryPrice > 0) || !(d.stopLossPrice > 0) || !(d.takeProfitPrice > 0)) {
          return fail(gate, 'order price parameters must be positive');
        }
        if (!(d.asOfMs > 0)) return fail(gate, 'decision anchor is invalid');
        break;
      }
      case 'valid_stop_loss': {
        const d = input.decision;
        if (!d) return fail(gate, 'no validated execution decision present');
        const ok =
          d.direction === 'long'
            ? d.stopLossPrice < d.entryPrice
            : d.stopLossPrice > d.entryPrice;
        if (!ok) return fail(gate, 'stop loss does not protect the entry for this direction');
        break;
      }
      case 'valid_take_profit': {
        const d = input.decision;
        if (!d) return fail(gate, 'no validated execution decision present');
        const ok =
          d.direction === 'long'
            ? d.takeProfitPrice > d.entryPrice
            : d.takeProfitPrice < d.entryPrice;
        if (!ok) return fail(gate, 'take profit does not reward the entry for this direction');
        break;
      }
      case 'acceptable_rr': {
        const d = input.decision;
        if (!d) return fail(gate, 'no validated execution decision present');
        const minRr = input.minRr ?? DEFAULT_MIN_RR;
        const risk = Math.abs(d.entryPrice - d.stopLossPrice);
        const reward = Math.abs(d.takeProfitPrice - d.entryPrice);
        const achievable = risk > 0 ? reward / risk : 0;
        if (d.expectedRr < minRr || achievable + 1e-9 < d.expectedRr) {
          return fail(gate, `risk:reward ${d.expectedRr.toFixed(2)} does not meet the required ${minRr}`);
        }
        break;
      }
      case 'exposure_limits':
        if (input.exposureWithinLimits === null) {
          return fail(gate, 'exposure limits have not been evaluated');
        }
        if (!input.exposureWithinLimits) {
          return fail(gate, 'exposure limits would be exceeded');
        }
        break;
      case 'provider_healthy':
        if (input.providerHealth === null) {
          return fail(gate, 'provider health is unknown');
        }
        if (!input.providerHealth.healthy) {
          return fail(gate, 'execution provider is not healthy');
        }
        break;
    }
    evaluated.push(gate);
  }

  return { passed: true, failedGate: null, reason: null, evaluated };
}
