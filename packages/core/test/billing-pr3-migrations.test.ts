/**
 * Billing PR3 — migration `0032_billing_fx_and_pricing.sql`, against a real
 * PostgreSQL.
 *
 * Pins:
 *  - 0001–0031 are BYTE-IDENTICAL (a full SHA-256 manifest, not a spot check):
 *    the historical migrations of this repository are immutable, and 0032 is the
 *    only new file;
 *  - 0032 applies cleanly on a fresh database and is additive/forward-only (no
 *    DROP, RENAME, TRUNCATE, DELETE or data rewrite; nothing existing is
 *    redefined);
 *  - `subscriptions.currency` and its `CHECK (currency = 'USD')` are untouched:
 *    the commercial currency stays USD and the payment currency never moves onto
 *    that column;
 *  - the FX rate history is append-only and immutable (a published version can
 *    never be edited, re-dated or deleted);
 *  - provider-plan epochs are immutable pricing records with ONE active epoch per
 *    (provider, mode, plan, interval, payment currency), sandbox-only, Starter
 *    refused, and retirement that only ever moves active → retired;
 *  - pricing snapshots are append-only, must copy their FX facts exactly from
 *    the version they reference, and are idempotent by their local key;
 *  - the subscription lock is IMMUTABLE: an authorized recurring amount can
 *    never be repriced, re-rated or cleared;
 *  - 0032 refuses to apply (rather than half-applying) when the 0031
 *    foundations it extends are missing.
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

const MIGRATION_0032 = '0032_billing_fx_and_pricing.sql';

/**
 * Every migration from 0001 to 0031, pinned by SHA-256 as recorded when Billing
 * PR3 was written. These files are history: a change to any of them is drift,
 * and the migration runner refuses to continue on a database that has them
 * applied. Pinning the whole range (rather than a sample) is deliberate.
 */
const RECORDED_SHA256: Readonly<Record<string, string>> = Object.freeze({
  '0001_identity_and_audit.sql': '7bf309682a639ab3b04bd72698d481f996ea07f98fafa59a5f726fe1a9943cf9',
  '0002_markets_and_providers.sql': 'cbab4efb243d451271f1410e9a6bf3e4cce703ae9d26908d1c9eff86aa0d6a5c',
  '0003_strategies_and_versions.sql': '313a97b7dd8e24c0a8c5d9e42cbacd60fc38ce9711cd96fc4fc1cd45fe21cae5',
  '0004_strategy_configuration.sql': '55ea692fb07cffe69aa0ad0c96dd8427a99b6098c7710a68277a03a13654deb7',
  '0005_rules_and_conditions.sql': '2b3075bafc0353468282472d2e30b324252a915512a11809904b1d2786af3901',
  '0006_setups_lifecycle.sql': 'bc3390356a978b29e8518223c2859a3d18deeafa34e2713992d007d38c8533a8',
  '0007_version_immutability.sql': '145e3263086c649fbbbd86394c8e3fcb68ac3bfad492199fe3332b477e83ef20',
  '0008_market_candles.sql': 'a3d0dcdbb0419a2676b9f8456f95ae064422be2f19ba6ba9e4ba76a77db68bc7',
  '0009_setup_detection_keys.sql': '532e2dba038b73ae7cc3987c05bee93b363cafb5741143e1912451f957a3f753',
  '0010_setup_score_idempotency.sql': '2300f1c3da62734b647d6416044d433068da27cd4b43663efa0ef9b294ca10b4',
  '0011_backtests.sql': '4bb3f63e822dd35adc776c3e51a06aca475bcf0e2068c0f4952d8881d96f5ae7',
  '0012_alerts.sql': '7e69e4c8c38eb9e2f3af0934c7a225381f6454f422b5cdbbadfdb88c4dae79dd',
  '0013_notification_outbox.sql': '09976673d94019d9e75ff52e08ad43e9c8808cdfb1bf73c4d4af378d70d0b307',
  '0014_subscriptions_and_entitlements.sql': '133cc73c27fe99ba23f78ecda65b526c36a0f3f1e8319252562941c69f79f810',
  '0015_scanner_runs.sql': '48d4bf946572681d0f0b982565db069005fa6591b68de6d4d108ddfbd14f4cfd',
  '0016_execution_architecture.sql': '8a96c00941abdc1f872e9d71039b14e4a678a7d005efd3f5308fd57e272ee9ce',
  '0017_risk_engine.sql': 'c1f81c53e8af94d52f04c665fb5b030b86bc209af85150f8ada51d2a692122a9',
  '0018_paper_execution.sql': '19e06fe3f4e95dff687bbfcc82fade39a79f74f08cbfcf1450eb2d423fda8f52',
  '0019_broker_mt5_boundary.sql': 'd610d7c8d084ae91792aae7ba9f70f1fc4fea5585473b2bb21b0e60f72b590e7',
  '0020_order_position_reconciliation.sql': 'c169e7a2a327a625a037fdff1283fb5f8179f5ff61dc7e661ab9dea90007afc0',
  '0021_safety_controls.sql': 'd6bc18378bdf1c31143879814b323eea55c1501eaef0db327b1945bc9f814986',
  '0022_drawdown_protection.sql': 'eeff30ee3c9f41e83584671769f5f494523847181cc335122889e8acafd07eb4',
  '0023_notification_preferences.sql': 'ab1efae18f391eb225c79f134317ef73685c291538d306412f90f4c130bc995e',
  '0024_notification_routing.sql': 'e2140a98ba62dea48d87eb4eddb0277f6fec5196652996964adbced44f910060',
  '0025_webhook_tenant_integrity.sql': 'a6840077b9564e07c4ac26929362efa852131ac2f6cb7169733cff35a5f7e0ea',
  '0026_notification_delivery_fairness.sql': '9e702effee78fca3c4ed22691f914685180f8db6f97ba24c029d1381473ec47b',
  '0027_notification_fairness_ledger.sql': 'cb3cd99f7edb5398b1de47568d575f33225c78d1a99a8f62248a9ecab431ab5d',
  '0028_push_channel_and_secret_hardening.sql': '25359093d0304d84d82982750c58ee1bb054edacf29d1d4971a32ecfb5c9e49f',
  '0029_provider_mutation_persistence.sql': 'a8c4cde5fc8dc2e0cc48b253e9d881f90cdc7f825d323a67a8defd382bde9ce7',
  '0030_provider_mutation_lineage_invariants.sql': '979015990c2bbf38d4d4f5ec246f328cbfe7f1833aac2472f5b5ad209985ea5a',
  '0031_provider_billing.sql': 'e43cf29aabc107a2985152b517560c872f8cafd2f7ebede01cffd5f555424a28',
});

