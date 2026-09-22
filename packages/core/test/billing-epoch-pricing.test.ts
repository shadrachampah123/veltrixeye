/**
 * Billing PR B — epoch-derived pricing (D-9).
 *
 * The active provider-plan epoch is the commercial truth for a plan-bound
 * purchase: a plan-bound pricing snapshot reuses the epoch's frozen GHS amount,
 * the epoch's FX facts, the epoch's provider plan identifier and the epoch's
 * pricing-policy version. It never reprices from a live rate. These tests pin
 * that behaviour:
 *  - deriving from the active epoch copies the frozen amount and the epoch's
 *    FX facts verbatim, with the catalogue USD amount and no freshness check —
 *    an epoch whose FX version is hours old still derives (D-9), while pricing
 *    a NEW amount from that same aged rate is refused (D-3);
 *  - a derived snapshot passes the plan-bound checkout guard
 *    (`assertProviderPlanMatches`) against its epoch by construction;
 *  - an already-derived snapshot keeps its epoch and amount after the epoch is
 *    retired and a new epoch is registered (D-1, D-8): it still verifies, and
 *    it mismatches — never silently re-bills under — the new epoch;
 *  - a new derivation resolves to the new epoch and its new amount;
 *  - a retired epoch, a foreign FX version, a malformed epoch/FX row, a broken
 *    amount identity and a below-minimum epoch amount all refuse — never
 *    recompute, never fall back;
 *  - derivation is deterministic (D-7): the same epoch always collapses onto
 *    the same idempotency key;
 *  - the GHS 2.00 evidence plan (contract §7.1) remains excluded: its code
 *    appears in the documentation that excludes it and nowhere in code.
 *
 * No database and no network are involved in this suite.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_CATALOGUE_VERSION,
  assertProviderPlanMatches,
  isBillingFxError,
  isBillingPricingError,
  isBillingProviderPlanError,
  parseProviderPlan,
  priceCommercialPlan,
  priceFromProviderPlanEpoch,
  pricingIdempotencyKey,
  providerPlanExpectationFromSnapshot,
  providerPlanKey,
  selectActiveProviderPlan,
  verifyPricingSnapshot,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX_VERSION_ID = '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01';
const FX_VERSION_ID_V2 = '4a8b7c1f-7c3a-4f59-8b2a-3d7e6c9f0b12';
const CAPTURED_AT = new Date('2026-09-22T09:00:00.000Z');

/** A raw FX authority row, exactly as the durable table stores one. */
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
    effective_from: new Date('2026-09-22T09:00:00.000Z'),
    captured_at: new Date('2026-09-22T09:00:00.000Z'),
    ...overrides,
  };
}

/** A durable epoch row, exactly as migration 0032 stores one. */
function epochRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'paystack',
    mode: 'test',
    catalogue_plan: 'pro',
    billing_interval: 'monthly',
    payment_currency: 'GHS',
    payment_amount_minor: '48750',
    payment_amount_exponent: 2,
    provider_plan_id: 'PLN_pro_monthly',
    provider_plan_reference: null,
    fx_rate_version_id: FX_VERSION_ID,
    pricing_policy_version: 'pr3-usd-ghs-v1',
    catalogue_version: 'billing-catalogue-1',
    status: 'active',
    valid_from: new Date('2026-09-22T09:00:00.000Z'),
    retired_at: null,
    retired_reason: null,
    ...overrides,
  };
}

/** A second-epoch FX version: 13.0 GHS per USD, effective later. */
function fxRowV2(overrides: Record<string, unknown> = {}) {
  return fxRow({
    id: FX_VERSION_ID_V2,
    fx_rate_scaled: '13000000',
    fx_rate_scale: 6,
    source_reference: 'ops-board-2',
    effective_from: new Date('2026-09-22T12:00:00.000Z'),
    captured_at: new Date('2026-09-22T12:00:00.000Z'),
    ...overrides,
  });
}

/** A second epoch: Pro monthly at 13.0 GHS/USD ⇒ 50,700 pesewas. */
function epochRowV2(overrides: Record<string, unknown> = {}) {
  return epochRow({
    id: '22222222-2222-4222-8222-222222222222',
    payment_amount_minor: '50700',
    provider_plan_id: 'PLN_pro_monthly_v2',
    fx_rate_version_id: FX_VERSION_ID_V2,
    valid_from: new Date('2026-09-22T12:00:00.000Z'),
    ...overrides,
  });
}

