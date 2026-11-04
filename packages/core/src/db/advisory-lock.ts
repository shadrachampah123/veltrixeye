/**
 * Hardened PostgreSQL **session-level advisory lock** acquisition, ownership
 * verification and release.
 *
 * Why this module exists (production incident class: `scanner advisory unlock
 * failed` / `unlock_returned_false` / `scan skipped: already running` /
 * `scheduled-ingestion warm-cycle lock is already held; skipping cycle`):
 *
 * A session-level advisory lock (`pg_try_advisory_lock`) belongs to the *server
 * backend session* that took it, not to the client object that issued the
 * statement and not to the logical job. Every way that identity can change or
 * disappear is therefore a correctness risk:
 *
 *  - **Unverifiable ownership.** `pg_advisory_unlock` returns `false` when the
 *    executing session does not hold the lock. Without recording the acquiring
 *    `pg_backend_pid()` there is no way to tell "someone else holds it" from
 *    "this session is no longer the session that acquired it" — which is
 *    exactly what happens behind a transaction-mode connection pooler
 *    (PgBouncer, and Neon's `-pooler` endpoint): consecutive statements of one
 *    client can be served by different backends, so the acquire succeeds on
 *    backend A while the release runs on backend B and returns `false`. The
 *    lock on backend A is then orphaned for as long as that backend survives,
 *    and every later cycle logs "already running"/"already held".
 *  - **Silent inheritance.** A pooled client returned to `pg.Pool` while it
 *    still holds a lock keeps holding it. The pool may hand that same session
 *    to unrelated work later; the *next* scanner cycle on that session then
 *    reports `acquired = true` while another scan already runs — mutual
 *    exclusion silently lost rather than visibly skipped.
 *  - **Unprovable liveness.** Scans and warm cycles hold the lock for minutes
 *    while the lock session sits idle. Nothing distinguishes a live job from an
 *    abandoned one, so an orphan cannot be told apart from healthy work.
 *
 * This module therefore:
 *  1. records the backend pid in the *same statement* that acquires the lock;
 *  2. proves the lock is visible on that same backend immediately after
 *     acquisition (`verify`), refusing to run unguarded if it is not;
 *  3. classifies every release outcome (`released` / `not_owned` /
 *     `session_changed` / `query_error`) and tells the caller to destroy and
 *     evict the connection whenever ownership could not be proven — the only
 *     way to guarantee the backend session (and its lock) is gone;
 *  4. supports periodic re-verification, so a job that loses ownership
 *     mid-flight can fail closed instead of running concurrently;
 *  5. reports a bounded, secret-free description of the *holder* session when
 *     acquisition fails, including whether it looks abandoned.
 *
 * Nothing here logs credentials, connection strings or tenant identifiers: the
 * holder description carries only pid/application name/state/age.
 */

/** One result row, read field-by-field with explicit type guards. */
export interface AdvisoryLockRow {
  [column: string]: unknown;
}

/**
 * Minimal client surface used here. Both `pg.PoolClient` and plain test doubles
 * satisfy it; every field read below is type-guarded, so no generic parameter
 * is needed (and a fake client stays trivial to write).
 */
export interface AdvisoryLockClient {
  query(text: string, values?: unknown[]): Promise<{ rows: AdvisoryLockRow[] }>;
}

export interface AdvisoryLockLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * A holder session idle for at least this long is reported as *suspected
 * orphaned*. Real holders re-verify their ownership while the job runs, so a
 * live holder is never idle for this long between checks.
 */
export const DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS = 120_000;

/**
 * Reconstructed advisory key + ownership test for the **single-bigint** form of
 * `pg_advisory_lock`. PostgreSQL stores such a key as
 * `classid = key >> 32`, `objid = key & 0xFFFFFFFF`, `objsubid = 1`; the
 * expression below inverts that exactly. Only the current backend can appear
 * for `pid = pg_backend_pid()` (no `pg_read_all_stats` privilege required).
 */
const ADVISORY_LOCK_VERIFY_SQL = `
  SELECT pg_backend_pid()::int AS pid,
         EXISTS (
           SELECT 1
             FROM pg_locks l
            WHERE l.locktype = 'advisory'
              AND l.granted = true
              AND l.objsubid = 1
              AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint
              AND l.pid = pg_backend_pid()
         ) AS owned
`;

