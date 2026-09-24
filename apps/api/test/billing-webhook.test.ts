import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { billingEventPayloadHash } from '@veltrixeye/core';
import { BILLING_CREDENTIAL_SHAPED_RE, BILLING_PROVIDER } from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  PAYSTACK_DOCUMENTED_WEBHOOK_SOURCE_IPS,
  parsePaystackWebhookAllowList,
  webhookIpAllowed,
} from '../src/webhook-allowlist.js';
import { startBillingTestDb, insertUser } from '../../../packages/core/test/helpers/billing-checkout.js';

/* ==========================================================================
   Billing Step 5.2 — the secure webhook ROUTE (apps/api integration).

   Exercises POST /api/billing/webhook end-to-end against a real database and
   the REAL Paystack adapter's Step 5.1 normalizer (fake nothing below the
   signature): signature verification over the raw body, the documented
   source-IP allow-list, the per-route rate limit, replay collapse onto the
   0031 ledger, refused-delivery evidence, and the redaction posture.
   ========================================================================== */

const SECRET = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const ROUTE = '/api/billing/webhook';
const RATE_LIMIT_MAX = 5;

/** Test networks admitted by the allow-list in these tests. */
const ALLOWED_IPS = '127.0.0.1, ::1, 192.0.2.0/24, 198.51.100.0/24';
/** An IP outside every allow-list entry (TEST-NET-3, documentation space). */
const OUTSIDER_IP = '203.0.113.9';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(
  here, '..', '..', '..', 'packages', 'providers', 'paystack', 'test', 'fixtures', 'webhook',
);
const fixtureBody = (name: string): Record<string, unknown> =>
  (JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8')) as { body: Record<string, unknown> }).body;

/** Values that exist only inside fixture payloads — they must never surface. */
const SENTINELS = [
  'AUTH_DO_NOT_PERSIST',
  'SIG_DO_NOT_PERSIST',
  'DONOTPERSISTemailtoken',
  'do-not-persist@example.com',
  'sk_test_DONOTPERSISTME',
  '203.0.113.7',
];

const sign = (raw: string | Buffer): string => createHmac('sha512', SECRET).update(raw).digest('hex');

const configWith = (dbUrl: string, overrides: Record<string, string> = {}) => loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: dbUrl,
  LOG_LEVEL: 'silent',
  COOKIE_SECURE: 'never',
  PAYSTACK_SECRET_KEY: SECRET,
  PAYSTACK_WEBHOOK_ALLOWED_IPS: ALLOWED_IPS,
  PAYSTACK_WEBHOOK_RATE_LIMIT_MAX: String(RATE_LIMIT_MAX),
  PUBLIC_APPLICATION_ORIGIN: 'https://app.example.test',
  ...overrides,
});

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let app: Awaited<ReturnType<typeof buildApp>>;
let keylessApp: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  db = await startBillingTestDb(5498);
  const cfg = configWith(db.dbUrl);
  app = await buildApp(cfg, createAppContext(db.pool, cfg));
  await app.ready();
  // Same database, but NO sandbox key: the receiver (and its route) must not
  // exist at all — the fail-closed posture billing-composition documents.
  const keyless = configWith(db.dbUrl, { PAYSTACK_SECRET_KEY: '' });
  keylessApp = await buildApp(keyless, createAppContext(db.pool, keyless));
  await keylessApp.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await keylessApp?.close();
  await db?.stop();
});

beforeEach(async () => {
  // 0031 retention: unprocessed events cannot be deleted — move them to a
  // terminal state first (test hygiene only; production keeps them).
  await db.pool.query(
    `UPDATE billing_provider_events SET status = 'processed', processed_at = now() WHERE status = 'received'`,
  );
  await db.pool.query('DELETE FROM billing_provider_events');
  await db.pool.query(`DELETE FROM subscriptions WHERE provider = $1`, [BILLING_PROVIDER]);
  await db.pool.query('DELETE FROM billing_customers');
});

