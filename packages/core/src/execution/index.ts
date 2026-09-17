/**
 * M8.1 — automated trading execution architecture (safety boundary).
 * M8.2 wires the risk engine into the intake gates.
 * M8.3 implements the INTERNAL deterministic paper simulator behind that
 * boundary. Still: no broker, no MT5/Exness, no demo account, no credentials,
 * no live path, automation OFF for every plan.
 */
export {
  allowedOrderTransitions,
  assertOrderTransition,
  isOrderTransitionAllowed,
  isOrderStatus,
  isOrderTerminal,
} from './order-machine.js';
export { ExecutionProviderRegistry, createExecutionProviderRegistry, type RegisteredExecutionProviderInfo } from './registry.js';
export {
  createPaperExecutionProvider,
  type PaperSimulatorPort,
} from './paper.js';
export {
  createMT5ExecutionProvider,
  normalizeMT5Error,
  normalizeMT5Order,
  DisabledMT5Transport,
  type MT5Transport,
  type MT5TransportHealth,
  type MT5TransportError,
  type MT5ProviderConfig,
  type MT5AccountSnapshot,
  type MT5SymbolSnapshot,
  type MT5OrderRequest,
  type MT5OrderSnapshot,
  type MT5PositionSnapshot,
} from './mt5.js';
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

/* M8.3 — paper execution simulator (internal only) */
export {
  PaperExecutionService,
  PaperIntegrityError,
  type PaperExecutionServiceDeps,
  type PaperExecutionServiceOptions,
  type PaperFailureMode,
} from './paper-service.js';
export { AuditCollector, type PaperEventEntry, type PaperEventLogger } from './paper-events.js';
export {
  PAPER_COST_MODEL_NONE,
  buildServerExecutionDecision,
  computeEntryFill,
  computeExitFill,
  detectExit,
  exitDecisionSnapshot,
  feeMoney,
  grossRealizedPl,
  impliedRr,
  isUsableCandle,
  moneyPerPriceUnit,
  netRealizedPl,
  paperClientOrderId,
  paperProviderPositionId,
  pipsToPrice,
  signedPriceMoveValue,
  unrealizedPl,
  type DecisionBuildResult,
  type ExitDetection,
  type FillComputation,
  type PaperCandle,
  type PaperCostModel,
  type PaperOrderKind,
  type SetupDecisionSource,
} from './paper-engine.js';
export {
  evaluatePaperSimulationGates,
  type PaperSimulationGateInput,
  type PaperSimulationGateResult,
} from './paper-gates.js';
export {
  CandleStoreMarketPriceSource,
  paperStaleThresholdMs,
  type MarketPriceResult,
  type SimulatorMarketPrice,
  type SimulatorMarketPriceSource,
} from './paper-market.js';
export {
  computeExpectedNetPl,
  reconcileOrderState,
  reconcilePositionState,
  type ReconciliationFillState,
  type ReconciliationOrderState,
  type ReconciliationPositionState,
  type ReconciliationResult,
} from './reconciliation.js';

/* M8.5 — provider-neutral order & position reconciliation */
export {
  ReconciliationService,
  PaperReconciliationSnapshotProvider,
  ProviderReconciliationSnapshotProvider,
  type ReconciliationServiceDeps,
  type ReconciliationSnapshotProvider,
  type TriggerRunOptions,
} from './reconciliation-service.js';
