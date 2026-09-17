/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M8.3 — paper execution simulator (core).
 *
 * Covers the full regression matrix required by the milestone, against a real
 * embedded Postgres and the real M8.1/M8.2 stack:
 *
 *  pure engine   long/short P&L, fees, slippage, SL/TP detection, conflicts,
 *                decision building, deterministic identities
 *  gates         every paper-simulation gate fails closed
 *  simulator     BUY/SELL, long/short, TP/SL exits, close, marks, full fills
 *  risk          M8.2 decision mandatory; rejected/forged/invalid refused
 *  idempotency   duplicate submission, duplicate fill, repeated SL/TP, retry
 *  reconciliation consistent state passes; tampering is DETECTED, never fixed
 *  failures      invalid/stale market data, fill failure, missing position
 *  isolation     owner-scoped reads/writes, masked 404s, append-only audit
 *  migration     additive constraints of 0018
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  PAPER_SIMULATION_GATE_IDS,
  PAPER_SIMULATOR_VERSION,
  RISK_ENGINE_VERSION,
  type InstrumentRiskSpec,
} from '@veltrixeye/contracts';
import {
  AuditService,
  AutomationService,
  CandleStoreMarketPriceSource,
  ExecutionIntakeService,
  ExecutionProfileService,
  KillSwitchService,
  PaperExecutionService,
  RiskEngineService,
  UserService,
  buildServerExecutionDecision,
  computeEntryFill,
  computeExitFill,
  createExecutionProviderRegistry,
  createPaperExecutionProvider,
  createPool,
  detectExit,
  evaluatePaperSimulationGates,
  executionIdempotencyHash,
  grossRealizedPl,
  netRealizedPl,
  paperClientOrderId,
  paperProviderPositionId,
  runMigrations,
  MIGRATIONS_DIR,
  type SimulatorMarketPriceSource,
} from '../src/index.js';
import { Dec } from '../src/risk/decimal.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5451;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_paper_execution';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;
let killSwitches: KillSwitchService;
let automation: AutomationService;
let risk: RiskEngineService;
let profiles: ExecutionProfileService;
let intake: ExecutionIntakeService;
let paper: PaperExecutionService;
let market: CandleStoreMarketPriceSource;
let registry: ReturnType<typeof createExecutionProviderRegistry>;

const uniqueEmail = () => `paper_${randomBytes(6).toString('hex')}@example.com`;
const T0 = 1_700_000_000_000; // fixed clock anchor (epoch ms)
/** Fixed clock: the simulator's financial values use `nowMs`; the in-memory
 *  authorization TTL uses this clock, so the suite stays deterministic. */
const clock = { now: T0 };
const serviceOptions = { clock: () => clock.now };
const MIN = 60_000;
const FIVE_MIN = 5 * MIN;
let anchorCounter = 0;

