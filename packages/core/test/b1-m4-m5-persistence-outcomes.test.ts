/**
 * B1 M4 + M5 — fail-closed persistence and canonical replay outcomes.
 *
 * M4: the execution-request insert recovers ONLY from a recognized identity
 * conflict (23505 / ON CONFLICT DO NOTHING) and ONLY onto a verified
 * same-user row. Every other persistence failure throws loudly with the
 * risk hold released and no submit reachable.
 *
 * M5: the replay pre-check reports already-resolved duplicates before any
 * risk, authorization, persistence, or submission work — paper from the
 * live paper order, broker from the durable Gate 9 intent (B2
 * duplicate-resolution parity). Unresolved history stays explicitly
 * unresolved, never projected as accepted or rejected.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  B1,
  ScriptPool,
  paperIdentity,
  riskDecision,
  scriptHappyPath,
  wireComposition,
} from './support/b1-harness.js';

const NOW = 1_786_000_001_000;

function happyInput(overrides: Record<string, unknown> = {}) {
  return { userId: B1.user, executionProfileId: B1.profile, setupId: B1.setup, nowMs: NOW, ...overrides };
}

function pgError(code: string, message: string): any {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

describe('B1 M4 — persistence fails closed except onto a verified row', () => {
  test('CHECK violation (23514) throws, releases the hold, and never submits', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      insertFn: () => {
        throw pgError('23514', 'new row violates check constraint "execution_requests_status_check"');
      },
    });
    const decision = riskDecision();
    const w = wireComposition({ pool, decision, clockMs: NOW });
    await assert.rejects(() => w.service.composeAndSubmit(happyInput()), /check constraint/);
    assert.deepEqual(w.risk.released, [decision.id]);
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0, 'no authorization is minted before persistence');
    assert.equal(pool.count('INSERT INTO execution_events'), 0, 'a throw is not a gate rejection');
  });

  test('foreign-key violation (23503) throws loudly', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      insertFn: () => {
        throw pgError('23503', 'insert violates foreign key "execution_requests_setup_id_fkey"');
      },
    });
    const w = wireComposition({ pool, clockMs: NOW });
    await assert.rejects(() => w.service.composeAndSubmit(happyInput()), /foreign key/);
    assert.deepEqual(w.risk.released, [B1.decision]);
    assert.equal(w.paper.executeCalls.length, 0);
  });

  test('identity conflict that resolves to no row throws internal (no silent acceptance)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      insertFn: () => [],
      conflictRows: [],
    });
    const w = wireComposition({ pool, clockMs: NOW });
    await assert.rejects(() => w.service.composeAndSubmit(happyInput()), /could not be resolved/);
    assert.deepEqual(w.risk.released, [B1.decision]);
    assert.equal(w.paper.executeCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
  });

  test('identity conflict resolving to ANOTHER user throws (ownership enforced)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      insertFn: () => {
        throw pgError('23505', 'duplicate key value violates unique constraint');
      },
      conflictRows: [{ id: B1.request, user_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }],
    });
    const w = wireComposition({ pool, clockMs: NOW });
    await assert.rejects(() => w.service.composeAndSubmit(happyInput()), /another user/);
    assert.deepEqual(w.risk.released, [B1.decision]);
    assert.equal(w.paper.executeCalls.length, 0);
  });

  test('recognized 23505 onto a verified same-user row recovers and accepts (control)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      insertFn: () => {
        throw pgError('23505', 'duplicate key value violates unique constraint "execution_requests_idempotency_key_key"');
      },
      conflictRows: [{ id: B1.request, user_id: B1.user }],
    });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
    assert.equal(out.requestId, B1.request);
    assert.deepEqual(w.risk.released, [], 'recovery keeps the hold (the attempt proceeds)');
  });

  test('ON CONFLICT DO NOTHING with a verified row recovers and accepts (control)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      insertFn: () => [],
      conflictRows: [{ id: B1.request, user_id: B1.user }],
    });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
    assert.equal(out.requestId, B1.request);
  });
});

describe('B1 M5 — replay pre-check reports durable history without new work', () => {
  test('paper live order replays as accepted with zero risk/auth/submit work', async () => {
    const identity = paperIdentity({
      liveOrder: { providerOrderId: 'paper-order-9', orderId: 'paper-order-9' },
    });
    const pool = scriptHappyPath(new ScriptPool(), { replayRows: [{ id: B1.request, user_id: B1.user, status: 'requested' }] });
    const w = wireComposition({ pool, paperIdentity: identity, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, true);
    assert.equal(out.replayed, true);
    assert.equal(out.paperOutcome?.status, 'replayed');
    assert.equal(out.paperOutcome?.providerOrderId, 'paper-order-9');
    assert.equal(out.clientOrderId, identity.clientOrderId);
    assert.equal(out.authorizationId, null);
    assert.equal(out.riskDecisionId, null);
    assert.equal(w.risk.evaluateCalls.length, 0, 'no risk work for a replay');
    assert.equal(w.authorization.size(), 0, 'no authorization minted');
    assert.equal(w.paper.executeCalls.length, 0, 'no second fill');
    assert.equal(w.paper.identityCalls.length, 1, 'identity derived once (read-only)');
    assert.equal(pool.count('INSERT INTO execution_requests'), 0, 'no persistence for a replay');
  });

  test('paper request row WITHOUT a live order proceeds (a row alone is not execution)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { replayRows: [{ id: B1.request, user_id: B1.user, status: 'requested' }] });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, true);
    assert.equal(out.replayed, false);
    assert.equal(w.risk.evaluateCalls.length, 1);
  });

  function brokerIntent(status: string, overrides: Record<string, unknown> = {}) {
    return {
      id: 'intent-1',
      userId: B1.user,
      executionProfileId: B1.profile,
      clientOrderId: `ve-${'f1'.repeat(12)}`,
      idempotencyKey: 'x'.repeat(64),
      status,
      outcome: status === 'confirmed' ? 'accepted' : status === 'rejected' ? 'rejected' : 'uncertain',
      attempt: 1,
      uncertaintyReason: status === 'uncertain' ? 'provider timeout' : null,
      terminalEvidence: null,
      ...overrides,
    };
  }

  test('broker confirmed intent with a verified ticket replays as accepted (read-only)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'broker' });
    const w = wireComposition({
      pool,
      clockMs: NOW,
      ledgerIntent: brokerIntent('confirmed'),
      ledgerReceipt: { id: 'rcpt-1', providerOrderId: 'ticket-7' },
    });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, true);
    assert.equal(out.replayed, true);
    assert.equal(out.providerOutcome?.status, 'ok');
    assert.equal((out.providerOutcome as any)?.kind, 'duplicate');
    assert.equal((out.providerOutcome as any)?.providerOutcome?.providerOrderId, 'ticket-7');
    assert.equal(w.risk.evaluateCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
  });

  test('broker confirmed intent WITHOUT a ticket stays unresolved (never accepted)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'broker' });
    const w = wireComposition({
      pool,
      clockMs: NOW,
      ledgerIntent: brokerIntent('confirmed'),
      ledgerReceipt: null,
    });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.replayed, true);
    assert.equal(out.providerOutcome?.status, 'error');
    assert.equal((out.providerOutcome as any)?.kind, 'duplicate_unresolved');
    assert.equal(w.risk.evaluateCalls.length, 0);
    assert.equal(w.authorization.size(), 0);
  });

  test('broker rejected intent replays as rejected (never accepted)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'broker' });
    const w = wireComposition({
      pool,
      clockMs: NOW,
      ledgerIntent: brokerIntent('rejected'),
      ledgerReceipt: { id: 'rcpt-1', providerOrderId: null },
    });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.replayed, true);
    assert.equal(out.providerOutcome?.status, 'ok');
    assert.equal((out.providerOutcome as any)?.providerOutcome?.status, 'rejected');
  });

  test('broker uncertain intent replays as explicitly unresolved', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'broker' });
    const w = wireComposition({
      pool,
      clockMs: NOW,
      ledgerIntent: brokerIntent('uncertain'),
    });
    const out = await w.service.composeAndSubmit(happyInput());

    assert.equal(out.accepted, false);
    assert.equal(out.replayed, true);
    assert.equal(out.providerOutcome?.status, 'error');
    assert.equal((out.providerOutcome as any)?.kind, 'duplicate_unresolved');
    assert.equal(out.gate.passed, false);
    assert.equal(out.gate.failedGate, null);
    assert.match(out.gate.reason ?? '', /not durably resolved/);
    assert.equal(w.risk.evaluateCalls.length, 0);
  });

  test('broker submitting intent replays as explicitly unresolved', async () => {
    const pool = scriptHappyPath(new ScriptPool(), { profileEnv: 'broker' });
    const w = wireComposition({
      pool,
      clockMs: NOW,
      ledgerIntent: brokerIntent('submitting'),
    });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, false);
    assert.equal(out.replayed, true);
    assert.equal((out.providerOutcome as any)?.kind, 'duplicate_unresolved');
  });

  test('request row owned by another user fails closed (masked identity anomaly)', async () => {
    const pool = scriptHappyPath(new ScriptPool(), {
      replayRows: [{ id: B1.request, user_id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', status: 'requested' }],
    });
    const w = wireComposition({ pool, clockMs: NOW });
    const out = await w.service.composeAndSubmit(happyInput());
    assert.equal(out.accepted, false);
    assert.equal(out.replayed, false);
    assert.equal(out.gate.failedGate, 'authorized');
    assert.equal(w.risk.evaluateCalls.length, 0);
  });
});
