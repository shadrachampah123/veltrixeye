/**
 * PR1 — authoritative commercial catalogue (contracts).
 *
 * Pins the operator-defined catalogue (Starter / Pro / Elite, USD monthly +
 * annual), the separation between commercial values and enforcement, and the
 * compatibility mapping to the existing internal plan values.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BILLING_CATALOGUE,
  BILLING_CATALOGUE_VERSION,
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  COMMERCIAL_PLANS,
  COMMERCIAL_PLAN_CATALOGUE,
  COMMERCIAL_PLAN_FOR_INTERNAL_PLAN,
  INTERNAL_PLAN_FOR_COMMERCIAL_PLAN,
  USER_PLANS,
  billingCatalogueSchema,
  commercialPlanForInternalPlan,
  commercialPlanPrice,
  getCommercialPlan,
  internalPlanForCommercialPlan,
  type CommercialPlanId,
} from '../src/index.js';

describe('commercial catalogue — shape', () => {
  it('validates against the catalogue schema', () => {
    const parsed = billingCatalogueSchema.safeParse(BILLING_CATALOGUE);
    assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues));
  });

  it('is a single, complete, ordered source of truth', () => {
    assert.deepEqual(BILLING_CATALOGUE.version, BILLING_CATALOGUE_VERSION);
    assert.equal(BILLING_CATALOGUE.provider, 'paystack');
    assert.equal(BILLING_PROVIDER, 'paystack');
    assert.equal(BILLING_CATALOGUE.currency, 'USD');
    assert.equal(BILLING_CURRENCY, 'USD');
    assert.deepEqual([...COMMERCIAL_PLANS], ['starter', 'pro', 'elite']);
    assert.deepEqual(
      COMMERCIAL_PLAN_CATALOGUE.map((plan) => plan.id),
      ['starter', 'pro', 'elite'],
    );
    assert.deepEqual(
      BILLING_CATALOGUE.plans.map((plan) => plan.id),
      ['starter', 'pro', 'elite'],
    );
  });

  it('deeply freezes every plan entry (prices, limits, grants)', () => {
    for (const plan of COMMERCIAL_PLAN_CATALOGUE) {
      for (const frozen of [
        plan,
        plan.pricing,
        plan.pricing.monthly,
        plan.pricing.annual,
        plan.activeStrategies,
        plan.markets,
        plan.tradeFrequency,
        plan.capabilityGrants,
      ]) {
        assert.equal(Object.isFrozen(frozen), true, `${plan.id}: nested value must be frozen`);
      }
    }
  });

  it('rejects a catalogue that is missing a plan, duplicates an id or drifts currency', () => {
    const incomplete = billingCatalogueSchema.safeParse({
      ...BILLING_CATALOGUE,
      plans: [getCommercialPlan('starter'), getCommercialPlan('pro')],
    });
    assert.equal(incomplete.success, false);

    const duplicate = billingCatalogueSchema.safeParse({
      ...BILLING_CATALOGUE,
      plans: [getCommercialPlan('starter'), getCommercialPlan('starter'), getCommercialPlan('elite')],
    });
    assert.equal(duplicate.success, false);

    const wrongCurrency = billingCatalogueSchema.safeParse({
      ...BILLING_CATALOGUE,
      plans: [
        { ...getCommercialPlan('starter'), pricing: { monthly: { interval: 'monthly', currency: 'EUR', amountMinor: 1500, display: '€15' }, annual: getCommercialPlan('starter').pricing.annual } },
        getCommercialPlan('pro'),
        getCommercialPlan('elite'),
      ],
    });
    assert.equal(wrongCurrency.success, false);
  });
});

describe('commercial catalogue — prices (USD, operator-defined)', () => {
  const expected: ReadonlyArray<[CommercialPlanId, number, string, number, string]> = [
    ['starter', 1500, '$15', 15000, '$150'],
    ['pro', 3900, '$39', 39000, '$390'],
    ['elite', 9900, '$99', 99000, '$990'],
  ];

  for (const [id, monthlyMinor, monthlyDisplay, annualMinor, annualDisplay] of expected) {
    it(`${id}: USD ${monthlyDisplay}/mo and ${annualDisplay}/yr`, () => {
      const plan = getCommercialPlan(id);
      assert.equal(plan.currency, 'USD');
      assert.equal(plan.pricing.monthly.interval, 'monthly');
      assert.equal(plan.pricing.monthly.currency, 'USD');
      assert.equal(plan.pricing.monthly.amountMinor, monthlyMinor);
      assert.equal(plan.pricing.monthly.display, monthlyDisplay);
      assert.equal(plan.pricing.annual.interval, 'annual');
      assert.equal(plan.pricing.annual.currency, 'USD');
      assert.equal(plan.pricing.annual.amountMinor, annualMinor);
      assert.equal(plan.pricing.annual.display, annualDisplay);
      assert.equal(commercialPlanPrice(id, 'monthly').amountMinor, monthlyMinor);
      assert.equal(commercialPlanPrice(id, 'annual').amountMinor, annualMinor);
    });
  }

  it('keeps money in integer minor units', () => {
    for (const plan of COMMERCIAL_PLAN_CATALOGUE) {
      for (const interval of ['monthly', 'annual'] as const) {
        assert.ok(Number.isInteger(plan.pricing[interval].amountMinor), `${plan.id}/${interval} must be integer cents`);
      }
    }
  });
});

describe('commercial catalogue — entitlements advertised (not enforced)', () => {
  it('publishes active-strategy limits', () => {
    assert.deepEqual(getCommercialPlan('starter').activeStrategies, { limit: 1, unlimited: false, display: '1' });
    assert.deepEqual(getCommercialPlan('pro').activeStrategies, { limit: 5, unlimited: false, display: '5' });
    assert.deepEqual(getCommercialPlan('elite').activeStrategies, { limit: null, unlimited: true, display: 'Unlimited' });
  });

  it('publishes market coverage', () => {
    assert.equal(getCommercialPlan('starter').markets.scope, 'single-category');
    assert.equal(getCommercialPlan('starter').markets.display, '1 market category');
    for (const id of ['pro', 'elite'] as const) {
      assert.equal(getCommercialPlan(id).markets.scope, 'forex-crypto-stocks');
      assert.equal(getCommercialPlan(id).markets.display, 'Forex + crypto + stocks');
    }
  });

  it('publishes trade-frequency tiers', () => {
    assert.equal(getCommercialPlan('starter').tradeFrequency.tier, 'delayed');
    assert.equal(getCommercialPlan('starter').tradeFrequency.display, 'Delayed / limited');
    assert.equal(getCommercialPlan('pro').tradeFrequency.tier, 'real-time');
    assert.equal(getCommercialPlan('pro').tradeFrequency.display, 'Real-time');
    assert.equal(getCommercialPlan('elite').tradeFrequency.tier, 'real-time-priority');
    assert.equal(getCommercialPlan('elite').tradeFrequency.display, 'Real-time + priority execution');
  });

  it('grants no execution capability on any plan', () => {
    for (const plan of COMMERCIAL_PLAN_CATALOGUE) {
      assert.deepEqual(plan.capabilityGrants, { liveExecution: false, brokerExecution: false, automation: false });
      assert.equal(plan.tradeFrequency.grantsExecution, false, `${plan.id} frequency must not grant execution`);
    }
    // "Priority execution" is a commercial descriptor, and the catalogue says so.
    const elite = getCommercialPlan('elite').tradeFrequency;
    assert.match(elite.note ?? '', /no execution capability/i);
  });
});

describe('compatibility boundary — commercial catalogue ⇄ internal plan values', () => {
  it('leaves the internal plan vocabulary untouched', () => {
    assert.deepEqual([...USER_PLANS], ['free', 'pro', 'premium']);
  });

  it('maps internal → commercial without renaming anything', () => {
    assert.deepEqual({ ...COMMERCIAL_PLAN_FOR_INTERNAL_PLAN }, { free: null, pro: 'pro', premium: 'elite' });
    assert.equal(commercialPlanForInternalPlan('free'), null);
    assert.equal(commercialPlanForInternalPlan('pro'), 'pro');
    assert.equal(commercialPlanForInternalPlan('premium'), 'elite');
  });

  it('records that Starter has no internal plan value yet (needs migration 0031)', () => {
    assert.deepEqual({ ...INTERNAL_PLAN_FOR_COMMERCIAL_PLAN }, { starter: null, pro: 'pro', elite: 'premium' });
    assert.equal(internalPlanForCommercialPlan('starter'), null);
    assert.equal(internalPlanForCommercialPlan('pro'), 'pro');
    assert.equal(internalPlanForCommercialPlan('elite'), 'premium');
  });

  it('is a two-way mapping wherever both sides exist', () => {
    for (const internal of USER_PLANS) {
      const commercial = commercialPlanForInternalPlan(internal);
      if (commercial === null) continue;
      assert.equal(internalPlanForCommercialPlan(commercial), internal);
    }
  });
});
