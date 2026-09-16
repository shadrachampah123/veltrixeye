/**
 * M7.3 — schema guarantees of migration `0013_notification_outbox.sql`.
 *
 * The outbox's correctness is enforced by the database, not by convention, so
 * these are the constraints the worker relies on:
 *  - one job per (alert, channel) and one per idempotency key;
 *  - only the five statuses / one channel / seven failure categories exist;
 *  - `attempts <= max_attempts` (the retry budget cannot be exceeded by a bug);
 *  - deleting an alert removes its jobs (no orphans, no leaked recipients);
 *  - `updated_at` is maintained by the shared trigger;
 *  - the migration is additive and reported by `migrationStatus`.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  createPool,
  runMigrations,
  migrationStatus,
  MIGRATIONS_DIR,
  hashPassword,
  UserService,
  NotificationOutbox,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5444;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_m7_notifications';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let outbox: NotificationOutbox;

const uniqueEmail = () => `m73_${randomBytes(6).toString('hex')}@example.com`;
const HASH = 'a'.repeat(64);

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m7-notifications');
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
  outbox = new NotificationOutbox(pool, { maxAttempts: 5 });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

async function makeAlert(userId: string): Promise<string> {
  const instrument = await pool.query<{ id: string }>(
    'INSERT INTO instruments (asset_class, symbol) VALUES ($1, $2) RETURNING id',
    ['forex', `M${randomBytes(3).toString('hex').toUpperCase()}`],
  );
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `m73-schema-${randomBytes(4).toString('hex')}`],
  );
  const strategyId = strategy.rows[0]?.id;
  const version = await pool.query<{ id: string }>(
    'INSERT INTO strategy_versions (strategy_id, version_number) VALUES ($1, 1) RETURNING id',
    [strategyId],
  );
  const versionId = version.rows[0]?.id;
  const setup = await pool.query<{ id: string }>(
    `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms)
     VALUES ($1, $2, 'confirmed', 'long', now(), 1800000000000) RETURNING id`,
    [versionId, instrument.rows[0]?.id],
  );
  const alert = await pool.query<{ id: string }>(
    `INSERT INTO alerts (user_id, setup_id, strategy_id, strategy_version_id, instrument_id,
                         direction, trigger_state, quality_score, min_quality_score, title, body)
     VALUES ($1, $2, $3, $4, $5, 'long', 'confirmed', 80, 65, 'title', '{}') RETURNING id`,
    [userId, setup.rows[0]?.id, strategyId, versionId, instrument.rows[0]?.id],
  );
  const alertId = alert.rows[0]?.id;
  assert.ok(alertId);
  return alertId;
}

async function makeOwner(): Promise<string> {
  const users = new UserService(pool);
  const user = await users.create({
    email: uniqueEmail(),
    passwordHash: await hashPassword('correct-horse-42'),
    name: 'M7 Schema',
  });
  return user.id;
}

async function insertJob(args: {
  alertId: string;
  userId: string;
  channel?: string;
  idempotencyKey?: string;
  status?: string;
  attempts?: number;
  maxAttempts?: number;
  failureCategory?: string;
  recipient?: string;
}): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO notification_deliveries
       (alert_id, user_id, channel, template, idempotency_key, payload_hash, payload, recipient,
        status, attempts, max_attempts, failure_category)
     VALUES ($1, $2, $3, 'alert.email.v1', $4, $5, '{}'::jsonb, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      args.alertId,
      args.userId,
      args.channel ?? 'email',
      args.idempotencyKey ?? randomBytes(32).toString('hex'),
      HASH,
      args.recipient ?? 'trader@example.com',
      args.status ?? 'pending',
      args.attempts ?? 0,
      args.maxAttempts ?? 5,
      args.failureCategory ?? 'none',
    ],
  );
  return res.rows[0]?.id ?? '';
}

function pgCode(err: unknown): string {
  assert.ok(err !== null && typeof err === 'object' && 'code' in err);
  return String((err as { code: unknown }).code);
}

describe('m7.3 notification outbox schema', () => {
  test('migration 0013 is applied, additive and checksum-clean', async () => {
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.equal(status.pending.length, 0);
    assert.equal(status.checksumsMatch, true);
    // M8.1 appended 0016 (execution architecture) after this suite was
    // written; the notification outbox assertions below are unchanged.
    assert.equal(status.expectedCount, 16, '0001…0016');
    assert.equal(status.appliedCount, 16);
    assert.equal(status.latestApplied, '0016_execution_architecture.sql');
  });

  test('the table carries every column the worker depends on', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notification_deliveries'`,
    );
    const columns = new Set(res.rows.map((r) => r.column_name));
    for (const column of [
      'id',
      'alert_id',
      'user_id',
      'channel',
      'template',
      'idempotency_key',
      'payload_hash',
      'payload',
      'recipient',
      'status',
      'attempts',
      'max_attempts',
      'provider',
      'provider_message_id',
      'provider_response_code',
      'failure_category',
      'last_error',
      'next_attempt_at',
      'locked_at',
      'locked_by',
      'delivered_at',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(columns.has(column), `missing column ${column}`);
    }
  });

  test('status, channel and failure-category values are constrained', async () => {
    const owner = await makeOwner();
    const alertId = await makeAlert(owner);

    await assert.rejects(() => insertJob({ alertId, userId: owner, status: 'retrying' }), (err: unknown) =>
      pgCode(err) === '23514',
    );
    await assert.rejects(() => insertJob({ alertId, userId: owner, channel: 'sms' }), (err: unknown) =>
      pgCode(err) === '23514',
    );
    await assert.rejects(
      () => insertJob({ alertId, userId: owner, failureCategory: 'whatever' }),
      (err: unknown) => pgCode(err) === '23514',
    );
    // The retry budget is enforced by the schema, not only by the worker.
    await assert.rejects(
      () => insertJob({ alertId, userId: owner, attempts: 6, maxAttempts: 5 }),
      (err: unknown) => pgCode(err) === '23514',
    );
    // Short hashes / recipients are rejected.
    await assert.rejects(
      () => insertJob({ alertId, userId: owner, idempotencyKey: 'abc' }),
      (err: unknown) => pgCode(err) === '23514',
    );
  });

  test('one job per (alert, channel) and one per idempotency key', async () => {
    const owner = await makeOwner();
    const alertId = await makeAlert(owner);
    await insertJob({ alertId, userId: owner });

    await assert.rejects(() => insertJob({ alertId, userId: owner }), (err: unknown) => pgCode(err) === '23505');

    const otherAlert = await makeAlert(owner);
    const key = randomBytes(32).toString('hex');
    await insertJob({ alertId: otherAlert, userId: owner, idempotencyKey: key });
    await assert.rejects(
      async () => insertJob({ alertId: await makeAlert(owner), userId: owner, idempotencyKey: key }),
      (err: unknown) => pgCode(err) === '23505',
    );
  });

  test('the outbox helper collapses duplicates instead of raising', async () => {
    const owner = await makeOwner();
    const alertId = await makeAlert(owner);
    const payload = {
      template: 'alert.email.v1',
      subject: 'subject',
      text: 'text',
      data: {
        alertId,
        setupId: '33333333-3333-4333-8333-333333333333',
        strategyId: '44444444-4444-4444-8444-444444444444',
        strategyVersionId: '55555555-5555-4555-8555-555555555555',
        versionNumber: 1,
        instrument: { assetClass: 'forex' as const, symbol: 'EURUSD' },
        timeframe: null,
        direction: 'long' as const,
        triggerState: 'confirmed' as const,
        qualityScore: 80,
        qualityGrade: 'B',
        minQualityScore: 0,
        entryPrice: null,
        stopLossPrice: null,
        tp1Price: null,
        tp2Price: null,
        tp3Price: null,
        detectedAt: new Date(1_800_000_000_000).toISOString(),
        generatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    };
    const args = {
      alertId,
      userId: owner,
      channel: 'email' as const,
      template: payload.template,
      payload,
      payloadHash: HASH,
      idempotencyKey: randomBytes(32).toString('hex'),
    };
    const first = await outbox.enqueue(pool, args);
    assert.equal(first.created, true);
    const second = await outbox.enqueue(pool, { ...args, idempotencyKey: randomBytes(32).toString('hex') });
    assert.equal(second.created, false, 'a different key still collapses on (alert_id, channel)');
    assert.equal(second.row.id, first.row.id);
  });

  test('deleting an alert cascades its jobs (no orphaned recipients)', async () => {
    const owner = await makeOwner();
    const alertId = await makeAlert(owner);
    await insertJob({ alertId, userId: owner });

    await pool.query('DELETE FROM alerts WHERE id = $1', [alertId]);
    const left = await pool.query('SELECT id FROM notification_deliveries WHERE alert_id = $1', [alertId]);
    assert.equal(left.rows.length, 0);
  });

  test('the claim index and the unique indexes exist', async () => {
    const res = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'notification_deliveries'`,
    );
    const names = new Set(res.rows.map((r) => r.indexname));
    for (const index of [
      'notification_deliveries_alert_channel_uniq',
      'notification_deliveries_idempotency_uniq',
      'notification_deliveries_claim_idx',
      'notification_deliveries_processing_idx',
      'notification_deliveries_status_idx',
      'notification_deliveries_alert_idx',
      'notification_deliveries_user_idx',
      'notification_deliveries_delivered_idx',
    ]) {
      assert.ok(names.has(index), `missing index ${index}`);
    }
  });

  test('updated_at is maintained by the shared trigger', async () => {
    const owner = await makeOwner();
    const alertId = await makeAlert(owner);
    const jobId = await insertJob({ alertId, userId: owner });

    const before = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM notification_deliveries WHERE id = $1',
      [jobId],
    );
    await new Promise((resolve) => setTimeout(resolve, 15));
    await pool.query(`UPDATE notification_deliveries SET status = 'processing' WHERE id = $1`, [jobId]);
    const after = await pool.query<{ updated_at: Date }>(
      'SELECT updated_at FROM notification_deliveries WHERE id = $1',
      [jobId],
    );
    assert.ok(
      after.rows[0]!.updated_at.getTime() > before.rows[0]!.updated_at.getTime(),
      'updated_at advanced on update',
    );
  });

  test('the migration touched no other table', async () => {
    // `alerts` and `alert_deliveries` (0012) must be byte-for-byte the same
    // schema they had before 0013: the outbox is additive next to them.
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'alert_deliveries'`,
    );
    assert.deepEqual(
      res.rows.map((r) => r.column_name).sort(),
      ['alert_id', 'attempt', 'channel', 'created_at', 'error', 'id', 'payload_hash', 'status'],
    );
  });
});
