import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BillingActivationService, billingEventPayloadHash } from '@veltrixeye/core';
import {
  BILLING_CREDENTIAL_SHAPED_RE,
  billingPaymentVerificationResultSchema,
} from '@veltrixeye/contracts';
import {
  PAYSTACK_TEST_KEY_PREFIX,
  type PaystackFetchFn,
} from '@veltrixeye/provider-paystack';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { composeBillingProvider, paystackPlanDirectory } from '../src/billing-composition.js';
import {
  PRO_MONTHLY,
  insertEpoch,
  insertUser,
  retireActiveEpochs,
  seedCommercialSubscription,
  seedPaymentEvidence,
  startBillingTestDb,
} from '../../../packages/core/test/helpers/billing-checkout.js';

/* ==========================================================================
   Live Paystack mode — apps/api integration.

   Everything here runs against a real database with FAKE TRANSPORT ONLY: the
   injected `billingFetchFn` (and the webhook's signed fixture deliveries)
   stand in for Paystack, so no test ever reaches a network. No production
   domain, no production plan and no real credential is involved: the "live"
   key below is a synthetic, obviously fake literal used exactly like the
   existing sandbox test keys.

   Covers, per the approved review:
     - the PAYSTACK_MODE × key-prefix boot matrix (mismatch fails boot);
     - live composition status (mode reported honestly, no secrets);
     - mode-specific provider-plan directory resolution;
     - an end-to-end live customer → checkout → verify → activation flow;
     - live-domain provider verification and the wrong-domain refusal;
     - live webhook delivery acceptance and test-domain refusal.
   ========================================================================== */

const TEST_KEY = 'sk_test_0123456789abcdef0123456789abcdef01234567';
/** SYNTHETIC live-shaped key for tests only — never a real credential. */
const LIVE_KEY = 'sk_live_notarealkey01';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  here, '..', '..', '..', 'packages', 'providers', 'paystack', 'test', 'fixtures', 'webhook',
);
const fixtureBody = (name: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as { body: Record<string, unknown> }).body;

const baseEnv = (dbUrl: string, overrides: Record<string, string> = {}) => ({
  NODE_ENV: 'test',
  DATABASE_URL: dbUrl,
  LOG_LEVEL: 'silent',
  COOKIE_SECURE: 'never',
  PUBLIC_APPLICATION_ORIGIN: 'https://app.example.test',
  PAYSTACK_WEBHOOK_ALLOWED_IPS: '127.0.0.1, ::1, 192.0.2.0/24',
  ...overrides,
});

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let ctx: ReturnType<typeof createAppContext>;
let app: Awaited<ReturnType<typeof buildApp>>;
let calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
let verifyDomain: 'test' | 'live' = 'live';
/** Monotonic provider-side customer identifiers (each create is unique). */
let customerSeq = 700_000;
/**
 * ref → the exact facts the fake verify endpoint reports for that checkout.
 * The customer identity MUST be the one the local row holds: reconciliation
 * fails closed on any provider-customer disagreement.
 */
const referenceEvidence = new Map<string, { amount: number; customerCode: string; customerId: string | null }>();

/**
 * The fake Paystack transport for the LIVE composition: it answers exactly
 * the four endpoints the adapter may reach (customer create/find, checkout
 * initialize, transaction verify) and fails loudly on anything else.
 */
const liveFetchFn: PaystackFetchFn = async (url, init) => {
  const method = init.method ?? 'GET';
  const body = init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
  calls.push({ url, method, ...(body === undefined ? {} : { body }) });
  const respond = (status: number, payload: unknown) => ({ status, json: async () => payload });

  if (method === 'POST' && url === 'https://api.paystack.co/customer') {
    customerSeq += 1;
    return respond(200, {
      status: true, message: 'Customer created',
      data: {
        id: customerSeq,
        customer_code: `CUS_live${customerSeq}`,
        email: String(body?.email ?? '').toLowerCase(),
      },
    });
  }
  if (method === 'GET' && url.startsWith('https://api.paystack.co/customer/')) {
    // First provisioning: the account has no provider customer yet. Answer
    // 404 exactly like a real lookup miss so the adapter falls through to
    // create — an over-eager 200 would link a foreign identity and be
    // refused as customer_identity_conflict.
    return respond(404, { status: false, message: 'Customer not found' });
  }
  if (method === 'POST' && url === 'https://api.paystack.co/transaction/initialize') {
    return respond(200, {
      status: true, message: 'Initialized',
      data: { authorization_url: 'https://checkout.example.test/authorize', access_code: 'live-code', reference: body?.reference },
    });
  }
  if (method === 'GET' && url.startsWith('https://api.paystack.co/transaction/verify/')) {
    const ref = decodeURIComponent(url.split('/').pop() ?? '');
    const facts = referenceEvidence.get(ref);
    if (facts === undefined) {
      return respond(500, { status: false, message: `unexpected verify for ${ref}` });
    }
    return respond(200, {
      status: true, message: 'Verification successful',
      data: {
        id: 4242424,
        domain: verifyDomain,
        status: 'success',
        reference: ref,
        amount: facts.amount,
        currency: 'GHS',
        paid_at: '2026-09-24T10:01:00.000Z',
        customer: {
          id: facts.customerId === null ? 42 : Number(facts.customerId) || 42,
          customer_code: facts.customerCode,
          email: 'live@example.test',
        },
      },
    });
  }
  return respond(500, { status: false, message: `unexpected call ${method} ${url}` });
};

