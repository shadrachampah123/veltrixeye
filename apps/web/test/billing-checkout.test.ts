/**
 * Billing Step 9 — the sandbox checkout surface (`/settings`).
 *
 * These tests pin the behaviour the step promises, and the boundaries it must
 * not cross:
 *  - EXACTLY FOUR choices are offered (Pro monthly, Pro annual, Elite monthly,
 *    Elite annual) with the catalogue's own prices; Starter is never offered;
 *  - the five states stay visibly distinct — free, awaiting verification,
 *    evidence awaiting operator activation, activated, unavailable/error;
 *  - checkout is SUPPRESSED (no choice, no button, no link) once evidence is
 *    recorded in this UI state and once the server confirms an activation, and
 *    an unreadable billing state offers nothing either;
 *  - the server-provided price and FX disclosure are rendered from the
 *    disclosed DTO, and the `authorizationUrl` is used VERBATIM as the link;
 *  - verification is an EXPLICIT action: the component contains no timer, no
 *    interval, no effect and no automatic re-check of any kind;
 *  - the API client sends `{}` for the customer and verification calls and
 *    exactly `{ cataloguePlan, interval }` for checkout, and it FAILS CLOSED on
 *    a checkout response that carries an internal field (a reference, a
 *    provider identifier, an idempotency key or a pricing snapshot).
 */
import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BILLING_CHECKOUT_CHOICES,
  billingCheckoutSessionDtoSchema,
  billingStateDtoSchema,
  projectBillingCheckoutSession,
  type BillingCheckoutSessionDto,
  type BillingPaymentVerificationResult,
  type BillingStateDto,
} from '@veltrixeye/contracts';
import { api } from '../lib/api';
import {
  BILLING_CHECKOUT_STATE_COPY,
  BILLING_VERIFICATION_FAILURE_COPY,
  BillingCheckoutChoices,
  BillingCheckoutPanel,
  BillingCheckoutSessionDisclosure,
  BillingVerificationNotice,
  toVerificationSummary,
} from '../components/billing-checkout';

const SUBSCRIPTION_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const FX_VERSION_ID = '7c2f0b6e-3d51-4a2c-9d1f-2b8a5e7c9f03';
const AUTHORIZATION_URL = 'https://checkout.example.test/authorize?code=abc123';
/** Internal values that must never reach the markup. */
const CHECKOUT_REFERENCE = `ve-chk-${'a1'.repeat(32)}`;
const IDEMPOTENCY_KEY = 'b'.repeat(64);
const PROVIDER_PLAN_ID = 'PLN_5a1f0c9e2b7d4bad9bdd2b0d7b3dcb6d';

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

function billingState(args: {
  plan?: 'free' | 'pro' | 'premium';
  provider?: string | null;
  providerState?: string | null;
  paymentConfirmed?: boolean;
  /** The server-reported provider domain (default: the sandbox test domain). */
  mode?: 'test' | 'live';
} = {}): BillingStateDto {
  return billingStateDtoSchema.parse({
    // The default provider domain: mode-aware copy renders sandbox text.
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
    // A non-commercial operator grant is always disclosed when one exists; none
    // of these fixtures has one.
    entitlementGrant: null,
  });
}

/** A disclosed checkout session, produced by the REAL projection. */
function sessionDto(overrides: Record<string, unknown> = {}): BillingCheckoutSessionDto {
  return projectBillingCheckoutSession({
    status: 'initialized',
    authorizationUrl: AUTHORIZATION_URL,
    amountMinor: 3900,
    currency: 'USD',
    payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
    pricing: {
      commercialCurrency: 'USD',
      commercialAmountMinor: 3900,
      catalogueVersion: 'billing-catalogue-1',
      cataloguePlan: 'pro',
      interval: 'monthly',
      payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
      fx: {
        baseCurrency: 'USD',
        quoteCurrency: 'GHS',
        fxRateScaled: 12_500_000,
        fxRateScale: 6,
        fxRateVersionId: FX_VERSION_ID,
        fxRateEffectiveFrom: '2026-09-22T08:00:00.000Z',
        fxRateCapturedAt: '2026-09-22T08:00:00.000Z',
        fxRateSource: 'ops',
        roundingMode: 'half_up',
      },
      providerPlanId: PROVIDER_PLAN_ID,
      providerReference: null,
      pricingPolicyVersion: 'pr3-usd-ghs-v1',
      computedAt: '2026-09-22T11:59:31.000Z',
    },
    initializedAt: '2026-09-22T12:00:00.000Z',
    ...overrides,
  });
}

