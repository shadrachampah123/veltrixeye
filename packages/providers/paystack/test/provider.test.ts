/**
 * Paystack sandbox billing provider — the FAIL-CLOSED matrix.
 *
 * Every case asserts the same property from a different angle: when anything in
 * the authorization chain (pricing snapshot → local plan epoch → provider call)
 * does not line up exactly, NOTHING is sent and no charge can occur. The
 * transport is injected everywhere, so the suite proves what was (and was not)
 * transmitted.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BILLING_CATALOGUE_VERSION, type BillingPricingSnapshot } from '@veltrixeye/contracts';
import { priceCommercialPlan, type BillingProviderPlan } from '@veltrixeye/core';
import {
  PAYSTACK_IMPLEMENTED_OPERATIONS,
  PaystackNotImplementedError,
  createPaystackProvider,
  deterministicLocalId,
  isPaystackAdapterError,
  type PaystackCustomerDirectory,
  type PaystackFetchFn,
  type PaystackPlanDirectory,
} from '../src/index.js';

const TEST_KEY = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const USER_ID = 'u0000000-0000-4000-8000-000000000001'.replace('u', '1');
const FX_VERSION_ID = '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01';
const CAPTURED_AT = '2026-09-22T09:00:00.000Z';
const AS_OF = new Date('2026-09-22T09:05:00.000Z');
const REFERENCE = 've-chk-0001';

/** A rate of 12.5 GHS per USD, expressed as the scaled integer 12_500_000 @ 6. */
function fx(overrides: Partial<ReturnType<typeof fxBase>> = {}) {
  return { ...fxBase(), ...overrides };
}

function fxBase() {
  return {
    baseCurrency: 'USD' as const,
    quoteCurrency: 'GHS' as const,
    fxRateScaled: 12_500_000,
    fxRateScale: 6,
    fxRateVersionId: FX_VERSION_ID,
    fxRateEffectiveFrom: CAPTURED_AT,
    fxRateCapturedAt: CAPTURED_AT,
    fxRateSource: 'ops' as const,
    roundingMode: 'half_up' as const,
  };
}

/** Pro monthly ($39.00) at 12.5 GHS/USD ⇒ GHS 487.50 = 48_750 pesewas. */
const PRO_MONTHLY_GHS_MINOR = 48_750;

function snapshot(overrides: { providerPlanId?: string | null } = {}): BillingPricingSnapshot {
  return priceCommercialPlan({
    planId: 'pro',
    interval: 'monthly',
    fx: fx(),
    asOf: AS_OF,
    providerPlanId: overrides.providerPlanId === undefined ? null : overrides.providerPlanId,
    providerReference: REFERENCE,
  });
}

/**
 * A validated epoch, exactly as composition hands one to the adapter
 * (`parseProviderPlan` output). Amounts are bigint here because this is an
 * in-process boundary, not JSON.
 */
const epochFor = (s: BillingPricingSnapshot, overrides: Partial<BillingProviderPlan> = {}): BillingProviderPlan => ({
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'paystack',
  mode: 'test',
  cataloguePlan: s.cataloguePlan,
  interval: s.interval,
  paymentCurrency: s.payment.paymentCurrency,
  paymentAmountMinor: BigInt(s.payment.paymentAmountMinor),
  paymentAmountExponent: s.payment.paymentAmountExponent,
  providerPlanId: s.providerPlanId ?? 'PLN_pro_monthly',
  providerPlanReference: null,
  fxRateVersionId: s.fx.fxRateVersionId,
  pricingPolicyVersion: s.pricingPolicyVersion,
  catalogueVersion: 'billing-catalogue-1',
  status: 'active',
  validFrom: new Date('2026-09-22T09:00:00.000Z'),
  retiredAt: null,
  ...overrides,
});

const customers = (found: boolean): PaystackCustomerDirectory => ({
  find: async () => (found ? { email: 'trader@example.com', providerCustomerCode: 'CUS_abc' } : null),
});

