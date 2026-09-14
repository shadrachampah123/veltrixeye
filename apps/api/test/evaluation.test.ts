import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import { evaluationResultSchema, type StrategyVersionConfig } from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, runMigrations, MIGRATIONS_DIR, CandleStore } from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5436;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_evaluation';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let store: CandleStore;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `eval_${randomBytes(6).toString('hex')}@example.com`;
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

// Fixed evaluation anchor and a deterministic 1h candle series: 16 flat
// candles, then a bearish candle, then a bullish engulfing close at the anchor.
const HOUR = 3_600_000;
const AS_OF = 1_800_000_000_000;
const CANDLE_SHAPES: Array<[number, number, number, number]> = [
  ...Array.from({ length: 16 }, () => [100, 100.5, 99.5, 100] as [number, number, number, number]),
  [101, 101.2, 100, 100.2],
  [100, 101.5, 99.9, 101.3],
];

const BULLISH_ENGULF_CONFIG: StrategyVersionConfig = {
  timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
  marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }] },
  sessionFilters: [],
  risk: {
    minRr: 2,
    stopLossMethod: 'fixed',
    stopLossBuffer: 1,
    stopLossBufferUnit: 'pips',
    takeProfitMethod: 'rr',
    tp1Rr: 1,
    tp2Rr: 2,
    tp3Rr: 3,
    minQualityScore: 65,
  },
  filters: [],
  ruleGroups: [
    {
      name: 'entry',
      logic: 'AND',
      position: 0,
      conditions: [
        { conditionType: 'engulfing_candle', classification: 'required', timeframeRole: 'setup', params: { direction: 'bullish' }, position: 0 },
      ],
    },
  ],
};

async function registerUser(): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: PASSWORD, name: 'Eval Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { cookie: cookieFrom(res), userId: body.user.id };
}

/** Create a strategy with `config` as its draft and publish version 1. */
async function createPublishedVersion(cookie: string, config: StrategyVersionConfig): Promise<{ strategyId: string; versionId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/strategies',
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { name: `Eval strategy ${randomBytes(4).toString('hex')}`, version: config },
  });
  assert.equal(created.statusCode, 201, created.body);
  const strategy = created.json().strategy;
  const version = strategy.versions[0];
  assert.ok(version);
  const published = await app.inject({
    method: 'POST',
    url: `/api/strategies/${strategy.id}/versions/${version.id}/publish`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
  });
  assert.equal(published.statusCode, 200, published.body);
  return { strategyId: strategy.id, versionId: version.id };
}

async function countRows(table: string): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? '0');
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-eval');
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