/**
 * Does **this session** already hold `$1` before we try to acquire it?
 *
 * `pg_try_advisory_lock` is re-entrant per session: a session that already
 * holds the key acquires again happily (the lock level is stacked) and reports
 * `true`. Accepting that as a fresh exclusive grant is a silent mutual-exclusion
 * failure — the second job runs while the first one still holds the lock, and a
 * single `pg_advisory_unlock` later leaves one level behind. That is precisely
 * the "inherited lock on a pooled session" case this module exists to stop, so
 * it is detected *before* acquiring and the session is evicted instead.
 */
const ADVISORY_LOCK_PRECHECK_SQL = `
  SELECT pg_backend_pid()::int AS pid,
         EXISTS (
           SELECT 1
             FROM pg_locks l
            WHERE l.locktype = 'advisory'
              AND l.granted = true
              AND l.objsubid = 1
              AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint
              AND l.pid = pg_backend_pid()
         ) AS already_owned
`;

const ADVISORY_LOCK_ACQUIRE_SQL = `
  SELECT pg_backend_pid()::int AS pid,
         pg_try_advisory_lock($1::bigint) AS acquired
`;

/**
 * Release + pid in one statement, so a release that is silently evaluated on a
 * *different* backend than the acquisition is detectable instead of being
 * misreported as "the lock was not held".
 */
const ADVISORY_LOCK_RELEASE_SQL = `
  SELECT pg_backend_pid()::int AS pid,
         pg_advisory_unlock($1::bigint) AS unlocked
`;

/**
 * Bounded, secret-free description of whoever currently holds `$1`.
 *
 * `pg_stat_activity` columns are null for sessions owned by other roles without
 * `pg_read_all_stats`; that is reported as "unknown", never guessed.
 */
const ADVISORY_LOCK_HOLDER_SQL = `
  SELECT l.pid::int AS pid,
         a.application_name AS application_name,
         a.state AS state,
         a.backend_type AS backend_type,
         CASE
           WHEN a.state_change IS NULL THEN NULL
           ELSE GREATEST(0, (EXTRACT(EPOCH FROM (now() - a.state_change)) * 1000)::bigint)
         END AS state_idle_ms
    FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory'
     AND l.granted = true
     AND l.objsubid = 1
     AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint
   ORDER BY l.pid
   LIMIT 1
`;

export interface AdvisoryLockHolder {
  /** Backend pid holding the lock, when readable. */
  pid: number | null;
  applicationName: string | null;
  /** `pg_stat_activity.state` — `active`, `idle`, `idle in transaction`, … */
  state: string | null;
  backendType: string | null;
  /** How long the holder has been in its current state, in ms. */
  stateIdleMs: number | null;
  /**
   * True when the holder has been idle for at least `orphanIdleMs`. A job that
   * still owns its lock re-verifies it well inside that window, so an idle
   * holder older than the threshold is very likely abandoned.
   */
  suspectedOrphaned: boolean;
  /** True when `pg_stat_activity` details were not readable for this pid. */
  detailsUnavailable: boolean;
}

export type AdvisoryLockReleaseReason =
  /** PostgreSQL confirmed the unlock on the acquiring backend. */
  | 'released'
  /** The executing session does not hold the lock (`false` / `NULL` result). */
  | 'not_owned'
  /** The release ran on a different backend than the acquisition (pooler/reset). */
  | 'session_changed'
  /** The unlock statement itself failed (connection lost, aborted transaction, …). */
  | 'query_error'
  /**
   * PostgreSQL confirmed one unlock level, but the key is **still held by this
   * session** — the session had stacked more than one acquisition of the same
   * key (advisory locks are re-entrant per session). Reporting success here
   * would leave an orphaned lock behind while telling the caller it was
   * released, which is exactly the permanent `already running` failure mode.
   */
  | 'still_held';

export interface AdvisoryLockRelease {
  released: boolean;
  reason: AdvisoryLockReleaseReason;
  /** The caller MUST destroy/evict the connection when true. */
  mustDestroyClient: boolean;
  /** Holder description gathered when the release was not clean. */
  holder: AdvisoryLockHolder | null;
  /** SQLSTATE of the release failure, when available. */
  code?: string;
  /**
   * The thrown release error, for callers that own a redacting sanitizer. Kept
   * out of the logged metadata by this module on purpose.
   */
  error?: unknown;
}

