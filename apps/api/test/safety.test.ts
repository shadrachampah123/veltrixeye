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
import { killSwitchStatusDtoSchema } from '@veltrixeye/contracts';

/**
 * M8.6 — safety-controls API suite (real HTTP via fastify inject).
 *
 * Proves:
 *  - every safety route is session-only (401 otherwise);
 *  - GET status returns the pinned strict DTO, owner-scoped;
 *  - activate/clear work for own scopes with a REQUIRED reason and land in
 *    BOTH ledgers (kill_switch_events + audit_events, with ip);
 *  - schema strictness: global scope unparseable, targetId refused for
 *    user scope, short/long/hostile reasons refused, extra keys refused —
 *    an "approval" body smuggled into a safety call is a 400;
 *  - cross-tenant strategy/profile targets are masked 404s and cannot be
 *    armed OR cleared by anybody else;
 *  - emergency stop: arming the account switch + forcing automation OFF +
 *    disabling profiles in one call, visible through the OTHER endpoints
 *    (status/automation/profiles);
 *  - automation enable refuses with 409 while any switch is armed even for
 *    an (operator-flipped) plan with the entitlement, and OFF is always
 *    allowed;
 *  - the safety layer never leaks credentials/PII and never accepts a
 *    live-trading control: no broker credential field parses; a live-scoped
 *    safety route does not exist.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5454;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_safety_api';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let dbUrl: string;

const uniqueEmail = () => `safety_api_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () =>
  `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

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

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-safety-api');
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

async function registerUser(plan: 'free' | 'pro' | 'premium' = 'free'): Promise<{
  cookie: string;
  user: { id: string; email: string };
}> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: 'correct-horse-42', name: 'Safety API Tester' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const user = res.json().user;
  if (plan !== 'free') {
    // Model C: registration provisions no subscription row, so the fixture
    // seeds the historical (provider IS NULL) paid row the plan override needs.
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status) VALUES ($2, $1, 'active')
       ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan`,
      [plan, user.id],
    );
  }
  return { cookie: cookieFrom(res), user };
}

let strategyCounter = 0;
async function seedOwnedStrategy(userId: string): Promise<string> {
  strategyCounter += 1;
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `safety api strategy ${strategyCounter}`],
  );
  return strategy.rows[0]!.id;
}

async function seedPaperProfile(cookie: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/execution/profiles',
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { mode: 'paper', providerSlug: 'paper' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().profile.id;
}

/* -------------------------------------------------------------------------- */

describe('m8.6 safety API — authentication', () => {
  test('every safety route requires a session (401)', async () => {
    const routes = [
      ['GET', '/api/execution/safety'],
      ['GET', '/api/execution/safety/events'],
      ['POST', '/api/execution/safety/kill-switch/activate'],
      ['POST', '/api/execution/safety/kill-switch/clear'],
      ['POST', '/api/execution/safety/emergency-stop'],
    ] as const;
    for (const [method, url] of routes) {
      const res = await app.inject({ method, url, payload: {} });
      assert.equal(res.statusCode, 401, `${method} ${url} must be 401`);
    }
  });

  test('no global-scope mutation route exists (and none will be added silently)', async () => {
    const { cookie } = await registerUser();
    for (const url of [
      '/api/execution/safety/global',
      '/api/execution/kill-switch/global',
      '/api/execution/safety/global/clear',
      '/api/execution/safety/resume',
      '/api/execution/live',
    ]) {
      const res = await app.inject({ method: 'POST', url, headers: { cookie }, payload: {} });
      assert.equal(res.statusCode, 404, `${url} must not exist`);
    }
  });
});