const signLive = (raw: string | Buffer): string =>
  createHmac('sha512', LIVE_KEY).update(raw).digest('hex');

let ipOctet = 40;
const nextIp = (): string => `203.0.113.${(ipOctet++ % 250) + 1}`;
let webhookOctet = 60;
const nextWebhookIp = (): string => `192.0.2.${(webhookOctet++ % 250) + 1}`;

before(async () => {
  db = await startBillingTestDb(5530);
  const liveCfg = loadConfig(baseEnv(db.dbUrl, {
    PAYSTACK_MODE: 'live',
    PAYSTACK_SECRET_KEY: LIVE_KEY,
  }));
  // The production path under test: mode threaded through composition,
  // transport injected for tests only.
  ctx = createAppContext(db.pool, liveCfg, { billingFetchFn: liveFetchFn });
  app = await buildApp(liveCfg, ctx);
  await app.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await db?.stop();
});

beforeEach(() => {
  calls = [];
  verifyDomain = 'live';
  referenceEvidence.clear();
});

async function signedIn() {
  const user = await insertUser(db.pool, false);
  const session = await ctx.sessions.create(user.id, {});
  return { ...user, cookie: `ve_session=${session.token}` };
}

const inject = (cookie: string, url: string, payload?: object) =>
  app.inject({
    method: 'POST', url, headers: { cookie }, remoteAddress: nextIp(),
    ...(payload === undefined ? {} : { payload }),
  });

/* ========================================================================== */
/* 1. The boot matrix: mode × key prefix                                      */
/* ========================================================================== */

describe('PAYSTACK_MODE — the configuration matrix', () => {
  test('live mode with a live key boots and reports live (sandbox false)', () => {
    const cfg = loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: 'live', PAYSTACK_SECRET_KEY: LIVE_KEY }));
    assert.equal(cfg.billing.mode, 'live');
    assert.equal(cfg.billing.sandbox, false);
    assert.equal(cfg.billing.live, true);
    assert.equal(cfg.billing.enabled, true);
    assert.equal(cfg.PAYSTACK_SECRET_KEY, LIVE_KEY, 'server-side config keeps the key');
  });

  test('test mode with a test key boots and stays the sandbox default', () => {
    assert.equal(PAYSTACK_TEST_KEY_PREFIX, 'sk_test_', 'the test prefix is pinned at the source');
    assert.ok(TEST_KEY.startsWith(PAYSTACK_TEST_KEY_PREFIX));
    const cfg = loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: 'test', PAYSTACK_SECRET_KEY: TEST_KEY }));
    assert.equal(cfg.billing.mode, 'test');
    assert.equal(cfg.billing.sandbox, true);
    assert.equal(cfg.billing.live, false);
    // The default when PAYSTACK_MODE is absent.
    const implicit = loadConfig(baseEnv(db.dbUrl, { PAYSTACK_SECRET_KEY: TEST_KEY }));
    assert.equal(implicit.billing.mode, 'test');
  });

  test('mode × key MISMATCH fails the boot, naming the config, never echoing the key', () => {
    for (const [mode, key] of [['test', LIVE_KEY], ['live', TEST_KEY]] as const) {
      assert.throws(
        () => loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: mode, PAYSTACK_SECRET_KEY: key })),
        (error: unknown) => {
          const message = String((error as Error).message);
          assert.match(message, /PAYSTACK_SECRET_KEY/);
          assert.match(message, /PAYSTACK_MODE/);
          assert.ok(!message.includes(key), 'the rejected key is never echoed');
          return true;
        },
        `${mode} + ${key.slice(0, 8)}… must refuse to boot`,
      );
    }
  });

  test('an unknown PAYSTACK_MODE value fails the boot', () => {
    assert.throws(() => loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: 'sandbox' })));
    assert.throws(() => loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: 'LIVE' })));
  });

  test('an empty key stays fail-closed in BOTH modes (configured but disabled)', () => {
    for (const mode of ['test', 'live'] as const) {
      const cfg = loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: mode, PAYSTACK_SECRET_KEY: '' }));
      assert.equal(cfg.billing.mode, mode);
      assert.equal(cfg.billing.enabled, false, `${mode} + empty key is disabled`);
    }
  });
});

