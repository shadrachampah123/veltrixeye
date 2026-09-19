import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type pg from 'pg';
import type { AppConfig } from './config.js';
import { isProduction } from './config.js';
import { errorHandler } from './errors.js';
import {
  redactSecrets,
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
  BacktestService,
  AlertService,
  StubAlertSender,
  ScannerService,
  // M7.3 delivery pipeline
  createNotificationProviderRegistry,
  createSmtpEmailProvider,
  createWebhookNotificationProvider,
  NotificationOutbox,
  NotificationPreferenceService,
  DeliveryWorker,
  // M8.1 execution architecture (safety boundary only — no provider can trade)
  createExecutionProviderRegistry,
  createPaperExecutionProvider,
  createMT5ExecutionProvider,
  DisabledMT5Transport,
  PaperExecutionService,
  CandleStoreMarketPriceSource,
  KillSwitchService,
  SafetyControlsService,
  ExecutionProfileService,
  AutomationService,
  ExecutionIntakeService,
  ExecutionQueryService,
  ReconciliationService,
  PaperReconciliationSnapshotProvider,
  ProviderReconciliationSnapshotProvider,
  RiskEngineService,
  type ProviderRegistry,
  type NotificationProviderRegistry,
  type DeliveryRetryPolicy,
  type ExecutionProviderRegistry,
} from '@veltrixeye/core';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { strategyRoutes } from './routes/strategies.js';
import { marketDataRoutes } from './routes/market-data.js';
import { setupRoutes } from './routes/setups.js';
import { backtestRoutes } from './routes/backtests.js';
import { alertRoutes } from './routes/alerts.js';
import { notificationRoutes } from './routes/notifications.js';
import { billingRoutes } from './routes/billing.js';
import { scannerRoutes } from './routes/scanner.js';
import {
  executionRoutes,
  paperExecutionRoutes,
  reconciliationRoutes,
  safetyRoutes,
} from './routes/execution.js';
import { riskRoutes } from './routes/risk.js';

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
  backtests: BacktestService;
  alerts: AlertService;
  scanner: ScannerService;
  /** M7.3: channel → provider adapter registry (the only provider-aware object). */
  notificationProviders: NotificationProviderRegistry;
  /** M7.3: durable outbox — writes/reads `notification_deliveries`. */
  notifications: NotificationOutbox;
  preferences: NotificationPreferenceService;
  /** M7.3: the delivery worker (run in-process, by cron, or manually). */
  deliveryWorker: DeliveryWorker;
  /** M7.3: the retry/lease policy derived from the environment. */
  deliveryPolicy: DeliveryRetryPolicy;
  /**
   * M8.1: execution architecture bundle. Safety boundary only — the single
   * registered provider (paper) reports not-ready and refuses every trading
   * operation, and no route exposes order submission.
   */
  execution: {
    providers: ExecutionProviderRegistry;
    killSwitches: KillSwitchService;
    profiles: ExecutionProfileService;
    automation: AutomationService;
    intake: ExecutionIntakeService;
    queries: ExecutionQueryService;
    risk: RiskEngineService;
    /**
     * M8.3: internal deterministic paper simulator. No broker, no credential,
     * no external trading call — every order it writes is simulated.
     */
    paper: PaperExecutionService;
    /**
     * M8.5: provider-neutral order & position reconciliation. Fail-closed,
     * idempotent, concurrency-safe. Destructive corrective actions are gated
     * OFF; mismatches produce findings for manual resolution.
     */
    reconciliation: ReconciliationService;
    /**
     * M8.6: safety controls — kill-switch status/history for every scope the
     * account owns, the emergency stop (arm switch + automation OFF + profiles
     * disabled, one transaction), and the loss-limit circuit-breaker wiring.
     * Stopping is always allowed; nothing here can arm execution.
     */
    safety: SafetyControlsService;
  };
}

