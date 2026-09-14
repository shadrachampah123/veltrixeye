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
  M5_SCORE_ENGINE_VERSION,
  qualityGrade,
  setupScoreResponseDtoSchema,
  setupScoreHistoryResponseDtoSchema,
  type SetupScoreDto,
  type StrategyVersionConfig,
} from '@veltrixeye/contracts';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, runMigrations, MIGRATIONS_DIR, CandleStore } from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5438;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_scoring';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let ctx: ReturnType<typeof createAppContext>;
let store: CandleStore;

const PASSWORD = 'correct-horse-42';
const uniqueEmail = () => `score_${randomBytes(6).toString('hex')}@example.com`;
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

const HOUR = 3_600_000;
const AS_OF = 1_800_000_000_000;
type Shape = [number, number, number, number]; // o,h,l,c

const FLAT_16: Shape[] = Array.from({ length: 16 }, () => [100, 100.5, 99.5, 100] as Shape);
// Bearish candle then a bullish engulfing close at the anchor (long passes).
const BULLISH_SHAPES: Shape[] = [...FLAT_16, [101, 101.2, 100, 100.2], [100, 101.5, 99.9, 101.3]];

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

function engulfConfig(symbol: string): StrategyVersionConfig {
  return {
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol }] },
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
    payload: { email: uniqueEmail(), password: PASSWORD, name: 'Score Trader' },
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
    payload: { name: `Score strategy ${randomBytes(4).toString('hex')}`, version: config },
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

/** Detect one long setup for the owner (shared fixture step). */
async function detectLong(cookie: string, strategyId: string, versionId: string, symbol: string, asOf = AS_OF): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/strategies/${strategyId}/versions/${versionId}/detect`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { instrument: { assetClass: 'forex', symbol }, direction: 'long', asOf },
  });
  assert.equal(res.statusCode, 200, res.body);
  const item = res.json().detections[0];
  assert.equal(item.qualified, true, res.body);
  return item.setup.id as string;
}

function score(
  cookie: string,
  setupId: string,
  body?: Record<string, unknown>,
  ip = freshIp(),
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/setups/${setupId}/score`,
    headers: { cookie, 'x-forwarded-for': ip },
    payload: body ?? {},
  });
}

function history(cookie: string, setupId: string, query = ''): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: `/api/setups/${setupId}/scores${query}`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
  });
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-scoring');
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

