import {
  ExecutionProviderError,
  evaluateQuoteFreshness,
  normalizeProviderOrderStatus,
  validateBridgeClientOrderId,
  validateInstrumentContract,
  validateVolumeAgainstInstrument,
  type AssetClass,
  MT5_BRIDGE_DEFAULT_CLOCK_SKEW_MS,
  MT5_BRIDGE_DEFAULT_MAX_QUOTE_AGE_MS,
  type BridgeInstrumentContract,
  type ClientOrderIdDecision,
  type InstrumentContractDecision,
  type QuoteFreshnessDecision,
  type VolumeRuleCode,
} from '@veltrixeye/contracts';
import { resolveExecutionReadiness, type ReadinessProfile } from './readiness.js';

/**
 * Gate 9 Step 2 — the strict pre-provider validation layer.
 *
 * These are the checks a future bridge adapter MUST complete before a single
 * byte can reach a provider, expressed once so no adapter can implement a
 * laxer copy:
 *
 *  - **B2** durable client-order identity (`ve-<24 hex>` / `ve-<20 hex>-rN`);
 *  - **B5** explicit transport readiness (delegated to the single resolver);
 *  - **B6** two-sided quote freshness with a bounded clock-skew window;
 *  - **B7** instrument contract + volume-step alignment;
 *  - **B9** provider-status normalization that keeps unknown states uncertain.
 *
 * Every failure is deterministic, pre-exchange and therefore carries
 * `uncertain: false` — nothing was sent, so nothing is unknown. Messages are
 * fixed literals plus closed code tokens; no provider text and no request
 * payload ever enters an error (Gate 10 boundary).
 */

/** Options a deployment may narrow; widening is impossible (bounded schema). */
export interface BridgeValidationPolicy {
  /** Maximum accepted quote age. Defaults to the protocol value (15000 ms). */
  maxQuoteAgeMs?: number;
  /** Forward-drift tolerance for quote timestamps. Defaults to 5000 ms (§8). */
  clockSkewMs?: number;
}

export const BRIDGE_DEFAULT_POLICY: Required<BridgeValidationPolicy> = Object.freeze({
  maxQuoteAgeMs: MT5_BRIDGE_DEFAULT_MAX_QUOTE_AGE_MS,
  clockSkewMs: MT5_BRIDGE_DEFAULT_CLOCK_SKEW_MS,
});

type PreflightCategory = 'validation' | 'invalid_symbol' | 'invalid_volume' | 'invalid_price' | 'unavailable' | 'authentication';

/** A pre-exchange rejection: deterministic, certain, and carrying no payload. */
const preflight = (category: PreflightCategory, message: string) => new ExecutionProviderError(category, message, { uncertain: false });

/* -------------------------------------------------------------------------- */
/* B2 — client order identity                                                  */
/* -------------------------------------------------------------------------- */

/** Pure identity decision (no error construction) for callers that only inspect. */
export function validateBridgeOrderIdentity(clientOrderId: unknown): ClientOrderIdDecision {
  return validateBridgeClientOrderId(clientOrderId);
}

/**
 * Returns the rejection for a malformed client order id, or null when the id is
 * an accepted VeltrixEye durable identity. MUST be the first check performed on
 * any order-creating mutation: a rejection here means zero provider calls.
 */
export function bridgeOrderIdentityError(clientOrderId: unknown): ExecutionProviderError | null {
  const decision = validateBridgeOrderIdentity(clientOrderId);
  if (decision.ok) return null;
  return preflight('validation', `Client order identity rejected before submission (${decision.code})`);
}

/* -------------------------------------------------------------------------- */
/* B5 — readiness (delegates to the single authoritative resolver)             */
/* -------------------------------------------------------------------------- */

export interface BridgeReadinessOutcome {
  ready: boolean;
  code: string;
}

