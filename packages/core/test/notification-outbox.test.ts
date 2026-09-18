/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M7.3 — durable outbox, delivery worker, retry/idempotency and provider
 * boundary. Runs against a real PostgreSQL (embedded), so every guarantee
 * below is proven by the database: unique constraints, SKIP LOCKED claims,
 * lease recovery and retention.
 *
 * Covered:
 *  1. one job per (alert, channel) — replays, retries and races collapse
 *  2. transactional enqueue (alert + job commit together)
 *  3. claiming: due jobs only, `processing` + lease, never claimed twice
 *  4. success → delivered (with provider receipt)
 *  5. retryable/timeout → scheduled retry with exponential backoff
 *  6. retry budget → dead-letter, never an infinite loop
 *  7. permanent failure → dead-letter on the first attempt
 *  8. stalled worker → recovered (or dead-lettered when the budget is gone)
 *  9. two workers never deliver the same job
 * 10. no provider / unconfigured provider → `unavailable`, never `delivered`
 * 11. retention deletes terminal rows, never work that is still owed
 * 12. owner scoping, payload determinism and credential redaction
 */
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  hashPassword,
  UserService,
  NotificationOutbox,
  createNotificationProviderRegistry,
  createSmtpEmailProvider,
  classifySmtpError,
  DeliveryWorker,
  backoffDelayMs,
  renderAlertNotification,
  notificationPayloadHash,
  notificationIdempotencyKey,
  redactSecrets,
  SMTP_PROVIDER_NAME,
  DEFAULT_DELIVERY_RETRY_POLICY,
  type DeliveryRetryPolicy,
  type NotificationProvider,
  type NotificationProviderRegistry,
  type NotificationSendRequest,
  type NotificationSendResult,
  type EnqueueAlertNotificationArgs,
  type NotificationJobRow,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5442;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_notifications';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let outbox: NotificationOutbox;

/** Short, test-friendly policy: 3 attempts, 1s → 2s → 4s backoff, no jitter. */
const TEST_POLICY: DeliveryRetryPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 1_000,
  maxBackoffMs: 8_000,
  jitterMs: 0,
  leaseMs: 60_000,
  batchSize: 10,
  timeoutMs: 1_000,
};

const uniqueEmail = () => `notif_${randomBytes(6).toString('hex')}@example.com`;

/**
 * The worker drains the whole outbox by design (it has no per-test filter), so
 * every test starts from an empty queue: a "claimed: 1" assertion then really
 * means "this test's job", not "some earlier test's leftovers".
 */
beforeEach(async () => {
  await pool.query('DELETE FROM notification_deliveries');
  await pool.query('DELETE FROM notification_webhook_deliveries');
});

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-notifications');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  users = new UserService(pool);
  outbox = new NotificationOutbox(pool, { maxAttempts: TEST_POLICY.maxAttempts });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

async function makeUser(email = uniqueEmail()): Promise<{ id: string; email: string }> {
  const user = await users.create({
    email,
    passwordHash: await hashPassword('correct-horse-42'),
    name: 'M7 Trader',
  });
  return { id: user.id, email: user.email };
}

async function makeAlert(userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const instrument = await pool.query<{ id: string }>(
    'INSERT INTO instruments (asset_class, symbol) VALUES ($1, $2) RETURNING id',
    ['forex', `N${randomBytes(3).toString('hex').toUpperCase()}`],
  );
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `m73-${randomBytes(4).toString('hex')}`],
  );
  const strategyId = strategy.rows[0]?.id;
  const version = await pool.query<{ id: string }>(
    'INSERT INTO strategy_versions (strategy_id, version_number) VALUES ($1, 1) RETURNING id',
    [strategyId],
  );
  const versionId = version.rows[0]?.id;
  const setup = await pool.query<{ id: string }>(
    `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms,
                         entry_price, stop_loss_price, tp1_price, tp2_price, tp3_price)
     VALUES ($1, $2, 'confirmed', 'long', now(), $3, 1.105, 1.1, 1.11, 1.115, 1.12) RETURNING id`,
    [versionId, instrument.rows[0]?.id, 1_800_000_000_000],
  );
  const alert = await pool.query<{ id: string }>(
    `INSERT INTO alerts (user_id, setup_id, strategy_id, strategy_version_id, instrument_id,
                         direction, trigger_state, quality_score, min_quality_score, title, body)
     VALUES ($1, $2, $3, $4, $5, 'long', 'confirmed', 80, 65, $6, $7) RETURNING id`,
    [
      userId,
      setup.rows[0]?.id,
      strategyId,
      versionId,
      instrument.rows[0]?.id,
      'EURUSD long confirmed (score 80/B)',
      JSON.stringify({
        setupId: setup.rows[0]?.id,
        strategyId,
        strategyVersionId: versionId,
        versionNumber: 1,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        triggerState: 'confirmed',
        qualityScore: 80,
        qualityGrade: 'B',
        minQualityScore: 65,
        entryPrice: 1.105,
        stopLossPrice: 1.1,
        tp1Price: 1.11,
        tp2Price: 1.115,
        tp3Price: 1.12,
        detectedAt: new Date(1_800_000_000_000).toISOString(),
        ...overrides,
      }),
    ],
  );
  const alertId = alert.rows[0]?.id;
  assert.ok(alertId);
  return alertId;
}

/**
 * The payload the alert pipeline renders for a persisted alert: the identity
 * and trade facts come from the alert row, the levels from its body.
 */
