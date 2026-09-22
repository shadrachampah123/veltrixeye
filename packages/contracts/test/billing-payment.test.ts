/**
 * Billing PR3 — the provider-neutral payment contract (`billing-payment.ts`).
 *
 * Pins:
 *  - amounts are INTEGERS in minor units and every schema refuses a fractional,
 *    zero, negative or non-safe amount — nothing rounds, nothing truncates;
 *  - the payment currency is a pinned literal (`GHS`) and the COMMERCIAL
 *    currency stays pinned to `USD`: no PR2 pin is relaxed and `currency` never
 *    changes meaning;
 *  - the FX authority contract is versioned and records provenance and
 *    rounding, and a rate can never be captured after it became effective;
 *  - the pricing snapshot is strict, self-describing and carries a
 *    required-NULLABLE provider plan/reference pair (NULL is a fact, absence is
 *    an error);
 *  - a credential can never be smuggled in through a plan id, a reference or a
 *    version label;
 *  - provider vocabulary lives in exactly one place — the `provider` identifier
 *    refers to `BILLING_PROVIDER` — and this module knows no provider endpoint,
 *    header, status, event word or payload field;
 *  - PR3's additions to the PR2 provider/subscription/event contracts are
 *    OPTIONAL: the PR2 fixtures still parse unchanged.
 *
 * The conversion arithmetic is deliberately NOT validated here: `pricing.ts`
 * (core) is the single implementation of the one half-up step, and it is tested
 * there. This module owns shape, units and identity.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BILLING_CATALOGUE_VERSION,
  BILLING_CURRENCY,
  BILLING_FX_SOURCES,
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  BILLING_PAYMENT_CURRENCIES,
  BILLING_PROVIDER,
  BILLING_ROUNDING_MODES,
  billingEventDataSchema,
  billingFxSnapshotSchema,
  billingPaymentAmountSchema,
  billingPaymentAuthorizationSchema,
  billingPayableAmountMinor,
  billingPricingSnapshotSchema,
  billingIsCrossCurrency,
  billingSnapshotPlanIdentity,
  billingSubscriptionStateSchema,
  providerEventReferenceSchema,
  providerReferenceSchema,
  providerSubscriptionStateSchema,
} from '../src/index.js';

const FX_VERSION_ID = '7c2f0b6e-3d51-4a2c-9d1f-2b8a5e7c9f03';
const COMPUTED_AT = '2026-09-22T09:05:00.000Z';
const GHS_487_50 = 48_750;

/** A coherent authorized snapshot: $39.00 at 12.5 GHS/USD = GHS 487.50. */
function pricingSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    commercialCurrency: 'USD',
    commercialAmountMinor: 3900,
    catalogueVersion: BILLING_CATALOGUE_VERSION,
    cataloguePlan: 'pro',
    interval: 'monthly',
    payment: { paymentCurrency: 'GHS', paymentAmountMinor: GHS_487_50, paymentAmountExponent: 2 },
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
    providerPlanId: 'PLN_pro_monthly',
    providerReference: 've-chk-0001',
    pricingPolicyVersion: 'pr3-usd-ghs-v1',
    computedAt: COMPUTED_AT,
    ...overrides,
  };
}

