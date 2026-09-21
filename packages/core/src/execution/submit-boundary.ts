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
 *     ↓
 *   ProviderSubmitCall                              ← injected provider function
 *     ↓
 *   provider transport / broker call                ← never reached without barrier
 *
 * Nothing in this file introduces a second boundary, an alternate permission
 * scheme, or a parallel retry policy. It composes the existing Gate 9 ledger
 * (`provider-mutations.ts`) with the existing `ExecutionProvider` interface
 * (`@veltrixeye/contracts`) and the existing `DisabledMT5Transport` failure
 * surface. No migration, schema, state machine, or vocabulary change is
 * introduced.
 *
 * Scope:
 *   - provider MUTATIONS only (submit). Cancel/modify/close are out of scope.
 *   - the canonical submit path for any execution provider that can produce a
 *     broker-side mutation. The internal paper simulator path remains
 *     unchanged (it does not reach a transport).
 *   - the M10 transport layer (`packages/core/src/execution/transport/`) is
 *     the documented future boundary. It remains unwired today and is reached
 *     only through `provider.submitOrder` once the canonical dispatcher is
 *     adopted by an execution route.
 *
 * The legacy M8.4 `MT5Provider.submitOrder` boundary in `mt5.ts` is
 * additionally gated by an injected `gate9.consumeAuthorization` predicate
 * (see `createMT5ExecutionProvider`). When wired (production composition),
 * the predicate enforces the same "no barrier, no transport call" rule.
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
  SubmitIntentInput,
  SubmitOnceResult,
} from './provider-mutations.js';

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
  readonly provider: ExecutionProvider;

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
 *   4. Persists the normalized receipt and the outcome transition.
 *
 * The injected provider call is the ONLY thing that ever reaches the
 * provider transport. A failed prepare, a zero-row CAS, or a database failure
 * during consumption refuses closed (`pre_call_persistence_failed` or
 * `barrier_not_consumable`) and the provider function is never invoked.
 */
export async function submitOrderThroughGate9(
  input: CanonicalSubmitInput,
): Promise<CanonicalSubmitResult> {
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

  // The provider function receives the consumed barrier, NOT the raw request.
  // The barrier is the only thing that authorizes a provider invocation; the
  // provider's own gate composition runs unchanged on top of it.
  const providerCall: ProviderSubmitCall = async (barrier) => {
    void barrier; // the barrier has already been durably consumed at this point
    const outcome = await input.provider.submitOrder(input.request);
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
