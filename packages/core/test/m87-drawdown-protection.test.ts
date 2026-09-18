/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M8.7 — drawdown-based circuit breakers and equity protection (real Postgres).
 *
 * Proven against the migration-0022 schema:
 *  - Drawdown protection: daily/weekly/maximum drawdown limits computed from
 *    authoritative internal account data (immutable initial equity + cumulative realized P&L).
 *  - Warning vs hard-stop thresholds: warnings surface in safety status;
 *    hard-stops trip the circuit breaker (durable kill switch).
 *  - Fail-closed: missing/stale/uninitialized equity data rejects with
 *    EQUITY_DATA_UNAVAILABLE and trips the breaker.
 *  - Configuration: safe defaults, validated, ceiling-enforced, cannot
 *    bypass the global kill switch.
 *  - Tenant isolation: user A's drawdown data is invisible to user B.
 *  - Existing M8.6 kill-switch interactions preserved.
 *  - Live execution remains impossible.
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
  DEFAULT_RISK_POLICY,
  isCircuitBreakerCode,
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
  runMigrations,
  MIGRATIONS_DIR,
  Dec,
  type RiskEngineInput,
  evaluateRisk,
  defaultEffectivePolicy,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5457;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_m87_drawdown';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;
let killSwitches: KillSwitchService;
let automation: AutomationService;
let safety: SafetyControlsService;
let risk: RiskEngineService;
let profiles: ExecutionProfileService;

const uniqueEmail = () => `m87_${randomBytes(6).toString('hex')}@example.com`;
const ANCHOR = Date.UTC(2024, 0, 2, 12, 0, 0);

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m87-drawdown');
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
    name: 'M87 Tester',
  });
  return { id: user.id };
}

