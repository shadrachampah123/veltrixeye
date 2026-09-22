/**
 * Billing PR2 — migration `0031_provider_billing.sql`.
 *
 * Pins, against a real PostgreSQL:
 *  - 0031 is the next migration, applies cleanly on a fresh database and on an
 *    in-place 0030 → 0031 upgrade, and is additive/forward-only (no DROP, no
 *    RENAME, no data rewrite, no redefinition of an earlier object);
 *  - migrations 0001–0030 are byte-identical (recorded SHA-256 for 0001, 0014
 *    and 0030 — identity/audit, the subscription table 0031 extends, and the
 *    previous tip); 0031 itself is now pinned the same way (PR3 re-scoped the
 *    "newest migration" assertion to the PR2 step, exactly as the Gate 9 M3
 *    suite re-scoped the 0029 tip assertion when 0030 arrived: 0031 is the
 *    newest migration OF THIS STEP, later migrations must be the recorded ones,
 *    and the runner still verifies every applied checksum);
 *  - existing users keep their `free | pro | premium` plan values and every
 *    pre-existing column/default/constraint of `subscriptions` (0014);
 *  - persisted provider state is constrained to the canonical vocabulary, the
 *    catalogue mapping is enforced, and **Starter is still not persistable**
 *    (no internal plan value and no entitlement definition — a later PR);
 *  - `billing_customers` and `billing_provider_events` enforce identity,
 *    uniqueness, tenant integrity, append-only retention, secret rejection and
 *    payload non-storage;
 *  - NO execution surface changes: execution tables/columns are identical
 *    before and after 0031, and `canAccessAutomation` stays `false`.
 *
 * No provider is contacted: this suite only runs SQL through the repository's
 * migration runner.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { startEmbeddedPostgres, removeDirRobust } from '../../../scripts/db/embedded.mjs';
import { createPool, MIGRATIONS_DIR, migrationStatus, runMigrations } from '../src/index.js';
import { getEntitlements } from '../src/billing/entitlements.js';
import type { UserPlan } from '@veltrixeye/contracts';

const MIGRATION_0031 = '0031_provider_billing.sql';
/** Recorded when Billing PR2 was written; these migrations are immutable. */
const RECORDED_SHA256: Readonly<Record<string, string>> = Object.freeze({
  '0001_identity_and_audit.sql': '7bf309682a639ab3b04bd72698d481f996ea07f98fafa59a5f726fe1a9943cf9',
  '0014_subscriptions_and_entitlements.sql': '133cc73c27fe99ba23f78ecda65b526c36a0f3f1e8319252562941c69f79f810',
  '0030_provider_mutation_lineage_invariants.sql': '979015990c2bbf38d4d4f5ec246f328cbfe7f1833aac2472f5b5ad209985ea5a',
  // Pinned when Billing PR3 added 0032: from that point on, 0031 is history and
  // must never change either (the PR3 suite re-checks the same value).
  '0031_provider_billing.sql': 'e43cf29aabc107a2985152b517560c872f8cafd2f7ebede01cffd5f555424a28',
});
/**
 * Migrations that legitimately appear AFTER this step's tip. Naming them here
 * is what keeps "nothing unexpected appears after 0031" a real assertion: a new
 * migration must be added to this list deliberately, by the change that
 * introduces it.
 */
const LATER_MIGRATIONS = ['0032_billing_fx_and_pricing.sql'] as const;
/** Columns `subscriptions` had before 0031 (migration 0014). */
const SUBSCRIPTION_COLUMNS_0014 = [
  'id',
  'user_id',
  'plan',
  'status',
  'provider',
  'provider_customer_id',
  'provider_subscription_id',
  'current_period_start',
  'current_period_end',
  'cancel_at_period_end',
  'created_at',
  'updated_at',
] as const;
/** Columns 0031 adds to `subscriptions`. */
const SUBSCRIPTION_COLUMNS_0031 = [
  'catalogue_plan',
  'billing_interval',
  'currency',
  'catalogue_version',
  'billing_customer_id',
  'provider_plan_id',
  'provider_subscription_code',
  'provider_reference',
  'provider_state',
  'cancel_at',
  'cancelled_at',
  'cancellation_reason',
  'sync_state',
  'last_sync_source',
  'last_synced_at',
  'sync_required',
  'last_event_idempotency_key',
  'state_version',
] as const;
/** Execution tables that must be structurally identical before/after 0031. */
const EXECUTION_TABLES = [
  'execution_profiles',
  'execution_requests',
  'execution_orders',
  'execution_positions',
  'execution_events',
  'execution_fills',
  'execution_provider_intents',
  'kill_switches',
] as const;

// Unique per suite file: core 5434, api 5435-5438, m6 5439, … gate9-m3 5470-5474.
const DB_PORT = 5475;

let db: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let pool: ReturnType<typeof createPool>;
let dir30: string;
let dir31: string;
let dataDir: string;