/**
 * Each delivery comes from its own address inside the allowed test CIDR: the
 * route rate-limits per IP, and sharing one address across tests would exhaust
 * the budget mid-suite. Rotation also exercises the CIDR allow-list entry.
 */
let nextHostOctet = 20;
const nextAllowedIp = (): string => `192.0.2.${nextHostOctet++}`;

/** POST a delivery from `ip` with a raw body + its signature. */
async function deliver(options: {
  target?: typeof app;
  ip?: string;
  raw: string | Buffer;
  signature?: string | string[] | null;
  headers?: Record<string, string>;
}) {
  const headers: Record<string, string | string[]> = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  };
  if (options.signature !== null) {
    headers['x-paystack-signature'] = options.signature ?? sign(options.raw);
  }
  return (options.target ?? app).inject({
    method: 'POST',
    url: ROUTE,
    headers,
    payload: options.raw,
    remoteAddress: options.ip ?? nextAllowedIp(),
  });
}

async function ledgerRows() {
  const { rows } = await db.pool.query(
    `SELECT event_type, payload_hash, subscription_id, user_id, provider_customer_id,
            provider_subscription_id, provider_reference, status, failure_reason
       FROM billing_provider_events ORDER BY created_at`,
  );
  return rows as Array<Record<string, string | null>>;
}

/** Seed the checkout-shaped local state an event resolves against. */
async function seedOwner() {
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
  return { user, subscriptionId: rows[0]!.id as string };
}

/* -------------------------------------------------------------------------- */

describe('Step 5.2 route — existence and gating', () => {
  test('with no sandbox key configured the endpoint does not exist (404)', async () => {
    const body = JSON.stringify(fixtureBody('charge-success-one-off'));
    const result = await keylessApp.inject({
      method: 'POST', url: ROUTE,
      headers: { 'content-type': 'application/json', 'x-paystack-signature': sign(body) },
      payload: body,
    });
    assert.equal(result.statusCode, 404);
    assert.equal((await ledgerRows()).length, 0);
  });

  test('only POST exists at the webhook path', async () => {
    assert.equal((await app.inject({ method: 'GET', url: ROUTE, remoteAddress: '192.0.2.10' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `${ROUTE}/other`, remoteAddress: '192.0.2.10' })).statusCode, 404);
  });
});

describe('Step 5.2 route — signature verification over the raw body', () => {
  test('a correctly signed, supported delivery is acknowledged and recorded', async () => {
    const { user, subscriptionId } = await seedOwner();
    const body = fixtureBody('charge-success-one-off');
    const raw = JSON.stringify(body);
    const result = await deliver({ raw });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(JSON.parse(result.body), { status: 'recorded' });

    const rows = await ledgerRows();
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.event_type, 'payment.succeeded');
    assert.equal(row.status, 'received');
    // Local subject resolution bound the pair BEFORE the insert.
    assert.equal(row.user_id, user.id);
    assert.equal(row.subscription_id, subscriptionId);
    // Traceability references, canonical hash — and no payload at rest.
    assert.equal(row.provider_customer_id, 'CUS_fixture0000001');
    assert.equal(row.provider_reference, 've-chk-fixture-0003');
    assert.equal(row.payload_hash, billingEventPayloadHash(body));
    assert.equal(row.failure_reason, null);
  });

  test('a replay collapses onto the same ledger row (2xx both times)', async () => {
    await seedOwner();
    const raw = JSON.stringify(fixtureBody('charge-success-one-off'));
    assert.equal((await deliver({ raw })).statusCode, 200);
    const replay = await deliver({ raw });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(JSON.parse(replay.body), { status: 'replayed' });
    assert.equal((await ledgerRows()).length, 1);
  });

  test('a wrong signature is 401 and writes nothing', async () => {
    const raw = JSON.stringify(fixtureBody('charge-success-one-off'));
    const good = sign(raw);
    const wrong = good.slice(0, -2) + (good.endsWith('00') ? '11' : '00');
    const result = await deliver({ raw, signature: wrong });
    assert.equal(result.statusCode, 401);
    assert.equal(JSON.parse(result.body).error.code, 'unauthorized');
    // The response never echoes the signature or the payload.
    assert.ok(!result.body.includes(good));
    assert.ok(!result.body.includes('charge.success'));
    assert.equal((await ledgerRows()).length, 0);
  });

  test('a missing or non-single signature header is the same 401', async () => {
    const raw = JSON.stringify(fixtureBody('charge-success-one-off'));
    assert.equal((await deliver({ raw, signature: null })).statusCode, 401);
    const doubled = await deliver({ raw, signature: [sign(raw), sign(raw)] });
    assert.equal(doubled.statusCode, 401);
    assert.equal((await ledgerRows()).length, 0);
  });

  test('the signature covers the EXACT bytes: re-serialized JSON does not verify', async () => {
    await seedOwner();
    const body = fixtureBody('charge-success-one-off');
    const rekeyed = JSON.stringify({ data: body.data, event: body.event }); // same JSON, other key order
    const result = await deliver({ raw: rekeyed, signature: sign(JSON.stringify(body)) });
    assert.equal(result.statusCode, 401);
    assert.equal((await ledgerRows()).length, 0);
  });
});

