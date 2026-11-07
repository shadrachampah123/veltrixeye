/**
 * Phase A — scanner candle-source observability.
 *
 * Proves the three observability counters added in Phase A without changing any
 * scanner behaviour:
 *   A1  candles served by the CandleStore fast path are counted as processed
 *   A2  store / provider / total are reported separately and never double-count
 *   A3  cursor de-duplication is counted, and still skips exactly as before
 *
 * The suite runs against its OWN embedded database, so a run's totals contain
 * exactly the instrument pairs this file created — no other scanner test can
 * contribute to (or be affected by) these assertions.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  ProviderError,
  TIMEFRAMES,
  type Candle,
  type MarketDataProvider,
  type NormalizedInstrument,
  type RealtimeCandleStream,
  type RealtimeSubscription,
  type Timeframe,
} from '@veltrixeye/contracts';
import {
  AlertService,
  AuditService,
  CandleStore,
  EvaluationService,
  IngestionService,
  MIGRATIONS_DIR,
  NotificationOutbox,
  ScannerService,
  ScoringService,
  type SetupService,
  StubAlertSender,
  StrategyService,
  UserService,
  checkFreshness,
  createPool,
  createProviderRegistry,
  hashPassword,
  runMigrations,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5483; // unique across the suite (5442 = notification-outbox, 5497 = billing-sync)
const DB_USER = 'test';
const DB_NAME = 'veltrixeye_test_scanner_phase_a';

const HOUR_MS = 60 * 60_000;
const MIN15_MS = 15 * 60_000;
const HOUR4_MS = 4 * 60 * 60_000;
const PERIOD_MS: Record<string, number> = { '4h': HOUR4_MS, '1h': HOUR_MS, '15m': MIN15_MS };
/** Candles seeded/returned per role timeframe: 4h / 1h / 15m. */
const ROLE_COUNTS: Record<string, number> = { '4h': 60, '1h': 120, '15m': 120 };
/** 60 + 120 + 120 — the batch size a single instrument pair loads. */
const PAIR_CANDLES = 300;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `phasea_${randomBytes(6).toString('hex')}@example.com`;

interface CandleStats {
  store: number;
  provider: number;
  total: number;
}

const candlesOf = (run: { metadata: Record<string, unknown> }): CandleStats => run.metadata.candles as CandleStats;
const skipsOf = (run: { metadata: Record<string, unknown> }): number => run.metadata.duplicateCandleSkips as number;

function makeCandle(time: number, open = 100, high = 105, low = 95, close = 102, volume: number | null = 1000): Candle {
  return { time, open, high, low, close, volume, state: 'closed' };
}

function makeCandles(count: number, startTime: number, periodMs: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const time = startTime + i * periodMs;
    candles.push(makeCandle(time, 100 + i * 0.1, 105 + i * 0.1, 95 + i * 0.1, 102 + i * 0.1, 1000));
  }
  return candles;
}

/** A pre-closed, fresh batch ending at the last closed bar before `nowMs`. */
function roleBatch(timeframe: Timeframe, nowMs: number): Candle[] {
  const periodMs = PERIOD_MS[timeframe]!;
  const count = ROLE_COUNTS[timeframe]!;
  const lastClosedOpen = Math.floor(nowMs / periodMs) * periodMs - periodMs;
  return makeCandles(count, lastClosedOpen - (count - 1) * periodMs, periodMs);
}

/** Provider that serves each requested timeframe with an aligned, fresh batch. */
class PhaseAProvider implements MarketDataProvider {
  readonly id = 'twelve-data';
  readonly name = 'Phase A Provider';
  readonly capabilities = { historical: true, realtime: false, timeframes: TIMEFRAMES, maxLookbackDays: 2190 };
  public calls: Timeframe[] = [];
  public failWith: ProviderError | null = null;

  async getSymbols() {
    return [];
  }

  async getHistoricalCandles(request: { timeframe: Timeframe; to: number }): Promise<Candle[]> {
    this.calls.push(request.timeframe);
    if (this.failWith) throw this.failWith;
    return roleBatch(request.timeframe, request.to);
  }

  subscribeRealtime(_sub: RealtimeSubscription): RealtimeCandleStream {
    return {
      [Symbol.asyncIterator]: async function* () {
        /* no realtime stream in tests */
      },
      close: async () => {},
    } as unknown as RealtimeCandleStream;
  }

  async getTradingSessions() {
    return [];
  }

  async getMarketStatus(instrument: NormalizedInstrument) {
    return { instrument, state: 'open' as const };
  }
}

