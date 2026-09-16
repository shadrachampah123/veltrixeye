import { loadConfig, loadDotEnv } from './config.js';
import {
  buildApp,
  createAppContext,
  runStartupHousekeeping,
  runStartupDeliveryRecovery,
  runStartupScannerRecovery,
} from './app.js';
import { startDeliveryWorkerTicker, consoleDeliveryLogger } from './delivery-worker.js';
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

  // M7.2 housekeeping: drop sessions past their TTL (no scheduler exists by
  // design, so boot is the cleanup point). Never throws: a cleanup failure
  // must not block boot — the queries are trivial DELETEs.
  try {
    const removed = await runStartupHousekeeping(ctx);
    if (removed > 0) console.info(`[db] removed ${removed} expired session(s) at startup`);
  } catch (err) {
    console.warn('[api] expired-session cleanup failed (continuing):', (err as Error)?.message);
  }

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

  // M7.3 — notification delivery. Log the channel state WITHOUT credentials:
  // `describe()` is the provider's operator-safe view (host/port/from only,
  // never the SMTP password). Unconfigured is a normal state, not an error:
  // outbox jobs are still created and the worker records them `unavailable`
  // rather than pretending they were delivered.
  const email = ctx.notificationProviders.list()[0];
  if (email?.configured) {
    const emailProvider = ctx.notificationProviders.get('email');
    console.info(
      `[api] notification channel "email" configured: ${JSON.stringify(emailProvider?.describe() ?? {})}`,
    );
  } else {
    console.warn(
      '[api] email delivery is NOT configured (SMTP_HOST / NOTIFICATION_FROM missing) — ' +
        'alert notifications are queued and recorded as "unavailable", never as delivered. ' +
        'Set the SMTP_* / NOTIFICATION_FROM environment variables to enable delivery.',
    );
  }

  // Recover jobs a previous process claimed but never finished (crash, deploy,
  // scale-down). Cheap: two bounded UPDATEs, no provider I/O. Never throws.
  try {
    const recovery = await runStartupDeliveryRecovery(ctx);
    if (recovery.recovered > 0 || recovery.deadLettered > 0) {
      console.info(
        `[api] delivery recovery: ${recovery.recovered} job(s) re-queued, ${recovery.deadLettered} dead-lettered`,
      );
    }
  } catch (err) {
    console.warn('[api] delivery recovery failed (continuing):', (err as Error)?.message);
  }

  // M7.5 — scanner recovery: mark stale running scanner runs as failed after restart.
  try {
    const scannerRecovery = await runStartupScannerRecovery(ctx);
    if (scannerRecovery.recovered > 0) {
      console.info(`[api] scanner recovery: ${scannerRecovery.recovered} stale run(s) marked failed`);
    }
  } catch (err) {
    console.warn('[api] scanner recovery failed (continuing):', (err as Error)?.message);
  }

  const app = await buildApp(config, ctx);

  await app.listen({ port: config.PORT, host: config.HOST });

  // Drain the outbox on an interval. An external scheduler can do the same
  // through the token-protected internal endpoint; both are safe together.
  let workerTicker: Awaited<ReturnType<typeof startDeliveryWorkerTicker>> | null = null;
  if (config.notification.worker.enabled) {
    workerTicker = startDeliveryWorkerTicker(ctx.deliveryWorker, {
      intervalMs: config.notification.worker.intervalMs,
      batchSize: config.notification.worker.batchSize,
      logger: consoleDeliveryLogger('[notifications]'),
    });
    console.info(
      `[api] notification worker enabled (every ${config.notification.worker.intervalMs}ms, ` +
        `batch ${config.notification.worker.batchSize})`,
    );
  } else {
    console.warn(
      '[api] notification worker is disabled — the outbox drains only when the internal ' +
        'endpoint is called by an external scheduler (NOTIFICATION_WORKER_TOKEN).',
    );
  }

  // M7.5 — live scanner ticker (optional, disabled by default in dev).
  let scannerTicker: NodeJS.Timeout | null = null;
  if (config.scanner.enabled) {
    console.info(`[api] live scanner enabled (every ${config.scanner.intervalMs}ms)`);
    const runScanner = async () => {
      try {
        const result = await ctx.scanner.runOnce({});
        if (!result.skipped) {
          console.info(
            `[scanner] run ${result.run.id} ${result.run.status}: ${result.run.setupsDetected} setups, ${result.run.alertsCreated} alerts`,
          );
        }
      } catch (err) {
        console.warn('[scanner] run failed:', (err as Error)?.message);
      }
    };
    // Initial delay to let the server settle
    setTimeout(() => void runScanner(), 10_000);
    scannerTicker = setInterval(() => void runScanner(), config.scanner.intervalMs);
  } else {
    console.info('[api] live scanner is disabled — enable with SCANNER_ENABLED=true or trigger via POST /api/scanner/trigger');
  }

  const shutdown = async (signal: string) => {
        console.info(`[api] ${signal} received, shutting down`);
    if (scannerTicker) clearInterval(scannerTicker);
    await workerTicker?.stop().catch(() => {});
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
