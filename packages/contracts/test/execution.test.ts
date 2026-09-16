import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_ACTIONS,
  EXECUTION_ARCHITECTURE_VERSION,
  EXECUTION_FAILURE_CATEGORIES,
  EXECUTION_GATE_IDS,
  EXECUTION_MODES,
  EXECUTION_REQUEST_STATUSES,
  ExecutionProviderError,
  isExecutionProviderError,
  KILL_SWITCH_SCOPES,
  M8_1_ALLOWED_ENVIRONMENTS,
  ORDER_SIDES,
  ORDER_STATUSES,
  ORDER_TERMINAL_STATUSES,
  ORDER_TYPES,
  POSITION_STATUSES,
  automationStatusDtoSchema,
  executionDecisionSchema,
  executionIdempotencyKey,
  executionProfileCreateSchema,
  isTerminalOrderStatus,
  type ExecutionDecisionInput,
} from '../src/index.js';

const VALID_DECISION: ExecutionDecisionInput = {
  strategyId: '11111111-1111-4111-8111-111111111111',
  strategyVersionId: '22222222-2222-4222-8222-222222222222',
  setupId: '33333333-3333-4333-8333-333333333333',
  action: 'open_long',
  assetClass: 'forex',
  symbol: 'EURUSD',
  timeframe: '1h',
  direction: 'long',
  entryPrice: 1.1,
  stopLossPrice: 1.095,
  takeProfitPrice: 1.11,
  expectedRr: 2,
  qualityScore: 78,
  minQualityScore: 65,
  asOfMs: 1_700_000_000_000,
};

describe('m8.1 execution constants', () => {
  test('the M8.1 boundary pins paper as the only allowed environment', () => {
    assert.deepEqual([...M8_1_ALLOWED_ENVIRONMENTS], ['paper']);
    assert.ok(EXECUTION_MODES.includes('live')); // modeled…
    assert.ok(!M8_1_ALLOWED_ENVIRONMENTS.includes('live')); // …but never allowed
  });

  test('order statuses cover the full lifecycle with absorbing terminals', () => {
    assert.deepEqual([...ORDER_STATUSES], [
      'requested',
      'validating',
      'submitted',
      'accepted',
      'partially_filled',
      'filled',
      'rejected',
      'cancelled',
      'expired',
      'failed',
    ]);
    assert.deepEqual(
      ORDER_TERMINAL_STATUSES.filter((s) => isTerminalOrderStatus(s)),
      [...ORDER_TERMINAL_STATUSES],
    );
    assert.equal(isTerminalOrderStatus('accepted'), false);
    assert.equal(isTerminalOrderStatus('filled'), true);
  });

  test('the safety gate list is pinned, ordered and complete (15 gates)', () => {
    assert.equal(EXECUTION_GATE_IDS.length, 15);
    assert.equal(EXECUTION_GATE_IDS[0], 'authenticated');
    assert.equal(EXECUTION_GATE_IDS[1], 'authorized');
    assert.equal(EXECUTION_GATE_IDS[EXECUTION_GATE_IDS.length - 1], 'provider_healthy');
    assert.ok(EXECUTION_GATE_IDS.includes('kill_switch'));
    assert.ok(EXECUTION_GATE_IDS.includes('automation_on'));
  });

  test('failure taxonomy is normalized and exhaustive for provider mapping', () => {
    assert.deepEqual([...EXECUTION_FAILURE_CATEGORIES], [
      'authentication',
      'validation',
      'insufficient_funds',
      'market_closed',
      'rate_limited',
      'timeout',
      'unavailable',
      'rejected',
      'unknown',
    ]);
  });

  test('kill-switch scopes and domain enums are pinned', () => {
    assert.deepEqual([...KILL_SWITCH_SCOPES], ['global', 'user', 'strategy', 'execution_profile']);
    assert.deepEqual([...ORDER_SIDES], ['buy', 'sell']);
    assert.deepEqual([...ORDER_TYPES], ['market', 'limit', 'stop', 'stop_limit']);
    assert.deepEqual([...POSITION_STATUSES], ['open', 'closed']);
    assert.deepEqual([...EXECUTION_ACTIONS], ['open_long', 'open_short', 'close_position']);
    assert.deepEqual([...EXECUTION_REQUEST_STATUSES], ['requested', 'rejected']);
    assert.match(EXECUTION_ARCHITECTURE_VERSION, /^m8\.1-execution-arch-\d+$/);
  });
});