const pricingReason = (error: unknown): string => {
  assert.ok(isBillingPricingError(error), `expected a BillingPricingError, got ${String(error)}`);
  return error.reason;
};

const planReason = (error: unknown): string => {
  assert.ok(
    isBillingProviderPlanError(error),
    `expected a BillingProviderPlanError, got ${String(error)}`,
  );
  return error.reason;
};

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('Billing PR B — deriving from the active epoch', () => {
  test('the snapshot reuses the frozen amount, the epoch FX facts and the epoch plan identity', () => {
    const asOf = new Date('2026-09-22T09:05:00.000Z');
    const snapshot = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf,
      providerReference: 've-chk-0001',
    });

    // The commercial facts come from the catalogue (D-5), not the epoch.
    assert.equal(snapshot.cataloguePlan, 'pro');
    assert.equal(snapshot.interval, 'monthly');
    assert.equal(snapshot.commercialCurrency, 'USD');
    assert.equal(snapshot.commercialAmountMinor, 3_900);
    assert.equal(snapshot.catalogueVersion, BILLING_CATALOGUE_VERSION);
    // The payable facts are the epoch's frozen facts, verbatim (D-9).
    assert.deepEqual(snapshot.payment, {
      paymentCurrency: 'GHS',
      paymentAmountMinor: 48_750,
      paymentAmountExponent: 2,
    });
    assert.equal(snapshot.providerPlanId, 'PLN_pro_monthly');
    assert.equal(snapshot.pricingPolicyVersion, 'pr3-usd-ghs-v1');
    // The epoch's FX facts are the disclosed FX facts — not a live rate.
    assert.equal(snapshot.fx.fxRateVersionId, FX_VERSION_ID);
    assert.equal(snapshot.fx.fxRateScaled, 12_500_000);
    assert.equal(snapshot.fx.fxRateScale, 6);
    assert.equal(snapshot.fx.fxRateEffectiveFrom, '2026-09-22T09:00:00.000Z');
    assert.equal(snapshot.fx.fxRateCapturedAt, '2026-09-22T09:00:00.000Z');
    assert.equal(snapshot.fx.fxRateSource, 'ops');
    // Traceability only.
    assert.equal(snapshot.providerReference, 've-chk-0001');
    assert.equal(snapshot.computedAt, asOf.toISOString());
  });

  test('the reference defaults to null and is carried through when given', () => {
    const asOf = new Date('2026-09-22T09:05:00.000Z');
    const without = priceFromProviderPlanEpoch({ epoch: epochRow(), fxVersion: fxRow(), asOf });
    assert.equal(without.providerReference, null);
    const withReference = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf,
      providerReference: 've-chk-0002',
    });
    assert.equal(withReference.providerReference, 've-chk-0002');
  });

  test('an epoch whose FX version is hours old still derives (D-9), while a NEW price from that rate is refused (D-3)', () => {
    // Six hours after the rate was captured: far past the 15-minute bound.
    const asOf = new Date('2026-09-22T15:00:00.000Z');
    const derived = priceFromProviderPlanEpoch({ epoch: epochRow(), fxVersion: fxRow(), asOf });
    assert.equal(derived.payment.paymentAmountMinor, 48_750);
    assert.equal(derived.fx.fxRateVersionId, FX_VERSION_ID);

    // The same aged rate must never price a NEW amount: D-3 still holds for
    // new pricing instants.
    assert.equal(
      pricingReason(
        catchError(() =>
          priceCommercialPlan({
            planId: 'pro',
            interval: 'monthly',
            fx: {
              baseCurrency: 'USD',
              quoteCurrency: 'GHS',
              fxRateScaled: 12_500_000,
              fxRateScale: 6,
              fxRateVersionId: FX_VERSION_ID,
              fxRateEffectiveFrom: '2026-09-22T09:00:00.000Z',
              fxRateCapturedAt: '2026-09-22T09:00:00.000Z',
              fxRateSource: 'ops',
              roundingMode: 'half_up',
            },
            asOf,
          }),
        ),
      ),
      'stale_fx',
    );
  });

  test('a later FX version never reprices the derivation: the epoch amount wins, not the new rate', () => {
    // A newer rate exists (13.0) under which Pro monthly would be 50,700 —
    // but deriving from the first epoch still yields its frozen 48,750.
    const derived = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf: new Date('2026-09-22T12:30:00.000Z'),
    });
    assert.equal(derived.payment.paymentAmountMinor, 48_750);
    assert.equal(derived.fx.fxRateVersionId, FX_VERSION_ID);
    assert.equal(derived.providerPlanId, 'PLN_pro_monthly');
  });

  test('the derived snapshot passes the plan-bound checkout guard against its epoch by construction', () => {
    const epoch = parseProviderPlan(epochRow());
    const snapshot = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf: new Date('2026-09-22T09:05:00.000Z'),
    });
    assert.doesNotThrow(() => verifyPricingSnapshot(snapshot));
    assert.doesNotThrow(() =>
      assertProviderPlanMatches(epoch, providerPlanExpectationFromSnapshot(snapshot, 'PLN_pro_monthly')),
    );
  });

  test('derivation is deterministic: the same epoch collapses onto the same idempotency key (D-7)', () => {
    const first = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf: new Date('2026-09-22T09:05:00.000Z'),
      providerReference: 've-chk-0001',
    });
    const second = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf: new Date('2026-09-22T15:00:00.000Z'),
      providerReference: 've-chk-0002',
    });
    assert.equal(pricingIdempotencyKey(first), pricingIdempotencyKey(second));
    assert.match(pricingIdempotencyKey(first), /^[0-9a-f]{64}$/);

    const otherEpoch = priceFromProviderPlanEpoch({
      epoch: epochRowV2(),
      fxVersion: fxRowV2(),
      asOf: new Date('2026-09-22T12:05:00.000Z'),
    });
    assert.notEqual(pricingIdempotencyKey(first), pricingIdempotencyKey(otherEpoch));
  });
});

