/**
 * Billing PR2 — provider-seam contracts (canonical, provider-neutral).
 *
 * Pins:
 *  - every billing contract validates its canonical shape and is `.strict()`,
 *    so provider-specific fields cannot leak across the boundary;
 *  - plan identifiers and billing intervals are exactly the catalogue
 *    vocabulary, and prices are read FROM the catalogue (never restated);
 *  - provider identity is `paystack` only, and references are identifiers —
 *    credential-shaped material is rejected;
 *  - provider state normalizes onto the authoritative 0014 status vocabulary
 *    through exactly one mapping, and an unapplicable state maps to `null`
 *    (never a widening);
 *  - provider event identity is deterministic and idempotent;
 *  - synchronization results cannot claim a plan change, an entitlement change
 *    or an execution grant;
 *  - the existing internal plan vocabulary `free | pro | premium` is unchanged
 *    and Starter remains unsellable.
 *
 * Pure contract tests: no database, no HTTP, no provider.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  BILLING_CURRENCY,
  BILLING_EVENT_CATEGORIES,
  BILLING_EVENT_IDEMPOTENCY_FIELDS,
  BILLING_EVENT_TYPES,
  BILLING_LIFECYCLE_STATES,
  BILLING_PROVIDER,
  BILLING_PROVIDER_OPERATIONS,
  BILLING_PROVIDERS,
  BILLING_SYNC_OUTCOMES,
  COMMERCIAL_PLANS,
  SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE,
  USER_PLANS,
  billingCatalogueSchema,
  billingEventCategory,
  billingEventIdempotencyCanonicalString,
  billingCustomerIdentitySchema,
  billingPlanIdentity,
  billingPlanIdentitySchema,
  billingPlanPrice,
  billingProviderIdSchema,
  billingProviderOperationSchema,
  billingSubscriptionStateSchema,
  commercialPlanForInternalPlan,
  commercialPlanPrice,
  internalPlanForCommercialPlan,
  isSellableBillingPlan,
  normalizedBillingEventSchema,
  providerEventIdentitySchema,
  providerReferenceSchema,
  providerEventReferenceSchema,
  providerStateRequiresReview,
  providerSubscriptionStateSchema,
  sha256HexSchema,
  subscriptionStatusForProviderState,
  subscriptionStatusSchema,
  subscriptionSyncResultSchema,
  unappliedSyncResult,
  BILLING_CATALOGUE,
  type BillingEventIdempotencyInput,
  type BillingEventType,
  type BillingLifecycleState,
  type CommercialPlanId,
  type UserPlan,
} from '../src/index.js';

const NOW = '2026-09-21T12:00:00.000Z';
const PERIOD_END = '2026-10-21T12:00:00.000Z';
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const HASH = 'c'.repeat(64);

function subscriptionState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    plan: 'free',
    cataloguePlan: null,
    interval: null,
    currency: BILLING_CURRENCY,
    status: 'active',
    catalogueVersion: null,
    provider: null,
    billingCustomerId: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    providerSubscriptionCode: null,
    providerPlanId: null,
    providerReference: null,
    providerState: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    cancelledAt: null,
    cancellationReason: null,
    syncState: 'never_synced',
    lastSyncSource: 'none',
    lastSyncedAt: null,
    syncRequired: false,
    lastEventIdempotencyKey: null,
    stateVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function providerState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: BILLING_PROVIDER,
    state: 'active',
    providerSubscriptionId: 'sub_1a2b3c',
    providerSubscriptionCode: 'code_1a2b3c',
    providerCustomerId: 'cus_1a2b3c',
    providerCustomerCode: 'CUS_1A2B3C',
    providerPlanId: 'plan_1a2b3c',
    providerReference: 'ref_1a2b3c',
    cataloguePlan: 'pro',
    interval: 'monthly',
    currency: BILLING_CURRENCY,
    currentPeriodStart: NOW,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    cancelledAt: null,
    cancellationReason: null,
    sourceEventIdempotencyKey: KEY,
    observedAt: NOW,
    ...overrides,
  };
}

function eventIdempotencyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: BILLING_PROVIDER,
    providerEventId: 'evt_1',
    eventType: 'payment.succeeded',
    occurredAt: NOW,
    payloadHash: HASH,
    ...overrides,
  };
}

/** The canonicalizer is total over unknown input; tests feed it loose objects. */
const asIdempotencyInput = (value: Record<string, unknown>): BillingEventIdempotencyInput =>
  value as unknown as BillingEventIdempotencyInput;

function eventIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...eventIdempotencyInput(overrides),
    idempotencyKey: KEY,
    receivedAt: PERIOD_END,
  };
}

function eventData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cataloguePlan: null,
    interval: null,
    state: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: null,
    cancellationReason: null,
    amountMinor: 3900,
    currency: BILLING_CURRENCY,
    failureReason: null,
    ...overrides,
  };
}

function normalizedEvent(
  overrides: Record<string, unknown> = {},
  identityOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    identity: eventIdentity(identityOverrides),
    category: 'payment',
    subject: {
      userId: randomUUID(),
      subscriptionId: randomUUID(),
      billingCustomerId: null,
      providerCustomerId: 'cus_1a2b3c',
      providerSubscriptionId: null,
      providerReference: 'ref_1a2b3c',
    },
    data: eventData(),
    grantsExecution: false,
    ...overrides,
  };
}

function syncResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: BILLING_PROVIDER,
    userId: randomUUID(),
    subscriptionId: randomUUID(),
    outcome: 'unchanged',
    fromStatus: 'active',
    toStatus: 'active',
    providerState: 'active',
    appliedEventIdempotencyKeys: [KEY],
    requiresManualReview: false,
    reason: null,
    syncedAt: NOW,
    stateVersion: 2,
    planChanged: false,
    entitlementsChanged: false,
    grantsExecution: false,
    ...overrides,
  };
}

function issues(result: unknown): string {
  const parsed = result as { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } };
  return parsed.success
    ? '<valid>'
    : (parsed.error?.issues ?? []).map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
}

describe('provider identity', () => {
  it('is paystack, and only paystack', () => {
    assert.deepEqual([...BILLING_PROVIDERS], ['paystack']);
    assert.equal(BILLING_PROVIDER, 'paystack');
    assert.equal(billingProviderIdSchema.safeParse('paystack').success, true);
    for (const rejected of ['stripe', 'PAYSTACK', 'Paystack', 'paystack ', '', null, undefined, 1]) {
      assert.equal(billingProviderIdSchema.safeParse(rejected).success, false, `provider "${String(rejected)}" is rejected`);
    }
  });

  it('declares exactly the seam operations a later PR must implement', () => {
    assert.deepEqual(
      [...BILLING_PROVIDER_OPERATIONS],
      [
        'findCustomer',
        'createCustomer',
        'initializeCheckout',
        'findSubscription',
        'verifySubscription',
        'synchronizeSubscription',
        'cancelSubscription',
        'normalizeEvent',
      ],
    );
    for (const operation of BILLING_PROVIDER_OPERATIONS) {
      assert.equal(billingProviderOperationSchema.safeParse(operation).success, true);
    }
    // Webhook signature verification is NOT part of the PR2 seam vocabulary.
    for (const rejected of ['verifyWebhookSignature', 'processWebhook', 'chargeCard', 'sendInvoice', '', 'findcustomer']) {
      assert.equal(billingProviderOperationSchema.safeParse(rejected).success, false, `"${rejected}" is not a seam operation`);
    }
  });

  it('treats provider references as identifiers, never as credential material', () => {
    for (const accepted of ['cus_1a2b3c', 'sub_9x', 'a'.repeat(128), 'ref/2026/09']) {
      assert.equal(providerReferenceSchema.safeParse(accepted).success, true, `"${accepted.slice(0, 20)}" is a valid reference`);
    }
    for (const rejected of ['', '   ', 'a'.repeat(129), null, 42, 'sk_live_secret_value', 'Bearer abc123', 'api_key=xyz', 'token-abc', 'password1']) {
      assert.equal(providerReferenceSchema.safeParse(rejected).success, false, `"${String(rejected).slice(0, 24)}" is not a valid reference`);
    }
    assert.equal(providerEventReferenceSchema.safeParse('e'.repeat(190)).success, true);
    assert.equal(providerEventReferenceSchema.safeParse('e'.repeat(191)).success, false);
    assert.equal(providerEventReferenceSchema.safeParse('authorization-header').success, false);
  });

  it('pins every billing hash to SHA-256 hex', () => {
    assert.equal(sha256HexSchema.safeParse(KEY).success, true);
    for (const rejected of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'not-a-hash', '', null]) {
      assert.equal(sha256HexSchema.safeParse(rejected).success, false);
    }
  });
});

