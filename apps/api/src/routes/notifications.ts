import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  notificationMaintenanceRequestSchema,
  notificationRunRequestSchema,
  notificationPreferencesRequestSchema,
  pushSubscriptionRequestSchema,
  strategyNotificationPreferenceRequestSchema,
} from '@veltrixeye/contracts';
import { Errors } from '@veltrixeye/core';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';

/**
 * M7.3 notification routes.
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | `GET /api/alerts/:alertId/notifications` | session | Owner-scoped; foreign/unknown ids are masked as 404. Returns status/attempt/failure-category only — never the recipient, payload or provider error. |
 * | `POST /api/internal/notifications/deliveries/run` | worker token | Runs one delivery batch (recover stale → re-queue what became deliverable → claim → send). 404 when no token is configured. |
 * | `POST /api/internal/notifications/deliveries/maintenance` | worker token | Stale recovery + retention + queue depth. 404 when no token is configured. |
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
 *  - they are rate limited per IP and never accept user ids, alert ids or
 *    payloads — a caller can only say "process a batch", never "send this";
 *  - no response ever contains a credential, a recipient address or provider
 *    error text (counts and statuses only).
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

  // POST /api/internal/notifications/deliveries/run — process one batch now
  app.post('/api/internal/notifications/deliveries/run', adminRateLimit, async (req, reply) => {
    if (!hasWorkerToken(config)) return notFound(reply);
    if (!tokenMatches(req, config)) return unauthorized(reply);

    const parsed = notificationRunRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const result = await ctx.deliveryWorker.runOnce(parsed.data.batchSize);
    return result;
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
