/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M8.1 — execution architecture (safety boundary) core tests.
 *
 * Proven against a real embedded Postgres:
 *  - order state machine (valid + invalid transitions, absorbing terminals)
 *  - DB constraints: live impossible, unique intents, order CHECKs
 *  - gates: every one of the 15 gates fail-closed at the contract level
 *  - intake: decision validation, ownership masking, entitlement refusal,
 *    idempotency (sequential replay + concurrent twins), audit trail
 *  - provider boundary: paper not-ready, every trade op throws, taxonomy
 *  - kill switch semantics + automation switch gating
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  ExecutionProviderError,
  isExecutionProviderError,
  type ExecutionDecisionInput,
  type ExecutionProvider,
  type UserPlan,
} from '@veltrixeye/contracts';
import {
  AuditService,
  AutomationService,
  ExecutionIntakeService,
  ExecutionProfileService,
  ExecutionQueryService,
  KillSwitchService,
  UserService,
  assertOrderTransition,
  allowedOrderTransitions,
  createExecutionProviderRegistry,
  createPaperExecutionProvider,
  createPool,
  deriveClientOrderId,
  evaluateExecutionGates,
  executionIdempotencyHash,
  getEntitlements,
  isOrderTerminal,
  runMigrations,
  MIGRATIONS_DIR,
  type ExecutionGateInput,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5443;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_execution';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;
let killSwitches: KillSwitchService;
let automation: AutomationService;
let profiles: ExecutionProfileService;
let intake: ExecutionIntakeService;
let queries: ExecutionQueryService;
let registry: ReturnType<typeof createExecutionProviderRegistry>;

const uniqueEmail = () => `exec_${randomBytes(6).toString('hex')}@example.com`;
const ANCHOR = 1_700_000_000_000;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-execution');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({ dataDir, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);

  users = new UserService(pool);
  audit = new AuditService(pool);
  registry = createExecutionProviderRegistry();
  registry.register(createPaperExecutionProvider());
  killSwitches = new KillSwitchService(pool);
  automation = new AutomationService(pool, killSwitches, audit);
  profiles = new ExecutionProfileService(pool, registry, audit);
  intake = new ExecutionIntakeService(pool, { automation, killSwitches, providers: registry, audit });
  queries = new ExecutionQueryService(pool);
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

async function makeUser(plan: UserPlan = 'free'): Promise<{ id: string }> {
  const user = await users.create({ email: uniqueEmail(), passwordHash: 'x'.repeat(32), name: 'Exec Tester' });
  if (plan !== 'free') {
    await pool.query('UPDATE subscriptions SET plan = $1 WHERE user_id = $2', [plan, user.id]);
  }
  return { id: user.id };
}

/** Seed a strategy + published version + confirmed setup owned by `userId`. */
async function makeSetup(userId: string): Promise<{
  strategyId: string;
  versionId: string;
  setupId: string;
  instrumentId: string;
}> {
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, 'exec test strategy'],
  );
  const strategyId = strategy.rows[0]!.id;
  const version = await pool.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by, published_at)
     VALUES ($1, 1, 'published', $2, now()) RETURNING id`,
    [strategyId, userId],
  );
  const versionId = version.rows[0]!.id;
  const instrument = await pool.query<{ id: string }>(
    `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'`,
  );
  const instrumentId = instrument.rows[0]!.id;
  const setup = await pool.query<{ id: string }>(
    `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms)
     VALUES ($1, $2, 'confirmed', 'long', now(), $3) RETURNING id`,
    [versionId, instrumentId, ANCHOR],
  );
  return { strategyId, versionId, setupId: setup.rows[0]!.id, instrumentId };
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

const PREMIUM_ENTITLEMENTS = getEntitlements('premium', 'active');

