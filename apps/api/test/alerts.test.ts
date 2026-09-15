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
  ALERT_TRIGGER_STATES,
  alertDtoSchema,
} from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, runMigrations, MIGRATIONS_DIR, CandleStore } from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5441;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_alerts';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let store: CandleStore;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `alert_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () => `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4996',
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
const AS_OF = 1_700_000_000_000;

type Shape = [number, number, number, number];
const FLAT_16: Shape[] = Array.from({ length: 16 }, () => [100, 100.5, 99.5, 100] as Shape);
const BULLISH_SHAPES: Shape[] = [...FLAT_16, [101, 101.2, 100, 100.2], [100, 101.5, 99.9, 101.3]];

const RISK_LOW = {
  minRr: 2,
  stopLossMethod: 'fixed' as const,
  stopLossBuffer: 1,
  stopLossBufferUnit: 'pips' as const,
  takeProfitMethod: 'rr' as const,
  tp1Rr: 1,
  tp2Rr: 2,
  tp3Rr: 3,
  minQualityScore: 0,
};

const RISK_HIGH = {
  ...RISK_LOW,
  minQualityScore: 90,
};

function engulfConfig(symbol: string, risk: typeof RISK_LOW = RISK_LOW) {
  return {
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol }] },
    sessionFilters: [],
    risk,
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
}

async function registerUser(): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: PASSWORD, name: 'Alert Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { cookie: cookieFrom(res), userId: body.user.id };
}

async function createPublishedVersion(cookie: string, config: any): Promise<{ strategyId: string; versionId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/strategies',
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { name: `Alert strategy ${randomBytes(4).toString('hex')}`, version: config },
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

async function seedCandles(symbol: string, shapes: Shape[], anchor: number): Promise<void> {
  const instrument = await store.resolveInstrument('forex', symbol);
  assert.ok(instrument);
  const candles = shapes.map(([o, h, l, c], idx) => ({
    time: anchor - (shapes.length - idx) * HOUR,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
  }));
  await store.upsertCandles({ instrumentId: instrument.id, timeframe: '1h', providerSlug: 'test-fixture', candles });
}

async function detectSetup(cookie: string, strategyId: string, versionId: string, symbol: string, asOf: number): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/strategies/${strategyId}/versions/${versionId}/detect`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { instrument: { assetClass: 'forex', symbol }, direction: 'long', asOf },
  });
  assert.equal(res.statusCode, 200, res.body);
  const setup = res.json().detections[0].setup;
  assert.ok(setup);
  return setup.id as string;
}

async function scoreSetup(cookie: string, setupId: string, asOf?: number): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/setups/${setupId}/score`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: asOf ? { asOf } : {},
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function countRows(table: string): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? '0');
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-alerts');
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

