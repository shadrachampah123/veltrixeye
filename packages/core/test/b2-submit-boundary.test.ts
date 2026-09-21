/**
 * B2 — one authoritative provider-submit boundary, gated by Gate 9.
 *
 * These tests prove the production-facing submit architecture around the
 * existing Gate 9 `ProviderMutationLedger` and the Gate 9-gated MT5
 * provider. They run against a real embedded PostgreSQL, an injected Gate 9
 * ledger, a recording MT5 transport (test tool — never a broker) and the
 * canonical `DisabledMT5Transport`. No broker, network, credential or live
 * transport is used; nothing is touched in `apps/`, `migrations/` or any
 * Gate 9 core file.
 *
 * Architecture under test:
 *   - production MT5 providers are built ONLY by
 *     `createGate9MT5ExecutionProvider` (the legacy ungated factory remains
 *     for the inherited M8.4 test surface only); its bare `submitOrder`
 *     always refuses;
 *   - the canonical dispatcher `submitOrderThroughGate9` commits the durable
 *     Gate 9 intent, consumes the single-use SubmitBarrier (M2 CAS) and
 *     HANDS THE CONSUMED BARRIER to the provider through
 *     `submitOrderWithGate9Barrier(request, barrier)`;
 *   - the provider re-verifies the barrier against the DURABLE intent row
 *     (in-flight `submitting` state, `state_version = barrier.stateVersion+1`
 *     — i.e. exactly one consuming write per migration 0029) before any
 *     pre-flight, idempotency lookup, or transport contact.
 *
 * Required cases:
 *   A. Direct submit refuses — the production-shape gated provider refuses
 *      every bare `submitOrder` before any transport contact.
 *   A2. No silent ungated construction — the gated factory throws without a
 *      real Gate 9 ledger.
 *   A3. Legacy boundary stays available for the inherited M8.4 suite only.
 *   B. Prepare before provider — `prepareSubmit()` commits before the
 *      provider callback can execute.
 *   B2. Dispatcher hand-off — prepare → consume → provider receives the
 *      consumed barrier; the transport fires exactly once, only after the
 *      durable Gate 9 step.
 *   C. Replay refused — a spent barrier cannot invoke the provider again,
 *      and a canonical replay resolves as duplicate without a provider call.
 *   C2. Forged stateVersion refuses closed at the ledger CAS (M2).
 *   C3. Fabricated / never-consumed / mismatched barriers fail durable
 *      verification at the provider gate.
 *   D. The canonical dispatcher refuses non-Gate 9 providers before any
 *      durable write.
 *   E. Attribution: with a VALID in-flight barrier the call passes the Gate
 *      9 gate and fails at the documented disabled-transport surface —
 *      never mistaken for a Gate 9 refusal.
 *   E2. The canonical path against DisabledMT5Transport durably records
 *      uncertainty.
 *   F. Contract guards — the gated interface is present on the production
 *      boundary and absent from the legacy test boundary.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import {
  ExecutionProviderError,
  type ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations } from '../src/index.js';
import {
  createMT5ExecutionProvider,
  createGate9MT5ExecutionProvider,
  DisabledMT5Transport,
  hasGate9BarrierSubmit,
  submitOrderThroughGate9,
  ProviderMutationLedger,
  ProviderMutationError,
  type Gate9SubmitBarrierProvider,
  type MT5Transport,
  type MT5OrderRequest,
  type MT5OrderSnapshot,
  type MT5TransportHealth,
  type MT5AccountSnapshot,
  type MT5SymbolSnapshot,
  type SubmitBarrier,
  type SubmitIntentInput,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5472;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_b2_submit_boundary';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let ledger: ProviderMutationLedger;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-b2-submit-boundary');
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

const NOW = 1_700_000_000_000;
const CLIENT_ORDER_ID = `ve-${'a'.repeat(24)}`;
const uniqueEmail = () => `b2_${randomBytes(6).toString('hex')}@example.com`;
const newClientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;
const newIdempotencyKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');

async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'B2 Submit Boundary Tester') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}

async function makeProfile(userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,'paper','paper','paper','b2-acct',true,'connected')`,
    [id, userId],
  );
  return id;
}

async function makeAccount(): Promise<{ userId: string; profileId: string }> {
  const userId = await makeUser();
  return { userId, profileId: await makeProfile(userId) };
}

function submitInput(args: { userId: string; profileId: string; clientOrderId?: string; idempotencyKey?: string }): SubmitIntentInput {
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
    accountRef: 'b2-acct',
    credentialRef: 'cred-ref-b2',
    credentialFingerprint: createHash('sha256').update('b2-binding').digest('hex'),
    riskDecisionId: null,
    riskReservationId: null,
    symbol: 'EURUSD',
    direction: 'long',
    monetaryRisk: '25',
    riskExpiresAt: null,
  };
}

function makeRequest(): ExecutionSubmitOrderRequest {
  return {
    clientOrderId: CLIENT_ORDER_ID,
    idempotencyKey: 'a'.repeat(64),
    authorizationId: 'server-auth-b2',
    assetClass: 'commodity',
    symbol: 'XAUUSD',
    side: 'buy',
    orderType: 'market',
    quantity: 0.1,
    requestedPrice: null,
    stopLossPrice: 1990,
    takeProfitPrice: 2020,
  };
}

/** A valid MT5-shaped request whose identity matches the Gate 9 intent. */
function requestFor(input: SubmitIntentInput): ExecutionSubmitOrderRequest {
  return {
    ...makeRequest(),
    clientOrderId: input.clientOrderId,
    idempotencyKey: input.idempotencyKey,
  };
}

