import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { subscriptionSyncResultSchema } from '@veltrixeye/contracts';
import {
  BillingPricingSnapshotStore, FREE_ENTITLEMENTS, billingCheckoutReference,
} from '@veltrixeye/core';
import { createPaystackProvider } from '@veltrixeye/provider-paystack';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { paystackCustomerDirectory, paystackPlanDirectory } from '../src/billing-composition.js';
import { BILLING_SYNC_RATE_LIMIT_MAX } from '../src/routes/billing.js';
import {
  AS_OF, deriveSnapshot, insertEpoch, insertUser, retireActiveEpochs, startBillingTestDb,
} from '../../../packages/core/test/helpers/billing-checkout.js';

/* ==========================================================================
   Later-billing-PR #7 — POST /api/billing/sync (sandbox only).

   The ACTUAL Paystack sandbox adapter with an entirely fake transport: the
   route verifies the caller's own checkout reference through the documented
   transaction-verify read, and — because that response publishes no
   subscription status — every verified state is `unknown` (manual review).
   ========================================================================== */

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let ctx: ReturnType<typeof createAppContext>;
let app: Awaited<ReturnType<typeof buildApp>>;
let bare: Awaited<ReturnType<typeof buildApp>>;
let bareCtx: ReturnType<typeof createAppContext>;
let calls: { url: string; method: string; body: string | undefined }[];
let respond: (url: string) => { status: number; body: unknown };
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

const config = () => loadConfig({
  NODE_ENV: 'test', DATABASE_URL: db?.dbUrl ?? 'postgres://test:test@localhost/test',
  LOG_LEVEL: 'silent', COOKIE_SECURE: 'never',
  PUBLIC_APPLICATION_ORIGIN: 'https://app.example.test',
});

const verified = (reference: string, customerCode: string, overrides: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    status: true,
    message: 'Verification successful',
    data: {
      id: 4099260516, domain: 'test', status: 'success', reference, amount: 48_750, currency: 'GHS',
      paid_at: '2026-09-22T12:01:00.000Z', gateway_response: 'Successful',
      authorization: { authorization_code: 'AUTH_neverstored', last4: '4081', reusable: true },
      customer: { id: 181873746, email: 'demo@test.com', customer_code: customerCode },
      plan: null, ...overrides,
    },
  },
});

before(async () => {
  db = await startBillingTestDb(5499);
  const cfg = config();
  ctx = createAppContext(db.pool, cfg);
  ctx.billingProviders.register(createPaystackProvider({
    secretKey: 'sk_test_0123456789abcdef0123456789abcdef01234567', timeoutMs: 1000,
    customers: paystackCustomerDirectory(db.pool),
    plans: paystackPlanDirectory(db.pool),
    clock: () => AS_OF,
    fetchFn: async (url, init) => {
      calls.push({ url, method: init.method, body: init.body });
      const response = respond(url);
      return { status: response.status, json: async () => response.body };
    },
  }));
  app = await buildApp(cfg, ctx);
  await app.ready();
  // A second app with NO provider registered (no sandbox key configured).
  bareCtx = createAppContext(db.pool, cfg);
  bare = await buildApp(cfg, bareCtx);
  await bare.ready();
}, { timeout: 180_000 });
after(async () => { await app?.close(); await bare?.close(); await db?.stop(); });
beforeEach(() => {
  calls = [];
  respond = () => ({ status: 500, body: { status: false, message: 'unexpected call' } });
});

