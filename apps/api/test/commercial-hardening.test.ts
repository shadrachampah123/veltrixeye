/**
 * M7.2 — Commercial Readiness Hardening (regression tests).
 *
 * Pins the four M7.2 fixes:
 *  1. SHARED INSTRUMENT PROTECTION — a strategy version may only REFERENCE
 *     instruments from the platform universe. User input can neither create
 *     rows in the shared `instruments` table nor rewrite a platform
 *     instrument's display name (verified finding: the pre-M7.2 upsert let
 *     any user mint symbols that appeared in EVERY user's scope-"all"
 *     evaluations and rename shared instruments for everyone).
 *  2. STRATEGY LIFECYCLE AUDIT CONTEXT — strategy.created/updated/deleted and
 *     the version lifecycle events carry the acting request's IP and user
 *     agent (previously NULL, unlike every other audit event).
 *  3. PASSWORD-CHANGE RATE LIMIT — the credential endpoint POST
 *     /api/users/me/password is limited to 5/min per IP (previously only the
 *     global 300/min applied).
 *  4. SESSION HYGIENE — expired sessions are cleaned up at boot
 *     (runStartupHousekeeping) and the per-user session list is capped at
 *     MAX_SESSIONS_LISTED, newest first.
 *
 * Every test also exercises the negative paths (unauthenticated, foreign
 * user, invalid input) where the fixed surface is relevant.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import { MAX_SESSIONS_LISTED } from '@veltrixeye/core';
import { createPool, runMigrations, MIGRATIONS_DIR } from '@veltrixeye/core';
import { buildApp, createAppContext, runStartupHousekeeping } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5447;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_m72';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `m72_${randomBytes(6).toString('hex')}@example.com`;
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

/** A publishable config on one platform instrument (drives the audit tests). */
const PUBLISHABLE_CONFIG = {
  timeframes: { htf_bias: '1d', setup: '1h', entry: '15m' },
  marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }] },
  risk: {
    minRr: 2,
    stopLossMethod: 'structure',
    stopLossBuffer: 1,
    stopLossBufferUnit: 'pips',
    takeProfitMethod: 'rr',
    tp1Rr: 1,
    tp2Rr: 2,
    tp3Rr: 3,
    minQualityScore: 0,
  },
  ruleGroups: [
    {
      name: 'HTF Bias',
      logic: 'AND',
      conditions: [
        {
          conditionType: 'htf_alignment',
          classification: 'required',
          timeframeRole: 'htf_bias',
          params: { direction: 'bullish' },
        },
      ],
    },
  ],
};

async function registerUser(extraHeaders: Record<string, string> = {}): Promise<{
  cookie: string;
  email: string;
  userId: string;
}> {
  const email = uniqueEmail();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp(), ...extraHeaders },
    payload: { email, password: PASSWORD },
  });
  assert.equal(res.statusCode, 201, res.body);
  const user = (res.json() as { user: { id: string } }).user;
  return { cookie: cookieFrom(res), email, userId: user.id };
}

async function instrumentCount(): Promise<number> {
  const res = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM instruments');
  return Number(res.rows[0]?.n ?? 0);
}

