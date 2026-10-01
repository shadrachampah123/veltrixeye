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
  type Timeframe,
  type NormalizedInstrument,
  type RealtimeSubscription,
  type RealtimeCandleStream,
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
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5444;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_scheduled_ingestion';

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
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);

  providerRegistry = createProviderRegistry();
  mockProvider = new MockProvider();
  providerRegistry.register(mockProvider);
  candleStore = new CandleStore(pool);
  ingestion = new IngestionService(pool, providerRegistry, candleStore);
  scheduled = new ScheduledIngestionService(pool, ingestion, {
    lookbackCandles: 100,
  });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

describe('ScheduledIngestionService', () => {
  test('warmCache processes the seeded instrument universe', async () => {
    const result = await scheduled.warmCache({
      timeframes: ['1h', '4h'],
      nowMs: Date.now(),
    });

    // Migration 0002 seeds 9 instruments
    assert.ok(result.instrumentsProcessed > 0);
    assert.equal(result.timeframesProcessed, result.instrumentsProcessed * 2);
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
    // Create a scheduled ingestion with a registry that has no provider
    const emptyRegistry = createProviderRegistry();
    const emptyIngestion = new IngestionService(pool, emptyRegistry, candleStore);
    const emptyScheduled = new ScheduledIngestionService(pool, emptyIngestion, {
      lookbackCandles: 100,
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
    });

    const result = await smallScheduled.warmCache({
      timeframes: ['1h'],
      nowMs: Date.now(),
    });

    assert.ok(result.instrumentsProcessed > 0);
    assert.ok(result.candlesUpserted > 0);
  });
});
