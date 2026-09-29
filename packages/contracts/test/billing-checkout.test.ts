/**
 * Billing Step 9 — the sandbox checkout surface contracts
 * (`packages/contracts/src/billing-checkout.ts`).
 *
 * Pins:
 *  - the request DTO is exactly `{ cataloguePlan, interval }`, `.strict()`, and
 *    refuses Starter plus every server-derived field a client might try to add
 *    (a price, an amount, a currency, a provider plan, a callback URL, a
 *    reference, an idempotency key, a user id);
 *  - the offered choices are EXACTLY four (Pro monthly, Pro annual, Elite
 *    monthly, Elite annual), derived from the frozen catalogue — the price
 *    objects are the catalogue's own, never restated;
 *  - the checkout-session DTO is strict and discloses the commercial price, the
 *    exact payment amount and the FX rate/version/time;
 *  - `projectBillingCheckoutSession` is a PROJECTION: the internal seam
 *    session's checkout reference, provider reference, provider id,
 *    idempotency key and pricing snapshot never survive it, and a session that
 *    cannot be disclosed safely is refused rather than forwarded;
 *  - the authorization URL is carried verbatim (never rewritten), and only an
 *    `initialized` session carries one;
 *  - every capability pin is `z.literal(false)` — a checkout session confirms
 *    no payment, changes no plan or entitlement and grants no execution;
 *  - the five UI states are derived from SERVER facts first
 *    (`paymentConfirmed` ⇒ activated, a provider-backed row ⇒ awaiting
 *    verification), and an unreadable billing state is `unavailable`, never
 *    `free`;
 *  - display strings are built with integer arithmetic only (no float ever
 *    touches money in this module).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BILLING_CATALOGUE_VERSION,
  BILLING_CHECKOUT_CHOICES,
  BILLING_CHECKOUT_OFFERED_STATES,
  BILLING_CHECKOUT_SELLABLE_PLANS,
  BILLING_CHECKOUT_SESSION_DTO_STATUSES,
  BILLING_CHECKOUT_STATES,
  billingCheckoutChoice,
  billingCheckoutOffered,
  billingCheckoutRequestDtoSchema,
  billingCheckoutSessionDtoSchema,
  billingFxRateDisplay,
  billingPaymentAmountDisplay,
  billingUsdAmountDisplay,
  billingPaymentEvidenceSchema,
  billingProviderModeSchema,
  billingStateDtoSchema,
  BILLING_PROVIDER_MODES,
  getCommercialPlan,
  isBillingCheckoutProjectionError,
  projectBillingCheckoutSession,
  resolveBillingCheckoutState,
  type BillingCheckoutSessionDto,
  type BillingCheckoutSessionProjectionInput,
  type BillingFxSnapshot,
  type BillingPricingSnapshot,
  type BillingStateDto,
} from '../src/index.js';

const FX_VERSION_ID = '7c2f0b6e-3d51-4a2c-9d1f-2b8a5e7c9f03';
const SUBSCRIPTION_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
/** The provider plan code the projection must strip. */
const PROVIDER_PLAN_ID = 'PLN_5a1f0c9e2b7d4bad9bdd2b0d7b3dcb6d';
/** Our deterministic checkout reference (`ve-chk-…`) — must never be disclosed. */
const CHECKOUT_REFERENCE = `ve-chk-${'a1'.repeat(32)}`;
const IDEMPOTENCY_KEY = 'b'.repeat(64);
const AUTHORIZATION_URL = 'https://checkout.example.test/authorize?code=abc123';
const INITIALIZED_AT = '2026-09-22T12:00:00.000Z';
const COMPUTED_AT = '2026-09-22T11:59:31.000Z';

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

const fx = (overrides: Partial<BillingFxSnapshot> = {}): BillingFxSnapshot => ({
  baseCurrency: 'USD',
  quoteCurrency: 'GHS',
  fxRateScaled: 12_500_000,
  fxRateScale: 6,
  fxRateVersionId: FX_VERSION_ID,
  fxRateEffectiveFrom: '2026-09-22T08:00:00.000Z',
  fxRateCapturedAt: '2026-09-22T08:00:00.000Z',
  fxRateSource: 'ops',
  roundingMode: 'half_up',
  ...overrides,
});

