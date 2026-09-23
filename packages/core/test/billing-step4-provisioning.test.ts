/**
 * Billing Step 4 — sandbox plan provisioning: PURE admission/validation suite.
 *
 * The provisioning workflow turns ONE authoritative USD→GHS FX rate version
 * plus the operator's evidence for the four genuine sandbox provider plans
 * into four immutable local epochs. These tests pin every rule of the
 * preparation phase — before anything is ever written:
 *
 *  A. the batch is exactly Pro Monthly / Pro Annual / Elite Monthly / Elite
 *     Annual (provider variants of the two sellable catalogue plans), the
 *     local annual ⇄ provider annually mapping is explicit, and Starter,
 *     duplicates, unsupported currencies/periods and live mode are refused;
 *  B. the FX version must be an existing, well-formed USD→GHS authority row
 *     within the 900-second freshness window (899/900 accepted, 901 rejected,
 *     future refused), one shared version for the whole batch (mixed ids
 *     refuse), and a non-authority shape is never promoted;
 *  C. the GHS amounts are the catalogue amounts converted with exactly one
 *     BigInt half-up step in the existing pricing authority — fractional,
 *     exact-half, minimum, large-value and deterministic cases included;
 *  D. provider evidence is validated: genuine-format codes only, the excluded
 *     GHS 2.00 evidence plan and placeholder/fixture codes refuse, test mode,
 *     GHS, exponent 2, an exact amount match and explicit uncapped evidence
 *     are all mandatory;
 *  G. boundary isolation: the module contains no provider mutation, no
 *     transport, no credential and no re-implemented pricing.
 *
 * No database and no network are involved in this suite.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_CATALOGUE_VERSION,
  BILLING_PRICING_POLICY_VERSION,
  BillingPlanProvisioningService,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  isBillingFxError,
  isBillingProvisioningError,
  prepareSandboxProvisioningBatch,
  providerIntervalForBillingInterval,
  sandboxProvisioningRegisterInputs,
  assertSandboxRegistrationBatchAdmissible,
  sandboxProviderPlanEvidenceSchema,
  SANDBOX_PLAN_MATRIX,
  PROVIDER_INTERVAL_FOR_BILLING_INTERVAL,
  EXCLUDED_PROVIDER_PLAN_CODE,
  isExcludedProviderPlanCode,
  type SandboxPlanMatrixEntry,
  type ValidatedSandboxEpochRegistration,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX_VERSION_ID = '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01';
const REGISTERED_AT = new Date('2026-09-22T12:00:00.000Z');
const CAPTURED_AT = new Date('2026-09-22T11:55:00.000Z'); // 300 s old at registration

/** A raw FX authority row, exactly as migration 0032 stores one (12.5 GHS/USD). */
function fxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FX_VERSION_ID,
    base_currency: 'USD',
    quote_currency: 'GHS',
    fx_rate_scaled: '12500000',
    fx_rate_scale: 6,
    rounding_mode: 'half_up',
    source: 'ops',
    source_reference: 'ops-board-1',
    created_by: 'ops@example.com',
    effective_from: CAPTURED_AT,
    captured_at: CAPTURED_AT,
    ...overrides,
  };
}

/** A genuine-format provider code: PLN_ + lowercase alphanumeric (here: random hex). */
function planCode(): string {
  return `PLN_${randomUUID().replaceAll('-', '')}`;
}

/** The amount the selected FX version derives for a combination (catalogue × FX, half-up). */
function derivedAmount(
  cataloguePlan: 'pro' | 'elite',
  interval: 'monthly' | 'annual',
  rateScaled = 12_500_000n,
  rateScale = 6,
): bigint {
  return computePaymentAmountMinor({
    usdMinor: BigInt(cataloguePriceMinor(cataloguePlan, interval)),
    rateScaled,
    rateScale,
  });
}

/** One operator-evidence entry, valid unless overridden. */
function evidenceFor(
  cataloguePlan: 'pro' | 'elite',
  interval: 'monthly' | 'annual',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cataloguePlan,
    interval,
    providerInterval: providerIntervalForBillingInterval(interval),
    providerPlanId: planCode(),
    paymentCurrency: 'GHS',
    paymentAmountMinor: derivedAmount(cataloguePlan, interval),
    paymentAmountExponent: 2,
    mode: 'test',
    paymentCountCap: 'uncapped',
    evidenceReference: 'ops-sandbox-plan-evidence-2026-09-22',
    ...overrides,
  };
}

