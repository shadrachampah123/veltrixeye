/**
 * B1 M1 — immutable authorization records + strict quantity/price validation.
 *
 * The authorization service is the one-shot barrier in front of Gate 9: every
 * record it hands out must be frozen (what the caller holds can never drift
 * from what the service verifies), `peekAuthorization` must expose records
 * without consuming them, creation must validate aggressively, and revocation
 * must be idempotent.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutionAuthorizationService,
  type AuthorizationExecutionContext,
} from '../src/execution/authorization.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROFILE = '22222222-2222-4222-8222-222222222222';
const DECISION = '88888888-8888-4888-8888-888888888888';
const SETUP = '33333333-3333-4333-8333-333333333333';

function mintArgs(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    executionProfileId: PROFILE,
    clientOrderId: 've-order-1',
    idempotencyKey: 'idem-1',
    symbol: 'EURUSD',
    side: 'buy' as const,
    quantity: 0.5,
    assetClass: 'forex',
    orderType: 'market',
    stopLossPrice: 1.09,
    takeProfitPrice: 1.12,
    requestedPrice: 1.1,
    providerSlug: 'paper',
    environment: 'paper' as const,
    accountRef: null,
    brokerServerRef: null,
    riskDecisionId: DECISION,
    setupId: SETUP,
    ...overrides,
  };
}

function consumeArgs() {
  return {
    request: {
      clientOrderId: 've-order-1',
      idempotencyKey: 'idem-1',
      symbol: 'EURUSD',
      side: 'buy' as const,
      quantity: 0.5,
      assetClass: 'forex' as const,
      orderType: 'market' as const,
      stopLossPrice: 1.09,
      takeProfitPrice: 1.12,
      requestedPrice: 1.1,
    },
    context: {
      userId: USER,
      executionProfileId: PROFILE,
      providerSlug: 'paper',
      environment: 'paper' as const,
      accountRef: null,
      brokerServerRef: null,
      setupId: SETUP,
      riskDecisionId: DECISION,
    } satisfies AuthorizationExecutionContext,
  };
}

describe('B1 M1 — authorization records are immutable', () => {
  test('createAuthorization returns a frozen record: tampering throws and the stored copy is intact', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    assert.equal(Object.isFrozen(rec), true);

    assert.throws(() => {
      (rec as any).quantity = 999;
    }, TypeError);

    const { request, context } = consumeArgs();
    const consumed = svc.consumeAuthorization(rec.id, request as any, context);
    assert.equal(consumed.id, rec.id);
    assert.equal(consumed.quantity, 0.5);
  });

  test('peekAuthorization returns the record without consuming it', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    const peeked = svc.peekAuthorization(rec.id);
    assert.ok(peeked);
    assert.equal(peeked!.id, rec.id);
    assert.equal(Object.isFrozen(peeked), true);
    assert.equal(svc.size(), 1);
    const { request, context } = consumeArgs();
    assert.equal(svc.consumeAuthorization(rec.id, request as any, context).id, rec.id);
    assert.equal(svc.size(), 0);
  });

  test('peekAuthorization of an unknown id returns null', () => {
    const svc = new ExecutionAuthorizationService();
    assert.equal(svc.peekAuthorization('no-such-id'), null);
  });

  test('consumeAuthorization returns a frozen record', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    const { request, context } = consumeArgs();
    const consumed = svc.consumeAuthorization(rec.id, request as any, context);
    assert.equal(Object.isFrozen(consumed), true);
  });
});

describe('B1 M1 — creation validates aggressively', () => {
  test('rejects non-finite, zero, and negative quantities', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.5' as any]) {
      assert.throws(() => svc.createAuthorization(mintArgs({ quantity })), /quantity/, `quantity ${quantity}`);
    }
    assert.equal(svc.size(), 0);
  });

  test('rejects non-finite prices but accepts null (absent) prices', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    for (const field of ['stopLossPrice', 'takeProfitPrice', 'requestedPrice'] as const) {
      assert.throws(() => svc.createAuthorization(mintArgs({ [field]: Number.NaN })), /finite/, field);
    }
    assert.equal(svc.size(), 0);
    const rec = svc.createAuthorization(
      mintArgs({ stopLossPrice: null, takeProfitPrice: null, requestedPrice: null }),
    );
    assert.equal(rec.stopLossPrice, null);
    assert.equal(rec.takeProfitPrice, null);
    assert.equal(rec.requestedPrice, null);
  });

  test('rejects blank identity fields, bad side, and bad environment', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    for (const field of [
      'userId',
      'executionProfileId',
      'clientOrderId',
      'idempotencyKey',
      'symbol',
      'assetClass',
      'orderType',
      'providerSlug',
    ] as const) {
      assert.throws(() => svc.createAuthorization(mintArgs({ [field]: '' })), /non-empty/, field);
    }
    assert.throws(() => svc.createAuthorization(mintArgs({ side: 'hold' })), /side/);
    assert.throws(() => svc.createAuthorization(mintArgs({ environment: 'live' })), /environment/);
    assert.equal(svc.size(), 0);
  });
});

describe('B1 M1 — lifecycle: one-shot, expiry, revocation', () => {
  test('one-shot: the second consume fails closed', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    const { request, context } = consumeArgs();
    svc.consumeAuthorization(rec.id, request as any, context);
    assert.throws(
      () => svc.consumeAuthorization(rec.id, request as any, context),
      /no server-issued execution authorization/,
    );
    assert.equal(svc.size(), 0);
  });

  test('expiry is enforced and the expired record is pruned', () => {
    let now = 1_000_000;
    const svc = new ExecutionAuthorizationService({ clock: () => now, ttlMs: 1_000 });
    const rec = svc.createAuthorization(mintArgs());
    now += 1_001;
    const { request, context } = consumeArgs();
    assert.throws(() => svc.consumeAuthorization(rec.id, request as any, context), /expired/);
    assert.equal(svc.size(), 0);
    assert.equal(svc.clearExpired(), 0);
  });

  test('revokeAuthorization is idempotent and blocks later consume', () => {
    const svc = new ExecutionAuthorizationService({ clock: () => 1_000_000 });
    const rec = svc.createAuthorization(mintArgs());
    assert.equal(svc.revokeAuthorization(rec.id), true);
    assert.equal(svc.revokeAuthorization(rec.id), false);
    assert.equal(svc.revokeAuthorization('unknown'), false);
    assert.equal(svc.size(), 0);
    const { request, context } = consumeArgs();
    assert.throws(
      () => svc.consumeAuthorization(rec.id, request as any, context),
      /no server-issued execution authorization/,
    );
  });

  test('clearExpired keeps live records and drops expired ones', () => {
    let now = 1_000_000;
    const svc = new ExecutionAuthorizationService({ clock: () => now, ttlMs: 10_000 });
    svc.createAuthorization(mintArgs({ clientOrderId: 've-short', idempotencyKey: 'idem-short' }));
    now += 500;
    svc.createAuthorization(mintArgs({ clientOrderId: 've-long', idempotencyKey: 'idem-long' }));
    // Both live: neither is older than ttlMs. Expire only the first.
    now += 10_000;
    assert.equal(svc.clearExpired(), 1);
    assert.equal(svc.size(), 1);
  });
});
