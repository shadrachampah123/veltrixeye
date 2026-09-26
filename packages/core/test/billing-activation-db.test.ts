/**
 * Billing Step 8 — migration `0034_billing_activation.sql`, against a real
 * PostgreSQL.
 *
 * Pins what only the database can prove about the activation-fact ledger:
 *  - migrations 0001–0033 are BYTE-IDENTICAL to the baseline (a full SHA-256
 *    manifest), and 0034 is the single new file;
 *  - 0034 applies cleanly on a fresh database and is additive/forward-only
 *    (no DROP, RENAME, TRUNCATE, DELETE or data rewrite; nothing existing is
 *    redefined), and it refuses to apply when the 0033 evidence ledger it
 *    extends is missing rather than half-applying;
 *  - the COHERENCE TRIGGER refuses a fact that disagrees with its
 *    subscription, its immutable pricing snapshot or its verified evidence on
 *    any identity-bearing field, and refuses Starter and the excluded
 *    capability-evidence provider plan;
 *  - the table is APPEND-ONLY: UPDATE and DELETE are refused;
 *  - exactly one fact per subscription, per evidence row and per idempotency
 *    key.
 *
 * No provider is contacted: this suite only runs SQL through the repository's
 * migration runner, or through the fixtures that write coherent rows.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startEmbeddedPostgres, removeDirRobust } from '../../../scripts/db/embedded.mjs';
import {
  billingSubscriptionActivationIdempotencyKey, createPool, MIGRATIONS_DIR, runMigrations,
} from '../src/index.js';
import {
  insertUser, seedActivatedSubscription, seedCommercialSubscription, seedPaymentEvidence,
} from './helpers/billing-checkout.js';
import type { SeededCommercial } from './helpers/billing-checkout.js';

const MIGRATION_0034 = '0034_billing_activation.sql';
const DB_PORT = 5502;

/**
 * SHA-256 of every migration this build inherits from the baseline. Recorded
 * against the Step 7 tip: 0001–0033 are immutable, and any byte-level change
 * to one of them is a failure here first.
 */
const BASELINE_SHA256: Readonly<Record<string, string>> = Object.freeze({
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
  '0032_billing_fx_and_pricing.sql': '0a7577cda8021a32a723a21827985605a93255fcc499364a36550c9f5b8a4b80',
  '0033_billing_payment_evidence.sql': '0a7dd40eea21c243727e8ba1bf8accdf04d973c93ecad78fe29004f5971165de',
});

/** The one provider plan that is capability evidence only, never an epoch. */
const EXCLUDED_PROVIDER_PLAN = ['PLN', 'u0l4961hhipl6ek'].join('_');

let pool: Awaited<ReturnType<typeof createPool>>;
let dataDir: string;

before(async () => {
  dataDir = path.join(os.tmpdir(), `ve-billing-0034-pg-${process.pid}`);
  removeDirRobust(dataDir);
  const db = await startEmbeddedPostgres({
    dataDir, port: DB_PORT, user: 'test', password: randomBytes(16).toString('hex'),
    database: 'veltrixeye_billing_0034',
  });
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
}, { timeout: 180_000 });

after(async () => {
  try {
    await pool?.end();
  } finally {
    if (dataDir) removeDirRobust(dataDir);
  }
});

/* ==========================================================================
   A. File conventions and history integrity
   ========================================================================== */