const plans = (epoch: BillingProviderPlan | null): PaystackPlanDirectory => ({
  find: async () => epoch,
});

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function transport(responses: Array<{ status: number; body: unknown }>): {
  fetchFn: PaystackFetchFn;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchFn: PaystackFetchFn = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const response = responses[index] ?? responses[responses.length - 1];
    index += 1;
    return { status: response?.status ?? 500, json: async () => response?.body };
  };
  return { fetchFn, calls };
}

function build(options: {
  epoch?: BillingProviderPlan | null;
  customerProvisioned?: boolean;
  responses?: Array<{ status: number; body: unknown }>;
}) {
  const t = transport(
    options.responses ?? [
      {
        status: 200,
        body: {
          status: true,
          data: { authorization_url: 'https://checkout.paystack.com/sandbox', reference: REFERENCE },
        },
      },
    ],
  );
  const provider = createPaystackProvider({
    secretKey: TEST_KEY,
    timeoutMs: 2000,
    fetchFn: t.fetchFn,
    clock: () => new Date('2026-09-22T09:10:00.000Z'),
    customers: customers(options.customerProvisioned ?? true),
    plans: plans(options.epoch ?? null),
  });
  return { provider, calls: t.calls };
}

const checkoutRequest = (s: BillingPricingSnapshot) => ({
  provider: 'paystack' as const,
  userId: USER_ID,
  plan: { cataloguePlan: s.cataloguePlan, interval: s.interval },
  reference: REFERENCE,
  pricing: s,
  idempotencyKey: 'a'.repeat(64),
  callbackUrl: 'https://app.example.com/billing/callback',
  requestedAt: '2026-09-22T09:05:00.000Z',
});

const expectReason = (reason: string) => (error: unknown) => {
  assert.ok(isPaystackAdapterError(error), `expected a PaystackAdapterError, got ${String(error)}`);
  assert.equal(error.reason, reason, `expected reason ${reason}, got ${error.reason}`);
  return true;
};

describe('Paystack provider — honest capability reporting', () => {
  test('implemented is false and live is false, and describe() lists what really works', () => {
    const { provider } = build({});
    assert.equal(provider.implemented, false, 'four of eight seam operations are implemented');
    assert.equal(provider.live, false);
    assert.equal(provider.id, 'paystack');

    const described = provider.describe();
    assert.equal(described.provider, 'paystack');
    assert.equal(described.live, false);
    assert.deepEqual(described.operations, {
      implemented: [...PAYSTACK_IMPLEMENTED_OPERATIONS],
      unimplemented: [
        'findSubscription',
        'verifySubscription',
        'synchronizeSubscription',
        'cancelSubscription',
      ],
    });
    // Event normalization is covered by provider-events.test.ts; this build
    // still receives nothing, verifies no signature and confirms no payment.
    assert.deepEqual((described.events as Record<string, unknown>)['receiver'], 'none');
    assert.deepEqual((described.events as Record<string, unknown>)['confirmsPayment'], false);
    assert.deepEqual((described.events as Record<string, unknown>)['grantsExecution'], false);
    assert.equal(JSON.stringify(described).includes(TEST_KEY), false);
  });

  test('every unimplemented operation rejects with a typed error and touches nothing', async () => {
    const { provider, calls } = build({});

    await assert.rejects(() => provider.findSubscription({ provider: 'paystack', userId: USER_ID }), PaystackNotImplementedError);
    await assert.rejects(
      () => provider.verifySubscription({ provider: 'paystack', userId: USER_ID, idempotencyKey: 'a'.repeat(64), requestedAt: '2026-09-22T09:00:00.000Z' }),
      PaystackNotImplementedError,
    );
    await assert.rejects(
      () =>
        provider.synchronizeSubscription({
          provider: 'paystack',
          userId: USER_ID,
          source: 'verification',
          eventIdempotencyKeys: [],
          requestedAt: '2026-09-22T09:00:00.000Z',
        }),
      PaystackNotImplementedError,
    );
    await assert.rejects(
      () =>
        provider.cancelSubscription({
          provider: 'paystack',
          userId: USER_ID,
          providerSubscriptionId: 'SUB_x',
          immediate: false,
          reason: 'user',
          idempotencyKey: 'a'.repeat(64),
          requestedAt: '2026-09-22T09:00:00.000Z',
        }),
      PaystackNotImplementedError,
    );

    assert.equal(calls.length, 0, 'an unimplemented operation never reaches the network');
  });

  test('the customer identity id is deterministic for a (provider, user) pair', async () => {
    const { provider } = build({ responses: [{ status: 200, body: { status: true, data: { customer_code: 'CUS_abc', id: 7, email: 'trader@example.com' } } }] });
    const first = await provider.createCustomer({
      provider: 'paystack',
      userId: USER_ID,
      email: 'trader@example.com',
      idempotencyKey: 'a'.repeat(64),
      requestedAt: '2026-09-22T09:00:00.000Z',
    });
    const second = await provider.createCustomer({
      provider: 'paystack',
      userId: USER_ID,
      email: 'trader@example.com',
      idempotencyKey: 'b'.repeat(64),
      requestedAt: '2026-09-22T09:00:01.000Z',
    });

    assert.equal(first.id, second.id, 'a retried provisioning attempt cannot mint a second local identity');
    assert.equal(first.id, deterministicLocalId('billing-customer', 'paystack', USER_ID));
    assert.equal(first.providerCustomerCode, 'CUS_abc');
    assert.equal(first.providerCustomerId, '7');
    assert.equal(first.status, 'provisioned');
  });
});

