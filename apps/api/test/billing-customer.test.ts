import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { billingCustomerProvisioningResultSchema } from '@veltrixeye/contracts';
import { FREE_ENTITLEMENTS, billingCheckoutSessionSchema } from '@veltrixeye/core';
import { createPaystackProvider } from '@veltrixeye/provider-paystack';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { paystackCustomerDirectory, paystackPlanDirectory } from '../src/billing-composition.js';
import { BILLING_CUSTOMER_RATE_LIMIT_MAX } from '../src/routes/billing.js';
import {
  AS_OF, PRO_MONTHLY, insertEpoch, insertUser, retireActiveEpochs, startBillingTestDb,
} from '../../../packages/core/test/helpers/billing-checkout.js';

/* ==========================================================================
   Billing Step 6 (roadmap item 8a) — POST /api/billing/customer (sandbox).

   The ACTUAL Paystack sandbox adapter and the ACTUAL composition directories
   with an entirely fake transport: no network, no Paystack mutation API is
   ever reached. The route ensures the caller's OWN billing customer exists
   (documented GET /customer/:email, then POST /customer only when missing),
   persists it, and makes checkout's existing-customer requirement reachable.
   ========================================================================== */

const SECRET = 'sk_test_0123456789abcdef0123456789abcdef01234567';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let ctx: ReturnType<typeof createAppContext>;
let app: Awaited<ReturnType<typeof buildApp>>;
let bare: Awaited<ReturnType<typeof buildApp>>;
let bareCtx: ReturnType<typeof createAppContext>;

interface Call { url: string; method: string; body: Record<string, unknown> | undefined; authorization: string | undefined }
let calls: Call[];
type Responder = (call: Call) => { status: number; body: unknown } | undefined;
let onFind: Responder;
let onCreate: Responder;
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;
let customerSequence = 500_000;

const config = () => loadConfig({
  NODE_ENV: 'test', DATABASE_URL: db?.dbUrl ?? 'postgres://test:test@localhost/test',
  LOG_LEVEL: 'silent', COOKIE_SECURE: 'never',
  PUBLIC_APPLICATION_ORIGIN: 'https://app.example.test',
});

const notFound = () => ({ status: 404, body: { status: false, message: 'Customer not found' } });
const customerBody = (email: string, overrides: Record<string, unknown> = {}) => {
  customerSequence += 1;
  return {
    status: 200,
    body: {
      status: true, message: 'Customer retrieved',
      data: { id: customerSequence, customer_code: `CUS_${randomUUID().replaceAll('-', '').slice(0, 14)}`, email, ...overrides },
    },
  };
};

