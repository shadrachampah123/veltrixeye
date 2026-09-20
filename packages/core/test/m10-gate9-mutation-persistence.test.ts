/**
 * M10 Gate 9 — durable provider mutation persistence (fake-provider suite).
 *
 * Covers the Gate 9 persistence contract (§2–§17) against a real embedded
 * PostgreSQL with a deterministic FAKE provider. Every assertion reads durable
 * database state — never in-memory bookkeeping — and no broker, network or
 * credential is involved: the provider is an injected function.
 *
 * Required scenarios (§13):
 *   1  successful provider acceptance
 *   2  duplicate/idempotent submission
 *   3  verified provider rejection
 *   4  timeout
 *   5  lost response
 *   6  malformed response
 *   7  unknown provider status
 *   8  process crash before provider call
 *   9  process crash during/after provider call
 *  10  restart and recovery
 *  11  receipt-persistence failure
 *  12  concurrent duplicate submissions
 *  13  reconciliation after uncertainty
 *  14  retry after properly resolved uncertainty
 *  15  attempted retry while uncertainty remains
 *  16  stale reconciliation result against a newer retry
 *  17  risk-reservation expiry while provider outcome remains uncertain
 *
 * Plus the boundary tests that make the above meaningful: fail-closed
 * pre-call persistence, no-secret persistence, terminal-state immutability,
 * retention of unresolved evidence, and verified absence ≠ rejection.
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
import { ExecutionTransportError } from '../src/index.js';
import {
  ProviderMutationError,
  ProviderMutationLedger,
  type ProviderIntentRecord,
  type ProviderSubmitCall,
  type SubmitBarrier,
  type SubmitIntentInput,
} from '../src/execution/provider-mutations.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5465;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_gate9_persistence';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let ledger: ProviderMutationLedger;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m10-gate9-persistence');
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

const uniqueEmail = () => `gate9_${randomBytes(6).toString('hex')}@example.com`;

async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Gate 9 Tester') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}

async function makeProfile(userId: string, provider = 'paper'): Promise<string> {
  const id = randomUUID();
  const mode = provider === 'mt5' ? 'demo' : 'paper';
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,$3,$3,$4,'gate9-acct',true,$5)`,
    [id, userId, mode, provider, mode === 'demo' ? 'unavailable' : 'connected'],
  );
  return id;
}

async function makeRiskDecision(userId: string, profileId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO risk_decisions
       (user_id, execution_profile_id, outcome, reason, entry_price, stop_loss_price, take_profit_price,
        policy_version, engine_version, current_exposure, projected_exposure)
     VALUES ($1,$2,'approved','gate9 fixture',1.1,1.09,1.13,1,'gate9-test','{}'::jsonb,'{}'::jsonb)
     RETURNING id`,
    [userId, profileId],
  );
  return rows[0]!.id;
}

async function makeRiskReservation(args: {
  userId: string;
  profileId: string;
  riskDecisionId: string;
  monetaryRisk: string;
  expiresAt: Date;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO risk_reservations
       (user_id, execution_profile_id, risk_decision_id, symbol, direction, monetary_risk, expires_at)
     VALUES ($1,$2,$3,'EURUSD','long',$4,$5)
     RETURNING id`,
    [args.userId, args.profileId, args.riskDecisionId, args.monetaryRisk, args.expiresAt],
  );
  return rows[0]!.id;
}

const newClientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;
const newIdempotencyKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');

async function makeAccount(provider = 'paper'): Promise<{ userId: string; profileId: string }> {
  const userId = await makeUser();
  return { userId, profileId: await makeProfile(userId, provider) };
}

function submitInput(args: {
  userId: string;
  profileId: string;
  clientOrderId?: string;
  idempotencyKey?: string;
  riskDecisionId?: string | null;
  riskReservationId?: string | null;
  monetaryRisk?: string;
  riskExpiresAt?: Date | null;
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
    accountRef: 'gate9-acct',
    credentialRef: 'cred-ref-gate9',
    credentialFingerprint: createHash('sha256').update('gate9-binding').digest('hex'),
    riskDecisionId: args.riskDecisionId ?? null,
    riskReservationId: args.riskReservationId ?? null,
    symbol: 'EURUSD',
    direction: 'long',
    monetaryRisk: args.monetaryRisk ?? '25',
    riskExpiresAt: args.riskExpiresAt ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Fake provider (test tool only — never a broker)                             */
/* -------------------------------------------------------------------------- */

type FakeScenario =
  | { kind: 'accept'; status?: string }
  | { kind: 'reject'; status?: string }
  | { kind: 'timeout' }
  | { kind: 'transport_failure' }
  | { kind: 'crash' }
  | { kind: 'lost' }
  | { kind: 'malformed' }
  | { kind: 'unknown_status' }
  | { kind: 'credential_leak' }
  | { kind: 'identity_mismatch' };

interface FakeCall {
  barrier: SubmitBarrier;
  scenario: FakeScenario | undefined;
  response: unknown;
}

function createFakeProvider(scenario: FakeScenario | ((call: number) => FakeScenario)) {
  const calls: FakeCall[] = [];
  const call: ProviderSubmitCall = async (barrier) => {
    const resolved = typeof scenario === 'function' ? scenario(calls.length) : scenario;
    const providerOrderId = `sim-${createHash('sha256').update(barrier.clientOrderId).digest('hex').slice(0, 32)}`;
    const responseOf = (): unknown => {
      switch (resolved.kind) {
        case 'accept':
          return {
            clientOrderId: barrier.clientOrderId,
            idempotencyKey: barrier.idempotencyKey,
            accountRef: barrier.accountRef,
            providerOrderId,
            status: resolved.status ?? 'accepted',
          };
        case 'reject':
          return {
            clientOrderId: barrier.clientOrderId,
            idempotencyKey: barrier.idempotencyKey,
            accountRef: barrier.accountRef,
            providerOrderId: null,
            status: resolved.status ?? 'rejected',
          };
        case 'credential_leak':
          // A provider response carrying a credential-shaped key: the receipt
          // must be rejected (never redacted), so the mutation stays uncertain.
          return {
            clientOrderId: barrier.clientOrderId,
            idempotencyKey: barrier.idempotencyKey,
            accountRef: barrier.accountRef,
            providerOrderId,
            status: 'accepted',
            receipt: { providerOrderId, token: 'provider-secret-token' },
          };
        case 'identity_mismatch':
          return { clientOrderId: 've-000000000000000000000000', providerOrderId, status: 'accepted' };
        case 'unknown_status':
          return { clientOrderId: barrier.clientOrderId, providerOrderId, status: 'TOTALLY_UNKNOWN' };
        case 'malformed':
          return { unexpected: true };
        case 'lost':
          return null;
        case 'timeout':
          throw new ExecutionTransportError('timeout');
        case 'transport_failure':
          throw new ExecutionTransportError('transport_failure');
        case 'crash':
          // Indistinguishable from a process dying mid-call: unknown outcome.
          throw new Error('process crashed during provider call');
      }
    };
    let response: unknown;
    try {
      response = responseOf();
    } catch (error) {
      calls.push({ barrier, scenario: resolved, response: null });
      throw error;
    }
    calls.push({ barrier, scenario: resolved, response });
    return response;
  };
  return { call, calls };
}