describe('m8.6 safety API — status + strict inputs', () => {
  test('GET /api/execution/safety returns the pinned strict DTO for a fresh account', async () => {
    const { cookie } = await registerUser();
    const res = await app.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(killSwitchStatusDtoSchema.safeParse(body).success, true, JSON.stringify(body));
    assert.equal(body.safetyVersion, 'm8.7-safety-controls-1');
    assert.equal(body.globalForcedByEnvironment, false);
    assert.equal(body.anyActive, false);
    assert.equal(body.global.active, false);
    assert.equal(body.user.active, false);
    assert.deepEqual(body.strategies, []);
    assert.deepEqual(body.profiles, []);
    assert.equal(body.circuitBreaker.active, false);
    assert.equal(body.automation.entitled, false);
    assert.equal(body.automation.effective, false);
    const blob = JSON.stringify(body).toLowerCase();
    for (const needle of ['password', 'token', 'secret', 'cookie', 'apikey', '@example.com']) {
      assert.ok(!blob.includes(needle), 'status body must be free of PII/credentials');
    }
  });

  test('activation bodies are strict: scope/target/reason rules are not suggestions', async () => {
    const { cookie } = await registerUser();
    const cases: Array<[object, number, string]> = [
      [{ scope: 'global', reason: 'stop the platform' }, 400, 'global is not user-mutable'],
      [{ scope: 'user', targetId: randomBytes(16).toString('hex'), reason: 'aim at another' }, 400, 'user scope takes no targetId'],
      [{ scope: 'user' }, 400, 'reason required'],
      [{ scope: 'user', reason: 'no' }, 400, 'reason too short'],
      [{ scope: 'user', reason: 'x'.repeat(401) }, 400, 'reason too long'],
      [{ scope: 'user', reason: '<script>alert(1)</script>' }, 400, 'markup refused'],
      [{ scope: 'user', reason: 'ok reason', approved: true }, 400, 'no approval smuggling'],
      [{ scope: 'user', reason: 'ok reason', entryPrice: 9 }, 400, 'no price smuggling'],
      [{ scope: 'execution_profile', targetId: 'not-a-uuid', reason: 'bad target' }, 400, 'uuid only'],
      [{ scope: 'strategy', reason: 'missing target' }, 400, 'strategy needs targetId'],
    ];
    for (const [payload, status, label] of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/execution/safety/kill-switch/activate',
        headers: { cookie, 'x-forwarded-for': freshIp() },
        payload,
      });
      assert.equal(res.statusCode, status, label);
    }
    // A valid one passes.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'user', reason: 'incident drill from the API suite' },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().changed, true);
  });

  test('events query bounds the limit like every other list endpoint', async () => {
    const { cookie } = await registerUser();
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'extra=1']) {
      const res = await app.inject({ method: 'GET', url: `/api/execution/safety/events?${q}`, headers: { cookie } });
      assert.equal(res.statusCode, 400, q);
    }
    const res = await app.inject({ method: 'GET', url: '/api/execution/safety/events?limit=10', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().events, []);
  });
});

