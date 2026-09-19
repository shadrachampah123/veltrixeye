import type pg from 'pg';
import {
  MAX_NOTIFICATIONS_PER_ALERT,
  NOTIFICATION_STATUSES,
  type AlertNotificationPayload,
  type NotificationChannel,
  type NotificationDto,
  type NotificationFailureCategory,
  type NotificationStatus,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { SecretManager } from './secret-manager.js';
import { looksEncrypted } from './secret-manager.js';

/**
 * The durable outbox (M7.3) — the ONLY writer/reader of
 * `notification_deliveries`.
 *
 * Why an outbox instead of "send it in the request":
 *
 *  - the alert transaction never performs external I/O, so a provider outage
 *    (or a slow SMTP server) can never fail or hang alert generation;
 *  - the job survives a crash, a deploy and a restart: it is a row with a
 *    status, an attempt counter and a next-attempt time;
 *  - delivery is idempotent by construction: at most one row per
 *    (alert, channel), claimed with `FOR UPDATE SKIP LOCKED`, so two workers
 *    (or the same worker restarted) can never deliver the same job twice.
 *
 * Concurrency contract:
 *  - `claimBatch` moves `pending → processing` in a single UPDATE … FROM
 *    (SELECT … FOR UPDATE SKIP LOCKED), which is atomic: the rows it returns
 *    are locked by THIS transaction and invisible to every other worker.
 *  - every state transition below is a single conditional UPDATE whose
 *    `WHERE` carries the expected status, so a stale worker cannot overwrite
 *    a newer state (it simply updates zero rows).
 *  - cross-queue fairness is durable state in `notification_delivery_fairness`
 *    (M9.1 remediation, extended to 3-way in M9.2): every claim decision reads
 *    and writes it under the shared transaction-level advisory lock 611_231_008,
 *    so it is atomic with the claim and survives cleanup, retries, stale
 *    recovery, restarts and outbox reconstruction — unlike the score it replaces,
 *    it is not derived from retention-managed delivery rows.
 */

/** Anything with a `query` method: a `Pool` or a transaction `PoolClient`. */
export type Queryable = Pick<pg.Pool, 'query'>;
const EMAIL_DELIVERY_TABLE = 'notification_deliveries';
const WEBHOOK_DELIVERY_TABLE = 'notification_webhook_deliveries';
const PUSH_DELIVERY_TABLE = 'notification_push_deliveries';
/** Shared PostgreSQL advisory lock for the durable cross-instance fairness decision. */
const NOTIFICATION_FAIRNESS_LOCK_KEY = 611_231_008;
function tableForChannel(channel: NotificationChannel): string {
  if (channel === 'webhook') return WEBHOOK_DELIVERY_TABLE;
  if (channel === 'push') return PUSH_DELIVERY_TABLE;
  return EMAIL_DELIVERY_TABLE;
}

export interface NotificationJobRow {
  id: string;
  alert_id: string;
  user_id: string;
  channel: string;
  template: string;
  idempotency_key: string;
  payload_hash: string;
  payload: AlertNotificationPayload;
  recipient: string;
  signing_secret: string | null;
  signing_secret_encrypted?: string | null;
  signing_secret_key_version?: number | null;
  status: string;
  attempts: number;
  max_attempts: number;
  provider: string | null;
  provider_message_id: string | null;
  provider_response_code: string | null;
  failure_category: string;
  last_error: string | null;
  next_attempt_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueAlertNotificationArgs {
  alertId: string;
  userId: string;
  channel: NotificationChannel;
  template: string;
  payload: AlertNotificationPayload;
  payloadHash: string;
  idempotencyKey: string;
  /** Strategy owner context required for webhook/push tenant integrity. */
  strategyId?: string;
  /** Optional channel-specific destination; email defaults to the user's address. */
  recipient?: string;
  /** Internal webhook/push signing secret; never included in DTOs or logs. */
  signingSecret?: string | null;
  /** Encrypted variant for M9.2 hardening */
  signingSecretEncrypted?: string | null;
  signingSecretKeyVersion?: number | null;
  /** Overrides the column default (from the deployment's retry policy). */
  maxAttempts?: number;
}

export interface EnqueueResult {
  row: NotificationJobRow;
  /** True only when THIS call inserted the row (replays → false). */
  created: boolean;
}

export interface OutboxDefaults {
  maxAttempts: number;
}

export interface AttemptResult {
  provider?: string | null;
  providerMessageId?: string | null;
  providerResponseCode?: string | null;
  failureCategory: NotificationFailureCategory;
  error?: string | null;
}

export interface CleanupPolicy {
  deliveredRetentionDays: number;
  failedRetentionDays: number;
}

export interface OutboxDepth {
  pending: number;
  processing: number;
  delivered: number;
  failed: number;
  unavailable: number;
}

export class NotificationOutbox {
  private readonly secretManager?: SecretManager;
  constructor(
    private readonly pool: pg.Pool,
    private readonly defaults: OutboxDefaults,
    secretManager?: SecretManager,
  ) {
    this.secretManager = secretManager;
  }

  private encryptSecret(plaintext: string | null | undefined): { encrypted: string | null; keyVersion: number | null; plaintextForLegacy: string | null } {
    if (!plaintext) return { encrypted: null, keyVersion: null, plaintextForLegacy: null };
    if (!this.secretManager) {
      return { encrypted: null, keyVersion: null, plaintextForLegacy: plaintext };
    }
    if (looksEncrypted(plaintext)) {
      return { encrypted: plaintext, keyVersion: this.secretManager.keyVersion, plaintextForLegacy: null };
    }
    try {
      const enc = this.secretManager.encrypt(plaintext);
      return { encrypted: enc.ciphertext, keyVersion: enc.keyVersion, plaintextForLegacy: null };
    } catch {
      return { encrypted: null, keyVersion: null, plaintextForLegacy: plaintext };
    }
  }

  private decryptSecret(row: { signing_secret: string | null; signing_secret_encrypted?: string | null; signing_secret_key_version?: number | null }): string | null {
    if ((row as { signing_secret_encrypted?: string | null }).signing_secret_encrypted) {
      const enc = (row as { signing_secret_encrypted?: string | null }).signing_secret_encrypted!;
      const version = (row as { signing_secret_key_version?: number | null }).signing_secret_key_version ?? this.secretManager?.keyVersion ?? 1;
      if (this.secretManager) {
        try {
          return this.secretManager.decrypt(enc, version);
        } catch {
          return row.signing_secret ?? null;
        }
      }
      return row.signing_secret ?? null;
    }
    return row.signing_secret ?? null;
  }

  /**
   * Insert one job for an alert, idempotently.
   *
   * `q` is the caller's transaction client: the alert row and its delivery job
   * must commit together (an alert without a job would never be delivered and
   * a job without an alert is impossible — the FK forbids it).
   *
   * The recipient is read from `users.email` inside the INSERT, so the job
   * stores the address that will actually be used (an audit trail that does
   * not change if the user later edits their account).
   *
   * `ON CONFLICT (alert_id, channel) DO NOTHING` is the DB-level duplicate
   * guard: a replayed generation request, a retried HTTP call, a concurrent
   * twin or a crashed-and-restarted worker all collapse onto the one row.
   */
  async enqueue(q: Queryable, args: EnqueueAlertNotificationArgs): Promise<EnqueueResult> {
    const table = tableForChannel(args.channel);
    if (args.channel === 'webhook' || args.channel === 'push') {
      if (!args.strategyId) throw Errors.internal(`${args.channel} notification is missing strategy ownership context`);
      // M9.2: encrypt signing secret at rest if secret manager available
      const enc = this.encryptSecret(args.signingSecret ?? null);
      // Prefer encrypted, fallback to plaintext for dev/test without manager
      const finalSecret = enc.plaintextForLegacy;
      const finalEncrypted = enc.encrypted ?? args.signingSecretEncrypted ?? null;
      const finalKeyVersion = enc.keyVersion ?? args.signingSecretKeyVersion ?? null;

      const row = await q.query<NotificationJobRow>(
        `INSERT INTO ${table}
          (alert_id, user_id, strategy_id, template, idempotency_key, payload_hash, payload, recipient, signing_secret, signing_secret_encrypted, signing_secret_key_version, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (alert_id) DO NOTHING RETURNING *`,
        [
          args.alertId,
          args.userId,
          args.strategyId,
          args.template,
          args.idempotencyKey,
          args.payloadHash,
          JSON.stringify(args.payload),
          args.recipient,
          finalSecret,
          finalEncrypted,
          finalKeyVersion,
          args.maxAttempts ?? this.defaults.maxAttempts,
        ],
      );
      if (row.rows[0]) return { row: row.rows[0], created: true };
      const existing = await q.query<NotificationJobRow>(`SELECT * FROM ${table} WHERE alert_id = $1`, [args.alertId]);
      if (!existing.rows[0]) throw Errors.internal(`${args.channel} notification job could not be created for this alert`);
      return { row: existing.rows[0], created: false };
    }
    const inserted = await q.query<NotificationJobRow>(
      `INSERT INTO ${table}
         (alert_id, user_id, channel, template, idempotency_key, payload_hash,
          payload, recipient, max_attempts)
       SELECT $1, u.id, $3, $4, $5, $6, $7, COALESCE($8, u.email), $9
         FROM users u
        WHERE u.id = $2
       ON CONFLICT (alert_id, channel) DO NOTHING
       RETURNING *`,
      [
        args.alertId,
        args.userId,
        args.channel,
        args.template,
        args.idempotencyKey,
        args.payloadHash,
        JSON.stringify(args.payload),
        args.recipient ?? null,
        args.maxAttempts ?? this.defaults.maxAttempts,
      ],
    );

    const row = inserted.rows[0];
    if (row) return { row, created: true };

    // Existing job (replay or the loser of a race): read the winner.
    const existing = await q.query<NotificationJobRow>(
      `SELECT * FROM ${table} WHERE alert_id = $1 AND channel = $2`,
      [args.alertId, args.channel],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      // The alert row is gone (cascade/deleted) — nothing to deliver.
      throw Errors.internal('Notification job could not be created for this alert');
    }
    return { row: existingRow, created: false };
  }

  /** Owner-scoped read: throws a masked 404 when the alert is not the caller's. */
  async listForAlert(userId: string, alertId: string): Promise<NotificationDto[]> {
    const owned = await this.pool.query<{ id: string }>('SELECT id FROM alerts WHERE id = $1 AND user_id = $2', [
      alertId,
      userId,
    ]);
    if (!owned.rows[0]) throw Errors.notFound('Alert not found');

    const res = await this.pool.query<NotificationJobRow>(
      `SELECT * FROM (
         SELECT id, alert_id, user_id, channel, template, idempotency_key, payload_hash, payload, recipient,
           NULL::text AS signing_secret, status, attempts, max_attempts, provider, provider_message_id,
           provider_response_code, failure_category, last_error, next_attempt_at, locked_at, locked_by,
           delivered_at, created_at, updated_at
         FROM notification_deliveries WHERE alert_id = $1
         UNION ALL
         SELECT id, alert_id, user_id, channel, template, idempotency_key, payload_hash, payload, recipient,
           signing_secret, status, attempts, max_attempts, provider, provider_message_id,
           provider_response_code, failure_category, last_error, next_attempt_at, locked_at, locked_by,
           delivered_at, created_at, updated_at
         FROM notification_webhook_deliveries WHERE alert_id = $1
         UNION ALL
         SELECT id, alert_id, user_id, channel, template, idempotency_key, payload_hash, payload, recipient,
           COALESCE(signing_secret_encrypted, signing_secret) AS signing_secret, status, attempts, max_attempts, provider, provider_message_id,
           provider_response_code, failure_category, last_error, next_attempt_at, locked_at, locked_by,
           delivered_at, created_at, updated_at
         FROM notification_push_deliveries WHERE alert_id = $1
       ) jobs ORDER BY created_at ASC, id ASC LIMIT $2`,
      [alertId, MAX_NOTIFICATIONS_PER_ALERT],
    );
    return res.rows.map(toNotificationDto);
  }

  /**
   * Claim up to `limit` due jobs atomically across all delivery queues.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes two workers safe: a row already
   * locked by another claim is skipped instead of blocking, so two concurrent
   * `runOnce` calls process disjoint sets. `attempts < max_attempts` keeps the
   * retry budget bounded even if a worker dies repeatedly.
   *
   * Cross-queue fairness (M9.1 remediation, M9.2 extended to 3-way): every claim
   * decision — single row or batch — is taken under the shared transaction-level
   * advisory lock and is derived from the durable ledger in
   * `notification_delivery_fairness`. It is never derived from `sum(attempts)`
   * over the delivery tables (that history is deleted by `cleanup()`), from
   * instance memory (lost on restart or reconstruction), or from the worker
   * identity (changes every deploy). The ledger update commits in the same
   * transaction as the claim, so a rolled-back claim never advances fairness
   * and a committed claim can never lose its ledger increment.
   */
  async claimBatch(limit: number, workerId: string, q: Queryable = this.pool): Promise<NotificationJobRow[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const bounded = Math.trunc(limit);
    // A pool-backed claim owns its transaction so selection and state change
    // across all tables commit as one operation. A caller-supplied client is
    // already transaction-owned (and is used by the SKIP LOCKED tests).
    if (q === this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const jobs = await this.claimBatchInTransaction(bounded, workerId, client);
        await client.query('COMMIT');
        return jobs;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    return this.claimBatchInTransaction(bounded, workerId, q);
  }

  private async claimBatchInTransaction(limit: number, workerId: string, q: Queryable): Promise<NotificationJobRow[]> {
    // M9.1 remediation + M9.2 3-way — ONE durable decision for EVERY claim size.
    await q.query('SELECT pg_advisory_xact_lock($1)', [NOTIFICATION_FAIRNESS_LOCK_KEY]);
    await q.query(
      `INSERT INTO notification_delivery_fairness (singleton, last_channel)
       VALUES (true, 'webhook') ON CONFLICT (singleton) DO NOTHING`,
    );
    const state = await q.query<{
      last_channel: string;
      email_claims: string;
      webhook_claims: string;
      push_claims: string;
    }>(
      `SELECT last_channel,
              email_claims::text AS email_claims,
              webhook_claims::text AS webhook_claims,
              COALESCE(push_claims, 0)::text AS push_claims
         FROM notification_delivery_fairness
        WHERE singleton = true
        FOR UPDATE`,
    );
    const ledger = state.rows[0];
    const emailClaims = BigInt(ledger?.email_claims ?? '0');
    const webhookClaims = BigInt(ledger?.webhook_claims ?? '0');
    const pushClaims = BigInt(ledger?.push_claims ?? '0');

    type QueueInfo = { channel: NotificationChannel; table: string; claims: bigint; rrIndex: number };
    const lastChannel = (ledger?.last_channel ?? 'webhook') as NotificationChannel;

    // Round-robin order after last_channel: e.g. last=webhook => push, email, webhook
    // Define canonical order
    const canonical: NotificationChannel[] = ['email', 'webhook', 'push'];
    const lastIdx = canonical.indexOf(lastChannel);
    const rrOrder: NotificationChannel[] = lastIdx >= 0 ? [...canonical.slice(lastIdx + 1), ...canonical.slice(0, lastIdx + 1)] : [...canonical];
    // Map channel to rrIndex (0 = next to serve, 2 = last served)
    const rrIndexMap = new Map<NotificationChannel, number>();
    rrOrder.forEach((ch, idx) => {
      // The last element is the last_channel itself, so it should have highest index (least preferred for tie)
      // Actually rrOrder is [next, ..., last], so index 0 is most preferred for tie, last is least
      rrIndexMap.set(ch, idx);
    });

    const queues: QueueInfo[] = [
      { channel: 'email', table: EMAIL_DELIVERY_TABLE, claims: emailClaims, rrIndex: rrIndexMap.get('email') ?? 0 },
      { channel: 'webhook', table: WEBHOOK_DELIVERY_TABLE, claims: webhookClaims, rrIndex: rrIndexMap.get('webhook') ?? 1 },
      { channel: 'push', table: PUSH_DELIVERY_TABLE, claims: pushClaims, rrIndex: rrIndexMap.get('push') ?? 2 },
    ];

    // Sort by claims ascending, then rrIndex ascending (round-robin tie-break)
    const sorted = [...queues].sort((a, b) => {
      if (a.claims < b.claims) return -1;
      if (a.claims > b.claims) return 1;
      return a.rrIndex - b.rrIndex;
    });

    if (limit === 1) {
      for (const qInfo of sorted) {
        const jobs = await this.claimTable(qInfo.table, 1, workerId, q);
        if (jobs.length > 0) {
          await this.recordFairnessClaims(q, {
            email: qInfo.channel === 'email' ? 1 : 0,
            webhook: qInfo.channel === 'webhook' ? 1 : 0,
            push: qInfo.channel === 'push' ? 1 : 0,
          });
          return jobs;
        }
      }
      return [];
    }

    // Batch: distribute limit fairly across 3 queues in preference order, but
    // fill up to limit when one or more queues are empty/insufficient.
    // First pass uses decreasing remainingQueues so that empty queues do not strand capacity:
    // e.g. limit 4, queues [push(empty), email, webhook] => per ceil(4/3)=2,0, then ceil(4/2)=2,2, then ceil(2/1)=2,2 => 2+2 balanced.
    let jobs: NotificationJobRow[] = [];
    let remaining = limit;
    let remainingQueues = sorted.length;
    for (const qInfo of sorted) {
      if (remaining <= 0) break;
      const per = Math.max(1, Math.ceil(remaining / remainingQueues));
      const claimed = await this.claimTable(qInfo.table, per, workerId, q);
      jobs = [...jobs, ...claimed];
      remaining = limit - jobs.length;
      remainingQueues--;
    }
    // Second pass: if some queue had fewer than its quota, fill the leftover from any queue that still has work.
    if (remaining > 0) {
      for (const qInfo of sorted) {
        if (remaining <= 0) break;
        const extra = await this.claimTable(qInfo.table, remaining, workerId, q);
        if (extra.length > 0) {
          jobs = [...jobs, ...extra];
          remaining = limit - jobs.length;
        }
      }
    }

    const counts = {
      email: jobs.reduce((n, job) => n + (job.channel === 'email' ? 1 : 0), 0),
      webhook: jobs.reduce((n, job) => n + (job.channel === 'webhook' ? 1 : 0), 0),
      push: jobs.reduce((n, job) => n + (job.channel === 'push' ? 1 : 0), 0),
    };
    await this.recordFairnessClaims(q, counts);
    return jobs.sort((a, b) => {
      const due = a.next_attempt_at.getTime() - b.next_attempt_at.getTime();
      return due || a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id);
    });
  }

  /**
   * Record the claims THIS transaction actually made into the durable ledger:
   * lifetime counters only ever grow, and the round-robin turn moves to the
   * queue that received more claims this decision (a balanced split keeps the
   * turn, so the next tie-break still alternates). Running it under the
   * advisory lock, in the claiming transaction, is what makes fairness both
   * atomic (claim and score commit or roll back together) and durable (the
   * counters live outside the retention-managed delivery tables).
   */
  private async recordFairnessClaims(
    q: Queryable,
    counts: { email: number; webhook: number; push: number },
  ): Promise<void> {
    const { email, webhook, push } = counts;
    if (email === 0 && webhook === 0 && push === 0) return;
    await q.query(
      `UPDATE notification_delivery_fairness
          SET email_claims = email_claims + $1::bigint,
              webhook_claims = webhook_claims + $2::bigint,
              push_claims = COALESCE(push_claims, 0) + $3::bigint,
              last_channel = CASE
                WHEN $1 > $2 AND $1 > $3 THEN 'email'::text
                WHEN $2 > $1 AND $2 > $3 THEN 'webhook'::text
                WHEN $3 > $1 AND $3 > $2 THEN 'push'::text
                ELSE last_channel
              END,
              updated_at = now()
        WHERE singleton = true`,
      [email, webhook, push],
    );
  }

  private async claimTable(table: string, limit: number, workerId: string, q: Queryable): Promise<NotificationJobRow[]> {
    if (limit <= 0) return [];
    const res = await q.query<NotificationJobRow>(
      `WITH candidate AS (
         SELECT id FROM ${table}
          WHERE status = 'pending' AND next_attempt_at <= now() AND attempts < max_attempts
          ORDER BY next_attempt_at ASC, created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE ${table} n SET status = 'processing', locked_at = now(), locked_by = $2,
         attempts = n.attempts + 1, failure_category = 'none', last_error = NULL
       FROM candidate c WHERE n.id = c.id RETURNING n.*`,
      [limit, workerId],
    );
    return res.rows;
  }

  /** Success: terminal, keeps the provider's receipt for traceability. */
  async markDelivered(jobId: string, result: AttemptResult, channel: NotificationChannel = 'email'): Promise<void> {
    await this.pool.query(
      `UPDATE ${tableForChannel(channel)}
          SET status = 'delivered',
              provider = $2,
              provider_message_id = $3,
              provider_response_code = $4,
              failure_category = 'none',
              last_error = NULL,
              delivered_at = now(),
              locked_at = NULL,
              locked_by = NULL,
              next_attempt_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [
        jobId,
        result.provider ?? null,
        result.providerMessageId ?? null,
        result.providerResponseCode ?? null,
      ],
    );
  }

  /**
   * Schedule the next attempt — or dead-letter the job when the budget is
   * exhausted. `delayMs` comes from the worker's (pure, deterministic) backoff
   * function, so the SQL stays a single bounded UPDATE.
   */
  async markRetry(jobId: string, delayMs: number, result: AttemptResult, channel: NotificationChannel = 'email'): Promise<'retried' | 'failed'> {
    const retried = await this.pool.query(
      `UPDATE ${tableForChannel(channel)}
          SET status = 'pending',
              next_attempt_at = now() + ($2::int * interval '1 millisecond'),
              provider = $3,
              provider_response_code = $4,
              failure_category = $5,
              last_error = $6,
              locked_at = NULL,
              locked_by = NULL
        WHERE id = $1 AND status = 'processing' AND attempts < max_attempts`,
      [
        jobId,
        Math.max(0, Math.trunc(delayMs)),
        result.provider ?? null,
        result.providerResponseCode ?? null,
        result.failureCategory,
        result.error ?? null,
      ],
    );
    if ((retried.rowCount ?? 0) > 0) return 'retried';
    await this.markFailed(jobId, result, channel);
    return 'failed';
  }

  /** Permanent failure or exhausted retries: dead-lettered, never retried. */
  async markFailed(jobId: string, result: AttemptResult, channel: NotificationChannel = 'email'): Promise<void> {
    await this.pool.query(
      `UPDATE ${tableForChannel(channel)}
          SET status = 'failed',
              provider = $2,
              provider_response_code = $3,
              failure_category = $4,
              last_error = $5,
              next_attempt_at = now(),
              locked_at = NULL,
              locked_by = NULL
        WHERE id = $1 AND status = 'processing'`,
      [jobId, result.provider ?? null, result.providerResponseCode ?? null, result.failureCategory, result.error ?? null],
    );
  }

  /**
   * No usable provider for the channel: honest, terminal-but-recoverable.
   *
   * Not `delivered` (nothing was sent) and not `failed` (nothing is broken) —
   * `unavailable` is the "configure delivery and these go out" state. It is
   * terminal, so a misconfigured deployment cannot spin forever.
   */
  async markUnavailable(jobId: string, result: AttemptResult, channel: NotificationChannel = 'email'): Promise<void> {
    await this.pool.query(
      `UPDATE ${tableForChannel(channel)}
          SET status = 'unavailable',
              provider = $2,
              failure_category = $3,
              last_error = $4,
              next_attempt_at = now(),
              locked_at = NULL,
              locked_by = NULL
        WHERE id = $1 AND status = 'processing'`,
      [jobId, result.provider ?? null, result.failureCategory, result.error ?? null],
    );
  }

  /**
   * Recover jobs whose worker died mid-attempt (process crash, deploy, killed
   * instance): anything still `processing` past its lease is either returned to
   * `pending` (budget left) or dead-lettered with `stale` (budget exhausted).
   * This is what guarantees "no job is stuck forever" and it is idempotent, so
   * every worker can call it before claiming.
   */
  async recoverStale(leaseMs: number): Promise<{ recovered: number; deadLettered: number }> {
    const lease = Math.max(1, Math.trunc(leaseMs));
    const tables = [EMAIL_DELIVERY_TABLE, WEBHOOK_DELIVERY_TABLE, PUSH_DELIVERY_TABLE];
    const results = await Promise.all(
      tables.map(async (table) => {
        const back = await this.pool.query(
          `UPDATE ${table} SET status = 'pending', next_attempt_at = now(), failure_category = 'stale', last_error = 'worker did not finish inside the lease — recovered', locked_at = NULL, locked_by = NULL WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 millisecond') AND attempts < max_attempts`,
          [lease],
        );
        const dead = await this.pool.query(
          `UPDATE ${table} SET status = 'failed', failure_category = 'stale', last_error = 'worker did not finish inside the lease — retry budget exhausted', next_attempt_at = now(), locked_at = NULL, locked_by = NULL WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 millisecond') AND attempts >= max_attempts`,
          [lease],
        );
        return { recovered: back.rowCount ?? 0, deadLettered: dead.rowCount ?? 0 };
      }),
    );
    return results.reduce(
      (sum, value) => ({ recovered: sum.recovered + value.recovered, deadLettered: sum.deadLettered + value.deadLettered }),
      { recovered: 0, deadLettered: 0 },
    );
  }

  /**
   * Re-queue `unavailable` jobs whose channel now HAS a configured provider.
   * Called by the worker (bounded by `limit`), never by a request: a job only
   * leaves `unavailable` when delivery is actually possible, and the attempt
   * counter resets because the previous attempts never reached a provider.
   */
  async requeueUnavailable(channels: readonly NotificationChannel[], limit: number): Promise<number> {
    if (channels.length === 0) return 0;
    let total = 0;
    for (const channel of channels) {
      const table = tableForChannel(channel);
      const res = await this.pool.query(
        `UPDATE ${table} SET status = 'pending', attempts = 0, failure_category = 'none', last_error = NULL, next_attempt_at = now(), locked_at = NULL, locked_by = NULL WHERE id IN (SELECT id FROM ${table} WHERE status = 'unavailable' LIMIT $1 FOR UPDATE SKIP LOCKED)`,
        [Math.max(1, Math.trunc(limit))],
      );
      total += res.rowCount ?? 0;
    }
    return total;
  }

  /**
   * Bounded retention: delivered rows age out first (their content is
   * reproducible and the alert itself is the durable record), then dead
   * letters, which are kept much longer because they are the failure audit
   * trail. `pending`, `processing` and `unavailable` rows are NEVER deleted —
   * they represent work that is still owed or blocked on configuration.
   *
   * Dead-letter retention is anchored on `created_at` (when the alert was
   * queued), not `updated_at`: a job's retry schedule is short, and
   * `updated_at` is rewritten by the `set_updated_at()` trigger on every
   * transition, which makes it unusable as an age filter.
   */
  async cleanup(policy: CleanupPolicy): Promise<number> {
    let deleted = 0;
    for (const table of [EMAIL_DELIVERY_TABLE, WEBHOOK_DELIVERY_TABLE, PUSH_DELIVERY_TABLE]) {
      const delivered = await this.pool.query(
        `DELETE FROM ${table} WHERE status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < now() - ($1::int * interval '1 day')`,
        [Math.max(1, Math.trunc(policy.deliveredRetentionDays))],
      );
      const failed = await this.pool.query(
        `DELETE FROM ${table} WHERE status = 'failed' AND created_at < now() - ($1::int * interval '1 day')`,
        [Math.max(1, Math.trunc(policy.failedRetentionDays))],
      );
      deleted += (delivered.rowCount ?? 0) + (failed.rowCount ?? 0);
    }
    return deleted;
  }

  /** Queue depth per status — the number an operator watches. */
  async depth(): Promise<OutboxDepth> {
    const res = await this.pool.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM (
         SELECT status FROM notification_deliveries
         UNION ALL SELECT status FROM notification_webhook_deliveries
         UNION ALL SELECT status FROM notification_push_deliveries
       ) jobs GROUP BY status`,
    );
    const depth: OutboxDepth = { pending: 0, processing: 0, delivered: 0, failed: 0, unavailable: 0 };
    for (const row of res.rows) {
      if ((NOTIFICATION_STATUSES as readonly string[]).includes(row.status)) {
        depth[row.status as NotificationStatus] = Number(row.n);
      }
    }
    return depth;
  }
}

/** Row → owner-visible DTO. Nothing sensitive crosses this boundary. */
export function toNotificationDto(row: NotificationJobRow): NotificationDto {
  return {
    id: row.id,
    alertId: row.alert_id,
    channel: row.channel as NotificationDto['channel'],
    status: row.status as NotificationDto['status'],
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    failureCategory: row.failure_category as NotificationDto['failureCategory'],
    provider: row.provider,
    nextAttemptAt: row.next_attempt_at ? row.next_attempt_at.toISOString() : null,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
