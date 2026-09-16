import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  BACKTEST_ENGINE_VERSION,
  type BacktestExitPolicy,
  type BacktestCostPolicy,
} from '@veltrixeye/contracts';
import {
  createPool,
  runMigrations,
  migrationStatus,
  MIGRATIONS_DIR,
  hashPassword,
  UserService,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Unique per suite file: core 5434, api 5435-5438.
const DB_PORT = 5439;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_m6_test';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;

const uniqueEmail = () => `m6_${randomBytes(6).toString('hex')}@example.com`;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m6');
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
  users = new UserService(pool);
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

function pgCode(err: unknown): string {
  assert.ok(err !== null && typeof err === 'object' && 'code' in err);
  return String((err as { code: unknown }).code);
}

async function makeOwner(): Promise<string> {
  const user = await users.create({
    email: uniqueEmail(),
    passwordHash: await hashPassword('correct-horse-42'),
    name: 'M6 Trader',
  });
  return user.id;
}

async function makeInstrument(assetClass = 'forex', symbol?: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    'INSERT INTO instruments (asset_class, symbol) VALUES ($1, $2) RETURNING id',
    [assetClass, symbol ?? `TST${randomBytes(2).toString('hex').toUpperCase()}`],
  );
  const row = res.rows[0];
  assert.ok(row);
  return row.id;
}

async function makeStrategyVersion(ownerId: string): Promise<{ strategyId: string; versionId: string }> {
  const s = await pool.query<{ id: string }>('INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id', [
    ownerId,
    'm6-fixture',
  ]);
  const strategyId = s.rows[0]?.id;
  assert.ok(strategyId);
  const v = await pool.query<{ id: string }>(
    'INSERT INTO strategy_versions (strategy_id, version_number) VALUES ($1, 1) RETURNING id',
    [strategyId],
  );
  const versionId = v.rows[0]?.id;
  assert.ok(versionId);
  return { strategyId, versionId };
}

async function makeSetup(versionId: string, instrumentId: string, state = 'confirmed'): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms)
     VALUES ($1, $2, $3, 'long', now(), $4) RETURNING id`,
    [versionId, instrumentId, state, 1800000000000],
  );
  const row = res.rows[0];
  assert.ok(row);
  return row.id;
}

const CONFIG_HASH = 'a'.repeat(64);
const EXIT_POLICY = {
  stopLoss: 'level',
  takeProfit: 'tp3',
  maxHoldCandles: 100,
  sameCandleRule: 'stop_first',
  entryTiming: 'signal_close',
} satisfies BacktestExitPolicy;
const COST_POLICY = { feePerSide: 0, slippagePerSide: 0, spread: 0 } satisfies BacktestCostPolicy;

async function insertRun(opts: {
  ownerId: string;
  strategyId: string;
  versionId: string;
  instrumentId: string;
  direction?: string;
  fromMs?: number;
  toMs?: number;
  configHash?: string;
  status?: string;
}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO backtest_runs
       (user_id, strategy_id, strategy_version_id, instrument_id, direction, engine_version,
        from_ms, to_ms, exit_policy, cost_policy, config_hash, status,
        steps_evaluated, setups_detected, trades_closed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 7, 3, 3)
     RETURNING id`,
    [
      opts.ownerId,
      opts.strategyId,
      opts.versionId,
      opts.instrumentId,
      opts.direction ?? 'long',
      BACKTEST_ENGINE_VERSION,
      opts.fromMs ?? 1_800_000_000_000,
      opts.toMs ?? 1_800_010_000_000,
      JSON.stringify(EXIT_POLICY),
      JSON.stringify(COST_POLICY),
      opts.configHash ?? CONFIG_HASH,
      opts.status ?? 'completed',
    ],
  );
  const row = res.rows[0];
  assert.ok(row);
  return row.id;
}

// ---------------------------------------------------------------------------
// Migration chain + 0011 backtests
// ---------------------------------------------------------------------------