describe('billing plan identity — catalogue integration', () => {
  it('derives plan identity from the authoritative catalogue mapping', () => {
    for (const plan of COMMERCIAL_PLANS) {
      for (const interval of ['monthly', 'annual'] as const) {
        const identity = billingPlanIdentity(plan, interval);
        const parsed = billingPlanIdentitySchema.safeParse(identity);
        assert.equal(parsed.success, true, `${plan}/${interval}: ${issues(parsed)}`);
        assert.equal(identity.internalPlan, internalPlanForCommercialPlan(plan));
        assert.equal(identity.currency, BILLING_CURRENCY);
        assert.equal(identity.interval, interval);
      }
    }
    assert.deepEqual(billingPlanIdentity('pro', 'monthly').internalPlan, 'pro');
    assert.deepEqual(billingPlanIdentity('elite', 'annual').internalPlan, 'premium');
    assert.equal(billingPlanIdentity('starter', 'monthly').internalPlan, null);
  });

  it('accepts valid plan identifiers and rejects invalid ones', () => {
    for (const accepted of ['starter', 'pro', 'elite']) {
      assert.equal(billingPlanIdentitySchema.safeParse(billingPlanIdentity(accepted as CommercialPlanId, 'monthly')).success, true);
    }
    for (const rejected of ['free', 'premium', 'Starter', 'PRO', 'elite ', '', null, 'starter-pro']) {
      const parsed = billingPlanIdentitySchema.safeParse({
        cataloguePlan: rejected,
        internalPlan: null,
        interval: 'monthly',
        currency: BILLING_CURRENCY,
      });
      assert.equal(parsed.success, false, `plan identifier "${String(rejected)}" is rejected`);
    }
  });

  it('accepts valid billing intervals and rejects invalid ones', () => {
    for (const accepted of ['monthly', 'annual']) {
      assert.equal(billingPlanIdentitySchema.safeParse(billingPlanIdentity('pro', accepted as 'monthly' | 'annual')).success, true);
    }
    for (const rejected of ['weekly', 'yearly', 'month', 'MONTHLY', 'annually', '', null, 30]) {
      const parsed = billingPlanIdentitySchema.safeParse({
        cataloguePlan: 'pro',
        internalPlan: 'pro',
        interval: rejected,
        currency: BILLING_CURRENCY,
      });
      assert.equal(parsed.success, false, `interval "${String(rejected)}" is rejected`);
    }
  });

  it('rejects an identity whose internal plan contradicts the canonical mapping', () => {
    const mismatch = billingPlanIdentitySchema.safeParse({
      cataloguePlan: 'pro',
      internalPlan: 'premium',
      interval: 'monthly',
      currency: BILLING_CURRENCY,
    });
    assert.equal(mismatch.success, false);
    const starterWithPlan = billingPlanIdentitySchema.safeParse({
      cataloguePlan: 'starter',
      internalPlan: 'free',
      interval: 'monthly',
      currency: BILLING_CURRENCY,
    });
    assert.equal(starterWithPlan.success, false, 'Starter has no internal plan value');
  });

  it('reads prices from the catalogue and carries no amount of its own', () => {
    for (const plan of COMMERCIAL_PLANS) {
      for (const interval of ['monthly', 'annual'] as const) {
        const identity = billingPlanIdentity(plan, interval);
        assert.deepEqual(billingPlanPrice(identity), commercialPlanPrice(plan, interval));
      }
    }
    assert.equal(billingPlanPrice(billingPlanIdentity('starter', 'monthly')).amountMinor, 1500);
    assert.equal(billingPlanPrice(billingPlanIdentity('elite', 'annual')).amountMinor, 99000);
    // There is nowhere to put a price: an amount on the identity is rejected.
    const withAmount = billingPlanIdentitySchema.safeParse({
      ...billingPlanIdentity('pro', 'monthly'),
      amountMinor: 3900,
    });
    assert.equal(withAmount.success, false, 'a restated amount is rejected (strict)');
  });

  it('marks Starter unsellable until it has an internal plan value', () => {
    assert.equal(isSellableBillingPlan(billingPlanIdentity('starter', 'monthly')), false);
    assert.equal(isSellableBillingPlan(billingPlanIdentity('pro', 'monthly')), true);
    assert.equal(isSellableBillingPlan(billingPlanIdentity('elite', 'annual')), true);
    assert.equal(billingCatalogueSchema.safeParse(BILLING_CATALOGUE).success, true, 'the catalogue itself is unchanged');
  });
});

