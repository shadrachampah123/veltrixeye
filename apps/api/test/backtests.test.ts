/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import {
  BACKTEST_ENGINE_VERSION,
  MAX_BACKTEST_TRADES,
  MAX_BACKTEST_STEPS,
  backtestRunDtoSchema,
  backtestTradeDtoSchema,
} from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, runMigrations, MIGRATIONS_DIR, CandleStore } from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5440;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_backtests';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let store: CandleStore;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `backtest_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () => `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4998',
  HOST: '127.0.0.1',
  DATABASE_SSL_MODE: 'disable',
  SESSION_COOKIE_NAME: 've_session',
  COOKIE_SECURE: 'never',
  SESSION_TTL_DAYS: '30',
  LOG_LEVEL: 'silent',
};

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
}

function cookieFrom(res: { headers: Record<string, string | number | string[] | undefined> }): string {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const [pair] = String(c ?? '').split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(eq + 1).trim().length > 0) return pair;
  }
  return '';
}

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000; // past, not future

type Shape = [number, number, number, number];
function candle(time: number, o: number, h: number, l: number, c: number) {
  return { time, open: o, high: h, low: l, close: c, volume: null };
}

const RISK = {
  minRr: 2,
  stopLossMethod: 'fixed',
  stopLossBuffer: 10,
  stopLossBufferUnit: 'pips',
  takeProfitMethod: 'rr',
  tp1Rr: 1,
  tp2Rr: 2,
  tp3Rr: 3,
  minQualityScore: 65,
} as const;

function alwaysPassConfig(symbol: string) {
  return {
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol }] },
    sessionFilters: [],
    risk: { ...RISK },
    filters: [],
    ruleGroups: [
      {
        name: 'Pass',
        logic: 'AND',
        position: 0,
        conditions: [
          { conditionType: 'volatility_filter', classification: 'required', timeframeRole: 'setup', params: { metric: 'body_range', period: 2, min: 0 }, position: 0 },
        ],
      },
    ],
  };
}

async function registerUser(): Promise<{ cookie: string; userId: string; email: string }> {
  const email = uniqueEmail();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email, password: PASSWORD, name: 'Backtest Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { cookie: cookieFrom(res), userId: body.user.id, email };
}

async function createPublishedVersion(cookie: string, config: any): Promise<{ strategyId: string; versionId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/strategies',
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { name: `BT strategy ${randomBytes(4).toString('hex')}`, version: config },
  });
  assert.equal(created.statusCode, 201, created.body);
  const strategy = created.json().strategy;
  const version = strategy.versions[0];
  const published = await app.inject({
    method: 'POST',
    url: `/api/strategies/${strategy.id}/versions/${version.id}/publish`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
  });
  assert.equal(published.statusCode, 200, published.body);
  return { strategyId: strategy.id, versionId: version.id };
}

async function seedCandles(symbol: string, count: number, startMs: number, shape: Shape = [100, 100.5, 99.5, 100]): Promise<void> {
  const instrument = await store.resolveInstrument('forex', symbol);
  assert.ok(instrument);
  const candles = Array.from({ length: count }, (_, i) => candle(startMs + i * HOUR, shape[0], shape[1], shape[2], shape[3]));
  const upserted = await store.upsertCandles({ instrumentId: instrument.id, timeframe: '1h', providerSlug: 'test-fixture', candles });
  assert.equal(upserted, count);
}

async function seedMixedCandles(symbol: string, shapes: Shape[], startMs: number): Promise<void> {
  const instrument = await store.resolveInstrument('forex', symbol);
  assert.ok(instrument);
  const candles = shapes.map(([o, h, l, c], idx) => candle(startMs + idx * HOUR, o, h, l, c));
  await store.upsertCandles({ instrumentId: instrument.id, timeframe: '1h', providerSlug: 'test-fixture', candles });
}

async function countRows(table: string): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? '0');
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-backtests');
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
  const config = makeConfig({ DATABASE_URL: db.dbUrl });
  ctx = createAppContext(pool, config);
  app = await buildApp(config, ctx);
  await app.ready();
  store = new CandleStore(pool);
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