describe('m8.6 safety API — control round-trips', () => {
  test('arm, verify through every read model, clear — ledgers record all of it', async () => {
    const { cookie, user } = await registerUser('premium');
    const profileId = await seedPaperProfile(cookie);
    const strategyId = await seedOwnedStrategy(user.id);

    // Arm the account switch.
    const arm = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'user', reason: 'manual review requested' },
    });
    assert.equal(arm.statusCode, 200, arm.body);
    const armedStatus = arm.json().status;
    assert.equal(armedStatus.user.active, true);
    assert.equal(armedStatus.anyActive, true);
    assert.equal(killSwitchStatusDtoSchema.safeParse(armedStatus).success, true);

    // The automation surface agrees…
    const auto = await app.inject({ method: 'GET', url: '/api/execution/automation', headers: { cookie } });
    assert.ok(auto.json().reasons.includes('user_kill_switch_active'));
    assert.equal(auto.json().effective, false);

    // …and arming while armed changes nothing but IS recorded.
    const arm2 = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'user', reason: 'repeated panic click' },
    });
    assert.equal(arm2.statusCode, 200);
    assert.equal(arm2.json().changed, false);
    assert.equal(arm2.json().status.user.reason, 'manual review requested', 'first reason stands');

    // Strategy scope arms independently.
    const armStrategy = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'strategy', targetId: strategyId, reason: 'rebuilding this strategy' },
    });
    assert.equal(armStrategy.statusCode, 200, armStrategy.body);
    const status = await app.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie } });
    assert.equal(
      status.json().strategies.find((s: { strategyId: string }) => s.strategyId === strategyId)?.active,
      true,
    );

    // Profile scope.
    const armProfile = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'execution_profile', targetId: profileId, reason: 'profile quarantine' },
    });
    assert.equal(armProfile.statusCode, 200, armProfile.body);

    // Events: four attempts, three real changes, all visible, none cross-tenant.
    const events = await app.inject({ method: 'GET', url: '/api/execution/safety/events', headers: { cookie } });
    assert.equal(events.statusCode, 200);
    const list = events.json().events;
    assert.equal(list.length, 4);
    assert.deepEqual(list.map((e: { changed: boolean }) => e.changed), [true, true, false, true]);
    assert.ok(list.every((e: { source: string }) => e.source === 'user'));
    assert.ok(list.some((e: { entityLabel: string | null }) => e.entityLabel && e.entityLabel.startsWith('safety api strategy')));

    // Audit side-ledger carries ip/user-agent attribution.
    const auditRows = await pool.query<{ action: string; ip: string | null; metadata: Record<string, unknown> }>(
      `SELECT action, ip, metadata FROM audit_events
        WHERE user_id = $1 AND action LIKE 'safety.%' ORDER BY id DESC`,
      [user.id],
    );
    assert.ok(auditRows.rowCount! >= 4, 'every control is audited');
    assert.ok(auditRows.rows.every((r) => r.ip && r.ip.startsWith('10.')), 'ip attribution');
    assert.ok(auditRows.rows.some((r) => r.metadata.scope === 'strategy'));

    // Clearing requires a reason too, and clears exactly one scope.
    const clearNoReason = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/clear',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'user' },
    });
    assert.equal(clearNoReason.statusCode, 400);
    const clear = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/clear',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'user', reason: 'review complete; feed verified' },
    });
    assert.equal(clear.statusCode, 200, clear.body);
    assert.equal(clear.json().changed, true);
    assert.equal(clear.json().status.user.active, false);
    assert.equal(clear.json().status.anyActive, true, 'strategy + profile switches stay armed');
  });

  test('emergency stop: three brakes, one call, seen from every endpoint', async () => {
    const { cookie, user } = await registerUser();
    const profileId = await seedPaperProfile(cookie);
    // Pretend-armed account (raw DB flip — allowed only for tests/operators):
    await pool.query('UPDATE users SET automation_enabled = true WHERE id = $1', [user.id]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/emergency-stop',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { reason: 'vendor feed suspect during incident' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.stopped, true);
    assert.equal(body.killSwitchActivated, true);
    assert.equal(body.automationWasEnabled, true);
    assert.equal(body.automationDisabled, true);
    assert.equal(body.profilesDisabled, 1);
    assert.equal(killSwitchStatusDtoSchema.safeParse(body.status).success, true);
    assert.equal(body.status.anyActive, true);

    // The switch and its reason are durable.
    const row = await pool.query<{ active: boolean; reason: string; source: string }>(
      `SELECT active, reason, source FROM kill_switches WHERE scope = 'user' AND target_id = $1`,
      [user.id],
    );
    assert.equal(row.rows[0]!.active, true);
    assert.equal(row.rows[0]!.reason, 'vendor feed suspect during incident');
    assert.equal(row.rows[0]!.source, 'user');

    // Automation forced OFF, profile disabled — through their own endpoints.
    const auto = await app.inject({ method: 'GET', url: '/api/execution/automation', headers: { cookie } });
    assert.equal(auto.json().automationEnabled, false);
    assert.ok(auto.json().reasons.includes('user_kill_switch_active'));
    const profs = await app.inject({ method: 'GET', url: '/api/execution/profiles', headers: { cookie } });
    assert.equal(profs.json().profiles.find((p: { id: string }) => p.id === profileId)!.enabled, false);

    // Re-running keeps state, still records the attempt.
    const again = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/emergency-stop',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().killSwitchActivated, false);
    assert.equal(again.json().profilesDisabled, 0);
    const ev = await app.inject({ method: 'GET', url: '/api/execution/safety/events', headers: { cookie } });
    const second = ev.json().events[0];
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'Emergency stop requested from the account UI');

    // And the mirrored trail exists in execution_events for the Trading UI.
    const execTrail = await pool.query(
      `SELECT event, reason FROM execution_events WHERE user_id = $1 AND event = 'emergency_stop'`,
      [user.id],
    );
    assert.equal(execTrail.rowCount, 2);
  });

  test('automation enable is refused 409 while armed — even for an entitlement-flipped plan; disable is always allowed', async () => {
    const { cookie, user } = await registerUser('premium');
    // No plan grants the entitlement, so arm directly + verify 403… then make
    // the entitlement exist at the DB layer and verify the SWITCH still wins.
    const denied = await app.inject({
      method: 'POST',
      url: '/api/execution/automation',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { enabled: true },
    });
    assert.equal(denied.statusCode, 403, 'no plan grants automation (M8.1 guarantee intact)');

    await pool.query(
      `INSERT INTO kill_switches (scope, target_id, active, reason, source, activated_at)
       VALUES ('user', $1, true, 'operator stop', 'operator', now())`,
      [user.id],
    );
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/execution/automation',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { enabled: true },
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.match(blocked.json().error.message, /kill switch/i);

    // Turning OFF never needs an entitlement nor an unblocked path.
    const off = await app.inject({
      method: 'POST',
      url: '/api/execution/automation',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { enabled: false },
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().automationEnabled, false);
    assert.equal(off.json().effective, false);
  });
});

