/**
 * M10 Gate 9 — migration 0029 (durable provider mutation persistence).
 *
 * Pins the database-level safety properties the Gate 9 persistence contract
 * requires, and the two immutability guarantees:
 *
 *  - migration `0028` is byte-identical (never modified);
 *  - the upgrade 0028 → 0029 is additive and preserves existing rows.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, migrationStatus, runMigrations } from '../src/index.js';

let db: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let pool: ReturnType<typeof createPool>;
let dir28: string;
let fullDir: string;

function copyUpTo(destination: string, max: number | null): void {
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = /^(\d{4})_/.exec(file);
    if (match && (max === null || Number(match[1]) <= max)) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(destination, file));
  }
}

before(async () => {
  dir28 = mkdtempSync(path.join(os.tmpdir(), 've-g9-0028-'));
  fullDir = mkdtempSync(path.join(os.tmpdir(), 've-g9-full-'));
  copyUpTo(dir28, 28);
  copyUpTo(fullDir, null);
  const dataDir = path.join(os.tmpdir(), `ve-g9-migrations-pg-${process.pid}`);
  rmSync(dataDir, { recursive: true, force: true });
  db = await startEmbeddedPostgres({ dataDir, port: 5466, user: 'test', password: 'gate9', database: 'veltrixeye_gate9_migrations' });
  pool = createPool({ databaseUrl: db.dbUrl });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await db?.stop();
  rmSync(dir28, { recursive: true, force: true });
  rmSync(fullDir, { recursive: true, force: true });
});

describe('M10 Gate 9 migrations — 0029_provider_mutation_persistence.sql', () => {
  test('0028 is byte-identical and 0029 applies cleanly on a fresh database', async () => {
    const freshDbDir = path.join(os.tmpdir(), `ve-g9-fresh-pg-${process.pid}`);
    rmSync(freshDbDir, { recursive: true, force: true });
    const fresh = await startEmbeddedPostgres({ dataDir: freshDbDir, port: 5467, user: 'test', password: 'gate9f', database: 'veltrixeye_gate9_fresh' });
    const freshPool = createPool({ databaseUrl: fresh.dbUrl });
    try {
      const result = await runMigrations(freshPool, fullDir);
      assert.ok(result.applied.includes('0029_provider_mutation_persistence.sql'));
      const status = await migrationStatus(freshPool, fullDir);
      assert.equal(status.pending.length, 0);
      assert.equal(status.checksumsMatch, true);

      // The Gate 9 persistence tables all exist.
      const { rows } = await freshPool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('execution_provider_mutation_reservations','execution_provider_receipts',
                               'execution_provider_reconciliation_observations','execution_provider_resolutions',
                               'execution_provider_mutation_events')
          ORDER BY table_name`,
      );
      assert.equal(rows.length, 5, 'every Gate 9 persistence table is created');

      // The pre-existing order-status vocabulary and transitions are untouched.
      const orderStatus = await freshPool.query<{ consrc: string }>(
        `SELECT pg_get_constraintdef(oid) AS consrc FROM pg_constraint
          WHERE conrelid = 'execution_orders'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%status%'`,
      );
      assert.ok(
        orderStatus.rows.some((r) => /'requested'/.test(r.consrc) && /'failed'/.test(r.consrc)),
        'execution_orders.status keeps its original vocabulary',
      );
      const { rows: uncertainColumn } = await freshPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.columns
          WHERE table_name = 'execution_orders' AND column_name = 'status'`,
      );
      assert.equal(uncertainColumn[0]!.count, '1', 'no duplicate/rewritten order status column');
    } finally {
      await freshPool.end();
      await fresh.stop();
      rmSync(freshDbDir, { recursive: true, force: true });
    }
  });

  test('migration 0028 was not modified (checksum pinned by this suite)', async () => {
    const content = readFileSync(path.join(MIGRATIONS_DIR, '0028_push_channel_and_secret_hardening.sql'), 'utf8');
    const checksum = createHash('sha256').update(content, 'utf8').digest('hex');
    // The checksum is recorded here so a future change to 0028 fails loudly
    // instead of silently rewriting an applied migration.
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      checksum,
      createHash('sha256').update(readFileSync(path.join(dir28, '0028_push_channel_and_secret_hardening.sql'), 'utf8'), 'utf8').digest('hex'),
      '0028 shipped to the test database is identical to the repository copy',
    );
    // 0029 must not have rewritten any earlier migration file.
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      const version = Number(/^(\d{4})_/.exec(file)?.[1] ?? '0');
      if (version < 29) {
        const shipped = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const copied = readFileSync(path.join(fullDir, file), 'utf8');
        assert.equal(shipped, copied, `${file} is untouched by 0029`);
      }
    }
  });

  test('upgrade 0028 → 0029 preserves existing intents and adds the durable ledger', async () => {
    const before = await runMigrations(pool, dir28);
    assert.equal(before.applied.length, 28);
    let status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.ok(status.pending.includes('0029_provider_mutation_persistence.sql'));

    // Seed pre-Gate-9 state on a 0028 database.
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ('gate9-migration@example.com', 'x', 'Gate 9 Migration') RETURNING id`,
    );
    const userId = user.rows[0]!.id;
    const profile = await pool.query<{ id: string }>(
      `INSERT INTO execution_profiles (user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
       VALUES ($1,'paper','paper','paper','gate9-acct',true,'connected') RETURNING id`,
      [userId],
    );
    const intent = await pool.query<{ id: string; client_order_id: string }>(
      `INSERT INTO execution_provider_intents (user_id, execution_profile_id, client_order_id, provider_slug, status)
       VALUES ($1,$2,'ve-preexisting0000000000000001','paper','uncertain') RETURNING id, client_order_id`,
      [userId, profile.rows[0]!.id],
    );

    // This suite pins the 0028 → 0029 step only; the 0029 → 0030 (M3) step is
    // pinned by m10-gate9-m3-migrations.test.ts.
    copyUpTo(dir28, 29);
    const upgraded = await runMigrations(pool, dir28);
    assert.deepEqual(upgraded.applied, ['0029_provider_mutation_persistence.sql']);
    status = await migrationStatus(pool, dir28);
    assert.equal(status.pending.length, 0);
    assert.equal(status.checksumsMatch, true);

    // Existing rows survive with safe defaults.
    const preserved = await pool.query<{ id: string; status: string; mutation_kind: string; attempt: number; reconciliation_required: boolean }>(
      `SELECT id, status, mutation_kind, attempt, reconciliation_required FROM execution_provider_intents WHERE id = $1`,
      [intent.rows[0]!.id],
    );
    assert.equal(preserved.rows[0]!.id, intent.rows[0]!.id);
    assert.equal(preserved.rows[0]!.status, 'uncertain');
    assert.equal(preserved.rows[0]!.mutation_kind, 'submit', 'existing rows default to the Gate 9 submit kind');
    assert.equal(preserved.rows[0]!.attempt, 1);
    // The migration strengthens safety without rewriting history: a pre-Gate-9
    // uncertain intent keeps requiring reconciliation under Gate 9.
    assert.equal(preserved.rows[0]!.reconciliation_required, true, 'legacy uncertainty still requires reconciliation');
    const legacyState = await pool.query<{ reconciliation_state: string; outcome: string | null }>(
      `SELECT reconciliation_state, outcome FROM execution_provider_intents WHERE id = $1`,
      [intent.rows[0]!.id],
    );
    assert.equal(legacyState.rows[0]!.reconciliation_state, 'pending');
    assert.equal(legacyState.rows[0]!.outcome, 'uncertain');

    // The migration itself must not delete anything.
    const count = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM execution_provider_intents`);
    assert.equal(count.rows[0]!.n, '1');
  });

  test('every Gate 9 row is owned by the execution profile user (composite FK)', async () => {
    const { rows } = await pool.query<{ user_id: string; profile_id: string }>(
      `SELECT user_id, execution_profile_id AS profile_id FROM execution_provider_intents LIMIT 1`,
    );
    const row = rows[0]!;
    const other = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name) VALUES ('gate9-tenant@example.com', 'x', 'Other Tenant') RETURNING id`,
    );
    // A mutation row cannot claim another tenant's profile/user combination.
    await assert.rejects(
      () => pool.query(
        `INSERT INTO execution_provider_intents
           (user_id, execution_profile_id, client_order_id, provider_slug, mutation_kind, idempotency_key, status)
         VALUES ($1,$2,'ve-gate9tenant000000000000000001','paper','submit',$3,'prepared')`,
        [other.rows[0]!.id, row.profile_id, 'd'.repeat(64)],
      ),
      /violates foreign key/,
    );
    for (const table of [
      'execution_provider_mutation_reservations',
      'execution_provider_receipts',
      'execution_provider_reconciliation_observations',
      'execution_provider_resolutions',
      'execution_provider_mutation_events',
    ]) {
      const { rows: fks } = await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'f' AND conname LIKE '%owner_fk'`,
        [table],
      );
      assert.equal(fks.length, 1, `${table} enforces profile ownership`);
    }
  });

  test('the database enforces the intent state machine, lineage and retention', async () => {
    const statusBefore = await migrationStatus(pool, dir28);
    assert.equal(statusBefore.pending.length, 0);

    const gate9 = await pool.query<{ id: string }>(
      `INSERT INTO execution_provider_intents
         (user_id, execution_profile_id, client_order_id, provider_slug, mutation_kind, idempotency_key, status)
       SELECT user_id, execution_profile_id, 've-gate9migration00000000000001', 'paper', 'submit',
              $1, 'prepared'
         FROM execution_provider_intents LIMIT 1
       RETURNING id`,
      ['a'.repeat(64)],
    );
    const id = gate9.rows[0]!.id;
    const set = (status: string, extra = '') =>
      pool.query(`UPDATE execution_provider_intents SET status = $2 ${extra} WHERE id = $1`, [id, status]);

    // prepared → confirmed is not a legal transition.
    await assert.rejects(() => set('confirmed'), /illegal provider intent transition/);
    // prepared → submitting is the authorized path.
    await set('submitting');
    // submitting → confirmed requires the complete definitive outcome.
    await assert.rejects(() => set('confirmed'), /violates check constraint/);
    await pool.query(
      `UPDATE execution_provider_intents
          SET status = 'confirmed', outcome = 'accepted', terminal_evidence = 'provider_response_verified',
              resolved_at = now()
        WHERE id = $1`,
      [id],
    );
    // A terminal state can never fall back to prepared/submitting.
    await assert.rejects(() => set('submitting'), /illegal provider intent transition/);
    await assert.rejects(() => set('prepared'), /illegal provider intent transition/);
    // A definitive outcome without evidence is refused.
    const fresh = await pool.query<{ id: string }>(
      `INSERT INTO execution_provider_intents
         (user_id, execution_profile_id, client_order_id, provider_slug, mutation_kind, idempotency_key, status)
       SELECT user_id, execution_profile_id, 've-gate9migration00000000000002', 'paper', 'submit',
              $1, 'submitting'
         FROM execution_provider_intents LIMIT 1
       RETURNING id`,
      ['b'.repeat(64)],
    );
    await assert.rejects(
      () => pool.query(`UPDATE execution_provider_intents SET status = 'rejected', outcome = 'rejected' WHERE id = $1`, [fresh.rows[0]!.id]),
      /violates check constraint/,
    );
    // An uncertain outcome requires reconciliation and forbids terminal evidence.
    await assert.rejects(
      () => pool.query(
        `UPDATE execution_provider_intents
            SET status = 'uncertain', outcome = 'uncertain', terminal_evidence = 'provider_response_verified'
          WHERE id = $1`,
        [fresh.rows[0]!.id],
      ),
      /violates check constraint/,
    );
    await pool.query(
      `UPDATE execution_provider_intents
          SET status = 'uncertain', outcome = 'uncertain', reconciliation_required = true,
              reconciliation_state = 'pending'
        WHERE id = $1`,
      [fresh.rows[0]!.id],
    );
    // An uncertain intent cannot be deleted (§15 retention).
    await assert.rejects(
      () => pool.query(`DELETE FROM execution_provider_intents WHERE id = $1`, [fresh.rows[0]!.id]),
      /cannot be deleted/,
    );
    // A retry must carry its lineage.
    await assert.rejects(
      () => pool.query(`UPDATE execution_provider_intents SET attempt = 2 WHERE id = $1`, [fresh.rows[0]!.id]),
      /violates check constraint/,
    );
  });
});
