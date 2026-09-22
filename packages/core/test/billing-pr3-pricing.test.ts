/**
 * Billing PR3 — the pure pricing boundary and the FX resolution rules.
 *
 * Pins the decisions that decide what a customer is charged:
 *  - exactly ONE half-up rounding step, integer arithmetic only, no floats;
 *  - the commercial amount comes from the authoritative catalogue and nowhere
 *    else (no literal price is restated in the pricing module);
 *  - a rate must be effective (`effective_from <= asOf`), the newest such
 *    version, unambiguous, and at most 15 minutes old (measured from the moment
 *    it was captured);
 *  - a LOCKED snapshot is verified WITHOUT re-rating: ageing never reprices an
 *    authorized subscription, and refunds use the charged amount;
 *  - a pending checkout keeps the amount the customer was quoted;
 *  - below the documented minimum, nothing is charged.
 *
 * No database and no network are involved in this suite.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_FX_POLICY,
  BILLING_PAYMENT_MINIMUM_MINOR,
  BILLING_PRICING_POLICY_VERSION,
  assertPaymentAmountMatches,
  computePaymentAmountMinor,
  isBillingFxError,
  isBillingPricingError,
  isPricingSnapshotQuotable,
  parseFxRateVersion,
  priceCommercialPlan,
  pricingIdempotencyCanonicalString,
  pricingIdempotencyKey,
  resolveFxRateVersion,
  toBillingFxSnapshot,
  verifyPricingSnapshot,
  type BillingFxRateVersion,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX_VERSION_ID = '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01';

/** A raw authority row, exactly as the durable table stores one. */
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

const snapshotFor = (planId: 'pro' | 'elite' | 'starter' = 'pro', interval: 'monthly' | 'annual' = 'monthly', asOf = new Date('2026-09-22T09:05:00.000Z')) =>
  priceCommercialPlan({
    planId,
    interval,
    fx: toBillingFxSnapshot(parseFxRateVersion(fxRow())),
    asOf,
    providerPlanId: null,
    providerReference: 've-chk-0001',
  });

describe('Billing PR3 — exact integer conversion', () => {
  test('$39.00 at 12.5 GHS/USD is GHS 487.50 (48,750 pesewas)', () => {
    const payable = computePaymentAmountMinor({ usdMinor: 3900n, rateScaled: 12_500_000n, rateScale: 6 });
    assert.equal(payable, 48_750n);
  });

  test('a cent-scale rate converts exactly', () => {
    // $99.00 at 12.345678 GHS/USD = GHS 1222.222222 ⇒ 122,222 pesewas.
    const payable = computePaymentAmountMinor({ usdMinor: 9900n, rateScaled: 12_345_678n, rateScale: 6 });
    assert.equal(payable, 122_222n);
  });

  test('rounding is half-up, in exactly one step', () => {
    // The exact ratio is usdMinor·rateScaled / 10^rateScale. With scale 1 the
    // denominator is 10, so the boundary is directly observable:
    // 0.5 ⇒ 1 (half UP, not banker's rounding), 1.5 ⇒ 2, 2.5 ⇒ 3.
    assert.equal(computePaymentAmountMinor({ usdMinor: 5n, rateScaled: 1n, rateScale: 1 }), 1n);
    assert.equal(computePaymentAmountMinor({ usdMinor: 15n, rateScaled: 1n, rateScale: 1 }), 2n);
    assert.equal(computePaymentAmountMinor({ usdMinor: 25n, rateScaled: 1n, rateScale: 1 }), 3n);
    // Just below/above the boundary: 0.4999 ⇒ 0, 0.5001 ⇒ 1
    assert.equal(computePaymentAmountMinor({ usdMinor: 4999n, rateScaled: 1n, rateScale: 4 }), 0n);
    assert.equal(computePaymentAmountMinor({ usdMinor: 5001n, rateScaled: 1n, rateScale: 4 }), 1n);
    // A rate smaller than one minor unit still rounds up at the boundary.
    assert.equal(computePaymentAmountMinor({ usdMinor: 1n, rateScaled: 5n, rateScale: 1 }), 1n);
  });

  test('no intermediate value is rounded: the exact ratio decides', () => {
    // 3900 × 12345678 / 10^6 = 48148.1442 ⇒ 48148 (not 48148.14 → 48148 twice).
    assert.equal(computePaymentAmountMinor({ usdMinor: 3900n, rateScaled: 12_345_678n, rateScale: 6 }), 48_148n);
    // The same value expressed with a coarser scale (1235 @ 2 = 12.35):
    assert.equal(computePaymentAmountMinor({ usdMinor: 3900n, rateScaled: 1235n, rateScale: 2 }), 48_165n);
  });

  test('rejects a zero/negative amount or rate, and an out-of-range scale', () => {
    for (const params of [
      { usdMinor: 0n, rateScaled: 1n, rateScale: 1 },
      { usdMinor: -1n, rateScaled: 1n, rateScale: 1 },
      { usdMinor: 1n, rateScaled: 0n, rateScale: 1 },
      { usdMinor: 1n, rateScaled: 1n, rateScale: 0 },
      { usdMinor: 1n, rateScaled: 1n, rateScale: 19 },
      { usdMinor: 1n, rateScaled: 1n, rateScale: 1.5 },
    ]) {
      assert.throws(
        () => computePaymentAmountMinor(params),
        (error: unknown) => isBillingPricingError(error),
        `an unusable conversion input must be refused (${String(params.usdMinor)}/${String(params.rateScaled)}@${params.rateScale})`,
      );
    }
  });
});

