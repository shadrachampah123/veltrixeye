/**
 * Billing Portal v1 — `GET /api/billing/portal` (read-only overview).
 *
 * The tests below pin the two things this surface exists to guarantee:
 *
 *  AUTHORIZATION — the subject is ALWAYS the authenticated session user. An
 *  unauthenticated request is rejected, a browser-supplied `userId`,
 *  `customerId` or `subscriptionId` cannot change whose summary is answered, a
 *  body is refused, and no internal id, provider code, reference, hash,
 *  idempotency key or pricing fact appears in the raw HTTP response.
 *
 *  BILLING TRUTH — the state is derived from server facts only, and `activated`
 *  only from the durable activation fact (Billing Step 8). A stored
 *  `status = 'active'`, a provider state and verified payment evidence all buy
 *  nothing: an unactivated provider-backed row is stated as awaiting
 *  verification or awaiting activation, the entitlement it resolves is still the
 *  free tier, and `canAccessAutomation` stays `false`. A renewal date is shown
 *  only when the server persisted one — it is never calculated from the billing
 *  interval — and a read failure fails closed: `unavailable`, nothing claimed,
 *  no reason published and no billing state changed.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  UNAVAILABLE_BILLING_PORTAL_SUMMARY, billingPortalSummaryDtoSchema,
  billingStateDtoSchema, type BillingPortalSummaryDto,
} from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  insertUser, retireActiveEpochs, seedActivatedSubscription, seedCommercialSubscription,
  seedPaymentEvidence, startBillingTestDb,
} from '../../../packages/core/test/helpers/billing-checkout.js';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let ctx: ReturnType<typeof createAppContext>;
let app: Awaited<ReturnType<typeof buildApp>>;
/** A second app whose `subscriptions` read throws a provider-shaped error. */
let failingApp: Awaited<ReturnType<typeof buildApp>>;

const SESSION_COOKIE = 've_session';

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: db?.dbUrl ?? 'postgres://test:test@localhost/test',
    LOG_LEVEL: 'silent',
    COOKIE_SECURE: 'never',
    ...overrides,
  });
}

/**
 * Fault injection for the fail-closed path: every query behaves normally except
 * the portal's own `subscriptions` read, which throws an error carrying a
 * credential and a raw provider message. Nothing of it may reach the browser.
 */
function failingPool(pool: pg.Pool): pg.Pool {
  const run = pool.query.bind(pool) as (text: string, values?: unknown[]) => Promise<unknown>;
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: unknown, params?: unknown) => {
          if (typeof sql === 'string' && /\bFROM\s+subscriptions\b/i.test(sql)) {
            throw new Error(
              'connect ECONNREFUSED sk_test_0123456789abcdef0123456789abcdef01234567 ' +
              'Charge attempted failed: authorization_code=AUTH_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
            );
          }
          return params === undefined ? run(sql as string) : run(sql as string, params as unknown[]);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as pg.Pool;
}

before(async () => {
  db = await startBillingTestDb(5526);
  const cfg = config();
  ctx = createAppContext(db.pool, cfg);
  app = await buildApp(cfg, ctx);
  await app.ready();
  const failingCfg = config();
  failingApp = await buildApp(failingCfg, createAppContext(failingPool(db.pool), failingCfg));
  await failingApp.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await failingApp?.close();
  await db?.stop();
});

