import {
  PAPER_SIMULATION_GATE_IDS,
  PLATFORM_RISK_CEILINGS,
  RISK_ENGINE_VERSION,
  type ExecutionDecisionInput,
  type InstrumentRiskSpec,
  type PaperSimulationGateId,
} from '@veltrixeye/contracts';
import { Dec } from '../risk/decimal.js';
import { resolveExecutionReadiness } from './readiness.js';

/**
 * M8.3 — paper simulation gates (pure, ordered, fail-closed).
 *
 * This is the checklist a *user-initiated paper simulation* must pass before
 * the simulator may create an order. It is a separate pinned list from the
 * M8.1 `EXECUTION_GATE_IDS` on purpose:
 *
 *  - M8.1's gates govern the AUTOMATED path (scanner → decision → intake →
 *    provider). They are untouched, and because `canAccessAutomation` is false
 *    for every plan the automated path cannot produce an order. Nothing here
 *    weakens them.
 *  - Paper simulation is not automation: it is an explicit, single-shot,
 *    user-requested simulation of a server-issued decision. It therefore
 *    carries its own gates — but every gate that protects money, provenance
 *    and tenant isolation is enforced identically (kill switch, server-issued
 *    risk decision, position size, SL/TP, RR, exposure, market-data freshness).
 *
 * Anything UNKNOWN fails: a missing profile, an unknown provider health, a
 * risk decision without `decisionId`/`engineVersion`, a null exposure verdict
 * or a missing market price all refuse the simulation. Evaluation stops at the
 * first failing gate, exactly like the M8.1 gate service.
 */

export interface PaperSimulationGateInput {
  /** Gate 1 — session authenticated (enforced by the API layer). */
  authenticated: boolean;
  /** Gate 2 — the caller owns the setup and the execution profile (DB-proven). */
  authorized: boolean;
  /** Gate 3 — the target profile: paper only, enabled. */
  profile: { enabled: boolean; environment: string } | null;
  /** Gate 4 — kill switches in every applicable scope. */
  killSwitches: { global: boolean; user: boolean; strategy: boolean; profile: boolean };
  /** Gate 5 — the internal simulator reports itself ready. */
  providerHealth: { healthy: boolean; configured: boolean } | null;
  /** Gate 6/11-13 — the server-built decision + the DB-resolved setup. */
  decision: ExecutionDecisionInput | null;
  setup: { id: string; direction: 'long' | 'short'; state: string } | null;
  /**
   * Gate 7/8 — the M8.2 verdict. It MUST be a persisted, server-issued row:
   * `decisionId` + the pinned `engineVersion` are required before `approved`
   * is even consulted, so a forged `{ approved: true }` cannot pass.
   */
  riskDecision: {
    outcome: 'approved' | 'rejected';
    reason?: string | null;
    decisionId: string | null;
    engineVersion: string | null;
    positionSize: number | null;
    rr: number | null;
    exposureWithinLimits: boolean | null;
  } | null;
  /** The effective minimum RR the risk engine applied (null ⇒ platform floor). */
  effectiveMinRr: number | null;
  /** Gate 9/10 — the instrument contract spec used to validate the size. */
  instrumentSpec: InstrumentRiskSpec | null;
  /** Gate 12/13/14 reference price: the fill price the simulation would use. */
  fillPrice: number | null;
  /** Gate 11 — freshness of the server market data behind `fillPrice`. */
  marketPrice: { price: number; ageMs: number; thresholdMs: number } | null;
  /**
   * Why the server market interface has no usable price (missing candle,
   * malformed data, stale, future timestamp). The interface is the authority;
   * the gate never invents a reason of its own.
   */
  marketPriceError?: string | null;
}

export interface PaperSimulationGateResult {
  passed: boolean;
  failedGate: PaperSimulationGateId | null;
  reason: string | null;
  evaluated: PaperSimulationGateId[];
}

