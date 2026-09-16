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
import { Errors, getBillingState } from '@veltrixeye/core';

/**
 * Alert API routes (M6 Phases 2–3).
 *
 * POST /api/setups/:setupId/alerts — generate an alert from an owned setup
 * GET  /api/alerts                 — list owned alerts
 * GET  /api/alerts/:id             — alert + its stub delivery ledger
 * POST /api/alerts/:id/acknowledge — acknowledge (idempotent)
 *
 * All routes are session-authenticated, owner-scoped with masked 404s,
 * Zod-validated, tiered rate limited (generate 20/min, acknowledge 60/min),
 * audited, and return safe DTOs.
 *
 * No real delivery is ever performed: the only channel is the local `stub`
 * sender (see `@veltrixeye/core` → `alerts/sender.ts`). Audit events mirror
 * exactly what happened — `alert.created` only on insert, `alert.replayed`
 * for a dedup replay, and `alert.delivery_recorded` only when a NEW ledger
 * row was written, so a retry can never look like a second delivery.
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

      if (!result.alert) {
        // minQualityScore gate: explicit, audited silence — not an error.
        await ctx.audit.log({
          userId: user.id,
          action: 'alert.skipped',
          entityType: 'setup',
          entityId: setupId,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          metadata: {
            reason: result.skippedReason,
            triggerState: parsed.data.triggerState ?? null,
            qualityScore: result.gate?.qualityScore ?? null,
            qualityGrade: result.gate?.qualityGrade ?? null,
            minQualityScore: result.gate?.minQualityScore ?? null,
          },
        });
        return reply.code(200).send({
          alert: null,
          created: false,
          skippedReason: result.skippedReason,
        });
      }

      await ctx.audit.log({
        userId: user.id,
        action: result.created ? 'alert.created' : 'alert.replayed',
        entityType: 'alert',
        entityId: result.alert.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          setupId,
          triggerState: result.alert.triggerState,
          qualityScore: result.alert.qualityScore,
          qualityGrade: result.alert.body.qualityGrade ?? null,
          minQualityScore: result.alert.minQualityScore,
          created: result.created,
          channel: ctx.alerts.deliveryChannel,
        },
      });

      if (result.deliveryCreated && result.delivery) {
        // One ledger row, one audit event: replays do not re-emit this.
        await ctx.audit.log({
          userId: user.id,
          action: 'alert.delivery_recorded',
          entityType: 'alert_delivery',
          entityId: String(result.delivery.id),
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          metadata: {
            alertId: result.alert.id,
            setupId,
            channel: result.delivery.channel,
            status: result.delivery.status,
            attempt: result.delivery.attempt,
            payloadHash: result.delivery.payloadHash,
          },
        });
      }

      return reply.code(result.created ? 201 : 200).send({
        alert: result.alert,
        deliveries: result.delivery ? [result.delivery] : [],
        created: result.created,
      });
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
          setupId: result.alert.setupId,
          triggerState: result.alert.triggerState,
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