describe('customer identity', () => {
  it('validates a canonical provider customer', () => {
    const customer = {
      id: randomUUID(),
      userId: randomUUID(),
      provider: BILLING_PROVIDER,
      email: 'trader@example.com',
      providerCustomerId: 'cus_1a2b3c',
      providerCustomerCode: 'CUS_1A2B3C',
      status: 'provisioned',
      lastReference: 'ref_1a2b3c',
      provisionedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const parsed = billingCustomerIdentitySchema.safeParse(customer);
    assert.equal(parsed.success, true, issues(parsed));

    const unprovisioned = billingCustomerIdentitySchema.safeParse({
      ...customer,
      status: 'unprovisioned',
      providerCustomerId: null,
      providerCustomerCode: null,
      provisionedAt: null,
    });
    assert.equal(unprovisioned.success, true, issues(unprovisioned));
  });

  it('rejects incoherent or provider-shaped customer identity', () => {
    const base = {
      id: randomUUID(),
      userId: randomUUID(),
      provider: BILLING_PROVIDER,
      email: 'trader@example.com',
      providerCustomerId: 'cus_1a2b3c',
      providerCustomerCode: null,
      status: 'provisioned',
      lastReference: null,
      provisionedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['uppercase email', { ...base, email: 'Trader@Example.com' }],
      ['not an email', { ...base, email: 'trader' }],
      ['provisioned without identifiers', { ...base, providerCustomerId: null }],
      ['unprovisioned with a timestamp', { ...base, status: 'unprovisioned', providerCustomerId: null }],
      ['unknown status', { ...base, status: 'active' }],
      ['other provider', { ...base, provider: 'stripe' }],
      ['provider-shaped extra field', { ...base, customer_code: 'CUS_1' }],
      ['credential-shaped reference', { ...base, providerCustomerId: 'sk_test_secret' }],
      ['bad id', { ...base, id: 'not-a-uuid' }],
    ];
    for (const [label, candidate] of invalid) {
      const parsed = billingCustomerIdentitySchema.safeParse(candidate);
      assert.equal(parsed.success, false, `${label} must be rejected`);
    }
  });
});

describe('provider subscription state (normalized)', () => {
  it('validates canonical provider state', () => {
    const parsed = providerSubscriptionStateSchema.safeParse(providerState());
    assert.equal(parsed.success, true, issues(parsed));
    for (const state of BILLING_LIFECYCLE_STATES) {
      const candidate = providerSubscriptionStateSchema.safeParse(providerState({ state }));
      assert.equal(candidate.success, true, `${state}: ${issues(candidate)}`);
    }
    const minimal = providerSubscriptionStateSchema.safeParse(
      providerState({
        state: 'unprovisioned',
        providerSubscriptionId: null,
        providerSubscriptionCode: null,
        providerCustomerId: null,
        providerCustomerCode: null,
        providerPlanId: null,
        providerReference: null,
        cataloguePlan: null,
        interval: null,
        currency: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        sourceEventIdempotencyKey: null,
      }),
    );
    assert.equal(minimal.success, true, issues(minimal));
  });

  it('rejects provider-specific vocabulary and incoherent state', () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['provider status word', providerState({ state: 'paused' })],
      ['raw provider event name', providerState({ state: 'charge.success' })],
      ['uppercase state', providerState({ state: 'ACTIVE' })],
      ['interval without a plan', providerState({ cataloguePlan: null })],
      ['inverted period', providerState({ currentPeriodStart: PERIOD_END, currentPeriodEnd: NOW })],
      ['cancelledAt without cancellation', providerState({ state: 'active', cancelledAt: NOW })],
      ['reason without cancellation', providerState({ cancellationReason: 'user' })],
      ['non-hex event key', providerState({ sourceEventIdempotencyKey: 'evt_1' })],
      ['provider-shaped extra field', providerState({ subscription_code: 'x' })],
      ['other currency', providerState({ currency: 'NGN' })],
    ];
    for (const [label, candidate] of invalid) {
      const parsed = providerSubscriptionStateSchema.safeParse(candidate);
      assert.equal(parsed.success, false, `${label} must be rejected`);
    }
  });
});