function copyUpTo(destination: string, max: number): void {
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = /^(\d{4})_/.exec(file);
    if (match && Number(match[1]) <= max) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(destination, file));
  }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** SQL of 0031 with comment lines removed, so prose cannot satisfy a check. */
function statements0031(): string {
  return readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_0031), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function pgCode(err: unknown): string {
  return String((err as { code?: unknown })?.code ?? '');
}

function constraintName(err: unknown): string {
  return String((err as { constraint?: unknown })?.constraint ?? '');
}

async function databasePool(name: string): Promise<ReturnType<typeof createPool>> {
  await pool.query(`CREATE DATABASE ${name}`);
  const url = new URL(db.dbUrl);
  url.pathname = `/${name}`;
  return createPool({ databaseUrl: url.toString() });
}

/** Structural signature of a table (name/type/default/nullability per column). */
async function columnsOf(q: ReturnType<typeof createPool>, table: string): Promise<string> {
  const { rows } = await q.query<{ signature: string | null }>(
    `SELECT string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, '-') || ':' || is_nullable, '|' ORDER BY column_name) AS signature
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows[0]?.signature ?? '';
}

async function constraintsOf(q: ReturnType<typeof createPool>, table: string): Promise<string> {
  const { rows } = await q.query<{ signature: string | null }>(
    `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), '|' ORDER BY conname) AS signature
       FROM pg_constraint WHERE conrelid = $1::regclass`,
    [table],
  );
  return rows[0]?.signature ?? '';
}

const uniqueEmail = () => `billing_pr2_${randomBytes(6).toString('hex')}@example.com`;

/** A user plus its (0014-shaped) subscription row. */
async function seedAccount(
  q: ReturnType<typeof createPool>,
  plan: UserPlan = 'free',
): Promise<{ userId: string; subscriptionId: string; email: string }> {
  const email = uniqueEmail();
  const user = await q.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name, plan) VALUES ($1, 'x', 'Billing PR2', $2) RETURNING id`,
    [email, plan],
  );
  const userId = user.rows[0]!.id;
  const sub = await q.query<{ id: string }>(
    `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, $2, 'active') RETURNING id`,
    [userId, plan],
  );
  return { userId, subscriptionId: sub.rows[0]!.id, email };
}

before(async () => {
  dir30 = mkdtempSync(path.join(os.tmpdir(), 've-billing-pr2-0030-'));
  dir31 = mkdtempSync(path.join(os.tmpdir(), 've-billing-pr2-0031-'));
  copyUpTo(dir30, 30);
  copyUpTo(dir31, 31);
  dataDir = path.join(os.tmpdir(), `ve-billing-pr2-pg-${process.pid}`);
  removeDirRobust(dataDir);
  db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: 'test',
    password: randomBytes(16).toString('hex'),
    database: 'veltrixeye_billing_pr2',
  });
  pool = createPool({ databaseUrl: db.dbUrl });
}, { timeout: 180_000 });

after(async () => {
  try {
    await pool?.end();
  } finally {
    try {
      await db?.stop();
    } finally {
      if (dataDir) removeDirRobust(dataDir);
      rmSync(dir30, { recursive: true, force: true });
      rmSync(dir31, { recursive: true, force: true });
    }
  }
});