function verificationResult(
  overrides: Partial<BillingPaymentVerificationResult> = {},
): BillingPaymentVerificationResult {
  return {
    verified: true,
    evidence: {
      id: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      subscriptionId: SUBSCRIPTION_ID,
      pricingSnapshotId: '33333333-3333-4333-8333-333333333333',
      provider: 'paystack',
      providerReference: CHECKOUT_REFERENCE,
      providerTransactionId: '44444444',
      paymentAmountMinor: 48_750,
      paymentCurrency: 'GHS',
      paymentAmountExponent: 2,
      providerStatus: 'success',
      providerDomain: 'test',
      providerCustomerId: null,
      providerCustomerCode: 'CUS_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      paidAt: '2026-09-22T12:01:00.000Z',
      verifiedAt: '2026-09-22T12:02:00.000Z',
      evidenceHash: 'c'.repeat(64),
      idempotencyKey: IDEMPOTENCY_KEY,
      createdAt: '2026-09-22T12:02:00.000Z',
      updatedAt: '2026-09-22T12:02:00.000Z',
    },
    failureReason: null,
    failureMessage: null,
    providerReference: CHECKOUT_REFERENCE,
    providerStatus: 'success',
    replayed: false,
    verifiedAt: '2026-09-22T12:02:00.000Z',
    grantsExecution: false,
    planChanged: false,
    entitlementsChanged: false,
    ...overrides,
  };
}

const renderPanel = (props: Partial<React.ComponentProps<typeof BillingCheckoutPanel>> = {}) =>
  renderToStaticMarkup(
    React.createElement(BillingCheckoutPanel, { billing: billingState(), ...props }),
  );

const componentSource = readFileSync(
  fileURLToPath(new URL('../components/billing-checkout.tsx', import.meta.url)),
  'utf8',
);
const apiSource = readFileSync(fileURLToPath(new URL('../lib/api.ts', import.meta.url)), 'utf8');

/* ========================================================================== */
/* The four choices                                                           */
/* ========================================================================== */

describe('Billing Step 9 — exactly four choices', () => {
  test('the free state offers Pro/Elite × monthly/annual with catalogue prices and no Starter', () => {
    const markup = renderPanel();
    assert.match(markup, /Sandbox Checkout/);
    assert.equal(markup.match(/type="radio"/g)?.length, 4, 'exactly four choices');
    for (const label of ['Pro · monthly', 'Pro · annual', 'Elite · monthly', 'Elite · annual']) {
      assert.match(markup, new RegExp(label.replace('·', '·')), `offers ${label}`);
    }
    for (const price of ['$39', '$390', '$99', '$990']) {
      assert.match(markup, new RegExp(price.replace('$', '\\$')), `shows the catalogue price ${price}`);
    }
    assert.doesNotMatch(markup, /Starter/i, 'Starter is not sellable and is never offered');
    assert.doesNotMatch(markup, /\$15/, 'the Starter price is never rendered');
    assert.match(markup, /Create sandbox checkout/, 'the checkout action exists');
    // No session yet, so there is no payment link and no verification action.
    assert.doesNotMatch(markup, /<a\s/i);
    assert.doesNotMatch(markup, /Verify payment/);
  });

  test('the choice list is the shared catalogue-derived four, in order', () => {
    assert.deepEqual(
      BILLING_CHECKOUT_CHOICES.map((choice) => `${choice.planName} ${choice.interval} ${choice.price.display}`),
      ['Pro monthly $39', 'Pro annual $390', 'Elite monthly $99', 'Elite annual $990'],
    );
    const markup = renderToStaticMarkup(
      React.createElement(BillingCheckoutChoices, {
        selected: { cataloguePlan: 'elite', interval: 'annual' },
      }),
    );
    assert.equal(markup.match(/type="radio"/g)?.length, 4);
    assert.match(markup, /value="elite:annual"/);
    assert.match(markup, /checked=""/, 'the selected choice is checked');
    assert.equal(markup.match(/checked=""/g)?.length, 1, 'exactly one choice is selected');
  });
});