describe('m3 evaluation api', () => {
  test('setup: no provider is registered (evaluation must not need one)', () => {
    assert.equal(ctx.providerRegistry.list().length, 0);
  });

  test('unauthenticated evaluate → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies/11111111-1111-1111-1111-111111111111/versions/22222222-2222-2222-2222-222222222222/evaluate',
      headers: { 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(res.statusCode, 401);
  });

  test('foreign and nonexistent strategy/version are masked 404s; malformed uuid 404', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, BULLISH_ENGULF_CONFIG);
    const attacker = await registerUser();

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(foreign.statusCode, 404);

    const missing = await app.inject({
      method: 'POST',
      url: `/api/strategies/11111111-1111-1111-1111-111111111111/versions/22222222-2222-2222-2222-222222222222/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(missing.statusCode, 404);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/strategies/not-a-uuid/versions/22222222-2222-2222-2222-222222222222/evaluate',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(malformed.statusCode, 404);
  });

  test('draft version → 400 with an actionable message', async () => {
    const owner = await registerUser();
    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { name: `Draft ${randomBytes(4).toString('hex')}`, version: BULLISH_ENGULF_CONFIG },
    });
    assert.equal(created.statusCode, 201);
    const strategy = created.json().strategy;
    const version = strategy.versions[0];
    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategy.id}/versions/${version.id}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.message.includes('published'));
  });

  test('published version evaluates seeded candles: long passes via engulfing, short fails; result validates against the contract', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, BULLISH_ENGULF_CONFIG);

    const instrument = await store.resolveInstrument('forex', 'EURUSD');
    assert.ok(instrument);
    const candles = CANDLE_SHAPES.map(([o, h, l, c], idx) => ({
      time: AS_OF - (CANDLE_SHAPES.length - idx) * HOUR,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: null,
    }));
    const upserted = await store.upsertCandles({ instrumentId: instrument.id, timeframe: '1h', providerSlug: 'test-fixture', candles });
    assert.equal(upserted, CANDLE_SHAPES.length);

    const beforeSetups = await countRows('setups');
    const beforeScores = await countRows('setup_scores');
    const beforeEvents = await countRows('setup_state_events');

    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();

    // Round-trips the published zod contract.
    const parsed = evaluationResultSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? []));

    assert.equal(body.strategyId, strategyId);
    assert.equal(body.versionId, versionId);
    assert.equal(body.asOfMs, AS_OF);
    assert.equal(body.instruments.length, 1);
    assert.equal(body.instruments[0].symbol, 'EURUSD');
    assert.equal(body.instruments[0].directions.long.passed, true);
    assert.equal(body.instruments[0].directions.short.passed, false);
    assert.equal(body.instruments[0].anyPassed, true);
    const engulf = body.instruments[0].directions.long.groups[0].conditions[0];
    assert.equal(engulf.status, 'satisfied');
    assert.ok(body.instruments[0].directions.long.candidate);
    assert.equal(body.instruments[0].directions.long.candidate.entryPrice, 101.3);

    // READ-ONLY guarantee: evaluation wrote nothing anywhere.
    assert.equal(await countRows('setups'), beforeSetups);
    assert.equal(await countRows('setup_scores'), beforeScores);
    assert.equal(await countRows('setup_state_events'), beforeEvents);

    // Determinism: the same request twice yields byte-identical output.
    const again = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), body);
  });

  test('insufficient store history fails closed (required condition insufficient_data, direction blocked)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, BULLISH_ENGULF_CONFIG);
    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      // Only the single oldest seeded 1h candle closes at/before this anchor,
      // far below the handler's 10-candle floor → fail closed.
      payload: { asOf: AS_OF - 17 * HOUR },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.instruments[0].directions.long.passed, false);
    const engulf = body.instruments[0].directions.long.groups[0].conditions[0];
    assert.equal(engulf.status, 'insufficient_data');
    assert.ok(body.instruments[0].directions.long.failureReasons.length > 0);
  });

  test('scope all evaluates the instrument universe read-only (no provider, no writes)', async () => {
    const owner = await registerUser();
    const config: StrategyVersionConfig = {
      ...BULLISH_ENGULF_CONFIG,
      marketScope: { mode: 'all' },
    };
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, config);
    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.instruments.length >= 8, `expected the full M2 universe, got ${body.instruments.length}`);
    assert.equal(body.truncated, false);
    const eurusd = body.instruments.find((i: { symbol: string }) => i.symbol === 'EURUSD');
    assert.ok(eurusd);
    assert.equal(eurusd.directions.long.passed, true); // seeded candles from the earlier test are shared
    assert.equal(await countRows('setups'), 0);
    assert.equal(await countRows('setup_scores'), 0);
    assert.equal(await countRows('setup_state_events'), 0);
  });

  test('evaluation never triggers provider fetch-through (no key, empty registry, unseeded timeframe → 200 with insufficient data)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, BULLISH_ENGULF_CONFIG);
    // No candles exist for GBPUSD at all — a fetch-through would throw 502
    // (no provider registered); evaluation must answer 200 instead.
    const config: StrategyVersionConfig = {
      ...BULLISH_ENGULF_CONFIG,
      marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'GBPUSD' }] },
    };
    const { strategyId: sid2, versionId: vid2 } = await createPublishedVersion(owner.cookie, config);
    void strategyId;
    void versionId;
    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${sid2}/versions/${vid2}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.instruments[0].directions.long.passed, false);
    assert.equal(body.instruments[0].directions.long.groups[0].conditions[0].status, 'insufficient_data');
  });

  test('evaluate endpoint rate limit: 21st request inside a minute → 429', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, BULLISH_ENGULF_CONFIG);
    const ip = freshIp(); // same bucket for all requests
    let saw429 = false;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
        headers: { cookie: owner.cookie, 'x-forwarded-for': ip },
        payload: { asOf: AS_OF },
      });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
      assert.equal(res.statusCode, 200, `request ${i + 1}: ${res.body}`);
    }
    assert.equal(saw429, true, 'expected the 20/min evaluation rate limit to fire');
  });

  test('audit event strategy.evaluated is recorded', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, BULLISH_ENGULF_CONFIG);
    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(res.statusCode, 200);
    const events = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE action = 'strategy.evaluated' AND entity_id = $1",
      [versionId],
    );
    assert.ok(Number(events.rows[0]?.n ?? '0') >= 1);
  });

  test('invalid body (asOf not a number) → 400', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, BULLISH_ENGULF_CONFIG);
    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategyId}/versions/${versionId}/evaluate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: 'yesterday' },
    });
    assert.equal(res.statusCode, 400);
  });
});
