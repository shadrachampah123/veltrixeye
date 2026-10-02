/**
 * Billing — migration 0035 (live Paystack mode) and the mode-aware services,
 * against a real database.
 *
 * What this suite pins:
 *
 *  1. SCHEMA — 0035 widens exactly two CHECK constraints to the two-value
 *     domain ('test' | 'live'), replaces only the evidence-domain branch of
 *     the 0034 activation coherence function, applies cleanly on top of
 *     0001–0034 (forward-only upgrade path), and REFUSES to apply (42704)
 *     when its foundations are missing. Garbage domain values are still
 *     refused by the database.
 *  2. PROVISIONING / DIRECTORY — the configured mode threads through batch
 *     preparation and the epoch store: evidence from another mode is a
 *     `mode_mismatch`; a live deployment registers live epochs; the test and
 *     live directory views never cross (no silent fallback in either
 *     direction).
 *  3. EVIDENCE / ACTIVATION — the evidence store stamps only its configured
 *     mode; the activation service defaults to `test` and refuses live
 *     evidence, while an explicitly live-mode activation accepts live
 *     evidence end to end (0035 trigger included).
 *  4. REGISTRY — the seam's `live` execution guard is untouched: claiming
 *     `live: true` still refuses registration even though `mode` exists.
 *
 * Nothing here contacts a provider or a network: only SQL through the
 * repository's migration runner and the mode-aware services.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import type { BillingProvider } from '../src/index.js';
import {
  BillingActivationService,
  BillingPlanProvisioningService,
  BillingPricingSnapshotStore,
  BillingProviderPlanStore,
  BillingVerifiedTransactionError,
  BillingVerifiedTransactionStore,
  MIGRATIONS_DIR,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  createBillingProviderRegistry,
  createPool,
  createUnimplementedBillingProvider,
  getBillingState,
  isBillingActivationError,
  isBillingProvisioningError,
  isBillingProviderPlanError,
  migrationStatus,
  parseProviderPlan,
  prepareSandboxProvisioningBatch,
  providerIntervalForBillingInterval,
  providerPlanExpectationFromSnapshot,
  providerPlanKey,
  runMigrations,
  sandboxProvisioningRegisterInputs,
  selectActiveProviderPlan,
} from '../src/index.js';
import {
  AS_OF,
  insertFx,
  insertUser,
  seedCommercialSubscription,
  seedPaymentEvidence,
  startBillingTestDb,
} from './helpers/billing-checkout.js';

const DB_PORT = 5531;
const ACTIVATED_AT = new Date('2026-09-23T09:30:00.000Z');
const OPERATOR = 'ops-live-01';
const REASON = 'live transaction verified and reviewed by the on-call operator';
const FX_RATE_SCALED = 12_500_000;

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let pool: Pool;
/** Seeded on the test domain by the schema section; reused by later sections. */
let testUser: { id: string; email: string };
let testCommercial: Awaited<ReturnType<typeof seedCommercialSubscription>>;

const planCode = () => `PLN_${randomBytes(6).toString('hex')}`;

const liveEvidenceEntry = (cataloguePlan: 'pro' | 'elite', interval: 'monthly' | 'annual') => ({
  cataloguePlan,
  interval,
  providerInterval: providerIntervalForBillingInterval(interval),
  providerPlanId: planCode(),
  paymentCurrency: 'GHS',
  paymentAmountMinor: Number(
    computePaymentAmountMinor({
      usdMinor: BigInt(cataloguePriceMinor(cataloguePlan, interval)),
      rateScaled: BigInt(FX_RATE_SCALED),
      rateScale: 6,
    }),
  ),
  paymentAmountExponent: 2,
  mode: 'live',
  paymentCountCap: 'uncapped',
  evidenceReference: 'ops-live-plan-evidence-2026-09-22',
});

const testEvidenceEntry = (cataloguePlan: 'pro' | 'elite', interval: 'monthly' | 'annual') => ({
  ...liveEvidenceEntry(cataloguePlan, interval),
  providerPlanId: planCode(),
  mode: 'test',
});

