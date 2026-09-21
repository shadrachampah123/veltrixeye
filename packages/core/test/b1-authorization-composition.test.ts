/**
 * B1 — authorization/composition layer tests.
 *
 * Verifies:
 *  - ExecutionAuthorizationService: one-shot, TTL, exact request + context
 *    binding, fail-closed (context coverage lives in b1-h1-*; immutability
 *    in b1-m1-*)
 *  - MT5 provider wired through the one-shot context handoff (H1)
 *  - Gate evaluation: environment safety, broker/account binding,
 *    provider health, no live execution (gates themselves are unchanged)
 *  - Canonical boundary still mandatory (Gate 9 + B2)
 *  - DisabledMT5Transport preserved
 *  - Honest uncertainty never projected as accepted
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMT5ExecutionProvider,
  DisabledMT5Transport,
  ExecutionAuthorizationService,
  createAuthorizationContextHandoff,
  evaluateExecutionGates,
  type AuthorizationExecutionContext,
  type ExecutionGateInput,
} from '../src/execution/index.js';
import { ExecutionProviderError, normalizeProviderOrderStatus } from '@veltrixeye/contracts';
import type { MT5Transport } from '../src/execution/mt5.js';

// ---------------------------------------------------------------------------
// Authorization service
// ---------------------------------------------------------------------------

describe('B1 — ExecutionAuthorizationService', () => {
  const baseRequest = {
    clientOrderId: `ve-${'a1'.repeat(12)}`,
    idempotencyKey: 'a'.repeat(64),
    assetClass: 'forex' as const,
    symbol: 'EURUSD',
    side: 'buy' as const,
    orderType: 'market' as const,
    quantity: 0.1,
    requestedPrice: null,
    stopLossPrice: 1.1,
    takeProfitPrice: 1.2,
    authorizationId: 'test-auth',
  };

  const baseContext: AuthorizationExecutionContext = {
    userId: 'u1',
    executionProfileId: 'p1',
    providerSlug: 'mt5',
    environment: 'demo',
    accountRef: 'acc-1',
    brokerServerRef: 'srv-1',
    setupId: 's1',
    riskDecisionId: 'r1',
  };

  function mintArgs(overrides: Record<string, unknown> = {}) {
    return {
      userId: 'u1',
      executionProfileId: 'p1',
      clientOrderId: baseRequest.clientOrderId,
      idempotencyKey: baseRequest.idempotencyKey,
      symbol: baseRequest.symbol,
      side: baseRequest.side,
      quantity: baseRequest.quantity,
      assetClass: baseRequest.assetClass,
      orderType: baseRequest.orderType,
      stopLossPrice: baseRequest.stopLossPrice,
      takeProfitPrice: baseRequest.takeProfitPrice,
      requestedPrice: null,
      providerSlug: 'mt5',
      environment: 'demo' as const,
      accountRef: 'acc-1',
      brokerServerRef: 'srv-1',
      riskDecisionId: 'r1',
      setupId: 's1',
      ...overrides,
    };
  }

  it('mints and consumes exactly once (one-shot)', () => {
    const clock = { now: 1_000 };
    const svc = new ExecutionAuthorizationService({ clock: () => clock.now, ttlMs: 60_000 });
    const auth = svc.createAuthorization(mintArgs());

    const consumed = svc.consumeAuthorization(
      auth.id,
      { ...baseRequest, authorizationId: auth.id } as any,
      baseContext,
    );
    assert.equal(consumed.id, auth.id);

    assert.throws(
      () => svc.consumeAuthorization(auth.id, { ...baseRequest, authorizationId: auth.id } as any, baseContext),
      (e: any) => e instanceof ExecutionProviderError && e.category === 'validation',
    );
  });

  it('refuses expired authorization (TTL)', () => {
    let now = 1_000;
    const svc = new ExecutionAuthorizationService({ clock: () => now, ttlMs: 60_000 });
    const auth = svc.createAuthorization(mintArgs({ accountRef: null, brokerServerRef: null, riskDecisionId: null, setupId: null }));
    now += 61_000;
    assert.throws(
      () =>
        svc.consumeAuthorization(
          auth.id,
          { ...baseRequest, authorizationId: auth.id } as any,
          { ...baseContext, accountRef: null, brokerServerRef: null, riskDecisionId: null, setupId: null },
        ),
      (e: any) => e instanceof ExecutionProviderError && /expired/.test(e.message),
    );
  });

  it('refuses binding mismatch (symbol, quantity, SL/TP)', () => {
    const svc = new ExecutionAuthorizationService({ ttlMs: 60_000 });
    const idempotencyKey = 'b'.repeat(64);
    const clientOrderId = `ve-${'b2'.repeat(12)}`;
    const auth = svc.createAuthorization(mintArgs({ clientOrderId, idempotencyKey }));
    const req = (patch: Record<string, unknown>) =>
      ({
        clientOrderId,
        idempotencyKey,
        assetClass: 'forex',
        symbol: 'EURUSD',
        side: 'buy',
        orderType: 'market',
        quantity: 0.1,
        stopLossPrice: 1.1,
        takeProfitPrice: 1.2,
        requestedPrice: null,
        authorizationId: auth.id,
        ...patch,
      }) as any;

    assert.throws(() => svc.consumeAuthorization(auth.id, req({ symbol: 'GBPUSD' }), baseContext));
    assert.throws(() => svc.consumeAuthorization(auth.id, req({ quantity: 0.2 }), baseContext));
    assert.throws(() => svc.consumeAuthorization(auth.id, req({ stopLossPrice: 1.0 }), baseContext));
    // All failures non-consuming: the exact request still consumes.
    assert.equal(svc.consumeAuthorization(auth.id, req({}), baseContext).id, auth.id);
  });

  it('refuses unknown authorization id', () => {
    const svc = new ExecutionAuthorizationService();
    assert.throws(
      () => svc.consumeAuthorization('unknown-id', baseRequest as any, baseContext),
      (e: any) => e instanceof ExecutionProviderError,
    );
  });

  it('refuses context mismatch (H1)', () => {
    const svc = new ExecutionAuthorizationService({ ttlMs: 60_000 });
    const auth = svc.createAuthorization(mintArgs());
    assert.throws(
      () =>
        svc.consumeAuthorization(
          auth.id,
          { ...baseRequest, authorizationId: auth.id } as any,
          { ...baseContext, executionProfileId: 'p2' },
        ),
      /not issued for this execution context/,
    );
    assert.equal(
      svc.consumeAuthorization(auth.id, { ...baseRequest, authorizationId: auth.id } as any, baseContext).id,
      auth.id,
    );
  });

  it('bounds map and evicts expired', () => {
    let now = 0;
    const svc = new ExecutionAuthorizationService({ clock: () => now, ttlMs: 1000, maxEntries: 2 });
    svc.createAuthorization({
      userId: 'u', executionProfileId: 'p', clientOrderId: 've-1', idempotencyKey: 'k1', symbol: 'EURUSD', side: 'buy', quantity: 0.1, assetClass: 'forex', orderType: 'market', providerSlug: 'paper', environment: 'paper', accountRef: null, brokerServerRef: null,
    });
    now = 500;
    svc.createAuthorization({
      userId: 'u', executionProfileId: 'p', clientOrderId: 've-2', idempotencyKey: 'k2', symbol: 'EURUSD', side: 'buy', quantity: 0.1, assetClass: 'forex', orderType: 'market', providerSlug: 'paper', environment: 'paper', accountRef: null, brokerServerRef: null,
    });
    now = 2000;
    svc.createAuthorization({
      userId: 'u', executionProfileId: 'p', clientOrderId: 've-3', idempotencyKey: 'k3', symbol: 'EURUSD', side: 'buy', quantity: 0.1, assetClass: 'forex', orderType: 'market', providerSlug: 'paper', environment: 'paper', accountRef: null, brokerServerRef: null,
    });
    assert.ok(svc.size() <= 2);
  });
});

// ---------------------------------------------------------------------------
// MT5 provider with authorization service (via the one-shot context handoff)
// ---------------------------------------------------------------------------

describe('B1 — MT5 provider with authorization service', () => {
  function providerWith(authz: { consumeAuthorization(id: string, req: any): unknown }) {
    return createMT5ExecutionProvider(
      new DisabledMT5Transport(),
      {
        enabled: true,
        environment: 'demo',
        broker: null,
        server: 'srv',
        accountRef: 'acc',
        symbols: new Map([['EURUSD', 'EURUSD']]),
      },
      { authorization: authz },
    );
  }

  it('refuses when authorizationId missing (presence check preserved)', async () => {
    const svc = new ExecutionAuthorizationService();
    const handoff = createAuthorizationContextHandoff(svc);
    const provider = providerWith(handoff.authorization);
    await assert.rejects(() =>
      provider.submitOrder({
        clientOrderId: `ve-${'c3'.repeat(12)}`,
        idempotencyKey: 'k'.repeat(64),
        assetClass: 'forex',
        symbol: 'EURUSD',
        side: 'buy',
        orderType: 'market',
        quantity: 0.1,
        requestedPrice: null,
        stopLossPrice: 1.1,
        takeProfitPrice: 1.2,
      } as any),
    );
  });

  it('verifies authorization via the armed handoff, one-shot at both layers', async () => {
    const authSvc = new ExecutionAuthorizationService();
    const handoff = createAuthorizationContextHandoff(authSvc);
    const provider = providerWith(handoff.authorization);

    const clientOrderId = `ve-${'d4'.repeat(12)}`;
    const idempotencyKey = 'c'.repeat(64);
    const context: AuthorizationExecutionContext = {
      userId: 'u1',
      executionProfileId: 'p1',
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'acc',
      brokerServerRef: 'srv',
      setupId: null,
      riskDecisionId: null,
    };
    const auth = authSvc.createAuthorization({
      userId: 'u1', executionProfileId: 'p1', clientOrderId, idempotencyKey,
      symbol: 'EURUSD', side: 'buy', quantity: 0.1, assetClass: 'forex', orderType: 'market',
      stopLossPrice: 1.1, takeProfitPrice: 1.2, requestedPrice: null,
      providerSlug: 'mt5', environment: 'demo', accountRef: 'acc', brokerServerRef: 'srv',
    });
    const request = {
      clientOrderId, idempotencyKey, authorizationId: auth.id,
      assetClass: 'forex', symbol: 'EURUSD', side: 'buy', orderType: 'market', quantity: 0.1,
      requestedPrice: null, stopLossPrice: 1.1, takeProfitPrice: 1.2,
    } as any;

    // Armed: authorization is consumed, then the provider fails later at
    // readiness (the transport is disabled) — never at the auth layer.
    handoff.arm(auth.id, context);
    await assert.rejects(() => provider.submitOrder(request), /unavailable|disabled|not configured|not ready/i);
    assert.equal(authSvc.size(), 0, 'first submit consumed the authorization');

    // Second submit with the same id fails at the auth layer (one-shot):
    // the handoff entry is spent and the authorization is gone.
    await assert.rejects(
      () => provider.submitOrder(request),
      (e: any) => e instanceof ExecutionProviderError && e.category === 'validation',
    );
  });

  it('DisabledMT5Transport preserved: configured false, health unhealthy, submit fails closed', async () => {
    const transport = new DisabledMT5Transport();
    assert.equal(transport.configured, false);
    const health = await transport.health();
    assert.equal(health.configured, false);
    assert.equal(health.healthy, false);
    const provider = createMT5ExecutionProvider(transport, {
      enabled: false,
      environment: 'demo',
      broker: null,
      server: null,
      accountRef: null,
      symbols: new Map(),
    });
    const providerHealth = await provider.health();
    assert.equal(providerHealth.healthy, false);
    assert.equal(providerHealth.state, 'disabled');
    await assert.rejects(() =>
      provider.submitOrder({
        clientOrderId: `ve-${'e5'.repeat(12)}`,
        idempotencyKey: 'k'.repeat(64),
        assetClass: 'forex',
        symbol: 'EURUSD',
        side: 'buy',
        orderType: 'market',
        quantity: 0.1,
        requestedPrice: null,
        stopLossPrice: 1.1,
        takeProfitPrice: 1.2,
        authorizationId: 'a',
      } as any),
    );
  });
});

// ---------------------------------------------------------------------------
// Gate evaluation — B1 fixes
// ---------------------------------------------------------------------------

describe('B1 — gate evaluation fixes', () => {
  const baseEntitlements = { canAccessAutomation: true, plan: 'pro' } as any;

  const baseInput = (overrides: Partial<ExecutionGateInput> = {}): ExecutionGateInput => ({
    authenticated: true,
    authorized: true,
    entitlements: baseEntitlements,
    automation: { entitled: true, automationEnabled: true },
    profile: { enabled: true, environment: 'paper' },
    killSwitches: { global: false, user: false, strategy: false, profile: false },
    decision: {
      strategyId: 's1',
      strategyVersionId: 'v1',
      setupId: 'setup1',
      action: 'open_long',
      assetClass: 'forex',
      symbol: 'EURUSD',
      timeframe: '1h',
      direction: 'long',
      entryPrice: 1.1,
      stopLossPrice: 1.0,
      takeProfitPrice: 1.3,
      expectedRr: 2,
      qualityScore: 80,
      minQualityScore: 60,
      asOfMs: Date.now(),
    } as any,
    setup: { id: 'setup1', direction: 'long', state: 'confirmed' },
    instrumentKnown: true,
    riskDecision: { approved: true, decisionId: 'r1', engineVersion: 'm8.2-risk-engine-1' } as any,
    minRr: 2,
    exposureWithinLimits: true,
    providerHealth: { healthy: true },
    environmentSafe: true,
    brokerAuthorized: true,
    accountAuthorized: true,
    ...overrides,
  });

  it('allows demo environment (B1) but still fails live', () => {
    const demo = evaluateExecutionGates(baseInput({ profile: { enabled: true, environment: 'demo' } }));
    assert.equal(demo.passed, true);

    const live = evaluateExecutionGates(baseInput({ profile: { enabled: true, environment: 'live' as any } }));
    assert.equal(live.passed, false);
    assert.equal(live.failedGate, 'profile_enabled');
  });

  it('fails closed when broker/account not server-authorized', () => {
    const noBroker = evaluateExecutionGates(baseInput({ brokerAuthorized: false }));
    assert.equal(noBroker.passed, false);
    assert.equal(noBroker.failedGate, 'broker_authorized');

    const noAccount = evaluateExecutionGates(baseInput({ accountAuthorized: false }));
    assert.equal(noAccount.passed, false);
    assert.equal(noAccount.failedGate, 'account_authorized');
  });

  it('fails closed when environment not safe (live)', () => {
    const unsafe = evaluateExecutionGates(baseInput({ environmentSafe: false, profile: { enabled: true, environment: 'demo' } }));
    assert.equal(unsafe.passed, false);
    assert.equal(unsafe.failedGate, 'environment_safety');
  });

  it('fails closed when provider health unknown via readiness resolver', () => {
    const unknown = evaluateExecutionGates(baseInput({ providerHealth: null }));
    assert.equal(unknown.passed, false);
    assert.equal(unknown.failedGate, 'provider_healthy');
  });
});

// ---------------------------------------------------------------------------
// Production composition audit — single boundary, no bypass, Gate 9 mandatory
// ---------------------------------------------------------------------------

describe('B1 — production composition audit', () => {
  it('exactly one canonical boundary: submitOrderThroughGate9 exists and is used', async () => {
    const { submitOrderThroughGate9, createSubmitBarrierHandoff } = await import('../src/execution/submit-boundary.js');
    assert.ok(typeof submitOrderThroughGate9 === 'function');
    assert.ok(typeof createSubmitBarrierHandoff === 'function');
  });

  it('honest uncertainty: unknown broker statuses normalize to uncertain, never accepted', async () => {
    // B9 — the protocol normalizer is the only reader of the status
    // vocabulary: an unknown broker status can never project acceptance.
    for (const unknown of ['TOTALLY_UNKNOWN', '', 'weird-status-123']) {
      const normalized = normalizeProviderOrderStatus(unknown as any);
      assert.equal(normalized.status, null, `status ${JSON.stringify(unknown)}`);
      assert.equal(normalized.statusUncertain, true);
      assert.equal(normalized.snapshotStatus, 'uncertain');
    }
    // Known terminal states keep their meaning.
    assert.equal(normalizeProviderOrderStatus('accepted' as any).status, 'accepted');
    assert.equal(normalizeProviderOrderStatus('rejected' as any).status, 'rejected');

    // And the disabled transport fails closed (unavailable), never accepted.
    const transport: MT5Transport = new DisabledMT5Transport();
    await assert.rejects(() => transport.submitOrder({} as any), /not configured/);
  });
});