/* ========================================================================== */
/* 2. Composition status and the mode-specific plan directory                 */
/* ========================================================================== */

describe('live composition — status and provider-plan directory', () => {
  test('live composition registers with mode live and an operator-safe describe', () => {
    const cfg = loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: 'live', PAYSTACK_SECRET_KEY: LIVE_KEY }));
    const composition = composeBillingProvider(db.pool, cfg);
    assert.equal(composition.status.registered, true);
    assert.equal(composition.status.mode, 'live');
    assert.match(composition.status.reason, /live mode/);
    const listed = composition.registry.list();
    assert.deepEqual(listed, [
      { id: 'paystack', name: 'paystack-live', implemented: false, live: false, mode: 'live' },
    ]);
    const describe = composition.status.describe as Record<string, unknown>;
    assert.equal(describe.mode, 'live');
    assert.equal(describe.live, false, 'the execution gate NEVER flips');
    assert.ok(!JSON.stringify(composition.status).includes(LIVE_KEY), 'no key in the status');
  });

  test('an unregistered live composition still reports the configured mode honestly', () => {
    const cfg = loadConfig(baseEnv(db.dbUrl, { PAYSTACK_MODE: 'live', PAYSTACK_SECRET_KEY: '' }));
    const composition = composeBillingProvider(db.pool, cfg);
    assert.equal(composition.status.registered, false);
    assert.equal(composition.status.mode, 'live', 'mode is configuration, not registration state');
    assert.match(composition.status.reason, /PAYSTACK_SECRET_KEY is not set/);
    assert.equal(composition.status.describe, null);
  });

  test('the plan directory resolves each domain independently (same plan id, two epochs)', async () => {
    await retireActiveEpochs(db.pool);
    const shared = `PLN_shared_${Date.now()}`;
    const { epoch: testEpoch } = await insertEpoch(db.pool, { providerPlanId: shared, mode: 'test' });
    const { epoch: liveEpoch } = await insertEpoch(db.pool, { providerPlanId: shared, mode: 'live' });
    assert.notEqual(testEpoch.id, liveEpoch.id);

    const fromTest = await paystackPlanDirectory(db.pool, 'test').find(shared);
    const fromLive = await paystackPlanDirectory(db.pool, 'live').find(shared);
    assert.equal(fromTest?.mode, 'test', 'the test directory never selects the live epoch');
    assert.equal(fromLive?.mode, 'live', 'the live directory never selects the test epoch');
    assert.equal(fromTest?.id, testEpoch.id);
    assert.equal(fromLive?.id, liveEpoch.id);
  });

  test('the LIVE composition cannot check out a test-only plan epoch', async () => {
    await retireActiveEpochs(db.pool);
    // Elite × monthly: a TEST epoch only — no live elite epoch has ever
    // existed in this database (epochs are never deleted, only retired). A
    // live checkout that selected this row — or any other test epoch — would
    // be the cross-domain bug this test forbids; the mode-scoped directory
    // must MISS instead.
    await insertEpoch(db.pool, { plan: 'elite', interval: 'monthly', mode: 'test' });

    const user = await signedIn();
    const customer = await inject(user.cookie, '/api/billing/customer');
    assert.equal(customer.statusCode, 200, customer.body);
    const checkout = await inject(user.cookie, '/api/billing/checkout', {
      cataloguePlan: 'elite',
      interval: 'monthly',
    });
    assert.ok(
      checkout.statusCode >= 400,
      `a live deployment must never select a test epoch (got ${checkout.statusCode})`,
    );
    assert.match(checkout.json().error.message, /plan_not_registered/);

    // And the direction is symmetric: the test composition resolves the very
    // same test epoch the live composition just refused (sanity: the epoch is
    // findable in its own domain).
    const testDirectory = paystackPlanDirectory(db.pool, 'test');
    const found = await testDirectory.find(
      (await db.pool.query(
        `SELECT provider_plan_id FROM billing_provider_plans
          WHERE mode = 'test' AND catalogue_plan = 'elite' AND status = 'active'`,
      )).rows[0].provider_plan_id as string,
    );
    assert.equal(found?.mode, 'test');
    const liveDirectory = paystackPlanDirectory(db.pool, 'live');
    assert.equal(await liveDirectory.find(found!.providerPlanId), null, 'the live directory misses it');
  });
});

