import {
  ExecutionProviderError,
  PAPER_EXECUTION_PROVIDER_ID,
  PAPER_SIMULATOR_VERSION,
  type ExecutionProvider,
  type ExecutionProviderCapabilities,
  type ExecutionProviderHealth,
  type ExecutionProviderOrderState,
  type ExecutionProviderPositionState,
  type ExecutionSubmitOrderOutcome,
  type ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';

/**
 * M8.3 — the paper execution provider: the INTERNAL simulator behind the M8.1
 * provider boundary.
 *
 * M8.1 shipped this adapter as an honest stub that reported `configured: false`
 * and threw on every trading operation. M8.3 binds it to the in-process paper
 * simulator, so `configured` and `health()` are true — the simulator really
 * exists — while the boundary contract stays exactly as documented:
 *
 *  - NOTHING leaves the process. There is no broker client, no socket, no
 *    credential and no external trading API anywhere in this module. A paper
 *    "order" is an internal database row marked `simulated = true`.
 *  - `submitOrder` REFUSES every request that does not carry a server-issued
 *    `authorizationId` (created by `PaperExecutionService` only after the
 *    server-built decision, the server-issued M8.2 risk decision and every
 *    paper-simulation gate have passed). A caller cannot mint that id, so the
 *    provider is not a way around the gates.
 *  - `cancelOrder` / `modifyOrder` / `closePosition` are not part of the
 *    simulator's contract: the deterministic lifecycle is entry → SL/TP or
 *    explicit close, all driven by the service. They throw rather than
 *    pretend to work.
 *  - no method accepts a client-supplied price, P&L or position size.
 */
export interface PaperSimulatorPort {
  /** Fill a server-authorized paper order (the only mutation entry point). */
  submitAuthorizedOrder(args: {
    authorizationId: string;
    request: ExecutionSubmitOrderRequest;
  }): Promise<ExecutionSubmitOrderOutcome>;
}

export function createPaperExecutionProvider(options?: {
  /** Bound simulator. When absent the adapter reports not-configured. */
  simulator?: PaperSimulatorPort;
  /** Optional clock (tests) — never affects simulated financial values. */
  now?: () => number;
}): ExecutionProvider {
  const simulator = options?.simulator;
  const capabilities: ExecutionProviderCapabilities = {
    modes: ['paper'],
    orderTypes: ['market'],
  };

  const requireSimulator = (op: string): PaperSimulatorPort => {
    if (!simulator) {
      throw new ExecutionProviderError(
        'unavailable',
        `Paper simulator is not bound to the provider (${op})`,
      );
    }
    return simulator;
  };

  return {
    id: PAPER_EXECUTION_PROVIDER_ID,
    name: 'Paper Execution Simulator',
    capabilities,
    configured: Boolean(simulator),

    describe(): Record<string, unknown> {
      // Operator-safe view: paper holds no credential by design.
      return {
        id: PAPER_EXECUTION_PROVIDER_ID,
        modes: capabilities.modes,
        orderTypes: capabilities.orderTypes,
        configured: Boolean(simulator),
        internal: true,
        simulatorVersion: PAPER_SIMULATOR_VERSION,
        notes:
          'Internal deterministic paper simulator (M8.3). No broker, no MT5/Exness, no demo account, no external trading API, no credentials.',
      };
    },

    async health(): Promise<ExecutionProviderHealth> {
      const checkedAt = new Date(options?.now?.() ?? Date.now()).toISOString();
      if (!simulator) {
        return {
          configured: false,
          authenticated: true,
          connected: false,
          available: false,
          healthy: false,
          state: 'unavailable',
          reason: 'paper_simulator_not_bound',
          checkedAt,
        };
      }
      return {
        configured: true,
        authenticated: true,
        connected: true,
        available: true,
        healthy: true,
        state: 'healthy',
        checkedAt,
        detail: { internal: true, simulatorVersion: PAPER_SIMULATOR_VERSION },
      };
    },

    async getAccountInfo() {
      return null;
    },

    async getInstrument() {
      return null;
    },

    async listInstruments() {
      return [];
    },

    async submitOrder(request: ExecutionSubmitOrderRequest): Promise<ExecutionSubmitOrderOutcome> {
      const port = requireSimulator('submitOrder');
      if (!request.authorizationId) {
        throw new ExecutionProviderError(
          'validation',
          'paper orders require a server-issued authorization (the simulator never accepts an unauthorized order)',
        );
      }
      return port.submitAuthorizedOrder({
        authorizationId: request.authorizationId,
        request,
      });
    },

    async cancelOrder(): Promise<void> {
      throw new ExecutionProviderError(
        'unavailable',
        'the paper simulator has no cancellation path: a simulated market order fills or fails deterministically',
      );
    },

    async modifyOrder(): Promise<void> {
      throw new ExecutionProviderError(
        'unavailable',
        'the paper simulator does not modify orders: SL/TP are fixed by the server-issued decision',
      );
    },

    async getOrder(providerOrderId: string): Promise<ExecutionProviderOrderState | null> {
      void providerOrderId;
      throw new ExecutionProviderError(
        'unavailable',
        'paper order reads are owner-scoped and served by GET /api/execution/paper/orders',
      );
    },

    async listOrders(): Promise<ExecutionProviderOrderState[]> {
      // The provider-neutral list cannot express an owner, so it reports
      // nothing rather than leaking every tenant's rows.
      return [];
    },

    async getPosition(): Promise<ExecutionProviderPositionState | null> {
      throw new ExecutionProviderError(
        'unavailable',
        'paper position reads are owner-scoped and served by GET /api/execution/paper/positions',
      );
    },

    async listPositions(): Promise<ExecutionProviderPositionState[]> {
      // Same reasoning as listOrders: owner-scoped reads are served by the
      // paper query surface, never by an unscoped provider call.
      return [];
    },

    async closePosition(): Promise<void> {
      throw new ExecutionProviderError(
        'unavailable',
        'positions are closed through the gated paper service (POST /api/execution/paper/positions/:id/close), never directly',
      );
    },
  };
}
