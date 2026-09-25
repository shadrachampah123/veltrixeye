/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M8.6 — safety controls (real Postgres).
 *
 * Proven against the migration-0021 schema:
 *  - DB hardening: source CHECK, activated_at invariant, append-only
 *    `kill_switch_events` (UPDATE/DELETE refused), no credential columns;
 *  - activate/clear semantics: ownership (strategy/profile), masked 404s,
 *    global refusal, reason requirement, event ledger (including no-op
 *    attempts and first-trip reason preservation);
 *  - environment-pinned global switch: forces gate 6 + status + refusal to
 *    clear, without touching rows;
 *  - circuit breaker: a loss-limit rejection DURABLY trips the user switch
 *    (idempotent, never re-tripped, never blocks the risk call itself), the
 *    risk DTO surfaces the platform default, and while tripped all new
 *    decisions fail KILL_SWITCH_ACTIVE;
 *  - automation switch: disable is always allowed; enable is refused while a
 *    switch is armed (409) and stays entitlement-gated (403);
 *  - emergency stop: one call arms the switch + turns automation OFF +
 *    disables profiles, atomically; audit rows for every control;
 *  - kill switches never strand risk reduction: position-close evaluation
 *    paths do not consult them (pinned by the paper-gates contract).
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  PAPER_SIMULATION_GATE_IDS,
  killSwitchStatusDtoSchema,
  type ExecutionDecisionInput,
} from '@veltrixeye/contracts';
import {
  AuditService,
  AutomationService,
  ExecutionProfileService,
  KillSwitchService,
  RiskEngineService,
  SafetyControlsService,
  UserService,
  createExecutionProviderRegistry,
  createPaperExecutionProvider,
  createPool,
  evaluateExecutionGates,
  getEntitlements,
  runMigrations,
  MIGRATIONS_DIR,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5453;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_safety';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;
let killSwitches: KillSwitchService;
let automation: AutomationService;
let safety: SafetyControlsService;
let risk: RiskEngineService;
let profiles: ExecutionProfileService;

const uniqueEmail = () => `safety_${randomBytes(6).toString('hex')}@example.com`;
const ANCHOR = Date.UTC(2024, 0, 2, 12, 0, 0);

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-safety');
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
  users = new UserService(pool);
  audit = new AuditService(pool);
  killSwitches = new KillSwitchService(pool);
  automation = new AutomationService(pool, killSwitches, audit);
  const registry = createExecutionProviderRegistry();
  registry.register(createPaperExecutionProvider());
  profiles = new ExecutionProfileService(pool, registry, audit);
  risk = new RiskEngineService(pool, { killSwitches, audit });
  safety = new SafetyControlsService(pool, { killSwitches, automation, audit });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

async function makeUser(): Promise<{ id: string }> {
  const user = await users.create({
    email: uniqueEmail(),
    passwordHash: 'x'.repeat(32),
    name: 'Safety Tester',
  });
  return { id: user.id };
}

async function makeStrategy(userId: string, name = 'London breakout'): Promise<string> {
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `${name} ${randomBytes(3).toString('hex')}`],
  );
  return strategy.rows[0]!.id;
}

async function makeSetup(userId: string): Promise<{
  strategyId: string;
  versionId: string;
  setupId: string;
}> {
  const strategyId = await makeStrategy(userId);
  const version = await pool.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by)
     VALUES ($1, 1, 'draft', $2) RETURNING id`,
    [strategyId, userId],
  );
  const versionId = version.rows[0]!.id;
  await pool.query(
    `INSERT INTO strategy_risk_config
       (version_id, min_rr, stop_loss_method, stop_loss_buffer, stop_loss_buffer_unit,
        take_profit_method, tp1_rr, tp2_rr, tp3_rr, min_quality_score)
     VALUES ($1, 2, 'structure', 1, 'pips', 'rr', 1, 2, 3, 65)`,
    [versionId],
  );
  await pool.query(
    `UPDATE strategy_versions SET status = 'published', published_at = now() WHERE id = $1`,
    [versionId],
  );
  const instrument = await pool.query<{ id: string }>(
    `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'`,
  );
  const setup = await pool.query<{ id: string }>(
    `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms)
     VALUES ($1, $2, 'confirmed', 'long', now(), $3) RETURNING id`,
    [versionId, instrument.rows[0]!.id, ANCHOR],
  );
  return { strategyId, versionId, setupId: setup.rows[0]!.id };
}

function makeDecision(ids: { strategyId: string; versionId: string; setupId: string }): ExecutionDecisionInput {
  return {
    strategyId: ids.strategyId,
    strategyVersionId: ids.versionId,
    setupId: ids.setupId,
    action: 'open_long',
    assetClass: 'forex',
    symbol: 'EURUSD',
    timeframe: '1h',
    direction: 'long',
    entryPrice: 1.1,
    stopLossPrice: 1.095,
    takeProfitPrice: 1.11,
    expectedRr: 2,
    qualityScore: 80,
    minQualityScore: 65,
    asOfMs: ANCHOR,
  };
}

