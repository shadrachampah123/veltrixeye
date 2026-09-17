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
import { createPool, runMigrations, MIGRATIONS_DIR } from '@veltrixeye/core';
import {
  PAPER_SIMULATOR_VERSION,
  RISK_ENGINE_VERSION,
  type PaperFillDto,
  type PaperPositionDto,
  type ReconciliationDto,
} from '@veltrixeye/contracts';

/**
 * M8.3 — paper execution simulator API suite.
 *
 * Proves over real HTTP (fastify inject):
 *  - the paper workflow is session-only, owner-scoped and masked;
 *  - the ONLY client inputs are identifiers — a price, quantity, approval,
 *    P&L or execution state in the body is a 400;
 *  - automation stays OFF and no live/broker/credential surface exists;
 *  - a server-issued risk decision is mandatory before any paper order;
 *  - entry, SL/TP exit, explicit close and the realized/unrealized P&L the
 *    Trading UI shows all come from server state;
 *  - reconciliation is exposed read-only (findings are never auto-corrected).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5445;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_test_paper_api';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof buildApp>>;
let dbUrl: string;

const uniqueEmail = () => `paper_api_${randomBytes(6).toString('hex')}@example.com`;
const freshIp = () =>
  `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

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

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-paper-api');
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
  const config = makeConfig({ DATABASE_URL: dbUrl });
  const ctx = createAppContext(pool, config);
  app = await buildApp(config, ctx);
  await app.ready();
}, { timeout: 180_000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await stopDb?.();
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

interface Session {
  cookie: string;
  user: { id: string; email: string };
}

async function registerUser(): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: 'correct-horse-42', name: 'Paper API Tester' },
  });
  assert.equal(res.statusCode, 201, res.body);
  const user = res.json().user;
  return { cookie: cookieFrom(res), user };
}

async function createProfile(session: Session): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/execution/profiles',
    headers: { cookie: session.cookie, 'x-forwarded-for': freshIp() },
    payload: { mode: 'paper', providerSlug: 'paper' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().profile.id as string;
}

let strategyCounter = 0;

/** A published strategy version whose setup is immediately simulatable. */
async function makeSetup(
  userId: string,
  opts: { direction?: 'long' | 'short'; entry?: number; stop?: number; tp?: number } = {},
): Promise<{ setupId: string; instrumentId: string }> {
  strategyCounter += 1;
  const direction = opts.direction ?? 'long';
  const entry = opts.entry ?? 1.1;
  const stop = opts.stop ?? (direction === 'long' ? 1.095 : 1.105);
  const tp = opts.tp ?? (direction === 'long' ? 1.11 : 1.09);
  const strategy = await pool.query<{ id: string }>(
    'INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id',
    [userId, `paper api strategy ${strategyCounter}`],
  );
  const version = await pool.query<{ id: string }>(
    `INSERT INTO strategy_versions (strategy_id, version_number, status, created_by)
     VALUES ($1, 1, 'draft', $2) RETURNING id`,
    [strategy.rows[0]!.id, userId],
  );
  await pool.query(
    `INSERT INTO strategy_timeframes (version_id, role, timeframe)
     VALUES ($1, 'htf_bias', '1h'), ($1, 'setup', '5m'), ($1, 'entry', '1m')`,
    [version.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO strategy_risk_config
       (version_id, min_rr, stop_loss_method, stop_loss_buffer, stop_loss_buffer_unit,
        take_profit_method, tp1_rr, tp2_rr, tp3_rr, min_quality_score)
     VALUES ($1, 2, 'structure', 0, 'pips', 'rr', 2, 3, 4, 60)`,
    [version.rows[0]!.id],
  );
  await pool.query(`UPDATE strategy_versions SET status = 'published', published_at = now() WHERE id = $1`, [
    version.rows[0]!.id,
  ]);
  const instrument = await pool.query<{ id: string }>(
    `SELECT id FROM instruments WHERE asset_class = 'forex' AND symbol = 'EURUSD'`,
  );
  const setup = await pool.query<{ id: string }>(
    `INSERT INTO setups
       (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms,
        entry_price, stop_loss_price, tp1_price, quality_score)
     VALUES ($1,$2,'confirmed',$3, to_timestamp($4 / 1000.0), $4,$5,$6,$7,80) RETURNING id`,
    [version.rows[0]!.id, instrument.rows[0]!.id, direction, Date.now() - 1000, entry, stop, tp],
  );
  return { setupId: setup.rows[0]!.id, instrumentId: instrument.rows[0]!.id };
}

async function seedCandle(
  instrumentId: string,
  ts: number,
  ohlc: { open: number; high: number; low: number; close: number },
  timeframe = '5m',
): Promise<void> {
  await pool.query(
    `INSERT INTO candles (instrument_id, timeframe, ts, open, high, low, close, provider_slug)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'test-provider')
     ON CONFLICT (instrument_id, timeframe, ts) DO UPDATE
       SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close`,
    [instrumentId, timeframe, ts, ohlc.open, ohlc.high, ohlc.low, ohlc.close],
  );
}

/** The candle store is global; each test starts from a clean symbol so its
 *  entry price is deterministic and not inherited from the previous test. */
async function resetCandles(instrumentId: string): Promise<void> {
  await pool.query('DELETE FROM candles WHERE instrument_id = $1', [instrumentId]);
}

async function seedEntryCandle(instrumentId: string, price = 1.1): Promise<void> {
  await resetCandles(instrumentId);
  await seedCandle(instrumentId, Date.now() - 60_000, {
    open: price,
    high: price,
    low: price,
    close: price,
  });
}

async function getJson(session: Session, url: string) {
  const res = await app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
  return { status: res.statusCode, body: res.json() };
}

async function postJson(session: Session, url: string, payload: unknown) {
  const res = await app.inject({
    method: 'POST',
    url,
    headers: { cookie: session.cookie, 'x-forwarded-for': freshIp() },
    payload: payload as object,
  });
  return { status: res.statusCode, body: res.json() };
}

async function simulate(session: Session, setupId: string, profileId: string) {
  return postJson(session, '/api/execution/paper/simulate', {
    setupId,
    executionProfileId: profileId,
  });
}

/* -------------------------------------------------------------------------- */
/* authentication + status                                                     */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper API — authentication and status', () => {
  test('every paper route requires a session', async () => {
    const routes = [
      ['GET', '/api/execution/paper/status'],
      ['GET', '/api/execution/paper/orders'],
      ['GET', '/api/execution/paper/positions'],
      ['GET', '/api/execution/paper/fills'],
      ['GET', '/api/execution/paper/reconciliations'],
      ['POST', '/api/execution/paper/simulate'],
      ['POST', '/api/execution/paper/evaluate'],
      ['POST', '/api/execution/paper/reconcile'],
      ['POST', '/api/execution/paper/positions/11111111-1111-4111-8111-111111111111/close'],
    ] as const;
    for (const [method, url] of routes) {
      const res = await app.inject({ method, url, payload: {} });
      assert.equal(res.statusCode, 401, `${method} ${url} must require a session`);
    }
  });

  test('status is honest: simulator ready, automation OFF, live impossible', async () => {
    const session = await registerUser();
    const { status, body } = await getJson(session, '/api/execution/paper/status');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.simulatorVersion, PAPER_SIMULATOR_VERSION);
    assert.equal(body.riskEngineVersion, RISK_ENGINE_VERSION);
    assert.equal(body.providerId, 'paper');
    assert.equal(body.providerConfigured, true);
    assert.equal(body.providerHealthy, true);
    assert.equal(body.automationOff, true);
    assert.equal(body.automatedPathGate, 'entitlement');
    assert.equal(body.liveExecutionAvailable, false);
    assert.equal(body.orders, 0);
    assert.equal(body.openPositions, 0);
    assert.equal(body.openPl, 0);
    assert.equal(body.closedPl, 0);

    // No live/demo/broker affordance and no secret material in the payload.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const needle of ['password', 'api_key', 'apikey', 'secret', 'token', 'exness', 'mt5']) {
      assert.ok(!serialized.includes(needle), `status must not leak "${needle}"`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* strict input surface                                                        */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper API — the client may only send identifiers', () => {
  test('client-supplied approval, price, size, P&L or state is a 400', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId } = await makeSetup(session.user.id);
    const attacks: Record<string, unknown>[] = [
      { setupId, executionProfileId: profileId, quantity: 5 },
      { setupId, executionProfileId: profileId, price: 1.5 },
      { setupId, executionProfileId: profileId, approved: true },
      { setupId, executionProfileId: profileId, riskApproved: true },
      { setupId, executionProfileId: profileId, positionSize: 10 },
      { setupId, executionProfileId: profileId, stopLossPrice: 1.09 },
      { setupId, executionProfileId: profileId, takeProfitPrice: 1.2 },
      { setupId, executionProfileId: profileId, realizedPnl: 9999 },
      { setupId, executionProfileId: profileId, unrealizedPnl: 9999 },
      { setupId, executionProfileId: profileId, status: 'filled', clientOrderId: 've-forged' },
      { setupId: 'not-a-uuid', executionProfileId: profileId },
      { executionProfileId: profileId },
    ];
    for (const payload of attacks) {
      const res = await postJson(session, '/api/execution/paper/simulate', payload);
      assert.equal(res.status, 400, `must refuse ${JSON.stringify(payload)}`);
    }
    // Nothing was created by any of the attempts.
    assert.equal((await getJson(session, '/api/execution/paper/orders')).body.orders.length, 0);
  });

  test('position actions take no body fields at all', async () => {
    const session = await registerUser();
    const res = await postJson(session, '/api/execution/paper/evaluate', { price: 1.5 });
    assert.equal(res.status, 400);
    const close = await postJson(
      session,
      '/api/execution/paper/positions/11111111-1111-4111-8111-111111111111/close',
      { price: 1.5 },
    );
    assert.equal(close.status, 400);
  });
});

/* -------------------------------------------------------------------------- */
/* entry + exit + P&L                                                          */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper API — simulate, exit and P&L', () => {
  test('a risk-approved long setup fills and is visible in every read model', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);

    const { status, body } = await simulate(session, setupId, profileId);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.simulated, true, body.reason ?? '');
    assert.equal(body.automationOff, true);
    assert.equal(body.riskEngineVersion, RISK_ENGINE_VERSION);
    assert.ok(body.riskDecisionId, 'the paper order cites a server-issued risk decision');
    assert.equal(body.order.side, 'buy');
    assert.equal(body.order.status, 'filled');
    assert.equal(body.order.simulated, true);
    assert.equal(body.order.quantity, body.position.quantity);
    assert.equal(body.order.averageFillPrice, 1.1);
    assert.equal(body.order.stopLossPrice, 1.095);
    assert.equal(body.order.takeProfitPrice, 1.11);
    assert.equal(body.position.status, 'open');
    assert.equal(body.position.direction, 'long');
    assert.equal(body.position.averageEntryPrice, 1.1);
    assert.equal(body.position.exitPrice, null);
    assert.equal(body.position.realizedPl, null);
    assert.equal(body.position.markPrice, 1.1);
    assert.equal(body.fills.length, 1);
    assert.equal(body.fills[0].fillType, 'entry');

    const orders = await getJson(session, '/api/execution/paper/orders');
    assert.equal(orders.body.orders.length, 1);
    assert.equal(orders.body.orders[0].id, body.order.id);
    const positions = await getJson(session, '/api/execution/paper/positions');
    assert.equal(positions.body.positions.length, 1);
    assert.equal(positions.body.positions[0].openedByOrderId, body.order.id);
    const fills = await getJson(session, '/api/execution/paper/fills');
    assert.equal(fills.body.fills.length, 1);

    const paperStatus = await getJson(session, '/api/execution/paper/status');
    assert.equal(paperStatus.body.orders, 1);
    assert.equal(paperStatus.body.openPositions, 1);
    assert.equal(paperStatus.body.fills, 1);
    assert.equal(paperStatus.body.openPl, 0);
  });

  test('a duplicate submission replays instead of duplicating the position', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);

    const first = await simulate(session, setupId, profileId);
    const second = await simulate(session, setupId, profileId);
    assert.equal(first.body.simulated, true);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.order.id, first.body.order.id);
    assert.equal((await getJson(session, '/api/execution/paper/orders')).body.orders.length, 1);
    assert.equal((await getJson(session, '/api/execution/paper/positions')).body.positions.length, 1);
    assert.equal((await getJson(session, '/api/execution/paper/fills')).body.fills.length, 1);
  });

  test('SL/TP evaluation closes at the take profit with the exact realized P&L', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);
    const opened = await simulate(session, setupId, profileId);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');

    // A fresh bar taps the take profit.
    await seedCandle(instrumentId, Date.now(), { open: 1.105, high: 1.112, low: 1.104, close: 1.111 });
    const evaluated = await postJson(session, '/api/execution/paper/evaluate', {});
    assert.equal(evaluated.status, 200, evaluated.body);
    assert.equal(evaluated.body.closed, 1);
    assert.equal(evaluated.body.outcomes[0].exitReason, 'take_profit');
    assert.equal(evaluated.body.outcomes[0].realizedPl, 100);

    // Repeated evaluation is a no-op (no second exit, no second P&L swing).
    const again = await postJson(session, '/api/execution/paper/evaluate', {});
    assert.equal(again.body.evaluated, 0);

    const positions = await getJson(session, '/api/execution/paper/positions');
    const closed = positions.body.positions.find((p: PaperPositionDto) => p.id === opened.body.position.id);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.exitReason, 'take_profit');
    assert.equal(closed.exitPrice, 1.11);
    assert.equal(closed.realizedPl, 100);
    assert.ok(closed.closedByOrderId);

    const paperStatus = await getJson(session, '/api/execution/paper/status');
    assert.equal(paperStatus.body.openPositions, 0);
    assert.equal(paperStatus.body.closedPositions, 1);
    assert.equal(paperStatus.body.closedPl, 100);
    assert.equal(paperStatus.body.openPl, 0);

    const fills = await getJson(session, '/api/execution/paper/fills');
    assert.deepEqual(
      fills.body.fills.map((f: PaperFillDto) => f.fillType).sort(),
      ['entry', 'take_profit'],
    );
  });

  test('a short setup mirrors the levels and closes at its stop', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id, { direction: 'short' });
    await seedEntryCandle(instrumentId);

    const opened = await simulate(session, setupId, profileId);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');
    assert.equal(opened.body.order.side, 'sell');
    assert.equal(opened.body.position.direction, 'short');
    assert.equal(opened.body.position.stopLossPrice, 1.105);
    assert.equal(opened.body.position.takeProfitPrice, 1.09);

    await seedCandle(instrumentId, Date.now(), { open: 1.1, high: 1.107, low: 1.099, close: 1.106 });
    const evaluated = await postJson(session, '/api/execution/paper/evaluate', {});
    assert.equal(evaluated.body.closed, 1);
    assert.equal(evaluated.body.outcomes[0].exitReason, 'stop_loss');
    assert.equal(evaluated.body.outcomes[0].realizedPl, -50);
  });

  test('a position can be closed explicitly at the server price', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);
    const opened = await simulate(session, setupId, profileId);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');

    const closed = await postJson(
      session,
      `/api/execution/paper/positions/${opened.body.position.id}/close`,
      {},
    );
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.exitReason, 'close');
    // Closed at the fresh server price (1.1) with no fabricated P&L.
    assert.equal(closed.body.realizedPl, 0);

    // Closing again is refused (the position is already closed).
    const second = await postJson(
      session,
      `/api/execution/paper/positions/${opened.body.position.id}/close`,
      {},
    );
    assert.equal(second.status, 400);

    // Unknown / foreign position ids are masked 404s.
    const foreign = await postJson(
      session,
      '/api/execution/paper/positions/11111111-1111-4111-8111-111111111111/close',
      {},
    );
    assert.equal(foreign.status, 404);
  });

  test('unrealized P&L is marked from server data, never from the client', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);
    const opened = await simulate(session, setupId, profileId);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');

    await seedCandle(instrumentId, Date.now(), { open: 1.102, high: 1.106, low: 1.101, close: 1.105 });
    const evaluated = await postJson(session, '/api/execution/paper/evaluate', {});
    assert.equal(evaluated.body.closed, 0);

    const status = await getJson(session, '/api/execution/paper/status');
    assert.equal(status.body.openPl, 50); // (1.105 − 1.100) × 0.1 × 100 000
    const positions = await getJson(session, '/api/execution/paper/positions');
    const open = positions.body.positions.find((p: PaperPositionDto) => p.id === opened.body.position.id);
    assert.equal(open.status, 'open');
    assert.equal(open.unrealizedPl, 50);
    assert.equal(open.markPrice, 1.105);
  });
});

/* -------------------------------------------------------------------------- */
/* safety refusals                                                             */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper API — refusals are fail-closed and auditable', () => {
  test('a missing/forged risk decision id refuses instead of executing', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);

    const res = await postJson(session, '/api/execution/paper/simulate', {
      setupId,
      executionProfileId: profileId,
      riskDecisionId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(res.status, 404);
    assert.equal((await getJson(session, '/api/execution/paper/orders')).body.orders.length, 0);
    assert.equal((await getJson(session, '/api/execution/paper/positions')).body.positions.length, 0);
  });

  test('a foreign setup or profile is a masked 404 and writes nothing', async () => {
    const owner = await registerUser();
    const ownerProfile = await createProfile(owner);
    const { setupId, instrumentId } = await makeSetup(owner.user.id);
    await seedEntryCandle(instrumentId);

    const intruder = await registerUser();
    const intruderProfile = await createProfile(intruder);

    const foreignSetup = await simulate(intruder, setupId, intruderProfile);
    assert.equal(foreignSetup.status, 404);
    const foreignProfile = await simulate(intruder, setupId, ownerProfile);
    assert.equal(foreignProfile.status, 404);
    assert.equal((await getJson(intruder, '/api/execution/paper/orders')).body.orders.length, 0);
    assert.equal((await getJson(intruder, '/api/execution/paper/fills')).body.fills.length, 0);
  });

  test('an active kill switch blocks the simulation (automation is OFF regardless)', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);

    await pool.query(
      `INSERT INTO kill_switches (scope, target_id, active, reason)
       VALUES ('user', $1, true, 'test')
       ON CONFLICT (scope, target_id) WHERE scope <> 'global'
         DO UPDATE SET active = true, reason = 'test', updated_at = now()`,
      [session.user.id],
    );
    const blocked = await simulate(session, setupId, profileId);
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.simulated, false);
    assert.equal(blocked.body.gate, 'kill_switch');
    assert.equal(blocked.body.order, null);
    assert.equal((await getJson(session, '/api/execution/paper/orders')).body.orders.length, 0);
  });

  test('the automated path is still impossible: the toggle 403s for every plan', async () => {
    for (const plan of ['free', 'pro', 'premium'] as const) {
      const session = await registerUser();
      if (plan !== 'free') {
        await pool.query('UPDATE subscriptions SET plan = $1 WHERE user_id = $2', [plan, session.user.id]);
      }
      const res = await postJson(session, '/api/execution/automation', { enabled: true });
      assert.equal(res.status, 403, `automation must stay OFF for ${plan}`);
      const status = await getJson(session, '/api/execution/paper/status');
      assert.equal(status.body.automationOff, true);
    }
  });

  test('missing or stale market data refuses the entry (no invented price)', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await resetCandles(instrumentId); // no candle seeded at all
    const res = await simulate(session, setupId, profileId);
    assert.equal(res.status, 200);
    assert.equal(res.body.simulated, false);
    assert.equal(res.body.gate, 'market_price_fresh');
    assert.equal(res.body.order, null);
    assert.equal((await getJson(session, '/api/execution/paper/fills')).body.fills.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* reconciliation + owner-scoped reads                                         */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper API — reconciliation and isolation', () => {
  test('consistent simulated state reconciles clean and is exposed read-only', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);
    const opened = await simulate(session, setupId, profileId);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');

    const sweep = await postJson(session, '/api/execution/paper/reconcile', {});
    assert.equal(sweep.status, 200, JSON.stringify(sweep.body));
    assert.equal(sweep.body.ok, true, JSON.stringify(sweep.body.findings));
    assert.ok(sweep.body.reconciliations.length >= 2);

    const trail = await getJson(session, '/api/execution/paper/reconciliations');
    assert.equal(trail.status, 200);
    assert.ok(trail.body.reconciliations.length >= 2);
    assert.ok(trail.body.reconciliations.every((r: ReconciliationDto) => r.outcome === 'ok'));
    assert.equal(trail.body.reconciliations[0].simulatorVersion, PAPER_SIMULATOR_VERSION);
  });

  test('tampered state is DETECTED, reported and never silently corrected', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);
    const opened = await simulate(session, setupId, profileId);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');

    // Tamper directly in the database: a filled order wearing a non-terminal
    // status while still holding its fill.
    await pool.query(`UPDATE execution_orders SET status = 'accepted' WHERE id = $1`, [
      opened.body.order.id,
    ]);
    const sweep = await postJson(session, '/api/execution/paper/reconcile', {});
    assert.equal(sweep.status, 200);
    assert.equal(sweep.body.ok, false);
    assert.ok(sweep.body.findings.includes('order_fill_quantity_mismatch'));

    // The tampered value is still there: the simulator reports, never repairs.
    const row = await pool.query<{ status: string }>('SELECT status FROM execution_orders WHERE id = $1', [
      opened.body.order.id,
    ]);
    assert.equal(row.rows[0]!.status, 'accepted');
  });

  test('every read model is owner-scoped: another user sees nothing', async () => {
    const owner = await registerUser();
    const ownerProfile = await createProfile(owner);
    const { setupId, instrumentId } = await makeSetup(owner.user.id);
    await seedEntryCandle(instrumentId);
    const opened = await simulate(owner, setupId, ownerProfile);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');

    const other = await registerUser();
    for (const url of [
      '/api/execution/paper/orders',
      '/api/execution/paper/positions',
      '/api/execution/paper/fills',
      '/api/execution/paper/reconciliations',
    ]) {
      const { status, body } = await getJson(other, url);
      assert.equal(status, 200);
      const key = url.split('/').pop() as string;
      assert.equal(body[key].length, 0, `${url} must be empty for another user`);
    }
    const status = await getJson(other, '/api/execution/paper/status');
    assert.equal(status.body.orders, 0);
    assert.equal(status.body.openPositions, 0);
    assert.equal(status.body.closedPl, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* no live/broker surface                                                      */
/* -------------------------------------------------------------------------- */

describe('M8.3 paper API — no broker, credential or live-execution surface', () => {
  test('broker/demo/credential endpoints do not exist', async () => {
    const session = await registerUser();
    const attempts = [
      ['POST', '/api/execution/paper/orders'],
      ['POST', '/api/execution/paper/broker'],
      ['POST', '/api/execution/broker/connect'],
      ['POST', '/api/execution/credentials'],
      ['POST', '/api/execution/live/orders'],
      ['POST', '/api/execution/demo/connect'],
      ['POST', '/api/execution/exness/connect'],
      ['POST', '/api/execution/mt5/connect'],
      ['POST', '/api/execution/providers/paper/submit'],
      ['GET', '/api/execution/paper/credentials'],
    ] as const;
    for (const [method, url] of attempts) {
      const res = await app.inject({
        method,
        url,
        headers: { cookie: session.cookie, 'x-forwarded-for': freshIp() },
        payload: {},
      });
      assert.ok(
        res.statusCode === 404 || res.statusCode === 405,
        `${method} ${url} must not exist (got ${res.statusCode})`,
      );
    }
  });

  test('no paper response carries credential material or a broker order id', async () => {
    const session = await registerUser();
    const profileId = await createProfile(session);
    const { setupId, instrumentId } = await makeSetup(session.user.id);
    await seedEntryCandle(instrumentId);
    const opened = await simulate(session, setupId, profileId);
    assert.equal(opened.body.simulated, true, opened.body.reason ?? '');

    const payloads = [
      opened.body,
      (await getJson(session, '/api/execution/paper/orders')).body,
      (await getJson(session, '/api/execution/paper/positions')).body,
      (await getJson(session, '/api/execution/paper/fills')).body,
      (await getJson(session, '/api/execution/paper/status')).body,
    ];
    for (const payload of payloads) {
      const serialized = JSON.stringify(payload).toLowerCase();
      for (const needle of ['password', 'api_key', 'apikey', 'secret', 'token', 'exness', 'mt5', 'login']) {
        assert.ok(!serialized.includes(needle), `paper payload must not contain "${needle}"`);
      }
    }
  });
});
