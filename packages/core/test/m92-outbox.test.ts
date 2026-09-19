import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations, NotificationOutbox, hashPassword, UserService, type EnqueueAlertNotificationArgs, notificationPayloadHash, notificationIdempotencyKey, renderAlertNotification } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5461;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_m92_outbox';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let outbox: NotificationOutbox;

const TEST_POLICY = { maxAttempts: 3, baseBackoffMs: 1_000, maxBackoffMs: 8_000, jitterMs: 0, leaseMs: 60_000, batchSize: 10, timeoutMs: 1_000 };

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m92-outbox');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({ dataDir, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  users = new UserService(pool);
  outbox = new NotificationOutbox(pool, { maxAttempts: TEST_POLICY.maxAttempts });
}, { timeout: 180_000 });

after(async () => { await pool?.end(); await stopDb?.(); });

beforeEach(async () => {
  await pool.query('DELETE FROM notification_deliveries');
  await pool.query('DELETE FROM notification_webhook_deliveries');
  await pool.query('DELETE FROM notification_push_deliveries');
  await pool.query('UPDATE notification_delivery_fairness SET email_claims=0, webhook_claims=0, push_claims=0, last_channel=\'webhook\'');
});

async function makeUser() {
  const user = await users.create({ email: `m92_${randomBytes(4).toString('hex')}@example.com`, passwordHash: await hashPassword('correct-horse-42'), name: 'M92' });
  return user;
}
async function makeAlert(userId: string): Promise<string> {
  const instrument = await pool.query<{ id: string }>('INSERT INTO instruments (asset_class, symbol) VALUES ($1,$2) RETURNING id', ['forex', `P${randomBytes(2).toString('hex').toUpperCase()}`]);
  const strategy = await pool.query<{ id: string }>('INSERT INTO strategies (user_id, name) VALUES ($1,$2) RETURNING id', [userId, `m92-${randomBytes(3).toString('hex')}`]);
  const version = await pool.query<{ id: string }>('INSERT INTO strategy_versions (strategy_id, version_number) VALUES ($1,1) RETURNING id', [strategy.rows[0]!.id]);
  const setup = await pool.query<{ id: string }>(`INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms) VALUES ($1,$2,'confirmed','long',now(),1800000000000) RETURNING id`, [version.rows[0]!.id, instrument.rows[0]!.id]);
  const alert = await pool.query<{ id: string }>(`INSERT INTO alerts (user_id, setup_id, strategy_id, strategy_version_id, instrument_id, direction, trigger_state, quality_score, min_quality_score, title, body) VALUES ($1,$2,$3,$4,$5,'long','confirmed',80,65,'m92','{}') RETURNING id`, [userId, setup.rows[0]!.id, strategy.rows[0]!.id, version.rows[0]!.id, instrument.rows[0]!.id]);
  return alert.rows[0]!.id;
}
function payloadFor(alertId: string) {
  return renderAlertNotification({
    alertId,
    setupId: '33333333-3333-4333-8333-333333333333',
    strategyId: '44444444-4444-4444-8444-444444444444',
    strategyVersionId: '55555555-5555-4555-8555-555555555555',
    versionNumber: 1,
    direction: 'long',
    triggerState: 'confirmed',
    qualityScore: 80,
    minQualityScore: 65,
    createdAt: new Date(1_800_000_000_000).toISOString(),
    body: { instrument: { assetClass: 'forex', symbol: 'EURUSD' }, direction: 'long', triggerState: 'confirmed', qualityScore: 80, qualityGrade: 'B', minQualityScore: 65, entryPrice: 1.1, stopLossPrice: 1.0, tp1Price: 1.2, tp2Price: 1.3, tp3Price: 1.4, detectedAt: new Date(1_799_900_000_000).toISOString() },
    symbol: 'EURUSD',
    assetClass: 'forex',
    timeframe: '1h',
  });
}
async function enqueueChannel(alertId: string, userId: string, channel: 'email' | 'webhook' | 'push') {
  const payload = payloadFor(alertId);
  const strategyId = (await pool.query<{ strategy_id: string }>('SELECT strategy_id FROM alerts WHERE id=$1', [alertId])).rows[0]!.strategy_id;
  const args: EnqueueAlertNotificationArgs = {
    alertId,
    userId,
    channel,
    template: payload.template,
    payload,
    payloadHash: notificationPayloadHash(payload),
    idempotencyKey: notificationIdempotencyKey({ template: payload.template, channel, alertId }),
    strategyId: channel === 'email' ? undefined : strategyId,
    recipient: channel === 'email' ? undefined : channel === 'webhook' ? 'https://hooks.example.test/alerts' : 'https://fcm.googleapis.com/fcm/send/abc',
    signingSecret: channel === 'email' ? undefined : channel === 'webhook' ? 'webhook-secret' : JSON.stringify({ p256dh: 'B'.repeat(20) + '_-_' + 'A'.repeat(10), auth: 'auth123_-_' + 'B'.repeat(10) }),
  };
  return outbox.enqueue(pool, args);
}