async function providerBackedUser(target = ctx) {
  await retireActiveEpochs(db.pool);
  const facts = await insertEpoch(db.pool);
  const snapshot = deriveSnapshot(facts);
  const stored = await new BillingPricingSnapshotStore(db.pool).create(snapshot);
  const user = await insertUser(db.pool, true);
  const { rows } = await db.pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, catalogue_plan, billing_interval, currency,
       provider, provider_plan_id, provider_state, locked_pricing_snapshot_id)
     VALUES ($1, 'pro', 'active', 'pro', 'monthly', 'USD', 'paystack', $2, 'pending', $3) RETURNING id`,
    [user.id, snapshot.providerPlanId, stored.id],
  );
  const customer = await db.pool.query('SELECT provider_customer_code FROM billing_customers WHERE user_id = $1', [user.id]);
  const session = await target.sessions.create(user.id, {});
  return {
    userId: user.id,
    subscriptionId: rows[0]!.id as string,
    cookie: `ve_session=${session.token}`,
    reference: billingCheckoutReference(user.id, stored.idempotencyKey),
    customerCode: customer.rows[0]!.provider_customer_code as string,
  };
}

const sync = (cookie: string, options: { payload?: unknown; target?: typeof app; ip?: string } = {}) =>
  (options.target ?? app).inject({
    method: 'POST', url: '/api/billing/sync', headers: { cookie },
    remoteAddress: options.ip ?? nextIp(),
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });

const subscriptionRow = async (id: string) =>
  (await db.pool.query('SELECT * FROM subscriptions WHERE id = $1', [id])).rows[0] as Record<string, unknown>;

describe('PR #7 route — authentication and payload', () => {
  test('requires a session: 401, no provider call, nothing written', async () => {
    const fixture = await providerBackedUser();
    const before = await subscriptionRow(fixture.subscriptionId);
    for (const cookie of ['', 've_session=not-a-real-session']) {
      const result = await sync(cookie);
      assert.equal(result.statusCode, 401, result.body);
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await subscriptionRow(fixture.subscriptionId), before);
  });

  test('accepts no payload: a client cannot name a user, a reference or a provider fact', async () => {
    const fixture = await providerBackedUser();
    const before = await subscriptionRow(fixture.subscriptionId);
    for (const payload of [
      { userId: randomUUID() }, { reference: fixture.reference }, { state: 'active' },
      { observed: { state: 'active' } }, { plan: 'premium' }, [1],
    ]) {
      const result = await sync(fixture.cookie, { payload });
      assert.equal(result.statusCode, 400, `${JSON.stringify(payload)}: ${result.body}`);
      assert.equal(result.json().error.code, 'invalid_input');
    }
    assert.equal(calls.length, 0);
    assert.deepEqual(await subscriptionRow(fixture.subscriptionId), before);
  });
});

describe('PR #7 route — canonical response through the real sandbox adapter', () => {
  test('verifies the caller\'s own reference; the published verify shape yields unknown → manual review', async () => {
    const fixture = await providerBackedUser();
    respond = () => verified(fixture.reference, fixture.customerCode);
    const before = await subscriptionRow(fixture.subscriptionId);

    for (const payload of [undefined, {}]) {
      calls = [];
      const result = await sync(fixture.cookie, { payload });
      assert.equal(result.statusCode, 200, result.body);
      const body = subscriptionSyncResultSchema.parse(result.json());
      assert.deepEqual(result.json(), body, 'exactly the canonical SubscriptionSyncResult');
      assert.equal(body.userId, fixture.userId);
      assert.equal(body.subscriptionId, fixture.subscriptionId);
      assert.equal(body.outcome, 'requires_manual_review');
      assert.equal(body.providerState, 'unknown');
      assert.equal(body.requiresManualReview, true);
      assert.equal(body.toStatus, null);
      assert.equal(body.fromStatus, 'active');
      assert.equal(body.planChanged, false);
      assert.equal(body.entitlementsChanged, false);
      assert.equal(body.grantsExecution, false);

      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.method, 'GET');
      assert.equal(calls[0]!.url, `https://api.paystack.co/transaction/verify/${fixture.reference}`);
      assert.equal(calls[0]!.body, undefined);
      assert.ok(!result.body.includes('AUTH_'), 'no provider payload reaches the response');
      assert.ok(!result.body.includes('4081'));
    }

    const afterRow = await subscriptionRow(fixture.subscriptionId);
    assert.equal(afterRow.status, before.status, 'status never moves on an unknown state');
    assert.equal(afterRow.plan, before.plan, 'plan byte-identical');
    assert.equal(afterRow.provider_state, 'unknown');
    assert.equal(afterRow.sync_state, 'conflict');
    assert.equal(afterRow.sync_required, true);
    assert.equal(afterRow.last_sync_source, 'verification');
    assert.equal(afterRow.state_version, 3);

    // Entitlements stay FREE (provider→FREE gate unchanged); nothing is confirmed.
    const me = await app.inject({ method: 'GET', url: '/api/billing/me', headers: { cookie: fixture.cookie }, remoteAddress: nextIp() });
    assert.equal(me.statusCode, 200, me.body);
    assert.deepEqual(me.json().entitlements, JSON.parse(JSON.stringify(FREE_ENTITLEMENTS)));
    assert.equal(me.json().providerStatus.paymentConfirmed, false);
  });

  test('a user with no provider-backed subscription is ignored without any provider call', async () => {
    const user = await insertUser(db.pool, false);
    const session = await ctx.sessions.create(user.id, {});
    const result = await sync(`ve_session=${session.token}`);
    assert.equal(result.statusCode, 200, result.body);
    const body = subscriptionSyncResultSchema.parse(result.json());
    assert.equal(body.outcome, 'ignored');
    assert.equal(body.subscriptionId, null);
    assert.equal(calls.length, 0);
  });
});

describe('PR #7 route — safe refusals', () => {
  test('provider failures refuse as provider_unavailable (verification_unavailable) and write nothing', async () => {
    const fixture = await providerBackedUser();
    const before = await subscriptionRow(fixture.subscriptionId);
    for (const response of [
      { status: 500, body: { status: false, message: 'Server error' } },
      { status: 404, body: { status: false, message: 'Transaction reference not found' } },
      verified('ve-chk-someone-else', fixture.customerCode),
      verified(fixture.reference, fixture.customerCode, { domain: 'live' }),
      { status: 200, body: { status: true, data: { reference: fixture.reference } } },
    ]) {
      respond = () => response;
      const result = await sync(fixture.cookie);
      assert.equal(result.statusCode, 502, result.body);
      assert.equal(result.json().error.code, 'provider_unavailable');
      assert.match(result.json().error.message, /verification_unavailable/);
      assert.ok(!result.body.includes('sk_test_'));
      assert.ok(!result.body.includes('AUTH_'));
    }
    assert.deepEqual(await subscriptionRow(fixture.subscriptionId), before);
  });

  test('with no registered provider the route refuses as provider_not_registered', async () => {
    const fixture = await providerBackedUser(bareCtx);
    const before = await subscriptionRow(fixture.subscriptionId);
    const result = await sync(fixture.cookie, { target: bare });
    assert.equal(result.statusCode, 502, result.body);
    assert.equal(result.json().error.code, 'provider_unavailable');
    assert.match(result.json().error.message, /provider_not_registered/);
    assert.equal(calls.length, 0);
    assert.deepEqual(await subscriptionRow(fixture.subscriptionId), before);
  });
});

describe('PR #7 route — per-IP rate limit (webhook pattern)', () => {
  test('calls beyond the per-IP budget are 429 before authentication or any provider call', async () => {
    const ip = '198.51.100.201'; // its own bucket
    for (let attempt = 0; attempt < BILLING_SYNC_RATE_LIMIT_MAX; attempt += 1) {
      const result = await sync('', { ip });
      assert.equal(result.statusCode, 401, `attempt ${attempt}`);
    }
    const limited = await sync('', { ip });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    assert.equal(calls.length, 0);
  });
});
