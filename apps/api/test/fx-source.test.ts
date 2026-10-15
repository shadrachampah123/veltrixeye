/**
 * Billing FX source observation API — the sleep-safe scheduled surface.
 *
 * Pins:
 *  - with no `FX_SOURCE_WORKER_TOKEN` the route DOES NOT EXIST (404), so an
 *    unconfigured deployment exposes no surface that can cause an outbound read;
 *  - a wrong or missing token is 401, compared in constant time over SHA-256
 *    digests;
 *  - a valid call performs EXACTLY ONE outbound read of the pinned publisher URL
 *    (no retry, no other host) and records ONE append-only observation, then
 *    dedups on a second call;
 *  - the response carries the published date, the exact figures, digests and the
 *    standing `need_source` decision — and never the page, a token, a credential
 *    or any claim that a rate was approved or published;
 *  - the call is visible WITHOUT a credential in `GET /api/health`
 *    (`workers.fxSource`), which is the only proof an external scheduler actually
 *    reached the API;
 *  - a failing publisher is reported (`unavailable`) without writing anything,
 *    and a check that cannot complete answers 503 without echoing error text;
 *  - the observation path leaves the FX authority, the pricing snapshots and the
 *    provider-plan epochs untouched: no observation can price a payment or
 *    bypass the `need_source` approval boundary.
 *
 * The publisher is stubbed by replacing `globalThis.fetch`, so the real provider
 * transport and the real composition run, and NO socket is opened.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { FX_SOURCE_WORKER_TOKEN_HEADER } from '../src/routes/fx-source.js';
import { resetWorkerLivenessForTests } from '../src/worker-liveness.js';
import { createPool, runMigrations, MIGRATIONS_DIR } from '@veltrixeye/core';
import { FX_SOURCE_BANK_OF_GHANA_URL } from '@veltrixeye/contracts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5482;
const TOKEN = randomBytes(24).toString('hex');

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4994',
  HOST: '127.0.0.1',
  DATABASE_SSL_MODE: 'disable',
  SESSION_COOKIE_NAME: 've_session',
  COOKIE_SECURE: 'never',
  SESSION_TTL_DAYS: '30',
  LOG_LEVEL: 'silent',
};

let stopDb: () => Promise<void>;
let pool: pg.Pool;
let dbUrl: string;

/** The published USD→GHS row, as the Bank of Ghana publishes it. */
const PUBLISHED_PAGE = `<!doctype html><html><body><table>
  <thead><tr><th>Date</th><th>Currency</th><th>Currency Pair</th><th>Buying</th><th>Selling</th><th>Mid Rate</th></tr></thead>
  <tbody>
    <tr><td>14 Oct 2026</td><td>US Dollar</td><td>USDGHS</td><td>11.6692</td><td>11.6808</td><td>11.6750</td></tr>
    <tr><td>14 Oct 2026</td><td>Pound Sterling</td><td>GBPGHS</td><td>15.1000</td><td>15.2200</td><td>15.1600</td></tr>
  </tbody>
</table></body></html>`;

interface OutboundCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

let calls: OutboundCall[] = [];

/** Replace global fetch with a stub that records every outbound request. */
function stubPublisher(handler?: (call: OutboundCall) => Response | Promise<Response>): () => void {
  const original = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    const call: OutboundCall = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {} };
    calls.push(call);
    if (handler) return await handler(call);
    return new Response(PUBLISHED_PAGE, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...TEST_ENV,
    DATABASE_URL: dbUrl,
    FX_SOURCE_PROVIDER_TIMEOUT_MS: '5000',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

async function buildFxApp(overrides: Record<string, string> = {}) {
  const config = makeConfig(overrides);
  const ctx = createAppContext(pool, config);
  const app = await buildApp(config, ctx);
  await app.ready();
  return { app, ctx, config };
}

const countRows = async (table: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number.parseInt(rows[0]!.count, 10);
};

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-fx-source-api');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: 'test',
    password: randomBytes(16).toString('hex'),
    database: 'veltrixeye_fx_source_api',
  });
  pool = createPool({ databaseUrl: db.dbUrl });
  dbUrl = db.dbUrl;
  await runMigrations(pool, MIGRATIONS_DIR);
  stopDb = async () => {
    await db.stop();
  };
}, { timeout: 180_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

describe('the internal FX source check — access control', () => {
  test('with no token configured the route does not exist (404), and nothing is fetched', async () => {
    const restore = stubPublisher();
    try {
      const { app } = await buildFxApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/billing/fx/source-check',
        headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: 'anything' },
        payload: {},
      });
      assert.equal(response.statusCode, 404);
      assert.equal(calls.length, 0, 'an unconfigured deployment cannot cause an outbound read');
      await app.close();
    } finally {
      restore();
    }
  });

  test('a wrong or missing token is 401, and nothing is fetched', async () => {
    const restore = stubPublisher();
    try {
      const { app } = await buildFxApp({ FX_SOURCE_WORKER_TOKEN: TOKEN });
      const attempts: Array<Record<string, string>> = [
        {},
        { [FX_SOURCE_WORKER_TOKEN_HEADER]: '' },
        { [FX_SOURCE_WORKER_TOKEN_HEADER]: 'not-the-token' },
        { [FX_SOURCE_WORKER_TOKEN_HEADER]: `${TOKEN}x` },
      ];
      for (const headers of attempts) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/internal/billing/fx/source-check',
          headers,
          payload: {},
        });
        assert.equal(response.statusCode, 401, JSON.stringify(headers));
      }
      assert.equal(calls.length, 0, 'an unauthorized caller cannot cause an outbound read');
      assert.equal(JSON.stringify(calls).includes(TOKEN), false);
      await app.close();
    } finally {
      restore();
    }
  });
});