function fullEvidence(): Record<string, unknown>[] {
  return [
    evidenceFor('pro', 'monthly'),
    evidenceFor('pro', 'annual'),
    evidenceFor('elite', 'monthly'),
    evidenceFor('elite', 'annual'),
  ];
}

function prepare(overrides: Record<string, unknown> = {}) {
  return prepareSandboxProvisioningBatch({
    fxVersion: fxRow(),
    evidence: fullEvidence(),
    registeredAt: REGISTERED_AT,
    ...overrides,
  });
}

const provisioningReason = (error: unknown): string => {
  assert.ok(isBillingProvisioningError(error), `expected a BillingProvisioningError, got ${String(error)}`);
  return error.reason;
};
const fxReason = (error: unknown): string => {
  assert.ok(isBillingFxError(error), `expected a BillingFxError, got ${String(error)}`);
  return error.reason;
};
function throwsReason(run: () => unknown, expected: string): void {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, null, `expected a failure with reason ${expected}`);
  assert.equal(provisioningReason(caught), expected);
}

/* -------------------------------------------------------------------------- */
/* A. Catalogue / batch shape                                                  */
/* -------------------------------------------------------------------------- */

describe('Step 4 — A. the batch is exactly the four sandbox plans', () => {
  test('the matrix names exactly four combinations and no amounts', () => {
    assert.deepEqual(
      SANDBOX_PLAN_MATRIX.map((entry: SandboxPlanMatrixEntry) => [entry.cataloguePlan, entry.interval, entry.providerInterval]),
      [
        ['pro', 'monthly', 'monthly'],
        ['pro', 'annual', 'annually'],
        ['elite', 'monthly', 'monthly'],
        ['elite', 'annual', 'annually'],
      ],
    );
    for (const entry of SANDBOX_PLAN_MATRIX) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['cataloguePlan', 'interval', 'providerInterval'],
        'the matrix never restates a price — amounts come from the catalogue authority (D-5)',
      );
      assert.ok(Object.isFrozen(entry));
    }
    assert.ok(Object.isFrozen(SANDBOX_PLAN_MATRIX));
    assert.ok(!SANDBOX_PLAN_MATRIX.some((entry) => (entry.cataloguePlan as string) === 'starter'));
  });

  test('local annual maps explicitly onto provider annually (and monthly onto monthly)', () => {
    assert.equal(providerIntervalForBillingInterval('monthly'), 'monthly');
    assert.equal(providerIntervalForBillingInterval('annual'), 'annually');
    assert.ok(Object.isFrozen(PROVIDER_INTERVAL_FOR_BILLING_INTERVAL));
    throwsReason(() => providerIntervalForBillingInterval('weekly' as never), 'interval_mismatch');
  });

  test('a valid batch validates into four registrations in matrix order', () => {
    const evidence = fullEvidence();
    const batch = prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence, registeredAt: REGISTERED_AT });
    assert.equal(batch.fxVersion.id, FX_VERSION_ID);
    assert.equal(batch.registeredAt.getTime(), REGISTERED_AT.getTime());
    assert.deepEqual(
      batch.registrations.map((reg) => [reg.cataloguePlan, reg.interval, reg.providerInterval]),
      [
        ['pro', 'monthly', 'monthly'],
        ['pro', 'annual', 'annually'],
        ['elite', 'monthly', 'monthly'],
        ['elite', 'annual', 'annually'],
      ],
    );
    // Derived EXACTLY as catalogue × FX (12.5): 487.50 / 4,875.00 / 1,237.50 / 12,375.00 GHS.
    const expected: Record<string, [string, bigint, number]> = {
      'pro/monthly': ['monthly', 48_750n, 3_900],
      'pro/annual': ['annually', 487_500n, 39_000],
      'elite/monthly': ['monthly', 123_750n, 9_900],
      'elite/annual': ['annually', 1_237_500n, 99_000],
    };
    for (const registration of batch.registrations) {
      const key = `${registration.cataloguePlan}/${registration.interval}`;
      const [providerInterval, ghsMinor, usdMinor] = expected[key]!;
      assert.equal(registration.providerInterval, providerInterval);
      assert.equal(registration.paymentAmountMinor, ghsMinor, key);
      assert.equal(registration.paymentAmountMinor, derivedAmount(
        registration.cataloguePlan as 'pro' | 'elite',
        registration.interval,
      ), 'the registration amount is the pricing-authority derivation');
      assert.equal(registration.catalogueAmountMinor, usdMinor, key);
      assert.equal(registration.catalogueAmountMinor, cataloguePriceMinor(
        registration.cataloguePlan as 'pro' | 'elite',
        registration.interval,
      ), 'the catalogue amount comes from the catalogue, never restated');
      assert.equal(registration.fxRateVersionId, FX_VERSION_ID, 'one shared FX version (D-9/§6)');
      assert.equal(registration.pricingPolicyVersion, BILLING_PRICING_POLICY_VERSION);
      assert.equal(registration.catalogueVersion, BILLING_CATALOGUE_VERSION);
      assert.equal(registration.paymentCurrency, 'GHS');
    }

    const inputs = sandboxProvisioningRegisterInputs(batch);
    assert.equal(inputs.length, 4);
    for (const input of inputs) {
      assert.equal(typeof input.catalogueAmountMinor, 'bigint');
      assert.equal(input.validFrom?.getTime(), REGISTERED_AT.getTime());
      assert.equal(input.providerPlanReference, 'ops-sandbox-plan-evidence-2026-09-22');
      assert.equal(input.pricingPolicyVersion, 'pr3-usd-ghs-v1');
      assert.equal(input.catalogueVersion, 'billing-catalogue-1');
    }
    // Determinism: the same batch validates into the identical plan twice (D-7).
    const again = prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence, registeredAt: REGISTERED_AT });
    assert.deepEqual(again.registrations, batch.registrations);
    assert.deepEqual(sandboxProvisioningRegisterInputs(again), sandboxProvisioningRegisterInputs(batch));
  });

  test('partial, oversized or empty batches are refused', () => {
    throwsReason(() => prepare({ evidence: [] }), 'plan_matrix');
    throwsReason(() => prepare({ evidence: fullEvidence().slice(0, 3) }), 'plan_matrix');
    throwsReason(() => prepare({ evidence: [...fullEvidence(), evidenceFor('pro', 'monthly')] }), 'plan_matrix');
  });

  test('Starter is refused, and a duplicate combination is refused', () => {
    // A starter entry passes the local plan-id schema (starter IS a plan id)…
    const starterEntry = evidenceFor('elite', 'annual');
    starterEntry['cataloguePlan'] = 'starter';
    sandboxProviderPlanEvidenceSchema.parse(starterEntry);
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), starterEntry] }),
      'plan_matrix', // …and is refused by the four-combination matrix
    );
    const duplicated = fullEvidence();
    duplicated[3] = evidenceFor('pro', 'monthly'); // pro/monthly twice, elite/annual missing
    throwsReason(() => prepare({ evidence: duplicated }), 'duplicate_combination');
  });

  test('unsupported currencies, periods and live mode are refused', () => {
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentCurrency: 'USD' })] }),
      'currency_mismatch',
    );
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentCurrency: 'GHC' })] }),
      'currency_mismatch',
    );
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { interval: 'weekly' })] }),
      'invalid_evidence',
    );
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { providerInterval: 'weekly' })] }),
      'invalid_evidence',
    );
    throwsReason(
      () =>
        prepare({
          evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { providerInterval: 'monthly' })],
        }),
      'interval_mismatch',
    );
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { mode: 'live' })] }),
      'mode_mismatch',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* B. FX authority + freshness                                                 */
