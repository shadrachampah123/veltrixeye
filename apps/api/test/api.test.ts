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
const DB_PORT = 5435;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_api';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `api_${randomBytes(6).toString('hex')}@example.com`;

/** Every test uses a unique client IP (via X-Forwarded-For + trustProxy) so
 *  per-IP rate limits never leak between tests. */
const freshIp = () => `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

function cookieFrom(res: { headers: Record<string, string | number | string[] | undefined> }): string {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  // Pick the set-cookie that actually sets a value (skip "ve_session=; expires=..." clears).
  for (const c of arr) {
    const [pair] = String(c ?? '').split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(eq + 1).trim().length > 0) return pair;
  }
  return '';
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-api');
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

  const config: AppConfig = loadConfig({
    NODE_ENV: 'test',
    PORT: '4999',
    HOST: '127.0.0.1',
    DATABASE_URL: db.dbUrl,
    DATABASE_SSL_MODE: 'disable',
    SESSION_COOKIE_NAME: 've_session',
    COOKIE_SECURE: 'never',
    SESSION_TTL_DAYS: '30',
    LOG_LEVEL: 'silent',
  } as NodeJS.ProcessEnv);
  const ctx = createAppContext(pool, config);
  app = await buildApp(config, ctx);
  await app.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

async function registerUser(password = PASSWORD): Promise<{ cookie: string; email: string; user: { id: string; email: string } }> {
  const email = uniqueEmail();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email, password, name: 'Api Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { cookie: cookieFrom(res), email, user: body.user };
}

async function loginUser(
  email: string,
  password = PASSWORD,
  ip = freshIp(),
): Promise<{ cookie: string; status: number; body: { error?: { code: string; message: string } } }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': ip },
    payload: { email, password },
  });
  return { cookie: cookieFrom(res), status: res.statusCode, body: res.json() };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('health', () => {
  test('GET /api/health → 200 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
  });

  test('GET /api/health/ready → 200 ready (db up)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().database, 'up');
  });

  // The readiness payload is what a platform health check and an operator use
  // to tell "database reachable" from "schema actually migrated".
  test('GET /api/health/ready → reports migration/schema state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      status: string;
      schema: { applied: number; expected: number; latest: string | null; pending: string[]; checksumsMatch: boolean };
    };
    assert.equal(body.status, 'ready');
    assert.ok(body.schema.applied >= 7, 'all shipped migrations applied');
    assert.equal(body.schema.applied, body.schema.expected);
    assert.deepEqual(body.schema.pending, []);
    assert.equal(body.schema.checksumsMatch, true);
    assert.ok(String(body.schema.latest).endsWith('.sql'));
    // Health endpoints never leak credentials or the connection string.
    assert.ok(!res.body.includes('postgres://'), 'no database URL in the payload');
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe('auth', () => {
  test('register creates account + session cookie (httpOnly, sameSite=strict)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { email: uniqueEmail(), password: PASSWORD, name: 'Cookie Trader' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr, 'a set-cookie header is present');
    assert.ok(cookieStr.includes('ve_session='), 'session cookie set');
    assert.ok(/httponly/i.test(cookieStr), 'cookie must be HttpOnly');
    assert.ok(/samesite=strict/i.test(cookieStr), 'cookie must be SameSite=Strict');
    assert.ok(!/secure/i.test(cookieStr), 'test env uses http (COOKIE_SECURE=never)');
    assert.equal(res.json().user.email.toLowerCase(), res.json().user.email, 'email stored lowercase');
  });

  test('duplicate email → 409 (both exact and case-different)', async () => {
    const email = uniqueEmail();
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { email, password: PASSWORD },
    });
    assert.equal(first.statusCode, 201);
    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { email: email.toUpperCase(), password: PASSWORD },
    });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.json().error.code, 'conflict');
  });

  test('weak password / malformed input → 400 with field errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-forwarded-for': freshIp() },
      payload: { email: 'nope', password: 'short' },
    });
    assert.equal(res.statusCode, 400);
    const err = res.json().error;
    assert.equal(err.code, 'invalid_input');
    assert.ok(err.fields.email, 'email field error present');
    assert.ok(err.fields.password, 'password field error present');
  });

  test('login: valid → 200 + cookie; wrong password → 401 generic; unknown user → 401 generic', async () => {
    const { email } = await registerUser();

    const ok = await loginUser(email);
    assert.equal(ok.status, 200);
    assert.ok(ok.cookie);

    const wrong = await loginUser(email, 'wrong-password-9');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error?.message, 'Invalid email or password');

    const unknown = await loginUser(uniqueEmail());
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error?.message, 'Invalid email or password'); // same message — no user enumeration
  });

  test('auth-required route without cookie → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users/me' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, 'unauthorized');
  });

  test('GET /api/users/me with valid session → 200 user', async () => {
    const { cookie, email } = await registerUser();
    const res = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.email, email);
    assert.equal(res.json().user.plan, 'free');
  });

  test('logout revokes the session', async () => {
    const { cookie, email } = await registerUser();
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(out.statusCode, 200);
    const me = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(me.statusCode, 401);
    void email;
  });

  test('password change rotates sessions', async () => {
    const { cookie, email } = await registerUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/me/password',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { currentPassword: PASSWORD, newPassword: 'brand-new-99' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const newCookie = cookieFrom(res);
    assert.ok(newCookie, 'new session cookie issued');

    // old cookie is dead
    const oldMe = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(oldMe.statusCode, 401);
    // new cookie works
    const newMe = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: newCookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(newMe.statusCode, 200);
    void email;
  });

  test('wrong current password on change → 401', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/me/password',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { currentPassword: 'not-the-password', newPassword: 'brand-new-99' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// Security baseline
// ---------------------------------------------------------------------------

describe('security baseline', () => {
  test('security headers present', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const h = res.headers;
    assert.ok(h['x-content-type-options'] === 'nosniff');
    assert.ok(h['x-frame-options'] === 'DENY');
    assert.ok(String(h['content-security-policy']).includes("default-src 'none'"));
    assert.ok(h['referrer-policy']);
  });

  test('malformed JSON body → 400 (no stack leak)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': freshIp() },
      payload: '{"email": "broken",',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid_input');
    assert.ok(!res.body.includes('at '));
  });

  test('unknown route → 404 JSON (no HTML error page)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'not_found');
  });

  test('login is rate-limited per IP (10/min)', async () => {
    const ip = freshIp();
    const email = uniqueEmail();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { email, password: 'whatever-1' },
      });
      last = res.statusCode;
      if (res.statusCode === 429) break;
    }
    assert.equal(last, 429, 'expected a 429 after 10 rapid logins');
  });

  test('register is rate-limited per IP (5/hour)', async () => {
    const ip = freshIp();
    let created = 0;
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'x-forwarded-for': ip },
        payload: { email: uniqueEmail(), password: PASSWORD, name: 'Api Trader' },
      });
      last = res.statusCode;
      if (res.statusCode === 429) break;
      if (res.statusCode === 201) created += 1;
    }
    // Pins the documented control in docs/security.md (5/hour per IP) so the
    // documentation and the route config cannot drift apart again.
    assert.equal(created, 5, 'exactly 5 registrations should succeed from one IP');
    assert.equal(last, 429, 'expected a 429 after 5 registrations from one IP');
  });

  test('audit log records auth events', async () => {
    const { email } = await registerUser();
    await loginUser(email);
    const res = await pool.query(
      'SELECT action FROM audit_events WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY created_at DESC LIMIT 5',
      [email],
    );
    const actions = res.rows.map((r) => r.action);
    assert.ok(actions.includes('auth.registered'), `registered recorded: ${actions}`);
    assert.ok(actions.includes('auth.login'), `login recorded: ${actions}`);
  });
});

// ---------------------------------------------------------------------------
// Strategy API (ownership, versioning, immutability over HTTP)
// ---------------------------------------------------------------------------

const VERSION_CONFIG = {
  timeframes: { htf_bias: '1d', setup: '1h', entry: '15m' },
  marketScope: { mode: 'all' },
  risk: { minRr: 2 },
  ruleGroups: [
    {
      name: 'Structure',
      logic: 'AND',
      conditions: [
        { conditionType: 'liquidity_sweep', classification: 'required', timeframeRole: 'setup', params: { side: 'below' } },
        { conditionType: 'news_filter', classification: 'disqualifying', timeframeRole: 'any', params: { maxImportance: 'high' } },
      ],
    },
  ],
};

describe('strategies api', () => {
  test('full lifecycle: create → get → update draft → publish → frozen → new version → publish', async () => {
    const { cookie } = await registerUser();
    const H = { cookie, 'x-forwarded-for': freshIp() };

    // create
    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: H,
      payload: { name: 'API Strategy', description: 'http lifecycle', version: VERSION_CONFIG },
    });
    assert.equal(created.statusCode, 201, created.body);
    const strategy = created.json().strategy;
    assert.equal(strategy.versions.length, 1);
    const v1 = strategy.versions[0].id;

    // list
    const list = await app.inject({ method: 'GET', url: '/api/strategies', headers: H });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().strategies.length, 1);

    // get
    const got = await app.inject({ method: 'GET', url: `/api/strategies/${strategy.id}`, headers: H });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().strategy.currentVersion, null); // not published yet

    // update draft
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/strategies/${strategy.id}/versions/${v1}`,
      headers: H,
      payload: {
        config: {
          ...VERSION_CONFIG,
          timeframes: { htf_bias: '4h', setup: '1h', entry: '5m' },
        },
      },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json().version.config.timeframes, { htf_bias: '4h', setup: '1h', entry: '5m' });

    // publish
    const published = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategy.id}/versions/${v1}/publish`,
      headers: H,
    });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(published.json().version.status, 'published');

    // now frozen
    const frozen = await app.inject({
      method: 'PATCH',
      url: `/api/strategies/${strategy.id}/versions/${v1}`,
      headers: H,
      payload: { config: VERSION_CONFIG },
    });
    assert.equal(frozen.statusCode, 409);
    assert.equal(frozen.json().error.code, 'immutable');

    // new version (clone of v1)
    const v2 = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategy.id}/versions`,
      headers: H,
      payload: { fromVersionId: v1, changelog: 'v2 via http' },
    });
    assert.equal(v2.statusCode, 201, v2.body);
    const v2Id = v2.json().version.id;
    assert.equal(v2.json().version.versionNumber, 2);
    assert.equal(v2.json().version.status, 'draft');

    // publish v2 → becomes current
    await app.inject({ method: 'POST', url: `/api/strategies/${strategy.id}/versions/${v2Id}/publish`, headers: H });
    const final = await app.inject({ method: 'GET', url: `/api/strategies/${strategy.id}`, headers: H });
    assert.equal(final.json().strategy.currentVersion.versionNumber, 2);
  });

  test('publish gate over HTTP: incomplete draft → 400 with explanation', async () => {
    const { cookie } = await registerUser();
    const H = { cookie, 'x-forwarded-for': freshIp() };
    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: H,
      payload: { name: 'Incomplete HTTP' },
    });
    assert.equal(created.statusCode, 201);
    const s = created.json().strategy;
    const res = await app.inject({
      method: 'POST',
      url: `/api/strategies/${s.id}/versions/${s.versions[0].id}/publish`,
      headers: H,
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error.message.length > 20);
  });

  test('user isolation over HTTP: user B gets 404 on user A resources', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
      payload: { name: 'Owned By A' },
    });
    const s = created.json().strategy;

    const get = await app.inject({
      method: 'GET',
      url: `/api/strategies/${s.id}`,
      headers: { cookie: b.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(get.statusCode, 404); // not 403 — no existence leakage

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/strategies/${s.id}`,
      headers: { cookie: b.cookie, 'x-forwarded-for': freshIp() },
      payload: { name: 'Hijacked' },
    });
    assert.equal(patch.statusCode, 404);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/strategies/${s.id}`,
      headers: { cookie: b.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(del.statusCode, 404);

    const list = await app.inject({
      method: 'GET',
      url: '/api/strategies',
      headers: { cookie: b.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(list.json().strategies.length, 0);
  });

  test('invalid id shapes → 404 (not 500)', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'GET',
      url: '/api/strategies/not-a-uuid',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 404);
  });

  test('delete draft-only strategy → 204; delete with published history → 409', async () => {
    const { cookie } = await registerUser();
    const H = { cookie, 'x-forwarded-for': freshIp() };

    const a = (await app.inject({ method: 'POST', url: '/api/strategies', headers: H, payload: { name: 'Draft Only' } })).json().strategy;
    const delA = await app.inject({ method: 'DELETE', url: `/api/strategies/${a.id}`, headers: H });
    assert.equal(delA.statusCode, 204);

    const b = (await app.inject({ method: 'POST', url: '/api/strategies', headers: H, payload: { name: 'Has History', version: VERSION_CONFIG } })).json().strategy;
    await app.inject({ method: 'POST', url: `/api/strategies/${b.id}/versions/${b.versions[0].id}/publish`, headers: H });
    const delB = await app.inject({ method: 'DELETE', url: `/api/strategies/${b.id}`, headers: H });
    assert.equal(delB.statusCode, 409);
    assert.match(delB.json().error.message, /traceab/i);
  });
});

// ---------------------------------------------------------------------------
// Market data & meta endpoints
// ---------------------------------------------------------------------------

describe('market data & meta', () => {
  test('providers endpoint: empty registry at M1', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'GET',
      url: '/api/market-data/providers',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().providers, []);
  });

  test('instruments endpoint: normalized canonical instruments', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'GET',
      url: '/api/markets/instruments',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200);
    const symbols = res.json().instruments.map((i: { symbol: string }) => i.symbol);
    for (const s of ['EURUSD', 'XAUUSD', 'BTCUSD', 'SPX500']) {
      assert.ok(symbols.includes(s), `seeded ${s} present`);
    }
  });

  test('meta endpoint: full vocabulary for the editor', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'GET',
      url: '/api/strategies/meta',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200);
    const meta = res.json();
    assert.ok(meta.timeframes.includes('1h'));
    assert.ok(meta.conditionTypes.length >= 19);
    assert.deepEqual(meta.conditionClassifications.sort(), ['confirmation', 'disqualifying', 'optional', 'required']);
    assert.equal(meta.risk.defaultMinRr, 2);
    assert.ok(meta.qualityGrades.some((g: { grade: string; min: number }) => g.grade === 'A+' && g.min === 90));
  });

  test('meta requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/strategies/meta' });
    assert.equal(res.statusCode, 401);
  });
});
