/**
 * B1 H2 — the composition snapshots caller input immutably before any await.
 *
 *  - Invalid input throws `invalidInput` before any database access.
 *  - A caller mutation landing mid-flight (after an await) throws
 *    `invalidInput` instead of mixing two execution contexts.
 *  - A caller-supplied riskDecisionId that disagrees with the fresh risk
 *    evaluation is rejected (the composition never executes on it).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B1,
  ScriptPool,
  profileRow,
  riskDecision,
  scriptHappyPath,
  setupRow,
  wireComposition,
} from './support/b1-harness.js';

function happyInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: B1.user,
    executionProfileId: B1.profile,
    setupId: B1.setup,
    nowMs: 1_786_000_001_000,
    ...overrides,
  };
}

describe('B1 H2 — invalid input throws before any state access', () => {
  test('control: the happy path accepts a paper fill', async () => {
    const pool = scriptHappyPath(new ScriptPool());
    const w = wireComposition({ pool, clockMs: 1_786_000_001_000 });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
    assert.equal(out.replayed, false);
    assert.equal(out.paperOutcome?.status, 'filled');
    assert.equal(out.providerOutcome, null);
    assert.equal(w.authorization.size(), 0, 'no stranded authorization');
  });

  const badInputs: Array<[string, Record<string, unknown>]> = [
    ['bad userId', { userId: 'not-a-uuid' }],
    ['bad executionProfileId', { executionProfileId: 'not-a-uuid' }],
    ['bad setupId', { setupId: 'not-a-uuid' }],
    ['bad action', { action: 'hold' }],
    ['bad riskDecisionId', { riskDecisionId: 'not-a-uuid' }],
    ['bad nowMs', { nowMs: Number.NaN }],
  ];
  for (const [label, patch] of badInputs) {
    test(`${label} throws invalidInput with zero queries`, async () => {
      const pool = scriptHappyPath(new ScriptPool());
      const w = wireComposition({ pool, clockMs: 1_786_000_001_000 });
      await assert.rejects(() => w.service.composeAndSubmit(happyInput(patch)), /valid|invalid/);
      assert.equal(pool.calls.length, 0, 'no database access before input validation');
      assert.equal(w.risk.evaluateCalls.length, 0);
      assert.equal(w.paper.executeCalls.length, 0);
      assert.equal(w.authorization.size(), 0);
    });
  }
});

describe('B1 H2 — caller mutation mid-flight throws instead of mixing contexts', () => {
  test('mutating userId during the profile load throws invalidInput', async () => {
    const input: any = happyInput();
    const pool = new ScriptPool();
    // Flip the caller object while the composition is awaiting the profile.
    pool.on('account_ref', () => {
      input.userId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      return [profileRow('paper')];
    });
    scriptHappyPath(pool);
    const w = wireComposition({ pool, clockMs: 1_786_000_001_000 });
    await assert.rejects(() => w.service.composeAndSubmit(input), /changed during evaluation/);
    assert.equal(w.risk.evaluateCalls.length, 0, 'no risk work after the race is detected');
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
  });

  test('mutating setupId during the risk evaluation throws invalidInput', async () => {
    const input: any = happyInput();
    const pool = scriptHappyPath(new ScriptPool());
    const w = wireComposition({ pool, clockMs: 1_786_000_001_000 });
    // Flip the caller object while the risk stub is "awaiting".
    const inner = w.risk.service;
    (w.service as any).deps.risk = {
      ...inner,
      evaluate: async (args: any) => {
        input.setupId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
        return inner.evaluate(args);
      },
    };
    await assert.rejects(() => w.service.composeAndSubmit(input), /changed during evaluation/);
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
  });

  test('every ownership lookup used the snapshot values (A), never the mutated ones (B)', async () => {
    const input: any = happyInput();
    const pool = new ScriptPool();
    pool.on('account_ref', () => {
      input.executionProfileId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
      return [profileRow('paper')];
    });
    scriptHappyPath(pool);
    const w = wireComposition({ pool, clockMs: 1_786_000_001_000 });
    await assert.rejects(() => w.service.composeAndSubmit(input), /changed during evaluation/);
    const profileCalls = pool.calls.filter((c) => c.text.includes('FROM execution_profiles'));
    assert.equal(profileCalls.length, 1);
    assert.deepEqual(profileCalls[0]!.params, [B1.profile, B1.user]);
  });
});

describe('B1 H2 — the composition never executes on a caller-supplied risk id', () => {
  test('matching riskDecisionId proceeds; mismatched is rejected and the hold released', async () => {
    const decision = riskDecision();
    const pool = scriptHappyPath(new ScriptPool());
    const w = wireComposition({ pool, decision, clockMs: 1_786_000_001_000 });
    const ok = await w.service.composeAndSubmit(happyInput({ riskDecisionId: decision.id }));
    assert.equal(ok.accepted, true);

    const pool2 = scriptHappyPath(new ScriptPool());
    const w2 = wireComposition({ pool: pool2, decision, clockMs: 1_786_000_001_000 });
    const out = await w2.service.composeAndSubmit(
      happyInput({ riskDecisionId: 'dddddddd-dddd-4ddd-dddd-dddddddddddd' }),
    );
    assert.equal(out.accepted, false);
    assert.equal(out.gate.failedGate, 'risk_decision');
    assert.match(out.gate.reason ?? '', /does not match the fresh risk evaluation/);
    assert.deepEqual(w2.risk.released, [decision.id], 'the fresh hold is released');
    assert.equal(w2.paper.executeCalls.length, 0);
    assert.equal(w2.authorization.size(), 0);
    assert.equal(pool2.count('INSERT INTO execution_requests'), 0, 'no persistence on mismatch');
  });
});