/* -------------------------------------------------------------------------- */

describe('Step 4 — B. the selected FX version must be an authoritative fresh USD→GHS row', () => {
  test('a wrong currency pair is refused', () => {
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ base_currency: 'EUR' }) }))), 'unsupported_currency');
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ quote_currency: 'USD' }) }))), 'unsupported_currency');
  });

  test('non-positive rates, invalid scales and unknown rounding modes are refused', () => {
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ fx_rate_scaled: '0' }) }))), 'invalid');
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ fx_rate_scaled: '-12' }) }))), 'invalid');
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ fx_rate_scale: 0 }) }))), 'invalid');
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ fx_rate_scale: 19 }) }))), 'invalid');
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ rounding_mode: 'half_even' }) }))), 'invalid');
    assert.equal(fxReason(catched(() => prepare({ fxVersion: fxRow({ source: 'paystack' }) }))), 'invalid');
  });

  test('the exact 900-second boundary is inclusive: 899 and 900 pass, 901 is stale', () => {
    const at = (secondsBefore: number): Date => new Date(REGISTERED_AT.getTime() - secondsBefore * 1000);
    assert.doesNotThrow(() => prepare({ fxVersion: fxRow({ captured_at: at(899), effective_from: at(899) }) }));
    assert.doesNotThrow(() => prepare({ fxVersion: fxRow({ captured_at: at(900), effective_from: at(900) }) }));
    assert.equal(
      fxReason(catched(() => prepare({ fxVersion: fxRow({ captured_at: at(901), effective_from: at(901) }) }))),
      'stale',
    );
  });

  test('a future-dated or not-yet-effective version is refused', () => {
    // captured after the registration instant (effective bumped to stay coherent):
    const future = new Date(REGISTERED_AT.getTime() + 1000);
    assert.equal(
      fxReason(catched(() => prepare({ fxVersion: fxRow({ captured_at: future, effective_from: future }) }))),
      'invalid',
    );
    // captured after effective violates the authority's own coherence rule:
    assert.equal(
      fxReason(
        catched(() =>
          prepare({
            fxVersion: fxRow({
              captured_at: new Date(CAPTURED_AT.getTime() + 1000),
              effective_from: CAPTURED_AT,
            }),
          }),
        ),
      ),
      'invalid',
    );
  });

  test('a non-authority shape is never promoted to authority', () => {
    // A normalized camelCase version object is NOT the durable row:
    assert.equal(
      fxReason(
        catched(() =>
          prepare({
            fxVersion: {
              id: FX_VERSION_ID,
              baseCurrency: 'USD',
              quoteCurrency: 'GHS',
              fxRateScaled: 12500000n,
              fxRateScale: 6,
              roundingMode: 'half_up',
              source: 'ops',
              effectiveFrom: CAPTURED_AT,
              capturedAt: CAPTURED_AT,
            },
          }),
        ),
      ),
      'invalid',
    );
    // Nor is a pricing FX snapshot (base/quote + rate + version id):
    assert.equal(
      fxReason(
        catched(() =>
          prepare({
            fxVersion: {
              baseCurrency: 'USD',
              quoteCurrency: 'GHS',
              fxRateScaled: 12500000,
              fxRateScale: 6,
              fxRateVersionId: FX_VERSION_ID,
              fxRateEffectiveFrom: CAPTURED_AT.toISOString(),
              fxRateCapturedAt: CAPTURED_AT.toISOString(),
              fxRateSource: 'ops',
              roundingMode: 'half_up',
            },
          }),
        ),
      ),
      'invalid',
    );
  });

  test('batch admission refuses mixed FX version ids, duplicate combos and duplicate provider codes', () => {
    const { registrations } = prepare();
    const mixed = registrations.map((reg, index) =>
      index === 0 ? { ...reg, fxRateVersionId: '11111111-2222-3333-4444-555555555555' } : reg,
    );
    throwsReason(() => assertSandboxRegistrationBatchAdmissible(mixed), 'shared_fx_violation');

    const duplicatedCode = registrations.map((reg, index) =>
      index > 0 ? { ...reg, providerPlanId: registrations[0]!.providerPlanId } : reg,
    );
    throwsReason(() => assertSandboxRegistrationBatchAdmissible(duplicatedCode), 'duplicate_provider_plan');

    const duplicatedCombo = registrations.map((reg, index, all) =>
      index === 1
        ? ({ ...reg, cataloguePlan: all[0]!.cataloguePlan, interval: all[0]!.interval } as ValidatedSandboxEpochRegistration)
        : reg,
    );
    throwsReason(() => assertSandboxRegistrationBatchAdmissible(duplicatedCombo), 'duplicate_combination');

    throwsReason(() => assertSandboxRegistrationBatchAdmissible(registrations.slice(0, 3)), 'plan_matrix');
    const wrongCombo = registrations.map((reg, index) =>
      index === 3 ? ({ ...reg, cataloguePlan: 'beginner' } as unknown as ValidatedSandboxEpochRegistration) : reg,
    );
    throwsReason(() => assertSandboxRegistrationBatchAdmissible(wrongCombo), 'plan_matrix');
    assert.doesNotThrow(() => assertSandboxRegistrationBatchAdmissible(registrations));
  });
});

