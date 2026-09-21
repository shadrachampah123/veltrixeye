/**
 * Test-only deterministic Fake Bridge support boundary.
 *
 * This module is deliberately kept under `test/support`. It is an in-memory
 * provider simulation for Gate 9 ledger tests, not an execution provider and
 * not a production transport. It has no database, network, credential,
 * subprocess, registry, or API dependency.
 *
 * The intended test path is:
 *
 *   prepareSubmit -> SubmitBarrier -> executeSubmit/submitOnce
 *     -> DeterministicFakeProvider -> FakeBridge state
 *     -> deterministic lookup/snapshot
 *
 * The ledger remains the system under test. The fake only implements the
 * injected `ProviderSubmitCall` boundary and owns provider-side state.
 */

import { createHash } from 'node:crypto';
import { validateBridgeClientOrderId, type BridgeNormalizedStatus, type BridgeReconciliationOutcome, type ReconciliationProviderOrder, type ReconciliationProviderSnapshot } from '@veltrixeye/contracts';
import {
  ProviderMutationError,
  type ProviderSubmitCall,
  type SubmitBarrier,
} from '../../src/execution/provider-mutations.js';

/* -------------------------------------------------------------------------- */
/* Deterministic provider identity                                            */
/* -------------------------------------------------------------------------- */

export function deterministicProviderOrderId(clientOrderId: string): string {
  const hash = createHash('sha256').update(clientOrderId).digest('hex').slice(0, 32);
  return `fake-${hash}`;
}

/* -------------------------------------------------------------------------- */
/* Provider-side simulated order state                                        */
/* -------------------------------------------------------------------------- */

/**
 * `unknown` is test-only provider-side state. It is projected to the existing
 * reconciliation `uncertain` vocabulary and is never a VeltrixEye mutation
 * state.
 */
export type FakeProviderOrderStatus =
  | 'requested'
  | 'placed'
  | 'accepted'
  | 'partial'
  | 'filled'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'duplicate_reported'
  | 'unknown';

export interface FakeProviderState {
  readonly providerOrderId: string;
  readonly clientOrderId: string;
  readonly idempotencyKey: string;
  readonly accountRef: string | null;
  status: FakeProviderOrderStatus;
  filledQuantity: number | null;
  averagePrice: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface FakeBridgeInvocation {
  readonly barrierIntentId: string;
  readonly clientOrderId: string;
  readonly idempotencyKey: string;
  readonly providerOrderId: string;
  readonly scenario: FakeBridgeScenario;
  readonly at: string;
}

/* -------------------------------------------------------------------------- */
/* Deterministic scenario control                                             */
/* -------------------------------------------------------------------------- */

/**
 * `accept`/`reject` and the shorter names are retained as compatibility
 * aliases for the reviewed readiness scaffold. The explicit names are the
 * canonical Gate 9 taxonomy used by new tests.
 */
export type FakeBridgeScenario =
  | { kind: 'accepted'; status?: FakeProviderOrderStatus }
  | { kind: 'accept'; status?: FakeProviderOrderStatus }
  | { kind: 'rejected'; status?: FakeProviderOrderStatus }
  | { kind: 'reject'; status?: FakeProviderOrderStatus }
  | { kind: 'provider_duplicate'; status?: FakeProviderOrderStatus }
  | { kind: 'timeout' }
  | { kind: 'connection_failure' }
  | { kind: 'transport_failure' }
  | { kind: 'lost_response' }
  | { kind: 'lost' }
  | { kind: 'malformed_response' }
  | { kind: 'malformed' }
  | { kind: 'unknown_provider_status' }
  | { kind: 'unknown_status' }
  | { kind: 'credential_leak' }
  | { kind: 'identity_verification_failed' }
  | { kind: 'identity_mismatch' }
  | { kind: 'accepted_then_timeout' };

export type FakeBridgeScenarioFn = (call: number) => FakeBridgeScenario;
export type FakeBridgeScenarioInput = FakeBridgeScenario | FakeBridgeScenarioFn;

export type FakeReconciliationScenario =
  | 'normal'
  | 'malformed_response'
  | 'unknown_provider_status'
  | 'provider_unavailable';

export interface FakeBridgeOptions {
  /** Prefix for deterministic provider order ids. */
  providerIdPrefix?: string;
  /** Provider id used by the optional reconciliation snapshot adapter. */
  providerId?: string;
  now?: () => Date;
}

export interface FakeReconciliationSelector {
  providerOrderId?: string;
  clientOrderId?: string;
  idempotencyKey?: string;
}

/**
 * The lookup result deliberately uses the existing Gate 9 reconciliation
 * vocabulary. It is an observation only; it never changes ledger state and
 * never authorizes a retry or a repair.
 */
export interface FakeReconciliationLookup {
  readonly outcome: BridgeReconciliationOutcome;
  readonly status: BridgeNormalizedStatus | null;
  /** Alias used by ProviderMutationLedger.recordReconciliationObservation. */
  readonly providerStatus: BridgeNormalizedStatus | null;
  readonly statusUncertain: boolean;
  readonly requiresReconciliation: boolean;
  readonly requiresOperatorResolution: boolean;
  readonly providerUnavailable: boolean;
  readonly providerOrderId: string | null;
  readonly clientOrderId: string | null;
  readonly idempotencyKey: string | null;
  readonly observedAt: string;
  readonly order: FakeProviderState | null;
}

/* -------------------------------------------------------------------------- */
/* FakeBridge — provider-side state plus the submit boundary                  */
/* -------------------------------------------------------------------------- */

export class FakeBridge {
  private readonly ordersByClient = new Map<string, FakeProviderState>();
  private readonly ordersByProvider = new Map<string, FakeProviderState>();
  private readonly ordersByIdempotency = new Map<string, FakeProviderState>();
  private readonly invocations: FakeBridgeInvocation[] = [];
  /** A fake-side defense-in-depth guard; the durable ledger remains authoritative. */
  private readonly consumedBarrierKeys = new Set<string>();
  private scenario: FakeBridgeScenarioInput;
  private readonly now: () => Date;
  private readonly prefix: string;
  private readonly reconciliationProviderId: string;
  private reconciliationScenario: FakeReconciliationScenario = 'normal';

