/**
 * M10 Gate 9 — fake-provider readiness (MEDIUM-1, MEDIUM-2, barrier reuse).
 *
 * Focused tests covering:
 * 5. logical duplicate (ledger-level)
 * 6. provider-level duplicate (provider-reported)
 * 7. barrier reuse
 * 8. existing Gate 9 persistence behavior (sanity)
 * 9. Gate 10 redaction behavior (sanity, via existing suite)
 *
 * Uses embedded Postgres + deterministic FakeBridge (test-only support).
 * No network, no broker credentials, no MT5 live path.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations } from '../src/index.js';
import { ProviderMutationLedger, type SubmitIntentInput, type SubmitBarrier } from '../src/execution/provider-mutations.js';
import { FakeBridge, DeterministicFakeProvider } from './support/fake-bridge.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5466;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_gate9_fake_readiness';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let ledger: ProviderMutationLedger;

before(async () => {
  const dataDir = path.join(REPO_ROOT, 'packages', '.test', 'pg-m10-gate9-fake-readiness');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({ dataDir, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  ledger = new ProviderMutationLedger(pool);
}, { timeout: 240_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

const uniqueEmail = () => `gate9fr_${randomBytes(6).toString('hex')}@example.com`;
async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Gate9 Fake Readiness') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}
async function makeProfile(userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_profiles (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status) VALUES ($1,$2,'paper','paper','paper','gate9-acct',true,'connected')`,
    [id, userId],
  );
  return id;
}
const newClientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;
const newIdempotencyKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');

function submitInput(args: { userId: string; profileId: string; clientOrderId?: string; idempotencyKey?: string }): SubmitIntentInput {
  const clientOrderId = args.clientOrderId ?? newClientOrderId();
  const idempotencyKey = args.idempotencyKey ?? newIdempotencyKey();
  return {
    userId: args.userId,
    executionProfileId: args.profileId,
    clientOrderId,
    idempotencyKey,
    canonicalRequest: { clientOrderId, idempotencyKey, symbol: 'EURUSD', side: 'buy', orderType: 'market', quantity: 0.1 },
    providerSlug: 'paper',
    environment: 'paper',
    accountRef: 'gate9-acct',
    credentialRef: 'cred-ref-gate9',
    credentialFingerprint: createHash('sha256').update('gate9-binding').digest('hex'),
    symbol: 'EURUSD',
    direction: 'long',
    monetaryRisk: '25',
  };
}

describe('MEDIUM-1 — logical duplicate vs provider-level duplicate', () => {
  test('5. logical duplicate: same identity resolves onto existing intent without provider call', async () => {
    const userId = await makeUser();
    const profileId = await makeProfile(userId);
    const bridge = new FakeBridge({ kind: 'accept' });
    const fake = new DeterministicFakeProvider(bridge);
    const input = submitInput({ userId, profileId });

    const first = await ledger.submitOnce(input, fake.asSubmitCall());
    assert.equal(first.kind, 'submitted');
    assert.equal(bridge.invocationCount, 1, 'first submission calls provider');

    const second = await ledger.submitOnce(input, fake.asSubmitCall());
    assert.equal(second.kind, 'duplicate', 'second submission with same identity is logical duplicate');
    assert.equal(bridge.invocationCount, 1, 'logical duplicate must NOT call provider again');
    assert.equal(second.kind === 'duplicate' ? second.intent.clientOrderId : '', input.clientOrderId);

    // Snapshot: provider has exactly one simulated order
    assert.equal(bridge.snapshot().length, 1);
    assert.equal(bridge.getByClientOrderId(input.clientOrderId)?.clientOrderId, input.clientOrderId);
  });

  test('6. provider-level duplicate: provider reports duplicate, ledger still records outcome, no auto-retry', async () => {
    const userId = await makeUser();
    const profileId = await makeProfile(userId);
    const bridge = new FakeBridge({ kind: 'provider_duplicate' });
    const fake = new DeterministicFakeProvider(bridge);
    const input = submitInput({ userId, profileId });

    // First call: provider reports duplicate (even without prior state, our fake stores it as duplicate_reported)
    const first = await ledger.submitOnce(input, fake.asSubmitCall());
    assert.equal(first.kind, 'submitted');
    assert.equal(first.kind === 'submitted' ? first.result.providerCalled : false, true, 'provider was called');
    assert.equal(bridge.invocationCount, 1);

    // The provider reported duplicate, but ledger normalized it as accepted (since status is accepted in our fake)
    // This is provider-level duplicate, NOT logical duplicate
    if (first.kind === 'submitted') {
      assert.equal(first.result.outcome, 'accepted', 'provider duplicate reported as accepted is still accepted outcome');
    }

    // A new order with different identity but same provider order? That's not logical duplicate.
    // Provider-level duplicate does NOT cause automatic retry.
    const secondInput = submitInput({ userId, profileId });
    bridge.setScenario({ kind: 'accept' });
    const second = await ledger.submitOnce(secondInput, fake.asSubmitCall());
    assert.equal(second.kind, 'submitted');
    assert.equal(bridge.invocationCount, 2, 'second distinct order calls provider again');
    assert.equal(second.kind === 'submitted' ? second.result.outcome : '', 'accepted');

    // No automatic retry happened
    assert.equal(bridge.snapshot().length, 2, 'two distinct simulated provider orders');
  });

  test('provider duplicate vs logical duplicate: invocation tracking proves distinction', async () => {
    const userId = await makeUser();
    const profileId = await makeProfile(userId);
    const bridge = new FakeBridge((call) => (call === 0 ? { kind: 'accept' } : { kind: 'provider_duplicate' }));
    const fake = new DeterministicFakeProvider(bridge);

    const input1 = submitInput({ userId, profileId });
    const input2 = submitInput({ userId, profileId });

    // input1 accepted
    const r1 = await ledger.submitOnce(input1, fake.asSubmitCall());
    assert.equal(r1.kind, 'submitted');
    assert.equal(bridge.invocationCount, 1);

    // input1 again: logical duplicate, no provider call
    const r1Dup = await ledger.submitOnce(input1, fake.asSubmitCall());
    assert.equal(r1Dup.kind, 'duplicate');
    assert.equal(bridge.invocationCount, 1, 'logical duplicate does not increase invocation count');

    // input2 with provider_duplicate scenario: provider call happens, provider says duplicate
    const r2 = await ledger.submitOnce(input2, fake.asSubmitCall());
    assert.equal(r2.kind, 'submitted');
    assert.equal(bridge.invocationCount, 2, 'provider-level duplicate DOES call provider');
    assert.ok(bridge.getCalls()[1]?.scenario.kind === 'provider_duplicate');

    // Deterministic provider identity: same clientOrderId always maps to same providerOrderId
    const derived1 = bridge.deriveProviderOrderId(input1.clientOrderId);
    const derived2 = bridge.deriveProviderOrderId(input1.clientOrderId);
    assert.equal(derived1, derived2, 'deterministic provider identity');
  });
});

describe('MEDIUM-2 — stateful fake-provider test architecture', () => {
  test('provider-side simulated order state, deterministic scenario control, lookup, invocation tracking', async () => {
    const bridge = new FakeBridge({ kind: 'accept' }, { now: () => new Date('2026-09-20T00:00:00.000Z') });

    // Initially empty
    assert.equal(bridge.snapshot().length, 0);
    assert.equal(bridge.invocationCount, 0);

    // Submit via bridge directly
    const barrier = { intentId: randomUUID(), clientOrderId: newClientOrderId(), idempotencyKey: newIdempotencyKey(), accountRef: 'acct-1' };
    const response = await bridge.submit(barrier);
    assert.ok(response);
    assert.equal(bridge.snapshot().length, 1);
    assert.equal(bridge.invocationCount, 1);

    // Deterministic lookup
    assert.ok(bridge.getByClientOrderId(barrier.clientOrderId));
    assert.ok(bridge.getByIdempotencyKey(barrier.idempotencyKey));
    const byProvider = bridge.getByProviderOrderId(bridge.deriveProviderOrderId(barrier.clientOrderId));
    assert.ok(byProvider);
    assert.equal(byProvider?.clientOrderId, barrier.clientOrderId);

    // Deterministic provider identity
    const id1 = bridge.deriveProviderOrderId('ve-abc');
    const id2 = bridge.deriveProviderOrderId('ve-abc');
    assert.equal(id1, id2);

    // Scenario control
    bridge.setScenario({ kind: 'reject' });
    const barrier2 = { intentId: randomUUID(), clientOrderId: newClientOrderId(), idempotencyKey: newIdempotencyKey(), accountRef: 'acct-1' };
    const response2 = await bridge.submit(barrier2);
    assert.ok(response2);
    assert.equal((response2 as { status: string }).status, 'rejected');
    assert.equal(bridge.snapshot().length, 2);

    // Invocation tracking
    const calls = bridge.getCalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.clientOrderId, barrier.clientOrderId);
    assert.equal(calls[1]?.clientOrderId, barrier2.clientOrderId);
    assert.equal(calls[0]?.scenario.kind, 'accept');
    assert.equal(calls[1]?.scenario.kind, 'reject');

    // No network, no MT5 behavior: check that providerOrderId is deterministic fake, not MT5 ticket
    assert.ok(calls[0]?.providerOrderId.startsWith('fake-'));
  });

  test('test-only boundary: no production export, no provider registration', async () => {
    const { readFileSync } = await import('node:fs');
    const indexContent = readFileSync(path.join(REPO_ROOT, 'packages/core/src/execution/index.ts'), 'utf8');
    assert.equal(indexContent.includes('fake-bridge'), false, 'production index must not export fake-bridge');
    assert.equal(indexContent.includes('FakeBridge'), false, 'production index must not export FakeBridge');
    assert.equal(indexContent.includes('DeterministicFakeProvider'), false);
  });
});

describe('barrier reuse — M2', () => {
  test('7. barrier reuse: second consume of same barrier fails closed with barrier_not_consumable', async () => {
    const userId = await makeUser();
    const profileId = await makeProfile(userId);
    const bridge = new FakeBridge({ kind: 'accept' });
    const fake = new DeterministicFakeProvider(bridge);
    const input = submitInput({ userId, profileId });

    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    if (prepared.kind !== 'authorized') throw new Error('not authorized');
    const barrier = prepared.barrier;

    // First execution succeeds
    const first = await ledger.executeSubmit(barrier, fake.asSubmitCall());
    assert.equal(first.outcome, 'accepted');
    assert.equal(bridge.invocationCount, 1);

    // Reuse same barrier value — must fail closed, no provider call
    await assert.rejects(
      () => ledger.executeSubmit(barrier, fake.asSubmitCall()),
      (err: unknown) => {
        const e = err as { code?: string };
        return e.code === 'barrier_not_consumable';
      },
      'barrier reuse must fail closed',
    );
    assert.equal(bridge.invocationCount, 1, 'reused barrier must NOT call provider again');
  });
});

describe('Gate 9 persistence sanity (8)', () => {
  test('8. existing Gate 9 persistence behavior: submit only, no secret, durable', async () => {
    const userId = await makeUser();
    const profileId = await makeProfile(userId);
    const bridge = new FakeBridge({ kind: 'accept' });
    const fake = new DeterministicFakeProvider(bridge);
    const input = submitInput({ userId, profileId });

    const result = await ledger.submitOnce(input, fake.asSubmitCall());
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') throw new Error('not submitted');

    const { rows: intentRows } = await pool.query<{ mutation_kind: string; credential_ref: string }>(
      `SELECT mutation_kind, credential_ref FROM execution_provider_intents WHERE id = $1`,
      [result.result.intentId],
    );
    assert.equal(intentRows[0]?.mutation_kind, 'submit');
    assert.equal(intentRows[0]?.credential_ref, 'cred-ref-gate9');

    const { rows: receiptRows } = await pool.query<{ receipt: unknown }>(
      `SELECT receipt FROM execution_provider_receipts WHERE intent_id = $1`,
      [result.result.intentId],
    );
    assert.equal(receiptRows.length, 1);
    const receipt = receiptRows[0]?.receipt as Record<string, unknown>;
    assert.ok(receipt);
    // Receipt must not contain secret-shaped keys
    const receiptStr = JSON.stringify(receipt).toLowerCase();
    assert.equal(receiptStr.includes('password'), false);
    assert.equal(receiptStr.includes('secret'), false);
    assert.equal(receiptStr.includes('token'), false);
  });
});