beforeEach(async () => {
  await retireActiveEpochs(db.pool);
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

/** One registered user with a live session cookie. */
async function user(withCustomer = false): Promise<{ id: string; email: string; cookie: string }> {
  const row = await insertUser(db.pool, withCustomer);
  const session = await ctx.sessions.create(row.id, {});
  return { ...row, cookie: `${SESSION_COOKIE}=${session.token}` };
}

const portal = (cookie: string, url = '/api/billing/portal') =>
  app.inject({ method: 'GET', url, headers: cookie === '' ? { 'x-forwarded-for': nextIp() } : { cookie, 'x-forwarded-for': nextIp() } });

/** The route's answer, parsed through the strict DTO. */
async function summary(cookie: string, url = '/api/billing/portal'): Promise<BillingPortalSummaryDto> {
  const res = await portal(cookie, url);
  assert.equal(res.statusCode, 200, res.body);
  return billingPortalSummaryDtoSchema.parse(res.json());
}

const billingMe = (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/billing/me', headers: { cookie, 'x-forwarded-for': nextIp() } });

/** Every token that must never appear in a portal response body. */
const PROHIBITED_TOKENS: ReadonlyArray<[string, RegExp]> = [
  ['provider name', /paystack/i],
  ['credential', /sk_test_|sk_live_|Bearer\b/i],
  ['reusable material', /email_token|authorization_code|access_code|\bpassword\b|\bsecret\b|idempotenc/i],
  ['card/bank data', /card|cvv|\bbin\b|expiry/i],
  ['internal uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i],
  ['hash', /[0-9a-f]{64}/i],
  ['checkout reference', /ve-chk-/],
  ['provider plan code', /PLN_|CUS_|SUB_/],
  ['identity field', /"userId"|"customerId"|"subscriptionId"|"providerCustomer|"providerSubscription/],
  ['provider identity', /"provider"|"providerState"|"providerStatus"|"providerPlanId"|"providerReference"/],
  ['raw error', /"error"|"message"|"reason"|stack|ECONNREFUSED/i],
  ['pricing snapshot', /"pricing"|"amountMinor"|"fx"|"commercialAmount/],
  ['entitlement surface', /"entitlements"|"maxStrategies"/],
];

function assertNoProhibitedTokens(body: string): void {
  for (const [label, pattern] of PROHIBITED_TOKENS) {
    assert.doesNotMatch(body, pattern, `the portal response must not carry ${label} (${pattern})`);
  }
}

const subscriptionRow = async (userId: string) => {
  const { rows } = await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
  return rows[0];
};

/* ========================================================================== */
/* 1. Authorization                                                           */
/* ========================================================================== */

test('an unauthenticated request is rejected and leaks nothing', async () => {
  const res = await portal('');
  assert.equal(res.statusCode, 401, res.body);
  const body = res.json();
  assert.equal(body.error.code, 'unauthorized');
  // No billing fact of any kind is present in a 401.
  assert.equal(body.state, undefined);
  assert.equal(body.plan, undefined);
  assert.equal(body.error.fields, undefined);
  assert.equal(typeof body.error.message, 'string');
  // An invalid/expired session cookie is refused the same way.
  const stale = await app.inject({
    method: 'GET', url: '/api/billing/portal',
    headers: { cookie: `${SESSION_COOKIE}=not-a-real-session`, 'x-forwarded-for': nextIp() },
  });
  assert.equal(stale.statusCode, 401);
});

test('an authenticated user sees only their own billing state', async () => {
  const paying = await user();
  const activated = await seedActivatedSubscription(db.pool, paying.id);
  const free = await user();

  const payingSummary = await summary(paying.cookie);
  assert.equal(payingSummary.state, 'activated');
  assert.deepEqual(payingSummary.plan, { cataloguePlan: activated.cataloguePlan, interval: activated.interval });

  // The free user's answer is free — not the other user's activation.
  const freeSummary = await summary(free.cookie);
  assert.deepEqual(freeSummary, {
    state: 'free',
    plan: null,
    periodEnd: null,
    cancelAtPeriodEnd: null,
    canAccessAutomation: false,
    grantsExecution: false,
  });

  // And the two answers are genuinely different subjects.
  assert.notDeepEqual(payingSummary, freeSummary);
});

test('browser-supplied identity cannot change the subject', async () => {
  const victim = await user();
  await seedActivatedSubscription(db.pool, victim.id);
  const attacker = await user();
  const victimRow = await subscriptionRow(victim.id);
  assert.ok(victimRow, 'the victim has a subscription row');

  // Every identity a browser could try to inject as a query parameter is
  // ignored: the summary stays the CALLER's own (free) state.
  const injected = await summary(
    attacker.cookie,
    `/api/billing/portal?userId=${victim.id}&customerId=${victimRow.billing_customer_id ?? ''}` +
    `&subscriptionId=${victimRow.id}&provider=paystack&state=activated&plan=elite&admin=1`,
  );
  assert.equal(injected.state, 'free');
  assert.equal(injected.plan, null);

  // A request body is not an input channel either: Fastify parses none for a
  // GET, and the route reads none, so an injected body changes nothing.
  for (const payload of [
    { userId: victim.id },
    { customerId: 'CUS_1' },
    { subscriptionId: victimRow.id },
    { state: 'activated' },
  ]) {
    const res = await app.inject({
      method: 'GET', url: '/api/billing/portal',
      headers: { cookie: attacker.cookie, 'x-forwarded-for': nextIp() }, payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(billingPortalSummaryDtoSchema.parse(res.json()).state, 'free', 'the injected body is ignored');
    assertNoProhibitedTokens(res.body);
  }

  // The victim's own summary was never served to the attacker's session.
  assert.deepEqual(await summary(attacker.cookie), {
    state: 'free', plan: null, periodEnd: null, cancelAtPeriodEnd: null,
    canAccessAutomation: false, grantsExecution: false,
  });
  assert.equal((await summary(victim.cookie)).state, 'activated');
});

test('no write verb and no cancellation/invoice/payment-method route exists', async () => {
  const { cookie } = await user();
  // The portal is a READ. Every other verb is absent, and so is every surface
  // this milestone deliberately defers.
  for (const [method, url] of [
    ['POST', '/api/billing/portal'],
    ['PUT', '/api/billing/portal'],
    ['PATCH', '/api/billing/portal'],
    ['DELETE', '/api/billing/portal'],
    ['POST', '/api/billing/cancel'],
    ['POST', '/api/billing/subscription/cancel'],
    ['POST', '/api/billing/subscription'],
    ['DELETE', '/api/billing/subscription'],
    ['GET', '/api/billing/invoices'],
    ['GET', '/api/billing/payment-methods'],
    ['POST', '/api/billing/refund'],
  ] as const) {
    const res = await app.inject({
      method, url, headers: { cookie, 'x-forwarded-for': nextIp() },
      payload: method === 'GET' ? undefined : { reason: 'please' },
    });
    assert.equal(res.statusCode, 404, `${method} ${url} must not exist`);
  }
});

test('a user without billing state receives the free summary and nothing is written', async () => {
  const { id, cookie } = await user();
  const before = await subscriptionRow(id);
  assert.equal(before, undefined, 'Model C: registration writes no subscription');

  assert.deepEqual(await summary(cookie), {
    state: 'free', plan: null, periodEnd: null, cancelAtPeriodEnd: null,
    canAccessAutomation: false, grantsExecution: false,
  });

  // Reading the portal writes nothing at all.
  assert.equal(await subscriptionRow(id), undefined);
  assert.equal((await db.pool.query('SELECT count(*)::int AS c FROM billing_customers WHERE user_id = $1', [id])).rows[0].c, 0);
  assert.equal((await db.pool.query('SELECT count(*)::int AS c FROM billing_subscription_activations WHERE user_id = $1', [id])).rows[0].c, 0);
});

test('internal ids are absent from the response', async () => {
  const owner = await user();
  const activated = await seedActivatedSubscription(db.pool, owner.id);
  const res = await portal(owner.cookie);
  assert.equal(res.statusCode, 200, res.body);

  const summaryDto = billingPortalSummaryDtoSchema.parse(res.json());
  assert.deepEqual(Object.keys(summaryDto).sort(), [
    'canAccessAutomation', 'cancelAtPeriodEnd', 'grantsExecution', 'periodEnd', 'plan', 'state',
  ]);
  assert.deepEqual(Object.keys(summaryDto.plan ?? {}).sort(), ['cataloguePlan', 'interval']);

  const row = await subscriptionRow(owner.id);
  assert.ok(row, 'the row exists and is simply not published');
  const markers = [
    owner.id, owner.email, row.id, activated.subscriptionId, activated.pricingSnapshotId,
    activated.evidenceId, activated.activationId, row.locked_pricing_snapshot_id, row.billing_customer_id,
  ].filter((marker) => typeof marker === 'string' && marker !== '');
  assert.ok(markers.length >= 6, 'the server side really carries this identity');
  for (const marker of markers) {
    assert.doesNotMatch(res.body, new RegExp(marker.replaceAll('-', '\\-')), `the response must not carry ${marker}`);
  }
  assertNoProhibitedTokens(res.body);
});

/* ========================================================================== */
/* 2. Billing truth                                                           */
/* ========================================================================== */

test('a stored status of active alone never produces a paid state', async () => {
  // The checkout shape: `status = 'active'`, `provider_state = 'active'`, no
  // evidence and no activation fact. It is a CHECKOUT, not a purchase.
  const owner = await user(true);
  const commercial = await seedCommercialSubscription(db.pool, owner.id, { providerState: 'active' });
  const row = await subscriptionRow(owner.id);
  assert.equal(row.status, 'active', 'the local status really is active');
  assert.equal(row.provider_state, 'active', 'and the provider state agrees');

  const state = await summary(owner.cookie);
  assert.notEqual(state.state, 'activated');
  assert.equal(state.state, 'awaiting_verification');
  // No renewal claim either: nothing was persisted.
  assert.equal(state.periodEnd, null);
  assert.equal(state.cancelAtPeriodEnd, false, 'the authoritative row states no cancellation');

  // The entitlement authority is unmoved by the row.
  const me = billingStateDtoSchema.parse((await billingMe(owner.cookie)).json());
  assert.equal(me.providerStatus.paymentConfirmed, false);
  assert.equal(me.subscription.plan, 'pro', 'the row records what was checked out…');
  assert.equal(me.entitlements.maxStrategies, 100, '…and the server still enforces the free tier');
  assert.equal(me.entitlements.canAccessAutomation, false);
  assert.equal(commercial.amountMinor > 0, true);
});

test('a non-commercial paid row is unknown, never activated', async () => {
  const owner = await user();
  await db.pool.query(
    `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'premium', 'active')`,
    [owner.id],
  );
  const state = await summary(owner.cookie);
  assert.equal(state.state, 'unknown');
  assert.equal(state.plan, null, 'a historical row has no commercial identity to state');
  assert.equal(state.periodEnd, null);
  assert.equal(state.cancelAtPeriodEnd, null);
  assertNoProhibitedTokens(JSON.stringify(state));
});

test('an unactivated provider-backed subscription is awaiting activation, not activated', async () => {
  const owner = await user(true);
  const commercial = await seedCommercialSubscription(db.pool, owner.id, { providerState: 'pending' });
  const evidence = await seedPaymentEvidence(db.pool, owner.id, commercial);

  const withEvidence = await summary(owner.cookie);
  assert.equal(withEvidence.state, 'evidence_awaiting_activation');
  assert.deepEqual(withEvidence.plan, { cataloguePlan: 'pro', interval: 'monthly' });
  assert.notEqual(withEvidence.state, 'activated');
  assert.equal(evidence.evidenceHash.length, 64);
  // Evidence did not activate anything.
  assert.equal((await db.pool.query('SELECT count(*)::int AS c FROM billing_subscription_activations WHERE user_id = $1', [owner.id])).rows[0].c, 0);
});

test('verified evidence without an activation stays free-entitled', async () => {
  const owner = await user(true);
  const commercial = await seedCommercialSubscription(db.pool, owner.id);
  await seedPaymentEvidence(db.pool, owner.id, commercial);

  const state = await summary(owner.cookie);
  assert.equal(state.state, 'evidence_awaiting_activation');
  assert.equal(state.canAccessAutomation, false);

  const me = billingStateDtoSchema.parse((await billingMe(owner.cookie)).json());
  assert.equal(me.entitlements.maxStrategies, 100, 'evidence is a receipt, never an entitlement');
  assert.equal(me.providerStatus.paymentConfirmed, false);
  assert.equal(me.entitlements.canAccessAutomation, false);

  // …and the free limits are the ones actually enforced.
  await db.pool.query(
    `INSERT INTO strategies (user_id, name, description)
     SELECT $1, 'Evidence S' || i, 'desc' FROM generate_series(1, 100) i`, [owner.id],
  );
  const created = await app.inject({
    method: 'POST', url: '/api/strategies',
    headers: { cookie: owner.cookie, 'x-forwarded-for': nextIp() },
    payload: { name: 'Over the free limit', description: '' },
  });
  assert.equal(created.statusCode, 403, created.body);
});

test('an activated subscription reflects the server-side activation fact', async () => {
  const owner = await user(true);
  const activated = await seedActivatedSubscription(db.pool, owner.id, { cataloguePlan: 'elite', interval: 'annual' });

  const state = await summary(owner.cookie);
  assert.equal(state.state, 'activated');
  assert.deepEqual(state.plan, { cataloguePlan: 'elite', interval: 'annual' });
  assert.equal(state.cancelAtPeriodEnd, false);
  // The activation fact is the authority, and it is on the server, not here.
  assert.equal((await db.pool.query(
    'SELECT count(*)::int AS c FROM billing_subscription_activations WHERE subscription_id = $1',
    [activated.subscriptionId],
  )).rows[0].c, 1);

  // The entitlement side is unchanged by this milestone: an activated
  // provider-backed row resolves the PAID tier, and automation stays OFF.
  const me = billingStateDtoSchema.parse((await billingMe(owner.cookie)).json());
  assert.equal(me.providerStatus.paymentConfirmed, true);
  assert.equal(me.entitlements.maxStrategies, 1000, 'elite (internal premium) limits');
  assert.equal(me.entitlements.canAccessAutomation, false);
});

test('an operator review flag keeps the row out of the live states', async () => {
  const owner = await user(true);
  await seedCommercialSubscription(db.pool, owner.id);
  await db.pool.query(
    `UPDATE subscriptions SET sync_state = 'conflict', sync_required = true, provider_state = 'unknown'
      WHERE user_id = $1`, [owner.id],
  );
  const state = await summary(owner.cookie);
  assert.equal(state.state, 'unknown');
  assert.equal(state.plan, null);
  assert.equal(state.periodEnd, null);
});

test('a missing renewal date remains unavailable, and is never inferred from the interval', async () => {
  const owner = await user(true);
  await seedActivatedSubscription(db.pool, owner.id, { cataloguePlan: 'pro', interval: 'annual' });

  const res = await portal(owner.cookie);
  assert.equal(res.statusCode, 200, res.body);
  const state = billingPortalSummaryDtoSchema.parse(res.json());
  assert.equal(state.state, 'activated');
  assert.equal(state.plan?.interval, 'annual', 'the interval is stated…');
  assert.equal(state.periodEnd, null, '…and no renewal date is derived from it');
  // No date of any shape appears: an interval is not a schedule.
  assert.doesNotMatch(res.body, /\d{4}-\d{2}-\d{2}/, 'no date is fabricated anywhere in the answer');

  // A consumer reading the billing state sees the same absence.
  const me = billingStateDtoSchema.parse((await billingMe(owner.cookie)).json());
  assert.equal(me.subscription.currentPeriodEnd, null);
});

test('a persisted period end and cancellation state are published verbatim', async () => {
  const owner = await user(true);
  await seedActivatedSubscription(db.pool, owner.id);
  const periodEnd = '2026-10-22T12:00:00.000Z';
  await db.pool.query(
    `UPDATE subscriptions SET current_period_start = $2, current_period_end = $3, cancel_at_period_end = true
      WHERE user_id = $1`,
    [owner.id, '2026-09-22T12:00:00.000Z', periodEnd],
  );

  const state = await summary(owner.cookie);
  assert.equal(state.state, 'activated');
  assert.equal(state.periodEnd, periodEnd, 'the stored period end, unmodified');
  assert.equal(state.cancelAtPeriodEnd, true, 'the authoritative cancellation state');
  assertNoProhibitedTokens(JSON.stringify(state));
});

test('canAccessAutomation remains false in every state and on every plan', async () => {
  const free = await user();
  const pending = await user(true);
  await seedCommercialSubscription(db.pool, pending.id);
  const activatedPro = await user(true);
  await seedActivatedSubscription(db.pool, activatedPro.id, { cataloguePlan: 'pro' });
  const activatedElite = await user(true);
  await seedActivatedSubscription(db.pool, activatedElite.id, { cataloguePlan: 'elite', interval: 'annual' });

  for (const u of [free, pending, activatedPro, activatedElite]) {
    const state = await summary(u.cookie);
    assert.equal(state.canAccessAutomation, false, `portal pins automation off (${state.state})`);
    assert.equal(state.grantsExecution, false, `portal pins execution off (${state.state})`);
    const me = billingStateDtoSchema.parse((await billingMe(u.cookie)).json());
    assert.equal(me.entitlements.canAccessAutomation, false, `enforcement keeps automation off (${state.state})`);
  }
});

/* ========================================================================== */
/* 3. Sensitive-field boundary                                                */
/* ========================================================================== */

test('prohibited provider and internal fields are absent from the raw HTTP response', async () => {
  const owner = await user(true);
  const activated = await seedActivatedSubscription(db.pool, owner.id);

  // Put recognizable markers on every sensitive column the row actually has,
  // plus a provider-event ledger row, so a leak would be visible in the body.
  const markers = {
    providerReference: `ve-chk-${'a1'.repeat(32)}`,
    providerPlanId: 'PLN_9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    providerSubscriptionCode: 'SUB_5a1f0c9e2b7d4bad9bdd2b0d7b3dcb6d',
    lastEventIdempotencyKey: 'b'.repeat(64),
  };
  await db.pool.query(
    `UPDATE subscriptions
        SET provider_reference = $2, provider_plan_id = $3,
            provider_subscription_code = $4, last_event_idempotency_key = $5
      WHERE user_id = $1`,
    [owner.id, markers.providerReference, markers.providerPlanId, markers.providerSubscriptionCode, markers.lastEventIdempotencyKey],
  );
  await db.pool.query(
    `INSERT INTO billing_provider_events (event_type, idempotency_key, payload_hash, subscription_id, user_id,
       provider_reference, status, failure_reason)
     VALUES ('payment.succeeded', $2, $3, $4, $1, $5, 'received', 'upstream said Charge attempted failed')`,
    [owner.id, 'c'.repeat(64), 'd'.repeat(64), activated.subscriptionId, 'REF_RAW_PROVIDER_PAYLOAD'],
  );

  const res = await portal(owner.cookie);
  assert.equal(res.statusCode, 200, res.body);
  for (const marker of [
    ...Object.values(markers),
    'REF_RAW_PROVIDER_PAYLOAD', 'upstream said',
    activated.subscriptionId, activated.evidenceId, activated.activationId, activated.pricingSnapshotId,
    owner.id, owner.email,
  ]) {
    assert.doesNotMatch(res.body, new RegExp(marker.replaceAll('-', '\\-')), `the portal response must not carry ${marker}`);
  }
  assertNoProhibitedTokens(res.body);
});

test('a raw provider or webhook payload cannot reach the portal DTO', async () => {
  const owner = await user(true);
  const commercial = await seedCommercialSubscription(db.pool, owner.id);
  await seedPaymentEvidence(db.pool, owner.id, commercial, { providerReference: commercial.reference });
  // The ledger stores a payload HASH, never a payload — a marker written into
  // every text column it does have still must not surface.
  await db.pool.query(
    `INSERT INTO billing_provider_events (event_type, idempotency_key, payload_hash, subscription_id, user_id,
       provider_reference, status)
     VALUES ('subscription.activated', $2, $3, $4, $1, 'RAW_EVENT_PAYLOAD_MARKER', 'received')`,
    [owner.id, 'e'.repeat(64), 'f'.repeat(64), commercial.subscriptionId],
  );

  const state = await summary(owner.cookie);
  assert.equal(state.state, 'evidence_awaiting_activation');
  assert.doesNotMatch(JSON.stringify(state), /RAW_EVENT_PAYLOAD_MARKER|payload|failure/i);
  // A provider event is not an activation: the state did not move.
  assert.notEqual(state.state, 'activated');
});

/* ========================================================================== */
/* 4. Failure handling                                                        */
/* ========================================================================== */

test('a billing read failure fails closed: unavailable, nothing claimed', async () => {
  const owner = await user(true);
  await seedActivatedSubscription(db.pool, owner.id);
  const session = await ctx.sessions.create(owner.id, {});
  const cookie = `${SESSION_COOKIE}=${session.token}`;

  const res = await failingApp.inject({
    method: 'GET', url: '/api/billing/portal',
    headers: { cookie, 'x-forwarded-for': nextIp() },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), UNAVAILABLE_BILLING_PORTAL_SUMMARY);
  const state = billingPortalSummaryDtoSchema.parse(res.json());
  assert.equal(state.state, 'unavailable');
  assert.equal(state.plan, null, 'no plan is claimed when the read failed');
  assert.equal(state.periodEnd, null, 'no renewal date is claimed');
  assert.equal(state.cancelAtPeriodEnd, null, 'no cancellation state is claimed');
  assert.equal(state.canAccessAutomation, false);
});

test('a failure neither leaks the error nor changes billing state', async () => {
  const owner = await user(true);
  await seedActivatedSubscription(db.pool, owner.id);
  const session = await ctx.sessions.create(owner.id, {});
  const cookie = `${SESSION_COOKIE}=${session.token}`;

  const snapshot = async () => ({
    subscriptions: (await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [owner.id])).rows,
    activations: (await db.pool.query(
      'SELECT id, subscription_id, activated_at FROM billing_subscription_activations WHERE user_id = $1', [owner.id],
    )).rows,
    evidence: (await db.pool.query(
      'SELECT id, provider_reference, verified_at FROM billing_verified_transactions WHERE user_id = $1', [owner.id],
    )).rows,
    audit: (await db.pool.query(
      'SELECT action, count(*)::int AS c FROM audit_events WHERE user_id = $1 GROUP BY action ORDER BY action', [owner.id],
    )).rows,
  });
  const before = await snapshot();

  const res = await failingApp.inject({
    method: 'GET', url: '/api/billing/portal',
    headers: { cookie, 'x-forwarded-for': nextIp() },
  });
  assert.equal(res.statusCode, 200, res.body);
  // The failure response carries no credential, no provider message, no reason
  // and no internal detail: only the unavailable summary.
  assertNoProhibitedTokens(res.body);
  assert.doesNotMatch(res.body, /sk_test_|ECONNREFUSED|Charge attempted|AUTH_9f8e/i);

  assert.deepEqual(await snapshot(), before, 'a failed read changes nothing');
  // And the portal still answers correctly once the read works again.
  assert.equal((await summary(cookie)).state, 'activated');
});

test('a row without a statable commercial identity is unknown, never a guess', async () => {
  const owner = await user();
  // A provider-backed row whose commercial identity is incomplete (a commercial
  // plan with no interval): the portal cannot state a plan, so it states nothing
  // at all. Built directly because a LOCKED row can never lose its identity —
  // the pricing-lock constraint refuses that, which is the point of the lock.
  await db.pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, provider, catalogue_plan, provider_state)
     VALUES ($1, 'pro', 'active', 'paystack', 'pro', 'pending')`,
    [owner.id],
  );
  const state = await summary(owner.cookie);
  assert.equal(state.state, 'unknown');
  assert.equal(state.plan, null);
  assert.equal(state.periodEnd, null);
  assert.equal(state.cancelAtPeriodEnd, null);

  // A non-commercial row whose internal plan is paid has no payment authority
  // in the commercial model either.
  const historical = await user();
  await db.pool.query(
    "INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'pro', 'trialing')", [historical.id],
  );
  assert.equal((await summary(historical.cookie)).state, 'unknown');
});
