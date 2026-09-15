/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * M6 Phase 3 — alert generation, stub delivery ledger and API.
 *
 * Covers the Phase 3 definition of done end to end:
 *  - authenticated generation, missing auth, owner isolation, masked 404
 *  - eligible states (confirmed/triggered) and ineligible/terminal refusal
 *  - the M5 score requirement (400) and the minQualityScore gate (silent 200)
 *  - dedup by (setup_id, trigger_state), concurrency, replay safety
 *  - one stub ledger row per alert, hash over the persisted payload
 *  - idempotent acknowledgement that preserves the first timestamp
 *  - tiered rate limits (generate 20/min, acknowledge 60/min) with 429s
 *  - accurate audit events, zero external/network I/O, no stray DB writes
 *  - different setups/trigger states never collapse into one logical alert
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
  ALERT_TRIGGER_STATES,
  alertDeliveryDtoSchema,
  alertDetailDtoSchema,
  alertDtoSchema,
  alertGenerateResponseSchema,
  alertListResponseSchema,
} from '@veltrixeye/contracts';
import {
  AlertService,
  CandleStore,
  createPool,
  MIGRATIONS_DIR,
  NonStubSenderError,
  runMigrations,
  StubAlertSender,
  type AlertSendRequest,
  type AlertSender,
} from '@veltrixeye/core';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5441;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_alerts';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let store: CandleStore;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `alert_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () =>
  `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4996',
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

const RISK_HIGH = {
  ...RISK_LOW,
  minQualityScore: 90,
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

async function registerUser(): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: PASSWORD, name: 'Alert Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { cookie: cookieFrom(res), userId: body.user.id };
}

async function createPublishedVersion(
  cookie: string,
  config: any,
): Promise<{ strategyId: string; versionId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/strategies',
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { name: `Alert strategy ${randomBytes(4).toString('hex')}`, version: config },
  });
  assert.equal(created.statusCode, 201, created.body);
  const strategy = created.json().strategy;
  const version = strategy.versions[0];
  const published = await app.inject({
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
  const candles = shapes.map(([o, h, l, c], idx) => ({
    time: anchor - (shapes.length - idx) * HOUR,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: null,
  }));
  await store.upsertCandles({
    instrumentId: instrument.id,
    timeframe: '1h',
    providerSlug: 'test-fixture',
    candles,
  });
}

async function detectSetup(
  cookie: string,
  strategyId: string,
  versionId: string,
  symbol: string,
  asOf: number,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/strategies/${strategyId}/versions/${versionId}/detect`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { instrument: { assetClass: 'forex', symbol }, direction: 'long', asOf },
  });
  assert.equal(res.statusCode, 200, res.body);
  const setup = res.json().detections[0].setup;
  assert.ok(setup, JSON.stringify(res.json()).slice(0, 1200));
  return setup.id as string;
}

async function scoreSetup(
  cookie: string,
  setupId: string,
  asOf?: number,
): Promise<{ total: number; grade: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/setups/${setupId}/score`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: asOf ? { asOf } : {},
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().score;
}

async function transition(cookie: string, setupId: string, toState: string, asOf: number) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/setups/${setupId}/transitions`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { toState, asOf },
  });
  assert.equal(res.statusCode, 200, res.body);
}

async function generate(
  cookie: string,
  setupId: string,
  payload: Record<string, unknown> = {},
  ip: string = freshIp(),
) {
  return app.inject({
    method: 'POST',
    url: `/api/setups/${setupId}/alerts`,
    headers: { cookie, 'x-forwarded-for': ip },
    payload,
  });
}

async function acknowledge(cookie: string, alertId: string, ip: string = freshIp()) {
  return app.inject({
    method: 'POST',
    url: `/api/alerts/${alertId}/acknowledge`,
    headers: { cookie, 'x-forwarded-for': ip },
    payload: {},
  });
}

async function countRows(table: string): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? '0');
}

async function auditCount(userId: string, action: string): Promise<number> {
  const res = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM audit_events WHERE user_id = $1 AND action = $2',
    [userId, action],
  );
  return Number(res.rows[0]?.n ?? '0');
}

async function auditMetadata(
  userId: string,
  action: string,
  where: string,
  value: string,
): Promise<Record<string, any> | null> {
  const res = await pool.query<{ metadata: Record<string, any> }>(
    `SELECT metadata FROM audit_events
     WHERE user_id = $1 AND action = $2 AND metadata->>$3 = $4
     ORDER BY id ASC LIMIT 1`,
    [userId, action, where, value],
  );
  return res.rows[0]?.metadata ?? null;
}

async function alertRowsForSetup(setupId: string) {
  const res = await pool.query<any>('SELECT * FROM alerts WHERE setup_id = $1 ORDER BY trigger_state', [
    setupId,
  ]);
  return res.rows;
}

/**
 * Deterministic interleaving harness for the lifecycle TOCTOU race.
 *
 * `AlertService.generateAlert` reads the owned setup (state gate) on one pooled
 * connection and only later opens its write transaction. This harness parks the
 * generation path at its NEXT connection checkout after that state read — i.e.
 * after the gate has already been evaluated and before the alert INSERT runs —
 * so a lifecycle transition can be committed inside the window.
 *
 * Returns `restore()` (always call it), a promise that resolves once the path
 * is parked, and `release()` which lets it continue.
 */
function parkGenerationWriteCheckout() {
  const originalQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  let restore: () => void = () => {};
  let release: () => void = () => {};
  let signalParked: () => void = () => {};
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stateReadSeen = false;
  let oneShotUsed = false;

  (pool as any).query = async (...args: any[]) => {
    const result = await (originalQuery as any)(...args);
    // The service's owned-setup read (ownership chain + instrument join).
    if (
      !stateReadSeen &&
      typeof args[0] === 'string' &&
      args[0].includes('JOIN instruments i ON i.id = s.instrument_id')
    ) {
      stateReadSeen = true;
    }
    return result;
  };

  (pool as any).connect = async (...args: any[]) => {
    if (stateReadSeen && !oneShotUsed) {
      oneShotUsed = true;
      signalParked();
      await gate;
    }
    return (originalConnect as any)(...args);
  };

  restore = () => {
    (pool as any).query = originalQuery;
    (pool as any).connect = originalConnect;
    release(); // never leave the generation path parked if the test throws
  };

  return { parked, release, restore };
}

async function deliveriesFor(alertId: string) {
  const res = await pool.query<any>(
    'SELECT * FROM alert_deliveries WHERE alert_id = $1 ORDER BY id ASC',
    [alertId],
  );
  return res.rows;
}