  constructor(
    initialScenario: FakeBridgeScenarioInput = { kind: 'accepted' },
    options: FakeBridgeOptions = {},
  ) {
    this.scenario = initialScenario;
    this.now = options.now ?? (() => new Date());
    this.prefix = options.providerIdPrefix ?? 'fake';
    this.reconciliationProviderId = options.providerId ?? 'deterministic-fake';
  }

  setScenario(scenario: FakeBridgeScenarioInput): void {
    this.scenario = scenario;
  }

  getCalls(): readonly FakeBridgeInvocation[] {
    return this.invocations;
  }

  get invocationCount(): number {
    return this.invocations.length;
  }

  /** Returns a defensive snapshot, never the mutable provider-side row. */
  getByClientOrderId(clientOrderId: string): FakeProviderState | null {
    return cloneState(this.ordersByClient.get(clientOrderId));
  }

  getByProviderOrderId(providerOrderId: string): FakeProviderState | null {
    return cloneState(this.ordersByProvider.get(providerOrderId));
  }

  getByIdempotencyKey(idempotencyKey: string): FakeProviderState | null {
    return cloneState(this.ordersByIdempotency.get(idempotencyKey));
  }

  /** All provider-side rows, including a deterministic rejection record. */
  snapshot(): readonly FakeProviderState[] {
    return [...this.ordersByClient.values()].map((state) => cloneState(state)!).filter(Boolean);
  }

  deriveProviderOrderId(clientOrderId: string): string {
    const hash = createHash('sha256').update(clientOrderId).digest('hex').slice(0, 32);
    return `${this.prefix}-${hash}`;
  }