/** A fully-passing gate input; each test mutates exactly one ingredient. */
function passingGateInput(overrides: Partial<ExecutionGateInput> = {}): ExecutionGateInput {
  return {
    authenticated: true,
    authorized: true,
    entitlements: { ...PREMIUM_ENTITLEMENTS, canAccessAutomation: true },
    automation: { entitled: true, automationEnabled: true },
    profile: { enabled: true, environment: 'paper' },
    killSwitches: { global: false, user: false, strategy: false, profile: false },
    decision: {
      strategyId: 's',
      strategyVersionId: 'v',
      setupId: 'setup',
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
    },
    setup: { id: 'setup', direction: 'long', state: 'confirmed' },
    instrumentKnown: true,
    riskDecision: { approved: true },
    minRr: 2,
    exposureWithinLimits: true,
    providerHealth: { healthy: true },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('m8.1 order state machine', () => {
  test('the happy path walks requested → filled', () => {
    assert.doesNotThrow(() => assertOrderTransition('requested', 'validating'));
    assert.doesNotThrow(() => assertOrderTransition('validating', 'submitted'));
    assert.doesNotThrow(() => assertOrderTransition('submitted', 'accepted'));
    assert.doesNotThrow(() => assertOrderTransition('accepted', 'partially_filled'));
    assert.doesNotThrow(() => assertOrderTransition('partially_filled', 'partially_filled'));
    assert.doesNotThrow(() => assertOrderTransition('partially_filled', 'filled'));
  });

  test('failure and cancellation paths exist at the right stages', () => {
    assert.doesNotThrow(() => assertOrderTransition('requested', 'rejected'));
    assert.doesNotThrow(() => assertOrderTransition('validating', 'failed'));
    assert.doesNotThrow(() => assertOrderTransition('submitted', 'expired'));
    assert.doesNotThrow(() => assertOrderTransition('accepted', 'cancelled'));
    assert.doesNotThrow(() => assertOrderTransition('partially_filled', 'cancelled'));
  });

  test('invalid transitions are rejected (filled → pending-like, backwards, skipping)', () => {
    assert.throws(() => assertOrderTransition('filled', 'requested'), /terminal status/);
    assert.throws(() => assertOrderTransition('rejected', 'submitted'), /terminal status/);
    assert.throws(() => assertOrderTransition('accepted', 'validating'), /Cannot transition/);
    assert.throws(() => assertOrderTransition('submitted', 'filled'), /Cannot transition/);
    assert.throws(() => assertOrderTransition('requested', 'accepted'), /Allowed:/);
    assert.throws(() => assertOrderTransition('accepted', 'accepted'), /already in status/);
  });

  test('terminals are absorbing and expose no exits', () => {
    for (const terminal of ['filled', 'rejected', 'cancelled', 'expired', 'failed'] as const) {
      assert.equal(isOrderTerminal(terminal), true);
      assert.deepEqual(allowedOrderTransitions(terminal), []);
    }
    assert.equal(isOrderTerminal('submitted'), false);
  });
});

describe('m8.1 database constraints', () => {
  test('a live execution profile is impossible at the storage layer', async () => {
    const user = await makeUser();
    let err: unknown = null;
    try {
      await pool.query(
        `INSERT INTO execution_profiles (user_id, mode, environment, provider_slug)
         VALUES ($1, 'live', 'live', 'some-broker')`,
        [user.id],
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'CHECK must refuse environment = live');
  });

  test('order rows refuse invalid status, side and non-positive quantity', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const base = {
      userId: user.id,
      profileId: profile.id,
    };
    const attempt = async (sql: string, values: unknown[]) => {
      let err: unknown = null;
      try {
        await pool.query(sql, values);
      } catch (e) {
        err = e;
      }
      assert.ok(err, `expected CHECK failure: ${sql}`);
    };
    const insert = (cols: string) =>
      `INSERT INTO execution_orders (user_id, execution_profile_id, client_order_id, provider_slug,
         asset_class, symbol, side, order_type, quantity, status, idempotency_key, architecture_version)
       VALUES ($1, $2, ${cols})`;
    await attempt(insert(`'co-1', 'paper', 'forex', 'EURUSD', 'buy', 'market', 1, 'pending', repeat('a', 64), 'm8.1'`), [
      base.userId,
      base.profileId,
    ]);
    await attempt(insert(`'co-2', 'paper', 'forex', 'EURUSD', 'sideways', 'market', 1, 'requested', repeat('b', 64), 'm8.1'`), [
      base.userId,
      base.profileId,
    ]);
    await attempt(insert(`'co-3', 'paper', 'forex', 'EURUSD', 'buy', 'market', 0, 'requested', repeat('c', 64), 'm8.1'`), [
      base.userId,
      base.profileId,
    ]);
  });

  test('client_order_id and idempotency_key are globally unique on orders', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const idem = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO execution_orders (user_id, execution_profile_id, client_order_id, provider_slug,
         asset_class, symbol, side, order_type, quantity, status, idempotency_key, architecture_version)
       VALUES ($1, $2, 've-dupcheck1', 'paper', 'forex', 'EURUSD', 'buy', 'market', 1, 'requested', $3, 'm8.1')`,
      [user.id, profile.id, idem],
    );
    let dupErr: unknown = null;
    try {
      await pool.query(
        `INSERT INTO execution_orders (user_id, execution_profile_id, client_order_id, provider_slug,
           asset_class, symbol, side, order_type, quantity, status, idempotency_key, architecture_version)
         VALUES ($1, $2, 've-dupcheck1', 'paper', 'forex', 'EURUSD', 'buy', 'market', 1, 'requested', $3, 'm8.1')`,
        [user.id, profile.id, idem],
      );
    } catch (e) {
      dupErr = e;
    }
    assert.ok(dupErr, 'duplicate client_order_id must be refused');
  });
});

describe('m8.1 safety gates (contract level)', () => {
  test('all 15 gates passing yields acceptance', () => {
    const result = evaluateExecutionGates(passingGateInput());
    assert.equal(result.passed, true);
    assert.equal(result.failedGate, null);
    assert.equal(result.evaluated.length, 15);
  });

  test('each gate fails closed in order', () => {
    const cases: Array<{ name: string; override: Partial<ExecutionGateInput>; gate: string }> = [
      { name: 'authentication', override: { authenticated: false }, gate: 'authenticated' },
      { name: 'authorization', override: { authorized: false }, gate: 'authorized' },
      {
        name: 'entitlement',
        override: { entitlements: { ...PREMIUM_ENTITLEMENTS, canAccessAutomation: false } },
        gate: 'entitlement',
      },
      {
        name: 'automation off',
        override: { automation: { entitled: true, automationEnabled: false } },
        gate: 'automation_on',
      },
      { name: 'profile missing', override: { profile: null }, gate: 'profile_enabled' },
      {
        name: 'profile disabled',
        override: { profile: { enabled: false, environment: 'paper' } },
        gate: 'profile_enabled',
      },
      {
        name: 'environment not paper',
        override: { profile: { enabled: true, environment: 'demo' } },
        gate: 'profile_enabled',
      },
      {
        name: 'global kill switch',
        override: { killSwitches: { global: true, user: false, strategy: false, profile: false } },
        gate: 'kill_switch',
      },
      {
        name: 'user kill switch',
        override: { killSwitches: { global: false, user: true, strategy: false, profile: false } },
        gate: 'kill_switch',
      },
      {
        name: 'strategy kill switch',
        override: { killSwitches: { global: false, user: false, strategy: true, profile: false } },
        gate: 'kill_switch',
      },
      {
        name: 'profile kill switch',
        override: { killSwitches: { global: false, user: false, strategy: false, profile: true } },
        gate: 'kill_switch',
      },
      { name: 'missing signal', override: { decision: null }, gate: 'valid_signal' },
      { name: 'missing setup', override: { setup: null }, gate: 'valid_signal' },
      {
        name: 'ineligible setup state',
        override: { setup: { id: 'setup', direction: 'long', state: 'developing' } },
        gate: 'valid_signal',
      },
      {
        name: 'low quality signal',
        override: {
          decision: { ...passingGateInput().decision!, qualityScore: 40 },
        },
        gate: 'valid_signal',
      },
      { name: 'missing risk decision', override: { riskDecision: null }, gate: 'risk_decision' },
      {
        name: 'rejected risk decision',
        override: { riskDecision: { approved: false, reason: 'daily loss limit' } },
        gate: 'risk_decision',
      },
      { name: 'unknown symbol', override: { instrumentKnown: false }, gate: 'valid_symbol' },
      {
        name: 'invalid stop loss',
        override: {
          decision: { ...passingGateInput().decision!, stopLossPrice: 1.2 },
        },
        gate: 'valid_stop_loss',
      },
      {
        name: 'invalid take profit',
        override: {
          decision: { ...passingGateInput().decision!, takeProfitPrice: 1.05 },
        },
        gate: 'valid_take_profit',
      },
      {
        name: 'unacceptable RR',
        override: {
          decision: { ...passingGateInput().decision!, expectedRr: 1.5 },
          minRr: 2,
        },
        gate: 'acceptable_rr',
      },
      { name: 'exposure not evaluated', override: { exposureWithinLimits: null }, gate: 'exposure_limits' },
      { name: 'exposure exceeded', override: { exposureWithinLimits: false }, gate: 'exposure_limits' },
      { name: 'provider health unknown', override: { providerHealth: null }, gate: 'provider_healthy' },
      {
        name: 'provider unhealthy',
        override: { providerHealth: { healthy: false } },
        gate: 'provider_healthy',
      },
    ];

    for (const c of cases) {
      const result = evaluateExecutionGates(passingGateInput(c.override));
      assert.equal(result.passed, false, `case "${c.name}" must fail`);
      assert.equal(result.failedGate, c.gate, `case "${c.name}" must fail at ${c.gate}`);
      assert.ok(result.reason && result.reason.length > 0);
    }
  });

  test('evaluation stops at the FIRST failing gate (pinned order)', () => {
    const result = evaluateExecutionGates(
      passingGateInput({
        entitlements: { ...PREMIUM_ENTITLEMENTS, canAccessAutomation: false },
        riskDecision: null, // would fail later — must not be reached
      }),
    );
    assert.equal(result.failedGate, 'entitlement');
    assert.ok(!result.evaluated.includes('risk_decision'));
  });
});

describe('m8.1 execution profiles', () => {
  test('paper profile creation succeeds and is owner-scoped', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const profile = await profiles.createProfile(owner.id, { mode: 'paper', providerSlug: 'paper' });
    assert.equal(profile.mode, 'paper');
    assert.equal(profile.environment, 'paper');
    assert.equal(profile.providerSlug, 'paper');
    assert.equal(profile.enabled, true);

    const mine = await profiles.listForUser(owner.id);
    assert.equal(mine.profiles.length, 1);
    const theirs = await profiles.listForUser(stranger.id);
    assert.equal(theirs.profiles.length, 0);

    await assert.rejects(
      async () => profiles.getForUser(stranger.id, profile.id),
      (err: any) => err.code === 'not_found',
      'foreign profile access must be a masked 404',
    );
  });

  test('demo and live profile creation are refused server-side', async () => {
    const user = await makeUser();
    await assert.rejects(
      async () => profiles.createProfile(user.id, { mode: 'demo', providerSlug: 'paper' }),
      (err: any) => err.code === 'forbidden',
    );
    await assert.rejects(
      async () => profiles.createProfile(user.id, { mode: 'live', providerSlug: 'paper' }),
      (err: any) => err.code === 'forbidden',
    );
  });

  test('unknown providers cannot be named into existence', async () => {
    const user = await makeUser();
    await assert.rejects(
      async () => profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'exness-mt5' }),
      (err: any) => err.code === 'invalid_input',
    );
  });

  test('one profile per (user, mode)', async () => {
    const user = await makeUser();
    await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await assert.rejects(
      async () => profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' }),
      (err: any) => err.code === 'conflict',
    );
  });
});

describe('m8.1 automation control', () => {
  test('status is OFF by default with machine-readable reasons', async () => {
    const user = await makeUser('premium');
    const status = await automation.getStatus(user.id);
    assert.equal(status.entitled, false, 'no plan carries the automation entitlement in M8.1');
    assert.equal(status.automationEnabled, false);
    assert.equal(status.effective, false);
    assert.ok(status.reasons.includes('entitlement_not_granted'));
    assert.ok(status.reasons.includes('automation_switch_off'));
  });

  test('the switch cannot be flipped without the entitlement (403 for every plan)', async () => {
    for (const plan of ['free', 'pro', 'premium'] as UserPlan[]) {
      const user = await makeUser(plan);
      await assert.rejects(
        async () => automation.setAutomationEnabled(user.id, true),
        (err: any) => err.code === 'forbidden',
        `plan ${plan} must not toggle automation`,
      );
      const status = await automation.getStatus(user.id);
      assert.equal(status.automationEnabled, false, `plan ${plan} flag must remain off`);
    }
  });

  test('kill switches surface in the automation status', async () => {
    const user = await makeUser();
    await killSwitches.set('user', { targetId: user.id, active: true, reason: 'test' });
    const status = await automation.getStatus(user.id);
    assert.equal(status.userKillSwitch, true);
    assert.ok(status.reasons.includes('user_kill_switch_active'));
    await killSwitches.set('user', { targetId: user.id, active: false, reason: 'test-clear' });
  });
});

describe('m8.1 kill switch service', () => {
  test('default state is OFF for every scope', async () => {
    const user = await makeUser();
    const state = await killSwitches.anyActive({ userId: user.id });
    assert.deepEqual(state, { active: false, global: false, user: false, strategy: false, profile: false });
  });

  test('global switch dominates all attempts', async () => {
    const user = await makeUser();
    await killSwitches.set('global', { active: true, reason: 'incident drill' });
    assert.equal(await killSwitches.isGlobalActive(), true);
    assert.equal((await killSwitches.anyActive({ userId: user.id })).active, true);
    await killSwitches.set('global', { active: false, reason: 'drill over' });
    assert.equal(await killSwitches.isGlobalActive(), false);
  });

  test('scoped switches only affect their target', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await killSwitches.set('user', { targetId: a.id, active: true, reason: 'user stop' });
    assert.equal(await killSwitches.isUserActive(a.id), true);
    assert.equal(await killSwitches.isUserActive(b.id), false);
  });
});

describe('m8.1 execution intake', () => {
  test('invalid decisions are refused before touching state', async () => {
    const user = await makeUser('premium');
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await assert.rejects(
      async () =>
        intake.submitExecutionDecision({
          userId: user.id,
          executionProfileId: profile.id,
          decision: { literally: 'anything' },
        }),
      (err: any) => err.code === 'invalid_input',
    );
    const { requests } = await intake.listForUser(user.id, 10);
    assert.equal(requests.length, 0, 'invalid decisions must not persist');
  });

  test('foreign setups are masked 404s (no IDOR)', async () => {
    const victim = await makeUser();
    const attacker = await makeUser();
    const victimSetup = await makeSetup(victim.id);
    const profile = await profiles.createProfile(attacker.id, { mode: 'paper', providerSlug: 'paper' });
    await assert.rejects(
      async () =>
        intake.submitExecutionDecision({
          userId: attacker.id,
          executionProfileId: profile.id,
          decision: makeDecision(victimSetup),
        }),
      (err: any) => err.code === 'not_found',
    );
  });

  test('decisions that misquote the setup are refused', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await assert.rejects(
      async () =>
        intake.submitExecutionDecision({
          userId: user.id,
          executionProfileId: profile.id,
          decision: { ...makeDecision(setup), entryPrice: 9.99 },
        }),
      (err: any) => err.code === 'not_found' || err.code === 'invalid_input',
    );
    await assert.rejects(
      async () =>
        intake.submitExecutionDecision({
          userId: user.id,
          executionProfileId: profile.id,
          decision: { ...makeDecision(setup), symbol: 'BTCUSD' },
        }),
      (err: any) => err.code === 'invalid_input',
      'instrument mismatch must be refused',
    );
  });

  test('a well-formed request is persisted REJECTED at the entitlement gate (M8.1)', async () => {
    const user = await makeUser('premium');
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const result = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
      meta: { ip: '10.0.0.1', userAgent: 'audit-test' },
    });
    assert.equal(result.accepted, false, 'nothing may be accepted while the risk engine is absent');
    assert.equal(result.replayed, false);
    assert.equal(result.request.status, 'rejected');
    assert.equal(result.gate.failedGate, 'entitlement', 'automation entitlement is off for every plan');

    // Append-only execution audit trail was written.
    const events = await queries.listEvents(user.id, 10);
    assert.ok(events.events.some((e) => e.event === 'execution_rejected'));

    // Platform audit trail too.
    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE user_id = $1 AND action LIKE 'execution.%'`,
      [user.id],
    );
    assert.ok(auditRows.rows.some((r) => r.action === 'execution.rejected'));
  });

  test('duplicate submissions collapse onto one row (idempotent replay)', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const decision = makeDecision(setup);

    const first = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision,
    });
    const second = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision,
    });
    const third = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision: { ...decision, entryPrice: decision.entryPrice }, // identical content
    });

    assert.equal(first.request.id, second.request.id);
    assert.equal(first.request.id, third.request.id);
    assert.equal(second.replayed, true);
    assert.equal(third.replayed, true);

    const count = await pool.query('SELECT count(*)::int AS c FROM execution_requests WHERE setup_id = $1', [
      setup.setupId,
    ]);
    assert.equal(count.rows[0].c, 1, 'one intent ⇒ one row, forever');
  });

  test('concurrent twins never create duplicate requests', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const decision = makeDecision(setup);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        intake.submitExecutionDecision({ userId: user.id, executionProfileId: profile.id, decision }),
      ),
    );
    // The idempotency invariant: exactly ONE row no matter how many twins
    // raced. (The `replayed` flag only marks attempts that SAW an existing
    // row before inserting — under a true race several twins insert-blindly
    // and lose on the unique constraint instead; both paths converge on the
    // same row, which is what must never duplicate.)
    const ids = new Set(results.map((r) => r.request.id));
    assert.equal(ids.size, 1, '8 concurrent submissions must collapse to 1 row');
    const count = await pool.query('SELECT count(*)::int AS c FROM execution_requests WHERE setup_id = $1', [
      setup.setupId,
    ]);
    assert.equal(count.rows[0].c, 1, 'concurrent twins must never duplicate the request');
  });

  test('different intents for the same setup stay distinct (close vs open)', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const open = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
    });
    const close = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision: { ...makeDecision(setup), action: 'close_position' },
    });
    assert.notEqual(open.request.id, close.request.id);
  });

  test('a disabled profile is refused by the gates even past entitlement fixes', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await pool.query('UPDATE execution_profiles SET enabled = false WHERE id = $1', [profile.id]);
    const result = await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
    });
    assert.equal(result.accepted, false);
    // Entitlement still fails first in pinned order — the disabled profile is
    // additionally proven at gate level; both are verified here:
    assert.equal(result.gate.failedGate, 'entitlement');
    const gateOnly = evaluateExecutionGates(
      passingGateInput({ profile: { enabled: false, environment: 'paper' } }),
    );
    assert.equal(gateOnly.failedGate, 'profile_enabled');
  });

  test('an active kill switch refuses at the gate layer', async () => {
    const gate = evaluateExecutionGates(
      passingGateInput({ killSwitches: { global: true, user: false, strategy: false, profile: false } }),
    );
    assert.equal(gate.passed, false);
    assert.equal(gate.failedGate, 'kill_switch');
  });

  test('idempotency hashes and client order ids are stable + bounded', () => {
    const args = {
      userId: 'u',
      setupId: 's',
      executionProfileId: 'p',
      action: 'open_long' as const,
    };
    const h1 = executionIdempotencyHash(args);
    const h2 = executionIdempotencyHash(args);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
    const clientId = deriveClientOrderId(h1);
    assert.ok(clientId.length <= 64);
    assert.ok(clientId.startsWith('ve-'));
    assert.equal(deriveClientOrderId(h1), clientId);
  });
});

