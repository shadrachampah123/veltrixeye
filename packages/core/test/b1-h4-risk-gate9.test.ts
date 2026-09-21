/**
 * B1 H4 — the approved risk exposure reaches Gate 9 intact and is never
 * projected as zero.
 *
 * The REAL risk engine approves a real setup, the REAL reservation backs it,
 * `toGate9RiskHandoff` builds the handoff, and the REAL canonical boundary
 * (`submitOrderThroughGate9` — the exact function the broker composition
 * calls) commits the intent. A scripted in-process ExecutionProvider stands
 * in for the broker transport (no network, no credentials): it can accept,
 * reject, or time out.
 *
 * Proves: the intent carries the reservation's exact positive decimal
 * exposure on accept AND on uncertain; the composition's post-handoff
 * reservation release does not erase the durable copy; restart recovery
 * still sees the exposure; and a rejected submit carries no accepted
 * outcome anywhere.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import type { ExecutionDecisionInput } from '@veltrixeye/contracts';

import {
  AuditService,
  KillSwitchService,
  ProviderMutationLedger,
  RiskEngineService,
  buildServerExecutionDecision,
  createPool,
  createSubmitBarrierHandoff,
  runMigrations,
  submitOrderThroughGate9,
  toAuthorizationRequestBinding,
  toGate9RiskHandoff,
  MIGRATIONS_DIR,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5474;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_b1_h4';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let audit: AuditService;
let killSwitches: KillSwitchService;
let risk: RiskEngineService;
let ledger: ProviderMutationLedger;
let submitHandoff: ReturnType<typeof createSubmitBarrierHandoff>;

const uniqueEmail = () => `b1h4_${randomBytes(6).toString('hex')}@example.com`;
let strategyCounter = 0;
let anchorCounter = 0;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-b1-h4');
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

  audit = new AuditService(pool);
  killSwitches = new KillSwitchService(pool);
  risk = new RiskEngineService(pool, { killSwitches, audit });
  ledger = new ProviderMutationLedger(pool);
  submitHandoff = createSubmitBarrierHandoff();
}, { timeout: 240_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'B1 H4') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}

async function makeBrokerProfile(userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, broker_server, enabled, connection_status)
     VALUES ($1,$2,'demo','demo','mt5','acct-1','Exness-MT5',true,'connected')`,
    [id, userId],
  );
  return id;
}

async function makeApprovedDecision(
  userId: string,
  profileId: string,
): Promise<{ decision: ExecutionDecisionInput; riskId: string }> {
  strategyCounter += 1;
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `b1 h4 strategy ${strategyCounter}`],
  );
  const strategyId = strategy.rows[0]!.id;
  const version = await pool.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by)
     VALUES ($1, 1, 'draft', $2) RETURNING id`,
    [strategyId, userId],
  );
  const versionId = version.rows[0]!.id;
  await pool.query(
    `INSERT INTO strategy_timeframes (version_id, role, timeframe) VALUES ($1, 'setup', '5m')`,
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
  const setupId = setup.rows[0]!.id;
  const built = buildServerExecutionDecision({
    setupId,
    strategyId,
    strategyVersionId: versionId,
    assetClass: 'forex',
    symbol: 'EURUSD',
    direction: 'long',
    state: 'confirmed',
    asOfMs,
    entryPrice: 1.1,
    stopLossPrice: 1.09,
    tp1Price: 1.12,
    qualityScore: 80,
    minQualityScore: 60,
    timeframe: '5m',
  });
  if (!built.ok) throw new Error(`fixture decision invalid: ${built.reason}`);
  const evaluated = await risk.evaluate({
    userId,
    executionProfileId: profileId,
    decision: built.decision,
    reserveOnApprove: true,
  });
  assert.equal(evaluated.outcome, 'approved', `fixture risk must approve (${evaluated.reason})`);
  return { decision: built.decision, riskId: evaluated.id };
}

/** In-process scripted broker transport: accept, reject, or time out. No network. */
function scriptedBrokerProvider(scenario: 'accept' | 'reject' | 'timeout', calls: unknown[]): any {
  return {
    id: 'mt5',
    configured: true,
    capabilities: { modes: ['demo'], orderTypes: ['market'] },
    describe: () => ({ id: 'mt5', environment: 'demo', accountRef: 'acct-1', server: 'Exness-MT5' }),
    health: async () => ({
      configured: true,
      authenticated: true,
      connected: true,
      available: true,
      healthy: true,
      state: 'healthy',
      checkedAt: new Date().toISOString(),
    }),
    getAccountInfo: async () => null,
    getInstrument: async () => null,
    listInstruments: async () => [],
    submitOrder: async (request: unknown) => {
      calls.push(request);
      if (scenario === 'timeout') throw new Error('simulated broker timeout');
      if (scenario === 'reject') {
        return { status: 'rejected', providerOrderId: null, receipt: { reason: 'scripted-risk-reject' } };
      }
      return { status: 'accepted', providerOrderId: `fake-${randomBytes(8).toString('hex')}` };
    },
    cancelOrder: async () => {},
    modifyOrder: async () => {},
    closePosition: async () => {},
  };
}

