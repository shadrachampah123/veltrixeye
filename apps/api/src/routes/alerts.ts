import type { FastifyInstance } from 'fastify';
import {
  alertAcknowledgeRequestSchema,
  alertGenerateRequestSchema,
  alertListQuerySchema,
} from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import { Errors } from '@veltrixeye/core';

/**
 * Alert API routes (M6 Phase 2).
 *
 * POST /api/setups/:setupId/alerts — generate alert from setup (setup-level action)
 * GET /api/alerts — list owned alerts
 * GET /api/alerts/:id — get alert + deliveries
 * POST /api/alerts/:id/acknowledge — acknowledge alert (idempotent)
 *
 * All routes are session-authenticated, owner-scoped with masked 404s,
 * Zod-validated, tiered rate limits, audited, and return safe DTOs.
 * No real delivery is ever performed (stub only).
 */

export async function alertRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  // POST /api/setups/:setupId/alerts — generate alert from setup
  app.post(
    '/api/setups/:setupId/alerts',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const { setupId } = req.params as { setupId: string };
      if (!isUuid(setupId)) throw Errors.notFound('Setup not found');
      const parsed = alertGenerateRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }

      const result = await ctx.alerts.generateAlert({
        userId: user.id,
        setupId,
        triggerState: parsed.data.triggerState,
      });

      if (result.alert) {
        await ctx.audit.log({
          userId: user.id,
          action: result.created ? 'alert.generated' : 'alert.replayed',
          entityType: 'alert',
          entityId: result.alert.id,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          metadata: {
            setupId,
            triggerState: result.alert.triggerState,
            qualityScore: result.alert.qualityScore,
            minQualityScore: result.alert.minQualityScore,
            created: result.created,
            channel: 'stub',
          },
        });

        // Delivery stub audit if conventions require
        await ctx.audit.log({
          userId: user.id,
          action: 'alert.delivery_recorded',
          entityType: 'alert_delivery',
          entityId: result.delivery?.id ? String(result.delivery.id) : null,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          metadata: {
            alertId: result.alert.id,
            channel: 'stub',
            status: 'delivered',
          },
        });

        return reply.code(result.created ? 201 : 200).send({
          alert: result.alert,
          deliveries: result.delivery ? [result.delivery] : [],
          created: result.created,
        });
      } else {
        // Gate not met — explicit silence, not error
        await ctx.audit.log({
          userId: user.id,
          action: 'alert.skipped',
          entityType: 'setup',
          entityId: setupId,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          metadata: {
            reason: result.skippedReason,
            triggerState: parsed.data.triggerState,
          },
        });
        return reply.code(200).send({
          alert: null,
          created: false,
          skippedReason: result.skippedReason,
        });
      }
    },
  );

  // GET /api/alerts — list
  app.get('/api/alerts', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = alertListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.alerts.listAlerts({ userId: user.id, ...parsed.data });
  });

  // GET /api/alerts/:id — detail
  app.get('/api/alerts/:id', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw Errors.notFound('Alert not found');
    return ctx.alerts.getAlert({ userId: user.id, alertId: id });
  });

  // POST /api/alerts/:id/acknowledge — acknowledge (idempotent)
  app.post(
    '/api/alerts/:id/acknowledge',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const { id } = req.params as { id: string };
      if (!isUuid(id)) throw Errors.notFound('Alert not found');
      const parsed = alertAcknowledgeRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }

      const result = await ctx.alerts.acknowledgeAlert({ userId: user.id, alertId: id });

      await ctx.audit.log({
        userId: user.id,
        action: 'alert.acknowledged',
        entityType: 'alert',
        entityId: id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          status: result.alert.status,
          acknowledgedAt: result.alert.acknowledgedAt,
        },
      });

      return result;
    },
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
