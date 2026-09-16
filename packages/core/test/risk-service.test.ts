/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M8.2 — risk engine service (real Postgres).
 *
 * Persistence, owner scoping, platform-ceiling CHECKs, kill-switch
 * integration, loss limits against server-owned P&L, concurrent
 * evaluations, reservations, and the fail-closed instrument-spec path.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  PLATFORM_RISK_CEILINGS,
  RISK_ENGINE_VERSION,
  type ExecutionDecisionInput,
  type UserPlan,
} from '@veltrixeye/contracts';
import {
  AuditService,
  KillSwitchService,
  RiskEngineService,
  UserService,
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  ExecutionProfileService,
  createExecutionProviderRegistry,
  createPaperExecutionProvider,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5448;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_risk';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;
let killSwitches: KillSwitchService;
let risk: RiskEngineService;
let profiles: ExecutionProfileService;

const uniqueEmail = () => `risk_${randomBytes(6).toString('hex')}@example.com`;
const ANCHOR = Date.UTC(2024, 0, 2, 12, 0, 0);

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-risk');
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
  risk = new RiskEngineService(pool, { killSwitches, audit });
  const registry = createExecutionProviderRegistry();
  registry.register(createPaperExecutionProvider());
  profiles = new ExecutionProfileService(pool, registry, audit);
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

async function makeUser(plan: UserPlan = 'free'): Promise<{ id: string }> {
  const user = await users.create({ email: uniqueEmail(), passwordHash: 'x'.repeat(32), name: 'Risk Tester' });
  if (plan !== 'free') {
    await pool.query('UPDATE subscriptions SET plan = $1 WHERE user_id = $2', [plan, user.id]);
  }
  return { id: user.id };
}

async function makeSetup(userId: string): Promise<{
  strategyId: string;
  versionId: string;
  setupId: string;
}> {
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `risk ${randomBytes(3).toString('hex')}`],
  );
  const strategyId = strategy.rows[0]!.id;
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

