/**
 * Notification-outbox heartbeat (M7.3 delivery worker).
 *
 * WHY THIS EXISTS. The delivery worker drains the `notification_deliveries`
 * outbox two ways: an in-process ticker every `NOTIFICATION_WORKER_INTERVAL_MS`
 * while the instance is awake, and the token-protected
 * `POST /api/internal/notifications/deliveries/run` endpoint an external
 * scheduler can call. Only the second one survives a platform spin-down.
 *
 * The production deployment is a scale-to-zero container, so a scheduler is the
 * only thing that guarantees delivery across sleep. But an external scheduler
 * holds ONE shared secret: the scanner heartbeat endpoint and the notification
 * endpoint both read the `x-veltrixeye-worker-token` header yet compare it
 * against DIFFERENT configured values (`SCANNER_WORKER_TOKEN` and
 * `NOTIFICATION_WORKER_TOKEN`, see `routes/scanner.ts` and
 * `routes/notifications.ts`). A scheduler configured with only the scanner
 * secret therefore reaches the API and is refused by the notification route
 * with 401 — the instance is woken, the scan runs, and the outbox is left to
 * the in-process ticker, which stops the moment the instance sleeps again.
 *
 * This module closes that hole in the place the scheduler already reaches:
 * the scanner heartbeat performs one bounded, best-effort delivery batch using
 * THIS process's own worker, so notification delivery is exercised on the same
 * five-minute schedule as scanning without a second cron job, a second secret,
 * or any change to the deployed scheduler.
 *
 * SAFETY
 *  - Never throws: a delivery failure must never turn a successful scan into a
 *    failed heartbeat (the scanner response is scoped to scanning).
 *  - Bounded: a small batch and a hard timeout, so a slow or unreachable
 *    provider cannot delay the scan or hold the scheduler's request open.
 *  - Safe alongside the ticker: `runOnce` claims jobs with
 *    `FOR UPDATE SKIP LOCKED`, so concurrent invocations process disjoint sets
 *    and can never deliver the same job twice.
 *  - Idempotent under retry: an abandoned batch leaves its jobs claimed/
 *    recoverable by the worker's own stale-recovery path, not duplicated.
 *  - No secret, no tenant identifier and no provider text is logged or
 *    returned — counts and a machine code only.
 */

import { failureCode, recordWorkerFailure, recordWorkerStart, recordWorkerSuccess } from './worker-liveness.js';

/** The counts `DeliveryWorker.runOnce()` reports (structural subset). */
export interface NotificationBatchSummary {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  unavailable: number;
  recovered: number;
  deadLettered: number;
  requeued: number;
}

/** Minimal structural target: keeps this module testable without a pool. */
export interface NotificationHeartbeatTarget {
  runOnce(batchSize?: number): Promise<NotificationBatchSummary>;
}

export interface NotificationHeartbeatLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface NotificationDrainOptions {
  worker: NotificationHeartbeatTarget;
  /** Requested batch size; clamped to `HEARTBEAT_MAX_BATCH`. */
  batchSize?: number;
  /** Hard bound on how long the heartbeat waits (default 10s). */
  timeoutMs?: number;
  logger?: NotificationHeartbeatLogger;
}

export type NotificationDrainOutcome =
  | { ok: true; summary: NotificationBatchSummary }
  | { ok: false; code: string; timedOut: boolean };

/**
 * The heartbeat is a safety net, not the throughput path: while the instance is
 * awake the ticker drains `NOTIFICATION_WORKER_BATCH_SIZE` (25 by default) every
 * minute. A small batch keeps the five-minute heartbeat cheap — it usually finds
 * nothing due — and keeps a slow provider from eating the scanner's own budget.
 */
export const HEARTBEAT_MAX_BATCH = 5;

/** Hard bound so a stuck provider cannot hold the scheduler's request open. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** Raised when the heartbeat stops waiting for a batch that is still running. */
export class NotificationHeartbeatTimeout extends Error {
  constructor() {
    super('notification heartbeat timed out');
    this.name = 'NotificationHeartbeatTimeout';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new NotificationHeartbeatTimeout()), timeoutMs);
    // Never keep the process alive on this timer alone.
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run one bounded delivery batch and record the outcome for `GET /api/health`.
 * Always resolves — the caller must never fail a scan because delivery failed.
 */
export async function drainNotificationOutbox(
  options: NotificationDrainOptions,
): Promise<NotificationDrainOutcome> {
  const requested = Math.trunc(options.batchSize ?? HEARTBEAT_MAX_BATCH);
  const batchSize = Math.max(1, Math.min(Number.isFinite(requested) ? requested : HEARTBEAT_MAX_BATCH, HEARTBEAT_MAX_BATCH));
  const timeoutMs = Math.max(0, Math.trunc(options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS));

  recordWorkerStart('notifications');
  try {
    const batch = options.worker.runOnce(batchSize);
    // If the timeout wins the race the batch keeps running in the background;
    // swallow its eventual rejection so it cannot become an unhandled one.
    batch.catch(() => {});
    const summary = timeoutMs > 0 ? await withTimeout(batch, timeoutMs) : await batch;
    recordWorkerSuccess('notifications');
    if (
      summary.claimed > 0 ||
      summary.delivered > 0 ||
      summary.failed > 0 ||
      summary.unavailable > 0 ||
      summary.recovered > 0
    ) {
      options.logger?.info('notification heartbeat batch', { ...summary });
    }
    return { ok: true, summary };
  } catch (err) {
    const code = failureCode(err);
    recordWorkerFailure('notifications', err);
    options.logger?.warn('notification heartbeat batch failed', {
      code,
      timedOut: err instanceof NotificationHeartbeatTimeout,
    });
    return { ok: false, code, timedOut: err instanceof NotificationHeartbeatTimeout };
  }
}