describe('subscription state normalization', () => {
  it('maps canonical provider state onto the authoritative 0014 status vocabulary', () => {
    assert.deepEqual(
      { ...SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE },
      {
        unprovisioned: null,
        pending: null,
        active: 'active',
        trialing: 'trialing',
        past_due: 'past_due',
        cancelled: 'canceled',
        unsubscribed: 'canceled',
        expired: 'expired',
        unknown: null,
      },
    );
    for (const state of BILLING_LIFECYCLE_STATES) {
      const status = subscriptionStatusForProviderState(state);
      if (status === null) continue;
      assert.equal(subscriptionStatusSchema.safeParse(status).success, true, `${state} → ${status} is an authoritative status`);
    }
  });

  it('never maps a provider state onto a plan value or an entitlement', () => {
    for (const [state, status] of Object.entries(SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE)) {
      if (status === null) continue;
      assert.ok(!(USER_PLANS as readonly string[]).includes(status), `${state} cannot change the plan`);
    }
  });

  it('flags unapplicable provider state for review instead of guessing', () => {
    assert.equal(providerStateRequiresReview('unknown'), true);
    assert.equal(providerStateRequiresReview('pending'), true);
    assert.equal(providerStateRequiresReview('unprovisioned'), false);
    for (const state of ['active', 'trialing', 'past_due', 'cancelled', 'unsubscribed', 'expired'] as BillingLifecycleState[]) {
      assert.equal(providerStateRequiresReview(state), false, `${state} is applicable`);
    }
  });
});

describe('authoritative subscription state (migration 0031 shape)', () => {
  it('validates the existing free/pro/premium rows unchanged', () => {
    for (const plan of USER_PLANS) {
      const parsed = billingSubscriptionStateSchema.safeParse(
        subscriptionState({ plan, cataloguePlan: commercialPlanForInternalPlan(plan as UserPlan) }),
      );
      assert.equal(parsed.success, true, `${plan}: ${issues(parsed)}`);
    }
    // A legacy row with no provider state at all.
    const legacy = billingSubscriptionStateSchema.safeParse(subscriptionState());
    assert.equal(legacy.success, true, issues(legacy));
    // A provider-backed Elite row.
    const sold = billingSubscriptionStateSchema.safeParse(
      subscriptionState({
        plan: 'premium',
        cataloguePlan: 'elite',
        interval: 'annual',
        catalogueVersion: 'billing-catalogue-1',
        provider: BILLING_PROVIDER,
        billingCustomerId: randomUUID(),
        providerCustomerId: 'cus_1a2b3c',
        providerSubscriptionId: 'sub_1a2b3c',
        providerSubscriptionCode: 'code_1a2b3c',
        providerPlanId: 'plan_1a2b3c',
        providerReference: 'ref_1a2b3c',
        providerState: 'active',
        currentPeriodStart: NOW,
        currentPeriodEnd: PERIOD_END,
        syncState: 'synced',
        lastSyncSource: 'webhook',
        lastSyncedAt: NOW,
        lastEventIdempotencyKey: KEY,
        stateVersion: 4,
      }),
    );
    assert.equal(sold.success, true, issues(sold));
  });

  it('rejects incoherent catalogue, provider, period, cancellation and sync state', () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['pro claiming Elite', subscriptionState({ plan: 'pro', cataloguePlan: 'elite' })],
      ['premium claiming Pro', subscriptionState({ plan: 'premium', cataloguePlan: 'pro' })],
      ['free claiming a plan', subscriptionState({ plan: 'free', cataloguePlan: 'pro' })],
      ['Starter persisted', subscriptionState({ plan: 'premium', cataloguePlan: 'starter' })],
      ['internal plan value in the catalogue field', subscriptionState({ cataloguePlan: 'premium' })],
      ['interval without a plan', subscriptionState({ interval: 'monthly' })],
      ['invalid interval', subscriptionState({ cataloguePlan: 'pro', plan: 'pro', interval: 'weekly' })],
      ['provider state without a provider', subscriptionState({ providerState: 'active' })],
      ['provider id without a provider', subscriptionState({ providerSubscriptionId: 'sub_1' })],
      ['customer link without a provider', subscriptionState({ billingCustomerId: randomUUID() })],
      ['other provider', subscriptionState({ provider: 'stripe' })],
      ['provider-specific state word', subscriptionState({ provider: BILLING_PROVIDER, providerState: 'paused' })],
      ['inverted period', subscriptionState({ currentPeriodStart: PERIOD_END, currentPeriodEnd: NOW })],
      ['cancelledAt without cancellation', subscriptionState({ cancelledAt: NOW })],
      ['unknown cancellation reason', subscriptionState({ cancelAtPeriodEnd: true, cancellationReason: 'because' })],
      ['sync timestamp without a sync state', subscriptionState({ lastSyncedAt: NOW })],
      ['sync timestamp without a source', subscriptionState({ syncState: 'synced', lastSyncedAt: NOW })],
      ['zero state version', subscriptionState({ stateVersion: 0 })],
      ['fractional state version', subscriptionState({ stateVersion: 1.5 })],
      ['other currency', subscriptionState({ currency: 'NGN' })],
      ['unknown status', subscriptionState({ status: 'paused' })],
    ];
    for (const [label, candidate] of invalid) {
      const parsed = billingSubscriptionStateSchema.safeParse(candidate);
      assert.equal(parsed.success, false, `${label} must be rejected`);
    }
  });

  it('is not an entitlement system: no limit or capability field is representable', () => {
    for (const forbidden of ['canAccessAutomation', 'maxStrategies', 'maxAlertsPerMonth', 'automationEnabled', 'entitlements']) {
      const parsed = billingSubscriptionStateSchema.safeParse(
        subscriptionState({ [forbidden]: forbidden === 'maxStrategies' ? 10 : true }),
      );
      assert.equal(parsed.success, false, `${forbidden} is rejected by the strict billing-state schema`);
    }
  });
});

