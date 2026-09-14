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
  EvaluationService,
  SetupService,
  ScoringService,
  type ProviderRegistry,
} from '@veltrixeye/core';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { strategyRoutes } from './routes/strategies.js';
import { marketDataRoutes } from './routes/market-data.js';
import { setupRoutes } from './routes/setups.js';

export interface AppContext {
  pool: pg.Pool;
  users: UserService;
  sessions: SessionService;
  strategies: StrategyService;
  audit: AuditService;
  providerRegistry: ProviderRegistry;
  candles: CandleStore;
  ingestion: IngestionService;
  evaluation: EvaluationService;
  setups: SetupService;
  scoring: ScoringService;
}

export function createAppContext(pool: pg.Pool, config: AppConfig): AppContext {
  const audit = new AuditService(pool);
  const providerRegistry = createProviderRegistry();
  const candles = new CandleStore(pool);
  const strategies = new StrategyService(pool, audit);
  // M3: reads the shared candle store ONLY (never the ingestion fetch-through),
  // so evaluation never triggers a provider call.
  const evaluation = new EvaluationService(pool, strategies, candles);
  return {
    pool,
    users: new UserService(pool),
    sessions: new SessionService(pool, config.SESSION_TTL_DAYS),
    strategies,
    audit,
    providerRegistry,
    candles,
    ingestion: new IngestionService(pool, providerRegistry, candles),
    evaluation,
    // M4: consumes the M3 evaluation service; writes setups + state events,
    // never scores, never providers.
    setups: new SetupService(pool, evaluation, candles),
    // M5: consumes the M3 evaluation service to rebuild the scoring context;
    // writes append-only setup_scores + refreshes setups.quality_score,
    // never transitions setups, never providers.
    scoring: new ScoringService(pool, strategies, evaluation),
  };
}

/**
 * Build the Fastify app WITHOUT listening.
 * Tests use `app.inject()` against this factory.
 */
export async function buildApp(config: AppConfig, ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV === 'production' ? { level: config.LOG_LEVEL } : false,
    /**
     * Client-IP resolution — pinned to the proxies that actually front this
     * service, never `true`.
     *
     * `req.ip` keys every rate limit and is what `audit_events.ip` /
     * `sessions.ip` record, so the trust list is a security boundary:
     * proxy-addr walks `X-Forwarded-For` from the socket outward and returns
     * the first address NOT in the list.
     *
     *  - `true` (the previous value) trusted every hop ⇒ `req.ip` was the
     *    LEFTMOST header value, which any client can set. This API is publicly
     *    reachable on *.onrender.com, so a caller could rotate that header and
     *    mint a fresh bucket per request (300/min global, 10/min login,
     *    60/min candles, 5/min backfill) — defeating all of them.
     *  - a NUMBER such as `1` does not mean "one hop" in Fastify 5: hop-count
     *    trust cannot validate the immediate peer, so Fastify fails closed and
     *    trusts nothing. Every request would then key on Render's load
     *    balancer address, collapsing all users into a single bucket.
     *  - the explicit list in `config.trustedProxies` (Cloudflare's published
     *    edge ranges + Render's internal hops, overridable via
     *    TRUSTED_PROXY_CIDRS) is the narrowest correct setting: spoofed
     *    entries sit to the LEFT of the address Cloudflare appended, so the
     *    walk stops at the real client and never reads them.
     *
     * Trade-off (documented in trust-proxy.ts and docs/deployment.md): traffic
     * proxied by the Vercel web app resolves to Vercel's egress address,
     * because Vercel publishes no egress range to pin. Coarser buckets, never
     * a client-chosen key; add Vercel Static IPs to TRUSTED_PROXY_CIDRS to
     * attribute that path per browser.
     */
    trustProxy: config.trustedProxies,
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
  // `req.ip` is only a safe key because `trustProxy` above is pinned to the
  // real infrastructure hops: it is the first address in the
  // X-Forwarded-For chain that is NOT Cloudflare/Render-internal, so a caller
  // cannot pick it by setting the header (regression tests in
  // apps/api/test/api.test.ts → "rate limits cannot be bypassed …").
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
  await setupRoutes(app, ctx, config);

  return app;
}
