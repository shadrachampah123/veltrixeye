import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  scannerInternalMaintenanceRequestSchema,
  scannerInternalRunRequestSchema,
  scannerRunListQuerySchema,
  scannerTriggerRequestSchema,
  type UserPlan,
} from '@veltrixeye/contracts';
import { Errors, redactScannerRunForViewer, resolveEntitlements } from '@veltrixeye/core';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import { consoleScannerLogger, runScannerWorkerCycle } from '../scanner-worker.js';

/**
 * Scanner routes (M7.5 / F3) — live scanner / production market flow.
 *
 * | Route | Auth | Notes |
 * |---|---|---|
 * | GET /api/scanner/health | session | Real production state: provider availability, last run, last successful, active runs, data freshness. Never mock/static. |
 * | GET /api/scanner/runs | session | List recent scanner runs (observability), owner-scoped. |
 * | POST /api/scanner/trigger | session | Manual trigger (entitlement-gated). Uses advisory locking to prevent overlapping. |
 * | POST /api/internal/scanner/run | worker token | Sleep-safe external scheduler trigger: recovers stale runs and executes one system scan under advisory lock. 404 when no token is configured. |
 * | POST /api/internal/scanner/maintenance | worker token | Stale-run recovery + bounded operational status. 404 when no token is configured. |
 *
 * Security:
 *  - User routes are session-authenticated; canAccessScanner entitlement enforced server-side (free users get 403)
 *  - Internal worker routes return 404 when SCANNER_WORKER_TOKEN is unset, and compare the token in constant time over SHA-256 digests
 *  - No client-controlled signal generation — scanner always uses server-side validated data
 *  - Provider credentials remain server-side, never exposed
 *  - Users cannot bypass market universe (symbols validated against instruments table)
 *
 * Tenant privacy (M7 audit finding F4):
 *  - `scanner_runs` is a global ledger whose `metadata` carries `triggeredBy`
 *    (user UUID) and `strategyId` (strategy UUID), so it is never read globally
 *    on behalf of a tenant: `listRuns` is owner-scoped to the session user.
 *  - `getHealth` stays global (the scanner is one shared pipeline) but redacts
 *    tenant-identifying metadata from the embedded last-run DTOs.
 *  - Internal worker endpoints strip all tenant/strategy identifiers and
 *    sanitize error text before responding.
 */

/** Header carrying the shared scanner worker secret. */
export const SCANNER_WORKER_TOKEN_HEADER = 'x-veltrixeye-worker-token';

