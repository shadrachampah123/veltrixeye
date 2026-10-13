/* eslint-disable @typescript-eslint/no-explicit-any */
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
  const logger = {
    info: (message: string, meta?: Record<string, unknown>) => logs.push({ message, meta }),
    warn: () => {},
    error: () => {},
  };
  // Only the pool, provider registry (empty ⇒ provider unavailable, harmless
  // for prune/health/maintenance) and logger are exercised by these tests.
  scanner = new ScannerService(pool, createProviderRegistry(), candleStore, {} as any, {} as any, {} as any, {} as any, {} as any, {
    logger,
    runRetentionDays: 90,
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
