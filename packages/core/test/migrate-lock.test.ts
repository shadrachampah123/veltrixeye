/**
 * Regression suite for the migration advisory-lock behaviour that gates boot.
 *
 * The production symptom class this covers: a deploy starts a new instance
 * while the previous one (or an operator CLI) is still migrating, so the new
 * instance blocks on the migration lock. These tests prove the lock wait is
 * bounded and clearly reported, that a contended run recovers once the lock
 * is released, and that the lock is always released after a run (no leak that
 * would block the next instance forever).
 *
 * Runs against a real embedded PostgreSQL because advisory locks are
 * server-session state — a mock cannot prove acquisition/release semantics.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  MIGRATION_LOCK_KEY,
  type RunMigrationsResult,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Unique per suite file.
const DB_PORT = 5440;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_migrate_lock';

let stopDb: () => Promise<void>;
let poolA: ReturnType<typeof createPool>;
let poolB: ReturnType<typeof createPool>;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-migrate-lock');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  poolA = createPool({ databaseUrl: db.dbUrl });
  poolB = createPool({ databaseUrl: db.dbUrl });
}, { timeout: 240_000 });

after(async () => {
  await poolA?.end().catch(() => {});
  await poolB?.end().catch(() => {});
  await stopDb?.();
});

/** A short sleep so the contended run has time to start blocking on the lock. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire the migration lock on a dedicated client and return an idempotent
 * `release`. `release()` is safe to call more than once: the client is
 * unlocked and returned to the pool exactly once.
 */
async function holdMigrationLock(pool: ReturnType<typeof createPool>) {
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    },
  };
}

describe('runMigrations advisory lock', () => {
  test('times out clearly when the migration lock is held by another session', async () => {
    const holder = await holdMigrationLock(poolA);
    try {
      // A short lock-wait keeps the test fast; the production default is 60s.
      await assert.rejects(
        () => runMigrations(poolB, MIGRATIONS_DIR, { lockWaitMs: 600 }),
        (err: Error) => {
          assert.match(err.message, /Timed out waiting for the migration lock/);
          assert.match(err.message, /retry when it finishes/);
          return true;
        },
      );
    } finally {
      await holder.release();
    }
  });

  test('waits for a contended lock and succeeds once it is released', async () => {
    const holder = await holdMigrationLock(poolA);
    let result: RunMigrationsResult | null = null;
    try {
      // Start the run while the lock is held. Wait for the run to begin
      // blocking on the lock, then release it so the polling loop acquires
      // it and proceeds. The release is awaited, so no timer is left running.
      const runPromise = runMigrations(poolB, MIGRATIONS_DIR, { lockWaitMs: 10_000 });
      await sleep(100);
      await holder.release();
      result = await runPromise;
    } finally {
      // Idempotent: a no-op if the release already ran above.
      await holder.release();
    }
    assert.ok(result, 'runMigrations should resolve after the lock is released');
    // The lock was contended: acquisition took at least the release delay.
    assert.ok(result.lockWaitMs >= 100, `expected a contended wait, got ${result.lockWaitMs}ms`);
  });

  test('releases the advisory lock after a successful run (no leak)', async () => {
    // A fresh, uncontended run must apply migrations and release the lock so
    // the next instance is not blocked.
    const result = await runMigrations(poolB, MIGRATIONS_DIR);
    assert.equal(result.applied.length, 0, 'migrations already applied by the prior test');
    assert.equal(result.alreadyApplied.length > 0, true);

    // A different session must be able to take the lock immediately: if the
    // runner had leaked it, this try_advisory_lock would return false.
    const client = await poolA.connect();
    try {
      const res = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [MIGRATION_LOCK_KEY],
      );
      assert.equal(res.rows[0]?.locked, true, 'the migration lock was leaked by the prior run');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  });
});