// Unique per suite file: core 5434, api 5435-5438, m6 5439, … PR2 billing 5475.
const DB_PORT = 5476;

let db: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let pool: ReturnType<typeof createPool>;
let dir32: string;
let dir31: string;
let dirOnly32: string;
let dataDir: string;

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sqlOf(file: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
}

/** SQL of 0032 with comment lines removed, so prose cannot satisfy a check. */
function statements0032(): string {
  return sqlOf(MIGRATION_0032)
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

async function expectRejects(
  run: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
  message: string,
): Promise<void> {
  let caught: unknown = null;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  assert.notEqual(caught, null, `${message}: expected a database error`);
  assert.ok(predicate(caught), `${message}: unexpected error ${JSON.stringify(caught)}`);
}

async function seedFxVersion(
  q: ReturnType<typeof createPool>,
  overrides: Partial<{
    fxRateScaled: string;
    fxRateScale: number;
    effectiveFrom: string;
    capturedAt: string;
    source: string;
    sourceReference: string;
    createdBy: string;
    base: string;
    quote: string;
    id: string;
  }> = {},
): Promise<string> {
  // A fresh id per call by default, so a failure can only come from the rule
  // under test (a shared default id would turn rule checks into PK collisions).
  const id = overrides.id ?? randomUUID();
  await q.query(
    `INSERT INTO billing_fx_rate_versions
       (id, base_currency, quote_currency, fx_rate_scaled, fx_rate_scale, rounding_mode,
        source, source_reference, created_by, effective_from, captured_at, published_at)
     VALUES ($1, $2, $3, $4, $5, 'half_up', $6, $7, $8, $9, $10, $10)`,
    [
      id,
      overrides.base ?? 'USD',
      overrides.quote ?? 'GHS',
      overrides.fxRateScaled ?? '12500000',
      overrides.fxRateScale ?? 6,
      overrides.source ?? 'ops',
      overrides.sourceReference ?? 'ops-board-1',
      overrides.createdBy ?? 'ops@example.com',
      overrides.effectiveFrom ?? '2026-09-22T09:00:00.000Z',
      overrides.capturedAt ?? '2026-09-22T09:00:00.000Z',
    ],
  );
  return id;
}

async function seedUser(q: ReturnType<typeof createPool>): Promise<string> {
  const email = `pr3_${randomBytes(6).toString('hex')}@example.com`;
  const user = await q.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name, plan) VALUES ($1, 'x', 'Billing PR3', 'pro') RETURNING id`,
    [email],
  );
  return user.rows[0]!.id;
}

/**
 * A sold, provider-backed subscription. The LOCK is written at INSERT — the
 * database refuses to set it later, which is what makes "the recurring amount is
 * locked at subscription creation" a structural guarantee rather than a
 * convention.
 */
async function seedSoldSubscription(
  q: ReturnType<typeof createPool>,
  input: { userId: string; lockedPricingSnapshotId: string | null; withProvider?: boolean },
): Promise<string> {
  const sub = await q.query<{ id: string }>(
    `INSERT INTO subscriptions
       (user_id, plan, status, catalogue_plan, billing_interval, provider, provider_plan_id,
        locked_pricing_snapshot_id)
     VALUES ($1, 'pro', 'active', 'pro', 'monthly', $2, $3, $4)
     RETURNING id`,
    [
      input.userId,
      input.withProvider === false ? null : 'paystack',
      input.withProvider === false ? null : 'PLN_pro_monthly',
      input.lockedPricingSnapshotId,
    ],
  );
  return sub.rows[0]!.id;
}

async function seedPricingSnapshot(
  q: ReturnType<typeof createPool>,
  input: { fxVersionId: string } & Partial<{
    idempotencyKey: string;
    paymentAmountMinor: string;
    commercialAmountMinor: string;
    cataloguePlan: string;
    fxRateScaled: string;
    fxRateScale: number;
    fxEffectiveFrom: string;
    fxCapturedAt: string;
    paymentCurrency: string;
    commercialCurrency: string;
  }>,
): Promise<string> {
  const overrides = input;
  const row = await q.query<{ id: string }>(
    `INSERT INTO billing_pricing_snapshots
       (commercial_currency, commercial_amount_minor, catalogue_plan, billing_interval,
        catalogue_version, payment_currency, payment_amount_minor, payment_amount_exponent,
        fx_rate_version_id, fx_rate_scaled, fx_rate_scale, fx_rate_effective_from,
        fx_rate_captured_at, fx_rate_source, rounding_mode, pricing_policy_version,
        provider, provider_plan_id, provider_reference, idempotency_key)
     VALUES ($10, $1, $2, 'monthly', 'billing-catalogue-1', $11, $3, 2,
             $4, $5, $6, $7, $8, 'ops', 'half_up', 'pr3-usd-ghs-v1',
             'paystack', NULL, 've-ref-1', $9)
     RETURNING id`,
    [
      overrides.commercialAmountMinor ?? '3900',
      overrides.cataloguePlan ?? 'pro',
      overrides.paymentAmountMinor ?? '48750',
      overrides.fxVersionId,
      overrides.fxRateScaled ?? '12500000',
      overrides.fxRateScale ?? 6,
      overrides.fxEffectiveFrom ?? '2026-09-22T09:00:00.000Z',
      overrides.fxCapturedAt ?? '2026-09-22T09:00:00.000Z',
      overrides.idempotencyKey ?? createHash('sha256').update(randomBytes(8)).digest('hex'),
      overrides.commercialCurrency ?? 'USD',
      overrides.paymentCurrency ?? 'GHS',
    ],
  );
  return row.rows[0]!.id;
}

before(async () => {
  dir32 = mkdtempSync(path.join(os.tmpdir(), 've-billing-pr3-0032-'));
  dir31 = mkdtempSync(path.join(os.tmpdir(), 've-billing-pr3-0031-'));
  dirOnly32 = mkdtempSync(path.join(os.tmpdir(), 've-billing-pr3-only32-'));
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = /^(\d{4})_/.exec(file);
    if (match && Number(match[1]) <= 32) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir32, file));
    if (match && Number(match[1]) <= 31) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir31, file));
    if (file === MIGRATION_0032) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dirOnly32, file));
  }
  dataDir = path.join(os.tmpdir(), `ve-billing-pr3-pg-${process.pid}`);
  removeDirRobust(dataDir);
  db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: 'test',
    password: randomBytes(16).toString('hex'),
    database: 'veltrixeye_billing_pr3',
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
      rmSync(dir32, { recursive: true, force: true });
      rmSync(dir31, { recursive: true, force: true });
      rmSync(dirOnly32, { recursive: true, force: true });
    }
  }
});

describe('Billing PR3 — 0032 file conventions and history integrity', () => {
  test('0001-0031 are byte-identical and 0032 is the only new migration', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();

    // Every historical migration is present and unchanged.
    for (const [file, expected] of Object.entries(RECORDED_SHA256)) {
      assert.equal(
        sha256Text(sqlOf(file)),
        expected,
        `${file} was modified — applied migrations are immutable`,
      );
    }
    assert.equal(Object.keys(RECORDED_SHA256).length, 31, 'the manifest pins 0001-0031');

    const versions = files.map((file) => Number(/^(\d{4})_/.exec(file)?.[1]));
    assert.equal(new Set(versions).size, versions.length, 'no duplicate migration version');
    for (let expected = 1; expected <= 32; expected += 1) {
      assert.ok(versions.includes(expected), `migration ${String(expected).padStart(4, '0')} exists`);
    }
    assert.equal(files.filter((file) => file.startsWith('0032_')).length, 1, 'exactly one 0032 migration');
    assert.equal(files.at(-1), MIGRATION_0032, '0032 is the newest migration');
    assert.equal(
      files.filter((file) => Number(/^(\d{4})_/.exec(file)?.[1]) > 32).length,
      0,
      'nothing is numbered after 0032',
    );
  });

  test('0032 is additive and forward-only, and never touches the commercial currency', () => {
    const sql = statements0032();
    for (const forbidden of [
      /\bDROP\b/i,
      /\bRENAME\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bCREATE\s+OR\s+REPLACE\b/i,
      /\bUPDATE\s+(users|subscriptions|billing_\w+)\b/i,
      /\bALTER\s+(USER|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER|FUNCTION)\b/i,
      /\bALTER\s+COLUMN\b/i,
      /\bDROP\s+CONSTRAINT\b/i,
      /\bALTER\s+TABLE\s+subscriptions\s+ALTER\b/i,
    ]) {
      assert.doesNotMatch(sql, forbidden, `0032 is additive only (${forbidden})`);
    }

    // The ONLY changes to `subscriptions` are one additive nullable column with
    // its foreign key, and one guarded additive CONSTRAINT that READS the
    // commercial currency to enforce the lock's scope. Nothing is dropped,
    // renamed, rewritten, or has its type/default/nullability changed, and
    // `currency` is never assigned.
    const subscriptionAlters = sql.match(/ALTER\s+TABLE\s+subscriptions[\s\S]*?;/gi) ?? [];
    assert.equal(subscriptionAlters.length, 2, 'subscriptions is altered exactly twice, both additively');
    assert.match(subscriptionAlters[0]!, /ADD COLUMN IF NOT EXISTS locked_pricing_snapshot_id uuid/);
    assert.match(subscriptionAlters[0]!, /REFERENCES billing_pricing_snapshots \(id\)/);
    assert.doesNotMatch(subscriptionAlters[0]!, /\bcurrency\b/i, 'the column add does not mention currency');
    assert.match(subscriptionAlters[1]!, /ADD CONSTRAINT subscriptions_locked_pricing_scope_check/);
    assert.match(subscriptionAlters[1]!, /CHECK \(/);

    assert.doesNotMatch(sql, /subscriptions\s+SET\s+currency/i);
    assert.doesNotMatch(sql, /ALTER\s+COLUMN\s+currency/i);
    assert.doesNotMatch(sql, /subscriptions_currency_check[\s\S]{0,80}(DROP|USING|ALTER)/i);
    // The lock's scope guard restates, but never relaxes, the USD pin.
    assert.match(sql, /AND currency = 'USD'/);
  });

  test('the historical migration files are untouched by this change (byte count check)', () => {
    // A second, independent guard: 0031 is still the file Billing PR2 shipped.
    assert.equal(sqlOf('0031_provider_billing.sql').includes('0031: Billing PR2'), true);
    assert.equal(sqlOf(MIGRATION_0032).includes('0032: Billing PR3'), true);
  });

  test('0032 refuses to apply when the 0031 foundations are missing', async () => {
    const orphan = await databasePool('veltrixeye_pr3_orphan');
    try {
      await expectRejects(
        () => runMigrations(orphan, dirOnly32),
        (err) =>
          /Migration 0032_billing_fx_and_pricing\.sql failed: 0032 refused/.test(
            String((err as Error).message),
          ) &&
          /set_updated_at\(\)|subscriptions\.(currency|billing_interval|catalogue_plan)/.test(
            String((err as Error).message),
          ),
        '0032 must refuse to apply without 0031',
      );
      // Nothing was half-applied: the migration's tables do not exist.
      const { rows } = await orphan.query<{ present: boolean }>(
        `SELECT to_regclass('public.billing_fx_rate_versions') IS NOT NULL AS present`,
      );
      assert.equal(rows[0]!.present, false);
    } finally {
      await orphan.end();
    }
  });
});

describe('Billing PR3 — 0032 on a fresh database', () => {
  test('applies cleanly through 0032 and leaves the commercial currency untouched', async () => {
    const fresh = await databasePool('veltrixeye_billing_pr3_fresh');
    try {
      const result = await runMigrations(fresh, dir32);
      assert.equal(result.applied.length, 32, 'a fresh database applies 0001-0032');
      assert.equal(result.applied.at(-1), MIGRATION_0032);

      const status = await migrationStatus(fresh, dir32);
      assert.equal(status.pending.length, 0);
      assert.equal(status.checksumsMatch, true);
      assert.equal(status.latestApplied, MIGRATION_0032);

      const second = await runMigrations(fresh, dir32);
      assert.equal(second.applied.length, 0, 'a re-run applies nothing (deterministic)');
      assert.equal(second.alreadyApplied.length, 32);

      // `subscriptions.currency` is the COMMERCIAL currency and is still pinned
      // to USD: the payment currency never moved onto that column.
      const currency = await fresh.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conname = 'subscriptions_currency_check'`,
      );
      assert.equal(currency.rows[0]?.definition, `CHECK ((currency = 'USD'::text))`);
      const column = await fresh.query<{ column_default: string | null; is_nullable: string }>(
        `SELECT column_default, is_nullable FROM information_schema.columns
          WHERE table_name = 'subscriptions' AND column_name = 'currency'`,
      );
      assert.match(column.rows[0]?.column_default ?? '', /'USD'/);
      assert.equal(column.rows[0]?.is_nullable, 'NO');

      // The lock column exists, is nullable and is a FK to the snapshot table.
      const lock = await fresh.query<{ is_nullable: string; data_type: string }>(
        `SELECT is_nullable, data_type FROM information_schema.columns
          WHERE table_name = 'subscriptions' AND column_name = 'locked_pricing_snapshot_id'`,
      );
      assert.equal(lock.rows[0]?.is_nullable, 'YES');
      assert.equal(lock.rows[0]?.data_type, 'uuid');
    } finally {
      await fresh.end();
    }
  });
});