export interface AdvisoryLockVerification {
  owned: boolean;
  /** False when the backend pid changed since acquisition (session not pinned). */
  sessionPinned: boolean;
  pid: number | null;
  reason?: 'not_owned' | 'session_changed' | 'query_error';
  code?: string;
}

export interface AdvisoryLockAcquireResult {
  acquired: boolean;
  /** Present only when the lock was acquired *and* ownership was proven. */
  lock: SessionAdvisoryLock | null;
  /** Description of the current holder when acquisition failed on contention. */
  holder?: AdvisoryLockHolder | null;
  /** The caller MUST destroy/evict the connection when true. */
  mustDestroyClient: boolean;
  /** Why acquisition failed, when it was not ordinary contention. */
  reason?: 'not_owned' | 'session_changed' | 'query_error' | 'contended' | 'already_owned';
  /** SQLSTATE of the acquisition failure, when available. */
  code?: string;
}

export interface AdvisoryLockOptions {
  /** Idle threshold used to classify a holder as suspected-orphaned. */
  orphanIdleMs?: number;
  /** Logger for the diagnostics emitted by this module (optional). */
  logger?: AdvisoryLockLogger;
  /** Prefix used in log metadata (e.g. `scanner`). */
  label?: string;
}

/** Extract a SQLSTATE/errnocode-like code without leaking the message. */
export function advisoryLockErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.length <= 12 ? code : undefined;
}

/**
 * One session-level advisory lock, bound to the pid that acquired it.
 *
 * Obtain instances through {@link acquireSessionAdvisoryLock}; never construct
 * directly.
 */
export class SessionAdvisoryLock {
  private readonly client: AdvisoryLockClient;
  private readonly key: number;
  private readonly ownerPid: number | null;
  private readonly orphanIdleMs: number;
  private readonly logger: AdvisoryLockLogger | undefined;
  private readonly label: string;

  constructor(
    client: AdvisoryLockClient,
    key: number,
    ownerPid: number | null,
    options: AdvisoryLockOptions = {},
  ) {
    this.client = client;
    this.key = key;
    this.ownerPid = ownerPid;
    this.orphanIdleMs = Math.max(0, options.orphanIdleMs ?? DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS);
    this.logger = options.logger;
    this.label = options.label ?? 'advisory lock';
  }

  get lockKey(): number {
    return this.key;
  }

  /** The backend pid that acquired this lock (null when it could not be read). */
  get pid(): number | null {
    return this.ownerPid;
  }

  /**
   * Re-check that this session still holds the lock. Intended as a heartbeat
   * during long-running work: a `false` result means ownership was lost (lock
   * released behind our back, session killed, backend rotated by a pooler) and
   * the caller must stop relying on mutual exclusion and destroy the session.
   */
  async verify(): Promise<AdvisoryLockVerification> {
    let res: { rows: AdvisoryLockRow[] };
    try {
      res = await this.client.query(ADVISORY_LOCK_VERIFY_SQL, [this.key]);
    } catch (err) {
      const code = advisoryLockErrorCode(err);
      return {
        owned: false,
        sessionPinned: true,
        pid: this.ownerPid,
        reason: 'query_error',
        ...(code !== undefined ? { code } : {}),
      };
    }
    const row = res.rows[0] ?? {};
    const observedPid = typeof row.pid === 'number' ? row.pid : null;
    if (this.ownerPid !== null && observedPid !== null && observedPid !== this.ownerPid) {
      this.logger?.error(`${this.label}: session is not pinned to the acquiring backend`, {
        lockKey: this.key,
        ownerPid: this.ownerPid,
        observedPid,
        reason: 'session_changed',
      });
      return { owned: false, sessionPinned: false, pid: observedPid, reason: 'session_changed' };
    }
    const owned = row.owned === true;
    return {
      owned,
      sessionPinned: true,
      pid: observedPid ?? this.ownerPid,
      ...(owned ? {} : { reason: 'not_owned' as const }),
    };
  }

