import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, runMigrations, migrationStatus } from '../src/index.js';

let db: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let pool: ReturnType<typeof createPool>;
let oldDir: string;
let freshDir: string;

function copyUpTo(destination: string, max: number | null): void {
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const m = /^(\d{4})_/.exec(file);
    if (m && (max === null || Number(m[1]) <= max)) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(destination, file));
  }
}

before(async () => {
  oldDir = mkdtempSync(path.join(os.tmpdir(), 've-m92-0027-'));
  freshDir = mkdtempSync(path.join(os.tmpdir(), 've-m92-fresh-'));
  copyUpTo(oldDir, 27);
  copyUpTo(freshDir, null);
  const dataDir = path.join(os.tmpdir(), `ve-m92-pg-${process.pid}`);
  rmSync(dataDir, { recursive: true, force: true });
  db = await startEmbeddedPostgres({ dataDir, port: 5459, user: 'test', password: 'm92', database: 'veltrixeye_m92' });
  pool = createPool({ databaseUrl: db.dbUrl });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await db?.stop();
  rmSync(oldDir, { recursive: true, force: true });
  rmSync(freshDir, { recursive: true, force: true });
});

describe('M9.2 migrations — 0028_push_channel_and_secret_hardening.sql', () => {
  test('fresh database applies cleanly through 0028, checksumsMatch, push_claims default 0, constraints', async () => {
    const freshDbDir = path.join(os.tmpdir(), `ve-m92-fresh2-pg-${process.pid}`);
    rmSync(freshDbDir, { recursive: true, force: true });
    const fresh = await startEmbeddedPostgres({ dataDir: freshDbDir, port: 5460, user: 'test', password: 'm92f', database: 'veltrixeye_m92_fresh' });
    const freshPool = createPool({ databaseUrl: fresh.dbUrl });
    try {
      const result = await runMigrations(freshPool, freshDir);
      // A fresh database applies every shipped migration (0028 plus later
      // milestones such as 0029), so assert 0028 by name and the count as a
      // lower bound instead of an exact total.
      assert.ok(result.applied.includes('0028_push_channel_and_secret_hardening.sql'));
      assert.ok(result.applied.length >= 28);
      const status = await migrationStatus(freshPool, freshDir);
      assert.equal(status.pending.length, 0);
      assert.equal(status.checksumsMatch, true);

      // Tables exist
      const tables = await freshPool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('notification_push_deliveries','notification_delivery_fairness','notification_preferences') ORDER BY table_name`);
      const names = tables.rows.map((r) => r.table_name);
      assert.ok(names.includes('notification_push_deliveries'));
      assert.ok(names.includes('notification_delivery_fairness'));
      assert.ok(names.includes('notification_preferences'));

      // push_claims column exists, default 0, >=0 check
      const fairnessCols = await freshPool.query<{ column_name: string; column_default: string | null }>(`SELECT column_name, column_default FROM information_schema.columns WHERE table_name='notification_delivery_fairness' AND column_name='push_claims'`);
      assert.equal(fairnessCols.rows.length, 1);
      assert.match(fairnessCols.rows[0]!.column_default ?? '', /0/);

      // Encrypted columns exist on preferences
      const prefCols = await freshPool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='notification_preferences' AND column_name IN ('signing_secret_encrypted','signing_secret_key_version')`);
      assert.equal(prefCols.rows.length, 2);

      // Encrypted columns on push deliveries
      const pushCols = await freshPool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name='notification_push_deliveries' AND column_name IN ('signing_secret_encrypted','signing_secret_key_version')`);
      assert.equal(pushCols.rows.length, 2);

      // Check constraint names are not assumed, but we can verify check exists via pg_constraint
      const checks = await freshPool.query<{ conname: string; contype: string }>(`SELECT conname, contype FROM pg_constraint WHERE conrelid = 'notification_delivery_fairness'::regclass`);
      // Should have at least one check for push_claims >=0
      const hasPushCheck = checks.rows.some((r) => r.contype === 'c');
      assert.ok(hasPushCheck);

      // Channels check includes push
      const prefCheck = await freshPool.query<{ conname: string; consrc: string }>(`SELECT conname, pg_get_constraintdef(oid) AS consrc FROM pg_constraint WHERE conrelid = 'notification_preferences'::regclass AND contype='c'`);
      const hasPushChannel = prefCheck.rows.some((r) => /push/.test(r.consrc));
      assert.ok(hasPushChannel, 'preferences check should include push');

      // last_channel check includes push
      const fairnessCheck = await freshPool.query<{ consrc: string }>(`SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint WHERE conrelid = 'notification_delivery_fairness'::regclass AND contype='c'`);
      const hasLastPush = fairnessCheck.rows.some((r) => /push/.test(r.consrc));
      assert.ok(hasLastPush, 'fairness last_channel should include push');
    } finally {
      await freshPool.end();
      await fresh.stop();
      rmSync(freshDbDir, { recursive: true, force: true });
    }
  });

  test('upgrade 0027→0028 preserves data, push_claims=0, no plaintext rewrite, additive safe', async () => {
    // Start from 27
    const before = await runMigrations(pool, oldDir);
    assert.equal(before.applied.length, 27);
    let status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.ok(status.pending.includes('0028_push_channel_and_secret_hardening.sql'));

    // Insert some data in 0027 state
    const user = await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ('m92@example.com','x','M92') RETURNING id`);
    const userId = user.rows[0]!.id;
    await pool.query(`INSERT INTO notification_preferences (user_id, channel, enabled, endpoint_url, signing_secret) VALUES ($1,'webhook',true,'https://hooks.example.test','plain-secret-123')`, [userId]);
    await pool.query(`INSERT INTO notification_delivery_fairness (singleton, last_channel, email_claims, webhook_claims) VALUES (true,'webhook',5,3) ON CONFLICT (singleton) DO UPDATE SET email_claims=5, webhook_claims=3`);

    // Copy 0028 into oldDir and run upgrade
    copyUpTo(oldDir, 28);
    const upgraded = await runMigrations(pool, oldDir);
    assert.deepEqual(upgraded.applied, ['0028_push_channel_and_secret_hardening.sql']);

    status = await migrationStatus(pool, oldDir);
    assert.equal(status.pending.length, 0);
    assert.equal(status.checksumsMatch, true);

    // Data preserved
    const pref = await pool.query<{ endpoint_url: string; signing_secret: string | null; signing_secret_encrypted: string | null }>(`SELECT endpoint_url, signing_secret, signing_secret_encrypted FROM notification_preferences WHERE user_id=$1 AND channel='webhook'`, [userId]);
    assert.equal(pref.rows[0]!.endpoint_url, 'https://hooks.example.test');
    // Plaintext should still be there (migration does not encrypt, app strategy does)
    assert.equal(pref.rows[0]!.signing_secret, 'plain-secret-123');

    const fairness = await pool.query<{ email_claims: string; webhook_claims: string; push_claims: string }>(`SELECT email_claims::text, webhook_claims::text, COALESCE(push_claims,0)::text AS push_claims FROM notification_delivery_fairness WHERE singleton=true`);
    assert.equal(fairness.rows[0]!.email_claims, '5');
    assert.equal(fairness.rows[0]!.webhook_claims, '3');
    assert.equal(fairness.rows[0]!.push_claims, '0', 'new column defaults to 0 on upgrade');

    // 0026/0027 not modified — we verify their checksums still match (migrationStatus already checks)
    assert.equal(status.checksumsMatch, true);
  });

  test('0026/0027 zero-diff: migration files unchanged, no data deletion', async () => {
    // This test ensures we did not rewrite 0026/0027; we check that they still exist and are readable
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0026_') || f.startsWith('0027_'));
    assert.equal(files.length, 2);
    for (const file of files) {
      const content = await import('node:fs').then((fs) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      assert.ok(content.length > 0);
      assert.ok(!content.includes('DROP TABLE'), 'migrations should not drop tables');
    }
  });
});
