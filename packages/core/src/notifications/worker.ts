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
 *  3. one due job is claimed immediately before each attempt, so unstarted
 *     siblings remain pending and do not consume a lease;
 *  4. a unique owner token is renewed during provider I/O and required for
 *     acknowledgement, retry, unavailable and dead-letter transitions;
 *  5. each attempt is mapped to delivered / retry-scheduled / dead-lettered /
 *     unavailable and recorded only while that lease is still owned.
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
  /** Prefix for per-claim fencing tokens stored in `locked_by` (default: per-process uuid). */
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

    // 3. Claim only when ready to attempt the next job. A claimed-but-unstarted
    // row would otherwise consume lease time while earlier sequential sends run.
    // Each claim gets a unique fencing token, even within the same process.
    for (let i = 0; i < limit; i += 1) {
      const jobs = await this.outbox.claimBatch(1, this.instanceId);
      const job = jobs[0];
      if (!job) break;
      result.claimed += 1;
      const outcome = await this.deliver(job);
      if (outcome) result[outcome] += 1;
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

  /** Send one claimed job while renewing its fenced lease. */
  private async deliver(job: NotificationJobRow): Promise<'delivered' | 'retried' | 'failed' | 'unavailable' | undefined> {
    const ownerToken = job.locked_by ?? '';
    const channel = job.channel as NotificationChannel;
    const meta = {
      jobId: job.id,
      alertId: job.alert_id,
      userId: job.user_id,
      channel: job.channel,
      attempt: job.attempts,
      provider: null as string | null,
    };
    if (!ownerToken) {
      this.logger.error('notification job claim omitted its lease token', { ...meta });
      return undefined;
    }

    const unavailable = async (provider: string | null, error: string): Promise<'unavailable' | undefined> => {
      const updated = await this.outbox.markUnavailable(job.id, ownerToken, this.policy.leaseMs, {
        provider, failureCategory: 'configuration', error,
      }, channel);
      if (!updated) {
        this.logger.warn('notification lease lost before unavailable acknowledgement', { ...meta, provider });
        return undefined;
      }
      this.logger.warn('notification delivery unavailable', {
        ...meta, provider, status: 'unavailable', failureCategory: 'configuration',
      });
      return 'unavailable';
    };

    const provider = this.registry.get(channel);
    if (!provider) {
      return unavailable(null, `no notification provider is registered for channel "${job.channel}"`);
    }
    if (!provider.configured) {
      return unavailable(provider.name, `notification provider "${provider.name}" is not configured (missing credentials)`);
    }

    const lease = await this.startLeaseRenewal(job, ownerToken);
    try {
      if (lease.lost) return undefined;
      // M9.2: prefer encrypted secret, decrypt if needed
      let signingSecret: string | null = job.signing_secret;
      const enc = (job as { signing_secret_encrypted?: string | null }).signing_secret_encrypted;
      const keyVersion = (job as { signing_secret_key_version?: number | null }).signing_secret_key_version;
      if (enc && this.secretManager) {
        try {
          signingSecret = this.secretManager.decrypt(enc, keyVersion ?? this.secretManager.keyVersion);
        } catch {
          signingSecret = job.signing_secret;
        }
      }
      let result: NotificationSendResult;
      let error: unknown = null;
      try {
        result = await provider.send({
          jobId: job.id,
          idempotencyKey: job.idempotency_key,
          channel,
          recipient: job.recipient,
          template: job.template,
          payload: job.payload,
          attempt: job.attempts,
          timeoutMs: this.policy.timeoutMs,
          signingSecret,
        });
      } catch (err) {
        error = err;
        result = { outcome: 'retryable', failureCategory: 'unknown', error: describeError(err) };
      }
      // Stop/settle the heartbeat before the terminal transition so a racing
      // renewal cannot make a successfully committed acknowledgement look lost.
      await lease.stop();
      // A failed/uncertain renewal is fail-closed: never persist this provider
      // result under a lease that may have been reclaimed by another worker.
      if (lease.lost) return undefined;
      return await this.record(job, ownerToken, provider.name, result, error, lease);
    } finally {
      await lease.stop();
    }
  }

  private async startLeaseRenewal(job: NotificationJobRow, ownerToken: string): Promise<{
    readonly lost: boolean;
    stop(): Promise<void>;
  }> {
    const channel = job.channel as NotificationChannel;
    let lost = false;
    let inFlight: Promise<void> | null = null;
    const renew = async (): Promise<void> => {
      if (lost) return;
      try {
        const renewed = await this.outbox.renewLease(job.id, ownerToken, this.policy.leaseMs, channel);
        if (!renewed) {
          lost = true;
          this.logger.warn('notification lease renewal rejected; provider result will not be acknowledged', { jobId: job.id, channel });
        }
      } catch {
        // Do not expose database error text. A transient DB failure is treated
        // as lease loss because ownership can no longer be proven safely.
        lost = true;
        this.logger.error('notification lease renewal failed; provider result will not be acknowledged', { jobId: job.id, channel });
      }
    };

    // Confirm ownership immediately before I/O, then renew at one third of the
    // configured lease. The claim is per job, so no queued sibling consumes
    // this lease while the provider is active.
    await renew();
    const intervalMs = Math.max(1, Math.floor(Math.max(1, this.policy.leaseMs) / 3));
    const timer = lost ? null : setInterval(() => {
      if (inFlight) return;
      inFlight = renew().finally(() => { inFlight = null; });
    }, intervalMs);
    timer?.unref?.();
    return {
      get lost() { return lost; },
      async stop() {
        if (timer) clearInterval(timer);
        if (inFlight) await inFlight;
      },
    };
  }

  private async record(
    job: NotificationJobRow,
    ownerToken: string,
    providerName: string,
    result: NotificationSendResult,
    err: unknown,
    lease: { readonly lost: boolean },
  ): Promise<'delivered' | 'retried' | 'failed' | 'unavailable' | undefined> {
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
      const acknowledged = await this.outbox.markDelivered(job.id, ownerToken, this.policy.leaseMs, {
        provider: providerName,
        providerMessageId: result.providerMessageId ?? null,
        providerResponseCode: result.providerResponseCode ?? null,
        failureCategory: 'none',
      }, job.channel as NotificationChannel);
      if (!acknowledged || lease.lost) {
        this.logger.warn('notification lease lost before delivery acknowledgement', { ...meta });
        return undefined;
      }
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
      const acknowledged = await this.outbox.markUnavailable(job.id, ownerToken, this.policy.leaseMs, attempt, job.channel as NotificationChannel);
      if (!acknowledged || lease.lost) {
        this.logger.warn('notification lease lost before unavailable acknowledgement', { ...meta });
        return undefined;
      }
      this.logger.warn('notification delivery unavailable', { ...meta, status: 'unavailable', failureCategory: category });
      return 'unavailable';
    }

    if (result.outcome === 'permanent') {
      const acknowledged = await this.outbox.markFailed(job.id, ownerToken, this.policy.leaseMs, attempt, job.channel as NotificationChannel);
      if (!acknowledged || lease.lost) {
        this.logger.warn('notification lease lost before failure acknowledgement', { ...meta });
        return undefined;
      }
      this.logger.warn('notification delivery failed permanently', { ...meta, status: 'failed', failureCategory: category });
      return 'failed';
    }

    // retryable | timeout | (unexpected) → schedule the next attempt, or
    // dead-letter when the budget is exhausted.
    const delayMs = backoffDelayMs({
      attempts: job.attempts,
      policy: this.policy,
      idempotencyKey: job.idempotency_key,
    });
    const outcome = await this.outbox.markRetry(job.id, ownerToken, this.policy.leaseMs, delayMs, attempt, job.channel as NotificationChannel);
    if (outcome === 'leaseLost' || lease.lost) {
      this.logger.warn('notification lease lost before retry acknowledgement', { ...meta });
      return undefined;
    }
    this.logger.warn(outcome === 'retried' ? 'notification attempt failed' : 'notification retries exhausted', {
      ...meta,
      status: outcome === 'retried' ? 'pending' : 'failed',
      failureCategory: category,
      // attempt.error has passed through the deployment redactor above.
      error: attempt.error,
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