/* ========================================================================== */
/* The five states                                                            */
/* ========================================================================== */

describe('Billing Step 9 — the five states stay distinct', () => {
  test('each state has its own label and its own explanation', () => {
    assert.deepEqual(Object.keys(BILLING_CHECKOUT_STATE_COPY).sort(), [
      'activated',
      'awaiting_verification',
      'evidence_recorded',
      'free',
      'unavailable',
    ]);
    const labels = Object.values(BILLING_CHECKOUT_STATE_COPY).map((copy) => copy.label);
    assert.equal(new Set(labels).size, labels.length, 'no two states share a label');
    const bodies = Object.values(BILLING_CHECKOUT_STATE_COPY).map((copy) => copy.body);
    assert.equal(new Set(bodies).size, bodies.length, 'no two states share an explanation');
  });

  test('free — no provider-backed row: checkout is offered', () => {
    const markup = renderPanel({ billing: billingState() });
    assert.match(markup, /free plan/);
    assert.match(markup, /Create sandbox checkout/);
    assert.equal(markup.match(/type="radio"/g)?.length, 4);
  });

  test('awaiting verification — a provider-backed row with no evidence: still offered', () => {
    const markup = renderPanel({
      billing: billingState({ plan: 'pro', provider: 'paystack', providerState: 'pending' }),
    });
    assert.match(markup, /awaiting payment verification/);
    assert.match(markup, /locked server-side/, 'the lock, not the selection, governs the price');
    assert.equal(markup.match(/type="radio"/g)?.length, 4, 'checkout is NOT suppressed yet');
    assert.match(markup, /Create sandbox checkout/);
    assert.doesNotMatch(markup, /activated/i);
  });

  test('evidence recorded — awaiting operator activation: checkout is suppressed', () => {
    const markup = renderPanel({
      billing: billingState({ plan: 'pro', provider: 'paystack', providerState: 'pending' }),
      evidenceRecorded: true,
    });
    assert.match(markup, /evidence recorded · awaiting operator activation/);
    assert.match(markup, /Evidence is a receipt, never an activation/);
    assert.match(markup, /npm run billing:activate/, 'the only activation path is named');
    assert.doesNotMatch(markup, /<button/i, 'no action of any kind');
    assert.doesNotMatch(markup, /<a\s/i, 'no payment link');
    assert.doesNotMatch(markup, /type="radio"/, 'no plan choice');
    assert.doesNotMatch(markup, /Create sandbox checkout/);
    assert.doesNotMatch(markup, /Verify payment/);
  });

  test('activated — the server confirmed the activation: checkout is suppressed', () => {
    const markup = renderPanel({
      billing: billingState({
        plan: 'pro', provider: 'paystack', providerState: 'active', paymentConfirmed: true,
      }),
    });
    assert.match(markup, />activated</);
    assert.match(markup, /An operator authorized this subscription/);
    assert.match(markup, /Checkout is closed/);
    assert.doesNotMatch(markup, /<button/i);
    assert.doesNotMatch(markup, /<a\s/i);
    assert.doesNotMatch(markup, /type="radio"/);
    // Activation outranks a stale UI evidence flag and a refusal flag.
    assert.match(
      renderPanel({
        billing: billingState({ plan: 'pro', provider: 'paystack', paymentConfirmed: true }),
        evidenceRecorded: true,
        unavailable: true,
      }),
      />activated</,
    );
  });

  test('unavailable — an unreadable billing state offers nothing and claims nothing', () => {
    for (const props of [
      { billing: null, unavailable: true },
      { billing: billingState(), unavailable: true },
    ]) {
      const markup = renderPanel(props);
      assert.match(markup, /billing unavailable/);
      assert.match(markup, /Nothing is offered and nothing is claimed/);
      assert.doesNotMatch(markup, /<button/i);
      assert.doesNotMatch(markup, /<a\s/i);
      assert.doesNotMatch(markup, /type="radio"/);
      assert.doesNotMatch(markup, /free plan/, 'a failure is never presented as the free state');
    }
  });

  test('loading is not a state: no affordance while the billing read is in flight', () => {
    const markup = renderPanel({ billing: null });
    assert.match(markup, /Loading billing state/);
    assert.doesNotMatch(markup, /<button/i);
    assert.doesNotMatch(markup, /<a\s/i);
    assert.doesNotMatch(markup, /type="radio"/);
  });
});