describe('Paystack provider — an authorized amount is mandatory', () => {
  test('a checkout without a pricing snapshot is refused before anything is sent', async () => {
    const { provider, calls } = build({});
    const request = { ...checkoutRequest(snapshot()), pricing: undefined };
    await assert.rejects(() => provider.initializeCheckout(request), expectReason('unauthorized_amount'));
    assert.equal(calls.length, 0);
  });

  test('a snapshot for another plan/interval is refused', async () => {
    const { provider, calls } = build({});
    const s = snapshot();
    await assert.rejects(
      () => provider.initializeCheckout({ ...checkoutRequest(s), plan: { cataloguePlan: 'elite', interval: 'annual' } }),
      expectReason('unauthorized_amount'),
    );
    assert.equal(calls.length, 0);
  });

  test('a snapshot quoted for a different reference is refused', async () => {
    const { provider, calls } = build({});
    const s = { ...snapshot(), providerReference: 've-chk-other' };
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(s)), expectReason('unauthorized_amount'));
    assert.equal(calls.length, 0);
  });

  test('a snapshot whose arithmetic does not hold is refused', async () => {
    const { provider, calls } = build({});
    const s = snapshot();
    const tampered = { ...s, payment: { ...s.payment, paymentAmountMinor: s.payment.paymentAmountMinor + 1 } };
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(tampered)), expectReason('unauthorized_amount'));
    assert.equal(calls.length, 0);
  });

  test('a snapshot below the documented minimum is refused', async () => {
    const { provider, calls } = build({});
    // Arithmetically coherent (1500 cents × 0.0005 GHS = 0.75 pesewas, rounded
    // half-up to 1) but below the documented ₵0.10 = 10 pesewas minimum, so no
    // provider call may happen. Built by hand because the pricing boundary
    // itself refuses to PRODUCE such a snapshot.
    const tiny: BillingPricingSnapshot = {
      ...snapshot({ providerPlanId: null }),
      cataloguePlan: 'starter',
      commercialAmountMinor: 1_500,
      payment: { paymentCurrency: 'GHS', paymentAmountMinor: 1, paymentAmountExponent: 2 },
      fx: fx({ fxRateScaled: 5, fxRateScale: 4 }),
    };
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(tiny)), expectReason('unauthorized_amount'));
    assert.equal(calls.length, 0);
  });
});

