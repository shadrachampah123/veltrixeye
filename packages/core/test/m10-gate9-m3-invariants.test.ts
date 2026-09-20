/**
 * M10 Gate 9 Step 3c (M3) — structural duplicate-mutation and retry invariants.
 *
 * `prepareSubmit` and `prepareRetry` must enforce, inside ONE transaction
 * (advisory lock → read → write → COMMIT), that:
 *
 *  - a managed order carries at most one unresolved provider mutation
 *    (`prepared` / `submitting` / `uncertain`);
 *  - a parent intent has at most one retry, a retry continues the newest
 *    lineage member, and a lineage never contains duplicate attempts;
 *  - a retry keeps its parent's provider/environment/account binding and
 *    managed order identity;
 *  - a retry needs a FRESH caller-supplied risk decision / authorization
 *    reference (Gate 9 never generates or approves one);
 *  - a confirmed / provider-accepted intent is never retried and never
 *    "started over" under the same order identity;
 *  - uncertainty keeps blocking until reconciliation or an operator resolves
 *    it; an explicit `provider_absent` resolution lets a new mutation proceed;
 *  - different orders, execution profiles and bindings stay independent.
 *
 * Migration 0030 mirrors the lineage/order invariants as partial unique
 * indexes; the last tests exercise those constraints directly with raw
 * concurrent transactions that bypass the application locks.
 *
 * Concurrency tests use REAL concurrent database transactions (separate pool
 * connections) and assert how many operations were actually authorized — never
 * just the final rows. While the winning transaction is held open inside its
 * locked check, `pg_stat_activity` is sampled to prove the competing
 * transactions are blocked on the advisory lock (i.e. lock and read really
 * happen in the same transaction).
 *
 * The provider is an injected fake. No broker, network, credential, risk
 * engine, authorization engine or transport is involved; M2 barrier
 * consumption is exercised only through the unchanged public API.
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
  type PrepareSubmitResult,
  type ProviderSubmitCall,
  type RetryIntentInput,
  type SubmitBarrier,
  type SubmitIntentInput,
} from '../src/execution/provider-mutations.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5469;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_gate9_m3';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let ledger: ProviderMutationLedger;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m10-gate9-m3');
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

const uniqueEmail = () => `gate9m3_${randomBytes(6).toString('hex')}@example.com`;

async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Gate 9 M3 Tester') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}

interface Binding {
  providerSlug: string;
  environment: 'paper' | 'demo';
  accountRef: string;
}

const PAPER_BINDING: Binding = { providerSlug: 'paper', environment: 'paper', accountRef: 'gate9-m3-acct' };
const DEMO_BINDING: Binding = { providerSlug: 'mt5', environment: 'demo', accountRef: 'gate9-m3-demo-acct' };

async function makeProfile(userId: string, binding: Binding = PAPER_BINDING): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,$3,$3,$4,$5,true,$6)`,
    [id, userId, binding.environment, binding.providerSlug, binding.accountRef, binding.environment === 'demo' ? 'unavailable' : 'connected'],
  );
  return id;
}

async function makeAccount(binding: Binding = PAPER_BINDING): Promise<{ userId: string; profileId: string }> {
  const userId = await makeUser();
  return { userId, profileId: await makeProfile(userId, binding) };
}

const newClientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;
const newIdempotencyKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const newAuthorizationId = () => `auth-${randomUUID()}`;

async function makeRiskDecision(userId: string, profileId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO risk_decisions
       (user_id, execution_profile_id, outcome, reason, entry_price, stop_loss_price, take_profit_price,
        policy_version, engine_version, current_exposure, projected_exposure)
     VALUES ($1,$2,'approved','gate9 m3 fixture',1.1,1.09,1.13,1,'gate9-m3-test','{}'::jsonb,'{}'::jsonb)
     RETURNING id`,
    [userId, profileId],
  );
  return rows[0]!.id;
}

/** A managed order row (`execution_orders`): the durable order identity a mutation is bound to. */
async function makeOrder(userId: string, profileId: string, providerSlug = 'paper'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_orders
       (id, user_id, execution_profile_id, client_order_id, provider_slug, asset_class, symbol, side, order_type,
        quantity, filled_quantity, status, idempotency_key, architecture_version)
     VALUES ($1,$2,$3,$4,$5,'forex','EURUSD','buy','market',1,0,'requested',$6,'m8.1-execution-arch-1')`,
    [id, userId, profileId, `ve-${id.replace(/-/g, '').slice(0, 24)}`, providerSlug, newIdempotencyKey()],
  );
  return id;
}

interface SubmitArgs {
  userId: string;
  profileId: string;
  orderId?: string | null;
  riskDecisionId?: string | null;
  binding?: Binding;
}

function submitInput(args: SubmitArgs): SubmitIntentInput {
  const clientOrderId = newClientOrderId();
  const idempotencyKey = newIdempotencyKey();
  const binding = args.binding ?? PAPER_BINDING;
  return {
    userId: args.userId,
    executionProfileId: args.profileId,
    orderId: args.orderId ?? null,
    clientOrderId,
    idempotencyKey,
    canonicalRequest: { clientOrderId, idempotencyKey, symbol: 'EURUSD', side: 'buy', orderType: 'market', quantity: 0.1 },
    providerSlug: binding.providerSlug,
    environment: binding.environment,
    accountRef: binding.accountRef,
    credentialRef: 'cred-ref-gate9-m3',
    credentialFingerprint: createHash('sha256').update('gate9-m3-binding').digest('hex'),
    riskDecisionId: args.riskDecisionId ?? null,
    riskReservationId: null,
    symbol: 'EURUSD',
    direction: 'long',
    monetaryRisk: '25',
    riskExpiresAt: null,
  };
}

interface RetryArgs extends SubmitArgs {
  parentIntentId: string;
  riskDecisionId: string;
  authorizationId?: string;
  clientOrderId?: string;
  idempotencyKey?: string;
}

function retryInput(args: RetryArgs): RetryIntentInput {
  const base = submitInput(args);
  const clientOrderId = args.clientOrderId ?? base.clientOrderId;
  const idempotencyKey = args.idempotencyKey ?? base.idempotencyKey;
  const { orderId, ...rest } = base;
  return {
    ...rest,
    ...(args.orderId === undefined ? {} : { orderId }),
    clientOrderId,
    idempotencyKey,
    canonicalRequest: { ...base.canonicalRequest, clientOrderId, idempotencyKey },
    parentIntentId: args.parentIntentId,
    riskDecisionId: args.riskDecisionId,
    authorizationId: args.authorizationId ?? newAuthorizationId(),
  };
}

async function authorizedBarrier(input: SubmitIntentInput, target: ProviderMutationLedger = ledger): Promise<SubmitBarrier> {
  const prepared = await target.prepareSubmit(input);
  assert.equal(prepared.kind, 'authorized');
  if (prepared.kind !== 'authorized') throw new Error('barrier was not authorized');
  return prepared.barrier;
}

async function authorizedRetry(input: RetryIntentInput, target: ProviderMutationLedger = ledger): Promise<SubmitBarrier> {
  const prepared = await target.prepareRetry(input);
  assert.equal(prepared.kind, 'authorized');
  if (prepared.kind !== 'authorized') throw new Error('retry was not authorized');
  return prepared.barrier;
}

/* -------------------------------------------------------------------------- */
/* Recording fake provider (test tool only — never a broker)                   */
/* -------------------------------------------------------------------------- */

type FakeScenario = { kind: 'accept' } | { kind: 'reject' } | { kind: 'timeout' };

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
      case 'reject':
        return {
          clientOrderId: barrier.clientOrderId,
          idempotencyKey: barrier.idempotencyKey,
          accountRef: barrier.accountRef,
          providerOrderId: null,
          status: 'rejected',
        };
      case 'timeout':
        throw new Error('simulated provider timeout');
    }
  };
  return { call, calls };
}

/** Submit for `input` and drive it to the requested durable end state. */
async function submitAs(kind: FakeScenario['kind'], input: SubmitIntentInput): Promise<{ intentId: string; barrier: SubmitBarrier }> {
  const barrier = await authorizedBarrier(input);
  const outcome = await ledger.executeSubmit(barrier, createFakeProvider({ kind }).call);
  const expected = kind === 'accept' ? 'confirmed' : kind === 'reject' ? 'rejected' : 'uncertain';
  assert.equal(outcome.intentState, expected);
  return { intentId: barrier.intentId, barrier };
}

async function resolveAbsent(intentId: string, userId: string, profileId: string): Promise<void> {
  const resolved = await ledger.resolveByOperator({
    intentId,
    userId,
    executionProfileId: profileId,
    actor: `operator:${userId}`,
    resolvedBy: userId,
    resolution: 'provider_absent',
    evidence: 'operator_resolution',
    evidenceReference: `ops-${randomUUID()}`,
  });
  assert.equal(resolved.toStatus, 'reconciled');
  assert.equal(resolved.resolution, 'provider_absent');
}

/* -------------------------------------------------------------------------- */
/* Durable-state readers                                                       */
/* -------------------------------------------------------------------------- */

async function intentRow(intentId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(`SELECT * FROM execution_provider_intents WHERE id = $1`, [intentId]);
  assert.ok(rows[0], `intent ${intentId} must exist`);
  return rows[0]!;
}

async function intentsForOrder(profileId: string, orderId: string): Promise<Array<{ id: string; status: string; attempt: number }>> {
  const { rows } = await pool.query<{ id: string; status: string; attempt: number }>(
    `SELECT id, status, attempt FROM execution_provider_intents WHERE execution_profile_id = $1 AND order_id = $2 ORDER BY created_at ASC`,
    [profileId, orderId],
  );
  return rows;
}

async function unresolvedForOrder(profileId: string, orderId: string): Promise<number> {
  const rows = await intentsForOrder(profileId, orderId);
  return rows.filter((r) => r.status === 'prepared' || r.status === 'submitting' || r.status === 'uncertain').length;
}

async function countIntents(profileId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM execution_provider_intents WHERE execution_profile_id = $1`, [profileId]);
  return Number(rows[0]!.n);
}