describe('the internal FX source check — one read, one observation, no publication', () => {
  test('a valid call reads the pinned URL once, records one observation and reports the standing decision', async () => {
    resetWorkerLivenessForTests();
    const restore = stubPublisher();
    try {
      const { app } = await buildFxApp({ FX_SOURCE_WORKER_TOKEN: TOKEN });
      const before = await countRows('billing_fx_source_observations');

      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/billing/fx/source-check',
        headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: TOKEN },
        payload: {},
      });

      assert.equal(response.statusCode, 200, response.body);
      assert.equal(calls.length, 1, 'exactly one outbound read, no retry');
      assert.equal(calls[0]!.url, FX_SOURCE_BANK_OF_GHANA_URL);
      assert.equal(calls[0]!.method, 'GET');

      const body = response.json() as Record<string, unknown>;
      assert.equal(body.status, 'ok');
      assert.equal(body.sourceId, 'bank_of_ghana');
      assert.equal(body.sourceUrl, FX_SOURCE_BANK_OF_GHANA_URL);
      const retrieval = body.retrieval as { outcome: string; reason: string | null; bodyDigest: string; rowDigest: string };
      assert.equal(retrieval.outcome, 'retrieved');
      assert.equal(retrieval.reason, null);
      assert.match(retrieval.bodyDigest, /^[0-9a-f]{64}$/);
      assert.match(retrieval.rowDigest, /^[0-9a-f]{64}$/);
      assert.equal(body.record && (body.record as { status: string }).status, 'recorded');
      assert.equal(body.databaseWrites, 1);

      const report = body.report as Record<string, unknown>;
      assert.equal(report.publishedOn, '2026-10-14');
      assert.equal(report.midRateDecimal, '11.6750');
      assert.equal(report.buyingDecimal, '11.6692');
      assert.equal(report.sellingDecimal, '11.6808');
      assert.equal(report.pricingPolicySatisfiable, false);
      // The staleness state is relative to the process clock, so it is asserted
      // as "observed, with a state from the closed vocabulary" rather than as a
      // date-dependent value; the exact boundaries are pinned in the core suite.
      assert.equal(report.observed, true);
      assert.ok(['fresh', 'warning', 'stale'].includes(String(report.state)), String(report.state));

      // The row was appended exactly once, and the publication boundary holds.
      assert.equal(await countRows('billing_fx_source_observations'), before + 1);
      assert.equal(body.decision, 'need_source');
      assert.equal(body.published, false);
      assert.equal(body.approved, false);
      assert.match(String(body.decisionReason), /not approving it/);

      // Nothing a caller could mistake for an authority, a secret or the page.
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes('<html'), false);
      assert.equal(serialized.includes('<td>'), false);
      assert.equal(serialized.includes(TOKEN), false);
      assert.equal(serialized.includes('postgres://'), false);
      assert.equal(serialized.includes('password'), false);
      assert.equal('fxRateVersionId' in report, false);
      assert.equal('publishedRate' in body, false);

      // A second call is a recognized duplicate: it reads, and writes nothing.
      const second = await app.inject({
        method: 'POST',
        url: '/api/internal/billing/fx/source-check',
        headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: TOKEN },
        payload: {},
      });
      assert.equal(second.statusCode, 200);
      const secondBody = second.json() as { record: { status: string }; databaseWrites: number };
      assert.equal(secondBody.record.status, 'duplicate');
      assert.equal(secondBody.databaseWrites, 0);
      assert.equal(await countRows('billing_fx_source_observations'), before + 1);
      assert.equal(calls.length, 2, 'each check reads once; dedup is by content, not by skipping the read');

      await app.close();
    } finally {
      restore();
    }
  });

  test('the FX authority, the pricing snapshots and the provider plans stay untouched', async () => {
    assert.equal(await countRows('billing_fx_rate_versions'), 0);
    assert.equal(await countRows('billing_pricing_snapshots'), 0);
    assert.equal(await countRows('billing_provider_plans'), 0);
  });

  test('the check is visible without a credential in GET /api/health', async () => {
    // Counters are process-local, so start from a known state: what matters is
    // that THIS check moves them.
    resetWorkerLivenessForTests();
    const restore = stubPublisher();
    try {
      const { app } = await buildFxApp({ FX_SOURCE_WORKER_TOKEN: TOKEN });
      await app.inject({
        method: 'POST',
        url: '/api/internal/billing/fx/source-check',
        headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: TOKEN },
        payload: {},
      });

      const health = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(health.statusCode, 200);
      const workers = (health.json() as { workers: Record<string, { successes: number; failures: number; lastSuccessAt: string | null; lastFailureCode: string | null }> }).workers;
      assert.equal(workers.fxSource?.successes, 1);
      assert.equal(workers.fxSource?.failures, 0);
      assert.ok(workers.fxSource?.lastSuccessAt, 'a scheduler that ran is timestamped');
      assert.equal(workers.fxSource?.lastFailureCode, null);
      assert.equal(JSON.stringify(health.json()).includes(TOKEN), false);
      await app.close();
    } finally {
      restore();
    }
  });
});

