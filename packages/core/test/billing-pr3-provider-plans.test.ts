/**
 * Billing PR3 — provider-plan epochs (immutable GHS mappings).
 *
 * An epoch is the ONLY thing that authorizes a recurring GHS amount. These
 * tests pin the rules that keep it honest:
 *  - exactly one ACTIVE epoch per (provider, mode, plan, interval, currency):
 *    a second one is a conflict, never "the newest row wins";
 *  - a retired epoch is history and is never a fallback for a new charge;
 *  - an epoch that disagrees with the authorized payment in ANY pricing or
 *    provider fact fails closed — no re-rate, no closest match;
 *  - Starter cannot be registered, non-sandbox modes cannot be registered, and
 *    an unknown status/plan/interval/currency is unreadable rather than
 *    permissive;
 *  - the store only ever talks to the database with bound parameters.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { priceCommercialPlan, toBillingFxSnapshot, parseFxRateVersion, isBillingProviderPlanError } from '../src/index.js';
import {
  BILLING_PROVIDER_PLAN_STATUSES,
  BillingProviderPlanStore,
  PROVIDER_PLAN_COMMERCIAL_CURRENCY,
  assertProviderPlanMatches,
  assertProviderPlanRetirable,
  parseProviderPlan,
  providerPlanExpectationFromSnapshot,
  providerPlanKey,
  providerPlanKeyMatches,
  selectActiveProviderPlan,
  type BillingProviderPlan,
} from '../src/billing/provider-plans.js';

const FX_VERSION_ID = '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01';

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

const snapshot = () =>
  priceCommercialPlan({
    planId: 'pro',
    interval: 'monthly',
    fx: toBillingFxSnapshot(
      parseFxRateVersion({
        id: FX_VERSION_ID,
        base_currency: 'USD',
        quote_currency: 'GHS',
        fx_rate_scaled: '12500000',
        fx_rate_scale: 6,
        rounding_mode: 'half_up',
        source: 'ops',
        effective_from: new Date('2026-09-22T09:00:00.000Z'),
        captured_at: new Date('2026-09-22T09:00:00.000Z'),
      }),
    ),
    asOf: new Date('2026-09-22T09:05:00.000Z'),
    providerPlanId: 'PLN_pro_monthly',
    providerReference: 've-chk-0001',
  });

const failureReason = (error: unknown): string => {
  assert.ok(isBillingProviderPlanError(error), `expected a BillingProviderPlanError, got ${String(error)}`);
  return error.reason;
};

describe('Billing PR3 — reading an epoch row', () => {
  test('normalizes a durable row into the canonical epoch', () => {
    const plan = parseProviderPlan(epochRow());
    assert.equal(plan.provider, 'paystack');
    assert.equal(plan.mode, 'test');
    assert.equal(plan.cataloguePlan, 'pro');
    assert.equal(plan.interval, 'monthly');
    assert.equal(plan.paymentCurrency, 'GHS');
    assert.equal(plan.paymentAmountMinor, 48_750n);
    assert.equal(plan.providerPlanId, 'PLN_pro_monthly');
    assert.equal(plan.fxRateVersionId, FX_VERSION_ID);
    assert.equal(plan.status, 'active');
    assert.equal(plan.validFrom.toISOString(), '2026-09-22T09:00:00.000Z');
    assert.equal(PROVIDER_PLAN_COMMERCIAL_CURRENCY, 'USD');
    assert.deepEqual([...BILLING_PROVIDER_PLAN_STATUSES], ['active', 'retired']);
  });

  test('a row this build does not fully understand is refused, never defaulted', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['unknown provider', { provider: 'stripe' }],
      ['live mode', { mode: 'live' }],
      ['unknown plan', { catalogue_plan: 'platinum' }],
      ['starter', { catalogue_plan: 'starter' }],
      ['unknown interval', { billing_interval: 'weekly' }],
      ['unknown currency', { payment_currency: 'NGN' }],
      ['wrong exponent for GHS', { payment_amount_exponent: 3 }],
      ['unknown status', { status: 'pending' }],
      ['non-positive amount', { payment_amount_minor: '0' }],
      ['empty provider plan id', { provider_plan_id: '   ' }],
      ['unknown field', { mystery: 1 }],
    ];
    for (const [label, overrides] of cases) {
      assert.throws(
        () => parseProviderPlan(epochRow(overrides)),
        (error: unknown) => isBillingProviderPlanError(error),
        `${label} must be refused`,
      );
    }
    // Specifically: Starter is rejected as UNSELTABLE, not merely unknown.
    assert.equal(
      failureReason(
        (() => {
          try {
            parseProviderPlan(epochRow({ catalogue_plan: 'starter' }));
          } catch (error) {
            return error;
          }
        })(),
      ),
      'forbidden_plan',
    );
  });
});

describe('Billing PR3 — selecting the one active epoch', () => {
  const key = providerPlanKey('pro', 'monthly');

  test('the key is the sandbox GHS mapping for a plan and interval', () => {
    assert.deepEqual(key, {
      provider: 'paystack',
      mode: 'test',
      cataloguePlan: 'pro',
      interval: 'monthly',
      paymentCurrency: 'GHS',
    });
  });

  test('exactly one active epoch is selected, alongside retired history', () => {
    const retired = epochRow({
      id: '22222222-2222-4222-8222-222222222222',
      provider_plan_id: 'PLN_pro_monthly_v1',
      payment_amount_minor: '45000',
      status: 'retired',
      retired_at: new Date('2026-09-22T08:00:00.000Z'),
      retired_reason: 'price change',
    });
    const selected = selectActiveProviderPlan([retired, epochRow()], key);
    assert.equal(selected.providerPlanId, 'PLN_pro_monthly');
    assert.equal(selected.paymentAmountMinor, 48_750n);
    assert.equal(providerPlanKeyMatches(selected, key), true);

    // An epoch for another interval is not a match for this key.
    assert.notEqual(providerPlanKeyMatches(parseProviderPlan(epochRow({ billing_interval: 'annual' })), key), true);
  });

  test('no mapping, only retired mappings, or two active mappings all fail closed', () => {
    const other = epochRow({ catalogue_plan: 'elite' });
    assert.equal(failureReason(catchError(() => selectActiveProviderPlan([other], key))), 'not_found');

    const retiredOnly = epochRow({
      status: 'retired',
      retired_at: new Date('2026-09-22T08:00:00.000Z'),
      retired_reason: 'retired',
    });
    assert.equal(failureReason(catchError(() => selectActiveProviderPlan([retiredOnly], key))), 'retired');

    const duplicateActive = epochRow({
      id: '33333333-3333-4333-8333-333333333333',
      provider_plan_id: 'PLN_pro_monthly_second',
    });
    assert.equal(
      failureReason(catchError(() => selectActiveProviderPlan([epochRow(), duplicateActive], key))),
      'ambiguous',
    );

    assert.equal(failureReason(catchError(() => selectActiveProviderPlan([], key))), 'not_found');
  });
});

describe('Billing PR3 — an epoch must authorize exactly the payment', () => {
  const plan = (): BillingProviderPlan => parseProviderPlan(epochRow());
  const expectation = () => providerPlanExpectationFromSnapshot(snapshot(), 'PLN_pro_monthly');

  test('a full match passes', () => {
    assert.doesNotThrow(() => assertProviderPlanMatches(plan(), expectation()));
  });

  test('any single mismatch refuses the charge', () => {
    const cases: Array<[string, Partial<ReturnType<typeof expectation>>]> = [
      ['provider', { provider: 'other' }],
      ['mode', { mode: 'live' }],
      ['plan', { cataloguePlan: 'elite' }],
      ['interval', { interval: 'annual' }],
      // A currency this build cannot even express is still guarded by the
      // comparison; the cast isolates the runtime rule from the type system.
      ['currency', { paymentCurrency: 'NGN' as never }],
      ['amount', { paymentAmountMinor: 48_751n }],
      ['provider plan id', { providerPlanId: 'PLN_something_else' }],
      ['fx version', { fxRateVersionId: '99999999-9999-4999-8999-999999999999' }],
      ['pricing policy', { pricingPolicyVersion: 'pr3-usd-ghs-v0' }],
    ];
    for (const [label, overrides] of cases) {
      assert.equal(
        failureReason(catchError(() => assertProviderPlanMatches(plan(), { ...expectation(), ...overrides }))),
        'mismatch',
        `${label} mismatch must refuse`,
      );
    }
  });

  test('a retired epoch can never authorize a charge, even if everything else matches', () => {
    const retired = parseProviderPlan(
      epochRow({ status: 'retired', retired_at: new Date('2026-09-22T08:00:00.000Z'), retired_reason: 'retired' }),
    );
    assert.equal(failureReason(catchError(() => assertProviderPlanMatches(retired, expectation()))), 'mismatch');
    assert.equal(failureReason(catchError(() => assertProviderPlanRetirable(retired))), 'retired');
    assert.doesNotThrow(() => assertProviderPlanRetirable(plan()));
  });

  test('the expectation is derived from the authorized snapshot, not restated', () => {
    const s = snapshot();
    assert.deepEqual(providerPlanExpectationFromSnapshot(s, 'PLN_pro_monthly'), {
      cataloguePlan: 'pro',
      interval: 'monthly',
      paymentAmountMinor: 48_750n,
      paymentCurrency: 'GHS',
      providerPlanId: 'PLN_pro_monthly',
      fxRateVersionId: FX_VERSION_ID,
      pricingPolicyVersion: s.pricingPolicyVersion,
    });
  });
});

describe('Billing PR3 — the epoch store is fail-closed and parameterized', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'billing', 'provider-plans.ts'),
    'utf8',
  );

  test('it never interpolates a value into SQL, and never mutates pricing columns', () => {
    // Every statement uses bound parameters.
    assert.doesNotMatch(source, /db\.query\(\s*`[^`]*\$\{/s, 'no value is interpolated into SQL');
    // The only UPDATE in the store moves the lifecycle.
    const updates = source.match(/UPDATE billing_provider_plans[\s\S]*?RETURNING \*/g) ?? [];
    assert.equal(updates.length, 1, 'exactly one UPDATE statement exists');
    assert.match(updates[0]!, /SET status = 'retired', retired_at = now\(\), retired_reason = \$2/);
    assert.doesNotMatch(updates[0]!, /payment_amount_minor\s*=/);
    assert.doesNotMatch(updates[0]!, /provider_plan_id\s*=/);
  });

  test('registering Starter is refused before any SQL is prepared', async () => {
    const pool = { query: async () => ({ rows: [] }) } as never;
    const store = new BillingProviderPlanStore(pool);
    await assert.rejects(
      () =>
        store.register({
          cataloguePlan: 'starter',
          interval: 'monthly',
          paymentCurrency: 'GHS',
          paymentAmountMinor: 15_000n,
          providerPlanId: 'PLN_starter',
          fxRateVersionId: FX_VERSION_ID,
          catalogueVersion: 'billing-catalogue-1',
        }),
      (error: unknown) => failureReason(error) === 'forbidden_plan',
    );
  });

  test('a missing epoch is reported as not_found, and a database double is enough to see it', async () => {
    const pool = { query: async () => ({ rows: [] }) } as never;
    const store = new BillingProviderPlanStore(pool);
    await assert.rejects(
      () => store.findActive(providerPlanKey('elite', 'annual')),
      (error: unknown) => failureReason(error) === 'not_found',
    );
    assert.equal(await store.isUsable(providerPlanKey('elite', 'annual')), false);
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}
