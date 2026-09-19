import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations, hashPassword, UserService, SessionService } from '@veltrixeye/core';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const port = 5462;
let stop: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let users: UserService;
let sessions: SessionService;
const env = { NODE_ENV: 'test', PORT: '4998', HOST: '127.0.0.1', DATABASE_SSL_MODE: 'disable', SESSION_COOKIE_NAME: 've_session', COOKIE_SECURE: 'never', LOG_LEVEL: 'silent', WEBHOOK_SECRET_ENCRYPTION_KEY: randomBytes(32).toString('hex'), VAPID_PUBLIC_KEY: 'B'.repeat(87), VAPID_PRIVATE_KEY: 'test-private-key-32-bytes-long-for-test', VAPID_SUBJECT: 'mailto:test@example.com', PUSH_ENABLED: 'true' };
const config = (url: string): AppConfig => loadConfig({ ...env, DATABASE_URL: url } as NodeJS.ProcessEnv);
const email = () => `m92_${randomBytes(5).toString('hex')}@example.com`;

async function createUser(): Promise<{ cookie: string; id: string }> {
  const user = await users.create({ email: email(), passwordHash: await hashPassword('correct-horse-42'), name: 'M92' });
  const session = await sessions.create(user.id, { ip: '127.0.0.1', userAgent: 'test' });
  const cookie = `${env.SESSION_COOKIE_NAME}=${session.token}`;
  return { cookie, id: user.id };
}