describe('Step 8 — 0034 file conventions and history integrity', () => {
  test('0001-0033 are byte-identical and 0034 is the only new migration', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();

    for (const [file, expected] of Object.entries(BASELINE_SHA256)) {
      assert.equal(
        createHash('sha256').update(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')).digest('hex'),
        expected,
        `${file} was modified — applied migrations are immutable`,
      );
    }
    assert.equal(Object.keys(BASELINE_SHA256).length, 33, 'the manifest pins 0001-0033');

    const versions = files.map((file) => Number(/^(\d{4})_/.exec(file)?.[1]));
    assert.equal(new Set(versions).size, versions.length, 'no duplicate migration version');
    for (let expected = 1; expected <= 34; expected += 1) {
      assert.ok(versions.includes(expected), `migration ${String(expected).padStart(4, '0')} exists`);
    }
    assert.equal(files.filter((file) => file.startsWith('0034_')).length, 1, 'exactly one 0034 migration');
    assert.equal(files.at(-1), MIGRATION_0034, '0034 is the newest migration');
    assert.equal(
      files.filter((file) => Number(/^(\d{4})_/.exec(file)?.[1]) > 34).length,
      0,
      'nothing is numbered after 0034',
    );
  });

  test('0034 is additive and forward-only, and reuses rather than redeclares helpers', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_0034), 'utf8');
    for (const forbidden of [/\bDROP\b/i, /\bRENAME\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bALTER\s+TABLE\b/i]) {
      assert.doesNotMatch(sql, forbidden, '0034 creates; it never rewrites an existing object');
    }
    assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+set_updated_at/i,
      'the 0001 helper is reused, never redeclared');
    assert.match(sql, /EXECUTE FUNCTION set_updated_at\(\)/, '0034 reuses the 0001 helper');
    // It extends exactly the foundations that exist.
    assert.match(sql, /billing_verified_transactions/);
    assert.match(sql, /billing_pricing_snapshots/);
  });

  test('0034 refuses to apply when the 0033 evidence ledger is missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 've-billing-0034-only-'));
    try {
      for (const file of readdirSync(MIGRATIONS_DIR)) {
        const match = /^(\d{4})_/.exec(file);
        if (match && Number(match[1]) <= 32) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
        if (file === MIGRATION_0034) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
      }
      const dir32 = mkdtempSync(path.join(os.tmpdir(), 've-billing-0034-base-'));
      try {
        for (const file of readdirSync(MIGRATIONS_DIR)) {
          const match = /^(\d{4})_/.exec(file);
          if (match && Number(match[1]) <= 32) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir32, file));
        }
        const dataDir34 = path.join(os.tmpdir(), `ve-billing-0034-refuse-${process.pid}`);
        removeDirRobust(dataDir34);
        const db = await startEmbeddedPostgres({
          dataDir: dataDir34, port: DB_PORT + 1, user: 'test',
          password: randomBytes(16).toString('hex'), database: 'veltrixeye_billing_0034_refuse',
        });
        const refusePool = createPool({ databaseUrl: db.dbUrl });
        try {
          await runMigrations(refusePool, dir32);
          await assert.rejects(
            runMigrations(refusePool, dir),
            /0034 refused/,
            '0034 refuses instead of half-applying without 0033',
          );
        } finally {
          await refusePool.end();
          await db.stop();
          removeDirRobust(dataDir34);
        }
      } finally {
        rmSync(dir32, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ==========================================================================
   B. Shape
   ========================================================================== */

describe('Step 8 — the activation-fact ledger exists with the documented shape', () => {
  test('every documented column, constraint and index is present', async () => {
    const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'billing_subscription_activations' ORDER BY column_name`,
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'activated_at', 'activation_reason', 'billing_interval', 'catalogue_plan', 'created_at',
      'evidence_hash', 'evidence_id', 'id', 'idempotency_key', 'operator_id',
      'payment_amount_exponent', 'payment_amount_minor', 'payment_currency',
      'pricing_snapshot_id', 'provider', 'provider_plan_id', 'provider_reference',
      'subscription_id', 'updated_at', 'user_id',
    ]);

    const notNull = columns.rows.filter((row) => row.is_nullable === 'NO').map((row) => row.column_name);
    for (const required of ['user_id', 'subscription_id', 'pricing_snapshot_id', 'evidence_id',
      'catalogue_plan', 'billing_interval', 'provider', 'provider_reference', 'payment_currency',
      'payment_amount_minor', 'payment_amount_exponent', 'evidence_hash', 'operator_id',
      'activation_reason', 'activated_at', 'idempotency_key']) {
      assert.ok(notNull.includes(required), `${required} is NOT NULL`);
    }

    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'billing_subscription_activations'::regclass ORDER BY conname`,
    );
    assert.ok(constraints.rows.some((row) => row.conname === 'billing_subscription_activations_provider_check'));
    assert.ok(constraints.rows.some((row) => row.conname === 'billing_subscription_activations_catalogue_plan_check'));
    assert.ok(constraints.rows.some((row) => row.conname === 'billing_subscription_activations_currency_check'));
    assert.ok(constraints.rows.some((row) => row.conname === 'billing_subscription_activations_exponent_check'));
    assert.ok(constraints.rows.some((row) => row.conname === 'billing_subscription_activations_amount_check'));
    assert.ok(constraints.rows.some((row) => row.conname === 'billing_subscription_activations_credential_shape_check'));

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'billing_subscription_activations' ORDER BY indexname`,
    );
    assert.ok(indexes.rows.some((row) => row.indexname === 'billing_subscription_activations_subscription_uniq'));
    assert.ok(indexes.rows.some((row) => row.indexname === 'billing_subscription_activations_evidence_uniq'));
    assert.ok(indexes.rows.some((row) => row.indexname === 'billing_subscription_activations_idempotency_uniq'));

    const triggers = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'billing_subscription_activations'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    assert.ok(triggers.rows.some((row) => row.tgname === 'billing_subscription_activations_append_only'));
    assert.ok(triggers.rows.some((row) => row.tgname === 'billing_subscription_activations_coherent'));
  });

  test('no payment_confirmed column exists anywhere in the billing schema', async () => {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name = 'payment_confirmed'`,
    );
    assert.deepEqual(rows, [], 'payment confirmation is derived, never stored');
  });
});

