import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BillingPricingSnapshotStore, billingCheckoutSessionSchema, verifyPricingSnapshot,
  createBillingProviderRegistry, createFreeSubscription, parseProviderPlan,
} from '@veltrixeye/core';
import { createPaystackProvider } from '@veltrixeye/provider-paystack';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  billingCheckoutCallbackUrl, composeBillingCheckout, paystackCustomerDirectory, paystackPlanDirectory,
} from '../src/billing-composition.js';
import {
  AS_OF, PRO_MONTHLY, startBillingTestDb, insertEpoch, insertUser,
  retireActiveEpochs, retireEpoch, deriveSnapshot,
} from '../../../packages/core/test/helpers/billing-checkout.js';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let ctx: ReturnType<typeof createAppContext>;
let app: Awaited<ReturnType<typeof buildApp>>;
let calls: { url: string; method: string; body: Record<string, unknown> }[];
let denyPlan = false;
const config = (overrides: Record<string, string> = {}) => loadConfig({
  NODE_ENV: 'test', DATABASE_URL: db?.dbUrl ?? 'postgres://test:test@localhost/test',
  LOG_LEVEL: 'silent', COOKIE_SECURE: 'never',
  PUBLIC_APPLICATION_ORIGIN: 'https://app.example.test', ...overrides,
});

before(async () => {
  db = await startBillingTestDb(5492);
  const cfg = config();
  ctx = createAppContext(db.pool, cfg);
  const directory = paystackPlanDirectory(db.pool);
  // Actual sandbox adapter, actual DB directories, entirely fake transport.
  ctx.billingProviders.register(createPaystackProvider({
    secretKey: 'sk_test_0123456789abcdef0123456789abcdef01234567', timeoutMs: 1000,
    customers: paystackCustomerDirectory(db.pool),
    plans: { find: async (id) => denyPlan ? null : directory.find(id) },
    clock: () => AS_OF,
    fetchFn: async (url, init) => {
      const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
      calls.push({ url, method: init.method, body });
      return { status: 200, json: async () => ({ status: true, message: 'Initialized', data: {
        authorization_url: 'https://checkout.example.test/authorize', access_code: 'test-code', reference: body.reference,
      } }) };
    },
  }));
  app = await buildApp(cfg, ctx);
  await app.ready();
}, { timeout: 180_000 });
after(async () => { await app?.close(); await db?.stop(); });
beforeEach(async () => { calls = []; denyPlan = false; await retireActiveEpochs(db.pool); });

async function authenticatedUser(customer = true) {
  const user = await insertUser(db.pool, customer);
  const session = await ctx.sessions.create(user.id, {});
  return { ...user, cookie: `ve_session=${session.token}` };
}
const checkout = (cookie: string, payload: object = PRO_MONTHLY, headers: Record<string, string> = {}) => app.inject({
  method: 'POST', url: '/api/billing/checkout', headers: { cookie, ...headers }, payload,
});

