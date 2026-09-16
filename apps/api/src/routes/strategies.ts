import type { FastifyInstance } from 'fastify';
import {
  strategyCreateSchema,
  strategyUpdateSchema,
  strategyVersionCreateSchema,
  strategyVersionUpdateSchema,
  detectionRequestSchema,
  evaluationRequestSchema,
  TIMEFRAMES,
  TIMEFRAME_ROLES,
  TIMEFRAME_ROLE_LABELS,
  ASSET_CLASSES,
  ASSET_CLASS_LABELS,
  SESSION_NAMES,
  listConditionTypes,
  CONDITION_CLASSIFICATIONS,
  STOP_LOSS_METHODS,
  STOP_LOSS_METHOD_LABELS,
  TAKE_PROFIT_METHODS,
  TAKE_PROFIT_METHOD_LABELS,
  BUFFER_UNITS,
  QUALITY_GRADE_BANDS,
  DEFAULT_MIN_RR,
  DEFAULT_MIN_QUALITY_SCORE,
  STRATEGY_STATUSES,
  VERSION_STATUSES,
} from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';
import { Errors, type StrategyAuditMeta, getBillingState } from '@veltrixeye/core';
import type { FastifyRequest } from 'fastify';

export async function strategyRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  /**
   * Audit context for the service-layer events this module triggers
   * (strategy.created/updated/deleted, version lifecycle). `req.ip` is the
   * pinned trust-proxy resolution — never client-chosen (see trust-proxy.ts).
   */
  const auditMeta = (req: FastifyRequest): StrategyAuditMeta => ({
    ip: req.ip,
    userAgent: req.headers['user-agent'] ?? null,
  });

  // -- vocabulary/meta for the strategy editor (auth-gated) --
  app.get('/api/strategies/meta', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    return {
      timeframes: TIMEFRAMES,
      timeframeRoles: TIMEFRAME_ROLES.map((role) => ({ role, label: TIMEFRAME_ROLE_LABELS[role] })),
      assetClasses: ASSET_CLASSES.map((ac) => ({ value: ac, label: ASSET_CLASS_LABELS[ac] })),
      sessions: SESSION_NAMES,
      conditionTypes: listConditionTypes().map((t) => ({
        type: t.type,
        label: t.label,
        description: t.description,
        categories: t.categories,
        defaultTimeframeRole: t.defaultTimeframeRole,
      })),
      conditionClassifications: CONDITION_CLASSIFICATIONS,
      ruleGroupLogics: ['AND', 'OR'],
      risk: {
        defaultMinRr: DEFAULT_MIN_RR,
        defaultMinQualityScore: DEFAULT_MIN_QUALITY_SCORE,
        stopLossMethods: STOP_LOSS_METHODS.map((m) => ({ value: m, label: STOP_LOSS_METHOD_LABELS[m] })),
        takeProfitMethods: TAKE_PROFIT_METHODS.map((m) => ({ value: m, label: TAKE_PROFIT_METHOD_LABELS[m] })),
        bufferUnits: BUFFER_UNITS,
      },
      qualityGrades: QUALITY_GRADE_BANDS,
      strategyStatuses: STRATEGY_STATUSES,
      versionStatuses: VERSION_STATUSES,
    };
  });

  // -- strategies --
  app.get('/api/strategies', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const strategies = await ctx.strategies.listStrategies(user.id);
    return { strategies };
  });

  app.post('/api/strategies', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = strategyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    
    const strategy = await ctx.strategies.createStrategy(user.id, parsed.data, auditMeta(req));
    return reply.code(201).send({ strategy });
  });

  app.get('/api/strategies/:strategyId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { strategyId } = req.params as { strategyId: string };
    if (!isUuid(strategyId)) throw Errors.notFound('Strategy not found');
    const strategy = await ctx.strategies.getStrategy(user.id, strategyId);
    return { strategy };
  });

  app.patch('/api/strategies/:strategyId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = strategyUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    const { strategyId } = req.params as { strategyId: string };
    if (!isUuid(strategyId)) throw Errors.notFound('Strategy not found');
    const strategy = await ctx.strategies.updateStrategy(user.id, strategyId, parsed.data, auditMeta(req));
    return { strategy };
  });

  app.delete('/api/strategies/:strategyId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { strategyId } = req.params as { strategyId: string };
    if (!isUuid(strategyId)) throw Errors.notFound('Strategy not found');
    await ctx.strategies.deleteStrategy(user.id, strategyId, auditMeta(req));
    return reply.code(204).send();
  });

  // -- versions --
  app.post('/api/strategies/:strategyId/versions', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = strategyVersionCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    const { strategyId } = req.params as { strategyId: string };
    if (!isUuid(strategyId)) throw Errors.notFound('Strategy not found');
    const version = await ctx.strategies.createVersion(user.id, strategyId, parsed.data, auditMeta(req));
    return reply.code(201).send({ version });
  });

  app.get('/api/strategies/:strategyId/versions/:versionId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { strategyId, versionId } = req.params as { strategyId: string; versionId: string };
    if (!isUuid(strategyId) || !isUuid(versionId)) throw Errors.notFound('Version not found');
    const version = await ctx.strategies.getVersion(user.id, strategyId, versionId);
    return { version };
  });

  app.patch('/api/strategies/:strategyId/versions/:versionId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = strategyVersionUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    const { strategyId, versionId } = req.params as { strategyId: string; versionId: string };
    if (!isUuid(strategyId) || !isUuid(versionId)) throw Errors.notFound('Version not found');
    const version = await ctx.strategies.updateVersionConfig(user.id, strategyId, versionId, parsed.data, auditMeta(req));
    return { version };
  });

  app.post('/api/strategies/:strategyId/versions/:versionId/publish', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { strategyId, versionId } = req.params as { strategyId: string; versionId: string };
    if (!isUuid(strategyId) || !isUuid(versionId)) throw Errors.notFound('Version not found');
    const version = await ctx.strategies.publishVersion(user.id, strategyId, versionId, auditMeta(req));
    return { version };
  });

  app.post('/api/strategies/:strategyId/versions/:versionId/deprecate', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user } = req as AuthenticatedRequest;
    const { strategyId, versionId } = req.params as { strategyId: string; versionId: string };
    if (!isUuid(strategyId) || !isUuid(versionId)) throw Errors.notFound('Version not found');
    const version = await ctx.strategies.deprecateVersion(user.id, strategyId, versionId, auditMeta(req));
    return { version };
  });

  /**
   * Deterministic evaluation of a PUBLISHED version (M3).
   *
   * Read-only over the shared candle store: this route never writes setups,
   * scores or state events, and never triggers provider fetch-through
   * (evaluation reads the store directly, so it works with no provider key).
   * The optional `asOf` body field pins the evaluation anchor for
   * reproducibility; omitting it pins the anchor to the current time at the
   * API edge (the only wall-clock read in the evaluation path).
   */
  app.post(
    '/api/strategies/:strategyId/versions/:versionId/evaluate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const { strategyId, versionId } = req.params as { strategyId: string; versionId: string };
      if (!isUuid(strategyId) || !isUuid(versionId)) throw Errors.notFound('Version not found');
      const parsed = evaluationRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const result = await ctx.evaluation.evaluateVersion({
        userId: user.id,
        strategyId,
        versionId,
        asOf: parsed.data.asOf,
      });
      await ctx.audit.log({
        userId: user.id,
        action: 'strategy.evaluated',
        entityType: 'strategy_version',
        entityId: versionId,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          strategyId,
          versionNumber: result.versionNumber,
          instruments: result.instruments.length,
          truncated: result.truncated,
          asOfMs: result.asOfMs,
          anyPassed: result.instruments.some((i) => i.anyPassed),
        },
      });
      return result;
    },
  );

  /**
   * Setup detection from a PUBLISHED version (M4).
   *
   * Consumes the M3 evaluation for one instrument at an explicit anchor and
   * persists a setup per qualifying direction. Idempotent per
   * (version, instrument, direction, asOfMs): repeats return the existing
   * setup and write nothing. Never scores, never touches a provider.
   * `asOf` is REQUIRED — M4 performs no wall-clock read.
   */
  app.post(
    '/api/strategies/:strategyId/versions/:versionId/detect',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const { user } = req as AuthenticatedRequest;
      const { strategyId, versionId } = req.params as { strategyId: string; versionId: string };
      if (!isUuid(strategyId) || !isUuid(versionId)) throw Errors.notFound('Version not found');
      const parsed = detectionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      
      const result = await ctx.setups.detect({
        userId: user.id,
        strategyId,
        versionId,
        assetClass: parsed.data.instrument.assetClass,
        symbol: parsed.data.instrument.symbol,
        direction: parsed.data.direction,
        asOf: parsed.data.asOf,
      });
      await ctx.audit.log({
        userId: user.id,
        action: 'setup.detected',
        entityType: 'strategy_version',
        entityId: versionId,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          strategyId,
          versionNumber: result.versionNumber,
          assetClass: result.instrument.assetClass,
          symbol: result.instrument.symbol,
          asOfMs: result.asOfMs,
          qualified: result.detections.filter((d) => d.qualified).map((d) => d.direction),
          created: result.detections.filter((d) => d.created).map((d) => d.direction),
        },
      });
      return result;
    },
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
