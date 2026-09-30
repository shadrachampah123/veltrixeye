import type {
  ScannerInternalMaintenanceResponse,
  ScannerInternalRunResponse,
} from '@veltrixeye/contracts';
import { sanitizeScannerError, type ScannerLogger } from '@veltrixeye/core';

/**
 * In-process invocation of the live scanner worker (M7.5 / F3).
 *
 * The API deploys as a container that a platform may stop or spin down at any
 * time, so background scanning cannot depend on an unguarded `setInterval`:
 *
 *   - `POST /api/internal/scanner/run` (token-protected) lets an external
 *     scheduler invoke a sleep-safe scan cycle even when the instance was
 *     asleep;
 *   - `startScannerWorkerTicker` runs the same `runWorkerOnce()` cycle inside
 *     the API process while it is awake;
 *   - both may run simultaneously because `ScannerService` serializes scans
 *     with PostgreSQL advisory lock `SCANNER_ADVISORY_LOCK_KEY` (875421009)
 *     and deduplicates closed candles via `scanner_cursors`.
 *
 * Production safety guarantees:
 *  - **overlap-guarded** — a tick that is still running never starts a second
 *    in-process scan;
 *  - **never throws** — a failed tick logs sanitized diagnostics (no secrets,
 *    no tenant UUIDs) and keeps the interval alive;
 *  - **unref'd** — timers never keep the Node process open on their own;
 *  - **graceful shutdown** — `stop()` clears pending timers and awaits both
 *    the active tick and any in-flight `ScannerService` execution before
 *    resolving so `pool.end()` never races an active scan.
 */

export interface ScannerWorkerTarget {
  runWorkerOnce(args?: {
    force?: boolean;
    leaseMs?: number;
    nowMs?: number;
  }): Promise<ScannerInternalRunResponse>;
  runMaintenance(args?: {
    leaseMs?: number;
  }): Promise<ScannerInternalMaintenanceResponse>;
  waitForInFlight?(): Promise<void>;
}

export interface ScannerWorkerTickerOptions {
  intervalMs: number;
  leaseMs?: number;
  /** Run maintenance every N ticks (default 6). */
  maintenanceEveryRuns?: number;
  /** Optional initial settle delay (ms) before the first tick when `runImmediately !== false`. */
  initialDelayMs?: number;
  /** Process one scan immediately (or after `initialDelayMs`) instead of waiting for the first interval. */
  runImmediately?: boolean;
  logger?: ScannerLogger;
  redact?: (text: string) => string;
}

export interface ScannerWorkerTicker {
  /** Stop scheduling new scans and wait for the in-flight scan to finish. */
  stop(): Promise<void>;
  readonly running: boolean;
}

const NOOP_LOGGER: ScannerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function startScannerWorkerTicker(
  scanner: ScannerWorkerTarget,
  options: ScannerWorkerTickerOptions,
): ScannerWorkerTicker {
  const logger = options.logger ?? NOOP_LOGGER;
  const intervalMs = Math.max(20, Math.trunc(options.intervalMs));
  const maintenanceEveryRuns = Math.max(1, Math.trunc(options.maintenanceEveryRuns ?? 6));

  let timer: NodeJS.Timeout | null = null;
  let initialTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let runs = 0;

  const runOnce = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return; // overlap guard: previous scan is still running
    inFlight = (async () => {
      try {
        runs += 1;
        if (runs % maintenanceEveryRuns === 0) {
          const maintenance = await scanner.runMaintenance(
            options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : undefined,
          );
          if (maintenance.recovered > 0 || maintenance.recentFailures > 0) {
            logger.info('scanner maintenance', {
              recovered: maintenance.recovered,
              activeRuns: maintenance.activeRuns,
              recentFailures: maintenance.recentFailures,
              status: maintenance.status,
              isProviderAvailable: maintenance.isProviderAvailable,
            });
          }
        }
        const result = await scanner.runWorkerOnce(
          options.leaseMs !== undefined ? { leaseMs: options.leaseMs } : undefined,
        );
        if (!result.skipped && result.run) {
          logger.info('scanner worker run', {
            runId: result.run.id,
            status: result.run.status,
            strategiesScanned: result.run.strategiesScanned,
            instrumentsScanned: result.run.instrumentsScanned,
            setupsDetected: result.run.setupsDetected,
            alertsCreated: result.run.alertsCreated,
            staleRejections: result.run.staleRejections,
            providerFailures: result.run.providerFailures,
            recovered: result.recovered,
          });
        } else if (result.recovered > 0) {
          logger.info('scanner worker recovery', {
            recovered: result.recovered,
            skipped: result.skipped,
            reason: result.reason ?? null,
          });
        }
      } catch (err) {
        logger.error('scanner worker tick failed', {
          error: sanitizeScannerError(err, options.redact),
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
  timer.unref?.();

  if (options.runImmediately !== false) {
    const delayMs = options.initialDelayMs !== undefined ? Math.max(0, Math.trunc(options.initialDelayMs)) : 0;
    if (delayMs > 0) {
      initialTimer = setTimeout(() => {
        initialTimer = null;
        void runOnce();
      }, delayMs);
      initialTimer.unref?.();
    } else {
      void runOnce();
    }
  }

  return {
    get running(): boolean {
      return !stopped && (timer !== null || initialTimer !== null);
    },
    async stop(): Promise<void> {
      stopped = true;
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => {});
      if (typeof scanner.waitForInFlight === 'function') {
        await scanner.waitForInFlight().catch(() => {});
      }
    },
  };
}

/** Structured logger that writes scanner worker lines to the API log. */
export function consoleScannerLogger(prefix = '[scanner]'): ScannerLogger {
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
