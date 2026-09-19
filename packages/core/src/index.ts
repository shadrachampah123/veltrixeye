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
export { SessionService, MAX_SESSIONS_LISTED, type SessionRecord, type NewSessionMeta } from './auth/sessions.js';
export { AuditService, readAuditEvents, type AuditEntry } from './audit.js';

// Strategies
export { StrategyService, type StrategyAuditMeta } from './strategies/strategies.js';
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

// Deterministic backtesting (M6 Phase 1: pure engine; Phase 2: service + canonical hash)
export { runBacktest } from './backtest/engine.js';
export { BacktestService } from './backtest/service.js';
export {
  computeConfigHash,
  isValidConfigHash,
  CONFIG_HASH_RE as BACKTEST_CONFIG_HASH_RE,
} from './backtest/canonical.js';

// Setup alerts (M6 Phase 1: schema; Phase 2: service; Phase 3: stub sender)
export { AlertService } from './alerts/service.js';
export {
  StubAlertSender,
  NonStubSenderError,
  alertPayloadHash,
  canonicalize as canonicalizeAlertPayload,
  ALERT_PAYLOAD_HASH_RE,
  type AlertSender,
  type AlertSendRequest,
  type AlertSendResult,
} from './alerts/sender.js';

// Notification delivery pipeline (M7.3: outbox + worker + provider adapters)
export {
  NotificationOutbox,
  toNotificationDto,
  type Queryable,
  type NotificationJobRow,
  type EnqueueAlertNotificationArgs,
  type EnqueueResult,
  type AttemptResult,
  type CleanupPolicy,
  type OutboxDepth,
} from './notifications/outbox.js';
export {
  NotificationProviderRegistry,
  createNotificationProviderRegistry,
  type NotificationProvider,
  type NotificationOutcome,
  type NotificationSendRequest,
  type NotificationSendResult,
  type RegisteredNotificationProviderInfo,
} from './notifications/provider.js';
export {
  renderAlertNotification,
  notificationPayloadHash,
  notificationIdempotencyKey,
  formatPrice as formatNotificationPrice,
  NOTIFICATION_HASH_RE,
  type RenderAlertNotificationArgs,
} from './notifications/render.js';
export {
  DeliveryWorker,
  backoffDelayMs,
  DEFAULT_DELIVERY_RETRY_POLICY,
  type DeliveryRetryPolicy,
  type DeliveryWorkerLogger,
  type DeliveryWorkerOptions,
  type WorkerRunResult,
  type WorkerMaintenanceResult,
} from './notifications/worker.js';
export {
  createSmtpEmailProvider,
  isSmtpConfigured,
  classifySmtpError,
  buildMessageId,
  SMTP_PROVIDER_NAME,
  type SmtpEmailConfig,
  type SmtpEmailProvider,
} from './notifications/email.js';
export {
  createWebhookNotificationProvider,
  WEBHOOK_PROVIDER_NAME,
  type WebhookProviderConfig,
  type WebhookNotificationProvider,
} from './notifications/webhook.js';
export {
  createPushNotificationProvider,
  PUSH_PROVIDER_NAME,
  type PushProviderConfig,
  type PushNotificationProvider,
} from './notifications/push.js';
export { resolveWebhookDestination, isUnsafeAddress, type ResolvedWebhookDestination } from './notifications/webhook-security.js';
export {
  NotificationPreferenceService,
  type NotificationDeliveryTarget,
  type PreferenceQueryable,
} from './notifications/preferences.js';
export { redactSecrets, describeError, REDACTED, MAX_ERROR_CHARS } from './notifications/redact.js';
export {
  EnvKeySecretManager,
  NoopSecretManager,
  createSecretManager,
  looksEncrypted,
  SECRET_MANAGER_KEY_VERSION,
  type SecretManager,
  type EncryptedSecret,
  SecretManagerError,
} from './notifications/secret-manager.js';

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

// Billing / Entitlements
export * from './billing/index.js';

// Live scanner (M7.5) — production market-data and scanner pipeline
export * from './scanner/index.js';

// Execution architecture (M8.1) — safety boundary only; no provider can trade
export * from './execution/index.js';

// Risk management engine (M8.2) — server-authoritative, fail-closed; does not execute
export * from './risk/index.js';

