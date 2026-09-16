import { z } from 'zod';
import { detectionInstrumentSchema, setupDirectionSchema } from './detection.js';
import { alertTriggerStateSchema } from './alerts.js';

/**
 * Notification-delivery contracts (M7.3).
 *
 * M7.3 turns M6's *stub* delivery ledger into a real, reliable delivery
 * pipeline without touching the alert domain itself:
 *
 *   alert created → durable outbox job → worker claims the job →
 *   provider adapter sends it → result recorded → retry / success /
 *   permanent failure
 *
 * The **strategy engine and the alert service never talk to a provider**:
 * they write a durable outbox row (`notification_deliveries`) inside the same
 * transaction as the alert, and a worker — nothing else — resolves a
 * `NotificationProvider` for the job's channel and performs the I/O.
 *
 * Scope of this milestone:
 *  - exactly ONE channel is implemented: `email` (SMTP). `webhook`, `push`
 *    and `sms` are deliberately absent from the enum: adding a channel is an
 *    additive change (a new enum value + a provider adapter), and shipping
 *    unimplemented enum values would let callers queue jobs that can never
 *    be delivered.
 *  - no user preference system: an alert is delivered to the owner's account
 *    email. Preferences are a later, separate milestone.
 *  - no fake delivery: a job with no configured provider is recorded as
 *    `unavailable`, never as `delivered`.
 *
 * Deduplication: at most one outbox job per (alert, channel), keyed by a
 * deterministic `idempotency_key`. Replays of the alert-generation request,
 * worker crashes and repeated API calls all collapse onto that one row.
 */

