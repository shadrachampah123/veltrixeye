// Shared helper: boot a real PostgreSQL instance via the embedded-postgres
// npm package (native binary, no system install). Used by local dev and the
// test suites. The PRODUCT CODE NEVER depends on this — it only connects to
// a DATABASE_URL.
//
// Windows hardening notes (test infrastructure only):
// - `initdb --locale=C.utf8` is not valid on Windows; initdb there needs
//   `--no-locale` instead. Using the wrong flag makes initdb fail, which used
//   to take down the whole test process (see the shutdown path below).
// - embedded-postgres' `stop()` awaits an 'exit' event on the tracked child
//   process. If the child already exited before that listener is attached —
//   e.g. a crashed postmaster or a Windows taskkill race — the listener never
//   fires and `stop()` (and the library's async-exit-hook, which calls
//   `stop()` on every instance at process exit) hangs forever. Every wait in
//   this file is therefore bounded, force-kills are verified with finite
//   polling, and the library's child handle is cleared once termination is
//   confirmed so exit hooks can never hang on a reaped child.
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import EmbeddedPostgresDefault from 'embedded-postgres';

const EmbeddedPostgres = EmbeddedPostgresDefault;

const IS_WINDOWS = process.platform === 'win32';

/**
 * initdb flags per platform. UTF8 encoding everywhere; locale handling
 * differs because Windows initdb does not understand `--locale=C.utf8`.
 * @param {string} [platform]
 * @returns {string[]}
 */
export function initdbFlagsFor(platform = process.platform) {
  return platform === 'win32'
    ? ['--encoding=UTF8', '--no-locale']
    : ['--encoding=UTF8', '--locale=C.utf8'];
}

/** initdb flags for the current platform. */
export const INITDB_FLAGS = initdbFlagsFor();

// Bounded shutdown defaults. These are ceilings for pathological cases only;
// a healthy stop completes in well under a second and returns immediately.
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_EXIT_POLL_INTERVAL_MS = 50;
const TASKKILL_SPAWN_TIMEOUT_MS = 15_000;

/** Error subtype used internally to distinguish timeouts from real errors. */
class StopTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StopTimeoutError';
  }
}

/**
 * Reject `promise` with a StopTimeoutError if it does not settle within `ms`.
 * The timer is unref'd (so it can never keep the event loop alive) and always
 * cleared (so it can never fire after settling).
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new StopTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Promise that resolves after `ms` using a bounded, unref'd timer. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolve();
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * True when Node has observed the child process as terminated. Covers both
 * normal exits and already-reaped children (the crash/taskkill race where
 * embedded-postgres' own `stop()` would wait on an 'exit' event that can
 * never fire).
 * @param {import('node:child_process').ChildProcess | undefined | null} child
 */
function hasExited(child) {
  if (!child) return true;
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Bounded poll confirming the child actually terminated.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @param {number} pollMs
 * @returns {Promise<boolean>}
 */
async function waitForChildExit(child, timeoutMs, pollMs) {
  if (hasExited(child)) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    await delay(pollMs);
    if (hasExited(child)) return true;
  }
  return hasExited(child);
}

/**
 * Force-terminate the postmaster. On Windows this must go through
 * `taskkill /F /T /PID` so the whole process tree (postmaster + backends)
 * dies even if the child is mid-exit; on POSIX, SIGKILL the postmaster —
 * its children exit on their own once the postmaster is gone.
 * @param {import('node:child_process').ChildProcess} child
 */
function forceKillChild(child) {
  if (hasExited(child)) return;
  if (IS_WINDOWS) {
    const pid = child.pid;
    if (!pid) return;
    try {
      // Bounded synchronous spawn: spawnSync guarantees the call cannot
      // outlive its timeout, and a "process not found" exit status is fine —
      // the bounded poll in the caller decides success.
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        windowsHide: true,
        timeout: TASKKILL_SPAWN_TIMEOUT_MS,
      });
    } catch (err) {
      console.warn('[embedded-pg] taskkill failed', err);
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch (err) {
      console.warn('[embedded-pg] SIGKILL failed', err);
    }
  }
}

