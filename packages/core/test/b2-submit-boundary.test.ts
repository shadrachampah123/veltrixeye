/**
 * B2 — establish one authoritative provider-submit boundary.
 *
 * These tests prove the canonical submit boundary around the existing Gate 9
 * `ProviderMutationLedger` and the existing `MT5Provider.submitOrder` legacy
 * boundary. They run against a real embedded PostgreSQL, an injected Gate 9
 * ledger, the documented Fake Bridge (deterministic fake provider) and the
 * canonical `DisabledMT5Transport`. No broker, network, credential or live
 * transport is used; `apps/` production composition is exercised separately
 * (the api suite boots the real app).
 *
 * Required cases:
 *   A.  Gate 9 required — provider submission cannot occur without a Gate 9
 *       `SubmitBarrier`. The legacy `MT5Provider.submitOrder` refuses BEFORE
 *       any transport call when the gate9 predicate is supplied and returns
 *       null (or throws — A2).
 *   A3. Backward compatibility — without a gate9 predicate the legacy
 *       boundary behaves exactly as documented (no boundary change for
 *       compositions that have not wired the handoff yet).
 *   B.  Prepare before provider — `prepareSubmit()` commits before the
 *       provider callback can execute.
 *   B2. The canonical dispatcher wires prepare → barrier → execute → provider
 *       in one call; durable state is committed; the projected outcome carries
 *       the REAL provider order id, never an internal intent id.
 *   C.  F1 INVARIANT (replay) — first mutation consumes its barrier through
 *       the canonical dispatcher; a SECOND, DIFFERENT mutation (same client
 *       order identity, fresh idempotency key, different body) and a REPLAY
 *       of the first identity must both be refused by the legacy boundary
 *       BEFORE any transport call.
 *   C2. A forged stateVersion refuses closed at the ledger; the legacy
 *       boundary is never reached.
 *   C3. F1 (forgery through the legacy gate) — a real, already-consumed
 *       barrier presented by a permissive predicate for a DIFFERENT mutation
 *       (different identity, or same identity with a different body) is
 *       refused at the gate's identity re-verification, before transport.
 *   D.  Direct bypass blocked — with a refusing predicate the legacy path
 *       cannot reach `transport.submitOrder` at all.
 *   E.  Disabled transport preserved — the canonical path with
 *       `DisabledMT5Transport` fails closed at the documented readiness
 *       surface and durably records `uncertain` — never `accepted`.
 *   E2. The same with an all-null MT5 configuration (no broker/server/account
 *       declared — the binding check must pass for null-equal bindings).
 *   E3. F5 — the test seam deterministically REACHES
 *       `DisabledMT5Transport.submitOrder()` (the readiness gate is healthy
 *       here); the disabled transport itself refuses, and no real external
 *       provider/network call can occur (the delegate is the real
 *       `DisabledMT5Transport`, whose only behavior is to throw).
 *   F.  Existing M8.4 boundary tests still pass: the barrier check is purely
 *       additive (the rest of the suite covers the regression baseline).
 *   F2a. F2 (mutation window) — the request is mutated in-process AFTER the
 *       canonical hash is computed and BEFORE the provider call: the provider
 *       must still receive the ORIGINAL frozen values, and the durable
 *       request hash must cover the original request.
 *   F2b. F2 (provider identity) — the injected provider's declared `id`
 *       differs from the authorization's `providerSlug`: refused before
 *       persistence, provider never called.
 *   F2c. F2 (account binding) — the provider declares a different
 *       `accountRef` than the authorization: refused before persistence.
 *   F2d. F2 (broker/server binding) — the provider declares a different
 *       broker `server` than the authorization's `brokerServerRef` (in both
 *       directions): refused before persistence.
 *   F3a. F3 (uncertainty) — a provider call whose outcome cannot be
 *       established is NEVER projected as accepted: the result is an explicit
 *       `provider_uncertain` error and the intent is durably `uncertain`.
 *   F3b. F3 (duplicate uncertainty) — a duplicate request resolving onto an
 *       `uncertain` intent is NEVER projected as accepted (or rejected):
 *       explicit `duplicate_unresolved`, provider not re-invoked.
 *   F3c. F3 (duplicate acceptance) — a duplicate resolving onto a `confirmed`
 *       intent projects the REAL provider order id from the durable receipt
 *       (never the internal intent id).
 *   F3d. F3 (rejection without ticket) — a provider rejection that produced
 *       no ticket projects `rejected` with `providerOrderId: null` — an
 *       internal id is never substituted.
 *   F3e. F3 (fail-safe) — a duplicate resolving onto a `confirmed` intent
 *       whose durable ticket is missing (a durable state anomaly the ledger
 *       cannot produce) is NEVER projected as a ticket-less acceptance:
 *       explicit `duplicate_unresolved`.
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
  type ExecutionProvider,
  type ExecutionSubmitOrderOutcome,
  type ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations } from '../src/index.js';
import {
  createMT5ExecutionProvider,
  createPaperExecutionProvider,
  createSubmitBarrierHandoff,
  DisabledMT5Transport,
  submitOrderThroughGate9,
  ProviderMutationLedger,
  type MT5AccountSnapshot,
  type MT5OrderRequest,
  type MT5OrderSnapshot,
  type MT5PositionSnapshot,
  type MT5SymbolSnapshot,
  type MT5Transport,
  type MT5TransportHealth,
  ProviderMutationError,
  type SubmitBarrier,
  type SubmitIntentInput,
} from '../src/index.js';
import { canonicalMutationRequestHash } from '../src/execution/provider-mutations.js';

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

/** The MT5 provider configuration used by the gated MT5 tests. */
const MT5_CONFIG = {
  enabled: true,
  environment: 'demo' as const,
  broker: 'Example MT5 Broker',
  server: 'Example-Demo',
  accountRef: 'masked-account',
  symbols: new Map([['XAUUSD', 'XAUUSDm']]),
  now: () => NOW,
};