  /**
   * Release the lock. Every outcome is classified; whenever PostgreSQL could
   * not confirm the unlock on the acquiring backend the caller is told to
   * destroy the connection, because a pooled session that keeps a lock is far
   * more damaging than one extra reconnect.
   */
  async release(): Promise<AdvisoryLockRelease> {
    let res: { rows: AdvisoryLockRow[] };
    try {
      res = await this.client.query(ADVISORY_LOCK_RELEASE_SQL, [this.key]);
    } catch (err) {
      const code = advisoryLockErrorCode(err);
      return {
        released: false,
        reason: 'query_error',
        mustDestroyClient: true,
        holder: null,
        ...(code !== undefined ? { code } : {}),
        error: err,
      };
    }

    const row = res.rows[0] ?? {};
    const observedPid = typeof row.pid === 'number' ? row.pid : null;
    if (this.ownerPid !== null && observedPid !== null && observedPid !== this.ownerPid) {
      // The release statement ran somewhere else, so its `false` tells us
      // nothing about the acquiring session. Destroy: only session teardown is
      // guaranteed to drop the lock (or, behind a pooler, to stop this client
      // from re-entering a session it does not control).
      return { released: false, reason: 'session_changed', mustDestroyClient: true, holder: null };
    }

    const unlocked = row.unlocked ?? row.pg_advisory_unlock ?? false;
    if (unlocked !== true) {
      const holder = await readAdvisoryLockHolder(this.client, this.key, this.orphanIdleMs);
      return { released: false, reason: 'not_owned', mustDestroyClient: true, holder };
    }

    // `pg_advisory_unlock` returns true when it removed *one* level. Advisory
    // locks are re-entrant per session, so a stacked acquisition would leave the
    // key held while this call reports success. Prove the key is gone before
    // claiming a release; anything else must destroy the session.
    const after = await this.verify();
    if (after.owned) {
      const holder = await readAdvisoryLockHolder(this.client, this.key, this.orphanIdleMs);
      return { released: false, reason: 'still_held', mustDestroyClient: true, holder };
    }
    if (!after.sessionPinned) {
      return { released: false, reason: 'session_changed', mustDestroyClient: true, holder: null };
    }
    if (after.reason === 'query_error') {
      // The proof could not be read. "Unreadable" is not "released": the key may
      // still be held by this session, so the caller must evict it.
      return {
        released: false,
        reason: 'query_error',
        mustDestroyClient: true,
        holder: null,
        ...(after.code !== undefined ? { code: after.code } : {}),
      };
    }
    return { released: true, reason: 'released', mustDestroyClient: false, holder: null };
  }
}

/**
 * Acquire a session-level advisory lock on `client` and prove ownership before
 * returning it.
 *
 * The caller owns the returned `mustDestroyClient` contract:
 *  - `true` — destroy and evict the connection (the lock may be held by a
 *    session this client can no longer address, e.g. after a failed or
 *    misdirected acquire);
 *  - `false` — return the connection to the pool normally.
 */