describe('m8.1 read models are owner-scoped', () => {
  test('orders and positions lists never cross users', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const profileA = await profiles.createProfile(a.id, { mode: 'paper', providerSlug: 'paper' });
    await pool.query(
      `INSERT INTO execution_orders (user_id, execution_profile_id, client_order_id, provider_slug,
         asset_class, symbol, side, order_type, quantity, status, idempotency_key, architecture_version)
       VALUES ($1, $2, 've-scope-1', 'paper', 'forex', 'EURUSD', 'buy', 'market', 1, 'requested', $3, 'm8.1')`,
      [a.id, profileA.id, randomBytes(32).toString('hex')],
    );
    await pool.query(
      `INSERT INTO execution_positions (user_id, execution_profile_id, provider_slug, asset_class, symbol,
         direction, quantity, average_entry_price, status)
       VALUES ($1, $2, 'paper', 'forex', 'EURUSD', 'long', 1, 1.1, 'open')`,
      [a.id, profileA.id],
    );

    const aOrders = await queries.listOrders(a.id, 50);
    const bOrders = await queries.listOrders(b.id, 50);
    assert.equal(aOrders.orders.length, 1);
    assert.equal(bOrders.orders.length, 0, 'user B must never see user A orders');

    const aPositions = await queries.listPositions(a.id, 50);
    const bPositions = await queries.listPositions(b.id, 50);
    assert.equal(aPositions.positions.length, 1);
    assert.equal(bPositions.positions.length, 0, 'user B must never see user A positions');
  });

  test('execution events are append-only', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await intake.submitExecutionDecision({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
    });
    let err: unknown = null;
    try {
      await pool.query('UPDATE execution_events SET event = $1', ['tampered']);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'append-only guard must refuse UPDATE');
  });
});