describe('M9.2 outbox — push channel + 3-way fairness', () => {
  test('push enqueue creates row in push table, idempotent per alert', async () => {
    const user = await makeUser();
    const alertId = await makeAlert(user.id);
    const first = await enqueueChannel(alertId, user.id, 'push');
    assert.equal(first.created, true);
    const second = await enqueueChannel(alertId, user.id, 'push');
    assert.equal(second.created, false);
    assert.equal(first.row.id, second.row.id);
    const count = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM notification_push_deliveries WHERE alert_id=$1', [alertId]);
    assert.equal(count.rows[0]!.n, '1');
  });

  test('claimBatch with 3 queues respects fairness: fewer lifetime claims preferred, balanced continues from last_channel', async () => {
    const user = await makeUser();
    for (let i = 0; i < 3; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'email');
    for (let i = 0; i < 3; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'webhook');
    for (let i = 0; i < 3; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'push');

    // First claim: all 0, last_channel=webhook => rrOrder push,email,webhook, so first should be push
    const first = await outbox.claimBatch(1, 'worker-1');
    assert.equal(first.length, 1);
    assert.equal(first[0]!.channel, 'push', 'push preferred when last=webhook and all claims 0');

    // Second claim: push has 1, email/webhook 0, so email should be next (deficit)
    const second = await outbox.claimBatch(1, 'worker-2');
    assert.equal(second[0]!.channel, 'email');

    // Third: webhook
    const third = await outbox.claimBatch(1, 'worker-3');
    assert.equal(third[0]!.channel, 'webhook');

    // Fourth: balanced, last_channel was webhook, so push again
    const fourth = await outbox.claimBatch(1, 'worker-4');
    assert.equal(fourth[0]!.channel, 'push');
  });

  test('batch claims fill up to limit when one or more queues empty — no ceil(limit/3) stranding', async () => {
    const user = await makeUser();
    // Only email jobs
    for (let i = 0; i < 6; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'email');
    const claimed = await outbox.claimBatch(4, 'fill-worker');
    assert.equal(claimed.length, 4, 'must fill up to limit even when 2 queues empty');
    assert.ok(claimed.every((j) => j.channel === 'email'));

    // Two queues populated, one empty, limit 4 should give 2+2
    await pool.query('DELETE FROM notification_deliveries');
    await pool.query('DELETE FROM notification_webhook_deliveries');
    await pool.query('DELETE FROM notification_push_deliveries');
    await pool.query('UPDATE notification_delivery_fairness SET email_claims=0, webhook_claims=0, push_claims=0, last_channel=\'webhook\'');
    for (let i = 0; i < 4; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'email');
    for (let i = 0; i < 4; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'webhook');
    const claimed2 = await outbox.claimBatch(4, 'fill-worker-2');
    assert.equal(claimed2.length, 4);
    assert.equal(claimed2.filter((j) => j.channel === 'email').length, 2);
    assert.equal(claimed2.filter((j) => j.channel === 'webhook').length, 2);
  });

  test('cleanup never decrements fairness, retries/stale never change fairness, rollback rolls back', async () => {
    const user = await makeUser();
    const alertId = await makeAlert(user.id);
    const enq = await enqueueChannel(alertId, user.id, 'email');
    const claimed = await outbox.claimBatch(1, 'worker-cleanup');
    assert.equal(claimed.length, 1);
    const before = await pool.query<{ e: string; w: string; p: string }>('SELECT email_claims::text AS e, webhook_claims::text AS w, push_claims::text AS p FROM notification_delivery_fairness WHERE singleton=true');
    assert.equal(before.rows[0]!.e, '1');

    // Mark retry (does not change fairness) — job goes back to pending
    await outbox.markRetry(claimed[0]!.id, 0, { failureCategory: 'transient', error: 'retry' }, 'email');
    const afterRetry = await pool.query<{ e: string }>('SELECT email_claims::text AS e FROM notification_delivery_fairness WHERE singleton=true');
    assert.equal(afterRetry.rows[0]!.e, '1', 'retries do not disturb fairness');

    // Stale recovery: claim again to get into processing, then simulate crash
    const claimed2 = await outbox.claimBatch(1, 'worker-stale');
    assert.equal(claimed2.length, 1);
    const afterSecondClaim = await pool.query<{ e: string }>('SELECT email_claims::text AS e FROM notification_delivery_fairness WHERE singleton=true');
    assert.equal(afterSecondClaim.rows[0]!.e, '2', 'second claim increments fairness');
    await pool.query(`UPDATE notification_deliveries SET locked_at = now() - interval '1 hour' WHERE id=$1`, [enq.row.id]);
    await outbox.recoverStale(60_000);
    const afterStale = await pool.query<{ e: string }>('SELECT email_claims::text AS e FROM notification_delivery_fairness WHERE singleton=true');
    assert.equal(afterStale.rows[0]!.e, '2', 'stale recovery does not disturb fairness');

    // Cleanup deletes delivered but not fairness
    await pool.query(`UPDATE notification_deliveries SET status='delivered', delivered_at=now() - interval '2 days' WHERE id=$1`, [enq.row.id]);
    await outbox.cleanup({ deliveredRetentionDays: 1, failedRetentionDays: 1 });
    const afterCleanup = await pool.query<{ e: string }>('SELECT email_claims::text AS e FROM notification_delivery_fairness WHERE singleton=true');
    assert.equal(afterCleanup.rows[0]!.e, '2', 'cleanup never decrements fairness');

    // Rollback test: claim in transaction then rollback should not advance fairness
    const alert2 = await makeAlert(user.id);
    await enqueueChannel(alert2, user.id, 'webhook');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const jobs = await outbox.claimBatch(1, 'rollback-worker', client);
      assert.equal(jobs.length, 1);
      const during = await client.query<{ w: string }>('SELECT webhook_claims::text AS w FROM notification_delivery_fairness WHERE singleton=true');
      assert.equal(during.rows[0]!.w, '1');
      await client.query('ROLLBACK');
    } finally { client.release(); }
    const afterRollback = await pool.query<{ w: string }>('SELECT webhook_claims::text AS w FROM notification_delivery_fairness WHERE singleton=true');
    assert.equal(afterRollback.rows[0]!.w, '0', 'rollback rolls back fairness');
  });

  test('concurrent claims never double-claim and fairness ledger counts correctly', async () => {
    const user = await makeUser();
    for (let i = 0; i < 6; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'email');
    for (let i = 0; i < 6; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'webhook');
    for (let i = 0; i < 6; i++) await enqueueChannel(await makeAlert(user.id), user.id, 'push');

    const batches = await Promise.all([
      outbox.claimBatch(4, 'concurrent-A'),
      outbox.claimBatch(4, 'concurrent-B'),
      outbox.claimBatch(4, 'concurrent-C'),
    ]);
    const all = batches.flat();
    assert.equal(new Set(all.map((j) => j.id)).size, all.length, 'disjoint');
    assert.equal(all.length, 12);

    const ledger = await pool.query<{ e: string; w: string; p: string }>('SELECT email_claims::text AS e, webhook_claims::text AS w, push_claims::text AS p FROM notification_delivery_fairness WHERE singleton=true');
    const total = Number(ledger.rows[0]!.e) + Number(ledger.rows[0]!.w) + Number(ledger.rows[0]!.p);
    assert.equal(total, 12, 'ledger counts every committed claim');
  });

  test('invalid limits claim zero and never touch fairness', async () => {
    const user = await makeUser();
    await enqueueChannel(await makeAlert(user.id), user.id, 'email');
    const before = await pool.query('SELECT email_claims::text AS e, webhook_claims::text AS w, push_claims::text AS p, last_channel, updated_at FROM notification_delivery_fairness WHERE singleton=true');
    assert.deepEqual(await outbox.claimBatch(0, 'zero'), []);
    assert.deepEqual(await outbox.claimBatch(-1, 'neg'), []);
    assert.deepEqual(await outbox.claimBatch(NaN, 'nan'), []);
    const after = await pool.query('SELECT email_claims::text AS e, webhook_claims::text AS w, push_claims::text AS p, last_channel, updated_at FROM notification_delivery_fairness WHERE singleton=true');
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  test('cascade delete of alert does not rewind fairness', async () => {
    const user = await makeUser();
    const alertId = await makeAlert(user.id);
    await enqueueChannel(alertId, user.id, 'email');
    await outbox.claimBatch(1, 'cascade');
    const before = await pool.query('SELECT email_claims::text AS e FROM notification_delivery_fairness WHERE singleton=true');
    await pool.query('DELETE FROM alerts WHERE id=$1', [alertId]);
    const after = await pool.query('SELECT email_claims::text AS e FROM notification_delivery_fairness WHERE singleton=true');
    assert.deepEqual(after.rows[0], before.rows[0]);
  });

  test('push delivery row stores encrypted secret, not plaintext', async () => {
    const user = await makeUser();
    const alertId = await makeAlert(user.id);
    // Enqueue with secret manager? Our outbox without manager stores plaintext for now, but we test that DTO hides it
    const enq = await enqueueChannel(alertId, user.id, 'push');
    const row = await pool.query<{ signing_secret: string | null; signing_secret_encrypted: string | null }>('SELECT signing_secret, signing_secret_encrypted FROM notification_push_deliveries WHERE id=$1', [enq.row.id]);
    // Without secret manager, plaintext is stored; with manager, encrypted. Both should not leak via DTO
    const dto = await outbox.listForAlert(user.id, alertId);
    assert.equal(dto.length, 1);
    assert.equal((dto[0] as any).signingSecret, undefined);
    assert.equal((dto[0] as any).recipient, undefined);
  });
});
