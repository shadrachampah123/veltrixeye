/**
 * Regression suite for the hardened session-advisory-lock helper.
 *
 * The production symptom class this covers:
 *   `scanner advisory unlock failed` / `unlock_returned_false`,
 *   `scanner scan skipped: already running`,
 *   `scheduled-ingestion warm-cycle lock is already held; skipping cycle`.
 *
 * Every scenario named in the incident review has a test here: acquisition,
 * release, connection failure, overlapping jobs, stale (orphaned) locks and
 * recovery. Integration tests run against a real embedded PostgreSQL because
 * advisory locks are server-session state — a mock cannot prove them.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import {
  acquireSessionAdvisoryLock,
  advisoryLockErrorCode,
  createPool,
  deriveAdvisoryLockTiming,
  holderLogMeta,
  readAdvisoryLockHolder,
  DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS,
  MAX_ADVISORY_LOCK_HEARTBEAT_MS,
  MIGRATION_LOCK_KEY,
  NOTIFICATION_FAIRNESS_LOCK_KEY,
  SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
  type AdvisoryLockClient,
  type SessionAdvisoryLock,
} from '../src/index.js';
import { FX_SOURCE_ADVISORY_LOCK_KEY, SCANNER_ADVISORY_LOCK_KEY } from '@veltrixeye/contracts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5594;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_advisory_lock';

/** A key no other suite uses, < 2^32 so it stays in the low half of the bigint. */
const TEST_LOCK_KEY = 909_091_001;

let databaseUrl: string;
let stopDb: () => Promise<void>;
let pool: pg.Pool;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-advisory-lock');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  databaseUrl = db.dbUrl;
  pool = createPool({ databaseUrl });
}, { timeout: 240_000 });

after(async () => {
  await pool?.end().catch(() => {});
  await stopDb?.();
});

/** Poll `predicate` until true or the deadline passes (bounded, no sleeps in tests). */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Count granted advisory locks for `key` anywhere in the cluster. */
async function countLocks(key: number): Promise<number> {
  const res = await pool.query<{ cnt: number }>(
    `SELECT count(*)::int AS cnt
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND granted = true
        AND ((classid::bigint << 32) | objid::bigint) = $1::bigint`,
    [key],
  );
  return res.rows[0]?.cnt ?? 0;
}

/** Acquire a raw (unhardened) lock on a dedicated client — used to stage states. */
async function holdRawLock(
  key: number,
): Promise<{ client: pg.PoolClient; release: () => Promise<void>; destroy: () => void }> {
  const client = await pool.connect();
  const res = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
    key,
  ]);
  assert.equal(res.rows[0]?.acquired, true, 'staging lock must be acquirable');
  return {
    client,
    release: async () => {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => {});
      client.release();
    },
    // Destroy through the pool (never `client.end()`, which would leave the
    // pool believing the connection is still checked out).
    destroy: () => client.release(true),
  };
}