/* ========================================================================== */
/* The disclosed session: price, FX and the verbatim authorization URL         */
/* ========================================================================== */

describe('Billing Step 9 — the disclosed checkout session', () => {
  test('renders the server-provided price, the exact payment amount and the FX disclosure', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BillingCheckoutSessionDisclosure, { session: sessionDto() }),
    );
    assert.match(markup, /Server-provided price/);
    assert.match(markup, /\$39/, 'the commercial USD price is prominent');
    assert.match(markup, /You pay/);
    assert.match(markup, /GHS 487\.50/, 'the exact GHS amount');
    assert.match(markup, /1 USD = 12\.5 GHS/, 'the FX rate');
    assert.match(markup, new RegExp(FX_VERSION_ID), 'the rate version');
    assert.match(markup, /half_up/, 'the single rounding step');
    assert.match(markup, /Rate captured/);
    assert.match(markup, /Rate effective from/);
    assert.match(markup, /Verify payment/, 'the explicit verification action');
    assert.match(markup, /never\s+polls the provider/, 'and the promise that it is not automatic');
  });

  test('the authorization URL is used verbatim as the link and shown verbatim as text', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BillingCheckoutSessionDisclosure, { session: sessionDto() }),
    );
    assert.match(markup, new RegExp(`href="${AUTHORIZATION_URL.replace(/[?&]/g, '\\$&')}"`));
    assert.equal(
      markup.split(AUTHORIZATION_URL).length - 1,
      2,
      'the URL appears exactly twice: the href and the visible text',
    );
    assert.match(markup, /rel="noopener noreferrer"/, 'a cross-origin payment page gets no window access');
    // Nothing internal is rendered next to it.
    for (const forbidden of [CHECKOUT_REFERENCE, IDEMPOTENCY_KEY, PROVIDER_PLAN_ID, 'paystack', 'idempotencyKey']) {
      assert.ok(!markup.includes(forbidden), `the disclosure must not render "${forbidden}"`);
    }
  });

  test('a locked plan the selection did not choose is disclosed as the server priced it', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BillingCheckoutSessionDisclosure, {
        session: sessionDto(),
        selected: { cataloguePlan: 'elite', interval: 'annual' },
      }),
    );
    assert.match(markup, /The server priced pro · monthly/);
    assert.match(markup, /the lock is immutable/);
  });

  test('a session that did not initialize shows no payment link and charges nothing', () => {
    for (const status of ['failed', 'unavailable'] as const) {
      const markup = renderToStaticMarkup(
        React.createElement(BillingCheckoutSessionDisclosure, {
          session: sessionDto({ status, authorizationUrl: null }),
        }),
      );
      assert.doesNotMatch(markup, /<a\s/i, 'no link without an initialized session');
      assert.doesNotMatch(markup, /Authorize payment/);
      assert.doesNotMatch(markup, /Verify payment/, 'nothing to verify');
      assert.match(markup, /did not initialize this checkout/);
      assert.match(markup, new RegExp(status));
      assert.match(markup, /Nothing was charged/);
    }
  });

  test('a session DTO cannot carry an internal field, so the markup cannot either', () => {
    const dto = billingCheckoutSessionDtoSchema.parse(sessionDto());
    assert.deepEqual(Object.keys(dto).sort(), [
      'authorizationUrl', 'canAccessAutomation', 'entitlementsChanged', 'fx', 'grantsExecution',
      'initializedAt', 'payment', 'paymentConfirmed', 'paymentDisplay', 'planChanged', 'price', 'status',
    ]);
    assert.equal(dto.paymentConfirmed, false);
    assert.equal(dto.grantsExecution, false);
    assert.equal(dto.canAccessAutomation, false);
  });
});

