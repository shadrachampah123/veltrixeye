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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5437;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_billing';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let dbUrl: string;

const uniqueEmail = () => `billing_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () => `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4999',
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
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-billing');
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
  const config: AppConfig = makeConfig({ DATABASE_URL: dbUrl });
  ctx = createAppContext(pool, config);
  app = await buildApp(config, ctx);
  await app.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

async function registerUser(): Promise<{ cookie: string; user: { id: string; email: string } }> {
  const email = uniqueEmail();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email, password: 'correct-horse-42', name: 'Billing Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { cookie: cookieFrom(res), user: res.json().user };
}

describe('M7.4: Billing and Entitlements API', () => {
  test('Model C: registration succeeds without any billing provisioning', async () => {
    const snapshotsBefore = (
      await pool.query('SELECT count(*)::int AS c FROM billing_pricing_snapshots')
    ).rows[0].c;
    const { cookie, user } = await registerUser();

    // The user row exists exactly as before, with the unchanged default plan…
    const users = await pool.query('SELECT plan, email, deleted_at FROM users WHERE id = $1', [user.id]);
    assert.equal(users.rows[0].plan, 'free');
    assert.equal(users.rows[0].deleted_at, null);
    // …while registration touches NO billing state at all.
    assert.equal(
      (await pool.query('SELECT count(*)::int AS c FROM subscriptions WHERE user_id = $1', [user.id])).rows[0].c,
      0, 'registration must not create a subscriptions row',
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS c FROM billing_customers WHERE user_id = $1', [user.id])).rows[0].c,
      0, 'registration must not provision a provider customer',
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS c FROM billing_pricing_snapshots')).rows[0].c,
      snapshotsBefore, 'registration must not price anything',
    );

    // Session and audit behaviour are unchanged: the registration session is
    // usable and the audit trail still records the registration.
    const me = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie, 'x-forwarded-for': freshIp() } });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().user.id, user.id);
    const audit = await pool.query(
      "SELECT action FROM audit_events WHERE user_id = $1 AND action = 'auth.registered'", [user.id],
    );
    assert.equal(audit.rowCount, 1, 'the registration audit event is preserved');
  });

  test('New user gets correct default free entitlement', async () => {
    const { cookie, user } = await registerUser();
    const res = await app.inject({
      method: 'GET',
      url: '/api/billing/me',
      headers: { cookie, 'x-forwarded-for': freshIp() }
    });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json();
    assert.equal(data.subscription.plan, 'free');
    assert.equal(data.subscription.status, 'active');
    assert.equal(data.entitlements.maxStrategies, 100);
    // Model C: the free state IS the absent row — no provider, nothing confirmed,
    // no commercial entitlement and no scanner access.
    assert.deepEqual(data.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
    assert.equal(data.entitlements.canAccessScanner, false);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS c FROM subscriptions WHERE user_id = $1', [user.id])).rows[0].c,
      0,
    );
  });

  test('Free user is rejected from premium functionality (Strategy limit)', async () => {
    const { cookie, user } = await registerUser();
    
    // Fill up the free limit (100 strategies)
    await pool.query(
      `INSERT INTO strategies (user_id, name, description) 
       SELECT $1, 'Dummy S' || i, 'desc' FROM generate_series(1, 100) i`,
       [user.id]
    );
    
    // 101st strategy should fail
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { name: 'Exceeding Strategy', description: '' }
    });
    
    assert.equal(res.statusCode, 403, res.body);
    const err = res.json();
    assert.equal(err.error.code, 'forbidden');
    assert.ok(err.error.message.includes('Strategy limit reached'));
  });

  test('Premium user can access entitled functionality', async () => {
    const { cookie, user } = await registerUser();

    // Model C fixture: a HISTORICAL (provider IS NULL) paid row. Registration
    // no longer creates the row, so the fixture seeds it — the row shape and the
    // entitlements it resolves are exactly the pre-Model-C ones.
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'premium', 'active')
       ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status`,
      [user.id],
    );
    
    const resBilling = await app.inject({
      method: 'GET',
      url: '/api/billing/me',
      headers: { cookie, 'x-forwarded-for': freshIp() }
    });
    const billing = resBilling.json();
    assert.equal(billing.subscription.plan, 'premium');
    assert.equal(billing.entitlements.maxStrategies, 1000); 

    // Test that the premium user can create more than free limit
    await pool.query(
      `INSERT INTO strategies (user_id, name, description) 
       SELECT $1, 'Dummy S' || i, 'desc' FROM generate_series(1, 100) i`,
       [user.id]
    );
    
    // 101st strategy should SUCCEED for premium user
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { name: 'Premium Exceeding Strategy', description: '' }
    });
    
    assert.equal(res.statusCode, 201, res.body);
  });
});
