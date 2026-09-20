/**
 * Ambient declarations for scripts/db/embedded.mjs — dev/test infrastructure
 * only; the product never imports this module. Keep this file in sync with
 * the runtime exports of embedded.mjs.
 */

export interface EmbeddedPostgresOptions {
  dataDir: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Minimal view of the postmaster child process tracked by embedded-postgres. */
export interface EmbeddedPostgresChild {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** The embedded-postgres cluster instance managed by `startEmbeddedPostgres`. */
export interface EmbeddedPostgresInstance {
  /** Tracked postmaster child; `undefined` once stopped or auto-cleared. */
  process?: EmbeddedPostgresChild | undefined;
  /** Native embedded-postgres shutdown (unbounded; prefer `stopEmbeddedPostgres`). */
  stop(): Promise<void>;
}

export interface EmbeddedPostgresHandle {
  /** Underlying embedded-postgres cluster instance (test infra use only). */
  db: EmbeddedPostgresInstance;
  /** Connection URL for the bootstrapped database. */
  dbUrl: string;
  /**
   * Stop the Postgres instance via the bounded shutdown path. Errors during
   * shutdown are logged rather than thrown, preserving the historical API.
   */
  stop: () => Promise<void>;
}

export interface StopEmbeddedPostgresOptions {
  /** Upper bound (ms) for the graceful `db.stop()` attempt before force-kill. */
  gracefulTimeoutMs?: number;
  /** Upper bound (ms) for confirming termination after a force-kill. */
  forceKillTimeoutMs?: number;
  /** Interval (ms) used while polling for process termination. */
  pollIntervalMs?: number;
}

export interface RemoveDirRobustOptions {
  /** Retries after the first attempt (default 8). */
  maxRetries?: number;
  /** Initial backoff delay in ms (default 25). */
  retryDelayMs?: number;
  /** Backoff ceiling in ms (default 400). */
  maxDelayMs?: number;
  /** Exponential backoff multiplier (default 2). */
  backoffFactor?: number;
}

/** initdb flags for a given platform (`win32` uses `--no-locale`). */
export function initdbFlagsFor(platform?: string): string[];

/** initdb flags for the current platform. */
export const INITDB_FLAGS: readonly string[];

/**
 * Bounded, leak-proof shutdown of an embedded-postgres instance:
 * safe against already-reaped/absent children, hanging `db.stop()` calls,
 * and Windows taskkill races. Throws only for genuine shutdown failures.
 */
export function stopEmbeddedPostgres(
  db: EmbeddedPostgresInstance | null | undefined,
  options?: StopEmbeddedPostgresOptions,
): Promise<void>;

/**
 * Recursive synchronous directory removal with bounded retry/backoff for
 * transient Windows filesystem errors (EPERM/EBUSY/EACCES/ENOTEMPTY/EAGAIN).
 * Non-retryable errors are rethrown immediately; the final retry error is
 * rethrown once the bounded retries are exhausted. Missing paths are a no-op.
 */
export function removeDirRobust(target: string, options?: RemoveDirRobustOptions): void;

/**
 * Boot a throwaway embedded Postgres instance (dev/test infrastructure only).
 * Complements `scripts/db/embedded.mjs`.
 */
export function startEmbeddedPostgres(
  options: EmbeddedPostgresOptions,
): Promise<EmbeddedPostgresHandle>;