export function createAppContext(pool: pg.Pool, config: AppConfig): AppContext {
  const audit = new AuditService(pool);
  const providerRegistry = createProviderRegistry();
  const candles = new CandleStore(pool);
  const strategies = new StrategyService(pool, audit);
  // M3: reads the shared candle store ONLY (never the ingestion fetch-through),
  // so evaluation never triggers a provider call.
  const evaluation = new EvaluationService(pool, strategies, candles);
  const setups = new SetupService(pool, evaluation, candles);

  // M7.3 — notification delivery. The registry is the ONLY place a channel is
  // bound to an adapter; an unconfigured email adapter is still registered
  // when its credentials exist, and simply omitted when they do not, so the
  // worker records `unavailable` instead of faking a delivery.
  const notificationProviders = createNotificationProviderRegistry();
  const emailProvider = createSmtpEmailProvider(config.notification.email);
  if (emailProvider.configured) notificationProviders.register(emailProvider);
  // M9.1 — webhook is endpoint-configured per notification preference.
  notificationProviders.register(createWebhookNotificationProvider({ timeoutMs: config.notification.retry.timeoutMs }));

  const notifications = new NotificationOutbox(pool, {
    maxAttempts: config.notification.retry.maxAttempts,
  });
  const preferences = new NotificationPreferenceService(pool);
  const deliveryWorker = new DeliveryWorker(pool, notificationProviders, config.notification.retry, {
    retention: config.notification.retention,
    // Defence in depth: adapters redact their own secrets, and the worker also
    // scrubs the credentials THIS deployment configured out of any provider
    // error before it is stored in `last_error` or written to a log line.
    redact: (text) => redactSecrets(text, [config.notification.email.pass]),
  });

  const ingestion = new IngestionService(pool, providerRegistry, candles);
  const backtests = new BacktestService(pool, strategies, candles);
  const alerts = new AlertService(pool, strategies, new StubAlertSender(), notifications, preferences);
  const scoring = new ScoringService(pool, strategies, evaluation);

  // M8.1/M8.3 — execution architecture + the internal paper simulator.
  // Exactly ONE provider registers (paper), bound to the in-process simulator:
  // there is no broker connectivity anywhere, and the provider refuses every
  // order that does not carry a server-issued authorization.
  const executionProviders = createExecutionProviderRegistry();
  // M8.6: the deployment-level global kill switch (EXECUTION_GLOBAL_KILL_SWITCH)
  // pins the platform stop ON regardless of DB state; no API can clear it.
  const killSwitches = new KillSwitchService(pool, {
    globalForced: config.EXECUTION_GLOBAL_KILL_SWITCH,
  });
  const automation = new AutomationService(pool, killSwitches, audit);
  const risk = new RiskEngineService(
    pool,
    { killSwitches, audit },
    {
      logger: {
        info: (msg, meta) => {
          if (config.NODE_ENV === 'production') {
            console.info(`[risk] ${msg}`, meta ? JSON.stringify(meta) : '');
          }
        },
        warn: (msg, meta) => console.warn(`[risk] ${msg}`, meta ? JSON.stringify(meta) : ''),
      },
    },
  );
  // M8.3 — the paper simulator is created BEFORE the provider so the provider
  // can be bound to it; the service resolves the provider lazily (below) so
  // there is no construction cycle.
  const paperMarket = new CandleStoreMarketPriceSource(pool);
  let paperService: PaperExecutionService;
  const paperProvider = createPaperExecutionProvider({
    simulator: {
      submitAuthorizedOrder: (args) => paperService.submitAuthorizedOrder(args),
    },
  });
  executionProviders.register(paperProvider);
  // M8.4: MT5 is a registered, honest integration boundary. The deployed
  // transport is deliberately disabled/unconfigured: no endpoint, SDK,
  // credential, terminal, or network path exists and live is hard-stopped.
  executionProviders.register(createMT5ExecutionProvider(new DisabledMT5Transport(), {
    enabled: false,
    environment: 'demo',
    broker: null,
    server: null,
    accountRef: null,
    symbols: new Map(),
  }));
  const execution = {
    providers: executionProviders,
    killSwitches,
    profiles: new ExecutionProfileService(pool, executionProviders, audit),
    automation,
    intake: new ExecutionIntakeService(
      pool,
      { automation, killSwitches, providers: executionProviders, audit, risk },
      {
        logger: {
          info: (msg, meta) => {
            if (config.NODE_ENV === 'production') {
              console.info(`[execution] ${msg}`, meta ? JSON.stringify(meta) : '');
            }
          },
          warn: (msg, meta) => console.warn(`[execution] ${msg}`, meta ? JSON.stringify(meta) : ''),
        },
      },
    ),
    queries: new ExecutionQueryService(pool),
    risk,
    paper: (paperService = new PaperExecutionService(
      pool,
      {
        market: paperMarket,
        risk,
        killSwitches,
        automation,
        audit,
        provider: () => executionProviders.get(paperProvider.id),
      },
      {
        logger: {
          info: (msg, meta) => {
            if (config.NODE_ENV === 'production') {
              console.info(`[paper] ${msg}`, meta ? JSON.stringify(meta) : '');
            }
          },
          warn: (msg, meta) => console.warn(`[paper] ${msg}`, meta ? JSON.stringify(meta) : ''),
        },
      },
    )),
    safety: new SafetyControlsService(pool, { killSwitches, automation, audit }),
    reconciliation: new ReconciliationService(
      pool,
      {
        getProvider: (id) => executionProviders.get(id),
        snapshots: {
          // M8.5: composition root dispatches to the owner-scoped paper
          // snapshot provider for paper profiles, and the generic provider
          // adapter for anything else (which in M8.5 returns unavailable
          // for the disabled MT5 transport — fail-closed).
          async getSnapshot(args) {
            if (args.providerId === 'paper') {
              return new PaperReconciliationSnapshotProvider(pool).getSnapshot(args);
            }
            return new ProviderReconciliationSnapshotProvider((id) =>
              executionProviders.get(id),
            ).getSnapshot(args);
          },
        },
        audit,
      },
    ),
  };

  // M7.5 — live scanner (production market-data and scanner pipeline)
  const scanner = new ScannerService(pool, providerRegistry, candles, ingestion, evaluation, setups, scoring, alerts, {
    logger: {
      info: (msg, meta) => {
        if (config.NODE_ENV === 'production') {
          console.info(`[scanner] ${msg}`, meta ? JSON.stringify(meta) : '');
        }
      },
      warn: (msg, meta) => console.warn(`[scanner] ${msg}`, meta ? JSON.stringify(meta) : ''),
      error: (msg, meta) => console.error(`[scanner] ${msg}`, meta ? JSON.stringify(meta) : ''),
    },
  });

  return {
    pool,
    users: new UserService(pool),
    sessions: new SessionService(pool, config.SESSION_TTL_DAYS),
    strategies,
    audit,
    providerRegistry,
    candles,
    ingestion,
    evaluation,
    // M4: consumes the M3 evaluation service; writes setups + state events,
    // never scores, never providers.
    setups,
    // M5: consumes the M3 evaluation service to rebuild the scoring context;
    // writes append-only setup_scores + refreshes setups.quality_score,
    // never transitions setups, never providers.
    scoring,
    // M6 Phase 2: backtest service (pure engine + store-only reads + idempotent persistence)
    backtests,
    // M6 Phase 2 / M7.3: alert service (eligible states, M5 gate, dedup, stub
    // ledger) + the durable outbox hand-off. Alert generation still performs
    // NO external I/O: it enqueues a job, the worker delivers it.
    alerts,
    // M7.5: live scanner
    scanner,
    notificationProviders,
    notifications,
    preferences,
    deliveryWorker,
    deliveryPolicy: config.notification.retry,
    // M8.1: execution architecture (safety boundary; no provider can trade)
    execution,
  };
}