/** Resolves readiness through `readiness.ts` and maps a refusal onto the provider taxonomy. */
export function bridgeReadinessError(
  health: unknown,
  profile: ReadinessProfile,
): (ExecutionProviderError & { readinessCode: string }) | null {
  const { decision } = resolveExecutionReadiness(health, profile);
  if (decision.ready) return null;
  const category = decision.code === 'not_authenticated' ? 'authentication' : 'unavailable';
  const error = preflight(category, 'Execution transport is not ready; no request was sent to the provider') as ExecutionProviderError & { readinessCode: string };
  Object.defineProperty(error, 'readinessCode', { value: decision.code, enumerable: false });
  return error;
}

/* -------------------------------------------------------------------------- */
/* B6 — two-sided quote freshness                                              */
/* -------------------------------------------------------------------------- */

export function evaluateBridgeQuote(args: {
  quote: unknown;
  nowMs: number;
  policy?: BridgeValidationPolicy;
}): QuoteFreshnessDecision {
  // An omitted option falls back to the protocol default; it can only narrow,
  // never disable, a bound (`evaluateQuoteFreshness` rejects non-finite values).
  const policy = {
    maxQuoteAgeMs: args.policy?.maxQuoteAgeMs ?? BRIDGE_DEFAULT_POLICY.maxQuoteAgeMs,
    clockSkewMs: args.policy?.clockSkewMs ?? BRIDGE_DEFAULT_POLICY.clockSkewMs,
  };
  return evaluateQuoteFreshness({
    quote: args.quote,
    nowMs: args.nowMs,
    maxAgeMs: policy.maxQuoteAgeMs,
    clockSkewMs: policy.clockSkewMs,
  });
}

/** Stale AND materially-future quotes both refuse execution (§8, B6). */
export function bridgeQuoteError(args: {
  quote: unknown;
  nowMs: number;
  policy?: BridgeValidationPolicy;
}): (ExecutionProviderError & { quoteCode: string }) | null {
  const decision = evaluateBridgeQuote(args);
  if (decision.fresh) return null;
  const error = preflight('invalid_price', `Broker quote rejected before submission (${decision.code})`) as ExecutionProviderError & { quoteCode: string };
  Object.defineProperty(error, 'quoteCode', { value: decision.code, enumerable: false });
  return error;
}

/* -------------------------------------------------------------------------- */
/* B7 — instrument contract and volume                                         */
/* -------------------------------------------------------------------------- */

export interface BridgeInstrumentOutcome {
  contract: BridgeInstrumentContract | null;
  error: ExecutionProviderError | null;
}

/**
 * Validates a provider-supplied instrument against the protocol contract. The
 * returned `contract` is the validated copy — downstream code must use it
 * instead of the raw provider row.
 */
export function validateBridgeInstrument(
  raw: unknown,
  expected: { canonicalSymbol?: string; providerSymbol?: string; assetClass?: AssetClass } = {},
): BridgeInstrumentOutcome {
  const decision: InstrumentContractDecision = validateInstrumentContract(raw, expected);
  if (decision.ok && decision.contract) return { contract: decision.contract, error: null };
  const category = decision.code === 'symbol_mismatch' ? 'invalid_symbol' : decision.code === 'volume_step_invalid' ? 'invalid_volume' : 'validation';
  return { contract: null, error: preflight(category, `Broker instrument contract rejected before submission (${decision.code})`) };
}

/** Volume range + step alignment against an ALREADY validated contract (§9). */
export function bridgeVolumeError(args: {
  volume: unknown;
  contract: BridgeInstrumentContract | null;
}): (ExecutionProviderError & { volumeCode: VolumeRuleCode }) | null {
  const decision = validateVolumeAgainstInstrument({ volume: args.volume, contract: args.contract });
  if (decision.ok) return null;
  const error = preflight('invalid_volume', `Requested volume rejected before submission (${decision.code})`) as ExecutionProviderError & { volumeCode: VolumeRuleCode };
  Object.defineProperty(error, 'volumeCode', { value: decision.code, enumerable: false });
  return error;
}

/* -------------------------------------------------------------------------- */
/* B9 — provider status normalization                                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes a provider order status through the closed vocabulary. Unknown,
 * missing, malformed or case-variant values are returned as an explicitly
 * uncertain state; they are never converted into `failed`/`rejected (§18, §21).
 */
export function normalizeBridgeProviderStatus(raw: unknown) {
  return normalizeProviderOrderStatus(raw);
}
