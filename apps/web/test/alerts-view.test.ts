/**
 * M6 Phase 4 — alert UI helpers.
 *
 * The invariants these tests exist to protect:
 *  - the three generation outcomes (created / dedup replay / quality-gate skip)
 *    are never blurred together, and a skip or replay is never described as a
 *    newly generated alert;
 *  - nothing in the UI claims an email, webhook, push, SMS or broker
 *    notification was sent — M6 delivery is a local stub ledger row;
 *  - acknowledgement is idempotent in the UI: the control is disabled while a
 *    request is in flight and stays disabled once the API says "acknowledged".
 *
 * Fixtures are parsed through the shared contract schemas, so a drift between
 * the API's DTOs and these tests fails here rather than in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_STATUSES,
  ALERT_TRIGGER_STATES,
  alertDeliveryDtoSchema,
  alertDtoSchema,
  type AlertDeliveryDto,
  type AlertDto,
  type AlertGenerateResponse,
  type SetupDto,
} from '@veltrixeye/contracts';
import {
  ALERT_STATUS_FILTERS,
  STUB_DELIVERY_BODY,
  STUB_DELIVERY_TITLE,
  acknowledgeControlState,
  alertStatusLabel,
  alertStatusTone,
  classifyGenerateOutcome,
  deliveryChannelLabel,
  describeDelivery,
  describeGenerateOutcome,
  gradeTone,
  isAcknowledged,
  readAlertBody,
  setupGenerateEligibility,
  sortSetupsForGenerate,
  triggerStateLabel,
} from '../lib/alerts-view';

const SETUP_ID = '33333333-3333-4333-8333-333333333333';
const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const ALERT_ID = '44444444-4444-4444-8444-444444444444';

function alertFixture(overrides: Partial<AlertDto> = {}): AlertDto {
  return alertDtoSchema.parse({
    id: ALERT_ID,
    setupId: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'long',
    triggerState: 'confirmed',
    qualityScore: 82,
    minQualityScore: 70,
    title: 'EURUSD long confirmed (score 82/A)',
    body: {
      setupId: SETUP_ID,
      strategyId: STRATEGY_ID,
      strategyVersionId: VERSION_ID,
      versionNumber: 3,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      triggerState: 'confirmed',
      qualityScore: 82,
      qualityGrade: 'A',
      minQualityScore: 70,
      entryPrice: 1.085,
      stopLossPrice: 1.08,
      tp1Price: 1.095,
      tp2Price: 1.105,
      tp3Price: 1.12,
      scoreId: 17,
      scoreEngineVersion: 'm5-score-1',
      detectedAt: '2024-05-20T12:00:00.000Z',
      asOfMs: 1716206400000,
    },
    status: 'pending',
    acknowledgedAt: null,
    createdAt: '2024-05-20T12:05:00.000Z',
    ...overrides,
  });
}

function deliveryFixture(overrides: Partial<AlertDeliveryDto> = {}): AlertDeliveryDto {
  return alertDeliveryDtoSchema.parse({
    id: 1,
    alertId: ALERT_ID,
    channel: 'stub',
    status: 'delivered',
    attempt: 1,
    error: null,
    payloadHash: 'a'.repeat(64),
    createdAt: '2024-05-20T12:05:00.000Z',
    ...overrides,
  });
}

function setupFixture(overrides: Partial<SetupDto> = {}): SetupDto {
  return {
    id: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    state: 'confirmed',
    direction: 'long',
    asOfMs: 1716206400000,
    detectedAt: '2024-05-20T12:00:00.000Z',
    updatedAt: '2024-05-20T12:00:00.000Z',
    expiresAt: null,
    entryPrice: 1.085,
    stopLossPrice: 1.08,
    tp1Price: 1.095,
    tp2Price: 1.105,
    tp3Price: 1.12,
    qualityScore: 82,
    metadata: {},
    ...overrides,
  } as SetupDto;
}

// ---------------------------------------------------------------------------
// Generation outcomes
// ---------------------------------------------------------------------------

test('classifyGenerateOutcome() — created / replayed / skipped are distinct', () => {
  const alert = alertFixture();
  const delivery = deliveryFixture();

  const created = classifyGenerateOutcome({ alert, created: true, deliveries: [delivery] });
  assert.equal(created.kind, 'created');

  const replayed = classifyGenerateOutcome({ alert, created: false, deliveries: [delivery] });
  assert.equal(replayed.kind, 'replayed');

  const skipped = classifyGenerateOutcome({ alert: null, created: false, skippedReason: 'below_min_quality' });
  assert.equal(skipped.kind, 'skipped');
  if (skipped.kind === 'skipped') assert.equal(skipped.reason, 'below_min_quality');

  // A defensive default: `alert: null` without a reason is still a skip.
  const bare = classifyGenerateOutcome({ alert: null, created: false } as AlertGenerateResponse);
  assert.equal(bare.kind, 'skipped');
});

test('describeGenerateOutcome() — a created alert is truthful about stub delivery', () => {
  const copy = describeGenerateOutcome({ kind: 'created', alert: alertFixture(), deliveries: [deliveryFixture()] });
  assert.equal(copy.tone, 'success');
  assert.equal(copy.title, 'Alert generated');
  assert.match(copy.detail, /stub/i, 'names the stub channel');
  assert.match(copy.detail, /no external notification was sent/i, 'states nothing was sent');
  assert.ok(!/was (sent|delivered) to your (email|phone)/i.test(copy.detail));
});

test('describeGenerateOutcome() — a replay is NOT described as generated', () => {
  const copy = describeGenerateOutcome({ kind: 'replayed', alert: alertFixture(), deliveries: [deliveryFixture()] });
  assert.equal(copy.tone, 'info');
  assert.equal(copy.title, 'Alert already exists');
  assert.match(copy.detail, /existing alert was returned/i);
  assert.match(copy.detail, /no second alert/i);
  assert.ok(!/alert generated/i.test(copy.title), 'must not claim a new alert');
});

test('describeGenerateOutcome() — a quality-gate skip is NOT described as generated', () => {
  const copy = describeGenerateOutcome({ kind: 'skipped', reason: 'below_min_quality' });
  assert.equal(copy.tone, 'warning');
  assert.match(copy.title, /no alert generated/i);
  assert.match(copy.detail, /below the strategy version’s minimum quality score gate/);
  assert.match(copy.detail, /no alert row was written/i);
  assert.ok(!/alert generated successfully/i.test(copy.detail));
});

// ---------------------------------------------------------------------------
// Acknowledgement idempotency
// ---------------------------------------------------------------------------

test('acknowledgeControlState() — enabled for a pending alert', () => {
  const state = acknowledgeControlState(alertFixture({ status: 'pending', acknowledgedAt: null }), false);
  assert.equal(state.disabled, false);
  assert.equal(state.label, 'Acknowledge');
  assert.equal(state.reason, null);
});

test('acknowledgeControlState() — disabled and labelled while the request is in flight', () => {
  const state = acknowledgeControlState(alertFixture({ status: 'pending', acknowledgedAt: null }), true);
  assert.equal(state.disabled, true, 'no second call can be fired mid-request');
  assert.equal(state.label, 'Acknowledging…');
});

test('acknowledgeControlState() — permanently disabled once acknowledged (idempotent)', () => {
  const acknowledged = alertFixture({ status: 'acknowledged', acknowledgedAt: '2024-05-21T09:00:00.000Z' });
  assert.equal(isAcknowledged(acknowledged), true);
  const idle = acknowledgeControlState(acknowledged, false);
  assert.equal(idle.disabled, true);
  assert.equal(idle.label, 'Acknowledged');
  assert.match(idle.reason ?? '', /already acknowledged/);
  // Re-acknowledging an already-acknowledged alert is still disabled.
  assert.equal(acknowledgeControlState(acknowledged, true).disabled, true);
});

test('acknowledgeControlState() — an acknowledged status without a timestamp is still actionable', () => {
  // Defensive: `isAcknowledged` requires both fields, so a partially written row
  // is not silently presented as done.
  const partial = alertFixture({ status: 'acknowledged', acknowledgedAt: null });
  assert.equal(isAcknowledged(partial), false);
  assert.equal(acknowledgeControlState(partial, false).disabled, false);
});

// ---------------------------------------------------------------------------
// Stub-delivery wording
// ---------------------------------------------------------------------------

test('stub-delivery copy never claims a real notification was sent', () => {
  assert.equal(STUB_DELIVERY_TITLE, 'Stub delivery only');
  assert.match(STUB_DELIVERY_BODY, /no email, webhook, push, sms or broker notification is sent/i);
  assert.match(STUB_DELIVERY_BODY, /real external delivery is not enabled/i);
  for (const banned of ['email sent', 'notification sent', 'push sent', 'sms sent', 'delivered to your inbox']) {
    assert.ok(!STUB_DELIVERY_BODY.toLowerCase().includes(banned), `copy must not claim "${banned}"`);
  }
});

test('describeDelivery() — the stub row is a local record, not a transmission', () => {
  const text = describeDelivery(deliveryFixture());
  assert.match(text, /recorded locally on the stub channel/i);
  assert.match(text, /nothing was transmitted externally/i);
  assert.ok(!/\bsent\b/i.test(text), 'must not say "sent"');

  const withError = describeDelivery(deliveryFixture({ status: 'failed', error: 'render failed' }));
  assert.match(withError, /ledger error: render failed/i);

  // A reserved channel value must never look like a live integration.
  const reserved = describeDelivery(deliveryFixture({ channel: 'email' }));
  assert.match(reserved, /not enabled in this milestone/i);
});

test('deliveryChannelLabel() — stub is labelled, reserved channels are marked not enabled', () => {
  assert.equal(deliveryChannelLabel('stub'), 'Stub (local ledger record)');
  assert.match(deliveryChannelLabel('email'), /reserved — not enabled/);
  assert.match(deliveryChannelLabel('webhook'), /reserved — not enabled/);
  assert.match(deliveryChannelLabel('push'), /reserved — not enabled/);
  // A channel the contracts do not define is still described as reserved,
  // never as a live integration.
  assert.match(deliveryChannelLabel('carrier-pigeon'), /reserved — not enabled/);
});

// ---------------------------------------------------------------------------
// Status, trigger state, grade + body narrowing
// ---------------------------------------------------------------------------

test('alert status/trigger labels cover the contract values', () => {
  for (const status of ALERT_STATUSES) {
    assert.ok(alertStatusLabel(status).length > 0, `label for ${status}`);
    assert.ok(['success', 'warning', 'neutral'].includes(alertStatusTone(status)));
  }
  assert.equal(alertStatusLabel('acknowledged'), 'Acknowledged');
  assert.equal(alertStatusLabel('pending'), 'Pending');
  assert.equal(alertStatusTone('acknowledged'), 'success');
  assert.equal(alertStatusTone('pending'), 'warning');
  for (const state of ALERT_TRIGGER_STATES) assert.ok(triggerStateLabel(state).length > 0);
  assert.equal(gradeTone('A+'), 'success');
  assert.equal(gradeTone('B'), 'info');
  assert.equal(gradeTone('C'), 'warning');
  assert.equal(gradeTone(null), 'neutral');
  assert.equal(ALERT_STATUS_FILTERS.length, ALERT_STATUSES.length + 1, 'one option per status + "all"');
  assert.equal(ALERT_STATUS_FILTERS[0]?.value, '');
});

test('readAlertBody() — narrows known fields and ignores unexpected shapes', () => {
  const body = readAlertBody(alertFixture().body);
  assert.equal(body.qualityGrade, 'A');
  assert.equal(body.entryPrice, 1.085);
  assert.equal(body.stopLossPrice, 1.08);
  assert.equal(body.tp3Price, 1.12);
  assert.equal(body.scoreId, 17);
  assert.equal(body.scoreEngineVersion, 'm5-score-1');
  assert.equal(body.detectedAt, '2024-05-20T12:00:00.000Z');

  // A missing/garbled payload renders as em dashes upstream, never as "0".
  const empty = readAlertBody({ qualityGrade: 42, entryPrice: 'nope', scoreId: null });
  assert.equal(empty.qualityGrade, null);
  assert.equal(empty.entryPrice, null);
  assert.equal(empty.scoreId, null);
  assert.equal(empty.tp1Price, null);
});

// ---------------------------------------------------------------------------
// Generate-from-setup source list
// ---------------------------------------------------------------------------

test('setupGenerateEligibility() — only confirmed/triggered can generate', () => {
  assert.equal(setupGenerateEligibility(setupFixture({ state: 'confirmed' })).eligible, true);
  assert.equal(setupGenerateEligibility(setupFixture({ state: 'triggered' })).eligible, true);
  for (const state of ['developing', 'watching', 'almost_ready'] as const) {
    const r = setupGenerateEligibility(setupFixture({ state }));
    assert.equal(r.eligible, false, state);
    assert.match(r.reason ?? '', /only confirmed or triggered setups can generate alerts/);
  }
  for (const state of ['completed', 'invalidated', 'expired'] as const) {
    const r = setupGenerateEligibility(setupFixture({ state }));
    assert.equal(r.eligible, false, state);
    assert.match(r.reason ?? '', /terminal setup/);
  }
});

test('sortSetupsForGenerate() — eligible first, newest detection first', () => {
  const a = setupFixture({ id: 'a'.padEnd(36, '0'), state: 'expired', detectedAt: '2024-05-25T00:00:00.000Z' });
  const b = setupFixture({ id: 'b'.padEnd(36, '0'), state: 'confirmed', detectedAt: '2024-05-21T00:00:00.000Z' });
  const c = setupFixture({ id: 'c'.padEnd(36, '0'), state: 'triggered', detectedAt: '2024-05-23T00:00:00.000Z' });
  const sorted = sortSetupsForGenerate([a, b, c]);
  assert.deepEqual(
    sorted.map((s) => s.id),
    [c.id, b.id, a.id],
  );
  // The input array is not mutated.
  assert.deepEqual(
    [a, b, c].map((s) => s.id),
    [a.id, b.id, c.id],
  );
});
