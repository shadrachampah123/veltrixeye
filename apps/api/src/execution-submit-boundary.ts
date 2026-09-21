/**
 * B2 — the production execution submit boundary.
 *
 * This module owns the ONLY construction of the production MT5 execution
 * provider. It binds the existing Gate 9 `ProviderMutationLedger` to the
 * Gate 9-gated MT5 boundary (`createGate9MT5ExecutionProvider`) and exposes
 * the canonical dispatcher (`submitOrderThroughGate9`) as the single
 * provider-submit entry point for the whole application:
 *
 *   - The registered MT5 provider's bare `submitOrder` ALWAYS refuses; no
 *     caller of the provider registry can reach a provider mutation without
 *     Gate 9.
 *   - `submitThroughGate9` is the only sanctioned submit entry: it commits
 *     the durable Gate 9 intent, consumes the single-use `SubmitBarrier`
 *     (M2 CAS) and hands it to the provider, which re-verifies the barrier
 *     against the durable intent row before any transport contact.
 *   - The deployed transport remains `DisabledMT5Transport`: every provider
 *     call still fails closed as `unavailable`, and the boundary records the
 *     outcome as durable Gate 9 uncertainty — never silent success.
 *
 * An ungated MT5 provider cannot be constructed here: the gated factory
 * requires the ledger and throws without it.
 */
import type pg from 'pg';
import {
  createGate9MT5ExecutionProvider,
  DisabledMT5Transport,
  ProviderMutationLedger,
  submitOrderThroughGate9,
  type CanonicalSubmitInput,
  type CanonicalSubmitResult,
  type Gate9SubmitBarrierProvider,
} from '@veltrixeye/core';

export interface ExecutionSubmitBoundary {
  /** The Gate 9 provider-mutation ledger (durable intent/barrier store). */
  readonly ledger: ProviderMutationLedger;
  /** The Gate 9-gated MT5 provider registered in the provider registry. */
  readonly mt5Provider: Gate9SubmitBarrierProvider;
  /** The single canonical provider-submit boundary for production. */
  readonly submitThroughGate9: (
    input: Omit<CanonicalSubmitInput, 'ledger' | 'provider'>,
  ) => Promise<CanonicalSubmitResult>;
}

export function createExecutionSubmitBoundary(pool: pg.Pool): ExecutionSubmitBoundary {
  const ledger = new ProviderMutationLedger(pool);
  // M8.4 production configuration, unchanged: deliberately disabled and
  // unconfigured — no endpoint, SDK, credential, terminal, or network path
  // exists and live is hard-stopped.
  const mt5Provider = createGate9MT5ExecutionProvider(
    new DisabledMT5Transport(),
    {
      enabled: false,
      environment: 'demo',
      broker: null,
      server: null,
      accountRef: null,
      symbols: new Map(),
    },
    { ledger },
  );
  return {
    ledger,
    mt5Provider,
    submitThroughGate9: (input) => submitOrderThroughGate9({ ...input, ledger, provider: mt5Provider }),
  };
}
