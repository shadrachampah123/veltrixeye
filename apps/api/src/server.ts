import { loadConfig, loadDotEnv } from './config.js';
import {
  buildApp,
  createAppContext,
  runStartupHousekeeping,
  runStartupDeliveryRecovery,
  runStartupScannerRecovery,
} from './app.js';
import { startDeliveryWorkerTicker, consoleDeliveryLogger } from './delivery-worker.js';
import { startScannerWorkerTicker, consoleScannerLogger } from './scanner-worker.js';
import { consoleFxSourceLogger, startFxSourceTicker } from './fx-source-runner.js';
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

  // Billing PR3 — Paystack SANDBOX. Logged WITHOUT credentials: `describe()`
  // carries the host, mode, live flag and implemented operations only. A key
  // that is absent is a normal state (billing simply unavailable), not an
  // error, and a key that is not a test key stops the boot in `loadConfig`.
  if (ctx.billingComposition.registered) {
    console.info(
      `[api] billing provider registered: ${JSON.stringify(ctx.billingComposition.describe ?? {})}`,
    );
  } else {
    console.warn(`[api] billing is unavailable — ${ctx.billingComposition.reason}`);
  }

  // M7.3 — notification delivery. Log the channel state WITHOUT credentials:
  // `describe()` is the provider's operator-safe view (host/port/from only,
  // never the SMTP password). Unconfigured is a normal state, not an error:
  // outbox jobs are still created and the worker records them `unavailable`
  // rather than pretending they were delivered.
  const emailProvider = ctx.notificationProviders.get('email');
  if (emailProvider?.configured) {
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

  // M7.5 / F3 — scanner recovery: mark stale running scanner runs as failed after restart.
  try {
    const scannerRecovery = await runStartupScannerRecovery(ctx, config.scanner.leaseMs);
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

  // M7.5 / F3 — live scanner ticker (optional, disabled by default in dev).
  // An external scheduler can also invoke `POST /api/internal/scanner/run`
  // with `SCANNER_WORKER_TOKEN`; both paths coordinate through the same
  // PostgreSQL advisory lock and `scanner_cursors` watermarks.
  let scannerTicker: ReturnType<typeof startScannerWorkerTicker> | null = null;
  if (config.scanner.enabled) {
    scannerTicker = startScannerWorkerTicker(ctx.scanner, {
      intervalMs: config.scanner.intervalMs,
      leaseMs: config.scanner.leaseMs,
      initialDelayMs: 10_000,
      logger: consoleScannerLogger('[scanner]'),
      // P1: scheduled ingestion warms the candle cache before each scan cycle.
      scheduledIngestion: config.scheduledIngestion.enabled
        ? ctx.scheduledIngestion
        : undefined,
    });
    console.info(
      `[api] live scanner enabled (every ${config.scanner.intervalMs}ms, lease ${config.scanner.leaseMs}ms)` +
        (config.scheduledIngestion.enabled
          ? ', scheduled ingestion warm enabled'
          : ', scheduled ingestion disabled (INGESTION_SCHEDULE_ENABLED=false)'),
    );
  } else {
    console.info(
      '[api] live scanner is disabled — enable with SCANNER_ENABLED=true, ' +
        'invoke via POST /api/internal/scanner/run (SCANNER_WORKER_TOKEN), ' +
        'or trigger via POST /api/scanner/trigger',
    );
  }

  // Billing FX source observations (read-only). Disabled by default: the
  // publisher's page has not been verified live from this environment, so
  // enabling the schedule is a deliberate operator decision taken after a probe
  // (`npm run billing:fx:source:probe`). Either path — this ticker or an
  // external scheduler calling the token-protected internal route — is safe
  // alongside the other, and both serialize through the pinned FX observation
  // advisory lock.
  let fxSourceTicker: ReturnType<typeof startFxSourceTicker> | null = null;
  if (config.fxSource.enabled) {
    fxSourceTicker = startFxSourceTicker(ctx.fxSource, {
      intervalMs: config.fxSource.intervalMs,
      initialDelayMs: 10_000,
      logger: consoleFxSourceLogger('[fx-source]'),
    });
    console.info(
      `[api] FX source observation check enabled (every ${config.fxSource.intervalMs}ms, ` +
        'read-only, never publishes a rate)',
    );
  } else {
    console.info(
      '[api] FX source observation check is disabled — enable with FX_SOURCE_CHECK_ENABLED=true, ' +
        'or invoke via POST /api/internal/billing/fx/source-check (FX_SOURCE_WORKER_TOKEN). ' +
        'Either way it only observes: publishing a billing FX rate stays a separate approved operation.',
    );
  }

  const shutdown = async (signal: string) => {
        console.info(`[api] ${signal} received, shutting down`);
    await fxSourceTicker?.stop().catch(() => {});
    await scannerTicker?.stop().catch(() => {});
    await workerTicker?.stop().catch(() => {});
    await ctx.scanner.waitForInFlight().catch(() => {});
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