describe('m5 quality scoring api', () => {
  test('setup: no provider is registered (scoring must not need one)', () => {
    assert.equal(ctx.providerRegistry.list().length, 0);
  });

  test('valid scoring returns the explainable breakdown and persists exactly one row', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');
    const scoresBefore = await countRows('setup_scores');

    const res = await score(owner.cookie, setupId);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();

    const parsed = setupScoreResponseDtoSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify((parsed as { error?: unknown }).error ?? []));

    assert.equal(body.created, true);
    assert.equal(body.setup.id, setupId);
    assert.equal(body.score.setupId, setupId);
    assert.equal(body.score.engineVersion, M5_SCORE_ENGINE_VERSION);
    assert.equal(body.score.asOfMs, AS_OF); // default anchor = the setup's detection anchor
    assert.ok(Number.isInteger(body.score.total));
    assert.ok(body.score.total >= 0 && body.score.total <= 100);
    assert.equal(body.score.grade, qualityGrade(body.score.total));
    assert.equal(body.score.createdAt, new Date(AS_OF).toISOString());

    // Explainable breakdown: the seven pinned components, each with a raw
    // contribution, a maximum contribution and a reason.
    assert.equal(body.score.components.length, 7);
    const names = body.score.components.map((c: { name: string }) => c.name);
    assert.deepEqual(names, [
      'required_conditions',
      'confirmation_conditions',
      'disqualifier_clearance',
      'optional_support',
      'directional_alignment',
      'setup_completeness',
      'data_sufficiency',
    ]);
    for (const c of body.score.components) {
      assert.ok(typeof c.points === 'number' && typeof c.maxPoints === 'number');
      assert.ok(c.points >= 0 && c.points <= c.maxPoints);
      assert.ok(typeof c.explanation === 'string' && c.explanation.length > 0);
    }
    // Single-required-condition passing setup: 25+15+20+0+0+10+5 = 75 (pinned formula).
    assert.equal(body.score.total, 75);
    assert.equal(body.score.grade, 'B');

    // Exactly one row persisted; setups.quality_score refreshed in the same transaction.
    assert.equal(await countRows('setup_scores'), scoresBefore + 1);
    assert.equal(body.setup.qualityScore, body.score.total);
    const row = await pool.query<{ quality_score: number }>('SELECT quality_score FROM setups WHERE id = $1', [setupId]);
    assert.equal(row.rows[0]?.quality_score, body.score.total);
  });

  test('determinism: scoring the same context twice yields the identical stored score', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');

    const first = await score(owner.cookie, setupId);
    assert.equal(first.statusCode, 200, first.body);
    const again = await score(owner.cookie, setupId);
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(again.json().score, first.json().score); // identical id, total, breakdown
  });

  test('repeated scoring is idempotent: no duplicate row, created=false', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');

    const first = await score(owner.cookie, setupId);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().created, true);
    const before = await countRows('setup_scores');

    const again = await score(owner.cookie, setupId);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().created, false);
    assert.equal(again.json().score.id, first.json().score.id);
    assert.equal(await countRows('setup_scores'), before);
  });

  test('concurrent duplicate scoring creates exactly one score row', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');

    const ip = freshIp();
    const results = await Promise.all(Array.from({ length: 8 }, () => score(owner.cookie, setupId, {}, ip)));
    for (const res of results) assert.equal(res.statusCode, 200, res.body);
    const ids = new Set(results.map((r) => r.json().score.id));
    assert.equal(ids.size, 1, 'all concurrent scorers must see the same score row');
    assert.equal(results.filter((r) => r.json().created).length, 1);
    const rows = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM setup_scores WHERE setup_id = $1', [setupId]);
    assert.equal(Number(rows.rows[0]?.n), 1);
  });

  test('score history is append-only: distinct anchors append, repeats never overwrite', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');

    const first = await score(owner.cookie, setupId);
    assert.equal(first.statusCode, 200, first.body);
    const firstScore = first.json().score as SetupScoreDto;

    // A different anchor is a different scoring context ⇒ a new appended row.
    const later = await score(owner.cookie, setupId, { asOf: AS_OF + HOUR });
    assert.equal(later.statusCode, 200, later.body);
    assert.equal(later.json().created, true);
    const laterScore = later.json().score as SetupScoreDto;
    assert.notEqual(laterScore.id, firstScore.id);
    assert.equal(laterScore.asOfMs, AS_OF + HOUR);

    // The historical row is preserved untouched.
    const rows = await pool.query<{ id: string; as_of_ms: string; total: number; grade: string }>(
      'SELECT id, as_of_ms, total, grade FROM setup_scores WHERE setup_id = $1 ORDER BY id ASC',
      [setupId],
    );
    assert.equal(rows.rows.length, 2);
    assert.equal(rows.rows[0]?.id, String(firstScore.id));
    assert.equal(Number(rows.rows[0]?.as_of_ms), AS_OF);
    assert.equal(rows.rows[0]?.total, firstScore.total);
    assert.equal(rows.rows[1]?.total, laterScore.total);

    // setups.quality_score reflects the latest score only.
    const setup = await pool.query<{ quality_score: number }>('SELECT quality_score FROM setups WHERE id = $1', [setupId]);
    assert.equal(setup.rows[0]?.quality_score, laterScore.total);

    // History endpoint: newest anchor first, owner-scoped.
    const hist = await history(owner.cookie, setupId);
    assert.equal(hist.statusCode, 200, hist.body);
    const parsed = setupScoreHistoryResponseDtoSchema.safeParse(hist.json());
    assert.equal(parsed.success, true);
    assert.equal(hist.json().setupId, setupId);
    assert.equal(hist.json().scores.length, 2);
    assert.equal(hist.json().scores[0].id, laterScore.id);
    assert.equal(hist.json().scores[1].id, firstScore.id);

    // The append-only guard blocks mutation/deletion at the database level.
    await assert.rejects(
      () => pool.query('UPDATE setup_scores SET total = 1 WHERE id = $1', [String(firstScore.id)]),
      (err: unknown) => String((err as Error).message).includes('append-only'),
    );
    await assert.rejects(
      () => pool.query('DELETE FROM setup_scores WHERE id = $1', [String(firstScore.id)]),
      (err: unknown) => String((err as Error).message).includes('append-only'),
    );
  });

  test('insufficient data at the anchor never manufactures a high score', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');

    // Far before the seeded history: the engulfing condition reports
    // insufficient_data, the direction fails closed, and the score is
    // capped in the "ignore" band instead of being fabricated.
    const res = await score(owner.cookie, setupId, { asOf: AS_OF - 48 * HOUR });
    assert.equal(res.statusCode, 200, res.body);
    const scoreRow = res.json().score;
    assert.ok(scoreRow.total <= 64, `expected capped score, got ${scoreRow.total}`);
    assert.equal(scoreRow.grade, 'ignore');
    const dataSufficiency = scoreRow.components.find((c: { name: string }) => c.name === 'data_sufficiency');
    assert.equal(dataSufficiency.points, 0);
  });

  test('terminal setups are refused with no writes (scoring never touches lifecycle)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');

    const invalidated = await app.inject({
      method: 'POST',
      url: `/api/setups/${setupId}/transitions`,
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { toState: 'invalidated', reason: 'structure broke', asOf: AS_OF + 1 },
    });
    assert.equal(invalidated.statusCode, 200);

    const scoresBefore = await countRows('setup_scores');
    const eventsBefore = await countRows('setup_state_events');
    const res = await score(owner.cookie, setupId);
    assert.equal(res.statusCode, 400, res.body);
    assert.ok(res.json().error.message.includes('terminal state'));
    assert.equal(await countRows('setup_scores'), scoresBefore);
    assert.equal(await countRows('setup_state_events'), eventsBefore);
    const row = await pool.query<{ quality_score: number | null; state: string }>(
      'SELECT quality_score, state FROM setups WHERE id = $1',
      [setupId],
    );
    assert.equal(row.rows[0]?.quality_score, null);
    assert.equal(row.rows[0]?.state, 'invalidated');
  });

  test('scoring never transitions a setup (no lifecycle side effects)', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');
    const eventsBefore = await countRows('setup_state_events');

    const res = await score(owner.cookie, setupId);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().setup.state, 'confirmed'); // still exactly where M4 left it
    assert.equal(await countRows('setup_state_events'), eventsBefore); // no transition events
  });

  test('unauthenticated scoring and history → 401', async () => {
    const fake = '11111111-1111-1111-1111-111111111111';
    const noCookie = { 'x-forwarded-for': freshIp() };
    const s = await app.inject({
      method: 'POST',
      url: `/api/setups/${fake}/score`,
      headers: noCookie,
      payload: {},
    });
    assert.equal(s.statusCode, 401);
    const h = await app.inject({ method: 'GET', url: `/api/setups/${fake}/scores`, headers: noCookie });
    assert.equal(h.statusCode, 401);
  });

  test('ownership isolation: foreign setups are masked 404s for scoring and history', async () => {
    const victim = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(victim.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(victim.cookie, strategyId, versionId, 'EURUSD');
    await score(victim.cookie, setupId); // the victim has a stored score

    const attacker = await registerUser();
    const scoresBefore = await countRows('setup_scores');

    const foreignScore = await score(attacker.cookie, setupId);
    assert.equal(foreignScore.statusCode, 404);
    const foreignHistory = await history(attacker.cookie, setupId);
    assert.equal(foreignHistory.statusCode, 404);
    assert.equal(await countRows('setup_scores'), scoresBefore); // nothing written by the attacker
  });

  test('malformed and nonexistent inputs are masked/validated, never 500s, never writes', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');
    const scoresBefore = await countRows('setup_scores');

    assert.equal((await score(owner.cookie, 'not-a-uuid')).statusCode, 404);
    assert.equal((await history(owner.cookie, 'not-a-uuid')).statusCode, 404);

    const missing = '22222222-2222-2222-2222-222222222222';
    assert.equal((await score(owner.cookie, missing)).statusCode, 404);
    assert.equal((await history(owner.cookie, missing)).statusCode, 404);

    assert.equal((await score(owner.cookie, setupId, { asOf: 'now' })).statusCode, 400);
    assert.equal((await score(owner.cookie, setupId, { asOf: -5 })).statusCode, 400);
    assert.equal((await score(owner.cookie, setupId, { anchor: AS_OF })).statusCode, 400); // strict body
    assert.equal((await history(owner.cookie, setupId, '?limit=0')).statusCode, 400);
    assert.equal((await history(owner.cookie, setupId, '?limit=500')).statusCode, 400);

    assert.equal(await countRows('setup_scores'), scoresBefore);
  });

  test('oversized bodies are rejected by the global body limit (clean 413, never 500)', async () => {
    const owner = await registerUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/setups/11111111-1111-1111-1111-111111111111/score',
      headers: { cookie: owner.cookie, 'x-forwarded-for': freshIp() },
      payload: { junk: 'x'.repeat(300 * 1024) },
    });
    assert.equal(res.statusCode, 413);
  });

  test('scoring endpoint rate limit: 21st request inside a minute → 429', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');
    const ip = freshIp();
    let saw429 = false;
    for (let i = 0; i < 21; i++) {
      const res = await score(owner.cookie, setupId, {}, ip);
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
      assert.equal(res.statusCode, 200, `request ${i + 1}: ${res.body}`);
    }
    assert.equal(saw429, true, 'expected the 20/min scoring rate limit to fire');
  });

  test('audit event setup.scored is recorded with the score metadata', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');

    const res = await score(owner.cookie, setupId);
    assert.equal(res.statusCode, 200, res.body);
    const rows = await pool.query<{ metadata: Record<string, unknown> }>(
      "SELECT metadata FROM audit_events WHERE action = 'setup.scored' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
      [setupId],
    );
    assert.equal(rows.rows.length, 1);
    const metadata = rows.rows[0]?.metadata ?? {};
    assert.equal(metadata.engineVersion, M5_SCORE_ENGINE_VERSION);
    assert.equal(metadata.total, res.json().score.total);
    assert.equal(metadata.grade, res.json().score.grade);
    assert.equal(metadata.asOfMs, AS_OF);
    assert.equal(metadata.created, true);

    // No M6 alerting functionality anywhere in the scoring path.
    const alerts = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_events WHERE action LIKE 'alert%'",
    );
    assert.equal(Number(alerts.rows[0]?.n), 0);
  });

  test('history pagination: limit bounds the response', async () => {
    const owner = await registerUser();
    const { strategyId, versionId } = await createPublishedVersion(owner.cookie, engulfConfig('EURUSD'));
    await seedCandles('EURUSD', BULLISH_SHAPES, AS_OF);
    const setupId = await detectLong(owner.cookie, strategyId, versionId, 'EURUSD');
    await score(owner.cookie, setupId);
    await score(owner.cookie, setupId, { asOf: AS_OF + HOUR });

    const limited = await history(owner.cookie, setupId, '?limit=1');
    assert.equal(limited.statusCode, 200, limited.body);
    assert.equal(limited.json().scores.length, 1);

    const empty = await history(owner.cookie, await detectLong(owner.cookie, strategyId, versionId, 'EURUSD', AS_OF + 2 * HOUR));
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json().scores, []);
  });
});