let stopDb: (() => Promise<void>) | undefined;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let strategies: StrategyService;
let candleStore: CandleStore;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-phase-a');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: randomBytes(16).toString('hex'),
    database: DB_NAME,
  });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);

  users = new UserService(pool);
  strategies = new StrategyService(pool, new AuditService(pool));
  candleStore = new CandleStore(pool);
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

async function makePro(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'pro', 'active')
     ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan`,
    [userId],
  );
}

interface ScopedStrategy {
  userId: string;
  strategyId: string;
  versionId: string;
}

async function createScopedStrategy(
  assetClass: 'forex' | 'commodity' | 'crypto',
  symbol: string,
  userId?: string,
): Promise<ScopedStrategy> {
  let owner = userId;
  if (!owner) {
    const user = await users.create({ email: uniqueEmail(), passwordHash: await hashPassword(PASSWORD), name: 'Phase A' });
    await makePro(user.id);
    owner = user.id;
  }
  const created = await strategies.createStrategy(owner, {
    name: `Phase A ${symbol} ${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
    description: 'Phase A observability fixture',
    version: {
      timeframes: { htf_bias: '4h', setup: '1h', entry: '15m' },
      marketScope: { mode: 'instruments', instruments: [{ assetClass, symbol }] },
      sessionFilters: [],
      risk: {
        minRr: 2,
        stopLossMethod: 'structure',
        stopLossBuffer: 1,
        stopLossBufferUnit: 'pips',
        takeProfitMethod: 'rr',
        tp1Rr: 1,
        tp2Rr: 2,
        tp3Rr: 3,
        minQualityScore: 70,
      },
      filters: [],
      ruleGroups: [
        {
          name: 'Structure',
          logic: 'AND',
          position: 0,
          conditions: [
            {
              conditionType: 'htf_alignment',
              classification: 'required',
              timeframeRole: 'htf_bias',
              params: { direction: 'bullish' },
              position: 0,
            },
          ],
        },
      ],
    },
  });
  const versionId = created.versions[0]!.id;
  await strategies.publishVersion(owner, created.id, versionId);
  await strategies.updateStrategy(owner, created.id, { status: 'active' });
  return { userId: owner, strategyId: created.id, versionId };
}

/** Seed a complete, fresh, closed-only store batch per role timeframe, plus a forming tail. */
async function seedStore(instrumentId: string, nowMs: number): Promise<void> {
  for (const timeframe of ['4h', '1h', '15m'] as const) {
    const candles = roleBatch(timeframe, nowMs);
    assert.equal(
      checkFreshness({ candles, timeframe, nowMs }).fresh,
      true,
      `${timeframe} fixture must satisfy the production freshness threshold`,
    );
    await candleStore.upsertCandles({ instrumentId, timeframe, providerSlug: 'twelve-data', candles });
    const formingOpen = candles.at(-1)!.time + PERIOD_MS[timeframe]!;
    await candleStore.upsertCandles({
      instrumentId,
      timeframe,
      providerSlug: 'twelve-data',
      candles: [makeCandle(formingOpen)],
    });
  }
}

interface Harness {
  scanner: ScannerService;
  provider: PhaseAProvider;
  detectCalls: { versionId: string; asOf: number; direction: string }[];
  ingestionCalls: () => number;
  storeReads: () => number;
}

/** Build a scanner whose only stub is `setups.detect`; store, ingestion and scoring are real. */
function makeHarness(options: { providerFails?: boolean; maxRetries?: number } = {}): Harness {
  const provider = new PhaseAProvider();
  if (options.providerFails) provider.failWith = new ProviderError('rate_limited', 'phase a: provider rate limited');

  const registry = createProviderRegistry();
  registry.register(provider);

  const ingestion = new IngestionService(pool, registry, candleStore);
  let ingestionCalls = 0;
  const monitoredIngestion = {
    getCandles: async (request: Parameters<IngestionService['getCandles']>[0]) => {
      ingestionCalls += 1;
      return ingestion.getCandles(request);
    },
  } as unknown as IngestionService;

  let storeReads = 0;
  const monitoredStore = {
    queryCandles: async (query: Parameters<CandleStore['queryCandles']>[0]) => {
      storeReads += 1;
      return candleStore.queryCandles(query);
    },
  } as unknown as CandleStore;

  const evaluation = new EvaluationService(pool, strategies, candleStore);
  const detectCalls: { versionId: string; asOf: number; direction: string }[] = [];
  const stubSetups = {
    detect: async (args: { versionId: string; asOf: number; direction: 'long' | 'short' }) => {
      detectCalls.push({ versionId: args.versionId, asOf: args.asOf, direction: args.direction });
      return { detections: [{ direction: args.direction, qualified: false, setup: null, created: false }] };
    },
  } as unknown as SetupService;

  const scoring = new ScoringService(pool, strategies, evaluation);
  const alerts = new AlertService(pool, strategies, new StubAlertSender(), new NotificationOutbox(pool, { maxAttempts: 5 }));

  const scanner = new ScannerService(
    pool,
    registry,
    monitoredStore,
    monitoredIngestion,
    evaluation,
    stubSetups,
    scoring,
    alerts,
    {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      maxRetries: options.maxRetries ?? 0,
      providerTimeoutMs: 500,
    },
  );

  return {
    scanner,
    provider,
    detectCalls,
    ingestionCalls: () => ingestionCalls,
    storeReads: () => storeReads,
  };
}