describe('Paystack provider — the plan epoch decides', () => {
  test('an unregistered provider plan is refused', async () => {
    const s = snapshot({ providerPlanId: 'PLN_unknown' });
    const { provider, calls } = build({ epoch: null });
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(s)), expectReason('plan_not_registered'));
    assert.equal(calls.length, 0);
  });

  test('a retired epoch is refused', async () => {
    const s = snapshot({ providerPlanId: 'PLN_pro_monthly' });
    const { provider, calls } = build({ epoch: epochFor(s, { status: 'retired' }) });
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(s)), expectReason('plan_mismatch'));
    assert.equal(calls.length, 0);
  });

  test('a non-sandbox epoch is refused', async () => {
    const s = snapshot({ providerPlanId: 'PLN_pro_monthly' });
    const { provider, calls } = build({ epoch: epochFor(s, { mode: 'live' }) });
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(s)), expectReason('plan_mismatch'));
    assert.equal(calls.length, 0);
  });

  test('an amount, currency, interval, FX-version or policy mismatch is refused', async () => {
    const cases: Array<[string, Partial<BillingProviderPlan>]> = [
      ['amount', { paymentAmountMinor: BigInt(PRO_MONTHLY_GHS_MINOR) + 1n }],
      ['currency', { paymentCurrency: 'NGN' as never }],
      ['interval', { interval: 'annual' }],
      ['plan', { cataloguePlan: 'elite' }],
      ['fx version', { fxRateVersionId: randomUUID() }],
      ['pricing policy', { pricingPolicyVersion: 'pr3-usd-ghs-v0' }],
      ['provider plan id', { providerPlanId: 'PLN_something_else' }],
    ];

    for (const [label, overrides] of cases) {
      const s = snapshot({ providerPlanId: 'PLN_pro_monthly' });
      const { provider, calls } = build({ epoch: epochFor(s, overrides) });
      await assert.rejects(
        () => provider.initializeCheckout(checkoutRequest(s)),
        expectReason('plan_mismatch'),
        `${label} mismatch must fail closed`,
      );
      assert.equal(calls.length, 0, `${label} mismatch must not reach the provider`);
    }
  });

  test('a user without a provisioned provider customer is refused', async () => {
    const s = snapshot();
    const { provider, calls } = build({ customerProvisioned: false });
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(s)), expectReason('customer_not_provisioned'));
    assert.equal(calls.length, 0);
  });
});

