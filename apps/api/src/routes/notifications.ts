import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  notificationMaintenanceRequestSchema,
  notificationRunRequestSchema,
  notificationPreferencesRequestSchema,
  pushSubscriptionRequestSchema,
  strategyNotificationPreferenceRequestSchema,
} from '@veltrixeye/contracts';
import { Errors, type NotificationSendRequest } from '@veltrixeye/core';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import { recordWorkerFailure, recordWorkerStart, recordWorkerSuccess } from '../worker-liveness.js';

/**
 * M7.3 notification routes.
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | `GET /api/alerts/:alertId/notifications` | session | Owner-scoped; foreign/unknown ids are masked as 404. Returns status/attempt/failure-category only — never the recipient, payload or provider error. |
 * | `POST /api/internal/notifications/deliveries/run` | worker token | Runs one delivery batch (recover stale → re-queue what became deliverable → claim → send). 404 when no token is configured. |
 * | `POST /api/internal/notifications/deliveries/maintenance` | worker token | Stale recovery + retention + queue depth. 404 when no token is configured. |
 * | `POST /api/internal/notifications/smtp-test` | worker token + explicit feature flag | One fixed-recipient SMTP diagnostic, guarded by a separate singleton claim; never touches the shared outbox or worker. |
 *
 * Why an internal HTTP trigger exists at all: the API is a container a
 * platform may stop at any time (the Render free tier spins down), so delivery
 * cannot depend on a process that is always awake. `runOnce()` is safe to call
 * from an in-process ticker AND from an external scheduler at the same time —
 * claims are `FOR UPDATE SKIP LOCKED`, so the two never deliver the same job.
 *
 * Security:
 *  - the internal routes are **not registered at all** unless
 *    `NOTIFICATION_WORKER_TOKEN` is set (404, not 401 — an unconfigured
 *    deployment must not advertise an administrative surface);
 *  - the token is compared in constant time over SHA-256 digests, so neither
 *    the length nor the prefix leaks through response timing;
 *  - worker routes are rate limited and accept no caller-selected alert,
 *    recipient or message payload;
 *  - the SMTP diagnostic additionally requires its explicit feature flag,
 *    uses one fixed recipient and a separate permanent claim for ambiguous
 *    outcomes, and never reads or writes the shared delivery queue;
 *  - no response ever contains a credential, recipient address or provider
 *    error text (only redacted outcomes and failure categories).
 */

/** Header carrying the shared worker secret. */
const WORKER_TOKEN_HEADER = 'x-veltrixeye-worker-token';