describe('provider event identity and idempotency', () => {
  it('derives the idempotency key from a fixed canonical field order', () => {
    assert.deepEqual([...BILLING_EVENT_IDEMPOTENCY_FIELDS], ['provider', 'providerEventId', 'eventType', 'occurredAt', 'payloadHash']);
    const canonical = billingEventIdempotencyCanonicalString(asIdempotencyInput(eventIdempotencyInput()));
    assert.equal(canonical, `paystack|evt_1|payment.succeeded|${NOW}|${HASH}`);
    // Deterministic and independent of object key order.
    const reordered = billingEventIdempotencyCanonicalString(
      asIdempotencyInput({
        payloadHash: HASH,
        occurredAt: NOW,
        eventType: 'payment.succeeded',
        providerEventId: 'evt_1',
        provider: BILLING_PROVIDER,
      }),
    );
    assert.equal(reordered, canonical);
    // Nulls are stable empties, not the string "null".
    assert.equal(
      billingEventIdempotencyCanonicalString(asIdempotencyInput(eventIdempotencyInput({ providerEventId: null, occurredAt: null }))),
      `paystack||payment.succeeded||${HASH}`,
    );
    // Every field is sensitive.
    for (const change of [
      { providerEventId: 'evt_2' },
      { eventType: 'payment.failed' },
      { occurredAt: PERIOD_END },
      { payloadHash: OTHER_KEY },
    ]) {
      assert.notEqual(
        billingEventIdempotencyCanonicalString(asIdempotencyInput(eventIdempotencyInput(change))),
        canonical,
        `${Object.keys(change)[0]} changes the key`,
      );
    }
  });

  it('validates the idempotency input and rejects malformed identity', () => {
    for (const rejected of [
      eventIdempotencyInput({ payloadHash: 'short' }),
      eventIdempotencyInput({ provider: 'stripe' }),
      eventIdempotencyInput({ eventType: 'charge.success' }),
      eventIdempotencyInput({ occurredAt: 'yesterday' }),
      eventIdempotencyInput({ extra: true }),
    ]) {
      const parsed = providerEventIdentitySchema.safeParse({ ...rejected, idempotencyKey: KEY, receivedAt: NOW });
      assert.equal(parsed.success, false, JSON.stringify(rejected).slice(0, 80));
    }
    const valid = providerEventIdentitySchema.safeParse(eventIdentity());
    assert.equal(valid.success, true, issues(valid));
    assert.equal(
      providerEventIdentitySchema.safeParse({ ...eventIdentity(), occurredAt: '2027-01-01T00:00:00.000Z' }).success,
      false,
      'an event cannot occur after it was received',
    );
    assert.equal(
      providerEventIdentitySchema.safeParse({ ...eventIdentity(), idempotencyKey: 'evt_1' }).success,
      false,
      'the idempotency key must be a SHA-256 hex digest',
    );
    assert.equal(
      providerEventIdentitySchema.safeParse({ ...eventIdentity(), receivedAt: 'not-a-timestamp' }).success,
      false,
    );
  });

  it('uses a canonical event vocabulary, never provider event names', () => {
    assert.ok(BILLING_EVENT_TYPES.includes('payment.succeeded'));
    assert.ok(BILLING_EVENT_TYPES.includes('unrecognized'));
    for (const rejected of ['charge.success', 'subscription.disabled', 'invoice.processed.failed', 'PAYMENT.SUCCEEDED', '', 'payment']) {
      assert.equal(
        providerEventIdentitySchema.safeParse(eventIdentity({ eventType: rejected })).success,
        false,
        `provider event name "${rejected}" is not canonical`,
      );
    }
    for (const eventType of BILLING_EVENT_TYPES) {
      assert.ok(BILLING_EVENT_CATEGORIES.includes(billingEventCategory(eventType)), `${eventType} has a category`);
    }
    assert.equal(billingEventCategory('payment.failed'), 'payment');
    assert.equal(billingEventCategory('subscription.cancelled'), 'subscription');
    assert.equal(billingEventCategory('customer.created'), 'customer');
    assert.equal(billingEventCategory('invoice.processed'), 'invoice');
    assert.equal(billingEventCategory('unrecognized'), 'unrecognized');
  });
});