describe('Billing PR2 — 0031 file conventions', () => {
  test('0031 is the newest migration of the PR2 step, uniquely named, and 0001-0030 are byte-identical', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    const versions = files.map((file) => Number(/^(\d{4})_/.exec(file)?.[1]));
    assert.equal(new Set(versions).size, versions.length, 'no duplicate migration version');
    for (let expected = 1; expected <= 31; expected += 1) {
      assert.ok(versions.includes(expected), `migration ${String(expected).padStart(4, '0')} exists`);
    }
    assert.equal(files.filter((file) => file.startsWith('0031_')).length, 1, 'exactly one 0031 migration');

    // Re-scoped when PR3 arrived (same precedent as the Gate 9 M3 suite, which
    // re-scoped its 0029 tip assertion when 0030 landed): 0031 must still be the
    // newest migration OF THIS STEP, and the only migrations after it are the
    // ones recorded in LATER_MIGRATIONS.
    const filesUpTo31 = files.filter((file) => Number(/^(\d{4})_/.exec(file)?.[1]) <= 31);
    assert.equal(filesUpTo31.at(-1), MIGRATION_0031, '0031 is the newest migration of the PR2 step');
    assert.deepEqual(
      files.filter((file) => Number(/^(\d{4})_/.exec(file)?.[1]) > 31),
      [...LATER_MIGRATIONS],
      'nothing unexpected is numbered after 0031',
    );
    for (const later of LATER_MIGRATIONS) {
      const version = Number(/^(\d{4})_/.exec(later)?.[1]);
      assert.equal(files.filter((file) => file.startsWith(`${later.slice(0, 4)}_`)).length, 1, `exactly one ${later}`);
      assert.equal(
        files.filter((file) => Number(/^(\d{4})_/.exec(file)?.[1]) === version).length,
        1,
        `${later} is uniquely numbered`,
      );
    }

    for (const [file, expected] of Object.entries(RECORDED_SHA256)) {
      assert.equal(
        sha256Text(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')),
        expected,
        `${file} was not modified`,
      );
    }
  });

  test('0031 is additive and forward-only: no drop, rename, data rewrite or object replacement', () => {
    const sql = statements0031();
    for (const forbidden of [
      /\bDROP\b/i,
      /\bRENAME\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bCREATE\s+OR\s+REPLACE\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+(users|subscriptions|billing_customers|billing_provider_events)\b/i,
      /\bALTER\s+(USER|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER|FUNCTION)\b/i,
    ]) {
      assert.doesNotMatch(sql, forbidden, `0031 is additive only (${forbidden})`);
    }

    // Every ALTER TABLE in 0031 adds something; none removes or rewrites.
    const alters = sql.match(/ALTER\s+TABLE[\s\S]*?;/gi) ?? [];
    assert.ok(alters.length >= 2, '0031 alters subscriptions additively');
    for (const alter of alters) {
      const body = alter.replace(/^ALTER\s+TABLE\s+\w+/i, '');
      assert.match(body, /\bADD\s+(COLUMN\s+IF\s+NOT\s+EXISTS|CONSTRAINT)\b/i, `additive ALTER: ${body.slice(0, 60)}`);
      assert.doesNotMatch(body, /\b(DROP|ALTER|RENAME|TRUNCATE|SET\s+DATA\s+TYPE|SET\s+DEFAULT|SET\s+NOT\s+NULL|VALIDATE)\b/i);
    }

    // Constraints are added behind an existence guard: deterministic, and never
    // a second constraint with the same name.
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname =/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS/);
    // The 0001 helper is reused, never redeclared.
    assert.match(sql, /EXECUTE FUNCTION set_updated_at\(\)/);
    assert.doesNotMatch(sql, /FUNCTION\s+set_updated_at\s*\(\)\s*RETURNS/i);
    // New tables/functions/triggers are created outright, so a name collision
    // with 0001-0030 fails loudly instead of silently replacing a definition.
    assert.doesNotMatch(sql, /CREATE\s+(?:TABLE|FUNCTION|TRIGGER)\s+IF\s+NOT\s+EXISTS/i);
  });

  test('0031 documents the boundary it establishes', () => {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_0031), 'utf8');
    assert.match(raw, /no HTTP call/i, 'states that no HTTP call exists');
    assert.match(raw, /free \| pro \| premium/, 'states the preserved internal plan vocabulary');
    assert.match(raw, /Starter still cannot be persisted/, 'states that Starter is not sellable yet');
    assert.match(raw, /0001–0030 are byte-identical/, 'states historical migrations are untouched');
    assert.match(raw, /no webhook receiver/i, 'states there is no webhook receiver');
    assert.match(raw, /Nothing in this migration enables execution/, 'states execution is untouched');
  });
});

describe('Billing PR2 — 0031 on a fresh database', () => {
  test('applies cleanly through 0031 and creates the billing persistence model', async () => {
    const fresh = await databasePool('veltrixeye_billing_pr2_fresh');
    try {
      const result = await runMigrations(fresh, dir31);
      assert.equal(result.applied.length, 31, 'a fresh database applies 0001-0031');
      assert.equal(result.applied.at(-1), MIGRATION_0031);

      const status = await migrationStatus(fresh, dir31);
      assert.equal(status.pending.length, 0);
      assert.equal(status.checksumsMatch, true);
      assert.equal(status.latestApplied, MIGRATION_0031);

      // A second run applies nothing: deterministic and forward-only.
      const second = await runMigrations(fresh, dir31);
      assert.equal(second.applied.length, 0);
      assert.equal(second.alreadyApplied.length, 31);

      const tables = await fresh.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('billing_customers','billing_provider_events')
          ORDER BY table_name`,
      );
      assert.deepEqual(
        tables.rows.map((row) => row.table_name),
        ['billing_customers', 'billing_provider_events'],
      );

      const columns = await fresh.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'subscriptions' ORDER BY column_name`,
      );
      const names = columns.rows.map((row) => row.column_name);
      for (const column of SUBSCRIPTION_COLUMNS_0014) {
        assert.ok(names.includes(column), `subscriptions.${column} (0014) still exists`);
      }
      for (const column of SUBSCRIPTION_COLUMNS_0031) {
        assert.ok(names.includes(column), `subscriptions.${column} was added by 0031`);
      }

      // The 0014 plan CHECK survives untouched — no new internal plan value.
      const checks = await fresh.query<{ conname: string; definition: string }>(
        `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'subscriptions'::regclass AND contype = 'c' ORDER BY conname`,
      );
      const planCheck = checks.rows.find((row) => row.conname === 'subscriptions_plan_check');
      assert.ok(planCheck, 'the 0014 plan CHECK still exists');
      assert.match(planCheck!.definition, /'free'/);
      assert.match(planCheck!.definition, /'pro'/);
      assert.match(planCheck!.definition, /'premium'/);
      assert.doesNotMatch(planCheck!.definition, /'starter'/, 'no new internal plan value was added');
      assert.doesNotMatch(planCheck!.definition, /'elite'/, 'no commercial value leaked into the internal vocabulary');
      // The 0014 status CHECK is unchanged too.
      const statusCheck = checks.rows.find((row) => row.conname === 'subscriptions_status_check');
      assert.ok(statusCheck, 'the 0014 status CHECK still exists');
      assert.match(statusCheck!.definition, /'trialing'/);
      assert.match(statusCheck!.definition, /'past_due'/);

      // The one-subscription-per-user uniqueness from 0014 is intact.
      const indexes = await fresh.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'subscriptions' ORDER BY indexname`,
      );
      assert.ok(
        indexes.rows.some((row) => row.indexname === 'subscriptions_user_id_idx'),
        'the 0014 unique index is preserved',
      );

      // No raw provider payload and no secret column exists in the billing schema.
      const sensitive = await fresh.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name LIKE 'billing_%'
            AND (column_name LIKE '%payload%' OR column_name LIKE '%secret%' OR column_name LIKE '%key%' OR column_name LIKE '%body%')
          ORDER BY table_name, column_name`,
      );
      assert.deepEqual(
        sensitive.rows.map((row) => `${row.table_name}.${row.column_name}`),
        ['billing_provider_events.idempotency_key', 'billing_provider_events.payload_hash'],
        'only a hash and an idempotency key are storable — never a payload or a secret',
      );
    } finally {
      await fresh.end();
    }
  });
});

