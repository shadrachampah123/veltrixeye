// Database
export { createPool, type DatabaseConfig } from './db/pool.js';
export {
  runMigrations,
  migrationStatus,
  listMigrationFiles,
  MIGRATIONS_DIR,
  type MigrationFile,
  type MigrationRecord,
  type MigrationStatus,
  type RunMigrationsResult,
} from './db/migrate.js';

// Errors
export { DomainError, Errors, isDomainError } from './errors.js';

// Auth
export { hashPassword, verifyPassword } from './auth/passwords.js';
export { UserService, type CreateUserData } from './auth/users.js';
export { SessionService, type SessionRecord, type NewSessionMeta } from './auth/sessions.js';
export { AuditService, readAuditEvents, type AuditEntry } from './audit.js';

// Strategies
export { StrategyService } from './strategies/strategies.js';
export { validatePublishable, type PublishValidationResult } from './strategies/validation.js';

// Deterministic strategy evaluation (M3)
export {
  EvaluationService,
  requiredWindows,
} from './strategies/evaluation/service.js';
export {
  createEvaluationEngine,
  deriveCandidate,
} from './strategies/evaluation/engine.js';
export {
  CONDITION_HANDLERS,
  parseParams,
  type ConditionHandler,
  type HandlerContext,
  type HandlerResult,
} from './strategies/evaluation/handlers.js';
export {
  atrWilder,
  bufferToPrice,
  candleAnatomy,
  countTouches,
  findFvg,
  findOrderBlock,
  findPivots,
  hourInSession,
  isDisplacement,
  isEngulfing,
  lastPivotHighAbove,
  lastPivotLowBelow,
  levelTolerance,
  pipSizeFor,
  sma,
  structuralTarget,
  structureBias,
  timeInSession,
  SESSION_WINDOWS_UTC,
  LEVEL_TOLERANCE_PCT,
  PIVOT_HALF_WIDTH,
  type Candle as EvaluationCandle,
  type CandleAnatomy,
  type Pivot,
  type Zone,
} from './strategies/evaluation/indicators.js';

// Market data / provider abstraction
export {
  createProviderRegistry,
  ProviderRegistry,
  type RegisteredProviderInfo,
} from './market-data/registry.js';
export { CandleStore, type ResolvedInstrument } from './market-data/candles.js';
export {
  IngestionService,
  mapProviderError,
  missingRanges,
  type BackfillRequest as IngestionBackfillRequest,
  type CandleReadRequest,
} from './market-data/ingestion.js';

// Setup detection + lifecycle (M4)
export { SetupService } from './setups/service.js';
export { allowedTransitions, assertTransition, isTerminalState } from './setups/machine.js';
export { detectionLevels, mirrorPrice, type DetectionLevels } from './setups/levels.js';

// Deterministic backtesting (M6 Phase 1: pure engine only — no service, no API yet)
export { runBacktest } from './backtest/engine.js';

// Scoring (foundation re-exports)
export { qualityGrade, QUALITY_GRADE_BANDS } from '@veltrixeye/contracts';

// Deterministic setup quality scoring (M5)
export { ScoringService } from './scoring/service.js';
export {
  createQualityScoringEngine,
  scoreSetupQuality,
  parseScoringContext,
  M5_COMPONENT_WEIGHTS,
  M5_FAILING_DIRECTION_CAP,
  type M5ComponentName,
} from './scoring/engine.js';
