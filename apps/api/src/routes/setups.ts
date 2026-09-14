import type { FastifyInstance } from 'fastify';
import {
  scoreHistoryQuerySchema,
  setupListQuerySchema,
  setupScoreRequestSchema,
  setupTransitionRequestSchema,
} from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import { Errors } from '@veltrixeye/core';

/**
 * Setup read + lifecycle routes (M4) and quality scoring (M5).
 *
 * All routes are session-authenticated and owner-scoped through the setup's
 * strategy: a foreign or nonexistent setup is a masked 404, exactly like
 * strategies. Detection itself lives on the version resource
 * (`POST …/versions/:versionId/detect` in routes/strategies.ts).
 */
export async function setupRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  /** The acting user's setups, newest first (all filters optional). */
  app.get('/api/setups', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = setupListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    return ctx.setups.listSetups({ userId: user.id, ...parsed.data });
  });

  /** One owned setup plus its full lifecycle history (oldest event first). */
  app.get('/api/setups/:setupId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { setupId } = req.params as { setupId: string };
    if (!isUuid(setupId)) throw Errors.notFound('Setup not found');
    return ctx.setups.getSetup({ userId: user.id, setupId });
  });

  /**
   * Request a lifecycle transition. Same-state repeats are idempotent
   * no-ops; anything the state machine forbids fails with no partial
   * writes. `asOf` pins the transition event's timestamp explicitly.
   */
  app.post(
    '/api/setups/:setupId/transitions',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const { setupId } = req.params as { setupId: string };
      if (!isUuid(setupId)) throw Errors.notFound('Setup not found');
      const parsed = setupTransitionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const result = await ctx.setups.transitionSetup({
        userId: user.id,
        setupId,
        toState: parsed.data.toState,
        reason: parsed.data.reason,
        asOf: parsed.data.asOf,
      });
      await ctx.audit.log({
        userId: user.id,
        action: 'setup.transitioned',
        entityType: 'setup',
        entityId: setupId,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          toState: result.setup.state,
          transitioned: result.transitioned,
          asOfMs: parsed.data.asOf,
        },
      });
      return result;
    },
  );

  /**
   * Deterministic quality scoring (M5).
   *
   * Rebuilds the M3 evaluation context at the scoring anchor (default: the
   * setup's own detection anchor) through the existing evaluation service —
   * store-only reads, never a provider — and runs the pure scoring engine.
   * Idempotent per (setup, engine version, anchor): a replayed context
   * returns the stored score and writes nothing; concurrent duplicates
   * serialize on the 0010 unique constraint. Scoring never transitions the
   * setup — it only inserts an append-only `setup_scores` row and refreshes
   * `setups.quality_score` transactionally.
   */
  app.post(
    '/api/setups/:setupId/score',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const { setupId } = req.params as { setupId: string };
      if (!isUuid(setupId)) throw Errors.notFound('Setup not found');
      const parsed = setupScoreRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const result = await ctx.scoring.scoreSetup({
        userId: user.id,
        setupId,
        asOf: parsed.data.asOf,
      });
      await ctx.audit.log({
        userId: user.id,
        action: 'setup.scored',
        entityType: 'setup',
        entityId: setupId,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          total: result.score.total,
          grade: result.score.grade,
          engineVersion: result.score.engineVersion,
          asOfMs: result.score.asOfMs,
          created: result.created,
        },
      });
      return result;
    },
  );

  /** One owned setup's append-only score history (newest anchor first). */
  app.get('/api/setups/:setupId/scores', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { setupId } = req.params as { setupId: string };
    if (!isUuid(setupId)) throw Errors.notFound('Setup not found');
    const parsed = scoreHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'query');
      return;
    }
    return ctx.scoring.listScores({ userId: user.id, setupId, limit: parsed.data.limit });
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