function payloadFor(alertId: string, createdAt = new Date(1_800_000_000_000).toISOString()) {
  return renderAlertNotification({
    alertId,
    setupId: '33333333-3333-4333-8333-333333333333',
    strategyId: '44444444-4444-4444-8444-444444444444',
    strategyVersionId: '55555555-5555-4555-8555-555555555555',
    versionNumber: 2,
    direction: 'long',
    triggerState: 'confirmed',
    qualityScore: 80,
    minQualityScore: 65,
    createdAt,
    body: {
      setupId: '33333333-3333-4333-8333-333333333333',
      strategyId: '44444444-4444-4444-8444-444444444444',
      strategyVersionId: '55555555-5555-4555-8555-555555555555',
      versionNumber: 2,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      triggerState: 'confirmed',
      qualityScore: 80,
      qualityGrade: 'B',
      minQualityScore: 65,
      entryPrice: 1.105,
      stopLossPrice: 1.1,
      tp1Price: 1.11,
      tp2Price: 1.115,
      tp3Price: 1.12,
      detectedAt: new Date(1_799_900_000_000).toISOString(),
    },
    symbol: 'EURUSD',
    assetClass: 'forex',
    timeframe: '1h',
  });
}

function enqueueArgs(alertId: string, userId: string): EnqueueAlertNotificationArgs {
  const payload = payloadFor(alertId);
  return {
    alertId,
    userId,
    channel: 'email',
    template: payload.template,
    payload,
    payloadHash: notificationPayloadHash(payload),
    idempotencyKey: notificationIdempotencyKey({
      template: payload.template,
      channel: 'email',
      alertId,
    }),
  };
}

async function enqueueAlert(alertId: string, userId: string): Promise<{ row: NotificationJobRow; created: boolean }> {
  return outbox.enqueue(pool, enqueueArgs(alertId, userId));
}

async function enqueueWebhook(alertId: string, userId: string): Promise<NotificationJobRow> {
  const alert = await pool.query<{ strategy_id: string }>('SELECT strategy_id FROM alerts WHERE id = $1', [alertId]);
  const payload = payloadFor(alertId);
  const result = await outbox.enqueue(pool, {
    alertId,
    userId,
    strategyId: alert.rows[0]!.strategy_id,
    channel: 'webhook',
    recipient: 'https://hooks.example.test/alerts',
    signingSecret: 'webhook-test-secret',
    template: payload.template,
    payload,
    payloadHash: notificationPayloadHash(payload),
    idempotencyKey: notificationIdempotencyKey({ template: payload.template, channel: 'webhook', alertId }),
  });
  return result.row;
}

function fakeProvider(
  handler: (request: NotificationSendRequest, call: number) => Promise<NotificationSendResult>,
  options: { configured?: boolean; name?: string } = {},
): NotificationProvider & { calls: NotificationSendRequest[] } {
  const calls: NotificationSendRequest[] = [];
  return {
    channel: 'email',
    name: options.name ?? 'fake',
    configured: options.configured ?? true,
    describe() {
      return { channel: 'email', provider: this.name, configured: this.configured };
    },
    async send(request) {
      calls.push(request);
      return handler(request, calls.length);
    },
    calls,
  } as NotificationProvider & { calls: NotificationSendRequest[] };
}

function registryWith(provider: NotificationProvider | null): NotificationProviderRegistry {
  const registry = createNotificationProviderRegistry();
  if (provider) registry.register(provider);
  return registry;
}

function worker(registry: NotificationProviderRegistry, policy = TEST_POLICY): DeliveryWorker {
  return new DeliveryWorker(pool, registry, policy);
}

async function getJob(jobId: string): Promise<NotificationJobRow> {
  const res = await pool.query<NotificationJobRow>('SELECT * FROM notification_deliveries WHERE id = $1', [jobId]);
  const row = res.rows[0];
  assert.ok(row, `job ${jobId} exists`);
  return row;
}

/** Make a job immediately due without waiting for its backoff. */
async function forceDue(jobId?: string): Promise<void> {
  await pool.query(
    `UPDATE notification_deliveries SET next_attempt_at = now() - interval '1 second' WHERE ($1::uuid IS NULL OR id = $1::uuid)`,
    [jobId ?? null],
  );
}

/* -------------------------------------------------------------------------- */
/* Outbox: enqueue / idempotency                                               */
/* -------------------------------------------------------------------------- */