export async function scannerRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);
  const adminRateLimit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

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
    const billing = await ctx.pool.query<{
      plan: string | null; status: string | null; provider: string | null;
      activated: boolean; granted_plan: string | null;
    }>(
      `SELECT sub.plan, sub.status, sub.provider,
              EXISTS (SELECT 1 FROM billing_subscription_activations a
                       WHERE a.subscription_id = sub.id) AS activated,
              (SELECT g.plan FROM billing_entitlement_grants g
                WHERE g.user_id = u.id) AS granted_plan
         FROM users u
         LEFT JOIN subscriptions sub ON sub.user_id = u.id
        WHERE u.id = $1`,
      [user.id],
    );
    const sub = billing.rows[0]
      ?? { plan: null, status: null, provider: null, activated: false, granted_plan: null };
    const entitlements = resolveEntitlements(
      (sub.plan ?? 'free') as UserPlan,
      sub.status ?? 'active',
      sub.provider,
      sub.activated === true,
      sub.granted_plan as UserPlan | null,
    );
    if (!entitlements.canAccessScanner) {
      throw Errors.forbidden('Scanner access requires a Pro or Premium subscription');
    }

    // Tenant read: global operational state, minus other tenants' identifiers.
    const health = await ctx.scanner.getHealth(user.id);
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
    const billing = await ctx.pool.query<{
      plan: string | null; status: string | null; provider: string | null;
      activated: boolean; granted_plan: string | null;
    }>(
      `SELECT sub.plan, sub.status, sub.provider,
              EXISTS (SELECT 1 FROM billing_subscription_activations a
                       WHERE a.subscription_id = sub.id) AS activated,
              (SELECT g.plan FROM billing_entitlement_grants g
                WHERE g.user_id = u.id) AS granted_plan
         FROM users u
         LEFT JOIN subscriptions sub ON sub.user_id = u.id
        WHERE u.id = $1`,
      [user.id],
    );
    const sub = billing.rows[0]
      ?? { plan: null, status: null, provider: null, activated: false, granted_plan: null };
    const entitlements = resolveEntitlements(
      (sub.plan ?? 'free') as UserPlan,
      sub.status ?? 'active',
      sub.provider,
      sub.activated === true,
      sub.granted_plan as UserPlan | null,
    );
    if (!entitlements.canAccessScanner) {
      throw Errors.forbidden('Scanner access requires a Pro or Premium subscription');
    }

    const parsed = scannerRunListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }

    // Tenant read: owner-scoped. The run ledger is global and its metadata
    // carries `triggeredBy`/`strategyId`, so it is never listed across tenants.
    return ctx.scanner.listRuns(parsed.data, user.id);
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
      // activation fact for it (Billing Step 8, migration 0034). The
      // non-commercial operator grant (migration 0036) is an account-level
      // authority read alongside them.
      const billing = await ctx.pool.query<{
        plan: string | null; status: string | null; provider: string | null;
        activated: boolean; granted_plan: string | null;
      }>(
        `SELECT sub.plan, sub.status, sub.provider,
                EXISTS (SELECT 1 FROM billing_subscription_activations a
                         WHERE a.subscription_id = sub.id) AS activated,
                (SELECT g.plan FROM billing_entitlement_grants g
                  WHERE g.user_id = u.id) AS granted_plan
           FROM users u
           LEFT JOIN subscriptions sub ON sub.user_id = u.id
          WHERE u.id = $1`,
        [user.id],
      );
      const sub = billing.rows[0]
        ?? { plan: null, status: null, provider: null, activated: false, granted_plan: null };
      const entitlements = resolveEntitlements(
        (sub.plan ?? 'free') as UserPlan,
        sub.status ?? 'active',
        sub.provider,
        sub.activated === true,
        sub.granted_plan as UserPlan | null,
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

      return reply.code(result.skipped ? 200 : 201).send({
        ...result,
        run: redactScannerRunForViewer(result.run, user.id),
      });
    },
  );

  // POST /api/internal/scanner/run — sleep-safe external scheduler trigger (F3)
  app.post('/api/internal/scanner/run', adminRateLimit, async (req, reply) => {
    if (!hasScannerWorkerToken(config)) return notFound(reply);
    if (!scannerTokenMatches(req, config)) return unauthorized(reply);

    const parsed = scannerInternalRunRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }

    const result = await runScannerWorkerCycle(ctx.scanner, {
      runArgs: {
        force: parsed.data.force,
        leaseMs: parsed.data.leaseMs ?? config.scanner.leaseMs,
      },
      scheduledIngestion: config.scheduledIngestion.enabled
        ? ctx.scheduledIngestion
        : undefined,
      logger: consoleScannerLogger('[scanner]'),
    });
    return reply.code(200).send(result);
  });

  // POST /api/internal/scanner/maintenance — stale-run recovery + operational status (F3)
  app.post('/api/internal/scanner/maintenance', adminRateLimit, async (req, reply) => {
    if (!hasScannerWorkerToken(config)) return notFound(reply);
    if (!scannerTokenMatches(req, config)) return unauthorized(reply);

    const parsed = scannerInternalMaintenanceRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }

    const result = await ctx.scanner.runMaintenance({
      leaseMs: parsed.data.leaseMs ?? config.scanner.leaseMs,
    });
    return reply.code(200).send(result);
  });
}

/**
 * Constant-time token comparison over SHA-256 digests: comparing raw strings
 * leaks length and prefix through timing; hashing first makes both inputs 32
 * bytes so `timingSafeEqual` is constant-time regardless of token length.
 */
export function scannerTokenMatches(
  req: { headers: Record<string, string | string[] | undefined> },
  config: AppConfig,
): boolean {
  if (!hasScannerWorkerToken(config)) return false;
  const presented = req.headers[SCANNER_WORKER_TOKEN_HEADER];
  const value = Array.isArray(presented)
    ? presented.length === 1
      ? presented[0]
      : undefined
    : presented;
  if (typeof value !== 'string' || value.trim() === '') return false;
  const a = createHash('sha256').update(value, 'utf8').digest();
  const b = createHash('sha256').update(config.scanner.workerToken, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function hasScannerWorkerToken(config: AppConfig): boolean {
  return config.scanner.workerToken.trim() !== '';
}

function notFound(reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
}

function unauthorized(reply: { code: (status: number) => { send: (body: unknown) => unknown } }): unknown {
  return reply.code(401).send({ error: { code: 'unauthorized', message: 'Authentication required' } });
}