export async function acquireSessionAdvisoryLock(
  client: AdvisoryLockClient,
  key: number,
  options: AdvisoryLockOptions = {},
): Promise<AdvisoryLockAcquireResult> {
  // Step 1 — refuse a session that already holds this key. Acquiring on top of
  // an inherited lock would stack a second level: the job would run concurrently
  // with whoever holds level one, and one unlock later the key would survive
  // ("released" reported, lock still held).
  let precheck: { rows: AdvisoryLockRow[] };
  try {
    precheck = await client.query(ADVISORY_LOCK_PRECHECK_SQL, [key]);
  } catch (err) {
    const code = advisoryLockErrorCode(err);
    return {
      acquired: false,
      lock: null,
      holder: null,
      mustDestroyClient: true,
      reason: 'query_error',
      ...(code !== undefined ? { code } : {}),
    };
  }
  const preRow = precheck.rows[0] ?? {};
  // The pre-check pid is only used to detect a backend change between the
  // pre-check and the acquire. The pid that *must* exist is the acquiring one.
  const prePid = typeof preRow.pid === 'number' ? preRow.pid : null;

  if (preRow.already_owned === true) {
    // The session cannot be trusted to release what it is already holding, so
    // it is evicted rather than reused. No new lock level is stacked.
    options.logger?.error(`${options.label ?? 'advisory lock'}: session already holds the lock`, {
      lockKey: key,
      pid: prePid,
      reason: 'already_owned',
      connectionDestroyed: true,
    });
    return {
      acquired: false,
      lock: null,
      holder: null,
      mustDestroyClient: true,
      reason: 'already_owned',
    };
  }

  // Step 2 — acquire, recording the pid in the same statement.
  let res: { rows: AdvisoryLockRow[] };
  try {
    res = await client.query(ADVISORY_LOCK_ACQUIRE_SQL, [key]);
  } catch (err) {
    // The server may have applied the lock even though the client saw an error
    // (connection reset/timeout after execution). The session can no longer be
    // trusted to release it, so the caller must destroy it.
    const code = advisoryLockErrorCode(err);
    return {
      acquired: false,
      lock: null,
      holder: null,
      mustDestroyClient: true,
      reason: 'query_error',
      ...(code !== undefined ? { code } : {}),
    };
  }

  const row = res.rows[0] ?? {};
  const pid = typeof row.pid === 'number' ? row.pid : null;
  const acquired = row.acquired === true;

  // The pre-check's evidence only describes the backend that ran it. If the
  // acquire was evaluated elsewhere (transaction-mode pooler), the session is
  // not pinned and nothing here is provable: evict.
  if (pid !== null && prePid !== null && pid !== prePid) {
    options.logger?.error(`${options.label ?? 'advisory lock'}: session is not pinned to one backend`, {
      lockKey: key,
      precheckPid: prePid,
      acquirePid: pid,
      reason: 'session_changed',
    });
    return {
      acquired: false,
      lock: null,
      holder: null,
      mustDestroyClient: true,
      reason: 'session_changed',
    };
  }

  // An unreadable acquiring pid cannot be proven later (release and heartbeat
  // both key off it), so a "grant" without one is refused and the session evicted.
  if (acquired && pid === null) {
    return {
      acquired: false,
      lock: null,
      holder: null,
      mustDestroyClient: true,
      reason: 'not_owned',
    };
  }

  if (!acquired) {
    const holder = await readAdvisoryLockHolder(
      client,
      key,
      options.orphanIdleMs ?? DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS,
    );
    return { acquired: false, lock: null, holder, mustDestroyClient: false, reason: 'contended' };
  }

  const lock = new SessionAdvisoryLock(client, key, pid, options);
  // Prove the lock is visible on the acquiring backend before anyone relies on
  // mutual exclusion. Behind a transaction-mode pooler this is where the design
  // assumption fails, and failing here (loudly) is the safe outcome.
  const check = await lock.verify();
  if (!check.owned) {
    return {
      acquired: false,
      lock: null,
      holder: null,
      mustDestroyClient: true,
      reason: check.reason ?? 'not_owned',
      ...(check.code !== undefined ? { code: check.code } : {}),
    };
  }
  return { acquired: true, lock, holder: null, mustDestroyClient: false };
}

/**
 * Describe the current holder of `key` (best effort, never throws). Safe to run
 * on the same client that just failed to acquire the lock.
 */
export async function readAdvisoryLockHolder(
  client: AdvisoryLockClient,
  key: number,
  orphanIdleMs: number = DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS,
): Promise<AdvisoryLockHolder | null> {
  let rows: AdvisoryLockRow[];
  try {
    const res = await client.query(ADVISORY_LOCK_HOLDER_SQL, [key]);
    rows = res.rows;
  } catch {
    return null;
  }
  const row = rows[0];
  if (!row) return null;

  const pid = typeof row.pid === 'number' ? row.pid : null;
  const state = typeof row.state === 'string' ? row.state : null;
  const idleRaw = row.state_idle_ms;
  const stateIdleMs =
    typeof idleRaw === 'number'
      ? idleRaw
      : typeof idleRaw === 'string' && idleRaw.trim() !== '' && Number.isFinite(Number(idleRaw))
        ? Number(idleRaw)
        : null;

  return {
    pid,
    applicationName: typeof row.application_name === 'string' ? row.application_name : null,
    state,
    backendType: typeof row.backend_type === 'string' ? row.backend_type : null,
    stateIdleMs,
    suspectedOrphaned: state === 'idle' && stateIdleMs !== null && stateIdleMs >= Math.max(0, orphanIdleMs),
    detailsUnavailable: pid !== null && state === null,
  };
}

/**
 * Bounded log metadata for the session currently holding an advisory lock.
 *
 * Operator-safe by construction: pid, application name, `pg_stat_activity`
 * state and state age only. `detailsUnavailable` is explicit rather than
 * guessed when the holder belongs to a role whose activity is not readable.
 */
export function holderLogMeta(holder: AdvisoryLockHolder | null | undefined): Record<string, unknown> {
  if (!holder) return {};
  return {
    holderPid: holder.pid,
    holderState: holder.state,
    holderIdleMs: holder.stateIdleMs,
    holderSuspectedOrphaned: holder.suspectedOrphaned,
    ...(holder.detailsUnavailable ? { holderDetailsUnavailable: true } : {}),
  };
}