describe('advisory lock — real PostgreSQL', () => {
  test('acquisition records the owning backend and proves ownership', async () => {
    assert.equal(await countLocks(TEST_LOCK_KEY), 0, 'starts with no holders');

    const client = await pool.connect();
    try {
      const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
      assert.equal(res.acquired, true);
      assert.equal(res.mustDestroyClient, false);
      assert.ok(res.lock, 'a proven lock handle is returned');
      const lock = res.lock as SessionAdvisoryLock;
      assert.ok(typeof lock.pid === 'number' && (lock.pid as number) > 0, 'owner pid is recorded');
      assert.equal(await countLocks(TEST_LOCK_KEY), 1);

      const verify = await lock.verify();
      assert.equal(verify.owned, true, 'ownership is verifiable while held');
      assert.equal(verify.sessionPinned, true);

      const release = await lock.release();
      assert.deepEqual(
        { released: release.released, reason: release.reason },
        { released: true, reason: 'released' },
      );
      assert.equal(release.mustDestroyClient, false);
      assert.equal(await countLocks(TEST_LOCK_KEY), 0, 'release clears the lock in pg_locks');
    } finally {
      client.release();
    }
  });

  test('contention reports the holder session and skips without destroying the client', async () => {
    const holder = await holdRawLock(TEST_LOCK_KEY);
    const second = await pool.connect();
    try {
      const res = await acquireSessionAdvisoryLock(second, TEST_LOCK_KEY);
      assert.equal(res.acquired, false);
      assert.equal(res.lock, null);
      assert.equal(res.reason, 'contended');
      assert.equal(res.mustDestroyClient, false, 'ordinary contention keeps the pooled session');
      assert.ok(res.holder, 'the holder is described for the log line');
      assert.ok(typeof res.holder?.pid === 'number');
      assert.equal(res.holder?.suspectedOrphaned, false, 'a fresh holder is not an orphan');
      // Metadata is bounded and carries no connection string or tenant data.
      const meta = holderLogMeta(res.holder);
      assert.deepEqual(
        Object.keys(meta).filter((k) => k.startsWith('holderPid')),
        ['holderPid'],
      );
      assert.ok(!JSON.stringify(meta).includes(DB_PASSWORD));
    } finally {
      second.release();
      await holder.release();
    }
  });

  test('overlapping jobs: exactly one of several concurrent acquires wins', async () => {
    const clients = await Promise.all(
      Array.from({ length: 5 }, () => pool.connect()),
    );
    try {
      const results = await Promise.all(
        clients.map((client) => acquireSessionAdvisoryLock(client, TEST_LOCK_KEY)),
      );
      const winners = results.filter((r) => r.acquired);
      assert.equal(winners.length, 1, 'mutual exclusion holds under concurrency');
      assert.equal(await countLocks(TEST_LOCK_KEY), 1);

      const winner = winners[0]!.lock as SessionAdvisoryLock;
      const contention = results.find((r) => !r.acquired)!;
      assert.equal(contention.holder?.pid, winner.pid, 'losers name the winning session');

      await winner.release();
      assert.equal(await countLocks(TEST_LOCK_KEY), 0);
      // A loser can now take the lock: contention is transient, not a leak.
      const loserClient = clients[results.findIndex((r) => !r.acquired)]!;
      const retry = await acquireSessionAdvisoryLock(loserClient, TEST_LOCK_KEY);
      assert.equal(retry.acquired, true);
      await retry.lock!.release();
    } finally {
      for (const client of clients) client.release();
    }
  });

  test('stale lock: an idle holder is classified as suspected orphaned', async () => {
    const holder = await holdRawLock(TEST_LOCK_KEY);
    const observer = await pool.connect();
    try {
      const fresh = await readAdvisoryLockHolder(observer, TEST_LOCK_KEY, DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS);
      assert.equal(fresh?.suspectedOrphaned, false);

      const strict = await readAdvisoryLockHolder(observer, TEST_LOCK_KEY, 0);
      assert.equal(strict?.state, 'idle', 'the holder is idle while another job skips');
      assert.equal(strict?.suspectedOrphaned, true, 'a zero threshold classifies any idle holder');
      assert.ok(typeof strict?.stateIdleMs === 'number' && (strict?.stateIdleMs ?? -1) >= 0);
    } finally {
      observer.release();
      await holder.release();
    }
  });

  test('connection failure: an acquire error demands session destruction', async () => {
    const client = await pool.connect();
    const brokenClient: AdvisoryLockClient = {
      async query() {
        throw Object.assign(new Error('terminating connection due to administrator command'), {
          code: '57P01',
        });
      },
    };
    try {
      const res = await acquireSessionAdvisoryLock(brokenClient, TEST_LOCK_KEY);
      assert.equal(res.acquired, false);
      assert.equal(res.mustDestroyClient, true, 'the server may hold a lock this session cannot release');
      assert.equal(res.reason, 'query_error');
      assert.equal(res.code, '57P01');
      // The real client is healthy and unaffected by the simulated failure.
      assert.equal(await countLocks(TEST_LOCK_KEY), 0);
    } finally {
      client.release();
    }
  });

  test('recovery: destroying the holding session frees the lock for the next cycle', async () => {
    const held = await holdRawLock(TEST_LOCK_KEY);
    assert.equal(await countLocks(TEST_LOCK_KEY), 1);

    // Simulate the evict path used after an unprovable release: the session
    // ends, so PostgreSQL drops the lock instead of leaving it orphaned.
    held.destroy();
    await waitFor(async () => (await countLocks(TEST_LOCK_KEY)) === 0);
    assert.equal(await countLocks(TEST_LOCK_KEY), 0, 'session teardown releases the lock');

    const next = await pool.connect();
    try {
      const res = await acquireSessionAdvisoryLock(next, TEST_LOCK_KEY);
      assert.equal(res.acquired, true, 'the next cycle is not blocked by the dead session');
      await res.lock!.release();
    } finally {
      next.release();
    }
  });

  test('ownership lost mid-job is detected by verify (heartbeat) and the lock is recoverable', async () => {
    const client = await pool.connect();
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const lock = res.lock as SessionAdvisoryLock;
    assert.equal(res.acquired, true);
    assert.equal((await lock.verify()).owned, true);

    // Someone kills the holding backend (idle timeout, deploy, manual action).
    await pool.query('SELECT pg_terminate_backend($1)', [lock.pid]);

    const lost = await lock.verify();
    assert.equal(lost.owned, false, 'the heartbeat must not report ownership after the session died');
    assert.ok(lost.reason === 'query_error' || lost.reason === 'not_owned');
    assert.equal(await countLocks(TEST_LOCK_KEY), 0, 'the dead session released the lock');
    client.release(true);
  });

  test('release that no longer owns the lock is classified and demands destruction', async () => {
    const client = await pool.connect();
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const lock = res.lock as SessionAdvisoryLock;
    assert.equal(res.acquired, true);

    // Release out of band (same session): the helper must notice it no longer
    // holds what it is being asked to release.
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [TEST_LOCK_KEY]);

    const release = await lock.release();
    assert.equal(release.released, false);
    assert.equal(release.reason, 'not_owned');
    assert.equal(release.mustDestroyClient, true);
    client.release();
  });

  test('a session that already holds the key is refused and evicted, never stacked', async () => {
    // `pg_try_advisory_lock` is re-entrant per session: acquiring on a session
    // that already holds the key would stack a second level and report `true`,
    // letting two jobs believe they are exclusive while one unlock leaves the
    // key held. The acquire must refuse and hand the session back for eviction.
    const holder = await holdRawLock(TEST_LOCK_KEY);
    try {
      const res = await acquireSessionAdvisoryLock(holder.client, TEST_LOCK_KEY);
      assert.equal(res.acquired, false, 'an inherited lock is never a fresh exclusive grant');
      assert.equal(res.reason, 'already_owned');
      assert.equal(res.mustDestroyClient, true, 'the poisoned session is evicted, not reused');
      assert.equal(res.lock, null);
      assert.equal(await countLocks(TEST_LOCK_KEY), 1, 'no second level was stacked');
    } finally {
      holder.destroy();
    }

    await waitFor(async () => (await countLocks(TEST_LOCK_KEY)) === 0);
    assert.equal(await countLocks(TEST_LOCK_KEY), 0, 'evicting the session clears the inherited lock');

    // Recovery: a clean session acquires immediately afterwards.
    const fresh = await pool.connect();
    try {
      const res = await acquireSessionAdvisoryLock(fresh, TEST_LOCK_KEY);
      assert.equal(res.acquired, true, 'the next cycle is not blocked by the evicted session');
      const release = await res.lock!.release();
      assert.equal(release.released, true);
    } finally {
      fresh.release();
    }
  });

  test('a release that leaves a stacked level behind is still_held, never "released"', async () => {
    const client = await pool.connect();
    try {
      const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
      assert.equal(res.acquired, true);
      // Stage the state the pre-check exists to prevent: a second level of the
      // same key on the same session (a leaked acquire from an earlier cycle).
      await client.query('SELECT pg_advisory_lock($1::bigint)', [TEST_LOCK_KEY]);

      const release = await res.lock!.release();
      assert.equal(release.released, false, 'one unlock does not empty a stacked lock');
      assert.equal(release.reason, 'still_held');
      assert.equal(release.mustDestroyClient, true, 'the caller must evict the session');
      assert.equal(await countLocks(TEST_LOCK_KEY), 1, 'the surviving level is visible in pg_locks');
    } finally {
      // Evict: only session teardown is guaranteed to clear a stacked lock.
      client.release(true);
    }

    await waitFor(async () => (await countLocks(TEST_LOCK_KEY)) === 0);
    assert.equal(await countLocks(TEST_LOCK_KEY), 0, 'eviction clears the stacked lock');
  });
});