/* ========================================================================== */
/* Verification: explicit, structured, and free of provider detail             */
/* ========================================================================== */

describe('Billing Step 9 — verification is explicit and evidence is not authority', () => {
  test('a verified result says evidence was recorded and that it activates nothing', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BillingVerificationNotice, {
        verification: toVerificationSummary(verificationResult()),
      }),
    );
    assert.match(markup, /Payment evidence recorded/);
    assert.match(markup, /Evidence is a receipt, not an activation/);
    assert.match(markup, /operator authorizes the activation out of band/);
    assert.doesNotMatch(markup, /activated your|plan is now|you now have/i);
  });

  test('an idempotent replay is labelled as one', () => {
    const markup = renderToStaticMarkup(
      React.createElement(BillingVerificationNotice, {
        verification: toVerificationSummary(verificationResult({ replayed: true })),
      }),
    );
    assert.match(markup, /replayed — this evidence was already recorded/);
  });

  test('every failure reason has user-facing copy and no reason is swallowed', () => {
    for (const [reason, copy] of Object.entries(BILLING_VERIFICATION_FAILURE_COPY)) {
      const markup = renderToStaticMarkup(
        React.createElement(BillingVerificationNotice, {
          verification: toVerificationSummary(
            verificationResult({ verified: false, evidence: null, failureReason: reason as never }),
          ),
        }),
      );
      assert.match(markup, /Payment not verified/);
      assert.match(markup, new RegExp(reason), 'the typed reason is shown');
      assert.ok(markup.includes(copy.slice(0, 24)), `copy for ${reason} is rendered`);
      assert.match(markup, /No evidence was recorded and no entitlement changed/);
    }
    assert.equal(Object.keys(BILLING_VERIFICATION_FAILURE_COPY).length, 11);
  });

  test('the verification summary drops the evidence row and every provider identifier', () => {
    const summary = toVerificationSummary(verificationResult());
    assert.deepEqual(Object.keys(summary).sort(), [
      'failureMessage', 'failureReason', 'replayed', 'verified', 'verifiedAt',
    ]);
    const wire = JSON.stringify(summary);
    for (const forbidden of [
      CHECKOUT_REFERENCE, IDEMPOTENCY_KEY, 'c'.repeat(64), 'CUS_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'evidence', 'providerReference', 'providerTransactionId', 'paystack',
    ]) {
      assert.ok(!wire.includes(forbidden), `the summary must not carry "${forbidden}"`);
    }
    const markup = renderToStaticMarkup(
      React.createElement(BillingVerificationNotice, { verification: summary }),
    );
    for (const forbidden of [CHECKOUT_REFERENCE, IDEMPOTENCY_KEY, 'CUS_9f8e']) {
      assert.ok(!markup.includes(forbidden), `the notice must not render "${forbidden}"`);
    }
  });
});

/* ========================================================================== */
/* No polling, no credential, no invented URL — pinned in source               */
/* ========================================================================== */

