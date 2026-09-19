import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_NOTIFICATION_TEMPLATE,
  DEFAULT_NOTIFICATION_BASE_BACKOFF_MS,
  DEFAULT_NOTIFICATION_CHANNEL,
  DEFAULT_NOTIFICATION_JITTER_MS,
  DEFAULT_NOTIFICATION_LEASE_MS,
  DEFAULT_NOTIFICATION_MAX_ATTEMPTS,
  DEFAULT_NOTIFICATION_MAX_BACKOFF_MS,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  DEFAULT_NOTIFICATION_WORKER_INTERVAL_MS,
  MAX_NOTIFICATIONS_PER_ALERT,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_FAILURE_CATEGORIES,
  NOTIFICATION_STATUSES,
  TERMINAL_NOTIFICATION_STATUSES,
  alertNotificationPayloadSchema,
  notificationDtoSchema,
  notificationMaintenanceRequestSchema,
  notificationMaintenanceResponseSchema,
  notificationListResponseSchema,
  notificationRunRequestSchema,
  notificationRunResponseSchema,
  notificationPreferenceSchema,
  notificationPreferenceRequestSchema,
  notificationPreferencesRequestSchema,
  strategyNotificationPreferenceSchema,
  strategyNotificationPreferenceRequestSchema,
  pushSubscriptionSchema,
  pushSubscriptionRequestSchema,
  vapidPublicKeyResponseSchema,
} from '../src/index.js';

const CREATED = new Date(1_800_000_000_000).toISOString();

function validNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    alertId: '22222222-2222-4222-8222-222222222222',
    channel: 'email',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    failureCategory: 'none',
    provider: null,
    nextAttemptAt: CREATED,
    deliveredAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    template: ALERT_NOTIFICATION_TEMPLATE,
    subject: 'EURUSD long setup confirmed — quality 80/100 (B)',
    text: 'VeltrixEye alert — EURUSD long setup confirmed',
    data: {
      alertId: '22222222-2222-4222-8222-222222222222',
      setupId: '33333333-3333-4333-8333-333333333333',
      strategyId: '44444444-4444-4444-8444-444444444444',
      strategyVersionId: '55555555-5555-4555-8555-555555555555',
      versionNumber: 3,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      timeframe: '1h',
      direction: 'long',
      triggerState: 'confirmed',
      qualityScore: 80,
      qualityGrade: 'B',
      minQualityScore: 65,
      entryPrice: 1.105,
      stopLossPrice: 1.1,
      tp1Price: 1.11,
      tp2Price: 1.115,
      tp3Price: 1.12,
      detectedAt: CREATED,
      generatedAt: CREATED,
    },
    ...overrides,
  };
}

