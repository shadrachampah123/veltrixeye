/**
 * B1 H5 — the final safety fence catches state that flips between the early
 * gate reads and the submit.
 *
 * Each test holds the early reads green and flips exactly one safety input
 * before the fence's fresh re-reads (scripted by call count, fully
 * deterministic). Every flip must: refuse acceptance, report the mapped
 * gate, run zero submits, revoke the minted authorization (never stranded),
 * and release the risk hold.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B1,
  ScriptPool,
  profileRow,
  reservationFor,
  riskDecision,
  scriptHappyPath,
  wireComposition,
} from './support/b1-harness.js';

const NOW = 1_786_000_001_000;

function happyInput(overrides: Record<string, unknown> = {}) {
  return { userId: B1.user, executionProfileId: B1.profile, setupId: B1.setup, nowMs: NOW, ...overrides };
}

describe('B1 H5 — mid-flight safety flips are caught at the fence', () => {
  test('kill switch trips after the early read → kill_switch, no submit, no stranded grant', async () => {
    const pool = scriptHappyPath(new ScriptPool());
    const decision = riskDecision();
    const w = wireComposition({
      pool,
      decision,
      clockMs: NOW,
      kills: [{ active: false }, { active: true, user: true }],
    });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.replayed, false);
    assert.equal(out.gate.failedGate, 'kill_switch');
    assert.equal(w.kills.calls, 2, 'early read green, fence read tripped');
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0, 'minted authorization revoked, not stranded');
    assert.deepEqual(w.risk.released, [decision.id]);
    assert.equal(pool.count('INSERT INTO execution_events'), 1);
  });

  test('automation switched off after the early read → automation_on', async () => {
    const pool = scriptHappyPath(new ScriptPool());
    const decision = riskDecision();
    const w = wireComposition({
      pool,
      decision,
      clockMs: NOW,
      automation: [
        { entitled: true, enabled: true },
        { entitled: true, enabled: false },
      ],
    });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'automation_on');
    assert.equal(w.automation.calls, 2);
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.risk.released, [decision.id]);
  });

  test('entitlement revoked after the early read → entitlement', async () => {
    const pool = scriptHappyPath(new ScriptPool());
    const decision = riskDecision();
    const w = wireComposition({
      pool,
      decision,
      clockMs: NOW,
      automation: [
        { entitled: true, enabled: true },
        { entitled: false, enabled: true },
      ],
    });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'entitlement');
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.risk.released, [decision.id]);
  });

  test('profile disabled after the early read → profile_enabled', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      profile: profileRow('paper', { enabled: true }),
      fenceProfile: [{ id: B1.profile, enabled: false }],
    });
    const decision = riskDecision();
    const w = wireComposition({ pool, decision, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'profile_enabled');
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.risk.released, [decision.id]);
  });

  test('authorization revoked after the mint → authorized', async () => {
    const pool = new ScriptPool();
    let w: ReturnType<typeof wireComposition>;
    // Revoke the live authorization while the fence is performing its first
    // fresh read (after the mint, before the fence's peek).
    pool.on('SELECT id, enabled FROM execution_profiles', () => {
      w.authorization.clear();
      return [{ id: B1.profile, enabled: true }];
    });
    scriptHappyPath(pool);
    const decision = riskDecision();
    w = wireComposition({ pool, decision, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'authorized');
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.risk.released, [decision.id]);
  });

  test('risk reservation lapses before the fence → risk_decision', async () => {
    const pool = scriptHappyPath(new ScriptPool());
    const decision = riskDecision();
    const w = wireComposition({
      pool,
      decision,
      clockMs: NOW,
      reservations: [reservationFor(decision), null],
    });
    // Drain the first (live) entry with a pre-flight read so the fence's own
    // read observes the lapse — the reservation died between the two reads.
    await w.risk.service.getActiveReservation({ riskDecisionId: decision.id, executionProfileId: B1.profile });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'risk_decision');
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.risk.released, [decision.id]);
  });

  test('control: no flips → the fence passes and the paper fill is accepted', async () => {
    const pool = scriptHappyPath(new ScriptPool());
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
    assert.equal(out.replayed, false);
    assert.equal(w.paper.executeCalls.length, 1);
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.risk.released, [], 'nothing to release on the accepted path (paper owns cleanup)');
  });
});