describe('Billing Step 9 — source pins', () => {
  test('the checkout surface has no timer, no effect and no automatic check', () => {
    for (const forbidden of [
      /setInterval/, /setTimeout/, /requestAnimationFrame/, /requestIdleCallback/,
      /useEffect/, /EventSource/, /WebSocket/, /visibilitychange/,
      /window\.location/, /location\.reload/,
    ]) {
      assert.doesNotMatch(componentSource, forbidden, `no automatic behaviour (${forbidden})`);
    }
    // The two provider reads happen only inside click handlers.
    assert.match(componentSource, /const createCheckout = React\.useCallback/);
    assert.match(componentSource, /const verifyPayment = React\.useCallback/);
    assert.match(componentSource, /onClick=\{\(\) => void createCheckout\(\)\}/);
    assert.match(componentSource, /onClick=\{onVerify\}/);
  });

  test('the authorization URL is never constructed, rewritten or re-encoded', () => {
    assert.match(componentSource, /href=\{session\.authorizationUrl/, 'used verbatim as the href');
    for (const forbidden of [
      /new URL\(/, /href=\{`/, /encodeURI/, /\$\{session\.authorizationUrl\}/,
      /authorizationUrl\.replace/, /authorizationUrl \+/, /\+ session\.authorizationUrl/,
    ]) {
      assert.doesNotMatch(componentSource, forbidden, `the URL must stay verbatim (${forbidden})`);
    }
  });

  test('the component holds no credential, provider endpoint or provider vocabulary', () => {
    for (const forbidden of [
      /sk_test/i, /sk_live/i, /PAYSTACK_SECRET_KEY/, /api\.paystack\.co/i, /authorization_url/i,
      /access_code/i, /x-paystack-signature/i, /idempotencyKey/, /localStorage/, /sessionStorage/,
    ]) {
      assert.doesNotMatch(componentSource, forbidden, `no provider detail in the UI (${forbidden})`);
    }
  });

  test('the API client sends {} for customer + verify and only the plan for checkout', () => {
    assert.match(apiSource, /const EMPTY_JSON_BODY = '\{\}';/);
    assert.match(
      apiSource,
      /ensureBillingCustomer:[\s\S]{0,220}?body: EMPTY_JSON_BODY/,
      'customer provisioning sends the empty JSON body',
    );
    assert.match(
      apiSource,
      /verifyBillingPayment:[\s\S]{0,220}?body: EMPTY_JSON_BODY/,
      'verification sends the empty JSON body',
    );
    assert.match(
      apiSource,
      /body: JSON\.stringify\(billingCheckoutRequestDtoSchema\.parse\(input\)\)/,
      'checkout sends exactly the strict { cataloguePlan, interval } body',
    );
    assert.match(
      apiSource,
      /billingCheckoutSessionDtoSchema\.parse/,
      'and the answer is parsed through the strict disclosed DTO',
    );
    // Billing Portal v1 added exactly ONE more call: the read-only
    // `GET /api/billing/portal`, which sends no method, no body and no
    // identity — the subject is the session. Nothing self-service exists: no
    // callback, activation, cancellation, invoice or payment-method call.
    assert.match(
      apiSource,
      /getBillingPortalSummary:[\s\S]{0,240}?request<BillingPortalSummaryDto>\('\/billing\/portal'\)/,
      'the portal overview is a body-less read of the session user\'s own summary',
    );
    assert.doesNotMatch(
      apiSource,
      /\/billing\/(callback|activate|activations|cancel|invoices|payment-methods|refund)/,
      'no callback, activation, cancellation, invoice, payment-method or refund call',
    );
  });
});

/* ========================================================================== */
/* The API client over a fake transport                                        */
/* ========================================================================== */

describe('Billing Step 9 — api client request shapes', () => {
  interface RecordedCall { url: string; init: RequestInit | undefined }
  let calls: RecordedCall[] = [];
  let responseBody: string = '{}';
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls = [];
    responseBody = '{}';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(responseBody, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  const contentTypeOf = (call: RecordedCall) => new Headers(call.init?.headers).get('content-type');

  test('ensureBillingCustomer() — POST /api/billing/customer with an empty {} body', async () => {
    responseBody = JSON.stringify({
      provider: 'paystack', outcome: 'already_provisioned', status: 'provisioned',
      email: 'trader@example.test', provisionedAt: '2026-09-22T12:00:00.000Z',
      checkoutReady: true, entitlementsChanged: false, grantsExecution: false,
    });
    const result = await api.ensureBillingCustomer();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, '/api/billing/customer');
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.body, '{}', 'the body is exactly {}');
    assert.equal(contentTypeOf(calls[0]!), 'application/json');
    assert.equal(result.checkoutReady, true);
    assert.equal(result.grantsExecution, false);
  });

  test('verifyBillingPayment() — POST /api/billing/verify with an empty {} body', async () => {
    responseBody = JSON.stringify(verificationResult());
    const result = await api.verifyBillingPayment();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, '/api/billing/verify');
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(calls[0]!.init?.body, '{}', 'the body is exactly {}');
    assert.equal(contentTypeOf(calls[0]!), 'application/json');
    assert.equal(result.verified, true);
    assert.equal(result.grantsExecution, false);
  });

  test('checkoutBilling() — sends exactly { cataloguePlan, interval }', async () => {
    responseBody = JSON.stringify(sessionDto());
    for (const choice of BILLING_CHECKOUT_CHOICES) {
      calls = [];
      const dto = await api.checkoutBilling({
        cataloguePlan: choice.cataloguePlan,
        interval: choice.interval,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url, '/api/billing/checkout');
      assert.equal(calls[0]!.init?.method, 'POST');
      assert.equal(
        calls[0]!.init?.body,
        JSON.stringify({ cataloguePlan: choice.cataloguePlan, interval: choice.interval }),
      );
      assert.deepEqual(Object.keys(JSON.parse(String(calls[0]!.init?.body))).sort(), ['cataloguePlan', 'interval']);
      assert.equal(contentTypeOf(calls[0]!), 'application/json');
      assert.equal(dto.authorizationUrl, AUTHORIZATION_URL);
      assert.equal(dto.price?.cataloguePlan, 'pro', 'the disclosed session is the fixture');
    }
  });

  test('checkoutBilling() refuses an unsellable plan or an extra field before any request', async () => {
    for (const input of [
      { cataloguePlan: 'starter', interval: 'monthly' },
      { cataloguePlan: 'pro', interval: 'weekly' },
      { cataloguePlan: 'pro', interval: 'monthly', amount: 1 },
      { cataloguePlan: 'pro', interval: 'monthly', callbackUrl: 'https://evil.example.test/settings' },
      { cataloguePlan: 'pro', interval: 'monthly', providerPlanId: PROVIDER_PLAN_ID },
    ]) {
      let refused = false;
      try {
        await api.checkoutBilling(input as never);
      } catch {
        refused = true;
      }
      assert.ok(refused, `must refuse ${JSON.stringify(input)} before sending`);
    }
    assert.equal(calls.length, 0, 'nothing reached the network');
  });

  test('checkoutBilling() fails closed on a response carrying an internal field', async () => {
    for (const extra of [
      { reference: CHECKOUT_REFERENCE },
      { providerReference: CHECKOUT_REFERENCE },
      { idempotencyKey: IDEMPOTENCY_KEY },
      { provider: 'paystack' },
      { pricing: sessionDto().fx },
      { paymentConfirmed: true },
    ]) {
      responseBody = JSON.stringify({ ...sessionDto(), ...extra });
      let refused = false;
      try {
        await api.checkoutBilling({ cataloguePlan: 'pro', interval: 'monthly' });
      } catch {
        refused = true;
      }
      assert.ok(refused, `must refuse a response carrying ${JSON.stringify(Object.keys(extra))}`);
    }
  });
});

/* ========================================================================== */
/* Mode-aware copy: a live billing state is never called a sandbox            */
/* ========================================================================== */

describe('Billing Step 9 — mode-aware copy', () => {
  test('a live billing state never displays sandbox vocabulary', () => {
    const markup = renderPanel({ billing: billingState({ mode: 'live' }) });
    assert.doesNotMatch(markup, /Sandbox Checkout/, 'the live header is not the sandbox header');
    assert.match(markup, />Checkout</, 'the neutral live title');
    assert.match(markup, /Paystack live mode/, 'the subtitle says live mode');
    assert.match(markup, /Create checkout/, 'the live action is not a sandbox checkout');
    assert.doesNotMatch(markup, /Create sandbox checkout/);
    assert.match(markup, /Live mode:/, 'the domain notice states live mode');
    assert.doesNotMatch(markup, /Sandbox only:/);
    assert.doesNotMatch(markup, /four sandbox choices/);
    assert.doesNotMatch(markup, /sandbox payment page/);
    assert.doesNotMatch(markup, /Creating a sandbox checkout/);
    assert.doesNotMatch(markup, /A sandbox checkout exists/);
  });

  test('a test billing state keeps every sandbox assertion from the existing suite', () => {
    const markup = renderPanel({ billing: billingState({ mode: 'test' }) });
    assert.match(markup, /Sandbox Checkout/);
    assert.match(markup, /Create sandbox checkout/);
    assert.match(markup, /Sandbox only:/);
    assert.match(markup, /four sandbox choices/);
    assert.doesNotMatch(markup, /Paystack live mode/);
    assert.doesNotMatch(markup, /Live mode:/);
  });

  test('an unreadable billing state claims NEITHER domain', () => {
    const loading = renderPanel({ billing: null });
    assert.doesNotMatch(loading, /Sandbox Checkout/, 'loading never claims the sandbox');
    assert.doesNotMatch(loading, /live mode/i, 'loading never claims live mode either');
    const failed = renderPanel({ billing: null, unavailable: true });
    assert.doesNotMatch(failed, /Sandbox Checkout/);
    assert.doesNotMatch(failed, /Live mode:/);
  });

  test('a live verification failure names the live domain, not the sandbox domain', () => {
    const summary = toVerificationSummary(
      verificationResult({ verified: false, evidence: null, failureReason: 'domain_mismatch' as never }),
    );
    const live = renderToStaticMarkup(
      React.createElement(BillingVerificationNotice, { verification: summary, mode: 'live' }),
    );
    assert.match(live, /configured live domain/);
    assert.doesNotMatch(live, /sandbox \(test\) domain/);

    const test = renderToStaticMarkup(
      React.createElement(BillingVerificationNotice, { verification: summary, mode: 'test' }),
    );
    assert.match(test, /sandbox \(test\) domain/);
    assert.doesNotMatch(test, /configured live domain/);
  });

  test('the disclosure and the choices default to the sandbox copy for direct renders', () => {
    const disclosure = renderToStaticMarkup(
      React.createElement(BillingCheckoutSessionDisclosure, { session: sessionDto() }),
    );
    assert.match(disclosure, /sandbox payment page/);

    const liveDisclosure = renderToStaticMarkup(
      React.createElement(BillingCheckoutSessionDisclosure, { session: sessionDto(), mode: 'live' }),
    );
    assert.match(liveDisclosure, /Opens the provider['\u2019]s payment page/);
    assert.doesNotMatch(liveDisclosure, /sandbox payment page/);

    const choices = renderToStaticMarkup(
      React.createElement(BillingCheckoutChoices, { selected: { cataloguePlan: 'pro', interval: 'monthly' } }),
    );
    assert.match(choices, /four sandbox choices/);

    const liveChoices = renderToStaticMarkup(
      React.createElement(BillingCheckoutChoices, {
        selected: { cataloguePlan: 'pro', interval: 'monthly' },
        mode: 'live',
      }),
    );
    assert.doesNotMatch(liveChoices, /four sandbox choices/);
  });
});