describe('Billing PR3 — units and pins', () => {
  test('the payment vocabulary, exponent, rounding mode and FX sources are exact', () => {
    assert.deepEqual([...BILLING_PAYMENT_CURRENCIES], ['GHS']);
    assert.deepEqual({ ...BILLING_PAYMENT_AMOUNT_EXPONENT }, { GHS: 2 }, 'one cedi = 100 pesewas');
    assert.deepEqual([...BILLING_ROUNDING_MODES], ['half_up'], 'exactly one rounding mode exists');
    assert.deepEqual([...BILLING_FX_SOURCES], ['db', 'ops', 'import', 'config']);
    assert.equal(BILLING_CURRENCY, 'USD', 'the commercial currency is unchanged by PR3');
    assert.equal(BILLING_PROVIDER, 'paystack');
  });

  test('an amount is a positive safe integer, and nothing else', () => {
    for (const amount of [
      4875.5,
      0,
      -1,
      -48_750,
      1e21,
      Number.MAX_SAFE_INTEGER + 2,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      '48750',
      null,
      undefined,
      true,
    ]) {
      const parsed = billingPaymentAmountSchema.safeParse({
        paymentCurrency: 'GHS',
        paymentAmountMinor: amount,
        paymentAmountExponent: 2,
      });
      assert.equal(parsed.success, false, `${String(amount)} must be refused, never rounded`);
    }
    assert.equal(
      billingPaymentAmountSchema.safeParse({
        paymentCurrency: 'GHS',
        paymentAmountMinor: GHS_487_50,
        paymentAmountExponent: 2,
      }).success,
      true,
    );
  });

  test('the exponent is part of the amount and must match the currency', () => {
    for (const exponent of [0, 1, 3]) {
      assert.equal(
        billingPaymentAmountSchema.safeParse({
          paymentCurrency: 'GHS',
          paymentAmountMinor: GHS_487_50,
          paymentAmountExponent: exponent,
        }).success,
        false,
        `exponent ${exponent} must be refused for GHS`,
      );
    }
  });

  test('an unknown currency or an extra field is refused, not ignored', () => {
    assert.equal(
      billingPaymentAmountSchema.safeParse({
        paymentCurrency: 'NGN',
        paymentAmountMinor: GHS_487_50,
        paymentAmountExponent: 2,
      }).success,
      false,
    );
    assert.equal(
      billingPaymentAmountSchema.safeParse({
        paymentCurrency: 'GHS',
        paymentAmountMinor: GHS_487_50,
        paymentAmountExponent: 2,
        amountMajor: 487.5,
      }).success,
      false,
      'a major-unit view of the amount is not part of the contract',
    );
  });

  test('the commercial currency stays pinned in the snapshot', () => {
    assert.equal(
      billingPricingSnapshotSchema.safeParse(pricingSnapshot({ commercialCurrency: 'GHS' })).success,
      false,
    );
    assert.equal(
      billingPricingSnapshotSchema.safeParse(pricingSnapshot({ payment: { paymentCurrency: 'USD', paymentAmountMinor: 3900, paymentAmountExponent: 2 } })).success,
      false,
    );
  });
});

describe('Billing PR3 — the FX snapshot contract', () => {
  test('a fractional, negative, zero or unrepresentable rate is refused', () => {
    for (const fxRateScaled of [12.5, -1, 0, 1e21, '12500000', null]) {
      assert.equal(
        billingFxSnapshotSchema.safeParse({ ...pricingSnapshot().fx, fxRateScaled }).success,
        false,
        `fxRateScaled ${String(fxRateScaled)} must be refused`,
      );
    }
  });

  test('the scale is bounded (a rate without a scale is meaningless)', () => {
    for (const fxRateScale of [0, -1, 19, 6.5, '6']) {
      assert.equal(
        billingFxSnapshotSchema.safeParse({ ...pricingSnapshot().fx, fxRateScale }).success,
        false,
        `fxRateScale ${String(fxRateScale)} must be refused`,
      );
    }
    for (const fxRateScale of [1, 6, 18]) {
      assert.equal(
        billingFxSnapshotSchema.safeParse({ ...pricingSnapshot().fx, fxRateScale }).success,
        true,
        `fxRateScale ${fxRateScale} is valid`,
      );
    }
  });

  test('a rate can never be captured after it became effective', () => {
    assert.equal(
      billingFxSnapshotSchema.safeParse({ ...pricingSnapshot().fx, fxRateCapturedAt: '2026-09-22T09:30:00.000Z' })
        .success,
      false,
      'a back-dated rate would let a past payment be repriced',
    );
    assert.equal(
      billingFxSnapshotSchema.safeParse({ ...pricingSnapshot().fx, fxRateCapturedAt: '2026-09-22T08:59:59.999Z' })
        .success,
      true,
    );
  });

  test('an unknown rounding mode, source or version identity is refused', () => {
    for (const override of [
      { roundingMode: 'bankers' },
      { roundingMode: 'half_even' },
      { fxRateSource: 'market' },
      { fxRateSource: 'paystack' },
      { fxRateVersionId: 'not-a-uuid' },
      { quoteCurrency: 'NGN' },
      { baseCurrency: 'EUR' },
      { extra: 'field' },
    ]) {
      assert.equal(
        billingFxSnapshotSchema.safeParse({ ...pricingSnapshot().fx, ...override }).success,
        false,
        `${JSON.stringify(override)} must be refused`,
      );
    }
  });
});

