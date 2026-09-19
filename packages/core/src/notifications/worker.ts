import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  DEFAULT_NOTIFICATION_BATCH_SIZE,
  DEFAULT_NOTIFICATION_BASE_BACKOFF_MS,
  DEFAULT_NOTIFICATION_JITTER_MS,
  DEFAULT_NOTIFICATION_LEASE_MS,
  DEFAULT_NOTIFICATION_MAX_ATTEMPTS,
  DEFAULT_NOTIFICATION_MAX_BACKOFF_MS,
  DEFAULT_NOTIFICATION_TIMEOUT_MS,
  MAX_NOTIFICATION_BATCH_SIZE,
  type NotificationChannel,
  type NotificationFailureCategory,
} from '@veltrixeye/contracts';
import { NotificationOutbox, type CleanupPolicy, type NotificationJobRow } from './outbox.js';
import { describeError } from './redact.js';
import type { NotificationProviderRegistry, NotificationSendResult } from './provider.js';
import type { SecretManager } from './secret-manager.js';

/**
 * The delivery worker (M7.3) — the ONLY component that performs delivery I/O.
 *
 * It is deliberately a plain, stateless class with a `runOnce()` method rather
 * than a daemon: this API deploys as a container that a platform may stop at
 * any time (the Render free tier spins down), so the worker must be safe to
 * invoke from *anywhere* and to stop at *any* moment:
 *
 *   - in-process ticker   — `startDeliveryWorkerTicker` in apps/api (a fixed
 *                           interval, one batch at a time, overlap-guarded);
 *   - scheduled HTTP call — `POST /api/internal/notifications/deliveries/run`
 *                           with a shared-secret token, for an external cron
 *                           (Render Cron Job, uptime scheduler, CI);
 *   - manually            — `runOnce()` from a script or a test.
 *
 * Every invocation is idempotent and concurrency-safe:
 *  1. stale `processing` rows are recovered (or dead-lettered if their retry
 *     budget is gone) — this is the crash-recovery path;
 *  2. `unavailable` rows whose channel now has a configured provider are
 *     re-queued (bounded);
 *  3. due jobs are claimed with `FOR UPDATE SKIP LOCKED`, so two workers —
 *     even in the same process — get disjoint sets and never deliver twice;
 *  4. each attempt is mapped to delivered / retry-scheduled / dead-lettered /
 *     unavailable and recorded on the row.
 *
 * Nothing here reads a credential, and nothing here logs one: log lines carry
 * ids, channel, attempt, status, provider and failure category only.
 */

export interface DeliveryRetryPolicy {
  /** Max send attempts per job (1–10, schema-bounded). */
  maxAttempts: number;
  /** Backoff base: attempt n waits `base * 2^(n-1)` ms, capped at `max`. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Deterministic per-job jitter (0 disables) — spreads a retry thundering herd. */
  jitterMs: number;
  /** How long a claimed job may stay `processing` before it is recovered. */
  leaseMs: number;
  /** Jobs claimed per `runOnce` call. */
  batchSize: number;
  /** Per-attempt provider budget. */
  timeoutMs: number;
}

export const DEFAULT_DELIVERY_RETRY_POLICY: DeliveryRetryPolicy = {
  maxAttempts: DEFAULT_NOTIFICATION_MAX_ATTEMPTS,
  baseBackoffMs: DEFAULT_NOTIFICATION_BASE_BACKOFF_MS,
  maxBackoffMs: DEFAULT_NOTIFICATION_MAX_BACKOFF_MS,
  jitterMs: DEFAULT_NOTIFICATION_JITTER_MS,
  leaseMs: DEFAULT_NOTIFICATION_LEASE_MS,
  batchSize: DEFAULT_NOTIFICATION_BATCH_SIZE,
  timeoutMs: DEFAULT_NOTIFICATION_TIMEOUT_MS,
};

export interface WorkerRunResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  unavailable: number;
  recovered: number;
  deadLettered: number;
  requeued: number;
}

