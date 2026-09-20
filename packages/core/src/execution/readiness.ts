import {
  readBridgeHealthFlags,
  resolveBridgeReadiness,
  type BridgeReadinessDecision,
  type BridgeHealthFlags,
  type TransportReadinessCode,
  type TransportReadinessCondition,
  BridgeProtocolViolation,
} from '@veltrixeye/contracts';

/**
 * Gate 9 §7/§26 (R7.4.4) — the single authoritative transport/adapter
 * readiness interpretation.
 *
 * Before this module, "is the execution path allowed to proceed?" was answered
 * in at least three places with three different rules: the MT5 execution path
 * used truthiness (`!health.configured`), the MT5 health path re-derived the
 * same flags with `=== true`, the M8.1/M8.3 gates consulted `healthy` alone,
 * and the reconciliation snapshot adapter had its own pair of checks. Any one
 * of them could disagree with another for a malformed or partial health
 * record — which is exactly how an unavailable transport can look available.
 *
 * There is now exactly one rule, and it is strict:
 *  - a condition counts only when its value is the boolean `true`;
 *  - `true` is never inferred from a truthy value, a string, a number, an
 *    object, a missing field or a provider-specific label;
 *  - an uncertain/unknown health state is not readiness;
 *  - every consumer (health projection, gates, provider execution path,
 *    reconciliation) resolves through this file.
 *
 * Readiness is a *precondition*, never an authorization: `ready: true` means
 * "the transport is not known-broken", not "a trade may be placed".
 */

/**
 * Which conditions a given health record is required to state. A record is
 * only ever judged on the conditions its own contract declares — a narrower
 * gate snapshot must not be treated as if it asserted five independent facts,
 * and a full adapter health record must not be judged on one field.
 */
export const READINESS_PROFILES = {
  /** M8.1 execution gate input: `{ healthy }` is the whole declared shape. */
  gateHealth: ['healthy'],
  /** M8.3 paper simulation gate input: `{ configured, healthy }`. */
  paperGateHealth: ['configured', 'healthy'],
  /** Full adapter/provider health record: every condition must be explicit. */
  providerHealth: ['configured', 'authenticated', 'connected', 'available', 'healthy'],
  /** MT5 transport health record (`available` is derived by the provider). */
  transportHealth: ['configured', 'authenticated', 'connected', 'healthy'],
  /** Reconciliation snapshot precondition: reachable + healthy. */
  reconciliationHealth: ['available', 'healthy'],
} as const satisfies Record<string, readonly TransportReadinessCondition[]>;

export type ReadinessProfile = keyof typeof READINESS_PROFILES;

export interface ReadinessResolution {
  decision: BridgeReadinessDecision;
  /** Strict per-condition flags of the record (never inferred, never coerced). */
  flags: Record<TransportReadinessCondition, boolean>;
}

/**
 * Resolves readiness for any health-shaped value. `unknown` on purpose: every
 * caller here is about to consume data produced by an adapter (or, in tests,
 * by a hostile double), so the input is treated as untrusted until proven to
 * state the required conditions as strict booleans.
 */
export function resolveExecutionReadiness(
  health: unknown,
  profile: ReadinessProfile = 'providerHealth',
  now: () => Date = () => new Date(),
): ReadinessResolution {
  const decision = resolveBridgeReadiness(health, READINESS_PROFILES[profile], now);
  return { decision, flags: readBridgeHealthFlags(health) };
}

/** Strict per-condition booleans of a health record, for projections. */
export function explicitHealthFlags(health: unknown): BridgeHealthFlags {
  return readBridgeHealthFlags(health);
}

/** The conditions a profile requires, exposed so callers cannot invent their own. */
export function readinessRequirements(profile: ReadinessProfile): readonly TransportReadinessCondition[] {
  return READINESS_PROFILES[profile];
}

/** Convenience predicate for callers that only need the boolean. */
export function isExecutionReady(health: unknown, profile: ReadinessProfile = 'providerHealth'): boolean {
  return resolveExecutionReadiness(health, profile).decision.ready;
}

/** The closed violation code that corresponds to a failing readiness decision. */
export function readinessViolationCode(code: TransportReadinessCode): 'readiness_not_explicit' | 'readiness_unavailable' | 'readiness_uncertain' {
  switch (code) {
    case 'health_missing':
    case 'health_not_an_object':
    case 'health_malformed':
      return 'readiness_not_explicit';
    case 'state_uncertain':
      return 'readiness_uncertain';
    default:
      return 'readiness_unavailable';
  }
}

/**
 * Fail-closed gate for mutation paths: any non-`ready` decision throws a
 * deterministic protocol violation carrying `outcomeUnknown: false` — nothing
 * has been sent anywhere, so an unavailable transport is a *certain* refusal.
 */
export function assertExecutionReadiness(
  health: unknown,
  profile: ReadinessProfile,
  context: { mutation?: 'submit' | 'cancel' | 'modify' | 'close' } = {},
): BridgeReadinessDecision {
  const { decision } = resolveExecutionReadiness(health, profile);
  if (decision.ready) return decision;
  throw new BridgeProtocolViolation(readinessViolationCode(decision.code), 'Execution transport is not ready', {
    mutation: context.mutation ?? null,
    outcomeUnknown: false,
  });
}