  /**
   * Implements the existing ProviderSubmitCall boundary. Runtime validation is
   * intentional: a structural type assertion by a test cannot authorize a
   * provider invocation. Durable freshness/staleness is still checked by the
   * ledger's committed CAS before this function is reached.
   */
  async submit(barrier: SubmitBarrier): Promise<unknown> {
    assertStructurallyValidBarrier(barrier);

    const barrierKey = `${barrier.intentId}:${barrier.stateVersion}`;
    if (this.consumedBarrierKeys.has(barrierKey)) {
      throw new ProviderMutationError(
        'barrier_not_consumable',
        'The fake provider received a reused submit barrier; no invocation was recorded',
        barrier.intentId,
      );
    }
    // Mark before producing a response. A timeout, lost response, or thrown
    // transport error still consumes the provider-side attempt.
    this.consumedBarrierKeys.add(barrierKey);

    const callIndex = this.invocations.length;
    const resolvedScenario = typeof this.scenario === 'function'
      ? this.scenario(callIndex)
      : this.scenario;
    const canonicalKind = canonicalScenarioKind(resolvedScenario);
    const existing = this.findExisting(barrier);
    const providerOrderId = existing?.providerOrderId ?? this.deriveProviderOrderId(barrier.clientOrderId);

    this.invocations.push({
      barrierIntentId: barrier.intentId,
      clientOrderId: barrier.clientOrderId,
      idempotencyKey: barrier.idempotencyKey,
      providerOrderId,
      scenario: resolvedScenario,
      at: this.now().toISOString(),
    });

    // Transport failures and an absent response do not manufacture a provider
    // order. `accepted_then_timeout` is the explicit exception below: it first
    // persists provider-side acceptance, then loses the response.
    if (canonicalKind === 'timeout') {
      throw transportError('timeout', 'simulated timeout');
    }
    if (canonicalKind === 'connection_failure') {
      throw transportError('connection_failure', 'simulated connection failure');
    }
    if (canonicalKind === 'lost_response') return null;

    if (canonicalKind === 'accepted_then_timeout') {
      const state = existing ?? this.createAndStoreState(barrier, 'accepted');
      void state;
      throw transportError('timeout', 'simulated timeout after provider acceptance');
    }

    // A provider-side duplicate is a provider invocation, unlike a logical
    // duplicate handled by ProviderMutationLedger.prepareSubmit. It reuses the
    // existing provider identity and never creates a second provider row.
    if (existing && (canonicalKind === 'provider_duplicate' || canonicalKind === 'accepted')) {
      return this.responseForExisting(existing, barrier, resolvedScenario);
    }

    switch (canonicalKind) {
      case 'accepted': {
        const status = scenarioStatusOverride(resolvedScenario) ?? 'accepted';
        const state = existing ?? this.createAndStoreState(barrier, status);
        return this.responseForExisting(state, barrier, resolvedScenario);
      }
      case 'rejected': {
        const status = scenarioStatusOverride(resolvedScenario) ?? 'rejected';
        if (!existing) this.createAndStoreState(barrier, status);
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: null,
          status,
        };
      }
      case 'provider_duplicate': {
        // A duplicate with no prior row is still deterministic: retain one
        // provider-side row and report the existing order, never a second one.
        // `duplicate_reported` is fake-side diagnostic state only; the wire
        // response remains an accepted-vocabulary status for normalization.
        const state = existing ?? this.createAndStoreState(barrier, 'duplicate_reported');
        return this.responseForExisting(state, barrier, resolvedScenario);
      }
      case 'credential_leak': {
        const state = existing ?? this.createAndStoreState(barrier, 'accepted');
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: state.providerOrderId,
          status: 'accepted',
          // Deliberately hostile. normalizeSubmitOutcome must reject this field;
          // the fake never persists it.
          receipt: { providerOrderId: state.providerOrderId, token: 'provider-secret-token' },
        };
      }
      case 'identity_verification_failed': {
        // The provider may have accepted, but its response names another order.
        // The mismatch must remain visible to normalization instead of binding
        // the provider ticket to the wrong VeltrixEye identity.
        const state = existing ?? this.createAndStoreState(barrier, 'accepted');
        return {
          clientOrderId: 've-000000000000000000000000',
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: state.providerOrderId,
          status: 'accepted',
        };
      }
      case 'unknown_provider_status': {
        const state = existing ?? this.createAndStoreState(barrier, 'unknown');
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: state.providerOrderId,
          status: 'TOTALLY_UNKNOWN',
        };
      }
      case 'malformed_response':
        return { unexpected: true };
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Deterministic reconciliation lookup/snapshot                             */
  /* ------------------------------------------------------------------------ */

