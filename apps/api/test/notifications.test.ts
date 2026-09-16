/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * M7.3 — alert delivery over HTTP: outbox hand-off, owner scoping, the
 * internal worker endpoints and credential hygiene.
 *
 * Every test runs a real Fastify app against a real PostgreSQL, and the
 * pipeline is exercised end to end:
 *
 *   POST /setups/:id/alerts → one outbox job (no I/O) →
 *   POST /api/internal/notifications/deliveries/run → delivered
 *
 * Covered:
 *  1. an alert creates exactly one delivery job; a replay never duplicates it
 *  2. generation delivers nothing itself (even with SMTP configured)
 *  3. owner scoping + authentication on every notification route
 *  4. the internal endpoints are unreachable without the shared secret
 *  5. the worker endpoints accept only a batch size — never content
 *  6. no credential, recipient or provider error reaches any response
 *  7. acknowledgement and the M6 alert surface are unchanged
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import {
  alertGenerateResponseSchema,
  notificationListResponseSchema,
  notificationMaintenanceResponseSchema,
  notificationRunResponseSchema,
} from '@veltrixeye/contracts';
import {
  CandleStore,
  createPool,
  DeliveryWorker,
  MIGRATIONS_DIR,
  runMigrations,
  type NotificationProvider,
  type NotificationSendRequest,
  type NotificationSendResult,
} from '@veltrixeye/core';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5443;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_notifications';

/** The shared secret for the internal worker routes in this suite. */
const WORKER_TOKEN = 'test-worker-token-value';
/** A fake SMTP password: the string that must never appear in a response. */
const SMTP_SECRET = 'smtp-secret-DO-NOT-LEAK';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let store: CandleStore;
let databaseUrl = '';

/** Default deployment: no SMTP credentials, no worker token. */
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
/** SMTP configured (secrets present) + worker token — for the leak/honesty tests. */
let adminApp: Awaited<ReturnType<typeof buildApp>>;
let adminCtx: ReturnType<typeof createAppContext>;
/** Worker token but no SMTP — a fake provider is registered by the test. */
let workerApp: Awaited<ReturnType<typeof buildApp>>;
let workerCtx: ReturnType<typeof createAppContext>;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `notif_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () =>
  `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4997',
  HOST: '127.0.0.1',
  DATABASE_SSL_MODE: 'disable',
  SESSION_COOKIE_NAME: 've_session',
  COOKIE_SECURE: 'never',
  SESSION_TTL_DAYS: '30',
  LOG_LEVEL: 'silent',
};

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...TEST_ENV, ...overrides } as NodeJS.ProcessEnv);
}

function cookieFrom(res: { headers: Record<string, string | number | string[] | undefined> }): string {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    const [pair] = String(c ?? '').split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(eq + 1).trim().length > 0) return pair;
  }
  return '';
}

const HOUR = 3_600_000;
const AS_OF = 1_700_000_000_000;

type Shape = [number, number, number, number];
const FLAT_16: Shape[] = Array.from({ length: 16 }, () => [100, 100.5, 99.5, 100] as Shape);
const BULLISH_SHAPES: Shape[] = [...FLAT_16, [101, 101.2, 100, 100.2], [100, 101.5, 99.9, 101.3]];

const RISK_LOW = {
  minRr: 2,
  stopLossMethod: 'fixed' as const,
  stopLossBuffer: 1,
  stopLossBufferUnit: 'pips' as const,
  takeProfitMethod: 'rr' as const,
  tp1Rr: 1,
  tp2Rr: 2,
  tp3Rr: 3,
  minQualityScore: 0,
};

function engulfConfig(symbol: string, risk: typeof RISK_LOW = RISK_LOW) {
  return {
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol }] },
    sessionFilters: [],
    risk,
    filters: [],
    ruleGroups: [
      {
        name: 'entry',
        logic: 'AND',
        position: 0,
        conditions: [
          {
            conditionType: 'engulfing_candle',
            classification: 'required',
            timeframeRole: 'setup',
            params: { direction: 'bullish' },
            position: 0,
          },
        ],
      },
    ],
  };
}

async function registerUser(target: Awaited<ReturnType<typeof buildApp>> = app): Promise<{
  cookie: string;
  userId: string;
  email: string;
}> {
  const email = uniqueEmail();
  const res = await target.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email, password: PASSWORD, name: 'Notification Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { cookie: cookieFrom(res), userId: res.json().user.id, email };
}

