import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CandidateLevels } from '@veltrixeye/contracts';
import {
  allowedTransitions,
  assertTransition,
  detectionLevels,
  isTerminalState,
  mirrorPrice,
} from '../src/index.js';

const LONG_CANDIDATE: CandidateLevels = {
  entryPrice: 100,
  stopLossPrice: 98,
  riskDistance: 2,
  tp1Price: 102,
  tp2Price: 104,
  tp3Price: 106,
  achievableRr: 3,
  basis: 'fixed stop below entry; RR targets above',
};

describe('m4 setup state machine (pure)', () => {
  test('terminal states are exactly completed/invalidated/expired', () => {
    assert.equal(isTerminalState('completed'), true);
    assert.equal(isTerminalState('invalidated'), true);
    assert.equal(isTerminalState('expired'), true);
    assert.equal(isTerminalState('confirmed'), false);
    assert.equal(isTerminalState('triggered'), false);
    assert.equal(isTerminalState('developing'), false);
  });

  test('the forward chain plus exits matches the repository lifecycle', () => {
    assert.deepEqual(allowedTransitions('developing'), ['watching', 'invalidated', 'expired']);
    assert.deepEqual(allowedTransitions('watching'), ['almost_ready', 'invalidated', 'expired']);
    assert.deepEqual(allowedTransitions('almost_ready'), ['confirmed', 'invalidated', 'expired']);
    assert.deepEqual(allowedTransitions('confirmed'), ['triggered', 'invalidated', 'expired']);
    assert.deepEqual(allowedTransitions('triggered'), ['completed', 'invalidated', 'expired']);
    assert.deepEqual(allowedTransitions('completed'), []);
    assert.deepEqual(allowedTransitions('invalidated'), []);
    assert.deepEqual(allowedTransitions('expired'), []);
  });

  test('valid transitions pass validation', () => {
    assert.doesNotThrow(() => assertTransition('confirmed', 'triggered'));
    assert.doesNotThrow(() => assertTransition('triggered', 'completed'));
    assert.doesNotThrow(() => assertTransition('confirmed', 'invalidated'));
    assert.doesNotThrow(() => assertTransition('triggered', 'expired'));
  });

  test('backward and sideways transitions fail with an actionable message', () => {
    assert.throws(() => assertTransition('confirmed', 'developing'), /Cannot transition setup from "confirmed" to "developing"/);
    assert.throws(() => assertTransition('triggered', 'confirmed'), /Cannot transition/);
    assert.throws(() => assertTransition('confirmed', 'completed'), /Allowed: triggered, invalidated, expired/);
  });

  test('terminal states reject everything; same-state repeats are caller no-ops', () => {
    assert.throws(() => assertTransition('completed', 'confirmed'), /terminal state "completed"/);
    assert.throws(() => assertTransition('invalidated', 'confirmed'), /terminal state/);
    assert.throws(() => assertTransition('expired', 'triggered'), /terminal state/);
    assert.throws(() => assertTransition('confirmed', 'confirmed'), /already in state/);
  });
});

describe('m4 detection levels (pure)', () => {
  test('long setups keep the M3 candidate as-is', () => {
    assert.deepEqual(detectionLevels(LONG_CANDIDATE, 'long'), {
      entryPrice: 100,
      stopLossPrice: 98,
      tp1Price: 102,
      tp2Price: 104,
      tp3Price: 106,
    });
  });

  test('short setups mirror every leg around the entry, preserving risk distance', () => {
    const levels = detectionLevels(LONG_CANDIDATE, 'short');
    assert.ok(levels);
    assert.equal(levels.entryPrice, 100);
    assert.equal(levels.stopLossPrice, 102); // 2*100 - 98
    assert.equal(levels.tp1Price, 98);
    assert.equal(levels.tp2Price, 96);
    assert.equal(levels.tp3Price, 94);
    assert.equal(mirrorPrice(100, 98), 102);
    // Same risk distance, opposite side.
    assert.equal(Math.abs(levels.entryPrice - (levels.stopLossPrice ?? 0)), LONG_CANDIDATE.riskDistance);
  });

  test('mirroring is deterministic and involutive', () => {
    assert.equal(mirrorPrice(100, mirrorPrice(100, 98)), 98);
    assert.deepEqual(detectionLevels(LONG_CANDIDATE, 'short'), detectionLevels(LONG_CANDIDATE, 'short'));
  });

  test('a null candidate persists as null levels (never fabricated)', () => {
    assert.equal(detectionLevels(null, 'long'), null);
    assert.equal(detectionLevels(null, 'short'), null);
  });

  test('degenerate legs degrade to null instead of storing inverted levels', () => {
    // A stop AT the entry mirrors onto the entry: not a valid short stop.
    const flat: CandidateLevels = { ...LONG_CANDIDATE, stopLossPrice: 100 };
    const short = detectionLevels(flat, 'short');
    assert.ok(short);
    assert.equal(short.entryPrice, 100);
    assert.equal(short.stopLossPrice, null);
    // A target so far it mirrors below zero is dropped, not stored negative.
    const far: CandidateLevels = { ...LONG_CANDIDATE, tp3Price: 250 };
    const shortFar = detectionLevels(far, 'short');
    assert.ok(shortFar);
    assert.equal(shortFar.tp3Price, null);
    assert.equal(shortFar.tp1Price, 98);
  });
});
