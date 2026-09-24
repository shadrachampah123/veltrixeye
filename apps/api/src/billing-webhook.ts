import type { FastifyInstance } from 'fastify';
import {
  BILLING_WEBHOOK_SIGNATURE_HEADER,
  Errors,
  isBillingWebhookError,
  type BillingWebhookReceiver,
} from '@veltrixeye/core';
import type { AppContext } from './app.js';
import type { AppConfig } from './config.js';
import { webhookIpAllowed } from './webhook-allowlist.js';

/**
 * Billing Step 5.2 — the webhook ROUTE (transport half of the receiver).
 *
 * `POST /api/billing/webhook` accepts one provider delivery at a time. This
 * file owns every TRANSPORT concern; the security-critical pipeline
 * (signature → parse → seam normalization → subject resolution → ledger)
 * lives in core (`packages/core/src/billing/webhook.ts`) and is exercised
 * here, never restated.
 *
 * Security posture, in request order:
 *
 *  1. EXISTENCE. The route is registered ONLY when a billing provider is
 *     registered (i.e. a sandbox key is configured). With no key, nothing is
 *     listening — the same fail-closed posture as the rest of billing, and
 *     the same posture as the token-gated internal notification routes.
 *  2. RATE LIMIT. Per-IP, far above the provider's documented delivery rate
 *     (retries are hourly in test mode; 3-minute then hourly in live) and far
 *     below the global API limit, so an unsigned flood stops here. `req.ip`
 *     is a safe key only because `trustProxy` is pinned (see trust-proxy.ts).
 *  3. IP ALLOW-LIST. The provider documents the three addresses it delivers
 *     from; the default pins exactly them (overridable per deployment). A
 *     defence-in-depth layer: the signature check below remains the authority.
 *  4. SIGNATURE. `x-paystack-signature` (HMAC-SHA512 of the RAW body, keyed
 *     by the sandbox secret key) is verified by core before the body is
 *     parsed. A missing or wrong signature is one identical 401.
 *  5. RECORDING. A verified delivery becomes exactly one ledger row (a replay
 *     collapses onto it); a verified-but-refused delivery becomes exactly one
 *     `unrecognized` row and a 400. The route answers 2xx only for rows it
 *     accepted, so the provider's documented retry schedule surfaces refusals
 *     instead of hiding them.
 *
 * Raw-body handling: Fastify's JSON parser is scoped to this route's plugin
 * context and switched to `parseAs: 'buffer'`, so the handler receives the
 * EXACT received bytes — the signature is computed over them, and only after
 * it verifies is the body parsed. No other route's body handling changes.
 *
 * What this route never does: no session is required (the signature is the
 * authentication), no payload is echoed or logged (the ledger stores a hash,
 * never the body), no payment is confirmed, no entitlement changes and
 * nothing about billing state grants execution.
 */

/** The webhook route path (operator-configured as the callback URL). */
export const BILLING_WEBHOOK_ROUTE = '/api/billing/webhook';

/**
 * Register the webhook route. Returns `true` when the route exists.
 * With no receiver (no sandbox key configured) the route is NOT registered,
 * so the endpoint simply does not exist (404) — nothing to probe, nothing to
 * half-configure.
 */
export async function registerBillingWebhookRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  config: AppConfig,
): Promise<boolean> {
  const receiver = ctx.billingWebhook;
  if (receiver === null) return false;

  const allowList = config.billing.webhook.allowedIps;
  const rateLimitMax = config.billing.webhook.rateLimitMax;

  await app.register(async (scope) => {
    // Raw-body capture, scoped to this route: the handler receives the exact
    // received bytes (Buffer), because HMAC-SHA512 must run over the raw body
    // — a re-serialized or pre-parsed form can differ byte-for-byte.
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    scope.post(
      BILLING_WEBHOOK_ROUTE,
      {
        config: {
          rateLimit: { max: rateLimitMax, timeWindow: '1 minute' },
        },
      },
      async (req, reply) => {
        // 3. Source-IP allow-list (defence in depth; the signature is the
        // authority). req.ip is non-client-controlled (pinned trustProxy).
        if (!webhookIpAllowed(req.ip, allowList)) {
          throw Errors.forbidden('The delivery source is not allowed to call this endpoint.');
        }

        const receivedAt = new Date();
        const body = req.body;
        const rawBody = Buffer.isBuffer(body)
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : Buffer.alloc(0);
        const header = req.headers[BILLING_WEBHOOK_SIGNATURE_HEADER];
        const signatureHeader = typeof header === 'string' ? header : null;

        let receipt;
        try {
          receipt = await receiver.receive({ rawBody, signatureHeader, receivedAt });
        } catch (error) {
          if (isBillingWebhookError(error)) {
            if (error.reason === 'invalid_signature') {
              throw Errors.unauthorized('The delivery signature could not be verified.');
            }
            if (error.reason === 'provider_not_registered') {
              throw Errors.providerUnavailable('No billing provider is registered.');
            }
            // persistence_failed: the verified delivery could not be recorded.
            // A 500 lets the provider's documented retry schedule try again.
            throw Errors.internal('The delivery could not be recorded.');
          }
          throw error;
        }

        // 5. A recorded refusal (unparseable body, or a payload the seam
        // refuses) is evidence, kept as an `unrecognized` row — but the
        // provider is told it was not accepted (400), so its retries surface
        // the problem. An accepted delivery is acknowledged with 2xx so the
        // provider does not redeliver it.
        if (receipt.deliveryRefused) {
          throw Errors.invalidInput('The delivery was recorded as unrecognized and refused.');
        }
        return reply.code(200).send({ status: receipt.outcome });
      },
    );
  });

  return true;
}

export type { BillingWebhookReceiver };
