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
  SCANNER_RUN_PAIR_ITEMS_MAX,
  readScannerRunPairAggregate,
  readScannerRunPairs,
  scannerPairDiagnosticsSchema,
  scannerRunPairsSchema,
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
  buildScannerRunPairs,
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
  normalisePairDiagnostics,
  redactScannerRunForViewer,
  redactScannerRunMetadata,
  runMigrations,
} from '../src/index.js';

/** Structural alias for the core observation type (not exported by name). */
type PairObservationLike = Parameters<typeof buildScannerRunPairs>[0][number];

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
  /** Phase B: shift a timeframe's batches into the past to force staleness. */
  public lagByTimeframe: Partial<Record<string, number>> = {};
  /** PR A: cap the returned batch so a pair can be starved of history. */
  public maxCandles: number | null = null;

  async getSymbols() {
    return [];
  }

  async getHistoricalCandles(request: { timeframe: Timeframe; to: number }): Promise<Candle[]> {
    this.calls.push(request.timeframe);
    if (this.failWith) throw this.failWith;
    const batch = roleBatch(request.timeframe, request.to - (this.lagByTimeframe[request.timeframe] ?? 0));
    return this.maxCandles === null ? batch : batch.slice(-this.maxCandles);
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
  assetClass: 'forex' | 'commodity' | 'crypto' | 'index',
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
function makeHarness(
  options: {
    providerFails?: boolean;
    maxRetries?: number;
    /** Phase B: push selected role batches into the past so freshness rejects them. */
    providerLagByTimeframe?: Partial<Record<'4h' | '1h' | '15m', number>>;
    /** Phase B: what the stubbed detector reports for each direction. */
    detectSummary?: { satisfied: number; unsatisfied: number; insufficient_data: number; unsupported: number };
    detectReasons?: string[];
    /** PR A: per-condition failures the stubbed detector reports. */
    detectConditionOutcomes?: { conditionType: string; status: string }[];
    /**
     * PR A: take over the stubbed detector entirely — omit a direction,
     * qualify one, or throw — so every scanner exit path can be exercised.
     */
    detectOverride?: (args: { direction: 'long' | 'short'; asOf: number }) => unknown;
    /** PR A: a qualified detection needs scoring/alerts stubbed out (they need real rows). */
    stubScoringAndAlerts?: boolean;
    /** PR A: starve the provider so a pair has too little history. */
    providerMaxCandles?: number;
  } = {},
): Harness {
  const provider = new PhaseAProvider();
  provider.lagByTimeframe = options.providerLagByTimeframe ?? {};
  provider.maxCandles = options.providerMaxCandles ?? null;
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
      if (options.detectOverride) return options.detectOverride({ direction: args.direction, asOf: args.asOf });
      return {
        detections: [
          {
            direction: args.direction,
            qualified: false,
            setup: null,
            created: false,
            failureReasons: options.detectReasons ?? [],
            ...(options.detectSummary ? { conditionSummary: options.detectSummary } : {}),
            ...(options.detectConditionOutcomes ? { conditionOutcomes: options.detectConditionOutcomes } : {}),
          },
        ],
      };
    },
  } as unknown as SetupService;

  const scoring = options.stubScoringAndAlerts
    ? ({ scoreSetup: async () => undefined } as unknown as ScoringService)
    : new ScoringService(pool, strategies, evaluation);
  const alerts = options.stubScoringAndAlerts
    ? ({ generateAlert: async () => ({ alert: null, created: false }) } as unknown as AlertService)
    : new AlertService(pool, strategies, new StubAlertSender(), new NotificationOutbox(pool, { maxAttempts: 5 }));

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

/**
 * Phase B — per-pair evaluation observability.
 *
 * The invariants these tests exist to protect:
 *  - every walked pair produces EXACTLY ONE mutually exclusive outcome, so
 *    totals always reconcile with the run's own counters;
 *  - `cursor_skipped` is never presented as an evaluation (no condition counts,
 *    no engine reasons) — the dashboard bug this phase exists to kill;
 *  - totals come from all pairs while `items` is a bounded, deterministic sample;
 *  - nested strategy identifiers and strategy-derived text are redacted at any
 *    depth for anyone who does not own the run;
 *  - historical runs (no `pairs` key) stay readable and are never mistaken for
 *    "zero pairs".
 */