/* ==========================================================================
   C. Coherence — the database is the last line of defence
   ========================================================================== */

/** The coherent baseline: a real commercial subscription plus its evidence. */
async function coherent(): Promise<{
  userId: string;
  subscriptionId: string;
  pricingSnapshotId: string;
  evidenceId: string;
  reference: string;
  amountMinor: number;
  evidenceHash: string;
  idempotencyKey: string;
  commercial: SeededCommercial;
}> {
  const user = await insertUser(pool, true);
  const commercial = await seedCommercialSubscription(pool, user.id);
  const evidence = await seedPaymentEvidence(pool, user.id, commercial);
  return {
    userId: user.id,
    commercial,
    subscriptionId: commercial.subscriptionId,
    pricingSnapshotId: commercial.pricingSnapshotId,
    evidenceId: evidence.evidenceId,
    reference: commercial.reference,
    amountMinor: commercial.amountMinor,
    evidenceHash: evidence.evidenceHash,
    idempotencyKey: billingSubscriptionActivationIdempotencyKey({
      provider: 'paystack', providerReference: commercial.reference,
      pricingSnapshotId: commercial.pricingSnapshotId,
    }),
  };
}

/** The identity a fact must carry to be coherent with the rows it cites. */
type FactSeed = Pick<
  Awaited<ReturnType<typeof coherent>>,
  'userId' | 'subscriptionId' | 'pricingSnapshotId' | 'evidenceId' | 'reference'
  | 'amountMinor' | 'evidenceHash' | 'idempotencyKey'
>;