test('requires authentication; preserves other prohibited routes', async () => {
  const result = await checkout('');
  assert.equal(result.statusCode, 401);
  // `webhook` is no longer prohibited: Billing Step 5.2 registered the secure
  // receiver at that path (see test/billing-webhook.test.ts). `customer` is
  // no longer prohibited either: Billing Step 6 registered the
  // session-authenticated provisioning route there (see
  // test/billing-customer.test.ts) — unauthenticated, it is a 401.
  for (const path of ['portal', 'callback']) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/billing/${path}` })).statusCode, 404);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/billing/customer' })).statusCode, 401);
  assert.equal(calls.length, 0);
});

test('authenticated route authorizes locked plan and exact GHS amount; retry returns stable reference', async () => {
  const facts = await insertEpoch(db.pool);
  const user = await authenticatedUser();
  const beforeCustomers = await db.pool.query('SELECT * FROM billing_customers WHERE user_id=$1', [user.id]);
  const first = await checkout(user.cookie, PRO_MONTHLY, {
    host: 'attacker.example.test', 'x-forwarded-host': 'attacker.example.test', 'x-forwarded-proto': 'http',
  });
  assert.equal(first.statusCode, 200, first.body);
  const session = billingCheckoutSessionSchema.parse(first.json());
  assert.equal(session.authorizationUrl, 'https://checkout.example.test/authorize');
  assert.equal(session.pricing?.providerPlanId, facts.epoch.provider_plan_id);
  assert.equal(session.pricing?.fx.fxRateVersionId, facts.fx.id);
  const second = await checkout(user.cookie);
  assert.equal(second.statusCode, 200, second.body);
  assert.deepEqual(second.json(), first.json());
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(call.method, 'POST');
    assert.equal(call.body.plan, session.pricing?.providerPlanId);
    assert.equal(call.body.amount, session.payment?.paymentAmountMinor);
    assert.equal(call.body.currency, 'GHS');
    assert.equal(call.body.email, user.email);
    assert.equal(call.body.callback_url, 'https://app.example.test/settings');
    assert.equal(call.body.reference, session.reference);
  }
  assert.deepEqual((await db.pool.query('SELECT * FROM billing_customers WHERE user_id=$1', [user.id])).rows, beforeCustomers.rows);
});

test('MODEL C: registration provisions no billing row and the first checkout creates the sold row + lock', async () => {
  const facts = await insertEpoch(db.pool);
  // The REAL registration path (no fixture): identity + session only.
  const user = await ctx.users.create({ email: `model-c-${crypto.randomUUID()}@example.test`, name: 'Model C user', passwordHash: 'test-hash' });
  const session = await ctx.sessions.create(user.id, {});
  const cookie = `ve_session=${session.token}`;
  const read = () => db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  assert.equal((await read()).rowCount, 0, 'registration must not create a subscriptions row');

  // The free fallback is the ABSENT row, and it publishes no provider.
  const me = await app.inject({ method: 'GET', url: '/api/billing/me', headers: { cookie } });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().subscription.plan, 'free');
  assert.equal(me.json().subscription.status, 'active');
  assert.deepEqual(me.json().providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
  assert.equal(me.json().entitlements.canAccessScanner, false);

  // Test-only fixture standing in for the Step 6 customer-provisioning result
  // (the checkout path requires an existing local provider customer identity).
  await db.pool.query(
    'INSERT INTO billing_customers(user_id,email,provider_customer_code) VALUES($1,$2,$3)',
    [user.id, user.email, `CUS_${crypto.randomUUID().replaceAll('-', '')}`],
  );

  // First commercial checkout: the one path that derives epoch + pinned FX
  // pricing and writes the subscription with its immutable lock — snapshot,
  // sold row and lock in ONE transaction.
  const snapshots = () => db.pool.query('SELECT count(*)::int AS c FROM billing_pricing_snapshots');
  const snapshotsBefore = (await snapshots()).rows[0].c;
  const result = await checkout(cookie);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().pricing.providerPlanId, facts.epoch.provider_plan_id);
  const rows = await read();
  assert.equal(rows.rowCount, 1, 'exactly one commercial subscription row');
  assert.equal(rows.rows[0].plan, 'pro');
  assert.equal(rows.rows[0].provider, 'paystack');
  assert.equal(rows.rows[0].provider_state, 'pending');
  assert.ok(rows.rows[0].locked_pricing_snapshot_id, 'the immutable pricing lock is created with the row');
  assert.equal((await snapshots()).rows[0].c, snapshotsBefore + 1, 'exactly one pricing snapshot for the sale');
  const stored = await new BillingPricingSnapshotStore(db.pool).findById(rows.rows[0].locked_pricing_snapshot_id);
  assert.deepEqual(verifyPricingSnapshot(stored?.snapshot), result.json().pricing);
  // The lock is a pricing fact, never a confirmation: still free, still unconfirmed.
  const after = await app.inject({ method: 'GET', url: '/api/billing/me', headers: { cookie } });
  assert.equal(after.json().providerStatus.paymentConfirmed, false);
  assert.equal(after.json().entitlements.canAccessScanner, false);
  // The retry is idempotent and creates no second row and no second snapshot.
  const retry = await checkout(cookie);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json(), result.json());
  assert.equal((await read()).rowCount, 1);
  assert.equal((await snapshots()).rows[0].c, snapshotsBefore + 1, 'the retry re-prices nothing');
  assert.deepEqual(
    (await db.pool.query('SELECT locked_pricing_snapshot_id FROM subscriptions WHERE user_id=$1', [user.id])).rows[0],
    { locked_pricing_snapshot_id: rows.rows[0].locked_pricing_snapshot_id },
    'the immutable lock is unchanged by the retry',
  );
});

test('parallel first checkouts leave one subscription, one snapshot and one lock', async () => {
  await insertEpoch(db.pool);
  await insertEpoch(db.pool, { plan: 'elite' });
  const user = await authenticatedUser();
  const snapshots = () => db.pool.query('SELECT count(*)::int AS c FROM billing_pricing_snapshots');
  const snapshotsBefore = (await snapshots()).rows[0].c;
  // Six simultaneous first checkouts over the HTTP boundary, half of them
  // pricing a different plan than the others.
  const results = await Promise.all(Array.from({ length: 6 }, (_, n) => checkout(
    user.cookie, n % 2 ? PRO_MONTHLY : { cataloguePlan: 'elite', interval: 'monthly' },
  )));
  const [winner] = results;
  for (const result of results) {
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), winner!.json());
  }
  const rows = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  assert.equal(rows.rowCount, 1, 'exactly one winning commercial subscription');
  assert.ok(rows.rows[0].locked_pricing_snapshot_id);
  // No orphaned candidate snapshot: the losing attempts' pricing decisions are
  // discarded with their own transactions, so only the winner's survives.
  assert.equal((await snapshots()).rows[0].c, snapshotsBefore + 1, 'exactly one pricing snapshot survives');
  const stored = await new BillingPricingSnapshotStore(db.pool).findById(rows.rows[0].locked_pricing_snapshot_id);
  assert.deepEqual(verifyPricingSnapshot(stored?.snapshot), winner!.json().pricing);
});

test('legacy NULL-lock rows stay fail-closed with pricing_lock_required and are never upgraded', async () => {
  // A pre-Model-C row (registration used to create exactly this shape) is
  // modelled with the legacy fixture: free/active, no provider, NULL lock.
  await insertEpoch(db.pool);
  const user = await authenticatedUser();
  await createFreeSubscription(db.pool, user.id);
  const read = () => db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  const before = await read();
  const result = await checkout(user.cookie);
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().error.code, 'conflict');
  assert.match(result.json().error.message, /pricing_lock_required/);
  assert.deepEqual((await read()).rows, before.rows, 'the legacy row is untouched');
  assert.equal(calls.length, 0);
});

test('strict body rejects client callback, prices, plan ids, user ids, starter and invalid interval', async () => {
  const user = await authenticatedUser();
  for (const body of [
    { ...PRO_MONTHLY, callbackUrl: 'https://evil.example.test/settings' },
    { ...PRO_MONTHLY, providerPlanId: 'PLN_client' }, { ...PRO_MONTHLY, amount: 1 },
    { ...PRO_MONTHLY, userId: user.id }, { ...PRO_MONTHLY, cataloguePlan: 'starter' },
    { ...PRO_MONTHLY, interval: 'daily' },
  ]) {
    const result = await checkout(user.cookie, body);
    assert.equal(result.statusCode, 400, result.body);
    assert.equal(result.json().error.code, 'invalid_input');
  }
  assert.equal(calls.length, 0);
  assert.equal((await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id])).rowCount, 0);
});

test('HTTPS origin derives only /settings; absent origin disables checkout; malformed origins rejected', async () => {
  assert.equal(billingCheckoutCallbackUrl(config()), 'https://app.example.test/settings');
  assert.equal(billingCheckoutCallbackUrl(config({ PUBLIC_APPLICATION_ORIGIN: 'https://app.example.test/' })), 'https://app.example.test/settings');
  assert.equal(billingCheckoutCallbackUrl(config({ PUBLIC_APPLICATION_ORIGIN: '' })), null);
  assert.ok(readFileSync(new URL('../../web/app/settings/page.tsx', import.meta.url), 'utf8').includes('Settings'));
  for (const origin of [
    'http://app.example.test', 'invalid', 'javascript:alert(1)', 'https://app.example.test/evil',
    'https://user:pass@app.example.test', 'https://app.example.test?next=evil', 'https://app.example.test#evil',
  ]) assert.throws(() => config({ PUBLIC_APPLICATION_ORIGIN: origin }), /PUBLIC_APPLICATION_ORIGIN/);
  const user = await authenticatedUser();
  const noOrigin = await buildApp(config({ PUBLIC_APPLICATION_ORIGIN: '' }), ctx);
  try {
    const result = await noOrigin.inject({ method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie }, payload: PRO_MONTHLY });
    assert.equal(result.statusCode, 502, result.body);
    assert.match(result.json().error.message, /callback_not_configured/);
    assert.equal((await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id])).rowCount, 0);
    assert.equal(calls.length, 0);
  } finally { await noOrigin.close(); }
});

test('absent provider and absent plan both fail closed', async () => {
  const user = await authenticatedUser();
  const unavailable = composeBillingCheckout(db.pool, createBillingProviderRegistry(), config());
  await assert.rejects(unavailable.checkout(user.id, PRO_MONTHLY), { reason: 'provider_not_registered' });
  const missing = await checkout(user.cookie, { cataloguePlan: 'elite', interval: 'annual' });
  assert.equal(missing.statusCode, 502, missing.body);
  assert.match(missing.json().error.message, /plan_not_registered/);
  assert.equal(calls.length, 0);
});

test('missing local customer identity returns customer_not_provisioned; never provisions', async () => {
  await insertEpoch(db.pool);
  for (const emailOnly of [false, true]) {
    const user = await authenticatedUser(false);
    if (emailOnly) await db.pool.query('INSERT INTO billing_customers(user_id,email) VALUES($1,$2)', [user.id, user.email]);
    const before = await db.pool.query('SELECT * FROM billing_customers WHERE user_id=$1', [user.id]);
    const result = await checkout(user.cookie);
    assert.equal(result.statusCode, 502, result.body);
    assert.match(result.json().error.message, /customer_not_provisioned/);
    assert.deepEqual((await db.pool.query('SELECT * FROM billing_customers WHERE user_id=$1', [user.id])).rows, before.rows);
    const lock = await db.pool.query('SELECT locked_pricing_snapshot_id FROM subscriptions WHERE user_id=$1', [user.id]);
    assert.ok(lock.rows[0].locked_pricing_snapshot_id, 'lock remains durable even if checkout cannot initialize');
  }
  assert.equal(calls.length, 0);
});

test('retired locked A remains immutable and verified; adapter rejects retry with plan_mismatch; new user gets B', async () => {
  const a = await insertEpoch(db.pool);
  const old = await authenticatedUser();
  const initial = await checkout(old.cookie);
  assert.equal(initial.statusCode, 200, initial.body);
  const read = () => db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [old.id]);
  const locked = await read();
  await retireEpoch(db.pool, a.epoch.id);
  const b = await insertEpoch(db.pool, { rateScaled: 20_000_000 });
  const attemptsBefore = calls.length;
  const rejected = await checkout(old.cookie);
  assert.equal(rejected.statusCode, 502, rejected.body);
  assert.match(rejected.json().error.message, /plan_mismatch/);
  assert.equal(calls.length, attemptsBefore, 'retirement guard prevents any provider HTTP request');
  assert.deepEqual((await read()).rows, locked.rows);
  const stored = await new BillingPricingSnapshotStore(db.pool).findById(locked.rows[0].locked_pricing_snapshot_id);
  assert.deepEqual(verifyPricingSnapshot(stored?.snapshot), initial.json().pricing);
  const fresh = await authenticatedUser();
  const result = await checkout(fresh.cookie);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().pricing.providerPlanId, b.epoch.provider_plan_id);
  assert.equal(result.json().payment.paymentAmountMinor, 78_000);
});

test('unregistered historical plan cannot reach Paystack', async () => {
  await insertEpoch(db.pool);
  const user = await authenticatedUser();
  const first = await checkout(user.cookie);
  assert.equal(first.statusCode, 200, first.body);
  denyPlan = true; // Simulate missing local authorization at the adapter directory boundary.
  const rejected = await checkout(user.cookie);
  assert.equal(rejected.statusCode, 502, rejected.body);
  assert.match(rejected.json().error.message, /plan_not_registered/);
  assert.equal(calls.length, 1);
});

test('excluded plan is refused both as a sneaked active epoch and as a historical lock', async () => {
  const facts = await insertEpoch(db.pool, { providerPlanId: ['PLN', 'u0l4961hhipl6ek'].join('_') });
  const user = await authenticatedUser();
  const result = await checkout(user.cookie);
  assert.equal(result.statusCode, 502, result.body);
  assert.match(result.json().error.message, /forbidden_plan/);
  const historical = await new BillingPricingSnapshotStore(db.pool).create(deriveSnapshot(facts));
  await db.pool.query(`INSERT INTO subscriptions(user_id,plan,provider,catalogue_plan,billing_interval,provider_plan_id,locked_pricing_snapshot_id)
    VALUES($1,'pro','paystack','pro','monthly',$2,$3)`, [user.id, facts.epoch.provider_plan_id, historical.id]);
  const again = await checkout(user.cookie);
  assert.equal(again.statusCode, 502, again.body);
  assert.match(again.json().error.message, /forbidden_plan/);
  assert.equal(calls.length, 0);
});

test('new checkout fails closed if epoch amount does not verify', async () => {
  await insertEpoch(db.pool, { amount: 48_751 });
  const user = await authenticatedUser();
  const rejected = await checkout(user.cookie);
  assert.equal(rejected.statusCode, 502, rejected.body);
  assert.match(rejected.json().error.message, /invalid_snapshot/);
  assert.equal(calls.length, 0);
});

test('NULL lock immutability trigger is unchanged and still rejects NULL to snapshot', async () => {
  const facts = await insertEpoch(db.pool);
  const user = await authenticatedUser();
  await createFreeSubscription(db.pool, user.id);
  const stored = await new BillingPricingSnapshotStore(db.pool).create(deriveSnapshot(facts));
  await assert.rejects(db.pool.query(`UPDATE subscriptions SET locked_pricing_snapshot_id=$1,
    plan='pro',catalogue_plan='pro',billing_interval='monthly',provider='paystack' WHERE user_id=$2`,
  [stored.id, user.id]), /immutable/);
  assert.equal((await db.pool.query('SELECT locked_pricing_snapshot_id FROM subscriptions WHERE user_id=$1', [user.id])).rows[0].locked_pricing_snapshot_id, null);
  assert.equal(calls.length, 0);
});

test('adapter amount authorization is not bypassed by the service', async () => {
  const facts = await insertEpoch(db.pool);
  const user = await authenticatedUser();
  const providers = createBillingProviderRegistry();
  providers.register(createPaystackProvider({
    secretKey: 'sk_test_0123456789abcdef0123456789abcdef01234567', timeoutMs: 1000,
    customers: paystackCustomerDirectory(db.pool),
    plans: { find: async () => ({ ...parseProviderPlan(facts.epoch), paymentAmountMinor: 1n }) },
    fetchFn: async () => { assert.fail('unauthorized amount must not reach transport'); },
  }));
  const guarded = composeBillingCheckout(db.pool, providers, config());
  await assert.rejects(guarded.checkout(user.id, PRO_MONTHLY), { reason: 'plan_mismatch' });
});
