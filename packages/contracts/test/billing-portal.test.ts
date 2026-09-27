/**
 * Billing Portal v1 — the read-only overview contracts
 * (`packages/contracts/src/billing-portal.ts`).
 *
 * Pins:
 *  - the SIX states are exactly the approved vocabulary, and a facts object is
 *    classified deterministically: `activated` is reachable ONLY from the
 *    durable activation fact, never from a stored `status = 'active'`, a
 *    provider state, verified evidence or a client-shaped input;
 *  - a `status = 'active'` provider-backed row that nothing has verified is
 *    `awaiting_verification`, and one with evidence is
 *    `evidence_awaiting_activation` — never `activated`;
 *  - a non-commercial (`provider IS NULL`) paid row, a row without a coherent
 *    commercial identity, a row flagged for operator review and a row whose
 *    lifecycle no longer carries a paid entitlement are all `unknown`
 *    (nothing is claimed);
 *  - the summary DTO is `.strict()` and MINIMAL: no identity, provider,
 *    reference, hash, idempotency key or pricing field can be added to it, and
 *    the projection cannot carry one through from a facts object;
 *  - a renewal date is published only when the server persisted one — the
 *    module contains no interval arithmetic of any kind;
 *  - `canAccessAutomation` and `grantsExecution` are pinned `false` by type;
 *  - the module knows no provider: no provider name, endpoint, payload field,
 *    credential or transport appears in it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BILLING_PORTAL_STATES,
  BILLING_PORTAL_SUBSCRIPTION_STATES,
  UNAVAILABLE_BILLING_PORTAL_SUMMARY,
  billingPortalSummaryDtoSchema,
  isBillingPortalProjectionError,
  projectBillingPortalSummary,
  resolveBillingPortalState,
  type BillingPortalFacts,
  type BillingPortalState,
} from '../src/index.js';

const PERIOD_END = '2026-10-22T12:00:00.000Z';

/** A well-formed, provider-backed, unverified checkout row. */
function facts(overrides: Partial<BillingPortalFacts> = {}): BillingPortalFacts {
  return {
    subscriptionPresent: true,
    providerBacked: true,
    internalPlan: 'pro',
    commercial: { cataloguePlan: 'pro', interval: 'monthly' },
    lifecycleLive: true,
    activated: false,
    evidenceRecorded: false,
    requiresOperatorReview: false,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

const statesOf = (cases: BillingPortalFacts[]): BillingPortalState[] =>
  cases.map((facts) => resolveBillingPortalState(facts));

/* ========================================================================== */
/* The six states                                                             */
/* ========================================================================== */

describe('Billing Portal v1 — the six states', () => {
  test('the vocabulary is exactly the approved six', () => {
    assert.deepEqual([...BILLING_PORTAL_STATES], [
      'free',
      'awaiting_verification',
      'evidence_awaiting_activation',
      'activated',
      'unknown',
      'unavailable',
    ]);
  });

  test('only the three subscription-bearing states may state a subscription', () => {
    assert.deepEqual([...BILLING_PORTAL_SUBSCRIPTION_STATES], [
      'awaiting_verification',
      'evidence_awaiting_activation',
      'activated',
    ]);
  });

  test('no row at all is the free state (Model C), and a non-commercial free row too', () => {
    assert.deepEqual(
      statesOf([
        facts({ subscriptionPresent: false, providerBacked: false, internalPlan: 'free', commercial: null, lifecycleLive: false }),
        facts({ providerBacked: false, internalPlan: 'free', commercial: null }),
      ]),
      ['free', 'free'],
    );
  });

  test('a provider-backed row is never activated by its stored status, evidence or provider state', () => {
    // `status = 'active'` is what a checkout INSERTs before any money moves:
    // every combination below is a CHECKOUT, not a purchase.
    assert.deepEqual(
      statesOf([
        facts(),
        facts({ evidenceRecorded: true }),
        facts({ providerBacked: true, internalPlan: 'premium', commercial: { cataloguePlan: 'elite', interval: 'annual' } }),
      ]),
      ['awaiting_verification', 'evidence_awaiting_activation', 'awaiting_verification'],
    );
  });

  test('the durable activation fact is the ONLY route to activated', () => {
    const active = projectBillingPortalSummary(facts({
      activated: true,
      evidenceRecorded: true,
      periodEnd: PERIOD_END,
    }));
    assert.equal(active.state, 'activated');
    // Evidence is not required for a recorded activation: the fact is the fact.
    assert.equal(resolveBillingPortalState(facts({ activated: true })), 'activated');
    // …but life-cycle liveness is: a recorded activation whose authoritative
    // lifecycle no longer carries a paid entitlement is NOT stated as paid.
    assert.equal(
      resolveBillingPortalState(facts({ activated: true, lifecycleLive: false })),
      'unknown',
    );
  });

  test('unclassifiable rows are unknown, and claim nothing', () => {
    assert.deepEqual(
      statesOf([
        // A non-commercial row whose internal plan is paid: no payment authority
        // exists for the commercial model, so the portal refuses to confirm it.
        facts({ providerBacked: false, internalPlan: 'premium', commercial: null }),
        // A provider-backed row without a coherent commercial identity.
        facts({ commercial: null }),
        // A row the server flagged for a human decision.
        facts({ requiresOperatorReview: true }),
        // An unactivated row whose authoritative lifecycle is terminal.
        facts({ lifecycleLive: false }),
      ]),
      ['unknown', 'unknown', 'unknown', 'unknown'],
    );
  });

  test('a recorded activation outranks a review flag, but a terminal lifecycle still does not', () => {
    assert.equal(resolveBillingPortalState(facts({ activated: true, requiresOperatorReview: true })), 'activated');
    assert.equal(
      resolveBillingPortalState(facts({ activated: true, requiresOperatorReview: true, lifecycleLive: false })),
      'unknown',
    );
  });
});

/* ========================================================================== */
/* The summary DTO                                                            */
/* ========================================================================== */

describe('Billing Portal v1 — the summary DTO', () => {
  test('the unavailable summary claims nothing and is frozen', () => {
    assert.equal(UNAVAILABLE_BILLING_PORTAL_SUMMARY.state, 'unavailable');
    assert.deepEqual(UNAVAILABLE_BILLING_PORTAL_SUMMARY, {
      state: 'unavailable',
      plan: null,
      periodEnd: null,
      cancelAtPeriodEnd: null,
      canAccessAutomation: false,
      grantsExecution: false,
    });
    assert.equal(Object.isFrozen(UNAVAILABLE_BILLING_PORTAL_SUMMARY), true);
  });

  test('only a stated subscription carries a plan, a period end and a cancellation state', () => {
    // `unavailable` is produced by the API when no summary can be produced at
    // all (the read or the projection failed); it is never a classification of
    // facts, so it is asserted separately below.
    const cases: Array<[BillingPortalState, BillingPortalFacts]> = [
      ['free', facts({ subscriptionPresent: false, providerBacked: false, internalPlan: 'free', commercial: null, lifecycleLive: false })],
      ['awaiting_verification', facts()],
      ['evidence_awaiting_activation', facts({ evidenceRecorded: true })],
      ['activated', facts({ activated: true, periodEnd: PERIOD_END, cancelAtPeriodEnd: true })],
      ['unknown', facts({ commercial: null })],
    ];
    for (const [state, factsForState] of cases) {
      const summary = projectBillingPortalSummary(factsForState);
      assert.equal(summary.state, state);
      const stated = (BILLING_PORTAL_SUBSCRIPTION_STATES as readonly string[]).includes(state);
      assert.equal(summary.plan === null, !stated, `${state} plan presence`);
      if (!stated) {
        assert.equal(summary.periodEnd, null, `${state} period end`);
        assert.equal(summary.cancelAtPeriodEnd, null, `${state} cancellation state`);
      } else {
        assert.deepEqual(summary.plan, { cataloguePlan: 'pro', interval: 'monthly' });
        assert.equal(summary.cancelAtPeriodEnd, state === 'activated');
      }
    }
    // The unavailable answer is the frozen constant, and no facts object
    // classifies into it.
    assert.deepEqual(UNAVAILABLE_BILLING_PORTAL_SUMMARY, {
      state: 'unavailable',
      plan: null,
      periodEnd: null,
      cancelAtPeriodEnd: null,
      canAccessAutomation: false,
      grantsExecution: false,
    });
  });

  test('a renewal date is published only when the server persisted one', () => {
    // The interval is known and the plan is stated, but no period end is stored:
    // the summary reports `null` — no date is derived from `monthly`/`annual`.
    const awaiting = projectBillingPortalSummary(facts({ commercial: { cataloguePlan: 'elite', interval: 'annual' } }));
    assert.equal(awaiting.plan?.interval, 'annual');
    assert.equal(awaiting.periodEnd, null);
    // An activated subscription without a stored period end is the same answer.
    assert.equal(projectBillingPortalSummary(facts({ activated: true })).periodEnd, null);
    // A persisted period end is carried verbatim.
    assert.equal(projectBillingPortalSummary(facts({ activated: true, periodEnd: PERIOD_END })).periodEnd, PERIOD_END);
  });

  test('the module contains no interval arithmetic and no date construction', () => {
    const source = readFileSync(new URL('../src/billing-portal.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      /new Date\(/,
      /Date\.now/,
      /setMonth|setFullYear|setDate|setUTCMonth/,
      /30 \*|365 \*|\bmsPerDay\b/,
      /addMonths|addYears|renewalDate|nextRenewal/i,
    ]) {
      assert.doesNotMatch(source, forbidden, `no renewal date may be computed here (${forbidden})`);
    }
  });

  test('prohibited identity, provider and reusable-material fields are refused', () => {
    const dto = projectBillingPortalSummary(facts({ activated: true, periodEnd: PERIOD_END }));
    for (const extra of [
      { userId: '11111111-1111-4111-8111-111111111111' },
      { customerId: 'CUS_9f8e7d6c5b4a39281706f5e4d3c2b1a0' },
      { subscriptionId: '22222222-2222-4222-8222-222222222222' },
      { provider: 'paystack' },
      { providerState: 'pending' },
      { providerCustomerId: 'CUS_1' },
      { providerSubscriptionCode: 'SUB_1' },
      { providerPlanId: 'PLN_1' },
      { providerReference: `ve-chk-${'a1'.repeat(32)}` },
      { providerTransactionId: '44444444' },
      { emailToken: 'eyJhbGciOi' },
      { authorizationCode: 'AUTH_123456' },
      { accessCode: 'test-code' },
      { cardLast4: '4081' },
      { bin: '408408' },
      { expiry: '12/29' },
      { evidenceHash: 'c'.repeat(64) },
      { idempotencyKey: 'b'.repeat(64) },
      { pricingSnapshot: { commercialAmountMinor: 3900 } },
      { pricingSnapshotId: '33333333-3333-4333-8333-333333333333' },
      { activationId: '44444444-4444-4444-8444-444444444444' },
      { operatorId: 'ops-test-operator' },
      { rawProviderPayload: { status: true } },
      { providerError: 'Charge attempted failed' },
    ]) {
      const parsed = billingPortalSummaryDtoSchema.safeParse({ ...dto, ...extra });
      assert.equal(
        parsed.success,
        false,
        `the summary must refuse the prohibited field: ${Object.keys(extra)[0]}`,
      );
    }
  });

  test('extra facts on a projection input cannot reach the DTO', () => {
    // `readBillingPortalFacts` hands over a structurally typed facts object; the
    // projection reads it field by field, so anything else on it is dropped —
    // which is what keeps a raw provider payload or a leaky column from ever
    // being forwarded.
    const leaky = {
      ...facts({ activated: true }),
      providerReference: `ve-chk-${'a1'.repeat(32)}`,
      rawProviderPayload: { data: { reference: 'x' } },
      failureReason: 'provider exploded',
      evidenceHash: 'c'.repeat(64),
      idempotencyKey: 'b'.repeat(64),
    } as BillingPortalFacts;
    const dto = projectBillingPortalSummary(leaky);
    const serialized = JSON.stringify(dto);
    assert.deepEqual(Object.keys(dto).sort(), [
      'canAccessAutomation',
      'cancelAtPeriodEnd',
      'grantsExecution',
      'periodEnd',
      'plan',
      'state',
    ]);
    for (const marker of ['ve-chk-', 'c'.repeat(64), 'b'.repeat(64), 'provider exploded', 'rawProviderPayload']) {
      assert.doesNotMatch(serialized, new RegExp(marker.replaceAll('-', '\\-')), 'no leak through the projection');
    }
  });

  test('capability pins are literal false and cannot be relaxed', () => {
    const dto = projectBillingPortalSummary(facts({ activated: true }));
    assert.equal(dto.canAccessAutomation, false);
    assert.equal(dto.grantsExecution, false);
    assert.equal(billingPortalSummaryDtoSchema.safeParse({ ...dto, canAccessAutomation: true }).success, false);
    assert.equal(billingPortalSummaryDtoSchema.safeParse({ ...dto, grantsExecution: true }).success, false);
    // A summary can never be mistaken for a billing-state or checkout DTO.
    assert.equal(billingPortalSummaryDtoSchema.safeParse({ ...dto, entitlements: {} }).success, false);
  });

  test('a facts object the DTO cannot represent is refused, never forwarded', () => {
    // `commercial` disagreeing with the state (`activated` with no stated plan)
    // cannot be built through the classifier, so it is injected directly.
    const incoherent = {
      ...facts({ activated: true }),
      commercial: null,
      activated: true,
    } as BillingPortalFacts;
    // The classifier answers `unknown` for a missing commercial identity, so the
    // projection is total here; the refusal path is exercised with a plan the
    // catalogue cannot state.
    assert.equal(projectBillingPortalSummary(incoherent).state, 'unknown');

    const unsellable = {
      ...facts(),
      commercial: { cataloguePlan: 'starter', interval: 'monthly' },
    } as unknown as BillingPortalFacts;
    assert.throws(
      () => projectBillingPortalSummary(unsellable),
      (error: unknown) => isBillingPortalProjectionError(error),
    );
  });
});

/* ========================================================================== */
/* Vocabulary isolation                                                       */
/* ========================================================================== */

describe('Billing Portal v1 — the contract knows no provider and no identity', () => {
  const source = readFileSync(new URL('../src/billing-portal.ts', import.meta.url), 'utf8');

  test('no provider name, endpoint, payload field, credential or transport appears', () => {
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
      /email_token/i,
    ]) {
      assert.doesNotMatch(source, forbidden, `the portal contract must stay provider-neutral (${forbidden})`);
    }
  });

  test('the facts interface cannot even name an identity or a provider field', () => {
    const factsInterface = source.slice(
      source.indexOf('export interface BillingPortalFacts'),
      source.indexOf('/* Facts → state'),
    );
    assert.ok(factsInterface.length > 0, 'the facts interface was located');
    // `providerBacked` is a boolean fact ("a checkout created this row"), not an
    // identity: every field below would be a value the DTO must never carry.
    for (const forbidden of [
      /userId/i,
      /subscriptionId/i,
      /customerId/i,
      /providerCustomer/i,
      /providerSubscription/i,
      /providerPlanId/i,
      /providerReference/i,
      /providerState/i,
      /providerEvent/i,
      /reference/i,
      /hash/i,
      /idempotency/i,
      /pricing/i,
      /snapshot/i,
      /amount/i,
    ]) {
      assert.doesNotMatch(factsInterface, forbidden, `the facts interface must not name ${forbidden}`);
    }
  });
});