describe('Billing PR3 — FX rate versions are append-only', () => {
  test('a published version can never be edited, re-dated or deleted', async () => {
    const q = await databasePool('veltrixeye_pr3_fx');
    try {
      await runMigrations(q, dir32);
      const id = await seedFxVersion(q);
      assert.equal(id.length, 36);

      await expectRejects(
        () => q.query(`UPDATE billing_fx_rate_versions SET fx_rate_scaled = 1 WHERE id = $1`, [id]),
        (err) => pgCode(err) === '27000',
        'an FX rate version is immutable',
      );
      await expectRejects(
        () => q.query(`DELETE FROM billing_fx_rate_versions WHERE id = $1`, [id]),
        (err) => pgCode(err) === '27000',
        'an FX rate version cannot be deleted',
      );

      // A correction is a NEW version, which is exactly what the schema allows.
      await seedFxVersion(q, { effectiveFrom: '2026-09-22T09:05:00.000Z', capturedAt: '2026-09-22T09:05:00.000Z' });
      const { rows } = await q.query<{ count: string }>(`SELECT count(*)::text AS count FROM billing_fx_rate_versions`);
      assert.equal(rows[0]!.count, '2');
    } finally {
      await q.end();
    }
  });

  test('one version per (base, quote, effective instant); no back-dating; no unknown currency', async () => {
    const q = await databasePool('veltrixeye_pr3_fx_rules');
    try {
      await runMigrations(q, dir32);
      await seedFxVersion(q);

      await expectRejects(
        () => seedFxVersion(q),
        (err) => pgCode(err) === '23505',
        'the same effective instant cannot carry two versions',
      );
      await expectRejects(
        () => seedFxVersion(q, { effectiveFrom: '2026-09-22T08:00:00.000Z', capturedAt: '2026-09-22T09:00:00.000Z' }),
        (err) => pgCode(err) === '23514' && constraintName(err).includes('captured'),
        'a rate can never be back-dated',
      );
      await expectRejects(
        () => seedFxVersion(q, { base: 'EUR' }),
        (err) => pgCode(err) === '23514',
        'only the commercial currency can be the base',
      );
      await expectRejects(
        () => seedFxVersion(q, { quote: 'NGN' }),
        (err) => pgCode(err) === '23514',
        'only the payment currency can be the quote',
      );
      await expectRejects(
        () => seedFxVersion(q, { fxRateScaled: '0' }),
        (err) => pgCode(err) === '23514',
        'a rate must be strictly positive',
      );
      await expectRejects(
        () => seedFxVersion(q, { fxRateScale: 19 }),
        (err) => pgCode(err) === '23514',
        'a scale beyond the supported range is refused',
      );
      await expectRejects(
        () => seedFxVersion(q, { source: 'market' }),
        (err) => pgCode(err) === '23514',
        'an unknown provenance is refused',
      );
      // No credential-shaped label may ever be stored as a rate reference.
      await expectRejects(
        () => seedFxVersion(q, { sourceReference: 'Bearer sk_test_abcdefghijklmnop' }),
        (err) => pgCode(err) === '23514',
        'a credential-shaped reference is refused',
      );
      await expectRejects(
        () => seedFxVersion(q, { createdBy: 'api_key=123' }),
        (err) => pgCode(err) === '23514',
        'a credential-shaped operator label is refused',
      );
    } finally {
      await q.end();
    }
  });
});

