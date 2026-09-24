import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import {
  getBillingState, BillingCheckoutError, Errors, isBillingProviderPlanError,
  isBillingPricingError, isBillingFxError, isBillingSubscriptionSyncError,
} from '@veltrixeye/core';
import { isPaystackAdapterError } from '@veltrixeye/provider-paystack';
import { composeBillingCheckout, composeBillingSync } from '../billing-composition.js';
import { registerBillingWebhookRoutes } from '../billing-webhook.js';
import type { BillingStateDto } from '@veltrixeye/contracts';

/**
 * Later-billing-PR #7: per-IP limit for `POST /api/billing/sync`, applied as a
 * route-level override of the global limiter (the same mechanism the webhook
 * route uses). Each call performs one provider read, so it is kept low.
 */
export const BILLING_SYNC_RATE_LIMIT_MAX = 10;

/** The sync route accepts NO payload: the subject is the session user, always. */
function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  return typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;
}

export async function billingRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);
  const checkout = composeBillingCheckout(ctx.pool, ctx.billingProviders, config);
  const sync = composeBillingSync(ctx.pool, ctx.billingProviders);

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

  // Later-billing-PR #7 — verify + synchronize the caller's OWN provider-backed
  // subscription (sandbox only). Session-authenticated; no payload is accepted
  // (the subject is always the session user, never a client-supplied id or
  // provider fact); one documented provider read per call. The response is the
  // canonical SubscriptionSyncResult, which pins planChanged /
  // entitlementsChanged / grantsExecution to false. A provider-backed row
  // still resolves to the free tier afterwards (provider→FREE gate unchanged).
  app.post('/api/billing/sync', {
    config: { rateLimit: { max: BILLING_SYNC_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!await requireAuth(req, reply)) return;
    if (!isEmptyBody(req.body)) {
      throw Errors.invalidInput('Synchronization accepts no request body.');
    }
    const { user } = req as AuthenticatedRequest;
    try {
      return reply.send(await sync.synchronize(user.id));
    } catch (error) {
      if (isBillingSubscriptionSyncError(error)) {
        // Nothing was written; the typed reason is visible, provider detail is not.
        throw Errors.providerUnavailable(`Synchronization refused: ${error.reason}.`, error);
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
