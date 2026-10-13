/**
 * F9 — backtest monthly-limit race for Model C free users.
 *
 * `SELECT … FROM subscriptions WHERE user_id = $1 FOR UPDATE` does not lock
 * anything when no subscription row exists (the normal free state). Two
 * distinct concurrent createBacktest calls can both observe 99 runs and
 * insert a 101st, exceeding the free monthly cap of 100.
 *
 * This suite drives real concurrent service calls against embedded Postgres.
 * It tests the quota race between DISTINCT requests, not identical-request
 * idempotency (`ON CONFLICT DO NOTHING` on the run identity).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  AuditService,
  BacktestService,
  CandleStore,
  MIGRATIONS_DIR,
  StrategyService,
  UserService,
  createPool,
  hashPassword,
  isDomainError,
  runMigrations,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5592;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_backtest_limit_race';

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `bt_race_${randomBytes(6).toString('hex')}@example.com`;

const HOUR = 3_600_000;
/** Historical grid well before any test wall clock. */
const T0 = 1_700_000_000_000;
const FREE_MONTHLY_CAP = 100;
const CONCURRENT_DISTINCT = 6;

const ALWAYS_PASS = {
  timeframes: { htf_bias: '1h' as const, setup: '1h' as const, entry: '1h' as const },
  marketScope: { mode: 'all' as const },
  risk: {
    minRr: 2,
    stopLossMethod: 'fixed' as const,
    stopLossBuffer: 10,
    stopLossBufferUnit: 'pips' as const,
    takeProfitMethod: 'rr' as const,
    tp1Rr: 1,
    tp2Rr: 2,
    tp3Rr: 3,
    minQualityScore: 65,
  },
  ruleGroups: [
    {
      name: 'Pass',
      logic: 'AND' as const,
      position: 0,
      conditions: [
        {
          conditionType: 'volatility_filter',
          classification: 'required' as const,
          timeframeRole: 'setup' as const,
          params: { metric: 'body_range', period: 2, min: 0 },
          position: 0,
        },
      ],
    },
  ],
};

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let strategies: StrategyService;
let candles: CandleStore;
let backtests: BacktestService;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-backtest-limit-race');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl, max: 12 });
  await runMigrations(pool, MIGRATIONS_DIR);
  users = new UserService(pool);
  strategies = new StrategyService(pool, new AuditService(pool));
  candles = new CandleStore(pool);
  backtests = new BacktestService(pool, strategies, candles);
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

async function subscriptionCount(userId: string): Promise<number> {
  const res = await pool.query<{ c: number }>(
    'SELECT count(*)::int AS c FROM subscriptions WHERE user_id = $1',
    [userId],
  );
  return res.rows[0]!.c;
}

async function seedPublishedOwner(): Promise<{
  userId: string;
  strategyId: string;
  versionId: string;
  instrumentId: string;
}> {
  const user = await users.create({
    email: uniqueEmail(),
    passwordHash: await hashPassword(PASSWORD),
    name: 'Free Racer',
  });
  assert.equal(await subscriptionCount(user.id), 0, 'Model C free state has no subscription row');

  const detail = await strategies.createStrategy(user.id, {
    name: `Race ${randomBytes(4).toString('hex')}`,
    version: ALWAYS_PASS,
  });
  const draft = detail.versions[0];
  assert.ok(draft);
  const published = await strategies.publishVersion(user.id, detail.id, draft.id);

  const instrument = await candles.resolveInstrument('forex', 'EURUSD');
  assert.ok(instrument);

  const series = Array.from({ length: 24 }, (_, i) => ({
    time: T0 + i * HOUR,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: null,
  }));
  const upserted = await candles.upsertCandles({
    instrumentId: instrument.id,
    timeframe: '1h',
    providerSlug: 'test-fixture',
    candles: series,
  });
  assert.equal(upserted, series.length);

  return {
    userId: user.id,
    strategyId: detail.id,
    versionId: published.id,
    instrumentId: instrument.id,
  };
}

