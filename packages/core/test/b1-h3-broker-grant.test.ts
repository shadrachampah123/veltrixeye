/**
 * B1 H3 — broker execution fails closed without an authoritative grant.
 *
 * No server-verified broker-account grant exists anywhere in the platform:
 * `account_ref` / `broker_server` are user-editable labels, the connection
 * test persists no handshake, and no code path records a verified binding.
 * The composition and the intake therefore authorize paper/paper by
 * construction and refuse every broker profile at the `broker_authorized`
 * gate — even when the editable metadata matches the provider's describe()
 * configuration exactly.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B1,
  ScriptPool,
  paperFill,
  paperIdentity,
  profileRow,
  riskDecision,
  scriptHappyPath,
  setupRow,
  stubProvider,
  stubRegistry,
  stubAutomation,
  stubKills,
  stubRisk,
  stubAudit,
  wireComposition,
} from './support/b1-harness.js';
import { ExecutionIntakeService } from '../src/execution/intake.js';

const NOW = 1_786_000_001_000;

function happyInput(overrides: Record<string, unknown> = {}) {
  return { userId: B1.user, executionProfileId: B1.profile, setupId: B1.setup, nowMs: NOW, ...overrides };
}

describe('B1 H3 — broker composition fails closed at broker_authorized', () => {
  test('broker profile with perfectly matching metadata is refused; nothing downstream runs', async () => {
    const mt5 = stubProvider({ id: 'mt5', environment: 'demo' });
    const paper = stubProvider({ id: 'paper' });
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'broker' });
    const w = wireComposition({ pool, clockMs: NOW, providers: [paper, mt5] });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.replayed, false);
    assert.equal(out.gate.failedGate, 'broker_authorized');
    assert.equal(out.authorizationId, null, 'no authorization is minted for a refused broker submit');
    assert.equal(out.providerOutcome, null);
    assert.equal(out.paperOutcome, null);

    // Zero downstream effects.
    assert.deepEqual(mt5.submitCalls, [], 'no provider submit');
    assert.deepEqual(paper.submitCalls, [], 'no paper-provider submit either');
    assert.equal(w.ledger.intentCalls.length, 1, 'only the read-only replay pre-check touches the ledger');
    assert.deepEqual(w.ledger.receiptCalls, [], 'no receipt read without an intent');
    assert.equal(w.paper.executeCalls.length, 0, 'paper simulator untouched');
    assert.equal(pool.count('INSERT INTO execution_requests'), 0, 'gate refusal persists nothing');
    assert.deepEqual(w.risk.released, [B1.decision], 'the risk hold is released');
    assert.equal(w.authorization.size(), 0);
  });

  test('broker/paper-environment mismatch also fails closed (paper slug on demo)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      profile: profileRow('paper', { environment: 'demo' }),
    });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, false);
    // paper slug on a demo environment is not the authorized paper/paper pair.
    assert.equal(out.gate.failedGate, 'broker_authorized');
  });

  test('control: paper/paper passes the grant and fills', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'paper' });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
    assert.equal(out.paperOutcome?.status, 'filled');
    assert.equal(out.providerOutcome, null, 'paper never touches the Gate 9 shapes');
    assert.deepEqual(w.ledger.intentCalls, [], 'paper never consults the broker ledger');
  });

  test('broker replay pre-check still reports durable history (read-only)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'broker' });
    const w = wireComposition({
      pool,
      clockMs: NOW,
      ledgerIntent: {
        id: 'intent-1',
        userId: B1.user,
        executionProfileId: B1.profile,
        clientOrderId: `ve-${'f1'.repeat(12)}`,
        idempotencyKey: 'x'.repeat(64),
        status: 'rejected',
        outcome: 'rejected',
        attempt: 1,
        uncertaintyReason: null,
        terminalEvidence: null,
      },
      ledgerReceipt: { id: 'rcpt-1', providerOrderId: null },
    });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, false);
    assert.equal(out.replayed, true);
    assert.equal(out.providerOutcome?.status, 'ok');
    assert.equal(w.risk.evaluateCalls.length, 0, 'replay allocates no risk work');
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.ledger.receiptCalls, ['intent-1']);
  });
});

describe('B1 H3 — intake authorizes paper and refuses broker', () => {
  function validDecision() {
    return {
      strategyId: B1.strategy,
      strategyVersionId: B1.version,
      setupId: B1.setup,
      action: 'open_long',
      assetClass: 'forex',
      symbol: 'EURUSD',
      timeframe: '5m',
      direction: 'long',
      entryPrice: 1.1,
      stopLossPrice: 1.09,
      takeProfitPrice: 1.12,
      expectedRr: 2,
      qualityScore: 80,
      minQualityScore: 60,
      asOfMs: 1_786_000_000_000,
    };
  }

  function intakeSetupRow() {
    return {
      setup_id: B1.setup,
      state: 'confirmed',
      direction: 'long',
      as_of_ms: '1786000000000',
      strategy_version_id: B1.version,
      strategy_id: B1.strategy,
      strategy_owner: B1.user,
      asset_class: 'forex',
      symbol: 'EURUSD',
    };
  }

  function wireIntake(profile: any, providerStubs: Array<{ provider: any; submitCalls: any[] }>) {
    const pool = new ScriptPool();
    pool.on('SELECT id, enabled, environment, provider_slug FROM execution_profiles', () => [profile]);
    pool.on('FROM setups st', () => [intakeSetupRow()]);
    let findCalls = 0;
    pool.on('SELECT * FROM execution_requests WHERE idempotency_key', () => {
      findCalls += 1;
      if (findCalls === 1) return [];
      return [
        {
          id: B1.request,
          user_id: B1.user,
          execution_profile_id: B1.profile,
          setup_id: B1.setup,
          action: 'open_long',
          status: 'rejected',
          rejection_gate: 'broker_authorized',
          rejection_reason: 'broker account is not authorized for execution',
          decision: validDecision(),
          idempotency_key: 'k',
          architecture_version: 'test',
          created_at: new Date('2026-09-21T00:00:00.000Z'),
        },
      ];
    });
    pool.on('INSERT INTO execution_requests', () => []);
    pool.on('INSERT INTO execution_events', () => []);
    const automation = stubAutomation({ entitled: true, enabled: true });
    const kills = stubKills({ active: false });
    const decision = riskDecision();
    const risk = stubRisk({ decision });
    const audit = stubAudit();
    const service = new ExecutionIntakeService(pool.asPool(), {
      automation: automation.service,
      killSwitches: kills.service,
      providers: stubRegistry(providerStubs.map((p) => p.provider)),
      audit: audit.service,
      risk: risk.service,
    });
    return { pool, service, risk, audit };
  }

  test('broker intake is rejected at broker_authorized and the risk hold is released', async () => {
    const mt5 = stubProvider({ id: 'mt5', environment: 'demo' });
    const { service, risk, pool } = wireIntake(profileRow('broker'), [mt5]);
    const out = await service.submitExecutionDecision({
      userId: B1.user,
      executionProfileId: B1.profile,
      decision: validDecision(),
    });
    assert.equal(out.accepted, false);
    assert.equal(out.replayed, false);
    assert.equal(out.gate.failedGate, 'broker_authorized');
    assert.deepEqual(mt5.submitCalls, [], 'intake never submits');
    assert.deepEqual(risk.released, [B1.decision], 'refused intake releases the reservation');
    assert.equal(pool.count('INSERT INTO execution_events'), 1);
  });

  test('paper intake passes the grant gates (fails later only because automation is stubbed off downstream)', async () => {
    // With everything green, paper intake is ACCEPTED (the stubs entitle
    // automation, unlike production where no plan grants it).
    const paper = stubProvider({ id: 'paper' });
    const { service } = wireIntake(profileRow('paper'), [paper]);
    const out = await service.submitExecutionDecision({
      userId: B1.user,
      executionProfileId: B1.profile,
      decision: validDecision(),
    });
    assert.equal(out.gate.failedGate, null);
    assert.equal(out.accepted, true);
  });
});
