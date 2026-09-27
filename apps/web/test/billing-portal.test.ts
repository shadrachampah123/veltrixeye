/**
 * Billing Portal v1 — the read-only billing overview (`/settings`).
 *
 * These tests pin what the surface promises and what it must never become:
 *  - the SIX states stay visibly distinct (free, awaiting payment verification,
 *    evidence awaiting operator activation, activated, unknown, unavailable),
 *    including the failed-read state, which is never presented as free or as an
 *    in-flight read;
 *  - a plan and an interval are rendered only when the server derived them, and
 *    renewal information only when the server persisted a period end — a missing
 *    one renders "Unavailable" copy, and no date is ever fabricated from an
 *    interval;
 *  - the card is strictly read-only: no button, no link, no form, no input, no
 *    cancel/upgrade/downgrade/edit affordance and no API call of any kind;
 *  - no provider or internal identifier can appear in the markup (the DTO
 *    carries none, and the API client FAILS CLOSED on a response that adds one).
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BILLING_PORTAL_STATES,
  UNAVAILABLE_BILLING_PORTAL_SUMMARY,
  billingPortalSummaryDtoSchema,
  type BillingPortalSummaryDto,
} from '@veltrixeye/contracts';
import { api } from '../lib/api';
import { BILLING_PORTAL_STATE_COPY, BillingPortalPanel } from '../components/billing-portal';

const PERIOD_END = '2026-10-22T12:00:00.000Z';

/** A summary produced by the same strict DTO the API sends. */
function summary(overrides: Partial<BillingPortalSummaryDto> = {}): BillingPortalSummaryDto {
  return billingPortalSummaryDtoSchema.parse({
    state: 'free',
    plan: null,
    periodEnd: null,
    cancelAtPeriodEnd: null,
    canAccessAutomation: false,
    grantsExecution: false,
    ...overrides,
  });
}

const free = () => summary();

const awaitingVerification = (): BillingPortalSummaryDto =>
  summary({ state: 'awaiting_verification', plan: { cataloguePlan: 'pro', interval: 'monthly' }, cancelAtPeriodEnd: false });

const evidenceAwaitingActivation = (): BillingPortalSummaryDto =>
  summary({ state: 'evidence_awaiting_activation', plan: { cataloguePlan: 'pro', interval: 'monthly' }, cancelAtPeriodEnd: false });

const activated = (overrides: Partial<BillingPortalSummaryDto> = {}): BillingPortalSummaryDto =>
  summary({
    state: 'activated',
    plan: { cataloguePlan: 'elite', interval: 'annual' },
    periodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    ...overrides,
  });

const unknownState = () => summary({ state: 'unknown' });

const render = (portal: BillingPortalSummaryDto | null, props: { unavailable?: boolean } = {}): string =>
  renderToStaticMarkup(React.createElement(BillingPortalPanel, { portal, ...props }));

const componentSource = readFileSync(
  fileURLToPath(new URL('../components/billing-portal.tsx', import.meta.url)),
  'utf8',
);

/* ========================================================================== */
/* The six states                                                             */
/* ========================================================================== */