describe('Step 5.2 route — the documented source-IP allow-list', () => {
  test('a delivery from outside the allow-list is 403 before any processing', async () => {
    const raw = JSON.stringify(fixtureBody('charge-success-one-off'));
    const result = await deliver({ raw, ip: OUTSIDER_IP });
    assert.equal(result.statusCode, 403);
    assert.equal(JSON.parse(result.body).error.code, 'forbidden');
    assert.equal((await ledgerRows()).length, 0);
  });

  test('X-Forwarded-For cannot launder an outside address into the allow-list', async () => {
    const raw = JSON.stringify(fixtureBody('charge-success-one-off'));
    const result = await deliver({
      raw, ip: OUTSIDER_IP, headers: { 'x-forwarded-for': '192.0.2.77' },
    });
    assert.equal(result.statusCode, 403);
    assert.equal((await ledgerRows()).length, 0);
  });

  test('the allow-list primitives pin the documented provider addresses', () => {
    const documented = parsePaystackWebhookAllowList('');
    assert.deepEqual(
      documented.map((entry) => entry.raw).sort(),
      [...PAYSTACK_DOCUMENTED_WEBHOOK_SOURCE_IPS].sort(),
    );
    for (const ip of PAYSTACK_DOCUMENTED_WEBHOOK_SOURCE_IPS) {
      assert.equal(webhookIpAllowed(ip, documented), true, ip);
    }
    assert.equal(webhookIpAllowed(OUTSIDER_IP, documented), false);
    assert.equal(webhookIpAllowed('52.31.139.76', documented), false);
    // CIDR + IPv6 handling.
    const cidr = parsePaystackWebhookAllowList('192.0.2.0/24, 2001:db8::/32');
    assert.equal(webhookIpAllowed('192.0.2.250', cidr), true);
    assert.equal(webhookIpAllowed('192.0.3.1', cidr), false);
    assert.equal(webhookIpAllowed('2001:db8::1', cidr), true);
    assert.equal(webhookIpAllowed('2001:db9::1', cidr), false);
    // A /0 would admit everything and is refused at parse time.
    assert.throws(() => parsePaystackWebhookAllowList('0.0.0.0/0'));
    assert.throws(() => parsePaystackWebhookAllowList('::/0'));
    assert.throws(() => parsePaystackWebhookAllowList('not-an-ip'));
  });

  test('loadConfig fails the boot on an unusable allow-list', () => {
    assert.throws(() => configWith(db.dbUrl, { PAYSTACK_WEBHOOK_ALLOWED_IPS: '10.0.0.0/0' }));
    assert.throws(() => configWith(db.dbUrl, { PAYSTACK_WEBHOOK_ALLOWED_IPS: 'definitely-not-an-ip' }));
  });
});