before(async () => {
  db = await startBillingTestDb(5522);
  const cfg = config();
  ctx = createAppContext(db.pool, cfg);
  ctx.billingProviders.register(createPaystackProvider({
    secretKey: SECRET, timeoutMs: 1000,
    customers: paystackCustomerDirectory(db.pool),
    plans: paystackPlanDirectory(db.pool),
    clock: () => AS_OF,
    fetchFn: async (url, init) => {
      const headers = (init as { headers?: Record<string, string> }).headers ?? {};
      const call: Call = {
        url, method: init.method,
        body: init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>,
        authorization: headers.Authorization ?? headers.authorization,
      };
      calls.push(call);
      let response: { status: number; body: unknown } | undefined;
      if (call.method === 'GET' && url.startsWith('https://api.paystack.co/customer/')) response = onFind(call);
      else if (call.method === 'POST' && url === 'https://api.paystack.co/customer') response = onCreate(call);
      else if (call.method === 'POST' && url === 'https://api.paystack.co/transaction/initialize') {
        response = { status: 200, body: { status: true, message: 'Initialized', data: {
          authorization_url: 'https://checkout.example.test/authorize', access_code: 'test-code', reference: call.body?.reference,
        } } };
      }
      const final = response ?? { status: 500, body: { status: false, message: 'unexpected call' } };
      return { status: final.status, json: async () => final.body };
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
  onFind = () => notFound();
  onCreate = (call) => customerBody(String(call.body?.email), {});
});

async function signedIn(target = ctx) {
  const user = await insertUser(db.pool, false);
  const session = await target.sessions.create(user.id, {});
  return { ...user, cookie: `ve_session=${session.token}` };
}

const provision = (cookie: string, options: { payload?: unknown; target?: typeof app; ip?: string } = {}) =>
  (options.target ?? app).inject({
    method: 'POST', url: '/api/billing/customer', headers: { cookie },
    remoteAddress: options.ip ?? nextIp(),
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });

const customerRows = async (userId: string) =>
  (await db.pool.query('SELECT * FROM billing_customers WHERE user_id = $1', [userId])).rows as Record<string, unknown>[];

const me = async (cookie: string) =>
  app.inject({ method: 'GET', url: '/api/billing/me', headers: { cookie }, remoteAddress: nextIp() });

describe('Step 6 route — authentication and payload', () => {
  test('requires a session: 401, no provider call, nothing written', async () => {
    for (const cookie of ['', 've_session=not-a-real-session']) {
      const result = await provision(cookie);
      assert.equal(result.statusCode, 401, result.body);
      assert.equal(result.json().error.code, 'unauthorized');
    }
    assert.equal(calls.length, 0);
  });

  test('accepts no payload: a client can never name a user, an email or a provider identity', async () => {
    const victim = await signedIn();
    const caller = await signedIn();
    for (const payload of [
      { userId: victim.id }, { email: victim.email }, { email: 'attacker@example.test' },
      { providerCustomerCode: 'CUS_attacker' }, { status: 'provisioned' }, { plan: 'premium' }, [1],
    ]) {
      const result = await provision(caller.cookie, { payload });
      assert.equal(result.statusCode, 400, `${JSON.stringify(payload)}: ${result.body}`);
      assert.equal(result.json().error.code, 'invalid_input');
    }
    assert.equal(calls.length, 0);
    assert.equal((await customerRows(victim.id)).length, 0);
    assert.equal((await customerRows(caller.id)).length, 0);
  });

  test('only POST exists (no read/list surface for billing customers)', async () => {
    const user = await signedIn();
    const read = await app.inject({ method: 'GET', url: '/api/billing/customer', headers: { cookie: user.cookie }, remoteAddress: nextIp() });
    assert.equal(read.statusCode, 404);
  });
});

describe('Step 6 route — provisioning through the real sandbox adapter', () => {
  test('creates a customer (find → 404, then create), persists it, and is idempotent', async () => {
    const user = await signedIn();
    const first = await provision(user.cookie);
    assert.equal(first.statusCode, 200, first.body);
    const body = billingCustomerProvisioningResultSchema.parse(first.json());
    assert.deepEqual(first.json(), body, 'exactly the canonical provisioning result');
    assert.equal(body.outcome, 'created');
    assert.equal(body.email, user.email);
    assert.equal(body.checkoutReady, true);
    assert.equal(body.entitlementsChanged, false);
    assert.equal(body.grantsExecution, false);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.url, `https://api.paystack.co/customer/${encodeURIComponent(user.email)}`);
    assert.equal(calls[1]!.method, 'POST');
    assert.equal(calls[1]!.url, 'https://api.paystack.co/customer');
    assert.deepEqual(calls[1]!.body, { email: user.email }, 'only the session user\'s email is sent');
    for (const call of calls) assert.ok(call.url.startsWith('https://api.paystack.co/'));

    const rows = await customerRows(user.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'provisioned');
    assert.match(String(rows[0]!.provider_customer_code), /^CUS_/);
    assert.ok(!first.body.includes(String(rows[0]!.provider_customer_code)), 'provider identifiers are not returned');
    assert.ok(!first.body.includes('sk_test_'));

    calls = [];
    const again = await provision(user.cookie);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().outcome, 'already_provisioned');
    assert.equal(calls.length, 0, 'an already-provisioned customer costs no provider call');
    assert.deepEqual(await customerRows(user.id), rows);
  });

  test('links an existing provider customer (find → 200) without creating one', async () => {
    const user = await signedIn();
    onFind = () => customerBody(user.email);
    onCreate = () => { throw new Error('must not create'); };
    const result = await provision(user.cookie);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().outcome, 'linked');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'GET');
    assert.equal((await customerRows(user.id))[0]!.status, 'provisioned');
  });

  test('concurrent requests from one user produce one provider round-trip and one row', async () => {
    const user = await signedIn();
    const results = await Promise.all(Array.from({ length: 5 }, () => provision(user.cookie)));
    for (const result of results) assert.equal(result.statusCode, 200, result.body);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
    assert.equal((await customerRows(user.id)).length, 1);
  });
});