async function instrumentsViaApi(cookie: string): Promise<unknown> {
  const res = await app.inject({ method: 'GET', url: '/api/markets/instruments', headers: { cookie } });
  assert.equal(res.statusCode, 200, res.body);
  return (res.json() as { instruments: unknown[] }).instruments;
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m72');
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
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

// ---------------------------------------------------------------------------
// 1. Shared instrument protection (multi-tenant data integrity)
// ---------------------------------------------------------------------------

describe('M7.2: shared instruments are platform-managed reference data', () => {
  test('a strategy cannot be created with an unknown scope instrument', async () => {
    const { cookie } = await registerUser();
    const before = await instrumentCount();

    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie },
      payload: {
        name: 'Pollutes Nothing',
        version: {
          marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'ZZM72FAKE' }] },
        },
      },
    });
    assert.equal(res.statusCode, 400, res.body);
    const err = res.json() as { error: { code: string; message: string } };
    assert.equal(err.error.code, 'invalid_input');
    assert.match(err.error.message, /ZZM72FAKE/);

    // No row was minted in the shared table…
    assert.equal(await instrumentCount(), before);
    // …and the shared universe the other users see is unchanged.
    const list = (await instrumentsViaApi(cookie)) as Array<{ symbol: string }>;
    assert.ok(!list.some((i) => i.symbol === 'ZZM72FAKE'), 'unknown symbol must not appear in the shared universe');
  });

  test('a user-supplied displayName cannot rewrite a platform instrument', async () => {
    const { cookie } = await registerUser();
    const dbBefore = await pool.query<{ display_name: string | null }>(
      "SELECT display_name FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'",
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie },
      payload: {
        name: 'Rename Attempt',
        version: {
          marketScope: {
            mode: 'instruments',
            instruments: [{ assetClass: 'forex', symbol: 'EURUSD', displayName: 'EVIL REWRITE' }],
          },
        },
      },
    });
    // The reference is legitimate (EURUSD exists), so the strategy is
    // accepted — but the shared display name must be untouched.
    assert.equal(res.statusCode, 201, res.body);

    const dbAfter = await pool.query<{ display_name: string | null }>(
      "SELECT display_name FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'",
    );
    assert.ok(dbBefore.rows[0] && dbAfter.rows[0], 'EURUSD row must exist before and after');
    assert.equal(dbAfter.rows[0].display_name, dbBefore.rows[0].display_name, 'shared display_name must not change');
    assert.notEqual(dbAfter.rows[0].display_name, 'EVIL REWRITE');

    const list = (await instrumentsViaApi(cookie)) as Array<{ symbol: string; displayName: string | null }>;
    const eur = list.find((i) => i.symbol === 'EURUSD');
    assert.equal(eur?.displayName, dbBefore.rows[0].display_name);
  });

  test('a draft version cannot be re-pointed at an unknown instrument', async () => {
    const { cookie } = await registerUser();
    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie },
      payload: {
        name: 'Swap Attempt',
        version: { marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'GBPUSD' }] } },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const strategy = (created.json() as { strategy: { id: string; versions: Array<{ id: string; status: string }> } }).strategy;
    const draft = strategy.versions.find((v) => v.status === 'draft');
    assert.ok(draft, 'created strategy has a draft version');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/strategies/${strategy.id}/versions/${draft.id}`,
      headers: { cookie },
      payload: {
        config: {
          marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'ZZM72FAKE2' }] },
        },
      },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_input');

    // The stored config is unchanged (still the legitimate reference).
    const after = await app.inject({
      method: 'GET',
      url: `/api/strategies/${strategy.id}/versions/${draft.id}`,
      headers: { cookie },
    });
    const version = (after.json() as { version: { config: { marketScope: { instruments: Array<{ symbol: string }> } } } }).version;
    assert.deepEqual(
      version.config.marketScope.instruments.map((i) => i.symbol),
      ['GBPUSD'],
    );
  });

  test('legitimate platform instruments are still accepted (no workflow regression)', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie },
      payload: {
        name: 'Legit Scope',
        version: {
          marketScope: {
            mode: 'instruments',
            // lowercase symbol: normalization to UPPERCASE must keep working
            instruments: [
              { assetClass: 'forex', symbol: 'eurusd' },
              { assetClass: 'crypto', symbol: 'btcusd' },
            ],
          },
        },
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const strategy = (res.json() as {
      strategy: { id: string; versions: Array<{ id: string; status: string }>; currentVersion: null };
    }).strategy;
    const draft = strategy.versions.find((v) => v.status === 'draft');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/strategies/${strategy.id}/versions/${draft!.id}`,
      headers: { cookie },
    });
    const version = (detail.json() as { version: { config: { marketScope: { instruments: Array<{ symbol: string }> } } } }).version;
    assert.deepEqual(
      version.config.marketScope.instruments.map((i) => i.symbol),
      ['EURUSD', 'BTCUSD'],
    );
  });

  test('one user failed attempt leaves another user platform view identical', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const snapshot = await instrumentsViaApi(b.cookie);

    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie: a.cookie },
      payload: {
        name: 'Cross Tenant',
        version: {
          marketScope: { mode: 'instruments', instruments: [{ assetClass: 'index', symbol: 'ZZFAKEIDX' }] },
        },
      },
    });
    assert.equal(res.statusCode, 400);

    const after = await instrumentsViaApi(b.cookie);
    assert.deepEqual(after, snapshot, 'user B platform instrument list must be byte-identical');
  });

  test('strategy create remains auth-gated (unauthenticated → 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      payload: { name: 'No Session', version: { marketScope: { mode: 'all' } } },
    });
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// 2. Strategy lifecycle audit events carry request context
// ---------------------------------------------------------------------------