const CRED_REF = 'cred-ref-b2';
const CRED_FINGERPRINT = () => createHash('sha256').update('b2-binding').digest('hex');

/* -------------------------------------------------------------------------- */
/* Recording MT5 transport (test tool — never a broker)                        */
/* -------------------------------------------------------------------------- */

class RecordingMT5Transport implements MT5Transport {
  readonly configured = true;
  public readonly submitted: MT5OrderRequest[] = [];
  public readonly findOrderCalls: string[] = [];
  public readonly symbolCalls: string[] = [];
  public submitError: Error | null = null;
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
  async cancelOrder(_ticket: string): Promise<void> {}
  async modifyOrder(_ticket: string, _changes: { stopLoss?: number | null; takeProfit?: number | null }): Promise<void> {}
  async order(_ticket: string): Promise<MT5OrderSnapshot | null> { return null; }
  async orders(): Promise<MT5OrderSnapshot[]> { return []; }
  async position(_ticket: string): Promise<MT5PositionSnapshot | null> { return null; }
  async positions(): Promise<MT5PositionSnapshot[]> { return []; }
  async closePosition(_ticket: string): Promise<void> {}
}

/* -------------------------------------------------------------------------- */
/* F5 seam — healthy pre-flight, REAL DisabledMT5Transport as the delegate     */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic test seam for E3: everything BEFORE `submitOrder` is served
 * from in-memory, no-I/O data (healthy health, a fresh deterministic symbol
 * row, an empty idempotency lookup) so the provider's pre-flight passes and
 * the flow REACHES `submitOrder`. `submitOrder` itself is delegated to the
 * REAL `DisabledMT5Transport` instance and counted: the only possible
 * "transport call" in this whole test is the disabled transport's own
 * fail-closed refusal. No network, no broker, no SDK — by construction.
 */
class DisabledTransportSeam implements MT5Transport {
  readonly configured = true;
  readonly delegate = new DisabledMT5Transport();
  submitOrderCalls = 0;
  private readonly symbolRow: MT5SymbolSnapshot = {
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
    return { login: 'seam-account', broker: 'Example MT5 Broker', server: 'Example-Demo', currency: 'USD', balance: 0 };
  }
  async symbol(symbol: string): Promise<MT5SymbolSnapshot | null> {
    return symbol === this.symbolRow.symbol ? this.symbolRow : null;
  }
  async submitOrder(order: MT5OrderRequest): Promise<MT5OrderSnapshot> {
    this.submitOrderCalls++;
    // The real DisabledMT5Transport.submitOrder() takes no arguments and
    // refuses unconditionally — no broker communication is attempted.
    void order;
    return this.delegate.submitOrder();
  }
  async findOrderByClientId(): Promise<MT5OrderSnapshot | null> {
    return null;
  }
  async cancelOrder(_ticket: string): Promise<void> {}
  async modifyOrder(_ticket: string, _changes: { stopLoss?: number | null; takeProfit?: number | null }): Promise<void> {}
  async order(_ticket: string): Promise<MT5OrderSnapshot | null> { return null; }
  async orders(): Promise<MT5OrderSnapshot[]> { return []; }
  async position(_ticket: string): Promise<MT5PositionSnapshot | null> { return null; }
  async positions(): Promise<MT5PositionSnapshot[]> { return []; }
  async closePosition(_ticket: string): Promise<void> {}
}

/* -------------------------------------------------------------------------- */
/* Fake MT5 provider (test tool — no transport, configurable binding)          */
/* -------------------------------------------------------------------------- */

function createFakeMT5Provider(args: {
  onCall?: (req: ExecutionSubmitOrderRequest) => void;
  submit?: (req: ExecutionSubmitOrderRequest) => Promise<ExecutionSubmitOrderOutcome>;
  describeId?: string;
  describeEnvironment?: string;
  describeAccountRef?: string | null;
  describeServer?: string | null;
}): { provider: ExecutionProvider; state: { callCount: number; lastRequest: ExecutionSubmitOrderRequest | null } } {
  const state: { callCount: number; lastRequest: ExecutionSubmitOrderRequest | null } = { callCount: 0, lastRequest: null };
  const provider = {
    id: 'mt5',
    name: 'Fake MT5 (test tool — no transport)',
    capabilities: { modes: ['demo'], orderTypes: ['market', 'limit', 'stop'] },
    configured: true,
    describe(): Record<string, unknown> {
      // Mirrors the real MT5 provider's operator-safe describe surface, with
      // configurable binding values for the F2 mismatch tests.
      return {
        id: args.describeId ?? 'mt5',
        environment: args.describeEnvironment ?? 'demo',
        broker: MT5_CONFIG.broker,
        server: args.describeServer ?? 'Example-Demo',
        accountRef: args.describeAccountRef ?? 'masked-account',
        transportPolicy: 'external-management-required',
        liveExecutionAvailable: false,
      };
    },
    async submitOrder(req: ExecutionSubmitOrderRequest): Promise<ExecutionSubmitOrderOutcome> {
      state.callCount++;
      state.lastRequest = req;
      args.onCall?.(req);
      if (args.submit) return args.submit(req);
      return { providerOrderId: `fake-ticket-${state.callCount}`, status: 'accepted' };
    },
    async health() {
      return {
        configured: true,
        authenticated: true,
        connected: true,
        available: true,
        healthy: true,
        state: 'healthy',
        checkedAt: new Date(NOW).toISOString(),
      };
    },
    async getAccountInfo() { return null; },
    async getInstrument() { return null; },
    async listInstruments() { return []; },
    async cancelOrder() { /* no-op test tool */ },
    async modifyOrder() { /* no-op test tool */ },
    async getOrder() { return null; },
    async listOrders() { return []; },
    async getPosition() { return null; },
    async listPositions() { return []; },
    async closePosition() { /* no-op test tool */ },
  } as unknown as ExecutionProvider;
  return { provider, state };
}