describe('outbox — enqueue and idempotency', () => {
  test('an alert enqueues exactly one job; replays and races never duplicate it', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);

    const first = await enqueueAlert(alertId, owner.id);
    assert.equal(first.created, true);
    assert.equal(first.row.status, 'pending');
    assert.equal(first.row.attempts, 0);
    assert.equal(first.row.max_attempts, TEST_POLICY.maxAttempts);
    assert.equal(first.row.channel, 'email');
    assert.equal(first.row.recipient, owner.email, 'recipient is the owner account email');

    // Replay (same request repeated) → same row, created: false.
    const replay = await enqueueAlert(alertId, owner.id);
    assert.equal(replay.created, false);
    assert.equal(replay.row.id, first.row.id);

    // Concurrent twins: two simultaneous inserts for a fresh alert, only one wins.
    const otherAlert = await makeAlert(owner.id);
    const [a, b] = await Promise.all([enqueueAlert(otherAlert, owner.id), enqueueAlert(otherAlert, owner.id)]);
    assert.equal(
      [a.created, b.created].filter(Boolean).length,
      1,
      'exactly one of two concurrent enqueues inserts',
    );
    assert.equal(a.row.id, b.row.id);

    const rows = await pool.query('SELECT id FROM notification_deliveries WHERE alert_id = $1', [alertId]);
    assert.equal(rows.rows.length, 1, 'one job per alert, enforced by UNIQUE (alert_id, channel)');
  });

  test('the job stores the rendered payload verbatim and a deterministic idempotency key', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    assert.equal(row.payload.template, 'alert.email.v1');
    assert.match(row.payload.subject, /EURUSD/);
    assert.match(row.payload.text, /Alert ID/);
    assert.equal(row.payload.data.alertId, alertId);
    assert.equal(row.payload.data.direction, 'long');
    assert.equal(row.payload.data.qualityScore, 80);
    assert.equal(row.payload.data.timeframe, '1h');
    assert.equal(row.payload_hash.length, 64);
    assert.equal(row.idempotency_key.length, 64);

    // Deterministic: the same alert always yields the same key/hash.
    const again = await enqueueAlert(alertId, owner.id);
    assert.equal(again.row.idempotency_key, row.idempotency_key);
    assert.equal(again.row.payload_hash, row.payload_hash);
  });

  test('enqueue is transactional: a rolled-back alert writes no job', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outbox.enqueue(client, enqueueArgs(alertId, owner.id));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const rows = await pool.query('SELECT id FROM notification_deliveries WHERE alert_id = $1', [alertId]);
    assert.equal(rows.rows.length, 0, 'the job must disappear with the rolled-back transaction');
  });

  test('owner scoping: another user cannot list the jobs of an alert they do not own', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const alertId = await makeAlert(owner.id);
    await enqueueAlert(alertId, owner.id);

    const mine = await outbox.listForAlert(owner.id, alertId);
    assert.equal(mine.length, 1);

    await assert.rejects(
      () => outbox.listForAlert(stranger.id, alertId),
      (err: any) => err?.code === 'not_found',
      'a foreign alert is a masked 404, not an empty list',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Claiming / concurrency                                                      */
/* -------------------------------------------------------------------------- */

describe('outbox — claiming', () => {
  test('claim marks jobs processing, records the lease holder and counts the attempt', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const claimed = await outbox.claimBatch(10, 'worker-A');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.id, row.id);
    assert.equal(claimed[0]?.attempts, 1);
    assert.equal(claimed[0]?.locked_by, 'worker-A');

    const after = await getJob(row.id);
    assert.equal(after.status, 'processing');
    assert.ok(after.locked_at, 'lease timestamp set');

    // A second, sequential claim finds nothing: the job is no longer pending.
    assert.equal((await outbox.claimBatch(10, 'worker-B')).length, 0);
  });

  test('SKIP LOCKED: a job claimed in an open transaction is invisible to a second worker', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    await enqueueAlert(alertId, owner.id);

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      const first = await outbox.claimBatch(10, 'A', clientA);
      assert.equal(first.length, 1, 'worker A claims the job');

      await clientB.query('BEGIN');
      // Same instant, different connection: the row is locked by A, so B skips
      // it instead of blocking or double-claiming.
      const second = await outbox.claimBatch(10, 'B', clientB);
      assert.equal(second.length, 0, 'worker B must not see the locked row');

      await clientA.query('COMMIT');
      await clientB.query('COMMIT');
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  test('non-positive limits claim no jobs', async () => {
    const owner = await makeUser();
    const emailAlert = await makeAlert(owner.id);
    await enqueueAlert(emailAlert, owner.id);
    const webhookAlert = await makeAlert(owner.id);
    await enqueueWebhook(webhookAlert, owner.id);
    assert.deepEqual(await outbox.claimBatch(0, 'zero-worker'), []);
    assert.deepEqual(await outbox.claimBatch(-1, 'negative-worker'), []);
    const states = await pool.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM (SELECT status FROM notification_deliveries UNION ALL SELECT status FROM notification_webhook_deliveries) jobs GROUP BY status`);
    assert.equal(Number(states.rows.find((row) => row.status === 'processing')?.n ?? 0), 0);
    assert.equal(Number(states.rows.find((row) => row.status === 'pending')?.n ?? 0), 2);
  });

  test('limit one round-robins both continuously populated queues', async () => {
    const owner = await makeUser();
    for (let i = 0; i < 6; i++) await enqueueAlert(await makeAlert(owner.id), owner.id);
    for (let i = 0; i < 6; i++) await enqueueWebhook(await makeAlert(owner.id), owner.id);
    const claimed = [] as NotificationJobRow[];
    for (let i = 0; i < 6; i++) claimed.push(...await outbox.claimBatch(1, `fair-worker-${i}`));
    assert.equal(claimed.length, 6);
    const processing = await pool.query<{ channel: string; n: string }>(`SELECT channel, count(*)::text AS n FROM (SELECT channel FROM notification_deliveries WHERE status = 'processing' UNION ALL SELECT channel FROM notification_webhook_deliveries WHERE status = 'processing') jobs GROUP BY channel`);
    assert.ok(Number(processing.rows.find((row) => row.channel === 'email')?.n ?? 0) > 0);
    assert.ok(Number(processing.rows.find((row) => row.channel === 'webhook')?.n ?? 0) > 0);
  });

  test('claims at most the requested total across email and webhook and returns every lease', async () => {
    const owner = await makeUser();
    const created: string[] = [];
    for (let i = 0; i < 4; i++) {
      const alertId = await makeAlert(owner.id);
      created.push((await enqueueAlert(alertId, owner.id)).row.id);
    }
    for (let i = 0; i < 4; i++) {
      const alertId = await makeAlert(owner.id);
      created.push((await enqueueWebhook(alertId, owner.id)).id);
    }
    const claimed = await outbox.claimBatch(4, 'mixed-worker');
    assert.equal(claimed.length, 4);
    assert.equal(new Set(claimed.map((job) => job.id)).size, 4);
    assert.ok(claimed.every((job) => created.includes(job.id)));
    const states = await pool.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM (SELECT status FROM notification_deliveries UNION ALL SELECT status FROM notification_webhook_deliveries) jobs GROUP BY status`);
    const processing = Number(states.rows.find((row) => row.status === 'processing')?.n ?? 0);
    assert.equal(processing, 4, 'claimed total equals processing total; no omitted lease exists');
  });

  test('concurrent claims are disjoint and each respects its requested total', async () => {
    const owner = await makeUser();
    for (let i = 0; i < 6; i++) await enqueueAlert(await makeAlert(owner.id), owner.id);
    for (let i = 0; i < 6; i++) await enqueueWebhook(await makeAlert(owner.id), owner.id);
    const batches = await Promise.all([
      outbox.claimBatch(4, 'concurrent-A'),
      outbox.claimBatch(4, 'concurrent-B'),
      outbox.claimBatch(4, 'concurrent-C'),
    ]);
    assert.ok(batches.every((batch) => batch.length <= 4));
    const ids = batches.flat().map((job) => job.id);
    assert.equal(new Set(ids).size, ids.length, 'concurrent claims are disjoint');
    const processing = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM (SELECT id FROM notification_deliveries WHERE status = 'processing' UNION ALL SELECT id FROM notification_webhook_deliveries WHERE status = 'processing') jobs`);
    assert.equal(Number(processing.rows[0]!.n), ids.length, 'all processing rows were returned by a claimant');
  });

  test('a job scheduled in the future is not claimed until it is due', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);
    await pool.query(
      `UPDATE notification_deliveries SET next_attempt_at = now() + ($1 || ' hours')::interval WHERE id = $2`,
      ['1', row.id],
    );

    assert.equal((await outbox.claimBatch(10, 'worker-A')).length, 0);
    await forceDue(row.id);
    assert.equal((await outbox.claimBatch(10, 'worker-A')).length, 1);
  });
});

/* -------------------------------------------------------------------------- */
/* Worker: delivery outcomes                                                   */
/* -------------------------------------------------------------------------- */

describe('worker — delivery outcomes', () => {
  test('successful delivery marks the job delivered and records the provider receipt', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const provider = fakeProvider(async () => ({
      outcome: 'delivered',
      providerMessageId: '<abc@provider>',
      providerResponseCode: '250',
    }));
    const result = await worker(registryWith(provider)).runOnce();

    assert.deepEqual(
      { claimed: result.claimed, delivered: result.delivered, retried: result.retried, failed: result.failed },
      { claimed: 1, delivered: 1, retried: 0, failed: 0 },
    );
    const after = await getJob(row.id);
    assert.equal(after.status, 'delivered');
    assert.equal(after.attempts, 1);
    assert.equal(after.provider, 'fake');
    assert.equal(after.provider_message_id, '<abc@provider>');
    assert.equal(after.provider_response_code, '250');
    assert.equal(after.failure_category, 'none');
    assert.equal(after.last_error, null);
    assert.ok(after.delivered_at, 'delivered_at stamped');
    assert.equal(after.locked_at, null, 'lease released');
  });

  test('retryable failure schedules a retry with exponential backoff', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const provider = fakeProvider(async () => ({
      outcome: 'retryable',
      failureCategory: 'transient',
      providerResponseCode: '451',
      error: 'greylisted, try later',
    }));
    const result = await worker(registryWith(provider)).runOnce();
    assert.deepEqual(
      { claimed: result.claimed, retried: result.retried, delivered: result.delivered, failed: result.failed },
      { claimed: 1, retried: 1, delivered: 0, failed: 0 },
    );

    const after = await getJob(row.id);
    assert.equal(after.status, 'pending', 'back to pending, not processing');
    assert.equal(after.attempts, 1);
    assert.equal(after.failure_category, 'transient');
    assert.equal(after.provider_response_code, '451');
    assert.match(after.last_error ?? '', /greylisted/);
    assert.equal(after.locked_at, null);
    assert.ok(
      after.next_attempt_at.getTime() > Date.now() + 500,
      'the next attempt is scheduled in the future (backoff)',
    );
  });

  test('retries stop at maxAttempts and the job is dead-lettered, never looped', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const provider = fakeProvider(async () => ({ outcome: 'retryable', error: 'still down' }));
    const w = worker(registryWith(provider));

    // Attempt 1 → retry, attempt 2 → retry, attempt 3 → budget exhausted.
    for (let i = 0; i < TEST_POLICY.maxAttempts; i++) {
      await forceDue(row.id);
      const result = await w.runOnce();
      assert.equal(result.claimed, 1, `attempt ${i + 1} claims the job`);
    }
    const after = await getJob(row.id);
    assert.equal(after.attempts, TEST_POLICY.maxAttempts);
    assert.equal(after.status, 'failed', 'dead-lettered once the budget is gone');
    assert.equal(after.failure_category, 'transient');
    assert.equal(provider.calls.length, TEST_POLICY.maxAttempts);

    // No further attempts, ever.
    await forceDue(row.id);
    const drained = await w.runOnce();
    assert.equal(drained.claimed, 0);
    assert.equal(provider.calls.length, TEST_POLICY.maxAttempts, 'no attempt beyond the budget');
  });

  test('permanent failure dead-letters on the first attempt', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const provider = fakeProvider(async () => ({
      outcome: 'permanent',
      failureCategory: 'permanent',
      providerResponseCode: '550',
      error: 'mailbox does not exist',
    }));
    const result = await worker(registryWith(provider)).runOnce();
    assert.deepEqual(
      { delivered: result.delivered, retried: result.retried, failed: result.failed },
      { delivered: 0, retried: 0, failed: 1 },
    );

    const after = await getJob(row.id);
    assert.equal(after.status, 'failed');
    assert.equal(after.attempts, 1);
    assert.equal(after.failure_category, 'permanent');
    assert.equal(provider.calls.length, 1, 'a permanent failure is never retried');
  });

  test('an unexpected provider exception is transient and bounded', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const provider = fakeProvider(async () => {
      throw new Error('socket hang up');
    });
    const result = await worker(registryWith(provider)).runOnce();
    assert.equal(result.retried, 1);
    const after = await getJob(row.id);
    assert.equal(after.status, 'pending');
    assert.equal(after.failure_category, 'unknown');
    assert.match(after.last_error ?? '', /socket hang up/);
  });
});

/* -------------------------------------------------------------------------- */
/* Timeouts, crashes, concurrency                                              */
/* -------------------------------------------------------------------------- */

describe('worker — timeout, crash and concurrency safety', () => {
  test('a provider timeout keeps the same idempotency key and delivers exactly once', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    let attempt = 0;
    const provider = fakeProvider(async () => {
      attempt += 1;
      // The provider accepted the message but the client timed out before the
      // reply arrived — the classic duplicate-send window.
      return attempt === 1
        ? { outcome: 'timeout', error: 'ETIMEDOUT: no response within 1000ms' }
        : { outcome: 'delivered', providerMessageId: '<xyz@provider>', providerResponseCode: '250' };
    });
    const w = worker(registryWith(provider));

    const first = await w.runOnce();
    assert.deepEqual({ claimed: first.claimed, retried: first.retried }, { claimed: 1, retried: 1 });
    const timedOut = await getJob(row.id);
    assert.equal(timedOut.status, 'pending');
    assert.equal(timedOut.failure_category, 'timeout');

    await forceDue(row.id);
    const second = await w.runOnce();
    assert.deepEqual({ claimed: second.claimed, delivered: second.delivered }, { claimed: 1, delivered: 1 });

    const delivered = await getJob(row.id);
    assert.equal(delivered.status, 'delivered');
    assert.equal(provider.calls.length, 2, 'two attempts');
    // The whole point of the stable key: the retry is recognisable as the same
    // logical message, so the receiver can suppress a duplicate.
    assert.equal(provider.calls[0]?.idempotencyKey, provider.calls[1]?.idempotencyKey);
    assert.equal(provider.calls[0]?.idempotencyKey, row.idempotency_key);
    assert.equal(provider.calls[0]?.jobId, provider.calls[1]?.jobId);
  });

  test('a stalled worker is recovered; an exhausted one is dead-lettered as stale', async () => {
    const owner = await makeUser();
    const alertA = await makeAlert(owner.id);
    const alertB = await makeAlert(owner.id);
    const jobA = (await enqueueAlert(alertA, owner.id)).row;
    const jobB = (await enqueueAlert(alertB, owner.id)).row;

    const w = worker(registryWith(null));
    // Simulate a crash: both jobs were claimed, the process died mid-attempt.
    await outbox.claimBatch(10, 'crashed-worker');
    await pool.query(
      `UPDATE notification_deliveries
          SET locked_at = now() - interval '10 minutes'
        WHERE id = ANY($1::uuid[])`,
      [[jobA.id, jobB.id]],
    );

    // Short lease so the recovery is immediate, and a 1-attempt budget for B.
    await pool.query('UPDATE notification_deliveries SET max_attempts = 1, attempts = 1 WHERE id = $1', [jobB.id]);
    const recovering = new DeliveryWorker(pool, registryWith(null), { ...TEST_POLICY, leaseMs: 1_000 });
    const stale = await recovering.recoverStale();
    assert.equal(stale.recovered, 1, 'job A still has budget → re-queued');
    assert.equal(stale.deadLettered, 1, 'job B exhausted its budget → dead letter');

    assert.equal((await getJob(jobA.id)).status, 'pending');
    assert.equal((await getJob(jobA.id)).failure_category, 'stale');
    assert.equal((await getJob(jobB.id)).status, 'failed');
    assert.equal((await getJob(jobB.id)).failure_category, 'stale');

    // The recovered job is deliverable again.
    const provider = fakeProvider(async () => ({ outcome: 'delivered', providerMessageId: '<ok@provider>' }));
    const result = await worker(registryWith(provider)).runOnce();
    assert.equal(result.delivered, 1);
    assert.equal((await getJob(jobA.id)).status, 'delivered');
    assert.equal(w !== null, true);
  });

  test('two concurrent workers never deliver the same job twice', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const provider = fakeProvider(
      () =>
        new Promise<NotificationSendResult>((resolve) =>
          // Slow provider: both workers are inside their attempt at the same
          // time, so a duplicate would show up if claiming were unsafe.
          setTimeout(() => resolve({ outcome: 'delivered', providerMessageId: '<once@provider>' }), 120),
        ),
    );
    const w1 = worker(registryWith(provider));
    const w2 = worker(registryWith(provider));

    const [r1, r2] = await Promise.all([w1.runOnce(), w2.runOnce()]);
    assert.equal(r1.claimed + r2.claimed, 1, 'exactly one worker claims the job');
    assert.equal(r1.delivered + r2.delivered, 1);
    assert.equal(provider.calls.length, 1, 'the provider was called once');

    const after = await getJob(row.id);
    assert.equal(after.status, 'delivered');
    assert.equal(after.attempts, 1);
  });

  test('worker restarts are safe: re-running a finished drain changes nothing', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const provider = fakeProvider(async () => ({ outcome: 'delivered' }));
    const w = worker(registryWith(provider));
    await w.runOnce();
    const restart1 = await w.runOnce();
    const restart2 = await w.runOnce();
    assert.deepEqual(
      { claimed: restart1.claimed, delivered: restart1.delivered },
      { claimed: 0, delivered: 0 },
    );
    assert.deepEqual({ claimed: restart2.claimed }, { claimed: 0 });
    assert.equal(provider.calls.length, 1);
    assert.equal((await getJob(row.id)).status, 'delivered');
  });
});

/* -------------------------------------------------------------------------- */
/* Provider configuration states                                               */
/* -------------------------------------------------------------------------- */

describe('worker — provider availability', () => {
  test('no registered provider records "unavailable", never "delivered"', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const result = await worker(registryWith(null)).runOnce();
    assert.deepEqual(
      { claimed: result.claimed, unavailable: result.unavailable, delivered: result.delivered },
      { claimed: 1, unavailable: 1, delivered: 0 },
    );

    const after = await getJob(row.id);
    assert.equal(after.status, 'unavailable');
    assert.equal(after.failure_category, 'configuration');
    assert.equal(after.delivered_at, null);
    assert.match(after.last_error ?? '', /no notification provider/i);
  });

  test('an unconfigured (credential-less) provider records "unavailable" with the configuration category', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    const unconfigured = createSmtpEmailProvider({
      host: '',
      port: 587,
      secure: false,
      user: '',
      pass: '',
      from: '',
    });
    assert.equal(unconfigured.configured, false);

    const registry = createNotificationProviderRegistry();
    registry.register(unconfigured);
    const result = await worker(registry).runOnce();
    assert.equal(result.unavailable, 1);
    assert.equal(result.delivered, 0);

    const after = await getJob(row.id);
    assert.equal(after.status, 'unavailable');
    assert.equal(after.failure_category, 'configuration');
    assert.equal(after.provider, SMTP_PROVIDER_NAME);
  });

  test('unavailable jobs are re-queued when a configured provider appears, then delivered', async () => {
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);

    // 1. no provider: the job parks as unavailable and stays there (terminal).
    await worker(registryWith(null)).runOnce();
    assert.equal((await getJob(row.id)).status, 'unavailable');
    const parked = await worker(registryWith(null)).runOnce();
    assert.equal(parked.claimed, 0, 'an unavailable job is not retried blindly');

    // 2. credentials are configured in the environment → next run picks it up.
    const provider = fakeProvider(async () => ({ outcome: 'delivered', providerMessageId: '<late@provider>' }));
    const recovered = await worker(registryWith(provider)).runOnce();
    assert.equal(recovered.requeued, 1);
    assert.equal(recovered.delivered, 1);

    const after = await getJob(row.id);
    assert.equal(after.status, 'delivered');
    assert.equal(after.attempts, 1, 'the attempt counter reset for the real provider');
  });

  test('the SMTP provider builds no connection and reports nothing when unconfigured', async () => {
    const provider = createSmtpEmailProvider({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'apikey',
      pass: 'super-secret-value',
      from: '',
    });
    assert.equal(provider.configured, false, 'a From address is required');
    const result = await provider.send({
      jobId: 'job-1',
      idempotencyKey: 'k'.repeat(64),
      channel: 'email',
      recipient: 'trader@example.com',
      template: 'alert.email.v1',
      payload: payloadFor('11111111-1111-4111-8111-111111111111'),
      attempt: 1,
      timeoutMs: 1_000,
    });
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.failureCategory, 'configuration');
  });
});

/* -------------------------------------------------------------------------- */
/* Backoff                                                                     */
/* -------------------------------------------------------------------------- */

describe('retry backoff', () => {
  test('is exponential, capped and deterministic per job', () => {
    const policy: DeliveryRetryPolicy = {
      ...TEST_POLICY,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      jitterMs: 0,
    };
    const key = 'a'.repeat(64);
    assert.equal(backoffDelayMs({ attempts: 1, policy, idempotencyKey: key }), 1_000);
    assert.equal(backoffDelayMs({ attempts: 2, policy, idempotencyKey: key }), 2_000);
    assert.equal(backoffDelayMs({ attempts: 3, policy, idempotencyKey: key }), 4_000);
    assert.equal(backoffDelayMs({ attempts: 4, policy, idempotencyKey: key }), 8_000);
    assert.equal(backoffDelayMs({ attempts: 9, policy, idempotencyKey: key }), 8_000, 'capped');

    // Jitter is derived from the job key: stable for one job, spread across jobs.
    const jittered = { ...policy, jitterMs: 5_000 };
    const first = backoffDelayMs({ attempts: 1, policy: jittered, idempotencyKey: 'a'.repeat(64) });
    const same = backoffDelayMs({ attempts: 1, policy: jittered, idempotencyKey: 'a'.repeat(64) });
    const other = backoffDelayMs({ attempts: 1, policy: jittered, idempotencyKey: 'b'.repeat(64) });
    assert.equal(first, same, 'deterministic for a given job');
    assert.notEqual(first, other, 'different jobs spread their retries');
    assert.ok(first >= 1_000 && first < 6_000);
  });

  test('the default policy is bounded and sane', () => {
    assert.equal(DEFAULT_DELIVERY_RETRY_POLICY.maxAttempts, 5);
    assert.ok(DEFAULT_DELIVERY_RETRY_POLICY.leaseMs > DEFAULT_DELIVERY_RETRY_POLICY.timeoutMs);
    assert.ok(DEFAULT_DELIVERY_RETRY_POLICY.maxBackoffMs >= DEFAULT_DELIVERY_RETRY_POLICY.baseBackoffMs);
  });
});

/* -------------------------------------------------------------------------- */
/* Cleanup / retention                                                         */
/* -------------------------------------------------------------------------- */

describe('outbox — retention', () => {
  test('old delivered and failed rows are deleted; owed and blocked work never is', async () => {
    const owner = await makeUser();
    const jobs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const alertId = await makeAlert(owner.id);
      jobs.push((await enqueueAlert(alertId, owner.id)).row.id);
    }
    const [deliveredOld, deliveredNew, failedOld, pendingOld, unavailable] = jobs;
    assert.ok(deliveredOld && deliveredNew && failedOld && pendingOld && unavailable);

    const setStatus = (id: string, status: string, ageDays: number, column = 'updated_at') =>
      pool.query(
        `UPDATE notification_deliveries
            SET status = $2, ${column} = now() - ($3 || ' days')::interval
          WHERE id = $1`,
        [id, status, String(ageDays)],
      );

    await setStatus(deliveredOld, 'delivered', 60, 'delivered_at');
    await setStatus(deliveredNew, 'delivered', 1, 'delivered_at');
    // Dead-letter retention is anchored on created_at (updated_at is rewritten
    // by the set_updated_at() trigger on every transition).
    await setStatus(failedOld, 'failed', 200, 'created_at');
    await setStatus(pendingOld, 'pending', 90, 'created_at');
    await setStatus(unavailable, 'unavailable', 90, 'created_at');

    const deleted = await outbox.cleanup({ deliveredRetentionDays: 30, failedRetentionDays: 120 });
    assert.equal(deleted, 2, 'only the two aged-out terminal rows');

    const remaining = await pool.query<{ id: string }>(
      'SELECT id FROM notification_deliveries WHERE id = ANY($1::uuid[])',
      [jobs],
    );
    const left = new Set(remaining.rows.map((r) => r.id));
    assert.equal(left.has(deliveredOld), false);
    assert.equal(left.has(failedOld), false);
    assert.equal(left.has(deliveredNew), true, 'recent deliveries are kept');
    assert.equal(left.has(pendingOld), true, 'work that is still owed is never deleted');
    assert.equal(left.has(unavailable), true, 'blocked-on-configuration work is never deleted');
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering + secrets                                                         */
/* -------------------------------------------------------------------------- */

describe('payload rendering and secret hygiene', () => {
  test('the payload is a deterministic function of the persisted alert', () => {
    const alertId = '11111111-1111-4111-8111-111111111111';
    const payload = payloadFor(alertId);
    const again = payloadFor(alertId);
    assert.equal(notificationPayloadHash(payload), notificationPayloadHash(again));
    assert.equal(JSON.stringify(payload), JSON.stringify(again));

    // Different alert ⇒ different idempotency key and hash.
    const other = payloadFor('99999999-9999-4999-8999-999999999999');
    assert.notEqual(notificationPayloadHash(payload), notificationPayloadHash(other));
    assert.notEqual(
      notificationIdempotencyKey({ template: payload.template, channel: 'email', alertId }),
      notificationIdempotencyKey({
        template: payload.template,
        channel: 'email',
        alertId: '99999999-9999-4999-8999-999999999999',
      }),
    );
  });

  test('the rendered message names instrument, timeframe, direction, levels, score and id', () => {
    const alertId = '11111111-1111-4111-8111-111111111111';
    const { subject, text, data } = payloadFor(alertId);
    assert.match(subject, /EURUSD/);
    assert.match(subject, /long/);
    assert.match(text, new RegExp(alertId));
    assert.match(text, /EURUSD \(forex\)/);
    assert.match(text, /Timeframe\s+1h/);
    assert.match(text, /Strategy version #2/, 'labels are space-padded');
    assert.doesNotMatch(subject, /[^\x20-\x7E]/, 'the subject stays ASCII');
    assert.match(text, /Direction\s+long/);
    assert.match(text, /Quality\s+80\/100 \(grade B\)/);
    assert.match(text, /Entry\s+1\.10500/);
    assert.match(text, /Stop loss\s+1\.10000/);
    assert.match(text, /Take profit 3\s+1\.12000/);
    assert.equal(data.qualityScore, 80);
    assert.equal(data.minQualityScore, 65);
    assert.equal(data.triggerState, 'confirmed');
    // No internal implementation details leak into a notification.
    assert.doesNotMatch(text, /password|secret|smtp|token/i);
  });

  test('a missing level is rendered as an em dash, never as a fabricated number', () => {
    const payload = renderAlertNotification({
      alertId: '11111111-1111-4111-8111-111111111111',
      setupId: '33333333-3333-4333-8333-333333333333',
      strategyId: '44444444-4444-4444-8444-444444444444',
      strategyVersionId: '55555555-5555-4555-8555-555555555555',
      versionNumber: 1,
      direction: 'short',
      triggerState: 'triggered',
      qualityScore: 70,
      minQualityScore: 0,
      createdAt: new Date(1_800_000_000_000).toISOString(),
      body: {
        setupId: '33333333-3333-4333-8333-333333333333',
        strategyId: '44444444-4444-4444-8444-444444444444',
        strategyVersionId: '55555555-5555-4555-8555-555555555555',
        versionNumber: 1,
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'short',
        triggerState: 'triggered',
        qualityScore: 70,
        qualityGrade: 'C',
        minQualityScore: 0,
        entryPrice: null,
        stopLossPrice: null,
        tp1Price: null,
        tp2Price: null,
        tp3Price: null,
        detectedAt: new Date(1_799_900_000_000).toISOString(),
      },
      symbol: 'EURUSD',
      assetClass: 'forex',
      timeframe: null,
    });
    assert.match(payload.text, /Entry\s+—/);
    assert.match(payload.text, /Timeframe\s+not set/);
    assert.equal(payload.data.entryPrice, null);
  });

  test('a legacy or partial alert body still renders — delivery never breaks generation', () => {
    // The alert repair path can meet an old row whose body has no structured
    // fields at all (M6 tolerated it for the stub ledger). Rendering must
    // degrade to nulls, never throw: an alert must not become undeliverable.
    const payload = renderAlertNotification({
      alertId: '11111111-1111-4111-8111-111111111111',
      setupId: '33333333-3333-4333-8333-333333333333',
      strategyId: '44444444-4444-4444-8444-444444444444',
      strategyVersionId: '55555555-5555-4555-8555-555555555555',
      versionNumber: 1,
      direction: 'long',
      triggerState: 'confirmed',
      qualityScore: 80,
      minQualityScore: 65,
      createdAt: new Date(1_800_000_000_000).toISOString(),
      body: { legacy: true },
      symbol: 'EURUSD',
      assetClass: 'forex',
      timeframe: null,
    });
    assert.equal(payload.data.alertId, '11111111-1111-4111-8111-111111111111');
    assert.equal(payload.data.setupId, '33333333-3333-4333-8333-333333333333');
    assert.equal(payload.data.direction, 'long');
    assert.equal(payload.data.qualityScore, 80);
    assert.equal(payload.data.entryPrice, null);
    assert.equal(payload.data.qualityGrade, 'n/a');
    assert.equal(payload.data.timeframe, null);
    assert.match(payload.text, /Alert ID/);
    // Identity still comes from the row, not from the body.
    assert.equal(payload.data.instrument.symbol, 'EURUSD');
  });

  test('provider credentials never reach a row, a description or an error string', async () => {
    const PASSWORD = 'smtp-password-DO-NOT-LEAK';
    const provider = createSmtpEmailProvider({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'api-key-user',
      pass: PASSWORD,
      from: 'VeltrixEye Alerts <alerts@example.com>',
    });
    assert.equal(provider.configured, true);

    // 1. the operator-safe description
    const described = JSON.stringify(provider.describe());
    assert.equal(described.includes(PASSWORD), false, 'describe() never contains the password');
    assert.equal(JSON.stringify(provider).includes(PASSWORD), false);

    // 2. an adapter-side redaction: the adapter knows the credential and
    //    scrubs its own error before it ever reaches the worker.
    const classified = classifySmtpError(
      Object.assign(new Error(`535 auth failed with pass ${PASSWORD}`), { code: 'EAUTH' }),
      [PASSWORD],
    );
    assert.equal(classified.error.includes(PASSWORD), false, 'the adapter redacts its own secret');
    assert.match(classified.error, /\[redacted\]/);
    assert.equal(classified.outcome, 'unavailable');

    // 3. worker-side defence in depth: the deployment hands the worker a
    //    scrubber, so even a leaky provider message cannot reach the row.
    const owner = await makeUser();
    const alertId = await makeAlert(owner.id);
    const { row } = await enqueueAlert(alertId, owner.id);
    const leaky = fakeProvider(async () => ({
      outcome: 'retryable',
      error: `upstream said: bad credentials ${PASSWORD}`,
    }));
    const guarded = new DeliveryWorker(pool, registryWith(leaky), TEST_POLICY, {
      redact: (text: string) => redactSecrets(text, [PASSWORD]),
    });
    await guarded.runOnce();
    const stored = await getJob(row.id);
    assert.equal(stored.last_error?.includes(PASSWORD), false, 'the row never stores the credential');
    assert.match(stored.last_error ?? '', /\[redacted\]/);
  });

  test('redactSecrets only masks real secrets and leaves ordinary text alone', () => {
    assert.equal(redactSecrets('connection refused for smtp.example.com', ['secret-value']), 'connection refused for smtp.example.com');
    assert.equal(redactSecrets('failed with secret-value here', ['secret-value']), 'failed with [redacted] here');
    assert.equal(redactSecrets('short ab value', ['ab']), 'short ab value', '<=3 char values are ignored');
  });
});
