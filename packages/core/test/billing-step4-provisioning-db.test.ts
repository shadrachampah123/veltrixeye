/**
 * Billing Step 4 — sandbox plan provisioning: REAL PostgreSQL suite.
 *
 * These tests exercise the ACTUAL registration path against a real database:
 * the repaired `BillingProviderPlanStore.register()` (which now persists
 * `catalogue_amount_minor` — migration 0032 declares it NOT NULL — and returns
 * a projection the strict epoch parser accepts), the atomic four-epoch batch
 * registration, the fail-closed rejections (missing/stale/not-yet-effective
 * FX, excluded evidence plan), the conflict semantics (no upsert, no automatic
 * retirement, provider-code/combination uniqueness) and the migration
 * compatibility pins (0031/0032 byte-identical, no new migration).
 *
 * No provider is contacted anywhere in this suite: the provisioning workflow
 * has no transport. Freshness is anchored to the REAL clock per test and
 * expired epochs are retired between tests (each test uses fresh provider
 * codes), so every cross-test refuse path comes from the rule under test.
 */
import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BILLING_CATALOGUE_VERSION,
  BILLING_PRICING_POLICY_VERSION,
  BillingFxRateVersionStore,
  BillingPlanProvisioningService,
  BillingProviderPlanStore,
  MIGRATIONS_DIR,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  isBillingFxError,
  isBillingProviderPlanError,
  isBillingProvisioningError,
  parseFxRateVersion,
  providerIntervalForBillingInterval,
  EXCLUDED_PROVIDER_PLAN_CODE,
} from '../src/index.js';
import { startBillingTestDb, retireActiveEpochs } from './helpers/billing-checkout.js';