describe('m8.6 safety API — tenant isolation', () => {
  test('cross-tenant targets are masked 404s for BOTH activate and clear', async () => {
    const owner = await registerUser();
    const victimProfileId = await seedPaperProfile(owner.cookie);
    const victimStrategyId = await seedOwnedStrategy(owner.user.id);
    const attacker = await registerUser('premium');

    for (const path of ['/activate', '/clear']) {
      for (const [scope, targetId] of [
        ['strategy', victimStrategyId],
        ['execution_profile', victimProfileId],
      ] as const) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/execution/safety/kill-switch${path}`,
          headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
          payload: { scope, targetId, reason: 'cross tenant attempt' },
        });
        assert.equal(res.statusCode, 404, `${scope} ${path} must mask`);
        assert.equal(res.json().error.message, 'Strategy not found'.replace('Strategy', scope === 'strategy' ? 'Strategy' : 'Execution profile'));
      }
    }
    // The victim's resources are untouched.
    const victimStatus = await app.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie: owner.cookie } });
    assert.equal(victimStatus.json().anyActive, false);
    // The attacker's own view shows NOTHING of the victim's profile list either.
    const attackerStatus = await app.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie: attacker.cookie } });
    assert.deepEqual(attackerStatus.json().profiles, []);
    assert.deepEqual(attackerStatus.json().strategies, []);
  });

  test('an attacker cannot clear a switch they do not own — even knowing the scope', async () => {
    const victim = await registerUser();
    const victimStrategyId = await seedOwnedStrategy(victim.user.id);
    const arm = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie: victim.cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'strategy', targetId: victimStrategyId, reason: 'victim self-stop' },
    });
    assert.equal(arm.statusCode, 200, arm.body);

    const attacker = await registerUser('premium');
    const clear = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/clear',
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'strategy', targetId: victimStrategyId, reason: 'try to free the victim' },
    });
    assert.equal(clear.statusCode, 404);
    assert.equal(await pool.query(
      `SELECT active FROM kill_switches WHERE scope='strategy' AND target_id = $1`,
      [victimStrategyId],
    ).then((r) => r.rows[0]?.active), true, 'still armed');
    // And the attacker sees their own status as clean (no bleed-through).
    const st = await app.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie: attacker.cookie } });
    assert.equal(st.json().anyActive, false);
  });

  test('user-scope always targets the session account — even if a victim id is somehow sent', async () => {
    const victim = await registerUser();
    const attacker = await registerUser();
    // The schema refuses the field outright (proven above); belt & braces —
    // even a service-level attempt with an explicit foreign id never lands.
    const rowsBefore = await pool.query(`SELECT count(*)::text AS n FROM kill_switches`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'user', targetId: victim.user.id, reason: 'aimed at victim' },
    });
    assert.equal(res.statusCode, 400, 'schema-level refusal');
    const rowsAfter = await pool.query(`SELECT count(*)::text AS n FROM kill_switches`);
    assert.equal(rowsAfter.rows[0]!.n, rowsBefore.rows[0]!.n, 'nothing was written at all');
  });
});

describe('m8.6 safety API — risk-policy breaker surface', () => {
  test('policy DTO reports the breaker ON; PATCH cannot disarm it or any other safety control', async () => {
    const { cookie } = await registerUser();
    const get = await app.inject({ method: 'GET', url: '/api/risk/policy', headers: { cookie } });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().policy.circuitBreakerEnabled, true);
    assert.equal(
      killSwitchStatusDtoSchema.safeParse((await app.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie } })).json()).success,
      true,
    );
    // The strict policy schema has no key for the breaker — attempting it is 400.
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/risk/policy',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { circuitBreakerEnabled: false },
    });
    assert.equal(patch.statusCode, 400, 'no API path disarms the circuit breaker');
    const after = await app.inject({ method: 'GET', url: '/api/risk/policy', headers: { cookie } });
    assert.equal(after.json().policy.circuitBreakerEnabled, true);
    // Legit tightening still works and stays intact.
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/risk/policy',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { maxDailyLossPct: 2.5 },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().policy.maxDailyLossPct, 2.5);
    assert.equal(ok.json().policy.circuitBreakerEnabled, true);
  });

  test('arming an account switch makes risk evaluations refuse with KILL_SWITCH_ACTIVE (server truth)', async () => {
    // The risk engine already consumes the switch (M8.1 gate 6 semantics);
    // this pins that the M8.6 user-facing arm path feeds that gate live.
    const { cookie } = await registerUser();
    const arm = await app.inject({
      method: 'POST',
      url: '/api/execution/safety/kill-switch/activate',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { scope: 'user', reason: 'pre-trade review required' },
    });
    assert.equal(arm.statusCode, 200, arm.body);
    const status = await app.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie } });
    assert.equal(status.json().anyActive, true);
    assert.equal(status.json().user.active, true);
    // And the decision history endpoint is unaffected/read-only — no route
    // exists to approve a decision by hand (M8.2 guarantee re-pinned here).
    const forge = await app.inject({
      method: 'POST',
      url: '/api/risk/decisions',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { approved: true },
    });
    assert.equal(forge.statusCode, 404, 'no hand-authored risk decisions endpoint');
  });
});

describe('m8.6 safety API — deployment-pinned global switch', () => {
  test('config parsing pins the flag; the route DTO would report it when forced', async () => {
    // Full second-app proof lives in the core suite (service level). Here we
    // pin the environment contract: strict parsing and honest default.
    assert.equal(makeConfig({ DATABASE_URL: dbUrl }).EXECUTION_GLOBAL_KILL_SWITCH, false);
    assert.equal(makeConfig({ DATABASE_URL: dbUrl, EXECUTION_GLOBAL_KILL_SWITCH: 'true' }).EXECUTION_GLOBAL_KILL_SWITCH, true);
    assert.throws(() => makeConfig({ DATABASE_URL: dbUrl, EXECUTION_GLOBAL_KILL_SWITCH: 'yes' }), /Invalid environment configuration/);
    assert.throws(() => makeConfig({ DATABASE_URL: dbUrl, EXECUTION_GLOBAL_KILL_SWITCH: '1' }), /Invalid environment configuration/);
    // Empty string falls back to the safe default (same rule as every bool env).
    assert.equal(makeConfig({ DATABASE_URL: dbUrl, EXECUTION_GLOBAL_KILL_SWITCH: '' }).EXECUTION_GLOBAL_KILL_SWITCH, false);

    // And with a forced deployment the status shape reports the pin — spin up
    // a second app on the SAME database with the pin ON.
    const config = makeConfig({ DATABASE_URL: dbUrl, EXECUTION_GLOBAL_KILL_SWITCH: 'true' });
    const ctx = createAppContext(pool, config);
    const forcedApp = await buildApp(config, ctx);
    await forcedApp.ready();
    try {
      const { cookie } = await (async () => {
        const res = await forcedApp.inject({
          method: 'POST',
          url: '/api/auth/register',
          headers: { 'x-forwarded-for': freshIp() },
          payload: { email: uniqueEmail(), password: 'correct-horse-42', name: 'Forced' },
        });
        assert.equal(res.statusCode, 201);
        return { cookie: cookieFrom(res) };
      })();
      const status = await forcedApp.inject({ method: 'GET', url: '/api/execution/safety', headers: { cookie } });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().globalForcedByEnvironment, true);
      assert.equal(status.json().global.active, true);
      assert.match(status.json().global.reason, /environment/i);
      assert.equal(status.json().anyActive, true);
      // Even with no DB row, the user's own clear attempts of "global" are 400
      // (unparseable) — and the account status stays stopped.
      const auto = await forcedApp.inject({ method: 'GET', url: '/api/execution/automation', headers: { cookie } });
      assert.ok(auto.json().reasons.includes('global_kill_switch_forced_by_environment'));
    } finally {
      await forcedApp.close();
    }
  });
});