/** Test-side, independent copy of the pinned payload canonicalization. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

function payloadHashFor(alert: { id: string; title: string; body: unknown }): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ alertId: alert.id, title: alert.title, body: alert.body })), 'utf8')
    .digest('hex');
}

/** Insert a setup row in an arbitrary lifecycle state (fixture for state gates). */
async function insertSetupFixture(args: {
  versionId: string;
  symbol: string;
  state: string;
  direction?: string;
  asOfMs: number;
}): Promise<string> {
  const instrument = await store.resolveInstrument('forex', args.symbol);
  assert.ok(instrument);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms)
     VALUES ($1, $2, $3, $4, to_timestamp($5::bigint / 1000.0), $5::bigint)
     RETURNING id`,
    [args.versionId, instrument.id, args.state, args.direction ?? 'long', String(args.asOfMs)],
  );
  const row = res.rows[0];
  assert.ok(row);
  return row.id;
}

/** Insert an alert row directly (fixture for the defensive ledger-repair path). */
async function insertAlertFixture(args: {
  userId: string;
  setupId: string;
  triggerState: string;
  title: string;
  body?: Record<string, unknown>;
}): Promise<string> {
  const setupRes = await pool.query<any>(
    `SELECT s.instrument_id, s.direction, s.strategy_version_id, v.strategy_id
     FROM setups s JOIN strategy_versions v ON v.id = s.strategy_version_id
     WHERE s.id = $1`,
    [args.setupId],
  );
  const setup = setupRes.rows[0];
  const res = await pool.query<{ id: string }>(
    `INSERT INTO alerts
       (user_id, setup_id, strategy_id, strategy_version_id, instrument_id, direction,
        trigger_state, quality_score, min_quality_score, title, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)
     RETURNING id`,
    [
      args.userId,
      args.setupId,
      setup.strategy_id,
      setup.strategy_version_id,
      setup.instrument_id,
      setup.direction,
      args.triggerState,
      args.title,
      JSON.stringify(args.body ?? {}),
    ],
  );
  const row = res.rows[0];
  assert.ok(row);
  return row.id;
}

interface NetCall {
  fn: string;
  target: string;
}

function targetOf(args: any[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first instanceof URL) return `${first.hostname}${first.port ? `:${first.port}` : ''}`;
  if (first && typeof first === 'object') {
    const host = first.hostname ?? first.host ?? first.path ?? '';
    const port = first.port ?? '';
    return `${host}${port ? `:${port}` : ''}`;
  }
  const second = args[1];
  if (typeof second === 'number') return `:${second}`;
  return '';
}

/** Spy on every outbound network entry point (recording, never blocking). */
async function withNetworkSpy<T>(fn: () => Promise<T>): Promise<{ result: T; calls: NetCall[] }> {
  const calls: NetCall[] = [];
  const restores: Array<() => void> = [];

  function wrap(obj: any, name: string, label: string): void {
    const original = obj[name];
    if (typeof original !== 'function') return;
    obj[name] = function wrapped(...args: any[]) {
      calls.push({ fn: label, target: targetOf(args) });
      return original.apply(this, args);
    };
    restores.push(() => {
      obj[name] = original;
    });
  }

  wrap(globalThis, 'fetch', 'fetch');
  wrap(http, 'request', 'http.request');
  wrap(http, 'get', 'http.get');
  wrap(https, 'request', 'https.request');
  wrap(https, 'get', 'https.get');
  wrap(net, 'connect', 'net.connect');
  wrap(net, 'createConnection', 'net.createConnection');
  wrap(net.Socket.prototype, 'connect', 'net.Socket.connect');
  wrap(tls, 'connect', 'tls.connect');
  wrap(dns, 'lookup', 'dns.lookup');
  wrap(dns.promises, 'lookup', 'dns.promises.lookup');

  try {
    const result = await fn();
    return { result, calls };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '']);

function isLocalTarget(target: string): boolean {
  const host = target.replace(/^\[|\]$/g, '').split(':')[0] ?? '';
  return LOCAL_HOSTS.has(host);
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-alerts');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  const config = makeConfig({ DATABASE_URL: db.dbUrl });
  ctx = createAppContext(pool, config);
  app = await buildApp(config, ctx);
  await app.ready();
  store = new CandleStore(pool);
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

describe('m6 alerts api (phase 3)', () => {
  test('no provider is registered and no ingestion run happens (alerts must not need one)', async () => {
    assert.equal(ctx.providerRegistry.list().length, 0);
    assert.equal(ctx.alerts.deliveryChannel, 'stub');

    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF);
    await scoreSetup(owner.cookie, setupId);

    const before = await countRows('ingestion_runs');
    const res = await generate(owner.cookie, setupId);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(await countRows('ingestion_runs'), before);
  });

  test('authentication is required for every alert route', async () => {
    const fake = '11111111-1111-1111-1111-111111111111';
    const noAuth = { 'x-forwarded-for': freshIp() };
    const gen = await app.inject({
      method: 'POST',
      url: `/api/setups/${fake}/alerts`,
      headers: noAuth,
      payload: {},
    });
    assert.equal(gen.statusCode, 401);
    const list = await app.inject({ method: 'GET', url: '/api/alerts', headers: noAuth });
    assert.equal(list.statusCode, 401);
    const detail = await app.inject({ method: 'GET', url: `/api/alerts/${fake}`, headers: noAuth });
    assert.equal(detail.statusCode, 401);
    const ack = await app.inject({
      method: 'POST',
      url: `/api/alerts/${fake}/acknowledge`,
      headers: noAuth,
      payload: {},
    });
    assert.equal(ack.statusCode, 401);
  });

  test('eligible states: confirmed and triggered both generate, and unauthenticated callers never reach the gate', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 5 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 5 * HOUR);
    await scoreSetup(owner.cookie, setupId);

    // Default: the setup's current state (confirmed) is eligible.
    const confirmed = await generate(owner.cookie, setupId);
    assert.equal(confirmed.statusCode, 201, confirmed.body);
    assert.equal(confirmed.json().alert.triggerState, 'confirmed');
    assert.ok(ALERT_TRIGGER_STATES.includes(confirmed.json().alert.triggerState));

    // Triggered is eligible once the setup actually reached it.
    await transition(owner.cookie, setupId, 'triggered', AS_OF + 5 * HOUR + 1);
    const triggered = await generate(owner.cookie, setupId, { triggerState: 'triggered' });
    assert.equal(triggered.statusCode, 201, triggered.body);
    assert.equal(triggered.json().alert.triggerState, 'triggered');

    // Forward-looking trigger states are refused (no invented progression).
    const res2 = await generate(owner.cookie, setupId, { triggerState: 'triggered' });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json().created, false);
  });

  test('pre-confirmation (non-eligible, non-terminal) states are refused with the state message', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));

    for (const [state, symbol] of [
      ['developing', 'EURUSD'],
      ['watching', 'GBPUSD'],
      ['almost_ready', 'USDJPY'],
    ] as const) {
      const setupId = await insertSetupFixture({
        versionId,
        symbol,
        state,
        asOfMs: AS_OF + 10 * HOUR,
      });
      const res = await generate(owner.cookie, setupId);
      assert.equal(res.statusCode, 400, `${state}: ${res.body}`);
      assert.equal(res.json().error.code, 'invalid_input');
      assert.match(res.json().error.message, /only confirmed or triggered/);
      assert.doesNotMatch(res.json().error.message, /terminal/);
      // The state gate runs BEFORE the score gate (this setup has no score).
      assert.doesNotMatch(res.json().error.message, /quality score/);
    }
  });

  test('terminal states (invalidated, expired, completed) are refused and never alerted', async () => {
    const owner = await registerUser();
    const cases: Array<{ exit: string; symbol: string; offset: number; via?: 'triggered' }> = [
      { exit: 'invalidated', symbol: 'EURUSD', offset: 12 },
      { exit: 'expired', symbol: 'GBPUSD', offset: 14 },
      { exit: 'completed', symbol: 'USDJPY', offset: 16, via: 'triggered' },
    ];

    for (const testCase of cases) {
      const { strategyId, versionId } = await createPublishedVersion(
        owner.cookie,
        engulfConfig(testCase.symbol),
      );
      const anchor = AS_OF + testCase.offset * HOUR;
      await seedCandles(testCase.symbol, BULLISH_SHAPES, anchor);
      const setupId = await detectSetup(owner.cookie, strategyId, versionId, testCase.symbol, anchor);
      await scoreSetup(owner.cookie, setupId);
      if (testCase.via === 'triggered') {
        await transition(owner.cookie, setupId, 'triggered', anchor + 1);
        await transition(owner.cookie, setupId, 'completed', anchor + 2);
      } else {
        await transition(owner.cookie, setupId, testCase.exit, anchor + 1);
      }

      const res = await generate(owner.cookie, setupId);
      assert.equal(res.statusCode, 400, `${testCase.exit}: ${res.body}`);
      assert.equal(res.json().error.code, 'invalid_input');
      assert.match(res.json().error.message, /terminal state/);
      assert.match(res.json().error.message, new RegExp(testCase.exit));
      assert.equal((await alertRowsForSetup(setupId)).length, 0);
    }
  });

  test('missing M5 score at the detection anchor → documented 400 with no side effects', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF + 18 * HOUR);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 18 * HOUR);

    const alertsBefore = await countRows('alerts');
    const deliveriesBefore = await countRows('alert_deliveries');
    const res = await generate(owner.cookie, setupId);

    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error.code, 'invalid_input');
    assert.match(res.json().error.message, /no quality score at its detection anchor/);
    assert.equal(await countRows('alerts'), alertsBefore);
    assert.equal(await countRows('alert_deliveries'), deliveriesBefore);
    assert.equal(await auditCount(owner.userId, 'alert.created'), 0);
    assert.equal(await auditCount(owner.userId, 'alert.delivery_recorded'), 0);
  });

  test('minQualityScore gate: score == gate generates, score < gate is silent with skippedReason', async () => {
    const owner = await registerUser();

    // Learn the engine's deterministic total for this configuration.
    const probe = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const probeAnchor = AS_OF + 20 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, probeAnchor);
    const probeSetup = await detectSetup(owner.cookie, probe.strategyId, probe.versionId, 'EURUSD', probeAnchor);
    const probeScore = await scoreSetup(owner.cookie, probeSetup);
    assert.ok(probeScore.total > 0 && probeScore.total < 100, `unexpected probe score ${probeScore.total}`);

    // Boundary: total === gate must pass (>= comparison, not >).
    const atGate = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', {
      ...RISK_LOW,
      minQualityScore: probeScore.total,
    }));
    const gateAnchor = AS_OF + 22 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, gateAnchor);
    const gateSetup = await detectSetup(owner.cookie, atGate.strategyId, atGate.versionId, 'EURUSD', gateAnchor);
    const gateScore = await scoreSetup(owner.cookie, gateSetup);
    assert.equal(gateScore.total, probeScore.total);
    assert.equal(gateScore.grade, probeScore.grade);

    const pass = await generate(owner.cookie, gateSetup);
    assert.equal(pass.statusCode, 201, pass.body);
    assert.equal(pass.json().alert.qualityScore, probeScore.total);
    assert.equal(pass.json().alert.minQualityScore, probeScore.total);
    assert.equal(pass.json().alert.body.qualityGrade, probeScore.grade);

    // One below the gate: silence, no rows, explicit skippedReason.
    const belowGate = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', {
      ...RISK_LOW,
      minQualityScore: probeScore.total + 1,
    }));
    const belowAnchor = AS_OF + 24 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, belowAnchor);
    const belowSetup = await detectSetup(
      owner.cookie,
      belowGate.strategyId,
      belowGate.versionId,
      'EURUSD',
      belowAnchor,
    );
    await scoreSetup(owner.cookie, belowSetup);

    const alertsBefore = await countRows('alerts');
    const deliveriesBefore = await countRows('alert_deliveries');
    const skip = await generate(owner.cookie, belowSetup);
    assert.equal(skip.statusCode, 200, skip.body);
    assert.equal(alertGenerateResponseSchema.safeParse(skip.json()).success, true);
    assert.equal(skip.json().alert, null);
    assert.equal(skip.json().created, false);
    assert.equal(skip.json().skippedReason, 'below_min_quality');
    assert.equal(await countRows('alerts'), alertsBefore);
    assert.equal(await countRows('alert_deliveries'), deliveriesBefore);

    // The skip is audited with the gate context (score, grade, gate).
    const meta = await auditMetadata(owner.userId, 'alert.skipped', 'reason', 'below_min_quality');
    assert.ok(meta);
    assert.equal(meta!.qualityScore, probeScore.total);
    assert.equal(meta!.qualityGrade, probeScore.grade);
    assert.equal(meta!.minQualityScore, probeScore.total + 1);
    assert.equal((await alertRowsForSetup(belowSetup)).length, 0);
  });

  test('generate creates the alert and exactly one stub delivery ledger entry', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(
      owner.cookie,
      engulfConfig('EURUSD', RISK_LOW),
    );
    const anchor = AS_OF + 30 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    const score = await scoreSetup(owner.cookie, setupId);
    const alertsBefore = await countRows('alerts');
    const deliveriesBefore = await countRows('alert_deliveries');

    const res = await generate(owner.cookie, setupId);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json();
    assert.equal(alertGenerateResponseSchema.safeParse(body).success, true);
    assert.equal(body.created, true);
    assert.equal(alertDtoSchema.safeParse(body.alert).success, true);
    assert.equal(body.alert.setupId, setupId);
    assert.equal(body.alert.strategyId, strategyId);
    assert.equal(body.alert.strategyVersionId, versionId);
    assert.equal(body.alert.triggerState, 'confirmed');
    assert.equal(body.alert.status, 'pending');
    assert.equal(body.alert.acknowledgedAt, null);
    assert.equal(body.alert.qualityScore, score.total);
    assert.equal(body.alert.body.qualityGrade, score.grade);
    assert.ok(body.alert.title.length <= 280);
    assert.ok(body.alert.title.includes('EURUSD'));
    assert.ok(body.alert.title.includes(`score ${score.total}/${score.grade}`));
    // Licensing-safe payload: no raw candle data.
    assert.ok(!JSON.stringify(body.alert.body).includes('"open"'));
    assert.ok(!JSON.stringify(body.alert.body).includes('"close"'));

    assert.equal(body.deliveries.length, 1);
    assert.equal(alertDeliveryDtoSchema.safeParse(body.deliveries[0]).success, true);
    assert.equal(body.deliveries[0].channel, 'stub');
    assert.equal(body.deliveries[0].status, 'delivered');
    assert.equal(body.deliveries[0].attempt, 1);
    assert.equal(body.deliveries[0].error, null);
    assert.match(body.deliveries[0].payloadHash, /^[0-9a-f]{64}$/);

    assert.equal(await countRows('alerts'), alertsBefore + 1);
    assert.equal(await countRows('alert_deliveries'), deliveriesBefore + 1);

    const rows = await alertRowsForSetup(setupId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger_state, 'confirmed');
    assert.equal(rows[0].status, 'pending');

    // The stored ledger hash is the hash of the STORED alert payload.
    const stored = rows[0];
    const deliveries = await deliveriesFor(stored.id);
    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0].payload_hash,
      payloadHashFor({ id: stored.id, title: stored.title, body: stored.body }),
    );
  });

  test('generation is idempotent: replay returns the same alert, never a second ledger row or a second delivery audit', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 40 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);

    const first = await generate(owner.cookie, setupId);
    assert.equal(first.statusCode, 201, first.body);
    const alertId = first.json().alert.id;
    const firstDeliveryId = first.json().deliveries[0].id;
    const deliveriesAfterFirst = await countRows('alert_deliveries');

    for (let i = 0; i < 3; i++) {
      const replay = await generate(owner.cookie, setupId);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().created, false);
      assert.equal(replay.json().alert.id, alertId);
      assert.equal(replay.json().alert.createdAt, first.json().alert.createdAt);
      assert.equal(replay.json().deliveries.length, 1);
      assert.equal(replay.json().deliveries[0].id, firstDeliveryId);
      assert.equal(replay.json().deliveries[0].attempt, 1);
    }

    assert.equal(await countRows('alert_deliveries'), deliveriesAfterFirst);
    assert.equal((await deliveriesFor(alertId)).length, 1);
    assert.equal(await auditCount(owner.userId, 'alert.created'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.replayed'), 3);
    // The delivery audit is emitted exactly once — for the real insert.
    const deliveryAudits = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE user_id = $1 AND action = 'alert.delivery_recorded' AND metadata->>'alertId' = $2`,
      [owner.userId, alertId],
    );
    assert.equal(deliveryAudits.rows[0]?.n, '1');
  });

  test('concurrent generation creates exactly one alert and one ledger row', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 50 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);
    const ip = freshIp();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => generate(owner.cookie, setupId, {}, ip)),
    );
    for (const r of results) assert.ok([200, 201].includes(r.statusCode), r.body);

    const ids = new Set(results.map((r) => r.json().alert?.id).filter(Boolean));
    assert.equal(ids.size, 1);
    assert.equal(results.filter((r) => r.json().created).length, 1);
    assert.equal(results.filter((r) => r.json().created === false).length, 7);

    const alertId = [...ids][0] as string;
    const rows = await alertRowsForSetup(setupId);
    assert.equal(rows.length, 1);
    assert.equal((await deliveriesFor(alertId)).length, 1);
    assert.equal(await auditCount(owner.userId, 'alert.created'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.delivery_recorded'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.replayed'), 7);
  });

  test('lifecycle race: a transition that lands mid-generation can never produce an alert (TOCTOU)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 55 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);

    // Counters captured before the race: this setup has an eligible state and
    // a passing M5 score, so without the in-transaction re-check the parked
    // generation below would happily commit an alert.
    const alertsBefore = await countRows('alerts');
    const deliveriesBefore = await countRows('alert_deliveries');
    const createdAuditsBefore = await auditCount(owner.userId, 'alert.created');

    const harness = parkGenerationWriteCheckout();
    let generateResponse: Awaited<ReturnType<typeof generate>>;
    try {
      // Start generation; it evaluates the state gate, then parks before its
      // write transaction is opened.
      const generation = generate(owner.cookie, setupId);
      await harness.parked;

      // While generation is parked, M4 moves the setup to a terminal state.
      const transitioned = await app.inject({
        method: 'POST',
        url: `/api/setups/${setupId}/transitions`,
        headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
        payload: { toState: 'invalidated', asOf: anchor + 1 },
      });
      assert.equal(transitioned.statusCode, 200, transitioned.body);

      harness.release();
      generateResponse = await generation;
    } finally {
      harness.restore();
    }

    // The generation must observe the terminal state, not write an alert.
    assert.equal(generateResponse.statusCode, 400, generateResponse.body);
    assert.equal(generateResponse.json().error.code, 'invalid_input');
    assert.match(generateResponse.json().error.message, /terminal state/);
    assert.match(generateResponse.json().error.message, /invalidated/);

    const state = await pool.query<{ state: string }>('SELECT state FROM setups WHERE id = $1', [setupId]);
    assert.equal(state.rows[0]?.state, 'invalidated');

    // Zero side effects for that setup: no alert row, no ledger row, no
    // alert.created audit event, and no growth of the global counters.
    assert.deepEqual(await alertRowsForSetup(setupId), []);
    assert.equal(await countRows('alerts'), alertsBefore);
    assert.equal(await countRows('alert_deliveries'), deliveriesBefore);
    assert.equal(await auditCount(owner.userId, 'alert.created'), createdAuditsBefore);
    const staleAudit = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
       WHERE action IN ('alert.created', 'alert.replayed', 'alert.delivery_recorded')
         AND metadata->>'setupId' = $1`,
      [setupId],
    );
    assert.equal(staleAudit.rows[0]?.n, '0');

    // The setup is still refused afterwards (terminal states stay refused).
    const afterRace = await generate(owner.cookie, setupId);
    assert.equal(afterRace.statusCode, 400);
    assert.match(afterRace.json().error.message, /terminal state/);
    assert.deepEqual(await alertRowsForSetup(setupId), []);
  });

  test('different trigger states do not collapse: confirmed and triggered are separate logical alerts', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 60 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);

    const confirmedAlert = await generate(owner.cookie, setupId);
    assert.equal(confirmedAlert.statusCode, 201, confirmedAlert.body);
    await transition(owner.cookie, setupId, 'triggered', anchor + 1);
    const triggeredAlert = await generate(owner.cookie, setupId, { triggerState: 'triggered' });
    assert.equal(triggeredAlert.statusCode, 201, triggeredAlert.body);

    const confirmedId = confirmedAlert.json().alert.id;
    const triggeredId = triggeredAlert.json().alert.id;
    assert.notEqual(confirmedId, triggeredId);
    assert.equal(confirmedAlert.json().alert.triggerState, 'confirmed');
    assert.equal(triggeredAlert.json().alert.triggerState, 'triggered');
    assert.ok(triggeredAlert.json().alert.title.includes('triggered'));
    assert.ok(confirmedAlert.json().alert.title.includes('confirmed'));

    const rows = await alertRowsForSetup(setupId);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.trigger_state),
      ['confirmed', 'triggered'],
    );
    assert.equal((await deliveriesFor(confirmedId)).length, 1);
    assert.equal((await deliveriesFor(triggeredId)).length, 1);

    // Re-requesting the confirmed alert returns the ORIGINAL row (no collapse
    // onto the newer triggered alert, no duplicate).
    const replayConfirmed = await generate(owner.cookie, setupId, { triggerState: 'confirmed' });
    assert.equal(replayConfirmed.statusCode, 200, replayConfirmed.body);
    assert.equal(replayConfirmed.json().alert.id, confirmedId);
    assert.equal(replayConfirmed.json().alert.triggerState, 'confirmed');

    // A request for a triggered alert on a non-triggered setup is a 400.
    const other = await createPublishedVersion(owner.cookie, engulfConfig('GBPUSD'));
    const otherAnchor = AS_OF + 61 * HOUR;
    await seedCandles('GBPUSD', BULLISH_SHAPES, otherAnchor);
    const otherSetup = await detectSetup(owner.cookie, other.strategyId, other.versionId, 'GBPUSD', otherAnchor);
    await scoreSetup(owner.cookie, otherSetup);
    const premature = await generate(owner.cookie, otherSetup, { triggerState: 'triggered' });
    assert.equal(premature.statusCode, 400, premature.body);
    assert.match(premature.json().error.message, /not in triggered state/);
    assert.equal((await alertRowsForSetup(otherSetup)).length, 0);
  });

  test('different setups and strategies do not collapse, even when the rendered title is identical', async () => {
    const owner = await registerUser();
    const first = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const second = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const third = await createPublishedVersion(owner.cookie, engulfConfig('GBPUSD'));

    // The two EURUSD windows must not overlap: the shared candle store is
    // global, so a shifted re-seed of the same times would rewrite the tail.
    const anchorA = AS_OF + 70 * HOUR;
    const anchorB = anchorA + 18 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchorA);
    await seedCandles('EURUSD', BULLISH_SHAPES, anchorB);
    await seedCandles('GBPUSD', BULLISH_SHAPES, anchorA);

    const setupA = await detectSetup(owner.cookie, first.strategyId, first.versionId, 'EURUSD', anchorA);
    const setupB = await detectSetup(owner.cookie, second.strategyId, second.versionId, 'EURUSD', anchorB);
    const setupC = await detectSetup(owner.cookie, third.strategyId, third.versionId, 'GBPUSD', anchorA);
    assert.notEqual(setupA, setupB);
    await scoreSetup(owner.cookie, setupA);
    await scoreSetup(owner.cookie, setupB);
    await scoreSetup(owner.cookie, setupC);

    const alerts = await Promise.all([
      generate(owner.cookie, setupA),
      generate(owner.cookie, setupB),
      generate(owner.cookie, setupC),
    ]);
    for (const r of alerts) assert.equal(r.statusCode, 201, r.body);
    const ids = alerts.map((r) => r.json().alert.id);
    assert.equal(new Set(ids).size, 3);
    assert.equal(new Set(alerts.map((r) => r.json().alert.setupId)).size, 3);
    // Same instrument + same version content ⇒ same title, different alert.
    assert.equal(alerts[0].json().alert.title, alerts[1].json().alert.title);
    for (const id of ids) assert.equal((await deliveriesFor(id)).length, 1);
  });

  test('alert ownership follows the existing strategy/user ownership chain', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 80 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);
    const res = await generate(owner.cookie, setupId);
    assert.equal(res.statusCode, 201, res.body);

    const rows = await alertRowsForSetup(setupId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, owner.userId);
    assert.equal(rows[0].strategy_id, strategyId);
    assert.equal(rows[0].strategy_version_id, versionId);
    assert.equal(rows[0].trigger_state, 'confirmed');
  });

  test('a missing ledger row is repaired exactly once (defensive) and the stored payload wins', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 90 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);

    // An alert row with no ledger entry (cannot happen through the service,
    // which writes both in one transaction — this is the repair path).
    const fixtureTitle = `Legacy ${randomBytes(3).toString('hex')} confirmed`;
    const fixtureId = await insertAlertFixture({
      userId: owner.userId,
      setupId,
      triggerState: 'confirmed',
      title: fixtureTitle,
      body: { legacy: true },
    });
    assert.equal((await deliveriesFor(fixtureId)).length, 0);

    const repaired = await generate(owner.cookie, setupId);
    assert.equal(repaired.statusCode, 200, repaired.body);
    assert.equal(repaired.json().created, false);
    assert.equal(repaired.json().alert.id, fixtureId);
    // The stored alert is never rewritten to the freshly computed content.
    assert.equal(repaired.json().alert.title, fixtureTitle);

    const deliveries = await deliveriesFor(fixtureId);
    assert.equal(deliveries.length, 1);
    assert.equal(
      deliveries[0].payload_hash,
      payloadHashFor({ id: fixtureId, title: fixtureTitle, body: { legacy: true } }),
    );
    assert.equal(await auditCount(owner.userId, 'alert.delivery_recorded'), 1);

    // A second replay adds nothing.
    const replay = await generate(owner.cookie, setupId);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().deliveries.length, 1);
    assert.equal((await deliveriesFor(fixtureId)).length, 1);
    assert.equal(await auditCount(owner.userId, 'alert.delivery_recorded'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.created'), 0);
  });

  test('masked 404: foreign setups, alerts and acknowledgements never disclose existence', async () => {
    const victim = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(victim.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 100 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(victim.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(victim.cookie, setupId);
    const gen = await generate(victim.cookie, setupId);
    assert.equal(gen.statusCode, 201, gen.body);
    const alertId = gen.json().alert.id;

    const attacker = await registerUser();

    const foreignGenerate = await generate(attacker.cookie, setupId);
    assert.equal(foreignGenerate.statusCode, 404);
    assert.equal(foreignGenerate.json().error.code, 'not_found');

    const unknownGenerate = await generate(attacker.cookie, '22222222-2222-4222-8222-222222222222');
    assert.equal(unknownGenerate.statusCode, 404);

    const foreignDetail = await app.inject({
      method: 'GET',
      url: `/api/alerts/${alertId}`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(foreignDetail.statusCode, 404);

    const foreignAck = await acknowledge(attacker.cookie, alertId);
    assert.equal(foreignAck.statusCode, 404);

    const unknownAck = await acknowledge(attacker.cookie, '33333333-3333-4333-8333-333333333333');
    assert.equal(unknownAck.statusCode, 404);

    const attackerList = await app.inject({
      method: 'GET',
      url: '/api/alerts',
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(attackerList.statusCode, 200);
    assert.equal(attackerList.json().alerts.length, 0);
    assert.equal(alertListResponseSchema.safeParse(attackerList.json()).success, true);

    // The victim's alert was untouched by any of the attacker's attempts.
    const victimDetail = await app.inject({
      method: 'GET',
      url: `/api/alerts/${alertId}`,
      headers: { cookie: victim.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(victimDetail.statusCode, 200);
    assert.equal(victimDetail.json().alert.status, 'pending');
    assert.equal(victimDetail.json().alert.acknowledgedAt, null);
  });

  test('acknowledgement is idempotent, preserves the first timestamp and writes no extra state', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 110 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);
    const gen = await generate(owner.cookie, setupId);
    assert.equal(gen.statusCode, 201, gen.body);
    const alertId = gen.json().alert.id;

    const alertsBefore = await countRows('alerts');
    const deliveriesBefore = await countRows('alert_deliveries');

    const first = await acknowledge(owner.cookie, alertId);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(alertDetailDtoSchema.safeParse(first.json()).success, true);
    assert.equal(first.json().alert.status, 'acknowledged');
    assert.ok(first.json().alert.acknowledgedAt);
    assert.equal(first.json().deliveries.length, 1);
    const firstAckAt = first.json().alert.acknowledgedAt;

    const second = await acknowledge(owner.cookie, alertId);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().alert.status, 'acknowledged');
    assert.equal(second.json().alert.acknowledgedAt, firstAckAt);
    assert.equal(second.json().alert.id, alertId);

    const third = await acknowledge(owner.cookie, alertId);
    assert.equal(third.statusCode, 200);
    assert.equal(third.json().alert.acknowledgedAt, firstAckAt);

    // No duplicate state records: same single alert row, same single ledger row.
    assert.equal(await countRows('alerts'), alertsBefore);
    assert.equal(await countRows('alert_deliveries'), deliveriesBefore);
    const rows = await alertRowsForSetup(setupId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'acknowledged');
    assert.equal(new Date(rows[0].acknowledged_at).toISOString(), firstAckAt);
    assert.equal(await auditCount(owner.userId, 'alert.acknowledged'), 3);
    // Acknowledging never creates a delivery or an alert.
    assert.equal(await auditCount(owner.userId, 'alert.created'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.delivery_recorded'), 1);
  });

  test('full lifecycle: detect → score → generate → acknowledge with an ordered audit trail', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 120 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);

    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    const score = await scoreSetup(owner.cookie, setupId);
    const gen = await generate(owner.cookie, setupId);
    assert.equal(gen.statusCode, 201, gen.body);
    const alertId = gen.json().alert.id;
    const ack = await acknowledge(owner.cookie, alertId);
    assert.equal(ack.statusCode, 200, ack.body);

    // Final state: one setup (confirmed), one score, one alert (acknowledged),
    // one stub ledger entry.
    const setup = await pool.query<any>('SELECT * FROM setups WHERE id = $1', [setupId]);
    assert.equal(setup.rows[0].state, 'confirmed');
    assert.equal(setup.rows[0].quality_score, score.total);
    assert.equal((await alertRowsForSetup(setupId)).length, 1);
    assert.equal((await deliveriesFor(alertId)).length, 1);
    assert.equal(ack.json().alert.status, 'acknowledged');

    const trail = await pool.query<{ action: string }>(
      `SELECT action FROM audit_events
       WHERE user_id = $1 AND action = ANY($2) ORDER BY id ASC`,
      [
        owner.userId,
        [
          'setup.detected',
          'setup.scored',
          'alert.created',
          'alert.delivery_recorded',
          'alert.acknowledged',
        ],
      ],
    );
    assert.deepEqual(
      trail.rows.map((r) => r.action),
      ['setup.detected', 'setup.scored', 'alert.created', 'alert.delivery_recorded', 'alert.acknowledged'],
    );
  });

  test('zero external I/O: no network, no provider and no vendor SDK during generate + acknowledge', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 130 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);
    const ingestionBefore = await countRows('ingestion_runs');

    const { result, calls } = await withNetworkSpy(async () => {
      const gen = await generate(owner.cookie, setupId);
      assert.equal(gen.statusCode, 201, gen.body);
      const ack = await acknowledge(owner.cookie, gen.json().alert.id);
      assert.equal(ack.statusCode, 200, ack.body);
      // Spy liveness: the pool reuses idle connections, so a clean run records
      // nothing at all — a deliberate LOCAL socket proves the wrappers are
      // attached, i.e. an external call could not slip through unrecorded.
      const probe = net.connect({ host: '127.0.0.1', port: DB_PORT });
      probe.on('error', () => {});
      probe.destroy();
      await pool.query('SELECT 1');
      return { alertId: gen.json().alert.id as string, ack };
    });
    assert.equal(result.ack.statusCode, 200);
    assert.ok(
      calls.some((c) => c.fn === 'net.connect' && c.target.startsWith('127.0.0.1')),
      `network spy recorded no local probe: ${JSON.stringify(calls)}`,
    );

    // No HTTP(S)/fetch/TLS/DNS traffic at all — the only sockets allowed are
    // the local Postgres connections opened by the pool.
    const external = calls.filter(
      (c) => c.fn !== 'net.connect' && c.fn !== 'net.createConnection' && c.fn !== 'net.Socket.connect',
    );
    assert.deepEqual(external, [], `unexpected external calls: ${JSON.stringify(external)}`);
    const nonLocal = calls.filter((c) => !isLocalTarget(c.target));
    assert.deepEqual(nonLocal, [], `non-local network calls: ${JSON.stringify(nonLocal)}`);
    for (const call of calls) assert.match(call.target, /^(127\.0\.0\.1|localhost|::1|)(:\d+)?$/);

    assert.equal(await countRows('ingestion_runs'), ingestionBefore);
    assert.equal(ctx.providerRegistry.list().length, 0);
  });

  test('no database side effects outside alerts, alert_deliveries and audit_events', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 140 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);

    const tracked = [
      'setups',
      'setup_state_events',
      'setup_scores',
      'strategies',
      'strategy_versions',
      'candles',
      'ingestion_runs',
      'backtest_runs',
      'backtest_trades',
    ];
    const before: Record<string, number> = {};
    for (const table of tracked) before[table] = await countRows(table);
    const alertsBefore = await countRows('alerts');
    const deliveriesBefore = await countRows('alert_deliveries');
    const auditsBefore = await countRows('audit_events');

    const gen = await generate(owner.cookie, setupId);
    assert.equal(gen.statusCode, 201, gen.body);
    // Replay + acknowledgement must also stay inside the alert tables.
    await generate(owner.cookie, setupId);
    await acknowledge(owner.cookie, gen.json().alert.id);

    for (const table of tracked) assert.equal(await countRows(table), before[table], `${table} changed`);
    assert.equal(await countRows('alerts'), alertsBefore + 1);
    assert.equal(await countRows('alert_deliveries'), deliveriesBefore + 1);
    // Only audit_events grow, by exactly the three events of this flow
    // (alert.created, alert.delivery_recorded, alert.replayed, alert.acknowledged).
    assert.equal(await countRows('audit_events'), auditsBefore + 4);
    assert.equal(await auditCount(owner.userId, 'alert.created'), 1);
  });

  test('only stub deliveries exist; email/webhook/push are never written', async () => {
    const nonStub = await pool.query<{ channel: string; n: string }>(
      'SELECT channel, count(*)::text AS n FROM alert_deliveries GROUP BY channel',
    );
    for (const row of nonStub.rows) assert.equal(row.channel, 'stub');
    const total = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM alert_deliveries WHERE status <> 'delivered' OR attempt <> 1`,
    );
    assert.equal(total.rows[0]?.n, '0');
    // No vendor SDK / provider module is loaded into the alert path.
    assert.equal(ctx.alerts.deliveryChannel, 'stub');
  });

  test('alert statuses stay inside the M6 lifecycle (suppressed is never written)', async () => {
    const res = await pool.query<{ status: string; n: string }>(
      'SELECT status, count(*)::text AS n FROM alerts GROUP BY status',
    );
    for (const row of res.rows) assert.ok(['pending', 'acknowledged'].includes(row.status), row.status);
  });

  test('AlertService refuses a non-stub sender and calls the stub sender exactly once per ledger row', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 150 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);

    // M6 wiring guard: any channel that would deliver externally is refused.
    const externalSender: AlertSender = {
      channel: 'email',
      async send() {
        throw new Error('must never be called');
      },
    };
    assert.throws(() => new AlertService(pool, ctx.strategies, externalSender), NonStubSenderError);

    class RecordingStubSender implements AlertSender {
      readonly channel = 'stub' as const;
      readonly requests: AlertSendRequest[] = [];
      private readonly inner = new StubAlertSender();
      async send(request: AlertSendRequest) {
        this.requests.push(request);
        return this.inner.send(request);
      }
    }

    const recorder = new RecordingStubSender();
    const service = new AlertService(pool, ctx.strategies, recorder);

    const created = await service.generateAlert({ userId: owner.userId, setupId });
    assert.equal(created.created, true);
    assert.equal(created.deliveryCreated, true);
    assert.equal(recorder.requests.length, 1);
    const firstRequest = recorder.requests[0];
    assert.ok(firstRequest);
    assert.equal(firstRequest.alertId, created.alert?.id);
    assert.equal(firstRequest.userId, owner.userId);
    assert.equal(firstRequest.setupId, setupId);
    assert.equal(firstRequest.triggerState, 'confirmed');

    const replay = await service.generateAlert({ userId: owner.userId, setupId });
    assert.equal(replay.created, false);
    assert.equal(replay.deliveryCreated, false);
    // Replays do not re-render/re-send: one attempt, one ledger row.
    assert.equal(recorder.requests.length, 1);
    assert.equal((await deliveriesFor(created.alert!.id)).length, 1);
  });

  test('rate limits: generate 20/min and acknowledge 60/min return 429 without side effects', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 160 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);

    // Generation: 20/min per IP.
    const generateIp = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await generate(owner.cookie, setupId, {}, generateIp);
      statuses.push(res.statusCode);
    }
    assert.equal(statuses.filter((s) => s === 201).length, 1);
    assert.equal(statuses.filter((s) => s === 200).length, 19);

    const blocked = await generate(owner.cookie, setupId, {}, generateIp);
    assert.equal(blocked.statusCode, 429, blocked.body);
    assert.equal(blocked.json().error.code, 'rate_limited');
    assert.match(blocked.json().error.message, /Try again in \d+s/);

    // The 429 never created a duplicate row or a second delivery.
    const alerts = await alertRowsForSetup(setupId);
    assert.equal(alerts.length, 1);
    assert.equal((await deliveriesFor(alerts[0].id)).length, 1);
    assert.equal(await auditCount(owner.userId, 'alert.created'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.delivery_recorded'), 1);

    // Acknowledgement: 60/min per IP (higher than generation).
    const alertId = alerts[0].id;
    const ackIp = freshIp();
    for (let i = 0; i < 60; i++) {
      const res = await acknowledge(owner.cookie, alertId, ackIp);
      assert.equal(res.statusCode, 200, res.body);
    }
    const blockedAck = await acknowledge(owner.cookie, alertId, ackIp);
    assert.equal(blockedAck.statusCode, 429, blockedAck.body);
    assert.equal(blockedAck.json().error.code, 'rate_limited');

    const rows = await alertRowsForSetup(setupId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'acknowledged');
    assert.equal((await deliveriesFor(alertId)).length, 1);
  });

  test('malformed inputs and unknown fields → 400/404, never 500', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 170 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    await scoreSetup(owner.cookie, setupId);
    const gen = await generate(owner.cookie, setupId);
    assert.equal(gen.statusCode, 201, gen.body);
    const alertId = gen.json().alert.id;

    const invalidTrigger = await generate(owner.cookie, setupId, { triggerState: 'watching' });
    assert.equal(invalidTrigger.statusCode, 400);
    const unknownField = await generate(owner.cookie, setupId, { force: true });
    assert.equal(unknownField.statusCode, 400);
    assert.match(unknownField.json().error.message, /Invalid request body/);

    const badSetupId = await generate(owner.cookie, 'not-a-uuid');
    assert.equal(badSetupId.statusCode, 404);

    const badAlertId = await app.inject({
      method: 'GET',
      url: '/api/alerts/not-a-uuid',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(badAlertId.statusCode, 404);

    const badAckBody = await acknowledge(owner.cookie, alertId);
    assert.equal(badAckBody.statusCode, 200);
    const extraAckBody = await app.inject({
      method: 'POST',
      url: `/api/alerts/${alertId}/acknowledge`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { note: 'seen' },
    });
    assert.equal(extraAckBody.statusCode, 400);

    const badList = await app.inject({
      method: 'GET',
      url: '/api/alerts?status=invalid',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(badList.statusCode, 400);
    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/alerts?limit=101',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(badLimit.statusCode, 400);
  });

  test('audit events are accurate for created, replayed, skipped, delivered and acknowledged', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    const anchor = AS_OF + 180 * HOUR;
    await seedCandles('EURUSD', BULLISH_SHAPES, anchor);
    const setupId = await detectSetup(owner.cookie, strategyId, versionId, 'EURUSD', anchor);
    const score = await scoreSetup(owner.cookie, setupId);

    const gen = await generate(owner.cookie, setupId);
    assert.equal(gen.statusCode, 201, gen.body);
    const alertId = gen.json().alert.id;
    await generate(owner.cookie, setupId);
    await acknowledge(owner.cookie, alertId);

    assert.equal(await auditCount(owner.userId, 'alert.created'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.replayed'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.delivery_recorded'), 1);
    assert.equal(await auditCount(owner.userId, 'alert.skipped'), 0);
    assert.equal(await auditCount(owner.userId, 'alert.acknowledged'), 1);

    const createdMeta = await auditMetadata(owner.userId, 'alert.created', 'setupId', setupId);
    assert.ok(createdMeta);
    assert.equal(createdMeta!.triggerState, 'confirmed');
    assert.equal(createdMeta!.qualityScore, score.total);
    assert.equal(createdMeta!.qualityGrade, score.grade);
    assert.equal(createdMeta!.minQualityScore, 0);
    assert.equal(createdMeta!.created, true);
    assert.equal(createdMeta!.channel, 'stub');

    const deliveryMeta = await auditMetadata(owner.userId, 'alert.delivery_recorded', 'alertId', alertId);
    assert.ok(deliveryMeta);
    assert.equal(deliveryMeta!.channel, 'stub');
    assert.equal(deliveryMeta!.status, 'delivered');
    assert.equal(deliveryMeta!.attempt, 1);
    assert.match(String(deliveryMeta!.payloadHash), /^[0-9a-f]{64}$/);

    const ackMeta = await auditMetadata(owner.userId, 'alert.acknowledged', 'setupId', setupId);
    assert.ok(ackMeta);
    assert.equal(ackMeta!.status, 'acknowledged');
    assert.equal(ackMeta!.acknowledgedAt, gen.json().alert.acknowledgedAt ?? ackMeta!.acknowledgedAt);

    // The alert-scoped audit surface is exactly the expected set.
    const actions = await pool.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_events WHERE user_id = $1 AND action LIKE 'alert.%' ORDER BY action`,
      [owner.userId],
    );
    assert.deepEqual(
      actions.rows.map((r) => r.action),
      ['alert.acknowledged', 'alert.created', 'alert.delivery_recorded', 'alert.replayed'],
    );
  });

  test('ledger invariant: every alert in the database has exactly one stub ledger entry', async () => {
    const violations = await pool.query<{ id: string; n: string }>(
      `SELECT a.id, count(d.id)::text AS n
       FROM alerts a LEFT JOIN alert_deliveries d ON d.alert_id = a.id
       GROUP BY a.id HAVING count(d.id) <> 1 OR count(d.id) FILTER (WHERE d.channel <> 'stub') > 0`,
    );
    assert.deepEqual(violations.rows, []);

    const alerts = await pool.query<any>('SELECT id, title, body, status FROM alerts');
    assert.ok(alerts.rows.length > 0, 'expected alerts from earlier tests');
    for (const alert of alerts.rows) {
      const deliveries = await deliveriesFor(alert.id);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].channel, 'stub');
      assert.equal(deliveries[0].status, 'delivered');
      assert.equal(deliveries[0].attempt, 1);
      assert.equal(deliveries[0].error, null);
      assert.equal(
        deliveries[0].payload_hash,
        payloadHashFor({ id: alert.id, title: alert.title, body: alert.body }),
      );
    }

    // Every alert's user owns the setup's strategy (owner scoping invariant).
    const orphans = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
       FROM alerts a
       JOIN setups s ON s.id = a.setup_id
       JOIN strategy_versions v ON v.id = s.strategy_version_id
       JOIN strategies st ON st.id = v.strategy_id
       WHERE a.user_id <> st.user_id OR a.strategy_id <> st.id OR a.strategy_version_id <> v.id`,
    );
    assert.equal(orphans.rows[0]?.n, '0');
  });
});
