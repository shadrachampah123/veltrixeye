/**
 * Billing UI — a provider-backed checkout is never shown as a paid subscription.
 *
 * The panel is display-only: it renders exactly what `GET /api/billing/me`
 * returned. These tests pin that
 *  - a provider-backed row (`provider='paystack'`, `provider_state='pending'`)
 *    is labelled as AWAITING VERIFICATION, shows the FREE limits the server
 *    enforced, and never renders a success badge for its stored
 *    `status: 'active'`;
 *  - a historical (`provider IS NULL`) paid row still renders its paid limits
 *    and no confirmation warning;
 *  - Billing Step 9: the panel shares the checkout surface's five-state
 *    vocabulary (`resolveBillingCheckoutState`), so verified evidence awaiting
 *    an operator activation, a server-confirmed activation and an unreadable
 *    billing state each read differently — and a UI-local evidence flag can
 *    never present itself as an activation;
 *  - the panel still contains NO checkout button, payment link or portal link —
 *    the checkout affordances live in `billing-checkout.tsx`
 *    (test/billing-checkout.test.ts), and this panel stays display-only.
 *  - Billing Step 10a: the catalogue cards (`PlanComparison`) distinguish what
 *    is SOLD from what merely exists in the catalogue — every catalogue entry
 *    renders, sellability is DERIVED from `BILLING_CHECKOUT_SELLABLE_PLANS`
 *    (never restated), Starter is the one non-sellable entry and is marked
 *    "Not available yet" and explained as a catalogue concept with no enforced
 *    entitlement tier, no card offers any action, and the current-plan badge
 *    behaves exactly as before (Starter can never be current).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BILLING_CHECKOUT_SELLABLE_PLANS,
  COMMERCIAL_PLAN_CATALOGUE,
  billingStateDtoSchema,
  type BillingStateDto,
  type UserPlan,
} from '@veltrixeye/contracts';
import { PlanComparison, SubscriptionPanel } from '../components/subscription-panel';

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

const PRO_ENTITLEMENTS = {
  maxStrategies: 500,
  maxBacktestsPerMonth: 1000,
  maxAlertsPerMonth: 5000,
  maxSavedSetups: 5000,
  canAccessScanner: true,
  canAccessAdvancedStrategies: true,
  canAccessAdvancedAlerts: true,
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
  /** Whether the durable activation FACT confirms the payment (Step 8). */
  paymentConfirmed?: boolean;
  /** The server-reported provider domain (default: the sandbox test domain). */
  mode?: 'test' | 'live';
}): BillingStateDto {
  return billingStateDtoSchema.parse({
    // The default provider domain: mode-aware copy renders sandbox text.
    mode: args.mode ?? 'test',
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
      paymentConfirmed: args.paymentConfirmed ?? false,
    },
  });
}

function render(
  billing: BillingStateDto | null,
  props: { evidenceRecorded?: boolean; unavailable?: boolean } = {},
): string {
  return renderToStaticMarkup(React.createElement(SubscriptionPanel, { billing, ...props }));
}