async function createPublishedVersion(
  cookie: string,
  config: any,
  target: Awaited<ReturnType<typeof buildApp>> = app,
): Promise<{ strategyId: string; versionId: string }> {
  const created = await target.inject({
    method: 'POST',
    url: '/api/strategies',
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { name: `Notif strategy ${randomBytes(4).toString('hex')}`, version: config },
  });
  assert.equal(created.statusCode, 201, created.body);
  const strategy = created.json().strategy;
  const version = strategy.versions[0];
  const published = await target.inject({
    method: 'POST',
    url: `/api/strategies/${strategy.id}/versions/${version.id}/publish`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
  });
  assert.equal(published.statusCode, 200, published.body);
  return { strategyId: strategy.id, versionId: version.id };
}

async function seedCandles(symbol: string, shapes: Shape[], anchor: number): Promise<void> {
  const instrument = await store.resolveInstrument('forex', symbol);
  assert.ok(instrument);
  await store.upsertCandles({
    instrumentId: instrument.id,
    timeframe: '1h',
    providerSlug: 'test-fixture',
    candles: shapes.map(([o, h, l, c], idx) => ({
      time: anchor - (shapes.length - idx) * HOUR,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: null,
    })),
  });
}

async function detectSetup(
  cookie: string,
  strategyId: string,
  versionId: string,
  symbol: string,
  asOf: number,
  target: Awaited<ReturnType<typeof buildApp>> = app,
): Promise<string> {
  const res = await target.inject({
    method: 'POST',
    url: `/api/strategies/${strategyId}/versions/${versionId}/detect`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { instrument: { assetClass: 'forex', symbol }, direction: 'long', asOf },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().detections[0].setup.id as string;
}

async function scoreSetup(
  cookie: string,
  setupId: string,
  target: Awaited<ReturnType<typeof buildApp>> = app,
): Promise<void> {
  const res = await target.inject({
    method: 'POST',
    url: `/api/setups/${setupId}/score`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function generateAlert(
  cookie: string,
  setupId: string,
  target: Awaited<ReturnType<typeof buildApp>> = app,
  payload: Record<string, unknown> = {},
) {
  return target.inject({
    method: 'POST',
    url: `/api/setups/${setupId}/alerts`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload,
  });
}

/**
 * register → version → candles → detect → score → generate (returns the alert).
 *
 * Uses a real platform instrument (M7.2 rejects unknown symbols at version
 * write time) and a fresh strategy per call, so the M4 detection key
 * (version, instrument, direction, asOf) is always new.
 */
async function fullWorkflow(
  target: Awaited<ReturnType<typeof buildApp>> = app,
  symbol = 'EURUSD',
): Promise<{ cookie: string; userId: string; email: string; setupId: string; alertId: string }> {
  const owner = await registerUser(target);
  const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig(symbol), target);
  await seedCandles(symbol, BULLISH_SHAPES, AS_OF);
  const setupId = await detectSetup(owner.cookie, strategyId, versionId, symbol, AS_OF, target);
  await scoreSetup(owner.cookie, setupId, target);
  const generated = await generateAlert(owner.cookie, setupId, target);
  assert.equal(generated.statusCode, 201, generated.body);
  return { cookie: owner.cookie, userId: owner.userId, email: owner.email, setupId, alertId: generated.json().alert.id };
}

/**
 * A throwaway app with its own (empty) provider registry. Tests that register
 * a provider use this so they cannot leak state into the shared app.
 */
async function makeWorkerApp(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: ReturnType<typeof createAppContext>;
  close: () => Promise<void>;
}> {
  const config = makeConfig({ DATABASE_URL: databaseUrl, NOTIFICATION_WORKER_TOKEN: WORKER_TOKEN });
  const context = createAppContext(pool, config);
  const app = await buildApp(config, context);
  await app.ready();
  return { app, ctx: context, close: () => app.close().then(() => undefined) };
}

function jobsForAlert(alertId: string) {
  return pool.query<any>('SELECT * FROM notification_deliveries WHERE alert_id = $1 ORDER BY created_at', [alertId]);
}

function countRows(table: string): Promise<number> {
  return pool
    .query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)
    .then((r) => Number(r.rows[0]?.n ?? '0'));
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-notifications-api');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  databaseUrl = db.dbUrl;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  store = new CandleStore(pool);

  const base = { DATABASE_URL: db.dbUrl };
  const plain = makeConfig(base);
  ctx = createAppContext(pool, plain);
  app = await buildApp(plain, ctx);
  await app.ready();

  const withSmtp = makeConfig({
    ...base,
    NOTIFICATION_WORKER_TOKEN: WORKER_TOKEN,
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'api-key-user',
    SMTP_PASS: SMTP_SECRET,
    NOTIFICATION_FROM: 'VeltrixEye Alerts <alerts@example.com>',
  });
  adminCtx = createAppContext(pool, withSmtp);
  adminApp = await buildApp(withSmtp, adminCtx);
  await adminApp.ready();

  const workerOnly = makeConfig({ ...base, NOTIFICATION_WORKER_TOKEN: WORKER_TOKEN });
  workerCtx = createAppContext(pool, workerOnly);
  workerApp = await buildApp(workerOnly, workerCtx);
  await workerApp.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await adminApp?.close();
  await workerApp?.close();
  await pool?.end();
  await stopDb?.();
});

/* -------------------------------------------------------------------------- */
/* Outbox hand-off                                                             */
/* -------------------------------------------------------------------------- */

describe('m7.3 alert → outbox hand-off', () => {
  test('generating an alert enqueues exactly one pending email job', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF);
    await scoreSetup(owner.cookie, setupId);

    const before = await countRows('notification_deliveries');
    const generated = await generateAlert(owner.cookie, setupId);
    assert.equal(generated.statusCode, 201, generated.body);
    const alertId = generated.json().alert.id as string;

    const rows = (await jobsForAlert(alertId)).rows;
    assert.equal(rows.length, 1, 'exactly one delivery job per alert');
    const job = rows[0];
    assert.equal(job.channel, 'email');
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.equal(job.user_id, owner.userId);
    assert.equal(job.recipient, owner.email, 'the recipient is the owner account email');
    assert.equal(job.idempotency_key.length, 64);
    assert.equal(job.payload.data.alertId, alertId);
    assert.equal(job.payload.data.direction, 'long');
    assert.equal(await countRows('notification_deliveries'), before + 1);
  });

  test('a replayed generation request never duplicates the job', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('GBPUSD'));
    await seedCandles('GBPUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'GBPUSD', AS_OF);
    await scoreSetup(owner.cookie, setupId);

    const first = await generateAlert(owner.cookie, setupId);
    const alertId = first.json().alert.id as string;
    const afterFirst = (await jobsForAlert(alertId)).rows;
    assert.equal(afterFirst.length, 1);

    const replay = await generateAlert(owner.cookie, setupId);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().created, false);

    // A concurrent double-click collapses too.
    await Promise.all([generateAlert(owner.cookie, setupId), generateAlert(owner.cookie, setupId)]);
    const after = (await jobsForAlert(alertId)).rows;
    assert.equal(after.length, 1, 'still exactly one job for the alert');
    assert.equal(after[0].id, afterFirst[0].id);
  });

  test('generation never delivers: the job stays pending even with SMTP configured', async () => {
    const flow = await fullWorkflow(adminApp);
    const rows = (await jobsForAlert(flow.alertId)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending', 'no delivery happens inside the request');
    assert.equal(rows[0].delivered_at, null);
    assert.equal(rows[0].attempts, 0);
    // …and the provider really is configured, so "pending" is not an accident.
    assert.equal(adminCtx.notificationProviders.list()[0]?.configured, true);
    assert.equal(adminCtx.notificationProviders.list()[0]?.channel, 'email');
  });

  test('zero external I/O during generation, even with the email provider configured', async () => {
    const flow = await fullWorkflow(adminApp);
    const calls: string[] = [];
    const restores: Array<() => void> = [];
    const wrap = (obj: any, name: string, label: string) => {
      const original = obj[name];
      if (typeof original !== 'function') return;
      obj[name] = function wrapped(...args: any[]) {
        calls.push(label);
        return original.apply(this, args);
      };
      restores.push(() => {
        obj[name] = original;
      });
    };
    wrap(globalThis, 'fetch', 'fetch');
    wrap(http, 'request', 'http.request');
    wrap(https, 'request', 'https.request');
    wrap(tls, 'connect', 'tls.connect');
    wrap(dns, 'lookup', 'dns.lookup');
    try {
      const generated = await generateAlert(flow.cookie, flow.setupId, adminApp);
      assert.equal(generated.statusCode, 200, generated.body);
    } finally {
      for (const restore of restores.reverse()) restore();
    }
    // Only local Postgres sockets are allowed; no SMTP/HTTP/DNS traffic at all.
    assert.deepEqual(calls, [], `unexpected outbound calls: ${calls.join(', ')}`);
    assert.equal((await jobsForAlert(flow.alertId)).rows.length, 1, 'replay still enqueues nothing new');
  });

  test('the M6 alert surface is unchanged: stub ledger row, schema and acknowledgement', async () => {
    const flow = await fullWorkflow();
    const deliveries = await countRows('alert_deliveries');
    assert.equal(deliveries > 0, true);
    assert.equal(ctx.alerts.deliveryChannel, 'stub', 'the request-path channel is still the stub ledger');

    // The generate response shape is byte-compatible with the M6 contract.
    const generated = await generateAlert(flow.cookie, flow.setupId);
    assert.equal(alertGenerateResponseSchema.safeParse(generated.json()).success, true);

    // Acknowledgement: idempotent, first timestamp preserved (M6 behaviour).
    const ack1 = await app.inject({
      method: 'POST',
      url: `/api/alerts/${flow.alertId}/acknowledge`,
      headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(ack1.statusCode, 200, ack1.body);
    const first = ack1.json().alert.acknowledgedAt as string;
    assert.ok(first);

    const ack2 = await app.inject({
      method: 'POST',
      url: `/api/alerts/${flow.alertId}/acknowledge`,
      headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(ack2.statusCode, 200, ack2.body);
    assert.equal(ack2.json().alert.acknowledgedAt, first, 'the first acknowledgement timestamp is preserved');
    assert.equal(ack2.json().alert.status, 'acknowledged');
  });
});

/* -------------------------------------------------------------------------- */
/* Owner scoping + authentication                                              */
/* -------------------------------------------------------------------------- */

describe('m7.3 notification access control', () => {
  test('unauthenticated callers cannot read notification status', async () => {
    const flow = await fullWorkflow();
    const res = await app.inject({
      method: 'GET',
      url: `/api/alerts/${flow.alertId}/notifications`,
      headers: { 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 401);
  });

  test('another user cannot read the notifications of an alert they do not own', async () => {
    const flow = await fullWorkflow();
    const stranger = await registerUser();

    const mine = await app.inject({
      method: 'GET',
      url: `/api/alerts/${flow.alertId}/notifications`,
      headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(mine.statusCode, 200, mine.body);
    assert.equal(mine.json().notifications.length, 1);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/alerts/${flow.alertId}/notifications`,
      headers: { cookie: stranger.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(foreign.statusCode, 404, 'a foreign alert is masked, never disclosed');
    assert.equal(foreign.json().error.code, 'not_found');

    // Unknown and malformed ids behave identically.
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/alerts/11111111-1111-4111-8111-111111111111/notifications',
      headers: { cookie: stranger.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(unknown.statusCode, 404);
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/alerts/not-a-uuid/notifications',
      headers: { cookie: stranger.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(malformed.statusCode, 404);
  });

  test('the owner-visible DTO carries status, attempts and category — never recipient or payload', async () => {
    const flow = await fullWorkflow();
    const res = await app.inject({
      method: 'GET',
      url: `/api/alerts/${flow.alertId}/notifications`,
      headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(notificationListResponseSchema.safeParse(body).success, true);

    const job = body.notifications[0];
    assert.equal(job.channel, 'email');
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.equal(job.failureCategory, 'none');
    // Nothing sensitive crosses the boundary.
    for (const key of ['recipient', 'payload', 'lastError', 'last_error', 'idempotencyKey', 'providerMessageId']) {
      assert.equal(key in job, false, `the DTO must not expose ${key}`);
    }
    assert.equal(res.body.includes(flow.email), false, 'the response never echoes the recipient address');
  });
});

/* -------------------------------------------------------------------------- */
/* Internal worker endpoints                                                   */
/* -------------------------------------------------------------------------- */

describe('m7.3 internal worker endpoints', () => {
  test('they do not exist when no worker token is configured', async () => {
    for (const url of [
      '/api/internal/notifications/deliveries/run',
      '/api/internal/notifications/deliveries/maintenance',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': WORKER_TOKEN },
        payload: {},
      });
      assert.equal(res.statusCode, 404, `${url} must not exist without a token configured`);
      assert.equal(res.json().error.code, 'not_found');
    }
  });

  test('a wrong, missing or empty token is refused (even with a valid session)', async () => {
    const flow = await fullWorkflow();
    const urls = [
      '/api/internal/notifications/deliveries/run',
      '/api/internal/notifications/deliveries/maintenance',
    ];
    for (const url of urls) {
      for (const headers of [
        { 'x-forwarded-for': freshIp() },
        { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': '' },
        { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': 'wrong-token' },
        { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': `${WORKER_TOKEN}-suffix` },
        // A browser session is NOT an authorization for an administrative route.
        { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
      ]) {
        const res = await workerApp.inject({ method: 'POST', url, headers, payload: {} });
        assert.equal(res.statusCode, 401, `${url} must reject ${JSON.stringify(Object.keys(headers))}`);
        assert.equal(res.json().error.code, 'unauthorized');
      }
    }
  });

  test('the run endpoint processes the queue through the worker', async () => {
    const local = await makeWorkerApp();
    try {
      const flow = await fullWorkflow(local.app);
      const calls: NotificationSendRequest[] = [];
      const provider: NotificationProvider = {
        channel: 'email',
        name: 'fake',
        configured: true,
        describe: () => ({ channel: 'email', provider: 'fake', configured: true }),
        async send(request) {
          calls.push(request);
          return { outcome: 'delivered', providerMessageId: '<api-test@fake>', providerResponseCode: '250' };
        },
      };
      local.ctx.notificationProviders.register(provider);

      const before = (await jobsForAlert(flow.alertId)).rows[0];
      assert.equal(before.status, 'pending');

      const res = await local.app.inject({
        method: 'POST',
        url: '/api/internal/notifications/deliveries/run',
        headers: { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': WORKER_TOKEN },
        payload: {},
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(notificationRunResponseSchema.safeParse(res.json()).success, true);
      assert.equal(res.json().delivered >= 1, true);

      // The worker drains the whole queue, so count THIS alert's deliveries.
      const mine = calls.filter((c) => c.payload.data.alertId === flow.alertId);
      assert.equal(mine.length, 1, 'this alert was delivered exactly once');
      assert.equal(mine[0]?.recipient, flow.email);
      // The payload the provider received is the SERVER-rendered one: the
      // client never supplied any of these values.
      assert.equal(mine[0]?.payload.data.alertId, flow.alertId);
      assert.match(mine[0]?.payload.text ?? '', /Stop loss/);
      // The provider is handed the job's stable idempotency key, so a retry
      // after a timeout can be de-duplicated upstream.
      assert.equal(mine[0]?.idempotencyKey, before.idempotency_key);

      const after = (await jobsForAlert(flow.alertId)).rows[0];
      assert.equal(after.status, 'delivered');
      assert.equal(after.attempts, 1);
      assert.equal(after.provider, 'fake');
      assert.ok(after.delivered_at);

      // The owner sees the delivered state, never the recipient or payload.
      const listed = await local.app.inject({
        method: 'GET',
        url: `/api/alerts/${flow.alertId}/notifications`,
        headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
      });
      assert.equal(listed.json().notifications[0].status, 'delivered');
      assert.equal(listed.json().notifications[0].provider, 'fake');
      assert.equal(listed.json().notifications[0].deliveredAt !== null, true);
    } finally {
      await local.close();
    }
  });

  test('without a provider the run endpoint records "unavailable" — never "delivered"', async () => {
    const local = await makeWorkerApp();
    try {
      const flow = await fullWorkflow(local.app);
      assert.equal(local.ctx.notificationProviders.size, 0, 'no provider is configured');

      const res = await local.app.inject({
        method: 'POST',
        url: '/api/internal/notifications/deliveries/run',
        headers: { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': WORKER_TOKEN },
        payload: {},
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().unavailable >= 1, true);
      assert.equal(res.json().delivered, 0, 'nothing is ever marked delivered without a provider');

      const rows = (await jobsForAlert(flow.alertId)).rows;
      assert.equal(rows[0].status, 'unavailable');
      assert.equal(rows[0].failure_category, 'configuration');
      assert.equal(rows[0].delivered_at, null);

      // A second run does not spin: unavailable is terminal until configuration changes.
      const second = await local.app.inject({
        method: 'POST',
        url: '/api/internal/notifications/deliveries/run',
        headers: { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': WORKER_TOKEN },
        payload: {},
      });
      assert.equal(second.json().claimed, 0);
    } finally {
      await local.close();
    }
  });

  test('the maintenance endpoint recovers stale work and reports the queue depth', async () => {
    const flow = await fullWorkflow(workerApp);
    // Simulate a worker that died mid-delivery.
    await pool.query(
      `UPDATE notification_deliveries
          SET status = 'processing', locked_at = now() - interval '10 minutes', attempts = 1
        WHERE alert_id = $1`,
      [flow.alertId],
    );

    const res = await workerApp.inject({
      method: 'POST',
      url: '/api/internal/notifications/deliveries/maintenance',
      headers: { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': WORKER_TOKEN },
      payload: { deliveredRetentionDays: 30, failedRetentionDays: 120 },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(notificationMaintenanceResponseSchema.safeParse(res.json()).success, true);
    assert.equal(res.json().recovered >= 1, true, 'the stale job was recovered');

    const rows = (await jobsForAlert(flow.alertId)).rows;
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].failure_category, 'stale');
    assert.equal(typeof res.json().depth.pending, 'number');
  });

  test('the worker endpoints accept only a batch size — never content, ids or recipients', async () => {
    const flow = await fullWorkflow(workerApp);
    const tokenHeaders = { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': WORKER_TOKEN };
    const rejects = [
      { alertId: flow.alertId },
      { recipient: 'attacker@example.com' },
      { payload: { subject: 'free money' } },
      { channel: 'sms' },
      { userId: flow.userId },
      { batchSize: 0 },
      { batchSize: 10_000 },
    ];
    for (const payload of rejects) {
      const res = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/notifications/deliveries/run',
        headers: tokenHeaders,
        payload,
      });
      assert.equal(res.statusCode, 400, `must reject ${JSON.stringify(payload)}`);
      assert.equal(res.json().error.code, 'invalid_input');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Credential hygiene                                                          */
/* -------------------------------------------------------------------------- */

describe('m7.3 credential hygiene', () => {
  test('no notification response ever contains the SMTP secret or the recipient', async () => {
    const flow = await fullWorkflow(adminApp);
    const tokenHeaders = { 'x-forwarded-for': freshIp(), 'x-veltrixeye-worker-token': WORKER_TOKEN };

    const responses = [
      await adminApp.inject({
        method: 'GET',
        url: `/api/alerts/${flow.alertId}/notifications`,
        headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
      }),
      await adminApp.inject({
        method: 'GET',
        url: `/api/alerts/${flow.alertId}`,
        headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
      }),
      await adminApp.inject({
        method: 'GET',
        url: '/api/alerts',
        headers: { cookie: flow.cookie, 'x-forwarded-for': freshIp() },
      }),
      await adminApp.inject({ method: 'POST', url: '/api/internal/notifications/deliveries/maintenance', headers: tokenHeaders, payload: {} }),
      await adminApp.inject({ method: 'GET', url: '/api/health/ready', headers: tokenHeaders }),
    ];

    for (const res of responses) {
      assert.equal(res.body.includes(SMTP_SECRET), false, 'the SMTP password never appears in a response');
      assert.equal(res.body.includes('smtp.example.com'), false, 'no provider internals in a response');
      assert.equal(res.body.includes(flow.email), false, 'no recipient address in a response');
    }
  });

  test('the provider description is operator-safe and the config holds the secret only server-side', async () => {
    const provider = adminCtx.notificationProviders.get('email');
    assert.ok(provider);
    const described = JSON.stringify(provider.describe());
    assert.equal(described.includes(SMTP_SECRET), false, 'describe() never leaks the password');
    assert.equal(JSON.stringify(provider).includes(SMTP_SECRET), false);
    assert.match(described, /smtp\.example\.com/);
    assert.equal(adminCtx.notificationProviders.list()[0]?.configured, true);
  });

  test('the queue never stores a credential, even when a provider echoes one', async () => {
    const local = await makeWorkerApp();
    try {
      const flow = await fullWorkflow(local.app);
      const leaky: NotificationProvider = {
        channel: 'email',
        name: 'leaky',
        configured: true,
        describe: () => ({ channel: 'email', provider: 'leaky' }),
        async send(): Promise<NotificationSendResult> {
          return { outcome: 'retryable', error: `auth failed with ${SMTP_SECRET}` };
        },
      };
      local.ctx.notificationProviders.register(leaky);
      // The deployment hands the worker a scrubber for the credentials IT
      // configured, so even a leaky provider message cannot reach a row.
      const guarded = new DeliveryWorker(pool, local.ctx.notificationProviders, local.ctx.deliveryPolicy, {
        redact: (text: string) => text.split(SMTP_SECRET).join('[redacted]'),
      });
      await guarded.runOnce();

      const stored = JSON.stringify((await jobsForAlert(flow.alertId)).rows[0]);
      assert.equal(stored.includes(SMTP_SECRET), false, 'no credential in the outbox row');
      assert.match(stored, /\[redacted\]/);
    } finally {
      await local.close();
    }
  });
});