describe('Billing PR3 — pricing a catalogue plan', () => {
  test('produces the auditable snapshot with both currencies and the FX facts', () => {
    const snapshot = snapshotFor('pro', 'monthly');
    assert.equal(snapshot.commercialCurrency, 'USD');
    assert.equal(snapshot.commercialAmountMinor, 3900);
    assert.equal(snapshot.payment.paymentCurrency, 'GHS');
    assert.equal(snapshot.payment.paymentAmountMinor, 48_750);
    assert.equal(snapshot.payment.paymentAmountExponent, 2);
    assert.equal(snapshot.fx.fxRateVersionId, FX_VERSION_ID);
    assert.equal(snapshot.fx.fxRateScaled, 12_500_000);
    assert.equal(snapshot.fx.fxRateScale, 6);
    assert.equal(snapshot.fx.roundingMode, 'half_up');
    assert.equal(snapshot.pricingPolicyVersion, BILLING_PRICING_POLICY_VERSION);
    assert.equal(snapshot.computedAt, '2026-09-22T09:05:00.000Z');
  });

  test('every sellable plan/interval prices from the catalogue, at every rate', () => {
    const expectations: Array<['pro' | 'elite', 'monthly' | 'annual', number, number]> = [
      // plan, interval, USD minor (catalogue), GHS minor at 12.5 GHS/USD
      ['pro', 'monthly', 3900, 48_750],
      ['pro', 'annual', 39_000, 487_500],
      ['elite', 'monthly', 9900, 123_750],
      ['elite', 'annual', 99_000, 1_237_500],
    ];
    for (const [plan, interval, usdMinor, ghsMinor] of expectations) {
      const snapshot = snapshotFor(plan, interval);
      assert.equal(snapshot.commercialAmountMinor, usdMinor, `${plan}/${interval} USD amount`);
      assert.equal(snapshot.payment.paymentAmountMinor, ghsMinor, `${plan}/${interval} GHS amount`);
    }
  });

  test('the commercial amount is the catalogue amount — never restated in code', () => {
    // Changing the rate changes ONLY the payment side.
    const cheap = priceCommercialPlan({
      planId: 'pro',
      interval: 'monthly',
      fx: toBillingFxSnapshot(parseFxRateVersion(fxRow({ fx_rate_scaled: '6000000' }))),
      asOf: new Date('2026-09-22T09:05:00.000Z'),
      providerPlanId: null,
      providerReference: null,
    });
    assert.equal(cheap.commercialAmountMinor, 3900, 'the USD price is untouched by the rate');
    assert.equal(cheap.payment.paymentAmountMinor, 23_400);
  });

  test('an unsellable plan cannot be priced', () => {
    assert.throws(
      () =>
        priceCommercialPlan({
          planId: 'starter',
          interval: 'monthly',
          fx: toBillingFxSnapshot(parseFxRateVersion(fxRow())),
          asOf: new Date('2026-09-22T09:05:00.000Z'),
        }),
      (error: unknown) => isBillingPricingError(error),
    );
  });

  test('an amount below the documented minimum is refused, not rounded up', () => {
    assert.equal(BILLING_PAYMENT_MINIMUM_MINOR.GHS, 10n, 'documented GHS minimum: ₵0.10 = 10 pesewas');
    // $15.00 (Starter price, used only as an amount) at 0.0005 GHS/USD = 0.75
    // pesewas ⇒ would round to 1, below the minimum.
    assert.throws(
      () =>
        priceCommercialPlan({
          planId: 'pro',
          interval: 'monthly',
          fx: toBillingFxSnapshot(parseFxRateVersion(fxRow({ fx_rate_scaled: '5', fx_rate_scale: 4 }))),
          asOf: new Date('2026-09-22T09:05:00.000Z'),
        }),
      (error: unknown) => isBillingPricingError(error) && error.reason === 'below_minimum',
    );
  });

  test('a stale, future-dated or mismatched FX snapshot cannot price', () => {
    const fresh = toBillingFxSnapshot(parseFxRateVersion(fxRow()));

    // 15 minutes exactly: allowed. One millisecond later: refused.
    const boundary = new Date(Date.parse('2026-09-22T09:00:00.000Z') + BILLING_FX_POLICY.maxAgeSeconds * 1000);
    assert.equal(
      priceCommercialPlan({ planId: 'pro', interval: 'monthly', fx: fresh, asOf: boundary }).payment.paymentAmountMinor,
      48_750,
    );
    assert.throws(
      () =>
        priceCommercialPlan({
          planId: 'pro',
          interval: 'monthly',
          fx: fresh,
          asOf: new Date(boundary.getTime() + 1),
        }),
      (error: unknown) => isBillingPricingError(error) && error.reason === 'stale_fx',
      'a rate older than the approved window must never price a new payment',
    );
    assert.throws(
      () =>
        priceCommercialPlan({
          planId: 'pro',
          interval: 'monthly',
          fx: fresh,
          asOf: new Date('2026-09-22T08:59:59.000Z'),
        }),
      (error: unknown) => isBillingPricingError(error) && error.reason === 'invalid_fx',
      'a rate captured after the pricing instant is refused',
    );
    assert.throws(
      () =>
        priceCommercialPlan({
          planId: 'pro',
          interval: 'monthly',
          fx: { ...fresh, roundingMode: 'bankers' } as never,
          asOf: new Date('2026-09-22T09:05:00.000Z'),
        }),
      (error: unknown) => isBillingPricingError(error),
    );
  });

  test('the policy is 15 minutes, versioned, and half-up', () => {
    assert.equal(BILLING_FX_POLICY.maxAgeSeconds, 15 * 60);
    assert.equal(BILLING_FX_POLICY.roundingMode, 'half_up');
    assert.equal(BILLING_FX_POLICY.version, BILLING_PRICING_POLICY_VERSION);
  });
});