describe('Phase B — per-pair evaluation outcomes', () => {
  const nowMs = () => Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 25 * 60_000;
  const pairsOf = (run: { metadata: Record<string, unknown> }) => readScannerRunPairs(run.metadata);

  test('B1: a cursor skip is recorded as cursor_skipped and never as an evaluation', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('commodity', 'XAUUSD');
    const instrument = await candleStore.resolveInstrument('commodity', 'XAUUSD');
    assert.ok(instrument);
    await seedStore(instrument.id, now);

    const harness = makeHarness();
    const first = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const firstPairs = pairsOf(first.run);
    assert.ok(firstPairs, 'a run always records the pairs block');
    assert.deepEqual(firstPairs.totals, { pairs: 1, evaluated: 1, cursor_skipped: 0, stale: 0, failed: 0 });
    assert.equal(firstPairs.items[0]?.outcome, 'evaluated');
    assert.ok(firstPairs.items[0]?.conditions, 'an evaluated pair carries condition counts');
    assert.ok((firstPairs.items[0]?.cursorMs ?? 0) > 0, 'the evaluated pair records the candle it processed');
    assert.equal(firstPairs.items[0]?.anchorMs, (firstPairs.items[0]?.cursorMs ?? 0) + HOUR_MS);

    const second = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const secondPairs = pairsOf(second.run);
    assert.ok(secondPairs);
    assert.deepEqual(secondPairs.totals, { pairs: 1, evaluated: 0, cursor_skipped: 1, stale: 0, failed: 0 });

    const skipped = secondPairs.items[0];
    assert.equal(skipped?.outcome, 'cursor_skipped');
    assert.equal(skipped?.reason, 'cursor_hit');
    assert.equal(skipped?.conditions, undefined, 'a skip is not an evaluation: no condition counts');
    assert.equal(skipped?.failureReasons, undefined, 'a skip never carries engine reasons');
    assert.deepEqual(secondPairs.conditions, { satisfied: 0, unsatisfied: 0, insufficient_data: 0, unsupported: 0 });

    // Reconciliation: the historical counter is DERIVED from the pair block.
    assert.equal(second.run.metadata.duplicateCandleSkips, secondPairs.totals.cursor_skipped);
    assert.equal(first.run.metadata.duplicateCandleSkips, 0);
    assert.equal(second.run.status, 'completed', 'a no-op run is still a healthy run');
    assert.equal(second.run.setupsDetected, 0);
  });

  test('B2: an evaluated pair aggregates both directions’ condition outcomes', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('commodity', 'XAUUSD');
    const instrument = await candleStore.resolveInstrument('commodity', 'XAUUSD');
    assert.ok(instrument);
    await seedStore(instrument.id, now);

    const harness = makeHarness({
      detectSummary: { satisfied: 1, unsatisfied: 2, insufficient_data: 3, unsupported: 4 },
      detectReasons: ['rule group "Structure" (AND) is not satisfied'],
    });
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const pairs = pairsOf(result.run);
    assert.ok(pairs);

    assert.equal(pairs.totals.evaluated, 1);
    // Both directions are evaluated, so every count doubles.
    assert.deepEqual(pairs.conditions, { satisfied: 2, unsatisfied: 4, insufficient_data: 6, unsupported: 8 });
    assert.deepEqual(pairs.items[0]?.conditions, { satisfied: 2, unsatisfied: 4, insufficient_data: 6, unsupported: 8 });
    assert.equal(pairs.items[0]?.failureReasons?.length, 2, 'reasons are capped per pair, one per direction');
    assert.match(pairs.items[0]?.failureReasons?.[0] ?? '', /rule group/);
    assert.equal(result.run.setupsDetected, 0);
  });

  test('B2: engine reasons are sanitized before they are stored', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('commodity', 'XAUUSD');
    const instrument = await candleStore.resolveInstrument('commodity', 'XAUUSD');
    assert.ok(instrument);
    await seedStore(instrument.id, now);

    const harness = makeHarness({
      detectReasons: [
        'strategy 11111111-1111-4111-8111-111111111111 leaked a strategy reference',
        'api_key=sk_live_abcdef123456 appeared in a reason',
      ],
    });
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    // Only the reason TEXT is under test: `items[].strategyId` is the owner's own
    // identifier and is expected to be present in their own run metadata.
    const stored = (pairsOf(result.run)?.items[0]?.failureReasons ?? []).join(' | ');
    assert.equal(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(stored),
      false,
      'a strategy UUID must never reach stored metadata text',
    );
    assert.equal(stored.includes('sk_live_'), false, 'a provider key must never reach stored metadata text');
  });

  test('B3: stale data is recorded as stale, not as a failed or an evaluated pair', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('forex', 'EURUSD');

    // The fixture clock is 25 minutes past the hour, so a 1h lag puts the newest
    // closed setup bar ~2h25m old: within MTF recency (≤ 3 × 1h) but older than
    // the 1h freshness threshold (2h), so the freshness branch is exercised
    // rather than the MTF one.
    const harness = makeHarness({ providerLagByTimeframe: { '1h': HOUR_MS } });
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const pairs = pairsOf(result.run);
    assert.ok(pairs);

    assert.equal(result.run.staleRejections, 1);
    assert.deepEqual(pairs.totals, { pairs: 1, evaluated: 0, cursor_skipped: 0, stale: 1, failed: 0 });
    assert.match(pairs.items[0]?.reason ?? '', /stale_candle$/);
    assert.equal(pairs.items[0]?.conditions, undefined);
    assert.equal(pairs.items[0]?.failureReasons, undefined);
    assert.deepEqual(pairs.conditions, { satisfied: 0, unsatisfied: 0, insufficient_data: 0, unsupported: 0 });
  });

  test('B4: a provider failure is recorded as failed with a bounded cause code', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('forex', 'EURUSD');

    const harness = makeHarness({ providerFails: true, maxRetries: 0 });
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const pairs = pairsOf(result.run);
    assert.ok(pairs);

    assert.deepEqual(pairs.totals, { pairs: 1, evaluated: 0, cursor_skipped: 0, stale: 0, failed: 1 });
    assert.equal(pairs.items[0]?.outcome, 'failed');
    assert.equal(pairs.items[0]?.reason, 'rate_limited', 'the provider failure kind, not a free-text message');
    assert.equal(pairs.items[0]?.conditions, undefined);
    // Existing counters are untouched by the new block.
    assert.equal(result.run.providerFailures, 1);
    assert.equal(result.run.staleRejections, 0);
    assert.equal(result.run.instrumentsScanned, 0, 'the pair never completed its fetches');
  });

  test('B5: totals cover every pair while items are a bounded, deterministic sample', () => {
    const observation = (index: number): PairObservationLike => ({
      strategyId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      assetClass: 'crypto',
      symbol: `SYM${index % 7}`,
      timeframe: '1h',
      outcome: index % 4 === 0 ? 'cursor_skipped' : index % 4 === 1 ? 'evaluated' : index % 4 === 2 ? 'stale' : 'failed',
      cursorMs: 1_700_000_000_000 + index,
      anchorMs: 1_700_003_600_000 + index,
      reason: null,
      ...(index % 4 === 1
        ? { conditions: { satisfied: 1, unsatisfied: 0, insufficient_data: 0, unsupported: 0 } }
        : {}),
    });
    const observations = Array.from({ length: 250 }, (_, index) => observation(index));

    const block = buildScannerRunPairs(observations as never);

    assert.equal(block.totals.pairs, 250, 'totals are computed over ALL pairs');
    assert.equal(
      block.totals.evaluated + block.totals.cursor_skipped + block.totals.stale + block.totals.failed,
      block.totals.pairs,
      'outcomes are mutually exclusive',
    );
    assert.equal(block.items.length, SCANNER_RUN_PAIR_ITEMS_MAX);
    assert.equal(block.truncated, true);
    assert.equal(block.conditions.satisfied, block.totals.evaluated, 'conditions are summed over evaluated pairs only');

    // Determinism: the same observations in a different order persist the same sample.
    const shuffled = [...observations].reverse();
    assert.deepEqual(buildScannerRunPairs(shuffled as never).items, block.items);

    // The block round-trips through the published contract.
    assert.equal(scannerRunPairsSchema.safeParse(block).success, true);
  });

  test('B6: nested strategy identifiers are redacted for non-owners at any depth', () => {
    const strategyId = '22222222-2222-4222-8222-222222222222';
    const owner = '33333333-3333-4333-8333-333333333333';
    const metadata = {
      triggeredBy: owner,
      force: false,
      candles: { store: 300, provider: 0, total: 300 },
      duplicateCandleSkips: 1,
      pairs: buildScannerRunPairs([
        {
          strategyId,
          assetClass: 'crypto',
          symbol: 'BTCUSD',
          timeframe: '1h',
          outcome: 'evaluated',
          cursorMs: 1_700_000_000_000,
          anchorMs: 1_700_003_600_000,
          reason: null,
          conditions: { satisfied: 1, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
          failureReasons: ['rule group "Structure" (AND) is not satisfied'],
        },
      ] as never),
    };

    const asOwner = JSON.stringify(redactScannerRunMetadata(metadata, owner));
    assert.ok(asOwner.includes(strategyId), 'the owner still sees which strategy produced the pair');

    for (const viewer of ['not-the-owner', '']) {
      const redacted = JSON.stringify(redactScannerRunMetadata(metadata, viewer));
      assert.equal(redacted.includes(strategyId), false, 'a strategy UUID must never reach another viewer');
      assert.equal(redacted.includes('failureReasons'), false, 'strategy-derived text is dropped for non-owners');
      assert.equal(redacted.includes('"triggeredBy"'), false);
    }

    // Non-identifying operational detail survives redaction.
    const shared = redactScannerRunMetadata(metadata, 'not-the-owner');
    assert.deepEqual(
      (shared.pairs as { totals: unknown }).totals,
      { pairs: 1, evaluated: 1, cursor_skipped: 0, stale: 0, failed: 0 },
      'counts stay visible: they identify no tenant',
    );
    assert.deepEqual(shared.candles, { store: 300, provider: 0, total: 300 });

    // Stripping the strategy UUID is not enough: a lone observation still names
    // an instrument, a timeframe and a candle timing. The whole sample goes.
    assert.equal(
      (shared.pairs as { items?: unknown }).items,
      undefined,
      'per-pair observations are never tenant-facing',
    );
    assert.equal(JSON.stringify(shared).includes('BTCUSD'), false);
    assert.equal(JSON.stringify(shared).includes('cursorMs'), false);
    assert.equal(readScannerRunPairAggregate(shared)?.totals.evaluated, 1, 'aggregates stay readable');
    assert.equal(readScannerRunPairs(shared), null, 'there is no detail sample to read');

    // A trusted operator read keeps the sample (identifiers still stripped).
    const operator = redactScannerRunMetadata(metadata, '', { keepPairObservations: true });
    assert.equal((operator.pairs as { items: unknown[] }).items.length, 1);

    // The input is never mutated by redaction.
    assert.equal(metadata.pairs.items[0]!.strategyId, strategyId);
  });

  test('B7: a historical run without the block parses as "detail unavailable", never as zero', () => {
    assert.equal(readScannerRunPairs({ triggeredBy: 'system', candles: { store: 0, provider: 0, total: 0 } }), null);
    assert.equal(readScannerRunPairs({}), null);
    assert.equal(readScannerRunPairs({ pairs: { v: 2 } } as never), null, 'an unknown version is not guessed');
    assert.equal(
      readScannerRunPairs({ pairs: { v: 1, totals: { pairs: 1 }, conditions: {}, truncated: false, items: [] } } as never),
      null,
      'a malformed block never throws',
    );
  });
});