const EURUSD: InstrumentRiskSpec = {
  assetClass: 'forex',
  symbol: 'EURUSD',
  contractSize: 100_000,
  pipSize: 0.0001,
  pnlMode: 'quote_linear',
  quoteCurrency: 'USD',
  minQuantity: 0.01,
  quantityStep: 0.01,
  maxQuantity: 100,
};

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-paper-execution');
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
  audit = new AuditService(pool);
  killSwitches = new KillSwitchService(pool);
  automation = new AutomationService(pool, killSwitches, audit);
  risk = new RiskEngineService(pool, { killSwitches, audit });
  registry = createExecutionProviderRegistry();
  // The provider calls back into the service; the binding is created before
  // the service exists and is only dereferenced at submit time.
  const serviceRef = (): PaperExecutionService => paper;
  const provider = createPaperExecutionProvider({
    simulator: { submitAuthorizedOrder: (args) => serviceRef().submitAuthorizedOrder(args) },
  });
  registry.register(provider);
  market = new CandleStoreMarketPriceSource(pool);
  paper = new PaperExecutionService(
    pool,
    {
      market,
      risk,
      killSwitches,
      automation,
      audit,
      provider: () => registry.get('paper'),
    },
    serviceOptions,
  );
  profiles = new ExecutionProfileService(pool, registry, audit);
  intake = new ExecutionIntakeService(pool, { automation, killSwitches, providers: registry, audit, risk });
}, { timeout: 240_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function makeUser(): Promise<{ id: string }> {
  const user = await users.create({
    email: uniqueEmail(),
    passwordHash: 'x'.repeat(32),
    name: 'Paper Tester',
  });
  return { id: user.id };
}

async function makeProfile(userId: string): Promise<string> {
  const profile = await profiles.createProfile(userId, { mode: 'paper', providerSlug: 'paper' });
  return profile.id;
}

let strategyCounter = 0;

async function makeStrategy(
  userId: string,
  opts: { minRr?: number; minQualityScore?: number } = {},
): Promise<{ strategyId: string; versionId: string }> {
  strategyCounter += 1;
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `paper test strategy ${strategyCounter}`],
  );
  const strategyId = strategy.rows[0]!.id;
  const version = await pool.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by)
     VALUES ($1, 1, 'draft', $2) RETURNING id`,
    [strategyId, userId],
  );
  const versionId = version.rows[0]!.id;
  await pool.query(
    `INSERT INTO strategy_timeframes (version_id, role, timeframe)
     VALUES ($1, 'htf_bias', '1h'), ($1, 'setup', '5m'), ($1, 'entry', '1m')`,
    [versionId],
  );
  await pool.query(
    `INSERT INTO strategy_risk_config
       (version_id, min_rr, stop_loss_method, stop_loss_buffer, stop_loss_buffer_unit,
        take_profit_method, tp1_rr, tp2_rr, tp3_rr, min_quality_score)
     VALUES ($1, $2, 'structure', 0, 'pips', 'rr', 2, 3, 4, $3)`,
    [versionId, opts.minRr ?? 2, opts.minQualityScore ?? 60],
  );
  await pool.query(
    `UPDATE strategy_versions SET status = 'published', published_at = now() WHERE id = $1`,
    [versionId],
  );
  return { strategyId, versionId };
}

interface SetupFixture {
  setupId: string;
  instrumentId: string;
  versionId: string;
  strategyId: string;
}

async function makeSetup(
  userId: string,
  opts: {
    direction?: 'long' | 'short';
    entry?: number | null;
    stop?: number | null;
    tp?: number | null;
    quality?: number;
    state?: string;
    minQualityScore?: number;
    minRr?: number;
    symbol?: string;
  } = {},
): Promise<SetupFixture> {
  const direction = opts.direction ?? 'long';
  const { strategyId, versionId } = await makeStrategy(userId, {
    minQualityScore: opts.minQualityScore,
    minRr: opts.minRr,
  });
  const symbol = opts.symbol ?? 'EURUSD';
  const instrument = await pool.query<{ id: string }>(
    `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = $1`,
    [symbol],
  );
  const instrumentId = instrument.rows[0]!.id;
  anchorCounter += 1;
  const asOfMs = T0 - anchorCounter;
  const setup = await pool.query<{ id: string }>(
    `INSERT INTO setups
       (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms,
        entry_price, stop_loss_price, tp1_price, quality_score)
     VALUES ($1,$2,$3,$4, to_timestamp($5 / 1000.0), $5,$6,$7,$8,$9) RETURNING id`,
    [
      versionId,
      instrumentId,
      opts.state ?? 'confirmed',
      direction,
      asOfMs,
      opts.entry === undefined ? 1.1 : opts.entry,
      opts.stop === undefined ? (direction === 'long' ? 1.095 : 1.105) : opts.stop,
      opts.tp === undefined ? (direction === 'long' ? 1.11 : 1.09) : opts.tp,
      opts.quality ?? 80,
    ],
  );
  return { setupId: setup.rows[0]!.id, instrumentId, versionId, strategyId };
}

async function insertCandle(
  instrumentId: string,
  ts: number,
  ohlc: { open: number; high: number; low: number; close: number },
  timeframe = '5m',
): Promise<void> {
  await pool.query(
    `INSERT INTO candles (instrument_id, timeframe, ts, open, high, low, close, provider_slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'test-provider')
     ON CONFLICT (instrument_id, timeframe, ts) DO UPDATE
       SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close`,
    [instrumentId, timeframe, ts, ohlc.open, ohlc.high, ohlc.low, ohlc.close],
  );
}

/** A flat entry candle at the setup's entry price, fresh at `nowMs`. */
async function seedEntryPrice(
  instrumentId: string,
  price = 1.1,
  ts = T0,
  timeframe = '5m',
): Promise<void> {
  await insertCandle(instrumentId, ts, { open: price, high: price, low: price, close: price }, timeframe);
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const res = await pool.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

/* -------------------------------------------------------------------------- */
/* 1. pure engine — P&L, fills, costs                                          */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper engine (pure)', () => {
  const qty = Dec.fromNumber(0.1)!;

  test('long gross P&L matches contract arithmetic exactly', () => {
    const gross = grossRealizedPl({
      direction: 'long',
      entryPrice: Dec.fromNumber(1.1)!,
      exitPrice: Dec.fromNumber(1.11)!,
      quantity: qty,
      spec: EURUSD,
    });
    assert.equal(gross!.toFixed(10), '100.0000000000'); // (1.11−1.10) × 0.1 × 100_000
  });

  test('long stop-out P&L is the exact negative risk', () => {
    const gross = grossRealizedPl({
      direction: 'long',
      entryPrice: Dec.fromNumber(1.1)!,
      exitPrice: Dec.fromNumber(1.095)!,
      quantity: qty,
      spec: EURUSD,
    });
    assert.equal(gross!.toFixed(10), '-50.0000000000');
  });

  test('short P&L is the mirror image', () => {
    const takeProfit = grossRealizedPl({
      direction: 'short',
      entryPrice: Dec.fromNumber(1.1)!,
      exitPrice: Dec.fromNumber(1.09)!,
      quantity: qty,
      spec: EURUSD,
    });
    const stop = grossRealizedPl({
      direction: 'short',
      entryPrice: Dec.fromNumber(1.1)!,
      exitPrice: Dec.fromNumber(1.105)!,
      quantity: qty,
      spec: EURUSD,
    });
    assert.equal(takeProfit!.toFixed(10), '100.0000000000');
    assert.equal(stop!.toFixed(10), '-50.0000000000');
  });

  test('fees and slippage are deterministic and reduce net P&L', () => {
    const costs = { entrySlippagePips: 1, exitSlippagePips: 2, feePipsPerSide: 0.5 };
    const entry = computeEntryFill({
      direction: 'long',
      referencePrice: Dec.fromNumber(1.1)!,
      quantity: qty,
      spec: EURUSD,
      costs,
    })!;
    // 1 pip = 0.0001 → buy fills one pip higher.
    assert.equal(entry.price.toFixed(10), '1.1001000000');
    assert.equal(entry.slippageCost.toFixed(10), '1.0000000000'); // 0.0001 × 0.1 × 100_000
    assert.equal(entry.fees.toFixed(10), '0.5000000000'); // 0.5 pip commission

    const exit = computeExitFill({
      direction: 'long',
      reason: 'stop_loss',
      level: Dec.fromNumber(1.095)!,
      referencePrice: Dec.fromNumber(1.09)!,
      quantity: qty,
      spec: EURUSD,
      costs,
    })!;
    assert.equal(exit.price.toFixed(10), '1.0948000000'); // stop fills 2 pips worse
    const gross = grossRealizedPl({
      direction: 'long',
      entryPrice: entry.price,
      exitPrice: exit.price,
      quantity: qty,
      spec: EURUSD,
    })!;
    const net = netRealizedPl({ gross, entryFees: entry.fees, exitFees: exit.fees })!;
    // −53 USD gross (slipped entry + slipped stop) − 1 USD fees.
    assert.equal(gross.toFixed(10), '-53.0000000000');
    assert.equal(net.toFixed(10), '-54.0000000000');
  });

  test('take-profit fills at the level without adverse slippage', () => {
    const exit = computeExitFill({
      direction: 'long',
      reason: 'take_profit',
      level: Dec.fromNumber(1.11)!,
      referencePrice: Dec.fromNumber(1.11)!,
      quantity: qty,
      spec: EURUSD,
      costs: { entrySlippagePips: 1, exitSlippagePips: 5, feePipsPerSide: 0 },
    })!;
    assert.equal(exit.price.toFixed(10), '1.1100000000');
  });

  test('non-positive references are refused instead of producing a fill', () => {
    assert.equal(
      computeEntryFill({
        direction: 'long',
        referencePrice: Dec.zero(),
        quantity: qty,
        spec: EURUSD,
        costs: { entrySlippagePips: 0, exitSlippagePips: 0, feePipsPerSide: 0 },
      }),
      null,
    );
    assert.equal(
      computeExitFill({
        direction: 'long',
        reason: 'close',
        level: Dec.fromNumber(-1)!,
        referencePrice: Dec.fromNumber(-1)!,
        quantity: qty,
        spec: EURUSD,
        costs: { entrySlippagePips: 0, exitSlippagePips: 0, feePipsPerSide: 0 },
      }),
      null,
    );
  });

  test('SL/TP detection is chronological, deterministic and conservative on conflict', () => {
    const tpOnly = detectExit({
      direction: 'long',
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11,
      candles: [{ time: T0 + FIVE_MIN, open: 1.1, high: 1.111, low: 1.099, close: 1.11 }],
    });
    assert.equal(tpOnly?.reason, 'take_profit');
    assert.equal(tpOnly?.conflict, false);

    const slFirst = detectExit({
      direction: 'long',
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11,
      candles: [
        { time: T0 + FIVE_MIN, open: 1.1, high: 1.105, low: 1.094, close: 1.095 },
        { time: T0 + 2 * FIVE_MIN, open: 1.095, high: 1.111, low: 1.094, close: 1.11 },
      ],
    });
    assert.equal(slFirst?.reason, 'stop_loss');

    // One bar touches BOTH levels: the stop wins and the conflict is reported.
    const conflict = detectExit({
      direction: 'long',
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11,
      candles: [{ time: T0 + FIVE_MIN, open: 1.1, high: 1.112, low: 1.093, close: 1.109 }],
    });
    assert.equal(conflict?.reason, 'stop_loss');
    assert.equal(conflict?.conflict, true);

    // Short positions are mirrored.
    const shortTp = detectExit({
      direction: 'short',
      stopLossPrice: 1.105,
      takeProfitPrice: 1.09,
      candles: [{ time: T0 + FIVE_MIN, open: 1.1, high: 1.101, low: 1.089, close: 1.09 }],
    });
    assert.equal(shortTp?.reason, 'take_profit');

    // Invalid candles are dropped, not trusted.
    const withJunk = detectExit({
      direction: 'long',
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11,
      candles: [
        { time: T0 + FIVE_MIN, open: 0, high: 0, low: 0, close: 0 },
        { time: T0 + 2 * FIVE_MIN, open: 1.1, high: 1.112, low: 1.1, close: 1.11 },
      ],
    });
    assert.equal(withJunk?.reason, 'take_profit');
    assert.equal(withJunk?.invalidCandles, 1);
  });

  test('identities are deterministic, distinct per kind and can never collide', () => {
    const hash = executionIdempotencyHash({
      userId: '11111111-1111-4111-8111-111111111111',
      setupId: '22222222-2222-4222-8222-222222222222',
      executionProfileId: '33333333-3333-4333-8333-333333333333',
      action: 'open_long',
    });
    assert.equal(hash, executionIdempotencyHash({
      userId: '11111111-1111-4111-8111-111111111111',
      setupId: '22222222-2222-4222-8222-222222222222',
      executionProfileId: '33333333-3333-4333-8333-333333333333',
      action: 'open_long',
    }));
    const entry = paperClientOrderId(hash, 'entry');
    const stop = paperClientOrderId(hash, 'stop_loss');
    const target = paperClientOrderId(hash, 'take_profit');
    assert.equal(new Set([entry, stop, target]).size, 3);
    assert.ok(entry.length <= 64 && stop.length <= 64 && target.length <= 64);
    assert.equal(paperProviderPositionId(hash), paperProviderPositionId(hash));
  });

  test('the server decision builder refuses unusable setups without inventing levels', () => {
    const base = {
      setupId: randomUUID(),
      strategyId: randomUUID(),
      strategyVersionId: randomUUID(),
      assetClass: 'forex',
      symbol: 'EURUSD',
      direction: 'long' as const,
      state: 'confirmed',
      asOfMs: T0,
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      tp1Price: 1.11,
      qualityScore: 80,
      minQualityScore: 60,
      timeframe: '5m',
    };
    assert.equal(buildServerExecutionDecision(base).ok, true);
    assert.equal(buildServerExecutionDecision({ ...base, state: 'developing' }).ok, false);
    assert.equal(buildServerExecutionDecision({ ...base, qualityScore: 10 }).ok, false);
    assert.equal(buildServerExecutionDecision({ ...base, stopLossPrice: null }).ok, false);
    assert.equal(buildServerExecutionDecision({ ...base, tp1Price: null }).ok, false);
    // Inverted stop (long stop above entry) is refused, never mirrored.
    assert.equal(buildServerExecutionDecision({ ...base, stopLossPrice: 1.12 }).ok, false);
    assert.equal(buildServerExecutionDecision({ ...base, timeframe: null }).ok, false);
    assert.equal(buildServerExecutionDecision({ ...base, minQualityScore: null }).ok, false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. gates — fail closed                                                      */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper simulation gates', () => {
  const baseDecision = {
    strategyId: randomUUID(),
    strategyVersionId: randomUUID(),
    setupId: randomUUID(),
    action: 'open_long' as const,
    assetClass: 'forex' as const,
    symbol: 'EURUSD',
    timeframe: '5m' as const,
    direction: 'long' as const,
    entryPrice: 1.1,
    stopLossPrice: 1.095,
    takeProfitPrice: 1.11,
    expectedRr: 2,
    qualityScore: 80,
    minQualityScore: 60,
    asOfMs: T0,
  };

  const input = () => ({
    authenticated: true,
    authorized: true,
    profile: { enabled: true, environment: 'paper' },
    killSwitches: { global: false, user: false, strategy: false, profile: false },
    providerHealth: { healthy: true, configured: true },
    decision: baseDecision,
    setup: { id: baseDecision.setupId, direction: 'long' as const, state: 'confirmed' },
    riskDecision: {
      outcome: 'approved' as const,
      reason: 'approved',
      decisionId: randomUUID(),
      engineVersion: RISK_ENGINE_VERSION,
      positionSize: 0.1,
      rr: 2,
      exposureWithinLimits: true,
    },
    effectiveMinRr: 2,
    instrumentSpec: EURUSD,
    fillPrice: 1.1,
    marketPrice: { price: 1.1, ageMs: 0, thresholdMs: 15 * MIN },
  });

  test('the pinned gate list is ordered and complete', () => {
    assert.deepEqual([...PAPER_SIMULATION_GATE_IDS][0], 'authenticated');
    assert.ok(PAPER_SIMULATION_GATE_IDS.includes('risk_decision_issued'));
    assert.ok(PAPER_SIMULATION_GATE_IDS.includes('market_price_fresh'));
    assert.equal(new Set(PAPER_SIMULATION_GATE_IDS).size, PAPER_SIMULATION_GATE_IDS.length);
  });

  test('a fully satisfied input passes every gate', () => {
    const result = evaluatePaperSimulationGates(input());
    assert.equal(result.passed, true, result.reason ?? '');
    assert.equal(result.failedGate, null);
    assert.deepEqual(result.evaluated, [...PAPER_SIMULATION_GATE_IDS]);
  });

  test('forged approval without a server-issued decision fails closed', () => {
    const forged = input();
    forged.riskDecision = {
      outcome: 'approved',
      reason: 'approved',
      decisionId: null,
      engineVersion: null,
      positionSize: 0.1,
      rr: 2,
      exposureWithinLimits: true,
    } as any;
    const result = evaluatePaperSimulationGates(forged);
    assert.equal(result.passed, false);
    assert.equal(result.failedGate, 'risk_decision_issued');
  });

  test('an unrecognized engine version fails closed', () => {
    const wrong = input();
    wrong.riskDecision.engineVersion = 'm9-not-a-real-engine';
    const result = evaluatePaperSimulationGates(wrong);
    assert.equal(result.passed, false);
    assert.equal(result.failedGate, 'risk_decision_issued');
  });

  test('a rejected risk decision is refused', () => {
    const rejected = input();
    (rejected.riskDecision as any).outcome = 'rejected';
    rejected.riskDecision.reason = 'exposure limits would be exceeded';
    const result = evaluatePaperSimulationGates(rejected);
    assert.equal(result.passed, false);
    assert.equal(result.failedGate, 'risk_approved');
  });

  test('invalid position sizes are refused', () => {
    for (const size of [null, 0, -1]) {
      const bad = input();
      (bad.riskDecision as any).positionSize = size;
      const result = evaluatePaperSimulationGates(bad);
      assert.equal(result.passed, false, `size ${size}`);
      assert.equal(result.failedGate, 'valid_position_size');
    }
    const offStep = input();
    offStep.riskDecision.positionSize = 0.001;
    const result = evaluatePaperSimulationGates(offStep);
    assert.equal(result.failedGate, 'valid_position_size');
  });

  test('kill switches in every scope block the simulation', () => {
    for (const scope of ['global', 'user', 'strategy', 'profile'] as const) {
      const blocked = input();
      blocked.killSwitches[scope] = true;
      const result = evaluatePaperSimulationGates(blocked);
      assert.equal(result.passed, false, scope);
      assert.equal(result.failedGate, 'kill_switch');
    }
  });

  test('a non-paper or disabled profile is refused', () => {
    const disabled = input();
    disabled.profile = { enabled: false, environment: 'paper' };
    assert.equal(evaluatePaperSimulationGates(disabled).failedGate, 'paper_profile');

    const live = input();
    live.profile = { enabled: true, environment: 'live' };
    assert.equal(evaluatePaperSimulationGates(live).failedGate, 'paper_profile');
  });

  test('an unhealthy or unknown provider is refused', () => {
    const unhealthy = input();
    unhealthy.providerHealth = { healthy: false, configured: true };
    assert.equal(evaluatePaperSimulationGates(unhealthy).failedGate, 'provider_ready');

    const unknown = input();
    (unknown as any).providerHealth = null;
    assert.equal(evaluatePaperSimulationGates(unknown).failedGate, 'provider_ready');
  });

  test('SL/TP must bracket the actual fill price', () => {
    const pastStop = input();
    pastStop.fillPrice = 1.094; // price gapped through the long stop
    assert.equal(evaluatePaperSimulationGates(pastStop).failedGate, 'valid_stop_loss');

    const pastTarget = input();
    pastTarget.fillPrice = 1.111;
    assert.equal(evaluatePaperSimulationGates(pastTarget).failedGate, 'valid_take_profit');
  });

  test('RR is judged at the fill price and below-minimum RR is refused', () => {
    const thin = input();
    thin.fillPrice = 1.1005; // worse entry for a long ⇒ RR below 2
    const result = evaluatePaperSimulationGates(thin);
    assert.equal(result.passed, false);
    assert.equal(result.failedGate, 'acceptable_rr');
  });

  test('stale market data and missing prices are refused', () => {
    const stale = input();
    stale.marketPrice = { price: 1.1, ageMs: 16 * MIN, thresholdMs: 15 * MIN };
    assert.equal(evaluatePaperSimulationGates(stale).failedGate, 'market_price_fresh');

    const missing = input();
    (missing as any).marketPrice = null;
    assert.equal(evaluatePaperSimulationGates(missing).failedGate, 'market_price_fresh');

    const future = input();
    future.marketPrice = { price: 1.1, ageMs: -1000, thresholdMs: 15 * MIN };
    assert.equal(evaluatePaperSimulationGates(future).failedGate, 'market_price_fresh');

    const nonPositive = input();
    nonPositive.fillPrice = 0;
    nonPositive.marketPrice = { price: 0, ageMs: 0, thresholdMs: 15 * MIN };
    assert.equal(evaluatePaperSimulationGates(nonPositive).failedGate, 'market_price_fresh');
  });

  test('unknown exposure verdict and unknown symbol fail closed', () => {
    const unknownExposure = input();
    (unknownExposure.riskDecision as any).exposureWithinLimits = null;
    assert.equal(evaluatePaperSimulationGates(unknownExposure).failedGate, 'exposure_limits');

    const unknownSymbol = input();
    (unknownSymbol as any).instrumentSpec = null;
    assert.equal(evaluatePaperSimulationGates(unknownSymbol).failedGate, 'valid_position_size');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. market price source                                                      */
/* -------------------------------------------------------------------------- */

describe('M8.3 simulator market price source', () => {
  test('a missing candle is refused, never guessed', async () => {
    const result = await market.latestPrice({
      instrumentId: randomUUID(),
      timeframe: '5m',
      nowMs: T0,
    });
    assert.equal(result.ok, false);
  });

  test('non-positive / inverted candle data is rejected as invalid', async () => {
    const instrument = await pool.query<{ id: string }>(
      `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'`,
    );
    const instrumentId = instrument.rows[0]!.id;
    const fakePool = {
      query: async () => ({
        rows: [
          {
            ts: String(T0),
            open: '1.1',
            high: '0',
            low: '1.0',
            close: '1.1',
          },
        ],
      }),
    } as any;
    const source: SimulatorMarketPriceSource = new CandleStoreMarketPriceSource(fakePool);
    const result = await source.latestPrice({ instrumentId, timeframe: '5m', nowMs: T0 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.invalidData, true);
  });

  test('stale candles are refused with the existing M7.5 policy', async () => {
    const instrument = await pool.query<{ id: string }>(
      `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'`,
    );
    const instrumentId = instrument.rows[0]!.id;
    await insertCandle(instrumentId, T0 - 20 * FIVE_MIN, { open: 1.1, high: 1.1, low: 1.1, close: 1.1 });
    const result = await market.latestPrice({
      instrumentId,
      timeframe: '5m',
      nowMs: T0 + 20 * FIVE_MIN,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.stale, true);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. simulator end-to-end                                                     */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper simulator — entries', () => {
  test('a valid long (BUY) paper order fills, opens a position and records everything', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);

    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });

    assert.equal(result.simulated, true, result.reason ?? '');
    assert.equal(result.replayed, false);
    assert.equal(result.simulatorVersion, PAPER_SIMULATOR_VERSION);
    assert.equal(result.automationOff, true);
    assert.equal(result.automatedPathGate, 'entitlement');
    assert.equal(result.riskEngineVersion, RISK_ENGINE_VERSION);
    const order = result.order!;
    assert.equal(order.side, 'buy');
    assert.equal(order.status, 'filled');
    assert.equal(order.orderType, 'market');
    assert.equal(order.simulated, true);
    assert.equal(order.filledQuantity, order.quantity);
    assert.equal(order.averageFillPrice, 1.1);
    assert.equal(order.quantity, 0.1); // 0.5% of 10k equity at a 50-pip stop
    assert.equal(order.stopLossPrice, 1.095);
    assert.equal(order.takeProfitPrice, 1.11);
    assert.ok(order.riskDecisionId);
    assert.equal(order.setupId, setup.setupId);

    const position = result.position!;
    assert.equal(position.direction, 'long');
    assert.equal(position.status, 'open');
    assert.equal(position.quantity, 0.1);
    assert.equal(position.averageEntryPrice, 1.1);
    assert.equal(position.realizedPl, null);
    assert.equal(position.exitPrice, null);
    assert.equal(position.simulated, true);
    assert.equal(position.markPrice, 1.1);

    assert.equal(result.fills.length, 1);
    assert.equal(result.fills[0]!.fillType, 'entry');
    assert.equal(result.fills[0]!.quantity, 0.1);
    assert.equal(result.fills[0]!.price, 1.1);
    assert.equal(result.fills[0]!.idempotencyKey.length, 64);

    // Deterministic, ordered lifecycle events.
    const eventRows = await pool.query<{ event: string; from_status: string | null; to_status: string | null }>(
      `SELECT event, from_status, to_status FROM execution_events WHERE order_id = $1 ORDER BY id ASC`,
      [order.id],
    );
    const events = eventRows.rows.map((r) => r.event);
    for (const expected of ['order_validating', 'order_submitted', 'order_accepted', 'order_filled', 'position_opened']) {
      assert.ok(events.includes(expected), `missing event ${expected}`);
    }
    assert.ok(events.includes('reconciliation_passed'));

    // Platform audit trail.
    const auditRows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE user_id = $1 AND action = 'execution.paper_simulated'`,
      [user.id],
    );
    assert.equal(Number(auditRows.rows[0]!.n), 1);

    // No credential-shaped field is ever stored on an execution row.
    const serialized = JSON.stringify(result).toLowerCase();
    for (const needle of ['password', 'api_key', 'apikey', 'secret', 'token']) {
      assert.ok(!serialized.includes(needle), `must not contain ${needle}`);
    }
  });

  test('a valid short (SELL) paper order mirrors the levels', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id, { direction: 'short' });
    await seedEntryPrice(setup.instrumentId);

    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, true, result.reason ?? '');
    assert.equal(result.order!.side, 'sell');
    assert.equal(result.position!.direction, 'short');
    assert.equal(result.position!.stopLossPrice, 1.105);
    assert.equal(result.position!.takeProfitPrice, 1.09);
  });

  test('the automated (M8.1) path still cannot create an order: automation is OFF', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const decision = buildServerExecutionDecision({
      setupId: setup.setupId,
      strategyId: setup.strategyId,
      strategyVersionId: setup.versionId,
      assetClass: 'forex',
      symbol: 'EURUSD',
      direction: 'long',
      state: 'confirmed',
      asOfMs: T0 - anchorCounter,
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      tp1Price: 1.11,
      qualityScore: 80,
      minQualityScore: 60,
      timeframe: '5m',
    });
    assert.equal(decision.ok, true);
    const intakeResult = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profileId,
      decision: decision.ok ? decision.decision : {},
    });
    assert.equal(intakeResult.accepted, false);
    assert.ok(['entitlement', 'automation_on'].includes(intakeResult.gate.failedGate ?? ''));
    // Risk approval is NOT permission to execute.
    assert.equal(
      await countRows(
        `SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1`,
        [user.id],
      ),
      0,
    );
    const status = await automation.getStatus(user.id);
    assert.equal(status.effective, false);
    assert.equal(status.entitled, false);
  });
});

describe('M8.3 paper simulator — risk integration', () => {
  test('an approved server-issued risk decision is required and consumed', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);

    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, true);
    const decision = await pool.query<{ outcome: string; engine_version: string; position_size: string }>(
      'SELECT outcome, engine_version, position_size FROM risk_decisions WHERE id = $1',
      [result.riskDecisionId],
    );
    assert.equal(decision.rows[0]!.outcome, 'approved');
    assert.equal(decision.rows[0]!.engine_version, RISK_ENGINE_VERSION);
    assert.equal(Number(decision.rows[0]!.position_size), 0.1);
  });

  test('a risk rejection prevents the paper order (no order, no position)', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    await risk.updatePolicy(user.id, { enabled: false });

    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, false);
    assert.equal(result.gate, 'risk_approved');
    assert.equal(result.order, null);
    assert.equal(result.position, null);
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [user.id]),
      0,
    );
    const events = await pool.query<{ event: string }>(
      `SELECT event FROM execution_events WHERE user_id = $1 ORDER BY id ASC`,
      [user.id],
    );
    assert.ok(events.rows.some((r) => r.event === 'paper_execution_rejected'));
  });

  test('exposure limits from the risk engine are respected', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    await risk.updatePolicy(user.id, { maxSimultaneousPositions: 1 });
    const first = await makeSetup(user.id);
    await seedEntryPrice(first.instrumentId);
    const ok = await paper.simulate({
      userId: user.id,
      setupId: first.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(ok.simulated, true);

    const second = await makeSetup(user.id);
    const blocked = await paper.simulate({
      userId: user.id,
      setupId: second.setupId,
      executionProfileId: profileId,
      nowMs: T0 + MIN,
    });
    assert.equal(blocked.simulated, false);
    assert.equal(blocked.gate, 'risk_approved');
  });

  test('an invalid or forged risk decision id fails closed', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);

    await assert.rejects(
      () =>
        paper.simulate({
          userId: user.id,
          setupId: setup.setupId,
          executionProfileId: profileId,
          riskDecisionId: randomUUID(),
          nowMs: T0,
        }),
      (err: any) => err.code === 'not_found',
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [user.id]),
      0,
    );
    assert.equal(
      await countRows(
        `SELECT count(*)::text AS n FROM execution_events WHERE user_id = $1 AND event = 'paper_execution_rejected'`,
        [user.id],
      ),
      1,
    );
  });

  test("another user's risk decision cannot be cited (masked)", async () => {
    const owner = await makeUser();
    const ownerProfile = await makeProfile(owner.id);
    const ownerSetup = await makeSetup(owner.id);
    await seedEntryPrice(ownerSetup.instrumentId);
    const ownerRun = await paper.simulate({
      userId: owner.id,
      setupId: ownerSetup.setupId,
      executionProfileId: ownerProfile,
      nowMs: T0,
    });
    assert.equal(ownerRun.simulated, true);

    const intruder = await makeUser();
    const intruderProfile = await makeProfile(intruder.id);
    const intruderSetup = await makeSetup(intruder.id);
    await seedEntryPrice(intruderSetup.instrumentId);
    await assert.rejects(
      () =>
        paper.simulate({
          userId: intruder.id,
          setupId: intruderSetup.setupId,
          executionProfileId: intruderProfile,
          riskDecisionId: ownerRun.riskDecisionId,
          nowMs: T0,
        }),
      (err: any) => err.code === 'not_found',
    );
  });

  test('a cited decision with an unrecognized engine version fails closed', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);

    // A row that LOOKS like an approval but was not issued by this engine.
    const instrument = await pool.query<{ id: string }>(
      `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'`,
    );
    const forged = await pool.query<{ id: string }>(
      `INSERT INTO risk_decisions
         (user_id, execution_profile_id, setup_id, strategy_id, outcome, reason, position_size,
          entry_price, stop_loss_price, take_profit_price, rr, current_exposure, projected_exposure,
          policy_version, engine_version)
       VALUES ($1,$2,$3,$4,'approved','forged',0.1,1.1,1.095,1.11,2,$5,$5,1,'m9-forged-engine')
       RETURNING id`,
      [
        user.id,
        profileId,
        setup.setupId,
        setup.strategyId,
        JSON.stringify({ openPositions: 0, reservedPositions: 0, totalOpenRisk: 0, instrumentOpenRisk: 0, directionOpenRisk: 0 }),
      ],
    );
    void instrument;

    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      riskDecisionId: forged.rows[0]!.id,
      nowMs: T0,
    });
    assert.equal(result.simulated, false);
    assert.equal(result.gate, 'risk_decision_issued');
    assert.equal(result.order, null);
  });

  test('a cited rejected risk decision fails closed', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    await risk.updatePolicy(user.id, { enabled: false });
    const rejected = await risk.evaluate({
      userId: user.id,
      executionProfileId: profileId,
      decision: {
        strategyId: setup.strategyId,
        strategyVersionId: setup.versionId,
        setupId: setup.setupId,
        action: 'open_long',
        assetClass: 'forex',
        symbol: 'EURUSD',
        timeframe: '5m',
        direction: 'long',
        entryPrice: 1.1,
        stopLossPrice: 1.095,
        takeProfitPrice: 1.11,
        expectedRr: 2,
        qualityScore: 80,
        minQualityScore: 60,
        asOfMs: T0 - anchorCounter,
      },
      nowMs: T0,
    });
    assert.equal(rejected.outcome, 'rejected');

    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      riskDecisionId: rejected.id,
      nowMs: T0,
    });
    assert.equal(result.simulated, false);
    assert.ok(['risk_approved', 'risk_decision_issued'].includes(result.gate ?? ''));
    assert.equal(result.order, null);
  });
});