/** Pro monthly at 12.5 GHS/USD ⇒ GHS 487.50 = 48 750 pesewas. */
const snapshot = (overrides: Partial<BillingPricingSnapshot> = {}): BillingPricingSnapshot => ({
  commercialCurrency: 'USD',
  commercialAmountMinor: 3900,
  catalogueVersion: BILLING_CATALOGUE_VERSION,
  cataloguePlan: 'pro',
  interval: 'monthly',
  payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
  fx: fx(),
  providerPlanId: PROVIDER_PLAN_ID,
  providerReference: null,
  pricingPolicyVersion: 'pr3-usd-ghs-v1',
  computedAt: COMPUTED_AT,
  ...overrides,
});

/**
 * The FULL internal seam session, exactly as
 * `packages/core/src/billing/provider.ts` produces it: every field the DTO must
 * not carry is present here, so a leak would be visible. The declared type is
 * the projection input widened with the internal fields, which is what makes
 * the "cannot even name them" property testable at runtime.
 */
type SeamSessionFixture = BillingCheckoutSessionProjectionInput & Record<string, unknown>;

function seamSession(overrides: Record<string, unknown> = {}): SeamSessionFixture {
  return {
    provider: 'paystack',
    status: 'initialized',
    reference: CHECKOUT_REFERENCE,
    providerReference: CHECKOUT_REFERENCE,
    authorizationUrl: AUTHORIZATION_URL,
    amountMinor: 3900,
    currency: 'USD',
    payment: snapshot().payment,
    pricing: snapshot(),
    idempotencyKey: IDEMPOTENCY_KEY,
    initializedAt: INITIALIZED_AT,
    ...overrides,
  };
}

function billingState(args: {
  plan?: 'free' | 'pro' | 'premium';
  provider?: string | null;
  providerState?: string | null;
  paymentConfirmed?: boolean;
  mode?: 'test' | 'live';
} = {}): BillingStateDto {
  return billingStateDtoSchema.parse({
    mode: args.mode ?? 'test',
    subscription: {
      id: SUBSCRIPTION_ID,
      plan: args.plan ?? 'free',
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    },
    entitlements: FREE_ENTITLEMENTS,
    providerStatus: {
      provider: args.provider ?? null,
      providerState: args.providerState ?? null,
      paymentConfirmed: args.paymentConfirmed ?? false,
    },
  });
}

/* ========================================================================== */
/* The request body                                                           */
/* ========================================================================== */

describe('Billing Step 9 — the checkout request DTO', () => {
  test('accepts exactly { cataloguePlan, interval } for the four sellable choices', () => {
    for (const choice of BILLING_CHECKOUT_CHOICES) {
      const parsed = billingCheckoutRequestDtoSchema.parse({
        cataloguePlan: choice.cataloguePlan,
        interval: choice.interval,
      });
      assert.deepEqual(parsed, { cataloguePlan: choice.cataloguePlan, interval: choice.interval });
      assert.deepEqual(Object.keys(parsed).sort(), ['cataloguePlan', 'interval']);
    }
  });

  test('refuses Starter and every server-derived field a client might add', () => {
    for (const body of [
      { cataloguePlan: 'starter', interval: 'monthly' },
      { cataloguePlan: 'pro', interval: 'weekly' },
      { cataloguePlan: 'PRO', interval: 'monthly' },
      { cataloguePlan: 'pro' },
      { interval: 'monthly' },
      { cataloguePlan: 'pro', interval: 'monthly', callbackUrl: 'https://evil.example.test/settings' },
      { cataloguePlan: 'pro', interval: 'monthly', amount: 1 },
      { cataloguePlan: 'pro', interval: 'monthly', amountMinor: 3900 },
      { cataloguePlan: 'pro', interval: 'monthly', currency: 'GHS' },
      { cataloguePlan: 'pro', interval: 'monthly', providerPlanId: PROVIDER_PLAN_ID },
      { cataloguePlan: 'pro', interval: 'monthly', provider: 'paystack' },
      { cataloguePlan: 'pro', interval: 'monthly', reference: CHECKOUT_REFERENCE },
      { cataloguePlan: 'pro', interval: 'monthly', idempotencyKey: IDEMPOTENCY_KEY },
      { cataloguePlan: 'pro', interval: 'monthly', userId: SUBSCRIPTION_ID },
      { cataloguePlan: 'pro', interval: 'monthly', authorizationUrl: AUTHORIZATION_URL },
      { cataloguePlan: 'pro', interval: 'monthly', paymentConfirmed: true },
    ]) {
      assert.equal(
        billingCheckoutRequestDtoSchema.safeParse(body).success,
        false,
        `must refuse ${JSON.stringify(body)}`,
      );
    }
  });

  test('Starter is not sellable and the sellable set is exactly Pro + Elite', () => {
    assert.deepEqual([...BILLING_CHECKOUT_SELLABLE_PLANS], ['pro', 'elite']);
    assert.ok(!(BILLING_CHECKOUT_SELLABLE_PLANS as readonly string[]).includes('starter'));
  });
});