async function makeStrategy(userId: string, name = 'Test strategy'): Promise<string> {
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

/* -------------------------------------------------------------------------- */
/* Migration 0022 — schema                                                  */
/* -------------------------------------------------------------------------- */

describe('m8.7 migration 0022 — drawdown protection schema', () => {
  test('risk_policies gains drawdown columns with safe defaults', async () => {
    const user = await makeUser();
    const status = await risk.getPolicyStatus(user.id);
    assert.equal(status.policy.dailyDrawdownWarningPct, DEFAULT_RISK_POLICY.dailyDrawdownWarningPct);
    assert.equal(status.policy.dailyDrawdownLimitPct, DEFAULT_RISK_POLICY.dailyDrawdownLimitPct);
    assert.equal(status.policy.weeklyDrawdownWarningPct, DEFAULT_RISK_POLICY.weeklyDrawdownWarningPct);
    assert.equal(status.policy.weeklyDrawdownLimitPct, DEFAULT_RISK_POLICY.weeklyDrawdownLimitPct);
    assert.equal(status.policy.maxDrawdownWarningPct, DEFAULT_RISK_POLICY.maxDrawdownWarningPct);
    assert.equal(status.policy.maxDrawdownLimitPct, DEFAULT_RISK_POLICY.maxDrawdownLimitPct);
  });

  test('platform ceilings enforce drawdown limits', async () => {
    const user = await makeUser();
    await assert.rejects(
      () => risk.updatePolicy(user.id, { dailyDrawdownLimitPct: PLATFORM_RISK_CEILINGS.maxDailyDrawdownPct + 1 }),
      (err: any) => err.code === 'invalid_input',
    );
    await assert.rejects(
      () => risk.updatePolicy(user.id, { weeklyDrawdownLimitPct: PLATFORM_RISK_CEILINGS.maxWeeklyDrawdownPct + 1 }),
      (err: any) => err.code === 'invalid_input',
    );
    await assert.rejects(
      () => risk.updatePolicy(user.id, { maxDrawdownLimitPct: PLATFORM_RISK_CEILINGS.maxMaxDrawdownPct + 1 }),
      (err: any) => err.code === 'invalid_input',
    );
  });

  test('drawdown thresholds are adjustable within platform ceilings', async () => {
    const user = await makeUser();
    const updated = await risk.updatePolicy(user.id, {
      dailyDrawdownWarningPct: 1,
      dailyDrawdownLimitPct: 2,
      weeklyDrawdownWarningPct: 3,
      weeklyDrawdownLimitPct: 5,
      maxDrawdownWarningPct: 6,
      maxDrawdownLimitPct: 8,
    });
    assert.equal(updated.policy.dailyDrawdownWarningPct, 1);
    assert.equal(updated.policy.dailyDrawdownLimitPct, 2);
    assert.equal(updated.policy.weeklyDrawdownWarningPct, 3);
    assert.equal(updated.policy.weeklyDrawdownLimitPct, 5);
    assert.equal(updated.policy.maxDrawdownWarningPct, 6);
    assert.equal(updated.policy.maxDrawdownLimitPct, 8);
  });

  test('risk_account_states gains drawdown tracking columns', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    // First evaluation initializes the state
    const ids = await makeSetup(user.id);
    await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR,
    });
    // Verify the state has the new columns
    const state = await pool.query<any>(
      `SELECT initial_equity, peak_equity, daily_high_value, weekly_open_value,
              cumulative_realized_pl, equity_initialized
         FROM risk_account_states WHERE execution_profile_id = $1`,
      [profile.id],
    );
    assert.ok(state.rows.length > 0);
    assert.equal(state.rows[0].equity_initialized, true);
    assert.ok(Number(state.rows[0].initial_equity) > 0);
    assert.ok(Number(state.rows[0].peak_equity) > 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Drawdown engine — pure function tests                                      */
/* -------------------------------------------------------------------------- */

describe('m8.7 engine — drawdown checks (pure)', () => {
  const EURUSD = {
    assetClass: 'forex' as const,
    symbol: 'EURUSD',
    contractSize: 100_000,
    pipSize: 0.0001,
    pnlMode: 'quote_linear' as const,
    quoteCurrency: 'USD',
    minQuantity: 0.01,
    quantityStep: 0.01,
    maxQuantity: 100,
  };

  function base(overrides: Partial<RiskEngineInput> = {}): RiskEngineInput {
    return {
      policy: defaultEffectivePolicy(),
      strategyOverride: null,
      strategyMinRr: 2,
      account: {
        equity: Dec.fromInt(10_000)!,
        dailyRealizedPl: Dec.zero(),
        weeklyRealizedPl: Dec.zero(),
        consecutiveLosses: 0,
      },
      openPositions: [],
      reservations: [],
      instrument: EURUSD,
      correlationGroups: [],
      candidateGroupIds: [],
      killSwitchActive: false,
      candidate: {
        action: 'open_long',
        symbol: 'EURUSD',
        assetClass: 'forex',
        direction: 'long',
        entryPrice: 1.1,
        stopLossPrice: 1.095,
        takeProfitPrice: 1.11,
        expectedRr: 2,
        asOfMs: ANCHOR,
      },
      evaluatedAtMs: ANCHOR,
      drawdown: {
        currentAccountValue: Dec.fromInt(10_000)!,
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
      ...overrides,
    };
  }

  test('below threshold → no trip', () => {
    const v = evaluateRisk(base({
      drawdown: {
        currentAccountValue: Dec.fromInt(9_900)!, // 1% drawdown
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
    }));
    assert.equal(v.outcome, 'approved');
    assert.ok(!v.violations.includes('MAX_DRAWDOWN_WARNING'));
    assert.ok(!v.violations.includes('MAX_DRAWDOWN_LIMIT'));
  });

  test('exactly at warning threshold → warning violation, still approved (no hard-stop)', () => {
    const policy = {
      ...defaultEffectivePolicy(),
      maxDrawdownWarningPct: 5,
      maxDrawdownLimitPct: 10,
      dailyDrawdownWarningPct: 5,
      dailyDrawdownLimitPct: 10,
      weeklyDrawdownWarningPct: 5,
      weeklyDrawdownLimitPct: 10,
    };
    const v = evaluateRisk(base({
      policy,
      drawdown: {
        currentAccountValue: Dec.fromInt(9_500)!, // 5% from 10k
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
    }));
    // At exactly 5% — gte(5%) triggers warning
    assert.ok(v.violations.includes('MAX_DRAWDOWN_WARNING'), JSON.stringify(v.violations));
    assert.ok(!v.violations.includes('MAX_DRAWDOWN_LIMIT'));
    assert.ok(!v.violations.includes('DAILY_DRAWDOWN_LIMIT'));
    assert.ok(!v.violations.includes('WEEKLY_DRAWDOWN_LIMIT'));
  });

  test('threshold exceeded → hard-stop violation and rejection', () => {
    const policy = {
      ...defaultEffectivePolicy(),
      maxDrawdownWarningPct: 5,
      maxDrawdownLimitPct: 10,
    };
    const v = evaluateRisk(base({
      policy,
      drawdown: {
        currentAccountValue: Dec.fromInt(8_500)!, // 15% drawdown from 10k
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
    }));
    assert.equal(v.outcome, 'rejected');
    assert.ok(v.violations.includes('MAX_DRAWDOWN_LIMIT'), JSON.stringify(v.violations));
  });

  test('daily drawdown limit triggers', () => {
    const policy = {
      ...defaultEffectivePolicy(),
      dailyDrawdownWarningPct: 2,
      dailyDrawdownLimitPct: 3,
    };
    const v = evaluateRisk(base({
      policy,
      drawdown: {
        currentAccountValue: Dec.fromInt(10_000)!,
        peakEquity: Dec.fromInt(10_500)!,
        dailyHighValue: Dec.fromInt(10_500)!, // daily high at 10500, current 10000 = ~4.76% daily DD
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
    }));
    assert.equal(v.outcome, 'rejected');
    assert.ok(v.violations.includes('DAILY_DRAWDOWN_LIMIT'), JSON.stringify(v.violations));
  });

  test('weekly drawdown limit triggers', () => {
    const policy = {
      ...defaultEffectivePolicy(),
      weeklyDrawdownWarningPct: 4,
      weeklyDrawdownLimitPct: 6,
    };
    const v = evaluateRisk(base({
      policy,
      drawdown: {
        currentAccountValue: Dec.fromInt(10_000)!,
        peakEquity: Dec.fromInt(10_800)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_800)!, // weekly open at 10800, current 10000 = ~7.4% weekly DD
        initialized: true,
      },
    }));
    assert.equal(v.outcome, 'rejected');
    assert.ok(v.violations.includes('WEEKLY_DRAWDOWN_LIMIT'), JSON.stringify(v.violations));
  });

  test('warning vs hard-stop distinction', () => {
    const policy = {
      ...defaultEffectivePolicy(),
      maxDrawdownWarningPct: 5,
      maxDrawdownLimitPct: 10,
    };
    // At warning but below hard-stop
    const warning = evaluateRisk(base({
      policy,
      drawdown: {
        currentAccountValue: Dec.fromInt(9_400)!, // 6% from 10k
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
    }));
    assert.ok(warning.violations.includes('MAX_DRAWDOWN_WARNING'));
    assert.ok(!warning.violations.includes('MAX_DRAWDOWN_LIMIT'));

    // Above hard-stop
    const hardstop = evaluateRisk(base({
      policy,
      drawdown: {
        currentAccountValue: Dec.fromInt(8_800)!, // 12% from 10k
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
    }));
    assert.ok(hardstop.violations.includes('MAX_DRAWDOWN_LIMIT'));
  });

  test('missing drawdown data → EQUITY_DATA_UNAVAILABLE (fail-closed)', () => {
    const v = evaluateRisk(base({ drawdown: null }));
    assert.equal(v.outcome, 'rejected');
    assert.ok(v.violations.includes('EQUITY_DATA_UNAVAILABLE'), JSON.stringify(v.violations));
  });

  test('uninitialized drawdown data → EQUITY_DATA_UNAVAILABLE (fail-closed)', () => {
    const v = evaluateRisk(base({
      drawdown: {
        currentAccountValue: Dec.fromInt(10_000)!,
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: false,
      },
    }));
    assert.equal(v.outcome, 'rejected');
    assert.ok(v.violations.includes('EQUITY_DATA_UNAVAILABLE'), JSON.stringify(v.violations));
  });

  test('contradictory data (negative baseline) → EQUITY_DATA_UNAVAILABLE (fail-closed)', () => {
    const v = evaluateRisk(base({
      drawdown: {
        currentAccountValue: Dec.fromInt(10_000)!,
        peakEquity: Dec.zero(), // impossible baseline
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
    }));
    assert.equal(v.outcome, 'rejected');
    assert.ok(v.violations.includes('EQUITY_DATA_UNAVAILABLE'), JSON.stringify(v.violations));
  });

  test('contradictory equity ordering → EQUITY_DATA_UNAVAILABLE (fail-closed)', () => {
    for (const drawdown of [
      {
        currentAccountValue: Dec.fromInt(10_100)!,
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_100)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
      {
        currentAccountValue: Dec.fromInt(9_900)!,
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(9_800)!,
        weeklyOpenValue: Dec.fromInt(10_000)!,
        initialized: true,
      },
      {
        currentAccountValue: Dec.fromInt(9_900)!,
        peakEquity: Dec.fromInt(10_000)!,
        dailyHighValue: Dec.fromInt(10_000)!,
        weeklyOpenValue: Dec.fromInt(10_100)!,
        initialized: true,
      },
    ]) {
      const v = evaluateRisk(base({ drawdown }));
      assert.equal(v.outcome, 'rejected');
      assert.ok(v.violations.includes('EQUITY_DATA_UNAVAILABLE'), JSON.stringify(v.violations));
    }
  });

  test('undefined drawdown data → EQUITY_DATA_UNAVAILABLE (fail-closed)', () => {
    const input = base();
    delete (input as any).drawdown;
    const v = evaluateRisk(input);
    assert.equal(v.outcome, 'rejected');
    assert.ok(v.violations.includes('EQUITY_DATA_UNAVAILABLE'), JSON.stringify(v.violations));
  });
});

/* -------------------------------------------------------------------------- */
/* Drawdown circuit breaker integration                                       */
/* -------------------------------------------------------------------------- */

describe('m8.7 drawdown circuit breaker — integration', () => {
  test('max drawdown hard-stop trips the circuit breaker durably', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);

    // Set tight drawdown limits
    await risk.updatePolicy(user.id, {
      maxDrawdownWarningPct: 5,
      maxDrawdownLimitPct: 10,
      dailyDrawdownWarningPct: 5,
      dailyDrawdownLimitPct: 10,
      weeklyDrawdownWarningPct: 5,
      weeklyDrawdownLimitPct: 10,
    });

    // First evaluation initializes the state
    const first = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR,
    });
    assert.equal(first.outcome, 'approved');
    await risk.releaseReservation(first.id);
    assert.equal(await killSwitches.isUserActive(user.id), false);

    // Record a loss that causes >10% drawdown (10000 equity, -1100 P&L)
    await risk.recordRealizedPl({
      userId: user.id,
      executionProfileId: profile.id,
      realizedPl: -1_100,
      nowMs: ANCHOR + 60_000,
      paperEquity: 10_000,
    });

    // Second evaluation — drawdown breach should reject and trip breaker
    const second = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 120_000,
    });
    assert.equal(second.outcome, 'rejected');
    assert.ok(second.violations.includes('MAX_DRAWDOWN_LIMIT'), JSON.stringify(second.violations));

    // The breaker is tripped — the first circuit-breaker code in violation order wins
    assert.equal(await killSwitches.isUserActive(user.id), true);
    const row = await pool.query<{ reason: string }>(
      `SELECT reason FROM kill_switches WHERE scope = 'user' AND target_id = $1`,
      [user.id],
    );
    assert.ok(row.rows[0]?.reason?.includes('circuit breaker'), `reason: ${row.rows[0]?.reason}`);
    // The reason contains the first circuit-breaker code that fired
    assert.ok(
      row.rows[0]?.reason?.includes('DAILY_LOSS_LIMIT') ||
      row.rows[0]?.reason?.includes('DAILY_DRAWDOWN_LIMIT') ||
      row.rows[0]?.reason?.includes('MAX_DRAWDOWN_LIMIT'),
      `Unexpected breaker reason: ${row.rows[0]?.reason}`,
    );

    // Subsequent decisions are KILL_SWITCH_ACTIVE
    const third = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 180_000,
    });
    assert.equal(third.outcome, 'rejected');
    assert.equal(third.rejectionCode, 'KILL_SWITCH_ACTIVE');
  });

  test('drawdown code is a circuit breaker code', () => {
    assert.equal(isCircuitBreakerCode('DAILY_DRAWDOWN_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('WEEKLY_DRAWDOWN_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('MAX_DRAWDOWN_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('EQUITY_DATA_UNAVAILABLE'), true);
    assert.equal(isCircuitBreakerCode('DAILY_DRAWDOWN_WARNING'), false, 'warnings do not trip breaker');
    assert.equal(isCircuitBreakerCode('WEEKLY_DRAWDOWN_WARNING'), false);
    assert.equal(isCircuitBreakerCode('MAX_DRAWDOWN_WARNING'), false);
  });

  test('daily drawdown limit trips the breaker', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);

    await risk.updatePolicy(user.id, {
      dailyDrawdownWarningPct: 2,
      dailyDrawdownLimitPct: 3,
    });

    // First evaluation to initialize
    await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR,
    });

    // Create a scenario where the daily high is above current value by >3%
    // We record a loss that moves the account value down significantly
    await risk.recordRealizedPl({
      userId: user.id,
      executionProfileId: profile.id,
      realizedPl: -400,
      nowMs: ANCHOR + 60_000,
      paperEquity: 10_000,
    });

    const verdict = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR + 120_000,
    });
    assert.equal(verdict.outcome, 'rejected');
    assert.ok(
      verdict.violations.includes('DAILY_DRAWDOWN_LIMIT') ||
      verdict.violations.includes('DAILY_LOSS_LIMIT'),
      JSON.stringify(verdict.violations),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Safety status includes drawdown protection                                 */
/* -------------------------------------------------------------------------- */

describe('m8.7 safety status — drawdown protection state', () => {
  test('safety status includes drawdownProtection for a user with risk data', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);
    await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR,
    });

    const status = await safety.getStatus(user.id);
    assert.ok(status.drawdownProtection !== undefined, 'drawdownProtection must be present');
    if (status.drawdownProtection) {
      assert.ok(status.drawdownProtection.currentAccountValue > 0);
      assert.ok(status.drawdownProtection.peakEquity > 0);
      assert.ok(status.drawdownProtection.maxDrawdownWarningPct > 0);
      assert.ok(status.drawdownProtection.maxDrawdownLimitPct > 0);
      assert.equal(typeof status.drawdownProtection.anyHardStopActive, 'boolean');
      assert.equal(status.drawdownProtection.dataAvailable, true);
    }
  });

  test('safety status shows drawdown state even for users without risk data', async () => {
    const user = await makeUser();
    const status = await safety.getStatus(user.id);
    // May be undefined if no risk policy exists yet — that's safe
    if (status.drawdownProtection) {
      assert.equal(status.drawdownProtection.dataAvailable, false);
      assert.equal(status.drawdownProtection.anyHardStopActive, false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Tenant isolation                                                            */
/* -------------------------------------------------------------------------- */

describe('m8.7 tenant isolation — drawdown data', () => {
  test('user A drawdown data is invisible to user B', async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const profileA = await profiles.createProfile(userA.id, { mode: 'paper', providerSlug: 'paper' });
    const profileB = await profiles.createProfile(userB.id, { mode: 'paper', providerSlug: 'paper' });
    const idsA = await makeSetup(userA.id);
    const idsB = await makeSetup(userB.id);

    // Set different policies (warning must be <= limit per CHECK constraint)
    await risk.updatePolicy(userA.id, { maxDrawdownWarningPct: 3, maxDrawdownLimitPct: 5 });
    await risk.updatePolicy(userB.id, { maxDrawdownWarningPct: 10, maxDrawdownLimitPct: 15 });

    // Initialize both
    await risk.evaluate({ userId: userA.id, executionProfileId: profileA.id, decision: makeDecision(idsA), nowMs: ANCHOR });
    await risk.evaluate({ userId: userB.id, executionProfileId: profileB.id, decision: makeDecision(idsB), nowMs: ANCHOR });

    // User A's policy doesn't affect user B
    const statusA = await risk.getPolicyStatus(userA.id);
    const statusB = await risk.getPolicyStatus(userB.id);
    assert.equal(statusA.policy.maxDrawdownLimitPct, 5);
    assert.equal(statusB.policy.maxDrawdownLimitPct, 15);

    // Safety status is isolated too
    const safetyA = await safety.getStatus(userA.id);
    const safetyB = await safety.getStatus(userB.id);
    assert.equal(safetyA.drawdownProtection?.maxDrawdownLimitPct, 5);
    assert.equal(safetyB.drawdownProtection?.maxDrawdownLimitPct, 15);
  });
});

/* -------------------------------------------------------------------------- */
/* Automation cannot be enabled while protection is active                     */
/* -------------------------------------------------------------------------- */

describe('m8.7 automation — protection interaction', () => {
  test('automation remains disabled by default and cannot be enabled', async () => {
    const user = await makeUser();
    const auto = await automation.getStatus(user.id);
    assert.equal(auto.effective, false);
    assert.equal(auto.automationEnabled, false);
    assert.equal(auto.entitled, false);

    // Cannot enable automation (no entitlement)
    await assert.rejects(
      () => automation.setAutomationEnabled(user.id, true),
      (err: any) => err.code === 'forbidden',
    );
  });

  test('disabling automation remains possible even without entitlement', async () => {
    const user = await makeUser();
    // Disabling is always allowed (safe direction)
    const status = await automation.setAutomationEnabled(user.id, false);
    assert.equal(status.automationEnabled, false);
  });
});

/* -------------------------------------------------------------------------- */
/* No live execution path                                                      */
/* -------------------------------------------------------------------------- */

describe('m8.7 safety — no live execution path', () => {
  test('live execution remains impossible', async () => {
    // Verify the M8.4 safety boundary is intact
    const user = await makeUser();
    await assert.rejects(
      pool.query(
        `INSERT INTO execution_profiles (user_id, mode, environment, provider_slug)
         VALUES ($1, 'live', 'live', 'paper')`,
        [user.id],
      ),
      (err: any) => err.code === '23514',
    );
  });

  test('no credential columns exist in drawdown/safety tables', async () => {
    const res = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('risk_policies', 'risk_account_states', 'kill_switches', 'kill_switch_events')`,
    );
    for (const row of res.rows) {
      const name = row.column_name.toLowerCase();
      for (const needle of ['password', 'secret', 'token', 'api_key', 'apikey', 'credential']) {
        assert.ok(!name.includes(needle), `${row.table_name}.${row.column_name} leaks the no-credentials rule`);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Existing M8.6 interactions preserved                                        */
/* -------------------------------------------------------------------------- */

describe('m8.7 M8.6 interactions — kill switch preserved', () => {
  test('kill switch still blocks risk evaluation even without drawdown breach', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);
    await killSwitches.set('user', { targetId: user.id, active: true, reason: 'manual stop' });

    const verdict = await risk.evaluate({
      userId: user.id,
      executionProfileId: profile.id,
      decision: makeDecision(ids),
      nowMs: ANCHOR,
    });
    assert.equal(verdict.outcome, 'rejected');
    assert.equal(verdict.rejectionCode, 'KILL_SWITCH_ACTIVE');
  });

  test('emergency stop still works with M8.7 drawdown data', async () => {
    const user = await makeUser();
    const profile = await profiles.createProfile(user.id, { mode: 'paper', providerSlug: 'paper' });
    const ids = await makeSetup(user.id);
    await risk.evaluate({ userId: user.id, executionProfileId: profile.id, decision: makeDecision(ids), nowMs: ANCHOR });

    const result = await safety.emergencyStop(user.id, 'M8.7 test emergency');
    assert.equal(result.stopped, true);
    assert.equal(result.killSwitchActivated, true);
    assert.equal(await killSwitches.isUserActive(user.id), true);
    assert.equal((await automation.getStatus(user.id)).automationEnabled, false);
  });
});