describe('PR A — evaluation diagnostics', () => {
  const nowMs = () => Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 25 * 60_000;
  const pairsOf = (run: { metadata: Record<string, unknown> }) => readScannerRunPairs(run.metadata);
  const limitError = () =>
    new Error('Saved setups limit reached. Your plan allows up to 1000 saved setups.');

  async function seededPair(assetClass: 'commodity' | 'crypto', symbol: string) {
    const now = nowMs();
    const scoped = await createScopedStrategy(assetClass, symbol);
    const instrument = await candleStore.resolveInstrument(assetClass, symbol);
    assert.ok(instrument);
    await seedStore(instrument.id, now);
    return { now, ...scoped };
  }

  test('A1: a cursor skip records the cursor stage and no direction evidence', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness();

    const first = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    assert.equal(pairsOf(first.run)?.items[0]?.diagnostics?.stage, 'complete', 'the first scan evaluates');
    const callsAfterFirst = harness.detectCalls.length;
    assert.equal(callsAfterFirst, 2, 'the detector ran for both directions');

    const second = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(second.run)?.items[0];
    assert.equal(item?.outcome, 'cursor_skipped');
    assert.equal(item?.diagnostics?.stage, 'cursor');
    assert.deepEqual(item?.diagnostics?.codes, ['cursor_hit']);
    assert.equal(item?.diagnostics?.directions, undefined, 'a skip evaluated no direction');
    assert.equal(item?.diagnostics?.data?.setup.candles, ROLE_COUNTS['1h'], 'the loaded history is still recorded');
    assert.equal(harness.detectCalls.length, callsAfterFirst, 'a cursor skip never invokes the detector');
  });

  test('A2: an evaluated pair names the failing condition of each direction', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness({
      detectSummary: { satisfied: 1, unsatisfied: 1, insufficient_data: 1, unsupported: 1 },
      detectConditionOutcomes: [
        { conditionType: 'liquidity_sweep', status: 'unsatisfied' },
        { conditionType: 'news_filter', status: 'insufficient_data' },
      ],
      detectReasons: ['rule group "Structure" (AND) is not satisfied'],
    });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(result.run)?.items[0];
    assert.equal(item?.outcome, 'evaluated');
    assert.equal(item?.reason, null, 'both directions were evaluated');
    assert.equal(item?.diagnostics?.stage, 'complete');

    const long = item?.diagnostics?.directions?.long;
    assert.equal(long?.state, 'not_qualified');
    assert.deepEqual(long?.failing, ['liquidity_sweep:unsatisfied', 'news_filter:insufficient_data']);
    assert.deepEqual(long?.conditions, { satisfied: 1, unsatisfied: 1, insufficient_data: 1, unsupported: 1 });
    assert.equal(item?.diagnostics?.directions?.short?.state, 'not_qualified');
    // The legacy fields keep their exact meaning.
    assert.deepEqual(item?.conditions, { satisfied: 2, unsatisfied: 2, insufficient_data: 2, unsupported: 2 });
    assert.equal(result.run.setupsDetected, 0);
  });

  test('A3: an evaluated and qualified pair marks the direction qualified', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const setupId = '44444444-4444-4444-8444-444444444444';
    const harness = makeHarness({
      stubScoringAndAlerts: true,
      detectOverride: ({ direction }) => ({
        detections: [
          {
            direction,
            qualified: direction === 'long',
            setup: direction === 'long' ? { id: setupId } : null,
            created: direction === 'long',
            failureReasons: [],
            conditionSummary: { satisfied: 2, unsatisfied: 0, insufficient_data: 0, unsupported: 0 },
          },
        ],
      }),
    });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(result.run)?.items[0];
    assert.equal(item?.outcome, 'evaluated');
    assert.equal(item?.diagnostics?.directions?.long?.state, 'qualified');
    assert.equal(item?.diagnostics?.directions?.long?.failing, undefined, 'a qualified direction has nothing to explain');
    assert.equal(item?.diagnostics?.directions?.short?.state, 'not_qualified');
    assert.equal(result.run.setupsDetected, 1);
    assert.equal(result.run.setupsCreated, 1);
    assert.equal(result.run.alertsCreated, 0, 'the stubbed alert service created nothing');
  });

  test('A4: insufficient history is recorded as validation with the counts that prove it', async () => {
    const now = nowMs();
    // GBPUSD is deliberately NOT seeded here: the pair depends entirely on what
    // the provider returns, and here that is a batch too short for the roles.
    const { userId, strategyId } = await createScopedStrategy('forex', 'GBPUSD');
    const harness = makeHarness({ providerMaxCandles: 10 });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(result.run)?.items[0];
    assert.equal(item?.outcome, 'stale');
    assert.equal(item?.reason, 'mtf_invalid', 'the stable reason code is unchanged');
    assert.equal(item?.diagnostics?.stage, 'validation');
    assert.ok(item?.diagnostics?.codes?.includes('insufficient_history'), 'the category is recorded');
    assert.ok(
      item?.diagnostics?.codes?.includes('insufficient_candles_for_correlation'),
      'the specific validation cause is recorded alongside it',
    );
    const counts = item?.diagnostics?.data;
    assert.deepEqual(
      { htf: counts?.htf.candles, setup: counts?.setup.candles, entry: counts?.entry.candles },
      { htf: 10, setup: 10, entry: 10 },
      'the per-role history is what makes this diagnosable',
    );
    assert.equal(typeof counts?.htf.newestMs, 'number');
    assert.equal(item?.diagnostics?.directions, undefined, 'validation never reached the detector');
    assert.equal(result.run.staleRejections, 1);
  });

  test('A5: stale freshness names the role that was too old', async () => {
    const now = nowMs();
    const { userId, strategyId } = await createScopedStrategy('forex', 'EURUSD');
    const harness = makeHarness({ providerLagByTimeframe: { '1h': HOUR_MS } });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(result.run)?.items[0];
    assert.equal(item?.outcome, 'stale');
    assert.equal(item?.diagnostics?.stage, 'freshness');
    assert.deepEqual(item?.diagnostics?.codes, ['setup_stale_candle']);
    assert.ok(item?.diagnostics?.data, 'the data counts are recorded even when the data is stale');
  });

  test('A6: a persistence limit is a failure with a cause, not an evaluation', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness({ detectOverride: () => { throw limitError(); } });

    const first = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const pairs = pairsOf(first.run);
    assert.ok(pairs);
    assert.deepEqual(
      pairs.totals,
      { pairs: 1, evaluated: 0, cursor_skipped: 0, stale: 0, failed: 1 },
      'a refused evaluation is never counted as evaluated',
    );
    const item = pairs.items[0];
    assert.equal(item?.outcome, 'failed');
    assert.equal(item?.reason, 'setup_limit_reached');
    assert.equal(item?.diagnostics?.stage, 'persistence');
    assert.deepEqual(item?.diagnostics?.codes, ['setup_limit_reached', 'setup_not_persisted']);
    assert.equal(item?.diagnostics?.directions?.long?.state, 'blocked');
    assert.equal(item?.diagnostics?.directions?.short?.state, 'blocked');
    assert.equal(item?.conditions, undefined, 'nothing was evaluated, so there are no condition counts');
    assert.equal(first.run.setupsDetected, 0);

    // PR A records this state; it does NOT change cursor advancement.
    const second = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    assert.equal(pairsOf(second.run)?.items[0]?.outcome, 'cursor_skipped', 'the cursor still advanced');
  });

  test('A7: one blocked direction and one evaluated direction stays evaluated, and says which', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness({
      detectOverride: ({ direction }) => {
        if (direction === 'long') throw limitError();
        return {
          detections: [
            {
              direction,
              qualified: false,
              setup: null,
              created: false,
              failureReasons: [],
              conditionSummary: { satisfied: 0, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
              conditionOutcomes: [{ conditionType: 'fvg', status: 'unsatisfied' }],
            },
          ],
        };
      },
    });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(result.run)?.items[0];
    assert.equal(item?.outcome, 'evaluated');
    assert.equal(item?.reason, 'partial_evaluation');
    assert.deepEqual(item?.diagnostics?.codes, ['setup_limit_reached']);
    assert.equal(item?.diagnostics?.directions?.long?.state, 'blocked');
    assert.equal(item?.diagnostics?.directions?.short?.state, 'not_qualified');
    assert.deepEqual(item?.diagnostics?.directions?.short?.failing, ['fvg:unsatisfied']);
  });

  test('A8: a detector that returns no item is a failure, not an evaluation', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness({ detectOverride: () => ({ detections: [] }) });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const pairs = pairsOf(result.run);
    assert.deepEqual(pairs?.totals, { pairs: 1, evaluated: 0, cursor_skipped: 0, stale: 0, failed: 1 });
    const item = pairs?.items[0];
    assert.equal(item?.reason, 'detector_unavailable');
    assert.equal(item?.diagnostics?.stage, 'detection');
    assert.equal(item?.diagnostics?.directions?.long?.state, 'not_run');
    assert.equal(item?.diagnostics?.directions?.short?.state, 'not_run');
    assert.equal(harness.detectCalls.length, 2, 'the detector WAS called — this is not a pre-detection failure');
  });

  test('A9: a failure before evaluation records the candle stage and no history', async () => {
    const now = nowMs();
    // SPX500 is never seeded anywhere in this file, so the store stays empty
    // and the failure can only come from the provider call.
    const { userId, strategyId } = await createScopedStrategy('index', 'SPX500');
    const harness = makeHarness({ providerFails: true, maxRetries: 0 });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(result.run)?.items[0];
    assert.equal(item?.outcome, 'failed');
    assert.equal(item?.reason, 'rate_limited', 'the bounded provider kind is unchanged');
    assert.equal(item?.diagnostics?.stage, 'candles');
    assert.equal(item?.diagnostics?.data, undefined, 'no role completed a fetch');
    assert.equal(result.run.providerFailures, 1);
  });

  test('A10: a failure during evaluation records the detection stage and the direction', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness({
      detectOverride: () => {
        throw new ProviderError('unavailable', 'detector exploded');
      },
    });

    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const item = pairsOf(result.run)?.items[0];
    assert.equal(item?.outcome, 'failed');
    assert.equal(item?.reason, 'unavailable');
    assert.equal(item?.diagnostics?.stage, 'detection');
    assert.equal(item?.diagnostics?.directions?.long?.state, 'error');
    assert.deepEqual(item?.diagnostics?.codes, ['unavailable']);
    assert.ok(item?.diagnostics?.data, 'the history it did have is still recorded');
  });

  test('A11: diagnostics are bounded and the sample stays deterministic', () => {
    const makeObservation = (index: number): PairObservationLike =>
      ({
        strategyId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        assetClass: 'crypto',
        symbol: `SYM${index % 7}`,
        timeframe: '1h',
        outcome: 'evaluated',
        cursorMs: 1_700_000_000_000 + index,
        anchorMs: 1_700_003_600_000 + index,
        reason: null,
        conditions: { satisfied: 1, unsatisfied: 0, insufficient_data: 0, unsupported: 0 },
        diagnostics: {
          stage: 'complete',
          codes: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
          directions: {
            long: { state: 'not_qualified', failing: ['x:unsatisfied', 'x:unsatisfied', 'y:unsatisfied', 'z:unsatisfied', 'w:unsatisfied'] },
          },
        },
      }) as PairObservationLike;

    const observations = Array.from({ length: 250 }, (_, index) => makeObservation(index));
    const block = buildScannerRunPairs(observations);
    assert.equal(scannerRunPairsSchema.safeParse(block).success, true, 'the block always satisfies its own contract');
    assert.equal(block.v, 2);

    const diagnostics = block.items[0]?.diagnostics;
    assert.ok(diagnostics);
    assert.deepEqual(diagnostics.codes, ['a', 'b', 'c', 'd', 'e', 'f'], 'codes are de-duplicated and capped');
    assert.deepEqual(diagnostics.directions?.long?.failing, ['x:unsatisfied', 'y:unsatisfied', 'z:unsatisfied', 'w:unsatisfied']);

    const reversed = [...observations].reverse();
    assert.deepEqual(buildScannerRunPairs(reversed).items, block.items, 'the sample does not depend on scan order');

    // The normaliser is idempotent and preserves an already-clean object.
    const cleaned = normalisePairDiagnostics(diagnostics);
    assert.deepEqual(normalisePairDiagnostics(cleaned), cleaned);
    assert.equal(normalisePairDiagnostics(undefined), undefined);
  });

  test('A11b: malformed diagnostics fail closed — nothing is coerced into evidence', () => {
    /** The public entry point, called the way a hand-built observation would. */
    const normalise = (value: unknown) => normalisePairDiagnostics(value as never);

    // An unknown stage is not "close enough": we cannot say where the pair
    // stopped, so no diagnostics are stored at all.
    assert.equal(normalise({ stage: 'somewhere_else' }), undefined);
    assert.equal(normalise({ stage: 42 }), undefined);
    assert.equal(normalise({}), undefined, 'a stage is mandatory');

    // Codes must be bounded machine tokens. Over-long and prose values are
    // DROPPED — never truncated into something that reads as a valid code.
    assert.deepEqual(
      normalise({
        stage: 'complete',
        codes: ['x'.repeat(200), 'Setup limit reached', 'UPPER', 'cursor_hit', ' cursor_hit ', '', 'ok_code'],
      })?.codes,
      ['cursor_hit', 'ok_code'],
      'only real tokens survive, de-duplicated and trimmed',
    );
    assert.deepEqual(
      normalise({ stage: 'complete', codes: Array.from({ length: 9 }, (_, i) => `code_${i}`) })?.codes,
      ['code_0', 'code_1', 'code_2', 'code_3', 'code_4', 'code_5'],
      'the list is still capped',
    );

    // `data` is all-or-nothing: each role must be three verified numbers.
    const malformedRoles: unknown[] = [
      { candles: -1, newestMs: null },
      { candles: 1.5, newestMs: null },
      { candles: 2_000_000, newestMs: null },
      { candles: '120', newestMs: null },
      { candles: 120, newestMs: 0 },
      { candles: 120, newestMs: -5 },
      { candles: 120, newestMs: 1.5 },
      { candles: 120, newestMs: '1700000000000' },
      { candles: 120 },
      null,
    ];
    for (const bad of malformedRoles) {
      const out = normalise({
        stage: 'validation',
        data: { htf: bad, setup: { candles: 120, newestMs: 1_700_000_000_000 }, entry: { candles: 120, newestMs: 1_700_000_000_000 } },
      });
      assert.equal(out?.data, undefined, `a malformed role drops data (${JSON.stringify(bad)})`);
      assert.equal(out?.stage, 'validation', 'the verified stage survives');
      assert.equal(scannerPairDiagnosticsSchema.safeParse(out).success, true);
    }

    // A direction with an unknown state is dropped; a malformed condition block
    // is dropped while the verified state survives.
    const directions = normalise({
      stage: 'complete',
      directions: {
        long: { state: 'probably_fine' },
        short: { state: 'not_qualified', conditions: { satisfied: -1, unsatisfied: 1, insufficient_data: 0, unsupported: 0 } },
      },
    });
    assert.equal(directions?.directions?.long, undefined, 'an unknown state is not stored');
    assert.deepEqual(directions?.directions?.short, { state: 'not_qualified' }, 'the state survives, the bad counts do not');

    assert.equal(
      normalise({ stage: 'complete', directions: { long: { state: 'nope' }, short: { state: 'nope' } } })?.directions,
      undefined,
      'no valid direction means no directions key at all',
    );

    // `failing` obeys the same token rule.
    assert.deepEqual(
      normalise({
        stage: 'detection',
        directions: { long: { state: 'not_qualified', failing: ['z'.repeat(90), 'not a code', 'fvg:unsatisfied'] } },
      })?.directions?.long?.failing,
      ['fvg:unsatisfied'],
    );

    // Unknown keys are never copied through.
    assert.deepEqual(normalise({ stage: 'complete', symbol: 'XAUUSD', strategyId: 'leak' }), { stage: 'complete' });
  });

  test('A11c: a hand-built observation can never persist an out-of-contract block', () => {
    const observation = {
      strategyId: '00000000-0000-4000-8000-000000000001',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      timeframe: '1h',
      outcome: 'evaluated',
      cursorMs: 1_700_000_000_000,
      anchorMs: 1_700_003_600_000,
      reason: null,
      conditions: { satisfied: 0, unsatisfied: 0, insufficient_data: 0, unsupported: 0 },
      diagnostics: {
        stage: 'not_a_stage',
        codes: ['Setup limit reached'],
        data: { htf: { candles: -1, newestMs: null }, setup: { candles: -1, newestMs: null }, entry: { candles: -1, newestMs: null } },
        directions: { long: { state: 'bogus' } },
      },
    };

    const block = buildScannerRunPairs([observation as never]);
    assert.equal(scannerRunPairsSchema.safeParse(block).success, true, 'the persisted block is always contract-valid');
    assert.equal(block.items[0]?.diagnostics, undefined, 'nothing survived normalisation, so nothing is claimed');
    // The rest of the observation is untouched by diagnostics normalisation.
    assert.equal(block.items[0]?.outcome, 'evaluated');
    assert.deepEqual(block.totals, { pairs: 1, evaluated: 1, cursor_skipped: 0, stale: 0, failed: 0 });
  });

  test('A12: diagnostics never reach a viewer who does not own the run', () => {
    const owner = '55555555-5555-4555-8555-555555555555';
    const metadata = {
      triggeredBy: owner,
      force: false,
      duplicateCandleSkips: 0,
      pairs: buildScannerRunPairs([
        {
          strategyId: '66666666-6666-4666-8666-666666666666',
          assetClass: 'crypto',
          symbol: 'BTCUSD',
          timeframe: '1h',
          outcome: 'evaluated',
          cursorMs: 1_700_000_000_000,
          anchorMs: 1_700_003_600_000,
          reason: null,
          conditions: { satisfied: 1, unsatisfied: 1, insufficient_data: 0, unsupported: 0 },
          diagnostics: {
            stage: 'complete',
            codes: ['setup_limit_reached'],
            data: { htf: { candles: 60, newestMs: 1_700_000_000_000 }, setup: { candles: 120, newestMs: 1_700_003_600_000 }, entry: { candles: 120, newestMs: 1_700_003_600_000 } },
            directions: { long: { state: 'not_qualified', failing: ['liquidity_sweep:unsatisfied'] } },
          },
        },
      ] as never),
    };

    // The owner sees the evidence.
    const own = JSON.stringify(redactScannerRunMetadata(metadata, owner));
    assert.ok(own.includes('"diagnostics"'));
    assert.ok(own.includes('liquidity_sweep:unsatisfied'));

    // Every other viewer sees counts and nothing else.
    for (const viewer of ['not-the-owner', '']) {
      const shared = redactScannerRunMetadata(metadata, viewer);
      const payload = JSON.stringify(shared);
      for (const marker of ['diagnostics', 'liquidity_sweep', 'setup_limit_reached', 'BTCUSD', 'candleMs', 'newestMs']) {
        assert.equal(payload.includes(marker), false, `${marker} must not reach another viewer`);
      }
      assert.equal(readScannerRunPairs(shared), null, 'there is no detail sample to read');
      assert.equal(readScannerRunPairAggregate(shared)?.totals.evaluated, 1, 'aggregates stay readable');
    }

    // A trusted operator read keeps the evidence (identifiers still stripped).
    const operator = redactScannerRunMetadata(metadata, '', { keepPairObservations: true });
    assert.ok(JSON.stringify(operator).includes('liquidity_sweep:unsatisfied'));
    assert.equal(JSON.stringify(operator).includes('66666666-6666-4666-8666-666666666666'), false);
  });

  test('A13: a run recorded before PR A still reads, with no fabricated diagnostics', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness();
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const pairs = pairsOf(result.run);
    assert.ok(pairs);

    // Simulate the historical shape: same block, version 1, no diagnostics key.
    const legacy = {
      ...pairs,
      v: 1,
      items: pairs.items.map(({ diagnostics: _diagnostics, ...rest }) => rest),
    };
    const read = readScannerRunPairs({ pairs: legacy });
    assert.ok(read, 'a v1 block is still readable');
    assert.equal(read.v, 1);
    assert.equal(read.items[0]?.diagnostics, undefined);
    assert.equal(readScannerRunPairAggregate({ pairs: legacy })?.totals.pairs, 1);
  });

  test('A14: health redaction keeps the owner\u2019s diagnostics but strips another tenant\u2019s', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness();
    const result = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });

    const healthForOwner = await harness.scanner.getHealth(userId);
    assert.ok(healthForOwner.lastRun);
    assert.equal(JSON.stringify(healthForOwner.lastRun).includes('"diagnostics"'), true);

    const healthForOther = await harness.scanner.getHealth('77777777-7777-4777-8777-777777777777');
    assert.ok(healthForOther.lastRun);
    const other = JSON.stringify(healthForOther.lastRun);
    assert.equal(other.includes('"diagnostics"'), false, 'another tenant never receives pair diagnostics');
    assert.equal(other.includes('cursor_hit'), false);
    assert.equal(other.includes(userId), false);
    // NOTE: run-level `symbolsProcessed`/`timeframesProcessed` already existed
    // before PR A and are returned to every viewer of the shared health feed.
    // That is a pre-existing surface, deliberately untouched here (reported as
    // a follow-up finding) — this test pins only that PR A's diagnostics do not
    // add to it.

    // And the owner-level run DTO is the same object the API returns.
    const viewerDto = redactScannerRunForViewer(result.run, '77777777-7777-4777-8777-777777777777');
    assert.equal(JSON.stringify(viewerDto).includes('"diagnostics"'), false);
  });

  test('A15: one direction blocked by the limit and the other with no item is a failed pair', async () => {
    const { now, userId, strategyId } = await seededPair('commodity', 'XAUUSD');
    const harness = makeHarness({
      detectOverride: ({ direction }) => {
        // Long is refused by the saved-setup limit, short simply returns
        // nothing. Neither direction was evaluated, so the pair must not claim
        // to have been — while still naming what stopped each direction.
        if (direction === 'long') throw limitError();
        return { detections: [] };
      },
    });

    const first = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const pairs = pairsOf(first.run);
    assert.ok(pairs);
    assert.deepEqual(
      pairs.totals,
      { pairs: 1, evaluated: 0, cursor_skipped: 0, stale: 0, failed: 1 },
      'a pair with no evaluated direction is failed, not evaluated',
    );

    const item = pairs.items[0];
    assert.equal(item?.outcome, 'failed');
    assert.equal(item?.reason, 'setup_limit_reached', 'the limit is the cause worth surfacing');
    assert.equal(item?.diagnostics?.stage, 'persistence');
    assert.deepEqual(item?.diagnostics?.codes, ['setup_limit_reached', 'setup_not_persisted']);
    assert.equal(item?.diagnostics?.directions?.long?.state, 'blocked', 'refused by the limit');
    assert.equal(item?.diagnostics?.directions?.short?.state, 'not_run', 'the detector had nothing to report');
    assert.equal(item?.conditions, undefined, 'no direction produced condition counts');
    assert.equal(item?.failureReasons, undefined);
    assert.equal(first.run.setupsDetected, 0);
    assert.equal(first.run.status, 'completed', 'a refused pair does not fail the run');

    // Cursor advancement and idempotency are unchanged by PR A.
    const callsAfterFirst = harness.detectCalls.length;
    assert.equal(callsAfterFirst, 2, 'both directions were consulted once');

    const second = await harness.scanner.triggerScan({ strategyId, force: false, initiatedBy: userId, nowMs: now });
    const secondItem = pairsOf(second.run)?.items[0];
    assert.equal(secondItem?.outcome, 'cursor_skipped', 'the cursor still advanced on the limit path');
    assert.equal(secondItem?.reason, 'cursor_hit');
    assert.equal(secondItem?.diagnostics?.stage, 'cursor');
    assert.equal(harness.detectCalls.length, callsAfterFirst, 'the second scan never reached the detector');
  });
});