/* ------------------------------------------------------------------------ */
/* Deterministic unit tests (no database): the states a real cluster cannot
   be made to produce on demand — a backend that changes identity between the
   acquire and the release (transaction-mode pooler), a release that throws,
   and a missing/foreign pid.                                              */
/* ------------------------------------------------------------------------ */

interface FakeRow {
  [column: string]: unknown;
}

function fakeClient(handler: (sql: string) => FakeRow): AdvisoryLockClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      return { rows: [handler(sql)] };
    },
  };
}

const isAcquire = (sql: string) => sql.includes('pg_try_advisory_lock');
const isVerify = (sql: string) => sql.includes('FROM pg_locks') && sql.includes('AS owned');
const isRelease = (sql: string) => sql.includes('pg_advisory_unlock');
const isHolder = (sql: string) => sql.includes('FROM pg_locks') && sql.includes('application_name');

describe('advisory lock — classified states (unit)', () => {
  test('a backend that changes identity between acquire and verify is rejected (pooler pinning)', async () => {
    const client = fakeClient((sql) => {
      if (isAcquire(sql)) return { pid: 100, acquired: true };
      if (isVerify(sql)) return { pid: 200, owned: false };
      return {};
    });
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY, { orphanIdleMs: 0 });
    assert.equal(res.acquired, false, 'an unpinned session must never be trusted');
    assert.equal(res.reason, 'session_changed');
    assert.equal(res.mustDestroyClient, true);
  });

  test('an acquire that succeeds on paper but is not visible in pg_locks is rejected', async () => {
    const client = fakeClient((sql) => {
      if (isAcquire(sql)) return { pid: 100, acquired: true };
      if (isVerify(sql)) return { pid: 100, owned: false };
      return {};
    });
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    assert.equal(res.acquired, false);
    assert.equal(res.reason, 'not_owned');
    assert.equal(res.mustDestroyClient, true);
  });

  test('a release evaluated on a different backend is session_changed, not a clean release', async () => {
    const client = fakeClient((sql) => {
      if (isAcquire(sql)) return { pid: 100, acquired: true };
      if (isVerify(sql)) return { pid: 100, owned: true };
      if (isRelease(sql)) return { pid: 200, unlocked: true };
      return {};
    });
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const release = await res.lock!.release();
    assert.equal(release.released, false, 'a true from another backend proves nothing');
    assert.equal(release.reason, 'session_changed');
    assert.equal(release.mustDestroyClient, true);
  });

  test('a throwing release is query_error with the SQLSTATE preserved and no raw message', async () => {
    const client: AdvisoryLockClient = {
      async query(sql: string) {
        if (isAcquire(sql)) return { rows: [{ pid: 100, acquired: true }] };
        if (isVerify(sql)) return { rows: [{ pid: 100, owned: true }] };
        if (isRelease(sql)) {
          throw Object.assign(new Error('connection reset by peer postgres://u:p@h/db'), { code: '08006' });
        }
        return { rows: [] };
      },
    };
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const release = await res.lock!.release();
    assert.equal(release.released, false);
    assert.equal(release.reason, 'query_error');
    assert.equal(release.mustDestroyClient, true);
    assert.equal(release.code, '08006');
    assert.ok(!JSON.stringify({ ...release, error: undefined }).includes('postgres://'));
  });

  test('an unlock returning false is reported with the holder description', async () => {
    const client = fakeClient((sql) => {
      if (isAcquire(sql)) return { pid: 100, acquired: true };
      if (isVerify(sql)) return { pid: 100, owned: true };
      if (isRelease(sql)) return { pid: 100, unlocked: false };
      if (isHolder(sql)) {
        return {
          pid: 321,
          application_name: 'veltrixeye',
          state: 'idle',
          backend_type: 'client backend',
          state_idle_ms: 300_000,
        };
      }
      return {};
    });
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const release = await res.lock!.release();
    assert.equal(release.reason, 'not_owned');
    assert.equal(release.mustDestroyClient, true);
    const meta = holderLogMeta(release.holder);
    assert.equal(meta.holderPid, 321);
    assert.equal(meta.holderState, 'idle');
    assert.equal(meta.holderSuspectedOrphaned, true, 'a 5-minute-idle holder is a suspected orphan');
  });

  test('an unreadable post-release proof is query_error, never a clean release', async () => {
    let verified = 0;
    const client: AdvisoryLockClient = {
      async query(sql: string) {
        if (sql.includes('AS already_owned')) return { rows: [{ pid: 100, already_owned: false }] };
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ pid: 100, acquired: true }] };
        if (sql.includes('AS owned')) {
          verified += 1;
          // The acquire-time proof works; the post-release proof cannot be read.
          if (verified > 1) throw Object.assign(new Error('connection reset'), { code: '08006' });
          return { rows: [{ pid: 100, owned: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ pid: 100, unlocked: true }] };
        return { rows: [] };
      },
    };
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const release = await res.lock!.release();
    assert.equal(release.released, false, 'an unprovable release is not a release');
    assert.equal(release.reason, 'query_error');
    assert.equal(release.mustDestroyClient, true);
    assert.equal(release.code, '08006');
  });

  test('an unlock that returns true while the key is still held is still_held', async () => {
    // `pg_advisory_unlock` answers "I removed one level", not "the key is now
    // free". Reporting a release on that alone is how a pooled session keeps a
    // lock while the caller believes it is gone.
    const client = fakeClient((sql) => {
      if (isAcquire(sql)) return { pid: 100, acquired: true };
      if (isVerify(sql)) return { pid: 100, owned: true };
      if (isRelease(sql)) return { pid: 100, unlocked: true };
      if (isHolder(sql)) return { pid: 100, state: 'idle', state_idle_ms: 1_000 };
      return {};
    });
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const release = await res.lock!.release();
    assert.equal(release.released, false);
    assert.equal(release.reason, 'still_held');
    assert.equal(release.mustDestroyClient, true);
    assert.equal(release.holder?.pid, 100, 'the surviving holder is named for the operator');
  });

  test('a session that already owns the key is refused before any acquire is attempted', async () => {
    const client = fakeClient((sql) => {
      if (sql.includes('AS already_owned')) return { pid: 100, already_owned: true };
      if (isAcquire(sql)) return { pid: 100, acquired: true };
      if (isVerify(sql)) return { pid: 100, owned: true };
      return {};
    });
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    assert.equal(res.acquired, false);
    assert.equal(res.reason, 'already_owned');
    assert.equal(res.mustDestroyClient, true);
    assert.equal(
      client.calls.some((sql) => sql.includes('pg_try_advisory_lock')),
      false,
      'no lock level is stacked on a session that already holds the key',
    );
  });

  test('a pre-check answered by a different backend than the acquire is session_changed', async () => {
    let pid = 100;
    const client = fakeClient((sql) => {
      if (sql.includes('AS already_owned')) return { pid, already_owned: false };
      if (isAcquire(sql)) {
        pid = 200; // the pooler moved the statement to another backend
        return { pid, acquired: true };
      }
      if (isVerify(sql)) return { pid, owned: true };
      return {};
    });
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    assert.equal(res.acquired, false, 'evidence from two backends proves nothing');
    assert.equal(res.reason, 'session_changed');
    assert.equal(res.mustDestroyClient, true);
  });

  test('an acquire without a readable backend pid is refused (ownership unprovable)', async () => {
    const noPid = fakeClient((sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { acquired: true };
      if (isVerify(sql)) return { owned: true };
      return {};
    });
    const res = await acquireSessionAdvisoryLock(noPid, TEST_LOCK_KEY);
    assert.equal(res.acquired, false, 'nothing this session does later could be attributed to it');
    assert.equal(res.reason, 'not_owned');
    assert.equal(res.mustDestroyClient, true);

    // A pre-check without a pid is tolerated (the acquiring pid is the one that
    // must exist); the lock still has to be proven by the acquire statement.
    const precheckWithoutPid = fakeClient((sql) => {
      if (sql.includes('AS already_owned')) return { already_owned: false };
      if (sql.includes('pg_try_advisory_lock')) return { pid: 100, acquired: true };
      if (isVerify(sql)) return { pid: 100, owned: true };
      return {};
    });
    const res2 = await acquireSessionAdvisoryLock(precheckWithoutPid, TEST_LOCK_KEY);
    assert.equal(res2.acquired, true);
    assert.equal(res2.lock?.pid, 100);
  });

  test('a null/absent result is treated as not owned, never as success', async () => {
    const client: AdvisoryLockClient = {
      async query(sql: string) {
        if (isAcquire(sql)) return { rows: [{ pid: 100, acquired: true }] };
        if (isVerify(sql)) return { rows: [{ pid: 100, owned: true }] };
        if (isRelease(sql)) return { rows: [{}] };
        return { rows: [] };
      },
    };
    const res = await acquireSessionAdvisoryLock(client, TEST_LOCK_KEY);
    const release = await res.lock!.release();
    assert.equal(release.released, false);
    assert.equal(release.reason, 'not_owned');
    assert.equal(release.mustDestroyClient, true);
  });

  test('advisoryLockErrorCode bounds what may be logged', () => {
    assert.equal(advisoryLockErrorCode({ code: '57P01' }), '57P01');
    assert.equal(advisoryLockErrorCode({ code: 'x'.repeat(40) }), undefined);
    assert.equal(advisoryLockErrorCode({ code: 42 }), undefined);
    assert.equal(advisoryLockErrorCode(new Error('no code')), undefined);
    assert.equal(advisoryLockErrorCode(null), undefined);
  });

  test('holderLogMeta never emits undefined-valued noise for a missing holder', () => {
    assert.deepEqual(holderLogMeta(null), {});
    assert.deepEqual(holderLogMeta(undefined), {});
  });
});