describe('Billing PR3 — the pricing snapshot contract', () => {
  test('a coherent decision parses, and every field is required', () => {
    assert.equal(billingPricingSnapshotSchema.safeParse(pricingSnapshot()).success, true);
    for (const field of [
      'commercialCurrency',
      'commercialAmountMinor',
      'catalogueVersion',
      'cataloguePlan',
      'interval',
      'payment',
      'fx',
      'providerPlanId',
      'providerReference',
      'pricingPolicyVersion',
      'computedAt',
    ]) {
      const without = pricingSnapshot();
      delete (without as Record<string, unknown>)[field];
      assert.equal(
        billingPricingSnapshotSchema.safeParse(without).success,
        false,
        `${field} is required (a snapshot must be self-describing)`,
      );
    }
  });

  test('the provider plan and reference are NULLABLE, never absent', () => {
    assert.equal(
      billingPricingSnapshotSchema.safeParse(pricingSnapshot({ providerPlanId: null, providerReference: null })).success,
      true,
      'an unbound decision states NULL, it does not omit the field',
    );
    const missing = pricingSnapshot();
    delete (missing as Record<string, unknown>).providerPlanId;
    assert.equal(billingPricingSnapshotSchema.safeParse(missing).success, false);
  });

  test('an unknown plan, interval or extra field is refused', () => {
    for (const override of [
      { cataloguePlan: 'platinum' },
      { cataloguePlan: 'PLATINUM' },
      { interval: 'weekly' },
      { computedAt: 'yesterday' },
      { pricingPolicyVersion: '' },
      { mystery: true },
    ]) {
      assert.equal(
        billingPricingSnapshotSchema.safeParse(pricingSnapshot(override)).success,
        false,
        `${JSON.stringify(override)} must be refused`,
      );
    }
  });

  test('starter is representable — sellability belongs to the catalogue and pricing layers', () => {
    // The contract records what was decided; it does not decide what may be
    // sold. `pricing.ts` refuses to price an unsellable plan (tested there).
    assert.equal(billingPricingSnapshotSchema.safeParse(pricingSnapshot({ cataloguePlan: 'starter' })).success, true);
  });

  test('a credential can never be smuggled in through a plan id or a reference', () => {
    for (const value of [
      'Bearer sk_test_0123456789abcdef',
      'api_key=abcdef',
      'secret: hunter2',
      'x'.repeat(129),
      '',
    ]) {
      assert.equal(
        providerReferenceSchema.safeParse(value).success,
        false,
        `plan id ${String(value).slice(0, 14)}… must be refused`,
      );
      assert.equal(
        billingPricingSnapshotSchema.safeParse(pricingSnapshot({ providerPlanId: value })).success,
        false,
      );
    }
    // Our own reference is bounded a little wider (an event reference may be an
    // opaque provider-side string) but is credential-checked the same way.
    for (const value of ['Bearer sk_live_0123456789', 'token: abcdef', 'y'.repeat(191)]) {
      assert.equal(providerEventReferenceSchema.safeParse(value).success, false);
    }
  });

  test('the accessors read the snapshot and never invent a value', () => {
    const snapshot = billingPricingSnapshotSchema.parse(pricingSnapshot());
    assert.equal(billingPayableAmountMinor(snapshot), GHS_487_50);
    assert.equal(billingIsCrossCurrency(snapshot), true);
    assert.deepEqual(billingSnapshotPlanIdentity(snapshot), { cataloguePlan: 'pro', interval: 'monthly' });
  });
});

