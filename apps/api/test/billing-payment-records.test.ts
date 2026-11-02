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
/**
 * The same app with a REAL log sink attached, so the logging path the other
 * apps suppress (`LOG_LEVEL: 'silent'`, and logging off outside production) is
 * actually exercised. `recordsOutcome` decides what the records read does.
 */
let loggingApp: Awaited<ReturnType<typeof buildApp>>;
let recordsOutcome: () => unknown = () => {
  throw credentialShapedRecordsError('28P01');
};
const capturedLogLines: string[] = [];
const logSink = {
  write: (line: string) => {
    capturedLogLines.push(String(line));
    return true;
  },
};

const SESSION_COOKIE = 've_session';
const ROUTE = '/api/billing/verified-payment-records';

/** Parse the captured pino lines and keep the ones this route wrote. */
function capturedLogs(): Record<string, any>[] {
  return capturedLogLines.map((line) => JSON.parse(line) as Record<string, any>);
}

function routeErrorLogs(): Record<string, any>[] {
  return capturedLogs().filter((entry) => entry.msg === 'verified payment records unavailable');
}

/** Assert the route logged exactly one error line and return it. */
function theRouteErrorLog(): Record<string, any> {
  const entries = routeErrorLogs();
  assert.equal(entries.length, 1, `expected one error line, got ${JSON.stringify(capturedLogLines)}`);
  const entry = entries[0];
  assert.ok(entry !== undefined, 'the captured error line is missing');
  return entry;
}

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

/* -------------------------------------------------------------------------- */
/* Credentials injected into failures — none may reach a log or a response    */
/* -------------------------------------------------------------------------- */

const SK_TEST = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const AUTH_CODE = 'AUTH_0123456789abcdef0123456789abcdef';
const DB_PASSWORD = 'sup3rs3cr3t';
const CONNECTION_STRING = `postgres://veltrix:${DB_PASSWORD}@db.internal.veltrixeye.internal:5432/veltrix`;
const BEARER_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
/**
 * A secret the DEPLOYMENT was configured with (`SMTP_PASS`). It matches no
 * credential shape at all, so only known-value redaction can remove it — this
 * is what proves the route scrubs configured secrets, not just known shapes.
 * `SMTP_HOST` stays empty, so no email provider is registered by setting it.
 */
const CONFIGURED_SECRET = 'smtp-configured-secret-value';

/**
 * A database failure carrying every credential shape at once, plus a stack
 * trace that repeats one of them. The route logs this failure; if it ever
 * hands the object (or its stack) to the logger, these values escape.
 */
function credentialShapedRecordsError(code?: string): Error {
  const err = new Error(
    'read failed sk_test_0123456789abcdef0123456789abcdef01234567 ' +
    `authorization_code=${AUTH_CODE} at ${CONNECTION_STRING} ` +
    `Authorization: Bearer ${BEARER_JWT} password=hunter2-hunter2 ` +
    `key=${CONFIGURED_SECRET} (records ledger read failed)`,
  ) as Error & { code?: string };
  if (code !== undefined) err.code = code;
  err.stack = `Error: read failed ${SK_TEST}\n    at Object.query (/app/node_modules/pg/lib/client.js:526:17)`;
  return err;
}

/** An unexpected database-level failure: a driver code plus the DSN. */
function unexpectedDatabaseError(): Error {
  const err = new Error(
    `terminating connection due to administrator command at ${CONNECTION_STRING} ` +
    `while holding ${SK_TEST} (records ledger read failed)`,
  ) as Error & { code: string };
  err.code = '57P01';
  err.stack = `Error: terminating connection at ${CONNECTION_STRING}\n    at Socket.<anonymous>`;
  return err;
}

/** Every value that must be absent from a log line and from a response body. */
const INJECTED_SECRETS: readonly string[] = [
  SK_TEST, AUTH_CODE, DB_PASSWORD, CONNECTION_STRING, BEARER_JWT, CONFIGURED_SECRET, 'hunter2-hunter2',
];