async function retriesOf(parentIntentId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM execution_provider_intents WHERE parent_intent_id = $1 ORDER BY created_at ASC`, [parentIntentId]);
  return rows.map((r) => r.id);
}

const expectCode = async (promise: Promise<unknown>, code: string): Promise<ProviderMutationError> => {
  let captured: ProviderMutationError | null = null;
  await assert.rejects(
    () => promise,
    (error: unknown) => {
      if (error instanceof ProviderMutationError && error.code === code) {
        captured = error;
        return true;
      }
      return false;
    },
    `expected a ${code} failure`,
  );
  return captured!;
};

/** Splits settled prepare results into authorized barriers and error codes. */
function tally(results: PromiseSettledResult<PrepareSubmitResult>[]): { authorized: SubmitBarrier[]; duplicates: number; codes: string[] } {
  const authorized: SubmitBarrier[] = [];
  const codes: string[] = [];
  let duplicates = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.kind === 'authorized') authorized.push(result.value.barrier);
      else duplicates++;
    } else {
      assert.ok(result.reason instanceof ProviderMutationError, `unexpected failure: ${String(result.reason)}`);
      codes.push(result.reason.code);
    }
  }
  return { authorized, duplicates, codes };
}

/* -------------------------------------------------------------------------- */
/* Concurrency instrumentation (test infrastructure only)                      */
/* -------------------------------------------------------------------------- */

/**
 * Pauses the FIRST client query matching `pattern` until `release()` — i.e.
 * holds the winning transaction open inside its locked check so that the
 * competing transactions can be observed blocked on the advisory lock.
 */
function withPausedQuery(base: pg.Pool, pattern: RegExp): { pool: pg.Pool; entered: Promise<void>; release: () => void } {
  let resolveEntered!: () => void;
  let resolveReleased!: () => void;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const released = new Promise<void>((resolve) => { resolveReleased = resolve; });
  let armed = true;
  const proxied = new Proxy(base, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(ct, cp) {
              if (cp === 'query') {
                return async (...args: unknown[]) => {
                  const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string } | undefined)?.text ?? '');
                  if (armed && pattern.test(text)) {
                    armed = false;
                    resolveEntered();
                    await released;
                  }
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
  return { pool: proxied, entered, release: resolveReleased };
}

/** Number of backends of this database currently blocked on a lock of the given wait event. */
async function waitingBackends(waitEvent: 'advisory' | 'transactionid'): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = $1`,
    [waitEvent],
  );
  return Number(rows[0]!.n);
}