/**
 * Bounded, leak-proof shutdown for an embedded-postgres instance.
 *
 * Unlike `db.stop()` directly, this is safe against:
 * - no tracked child at all (returns after a bounded no-op),
 * - an already-exited/reaped child (never attaches the exit listener that
 *   `db.stop()` would await forever; just clears tracking),
 * - `db.stop()` hanging (bounded by gracefulTimeoutMs, then force-kill),
 * - Windows taskkill/child-process races (verified by bounded polling).
 *
 * Clears the library's tracked child handle once termination is confirmed so
 * the embedded-postgres async-exit-hook cannot hang at process exit.
 *
 * Throws only for genuine shutdown failures (process survived force-kill, or
 * the library reported a real stop error); the public `stop()` wrapper turns
 * those into log lines so callers keep the existing "stop errors are logged"
 * behavior.
 *
 * @param {any} db embedded-postgres instance (as returned by the library)
 * @param {object} [options]
 * @param {number} [options.gracefulTimeoutMs] cap on the graceful `db.stop()` attempt
 * @param {number} [options.forceKillTimeoutMs] cap on confirming termination after force-kill
 * @param {number} [options.pollIntervalMs] exit-confirmation poll interval
 * @returns {Promise<void>}
 */
export async function stopEmbeddedPostgres(db, options = {}) {
  const {
    gracefulTimeoutMs = DEFAULT_GRACEFUL_STOP_TIMEOUT_MS,
    forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_EXIT_POLL_INTERVAL_MS,
  } = options || {};

  // Nothing to stop at all.
  if (!db) return;

  const child = db.process;

  // No tracked child: embedded-postgres' stop() short-circuits, but keep the
  // call bounded anyway (it is still the library's code) so a wedged fork
  // can never hang us, and make sure tracking ends up clear.
  if (!child) {
    try {
      await withTimeout(
        Promise.resolve().then(() => db.stop()),
        gracefulTimeoutMs,
        'embedded Postgres untracked stop',
      );
    } catch (err) {
      if (!(err instanceof StopTimeoutError)) {
        db.process = undefined;
        throw err;
      }
      console.warn('[embedded-pg] stop() on untracked instance did not settle in time; continuing');
    }
    db.process = undefined;
    return;
  }

  let gracefulError = null;
  if (hasExited(child)) {
    // Already reaped (crash, early exit, or a Windows kill race). Calling
    // db.stop() here would register an 'exit' listener that can never fire —
    // exactly the hang this module exists to prevent. Skip it and clear.
  } else {
    try {
      // Graceful stop: fast shutdown for a healthy postmaster, bounded so a
      // wedged child can never block the caller or the exit hook.
      await withTimeout(
        Promise.resolve().then(() => db.stop()),
        gracefulTimeoutMs,
        'graceful embedded Postgres stop',
      );
    } catch (err) {
      if (err instanceof StopTimeoutError) {
        console.warn(
          `[embedded-pg] graceful stop timed out after ${gracefulTimeoutMs}ms (pid ${child.pid}); force-terminating`,
        );
      } else {
        // Real stop error from the library: still make sure the process is
        // gone, but keep the error so it remains observable to the caller.
        gracefulError = err;
      }
    }
  }

  // Confirm death; force-kill the tree if the postmaster is still alive.
  if (!hasExited(child)) {
    forceKillChild(child);
    const exited = await waitForChildExit(child, forceKillTimeoutMs, pollIntervalMs);
    if (!exited) {
      // Genuine failure: do NOT clear tracking (a later exit-hook attempt is
      // better than a silent leak) and surface the problem loudly.
      throw new Error(
        `embedded Postgres (pid ${child.pid}) refused to terminate within ${forceKillTimeoutMs}ms after force-kill`,
      );
    }
  }

  // Termination confirmed: drop the library's handle so the async-exit-hook
  // sees "nothing running" instead of hanging on the reaped child.
  db.process = undefined;

  if (gracefulError) throw gracefulError;
}

/**
 * Recursive synchronous removal with bounded retry/backoff for transient
 * Windows filesystem errors (file locks released asynchronously after the
 * postmaster dies, antivirus handles, etc.). Non-retryable errors are
 * rethrown immediately; when retries are exhausted the final error is
 * rethrown. Missing paths are not an error.
 *
 * @param {string} target directory (or file) to remove
 * @param {object} [options]
 * @param {number} [options.maxRetries] retries after the first attempt (default 8)
 * @param {number} [options.retryDelayMs] initial backoff delay (default 25)
 * @param {number} [options.maxDelayMs] backoff ceiling (default 400)
 * @param {number} [options.backoffFactor] exponential multiplier (default 2)
 * @returns {void}
 */
