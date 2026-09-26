import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import {
  getBillingState, BillingCheckoutError, Errors, isBillingProviderPlanError,
  isBillingPricingError, isBillingFxError, isBillingSubscriptionSyncError,
  isBillingCustomerProvisioningError, type BillingCustomerProvisioningErrorReason,
  isBillingPaymentConfirmationError,
} from '@veltrixeye/core';
import { isPaystackAdapterError } from '@veltrixeye/provider-paystack';
import { composeBillingCheckout, composeBillingCustomers, composeBillingSync, composeBillingVerify } from '../billing-composition.js';
import { registerBillingWebhookRoutes } from '../billing-webhook.js';
import type { BillingStateDto } from '@veltrixeye/contracts';

/**
 * Later-billing-PR #7: per-IP limit for `POST /api/billing/sync`, applied as a
 * route-level override of the global limiter (the same mechanism the webhook
 * route uses). Each call performs one provider read, so it is kept low.
 */
export const BILLING_SYNC_RATE_LIMIT_MAX = 10;

/**
 * Billing Step 6: per-IP limit for `POST /api/billing/customer` (route-level
 * override of the global limiter, same mechanism as sync/webhook). A call
 * performs at most two provider requests (find, then create), so it is low.
 */
export const BILLING_CUSTOMER_RATE_LIMIT_MAX = 10;

/**
 * Billing Step 7: per-IP limit for `POST /api/billing/verify` (route-level
 * override of the global limiter, same mechanism as sync/customer/webhook).
 * One documented provider read per call, so it is low.
 */
export const BILLING_VERIFY_RATE_LIMIT_MAX = 10;

/**
 * Provisioning refusals that are about LOCAL state needing operator review
 * (409); every other refusal is a provider-side unavailability (502).
 */
const CUSTOMER_CONFLICT_REASONS: ReadonlySet<BillingCustomerProvisioningErrorReason> = new Set([
  'account_unavailable', 'customer_not_provisionable', 'customer_identity_incomplete',
  'customer_identity_conflict',
]);

/** The sync/customer routes accept NO payload: the subject is the session user, always. */
function isEmptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  return typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;
}

export async function billingRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);
  const checkout = composeBillingCheckout(ctx.pool, ctx.billingProviders, config);
  const sync = composeBillingSync(ctx.pool, ctx.billingProviders);
  const customers = composeBillingCustomers(ctx.pool, ctx.billingProviders);
  const verify = composeBillingVerify(ctx.pool, ctx.billingProviders);

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

  // Billing Step 6 (roadmap item 8a) — ensure the caller's OWN billing customer
  // exists (sandbox only), so checkout's existing-customer requirement can be
  // met. Session-authenticated; no payload is accepted (the subject and the
  // email are always the session user's, never client-supplied); idempotent —
  // an already-provisioned customer is returned without any provider call.
  // The response pins entitlementsChanged / grantsExecution to false: a
  // provisioned customer buys nothing and the provider→FREE gate is unchanged.
  app.post('/api/billing/customer', {
    config: { rateLimit: { max: BILLING_CUSTOMER_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!await requireAuth(req, reply)) return;
    if (!isEmptyBody(req.body)) {
      throw Errors.invalidInput('Customer provisioning accepts no request body.');
    }
    const { user } = req as AuthenticatedRequest;
    try {
      return reply.send(await customers.ensureCustomer(user.id));
    } catch (error) {
      if (isBillingCustomerProvisioningError(error)) {
        // Nothing was written; the typed reason is visible, provider detail is not.
        const message = `Customer provisioning refused: ${error.reason}.`;
        if (CUSTOMER_CONFLICT_REASONS.has(error.reason)) throw Errors.conflict(message);
        throw Errors.providerUnavailable(message, error);
      }
      throw error;
    }
  });

  // Billing Step 7 — verify the caller's OWN checkout transaction and record
  // durable payment evidence (sandbox only). Session-authenticated; no payload
  // is accepted (the subject is always the session user, never a
  // client-supplied reference); the checkout reference is derived server-side
  // from the locked pricing snapshot. The response is the structured
  // `BillingPaymentVerificationResult` (verified true with evidence, or
  // verified false with a typed failure reason). It never grants
  // entitlements or execution: `grantsExecution`, `planChanged` and
  // `entitlementsChanged` are pinned false, and `paymentConfirmed` on the
  // existing `GET /api/billing/me` DTO is not moved by it (that field is
  // derived from the durable activation fact, Billing Step 8).
  app.post('/api/billing/verify', {
    config: { rateLimit: { max: BILLING_VERIFY_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!await requireAuth(req, reply)) return;
    if (!isEmptyBody(req.body)) {
      throw Errors.invalidInput('Verification accepts no request body.');
    }
    const { user } = req as AuthenticatedRequest;
    try {
      return reply.send(await verify.confirm(user.id));
    } catch (error) {
      if (isBillingPaymentConfirmationError(error)) {
        // Provider or verification failures are unavailability (nothing was
        // persisted); snapshot mismatches that are returned as structured
        // 200s never reach here — they are the `verified: false` case above.
        throw Errors.providerUnavailable(`Verification refused: ${error.reason}.`, error);
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
      // from a provider checkout, and `paymentConfirmed` is derived from the
      // durable activation fact (Billing Step 8) — never from the provider
      // state, never from client input. It grants nothing.
      providerStatus: state.providerStatus,
    };
    
    return reply.send(dto);
  });
}