describe('Billing Portal v1 — the six states stay distinct', () => {
  test('the copy exists for exactly the six approved states, each with its own label and explanation', () => {
    assert.deepEqual(Object.keys(BILLING_PORTAL_STATE_COPY).sort(), [...BILLING_PORTAL_STATES].sort());
    const labels = Object.values(BILLING_PORTAL_STATE_COPY).map((copy) => copy.label);
    assert.equal(new Set(labels).size, labels.length, 'no two states share a label');
    const bodies = Object.values(BILLING_PORTAL_STATE_COPY).map((copy) => copy.body);
    assert.equal(new Set(bodies).size, bodies.length, 'no two states share an explanation');
  });

  test('each state renders its own badge and nothing of the others', () => {
    const cases: Array<[BillingPortalSummaryDto | null, string, { unavailable?: boolean }?]> = [
      [free(), 'free plan'],
      [awaitingVerification(), 'awaiting payment verification'],
      [evidenceAwaitingActivation(), 'evidence recorded · awaiting operator activation'],
      [activated(), 'activated'],
      [unknownState(), 'billing state unknown'],
      [UNAVAILABLE_BILLING_PORTAL_SUMMARY, 'billing unavailable'],
      [null, 'billing unavailable', { unavailable: true }],
    ];
    const rendered = cases.map(([portal, label, props]) => {
      const markup = render(portal, props ?? {});
      assert.match(markup, new RegExp(label.replace('·', '·')), `renders the "${label}" state`);
      assert.match(markup, /Billing Overview/, 'the card is the billing overview');
      return markup;
    });
    // The six answers are genuinely different screens, not one screen with a
    // different word in it.
    assert.equal(new Set(rendered).size, rendered.length);
  });

  test('free — no plan, no renewal and no cancellation state is claimed', () => {
    const markup = render(free());
    assert.match(markup, /free plan/);
    assert.match(markup, /Not stated/, 'the plan is not stated');
    assert.match(markup, /Unavailable/, 'renewal information is unavailable');
    assert.doesNotMatch(markup, /Pro|Elite/, 'no commercial plan is invented');
    assert.doesNotMatch(markup, /20\d\d/, 'no date appears');
  });

  test('awaiting verification — a provider-backed checkout is never shown as paid', () => {
    const markup = render(awaitingVerification());
    assert.match(markup, /awaiting payment verification/);
    assert.match(markup, /Pro · monthly/, 'the server-derived plan and interval are shown');
    assert.match(markup, /not a payment/, 'the copy says what a checkout status is');
    assert.doesNotMatch(markup, />activated</, 'a checkout is not an activation');
    assert.match(markup, /Unavailable/, 'no renewal date is claimed');
  });

  test('evidence awaiting activation — a receipt is stated as a receipt', () => {
    const markup = render(evidenceAwaitingActivation());
    assert.match(markup, /Evidence is a receipt, never an activation/);
    assert.match(markup, /free entitlement/, 'the entitlement consequence is stated');
    assert.doesNotMatch(markup, />activated</);
    assert.match(markup, /canAccessAutomation/, 'the automation pin is stated');
    assert.match(markup, /false/);
  });

  test('activated — the server-side activation, its plan and its stored period end', () => {
    const markup = render(activated());
    assert.match(markup, />activated</);
    assert.match(markup, /Elite · annual/, 'the commercial plan and interval come from the server');
    assert.match(markup, /2026/, 'the persisted period end is rendered');
    assert.match(markup, /Not scheduled to cancel/, 'the authoritative cancellation state is rendered');
    assert.match(markup, /automation, live execution and broker execution stay unavailable/i);
  });

  test('unknown — nothing is claimed when the server cannot classify the record', () => {
    const markup = render(unknownState());
    assert.match(markup, /billing state unknown/);
    assert.match(markup, /Nothing is claimed here/);
    assert.match(markup, /Not stated/, 'no plan is stated');
    assert.match(markup, /Unavailable/, 'no renewal date is stated');
    assert.doesNotMatch(markup, /20\d\d/);
    assert.doesNotMatch(markup, />activated</);
  });

  test('unavailable — a failed read is its own state, never free and never "loading"', () => {
    const failed = render(null, { unavailable: true });
    assert.match(failed, /billing unavailable/);
    assert.match(failed, /could not be read/);
    assert.doesNotMatch(failed, /Loading billing overview/, 'a failure is not an in-flight read');
    assert.doesNotMatch(failed, /free plan/, 'a failure is not the free state');
    assert.doesNotMatch(failed, />activated</);
    assert.doesNotMatch(failed, /20\d\d/);

    // The same rendering for a server-answered unavailable summary.
    const answered = render(UNAVAILABLE_BILLING_PORTAL_SUMMARY);
    assert.match(answered, /billing unavailable/);
    assert.match(answered, /Not stated/);

    // In flight is neither.
    const loading = render(null);
    assert.match(loading, /Loading billing overview/);
    assert.doesNotMatch(loading, /billing unavailable/);
  });
});

/* ========================================================================== */
/* Renewal information                                                        */
/* ========================================================================== */

describe('Billing Portal v1 — renewal information', () => {
  test('a missing renewal date renders unavailable copy, and no date is invented', () => {
    for (const state of ['awaiting_verification', 'evidence_awaiting_activation', 'activated'] as const) {
      const markup = render(summary({
        state,
        plan: { cataloguePlan: 'pro', interval: 'annual' },
        periodEnd: null,
        cancelAtPeriodEnd: false,
      }));
      assert.match(markup, /Unavailable/, `${state}: the renewal date is unavailable`);
      assert.doesNotMatch(markup, /20\d\d/, `${state}: no date is rendered`);
      assert.match(markup, /annual/, `${state}: the interval is still stated, and is not used as a schedule`);
      assert.match(markup, /does not (calculate|infer)/, `${state}: the copy says so explicitly`);
    }
  });

  test('a stored period end is rendered verbatim when the server persisted one', () => {
    const markup = render(activated());
    assert.match(markup, /2026/);
    assert.doesNotMatch(markup, /Unavailable/);
  });
});

/* ========================================================================== */
/* Read-only: no control of any kind                                          */
/* ========================================================================== */