describe('m8.1 provider boundary', () => {
  test('paper provider reports honestly: configured=false, unhealthy, reason set', async () => {
    const paper = createPaperExecutionProvider();
    assert.equal(paper.id, 'paper');
    assert.equal(paper.configured, false);
    const health = await paper.health();
    assert.equal(health.healthy, false);
    assert.ok(health.reason && health.reason.length > 0);
    const described = paper.describe();
    assert.equal(described.configured, false);
    assert.ok(!JSON.stringify(described).toLowerCase().includes('password'));
  });

  test('every trading operation throws a normalized unavailable error', async () => {
    const paper = createPaperExecutionProvider();
    const req = {
      clientOrderId: 've-x',
      idempotencyKey: 'k',
      assetClass: 'forex' as const,
      symbol: 'EURUSD',
      side: 'buy' as const,
      orderType: 'market' as const,
      quantity: 1,
      requestedPrice: null,
      stopLossPrice: null,
      takeProfitPrice: null,
    };
    for (const op of [
      () => paper.submitOrder(req),
      () => paper.cancelOrder('p1'),
      () => paper.modifyOrder('p1', {}),
      () => paper.getOrder('p1'),
      () => paper.listOrders(),
      () => paper.listPositions(),
      () => paper.closePosition('p1'),
    ]) {
      let err: unknown = null;
      try {
        await op();
      } catch (e) {
        err = e;
      }
      assert.ok(isExecutionProviderError(err), 'every trade op must fail with a normalized error');
      assert.equal((err as ExecutionProviderError).category, 'unavailable');
    }
  });

  test('failure taxonomy travels through the registry unchanged', async () => {
    const reg = createExecutionProviderRegistry();
    const categories = [
      'authentication',
      'validation',
      'insufficient_funds',
      'market_closed',
      'rate_limited',
      'timeout',
      'unavailable',
      'rejected',
      'unknown',
    ] as const;
    for (const category of categories) {
      const fake: ExecutionProvider = {
        id: `fake-${category}`,
        name: `Fake ${category}`,
        capabilities: { modes: ['paper'], orderTypes: ['market'] },
        configured: true,
        describe: () => ({ category }),
        health: async () => ({ healthy: false, reason: category }),
        submitOrder: async () => {
          throw new ExecutionProviderError(category, `simulated ${category}`);
        },
        cancelOrder: async () => {},
        modifyOrder: async () => {},
        getOrder: async () => null,
        listOrders: async () => [],
        listPositions: async () => [],
        closePosition: async () => {},
      };
      reg.register(fake);
      const provider = reg.get(`fake-${category}`)!;
      let err: unknown = null;
      try {
        await provider.submitOrder({
          clientOrderId: 'co',
          idempotencyKey: 'k',
          assetClass: 'forex',
          symbol: 'EURUSD',
          side: 'buy',
          orderType: 'market',
          quantity: 1,
          requestedPrice: null,
          stopLossPrice: null,
          takeProfitPrice: null,
        });
      } catch (e) {
        err = e;
      }
      assert.ok(isExecutionProviderError(err));
      assert.equal((err as ExecutionProviderError).category, category);
    }
  });

  test('duplicate provider registration is refused', () => {
    const reg = createExecutionProviderRegistry();
    reg.register(createPaperExecutionProvider());
    assert.throws(() => reg.register(createPaperExecutionProvider()), /already registered/);
    assert.equal(reg.list().length, 1);
  });
});
