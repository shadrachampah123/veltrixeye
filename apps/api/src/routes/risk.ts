import type { FastifyInstance } from 'fastify';
import { riskDecisionListQuerySchema, riskPolicyUpdateSchema } from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';

/**
 * Risk policy / status routes (M8.2).
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | GET   /api/risk/policy    | session | Owner-scoped policy + platform ceilings + account snapshot. |
 * | PATCH /api/risk/policy    | session | User-editable settings, REJECTED if they exceed platform ceilings. |
 * | GET   /api/risk/decisions | session | Owner-scoped risk-decision audit trail. |
 *
 * Deliberately ABSENT: any endpoint that submits a risk-approved execution
 * decision, mutates P&L / loss counters, weakens a ceiling, or places an
 * order. A client cannot tell the server "this trade is approved".
 */
export async function riskRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  app.get('/api/risk/policy', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    return ctx.execution.risk.getPolicyStatus(user.id);
  });

  app.patch(
    '/api/risk/policy',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsed = riskPolicyUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const status = await ctx.execution.risk.updatePolicy(user.id, parsed.data, {
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return status;
    },
  );

  app.get('/api/risk/decisions', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = riskDecisionListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.execution.risk.listDecisions(user.id, parsed.data.limit);
  });
}
