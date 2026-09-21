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
 *   handoff.onBarrierConsumed(barrier)             ← one-shot token handoff (F1)
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
 * B2 remediation invariants (F1–F6):
 *
 *  F1 — the legacy M8.4 `MT5Provider.submitOrder` boundary is additionally
 *       gated by an injected `gate9.consumeAuthorization` predicate. The
 *       composition is expected to wire `createSubmitBarrierHandoff()` so that
 *       a barrier may be presented to the legacy boundary only if the
 *       canonical dispatcher has durably consumed it, bound to the EXACT
 *       mutation identity, and not already presented. A consumed barrier can
 *       never authorize a second (different or repeated) mutation.
 *
 *  F2 — the provider-facing request is deep-frozen (an exact structural
 *       copy) BEFORE the canonical request hash is computed, and that same
 *       frozen copy is the ONLY object handed to `provider.submitOrder`. The
 *       durable hash and the transport payload therefore provably match, and
 *       no in-process mutation between authorization and transport can change
 *       what the provider receives. The injected provider instance is
 *       verified against the durable authorization (providerSlug,
 *       environment, accountRef, broker/server) BEFORE any persistence: a
 *       mismatch refuses closed.
 *       - `brokerServerRef` decision (explicit): it is durably persisted on
 *         the intent row and re-verified against the provider instance at
 *         this boundary, but it does NOT join the ledger's consumption CAS.
 *         The CAS identity is the barrier-minted mutation identity; the
 *         broker/server binding is enforced on the provider-instance side
 *         (this module), so no Gate 9 schema/CAS/vocabulary change is needed.
 *
 *  F3 — a provider outcome that is `uncertain` is NEVER projected as
 *       `accepted` (and never laundered into `rejected`): the result is an
 *       explicit `provider_uncertain` error carrying the durable
 *       `MutationExecutionResult`. A duplicate resolution onto an
 *       unresolved intent (`prepared`/`submitting`/`uncertain`/`reconciled`)
 *       is likewise an explicit `duplicate_unresolved` error. Only a
 *       durably `confirmed`/`rejected` intent projects a provider outcome,
 *       using the REAL provider order id from the durable receipt — never an
 *       internal intent id, and never a ticket-less acceptance.
 *
 *  F6 — `CanonicalSubmitError` contains exactly the kinds this wrapper can
 *       expose. The ledger's `barrier_not_consumable` code is surfaced under
 *       its own kind (not laundered into a persistence failure);
 *       `invalid_mutation_identity` / `invalid_binding` surface as
 *       `validation`. Provider-call failures are never thrown out of the
 *       ledger (they are classified durably as `uncertain`), so there is no
 *       `provider_error` kind.
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
 */

import type {
  ExecutionProvider,
  ExecutionSubmitOrderOutcome,
  ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';
import {
  ProviderMutationError,
  canonicalMutationRequestHash,
  type MutationExecutionResult,
  type ProviderMutationLedger,
  type ProviderSubmitCall,
  type SubmitBarrier,
  type SubmitIntentInput,
  type SubmitOnceResult,
} from './provider-mutations.js';
import type { Gate9BarrierPredicate } from './mt5.js';

/* -------------------------------------------------------------------------- */
/* Canonical submit input                                                      */
/* -------------------------------------------------------------------------- */

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

  /**
   * F1 — the one-shot barrier handoff shared with the provider's `gate9`
   * predicate. When supplied, the dispatcher records the durably consumed
   * barrier here immediately after consumption (and before the provider
   * call), so the legacy boundary can accept it exactly once, bound to this
   * exact mutation identity. Omit it when the injected provider has no
   * legacy gate to satisfy.
   */
  readonly handoff?: SubmitBarrierHandoff;
}