describe('Step 5.2 route — rate limiting', () => {
  test('deliveries beyond the per-IP budget are 429 (unsigned flood stops here)', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: {} });
    const ip = '198.51.100.200'; // its own bucket
    for (let attempt = 0; attempt < RATE_LIMIT_MAX; attempt += 1) {
      const result = await deliver({ raw, signature: '0'.repeat(128), ip });
      assert.equal(result.statusCode, 401, `attempt ${attempt}`);
    }
    const limited = await deliver({ raw, signature: '0'.repeat(128), ip });
    assert.equal(limited.statusCode, 429);
    assert.equal(JSON.parse(limited.body).error.code, 'rate_limited');
    assert.equal((await ledgerRows()).length, 0);
  });
});

describe('Step 5.2 route — refused deliveries are recorded as evidence', () => {
  test('an unsupported event is acknowledged and stored as unrecognized', async () => {
    const body = fixtureBody('subscription-expiring-cards');
    const raw = JSON.stringify(body);
    const result = await deliver({ raw });
    assert.equal(result.statusCode, 200, result.body);
    const rows = await ledgerRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_type, 'unrecognized');
    assert.equal(rows[0]!.failure_reason, null); // unsupported is not an error
    assert.equal(rows[0]!.payload_hash, billingEventPayloadHash(body));
  });

  test('a signed body that is not JSON is 400, recorded with a safe reason', async () => {
    const raw = '{{ definitely not JSON';
    const result = await deliver({ raw });
    assert.equal(result.statusCode, 400);
    assert.equal(JSON.parse(result.body).error.code, 'invalid_input');
    const rows = await ledgerRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.event_type, 'unrecognized');
    assert.match(rows[0]!.failure_reason ?? '', /not parseable JSON/);
    assert.equal(rows[0]!.payload_hash, billingEventPayloadHash(raw));
  });

  test('a supported event with a refused payload (non-sandbox domain) is 400 + evidence', async () => {
    const body = fixtureBody('charge-success-one-off');
    (body.data as Record<string, unknown>).domain = 'live';
    const raw = JSON.stringify(body);
    const result = await deliver({ raw });
    assert.equal(result.statusCode, 400);
    const rows = await ledgerRows();
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.event_type, 'unrecognized');
    const reason = row.failure_reason;
    assert.ok(reason !== null && reason !== undefined && reason.length > 0, 'a refusal reason must be recorded');
    assert.ok(reason!.length <= 600);
    // The refusal reason names the problem, never credential-shaped material.
    assert.equal(BILLING_CREDENTIAL_SHAPED_RE.test(reason!), false);
    assert.match(reason!, /domain/i);
  });
});

describe('Step 5.2 route — payload and secret hygiene', () => {
  test('nothing stored by the route carries fixture sentinel material', async () => {
    await seedOwner();
    for (const fixture of ['charge-success-one-off', 'invoice-payment-failed']) {
      await deliver({ raw: JSON.stringify(fixtureBody(fixture)) });
    }
    const raw = '{{ not json';
    await deliver({ raw });
    const { rows } = await db.pool.query(
      `SELECT row_to_json(billing_provider_events)::text AS dump FROM billing_provider_events`,
    );
    for (const { dump } of rows as Array<{ dump: string }>) {
      for (const sentinel of SENTINELS) {
        assert.ok(!dump.includes(sentinel), `ledger carries ${sentinel}`);
      }
    }
  });

  test('an oversized body is 413 before any handler runs', async () => {
    const raw = JSON.stringify({ event: 'charge.success', padding: 'x'.repeat(300_000) });
    const result = await deliver({ raw });
    assert.equal(result.statusCode, 413);
    assert.equal((await ledgerRows()).length, 0);
  });
});
