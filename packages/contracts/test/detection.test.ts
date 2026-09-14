import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DETECTOR_VERSION,
  SETUP_INITIAL_STATE,
  SETUP_STATES,
  SETUP_TERMINAL_STATES,
  SETUP_TRANSITIONS,
  detectionItemDtoSchema,
  detectionRequestSchema,
  detectionResponseDtoSchema,
  setupDetailDtoSchema,
  setupDtoSchema,
  setupListQuerySchema,
  setupStateEventDtoSchema,
  setupTransitionRequestSchema,
  setupTransitionResponseDtoSchema,
  type SetupDto,
} from '../src/index.js';

describe('m4 detection contracts', () => {
  test('the eight lifecycle states match the 0006 CHECK constraint exactly', () => {
    assert.deepEqual([...SETUP_STATES], [
      'developing',
      'watching',
      'almost_ready',
      'confirmed',
      'triggered',
      'invalidated',
      'expired',
      'completed',
    ]);
  });

  test('the state machine covers every state; terminal states have no exits', () => {
    assert.deepEqual(Object.keys(SETUP_TRANSITIONS).sort(), [...SETUP_STATES].sort());
    for (const terminal of SETUP_TERMINAL_STATES) {
      assert.deepEqual(SETUP_TRANSITIONS[terminal], []);
    }
    assert.deepEqual(SETUP_TRANSITIONS.confirmed, ['triggered', 'invalidated', 'expired']);
    assert.deepEqual(SETUP_TRANSITIONS.triggered, ['completed', 'invalidated', 'expired']);
  });

  test('detection enters the machine at confirmed with a pinned detector version', () => {
    assert.equal(SETUP_INITIAL_STATE, 'confirmed');
    assert.equal(DETECTOR_VERSION, 'm4-setup-detect-1');
  });

  test('detection request requires instrument + asOf; direction is optional', () => {
    const ok = detectionRequestSchema.safeParse({
      instrument: { assetClass: 'forex', symbol: 'eurusd' },
      asOf: 1_800_000_000_000,
    });
    assert.equal(ok.success, true);
    if (ok.success) {
      assert.equal(ok.data.instrument.symbol, 'EURUSD'); // normalized
      assert.equal(ok.data.direction, undefined);
    }
    const withDirection = detectionRequestSchema.safeParse({
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'short',
      asOf: 1_800_000_000_000,
    });
    assert.equal(withDirection.success, true);
  });

  test('detection request rejects missing asOf, bad direction, unknown keys', () => {
    assert.equal(
      detectionRequestSchema.safeParse({ instrument: { assetClass: 'forex', symbol: 'EURUSD' } }).success,
      false,
    );
    assert.equal(
      detectionRequestSchema.safeParse({
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'sideways',
        asOf: 1_800_000_000_000,
      }).success,
      false,
    );
    assert.equal(
      detectionRequestSchema.safeParse({
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        asOf: 1_800_000_000_000,
        timeframe: '1h',
      }).success,
      false,
    );
    assert.equal(
      detectionRequestSchema.safeParse({
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        asOf: 'now',
      }).success,
      false,
    );
  });

  test('transition request requires toState + asOf; reason is optional and bounded', () => {
    assert.equal(
      setupTransitionRequestSchema.safeParse({ toState: 'triggered', asOf: 1_800_000_000_001 }).success,
      true,
    );
    assert.equal(
      setupTransitionRequestSchema.safeParse({
        toState: 'triggered',
        reason: 'entry filled',
        asOf: 1_800_000_001,
      }).success,
      true,
    );
    assert.equal(setupTransitionRequestSchema.safeParse({ toState: 'triggered' }).success, false);
    assert.equal(
      setupTransitionRequestSchema.safeParse({ toState: 'sleeping', asOf: 1 }).success,
      false,
    );
    assert.equal(
      setupTransitionRequestSchema.safeParse({ toState: 'triggered', asOf: 1, reason: 'x'.repeat(281) })
        .success,
      false,
    );
  });

  test('list query coerces limit and validates filters', () => {
    const ok = setupListQuerySchema.safeParse({ state: 'confirmed', limit: '10' });
    assert.equal(ok.success, true);
    if (ok.success) assert.equal(ok.data.limit, 10);
    const defaults = setupListQuerySchema.safeParse({});
    assert.equal(defaults.success, true);
    if (defaults.success) assert.equal(defaults.data.limit, 50);
    assert.equal(setupListQuerySchema.safeParse({ limit: '500' }).success, false);
    assert.equal(setupListQuerySchema.safeParse({ state: 'napping' }).success, false);
    assert.equal(setupListQuerySchema.safeParse({ strategyId: 'not-a-uuid' }).success, false);
  });

  test('setup DTO round-trips a confirmed detection row', () => {
    const setup: SetupDto = {
      id: '11111111-1111-1111-1111-111111111111',
      strategyId: '22222222-2222-2222-2222-222222222222',
      strategyVersionId: '33333333-3333-3333-3333-333333333333',
      versionNumber: 1,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      state: 'confirmed',
      direction: 'long',
      asOfMs: 1_800_000_000_000,
      detectedAt: new Date(1_800_000_000_000).toISOString(),
      updatedAt: new Date(1_800_000_000_000).toISOString(),
      expiresAt: null,
      entryPrice: 101.3,
      stopLossPrice: 100.5,
      tp1Price: 102.1,
      tp2Price: 102.9,
      tp3Price: 103.7,
      qualityScore: null,
      metadata: { detectorVersion: DETECTOR_VERSION, asOfMs: 1_800_000_000_000 },
    };
    assert.equal(setupDtoSchema.safeParse(setup).success, true);
    assert.equal(
      setupStateEventDtoSchema.safeParse({
        id: 7,
        setupId: setup.id,
        fromState: null,
        toState: 'confirmed',
        reason: 'detected',
        payload: { detectorVersion: DETECTOR_VERSION, asOfMs: 1_800_000_000_000 },
        createdAt: new Date(1_800_000_000_000).toISOString(),
      }).success,
      true,
    );
    assert.equal(setupDetailDtoSchema.safeParse({ setup, events: [] }).success, true);
  });

  test('detection item DTO forbids setups on non-qualifying outcomes', () => {
    const bad = detectionItemDtoSchema.safeParse({
      direction: 'long',
      qualified: false,
      setup: null,
      created: true,
      failureReasons: ['blocked'],
    });
    assert.equal(bad.success, false);
  });

  test('detection + transition response DTOs validate', () => {
    const setup = setupDtoSchema.parse({
      id: '11111111-1111-1111-1111-111111111111',
      strategyId: '22222222-2222-2222-2222-222222222222',
      strategyVersionId: '33333333-3333-3333-3333-333333333333',
      versionNumber: 1,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      state: 'confirmed',
      direction: 'long',
      asOfMs: 1_800_000_000_000,
      detectedAt: new Date(1_800_000_000_000).toISOString(),
      updatedAt: new Date(1_800_000_000_000).toISOString(),
      expiresAt: null,
      entryPrice: null,
      stopLossPrice: null,
      tp1Price: null,
      tp2Price: null,
      tp3Price: null,
      qualityScore: null,
      metadata: {},
    });
    const response = detectionResponseDtoSchema.safeParse({
      strategyId: setup.strategyId,
      versionId: setup.strategyVersionId,
      versionNumber: 1,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      asOfMs: 1_800_000_000_000,
      detectorVersion: DETECTOR_VERSION,
      engineVersion: 'm3-deterministic-eval-1',
      detections: [{ direction: 'long', qualified: true, setup, created: true, failureReasons: [] }],
    });
    assert.equal(response.success, true);
    const transition = setupTransitionResponseDtoSchema.safeParse({
      setup,
      transitioned: false,
      event: null,
    });
    assert.equal(transition.success, true);
  });
});
