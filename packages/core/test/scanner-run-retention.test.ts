import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  DEFAULT_SCANNER_RUN_RETENTION_DAYS,
  MAX_SCANNER_RUN_RETENTION_DAYS,
  MIN_SCANNER_RUN_RETENTION_DAYS,
} from '@veltrixeye/contracts';
import {
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  UserService,
  StrategyService,
  AuditService,
  createProviderRegistry,
  CandleStore,
  ScannerService,
  clampRetentionDays,
  hashPassword,
  type RetentionSweepObservation,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5590;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_scanner_retention';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let strategies: StrategyService;
let candleStore: CandleStore;
let scanner: ScannerService;
const logs: { message: string; meta?: Record<string, unknown> }[] = [];
/**
 * Test logger shared by the fixture service and the stub-pool services below.
 * Captures every level: the sweep's own info line AND the warn an observer
 * failure produces, so "nothing was logged" is only ever asserted per-message.
 */
const logger = {
  info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
  warn: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
  error: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
};
/**
 * Every sweep observation the fixture service reports, so the F15
 * observability contract (a zero-delete sweep is still recorded) is pinned
 * against the real pruning path rather than a mock.
 */
const sweeps: RetentionSweepObservation[] = [];

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-scanner-retention');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);

  const audit = new AuditService(pool);
  users = new UserService(pool);
  strategies = new StrategyService(pool, audit);
  candleStore = new CandleStore(pool);
  // Only the pool, provider registry (empty ⇒ provider unavailable, harmless
  // for prune/health/maintenance) and logger are exercised by these tests.
  scanner = new ScannerService(pool, createProviderRegistry(), candleStore, {} as any, {} as any, {} as any, {} as any, {} as any, {
    logger,
    runRetentionDays: 90,
    onRetentionSweep: (observation) => sweeps.push(observation),
  });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

/** Each test starts from an empty ledger (no FKs reference scanner_runs). */
async function resetRuns(): Promise<void> {
  await pool.query(`DELETE FROM scanner_runs`);
}

/** Insert a run with `started_at = now() - <offset>` and optional finish. */
async function insertRun(status: string, offset: string, finishedOffset?: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO scanner_runs (status, provider_slug, started_at, finished_at, metadata)
     VALUES ($1, 'twelve-data', now() - $2::interval,
             CASE WHEN $3::text IS NULL THEN NULL ELSE now() - $3::interval END,
             '{"triggeredBy":"system"}')
     RETURNING id`,
    [status, offset, finishedOffset ?? null],
  );
  return res.rows[0]!.id;
}

async function exists(id: string): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM scanner_runs WHERE id = $1`, [id]);
  return (res.rowCount ?? 0) > 0;
}