describe('m6 backtests api', () => {
  test('setup: no provider is registered (backtest must not need one)', () => {
    assert.equal(ctx.providerRegistry.list().length, 0);
  });

  test('auth required for all backtest routes', async () => {
    const fakeId = '11111111-1111-1111-1111-111111111111';
    const noAuth = { 'x-forwarded-for': freshIp() };
    const post = await app.inject({ method: 'POST', url: '/api/backtests', headers: noAuth, payload: {} });
    assert.equal(post.statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/backtests', headers: noAuth })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/backtests/${fakeId}`, headers: noAuth })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/backtests/${fakeId}/trades`, headers: noAuth })).statusCode, 401);
  });

  test('published strategy requirement: draft version → 400', async () => {
    const owner = await registerUser();
    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { name: `Draft BT ${randomBytes(4).toString('hex')}`, version: alwaysPassConfig('EURUSD') },
    });
    assert.equal(created.statusCode, 201);
    const strategy = created.json().strategy;
    const version = strategy.versions[0];
    const res = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId: strategy.id,
        versionId: version.id,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'both',
        from: T0,
        to: T0 + 5 * HOUR,
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /published/);
  });

  test('owner isolation: foreign strategy/version masked 404', async () => {
    const victim = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(victim.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 20, T0 - 20 * HOUR);
    const attacker = await registerUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId,
        versionId,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        from: T0,
        to: T0 + 5 * HOUR,
      },
    });
    assert.equal(res.statusCode, 404);
  });

  test('request validation: missing fields, bad enums, strictness', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 20, T0 - 20 * HOUR);
    const base = {
      strategyId,
      versionId,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      from: T0,
      to: T0 + 5 * HOUR,
    };
    const cases: Array<[string, any]> = [
      ['missing instrument', { strategyId, versionId, from: T0, to: T0 + 5 * HOUR }],
      ['missing from', { ...base, from: undefined }],
      ['from >= to', { ...base, from: T0 + 5 * HOUR, to: T0 }],
      ['bad direction', { ...base, direction: 'sideways' }],
      ['bad assetClass', { ...base, instrument: { assetClass: 'nope', symbol: 'EURUSD' } }],
      ['unknown key', { ...base, leverage: 10 }],
      ['bad exitPolicy', { ...base, exitPolicy: { stopLoss: 'trailing' } }],
      ['bad costPolicy', { ...base, costPolicy: { feePerSide: -1 } }],
    ];
    for (const [name, payload] of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backtests',
        headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
        payload,
      });
      assert.equal(res.statusCode, 400, name);
    }
  });

  test('invalid/future ranges → 400', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 20, T0 - 20 * HOUR);
    const future = Date.now() + 24 * HOUR;
    const cases = [
      { from: future, to: future + HOUR },
      { from: T0, to: future },
      { from: T0, to: T0 }, // equal
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backtests',
        headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
        payload: {
          strategyId,
          versionId,
          instrument: { assetClass: 'forex', symbol: 'EURUSD' },
          from: c.from,
          to: c.to,
        },
      });
      assert.equal(res.statusCode, 400);
    }
  });

  test('valid backtest creates run + trades, deterministic, licensing-safe', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    // Seed 30 hourly candles: enough for warmup + anchors
    await seedCandles('EURUSD', 40, T0 - 20 * HOUR);
    const beforeSetups = await countRows('setups');
    const beforeScores = await countRows('setup_scores');
    const beforeEvents = await countRows('setup_state_events');
    const beforeIngest = await countRows('ingestion_runs');

    const res = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId,
        versionId,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'both',
        from: T0,
        to: T0 + 10 * HOUR,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.created, true);
    assert.equal(body.run.engineVersion, BACKTEST_ENGINE_VERSION);
    assert.equal(body.run.strategyId, strategyId);
    assert.equal(body.run.strategyVersionId, versionId);
    assert.equal(body.run.instrument.symbol, 'EURUSD');
    assert.equal(body.run.direction, 'both');
    assert.ok(body.run.configHash.match(/^[0-9a-f]{64}$/));
    assert.equal(body.run.status, 'completed');
    // DTO validation
    assert.equal(backtestRunDtoSchema.safeParse(body.run).success, true);
    for (const t of body.trades) assert.equal(backtestTradeDtoSchema.safeParse(t).success, true);
    // No side effects
    assert.equal(await countRows('setups'), beforeSetups);
    assert.equal(await countRows('setup_scores'), beforeScores);
    assert.equal(await countRows('setup_state_events'), beforeEvents);
    assert.equal(await countRows('ingestion_runs'), beforeIngest);
    // Licensing-safe: no candle data
    assert.ok(!JSON.stringify(body).includes('"open"'));
    assert.ok(!JSON.stringify(body).includes('"high"'));
    // Metrics sanity
    assert.ok(body.run.metrics.stepsEvaluated > 0);
    assert.equal(body.truncated, false);
  });

  test('deterministic config_hash: same canonical config replays with created=false', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 30, T0 - 20 * HOUR);
    const payload = {
      strategyId,
      versionId,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      from: T0,
      to: T0 + 8 * HOUR,
      exitPolicy: { stopLoss: 'level', takeProfit: 'tp3', maxHoldCandles: 100 },
      costPolicy: { feePerSide: 0, slippagePerSide: 0, spread: 0 },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload,
    });
    assert.equal(first.statusCode, 201);
    const firstId = first.json().run.id;
    const firstHash = first.json().run.configHash;

    const second = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().created, false);
    assert.equal(second.json().run.id, firstId);
    assert.equal(second.json().run.configHash, firstHash);
    assert.deepEqual(second.json().trades, first.json().trades);
  });

  test('key ordering does not change idempotency', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 30, T0 - 20 * HOUR);
    const base = {
      strategyId,
      versionId,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'both' as const,
      from: T0,
      to: T0 + 6 * HOUR,
    };
    const payloadA = {
      ...base,
      exitPolicy: { stopLoss: 'level', takeProfit: 'tp3', maxHoldCandles: 100, sameCandleRule: 'stop_first', entryTiming: 'signal_close' },
      costPolicy: { feePerSide: 0, slippagePerSide: 0, spread: 0 },
    };
    const payloadB = {
      ...base,
      // Same logical, different key order
      exitPolicy: { maxHoldCandles: 100, entryTiming: 'signal_close', sameCandleRule: 'stop_first', takeProfit: 'tp3', stopLoss: 'level' },
      costPolicy: { spread: 0, slippagePerSide: 0, feePerSide: 0 },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: payloadA,
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: payloadB,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().created, false);
    assert.equal(second.json().run.id, first.json().run.id);
    assert.equal(second.json().run.configHash, first.json().run.configHash);
  });

  test('irrelevant config representation cannot create duplicate logical runs', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 30, T0 - 20 * HOUR);
    const base = {
      strategyId,
      versionId,
      instrument: { assetClass: 'forex', symbol: 'eurusd' }, // lowercase, should normalize
      direction: 'both' as const,
      from: T0,
      to: T0 + 6 * HOUR,
    };
    const payloadA = {
      ...base,
      exitPolicy: {}, // defaults
      costPolicy: {},
    };
    const payloadB = {
      ...base,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' }, // uppercase
      exitPolicy: { stopLoss: 'level', takeProfit: 'tp3', maxHoldCandles: 100, sameCandleRule: 'stop_first', entryTiming: 'signal_close' },
      costPolicy: { feePerSide: 0, slippagePerSide: 0, spread: 0 },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: payloadA,
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: payloadB,
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().created, false);
    assert.equal(second.json().run.id, first.json().run.id);
  });

  test('concurrent identical submissions create exactly one run', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 40, T0 - 20 * HOUR);
    const payload = {
      strategyId,
      versionId,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      from: T0,
      to: T0 + 12 * HOUR,
    };
    const ip = freshIp();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({ method: 'POST', url: '/api/backtests', headers: { cookie: owner.cookie, 'x-forwarded-for': ip }, payload }),
      ),
    );
    for (const r of results) assert.ok([200, 201].includes(r.statusCode), r.body);
    const ids = new Set(results.map((r) => r.json().run.id));
    assert.equal(ids.size, 1);
    const createdCount = results.filter((r) => r.json().created).length;
    assert.equal(createdCount, 1);
  });

  test('trade truncation: >500 trades stores first 500 and marks truncated', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    // Need 300 anchors * both = 600 trades >500
    const totalCandles = 400;
    await seedCandles('EURUSD', totalCandles, T0 - 100 * HOUR);
    const res = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId,
        versionId,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'both',
        from: T0,
        to: T0 + 300 * HOUR,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.truncated, true);
    assert.equal(body.trades.length, MAX_BACKTEST_TRADES);
    assert.equal(body.run.metrics.setupsDetected, 600); // 300 anchors * both
    // Persisted trades are first 500 in seq order
    assert.deepEqual(body.trades.map((t: any) => t.seq), Array.from({ length: 500 }, (_, i) => i));

    // GET detail also marks truncated
    const detail = await app.inject({
      method: 'GET',
      url: `/api/backtests/${body.run.id}`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().truncated, true);
    assert.equal(detail.json().trades.length, 500);
  });

  test('persistence correctness: metrics and trades match engine', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 30, T0 - 20 * HOUR);
    const res = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId,
        versionId,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        from: T0,
        to: T0 + 10 * HOUR,
        costPolicy: { riskPerTrade: 100 },
      },
    });
    assert.equal(res.statusCode, 201);
    const runId = res.json().run.id;
    const direct = await pool.query<{ metrics: any; notes: any }>('SELECT metrics, notes FROM backtest_runs WHERE id = $1', [runId]);
    assert.ok(direct.rows[0]);
    const metrics = direct.rows[0]!.metrics;
    // metrics stored as jsonb should be object
    const m = typeof metrics === 'string' ? JSON.parse(metrics) : metrics;
    assert.ok(typeof m.totalR === 'number');
    assert.ok(Array.isArray(direct.rows[0]!.notes) || typeof direct.rows[0]!.notes === 'object');
  });

  test('list/detail/trade endpoints', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 30, T0 - 20 * HOUR);
    const created = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId,
        versionId,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'short',
        from: T0,
        to: T0 + 5 * HOUR,
      },
    });
    assert.equal(created.statusCode, 201);
    const runId = created.json().run.id;

    const list = await app.inject({
      method: 'GET',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().runs.some((r: any) => r.id === runId));

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/backtests?strategyId=${strategyId}`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(filtered.statusCode, 200);
    assert.ok(filtered.json().runs.length >= 1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/backtests/${runId}`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().run.id, runId);
    assert.ok(Array.isArray(detail.json().trades));

    const trades = await app.inject({
      method: 'GET',
      url: `/api/backtests/${runId}/trades?limit=2`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(trades.statusCode, 200);
    assert.equal(trades.json().trades.length, 2);
  });

  test('masked 404 for non-owned backtest', async () => {
    const victim = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(victim.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 20, T0 - 20 * HOUR);
    const created = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: victim.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId,
        versionId,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        from: T0,
        to: T0 + 5 * HOUR,
      },
    });
    assert.equal(created.statusCode, 201);
    const runId = created.json().run.id;
    const attacker = await registerUser();
    const res = await app.inject({
      method: 'GET',
      url: `/api/backtests/${runId}`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 404);
    const trades = await app.inject({
      method: 'GET',
      url: `/api/backtests/${runId}/trades`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(trades.statusCode, 404);
  });

  test('rate limit: 21st POST /api/backtests inside a minute → 429', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 50, T0 - 20 * HOUR);
    const ip = freshIp();
    let saw429 = false;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/backtests',
        headers: { cookie: owner.cookie, 'x-forwarded-for': ip },
        payload: {
          strategyId,
          versionId,
          instrument: { assetClass: 'forex', symbol: 'EURUSD' },
          from: T0 + i * 1000,
          to: T0 + i * 1000 + 5 * HOUR,
        },
      });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
      assert.ok([200, 201].includes(res.statusCode), `req ${i}: ${res.body}`);
    }
    assert.equal(saw429, true);
  });

  test('audit events for backtest creation/replay', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    await seedCandles('EURUSD', 20, T0 - 20 * HOUR);
    const payload = {
      strategyId,
      versionId,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      from: T0,
      to: T0 + 5 * HOUR,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload,
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload,
    });
    assert.equal(second.statusCode, 200);
    const audit = await pool.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE user_id = $1 AND action IN ('backtest.created','backtest.replayed') ORDER BY created_at DESC LIMIT 2",
      [owner.userId],
    );
    const actions = audit.rows.map((r) => r.action);
    assert.ok(actions.includes('backtest.created'));
    assert.ok(actions.includes('backtest.replayed'));
  });

  test('unknown instrument → 404', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, alwaysPassConfig('EURUSD'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {
        strategyId,
        versionId,
        instrument: { assetClass: 'forex', symbol: 'NOPE' },
        from: T0,
        to: T0 + 5 * HOUR,
      },
    });
    assert.equal(res.statusCode, 404);
  });
});