/* -------------------------------------------------------------------------- */
/* B2 — single canonical provider-submit boundary                              */
/* -------------------------------------------------------------------------- */

describe('B2 — single canonical provider-submit boundary', () => {
  test('A. the legacy boundary refuses when no Gate 9 SubmitBarrier was presented', async () => {
    const transport = new RecordingMT5Transport();
    const provider = createMT5ExecutionProvider(transport, MT5_CONFIG, {
      gate9: { async consumeAuthorization() { return null; } },
    });

    // No barrier presented — the legacy boundary refuses BEFORE the
    // transport is reached. No transport submit, no symbol lookup, no
    // idempotency lookup.
    await assert.rejects(
      () => provider.submitOrder(makeRequest()),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable'
        && /Gate 9 submit barrier/i.test(e.message),
    );
    assert.equal(transport.submitted.length, 0, 'no transport call may reach submitOrder');
    assert.equal(transport.symbolCalls.length, 0, 'no pre-flight transport call may happen');
    assert.equal(transport.findOrderCalls.length, 0, 'no idempotency transport lookup may happen');
  });

  test('A2. the legacy boundary refuses when the gate9 predicate throws', async () => {
    const transport = new RecordingMT5Transport();
    const provider = createMT5ExecutionProvider(transport, MT5_CONFIG, {
      gate9: { async consumeAuthorization() { throw new Error('predicate failure'); } },
    });

    await assert.rejects(
      () => provider.submitOrder(makeRequest()),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable',
    );
    assert.equal(transport.submitted.length, 0);
  });

  test('A3. without a gate9 predicate, the legacy boundary continues to behave as documented', async () => {
    const transport = new RecordingMT5Transport();
    const provider = createMT5ExecutionProvider(transport, MT5_CONFIG); // no options → no Gate 9 predicate
    const result = await provider.submitOrder(makeRequest());
    assert.equal(result.status, 'accepted');
    assert.equal(transport.submitted.length, 1, 'legacy behaviour preserved when gate9 is absent');
  });

  test('B. prepareSubmit commits before the provider callback runs (canonical dispatcher)', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });

    // The fake provider call asserts that the durable intent row exists
    // BEFORE it executes — the committed barrier is the precondition.
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

    const prepared = await ledger.prepareSubmit(input);
    assert.equal(prepared.kind, 'authorized');
    if (prepared.kind !== 'authorized') throw new Error('not authorized');
    const result = await ledger.executeSubmit(prepared.barrier, fakeProviderCall);

    assert.equal(result.outcome, 'accepted');
    assert.equal(result.intentState, 'confirmed');
    assert.equal(providerSawBarrier, true, 'provider saw a Gate 9 barrier with providerCallPermitted=true');
    assert.equal(providerSawIntent, true, 'provider saw a committed intent row in `submitting` state');
  });

  test('B2. the canonical dispatcher wires prepare → barrier → execute → provider in one call', async () => {
    const { userId, profileId } = await makeAccount();
    // The paper provider is the currently-active provider; it never reaches a
    // transport. Paper declares no account and no broker server, so the
    // authorization binds exactly that (null-equal binding check).
    const paperProvider = createPaperExecutionProvider({
      simulator: {
        submitAuthorizedOrder: async () => ({
          providerOrderId: 'paper-b2',
          status: 'accepted' as const,
          filledQuantity: 0.1,
          averagePrice: 2000,
        }),
      },
    });

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

    const result = await submitOrderThroughGate9({
      ledger,
      provider: paperProvider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'paper',
      environment: 'paper',
      accountRef: null,
      brokerServerRef: null,
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('expected canonical dispatch to succeed');
    assert.equal(result.kind, 'submitted');
    assert.equal(result.providerOutcome.status, 'accepted');
    assert.equal(result.providerOutcome.providerOrderId, 'paper-b2', 'the projected order id is the REAL provider ticket, not an internal id');
    assert.ok(result.result.providerCalled, 'the provider function was invoked once');
    assert.equal(result.result.intentState, 'confirmed');
    assert.equal(result.result.outcome, 'accepted');
    assert.equal(result.result.evidence, 'provider_response_verified');

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

  test('C. F1 invariant — a consumed barrier authorizes exactly one mutation (replay refused before transport)', async () => {
    const transport = new RecordingMT5Transport();
    const handoff = createSubmitBarrierHandoff();
    const provider = createMT5ExecutionProvider(transport, MT5_CONFIG, { gate9: handoff.gate9 });

    const { userId, profileId } = await makeAccount();

    // --- First mutation (M1): the full canonical flow. The ledger consumes
    // the barrier; the handoff presents it to the legacy boundary exactly
    // once; the recording transport sees exactly one submit.
    const m1: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'canonical-b2-c',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };
    const first = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: MT5_CONFIG.accountRef,
      brokerServerRef: MT5_CONFIG.server,
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request: m1,
      handoff,
    });
    assert.equal(first.status, 'ok');
    if (first.status !== 'ok') throw new Error('expected canonical dispatch to succeed');
    assert.equal(first.kind, 'submitted');
    assert.equal(first.providerOutcome.status, 'accepted');
    assert.equal(transport.submitted.length, 1, 'the first mutation reached the transport exactly once');
    assert.equal(transport.submitted[0]!.clientOrderId, m1.clientOrderId);
    const { rows: intentRows } = await pool.query<{ status: string }>(
      `SELECT status FROM execution_provider_intents WHERE client_order_id = $1`,
      [m1.clientOrderId],
    );
    assert.equal(intentRows.length, 1);
    assert.equal(intentRows[0]!.status, 'confirmed');

    // --- SECOND, DIFFERENT mutation (M2): same durable client order
    // identity, FRESH idempotency key, DIFFERENT body. The barrier is already
    // spent; the handoff has nothing for this identity; the gate's identity
    // check would also refuse. The legacy boundary must refuse BEFORE any
    // transport interaction.
    const symbolCallsBefore = transport.symbolCalls.length;
    const findOrderCallsBefore = transport.findOrderCalls.length;
    const m2: ExecutionSubmitOrderRequest = {
      ...m1,
      idempotencyKey: newIdempotencyKey(),
      quantity: 0.25,
      authorizationId: 'canonical-b2-c-rogue',
    };
    await assert.rejects(
      () => provider.submitOrder(m2),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable'
        && /Gate 9 submit barrier/i.test(e.message),
      'the second, different mutation must be refused by the legacy gate',
    );
    assert.equal(transport.submitted.length, 1, 'the provider mutation count never grew on the second, different mutation');
    assert.equal(transport.symbolCalls.length, symbolCallsBefore, 'no pre-flight transport call for the refused mutation');
    assert.equal(transport.findOrderCalls.length, findOrderCallsBefore, 'no idempotency transport lookup for the refused mutation');
    const { rows: rogueIntents } = await pool.query<{ id: string }>(
      `SELECT id FROM execution_provider_intents WHERE client_order_id = $1 AND idempotency_key = $2`,
      [m2.clientOrderId, m2.idempotencyKey],
    );
    assert.equal(rogueIntents.length, 0, 'the refused mutation never reached the ledger either');

    // --- REPLAY of the first identity (M1 again, direct legacy call): the
    // one-shot presentation is already spent — refused before transport.
    await assert.rejects(
      () => provider.submitOrder(m1),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable'
        && /Gate 9 submit barrier/i.test(e.message),
      'a replay of the same identity must be refused: the barrier was already presented',
    );
    assert.equal(transport.submitted.length, 1, 'the replay never reached the transport');

    // The canonical dispatcher replaying the same identity resolves to the
    // durable intent as an idempotent duplicate — provider NOT re-invoked.
    const replay = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: MT5_CONFIG.accountRef,
      brokerServerRef: MT5_CONFIG.server,
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request: m1,
      handoff,
    });
    assert.equal(replay.status, 'ok');
    if (replay.status !== 'ok') throw new Error('expected duplicate resolution to succeed');
    assert.equal(replay.kind, 'duplicate', 'a duplicate identity resolves onto the existing intent');
    assert.equal(replay.result.providerCalled, false, 'the duplicate path never invokes the provider');
    assert.equal(transport.submitted.length, 1, 'the transport count is unchanged after the canonical replay');
  });

  test('C2. a stale barrier (forged stateVersion) refuses closed at the ledger, the legacy boundary is never reached', async () => {
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });
    const prepared = await ledger.prepareSubmit(input);
    if (prepared.kind !== 'authorized') throw new Error('not authorized');
    const barrier = prepared.barrier;

    // Forge a future stateVersion: the M2 single-use CAS must refuse it
    // before any provider call.
    const forged: SubmitBarrier = { ...barrier, stateVersion: barrier.stateVersion + 99 };
    let providerInvoked = false;
    await assert.rejects(
      () => ledger.executeSubmit(forged, async () => {
        providerInvoked = true;
        throw new Error('the provider must NEVER be invoked with a forged barrier');
      }),
      (e: unknown) => e instanceof ProviderMutationError && e.code === 'barrier_not_consumable',
    );
    assert.equal(providerInvoked, false, 'the provider function was never invoked');

    const intent = await pool.query<{ status: string }>(
      `SELECT status FROM execution_provider_intents WHERE id = $1`,
      [barrier.intentId],
    );
    assert.equal(intent.rows[0]!.status, 'submitting', 'durable state unchanged on a forged CAS');
  });

  test('C3. F1 forgery through the legacy gate — a consumed barrier for a different mutation is refused at the identity check', async () => {
    const transport = new RecordingMT5Transport();
    const { userId, profileId } = await makeAccount();
    const input = submitInput({ userId, profileId });

    // Consume a real barrier through the ledger (fake provider call — the
    // recording transport is NOT involved).
    const prepared = await ledger.prepareSubmit(input);
    if (prepared.kind !== 'authorized') throw new Error('not authorized');
    const barrier = prepared.barrier;
    const consumed = await ledger.executeSubmit(barrier, async (b) => ({
      clientOrderId: b.clientOrderId,
      idempotencyKey: b.idempotencyKey,
      accountRef: b.accountRef,
      providerOrderId: 'sim-b2-c3',
      status: 'accepted' as const,
    }));
    assert.equal(consumed.outcome, 'accepted', 'the barrier was durably consumed');

    // A permissive (rogue) predicate that returns this consumed barrier for
    // ANY request. The gate must still refuse — the barrier is not for the
    // presented mutation.
    const provider = createMT5ExecutionProvider(transport, MT5_CONFIG, {
      gate9: { async consumeAuthorization() { return barrier; } },
    });

    // (1) Different mutation identity (different client order + idempotency).
    const otherIdentity: ExecutionSubmitOrderRequest = {
      ...makeRequest(),
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
    };
    await assert.rejects(
      () => provider.submitOrder(otherIdentity),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable'
        && /does not match this mutation identity/i.test(e.message),
      'a barrier for a different mutation identity must be refused',
    );
    assert.equal(transport.submitted.length, 0);

    // (2) Same identity, DIFFERENT body (different canonical request hash).
    const sameIdentityDifferentBody: ExecutionSubmitOrderRequest = {
      clientOrderId: barrier.clientOrderId,
      idempotencyKey: barrier.idempotencyKey,
      authorizationId: 'server-auth-b2',
      assetClass: 'commodity',
      symbol: 'EURUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.25,
      requestedPrice: null,
      stopLossPrice: 1.09,
      takeProfitPrice: 1.11,
    };
    await assert.rejects(
      () => provider.submitOrder(sameIdentityDifferentBody),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable'
        && /does not match this request/i.test(e.message),
      'a barrier whose request hash does not match the presented body must be refused',
    );
    assert.equal(transport.submitted.length, 0, 'the forgery never reached the transport');
  });

  test('D. the legacy competing submit path cannot independently reach a provider without a Gate 9 barrier', async () => {
    const transport = new RecordingMT5Transport();
    // Composition-level refusal: the predicate returns null when no barrier
    // has been presented through the canonical dispatcher.
    const provider = createMT5ExecutionProvider(transport, MT5_CONFIG, {
      gate9: { async consumeAuthorization() { return null; } },
    });

    await assert.rejects(
      () => provider.submitOrder(makeRequest()),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable',
    );

    // No transport submitOrder call is permitted.
    assert.equal(transport.submitted.length, 0, 'the legacy path cannot reach transport.submitOrder');

    // No pre-flight transport interaction either (the predicate is consulted
    // before identity, before readiness, before the symbol lookup).
    assert.equal(transport.symbolCalls.length, 0);
    assert.equal(transport.findOrderCalls.length, 0);

    // Even a SECOND attempt with a different request body cannot reach the
    // transport until a Gate 9 barrier is presented.
    await assert.rejects(
      () => provider.submitOrder({ ...makeRequest(), clientOrderId: `ve-${'b'.repeat(24)}` }),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable',
    );
    assert.equal(transport.submitted.length, 0);
  });

  test('E. the canonical path with DisabledMT5Transport fails closed and durably records uncertainty', async () => {
    // The MT5 production transport is DisabledMT5Transport today (no
    // broker, no SDK, no network). Even with a properly consumed barrier
    // presented through the handoff, the provider's readiness gate refuses
    // (the documented M8.4 fail-closed surface) and the ledger durably
    // records the unknown outcome as `uncertain` — never `accepted`.
    const transport = new DisabledMT5Transport();
    const handoff = createSubmitBarrierHandoff();
    const provider = createMT5ExecutionProvider(transport, MT5_CONFIG, { gate9: handoff.gate9 });

    const { userId, profileId } = await makeAccount();
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: `ve-${'e'.repeat(24)}`,
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'disabled-b2',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: MT5_CONFIG.accountRef,
      brokerServerRef: MT5_CONFIG.server,
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
      handoff,
    });

    // F3: uncertainty is an explicit error — it is never an acceptance.
    assert.equal(result.status, 'error');
    if (result.status !== 'error') throw new Error('expected the disabled-transport flow to fail closed');
    assert.equal(result.kind, 'provider_uncertain');
    assert.ok(!('providerOutcome' in result), 'an uncertain outcome carries no projected acceptance');
    assert.equal(result.result.outcome, 'uncertain');
    assert.equal(result.result.intentState, 'uncertain');
    assert.equal(result.result.requiresReconciliation, true);
    assert.ok(result.result.providerCalled, 'the provider call happened; its outcome is durably unknown');

    // Durable state: the intent and reservation are `uncertain`.
    const { rows: intents } = await pool.query<{ status: string }>(
      `SELECT status FROM execution_provider_intents WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.status, 'uncertain');
    const { rows: reservations } = await pool.query<{ state: string }>(
      `SELECT state FROM execution_provider_mutation_reservations WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]!.state, 'uncertain');

    // The disabled transport's health surface is unchanged.
    const health = await provider.health();
    assert.equal(health.healthy, false);
    assert.equal(health.available, false);
    assert.equal(health.reason, 'mt5_transport_unconfigured');
  });

  test('E2. the canonical path with an all-null MT5 configuration records uncertainty and respects null-equal bindings', async () => {
    const transport = new DisabledMT5Transport();
    const handoff = createSubmitBarrierHandoff();
    const provider = createMT5ExecutionProvider(transport, {
      enabled: true,
      environment: 'demo',
      broker: null,
      server: null,
      accountRef: null,
      symbols: new Map(),
      now: () => NOW,
    }, { gate9: handoff.gate9 });

    const { userId, profileId } = await makeAccount();
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: `ve-${'f'.repeat(24)}`,
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

    // The provider declares null broker/server/account — the authorization
    // must bind exactly that (F2 null-equal binding), and it does.
    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: null,
      brokerServerRef: null,
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
      handoff,
    });

    assert.equal(result.status, 'error');
    if (result.status !== 'error') throw new Error('expected the disabled-transport flow to fail closed');
    assert.equal(result.kind, 'provider_uncertain', 'never an acceptance, never a rejection');
    assert.equal(result.result.outcome, 'uncertain');
    assert.equal(result.result.intentState, 'uncertain');

    const health = await provider.health();
    assert.equal(health.healthy, false);
    assert.equal(health.available, false);
  });

  test('E3. F5 — DisabledMT5Transport.submitOrder() is actually reached (seam), and refuses without any external call', async () => {
    // The seam serves a healthy readiness pre-flight from in-memory data, so
    // the flow reaches `submitOrder`; `submitOrder` is delegated to the REAL
    // DisabledMT5Transport. This proves the disabled-transport boundary
    // itself is exercised — not just the readiness gate.
    const seam = new DisabledTransportSeam();
    assert.ok(seam.delegate instanceof DisabledMT5Transport, 'the delegate is the real disabled transport');

    // The delegate's only behavior is to refuse: no broker communication is
    // attempted, by construction. Prove it directly first.
    await assert.rejects(
      () => seam.delegate.submitOrder(),
      (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable'
        && /not configured; no broker communication was attempted/i.test(e.message),
    );

    const handoff = createSubmitBarrierHandoff();
    const provider = createMT5ExecutionProvider(seam, MT5_CONFIG, { gate9: handoff.gate9 });
    const { userId, profileId } = await makeAccount();
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: `ve-${'e3'.padEnd(24, '0')}`,
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'seam-b2',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: MT5_CONFIG.accountRef,
      brokerServerRef: MT5_CONFIG.server,
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
      handoff,
    });

    // The flow reached the transport boundary exactly once…
    assert.equal(seam.submitOrderCalls, 1, 'DisabledMT5Transport.submitOrder() was reached');
    // …and the disabled transport's refusal surfaced as a durable uncertainty.
    assert.equal(result.status, 'error');
    if (result.status !== 'error') throw new Error('expected the seam flow to fail closed at the disabled transport');
    assert.equal(result.kind, 'provider_uncertain');
    assert.equal(result.result.intentState, 'uncertain');
    assert.equal(result.result.requiresReconciliation, true);
  });

  test('F. existing M8.4 boundary surface stays intact: the barrier check is purely additive', () => {
    // Sentinel: the additive B2 changes expose the canonical boundary and the
    // one-shot handoff alongside the unchanged legacy surface.
    assert.equal(typeof createMT5ExecutionProvider, 'function');
    assert.equal(typeof DisabledMT5Transport, 'function');
    assert.equal(typeof submitOrderThroughGate9, 'function');
    assert.equal(typeof createSubmitBarrierHandoff, 'function');
    assert.equal(typeof ProviderMutationLedger, 'function');
    const handoff = createSubmitBarrierHandoff();
    assert.equal(typeof handoff.onBarrierConsumed, 'function');
    assert.equal(typeof handoff.gate9.consumeAuthorization, 'function');
  });

  /* ------------------------------------------------------------------------ */
  /* F2 — request + provider/configuration binding                             */
  /* ------------------------------------------------------------------------ */

  test('F2a. request mutation after authorization cannot change what the provider receives (F2)', async () => {
    const { userId, profileId } = await makeAccount();
    const { provider, state } = createFakeMT5Provider({
      submit: async () => ({ providerOrderId: 'fake-f2a', status: 'accepted' }),
    });
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f2a-auth',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };
    const original = { ...request };

    // Deterministic: the canonical hash is computed synchronously at the very
    // start of prepareSubmit (before any await). A queued microtask therefore
    // mutates the CALLER's object AFTER hashing and BEFORE any DB I/O — i.e.
    // before the provider call at the end of executeSubmit.
    queueMicrotask(() => {
      request.quantity = 999;
      request.symbol = 'EURUSD';
      request.stopLossPrice = 1;
    });

    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('expected canonical dispatch to succeed');

    // The provider received a FROZEN COPY of the original request — not the
    // caller's (mutated) object — and the original values intact.
    assert.notEqual(state.lastRequest, request, 'the provider received a copy, not the caller object');
    assert.equal(state.lastRequest!.quantity, original.quantity, 'quantity survived the mutation attempt');
    assert.equal(state.lastRequest!.symbol, original.symbol, 'symbol survived the mutation attempt');
    assert.equal(state.lastRequest!.stopLossPrice, original.stopLossPrice, 'stop loss survived the mutation attempt');
    assert.ok(Object.isFrozen(state.lastRequest!), 'the request handed to the provider is frozen');

    // The durable authorization covers the ORIGINAL request.
    const { rows } = await pool.query<{ request_hash: string }>(
      `SELECT request_hash FROM execution_provider_intents WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    const durableHash = rows[0]!.request_hash;
    const hashOfOriginal = canonicalMutationRequestHash({
      clientOrderId: original.clientOrderId,
      idempotencyKey: original.idempotencyKey,
      canonicalRequest: original,
    });
    const hashOfMutated = canonicalMutationRequestHash({
      clientOrderId: request.clientOrderId,
      idempotencyKey: request.idempotencyKey,
      canonicalRequest: request,
    });
    assert.equal(durableHash, hashOfOriginal, 'the durable hash covers the original request');
    assert.notEqual(durableHash, hashOfMutated, 'the mutated object does NOT match the durable authorization');
  });

  test('F2b. provider identity mismatch refuses before persistence (F2)', async () => {
    const { userId, profileId } = await makeAccount();

    // (1) Authorization names slug 'mt5'; the injected provider declares id 'paper'.
    const { provider: mt5DeclaringProvider } = createFakeMT5Provider({ describeId: 'paper' });
    const reqA: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f2b-a',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };
    const resA = await submitOrderThroughGate9({
      ledger,
      provider: mt5DeclaringProvider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request: reqA,
    });
    assert.equal(resA.status, 'error');
    if (resA.status !== 'error') throw new Error('expected a binding refusal');
    assert.equal(resA.kind, 'provider_binding_mismatch');
    assert.match(resA.message, /providerSlug/);

    // (2) Reverse: authorization names slug 'paper'; provider declares id 'mt5'.
    const { provider: paperDeclaringProvider, state: stateB } = createFakeMT5Provider({ describeId: 'mt5' });
    const reqB: ExecutionSubmitOrderRequest = { ...reqA, clientOrderId: newClientOrderId(), idempotencyKey: newIdempotencyKey() };
    const resB = await submitOrderThroughGate9({
      ledger,
      provider: paperDeclaringProvider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'paper',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request: reqB,
    });
    assert.equal(resB.status, 'error');
    if (resB.status !== 'error') throw new Error('expected a binding refusal');
    assert.equal(resB.kind, 'provider_binding_mismatch');
    assert.equal(stateB.callCount, 0, 'the provider was never invoked');

    // Nothing was persisted: no intent rows for either request.
    const { rows: none } = await pool.query<{ id: string }>(
      `SELECT id FROM execution_provider_intents WHERE client_order_id IN ($1, $2)`,
      [reqA.clientOrderId, reqB.clientOrderId],
    );
    assert.equal(none.length, 0, 'a binding mismatch persists nothing');
  });

  test('F2c. account binding mismatch refuses before persistence (F2)', async () => {
    const { userId, profileId } = await makeAccount();
    // Provider declares account 'masked-account'; authorization names 'other-account'.
    const { provider, state } = createFakeMT5Provider({ describeAccountRef: 'masked-account' });
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f2c',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };
    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'other-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });
    assert.equal(result.status, 'error');
    if (result.status !== 'error') throw new Error('expected a binding refusal');
    assert.equal(result.kind, 'provider_binding_mismatch');
    assert.match(result.message, /accountRef/);
    assert.equal(state.callCount, 0, 'the provider was never invoked');
    const { rows: none } = await pool.query<{ id: string }>(
      `SELECT id FROM execution_provider_intents WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(none.length, 0, 'a binding mismatch persists nothing');
  });

  test('F2d. broker/server binding mismatch refuses before persistence, in both directions (F2)', async () => {
    const { userId, profileId } = await makeAccount();

    // (1) Provider declares server 'Example-Demo'; authorization names 'Other-Server'.
    const { provider, state } = createFakeMT5Provider({ describeServer: 'Example-Demo' });
    const reqA: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f2d-a',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };
    const resA = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Other-Server',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request: reqA,
    });
    assert.equal(resA.status, 'error');
    if (resA.status !== 'error') throw new Error('expected a binding refusal');
    assert.equal(resA.kind, 'provider_binding_mismatch');
    assert.match(resA.message, /brokerServerRef/);
    assert.equal(state.callCount, 0, 'the provider was never invoked');

    // (2) Reverse: authorization names no broker server (null); provider
    // declares one. A binding that omits a value the provider declares is a
    // mismatch too — the provider cannot be silently re-targeted.
    const reqB: ExecutionSubmitOrderRequest = { ...reqA, clientOrderId: newClientOrderId(), idempotencyKey: newIdempotencyKey() };
    const resB = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: null,
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request: reqB,
    });
    assert.equal(resB.status, 'error');
    if (resB.status !== 'error') throw new Error('expected a binding refusal');
    assert.equal(resB.kind, 'provider_binding_mismatch');

    const { rows: none } = await pool.query<{ id: string }>(
      `SELECT id FROM execution_provider_intents WHERE client_order_id IN ($1, $2)`,
      [reqA.clientOrderId, reqB.clientOrderId],
    );
    assert.equal(none.length, 0, 'a binding mismatch persists nothing');
  });

  /* ------------------------------------------------------------------------ */
  /* F3 — uncertainty is never an acceptance                                   */
  /* ------------------------------------------------------------------------ */

  test('F3a. a provider call with an unknown outcome is never reported as accepted (F3)', async () => {
    const { userId, profileId } = await makeAccount();
    const { provider, state } = createFakeMT5Provider({
      submit: async () => {
        throw new Error('synthetic transport failure (response lost)');
      },
    });
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: `ve-${'f3a'.padEnd(24, '0')}`,
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f3a',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });

    // Explicit uncertainty — structurally incapable of being an acceptance:
    // the error envelope carries no `providerOutcome` at all.
    assert.equal(result.status, 'error');
    if (result.status !== 'error') throw new Error('expected explicit uncertainty');
    assert.equal(result.kind, 'provider_uncertain');
    assert.ok(!('providerOutcome' in result), 'uncertainty never projects a provider outcome');
    assert.equal(result.result.outcome, 'uncertain');
    assert.equal(result.result.intentState, 'uncertain');
    assert.equal(result.result.requiresReconciliation, true);
    assert.ok(result.result.providerCalled, 'the provider call happened and is durably recorded');
    assert.equal(state.callCount, 1);

    // Durable state: intent and reservation are `uncertain`.
    const { rows: intents } = await pool.query<{ status: string }>(
      `SELECT status FROM execution_provider_intents WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.status, 'uncertain');
    const { rows: reservations } = await pool.query<{ state: string }>(
      `SELECT state FROM execution_provider_mutation_reservations WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0]!.state, 'uncertain');
  });

  test('F3b. a duplicate resolving onto an uncertain intent is never accepted or rejected (F3)', async () => {
    const { userId, profileId } = await makeAccount();
    const { provider, state } = createFakeMT5Provider({
      submit: async () => {
        throw new Error('synthetic transport failure (response lost)');
      },
    });
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: `ve-${'d'.repeat(24)}`,
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f3b',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const first = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });
    assert.equal(first.status, 'error');
    if (first.status !== 'error') throw new Error('expected explicit uncertainty on the first attempt');
    assert.equal(first.kind, 'provider_uncertain');

    // Same identity, same body → the ledger resolves the duplicate onto the
    // unresolved (uncertain) intent. Explicit error — never accepted.
    const replay = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });
    assert.equal(replay.status, 'error');
    if (replay.status !== 'error') throw new Error('expected an explicit unresolved-duplicate error');
    assert.equal(replay.kind, 'duplicate_unresolved');
    assert.ok(!('providerOutcome' in replay), 'an unresolved duplicate never projects a provider outcome');
    assert.equal(replay.result.intentState, 'uncertain');
    assert.equal(replay.result.providerCalled, false, 'the duplicate path never invokes the provider');
    assert.equal(state.callCount, 1, 'the provider was invoked exactly once, ever');
  });

  test('F3c. a duplicate resolving onto a confirmed intent carries the REAL provider order id (F3)', async () => {
    const { userId, profileId } = await makeAccount();
    const { provider, state } = createFakeMT5Provider({
      submit: async () => ({ providerOrderId: 'fake-ticket-77', status: 'accepted' }),
    });
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f3c',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const first = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });
    assert.equal(first.status, 'ok');
    if (first.status !== 'ok') throw new Error('expected a successful submit');
    assert.equal(first.kind, 'submitted');
    assert.equal(first.providerOutcome.status, 'accepted');
    assert.equal(first.providerOutcome.providerOrderId, 'fake-ticket-77');

    // Idempotent replay: the duplicate resolution reports the durable
    // acceptance with the REAL ticket from the receipt — never the intent id.
    const replay = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });
    assert.equal(replay.status, 'ok');
    if (replay.status !== 'ok') throw new Error('expected the confirmed duplicate to resolve');
    assert.equal(replay.kind, 'duplicate');
    assert.equal(replay.providerOutcome.status, 'accepted');
    assert.equal(replay.providerOutcome.providerOrderId, 'fake-ticket-77', 'the real provider ticket, from the durable receipt');
    assert.notEqual(replay.providerOutcome.providerOrderId, replay.result.intentId, 'never the internal intent id');
    assert.equal(replay.result.providerCalled, false);
    assert.equal(state.callCount, 1, 'the provider was invoked exactly once, ever');
  });

  test('F3d. a provider rejection without a ticket projects rejected with a null order id (F3)', async () => {
    const { userId, profileId } = await makeAccount();
    const { provider } = createFakeMT5Provider({
      submit: async () => ({ providerOrderId: null, status: 'rejected' }),
    });
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: newClientOrderId(),
      idempotencyKey: newIdempotencyKey(),
      authorizationId: 'f3d',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const result = await submitOrderThroughGate9({
      ledger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('expected a durable rejection');
    assert.equal(result.kind, 'submitted');
    assert.equal(result.providerOutcome.status, 'rejected', 'an explicit rejection stays a rejection');
    assert.equal(result.providerOutcome.providerOrderId, null, 'no ticket exists — an internal id is never substituted');
    assert.equal(result.result.intentState, 'rejected');
  });

  test('F3e. a confirmed duplicate without a durable ticket fails safe to unresolved (F3)', async () => {
    // A confirmed (accepted) intent always carries its verified ticket
    // durably — the ledger only confirms after identity verification, and
    // the receipts table is append-only. A confirmed intent WITHOUT its
    // receipt/ticket is a durable state anomaly the ledger cannot produce.
    // The boundary's projection must still refuse to emit a ticket-less
    // acceptance: inject a stub ledger that resolves a duplicate onto such
    // an intent and exposes no receipt, and assert the explicit fail-safe.
    const { userId, profileId } = await makeAccount();
    const intentId = randomUUID();
    const confirmedWithoutTicket = {
      id: intentId,
      userId,
      executionProfileId: profileId,
      orderId: null,
      mutationKind: 'submit_order',
      clientOrderId: `ve-${'f3e'.padEnd(24, '0')}`,
      idempotencyKey: 'a'.repeat(64),
      requestHash: null,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      status: 'confirmed' as const,
      outcome: 'accepted' as const,
      uncertaintyReason: null,
      terminalEvidence: null,
      resolution: null,
      parentIntentId: null,
      rootIntentId: null,
      supersededByIntentId: null,
      attempt: 1,
      reconciliationRequired: false,
      reconciliationState: 'none',
      riskDecisionId: null,
      stateVersion: 4,
      submittedAt: null,
      resolvedAt: null,
      createdAt: new Date(NOW),
    };
    const stubLedger = {
      // Duplicate path only: the presented identity already exists as a
      // confirmed intent whose receipt is missing (the anomaly).
      submitOnce: async () => ({ kind: 'duplicate', intent: confirmedWithoutTicket }),
      getReceipt: async () => null,
    } as unknown as ProviderMutationLedger;
    const { provider, state } = createFakeMT5Provider({
      submit: async () => ({ providerOrderId: 'fake-ticket-f3e', status: 'accepted' }),
    });
    const request: ExecutionSubmitOrderRequest = {
      clientOrderId: confirmedWithoutTicket.clientOrderId,
      idempotencyKey: confirmedWithoutTicket.idempotencyKey!,
      authorizationId: 'f3e',
      assetClass: 'commodity',
      symbol: 'XAUUSD',
      side: 'buy',
      orderType: 'market',
      quantity: 0.1,
      requestedPrice: null,
      stopLossPrice: 1990,
      takeProfitPrice: 2020,
    };

    const replay = await submitOrderThroughGate9({
      ledger: stubLedger,
      provider,
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'masked-account',
      brokerServerRef: 'Example-Demo',
      credentialRef: CRED_REF,
      credentialFingerprint: CRED_FINGERPRINT(),
      request,
    });

    assert.equal(replay.status, 'error', 'a ticket-less acceptance is never projected');
    if (replay.status !== 'error') throw new Error('expected the fail-safe to refuse the projection');
    assert.equal(replay.kind, 'duplicate_unresolved');
    assert.ok(!('providerOutcome' in replay), 'no provider outcome is projected for the anomaly');
    assert.match(replay.message, /never projected without its verified ticket/);
    assert.equal(replay.result.intentState, 'confirmed');
    assert.equal(replay.result.providerCalled, false, 'the duplicate path never invokes the provider');
    assert.equal(state.callCount, 0);
  });
});
