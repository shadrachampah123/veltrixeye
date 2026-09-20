/**
 * M10 Gate 9 Step 3b (M2) — durable single-use submit barrier consumption.
 *
 * `executeSubmit` must CONSUME the submit barrier in its own short, committed
 * transaction immediately before the provider call: a compare-and-swap against
 * the exact `barrier.stateVersion` while the durable intent is still
 * `status = 'submitting'` and every identity field matches the row. The
 * consuming write advances `state_version`, so a barrier value can authorize at
 * most one provider call.
 *
 * These tests are the focused M2 suite. They never merely assert final database
 * state: every scenario counts provider invocations explicitly, and every
 * reuse/forge/failure scenario proves the provider invocation count did not
 * change. The provider is an injected fake — no broker, network or credential.
 *
 *  M2-1  first execute with a valid barrier: consume CAS → provider → receipt/outcome
 *  M2-2  sequential reuse after a confirmed outcome
 *  M2-3  sequential reuse after an uncertain outcome
 *  M2-4  reuse after `state_commit_failed` (defeats a simple pre-call READ check)
 *  M2-5  reuse after restart recovery
 *  M2-6  reuse after operator resolution
 *  M2-7  concurrent execution of the same barrier
 *  M2-8  forged/stale stateVersion
 *  M2-9  zero-row CAS (unknown intent, wrong tenant)
 *  M2-10 database failure during consumption
 *  M2-11 the durable consume event is persisted exactly once
 *
 * Existing receipt/outcome/reconciliation behavior and the existing submit-only
 * and fail-closed guarantees remain covered by
 * `m10-gate9-mutation-persistence.test.ts`, which must keep passing unchanged.
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
import {
  ProviderMutationError,
  ProviderMutationLedger,
  type MutationExecutionResult,
  type ProviderSubmitCall,
  type SubmitBarrier,
  type SubmitIntentInput,
} from '../src/execution/provider-mutations.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5468;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_gate9_barrier';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let ledger: ProviderMutationLedger;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m10-gate9-barrier');
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

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const uniqueEmail = () => `gate9m2_${randomBytes(6).toString('hex')}@example.com`;

async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Gate 9 M2 Tester') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}

async function makeProfile(userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,'paper','paper','paper','gate9-m2-acct',true,'connected')`,
    [id, userId],
  );
  return id;
}

async function makeAccount(): Promise<{ userId: string; profileId: string }> {
  const userId = await makeUser();
  return { userId, profileId: await makeProfile(userId) };
}

const newClientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;
const newIdempotencyKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');

async function makeRiskDecision(userId: string, profileId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO risk_decisions
       (user_id, execution_profile_id, outcome, reason, entry_price, stop_loss_price, take_profit_price,
        policy_version, engine_version, current_exposure, projected_exposure)
     VALUES ($1,$2,'approved','gate9 m2 fixture',1.1,1.09,1.13,1,'gate9-m2-test','{}'::jsonb,'{}'::jsonb)
     RETURNING id`,
    [userId, profileId],
  );
  return rows[0]!.id;
}

function submitInput(args: { userId: string; profileId: string }): SubmitIntentInput {
  const clientOrderId = newClientOrderId();
  const idempotencyKey = newIdempotencyKey();
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
    accountRef: 'gate9-m2-acct',
    credentialRef: 'cred-ref-gate9-m2',
    credentialFingerprint: createHash('sha256').update('gate9-m2-binding').digest('hex'),
    riskDecisionId: null,
    riskReservationId: null,
    symbol: 'EURUSD',
    direction: 'long',
    monetaryRisk: '25',
    riskExpiresAt: null,
  };
}

async function authorizedBarrier(input: SubmitIntentInput, target: ProviderMutationLedger = ledger): Promise<SubmitBarrier> {
  const prepared = await target.prepareSubmit(input);
  assert.equal(prepared.kind, 'authorized');
  if (prepared.kind !== 'authorized') throw new Error('barrier was not authorized');
  return prepared.barrier;
}

/* -------------------------------------------------------------------------- */
/* Recording fake provider (test tool only — never a broker)                   */
/* -------------------------------------------------------------------------- */