describe('advisory lock — key namespace is unique across subsystems (regression)', () => {
  /**
   * PostgreSQL keeps every advisory lock in one namespace per database: a
   * `pg_advisory_lock(k)` and a `pg_advisory_xact_lock(k)` on the same key
   * exclude each other even when they belong to unrelated subsystems.
   *
   * This is the check that the scheduling/ingestion collision (both the scanner
   * warm cycle and the billing FX source used `875421010`) violated: an FX
   * observation being fetched made the warm cycle log `warm-cycle lock is
   * already held; skipping cycle` and skip its work, and vice versa.
   */
  test('every subsystem uses a distinct advisory key', () => {
    const keys: Record<string, number> = {
      scanner: SCANNER_ADVISORY_LOCK_KEY,
      'scheduled-ingestion': SCHEDULED_INGESTION_ADVISORY_LOCK_KEY,
      'fx-source': FX_SOURCE_ADVISORY_LOCK_KEY,
      'notification-fairness': NOTIFICATION_FAIRNESS_LOCK_KEY,
      migrations: MIGRATION_LOCK_KEY,
    };
    const entries = Object.entries(keys);
    const seen = new Map<number, string>();
    for (const [name, key] of entries) {
      assert.equal(Number.isInteger(key), true, `${name} key must be an integer`);
      assert.ok(key > 0 && key < 2 ** 52, `${name} key must be a positive safe integer`);
      const clash = seen.get(key);
      assert.equal(
        clash,
        undefined,
        `${name} reuses advisory key ${key} already owned by ${clash} — advisory keys are one namespace, so the two subsystems would silently serialise on each other`,
      );
      seen.set(key, name);
    }
    assert.equal(new Set(entries.map(([, key]) => key)).size, entries.length);
  });

  test('the intended key assignment is pinned, so a rename cannot silently re-collide', () => {
    // Pinned values: production logs and the database's `pg_locks` are read
    // against these numbers, and a changed number is a deployment-visible event.
    assert.equal(SCANNER_ADVISORY_LOCK_KEY, 875_421_009);
    assert.equal(FX_SOURCE_ADVISORY_LOCK_KEY, 875_421_010, 'the FX source keeps its historical key');
    assert.equal(SCHEDULED_INGESTION_ADVISORY_LOCK_KEY, 875_421_011, 'ingestion moved off the FX key');
    assert.equal(MIGRATION_LOCK_KEY, 611_231_007);
    assert.equal(NOTIFICATION_FAIRNESS_LOCK_KEY, 611_231_008);
  });

  test('an FX-source lock held on a real backend does not block a scheduled-ingestion acquire', async () => {
    const holder = await holdRawLock(FX_SOURCE_ADVISORY_LOCK_KEY);
    const client = await pool.connect();
    let mustDestroy = true;
    try {
      const res = await acquireSessionAdvisoryLock(client, SCHEDULED_INGESTION_ADVISORY_LOCK_KEY);
      assert.equal(
        res.acquired,
        true,
        'the warm cycle must be able to run while an FX observation check holds its own key',
      );
      assert.notEqual(res.lock, null);
      assert.equal(await countLocks(FX_SOURCE_ADVISORY_LOCK_KEY), 1, 'the FX key is still held by its owner');

      const release = await res.lock!.release();
      assert.equal(release.released, true);
      assert.equal(release.mustDestroyClient, false);
      mustDestroy = release.mustDestroyClient;
    } finally {
      // `SessionAdvisoryLock.release()` proves the unlock but never returns the
      // pooled client — the caller does (the scanner does the same).
      client.release(mustDestroy);
    }
    await holder.release();
  });
});

