/**
 * Test-only deterministic fake-bridge support boundary (MEDIUM-2).
 *
 * This module establishes the SMALLEST test-support boundary required for a
 * future stateful fake provider (Gate 9 Fake Bridge). It is intentionally
 * minimal and contains:
 *
 * - provider-side simulated order state (FakeProviderState)
 * - deterministic scenario control (FakeBridgeScenario)
 * - deterministic provider identity (deterministic providerOrderId derivation)
 * - deterministic lookup/snapshot capability (getByClientOrderId, etc.)
 * - invocation tracking (calls, invocationCount)
 *
 * Boundaries:
 * - test-only: not exported from production code (`packages/core/src/execution/index.ts`)
 * - no production provider registration
 * - no network calls
 * - no broker credentials
 * - no MT5 vendor behavior
 * - provider-neutral naming: FakeBridge, DeterministicFakeProvider, FakeProviderState
 * - does NOT implement the full Fake Bridge (no transport, no reconciliation repair, no retry)
 *
 * The future Gate 9 Fake Bridge will be built on top of this state container.
 * For now it is only a deterministic in-memory state holder used by tests.
 */

import { createHash } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/* Deterministic provider identity                                            */
/* -------------------------------------------------------------------------- */

export function deterministicProviderOrderId(clientOrderId: string): string {
  const hash = createHash('sha256').update(clientOrderId).digest('hex').slice(0, 32);
  return `fake-${hash}`;
}

/* -------------------------------------------------------------------------- */
/* Simulated order state                                                     */
/* -------------------------------------------------------------------------- */

export type FakeProviderOrderStatus =
  | 'requested'
  | 'placed'
  | 'accepted'
  | 'partial'
  | 'filled'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'duplicate_reported';

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
/* Deterministic scenario control                                            */
/* -------------------------------------------------------------------------- */

export type FakeBridgeScenario =
  | { kind: 'accept'; status?: FakeProviderOrderStatus }
  | { kind: 'reject'; status?: FakeProviderOrderStatus }
  | { kind: 'provider_duplicate'; status?: FakeProviderOrderStatus }
  | { kind: 'timeout' }
  | { kind: 'connection_failure' }
  | { kind: 'lost_response' }
  | { kind: 'malformed_response' }
  | { kind: 'unknown_status' }
  | { kind: 'credential_leak' }
  | { kind: 'identity_mismatch' };

export type FakeBridgeScenarioFn = (call: number) => FakeBridgeScenario;
export type FakeBridgeScenarioInput = FakeBridgeScenario | FakeBridgeScenarioFn;

export interface FakeBridgeOptions {
  providerIdPrefix?: string;
  now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* FakeBridge — deterministic in-memory state container                      */
/* -------------------------------------------------------------------------- */

export class FakeBridge {
  private readonly ordersByClient = new Map<string, FakeProviderState>();
  private readonly ordersByProvider = new Map<string, FakeProviderState>();
  private readonly ordersByIdempotency = new Map<string, FakeProviderState>();
  private readonly invocations: FakeBridgeInvocation[] = [];
  private scenario: FakeBridgeScenarioInput;
  private readonly now: () => Date;
  private readonly prefix: string;