async function countRuns(): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM scanner_runs`);
  return Number(res.rows[0]!.n);
}

describe('F15: scanner_runs retention — configuration bounds (pure)', () => {
  test('clampRetentionDays defaults invalid input and clamps to documented bounds', () => {
    assert.equal(DEFAULT_SCANNER_RUN_RETENTION_DAYS, 90);
    assert.equal(clampRetentionDays(undefined), 90);
    assert.equal(clampRetentionDays(Number.NaN), 90);
    assert.equal(clampRetentionDays(Number.POSITIVE_INFINITY), 90);
    assert.equal(clampRetentionDays(0), MIN_SCANNER_RUN_RETENTION_DAYS);
    assert.equal(clampRetentionDays(-5), MIN_SCANNER_RUN_RETENTION_DAYS);
    assert.equal(clampRetentionDays(1), 1);
    assert.equal(clampRetentionDays(30.9), 30, 'fractional days truncate toward zero');
    assert.equal(clampRetentionDays(MAX_SCANNER_RUN_RETENTION_DAYS + 1), MAX_SCANNER_RUN_RETENTION_DAYS);
  });
});

describe('F15: scanner_runs retention — boundary and exclusion rules', () => {
  test('deletes completed/failed rows just past the window and keeps rows just inside it', async () => {
    await resetRuns();
    // Anchor row so the newest-terminal / newest-completed protection never
    // selects one of the boundary rows under test.
    await insertRun('completed', '1 hour', '1 hour');

    const oldCompleted = await insertRun('completed', '90 days 1 hour', '90 days 59 minutes');
    const oldFailed = await insertRun('failed', '90 days 1 hour');
    const insideCompleted = await insertRun('completed', '89 days 23 hours', '89 days 22 hours');
    const insideFailed = await insertRun('failed', '89 days 23 hours');

    const deleted = await scanner.pruneTerminalRuns({ retentionDays: 90 });
    assert.equal(deleted, 2);
    assert.equal(await exists(oldCompleted), false, 'completed run past the window is pruned');
    assert.equal(await exists(oldFailed), false, 'failed run past the window is pruned');
    assert.equal(await exists(insideCompleted), true, 'completed run inside the window is kept');
    assert.equal(await exists(insideFailed), true, 'failed run inside the window is kept');
  });

  test('never deletes running or partial runs, even when they are ancient', async () => {
    await resetRuns();
    await insertRun('completed', '1 hour', '1 hour');
    const ancientRunning = await insertRun('running', '400 days');
    const ancientPartial = await insertRun('partial', '400 days', '400 days');
    const ancientCompleted = await insertRun('completed', '400 days', '400 days');

    const deleted = await scanner.pruneTerminalRuns({ retentionDays: 90 });
    assert.equal(deleted, 1, 'only the ancient completed run is a candidate');
    assert.equal(await exists(ancientRunning), true, 'running run is never pruned');
    assert.equal(await exists(ancientPartial), true, 'partial run is outside the completed/failed policy');
    assert.equal(await exists(ancientCompleted), false);
  });

  test('scanner_cursors are never touched by the sweep', async () => {
    await resetRuns();
    const email = `retention_${randomBytes(6).toString('hex')}@example.com`;
    const user = await users.create({
      email,
      passwordHash: await hashPassword('correct-horse-42'),
      name: 'Retention Test',
    });
    const strategy = await strategies.createStrategy(user.id, {
      name: `Retention Strat ${Date.now()}`,
      description: 'test',
    });
    const versionId = strategy.versions[0]!.id;
    const inst = await candleStore.resolveInstrument('forex', 'EURUSD');
    assert.ok(inst, 'seeded instrument resolves');
    await pool.query(
      `INSERT INTO scanner_cursors (strategy_version_id, instrument_id, timeframe, last_candle_time, last_scan_at)
       VALUES ($1, $2, '1h', $3, now() - interval '500 days')`,
      [versionId, inst!.id, Date.now() - 3_600_000],
    );
    const cursorsBefore = await pool.query(`SELECT count(*)::int AS n FROM scanner_cursors`);

    await insertRun('failed', '500 days');
    await insertRun('completed', '1 hour', '1 hour');
    await scanner.pruneTerminalRuns({ retentionDays: 1 });
    await scanner.runMaintenance({ leaseMs: 300_000 });

    const cursorsAfter = await pool.query(`SELECT count(*)::int AS n FROM scanner_cursors`);
    assert.equal(cursorsAfter.rows[0].n, cursorsBefore.rows[0].n);
    assert.ok(cursorsBefore.rows[0].n >= 1, 'fixture cursor exists so the assertion is meaningful');
  });
});

describe('F15: scanner_runs retention — health preservation, idempotency, batching', () => {
  test('keeps the rows behind health lastRun and lastSuccessfulRun even when everything is past retention', async () => {
    await resetRuns();
    await insertRun('completed', '200 days', '200 days');
    await insertRun('failed', '150 days');
    const newestCompleted = await insertRun('completed', '120 days', '120 days');
    const newestTerminal = await insertRun('failed', '100 days');

    const healthBefore = await scanner.getHealth();
    const deleted = await scanner.pruneTerminalRuns({ retentionDays: 90 });
    const healthAfter = await scanner.getHealth();

    assert.equal(deleted, 2, 'two older candidates are pruned; the two newest terminal rows are protected');
    assert.equal(await exists(newestCompleted), true);
    assert.equal(await exists(newestTerminal), true);
    assert.equal(healthAfter.lastRun?.id, healthBefore.lastRun?.id);
    assert.equal(healthAfter.lastSuccessfulRun?.id, healthBefore.lastSuccessfulRun?.id);
    assert.equal(healthAfter.lastSuccessfulRun?.id, newestCompleted);
  });

  test('is idempotent: a repeat sweep deletes nothing and leaves the ledger unchanged', async () => {
    await resetRuns();
    await insertRun('completed', '1 hour', '1 hour');
    await insertRun('failed', '300 days');
    await insertRun('completed', '300 days', '300 days');

    // The 1-hour anchor (newest terminal and newest completed) is protected; both 300-day rows are candidates.
    assert.equal(await scanner.pruneTerminalRuns({ retentionDays: 90 }), 2);
    const afterFirst = await countRuns();
    assert.equal(await scanner.pruneTerminalRuns({ retentionDays: 90 }), 0);
    assert.equal(await countRuns(), afterFirst);
  });

  test('bounded batches: a backlog larger than one batch is drained in one sweep, keeping protected rows', async () => {
    await resetRuns();
    // 1,250 old failed rows: more than two 500-row batches. No completed rows,
    // so only the single newest terminal row is protected.
    await pool.query(
      `INSERT INTO scanner_runs (status, provider_slug, started_at, finished_at)
       SELECT 'failed', 'twelve-data', now() - interval '200 days' - (g * interval '1 minute'),
              now() - interval '200 days' - (g * interval '1 minute')
         FROM generate_series(1, 1250) g`,
    );
    const deleted = await scanner.pruneTerminalRuns({ retentionDays: 90 });
    assert.equal(deleted, 1249);
    assert.equal(await countRuns(), 1);
  });

  test('concurrent sweeps do not double-count or error, and never delete a running row', async () => {
    await resetRuns();
    await pool.query(
      `INSERT INTO scanner_runs (status, provider_slug, started_at, finished_at)
       SELECT 'completed', 'twelve-data', now() - interval '200 days' - (g * interval '1 minute'),
              now() - interval '200 days' - (g * interval '1 minute')
         FROM generate_series(1, 1200) g`,
    );
    const runningId = await insertRun('running', '400 days');
    await insertRun('completed', '1 hour', '1 hour');

    const results = await Promise.all([
      scanner.pruneTerminalRuns({ retentionDays: 90 }),
      scanner.pruneTerminalRuns({ retentionDays: 90 }),
      scanner.pruneTerminalRuns({ retentionDays: 90 }),
    ]);
    const total = results.reduce((a, b) => a + b, 0);
    assert.equal(total, 1200, 'every candidate is deleted exactly once across concurrent sweeps');
    assert.equal(await exists(runningId), true, 'running row survives concurrent sweeps');
    assert.equal(await countRuns(), 2);
  });
});

describe('F15: scanner_runs retention — maintenance contract and logging', () => {
  test('runMaintenance prunes but keeps the internal response shape unchanged and logs counts only', async () => {
    await resetRuns();
    await insertRun('completed', '1 hour', '1 hour');
    const oldId = await insertRun('failed', '365 days');
    logs.length = 0;

    const res = await scanner.runMaintenance({ leaseMs: 300_000 });
    assert.deepEqual(
      Object.keys(res).sort(),
      ['activeRuns', 'isProviderAvailable', 'recentFailures', 'recovered', 'status'],
      'maintenance response keys are unchanged',
    );
    assert.equal(await exists(oldId), false, 'maintenance performed the prune');

    const retentionLog = logs.find((l) => l.message === 'scanner run retention');
    assert.ok(retentionLog, 'sweep with deletions logs once');
    assert.deepEqual(Object.keys(retentionLog!.meta ?? {}).sort(), ['deleted', 'retentionDays']);
    assert.equal(retentionLog!.meta!.deleted, 1);
    assert.equal(retentionLog!.meta!.retentionDays, 90);
    assert.ok(!JSON.stringify(logs).match(/[0-9a-f]{8}-[0-9a-f]{4}-/i), 'no run ids in logs');
  });

  test('a sweep that deletes nothing logs nothing', async () => {
    await resetRuns();
    await insertRun('completed', '1 hour', '1 hour');
    logs.length = 0;
    assert.equal(await scanner.pruneTerminalRuns({ retentionDays: 90 }), 0);
    assert.equal(logs.filter((l) => l.message === 'scanner run retention').length, 0);
  });
});

/**
 * The gap this closes: a sweep used to be observable ONLY through a log line
 * emitted when it deleted something, so on a ledger young enough to have no
 * eligible rows — production today — "ran and found nothing" and "never ran"
 * looked identical. Every attempt must now be reported, and the report must
 * stay free of row ids, SQL and error messages.
 */
describe('F15: retention sweep observability (every attempt is reported)', () => {
  test('a zero-delete sweep is reported as completed — the case a log line cannot prove', async () => {
    await resetRuns();
    await insertRun('completed', '1 hour', '1 hour');
    sweeps.length = 0;

    assert.equal(await scanner.pruneTerminalRuns({ retentionDays: 90 }), 0);

    assert.equal(sweeps.length, 1, 'a sweep that deleted nothing is still observed');
    const observation = sweeps[0]!;
    assert.equal(observation.outcome, 'completed');
    if (observation.outcome !== 'completed') return;
    assert.equal(observation.deleted, 0);
    assert.equal(observation.retentionDays, 90, 'the applied window is carried');
    assert.equal(observation.batches, 1, 'one bounded statement drains an empty candidate set');
    assert.equal(observation.batchCeilingReached, false);
    assert.ok(observation.durationMs >= 0, 'duration is non-negative');
    assert.ok(
      Math.abs(Date.now() - observation.sweptAtMs) < 60_000,
      'the observation is stamped with the sweep clock, not a stale value',
    );
  });

  test('a sweep that deletes rows reports the count, the window and the batch shape', async () => {
    await resetRuns();
    await insertRun('completed', '1 hour', '1 hour');
    await insertRun('failed', '365 days');
    const ancient = await insertRun('completed', '365 days', '365 days');
    sweeps.length = 0;

    const deleted = await scanner.pruneTerminalRuns({ retentionDays: 30 });
    assert.equal(deleted, 2, 'the failed and the oldest completed run age out of a 30-day window');
    assert.equal(await exists(ancient), false);

    assert.equal(sweeps.length, 1);
    const observation = sweeps[0]!;
    assert.equal(observation.outcome, 'completed');
    if (observation.outcome !== 'completed') return;
    assert.equal(observation.deleted, 2);
    assert.equal(observation.retentionDays, 30, 'the override window is reported, not the configured one');
    assert.equal(observation.batchCeilingReached, false, 'a drained ledger does not report a backlog');
  });

  test('the observation never carries a row id, an SQL statement or a message', async () => {
    await resetRuns();
    const anchor = await insertRun('completed', '1 hour', '1 hour');
    const expired = await insertRun('failed', '365 days');
    sweeps.length = 0;
    await scanner.pruneTerminalRuns({ retentionDays: 90 });

    const serialized = JSON.stringify(sweeps);
    assert.ok(!serialized.includes(anchor), 'no run id from the kept anchor row');
    assert.ok(!serialized.includes(expired), 'no run id from the deleted row');
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(serialized), 'no UUID-shaped value at all');
    assert.ok(!serialized.includes('DELETE FROM'), 'no SQL text');
    assert.ok(!serialized.includes('scanner_runs'), 'no table name');
  });

  test('a failing sweep is reported as failed and still rejects (never swallowed)', async () => {
    const failure = Object.assign(new Error('connect ECONNREFUSED postgres://user:pw@host/db'), {
      code: 'ECONNREFUSED',
    });
    const failing = new ScannerService(
      { query: async () => { throw failure; } } as any,
      createProviderRegistry(),
      candleStore,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { logger, runRetentionDays: 90, onRetentionSweep: (observation) => sweeps.push(observation) },
    );
    sweeps.length = 0;

    await assert.rejects(
      () => failing.pruneTerminalRuns({ retentionDays: 90 }),
      /ECONNREFUSED/,
      'a failed sweep must still surface to the maintenance caller',
    );

    assert.equal(sweeps.length, 1);
    const observation = sweeps[0]!;
    assert.equal(observation.outcome, 'failed');
    if (observation.outcome !== 'failed') return;
    assert.equal(observation.retentionDays, 90);
    assert.equal(observation.error, failure, 'the observer receives the thrown value to reduce');
    assert.ok(!JSON.stringify(sweeps).includes('postgres://'), 'the raw value is not serialized into the report');
  });

  test('the batch ceiling is reported when a full final batch stops the sweep', async () => {
    // 20 statements x 500 rows: a pool that always reports a full batch makes
    // the ceiling reachable without inserting 10,000 rows.
    let statements = 0;
    const fullBatch = new ScannerService(
      { query: async () => { statements += 1; return { rowCount: 500 }; } } as any,
      createProviderRegistry(),
      candleStore,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { logger, runRetentionDays: 90, onRetentionSweep: (observation) => sweeps.push(observation) },
    );
    sweeps.length = 0;

    assert.equal(await fullBatch.pruneTerminalRuns({ retentionDays: 90 }), 10_000);
    assert.equal(statements, 20, 'the sweep stays inside its 20-statement bound');

    const observation = sweeps[0]!;
    assert.equal(observation.outcome, 'completed');
    if (observation.outcome !== 'completed') return;
    assert.equal(observation.batches, 20);
    assert.equal(observation.batchCeilingReached, true, 'a backlog past the ceiling is visible');
  });

  test('a broken observer can never break maintenance', async () => {
    await resetRuns();
    await insertRun('completed', '1 hour', '1 hour');
    const ancient = await insertRun('failed', '365 days');
    const throwing = new ScannerService(
      pool,
      createProviderRegistry(),
      candleStore,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        logger,
        runRetentionDays: 90,
        onRetentionSweep: () => { throw new Error('sink exploded at postgres://user:pw@host/db'); },
      },
    );
    logs.length = 0;

    assert.equal(
      await throwing.pruneTerminalRuns({ retentionDays: 90 }),
      1,
      'the sweep still reports its result when the observer throws',
    );
    assert.equal(await exists(ancient), false, 'the prune still happened');

    const warn = logs.find((l) => l.message === 'retention sweep observer failed');
    assert.ok(warn, 'the broken observer is reported');
    assert.deepEqual(Object.keys(warn!.meta ?? {}).sort(), ['error', 'outcome']);
    assert.equal(warn!.meta!.error, 'error', 'only the error name is logged, never the message');
    assert.ok(
      !JSON.stringify(logs).includes('postgres://'),
      'an observer error message can never reach the logs',
    );
  });
});