function freshIdentities() {
  const idempotencyKey = randomBytes(32).toString('hex');
  return { idempotencyKey, clientOrderId: `ve-${idempotencyKey.slice(0, 24)}` };
}

async function intentRow(intentId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM execution_provider_intents WHERE id = $1',
    [intentId],
  );
  assert.ok(rows[0]);
  return rows[0]!;
}

/** Gate 9 carries the exposure copy on the mutation reservation, linked from the intent. */
async function reservationRow(intentId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT *, monetary_risk::text AS monetary_risk_text
     FROM execution_provider_mutation_reservations WHERE intent_id = $1`,
    [intentId],
  );
  assert.ok(rows[0]);
  return rows[0]!;
}

describe('B1 H4 — approved exposure is preserved through Gate 9', () => {
  test('accepted submit: the intent carries the reservation exposure exactly (never zero)', async () => {
    const userId = await makeUser();
    const profileId = await makeBrokerProfile(userId);
    const { decision, riskId } = await makeApprovedDecision(userId, profileId);
    const nowMs = Date.now();
    const reservation = await risk.getActiveReservation({ riskDecisionId: riskId, executionProfileId: profileId, nowMs });
    assert.ok(reservation);
    assert.ok(Number(reservation!.monetaryRisk) > 0, `reservation exposure must be positive (${reservation!.monetaryRisk})`);

    const handoff = toGate9RiskHandoff({ riskDecisionId: riskId, reservation, nowMs });
    assert.equal(handoff.monetaryRisk, reservation!.monetaryRisk, 'handoff copies the exposure string exactly');
    assert.equal(handoff.riskReservationId, reservation!.id);

    const { clientOrderId, idempotencyKey } = freshIdentities();
    const request = toAuthorizationRequestBinding({
      clientOrderId,
      idempotencyKey,
      authorizationId: randomUUID(),
      assetClass: decision.assetClass,
      symbol: decision.symbol,
      side: 'buy',
      orderType: 'market',
      quantity: 0.05,
      requestedPrice: null,
      stopLossPrice: decision.stopLossPrice,
      takeProfitPrice: decision.takeProfitPrice,
    });
    const calls: unknown[] = [];
    const outcome = await submitOrderThroughGate9({
      ledger,
      provider: scriptedBrokerProvider('accept', calls),
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'acct-1',
      brokerServerRef: 'Exness-MT5',
      credentialRef: null,
      credentialFingerprint: null,
      riskDecisionId: handoff.riskDecisionId,
      riskReservationId: handoff.riskReservationId,
      monetaryRisk: handoff.monetaryRisk,
      riskExpiresAt: handoff.riskExpiresAt,
      request,
      handoff: submitHandoff,
    });

    assert.equal(outcome.status, 'ok');
    if (outcome.status !== 'ok') throw new Error('expected an accepted boundary outcome');
    assert.equal(outcome.kind, 'submitted');
    assert.equal(outcome.providerOutcome.status, 'accepted');
    assert.equal(calls.length, 1);

    const row = await intentRow(outcome.result.intentId);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.risk_decision_id, riskId);
    const res = await reservationRow(outcome.result.intentId);
    assert.equal(res.risk_reservation_id, reservation!.id);
    assert.equal(res.monetary_risk_text, reservation!.monetaryRisk, 'intent exposure equals the reservation exposure');
    assert.ok(Number(String(res.monetary_risk_text)) > 0, 'intent exposure is positive — never a $0 projection');

    // The composition releases the risk hold once the intent owns the
    // exposure; the durable copy on the intent is unaffected.
    await risk.releaseReservation(riskId);
    assert.equal(
      (await risk.getActiveReservation({ riskDecisionId: riskId, executionProfileId: profileId, nowMs })) ?? null,
      null,
    );
    const after = await reservationRow(outcome.result.intentId);
    assert.equal(String(after.monetary_risk_text), reservation!.monetaryRisk, 'durable exposure survives the hold release');
  });

  test('uncertain submit: the exposure stays represented and recoverable (never dropped)', async () => {
    const userId = await makeUser();
    const profileId = await makeBrokerProfile(userId);
    const { decision, riskId } = await makeApprovedDecision(userId, profileId);
    const nowMs = Date.now();
    const reservation = await risk.getActiveReservation({ riskDecisionId: riskId, executionProfileId: profileId, nowMs });
    assert.ok(reservation);
    const handoff = toGate9RiskHandoff({ riskDecisionId: riskId, reservation, nowMs });

    const { clientOrderId, idempotencyKey } = freshIdentities();
    const request = toAuthorizationRequestBinding({
      clientOrderId,
      idempotencyKey,
      authorizationId: randomUUID(),
      assetClass: decision.assetClass,
      symbol: decision.symbol,
      side: 'buy',
      orderType: 'market',
      quantity: 0.05,
      requestedPrice: null,
      stopLossPrice: decision.stopLossPrice,
      takeProfitPrice: decision.takeProfitPrice,
    });
    const calls: unknown[] = [];
    const outcome = await submitOrderThroughGate9({
      ledger,
      provider: scriptedBrokerProvider('timeout', calls),
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'acct-1',
      brokerServerRef: 'Exness-MT5',
      credentialRef: null,
      credentialFingerprint: null,
      riskDecisionId: handoff.riskDecisionId,
      riskReservationId: handoff.riskReservationId,
      monetaryRisk: handoff.monetaryRisk,
      riskExpiresAt: handoff.riskExpiresAt,
      request,
      handoff: submitHandoff,
    });

    assert.equal(outcome.status, 'error');
    if (outcome.status !== 'error') throw new Error('expected an uncertain boundary outcome');
    assert.equal(outcome.kind, 'provider_uncertain');
    assert.equal(calls.length, 1, 'the provider was called once; the outcome is unknown');

    const row = await intentRow(outcome.result.intentId);
    assert.equal(row.status, 'uncertain');
    const res = await reservationRow(outcome.result.intentId);
    assert.equal(String(res.monetary_risk_text), reservation!.monetaryRisk, 'uncertain intent keeps the full exposure');
    assert.ok(Number(String(res.monetary_risk_text)) > 0);

    // Unresolved exposure accounting includes it.
    const exposure = await ledger.unresolvedMutationExposure(profileId);
    assert.ok(exposure.clientOrderIds.includes(clientOrderId));
    assert.ok(Number(exposure.monetaryRisk) >= Number(reservation!.monetaryRisk));

    // The intent is still listed as unresolved with its exposure intact
    // (never silently zeroed): restart/reconciliation reads see it.
    const unresolved = await ledger.listUnresolved({ executionProfileId: profileId });
    const found = unresolved.find((i) => i.id === outcome.result.intentId);
    assert.ok(found, 'uncertain intent is still listed as unresolved');
    assert.equal(found!.riskDecisionId, riskId);
    const resAfter = await reservationRow(outcome.result.intentId);
    assert.equal(String(resAfter.monetary_risk_text), reservation!.monetaryRisk);
  });

  test('rejected submit: explicit rejection, exposure recorded, nothing accepted', async () => {
    const userId = await makeUser();
    const profileId = await makeBrokerProfile(userId);
    const { decision, riskId } = await makeApprovedDecision(userId, profileId);
    const nowMs = Date.now();
    const reservation = await risk.getActiveReservation({ riskDecisionId: riskId, executionProfileId: profileId, nowMs });
    assert.ok(reservation);
    const handoff = toGate9RiskHandoff({ riskDecisionId: riskId, reservation, nowMs });

    const { clientOrderId, idempotencyKey } = freshIdentities();
    const request = toAuthorizationRequestBinding({
      clientOrderId,
      idempotencyKey,
      authorizationId: randomUUID(),
      assetClass: decision.assetClass,
      symbol: decision.symbol,
      side: 'buy',
      orderType: 'market',
      quantity: 0.05,
      requestedPrice: null,
      stopLossPrice: decision.stopLossPrice,
      takeProfitPrice: decision.takeProfitPrice,
    });
    const calls: unknown[] = [];
    const outcome = await submitOrderThroughGate9({
      ledger,
      provider: scriptedBrokerProvider('reject', calls),
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'acct-1',
      brokerServerRef: 'Exness-MT5',
      credentialRef: null,
      credentialFingerprint: null,
      riskDecisionId: handoff.riskDecisionId,
      riskReservationId: handoff.riskReservationId,
      monetaryRisk: handoff.monetaryRisk,
      riskExpiresAt: handoff.riskExpiresAt,
      request,
      handoff: submitHandoff,
    });

    assert.equal(outcome.status, 'ok');
    if (outcome.status !== 'ok') throw new Error('expected a submitted boundary outcome');
    assert.equal(outcome.providerOutcome.status, 'rejected');
    const row = await intentRow(outcome.result.intentId);
    assert.equal(row.status, 'rejected');
    const res = await reservationRow(outcome.result.intentId);
    assert.equal(String(res.monetary_risk_text), reservation!.monetaryRisk, 'the attempted exposure is recorded');
  });

  test('the handoff itself refuses a missing reservation (composition-side guard)', async () => {
    const userId = await makeUser();
    const profileId = await makeBrokerProfile(userId);
    const { riskId } = await makeApprovedDecision(userId, profileId);
    const nowMs = Date.now();
    // Release first: no live reservation exists for this approval anymore.
    await risk.releaseReservation(riskId);
    const reservation = await risk.getActiveReservation({ riskDecisionId: riskId, executionProfileId: profileId, nowMs });
    assert.equal(reservation, null);
    assert.throws(() => toGate9RiskHandoff({ riskDecisionId: riskId, reservation, nowMs }), /not available/);
  });
});