/** The demo configuration used with the recording transport (M8.4-valid). */
function demoConfig() {
  return {
    enabled: true,
    environment: 'demo' as const,
    broker: 'Example MT5 Broker',
    server: 'Example-Demo',
    accountRef: 'masked-account',
    symbols: new Map([['XAUUSD', 'XAUUSDm']]),
    now: () => NOW,
  };
}

/** The exact production MT5 configuration (deliberately disabled). */
function productionConfig() {
  return {
    enabled: false,
    environment: 'demo' as const,
    broker: null,
    server: null,
    accountRef: null,
    symbols: new Map(),
    now: () => NOW,
  };
}

/* -------------------------------------------------------------------------- */
/* Recording MT5 transport (test tool — never a broker)                        */
/* -------------------------------------------------------------------------- */

class RecordingMT5Transport implements MT5Transport {
  readonly configured = true;
  public readonly submitted: MT5OrderRequest[] = [];
  public readonly findOrderCalls: string[] = [];
  public readonly symbolCalls: string[] = [];
  public submitError: Error | null = null;
  /** Optional probe invoked at the moment the provider mutation fires. */
  public onSubmit: ((order: MT5OrderRequest) => Promise<void>) | null = null;
  public readonly symbolRow: MT5SymbolSnapshot = {
    symbol: 'XAUUSDm',
    assetClass: 'commodity',
    bid: 1999.9,
    ask: 2000.1,
    quoteTimestampMs: NOW,
    contractSize: 100,
    volumeMin: 0.01,
    volumeMax: 10,
    volumeStep: 0.01,
    digits: 2,
    tickSize: 0.01,
    orderTypes: ['market', 'limit'],
    tradeMode: 'open',
  };

  async health(): Promise<MT5TransportHealth> {
    return { configured: true, authenticated: true, connected: true, healthy: true };
  }
  async account(): Promise<MT5AccountSnapshot> {
    return { login: 'masked-account', broker: 'Example MT5 Broker', server: 'Example-Demo', currency: 'USD', balance: 10000 };
  }
  async symbol(symbol: string): Promise<MT5SymbolSnapshot | null> {
    this.symbolCalls.push(symbol);
    return symbol === this.symbolRow.symbol ? this.symbolRow : null;
  }
  async submitOrder(order: MT5OrderRequest): Promise<MT5OrderSnapshot> {
    if (this.onSubmit) await this.onSubmit(order);
    this.submitted.push(order);
    if (this.submitError) throw this.submitError;
    return {
      ticket: `record-${this.submitted.length}`,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      status: 'accepted',
      volume: order.volume,
      timestampMs: NOW,
    };
  }
  async findOrderByClientId(clientOrderId: string): Promise<MT5OrderSnapshot | null> {
    this.findOrderCalls.push(clientOrderId);
    return null;
  }
  async cancelOrder(): Promise<void> {}
  async modifyOrder(): Promise<void> {}
  async order(): Promise<MT5OrderSnapshot | null> { return null; }
  async orders(): Promise<MT5OrderSnapshot[]> { return []; }
  async position(): Promise<MT5PositionSnapshot | null> { return null; }
  async positions(): Promise<MT5PositionSnapshot[]> { return []; }
  async closePosition(): Promise<void> {}
}