export function removeDirRobust(target, options = {}) {
  const {
    maxRetries = 8,
    retryDelayMs = 25,
    maxDelayMs = 400,
    backoffFactor = 2,
  } = options || {};

  // Transient Windows/Linux lock-ish errors worth another attempt. Anything
  // else (ENOTDIR, EINVAL, EROFS, …) is a real problem: rethrow immediately.
  const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EAGAIN']);

  // Already-missing paths are success, not an error.
  if (!existsSync(target)) return;

  // Synchronous sleep without busy-waiting (removeDirRobust is sync by
  // contract, so event-loop timers cannot be used here).
  const sleepSync = (ms) => {
    if (!(ms > 0)) return;
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* bounded busy-wait fallback, max maxDelayMs per step */
      }
    }
  };

  let attempt = 0;
  let waitMs = retryDelayMs;
  for (;;) {
    try {
      rmSync(target, { recursive: true, force: true });
      // Guard against a "false success" rm() where the directory somehow
      // survives: treat it as transient ENOTEMPTY and retry (bounded).
      if (!existsSync(target)) return;
      throw Object.assign(new Error(`directory still present after rmSync: ${target}`), { code: 'ENOTEMPTY' });
    } catch (err) {
      const code = err && typeof err === 'object' ? err.code : undefined;
      const transient = typeof code === 'string' && TRANSIENT.has(code);
      // Bounded by maxRetries — no infinite loop, ever.
      if (!transient || attempt >= maxRetries) throw err;
      sleepSync(waitMs);
      attempt += 1;
      waitMs = Math.min(Math.max(1, Math.round(waitMs * backoffFactor)), maxDelayMs);
    }
  }
}

/**
 * Start an embedded Postgres cluster + database.
 * @param {object} opts
 * @param {string} opts.dataDir  cluster data directory
 * @param {number} opts.port     TCP port
 * @param {string} opts.user     superuser name
 * @param {string} opts.password superuser password
 * @param {string} opts.database database name to create (if missing)
 * @returns {Promise<{db: any, dbUrl: string, stop: () => Promise<void>}>}
 */
export async function startEmbeddedPostgres({ dataDir, port, user, password, database }) {
  mkdirSync(dataDir, { recursive: true });
  const db = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user,
    password,
    persistent: true,
    initdbFlags: [...INITDB_FLAGS],
    onLog: () => {},
    onError: (m) => console.error('[embedded-pg]', m),
  });

  // initialise() only works on a fresh data dir.
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await db.initialise();
  }
  try {
    await db.start();
  } catch (err) {
    // start() rejects when the postmaster dies early; make sure the (dead or
    // half-dead) child is reaped and tracking is cleared so a later stop()
    // or the exit hook cannot hang, and no Postgres process is leaked.
    await stopEmbeddedPostgres(db).catch(() => {});
    throw err;
  }

  // Belt & braces against leaked processes / exit-hook hangs: whenever the
  // postmaster exits on its own (crash, kill, Windows taskkill race), drop
  // the library's handle immediately so nothing can await an 'exit' event
  // that has already fired.
  const trackedChild = db.process;
  if (trackedChild && typeof trackedChild.once === 'function') {
    trackedChild.once('exit', () => {
      if (db.process === trackedChild) db.process = undefined;
    });
  }

  // Wait until accepting connections (bounded: 30 * 500ms + client timeouts).
  const admin = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'postgres' });
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      await admin.connect();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await delay(500);
    }
  }
  if (lastErr) {
    // Bounded hardened shutdown (a bare db.stop() here could hang forever if
    // the postmaster died while we were polling for readiness).
    await stopEmbeddedPostgres(db).catch(() => {});
    throw new Error(`embedded Postgres did not become ready: ${lastErr.message}`);
  }

  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE "${database}"`);
  }
  await admin.end();

  const dbUrl = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  return {
    db,
    dbUrl,
    stop: async () => {
      // Public behavior preserved: shutdown problems are logged here rather
      // than breaking callers; stopEmbeddedPostgres guarantees boundedness.
      await stopEmbeddedPostgres(db).catch((err) => console.error('[embedded-pg] stop error', err));
    },
  };
}