/** Delivery channels with a provider adapter in this build. */
export const NOTIFICATION_CHANNELS = ['email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * The channel an alert is queued for. Alerts go to the owner's account email;
 * a second channel is an additive change (enum value + provider adapter),
 * never a rewrite of the outbox.
 */
export const DEFAULT_NOTIFICATION_CHANNEL: NotificationChannel = 'email';

/**
 * Outbox job lifecycle.
 *
 * - `pending`    — waiting for a worker (fresh job, or a scheduled retry
 *                  whose `nextAttemptAt` has not arrived yet).
 * - `processing` — claimed by a worker under a lease (`lockedAt`).
 * - `delivered`  — the provider accepted the message (terminal).
 * - `failed`     — dead-lettered: permanent provider rejection or the retry
 *                  budget is exhausted (terminal).
 * - `unavailable`— no provider is configured for the channel. NOT a delivery
 *                  and NOT a provider fault: the job stays auditable and is
 *                  re-queued automatically once a configured provider exists
 *                  (terminal until then, so it can never spin).
 */
export const NOTIFICATION_STATUSES = [
  'pending',
  'processing',
  'delivered',
  'failed',
  'unavailable',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Terminal statuses: a worker never claims these again. */
export const TERMINAL_NOTIFICATION_STATUSES = ['delivered', 'failed'] as const;

/**
 * Why the last attempt ended the way it did. Recorded on every attempt so a
 * failure can be triaged from the row alone (no log digging, no secrets).
 */
export const NOTIFICATION_FAILURE_CATEGORIES = [
  'none', // never failed (fresh job, or last attempt succeeded)
  'configuration', // no provider configured for this channel
  'transient', // provider-reported temporary failure → retry
  'permanent', // provider-reported permanent failure (bad recipient, rejected)
  'timeout', // provider did not answer in time → retry
  'stale', // the worker holding the lease died → recovered
  'unknown', // unexpected exception → retry until the budget is exhausted
] as const;
export type NotificationFailureCategory = (typeof NOTIFICATION_FAILURE_CATEGORIES)[number];

/** Template/renderer identifier stored with every job (`template` column). */
export const ALERT_NOTIFICATION_TEMPLATE = 'alert.email.v1';

/** Max jobs returned for one alert (an alert has at most one per channel). */
export const MAX_NOTIFICATIONS_PER_ALERT = 16;

/** Retry / worker defaults (overridable through the API environment). */
export const DEFAULT_NOTIFICATION_MAX_ATTEMPTS = 5;
export const DEFAULT_NOTIFICATION_BATCH_SIZE = 25;
export const MAX_NOTIFICATION_BATCH_SIZE = 200;
export const DEFAULT_NOTIFICATION_LEASE_MS = 120_000;
export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 15_000;
export const DEFAULT_NOTIFICATION_BASE_BACKOFF_MS = 30_000;
export const DEFAULT_NOTIFICATION_MAX_BACKOFF_MS = 3_600_000;
export const DEFAULT_NOTIFICATION_JITTER_MS = 5_000;
export const DEFAULT_NOTIFICATION_WORKER_INTERVAL_MS = 60_000;

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);
export const notificationFailureCategorySchema = z.enum(NOTIFICATION_FAILURE_CATEGORIES);

/**
 * Structured, server-rendered alert facts handed to a provider.
 *
 * Everything here is derived from the PERSISTED alert (plus the published
 * strategy-version config), never from request input: a client can choose to
 * generate an alert, but it can never influence the direction, levels, score
 * or identity that get delivered.
 */
export const alertNotificationDataSchema = z
  .object({
    alertId: z.string().uuid(),
    setupId: z.string().uuid(),
    strategyId: z.string().uuid(),
    strategyVersionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    instrument: detectionInstrumentSchema,
    /** Setup timeframe of the strategy version that produced the alert. */
    timeframe: z.string().min(1).max(16).nullable(),
    direction: setupDirectionSchema,
    triggerState: alertTriggerStateSchema,
    qualityScore: z.number().int().min(0).max(100),
    qualityGrade: z.string().min(1).max(8),
    minQualityScore: z.number().int().min(0).max(100),
    entryPrice: z.number().nullable(),
    stopLossPrice: z.number().nullable(),
    tp1Price: z.number().nullable(),
    tp2Price: z.number().nullable(),
    tp3Price: z.number().nullable(),
    /** Detection anchor (UTC ISO). */
    detectedAt: z.string().datetime(),
    /** Alert row creation time (UTC ISO). */
    generatedAt: z.string().datetime(),
  })
  .strict();
export type AlertNotificationData = z.infer<typeof alertNotificationDataSchema>;

/** The rendered message a provider sends (stored verbatim with the job). */
export const alertNotificationPayloadSchema = z
  .object({
    /** Renderer/version identifier — part of the idempotency key. */
    template: z.string().min(1).max(64),
    subject: z.string().min(1).max(200),
    text: z.string().min(1).max(8000),
    data: alertNotificationDataSchema,
  })
  .strict();
export type AlertNotificationPayload = z.infer<typeof alertNotificationPayloadSchema>;

/**
 * Owner-visible view of one outbox job.
 *
 * Deliberately excludes everything a client has no business reading: the
 * recipient address, the rendered payload, provider error text and any
 * upstream identifier. The failure *category* is enough to explain a delay.
 */
export const notificationDtoSchema = z
  .object({
    id: z.string().uuid(),
    alertId: z.string().uuid(),
    channel: notificationChannelSchema,
    status: notificationStatusSchema,
    attempts: z.number().int().min(0).max(100),
    maxAttempts: z.number().int().min(1).max(10),
    failureCategory: notificationFailureCategorySchema,
    /** Provider adapter that handled the last attempt (`smtp`), else null. */
    provider: z.string().min(1).max(64).nullable(),
    nextAttemptAt: z.string().datetime().nullable(),
    deliveredAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type NotificationDto = z.infer<typeof notificationDtoSchema>;

/** GET /api/alerts/:alertId/notifications response. */
export const notificationListResponseSchema = z
  .object({
    notifications: z.array(notificationDtoSchema).max(MAX_NOTIFICATIONS_PER_ALERT),
  })
  .strict();
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

/** Body of the internal worker trigger (all fields optional). */
export const notificationRunRequestSchema = z
  .object({
    batchSize: z.number().int().min(1).max(MAX_NOTIFICATION_BATCH_SIZE).optional(),
  })
  .strict();
export type NotificationRunRequest = z.infer<typeof notificationRunRequestSchema>;

/** Result of one worker batch — the numbers an operator/scheduler sees. */
export const notificationRunResponseSchema = z
  .object({
    claimed: z.number().int().min(0),
    delivered: z.number().int().min(0),
    retried: z.number().int().min(0),
    failed: z.number().int().min(0),
    unavailable: z.number().int().min(0),
    /** Jobs a crashed worker had claimed and that were returned to pending. */
    recovered: z.number().int().min(0),
    /** …and the ones whose retry budget was already gone (dead-lettered here). */
    deadLettered: z.number().int().min(0),
    /** Jobs re-queued because a provider became available. */
    requeued: z.number().int().min(0),
  })
  .strict();
export type NotificationRunResponse = z.infer<typeof notificationRunResponseSchema>;

/** Body of the internal maintenance trigger (all fields optional). */
export const notificationMaintenanceRequestSchema = z
  .object({
    deliveredRetentionDays: z.number().int().min(1).max(3650).optional(),
    failedRetentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type NotificationMaintenanceRequest = z.infer<typeof notificationMaintenanceRequestSchema>;

/** Maintenance result, including the current queue depth per status. */
export const notificationMaintenanceResponseSchema = z
  .object({
    recovered: z.number().int().min(0),
    deadLettered: z.number().int().min(0),
    requeued: z.number().int().min(0),
    deleted: z.number().int().min(0),
    depth: z.object({
      pending: z.number().int().min(0),
      processing: z.number().int().min(0),
      delivered: z.number().int().min(0),
      failed: z.number().int().min(0),
      unavailable: z.number().int().min(0),
    }),
  })
  .strict();
export type NotificationMaintenanceResponse = z.infer<typeof notificationMaintenanceResponseSchema>;