// Unique per suite file (see the port ledger in helpers/billing-checkout.ts).
const DB_PORT = 5495;

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
before(async () => {
  db = await startBillingTestDb(DB_PORT);
}, { timeout: 180_000 });
beforeEach(async () => {
  // Epochs are never deleted (history is retained); between tests the active
  // set is emptied so each registration starts from a clean active surface —
  // the same convention the existing billing suites use.
  await retireActiveEpochs(db.pool);
});
after(async () => {
  await db?.stop();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** An operator-driven registration for ONE instant (anchored to the real clock). */
function provisioning() {
  const registeredAt = new Date();
  const fxVersions = new BillingFxRateVersionStore(db.pool);
  let sequence = 0;
  return {
    service: new BillingPlanProvisioningService({ db: db.pool, now: () => registeredAt }),
    registeredAt,
    publishFx: async (rateScaled = 12_500_000n, capturedSecondsBefore = 300, effectiveFrom?: Date) => {
      // A distinct effective instant per publication within one test (the
      // authority pins one version per pair per instant).
      const tick = sequence++;
      return fxVersions.publish({
        fxRateScaled: rateScaled,
        fxRateScale: 6,
        effectiveFrom: effectiveFrom ?? new Date(registeredAt.getTime() - (capturedSecondsBefore + tick) * 1000),
        capturedAt: new Date(registeredAt.getTime() - (capturedSecondsBefore + tick) * 1000),
        source: 'ops',
        sourceReference: 'ops-sandbox-fx-board-1',
        createdBy: 'ops@example.com',
      });
    },
  };
}

function planCode(): string {
  return `PLN_${randomUUID().replaceAll('-', '')}`;
}

function derived(plan: 'pro' | 'elite', interval: 'monthly' | 'annual', fxRateScaled: bigint): bigint {
  return computePaymentAmountMinor({
    usdMinor: BigInt(cataloguePriceMinor(plan, interval)),
    rateScaled: fxRateScaled,
    rateScale: 6,
  });
}

type Combo = 'pro/monthly' | 'pro/annual' | 'elite/monthly' | 'elite/annual';

/** Operator evidence for the four sandbox plans, derived from the given FX rate. */
function evidenceBatch(
  fxRateScaled: bigint,
  overrides: Partial<Record<Combo, Record<string, unknown>>> = {},
): { evidence: Record<string, unknown>[]; codes: Record<Combo, string> } {
  const combos: ReadonlyArray<['pro' | 'elite', 'monthly' | 'annual']> = [
    ['pro', 'monthly'],
    ['pro', 'annual'],
    ['elite', 'monthly'],
    ['elite', 'annual'],
  ];
  const codes = {} as Record<Combo, string>;
  const evidence = combos.map(([plan, interval]) => {
    const code = planCode();
    codes[`${plan}/${interval}` as Combo] = code;
    return {
      cataloguePlan: plan,
      interval,
      providerInterval: providerIntervalForBillingInterval(interval),
      providerPlanId: code,
      paymentCurrency: 'GHS',
      paymentAmountMinor: derived(plan, interval, fxRateScaled),
      paymentAmountExponent: 2,
      mode: 'test',
      paymentCountCap: 'uncapped',
      evidenceReference: 'ops-sandbox-evidence-2026-09-22',
      ...(overrides[`${plan}/${interval}` as Combo] ?? {}),
    };
  });
  return { evidence, codes };
}

/** Durable rows for exactly the given provider codes (direct SQL, durable columns). */
async function durableRows(codes: readonly string[]) {
  const { rows } = await db.pool.query(
    `SELECT catalogue_plan, billing_interval, payment_currency, payment_amount_exponent,
            payment_amount_minor::text AS payment_amount_minor,
            catalogue_amount_minor::text AS catalogue_amount_minor,
            provider_plan_id, provider_plan_reference, fx_rate_version_id::text AS fx_rate_version_id,
            pricing_policy_version, catalogue_version, provider, mode, status
       FROM billing_provider_plans
      WHERE provider_plan_id = ANY($1::text[])
      ORDER BY catalogue_plan, billing_interval`,
    [codes],
  );
  return rows;
}

const fxReason = (error: unknown): string => {
  assert.ok(isBillingFxError(error), `expected a BillingFxError, got ${String(error)}`);
  return error.reason;
};
const planReason = (error: unknown): string => {
  assert.ok(isBillingProviderPlanError(error), `expected a BillingProviderPlanError, got ${String(error)}`);
  return error.reason;
};
const provisioningReason = (error: unknown): string => {
  assert.ok(isBillingProvisioningError(error), `expected a BillingProvisioningError, got ${String(error)}`);
  return error.reason;
};

/** Register ONE epoch directly through the repaired store (a pre-existing fact). */
async function preRegisterEpoch(
  fxVersionId: string,
  overrides: { cataloguePlan?: 'pro' | 'elite'; interval?: 'monthly' | 'annual'; providerPlanId?: string; rateScaled?: bigint } = {},
): Promise<string> {
  const plan = overrides.cataloguePlan ?? 'elite';
  const interval = overrides.interval ?? 'annual';
  const code = overrides.providerPlanId ?? planCode();
  const epoch = await new BillingProviderPlanStore(db.pool).register({
    cataloguePlan: plan,
    interval,
    paymentCurrency: 'GHS',
    paymentAmountMinor: derived(plan, interval, overrides.rateScaled ?? 12_500_000n),
    catalogueAmountMinor: BigInt(cataloguePriceMinor(plan, interval)),
    providerPlanId: code,
    fxRateVersionId: fxVersionId,
    catalogueVersion: BILLING_CATALOGUE_VERSION,
  });
  return epoch.providerPlanId;
}

/* -------------------------------------------------------------------------- */
/* E. Registration against the real store                                      */
/* -------------------------------------------------------------------------- */

describe('Step 4 — E. registering the four epochs against the real store', () => {
  test('registers all four epochs and persists catalogue_amount_minor (the repair)', async () => {
    const { service, registeredAt, publishFx } = provisioning();
    const fx = await publishFx();
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled);

    const registered = await service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence });
    assert.equal(registered.length, 4);

    // Matrix order out of the workflow: Pro Monthly, Pro Annual, Elite Monthly, Elite Annual.
    const matrixOrder: ReadonlyArray<Combo> = ['pro/monthly', 'pro/annual', 'elite/monthly', 'elite/annual'];
    for (const [index, combo] of matrixOrder.entries()) {
      const epoch = registered[index]!;
      assert.equal(`${epoch.cataloguePlan}/${epoch.interval}`, combo);
      assert.equal(epoch.fxRateVersionId, fx.id, 'one shared FX version across the batch');
      assert.equal(epoch.provider, 'paystack');
      assert.equal(epoch.mode, 'test');
      assert.equal(epoch.paymentCurrency, 'GHS');
      assert.equal(epoch.paymentAmountMinor, derived(...(combo.split('/') as ['pro'|'elite','monthly'|'annual']), fx.fxRateScaled));
      assert.equal(epoch.status, 'active');
      assert.equal(epoch.retiredAt, null);
      assert.equal(epoch.validFrom.getTime(), registeredAt.getTime(), 'one registration instant (valid_from)');
      assert.equal(epoch.pricingPolicyVersion, BILLING_PRICING_POLICY_VERSION);
      assert.equal(epoch.catalogueVersion, BILLING_CATALOGUE_VERSION);
      assert.equal(epoch.providerPlanId, codes[combo]);
      assert.equal(epoch.providerPlanReference, 'ops-sandbox-evidence-2026-09-22');
    }

    // The durable rows, durable column included, exactly as migration 0032 stores them.
    const expectedAmounts: ReadonlyArray<[Combo, number]> = [
      ['elite/annual', 99_000],
      ['elite/monthly', 9_900],
      ['pro/annual', 39_000],
      ['pro/monthly', 3_900],
    ];
    const rows = await durableRows(Object.values(codes));
    assert.equal(rows.length, 4);
    for (const [index, [combo, usdMinor]] of expectedAmounts.entries()) {
      const [plan, interval] = combo.split('/') as ['pro' | 'elite', 'monthly' | 'annual'];
      const row = rows[index]!;
      assert.equal(row['catalogue_plan'], plan);
      assert.equal(row['billing_interval'], interval);
      assert.equal(row['catalogue_amount_minor'], String(usdMinor), 'catalogue_amount_minor PERSISTED');
      assert.equal(row['payment_amount_minor'], derived(plan, interval, fx.fxRateScaled).toString(), 'the exact half-up GHS amount');
      assert.equal(row['payment_currency'], 'GHS');
      assert.equal(row['payment_amount_exponent'], 2);
      assert.equal(row['provider_plan_id'], codes[combo]);
      assert.equal(row['fx_rate_version_id'], fx.id);
      assert.equal(row['provider'], 'paystack');
      assert.equal(row['mode'], 'test');
      assert.equal(row['status'], 'active');
      assert.equal(row['pricing_policy_version'], 'pr3-usd-ghs-v1');
      assert.equal(row['catalogue_version'], 'billing-catalogue-1');
      assert.equal(row['provider_plan_reference'], 'ops-sandbox-evidence-2026-09-22');
    }
  });

  test('registering the same batch again conflicts — no upsert, no automatic retirement', async () => {
    const { service, publishFx } = provisioning();
    const fx = await publishFx();
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled);

    const first = await service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence });
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
      (error: unknown) => planReason(error) === 'conflict',
    );

    const rows = await durableRows(Object.values(codes));
    assert.equal(rows.length, 4, 'nothing was upserted into a duplicate');
    for (const row of rows) {
      assert.equal(row['status'], 'active', 'the conflict never retires the existing epochs');
      assert.ok(
        first.some((epoch) => epoch.providerPlanId === row['provider_plan_id']),
        'the original rows are exactly the ones from the first registration',
      );
    }
  });

  test('a provider code already registered for ANOTHER epoch conflicts too', async () => {
    const { service, publishFx } = provisioning();
    const fx = await publishFx();
    const borrowedCode = await preRegisterEpoch(fx.id); // active elite/annual epoch

    // The batch reuses that provider code for pro/monthly — a free combination,
    // but one provider plan can never map onto two local epochs.
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled, { 'pro/monthly': { providerPlanId: borrowedCode } });
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
      (error: unknown) => planReason(error) === 'conflict',
    );
    const remaining = (Object.entries(codes) as Array<[Combo, string]>)
      .filter(([combo]) => combo !== 'pro/monthly')
      .map(([, code]) => code);
    assert.equal((await durableRows(remaining)).length, 0, 'the failed batch left no rows');
  });

  test('a persistence conflict on the LAST entry rolls the whole batch back (atomic)', async () => {
    const { service, publishFx } = provisioning();
    const fx = await publishFx();
    const preSeededCode = await preRegisterEpoch(fx.id); // active elite/annual — the LAST matrix entry

    const { evidence, codes } = evidenceBatch(fx.fxRateScaled);
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
      (error: unknown) => planReason(error) === 'conflict',
    );

    assert.equal(
      (await durableRows(Object.values(codes))).length,
      0,
      'entries 1–3 rolled back with entry 4: no partial batch',
    );
    const preSeeded = await durableRows([preSeededCode]);
    assert.equal(preSeeded.length, 1);
    assert.equal(preSeeded[0]!['status'], 'active', 'the conflict never retires the pre-existing epoch');
  });

  test('a batch with an invalid LAST entry writes nothing at all (validate before write)', async () => {
    const { service, publishFx } = provisioning();
    const fx = await publishFx();
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled, {
      'elite/annual': { paymentAmountMinor: derived('elite', 'annual', fx.fxRateScaled) + 1n },
    });

    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
      (error: unknown) => provisioningReason(error) === 'amount_mismatch',
    );
    assert.equal((await durableRows(Object.values(codes))).length, 0, 'no epoch row was written');
  });

  test('retire() returns the same parser-compatible projection (the repair, applied)', async () => {
    const { service, publishFx } = provisioning();
    const fx = await publishFx();
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled);
    const registered = await service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence });

    const store = new BillingProviderPlanStore(db.pool);
    const proMonthly = registered.find((epoch) => epoch.cataloguePlan === 'pro' && epoch.interval === 'monthly')!;
    const retired = await store.retire(proMonthly.id, 'rotation check');
    // The RETURNING row parsed through the strict epoch parser: the repair holds.
    assert.equal(retired.id, proMonthly.id);
    assert.equal(retired.status, 'retired');
    assert.ok(retired.retiredAt instanceof Date);
    assert.equal(retired.providerPlanId, codes['pro/monthly']);
    assert.equal(retired.fxRateVersionId, fx.id);

    // Retirement is one-way and the pricing columns are immutable (migration 0032).
    await assert.rejects(
      db.pool.query("UPDATE billing_provider_plans SET status = 'active' WHERE id = $1", [proMonthly.id]),
      (error: unknown) => String((error as { code?: unknown }).code) === '27000',
      'a retired epoch can never reactivate',
    );
    await assert.rejects(
      db.pool.query('UPDATE billing_provider_plans SET payment_amount_minor = 1 WHERE id = $1', [proMonthly.id]),
      (error: unknown) => String((error as { code?: unknown }).code) === '27000',
      'the epoch amount is immutable after registration',
    );

    // A NEW epoch for the retired combination registers cleanly (history retained).
    const refreshedFx = await publishFx(13_000_000n);
    const replacement = await new BillingProviderPlanStore(db.pool).register({
      cataloguePlan: 'pro',
      interval: 'monthly',
      paymentCurrency: 'GHS',
      paymentAmountMinor: derived('pro', 'monthly', refreshedFx.fxRateScaled),
      catalogueAmountMinor: BigInt(cataloguePriceMinor('pro', 'monthly')),
      providerPlanId: planCode(),
      fxRateVersionId: refreshedFx.id,
      catalogueVersion: BILLING_CATALOGUE_VERSION,
    });
    assert.equal(replacement.status, 'active');
    assert.equal(replacement.paymentAmountMinor, derived('pro', 'monthly', refreshedFx.fxRateScaled));
    const retiredRows = await durableRows([proMonthly.providerPlanId]);
    assert.equal(retiredRows.length, 1);
    assert.equal(retiredRows[0]!['status'], 'retired', 'the retired epoch stays as history');
  });
});

