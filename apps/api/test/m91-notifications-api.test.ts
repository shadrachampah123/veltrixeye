import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations } from '@veltrixeye/core';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const port = 5446;
let stop: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
const env = { NODE_ENV: 'test', PORT: '4998', HOST: '127.0.0.1', DATABASE_SSL_MODE: 'disable', SESSION_COOKIE_NAME: 've_session', COOKIE_SECURE: 'never', LOG_LEVEL: 'silent' };
const config = (url: string): AppConfig => loadConfig({ ...env, DATABASE_URL: url } as NodeJS.ProcessEnv);
const email = () => `m91_${randomBytes(5).toString('hex')}@example.com`;
function cookie(res: { headers: Record<string, string | number | string[] | undefined> }): string {
  const value = res.headers['set-cookie'];
  return String(Array.isArray(value) ? value[0] : value ?? '').split(';')[0] ?? '';
}
async function register(): Promise<{ cookie: string; id: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: email(), name: 'M91', password: 'correct-horse-42' } });
  assert.equal(res.statusCode, 201, res.body);
  return { cookie: cookie(res), id: res.json().user.id };
}

describe('M9.1 Phase 2 notification preferences and routing', () => {
  before(async () => {
    const dataDir = path.join(root, '.test', 'pg-m91-api');
    rmSync(dataDir, { recursive: true, force: true });
    const db = await startEmbeddedPostgres({ dataDir, port, user: 'test', password: randomBytes(16).toString('hex'), database: 'veltrixeye_m91_api' });
    stop = db.stop;
    pool = createPool({ databaseUrl: db.dbUrl });
    await runMigrations(pool, MIGRATIONS_DIR);
    app = await buildApp(config(db.dbUrl), createAppContext(pool, config(db.dbUrl)));
    await app.ready();
  }, { timeout: 180_000 });
  after(async () => { await app?.close(); await pool?.end(); await stop?.(); });

  test('preferences require a session, validate strictly, and never return the webhook secret', async () => {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/notifications/preferences' });
    assert.equal(unauthenticated.statusCode, 401);
    const owner = await register();
    const saved = await app.inject({ method: 'PUT', url: '/api/notifications/preferences', headers: { cookie: owner.cookie }, payload: {
      preferences: [{ channel: 'webhook', enabled: true, endpointUrl: 'https://hooks.example.test/alerts', signingSecret: 'never-return-this' }],
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, timezone: 'UTC' },
    } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.body.includes('never-return-this'), false);
    const body = saved.json();
    assert.equal(body.preferences[0].endpointUrl, 'https://hooks.example.test/alerts');
    assert.equal(body.quietHours.startMinute, 1320);
    const emailOff = await app.inject({ method: 'PUT', url: '/api/notifications/preferences', headers: { cookie: owner.cookie }, payload: { preferences: [{ channel: 'email', enabled: false }] } });
    assert.equal(emailOff.statusCode, 200, emailOff.body);
    assert.equal(emailOff.json().preferences.find((p: { channel: string }) => p.channel === 'email')?.enabled, false);
    const invalid = await app.inject({ method: 'PUT', url: '/api/notifications/preferences', headers: { cookie: owner.cookie }, payload: { preferences: [], unexpected: true } });
    assert.equal(invalid.statusCode, 400);
  });

  test('strategy preference routes enforce tenant ownership', async () => {
    const owner = await register();
    const foreign = await register();
    const strategy = await pool.query<{ id: string }>('INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id', [owner.id, `s-${randomBytes(3).toString('hex')}`]);
    const id = strategy.rows[0]!.id;
    const put = await app.inject({ method: 'PUT', url: `/api/notifications/preferences/strategies/${id}`, headers: { cookie: owner.cookie }, payload: { muted: true, channels: ['webhook'] } });
    assert.equal(put.statusCode, 200, put.body);
    const denied = await app.inject({ method: 'GET', url: `/api/notifications/preferences/strategies/${id}`, headers: { cookie: foreign.cookie } });
    assert.equal(denied.statusCode, 404);
  });
});
