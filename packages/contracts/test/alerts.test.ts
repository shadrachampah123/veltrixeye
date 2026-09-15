import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_CHANNELS,
  ALERT_DELIVERY_STATUSES,
  ALERT_SKIPPED_REASONS,
  ALERT_STATUSES,
  ALERT_TRIGGER_STATES,
  DEFAULT_ALERTS_LIMIT,
  MAX_ALERTS_LIMIT,
  MAX_ALERT_DELIVERIES,
  alertAcknowledgeRequestSchema,
  alertDeliveryDtoSchema,
  alertDetailDtoSchema,
  alertDtoSchema,
  alertGenerateRequestSchema,
  alertGenerateResponseSchema,
  alertListQuerySchema,
  alertListResponseSchema,
} from '../src/index.js';

const CREATED = new Date(1_800_000_000_000).toISOString();

function validAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    setupId: '22222222-2222-4222-8222-222222222222',
    strategyId: '33333333-3333-4333-8333-333333333333',
    strategyVersionId: '44444444-4444-4444-8444-444444444444',
    versionNumber: 1,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'long',
    triggerState: 'confirmed',
    qualityScore: 80,
    minQualityScore: 65,
    title: 'EURUSD long setup confirmed (score 80/B)',
    body: { entryPrice: 1.1, grade: 'B' },
    status: 'pending',
    acknowledgedAt: null,
    createdAt: CREATED,
    ...overrides,
  };
}

function validDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    alertId: '11111111-1111-4111-8111-111111111111',
    channel: 'stub',
    status: 'delivered',
    attempt: 1,
    error: null,
    payloadHash: 'b'.repeat(64),
    createdAt: CREATED,
    ...overrides,
  };
}