describe('Billing PR3 — the payment authorization', () => {
  const authorization = () => ({
    provider: BILLING_PROVIDER,
    reference: 've-chk-0001',
    pricing: billingPricingSnapshotSchema.parse(pricingSnapshot()),
    providerPlanId: 'PLN_pro_monthly',
    idempotencyKey: 'a'.repeat(64),
    authorizedAt: COMPUTED_AT,
  });

  test('a complete authorization parses and requires every field', () => {
    assert.equal(billingPaymentAuthorizationSchema.safeParse(authorization()).success, true);
    for (const field of ['provider', 'reference', 'pricing', 'providerPlanId', 'idempotencyKey', 'authorizedAt']) {
      const without = authorization() as Record<string, unknown>;
      delete without[field];
      assert.equal(
        billingPaymentAuthorizationSchema.safeParse(without).success,
        false,
        `${field} is required to charge`,
      );
    }
  });

  test('a malformed idempotency key, an unknown provider or an extra field is refused', () => {
    for (const override of [
      { idempotencyKey: 'not-a-hash' },
      { idempotencyKey: 'A'.repeat(64) },
      { provider: 'stripe' },
      { extra: 1 },
      { providerPlanId: 'Bearer sk_test_x' },
    ]) {
      assert.equal(
        billingPaymentAuthorizationSchema.safeParse({ ...authorization(), ...override }).success,
        false,
        `${JSON.stringify(override)} must be refused`,
      );
    }
  });

  test('the authorization carries the snapshot unchanged: an adapter can trust the amount it reads', () => {
    const parsed = billingPaymentAuthorizationSchema.parse(authorization());
    assert.equal(parsed.pricing.payment.paymentAmountMinor, GHS_487_50);
    assert.equal(parsed.pricing.fx.fxRateVersionId, FX_VERSION_ID);
    assert.equal(parsed.pricing.fx.fxRateScaled, 12_500_000);
    assert.equal(parsed.pricing.fx.roundingMode, 'half_up');
  });
});

