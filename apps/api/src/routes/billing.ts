import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import { getBillingState } from '@veltrixeye/core';
import type { BillingStateDto } from '@veltrixeye/contracts';

export async function billingRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  app.get('/api/billing/me', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    
    const { user } = req as AuthenticatedRequest;
    const state = await getBillingState(ctx.pool, user.id);
    
    const dto: BillingStateDto = {
      subscription: state.subscription,
      entitlements: state.entitlements,
    };
    
    return reply.send(dto);
  });
}
