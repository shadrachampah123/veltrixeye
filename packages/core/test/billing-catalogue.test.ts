/**
 * PR1 — server-side billing catalogue authority (core).
 *
 * Pins three things:
 *  1. the server-side catalogue is the validated, frozen commercial catalogue
 *     (Starter / Pro / Elite, USD monthly + annual);
 *  2. the compatibility boundary with the existing internal plan values
 *     (`free` / `pro` / `premium`) — nothing is renamed, no user is migrated;
 *  3. **entitlement enforcement is unchanged by the catalogue**: limits and
 *     `canAccessAutomation` come from `getEntitlements()` exactly as before,
 *     and no catalogue entry grants live/broker/automation execution.
 *
 * No database, provider call, checkout or webhook is involved.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BILLING_CATALOGUE,
  SERVER_BILLING_CATALOGUE,
  catalogueEntryForPlan,
  cataloguePriceMinor,
  unmappedCommercialPlans,
} from '../src/billing/catalogue.js';
import { getEntitlements } from '../src/billing/entitlements.js';
import { COMMERCIAL_PLANS, USER_PLANS, getCommercialPlan, type CommercialPlanId, type UserPlan } from '@veltrixeye/contracts';

describe('server billing catalogue', () => {
  it('exposes the single validated commercial catalogue', () => {
    assert.equal(SERVER_BILLING_CATALOGUE, BILLING_CATALOGUE);
    assert.equal(SERVER_BILLING_CATALOGUE.provider, 'paystack');
    assert.equal(SERVER_BILLING_CATALOGUE.currency, 'USD');
    assert.deepEqual(
      SERVER_BILLING_CATALOGUE.plans.map((plan) => plan.id),
      ['starter', 'pro', 'elite'],
    );
  });

  it('serves the operator-defined USD prices', () => {
    const expected: ReadonlyArray<[CommercialPlanId, number, number]> = [
      ['starter', 1500, 15000],
      ['pro', 3900, 39000],
      ['elite', 9900, 99000],
    ];
    for (const [id, monthly, annual] of expected) {
      assert.equal(cataloguePriceMinor(id, 'monthly'), monthly);
      assert.equal(cataloguePriceMinor(id, 'annual'), annual);
    }
  });

  it('documents which commercial plans cannot be sold yet (no internal value)', () => {
    assert.deepEqual(unmappedCommercialPlans(), ['starter']);
    assert.deepEqual([...COMMERCIAL_PLANS], ['starter', 'pro', 'elite']);
  });
});

describe('compatibility boundary — no rename, no user migration', () => {
  it('keeps the internal plan vocabulary exactly as stored', () => {
    assert.deepEqual([...USER_PLANS], ['free', 'pro', 'premium']);
  });

  it('maps internal plan values onto catalogue entries for display only', () => {
    assert.equal(catalogueEntryForPlan('free'), null);
    assert.equal(catalogueEntryForPlan('pro')?.id, 'pro');
    assert.equal(catalogueEntryForPlan('premium')?.id, 'elite');
  });

  it('does not change the limits any existing user is enforced against', () => {
    const expected: Record<UserPlan, ReturnType<typeof getEntitlements>> = {
      free: {
        maxStrategies: 100,
        maxBacktestsPerMonth: 100,
        maxAlertsPerMonth: 1000,
        maxSavedSetups: 1000,
        canAccessScanner: false,
        canAccessAdvancedStrategies: false,
        canAccessAdvancedAlerts: false,
        canAccessAutomation: false,
      },
      pro: {
        maxStrategies: 500,
        maxBacktestsPerMonth: 1000,
        maxAlertsPerMonth: 5000,
        maxSavedSetups: 5000,
        canAccessScanner: true,
        canAccessAdvancedStrategies: true,
        canAccessAdvancedAlerts: true,
        canAccessAutomation: false,
      },
      premium: {
        maxStrategies: 1000,
        maxBacktestsPerMonth: 5000,
        maxAlertsPerMonth: 10000,
        maxSavedSetups: 10000,
        canAccessScanner: true,
        canAccessAdvancedStrategies: true,
        canAccessAdvancedAlerts: true,
        canAccessAutomation: false,
      },
    };
    for (const plan of USER_PLANS) {
      assert.deepEqual(getEntitlements(plan, 'active'), expected[plan], `entitlements for ${plan} must be unchanged`);
    }
  });

  it('keeps automation OFF for every plan, including the commercial Elite tier', () => {
    for (const plan of USER_PLANS) {
      for (const status of ['active', 'trialing', 'past_due'] as const) {
        assert.equal(getEntitlements(plan, status).canAccessAutomation, false, `${plan}/${status}`);
      }
    }
    assert.equal(catalogueEntryForPlan('premium')?.id, 'elite');
    assert.equal(catalogueEntryForPlan('premium')?.tradeFrequency.tier, 'real-time-priority');
    assert.deepEqual(catalogueEntryForPlan('premium')?.capabilityGrants, {
      liveExecution: false,
      brokerExecution: false,
      automation: false,
    });
  });
});

describe('commercial catalogue grants no execution capability', () => {
  it('every plan reports zero capability grants', () => {
    for (const planId of COMMERCIAL_PLANS) {
      const plan = getCommercialPlan(planId);
      assert.equal(plan.capabilityGrants.liveExecution, false);
      assert.equal(plan.capabilityGrants.brokerExecution, false);
      assert.equal(plan.capabilityGrants.automation, false);
      assert.equal(plan.tradeFrequency.grantsExecution, false);
    }
  });

  it('Elite "priority execution" stays a commercial descriptor', () => {
    const elite = getCommercialPlan('elite');
    assert.equal(elite.tradeFrequency.tier, 'real-time-priority');
    assert.equal(elite.tradeFrequency.grantsExecution, false);
    assert.match(elite.tradeFrequency.note ?? '', /commercial descriptor only/i);
    // The internal value Elite maps onto still has no automation entitlement.
    assert.equal(getEntitlements('premium', 'active').canAccessAutomation, false);
  });
});