async function eventCount(where: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM kill_switch_events WHERE ${where}`,
    params,
  );
  return Number(res.rows[0]!.n);
}

/* -------------------------------------------------------------------------- */

describe('m8.6 migration 0021 — schema hardening', () => {
  test('kill_switches gains provenance columns; source is CHECK-pinned', async () => {
    const cols = await pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'kill_switches'`,
    );
    const byName = new Map(cols.rows.map((c) => [c.column_name, c]));
    for (const col of ['source', 'actor_user_id', 'activated_at']) {
      assert.ok(byName.has(col), `${col} must exist`);
    }
    assert.equal(byName.get('source')?.is_nullable, 'NO');
    assert.ok(String(byName.get('source')?.column_default).includes('operator'), 'default operator');

    const user = await makeUser();
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO kill_switches (scope, target_id, active, source) VALUES ('user', $1, true, 'vibes')`,
          [user.id],
        ),
      (err: any) => err.code === '23514',
    );
    // An ACTIVE row can never lack an activation stamp: the trigger supplies
    // one even to raw operator/legacy writes (self-healing provenance).
    await pool.query(
      `INSERT INTO kill_switches (scope, target_id, active, activated_at) VALUES ('user', $1, true, NULL)`,
      [user.id],
    );
    const stamped = await pool.query<{ activated_at: Date | null; active: boolean }>(
      `SELECT activated_at, active FROM kill_switches WHERE scope = 'user' AND target_id = $1`,
      [user.id],
    );
    assert.equal(stamped.rows[0]!.active, true);
    assert.ok(stamped.rows[0]!.activated_at instanceof Date, 'the DB stamped the activation');
    // A never-activated row keeps NO timestamp.
    const inactiveUser = await makeUser();
    await pool.query(`INSERT INTO kill_switches (scope, target_id, active) VALUES ('user', $1, false)`, [inactiveUser.id]);
    const unStamp = await pool.query<{ activated_at: Date | null }>(
      `SELECT activated_at FROM kill_switches WHERE scope = 'user' AND target_id = $1`,
      [inactiveUser.id],
    );
    assert.equal(unStamp.rows[0]!.activated_at, null);
  });

  test('kill_switch_events is append-only (UPDATE/DELETE refused, INSERT free)', async () => {
    const user = await makeUser();
    await safety.activate(user.id, { scope: 'user', reason: 'drill: event ledger write' });
    const id = (await pool.query<{ id: string }>(
      `SELECT id FROM kill_switch_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [user.id],
    )).rows[0]!.id;

    await assert.rejects(
      () => pool.query(`UPDATE kill_switch_events SET reason = 'rewritten' WHERE id = $1`, [id]),
      (err: any) => /append-only|guard|UPDATE is not allowed|cannot/i.test(String(err.message)),
      'UPDATE must be refused by the guard trigger',
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM kill_switch_events WHERE id = $1`, [id]),
      (err: any) => /append-only|guard|DELETE is not allowed|cannot/i.test(String(err.message)),
      'DELETE must be refused by the guard trigger',
    );
    const row = await pool.query<{ reason: string }>(
      `SELECT reason FROM kill_switch_events WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0]!.reason, 'drill: event ledger write', 'history is immutable');
  });

  test('event ledger CHECKs pin scope/action/source/target coherence', async () => {
    // A global event with no actor/owner is legal (operator-only change)…
    await pool.query(
      `INSERT INTO kill_switch_events (scope, target_id, action, source, changed)
       VALUES ('global', NULL, 'activated', 'operator', true)`,
    );
    // …but every other shape of contradiction is refused by CHECK.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO kill_switch_events (scope, target_id, action, source, changed)
           VALUES ('global', gen_random_uuid(), 'activated', 'operator', true)`,
        ),
      (err: any) => err.code === '23514',
      'global event must have no target',
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO kill_switch_events (scope, target_id, action, source, changed)
           VALUES ('user', NULL, 'activated', 'operator', true)`,
        ),
      (err: any) => err.code === '23514',
      'non-global event requires a target',
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO kill_switch_events (scope, target_id, action, source, changed)
           VALUES ('user', gen_random_uuid(), 'deleted', 'operator', true)`,
        ),
      (err: any) => err.code === '23514',
      'action vocabulary is pinned',
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO kill_switch_events (scope, target_id, action, source, changed)
           VALUES ('user', gen_random_uuid(), 'activated', 'circuit_breaker', false)`,
        ),
      (err: any) => err.code === '23514',
      'a no-op circuit-breaker trip event is a contradiction and is refused',
    );
  });

  test('no credential-shaped columns exist anywhere in the safety schema', async () => {
    const res = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('kill_switches', 'kill_switch_events', 'risk_policies')`,
    );
    for (const row of res.rows) {
      const name = row.column_name.toLowerCase();
      for (const needle of ['password', 'secret', 'token', 'api_key', 'apikey', 'credential']) {
        assert.ok(!name.includes(needle), `${row.table_name}.${row.column_name} leaks the no-credentials rule`);
      }
    }
  });

  test('risk_policies.circuit_breaker_enabled defaults ON; no user path disarms it', async () => {
    const user = await makeUser();
    const status = await risk.getPolicyStatus(user.id);
    assert.equal(status.policy.circuitBreakerEnabled, true);
    const row = await pool.query<{ circuit_breaker_enabled: boolean }>(
      `SELECT circuit_breaker_enabled FROM risk_policies WHERE user_id = $1`,
      [user.id],
    );
    assert.equal(row.rows[0]!.circuit_breaker_enabled, true);
    // The service-level patch builder only knows allow-listed columns; a
    // "policy update" attempting to set the breaker flag is DROPPED (the API
    // layer additionally refuses the key with a strict-schema 400).
    await risk.updatePolicy(user.id, { circuitBreakerEnabled: false } as any);
    const after = await risk.getPolicyStatus(user.id);
    assert.equal(after.policy.circuitBreakerEnabled, true, 'the breaker cannot be disarmed by policy input');
    // Legit tightening still works and DOES touch the policy version.
    const patched = await risk.updatePolicy(user.id, { maxDailyLossPct: 2 });
    assert.equal(patched.policy.maxDailyLossPct, 2);
    assert.ok(patched.policy.policyVersion >= 2);
  });
});

/* -------------------------------------------------------------------------- */

describe('m8.6 kill-switch service — user-facing semantics', () => {
  test('user activate/clear round-trip with durable reasons and event trail', async () => {
    const user = await makeUser();
    assert.equal(await killSwitches.isUserActive(user.id), false);

    const armed = await safety.activate(user.id, { scope: 'user', reason: 'vendor data suspect' });
    assert.equal(armed.changed, true);
    assert.equal(await killSwitches.isUserActive(user.id), true);
    assert.equal((await killSwitches.anyActive({ userId: user.id })).user, true);

    const row = await killSwitches['findRow']('user', user.id);
    assert.equal(row?.active, true);
    assert.equal(row?.source, 'user');
    assert.equal(row?.reason, 'vendor data suspect');
    assert.equal(row?.actor_user_id, user.id);
    assert.ok(row?.activated_at instanceof Date, 'activation stamps the moment');

    const cleared = await safety.clear(user.id, { scope: 'user', reason: 'reviewed; feed verified' });
    assert.equal(cleared.changed, true);
    assert.equal(await killSwitches.isUserActive(user.id), false);
    // Clearing keeps the row + reason visible (never deletes).
    const after = await killSwitches['findRow']('user', user.id);
    assert.equal(after?.active, false);
    assert.equal(after?.reason, 'reviewed; feed verified');

    const events = await safety.history(user.id, 10);
    assert.deepEqual(
      events.events.map((e) => [e.scope, e.action]),
      [
        ['user', 'cleared'],
        ['user', 'activated'],
      ],
    );
    assert.equal(events.events[0]!.changed, true);
    assert.equal(events.events[0]!.entityLabel, null);
  });

  test('redundant activate/clear calls change nothing but are STILL recorded', async () => {
    const user = await makeUser();
    await safety.activate(user.id, { scope: 'user', reason: 'first arming' });
    const second = await safety.activate(user.id, { scope: 'user', reason: 'double click' });
    assert.equal(second.changed, false);
    // The first-trip reason survives a redundant re-activation (no overwrite).
    const row = await killSwitches['findRow']('user', user.id);
    assert.equal(row?.reason, 'first arming');
    const events = await safety.history(user.id, 10);
    assert.equal(events.events.length, 2);
    assert.equal(events.events[0]!.changed, false, 'the no-op attempt is on the record');
    assert.equal(events.events[0]!.reason, 'double click');
    const third = await safety.clear(user.id, { scope: 'user', reason: 'done' });
    assert.equal(third.changed, true);
    const fourth = await safety.clear(user.id, { scope: 'user', reason: 'already clear' });
    assert.equal(fourth.changed, false);
    assert.equal(await eventCount('user_id = $1', [user.id]), 4, 'every attempt, both no-ops included');
  });

  test('strategy/profile switches require OWNERSHIP; other tenants get a masked 404', async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const strategyId = await makeStrategy(owner.id, 'Owned strategy');
    const profile = await profiles.createProfile(owner.id, { mode: 'paper', providerSlug: 'paper' });

    // Attacker cannot target somebody else's resources — same error as missing.
    for (const [scope, targetId] of [
      ['strategy', strategyId],
      ['execution_profile', profile.id],
    ] as const) {
      await assert.rejects(
        () => safety.activate(attacker.id, { scope, targetId, reason: 'cross tenant attempt' }),
        (err: any) => err.code === 'not_found',
      );
      await assert.rejects(
        () => safety.clear(attacker.id, { scope, targetId, reason: 'cross tenant attempt' }),
        (err: any) => err.code === 'not_found',
      );
    }

    // Owner can, and the gate sees it.
    await safety.activate(owner.id, { scope: 'strategy', targetId: strategyId, reason: 'strategy under review' });
    assert.equal(await killSwitches.isStrategyActive(strategyId), true);
    assert.equal(
      (await killSwitches.anyActive({ userId: owner.id, strategyId })).strategy,
      true,
    );
    // And the attacker is unaffected by the owner's switch.
    assert.equal((await killSwitches.anyActive({ userId: attacker.id })).active, false);

    const status = await safety.getStatus(owner.id);
    const strat = status.strategies.find((s) => s.strategyId === strategyId);
    assert.equal(strat?.active, true);
    assert.ok(strat?.entityLabel?.startsWith('Owned strategy'));

    await safety.clear(owner.id, { scope: 'strategy', targetId: strategyId, reason: 'review complete' });
    assert.equal(await killSwitches.isStrategyActive(strategyId), false);
  });

  test('unknown strategy/profile targets 404 identically (no existence leak)', async () => {
    const user = await makeUser();
    const missing = randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).$/, '$1-$2-$3-$4-$5');
    const e1 = await safety
      .activate(user.id, { scope: 'strategy', targetId: missing, reason: 'nonexistent target' })
      .catch((err: any) => err);
    const e2 = await safety
      .activate(user.id, { scope: 'execution_profile', targetId: missing, reason: 'nonexistent target' })
      .catch((err: any) => err);
    assert.equal(e1.code, 'not_found');
    assert.equal(e2.code, 'not_found');
    // Masked: the message never distinguishes "not yours" from "does not exist".
    assert.doesNotMatch(e1.message, /strategies\.sql|permission|owns/i);
  });

  test('global scope is refused for users — service AND API surface alike', async () => {
    const user = await makeUser();
    await assert.rejects(
      () => safety.activate(user.id, { scope: 'global', reason: 'stop the platform' }),
      (err: any) => err.code === 'forbidden' && /platform/i.test(err.message),
    );
    await assert.rejects(
      () => safety.clear(user.id, { scope: 'global', reason: 'resume the platform' }),
      (err: any) => err.code === 'forbidden',
    );
  });

  test('operator set() still works, sources are recorded, and only real changes append events', async () => {
    await killSwitches.set('global', { active: true, reason: 'operator drill' });
    assert.equal(await killSwitches.isGlobalActive(), true);
    assert.equal(await eventCount("scope = 'global' AND changed = true"), await eventCount("scope = 'global'"));
    const before = await eventCount("scope = 'global'");
    await killSwitches.set('global', { active: true, reason: 'operator drill again' });
    assert.equal(await eventCount("scope = 'global'"), before, 'no-op operator writes do not spam the ledger');
    await killSwitches.set('global', { active: false, reason: 'drill over' });
    assert.equal(await killSwitches.isGlobalActive(), false);
    const row = await killSwitches['findRow']('global', null);
    assert.equal(row?.source, 'operator');
  });
});

/* -------------------------------------------------------------------------- */

describe('m8.6 environment-pinned global switch', () => {
  test('forced global makes every account see the stop and refuses clearing it', async () => {
    const forced = new KillSwitchService(pool, { globalForced: true });
    const user = await makeUser();

    assert.equal(forced.isGlobalForced(), true);
    assert.equal(await forced.isGlobalActive(), true);
    assert.equal((await forced.anyActive({ userId: user.id })).global, true);

    // No DB row was needed — the pin is independent of the table state.
    // A DB global row may exist too; clearing through the user path is refused
    // regardless (assertMutableScope fires first).
    await assert.rejects(
      () => forced.clear(user.id, { scope: 'global', reason: 'cannot unpin' }),
      (err: any) => err.code === 'forbidden',
    );
    // Even the low-level operator write cannot defeat the pin: the DECISION
    // path (isGlobalActive) keeps reporting ON while the environment says so.
    await forced.set('global', { active: false, reason: 'operator tried to unpin' });
    assert.equal(await forced.isGlobalActive(), true, 'the pin survives a row write');
    const unforced = await new KillSwitchService(pool).isGlobalActive();
    assert.equal(unforced, false, '…and the DB row itself was indeed written inactive — the PIN is at the decision layer');
    const st = await new SafetyControlsService(pool, {
      killSwitches: forced,
      automation: new AutomationService(pool, forced, audit),
      audit,
    }).getStatus(user.id);
    assert.match(st.global.reason ?? '', /environment/i, 'status names the environment as the reason');
    await forced.set('global', { active: false, reason: 'cleanup' });
  });

  test('gate 6 + automation status both reflect the pin (fail-closed)', async () => {
    const forcedService = new SafetyControlsService(pool, {
      killSwitches: new KillSwitchService(pool, { globalForced: true }),
      automation: new AutomationService(pool, new KillSwitchService(pool, { globalForced: true }), audit),
      audit,
    });
    const user = await makeUser();
    const status = await forcedService.getStatus(user.id);
    assert.equal(status.globalForcedByEnvironment, true);
    assert.equal(status.global.active, true);
    assert.equal(status.anyActive, true);
    assert.equal(status.automation.effective, false);
    assert.ok(status.global.reason && /environment/i.test(status.global.reason));

    // The pure gate function — fed what the forced service reports — refuses
    // at kill_switch even with everything else ideal.
    const gate = evaluateExecutionGates({
      authenticated: true,
      authorized: true,
      // Hypothetical future entitlement — the pure gate only consumes the
      // fields it checks; today NO plan carries it (that itself is asserted
      // by the M8.1 suites and the API suite below).
      entitlements: { ...getEntitlements('premium', 'active'), canAccessAutomation: true },
      automation: { entitled: true, automationEnabled: true },
      profile: { enabled: true, environment: 'paper' },
      killSwitches: { global: true, user: false, strategy: false, profile: false },
      decision: null,
      setup: null,
      instrumentKnown: false,
      riskDecision: null,
      minRr: null,
      exposureWithinLimits: null,
      providerHealth: null,
      environmentSafe: true,
      brokerAuthorized: true,
      accountAuthorized: true,
    });
    assert.equal(gate.passed, false);
    assert.equal(gate.failedGate, 'kill_switch');
    assert.match(gate.reason ?? '', /global kill switch/i);
  });
});

/* -------------------------------------------------------------------------- */

describe('m8.6 automation switch — safety asymmetry', () => {
  test('disable is always allowed (no entitlement), enable stays gated', async () => {
    const user = await makeUser();
    // Free plan, switch already OFF: turning it OFF is a no-op that must NOT 403.
    const status = await automation.setAutomationEnabled(user.id, false, { ip: null, userAgent: null });
    assert.equal(status.automationEnabled, false);
    // Turning it ON still requires the entitlement — refused for every plan here.
    await assert.rejects(
      () => automation.setAutomationEnabled(user.id, true),
      (err: any) => err.code === 'forbidden',
    );
    const audits = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [user.id],
    );
    assert.equal(audits.rows[0]?.action, 'execution.automation_disabled', 'even a no-op OFF is audited');
  });

  test('the kill switch outranks every plan claim: armed ⇒ 409, cleared ⇒ entitlement decides', async () => {
    const user = await makeUser();
    // Model C: registration provisions no subscription row, so the fixture
    // seeds the historical (provider IS NULL) premium row this test claims.
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'premium', 'active')
       ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan`,
      [user.id],
    );
    await killSwitches.set('user', { targetId: user.id, active: true, reason: 'armed during incident' });

    await assert.rejects(
      () => automation.setAutomationEnabled(user.id, true),
      (err: any) => err.code === 'conflict' && /kill switch/i.test(err.message),
      'a stop is named FIRST — the refusal is about the switch, not the plan',
    );
    const status = await automation.getStatus(user.id);
    assert.equal(status.automationEnabled, false, 'refusal left the switch OFF');

    // After clearing, the (still absent) entitlement decides. The important
    // regression: the kill switch check cannot be used to bypass entitlement.
    await killSwitches.set('user', { targetId: user.id, active: false, reason: 'incident closed' });
    await assert.rejects(
      () => automation.setAutomationEnabled(user.id, true),
      (err: any) => err.code === 'forbidden',
      'premium carries NO automation entitlement (pinned since M8.1)',
    );
    assert.equal((await automation.getStatus(user.id)).automationEnabled, false);
  });
});