/** Insert a fact with the given overrides, bypassing the service on purpose. */
async function insertFact(seed: FactSeed, overrides: Record<string, unknown> = {}) {
  const row = {
    user_id: seed.userId,
    subscription_id: seed.subscriptionId,
    pricing_snapshot_id: seed.pricingSnapshotId,
    evidence_id: seed.evidenceId,
    catalogue_plan: 'pro',
    billing_interval: 'monthly',
    provider: 'paystack',
    provider_plan_id: (await pool.query<{ provider_plan_id: string }>(
      'SELECT provider_plan_id FROM subscriptions WHERE id = $1', [seed.subscriptionId],
    )).rows[0]!.provider_plan_id,
    provider_reference: seed.reference,
    payment_currency: 'GHS',
    payment_amount_minor: seed.amountMinor,
    payment_amount_exponent: 2,
    evidence_hash: seed.evidenceHash,
    operator_id: 'ops-db-test',
    activation_reason: 'direct database probe',
    activated_at: new Date('2026-09-23T10:00:00.000Z'),
    idempotency_key: seed.idempotencyKey,
    ...overrides,
  };
  const keys = Object.keys(row);
  const values = Object.values(row);
  return pool.query(
    `INSERT INTO billing_subscription_activations (${keys.join(', ')})
     VALUES (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
    values,
  );
}

describe('Step 8 — a coherent fact is accepted', () => {
  test('the documented shape inserts and reads back', async () => {
    const base = await coherent();
    await insertFact(base);
    const { rows } = await pool.query<{ operator_id: string; catalogue_plan: string }>(
      'SELECT operator_id, catalogue_plan FROM billing_subscription_activations WHERE subscription_id = $1',
      [base.subscriptionId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.operator_id, 'ops-db-test');
    assert.equal(rows[0]!.catalogue_plan, 'pro');
  });
});

describe('Step 8 — the coherence trigger refuses an incoherent fact', () => {
  test('a fact for a different user than the subscription owner', async () => {
    const base = await coherent();
    const other = await insertUser(pool, true);
    await assert.rejects(
      insertFact(base, { user_id: other.id }),
      /does not own the subscription/,
    );
  });

  test('a fact for a different subscription', async () => {
    const base = await coherent();
    const other = await insertUser(pool, true);
    const otherCommercial = await seedCommercialSubscription(pool, other.id);
    await assert.rejects(
      insertFact(base, { subscription_id: otherCommercial.subscriptionId }),
      /coherence/,
    );
  });

  test('a fact that points at another sale\'s pricing snapshot', async () => {
    const base = await coherent();
    const other = await insertUser(pool, true);
    const otherCommercial = await seedCommercialSubscription(pool, other.id, { cataloguePlan: 'elite' });
    await assert.rejects(
      insertFact(base, { pricing_snapshot_id: otherCommercial.pricingSnapshotId }),
      /locked to a different pricing snapshot/,
    );
  });

  test('a fact whose catalogue plan disagrees with the subscription', async () => {
    const base = await coherent();
    await assert.rejects(
      insertFact(base, { catalogue_plan: 'elite' }),
      /catalogue plan disagrees with the subscription/,
    );
  });

  test('a fact whose interval disagrees with the subscription', async () => {
    const base = await coherent();
    await assert.rejects(
      insertFact(base, { billing_interval: 'annual' }),
      /billing interval disagrees with the subscription/,
    );
  });

  test('a fact whose provider plan disagrees with the subscription', async () => {
    const base = await coherent();
    await assert.rejects(
      insertFact(base, { provider_plan_id: 'PLN_a_different_plan' }),
      /provider plan disagrees with the subscription/,
    );
  });

  test('a starter catalogue plan', async () => {
    const base = await coherent();
    await assert.rejects(
      insertFact(base, { catalogue_plan: 'starter' }),
      /catalogue plan disagrees with the subscription|starter is not a sellable plan/,
    );
    // Starter is not sellable anywhere in the commercial path either, so no
    // subscription can ever be locked to it.
    await assert.rejects(
      pool.query("UPDATE subscriptions SET catalogue_plan = 'starter' WHERE id = $1", [base.subscriptionId]),
      /catalogue_plan|check/i,
    );
  });

  test('the excluded capability-evidence provider plan', async () => {
    const base = await coherent();
    // Point the subscription at the excluded plan so the plan agreement checks
    // pass and the excluded-plan rule is what refuses the fact.
    await pool.query('UPDATE subscriptions SET provider_plan_id = $1 WHERE id = $2', [
      EXCLUDED_PROVIDER_PLAN, base.subscriptionId,
    ]);
    await assert.rejects(
      insertFact(base, { provider_plan_id: EXCLUDED_PROVIDER_PLAN }),
      /excluded capability-evidence provider plan is never activatable/,
    );
  });

  test('an amount that disagrees with the locked snapshot', async () => {
    const base = await coherent();
    await assert.rejects(
      insertFact(base, { payment_amount_minor: base.amountMinor + 1 }),
      /pricing snapshot disagrees with the activation facts/,
    );
  });

  test('a currency or exponent that disagrees with the locked snapshot', async () => {
    const base = await coherent();
    await assert.rejects(insertFact(base, { payment_currency: 'USD' }), /pricing snapshot disagrees/);
    await assert.rejects(insertFact(base, { payment_amount_exponent: 3 }), /pricing snapshot disagrees/);
  });

  test('a reference that disagrees with the verified evidence', async () => {
    const base = await coherent();
    await assert.rejects(
      insertFact(base, { provider_reference: `ve-chk-${'0'.repeat(64)}` }),
      /reference disagrees with the activation/,
    );
  });

  test('an evidence hash that disagrees with the verified evidence', async () => {
    const base = await coherent();
    await assert.rejects(
      insertFact(base, { evidence_hash: createHash('sha256').update('other').digest('hex') }),
      /evidence hash disagrees with the activation/,
    );
  });

  test('evidence that is not a successful sandbox transaction', async () => {
    const base = await coherent();
    // Same billing context (so the context checks pass), but a FAILED
    // observation under a different reference. `provider_domain` is already
    // CHECK-pinned to 'test' by 0033, so the domain rule here is the last of
    // several independent guards.
    const failed = await seedPaymentEvidence(pool, base.userId, base.commercial, {
      providerStatus: 'failed',
      providerReference: `ve-chk-${'a'.repeat(64)}`,
    });
    await assert.rejects(
      insertFact(base, { evidence_id: failed.evidenceId }),
      /is not a successful transaction/,
    );
  });

  test('evidence that belongs to another billing context', async () => {
    const base = await coherent();
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    const foreign = await seedPaymentEvidence(pool, user.id, commercial);
    await assert.rejects(
      insertFact(base, { evidence_id: foreign.evidenceId }),
      /different billing context/,
    );
  });

  test('a subscription with no locked pricing snapshot', async () => {
    const base = await coherent();
    const user = await insertUser(pool, false);
    await pool.query(
      "INSERT INTO subscriptions (user_id, plan, status, provider, provider_state) VALUES ($1, 'pro', 'active', 'paystack', 'pending')",
      [user.id],
    );
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM subscriptions WHERE user_id = $1', [user.id]);
    await assert.rejects(
      insertFact(base, {
        user_id: user.id, subscription_id: rows[0]!.id, pricing_snapshot_id: base.pricingSnapshotId,
      }),
      /no locked pricing snapshot/,
    );
  });
});

/* ==========================================================================
   D. Append-only and unique
   ========================================================================== */

describe('Step 8 — the activation fact is append-only and unique', () => {
  test('UPDATE is refused', async () => {
    const base = await coherent();
    await insertFact(base);
    await assert.rejects(
      pool.query(
        "UPDATE billing_subscription_activations SET activation_reason = 'rewritten' WHERE subscription_id = $1",
        [base.subscriptionId],
      ),
      /append-only/,
    );
  });

  test('DELETE is refused', async () => {
    const base = await coherent();
    await insertFact(base);
    await assert.rejects(
      pool.query('DELETE FROM billing_subscription_activations WHERE subscription_id = $1', [base.subscriptionId]),
      /never deleted/,
    );
  });

  test('a replay of the same fact is refused and never duplicates the row', async () => {
    const base = await coherent();
    await insertFact(base);
    await assert.rejects(insertFact(base), /unique constraint/i);
    const { rows } = await pool.query(
      'SELECT id FROM billing_subscription_activations WHERE subscription_id = $1',
      [base.subscriptionId],
    );
    assert.equal(rows.length, 1, 'a replay never writes a second fact');
  });

  test('a different fact for the same subscription is refused', async () => {
    const base = await coherent();
    await insertFact(base);
    await assert.rejects(
      insertFact(base, {
        idempotency_key: createHash('sha256').update('a different activation').digest('hex'),
        operator_id: 'a-second-operator',
        activation_reason: 'a second, conflicting decision',
      }),
      /unique constraint/i,
    );
  });

  test('a different fact carrying the same idempotency key is refused', async () => {
    const base = await coherent();
    await insertFact(base);
    const other = await insertUser(pool, true);
    const otherCommercial = await seedCommercialSubscription(pool, other.id);
    const otherEvidence = await seedPaymentEvidence(pool, other.id, otherCommercial);
    const otherBase = {
      userId: other.id,
      subscriptionId: otherCommercial.subscriptionId,
      pricingSnapshotId: otherCommercial.pricingSnapshotId,
      evidenceId: otherEvidence.evidenceId,
      reference: otherCommercial.reference,
      amountMinor: otherCommercial.amountMinor,
      evidenceHash: otherEvidence.evidenceHash,
      idempotencyKey: billingSubscriptionActivationIdempotencyKey({
        provider: 'paystack',
        providerReference: otherCommercial.reference,
        pricingSnapshotId: otherCommercial.pricingSnapshotId,
      }),
    };
    await assert.rejects(
      insertFact(otherBase, { idempotency_key: base.idempotencyKey }),
      /unique constraint/i,
    );
  });

  test('one evidence row can never activate a second subscription', async () => {
    const base = await coherent();
    await insertFact(base);
    const other = await insertUser(pool, true);
    const otherCommercial = await seedCommercialSubscription(pool, other.id);
    const otherBase: FactSeed = {
      userId: other.id,
      subscriptionId: otherCommercial.subscriptionId,
      pricingSnapshotId: otherCommercial.pricingSnapshotId,
      evidenceId: base.evidenceId,
      reference: otherCommercial.reference,
      amountMinor: otherCommercial.amountMinor,
      evidenceHash: base.evidenceHash,
      idempotencyKey: billingSubscriptionActivationIdempotencyKey({
        provider: 'paystack',
        providerReference: otherCommercial.reference,
        pricingSnapshotId: otherCommercial.pricingSnapshotId,
      }),
    };
    // Coherence refuses it first (the evidence belongs to another billing
    // context); `billing_subscription_activations_evidence_uniq` is the
    // defence in depth behind that.
    await assert.rejects(
      insertFact(otherBase),
      /different billing context|unique constraint/i,
    );
  });

  test('a credential-shaped operator identity or reason is refused by CHECK', async () => {
    const base = await coherent();
    await assert.rejects(insertFact(base, { operator_id: 'ops-secret-token' }), /credential|check/i);
    await assert.rejects(insertFact(base, { activation_reason: 'x'.repeat(501) }), /check/i);
  });
});

/* ==========================================================================
   E. The fixture path is the production path
   ========================================================================== */

describe('Step 8 — the fixtures write exactly what the service writes', () => {
  test('a seeded activation satisfies every coherence rule', async () => {
    const user = await insertUser(pool, true);
    const seeded = await seedActivatedSubscription(pool, user.id, { cataloguePlan: 'elite' });
    const { rows } = await pool.query<{ catalogue_plan: string; billing_interval: string }>(
      'SELECT catalogue_plan, billing_interval FROM billing_subscription_activations WHERE subscription_id = $1',
      [seeded.subscriptionId],
    );
    assert.equal(rows[0]!.catalogue_plan, 'elite');
    assert.equal(rows[0]!.billing_interval, 'monthly');
  });
});