/* ========================================================================== */
/* The four choices                                                           */
/* ========================================================================== */

describe('Billing Step 9 — the offered choices', () => {
  test('there are exactly four, in catalogue order, and Starter is absent', () => {
    assert.equal(BILLING_CHECKOUT_CHOICES.length, 4);
    assert.deepEqual(
      BILLING_CHECKOUT_CHOICES.map((choice) => [choice.cataloguePlan, choice.interval]),
      [
        ['pro', 'monthly'],
        ['pro', 'annual'],
        ['elite', 'monthly'],
        ['elite', 'annual'],
      ],
    );
    assert.ok(
      !BILLING_CHECKOUT_CHOICES.some((choice) => (choice.cataloguePlan as string) === 'starter'),
      'Starter is never offered',
    );
    assert.ok(Object.isFrozen(BILLING_CHECKOUT_CHOICES), 'the choice list cannot be edited at runtime');
  });

  test('every choice carries the catalogue price object itself, never a restated amount', () => {
    for (const choice of BILLING_CHECKOUT_CHOICES) {
      const catalogue = getCommercialPlan(choice.cataloguePlan);
      assert.equal(choice.planName, catalogue.name);
      assert.equal(choice.price, catalogue.pricing[choice.interval], 'same frozen instance');
      assert.equal(choice.price.currency, 'USD');
      assert.equal(choice.price.interval, choice.interval);
    }
    // The four authoritative commercial prices, unchanged by this step.
    assert.deepEqual(
      BILLING_CHECKOUT_CHOICES.map((choice) => choice.price.display),
      ['$39', '$390', '$99', '$990'],
    );
  });

  test('a choice is looked up by plan + interval, and an unsellable one is null', () => {
    assert.equal(billingCheckoutChoice('pro', 'monthly')?.price.amountMinor, 3900);
    assert.equal(billingCheckoutChoice('elite', 'annual')?.price.amountMinor, 99_000);
    assert.equal(billingCheckoutChoice('starter' as never, 'monthly'), null);
  });
});

/* ========================================================================== */
/* The projection                                                             */
/* ========================================================================== */