export interface WorkerMaintenanceResult {
  recovered: number;
  deadLettered: number;
  requeued: number;
  deleted: number;
}

export interface DeliveryWorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface DeliveryWorkerOptions {
  /** Identifies this worker in `locked_by` (default: a per-process uuid). */
  instanceId?: string;
  logger?: DeliveryWorkerLogger;
  retention?: CleanupPolicy;
  /**
   * Defence in depth for stored error text. Adapters already redact their own
   * secrets (only they know them); this lets the deployment hand the worker a
   * scrubber for the credentials it configured, so a leaky provider message
   * still cannot reach `last_error` or a log line.
   */
  redact?: (text: string) => string;
  /** M9.2 secret manager for decrypting webhook/push secrets at delivery time */
  secretManager?: SecretManager;
}

/** A no-op logger: the worker never throws because of logging. */
const SILENT_LOGGER: DeliveryWorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class DeliveryWorker {
  private readonly outbox: NotificationOutbox;
  private readonly instanceId: string;
  private readonly logger: DeliveryWorkerLogger;
  private readonly secretManager?: SecretManager;

  constructor(
    pool: pg.Pool,
    private readonly registry: NotificationProviderRegistry,
    private readonly policy: DeliveryRetryPolicy = DEFAULT_DELIVERY_RETRY_POLICY,
    options: DeliveryWorkerOptions = {},
  ) {
    this.secretManager = options.secretManager;
    this.outbox = new NotificationOutbox(pool, { maxAttempts: policy.maxAttempts }, this.secretManager);
    this.instanceId = options.instanceId ?? `worker-${randomUUID()}`;
    this.logger = options.logger ?? SILENT_LOGGER;
    this.redact = options.redact ?? ((text: string) => text);
    this.retention = options.retention ?? { deliveredRetentionDays: 30, failedRetentionDays: 120 };
  }

  private readonly retention: CleanupPolicy;
  private readonly redact: (text: string) => string;

  /** The outbox this worker claims from (exposed for tests/operators). */
  get jobs(): NotificationOutbox {
    return this.outbox;
  }

  /**
   * Process one bounded batch. Safe to call concurrently, repeatedly, and
   * from more than one process. Never throws for a per-job failure: a bad
   * provider result is recorded on the row, not propagated.
   */
  async runOnce(batchSize?: number): Promise<WorkerRunResult> {
    const limit = clampInt(batchSize ?? this.policy.batchSize, 1, MAX_NOTIFICATION_BATCH_SIZE);
    const result: WorkerRunResult = {
      claimed: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
      unavailable: 0,
      recovered: 0,
      deadLettered: 0,
      requeued: 0,
    };

    // 1. crash recovery: what a previous run claimed but never finished.
    const stale = await this.outbox.recoverStale(this.policy.leaseMs);
    result.recovered = stale.recovered;
    result.deadLettered = stale.deadLettered;
    if (stale.recovered > 0 || stale.deadLettered > 0) {
      this.logger.warn('recovered stale notification jobs', {
        recovered: stale.recovered,
        deadLettered: stale.deadLettered,
        leaseMs: this.policy.leaseMs,
      });
    }

    // 2. configuration appeared: give blocked jobs a bounded second chance.
    const configured = this.registry.configuredChannels();
    if (configured.length > 0) {
      result.requeued = await this.outbox.requeueUnavailable(configured, limit);
      if (result.requeued > 0) {
        this.logger.info('requeued notification jobs after a provider became available', {
          requeued: result.requeued,
          channels: configured,
        });
      }
    }

    // 3. claim + deliver.
    const jobs = await this.outbox.claimBatch(limit, this.instanceId);
    result.claimed = jobs.length;

    for (const job of jobs) {
      const outcome = await this.deliver(job);
      result[outcome] += 1;
    }

    return result;
  }

  /**
   * Maintenance: recover stale work, re-queue what is now deliverable, apply
   * retention and report the queue depth. Called by the internal maintenance
   * endpoint (token-protected) and by the in-process ticker on a slower beat.
   */
  async runMaintenance(args?: {
    deliveredRetentionDays?: number;
    failedRetentionDays?: number;
  }): Promise<WorkerMaintenanceResult & { depth: Awaited<ReturnType<NotificationOutbox['depth']>> }> {
    const stale = await this.outbox.recoverStale(this.policy.leaseMs);
    const configured = this.registry.configuredChannels();
    const requeued =
      configured.length > 0
        ? await this.outbox.requeueUnavailable(configured, MAX_NOTIFICATION_BATCH_SIZE)
        : 0;
    const deleted = await this.outbox.cleanup({
      deliveredRetentionDays: args?.deliveredRetentionDays ?? this.retention.deliveredRetentionDays,
      failedRetentionDays: args?.failedRetentionDays ?? this.retention.failedRetentionDays,
    });
    const depth = await this.outbox.depth();
    if (stale.recovered > 0 || stale.deadLettered > 0 || deleted > 0) {
      this.logger.info('notification maintenance', {
        recovered: stale.recovered,
        deadLettered: stale.deadLettered,
        requeued,
        deleted,
      });
    }
    return { ...stale, requeued, deleted, depth };
  }

  /** Recover stale work only (cheap: two bounded UPDATEs, no provider I/O). */
  async recoverStale(): Promise<{ recovered: number; deadLettered: number }> {
    return this.outbox.recoverStale(this.policy.leaseMs);
  }

  /* ---------------------------------------------------------------------- */

  /** Send one claimed job and record the outcome. Returns the result bucket. */
  private async deliver(job: NotificationJobRow): Promise<'delivered' | 'retried' | 'failed' | 'unavailable'> {
    const meta = {
      jobId: job.id,
      alertId: job.alert_id,
      userId: job.user_id,
      channel: job.channel,
      attempt: job.attempts,
      provider: null as string | null,
    };

    const provider = this.registry.get(job.channel as NotificationChannel);

    if (!provider) {
      const error = `no notification provider is registered for channel "${job.channel}"`;
      await this.outbox.markUnavailable(job.id, { failureCategory: 'configuration', error }, job.channel as NotificationChannel);
      this.logger.warn('notification delivery unavailable', {
        ...meta,
        status: 'unavailable',
        failureCategory: 'configuration',
      });
      return 'unavailable';
    }

    if (!provider.configured) {
      const error = `notification provider "${provider.name}" is not configured (missing credentials)`;
      await this.outbox.markUnavailable(job.id, {
        provider: provider.name,
        failureCategory: 'configuration',
        error,
      }, job.channel as NotificationChannel);
      this.logger.warn('notification delivery unavailable', {
        ...meta,
        provider: provider.name,
        status: 'unavailable',
        failureCategory: 'configuration',
      });
      return 'unavailable';
    }

    try {
      // M9.2: prefer encrypted secret, decrypt if needed
      let signingSecret: string | null = job.signing_secret;
      const enc = (job as { signing_secret_encrypted?: string | null }).signing_secret_encrypted;
      const keyVersion = (job as { signing_secret_key_version?: number | null }).signing_secret_key_version;
      if (enc && this.secretManager) {
        try {
          signingSecret = this.secretManager.decrypt(enc, keyVersion ?? this.secretManager.keyVersion);
        } catch {
          // fallback to plaintext if decryption fails (migration path)
          signingSecret = job.signing_secret;
        }
      }
      const result = await provider.send({
        jobId: job.id,
        idempotencyKey: job.idempotency_key,
        channel: job.channel as NotificationChannel,
        recipient: job.recipient,
        template: job.template,
        payload: job.payload,
        attempt: job.attempts,
        timeoutMs: this.policy.timeoutMs,
        signingSecret,
      });
      return await this.record(job, provider.name, result, null);
    } catch (err) {
      // An unexpected exception is treated as transient: the retry budget still
      // bounds it, and the row keeps the redacted reason.
      const result: NotificationSendResult = {
        outcome: 'retryable',
        failureCategory: 'unknown',
        error: describeError(err),
      };
      return await this.record(job, provider.name, result, err);
    }
  }

  private async record(
    job: NotificationJobRow,
    providerName: string,
    result: NotificationSendResult,
    err: unknown,
  ): Promise<'delivered' | 'retried' | 'failed' | 'unavailable'> {
    const meta = {
      jobId: job.id,
      alertId: job.alert_id,
      userId: job.user_id,
      channel: job.channel,
      attempt: job.attempts,
      provider: providerName,
      providerResponseCode: result.providerResponseCode ?? null,
    };

    if (result.outcome === 'delivered') {
      await this.outbox.markDelivered(job.id, {
        provider: providerName,
        providerMessageId: result.providerMessageId ?? null,
        providerResponseCode: result.providerResponseCode ?? null,
        failureCategory: 'none',
      }, job.channel as NotificationChannel);
      this.logger.info('notification delivered', { ...meta, status: 'delivered' });
      return 'delivered';
    }

    const category = result.failureCategory ?? categoryForOutcome(result.outcome);
    const attempt = {
      provider: providerName,
      providerResponseCode: result.providerResponseCode ?? null,
      failureCategory: category,
      error: this.redact(result.error ?? (err ? describeError(err) : `${result.outcome} delivery attempt`)),
    };

    if (result.outcome === 'unavailable') {
      await this.outbox.markUnavailable(job.id, attempt, job.channel as NotificationChannel);
      this.logger.warn('notification delivery unavailable', {
        ...meta,
        status: 'unavailable',
        failureCategory: category,
      });
      return 'unavailable';
    }

    if (result.outcome === 'permanent') {
      await this.outbox.markFailed(job.id, attempt, job.channel as NotificationChannel);
      this.logger.warn('notification delivery failed permanently', {
        ...meta,
        status: 'failed',
        failureCategory: category,
      });
      return 'failed';
    }

    // retryable | timeout | (unexpected) → schedule the next attempt, or
    // dead-letter when the budget is exhausted.
    const delayMs = backoffDelayMs({
      attempts: job.attempts,
      policy: this.policy,
      idempotencyKey: job.idempotency_key,
    });
    const outcome = await this.outbox.markRetry(job.id, delayMs, attempt, job.channel as NotificationChannel);
    this.logger.warn(outcome === 'retried' ? 'notification attempt failed' : 'notification retries exhausted', {
      ...meta,
      status: outcome === 'retried' ? 'pending' : 'failed',
      failureCategory: category,
      retryDelayMs: outcome === 'retried' ? delayMs : 0,
    });
    return outcome;
  }
}

