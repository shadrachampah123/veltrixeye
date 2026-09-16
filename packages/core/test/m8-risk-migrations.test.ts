import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, runMigrations, migrationStatus, MIGRATIONS_DIR, hashPassword, UserService } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5449;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_m8_risk_migrations';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m8-risk');
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
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

function pgCode(err: unknown): string {
  assert.ok(err !== null && typeof err === 'object' && 'code' in err);
  return String((err as { code: unknown }).code);
}

describe('m8.2 risk engine migration 0017', () => {
  test('applies additively as the 17th migration', async () => {
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.equal(status.pending.length, 0);
    assert.equal(status.checksumsMatch, true);
    assert.equal(status.expectedCount, 17);
    assert.equal(status.appliedCount, 17);
    assert.equal(status.latestApplied, '0017_risk_engine.sql');
    const second = await runMigrations(pool, MIGRATIONS_DIR);
    assert.equal(second.applied.length, 0);
  });

  test('seeded instrument risk specs cover the platform universe', async () => {
    const res = await pool.query<{ symbol: string }>(
      `SELECT i.symbol FROM instrument_risk_specs s JOIN instruments i ON i.id = s.instrument_id ORDER BY i.symbol`,
    );
    const symbols = res.rows.map((r) => r.symbol);
    for (const s of ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD', 'ETHUSD', 'AAPL', 'SPY']) {
      assert.ok(symbols.includes(s), `missing spec for ${s}`);
    }
  });

  test('platform ceilings are enforced by CHECKs', async () => {
    const users = new UserService(pool);
    const user = await users.create({
      email: `m82_${randomBytes(4).toString('hex')}@example.com`,
      passwordHash: await hashPassword('correct-horse-42'),
      name: 'M82',
    });
    await pool.query(
      `INSERT INTO risk_policies (
         user_id, risk_pct_per_trade, max_monetary_risk_per_trade, max_daily_loss_pct, max_weekly_loss_pct,
         max_consecutive_losses, max_simultaneous_positions, max_total_open_risk_pct,
         max_exposure_per_instrument_pct, max_exposure_per_direction_pct, min_rr,
         correlation_required, max_correlation_group_exposure_pct, paper_equity
       ) VALUES ($1, 0.5, 500, 3, 6, 3, 3, 3, 1, 2, 2, false, 2, 10000)`,
      [user.id],
    );
    await assert.rejects(
      pool.query('UPDATE risk_policies SET risk_pct_per_trade = 50 WHERE user_id = $1', [user.id]),
      (err: unknown) => pgCode(err) === '23514',
    );
    await assert.rejects(
      pool.query('UPDATE risk_policies SET min_rr = 1 WHERE user_id = $1', [user.id]),
      (err: unknown) => pgCode(err) === '23514',
    );
    await assert.rejects(
      pool.query('UPDATE risk_policies SET max_simultaneous_positions = 50 WHERE user_id = $1', [user.id]),
      (err: unknown) => pgCode(err) === '23514',
    );
    await assert.rejects(
      pool.query('UPDATE risk_policies SET paper_equity = 1 WHERE user_id = $1', [user.id]),
      (err: unknown) => pgCode(err) === '23514',
    );
  });

  test('risk_reservations carry a crash-recovery expiry', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'risk_reservations'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    assert.ok(names.includes('expires_at'));
    assert.ok(!names.some((c) => /password|secret|api_key|token/i.test(c)));
  });

  test('0016 execution tables are untouched (live still impossible)', async () => {
    const users = new UserService(pool);
    const user = await users.create({
      email: `m82b_${randomBytes(4).toString('hex')}@example.com`,
      passwordHash: await hashPassword('correct-horse-42'),
      name: 'M82b',
    });
    await assert.rejects(
      pool.query(
        `INSERT INTO execution_profiles (user_id, mode, environment, provider_slug)
         VALUES ($1, 'live', 'live', 'paper')`,
        [user.id],
      ),
      (err: unknown) => pgCode(err) === '23514',
    );
  });
});
