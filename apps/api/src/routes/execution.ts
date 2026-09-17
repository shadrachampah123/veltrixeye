import type { FastifyInstance } from 'fastify';
import {
  automationToggleSchema,
  executionListQuerySchema,
  executionProfileCreateSchema,
  brokerProfilePatchSchema,
  brokerProfileParamsSchema,
  paperPositionActionSchema,
  paperSimulateSchema,
  EXECUTION_ARCHITECTURE_VERSION,
  RISK_ENGINE_VERSION,
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
      const health = provider ? await provider.health() : {
        configured: false, authenticated: false, connected: false, available: false,
        healthy: false, state: 'unavailable' as const, reason: 'provider_missing', checkedAt: new Date().toISOString(),
      };
      providers.push({
        id: info.id,
        name: info.name,
        configured: health.configured,
        authenticated: health.authenticated,
        connected: health.connected,
        available: health.available,
        healthy: health.healthy,
        state: health.state,
        reason: health.reason ?? null,
      });
    }
    const { profiles } = await ctx.execution.profiles.listForUser(user.id);

    const dto: ExecutionStatusDto = {
      automation,
      architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
      riskEngineVersion: RISK_ENGINE_VERSION,
      providers,
      profiles: profiles.length,
    };
    return dto;
  });

  // M8.4 provider inventory/status. Safe metadata only; describe() is written
  // by adapters and never contains credentials.
  app.get('/api/execution/providers', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const providers = await Promise.all(ctx.execution.providers.list().map(async (info) => {
      const provider = ctx.execution.providers.get(info.id)!;
      return { id: info.id, name: info.name, capabilities: info.capabilities, description: provider.describe(), health: await provider.health() };
    }));
    return { providers, liveExecutionAvailable: false };
  });

  app.get('/api/execution/providers/:provider/status', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const providerId = (req.params as { provider?: string }).provider ?? '';
    const provider = ctx.execution.providers.get(providerId);
    if (!provider) return reply.code(404).send({ error: { code: 'not_found', message: 'Execution provider not found' } });
    return { id: provider.id, name: provider.name, capabilities: provider.capabilities, description: provider.describe(), health: await provider.health(), liveExecutionAvailable: false };
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

  // M8.4 broker-profile aliases keep broker management distinct from order APIs.
  app.get('/api/execution/broker-profiles', async (req, reply) => {
    const ok = await requireAuth(req, reply); if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const result = await ctx.execution.profiles.listForUser(user.id);
    return { profiles: result.profiles.filter((p) => p.providerSlug !== 'paper') };
  });
  app.post('/api/execution/broker-profiles', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ok = await requireAuth(req, reply); if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionProfileCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) { sendZodError(reply, parsed.error, 'body'); return; }
    const profile = await ctx.execution.profiles.createProfile(user.id, parsed.data, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
    return reply.code(201).send({ profile });
  });
  app.patch('/api/execution/broker-profiles/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ok = await requireAuth(req, reply); if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const params = brokerProfileParamsSchema.safeParse(req.params);
    const body = brokerProfilePatchSchema.safeParse(req.body ?? {});
    if (!params.success) { sendZodError(reply, params.error, 'params'); return; }
    if (!body.success) { sendZodError(reply, body.error, 'body'); return; }
    return { profile: await ctx.execution.profiles.updateBrokerProfile(user.id, params.data.id, body.data, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null }) };
  });
  app.post('/api/execution/broker-profiles/:id/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const ok = await requireAuth(req, reply); if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const params = brokerProfileParamsSchema.safeParse(req.params);
    if (!params.success) { sendZodError(reply, params.error, 'params'); return; }
    return ctx.execution.profiles.testBrokerProfile(user.id, params.data.id, { ip: req.ip, userAgent: req.headers['user-agent'] ?? null });
  });

  // GET /api/execution/orders — owner-scoped
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

/**
 * M8.3 — paper execution routes (internal simulation only).
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | GET  /api/execution/paper/status  | session | Simulator readiness, automation OFF, open/closed P&L, counts. |
 * | POST /api/execution/paper/simulate | session | Simulate ONE server-issued decision for an owned setup (identifiers only — never a price, size, approval or P&L). |
 * | GET  /api/execution/paper/orders | session | Owner-scoped simulated orders. |
 * | GET  /api/execution/paper/positions | session | Owner-scoped simulated positions (entry/exit/P&L). |
 * | GET  /api/execution/paper/fills | session | Owner-scoped append-only fill ledger. |
 * | POST /api/execution/paper/positions/:id/close | session | Synthetic close at the server market price. |
 * | POST /api/execution/paper/evaluate | session | Apply SL/TP to open simulated positions from server market data. |
 * | GET  /api/execution/paper/reconciliations | session | Reconciliation trail (M8.5 foundation). |
 * | POST /api/execution/paper/reconcile | session | Run a reconciliation sweep (read-only; findings are never auto-corrected). |
 *
 * Deliberately ABSENT — every one of these is impossible in this platform:
 * broker/demo-account connection, credential submission, order submission to
 * an external venue, live-execution toggles, and any endpoint that accepts a
 * client-authored decision, price, position size, P&L or approval.
 */
export async function paperExecutionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  config: AppConfig,
): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  app.get('/api/execution/paper/status', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    return ctx.execution.paper.status(user.id);
  });

  app.post(
    '/api/execution/paper/simulate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsed = paperSimulateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const result = await ctx.execution.paper.simulate({
        userId: user.id,
        setupId: parsed.data.setupId,
        executionProfileId: parsed.data.executionProfileId,
        riskDecisionId: parsed.data.riskDecisionId ?? null,
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
      return result;
    },
  );

  app.get('/api/execution/paper/orders', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.paper.listOrders(user.id, parsed.data.limit);
  });

  app.get('/api/execution/paper/positions', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.paper.listPositions(user.id, parsed.data.limit);
  });

  app.get('/api/execution/paper/fills', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.paper.listFills(user.id, parsed.data.limit);
  });

  app.post(
    '/api/execution/paper/positions/:id/close',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsedBody = paperPositionActionSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        sendZodError(reply, parsedBody.error, 'body');
        return;
      }
      const params = req.params as { id?: string };
      const outcome = await ctx.execution.paper.closePosition({
        userId: user.id,
        positionId: String(params.id ?? ''),
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
      return outcome;
    },
  );

  app.post(
    '/api/execution/paper/evaluate',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsedBody = paperPositionActionSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        sendZodError(reply, parsedBody.error, 'body');
        return;
      }
      return ctx.execution.paper.evaluateOpenPositions({
        userId: user.id,
        meta: { ip: req.ip, userAgent: req.headers['user-agent'] ?? null },
      });
    },
  );

  app.get('/api/execution/paper/reconciliations', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = executionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.paper.listReconciliations(user.id, parsed.data.limit);
  });

  app.post(
    '/api/execution/paper/reconcile',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsedBody = paperPositionActionSchema.safeParse(req.body ?? {});
      if (!parsedBody.success) {
        sendZodError(reply, parsedBody.error, 'body');
        return;
      }
      return ctx.execution.paper.reconcile({ userId: user.id });
    },
  );
}