describe('M7.2: strategy lifecycle audit events carry ip + user agent', () => {
  test('strategy.created / version lifecycle rows record the request context', async () => {
    const ip = '10.72.72.72';
    const ua = 'm72-audit-agent/1.0';
    const { cookie, userId } = await registerUser();
    void ip; // the header below carries the IP

    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie, 'x-forwarded-for': ip, 'user-agent': ua },
      payload: { name: 'Auditable', version: PUBLISHABLE_CONFIG },
    });
    assert.equal(created.statusCode, 201, created.body);
    const strategy = (created.json() as { strategy: { id: string; versions: Array<{ id: string; status: string }> } }).strategy;
    const draftId = strategy.versions.find((v) => v.status === 'draft')?.id;
    assert.ok(draftId, 'created strategy has a draft version');

    const published = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategy.id}/versions/${draftId}/publish`,
      headers: { cookie, 'x-forwarded-for': ip, 'user-agent': ua },
    });
    assert.equal(published.statusCode, 200, published.body);

    const v2 = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategy.id}/versions`,
      headers: { cookie, 'x-forwarded-for': ip, 'user-agent': ua },
      payload: {},
    });
    assert.equal(v2.statusCode, 201, v2.body);

    const rows = await pool.query<{ action: string; ip: string | null; user_agent: string | null }>(
      `SELECT action, ip, user_agent FROM audit_events
       WHERE user_id = $1 AND action IN ('strategy.created','strategy.version_published','strategy.version_created')
       ORDER BY created_at DESC`,
      [userId],
    );
    const byAction = new Map(rows.rows.map((r) => [r.action, r]));
    for (const action of ['strategy.created', 'strategy.version_published', 'strategy.version_created']) {
      const row = byAction.get(action);
      assert.ok(row, `audit event ${action} must exist`);
      assert.equal(row.ip, ip, `${action} must record the request IP`);
      assert.equal(row.user_agent, ua, `${action} must record the user agent`);
    }
  });

  test('strategy.updated and strategy.deleted carry request context', async () => {
    const ip = '10.72.72.73';
    const ua = 'm72-audit-agent/2.0';
    const { cookie, userId } = await registerUser();

    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie, 'x-forwarded-for': ip, 'user-agent': ua },
      payload: { name: 'Auditable Two' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const strategyId = (created.json() as { strategy: { id: string } }).strategy.id;

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/strategies/${strategyId}`,
      headers: { cookie, 'x-forwarded-for': ip, 'user-agent': ua },
      payload: { status: 'paused' },
    });
    assert.equal(updated.statusCode, 200, updated.body);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/strategies/${strategyId}`,
      headers: { cookie, 'x-forwarded-for': ip, 'user-agent': ua },
    });
    assert.equal(deleted.statusCode, 204);

    const rows = await pool.query<{ action: string; ip: string | null; user_agent: string | null }>(
      "SELECT action, ip, user_agent FROM audit_events WHERE user_id = $1 AND action IN ('strategy.updated','strategy.deleted')",
      [userId],
    );
    assert.equal(rows.rows.length, 2, 'one updated + one deleted event');
    for (const row of rows.rows) {
      assert.equal(row.ip, ip);
      assert.equal(row.user_agent, ua);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Password-change endpoint rate limit
// ---------------------------------------------------------------------------

describe('M7.2: password change endpoint is rate limited per IP', () => {
  test('6th attempt from one IP is 429; a different IP is not affected', async () => {
    const ip = '10.72.72.99';
    const { cookie } = await registerUser();

    const body = { currentPassword: 'definitely-wrong-1', newPassword: 'correct-horse-99' };
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/users/me/password',
        headers: { cookie, 'x-forwarded-for': ip },
        payload: body,
      });
      codes.push(res.statusCode);
    }
    // Five attempts reach the (wrong-password) 401; the sixth is limited.
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401], `first five must be 401, got ${codes}`);
    assert.equal(codes[5], 429, 'sixth attempt from the same IP must be 429');

    // A different client (fresh IP) is unaffected.
    const other = await app.inject({
      method: 'POST',
      url: '/api/users/me/password',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: body,
    });
    assert.equal(other.statusCode, 401, 'a different IP must not inherit the limit (401, not 429)');

    // The limit is per endpoint, not global: an unrelated endpoint on the
    // limited IP still answers normally (401 from the auth guard, not 429).
    const unrelated = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie, 'x-forwarded-for': ip },
    });
    assert.equal(unrelated.statusCode, 200, 'unrelated endpoint unaffected');
  });
});