  /**
   * Lookup uses exactly one stable selector. No absence is converted into a
   * rejection: missing returns `not_found`, while an unreadable provider state
   * returns `uncertain`.
   */
  lookup(selector: FakeReconciliationSelector): FakeReconciliationLookup {
    const keys = [selector.providerOrderId, selector.clientOrderId, selector.idempotencyKey]
      .filter((value): value is string => typeof value === 'string');
    if (keys.length !== 1) {
      throw new Error('Fake Bridge reconciliation lookup requires exactly one selector');
    }

    const state = selector.providerOrderId !== undefined
      ? this.ordersByProvider.get(selector.providerOrderId)
      : selector.clientOrderId !== undefined
        ? this.ordersByClient.get(selector.clientOrderId)
        : this.ordersByIdempotency.get(selector.idempotencyKey!);

    const observedAt = this.now().toISOString();
    if (this.reconciliationScenario === 'provider_unavailable') {
      return lookupResult({
        outcome: 'uncertain',
        status: 'uncertain',
        statusUncertain: true,
        requiresOperatorResolution: true,
        providerUnavailable: true,
        observedAt,
        order: state,
      });
    }

    if (!state) {
      if (this.reconciliationScenario !== 'normal') {
        return lookupResult({
          outcome: 'uncertain',
          status: 'uncertain',
          statusUncertain: true,
          requiresOperatorResolution: true,
          observedAt,
          order: null,
        });
      }
      return lookupResult({
        outcome: 'not_found',
        status: null,
        statusUncertain: false,
        requiresOperatorResolution: true,
        observedAt,
        order: null,
      });
    }

    if (this.reconciliationScenario !== 'normal' || state.status === 'unknown') {
      return lookupResult({
        outcome: 'uncertain',
        status: 'uncertain',
        statusUncertain: true,
        requiresOperatorResolution: true,
        observedAt,
        order: state,
      });
    }

    const status = snapshotStatusFor(state.status);
    return lookupResult({
      outcome: 'matched',
      status,
      statusUncertain: false,
      requiresOperatorResolution: false,
      observedAt,
      order: state,
    });
  }

  lookupByClientOrderId(clientOrderId: string): FakeReconciliationLookup {
    return this.lookup({ clientOrderId });
  }

  lookupByIdempotencyKey(idempotencyKey: string): FakeReconciliationLookup {
    return this.lookup({ idempotencyKey });
  }

  lookupByProviderOrderId(providerOrderId: string): FakeReconciliationLookup {
    return this.lookup({ providerOrderId });
  }

  /** Set a deterministic lookup/snapshot fault without changing ledger state. */
  setReconciliationScenario(scenario: FakeReconciliationScenario): void {
    this.reconciliationScenario = scenario;
  }

  getReconciliationScenario(): FakeReconciliationScenario {
    return this.reconciliationScenario;
  }

  /**
   * Provider-neutral normalized snapshot for ReconciliationService adapters.
   * `userId` and `executionProfileId` are intentionally accepted as boundary
   * context but do not become fake provider state or database writes.
   */
  getSnapshot(args: {
    userId?: string;
    executionProfileId?: string;
    providerId?: string;
    accountRef?: string | null;
  } = {}): ReconciliationProviderSnapshot {
    void args.userId;
    void args.executionProfileId;

    const retrievedAt = this.now().toISOString();
    if (this.reconciliationScenario === 'provider_unavailable') {
      return {
        providerId: args.providerId ?? this.reconciliationProviderId,
        accountRef: args.accountRef ?? null,
        retrievedAt,
        orders: [],
        positions: [],
        providerUnavailable: true,
        providerUnavailableReason: 'provider_error:unknown',
      };
    }

    const states = [...this.ordersByClient.values()].filter((state) =>
      args.accountRef === undefined || args.accountRef === null || state.accountRef === args.accountRef,
    );
    const forceUncertain = this.reconciliationScenario !== 'normal';
    const orders = states.map((state) => toReconciliationOrder(state, forceUncertain));
    return {
      providerId: args.providerId ?? this.reconciliationProviderId,
      accountRef: args.accountRef ?? null,
      retrievedAt,
      orders,
      positions: [],
      providerUnavailable: false,
    };
  }

  /** Explicit alias for callers that want to distinguish provider state rows from a reconciliation snapshot. */
  getReconciliationSnapshot(args: {
    userId?: string;
    executionProfileId?: string;
    providerId?: string;
    accountRef?: string | null;
  } = {}): ReconciliationProviderSnapshot {
    return this.getSnapshot(args);
  }

