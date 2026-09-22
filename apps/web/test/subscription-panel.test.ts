/**
 * Billing UI — a provider-backed checkout is never shown as a paid subscription.
 *
 * The panel is display-only: it renders exactly what `GET /api/billing/me`
 * returned. These tests pin that
 *  - a provider-backed row (`provider='paystack'`, `provider_state='pending'`)
 *    is labelled unconfirmed, shows the FREE limits the server enforced, and
 *    never renders a success badge for its stored `status: 'active'`;
 *  - a historical (`provider IS NULL`) paid row still renders its paid limits
 *    and no confirmation warning;
 *  - the panel still contains NO checkout button, payment link or portal link —
 *    this change adds state display, not a payment flow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { billingStateDtoSchema, type BillingStateDto } from '@veltrixeye/contracts';
import { SubscriptionPanel } from '../components/subscription-panel';

const SUBSCRIPTION_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

const FREE_ENTITLEMENTS = {
  maxStrategies: 100,
  maxBacktestsPerMonth: 100,
  maxAlertsPerMonth: 1000,
  maxSavedSetups: 1000,
  canAccessScanner: false,
  canAccessAdvancedStrategies: false,
  canAccessAdvancedAlerts: false,
  canAccessAutomation: false,
};

const PREMIUM_ENTITLEMENTS = {
  maxStrategies: 1000,
  maxBacktestsPerMonth: 5000,
  maxAlertsPerMonth: 10000,
  maxSavedSetups: 10000,
  canAccessScanner: true,
  canAccessAdvancedStrategies: true,
  canAccessAdvancedAlerts: true,
  canAccessAutomation: false,
};

function billingState(args: {
  plan: 'free' | 'pro' | 'premium';
  status: BillingStateDto['subscription']['status'];
  entitlements: typeof FREE_ENTITLEMENTS;
  provider?: string | null;
  providerState?: string | null;
}): BillingStateDto {
  return billingStateDtoSchema.parse({
    subscription: {
      id: SUBSCRIPTION_ID,
      plan: args.plan,
      status: args.status,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    },
    entitlements: args.entitlements,
    providerStatus: {
      provider: args.provider ?? null,
      providerState: args.providerState ?? null,
      paymentConfirmed: false,
    },
  });
}

function render(billing: BillingStateDto | null): string {
  return renderToStaticMarkup(React.createElement(SubscriptionPanel, { billing }));
}

test('a provider-backed pending checkout is labelled unconfirmed and shows the free limits', () => {
  const markup = render(billingState({
    plan: 'pro', status: 'active', entitlements: FREE_ENTITLEMENTS,
    provider: 'paystack', providerState: 'pending',
  }));
  assert.match(markup, /Payment not confirmed/, 'the panel says so explicitly');
  assert.match(markup, /pending/, 'the provider state is shown as display information');
  assert.match(markup, /unconfirmed/i, 'the badge does not read as a live paid subscription');
  assert.match(markup, /awaiting payment confirmation/, 'the plan line is qualified');
  // The FREE limits the server actually enforced, not the pro ones.
  assert.match(markup, />100</, 'strategies limit is the free limit');
  assert.match(markup, />1000</, 'alerts limit is the free limit');
  assert.doesNotMatch(markup, />500</, 'the pro limit is never displayed');
  assert.match(markup, /Not included/, 'the scanner is shown as unavailable');
});

test('no provider state is rendered as a confirmed payment', () => {
  for (const providerState of ['active', 'trialing', 'past_due', 'unprovisioned', 'unknown', null]) {
    const markup = render(billingState({
      plan: 'premium', status: 'active', entitlements: FREE_ENTITLEMENTS,
      provider: 'paystack', providerState,
    }));
    assert.match(markup, /Payment not confirmed/, `provider_state=${providerState ?? 'NULL'}`);
    assert.doesNotMatch(markup, /confirmed payment|payment confirmed/i);
    assert.doesNotMatch(markup, />10000</, 'the premium limit is never displayed');
  }
});

test('a historical paid subscription still renders its paid limits with no warning', () => {
  const markup = render(billingState({
    plan: 'premium', status: 'active', entitlements: PREMIUM_ENTITLEMENTS,
  }));
  assert.doesNotMatch(markup, /Payment not confirmed/);
  assert.doesNotMatch(markup, /unconfirmed/i);
  assert.match(markup, />1000</, 'premium strategy limit');
  assert.match(markup, />10000</, 'premium alert limit');
  assert.match(markup, />active</, 'the authoritative status badge is unchanged');
});

test('a historical free subscription renders free limits and no warning', () => {
  const markup = render(billingState({ plan: 'free', status: 'active', entitlements: FREE_ENTITLEMENTS }));
  assert.doesNotMatch(markup, /Payment not confirmed/);
  assert.match(markup, />100</);
});

test('the panel still renders no checkout, payment or portal affordance', () => {
  for (const billing of [
    null,
    billingState({ plan: 'free', status: 'active', entitlements: FREE_ENTITLEMENTS }),
    billingState({
      plan: 'pro', status: 'active', entitlements: FREE_ENTITLEMENTS,
      provider: 'paystack', providerState: 'pending',
    }),
  ]) {
    const markup = render(billing);
    assert.doesNotMatch(markup, /<button/i, 'no button of any kind');
    assert.doesNotMatch(markup, /<a\s/i, 'no link, so no portal or hosted checkout');
    assert.doesNotMatch(markup, /authorize|checkout\.|paystack\.co/i, 'no provider URL is rendered');
  }
});

test('automation is still displayed as unavailable on every row', () => {
  for (const billing of [
    billingState({ plan: 'premium', status: 'active', entitlements: PREMIUM_ENTITLEMENTS }),
    billingState({
      plan: 'premium', status: 'active', entitlements: FREE_ENTITLEMENTS,
      provider: 'paystack', providerState: 'active',
    }),
  ]) {
    const markup = render(billing);
    assert.match(markup, /Automation \(M8\)/);
    assert.match(markup, /Automation remains OFF by default/);
  }
});

test('the loading state is unchanged', () => {
  const markup = render(null);
  assert.match(markup, /Loading billing state/);
  assert.doesNotMatch(markup, /Payment not confirmed/);
});
