/**
 * B1 H6 + M2 — action integrity and real setup provenance.
 *
 * H6: the opening-order path derives its action from the setup direction
 * (`long`→`open_long`, `short`→`open_short`) through the established
 * validated decision builder. A caller override may only restate that
 * action; a cross-direction open or `close_position` is rejected at
 * `valid_signal` before any risk, persistence, or submission work.
 *
 * M2: the decision cites real provenance only — stored levels, stored
 * quality, configured minimums, real timeframes. Missing provenance fails
 * closed with the builder's own reason; nothing is invented.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B1,
  ScriptPool,
  scriptHappyPath,
  setupRow,
  wireComposition,
} from './support/b1-harness.js';

const NOW = 1_786_000_001_000;

function happyInput(overrides: Record<string, unknown> = {}) {
  return { userId: B1.user, executionProfileId: B1.profile, setupId: B1.setup, nowMs: NOW, ...overrides };
}

describe('B1 H6 — caller action overrides cannot switch or invent actions', () => {
  test('cross-direction override (long setup + open_short) is rejected with zero side effects', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { setup: setupRow('long') });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput({ action: 'open_short' }));

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'valid_signal');
    assert.match(out.gate.reason ?? '', /conflicts with the setup direction/);
    assert.equal(out.clientOrderId, null, 'no identity is derived for a rejected action');
    assert.equal(w.risk.evaluateCalls.length, 0, 'no risk work');
    assert.equal(pool.count('INSERT INTO execution_requests'), 0, 'no persistence');
    assert.equal(w.paper.executeCalls.length, 0, 'no submit');
    assert.equal(w.authorization.size(), 0);
    assert.deepEqual(w.ledger.intentCalls, [], 'no ledger reads');
  });

  test('cross-direction override (short setup + open_long) is rejected', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { setup: setupRow('short') });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput({ action: 'open_long' }));

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'valid_signal');
    assert.equal(w.risk.evaluateCalls.length, 0);
    assert.equal(pool.count('INSERT INTO execution_requests'), 0);
  });

  test('close_position is rejected on the opening-order path', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { setup: setupRow('long') });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput({ action: 'close_position' }));

    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'valid_signal');
    assert.match(out.gate.reason ?? '', /close_position is not supported/);
    assert.equal(w.risk.evaluateCalls.length, 0);
    assert.equal(pool.count('INSERT INTO execution_requests'), 0);
    assert.equal(w.paper.executeCalls.length, 0);
  });

  test('restating the derived action proceeds (control)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { setup: setupRow('long') });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput({ action: 'open_long' }));
    assert.equal(out.accepted, true);
    assert.equal(w.paper.executeCalls.length, 1);
    assert.equal(w.paper.executeCalls[0].decision.action, 'open_long');
  });

  test('omitting the action derives open_short from a short setup (control)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { setup: setupRow('short') });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
    assert.equal(w.paper.executeCalls[0].decision.action, 'open_short');
    assert.equal(w.paper.executeCalls[0].decision.direction, 'short');
  });
});

describe('B1 M2 — decisions cite real provenance or fail closed', () => {
  const provenanceHoles: Array<[string, Record<string, unknown>, RegExp]> = [
    ['unscored setup', { quality_score: null }, /has not been scored/],
    ['missing risk configuration', { min_quality_score: null }, /no risk configuration/],
    ['missing setup timeframe', { setup_timeframe: null, entry_timeframe: null }, /no usable setup timeframe/],
    ['unusable setup timeframe', { setup_timeframe: '99x', entry_timeframe: null }, /no usable setup timeframe/],
    ['missing entry price', { entry_price: null }, /no valid entry price/],
    ['missing stop loss', { stop_loss_price: null }, /no valid stop loss/],
    ['missing take profit', { tp1_price: null }, /no valid take profit/],
    ['non-confirmed state', { state: 'draft' }, /not eligible for execution/],
  ];
  for (const [label, setupPatch, reason] of provenanceHoles) {
    test(`${label} is rejected with zero side effects`, async () => {
      const pool = scriptHappyPath(new ScriptPool(), { setup: setupRow('long', setupPatch) });
      const w = wireComposition({ pool, clockMs: NOW });
      const out = await w.service.composeAndSubmit(happyInput());

      assert.equal(out.accepted, false);
      assert.equal(out.gate.failedGate, 'valid_signal');
      assert.match(out.gate.reason ?? '', reason, label);
      assert.equal(w.risk.evaluateCalls.length, 0, `${label}: no risk work`);
      assert.equal(pool.count('INSERT INTO execution_requests'), 0, `${label}: no persistence`);
      assert.equal(w.paper.executeCalls.length, 0, `${label}: no submit`);
      assert.equal(w.authorization.size(), 0);
    });
  }

  test('below-minimum quality is rejected (stored quality vs configured minimum)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      setup: setupRow('long', { quality_score: 40, min_quality_score: 60 }),
    });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, false);
    assert.match(out.gate.reason ?? '', /below the configured minimum/);
    assert.equal(w.risk.evaluateCalls.length, 0);
  });

  test('risk receives the server-built levels (never caller claims)', async () => {
    const pool = scriptHappyPath(new ScriptPool());
    const w = wireComposition({ pool, clockMs: NOW });
    await w.service.composeAndSubmit(happyInput());
    assert.equal(w.risk.evaluateCalls.length, 1);
    const decision = w.risk.evaluateCalls[0].decision;
    assert.equal(decision.entryPrice, 1.1);
    assert.equal(decision.stopLossPrice, 1.09);
    assert.equal(decision.takeProfitPrice, 1.12);
    assert.equal(decision.qualityScore, 80);
    assert.equal(decision.setupId, B1.setup);
    assert.equal(w.risk.evaluateCalls[0].reserveOnApprove, true);
  });
});