describe('Billing Portal v1 — strictly read-only', () => {
  const everyState = (): BillingPortalSummaryDto[] => [
    free(), awaitingVerification(), evidenceAwaitingActivation(), activated(), unknownState(),
    UNAVAILABLE_BILLING_PORTAL_SUMMARY,
  ];

  test('there is no cancellation control, and no control of any kind', () => {
    for (const portal of [...everyState(), null]) {
      const markup = render(portal, portal === null ? { unavailable: true } : {});
      assert.doesNotMatch(markup, /<button/i, 'no button');
      assert.doesNotMatch(markup, /<a[\s>]/i, 'no link');
      assert.doesNotMatch(markup, /<form|<input|<select|<textarea/i, 'no form control');
      assert.doesNotMatch(markup, /onclick|onchange|onsubmit/i, 'no event handler is rendered');
      assert.doesNotMatch(markup, /cancel subscription|cancel plan|end subscription/i, 'no cancellation action');
      assert.doesNotMatch(markup, /verify payment|create sandbox checkout/i, 'the checkout actions live elsewhere');
    }
    // The component holds no handler and no API client at all.
    assert.doesNotMatch(componentSource, /onClick|onChange|onSubmit|<button|<form|<input/, 'no interactive element in the source');
    assert.doesNotMatch(componentSource, /\bapi\.\w|\bfetch\s*\(|from '@\/lib\/api'/, 'the panel performs no API call');
  });

  test('there is no invoice, payment-method or subscription-editing affordance', () => {
    for (const portal of everyState()) {
      const markup = render(portal);
      for (const forbidden of [
        /invoice/i, /payment method|card|bank account|cvv|expiry/i,
        /upgrade|downgrade|change plan|edit plan|edit subscription|modify subscription/i,
        /refund|proration|dunning/i,
      ]) {
        assert.doesNotMatch(markup, forbidden, `no ${forbidden} affordance`);
      }
    }
  });

  test('the panel is display-only: props in, markup out', () => {
    assert.doesNotMatch(componentSource, /useEffect|setInterval|setTimeout|addEventListener/, 'no effects, polling or timers');
    assert.doesNotMatch(componentSource, /useState/, 'no local mutable state');
  });
});

/* ========================================================================== */
/* No provider or internal identity                                           */
/* ========================================================================== */

describe('Billing Portal v1 — no provider or internal identity', () => {
  test('no provider name, code, reference, hash or id can appear in the markup', () => {
    for (const portal of [
      free(), awaitingVerification(), evidenceAwaitingActivation(), activated({ cancelAtPeriodEnd: true }), unknownState(),
      UNAVAILABLE_BILLING_PORTAL_SUMMARY,
    ]) {
      const markup = render(portal);
      for (const forbidden of [
        /paystack/i, /PLN_|CUS_|SUB_|REF_/, /ve-chk-/, /sk_test_|sk_live_/i,
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i, /[0-9a-f]{64}/i,
        /provider/i, /email/i, /@/, /customer/i, /subscription id|user id/i,
      ]) {
        assert.doesNotMatch(markup, forbidden, `the markup must not carry ${forbidden}`);
      }
    }
    assert.doesNotMatch(componentSource, /paystack|PLN_|CUS_|ve-chk-|providerReference/, 'and neither does the source');
  });

  test('the DTO the panel renders cannot even be built with an identity field', () => {
    const dto = activated();
    for (const extra of [
      { subscriptionId: '22222222-2222-4222-8222-222222222222' },
      { providerCustomerCode: 'CUS_9f8e' },
      { providerReference: `ve-chk-${'a1'.repeat(32)}` },
      { evidenceHash: 'c'.repeat(64) },
      { idempotencyKey: 'b'.repeat(64) },
      { emailToken: 'eyJhbGciOi' },
    ]) {
      assert.equal(
        billingPortalSummaryDtoSchema.safeParse({ ...dto, ...extra }).success,
        false,
        `the DTO refuses ${Object.keys(extra)[0]}`,
      );
    }
  });
});

/* ========================================================================== */
/* The API client                                                             */
/* ========================================================================== */

describe('Billing Portal v1 — the API client', () => {
  let calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let originalFetch: typeof globalThis.fetch;
  let respond: () => Response;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return respond();
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('it reads the portal with a body-less GET and returns the parsed summary', async () => {
    respond = () => json(activated());
    const result = await api.getBillingPortalSummary();
    assert.deepEqual(result, activated());
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/billing/portal');
    assert.equal(calls[0]?.init?.method, undefined, 'a GET, and nothing else');
    assert.equal(calls[0]?.init?.body, undefined, 'no body: the subject is the session');
    assert.equal(new Headers(calls[0]?.init?.headers).get('content-type'), null, 'and no empty JSON body');
  });

  test('it fails closed when a response carries an identity, provider or error field', async () => {
    for (const leak of [
      { subscriptionId: '22222222-2222-4222-8222-222222222222' },
      { providerCustomerCode: 'CUS_9f8e7d6c5b4a39281706f5e4d3c2b1a0' },
      { providerReference: `ve-chk-${'a1'.repeat(32)}` },
      { providerPlanId: 'PLN_5a1f0c9e' },
      { evidenceHash: 'c'.repeat(64) },
      { idempotencyKey: 'b'.repeat(64) },
      { emailToken: 'eyJhbGciOi' },
      { providerError: 'Charge attempted failed' },
      { pricingSnapshot: { commercialAmountMinor: 3900 } },
      { entitlements: { maxStrategies: 500 } },
    ]) {
      respond = () => json({ ...activated(), ...leak });
      await assert.rejects(
        () => api.getBillingPortalSummary(),
        `the client must refuse a response carrying ${Object.keys(leak)[0]}`,
      );
    }
  });

  test('it surfaces a failed read as an error rather than as a fabricated summary', async () => {
    respond = () => json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
    await assert.rejects(() => api.getBillingPortalSummary(), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 401);
      return true;
    });
  });
});
