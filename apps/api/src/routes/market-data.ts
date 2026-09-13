import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { createSessionAuth } from '../session-auth.js';

export async function marketDataRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  /**
   * Registered market-data providers (runtime). M1: empty — no provider is
   * implemented yet. This endpoint exists so the UI and future modules can
   * discover providers without knowing concrete implementations.
   */
  app.get('/api/market-data/providers', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    return {
      providers: ctx.providerRegistry.list(),
      note: 'No market-data provider is registered yet (M1). See docs/provider-abstraction.md.',
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
}