/* ========================================================================== */
/* 3. End-to-end: live customer → checkout → verify → activation             */
/* ========================================================================== */

describe('live end-to-end — every stage records the live domain', () => {
  test('provision → checkout → verify → evidence(provider_domain=live) → activation → confirmed', async () => {
    await retireActiveEpochs(db.pool);
    await insertEpoch(db.pool, { ...PRO_MONTHLY, mode: 'live' });

    const user = await signedIn();

    // (a) Provisioning: the live adapter creates a customer through the
    // injected transport; the row it writes is the local identity.
    const provision = await inject(user.cookie, '/api/billing/customer');
    assert.equal(provision.statusCode, 200, provision.body);
    const customers = (await db.pool.query(
      `SELECT provider_customer_code FROM billing_customers WHERE user_id = $1 AND provider = 'paystack'`,
      [user.id],
    )).rows as Array<{ provider_customer_code: string }>;
    assert.match(customers[0]?.provider_customer_code ?? '', /^CUS_live\d+$/, 'a fresh provider customer code');
    assert.ok(calls.some((c) => c.url.endsWith('/customer')), 'the live transport was used');

    // (b) Checkout: initialized against the LIVE epoch's provider plan id.
    const checkout = await inject(user.cookie, '/api/billing/checkout', PRO_MONTHLY);
    assert.equal(checkout.statusCode, 200, checkout.body);
    const session = checkout.json();
    assert.equal(session.status, 'initialized');
    const initCall = calls.find((c) => c.url.endsWith('/transaction/initialize'));
    assert.ok(initCall, 'checkout reached the transport');
    assert.equal(
      String(initCall.body?.amount),
      String(
        (await db.pool.query(
          `SELECT payment_amount_minor FROM billing_pricing_snapshots
            WHERE id = (SELECT locked_pricing_snapshot_id FROM subscriptions WHERE user_id = $1)`,
          [user.id],
        )).rows[0].payment_amount_minor,
      ),
      'the amount sent to the provider is the locked snapshot amount',
    );

    // The fake verify endpoint answers with the exact locked amount + live domain.
    const snap = (await db.pool.query(
      `SELECT p.idempotency_key, p.payment_amount_minor FROM billing_pricing_snapshots p
        WHERE p.id = (SELECT locked_pricing_snapshot_id FROM subscriptions WHERE user_id = $1)`,
      [user.id],
    )).rows[0] as { idempotency_key: string; payment_amount_minor: string };
    const localCustomer = (await db.pool.query(
      `SELECT provider_customer_id, provider_customer_code FROM billing_customers
        WHERE user_id = $1 AND provider = 'paystack'`,
      [user.id],
    )).rows[0] as { provider_customer_id: string | null; provider_customer_code: string | null };
    referenceEvidence.set(
      `ve-chk-${createHash('sha256').update(JSON.stringify(['billing-checkout/v1', user.id, snap.idempotency_key])).digest('hex')}`,
      {
        amount: Number(snap.payment_amount_minor),
        customerCode: localCustomer.provider_customer_code ?? '',
        customerId: localCustomer.provider_customer_id,
      },
    );

    // (c) Verification: the transaction answer carries domain "live" and the
    // live adapter accepts it; evidence is durable with provider_domain='live'.
    verifyDomain = 'live';
    const verify = await inject(user.cookie, '/api/billing/verify');
    assert.equal(verify.statusCode, 200, verify.body);
    const result = billingPaymentVerificationResultSchema.parse(verify.json());
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(result.evidence?.providerDomain, 'live');
    assert.equal(result.grantsExecution, false, 'evidence never grants execution');
    const evidence = (await db.pool.query(
      `SELECT provider_domain, provider FROM billing_verified_transactions WHERE user_id = $1`,
      [user.id],
    )).rows as Array<{ provider_domain: string; provider: string }>;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.provider_domain, 'live');
    assert.equal(evidence[0]?.provider, 'paystack');
    assert.ok(!verify.body.includes(LIVE_KEY), 'the response never carries the key');

    // (d) Wrong-domain refusal: a FRESH live checkout whose provider answers
    // domain "test" is refused — no silent cross-domain acceptance either way.
    await retireActiveEpochs(db.pool);
    await insertEpoch(db.pool, { ...PRO_MONTHLY, mode: 'live' });
    const user2 = await signedIn();
    assert.equal((await inject(user2.cookie, '/api/billing/customer')).statusCode, 200);
    const checkout2 = await inject(user2.cookie, '/api/billing/checkout', PRO_MONTHLY);
    assert.equal(checkout2.statusCode, 200, checkout2.body);
    const snap2 = (await db.pool.query(
      `SELECT p.idempotency_key, p.payment_amount_minor FROM billing_pricing_snapshots p
        WHERE p.id = (SELECT locked_pricing_snapshot_id FROM subscriptions WHERE user_id = $1)`,
      [user2.id],
    )).rows[0] as { idempotency_key: string; payment_amount_minor: string };
    const localCustomer2 = (await db.pool.query(
      `SELECT provider_customer_id, provider_customer_code FROM billing_customers
        WHERE user_id = $1 AND provider = 'paystack'`,
      [user2.id],
    )).rows[0] as { provider_customer_id: string | null; provider_customer_code: string | null };
    referenceEvidence.set(
      `ve-chk-${createHash('sha256').update(JSON.stringify(['billing-checkout/v1', user2.id, snap2.idempotency_key])).digest('hex')}`,
      {
        amount: Number(snap2.payment_amount_minor),
        customerCode: localCustomer2.provider_customer_code ?? '',
        customerId: localCustomer2.provider_customer_id,
      },
    );
    verifyDomain = 'test';
    const wrongDomain = await inject(user2.cookie, '/api/billing/verify');
    assert.ok(wrongDomain.statusCode >= 500, `expected a provider refusal, got ${wrongDomain.statusCode}`);
    const wrongEvidence = (await db.pool.query(
      `SELECT count(*)::int AS c FROM billing_verified_transactions WHERE user_id = $1`,
      [user2.id],
    )).rows[0] as { c: number };
    assert.equal(wrongEvidence.c, 0, 'a wrong-domain answer records nothing');
    assert.ok(!wrongDomain.body.includes('sk_live_'), 'no credential in the refusal');

    // (e) Activation: the operator service in configured live mode accepts the
    // live evidence and writes the activation fact.
    const evidenceId = (await db.pool.query(
      `SELECT id FROM billing_verified_transactions WHERE user_id = $1`,
      [user.id],
    )).rows[0].id as string;
    const activation = await new BillingActivationService({ db: db.pool, mode: 'live' }).activate({
      user: user.id,
      operatorId: 'ops-live-mode-test',
      reason: 'live-mode end-to-end test activation',
      evidenceId,
    });
    assert.equal(activation.outcome, 'activated');
    assert.equal(activation.replayed, false);

    // (f) The state now reports paymentConfirmed and the configured mode.
    const me = await app.inject({ method: 'GET', url: '/api/billing/me', headers: { cookie: user.cookie } });
    assert.equal(me.statusCode, 200, me.body);
    const state = me.json() as { mode: string; providerStatus: { paymentConfirmed: boolean } };
    assert.equal(state.mode, 'live', 'the status DTO carries the configured mode');
    assert.equal(state.providerStatus.paymentConfirmed, true, 'the activation fact confirms the payment');
    assert.ok(!me.body.includes(LIVE_KEY), 'the state response never carries the key');
  });

  test('activation in the WRONG mode refuses live evidence (no cross-domain activation)', async () => {
    // A FRESH subscription + live evidence that has never been activated: an
    // already-activated subscription would return an idempotent replay before
    // any mode check (by design — a replay writes nothing).
    const user = await insertUser(db.pool, false);
    const commercial = await seedCommercialSubscription(db.pool, user.id, { mode: 'live' });
    const { evidenceId } = await seedPaymentEvidence(db.pool, user.id, commercial, {
      providerDomain: 'live',
    });

    await assert.rejects(
      new BillingActivationService({ db: db.pool, mode: 'test' }).activate({
        user: user.id,
        operatorId: 'ops-wrong-mode',
        reason: 'cross-domain activation must be refused',
        evidenceId,
      }),
      (error: unknown) => {
        const reason = (error as { reason?: string }).reason;
        assert.equal(
          reason === 'payment_evidence_not_found' || reason === 'evidence_not_successful',
          true,
          `expected a typed domain refusal, got ${String(reason)}: ${String((error as Error).message)}`,
        );
        return true;
      },
    );

    // A refused activation leaves no trace at all.
    const activations = (await db.pool.query(
      `SELECT count(*)::int AS c FROM billing_subscription_activations WHERE user_id = $1`,
      [user.id],
    )).rows[0] as { c: number };
    assert.equal(activations.c, 0, 'a cross-domain activation must never write a fact');
  });
});