/* -------------------------------------------------------------------------- */
/* B/E. FX authority at the persistence boundary                               */
/* -------------------------------------------------------------------------- */

describe('Step 4 — the FX authority at the persistence boundary', () => {
  test('a missing FX version id is missing — nothing is promoted to authority', async () => {
    const { service, publishFx } = provisioning();
    const fx = await publishFx();
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled);
    const nonExistent = randomUUID();
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: nonExistent, evidence }),
      (error: unknown) => fxReason(error) === 'missing',
    );
    assert.equal((await durableRows(Object.values(codes))).length, 0);
  });

  test('a stale FX version (>900 s) is refused; 899 s and 900 s are accepted', async () => {
    const stale = provisioning();
    const staleFx = await stale.publishFx(12_500_000n, 901);
    const staleBatch = evidenceBatch(staleFx.fxRateScaled);
    await assert.rejects(
      stale.service.registerSandboxPlanEpochs({ fxRateVersionId: staleFx.id, evidence: staleBatch.evidence }),
      (error: unknown) => fxReason(error) === 'stale',
    );
    assert.equal((await durableRows(Object.values(staleBatch.codes))).length, 0);

    const at900 = provisioning();
    const fx900 = await at900.publishFx(12_500_000n, 900);
    const batch900 = evidenceBatch(fx900.fxRateScaled);
    assert.equal(
      (await at900.service.registerSandboxPlanEpochs({ fxRateVersionId: fx900.id, evidence: batch900.evidence })).length,
      4,
      'exactly 900 seconds old is inside the inclusive bound',
    );

    // The 900-second batch above registered the four active epochs; clear the
    // active surface so the 899-second batch stands on its own.
    await retireActiveEpochs(db.pool);
    const at899 = provisioning();
    const fx899 = await at899.publishFx(12_500_000n, 899);
    const batch899 = evidenceBatch(fx899.fxRateScaled);
    assert.equal(
      (await at899.service.registerSandboxPlanEpochs({ fxRateVersionId: fx899.id, evidence: batch899.evidence })).length,
      4,
      '899 seconds old is accepted',
    );
  });

  test('a fresh-but-not-yet-effective version is refused', async () => {
    const { service, publishFx, registeredAt } = provisioning();
    const fx = await publishFx(
      12_500_000n,
      700,
      new Date(registeredAt.getTime() + 60_000), // effective in the future
    );
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled);
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
      (error: unknown) => fxReason(error) === 'invalid',
    );
    assert.equal((await durableRows(Object.values(codes))).length, 0);
  });

  test('a newer FX version never replaces the operator-selected one', async () => {
    const { service, publishFx } = provisioning();
    const selected = await publishFx(12_500_000n, 300);
    await publishFx(20_000_000n, 200); // a newer, different-rate version now exists
    const { evidence, codes } = evidenceBatch(selected.fxRateScaled);

    await service.registerSandboxPlanEpochs({ fxRateVersionId: selected.id, evidence });
    const rows = await durableRows(Object.values(codes));
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row['fx_rate_version_id'], selected.id, 'the epochs pin the SELECTED version');
    }
    assert.equal(
      rows.find((row) => row['catalogue_plan'] === 'pro' && row['billing_interval'] === 'monthly')!['payment_amount_minor'],
      derived('pro', 'monthly', selected.fxRateScaled).toString(),
      'and the amounts derive from it — never from the newer rate',
    );
  });

  test('the excluded GHS 2.00 evidence plan is refused and never registered', async () => {
    const { service, publishFx } = provisioning();
    const fx = await publishFx();
    const { evidence, codes } = evidenceBatch(fx.fxRateScaled, {
      'pro/monthly': { providerPlanId: EXCLUDED_PROVIDER_PLAN_CODE },
    });
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
      (error: unknown) => provisioningReason(error) === 'excluded_provider_plan',
    );
    assert.equal((await durableRows(Object.values(codes))).length, 0);
    const excluded = await durableRows([EXCLUDED_PROVIDER_PLAN_CODE]);
    assert.equal(excluded.length, 0, 'the excluded code can never become an epoch');
  });

  test('register() refuses a non-positive catalogue amount before any SQL', async () => {
    const calls: unknown[] = [];
    const stub = {
      connect: async () => { throw new Error('not used'); },
      query: async (...args: unknown[]) => {
        calls.push(args);
        return { rows: [] };
      },
    } as never;
    const store = new BillingProviderPlanStore(stub);
    await assert.rejects(
      store.register({
        cataloguePlan: 'pro',
        interval: 'monthly',
        paymentCurrency: 'GHS',
        paymentAmountMinor: 48_750n,
        catalogueAmountMinor: 0n,
        providerPlanId: planCode(),
        fxRateVersionId: randomUUID(),
        catalogueVersion: BILLING_CATALOGUE_VERSION,
      }),
      (error: unknown) => planReason(error) === 'invalid',
    );
    assert.equal(calls.length, 0, 'refused before a statement was ever issued');
  });
});