  constructor(
    initialScenario: FakeBridgeScenarioInput = { kind: 'accept' },
    options: FakeBridgeOptions = {},
  ) {
    this.scenario = initialScenario;
    this.now = options.now ?? (() => new Date());
    this.prefix = options.providerIdPrefix ?? 'fake';
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

  getByClientOrderId(clientOrderId: string): FakeProviderState | null {
    return this.ordersByClient.get(clientOrderId) ?? null;
  }

  getByProviderOrderId(providerOrderId: string): FakeProviderState | null {
    return this.ordersByProvider.get(providerOrderId) ?? null;
  }

  getByIdempotencyKey(idempotencyKey: string): FakeProviderState | null {
    return this.ordersByIdempotency.get(idempotencyKey) ?? null;
  }

  snapshot(): readonly FakeProviderState[] {
    return [...this.ordersByClient.values()].map((s) => Object.freeze({ ...s }));
  }

  deriveProviderOrderId(clientOrderId: string): string {
    const hash = createHash('sha256').update(clientOrderId).digest('hex').slice(0, 32);
    return `${this.prefix}-${hash}`;
  }

  async submit(barrier: { intentId: string; clientOrderId: string; idempotencyKey: string; accountRef: string | null }): Promise<unknown> {
    const callIndex = this.invocations.length;
    const resolvedScenario = typeof this.scenario === 'function' ? (this.scenario as FakeBridgeScenarioFn)(callIndex) : this.scenario;
    const providerOrderId = this.deriveProviderOrderId(barrier.clientOrderId);

    const invocation: FakeBridgeInvocation = {
      barrierIntentId: barrier.intentId,
      clientOrderId: barrier.clientOrderId,
      idempotencyKey: barrier.idempotencyKey,
      providerOrderId,
      scenario: resolvedScenario,
      at: this.now().toISOString(),
    };
    this.invocations.push(invocation);

    const existingByClient = this.ordersByClient.get(barrier.clientOrderId);
    const existingByIdempotency = this.ordersByIdempotency.get(barrier.idempotencyKey);

    if (existingByClient || existingByIdempotency) {
      const existing = existingByClient ?? existingByIdempotency!;
      if (resolvedScenario.kind === 'provider_duplicate') {
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: existing.providerOrderId,
          status: resolvedScenario.status ?? 'accepted',
        };
      }
      return {
        clientOrderId: barrier.clientOrderId,
        idempotencyKey: barrier.idempotencyKey,
        accountRef: barrier.accountRef,
        providerOrderId: existing.providerOrderId,
        status: existing.status,
      };
    }

    switch (resolvedScenario.kind) {
      case 'accept': {
        const state: FakeProviderState = {
          providerOrderId,
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          status: resolvedScenario.status ?? 'accepted',
          filledQuantity: null,
          averagePrice: null,
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        };
        this.store(state);
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId,
          status: state.status,
        };
      }
      case 'reject': {
        const state: FakeProviderState = {
          providerOrderId,
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          status: resolvedScenario.status ?? 'rejected',
          filledQuantity: null,
          averagePrice: null,
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        };
        this.store(state);
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: null,
          status: state.status,
        };
      }
      case 'provider_duplicate': {
        const state: FakeProviderState = {
          providerOrderId,
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          status: 'duplicate_reported',
          filledQuantity: null,
          averagePrice: null,
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        };
        this.store(state);
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId,
          status: resolvedScenario.status ?? 'accepted',
        };
      }
      case 'credential_leak': {
        const state: FakeProviderState = {
          providerOrderId,
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          status: 'accepted',
          filledQuantity: null,
          averagePrice: null,
          createdAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        };
        this.store(state);
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId,
          status: 'accepted',
          receipt: { providerOrderId, token: 'provider-secret-token' },
        };
      }
      case 'identity_mismatch':
        return { clientOrderId: 've-000000000000000000000000', providerOrderId, status: 'accepted' };
      case 'unknown_status':
        return { clientOrderId: barrier.clientOrderId, providerOrderId, status: 'TOTALLY_UNKNOWN' };
      case 'malformed_response':
        return { unexpected: true };
      case 'lost_response':
        return null;
      case 'timeout': {
        const err = new Error('simulated timeout');
        (err as any).code = 'timeout';
        throw err;
      }
      case 'connection_failure': {
        const err = new Error('simulated connection failure');
        (err as any).code = 'connection_failure';
        throw err;
      }
      default:
        return null;
    }
  }

  private store(state: FakeProviderState): void {
    this.ordersByClient.set(state.clientOrderId, state);
    this.ordersByProvider.set(state.providerOrderId, state);
    this.ordersByIdempotency.set(state.idempotencyKey, state);
  }

  reset(): void {
    this.ordersByClient.clear();
    this.ordersByProvider.clear();
    this.ordersByIdempotency.clear();
    this.invocations.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* DeterministicFakeProvider — thin adapter for ledger tests                 */
/* -------------------------------------------------------------------------- */

export class DeterministicFakeProvider {
  constructor(private readonly bridge: FakeBridge) {}

  get fakeBridge(): FakeBridge {
    return this.bridge;
  }

  asSubmitCall(): (barrier: { intentId: string; clientOrderId: string; idempotencyKey: string; accountRef: string | null }) => Promise<unknown> {
    return (barrier) => this.bridge.submit(barrier);
  }
}
