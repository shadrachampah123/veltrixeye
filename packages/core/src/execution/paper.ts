import {
  ExecutionProviderError,
  PAPER_EXECUTION_PROVIDER_ID,
  type ExecutionProvider,
  type ExecutionProviderCapabilities,
  type ExecutionProviderHealth,
  type ExecutionProviderOrderState,
  type ExecutionProviderPositionState,
  type ExecutionSubmitOrderOutcome,
  type ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';

/**
 * M8.1 — the paper execution provider BOUNDARY.
 *
 * This adapter exists so M8.3 can drop in a real paper simulator without
 * touching the registry, the intake service, the gates or the API. In M8.1:
 *
 *  - `configured` is false and `health()` reports `not_ready` — honestly:
 *    there is no simulator yet, and nothing may fake readiness;
 *  - every trading operation throws `ExecutionProviderError('unavailable')`,
 *    so even a programming error that reaches a provider call fails loudly
 *    instead of pretending an order exists;
 *  - the adapter holds NO credentials and needs none: paper execution is an
 *    internal simulation, and broker credentials are forbidden platform-wide.
 */
const NOT_READY_REASON = 'paper_execution_simulator_not_implemented';

function notImplemented(op: string): never {
  throw new ExecutionProviderError(
    'unavailable',
    `Paper execution is not available yet (M8.1 provides the boundary only): ${op}`,
  );
}

export function createPaperExecutionProvider(): ExecutionProvider {
  const capabilities: ExecutionProviderCapabilities = {
    modes: ['paper'],
    orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  };

  return {
    id: PAPER_EXECUTION_PROVIDER_ID,
    name: 'Paper Execution',
    capabilities,
    // Honest readiness: the simulator ships in a later M8 milestone.
    configured: false,

    describe(): Record<string, unknown> {
      // Operator-safe view: never any credential (paper has none by design).
      return {
        id: PAPER_EXECUTION_PROVIDER_ID,
        modes: capabilities.modes,
        orderTypes: capabilities.orderTypes,
        configured: false,
        milestone: 'boundary-only in M8.1; simulator deferred',
      };
    },

    async health(): Promise<ExecutionProviderHealth> {
      return { healthy: false, reason: NOT_READY_REASON };
    },

    async submitOrder(_request: ExecutionSubmitOrderRequest): Promise<ExecutionSubmitOrderOutcome> {
      return notImplemented('submitOrder');
    },
    async cancelOrder(_providerOrderId: string): Promise<void> {
      return notImplemented('cancelOrder');
    },
    async modifyOrder(
      _providerOrderId: string,
      _changes: { stopLossPrice?: number | null; takeProfitPrice?: number | null },
    ): Promise<void> {
      return notImplemented('modifyOrder');
    },
    async getOrder(_providerOrderId: string): Promise<ExecutionProviderOrderState | null> {
      return notImplemented('getOrder');
    },
    async listOrders(): Promise<ExecutionProviderOrderState[]> {
      return notImplemented('listOrders');
    },
    async listPositions(): Promise<ExecutionProviderPositionState[]> {
      return notImplemented('listPositions');
    },
    async closePosition(_providerPositionId: string): Promise<void> {
      return notImplemented('closePosition');
    },
  };
}