describe('m7.3 notification contracts', () => {
  test('channels, statuses and failure categories are pinned', () => {
    assert.deepEqual([...NOTIFICATION_CHANNELS], ['email', 'webhook', 'push']);
    assert.deepEqual([...NOTIFICATION_STATUSES], ['pending', 'processing', 'delivered', 'failed', 'unavailable']);
    assert.deepEqual([...TERMINAL_NOTIFICATION_STATUSES], ['delivered', 'failed']);
    assert.deepEqual([...NOTIFICATION_FAILURE_CATEGORIES], [
      'none',
      'configuration',
      'transient',
      'permanent',
      'timeout',
      'stale',
      'unknown',
    ]);
    assert.equal(DEFAULT_NOTIFICATION_CHANNEL, 'email');
    assert.equal(ALERT_NOTIFICATION_TEMPLATE, 'alert.email.v1');
    assert.equal(MAX_NOTIFICATIONS_PER_ALERT, 16);
  });

  test('retry/worker defaults are pinned', () => {
    assert.equal(DEFAULT_NOTIFICATION_MAX_ATTEMPTS, 5);
    assert.equal(DEFAULT_NOTIFICATION_TIMEOUT_MS, 15_000);
    assert.equal(DEFAULT_NOTIFICATION_LEASE_MS, 120_000);
    assert.equal(DEFAULT_NOTIFICATION_BASE_BACKOFF_MS, 30_000);
    assert.equal(DEFAULT_NOTIFICATION_MAX_BACKOFF_MS, 3_600_000);
    assert.equal(DEFAULT_NOTIFICATION_JITTER_MS, 5_000);
    assert.equal(DEFAULT_NOTIFICATION_WORKER_INTERVAL_MS, 60_000);
  });

  test('the owner-visible DTO exposes no recipient, payload or provider error', () => {
    const parsed = notificationDtoSchema.parse(validNotification());
    assert.deepEqual(Object.keys(parsed).sort(), [
      'alertId',
      'attempts',
      'channel',
      'createdAt',
      'deliveredAt',
      'failureCategory',
      'id',
      'maxAttempts',
      'nextAttemptAt',
      'provider',
      'status',
      'updatedAt',
    ]);
    // Strict: any extra key (recipient, payload, lastError …) is rejected.
    assert.equal(notificationDtoSchema.safeParse(validNotification({ recipient: 'a@b.com' })).success, false);
    assert.equal(notificationDtoSchema.safeParse(validNotification({ payload: {} })).success, false);
    assert.equal(notificationDtoSchema.safeParse(validNotification({ lastError: 'boom' })).success, false);
    assert.equal(notificationDtoSchema.safeParse(validNotification({ channel: 'sms' })).success, false);
    assert.equal(notificationDtoSchema.safeParse(validNotification({ status: 'retrying' })).success, false);
    assert.equal(notificationDtoSchema.safeParse(validNotification({ channel: 'push' })).success, true, 'push is valid channel in M9.2');
  });

  test('rendered payloads carry the alert facts and nothing caller-supplied', () => {
    assert.equal(alertNotificationPayloadSchema.safeParse(validPayload()).success, true);
    // A payload without the structured facts is not a notification.
    const { data, ...withoutData } = validPayload() as Record<string, unknown>;
    assert.ok(data);
    assert.equal(alertNotificationPayloadSchema.safeParse(withoutData).success, false);
    assert.equal(
      alertNotificationPayloadSchema.safeParse(validPayload({ subject: 'x'.repeat(201) })).success,
      false,
      'subject is capped at 200 chars',
    );
  });

  test('M9.1 preference schemas keep webhook secrets write-only', () => {
    const preference = notificationPreferenceSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      channel: 'webhook',
      enabled: true,
      endpointUrl: 'https://hooks.example.test/alerts',
      createdAt: CREATED,
      updatedAt: CREATED,
    });
    assert.equal(preference.channel, 'webhook');
    assert.equal(
      notificationPreferenceRequestSchema.safeParse({
        channel: 'webhook',
        endpointUrl: 'https://hooks.example.test/alerts',
        signingSecret: 'secret',
      }).success,
      true,
    );
    assert.equal(
      notificationPreferenceRequestSchema.safeParse({
        channel: 'webhook',
        endpointUrl: 'http://hooks.example.test/alerts',
      }).success,
      false,
      'HTTPS policy enforced in M9.2',
    );
    assert.equal(notificationPreferenceSchema.safeParse({ ...preference, signingSecret: 'secret' }).success, false);
  });

  test('M9.2 push accepted, invalid push rejected, channel max 3', () => {
    assert.equal(
      notificationPreferenceRequestSchema.safeParse({
        channel: 'push',
        endpointUrl: 'https://fcm.googleapis.com/fcm/send/abc',
        signingSecret: JSON.stringify({ p256dh: 'B'.repeat(87) + '_-A', auth: 'abcd1234_-AB' }),
      }).success,
      true,
    );
    assert.equal(
      notificationPreferenceRequestSchema.safeParse({
        channel: 'push',
        endpointUrl: 'http://fcm.googleapis.com/fcm/send/abc',
      }).success,
      false,
      'push must be https',
    );
    assert.equal(
      notificationPreferencesRequestSchema.safeParse({
        preferences: [
          { channel: 'email', enabled: true },
          { channel: 'webhook', enabled: true, endpointUrl: 'https://hooks.example.test' },
          { channel: 'push', enabled: true, endpointUrl: 'https://push.example.test' },
        ],
      }).success,
      true,
    );
    assert.equal(
      notificationPreferencesRequestSchema.safeParse({
        preferences: [
          { channel: 'email', enabled: true },
          { channel: 'webhook', enabled: true, endpointUrl: 'https://hooks.example.test' },
          { channel: 'push', enabled: true, endpointUrl: 'https://push.example.test' },
          { channel: 'email', enabled: true },
        ],
      }).success,
      false,
      'max 3',
    );
    assert.equal(
      strategyNotificationPreferenceRequestSchema.safeParse({
        muted: false,
        channels: ['email', 'webhook', 'push'],
      }).success,
      true,
    );
    assert.equal(
      strategyNotificationPreferenceRequestSchema.safeParse({
        muted: false,
        channels: ['email', 'webhook', 'push', 'email'],
      }).success,
      false,
      'max 3 strategy',
    );
  });

  test('M9.2 push subscription schema strict, secrets excluded from DTOs', () => {
    const validSub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'B'.repeat(20) + '_-_' + 'A'.repeat(10), auth: 'auth123_-_' + 'B'.repeat(10) },
    };
    assert.equal(pushSubscriptionSchema.safeParse(validSub).success, true);
    assert.equal(pushSubscriptionRequestSchema.safeParse(validSub).success, true);
    assert.equal(
      pushSubscriptionSchema.safeParse({ endpoint: 'http://fcm.googleapis.com/fcm/send/abc', keys: validSub.keys }).success,
      false,
      'push endpoint must be https',
    );
    assert.equal(
      pushSubscriptionSchema.safeParse({ endpoint: validSub.endpoint, keys: { p256dh: 'bad!' } }).success,
      false,
      'invalid p256dh',
    );
    assert.equal(vapidPublicKeyResponseSchema.safeParse({ publicKey: 'B'.repeat(87) }).success, true);
    // DTO must not contain secrets
    const pref = notificationPreferenceSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      channel: 'push',
      enabled: true,
      endpointUrl: 'https://push.example.test',
      createdAt: CREATED,
      updatedAt: CREATED,
    });
    assert.equal((pref as unknown as Record<string, unknown>).signingSecret, undefined);
    assert.equal(notificationPreferenceSchema.safeParse({ ...pref, p256dh: 'secret' }).success, false);
  });

  test('list/run/maintenance schemas are strict and bounded', () => {
    assert.equal(notificationListResponseSchema.safeParse({ notifications: [validNotification()] }).success, true);
    assert.equal(notificationListResponseSchema.safeParse({ notifications: [] }).success, true);
    assert.equal(notificationListResponseSchema.safeParse({ notifications: [], extra: true }).success, false);

    assert.deepEqual(notificationRunRequestSchema.parse({}), {});
    assert.equal(notificationRunRequestSchema.safeParse({ batchSize: 0 }).success, false);
    assert.equal(notificationRunRequestSchema.safeParse({ batchSize: 201 }).success, false);
    assert.equal(notificationRunRequestSchema.safeParse({ alertId: 'x' }).success, false);

    assert.equal(
      notificationRunResponseSchema.safeParse({
        claimed: 1,
        delivered: 1,
        retried: 0,
        failed: 0,
        unavailable: 0,
        recovered: 0,
        deadLettered: 0,
        requeued: 0,
      }).success,
      true,
    );
    assert.equal(notificationRunResponseSchema.safeParse({ claimed: 1, delivered: 1 }).success, false, 'every counter is required');

    assert.deepEqual(notificationMaintenanceRequestSchema.parse({}), {});
    assert.equal(notificationMaintenanceRequestSchema.safeParse({ deliveredRetentionDays: 0 }).success, false);
    assert.equal(
      notificationMaintenanceResponseSchema.safeParse({
        recovered: 0,
        deadLettered: 0,
        requeued: 0,
        deleted: 0,
        depth: { pending: 0, processing: 0, delivered: 0, failed: 0, unavailable: 0 },
      }).success,
      true,
    );
  });
});
