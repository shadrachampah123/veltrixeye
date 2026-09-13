import type { FastifyInstance } from 'fastify';
import { backfillRequestSchema, candleQuerySchema } from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, type AuthenticatedRequest } from '../session-auth.js';

/**
 * Market-data routes (M2: historical ingestion, persistence, retrieval).
 *
 * The candle store is global and shared — every authenticated user reads the
 * same ingested candles — but every route still requires a session (no
 * anonymous market-data access). Reads fetch through to the registered
 * provider on cache miss; backfills are explicit, bounded, and audited.
 * No raw-data export exists (display only, per docs/provider-licensing.md).
 */
export async function marketDataRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  /** Registered market-data providers (runtime registry). */
  app.get('/api/market-data/providers', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const providers = ctx.providerRegistry.list();
    return {
      providers,
      note:
        providers.length === 0
          ? 'No market-data provider is registered. Set TWELVE_DATA_API_KEY and restart the API.'
          : undefined,
    };
  });

  /** Normalized instruments known to the platform (provider-independent). */
  app.get('/api/markets/instruments', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const res = await ctx.pool.query<{ asset_class: string; symbol: string; display_name: string | null }>(
      'SELECT asset_class, symbol, display_name FROM instruments ORDER BY asset_class, symbol',
    );
    return {
      instruments: res.rows.map((r) => ({
        assetClass: r.asset_class,
        symbol: r.symbol,
        displayName: r.display_name,
      })),
    };
  });

  /**
   * Historical candles for one instrument × timeframe × [from, to).
   * Missing head/tail ranges are fetched from the provider, persisted, and
   * then served — every response after the first is served from the store.
   */
  app.get(
    '/api/market-data/candles',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const parsed = candleQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'query');
        return;
      }
      const { user } = req as AuthenticatedRequest;
      const result = await ctx.ingestion.getCandles({ ...parsed.data, initiatedBy: user.id });
      return result;
    },
  );

  /** Coverage ledger: what the store holds per instrument × timeframe. */
  app.get('/api/market-data/coverage', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const coverage = await ctx.candles.getCoverage({});
    return { coverage };
  });

  /**
   * Explicit manual backfill over instruments × timeframes × [from, to).
   * Bounded by retention and the per-request candle cap; audited; no
   * scheduler exists in M2, so this (plus fetch-through) is the only writer.
   */
  app.post(
    '/api/market-data/backfill',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ok = await requireAuth(req, reply);
      if (!ok) return;
      const parsed = backfillRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendZodError(reply, parsed.error, 'body');
        return;
      }
      const { user } = req as AuthenticatedRequest;
      const result = await ctx.ingestion.backfill({ ...parsed.data, initiatedBy: user.id });
      await ctx.audit.log({
        userId: user.id,
        action: 'market_data.backfill',
        entityType: 'ingestion_run',
        entityId: result.runId,
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
        metadata: {
          instruments: parsed.data.instruments.length,
          timeframes: parsed.data.timeframes.length,
          status: result.status,
          candlesUpserted: result.candlesUpserted,
        },
      });
      return result;
    },
  );
}
