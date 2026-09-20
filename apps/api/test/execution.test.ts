import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, runMigrations, MIGRATIONS_DIR } from '@veltrixeye/core';

/**
 * M8.1 — execution architecture API security suite.
 *
 * Proves over real HTTP (fastify inject):
 *  - every execution route demands a session;
 *  - automation stays OFF, is server-authoritative, and the toggle 403s;
 *  - profile creation is paper-only, provider-validated, conflict-safe;
 *  - lists are owner-scoped (no cross-user order/position/profile leakage);
 *  - client-controlled ids/modes/providers are ignored or refused;
 *  - NO order-placement surface exists (submission endpoints are 404).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5444;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_execution_api';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let dbUrl: string;

const uniqueEmail = () => `exec_api_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () =>
  `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4997',
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

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-execution-api');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({ dataDir, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  dbUrl = db.dbUrl;
  const config = makeConfig({ DATABASE_URL: dbUrl });
  const ctx = createAppContext(pool, config);
  app = await buildApp(config, ctx);
  await app.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

async function registerUser(plan: 'free' | 'pro' | 'premium' = 'free'): Promise<{
  cookie: string;
  user: { id: string; email: string };
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: 'correct-horse-42', name: 'Exec API Tester' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const user = res.json().user;
  if (plan !== 'free') {
    await pool.query('UPDATE subscriptions SET plan = $1 WHERE user_id = $2', [plan, user.id]);
  }
  return { cookie: cookieFrom(res), user };
}

describe('M8.1 execution API — authentication', () => {
  test('every execution route requires a session (401 unauthenticated)', async () => {
    const routes = [
      ['GET', '/api/execution/automation'],
      ['GET', '/api/execution/status'],
      ['GET', '/api/execution/profiles'],
      ['GET', '/api/execution/orders'],
      ['GET', '/api/execution/positions'],
      ['GET', '/api/execution/events'],
    ] as const;
    for (const [method, url] of routes) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401, `${method} ${url} must be 401`);
    }
    for (const url of ['/api/execution/automation', '/api/execution/profiles']) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      assert.equal(res.statusCode, 401, `POST ${url} must be 401`);
    }
  });
});

describe('M8.1 execution API — automation control', () => {
  test('automation status is OFF, server-authoritative, with reasons', async () => {
    const { cookie } = await registerUser('premium');
    const res = await app.inject({
      method: 'GET',
      url: '/api/execution/automation',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.entitled, false);
    assert.equal(body.automationEnabled, false);
    assert.equal(body.effective, false);
    assert.ok(Array.isArray(body.reasons) && body.reasons.includes('entitlement_not_granted'));
  });

  test('clients cannot turn automation ON (403 for every plan)', async () => {
    for (const plan of ['free', 'pro', 'premium'] as const) {
      const { cookie } = await registerUser(plan);
      const res = await app.inject({
        method: 'POST',
        url: '/api/execution/automation',
        headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { enabled: true },
      });
      assert.equal(res.statusCode, 403, `plan ${plan} must be refused`);
    }
  });

  test('the automation flag cannot be forced through the users profile endpoint', async () => {
    const { cookie, user } = await registerUser();
    // updateProfile only accepts `name`; extra fields are rejected (.strict)
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: { cookie },
      payload: { automationEnabled: true },
    });
    assert.equal(res.statusCode, 400);
    const row = await pool.query('SELECT automation_enabled FROM users WHERE id = $1', [user.id]);
    assert.equal(row.rows[0].automation_enabled, false);
  });

  test('direct DB flag flip is NOT sufficient: status still reports OFF (entitlement required)', async () => {
    const { cookie, user } = await registerUser('premium');
    await pool.query('UPDATE users SET automation_enabled = true WHERE id = $1', [user.id]);
    const res = await app.inject({ method: 'GET', url: '/api/execution/automation', headers: { cookie } });
    const body = res.json();
    assert.equal(body.automationEnabled, true, 'the switch reflects DB state…');
    assert.equal(body.entitled, false, '…but the entitlement is still missing…');
    assert.equal(body.effective, false, '…so automation remains OFF');
  });
});

describe('M8.1 execution API — profiles', () => {
  test('paper profile creation succeeds; demo/live/unknown provider refused', async () => {
    const { cookie } = await registerUser();
    const ok = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'paper', providerSlug: 'paper' },
    });
    assert.equal(ok.statusCode, 201, ok.body);
    const profile = ok.json().profile;
    assert.equal(profile.mode, 'paper');
    assert.equal(profile.environment, 'paper');
    assert.equal(profile.enabled, true);

    const demo = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'demo', providerSlug: 'paper' },
    });
    assert.equal(demo.statusCode, 400);

    const live = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'live', providerSlug: 'paper' },
    });
    assert.equal(live.statusCode, 403);

    const unknownProvider = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'paper', providerSlug: 'exness-mt5' },
    });
    assert.equal(unknownProvider.statusCode, 400, 'client-controlled provider ids are refused');
  });

  test('duplicate paper profile is a conflict', async () => {
    const { cookie } = await registerUser();
    const first = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'paper', providerSlug: 'paper' },
    });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'paper', providerSlug: 'paper' },
    });
    assert.equal(second.statusCode, 409);
  });

  test('profile lists are strictly owner-scoped', async () => {
    const a = await registerUser();
    const b = await registerUser();
    await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'paper', providerSlug: 'paper' },
    });
    const aList = await app.inject({ method: 'GET', url: '/api/execution/profiles', headers: { cookie: a.cookie } });
    const bList = await app.inject({ method: 'GET', url: '/api/execution/profiles', headers: { cookie: b.cookie } });
    assert.equal(aList.json().profiles.length, 1);
    assert.equal(bList.json().profiles.length, 0, 'user B must not see user A profiles');
  });

  test('no credential field is accepted on profile creation (strict schema)', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'paper', providerSlug: 'paper', password: 'hunter2', apiKey: 'sk_live_xxx' },
    });
    assert.equal(res.statusCode, 400, 'strict body schema rejects credential-shaped fields');
  });
});

describe('M8.1 execution API — orders, positions, events', () => {
  test('order/position lists answer 200 + empty in M8.1 and never cross users', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const profileRes = await app.inject({
      method: 'POST',
      url: '/api/execution/profiles',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
      payload: { mode: 'paper', providerSlug: 'paper' },
    });
    const profileId = profileRes.json().profile.id;
    // Seed an order + position for user A directly (M8.1 has no writer path).
    await pool.query(
      `INSERT INTO execution_orders (user_id, execution_profile_id, client_order_id, provider_slug,
         asset_class, symbol, side, order_type, quantity, status, idempotency_key, architecture_version)
       VALUES ($1, $2, 've-api-scope', 'paper', 'forex', 'EURUSD', 'buy', 'market', 1, 'requested', $3, 'm8.1')`,
      [a.user.id, profileId, randomBytes(32).toString('hex')],
    );
    await pool.query(
      `INSERT INTO execution_positions (user_id, execution_profile_id, provider_slug, asset_class, symbol,
         direction, quantity, average_entry_price, status)
       VALUES ($1, $2, 'paper', 'forex', 'EURUSD', 'long', 1, 1.1, 'open')`,
      [a.user.id, profileId],
    );

    const aOrders = await app.inject({ method: 'GET', url: '/api/execution/orders', headers: { cookie: a.cookie } });
    const bOrders = await app.inject({ method: 'GET', url: '/api/execution/orders', headers: { cookie: b.cookie } });
    assert.equal(aOrders.statusCode, 200);
    assert.equal(aOrders.json().orders.length, 1);
    assert.equal(bOrders.json().orders.length, 0, 'cross-user order access denied');

    const aPositions = await app.inject({ method: 'GET', url: '/api/execution/positions', headers: { cookie: a.cookie } });
    const bPositions = await app.inject({ method: 'GET', url: '/api/execution/positions', headers: { cookie: b.cookie } });
    assert.equal(aPositions.json().positions.length, 1);
    assert.equal(bPositions.json().positions.length, 0, 'cross-user position access denied');

    const events = await app.inject({ method: 'GET', url: '/api/execution/events', headers: { cookie: a.cookie } });
    assert.equal(events.statusCode, 200);
    assert.ok(Array.isArray(events.json().events));
  });

  test('query limit is validated', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({ method: 'GET', url: '/api/execution/orders?limit=99999', headers: { cookie } });
    assert.equal(res.statusCode, 400);
  });
});

describe('M8.1 execution API — execution status', () => {
  test('status reports automation OFF, internal paper simulator ready, no secrets', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({ method: 'GET', url: '/api/execution/status', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.automation.effective, false);
    assert.match(body.architectureVersion, /^m8\.1-/);
    assert.ok(Array.isArray(body.providers));
    const paper = body.providers.find((p: { id: string }) => p.id === 'paper');
    assert.ok(paper, 'the paper boundary provider is registered');
    assert.equal(paper.healthy, true);
    assert.equal(paper.configured, true);
    const mt5 = body.providers.find((p: { id: string }) => p.id === 'mt5');
    assert.ok(mt5, 'the disabled MT5 integration boundary is registered');
    assert.equal(mt5.healthy, false);
    assert.equal(mt5.available, false);
    assert.equal(mt5.configured, false);
    assert.equal(body.providers.length, 2);
    // No secret material anywhere in the response.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const needle of ['password', 'api_key', 'apikey', 'secret', 'token']) {
      assert.ok(!serialized.includes(needle), `status must not leak "${needle}"`);
    }
  });
});

describe('M8.1 execution API — no order-placement surface', () => {
  test('there is NO endpoint capable of submitting, modifying or cancelling an order', async () => {
    const { cookie } = await registerUser('premium');
    const attempts = [
      ['POST', '/api/execution/orders'],
      ['POST', '/api/execution/orders/submit'],
      ['POST', '/api/execution/execute'],
      ['POST', '/api/execution/decisions'],
      ['POST', '/api/execution/positions/close'],
      ['POST', '/api/execution/providers/paper/submit'],
      ['POST', '/api/internal/execution/run'],
      ['DELETE', '/api/execution/orders/anything'],
    ] as const;
    for (const [method, url] of attempts) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { anything: true },
      });
      assert.equal(res.statusCode, 404, `${method} ${url} must not exist`);
    }
  });

  test('client-authored execution decisions have no intake endpoint', async () => {
    const { cookie } = await registerUser('premium');
    for (const url of ['/api/execution/intake', '/api/execution/requests', '/api/setups/anything/execute']) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { setupId: 'x', direction: 'long' },
      });
      assert.equal(res.statusCode, 404, `POST ${url} must not exist`);
    }
  });
});

describe('M8.4 broker management API', () => {
  const demoPayload = {
    mode: 'demo', providerSlug: 'mt5', accountRef: 'demo-account-ref', brokerServer: 'ExampleBroker-Demo',
    symbolMappings: [{ assetClass: 'commodity', canonicalSymbol: 'XAUUSD', brokerSymbol: 'XAUUSDm' }],
  };

  test('provider inventory reports MT5 unavailable and live disabled', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({ method: 'GET', url: '/api/execution/providers', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const mt5 = body.providers.find((p: { id: string }) => p.id === 'mt5');
    assert.equal(mt5.health.configured, false); assert.equal(mt5.health.available, false); assert.equal(mt5.health.healthy, false);
    assert.equal(body.liveExecutionAvailable, false);
  });

  test('creates disabled demo metadata, rejects secrets and cannot enable it', async () => {
    const { cookie } = await registerUser();
    const created = await app.inject({ method: 'POST', url: '/api/execution/broker-profiles', headers: { cookie, 'x-forwarded-for': freshIp() }, payload: demoPayload });
    assert.equal(created.statusCode, 201, created.body);
    const profile = created.json().profile;
    assert.equal(profile.environment, 'demo'); assert.equal(profile.enabled, false); assert.equal(profile.connectionStatus, 'disabled');
    assert.equal(profile.symbolMappings[0].brokerSymbol, 'XAUUSDm');
    const secret = await app.inject({ method: 'POST', url: '/api/execution/broker-profiles', headers: { cookie, 'x-forwarded-for': freshIp() }, payload: { ...demoPayload, password: 'must-not-be-stored' } });
    assert.equal(secret.statusCode, 400);
    const enable = await app.inject({ method: 'PATCH', url: `/api/execution/broker-profiles/${profile.id}`, headers: { cookie, 'x-forwarded-for': freshIp() }, payload: { enabled: true } });
    assert.equal(enable.statusCode, 403);
  });

  test('live profile and live patch are rejected', async () => {
    const { cookie } = await registerUser();
    const live = await app.inject({ method: 'POST', url: '/api/execution/broker-profiles', headers: { cookie, 'x-forwarded-for': freshIp() }, payload: { ...demoPayload, mode: 'live' } });
    assert.equal(live.statusCode, 403);
    const created = await app.inject({ method: 'POST', url: '/api/execution/broker-profiles', headers: { cookie, 'x-forwarded-for': freshIp() }, payload: demoPayload });
    const patch = await app.inject({ method: 'PATCH', url: `/api/execution/broker-profiles/${created.json().profile.id}`, headers: { cookie, 'x-forwarded-for': freshIp() }, payload: { environment: 'live' } });
    assert.equal(patch.statusCode, 403);
  });

  test('Gate 10: provider health is never returned verbatim — closed field set, no detail, token reasons only', async () => {
    const { cookie } = await registerUser();
    const SAFE_KEYS = ['authenticated', 'available', 'checkedAt', 'configured', 'connected', 'healthy', 'reason', 'state'];
    const TOKEN = /^[a-z0-9_]{1,64}$/;
    const inventory = await app.inject({ method: 'GET', url: '/api/execution/providers', headers: { cookie } });
    assert.equal(inventory.statusCode, 200);
    for (const p of inventory.json().providers) {
      assert.deepEqual(Object.keys(p.health).sort(), SAFE_KEYS, `${p.id}: only safe health fields`);
      assert.ok(p.health.reason === null || TOKEN.test(p.health.reason), `${p.id}: reason is a machine token`);
    }
    // The paper adapter's health carries a `detail` object; the API must strip it.
    const paper = inventory.json().providers.find((p: { id: string }) => p.id === 'paper');
    assert.equal(paper.health.healthy, true); assert.equal('detail' in paper.health, false);
    const mt5 = inventory.json().providers.find((p: { id: string }) => p.id === 'mt5');
    assert.equal(mt5.health.reason, 'mt5_transport_unconfigured');
    for (const id of ['paper', 'mt5']) {
      const single = await app.inject({ method: 'GET', url: `/api/execution/providers/${id}/status`, headers: { cookie } });
      assert.equal(single.statusCode, 200);
      assert.deepEqual(Object.keys(single.json().health).sort(), SAFE_KEYS, `${id}/status: only safe health fields`);
      assert.equal(single.json().liveExecutionAvailable, false);
    }
    const status = await app.inject({ method: 'GET', url: '/api/execution/status', headers: { cookie } });
    for (const p of status.json().providers) {
      assert.deepEqual(Object.keys(p).sort(), ['authenticated', 'available', 'configured', 'connected', 'healthy', 'id', 'name', 'reason', 'state']);
      assert.ok(p.reason === null || TOKEN.test(p.reason), `${p.id}: status reason is a machine token`);
    }
  });

  test('Gate 10: connection test returns the safe health projection and audits no provider reason', async () => {
    const { cookie, user } = await registerUser();
    const created = await app.inject({ method: 'POST', url: '/api/execution/broker-profiles', headers: { cookie, 'x-forwarded-for': freshIp() }, payload: demoPayload });
    assert.equal(created.statusCode, 201, created.body);
    const tested = await app.inject({ method: 'POST', url: `/api/execution/broker-profiles/${created.json().profile.id}/test`, headers: { cookie, 'x-forwarded-for': freshIp() } });
    assert.equal(tested.statusCode, 200, tested.body);
    const body = tested.json();
    assert.equal(body.orderPlaced, false);
    assert.deepEqual(Object.keys(body.health).sort(), ['authenticated', 'available', 'checkedAt', 'configured', 'connected', 'healthy', 'reason', 'state']);
    assert.equal(body.health.available, false); assert.equal(body.health.reason, 'mt5_transport_unconfigured');
    const audit = await pool.query(`SELECT metadata FROM audit_events WHERE user_id = $1 AND action = 'execution.connection_tested'`, [user.id]);
    assert.equal(audit.rows.length, 1);
    assert.deepEqual(audit.rows[0].metadata, { provider: 'mt5', healthy: false, available: false, state: 'disabled', providerRegistered: true });
    assert.equal('reason' in audit.rows[0].metadata, false, 'health.reason is never persisted into audit metadata');
  });

  test('profile reads/tests are tenant isolated and connection test places no order', async () => {
    const a = await registerUser(); const b = await registerUser();
    const created = await app.inject({ method: 'POST', url: '/api/execution/broker-profiles', headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() }, payload: demoPayload });
    const id = created.json().profile.id;
    const list = await app.inject({ method: 'GET', url: '/api/execution/broker-profiles', headers: { cookie: b.cookie } });
    assert.equal(list.json().profiles.length, 0);
    const foreignTest = await app.inject({ method: 'POST', url: `/api/execution/broker-profiles/${id}/test`, headers: { cookie: b.cookie, 'x-forwarded-for': freshIp() } });
    assert.equal(foreignTest.statusCode, 404);
    const ownTest = await app.inject({ method: 'POST', url: `/api/execution/broker-profiles/${id}/test`, headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() } });
    assert.equal(ownTest.statusCode, 200); assert.equal(ownTest.json().orderPlaced, false); assert.equal(ownTest.json().health.available, false);
  });
});
