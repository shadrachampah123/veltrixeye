/**
 * Billing Step 9b-R1 — `GET /api/billing/verified-payment-records`.
 *
 * The route is an authenticated, read-only view over stored evidence only. These
 * integration tests use local embedded PostgreSQL and synthetic test/live rows
 * to pin session-user isolation, server-selected mode scoping, strict minimal
 * disclosure, bounded newest-first output and fail-closed behavior. No provider
 * is registered or contacted.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT,
  UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS,
  billingVerifiedPaymentRecordsDtoSchema,
} from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  insertUser,
  retireActiveEpochs,
  seedCommercialSubscription,
  seedPaymentEvidence,
  startBillingTestDb,
} from '../../../packages/core/test/helpers/billing-checkout.js';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let ctx: ReturnType<typeof createAppContext>;
let app: Awaited<ReturnType<typeof buildApp>>;
let liveApp: Awaited<ReturnType<typeof buildApp>>;
let failingApp: Awaited<ReturnType<typeof buildApp>>;

const SESSION_COOKIE = 've_session';
const ROUTE = '/api/billing/verified-payment-records';

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: db?.dbUrl ?? 'postgres://test:test@localhost/test',
    LOG_LEVEL: 'silent',
    COOKIE_SECURE: 'never',
    PAYSTACK_SECRET_KEY: '',
    ...overrides,
  });
}

/** Throw a provider-shaped error only for the records read; auth remains real. */
function failingPool(pool: pg.Pool): pg.Pool {
  const run = pool.query.bind(pool) as (text: string, values?: unknown[]) => Promise<unknown>;
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: unknown, params?: unknown) => {
          if (typeof sql === 'string' && /FROM\s+billing_verified_transactions/i.test(sql)) {
            throw new Error(
              'read failed sk_test_0123456789abcdef0123456789abcdef01234567 ' +
              'authorization_code=AUTH_0123456789abcdef0123456789abcdef',
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
  db = await startBillingTestDb(5531);
  const testConfig = config();
  ctx = createAppContext(db.pool, testConfig);
  app = await buildApp(testConfig, ctx);
  await app.ready();

  // This is a local mode-selection test only: an empty key means no provider is
  // registered, so PAYSTACK_MODE=live cannot make any external call.
  const liveConfig = config({ PAYSTACK_MODE: 'live' });
  liveApp = await buildApp(liveConfig, createAppContext(db.pool, liveConfig));
  await liveApp.ready();

  const failingConfig = config();
  failingApp = await buildApp(failingConfig, createAppContext(failingPool(db.pool), failingConfig));
  await failingApp.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await liveApp?.close();
  await failingApp?.close();
  await db?.stop();
});

beforeEach(async () => {
  await retireActiveEpochs(db.pool);
});

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

async function user(): Promise<{ id: string; email: string; cookie: string }> {
  const row = await insertUser(db.pool, false);
  const session = await ctx.sessions.create(row.id, {});
  return { ...row, cookie: `${SESSION_COOKIE}=${session.token}` };
}

function request(
  targetApp: typeof app,
  cookie = '',
  url = ROUTE,
  payload?: string | object,
) {
  const options = {
    method: 'GET' as const,
    url,
    headers: cookie === ''
      ? { 'x-forwarded-for': nextIp() }
      : { cookie, 'x-forwarded-for': nextIp() },
    ...(payload === undefined ? {} : { payload }),
  };
  return targetApp.inject(options);
}

async function response(targetApp: typeof app, cookie: string, url = ROUTE) {
  const res = await request(targetApp, cookie, url);
  assert.equal(res.statusCode, 200, res.body);
  return billingVerifiedPaymentRecordsDtoSchema.parse(res.json());
}

function forbiddenDisclosure(body: string): void {
  for (const [label, pattern] of [
    ['credential', /sk_test_|sk_live_|Bearer\b|authorization_code/i],
    ['provider or billing identity', /paystack|provider_reference|providerReference|provider_customer|subscriptionId/i],
    ['internal identifiers or hashes', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{64}/i],
    ['checkout or provider reference', /ve-chk-|PLN_|CUS_|SUB_/],
    ['provider/error payload', /AUTH_0123456789abcdef|read failed|"error"|"message"|"reason"/i],
    ['pricing or authorization detail', /pricingSnapshot|fxRate|idempotency|card|secret/i],
  ] as const) {
    assert.doesNotMatch(body, pattern, `response must not contain ${label}`);
  }
}

test('an unauthenticated caller is rejected before any billing records are disclosed', async () => {
  const res = await request(app);
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(res.json().error.code, 'unauthorized');
  assert.equal(res.json().records, undefined);
});

test('records are isolated by authenticated user and server-selected provider mode', async () => {
  const testOwner = await user();
  const testCommercial = await seedCommercialSubscription(db.pool, testOwner.id, { mode: 'test' });
  await seedPaymentEvidence(db.pool, testOwner.id, testCommercial, { paidAt: new Date('2026-10-14T10:00:00.000Z') });

  const anotherTestOwner = await user();
  const anotherTestCommercial = await seedCommercialSubscription(db.pool, anotherTestOwner.id, { mode: 'test' });
  await seedPaymentEvidence(db.pool, anotherTestOwner.id, anotherTestCommercial, {
    paidAt: new Date('2026-10-15T10:00:00.000Z'),
  });

  const liveOwner = await user();
  const liveCommercial = await seedCommercialSubscription(db.pool, liveOwner.id, { mode: 'live' });
  await seedPaymentEvidence(db.pool, liveOwner.id, liveCommercial, {
    providerDomain: 'live',
    paidAt: new Date('2026-10-16T10:00:00.000Z'),
  });

  const testView = await response(app, testOwner.cookie);
  assert.equal(testView.state, 'available');
  if (testView.state !== 'available') assert.fail('expected test-mode records');
  assert.equal(testView.mode, 'test');
  assert.deepEqual(testView.records.map(({ paidAt }) => paidAt), ['2026-10-14T10:00:00.000Z']);
  assert.equal(testView.records[0]?.amountMinor, testCommercial.amountMinor, 'amount is the stored GHS minor-unit fact');

  const otherTenantView = await response(app, anotherTestOwner.cookie);
  assert.equal(otherTenantView.state, 'available');
  if (otherTenantView.state !== 'available') assert.fail('expected available response');
  assert.deepEqual(otherTenantView.records.map(({ paidAt }) => paidAt), ['2026-10-15T10:00:00.000Z']);

  const testModeDoesNotShowLive = await response(app, liveOwner.cookie);
  assert.equal(testModeDoesNotShowLive.state, 'available');
  if (testModeDoesNotShowLive.state !== 'available') assert.fail('expected available response');
  assert.equal(testModeDoesNotShowLive.mode, 'test');
  assert.deepEqual(testModeDoesNotShowLive.records, []);

  const liveView = await response(liveApp, liveOwner.cookie);
  assert.equal(liveView.state, 'available');
  if (liveView.state !== 'available') assert.fail('expected live-mode records');
  assert.equal(liveView.mode, 'live');
  assert.deepEqual(liveView.records.map(({ paidAt }) => paidAt), ['2026-10-16T10:00:00.000Z']);

  const liveModeDoesNotShowTest = await response(liveApp, testOwner.cookie);
  assert.equal(liveModeDoesNotShowTest.state, 'available');
  if (liveModeDoesNotShowTest.state !== 'available') assert.fail('expected available response');
  assert.deepEqual(liveModeDoesNotShowTest.records, []);
});

test('identity, mode and provider query/body values cannot change the subject or scope', async () => {
  const victim = await user();
  const victimCommercial = await seedCommercialSubscription(db.pool, victim.id);
  const victimEvidence = await seedPaymentEvidence(db.pool, victim.id, victimCommercial, {
    providerReference: `${victimCommercial.reference}-victim`,
  });
  const caller = await user();

  const res = await request(
    app,
    caller.cookie,
    `${ROUTE}?userId=${victim.id}&subscriptionId=${victimCommercial.subscriptionId}&mode=live&provider=paystack`,
    { userId: victim.id, mode: 'live', providerReference: 'forged' },
  );
  assert.equal(res.statusCode, 200, res.body);
  const ownRecords = billingVerifiedPaymentRecordsDtoSchema.parse(res.json());
  assert.equal(ownRecords.state, 'available');
  if (ownRecords.state !== 'available') assert.fail('expected available response');
  assert.equal(ownRecords.mode, 'test');
  assert.deepEqual(ownRecords.records, []);
  forbiddenDisclosure(res.body);

  // The victim's record remains available only to the victim's session.
  const victimRecords = await response(app, victim.cookie);
  assert.equal(victimRecords.state, 'available');
  if (victimRecords.state !== 'available') assert.fail('expected available response');
  assert.equal(victimRecords.records.length, 1);
  assert.doesNotMatch(JSON.stringify(ownRecords), new RegExp(victimEvidence.evidenceId));
});

test('the response is newest-first and never exceeds the fixed page limit', async () => {
  const owner = await user();
  const commercial = await seedCommercialSubscription(db.pool, owner.id);
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const expectedPaidAt: string[] = [];

  for (let index = 0; index < BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT + 2; index += 1) {
    const paidAt = new Date(start + index * 60_000);
    expectedPaidAt.push(paidAt.toISOString());
    await seedPaymentEvidence(db.pool, owner.id, commercial, {
      providerReference: `${commercial.reference}-page-${index}`,
      paidAt,
    });
  }

  const records = await response(app, owner.cookie);
  assert.equal(records.state, 'available');
  if (records.state !== 'available') assert.fail('expected available response');
  assert.equal(records.records.length, BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT);
  assert.equal(records.hasMore, true);
  assert.deepEqual(
    records.records.map(({ paidAt }) => paidAt),
    expectedPaidAt.slice(2).reverse(),
    'the newest 25 are returned in descending paid-at order',
  );
});

test('failure returns the fixed unavailable DTO and leaks no database/provider detail', async () => {
  const owner = await user();
  const failingSession = await ctx.sessions.create(owner.id, {});
  const cookie = `${SESSION_COOKIE}=${failingSession.token}`;
  const res = await request(failingApp, cookie);

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS);
  forbiddenDisclosure(res.body);
  assert.doesNotMatch(res.body, /AUTH_0123456789abcdef|read failed|ECONNREFUSED/i);
});

test('no mutation or invoice route is added to the read-only records surface', async () => {
  const owner = await user();
  const evidenceBefore = await db.pool.query(
    'SELECT count(*)::int AS count FROM billing_verified_transactions WHERE user_id = $1',
    [owner.id],
  );
  const responseBefore = await response(app, owner.cookie);
  const evidenceAfter = await db.pool.query(
    'SELECT count(*)::int AS count FROM billing_verified_transactions WHERE user_id = $1',
    [owner.id],
  );
  assert.deepEqual(evidenceAfter.rows, evidenceBefore.rows, 'GET writes no evidence');
  assert.deepEqual(responseBefore.records, []);

  const post = await app.inject({
    method: 'POST', url: ROUTE,
    headers: { cookie: owner.cookie, 'x-forwarded-for': nextIp() },
    payload: { amountMinor: 1 },
  });
  assert.equal(post.statusCode, 404, 'no write verb exists for the records resource');

  const invoices = await app.inject({
    method: 'GET', url: '/api/billing/invoices',
    headers: { cookie: owner.cookie, 'x-forwarded-for': nextIp() },
  });
  assert.equal(invoices.statusCode, 404, 'this is not an invoice endpoint');
});