describe('normalized billing events', () => {
  it('validates a canonical event', () => {
    const parsed = normalizedBillingEventSchema.safeParse(normalizedEvent());
    assert.equal(parsed.success, true, issues(parsed));
    const minimal = normalizedBillingEventSchema.safeParse(
      normalizedEvent({ category: 'unrecognized', subject: null, data: null }, { eventType: 'unrecognized' }),
    );
    assert.equal(minimal.success, true, issues(minimal));
  });

  it('cannot grant execution and cannot carry provider payload', () => {
    assert.equal(normalizedBillingEventSchema.safeParse(normalizedEvent({ grantsExecution: true })).success, false);
    assert.equal(
      normalizedBillingEventSchema.safeParse(normalizedEvent({ rawBody: '{"event":"charge.success"}' })).success,
      false,
      'a raw provider payload cannot cross the boundary',
    );
    assert.equal(
      normalizedBillingEventSchema.safeParse(normalizedEvent({ payload: { event: 'charge.success' } })).success,
      false,
    );
    assert.equal(normalizedBillingEventSchema.safeParse(normalizedEvent({ category: 'subscription' })).success, false, 'category must match the event type');
    assert.equal(
      normalizedBillingEventSchema.safeParse(
        normalizedEvent({ data: eventData({ failureReason: 'authorization: Bearer sk_test_1' }) }),
      ).success,
      false,
      'credential-shaped failure text is rejected',
    );
    assert.equal(
      normalizedBillingEventSchema.safeParse(normalizedEvent({ data: eventData({ amountMinor: -1 }) })).success,
      false,
      'amounts are non-negative integers',
    );
    assert.equal(
      normalizedBillingEventSchema.safeParse(normalizedEvent({ data: eventData({ amountMinor: 39.9 }) })).success,
      false,
      'money is never a float',
    );
    // The amount on an event is a receipt fact, not a price definition: an
    // event without one is perfectly valid.
    assert.equal(
      normalizedBillingEventSchema.safeParse(
        normalizedEvent({ data: eventData({ amountMinor: null, currency: null }) }),
      ).success,
      true,
    );
  });

  it('covers every canonical event type', () => {
    for (const eventType of BILLING_EVENT_TYPES as readonly BillingEventType[]) {
      const parsed = normalizedBillingEventSchema.safeParse(
        normalizedEvent({ category: billingEventCategory(eventType) }, { eventType }),
      );
      assert.equal(parsed.success, true, `${eventType}: ${issues(parsed)}`);
    }
  });
});