/**
 * Exponential backoff with a deterministic per-job jitter.
 *
 * `attempts` is the number of attempts already made (1 after the first claim),
 * so the first retry waits `base`, the second `2*base`, the third `4*base` …
 * capped at `maxBackoffMs`. The jitter is derived from the job's idempotency
 * key instead of a random number: retries of a burst of jobs are spread out,
 * but the delay for a given job/attempt is reproducible (testable) and stable
 * across worker restarts.
 */
export function backoffDelayMs(args: {
  attempts: number;
  policy: DeliveryRetryPolicy;
  idempotencyKey: string;
}): number {
  const attempt = Math.max(1, Math.trunc(args.attempts));
  const exponential = Math.min(
    args.policy.baseBackoffMs * 2 ** (attempt - 1),
    Math.max(args.policy.baseBackoffMs, args.policy.maxBackoffMs),
  );
  const jitter = args.policy.jitterMs > 0 ? hashMod(args.idempotencyKey, args.policy.jitterMs) : 0;
  return Math.max(0, Math.trunc(exponential + jitter));
}

/** Stable 32-bit hash of a string, mapped into `[0, mod)`. */
function hashMod(value: string, mod: number): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash) % Math.max(1, mod);
}

function categoryForOutcome(outcome: NotificationSendResult['outcome']): NotificationFailureCategory {
  switch (outcome) {
    case 'timeout':
      return 'timeout';
    case 'permanent':
      return 'permanent';
    case 'unavailable':
      return 'configuration';
    default:
      return 'transient';
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