describe('m6 alert contracts', () => {
  test('statuses, trigger states and channels are pinned', () => {
    assert.deepEqual([...ALERT_STATUSES], ['pending', 'acknowledged', 'suppressed']);
    assert.deepEqual([...ALERT_TRIGGER_STATES], ['confirmed', 'triggered']);
    assert.deepEqual([...ALERT_CHANNELS], ['stub', 'email', 'webhook', 'push']);
    assert.deepEqual([...ALERT_DELIVERY_STATUSES], ['delivered', 'failed']);
    assert.deepEqual([...ALERT_SKIPPED_REASONS], ['below_min_quality']);
    assert.equal(DEFAULT_ALERTS_LIMIT, 50);
    assert.equal(MAX_ALERTS_LIMIT, 100);
    assert.equal(MAX_ALERT_DELIVERIES, 64);
  });

  test('generate request defaults to the setup state; only confirmed/triggered accepted', () => {
    assert.deepEqual(alertGenerateRequestSchema.parse({}), {});
    assert.equal(alertGenerateRequestSchema.parse({ triggerState: 'confirmed' }).triggerState, 'confirmed');
    assert.equal(alertGenerateRequestSchema.parse({ triggerState: 'triggered' }).triggerState, 'triggered');
    assert.equal(alertGenerateRequestSchema.safeParse({ triggerState: 'watching' }).success, false);
    assert.equal(alertGenerateRequestSchema.safeParse({ triggerState: 'completed' }).success, false);
    assert.equal(alertGenerateRequestSchema.safeParse({ triggerState: 'confirmed', force: true }).success, false);
  });

  test('acknowledge request is empty and strict', () => {
    assert.deepEqual(alertAcknowledgeRequestSchema.parse({}), {});
    assert.equal(alertAcknowledgeRequestSchema.safeParse({ note: 'seen' }).success, false);
  });

  test('alert DTO accepts a generated alert and enforces bounds', () => {
    assert.equal(alertDtoSchema.safeParse(validAlert()).success, true);
    assert.equal(
      alertDtoSchema.safeParse(validAlert({ status: 'acknowledged', acknowledgedAt: CREATED })).success,
      true,
    );
    assert.equal(alertDtoSchema.safeParse(validAlert({ triggerState: 'watching' })).success, false);
    assert.equal(alertDtoSchema.safeParse(validAlert({ status: 'sent' })).success, false);
    assert.equal(alertDtoSchema.safeParse(validAlert({ direction: 'both' })).success, false);
    assert.equal(alertDtoSchema.safeParse(validAlert({ qualityScore: 101 })).success, false);
    assert.equal(alertDtoSchema.safeParse(validAlert({ qualityScore: -1 })).success, false);
    assert.equal(alertDtoSchema.safeParse(validAlert({ minQualityScore: 101 })).success, false);
    assert.equal(alertDtoSchema.safeParse(validAlert({ title: '' })).success, false);
    assert.equal(alertDtoSchema.safeParse(validAlert({ title: 'x'.repeat(281) })).success, false);
    assert.equal(alertDtoSchema.safeParse({ ...validAlert(), priority: 'high' }).success, false);
  });

  test('delivery DTO requires a sha256 payload hash and a known channel/status', () => {
    assert.equal(alertDeliveryDtoSchema.safeParse(validDelivery()).success, true);
    assert.equal(alertDeliveryDtoSchema.safeParse(validDelivery({ channel: 'sms' })).success, false);
    assert.equal(alertDeliveryDtoSchema.safeParse(validDelivery({ status: 'queued' })).success, false);
    assert.equal(alertDeliveryDtoSchema.safeParse(validDelivery({ attempt: 0 })).success, false);
    assert.equal(alertDeliveryDtoSchema.safeParse(validDelivery({ payloadHash: 'short' })).success, false);
    assert.equal(
      alertDeliveryDtoSchema.safeParse(validDelivery({ error: 'x'.repeat(2001) })).success,
      false,
    );
    assert.equal(alertDeliveryDtoSchema.safeParse({ ...validDelivery(), vendor: 'x' }).success, false);
  });

  test('alert detail caps deliveries at MAX_ALERT_DELIVERIES', () => {
    const one = alertDetailDtoSchema.safeParse({ alert: validAlert(), deliveries: [validDelivery()] });
    assert.equal(one.success, true);
    const many = Array.from({ length: MAX_ALERT_DELIVERIES + 1 }, (_, id) => validDelivery({ id: id + 1 }));
    assert.equal(alertDetailDtoSchema.safeParse({ alert: validAlert(), deliveries: many }).success, false);
  });

  test('generate response covers created, replayed and gate-skipped outcomes', () => {
    const created = { alert: validAlert(), created: true, deliveries: [validDelivery()] };
    assert.equal(alertGenerateResponseSchema.safeParse(created).success, true);
    const replayed = { alert: validAlert(), created: false, deliveries: [validDelivery()] };
    assert.equal(alertGenerateResponseSchema.safeParse(replayed).success, true);
    const skipped = { alert: null, created: false, skippedReason: 'below_min_quality' };
    assert.equal(alertGenerateResponseSchema.safeParse(skipped).success, true);
    // Unknown keys, unknown reasons and a missing `created` are rejected.
    assert.equal(alertGenerateResponseSchema.safeParse({ ...skipped, extra: 1 }).success, false);
    assert.equal(
      alertGenerateResponseSchema.safeParse({ alert: null, created: false, skippedReason: 'muted' }).success,
      false,
    );
    assert.equal(alertGenerateResponseSchema.safeParse({ alert: validAlert() }).success, false);
    assert.equal(
      alertGenerateResponseSchema.safeParse({ alert: validAlert(), created: true, deliveries: 'none' }).success,
      false,
    );
  });

  test('list response caps the page at MAX_ALERTS_LIMIT and is strict', () => {
    assert.equal(alertListResponseSchema.safeParse({ alerts: [validAlert()] }).success, true);
    assert.equal(alertListResponseSchema.safeParse({ alerts: [] }).success, true);
    assert.equal(alertListResponseSchema.safeParse({ alerts: [], total: 1 }).success, false);
    const tooMany = Array.from({ length: MAX_ALERTS_LIMIT + 1 }, () => validAlert());
    assert.equal(alertListResponseSchema.safeParse({ alerts: tooMany }).success, false);
  });

  test('list query defaults, coerces and bounds the limit', () => {
    assert.deepEqual(alertListQuerySchema.parse({}), { limit: 50 });
    assert.equal(alertListQuerySchema.parse({ limit: '10' }).limit, 10);
    assert.equal(alertListQuerySchema.parse({ status: 'pending' }).status, 'pending');
    assert.equal(alertListQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(alertListQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(alertListQuerySchema.safeParse({ status: 'sent' }).success, false);
    assert.equal(alertListQuerySchema.safeParse({ strategyId: 'not-a-uuid' }).success, false);
    assert.equal(alertListQuerySchema.safeParse({ limit: 10, unread: true }).success, false);
  });
});