/* -------------------------------------------------------------------------- */
/* C. Exact price derivation                                                   */
/* -------------------------------------------------------------------------- */

describe('Step 4 — C. amounts derive with exactly one BigInt half-up step', () => {
  test('fractional results round half-up, and the exact-half rounds up', () => {
    // 3900 minor units at 0.375 ⇒ 1462.5 ⇒ 1463 (exact half rounds UP).
    assert.equal(computePaymentAmountMinor({ usdMinor: 3900n, rateScaled: 375n, rateScale: 3 }), 1463n);
    // An inexact non-half fraction rounds by the exact ratio, not by truncation.
    assert.equal(computePaymentAmountMinor({ usdMinor: 9900n, rateScaled: 333n, rateScale: 3 }), 3297n); // 3296.7
    assert.equal(computePaymentAmountMinor({ usdMinor: 3901n, rateScaled: 5n, rateScale: 1 }), 1951n); // 1950.5
    // A fractional, exact-half batch derives (and must be admitted) correctly:
    const fractionalFx = fxRow({ fx_rate_scaled: '375', fx_rate_scale: 3 });
    const batch = prepareSandboxProvisioningBatch({
      fxVersion: fractionalFx,
      evidence: [
        evidenceFor('pro', 'monthly', { paymentAmountMinor: 1463n }),
        evidenceFor('pro', 'annual', { paymentAmountMinor: 14_625n }),
        evidenceFor('elite', 'monthly', { paymentAmountMinor: 3713n }), // 3712.5 ⇒ up
        evidenceFor('elite', 'annual', { paymentAmountMinor: 37_125n }),
      ],
      registeredAt: REGISTERED_AT,
    });
    assert.equal(batch.registrations[0]!.paymentAmountMinor, 1463n);
    assert.equal(batch.registrations[2]!.paymentAmountMinor, 3713n);
  });

  test('a derived amount below the provider minimum is refused, never rounded up', () => {
    // A near-zero rate drives the derived amount to 0 pesewas (< the 10 floor).
    throwsReason(
      () =>
        prepare({
          fxVersion: fxRow({ fx_rate_scaled: '1', fx_rate_scale: 9 }),
          evidence: [
            evidenceFor('pro', 'monthly', { paymentAmountMinor: 0n }),
            evidenceFor('pro', 'annual', { paymentAmountMinor: 0n }),
            evidenceFor('elite', 'monthly', { paymentAmountMinor: 0n }),
            evidenceFor('elite', 'annual', { paymentAmountMinor: 0n }),
          ],
        }),
      'below_minimum',
    );
    // At exactly the floor the batch ADMITS: 3900 × 0.00256410265 ≈ 10.000000335 ⇒ 10 ≥ 10.
    const floorRate = { rateScaled: 256_410_265n, rateScale: 11 };
    assert.equal(computePaymentAmountMinor({ usdMinor: 3900n, ...floorRate }), 10n);
    const batch = prepareSandboxProvisioningBatch({
      fxVersion: fxRow({ fx_rate_scaled: floorRate.rateScaled.toString(), fx_rate_scale: floorRate.rateScale }),
      evidence: [
        evidenceFor('pro', 'monthly', { paymentAmountMinor: 10n }),
        evidenceFor('pro', 'annual', { paymentAmountMinor: 100n }),
        evidenceFor('elite', 'monthly', { paymentAmountMinor: 25n }),
        evidenceFor('elite', 'annual', { paymentAmountMinor: 254n }),
      ],
      registeredAt: REGISTERED_AT,
    });
    assert.equal(batch.registrations[0]!.paymentAmountMinor, 10n);
  });

  test('large and extreme values stay exact, deterministic and unrounded', () => {
    // 13 GHS/USD on a 2^60 minor-unit amount: exact, beyond float precision.
    assert.equal(
      computePaymentAmountMinor({ usdMinor: 2n ** 60n, rateScaled: 13_000_000n, rateScale: 6 }),
      13n * 2n ** 60n,
    );
    // A rate whose result is not exactly representable in doubles still derives exactly:
    const big = computePaymentAmountMinor({ usdMinor: 2n ** 60n, rateScaled: 10n ** 18n, rateScale: 1 });
    assert.equal(big, 2n ** 60n * 10n ** 17n);
    assert.equal(
      computePaymentAmountMinor({ usdMinor: 2n ** 60n, rateScaled: 10n ** 18n, rateScale: 1 }),
      big,
      'repeated derivation is deterministic (D-7)',
    );
    // A large inexact value rounds half-up exactly: 98999999999.901 ⇒ 99000000000.
    assert.equal(
      computePaymentAmountMinor({ usdMinor: 99_000n, rateScaled: 999_999_999_999n, rateScale: 6 }),
      99_000_000_000n,
    );
  });

  test('evidence amounts must equal the derived amount exactly', () => {
    throwsReason(
      () =>
        prepare({
          evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentAmountMinor: 1_237_501n })],
        }),
      'amount_mismatch',
    );
    // The USD catalogue amount itself is not a GHS amount:
    throwsReason(
      () =>
        prepare({
          evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentAmountMinor: 99_000n })],
        }),
      'amount_mismatch',
    );
    throwsReason(
      () =>
        prepare({
          evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentAmountMinor: 0 })],
        }),
      'amount_mismatch',
    );
    throwsReason(
      () =>
        prepare({
          evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentAmountMinor: '1237500.00' })],
        }),
      'invalid_evidence',
    );
    // …but the same value as bigint, integer string or safe integer is accepted.
    for (const shape of [1_237_500n, '1237500', 1_237_500]) {
      assert.doesNotThrow(() =>
        prepare({
          evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentAmountMinor: shape })],
        }),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* D. Provider evidence                                                        */
