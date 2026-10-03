import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  type Candle,
  type MarketDataProvider,
  type ProviderFailureKind,
  type Timeframe,
  type NormalizedInstrument,
  type RealtimeSubscription,
  type RealtimeCandleStream,
  ProviderError,
  TIMEFRAMES,
} from '@veltrixeye/contracts';
import {
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  createProviderRegistry,
  CandleStore,
  IngestionService,
  ScheduledIngestionService,
  isRateLimitedError,
  Errors,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5547;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_scheduled_ingestion';

let databaseUrl: string;
let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let candleStore: CandleStore;
let ingestion: IngestionService;
let scheduled: ScheduledIngestionService;
let providerRegistry: ReturnType<typeof createProviderRegistry>;

class MockProvider implements MarketDataProvider {
  readonly id = 'twelve-data';
  readonly name = 'Twelve Data (Mock)';
  readonly capabilities = {
    historical: true,
    realtime: false,
    timeframes: TIMEFRAMES,
    maxLookbackDays: 2190,
  };
  public fetchCount = 0;
  /** Optional barrier used to hold a provider request in concurrency tests. */
  public beforeFetch: (() => Promise<void>) | null = null;
  /** When set, every fetch fails with this provider failure kind (tests). */
  public failKind: ProviderFailureKind | null = null;

  async getSymbols() {
    return [];
  }

  async getHistoricalCandles(req: {
    instrument: { assetClass: string; symbol: string };
    timeframe: Timeframe;
    from: number;
    to: number;
  }): Promise<Candle[]> {
    this.fetchCount++;
    await this.beforeFetch?.();
    if (this.failKind) throw new ProviderError(this.failKind, 'mock provider failure');
    const periodMs = getTimeframeMs(req.timeframe);
    const candles: Candle[] = [];
    const start = Math.ceil(req.from / periodMs) * periodMs;
    for (let t = start; t < req.to; t += periodMs) {
      candles.push({
        time: t,
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1000,
        state: 'closed',
      });
    }
    return candles;
  }

  subscribeRealtime(_sub: RealtimeSubscription): RealtimeCandleStream {
    throw new Error('realtime not supported in mock');
  }

  async getTradingSessions(): Promise<[]> {
    return [];
  }

  async getMarketStatus(inst: NormalizedInstrument) {
    return { instrument: inst, state: 'unknown' as const };
  }
}

function getTimeframeMs(tf: Timeframe): number {
  const map: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '8h': 28_800_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
    '3d': 259_200_000,
    '1w': 604_800_000,
    '1M': 2_592_000_000,
  };
  return map[tf] ?? 60_000;
}

let mockProvider: MockProvider;

/**
 * Seed a throwaway user + strategy + version + instrument scope.
 *
 * Scope rows must be written while the version is still `draft`: migration
 * 0007's guard rejects configuration writes once a version is published.
 */
async function seedScopedStrategy(args: {
  name: string;
  strategyStatus: 'active' | 'paused';
  versionStatus: 'draft' | 'published';
  symbols: [string, string][];
}): Promise<void> {
  const email = `${args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@fixture.test`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, 'Scheduled Ingestion Fixture') RETURNING id`,
    [email, 'x'.repeat(32)],
  );
  const userId = user.rows[0]!.id;
  const strategy = await pool.query<{ id: string }>(
    `INSERT INTO strategies (user_id, name, status) VALUES ($1, $2, $3) RETURNING id`,
    [userId, args.name, args.strategyStatus],
  );
  const version = await pool.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by)
     VALUES ($1, 1, 'draft', $2) RETURNING id`,
    [strategy.rows[0]!.id, userId],
  );
  const versionId = version.rows[0]!.id;
  await pool.query(`INSERT INTO strategy_market_scopes (version_id, mode) VALUES ($1, 'instruments')`, [
    versionId,
  ]);
  for (const [assetClass, symbol] of args.symbols) {
    await pool.query(
      `INSERT INTO strategy_market_scope_instruments (version_id, instrument_id)
       SELECT $1, id FROM instruments WHERE asset_class = $2 AND symbol = $3`,
      [versionId, assetClass, symbol],
    );
  }
  if (args.versionStatus === 'published') {
    await pool.query(
      `UPDATE strategy_versions SET status = 'published', published_at = now() WHERE id = $1`,
      [versionId],
    );
  }
}