export async function notificationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  config: AppConfig,
): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);
  const adminRateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const preferenceRateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/api/notifications/preferences', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    return ctx.preferences.preferencesResponse(user.id);
  });

  app.put('/api/notifications/preferences', preferenceRateLimit, async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = notificationPreferencesRequestSchema.safeParse(req.body);
    if (!parsed.success) { sendZodError(reply, parsed.error, 'body'); return; }
    const { user } = req as AuthenticatedRequest;
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const preference of parsed.data.preferences) await ctx.preferences.upsert(user.id, preference, client);
      if (parsed.data.quietHours !== undefined) await ctx.preferences.saveSettings(user.id, parsed.data.quietHours, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
    await ctx.audit.log({ userId: user.id, action: 'notification.preferences_updated', ip: req.ip, userAgent: req.headers['user-agent'] ?? null, metadata: { channels: parsed.data.preferences.map((p) => p.channel), quietHoursChanged: parsed.data.quietHours !== undefined } });
    return ctx.preferences.preferencesResponse(user.id);
  });

  app.get('/api/notifications/preferences/strategies', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    return { preferences: await ctx.preferences.listStrategies((req as AuthenticatedRequest).user.id) };
  });

  app.get('/api/notifications/preferences/strategies/:strategyId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { strategyId } = req.params as { strategyId: string };
    if (!isUuid(strategyId)) throw Errors.notFound('Strategy not found');
    return { preference: await ctx.preferences.getStrategy((req as AuthenticatedRequest).user.id, strategyId) };
  });

  app.put('/api/notifications/preferences/strategies/:strategyId', preferenceRateLimit, async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { strategyId } = req.params as { strategyId: string };
    if (!isUuid(strategyId)) throw Errors.notFound('Strategy not found');
    const parsed = strategyNotificationPreferenceRequestSchema.safeParse(req.body);
    if (!parsed.success) { sendZodError(reply, parsed.error, 'body'); return; }
    const { user } = req as AuthenticatedRequest;
    const preference = await ctx.preferences.upsertStrategy(user.id, strategyId, parsed.data);
    await ctx.audit.log({ userId: user.id, action: 'notification.strategy_preferences_updated', entityType: 'strategy', entityId: strategyId, ip: req.ip, userAgent: req.headers['user-agent'] ?? null, metadata: { muted: preference.muted, channels: preference.channels } });
    return { preference };
  });

  // M9.2 — push VAPID public key (authenticated, public key is not secret but still owner-scoped to avoid enumeration)
  app.get('/api/notifications/push/vapid-public-key', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const publicKey = config.notification.push.publicKey;
    if (!publicKey) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Push not configured' } });
    }
    return { publicKey };
  });

  // M9.2 — push subscription creation (owner-scoped, encrypted at rest)
  app.post('/api/notifications/push/subscriptions', preferenceRateLimit, async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = pushSubscriptionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    const preference = await ctx.preferences.upsertPushSubscription(user.id, parsed.data);
    await ctx.audit.log({
      userId: user.id,
      action: 'notification.push_subscription_created',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      metadata: { endpoint: parsed.data.endpoint.slice(0, 80) }, // truncated, no keys
    });
    return { preference };
  });

  // M9.2 — narrowly scoped delete for push/webhook/email preferences
  app.delete('/api/notifications/preferences/:channel', preferenceRateLimit, async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { channel } = req.params as { channel: string };
    if (!['email', 'webhook', 'push'].includes(channel)) {
      throw Errors.notFound('Channel not found');
    }
    const { user } = req as AuthenticatedRequest;
    await ctx.preferences.remove(user.id, channel as never);
    await ctx.audit.log({
      userId: user.id,
      action: 'notification.preference_removed',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      metadata: { channel },
    });
    return { ok: true };
  });

  // GET /api/alerts/:alertId/notifications — owner-scoped delivery status
  app.get('/api/alerts/:alertId/notifications', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { alertId } = req.params as { alertId: string };
    if (!isUuid(alertId)) throw Errors.notFound('Alert not found');
    // Owner scoping lives in the service: it throws a masked 404 when the
    // alert belongs to somebody else, so the route cannot leak existence.
    return ctx.notifications.listForAlert(user.id, alertId).then((notifications) => ({ notifications }));
  });

  // One-time SMTP diagnostic. This is deliberately independent of the shared outbox/worker.
  // It is invisible unless BOTH the feature flag and worker token are configured.
  app.post('/api/internal/notifications/smtp-test', adminRateLimit, async (req, reply) => {
    if (!config.notification.smtpTestEnabled || !hasWorkerToken(config)) return notFound(reply);
    if (!tokenMatches(req, config)) return unauthorized(reply);
    if (!ctx.smtpTestProvider?.configured) {
      return reply.code(503).send({ status: 'unavailable', reason: 'smtp_not_configured' });
    }

    // The singleton key is fixed in code and protected by a primary key in
    // its own table. Claim commits before network I/O; never release on timeout.
    const claim = await ctx.pool.query<{ test_key: string }>(
      `INSERT INTO notification_smtp_test_claims (test_key)
       VALUES ('production-smtp-diagnostic-v1')
       ON CONFLICT (test_key) DO NOTHING
       RETURNING test_key`,
    );
    if (claim.rowCount !== 1) {
      return reply.code(409).send({ status: 'already_claimed' });
    }

    const diagnosticTimestamp = new Date().toISOString();
    const request = {
      jobId: 'smtp-diagnostic-once',
      idempotencyKey: 'smtp-diagnostic-once',
      channel: 'email',
      recipient: 'shadrachampah123@gmail.com',
      template: 'operator.smtp-diagnostic.v1',
      payload: {
        template: 'operator.smtp-diagnostic.v1',
        subject: 'VeltrixEye SMTP diagnostic',
        text: 'This is the one-time SMTP delivery diagnostic requested by the VeltrixEye operator.',
        data: {
          alertId: '00000000-0000-4000-8000-000000000039',
          setupId: '00000000-0000-4000-8000-000000000039',
          strategyId: '00000000-0000-4000-8000-000000000039',
          strategyVersionId: '00000000-0000-4000-8000-000000000039',
          versionNumber: 1,
          instrument: { assetClass: 'forex', symbol: 'EURUSD' },
          timeframe: '1h',
          direction: 'long',
          triggerState: 'confirmed',
          qualityScore: 75,
          qualityGrade: 'B',
          minQualityScore: 50,
          entryPrice: null,
          stopLossPrice: null,
          tp1Price: null,
          tp2Price: null,
          tp3Price: null,
          detectedAt: diagnosticTimestamp,
          generatedAt: diagnosticTimestamp,
        },
      },
      attempt: 1,
      timeoutMs: config.notification.email.timeoutMs,
    } satisfies NotificationSendRequest;
    try {
      const result = await ctx.smtpTestProvider.send(request);
      // SMTP AUTH failures are classified by the adapter as configuration
      // failures before an envelope/message can be accepted. Release only
      // that definitive pre-send failure so an operator can correct credentials
      // and retry. Every ambiguous transport outcome keeps the claim forever.
      if (result.outcome === 'unavailable' && result.failureCategory === 'configuration') {
        await ctx.pool.query(
          `DELETE FROM notification_smtp_test_claims
            WHERE test_key = 'production-smtp-diagnostic-v1' AND outcome = 'claimed'`,
        );
        return reply.code(503).send({ status: 'unavailable', reason: 'smtp_configuration' });
      }
      const succeeded = result.outcome === 'delivered';
      await ctx.pool.query(
        `UPDATE notification_smtp_test_claims
            SET outcome = $1, failure_category = $2, finished_at = now()
          WHERE test_key = 'production-smtp-diagnostic-v1'`,
        [succeeded ? 'delivered' : 'failed', result.failureCategory ?? null],
      );
      return reply.code(succeeded ? 200 : 502).send({
        status: succeeded ? 'sent' : 'failed',
        outcome: result.outcome,
        failureCategory: result.failureCategory ?? null,
      });
    } catch {
      // Claim remains consumed: SMTP acceptance may be ambiguous after a crash/error.
      await ctx.pool.query(
        `UPDATE notification_smtp_test_claims
            SET outcome = 'failed', failure_category = 'unknown', finished_at = now()
          WHERE test_key = 'production-smtp-diagnostic-v1'`,
      ).catch(() => {});
      return reply.code(502).send({ status: 'failed', outcome: 'unknown' });
    }
  });

  // POST /api/internal/notifications/deliveries/run — process one batch now
  app.post('/api/internal/notifications/deliveries/run', adminRateLimit, async (req, reply) => {
    if (!hasWorkerToken(config)) return notFound(reply);
    if (!tokenMatches(req, config)) return unauthorized(reply);

    const parsed = notificationRunRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    // Exactly ONE batch per call: the liveness wrapper must never add a second
    // invocation, which would drain the queue and report an empty result.
    recordWorkerStart('notifications');
    try {
      const result = await ctx.deliveryWorker.runOnce(parsed.data.batchSize);
      recordWorkerSuccess('notifications');
      return result;
    } catch (err) {
      // Existing behaviour: a failed batch stays a visible 5xx for the caller.
      recordWorkerFailure('notifications', err);
      throw err;
    }
  });

  // POST /api/internal/notifications/deliveries/maintenance — recovery + cleanup
  app.post('/api/internal/notifications/deliveries/maintenance', adminRateLimit, async (req, reply) => {
    if (!hasWorkerToken(config)) return notFound(reply);
    if (!tokenMatches(req, config)) return unauthorized(reply);

    const parsed = notificationMaintenanceRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const result = await ctx.deliveryWorker.runMaintenance({
      deliveredRetentionDays:
        parsed.data.deliveredRetentionDays ?? config.notification.retention.deliveredRetentionDays,
      failedRetentionDays:
        parsed.data.failedRetentionDays ?? config.notification.retention.failedRetentionDays,
    });
    return {
      recovered: result.recovered,
      deadLettered: result.deadLettered,
      requeued: result.requeued,
      deleted: result.deleted,
      depth: result.depth,
    };
  });
}

/**
 * Constant-time token comparison over SHA-256 digests: comparing raw strings
 * leaks length and prefix through timing, hashing first makes both inputs 32
 * bytes so `timingSafeEqual` is meaningful.
 */
export function tokenMatches(
  req: { headers: Record<string, string | string[] | undefined> },
  config: AppConfig,
): boolean {
  const presented = req.headers[WORKER_TOKEN_HEADER];
  const value = Array.isArray(presented) ? presented[0] : presented;
  if (typeof value !== 'string' || value === '') return false;
  const a = createHash('sha256').update(value, 'utf8').digest();
  const b = createHash('sha256').update(config.notification.worker.token, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function hasWorkerToken(config: AppConfig): boolean {
  return config.notification.worker.token.trim() !== '';
}

function notFound(reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
}

function unauthorized(reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  return reply.code(401).send({ error: { code: 'unauthorized', message: 'Authentication required' } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
