import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import type { AppConfig } from './config.js';
import { isProduction } from './config.js';
import { errorHandler } from './errors.js';
import {
  UserService,
  SessionService,
  StrategyService,
  AuditService,
  createProviderRegistry,
  CandleStore,
  IngestionService,
  type ProviderRegistry,
} from '@veltrixeye/core';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { strategyRoutes } from './routes/strategies.js';
import { marketDataRoutes } from './routes/market-data.js';

export interface AppContext {
  pool: pg.Pool;
  users: UserService;
  sessions: SessionService;
  strategies: StrategyService;
  audit: AuditService;
  providerRegistry: ProviderRegistry;
  candles: CandleStore;
  ingestion: IngestionService;
}

export function createAppContext(pool: pg.Pool, config: AppConfig): AppContext {
  const audit = new AuditService(pool);
  const providerRegistry = createProviderRegistry();
  const candles = new CandleStore(pool);
  return {
    pool,
    users: new UserService(pool),
    sessions: new SessionService(pool, config.SESSION_TTL_DAYS),
    strategies: new StrategyService(pool, audit),
    audit,
    providerRegistry,
    candles,
    ingestion: new IngestionService(pool, providerRegistry, candles),
  };
}

/**
 * Build the Fastify app WITHOUT listening.
 * Tests use `app.inject()` against this factory.
 */
export async function buildApp(config: AppConfig, ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === 'production' ? { level: config.LOG_LEVEL } : false,
    trustProxy: true,
    bodyLimit: 256 * 1024, // 256 KB — strategy configs are small; reject fat payloads
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({
      error: { code: 'not_found', message: 'Route not found' },
    });
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' }, // the API serves no framable content
    hsts: isProduction(config)
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false,
  });

  // Global API rate limit (per IP); credential endpoints get stricter
  // per-route overrides (see routes/auth.ts via route config).
  // Note: the plugin THROWS the builder's result, so we return an Error
  // tagged with statusCode 429 and let the central error handler send it.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, context) => {
      const err = new Error(
        `Rate limit exceeded. Try again in ${Math.ceil((context.ttl ?? 0) / 1000)}s.`,
      ) as Error & { statusCode: number; rateLimited: boolean };
      err.statusCode = 429;
      err.rateLimited = true;
      return err;
    },
  });

  await healthRoutes(app, ctx);
  await authRoutes(app, ctx, config);
  await userRoutes(app, ctx, config);
  await strategyRoutes(app, ctx, config);
  await marketDataRoutes(app, ctx, config);

  return app;
}
