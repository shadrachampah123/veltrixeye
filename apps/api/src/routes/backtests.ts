import type { FastifyInstance } from 'fastify';
import {
  backtestListQuerySchema,
  backtestInstrumentSchema,
  backtestDirectionSchema,
  backtestExitPolicySchema,
  backtestCostPolicySchema,
  MAX_BACKTEST_TRADES,
} from '@veltrixeye/contracts';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import { Errors } from '@veltrixeye/core';

/**
 * Backtest API routes (M6 Phase 2).
 *
 * POST /api/backtests — create or replay a backtest
 * GET /api/backtests — list owned runs
 * GET /api/backtests/:id — get one run + trades
 * GET /api/backtests/:id/trades — get trades for a run (paginated)
 *
 * All routes are session-authenticated, owner-scoped with masked 404s,
 * Zod-validated, rate-limited, and audited. No raw candle data is ever
 * returned (licensing-safe).
 */

const createBacktestBodySchema = z
  .object({
    strategyId: z.string().uuid(),
    versionId: z.string().uuid(),
    instrument: backtestInstrumentSchema,
    direction: backtestDirectionSchema.optional(),
    from: z.number().int().positive().max(9_999_999_999_999),
    to: z.number().int().positive().max(9_999_999_999_999),
    exitPolicy: backtestExitPolicySchema.optional(),
    costPolicy: backtestCostPolicySchema.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.from >= b.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '`from` must be earlier than `to`' });
    }
  });

const tradesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_BACKTEST_TRADES).default(50),
  })
  .strict();

export async function backtestRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  // POST /api/backtests — create or replay
  app.post(
    '/api/backtests',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const parsed = createBacktestBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const data = parsed.data;
      try {
        const result = await ctx.backtests.createBacktest({
          userId: user.id,
          strategyId: data.strategyId,
          versionId: data.versionId,
          instrument: data.instrument,
          direction: data.direction,
          from: data.from,
          to: data.to,
          exitPolicy: data.exitPolicy,
          costPolicy: data.costPolicy,
        });

        await ctx.audit.log({
          userId: user.id,
          action: result.created ? 'backtest.created' : 'backtest.replayed',
          entityType: 'backtest_run',
          entityId: result.run.id,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          metadata: {
            strategyId: data.strategyId,
            versionId: data.versionId,
            instrument: data.instrument,
            direction: result.run.direction,
            fromMs: data.from,
            toMs: data.to,
            configHash: result.run.configHash,
            created: result.created,
            truncated: result.truncated,
            stepsEvaluated: result.run.metrics.stepsEvaluated,
            setupsDetected: result.run.metrics.setupsDetected,
            tradesClosed: result.run.metrics.tradesClosed,
          },
        });

        // Deterministic replay behavior exposed via `created` flag
        return reply.code(result.created ? 201 : 200).send({
          run: result.run,
          trades: result.trades,
          truncated: result.truncated,
          created: result.created,
        });
      } catch (err) {
        // Map domain errors already handled by central handler, but ensure
        // audit for failures if needed
        if ((err as { code?: string })?.code === 'not_found') {
          // Masked 404 already, but audit as failure for observability
          await ctx.audit.log({
            userId: user.id,
            action: 'backtest.failed',
            entityType: 'backtest_run',
            entityId: null,
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
            metadata: {
              strategyId: data.strategyId,
              versionId: data.versionId,
              reason: (err as Error).message,
            },
          });
        }
        throw err;
      }
    },
  );

  // GET /api/backtests — list
  app.get('/api/backtests', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const parsed = backtestListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.backtests.listBacktests({ userId: user.id, ...parsed.data });
  });

  // GET /api/backtests/:id — detail
  app.get('/api/backtests/:id', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw Errors.notFound('Backtest not found');
    const result = await ctx.backtests.getBacktest({ userId: user.id, runId: id });
    return {
      run: result.run,
      trades: result.trades,
      truncated: result.truncated,
    };
  });

  // GET /api/backtests/:id/trades — trades list
  app.get('/api/backtests/:id/trades', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) throw Errors.notFound('Backtest not found');
    const parsed = tradesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    const result = await ctx.backtests.getTrades({ userId: user.id, runId: id, limit: parsed.data.limit });
    return {
      runId: result.run.id,
      trades: result.trades,
      truncated: result.truncated,
    };
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
