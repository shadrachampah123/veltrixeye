/**
 * B1 fence units — the pure guards in composition-fence.ts plus the final
 * safety fence against scripted doubles.
 *
 *  - H2 freezeCompositionInput / assertCompositionInputUnchanged
 *  - H3 resolveBrokerAccountAuthorization
 *  - M3 evaluateProviderReadinessForGate
 *  - H4 toGate9RiskHandoff
 *  - M5 mapBrokerSubmitOutcome
 *  - H5 runFinalSafetyFence (fresh-read verification with scripted deps)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCompositionInputUnchanged,
  evaluateProviderReadinessForGate,
  freezeCompositionInput,
  mapBrokerSubmitOutcome,
  resolveBrokerAccountAuthorization,
  runFinalSafetyFence,
  toGate9RiskHandoff,
} from '../src/execution/composition-fence.js';
import { ExecutionAuthorizationService } from '../src/execution/authorization.js';
import { ScriptPool, stubAutomation, stubKills } from './support/b1-harness.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROFILE = '22222222-2222-4222-8222-222222222222';
const SETUP = '33333333-3333-4333-8333-333333333333';
const DECISION = '88888888-8888-4888-8888-888888888888';

describe('B1 H2 — input snapshot is validated and frozen', () => {
  test('valid input snapshots with defaults', () => {
    const snap = freezeCompositionInput({ userId: USER, executionProfileId: PROFILE, setupId: SETUP });
    assert.equal(snap.userId, USER);
    assert.equal(snap.action, undefined);
    assert.equal(snap.riskDecisionId, null);
    assert.equal(snap.ip, null);
    assert.ok(snap.nowMs > 0);
    assert.equal(Object.isFrozen(snap), true);
  });

  test('invalid uuids, action, riskDecisionId, and nowMs throw invalidInput', () => {
    const good = { userId: USER, executionProfileId: PROFILE, setupId: SETUP };
    assert.throws(() => freezeCompositionInput({ ...good, userId: 'nope' }), /valid userId/);
    assert.throws(
      () => freezeCompositionInput({ ...good, executionProfileId: 'nope' }),
      /valid executionProfileId/,
    );
    assert.throws(() => freezeCompositionInput({ ...good, setupId: 'nope' }), /valid setupId/);
    assert.throws(
      () => freezeCompositionInput({ ...good, action: 'hold' as any }),
      /invalid action/,
    );
    assert.throws(
      () => freezeCompositionInput({ ...good, riskDecisionId: 'nope' }),
      /invalid riskDecisionId/,
    );
    assert.throws(() => freezeCompositionInput({ ...good, nowMs: Number.NaN }), /invalid nowMs/);
    assert.throws(() => freezeCompositionInput(null as any), /missing/);
  });

  test('assertCompositionInputUnchanged passes for the untouched object', () => {
    const live: any = { userId: USER, executionProfileId: PROFILE, setupId: SETUP, nowMs: 123 };
    const snap = freezeCompositionInput(live);
    assert.doesNotThrow(() => assertCompositionInputUnchanged(live, snap));
  });

  test('any caller mutation after the snapshot is detected', () => {
    const variants: Array<[string, (live: any) => void]> = [
      ['userId', (l) => { l.userId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; }],
      ['executionProfileId', (l) => { l.executionProfileId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; }],
      ['setupId', (l) => { l.setupId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; }],
      ['action', (l) => { l.action = 'open_short'; }],
      ['riskDecisionId', (l) => { l.riskDecisionId = DECISION; }],
      ['nowMs', (l) => { l.nowMs = 999; }],
    ];
    for (const [label, mutate] of variants) {
      const live: any = { userId: USER, executionProfileId: PROFILE, setupId: SETUP, nowMs: 123 };
      const snap = freezeCompositionInput(live);
      mutate(live);
      assert.throws(() => assertCompositionInputUnchanged(live, snap), /changed during evaluation/, label);
    }
  });
});

describe('B1 H3 — broker-account grant is authoritative', () => {
  test('paper/paper is authorized by construction', () => {
    assert.deepEqual(
      resolveBrokerAccountAuthorization({ providerSlug: 'paper', environment: 'paper' }),
      { brokerAuthorized: true, accountAuthorized: true },
    );
  });

  test('everything else fails closed — including exact metadata matches', () => {
    const cases = [
      { providerSlug: 'mt5', environment: 'demo' },
      { providerSlug: 'mt5', environment: 'live' },
      { providerSlug: 'paper', environment: 'demo' },
      { providerSlug: 'mt5', environment: 'paper' },
      { providerSlug: '', environment: '' },
      { providerSlug: 'MT5', environment: 'DEMO' },
    ];
    for (const input of cases) {
      assert.deepEqual(
        resolveBrokerAccountAuthorization(input),
        { brokerAuthorized: false, accountAuthorized: false },
        JSON.stringify(input),
      );
    }
  });

  test('the resolver takes no metadata argument — labels cannot authorize', () => {
    assert.equal(resolveBrokerAccountAuthorization.length, 1);
  });
});

describe('B1 M3 — readiness resolves the full health record', () => {
  const fullHealthy = {
    configured: true,
    authenticated: true,
    connected: true,
    available: true,
    healthy: true,
    state: 'healthy',
    checkedAt: new Date().toISOString(),
  };

  test('fully healthy record is ready', () => {
    const out = evaluateProviderReadinessForGate(fullHealthy);
    assert.equal(out.ready, true);
    assert.deepEqual(out.gateValue, { healthy: true });
    assert.equal(out.state, 'healthy');
  });

  test('healthy=true with available=false is NOT ready', () => {
    const out = evaluateProviderReadinessForGate({ ...fullHealthy, available: false });
    assert.equal(out.ready, false);
    assert.deepEqual(out.gateValue, { healthy: false });
  });

  test('healthy=true with an uncertain state is NOT ready', () => {
    const out = evaluateProviderReadinessForGate({ ...fullHealthy, state: 'uncertain' });
    assert.equal(out.ready, false);
    assert.deepEqual(out.gateValue, { healthy: false });
    assert.equal(out.state, 'uncertain');
  });

  test('truthy-but-malformed healthy flag is NOT ready (no Boolean coercion)', () => {
    const out = evaluateProviderReadinessForGate({ ...fullHealthy, healthy: 'yes' as any });
    assert.equal(out.ready, false);
    assert.deepEqual(out.gateValue, { healthy: false });
  });

  test('null and missing records are NOT ready', () => {
    for (const raw of [null, undefined, {}, { healthy: true }]) {
      const out = evaluateProviderReadinessForGate(raw);
      assert.equal(out.ready, false, JSON.stringify(raw));
      assert.deepEqual(out.gateValue, { healthy: false });
    }
  });

  test('explicit unhealthy record is NOT ready', () => {
    const out = evaluateProviderReadinessForGate({ ...fullHealthy, healthy: false, state: 'down' });
    assert.equal(out.ready, false);
    assert.deepEqual(out.gateValue, { healthy: false });
  });
});

describe('B1 H4 — Gate 9 risk handoff requires live positive cover', () => {
  const NOW = 1_786_000_000_000;

  test('live positive reservation passes with the exact exposure string', () => {
    const out = toGate9RiskHandoff({
      riskDecisionId: DECISION,
      reservation: { id: 'res-1', monetaryRisk: '50.00', expiresAt: new Date(NOW + 60_000) },
      nowMs: NOW,
    });
    assert.deepEqual(out, {
      riskDecisionId: DECISION,
      riskReservationId: 'res-1',
      monetaryRisk: '50.00',
      riskExpiresAt: new Date(NOW + 60_000),
    });
  });

  test('missing reservation fails closed (no zero-exposure handoff)', () => {
    assert.throws(
      () => toGate9RiskHandoff({ riskDecisionId: DECISION, reservation: null, nowMs: NOW }),
      /not available/,
    );
  });

  const badAmounts = ['0', '0.00', '-50.00', 'NaN', 'abc', '', '50,00', ' 50', 50 as any, null as any];
  for (const monetaryRisk of badAmounts) {
    test(`non-positive-decimal exposure ${JSON.stringify(monetaryRisk)} fails closed`, () => {
      assert.throws(
        () =>
          toGate9RiskHandoff({
            riskDecisionId: DECISION,
            reservation: { id: 'res-1', monetaryRisk, expiresAt: new Date(NOW + 60_000) },
            nowMs: NOW,
          }),
        /positive decimal/,
      );
    });
  }

  test('expired reservation fails closed', () => {
    assert.throws(
      () =>
        toGate9RiskHandoff({
          riskDecisionId: DECISION,
          reservation: { id: 'res-1', monetaryRisk: '50.00', expiresAt: new Date(NOW) },
          nowMs: NOW,
        }),
      /expired/,
    );
  });
});

describe('B1 M5 — broker outcome mapping is total and canonical', () => {
  const acceptedOutcome: any = { status: 'accepted', providerOrderId: 't-1', uncertain: false };
  const rejectedOutcome: any = { status: 'rejected', uncertain: false };

  test('submitted accepted → accepted, not a replay', () => {
    assert.deepEqual(
      mapBrokerSubmitOutcome({ status: 'ok', kind: 'submitted', result: {} as any, providerOutcome: acceptedOutcome }),
      { accepted: true, replayed: false, disposition: 'submitted_accepted' },
    );
  });

  test('submitted rejected → NOT accepted, never projected as accepted', () => {
    assert.deepEqual(
      mapBrokerSubmitOutcome({ status: 'ok', kind: 'submitted', result: {} as any, providerOutcome: rejectedOutcome }),
      { accepted: false, replayed: false, disposition: 'submitted_rejected' },
    );
  });

  test('duplicate onto confirmed → accepted AND replayed', () => {
    assert.deepEqual(
      mapBrokerSubmitOutcome({ status: 'ok', kind: 'duplicate', result: {} as any, providerOutcome: acceptedOutcome }),
      { accepted: true, replayed: true, disposition: 'duplicate_accepted' },
    );
  });

  test('duplicate onto rejected → rejected AND replayed', () => {
    assert.deepEqual(
      mapBrokerSubmitOutcome({ status: 'ok', kind: 'duplicate', result: {} as any, providerOutcome: rejectedOutcome }),
      { accepted: false, replayed: true, disposition: 'duplicate_rejected' },
    );
  });

  test('provider uncertain → NOT accepted, uncertainty preserved', () => {
    assert.deepEqual(
      mapBrokerSubmitOutcome({ status: 'error', kind: 'provider_uncertain', message: 'x', result: {} as any }),
      { accepted: false, replayed: false, disposition: 'uncertain' },
    );
  });

  test('duplicate onto unresolved → NOT accepted, replayed, unresolved', () => {
    assert.deepEqual(
      mapBrokerSubmitOutcome({ status: 'error', kind: 'duplicate_unresolved', message: 'x', result: {} as any }),
      { accepted: false, replayed: true, disposition: 'unresolved_duplicate' },
    );
  });

  const refused: Array<[string, any]> = [
    ['validation', { status: 'error', kind: 'validation', message: 'x' }],
    ['pre_call_persistence_failed', { status: 'error', kind: 'pre_call_persistence_failed', message: 'x' }],
    ['barrier_not_consumable', { status: 'error', kind: 'barrier_not_consumable' }],
    ['provider_binding_mismatch', { status: 'error', kind: 'provider_binding_mismatch', message: 'x' }],
  ];
  for (const [kind, outcome] of refused) {
    test(`pre-call refusal (${kind}) → NOT accepted`, () => {
      assert.deepEqual(mapBrokerSubmitOutcome(outcome), {
        accepted: false,
        replayed: false,
        disposition: 'refused',
      });
    });
  }
});

describe('B1 H5 — final safety fence verifies fresh state', () => {
  const NOW = 1_786_000_000_000;

  function fenceInput(overrides: Record<string, unknown> = {}) {
    return {
      userId: USER,
      executionProfileId: PROFILE,
      strategyId: '44444444-4444-4444-a444-444444444444',
      setupId: SETUP,
      providerSlug: 'paper',
      environment: 'paper' as const,
      accountRef: null,
      brokerServerRef: null,
      riskDecisionId: DECISION,
      authorizationId: 'auth-1',
      nowMs: NOW,
      ...overrides,
    };
  }

  function fenceDeps(opts: {
    profileRows?: any[];
    automation?: { entitled: boolean; enabled: boolean };
    kills?: { active: boolean };
    authorization?: ExecutionAuthorizationService;
    authorizationId?: string;
    reservation?: any;
  }) {
    const pool = new ScriptPool().on('FROM execution_profiles', opts.profileRows ?? [{ id: PROFILE, enabled: true }]);
    const automation = stubAutomation(opts.automation ?? { entitled: true, enabled: true });
    const kills = stubKills(opts.kills ?? { active: false });
    const authorization = opts.authorization ?? new ExecutionAuthorizationService();
    const reservation = opts.reservation === undefined ? { id: 'res-1' } : opts.reservation;
    return {
      pool,
      deps: {
        pool: pool.asPool(),
        automation: automation.service,
        killSwitches: kills.service,
        authorization,
        risk: { async getActiveReservation() { return reservation; } },
      },
    };
  }

  function mintLiveAuthorization(): { svc: ExecutionAuthorizationService; id: string } {
    const svc = new ExecutionAuthorizationService({ clock: () => NOW });
    const rec = svc.createAuthorization({
      userId: USER,
      executionProfileId: PROFILE,
      clientOrderId: `ve-${'e5'.repeat(12)}`,
      idempotencyKey: 'idem-fence',
      symbol: 'EURUSD',
      side: 'buy',
      quantity: 0.5,
      assetClass: 'forex',
      orderType: 'market',
      providerSlug: 'paper',
      environment: 'paper',
      accountRef: null,
      brokerServerRef: null,
      riskDecisionId: DECISION,
      setupId: SETUP,
    });
    return { svc, id: rec.id };
  }

  test('steady state passes and consumes nothing', async () => {
    const { svc, id } = mintLiveAuthorization();
    const { deps } = fenceDeps({ authorization: svc });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.deepEqual(out, { ok: true });
    assert.equal(svc.size(), 1, 'fence verification must not consume the authorization');
  });

  test('disabled profile fails closed (profile_enabled)', async () => {
    const { svc, id } = mintLiveAuthorization();
    const { deps } = fenceDeps({ authorization: svc, profileRows: [{ id: PROFILE, enabled: false }] });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.equal(out.ok, false);
    assert.equal((out as any).code, 'profile_disabled');
    assert.equal((out as any).failedGate, 'profile_enabled');
  });

  test('vanished profile fails closed', async () => {
    const { svc, id } = mintLiveAuthorization();
    const { deps } = fenceDeps({ authorization: svc, profileRows: [] });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.equal((out as any).code, 'profile_disabled');
  });

  test('automation switched off fails closed (automation_on)', async () => {
    const { svc, id } = mintLiveAuthorization();
    const { deps } = fenceDeps({ authorization: svc, automation: { entitled: true, enabled: false } });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.equal((out as any).code, 'automation_revoked');
    assert.equal((out as any).failedGate, 'automation_on');
  });

  test('entitlement revoked fails closed (entitlement)', async () => {
    const { svc, id } = mintLiveAuthorization();
    const { deps } = fenceDeps({ authorization: svc, automation: { entitled: false, enabled: true } });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.equal((out as any).code, 'entitlement_revoked');
    assert.equal((out as any).failedGate, 'entitlement');
  });

  test('active kill switch fails closed (kill_switch)', async () => {
    const { svc, id } = mintLiveAuthorization();
    const { deps } = fenceDeps({ authorization: svc, kills: { active: true } });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.equal((out as any).code, 'kill_switch_active');
    assert.equal((out as any).failedGate, 'kill_switch');
  });

  test('revoked authorization fails closed (authorized)', async () => {
    const { svc, id } = mintLiveAuthorization();
    svc.revokeAuthorization(id);
    const { deps } = fenceDeps({ authorization: svc });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.equal((out as any).code, 'authorization_revoked');
    assert.equal((out as any).failedGate, 'authorized');
  });

  test('authorization bound to a different context fails closed', async () => {
    const svc = new ExecutionAuthorizationService({ clock: () => NOW });
    const rec = svc.createAuthorization({
      userId: USER,
      executionProfileId: PROFILE,
      clientOrderId: `ve-${'e5'.repeat(12)}`,
      idempotencyKey: 'idem-fence',
      symbol: 'EURUSD',
      side: 'buy',
      quantity: 0.5,
      assetClass: 'forex',
      orderType: 'market',
      providerSlug: 'paper',
      environment: 'paper',
      accountRef: null,
      brokerServerRef: null,
      riskDecisionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc',
      setupId: SETUP,
    });
    const { deps } = fenceDeps({ authorization: svc });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: rec.id }));
    assert.equal((out as any).code, 'authorization_revoked');
    assert.equal((out as any).failedGate, 'authorized');
  });

  test('lapsed risk reservation fails closed (risk_decision)', async () => {
    const { svc, id } = mintLiveAuthorization();
    const { deps } = fenceDeps({ authorization: svc, reservation: null });
    const out = await runFinalSafetyFence(deps, fenceInput({ authorizationId: id }));
    assert.equal((out as any).code, 'risk_reservation_lapsed');
    assert.equal((out as any).failedGate, 'risk_decision');
  });

  test('infrastructure failure propagates loudly (never a silent pass)', async () => {
    const { svc, id } = mintLiveAuthorization();
    const pool = new ScriptPool().on('FROM execution_profiles', () => {
      throw new Error('connection reset');
    });
    const { deps } = fenceDeps({ authorization: svc });
    await assert.rejects(
      () => runFinalSafetyFence({ ...deps, pool: pool.asPool() }, fenceInput({ authorizationId: id })),
      /connection reset/,
    );
  });
});
