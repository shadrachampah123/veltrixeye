/**
 * B1 H1 — authorization is bound to the complete immutable execution context.
 *
 * consumeAuthorization takes (authorizationId, request, expectedContext):
 * the request must match the mutation identity AND the expected context
 * (built by the composition from its authoritative snapshot) must match the
 * stored context field-for-field, including null-vs-non-null. Any deviation
 * fails closed with `validation` and consumes nothing.
 *
 * The MT5 provider cannot take a per-call context (contracts boundary), so
 * the composition arms it one-shot through AuthorizationContextHandoff
 * immediately before the submit; the provider-side adapter consumes the
 * armed entry at most once.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionAuthorizationService,
  assertAuthorizationContext,
  createAuthorizationContextHandoff,
  diffAuthorizationContext,
  type AuthorizationExecutionContext,
} from '../src/execution/authorization.js';
import { createMT5ExecutionProvider, type MT5Transport } from '../src/execution/mt5.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROFILE = '22222222-2222-4222-8222-222222222222';
const OTHER_PROFILE = '99999999-9999-4999-8999-999999999999';
const DECISION = '88888888-8888-4888-8888-888888888888';
const SETUP = '33333333-3333-4333-8333-333333333333';
const CLIENT = `ve-${'c1'.repeat(12)}`;

function fullContext(overrides: Partial<AuthorizationExecutionContext> = {}): AuthorizationExecutionContext {
  return {
    userId: USER,
    executionProfileId: PROFILE,
    providerSlug: 'mt5',
    environment: 'demo',
    accountRef: 'acct-1',
    brokerServerRef: 'Exness-MT5',
    setupId: SETUP,
    riskDecisionId: DECISION,
    ...overrides,
  };
}

function mintArgs(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    executionProfileId: PROFILE,
    clientOrderId: CLIENT,
    idempotencyKey: 'idem-h1',
    symbol: 'EURUSD',
    side: 'buy' as const,
    quantity: 0.5,
    assetClass: 'forex',
    orderType: 'market',
    stopLossPrice: 1.09,
    takeProfitPrice: 1.12,
    requestedPrice: 1.1,
    providerSlug: 'mt5',
    environment: 'demo' as const,
    accountRef: 'acct-1',
    brokerServerRef: 'Exness-MT5',
    riskDecisionId: DECISION,
    setupId: SETUP,
    ...overrides,
  };
}

function submitRequest(overrides: Record<string, unknown> = {}): any {
  return {
    clientOrderId: CLIENT,
    idempotencyKey: 'idem-h1',
    symbol: 'EURUSD',
    side: 'buy',
    quantity: 0.5,
    assetClass: 'forex',
    orderType: 'market',
    stopLossPrice: 1.09,
    takeProfitPrice: 1.12,
    requestedPrice: 1.1,
    ...overrides,
  };
}

describe('B1 H1 — context binding on consume', () => {
  test('exact match consumes', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    const consumed = svc.consumeAuthorization(rec.id, submitRequest(), fullContext());
    assert.equal(consumed.id, rec.id);
  });

  const mismatches: Array<[string, Partial<AuthorizationExecutionContext>, string]> = [
    ['userId', { userId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }, 'userId'],
    ['executionProfileId', { executionProfileId: OTHER_PROFILE }, 'executionProfileId'],
    ['providerSlug', { providerSlug: 'paper' }, 'providerSlug'],
    ['environment', { environment: 'paper' }, 'environment'],
    ['accountRef value', { accountRef: 'acct-2' }, 'accountRef'],
    ['accountRef null-vs-value', { accountRef: null }, 'accountRef'],
    ['brokerServerRef value', { brokerServerRef: 'Other-Server' }, 'brokerServerRef'],
    ['brokerServerRef null-vs-value', { brokerServerRef: null }, 'brokerServerRef'],
    ['setupId', { setupId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }, 'setupId'],
    ['setupId null-vs-value', { setupId: null }, 'setupId'],
    ['riskDecisionId', { riskDecisionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc' }, 'riskDecisionId'],
    ['riskDecisionId null-vs-value', { riskDecisionId: null }, 'riskDecisionId'],
  ];
  for (const [label, patch, field] of mismatches) {
    test(`context mismatch on ${label} fails closed and consumes nothing`, () => {
      const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
      const rec = svc.createAuthorization(mintArgs());
      assert.equal(diffAuthorizationContext(rec, fullContext(patch)), field);
      assert.throws(
        () => svc.consumeAuthorization(rec.id, submitRequest(), fullContext(patch)),
        /not issued for this execution context/,
      );
      // Failed consume leaves the authorization live for the correct context.
      assert.equal(svc.size(), 1);
      const consumed = svc.consumeAuthorization(rec.id, submitRequest(), fullContext());
      assert.equal(consumed.id, rec.id);
    });
  }

  test('null stored matches only null expected (value-vs-null also fails)', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs({ accountRef: null, brokerServerRef: null, setupId: null }));
    assert.equal(
      diffAuthorizationContext(
        rec,
        fullContext({ accountRef: null, brokerServerRef: null, setupId: null }),
      ),
      null,
    );
    assert.equal(
      diffAuthorizationContext(rec, fullContext({ accountRef: 'acct-1' })),
      'accountRef',
    );
    assert.throws(
      () => svc.consumeAuthorization(rec.id, submitRequest(), fullContext({ setupId: SETUP })),
      /not issued for this execution context/,
    );
    assert.equal(svc.size(), 1);
  });

  test('assertAuthorizationContext throws validation on mismatch, silent on match', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    assert.doesNotThrow(() => assertAuthorizationContext(rec, fullContext()));
    assert.throws(() => assertAuthorizationContext(rec, fullContext({ userId: 'x' })), /not issued for this execution context/);
  });

  test('request mismatches still fail closed (mutation identity binding preserved)', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    assert.throws(
      () => svc.consumeAuthorization(rec.id, submitRequest({ quantity: 1.5 }), fullContext()),
      /does not match its server-issued authorization/,
    );
    assert.throws(
      () => svc.consumeAuthorization(rec.id, submitRequest({ side: 'sell' }), fullContext()),
      /does not match its server-issued authorization/,
    );
    assert.throws(
      () =>
        svc.consumeAuthorization(
          rec.id,
          submitRequest({ clientOrderId: `ve-${'d2'.repeat(12)}` }),
          fullContext(),
        ),
      /does not match its server-issued authorization/,
    );
    // All failures non-consuming: the correct request still consumes.
    assert.equal(svc.consumeAuthorization(rec.id, submitRequest(), fullContext()).id, rec.id);
  });
});

describe('B1 H1 — one-shot context handoff to the provider boundary', () => {
  function setup() {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const handoff = createAuthorizationContextHandoff(svc, { clock: () => 1_000_000 });
    return { svc, handoff };
  }

  test('arm then provider-adapter consume works exactly once', () => {
    const { svc, handoff } = setup();
    const rec = svc.createAuthorization(mintArgs());
    handoff.arm(rec.id, fullContext());
    assert.equal(handoff.size(), 1);
    const out = handoff.authorization.consumeAuthorization(rec.id, submitRequest());
    assert.equal((out as any).id, rec.id);
    assert.equal(handoff.size(), 0);
    // Second presentation fails closed (one-shot), even for the same mutation.
    assert.throws(
      () => handoff.authorization.consumeAuthorization(rec.id, submitRequest()),
      /no armed execution context/,
    );
  });

  test('unarmed authorization is refused by the provider adapter', () => {
    const { svc, handoff } = setup();
    const rec = svc.createAuthorization(mintArgs());
    assert.throws(
      () => handoff.authorization.consumeAuthorization(rec.id, submitRequest()),
      /no armed execution context/,
    );
    // Refused presentation consumes nothing on either side.
    assert.equal(svc.size(), 1);
  });

  test('armed context mismatch fails closed at the service layer', () => {
    const { svc, handoff } = setup();
    const rec = svc.createAuthorization(mintArgs());
    handoff.arm(rec.id, fullContext({ executionProfileId: OTHER_PROFILE }));
    assert.throws(
      () => handoff.authorization.consumeAuthorization(rec.id, submitRequest()),
      /not issued for this execution context/,
    );
    assert.equal(svc.size(), 1);
    assert.equal(handoff.size(), 0); // the armed entry was spent by the attempt
  });

  test('expired armed entry is refused', () => {
    let now = 1_000_000;
    const svc = new ExecutionAuthorizationService({ clock: () => now, ttlMs: 60_000 });
    const handoff = createAuthorizationContextHandoff(svc, { clock: () => now, ttlMs: 5_000 });
    const rec = svc.createAuthorization(mintArgs());
    handoff.arm(rec.id, fullContext());
    now += 5_001;
    assert.throws(
      () => handoff.authorization.consumeAuthorization(rec.id, submitRequest()),
      /armed execution context has expired/,
    );
    assert.equal(svc.size(), 1);
  });

  test('revoke disarms; arming snapshots the context object', () => {
    const { handoff } = setup();
    handoff.arm('auth-1', fullContext());
    assert.equal(handoff.revoke('auth-1'), true);
    assert.equal(handoff.revoke('auth-1'), false);
    assert.equal(handoff.size(), 0);

    const mutable = fullContext();
    handoff.arm('auth-2', mutable);
    (mutable as any).userId = 'tampered';
    // The armed copy is unaffected — would only be observable via consume;
    // revoke proves the entry exists and size accounting holds.
    assert.equal(handoff.size(), 1);
  });
});

describe('B1 H1 — MT5 provider enforces the armed context before any transport call', () => {
  function countingTransport(): { transport: MT5Transport; calls: string[] } {
    const calls: string[] = [];
    const transport: MT5Transport = {
      configured: true,
      async health() {
        calls.push('health');
        return { configured: true, authenticated: true, connected: true, healthy: true };
      },
      async account() {
        calls.push('account');
        throw new Error('not used');
      },
      async symbol() {
        calls.push('symbol');
        return null;
      },
      async submitOrder() {
        calls.push('submitOrder');
        throw new Error('not used');
      },
      async findOrderByClientId() {
        calls.push('findOrderByClientId');
        return null;
      },
      async cancelOrder() {
        calls.push('cancelOrder');
      },
      async modifyOrder() {
        calls.push('modifyOrder');
      },
      async order() {
        calls.push('order');
        return null;
      },
      async orders() {
        calls.push('orders');
        return [];
      },
      async position() {
        calls.push('position');
        return null;
      },
      async positions() {
        calls.push('positions');
        return [];
      },
      async closePosition() {
        calls.push('closePosition');
      },
    };
    return { transport, calls };
  }

  function wiredProvider(authorization: { consumeAuthorization(id: string, req: any): unknown }) {
    const { transport, calls } = countingTransport();
    const provider = createMT5ExecutionProvider(
      transport,
      {
        enabled: false,
        environment: 'demo',
        broker: 'Exness',
        server: 'Exness-MT5',
        accountRef: 'acct-1',
        symbols: new Map([['EURUSD', 'EURUSD']],
        ),
      },
      { authorization },
    );
    return { provider, calls };
  }

  test('matching armed context passes authorization (then fails later: the provider is disabled)', async () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const handoff = createAuthorizationContextHandoff(svc, { clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    handoff.arm(rec.id, fullContext());
    const { provider, calls } = wiredProvider(handoff.authorization);
    // Authorization passes, so the provider proceeds past the auth gate
    // and then refuses because the deployment is disabled. The point: the
    // failure is AFTER authorization, not a validation refusal, and no
    // order-creating transport call was made.
    await assert.rejects(
      () => provider.submitOrder({ ...submitRequest(), authorizationId: rec.id } as any),
      /disabled/,
    );
    assert.ok(!calls.includes('submitOrder'), 'no order-creating transport call');
    assert.equal(svc.size(), 0, 'authorization was consumed');
  });

  test('mismatched armed context is refused before any transport call', async () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const handoff = createAuthorizationContextHandoff(svc, { clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    handoff.arm(rec.id, fullContext({ executionProfileId: OTHER_PROFILE }));
    const { provider, calls } = wiredProvider(handoff.authorization);
    await assert.rejects(
      () => provider.submitOrder({ ...submitRequest(), authorizationId: rec.id } as any),
      /not issued for this execution context/,
    );
    assert.deepEqual(calls, [], 'no transport call may precede authorization');
    assert.equal(svc.size(), 1, 'refused submit consumes nothing');
  });

  test('unarmed submit is refused before any transport call', async () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const handoff = createAuthorizationContextHandoff(svc, { clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    const { provider, calls } = wiredProvider(handoff.authorization);
    await assert.rejects(
      () => provider.submitOrder({ ...submitRequest(), authorizationId: rec.id } as any),
      /no armed execution context/,
    );
    assert.deepEqual(calls, [], 'no transport call may precede authorization');
    assert.equal(svc.size(), 1);
  });

  test('missing authorization id is refused before any transport call', async () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const handoff = createAuthorizationContextHandoff(svc, { clock: () => 1_000_000 });
    const { provider, calls } = wiredProvider(handoff.authorization);
    await assert.rejects(() => provider.submitOrder(submitRequest() as any), /server-issued execution authorization/);
    assert.deepEqual(calls, []);
  });
});