describe('Phase A — candle source observability', () => {
  /** Wall clock 25 minutes past the hour: every role bar boundary is unambiguous. */
  const nowMs = () => Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 25 * 60_000;

  // Runs first: a global scan sees exactly the two strategies created here,
  // because this suite owns its database.
  test('A2: total === store + provider and the same candles are never counted twice', async () => {
    const now = nowMs();
    const instrument = await candleStore.resolveInstrument('crypto', 'ETHUSD');
    assert.ok(instrument);
    await seedStore(instrument.id, now);

    // Two strategies share one (instrument x timeframe) pair.
    const first = await createScopedStrategy('crypto', 'ETHUSD');
    await createScopedStrategy('crypto', 'ETHUSD', first.userId);

    const harness = makeHarness();
    const result = await harness.scanner.triggerScan({ force: true, initiatedBy: first.userId, nowMs: now });
    const run = result.run;

    assert.equal(run.status, 'completed');
    assert.equal(run.instrumentsScanned, 2, 'both strategies scan the pair');

    const stats = candlesOf(run);
    assert.equal(stats.total, stats.store + stats.provider, 'the total is exactly the sum of the sources');
    assert.equal(stats.total, run.candlesFetched, 'run.candles_fetched mirrors the total');
    assert.equal(stats.provider, 0);
    // The second pair is served by the per-cycle cache: the same 300 candles are
    // handed over twice, so the counters must stay at a single load.
    assert.equal(stats.store, PAIR_CANDLES, 'a cycle-cache hit must not re-count the same candles');
    assert.equal(harness.storeReads(), 3, 'three role reads for the loading pair; the cached pair reads nothing');
    assert.equal(harness.detectCalls.length, 4, 'both strategies still evaluate both directions');
  });

  test('A1/A2: a CandleStore fast-path load is counted as candles processed (not zero)', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('crypto', 'ETHUSD');
    const instrument = await candleStore.resolveInstrument('crypto', 'ETHUSD');
    assert.ok(instrument);
    await seedStore(instrument.id, now);

    const harness = makeHarness();
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const run = result.run;

    assert.equal(run.status, 'completed');
    assert.equal(run.instrumentsScanned, 1);
    assert.equal(run.staleRejections, 0, 'fresh store data must not be rejected as stale');
    assert.equal(run.providerFailures, 0);

    // The regression: before Phase A this was 0 even though 300 candles were used.
    assert.equal(run.candlesFetched, PAIR_CANDLES, 'candles_fetched must report store-served candles');
    assert.deepEqual(candlesOf(run), { store: PAIR_CANDLES, provider: 0, total: PAIR_CANDLES });

    assert.equal(harness.provider.calls.length, 0, 'the provider must not be called when the store is complete');
    assert.equal(harness.ingestionCalls(), 0, 'fetch-through must not run when the store is complete');
    assert.equal(harness.detectCalls.length, 2, 'both directions still evaluate the same real batch');
  });

  test('A2: a provider fetch is attributed to the provider counter (and still counted in the total)', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('crypto', 'BTCUSD');

    const harness = makeHarness();
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const run = result.run;

    assert.equal(run.status, 'completed');
    assert.equal(run.instrumentsScanned, 1);
    assert.deepEqual(harness.provider.calls, ['4h', '1h', '15m'], 'each role timeframe fetched exactly once');
    assert.deepEqual(candlesOf(run), { store: 0, provider: PAIR_CANDLES, total: PAIR_CANDLES });
    assert.equal(run.candlesFetched, PAIR_CANDLES, 'provider fetches keep their historical meaning');
    assert.equal(harness.detectCalls.length, 2);
  });

  test('A3: a duplicate-candle skip increments its own counter and changes nothing else', async () => {
    const now = nowMs();
    const { userId, strategyId, versionId } = await createScopedStrategy('crypto', 'ETHUSD');
    const instrument = await candleStore.resolveInstrument('crypto', 'ETHUSD');
    assert.ok(instrument);
    await seedStore(instrument.id, now);

    const harness = makeHarness();
    const first = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    assert.equal(skipsOf(first.run), 0, 'a fresh bar is never reported as a skip');
    const afterFirst = harness.detectCalls.length;
    const anchorsFirst = [...new Set(harness.detectCalls.map((c) => c.asOf))];

    const cursorAfterFirst = await pool.query<{ last_candle_time: string }>(
      `SELECT last_candle_time FROM scanner_cursors
        WHERE strategy_version_id = $1 AND instrument_id = $2 AND timeframe = '1h'`,
      [versionId, instrument.id],
    );

    // Same wall clock, same closed setup bar => the cursor must short-circuit.
    const second = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });

    assert.equal(skipsOf(second.run), 1, 'the skip is now observable');
    assert.equal(harness.detectCalls.length, afterFirst, 'the skip still prevents re-evaluation');
    assert.deepEqual([...new Set(harness.detectCalls.map((c) => c.asOf))], anchorsFirst, 'no new anchor was evaluated');

    // Legitimate behaviour is unchanged: candles are still loaded before the
    // cursor check, nothing is marked stale, and no failure is invented.
    assert.equal(second.run.status, 'completed');
    assert.equal(second.run.instrumentsScanned, 1);
    assert.equal(second.run.staleRejections, 0);
    assert.equal(second.run.providerFailures, 0);
    assert.deepEqual(second.run.metadata.errors, []);
    assert.deepEqual(candlesOf(second.run), { store: PAIR_CANDLES, provider: 0, total: PAIR_CANDLES });
    assert.equal(second.run.setupsDetected, 0);
    assert.equal(second.run.setupsCreated, 0);

    const cursorAfterSecond = await pool.query<{ last_candle_time: string }>(
      `SELECT last_candle_time FROM scanner_cursors
        WHERE strategy_version_id = $1 AND instrument_id = $2 AND timeframe = '1h'`,
      [versionId, instrument.id],
    );
    assert.equal(
      cursorAfterSecond.rows[0]?.last_candle_time,
      cursorAfterFirst.rows[0]?.last_candle_time,
      'cursor semantics are untouched by a skipped run',
    );
  });

  test('A2/A3: an empty store with a failing provider reports zero candles and the failure', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('forex', 'GBPUSD');

    const harness = makeHarness({ providerFails: true, maxRetries: 0 });
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const run = result.run;

    assert.deepEqual(candlesOf(run), { store: 0, provider: 0, total: 0 }, 'no candles were ever available');
    assert.equal(run.candlesFetched, 0);
    assert.equal(skipsOf(run), 0);
    assert.equal(run.instrumentsScanned, 0, 'the pair never completed its fetches');
    assert.equal(run.providerFailures, 1, 'the provider failure is still counted as before');
    assert.equal(run.staleRejections, 0, 'a provider failure is not a staleness rejection');
    assert.equal((run.metadata.errors as string[]).length, 1, 'the swallowed error is still recorded');
    assert.ok(['failed', 'partial'].includes(run.status), 'the run does not claim to be healthy');
    assert.equal(harness.detectCalls.length, 0, 'nothing is evaluated without data');
  });

  test('A2: each independent run reports its own totals (counters do not accumulate across runs)', async () => {
    const now = nowMs();
    // USDJPY is untouched by every other case in this file.
    const { userId, strategyId } = await createScopedStrategy('forex', 'USDJPY');

    const harness = makeHarness();
    const first = await harness.scanner.triggerScan({ strategyId, force: true, initiatedBy: userId, nowMs: now });
    const second = await harness.scanner.triggerScan({ strategyId, force: true, initiatedBy: userId, nowMs: now });

    // Run 1 has an empty store: everything comes from the provider.
    assert.deepEqual(candlesOf(first.run), { store: 0, provider: PAIR_CANDLES, total: PAIR_CANDLES });
    // Fetch-through persisted those candles, so run 2 is served by the store:
    // the same batch is reported once more, from the other source — not doubled.
    assert.deepEqual(candlesOf(second.run), { store: PAIR_CANDLES, provider: 0, total: PAIR_CANDLES });

    for (const run of [first.run, second.run]) {
      const stats = candlesOf(run);
      assert.equal(stats.total, stats.store + stats.provider, 'total is the sum of the sources');
      assert.equal(run.candlesFetched, stats.total, 'candles_fetched mirrors the total');
      assert.equal(run.candlesFetched, PAIR_CANDLES, 'counters are per run, never cumulative');
    }
    assert.equal(skipsOf(first.run), 0);
    assert.equal(skipsOf(second.run), 0, 'force=true never reports a skip');
  });
});
