/**
 * Gate 9 — deterministic Fake Bridge integration suite.
 *
 * The provider mutation ledger is the system under test. FakeBridge is only an
 * injected, in-memory ProviderSubmitCall implementation with provider-side
 * state and deterministic reconciliation observations. No fake method writes a
 * VeltrixEye table, and no scenario retries, repairs, cancels, or resubmits.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations } from '../src/index.js';
import {
  ProviderMutationError,
  ProviderMutationLedger,
  type SubmitBarrier,
  type SubmitIntentInput,
} from '../src/execution/provider-mutations.js';
import { FakeBridge, DeterministicFakeProvider, type FakeBridgeScenario } from './support/fake-bridge.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5471;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_gate9_fake_bridge';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let ledger: ProviderMutationLedger;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m10-gate9-fake-bridge');
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
  ledger = new ProviderMutationLedger(pool);
}, { timeout: 240_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

const uniqueEmail = () => `gate9_fake_bridge_${randomBytes(6).toString('hex')}@example.com`;
const newClientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;
const newIdempotencyKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');

async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Gate 9 Fake Bridge') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}

async function makeProfile(userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,'paper','paper','paper','fake-acct',true,'connected')`,
    [id, userId],
  );
  return id;
}

async function makeRiskDecision(userId: string, profileId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO risk_decisions
       (user_id, execution_profile_id, outcome, reason, entry_price, stop_loss_price, take_profit_price,
        policy_version, engine_version, current_exposure, projected_exposure)
     VALUES ($1,$2,'approved','fake bridge fixture',1.1,1.09,1.13,1,'gate9-fake-bridge','{}'::jsonb,'{}'::jsonb)
     RETURNING id`,
    [userId, profileId],
  );
  return rows[0]!.id;
}

function submitInput(args: {
  userId: string;
  profileId: string;
  clientOrderId?: string;
  idempotencyKey?: string;
  riskDecisionId?: string | null;
}): SubmitIntentInput {
  const clientOrderId = args.clientOrderId ?? newClientOrderId();
  const idempotencyKey = args.idempotencyKey ?? newIdempotencyKey();
  return {
    userId: args.userId,
    executionProfileId: args.profileId,
    clientOrderId,
    idempotencyKey,
    canonicalRequest: {
      clientOrderId,
      idempotencyKey,
      symbol: 'EURUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
    },
    providerSlug: 'paper',
    environment: 'paper',
    accountRef: 'fake-acct',
    credentialRef: 'fake-credential-reference',
    credentialFingerprint: createHash('sha256').update('fake-binding').digest('hex'),
    riskDecisionId: args.riskDecisionId ?? null,
    riskReservationId: null,
    symbol: 'EURUSD',
    direction: 'long',
    monetaryRisk: '25',
    riskExpiresAt: null,
  };
}

async function makeAccount(): Promise<{ userId: string; profileId: string }> {
  const userId = await makeUser();
  return { userId, profileId: await makeProfile(userId) };
}

async function prepare(input: SubmitIntentInput): Promise<SubmitBarrier> {
  const result = await ledger.prepareSubmit(input);
  assert.equal(result.kind, 'authorized');
  if (result.kind !== 'authorized') throw new Error('expected an authorized barrier');
  return result.barrier;
}

async function intentRow(intentId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM execution_provider_intents WHERE id = $1',
    [intentId],
  );
  assert.ok(rows[0]);
  return rows[0]!;
}

async function receiptRows(intentId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM execution_provider_receipts WHERE intent_id = $1 ORDER BY created_at ASC',
    [intentId],
  );
  return rows;
}

function assertBarrierError(error: unknown, code: string): boolean {
  return error instanceof ProviderMutationError && error.code === code;
}

describe('DeterministicFakeProvider -> ProviderMutationLedger scenario taxonomy', () => {
  test('accepted creates provider-side state, normalizes to accepted, and is discoverable for reconciliation', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'accepted' });
    const provider = new DeterministicFakeProvider(bridge);
    const input = submitInput({ userId, profileId });

    const result = await ledger.submitOnce(input, provider.asSubmitCall());
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') throw new Error('expected submitted result');
    assert.equal(result.result.outcome, 'accepted');
    assert.equal(result.result.intentState, 'confirmed');
    assert.equal(result.result.providerCalled, true);
    assert.equal(bridge.invocationCount, 1);

    const state = bridge.getByClientOrderId(input.clientOrderId);
    assert.ok(state);
    assert.equal(state.status, 'accepted');
    assert.equal(state.providerOrderId, bridge.deriveProviderOrderId(input.clientOrderId));
    assert.equal(state.idempotencyKey, input.idempotencyKey);

    const lookup = bridge.lookupByClientOrderId(input.clientOrderId);
    assert.equal(lookup.outcome, 'matched');
    assert.equal(lookup.providerStatus, 'accepted');
    assert.equal(lookup.statusUncertain, false);
    assert.equal(lookup.providerOrderId, state.providerOrderId);

    const snapshot = bridge.getSnapshot({ providerId: 'paper', accountRef: 'fake-acct' });
    assert.equal(snapshot.providerUnavailable, false);
    assert.equal(snapshot.orders.length, 1);
    assert.equal(snapshot.orders[0]?.providerOrderId, state.providerOrderId);
    assert.equal(snapshot.orders[0]?.status, 'accepted');

    // The fake owns no VeltrixEye mutation persistence. Only the ledger result
    // has a durable intent/receipt for this invocation.
    const durable = await intentRow(result.result.intentId);
    assert.equal(durable.status, 'confirmed');
    assert.equal(durable.mutation_kind, 'submit');
  });

  test('rejected returns provider rejection semantics and never creates an accepted provider order', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'rejected' });
    const input = submitInput({ userId, profileId });

    const result = await ledger.submitOnce(input, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') throw new Error('expected submitted result');
    assert.equal(result.result.outcome, 'rejected');
    assert.equal(result.result.intentState, 'rejected');
    assert.equal(result.result.requiresReconciliation, false);
    assert.equal(bridge.invocationCount, 1);

    const state = bridge.getByClientOrderId(input.clientOrderId);
    assert.ok(state);
    assert.equal(state.status, 'rejected');
    assert.equal(bridge.snapshot().some((row) => row.status === 'accepted'), false);
    assert.equal(bridge.lookupByClientOrderId(input.clientOrderId).providerStatus, 'rejected');
  });

  const uncertainScenarios: Array<{ name: string; scenario: FakeBridgeScenario; reason: string }> = [
    { name: 'timeout', scenario: { kind: 'timeout' }, reason: 'timeout' },
    { name: 'connection failure', scenario: { kind: 'connection_failure' }, reason: 'connection_failure' },
    { name: 'lost response', scenario: { kind: 'lost_response' }, reason: 'lost_response' },
    { name: 'malformed response', scenario: { kind: 'malformed_response' }, reason: 'malformed_response' },
    { name: 'unknown provider status', scenario: { kind: 'unknown_provider_status' }, reason: 'unknown_provider_status' },
    { name: 'identity verification failure', scenario: { kind: 'identity_verification_failed' }, reason: 'identity_verification_failed' },
  ];

  for (const testCase of uncertainScenarios) {
    test(`${testCase.name} remains uncertain and is never automatically retried`, async () => {
      const { userId, profileId } = await makeAccount();
      const bridge = new FakeBridge(testCase.scenario);
      const input = submitInput({ userId, profileId });

      const result = await ledger.submitOnce(input, new DeterministicFakeProvider(bridge).asSubmitCall());
      assert.equal(result.kind, 'submitted');
      if (result.kind !== 'submitted') throw new Error('expected submitted result');
      assert.equal(result.result.outcome, 'uncertain');
      assert.equal(result.result.uncertaintyReason, testCase.reason);
      assert.equal(result.result.intentState, 'uncertain');
      assert.equal(result.result.requiresReconciliation, true);
      assert.equal(bridge.invocationCount, 1, 'there is no automatic retry');

      const durable = await intentRow(result.result.intentId);
      assert.equal(durable.status, 'uncertain');
      assert.equal(durable.outcome, 'uncertain');
      assert.equal(durable.reconciliation_required, true);
      assert.equal(durable.terminal_evidence, null);
    });
  }

  test('accepted_then_timeout retains provider acceptance while the ledger remains uncertain', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'accepted_then_timeout' });
    const input = submitInput({ userId, profileId });

    const result = await ledger.submitOnce(input, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') throw new Error('expected submitted result');
    assert.equal(result.result.outcome, 'uncertain');
    assert.equal(result.result.uncertaintyReason, 'timeout');
    assert.equal(result.result.intentState, 'uncertain');
    assert.equal(bridge.invocationCount, 1);

    const state = bridge.getByClientOrderId(input.clientOrderId);
    assert.ok(state);
    assert.equal(state.status, 'accepted');
    const lookup = bridge.lookupByClientOrderId(input.clientOrderId);
    assert.equal(lookup.outcome, 'matched');
    assert.equal(lookup.providerStatus, 'accepted');
    assert.equal(lookup.providerOrderId, state.providerOrderId);
  });
});

describe('Fake Bridge barrier and duplicate boundaries', () => {
  test('invalid, forged, stale, and reused barriers fail before fake invocation', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'accepted' });
    const provider = new DeterministicFakeProvider(bridge);
    const barrier = await prepare(submitInput({ userId, profileId }));

    await assert.rejects(
      () => bridge.submit({ ...barrier, providerCallPermitted: false } as unknown as SubmitBarrier),
      (error: unknown) => assertBarrierError(error, 'barrier_not_consumable'),
    );
    assert.equal(bridge.invocationCount, 0, 'invalid barrier never reaches provider state');

    await assert.rejects(
      () => ledger.executeSubmit({ ...barrier, stateVersion: barrier.stateVersion + 1 }, provider.asSubmitCall()),
      (error: unknown) => assertBarrierError(error, 'barrier_not_consumable'),
    );
    await assert.rejects(
      () => ledger.executeSubmit({ ...barrier, intentId: randomUUID() }, provider.asSubmitCall()),
      (error: unknown) => assertBarrierError(error, 'barrier_not_consumable'),
    );
    assert.equal(bridge.invocationCount, 0, 'stale and forged barriers are rejected by the ledger CAS');

    const first = await ledger.executeSubmit(barrier, provider.asSubmitCall());
    assert.equal(first.outcome, 'accepted');
    assert.equal(bridge.invocationCount, 1);
    await assert.rejects(
      () => ledger.executeSubmit(barrier, provider.asSubmitCall()),
      (error: unknown) => assertBarrierError(error, 'barrier_not_consumable'),
    );
    assert.equal(bridge.invocationCount, 1, 'reused barrier cannot invoke the fake');
  });

  test('logical duplicate is ledger-level; provider-side duplicate reuses one fake order', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'accepted' });
    const provider = new DeterministicFakeProvider(bridge);
    const input = submitInput({ userId, profileId });

    const first = await ledger.submitOnce(input, provider.asSubmitCall());
    assert.equal(first.kind, 'submitted');
    assert.equal(bridge.invocationCount, 1);
    const logicalDuplicate = await ledger.submitOnce(input, provider.asSubmitCall());
    assert.equal(logicalDuplicate.kind, 'duplicate');
    assert.equal(bridge.invocationCount, 1, 'logical duplicate does not invoke the fake');

    // Simulate an already-existing provider order receiving a duplicate provider
    // invocation. This is deliberately below the ledger boundary: the test is
    // checking provider duplicate behavior, not authorizing a second ledger
    // mutation.
    bridge.setScenario({ kind: 'provider_duplicate' });
    const originalBarrier = await prepare(submitInput({ userId, profileId }));
    // The second prepare above has a new identity and is not used to call the
    // ledger; the existing provider identity is selected explicitly below.
    const duplicateBarrier: SubmitBarrier = {
      ...originalBarrier,
      intentId: randomUUID(),
      clientOrderId: input.clientOrderId,
      idempotencyKey: input.idempotencyKey,
      requestHash: newIdempotencyKey(),
      stateVersion: originalBarrier.stateVersion + 1,
    };
    await bridge.submit(duplicateBarrier);
    assert.equal(bridge.invocationCount, 2, 'provider duplicate is a provider invocation');
    assert.equal(bridge.snapshot().length, 1, 'provider duplicate cannot create a second provider order');
    assert.equal(bridge.getByClientOrderId(input.clientOrderId)?.providerOrderId, bridge.deriveProviderOrderId(input.clientOrderId));
  });

  test('concurrent logical submissions authorize exactly one fake invocation and one provider order', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'accepted' });
    const provider = new DeterministicFakeProvider(bridge);
    const input = submitInput({ userId, profileId });

    const results = await Promise.all([
      ledger.submitOnce(input, provider.asSubmitCall()),
      ledger.submitOnce(input, provider.asSubmitCall()),
      ledger.submitOnce(input, provider.asSubmitCall()),
      ledger.submitOnce(input, provider.asSubmitCall()),
    ]);
    assert.equal(results.filter((result) => result.kind === 'submitted').length, 1);
    assert.equal(results.filter((result) => result.kind === 'duplicate').length, 3);
    assert.equal(bridge.invocationCount, 1);
    assert.equal(bridge.snapshot().length, 1);
  });
});

describe('Fake Bridge reconciliation and retry lineage', () => {
  test('accepted then timeout -> lookup matched/provider_accepted, with no resubmission', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'accepted_then_timeout' });
    const input = submitInput({ userId, profileId });
    const first = await ledger.submitOnce(input, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(first.kind, 'submitted');
    if (first.kind !== 'submitted') throw new Error('expected submitted result');

    const lookup = bridge.lookupByClientOrderId(input.clientOrderId);
    assert.equal(lookup.outcome, 'matched');
    const observation = await ledger.recordReconciliationObservation({
      intentId: first.result.intentId,
      userId,
      executionProfileId: profileId,
      outcome: lookup.outcome,
      providerStatus: lookup.providerStatus,
      statusUncertain: lookup.statusUncertain,
      providerOrderId: lookup.providerOrderId,
    });
    assert.equal(observation.applied, true);
    assert.equal(observation.resolution, 'provider_accepted');
    assert.equal(observation.outcome, 'accepted');
    assert.equal(observation.intentState, 'reconciled');
    assert.equal(bridge.invocationCount, 1, 'reconciliation never resubmits');
  });

  test('missing provider order is not_found and stays unresolved, never an automatic rejection', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'timeout' });
    const input = submitInput({ userId, profileId });
    const first = await ledger.submitOnce(input, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(first.kind, 'submitted');
    if (first.kind !== 'submitted') throw new Error('expected submitted result');

    const lookup = bridge.lookupByClientOrderId(input.clientOrderId);
    assert.equal(lookup.outcome, 'not_found');
    assert.equal(lookup.providerStatus, null);
    const observation = await ledger.recordReconciliationObservation({
      intentId: first.result.intentId,
      userId,
      executionProfileId: profileId,
      outcome: lookup.outcome,
      providerStatus: lookup.providerStatus,
      statusUncertain: lookup.statusUncertain,
    });
    assert.equal(observation.applied, false);
    assert.equal(observation.requiresOperatorResolution, true);
    const durable = await intentRow(first.result.intentId);
    assert.equal(durable.status, 'uncertain');
    assert.equal(durable.outcome, 'uncertain');
    assert.equal(bridge.invocationCount, 1);
  });

  test('malformed provider state remains uncertain in lookup and normalized snapshot', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'accepted_then_timeout' });
    const input = submitInput({ userId, profileId });
    const first = await ledger.submitOnce(input, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(first.kind, 'submitted');
    if (first.kind !== 'submitted') throw new Error('expected submitted result');

    bridge.setReconciliationScenario('malformed_response');
    const lookup = bridge.lookupByClientOrderId(input.clientOrderId);
    assert.equal(lookup.outcome, 'uncertain');
    assert.equal(lookup.status, 'uncertain');
    assert.equal(lookup.statusUncertain, true);
    const snapshot = await bridge.asReconciliationSnapshotProvider().getSnapshot({
      userId,
      executionProfileId: profileId,
      providerId: 'paper',
    });
    assert.equal(snapshot.orders[0]?.status, 'uncertain');
    assert.equal(snapshot.orders[0]?.statusUncertain, true);

    const observation = await ledger.recordReconciliationObservation({
      intentId: first.result.intentId,
      userId,
      executionProfileId: profileId,
      outcome: lookup.outcome,
      providerStatus: lookup.providerStatus,
      statusUncertain: lookup.statusUncertain,
      providerOrderId: lookup.providerOrderId,
    });
    assert.equal(observation.applied, false);
    assert.equal(observation.requiresOperatorResolution, true);
    assert.equal((await intentRow(first.result.intentId)).status, 'uncertain');
  });

  test('explicit retry has new identity, request hash, attempt, and no automatic retry', async () => {
    const { userId, profileId } = await makeAccount();
    const firstRiskDecision = await makeRiskDecision(userId, profileId);
    const bridge = new FakeBridge({ kind: 'timeout' });
    const firstInput = submitInput({ userId, profileId, riskDecisionId: firstRiskDecision });
    const first = await ledger.submitOnce(firstInput, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(first.kind, 'submitted');
    if (first.kind !== 'submitted') throw new Error('expected submitted result');
    assert.equal(bridge.invocationCount, 1, 'no automatic retry happened');

    await ledger.resolveByOperator({
      intentId: first.result.intentId,
      userId,
      executionProfileId: profileId,
      actor: `operator:${userId}`,
      resolvedBy: userId,
      resolution: 'provider_absent',
      evidence: 'operator_resolution',
      evidenceReference: 'fake-bridge-operator-ticket',
    });

    const retryRiskDecision = await makeRiskDecision(userId, profileId);
    const retryClientOrderId = `ve-${first.result.clientOrderId.slice(3, 23)}-r1`;
    const retry = await ledger.prepareRetry({
      ...submitInput({ userId, profileId, riskDecisionId: retryRiskDecision, clientOrderId: retryClientOrderId }),
      parentIntentId: first.result.intentId,
      clientOrderId: retryClientOrderId,
      idempotencyKey: newIdempotencyKey(),
      riskDecisionId: retryRiskDecision,
      authorizationId: `fake-bridge-auth-${randomUUID()}`,
    });
    assert.equal(retry.kind, 'authorized');
    if (retry.kind !== 'authorized') throw new Error('expected retry barrier');
    assert.equal(retry.barrier.attempt, 2);
    assert.notEqual(retry.barrier.clientOrderId, first.result.clientOrderId);
    assert.notEqual(retry.barrier.idempotencyKey, first.result.idempotencyKey);
    const originalRequestHash = (await intentRow(first.result.intentId)).request_hash;
    assert.notEqual(retry.barrier.requestHash, originalRequestHash);

    bridge.setScenario({ kind: 'accepted' });
    const second = await ledger.executeSubmit(retry.barrier, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(second.outcome, 'accepted');
    assert.equal(bridge.invocationCount, 2, 'only the explicitly authorized retry invoked the fake');

    const parent = await intentRow(first.result.intentId);
    const child = await intentRow(retry.barrier.intentId);
    assert.equal(child.attempt, 2);
    assert.equal(child.parent_intent_id, first.result.intentId);
    assert.equal(child.root_intent_id, first.result.intentId);
    assert.equal(parent.superseded_by_intent_id, retry.barrier.intentId);
  });
});

describe('Fake Bridge redaction and production isolation', () => {
  test('malformed and credential-shaped responses cannot produce an unsafe receipt', async () => {
    const { userId, profileId } = await makeAccount();
    const bridge = new FakeBridge({ kind: 'credential_leak' });
    const input = submitInput({ userId, profileId });
    const result = await ledger.submitOnce(input, new DeterministicFakeProvider(bridge).asSubmitCall());
    assert.equal(result.kind, 'submitted');
    if (result.kind !== 'submitted') throw new Error('expected submitted result');
    assert.equal(result.result.outcome, 'uncertain');
    assert.equal(result.result.uncertaintyReason, 'malformed_response');

    const rows = await receiptRows(result.result.intentId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.receipt, {});
    const persisted = JSON.stringify(rows[0]);
    for (const forbidden of ['provider-secret-token', 'password', 'token', 'authorization', 'private_key']) {
      assert.equal(persisted.toLowerCase().includes(forbidden), false, `persisted receipt contains ${forbidden}`);
    }
  });

  test('the fake remains test-only and has no database/network/production wiring', () => {
    const fakeSource = readFileSync(path.join(REPO_ROOT, 'packages/core/test/support/fake-bridge.ts'), 'utf8');
    assert.equal(/\b(pg|Pool|fetch|http|https|net|tls|socket|child_process|spawn|exec)\b/i.test(fakeSource), false);
    assert.equal(fakeSource.includes('INSERT INTO'), false);
    assert.equal(fakeSource.includes('UPDATE '), false);

    const productionIndex = readFileSync(path.join(REPO_ROOT, 'packages/core/src/execution/index.ts'), 'utf8');
    assert.equal(productionIndex.includes('fake-bridge'), false);
    assert.equal(productionIndex.includes('FakeBridge'), false);

    const app = readFileSync(path.join(REPO_ROOT, 'apps/api/src/app.ts'), 'utf8');
    assert.equal(app.includes('FakeBridge'), false);
    assert.equal(app.includes('DeterministicFakeProvider'), false);
  });
});
