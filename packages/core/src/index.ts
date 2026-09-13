// Database
export { createPool, type DatabaseConfig } from './db/pool.js';
export {
  runMigrations,
  MIGRATIONS_DIR,
  type MigrationRecord,
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

// Market data / provider abstraction
export {
  createProviderRegistry,
  ProviderRegistry,
  type RegisteredProviderInfo,
} from './market-data/registry.js';

// Scoring (foundation re-exports)
export { qualityGrade, QUALITY_GRADE_BANDS } from '@veltrixeye/contracts';