export interface CanonicalSubmitSuccess {
  /** The mutation was durably submitted (or already existed as a duplicate). */
  readonly kind: 'submitted' | 'duplicate';
  /** The durable ledger outcome. `providerCalled` is true when the injected provider function ran. */
  readonly result: MutationExecutionResult;
  /**
   * The provider-facing outcome, projected for downstream callers. `status`
   * is `accepted` only when the ledger verified the acceptance durably (with
   * a real provider order id), `rejected` only for an explicit provider
   * rejection, and `uncertain` is never projected here: uncertainty surfaces
   * as the `provider_uncertain` error kind instead.
   */
  readonly providerOutcome: ExecutionSubmitOrderOutcome;
}

/**
 * The closed error vocabulary of the canonical boundary (F6). Every kind is
 * reachable and every kind refuses closed — in every error case the provider
 * function was never invoked (except `provider_uncertain`, where it WAS
 * invoked and the durable state records the unknown outcome).
 */
export type CanonicalSubmitError =
  | { kind: 'validation'; message: string }
  | { kind: 'pre_call_persistence_failed'; message: string }
  | { kind: 'barrier_not_consumable'; message: string }
  | { kind: 'provider_binding_mismatch'; message: string }
  /**
   * The provider call was made, its outcome could not be durably established,
   * and the intent is recorded `uncertain` (reconciliation required). This is
   * NEVER an acceptance and NEVER a rejection.
   */
  | { kind: 'provider_uncertain'; message: string; result: MutationExecutionResult }
  /**
   * A duplicate request resolved onto an intent whose provider outcome is not
   * durably resolved (`prepared`/`submitting`/`uncertain`/`reconciled`).
   * Never projected as accepted or rejected.
   */
  | { kind: 'duplicate_unresolved'; message: string; result: MutationExecutionResult };

export type CanonicalSubmitResult =
  | ({ status: 'ok' } & CanonicalSubmitSuccess)
  | ({ status: 'error' } & CanonicalSubmitError);

/* -------------------------------------------------------------------------- */
/* F2 — frozen request + provider/configuration binding                        */
/* -------------------------------------------------------------------------- */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

type BindingMismatch = { status: 'error'; kind: 'provider_binding_mismatch'; message: string };

/**
 * F2 — verifies that the injected provider instance IS the provider the
 * durable authorization names. The check is structural, over the provider's
 * operator-safe `describe()` surface (existing API — no second authorization
 * system), and is exact in BOTH directions:
 *
 *   - `providerSlug`    must equal the provider's declared `id`;
 *   - `environment`     must equal the provider's declared `environment`;
 *   - `accountRef`      must equal the provider's declared `accountRef`;
 *   - `brokerServerRef` must equal the provider's declared broker `server`.
 *
 * A provider that does not declare a field declares `null` (the paper
 * simulator declares no account and no broker server). A binding that names
 * a value the provider does not declare is a mismatch, and vice versa.
 * Undeclared credentials are never consulted — only references.
 */
