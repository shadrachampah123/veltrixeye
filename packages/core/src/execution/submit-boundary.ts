/**
 * B2 — the single canonical provider-submit boundary.
 *
 * This module wires the existing Gate 9 `ProviderMutationLedger` to the
 * `ExecutionProvider.submitOrder` interface so that **every provider-side
 * mutation flows through the durable barrier chain** documented in
 * `docs/gate9-provider-mutation-persistence.md`:
 *
 *   execution request
 *     ↓
 *   existing authorization / gate composition (caller-supplied, unchanged)
 *     ↓
 *   ProviderMutationLedger.prepareSubmit()         ← §9 pre-provider barrier
 *     ↓ durable committed intent + reservation + SubmitBarrier
 *   SubmitBarrier
 *     ↓
 *   ProviderMutationLedger.executeSubmit()
 *     ↓
 *   consumeSubmitBarrier()                         ← M2 single-use CAS
 *     ↓ consumed SubmitBarrier (state_version durably advanced)
 *   provider.submitOrderWithGate9Barrier(request, barrier)
 *     ↓ the provider re-verifies the barrier against the DURABLE intent row
 *   provider transport / broker call                ← never reached without barrier
 *
 * Nothing in this file introduces a second boundary, an alternate permission
 * scheme, or a parallel retry policy. It composes the existing Gate 9 ledger
 * (`provider-mutations.ts`) with the `Gate9SubmitBarrierProvider` contract
 * (below). No migration, schema, state machine, or vocabulary change is
 * introduced.
 *
 * Scope:
 *   - provider MUTATIONS only (submit). Cancel/modify/close are out of scope.
 *   - the canonical submit path for any execution provider that can produce a
 *     broker-side mutation. The internal paper simulator path remains
 *     unchanged (it does not reach a transport and is intentionally outside
 *     this boundary).
 *   - the M10 transport layer (`packages/core/src/execution/transport/`) is
 *     the documented future boundary. It remains unwired today and is reached
 *     only through a Gate 9-gated provider once the canonical dispatcher is
 *     adopted by an execution route.
 *
 * The legacy M8.4 `MT5Provider.submitOrder` boundary in `mt5.ts` remains
 * available as `createMT5ExecutionProvider` for the inherited M8.4 test
 * surface only. Production providers are built exclusively by
 * `createGate9MT5ExecutionProvider`, whose bare `submitOrder` always refuses
 * and whose `submitOrderWithGate9Barrier` requires the consumed Gate 9
 * barrier this dispatcher hands over (and re-verifies it durably).
 */