describe('Step 6 route — checkout becomes reachable through requireExistingCustomer', () => {
  test('checkout refuses before provisioning and initializes after it; entitlements stay FREE', async () => {
    await retireActiveEpochs(db.pool);
    const facts = await insertEpoch(db.pool);
    const user = await signedIn();
    const checkout = () => app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie }, payload: PRO_MONTHLY, remoteAddress: nextIp(),
    });

    const refused = await checkout();
    assert.equal(refused.statusCode, 502, refused.body);
    assert.match(refused.json().error.message, /customer_not_provisioned/);
    assert.equal(calls.length, 0);

    const provisioned = await provision(user.cookie);
    assert.equal(provisioned.statusCode, 200, provisioned.body);
    calls = [];

    const initialized = await checkout();
    assert.equal(initialized.statusCode, 200, initialized.body);
    const session = billingCheckoutSessionSchema.parse(initialized.json());
    assert.equal(session.pricing?.providerPlanId, facts.epoch.provider_plan_id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.paystack.co/transaction/initialize');
    assert.equal(calls[0]!.body?.email, user.email, 'checkout uses the provisioned local customer email');

    // Initialization + provisioning buy nothing: provider→FREE gate unchanged.
    const state = await me(user.cookie);
    assert.equal(state.statusCode, 200, state.body);
    assert.deepEqual(state.json().entitlements, JSON.parse(JSON.stringify(FREE_ENTITLEMENTS)));
    assert.equal(state.json().entitlements.canAccessAutomation, false);
    assert.equal(state.json().providerStatus.paymentConfirmed, false);
  });

  test('provisioning alone changes no subscription and no entitlement', async () => {
    const user = await signedIn();
    const before = await me(user.cookie);
    const subsBefore = (await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id])).rows;
    assert.equal((await provision(user.cookie)).statusCode, 200);
    const afterMe = await me(user.cookie);
    assert.deepEqual(afterMe.json(), before.json());
    assert.deepEqual(afterMe.json().entitlements, JSON.parse(JSON.stringify(FREE_ENTITLEMENTS)));
    assert.deepEqual((await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id])).rows, subsBefore);
  });
});

describe('Step 6 route — authorization / isolation', () => {
  test('each session provisions only its own customer; another user\'s record is never exposed', async () => {
    const a = await signedIn();
    const b = await signedIn();
    assert.equal((await provision(a.cookie)).statusCode, 200);
    const aRows = await customerRows(a.id);

    const result = await provision(b.cookie);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().email, b.email);
    assert.ok(!result.body.includes(a.email));
    assert.ok(!result.body.includes(String(aRows[0]!.provider_customer_code)));
    assert.deepEqual(await customerRows(a.id), aRows);
  });

  test('a provider identity already bound to another user is refused (409) without revealing it', async () => {
    const owner = await signedIn();
    assert.equal((await provision(owner.cookie)).statusCode, 200);
    const [ownerRow] = await customerRows(owner.id);

    const intruder = await signedIn();
    onCreate = (call) => customerBody(String(call.body?.email), {
      customer_code: ownerRow!.provider_customer_code, id: Number(ownerRow!.provider_customer_id),
    });
    const result = await provision(intruder.cookie);
    assert.equal(result.statusCode, 409, result.body);
    assert.equal(result.json().error.code, 'conflict');
    assert.match(result.json().error.message, /customer_identity_conflict/);
    assert.ok(!result.body.includes(owner.email));
    assert.ok(!result.body.includes(String(ownerRow!.provider_customer_code)));
    assert.equal((await customerRows(intruder.id)).length, 0);
    assert.deepEqual(await customerRows(owner.id), [ownerRow]);
  });
});