const provisioningReason = (error: unknown): string => {
  assert.ok(isBillingProvisioningError(error), `expected a BillingProvisioningError, got ${String(error)}`);
  return error.reason;
};

const catchError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
};

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  pool = db.pool;
}, { timeout: 180_000 });

after(async () => {
  await db?.stop();
});

/* ========================================================================== */
/* 1. Schema: 0035 on a fresh database                                        */
/* ========================================================================== */

describe('0035 — fresh database: files, constraints and the coherence trigger', () => {
  it('applies through 0037: every file, both domains in both CHECKs', async () => {
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    // 0036 (non-commercial operator grants) and 0037 (scheduled ingestion
    // trigger) are later migrations than this step's 0035; the fresh database
    // is expected to carry them too.
    assert.equal(status.expectedCount, 37, 'the whole shipped file set exists');
    assert.equal(status.appliedCount, 37, 'the fresh database is fully migrated');
    assert.equal(status.pending.length, 0);

    const constraintDef = async (name: string): Promise<string> => {
      const { rows } = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1`,
        [name],
      );
      return rows[0]?.definition ?? '';
    };
    const plansDef = await constraintDef('billing_provider_plans_mode_check');
    assert.match(plansDef, /'test'/, 'the epoch mode CHECK keeps test');
    assert.match(plansDef, /'live'/, 'the epoch mode CHECK gained live');

    const domainDef = await constraintDef('billing_verified_transactions_domain_check');
    assert.match(domainDef, /'test'/, 'the evidence domain CHECK keeps test');
    assert.match(domainDef, /'live'/, 'the evidence domain CHECK gained live');

    // The activation coherence function accepts a recognized domain and
    // nothing else — the 0035 replacement is the one in force.
    const { rows } = await pool.query<{ prosrc: string }>(
      `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'billing_subscription_activations_coherent' AND n.nspname = current_schema()`,
    );
    const source = rows[0]?.prosrc ?? '';
    assert.match(source, /NOT IN \('test', 'live'\)/, 'the coherence trigger accepts the recognized domains');
    assert.doesNotMatch(source, /provider_domain <> 'test'/, 'the old test-only branch is replaced');
  });

  it('still refuses garbage domain values at the database layer', async () => {
    const fx = await insertFx(pool);
    const result = await pool.query(
      `INSERT INTO billing_provider_plans (mode, catalogue_plan, billing_interval, payment_amount_minor,
         provider_plan_id, fx_rate_version_id, pricing_policy_version, catalogue_version,
         catalogue_amount_minor, valid_from)
       VALUES ('sandbox', 'pro', 'monthly', 48750, $1, $2,
         'pr3-usd-ghs-v1', 'billing-catalogue-1', 3900, now())
       RETURNING id`,
      [planCode(), fx.id],
    ).then(
      () => null,
      (error: { code?: string; message?: string }) => error,
    );
    assert.ok(result !== null && result.code === '23514',
      `epoch mode 'sandbox' is refused (got ${String(result?.code)})`);
    assert.match(String(result?.message ?? ''), /mode_check/);
  });

  it('upgrades 0001–0034 in place, and refuses 0035 alone on an empty database', async () => {
    const dir34 = mkdtempSync(path.join(os.tmpdir(), 've-0035-base-'));
    const dir35 = mkdtempSync(path.join(os.tmpdir(), 've-0035-only-'));
    const dbName = 'veltrixeye_billing_0035_upgrade';
    try {
      for (const file of readdirSync(MIGRATIONS_DIR)) {
        const match = /^(\d{4})_/.exec(file);
        if (match && Number(match[1]) <= 34) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir34, file));
        if (match && Number(match[1]) === 35) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir35, file));
      }

      await pool.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(db.dbUrl);
      url.pathname = `/${dbName}`;
      const upgrade = createPool({ databaseUrl: url.toString() });
      try {
        // a. 0035 alone on an empty database → pre-flight refusal (42704),
        //    nothing half-applied.
        await assert.rejects(
          runMigrations(upgrade, dir35),
          /0035_billing_live_mode\.sql failed: 0035 refused/,
          '0035 refuses without its foundations',
        );
        const { rows } = await upgrade.query<{ present: boolean }>(
          `SELECT to_regclass('public.billing_provider_plans') IS NOT NULL AS present`,
        );
        assert.equal(rows[0]!.present, false, 'the refusal modified nothing');

        // b. the real upgrade path: 0001–0034 first, then 0035 on top.
        const base = await runMigrations(upgrade, dir34);
        assert.equal(base.applied.length, 34, 'the base applies through 0034');
        const next = await runMigrations(upgrade, dir35);
        assert.deepEqual(next.applied, ['0035_billing_live_mode.sql'], '0035 applies on top, forward-only');
        const status = await migrationStatus(upgrade, dir34);
        const full = await migrationStatus(upgrade, MIGRATIONS_DIR);
        assert.equal(status.expectedCount, 34, 'the base file set is exactly 0001-0034');
        assert.equal(status.pending.length, 0, 'the base set is fully applied');
        assert.equal(full.appliedCount, 35, 'the upgrade path ends at 0035, this step’s tip');
        // Only 0036 and 0037 — later migrations this step knows nothing
        // about — are still pending, and they are exactly those files.
        assert.deepEqual(full.pending, [
          '0036_billing_entitlement_grants.sql',
          '0037_scheduled_ingestion_trigger.sql',
        ]);
        assert.equal(full.latestApplied, '0035_billing_live_mode.sql', '0035 is the newest applied migration');
      } finally {
        await upgrade.end();
        await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
      }
    } finally {
      rmSync(dir34, { recursive: true, force: true });
      rmSync(dir35, { recursive: true, force: true });
    }
  });

  it('a live-domain evidence row is storable; a garbage domain is refused', async () => {
    testUser = await insertUser(pool, true);
    testCommercial = await seedCommercialSubscription(pool, testUser.id);

    // Garbage domain → database CHECK refusal (no row exists afterwards).
    const garbage = await catchError(() =>
      pool.query(
        `INSERT INTO billing_verified_transactions (
           user_id, subscription_id, pricing_snapshot_id, provider, provider_reference,
           provider_transaction_id, payment_amount_minor, payment_currency, payment_amount_exponent,
           provider_status, provider_domain, provider_customer_id, provider_customer_code,
           paid_at, verified_at, evidence_hash, idempotency_key)
         VALUES ($1,$2,$3,'paystack',$4,NULL,$5,'GHS',2,'success','Sandbox',NULL,NULL,
           now(), now(), $6, $7)
         RETURNING id`,
        [
          testUser.id,
          testCommercial.subscriptionId,
          testCommercial.pricingSnapshotId,
          testCommercial.reference,
          testCommercial.amountMinor,
          randomBytes(32).toString('hex'),
          randomBytes(32).toString('hex'),
        ],
      ),
    );
    assert.ok(garbage !== null, 'a garbage domain insert must fail');
    assert.equal((garbage as { code?: string }).code, '23514');
    assert.match(String((garbage as { message?: string }).message ?? ''), /domain_check/);

    // 'live' is a recognized domain and stores fine (the seed helper writes
    // its own coherent row; here the contract under test is the CHECK).
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    const live = await seedPaymentEvidence(pool, user.id, commercial, { providerDomain: 'live' });
    const { rows } = await pool.query<{ provider_domain: string }>(
      'SELECT provider_domain FROM billing_verified_transactions WHERE id = $1',
      [live.evidenceId],
    );
    assert.equal(rows[0]?.provider_domain, 'live', '0035 persists a live-domain evidence row');
  });
});

/* ========================================================================== */
/* 2. Provisioning + provider-plan directory isolation                        */
/* ========================================================================== */

describe('0035 — live-mode provisioning and mode-specific directories', () => {
  it('the batch carries the configured mode; a cross-mode batch is a mode_mismatch', async () => {
    // An FX version effective at (and captured at) the registration instant:
    // provisioning measures freshness, unlike epoch checkout.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO billing_fx_rate_versions (fx_rate_scaled, fx_rate_scale, source, effective_from, captured_at)
       VALUES ($1, 6, 'ops', $2, $2) RETURNING id`,
      [FX_RATE_SCALED, AS_OF],
    );
    const fxId = rows[0]!.id;
    const fxRow = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [fxId])).rows[0];
    const liveEvidence = [
      liveEvidenceEntry('pro', 'monthly'),
      liveEvidenceEntry('pro', 'annual'),
      liveEvidenceEntry('elite', 'monthly'),
      liveEvidenceEntry('elite', 'annual'),
    ];

    const batch = prepareSandboxProvisioningBatch({
      fxVersion: fxRow,
      evidence: liveEvidence,
      registeredAt: AS_OF,
      mode: 'live',
    });
    assert.equal(batch.mode, 'live', 'the validated batch states its mode');
    assert.equal(batch.registrations.length, 4);
    for (const input of sandboxProvisioningRegisterInputs(batch)) {
      assert.equal(input.mode, 'live', 'every store input carries the batch mode');
    }

    // Test-mode evidence in a live batch → refused.
    const mixedDown = await catchError(() =>
      Promise.resolve(
        prepareSandboxProvisioningBatch({
          fxVersion: fxRow,
          evidence: [testEvidenceEntry('pro', 'monthly'), ...liveEvidence.slice(1)],
          registeredAt: AS_OF,
          mode: 'live',
        }),
      ),
    );
    assert.equal(provisioningReason(mixedDown), 'mode_mismatch');

    // Live evidence in the default (test) batch → refused, and vice versa.
    const defaulted = await catchError(() =>
      Promise.resolve(
        prepareSandboxProvisioningBatch({ fxVersion: fxRow, evidence: liveEvidence, registeredAt: AS_OF }),
      ),
    );
    assert.equal(provisioningReason(defaulted), 'mode_mismatch');
    const batchDefaultMode = prepareSandboxProvisioningBatch({
      fxVersion: fxRow,
      evidence: [testEvidenceEntry('pro', 'monthly'), testEvidenceEntry('pro', 'annual'),
        testEvidenceEntry('elite', 'monthly'), testEvidenceEntry('elite', 'annual')],
      registeredAt: AS_OF,
    });
    assert.equal(batchDefaultMode.mode, 'test', 'the default batch stays test');
  });

  it('a live-mode service registers four live epochs; directories never cross', async () => {
    const fxRow = (await pool.query('SELECT * FROM billing_fx_rate_versions ORDER BY effective_from DESC LIMIT 1')).rows[0];
    const liveEvidence = [
      liveEvidenceEntry('pro', 'monthly'),
      liveEvidenceEntry('pro', 'annual'),
      liveEvidenceEntry('elite', 'monthly'),
      liveEvidenceEntry('elite', 'annual'),
    ];
    const service = new BillingPlanProvisioningService({ db: pool, mode: 'live', now: () => AS_OF });
    // A LIVE registration is auditable by construction: the operator identity
    // and the reason are mandatory in live mode (`audit_required` otherwise),
    // and the audit event is written on the same transaction as the epochs.
    const registered = await service.registerSandboxPlanEpochs({
      fxRateVersionId: fxRow.id,
      evidence: liveEvidence,
      audit: { operatorId: OPERATOR, reason: REASON },
    });
    assert.equal(registered.length, 4);
    for (const epoch of registered) {
      assert.equal(epoch.mode, 'live', `${epoch.cataloguePlan}/${epoch.interval} registered in live mode`);
    }

    const testStore = new BillingProviderPlanStore(pool);
    const liveStore = new BillingProviderPlanStore(pool, undefined, 'live');

    // Direction 1: a test directory read never sees a live epoch.
    const liveKey = providerPlanKey('pro', 'monthly', { mode: 'live' });
    const notFound = await catchError(() => testStore.findActive(liveKey));
    assert.ok(notFound !== null && isBillingProviderPlanError(notFound), 'a live key must fail on the test store');
    assert.equal((notFound as InstanceType<typeof Error>).message.includes('No provider-plan epoch exists'), true,
      'the test directory reports not_found for a live key');

    // Direction 2: a live directory read never selects a test epoch — even
    // when the row it would otherwise find is a perfectly valid test epoch.
    const testKey = providerPlanKey('pro', 'monthly');
    const crossDomain = await catchError(() => liveStore.findActive(testKey));
    assert.ok(crossDomain !== null && isBillingProviderPlanError(crossDomain),
      'a test key must fail on the live store');
    assert.match((crossDomain as Error).message, /configured provider mode is live/,
      'the refusal names the configured mode, never a silent selection');

    // Both stores find their own domain.
    const foundTest = await testStore.findActive(testKey);
    assert.equal(foundTest.mode, 'test');
    const foundLive = await liveStore.findActive(liveKey);
    assert.equal(foundLive.mode, 'live');

    // The parser itself: live rows are unparseable by default, and a
    // hand-built key for the wrong domain never selects anything.
    const { rows: liveRows } = await pool.query(
      `SELECT id, provider, mode, catalogue_plan, billing_interval, payment_currency,
              payment_amount_minor, payment_amount_exponent, provider_plan_id,
              provider_plan_reference, fx_rate_version_id, pricing_policy_version,
              catalogue_version, status, valid_from, retired_at, retired_reason
         FROM billing_provider_plans WHERE mode = 'live' AND catalogue_plan = 'pro'
         AND billing_interval = 'monthly' LIMIT 1`,
    );
    assert.equal(liveRows.length, 1);
    const defaultParse = await catchError(() => Promise.resolve(parseProviderPlan(liveRows[0])));
    assert.ok(defaultParse !== null && isBillingProviderPlanError(defaultParse));
    assert.match((defaultParse as Error).message, /sandbox-only/,
      'the default refusal keeps the sandbox-only posture');
    const explicit = parseProviderPlan(liveRows[0], { allowedMode: 'live' });
    assert.equal(explicit.mode, 'live');
    const wrongSelect = await catchError(() =>
      Promise.resolve(selectActiveProviderPlan(liveRows, providerPlanKey('pro', 'monthly', { mode: 'test' }))),
    );
    assert.ok(wrongSelect !== null && isBillingProviderPlanError(wrongSelect));
  });

  it('a snapshot expectation carries the configured mode only when stated', async () => {
    const stored = await new BillingPricingSnapshotStore(pool).findById(testCommercial.pricingSnapshotId);
    assert.ok(stored !== null, 'the seeded snapshot is readable');
    const snapshot = stored.snapshot;
    const bare = providerPlanExpectationFromSnapshot(snapshot, 'PLN_pro_monthly');
    assert.equal('mode' in bare, false, 'no mode is inferred from a mode-less snapshot');
    const live = providerPlanExpectationFromSnapshot(snapshot, 'PLN_pro_monthly', { mode: 'live' });
    assert.equal(live.mode, 'live', 'an explicit configured mode appears in the expectation');
  });
});