describe('M8.3 paper simulator — exits and P&L', () => {
  async function openPosition(opts: { direction: 'long' | 'short' } = { direction: 'long' }) {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id, { direction: opts.direction });
    await seedEntryPrice(setup.instrumentId);
    const simulated = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(simulated.simulated, true, simulated.reason ?? '');
    return { user, profileId, setup, position: simulated.position!, order: simulated.order! };
  }

  test('long take-profit closes with the exact realized P&L', async () => {
    const { user, setup, position } = await openPosition();
    await insertCandle(setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.105,
      high: 1.112,
      low: 1.104,
      close: 1.111,
    });
    const outcome = await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(outcome.closed, 1);
    assert.equal(outcome.outcomes[0]!.exitReason, 'take_profit');
    assert.equal(outcome.outcomes[0]!.realizedPl, 100);
    assert.equal(outcome.outcomes[0]!.fills.length, 1);
    assert.equal(outcome.outcomes[0]!.fills[0]!.fillType, 'take_profit');
    assert.equal(outcome.outcomes[0]!.fills[0]!.price, 1.11);

    const row = await pool.query<{ status: string; exit_price: string; realized_pl: string; unrealized_pl: string }>(
      'SELECT status, exit_price, realized_pl, unrealized_pl FROM execution_positions WHERE id = $1',
      [position.id],
    );
    assert.equal(row.rows[0]!.status, 'closed');
    assert.equal(Number(row.rows[0]!.exit_price), 1.11);
    assert.equal(Number(row.rows[0]!.realized_pl), 100);
    assert.equal(Number(row.rows[0]!.unrealized_pl), 0);

    // Simulated P&L feeds the server-owned risk account snapshot.
    const account = await pool.query<{ daily_realized_pl: string; consecutive_losses: number }>(
      'SELECT daily_realized_pl, consecutive_losses FROM risk_account_states WHERE execution_profile_id = $1',
      [position.executionProfileId],
    );
    assert.equal(Number(account.rows[0]!.daily_realized_pl), 100);
    assert.equal(account.rows[0]!.consecutive_losses, 0);
  });

  test('long stop-loss closes at the stop with the exact realized P&L', async () => {
    const { user, setup, position } = await openPosition();
    await insertCandle(setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.1,
      high: 1.101,
      low: 1.092,
      close: 1.094,
    });
    const outcome = await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(outcome.outcomes[0]!.exitReason, 'stop_loss');
    assert.equal(outcome.outcomes[0]!.realizedPl, -50);
    const account = await pool.query<{ daily_realized_pl: string; consecutive_losses: number }>(
      'SELECT daily_realized_pl, consecutive_losses FROM risk_account_states WHERE execution_profile_id = $1',
      [position.executionProfileId],
    );
    assert.equal(Number(account.rows[0]!.daily_realized_pl), -50);
    assert.equal(account.rows[0]!.consecutive_losses, 1);
  });

  test('short take-profit and short stop-loss are correct', async () => {
    const tp = await openPosition({ direction: 'short' });
    await insertCandle(tp.setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.098,
      high: 1.099,
      low: 1.088,
      close: 1.089,
    });
    const tpOutcome = await paper.evaluateOpenPositions({ userId: tp.user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(tpOutcome.outcomes[0]!.exitReason, 'take_profit');
    assert.equal(tpOutcome.outcomes[0]!.realizedPl, 100);

    const sl = await openPosition({ direction: 'short' });
    await insertCandle(sl.setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.1,
      high: 1.107,
      low: 1.099,
      close: 1.106,
    });
    const slOutcome = await paper.evaluateOpenPositions({ userId: sl.user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(slOutcome.outcomes[0]!.exitReason, 'stop_loss');
    assert.equal(slOutcome.outcomes[0]!.realizedPl, -50);
  });

  test('an ambiguous bar touching SL and TP is resolved conservatively at the stop', async () => {
    const { user, setup } = await openPosition();
    await insertCandle(setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.1,
      high: 1.113,
      low: 1.093,
      close: 1.112,
    });
    const outcome = await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(outcome.outcomes[0]!.exitReason, 'stop_loss');
    assert.equal(outcome.outcomes[0]!.realizedPl, -50);
    const conflict = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM execution_events
        WHERE user_id = $1 AND event = 'paper_sl_tp_conflict'`,
      [user.id],
    );
    assert.equal(Number(conflict.rows[0]!.n), 1);
  });

  test('unrealized P&L is marked from server market data without closing', async () => {
    const { user, setup, position } = await openPosition();
    await insertCandle(setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.102,
      high: 1.106,
      low: 1.101,
      close: 1.105,
    });
    const outcome = await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(outcome.closed, 0);
    assert.equal(outcome.outcomes[0]!.markPrice, 1.105);
    const marked = await paper.listPositions(user.id, 10);
    const open = marked.positions.find((p) => p.id === position.id)!;
    assert.equal(open.status, 'open');
    assert.equal(open.unrealizedPl, 50); // (1.105 − 1.100) × 0.1 × 100_000
    assert.equal(open.realizedPl, null);
    assert.equal(open.markPrice, 1.105);
  });

  test('a position can be closed explicitly at the server price', async () => {
    const { user, setup, position } = await openPosition();
    await insertCandle(setup.instrumentId, T0 + 2 * FIVE_MIN, {
      open: 1.103,
      high: 1.104,
      low: 1.102,
      close: 1.103,
    });
    const outcome = await paper.closePosition({
      userId: user.id,
      positionId: position.id,
      nowMs: T0 + 2 * FIVE_MIN,
    });
    assert.equal(outcome.exitReason, 'close');
    assert.equal(outcome.realizedPl, 30); // (1.103 − 1.100) × 10_000
    const closed = await pool.query<{ status: string; exit_reason: string; closed_by_order_id: string }>(
      'SELECT status, exit_reason, closed_by_order_id FROM execution_positions WHERE id = $1',
      [position.id],
    );
    assert.equal(closed.rows[0]!.status, 'closed');
    assert.equal(closed.rows[0]!.exit_reason, 'close');
    assert.ok(closed.rows[0]!.closed_by_order_id);
    // Closing twice is refused, never double-booked.
    await assert.rejects(
      () => paper.closePosition({ userId: user.id, positionId: position.id, nowMs: T0 + 2 * FIVE_MIN }),
      (err: any) => err.code === 'invalid_input',
    );
  });

  test('fees and slippage are applied deterministically when configured', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    let costedService: PaperExecutionService;
    const costedRegistry = createExecutionProviderRegistry();
    costedRegistry.register(
      createPaperExecutionProvider({
        simulator: { submitAuthorizedOrder: (args) => costedService.submitAuthorizedOrder(args) },
      }),
    );
    const costed = (costedService = new PaperExecutionService(
      pool,
      { market, risk, killSwitches, automation, audit, provider: () => costedRegistry.get('paper') },
      { ...serviceOptions, costs: { entrySlippagePips: 1, exitSlippagePips: 0, feePipsPerSide: 1 } },
    ));
    const result = await costed.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, true, result.reason ?? '');
    // Entry filled one pip worse: 1.1001, one pip of commission.
    assert.equal(result.order!.averageFillPrice, 1.1001);
    assert.equal(result.order!.fees, 1); // 1 pip × 0.1 lot × 100k = 10 USD? no: 0.0001×10_000 = 1
    assert.equal(result.fills[0]!.slippage, 1);

    await insertCandle(setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.105,
      high: 1.113,
      low: 1.104,
      close: 1.112,
    });
    const closed = await costed.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    // Entry 1.1001 → TP 1.11: (1.11 − 1.1001) × 10_000 = 99 − 2 pips fees = 97.
    assert.equal(closed.outcomes[0]!.exitReason, 'take_profit');
    assert.equal(closed.outcomes[0]!.realizedPl, 97);
    const row = await pool.query<{ fees: string; slippage: string }>(
      'SELECT fees, slippage FROM execution_positions WHERE opened_by_order_id = $1',
      [result.order!.id],
    );
    assert.equal(Number(row.rows[0]!.fees), 2);
    assert.equal(Number(row.rows[0]!.slippage), 1);
  });
});

describe('M8.3 paper simulator — idempotency and failure paths', () => {
  test('duplicate submission replays instead of creating a second order/position', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);

    const first = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    const second = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0 + MIN,
    });
    assert.equal(first.simulated, true);
    assert.equal(second.replayed, true);
    assert.equal(second.order!.id, first.order!.id);
    assert.equal(second.position!.id, first.position!.id);
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [user.id]),
      1,
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_positions WHERE user_id = $1', [user.id]),
      1,
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_fills WHERE user_id = $1', [user.id]),
      1,
    );
  });

  test('concurrent duplicate submissions collapse onto one order (unique identity)', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        paper.simulate({
          userId: user.id,
          setupId: setup.setupId,
          executionProfileId: profileId,
          nowMs: T0,
        }),
      ),
    );
    assert.ok(results.some((r) => r.simulated));
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [user.id]),
      1,
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_positions WHERE user_id = $1', [user.id]),
      1,
    );
  });

  test('repeated fill processing cannot duplicate a fill or a position', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const first = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(first.simulated, true);
    const order = first.order!;

    // Re-drive the SAME provider submit with the same server authorization
    // shape: an authorization is single-use, so an unauthorized retry is
    // refused outright and writes nothing.
    await assert.rejects(
      () =>
        paper.submitAuthorizedOrder({
          authorizationId: randomUUID(),
          request: {
            clientOrderId: order.clientOrderId,
            idempotencyKey: order.idempotencyKey,
            authorizationId: randomUUID(),
            assetClass: 'forex',
            symbol: 'EURUSD',
            side: 'buy',
            orderType: 'market',
            quantity: order.quantity,
            requestedPrice: null,
            stopLossPrice: 1.095,
            takeProfitPrice: 1.11,
          },
        }),
      (err: any) => err.name === 'ExecutionProviderError',
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_fills WHERE user_id = $1', [user.id]),
      1,
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_positions WHERE user_id = $1', [user.id]),
      1,
    );
  });

  test('repeated SL/TP processing is a no-op (one exit order, one fill, one P&L swing)', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const opened = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(opened.simulated, true);
    await insertCandle(setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.105,
      high: 1.112,
      low: 1.104,
      close: 1.111,
    });
    const first = await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(first.closed, 1);
    const second = await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(second.evaluated, 0);

    assert.equal(
      await countRows(
        `SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1 AND status = 'filled'`,
        [user.id],
      ),
      2, // entry + single exit
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_fills WHERE user_id = $1', [user.id]),
      2,
    );
    const row = await pool.query<{ realized_pl: string }>(
      'SELECT realized_pl FROM execution_positions WHERE user_id = $1',
      [user.id],
    );
    assert.equal(Number(row.rows[0]!.realized_pl), 100);
  });

  test('a simulated fill failure is auditable and a retry creates no duplicate position', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);

    const failingServiceRef = (): PaperExecutionService => failingService;
    const failingRegistry = createExecutionProviderRegistry();
    const failingProvider = createPaperExecutionProvider({
      simulator: { submitAuthorizedOrder: (args) => failingServiceRef().submitAuthorizedOrder(args) },
    });
    failingRegistry.register(failingProvider);
    const failingService = new PaperExecutionService(
      pool,
      {
        market,
        risk,
        killSwitches,
        automation,
        audit,
        provider: () => failingRegistry.get('paper'),
      },
      { ...serviceOptions, failureMode: { fillFailure: true } },
    );

    const failed = await failingService.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(failed.simulated, false);
    assert.ok(failed.reason);
    assert.equal(
      await countRows(
        `SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1 AND status = 'failed'`,
        [user.id],
      ),
      1,
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_fills WHERE user_id = $1', [user.id]),
      0,
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_positions WHERE user_id = $1', [user.id]),
      0,
    );
    const failureEvents = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM execution_events WHERE user_id = $1 AND event = 'order_failed'`,
      [user.id],
    );
    assert.equal(Number(failureEvents.rows[0]!.n), 1);

    // Retry with the healthy simulator succeeds, still with ONE position.
    const retried = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0 + MIN,
    });
    assert.equal(retried.simulated, true, retried.reason ?? '');
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_positions WHERE user_id = $1', [user.id]),
      1,
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [user.id]),
      2, // the failed attempt + the successful retry, both auditable
    );
  });

  test('a deterministic order rejection is recorded and never fabricates a fill', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const rejectingServiceRef = (): PaperExecutionService => rejectingService;
    const rejectingRegistry = createExecutionProviderRegistry();
    const rejectingProvider = createPaperExecutionProvider({
      simulator: { submitAuthorizedOrder: (args) => rejectingServiceRef().submitAuthorizedOrder(args) },
    });
    rejectingRegistry.register(rejectingProvider);
    const rejectingService = new PaperExecutionService(
      pool,
      { market, risk, killSwitches, automation, audit, provider: () => rejectingRegistry.get('paper') },
      { ...serviceOptions, failureMode: { orderRejection: true } },
    );
    const result = await rejectingService.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, false);
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_fills WHERE user_id = $1', [user.id]),
      0,
    );
  });
});

