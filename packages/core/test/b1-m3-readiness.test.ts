/**
 * B1 M3 — gates observe the authoritative readiness decision, not a coerced
 * flag.
 *
 * A provider that reports `healthy: true` while unavailable, uncertain, or
 * malformed must fail `provider_healthy` in both the composition and the
 * intake. The gate input carries the resolver's decision
 * (`readiness.gateValue`); no `Boolean(...)` coercion, no `{ healthy }`
 * projection of the raw record.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B1,
  ScriptPool,
  profileRow,
  riskDecision,
  scriptHappyPath,
  stubAudit,
  stubAutomation,
  stubKills,
  stubProvider,
  stubRegistry,
  stubRisk,
  wireComposition,
} from './support/b1-harness.js';
import { ExecutionIntakeService } from '../src/execution/intake.js';

const NOW = 1_786_000_001_000;

function happyInput(overrides: Record<string, unknown> = {}) {
  return { userId: B1.user, executionProfileId: B1.profile, setupId: B1.setup, nowMs: NOW, ...overrides };
}

function fullHealthy() {
  return {
    configured: true,
    authenticated: true,
    connected: true,
    available: true,
    healthy: true,
    state: 'healthy',
    checkedAt: new Date(NOW).toISOString(),
  };
}

describe('B1 M3 — composition refuses uncertain providers at provider_healthy', () => {
  const deceptive: Array<[string, Record<string, unknown>]> = [
    ['healthy but unavailable', { available: false }],
    ['healthy but uncertain state', { state: 'uncertain' }],
    ['healthy but unknown state', { state: 'unknown' }],
    ['healthy but disconnected', { connected: false }],
    ['healthy but unauthenticated', { authenticated: false }],
    ['truthy-string healthy flag', { healthy: 'yes' }],
  ];
  for (const [label, patch] of deceptive) {
    test(`${label} fails provider_healthy with zero submits`, async () => {
      const paper = stubProvider({ id: 'paper', health: { ...fullHealthy(), ...patch } });
      const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'paper' });
      const decision = riskDecision();
      const w = wireComposition({ pool, decision, clockMs: NOW, providers: [paper] });
      const out = await w.service.composeAndSubmit(happyInput());

      assert.equal(out.accepted, false, label);
      assert.equal(out.gate.failedGate, 'provider_healthy', label);
      assert.deepEqual(paper.submitCalls, [], `${label}: no provider submit`);
      assert.equal(w.paper.executeCalls.length, 0, `${label}: no paper handoff`);
      assert.equal(w.authorization.size(), 0, `${label}: no authorization minted`);
      assert.deepEqual(w.risk.released, [decision.id], `${label}: hold released`);
      assert.equal(pool.count('INSERT INTO execution_requests'), 0, `${label}: gate refusal persists nothing`);
    });
  }

  test('missing provider record fails provider_healthy (control: registry miss)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'paper' });
    const w = wireComposition({ pool, clockMs: NOW, providers: [] });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'provider_healthy');
  });

  test('fully healthy provider passes the gate (control)', async () => {
    const paper = stubProvider({ id: 'paper', health: fullHealthy() });
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'paper' });
    const w = wireComposition({ pool, clockMs: NOW, providers: [paper] });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
  });
});

describe('B1 M3 — intake refuses uncertain providers at provider_healthy', () => {
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

  function wireIntake(health: unknown) {
    const paper = stubProvider({ id: 'paper', health: health as any });
    const pool = new ScriptPool();
    pool.on('SELECT id, enabled, environment, provider_slug FROM execution_profiles', () => [profileRow('paper')]);
    pool.on('FROM setups st', () => [
      {
        setup_id: B1.setup,
        state: 'confirmed',
        direction: 'long',
        as_of_ms: '1786000000000',
        strategy_version_id: B1.version,
        strategy_id: B1.strategy,
        strategy_owner: B1.user,
        asset_class: 'forex',
        symbol: 'EURUSD',
      },
    ]);
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
          rejection_gate: 'provider_healthy',
          rejection_reason: 'execution provider is not healthy',
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
    const risk = stubRisk({ decision: riskDecision() });
    const audit = stubAudit();
    const service = new ExecutionIntakeService(pool.asPool(), {
      automation: automation.service,
      killSwitches: kills.service,
      providers: stubRegistry([paper.provider]),
      audit: audit.service,
      risk: risk.service,
    });
    return { service, risk };
  }

  test('healthy-but-unavailable provider fails provider_healthy', async () => {
    const { service, risk } = wireIntake({ ...fullHealthy(), available: false });
    const out = await service.submitExecutionDecision({
      userId: B1.user,
      executionProfileId: B1.profile,
      decision: validDecision(),
    });
    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'provider_healthy');
    assert.deepEqual(risk.released, [B1.decision]);
  });

  test('truthy-string healthy flag fails provider_healthy (no coercion)', async () => {
    const { service } = wireIntake({ ...fullHealthy(), healthy: 'yes' });
    const out = await service.submitExecutionDecision({
      userId: B1.user,
      executionProfileId: B1.profile,
      decision: validDecision(),
    });
    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'provider_healthy');
  });
});