describe('Billing PR2 — upgrade 0030 → 0031', () => {
  test('preserves existing users, free/pro/premium values, every 0014 column and all execution tables', async () => {
    const before = await runMigrations(pool, dir30);
    assert.equal(before.applied.length, 30, 'the database starts at 0030');
    let status = await migrationStatus(pool, dir31);
    assert.deepEqual(status.pending, [MIGRATION_0031], '0031 is the only pending migration');

    // Seed the three existing plan values exactly as production holds them.
    const seeded = [await seedAccount(pool, 'free'), await seedAccount(pool, 'pro'), await seedAccount(pool, 'premium')];
    const snapshotBefore = JSON.stringify(
      (
        await pool.query(
          `SELECT id, user_id, plan, status, provider, provider_customer_id, provider_subscription_id,
                  current_period_start, current_period_end, cancel_at_period_end, created_at
             FROM subscriptions ORDER BY created_at, id`,
        )
      ).rows,
    );
    const executionColumnsBefore: Record<string, string> = {};
    const executionConstraintsBefore: Record<string, string> = {};
    for (const table of EXECUTION_TABLES) {
      executionColumnsBefore[table] = await columnsOf(pool, table);
      executionConstraintsBefore[table] = await constraintsOf(pool, table);
      assert.notEqual(executionColumnsBefore[table], '', `${table} exists before 0031`);
    }
    const userColumnsBefore = await columnsOf(pool, 'users');
    const userConstraintsBefore = await constraintsOf(pool, 'users');

    const upgraded = await runMigrations(pool, dir31);
    assert.deepEqual(upgraded.applied, [MIGRATION_0031], 'only 0031 was applied');
    status = await migrationStatus(pool, dir31);
    assert.equal(status.pending.length, 0);
    assert.equal(status.checksumsMatch, true);
    assert.equal(status.latestApplied, MIGRATION_0031);

    // Existing rows are unchanged on every 0014 column.
    const snapshotAfter = JSON.stringify(
      (
        await pool.query(
          `SELECT id, user_id, plan, status, provider, provider_customer_id, provider_subscription_id,
                  current_period_start, current_period_end, cancel_at_period_end, created_at
             FROM subscriptions ORDER BY created_at, id`,
        )
      ).rows,
    );
    assert.equal(snapshotAfter, snapshotBefore, 'no existing subscription row was rewritten');

    // New columns carry inert defaults on every pre-existing row.
    const defaults = await pool.query<{
      plan: string;
      catalogue_plan: string | null;
      billing_interval: string | null;
      currency: string;
      provider: string | null;
      provider_state: string | null;
      sync_state: string;
      last_sync_source: string;
      last_synced_at: Date | null;
      sync_required: boolean;
      state_version: number;
      last_event_idempotency_key: string | null;
      billing_customer_id: string | null;
      cancelled_at: Date | null;
    }>(
      `SELECT plan, catalogue_plan, billing_interval, currency, provider, provider_state, sync_state,
              last_sync_source, last_synced_at, sync_required, state_version, last_event_idempotency_key,
              billing_customer_id, cancelled_at
         FROM subscriptions ORDER BY created_at, id`,
    );
    assert.equal(defaults.rows.length, 3);
    assert.deepEqual(
      defaults.rows.map((row) => row.plan),
      ['free', 'pro', 'premium'],
      'the stored plan values survived the upgrade',
    );
    for (const row of defaults.rows) {
      assert.equal(row.catalogue_plan, null, 'no commercial plan is claimed for a pre-existing row');
      assert.equal(row.billing_interval, null);
      assert.equal(row.currency, 'USD');
      assert.equal(row.provider, null);
      assert.equal(row.provider_state, null);
      assert.equal(row.sync_state, 'never_synced');
      assert.equal(row.last_sync_source, 'none');
      assert.equal(row.last_synced_at, null);
      assert.equal(row.sync_required, false);
      assert.equal(row.state_version, 1);
      assert.equal(row.last_event_idempotency_key, null);
      assert.equal(row.billing_customer_id, null);
      assert.equal(row.cancelled_at, null);
    }

    // `users` was not altered at all.
    assert.equal(await columnsOf(pool, 'users'), userColumnsBefore, 'users columns are identical');
    assert.equal(await constraintsOf(pool, 'users'), userConstraintsBefore, 'users constraints are identical');

    // NO execution surface changed.
    for (const table of EXECUTION_TABLES) {
      assert.equal(await columnsOf(pool, table), executionColumnsBefore[table], `${table} columns are identical after 0031`);
      assert.equal(
        await constraintsOf(pool, table),
        executionConstraintsBefore[table],
        `${table} constraints are identical after 0031`,
      );
    }
    const automationDefault = await pool.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'automation_enabled'`,
    );
    assert.match(automationDefault.rows[0]?.column_default ?? '', /false/, 'automation stays off by default');

    // Entitlements are unchanged for every existing plan value.
    for (const plan of ['free', 'pro', 'premium'] as const) {
      assert.equal(getEntitlements(plan, 'active').canAccessAutomation, false, `${plan}: automation is not granted`);
      assert.equal(getEntitlements(plan, 'canceled').canAccessAutomation, false);
    }
    assert.equal(getEntitlements('premium', 'active').maxStrategies, 1000);
    assert.equal(getEntitlements('pro', 'active').maxStrategies, 500);
    assert.equal(getEntitlements('free', 'active').maxStrategies, 100);
    assert.equal(seeded.length, 3);
  });

  test('the stored plan vocabulary is unchanged and Starter is still not persistable', async () => {
    const { userId, subscriptionId } = await seedAccount(pool, 'premium');

    for (const plan of ['free', 'pro', 'premium'] as const) {
      await pool.query(`UPDATE subscriptions SET plan = $1, catalogue_plan = NULL WHERE id = $2`, [plan, subscriptionId]);
      const check = await pool.query<{ plan: string }>(`SELECT plan FROM subscriptions WHERE id = $1`, [subscriptionId]);
      assert.equal(check.rows[0]!.plan, plan, `${plan} remains a valid stored value`);
      await pool.query(`UPDATE users SET plan = $1 WHERE id = $2`, [plan, userId]);
    }

    // No new internal plan value exists — on either table.
    for (const rejected of ['starter', 'elite', 'Starter', 'PRO', '', 'premium ']) {
      await assert.rejects(
        () => pool.query(`UPDATE subscriptions SET plan = $1 WHERE id = $2`, [rejected, subscriptionId]),
        (err: unknown) => pgCode(err) === '23514',
        `subscriptions.plan must reject "${rejected}"`,
      );
      await assert.rejects(
        () => pool.query(`UPDATE users SET plan = $1 WHERE id = $2`, [rejected, userId]),
        (err: unknown) => pgCode(err) === '23514',
        `users.plan must reject "${rejected}"`,
      );
    }

    // Catalogue identity is constrained to the canonical compatibility mapping.
    await pool.query(`UPDATE subscriptions SET plan = 'premium' WHERE id = $1`, [subscriptionId]);
    await pool.query(`UPDATE subscriptions SET catalogue_plan = 'elite', billing_interval = 'annual' WHERE id = $1`, [subscriptionId]);
    await pool.query(`UPDATE subscriptions SET plan = 'pro', catalogue_plan = 'pro', billing_interval = 'monthly' WHERE id = $1`, [subscriptionId]);

    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET catalogue_plan = 'starter' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_catalogue_plan_mapping_check',
      'Starter has no internal plan value, so it cannot be persisted',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET catalogue_plan = 'elite' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_catalogue_plan_mapping_check',
      'internal pro cannot claim the Elite catalogue row',
    );
    await pool.query(`UPDATE subscriptions SET plan = 'free', catalogue_plan = NULL, billing_interval = NULL WHERE id = $1`, [subscriptionId]);
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET catalogue_plan = 'pro' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_catalogue_plan_mapping_check',
      'internal free has no commercial counterpart',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET catalogue_plan = 'free' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => pgCode(err) === '23514',
      'catalogue_plan only accepts the commercial vocabulary',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET billing_interval = 'weekly' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_billing_interval_check',
    );
    await pool.query(`UPDATE subscriptions SET billing_interval = NULL WHERE id = $1`, [subscriptionId]);
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET billing_interval = 'monthly' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_billing_interval_scope_check',
      'an interval requires a sold (catalogue) plan',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET currency = 'NGN' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_currency_check',
      'the catalogue is USD-only',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET current_period_start = now(), current_period_end = now() - interval '1 day' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_period_order_check',
    );
  });

  test('provider-backed columns are constrained to the canonical vocabulary', async () => {
    const { subscriptionId } = await seedAccount(pool, 'pro');
    const providerSubscriptionId = `sub_${randomBytes(6).toString('hex')}`;

    // Provider detail without a provider is refused.
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET provider_state = 'active' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_provider_binding_check',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET provider_customer_id = 'cus_1' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_provider_binding_check',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET provider = 'stripe' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_provider_check',
      'paystack is the only billing provider',
    );

    await pool.query(
      `UPDATE subscriptions SET provider = 'paystack', provider_state = 'active', catalogue_plan = 'pro',
              billing_interval = 'monthly', catalogue_version = 'billing-catalogue-1',
              provider_subscription_id = $2, provider_subscription_code = $3, provider_reference = $4, provider_plan_id = $5
        WHERE id = $1`,
      [
        subscriptionId,
        providerSubscriptionId,
        `code_${randomBytes(6).toString('hex')}`,
        `ref_${randomBytes(6).toString('hex')}`,
        `plan_${randomBytes(4).toString('hex')}`,
      ],
    );

    // A provider-specific status word never reaches the database.
    for (const rejected of ['paused', 'charge.success', 'ACTIVE', 'not_renewing', '', 'active ']) {
      await assert.rejects(
        () => pool.query(`UPDATE subscriptions SET provider_state = $1 WHERE id = $2`, [rejected, subscriptionId]),
        (err: unknown) => constraintName(err) === 'subscriptions_provider_state_check',
        `provider_state must reject "${rejected}"`,
      );
    }
    for (const accepted of ['active', 'trialing', 'past_due', 'cancelled', 'unsubscribed', 'expired', 'pending', 'unknown', 'unprovisioned']) {
      await pool.query(`UPDATE subscriptions SET provider_state = $1 WHERE id = $2`, [accepted, subscriptionId]);
    }

    // A provider subscription identifier belongs to exactly one row.
    const other = await seedAccount(pool, 'free');
    await assert.rejects(
      () =>
        pool.query(`UPDATE subscriptions SET provider = 'paystack', provider_subscription_id = $1 WHERE id = $2`, [
          providerSubscriptionId,
          other.subscriptionId,
        ]),
      (err: unknown) => constraintName(err) === 'subscriptions_provider_subscription_uniq',
      'a provider subscription id cannot be claimed by a second user',
    );

    // Optimistic concurrency: a stale writer cannot rewind state_version.
    await pool.query(`UPDATE subscriptions SET state_version = 2 WHERE id = $1`, [subscriptionId]);
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET state_version = 1 WHERE id = $1`, [subscriptionId]),
      (err: unknown) => /state_version cannot decrease/.test((err as Error).message),
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET state_version = 0 WHERE id = $1`, [subscriptionId]),
      (err: unknown) =>
        /state_version cannot decrease/.test((err as Error).message) ||
        constraintName(err) === 'subscriptions_state_version_check',
      'state_version stays >= 1 and never moves backwards',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET last_event_idempotency_key = 'not-a-hash' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_last_event_idempotency_key_check',
    );
    await pool.query(
      `UPDATE subscriptions SET last_event_idempotency_key = $1, sync_state = 'synced', last_sync_source = 'webhook',
              last_synced_at = now(), sync_required = false, state_version = 3
        WHERE id = $2`,
      [sha256Text('event'), subscriptionId],
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET sync_state = 'never_synced' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_sync_coherence_check',
      'a recorded sync cannot go back to never_synced',
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET last_sync_source = 'carrier-pigeon' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_last_sync_source_check',
    );

    // Cancellation coherence.
    await pool.query(`UPDATE subscriptions SET cancel_at_period_end = false, cancelled_at = NULL WHERE id = $1`, [subscriptionId]);
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET cancelled_at = now() WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_cancellation_coherence_check',
    );
    await pool.query(
      `UPDATE subscriptions SET cancel_at_period_end = true, cancel_at = now(), cancelled_at = now(), cancellation_reason = 'user' WHERE id = $1`,
      [subscriptionId],
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET cancellation_reason = 'because' WHERE id = $1`, [subscriptionId]),
      (err: unknown) => constraintName(err) === 'subscriptions_cancellation_reason_check',
    );
  });

  test('billing_customers keeps one provider customer per user and unique provider identifiers', async () => {
    const owner = await seedAccount(pool, 'pro');
    const other = await seedAccount(pool, 'free');

    const created = await pool.query<{ id: string; status: string }>(
      `INSERT INTO billing_customers (user_id, provider, email, status, provider_customer_id, provider_customer_code, provisioned_at)
       VALUES ($1, 'paystack', $2, 'provisioned', 'cus_pr2_1', 'CUS_PR2_1', now()) RETURNING id, status`,
      [owner.userId, owner.email],
    );
    const customerId = created.rows[0]!.id;
    assert.equal(created.rows[0]!.status, 'provisioned');

    // An unprovisioned placeholder is allowed and carries no provider identity.
    const placeholder = await pool.query<{ id: string; status: string }>(
      `INSERT INTO billing_customers (user_id, provider, email) VALUES ($1, 'paystack', $2) RETURNING id, status`,
      [other.userId, other.email],
    );
    assert.equal(placeholder.rows[0]!.status, 'unprovisioned');

    await assert.rejects(
      () => pool.query(`INSERT INTO billing_customers (user_id, provider, email) VALUES ($1, 'paystack', $2)`, [owner.userId, 'second@example.com']),
      (err: unknown) => constraintName(err) === 'billing_customers_provider_user_uniq',
      'one provider customer per (provider, user)',
    );
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE billing_customers SET provider_customer_id = 'cus_pr2_1', status = 'provisioned', provisioned_at = now() WHERE id = $1`,
          [placeholder.rows[0]!.id],
        ),
      (err: unknown) => constraintName(err) === 'billing_customers_provider_customer_id_uniq',
      'a provider customer id cannot be shared by two users',
    );
    await assert.rejects(
      () => pool.query(`UPDATE billing_customers SET status = 'provisioned' WHERE id = $1`, [placeholder.rows[0]!.id]),
      (err: unknown) => pgCode(err) === '23514',
      'a provisioned customer must carry a provider identifier',
    );
    await assert.rejects(
      () => pool.query(`UPDATE billing_customers SET provider = 'stripe' WHERE id = $1`, [placeholder.rows[0]!.id]),
      (err: unknown) => pgCode(err) === '23514',
      'paystack is the only billing provider',
    );
    await assert.rejects(
      () => pool.query(`UPDATE billing_customers SET email = 'Mixed@Example.com' WHERE id = $1`, [placeholder.rows[0]!.id]),
      (err: unknown) => pgCode(err) === '23514',
      'the provider email is normalized to lowercase',
    );
    await assert.rejects(
      () => pool.query(`UPDATE billing_customers SET provisioned_at = now() WHERE id = $1`, [placeholder.rows[0]!.id]),
      (err: unknown) => pgCode(err) === '23514',
      'an unprovisioned customer carries no provisioned timestamp',
    );

    // The subscription links to its provider customer; deleting the customer
    // clears the link (ON DELETE SET NULL) instead of cascading away the
    // authoritative subscription row.
    await pool.query(
      `UPDATE subscriptions SET provider = 'paystack', billing_customer_id = $1, provider_customer_id = 'cus_pr2_1' WHERE id = $2`,
      [customerId, owner.subscriptionId],
    );
    await pool.query(`DELETE FROM billing_customers WHERE id = $1`, [customerId]);
    const after = await pool.query<{ billing_customer_id: string | null; plan: string; status: string }>(
      `SELECT billing_customer_id, plan, status FROM subscriptions WHERE id = $1`,
      [owner.subscriptionId],
    );
    assert.equal(after.rows[0]!.billing_customer_id, null, 'the link is cleared');
    assert.equal(after.rows[0]!.plan, 'pro', 'the authoritative subscription row survives');
    assert.equal(after.rows[0]!.status, 'active');
  });

  test('billing_provider_events is an idempotent, append-only ledger that stores no payload', async () => {
    const { userId, subscriptionId } = await seedAccount(pool, 'premium');
    const payloadHash = sha256Text('payload');
    const key = sha256Text(`paystack|evt_pr2_1|payment.succeeded||${payloadHash}`);

    const inserted = await pool.query<{ id: string; status: string }>(
      `INSERT INTO billing_provider_events
         (provider, event_type, provider_event_id, idempotency_key, payload_hash, subscription_id, user_id, provider_reference, occurred_at)
       VALUES ('paystack', 'payment.succeeded', 'evt_pr2_1', $1, $2, $3, $4, 'ref_pr2_1', now())
       RETURNING id, status`,
      [key, payloadHash, subscriptionId, userId],
    );
    const eventId = inserted.rows[0]!.id;
    assert.equal(inserted.rows[0]!.status, 'received');

    // Idempotency: the same key, and the same provider event id, are refused.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO billing_provider_events (provider, event_type, provider_event_id, idempotency_key, payload_hash)
           VALUES ('paystack', 'payment.succeeded', 'evt_pr2_2', $1, $2)`,
          [key, payloadHash],
        ),
      (err: unknown) => constraintName(err) === 'billing_provider_events_idempotency_uniq',
      'a replayed provider event collapses onto one row',
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO billing_provider_events (provider, event_type, provider_event_id, idempotency_key, payload_hash)
           VALUES ('paystack', 'payment.failed', 'evt_pr2_1', $1, $2)`,
          [sha256Text('other-key'), payloadHash],
        ),
      (err: unknown) => constraintName(err) === 'billing_provider_events_provider_event_uniq',
    );
    // A provider-specific event name must be normalized before it is stored.
    for (const rejected of ['charge.success', 'subscription.disabled', 'PAYMENT.SUCCEEDED', '']) {
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO billing_provider_events (provider, event_type, idempotency_key, payload_hash)
             VALUES ('paystack', $1, $2, $3)`,
            [rejected, sha256Text(`raw-${rejected}`), payloadHash],
          ),
        (err: unknown) => constraintName(err) === 'billing_provider_events_event_type_check',
        `event_type must reject the provider-specific name "${rejected}"`,
      );
    }
    // An event that cannot be mapped is stored as `unrecognized`, never guessed.
    await pool.query(
      `INSERT INTO billing_provider_events (provider, event_type, idempotency_key, payload_hash)
       VALUES ('paystack', 'unrecognized', $1, $2)`,
      [sha256Text('unrecognized'), payloadHash],
    );
    // Tenant integrity: subscription and owner must describe the same row.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO billing_provider_events (provider, event_type, idempotency_key, payload_hash, subscription_id, user_id)
           VALUES ('paystack', 'payment.succeeded', $1, $2, $3, $4)`,
          [sha256Text('tenant'), payloadHash, subscriptionId, randomUUID()],
        ),
      (err: unknown) => pgCode(err) === '23503',
      'an event cannot be bound to a subscription of another user',
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO billing_provider_events (provider, event_type, idempotency_key, payload_hash, subscription_id)
           VALUES ('paystack', 'payment.succeeded', $1, $2, $3)`,
          [sha256Text('half-bound'), payloadHash, subscriptionId],
        ),
      (err: unknown) => pgCode(err) === '23514',
      'subscription and owner are recorded together or not at all',
    );
    // No secret material is storable.
    for (const reason of ['authorization: Bearer sk_test_123', 'invalid api_key', 'token expired', 'secret leaked']) {
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO billing_provider_events (provider, event_type, idempotency_key, payload_hash, status, processed_at, failure_reason)
             VALUES ('paystack', 'payment.failed', $1, $2, 'failed', now(), $3)`,
            [sha256Text(`secret-${reason}`), payloadHash, reason],
          ),
        (err: unknown) => pgCode(err) === '23514',
        `credential-shaped material must be rejected: ${reason}`,
      );
    }

    // Append-only: identity cannot change; an unprocessed event cannot be deleted.
    await assert.rejects(
      () => pool.query(`UPDATE billing_provider_events SET event_type = 'payment.failed' WHERE id = $1`, [eventId]),
      (err: unknown) => /append-only/.test((err as Error).message),
    );
    await assert.rejects(
      () => pool.query(`UPDATE billing_provider_events SET idempotency_key = $1 WHERE id = $2`, [sha256Text('rewrite'), eventId]),
      (err: unknown) => /append-only/.test((err as Error).message),
    );
    await assert.rejects(
      () => pool.query(`UPDATE billing_provider_events SET received_at = now() WHERE id = $1`, [eventId]),
      (err: unknown) => /append-only/.test((err as Error).message),
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM billing_provider_events WHERE id = $1`, [eventId]),
      (err: unknown) => /retention/.test((err as Error).message),
      'an unprocessed provider event cannot be deleted',
    );

    // Processing state may move; a processed event is deletable.
    await pool.query(`UPDATE billing_provider_events SET status = 'processed', processed_at = now() WHERE id = $1`, [eventId]);
    const processed = await pool.query<{ status: string; processed_at: Date | null; event_type: string }>(
      `SELECT status, processed_at, event_type FROM billing_provider_events WHERE id = $1`,
      [eventId],
    );
    assert.equal(processed.rows[0]!.status, 'processed');
    assert.equal(processed.rows[0]!.event_type, 'payment.succeeded', 'identity is unchanged');
    assert.ok(processed.rows[0]!.processed_at !== null);
    await pool.query(`DELETE FROM billing_provider_events WHERE id = $1`, [eventId]);
    assert.equal((await pool.query(`SELECT 1 FROM billing_provider_events WHERE id = $1`, [eventId])).rowCount, 0);

    // A processed_at timestamp requires a terminal processing state.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO billing_provider_events (provider, event_type, idempotency_key, payload_hash, processed_at)
           VALUES ('paystack', 'payment.succeeded', $1, $2, now())`,
          [sha256Text('processed-too-early'), payloadHash],
        ),
      (err: unknown) => pgCode(err) === '23514',
    );
  });
});