describe('Paystack provider — the provider call', () => {
  test('a plan-bound checkout sends the locked GHS amount, currency, plan and reference', async () => {
    const s = snapshot({ providerPlanId: 'PLN_pro_monthly' });
    const { provider, calls } = build({ epoch: epochFor(s) });

    const session = await provider.initializeCheckout(checkoutRequest(s));

    assert.equal(session.status, 'initialized');
    assert.equal(session.authorizationUrl, 'https://checkout.paystack.com/sandbox');
    assert.equal(session.providerReference, REFERENCE);
    assert.equal(session.amountMinor, 3_900, 'the commercial amount stays USD cents');
    assert.equal(session.currency, 'USD');
    assert.deepEqual(session.payment, { paymentCurrency: 'GHS', paymentAmountMinor: PRO_MONTHLY_GHS_MINOR, paymentAmountExponent: 2 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(calls[0]!.body!.amount, PRO_MONTHLY_GHS_MINOR);
    assert.equal(calls[0]!.body!.currency, 'GHS');
    assert.equal(calls[0]!.body!.plan, 'PLN_pro_monthly');
    assert.equal(calls[0]!.body!.reference, REFERENCE);
    assert.equal(calls[0]!.body!.email, 'trader@example.com');
  });

  test('a one-off (unbound) checkout sends no plan', async () => {
    const s = snapshot({ providerPlanId: null });
    const { provider, calls } = build({});
    const session = await provider.initializeCheckout(checkoutRequest(s));
    assert.equal(session.status, 'initialized');
    assert.equal('plan' in (calls[0]!.body ?? {}), false);
    assert.equal(calls[0]!.body!.amount, PRO_MONTHLY_GHS_MINOR);
  });

  test('a provider rejection is reported as failed, never as initialized', async () => {
    const s = snapshot();
    const { provider } = build({
      responses: [{ status: 400, body: { status: false, message: 'Invalid amount' } }],
    });
    const session = await provider.initializeCheckout(checkoutRequest(s));
    assert.equal(session.status, 'failed');
    assert.equal(session.authorizationUrl, null);
    assert.equal(session.providerReference, null);
  });

  test('an unknown outcome is reported as unavailable, never as initialized', async () => {
    const s = snapshot();
    const { provider } = build({ responses: [{ status: 502, body: { status: false, message: 'bad gateway' } }] });
    const session = await provider.initializeCheckout(checkoutRequest(s));
    assert.equal(session.status, 'unavailable');
    assert.equal(session.authorizationUrl, null);
    assert.equal(session.providerReference, null);
  });

  test('a provider that acknowledges a different reference is a conflict', async () => {
    const s = snapshot();
    const { provider } = build({
      responses: [
        {
          status: 200,
          body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/sandbox', reference: 'not-ours' } },
        },
      ],
    });
    await assert.rejects(() => provider.initializeCheckout(checkoutRequest(s)), expectReason('reference_conflict'));
  });

  test('a non-https callback URL is refused before any call', async () => {
    const s = snapshot();
    const { provider, calls } = build({});
    await assert.rejects(
      () => provider.initializeCheckout({ ...checkoutRequest(s), callbackUrl: 'http://app.example.com/cb' }),
      expectReason('invalid_request'),
    );
    assert.equal(calls.length, 0);
  });

  test('the session it returns satisfies the canonical contract', async () => {
    const s = snapshot();
    const { provider } = build({});
    const session = await provider.initializeCheckout(checkoutRequest(s));
    assert.equal(session.pricing?.pricingPolicyVersion, s.pricingPolicyVersion);
    assert.equal(session.pricing?.fx.fxRateVersionId, FX_VERSION_ID);
    assert.equal(session.pricing?.catalogueVersion, BILLING_CATALOGUE_VERSION);
  });
});

describe('Paystack provider — customers', () => {
  test('findCustomer returns null only for a clearly missing provider customer', async () => {
    const { provider } = build({ responses: [{ status: 404, body: { status: false, message: 'Customer not found' } }] });
    assert.equal(await provider.findCustomer({ provider: 'paystack', userId: USER_ID }), null);
  });

  test('findCustomer surfaces an ambiguous 404 as an error', async () => {
    const { provider } = build({ responses: [{ status: 404, body: { status: false, message: 'Nope' } }] });
    await assert.rejects(() => provider.findCustomer({ provider: 'paystack', userId: USER_ID }), expectReason('ambiguous_not_found'));
  });

  test('findCustomer without a local record or an email is refused without a call', async () => {
    const { provider, calls } = build({ customerProvisioned: false });
    await assert.rejects(() => provider.findCustomer({ provider: 'paystack', userId: USER_ID }), expectReason('invalid_request'));
    assert.equal(calls.length, 0);
  });

  test('a non-canonical request is refused before any call', async () => {
    const { provider, calls } = build({});
    await assert.rejects(
      // `email` must be a real email when supplied; a non-canonical request is a
      // programming error, not something to forward to the provider.
      () => provider.findCustomer({ provider: 'paystack', userId: USER_ID, email: 'not-an-email' } as never),
      expectReason('invalid_request'),
    );
    assert.equal(calls.length, 0);
  });
});