describe('m8.2 risk policy storage', () => {
  test('GET initializes a default policy inside the platform envelope', async () => {
    const user = await makeUser();
    const status = await risk.getPolicyStatus(user.id);
    assert.equal(status.engineVersion, RISK_ENGINE_VERSION);
    assert.equal(status.policy.riskPctPerTrade, 0.5);
    assert.equal(status.policy.minRr, 2);
    assert.equal(status.policy.paperEquity, PLATFORM_RISK_CEILINGS.defaultPaperEquity);
    assert.equal(status.platformCeilings.maxRiskPctPerTrade, 1);
    assert.ok(status.policy.riskPctPerTrade <= status.platformCeilings.maxRiskPctPerTrade);
  });

  test('a user may tighten risk %; 50% is refused by the schema CHECK', async () => {
    const user = await makeUser();
    const ok = await risk.updatePolicy(user.id, { riskPctPerTrade: 0.25 });
    assert.equal(ok.policy.riskPctPerTrade, 0.25);
    assert.ok(ok.policy.policyVersion >= 2);

    await assert.rejects(
      async () =>
        pool.query('UPDATE risk_policies SET risk_pct_per_trade = 50 WHERE user_id = $1', [user.id]),
      (err: any) => err.code === '23514',
      'CHECK must refuse 50% risk',
    );
    const after = await risk.getPolicyStatus(user.id);
    assert.equal(after.policy.riskPctPerTrade, 0.25, 'the illegal write did not land');
  });

  test('minRr below 2 cannot be persisted', async () => {
    const user = await makeUser();
    await risk.getPolicyStatus(user.id);
    await assert.rejects(
      async () => pool.query('UPDATE risk_policies SET min_rr = 1 WHERE user_id = $1', [user.id]),
      (err: any) => err.code === '23514',
    );
  });

  test('policies are owner-scoped (no cross-user leakage)', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await risk.updatePolicy(a.id, { riskPctPerTrade: 0.75 });
    const aStatus = await risk.getPolicyStatus(a.id);
    const bStatus = await risk.getPolicyStatus(b.id);
    assert.equal(aStatus.policy.riskPctPerTrade, 0.75);
    assert.equal(bStatus.policy.riskPctPerTrade, 0.5);
    assert.notEqual(aStatus.policy.id, bStatus.policy.id);
  });

  test('no credential columns exist on risk tables', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('risk_policies','risk_decisions','risk_account_states','instrument_risk_specs')`,
    );
    const cols = res.rows.map((r) => r.column_name.toLowerCase());
    for (const needle of ['password', 'api_key', 'apikey', 'secret', 'token', 'credential']) {
      assert.ok(!cols.some((c) => c.includes(needle)), `risk schema must not contain ${needle}`);
    }
  });
});

describe('m8.2 risk evaluation (service)', () => {
  test('a valid trade is approved with a persisted server-issued decision', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const decision = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
      nowMs: ANCHOR,
      reserveOnApprove: true,
    });
    assert.equal(decision.outcome, 'approved');
    assert.equal(decision.engineVersion, RISK_ENGINE_VERSION);
    assert.match(decision.id, /^[0-9a-f-]{36}$/);
    assert.equal(decision.rejectionCode, null);
    assert.ok(decision.positionSize && decision.positionSize > 0);
    assert.equal(decision.rr, 2);

    const listed = await risk.listDecisions(user.id, 10);
    assert.equal(listed.decisions.length, 1);
    assert.equal(listed.decisions[0]!.id, decision.id);

    await risk.releaseReservation(decision.id);
  });

  test('kill switch rejects even a otherwise-valid trade', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await killSwitches.set('user', { targetId: user.id, active: true, reason: 'test' });
    const decision = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
      nowMs: ANCHOR,
    });
    assert.equal(decision.outcome, 'rejected');
    assert.equal(decision.rejectionCode, 'KILL_SWITCH_ACTIVE');
    await killSwitches.set('user', { targetId: user.id, active: false, reason: 'clear' });
  });

  test('daily loss against server-owned P&L (client P&L is not an input)', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await risk.recordRealizedPl({
      userId: user.id,
      executionProfileId: profile.id,
      realizedPl: -300, // 3% of 10k default equity — at the default daily cap
      nowMs: ANCHOR,
    });
    const decision = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
      nowMs: ANCHOR,
    });
    assert.equal(decision.outcome, 'rejected');
    assert.equal(decision.rejectionCode, 'DAILY_LOSS_LIMIT');
  });

  test('consecutive-loss limit uses the server counter', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    for (let i = 0; i < 3; i++) {
      await risk.recordRealizedPl({
        userId: user.id,
        executionProfileId: profile.id,
        realizedPl: -1,
        nowMs: ANCHOR,
      });
    }
    const decision = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
      nowMs: ANCHOR,
    });
    assert.equal(decision.rejectionCode, 'CONSECUTIVE_LOSS_LIMIT');
  });

  test('unsupported symbol fails closed', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const decision = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: { ...makeDecision(setup), symbol: 'FAKEUSD', assetClass: 'forex' },
      nowMs: ANCHOR,
    });
    assert.equal(decision.outcome, 'rejected');
    assert.ok(
      decision.rejectionCode === 'MISSING_INSTRUMENT_METADATA' || decision.rejectionCode === 'UNSUPPORTED_SYMBOL',
    );
  });

  test('decisions never leak to another user', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const setup = await makeSetup(a.id);
    const profile = await profiles.createProfile(a.id, { mode: 'paper', providerSlug: 'paper' });
    await risk.evaluate({
      userId: a.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
      nowMs: ANCHOR,
    });
    const bList = await risk.listDecisions(b.id, 50);
    assert.equal(bList.decisions.length, 0);
  });

  test('risk_decisions are append-only', async () => {
    const user = await makeUser();
    const setup = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(setup),
      nowMs: ANCHOR,
    });
    await assert.rejects(pool.query(`UPDATE risk_decisions SET reason = 'tampered' WHERE user_id = $1`, [user.id]));
  });
});

describe('m8.2 concurrency', () => {
  test('two simultaneous approvals against maxSimultaneousPositions=1: only one passes', async () => {
    const user = await makeUser();
    await risk.updatePolicy(user.id, { maxSimultaneousPositions: 1 });
    const setupA = await makeSetup(user.id);
    const setupB = await makeSetup(user.id);
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });

    const [first, second] = await Promise.all([
      risk.evaluate({
        userId: user.id,
        executionProfileId: profile.id,
        decision: makeDecision(setupA),
        nowMs: ANCHOR,
        reserveOnApprove: true,
      }),
      risk.evaluate({
        userId: user.id,
        executionProfileId: profile.id,
        decision: makeDecision(setupB),
        nowMs: ANCHOR,
        reserveOnApprove: true,
      }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    assert.deepEqual(outcomes, ['approved', 'rejected']);
    const rejected = first.outcome === 'rejected' ? first : second;
    assert.equal(rejected.rejectionCode, 'SIMULTANEOUS_POSITION_LIMIT');

    const approved = first.outcome === 'approved' ? first : second;
    await risk.releaseReservation(approved.id);
  });
});