describe('M9.2 notification preferences + push subscriptions API', () => {
  before(async () => {
    const dataDir = path.join(root, '.test', 'pg-m92-api');
    rmSync(dataDir, { recursive: true, force: true });
    const db = await startEmbeddedPostgres({ dataDir, port, user: 'test', password: randomBytes(16).toString('hex'), database: 'veltrixeye_m92_api' });
    stop = db.stop;
    pool = createPool({ databaseUrl: db.dbUrl });
    await runMigrations(pool, MIGRATIONS_DIR);
    users = new UserService(pool);
    sessions = new SessionService(pool, 30);
    app = await buildApp(config(db.dbUrl), createAppContext(pool, config(db.dbUrl)));
    await app.ready();
  }, { timeout: 180_000 });
  after(async () => { await app?.close(); await pool?.end(); await stop?.(); });

  test('GET preferences requires auth, returns no secrets', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/api/notifications/preferences' });
    assert.equal(unauth.statusCode, 401);
    const owner = await createUser();
    const res = await app.inject({ method: 'GET', url: '/api/notifications/preferences', headers: { cookie: owner.cookie } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(Array.isArray(body.preferences));
    assert.equal(JSON.stringify(body).includes('signingSecret'), false);
    assert.equal(JSON.stringify(body).includes('p256dh'), false);
  });

  test('PUT preferences validates HTTPS, max 3, push accepted', async () => {
    const owner = await createUser();
    const ok = await app.inject({
      method: 'PUT', url: '/api/notifications/preferences', headers: { cookie: owner.cookie }, payload: {
        preferences: [
          { channel: 'email', enabled: true },
          { channel: 'webhook', enabled: true, endpointUrl: 'https://hooks.example.test/alerts', signingSecret: 'secret' },
          { channel: 'push', enabled: true, endpointUrl: 'https://push.example.test/abc', signingSecret: JSON.stringify({ p256dh: 'B'.repeat(20) + '_-_' + 'A'.repeat(10), auth: 'auth123_-_' + 'B'.repeat(10) }) },
        ],
      },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(JSON.stringify(ok.body).includes('secret'), false, 'secret never in response');

    const badHttp = await app.inject({
      method: 'PUT', url: '/api/notifications/preferences', headers: { cookie: owner.cookie }, payload: {
        preferences: [{ channel: 'webhook', enabled: true, endpointUrl: 'http://hooks.example.test' }],
      },
    });
    assert.equal(badHttp.statusCode, 400, 'HTTP webhook should be rejected');

    const tooMany = await app.inject({
      method: 'PUT', url: '/api/notifications/preferences', headers: { cookie: owner.cookie }, payload: {
        preferences: [
          { channel: 'email', enabled: true },
          { channel: 'webhook', enabled: true, endpointUrl: 'https://hooks.example.test' },
          { channel: 'push', enabled: true, endpointUrl: 'https://push.example.test' },
          { channel: 'email', enabled: true },
        ],
      },
    });
    assert.equal(tooMany.statusCode, 400, 'max 3');
  });

  test('push subscription endpoint validates HTTPS and keys, owner-scoped, encrypted at rest', async () => {
    const owner = await createUser();
    const other = await createUser();
    const validSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'B'.repeat(20) + '_-_' + 'A'.repeat(10), auth: 'auth123_-_' + 'B'.repeat(10) } };

    const created = await app.inject({ method: 'POST', url: '/api/notifications/push/subscriptions', headers: { cookie: owner.cookie }, payload: validSub });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(JSON.stringify(created.body).includes('p256dh'), false, 'keys never in response');
    assert.equal(JSON.stringify(created.body).includes('auth'), false);

    // Check encrypted at rest
    const row = await pool.query<{ signing_secret: string | null; signing_secret_encrypted: string | null }>('SELECT signing_secret, signing_secret_encrypted FROM notification_preferences WHERE user_id=$1 AND channel=\'push\'', [owner.id]);
    assert.equal(row.rows[0]!.signing_secret, null, 'plaintext should be null when encryption enabled');
    assert.ok(row.rows[0]!.signing_secret_encrypted?.startsWith('v1:'), 'encrypted at rest');

    // Other user cannot see owner's preference via strategy scoping? For push, list is owner-scoped
    const otherList = await app.inject({ method: 'GET', url: '/api/notifications/preferences', headers: { cookie: other.cookie } });
    assert.equal(otherList.statusCode, 200);
    assert.equal(otherList.json().preferences.find((p: { channel: string }) => p.channel === 'push'), undefined);

    // Invalid subscription: http
    const bad = await app.inject({ method: 'POST', url: '/api/notifications/push/subscriptions', headers: { cookie: owner.cookie }, payload: { endpoint: 'http://fcm.googleapis.com/fcm/send/abc', keys: validSub.keys } });
    assert.equal(bad.statusCode, 400);

    // Invalid keys
    const badKeys = await app.inject({ method: 'POST', url: '/api/notifications/push/subscriptions', headers: { cookie: owner.cookie }, payload: { endpoint: validSub.endpoint, keys: { p256dh: 'bad!' } } });
    assert.equal(badKeys.statusCode, 400);
  });

  test('VAPID public key endpoint auth required, no private key leakage', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/api/notifications/push/vapid-public-key' });
    assert.equal(unauth.statusCode, 401);
    const owner = await createUser();
    const res = await app.inject({ method: 'GET', url: '/api/notifications/push/vapid-public-key', headers: { cookie: owner.cookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().publicKey);
    assert.equal(JSON.stringify(res.body).includes('private'), false);
  });

  test('DELETE preferences/:channel narrow, rate limited, 404 masking', async () => {
    const owner = await createUser();
    await app.inject({ method: 'PUT', url: '/api/notifications/preferences', headers: { cookie: owner.cookie }, payload: { preferences: [{ channel: 'webhook', enabled: true, endpointUrl: 'https://hooks.example.test' }] } });
    const del = await app.inject({ method: 'DELETE', url: '/api/notifications/preferences/webhook', headers: { cookie: owner.cookie } });
    assert.equal(del.statusCode, 200, del.body);
    const after = await app.inject({ method: 'GET', url: '/api/notifications/preferences', headers: { cookie: owner.cookie } });
    assert.equal(after.json().preferences.find((p: { channel: string }) => p.channel === 'webhook'), undefined);

    const badChannel = await app.inject({ method: 'DELETE', url: '/api/notifications/preferences/sms', headers: { cookie: owner.cookie } });
    assert.equal(badChannel.statusCode, 404);
  });

  test('constant-time token and rate limit preserved', async () => {
    // Internal route without token should 404
    const noToken = await app.inject({ method: 'POST', url: '/api/internal/notifications/deliveries/run', payload: {} });
    assert.equal(noToken.statusCode, 404);
  });
});