function assertNoCredentials(haystack: string, label: string): void {
  for (const secret of INJECTED_SECRETS) {
    assert.ok(
      !haystack.includes(secret),
      `${label} must not contain the injected secret ${secret.slice(0, 12)}…`,
    );
  }
  for (const [name, pattern] of [
    ['a provider test/live key', /sk_(?:test|live)_[A-Za-z0-9]{8,}/i],
    ['a provider authorization code', /AUTH_[A-Za-z0-9]{12,}/],
    ['a connection string with inline credentials', /postgres(?:ql)?:\/\/[^/\s@]*:[^/\s@]*@/i],
    ['a bearer token', /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
    ['a JSON web token', /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./],
    ['a password pair', /password\s*[=:]\s*(?!\[redacted\])\S+/i],
  ] as const) {
    assert.doesNotMatch(haystack, pattern, `${label} must not contain ${name}`);
  }
}

/**
 * Script the records read only; every other query — the session lookup most of
 * all — still goes to the real database, so authentication stays real and the
 * route is exercised end to end. Returning `undefined` runs the real query.
 */
function scriptedPool(pool: pg.Pool, respond: () => unknown): pg.Pool {
  const run = pool.query.bind(pool) as (text: string, values?: unknown[]) => Promise<unknown>;
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (sql: unknown, params?: unknown) => {
          if (typeof sql === 'string' && /FROM\s+billing_verified_transactions/i.test(sql)) {
            const scripted = respond();
            if (scripted !== undefined) return scripted;
          }
          return params === undefined ? run(sql as string) : run(sql as string, params as unknown[]);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as pg.Pool;
}

/** Throw a provider-shaped error only for the records read; auth remains real. */
function failingPool(pool: pg.Pool): pg.Pool {
  return scriptedPool(pool, () => {
    throw credentialShapedRecordsError();
  });
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

  // Same route, real logger: `SMTP_PASS` is a configured secret and the sink
  // captures everything the route writes, so the logging path is observable.
  const loggingConfig = config({ LOG_LEVEL: 'error', SMTP_PASS: CONFIGURED_SECRET });
  loggingApp = await buildApp(
    loggingConfig,
    createAppContext(scriptedPool(db.pool, () => recordsOutcome()), loggingConfig),
    { logger: { level: 'error', stream: logSink } },
  );
  await loggingApp.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await liveApp?.close();
  await failingApp?.close();
  await loggingApp?.close();
  await db?.stop();
});

beforeEach(async () => {
  await retireActiveEpochs(db.pool);
  // Every logging test starts from a clean sink and the credential failure.
  capturedLogLines.length = 0;
  recordsOutcome = () => {
    throw credentialShapedRecordsError('28P01');
  };
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

/**
 * Logging regression (security).
 *
 * The route above is proven to answer without leaking, but a leak through the
 * LOG sink is a different failure: the response can be clean while the
 * exception — with its stack and every property the driver attached — is
 * written to a stream that is shipped off the host. These tests attach a real
 * pino destination to the real app and assert on what the route writes, with
 * credential-shaped failure data flowing through the actual logging path.
 */

test('a failing read is logged without the raw exception, its stack or any credential', async () => {
  const owner = await user();
  const session = await ctx.sessions.create(owner.id, {});

  const res = await request(loggingApp, `${SESSION_COOKIE}=${session.token}`);

  // The caller still gets the fixed fail-closed answer, with nothing extra.
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS);
  forbiddenDisclosure(res.body);
  assertNoCredentials(res.body, 'the response body');

  // One error line was written, and it carries no credential.
  const entry = theRouteErrorLog();
  const serialized = JSON.stringify(entry);
  assertNoCredentials(serialized, 'the log line');
  assert.ok(!serialized.includes('stack'), 'the exception stack is never logged');
  assert.ok(!serialized.includes('client.js'), 'no stack frame is logged');
  assert.ok(!('err' in entry), 'the raw exception object is never attached to the log line');

  // Diagnostics survive: where it happened, and what the failure was.
  assert.equal(entry.msg, 'verified payment records unavailable');
  assert.equal(entry.route, ROUTE);
  assert.equal(entry.method, 'GET');
  assert.equal(entry.billingMode, 'test');
  assert.equal(typeof entry.requestId, 'string');
  assert.deepEqual(Object.keys(entry.error).sort(), ['code', 'message', 'type']);
  assert.equal(entry.error.type, 'Error');
  assert.equal(entry.error.code, '28P01', 'the driver code survives for the operator');
  assert.match(entry.error.message, /records ledger read failed/);
  assert.ok(!entry.error.message.includes(SK_TEST));
  assert.match(serialized, /\[redacted\]/, 'redaction is visible rather than silently dropped');
});

test('a malformed stored row fails closed and is logged as a redacted, stack-free diagnostic', async () => {
  const owner = await user();
  const session = await ctx.sessions.create(owner.id, {});
  // A row the projection must refuse: a non-positive amount, the wrong
  // exponent and a credential-shaped currency. The credential is the point —
  // a refused row's VALUE must not be logged, only the fact of the refusal.
  recordsOutcome = () => ({
    rows: [{
      payment_amount_minor: 0,
      payment_currency: SK_TEST,
      payment_amount_exponent: 3,
      paid_at: new Date('2026-10-14T10:00:00.000Z'),
      verified_at: new Date('2026-10-14T10:00:05.000Z'),
    }],
    rowCount: 1,
  });

  const res = await request(loggingApp, `${SESSION_COOKIE}=${session.token}`);

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS);
  assertNoCredentials(res.body, 'the response body');

  const entry = theRouteErrorLog();
  const serialized = JSON.stringify(entry);
  assertNoCredentials(serialized, 'the log line');
  assert.ok(!serialized.includes('stack'));
  assert.equal(entry.error.type, 'Error');
  assert.match(
    entry.error.message,
    /stored verified payment record is not usable/,
    'the reason survives for the operator',
  );
  assert.ok(!serialized.includes('2026-10-14'), 'the refused row value is not logged');
});

test('an unexpected database failure is logged with its driver code and without the connection string', async () => {
  const owner = await user();
  const session = await ctx.sessions.create(owner.id, {});
  recordsOutcome = () => {
    throw unexpectedDatabaseError();
  };

  const res = await request(loggingApp, `${SESSION_COOKIE}=${session.token}`);

  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS);
  forbiddenDisclosure(res.body);
  assert.doesNotMatch(res.body, /57P01|terminating connection|ECONNREFUSED/i);
  assertNoCredentials(res.body, 'the response body');

  const entry = theRouteErrorLog();
  const serialized = JSON.stringify(entry);
  assertNoCredentials(serialized, 'the log line');
  assert.ok(!serialized.includes('stack'));
  assert.equal(entry.error.code, '57P01');
  assert.match(entry.error.message, /terminating connection/);
  assert.ok(!serialized.includes(DB_PASSWORD));
});

test('a successful read writes no error line at all', async () => {
  const owner = await user();
  const commercial = await seedCommercialSubscription(db.pool, owner.id);
  await seedPaymentEvidence(db.pool, owner.id, commercial);
  recordsOutcome = () => undefined; // fall through to the real read

  const res = await request(loggingApp, owner.cookie);

  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().state, 'available');
  assert.deepEqual(routeErrorLogs(), [], 'a healthy read logs nothing');
  assert.deepEqual(capturedLogs(), [], 'nothing at all is written to the log sink');
});