describe('M8.3 paper simulator — kill switch and market-data failures', () => {
  test('an active user kill switch blocks the simulation', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    await killSwitches.set('user', { targetId: user.id, active: true, reason: 'test' });
    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, false);
    assert.equal(result.gate, 'kill_switch');
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [user.id]),
      0,
    );
  });

  test('a global kill switch blocks the simulation', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    await killSwitches.set('global', { active: true, reason: 'platform stop' });
    try {
      const result = await paper.simulate({
        userId: user.id,
        setupId: setup.setupId,
        executionProfileId: profileId,
        nowMs: T0,
      });
      assert.equal(result.gate, 'kill_switch');
    } finally {
      await killSwitches.set('global', { active: false, reason: 'test cleanup' });
    }
  });

  test('missing market data fails closed (no order from an invented price)', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    // GBPUSD never receives candles in this suite.
    const setup = await makeSetup(user.id, { symbol: 'GBPUSD' }); // no candle seeded
    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, false, result.reason ?? '');
    assert.equal(result.gate, 'market_price_fresh', result.reason ?? '');
    assert.equal(result.order, null);
  });

  test('stale market data fails closed', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id, { symbol: 'GBPUSD' });
    await insertCandle(setup.instrumentId, T0 - 3 * 60 * MIN, {
      open: 1.1,
      high: 1.1,
      low: 1.1,
      close: 1.1,
    });
    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, false, result.reason ?? '');
    assert.equal(result.gate, 'market_price_fresh', result.reason ?? '');
    assert.match(result.reason ?? '', /stale/);
  });

  test('invalid stop loss / take profit setups are refused', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const brokenStop = await makeSetup(user.id, { entry: 1.1, stop: 1.12, tp: 1.11 }); // inverted
    await seedEntryPrice(brokenStop.instrumentId);
    const stopResult = await paper.simulate({
      userId: user.id,
      setupId: brokenStop.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(stopResult.simulated, false);
    assert.equal(stopResult.gate, 'valid_order_params');

    const noTarget = await makeSetup(user.id, { entry: 1.1, stop: 1.095, tp: null });
    const targetResult = await paper.simulate({
      userId: user.id,
      setupId: noTarget.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(targetResult.simulated, false);
    assert.equal(targetResult.gate, 'valid_order_params');

    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [user.id]),
      0,
    );
  });

  test('a disabled execution profile is refused', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    await pool.query('UPDATE execution_profiles SET enabled = false WHERE id = $1', [profileId]);
    const result = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(result.simulated, false);
    assert.equal(result.gate, 'paper_profile');
  });

  test('a position whose opening order is gone is reported, never guessed', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const opened = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(opened.simulated, true);
    // Simulate an inconsistent state: the position loses its opening order.
    await pool.query('UPDATE execution_positions SET opened_by_order_id = NULL WHERE id = $1', [
      opened.position!.id,
    ]);
    const outcome = await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });
    assert.equal(outcome.evaluated, 0); // fail closed, not "best effort"
    const finding = await pool.query<{ findings: string[] }>(
      `SELECT findings FROM execution_reconciliations
        WHERE position_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [opened.position!.id],
    );
    assert.ok(finding.rows[0]!.findings.includes('position_metadata_missing'));
  });
});

describe('M8.3 paper simulator — isolation and audit', () => {
  test('simulating a foreign setup is a masked 404 and writes nothing', async () => {
    const owner = await makeUser();
    const ownerProfile = await makeProfile(owner.id);
    const ownerSetup = await makeSetup(owner.id);
    await seedEntryPrice(ownerSetup.instrumentId);

    const intruder = await makeUser();
    const intruderProfile = await makeProfile(intruder.id);
    await assert.rejects(
      () =>
        paper.simulate({
          userId: intruder.id,
          setupId: ownerSetup.setupId,
          executionProfileId: intruderProfile,
          nowMs: T0,
        }),
      (err: any) => err.code === 'not_found',
    );
    await assert.rejects(
      () =>
        paper.simulate({
          userId: intruder.id,
          setupId: ownerSetup.setupId,
          executionProfileId: ownerProfile,
          nowMs: T0,
        }),
      (err: any) => err.code === 'not_found',
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM execution_orders WHERE user_id = $1', [intruder.id]),
      0,
    );
  });

  test('every read model is owner-scoped', async () => {
    const a = await makeUser();
    const aProfile = await makeProfile(a.id);
    const aSetup = await makeSetup(a.id);
    await seedEntryPrice(aSetup.instrumentId);
    const opened = await paper.simulate({
      userId: a.id,
      setupId: aSetup.setupId,
      executionProfileId: aProfile,
      nowMs: T0,
    });
    assert.equal(opened.simulated, true);

    const b = await makeUser();
    for (const list of [
      await paper.listOrders(b.id, 50),
      (await paper.listPositions(b.id, 50)) as unknown as { orders: unknown[] },
      (await paper.listFills(b.id, 50)) as unknown as { orders: unknown[] },
      (await paper.listReconciliations(b.id, 50)) as unknown as { orders: unknown[] },
    ] as unknown as { orders?: unknown[]; positions?: unknown[]; fills?: unknown[]; reconciliations?: unknown[] }[]) {
      const rows = list.orders ?? list.positions ?? list.fills ?? list.reconciliations ?? [];
      assert.equal(rows.length, 0);
    }
    const status = await paper.status(b.id);
    assert.equal(status.orders, 0);
    assert.equal(status.openPositions, 0);
    assert.equal(status.closedPl, 0);
  });

  test('status surfaces automation OFF, the paper provider and live execution impossibility', async () => {
    const user = await makeUser();
    const status = await paper.status(user.id);
    assert.equal(status.simulatorVersion, PAPER_SIMULATOR_VERSION);
    assert.equal(status.riskEngineVersion, RISK_ENGINE_VERSION);
    assert.equal(status.providerId, 'paper');
    assert.equal(status.providerConfigured, true);
    assert.equal(status.providerHealthy, true);
    assert.equal(status.automationOff, true);
    assert.equal(status.automatedPathGate, 'entitlement');
    assert.equal(status.liveExecutionAvailable, false);
    assert.ok(status.automationReasons.includes('entitlement_not_granted'));
  });

  test('the provider refuses unauthorized submits and cannot place a broker order', async () => {
    const provider = registry.get('paper')!;
    assert.equal(provider.configured, true);
    assert.equal((await provider.health()).healthy, true);
    assert.equal(provider.describe().internal, true);

    await assert.rejects(
      () =>
        provider.submitOrder({
          clientOrderId: 've-forged',
          idempotencyKey: 'f'.repeat(64),
          assetClass: 'forex',
          symbol: 'EURUSD',
          side: 'buy',
          orderType: 'market',
          quantity: 0.1,
          requestedPrice: null,
          stopLossPrice: 1.095,
          takeProfitPrice: 1.11,
        }),
      (err: any) => err.name === 'ExecutionProviderError' && err.category === 'validation',
    );
    await assert.rejects(() => provider.cancelOrder('x'), (err: any) => err.category === 'unavailable');
    await assert.rejects(() => provider.modifyOrder('x', {}), (err: any) => err.category === 'unavailable');
    await assert.rejects(() => provider.closePosition('x'), (err: any) => err.category === 'unavailable');
  });
});

describe('M8.3 reconciliation', () => {
  test('consistent simulated state reconciles clean and records the trail', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const opened = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(opened.simulated, true);
    const result = await paper.reconcile({ userId: user.id, nowMs: T0 + MIN });
    assert.equal(result.ok, true, JSON.stringify(result.findings));
    const list = await paper.listReconciliations(user.id, 20);
    assert.ok(list.reconciliations.length >= 2);
    assert.ok(list.reconciliations.every((r) => r.outcome === 'ok'));
    assert.equal(list.reconciliations[0]!.simulatorVersion, PAPER_SIMULATOR_VERSION);
  });

  test('impossible order state is DETECTED and never silently corrected', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const opened = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(opened.simulated, true);
    const orderId = opened.order!.id;

    // Tamper: a filled order carrying a non-terminal status while still
    // holding fills (impossible in a correct simulator).
    await pool.query(`UPDATE execution_orders SET status = 'accepted' WHERE id = $1`, [orderId]);

    const result = await paper.reconcile({ userId: user.id, nowMs: T0 + MIN });
    assert.equal(result.ok, false);
    assert.ok(result.findings.includes('order_fill_quantity_mismatch'));

    // No silent correction: the row is untouched and the finding is recorded.
    const row = await pool.query<{ status: string; filled_quantity: string }>(
      'SELECT status, filled_quantity FROM execution_orders WHERE id = $1',
      [orderId],
    );
    assert.equal(row.rows[0]!.status, 'accepted');
    assert.equal(Number(row.rows[0]!.filled_quantity), 0.1);
    const mismatch = await pool.query<{ n: string; findings: string[] }>(
      `SELECT count(*)::text AS n FROM execution_reconciliations
        WHERE user_id = $1 AND outcome = 'mismatch'`,
      [user.id],
    );
    assert.ok(Number(mismatch.rows[0]!.n) >= 1);
    const events = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM execution_events
        WHERE user_id = $1 AND event = 'reconciliation_mismatch'`,
      [user.id],
    );
    assert.ok(Number(events.rows[0]!.n) >= 1);
  });

  test('impossible position state (fabricated realized P&L) is detected', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const opened = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(opened.simulated, true);
    await insertCandle(setup.instrumentId, T0 + FIVE_MIN, {
      open: 1.105,
      high: 1.112,
      low: 1.104,
      close: 1.111,
    });
    await paper.evaluateOpenPositions({ userId: user.id, nowMs: T0 + FIVE_MIN });

    // Tamper: claim a completely different realized P&L.
    await pool.query('UPDATE execution_positions SET realized_pl = 9999 WHERE id = $1', [
      opened.position!.id,
    ]);
    const result = await paper.reconcile({ userId: user.id, nowMs: T0 + 2 * FIVE_MIN });
    assert.equal(result.ok, false);
    assert.ok(result.findings.includes('position_realized_pl_mismatch'));
    const row = await pool.query<{ realized_pl: string }>(
      'SELECT realized_pl FROM execution_positions WHERE id = $1',
      [opened.position!.id],
    );
    assert.equal(Number(row.rows[0]!.realized_pl), 9999); // never auto-corrected
  });
});