function verifyProviderBinding(input: CanonicalSubmitInput): BindingMismatch | null {
  const mismatch = (field: string): BindingMismatch => ({
    status: 'error',
    kind: 'provider_binding_mismatch',
    message:
      `provider binding mismatch on ${field}: the durable authorization and the ` +
      'provider instance disagree; no persistence or provider call is permitted',
  });

  let described: Record<string, unknown> | null = null;
  try {
    described = input.provider.describe();
  } catch {
    described = null;
  }
  if (!described || typeof described !== 'object') return mismatch('describe');

  const declared = (key: string): string | null => {
    const value = described[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  if (!input.providerSlug) return mismatch('providerSlug');
  if (declared('id') !== input.providerSlug) return mismatch('providerSlug');
  if (declared('environment') !== input.environment) return mismatch('environment');
  if (declared('accountRef') !== (input.accountRef ?? null)) return mismatch('accountRef');
  if (declared('server') !== (input.brokerServerRef ?? null)) return mismatch('brokerServerRef');
  return null;
}

/* -------------------------------------------------------------------------- */
/* F1 — one-shot barrier handoff for the legacy boundary                       */
/* -------------------------------------------------------------------------- */

function handoffKey(clientOrderId: string, idempotencyKey: string, requestHash: string): string {
  return `${clientOrderId}\u0000${idempotencyKey}\u0000${requestHash}`;
}

/**
 * F1 — the composition-side, one-shot token handoff between the canonical
 * dispatcher and the legacy M8.4 boundary.
 *
 * This is NOT an authorization system: it stores no permissions and authorizes
 * nothing by itself. It is a single-process token vault with exactly one job —
 * to make a durably consumed Gate 9 `SubmitBarrier` presentable to the legacy
 * boundary AT MOST ONCE, bound to the exact mutation identity:
 *
 *   - `onBarrierConsumed(barrier)` is called by the canonical dispatcher
 *     immediately after the ledger's single-use CAS has COMMITTED (and before
 *     the provider call). It arms the vault with the consumed barrier.
 *   - `gate9.consumeAuthorization(request)` (the predicate the composition
 *     wires into `createMT5ExecutionProvider`) re-derives the canonical
 *     request hash of the presented request, looks the barrier up by
 *     (clientOrderId, idempotencyKey, requestHash), and REMOVES it on
 *     presentation. A spent barrier, a barrier for a different mutation, a
 *     forged barrier, or a replayed presentation all yield `null` — the
 *     legacy boundary then refuses before any transport interaction.
 *
 * The durable single-use guarantee remains the ledger's CAS; the vault only
 * prevents a consumed barrier object from being re-presented in-process.
 */
export interface SubmitBarrierHandoff {
  /** Called by the canonical dispatcher after durable consumption, before the provider call. */
  readonly onBarrierConsumed: (barrier: SubmitBarrier) => void;
  /** The `gate9` predicate for the legacy boundary (wire into the provider). */
  readonly gate9: Gate9BarrierPredicate;
}

export function createSubmitBarrierHandoff(): SubmitBarrierHandoff {
  const presented = new Map<string, SubmitBarrier>();

  return {
    onBarrierConsumed(barrier: SubmitBarrier): void {
      presented.set(handoffKey(barrier.clientOrderId, barrier.idempotencyKey, barrier.requestHash), barrier);
    },
    gate9: {
      consumeAuthorization(request: ExecutionSubmitOrderRequest): SubmitBarrier | null {
        if (!request || typeof request !== 'object') return null;
        const clientOrderId = request.clientOrderId;
        const idempotencyKey = request.idempotencyKey;
        if (typeof clientOrderId !== 'string' || clientOrderId.length === 0) return null;
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return null;
        let requestHash: string;
        try {
          requestHash = canonicalMutationRequestHash({
            clientOrderId,
            idempotencyKey,
            canonicalRequest: request,
          });
        } catch {
          // A request carrying credential-shaped keys is refused, never armed.
          return null;
        }
        const key = handoffKey(clientOrderId, idempotencyKey, requestHash);
        const barrier = presented.get(key) ?? null;
        if (barrier) presented.delete(key); // one-shot: never presentable again
        return barrier;
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The canonical dispatcher                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The single canonical provider-submit boundary.
 *
 * The function NEVER calls the provider directly: it goes through
 * `ProviderMutationLedger.prepareSubmit` then `executeSubmit`, which:
 *   1. Commits the durable intent + reservation in one transaction (§9).
 *   2. Mints the `SubmitBarrier` whose `providerCallPermitted: true` is the
 *      only authority the provider invocation receives.
 *   3. Consumes the barrier in its own short transaction (M2 — single-use,
 *      CAS on the exact `state_version`, never held across a remote call)
 *      before the provider function is invoked.
 *   4. Hands the consumed barrier to `input.handoff` (when wired) and
 *      persists the normalized receipt and the outcome transition.
 *
 * The injected provider call is the ONLY thing that ever reaches the
 * provider transport. A failed prepare, a zero-row CAS, a provider-binding
 * mismatch, or a database failure during consumption refuses closed and the
 * provider function is never invoked. A provider call whose outcome cannot
 * be established refuses closed as `provider_uncertain` — it is never an
 * acceptance.
 */
export async function submitOrderThroughGate9(
  input: CanonicalSubmitInput,
): Promise<CanonicalSubmitResult> {
  // F2 — freeze the EXACT provider-facing request before anything else. The
  // canonical request hash and the provider call both see this immutable
  // structural copy, so no in-process mutation between authorization and
  // transport can alter what the provider receives or what the durable
  // authorization covers. The caller's original object is left untouched.
  if (!input.request || typeof input.request !== 'object') {
    return { status: 'error', kind: 'validation', message: 'execution request is missing' };
  }
  const request = deepFreeze(structuredClone(input.request));
  if (!request.clientOrderId) {
    return { status: 'error', kind: 'validation', message: 'execution request is missing a client order identity' };
  }
  if (!request.idempotencyKey) {
    return { status: 'error', kind: 'validation', message: 'execution request is missing an idempotency identity' };
  }

  // F2 — the provider instance must be the provider the authorization names,
  // before any persistence. Fail closed on any mismatch (or on a provider
  // that cannot describe itself).
  const bindingError = verifyProviderBinding(input);
  if (bindingError) return bindingError;

  const intentInput: SubmitIntentInput = {
    userId: input.userId,
    executionProfileId: input.executionProfileId,
    clientOrderId: request.clientOrderId,
    idempotencyKey: request.idempotencyKey,
    // The frozen copy: the durable hash covers exactly what the provider
    // will receive.
    canonicalRequest: request as unknown as Record<string, unknown>,
    providerSlug: input.providerSlug,
    environment: input.environment,
    accountRef: input.accountRef ?? null,
    brokerServerRef: input.brokerServerRef ?? null,
    credentialRef: input.credentialRef ?? null,
    credentialFingerprint: input.credentialFingerprint ?? null,
    riskDecisionId: input.riskDecisionId ?? null,
    riskReservationId: input.riskReservationId ?? null,
    symbol: request.symbol,
    direction: request.side === 'buy' ? 'long' : 'short',
    monetaryRisk: input.monetaryRisk ?? '0',
    riskExpiresAt: input.riskExpiresAt ?? null,
  };

  // The provider function receives the consumed barrier, NOT the raw request.
  // The barrier has already been durably consumed (M2 CAS) at this point; the
  // handoff records it for the legacy boundary, and the provider's own gate
  // composition runs unchanged on top. The frozen `request` is the only
  // request object the provider ever sees.
  const providerCall: ProviderSubmitCall = async (barrier) => {
    void barrier; // the barrier has already been durably consumed
    input.handoff?.onBarrierConsumed(barrier);
    const outcome = await input.provider.submitOrder(request);
    return {
      clientOrderId: request.clientOrderId,
      idempotencyKey: request.idempotencyKey,
      accountRef: input.accountRef ?? null,
      providerOrderId: outcome.providerOrderId ?? null,
      status: outcome.status,
    };
  };

  let once: SubmitOnceResult;
  try {
    once = await input.ledger.submitOnce(intentInput, providerCall);
  } catch (error) {
    // F6 — surface the ledger's closed error vocabulary accurately. No
    // error path here may have invoked the provider: the ledger throws
    // only when the pre-call persistence or the single-use CAS fails.
    if (error instanceof ProviderMutationError) {
      if (error.code === 'barrier_not_consumable') {
        return { status: 'error', kind: 'barrier_not_consumable', message: error.message };
      }
      if (error.code === 'invalid_mutation_identity' || error.code === 'invalid_binding') {
        return { status: 'error', kind: 'validation', message: error.message };
      }
      if (error.code === 'pre_call_persistence_failed') {
        return { status: 'error', kind: 'pre_call_persistence_failed', message: error.message };
      }
      return {
        status: 'error',
        kind: 'pre_call_persistence_failed',
        message: `Gate 9 refused the submit (${error.code}); no provider call is permitted`,
      };
    }
    const message = error instanceof Error ? error.message : 'unknown persistence failure';
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
    // F3 — only a durably RESOLVED intent projects a provider outcome, and
    // only with the REAL provider order id from the durable receipt. A
    // duplicate resolving onto prepared/submitting/uncertain/reconciled is
    // NEVER projected as accepted (nor as rejected): it is an explicit
    // error the caller resolves through the ledger (reconciliation, or a
    // retry with a fresh mutation identity under fresh authorization).
    if (intent.status === 'rejected') {
      // An explicit rejection may legitimately have no ticket.
      const receipt = await input.ledger.getReceipt(intent.id);
      return {
        status: 'ok',
        kind: 'duplicate',
        result,
        providerOutcome: {
          providerOrderId: receipt?.providerOrderId ?? null,
          status: 'rejected',
          receipt: { duplicate: true, intentStatus: intent.status, receiptId: receipt?.id ?? null },
        },
      };
    }
    if (intent.status === 'confirmed') {
      const receipt = await input.ledger.getReceipt(intent.id);
      // Fail-safe: a confirmed (accepted) intent must carry its verified
      // ticket durably — the ledger only confirms after identity
      // verification, which requires a real provider order id. If the
      // receipt or its ticket is somehow missing (a durable state anomaly),
      // an acceptance is NEVER projected ticket-less: fail to explicit
      // unresolved so the anomaly is visible and reconciled.
      if (!receipt?.providerOrderId) {
        return {
          status: 'error',
          kind: 'duplicate_unresolved',
          message:
            `duplicate resolution reached a confirmed intent without a durable provider ` +
            `order id (intent ${intent.id}); an acceptance is never projected without its ` +
            'verified ticket — reconcile the intent before resubmitting',
          result,
        };
      }
      return {
        status: 'ok',
        kind: 'duplicate',
        result,
        providerOutcome: {
          providerOrderId: receipt.providerOrderId,
          status: 'accepted',
          receipt: { duplicate: true, intentStatus: intent.status, receiptId: receipt.id },
        },
      };
    }
    return {
      status: 'error',
      kind: 'duplicate_unresolved',
      message:
        `duplicate resolution reached an intent in state '${intent.status}'; the provider ` +
        'outcome is not durably resolved and is never projected as accepted or rejected',
      result,
    };
  }

  const result = once.result;

  // F3 — uncertainty is neither an acceptance nor a rejection.
  if (result.outcome === 'uncertain') {
    return {
      status: 'error',
      kind: 'provider_uncertain',
      message:
        `the provider call was made but its outcome could not be durably established` +
        ` (${result.uncertaintyReason ?? 'unknown reason'}); intent ${result.intentId} is ` +
        `recorded '${result.intentState}' and requires reconciliation`,
      result,
    };
  }

  if (result.outcome === 'rejected') {
    // An explicit provider rejection. `providerOrderId` is null when the
    // provider never produced a ticket — an internal id is never substituted.
    return {
      status: 'ok',
      kind: 'submitted',
      result,
      providerOutcome: {
        providerOrderId: result.providerOrderId,
        status: 'rejected',
        receipt: { receiptId: result.receiptId },
      },
    };
  }

  // accepted — the ledger reaches 'accepted' only after identity
  // verification, which requires a real, non-empty provider order id. The
  // defensive check below preserves the invariant regardless: an acceptance
  // is never projected without its real ticket.
  if (!result.providerOrderId) {
    return {
      status: 'error',
      kind: 'provider_uncertain',
      message:
        'an accepted outcome without a verified provider order identity cannot be projected; ' +
        'the intent requires reconciliation',
      result,
    };
  }
  return {
    status: 'ok',
    kind: 'submitted',
    result,
    providerOutcome: {
      providerOrderId: result.providerOrderId,
      status: 'accepted',
      receipt: result.evidence
        ? { evidence: result.evidence, receiptId: result.receiptId }
        : { receiptId: result.receiptId },
    },
  };
}
