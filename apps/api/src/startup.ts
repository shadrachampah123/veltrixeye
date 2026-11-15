/**
 * API startup reliability helpers.
 *
 * These utilities make the boot sequence observable without changing its
 * semantics: every phase is timed, every database wait is bounded, and a
 * failure names the phase that failed and how long it ran before failing.
 *
 * The database readiness probe is a raw socket connection (TCP or Unix
 * domain) rather than a pooled `SELECT 1`. `node-postgres` (pg 8.x) has no
 * query cancellation, so racing `pool.query()` against a timer leaves the
 * underlying query running: retries accumulate outstanding queries and
 * `pool.end()` then blocks on them. A raw socket probe is hard-bounded by a
 * timer and its socket is always `destroy()`-ed, which reliably closes the
 * connection (verified) — so no probe can linger, accumulate, or block
 * `pool.end()`. The authoritative `SELECT 1` readiness check remains in
 * `GET /api/health/ready`; this probe only gates boot on database
 * reachability, and `runMigrations` follows immediately to surface any
 * deeper unavailability.
 *
 * Supported connection-string formats for the probe:
 *  - `postgres://[user:password@]host[:port][/db]` — probed over TCP to
 *    `host:port` (default port 5432). This is the format every deployment
 *    this codebase uses (managed Postgres, embedded Postgres).
 *  - `postgres:///path/to/socket` (empty host) — probed over a Unix domain
 *    socket at `path`. Also genuinely cancellable via socket `destroy()`.
 * A connection string with neither a host nor a socket path cannot be probed
 * and fails the readiness check with a clear, credential-free error.
 *
 * Everything logged here is secret-free: no connection string, no provider
 * key, no tenant identifier, no raw error object or stack. Error messages are
 * passed through `sanitizeErrorMessage`, which redacts connection strings,
 * credential key/value pairs and bearer tokens before they are emitted. Only
 * phase names, attempt counts, durations and sanitized messages appear.
 */
import net from 'node:net';
import type pg from 'pg';

/** Minimal structured logger (compatible with `console`). */
export interface StartupLogger {
  info(message: string): void;
  error(message: string): void;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_SLEEP_MS = 1_000;
const DEFAULT_PG_PORT = 5432;
const MAX_SANITIZED_MESSAGE_LENGTH = 200;

export interface WaitForDatabaseOptions {
  /**
   * Hard timeout for each readiness probe. A probe that does not complete
   * within this window is abandoned and its socket is destroyed.
   */
  probeTimeoutMs?: number;
  /** Delay between retry attempts (milliseconds). */
  sleepMs?: number;
}

export interface WaitForDatabaseResult {
  /** How many probe attempts were needed before success. */
  attemptsUsed: number;
  /** Total wall-clock time spent waiting, in milliseconds. */
  elapsedMs: number;
}

/**
 * Wait for the database to accept connections, retrying with bounded, timed
 * attempts.
 *
 * - Each probe is a raw socket connect bounded by `probeTimeoutMs`; on expiry
 *   the probe socket is destroyed so it cannot linger or accumulate.
 * - Each attempt and the final outcome are logged with timing so a slow or
 *   unreachable database is visible in the startup log.
 * - On final failure the thrown error names the attempt count and total
 *   elapsed time, and the pool is ended before throwing.
 */
export async function waitForDatabase(
  pool: pg.Pool,
  attempts: number,
  options: WaitForDatabaseOptions = {},
  logger: StartupLogger = console,
): Promise<WaitForDatabaseResult> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const sleepMs = options.sleepMs ?? DEFAULT_RETRY_SLEEP_MS;
  const startedAt = Date.now();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const attemptStart = Date.now();
    try {
      await probeDatabase(pool, probeTimeoutMs);
      const elapsedMs = Date.now() - startedAt;
      if (attempt > 1) {
        logger.info(`[startup] database ready after ${attempt} attempt(s) in ${elapsedMs}ms`);
      }
      return { attemptsUsed: attempt, elapsedMs };
    } catch (err) {
      lastErr = err;
      const attemptElapsed = Date.now() - attemptStart;
      logger.info(
        `[startup] database not ready (attempt ${attempt}/${attempts}, ${attemptElapsed}ms): ` +
          `${messageOf(err)}`,
      );
      if (attempt < attempts) {
        await sleep(sleepMs);
      }
    }
  }

  await pool.end().catch(() => {});
  const elapsedMs = Date.now() - startedAt;
  throw new Error(
    `Could not connect to the database after ${attempts} attempt(s) in ${elapsedMs}ms: ` +
      `${messageOf(lastErr)}`,
  );
}

/**
 * Time an async boot phase and report its outcome.
 *
 * Logs a start line, a completion line with the duration on success, and a
 * phase-specific failure line (with duration) before rethrowing on error. The
 * failure line contains only the sanitized error message — never the raw
 * error object or its stack — so the secret-free logging guarantee holds.
 */