/**
 * One-shot startup housekeeping (M7.2): remove sessions that have passed
 * their TTL. Sessions are created on every successful login and otherwise
 * linger until their expiry — the platform runs no scheduler by design, so
 * boot is the only place this cleanup can happen. Removing expired rows
 * bounds `sessions` growth and keeps the per-user session list small.
 * Returns the number of rows removed.
 */
export async function runStartupHousekeeping(ctx: AppContext): Promise<number> {
  return ctx.sessions.deleteExpired();
}

/**
 * One-shot delivery recovery (M7.3): return outbox jobs that a previous
 * process claimed but never finished — a crash, a deploy or an instance that
 * was stopped mid-delivery — to `pending` (or dead-letter them when their
 * retry budget is gone). Two bounded UPDATEs, no provider I/O, never throws:
 * a recovery failure must not block boot (the next worker run retries it).
 */
export async function runStartupDeliveryRecovery(
  ctx: AppContext,
): Promise<{ recovered: number; deadLettered: number }> {
  return ctx.deliveryWorker.recoverStale();
}

/**
 * One-shot scanner recovery (M7.5): mark stale running scanner runs as failed
 * after a crash/restart. Cheap: one bounded UPDATE, no provider I/O.
 */
export async function runStartupScannerRecovery(ctx: AppContext): Promise<{ recovered: number }> {
  return ctx.scanner.recoverStaleRuns();
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
  await backtestRoutes(app, ctx, config);
  await alertRoutes(app, ctx, config);
  await notificationRoutes(app, ctx, config);
  await billingRoutes(app, ctx, config);
  await scannerRoutes(app, ctx, config);
  await executionRoutes(app, ctx, config);
  await paperExecutionRoutes(app, ctx, config);
  await reconciliationRoutes(app, ctx, config);
  await safetyRoutes(app, ctx, config);
  await riskRoutes(app, ctx, config);

  return app;
}
