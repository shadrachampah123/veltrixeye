import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import type pg from 'pg';
import type { LightMyRequestResponse } from 'fastify';
import {
  DETECTOR_VERSION,
  detectionResponseDtoSchema,
  setupDetailDtoSchema,
  setupTransitionResponseDtoSchema,
  type StrategyVersionConfig,
} from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, runMigrations, MIGRATIONS_DIR, CandleStore } from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5437;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_detection';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let store: CandleStore;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `detect_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () => `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

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
const AS_OF = 1_800_000_000_000;
type Shape = [number, number, number, number]; // o,h,l,c

const FLAT_16: Shape[] = Array.from({ length: 16 }, () => [100, 100.5, 99.5, 100] as Shape);
// Bearish candle then a bullish engulfing close at the anchor (long passes).
const BULLISH_SHAPES: Shape[] = [...FLAT_16, [101, 101.2, 100, 100.2], [100, 101.5, 99.9, 101.3]];
// Bullish candle then a bearish engulfing close at the anchor (short passes).
const BEARISH_SHAPES: Shape[] = [...FLAT_16, [99.9, 100.1, 99.8, 100.0], [100.2, 100.3, 99.5, 99.7]];

const RISK = {
  minRr: 2,
  stopLossMethod: 'fixed',
  stopLossBuffer: 1,
  stopLossBufferUnit: 'pips',
  takeProfitMethod: 'rr',
  tp1Rr: 1,
  tp2Rr: 2,
  tp3Rr: 3,
  minQualityScore: 65,
} as const;

function engulfConfig(
  symbol: string,
  direction: 'bullish' | 'bearish',
  assetClass: 'forex' | 'commodity' = 'forex',
): StrategyVersionConfig {
  return {
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'instruments', instruments: [{ assetClass, symbol }] },
    sessionFilters: [],
    risk: { ...RISK },
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
            params: { direction },
            position: 0,
          },
        ],
      },
    ],
  };
}

const NEWS_FILTER_CONFIG: StrategyVersionConfig = {
  timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
  marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'USDJPY' }] },
  sessionFilters: [],
  risk: { ...RISK },
  filters: [],
  ruleGroups: [
    {
      name: 'entry',
      logic: 'AND',
      position: 0,
      conditions: [
        { conditionType: 'news_filter', classification: 'required', timeframeRole: 'any', params: {}, position: 0 },
      ],
    },
  ],
};

async function registerUser(): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: PASSWORD, name: 'Detect Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  return { cookie: cookieFrom(res), userId: body.user.id };
}

async function createPublishedVersion(
  cookie: string,
  config: StrategyVersionConfig,
): Promise<{ strategyId: string; versionId: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/strategies',
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { name: `Detect strategy ${randomBytes(4).toString('hex')}`, version: config },
  });
  assert.equal(created.statusCode, 201, created.body);
  const strategy = created.json().strategy;
  const version = strategy.versions[0];
  assert.ok(version);
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
  const upserted = await store.upsertCandles({ instrumentId: instrument.id, timeframe: '1h', providerSlug: 'test-fixture', candles });
  assert.equal(upserted, shapes.length);
}

async function countRows(table: string): Promise<number> {
  const res = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? '0');
}

