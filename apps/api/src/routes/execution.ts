import type { FastifyInstance } from 'fastify';
import {
  automationToggleSchema,
  executionListQuerySchema,
  executionProfileCreateSchema,
  EXECUTION_ARCHITECTURE_VERSION,
  type ExecutionStatusDto,
} from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';

/**
 * Execution architecture routes (M8.1) — READ + configuration surface ONLY.
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | GET  /api/execution/automation | session | Server-authoritative automation state (entitlement + switch + kill switches). |
 * | POST /api/execution/automation | session | Entitlement-gated switch. In M8.1 every plan lacks the entitlement ⇒ always 403. |
 * | GET  /api/execution/status     | session | Execution readiness: automation state, provider health, profile count. |
 * | GET  /api/execution/profiles   | session | The caller's execution profiles (owner-scoped). |
 * | POST /api/execution/profiles   | session | Create a PAPER profile only; demo/live refused; provider validated against the server-side registry. |
 * | GET  /api/execution/orders     | session | Owner-scoped order list (empty in M8.1 — no provider can trade). |
 * | GET  /api/execution/positions  | session | Owner-scoped position list (empty in M8.1). |
 * | GET  /api/execution/events     | session | Owner-scoped execution audit trail. |
 *
 * Deliberately ABSENT in M8.1: any endpoint that submits/modifies/cancels an
 * order, calls a provider directly, or accepts a client-authored execution
 * decision. Execution decisions will only ever be produced server-side by the
 * strategy → risk pipeline (M8.2+).
 */
export async function executionRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  // GET /api/execution/automation — automation state (never client-derived)
  app.get('/api/execution/automation', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    return ctx.execution.automation.getStatus(user.id);
  });

  // POST /api/execution/automation — entitlement-gated switch (403 for all in M8.1)
  app.post(
    '/api/execution/automation',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsed = automationToggleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const status = await ctx.execution.automation.setAutomationEnabled(user.id, parsed.data.enabled, {
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return status;
    },
  );

  // GET /api/execution/status — readiness snapshot (no secrets, ever)
  app.get('/api/execution/status', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;

    const automation = await ctx.execution.automation.getStatus(user.id);
    const providers: ExecutionStatusDto['providers'] = [];
    for (const info of ctx.execution.providers.list()) {
      const provider = ctx.execution.providers.get(info.id);
      const health = provider ? await provider.health() : { healthy: false, reason: 'provider_missing' };
      providers.push({
        id: info.id,
        name: info.name,
        configured: info.configured,
        healthy: health.healthy,
        reason: health.reason ?? null,
      });
    }
    const { profiles } = await ctx.execution.profiles.listForUser(user.id);

    const dto: ExecutionStatusDto = {
      automation,
      architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
      providers,
      profiles: profiles.length,
    };
    return dto;
  });

  // GET /api/execution/profiles — owner-scoped list
  app.get('/api/execution/profiles', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    return ctx.execution.profiles.listForUser(user.id);
  });

  // POST /api/execution/profiles — create a PAPER profile (M8.1 only)
  app.post(
    '/api/execution/profiles',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsed = executionProfileCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const profile = await ctx.execution.profiles.createProfile(user.id, parsed.data, {
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(201).send({ profile });
    },
  );

  // GET /api/execution/orders — owner-scoped (empty until a provider can trade)
  app.get('/api/execution/orders', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.queries.listOrders(user.id, parsed.data.limit);
  });

  // GET /api/execution/positions — owner-scoped (empty until a provider can trade)
  app.get('/api/execution/positions', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.queries.listPositions(user.id, parsed.data.limit);
  });

  // GET /api/execution/events — owner-scoped execution audit trail
  app.get('/api/execution/events', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.queries.listEvents(user.id, parsed.data.limit);
  });
}