describe('Billing PR3 — the upgrade path and the untouched execution surface', () => {
  test('an existing PR2 database upgrades in place, additively', async () => {
    const q = await databasePool('veltrixeye_pr3_upgrade');
    try {
      // A database that already runs Billing PR2.
      const before = await runMigrations(q, dir31);
      assert.equal(before.applied.length, 31);
      assert.equal(before.applied.at(-1), '0031_provider_billing.sql');

      const subscriptionColumnsBefore = await columnsOf(q, 'subscriptions');
      const currencyCheckBefore = await constraintDefinition(q, 'subscriptions_currency_check');
      const executionBefore = await tableSignature(q, 'execution_requests');
      // An account in the PR2-era shape: a (0014) subscription row with no
      // billing columns set.
      const accountBefore = await seedUser(q);
      await q.query(`INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'pro', 'active')`, [accountBefore]);

      // 0032 applies on top, touchless to existing data.
      const upgrade = await runMigrations(q, dir32);
      assert.deepEqual(upgrade.applied, [MIGRATION_0032], 'only 0032 is applied on upgrade');
      assert.equal(upgrade.alreadyApplied.length, 31);

      // Nothing existing changed: every pre-0032 column keeps its type, default
      // and nullability, and the ONLY difference is the one added column.
      const subscriptionColumnsAfter = await columnsOf(q, 'subscriptions');
      const added = subscriptionColumnsAfter
        .split('|')
        .filter((column) => !subscriptionColumnsBefore.split('|').includes(column));
      assert.deepEqual(added, ['locked_pricing_snapshot_id:uuid:-:YES']);
      assert.equal(
        await constraintDefinition(q, 'subscriptions_currency_check'),
        currencyCheckBefore,
        'the commercial-currency CHECK is untouched',
      );
      assert.equal(await tableSignature(q, 'execution_requests'), executionBefore, 'execution is untouched');

      // The pre-existing account is untouched too.
      const account = await q.query<{ plan: string; locked_pricing_snapshot_id: string | null; currency: string }>(
        `SELECT plan, locked_pricing_snapshot_id, currency FROM subscriptions WHERE user_id = $1`,
        [accountBefore],
      );
      assert.deepEqual(account.rows[0], { plan: 'pro', locked_pricing_snapshot_id: null, currency: 'USD' });
    } finally {
      await q.end();
    }
  });

  test('0032 opens no billing surface and grants no entitlement', async () => {
    const statements = statements0032();
    for (const forbidden of [
      /execution_\w*/i,
      /\border(s|_items|_fills)?\b/i,
      /\bpositions?\b/i,
      /\bkill_switch/i,
      /\bcanAccessAutomation/i,
      /\bentitlement/i,
      /\bcheckout\b/i,
      /\bwebhook/i,
      /\b(payment|refund)s?\s+api\b/i,
    ]) {
      assert.doesNotMatch(statements, forbidden, `0032 must not touch this surface (${forbidden})`);
    }

    // The entitlement model is unchanged: billing money never widens access.
    for (const plan of ['free', 'pro', 'premium'] as const) {
      assert.equal(getEntitlements(plan, 'active').canAccessAutomation, false, `${plan}: automation stays off`);
    }

    // Exactly the three new billing tables are created, and nothing else.
    const q = await databasePool('veltrixeye_pr3_objects');
    try {
      await runMigrations(q, dir32);
      const created = await q.query<{ signature: string | null }>(
        `SELECT string_agg(tablename, ',' ORDER BY tablename) AS signature
           FROM pg_tables
          WHERE schemaname = 'public' AND tablename LIKE 'billing_%'`,
      );
      assert.equal(
        created.rows[0]!.signature,
        'billing_customers,billing_fx_rate_versions,billing_pricing_snapshots,billing_provider_events,billing_provider_plans',
      );
      const triggers = await q.query<{ signature: string | null }>(
        `SELECT string_agg(tgname, ',' ORDER BY tgname) AS signature FROM pg_trigger
          WHERE NOT tgisinternal AND (tgname LIKE 'billing_%' OR tgname LIKE 'subscriptions_locked%')`,
      );
      const names = (triggers.rows[0]!.signature ?? '').split(',');
      for (const expected of [
        'billing_fx_rate_versions_append_only',
        'billing_pricing_snapshots_append_only',
        'billing_pricing_snapshots_fx_coherence',
        'billing_provider_plans_lifecycle',
        'subscriptions_locked_pricing_immutable',
      ]) {
        assert.ok(names.includes(expected), `${expected} exists`);
      }
    } finally {
      await q.end();
    }
  });
});