describe('Billing PR B — an epoch change never reprices an existing snapshot (D-1, D-8)', () => {
  const key = providerPlanKey('pro', 'monthly');

  test('the old snapshot still verifies after its epoch is retired and a new epoch is registered', () => {
    const before = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf: new Date('2026-09-22T09:05:00.000Z'),
    });

    const retired = epochRow({
      status: 'retired',
      retired_at: new Date('2026-09-22T12:00:00.000Z'),
      retired_reason: 'rate moved to 13.0',
    });

    // The retired epoch authorizes nothing new …
    assert.equal(
      planReason(
        catchError(() =>
          priceFromProviderPlanEpoch({
            epoch: retired,
            fxVersion: fxRow(),
            asOf: new Date('2026-09-22T12:05:00.000Z'),
          }),
        ),
      ),
      'retired',
    );

    // … but the already-derived snapshot is untouched by the retirement (D-1, D-8).
    assert.doesNotThrow(() => verifyPricingSnapshot(before));
    assert.equal(before.payment.paymentAmountMinor, 48_750);
    assert.equal(before.providerPlanId, 'PLN_pro_monthly');
    assert.equal(before.fx.fxRateVersionId, FX_VERSION_ID);
  });

  test('a new derivation resolves to the new epoch, and the old snapshot mismatches it', () => {
    const before = priceFromProviderPlanEpoch({
      epoch: epochRow(),
      fxVersion: fxRow(),
      asOf: new Date('2026-09-22T09:05:00.000Z'),
    });

    const retired = epochRow({
      status: 'retired',
      retired_at: new Date('2026-09-22T12:00:00.000Z'),
      retired_reason: 'rate moved to 13.0',
    });

    const active = selectActiveProviderPlan([retired, epochRowV2()], key);
    assert.equal(active.providerPlanId, 'PLN_pro_monthly_v2');

    const after = priceFromProviderPlanEpoch({
      epoch: epochRowV2(),
      fxVersion: fxRowV2(),
      asOf: new Date('2026-09-22T12:05:00.000Z'),
    });
    assert.equal(after.payment.paymentAmountMinor, 50_700);
    assert.equal(after.providerPlanId, 'PLN_pro_monthly_v2');
    assert.equal(after.fx.fxRateVersionId, FX_VERSION_ID_V2);

    // The old snapshot is never silently re-billed under the new epoch: it
    // mismatches on amount, provider plan id and FX version.
    assert.equal(
      planReason(
        catchError(() =>
          assertProviderPlanMatches(active, providerPlanExpectationFromSnapshot(before, 'PLN_pro_monthly_v2')),
        ),
      ),
      'mismatch',
    );
    // While the new snapshot matches the new epoch exactly.
    assert.doesNotThrow(() =>
      assertProviderPlanMatches(active, providerPlanExpectationFromSnapshot(after, 'PLN_pro_monthly_v2')),
    );
  });
});

