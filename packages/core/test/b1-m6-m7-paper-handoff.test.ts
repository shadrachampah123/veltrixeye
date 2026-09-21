/**
 * B1 M6 + M7 — composed paper handoff end-to-end against embedded Postgres.
 *
 * The REAL composition, REAL paper simulator, REAL risk engine, REAL kill
 * switches, REAL Gate 9 ledger, REAL providers (paper bound, MT5 disabled),
 * and REAL in-memory authorization — only automation state is scripted
 * (no plan grants `canAccessAutomation` in this platform version, so the
 * real service would refuse every attempt at the entitlement gate before
 * the paper path is ever reached; the scripted state is entitled+enabled).
 *
 * Proves: a composed paper entry actually fills through the simulator, the
 * position/order/exposure rows are durable, the B1 authorization is consumed
 * exactly once (never stranded), the risk reservation is released into
 * durable ownership, Gate 9 is untouched, and retries replay without new
 * risk work. Plus the broker fail-closed path and the simulator-refusal
 * path with the same no-stranded-grant guarantees.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  AuditService,
  CandleStoreMarketPriceSource,
  createExecutionProviderRegistry,
  createMT5ExecutionProvider,
  createPaperExecutionProvider,
  createPool,
  createSubmitBarrierHandoff,
  DisabledMT5Transport,
  ExecutionAuthorizationService,
  ExecutionCompositionService,
  ExecutionProfileService,
  KillSwitchService,
  PaperExecutionService,
  ProviderMutationLedger,
  RiskEngineService,
  UserService,
  createAuthorizationContextHandoff,
  runMigrations,
  MIGRATIONS_DIR,
} from '../src/index.js';
import { stubAutomation } from './support/b1-harness.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5473;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_b1_m6';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;
let killSwitches: KillSwitchService;
let risk: RiskEngineService;
let profiles: ExecutionProfileService;
let market: CandleStoreMarketPriceSource;
let registry: ReturnType<typeof createExecutionProviderRegistry>;
let paper: PaperExecutionService;
let ledger: ProviderMutationLedger;
let submitHandoff: ReturnType<typeof createSubmitBarrierHandoff>;
let executionAuthorization: ExecutionAuthorizationService;
let authHandoff: ReturnType<typeof createAuthorizationContextHandoff>;
let automation: ReturnType<typeof stubAutomation>;
let composition: ExecutionCompositionService;
const paperSubmitCalls: unknown[] = [];

const uniqueEmail = () => `b1m6_${randomBytes(6).toString('hex')}@example.com`;
let strategyCounter = 0;
let anchorCounter = 0;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-b1-m6');
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
  // Scripted entitled+enabled (see header): the real service grants no plan
  // automation access, which would refuse every attempt before the handoff.
  automation = stubAutomation({ entitled: true, enabled: true });
  risk = new RiskEngineService(pool, { killSwitches, audit });
  registry = createExecutionProviderRegistry();
  const serviceRef = (): PaperExecutionService => paper;
  const paperProvider = createPaperExecutionProvider({
    simulator: { submitAuthorizedOrder: (args) => serviceRef().submitAuthorizedOrder(args) },
  });
  registry.register({
    ...paperProvider,
    submitOrder: async (request: unknown) => {
      paperSubmitCalls.push(request);
      return paperProvider.submitOrder(request as never);
    },
  } as never);
  // Disabled broker provider: registered so demo profiles can exist; every
  // operation fails closed and the composition never reaches it (H3).
  registry.register(
    createMT5ExecutionProvider(
      new DisabledMT5Transport(),
      {
        enabled: false,
        environment: 'demo',
        broker: 'Exness',
        server: 'Exness-MT5',
        accountRef: 'acct-1',
        symbols: new Map(),
      },
      {},
    ),
  );
  market = new CandleStoreMarketPriceSource(pool);
  executionAuthorization = new ExecutionAuthorizationService();
  authHandoff = createAuthorizationContextHandoff(executionAuthorization);
  paper = new PaperExecutionService(
    pool,
    {
      market,
      risk,
      killSwitches,
      automation: automation.service,
      audit,
      provider: () => registry.get('paper'),
      b1Authorization: executionAuthorization,
    },
    {},
  );
  ledger = new ProviderMutationLedger(pool);
  submitHandoff = createSubmitBarrierHandoff();
  profiles = new ExecutionProfileService(pool, registry, audit);
  composition = new ExecutionCompositionService(pool, {
    automation: automation.service,
    killSwitches,
    providers: registry,
    risk,
    audit,
    providerMutations: ledger,
    submitHandoff,
    authorization: executionAuthorization,
    authHandoff,
    paper,
  });
}, { timeout: 240_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function makeUser(): Promise<string> {
  const user = await users.create({ email: uniqueEmail(), passwordHash: 'x'.repeat(32), name: 'B1 M6' });
  return user.id;
}

async function makePaperProfile(userId: string): Promise<string> {
  const profile = await profiles.createProfile(userId, { mode: 'paper', providerSlug: 'paper' });
  return profile.id;
}

async function makeBrokerProfile(userId: string): Promise<string> {
  const profile = await profiles.createProfile(userId, {
    mode: 'demo',
    providerSlug: 'mt5',
    brokerServer: 'Exness-MT5',
    accountRef: 'acct-1',
  });
  return profile.id;
}

async function makeStrategy(userId: string): Promise<{ strategyId: string; versionId: string }> {
  strategyCounter += 1;
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `b1 m6 strategy ${strategyCounter}`],
  );
  const strategyId = strategy.rows[0]!.id;
  const version = await pool.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by)
     VALUES ($1, 1, 'draft', $2) RETURNING id`,
    [strategyId, userId],
  );
  const versionId = version.rows[0]!.id;
  await pool.query(
    `INSERT INTO strategy_timeframes (version_id, role, timeframe)
     VALUES ($1, 'htf_bias', '1h'), ($1, 'setup', '5m'), ($1, 'entry', '1m')`,
    [versionId],
  );
  await pool.query(
    `INSERT INTO strategy_risk_config
       (version_id, min_rr, stop_loss_method, stop_loss_buffer, stop_loss_buffer_unit,
        take_profit_method, tp1_rr, tp2_rr, tp3_rr, min_quality_score)
     VALUES ($1, 2, 'structure', 0, 'pips', 'rr', 2, 3, 4, 60)`,
    [versionId],
  );
  await pool.query(`UPDATE strategy_versions SET status = 'published', published_at = now() WHERE id = $1`, [versionId]);
  return { strategyId, versionId };
}

async function makeSetup(userId: string): Promise<{ setupId: string; instrumentId: string }> {
  const { versionId } = await makeStrategy(userId);
  const instrument = await pool.query<{ id: string }>(
    `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'`,
  );
  const instrumentId = instrument.rows[0]!.id;
  anchorCounter += 1;
  const asOfMs = Date.now() - anchorCounter;
  const setup = await pool.query<{ id: string }>(
    `INSERT INTO setups
       (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms,
        entry_price, stop_loss_price, tp1_price, quality_score)
     VALUES ($1,$2,'confirmed','long', to_timestamp($3 / 1000.0), $3, 1.1, 1.09, 1.12, 80) RETURNING id`,
    [versionId, instrumentId, asOfMs],
  );
  return { setupId: setup.rows[0]!.id, instrumentId };
}

async function seedEntryPrice(instrumentId: string, price = 1.1, ts = Date.now()): Promise<void> {
  await pool.query(
    `INSERT INTO candles (instrument_id, timeframe, ts, open, high, low, close, provider_slug)
     VALUES ($1,'5m',$2,$3,$3,$3,$3,'test-provider')
     ON CONFLICT (instrument_id, timeframe, ts) DO UPDATE
       SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close`,
    [instrumentId, ts, price],
  );
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const res = await pool.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

describe('B1 M6 — composed paper entry fills end-to-end', () => {
  test('full fill: accepted, durable position, consumed auth, released hold, Gate 9 untouched', async () => {
    const userId = await makeUser();
    const profileId = await makePaperProfile(userId);
    const { setupId, instrumentId } = await makeSetup(userId);
    const nowMs = Date.now();
    await seedEntryPrice(instrumentId, 1.1, nowMs);

    const intentsBefore = await countRows('SELECT count(*) AS n FROM execution_provider_intents', []);
    const submitsBefore = paperSubmitCalls.length;

    const out = await composition.composeAndSubmit({ userId, executionProfileId: profileId, setupId, nowMs });

    assert.equal(out.accepted, true);
    assert.equal(out.replayed, false);
    assert.equal(out.gate.passed, true);
    assert.equal(out.paperOutcome?.status, 'filled');
    assert.equal(out.providerOutcome, null);
    assert.ok(out.riskDecisionId);

    // The position and its economics are durable (H4-paper).
    const positions = await pool.query<{
      id: string;
      quantity: string;
      average_entry_price: string;
      direction: string;
      symbol: string;
      status: string;
    }>(
      `SELECT id, quantity::text AS quantity, average_entry_price::text AS average_entry_price,
              direction, symbol, status
       FROM execution_positions WHERE user_id = $1 AND execution_profile_id = $2`,
      [userId, profileId],
    );
    assert.equal(positions.rows.length, 1);
    assert.ok(Number(positions.rows[0]!.quantity) > 0);
    assert.ok(Math.abs(Number(positions.rows[0]!.average_entry_price) - 1.1) < 0.01);
    assert.equal(positions.rows[0]!.direction, 'long');
    assert.equal(positions.rows[0]!.symbol, 'EURUSD');
    assert.equal(positions.rows[0]!.status, 'open');
    const orders = await pool.query<{ status: string }>(
      `SELECT status FROM execution_orders WHERE user_id = $1 AND status = 'filled'`,
      [userId],
    );
    assert.equal(orders.rows.length, 1);

    // The risk hold is released into durable ownership (no stranded hold).
    assert.equal(
      await countRows('SELECT count(*) AS n FROM risk_reservations WHERE risk_decision_id = $1', [out.riskDecisionId]),
      0,
    );
    // The B1 authorization was consumed exactly once (never stranded).
    assert.equal(executionAuthorization.size(), 0);
    // The direct provider boundary was never used: the composition hands to
    // the simulator, it does not submit through the provider.
    assert.equal(paperSubmitCalls.length, submitsBefore);
    // Gate 9 never touched on the paper path.
    assert.equal(await countRows('SELECT count(*) AS n FROM execution_provider_intents', []), intentsBefore);
    // The attempt is audited.
    assert.equal(
      await countRows(`SELECT count(*) AS n FROM execution_requests WHERE user_id = $1 AND status = 'requested'`, [userId]),
      1,
    );
  });

  test('immediate retry replays without new risk work or a second position', async () => {
    const userId = await makeUser();
    const profileId = await makePaperProfile(userId);
    const { setupId, instrumentId } = await makeSetup(userId);
    const nowMs = Date.now();
    await seedEntryPrice(instrumentId, 1.1, nowMs);

    const first = await composition.composeAndSubmit({ userId, executionProfileId: profileId, setupId, nowMs });
    assert.equal(first.accepted, true);
    const decisionsAfterFirst = await countRows('SELECT count(*) AS n FROM risk_decisions WHERE user_id = $1', [userId]);

    const second = await composition.composeAndSubmit({ userId, executionProfileId: profileId, setupId, nowMs });
    assert.equal(second.accepted, true);
    assert.equal(second.replayed, true);
    assert.equal(second.paperOutcome?.status, 'replayed');
    assert.equal(
      await countRows('SELECT count(*) AS n FROM risk_decisions WHERE user_id = $1', [userId]),
      decisionsAfterFirst,
      'replay allocates no new risk evaluation',
    );
    assert.equal(
      await countRows('SELECT count(*) AS n FROM execution_positions WHERE user_id = $1', [userId]),
      1,
      'no second position',
    );
    assert.equal(executionAuthorization.size(), 0);
  });

  test('broker profile fails closed end-to-end: no intent, no submit, hold released', async () => {
    const userId = await makeUser();
    const profileId = await makeBrokerProfile(userId);
    // Demo profiles are created disabled; the production enable path refuses
    // while the MT5 transport is unconfigured (honest). Enable the row
    // directly so the test exercises the H3 grant gate itself.
    await pool.query(`UPDATE execution_profiles SET enabled = true WHERE id = $1`, [profileId]);
    const { setupId, instrumentId } = await makeSetup(userId);
    const nowMs = Date.now();
    await seedEntryPrice(instrumentId, 1.1, nowMs);

    const intentsBefore = await countRows('SELECT count(*) AS n FROM execution_provider_intents', []);
    const out = await composition.composeAndSubmit({ userId, executionProfileId: profileId, setupId, nowMs });

    assert.equal(out.accepted, false);
    // The disabled MT5 transport reports unhealthy, so the stack fails even
    // earlier than the grant gate (provider_healthy precedes
    // broker_authorized in the pinned gate order). Either way: no intent, no
    // submit, hold released. The broker_authorized gate itself is covered at
    // composition level with a healthy-reporting provider (b1-h3 file).
    assert.equal(out.gate.failedGate, 'provider_healthy');
    assert.equal(await countRows('SELECT count(*) AS n FROM execution_provider_intents', []), intentsBefore);
    assert.ok(out.riskDecisionId);
    assert.equal(
      await countRows('SELECT count(*) AS n FROM risk_reservations WHERE risk_decision_id = $1', [out.riskDecisionId]),
      0,
      'refused broker attempt releases its hold',
    );
    assert.equal(executionAuthorization.size(), 0);
  });

  test('simulator refusal: rejected, no position, no stranded grant or hold', async () => {
    const failingPaper = new PaperExecutionService(
      pool,
      {
        market,
        risk,
        killSwitches,
        automation: automation.service,
        audit,
        provider: () => registry.get('paper'),
        b1Authorization: executionAuthorization,
      },
      { failureMode: { orderRejection: true } },
    );
    const failingComposition = new ExecutionCompositionService(pool, {
      automation: automation.service,
      killSwitches,
      providers: registry,
      risk,
      audit,
      providerMutations: ledger,
      submitHandoff,
      authorization: executionAuthorization,
      authHandoff,
      paper: failingPaper,
    });

    const userId = await makeUser();
    const profileId = await makePaperProfile(userId);
    const { setupId, instrumentId } = await makeSetup(userId);
    const nowMs = Date.now();
    await seedEntryPrice(instrumentId, 1.1, nowMs);

    const out = await failingComposition.composeAndSubmit({ userId, executionProfileId: profileId, setupId, nowMs });

    assert.equal(out.accepted, false);
    assert.equal(out.gate.passed, true, 'the gates passed; the simulator refused');
    assert.equal(out.paperOutcome?.status, 'rejected');
    assert.equal(
      await countRows('SELECT count(*) AS n FROM execution_positions WHERE user_id = $1', [userId]),
      0,
      'no position on refusal',
    );
    assert.ok(out.riskDecisionId);
    assert.equal(
      await countRows('SELECT count(*) AS n FROM risk_reservations WHERE risk_decision_id = $1', [out.riskDecisionId]),
      0,
      'refused attempt releases its hold',
    );
    assert.equal(executionAuthorization.size(), 0, 'no stranded authorization on refusal');
  });

  test('kill switch tripped mid-flight fails closed end-to-end (H5)', async () => {
    let calls = 0;
    const flipKills = {
      ...killSwitches,
      anyActive: async (args: unknown) => {
        calls += 1;
        if (calls === 1) return { active: false, global: false, user: false, strategy: false, profile: false };
        return { active: true, global: true, user: false, strategy: false, profile: false };
      },
    };
    const flipComposition = new ExecutionCompositionService(pool, {
      automation: automation.service,
      killSwitches: flipKills as never,
      providers: registry,
      risk,
      audit,
      providerMutations: ledger,
      submitHandoff,
      authorization: executionAuthorization,
      authHandoff,
      paper,
    });

    const userId = await makeUser();
    const profileId = await makePaperProfile(userId);
    const { setupId, instrumentId } = await makeSetup(userId);
    const nowMs = Date.now();
    await seedEntryPrice(instrumentId, 1.1, nowMs);

    const out = await flipComposition.composeAndSubmit({ userId, executionProfileId: profileId, setupId, nowMs });

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'kill_switch');
    assert.equal(calls, 2, 'early read green, fence read tripped');
    assert.equal(
      await countRows('SELECT count(*) AS n FROM execution_orders WHERE user_id = $1', [userId]),
      0,
      'no order row is created after the fence trips',
    );
    assert.ok(out.riskDecisionId);
    assert.equal(
      await countRows('SELECT count(*) AS n FROM risk_reservations WHERE risk_decision_id = $1', [out.riskDecisionId]),
      0,
    );
    assert.equal(executionAuthorization.size(), 0);
  });
});