/* -------------------------------------------------------------------------- */

describe('m8.6 loss-limit circuit breaker', () => {
  test('a daily-loss rejection trips the user kill switch durably and idempotently', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);

    // No breaker yet: a valid decision passes.
    const first = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR,
    });
    assert.equal(first.outcome, 'approved');
    assert.equal(await killSwitches.isUserActive(user.id), false);
    await risk.releaseReservation(first.id);

    // Server-owned P&L: one big loss breaches the 3%-of-equity daily cap.
    await risk.recordRealizedPl({ userId: user.id, executionProfileId: profile.id, realizedPl: -1000, nowMs: ANCHOR });

    const second = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 60_000,
    });
    assert.equal(second.outcome, 'rejected');
    assert.equal(second.rejectionCode, 'DAILY_LOSS_LIMIT');

    // The DURABLE stop — this is the M8.6 strengthening.
    assert.equal(await killSwitches.isUserActive(user.id), true);
    const row = await killSwitches['findRow']('user', user.id);
    assert.equal(row?.source, 'circuit_breaker');
    assert.match(row?.reason ?? '', /circuit breaker/i);
    assert.match(row?.reason ?? '', /DAILY_LOSS_LIMIT/);

    // Idempotency: a second rejection does not re-trip (single event row,
    // first reason preserved).
    const before = await eventCount("user_id = $1 AND source = 'circuit_breaker'", [user.id]);
    const third = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 120_000,
    });
    assert.equal(third.outcome, 'rejected');
    assert.equal(third.rejectionCode, 'KILL_SWITCH_ACTIVE', 'from now on the armed switch is the blocker');
    assert.equal(
      await eventCount("user_id = $1 AND source = 'circuit_breaker'", [user.id]),
      before,
      'no event spam while the switch stays armed',
    );

    // The breaker shows in the safety status + automation reasons.
    const status = await safety.getStatus(user.id);
    assert.equal(status.circuitBreaker.active, true);
    assert.match(status.circuitBreaker.reason ?? '', /DAILY_LOSS_LIMIT/);
    assert.ok(status.circuitBreaker.trippedAt);
    const auto = await automation.getStatus(user.id);
    assert.ok(auto.reasons.includes('user_kill_switch_active'));

    // Audits for the trip itself.
    const tripAudit = await pool.query(
      `SELECT metadata FROM audit_events WHERE user_id = $1 AND action = 'safety.circuit_breaker_tripped'`,
      [user.id],
    );
    assert.equal(tripAudit.rowCount, 1);
    assert.equal((tripAudit.rows[0] as any).metadata.code, 'DAILY_LOSS_LIMIT');

    // Only an explicit, reason-carrying clear re-arms trading — a win in the
    // meantime does NOT auto-disarm (deliberate).
    await risk.recordRealizedPl({ userId: user.id, executionProfileId: profile.id, realizedPl: 500, nowMs: ANCHOR + 180_000 });
    assert.equal(await killSwitches.isUserActive(user.id), true);
    const cleared = await safety.clear(user.id, { scope: 'user', reason: 'reviewed losses; resuming with smaller size' });
    assert.equal(cleared.changed, true);
    const fourth = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 240_000,
    });
    assert.equal(fourth.outcome, 'rejected', 'still inside the daily loss window');
    assert.equal(fourth.rejectionCode, 'DAILY_LOSS_LIMIT');
    assert.notEqual(fourth.rejectionCode, 'KILL_SWITCH_ACTIVE');
  });

  test('consecutive-loss breach trips it (isolated from the daily cap)', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);
    // Generous money caps so ONLY the streak fires.
    await risk.updatePolicy(user.id, { maxDailyLossPct: 5, maxWeeklyLossPct: 10, maxConsecutiveLosses: 3 });
    for (let i = 0; i < 3; i += 1) {
      await risk.recordRealizedPl({
        userId: user.id,
        executionProfileId: profile.id,
        realizedPl: -100,
        nowMs: ANCHOR + i * 60_000,
      });
    }
    const verdict = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 4 * 60_000,
    });
    assert.equal(verdict.outcome, 'rejected');
    assert.ok(verdict.violations.includes('CONSECUTIVE_LOSS_LIMIT'));
    assert.ok(!verdict.violations.includes('DAILY_LOSS_LIMIT'), 'the daily cap must NOT have fired');
    assert.equal(await killSwitches.isUserActive(user.id), true, 'streak breach must trip the breaker');
  });

  test('weekly-loss breach trips it (isolated from the daily cap)', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);
    await risk.updatePolicy(user.id, { maxDailyLossPct: 5, maxWeeklyLossPct: 10, maxConsecutiveLosses: 3 });
    const DAY = 86_400_000;
    // Four days inside ONE UTC week: -490, +50, -490, +50 → daily never ≥ 500,
    // streak reset by the green days, weekly at -880 → then a small day-5
    // loss of -160 crosses 1000 with only the weekly code firing.
    const plan: Array<[number, number]> = [[0, -490], [1, 50], [3, -490], [4, 50], [5, -160]];
    for (const [dayOffset, pl] of plan) {
      await risk.recordRealizedPl({
        userId: user.id,
        executionProfileId: profile.id,
        realizedPl: pl,
        nowMs: ANCHOR + dayOffset * DAY,
      });
    }
    const verdict = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 5 * DAY + 60_000,
    });
    assert.equal(verdict.outcome, 'rejected');
    assert.ok(verdict.violations.includes('WEEKLY_LOSS_LIMIT'), JSON.stringify(verdict.violations));
    assert.ok(!verdict.violations.includes('DAILY_LOSS_LIMIT'), 'daily cap must not fire');
    assert.ok(!verdict.violations.includes('CONSECUTIVE_LOSS_LIMIT'), 'streak must not fire');
    assert.equal(await killSwitches.isUserActive(user.id), true, 'weekly breach must trip the breaker');
  });

  test('a NON-loss rejection never trips it', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);
    const bad = { ...makeDecision(ids), stopLossPrice: 1.2 }; // SL on the wrong side
    const verdict = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: bad as any,
      nowMs: ANCHOR,
    });
    assert.equal(verdict.outcome, 'rejected');
    assert.equal(await killSwitches.isUserActive(user.id), false, 'RR/level rejections do not stop the account');
  });

  test('the breaker never blocks the risk call itself if switching fails (decision stands)', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);
    await risk.recordRealizedPl({ userId: user.id, executionProfileId: profile.id, realizedPl: -1000, nowMs: ANCHOR });
    // Simulate a kill-switch ledger outage for THIS user only by making the
    // events insert fail: temporarily drop the append-only trigger is NOT
    // allowed, so instead assert the promise contract directly —
    // evaluate() must resolve (not reject) even when the trip path errors.
    const spy = killSwitches.tripCircuitBreaker.bind(killSwitches);
    (killSwitches as any).tripCircuitBreaker = async () => {
      throw new Error('simulated ledger outage');
    };
    try {
      const verdict = await risk.evaluate({
        userId: user.id,
        executionProfileId: profile.id,
        decision: makeDecision(ids),
        nowMs: ANCHOR + 60_000,
      });
      assert.equal(verdict.outcome, 'rejected', 'the decision still persisted fail-closed');
    } finally {
      (killSwitches as any).tripCircuitBreaker = spy;
    }
    // And because rejections repeat, the retry semantics hold: next call trips.
    await risk.recordRealizedPl({ userId: user.id, executionProfileId: profile.id, realizedPl: -1, nowMs: ANCHOR + 120_000 });
    const second = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 180_000,
    });
    assert.equal(second.outcome, 'rejected');
    assert.equal(await killSwitches.isUserActive(user.id), true, 'the durable trip landed on retry');
  });
});