import type {
  ExecutionProvider,
  ExecutionSubmitOrderOutcome,
  ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';
import type {
  MutationExecutionResult,
  ProviderMutationLedger,
  ProviderSubmitCall,
  SubmitBarrier,
  SubmitIntentInput,
  SubmitOnceResult,
} from './provider-mutations.js';

/**
 * The Gate 9 barrier hand-off contract for broker-mutating providers.
 *
 * `submitOrderWithGate9Barrier` may only be invoked with a `SubmitBarrier`
 * that `ProviderMutationLedger.executeSubmit()` has ALREADY consumed (the M2
 * single-use CAS committed) for THIS exact mutation identity. Implementations
 * MUST re-verify the barrier against the durable intent row — not the barrier
 * object — before any provider-side effect:
 *
 *   - the durable row matches every barrier identity field;
 *   - the row is in the in-flight `submitting` state;
 *   - the row's `state_version` is exactly `barrier.stateVersion + 1`, i.e.
 *     the consuming write (every UPDATE advances the version per migration
 *     0029) has invalidated this barrier value for any second use.
 *
 * A replayed barrier resolves off the `submitting` state once the outcome is
 * durably applied, and a never-consumed barrier lacks the version advance —
 * both MUST refuse. The bare `submitOrder` of such a provider MUST refuse:
 * there is no barrier-free path to a provider mutation.
 */
export interface Gate9SubmitBarrierProvider extends ExecutionProvider {
  submitOrderWithGate9Barrier(
    request: ExecutionSubmitOrderRequest,
    barrier: SubmitBarrier,
  ): Promise<ExecutionSubmitOrderOutcome>;
}

/** Runtime guard: the dispatcher fails closed before any durable write. */
export function hasGate9BarrierSubmit(provider: ExecutionProvider): provider is Gate9SubmitBarrierProvider {
  return typeof (provider as Partial<Gate9SubmitBarrierProvider>).submitOrderWithGate9Barrier === 'function';
}

/**
 * The canonical submit boundary input. Carries everything Gate 9 needs to
 * commit the intent and reservation, plus the original execution request
 * (which the caller must have validated through the existing intake / gate
 * composition before invoking this function).
 *
 * The ledger never invents a risk decision, an authorization id, a credential
 * reference, or a fingerprint — every such field is caller-supplied or null.
 */
export interface CanonicalSubmitInput {
  readonly ledger: ProviderMutationLedger;
  /** MUST implement the Gate 9 barrier hand-off (see above). */
  readonly provider: Gate9SubmitBarrierProvider;

  readonly userId: string;
  readonly executionProfileId: string;
  readonly providerSlug: string;
  readonly environment: 'paper' | 'demo';
  readonly accountRef?: string | null;
  readonly brokerServerRef?: string | null;
  /** Reference only — never a credential value. */
  readonly credentialRef?: string | null;
  /** Reference only — never a credential value. */
  readonly credentialFingerprint?: string | null;
  /** Caller-supplied risk decision id (Gate 9 does not generate one). */
  readonly riskDecisionId?: string | null;
  readonly riskReservationId?: string | null;
  /** Decimal-string exposure copy. */
  readonly monetaryRisk?: string | null;
  readonly riskExpiresAt?: Date | null;

  /** The validated execution request, ready to hand to the provider. */
  readonly request: ExecutionSubmitOrderRequest;
}

export interface CanonicalSubmitSuccess {
  /** The mutation was durably submitted (or already existed as a duplicate). */
  readonly kind: 'submitted' | 'duplicate';
  /** The durable ledger outcome. `providerCalled` is true when the injected provider function ran. */
  readonly result: MutationExecutionResult;
  /** The provider-facing outcome, projected for downstream callers. */
  readonly providerOutcome: ExecutionSubmitOrderOutcome;
}

export type CanonicalSubmitError =
  | { kind: 'validation'; message: string }
  | { kind: 'pre_call_persistence_failed'; message: string }
  | { kind: 'barrier_not_consumable'; message: string }
  | { kind: 'provider_error'; message: string };

export type CanonicalSubmitResult =
  | ({ status: 'ok' } & CanonicalSubmitSuccess)
  | ({ status: 'error' } & CanonicalSubmitError);

/**
 * Project the durable `MutationExecutionResult` onto the canonical
 * `ExecutionSubmitOrderOutcome`. A duplicate resolution maps to `rejected`
 * (no provider call) so the existing intake contract is preserved.
 */
function projectOutcome(result: MutationExecutionResult): ExecutionSubmitOrderOutcome {
  return {
    providerOrderId: result.providerOrderId ?? result.intentId,
    status: result.outcome === 'rejected' ? 'rejected' : 'accepted',
    receipt: result.evidence
      ? { evidence: result.evidence, receiptId: result.receiptId }
      : { receiptId: result.receiptId },
  };
}

/**
 * The single canonical provider-submit boundary.
 *
 * The function NEVER calls the provider directly: it goes through
 * `ProviderMutationLedger.prepareSubmit` then `executeSubmit`, which:
 *   1. Commits the durable intent + reservation in one transaction (§9).
 *   2. Mints the `SubmitBarrier` whose `providerCallPermitted: true` is the
 *      only authority the provider invocation receives.
 *   3. Consumes the barrier in its own short transaction (M2 — single-use,
 *      CAS on `state_version`, never held across a remote call) before the
 *      provider function is invoked.
 *   4. Hands the CONSUMED barrier to the provider through
 *      `submitOrderWithGate9Barrier(request, barrier)`; the provider
 *      re-verifies it against the durable intent row before any transport
 *      contact (`createGate9MT5ExecutionProvider`).
 *   5. Persists the normalized receipt and the outcome transition.
 *
 * A provider without the Gate 9 barrier hand-off is refused BEFORE any
 * durable write. A failed prepare, a zero-row CAS, or a database failure
 * during consumption refuses closed (`pre_call_persistence_failed` or
 * `barrier_not_consumable`) and the provider function is never invoked.
 */
export async function submitOrderThroughGate9(
  input: CanonicalSubmitInput,
): Promise<CanonicalSubmitResult> {
  if (!hasGate9BarrierSubmit(input.provider)) {
    return {
      status: 'error',
      kind: 'validation',
      message: 'the canonical submit boundary requires a Gate 9-gated provider (submitOrderWithGate9Barrier); refusing before any durable Gate 9 write',
    };
  }
  if (!input.request?.clientOrderId) {
    return { status: 'error', kind: 'validation', message: 'execution request is missing a client order identity' };
  }
  if (!input.request?.idempotencyKey) {
    return { status: 'error', kind: 'validation', message: 'execution request is missing an idempotency identity' };
  }

  const intentInput: SubmitIntentInput = {
    userId: input.userId,
    executionProfileId: input.executionProfileId,
    clientOrderId: input.request.clientOrderId,
    idempotencyKey: input.request.idempotencyKey,
    canonicalRequest: input.request as unknown as Record<string, unknown>,
    providerSlug: input.providerSlug,
    environment: input.environment,
    accountRef: input.accountRef ?? null,
    brokerServerRef: input.brokerServerRef ?? null,
    credentialRef: input.credentialRef ?? null,
    credentialFingerprint: input.credentialFingerprint ?? null,
    riskDecisionId: input.riskDecisionId ?? null,
    riskReservationId: input.riskReservationId ?? null,
    symbol: input.request.symbol,
    direction: input.request.side === 'buy' ? 'long' : 'short',
    monetaryRisk: input.monetaryRisk ?? '0',
    riskExpiresAt: input.riskExpiresAt ?? null,
  };

  // The barrier hand-off: the provider receives the CONSUMED barrier together
  // with the request. The barrier is the only thing that authorizes a
  // provider invocation, and the provider re-verifies it against the durable
  // intent row; the provider's own M8.4 pre-flight runs unchanged on top of
  // it. The authorization context is never discarded.
  const providerCall: ProviderSubmitCall = async (barrier) => {
    const outcome = await input.provider.submitOrderWithGate9Barrier(input.request, barrier);
    return {
      clientOrderId: input.request.clientOrderId,
      idempotencyKey: input.request.idempotencyKey,
      accountRef: input.accountRef ?? null,
      providerOrderId: outcome.providerOrderId,
      status: outcome.status,
    };
  };

  let once: SubmitOnceResult;
  try {
    once = await input.ledger.submitOnce(intentInput, providerCall);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown persistence failure';
    // The ledger distinguishes failure modes via the error code; here we only
    // surface the message. Callers that need the specific code can catch the
    // ProviderMutationError thrown by `submitOnce` directly.
    return { status: 'error', kind: 'pre_call_persistence_failed', message };
  }

  if (once.kind === 'duplicate') {
    const intent = once.intent;
    const result: MutationExecutionResult = {
      providerCalled: false,
      outcome: intent.outcome ?? 'uncertain',
      intentId: intent.id,
      clientOrderId: intent.clientOrderId,
      idempotencyKey: intent.idempotencyKey ?? '',
      attempt: intent.attempt,
      intentState: intent.status,
      reservationState: null,
      uncertaintyReason: intent.uncertaintyReason,
      requiresReconciliation: intent.status === 'uncertain' || intent.status === 'submitting',
      receiptId: null,
      providerOrderId: null,
      evidence: intent.terminalEvidence,
      persistenceFailure: null,
    };
    return {
      status: 'ok',
      kind: 'duplicate',
      result,
      providerOutcome: {
        providerOrderId: intent.id,
        status: intent.status === 'rejected' ? 'rejected' : 'accepted',
        receipt: { duplicate: true, intentStatus: intent.status },
      },
    };
  }

  const result = once.result;
  return {
    status: 'ok',
    kind: 'submitted',
    result,
    providerOutcome: projectOutcome(result),
  };
}