describe('m6 migrations: chain and backtest tables (0011)', () => {
  test('apply cleanly through 0012 and stay idempotent', async () => {
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.equal(status.pending.length, 0);
    assert.ok(status.appliedCount >= 12);
    // The chain is additive: M7.3 appended 0013 (the notification outbox),
    // M7.5 appended 0015 (scanner runs) and M8.1 appended 0016 (execution
    // architecture) without touching 0001-0012, so the head moved on while
    // every earlier migration — and this suite's 0011/0012 assertions — still
    // hold.
    assert.equal(status.expectedCount, 16);
    assert.equal(status.latestApplied, '0016_execution_architecture.sql');
    assert.equal(status.checksumsMatch, true);
    const second = await runMigrations(pool, MIGRATIONS_DIR);
    assert.equal(second.applied.length, 0);
  });

  test('identical inputs collapse onto one run row (idempotency key)', async () => {
    const owner = await makeOwner();
    const instrument = await makeInstrument();
    const { strategyId, versionId } = await makeStrategyVersion(owner);
    const base = { ownerId: owner, strategyId, versionId, instrumentId: instrument };
    const first = await insertRun(base);
    assert.ok(first);
    await assert.rejects(insertRun(base), (err: unknown) => pgCode(err) === '23505');

    // Any key component differs ⇒ a new row.
    const otherRange = await insertRun({ ...base, fromMs: 1_800_020_000_000, toMs: 1_800_030_000_000 });
    assert.ok(otherRange);
    // …but a different owner replaying identical inputs gets their own row.
    const owner2 = await makeOwner();
    const { strategyId: s2, versionId: v2 } = await makeStrategyVersion(owner2);
    const foreign = await insertRun({ ...base, ownerId: owner2, strategyId: s2, versionId: v2 });
    assert.ok(foreign);

    const res = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM backtest_runs WHERE user_id = $1',
      [owner],
    );
    assert.equal(res.rows[0]?.n, '2');
  });

  test('reject malformed runs at the schema boundary', async () => {
    const owner = await makeOwner();
    const instrument = await makeInstrument();
    const { strategyId, versionId } = await makeStrategyVersion(owner);
    const base = { ownerId: owner, strategyId, versionId, instrumentId: instrument };
    // Inverted bounds.
    await assert.rejects(insertRun({ ...base, fromMs: 5, toMs: 5 }), (err: unknown) => pgCode(err) === '23514');
    // Unknown direction / status.
    await assert.rejects(insertRun({ ...base, direction: 'sideways' }), (err: unknown) => pgCode(err) === '23514');
    await assert.rejects(insertRun({ ...base, status: 'running' }), (err: unknown) => pgCode(err) === '23514');
    // Truncated config hash.
    await assert.rejects(insertRun({ ...base, configHash: 'abc' }), (err: unknown) => pgCode(err) === '23514');
    // Dangling foreign keys.
    await assert.rejects(
      insertRun({ ...base, instrumentId: '00000000-0000-0000-0000-000000000000' }),
      (err: unknown) => pgCode(err) === '23503',
    );
  });

  test('trades are append-only and scoped to their run', async () => {
    const owner = await makeOwner();
    const instrument = await makeInstrument();
    const { strategyId, versionId } = await makeStrategyVersion(owner);
    const runId = await insertRun({ ownerId: owner, strategyId, versionId, instrumentId: instrument });

    const asOfMs = 1800000360000;
    const trade = await pool.query<{ id: string }>(
      `INSERT INTO backtest_trades
         (run_id, seq, instrument_id, direction, signal_as_of_ms,
          entry_price, stop_loss_price, tp1_price, tp2_price, tp3_price,
          quality_score, quality_grade, exit_reason, exit_price, exit_as_of_ms, pnl_r)
       VALUES ($1, 0, $2, 'long', $3, 100, 99.999, 100.001, 100.002, 100.003, 75, 'B',
               'take_profit_2', 100.002, $4, 2)
       RETURNING id`,
      [runId, instrument, asOfMs, asOfMs + 3600000],
    );
    assert.ok(trade.rows[0]?.id);
    // Duplicate seq within a run collides; dangling runs are rejected.
    await assert.rejects(
      pool.query(
        `INSERT INTO backtest_trades (run_id, seq, instrument_id, direction, signal_as_of_ms, exit_reason)
         VALUES ($1, 0, $2, 'short', $3, 'no_levels')`,
        [runId, instrument, asOfMs],
      ),
      (err: unknown) => pgCode(err) === '23505',
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO backtest_trades (run_id, seq, instrument_id, direction, signal_as_of_ms, exit_reason)
         VALUES ('00000000-0000-0000-0000-000000000000', 0, $1, 'long', 1, 'no_levels')`,
        [instrument],
      ),
      (err: unknown) => pgCode(err) === '23503',
    );
    // History cannot be rewritten or erased.
    await assert.rejects(pool.query('UPDATE backtest_trades SET pnl_r = 99 WHERE run_id = $1', [runId]));
    await assert.rejects(pool.query('DELETE FROM backtest_trades WHERE run_id = $1', [runId]));
    const res = await pool.query<{ pnl_r: string }>('SELECT pnl_r FROM backtest_trades WHERE run_id = $1', [runId]);
    assert.equal(res.rows[0]?.pnl_r, '2.0000');
  });
});

// ---------------------------------------------------------------------------
// 0012 alerts
// ---------------------------------------------------------------------------

describe('m6 migrations: alert tables (0012)', () => {
  test('one alert per setup per triggering state (dedup key)', async () => {
    const owner = await makeOwner();
    const instrument = await makeInstrument();
    const { strategyId, versionId } = await makeStrategyVersion(owner);
    const setupId = await makeSetup(versionId, instrument);

    const insertAlert = (triggerState: string) =>
      pool.query<{ id: string }>(
        `INSERT INTO alerts
           (user_id, setup_id, strategy_id, strategy_version_id, instrument_id, direction,
            trigger_state, quality_score, min_quality_score, title)
         VALUES ($1, $2, $3, $4, $5, 'long', $6, 75, 65, 'EURUSD long confirmed (75/B)') RETURNING id`,
        [owner, setupId, strategyId, versionId, instrument, triggerState],
      );
    const confirmed = await insertAlert('confirmed');
    assert.ok(confirmed.rows[0]?.id);
    // Retry collapses onto the row.
    await assert.rejects(insertAlert('confirmed'), (err: unknown) => pgCode(err) === '23505');
    // The second eligible state is a separate row.
    const triggered = await insertAlert('triggered');
    assert.ok(triggered.rows[0]?.id);
    // Ineligible states and bad gates are rejected.
    await assert.rejects(insertAlert('watching'), (err: unknown) => pgCode(err) === '23514');
  });

  test('alert status stays mutable (acknowledge/suppress) while deliveries are append-only', async () => {
    const owner = await makeOwner();
    const instrument = await makeInstrument();
    const { strategyId, versionId } = await makeStrategyVersion(owner);
    const setupId = await makeSetup(versionId, instrument);
    const alert = await pool.query<{ id: string }>(
      `INSERT INTO alerts
         (user_id, setup_id, strategy_id, strategy_version_id, instrument_id, direction,
          trigger_state, quality_score, min_quality_score, title)
       VALUES ($1, $2, $3, $4, $5, 'short', 'triggered', 80, 65, 'GBPUSD short triggered (80/B)') RETURNING id`,
      [owner, setupId, strategyId, versionId, instrument],
    );
    const alertId = alert.rows[0]?.id;
    assert.ok(alertId);

    // Acknowledge: a status UPDATE the append-only ledger must never block.
    await pool.query("UPDATE alerts SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1", [alertId]);
    const after = await pool.query<{ status: string }>('SELECT status FROM alerts WHERE id = $1', [alertId]);
    assert.equal(after.rows[0]?.status, 'acknowledged');
    // …but only to known statuses.
    await assert.rejects(
      pool.query("UPDATE alerts SET status = 'snoozed' WHERE id = $1", [alertId]),
      (err: unknown) => pgCode(err) === '23514',
    );

    // Delivery ledger: stub attempt recorded without any external I/O.
    const payloadHash = randomBytes(32).toString('hex');
    const delivery = await pool.query<{ id: string }>(
      `INSERT INTO alert_deliveries (alert_id, channel, status, payload_hash)
       VALUES ($1, 'stub', 'delivered', $2) RETURNING id`,
      [alertId, payloadHash],
    );
    assert.ok(delivery.rows[0]?.id);
    // Same alert + channel + payload is idempotent; unknown channels rejected.
    await assert.rejects(
      pool.query('INSERT INTO alert_deliveries (alert_id, channel, status, payload_hash) VALUES ($1, $2, $3, $4)', [
        alertId,
        'stub',
        'delivered',
        payloadHash,
      ]),
      (err: unknown) => pgCode(err) === '23505',
    );
    await assert.rejects(
      pool.query('INSERT INTO alert_deliveries (alert_id, channel, status, payload_hash) VALUES ($1, $2, $3, $4)', [
        alertId,
        'sms',
        'delivered',
        randomBytes(32).toString('hex'),
      ]),
      (err: unknown) => pgCode(err) === '23514',
    );
    // Ledger rows can never be rewritten or erased.
    await assert.rejects(pool.query("UPDATE alert_deliveries SET status = 'failed' WHERE alert_id = $1", [alertId]));
    await assert.rejects(pool.query('DELETE FROM alert_deliveries WHERE alert_id = $1', [alertId]));
    const kept = await pool.query<{ status: string }>('SELECT status FROM alert_deliveries WHERE alert_id = $1', [
      alertId,
    ]);
    assert.equal(kept.rows[0]?.status, 'delivered');
  });

  test('alerts are owner-scoped and cascade with their setup', async () => {
    const ownerA = await makeOwner();
    const ownerB = await makeOwner();
    const instrument = await makeInstrument();
    const a = await makeStrategyVersion(ownerA);
    const b = await makeStrategyVersion(ownerB);
    const setupA = await makeSetup(a.versionId, instrument);
    const setupB = await makeSetup(b.versionId, instrument);
    for (const [owner, ids, setup] of [
      [ownerA, a, setupA],
      [ownerB, b, setupB],
    ] as const) {
      await pool.query(
        `INSERT INTO alerts
           (user_id, setup_id, strategy_id, strategy_version_id, instrument_id, direction,
            trigger_state, quality_score, min_quality_score, title)
         VALUES ($1, $2, $3, $4, $5, 'long', 'confirmed', 70, 65, 'scoped')`,
        [owner, setup, ids.strategyId, ids.versionId, instrument],
      );
    }
    const onlyA = await pool.query<{ n: string }>('SELECT count(*) AS n FROM alerts WHERE user_id = $1', [ownerA]);
    assert.equal(onlyA.rows[0]?.n, '1');

    await pool.query('DELETE FROM setups WHERE id = $1', [setupA]);
    const surviving = await pool.query<{ n: string }>('SELECT count(*) AS n FROM alerts WHERE user_id = $1', [ownerA]);
    assert.equal(surviving.rows[0]?.n, '0');
    const untouched = await pool.query<{ n: string }>('SELECT count(*) AS n FROM alerts WHERE user_id = $1', [ownerB]);
    assert.equal(untouched.rows[0]?.n, '1');
  });
});