describe('m8.1 execution decision contract', () => {
  test('a valid long decision parses (provenance intact)', () => {
    const parsed = executionDecisionSchema.safeParse(VALID_DECISION);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.setupId, VALID_DECISION.setupId);
      assert.equal(parsed.data.symbol, 'EURUSD'); // normalized uppercase
    }
  });

  test('lowercase symbols are normalized, never rejected arbitrarily', () => {
    const parsed = executionDecisionSchema.safeParse({ ...VALID_DECISION, symbol: 'eurusd' });
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data.symbol, 'EURUSD');
  });

  test('long decisions require SL below and TP above the entry', () => {
    const slAbove = executionDecisionSchema.safeParse({ ...VALID_DECISION, stopLossPrice: 1.2 });
    assert.equal(slAbove.success, false);
    const tpBelow = executionDecisionSchema.safeParse({ ...VALID_DECISION, takeProfitPrice: 1.05 });
    assert.equal(tpBelow.success, false);
  });

  test('short decisions require SL above and TP below the entry', () => {
    const short = {
      ...VALID_DECISION,
      action: 'open_short' as const,
      direction: 'short' as const,
      entryPrice: 1.1,
      stopLossPrice: 1.105,
      takeProfitPrice: 1.09,
      expectedRr: 2,
    };
    assert.equal(executionDecisionSchema.safeParse(short).success, true);
    const badSl = executionDecisionSchema.safeParse({ ...short, stopLossPrice: 1.05 });
    assert.equal(badSl.success, false);
  });

  test('action and direction must agree', () => {
    const mismatch = executionDecisionSchema.safeParse({
      ...VALID_DECISION,
      action: 'open_short',
      // direction stays long ⇒ conflict
    });
    assert.equal(mismatch.success, false);
  });

  test('claimed RR must be achievable from the levels', () => {
    const inflated = executionDecisionSchema.safeParse({ ...VALID_DECISION, expectedRr: 5 });
    assert.equal(inflated.success, false);
  });

  test('non-positive prices and junk fields are refused', () => {
    assert.equal(executionDecisionSchema.safeParse({ ...VALID_DECISION, entryPrice: 0 }).success, false);
    assert.equal(executionDecisionSchema.safeParse({ ...VALID_DECISION, entryPrice: -1 }).success, false);
    assert.equal(
      executionDecisionSchema.safeParse({ ...VALID_DECISION, bogusClientField: true }).success,
      false,
      'strict schema rejects client-injected fields',
    );
    assert.equal(
      executionDecisionSchema.safeParse({ ...VALID_DECISION, setupId: 'not-a-uuid' }).success,
      false,
    );
  });
});

describe('m8.1 idempotency identity', () => {
  test('the identity is stable across retries (never random)', () => {
    const args = {
      userId: 'u1',
      setupId: 's1',
      executionProfileId: 'p1',
      action: 'open_long' as const,
    };
    assert.equal(executionIdempotencyKey(args), executionIdempotencyKey(args));
  });

  test('any identity component changes the key', () => {
    const base = {
      userId: 'u1',
      setupId: 's1',
      executionProfileId: 'p1',
      action: 'open_long' as const,
    };
    assert.notEqual(
      executionIdempotencyKey(base),
      executionIdempotencyKey({ ...base, userId: 'u2' }),
    );
    assert.notEqual(
      executionIdempotencyKey(base),
      executionIdempotencyKey({ ...base, setupId: 's2' }),
    );
    assert.notEqual(
      executionIdempotencyKey(base),
      executionIdempotencyKey({ ...base, executionProfileId: 'p2' }),
    );
    assert.notEqual(
      executionIdempotencyKey(base),
      executionIdempotencyKey({ ...base, action: 'open_short' }),
    );
  });
});

describe('m8.1 provider error normalization', () => {
  test('ExecutionProviderError carries a normalized category', () => {
    const err = new ExecutionProviderError('insufficient_funds', 'Not enough margin');
    assert.equal(isExecutionProviderError(err), true);
    assert.equal(err.category, 'insufficient_funds');
    assert.equal(err.name, 'ExecutionProviderError');
    assert.equal(isExecutionProviderError(new Error('x')), false);
  });
});

describe('m8.1 DTO schemas', () => {
  test('profile create input is strict and bounded', () => {
    assert.equal(executionProfileCreateSchema.safeParse({ mode: 'paper', providerSlug: 'paper' }).success, true);
    assert.equal(
      executionProfileCreateSchema.safeParse({ mode: 'paper', providerSlug: 'paper', extra: 1 }).success,
      false,
    );
    assert.equal(
      executionProfileCreateSchema.safeParse({ mode: 'live', providerSlug: 'paper' }).success,
      true, // parses as a known mode; the SERVICE refuses live server-side
    );
  });

  test('automation status DTO shape is pinned', () => {
    const parsed = automationStatusDtoSchema.safeParse({
      entitled: false,
      automationEnabled: false,
      globalKillSwitch: false,
      userKillSwitch: false,
      effective: false,
      reasons: ['entitlement_not_granted', 'automation_switch_off'],
    });
    assert.equal(parsed.success, true);
  });
});