describe('Step 6 route — safe refusals (nothing written)', () => {
  test('provider failures refuse as provider_unavailable (502)', async () => {
    const user = await signedIn();
    for (const [find, create] of [
      [() => ({ status: 500, body: { status: false, message: 'Server error' } }), undefined],
      [() => ({ status: 404, body: { status: false, message: '' } }), undefined], // ambiguous 404 is never "no customer"
      [() => ({ status: 401, body: { status: false, message: 'Invalid key' } }), undefined],
      [undefined, () => ({ status: 500, body: { status: false, message: 'Server error' } })],
      [undefined, () => ({ status: 200, body: { status: true, data: { email: 'x' } } })], // no identifiers
    ] as [Responder | undefined, Responder | undefined][]) {
      onFind = find ?? (() => notFound());
      onCreate = create ?? ((call) => customerBody(String(call.body?.email)));
      const result = await provision(user.cookie);
      assert.equal(result.statusCode, 502, result.body);
      assert.equal(result.json().error.code, 'provider_unavailable');
      assert.match(result.json().error.message, /provider_unavailable/);
      assert.ok(!result.body.includes('sk_test_'));
      assert.ok(!result.body.includes('Invalid key'), 'provider detail is not echoed');
    }
    assert.equal((await customerRows(user.id)).length, 0);
  });

  test('an unusable identity (code-less customer, mismatched email) is refused', async () => {
    const user = await signedIn();
    onFind = () => customerBody(user.email, { customer_code: undefined });
    let result = await provision(user.cookie);
    assert.equal(result.statusCode, 502, result.body);
    assert.match(result.json().error.message, /provider_response_unusable/);

    onFind = () => notFound();
    onCreate = () => customerBody('someone-else@example.test');
    result = await provision(user.cookie);
    // The adapter itself refuses a create email mismatch (response_conflict).
    assert.equal(result.statusCode, 502, result.body);
    assert.equal((await customerRows(user.id)).length, 0);
  });

  test('a suspended or unavailable customer is refused (409) without any provider call', async () => {
    for (const status of ['suspended', 'unavailable']) {
      const user = await signedIn();
      await db.pool.query(
        `INSERT INTO billing_customers (user_id, email, status, provider_customer_code, provisioned_at)
         VALUES ($1, $2, $3, $4, now())`,
        [user.id, user.email, status, `CUS_${randomUUID().replaceAll('-', '').slice(0, 12)}`],
      );
      const before = await customerRows(user.id);
      const result = await provision(user.cookie);
      assert.equal(result.statusCode, 409, result.body);
      assert.match(result.json().error.message, /customer_not_provisionable/);
      assert.deepEqual(await customerRows(user.id), before);
    }
    assert.equal(calls.length, 0);
  });

  test('with no registered provider the route refuses as provider_not_registered', async () => {
    const user = await signedIn(bareCtx);
    const result = await provision(user.cookie, { target: bare });
    assert.equal(result.statusCode, 502, result.body);
    assert.equal(result.json().error.code, 'provider_unavailable');
    assert.match(result.json().error.message, /provider_not_registered/);
    assert.equal(calls.length, 0);
    assert.equal((await customerRows(user.id)).length, 0);
  });
});

describe('Step 6 route — per-IP rate limit (sync/webhook pattern)', () => {
  test('calls beyond the per-IP budget are 429 before authentication or any provider call', async () => {
    const ip = '198.51.100.202'; // its own bucket
    for (let attempt = 0; attempt < BILLING_CUSTOMER_RATE_LIMIT_MAX; attempt += 1) {
      const result = await provision('', { ip });
      assert.equal(result.statusCode, 401, `attempt ${attempt}`);
    }
    const limited = await provision('', { ip });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, 'rate_limited');
    assert.equal(calls.length, 0);
  });

  test('the budget is small and applies to authenticated callers too', async () => {
    assert.ok(BILLING_CUSTOMER_RATE_LIMIT_MAX > 0 && BILLING_CUSTOMER_RATE_LIMIT_MAX <= 10);
    const user = await signedIn();
    const ip = '198.51.100.203';
    for (let attempt = 0; attempt < BILLING_CUSTOMER_RATE_LIMIT_MAX; attempt += 1) {
      assert.equal((await provision(user.cookie, { ip })).statusCode, 200);
    }
    assert.equal((await provision(user.cookie, { ip })).statusCode, 429);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'only the first call reached the provider');
  });
});
