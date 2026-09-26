import type { FastifyInstance } from 'fastify';
import {
  scannerRunListQuerySchema,
  scannerTriggerRequestSchema,
  type UserPlan,
} from '@veltrixeye/contracts';
import { Errors, resolveEntitlements } from '@veltrixeye/core';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';

/**
 * Scanner routes (M7.5) — live scanner / production market flow.
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | GET /api/scanner/health | session | Real production state: provider availability, last run, last successful, active runs, data freshness. Never mock/static. |
 * | GET /api/scanner/runs | session | List recent scanner runs (observability). |
 * | POST /api/scanner/trigger | session | Manual trigger (entitlement-gated). Uses advisory locking to prevent overlapping. |
 *
 * Security:
 *  - All routes are session-authenticated
 *  - canAccessScanner entitlement enforced server-side (free users get 403)
 *  - No client-controlled signal generation — scanner always uses server-side validated data
 *  - Provider credentials remain server-side, never exposed
 *  - Users cannot bypass market universe (symbols validated against instruments table)
 */

export async function scannerRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  // GET /api/scanner/health — scanner health/status (real production state)
  app.get('/api/scanner/health', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;

    // Check entitlement server-side
    // `provider` and the durable activation fact are read for the fail-closed
    // entitlement gate: a provider-backed row is an unconfirmed checkout and
    // never buys scanner access until an operator has authorized an immutable
    // activation fact for it (Billing Step 8, migration 0034).
    const billing = await ctx.pool.query<{ plan: string; status: string; provider: string | null; activated: boolean }>(
      `SELECT plan, status, provider,
              EXISTS (SELECT 1 FROM billing_subscription_activations a
                       WHERE a.subscription_id = subscriptions.id) AS activated
         FROM subscriptions WHERE user_id = $1`,
      [user.id],
    );
    const sub = billing.rows[0] ?? { plan: 'free', status: 'active', provider: null, activated: false };
    const entitlements = resolveEntitlements(
      sub.plan as UserPlan, sub.status, sub.provider, sub.activated === true,
    );
    if (!entitlements.canAccessScanner) {
      throw Errors.forbidden('Scanner access requires a Pro or Premium subscription');
    }

    const health = await ctx.scanner.getHealth();
    return health;
  });

  // GET /api/scanner/runs — list recent runs
  app.get('/api/scanner/runs', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;

    // `provider` and the durable activation fact are read for the fail-closed
    // entitlement gate: a provider-backed row is an unconfirmed checkout and
    // never buys scanner access until an operator has authorized an immutable
    // activation fact for it (Billing Step 8, migration 0034).
    const billing = await ctx.pool.query<{ plan: string; status: string; provider: string | null; activated: boolean }>(
      `SELECT plan, status, provider,
              EXISTS (SELECT 1 FROM billing_subscription_activations a
                       WHERE a.subscription_id = subscriptions.id) AS activated
         FROM subscriptions WHERE user_id = $1`,
      [user.id],
    );
    const sub = billing.rows[0] ?? { plan: 'free', status: 'active', provider: null, activated: false };
    const entitlements = resolveEntitlements(
      sub.plan as UserPlan, sub.status, sub.provider, sub.activated === true,
    );
    if (!entitlements.canAccessScanner) {
      throw Errors.forbidden('Scanner access requires a Pro or Premium subscription');
    }

    const parsed = scannerRunListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }

    return ctx.scanner.listRuns(parsed.data);
  });

  // POST /api/scanner/trigger — manual trigger
  app.post(
    '/api/scanner/trigger',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;

      // `provider` and the durable activation fact are read for the fail-closed
      // entitlement gate: a provider-backed row is an unconfirmed checkout and
      // never buys scanner access until an operator has authorized an immutable
      // activation fact for it (Billing Step 8, migration 0034).
      const billing = await ctx.pool.query<{ plan: string; status: string; provider: string | null; activated: boolean }>(
        `SELECT plan, status, provider,
                EXISTS (SELECT 1 FROM billing_subscription_activations a
                         WHERE a.subscription_id = subscriptions.id) AS activated
           FROM subscriptions WHERE user_id = $1`,
        [user.id],
      );
      const sub = billing.rows[0] ?? { plan: 'free', status: 'active', provider: null, activated: false };
      const entitlements = resolveEntitlements(
        sub.plan as UserPlan, sub.status, sub.provider, sub.activated === true,
      );
      if (!entitlements.canAccessScanner) {
        throw Errors.forbidden('Scanner access requires a Pro or Premium subscription');
      }

      const parsed = scannerTriggerRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }

      // Validate strategy ownership if specified
      if (parsed.data.strategyId) {
        const stratCheck = await ctx.pool.query<{ id: string }>(
          `SELECT id FROM strategies WHERE id = $1 AND user_id = $2`,
          [parsed.data.strategyId, user.id],
        );
        if (stratCheck.rows.length === 0) {
          throw Errors.notFound('Strategy not found');
        }
      }

      const result = await ctx.scanner.triggerScan({
        strategyId: parsed.data.strategyId,
        instruments: parsed.data.instruments,
        force: parsed.data.force,
        initiatedBy: user.id,
      });

      await ctx.audit.log({
        userId: user.id,
        action: result.skipped ? 'scanner.trigger_skipped' : 'scanner.triggered',
        entityType: 'scanner_run',
        entityId: result.run.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          strategyId: parsed.data.strategyId ?? null,
          force: parsed.data.force ?? false,
          skipped: result.skipped ?? false,
          reason: result.reason ?? null,
          status: result.run.status,
        },
      });

      return reply.code(result.skipped ? 200 : 201).send(result);
    },
  );
}