describe('advisory lock — heartbeat/orphan derivation (regression)', () => {
  const PRODUCTION_LEASE_MS = 1_800_000; // SCANNER_LEASE_MS in render.yaml

  test('at the production lease the heartbeat is 60s, not lease/4 (450s)', () => {
    const timing = deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS });
    assert.equal(timing.heartbeatMs, MAX_ADVISORY_LOCK_HEARTBEAT_MS);
    assert.equal(timing.heartbeatMs, 60_000);
    assert.equal(timing.orphanIdleMs, DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS);
  });

  test('a healthy holder is never idle past the orphan threshold', () => {
    // The invariant that the old code violated: heartbeat 450s > threshold 120s,
    // so ~73% of every heartbeat period a *healthy* scan looked abandoned.
    for (const leaseMs of [PRODUCTION_LEASE_MS, 60_000, 10_000, 2_000]) {
      const { heartbeatMs, orphanIdleMs } = deriveAdvisoryLockTiming({ leaseMs });
      assert.ok(
        orphanIdleMs >= heartbeatMs * 2,
        `lease ${leaseMs}: orphan threshold ${orphanIdleMs} must cover two heartbeat periods (${heartbeatMs})`,
      );
      assert.ok(
        heartbeatMs < leaseMs,
        `lease ${leaseMs}: a lost lock must be noticed inside the lease (heartbeat ${heartbeatMs})`,
      );
    }
    // Degenerate leases fall back to the 1s heartbeat floor; the orphan
    // threshold still covers it, so classification stays honest.
    for (const leaseMs of [1, 0, Number.NaN]) {
      const { heartbeatMs, orphanIdleMs } = deriveAdvisoryLockTiming({ leaseMs });
      assert.equal(heartbeatMs, 1_000);
      assert.ok(orphanIdleMs >= heartbeatMs * 2);
    }
  });

  test('the heartbeat is capped, and still detects loss far inside the lease', () => {
    const timing = deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS });
    assert.ok(timing.heartbeatMs <= MAX_ADVISORY_LOCK_HEARTBEAT_MS);
    assert.ok(
      timing.heartbeatMs * 4 <= PRODUCTION_LEASE_MS,
      'at least four ownership checks fit inside the production lease',
    );
    // An explicit, larger value is clamped rather than trusted.
    assert.equal(
      deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, heartbeatMs: 900_000 }).heartbeatMs,
      MAX_ADVISORY_LOCK_HEARTBEAT_MS,
    );
  });

  test('an explicit heartbeat is honoured (including the sub-second values tests use)', () => {
    assert.equal(deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, heartbeatMs: 1 }).heartbeatMs, 1);
    assert.equal(deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, heartbeatMs: 5_000 }).heartbeatMs, 5_000);
    assert.equal(deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, heartbeatMs: -1 }).heartbeatMs, 0);
    assert.equal(deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, heartbeatMs: Number.NaN }).heartbeatMs, MAX_ADVISORY_LOCK_HEARTBEAT_MS);
  });

  test('a disabled heartbeat leaves the default orphan threshold alone', () => {
    const timing = deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, heartbeatMs: 0 });
    assert.equal(timing.heartbeatMs, 0);
    assert.equal(timing.orphanIdleMs, DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS);
  });

  test('an explicit orphan threshold still wins (tests stage states that way)', () => {
    assert.equal(
      deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, orphanIdleMs: 0 }).orphanIdleMs,
      0,
    );
    assert.equal(
      deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, orphanIdleMs: 30_000 }).orphanIdleMs,
      30_000,
    );
    assert.equal(
      deriveAdvisoryLockTiming({ leaseMs: PRODUCTION_LEASE_MS, orphanIdleMs: Number.NaN }).orphanIdleMs,
      DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS,
    );
  });

  test('a holder idle for less than the threshold is not called a suspected orphan', async () => {
    const holder = await holdRawLock(SCANNER_ADVISORY_LOCK_KEY);
    try {
      const client = await pool.connect();
      try {
        const fresh = await readAdvisoryLockHolder(client, SCANNER_ADVISORY_LOCK_KEY, DEFAULT_ADVISORY_LOCK_ORPHAN_IDLE_MS);
        assert.ok(fresh, 'the holder is readable');
        assert.equal(fresh.state, 'idle');
        assert.equal(fresh.suspectedOrphaned, false, 'a holder idle for milliseconds is healthy, not abandoned');
        // The same backend, aged past the threshold, *is* flagged: the age test
        // is what classifies the holder, not the mere fact of being idle.
        const aged = await readAdvisoryLockHolder(client, SCANNER_ADVISORY_LOCK_KEY, 0);
        assert.equal(aged?.suspectedOrphaned, true);
      } finally {
        client.release();
      }
    } finally {
      await holder.release();
    }
  });
});
