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
  for (const path of ['portal', 'webhook', 'customer', 'callback']) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/billing/${path}` })).statusCode, 404);
  }
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

test('ordinary registered users keep their existing free NULL lock and get pricing_lock_required', async () => {
  // Exercise the existing creation service, which ALWAYS creates the free row.
  const user = await ctx.users.create({ email: `ordinary-${crypto.randomUUID()}@example.test`, name: 'Ordinary user', passwordHash: 'test-hash' });
  const session = await ctx.sessions.create(user.id, {});
  const read = () => db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  const before = await read();
  const result = await checkout(`ve_session=${session.token}`);
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().error.code, 'conflict');
  assert.match(result.json().error.message, /pricing_lock_required/);
  assert.deepEqual((await read()).rows, before.rows);
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
