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
/* Gate 10 — closed projection of provider health for API responses and persisted records */
export { toSafeProviderHealth, PROVIDER_MISSING_REASON, type SafeExecutionProviderHealth } from './provider-health.js';
/* Gate 9 §7/§26 (R7.4.4) — the single authoritative readiness interpretation */
export {
  READINESS_PROFILES,
  assertExecutionReadiness,
  explicitHealthFlags,
  isExecutionReady,
  readinessRequirements,
  readinessViolationCode,
  resolveExecutionReadiness,
  type ReadinessProfile,
  type ReadinessResolution,
} from './readiness.js';
/* Gate 9 Step 2 — strict pre-provider validation (B2/B5/B6/B7/B9) */
export {
  BRIDGE_DEFAULT_POLICY,
  bridgeOrderIdentityError,
  bridgeQuoteError,
  bridgeReadinessError,
  bridgeVolumeError,
  evaluateBridgeQuote,
  normalizeBridgeProviderStatus,
  validateBridgeInstrument,
  validateBridgeOrderIdentity,
  type BridgeInstrumentOutcome,
  type BridgeReadinessOutcome,
  type BridgeValidationPolicy,
} from './protocol.js';
export {
  createPaperExecutionProvider,
  type PaperSimulatorPort,
} from './paper.js';
export {
  createMT5ExecutionProvider,
  normalizeMT5Error,
  normalizeMT5Order,
  DisabledMT5Transport,
  MT5_TRANSPORT_UNHEALTHY_REASON,
  type MT5Transport,
  type MT5TransportHealth,
  type MT5TransportError,
  type MT5ProviderConfig,
  type MT5ProviderOptions,
  type Gate9BarrierPredicate,
  type MT5AccountSnapshot,
  type MT5SymbolSnapshot,
  type MT5OrderRequest,
  type MT5OrderSnapshot,
  type MT5PositionSnapshot,
} from './mt5.js';
export {
  KillSwitchService,
  type KillSwitchRow,
  type KillSwitchState,
} from './kill-switch.js';
/* M8.6 — safety controls (emergency stop, provenance, circuit-breaker wiring) */
export { SafetyControlsService } from './safety.js';
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

/* M10 Gate 9 — durable provider mutation persistence (submit only, no live transport) */
export {
  ProviderMutationLedger,
  ProviderMutationError,
  classifyTransportFailure,
  PROVIDER_MUTATION_ERROR_CODES,
  type MutationExecutionResult,
  type MutationReservationRecord,
  type OperatorResolutionInput,
  type PrepareSubmitResult,
  type ProviderIntentRecord,
  type ProviderReceiptRecord,
  type ProviderSubmitCall,
  type ProviderSubmitResponse,
  type ReconciliationObservationInput,
  type ReconciliationObservationResult,
  type ResolutionResult,
  type RetryIntentInput,
  type SubmitBarrier,
  type SubmitIntentInput,
  type SubmitOnceResult,
} from './provider-mutations.js';

/* B1 — authorization/composition layer (authorization + composition) */
export {
  ExecutionAuthorizationService,
  type ExecutionAuthorization,
  type ExecutionAuthorizationServiceOptions,
} from './authorization.js';
export {
  ExecutionCompositionService,
  type ExecutionCompositionInput,
  type ExecutionCompositionResult,
} from './composition.js';

/* B2 — the single canonical provider-submit boundary.
 * Wires the existing Gate 9 ledger (prepareSubmit → SubmitBarrier →
 * executeSubmit → consumeSubmitBarrier → provider call) onto the
 * ExecutionProvider interface. No parallel boundary, no alternative
 * authorization scheme, no migration or schema change. */
export {
  submitOrderThroughGate9,
  createSubmitBarrierHandoff,
  type CanonicalSubmitInput,
  type CanonicalSubmitSuccess,
  type CanonicalSubmitError,
  type CanonicalSubmitResult,
  type SubmitBarrierHandoff,
} from './submit-boundary.js';
