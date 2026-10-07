/**
 * The strategy editor's condition-param descriptors.
 *
 * `anchorOffsetCandles` (sequential anchors, engine `m3-deterministic-eval-3`)
 * is a param of EVERY condition type, so the control is appended to every
 * descriptor list rather than repeated in the 19 per-type entries. These tests
 * pin that it is present, editable as a non-negative integer, and part of the
 * defaults a newly-added condition is created with.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listConditionTypes } from '@veltrixeye/contracts';
import { CONDITION_PARAM_DESCRIPTORS, defaultParamsFor, descriptorsFor } from '../lib/condition-params';

const ANCHOR_OFFSET_KEY = 'anchorOffsetCandles';

test('every condition type exposes an editable anchor offset, defaulting to 0', () => {
  for (const def of listConditionTypes()) {
    const descriptor = descriptorsFor(def.type).find((d) => d.key === ANCHOR_OFFSET_KEY);
    assert.ok(descriptor, `${def.type} must expose ${ANCHOR_OFFSET_KEY}`);
    assert.equal(descriptor.kind, 'number');
    assert.equal(descriptor.default, 0);
    assert.equal(descriptor.min, 0);
    assert.equal(descriptor.step, 1);
    // 5000 matches the contracts bound (the store's per-request ceiling).
    assert.equal(descriptor.max, 5000);
  }
});

test('the offset is appended after a type\'s own params and is part of new-condition defaults', () => {
  const sweep = descriptorsFor('liquidity_sweep');
  assert.equal(sweep[sweep.length - 1]?.key, ANCHOR_OFFSET_KEY);
  assert.deepEqual(
    sweep.slice(0, -1).map((d) => d.key),
    CONDITION_PARAM_DESCRIPTORS.liquidity_sweep!.map((d) => d.key),
  );
  assert.equal(defaultParamsFor('liquidity_sweep')[ANCHOR_OFFSET_KEY], 0);
});

test('an unknown type degrades to just the offset control (never undefined)', () => {
  assert.deepEqual(
    descriptorsFor('does_not_exist').map((d) => d.key),
    [ANCHOR_OFFSET_KEY],
  );
});