async function seedMonthRuns(args: {
  userId: string;
  strategyId: string;
  versionId: string;
  instrumentId: string;
  count: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO backtest_runs (
       user_id, strategy_id, strategy_version_id, instrument_id, direction,
       engine_version, from_ms, to_ms, exit_policy, cost_policy, config_hash, status
     )
     SELECT $1, $2, $3, $4, 'long', 'fixture-engine', 1000 + i, 2000 + i,
            '{}', '{}', md5('fixture' || i::text) || md5(i::text), 'completed'
     FROM generate_series(1, $5::int) AS i`,
    [args.userId, args.strategyId, args.versionId, args.instrumentId, args.count],
  );
}

function distinctArgs(
  owner: { userId: string; strategyId: string; versionId: string },
  index: number,
) {
  return {
    userId: owner.userId,
    strategyId: owner.strategyId,
    versionId: owner.versionId,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'both' as const,
    from: T0 + (2 + index) * HOUR,
    to: T0 + (10 + index) * HOUR,
  };
}

describe('F9: backtest monthly limit serializes for row-less free users', () => {
  test('distinct concurrent requests below the cap all persist', async () => {
    const owner = await seedPublishedOwner();
    const settled = await Promise.allSettled([
      backtests.createBacktest(distinctArgs(owner, 0)),
      backtests.createBacktest(distinctArgs(owner, 1)),
    ]);
    const created = settled.filter((r) => r.status === 'fulfilled');
    assert.equal(created.length, 2, `both distinct runs should persist: ${summarize(settled)}`);
    for (const r of created) {
      assert.equal(r.status === 'fulfilled' && r.value.created, true);
    }
    assert.equal(await backtests.countBacktestsThisMonth(owner.userId), 2);
    assert.equal(await subscriptionCount(owner.userId), 0);
  });

  test(
    'distinct concurrent requests at the free monthly boundary never exceed the cap',
    { timeout: 60_000 },
    async () => {
      const owner = await seedPublishedOwner();
      await seedMonthRuns({ ...owner, count: FREE_MONTHLY_CAP - 1 });
      assert.equal(await backtests.countBacktestsThisMonth(owner.userId), FREE_MONTHLY_CAP - 1);
      assert.equal(await subscriptionCount(owner.userId), 0, 'the race is the no-row free state');

      const settled = await Promise.allSettled(
        Array.from({ length: CONCURRENT_DISTINCT }, (_, i) =>
          backtests.createBacktest(distinctArgs(owner, i)),
        ),
      );

      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected');
      assert.equal(
        fulfilled.length,
        1,
        `exactly one distinct request may consume the last slot: ${summarize(settled)}`,
      );
      assert.equal(rejected.length, CONCURRENT_DISTINCT - 1, summarize(settled));
      const winner = fulfilled[0];
      assert.ok(winner && winner.status === 'fulfilled');
      assert.equal(winner.value.created, true);

      for (const r of rejected) {
        assert.equal(r.status, 'rejected');
        assert.equal(isDomainError(r.reason), true, `expected DomainError, got ${String(r.reason)}`);
        if (isDomainError(r.reason)) {
          assert.equal(r.reason.code, 'forbidden');
          assert.match(r.reason.message, /up to 100 backtests per month/);
        }
      }

      assert.equal(
        await backtests.countBacktestsThisMonth(owner.userId),
        FREE_MONTHLY_CAP,
        'the free monthly cap must not be exceeded under concurrent distinct requests',
      );
      assert.equal(await subscriptionCount(owner.userId), 0);
    },
  );
});

function summarize(settled: PromiseSettledResult<unknown>[]): string {
  return settled
    .map((r, i) => {
      if (r.status === 'fulfilled') return `#${i}=ok`;
      const reason = r.reason;
      if (isDomainError(reason)) return `#${i}=${reason.code}:${reason.message}`;
      return `#${i}=${reason instanceof Error ? reason.message : String(reason)}`;
    })
    .join('; ');
}