async function waitUntilBlocked(expected: number, waitEvent: 'advisory' | 'transactionid' = 'advisory', timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await waitingBackends(waitEvent);
    if (n >= expected) return n;
    if (Date.now() > deadline) return n;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

/**
 * Replaces the result of the FIRST client query matching `pattern` with
 * fabricated rows (test infrastructure only): simulates a bypassed or broken
 * application check so the database layer behind it can be observed.
 */
function withFabricatedQuery(base: pg.Pool, pattern: RegExp, rows: () => unknown[]): pg.Pool {
  let armed = true;
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
                  if (armed && pattern.test(text)) {
                    armed = false;
                    const fabricated = rows();
                    return { rows: fabricated, rowCount: fabricated.length, command: 'SELECT', oid: 0, fields: [] };
                  }
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

/** Matches the M3 live-order read inside the prepare transactions. */
const ORDER_LIVE_CHECK = /AND order_id = \$2/;
/** Matches the M3 lineage read inside the retry transaction. */
const LINEAGE_READ = /OR root_intent_id = \$1/;

/* -------------------------------------------------------------------------- */
/* Raw-SQL helpers for the database-constraint tests                           */
/* -------------------------------------------------------------------------- */

interface RawIntent {
  userId: string;
  profileId: string;
  orderId?: string | null;
  status?: 'prepared' | 'submitting' | 'uncertain' | 'confirmed' | 'rejected' | 'reconciled';
  resolution?: 'provider_accepted' | 'provider_rejected' | 'provider_absent' | null;
  parentIntentId?: string | null;
  rootIntentId?: string | null;
  attempt?: number;
  legacy?: boolean;
}

/** Inserts a Gate 9-shaped intent row directly (bypassing the ledger and its locks). */
async function rawIntent(q: Pick<pg.PoolClient, 'query'>, args: RawIntent): Promise<string> {
  const id = randomUUID();
  const status = args.status ?? 'submitting';
  const unresolved = status === 'prepared' || status === 'submitting' || status === 'uncertain';
  const outcome = status === 'confirmed' ? 'accepted'
    : status === 'rejected' ? 'rejected'
      : status === 'uncertain' ? 'uncertain'
        : status === 'reconciled' ? (args.resolution === 'provider_accepted' ? 'accepted' : args.resolution === 'provider_rejected' ? 'rejected' : null)
          : null;
  await q.query(
    `INSERT INTO execution_provider_intents
       (id, user_id, execution_profile_id, order_id, mutation_kind, client_order_id, idempotency_key, request_hash,
        provider_slug, environment, account_ref, status, outcome, terminal_evidence, resolution, resolved_at,
        reconciliation_required, reconciliation_state, parent_intent_id, root_intent_id, attempt)
     VALUES ($1,$2,$3,$4,'submit',$5,$6,$7,'paper','paper','gate9-m3-acct',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id,
      args.userId,
      args.profileId,
      args.orderId ?? null,
      newClientOrderId(),
      args.legacy ? null : newIdempotencyKey(),
      args.legacy ? null : newIdempotencyKey(),
      status,
      args.legacy ? null : outcome,
      args.legacy ? null : (unresolved ? null : status === 'reconciled' ? 'operator_resolution' : 'provider_response_verified'),
      args.legacy ? null : (status === 'reconciled' ? (args.resolution ?? 'provider_absent') : null),
      args.legacy ? null : (unresolved ? null : new Date()),
      args.legacy ? false : status === 'uncertain',
      args.legacy ? 'not_required' : status === 'uncertain' ? 'pending' : status === 'reconciled' ? 'resolved' : 'not_required',
      args.parentIntentId ?? null,
      args.rootIntentId ?? null,
      args.attempt ?? 1,
    ],
  );
  return id;
}

const constraintOf = (error: unknown): string | null => (error as { constraint?: string } | null)?.constraint ?? null;
const sqlState = (error: unknown): string | null => (error as { code?: string } | null)?.code ?? null;

/* -------------------------------------------------------------------------- */
/* M3 — structural duplicate-mutation and retry invariants                     */
/* -------------------------------------------------------------------------- */

describe('Gate 9 Step 3c (M3) — structural duplicate-mutation and retry invariants', () => {
  /* ---------------------------------------------------------------------- */
  /* 1 — concurrent duplicate submit for one managed order                   */
  /* ---------------------------------------------------------------------- */

  test('M3-1. concurrent submissions for one managed order with different client order ids: exactly one is authorized', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const competitors = 4;

    // Hold the winner open inside its locked unresolved-order read so that the
    // other transactions can be observed blocked on the order lock.
    const paused = withPausedQuery(pool, ORDER_LIVE_CHECK);
    const racing = new ProviderMutationLedger(paused.pool);
    const inputs = Array.from({ length: competitors }, () => submitInput({ userId, profileId, orderId }));
    assert.equal(new Set(inputs.map((i) => i.clientOrderId)).size, competitors, 'every competitor carries its own identity');

    const pending = inputs.map((input) => racing.prepareSubmit(input));
    await paused.entered;
    const blocked = await waitUntilBlocked(competitors - 1);
    assert.equal(blocked, competitors - 1, 'every competing transaction is blocked on the order advisory lock while the winner reads');
    assert.equal((await intentsForOrder(profileId, orderId)).length, 0, 'the winner has not committed yet while it holds the lock');
    paused.release();

    const { authorized, duplicates, codes } = tally(await Promise.allSettled(pending));
    assert.equal(authorized.length, 1, 'exactly one submission was authorized');
    assert.equal(duplicates, 0, 'different identities are never reported as identity duplicates');
    assert.deepEqual(codes, Array(competitors - 1).fill('unresolved_order_mutation'));

    const rows = await intentsForOrder(profileId, orderId);
    assert.equal(rows.length, 1, 'exactly one durable intent exists for the order');
    assert.equal(rows[0]!.id, authorized[0]!.intentId);
    assert.equal(rows[0]!.status, 'submitting');
    const { rows: reservations } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM execution_provider_mutation_reservations WHERE execution_profile_id = $1 AND order_id = $2`,
      [profileId, orderId],
    );
    assert.equal(reservations[0]!.n, '1', 'exactly one durable reservation');
    assert.equal(await countIntents(profileId), 1);
  });

  test('M3-1b. a later submission for an order with an in-flight mutation fails closed even with a brand-new identity', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const first = await authorizedBarrier(submitInput({ userId, profileId, orderId }));

    const refused = await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');
    assert.equal(refused.intentId, first.intentId, 'the refusal names the blocking mutation');
    assert.equal(await countIntents(profileId), 1);

    // The identity-based semantics are untouched: the same identity replays as a duplicate.
    const replayInput = { ...submitInput({ userId, profileId, orderId }), clientOrderId: first.clientOrderId, idempotencyKey: first.idempotencyKey };
    const replay = await ledger.prepareSubmit(replayInput);
    assert.equal(replay.kind, 'duplicate');
  });

  /* ---------------------------------------------------------------------- */
  /* 2 — concurrent retry from one parent                                    */
  /* ---------------------------------------------------------------------- */

  test('M3-2. concurrent retries from one resolved parent: exactly one retry is created and the parent is superseded once', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const { intentId: parentId } = await submitAs('reject', submitInput({ userId, profileId, orderId }));
    const competitors = 4;
    const decisions = await Promise.all(Array.from({ length: competitors }, () => makeRiskDecision(userId, profileId)));

    const paused = withPausedQuery(pool, LINEAGE_READ);
    const racing = new ProviderMutationLedger(paused.pool);
    const pending = decisions.map((riskDecisionId) =>
      racing.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId })),
    );
    await paused.entered;
    const blocked = await waitUntilBlocked(competitors - 1);
    assert.equal(blocked, competitors - 1, 'every competing retry is blocked on the lineage advisory lock while the winner verifies the parent');
    assert.deepEqual(await retriesOf(parentId), [], 'nothing is committed while the winner holds the lock');
    paused.release();

    const { authorized, duplicates, codes } = tally(await Promise.allSettled(pending));
    assert.equal(authorized.length, 1, 'exactly one retry was authorized');
    assert.equal(duplicates, 0);
    assert.deepEqual(codes, Array(competitors - 1).fill('parent_already_superseded'));

    const retries = await retriesOf(parentId);
    assert.deepEqual(retries, [authorized[0]!.intentId], 'exactly one retry row exists for the parent');
    const parent = await intentRow(parentId);
    assert.equal(parent.superseded_by_intent_id, authorized[0]!.intentId, 'the parent is superseded exactly by the winner');
    assert.equal(authorized[0]!.attempt, 2);
    const retry = await intentRow(authorized[0]!.intentId);
    assert.equal(retry.order_id, orderId, 'the retry inherited the managed order identity');
    assert.equal(retry.root_intent_id, parentId);
    assert.equal(await countIntents(profileId), 2);
  });

  /* ---------------------------------------------------------------------- */
  /* 3 — sibling retry                                                       */
  /* ---------------------------------------------------------------------- */

  test('M3-3. a second (sibling) retry from an already-superseded parent is refused, whether the first retry is resolved or not', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const { intentId: parentId } = await submitAs('reject', submitInput({ userId, profileId, orderId }));

    const first = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) }));

    // While the first retry is still in flight.
    const early = await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'parent_already_superseded',
    );
    assert.equal(early.intentId, parentId);

    // And after the first retry itself resolved (rejected): the parent still has exactly one retry.
    const outcome = await ledger.executeSubmit(first, createFakeProvider({ kind: 'reject' }).call);
    assert.equal(outcome.intentState, 'rejected');
    await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'parent_already_superseded',
    );
    assert.deepEqual(await retriesOf(parentId), [first.intentId]);

    // The lineage continues only from its newest member.
    const second = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: first.intentId, riskDecisionId: await makeRiskDecision(userId, profileId) }));
    assert.equal(second.attempt, 3);
    assert.equal((await intentRow(first.intentId)).superseded_by_intent_id, second.intentId);
    assert.equal(await countIntents(profileId), 3);
  });

  /* ---------------------------------------------------------------------- */
  /* 4 — start-over against an unresolved order                              */
  /* ---------------------------------------------------------------------- */

  test('M3-4. a start-over submission for an order whose mutation is unresolved is refused; without an order id the identity semantics are unchanged', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const { intentId } = await submitAs('timeout', submitInput({ userId, profileId, orderId }));
    assert.equal((await intentRow(intentId)).status, 'uncertain');

    const refused = await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');
    assert.equal(refused.intentId, intentId);
    assert.equal(await unresolvedForOrder(profileId, orderId), 1);
    assert.equal(await countIntents(profileId), 1, 'the refused start-over minted nothing');

    // Mutations without a managed order keep the pre-existing identity contract:
    // two different identities are two independent mutations.
    const a = await ledger.prepareSubmit(submitInput({ userId, profileId }));
    const b = await ledger.prepareSubmit(submitInput({ userId, profileId }));
    assert.equal(a.kind, 'authorized');
    assert.equal(b.kind, 'authorized');
    assert.equal(await countIntents(profileId), 3);
  });

  /* ---------------------------------------------------------------------- */
  /* 5 — provider_absent resolution permits a new mutation                   */
  /* ---------------------------------------------------------------------- */

  test('M3-5. after an explicit provider_absent resolution a new mutation for the order may proceed — by start-over or by retry, but not both at once', async () => {
    // Start-over path.
    const { userId, profileId } = await makeAccount();
    const orderA = await makeOrder(userId, profileId);
    const { intentId: absentA } = await submitAs('timeout', submitInput({ userId, profileId, orderId: orderA }));
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderA })), 'unresolved_order_mutation');
    await resolveAbsent(absentA, userId, profileId);

    const startOver = await ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderA }));
    assert.equal(startOver.kind, 'authorized');
    assert.equal(await unresolvedForOrder(profileId, orderA), 1);
    // The absent original cannot now be retried underneath the live start-over.
    await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: absentA, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'unresolved_order_mutation',
    );
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderA })), 'unresolved_order_mutation');

    // Retry path.
    const orderB = await makeOrder(userId, profileId);
    const { intentId: absentB } = await submitAs('timeout', submitInput({ userId, profileId, orderId: orderB }));
    await resolveAbsent(absentB, userId, profileId);
    const retry = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: absentB, riskDecisionId: await makeRiskDecision(userId, profileId) }));
    assert.equal(retry.attempt, 2);
    assert.equal((await intentRow(retry.intentId)).order_id, orderB);
    // The live retry now blocks a start-over for the same order.
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderB })), 'unresolved_order_mutation');
    assert.equal(await unresolvedForOrder(profileId, orderB), 1);
  });

  /* ---------------------------------------------------------------------- */
  /* 6 — uncertainty remains blocking                                        */
  /* ---------------------------------------------------------------------- */

  test('M3-6. an uncertain mutation keeps blocking through inconclusive reconciliation until it is resolved', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const { intentId } = await submitAs('timeout', submitInput({ userId, profileId, orderId }));
    const blockedEverywhere = async () => {
      await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');
      await expectCode(
        ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: intentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
        'uncertainty_unresolved',
      );
      assert.equal(await unresolvedForOrder(profileId, orderId), 1);
      assert.equal(await countIntents(profileId), 1);
    };
    await blockedEverywhere();

    for (const observation of [
      { outcome: 'not_found' as const, providerStatus: null, statusUncertain: false },
      { outcome: 'uncertain' as const, providerStatus: null, statusUncertain: true },
      { outcome: 'mismatched' as const, providerStatus: 'filled' as const, statusUncertain: false },
      { outcome: 'matched' as const, providerStatus: 'filled' as const, statusUncertain: true },
    ]) {
      const result = await ledger.recordReconciliationObservation({ intentId, userId, executionProfileId: profileId, ...observation });
      assert.equal(result.applied, false, `${observation.outcome} does not resolve uncertainty`);
      assert.equal(result.intentState, 'uncertain');
      await blockedEverywhere();
    }

    // A verified rejection resolves it — and only then may the lineage continue.
    const applied = await ledger.recordReconciliationObservation({
      intentId, userId, executionProfileId: profileId, outcome: 'matched', providerStatus: 'rejected', statusUncertain: false,
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.resolution, 'provider_rejected');
    const retry = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: intentId, riskDecisionId: await makeRiskDecision(userId, profileId) }));
    assert.equal(retry.attempt, 2);
  });

  /* ---------------------------------------------------------------------- */
  /* 7 — retry binding mismatch                                              */
  /* ---------------------------------------------------------------------- */

  test('M3-7. a retry must keep its parent provider, environment, account binding and managed order identity', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const otherOrder = await makeOrder(userId, profileId);
    const { intentId: parentId } = await submitAs('reject', submitInput({ userId, profileId, orderId }));
    const fresh = () => makeRiskDecision(userId, profileId);

    const attempts: Array<[string, Partial<Binding> | { orderId: string }]> = [
      ['provider', { providerSlug: 'mt5' }],
      ['environment', { environment: 'demo' }],
      ['account', { accountRef: 'someone-elses-account' }],
      ['order', { orderId: otherOrder }],
    ];
    for (const [label, change] of attempts) {
      const input = 'orderId' in change
        ? retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await fresh(), orderId: change.orderId })
        : retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await fresh(), binding: { ...PAPER_BINDING, ...change } });
      const error = await expectCode(ledger.prepareRetry(input), 'binding_mismatch');
      assert.equal(error.intentId, parentId, `${label} mismatch is refused against the parent`);
    }
    assert.deepEqual(await retriesOf(parentId), [], 'no mismatched retry was created');
    assert.equal((await intentRow(parentId)).superseded_by_intent_id, null, 'a refused retry never supersedes the parent');

    // Coherent binding: authorized, and the retry carries the parent's binding + order.
    const retry = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await fresh() }));
    const row = await intentRow(retry.intentId);
    assert.equal(row.provider_slug, 'paper');
    assert.equal(row.environment, 'paper');
    assert.equal(row.account_ref, PAPER_BINDING.accountRef);
    assert.equal(row.order_id, orderId);
  });

  /* ---------------------------------------------------------------------- */
  /* 8 — stale parent                                                        */
  /* ---------------------------------------------------------------------- */

  test('M3-8. a retry must continue the newest lineage member: an older attempt is refused as superseded, and as stale when its pointer is missing', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const { intentId: root } = await submitAs('reject', submitInput({ userId, profileId, orderId }));
    const second = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: root, riskDecisionId: await makeRiskDecision(userId, profileId) }));
    assert.equal((await ledger.executeSubmit(second, createFakeProvider({ kind: 'reject' }).call)).intentState, 'rejected');
    const third = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: second.intentId, riskDecisionId: await makeRiskDecision(userId, profileId) }));
    assert.equal((await ledger.executeSubmit(third, createFakeProvider({ kind: 'reject' }).call)).intentState, 'rejected');

    // A caller holding a stale view of the lineage cannot branch from the root or the middle.
    for (const stale of [root, second.intentId]) {
      await expectCode(
        ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: stale, riskDecisionId: await makeRiskDecision(userId, profileId) })),
        'parent_already_superseded',
      );
    }
    assert.equal(await countIntents(profileId), 3);

    // Defense in depth: a lineage member that is not the newest attempt is
    // refused as stale even when its superseded pointer was never written
    // (a lineage written outside the M3 rules).
    const q1 = await rawIntent(pool, { userId, profileId, status: 'rejected' });
    const q2 = await rawIntent(pool, { userId, profileId, status: 'rejected', parentIntentId: q1, rootIntentId: q1, attempt: 2 });
    assert.equal((await intentRow(q1)).superseded_by_intent_id, null);
    const staleError = await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: q1, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'stale_parent_intent',
    );
    assert.equal(staleError.intentId, q1);
    assert.deepEqual(await retriesOf(q1), [q2], 'the stale parent gained no second retry');
    // The newest member of that lineage can be continued.
    const q3 = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: q2, riskDecisionId: await makeRiskDecision(userId, profileId) }));
    assert.equal(q3.attempt, 3);
    assert.equal((await intentRow(q2)).superseded_by_intent_id, q3.intentId);
  });

  /* ---------------------------------------------------------------------- */
  /* 9 — fresh risk / authorization reference                                */
  /* ---------------------------------------------------------------------- */

  test('M3-9. a retry requires a fresh caller-supplied risk decision and authorization reference; Gate 9 never mints one', async () => {
    const { userId, profileId } = await makeAccount();
    const stranger = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const originalDecision = await makeRiskDecision(userId, profileId);
    const { intentId: parentId } = await submitAs('reject', submitInput({ userId, profileId, orderId, riskDecisionId: originalDecision }));
    const otherOrder = await makeOrder(userId, profileId);
    const consumedElsewhere = await makeRiskDecision(userId, profileId);
    await authorizedBarrier(submitInput({ userId, profileId, orderId: otherOrder, riskDecisionId: consumedElsewhere }));
    const strangersDecision = await makeRiskDecision(stranger.userId, stranger.profileId);
    const retry = (riskDecisionId: string, authorizationId?: string) =>
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId, ...(authorizationId === undefined ? {} : { authorizationId }) }));

    const cases: Array<[string, string, string | undefined]> = [
      ['empty risk decision', '', undefined],
      ['empty authorization', await makeRiskDecision(userId, profileId), ''],
      ['blank authorization', await makeRiskDecision(userId, profileId), '   '],
      ['malformed risk decision reference', 'not-a-risk-decision', undefined],
      ['unknown risk decision', randomUUID(), undefined],
      ["the parent's own risk decision", originalDecision, undefined],
      ['a risk decision consumed by another mutation', consumedElsewhere, undefined],
      ["another tenant's risk decision", strangersDecision, undefined],
    ];
    for (const [label, riskDecisionId, authorizationId] of cases) {
      const error = await expectCode(retry(riskDecisionId, authorizationId), 'retry_requires_fresh_authorization');
      assert.equal(error.intentId, parentId, `${label}: refused`);
    }
    assert.deepEqual(await retriesOf(parentId), [], 'no refused retry minted a mutation');
    assert.equal((await intentRow(parentId)).superseded_by_intent_id, null);
    const decisions = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM risk_decisions WHERE user_id = $1`, [userId]);

    // Fresh references: authorized; the retry is durably bound to them.
    const freshDecision = await makeRiskDecision(userId, profileId);
    const authorizationId = newAuthorizationId();
    const barrier = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: freshDecision, authorizationId }));
    assert.equal((await intentRow(barrier.intentId)).risk_decision_id, freshDecision);
    const after = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM risk_decisions WHERE user_id = $1`, [userId]);
    assert.equal(Number(after.rows[0]!.n), Number(decisions.rows[0]!.n) + 1, 'only the test fixture created a risk decision — Gate 9 created none');

    // An authorization already consumed by a retry is not fresh either.
    assert.equal((await ledger.executeSubmit(barrier, createFakeProvider({ kind: 'reject' }).call)).intentState, 'rejected');
    await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: barrier.intentId, riskDecisionId: await makeRiskDecision(userId, profileId), authorizationId })),
      'retry_requires_fresh_authorization',
    );
    await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: barrier.intentId, riskDecisionId: freshDecision })),
      'retry_requires_fresh_authorization',
    );
    const third = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: barrier.intentId, riskDecisionId: await makeRiskDecision(userId, profileId) }));
    assert.equal(third.attempt, 3);
  });

  /* ---------------------------------------------------------------------- */
  /* 10 / 11 / 12 — isolation                                                */
  /* ---------------------------------------------------------------------- */

  test('M3-10. different managed orders in one profile are independent', async () => {
    const { userId, profileId } = await makeAccount();
    const [orderA, orderB, orderC] = await Promise.all([makeOrder(userId, profileId), makeOrder(userId, profileId), makeOrder(userId, profileId)]);

    const { authorized, codes } = tally(await Promise.allSettled([
      ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderA })),
      ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderB })),
      ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderA })),
      ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderB })),
    ]));
    assert.equal(authorized.length, 2, 'one mutation per order was authorized concurrently');
    assert.deepEqual(codes, ['unresolved_order_mutation', 'unresolved_order_mutation']);
    assert.equal(await unresolvedForOrder(profileId, orderA), 1);
    assert.equal(await unresolvedForOrder(profileId, orderB), 1);

    // Uncertainty on A does not touch C.
    const unresolvedA = (await intentsForOrder(profileId, orderA))[0]!.id;
    await ledger.recoverAfterRestart({ executionProfileId: profileId });
    assert.equal((await intentRow(unresolvedA)).status, 'uncertain');
    assert.equal((await ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderC }))).kind, 'authorized');
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId: orderA })), 'unresolved_order_mutation');
  });

  test('M3-11. different execution profiles are independent and cannot reach into each other\'s lineages', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    const orderA = await makeOrder(a.userId, a.profileId);
    const orderB = await makeOrder(b.userId, b.profileId);

    const { authorized } = tally(await Promise.allSettled([
      ledger.prepareSubmit(submitInput({ userId: a.userId, profileId: a.profileId, orderId: orderA })),
      ledger.prepareSubmit(submitInput({ userId: b.userId, profileId: b.profileId, orderId: orderB })),
    ]));
    assert.equal(authorized.length, 2);

    // Profile A's unresolved order blocks A only.
    await expectCode(ledger.prepareSubmit(submitInput({ userId: a.userId, profileId: a.profileId, orderId: orderA })), 'unresolved_order_mutation');
    const orderB2 = await makeOrder(b.userId, b.profileId);
    assert.equal((await ledger.prepareSubmit(submitInput({ userId: b.userId, profileId: b.profileId, orderId: orderB2 }))).kind, 'authorized');

    // A lineage in A cannot be retried by B, even with B's own fresh decision.
    const orderA2 = await makeOrder(a.userId, a.profileId);
    const { intentId: rejectedA } = await submitAs('reject', submitInput({ userId: a.userId, profileId: a.profileId, orderId: orderA2 }));
    await expectCode(
      ledger.prepareRetry(retryInput({ userId: b.userId, profileId: b.profileId, parentIntentId: rejectedA, riskDecisionId: await makeRiskDecision(b.userId, b.profileId) })),
      'intent_ownership_mismatch',
    );
    // ...and A cannot spend B's risk decision for its own retry.
    await expectCode(
      ledger.prepareRetry(retryInput({ userId: a.userId, profileId: a.profileId, parentIntentId: rejectedA, riskDecisionId: await makeRiskDecision(b.userId, b.profileId) })),
      'retry_requires_fresh_authorization',
    );
    assert.deepEqual(await retriesOf(rejectedA), []);
    const retry = await authorizedRetry(retryInput({ userId: a.userId, profileId: a.profileId, parentIntentId: rejectedA, riskDecisionId: await makeRiskDecision(a.userId, a.profileId) }));
    assert.equal(retry.executionProfileId, a.profileId);
  });

  test('M3-12. different provider/environment/account bindings are independent; a binding never opens a loophole for one order', async () => {
    const userId = await makeUser();
    const paperProfile = await makeProfile(userId, PAPER_BINDING);
    const demoProfile = await makeProfile(userId, DEMO_BINDING);
    const paperOrder = await makeOrder(userId, paperProfile, 'paper');
    const demoOrder = await makeOrder(userId, demoProfile, 'mt5');

    const { authorized } = tally(await Promise.allSettled([
      ledger.prepareSubmit(submitInput({ userId, profileId: paperProfile, orderId: paperOrder, binding: PAPER_BINDING })),
      ledger.prepareSubmit(submitInput({ userId, profileId: demoProfile, orderId: demoOrder, binding: DEMO_BINDING })),
    ]));
    assert.equal(authorized.length, 2, 'the paper and demo bindings each carry their own live mutation');
    assert.deepEqual(authorized.map((b) => b.environment).sort(), ['demo', 'paper']);

    // The same managed order under a different account/binding is still the same order: blocked.
    await expectCode(
      ledger.prepareSubmit(submitInput({ userId, profileId: paperProfile, orderId: paperOrder, binding: { ...PAPER_BINDING, accountRef: 'another-account' } })),
      'unresolved_order_mutation',
    );
    await expectCode(
      ledger.prepareSubmit(submitInput({ userId, profileId: paperProfile, orderId: paperOrder, binding: { ...PAPER_BINDING, providerSlug: 'mt5', environment: 'demo' } })),
      'unresolved_order_mutation',
    );
    assert.equal(await unresolvedForOrder(paperProfile, paperOrder), 1);
    assert.equal(await unresolvedForOrder(demoProfile, demoOrder), 1);
  });

  /* ---------------------------------------------------------------------- */
  /* 13 — state_commit_failed interaction                                    */
  /* ---------------------------------------------------------------------- */

  test('M3-13. after state_commit_failed the order stays blocked; once resolved as provider-accepted it can be neither retried nor started over', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const provider = createFakeProvider({ kind: 'accept' });
    const failing = new ProviderMutationLedger(withFailingClientQuery(pool, /SET status = \$3/));
    const barrier = await authorizedBarrier(submitInput({ userId, profileId, orderId }), failing);

    const outcome = await failing.executeSubmit(barrier, provider.call);
    assert.equal(provider.calls.length, 1);
    assert.equal(outcome.persistenceFailure, 'state_commit_failed');
    assert.equal((await intentRow(barrier.intentId)).status, 'submitting', 'the intent is still submitting after the failed commit');

    // The provider may hold this order: nothing new may be created for it.
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');
    await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: barrier.intentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'uncertainty_unresolved',
    );
    // M2 is unchanged: the consumed barrier can never call the provider again.
    await expectCode(ledger.executeSubmit(barrier, provider.call), 'barrier_not_consumable');
    assert.equal(provider.calls.length, 1);

    // Restart recovery turns it into explicit uncertainty — still blocking.
    await ledger.recoverAfterRestart({ executionProfileId: profileId });
    assert.equal((await intentRow(barrier.intentId)).status, 'uncertain');
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');

    // The durable receipt proves acceptance; the operator resolves accordingly.
    const resolved = await ledger.resolveByOperator({
      intentId: barrier.intentId,
      userId,
      executionProfileId: profileId,
      actor: `operator:${userId}`,
      resolvedBy: userId,
      resolution: 'provider_accepted',
      evidence: 'provider_response_verified',
      evidenceReference: `receipt:${barrier.intentId}`,
    });
    assert.equal(resolved.resolution, 'provider_accepted');
    // A provider-accepted order identity is closed to Gate 9 mutations.
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'duplicate_mutation');
    await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: barrier.intentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'duplicate_mutation',
    );
    assert.equal((await intentsForOrder(profileId, orderId)).length, 1);
    assert.equal(provider.calls.length, 1, 'the provider was invoked exactly once throughout');
  });

  /* ---------------------------------------------------------------------- */
  /* 14 — restart / reconciliation interaction                               */
  /* ---------------------------------------------------------------------- */

  test('M3-14. restart recovery and reconciliation interact with the order invariant exactly as their resolutions dictate', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const inFlight = await authorizedBarrier(submitInput({ userId, profileId, orderId }));
    // (the process dies here; the in-memory barrier is gone)

    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');
    const restarted = new ProviderMutationLedger(pool);
    const recovered = await restarted.recoverAfterRestart({ executionProfileId: profileId });
    assert.ok(recovered.some((r) => r.id === inFlight.intentId));
    assert.equal((await intentRow(inFlight.intentId)).status, 'uncertain');
    await expectCode(restarted.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');

    // Verified rejection through reconciliation: the lineage may continue by retry.
    const rejected = await restarted.recordReconciliationObservation({
      intentId: inFlight.intentId, userId, executionProfileId: profileId, outcome: 'matched', providerStatus: 'rejected', statusUncertain: false,
    });
    assert.equal(rejected.resolution, 'provider_rejected');
    const retry = await authorizedRetry(retryInput({ userId, profileId, parentIntentId: inFlight.intentId, riskDecisionId: await makeRiskDecision(userId, profileId) }), restarted);
    assert.equal((await intentRow(retry.intentId)).order_id, orderId, 'the retry continues the managed order');
    await expectCode(restarted.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');

    // The retry is accepted: the order is closed to further Gate 9 mutations.
    const accepted = await restarted.executeSubmit(retry, createFakeProvider({ kind: 'accept' }).call);
    assert.equal(accepted.intentState, 'confirmed');
    await expectCode(restarted.prepareSubmit(submitInput({ userId, profileId, orderId })), 'duplicate_mutation');
    await expectCode(
      restarted.prepareRetry(retryInput({ userId, profileId, parentIntentId: retry.intentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'duplicate_mutation',
    );
    // A late observation about the superseded original changes nothing.
    const late = await restarted.recordReconciliationObservation({
      intentId: inFlight.intentId, userId, executionProfileId: profileId, outcome: 'matched', providerStatus: 'filled', statusUncertain: false,
    });
    assert.equal(late.applied, false);
    assert.equal((await intentsForOrder(profileId, orderId)).length, 2);

    // Reconciliation proving provider acceptance closes the order identity too.
    const orderB = await makeOrder(userId, profileId);
    const { intentId: uncertainB } = await submitAs('timeout', submitInput({ userId, profileId, orderId: orderB }));
    const filled = await restarted.recordReconciliationObservation({
      intentId: uncertainB, userId, executionProfileId: profileId, outcome: 'matched', providerStatus: 'filled', statusUncertain: false,
    });
    assert.equal(filled.resolution, 'provider_accepted');
    await expectCode(restarted.prepareSubmit(submitInput({ userId, profileId, orderId: orderB })), 'duplicate_mutation');
    await expectCode(
      restarted.prepareRetry(retryInput({ userId, profileId, parentIntentId: uncertainB, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'duplicate_mutation',
    );
  });

  /* ---------------------------------------------------------------------- */
  /* 15 — confirmed intents are never retried                                */
  /* ---------------------------------------------------------------------- */

  test('M3-15. a confirmed intent is never retried; the same order identity is closed after confirmation', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const { intentId } = await submitAs('accept', submitInput({ userId, profileId, orderId }));

    const error = await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: intentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'duplicate_mutation',
    );
    assert.equal(error.intentId, intentId);
    await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'duplicate_mutation');
    assert.deepEqual(await retriesOf(intentId), []);
    assert.equal((await intentRow(intentId)).superseded_by_intent_id, null);
    assert.equal((await intentsForOrder(profileId, orderId)).length, 1);

    // A distinct logical order identity is the only way to another order.
    const nextOrder = await makeOrder(userId, profileId);
    assert.equal((await ledger.prepareSubmit(submitInput({ userId, profileId, orderId: nextOrder }))).kind, 'authorized');
  });

  /* ---------------------------------------------------------------------- */
  /* 16 — persistence failure inside the checks is fail-closed               */
  /* ---------------------------------------------------------------------- */

  test('M3-16. a database failure inside the locked checks rolls everything back and permits no mutation', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const failingSubmit = new ProviderMutationLedger(withFailingClientQuery(pool, ORDER_LIVE_CHECK));
    await expectCode(failingSubmit.prepareSubmit(submitInput({ userId, profileId, orderId })), 'pre_call_persistence_failed');
    assert.equal(await countIntents(profileId), 0);

    const { intentId: parentId } = await submitAs('reject', submitInput({ userId, profileId, orderId }));
    const failingRetry = new ProviderMutationLedger(withFailingClientQuery(pool, LINEAGE_READ));
    await expectCode(
      failingRetry.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'pre_call_persistence_failed',
    );
    // Failure after the retry row was written but before the parent CAS: nothing survives.
    const failingSupersede = new ProviderMutationLedger(withFailingClientQuery(pool, /SET superseded_by_intent_id = \$2/));
    await expectCode(
      failingSupersede.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'pre_call_persistence_failed',
    );
    assert.deepEqual(await retriesOf(parentId), []);
    assert.equal((await intentRow(parentId)).superseded_by_intent_id, null);
    assert.equal(await countIntents(profileId), 1);
    // The lineage is intact and can still be continued normally.
    assert.equal((await authorizedRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) }))).attempt, 2);
  });

  /* ---------------------------------------------------------------------- */
  /* 17 — migration 0030 constraints, exercised directly                     */
  /* ---------------------------------------------------------------------- */

  test('M3-17. the 0030 order index refuses a second live mutation for an order even when the application locks are bypassed', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const first = await rawIntent(a, { userId, profileId, orderId, status: 'submitting' });

      // B's insert must wait for A's outcome (unique index), then fail once A commits.
      let settled = false;
      const second = rawIntent(b, { userId, profileId, orderId, status: 'prepared' }).finally(() => { settled = true; });
      const blocked = await waitUntilBlocked(1, 'transactionid');
      assert.equal(blocked, 1, 'the second insert is blocked behind the first transaction');
      assert.equal(settled, false);
      await a.query('COMMIT');
      const error = await second.then(() => null, (e: unknown) => e);
      assert.ok(error, 'the second live mutation was refused');
      assert.equal(sqlState(error), '23505');
      assert.equal(constraintOf(error), 'execution_provider_intents_order_live_uniq');
      await b.query('ROLLBACK');

      // Legitimate transitions of the single live row never trip the index.
      await pool.query(
        `UPDATE execution_provider_intents
            SET status = 'confirmed', outcome = 'accepted', terminal_evidence = 'provider_response_verified', resolved_at = now()
          WHERE id = $1`,
        [first],
      );
      // A confirmed submit closes the order at the database level as well.
      await assert.rejects(
        () => rawIntent(pool, { userId, profileId, orderId, status: 'prepared' }),
        (e: unknown) => constraintOf(e) === 'execution_provider_intents_order_live_uniq',
      );
      // Resolved-as-rejected / absent rows leave the predicate: another order-bound row is accepted.
      const orderB = await makeOrder(userId, profileId);
      const absent = await rawIntent(pool, { userId, profileId, orderId: orderB, status: 'uncertain' });
      await assert.rejects(() => rawIntent(pool, { userId, profileId, orderId: orderB }), (e: unknown) => sqlState(e) === '23505');
      await pool.query(
        `UPDATE execution_provider_intents
            SET status = 'reconciled', outcome = NULL, terminal_evidence = 'operator_resolution', resolution = 'provider_absent',
                resolved_at = now(), reconciliation_state = 'resolved', reconciliation_required = false
          WHERE id = $1`,
        [absent],
      );
      await rawIntent(pool, { userId, profileId, orderId: orderB, status: 'submitting' });
      assert.equal(await unresolvedForOrder(profileId, orderB), 1);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });

  test('M3-17b. the 0030 lineage indexes refuse sibling retries and duplicated attempts at the database level', async () => {
    const { userId, profileId } = await makeAccount();
    const root = await rawIntent(pool, { userId, profileId, status: 'rejected' });
    const second = await rawIntent(pool, { userId, profileId, status: 'rejected', parentIntentId: root, rootIntentId: root, attempt: 2 });

    // A second child of the same parent.
    await assert.rejects(
      () => rawIntent(pool, { userId, profileId, status: 'prepared', parentIntentId: root, rootIntentId: root, attempt: 3 }),
      (e: unknown) => sqlState(e) === '23505' && constraintOf(e) === 'execution_provider_intents_parent_uniq',
    );
    // A duplicated attempt number inside the lineage (different parent).
    await assert.rejects(
      () => rawIntent(pool, { userId, profileId, status: 'prepared', parentIntentId: second, rootIntentId: root, attempt: 2 }),
      (e: unknown) => sqlState(e) === '23505' && constraintOf(e) === 'execution_provider_intents_lineage_attempt_uniq',
    );
    // The legitimate continuation is accepted.
    const third = await rawIntent(pool, { userId, profileId, status: 'prepared', parentIntentId: second, rootIntentId: root, attempt: 3 });
    assert.deepEqual(await retriesOf(second), [third]);

    // The ledger's own lineage read refuses such a lineage before the index is
    // ever reached (the index is the layer behind it — see M3-18).
    const { intentId: parentId } = await submitAs('reject', submitInput({ userId, profileId }));
    const sibling = await rawIntent(pool, { userId, profileId, status: 'rejected', parentIntentId: parentId, rootIntentId: parentId, attempt: 2 });
    assert.ok(sibling);
    await expectCode(
      ledger.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'stale_parent_intent',
    );
  });

  test('M3-18. if an application check were ever bypassed, the 0030 indexes still fail closed and the ledger reports them with the M3 vocabulary', async () => {
    const { userId, profileId } = await makeAccount();

    // Order invariant: the live-order read is stubbed to see nothing.
    const orderId = await makeOrder(userId, profileId);
    const { intentId: unresolved } = await submitAs('timeout', submitInput({ userId, profileId, orderId }));
    const blind = new ProviderMutationLedger(withFabricatedQuery(pool, ORDER_LIVE_CHECK, () => []));
    const viaIndex = await expectCode(blind.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');
    assert.equal(viaIndex.intentId, unresolved, 'the refusal still names the live mutation');
    assert.equal((await intentsForOrder(profileId, orderId)).length, 1);

    const acceptedOrder = await makeOrder(userId, profileId);
    await submitAs('accept', submitInput({ userId, profileId, orderId: acceptedOrder }));
    const blindAgain = new ProviderMutationLedger(withFabricatedQuery(pool, ORDER_LIVE_CHECK, () => []));
    await expectCode(blindAgain.prepareSubmit(submitInput({ userId, profileId, orderId: acceptedOrder })), 'duplicate_mutation');
    assert.equal((await intentsForOrder(profileId, acceptedOrder)).length, 1);

    // Parent invariant: the lineage read is stubbed to hide an existing retry.
    const { intentId: parentId } = await submitAs('reject', submitInput({ userId, profileId }));
    await rawIntent(pool, { userId, profileId, status: 'rejected', parentIntentId: parentId, rootIntentId: parentId, attempt: 2 });
    const hiding = new ProviderMutationLedger(withFabricatedQuery(pool, LINEAGE_READ, () => [
      { id: parentId, attempt: 1, status: 'rejected', supersededByIntentId: null },
    ]));
    await expectCode(
      hiding.prepareRetry(retryInput({ userId, profileId, parentIntentId: parentId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'parent_already_superseded',
    );
    assert.equal((await retriesOf(parentId)).length, 1, 'the index kept the lineage at one retry');
    assert.equal((await intentRow(parentId)).superseded_by_intent_id, null, 'the rolled-back retry never superseded the parent');

    // Lineage-attempt invariant: a (root, attempt) collision with a different parent.
    const { intentId: rootId } = await submitAs('reject', submitInput({ userId, profileId }));
    const { intentId: strayParent } = await submitAs('reject', submitInput({ userId, profileId }));
    await rawIntent(pool, { userId, profileId, status: 'rejected', parentIntentId: strayParent, rootIntentId: rootId, attempt: 2 });
    const hidingAttempt = new ProviderMutationLedger(withFabricatedQuery(pool, LINEAGE_READ, () => [
      { id: rootId, attempt: 1, status: 'rejected', supersededByIntentId: null },
    ]));
    await expectCode(
      hidingAttempt.prepareRetry(retryInput({ userId, profileId, parentIntentId: rootId, riskDecisionId: await makeRiskDecision(userId, profileId) })),
      'stale_parent_intent',
    );
    assert.deepEqual(await retriesOf(rootId), []);
    assert.equal((await intentRow(rootId)).superseded_by_intent_id, null);
  });

  test('M3-17c. legacy rows without a Gate 9 identity are outside the 0030 index but still block the ledger (fail closed)', async () => {
    const { userId, profileId } = await makeAccount();
    const orderId = await makeOrder(userId, profileId);
    const legacy = await rawIntent(pool, { userId, profileId, orderId, status: 'uncertain', legacy: true });
    assert.equal((await intentRow(legacy)).idempotency_key, null);

    // Upgrade safety: the partial index ignores the legacy row...
    const { rows } = await pool.query<{ indexed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM execution_provider_intents
          WHERE id = $1 AND order_id IS NOT NULL AND idempotency_key IS NOT NULL
            AND (status IN ('prepared','submitting','uncertain','confirmed') OR (status = 'reconciled' AND resolution = 'provider_accepted'))
       ) AS indexed`,
      [legacy],
    );
    assert.equal(rows[0]!.indexed, false);
    // ...but the application never treats a mutation of unknown provider state as absent.
    const error = await expectCode(ledger.prepareSubmit(submitInput({ userId, profileId, orderId })), 'unresolved_order_mutation');
    assert.equal(error.intentId, legacy);
    assert.equal(await countIntents(profileId), 1);
  });
});
