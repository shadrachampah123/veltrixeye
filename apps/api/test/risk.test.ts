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
import { PLATFORM_RISK_CEILINGS, RISK_ENGINE_VERSION } from '@veltrixeye/contracts';

/**
 * M8.2 — risk API security suite.
 *
 *  - every risk route demands a session;
 *  - owner-scoped reads (no IDOR);
 *  - client cannot raise risk above the platform ceiling;
 *  - client cannot lower minRr below 1:2;
 *  - client cannot submit a risk-approved execution decision;
 *  - no order-placement / broker-credential surface;
 *  - automation remains OFF.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5450;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_risk_api';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let dbUrl: string;

const uniqueEmail = () => `risk_api_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () =>
  `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

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

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-risk-api');
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

async function registerUser(): Promise<{ cookie: string; user: { id: string; email: string } }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: 'correct-horse-42', name: 'Risk API Tester' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { cookie: cookieFrom(res), user: res.json().user };
}

describe('M8.2 risk API — authentication', () => {
  test('every risk route requires a session', async () => {
    for (const [method, url] of [
      ['GET', '/api/risk/policy'],
      ['GET', '/api/risk/decisions'],
    ] as const) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
    const patch = await app.inject({ method: 'PATCH', url: '/api/risk/policy', payload: {} });
    assert.equal(patch.statusCode, 401);
  });
});

describe('M8.2 risk API — policy', () => {
  test('GET returns the default policy plus platform ceilings', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({ method: 'GET', url: '/api/risk/policy', headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.engineVersion, RISK_ENGINE_VERSION);
    assert.equal(body.policy.minRr, 2);
    assert.equal(body.platformCeilings.maxRiskPctPerTrade, PLATFORM_RISK_CEILINGS.maxRiskPctPerTrade);
    assert.equal(body.platformCeilings.minRr, 2);
    const serialized = JSON.stringify(body).toLowerCase();
    for (const needle of ['password', 'api_key', 'apikey', 'secret', 'token']) {
      assert.ok(!serialized.includes(needle), `must not leak ${needle}`);
    }
  });

  test('client cannot raise risk % above the platform maximum', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/risk/policy',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { riskPctPerTrade: 50 },
    });
    assert.equal(res.statusCode, 400);
  });

  test('client cannot reduce minRr below 1:2', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/risk/policy',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { minRr: 1 },
    });
    assert.equal(res.statusCode, 400);
  });

  test('a value inside the envelope is accepted', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/risk/policy',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { riskPctPerTrade: 0.25, minRr: 3 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.policy.riskPctPerTrade, 0.25);
    assert.equal(body.policy.minRr, 3);
  });

  test('strict schema rejects credential-shaped and approval fields', async () => {
    const { cookie } = await registerUser();
    for (const payload of [
      { password: 'hunter2' },
      { apiKey: 'sk_live' },
      { approved: true },
      { riskPctPerTrade: 0.5, extra: 1 },
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/risk/policy',
        headers: { cookie, 'x-forwarded-for': freshIp() },
        payload,
      });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  });

  test('policies are owner-scoped (IDOR)', async () => {
    const a = await registerUser();
    const b = await registerUser();
    await app.inject({
      method: 'PATCH',
      url: '/api/risk/policy',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
      payload: { riskPctPerTrade: 0.8 },
    });
    const bGet = await app.inject({ method: 'GET', url: '/api/risk/policy', headers: { cookie: b.cookie } });
    assert.equal(bGet.json().policy.riskPctPerTrade, 0.5, 'user B must not see user A settings');
    const bDecisions = await app.inject({
      method: 'GET',
      url: '/api/risk/decisions',
      headers: { cookie: b.cookie },
    });
    assert.equal(bDecisions.json().decisions.length, 0);
  });
});

describe('M8.2 risk API — no execution bypass', () => {
  test('there is no endpoint to submit a risk-approved decision or an order', async () => {
    const { cookie } = await registerUser();
    const attempts = [
      ['POST', '/api/risk/approve'],
      ['POST', '/api/risk/decisions'],
      ['POST', '/api/risk/evaluate'],
      ['POST', '/api/execution/orders'],
      ['POST', '/api/execution/decisions'],
      ['POST', '/api/execution/intake'],
    ] as const;
    for (const [method, url] of attempts) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { approved: true, setupId: 'x' },
      });
      assert.equal(res.statusCode, 404, `${method} ${url} must not exist`);
    }
  });

  test('automation remains OFF and cannot be enabled', async () => {
    const { cookie } = await registerUser();
    const status = await app.inject({ method: 'GET', url: '/api/execution/automation', headers: { cookie } });
    assert.equal(status.json().effective, false);
    const toggle = await app.inject({
      method: 'POST',
      url: '/api/execution/automation',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { enabled: true },
    });
    assert.equal(toggle.statusCode, 403);
  });

  test('execution status reports the risk engine version and paper not-ready', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({ method: 'GET', url: '/api/execution/status', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.riskEngineVersion, RISK_ENGINE_VERSION);
    assert.equal(body.automation.effective, false);
    const paper = body.providers.find((p: { id: string }) => p.id === 'paper');
    assert.equal(paper.healthy, false);
    assert.equal(paper.configured, false);
  });
});
