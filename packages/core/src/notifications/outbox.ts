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
 */

/** Anything with a `query` method: a `Pool` or a transaction `PoolClient`. */
export type Queryable = Pick<pg.Pool, 'query'>;
const EMAIL_DELIVERY_TABLE = 'notification_deliveries';
const WEBHOOK_DELIVERY_TABLE = 'notification_webhook_deliveries';
/** Shared PostgreSQL advisory lock for the cross-instance single-row decision. */
const NOTIFICATION_FAIRNESS_LOCK_KEY = 611_231_008;
function tableForChannel(channel: NotificationChannel): string {
  return channel === 'webhook' ? WEBHOOK_DELIVERY_TABLE : EMAIL_DELIVERY_TABLE;
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
  /** Strategy owner context required for webhook tenant integrity. */
  strategyId?: string;
  /** Optional channel-specific destination; email defaults to the user's address. */
  recipient?: string;
  /** Internal webhook signing secret; never included in DTOs or logs. */
  signingSecret?: string | null;
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
  constructor(
    private readonly pool: pg.Pool,
    private readonly defaults: OutboxDefaults,
  ) {}

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
    if (args.channel === 'webhook') {
      if (!args.strategyId) throw Errors.internal('Webhook notification is missing strategy ownership context');
      const webhook = await q.query<NotificationJobRow>(
        `INSERT INTO notification_webhook_deliveries
          (alert_id, user_id, strategy_id, template, idempotency_key, payload_hash, payload, recipient, signing_secret, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (alert_id) DO NOTHING RETURNING *`,
        [args.alertId, args.userId, args.strategyId, args.template, args.idempotencyKey, args.payloadHash, JSON.stringify(args.payload), args.recipient, args.signingSecret ?? null, args.maxAttempts ?? this.defaults.maxAttempts],
      );
      if (webhook.rows[0]) return { row: webhook.rows[0], created: true };
      const existingWebhook = await q.query<NotificationJobRow>('SELECT * FROM notification_webhook_deliveries WHERE alert_id = $1', [args.alertId]);
      if (!existingWebhook.rows[0]) throw Errors.internal('Webhook notification job could not be created for this alert');
      return { row: existingWebhook.rows[0], created: false };
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
       ) jobs ORDER BY created_at ASC, id ASC LIMIT $2`,
      [alertId, MAX_NOTIFICATIONS_PER_ALERT],
    );
    return res.rows.map(toNotificationDto);
  }

  /**
   * Claim up to `limit` due jobs atomically.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes two workers safe: a row already
   * locked by another claim is skipped instead of blocking, so two concurrent
   * `runOnce` calls process disjoint sets. `attempts < max_attempts` keeps the
   * retry budget bounded even if a worker dies repeatedly.
   */
  async claimBatch(limit: number, workerId: string, q: Queryable = this.pool): Promise<NotificationJobRow[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const bounded = Math.trunc(limit);
    // A pool-backed claim owns its transaction so selection and state change
    // across both tables commit as one operation. A caller-supplied client is
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
    // The advisory lock serializes every single-row decision across workers.
    // The singleton row is locked and updated in this same transaction, so
    // fairness survives delivery cleanup, retries, restarts, and reconstruction.
    if (limit === 1) {
      await q.query('SELECT pg_advisory_xact_lock($1)', [NOTIFICATION_FAIRNESS_LOCK_KEY]);
      await q.query(
        `INSERT INTO notification_delivery_fairness (singleton, last_channel)
         VALUES (true, 'webhook') ON CONFLICT (singleton) DO NOTHING`,
      );
      const state = await q.query<{ last_channel: NotificationChannel }>(
        'SELECT last_channel FROM notification_delivery_fairness WHERE singleton = true FOR UPDATE',
      );
      const last = state.rows[0]?.last_channel === 'email' ? 'email' : 'webhook';
      const first = last === 'email' ? WEBHOOK_DELIVERY_TABLE : EMAIL_DELIVERY_TABLE;
      const second = first === EMAIL_DELIVERY_TABLE ? WEBHOOK_DELIVERY_TABLE : EMAIL_DELIVERY_TABLE;
      const firstJobs = await this.claimTable(first, 1, workerId, q);
      if (firstJobs.length > 0) {
        await this.recordFairnessTurn(first, q);
        return firstJobs;
      }
      const secondJobs = await this.claimTable(second, 1, workerId, q);
      if (secondJobs.length > 0) await this.recordFairnessTurn(second, q);
      return secondJobs;
    }

    // Alternate the preferred table while reserving half the batch for each
    // table. If one side is short, the unused capacity is filled from the
    // other side. Every claim is therefore <= limit and every transitioned row
    // is retained in the returned array.
    const preferWebhook = [...workerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2 === 1;
    const first = preferWebhook ? WEBHOOK_DELIVERY_TABLE : EMAIL_DELIVERY_TABLE;
    const second = preferWebhook ? EMAIL_DELIVERY_TABLE : WEBHOOK_DELIVERY_TABLE;
    const firstQuota = Math.ceil(limit / 2);
    const secondQuota = limit - firstQuota;
    const firstJobs = await this.claimTable(first, firstQuota, workerId, q);
    const secondJobs = await this.claimTable(second, secondQuota, workerId, q);
    let jobs = [...firstJobs, ...secondJobs];
    let remaining = limit - jobs.length;
    if (remaining > 0 && firstJobs.length < firstQuota) {
      const extra = await this.claimTable(first, Math.min(remaining, firstQuota - firstJobs.length), workerId, q);
      jobs = [...jobs, ...extra];
      remaining -= extra.length;
    }
    if (remaining > 0 && secondJobs.length < secondQuota) {
      const extra = await this.claimTable(second, Math.min(remaining, secondQuota - secondJobs.length), workerId, q);
      jobs = [...jobs, ...extra];
    }
    return jobs.sort((a, b) => {
      const due = a.next_attempt_at.getTime() - b.next_attempt_at.getTime();
      return due || a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id);
    });
  }

  private async recordFairnessTurn(table: string, q: Queryable): Promise<void> {
    const channel = table === EMAIL_DELIVERY_TABLE ? 'email' : 'webhook';
    await q.query(
      `UPDATE notification_delivery_fairness
          SET last_channel = $1, updated_at = now()
        WHERE singleton = true`,
      [channel],
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
       FROM candidate c WHERE n.id = c.id RETURNING n.*`, [limit, workerId]);
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
    const results = await Promise.all([EMAIL_DELIVERY_TABLE, WEBHOOK_DELIVERY_TABLE].map(async (table) => {
      const back = await this.pool.query(`UPDATE ${table} SET status = 'pending', next_attempt_at = now(), failure_category = 'stale', last_error = 'worker did not finish inside the lease — recovered', locked_at = NULL, locked_by = NULL WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 millisecond') AND attempts < max_attempts`, [lease]);
      const dead = await this.pool.query(`UPDATE ${table} SET status = 'failed', failure_category = 'stale', last_error = 'worker did not finish inside the lease — retry budget exhausted', next_attempt_at = now(), locked_at = NULL, locked_by = NULL WHERE status = 'processing' AND locked_at < now() - ($1::int * interval '1 millisecond') AND attempts >= max_attempts`, [lease]);
      return { recovered: back.rowCount ?? 0, deadLettered: dead.rowCount ?? 0 };
    }));
    return results.reduce((sum, value) => ({ recovered: sum.recovered + value.recovered, deadLettered: sum.deadLettered + value.deadLettered }), { recovered: 0, deadLettered: 0 });
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
      const res = await this.pool.query(`UPDATE ${table} SET status = 'pending', attempts = 0, failure_category = 'none', last_error = NULL, next_attempt_at = now(), locked_at = NULL, locked_by = NULL WHERE id IN (SELECT id FROM ${table} WHERE status = 'unavailable' LIMIT $1 FOR UPDATE SKIP LOCKED)`, [Math.max(1, Math.trunc(limit))]);
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
    for (const table of [EMAIL_DELIVERY_TABLE, WEBHOOK_DELIVERY_TABLE]) {
      const delivered = await this.pool.query(`DELETE FROM ${table} WHERE status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at < now() - ($1::int * interval '1 day')`, [Math.max(1, Math.trunc(policy.deliveredRetentionDays))]);
      const failed = await this.pool.query(`DELETE FROM ${table} WHERE status = 'failed' AND created_at < now() - ($1::int * interval '1 day')`, [Math.max(1, Math.trunc(policy.failedRetentionDays))]);
      deleted += (delivered.rowCount ?? 0) + (failed.rowCount ?? 0);
    }
    return deleted;
  }

  /** Queue depth per status — the number an operator watches. */
  async depth(): Promise<OutboxDepth> {
    const res = await this.pool.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM (SELECT status FROM notification_deliveries UNION ALL SELECT status FROM notification_webhook_deliveries) jobs GROUP BY status`,
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