/* -------------------------------------------------------------------------- */
/* Durable-state readers                                                       */
/* -------------------------------------------------------------------------- */

async function intentRow(intentId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM execution_provider_intents WHERE id = $1`,
    [intentId],
  );
  assert.ok(rows[0], `intent ${intentId} must exist`);
  return rows[0]!;
}

async function reservationRow(intentId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM execution_provider_mutation_reservations WHERE intent_id = $1`,
    [intentId],
  );
  assert.ok(rows[0], `mutation reservation for ${intentId} must exist`);
  return rows[0]!;
}

async function receipts(intentId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM execution_provider_receipts WHERE intent_id = $1 ORDER BY created_at ASC`,
    [intentId],
  );
  return rows;
}

async function events(intentId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM execution_provider_mutation_events WHERE intent_id = $1 ORDER BY id ASC`,
    [intentId],
  );
  return rows;
}

async function countIntents(profileId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM execution_provider_intents WHERE execution_profile_id = $1`,
    [profileId],
  );
  return Number(rows[0]!.n);
}

/* -------------------------------------------------------------------------- */
/* Fault injection: a persistence write that fails (no production fault code)  */
/* -------------------------------------------------------------------------- */

function withFailingReceiptWrite(base: pg.Pool): pg.Pool {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'query') {
        return async (...args: unknown[]) => {
          const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string } | undefined)?.text ?? '');
          if (/INSERT INTO execution_provider_receipts/i.test(text)) throw new Error('injected receipt persistence failure');
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as pg.Pool;
}

function withFailingBarrierWrite(base: pg.Pool, pattern: RegExp): pg.Pool {
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
                  if (pattern.test(text)) throw new Error('injected pre-call persistence failure');
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
/* 1 — successful provider acceptance                                          */
/* -------------------------------------------------------------------------- */

describe('Gate 9 §13 — durable provider mutation persistence (fake provider)', () => {
  test('1. successful provider acceptance is durably confirmed with verified evidence', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });

    const outcome = await ledger.executeSubmit(
      await authorizedBarrier(input),
      provider.call,
    );

    assert.equal(outcome.outcome, 'accepted');
    assert.equal(outcome.intentState, 'confirmed');
    assert.equal(outcome.reservationState, 'known_completed');
    assert.equal(outcome.requiresReconciliation, false);
    assert.equal(outcome.evidence, 'provider_response_verified');
    assert.ok(outcome.providerOrderId?.startsWith('sim-'));

    // Durable state, not in-memory bookkeeping.
    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'confirmed');
    assert.equal(intent.outcome, 'accepted');
    assert.equal(intent.terminal_evidence, 'provider_response_verified');
    assert.equal(intent.reconciliation_required, false);
    assert.equal(intent.reconciliation_state, 'not_required');
    assert.equal(intent.mutation_kind, 'submit');
    assert.equal(intent.attempt, 1);
    assert.ok(intent.resolved_at, 'a definitive outcome records resolved_at');
    assert.equal(intent.credential_ref, 'cred-ref-gate9', 'only a credential REFERENCE is stored');

    const reservation = await reservationRow(outcome.intentId);
    assert.equal(reservation.state, 'known_completed');
    assert.equal(reservation.requires_reconciliation, false);

    const rows = await receipts(outcome.intentId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, 'accepted');
    assert.equal(rows[0]!.identity_verified, true);
    assert.equal(rows[0]!.evidence, 'provider_response_verified');
    assert.equal(rows[0]!.provider_order_id, outcome.providerOrderId);

    const history = await events(outcome.intentId);
    assert.deepEqual(
      history.map((e) => e.to_state),
      // prepared → submitting → (M2 barrier consumed: submitting → submitting)
      // → confirmed.
      ['prepared', 'submitting', 'submitting', 'confirmed'],
    );
    assert.equal(history[2]!.from_state, 'submitting');
    assert.equal((history[2]!.detail as { barrier?: string }).barrier, 'submit_barrier_consumed');
  });

  /* ------------------------------------------------------------------------ */
  /* 2 — duplicate / idempotent submission                                     */
  /* ------------------------------------------------------------------------ */

  test('2. a duplicate submission never reaches the provider twice', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });

    const first = await ledger.submitOnce(input, provider.call);
    assert.equal(first.kind, 'submitted');
    assert.equal(first.kind === 'submitted' && first.result.outcome, 'accepted');

    const second = await ledger.submitOnce(input, provider.call);
    assert.equal(second.kind, 'duplicate');
    assert.equal(provider.calls.length, 1, 'the provider was called exactly once');

    const original = await intentRow(second.kind === 'duplicate' ? second.intent.id : '');
    assert.equal(original.status, 'confirmed');
    assert.equal(await countIntents(profileId), 1, 'no second mutation identity was minted');
    assert.equal((await receipts(original.id as string)).length, 1);
  });

  test('2b. a repeated request resolves by idempotency identity even with a fresh client order id', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });
    await ledger.submitOnce(input, provider.call);

    const resolved = await ledger.resolveByIdentity({
      executionProfileId: profileId,
      clientOrderId: 've-ffffffffffffffffffffffff',
      idempotencyKey: input.idempotencyKey,
    });
    assert.ok(resolved, 'the same idempotency identity resolves onto the existing intent');
    assert.equal(resolved!.clientOrderId, input.clientOrderId);
    assert.equal(resolved!.status, 'confirmed');
  });

  /* ------------------------------------------------------------------------ */
  /* 3 — verified provider rejection                                          */
  /* ------------------------------------------------------------------------ */

  test('3. a verified provider rejection is recorded as rejected, never as uncertainty', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'reject' });
    const input = submitInput({ userId, profileId });

    const outcome = await ledger.executeSubmit(await authorizedBarrier(input), provider.call);

    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.intentState, 'rejected');
    assert.equal(outcome.reservationState, 'known_rejected');
    assert.equal(outcome.requiresReconciliation, false);

    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'rejected');
    assert.equal(intent.outcome, 'rejected');
    assert.equal(intent.terminal_evidence, 'provider_response_verified');
    assert.equal(intent.uncertainty_reason, null);

    const reservation = await reservationRow(outcome.intentId);
    assert.equal(reservation.state, 'known_rejected');
    assert.equal(reservation.requires_reconciliation, false);
  });

  /* ------------------------------------------------------------------------ */
  /* 4–7 — every unobservable failure becomes uncertainty                     */
  /* ------------------------------------------------------------------------ */

  const uncertainCases: Array<{ name: string; scenario: FakeScenario; reason: string }> = [
    { name: '4. timeout', scenario: { kind: 'timeout' }, reason: 'timeout' },
    { name: '5. lost response', scenario: { kind: 'lost' }, reason: 'lost_response' },
    { name: '6. malformed response', scenario: { kind: 'malformed' }, reason: 'malformed_response' },
    { name: '7. unknown provider status', scenario: { kind: 'unknown_status' }, reason: 'unknown_provider_status' },
    { name: '7b. identity verification failure', scenario: { kind: 'identity_mismatch' }, reason: 'identity_verification_failed' },
    { name: '7c. transport failure after submission may have started', scenario: { kind: 'transport_failure' }, reason: 'connection_failure' },
  ];

  for (const testCase of uncertainCases) {
    test(`${testCase.name} fails closed into uncertainty and requires reconciliation`, async () => {
      const { userId, profileId } = await makeAccount();
      const provider = createFakeProvider(testCase.scenario);
      const input = submitInput({ userId, profileId });

      const outcome = await ledger.executeSubmit(await authorizedBarrier(input), provider.call);

      assert.equal(outcome.outcome, 'uncertain');
      assert.equal(outcome.uncertaintyReason, testCase.reason);
      assert.equal(outcome.intentState, 'uncertain');
      assert.equal(outcome.reservationState, 'uncertain');
      assert.equal(outcome.requiresReconciliation, true);
      assert.equal(outcome.evidence, null, 'an uncertain outcome carries no terminal evidence');

      const intent = await intentRow(outcome.intentId);
      assert.equal(intent.status, 'uncertain');
      assert.equal(intent.outcome, 'uncertain');
      assert.equal(intent.reconciliation_required, true);
      assert.equal(intent.reconciliation_state, 'pending');
      assert.equal(intent.terminal_evidence, null);
      assert.equal(intent.resolved_at, null, 'an uncertain mutation is never treated as resolved');
      assert.equal(intent.provider_order_id ?? null, null, 'no provider ticket is claimed for an unknown outcome');

      const reservation = await reservationRow(outcome.intentId);
      assert.equal(reservation.state, 'uncertain');
      assert.equal(reservation.requires_reconciliation, true);

      // A missing response is never a rejection.
      const rows = await receipts(outcome.intentId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.outcome, 'uncertain');
      assert.equal(rows[0]!.evidence, null);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* 8 — crash before the provider call                                       */
  /* ------------------------------------------------------------------------ */

  test('8. a crash before intent commit permits no provider call at all', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });
    const failing = new ProviderMutationLedger(withFailingBarrierWrite(pool, /INSERT INTO execution_provider_intents/i));

    await assert.rejects(
      () => failing.prepareSubmit(input),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'pre_call_persistence_failed',
    );
    assert.equal(provider.calls.length, 0, 'no provider call is permitted without a committed barrier');
    assert.equal(await countIntents(profileId), 0, 'nothing durable was committed');
  });

  test('8b. a crash after intent commit but before the provider call leaves an unresolved, unrepeatable intent', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });

    // The barrier commits and the process dies before the provider call.
    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    const intentId = prepared.kind === 'authorized' ? prepared.barrier.intentId : '';
    // (the in-memory barrier is discarded here — the "crash")

    assert.equal(provider.calls.length, 0);
    const intent = await intentRow(intentId);
    assert.equal(intent.status, 'submitting', 'the intent remains unresolved');
    assert.equal(intent.outcome, null);
    const reservation = await reservationRow(intentId);
    assert.equal(reservation.state, 'reserved');

    // A repeated request after the crash must NOT submit a second mutation.
    const replay = await ledger.submitOnce(input, provider.call);
    assert.equal(replay.kind, 'duplicate');
    assert.equal(provider.calls.length, 0, 'a crashed submission is never re-sent');
    assert.equal(await countIntents(profileId), 1);
  });

  /* ------------------------------------------------------------------------ */
  /* 9 — crash during / after the provider call                               */
  /* ------------------------------------------------------------------------ */

  test('9. a crash during the provider call is uncertainty, never a rejection', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'crash' });
    const input = submitInput({ userId, profileId });

    const outcome = await ledger.executeSubmit(await authorizedBarrier(input), provider.call);

    assert.equal(outcome.outcome, 'uncertain');
    assert.equal(outcome.uncertaintyReason, 'connection_failure');
    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'uncertain');
    assert.equal(intent.reconciliation_required, true);
  });

  test('9b. provider acceptance followed by a crash before the local outcome commit stays unresolved', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    const barrier = prepared.kind === 'authorized' ? prepared.barrier : null;
    assert.ok(barrier);

    // The provider accepts, then the process dies before anything is recorded.
    const accepted = { clientOrderId: barrier.clientOrderId, providerOrderId: 'sim-crash-after-accept', status: 'accepted' };
    assert.deepEqual(accepted.status, 'accepted');

    const intent = await intentRow(barrier.intentId);
    assert.equal(intent.status, 'submitting', 'no receipt, no conclusion: still unresolved');
    assert.equal((await receipts(barrier.intentId)).length, 0);

    // Restart recovery turns the in-flight intent into uncertainty.
    const recovered = await ledger.recoverAfterRestart({ executionProfileId: profileId });
    assert.ok(recovered.some((r) => r.id === barrier.intentId));
    const after = await intentRow(barrier.intentId);
    assert.equal(after.status, 'uncertain');
    assert.equal(after.uncertainty_reason, 'process_restart');
    assert.equal(after.reconciliation_required, true);
  });

  /* ------------------------------------------------------------------------ */
  /* 10 — restart and recovery                                                */
  /* ------------------------------------------------------------------------ */

  test('10. an in-flight mutation survives restart as uncertainty and cannot be resubmitted', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    const barrier = prepared.kind === 'authorized' ? prepared.barrier : null;
    assert.ok(barrier);

    // Restart: a brand-new ledger instance, no in-memory state.
    const restarted = new ProviderMutationLedger(pool);
    const unresolved = await restarted.listUnresolved({ executionProfileId: profileId });
    assert.ok(unresolved.some((i) => i.id === barrier.intentId), 'the durable intent survived the restart');

    const recovered = await restarted.recoverAfterRestart({ executionProfileId: profileId });
    assert.ok(recovered.some((r) => r.id === barrier.intentId));

    const intent = await intentRow(barrier.intentId);
    assert.equal(intent.status, 'uncertain');
    assert.equal(intent.uncertainty_reason, 'process_restart');
    const reservation = await reservationRow(barrier.intentId);
    assert.equal(reservation.state, 'uncertain');
    assert.equal(reservation.requires_reconciliation, true);

    const provider = createFakeProvider({ kind: 'accept' });
    const replay = await restarted.submitOnce(input, provider.call);
    assert.equal(replay.kind, 'duplicate');
    assert.equal(provider.calls.length, 0, 'a restart never authorizes a duplicate mutation');
    assert.equal(await countIntents(profileId), 1);
  });

  /* ------------------------------------------------------------------------ */
  /* 11 — receipt persistence failure                                         */
  /* ------------------------------------------------------------------------ */

  test('11. a receipt-persistence failure after a verified acceptance leaves the mutation uncertain', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });
    const failing = new ProviderMutationLedger(withFailingReceiptWrite(pool));

    const outcome = await failing.executeSubmit(await authorizedBarrier(input, failing), provider.call);

    assert.equal(provider.calls.length, 1);
    assert.equal(outcome.outcome, 'uncertain', 'an accepted-but-unrecorded mutation is uncertain, not accepted');
    assert.equal(outcome.persistenceFailure, 'receipt_persistence_failure');
    assert.equal(outcome.intentState, 'uncertain');
    assert.equal(outcome.reservationState, 'uncertain');
    assert.equal(outcome.requiresReconciliation, true);

    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'uncertain');
    assert.equal(intent.uncertainty_reason, 'receipt_persistence_failure');
    assert.equal(intent.terminal_evidence, null);
    assert.equal((await receipts(outcome.intentId)).length, 0, 'no unverified receipt was stored');
  });

  /* ------------------------------------------------------------------------ */
  /* 12 — concurrent duplicate submissions                                    */
  /* ------------------------------------------------------------------------ */

  test('12. concurrent duplicate submissions produce exactly one provider call', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    const input = submitInput({ userId, profileId });

    const results = await Promise.all([
      ledger.submitOnce(input, provider.call),
      ledger.submitOnce(input, provider.call),
      ledger.submitOnce(input, provider.call),
      ledger.submitOnce(input, provider.call),
    ]);

    assert.equal(provider.calls.length, 1, 'the provider saw exactly one mutation');
    const submitted = results.filter((r) => r.kind === 'submitted');
    assert.equal(submitted.length, 1);
    assert.equal(results.filter((r) => r.kind === 'duplicate').length, 3);
    assert.equal(await countIntents(profileId), 1);

    const intent = await intentRow(submitted[0]!.kind === 'submitted' ? submitted[0]!.result.intentId : '');
    assert.equal(intent.status, 'confirmed');
    assert.equal((await receipts(intent.id as string)).length, 1);
  });

  test('12b. concurrent barriers cannot both be authorized for one identity', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const prepared = await Promise.all([ledger.prepareSubmit(input), ledger.prepareSubmit(input), ledger.prepareSubmit(input)]);
    const authorized = prepared.filter((p) => p.kind === 'authorized');
    assert.equal(authorized.length, 1);
    const intentIds = new Set(prepared.filter((p) => p.kind === 'duplicate').map((p) => (p as { intent: ProviderIntentRecord }).intent.id));
    assert.equal(intentIds.size, 1);
    assert.equal(await countIntents(profileId), 1);
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM execution_provider_mutation_reservations WHERE execution_profile_id = $1`,
      [profileId],
    );
    assert.equal(rows[0]!.n, '1', 'exactly one durable reservation');
  });

  /* ------------------------------------------------------------------------ */
  /* 13 — reconciliation after uncertainty                                    */
  /* ------------------------------------------------------------------------ */

  test('13. verified reconciliation resolves an uncertain mutation without resubmitting', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'timeout' });
    const input = submitInput({ userId, profileId });
    const outcome = await ledger.executeSubmit(await authorizedBarrier(input), provider.call);
    assert.equal(outcome.intentState, 'uncertain');

    const observation = await ledger.recordReconciliationObservation({
      intentId: outcome.intentId,
      userId,
      executionProfileId: profileId,
      outcome: 'matched',
      providerStatus: 'filled',
      statusUncertain: false,
      providerOrderId: 'sim-reconciled-ticket',
    });

    assert.equal(observation.stale, false);
    assert.equal(observation.applied, true);
    assert.equal(observation.intentState, 'reconciled');
    assert.equal(observation.resolution, 'provider_accepted');
    assert.equal(observation.outcome, 'accepted');

    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'reconciled');
    assert.equal(intent.resolution, 'provider_accepted');
    assert.equal(intent.outcome, 'accepted');
    assert.equal(intent.terminal_evidence, 'reconciliation_verified');
    assert.equal(intent.reconciliation_state, 'resolved');
    assert.equal(intent.reconciliation_required, false);
    assert.ok(intent.resolved_at);

    const reservation = await reservationRow(outcome.intentId);
    assert.equal(reservation.state, 'known_completed');

    const { rows } = await pool.query<{ id: string; evidence: string; actor: string }>(
      `SELECT id, evidence, actor FROM execution_provider_resolutions WHERE intent_id = $1`,
      [outcome.intentId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.evidence, 'reconciliation_verified');
    assert.equal(provider.calls.length, 1, 'reconciliation never resubmits');
  });

  test('13b. verified absence is recorded as absence, never as a rejection', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const outcome = await ledger.executeSubmit(await authorizedBarrier(input), createFakeProvider({ kind: 'timeout' }).call);

    const resolution = await ledger.resolveByOperator({
      intentId: outcome.intentId,
      userId,
      executionProfileId: profileId,
      actor: 'operator:' + userId,
      resolvedBy: userId,
      resolution: 'provider_absent',
      evidence: 'operator_resolution',
      evidenceReference: 'broker-statement-2026-09-20#absent',
      note: 'Provider statement shows no order for this client order id',
    });

    assert.equal(resolution.toStatus, 'reconciled');
    assert.equal(resolution.outcome, null, 'absence is not a rejection');
    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'reconciled');
    assert.equal(intent.resolution, 'provider_absent');
    assert.equal(intent.outcome, null);
    assert.equal(intent.terminal_evidence, 'operator_resolution');

    // A not_found observation is an observation: it carries no provider status.
    await assert.rejects(
      () => ledger.recordReconciliationObservation({
        intentId: outcome.intentId,
        userId,
        executionProfileId: profileId,
        outcome: 'not_found',
        providerStatus: 'rejected',
        statusUncertain: false,
      }),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'invalid_observation',
    );
  });

  test('13c. valid not_found reconciliation preserves uncertainty and blocks retry until operator resolution', async () => {
    const { userId, profileId } = await makeAccount();
    const riskDecisionId = await makeRiskDecision(userId, profileId);
    const input = submitInput({
      userId,
      profileId,
      riskDecisionId,
      monetaryRisk: '55.5',
    });

    const outcome = await ledger.executeSubmit(
      await authorizedBarrier(input),
      createFakeProvider({ kind: 'timeout' }).call,
    );
    assert.equal(outcome.intentState, 'uncertain');

    // Record a valid not_found reconciliation observation
    const observation = await ledger.recordReconciliationObservation({
      intentId: outcome.intentId,
      userId,
      executionProfileId: profileId,
      outcome: 'not_found',
      providerStatus: null,
      statusUncertain: false,
    });

    // 1. Observation is recorded but NOT applied (applied=false, requiresOperatorResolution=true)
    assert.equal(observation.stale, false);
    assert.equal(observation.applied, false);
    assert.equal(observation.intentState, 'uncertain');
    assert.equal(observation.resolution, null);
    assert.equal(observation.outcome, 'uncertain');
    assert.equal(observation.requiresOperatorResolution, true);

    const obsRows = await pool.query<{ outcome: string; applied: boolean; evidence: string | null }>(
      `SELECT outcome, applied, evidence FROM execution_provider_reconciliation_observations WHERE intent_id = $1`,
      [outcome.intentId],
    );
    assert.equal(obsRows.rows.length, 1);
    assert.equal(obsRows.rows[0]!.outcome, 'not_found');
    assert.equal(obsRows.rows[0]!.applied, false);
    assert.equal(obsRows.rows[0]!.evidence, null);

    // 2. Intent remains uncertain
    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'uncertain');
    assert.equal(intent.resolution, null);
    assert.equal(intent.outcome, 'uncertain');
    assert.equal(intent.reconciliation_required, true);
    assert.equal(intent.reconciliation_state, 'pending');
    assert.equal(intent.resolved_at, null);

    // 3. Reservation remains uncertain
    const reservation = await reservationRow(outcome.intentId);
    assert.equal(reservation.state, 'uncertain');
    assert.equal(reservation.requires_reconciliation, true);

    // 4. Unresolved exposure remains counted
    const exposure = await ledger.unresolvedMutationExposure(profileId);
    assert.equal(exposure.count, 1);
    assert.equal(Number(exposure.monetaryRisk), 55.5);
    assert.deepEqual(exposure.clientOrderIds, [outcome.clientOrderId]);
    assert.equal(exposure.intents[0]!.state, 'uncertain');

    // 5. prepareRetry remains blocked by uncertainty_unresolved
    const retryRiskDecisionId = await makeRiskDecision(userId, profileId);
    await assert.rejects(
      () => ledger.prepareRetry({
        ...submitInput({ userId, profileId, riskDecisionId: retryRiskDecisionId }),
        parentIntentId: outcome.intentId,
        clientOrderId: `ve-${outcome.clientOrderId.slice(3, 23)}-r1`,
        idempotencyKey: newIdempotencyKey(),
        riskDecisionId: retryRiskDecisionId,
        authorizationId: `auth-${randomUUID()}`,
      }),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'uncertainty_unresolved',
    );

    // 6. Provider absence becomes durable only through explicit operator resolution
    const opResolution = await ledger.resolveByOperator({
      intentId: outcome.intentId,
      userId,
      executionProfileId: profileId,
      actor: 'operator:' + userId,
      resolvedBy: userId,
      resolution: 'provider_absent',
      evidence: 'operator_resolution',
      evidenceReference: 'ops-audit#reconciliation-confirmed-absent',
      note: 'Reconciliation observation confirmed absence, operator resolved',
    });
    assert.equal(opResolution.toStatus, 'reconciled');
    assert.equal(opResolution.resolution, 'provider_absent');
    assert.equal(opResolution.reservationState, 'known_rejected');

    const resolvedIntent = await intentRow(outcome.intentId);
    assert.equal(resolvedIntent.status, 'reconciled');
    assert.equal(resolvedIntent.resolution, 'provider_absent');
    assert.equal(resolvedIntent.outcome, null);
    assert.equal(resolvedIntent.reconciliation_required, false);

    const resolvedReservation = await reservationRow(outcome.intentId);
    assert.equal(resolvedReservation.state, 'known_rejected');
    assert.equal(resolvedReservation.requires_reconciliation, false);

    const exposureAfter = await ledger.unresolvedMutationExposure(profileId);
    assert.equal(exposureAfter.count, 0);
  });

  /* ------------------------------------------------------------------------ */
  /* 14 — retry after properly resolved uncertainty                           */
  /* ------------------------------------------------------------------------ */

  test('14. a retry after proper resolution gets a new identity and full lineage', async () => {
    const { userId, profileId } = await makeAccount();
    const riskDecisionId = await makeRiskDecision(userId, profileId);
    const input = submitInput({ userId, profileId, riskDecisionId });
    const first = await ledger.executeSubmit(await authorizedBarrier(input), createFakeProvider({ kind: 'timeout' }).call);
    assert.equal(first.intentState, 'uncertain');

    // Resolve through verified reconciliation (provider rejected the order).
    await ledger.recordReconciliationObservation({
      intentId: first.intentId,
      userId,
      executionProfileId: profileId,
      outcome: 'matched',
      providerStatus: 'rejected',
      statusUncertain: false,
    });

    const retry = await ledger.prepareRetry({
      ...submitInput({ userId, profileId, riskDecisionId }),
      parentIntentId: first.intentId,
      clientOrderId: `ve-${first.clientOrderId.slice(3, 23)}-r1`,
      idempotencyKey: newIdempotencyKey(),
      riskDecisionId,
      authorizationId: `auth-${randomUUID()}`,
    });
    assert.equal(retry.kind, 'authorized');
    const retryBarrier = retry.kind === 'authorized' ? retry.barrier : null;
    assert.ok(retryBarrier);
    assert.equal(retryBarrier.attempt, 2);

    const second = await ledger.executeSubmit(retryBarrier, createFakeProvider({ kind: 'accept' }).call);
    assert.equal(second.outcome, 'accepted');

    const retryIntent = await intentRow(retryBarrier.intentId);
    assert.equal(retryIntent.attempt, 2);
    assert.equal(retryIntent.parent_intent_id, first.intentId);
    assert.equal(retryIntent.root_intent_id, first.intentId);
    assert.equal(retryIntent.client_order_id, retryBarrier.clientOrderId);
    assert.notEqual(retryIntent.client_order_id, first.clientOrderId);
    assert.notEqual(retryIntent.idempotency_key, first.idempotencyKey);
    assert.equal(retryIntent.status, 'confirmed');

    const original = await intentRow(first.intentId);
    assert.equal(original.superseded_by_intent_id, retryBarrier.intentId, 'the original is superseded, never deleted');
    assert.equal(original.status, 'reconciled');
  });

  /* ------------------------------------------------------------------------ */
  /* 15 — attempted retry while uncertainty remains                           */
  /* ------------------------------------------------------------------------ */

  test('15. a retry while uncertainty remains is refused and mints no new mutation', async () => {
    const { userId, profileId } = await makeAccount();
    const riskDecisionId = await makeRiskDecision(userId, profileId);
    const input = submitInput({ userId, profileId, riskDecisionId });
    const first = await ledger.executeSubmit(await authorizedBarrier(input), createFakeProvider({ kind: 'timeout' }).call);
    assert.equal(first.intentState, 'uncertain');
    const before = await countIntents(profileId);

    await assert.rejects(
      () => ledger.prepareRetry({
        ...submitInput({ userId, profileId, riskDecisionId }),
        parentIntentId: first.intentId,
        clientOrderId: `ve-${first.clientOrderId.slice(3, 23)}-r1`,
        idempotencyKey: newIdempotencyKey(),
        riskDecisionId,
        authorizationId: `auth-${randomUUID()}`,
      }),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'uncertainty_unresolved',
    );
    assert.equal(await countIntents(profileId), before, 'no new mutation identity was created');

    // An unresolved retry may also never reuse the original identity.
    await assert.rejects(
      () => ledger.prepareRetry({
        ...submitInput({ userId, profileId, riskDecisionId }),
        parentIntentId: first.intentId,
        clientOrderId: first.clientOrderId,
        idempotencyKey: newIdempotencyKey(),
        riskDecisionId,
        authorizationId: `auth-${randomUUID()}`,
      }),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'uncertainty_unresolved',
    );

    // A resolved retry still requires fresh risk/authorization evidence.
    await ledger.resolveByOperator({
      intentId: first.intentId,
      userId,
      executionProfileId: profileId,
      actor: 'operator:' + userId,
      resolvedBy: userId,
      resolution: 'provider_absent',
      evidence: 'operator_resolution',
      evidenceReference: 'ops-ticket-4711',
    });
    await assert.rejects(
      () => ledger.prepareRetry({
        ...submitInput({ userId, profileId, riskDecisionId }),
        parentIntentId: first.intentId,
        clientOrderId: `ve-${first.clientOrderId.slice(3, 23)}-r1`,
        idempotencyKey: newIdempotencyKey(),
        riskDecisionId: '',
        authorizationId: `auth-${randomUUID()}`,
      }),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'retry_requires_fresh_authorization',
    );
    assert.equal(await countIntents(profileId), before);
  });

  /* ------------------------------------------------------------------------ */
  /* 16 — stale reconciliation result against a newer retry                   */
  /* ------------------------------------------------------------------------ */

  test('16. a late reconciliation result cannot overwrite a newer attempt', async () => {
    const { userId, profileId } = await makeAccount();
    const riskDecisionId = await makeRiskDecision(userId, profileId);

    // Attempt 1: uncertain, resolved as absent by an operator, then retried.
    const first = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId, riskDecisionId })),
      createFakeProvider({ kind: 'timeout' }).call,
    );
    await ledger.resolveByOperator({
      intentId: first.intentId,
      userId,
      executionProfileId: profileId,
      actor: 'operator:' + userId,
      resolvedBy: userId,
      resolution: 'provider_absent',
      evidence: 'operator_resolution',
      evidenceReference: 'ops-ticket-1001',
    });
    const retry = await ledger.prepareRetry({
      ...submitInput({ userId, profileId, riskDecisionId }),
      parentIntentId: first.intentId,
      clientOrderId: `ve-${first.clientOrderId.slice(3, 23)}-r1`,
      idempotencyKey: newIdempotencyKey(),
      riskDecisionId,
      authorizationId: `auth-${randomUUID()}`,
    });
    assert.equal(retry.kind, 'authorized');
    const secondBarrier = retry.kind === 'authorized' ? retry.barrier : null;
    assert.ok(secondBarrier);
    const second = await ledger.executeSubmit(secondBarrier, createFakeProvider({ kind: 'accept' }).call);
    assert.equal(second.outcome, 'accepted');

    // A late verified result about attempt 1 arrives after attempt 2 exists.
    const stale = await ledger.recordReconciliationObservation({
      intentId: first.intentId,
      userId,
      executionProfileId: profileId,
      outcome: 'matched',
      providerStatus: 'filled',
      statusUncertain: false,
      providerOrderId: 'sim-late-ticket',
    });
    assert.equal(stale.stale, true, 'the observation describes an attempt a newer retry has superseded');
    assert.equal(stale.applied, false);
    assert.equal(stale.intentState, 'reconciled');

    const original = await intentRow(first.intentId);
    assert.equal(original.status, 'reconciled');
    assert.equal(original.resolution, 'provider_absent', 'the newer attempt was not overwritten');
    assert.equal(original.outcome, null);

    const newer = await intentRow(secondBarrier.intentId);
    assert.equal(newer.status, 'confirmed');
    assert.equal(newer.outcome, 'accepted');

    const { rows } = await pool.query<{ stale: boolean; applied: boolean }>(
      `SELECT stale, applied FROM execution_provider_reconciliation_observations WHERE intent_id = $1`,
      [first.intentId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.stale, true);
    assert.equal(rows[0]!.applied, false);
  });

  test('16b. an observation for an already-definitive intent is recorded but never applied', async () => {
    const { userId, profileId } = await makeAccount();
    const outcome = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      createFakeProvider({ kind: 'accept' }).call,
    );
    assert.equal(outcome.intentState, 'confirmed');

    const stale = await ledger.recordReconciliationObservation({
      intentId: outcome.intentId,
      userId,
      executionProfileId: profileId,
      outcome: 'matched',
      providerStatus: 'rejected',
      statusUncertain: false,
    });
    assert.equal(stale.stale, true);
    assert.equal(stale.applied, false);

    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'confirmed', 'a newer definitive outcome is not overwritten');
    assert.equal(intent.outcome, 'accepted');
  });

  /* ------------------------------------------------------------------------ */
  /* 17 — risk-reservation expiry while the outcome remains uncertain         */
  /* ------------------------------------------------------------------------ */

  test('17. risk-reservation expiry cannot erase unresolved mutation safety', async () => {
    const { userId, profileId } = await makeAccount();
    const riskDecisionId = await makeRiskDecision(userId, profileId);
    const past = new Date(Date.now() - 5_000);
    const riskReservationId = await makeRiskReservation({
      userId,
      profileId,
      riskDecisionId,
      monetaryRisk: '42.5',
      expiresAt: past,
    });
    const input = submitInput({
      userId,
      profileId,
      riskDecisionId,
      riskReservationId,
      monetaryRisk: '42.5',
      riskExpiresAt: past,
    });

    const outcome = await ledger.executeSubmit(await authorizedBarrier(input), createFakeProvider({ kind: 'timeout' }).call);
    assert.equal(outcome.intentState, 'uncertain');

    // The EXISTING 60-second risk-reservation reclaim runs (unchanged behavior).
    const reclaim = await pool.query(
      `DELETE FROM risk_reservations
        WHERE execution_profile_id = $1 AND expires_at <= to_timestamp($2 / 1000.0)`,
      [profileId, Date.now()],
    );
    assert.equal(reclaim.rowCount, 1, 'the risk reservation was reclaimed by its own TTL');

    // …but the mutation ledger still represents the unresolved mutation.
    const reservation = await reservationRow(outcome.intentId);
    assert.equal(reservation.state, 'uncertain');
    assert.equal(reservation.requires_reconciliation, true);
    assert.equal(reservation.risk_reservation_id, null, 'the risk row may go; the mutation row may not');
    assert.equal(reservation.monetary_risk, '42.5000000000', 'the exposure linkage is retained durably');

    const exposure = await ledger.unresolvedMutationExposure(profileId);
    assert.equal(exposure.count, 1);
    assert.equal(Number(exposure.monetaryRisk), 42.5);
    assert.deepEqual(exposure.clientOrderIds, [outcome.clientOrderId]);

    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.status, 'uncertain');
    assert.equal(intent.risk_decision_id, riskDecisionId);

    // Expiry/cleanup still cannot authorize a duplicate mutation.
    const provider = createFakeProvider({ kind: 'accept' });
    const replay = await ledger.submitOnce(input, provider.call);
    assert.equal(replay.kind, 'duplicate');
    assert.equal(provider.calls.length, 0);

    // And the unresolved reservation cannot be deleted at all.
    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_mutation_reservations WHERE intent_id = $1`, [outcome.intentId]),
      /cannot be deleted/,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_intents WHERE id = $1`, [outcome.intentId]),
      /cannot be deleted/,
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Boundary: fail-closed identity, no secrets, immutability, retention      */
  /* ------------------------------------------------------------------------ */

  test('an invalid mutation identity is refused before any provider call', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'accept' });
    await assert.rejects(
      () => ledger.prepareSubmit(submitInput({ userId, profileId, clientOrderId: 'not-a-ve-identity' })),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'invalid_mutation_identity',
    );
    assert.equal(provider.calls.length, 0);
    assert.equal(await countIntents(profileId), 0);
  });

  test('a provider response carrying credential material cannot be persisted', async () => {
    const { userId, profileId } = await makeAccount();
    const provider = createFakeProvider({ kind: 'credential_leak' });
    const outcome = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      provider.call,
    );

    // The extra `receipt.token` field is itself a strictness violation, so the
    // response is unreadable: uncertainty, never a stored secret.
    assert.equal(outcome.outcome, 'uncertain');
    assert.equal((await receipts(outcome.intentId)).length, 1);
    const rows = await receipts(outcome.intentId);
    assert.equal(JSON.stringify(rows[0]!.receipt), '{}');

    // The database rejects a secret-shaped receipt even if the app is bypassed.
    await assert.rejects(
      () => pool.query(
        `INSERT INTO execution_provider_receipts
           (intent_id, user_id, execution_profile_id, client_order_id, idempotency_key, provider_slug,
            outcome, uncertainty_reason, receipt)
         VALUES ($1,$2,$3,$4,$5,'paper','uncertain','lost_response','{"providerOrderId":"x","password":"hunter2"}'::jsonb)`,
        [outcome.intentId, userId, profileId, outcome.clientOrderId, outcome.idempotencyKey],
      ),
      /violates check constraint|receipts_sanitized|cannot be inserted/i,
    );
  });

  test('terminal states cannot return to prepared/submitting', async () => {
    const { userId, profileId } = await makeAccount();
    const outcome = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      createFakeProvider({ kind: 'accept' }).call,
    );
    assert.equal(outcome.intentState, 'confirmed');

    for (const status of ['prepared', 'submitting'] as const) {
      await assert.rejects(
        () => pool.query(`UPDATE execution_provider_intents SET status = $2 WHERE id = $1`, [outcome.intentId, status]),
        /illegal provider intent transition/,
      );
    }
    // An uncertain intent can only leave through `reconciled`.
    const uncertain = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      createFakeProvider({ kind: 'timeout' }).call,
    );
    for (const status of ['prepared', 'submitting', 'confirmed'] as const) {
      await assert.rejects(
        () => pool.query(`UPDATE execution_provider_intents SET status = $2 WHERE id = $1`, [uncertain.intentId, status]),
        /illegal provider intent transition/,
      );
    }
    const intent = await intentRow(uncertain.intentId);
    assert.equal(intent.status, 'uncertain');
  });

  test('unresolved intents, reservations, receipts and evidence are retained', async () => {
    const { userId, profileId } = await makeAccount();
    const outcome = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      createFakeProvider({ kind: 'timeout' }).call,
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM execution_provider_receipts WHERE intent_id = $1`,
      [outcome.intentId],
    );
    assert.ok(rows[0]);

    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_receipts WHERE id = $1`, [rows[0]!.id]),
      /append-only|not allowed/i,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_mutation_events WHERE intent_id = $1`, [outcome.intentId]),
      /append-only|not allowed/i,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_intents WHERE id = $1`, [outcome.intentId]),
      /cannot be deleted/,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_mutation_reservations WHERE intent_id = $1`, [outcome.intentId]),
      /cannot be deleted/,
    );
  });

  test('Gate 9 persists submit mutations only and never stores a secret value', async () => {
    const { userId, profileId } = await makeAccount();
    await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      createFakeProvider({ kind: 'accept' }).call,
    );
    await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      createFakeProvider({ kind: 'timeout' }).call,
    );

    const { rows } = await pool.query<{ kinds: string[]; refs: Array<string | null>; secret_manager: boolean }>(
      `SELECT array_agg(DISTINCT mutation_kind) AS kinds,
              array_agg(DISTINCT credential_ref) AS refs
         FROM execution_provider_intents
        WHERE execution_profile_id = $1`,
      [profileId],
    );
    assert.deepEqual(rows[0]!.kinds, ['submit'], 'cancel/modify/close are out of scope for Gate 9');
    assert.deepEqual(rows[0]!.refs, ['cred-ref-gate9'], 'only a credential reference identifier is persisted');

    // No column anywhere in the Gate 9 tables can hold a credential value.
    const { rows: columns } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('execution_provider_intents','execution_provider_mutation_reservations',
                             'execution_provider_receipts','execution_provider_reconciliation_observations',
                             'execution_provider_resolutions','execution_provider_mutation_events')`,
    );
    for (const column of columns) {
      assert.ok(
        !/(password|passwd|secret_value|api_key|private_key|token_value)/i.test(column.column_name),
        `${column.table_name}.${column.column_name} must not be credential-shaped`,
      );
    }
  });

  test('an operator resolution preserves identity, records who resolved it, and never deletes the record', async () => {
    const { userId, profileId } = await makeAccount();
    const outcome = await ledger.executeSubmit(
      await authorizedBarrier(submitInput({ userId, profileId })),
      createFakeProvider({ kind: 'timeout' }).call,
    );

    await assert.rejects(
      () => ledger.resolveByOperator({
        intentId: outcome.intentId,
        userId,
        executionProfileId: profileId,
        actor: 'operator:' + userId,
        resolvedBy: userId,
        resolution: 'provider_accepted',
        evidence: 'operator_resolution',
        evidenceReference: '   ',
      }),
      (error: unknown) => error instanceof ProviderMutationError && error.code === 'operator_evidence_required',
      'marking a finding resolved is not itself evidence',
    );

    const resolved = await ledger.resolveByOperator({
      intentId: outcome.intentId,
      userId,
      executionProfileId: profileId,
      actor: 'operator:' + userId,
      resolvedBy: userId,
      resolution: 'provider_accepted',
      evidence: 'operator_resolution',
      evidenceReference: 'broker-confirmation-2026-09-20',
      note: 'Broker statement confirms the order exists',
    });
    assert.equal(resolved.fromStatus, 'uncertain');
    assert.equal(resolved.toStatus, 'reconciled');

    const intent = await intentRow(outcome.intentId);
    assert.equal(intent.client_order_id, outcome.clientOrderId, 'the original identity is preserved');
    assert.equal(intent.idempotency_key, outcome.idempotencyKey);
    assert.equal(intent.status, 'reconciled');
    assert.equal(intent.terminal_evidence, 'operator_resolution');

    const { rows } = await pool.query<{ actor: string; resolved_by: string | null; evidence_reference: string }>(
      `SELECT actor, resolved_by::text, evidence_reference FROM execution_provider_resolutions WHERE intent_id = $1`,
      [outcome.intentId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actor, `operator:${userId}`);
    assert.equal(rows[0]!.resolved_by, userId);
    assert.equal(rows[0]!.evidence_reference, 'broker-confirmation-2026-09-20');

    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_resolutions WHERE intent_id = $1`, [outcome.intentId]),
      /append-only|not allowed/i,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Helper: commit the barrier (the "pre-provider persistence barrier")         */
/* -------------------------------------------------------------------------- */

async function authorizedBarrier(input: SubmitIntentInput, target: ProviderMutationLedger = ledger): Promise<SubmitBarrier> {
  const prepared = await target.prepareSubmit(input);
  assert.equal(prepared.kind, 'authorized');
  if (prepared.kind !== 'authorized') throw new Error('barrier was not authorized');
  return prepared.barrier;
}