interface MT5PositionSnapshot {
  ticket: string;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  priceOpen: number;
  stopLoss?: number;
  takeProfit?: number;
  profit?: number;
}

const isGate9Refusal = (e: unknown): boolean =>
  e instanceof ExecutionProviderError && e.category === 'unavailable' && /Gate 9 submit barrier/i.test(e.message);

/* -------------------------------------------------------------------------- */
/* B2 — single canonical provider-submit boundary                              */
/* -------------------------------------------------------------------------- */

describe('B2 — single canonical provider-submit boundary', () => {
  test('A. the production-shape gated provider refuses every direct submitOrder before any transport contact', async () => {
    const transport = new RecordingMT5Transport();
    const provider = createGate9MT5ExecutionProvider(transport, demoConfig(), { ledger });

    // A perfectly valid request — but no consumed Gate 9 barrier can ever
    // accompany a bare submitOrder call. Refused BEFORE identity, BEFORE
    // readiness, BEFORE the symbol lookup, BEFORE the idempotency lookup,
    // BEFORE the transport.
    await assert.rejects(() => provider.submitOrder(makeRequest()), isGate9Refusal);
    assert.equal(transport.submitted.length, 0, 'no transport call may reach submitOrder');
    assert.equal(transport.symbolCalls.length, 0, 'no pre-flight transport call may happen');
    assert.equal(transport.findOrderCalls.length, 0, 'no idempotency transport lookup may happen');

    // Even a second attempt with a different identity cannot get through.
    await assert.rejects(
      () => provider.submitOrder({ ...makeRequest(), clientOrderId: newClientOrderId() }),
      isGate9Refusal,
    );
    assert.equal(transport.submitted.length, 0);
  });

  test('A2. the gated factory cannot silently construct an ungated provider', async () => {
    const transport = new RecordingMT5Transport();
    // Missing binding entirely.
    assert.throws(
      () => createGate9MT5ExecutionProvider(transport, demoConfig(), undefined as unknown as { ledger: ProviderMutationLedger }),
      TypeError,
    );
    // Empty binding.
    assert.throws(
      () => createGate9MT5ExecutionProvider(transport, demoConfig(), {} as { ledger: ProviderMutationLedger }),
      TypeError,
    );
    // A fabricated "ledger" without the durable read API.
    assert.throws(
      () => createGate9MT5ExecutionProvider(transport, demoConfig(), { ledger: {} as unknown as ProviderMutationLedger }),
      TypeError,
    );
  });

  test('A3. the legacy ungated factory stays available for the inherited M8.4 suite (not used by production)', async () => {
    const transport = new RecordingMT5Transport();
    const provider = createMT5ExecutionProvider(transport, demoConfig());
    const result = await provider.submitOrder(makeRequest());
    assert.equal(result.status, 'accepted');
    assert.equal(transport.submitted.length, 1, 'legacy behaviour preserved for the M8.4 test surface');
    assert.equal(hasGate9BarrierSubmit(provider), false, 'the legacy boundary exposes no Gate 9 hand-off');
  });

  test('B. prepareSubmit commits before the provider callback runs (canonical dispatcher semantics)', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });

    let providerSawBarrier = false;
    let providerSawIntent = false;
    const fakeProviderCall = async (barrier: SubmitBarrier) => {
      providerSawBarrier = barrier.providerCallPermitted === true;
      const { rows } = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM execution_provider_intents WHERE id = $1`,
        [barrier.intentId],
      );
      providerSawIntent = rows.length === 1 && rows[0]!.status === 'submitting';
      return {
        clientOrderId: barrier.clientOrderId,
        idempotencyKey: barrier.idempotencyKey,
        accountRef: barrier.accountRef,
        providerOrderId: `sim-${createHash('sha256').update(barrier.clientOrderId).digest('hex').slice(0, 32)}`,
        status: 'accepted',
      };
    };

    const result = await ledger.executeSubmit(
      await (async () => {
        const prepared = await ledger.prepareSubmit(input);
        assert.equal(prepared.kind, 'authorized');
        if (prepared.kind !== 'authorized') throw new Error('not authorized');
        return prepared.barrier;
      })(),
      fakeProviderCall,
    );

    assert.equal(result.outcome, 'accepted');
    assert.equal(result.intentState, 'confirmed');
    assert.equal(providerSawBarrier, true, 'provider saw a Gate 9 barrier with providerCallPermitted=true');
    assert.equal(providerSawIntent, true, 'provider saw a committed intent row in `submitting` state');
  });

  test('B2. the canonical dispatcher hands the consumed Gate 9 barrier to the gated provider in one coherent call', async () => {
    const { userId, profileId } = await makeAccount();
    const transport = new RecordingMT5Transport();
    const provider = createGate9MT5ExecutionProvider(transport, demoConfig(), { ledger });

    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'canonical-b2-auth',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    // At the exact moment the provider mutation fires, the durable Gate 9
    // step must already be committed: the intent row exists in the in-flight
    // `submitting` state.
    let statusAtMutation: string | null = null;
    transport.onSubmit = async () => {
      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM execution_provider_intents WHERE client_order_id = $1`,
        [request.clientOrderId],
      );
      statusAtMutation = rows[0]?.status ?? null;
    };

    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      credentialRef: 'cred-ref-b2',
      credentialFingerprint: createHash('sha256').update('b2-binding').digest('hex'),
      request,
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('expected canonical dispatch to succeed');
    assert.equal(result.kind, 'submitted');
    assert.equal(result.providerOutcome.status, 'accepted');
    assert.ok(result.result.providerCalled, 'the provider function was invoked once');
    assert.equal(result.result.intentState, 'confirmed');
    assert.equal(result.result.outcome, 'accepted');
    assert.equal(result.result.evidence, 'provider_response_verified');

    // The provider mutation happened exactly once, and only AFTER the
    // durable Gate 9 step (the barrier hand-off worked: durable verification
    // passed and the M8.4 pre-flight reached the transport).
    assert.equal(transport.submitted.length, 1, 'the transport fired exactly once');
    assert.equal(statusAtMutation, 'submitting', 'no provider mutation before the durable Gate 9 commit');

    // The intent and reservation are durably committed.
    const { rows: intents } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM execution_provider_intents WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.status, 'confirmed');
    const { rows: reservations } = await pool.query<{ intent_id: string; state: string }>(
      `SELECT intent_id, state FROM execution_provider_mutation_reservations WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]!.state, 'known_completed');
  });

  test('C. a spent barrier is durably refused on replay and a canonical replay resolves as duplicate', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const transport = new RecordingMT5Transport();
    const provider = createGate9MT5ExecutionProvider(transport, demoConfig(), { ledger });
    const request = requestFor(input);

    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    if (prepared.kind !== 'authorized') throw new Error('not authorized');

    // The canonical hand-off (exactly what the dispatcher does): the
    // provider receives the consumed barrier; durable verification passes.
    let spentBarrier: SubmitBarrier | null = null;
    const exec = await ledger.executeSubmit(prepared.barrier, async (barrier) => {
      spentBarrier = barrier;
      const outcome = await provider.submitOrderWithGate9Barrier(request, barrier);
      return {
        clientOrderId: request.clientOrderId,
        idempotencyKey: request.idempotencyKey,
        accountRef: input.accountRef,
        providerOrderId: outcome.providerOrderId,
        status: outcome.status,
      };
    });
    assert.equal(exec.outcome, 'accepted');
    assert.equal(transport.submitted.length, 1, 'the first call reached the transport exactly once');

    // Replay the same barrier object: the outcome is durably applied (the
    // intent left `submitting`), so the provider gate refuses BEFORE any
    // transport contact. The Gate 9 single-use guarantee holds at the
    // provider, not just at the ledger.
    assert.ok(spentBarrier);
    await assert.rejects(
      () => provider.submitOrderWithGate9Barrier(request, spentBarrier!),
      isGate9Refusal,
    );
    assert.equal(transport.submitted.length, 1, 'no second provider mutation on barrier replay');
    assert.equal(transport.symbolCalls.length, 1, 'no additional pre-flight on replay');

    // A canonical replay with the same identity resolves as duplicate: the
    // provider is never invoked a second time.
    const replay = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'paper',
      environment: 'paper',
      accountRef: 'b2-acct',
      request: {
        clientOrderId: input.clientOrderId,
        idempotencyKey: input.idempotencyKey,
        authorizationId: 'canonical-b2-c',
        assetClass: 'commodity',
        symbol: 'EURUSD',
        side: 'buy',
        orderType: 'market',
        quantity: 0.1,
        requestedPrice: null,
        stopLossPrice: 1.095,
        takeProfitPrice: 1.11,
      },
    });
    assert.equal(replay.status, 'ok');
    if (replay.status !== 'ok') throw new Error('expected duplicate resolution to succeed');
    assert.equal(replay.kind, 'duplicate', 'a duplicate identity resolves onto the existing intent');
    assert.equal(replay.result.providerCalled, false, 'the duplicate path never invokes the provider');
    assert.equal(transport.submitted.length, 1, 'the provider mutation count never grew on replay');
  });

  test('C2. a stale barrier (forged stateVersion) refuses closed at the ledger CAS', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const barrier = await (async () => {
      const prepared = await ledger.prepareSubmit(input);
      if (prepared.kind !== 'authorized') throw new Error('not authorized');
      return prepared.barrier;
    })();

    const forged: SubmitBarrier = { ...barrier, stateVersion: barrier.stateVersion + 99 };
    await assert.rejects(
      () => ledger.executeSubmit(forged, async () => {
        throw new Error('the provider must NEVER be invoked with a forged barrier');
      }),
      (e: unknown) => e instanceof ProviderMutationError && e.code === 'barrier_not_consumable',
    );

    const intent = await pool.query<{ status: string }>(
      `SELECT status FROM execution_provider_intents WHERE id = $1`,
      [barrier.intentId],
    );
    assert.equal(intent.rows[0]!.status, 'submitting', 'durable state unchanged on a forged CAS');
  });

  test('C3. fabricated, never-consumed and mismatched barriers fail durable verification at the provider gate', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const transport = new RecordingMT5Transport();
    const provider = createGate9MT5ExecutionProvider(transport, demoConfig(), { ledger });
    const request = requestFor(input);

    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    if (prepared.kind !== 'authorized') throw new Error('not authorized');

    // (i) A REAL barrier that was prepared but never consumed: the
    // single-use version advance never happened, so durable verification
    // refuses (a barrier that exists is not a barrier that was consumed).
    await assert.rejects(
      () => provider.submitOrderWithGate9Barrier(request, prepared.barrier),
      isGate9Refusal,
    );

    // (ii) A fabricated identity: no durable row, no authorization.
    const fabricated: SubmitBarrier = { ...prepared.barrier, intentId: randomUUID() };
    await assert.rejects(
      () => provider.submitOrderWithGate9Barrier(request, fabricated),
      isGate9Refusal,
    );

    // (iii) A tampered stateVersion that pretends a consumption the ledger
    // never committed.
    const tampered: SubmitBarrier = { ...prepared.barrier, stateVersion: prepared.barrier.stateVersion + 1 };
    await assert.rejects(
      () => provider.submitOrderWithGate9Barrier(request, tampered),
      isGate9Refusal,
    );

    // (iv) A barrier minted for one identity presented with another.
    await assert.rejects(
      () => provider.submitOrderWithGate9Barrier(
        { ...request, clientOrderId: newClientOrderId(), idempotencyKey: newIdempotencyKey() },
        prepared.barrier,
      ),
      isGate9Refusal,
    );

    assert.equal(transport.submitted.length, 0, 'no fabricated barrier ever reached the transport');
    assert.equal(transport.symbolCalls.length, 0, 'no pre-flight transport call happened');
    assert.equal(transport.findOrderCalls.length, 0, 'no idempotency lookup happened');
  });

  test('D. the canonical dispatcher refuses a non-Gate 9 provider before any durable write', async () => {
    const { userId, profileId } = await makeAccount();
    const legacy = createMT5ExecutionProvider(new RecordingMT5Transport(), demoConfig());

    const countIntents = async () => {
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM execution_provider_intents`);
      return Number(rows[0]!.n);
    };
    const beforeCount = await countIntents();

    const result = await submitOrderThroughGate9({
      ledger,
      provider: legacy as unknown as Gate9SubmitBarrierProvider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      request: { ...makeRequest(), clientOrderId: newClientOrderId(), idempotencyKey: newIdempotencyKey() },
    });

    assert.equal(result.status, 'error');
    if (result.status !== 'error') throw new Error('expected the dispatcher to refuse a non-gated provider');
    assert.equal(result.kind, 'validation');
    assert.equal(await countIntents(), beforeCount, 'no durable Gate 9 write happens for a non-gated provider');
  });

  test('E. with a valid in-flight barrier the refusal is the disabled transport — never the Gate 9 gate', async () => {
    // Production-faithful configuration: the exact disabled MT5 transport
    // and the exact disabled provider config from apps/api. The Gate 9
    // barrier is genuinely consumed and in-flight, so the ONLY thing that
    // may refuse the mutation is the documented M8.4 fail-closed surface.
    const provider = createGate9MT5ExecutionProvider(new DisabledMT5Transport(), productionConfig(), { ledger });

    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    if (prepared.kind !== 'authorized') throw new Error('not authorized');
    const request = requestFor(input);

    let observed: unknown = null;
    const exec = await ledger.executeSubmit(prepared.barrier, async (barrier) => {
      try {
        const outcome = await provider.submitOrderWithGate9Barrier(request, barrier);
        return {
          clientOrderId: request.clientOrderId,
          idempotencyKey: request.idempotencyKey,
          accountRef: input.accountRef,
          providerOrderId: outcome.providerOrderId,
          status: outcome.status,
        };
      } catch (error) {
        observed = error;
        throw error;
      }
    });

    // The call went THROUGH the Gate 9 gate (durable verification passed)
    // and failed at the provider's disabled readiness gate — the refusal
    // message is the M8.4 surface, attributed correctly and durably.
    assert.ok(observed instanceof ExecutionProviderError, 'the provider refused');
    assert.equal((observed as ExecutionProviderError).category, 'unavailable');
    assert.equal((observed as ExecutionProviderError).message, 'MT5 provider is disabled');
    assert.doesNotMatch((observed as ExecutionProviderError).message, /Gate 9/, 'attribution: this is the disabled transport, not a Gate 9 refusal');
    assert.equal(exec.outcome, 'uncertain', 'an unavailable provider is durably uncertain — never laundered');
    assert.equal(exec.providerCalled, true, 'the provider call itself ran after the Gate 9 gate passed');

    // The health surface remains the documented fail-closed one.
    const health = await provider.health();
    assert.equal(health.healthy, false);
    assert.equal(health.available, false);
  });

  test('E2. the canonical path with DisabledMT5Transport durably records uncertainty', async () => {
    const provider = createGate9MT5ExecutionProvider(new DisabledMT5Transport(), productionConfig(), { ledger });

    const { userId, profileId } = await makeAccount();
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'disabled-b2-f',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const canonical = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'b2-acct',
      credentialRef: 'cred-ref-b2',
      credentialFingerprint: createHash('sha256').update('b2-binding').digest('hex'),
      request,
    });

    assert.equal(canonical.status, 'ok');
    if (canonical.status !== 'ok') throw new Error('canonical dispatch returned an error');
    assert.equal(canonical.kind, 'submitted');
    assert.equal(canonical.result.providerCalled, true, 'the barrier hand-off reached the provider');
    assert.equal(canonical.result.outcome, 'uncertain');
    assert.equal(canonical.result.intentState, 'uncertain');
    assert.equal(canonical.result.requiresReconciliation, true);

    // Durable uncertainty is visible in the Gate 9 store.
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM execution_provider_intents WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'uncertain', 'the disabled transport never reports ready; uncertainty is durable');

    const health = await provider.health();
    assert.equal(health.healthy, false);
    assert.equal(health.available, false);
  });

  test('F. contract guards: the gated interface exists on the production boundary, not on the legacy one', () => {
    assert.equal(typeof createMT5ExecutionProvider, 'function');
    assert.equal(typeof createGate9MT5ExecutionProvider, 'function');
    assert.equal(typeof submitOrderThroughGate9, 'function');
    assert.equal(typeof ProviderMutationLedger, 'function');

    const gated = createGate9MT5ExecutionProvider(new DisabledMT5Transport(), productionConfig(), { ledger });
    assert.equal(hasGate9BarrierSubmit(gated), true, 'the production boundary accepts the Gate 9 barrier hand-off');
    const legacy = createMT5ExecutionProvider(new DisabledMT5Transport(), productionConfig());
    assert.equal(hasGate9BarrierSubmit(legacy), false, 'the legacy test boundary cannot be mistaken for the production one');
  });
});
