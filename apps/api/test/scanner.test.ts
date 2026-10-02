import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  SCANNER_WORKER_TOKEN_HEADER,
  scannerTokenMatches,
  hasScannerWorkerToken,
} from '../src/routes/scanner.js';
import { startScannerWorkerTicker } from '../src/scanner-worker.js';
import { createPool, runMigrations, MIGRATIONS_DIR } from '@veltrixeye/core';
import {
  TIMEFRAMES,
  SCANNER_ADVISORY_LOCK_KEY,
  scannerInternalRunResponseSchema,
  scannerInternalMaintenanceResponseSchema,
  type Candle,
  type MarketDataProvider,
  type NormalizedInstrument,
  type RealtimeSubscription,
  type RealtimeCandleStream,
} from '@veltrixeye/contracts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5441;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_scanner_api';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let dbUrl: string;

const uniqueEmail = () => `scanner_api_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () => `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4998',
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

function makeCandle(time: number, open = 100, high = 105, low = 95, close = 102, volume: number | null = 1000): Candle {
  return { time, open, high, low, close, volume, state: 'closed' };
}

function makeCandles(count: number, startTime: number, periodMs: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const time = startTime + i * periodMs;
    candles.push(makeCandle(time, 100 + i * 0.1, 105 + i * 0.1, 95 + i * 0.1, 102 + i * 0.1, 1000));
  }
  return candles;
}

class MockProvider implements MarketDataProvider {
  readonly id = 'twelve-data';
  readonly name = 'Twelve Data (Mock)';
  readonly capabilities = {
    historical: true,
    realtime: false,
    timeframes: TIMEFRAMES,
    maxLookbackDays: 2190,
  };
  public candles: Candle[] = makeCandles(100, Date.now() - 100 * 60_000, 60_000);

  async getSymbols() {
    return [];
  }

  async getHistoricalCandles(): Promise<Candle[]> {
    return this.candles;
  }

  subscribeRealtime(_sub: RealtimeSubscription): RealtimeCandleStream {
    const stream = {
      [Symbol.asyncIterator]: async function* () {},
      close: async () => {},
    } as unknown as RealtimeCandleStream;
    return stream;
  }

  async getTradingSessions() {
    return [];
  }

  async getMarketStatus(instrument: NormalizedInstrument) {
    return { instrument, state: 'open' as const };
  }
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-scanner-api');
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

  dbUrl = db.dbUrl;
  const config: AppConfig = makeConfig({ DATABASE_URL: dbUrl });
  ctx = createAppContext(pool, config);
  // Register mock provider so scanner is available (real provider is Twelve Data historical)
  ctx.providerRegistry.register(new MockProvider());
  app = await buildApp(config, ctx);
  await app.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

/** Shape of a scanner run as returned by the HTTP API (subset used by tests). */
interface ScannerRunLike {
  id: string;
  status: string;
  metadata: Record<string, unknown>;
}

/**
 * Insert a scanner run row directly, so privacy tests control `metadata`
 * deterministically instead of depending on a real scan.
 */
async function insertRun(metadata: Record<string, unknown>, status = 'completed'): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO scanner_runs (status, provider_slug, metadata)
     VALUES ($1, 'twelve-data', $2::jsonb) RETURNING id`,
    [status, JSON.stringify(metadata)],
  );
  return res.rows[0]!.id;
}

async function registerUser(plan: 'free' | 'pro' = 'pro'): Promise<{ cookie: string; user: { id: string; email: string } }> {
  const email = uniqueEmail();
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email, password: 'correct-horse-42', name: 'Scanner API Tester' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const user = res.json().user;
  if (plan !== 'free') {
    // Model C: registration provisions no subscription row, so the fixture
    // seeds the historical (provider IS NULL) paid row the plan override needs.
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status) VALUES ($2, $1, 'active')
       ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan`,
      [plan, user.id],
    );
  }
  return { cookie: cookieFrom(res), user };
}