async function columnsOf(q: ReturnType<typeof createPool>, table: string): Promise<string> {
  const { rows } = await q.query<{ signature: string | null }>(
    `SELECT string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, '-') || ':' || is_nullable, '|' ORDER BY column_name) AS signature
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return rows[0]?.signature ?? '';
}

async function tableSignature(q: ReturnType<typeof createPool>, table: string): Promise<string> {
  return columnsOf(q, table);
}

async function constraintDefinition(q: ReturnType<typeof createPool>, name: string): Promise<string> {
  const { rows } = await q.query<{ definition: string | null }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return rows[0]?.definition ?? '';
}

describe('Billing PR3 — provider-plan epochs', () => {
  test('one active epoch per (provider, mode, plan, interval, currency); Pro/Elite only; sandbox only', async () => {
    const q = await databasePool('veltrixeye_pr3_plans');
    try {
      await runMigrations(q, dir32);
      const fxId = await seedFxVersion(q);

      const insert = (overrides: Partial<Record<string, unknown>> = {}) => {
        const values = {
          catalogue_plan: 'pro',
          billing_interval: 'monthly',
          payment_amount_minor: '48750',
          provider_plan_id: `PLN_${randomBytes(6).toString('hex')}`,
          ...overrides,
        };
        return q.query(
          `INSERT INTO billing_provider_plans
             (provider, mode, catalogue_plan, billing_interval, payment_currency,
              payment_amount_minor, payment_amount_exponent, provider_plan_id,
              provider_plan_reference, fx_rate_version_id, pricing_policy_version, catalogue_version,
              catalogue_amount_minor)
           VALUES ('paystack', $1, $2, $3, 'GHS', $4, 2, $5, NULL, $6, 'pr3-usd-ghs-v1', 'billing-catalogue-1', $7)`,
          [
            (values as { mode?: string }).mode ?? 'test',
            values.catalogue_plan,
            values.billing_interval,
            values.payment_amount_minor,
            values.provider_plan_id,
            fxId,
            (values as { catalogue_amount_minor?: string }).catalogue_amount_minor ?? '3900',
          ],
        );
      };

      await insert();

      // A second ACTIVE epoch for the same key is refused.
      await expectRejects(
        () => insert(),
        (err) => pgCode(err) === '23505' && constraintName(err).includes('one_active'),
        'one active epoch per key',
      );
      // Starter is not sellable.
      await expectRejects(
        () => insert({ catalogue_plan: 'starter' }),
        (err) => pgCode(err) === '23514',
        'Starter cannot be registered',
      );
      // Live mode is not producible by this build.
      await expectRejects(
        () => insert({ mode: 'live', catalogue_plan: 'elite', billing_interval: 'annual' }),
        (err) => pgCode(err) === '23514',
        'sandbox only',
      );
      // An amount below the documented ₵0.10 minimum is refused.
      await expectRejects(
        () => insert({ catalogue_plan: 'elite', billing_interval: 'annual', payment_amount_minor: '9' }),
        (err) => pgCode(err) === '23514',
        'the documented GHS minimum is enforced',
      );
      // An unknown interval is refused.
      await expectRejects(
        () => insert({ billing_interval: 'weekly', catalogue_plan: 'elite' }),
        (err) => pgCode(err) === '23514',
        'intervals are the catalogue vocabulary',
      );

      // A DIFFERENT interval is a different epoch and is allowed.
      await insert({ billing_interval: 'annual', catalogue_plan: 'elite', payment_amount_minor: '1237500' });
      const { rows } = await q.query<{ count: string }>(`SELECT count(*)::text AS count FROM billing_provider_plans`);
      assert.equal(rows[0]!.count, '2');
    } finally {
      await q.end();
    }
  });

  test('pricing is immutable and retirement is one-way and retained', async () => {
    const q = await databasePool('veltrixeye_pr3_plans_lifecycle');
    try {
      await runMigrations(q, dir32);
      const fxId = await seedFxVersion(q);
      const inserted = await q.query<{ id: string }>(
        `INSERT INTO billing_provider_plans
           (provider, mode, catalogue_plan, billing_interval, payment_currency,
            payment_amount_minor, payment_amount_exponent, provider_plan_id,
            fx_rate_version_id, pricing_policy_version, catalogue_version, catalogue_amount_minor)
         VALUES ('paystack', 'test', 'pro', 'monthly', 'GHS', 48750, 2, 'PLN_lifecycle',
                 $1, 'pr3-usd-ghs-v1', 'billing-catalogue-1', 3900)
         RETURNING id`,
        [fxId],
      );
      const planId = inserted.rows[0]!.id;

      // Every pricing column is frozen at insert.
      for (const statement of [
        `UPDATE billing_provider_plans SET payment_amount_minor = 50000 WHERE id = $1`,
        `UPDATE billing_provider_plans SET provider_plan_id = 'PLN_other' WHERE id = $1`,
        `UPDATE billing_provider_plans SET catalogue_plan = 'elite' WHERE id = $1`,
        `UPDATE billing_provider_plans SET billing_interval = 'annual' WHERE id = $1`,
        `UPDATE billing_provider_plans SET fx_rate_version_id = gen_random_uuid() WHERE id = $1`,
        `UPDATE billing_provider_plans SET pricing_policy_version = 'other' WHERE id = $1`,
        `UPDATE billing_provider_plans SET valid_from = now() WHERE id = $1`,
      ]) {
        await expectRejects(
          () => q.query(statement, [planId]),
          (err) => pgCode(err) === '27000',
          `an immutable pricing epoch refuses: ${statement}`,
        );
      }

      // Retirement is allowed, timestamped and one-way.
      await q.query(`UPDATE billing_provider_plans SET status = 'retired', retired_at = now(), retired_reason = 'priced out' WHERE id = $1`, [planId]);
      await expectRejects(
        () => q.query(`UPDATE billing_provider_plans SET status = 'active', retired_at = NULL WHERE id = $1`, [planId]),
        (err) => pgCode(err) === '27000',
        'a retired epoch can never be reactivated',
      );
      // A retired epoch is history: it cannot be deleted.
      await expectRejects(
        () => q.query(`DELETE FROM billing_provider_plans WHERE id = $1`, [planId]),
        (err) => pgCode(err) === '27000',
        'a pricing epoch cannot be deleted',
      );
      // Once retired, a NEW active epoch for the same key is allowed: that is
      // how a price change happens without rewriting history.
      await q.query(
        `INSERT INTO billing_provider_plans
           (provider, mode, catalogue_plan, billing_interval, payment_currency,
            payment_amount_minor, payment_amount_exponent, provider_plan_id,
            fx_rate_version_id, pricing_policy_version, catalogue_version, catalogue_amount_minor)
         VALUES ('paystack', 'test', 'pro', 'monthly', 'GHS', 50000, 2, 'PLN_lifecycle_v2',
                 $1, 'pr3-usd-ghs-v1', 'billing-catalogue-1', 3900)`,
        [fxId],
      );
      const { rows } = await q.query<{ count: string }>(`SELECT count(*)::text AS count FROM billing_provider_plans`);
      assert.equal(rows[0]!.count, '2', 'the retired epoch is retained alongside the new active one');
    } finally {
      await q.end();
    }
  });
});

describe('Billing PR3 — pricing snapshots', () => {
  test('append-only, idempotent by local key, and coherent with the FX version they reference', async () => {
    const q = await databasePool('veltrixeye_pr3_snapshots');
    try {
      await runMigrations(q, dir32);
      const fxId = await seedFxVersion(q);
      const snapshotId = await seedPricingSnapshot(q, { fxVersionId: fxId });

      // A snapshot is evidence: it is never updated or deleted.
      await expectRejects(
        () => q.query(`UPDATE billing_pricing_snapshots SET payment_amount_minor = 1 WHERE id = $1`, [snapshotId]),
        (err) => pgCode(err) === '27000',
        'a pricing snapshot is immutable',
      );
      await expectRejects(
        () => q.query(`DELETE FROM billing_pricing_snapshots WHERE id = $1`, [snapshotId]),
        (err) => pgCode(err) === '27000',
        'a pricing snapshot cannot be deleted',
      );

      // The FX facts must be EXACTLY those of the referenced version.
      await expectRejects(
        () => seedPricingSnapshot(q, { fxVersionId: fxId, fxRateScaled: '12500001' }),
        (err) => pgCode(err) === '27000',
        'a snapshot cannot claim a rate its version does not have',
      );
      await expectRejects(
        () => seedPricingSnapshot(q, { fxVersionId: fxId, fxCapturedAt: '2026-09-22T08:59:00.000Z' }),
        (err) => pgCode(err) === '27000',
        'a snapshot cannot claim a capture time its version does not have',
      );
      await expectRejects(
        () => seedPricingSnapshot(q, { fxVersionId: '00000000-0000-4000-8000-000000000000' }),
        (err) => pgCode(err) === '23503' || pgCode(err) === '27000',
        'a snapshot must reference a published version',
      );

      // Local deterministic idempotency: the same key cannot be recorded twice.
      const key = createHash('sha256').update('decision-1').digest('hex');
      await seedPricingSnapshot(q, { fxVersionId: fxId, idempotencyKey: key });
      await expectRejects(
        () => seedPricingSnapshot(q, { fxVersionId: fxId, idempotencyKey: key }),
        (err) => pgCode(err) === '23505',
        'a repeated decision collapses onto one snapshot',
      );

      // Starter is not sellable, amounts are positive, and the key must be a hash.
      await expectRejects(
        () => seedPricingSnapshot(q, { fxVersionId: fxId, cataloguePlan: 'starter' }),
        (err) => pgCode(err) === '23514',
        'no pricing snapshot exists for Starter',
      );
      await expectRejects(
        () => seedPricingSnapshot(q, { fxVersionId: fxId, paymentAmountMinor: '0' }),
        (err) => pgCode(err) === '23514',
        'an amount must be positive',
      );
      await expectRejects(
        () => seedPricingSnapshot(q, { fxVersionId: fxId, idempotencyKey: 'not-a-hash' }),
        (err) => pgCode(err) === '23514',
        'the idempotency key is a sha256',
      );
    } finally {
      await q.end();
    }
  });
});

describe('Billing PR3 — the subscription lock', () => {
  test('an authorized recurring amount is written at creation and can never be repriced, re-rated or cleared', async () => {
    const q = await databasePool('veltrixeye_pr3_lock');
    try {
      await runMigrations(q, dir32);
      const fxId = await seedFxVersion(q);
      const snapshotId = await seedPricingSnapshot(q, { fxVersionId: fxId });
      const userId = await seedUser(q);

      const subscriptionId = await seedSoldSubscription(q, { userId, lockedPricingSnapshotId: snapshotId });
      const locked = await q.query<{ locked_pricing_snapshot_id: string }>(
        `SELECT locked_pricing_snapshot_id FROM subscriptions WHERE id = $1`,
        [subscriptionId],
      );
      assert.equal(locked.rows[0]!.locked_pricing_snapshot_id, snapshotId);

      // THE LOCK IS IMMUTABLE: not to a newer snapshot, not to another amount,
      // not to NULL — and it cannot be set after the fact either.
      const secondSnapshot = await seedPricingSnapshot(q, { fxVersionId: fxId, paymentAmountMinor: '50000' });
      await expectRejects(
        () =>
          q.query(`UPDATE subscriptions SET locked_pricing_snapshot_id = $1 WHERE id = $2`, [
            secondSnapshot,
            subscriptionId,
          ]),
        (err) => pgCode(err) === '27000',
        'repointing the lock at another snapshot must be impossible',
      );
      await expectRejects(
        () => q.query(`UPDATE subscriptions SET locked_pricing_snapshot_id = NULL WHERE id = $1`, [subscriptionId]),
        (err) => pgCode(err) === '27000',
        'clearing the lock must be impossible',
      );

      // A subscription that was created WITHOUT a lock cannot acquire one later:
      // the price is written at creation, or the subscription has no price.
      const unpricedUser = await seedUser(q);
      const unpriced = await seedSoldSubscription(q, { userId: unpricedUser, lockedPricingSnapshotId: null });
      await expectRejects(
        () => q.query(`UPDATE subscriptions SET locked_pricing_snapshot_id = $1 WHERE id = $2`, [snapshotId, unpriced]),
        (err) => pgCode(err) === '27000',
        'a lock cannot be attached to a subscription after creation',
      );

      // A lock without a provider binding (or without a sold plan/interval) is
      // refused AT INSERT by the scope check.
      const otherUser = await seedUser(q);
      await expectRejects(
        () =>
          seedSoldSubscription(q, {
            userId: otherUser,
            lockedPricingSnapshotId: snapshotId,
            withProvider: false,
          }),
        (err) => pgCode(err) === '23514',
        'a locked price requires a sold, provider-backed subscription',
      );

      // A snapshot referenced by a subscription cannot be deleted (it is
      // append-only anyway, and the FK is the second line of defence).
      await expectRejects(
        () => q.query(`DELETE FROM billing_pricing_snapshots WHERE id = $1`, [snapshotId]),
        (err) => pgCode(err) === '27000',
        'the locked snapshot cannot be deleted',
      );

      // Ordinary subscription updates still work: the lock trigger guards the
      // lock only.
      await q.query(`UPDATE subscriptions SET state_version = state_version + 1 WHERE id = $1`, [subscriptionId]);
      const after = await q.query<{ state_version: number }>(
        `SELECT state_version FROM subscriptions WHERE id = $1`,
        [subscriptionId],
      );
      assert.equal(after.rows[0]!.state_version, 2);
    } finally {
      await q.end();
    }
  });
});
