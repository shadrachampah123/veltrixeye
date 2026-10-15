import { createBankOfGhanaUsdGhsSource } from '@veltrixeye/provider-bank-of-ghana';
import {
  FxSourceObservationService,
  type FxSourceCheckResult,
} from '@veltrixeye/core';
import type pg from 'pg';
import {
  recordWorkerFailure,
  recordWorkerStart,
  recordWorkerSuccess,
} from './worker-liveness.js';

/**
 * The billing FX **source observation** runner — the sleep-safe scheduled half
 * of the read-only observation feature.
 *
 * WHAT IT IS. One bounded check: read the approved publisher's page once
 * (through the provider package, which owns the transport), validate and record
 * what was published, and report staleness. It runs from two places, exactly
 * like the other scheduled workers on this platform:
 *
 *  * an in-process interval ticker while the instance is awake
 *    (`FX_SOURCE_CHECK_ENABLED`), and
 *  * a token-protected internal endpoint an external scheduler can call after a
 *    spin-down (`FX_SOURCE_WORKER_TOKEN`).
 *
 * Both paths coordinate through ONE PostgreSQL advisory lock
 * (`FX_SOURCE_ADVISORY_LOCK_KEY`), so an instance that wakes up mid-schedule can
 * never fetch or write twice.
 *
 * WHY BOTH. The production API is a container a platform may stop at any time
 * (Render's free tier spins down after ~15 minutes idle). A ticker alone
 * silently stops when the instance sleeps; a scheduler alone depends on an
 * external job an operator must create. Together, either one keeps the
 * observation history moving, and `GET /api/health` reports whether either has
 * actually run — without a credential.
 *
 * WHAT IT NEVER DOES. It never publishes an FX rate version, never approves a
 * source, never prices a payment and never touches the catalogue, a Paystack
 * plan or a pricing epoch. The service it drives holds no rate-version store and
 * exposes no publish option; every result carries `decision: 'need_source'`,
 * `published: false` and `approved: false`, and `GET /api/health` never claims a
 * live source has been verified.
 *
 * Logging carries counts, dates and machine states only: never the page body,
 * never a rate as an "approved" value, never a token.
 */

export interface FxSourceLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A logger writing short, secret-free lines to the API console. */
export function consoleFxSourceLogger(prefix: string): FxSourceLogger {
  const emit = (
    level: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    const line = `${prefix} ${message}`;
    const detail = meta && Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
    // Explicit calls (no dynamic member access): the allowed console methods are
    // fixed, and a log line must never be able to reach an arbitrary method.
    if (level === 'info') {
      if (detail === null) console.info(line);
      else console.info(line, detail);
    } else if (level === 'warn') {
      if (detail === null) console.warn(line);
      else console.warn(line, detail);
    } else if (detail === null) {
      console.error(line);
    } else {
      console.error(line, detail);
    }
  };
  return {
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}

/** A bounded logger for the core service (short strings only). */
function serviceLogger(logger: FxSourceLogger) {
  return {
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
  };
}

export interface FxSourceRunnerOptions {
  timeoutMs: number;
  /** Injected transport (tests inject a stub; production uses global fetch). */
  fetchFn?: Parameters<typeof createBankOfGhanaUsdGhsSource>[0]['fetchFn'];
  /** Injected clock (deterministic tests). */
  clock?: () => Date;
  logger: FxSourceLogger;
}

/**
 * Build the observation service: the pinned, read-only provider reader wired to
 * the core observation service over the API's connection pool.
 */
export function createFxSourceObservationService(
  pool: pg.Pool,
  options: FxSourceRunnerOptions,
): FxSourceObservationService {
  const source = createBankOfGhanaUsdGhsSource({
    timeoutMs: options.timeoutMs,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });

  return new FxSourceObservationService(pool, source, {
    ...(options.clock ? { clock: options.clock } : {}),
    logger: serviceLogger(options.logger),
  });
}

/** One check, with worker liveness recorded (this process's proof it ran). */
export async function runFxSourceCheckOnce(
  service: FxSourceObservationService,
  options: { logger: FxSourceLogger; retrievedBy?: string },
): Promise<{ ok: boolean; result: FxSourceCheckResult | null; error?: unknown }> {
  recordWorkerStart('fxSource');
  try {
    const result = await service.runCheck({
      retrievedBy: options.retrievedBy ?? 'scheduler',
    });
    recordWorkerSuccess('fxSource');

    // A retrieval that failed is a recorded OUTCOME, not a crash: the check ran,
    // so liveness is a success, and the outcome is what an operator reads. An
    // overlap skip is likewise a completed check that did no work.
    options.logger.info('fx source check complete', {
      overlapSkipped: result.overlapSkipped,
      retrieval: result.retrieval.outcome,
      record: result.record.status,
      staleness: result.report.state,
      publishedDate: result.report.latest?.publishedOn ?? null,
      decision: result.decision,
    });
    return { ok: true, result };
  } catch (error) {
    recordWorkerFailure('fxSource', error);
    options.logger.error('fx source check failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return { ok: false, result: null, error };
  }
}

export interface FxSourceTickerHandle {
  stop(): Promise<void>;
}

/**
 * Start the in-process observation ticker. Runs one check immediately (so a
 * freshly deployed instance records within seconds) and then on the interval.
 *
 * The ticker is deliberately unref'd-safe and single-flight: a check that is
 * still running when the next tick arrives is skipped (`inFlight`), rather than
 * queued, and the core service's advisory lock protects against a second
 * instance doing the same work.
 */
export function startFxSourceTicker(
  service: FxSourceObservationService,
  options: {
    intervalMs: number;
    logger: FxSourceLogger;
    initialDelayMs?: number;
    retrievedBy?: string;
  },
): FxSourceTickerHandle {
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped || running) {
      if (running) options.logger.info('fx source tick skipped: a check is already in flight');
      return;
    }
    running = true;
    try {
      await runFxSourceCheckOnce(service, {
        logger: options.logger,
        retrievedBy: options.retrievedBy ?? 'ticker',
      });
    } finally {
      running = false;
    }
  };

  const initialDelay = options.initialDelayMs ?? 5_000;
  const firstTimer = setTimeout(() => void tick(), initialDelay);
  timer = setInterval(() => void tick(), options.intervalMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(firstTimer);
      if (timer !== null) clearInterval(timer);
    },
  };
}