/* -------------------------------------------------------------------------- */

describe('Step 4 — D. provider evidence must be genuine, explicit and sandbox', () => {
  test('malformed, placeholder-shaped and fixture-shaped codes are refused', () => {
    const invalid = [
      ['slugged placeholder', 'PLN_pro_monthly'],
      ['uppercase', 'PLN_ABCDEF123'],
      ['too short', 'PLN_x1'],
      ['empty suffix', 'PLN_'],
      ['no provider prefix', 'pro_monthly_plan'],
      ['fixture marker (sample)', 'PLN_00sample00'],
      ['fixture marker (test)', 'PLN_a1b2testc3'],
      ['fixture marker (changeme)', 'PLN_changeme01'],
      ['fixture marker (fake)', 'PLN_123fake456'],
      ['placeholder word', 'PLN_placeholder1'],
    ] as const;
    for (const [label, code] of invalid) {
      throwsReason(
        () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { providerPlanId: code })] }),
        'invalid_provider_plan',
      );
      void label;
    }
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { providerPlanId: '' })] }),
      'invalid_evidence',
    );
  });

  test('the excluded GHS 2.00 evidence plan is refused as a batch member', () => {
    // The exclusion constant IS the documented evidence-plan code (assembled,
    // never written as a code/test/migration literal).
    assert.equal(EXCLUDED_PROVIDER_PLAN_CODE, ['PLN', 'u0l4961hhipl6ek'].join('_'));
    assert.ok(isExcludedProviderPlanCode(EXCLUDED_PROVIDER_PLAN_CODE));
    assert.ok(!isExcludedProviderPlanCode(planCode()));
    throwsReason(
      () =>
        prepare({
          evidence: [
            ...fullEvidence().slice(0, 3),
            evidenceFor('elite', 'annual', { providerPlanId: EXCLUDED_PROVIDER_PLAN_CODE }),
          ],
        }),
      'excluded_provider_plan',
    );
    // …even when dressed with a matching amount and cap-free evidence: the
    // code itself is what is excluded, so it can never be laundered through.
    throwsReason(
      () =>
        prepare({
          evidence: [
            ...fullEvidence().slice(0, 3),
            evidenceFor('elite', 'annual', {
              providerPlanId: EXCLUDED_PROVIDER_PLAN_CODE,
              paymentCountCap: { capped: true, maxPayments: 1 },
            }),
          ],
        }),
      'excluded_provider_plan',
    );
  });

  test('duplicate provider codes inside the batch are refused', () => {
    const evidence = fullEvidence();
    const first = evidence[0]!['providerPlanId'] as string;
    evidence[3] = evidenceFor('elite', 'annual', { providerPlanId: first });
    throwsReason(() => prepare({ evidence }), 'duplicate_provider_plan');
  });

  test('test mode, GHS, exponent 2 and an uncapped payment count are mandatory', () => {
    throwsReason(
      () => prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { mode: 'TEST' })] }),
      'mode_mismatch',
    );
    throwsReason(
      () =>
        prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentAmountExponent: 3 })] }),
      'exponent_mismatch',
    );
    // Explicit cap evidence: capped at 1 (the evidence-plan shape) or at 12.
    throwsReason(
      () =>
        prepare({
          evidence: [
            ...fullEvidence().slice(0, 3),
            evidenceFor('elite', 'annual', { paymentCountCap: { capped: true, maxPayments: 1 } }),
          ],
        }),
      'cap_mismatch',
    );
    throwsReason(
      () =>
        prepare({
          evidence: [
            ...fullEvidence().slice(0, 3),
            evidenceFor('elite', 'annual', { paymentCountCap: { capped: true, maxPayments: 12 } }),
          ],
        }),
      'cap_mismatch',
    );
    throwsReason(
      () =>
        prepare({
          evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { paymentCountCap: 'unknown' })],
        }),
      'cap_mismatch',
    );
    // Missing cap evidence is rejected, never defaulted:
    const missingCap = evidenceFor('elite', 'annual');
    delete missingCap['paymentCountCap'];
    throwsReason(() => prepare({ evidence: [...fullEvidence().slice(0, 3), missingCap] }), 'invalid_evidence');
    // Missing provenance and unknown extra fields are rejected too:
    const missingReference = evidenceFor('elite', 'annual');
    delete missingReference['evidenceReference'];
    throwsReason(() => prepare({ evidence: [...fullEvidence().slice(0, 3), missingReference] }), 'invalid_evidence');
    throwsReason(
      () =>
        prepare({ evidence: [...fullEvidence().slice(0, 3), evidenceFor('elite', 'annual', { mystery: 1 })] }),
      'invalid_evidence',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The service input boundary — refused before any database read               */
/* -------------------------------------------------------------------------- */

describe('Step 4 — the service refuses malformed requests before any database read', () => {
  /**
   * The request envelope (`fxRateVersionId` + `evidence`) is validated before
   * the pool is ever touched: a malformed version id or an empty evidence list
   * cannot even reserve a connection.
   */
  function serviceThatMustNotConnect(): BillingPlanProvisioningService {
    const pool = {
      connect: async () => {
        throw new Error('the request must be refused before a connection exists');
      },
    };
    return new BillingPlanProvisioningService({ db: pool as never });
  }

  test('a malformed fx_rate_version_id is refused', async () => {
    for (const bad of ['not-a-uuid', 'FX-2026-09-22', '', 42]) {
      await assert.rejects(
        serviceThatMustNotConnect().registerSandboxPlanEpochs({ fxRateVersionId: bad, evidence: fullEvidence() }),
        (error: unknown) => {
          assert.ok(isBillingProvisioningError(error), `expected BillingProvisioningError, got ${String(error)}`);
          return error.reason === 'invalid_evidence';
        },
      );
    }
  });

  test('an empty or non-array evidence payload is refused', async () => {
    const service = serviceThatMustNotConnect();
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: randomUUID(), evidence: [] }),
      (error: unknown) => (error as { reason?: string }).reason === 'invalid_evidence',
    );
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: randomUUID(), evidence: 'PLN_something' }),
      (error: unknown) => (error as { reason?: string }).reason === 'invalid_evidence',
    );
    await assert.rejects(service.registerSandboxPlanEpochs(null), (error: unknown) =>
      (error as { reason?: string }).reason === 'invalid_evidence',
    );
    await assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: randomUUID(), evidence: fullEvidence(), extra: true }),
      (error: unknown) => (error as { reason?: string }).reason === 'invalid_evidence',
      'unknown envelope keys are refused (.strict) — never silently dropped',
    );
  });

  test('a non-finite registration instant is refused', () => {
    const pool = {
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    };
    const service = new BillingPlanProvisioningService({
      db: pool as never,
      now: () => new Date('not a date'),
    });
    return assert.rejects(
      service.registerSandboxPlanEpochs({ fxRateVersionId: randomUUID(), evidence: fullEvidence() }),
      (error: unknown) => (error as { reason?: string }).reason === 'invalid_instant',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* G. Boundary isolation (source assertions)                                   */
/* -------------------------------------------------------------------------- */

describe('Step 4 — G. the provisioning workflow stays outside the adapter and reproduces nothing', () => {
  const provisioningSource = readFileSync(path.join(HERE, '..', 'src', 'billing', 'provisioning.ts'), 'utf8');
  const providerPlansSource = readFileSync(path.join(HERE, '..', 'src', 'billing', 'provider-plans.ts'), 'utf8');

  test('no provider mutation, no transport, no credential, no environment read', () => {
    for (const forbidden of [
      /@veltrixeye\/provider-paystack/, // the adapter is never imported here
      /\bfetch\s*\(/, // no transport of any kind
      /api\.paystack/i,
      /process\.env/, // configuration is injected, never read from the environment here
      /sk_test_[A-Za-z0-9]/,
      /sk_live_[A-Za-z0-9]/,
      /['"`](POST|PUT|PATCH|DELETE)['"`]/, // no HTTP verbs at all
      /['"`]\/plan['"`]/, // no provider /plan request path (mutation stays out)
      /\bcreatePlan\b/,
      /\bupdatePlan\b/,
      /\bdeletePlan\b/,
      /\.publish\s*\(/, // the FX authority is read-only here: nothing is (re)published
      /ON CONFLICT/i, // conflicts surface; nothing is upserted
      /\.retire\s*\(/, // no automatic retirement anywhere in provisioning
    ]) {
      assert.doesNotMatch(provisioningSource, forbidden, `provisioning must never do this (${forbidden})`);
    }
  });

  test('the derivation reuses the catalogue and pricing authorities — nothing is re-implemented', () => {
    assert.match(provisioningSource, /cataloguePriceMinor\b/, 'prices come from the catalogue authority');
    assert.match(provisioningSource, /computePaymentAmountMinor\b/, 'the one half-up step is reused, not copied');
    assert.match(provisioningSource, /assertFxRateVersionFresh\b/, 'the 900-second rule is the existing authority');
    for (const priceLiteral of [/\b3900\b/, /\b39000\b/, /\b9900\b/, /\b99000\b/]) {
      assert.doesNotMatch(provisioningSource, priceLiteral, `no catalogue price is restated (${priceLiteral})`);
    }
    assert.doesNotMatch(provisioningSource, /parseFloat/, 'money is never a float');
    assert.match(provisioningSource, /registerSandboxPlanEpochs/, 'the workflow entry point exists');
  });

  test('the repaired store keeps one explicit, parser-compatible row projection', () => {
    // findActive's SELECT and both RETURNING clauses must project the SAME
    // column list (never *): the strict epoch parser refuses the durable
    // audit columns (catalogue_amount_minor, created_at, updated_at).
    const projections = [
      ...providerPlansSource.matchAll(/(?:SELECT|RETURNING)\s+(id, provider, mode[\s\S]*?retired_reason)/g),
    ].map((match) => match[1]!.replace(/\s+/g, ' ').trim());
    assert.equal(projections.length, 3, 'one lookup SELECT and two RETURNING clauses');
    for (const projection of projections) {
      assert.equal(
        projection,
        'id, provider, mode, catalogue_plan, billing_interval, payment_currency, payment_amount_minor, ' +
          'payment_amount_exponent, provider_plan_id, provider_plan_reference, fx_rate_version_id, ' +
          'pricing_policy_version, catalogue_version, status, valid_from, retired_at, retired_reason',
      );
    }
    assert.doesNotMatch(providerPlansSource, /RETURNING \*`/, 'no full-row RETURNING statement remains');
    assert.match(
      providerPlansSource,
      /catalogue_amount_minor/,
      'registration persists the catalogue amount (the Step 4 repair)',
    );
  });
});

function catched(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}
