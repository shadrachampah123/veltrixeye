import type { DeliveryWorker, DeliveryWorkerLogger } from '@veltrixeye/core';

/**
 * In-process invocation of the M7.3 delivery worker.
 *
 * The API is a long-lived container, so a fixed-interval ticker is the
 * simplest correct way to drain the outbox. It is explicitly *not* the only
 * way: `POST /api/internal/notifications/deliveries/run` (token-protected)
 * lets an external scheduler do the same thing, and both may run at once —
 * `claimBatch` uses `FOR UPDATE SKIP LOCKED`, so concurrent invocations
 * process disjoint sets of jobs and can never deliver the same one twice.
 *
 * Properties that make this safe in production:
 *  - **overlap-guarded** — a tick that is still running (slow SMTP server)
 *    never starts a second batch; the next tick simply finds fewer due jobs;
 *  - **never throws** — a failed batch is logged and the timer keeps going, so
 *    one provider outage cannot kill the background loop;
 *  - **unref'd** — the interval never keeps the process alive by itself, so
 *    shutdown and `SIGTERM` handling are unaffected;
 *  - **bounded** — one batch per tick, `batchSize` jobs per batch, and a
 *    slower maintenance cadence (stale recovery + retention).
 */
export interface DeliveryWorkerTickerOptions {
  intervalMs: number;
  batchSize: number;
  /** Run maintenance (stale recovery + retention) every N batches. */
  maintenanceEveryRuns?: number;
  /** Process one batch immediately instead of waiting for the first interval. */
  runImmediately?: boolean;
  logger?: DeliveryWorkerLogger;
}

export interface DeliveryWorkerTicker {
  /** Stop scheduling new batches and wait for the in-flight one to finish. */
  stop(): Promise<void>;
  readonly running: boolean;
}

const NOOP_LOGGER: DeliveryWorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function startDeliveryWorkerTicker(
  worker: DeliveryWorker,
  options: DeliveryWorkerTickerOptions,
): DeliveryWorkerTicker {
  const logger = options.logger ?? NOOP_LOGGER;
  const intervalMs = Math.max(1_000, Math.trunc(options.intervalMs));
  const maintenanceEveryRuns = Math.max(1, Math.trunc(options.maintenanceEveryRuns ?? 10));

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let runs = 0;

  const runOnce = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return; // overlap guard: the previous batch is still running
    inFlight = (async () => {
      try {
        runs += 1;
        if (runs % maintenanceEveryRuns === 0) {
          const maintenance = await worker.runMaintenance();
          if (maintenance.recovered > 0 || maintenance.deadLettered > 0 || maintenance.deleted > 0) {
            logger.info('notification maintenance', {
              recovered: maintenance.recovered,
              deadLettered: maintenance.deadLettered,
              requeued: maintenance.requeued,
              deleted: maintenance.deleted,
            });
          }
        }
        const result = await worker.runOnce(options.batchSize);
        if (result.claimed > 0 || result.recovered > 0 || result.failed > 0 || result.unavailable > 0) {
          logger.info('notification worker batch', { ...result });
        }
      } catch (err) {
        // A batch failure must never kill the timer (or the process).
        logger.error('notification worker batch failed', {
          error: err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error',
        });
      }
    })().finally(() => {
      inFlight = null;
    });
    await inFlight;
  };

  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  // Do not hold the process open on shutdown: the HTTP server keeps it alive.
  timer.unref?.();

  if (options.runImmediately !== false) void runOnce();

  return {
    get running(): boolean {
      return timer !== null;
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => {});
    },
  };
}

/** Structured logger that writes the worker's own lines to the API log. */
export function consoleDeliveryLogger(prefix = '[notifications]'): DeliveryWorkerLogger {
  const write = (level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => {
    const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
    if (level === 'info') console.info(prefix, line);
    else if (level === 'warn') console.warn(prefix, line);
    else console.error(prefix, line);
  };
  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}
