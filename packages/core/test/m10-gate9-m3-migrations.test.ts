/**
 * M10 Gate 9 Step 3c (M3) — migration 0030 (structural lineage / order
 * invariants for the provider mutation ledger).
 *
 * Pins:
 *  - migration `0029` is byte-identical (SHA-256 recorded here);
 *  - `0030` is additive only (three partial UNIQUE indexes + a refusing
 *    pre-flight; no DROP / ALTER / REPLACE / data rewrite);
 *  - the upgrade 0029 → 0030 preserves every existing row — legacy rows,
 *    lineages and order-bound rows alike;
 *  - `0030` REFUSES to apply on conflicting data and rewrites nothing.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, migrationStatus, runMigrations } from '../src/index.js';

const MIGRATION_0029 = '0029_provider_mutation_persistence.sql';
const MIGRATION_0030 = '0030_provider_mutation_lineage_invariants.sql';
/** Recorded when M2 was merged; 0029 is immutable. */
const MIGRATION_0029_SHA256 = 'a8c4cde5fc8dc2e0cc48b253e9d881f90cdc7f825d323a67a8defd382bde9ce7';
const M3_INDEXES = [
  'execution_provider_intents_parent_uniq',
  'execution_provider_intents_lineage_attempt_uniq',
  'execution_provider_intents_order_live_uniq',
] as const;

let db: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let pool: ReturnType<typeof createPool>;
let dir29: string;
let fullDir: string;

function copyUpTo(destination: string, max: number | null): void {
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = /^(\d{4})_/.exec(file);
    if (match && (max === null || Number(match[1]) <= max)) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(destination, file));
  }
}

/** A second database inside the same embedded instance (fresh-apply / conflict scenarios). */
async function databasePool(name: string): Promise<ReturnType<typeof createPool>> {
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(db.dbUrl);
  url.pathname = `/${name}`;
  return createPool({ databaseUrl: url.toString() });
}

before(async () => {
  dir29 = mkdtempSync(path.join(os.tmpdir(), 've-g9m3-0029-'));
  fullDir = mkdtempSync(path.join(os.tmpdir(), 've-g9m3-full-'));
  copyUpTo(dir29, 29);
  copyUpTo(fullDir, null);
  const dataDir = path.join(os.tmpdir(), `ve-g9m3-migrations-pg-${process.pid}`);
  rmSync(dataDir, { recursive: true, force: true });
  db = await startEmbeddedPostgres({ dataDir, port: 5470, user: 'test', password: 'gate9m3', database: 'veltrixeye_gate9_m3_migrations' });
  pool = createPool({ databaseUrl: db.dbUrl });
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await db?.stop();
  rmSync(dir29, { recursive: true, force: true });
  rmSync(fullDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Seed helpers (raw rows; the ledger is not involved in migration tests)      */
/* -------------------------------------------------------------------------- */

const hex64 = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const clientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;

async function seedAccount(q: ReturnType<typeof createPool>): Promise<{ userId: string; profileId: string }> {
  const user = await q.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Gate 9 M3 Migration') RETURNING id`,
    [`gate9-m3-${randomBytes(6).toString('hex')}@example.com`],
  );
  const userId = user.rows[0]!.id;
  const profile = await q.query<{ id: string }>(
    `INSERT INTO execution_profiles (user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,'paper','paper','paper','gate9-m3-acct',true,'connected') RETURNING id`,
    [userId],
  );
  return { userId, profileId: profile.rows[0]!.id };
}

async function seedOrder(q: ReturnType<typeof createPool>, userId: string, profileId: string): Promise<string> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO execution_orders
       (id, user_id, execution_profile_id, client_order_id, provider_slug, asset_class, symbol, side, order_type,
        quantity, filled_quantity, status, idempotency_key, architecture_version)
     VALUES ($1,$2,$3,$4,'paper','forex','EURUSD','buy','market',1,0,'requested',$5,'m8.1-execution-arch-1')`,
    [id, userId, profileId, `ve-${id.replace(/-/g, '').slice(0, 24)}`, hex64()],
  );
  return id;
}

interface SeedIntent {
  userId: string;
  profileId: string;
  orderId?: string | null;
  mutationKind?: 'submit' | 'cancel' | 'modify' | 'close';
  status: 'submitting' | 'uncertain' | 'confirmed' | 'rejected';
  parentIntentId?: string;
  rootIntentId?: string;
  attempt?: number;
}

async function seedIntent(q: ReturnType<typeof createPool>, args: SeedIntent): Promise<string> {
  const id = randomUUID();
  const terminal = args.status === 'confirmed' || args.status === 'rejected';
  await q.query(
    `INSERT INTO execution_provider_intents
       (id, user_id, execution_profile_id, order_id, mutation_kind, client_order_id, idempotency_key, request_hash,
        provider_slug, environment, account_ref, status, outcome, terminal_evidence, resolved_at,
        reconciliation_required, reconciliation_state, parent_intent_id, root_intent_id, attempt)
     VALUES ($1,$2,$3,$4,$17,$5,$6,$7,'paper','paper','gate9-m3-acct',$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id, args.userId, args.profileId, args.orderId ?? null, clientOrderId(), hex64(), hex64(),
      args.status,
      args.status === 'confirmed' ? 'accepted' : args.status === 'rejected' ? 'rejected' : args.status === 'uncertain' ? 'uncertain' : null,
      terminal ? 'provider_response_verified' : null,
      terminal ? new Date() : null,
      args.status === 'uncertain',
      args.status === 'uncertain' ? 'pending' : 'not_required',
      args.parentIntentId ?? null,
      args.rootIntentId ?? null,
      args.attempt ?? 1,
      args.mutationKind ?? 'submit',
    ],
  );
  return id;
}