describe('M8.3 migration 0018', () => {
  test('applies additively as the 18th migration', async () => {
    const status = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migrations`,
    );
    assert.equal(Number(status.rows[0]!.n), 18);
    const applied = await pool.query<{ name: string }>(
      `SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`,
    );
    assert.equal(applied.rows[0]!.name, '0018_paper_execution.sql');
  });

  test('the fill ledger is append-only and exactly-once', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const opened = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    const fill = (await paper.listFills(user.id, 5)).fills[0]!;
    assert.equal(opened.simulated, true);

    await assert.rejects(
      () => pool.query('UPDATE execution_fills SET price = 9 WHERE id = $1', [fill.id]),
      (err: unknown) => (err as { code?: string }).code === '55000',
    );
    await assert.rejects(
      () => pool.query('DELETE FROM execution_fills WHERE id = $1', [fill.id]),
      (err: unknown) => (err as { code?: string }).code === '55000',
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO execution_fills
             (user_id, execution_profile_id, order_id, sequence, fill_type, quantity, price, idempotency_key)
           VALUES ($1,$2,$3,1,'entry',0.1,1.1,$4)`,
          [user.id, profileId, opened.order!.id, 'a'.repeat(64)],
        ),
      (err: unknown) => (err as { code?: string }).code === '23505',
    );
  });

  test('impossible position states are refused by CHECK constraints', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    const opened = await paper.simulate({
      userId: user.id,
      setupId: setup.setupId,
      executionProfileId: profileId,
      nowMs: T0,
    });
    assert.equal(opened.simulated, true);
    const positionId = opened.position!.id;

    // An open position may not carry exit data.
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE execution_positions SET exit_price = 1.11, exit_reason = 'take_profit' WHERE id = $1`,
          [positionId],
        ),
      (err: unknown) => (err as { code?: string }).code === '23514',
    );
    // A closed position must carry an exit price.
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE execution_positions SET status = 'closed', closed_at = now() WHERE id = $1`,
          [positionId],
        ),
      (err: unknown) => (err as { code?: string }).code === '23514',
    );
    // An unknown exit reason is refused.
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE execution_positions
              SET status = 'closed', closed_at = now(), exit_price = 1.1, exit_reason = 'liquidation'
            WHERE id = $1`,
          [positionId],
        ),
      (err: unknown) => (err as { code?: string }).code === '23514',
    );
  });

  test('simulated provenance is enforced: a simulated order carries its decision', async () => {
    const user = await makeUser();
    const profileId = await makeProfile(user.id);
    const setup = await makeSetup(user.id);
    await seedEntryPrice(setup.instrumentId);
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO execution_orders
             (user_id, execution_profile_id, client_order_id, provider_slug, asset_class, symbol,
              side, order_type, quantity, status, idempotency_key, architecture_version, simulated, simulator_version)
           VALUES ($1,$2,'ve-forged-provenance','paper','forex','EURUSD','buy','market',0.1,'requested',
                   $3,'m8.1-execution-arch-1', true, $4)`,
          [user.id, profileId, 'b'.repeat(64), PAPER_SIMULATOR_VERSION],
        ),
      (err: unknown) => (err as { code?: string }).code === '23514',
    );
  });

  test('no execution table stores credentials or broker identifiers', async () => {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('execution_orders','execution_positions','execution_fills',
                             'execution_reconciliations','execution_profiles')
        ORDER BY table_name, column_name`,
    );
    const suspicious = ['password', 'secret', 'token', 'api_key', 'apikey', 'credential', 'login', 'mt5', 'exness'];
    for (const row of columns.rows) {
      for (const needle of suspicious) {
        assert.ok(
          !row.column_name.toLowerCase().includes(needle),
          `${row.table_name}.${row.column_name} looks like a credential field`,
        );
      }
    }
  });
});