/* -------------------------------------------------------------------------- */

describe('m8.6 emergency stop', () => {
  test('one call: switch armed + automation OFF + profiles disabled, all audited', async () => {
    const user = await makeUser();
    // A hypothetical armed account can only be simulated at the DB layer
    // (no plan grants the entitlement — that is the point). Emergency stop
    // must still be able to force it OFF.
    await pool.query('UPDATE users SET automation_enabled = true WHERE id = $1', [user.id]);
    const paperProfile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    assert.equal((await automation.getStatus(user.id)).automationEnabled, true);

    const result = await safety.emergencyStop(user.id, 'suspected stale candles during incident');
    assert.equal(result.stopped, true);
    assert.equal(result.killSwitchActivated, true);
    assert.equal(result.automationWasEnabled, true);
    assert.equal(result.automationDisabled, true);
    assert.ok(result.profilesDisabled >= 1);

    assert.equal(await killSwitches.isUserActive(user.id), true);
    const auto = await automation.getStatus(user.id);
    assert.equal(auto.automationEnabled, false, 'the explicit switch was forced OFF');
    const listed = await profiles.listForUser(user.id);
    const profile = listed.profiles.find((p) => p.id === paperProfile.id);
    assert.equal(profile?.enabled, false, 'the profile is disabled too');

    // Status snapshot returned by the call is the refreshed truth and parses
    // the pinned contract shape.
    assert.equal(result.status.anyActive, true);
    assert.equal(killSwitchStatusDtoSchema.safeParse(result.status).success, true);

    // Auditability: both ledgers.
    const auditRow = await pool.query(
      `SELECT metadata FROM audit_events WHERE user_id = $1 AND action = 'safety.emergency_stop'`,
      [user.id],
    );
    assert.equal(auditRow.rowCount, 1);
    const execEvent = await pool.query(
      `SELECT event, reason FROM execution_events WHERE user_id = $1 AND event = 'emergency_stop'`,
      [user.id],
    );
    assert.equal(execEvent.rowCount, 1);
    assert.equal((execEvent.rows[0] as any).reason, 'suspected stale candles during incident');
    const ksEvents = await pool.query(
      `SELECT metadata FROM kill_switch_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [user.id],
    );
    assert.equal((ksEvents.rows[0] as any).metadata.path, 'emergency_stop');

    // Re-running is SAFE and idempotent in state, but still recorded as an
    // attempt (changed=false).
    const again = await safety.emergencyStop(user.id, 'second press (replay)');
    assert.equal(again.killSwitchActivated, false);
    assert.equal(again.profilesDisabled, 0);
    assert.equal(again.automationDisabled, false, 'was already off');
    const events = await safety.history(user.id, 10);
    assert.equal(events.events[0]?.action, 'activated');
    assert.equal(events.events[0]?.changed, false);

    // Entries refused while stopped (gate 6 view through the real service).
    const ids = await makeSetup(user.id);
    const verdict = await risk.evaluate({
      userId: user.id,
      executionProfileId: paperProfile.id,
      decision: makeDecision(ids),
      nowMs: Date.now(),
    });
    assert.equal(verdict.outcome, 'rejected');
    assert.equal(verdict.rejectionCode, 'KILL_SWITCH_ACTIVE');
  });

  test('default reason applies when the body omits one', async () => {
    const user = await makeUser();
    const result = await safety.emergencyStop(user.id);
    assert.equal(result.stopped, true);
    const row = await killSwitches['findRow']('user', user.id);
    assert.match(row?.reason ?? '', /Emergency stop requested from the account UI/);
  });

  test('a concurrent double-tap cannot split state (advisory lock serializes)', async () => {
    const user = await makeUser();
    const [a, b] = await Promise.all([
      safety.emergencyStop(user.id, 'tap one'),
      safety.emergencyStop(user.id, 'tap two'),
    ]);
    const activated = [a.killSwitchActivated, b.killSwitchActivated];
    assert.equal(activated.filter(Boolean).length, 1, 'exactly one tap armed the switch');
    assert.equal(await killSwitches.isUserActive(user.id), true);
    const changedEvents = await eventCount("user_id = $1 AND changed = true", [user.id]);
    assert.equal(changedEvents, 1, 'one real transition recorded');
  });
});

/* -------------------------------------------------------------------------- */

describe('m8.6 read models + tenant isolation', () => {
  test('status DTO is complete for a user with strategies + profiles + switches', async () => {
    const user = await makeUser();
    const strategyId = await makeStrategy(user.id, 'Session momentum');
    await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await safety.activate(user.id, { scope: 'strategy', targetId: strategyId, reason: 'tuning filters' });

    const status = await safety.getStatus(user.id);
    assert.equal(killSwitchStatusDtoSchema.safeParse(status).success, true, JSON.stringify((killSwitchStatusDtoSchema.safeParse(status) as any).error?.issues ?? {}));
    assert.equal(status.anyActive, true);
    assert.equal(status.strategies.length, 1);
    assert.equal(status.profiles.length, 1);
    assert.equal(status.global.active, false);
    assert.equal(status.user.active, false);

    // The other user sees NOTHING of this.
    const other = await makeUser();
    const otherStatus = await safety.getStatus(other.id);
    assert.equal(otherStatus.anyActive, false);
    assert.equal(otherStatus.strategies.length, 0);
    assert.deepEqual((await safety.history(other.id, 50)).events, []);
    const leaked = await safety.history(user.id, 50);
    assert.ok(leaked.events.every((e) => e.scope !== 'global' || e.entityLabel === 'platform'));
  });

  test('history reads are bounded and never contain credential-shaped text', async () => {
    const user = await makeUser();
    for (let i = 0; i < 4; i += 1) {
      await safety.activate(user.id, { scope: 'user', reason: `bounded read drill ${i}` });
    }
    const page = await safety.history(user.id, 3);
    assert.equal(page.events.length, 3);
    assert.ok(page.events.every((e) => Number(e.id) > 0));
    const blob = JSON.stringify(page);
    for (const needle of ['password', 'apikey', 'api_key', 'token', 'secret']) {
      assert.ok(!blob.toLowerCase().includes(needle));
    }
  });

  test('a kill switch NEVER blocks position-exit evaluation (risk reduction stays open)', async () => {
    // Pinned at the gate-contract level: close/evaluate flows deliberately do
    // not carry the kill_switch gate — only ENTRY gates do.
    assert.ok(PAPER_SIMULATION_GATE_IDS.includes('kill_switch'), 'entry gates DO check it');
    const src = await import('node:fs/promises');
    const service = await src.readFile(new URL('../src/execution/paper-service.ts', import.meta.url), 'utf8');
    const closeFn = service.slice(
      service.indexOf('async closePosition('),
      service.indexOf('private async evaluatePosition('),
    );
    assert.ok(closeFn.length > 0);
    assert.ok(!/killSwitch/i.test(closeFn), 'closing a position must not consult the switch');
    const evalFn = service.slice(
      service.indexOf('async evaluateOpenPositions('),
      service.indexOf('async closePosition('),
    );
    assert.ok(!/killSwitches\.anyActive/.test(evalFn), 'exit evaluation must not consult the switch');
  });
});