/* -------------------------------------------------------------------------- */
/* H. Migration compatibility                                                  */
/* -------------------------------------------------------------------------- */

describe('Step 4 — H. migration compatibility', () => {
  test('migrations 0031-0033 are byte-identical, and only 0034 (Step 8) was added', () => {
    /**
     * SHA-256 of the Step 4 persistence foundations, recorded against the
     * Step 4 implementation. 0031 is pinned identically in the PR3 suite;
     * 0032 is the migration the audit proved sufficient — a Step 4 migration
     * is forbidden, so its bytes (and the 32-file set) are pinned here.
     */
    const EXPECTED: Readonly<Record<string, string>> = Object.freeze({
      '0031_provider_billing.sql': 'e43cf29aabc107a2985152b517560c872f8cafd2f7ebede01cffd5f555424a28',
      '0032_billing_fx_and_pricing.sql': '0a7577cda8021a32a723a21827985605a93255fcc499364a36550c9f5b8a4b80',
      '0033_billing_payment_evidence.sql': '0a7dd40eea21c243727e8ba1bf8accdf04d973c93ecad78fe29004f5971165de',
    });
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    assert.equal(files.length, 34, 'no migration was added or removed by Step 4 beyond Step 8 (0034)');
    assert.equal(files.at(-1), '0034_billing_activation.sql', '0034 is the newest migration (Step 8)');
    for (const [file, sha] of Object.entries(EXPECTED)) {
      const digest = createHash('sha256').update(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')).digest('hex');
      assert.equal(digest, sha, `${file} is byte-identical to its pinned bytes`);
    }
  });

  test('the FX authority is still append-only (registration never rewrites a version)', async () => {
    const { publishFx } = provisioning();
    const fx = await publishFx();
    await assert.rejects(
      db.pool.query('UPDATE billing_fx_rate_versions SET fx_rate_scaled = 1 WHERE id = $1', [fx.id]),
      (error: unknown) => String((error as { code?: unknown }).code) === '27000',
      'a published FX version can never be edited — epochs are never silently repriced',
    );
    // Published once, it stays readable and valid through the authority's row contract.
    const { rows } = await db.pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [fx.id]);
    const reread = parseFxRateVersion(rows[0]);
    assert.equal(reread.id, fx.id);
    assert.equal(reread.fxRateScaled, fx.fxRateScaled);
  });
});