  asReconciliationSnapshotProvider(): {
    getSnapshot(args: { userId: string; executionProfileId: string; providerId: string }): Promise<ReconciliationProviderSnapshot>;
  } {
    return {
      getSnapshot: async (args) => this.getSnapshot(args),
    };
  }

  reset(): void {
    this.ordersByClient.clear();
    this.ordersByProvider.clear();
    this.ordersByIdempotency.clear();
    this.invocations.length = 0;
    this.consumedBarrierKeys.clear();
    this.reconciliationScenario = 'normal';
  }

  /* ------------------------------------------------------------------------ */
  /* Private provider-state operations                                        */
  /* ------------------------------------------------------------------------ */

  private findExisting(barrier: SubmitBarrier): FakeProviderState | null {
    return this.ordersByClient.get(barrier.clientOrderId)
      ?? this.ordersByIdempotency.get(barrier.idempotencyKey)
      ?? null;
  }

  private createAndStoreState(barrier: SubmitBarrier, status: FakeProviderOrderStatus): FakeProviderState {
    const now = this.now().toISOString();
    const state: FakeProviderState = {
      providerOrderId: this.deriveProviderOrderId(barrier.clientOrderId),
      clientOrderId: barrier.clientOrderId,
      idempotencyKey: barrier.idempotencyKey,
      accountRef: barrier.accountRef,
      status,
      filledQuantity: null,
      averagePrice: null,
      createdAt: now,
      updatedAt: now,
    };
    this.ordersByClient.set(state.clientOrderId, state);
    this.ordersByProvider.set(state.providerOrderId, state);
    this.ordersByIdempotency.set(state.idempotencyKey, state);
    return state;
  }