describe('Billing Step 9 — projectBillingCheckoutSession', () => {
  test('discloses the price, the exact payment amount and the FX rate/version/time', () => {
    const dto = projectBillingCheckoutSession(seamSession());
    assert.equal(dto.status, 'initialized');
    assert.equal(dto.authorizationUrl, AUTHORIZATION_URL, 'the URL is carried verbatim');
    assert.deepEqual(dto.price, {
      cataloguePlan: 'pro',
      interval: 'monthly',
      currency: 'USD',
      amountMinor: 3900,
      display: '$39',
    });
    assert.deepEqual(dto.payment, { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 });
    assert.equal(dto.paymentDisplay, 'GHS 487.50');
    assert.deepEqual(dto.fx, {
      baseCurrency: 'USD',
      quoteCurrency: 'GHS',
      fxRateScaled: 12_500_000,
      fxRateScale: 6,
      rateDisplay: '1 USD = 12.5 GHS',
      fxRateVersionId: FX_VERSION_ID,
      fxRateEffectiveFrom: '2026-09-22T08:00:00.000Z',
      fxRateCapturedAt: '2026-09-22T08:00:00.000Z',
      fxRateSource: 'ops',
      roundingMode: 'half_up',
    });
    assert.equal(dto.initializedAt, INITIALIZED_AT);
  });

  test('omits the checkout reference, provider identifiers, idempotency key and internal snapshot', () => {
    const dto = projectBillingCheckoutSession(seamSession());
    assert.deepEqual(Object.keys(dto).sort(), [
      'authorizationUrl',
      'canAccessAutomation',
      'entitlementsChanged',
      'fx',
      'grantsExecution',
      'initializedAt',
      'payment',
      'paymentConfirmed',
      'paymentDisplay',
      'planChanged',
      'price',
      'status',
    ]);
    const wire = JSON.stringify(dto);
    for (const forbidden of [
      CHECKOUT_REFERENCE,
      IDEMPOTENCY_KEY,
      PROVIDER_PLAN_ID,
      'paystack',
      'reference',
      'idempotencyKey',
      'pricing',
      'providerPlanId',
      'providerReference',
      BILLING_CATALOGUE_VERSION,
      'pr3-usd-ghs-v1',
      COMPUTED_AT,
    ]) {
      assert.ok(!wire.includes(forbidden), `the DTO must not carry "${forbidden}"`);
    }
    // The one version identity that IS disclosed is the FX version, which the
    // pricing decisions require ("rate, version and time").
    assert.match(wire, new RegExp(FX_VERSION_ID));
  });

  test('pins every capability and confirmation flag to false', () => {
    const dto = projectBillingCheckoutSession(seamSession());
    assert.equal(dto.paymentConfirmed, false);
    assert.equal(dto.planChanged, false);
    assert.equal(dto.entitlementsChanged, false);
    assert.equal(dto.grantsExecution, false);
    assert.equal(dto.canAccessAutomation, false);
    // The DTO is strict: a client-side "confirmed" cannot be added.
    assert.equal(
      billingCheckoutSessionDtoSchema.safeParse({ ...dto, paymentConfirmed: true }).success,
      false,
    );
    assert.equal(billingCheckoutSessionDtoSchema.safeParse({ ...dto, extra: 1 }).success, false);
  });

  test('the authorization URL is never rewritten and never invented', () => {
    for (const url of [
      'https://checkout.example.test/authorize',
      'https://checkout.example.test/authorize?code=abc&reference=x',
      'https://standardbankpay.example.test/gh/checkout/1a2b3c',
    ]) {
      const dto = projectBillingCheckoutSession(seamSession({ authorizationUrl: url }));
      assert.equal(dto.authorizationUrl, url, 'byte-identical to what the server returned');
    }
  });

  test('only an initialized session carries a URL; a stray URL on a refusal is dropped', () => {
    for (const status of ['failed', 'unavailable'] as const) {
      const dto = projectBillingCheckoutSession(seamSession({ status, authorizationUrl: null }));
      assert.equal(dto.status, status);
      assert.equal(dto.authorizationUrl, null);
      billingCheckoutSessionDtoSchema.parse(dto);
    }
    const dropped = projectBillingCheckoutSession(
      seamSession({ status: 'failed', authorizationUrl: AUTHORIZATION_URL }),
    );
    assert.equal(dropped.authorizationUrl, null, 'a failed session cannot offer a payment link');
  });

  test('a session with no pricing snapshot cannot be projected while initialized', () => {
    for (const pricing of [null, undefined]) {
      assert.throws(
        () => projectBillingCheckoutSession(seamSession({ pricing })),
        (error: unknown) =>
          isBillingCheckoutProjectionError(error) &&
          /no pricing snapshot/.test(error.message) &&
          error.code === 'billing_checkout_projection_refused',
      );
    }
    // The same session, refused by the provider, projects (with no disclosure).
    const dto = projectBillingCheckoutSession(seamSession({ status: 'failed', pricing: null, payment: null }));
    assert.deepEqual(
      { status: dto.status, authorizationUrl: dto.authorizationUrl, price: dto.price, payment: dto.payment, fx: dto.fx },
      { status: 'failed', authorizationUrl: null, price: null, payment: null, fx: null },
    );
  });

  test('a session that disagrees with its own snapshot is refused, never disclosed', () => {
    for (const overrides of [
      { amountMinor: 3901 },
      { amountMinor: 1 },
      { currency: 'GHS' },
      { payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_751, paymentAmountExponent: 2 } },
      { payment: { paymentCurrency: 'GHS', paymentAmountMinor: 1, paymentAmountExponent: 2 } },
    ]) {
      assert.throws(
        () => projectBillingCheckoutSession(seamSession(overrides)),
        isBillingCheckoutProjectionError,
        `must refuse ${JSON.stringify(overrides)}`,
      );
    }
  });

  test('an unsellable plan and an undisclosable URL are refused by the DTO', () => {
    assert.throws(
      () => projectBillingCheckoutSession(seamSession({ pricing: snapshot({ cataloguePlan: 'starter' }) })),
      isBillingCheckoutProjectionError,
      'Starter is never sold, so it is never disclosed',
    );
    assert.throws(
      () => projectBillingCheckoutSession(seamSession({ authorizationUrl: null })),
      isBillingCheckoutProjectionError,
      'an initialized session with no URL cannot be disclosed',
    );
    // The link is rendered verbatim as an anchor href, so only an absolute
    // https URL with no credentials is disclosable (Zod's `.url()` alone would
    // accept every one of these).
    for (const url of [
      'not-a-url',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'http://checkout.example.test/authorize',
      '//checkout.example.test/authorize',
      'https://user:pass@checkout.example.test/authorize',
      'https://checkout.example.test/authorize '.repeat(80),
    ]) {
      assert.throws(
        () => projectBillingCheckoutSession(seamSession({ authorizationUrl: url })),
        isBillingCheckoutProjectionError,
        `must refuse ${url.slice(0, 48)}`,
      );
    }
  });

  test('the projection is deterministic: a retry projects identically', () => {
    assert.deepEqual(
      projectBillingCheckoutSession(seamSession()),
      projectBillingCheckoutSession(seamSession({ reference: `ve-chk-${'c3'.repeat(32)}` })),
      'the omitted reference is the only difference, so the DTO is stable',
    );
  });

  test('the DTO status vocabulary mirrors the provider seam', () => {
    // `packages/core/src/billing/provider.ts` owns the seam vocabulary; the API
    // suite pins the two together over the HTTP boundary (contracts cannot
    // import core).
    assert.deepEqual([...BILLING_CHECKOUT_SESSION_DTO_STATUSES], ['initialized', 'unavailable', 'failed']);
    for (const dto of [
      projectBillingCheckoutSession(seamSession()),
      projectBillingCheckoutSession(seamSession({ status: 'failed', authorizationUrl: null })),
    ]) {
      assert.ok((BILLING_CHECKOUT_SESSION_DTO_STATUSES as readonly string[]).includes(dto.status));
    }
  });
});