async function countScheduledRuns(): Promise<number> {
  const result = await pool.query<{ cnt: number }>(
    `SELECT count(*)::int AS cnt FROM ingestion_runs WHERE trigger = 'scheduled'`,
  );
  return result.rows[0]?.cnt ?? 0;
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-scheduled-ingestion');
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
  await runMigrations(pool, MIGRATIONS_DIR);

  providerRegistry = createProviderRegistry();
  mockProvider = new MockProvider();
  providerRegistry.register(mockProvider);
  candleStore = new CandleStore(pool);
  ingestion = new IngestionService(pool, providerRegistry, candleStore);

  // The warm universe is derived from what the scanner can actually reach, so
  // seed the strategy scope: one in-scope active + published strategy, and two
  // decoys that must not widen it (a draft version, and a paused strategy).
  await seedScopedStrategy({
    name: 'Warm scope published',
    strategyStatus: 'active',
    versionStatus: 'published',
    symbols: [
      ['forex', 'EURUSD'],
      ['commodity', 'XAUUSD'],
    ],
  });
  await seedScopedStrategy({
    name: 'Warm scope draft version decoy',
    strategyStatus: 'active',
    versionStatus: 'draft',
    symbols: [['stock', 'AAPL']],
  });
  await seedScopedStrategy({
    name: 'Warm scope paused strategy decoy',
    strategyStatus: 'paused',
    versionStatus: 'published',
    symbols: [['etf', 'SPY']],
  });

  scheduled = new ScheduledIngestionService(pool, ingestion, {
    lookbackCandles: 100,
    minIntervalMs: 0,
  });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

describe('ScheduledIngestionService', () => {
  test('warmCache warms only instruments reachable by an active published strategy', async () => {
    const result = await scheduled.warmCache({
      timeframes: ['1h', '4h'],
      nowMs: Date.now(),
    });

    // Migration 0002 seeds 9 platform instruments, but only the two scoped to
    // the fixture's active + published strategy are warm targets: the draft
    // version (AAPL) and the paused strategy (SPY) must not contribute.
    assert.equal(result.instrumentsProcessed, 2);
    assert.equal(result.timeframesProcessed, 4);
    assert.equal(result.pairsFailed, 0);
    assert.ok(result.candlesUpserted > 0);
    assert.ok(typeof result.startedAt === 'string');
    assert.ok(typeof result.finishedAt === 'string');
  });

  test('warmCache fetches from provider for missing data', async () => {
    const initialFetchCount = mockProvider.fetchCount;

    const result = await scheduled.warmCache({
      timeframes: ['5m'],
      nowMs: Date.now(),
    });

    // Provider should have been called for the new timeframe
    assert.ok(mockProvider.fetchCount > initialFetchCount);
    assert.ok(result.pairsCompleted > 0);
  });

  test('warmCache second call reports cached results (no provider fetch)', async () => {
    // First call fetches from provider
    const result1 = await scheduled.warmCache({
      timeframes: ['4h'],
      nowMs: Date.now(),
    });
    assert.ok(result1.pairsCompleted > 0);

    // Reset fetch count to track only the second call
    const fetchCountBeforeSecond = mockProvider.fetchCount;

    // Second call with same timeframe: data should be in store (cache hit)
    const result2 = await scheduled.warmCache({
      timeframes: ['4h'],
      nowMs: Date.now(),
    });

    // The second call should report pairs as already cached
    assert.ok(result2.pairsAlreadyCached > 0);
    // Provider should NOT have been called again for the same ranges
    assert.equal(mockProvider.fetchCount, fetchCountBeforeSecond);
  });

  test('warmCache records ingestion_runs with trigger=scheduled', async () => {
    const beforeRes = await pool.query('SELECT count(*)::int as cnt FROM ingestion_runs WHERE trigger = $1', ['scheduled']);
    const beforeCount = beforeRes.rows[0]?.cnt ?? 0;

    await scheduled.warmCache({
      timeframes: ['1h'],
      nowMs: Date.now(),
    });

    const afterRes = await pool.query('SELECT count(*)::int as cnt FROM ingestion_runs WHERE trigger = $1', ['scheduled']);
    const afterCount = afterRes.rows[0]?.cnt ?? 0;

    assert.equal(afterCount, beforeCount + 1);
  });

  test('warmCache handles missing provider gracefully (never throws)', async () => {
    await pool.query('DELETE FROM candles');

    // Create a scheduled ingestion with a registry that has no provider
    const emptyRegistry = createProviderRegistry();
    const emptyIngestion = new IngestionService(pool, emptyRegistry, candleStore);
    const emptyScheduled = new ScheduledIngestionService(pool, emptyIngestion, {
      lookbackCandles: 100,
      minIntervalMs: 0,
    });

    // Should not throw — just reports failures
    const result = await emptyScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: Date.now(),
    });

    assert.equal(result.pairsCompleted, 0);
    assert.ok(result.pairsFailed > 0);
    assert.equal(result.candlesUpserted, 0);
  });

  test('warmCache respects lookbackCandles bound', async () => {
    const smallScheduled = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      minIntervalMs: 0,
    });

    const result = await smallScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: Date.now(),
    });

    assert.ok(result.instrumentsProcessed > 0);
    assert.ok(result.candlesUpserted > 0);
  });

  test('warmCache stops at the configured provider-request budget', async () => {
    await pool.query('DELETE FROM candles');
    const budgeted = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      maxRequestsPerCycle: 2,
      minIntervalMs: 0,
    });
    const fetchCountBefore = mockProvider.fetchCount;

    const result = await budgeted.warmCache({
      timeframes: ['1h', '4h'],
      nowMs: Date.now(),
    });

    assert.equal(result.providerRequests, 2);
    assert.equal(mockProvider.fetchCount, fetchCountBefore + 2);
    assert.equal(result.abortedDueToRateLimit, true);
  });

  test('warmCache counts both provider ranges needed by one pair', async () => {
    await pool.query('DELETE FROM candles');
    const nowMs = Date.now();
    const timeframe: Timeframe = '1h';
    const periodMs = getTimeframeMs(timeframe);
    const lookbackCandles = 10;
    const from = nowMs - lookbackCandles * periodMs;
    const middleBarTime = from + 5 * periodMs;

    // A stored middle bar leaves both the head and tail missing for either
    // target pair, so the first pair requires two provider requests.
    for (const [assetClass, symbol] of [
      ['commodity', 'XAUUSD'],
      ['forex', 'EURUSD'],
    ] as const) {
      const instrument = await candleStore.resolveInstrument(assetClass, symbol);
      assert.ok(instrument);
      await candleStore.upsertCandles({
        instrumentId: instrument.id,
        timeframe,
        providerSlug: 'test-seed',
        candles: [{
          time: middleBarTime,
          open: 100,
          high: 105,
          low: 95,
          close: 102,
          volume: 1000,
        }],
      });
    }

    const budgeted = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles,
      maxRequestsPerCycle: 2,
      minIntervalMs: 0,
    });
    const fetchCountBefore = mockProvider.fetchCount;

    const result = await budgeted.warmCache({ timeframes: [timeframe], nowMs });

    assert.equal(result.providerRequests, 2);
    assert.equal(mockProvider.fetchCount, fetchCountBefore + 2);
    assert.equal(result.abortedDueToRateLimit, true);
  });

  test('cached pairs consume no provider-request budget', async () => {
    await pool.query('DELETE FROM candles');
    const nowMs = Date.now();
    const warmScheduled = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      maxRequestsPerCycle: 8,
      minIntervalMs: 0,
    });
    const warmed = await warmScheduled.warmCache({ timeframes: ['1h'], nowMs });
    assert.equal(warmed.providerRequests, 2);

    const fetchCountBefore = mockProvider.fetchCount;
    const cacheOnlyScheduled = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      maxRequestsPerCycle: 0,
      minIntervalMs: 0,
    });
    const cached = await cacheOnlyScheduled.warmCache({ timeframes: ['1h'], nowMs });

    assert.equal(cached.pairsAlreadyCached, 2);
    assert.equal(cached.providerRequests, 0);
    assert.equal(mockProvider.fetchCount, fetchCountBefore);
    assert.equal(cached.abortedDueToRateLimit, false);
  });

  test('warmCache returns and persists providerRequests', async () => {
    await pool.query('DELETE FROM candles');
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const budgeted = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      maxRequestsPerCycle: 1,
      minIntervalMs: 0,
    });

    const result = await budgeted.warmCache({ timeframes: ['1h'], nowMs: Date.now() });

    assert.equal(result.providerRequests, 1);
    const runRes = await pool.query<{ request: Record<string, unknown> }>(
      `SELECT request FROM ingestion_runs WHERE trigger = 'scheduled'`,
    );
    assert.equal(runRes.rowCount, 1);
    assert.equal(runRes.rows[0]?.request?.providerRequests, 1);
  });

  test('warmCache stops the cycle when a pair is rate limited', async () => {
    // Start from a cold cache so the very first pair has to hit the provider.
    await pool.query('DELETE FROM candles');
    mockProvider.failKind = 'rate_limited';
    const fetchCountBefore = mockProvider.fetchCount;

    try {
      const result = await scheduled.warmCache({
        timeframes: ['1h', '4h'],
        nowMs: Date.now(),
      });

      // 2 instruments x 2 timeframes were candidates, but the rate limit must
      // abort after the first failed pair instead of walking into it 3 more
      // times (burning provider credits for the same answer).
      assert.equal(result.abortedDueToRateLimit, true);
      assert.equal(result.pairsFailed, 1);
      assert.equal(result.pairsCompleted, 0);
      assert.equal(result.candlesUpserted, 0);
      assert.equal(mockProvider.fetchCount, fetchCountBefore + 1);
    } finally {
      mockProvider.failKind = null;
    }
  });

  test('warmCache records the rate-limit abort on the ingestion run', async () => {
    await pool.query('DELETE FROM candles');
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    mockProvider.failKind = 'rate_limited';

    try {
      await scheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
    } finally {
      mockProvider.failKind = null;
    }

    // The abort must be visible to operators, not just to the caller: the run
    // row carries the flag in its request payload and says so in `error`.
    const runRes = await pool.query<{ request: Record<string, unknown>; error: string | null }>(
      `SELECT request, error FROM ingestion_runs WHERE trigger = 'scheduled'`,
    );
    assert.equal(runRes.rowCount, 1);
    assert.equal(runRes.rows[0]?.request?.abortedDueToRateLimit, true);
    assert.match(runRes.rows[0]?.error ?? '', /rate limited/);
  });

  test('warmCache keeps going past non-rate-limit pair failures', async () => {
    await pool.query('DELETE FROM candles');
    // 'unavailable' is an ordinary per-pair failure — the whole universe must
    // still be attempted, exactly as before the rate-limit guard existed.
    mockProvider.failKind = 'unavailable';
    const fetchCountBefore = mockProvider.fetchCount;

    try {
      const result = await scheduled.warmCache({
        timeframes: ['1h', '4h'],
        nowMs: Date.now(),
      });

      assert.equal(result.abortedDueToRateLimit, false);
      assert.equal(result.pairsCompleted, 0);
      assert.equal(result.pairsFailed, 4);
      assert.equal(mockProvider.fetchCount, fetchCountBefore + 4);
    } finally {
      mockProvider.failKind = null;
    }
  });

  test('warmCache recovers after a rate-limited cycle', async () => {
    await pool.query('DELETE FROM candles');
    mockProvider.failKind = 'rate_limited';
    try {
      const aborted = await scheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
      assert.equal(aborted.abortedDueToRateLimit, true);
    } finally {
      mockProvider.failKind = null;
    }

    // The guard is per-cycle: a later cycle with the provider healthy warms
    // normally and reports no abort.
    const result = await scheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
    assert.equal(result.abortedDueToRateLimit, false);
    assert.equal(result.pairsFailed, 0);
    assert.ok(result.candlesUpserted > 0);
  });

  test('warmCache runs the first cycle when no scheduled attempt exists', async () => {
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const firstCycleScheduled = new ScheduledIngestionService(pool, ingestion, { lookbackCandles: 10 });

    const result = await firstCycleScheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });

    assert.equal(result.skippedDueToMinInterval, false);
    assert.equal(await countScheduledRuns(), 1);
  });

  test('warmCache skips a second cycle before the default 15-minute interval', async () => {
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const intervalScheduled = new ScheduledIngestionService(pool, ingestion, { lookbackCandles: 10 });
    const first = await intervalScheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
    const lastAttemptAtMs = await intervalScheduled.lastScheduledRunAttemptAtMs();
    assert.ok(lastAttemptAtMs !== null);

    const second = await intervalScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: lastAttemptAtMs + 900_000 - 1,
    });

    assert.equal(second.skippedDueToMinInterval, true);
    assert.equal(second.providerRequests, 0);
    assert.equal(first.skippedDueToMinInterval, false);
  });

  test('a minimum-interval skip does not create an ingestion run', async () => {
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const intervalScheduled = new ScheduledIngestionService(pool, ingestion, { lookbackCandles: 10 });
    const first = await intervalScheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
    const lastAttemptAtMs = await intervalScheduled.lastScheduledRunAttemptAtMs();
    assert.ok(lastAttemptAtMs !== null);
    const runCountBefore = await countScheduledRuns();

    const skipped = await intervalScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: lastAttemptAtMs + 1,
    });

    assert.equal(skipped.skippedDueToMinInterval, true);
    assert.equal(await countScheduledRuns(), runCountBefore);
    assert.equal(first.skippedDueToMinInterval, false);
  });

  test('warmCache runs again once the default 15-minute interval has elapsed', async () => {
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const intervalScheduled = new ScheduledIngestionService(pool, ingestion, { lookbackCandles: 10 });
    const first = await intervalScheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
    const lastAttemptAtMs = await intervalScheduled.lastScheduledRunAttemptAtMs();
    assert.ok(lastAttemptAtMs !== null);

    const second = await intervalScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: lastAttemptAtMs + 900_000,
    });

    assert.equal(second.skippedDueToMinInterval, false);
    assert.equal(await countScheduledRuns(), 2);
    assert.equal(first.skippedDueToMinInterval, false);
  });

  test('minimum-interval state persists in ingestion_runs across service instances', async () => {
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const firstService = new ScheduledIngestionService(pool, ingestion, { lookbackCandles: 10 });
    const first = await firstService.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
    const expectedFinishedAtMs = Date.parse(first.finishedAt);

    const secondService = new ScheduledIngestionService(pool, ingestion, { lookbackCandles: 10 });
    assert.equal(await secondService.lastScheduledRunAttemptAtMs(), expectedFinishedAtMs);
    const second = await secondService.warmCache({
      timeframes: ['1h'],
      nowMs: expectedFinishedAtMs + 1,
    });

    assert.equal(second.skippedDueToMinInterval, true);
    assert.equal(await countScheduledRuns(), 1);
  });

  test('a fully failed warm cycle starts the minimum-interval cooldown', async () => {
    await pool.query('DELETE FROM candles');
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const cooldownScheduled = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      minIntervalMs: 900_000,
    });

    // Every pair fails: the run is terminal, but not 'completed'. Before the
    // cooldown read widened to attempts, such a row was invisible and the next
    // scanner tick walked straight back into the same broken provider state.
    mockProvider.failKind = 'unavailable';
    const failed = await cooldownScheduled
      .warmCache({ timeframes: ['1h', '4h'], nowMs: Date.now() })
      .finally(() => {
        mockProvider.failKind = null;
      });

    assert.equal(failed.skippedDueToMinInterval, false);
    assert.equal(failed.pairsCompleted, 0);
    assert.equal(failed.pairsFailed, 4);
    const runRes = await pool.query<{ status: string }>(
      `SELECT status FROM ingestion_runs WHERE trigger = 'scheduled'`,
    );
    assert.equal(runRes.rows[0]?.status, 'failed');

    const lastAttemptAtMs = await cooldownScheduled.lastScheduledRunAttemptAtMs();
    assert.ok(lastAttemptAtMs !== null);

    const fetchCountBefore = mockProvider.fetchCount;
    const retry = await cooldownScheduled.warmCache({
      timeframes: ['1h', '4h'],
      nowMs: lastAttemptAtMs + 900_000 - 1,
    });

    assert.equal(retry.skippedDueToMinInterval, true);
    assert.equal(retry.providerRequests, 0);
    assert.equal(mockProvider.fetchCount, fetchCountBefore);
    assert.equal(await countScheduledRuns(), 1);
  });

  test('a partial warm cycle starts the minimum-interval cooldown and holds its boundary', async () => {
    await pool.query('DELETE FROM candles');
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const cooldownScheduled = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      maxRequestsPerCycle: 2,
      minIntervalMs: 900_000,
    });

    // Two pairs warm, then the third runs into the provider-request budget:
    // the cycle is recorded 'partial', not 'completed'.
    const partial = await cooldownScheduled.warmCache({ timeframes: ['1h', '4h'], nowMs: Date.now() });
    assert.equal(partial.abortedDueToRateLimit, true);
    assert.ok(partial.pairsCompleted > 0);
    assert.ok(partial.pairsFailed > 0);
    const runRes = await pool.query<{ status: string }>(
      `SELECT status FROM ingestion_runs WHERE trigger = 'scheduled'`,
    );
    assert.equal(runRes.rows[0]?.status, 'partial');

    const lastAttemptAtMs = await cooldownScheduled.lastScheduledRunAttemptAtMs();
    assert.ok(lastAttemptAtMs !== null);

    // One millisecond short of the interval: still inside the cooldown.
    const tooEarly = await cooldownScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: lastAttemptAtMs + 900_000 - 1,
    });
    assert.equal(tooEarly.skippedDueToMinInterval, true);
    assert.equal(tooEarly.providerRequests, 0);

    // Exactly at the interval: the cooldown has elapsed and the cycle runs.
    const onTime = await cooldownScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: lastAttemptAtMs + 900_000,
    });
    assert.equal(onTime.skippedDueToMinInterval, false);
    assert.ok(onTime.instrumentsProcessed > 0);
    assert.equal(await countScheduledRuns(), 2);
  });

  test('an unfinished scheduled attempt pins the cooldown from its start time', async () => {
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const attemptStartedAtMs = Date.now() - 60_000;
    await pool.query(
      `INSERT INTO ingestion_runs (trigger, status, provider_slug, request, started_at)
       VALUES ('scheduled', 'running', 'scheduled', '{}', $1::timestamptz)`,
      [new Date(attemptStartedAtMs).toISOString()],
    );
    const cooldownScheduled = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      minIntervalMs: 900_000,
    });

    // A 'running' row left behind by a killed process has no finished_at; the
    // attempt still counts (from its start) so a crash cannot trigger an
    // immediate retry either.
    assert.equal(await cooldownScheduled.lastScheduledRunAttemptAtMs(), attemptStartedAtMs);
    const tooEarly = await cooldownScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: attemptStartedAtMs + 900_000 - 1,
    });
    assert.equal(tooEarly.skippedDueToMinInterval, true);
    assert.equal(tooEarly.providerRequests, 0);
  });

  test('the cooldown follows the newest attempt even when an older completed run exists', async () => {
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const minIntervalMs = 900_000;
    const completedAtMs = Date.now() - 4 * minIntervalMs;
    const failedAtMs = completedAtMs + 2 * minIntervalMs;
    await pool.query(
      `INSERT INTO ingestion_runs (trigger, status, provider_slug, request, started_at, finished_at)
       VALUES ('scheduled', 'completed', 'scheduled', '{}', $1::timestamptz, $1::timestamptz),
              ('scheduled', 'failed', 'scheduled', '{}', $2::timestamptz, $2::timestamptz)`,
      [new Date(completedAtMs).toISOString(), new Date(failedAtMs).toISOString()],
    );
    const cooldownScheduled = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      minIntervalMs,
    });

    assert.equal(await cooldownScheduled.lastScheduledRunAttemptAtMs(), failedAtMs);

    // The completed run's own 15-minute window elapsed long ago — if the
    // cooldown still keyed off completed runs only, this would start a cycle.
    const tooEarly = await cooldownScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: failedAtMs - 1,
    });
    assert.equal(tooEarly.skippedDueToMinInterval, true);
    assert.equal(tooEarly.providerRequests, 0);

    // Once the newest attempt's own window has elapsed, the cycle runs again.
    const onTime = await cooldownScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: failedAtMs + minIntervalMs,
    });
    assert.equal(onTime.skippedDueToMinInterval, false);
    assert.ok(onTime.instrumentsProcessed > 0);
  });

  test('concurrent warmCache calls are serialized by a database advisory lock', async () => {
    await pool.query('DELETE FROM candles');
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const firstService = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      maxRequestsPerCycle: 8,
      minIntervalMs: 0,
    });
    const secondService = new ScheduledIngestionService(pool, ingestion, {
      lookbackCandles: 10,
      maxRequestsPerCycle: 8,
      minIntervalMs: 0,
    });

    let signalFirstFetchStarted!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      signalFirstFetchStarted = resolve;
    });
    let releaseFirstFetch!: () => void;
    const holdFirstFetch = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let firstFetchIsBlocked = false;
    mockProvider.beforeFetch = async () => {
      if (!firstFetchIsBlocked) {
        firstFetchIsBlocked = true;
        signalFirstFetchStarted();
        await holdFirstFetch;
      }
    };

    const fetchCountBefore = mockProvider.fetchCount;
    let firstCycle: Promise<Awaited<ReturnType<typeof firstService.warmCache>>> | undefined;
    try {
      firstCycle = firstService.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
      await firstFetchStarted;

      const overlapping = await secondService.warmCache({ timeframes: ['1h'], nowMs: Date.now() });
      assert.equal(overlapping.providerRequests, 0);
      assert.equal(overlapping.skippedDueToMinInterval, false);
      assert.equal(mockProvider.fetchCount, fetchCountBefore + 1);
      assert.equal(await countScheduledRuns(), 0);

      releaseFirstFetch();
      const first = await firstCycle;
      assert.equal(first.providerRequests, 2);
      assert.equal(mockProvider.fetchCount, fetchCountBefore + 2);
      assert.equal(await countScheduledRuns(), 1);
    } finally {
      releaseFirstFetch();
      mockProvider.beforeFetch = null;
      await firstCycle?.catch(() => {});
    }
  });

  test('warmCache completes with a pool size of one', { timeout: 30_000 }, async () => {
    await pool.query('DELETE FROM candles');
    await pool.query(`DELETE FROM ingestion_runs WHERE trigger = 'scheduled'`);
    const singleConnectionPool = createPool({ databaseUrl, max: 1 });
    try {
      const singleConnectionStore = new CandleStore(singleConnectionPool);
      const singleConnectionIngestion = new IngestionService(
        singleConnectionPool,
        providerRegistry,
        singleConnectionStore,
      );
      const singleConnectionScheduled = new ScheduledIngestionService(
        singleConnectionPool,
        singleConnectionIngestion,
        { lookbackCandles: 10, minIntervalMs: 0 },
      );

      const result = await singleConnectionScheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });

      assert.equal(result.instrumentsProcessed, 2);
      assert.equal(result.pairsFailed, 0);
      assert.equal(result.providerRequests, 2);
      assert.equal(await countScheduledRuns(), 1);
    } finally {
      await singleConnectionPool.end();
    }
  });

  test('warmCache fails closed when it cannot read previous-run state', async () => {
    let queryCount = 0;
    const failingPool = {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
          if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
          queryCount++;
          throw new Error('database unavailable');
        },
        release: () => {},
      }),
      query: async () => {
        throw new Error('unexpected pool query');
      },
    } as unknown as typeof pool;
    const failClosedScheduled = new ScheduledIngestionService(failingPool, ingestion, {
      lookbackCandles: 10,
    });

    const result = await failClosedScheduled.warmCache({ timeframes: ['1h'], nowMs: Date.now() });

    assert.equal(result.skippedDueToMinInterval, true);
    assert.equal(result.providerRequests, 0);
    assert.equal(queryCount, 1);
  });
});

describe('isRateLimitedError', () => {
  test('recognises only rate-limit failures', () => {
    // Ingestion maps provider failures to domain errors — the shape a warm
    // cycle actually sees.
    assert.equal(isRateLimitedError(Errors.rateLimited('slow down')), true);
    assert.equal(isRateLimitedError(new ProviderError('rate_limited', 'slow down')), true);
    assert.equal(isRateLimitedError(Object.assign(new Error('429'), { statusCode: 429 })), true);

    assert.equal(isRateLimitedError(new ProviderError('unavailable', 'down')), false);
    assert.equal(isRateLimitedError(new ProviderError('not_found', 'nope')), false);
    assert.equal(isRateLimitedError(new ProviderError('invalid_request', 'bad range')), false);
    assert.equal(isRateLimitedError(Errors.providerUnavailable('down')), false);
    assert.equal(isRateLimitedError(Errors.notFound('unknown instrument')), false);
    assert.equal(isRateLimitedError(new Error('socket hang up')), false);
    assert.equal(isRateLimitedError(undefined), false);
  });
});