describe('Billing PR B — derivation fails closed', () => {
  const asOf = new Date('2026-09-22T09:05:00.000Z');

  test('a retired epoch never authorizes a new snapshot', () => {
    const retired = epochRow({
      status: 'retired',
      retired_at: new Date('2026-09-22T08:00:00.000Z'),
      retired_reason: 'superseded',
    });
    assert.equal(
      planReason(catchError(() => priceFromProviderPlanEpoch({ epoch: retired, fxVersion: fxRow(), asOf }))),
      'retired',
    );
  });

  test('any FX version other than the epoch\u2019s own is a mismatch, never a substitute', () => {
    assert.equal(
      planReason(
        catchError(() => priceFromProviderPlanEpoch({ epoch: epochRow(), fxVersion: fxRowV2(), asOf })),
      ),
      'mismatch',
    );
  });

  test('an epoch or FX row this build does not fully understand is refused', () => {
    assert.ok(
      isBillingProviderPlanError(
        catchError(() => priceFromProviderPlanEpoch({ epoch: epochRow({ mode: 'live' }), fxVersion: fxRow(), asOf })),
      ),
      'a non-sandbox epoch must be refused',
    );
    assert.ok(
      isBillingFxError(
        catchError(() =>
          priceFromProviderPlanEpoch({ epoch: epochRow(), fxVersion: fxRow({ quote_currency: 'NGN' }), asOf }),
        ),
      ),
      'an unreadable FX version must be refused',
    );
  });

  test('an epoch whose frozen amount breaks the derivation identity is refused, never recomputed', () => {
    // 48,751 is one pesewa off the true half_up(3900 × 12.5) = 48,750: the
    // derivation must refuse rather than silently "fix" the epoch amount.
    const tampered = epochRow({ payment_amount_minor: '48751' });
    assert.equal(
      pricingReason(catchError(() => priceFromProviderPlanEpoch({ epoch: tampered, fxVersion: fxRow(), asOf }))),
      'invalid_snapshot',
    );
  });

  test('an epoch amount below the documented minimum is refused', () => {
    // Arithmetically coherent — 3900 cents × 0.001 GHS = 3.9 pesewas, half-up
    // to 4 — but below the documented ₵0.10 = 10 pesewas minimum.
    const tiny = epochRow({ payment_amount_minor: '4' });
    const tinyFx = fxRow({ fx_rate_scaled: '10', fx_rate_scale: 4 });
    assert.equal(
      pricingReason(catchError(() => priceFromProviderPlanEpoch({ epoch: tiny, fxVersion: tinyFx, asOf }))),
      'below_minimum',
    );
  });

  test('a non-finite snapshot instant is refused', () => {
    assert.equal(
      pricingReason(
        catchError(() =>
          priceFromProviderPlanEpoch({ epoch: epochRow(), fxVersion: fxRow(), asOf: new Date(NaN) }),
        ),
      ),
      'invalid_input',
    );
  });

  test('the derivation timestamp is the recording instant, captured but never priced from', () => {
    assert.equal(CAPTURED_AT.toISOString(), '2026-09-22T09:00:00.000Z');
    const snapshot = priceFromProviderPlanEpoch({ epoch: epochRow(), fxVersion: fxRow(), asOf });
    assert.equal(snapshot.computedAt, asOf.toISOString());
  });
});

describe('Billing PR B — the evidence plan stays excluded', () => {
  test('its code appears in the documenting contract and nowhere in code, tests or migrations', () => {
    // The GHS 2.00 evidence plan code (paystack-provider-contract §7.1),
    // assembled from parts so this assertion itself never contains it.
    const needle = ['PLN', 'u0l4961hhipl6ek'].join('_');
    const repoRoot = path.resolve(HERE, '..', '..', '..');
    const hits: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx|sql|mjs|cjs|js)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8');
          if (text.includes(needle)) hits.push(path.relative(repoRoot, full));
        }
      }
    };
    for (const root of ['packages', 'apps', 'scripts']) {
      walk(path.join(repoRoot, root));
    }

    assert.deepEqual(hits, [], 'the evidence plan must never be referenced by code, tests or migrations');

    // Positive control: the needle is the real code — the contract that
    // excludes it still names it.
    const contract = readFileSync(path.join(repoRoot, 'docs', 'paystack-provider-contract.md'), 'utf8');
    assert.ok(contract.includes(needle), 'the exclusion contract still names the evidence plan');
  });
});