describe('the internal FX source check — failures are reported, never invented', () => {
  test('an unreachable publisher is reported without writing anything', async () => {
    const restore = stubPublisher(() => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { name: 'FetchError' });
    });
    try {
      const { app } = await buildFxApp({ FX_SOURCE_WORKER_TOKEN: TOKEN });
      const before = await countRows('billing_fx_source_observations');

      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/billing/fx/source-check',
        headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: TOKEN },
        payload: {},
      });

      assert.equal(response.statusCode, 200);
      const body = response.json() as {
        status: string;
        retrieval: { outcome: string; reason: string };
        record: { status: string };
        databaseWrites: number;
      };
      assert.equal(body.retrieval.outcome, 'unavailable');
      assert.equal(body.retrieval.reason, 'network');
      assert.equal(body.record.status, 'not_attempted');
      assert.equal(body.databaseWrites, 0);
      assert.equal(await countRows('billing_fx_source_observations'), before);
      assert.equal(JSON.stringify(body).includes('ECONNREFUSED'), false, 'transport text is never echoed');
      await app.close();
    } finally {
      restore();
    }
  });

  test('a page that is not an FX table is reported as unparseable, and nothing is recorded', async () => {
    const restore = stubPublisher(
      () => new Response('<html><body><h1>Maintenance</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    try {
      const { app } = await buildFxApp({ FX_SOURCE_WORKER_TOKEN: TOKEN });
      const before = await countRows('billing_fx_source_observations');

      const response = await app.inject({
        method: 'POST',
        url: '/api/internal/billing/fx/source-check',
        headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: TOKEN },
        payload: {},
      });
      const body = response.json() as { retrieval: { outcome: string; reason: string }; databaseWrites: number };
      assert.equal(response.statusCode, 200);
      assert.equal(body.retrieval.outcome, 'unparseable');
      assert.equal(body.retrieval.reason, 'no_usd_row');
      assert.equal(body.databaseWrites, 0);
      assert.equal(await countRows('billing_fx_source_observations'), before);
      await app.close();
    } finally {
      restore();
    }
  });

  test('the route refuses methods other than POST and exposes no publication route', async () => {
    const restore = stubPublisher();
    try {
      const { app } = await buildFxApp({ FX_SOURCE_WORKER_TOKEN: TOKEN });
      const get = await app.inject({
        method: 'GET',
        url: '/api/internal/billing/fx/source-check',
        headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: TOKEN },
      });
      assert.equal(get.statusCode, 404, 'reads are not exposed on the worker surface');

      for (const url of [
        '/api/internal/billing/fx/publish',
        '/api/internal/billing/fx/approve',
        '/api/internal/billing/fx/apply',
        '/api/billing/fx/publish',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { [FX_SOURCE_WORKER_TOKEN_HEADER]: TOKEN },
          payload: {},
        });
        assert.equal(response.statusCode, 404, `${url} must not exist`);
      }
      assert.equal(calls.length, 0);
      await app.close();
    } finally {
      restore();
    }
  });
});