/* ========================================================================== */
/* 4. Live webhook delivery                                                   */
/* ========================================================================== */

describe('live webhook — signed with the live key, domain enforced', () => {
  async function seedWebhookOwner() {
    const user = await insertUser(db.pool, false);
    await db.pool.query(
      `INSERT INTO billing_customers (user_id, email, provider_customer_code)
       VALUES ($1, $2, 'CUS_fixture0000001')`,
      [user.id, user.email],
    );
    const { rows } = await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, catalogue_plan, billing_interval,
         currency, provider, provider_state)
       VALUES ($1, 'pro', 'active', 'pro', 'monthly', 'USD', 'paystack', 'pending')
       RETURNING id`,
      [user.id],
    );
    return { user, subscriptionId: rows[0].id as string };
  }

  const deliver = async (raw: string, ip: string) => app.inject({
    method: 'POST',
    url: '/api/billing/webhook',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signLive(raw) },
    payload: raw,
    remoteAddress: ip,
  });

  test('a live-domain delivery signed with the LIVE key is accepted and recorded', async () => {
    const { user, subscriptionId } = await seedWebhookOwner();
    const body = fixtureBody('charge-success-one-off');
    (body.data as Record<string, unknown>).domain = 'live';
    const raw = JSON.stringify(body);

    const result = await deliver(raw, nextWebhookIp());
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { status: 'recorded' });

    const { rows } = await db.pool.query(
      `SELECT event_type, status, user_id, subscription_id, failure_reason, payload_hash
         FROM billing_provider_events WHERE payload_hash = $1`,
      [billingEventPayloadHash(body)],
    );
    assert.equal(rows.length, 1);
    const row = rows[0] as Record<string, string | null>;
    assert.equal(row.event_type, 'payment.succeeded');
    assert.equal(row.status, 'received');
    assert.equal(row.user_id, user.id);
    assert.equal(row.subscription_id, subscriptionId);
    assert.equal(row.failure_reason, null);
    assert.ok(!result.body.includes('sk_live_'), 'the route never echoes a credential');
  });

  test('a test-domain delivery is refused by the live receiver (400 + evidence, no echo)', async () => {
    const body = fixtureBody('charge-success-one-off');
    (body.data as Record<string, unknown>).domain = 'test';
    const raw = JSON.stringify(body);

    const result = await deliver(raw, nextWebhookIp());
    assert.equal(result.statusCode, 400, result.body);

    const { rows } = await db.pool.query(
      `SELECT event_type, failure_reason FROM billing_provider_events WHERE payload_hash = $1`,
      [billingEventPayloadHash(body)],
    );
    assert.equal(rows.length, 1, 'the refusal is durable evidence');
    const row = rows[0] as { event_type: string; failure_reason: string | null };
    assert.equal(row.event_type, 'unrecognized');
    const reason = row.failure_reason ?? '';
    assert.ok(reason.length > 0 && reason.length <= 600);
    assert.match(reason, /domain/i);
    assert.equal(BILLING_CREDENTIAL_SHAPED_RE.test(reason), false, 'no credential-shaped material');
    assert.ok(!result.body.includes('sk_live_'), 'the refusal never echoes the key');
  });

  test('a delivery signed with the TEST key is rejected by the live receiver', async () => {
    const body = fixtureBody('charge-success-one-off');
    (body.data as Record<string, unknown>).domain = 'live';
    const raw = JSON.stringify(body);
    const wrongSignature = createHmac('sha512', TEST_KEY).update(raw).digest('hex');
    const result = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': wrongSignature },
      payload: raw,
      remoteAddress: nextWebhookIp(),
    });
    assert.equal(result.statusCode, 401);
    assert.equal(JSON.parse(result.body).error.code, 'unauthorized');
    assert.ok(!result.body.includes(TEST_KEY));
  });
});