/* ========================================================================== */
/* 3. Evidence stores, activation and the registry guard                      */
/* ========================================================================== */

describe('0035 — evidence stores and mode-aware activation', () => {
  it('the evidence store stamps only its configured mode', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id, { mode: 'live' });
    const facts = {
      userId: user.id,
      subscriptionId: commercial.subscriptionId,
      pricingSnapshotId: commercial.pricingSnapshotId,
      verified: {
        provider: 'paystack',
        providerReference: commercial.reference,
        providerTransactionId: null,
        providerStatus: 'success',
        providerDomain: 'live',
        paymentCurrency: 'GHS',
        paymentAmountMinor: commercial.amountMinor,
        paymentAmountExponent: 2,
        providerCustomerId: null,
        providerCustomerCode: null,
        paidAt: AS_OF.toISOString(),
        verifiedAt: AS_OF.toISOString(),
      },
    } as const;

    // A test-mode store refuses to stamp live facts — loudly, with the mode
    // named, before any write happens.
    const testStore = new BillingVerifiedTransactionStore(pool);
    const refusal = await catchError(() => testStore.record(facts));
    assert.ok(refusal instanceof BillingVerifiedTransactionError, `expected a store error, got ${String(refusal)}`);
    assert.match((refusal as Error).message, /configured provider mode \(test\)/);

    // The live store records the same facts under the live domain.
    const liveStore = new BillingVerifiedTransactionStore(pool, 'live');
    const recorded = await liveStore.record(facts);
    assert.equal(recorded.providerDomain, 'live');
    // Re-recording through the test store still refuses (domain check first).
    const refusalAgain = await catchError(() => testStore.record(facts));
    assert.ok(refusalAgain instanceof BillingVerifiedTransactionError);
  });

  it('the default-mode activation service refuses live evidence; the DB does not', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id, { mode: 'live' });
    const evidence = await seedPaymentEvidence(pool, user.id, commercial, { providerDomain: 'live' });

    const error = await catchError(() =>
      new BillingActivationService({ db: pool, now: () => ACTIVATED_AT }).activate({
        user: user.email, operatorId: OPERATOR, reason: REASON, evidenceId: evidence.evidenceId,
      }),
    );
    assert.ok(error !== null && isBillingActivationError(error), 'the default service must refuse');
    assert.equal((error as { reason: string }).reason, 'evidence_not_successful');
    const { rows } = await pool.query('SELECT id FROM billing_subscription_activations WHERE subscription_id = $1',
      [commercial.subscriptionId]);
    assert.equal(rows.length, 0, 'no activation fact exists after the refusal');
  });

  it('an explicitly live-mode activation accepts live evidence end to end', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id, { mode: 'live' });
    const evidence = await seedPaymentEvidence(pool, user.id, commercial, { providerDomain: 'live' });

    const service = new BillingActivationService({ db: pool, mode: 'live', now: () => ACTIVATED_AT });
    const result = await service.activate({
      user: user.email, operatorId: OPERATOR, reason: REASON, evidenceId: evidence.evidenceId,
    });
    assert.equal(result.paymentConfirmed, true);
    assert.equal(result.grantsExecution, false, 'activation still never grants execution');

    // The 0035 trigger accepted the live-domain evidence, and the read side
    // reports the confirmation for the live deployment.
    const state = await getBillingState(pool, user.id, { mode: 'live' });
    assert.equal(state.mode, 'live');
    assert.equal(state.providerStatus.paymentConfirmed, true, 'the activation fact is durable and readable');
    assert.equal(state.entitlements.canAccessAutomation, false, 'no execution from an activation');

    // Cross-domain in the other direction: test evidence on a live service.
    const testUserEvidence = await seedPaymentEvidence(pool, testUser.id, testCommercial);
    const wrongDomain = await catchError(() =>
      new BillingActivationService({ db: pool, mode: 'live', now: () => ACTIVATED_AT }).activate({
        user: testUser.email, operatorId: OPERATOR, reason: REASON, evidenceId: testUserEvidence.evidenceId,
      }),
    );
    assert.ok(wrongDomain !== null && isBillingActivationError(wrongDomain));
    assert.equal((wrongDomain as { reason: string }).reason, 'evidence_not_successful',
      'a live service never activates from test-domain evidence');
  });

  it('the registry live-execution guard is untouched by the mode field', () => {
    const registry = createBillingProviderRegistry();
    const claiming = {
      ...createUnimplementedBillingProvider(),
      mode: 'live',
      live: true,
    } as unknown as BillingProvider;
    assert.throws(
      () => registry.register(claiming),
      /cannot be registered as live/,
      'mode and live stay independent: billing is never an execution path',
    );
    // The honest placeholder registers with mode test and live false.
    registry.register(createUnimplementedBillingProvider());
    const listed = registry.list();
    assert.deepEqual(listed, [
      { id: 'paystack', name: 'paystack-unimplemented', implemented: false, live: false, mode: 'test' },
    ]);
  });
});