type FakeScenario = { kind: 'accept' } | { kind: 'timeout' } | { kind: 'crash' };

function createFakeProvider(scenario: FakeScenario) {
  const calls: SubmitBarrier[] = [];
  const call: ProviderSubmitCall = async (barrier) => {
    calls.push(barrier);
    switch (scenario.kind) {
      case 'accept':
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: `sim-${createHash('sha256').update(barrier.clientOrderId).digest('hex').slice(0, 32)}`,
          status: 'accepted',
        };
      case 'timeout':
        throw new Error('simulated provider timeout');
      case 'crash':
        // Indistinguishable from a process dying mid-call: unknown outcome.
        throw new Error('process crashed during provider call');
    }
  };
  return { call, calls };
}

/* -------------------------------------------------------------------------- */
/* Durable-state readers                                                       */
/* -------------------------------------------------------------------------- */

async function intentRow(intentId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM execution_provider_intents WHERE id = $1`,
    [intentId],
  );
  assert.ok(rows[0], `intent ${intentId} must exist`);
  return rows[0]!;
}

async function eventsOf(intentId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM execution_provider_mutation_events WHERE intent_id = $1 ORDER BY id ASC`,
    [intentId],
  );
  return rows;
}

async function receiptsOf(intentId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM execution_provider_receipts WHERE intent_id = $1 ORDER BY created_at ASC`,
    [intentId],
  );
  return rows;
}

const barrierError = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await assert.rejects(
    () => promise,
    (error: unknown) => error instanceof ProviderMutationError && error.code === code,
    `expected a ${code} failure`,
  );
};

/* -------------------------------------------------------------------------- */
/* Fault injection: fail one durable write (test infrastructure only)          */
/* -------------------------------------------------------------------------- */

/** Fails the intent OUTCOME transition (`SET status = $3`) after the provider call. */
function withFailingOutcomeTransition(base: pg.Pool): pg.Pool {
  return withFailingClientQuery(base, /SET status = \$3/);
}

/** Fails the barrier-consumption UPDATE inside `consumeSubmitBarrier`. */
function withFailingConsumeWrite(base: pg.Pool): pg.Pool {
  return withFailingClientQuery(base, /UPDATE execution_provider_intents\s+SET updated_at/);
}

function withFailingClientQuery(base: pg.Pool, pattern: RegExp): pg.Pool {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(ct, cp) {
              if (cp === 'query') {
                return async (...args: unknown[]) => {
                  const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string } | undefined)?.text ?? '');
                  if (pattern.test(text)) throw new Error('injected persistence failure');
                  return (ct.query as (...a: unknown[]) => unknown)(...args);
                };
              }
              const value = Reflect.get(ct, cp, ct);
              return typeof value === 'function' ? value.bind(ct) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as pg.Pool;
}

/* -------------------------------------------------------------------------- */
/* M2 — durable single-use barrier consumption                                 */
/* -------------------------------------------------------------------------- */

describe('Gate 9 Step 3b (M2) — durable single-use submit barrier consumption', () => {
  test('M2-1. a valid barrier is consumed exactly once: consume CAS → provider call → receipt/outcome', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    const outcome = await ledger.executeSubmit(barrier, provider.call);

    // The provider was invoked exactly once, with the consumed barrier.
    assert.equal(provider.calls.length, 1);
    assert.equal(outcome.providerCalled, true);
    assert.equal(outcome.outcome, 'accepted');
    assert.equal(outcome.intentState, 'confirmed');
    assert.equal(outcome.reservationState, 'known_completed');
    assert.equal(outcome.persistenceFailure, null);

    // Durable state: confirmed with a verified receipt (receipt/outcome path intact).
    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'confirmed');
    assert.equal(intent.outcome, 'accepted');
    assert.equal((await receiptsOf(outcome.intentId)).length, 1);
    assert.equal(intent.state_version, barrier.stateVersion + 2, 'consume and outcome each advanced the version');

    // The durable event trail shows the full authorized sequence:
    // prepared → submitting → (barrier consumed) → confirmed.
    const events = await eventsOf(outcome.intentId);
    assert.equal(events.length, 4);
    assert.equal(events[0]!.from_state, null);
    assert.equal(events[0]!.to_state, 'prepared');
    assert.equal(events[1]!.from_state, 'prepared');
    assert.equal(events[1]!.to_state, 'submitting');
    assert.equal(events[2]!.from_state, 'submitting');
    assert.equal(events[2]!.to_state, 'submitting', 'barrier consumption is a submitting → submitting event');
    assert.equal(events[3]!.from_state, 'submitting');
    assert.equal(events[3]!.to_state, 'confirmed');

    // A second execution with the SAME barrier can never call the provider again.
    await barrierError(ledger.executeSubmit(barrier, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 1, 'the reused barrier never reached the provider');
    assert.equal((await eventsOf(outcome.intentId)).length, 4, 'a failed consume writes nothing');
    assert.equal((await receiptsOf(outcome.intentId)).length, 1);
  });

  test('M2-2. sequential reuse after a confirmed outcome cannot call the provider again', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    const first = await ledger.executeSubmit(barrier, provider.call);
    assert.equal(first.intentState, 'confirmed');
    assert.equal(provider.calls.length, 1);

    await barrierError(ledger.executeSubmit(barrier, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 1, 'no second provider mutation');

    const intent = await intentRow(barrier.intentId);
    assert.equal(intent.status, 'confirmed', 'a failed consume leaves durable state untouched');
    assert.equal(intent.state_version, barrier.stateVersion + 2);
  });

  test('M2-3. sequential reuse after an uncertain outcome cannot call the provider again', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'timeout' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    const first = await ledger.executeSubmit(barrier, provider.call);
    assert.equal(first.outcome, 'uncertain');
    assert.equal(first.intentState, 'uncertain');
    assert.equal(provider.calls.length, 1);

    await barrierError(ledger.executeSubmit(barrier, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 1, 'an uncertain mutation is never re-sent through a stale barrier');

    const intent = await intentRow(barrier.intentId);
    assert.equal(intent.status, 'uncertain');
    assert.equal(intent.reconciliation_required, true);
  });

  test('M2-4. reuse after a state_commit_failed cannot call the provider again (a pre-call READ check would pass here)', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });
    const barrier = await authorizedBarrier(input);

    // The provider accepts, but the local outcome transition cannot commit.
    const failing = new ProviderMutationLedger(withFailingOutcomeTransition(pool));
    const first = await failing.executeSubmit(barrier, provider.call);
    assert.equal(provider.calls.length, 1);
    assert.equal(first.persistenceFailure, 'state_commit_failed');

    // The intent is STILL `submitting` — a simple pre-call state READ would
    // therefore conclude "safe to send again". The durable version says
    // otherwise: the barrier was already consumed, so only the version CAS
    // (not a read) can authorize a provider call.
    const stuck = await intentRow(barrier.intentId);
    assert.equal(stuck.status, 'submitting', 'the intent remains in flight after the state commit failed');
    assert.equal(Number(stuck.state_version), barrier.stateVersion + 1, '…but its version moved past the barrier');

    await barrierError(ledger.executeSubmit(barrier, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 1, 'a second provider mutation is impossible after state_commit_failed');
  });

  test('M2-5. reuse after restart recovery cannot call the provider again', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });
    const barrier = await authorizedBarrier(input);

    // The process restarts before the barrier is consumed; recovery marks the
    // in-flight intent uncertain and permanently retires the minted barrier.
    const recovered = await ledger.recoverAfterRestart({ executionProfileId: profileId });
    assert.ok(recovered.some((r) => r.id === barrier.intentId));
    const afterRestart = await intentRow(barrier.intentId);
    assert.equal(afterRestart.status, 'uncertain');
    assert.equal(afterRestart.uncertainty_reason, 'process_restart');

    await barrierError(ledger.executeSubmit(barrier, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 0, 'a pre-restart barrier can never invoke the provider');
  });

  test('M2-6. reuse after operator resolution cannot call the provider again', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'timeout' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    const first = await ledger.executeSubmit(barrier, provider.call);
    assert.equal(first.intentState, 'uncertain');

    const resolved = await ledger.resolveByOperator({
      intentId: first.intentId,
      userId,
      executionProfileId: profileId,
      actor: 'operator:' + userId,
      resolvedBy: userId,
      resolution: 'provider_absent',
      evidence: 'operator_resolution',
      evidenceReference: 'm2-ops-ticket-1',
    });
    assert.equal(resolved.toStatus, 'reconciled');

    await barrierError(ledger.executeSubmit(barrier, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 1, 'an operator-resolved mutation is never re-sent through its old barrier');
  });

  test('M2-7. concurrent execution of the same barrier results in at most one provider call', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    const attempts: Array<Promise<MutationExecutionResult>> = [
      ledger.executeSubmit(barrier, provider.call),
      ledger.executeSubmit(barrier, provider.call),
      ledger.executeSubmit(barrier, provider.call),
    ];
    const settled = await Promise.allSettled(attempts);

    const fulfilled = settled.filter((s): s is PromiseFulfilledResult<MutationExecutionResult> => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one execution won the barrier CAS');
    assert.equal(rejected.length, 2);
    for (const rejection of rejected) {
      assert.ok(rejection.reason instanceof ProviderMutationError);
      assert.equal((rejection.reason as ProviderMutationError).code, 'barrier_not_consumable');
    }

    assert.equal(provider.calls.length, 1, 'the provider saw at most one mutation');
    const intent = await intentRow(barrier.intentId);
    assert.equal(intent.status, 'confirmed');

    const consumeEvents = (await eventsOf(barrier.intentId)).filter(
      (e) => e.to_state === 'submitting' && e.from_state === 'submitting',
    );
    assert.equal(consumeEvents.length, 1, 'the barrier was consumed exactly once, durably');
  });

  test('M2-8. a forged or stale stateVersion cannot call the provider', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    // A stale version (before the barrier was minted) and a forged future
    // version both match zero rows and fail closed.
    await barrierError(ledger.executeSubmit({ ...barrier, stateVersion: barrier.stateVersion - 1 }, provider.call), 'barrier_not_consumable');
    await barrierError(ledger.executeSubmit({ ...barrier, stateVersion: barrier.stateVersion + 99 }, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 0, 'no forged version reached the provider');

    // Failed consumption attempts must not consume or disturb durable state.
    const untouched = await intentRow(barrier.intentId);
    assert.equal(untouched.status, 'submitting');
    assert.equal(Number(untouched.state_version), barrier.stateVersion);
    assert.equal((await eventsOf(barrier.intentId)).length, 2, 'no consume event was written for a failed CAS');

    // The genuine barrier still works: a failed CAS is not a consumption.
    const outcome = await ledger.executeSubmit(barrier, provider.call);
    assert.equal(outcome.intentState, 'confirmed');
    assert.equal(provider.calls.length, 1);
  });

  test('M2-9. a zero-row CAS on an unknown intent or a wrong tenant cannot call the provider', async () => {
    const { userId, profileId } = await makeAccount();
    const other = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    // A fully forged barrier: no such durable intent exists.
    await barrierError(
      ledger.executeSubmit({ ...barrier, intentId: randomUUID() }, provider.call),
      'barrier_not_consumable',
    );

    // Tenant safety: an untrusted barrier object naming another user or another
    // execution profile matches zero rows even though the intent exists.
    await barrierError(ledger.executeSubmit({ ...barrier, userId: other.userId }, provider.call), 'barrier_not_consumable');
    await barrierError(ledger.executeSubmit({ ...barrier, executionProfileId: other.profileId }, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 0, 'no forged barrier reached the provider');
    assert.equal((await eventsOf(randomUUID())).length, 0);

    // The genuine, correctly-scoped barrier still authorizes exactly one call.
    const outcome = await ledger.executeSubmit(barrier, provider.call);
    assert.equal(outcome.intentState, 'confirmed');
    assert.equal(provider.calls.length, 1);
  });

  test('M2-10. a database failure during consumption fails closed as pre_call_persistence_failed', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    const failing = new ProviderMutationLedger(withFailingConsumeWrite(pool));
    await barrierError(failing.executeSubmit(barrier, provider.call), 'pre_call_persistence_failed');
    assert.equal(provider.calls.length, 0, 'a failed consume transaction never reaches the provider');

    // The consume transaction rolled back: durable state is exactly as before.
    const intent = await intentRow(barrier.intentId);
    assert.equal(intent.status, 'submitting');
    assert.equal(Number(intent.state_version), barrier.stateVersion);
    assert.equal((await eventsOf(barrier.intentId)).length, 2, 'no consume event was persisted');
    assert.equal((await receiptsOf(barrier.intentId)).length, 0);
  });

  test('M2-11. the durable consume event is persisted exactly once with audit detail and no secrets', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const barrier = await authorizedBarrier(submitInput({ userId, profileId }));

    await ledger.executeSubmit(barrier, provider.call);

    const events = await eventsOf(barrier.intentId);
    const consumeEvents = events.filter((e) => e.from_state === 'submitting' && e.to_state === 'submitting');
    assert.equal(consumeEvents.length, 1, 'exactly one submitting → submitting consumption event');

    const consumed = consumeEvents[0]!;
    assert.equal(consumed.intent_id, barrier.intentId);
    assert.equal(consumed.user_id, userId);
    assert.equal(consumed.execution_profile_id, profileId);
    assert.equal(consumed.client_order_id, barrier.clientOrderId);
    assert.equal(consumed.idempotency_key, barrier.idempotencyKey);
    assert.equal(consumed.attempt, 1);
    assert.equal(consumed.outcome, null, 'a consumption event claims no outcome');
    assert.equal(consumed.evidence, null);
    assert.equal(consumed.uncertainty_reason, null);
    assert.deepEqual(consumed.detail, {
      barrier: 'submit_barrier_consumed',
      consumedFromStateVersion: barrier.stateVersion,
    });

    const detailText = JSON.stringify(consumed.detail).toLowerCase();
    for (const forbidden of ['password', 'token', 'secret', 'apikey', 'api_key', 'authorization', 'privatekey', 'credential']) {
      assert.ok(!detailText.includes(forbidden), `consume event detail must never carry "${forbidden}"`);
    }
  });

  test('M2-12. a retry barrier is also single-use: reuse after the retry confirmed cannot call the provider', async () => {
    const { userId, profileId } = await makeAccount();
    const originalProvider = createFakeProvider({ kind: 'timeout' });
    const retryProvider = createFakeProvider({ kind: 'accept' });
    const first = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      originalProvider.call,
    );
    assert.equal(first.intentState, 'uncertain');
    assert.equal(originalProvider.calls.length, 1);

    // Resolve the uncertain original, then take a properly authorized retry.
    await ledger.recordReconciliationObservation({
      intentId: first.intentId,
      userId,
      executionProfileId: profileId,
      outcome: 'matched',
      providerStatus: 'rejected',
      statusUncertain: false,
    });
    const retryRiskDecisionId = await makeRiskDecision(userId, profileId);
    const retry = await ledger.prepareRetry({
      ...submitInput({ userId, profileId }),
      parentIntentId: first.intentId,
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      riskDecisionId: retryRiskDecisionId,
      authorizationId: `auth-${randomUUID()}`,
    });
    assert.equal(retry.kind, 'authorized');
    const retryBarrier = retry.kind === 'authorized' ? retry.barrier : null;
    assert.ok(retryBarrier);

    const second = await ledger.executeSubmit(retryBarrier, retryProvider.call);
    assert.equal(second.intentState, 'confirmed');
    assert.equal(retryProvider.calls.length, 1, 'exactly one call for the retry');

    // The retry barrier is single-use too.
    await barrierError(ledger.executeSubmit(retryBarrier, retryProvider.call), 'barrier_not_consumable');
    assert.equal(retryProvider.calls.length, 1, 'the consumed retry barrier cannot authorize another call');
    assert.equal((await eventsOf(retryBarrier.intentId)).length, 4, 'retry event trail: prepared, submitting, consumed, confirmed');
  });
});