describe('synchronization results', () => {
  it('validates canonical outcomes', () => {
    assert.deepEqual(
      [...BILLING_SYNC_OUTCOMES],
      ['unchanged', 'created', 'updated', 'ignored', 'conflict', 'requires_manual_review', 'failed'],
    );
    const unchanged = subscriptionSyncResultSchema.safeParse(syncResult());
    assert.equal(unchanged.success, true, issues(unchanged));

    const updated = subscriptionSyncResultSchema.safeParse(
      syncResult({ outcome: 'updated', fromStatus: 'past_due', toStatus: 'active', providerState: 'active' }),
    );
    assert.equal(updated.success, true, issues(updated));

    const created = subscriptionSyncResultSchema.safeParse(
      syncResult({ outcome: 'created', fromStatus: null, toStatus: 'active', providerState: 'active' }),
    );
    assert.equal(created.success, true, issues(created));

    const cancelled = subscriptionSyncResultSchema.safeParse(
      syncResult({ outcome: 'updated', fromStatus: 'active', toStatus: 'canceled', providerState: 'cancelled' }),
    );
    assert.equal(cancelled.success, true, issues(cancelled));
  });

  it('cannot claim a plan change, an entitlement change or an execution grant', () => {
    for (const [field, value] of [
      ['planChanged', true],
      ['entitlementsChanged', true],
      ['grantsExecution', true],
    ] as const) {
      const parsed = subscriptionSyncResultSchema.safeParse(syncResult({ [field]: value }));
      assert.equal(parsed.success, false, `${field} is pinned to false`);
    }
    assert.equal(subscriptionSyncResultSchema.safeParse(syncResult({ plan: 'premium' })).success, false, 'no plan field');
    assert.equal(
      subscriptionSyncResultSchema.safeParse(syncResult({ entitlements: { maxStrategies: 10 } })).success,
      false,
      'no entitlement field',
    );
  });

  it('enforces coherence between provider state, outcome and status', () => {
    const invalid: Array<[string, Record<string, unknown>]> = [
      ['updated without a target status', syncResult({ outcome: 'updated', toStatus: null })],
      ['unchanged moving the status', syncResult({ outcome: 'unchanged', toStatus: 'canceled' })],
      ['created without an id', syncResult({ outcome: 'created', subscriptionId: null, fromStatus: null })],
      ['created with a previous status', syncResult({ outcome: 'created', fromStatus: 'active' })],
      ['conflict without review', syncResult({ outcome: 'conflict' })],
      ['manual review flag missing', syncResult({ outcome: 'requires_manual_review' })],
      ['failed without review', syncResult({ outcome: 'failed', reason: 'provider unavailable' })],
      ['failed without a reason', syncResult({ outcome: 'failed', requiresManualReview: true, reason: null })],
      ['status off the canonical mapping', syncResult({ outcome: 'updated', toStatus: 'expired', providerState: 'active' })],
      ['unapplicable state applied anyway', syncResult({ outcome: 'unchanged', providerState: 'unknown' })],
      ['unknown provider state', syncResult({ providerState: 'paused' })],
      ['too many applied events', syncResult({ appliedEventIdempotencyKeys: new Array(65).fill(KEY) })],
      ['non-hex applied key', syncResult({ appliedEventIdempotencyKeys: ['evt_1'] })],
      ['other provider', syncResult({ provider: 'stripe' })],
    ];
    for (const [label, candidate] of invalid) {
      const parsed = subscriptionSyncResultSchema.safeParse(candidate);
      assert.equal(parsed.success, false, `${label} must be rejected`);
    }
  });

  it('offers a safe default for provider state that cannot be applied', () => {
    const result = unappliedSyncResult({
      provider: BILLING_PROVIDER,
      userId: randomUUID(),
      providerState: 'unknown',
      syncedAt: NOW,
      stateVersion: 1,
      reason: 'provider state is not modelled',
    });
    assert.equal(subscriptionSyncResultSchema.safeParse(result).success, true);
    assert.equal(result.outcome, 'requires_manual_review');
    assert.equal(result.requiresManualReview, true);
    assert.equal(result.toStatus, null);
    assert.equal(result.planChanged, false);
    assert.equal(result.entitlementsChanged, false);
    assert.equal(result.grantsExecution, false);
  });
});

describe('compatibility with the existing plan vocabulary', () => {
  it('changes nothing about free/pro/premium', () => {
    assert.deepEqual([...USER_PLANS], ['free', 'pro', 'premium']);
    assert.deepEqual([...COMMERCIAL_PLANS], ['starter', 'pro', 'elite']);
    assert.deepEqual(
      { ...Object.fromEntries(USER_PLANS.map((plan) => [plan, commercialPlanForInternalPlan(plan)])) },
      { free: null, pro: 'pro', premium: 'elite' },
    );
    assert.deepEqual(
      { ...Object.fromEntries(COMMERCIAL_PLANS.map((plan) => [plan, internalPlanForCommercialPlan(plan)])) },
      { starter: null, pro: 'pro', elite: 'premium' },
    );
    // Every internal plan value is representable in the persisted billing state.
    for (const plan of USER_PLANS) {
      assert.equal(billingSubscriptionStateSchema.safeParse(subscriptionState({ plan })).success, true, `${plan} stays valid`);
    }
  });
});
