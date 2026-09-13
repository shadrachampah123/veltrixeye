import { loadConfig, loadDotEnv } from './config.js';
import { buildApp, createAppContext } from './app.js';
import { createPool, runMigrations, MIGRATIONS_DIR } from '@veltrixeye/core';
import { createTwelveDataProvider } from '@veltrixeye/provider-twelve-data';

/**
 * API entrypoint.
 *
 * Boot sequence:
 *  1. Validate environment (fail fast).
 *  2. Connect to Postgres (retry briefly — dev orchestration may start the
 *     database and API concurrently).
 *  3. Apply migrations (idempotent; drift-protected).
 *  4. Start listening.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const pool = createPool({
    databaseUrl: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    sslMode: config.DATABASE_SSL_MODE,
  });

  await waitForDatabase(pool, 30);

  const migrations = await runMigrations(pool, MIGRATIONS_DIR);
  if (migrations.applied.length > 0) {
        console.info(`[db] applied ${migrations.applied.length} migration(s): ${migrations.applied.join(', ')}`);
  }

  const ctx = createAppContext(pool, config);

  // M2 primary market-data provider. The API boots without a key on purpose
  // (dev/test, or an unkeyed deploy); market-data reads/backfills answer 502
  // until TWELVE_DATA_API_KEY is set. Production user-facing display
  // additionally requires a Business (Venture+) plan — see
  // docs/provider-licensing.md. The key itself is never logged.
  if (config.TWELVE_DATA_API_KEY !== '') {
    ctx.providerRegistry.register(
      createTwelveDataProvider({
        apiKey: config.TWELVE_DATA_API_KEY,
        baseUrl: config.TWELVE_DATA_BASE_URL,
        timeoutMs: config.TWELVE_DATA_TIMEOUT_MS,
        maxRequestsPerMinute: config.TWELVE_DATA_MAX_RPM,
        cryptoExchange: config.TWELVE_DATA_CRYPTO_EXCHANGE,
      }),
    );
    console.info('[api] market-data provider registered: twelve-data (historical)');
  } else {
    console.warn('[api] TWELVE_DATA_API_KEY is not set — market-data ingestion is unavailable (502)');
  }

  const app = await buildApp(config, ctx);

  await app.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async (signal: string) => {
        console.info(`[api] ${signal} received, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function waitForDatabase(pool: ReturnType<typeof createPool>, attempts: number): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
            console.info(`[api] database not ready, retrying (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await pool.end();
  throw new Error(`Could not connect to the database after ${attempts} attempts: ${(lastErr as Error)?.message}`);
}

main().catch((err) => {
    console.error('[api] fatal boot error:', err);
  process.exit(1);
});