/** Reward:risk implied by the actual fill price (not the intended entry). */
function fillRr(fill: number, stop: number, target: number): number | null {
  const risk = Math.abs(fill - stop);
  const reward = Math.abs(target - fill);
  if (!(risk > 0) || !Number.isFinite(reward)) return null;
  return reward / risk;
}

export function evaluatePaperSimulationGates(
  input: PaperSimulationGateInput,
): PaperSimulationGateResult {
  const evaluated: PaperSimulationGateId[] = [];
  const fail = (gate: PaperSimulationGateId, reason: string): PaperSimulationGateResult => {
    evaluated.push(gate);
    return { passed: false, failedGate: gate, reason, evaluated };
  };

  for (const gate of PAPER_SIMULATION_GATE_IDS) {
    switch (gate) {
      case 'authenticated':
        if (!input.authenticated) return fail(gate, 'authentication required');
        break;

      case 'authorized':
        if (!input.authorized) {
          return fail(gate, 'caller does not own the referenced setup or execution profile');
        }
        break;

      case 'paper_profile': {
        const p = input.profile;
        if (!p) return fail(gate, 'execution profile not found');
        if (!p.enabled) return fail(gate, 'execution profile is disabled');
        // M8.3 is paper-only. `demo`/`live` remain impossible end to end.
        if (p.environment !== 'paper') {
          return fail(gate, `execution environment "${p.environment}" is not permitted`);
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

      case 'provider_ready': {
        // Gate 9 §7/§26 (B5, R7.4.4): same resolver as the health path. The
        // simulator is only "ready" when each declared condition is the strict
        // boolean `true`; truthy junk, missing fields and provider strings are
        // refusals, not green lights.
        const health = input.providerHealth;
        if (health === null) return fail(gate, 'paper simulator health is unknown');
        const { decision, flags } = resolveExecutionReadiness(health, 'paperGateHealth');
        if (decision.code === 'health_not_an_object' || decision.code === 'health_malformed') {
          return fail(gate, 'paper simulator health is malformed');
        }
        if (!flags.configured) return fail(gate, 'paper simulator is not configured');
        if (!decision.ready) return fail(gate, 'paper simulator is not healthy');
        break;
      }

      case 'valid_signal': {
        const d = input.decision;
        const s = input.setup;
        if (!d) return fail(gate, 'no server-issued execution decision available');
        if (!s) return fail(gate, 'setup referenced by the decision was not found');
        if (s.id !== d.setupId) return fail(gate, 'decision does not reference the resolved setup');
        if (s.state !== 'confirmed' && s.state !== 'triggered') {
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

      case 'risk_decision_issued': {
        const r = input.riskDecision;
        if (!r) return fail(gate, 'no server-issued risk decision available');
        if (!r.decisionId) return fail(gate, 'risk decision id is missing');
        if (!r.engineVersion) return fail(gate, 'risk decision engine version is missing');
        if (r.engineVersion !== RISK_ENGINE_VERSION) {
          return fail(gate, `risk engine version "${r.engineVersion}" is not recognized`);
        }
        break;
      }

      case 'risk_approved': {
        const r = input.riskDecision;
        if (!r) return fail(gate, 'no server-issued risk decision available');
        if (r.outcome !== 'approved') {
          return fail(gate, r.reason ?? 'risk decision rejected the simulation');
        }
        break;
      }

      case 'valid_position_size': {
        const r = input.riskDecision;
        if (!r) return fail(gate, 'no server-issued risk decision available');
        const size = r.positionSize;
        if (size === null || !Number.isFinite(size) || !(size > 0)) {
          return fail(gate, 'risk decision carries no usable position size');
        }
        const spec = input.instrumentSpec;
        if (!spec) return fail(gate, 'instrument risk specification is unavailable');
        const qty = Dec.fromNumber(size);
        const step = Dec.fromNumber(spec.quantityStep);
        const min = Dec.fromNumber(spec.minQuantity);
        const specMax = Dec.fromNumber(spec.maxQuantity);
        const platformMax = Dec.fromNumber(PLATFORM_RISK_CEILINGS.maxPositionSize);
        if (!qty || !step || !min || !specMax || !platformMax) {
          return fail(gate, 'instrument risk specification is invalid');
        }
        if (qty.lt(min)) return fail(gate, 'position size is below the instrument minimum');
        const max = specMax.min(platformMax);
        if (qty.gt(max)) return fail(gate, 'position size exceeds the permitted maximum');
        const onStep = qty.floorToStep(step);
        if (!onStep || !onStep.eq(qty)) {
          return fail(gate, 'position size is not aligned to the instrument quantity step');
        }
        break;
      }

      case 'valid_symbol':
        if (!input.instrumentSpec) {
          return fail(gate, 'symbol is not in the platform market universe');
        }
        break;

      case 'valid_order_params': {
        const d = input.decision;
        if (!d) return fail(gate, 'no server-issued execution decision available');
        if (!(d.entryPrice > 0) || !(d.stopLossPrice > 0) || !(d.takeProfitPrice > 0)) {
          return fail(gate, 'order price parameters must be positive');
        }
        if (!(d.asOfMs > 0)) return fail(gate, 'decision anchor is invalid');
        const fill = input.fillPrice;
        if (fill === null || !Number.isFinite(fill) || !(fill > 0)) {
          return fail(gate, 'a positive server market price is required');
        }
        break;
      }

      case 'valid_stop_loss': {
        const d = input.decision;
        const fill = input.fillPrice;
        if (!d || fill === null) return fail(gate, 'no server-issued execution decision available');
        const ok = d.direction === 'long' ? d.stopLossPrice < fill : d.stopLossPrice > fill;
        if (!ok) {
          return fail(gate, 'stop loss does not protect the entry for this direction at the fill price');
        }
        break;
      }

      case 'valid_take_profit': {
        const d = input.decision;
        const fill = input.fillPrice;
        if (!d || fill === null) return fail(gate, 'no server-issued execution decision available');
        const ok = d.direction === 'long' ? d.takeProfitPrice > fill : d.takeProfitPrice < fill;
        if (!ok) {
          return fail(gate, 'take profit does not reward the entry for this direction at the fill price');
        }
        break;
      }

      case 'acceptable_rr': {
        const d = input.decision;
        const fill = input.fillPrice;
        if (!d || fill === null) return fail(gate, 'no server-issued execution decision available');
        const minRr = Math.max(input.effectiveMinRr ?? PLATFORM_RISK_CEILINGS.minRr, PLATFORM_RISK_CEILINGS.minRr);
        const rr = fillRr(fill, d.stopLossPrice, d.takeProfitPrice);
        if (rr === null) return fail(gate, 'reward:risk could not be computed from the levels');
        if (rr + 1e-9 < minRr) {
          return fail(
            gate,
            `risk:reward ${rr.toFixed(2)} at the fill price does not meet the required ${minRr}`,
          );
        }
        break;
      }

      case 'exposure_limits': {
        const r = input.riskDecision;
        if (!r) return fail(gate, 'no server-issued risk decision available');
        if (r.exposureWithinLimits === null) {
          return fail(gate, 'exposure limits have not been evaluated');
        }
        if (!r.exposureWithinLimits) return fail(gate, 'exposure limits would be exceeded');
        break;
      }

      case 'market_price_fresh': {
        const m = input.marketPrice;
        if (!m) {
          return fail(
            gate,
            input.marketPriceError ?? 'no server market data is available for this instrument',
          );
        }
        if (!Number.isFinite(m.price) || !(m.price > 0)) {
          return fail(gate, 'server market price is not a positive finite number');
        }
        if (!Number.isFinite(m.ageMs) || m.ageMs < 0) {
          return fail(gate, 'server market data timestamp is in the future (clock skew)');
        }
        if (m.ageMs > m.thresholdMs) {
          return fail(
            gate,
            `server market data is stale (${Math.round(m.ageMs / 1000)}s old, limit ${Math.round(m.thresholdMs / 1000)}s)`,
          );
        }
        break;
      }
    }
    evaluated.push(gate);
  }

  return { passed: true, failedGate: null, reason: null, evaluated };
}