// ---------------------------------------------------------------------------
// 4. Session hygiene: startup cleanup + bounded session list
// ---------------------------------------------------------------------------

describe('M7.2: session hygiene', () => {
  test('runStartupHousekeeping removes only expired sessions', async () => {
    const { userId } = await registerUser();
    const live = await ctx.sessions.create(userId, { userAgent: 'live-device' });
    const expired = await ctx.sessions.create(userId, { userAgent: 'expired-device' });
    await pool.query('UPDATE sessions SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [expired.record.id]);

    const removed = await runStartupHousekeeping(ctx);
    assert.ok(removed >= 1, 'at least the seeded expired session was removed');

    assert.ok(await ctx.sessions.findByToken(live.token), 'live session must survive housekeeping');
    assert.equal(await ctx.sessions.findByToken(expired.token), null, 'expired session must be gone');
  });

  test('session list is capped, newest first, and always includes the current session', async () => {
    const { userId, cookie } = await registerUser();
    // Outnumber the cap: the cookie session plus MAX_SESSIONS_LISTED + 5
    // more. The cookie session is the OLDEST, so a naive LIMIT would drop
    // the user's own active device from the list.
    for (let i = 0; i < MAX_SESSIONS_LISTED + 5; i++) {
      await ctx.sessions.create(userId, { userAgent: `bulk-device-${i}` });
    }

    const res = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    const sessions = (res.json() as { sessions: Array<{ id: string; userAgent: string; current: boolean }> }).sessions;
    assert.equal(
      sessions.length,
      MAX_SESSIONS_LISTED + 1,
      'the newest cap rows plus the (oldest) current session',
    );

    const ids = new Set(sessions.map((s) => s.id));
    assert.equal(ids.size, sessions.length, 'no duplicates in the capped list');

    // Exactly one current session — the acting one, guaranteed present even
    // though it is the oldest of the 106 active sessions.
    const current = sessions.filter((s) => s.current);
    assert.equal(current.length, 1, 'exactly one current session');
    const currentSession = current[0];
    assert.ok(currentSession, 'current session present');

    // Newest first for the capped rows (the current/oldest session comes last).
    const bulk = sessions.filter((s) => !s.current);
    assert.equal(bulk.length, MAX_SESSIONS_LISTED);
    const newestBulk = bulk[0];
    assert.ok(newestBulk, 'capped rows present');
    assert.ok(newestBulk.userAgent.startsWith('bulk-device-'));
    assert.equal(newestBulk.userAgent, `bulk-device-${MAX_SESSIONS_LISTED + 4}`, 'newest first');
    const last = sessions[sessions.length - 1];
    assert.ok(last, 'list non-empty');
    assert.equal(last.id, currentSession.id, 'current session is present (last, being oldest)');
  });
});