async function detect(
  cookie: string,
  strategyId: string,
  versionId: string,
  body: Record<string, unknown>,
  ip = freshIp(),
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/strategies/${strategyId}/versions/${versionId}/detect`,
    headers: { cookie, 'x-forwarded-for': ip },
    payload: body,
  });
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-detection');
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

describe('m4 setup detection api', () => {
  test('setup: no provider is registered (detection must not need one)', () => {
    assert.equal(ctx.providerRegistry.list().length, 0);
  });

  test('qualifying evaluation creates a confirmed setup with levels + exactly one initial event', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);

    const beforeSetups = await countRows('setups');
    const beforeEvents = await countRows('setup_state_events');

    const res = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      asOf: AS_OF,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();

    const parsed = detectionResponseDtoSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify((parsed as { error?: unknown }).error ?? []));

    assert.equal(body.strategyId, strategyId);
    assert.equal(body.versionId, versionId);
    assert.equal(body.asOfMs, AS_OF);
    assert.equal(body.detectorVersion, DETECTOR_VERSION);
    assert.equal(body.detections.length, 2); // both directions when unspecified

    const long = body.detections.find((d: { direction: string }) => d.direction === 'long');
    const short = body.detections.find((d: { direction: string }) => d.direction === 'short');
    assert.equal(long.qualified, true);
    assert.equal(long.created, true);
    assert.equal(short.qualified, false);
    assert.equal(short.setup, null);
    assert.equal(short.created, false);
    assert.ok(short.failureReasons.length > 0);

    const setup = long.setup;
    assert.equal(setup.state, 'confirmed');
    assert.equal(setup.direction, 'long');
    assert.equal(setup.asOfMs, AS_OF);
    assert.equal(setup.detectedAt, new Date(AS_OF).toISOString());
    assert.equal(setup.entryPrice, 101.3);
    assert.ok(setup.stopLossPrice < setup.entryPrice); // long-convention levels as-is
    assert.ok(setup.tp1Price > setup.entryPrice);
    assert.equal(setup.qualityScore, null); // M5 owns scoring
    assert.equal(setup.expiresAt, null);
    assert.equal(setup.metadata.detectorVersion, DETECTOR_VERSION);
    assert.equal(setup.metadata.asOfMs, AS_OF);

    assert.equal(await countRows('setups'), beforeSetups + 1);
    assert.equal(await countRows('setup_state_events'), beforeEvents + 1);
    assert.equal(await countRows('setup_scores'), 0); // M4 never scores

    const events = await pool.query<{ from_state: string | null; to_state: string; reason: string }>(
      'SELECT from_state, to_state, reason FROM setup_state_events WHERE setup_id = $1 ORDER BY id ASC',
      [setup.id],
    );
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0]?.from_state, null);
    assert.equal(events.rows[0]?.to_state, 'confirmed');
    assert.equal(events.rows[0]?.reason, 'detected');
  });

  test('short setups mirror levels around the entry (stop above, targets below)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('GBPUSD', 'bearish'));
    await seedCandles('GBPUSD', BEARISH_SHAPES, AS_OF);

    const res = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'GBPUSD' },
      direction: 'short',
      asOf: AS_OF,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.detections.length, 1);
    assert.equal(body.detections[0].qualified, true);
    const setup = body.detections[0].setup;
    assert.equal(setup.direction, 'short');
    assert.equal(setup.entryPrice, 99.7);
    assert.ok(setup.stopLossPrice > setup.entryPrice);
    assert.ok(setup.tp1Price < setup.entryPrice);
    assert.ok(setup.tp2Price < setup.tp1Price);
  });

  test('non-qualifying evaluation creates no setup and no event', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const beforeSetups = await countRows('setups');
    const beforeEvents = await countRows('setup_state_events');
    // Far below the handler's history floor at this anchor → insufficient_data → fail closed.
    const res = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: AS_OF - 17 * HOUR,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.detections[0].qualified, false);
    assert.equal(body.detections[0].setup, null);
    assert.equal(body.detections[0].created, false);
    assert.ok(body.detections[0].failureReasons.length > 0);
    assert.equal(await countRows('setups'), beforeSetups);
    assert.equal(await countRows('setup_state_events'), beforeEvents);
  });

  test('unsupported/insufficient-data conditions never create setups (news filter fails closed)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, NEWS_FILTER_CONFIG);
    const beforeSetups = await countRows('setups');
    const res = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'USDJPY' },
      asOf: AS_OF,
    });
    assert.equal(res.statusCode, 200, res.body);
    for (const d of res.json().detections) {
      assert.equal(d.qualified, false);
      assert.equal(d.setup, null);
    }
    assert.equal(await countRows('setups'), beforeSetups);
  });

  test('repeated detection is idempotent: same setup, no duplicate event', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const first = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: AS_OF,
    });
    assert.equal(first.statusCode, 200);
    const setupId = first.json().detections[0].setup.id;
    const eventsBefore = await countRows('setup_state_events');

    const again = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: AS_OF,
    });
    assert.equal(again.statusCode, 200);
    const body = again.json();
    assert.equal(body.detections[0].qualified, true);
    assert.equal(body.detections[0].created, false);
    assert.equal(body.detections[0].setup.id, setupId);
    assert.equal(await countRows('setup_state_events'), eventsBefore);
  });

  test('concurrent duplicate detection creates exactly one setup and one event', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    // Fresh anchor so no earlier test owns this detection key.
    const anchor = AS_OF + 2 * HOUR;
    const ip = freshIp();
    const body = { instrument: { assetClass: 'forex', symbol: 'EURUSD' }, direction: 'long', asOf: anchor };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => detect(owner.cookie, strategyId, versionId, body, ip)),
    );
    for (const res of results) assert.equal(res.statusCode, 200, res.body);
    const created = results.filter((r) => r.json().detections[0].created);
    assert.equal(created.length, 1);
    const ids = new Set(results.map((r) => r.json().detections[0].setup.id));
    assert.equal(ids.size, 1);
    const setupId = [...ids][0] as string;
    const events = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM setup_state_events WHERE setup_id = $1',
      [setupId],
    );
    assert.equal(Number(events.rows[0]?.n), 1);
  });

  test('different asOfMs anchors are distinct detections (explicit-timestamp determinism)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const a = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: AS_OF,
    });
    const b = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: AS_OF + HOUR,
    });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    const idA = a.json().detections[0].setup.id as string;
    const idB = b.json().detections[0].setup.id as string;
    assert.notEqual(idA, idB);
    assert.equal(b.json().detections[0].setup.asOfMs, AS_OF + HOUR);
    assert.equal(b.json().detections[0].setup.detectedAt, new Date(AS_OF + HOUR).toISOString());
  });

  test('detection never transitions or resurrects an existing setup', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const anchor = AS_OF + 3 * HOUR;
    const first = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: anchor,
    });
    const setupId = first.json().detections[0].setup.id as string;
    const invalidated = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', reason: 'structure broke', asOf: anchor + 1 },
    });
    assert.equal(invalidated.statusCode, 200);

    const eventsBefore = await countRows('setup_state_events');
    const again = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: anchor,
    });
    assert.equal(again.statusCode, 200);
    const item = again.json().detections[0];
    assert.equal(item.qualified, true); // M3 still passes…
    assert.equal(item.created, false);
    assert.equal(item.setup.id, setupId);
    assert.equal(item.setup.state, 'invalidated'); // …but the terminal setup is untouched
    assert.equal(await countRows('setup_state_events'), eventsBefore);
  });

  test('unauthenticated detect/list/get/transitions → 401', async () => {
    const fake = '11111111-1111-1111-1111-111111111111';
    const noCookie = { 'x-forwarded-for': freshIp() };
    const d = await app.inject({
      method: 'POST',
      url: `/api/strategies/${fake}/versions/${fake}/detect`,
      headers: noCookie,
      payload: { instrument: { assetClass: 'forex', symbol: 'EURUSD' }, asOf: AS_OF },
    });
    assert.equal(d.statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/setups', headers: noCookie })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/setups/${fake}`, headers: noCookie })).statusCode, 401);
    const t = await app.inject({
      method: 'POST',
      url: `/api/setups/${fake}/transitions`,
      headers: noCookie,
      payload: { toState: 'triggered', asOf: AS_OF },
    });
    assert.equal(t.statusCode, 401);
  });

  test('foreign strategy/version/setup are masked 404s; malformed uuids 404', async () => {
    const victim = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(victim.cookie, engulfConfig('EURUSD', 'bullish'));
    const detected = await detect(victim.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: AS_OF,
    });
    const setupId = detected.json().detections[0].setup.id as string;
    const attacker = await registerUser();

    const foreignDetect = await detect(attacker.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      asOf: AS_OF,
    });
    assert.equal(foreignDetect.statusCode, 404);

    const foreignGet = await app.inject({
      method: 'GET',
      url: `/api/setups/${setupId}`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(foreignGet.statusCode, 404);

    const foreignTransition = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', asOf: AS_OF },
    });
    assert.equal(foreignTransition.statusCode, 404);

    // The victim's setup never appears in the attacker's list.
    const list = await app.inject({
      method: 'GET',
      url: '/api/setups',
      headers: { cookie: attacker.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(list.statusCode, 200);
    assert.ok(!list.json().setups.some((s: { id: string }) => s.id === setupId));

    // Malformed UUIDs are 404s, never 500s.
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/setups/not-a-uuid',
          headers: { cookie: victim.cookie, 'x-forwarded-for': freshIp() },
        })
      ).statusCode,
      404,
    );
    const malformedDetect = await detect(victim.cookie, 'not-a-uuid', versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      asOf: AS_OF,
    });
    assert.equal(malformedDetect.statusCode, 404);

    // Nonexistent setup → 404 with no writes.
    const missing = '22222222-2222-2222-2222-222222222222';
    const eventsBefore = await countRows('setup_state_events');
    const miss = await app.inject({
      method: 'POST',
      url: `/api/setups/${missing}/transitions`,
      headers: { cookie: victim.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'triggered', asOf: AS_OF },
    });
    assert.equal(miss.statusCode, 404);
    assert.equal(await countRows('setup_state_events'), eventsBefore);
  });

  test('draft version → 400; deprecated version still detects (M3 parity)', async () => {
    const owner = await registerUser();
    const created = await app.inject({
      method: 'POST',
      url: '/api/strategies',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { name: `Draft ${randomBytes(4).toString('hex')}`, version: engulfConfig('EURUSD', 'bullish') },
    });
    assert.equal(created.statusCode, 201);
    const strategy = created.json().strategy;
    const version = strategy.versions[0];
    const draft = await detect(owner.cookie, strategy.id, version.id, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      asOf: AS_OF,
    });
    assert.equal(draft.statusCode, 400);
    assert.ok(draft.json().error.message.includes('published'));

    const published = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategy.id}/versions/${version.id}/publish`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(published.statusCode, 200);
    const deprecated = await app.inject({
      method: 'POST',
      url: `/api/strategies/${strategy.id}/versions/${version.id}/deprecate`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(deprecated.statusCode, 200);
    const afterDeprecate = await detect(owner.cookie, strategy.id, version.id, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      asOf: AS_OF,
    });
    assert.equal(afterDeprecate.statusCode, 200, afterDeprecate.body);
    assert.equal(afterDeprecate.json().detections[0].qualified, true);
  });

  test('unknown instrument → 404; out-of-scope instrument → 400', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const unknown = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'NOPE' },
      asOf: AS_OF,
    });
    assert.equal(unknown.statusCode, 404);
    // GBPUSD exists platform-wide but this version scopes EURUSD only.
    const outOfScope = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'GBPUSD' },
      asOf: AS_OF,
    });
    assert.equal(outOfScope.statusCode, 400);
    assert.ok(outOfScope.json().error.message.includes('market scope'));
  });

  test('malformed bodies and queries → 400', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const missingAsOf = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    });
    assert.equal(missingAsOf.statusCode, 400);
    const badDirection = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'sideways',
      asOf: AS_OF,
    });
    assert.equal(badDirection.statusCode, 400);

    const setupId = (
      await detect(owner.cookie, strategyId, versionId, {
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        asOf: AS_OF,
      })
    ).json().detections[0].setup.id as string;

    const missingToState = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { asOf: AS_OF },
    });
    assert.equal(missingToState.statusCode, 400);
    const badState = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'sleeping', asOf: AS_OF },
    });
    assert.equal(badState.statusCode, 400);

    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/setups?limit=500',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(badLimit.statusCode, 400);
    const badFilter = await app.inject({
      method: 'GET',
      url: '/api/setups?state=napping',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(badFilter.statusCode, 400);
  });

  test('valid transitions walk the machine with exactly one event each', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const setupId = (
      await detect(owner.cookie, strategyId, versionId, {
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        asOf: AS_OF,
      })
    ).json().detections[0].setup.id as string;

    const triggered = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'triggered', reason: 'entry filled', asOf: AS_OF + 10 },
    });
    assert.equal(triggered.statusCode, 200, triggered.body);
    const parsed = setupTransitionResponseDtoSchema.safeParse(triggered.json());
    assert.equal(parsed.success, true);
    assert.equal(triggered.json().transitioned, true);
    assert.equal(triggered.json().setup.state, 'triggered');
    assert.equal(triggered.json().event.fromState, 'confirmed');
    assert.equal(triggered.json().event.toState, 'triggered');
    assert.equal(triggered.json().event.createdAt, new Date(AS_OF + 10).toISOString());

    const completed = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'completed', asOf: AS_OF + 20 },
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().setup.state, 'completed');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/setups/${setupId}`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(detail.statusCode, 200);
    const detailParsed = setupDetailDtoSchema.safeParse(detail.json());
    assert.equal(detailParsed.success, true);
    const events = detail.json().events;
    assert.equal(events.length, 3); // detected + 2 transitions, oldest first
    assert.deepEqual(events.map((e: { toState: string }) => e.toState), ['confirmed', 'triggered', 'completed']);
  });

  test('invalid transitions fail with no partial writes (rollback)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const setupId = (
      await detect(owner.cookie, strategyId, versionId, {
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        asOf: AS_OF,
      })
    ).json().detections[0].setup.id as string;
    const eventsBefore = await countRows('setup_state_events');

    // Skipping a machine step is rejected…
    const skipped = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'completed', asOf: AS_OF + 1 },
    });
    assert.equal(skipped.statusCode, 400);
    assert.ok(skipped.json().error.message.includes('Cannot transition'));

    // …with the setup row and the event log untouched.
    const row = await pool.query<{ state: string }>('SELECT state FROM setups WHERE id = $1', [setupId]);
    assert.equal(row.rows[0]?.state, 'confirmed');
    assert.equal(await countRows('setup_state_events'), eventsBefore);

    // Terminal states reject everything, also without writes.
    const terminal = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', reason: 'done here', asOf: AS_OF + 2 },
    });
    assert.equal(terminal.statusCode, 200);
    const afterTerminal = await countRows('setup_state_events');
    const escape = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'confirmed', asOf: AS_OF + 3 },
    });
    assert.equal(escape.statusCode, 400);
    assert.ok(escape.json().error.message.includes('terminal'));
    assert.equal(await countRows('setup_state_events'), afterTerminal);
  });

  test('repeated invalidation (and any same-state repeat) is an idempotent no-op', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const setupId = (
      await detect(owner.cookie, strategyId, versionId, {
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        asOf: AS_OF,
      })
    ).json().detections[0].setup.id as string;
    const first = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', reason: 'swept and reclaimed', asOf: AS_OF + 1 },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().transitioned, true);

    const eventsBefore = await countRows('setup_state_events');
    const repeat = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', reason: 'a different reason', asOf: AS_OF + 999 },
    });
    assert.equal(repeat.statusCode, 200);
    assert.equal(repeat.json().transitioned, false);
    assert.equal(repeat.json().event, null);
    assert.equal(repeat.json().setup.state, 'invalidated');
    assert.equal(await countRows('setup_state_events'), eventsBefore);

    // Expiry exits work from active states too.
    const owner2 = await registerUser();
    const v2 = await createPublishedVersion(owner2.cookie, engulfConfig('EURUSD', 'bullish'));
    const setup2 = (
      await detect(owner2.cookie, v2.strategyId, v2.versionId, {
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        asOf: AS_OF,
      })
    ).json().detections[0].setup.id as string;
    const expired = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId === setup2 ? setupId : setup2}/transitions`,
      headers: { cookie: owner2.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'expired', asOf: AS_OF + 5 },
    });
    assert.equal(expired.statusCode, 200);
    assert.equal(expired.json().setup.state, 'expired');
  });

  test('setup list supports owner-scoped filters and limits', async () => {
    const owner = await registerUser();
    const v1 = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const v2 = await createPublishedVersion(owner.cookie, engulfConfig('GBPUSD', 'bearish'));
    await seedCandles('GBPUSD', BEARISH_SHAPES, AS_OF);
    const longSetup = (
      await detect(owner.cookie, v1.strategyId, v1.versionId, {
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        asOf: AS_OF,
      })
    ).json().detections[0].setup;
    const shortSetup = (
      await detect(owner.cookie, v2.strategyId, v2.versionId, {
        instrument: { assetClass: 'forex', symbol: 'GBPUSD' },
        direction: 'short',
        asOf: AS_OF,
      })
    ).json().detections[0].setup;

    const all = await app.inject({
      method: 'GET',
      url: '/api/setups',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(all.statusCode, 200);
    const ids = all.json().setups.map((s: { id: string }) => s.id);
    assert.ok(ids.includes(longSetup.id) && ids.includes(shortSetup.id));

    const byDirection = await app.inject({
      method: 'GET',
      url: '/api/setups?direction=short',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    const shortIds = byDirection.json().setups.map((s: { id: string }) => s.id);
    assert.ok(shortIds.includes(shortSetup.id) && !shortIds.includes(longSetup.id));

    const byStrategy = await app.inject({
      method: 'GET',
      url: `/api/setups?strategyId=${v1.strategyId}`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    const strategyIds = byStrategy.json().setups.map((s: { id: string }) => s.id);
    assert.ok(strategyIds.includes(longSetup.id) && !strategyIds.includes(shortSetup.id));

    const limited = await app.inject({
      method: 'GET',
      url: '/api/setups?limit=1',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(limited.json().setups.length, 1);

    // Invalidating one setup makes the state filter discriminate.
    await app.inject({
      method: 'POST',
      url: `/api/setups/${longSetup.id}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', asOf: AS_OF + 1 },
    });
    const invalidated = await app.inject({
      method: 'GET',
      url: '/api/setups?state=invalidated',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
    });
    const invIds = invalidated.json().setups.map((s: { id: string }) => s.id);
    assert.ok(invIds.includes(longSetup.id) && !invIds.includes(shortSetup.id));
  });

  test('detection never triggers provider fetch-through (unseeded instrument → 200, not 502)', async () => {
    const owner = await registerUser();
    // XAUUSD is never seeded anywhere in this suite.
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('XAUUSD', 'bullish', 'commodity'));
    const res = await detect(owner.cookie, strategyId, versionId, {
      instrument: { assetClass: 'commodity', symbol: 'XAUUSD' },
      asOf: AS_OF,
    });
    assert.equal(res.statusCode, 200, res.body);
    for (const d of res.json().detections) {
      assert.equal(d.qualified, false);
      assert.equal(d.setup, null);
    }
  });

  test('detect endpoint rate limit: 21st request inside a minute → 429', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const ip = freshIp();
    const body = { instrument: { assetClass: 'forex', symbol: 'EURUSD' }, direction: 'long', asOf: AS_OF };
    let saw429 = false;
    for (let i = 0; i < 21; i++) {
      const res = await detect(owner.cookie, strategyId, versionId, body, ip);
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
      assert.equal(res.statusCode, 200, `request ${i + 1}: ${res.body}`);
    }
    assert.equal(saw429, true, 'expected the 20/min detection rate limit to fire');
  });

  test('audit events setup.detected and setup.transitioned are recorded', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD', 'bullish'));
    const setupId = (
      await detect(owner.cookie, strategyId, versionId, {
        instrument: { assetClass: 'forex', symbol: 'EURUSD' },
        direction: 'long',
        asOf: AS_OF,
      })
    ).json().detections[0].setup.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'triggered', asOf: AS_OF + 1 },
    });
    const detected = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE action = 'setup.detected' AND entity_id = $1",
      [versionId],
    );
    assert.ok(Number(detected.rows[0]?.n ?? '0') >= 1);
    const transitioned = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE action = 'setup.transitioned' AND entity_id = $1",
      [setupId],
    );
    assert.ok(Number(transitioned.rows[0]?.n ?? '0') >= 1);
  });

  test('no setup-score writes anywhere in the M4 suite', async () => {
    assert.equal(await countRows('setup_scores'), 0);
    const scored = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM setups WHERE quality_score IS NOT NULL',
    );
    assert.equal(Number(scored.rows[0]?.n ?? '0'), 0);
  });
});