/* ========================================================================== */
/* Display helpers — integer arithmetic only                                  */
/* ========================================================================== */

describe('Billing Step 9 — display strings', () => {
  test('USD display matches the catalogue for every price this build sells', () => {
    assert.equal(billingUsdAmountDisplay(3900), '$39');
    assert.equal(billingUsdAmountDisplay(39_000), '$390');
    assert.equal(billingUsdAmountDisplay(9900), '$99');
    assert.equal(billingUsdAmountDisplay(99_000), '$990');
    assert.equal(billingUsdAmountDisplay(12_345), '$123.45');
    assert.equal(billingUsdAmountDisplay(5), '$0.05');
  });

  test('payment display keeps the currency exponent exactly', () => {
    assert.equal(
      billingPaymentAmountDisplay({ paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 }),
      'GHS 487.50',
    );
    assert.equal(
      billingPaymentAmountDisplay({ paymentCurrency: 'GHS', paymentAmountMinor: 10, paymentAmountExponent: 2 }),
      'GHS 0.10',
    );
    assert.equal(
      billingPaymentAmountDisplay({ paymentCurrency: 'GHS', paymentAmountMinor: 1_237_500, paymentAmountExponent: 2 }),
      'GHS 12375.00',
    );
  });

  test('FX rate display renders the persisted scaled integer, never a float', () => {
    assert.equal(billingFxRateDisplay(fx()), '1 USD = 12.5 GHS');
    assert.equal(billingFxRateDisplay(fx({ fxRateScaled: 20_000_000 })), '1 USD = 20 GHS');
    assert.equal(billingFxRateDisplay(fx({ fxRateScaled: 15_123_456 })), '1 USD = 15.123456 GHS');
    assert.equal(billingFxRateDisplay(fx({ fxRateScaled: 123_456_789, fxRateScale: 7 })), '1 USD = 12.3456789 GHS');
    assert.equal(billingFxRateDisplay(fx({ fxRateScaled: 1, fxRateScale: 3 })), '1 USD = 0.001 GHS');
  });

  test('no float ever touches money in this module', () => {
    const source = readFileSync(new URL('../src/billing-checkout.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      /parseFloat/, /toFixed/, /Math\.round/, /Math\.floor/, /Math\.ceil/, /Number\(/, /\*\s*0\./,
    ]) {
      assert.doesNotMatch(source, forbidden, `money display must stay integer-only (${forbidden})`);
    }
    assert.match(source, /BigInt\(/, 'the display helpers use BigInt arithmetic');
  });
});

/* ========================================================================== */
/* The five UI states                                                         */
/* ========================================================================== */

describe('Billing Step 9 — resolveBillingCheckoutState', () => {
  test('the state vocabulary is exactly the five required states', () => {
    assert.deepEqual([...BILLING_CHECKOUT_STATES], [
      'free',
      'awaiting_verification',
      'evidence_recorded',
      'activated',
      'unavailable',
    ]);
    assert.deepEqual([...BILLING_CHECKOUT_OFFERED_STATES], ['free', 'awaiting_verification']);
    for (const state of BILLING_CHECKOUT_STATES) {
      assert.equal(billingCheckoutOffered(state), state === 'free' || state === 'awaiting_verification');
    }
  });

  test('no provider-backed row is the free state, and checkout is offered', () => {
    assert.equal(resolveBillingCheckoutState({ billing: billingState() }), 'free');
    assert.equal(
      resolveBillingCheckoutState({
        billing: billingState({ plan: 'premium', provider: null, providerState: null }),
      }),
      'free',
      'a historical (provider IS NULL) row is not a checkout',
    );
  });

  test('a provider-backed row with no activation is awaiting verification', () => {
    for (const providerState of ['pending', 'active', 'unknown', null]) {
      assert.equal(
        resolveBillingCheckoutState({
          billing: billingState({ plan: 'pro', provider: 'paystack', providerState }),
        }),
        'awaiting_verification',
        `provider_state=${providerState ?? 'NULL'}`,
      );
    }
  });

  test('recorded evidence in the current UI state is its own state, and still not activated', () => {
    const state = resolveBillingCheckoutState({
      billing: billingState({ plan: 'pro', provider: 'paystack', providerState: 'pending' }),
      evidenceRecorded: true,
    });
    assert.equal(state, 'evidence_recorded');
    assert.equal(billingCheckoutOffered(state), false, 'checkout is suppressed once evidence exists');
  });

  test('the server activation fact outranks every UI fact', () => {
    for (const evidenceRecorded of [true, false]) {
      assert.equal(
        resolveBillingCheckoutState({
          billing: billingState({ plan: 'pro', provider: 'paystack', providerState: 'active', paymentConfirmed: true }),
          evidenceRecorded,
          unavailable: true,
        }),
        'activated',
      );
    }
    assert.equal(billingCheckoutOffered('activated'), false);
  });

  test('an unreadable billing state is unavailable, never free', () => {
    assert.equal(resolveBillingCheckoutState({ billing: null }), 'unavailable');
    assert.equal(resolveBillingCheckoutState({ billing: null, evidenceRecorded: true }), 'unavailable');
    assert.equal(
      resolveBillingCheckoutState({ billing: billingState(), unavailable: true }),
      'unavailable',
      'an explicit refusal with no provider row is still unavailable',
    );
    assert.equal(billingCheckoutOffered('unavailable'), false);
  });

  test('a UI-local evidence flag can never fabricate an activation', () => {
    const billing = billingState({ plan: 'pro', provider: 'paystack', providerState: 'pending' });
    assert.equal(resolveBillingCheckoutState({ billing, evidenceRecorded: true }), 'evidence_recorded');
    assert.equal(billing.providerStatus.paymentConfirmed, false, 'the server fact is untouched');
    // Losing the UI flag (a reload) returns to the server-derived state.
    assert.equal(resolveBillingCheckoutState({ billing }), 'awaiting_verification');
  });
});

/* ========================================================================== */
/* The explicit test|live mode vocabulary (migration 0035 widening)          */
/* ========================================================================== */

describe('Billing — the two-value provider mode is explicit and exhaustive', () => {
  const SHA = 'a'.repeat(64);
  const ISO = '2026-09-22T12:00:00.000Z';
  const evidenceRow = (providerDomain: unknown) => ({
    id: '2b0e7c1e-1111-4222-8333-444455556666',
    userId: '2b0e7c1e-1111-4222-8333-444455557777',
    subscriptionId: '2b0e7c1e-1111-4222-8333-444455558888',
    pricingSnapshotId: '2b0e7c1e-1111-4222-8333-444455559999',
    provider: 'paystack',
    providerReference: 've-chk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    providerTransactionId: null,
    paymentAmountMinor: 48_750,
    paymentCurrency: 'GHS',
    paymentAmountExponent: 2,
    providerStatus: 'success',
    providerDomain,
    providerCustomerId: null,
    providerCustomerCode: null,
    paidAt: ISO,
    verifiedAt: ISO,
    evidenceHash: SHA,
    idempotencyKey: SHA,
    createdAt: ISO,
    updatedAt: ISO,
  });

  test('the vocabulary is exactly {test, live} — never an implicit boolean', () => {
    assert.deepEqual([...BILLING_PROVIDER_MODES], ['test', 'live'], 'exactly two provider modes exist');
    assert.equal(billingProviderModeSchema.safeParse('test').success, true);
    assert.equal(billingProviderModeSchema.safeParse('live').success, true);
    for (const invalid of ['sandbox', 'prod', 'production', 'Sandbox', '', 'true']) {
      assert.equal(billingProviderModeSchema.safeParse(invalid).success, false, `refuses "${invalid}"`);
    }
  });

  test('a durable evidence row carries a two-value domain: test and live parse, anything else does not', () => {
    assert.equal(billingPaymentEvidenceSchema.safeParse(evidenceRow('test')).success, true);
    assert.equal(billingPaymentEvidenceSchema.safeParse(evidenceRow('live')).success, true);
    for (const invalid of ['sandbox', 'Sandbox', 'TEST', 'prod', '']) {
      assert.equal(
        billingPaymentEvidenceSchema.safeParse(evidenceRow(invalid)).success,
        false,
        `evidence domain "${invalid}" is refused`,
      );
    }
  });

  test('the billing-state DTO requires the configured mode, and only test|live parse', () => {
    const base = billingState();
    assert.equal(base.mode, 'test', 'the default state is test/sandbox');
    assert.equal(billingStateDtoSchema.safeParse({ ...base, mode: 'live' }).success, true);
    const { mode: _mode, ...withoutMode } = base;
    assert.equal(
      billingStateDtoSchema.safeParse(withoutMode).success,
      false,
      'mode is required — a response never omits it and never infers it',
    );
    for (const invalid of ['sandbox', 'Sandbox', 'prod', true]) {
      assert.equal(billingStateDtoSchema.safeParse({ ...base, mode: invalid }).success, false);
    }
  });
});

/* ========================================================================== */
/* Vocabulary isolation                                                       */
/* ========================================================================== */

describe('Billing Step 9 — the checkout contract knows no provider', () => {
  test('no provider name, endpoint, field name or transport appears in the module', () => {
    const source = readFileSync(new URL('../src/billing-checkout.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      /paystack/i,
      /https?:\/\//,
      /authorization_url/i,
      /access_code/i,
      /customer_code/i,
      /plan_code/i,
      /transaction_reference/i,
      /\bfetch\s*\(/,
      /\bBearer\b/i,
      /sk_test_/i,
    ]) {
      assert.doesNotMatch(source, forbidden, `the checkout contract must stay provider-neutral (${forbidden})`);
    }
  });

  test('the projection input cannot even name the fields it must omit', () => {
    const source = readFileSync(new URL('../src/billing-checkout.ts', import.meta.url), 'utf8');
    const input = source.slice(
      source.indexOf('export interface BillingCheckoutSessionProjectionInput'),
      source.indexOf('export class BillingCheckoutProjectionError'),
    );
    for (const forbidden of [/idempotencyKey/, /providerReference/, /provider\s*:/, /\breference\s*:/]) {
      assert.doesNotMatch(input, forbidden, `the projection input must not name ${forbidden}`);
    }
  });

  test('a session DTO is never a billing-state DTO and cannot move paymentConfirmed there', () => {
    const dto: BillingCheckoutSessionDto = projectBillingCheckoutSession(seamSession());
    assert.equal(billingStateDtoSchema.safeParse(dto).success, false);
    assert.equal(dto.paymentConfirmed, false);
  });
});
