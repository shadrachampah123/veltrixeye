/**
 * M8.1 — automated trading execution architecture.
 *
 * Architecture + safety boundary ONLY: no provider registered here can
 * trade, no order is ever submitted, and automation stays OFF for every plan.
 */
export {
  allowedOrderTransitions,
  assertOrderTransition,
  isOrderTransitionAllowed,
  isOrderStatus,
  isOrderTerminal,
} from './order-machine.js';
export { ExecutionProviderRegistry, createExecutionProviderRegistry, type RegisteredExecutionProviderInfo } from './registry.js';
export { createPaperExecutionProvider } from './paper.js';
export { KillSwitchService } from './kill-switch.js';
export { ExecutionProfileService, toProfileDto, type ExecutionProfileRow } from './profiles.js';
export { AutomationService, type AutomationStatus } from './automation.js';
export { evaluateExecutionGates, type ExecutionGateInput, type ExecutionGateResult } from './gates.js';
export {
  ExecutionIntakeService,
  executionIdempotencyHash,
  deriveClientOrderId,
  EXECUTION_ELIGIBLE_STATES,
  type ExecutionIntakeResult,
  type ExecutionIntakeMeta,
  type ExecutionLogger,
} from './intake.js';
export { ExecutionQueryService } from './queries.js';