describe('Billing PR3 — PR3 additions to the PR2 contracts are additive only', () => {
  /** The exact PR2 fixture shapes, so an additive field cannot break them. */
  const providerState = (overrides: Record<string, unknown> = {}) => ({
    provider: BILLING_PROVIDER,
    state: 'active',
    providerSubscriptionId: 'sub_1a2b3c',
    providerSubscriptionCode: 'code_1a2b3c',
    providerCustomerId: 'cus_1a2b3c',
    providerCustomerCode: 'CUS_1A2B3C',
    providerPlanId: 'PLN_pro_monthly',
    providerReference: 'ref_1a2b3c',
    cataloguePlan: 'pro',
    interval: 'monthly',
    currency: BILLING_CURRENCY,
    currentPeriodStart: COMPUTED_AT,
    currentPeriodEnd: '2026-10-22T09:05:00.000Z',
    cancelAtPeriodEnd: false,
    cancelAt: null,
    cancelledAt: null,
    cancellationReason: null,
    sourceEventIdempotencyKey: 'd'.repeat(64),
    observedAt: COMPUTED_AT,
    ...overrides,
  });

  const subscriptionState = (overrides: Record<string, unknown> = {}) => ({
    id: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    plan: 'pro',
    cataloguePlan: 'pro',
    interval: 'monthly',
    currency: BILLING_CURRENCY,
    status: 'active',
    catalogueVersion: BILLING_CATALOGUE_VERSION,
    provider: BILLING_PROVIDER,
    billingCustomerId: null,
    providerCustomerId: 'cus_1a2b3c',
    providerSubscriptionId: 'sub_1a2b3c',
    providerSubscriptionCode: 'code_1a2b3c',
    providerPlanId: 'PLN_pro_monthly',
    providerReference: 'ref_1a2b3c',
    providerState: 'active',
    currentPeriodStart: COMPUTED_AT,
    currentPeriodEnd: '2026-10-22T09:05:00.000Z',
    cancelAtPeriodEnd: false,
    cancelAt: null,
    cancelledAt: null,
    cancellationReason: null,
    syncState: 'synced',
    lastSyncSource: 'verification',
    lastSyncedAt: COMPUTED_AT,
    syncRequired: false,
    lastEventIdempotencyKey: 'd'.repeat(64),
    stateVersion: 2,
    createdAt: COMPUTED_AT,
    updatedAt: COMPUTED_AT,
    ...overrides,
  });

  const eventData = (overrides: Record<string, unknown> = {}) => ({
    cataloguePlan: 'pro',
    interval: 'monthly',
    state: 'active',
    currentPeriodStart: COMPUTED_AT,
    currentPeriodEnd: '2026-10-22T09:05:00.000Z',
    cancelAtPeriodEnd: false,
    cancellationReason: null,
    amountMinor: 3900,
    currency: BILLING_CURRENCY,
    failureReason: null,
    ...overrides,
  });

  test('the provider subscription state accepts an exact payment, and the PR2 shape still parses', () => {
    assert.equal(providerSubscriptionStateSchema.safeParse(providerState()).success, true, 'PR2 fixture');
    assert.equal(
      providerSubscriptionStateSchema.safeParse({
        ...providerState(),
        payment: { paymentCurrency: 'GHS', paymentAmountMinor: GHS_487_50, paymentAmountExponent: 2 },
      }).success,
      true,
      'the PR3 payment is additive and optional',
    );
    assert.equal(
      providerSubscriptionStateSchema.safeParse({
        ...providerState(),
        payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_750.5, paymentAmountExponent: 2 },
      }).success,
      false,
      'an additive field is validated exactly like every other amount',
    );
  });

  test('the local subscription state accepts the locked snapshot and stays provider-pinned', () => {
    assert.equal(billingSubscriptionStateSchema.safeParse(subscriptionState()).success, true, 'PR2 fixture');
    assert.equal(
      billingSubscriptionStateSchema.safeParse({
        ...subscriptionState(),
        pricing: billingPricingSnapshotSchema.parse(pricingSnapshot()),
      }).success,
      true,
    );
    assert.equal(billingSubscriptionStateSchema.safeParse({ ...subscriptionState(), provider: 'stripe' }).success, false);
    assert.equal(
      billingSubscriptionStateSchema.safeParse({ ...subscriptionState(), currency: 'GHS' }).success,
      false,
      'the commercial currency pin is untouched',
    );
  });

  test('a normalized event may carry the payment it refers to', () => {
    assert.equal(billingEventDataSchema.safeParse(eventData()).success, true, 'PR2 fixture');
    assert.equal(
      billingEventDataSchema.safeParse({
        ...eventData(),
        payment: { paymentCurrency: 'GHS', paymentAmountMinor: GHS_487_50, paymentAmountExponent: 2 },
      }).success,
      true,
    );
    assert.equal(
      billingEventDataSchema.safeParse({
        ...eventData(),
        payment: { paymentCurrency: 'GHS', paymentAmountMinor: -1, paymentAmountExponent: 2 },
      }).success,
      false,
    );
  });

  test('no PR2 literal pin was removed or relaxed by PR3', () => {
    const paymentSource = readFileSync(new URL('../src/billing-payment.ts', import.meta.url), 'utf8');
    assert.match(paymentSource, /commercialCurrency: z\.literal\(BILLING_CURRENCY\)/);
    assert.match(paymentSource, /baseCurrency: z\.literal\(BILLING_CURRENCY\)/);
    const providerSource = readFileSync(new URL('../src/billing-provider.ts', import.meta.url), 'utf8');
    assert.match(providerSource, /currency: z\.literal\(BILLING_CURRENCY\)\.nullable\(\)/);
    assert.doesNotMatch(providerSource, /currency: z\.string\(\)/, 'the currency pin is not relaxed to a string');
  });
});

describe('Billing PR3 — vocabulary isolation', () => {
  test('the payment contract knows no provider endpoint, header, status or payload field', () => {
    const source = readFileSync(new URL('../src/billing-payment.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      /paystack/i,
      /https?:\/\//,
      /\bBearer\b/i,
      /x-paystack-signature/i,
      /\bwebhook\b/i,
      /\bfetch\s*\(/,
      /plan_code/i,
      /customer_code/i,
      /subaccount/i,
      /authorization_url/i,
      /access_code/i,
      /transaction_reference/i,
      /subscription_code/i,
    ]) {
      assert.doesNotMatch(source, forbidden, `the payment contract must stay provider-neutral (${forbidden})`);
    }
    // The one provider reference is the pinned identifier.
    assert.match(source, /BILLING_PROVIDER/);
  });

  test('nothing in the payment contract reaches a network or reads configuration', () => {
    const source = readFileSync(new URL('../src/billing-payment.ts', import.meta.url), 'utf8');
    for (const forbidden of [/\bprocess\.env\b/, /node:http/, /node:https/, /\baxios\b/, /\bundici\b/]) {
      assert.doesNotMatch(source, forbidden, `no transport or configuration in a contract (${forbidden})`);
    }
  });
});