describe('Billing PR3 — a locked snapshot is verified without re-rating', () => {
  test('an ageing rate never invalidates an authorized amount (D-1, D-8)', () => {
    const snapshot = snapshotFor('pro', 'monthly');
    const muchLater = new Date('2026-10-22T09:05:00.000Z'); // a month later

    // Pricing a NEW payment at that rate is refused…
    assert.throws(
      () =>
        priceCommercialPlan({
          planId: 'pro',
          interval: 'monthly',
          fx: snapshot.fx,
          asOf: muchLater,
        }),
      (error: unknown) => isBillingPricingError(error) && error.reason === 'stale_fx',
    );

    // …while the LOCKED snapshot still verifies, unchanged.
    const verified = verifyPricingSnapshot(snapshot);
    assert.equal(verified.payment.paymentAmountMinor, 48_750);
    assert.equal(verified.commercialAmountMinor, 3900);
  });

  test('verification is structural: a tampered amount or a malformed snapshot cannot pass', () => {
    const snapshot = snapshotFor('pro', 'monthly');
    for (const tampered of [
      { ...snapshot, payment: { ...snapshot.payment, paymentAmountMinor: 1 } },
      { ...snapshot, commercialAmountMinor: 1 },
      { ...snapshot, payment: { ...snapshot.payment, paymentAmountExponent: 3 } },
      { ...snapshot, fx: { ...snapshot.fx, fxRateScale: 0 } },
      { ...snapshot, fx: { ...snapshot.fx, fxRateVersionId: 'not-a-uuid' } },
      { ...snapshot, extra: true },
      null,
      'nope',
    ]) {
      assert.throws(
        () => verifyPricingSnapshot(tampered),
        (error: unknown) => isBillingPricingError(error) && error.reason === 'invalid_snapshot',
        `${JSON.stringify(tampered)?.slice(0, 60)} must not verify`,
      );
    }
    assert.equal(isPricingSnapshotQuotable(snapshot), true);
    assert.equal(isPricingSnapshotQuotable({ ...snapshot, commercialAmountMinor: 2 }), false);
  });

  test('the amount a provider reports must equal the authorized amount exactly', () => {
    const snapshot = snapshotFor('pro', 'monthly');
    assert.doesNotThrow(() =>
      assertPaymentAmountMatches(
        snapshot,
        { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
        'verify',
      ),
    );
    for (const observed of [
      { paymentCurrency: 'GHS', paymentAmountMinor: 48_751, paymentAmountExponent: 2 },
      { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 3 },
      { paymentCurrency: 'NGN', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
    ]) {
      assert.throws(
        () => assertPaymentAmountMatches(snapshot, observed, 'verify'),
        (error: unknown) => isBillingPricingError(error) && error.reason === 'amount_mismatch',
        'an under-charge and an over-charge are both incidents',
      );
    }
  });
});

describe('Billing PR3 — deterministic local idempotency', () => {
  test('the same decision always produces the same key', () => {
    const a = snapshotFor('pro', 'monthly');
    const b = snapshotFor('pro', 'monthly');
    assert.equal(pricingIdempotencyKey(a), pricingIdempotencyKey(b));
    assert.match(pricingIdempotencyKey(a), /^[0-9a-f]{64}$/);
    assert.equal(pricingIdempotencyCanonicalString(a).includes('billing-catalogue-1'), true);
  });

  test('a different amount, plan, interval, rate or policy is a different decision', () => {
    const base = snapshotFor('pro', 'monthly');
    const variants = [
      snapshotFor('pro', 'annual'),
      snapshotFor('elite', 'monthly'),
      priceCommercialPlan({
        planId: 'pro',
        interval: 'monthly',
        fx: toBillingFxSnapshot(parseFxRateVersion(fxRow({ fx_rate_scaled: '6000000' }))),
        asOf: new Date('2026-09-22T09:05:00.000Z'),
      }),
      { ...base, pricingPolicyVersion: 'pr3-usd-ghs-v0' },
    ];
    for (const variant of variants) {
      assert.notEqual(pricingIdempotencyKey(base), pricingIdempotencyKey(variant));
    }
  });

  test('our own reference and the computed timestamp are traceability, not identity', () => {
    const a = priceCommercialPlan({
      planId: 'pro',
      interval: 'monthly',
      fx: toBillingFxSnapshot(parseFxRateVersion(fxRow())),
      asOf: new Date('2026-09-22T09:05:00.000Z'),
      providerReference: 've-chk-0001',
    });
    const b = priceCommercialPlan({
      planId: 'pro',
      interval: 'monthly',
      fx: toBillingFxSnapshot(parseFxRateVersion(fxRow())),
      asOf: new Date('2026-09-22T09:05:30.000Z'),
      providerReference: 've-chk-9999',
    });
    assert.equal(pricingIdempotencyKey(a), pricingIdempotencyKey(b));
  });
});

describe('Billing PR3 — FX version resolution', () => {
  const rows = [
    fxRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', effective_from: new Date('2026-09-22T08:00:00.000Z'), captured_at: new Date('2026-09-22T08:00:00.000Z'), fx_rate_scaled: '11000000' }),
    fxRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', effective_from: new Date('2026-09-22T09:00:00.000Z'), captured_at: new Date('2026-09-22T09:00:00.000Z') }),
  ];

  test('the newest version effective at or before the instant is used', () => {
    const at = new Date('2026-09-22T09:05:00.000Z');
    const version = resolveFxRateVersion({ versions: rows, asOf: at });
    assert.equal(version.id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.equal(version.fxRateScaled, 12_500_000n);

    // Just before the second version becomes effective, the first is in force —
    // but it is already 59 minutes old, so it cannot price.
    assert.throws(
      () => resolveFxRateVersion({ versions: rows, asOf: new Date('2026-09-22T08:59:00.000Z') }),
      (error: unknown) => isBillingFxError(error) && error.reason === 'stale',
    );
  });

  test('no effective version is a hard failure', () => {
    assert.throws(
      () => resolveFxRateVersion({ versions: rows, asOf: new Date('2026-09-22T07:00:00.000Z') }),
      (error: unknown) => isBillingFxError(error) && error.reason === 'missing',
    );
    assert.throws(
      () => resolveFxRateVersion({ versions: [], asOf: new Date('2026-09-22T09:05:00.000Z') }),
      (error: unknown) => isBillingFxError(error) && error.reason === 'missing',
    );
  });

  test('two versions effective at the same instant are ambiguous, never picked', () => {
    const ambiguous = [
      ...rows,
      fxRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', effective_from: new Date('2026-09-22T09:00:00.000Z'), captured_at: new Date('2026-09-22T09:00:00.000Z') }),
    ];
    assert.throws(
      () => resolveFxRateVersion({ versions: ambiguous, asOf: new Date('2026-09-22T09:05:00.000Z') }),
      (error: unknown) => isBillingFxError(error) && error.reason === 'ambiguous',
    );
  });

  test('an invalid or unreadable authority row never becomes a price', () => {
    const at = new Date('2026-09-22T09:05:00.000Z');
    const cases: Array<[string, Record<string, unknown>]> = [
      ['zero rate', { fx_rate_scaled: '0' }],
      ['negative-looking rate', { fx_rate_scaled: 'abc' }],
      ['scale out of range', { fx_rate_scale: 0 }],
      ['unknown base currency', { base_currency: 'EUR' }],
      ['unknown quote currency', { quote_currency: 'NGN' }],
      ['unknown source', { source: 'market' }],
      ['unknown rounding mode', { rounding_mode: 'bankers' }],
      ['captured after it became effective', { captured_at: new Date('2026-09-22T10:00:00.000Z') }],
      ['missing id', { id: undefined }],
    ];
    for (const [label, overrides] of cases) {
      assert.throws(
        () => resolveFxRateVersion({ versions: [fxRow(overrides)], asOf: at }),
        (error: unknown) => isBillingFxError(error),
        `${label} must be refused`,
      );
    }
  });

  test('the snapshot carries the rate, its scale, its version and both timestamps', () => {
    const version: BillingFxRateVersion = parseFxRateVersion(fxRow());
    const snapshot = toBillingFxSnapshot(version);
    assert.deepEqual(snapshot, {
      baseCurrency: 'USD',
      quoteCurrency: 'GHS',
      fxRateScaled: 12_500_000,
      fxRateScale: 6,
      fxRateVersionId: FX_VERSION_ID,
      fxRateEffectiveFrom: '2026-09-22T09:00:00.000Z',
      fxRateCapturedAt: '2026-09-22T09:00:00.000Z',
      fxRateSource: 'ops',
      roundingMode: 'half_up',
    });
  });
});

describe('Billing PR3 — boundary isolation (source assertions)', () => {
  const sourceOf = (relative: string) =>
    readFileSync(path.join(HERE, '..', 'src', 'billing', relative), 'utf8');

  test('the pricing boundary neither fetches a rate nor calls a provider', () => {
    for (const file of ['pricing.ts', 'fx-rate-versions.ts']) {
      const source = sourceOf(file);
      for (const forbidden of [
        /\bfetch\s*\(/,
        /node:https?/,
        /axios/,
        /\bwebhook\b/i,
        /x-paystack-signature/i,
        /paystack\.co/i,
        /apilayer|openexchange|forex|exchangerate/i,
      ]) {
        assert.doesNotMatch(source, forbidden, `${file} must stay provider- and network-free (${forbidden})`);
      }
    }
  });

  test('money is never computed with floating-point arithmetic', () => {
    const pricing = sourceOf('pricing.ts');
    for (const forbidden of [
      /parseFloat/,
      /toFixed/,
      /Math\.round/,
      /Math\.ceil/,
      /Number\.EPSILON/,
      /\.toPrecision/,
    ]) {
      assert.doesNotMatch(pricing, forbidden, `no float money math (${forbidden})`);
    }
    assert.match(pricing, /10n \*\* BigInt\(rateScale\)/, 'the scale denominator is an exact power of ten');
    assert.match(pricing, /2n \* usdMinor \* rateScaled \+ denominator/, 'the half-up step is integer-only');
  });

  test('no price is restated outside the catalogue', () => {
    const pricing = sourceOf('pricing.ts');
    for (const price of ['1500', '15000', '3900', '39000', '9900', '99000']) {
      assert.doesNotMatch(
        pricing,
        new RegExp(`\\b${price}\\b`),
        `the catalogue amount ${price} must not be restated in the pricing boundary`,
      );
    }
    assert.match(pricing, /cataloguePriceMinor\(/, 'the amount comes from the catalogue authority');
  });

  test('the FX boundary never reads a market feed or a browser-supplied rate', () => {
    const fx = sourceOf('fx-rate-versions.ts');
    assert.match(fx, /resolveFxRateVersion/, 'rates are resolved, not fetched');
    // No request/transport surface exists in this module at all.
    for (const forbidden of [/\breq\b/, /\bres\b/, /Authorization/, /process\.env/]) {
      assert.doesNotMatch(fx, forbidden, `the FX authority is server-side only (${forbidden})`);
    }
  });
});
