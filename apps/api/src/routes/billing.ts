import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import {
  getBillingState, BillingCheckoutError, Errors, isBillingProviderPlanError,
  isBillingPricingError, isBillingFxError,
} from '@veltrixeye/core';
import { isPaystackAdapterError } from '@veltrixeye/provider-paystack';
import { composeBillingCheckout } from '../billing-composition.js';
import { registerBillingWebhookRoutes } from '../billing-webhook.js';
import type { BillingStateDto } from '@veltrixeye/contracts';

export async function billingRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);
  const checkout = composeBillingCheckout(ctx.pool, ctx.billingProviders, config);

  // Billing Step 5.2 — the secure webhook receiver route. Signature-verified,
  // never session-authenticated; registered only when a billing provider
  // exists (with no sandbox key the endpoint does not exist at all).
  await registerBillingWebhookRoutes(app, ctx, config);

  app.post('/api/billing/checkout', async (req, reply) => {
    if (!await requireAuth(req, reply)) return;
    const { user } = req as AuthenticatedRequest;
    try {
      return reply.send(await checkout.checkout(user.id, req.body));
    } catch (error) {
      if (error instanceof BillingCheckoutError && error.reason === 'pricing_lock_required') {
        throw Errors.conflict(error.message);
      }
      if (error instanceof BillingCheckoutError || isBillingProviderPlanError(error) ||
          isBillingPricingError(error) || isBillingFxError(error) || isPaystackAdapterError(error)) {
        // Existing API envelope/codes; typed billing reason remains visible, no raw payload.
        throw Errors.providerUnavailable(`Checkout refused: ${error.reason}.`, error);
      }
      throw error;
    }
  });

  app.get('/api/billing/me', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    
    const { user } = req as AuthenticatedRequest;
    const state = await getBillingState(ctx.pool, user.id);
    
    const dto: BillingStateDto = {
      subscription: state.subscription,
      entitlements: state.entitlements,
      // Display-only provider state: it tells the client whether the row came
      // from a provider checkout, and `paymentConfirmed` is pinned false
      // because no confirmation authority exists. It grants nothing.
      providerStatus: state.providerStatus,
    };
    
    return reply.send(dto);
  });
}