  private responseForExisting(
    state: FakeProviderState,
    barrier: SubmitBarrier,
    scenario: FakeBridgeScenario,
  ): Record<string, unknown> {
    const clientMatches = state.clientOrderId === barrier.clientOrderId;
    const idempotencyMatches = state.idempotencyKey === barrier.idempotencyKey;
    const status = scenarioStatusOverride(scenario) ?? responseStatusFor(state.status);
    return {
      // A provider-side identity collision is not silently rebound: returning
      // the stored identity lets the shared normalizer produce uncertainty.
      clientOrderId: clientMatches ? barrier.clientOrderId : state.clientOrderId,
      idempotencyKey: idempotencyMatches ? barrier.idempotencyKey : state.idempotencyKey,
      accountRef: state.accountRef,
      providerOrderId: state.status === 'rejected' ? null : state.providerOrderId,
      status,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* DeterministicFakeProvider — thin adapter for ledger tests                  */
/* -------------------------------------------------------------------------- */

export class DeterministicFakeProvider {
  constructor(private readonly bridge: FakeBridge) {}

  get fakeBridge(): FakeBridge {
    return this.bridge;
  }

  asSubmitCall(): ProviderSubmitCall {
    return (barrier) => this.bridge.submit(barrier);
  }

  asReconciliationSnapshotProvider(): ReturnType<FakeBridge['asReconciliationSnapshotProvider']> {
    return this.bridge.asReconciliationSnapshotProvider();
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

type CanonicalScenarioKind =
  | 'accepted'
  | 'rejected'
  | 'provider_duplicate'
  | 'timeout'
  | 'connection_failure'
  | 'lost_response'
  | 'malformed_response'
  | 'unknown_provider_status'
  | 'credential_leak'
  | 'identity_verification_failed'
  | 'accepted_then_timeout';

function canonicalScenarioKind(scenario: FakeBridgeScenario): CanonicalScenarioKind {
  switch (scenario.kind) {
    case 'accept':
    case 'accepted':
      return 'accepted';
    case 'reject':
    case 'rejected':
      return 'rejected';
    case 'transport_failure':
    case 'connection_failure':
      return 'connection_failure';
    case 'lost':
    case 'lost_response':
      return 'lost_response';
    case 'malformed':
    case 'malformed_response':
      return 'malformed_response';
    case 'unknown_status':
    case 'unknown_provider_status':
      return 'unknown_provider_status';
    case 'identity_mismatch':
    case 'identity_verification_failed':
      return 'identity_verification_failed';
    default:
      return scenario.kind;
  }
}

function scenarioStatusOverride(scenario: FakeBridgeScenario): FakeProviderOrderStatus | null {
  if (scenario.kind === 'accepted' || scenario.kind === 'accept' || scenario.kind === 'rejected' || scenario.kind === 'reject' || scenario.kind === 'provider_duplicate') {
    return scenario.status ?? null;
  }
  return null;
}

function responseStatusFor(status: FakeProviderOrderStatus): string {
  if (status === 'unknown') return 'TOTALLY_UNKNOWN';
  if (status === 'duplicate_reported') return 'accepted';
  return status;
}

function snapshotStatusFor(status: FakeProviderOrderStatus): BridgeNormalizedStatus {
  switch (status) {
    case 'requested':
      return 'submitted';
    case 'placed':
    case 'accepted':
    case 'duplicate_reported':
      return 'accepted';
    case 'partial':
      return 'partially_filled';
    case 'filled':
      return 'filled';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'unknown':
      return 'uncertain';
  }
}

function toReconciliationOrder(state: FakeProviderState, forceUncertain: boolean): ReconciliationProviderOrder {
  const uncertain = forceUncertain || state.status === 'unknown';
  if (uncertain) {
    return {
      providerOrderId: state.providerOrderId,
      clientOrderId: state.clientOrderId,
      idempotencyKey: state.idempotencyKey,
      status: 'uncertain',
      statusUncertain: true,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }
  return {
    providerOrderId: state.providerOrderId,
    clientOrderId: state.clientOrderId,
    idempotencyKey: state.idempotencyKey,
    status: snapshotStatusFor(state.status),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

function lookupResult(args: {
  outcome: BridgeReconciliationOutcome;
  status: BridgeNormalizedStatus | null;
  statusUncertain?: boolean;
  requiresOperatorResolution?: boolean;
  providerUnavailable?: boolean;
  observedAt: string;
  order: FakeProviderState | null | undefined;
}): FakeReconciliationLookup {
  const statusUncertain = args.statusUncertain === true;
  const order = cloneState(args.order);
  const outcome = args.outcome;
  return Object.freeze({
    outcome,
    status: args.status,
    providerStatus: args.status,
    statusUncertain,
    requiresReconciliation: outcome !== 'matched' || statusUncertain,
    requiresOperatorResolution: args.requiresOperatorResolution === true || outcome !== 'matched',
    providerUnavailable: args.providerUnavailable === true,
    providerOrderId: order?.providerOrderId ?? null,
    clientOrderId: order?.clientOrderId ?? null,
    idempotencyKey: order?.idempotencyKey ?? null,
    observedAt: args.observedAt,
    order,
  });
}

function cloneState(state: FakeProviderState | undefined | null): FakeProviderState | null {
  return state ? Object.freeze({ ...state }) : null;
}

function transportError(code: 'timeout' | 'connection_failure', message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function assertStructurallyValidBarrier(barrier: SubmitBarrier): void {
  const value = barrier as unknown as Record<string, unknown>;
  const fail = (message: string): never => {
    throw new ProviderMutationError('barrier_not_consumable', `${message}; no fake provider invocation is permitted`, typeof value.intentId === 'string' ? value.intentId : undefined);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('SubmitBarrier is malformed');
  if (value.providerCallPermitted !== true) return fail('SubmitBarrier is not provider-call permitted');
  for (const field of ['intentId', 'clientOrderId', 'idempotencyKey', 'requestHash', 'userId', 'executionProfileId', 'providerSlug', 'environment']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) return fail(`SubmitBarrier.${field} is invalid`);
  }
  const clientOrderId = validateBridgeClientOrderId(value.clientOrderId);
  if (!clientOrderId.ok) return fail('SubmitBarrier.clientOrderId is not a durable VeltrixEye identity');
  if (!isHex64(value.idempotencyKey) || !isHex64(value.requestHash)) return fail('SubmitBarrier identity hashes are invalid');
  if (value.environment !== 'paper' && value.environment !== 'demo') return fail('SubmitBarrier.environment is invalid');
  if (value.accountRef !== null && (typeof value.accountRef !== 'string' || value.accountRef.length === 0)) return fail('SubmitBarrier.accountRef is invalid');
  if (typeof value.attempt !== 'number' || !Number.isSafeInteger(value.attempt) || value.attempt < 1) return fail('SubmitBarrier.attempt is invalid');
  if (typeof value.stateVersion !== 'number' || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1) return fail('SubmitBarrier.stateVersion is invalid');
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