export async function timePhase<T>(
  phase: string,
  fn: () => Promise<T>,
  logger: StartupLogger = console,
): Promise<T> {
  const start = Date.now();
  logger.info(`[startup] ${phase} start`);
  try {
    const result = await fn();
    logger.info(`[startup] ${phase} done in ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    logger.error(
      `[startup] ${phase} FAILED after ${Date.now() - start}ms: ${messageOf(err)}`,
    );
    throw err;
  }
}

/**
 * Run one readiness probe against the database described by the pool's
 * connection string. The probe target is resolved to a raw socket (TCP or
 * Unix domain); there is no pooled-query fallback, because a pooled query
 * cannot be cancelled and would accumulate across retries.
 */
async function probeDatabase(pool: pg.Pool, timeoutMs: number): Promise<void> {
  const target = parseProbeTarget(pool.options.connectionString);
  if (!target) {
    throw new Error(
      'Database probe: unsupported connection-string format (expected ' +
        "'postgres://host:port/db' or 'postgres:///socket-path').",
    );
  }
  await probeSocket(target, timeoutMs);
}

/** A probe target: either a TCP `host:port` or a Unix domain socket `path`. */
export type ProbeTarget = { host: string; port: number } | { path: string };

/**
 * Extract a probe target from a `postgres://` connection string.
 *
 * - A non-empty host yields a TCP target (`host`, default port 5432).
 * - An empty host with a non-empty path yields a Unix domain socket target.
 * - Anything else (or an unparseable string) yields `null`, which the probe
 *   rejects with a clear, credential-free error.
 */
function parseProbeTarget(connectionString: string | undefined): ProbeTarget | null {
  if (!connectionString) return null;
  try {
    const url = new URL(connectionString);
    if (url.hostname) {
      const port = url.port ? Number(url.port) : DEFAULT_PG_PORT;
      if (!Number.isFinite(port) || port <= 0) return null;
      return { host: url.hostname, port };
    }
    // Empty host: treat the path as a Unix domain socket path.
    const rawPath = url.pathname && url.pathname !== '/' ? url.pathname : null;
    if (rawPath) {
      let socketPath: string;
      try {
        socketPath = decodeURIComponent(rawPath);
      } catch {
        socketPath = rawPath;
      }
      return { path: socketPath };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A single bounded socket probe (TCP or Unix domain). `connect` is injectable
 * so the timeout and cleanup paths can be tested deterministically without a
 * real hanging network.
 *
 * The returned promise settles on the first of: `connect`, `error`, or the
 * hard timeout. In every path the socket is `destroy()`-ed, which reliably
 * closes the connection, so no probe socket is ever left outstanding.
 */
export function probeSocket(
  target: ProbeTarget,
  timeoutMs: number,
  connect: (options: net.NetConnectOpts) => net.Socket = net.connect,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const options: net.NetConnectOpts =
      'host' in target ? { host: target.host, port: target.port } : { path: target.path };
    const socket = connect(options);
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always tear the socket down: destroy() reliably closes the
      // connection, cancelling any in-flight connect and freeing the
      // resource so nothing accumulates across retries.
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error(`database probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('connect', () => finish());
    socket.once('error', (err: Error) => finish(err));
  });
}

/**
 * Render an error as a secret-safe, single-line message.
 *
 * The raw error object and its stack are never returned. The underlying
 * message is passed through `sanitizeErrorMessage` so connection strings,
 * credential key/value pairs and bearer tokens cannot leak into logs.
 */
export function messageOf(err: unknown): string {
  let raw: string;
  if (err instanceof Error) raw = err.message;
  else if (typeof err === 'string') raw = err;
  else {
    try {
      raw = String(err);
    } catch {
      return 'unknown error';
    }
  }
  return sanitizeErrorMessage(raw);
}

/**
 * Redact sensitive values from an error message before it is logged.
 *
 * Redacts, in order:
 *  - any `scheme://...` URL (covers `postgres://user:pass@host/db`,
 *    `https://...`, etc.) — connection strings and their userinfo;
 *  - `Bearer <token>` headers (before the key/value rule, so an
 *    `Authorization: Bearer <token>` header is fully covered);
 *  - `key=value` / `key: value` pairs whose key is a credential-like name
 *    (password, token, secret, api key, authorization, ...).
 *
 * The result is whitespace-collapsed and length-capped. An empty result
 * falls back to a generic message so nothing sensitive is ever emitted.
 */
export function sanitizeErrorMessage(raw: string): string {
  let out = raw;
  // Redact URLs (connection strings, HTTP URLs, ...) entirely.
  out = out.replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"<>]+/g, '[redacted:connection-string]');
  // Redact bearer tokens before the key/value rule, so an
  // `Authorization: Bearer <token>` header is fully covered.
  out = out.replace(/\bBearer\s+[^\s,;'"]+/gi, 'Bearer [redacted]');
  // Redact credential key/value pairs (case-insensitive key).
  out = out.replace(
    /\b(password|passwd|pwd|token|secret|api[_-]?key|apikey|api[_-]?secret|authorization|auth|credential|credentials|private[_-]?key|client[_-]?secret|user|username)\b\s*[=:]\s*([^\s,;'"]+)/gi,
    (match: string, key: string, value: string) => {
      // Skip values that are not secrets: a bare `Bearer` word is left for
      // the bearer rule (so `Authorization: Bearer <token>` redacts once),
      // and an already-redacted marker is not re-processed.
      if (value.toLowerCase() === 'bearer' || /^\[redacted/.test(value)) return match;
      return `${key}=[redacted]`;
    },
  );
  // Collapse whitespace and cap length.
  out = out.replace(/\s+/g, ' ').trim();
  if (out.length > MAX_SANITIZED_MESSAGE_LENGTH) {
    out = out.slice(0, MAX_SANITIZED_MESSAGE_LENGTH) + '…';
  }
  if (out === '') out = 'unknown error';
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