test('a provider-backed pending checkout is labelled awaiting verification and shows the free limits', () => {
  const markup = render(billingState({
    plan: 'pro', status: 'active', entitlements: FREE_ENTITLEMENTS,
    provider: 'paystack', providerState: 'pending',
  }));
  assert.match(markup, /Payment not confirmed/, 'the panel says so explicitly');
  assert.match(markup, /pending/, 'the provider state is shown as display information');
  assert.match(markup, /awaiting verification/i, 'the badge does not read as a live paid subscription');
  assert.match(markup, /awaiting payment verification/, 'the plan line is qualified');
  assert.doesNotMatch(markup, /Payment evidence recorded/, 'no evidence has been recorded yet');
  assert.doesNotMatch(markup, /awaiting operator activation/);
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

test('an activated provider-backed checkout renders its paid limits and no warning', () => {
  // Billing Step 8: `paymentConfirmed` is DERIVED from the immutable
  // activation fact, so a confirmed provider-backed row is a legitimate state
  // and the panel renders it exactly like any other paid row — with the
  // limits the server actually enforced, and still no payment affordance.
  for (const [entitlements, strategyLimit, alertLimit] of [
    [PRO_ENTITLEMENTS, '500', '5000'],
    [PREMIUM_ENTITLEMENTS, '1000', '10000'],
  ] as const) {
    const markup = render(billingState({
      plan: entitlements === PRO_ENTITLEMENTS ? 'pro' : 'premium',
      status: 'active', entitlements,
      provider: 'paystack', providerState: 'active', paymentConfirmed: true,
    }));
    assert.doesNotMatch(markup, /Payment not confirmed/, 'the warning is gone');
    assert.doesNotMatch(markup, /awaiting verification/i, 'the badge does not read as a checkout');
    assert.doesNotMatch(markup, /awaiting payment verification/);
    assert.doesNotMatch(markup, /awaiting operator activation/, 'an activation is not "awaiting" anything');
    assert.match(markup, />active</, 'the authoritative status badge is shown');
    assert.match(markup, new RegExp(`>${strategyLimit}</`), 'the paid strategy limit is displayed');
    assert.match(markup, new RegExp(`>${alertLimit}</`), 'the paid alert limit is displayed');
    // Display only: nothing here can pay, confirm or activate anything.
    assert.doesNotMatch(markup, /<button/i);
    assert.doesNotMatch(markup, /<a\s/i);
    // Automation stays off regardless of plan or confirmation.
    assert.match(markup, /Automation \(M8\)/);
    assert.match(markup, /Automation remains OFF by default/);
    assert.match(markup, /Automation \(M8\)[\s\S]*?Not included/);
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
  const pending = billingState({
    plan: 'pro', status: 'active', entitlements: FREE_ENTITLEMENTS,
    provider: 'paystack', providerState: 'pending',
  });
  // Billing Step 9 added a checkout surface — as a SIBLING component. This panel
  // stays display-only in every state, including the new ones.
  for (const [billing, props] of [
    [null, {}],
    [billingState({ plan: 'free', status: 'active', entitlements: FREE_ENTITLEMENTS }), {}],
    [pending, {}],
    [pending, { evidenceRecorded: true }],
    [billingState({
      plan: 'pro', status: 'active', entitlements: PRO_ENTITLEMENTS,
      provider: 'paystack', providerState: 'active', paymentConfirmed: true,
    }), {}],
    [pending, { unavailable: true }],
    [null, { unavailable: true }],
  ] as const) {
    const markup = render(billing, props);
    assert.doesNotMatch(markup, /<button/i, 'no button of any kind');
    assert.doesNotMatch(markup, /<a\s/i, 'no link, so no portal or hosted checkout');
    assert.doesNotMatch(markup, /authorize|checkout\.|paystack\.co|href=/i, 'no provider URL is rendered');
    assert.doesNotMatch(markup, /Verify payment/i, 'verification is the checkout surface\'s action');
  }
});

/* -------------------------------------------------------------------------- */
/* Billing Step 9 — the shared five-state vocabulary                           */
/* -------------------------------------------------------------------------- */

test('verified evidence awaiting an operator activation is labelled as evidence, not as a payment', () => {
  const markup = render(
    billingState({
      plan: 'pro', status: 'active', entitlements: FREE_ENTITLEMENTS,
      provider: 'paystack', providerState: 'pending',
    }),
    { evidenceRecorded: true },
  );
  assert.match(markup, /evidence · awaiting operator activation/, 'its own badge');
  assert.match(markup, /Payment evidence recorded/, 'and its own explanation');
  assert.match(markup, /Evidence is a receipt, never an activation/);
  assert.match(markup, /paymentConfirmed: false/, 'the server fact is stated, not implied');
  assert.doesNotMatch(markup, /Payment not confirmed/, 'the awaiting-verification warning is replaced');
  assert.doesNotMatch(markup, />activated</, 'evidence is not an activation');
  // Still the FREE limits the server enforces.
  assert.match(markup, />100</);
  assert.doesNotMatch(markup, />500</, 'the pro limit is never displayed');
  assert.match(markup, /Not included/);
});

test('a UI-local evidence flag never rewrites the server fact', () => {
  // The same flag on a row the server still reports as unconfirmed changes the
  // LABEL only: no paid limit, no confirmed badge, no activation.
  const markup = render(
    billingState({
      plan: 'premium', status: 'active', entitlements: FREE_ENTITLEMENTS,
      provider: 'paystack', providerState: 'pending', paymentConfirmed: false,
    }),
    { evidenceRecorded: true },
  );
  assert.match(markup, /paymentConfirmed: false/);
  assert.doesNotMatch(markup, />10000</, 'the premium limit is never displayed');
  assert.doesNotMatch(markup, /canAccessAutomation[^<]*Included/);
  assert.match(markup, /Automation \(M8\)[\s\S]*?Not included/);
});

test('an unreadable billing state is labelled unavailable, never free', () => {
  // A FAILED read is its own card: not "loading", not the free state, not a
  // payment state, and with no limit presented as authoritative.
  const failed = render(null, { unavailable: true });
  assert.match(failed, /billing unavailable/);
  assert.match(failed, /Billing unavailable:/);
  assert.doesNotMatch(failed, /Loading billing state/, 'a failure is not an in-flight read');
  assert.doesNotMatch(failed, />active</);
  assert.doesNotMatch(failed, />100</, 'no limit is displayed as the enforced one');
  assert.doesNotMatch(failed, /<button/i);
  assert.doesNotMatch(failed, /<a\s/i);

  // A read that answered, while the checkout surface is refusing, is unavailable
  // too — as long as the server reports no provider-backed row.
  const refusing = render(
    billingState({ plan: 'free', status: 'active', entitlements: FREE_ENTITLEMENTS }),
    { unavailable: true },
  );
  assert.match(refusing, /billing unavailable/);
  assert.match(refusing, /Billing unavailable:/);
  assert.doesNotMatch(refusing, />active</, 'the stored status is not presented as authoritative');
  assert.doesNotMatch(refusing, /awaiting verification/i);
  assert.doesNotMatch(refusing, /Payment evidence recorded/);

  // A KNOWN server fact outranks the refusal flag: the flag describes a read
  // that failed, and this read did not.
  const known = render(
    billingState({
      plan: 'pro', status: 'active', entitlements: FREE_ENTITLEMENTS,
      provider: 'paystack', providerState: 'pending',
    }),
    { unavailable: true },
  );
  assert.match(known, /awaiting verification/i);
  assert.match(known, /Payment not confirmed/);
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

test('the loading state is unchanged, and is not the unavailable state', () => {
  const markup = render(null);
  assert.match(markup, /Loading billing state/);
  assert.doesNotMatch(markup, /Payment not confirmed/);
  assert.doesNotMatch(markup, /billing unavailable/, 'in flight is not a failure');
  assert.doesNotMatch(markup, /evidence/i);
});

/* -------------------------------------------------------------------------- */
/* Billing Step 10a — the catalogue cards: sold vs catalogue concept only      */
/* -------------------------------------------------------------------------- */

const CARD_OPEN = '<div class="rounded-lg border p-4 ';
const GRID_OPEN = '<div class="grid gap-4 p-5 sm:grid-cols-3">';
const FOOTER_OPEN = '<div class="border-t border-ink-700 px-5 py-3';

function renderComparison(currentPlan: UserPlan): string {
  return renderToStaticMarkup(React.createElement(PlanComparison, { currentPlan }));
}

/** The catalogue grid only — the cards, without the explanatory footer copy. */
function catalogueGrid(markup: string): string {
  const start = markup.indexOf(GRID_OPEN);
  assert.ok(start >= 0, 'the catalogue grid renders');
  const end = markup.indexOf(FOOTER_OPEN);
  assert.ok(end > start, 'the grid closes before the footer');
  return markup.slice(start, end);
}

/** One catalogue card's own markup, located by the plan name it renders. */
function cardFor(grid: string, planName: string): string {
  const card = grid
    .split(CARD_OPEN)
    .slice(1)
    .find((segment) => segment.includes(`>${planName}</span>`));
  assert.ok(card !== undefined, `the ${planName} catalogue card renders`);
  return `${CARD_OPEN}${card}`;
}

test('every catalogue entry renders, and exactly the non-sellable entry is marked unavailable', () => {
  const grid = catalogueGrid(renderComparison('free'));
  const sellable: readonly string[] = BILLING_CHECKOUT_SELLABLE_PLANS;
  const nonSellable = COMMERCIAL_PLAN_CATALOGUE.filter((plan) => !sellable.includes(plan.id));

  // Every catalogue entry renders, with its own catalogue name and prices.
  assert.equal(
    grid.split(CARD_OPEN).length - 1,
    COMMERCIAL_PLAN_CATALOGUE.length,
    'one card per catalogue entry',
  );
  for (const plan of COMMERCIAL_PLAN_CATALOGUE) {
    assert.match(grid, new RegExp(`>${plan.name}</span>`), `${plan.name} renders`);
    for (const price of [plan.pricing.monthly.display, plan.pricing.annual.display]) {
      assert.ok(grid.includes(price), `${plan.name} renders the catalogue price ${price}`);
    }
  }

  // Starter is the ONLY non-sellable catalogue entry, and the only card marked.
  assert.deepEqual(nonSellable.map((plan) => plan.id), ['starter']);
  assert.equal(
    (grid.match(/Not available yet/g) ?? []).length,
    1,
    'exactly one catalogue card is marked unavailable',
  );
  assert.match(cardFor(grid, 'Starter'), /Not available yet/, 'Starter is the marked card');
  for (const plan of COMMERCIAL_PLAN_CATALOGUE.filter((entry) => sellable.includes(entry.id))) {
    assert.doesNotMatch(
      cardFor(grid, plan.name),
      /Not available yet|not purchasable/,
      `${plan.name} is sellable and is not marked otherwise`,
    );
  }
  // No "Available"-style badge is introduced for the sellable plans.
  assert.doesNotMatch(grid, />\s*Available\s*</i, 'no Available badge exists');
});

test('Starter is described as a catalogue concept only, with no enforced entitlement tier', () => {
  const markup = renderComparison('pro');
  assert.match(markup, /Starter is a catalogue concept only\./);
  assert.match(markup, /Not offered and not purchasable in this build/);
  assert.match(markup, /no enforced entitlement tier/);
  assert.match(markup, /not a plan the server sells, prices, provisions or activates/);
  // The catalogue price is still shown — as catalogue information, not as an offer.
  assert.ok(cardFor(catalogueGrid(markup), 'Starter').includes('$15'));
  // And nothing claims Starter is purchasable or included.
  assert.doesNotMatch(markup, /Starter[^<]{0,40}(Buy|Subscribe|Upgrade)/i);
  assert.doesNotMatch(markup, /\b(Get started|Start now|Choose plan|Upgrade now)\b/i);
});

test('no catalogue card — Starter included — offers any action or checkout affordance', () => {
  for (const currentPlan of ['free', 'pro', 'premium'] as const) {
    const markup = renderComparison(currentPlan);
    const starterCard = cardFor(catalogueGrid(markup), 'Starter');
    assert.doesNotMatch(starterCard, /<button/i, 'no button on the Starter card');
    assert.doesNotMatch(starterCard, /<a\s/i, 'no link on the Starter card');
    assert.doesNotMatch(starterCard, /href=|onclick=|<form|<input|<label/i, 'no control on the Starter card');
    assert.doesNotMatch(starterCard, /\b(Buy|Subscribe|Upgrade|Checkout|Verify payment)\b/i);
    // The whole card is display-only, exactly as it was before Step 10a.
    assert.doesNotMatch(markup, /<button/i);
    assert.doesNotMatch(markup, /<a\s/i);
    assert.doesNotMatch(markup, /href=|onclick=|<form|<input/i);
  }
});

test('the current-plan badge behaves exactly as before, and Starter is never current', () => {
  const expectations: readonly (readonly [UserPlan, string | null])[] = [
    ['free', null],
    ['pro', 'Pro'],
    ['premium', 'Elite'],
  ];
  for (const [internalPlan, expectedCommercialName] of expectations) {
    const grid = catalogueGrid(renderComparison(internalPlan));
    const currentCount = (grid.match(/>Current</g) ?? []).length;
    assert.equal(
      currentCount,
      expectedCommercialName === null ? 0 : 1,
      `exactly ${expectedCommercialName === null ? 0 : 1} Current badge for the internal "${internalPlan}" plan`,
    );
    for (const plan of COMMERCIAL_PLAN_CATALOGUE) {
      const card = cardFor(grid, plan.name);
      const isMarked = />Current</.test(card);
      assert.equal(
        isMarked,
        plan.name === expectedCommercialName,
        `${plan.name} current=${isMarked} for internal "${internalPlan}"`,
      );
    }
    // A non-sellable entry can never be the account's current plan.
    assert.doesNotMatch(cardFor(grid, 'Starter'), />Current</);
  }
});

test('sellability is pinned to BILLING_CHECKOUT_SELLABLE_PLANS and never restated', () => {
  // The contract is the authority: the sellable set is exactly Pro + Elite.
  assert.deepEqual([...BILLING_CHECKOUT_SELLABLE_PLANS], ['pro', 'elite']);

  // Behavioural pin: the cards WITHOUT the unavailable marker are exactly the
  // entries the shared constant sells.
  const grid = catalogueGrid(renderComparison('free'));
  const markedUnavailable = COMMERCIAL_PLAN_CATALOGUE.filter((plan) =>
    /Not available yet/.test(cardFor(grid, plan.name)),
  ).map((plan) => plan.id);
  assert.deepEqual(
    markedUnavailable,
    COMMERCIAL_PLAN_CATALOGUE.filter(
      (plan) => !(BILLING_CHECKOUT_SELLABLE_PLANS as readonly string[]).includes(plan.id),
    ).map((plan) => plan.id),
    'the marked set and the non-sellable set are the same set',
  );

  // Source pin: the component derives sellability from the shared constant and
  // restates no sellable-plan list of its own (a second source of truth would
  // let the UI drift from what the server actually sells).
  const source = readFileSync(new URL('../components/subscription-panel.tsx', import.meta.url), 'utf8');
  assert.match(source, /BILLING_CHECKOUT_SELLABLE_PLANS/, 'the component uses the shared constant');
  assert.doesNotMatch(source, /\[\s*'pro'\s*,\s*'elite'\s*\]/, 'no restated sellable-plan literal');
});

/* -------------------------------------------------------------------------- */
/* Mode-aware copy: a live billing state is never called a sandbox            */
/* -------------------------------------------------------------------------- */

test('mode-aware copy: live never says sandbox, test keeps the sandbox note, unknown claims neither', () => {
  // The domain note lives on the catalogue card (PlanComparison).
  const live = renderComparison('pro');
  const liveMode = renderToStaticMarkup(
    React.createElement(PlanComparison, { currentPlan: 'pro', mode: 'live' }),
  );
  assert.match(liveMode, /Live billing:/);
  assert.match(liveMode, /<em>live-mode<\/em>/);
  assert.doesNotMatch(liveMode, /Sandbox billing only:/);
  assert.doesNotMatch(liveMode, /<em>sandbox<\/em>/);

  // The default render (direct, no mode) keeps every sandbox assertion.
  assert.match(live, /Sandbox billing only:/);
  assert.match(live, /<em>sandbox<\/em> \(test-mode\)/);
  assert.doesNotMatch(live, /Live billing:/);

  // An unknown mode claims neither domain.
  const unknown = renderToStaticMarkup(
    React.createElement(PlanComparison, { currentPlan: 'pro', mode: null }),
  );
  assert.doesNotMatch(unknown, /Sandbox billing only:/);
  assert.doesNotMatch(unknown, /Live billing:/);
  assert.match(unknown, /<strong class="text-amber-450">Billing:<\/strong>/);

  // The unreadable-state card names the configured checkout domain.
  const sandboxRefusal = render(
    billingState({ plan: 'free', status: 'active', entitlements: FREE_ENTITLEMENTS, mode: 'test' }),
    { unavailable: true },
  );
  assert.match(sandboxRefusal, /the sandbox checkout is refusing/);

  const liveRefusal = render(
    billingState({ plan: 'free', status: 'active', entitlements: FREE_ENTITLEMENTS, mode: 'live' }),
    { unavailable: true },
  );
  assert.match(liveRefusal, /the checkout is refusing/);
  assert.doesNotMatch(liveRefusal, /the sandbox checkout is refusing/);
});