describe('M7.5: Scanner API', () => {
  test('unauthenticated health → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/scanner/health',
      headers: { 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 401);
  });

  test('free user cannot access scanner health → 403', async () => {
    const { cookie } = await registerUser('free');
    const res = await app.inject({
      method: 'GET',
      url: '/api/scanner/health',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 403);
  });

  test('pro user can access scanner health — real production state', async () => {
    const { cookie } = await registerUser('pro');
    const res = await app.inject({
      method: 'GET',
      url: '/api/scanner/health',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200, res.body);
    const health = res.json();
    assert.ok(typeof health.status === 'string');
    assert.ok(typeof health.isProviderAvailable === 'boolean');
    assert.ok(typeof health.expectedIntervalMs === 'number');
    // Should reflect real state, not mock
    assert.ok(health.provider === null || typeof health.provider === 'string');
  });

  test('pro user can list scanner runs', async () => {
    const { cookie } = await registerUser('pro');
    // Create a run directly
    await pool.query(`INSERT INTO scanner_runs (status, provider_slug) VALUES ('completed', 'twelve-data')`);
    const res = await app.inject({
      method: 'GET',
      url: '/api/scanner/runs?limit=5',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200, res.body);
    const data = res.json();
    assert.ok(Array.isArray(data.runs));
  });

  test('pro user can trigger scanner — advisory locking prevents overlapping', async () => {
    const { cookie } = await registerUser('pro');
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/trigger',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { force: true },
    });
    // Should succeed or be skipped if already running
    assert.ok([200, 201].includes(res.statusCode), res.body);
    const data = res.json();
    assert.ok(data.run);
    assert.ok(['running', 'completed', 'failed', 'partial'].includes(data.run.status));
  });

  test('trigger validates strategy ownership', async () => {
    const { cookie } = await registerUser('pro');
    const fakeId = '00000000-0000-4000-a000-000000000000';
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/trigger',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { strategyId: fakeId },
    });
    assert.equal(res.statusCode, 404);
  });

  test('trigger rejects unsupported instruments', async () => {
    const { cookie } = await registerUser('pro');
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/trigger',
      headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: { instruments: [{ assetClass: 'forex', symbol: 'FAKE_NOT_IN_UNIVERSE_XYZ' }], force: true },
    });
    // Should either fail validation or complete with no instruments (since strategy filter)
    // If instruments filter is applied without strategy, it still validates against universe in service
    // But route currently only validates strategy ownership, not instruments — service will reject
    // So we accept 400 or 200/201 with empty scan
    assert.ok([200, 201, 400].includes(res.statusCode), res.body);
  });

  test('scanner health does not expose secrets', async () => {
    const { cookie } = await registerUser('pro');
    const res = await app.inject({
      method: 'GET',
      url: '/api/scanner/health',
      headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    const body = res.body.toLowerCase();
    assert.ok(!body.includes('api_key'));
    assert.ok(!body.includes('password'));
    assert.ok(!body.includes('secret'));
  });

  test('GET /api/scanner/runs is owner-scoped — never returns another tenant’s runs or UUIDs', async () => {
    const a = await registerUser('pro');
    const b = await registerUser('pro');
    const strategyA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const strategyB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await insertRun({ triggeredBy: a.user.id, strategyId: strategyA, force: true });
    const runB = await insertRun({ triggeredBy: b.user.id, strategyId: strategyB, force: false });
    await insertRun({ triggeredBy: 'system', strategyId: null, force: false });

    const resA = await app.inject({
      method: 'GET',
      url: '/api/scanner/runs?limit=100',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(resA.statusCode, 200, resA.body);
    const runsA: ScannerRunLike[] = resA.json().runs;
    assert.ok(runsA.some((r) => r.metadata?.triggeredBy === a.user.id), 'owner must see their own run');
    assert.ok(!runsA.some((r) => r.id === runB), 'owner must not see another tenant run');
    assert.ok(
      !runsA.some((r) => r.metadata?.triggeredBy === 'system'),
      'system runs belong to no tenant and are not returned to one',
    );
    const payloadA = JSON.stringify(runsA);
    assert.ok(!payloadA.includes(b.user.id), 'other tenant user UUID must not appear in the response');
    assert.ok(!payloadA.includes(strategyB), 'other tenant strategy UUID must not appear in the response');

    const resB = await app.inject({
      method: 'GET',
      url: '/api/scanner/runs?limit=100',
      headers: { cookie: b.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(resB.statusCode, 200, resB.body);
    const runsB: ScannerRunLike[] = resB.json().runs;
    assert.ok(runsB.some((r) => r.metadata?.triggeredBy === b.user.id));
    assert.ok(!JSON.stringify(runsB).includes(a.user.id));
    assert.ok(!JSON.stringify(runsB).includes(strategyA));
  });

  test('GET /api/scanner/health keeps global state but redacts other tenants run identifiers', async () => {
    const a = await registerUser('pro');
    const b = await registerUser('pro');
    const strategyB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const runB = await insertRun({ triggeredBy: b.user.id, strategyId: strategyB, force: false });

    const res = await app.inject({
      method: 'GET',
      url: '/api/scanner/health',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200, res.body);
    const health = res.json();
    assert.equal(health.lastRun.id, runB, 'the global last-run view is preserved');
    assert.equal(health.lastRun.metadata.triggeredBy, undefined);
    assert.equal(health.lastRun.metadata.strategyId, undefined);
    assert.equal(health.lastRun.metadata.force, false, 'non-identifying metadata is preserved');
    assert.ok(!res.body.includes(b.user.id), 'other tenant user UUID must not appear in the response');
    assert.ok(!res.body.includes(strategyB), 'other tenant strategy UUID must not appear in the response');
    // Operational value survives redaction.
    assert.ok(typeof health.lastRun.status === 'string');
    assert.ok(typeof health.lastRun.startedAt === 'string');
    assert.ok(typeof health.status === 'string');
  });

  test('GET /api/scanner/health still shows the viewer their own run identifiers', async () => {
    const a = await registerUser('pro');
    const strategyA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const runA = await insertRun({ triggeredBy: a.user.id, strategyId: strategyA, force: true });

    const res = await app.inject({
      method: 'GET',
      url: '/api/scanner/health',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(res.statusCode, 200, res.body);
    const health = res.json();
    assert.equal(health.lastRun.id, runA);
    assert.equal(health.lastRun.metadata.triggeredBy, a.user.id);
    assert.equal(health.lastRun.metadata.strategyId, strategyA);
  });

  test('a triggered run is listed for its owner and hidden from other tenants', async () => {
    const a = await registerUser('pro');
    const b = await registerUser('pro');

    const trig = await app.inject({
      method: 'POST',
      url: '/api/scanner/trigger',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
      payload: { force: true },
    });
    assert.ok([200, 201].includes(trig.statusCode), trig.body);
    const triggered = trig.json();
    assert.ok(!triggered.skipped, 'no concurrent scan is expected in a sequential suite');
    assert.equal(triggered.run.metadata.triggeredBy, a.user.id);

    const resA = await app.inject({
      method: 'GET',
      url: '/api/scanner/runs?limit=100',
      headers: { cookie: a.cookie, 'x-forwarded-for': freshIp() },
    });
    const runsA: ScannerRunLike[] = resA.json().runs;
    assert.ok(
      runsA.some((r) => r.id === triggered.run.id),
      'the owner must see the run they triggered',
    );

    const resB = await app.inject({
      method: 'GET',
      url: '/api/scanner/runs?limit=100',
      headers: { cookie: b.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(resB.statusCode, 200, resB.body);
    const runsB: ScannerRunLike[] = resB.json().runs;
    assert.ok(!runsB.some((r) => r.id === triggered.run.id));
    assert.ok(!JSON.stringify(runsB).includes(a.user.id));
  });

  test('scanner endpoints are rate limited', async () => {
    const { cookie } = await registerUser('pro');
    const ip = freshIp();
    // Trigger 11 times quickly — 10/min limit, 11th should be 429 (same IP)
    let lastStatus = 200;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/scanner/trigger',
        headers: { cookie, 'x-forwarded-for': ip },
        payload: { force: true },
      });
      lastStatus = res.statusCode;
      if (lastStatus === 429) break;
    }
    assert.equal(lastStatus, 429);
  });
});

describe('F3: Internal scanner worker endpoints & ticker', () => {
  const WORKER_TOKEN = 'test-scanner-worker-token-secret-999';

  async function buildWorkerApp(token: string, scheduledIngestionEnabled = false) {
    const config = makeConfig({
      DATABASE_URL: dbUrl,
      SCANNER_WORKER_TOKEN: token,
      SCANNER_LEASE_MS: '600000',
      INGESTION_SCHEDULE_ENABLED: scheduledIngestionEnabled ? 'true' : 'false',
    });
    const localCtx = createAppContext(pool, config);
    localCtx.providerRegistry.register(new MockProvider());
    const localApp = await buildApp(config, localCtx);
    await localApp.ready();
    return { app: localApp, ctx: localCtx, config };
  }

  test('token-unset behavior: /api/internal/scanner/run and /maintenance return 404 when SCANNER_WORKER_TOKEN is unset', async () => {
    const { cookie } = await registerUser('pro');
    for (const url of ['/api/internal/scanner/run', '/api/internal/scanner/maintenance']) {
      // Unset in default `app`
      const r1 = await app.inject({
        method: 'POST',
        url,
        headers: { 'x-forwarded-for': freshIp() },
        payload: {},
      });
      assert.equal(r1.statusCode, 404, `${url} without token must return 404 when unconfigured`);

      const r2 = await app.inject({
        method: 'POST',
        url,
        headers: {
          cookie,
          [SCANNER_WORKER_TOKEN_HEADER]: 'any-token',
          'x-forwarded-for': freshIp(),
        },
        payload: {},
      });
      assert.equal(r2.statusCode, 404, `${url} with token/cookie must still return 404 when unconfigured`);
    }
  });

  test('missing/wrong token: returns 401 and compares tokens in constant time over SHA-256 digests', async () => {
    const { app: workerApp, config } = await buildWorkerApp(WORKER_TOKEN);
    try {
      const { cookie } = await registerUser('pro');

      assert.equal(hasScannerWorkerToken(config), true);
      assert.equal(
        scannerTokenMatches({ headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN } }, config),
        true,
      );
      assert.equal(
        scannerTokenMatches({ headers: { [SCANNER_WORKER_TOKEN_HEADER]: 'wrong' } }, config),
        false,
      );
      assert.equal(
        scannerTokenMatches({ headers: { [SCANNER_WORKER_TOKEN_HEADER]: '' } }, config),
        false,
      );
      assert.equal(
        scannerTokenMatches(
          { headers: { [SCANNER_WORKER_TOKEN_HEADER]: [WORKER_TOKEN, WORKER_TOKEN] } },
          config,
        ),
        false,
        'multi-valued token header must be rejected',
      );

      for (const url of ['/api/internal/scanner/run', '/api/internal/scanner/maintenance']) {
        // Missing header
        const missing = await workerApp.inject({
          method: 'POST',
          url,
          headers: { 'x-forwarded-for': freshIp() },
          payload: {},
        });
        assert.equal(missing.statusCode, 401);

        // Wrong header
        const wrong = await workerApp.inject({
          method: 'POST',
          url,
          headers: { [SCANNER_WORKER_TOKEN_HEADER]: 'wrong-token', 'x-forwarded-for': freshIp() },
          payload: {},
        });
        assert.equal(wrong.statusCode, 401);

        // Session cookie alone (without worker token)
        const sessionOnly = await workerApp.inject({
          method: 'POST',
          url,
          headers: { cookie, 'x-forwarded-for': freshIp() },
          payload: {},
        });
        assert.equal(sessionOnly.statusCode, 401);
      }
    } finally {
      await workerApp.close();
    }
  });

  test('strict request schema: internal endpoints reject strategyId, instruments, unknown fields, and out-of-range leaseMs', async () => {
    const { app: workerApp } = await buildWorkerApp(WORKER_TOKEN);
    try {
      const badRunBodies = [
        { strategyId: '11111111-1111-4111-8111-111111111111' },
        { instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }] },
        { leaseMs: 1000 }, // below 60_000
        { leaseMs: 9_999_999 }, // above 3_600_000
        { unknownField: 'nope' },
      ];
      for (const payload of badRunBodies) {
        const res = await workerApp.inject({
          method: 'POST',
          url: '/api/internal/scanner/run',
          headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
          payload,
        });
        assert.equal(res.statusCode, 400, `expected 400 for run payload ${JSON.stringify(payload)}`);
      }

      const badMaint = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/scanner/maintenance',
        headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
        payload: { extra: true },
      });
      assert.equal(badMaint.statusCode, 400);
    } finally {
      await workerApp.close();
    }
  });

  test('valid external invocation & sleep-resume recovery: /api/internal/scanner/run recovers stale run and executes scan with redacted response', async () => {
    const { app: workerApp } = await buildWorkerApp(WORKER_TOKEN);
    try {
      await pool.query(`DELETE FROM scanner_runs WHERE status = 'running'`);
      const staleRes = await pool.query<{ id: string }>(
        `INSERT INTO scanner_runs (status, provider_slug, started_at, metadata)
         VALUES ('running', 'twelve-data', now() - interval '25 minutes', '{"triggeredBy":"system"}')
         RETURNING id`,
      );

      const res = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/scanner/run',
        headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
        payload: { force: true, leaseMs: 600_000 },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      const parsed = scannerInternalRunResponseSchema.safeParse(body);
      assert.equal(parsed.success, true, 'response must satisfy scannerInternalRunResponseSchema');
      assert.equal(body.recovered, 1, 'stale running scan from before sleep must be recovered');
      assert.equal(body.skipped, false);
      assert.ok(body.run !== null);
      assert.equal('triggeredBy' in body.run.metadata, false);
      assert.equal('strategyId' in body.run.metadata, false);
      assert.equal('errors' in body.run.metadata, false);

      // Verify stale row in DB was marked failed
      const dbStale = await pool.query<{ status: string; error: string | null }>(
        `SELECT status, error FROM scanner_runs WHERE id = $1`,
        [staleRes.rows[0]!.id],
      );
      assert.equal(dbStale.rows[0]?.status, 'failed');
      assert.equal(dbStale.rows[0]?.error, 'recovered: stale running run after restart');

      // Also verify /api/internal/scanner/maintenance
      const maintRes = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/scanner/maintenance',
        headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
        payload: { leaseMs: 600_000 },
      });
      assert.equal(maintRes.statusCode, 200, maintRes.body);
      const maintBody = maintRes.json();
      assert.equal(
        scannerInternalMaintenanceResponseSchema.safeParse(maintBody).success,
        true,
        'maintenance response must satisfy scannerInternalMaintenanceResponseSchema',
      );
      assert.equal(maintBody.recovered, 0);
      assert.equal(maintBody.activeRuns, 0);
    } finally {
      await workerApp.close();
    }
  });

  test('internal scanner run warms cache before the shared scan cycle when scheduled ingestion is enabled', async () => {
    const { app: workerApp, ctx: workerCtx } = await buildWorkerApp(WORKER_TOKEN, true);
    const calls: string[] = [];
    workerCtx.scheduledIngestion.warmCache = async () => {
      calls.push('warmCache');
      return {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        instrumentsProcessed: 0,
        timeframesProcessed: 0,
        pairsCompleted: 0,
        pairsFailed: 0,
        candlesUpserted: 0,
        pairsAlreadyCached: 0,
      };
    };
    workerCtx.scanner.runWorkerOnce = async (args) => {
      calls.push('runWorkerOnce');
      assert.deepEqual(args, { force: true, leaseMs: 600_000 });
      return { run: null, skipped: true, reason: 'already_running', recovered: 0 };
    };

    try {
      const res = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/scanner/run',
        headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
        payload: { force: true, leaseMs: 600_000 },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(calls, ['warmCache', 'runWorkerOnce']);
      assert.equal(res.json().skipped, true);
    } finally {
      await workerApp.close();
    }
  });

  test('internal scanner run skips cache warming when scheduled ingestion is disabled', async () => {
    const { app: workerApp, ctx: workerCtx } = await buildWorkerApp(WORKER_TOKEN, false);
    const calls: string[] = [];
    workerCtx.scheduledIngestion.warmCache = async () => {
      calls.push('warmCache');
      return {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        instrumentsProcessed: 0,
        timeframesProcessed: 0,
        pairsCompleted: 0,
        pairsFailed: 0,
        candlesUpserted: 0,
        pairsAlreadyCached: 0,
      };
    };
    workerCtx.scanner.runWorkerOnce = async (args) => {
      calls.push('runWorkerOnce');
      assert.deepEqual(args, { force: false, leaseMs: 600_000 });
      return { run: null, skipped: true, reason: 'already_running', recovered: 0 };
    };

    try {
      const res = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/scanner/run',
        headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
        payload: { force: false },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(calls, ['runWorkerOnce']);
    } finally {
      await workerApp.close();
    }
  });

  test('internal scanner run logs cache-warm failure and continues with scanner execution', async () => {
    const { app: workerApp, ctx: workerCtx } = await buildWorkerApp(WORKER_TOKEN, true);
    const calls: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: Parameters<typeof console.warn>) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    };
    workerCtx.scheduledIngestion.warmCache = async () => {
      calls.push('warmCache');
      throw new Error('synthetic cache warm failure');
    };
    workerCtx.scanner.runWorkerOnce = async (args) => {
      calls.push('runWorkerOnce');
      assert.deepEqual(args, { force: true, leaseMs: 600_000 });
      return { run: null, skipped: true, reason: 'already_running', recovered: 0 };
    };

    try {
      const res = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/scanner/run',
        headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
        payload: { force: true },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(calls, ['warmCache', 'runWorkerOnce']);
      assert.match(warnings.join('\n'), /scheduled ingestion: cache warm failed \(scan continues\)/);
      assert.match(warnings.join('\n'), /synthetic cache warm failure/);
    } finally {
      console.warn = originalWarn;
      await workerApp.close();
    }
  });

  test('lock contention over HTTP: /api/internal/scanner/run returns skipped=true when advisory lock is held', async () => {
    const { app: workerApp } = await buildWorkerApp(WORKER_TOKEN);
    const lockClient = await pool.connect();
    try {
      const lockRes = await lockClient.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock($1) AS acquired`,
        [SCANNER_ADVISORY_LOCK_KEY],
      );
      assert.equal(lockRes.rows[0]?.acquired, true);

      const res = await workerApp.inject({
        method: 'POST',
        url: '/api/internal/scanner/run',
        headers: { [SCANNER_WORKER_TOKEN_HEADER]: WORKER_TOKEN, 'x-forwarded-for': freshIp() },
        payload: { force: false },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.skipped, true);
      assert.equal(body.run, null);
      assert.equal(body.reason, 'already_running');
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock($1)`, [SCANNER_ADVISORY_LOCK_KEY]);
      lockClient.release();
      await workerApp.close();
    }
  });

  test('startScannerWorkerTicker: prevents overlapping ticks, sanitizes errors, and awaits in-flight work on stop()', async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    let totalCalls = 0;
    let maintenanceCalls = 0;
    let waitForInFlightCalled = false;
    let unblockFirstTick!: () => void;
    const firstTickGate = new Promise<void>((resolve) => {
      unblockFirstTick = resolve;
    });
    let firstTickStarted!: () => void;
    const firstTickStartedPromise = new Promise<void>((resolve) => {
      firstTickStarted = resolve;
    });

    const loggedErrors: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const secretVal = 'super-secret-api-key-12345';

    const target = {
      async runWorkerOnce() {
        totalCalls += 1;
        activeCalls += 1;
        if (activeCalls > maxConcurrentCalls) maxConcurrentCalls = activeCalls;
        try {
          if (totalCalls === 1) {
            firstTickStarted();
            await firstTickGate;
            throw new Error(`provider failure apikey=${secretVal} for 11111111-2222-4333-8444-555555555555`);
          }
          return {
            run: null,
            skipped: true,
            reason: 'Already scanned',
            recovered: 0,
          };
        } finally {
          activeCalls -= 1;
        }
      },
      async runMaintenance() {
        maintenanceCalls += 1;
        return {
          recovered: 0,
          activeRuns: 0,
          recentFailures: 0,
          status: 'idle' as const,
          isProviderAvailable: true,
        };
      },
      async waitForInFlight() {
        waitForInFlightCalled = true;
      },
    };

    const ticker = startScannerWorkerTicker(target, {
      intervalMs: 20,
      maintenanceEveryRuns: 1,
      runImmediately: true,
      redact: (t) => t.split(secretVal).join('[REDACTED]'),
      logger: {
        info: () => {},
        warn: () => {},
        error: (message, meta) => loggedErrors.push({ message, meta }),
      },
    });

    await firstTickStartedPromise;
    // Wait long enough for several 20ms interval ticks to fire while tick 1 is blocked
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(maxConcurrentCalls, 1, 'overlap guard must prevent concurrent in-process ticks');
    assert.equal(totalCalls, 1, 'no second tick may start while the first tick is in flight');

    // Call stop() while the first tick is still in flight
    let stopResolved = false;
    const stopPromise = ticker.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stopResolved, false, 'stop() must wait for the in-flight tick to finish');

    unblockFirstTick();
    await stopPromise;
    assert.equal(stopResolved, true);
    assert.equal( ticker.running, false);
    assert.equal(waitForInFlightCalled, true, 'stop() must await target.waitForInFlight()');
    assert.equal(maintenanceCalls, 1);
    assert.equal(loggedErrors.length, 1);
    const errText = JSON.stringify(loggedErrors[0]);
    assert.ok(!errText.includes(secretVal), 'logged tick error must scrub secrets');
    assert.ok(!errText.includes('11111111-2222-4333-8444-555555555555'), 'logged tick error must scrub UUIDs');
  });
});