describe('m6 alerts api', () => {
  test('setup: no provider is registered (alerts must not need one)', () => {
    assert.equal(ctx.providerRegistry.list().length, 0);
  });

  test('auth required for all alert routes', async () => {
    const fake = '11111111-1111-1111-1111-111111111111';
    const noAuth = { 'x-forwarded-for': freshIp() };
    assert.equal((await app.inject({ method: 'POST', url: `/api/setups/${fake}/alerts`, headers: noAuth, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/alerts', headers: noAuth })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/alerts/${fake}`, headers: noAuth })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `/api/alerts/${fake}/acknowledge`, headers: noAuth, payload: {} })).statusCode, 401);
  });

  test('eligible state enforcement: non-eligible states → 400', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF);
    await scoreSetup(owner.cookie, setupId);
    // Transition to invalidated (terminal, not eligible)
    const inv = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', asOf: AS_OF + 1 },
    });
    assert.equal(inv.statusCode, 200);
    const res = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /confirmed|triggered/);
  });

  test('M5 score requirement: setup without score → 400', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 10 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 10 * HOUR);
    // No scoring
    const res = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /quality score/);
  });

  test('minQualityScore gate: below gate → no alert, explicit silence', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', RISK_HIGH));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 20 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 20 * HOUR);
    await scoreSetup(owner.cookie, setupId);
    const before = await countRows('alerts');
    const res = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().alert, null);
    assert.equal(res.json().created, false);
    assert.equal(res.json().skippedReason, 'below_min_quality');
    assert.equal(await countRows('alerts'), before);
    assert.equal(await countRows('alert_deliveries'), 0);
  });

  test('valid alert generation creates alert + stub delivery', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', RISK_LOW));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 30 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 30 * HOUR);
    await scoreSetup(owner.cookie, setupId);
    const beforeAlerts = await countRows('alerts');
    const beforeDeliveries = await countRows('alert_deliveries');

    const res = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(body.created, true);
    assert.ok(body.alert);
    assert.equal(alertDtoSchema.safeParse(body.alert).success, true);
    assert.equal(body.alert.setupId, setupId);
    assert.equal(body.alert.triggerState, 'confirmed');
    assert.equal(body.alert.status, 'pending');
    assert.equal(body.alert.acknowledgedAt, null);
    assert.ok(body.alert.title.length <= 280);
    assert.ok(body.alert.title.includes('EURUSD'));
    // Body licensing-safe: no candle data
    assert.ok(!JSON.stringify(body.alert.body).includes('"open"'));
    // Delivery
    assert.equal(body.deliveries.length, 1);
    assert.equal(body.deliveries[0].channel, 'stub');
    assert.equal(body.deliveries[0].status, 'delivered');
    assert.ok(body.deliveries[0].payloadHash.match(/^[0-9a-f]{64}$/));
    assert.equal(await countRows('alerts'), beforeAlerts + 1);
    assert.equal(await countRows('alert_deliveries'), beforeDeliveries + 1);
  });

  test('trigger-state handling: explicit triggerState', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 40 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 40 * HOUR);
    await scoreSetup(owner.cookie, setupId);

    const resConfirmed = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { triggerState: 'confirmed' },
    });
    assert.equal(resConfirmed.statusCode, 201);
    assert.equal(resConfirmed.json().alert.triggerState, 'confirmed');

    // Transition to triggered, then generate triggered alert
    const trig = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'triggered', asOf: AS_OF + 40 * HOUR + 1 },
    });
    assert.equal(trig.statusCode, 200);

    const resTriggered = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { triggerState: 'triggered' },
    });
    assert.equal(resTriggered.statusCode, 201);
    assert.equal(resTriggered.json().alert.triggerState, 'triggered');

    // Invalid trigger state → 400
    const bad = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { triggerState: 'watching' },
    });
    assert.equal(bad.statusCode, 400);
  });

  test('deduplication by (setup_id, trigger_state)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 50 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 50 * HOUR);
    await scoreSetup(owner.cookie, setupId);

    const first = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(first.statusCode, 201);
    const firstId = first.json().alert.id;
    const beforeDeliveries = await countRows('alert_deliveries');

    const second = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().created, false);
    assert.equal(second.json().alert.id, firstId);
    // No duplicate delivery
    assert.equal(await countRows('alert_deliveries'), beforeDeliveries);
  });

  test('concurrent generation creates exactly one alert', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 60 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 60 * HOUR);
    await scoreSetup(owner.cookie, setupId);
    const ip = freshIp();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({ method: 'POST', url: `/api/setups/${setupId}/alerts`, headers: { cookie: owner.cookie, 'x-forwarded-for': ip }, payload: {} }),
      ),
    );
    for (const r of results) assert.ok([200, 201].includes(r.statusCode), r.body);
    const ids = new Set(results.map((r) => r.json().alert?.id).filter(Boolean));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((r) => r.json().created).length, 1);
  });

  test('stub delivery only, no network/vendor calls', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 70 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 70 * HOUR);
    await scoreSetup(owner.cookie, setupId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(res.statusCode, 201);
    const alertId = res.json().alert.id;
    const deliveries = await pool.query<{ channel: string; status: string }>('SELECT channel, status FROM alert_deliveries WHERE alert_id = $1', [alertId]);
    for (const d of deliveries.rows) {
      assert.equal(d.channel, 'stub');
      assert.equal(d.status, 'delivered');
    }
    // No email/webhook/push
    const nonStub = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM alert_deliveries WHERE channel <> 'stub'");
    assert.equal(nonStub.rows[0]?.n, '0');
  });

  test('acknowledgement: owner-scoped, status/acknowledged_at semantics', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 80 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 80 * HOUR);
    await scoreSetup(owner.cookie, setupId);
    const gen = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(gen.statusCode, 201);
    const alertId = gen.json().alert.id;

    const ack = await app.inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/acknowledge`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().alert.status, 'acknowledged');
    assert.ok(ack.json().alert.acknowledgedAt);
    const firstAckAt = ack.json().alert.acknowledgedAt;

    // Repeated ack is idempotent, keeps original timestamp
    const again = await app.inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/acknowledge`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().alert.status, 'acknowledged');
    assert.equal(again.json().alert.acknowledgedAt, firstAckAt);
  });

  test('masked 404 for foreign alerts and setups', async () => {
    const victim = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(victim.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 90 * HOUR);
    const setupId = await detectSetup(victim.cookie, strategyId, versionId, 'EURUSD', AS_OF + 90 * HOUR);
    await scoreSetup(victim.cookie, setupId);
    const gen = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: victim.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(gen.statusCode, 201);
    const alertId = gen.json().alert.id;

    const attacker = await registerUser();
    const foreignAlert = await app.inject({
      method: 'GET',
      url: `/api/alerts/${alertId}`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(foreignAlert.statusCode, 404);

    const foreignSetup = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(foreignSetup.statusCode, 404);

    const foreignAck = await app.inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/acknowledge`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(foreignAck.statusCode, 404);

    // Victim's alert not in attacker's list
    const list = await app.inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.json().alerts.some((a: any) => a.id === alertId));
  });

  test('list/detail endpoints', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 100 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 100 * HOUR);
    await scoreSetup(owner.cookie, setupId);
    const gen = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(gen.statusCode, 201);
    const alertId = gen.json().alert.id;

    const list = await app.inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().alerts.some((a: any) => a.id === alertId));

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/alerts?status=pending`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(filtered.statusCode, 200);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/alerts/${alertId}`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().alert.id, alertId);
    assert.ok(Array.isArray(detail.json().deliveries));
  });

  test('rate limits', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 110 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 110 * HOUR);
    await scoreSetup(owner.cookie, setupId);

    // Generate rate limit: 20/min
    const ip = freshIp();
    let saw429 = false;
    for (let i = 0; i < 21; i++) {
      // Use different triggerState? No, dedup will make second 200, but rate limit still counts.
      // We need distinct setups for each request to avoid dedup making it 200 but still counting.
      // For simplicity, we test ack rate limit separately with same alert.
      const res = await app.inject({
        method: 'POST',
        url: `/api/setups/${setupId}/alerts`,
        headers: { cookie: owner.cookie, 'x-forwarded-for': ip },
        payload: {},
      });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
      assert.ok([200, 201].includes(res.statusCode));
    }
    assert.equal(saw429, true);

    // Ack rate limit: 60/min
    const gen = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { triggerState: 'confirmed' },
    });
    const alertId = gen.json().alert.id;
    const ip2 = freshIp();
    let saw429Ack = false;
    for (let i = 0; i < 61; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/alerts/${alertId}/acknowledge`,
        headers: { cookie: owner.cookie, 'x-forwarded-for': ip2 },
        payload: {},
      });
      if (res.statusCode === 429) {
        saw429Ack = true;
        break;
      }
      assert.equal(res.statusCode, 200);
    }
    assert.equal(saw429Ack, true);
  });

  test('audit events for alert generation and acknowledgement', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 120 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 120 * HOUR);
    await scoreSetup(owner.cookie, setupId);
    const gen = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(gen.statusCode, 201);
    const alertId = gen.json().alert.id;
    await app.inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/acknowledge`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    const genAudit = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE user_id = $1 AND action = 'alert.generated'",
      [owner.userId],
    );
    assert.ok(Number(genAudit.rows[0]?.n ?? '0') >= 1);
    const ackAudit = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE user_id = $1 AND action = 'alert.acknowledged'",
      [owner.userId],
    );
    assert.ok(Number(ackAudit.rows[0]?.n ?? '0') >= 1);
    const deliveryAudit = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE user_id = $1 AND action = 'alert.delivery_recorded'",
      [owner.userId],
    );
    assert.ok(Number(deliveryAudit.rows[0]?.n ?? '0') >= 1);
  });

  test('malformed inputs → 400, never 500', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 130 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 130 * HOUR);
    await scoreSetup(owner.cookie, setupId);

    const badBody = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/alerts`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { triggerState: 'invalid' },
    });
    assert.equal(badBody.statusCode, 400);

    const badAck = await app.inject({
      method: 'POST',
      url: `/api/alerts/${setupId}/acknowledge`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { note: 'seen' },
    });
    // setupId is not an alert id, but malformed body also 400; we test both
    assert.ok([400, 404].includes(badAck.statusCode));

    const badList = await app.inject({
      method: 'GET',
      url: '/api/alerts?status=invalid',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(badList.statusCode, 400);
  });
});