async function snapshotIntents(q: ReturnType<typeof createPool>): Promise<string> {
  const { rows } = await q.query<{ row: unknown }>(
    `SELECT to_jsonb(i) AS row FROM execution_provider_intents i ORDER BY id`,
  );
  return JSON.stringify(rows.map((r) => r.row));
}

async function m3IndexNames(q: ReturnType<typeof createPool>): Promise<string[]> {
  const { rows } = await q.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'execution_provider_intents' AND indexname = ANY($1::text[]) ORDER BY indexname`,
    [[...M3_INDEXES]],
  );
  return rows.map((r) => r.indexname);
}

/* -------------------------------------------------------------------------- */

describe('M10 Gate 9 M3 migrations — 0030_provider_mutation_lineage_invariants.sql', () => {
  test('0029 is byte-identical (pinned checksum) and 0030 is the only new, additive-only migration', () => {
    const sql29 = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_0029), 'utf8');
    assert.equal(createHash('sha256').update(sql29).digest('hex'), MIGRATION_0029_SHA256, '0029 must never change');

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    assert.equal(files.at(-1), MIGRATION_0030, '0030 is the newest migration');
    assert.equal(files.filter((f) => f.startsWith('0030_')).length, 1, 'exactly one 0030 migration');

    const sql30 = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_0030), 'utf8');
    const statements = sql30.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    for (const forbidden of [/\bDROP\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+OR\s+REPLACE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+execution_provider_intents\b/i, /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i]) {
      assert.doesNotMatch(statements, forbidden, `0030 is additive only (${forbidden})`);
    }
    for (const index of M3_INDEXES) {
      assert.match(statements, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${index}\\b`), `0030 creates ${index}`);
    }
    const preflightPredicate = /SELECT execution_profile_id, order_id\s+FROM execution_provider_intents\s+WHERE ([\s\S]*?)\s+GROUP BY execution_profile_id, order_id/.exec(statements)?.[1];
    const indexPredicate = /CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_order_live_uniq\s+ON execution_provider_intents \(execution_profile_id, order_id\)\s+WHERE ([\s\S]*?);/.exec(statements)?.[1];
    assert.ok(preflightPredicate);
    assert.ok(indexPredicate);
    assert.equal(preflightPredicate.replace(/\s+/g, ' '), indexPredicate.replace(/\s+/g, ' '), 'pre-flight and order-live index use identical predicates');
    assert.match(indexPredicate, /mutation_kind = 'submit'/, 'order-live invariant is submit-only');
    assert.match(statements, /RAISE EXCEPTION/, '0030 refuses on conflicting data instead of repairing it');
  });

  test('0030 applies cleanly on a fresh database and creates exactly the three partial unique indexes', async () => {
    const fresh = await databasePool('veltrixeye_gate9_m3_fresh');
    try {
      const result = await runMigrations(fresh, fullDir);
      assert.ok(result.applied.includes(MIGRATION_0029));
      assert.ok(result.applied.includes(MIGRATION_0030));
      const status = await migrationStatus(fresh, fullDir);
      assert.equal(status.pending.length, 0);
      assert.equal(status.checksumsMatch, true);
      assert.equal(status.latestApplied, MIGRATION_0030);

      const { rows } = await fresh.query<{ indexname: string; unique: boolean; predicate: string | null; columns: string }>(
        `SELECT c.relname AS indexname, x.indisunique AS "unique",
                pg_get_expr(x.indpred, x.indrelid) AS predicate,
                pg_get_indexdef(x.indexrelid) AS columns
           FROM pg_index x
           JOIN pg_class c ON c.oid = x.indexrelid
          WHERE x.indrelid = 'execution_provider_intents'::regclass AND c.relname = ANY($1::text[])
          ORDER BY c.relname`,
        [[...M3_INDEXES]],
      );
      assert.deepEqual(rows.map((r) => r.indexname), [...M3_INDEXES].sort());
      for (const row of rows) {
        assert.equal(row.unique, true, `${row.indexname} is UNIQUE`);
        assert.ok(row.predicate, `${row.indexname} is partial`);
      }
      const byName = new Map(rows.map((r) => [r.indexname, r]));
      assert.match(byName.get('execution_provider_intents_parent_uniq')!.columns, /\(parent_intent_id\)/);
      assert.match(byName.get('execution_provider_intents_lineage_attempt_uniq')!.columns, /\(root_intent_id, attempt\)/);
      const live = byName.get('execution_provider_intents_order_live_uniq')!;
      assert.match(live.columns, /\(execution_profile_id, order_id\)/, 'order uniqueness keeps the execution-profile dimension');
      assert.match(live.predicate!, /mutation_kind = 'submit'::text/, 'only submit mutations participate');
      assert.match(live.predicate!, /idempotency_key IS NOT NULL/, 'scoped to Gate 9 rows');
      assert.match(live.predicate!, /'prepared'.*'submitting'.*'uncertain'.*'confirmed'/s);
      assert.match(live.predicate!, /provider_accepted/);

      // No global client_order_id uniqueness was introduced: the only
      // client-order indexes are the pre-existing 0019/0029 ones.
      const clientOrderIndexes = await fresh.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE tablename = 'execution_provider_intents' AND indexdef ILIKE '%client_order_id%' ORDER BY indexname`,
      );
      assert.deepEqual(clientOrderIndexes.rows.map((r) => r.indexname), [
        'execution_provider_intents_client_order_uniq',
        // 0019's auto-named UNIQUE (execution_profile_id, client_order_id), truncated to 63 chars by PostgreSQL.
        'execution_provider_intents_execution_profile_id_client_orde_key',
        'execution_provider_intents_mutation_uniq',
      ]);
    } finally {
      await fresh.end();
    }
  });

  test('upgrade 0029 → 0030 preserves every existing row: legacy, lineage and order-bound', async () => {
    const before = await runMigrations(pool, dir29);
    assert.equal(before.applied.length, 29);
    let status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.deepEqual(status.pending, [MIGRATION_0030]);

    // Seed 0029-era state that must survive unchanged.
    const { userId, profileId } = await seedAccount(pool);
    const legacyOrder = await seedOrder(pool, userId, profileId);
    const legacy = await pool.query<{ id: string }>(
      `INSERT INTO execution_provider_intents (user_id, execution_profile_id, order_id, client_order_id, provider_slug, status)
       VALUES ($1,$2,$3,'ve-legacy00000000000000000001','paper','uncertain') RETURNING id`,
      [userId, profileId, legacyOrder],
    );
    const legacyId = legacy.rows[0]!.id;
    const root = await seedIntent(pool, { userId, profileId, status: 'rejected' });
    const retry = await seedIntent(pool, { userId, profileId, status: 'rejected', parentIntentId: root, rootIntentId: root, attempt: 2 });
    await pool.query(`UPDATE execution_provider_intents SET superseded_by_intent_id = $2 WHERE id = $1`, [root, retry]);
    const liveOrder = await seedOrder(pool, userId, profileId);
    await seedIntent(pool, { userId, profileId, orderId: liveOrder, status: 'uncertain' });
    const confirmedOrder = await seedOrder(pool, userId, profileId);
    await seedIntent(pool, { userId, profileId, orderId: confirmedOrder, status: 'confirmed' });
    // A rejected row for an order that also has a live row is legitimate (start-over after rejection).
    await seedIntent(pool, { userId, profileId, orderId: liveOrder, status: 'rejected' });
    // Schema-level fixtures only: non-submit kinds must not participate in
    // the submit pre-flight, even with duplicate live rows for the same order.
    for (const mutationKind of ['cancel', 'modify', 'close'] as const) {
      await seedIntent(pool, { userId, profileId, orderId: liveOrder, mutationKind, status: 'uncertain' });
      await seedIntent(pool, { userId, profileId, orderId: liveOrder, mutationKind, status: 'confirmed' });
    }
    const snapshot = await snapshotIntents(pool);
    assert.deepEqual(await m3IndexNames(pool), []);

    copyUpTo(dir29, 30);
    const upgraded = await runMigrations(pool, dir29);
    assert.deepEqual(upgraded.applied, [MIGRATION_0030]);
    status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.equal(status.pending.length, 0);
    assert.equal(status.checksumsMatch, true);

    assert.equal(await snapshotIntents(pool), snapshot, 'no row was rewritten, deleted or touched by 0030');
    assert.deepEqual(await m3IndexNames(pool), [...M3_INDEXES].sort());
    const legacyRow = await pool.query<{ idempotency_key: string | null; status: string; order_id: string }>(
      `SELECT idempotency_key, status, order_id FROM execution_provider_intents WHERE id = $1`,
      [legacyId],
    );
    assert.equal(legacyRow.rows[0]!.idempotency_key, null);
    assert.equal(legacyRow.rows[0]!.status, 'uncertain');

    // The new indexes are live for Gate 9 rows immediately after the upgrade.
    await assert.rejects(
      () => seedIntent(pool, { userId, profileId, orderId: liveOrder, status: 'submitting' }),
      (e: unknown) => (e as { constraint?: string }).constraint === 'execution_provider_intents_order_live_uniq',
    );
    await assert.rejects(
      () => seedIntent(pool, { userId, profileId, status: 'rejected', parentIntentId: root, rootIntentId: root, attempt: 3 }),
      (e: unknown) => (e as { constraint?: string }).constraint === 'execution_provider_intents_parent_uniq',
    );
    // The installed index has the same submit-only scope as the pre-flight.
    for (const mutationKind of ['cancel', 'modify', 'close'] as const) {
      await seedIntent(pool, { userId, profileId, orderId: liveOrder, mutationKind, status: 'submitting' });
    }
    // A legacy row never participates: a Gate 9 row for the legacy order is accepted by the index.
    await seedIntent(pool, { userId, profileId, orderId: legacyOrder, status: 'submitting' });
  });

  test('0030 refuses to apply on conflicting rows and rewrites nothing; it applies once the conflict is resolved out-of-band', async () => {
    const conflicted = await databasePool('veltrixeye_gate9_m3_conflict');
    const pristine29 = mkdtempSync(path.join(os.tmpdir(), 've-g9m3-0029-pristine-'));
    copyUpTo(pristine29, 29);
    try {
      const applied = await runMigrations(conflicted, pristine29);
      assert.equal(applied.applied.length, 29);
      const { userId, profileId } = await seedAccount(conflicted);
      const root = await seedIntent(conflicted, { userId, profileId, status: 'rejected' });
      const first = await seedIntent(conflicted, { userId, profileId, status: 'rejected', parentIntentId: root, rootIntentId: root, attempt: 2 });
      const sibling = await seedIntent(conflicted, { userId, profileId, status: 'rejected', parentIntentId: root, rootIntentId: root, attempt: 3 });
      const orderId = await seedOrder(conflicted, userId, profileId);
      await seedIntent(conflicted, { userId, profileId, orderId, status: 'uncertain' });
      await seedIntent(conflicted, { userId, profileId, orderId, status: 'submitting' });
      const snapshot = await snapshotIntents(conflicted);

      await assert.rejects(
        () => runMigrations(conflicted, fullDir),
        (error: unknown) => {
          const message = (error as Error).message;
          return /0030 refused/.test(message)
            && /1 parent intents with more than one retry/.test(message)
            && /1 managed orders with more than one live submit mutation/.test(message)
            && /No data was modified/.test(message);
        },
      );
      assert.equal(await snapshotIntents(conflicted), snapshot, 'the refused migration touched no row');
      assert.deepEqual(await m3IndexNames(conflicted), [], 'no index was left behind by the rolled-back migration');
      const status = await migrationStatus(conflicted, fullDir);
      assert.deepEqual(status.pending, [MIGRATION_0030], '0030 is still pending');
      assert.equal(status.checksumsMatch, true);

      // An operator resolves the conflicts out-of-band (this is NOT something
      // the migration does): the terminal sibling is removed and the second
      // live row is resolved as absent.
      await conflicted.query(`DELETE FROM execution_provider_intents WHERE id = $1`, [sibling]);
      const { rows: live } = await conflicted.query<{ id: string }>(
        `SELECT id FROM execution_provider_intents WHERE order_id = $1 AND status = 'submitting'`,
        [orderId],
      );
      await conflicted.query(
        `UPDATE execution_provider_intents
            SET status = 'reconciled', outcome = NULL, terminal_evidence = 'operator_resolution', resolution = 'provider_absent',
                resolved_at = now(), reconciliation_state = 'resolved', reconciliation_required = false
          WHERE id = $1`,
        [live[0]!.id],
      );
      const retried = await runMigrations(conflicted, fullDir);
      assert.deepEqual(retried.applied, [MIGRATION_0030]);
      assert.deepEqual(await m3IndexNames(conflicted), [...M3_INDEXES].sort());
      assert.equal((await conflicted.query(`SELECT 1 FROM execution_provider_intents WHERE id = $1`, [first])).rowCount, 1);
    } finally {
      await conflicted.end();
      rmSync(pristine29, { recursive: true, force: true });
    }
  });
});
