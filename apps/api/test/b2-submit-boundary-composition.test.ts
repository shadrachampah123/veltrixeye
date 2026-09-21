/**
 * B2 — production composition is Gate 9-protected.
 *
 * These tests exercise the REAL production composition root
 * (`createAppContext`): the MT5 provider registered in the application's
 * provider registry is built only by `createExecutionSubmitBoundary` — the
 * Gate 9-gated boundary — and the canonical dispatcher is exposed on the
 * execution context as the single provider-submit entry point.
 *
 * Proven over a real embedded PostgreSQL with the full migration chain:
 *   1. the registered MT5 provider refuses every bare `submitOrder` (no
 *      Gate 9 bypass through the registry), and exposes the Gate 9 barrier
 *      hand-off;
 *   2. the composition-level helper cannot construct an ungated provider;
 *   3. a full canonical dispatch through `ctx.execution.submitThroughGate9`
 *      commits the durable Gate 9 intent, reaches the provider through the
 *      consumed-barrier hand-off and — against the deliberately disabled
 *      production transport — records durable Gate 9 uncertainty.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import { createAppContext } from '../src/app.js';
import { createExecutionSubmitBoundary } from '../src/execution-submit-boundary.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  ProviderMutationLedger,
  hasGate9BarrierSubmit,
} from '@veltrixeye/core';
import {
  ExecutionProviderError,
  type ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5473;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_api_b2_submit_boundary';

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let dbUrl: string;

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

const uniqueEmail = () => `b2_api_${randomBytes(6).toString('hex')}@example.com`;
const newClientOrderId = () => `ve-${randomBytes(12).toString('hex')}`;
const newIdempotencyKey = () => createHash('sha256').update(randomBytes(32)).digest('hex');

async function makeUser(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'B2 Composition Tester') RETURNING id`,
    [uniqueEmail(), `argon2id:${randomBytes(16).toString('hex')}`],
  );
  return rows[0]!.id;
}

async function makeProfile(userId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,'demo','demo','mt5','b2-acct',true,'connected')`,
    [id, userId],
  );
  return id;
}

function validRequest(): ExecutionSubmitOrderRequest {
  return {
    clientOrderId: newClientOrderId(),
    idempotencyKey: newIdempotencyKey(),
    authorizationId: 'b2-api-auth',
    assetClass: 'commodity',
    symbol: 'XAUUSD',
    side: 'buy',
    orderType: 'market',
    quantity: 0.1,
    requestedPrice: null,
    stopLossPrice: 1990,
    takeProfitPrice: 2020,
  };
}

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-api-b2-submit-boundary');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({ dataDir, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  stopDb = db.stop;
  dbUrl = db.dbUrl;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
}, { timeout: 240_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

describe('B2 — production composition is Gate 9-protected', () => {
  test('the registered MT5 provider refuses every bare submitOrder (no Gate 9 bypass via the registry)', async () => {
    const ctx = createAppContext(pool, makeConfig({ DATABASE_URL: dbUrl }));
    const mt5 = ctx.execution.providers.get('mt5');

    assert.ok(mt5, 'the MT5 provider is registered in the production registry');
    assert.equal(
      hasGate9BarrierSubmit(mt5),
      true,
      'the production MT5 provider implements the Gate 9 barrier hand-off',
    );

    // A perfectly valid request through the registry is refused by the Gate
    // 9 gate — the only way in is the canonical dispatcher.
    await assert.rejects(
      () => mt5.submitOrder(validRequest()),
      (e: unknown) => e instanceof ExecutionProviderError
        && e.category === 'unavailable'
        && /Gate 9 submit barrier/i.test(e.message),
    );
  });

  test('the composition boundary is bound to the Gate 9 ledger and cannot construct an ungated provider', async () => {
    const boundary = createExecutionSubmitBoundary(pool);

    assert.ok(boundary.ledger instanceof ProviderMutationLedger, 'the boundary holds the Gate 9 ledger');
    assert.equal(hasGate9BarrierSubmit(boundary.mt5Provider), true);

    await assert.rejects(
      () => boundary.mt5Provider.submitOrder(validRequest()),
      (e: unknown) => e instanceof ExecutionProviderError && /Gate 9 submit barrier/i.test(e.message),
    );

    // The gated factory itself refuses to exist without a ledger.
    const { createGate9MT5ExecutionProvider, DisabledMT5Transport } = await import('@veltrixeye/core');
    assert.throws(
      () => createGate9MT5ExecutionProvider(new DisabledMT5Transport(), {
        enabled: false,
        environment: 'demo',
        broker: null,
        server: null,
        accountRef: null,
        symbols: new Map(),
      }, undefined as unknown as { ledger: ProviderMutationLedger }),
      TypeError,
    );
  });

  test('the execution context exposes the canonical dispatcher and a full dispatch records durable Gate 9 uncertainty', async () => {
    const ctx = createAppContext(pool, makeConfig({ DATABASE_URL: dbUrl }));
    assert.equal(typeof ctx.execution.submitThroughGate9, 'function', 'the composition wires the canonical submit boundary');

    const userId = await makeUser();
    const profileId = await makeProfile(userId);
    const request = validRequest();

    const result = await ctx.execution.submitThroughGate9({
      userId,
      executionProfileId: profileId,
      providerSlug: 'mt5',
      environment: 'demo',
      accountRef: 'b2-acct',
      request,
    });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') throw new Error('canonical dispatch through the production context failed');
    assert.equal(result.kind, 'submitted');
    // The disabled production transport refuses: durable uncertainty, never
    // silent success — and the hand-off itself ran (providerCalled).
    assert.equal(result.result.providerCalled, true, 'the Gate 9 barrier hand-off reached the provider');
    assert.equal(result.result.outcome, 'uncertain');
    assert.equal(result.result.intentState, 'uncertain');
    assert.equal(result.result.requiresReconciliation, true);

    // The Gate 9 durable record exists in the migrated production schema.
    const { rows } = await pool.query<{ status: string; provider_slug: string }>(
      `SELECT status, provider_slug FROM execution_provider_intents WHERE client_order_id = $1`,
      [request.clientOrderId],
    );
    assert.equal(rows.length, 1, 'exactly one durable Gate 9 intent was committed');
    assert.equal(rows[0]!.status, 'uncertain');
    assert.equal(rows[0]!.provider_slug, 'mt5');
  });
});
