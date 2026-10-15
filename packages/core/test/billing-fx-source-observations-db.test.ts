/**
 * Billing FX **source observations** — against a real PostgreSQL.
 *
 * Pins the durable properties the feature rests on:
 *  - migration 0038 is the newest migration, is ADDITIVE (nothing existing is
 *    dropped, altered or rewritten) and creates the observation table with the
 *    dedup index, the coherence/URL/source CHECKs and the append-only trigger;
 *  - an observation is IMMUTABLE: `UPDATE` and `DELETE` are refused by the
 *    database (SQLSTATE 27000), so what a publisher published at a moment can
 *    always be explained later;
 *  - recording is DEDUPLICATED on the deterministic key, so a scheduler that
 *    runs too often inserts nothing;
 *  - the observation table has NO foreign key to the FX authority table, in
 *    either direction — an observation cannot become, reference or replace a
 *    rate version;
 *  - the check service serializes through the pinned advisory lock, so two
 *    concurrent checks cannot fetch or write twice, and a check that cannot take
 *    the lock does NOT fetch;
 *  - a failed or unrecognised retrieval writes NOTHING and is reported;
 *  - running the check leaves `billing_fx_rate_versions` (and the pricing
 *    snapshot / provider-plan tables) untouched and empty: no observation ever
 *    publishes a rate, bypasses the `need_source` approval boundary, or touches a
 *    price, a Paystack plan or a pricing epoch.
 *
 * No network is involved: the reader is injected, and the transport beneath it
 * is a stub.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import {
  BillingFxSourceObservationStore,
  FX_SOURCE_OBSERVATION_POLICY,
  FxSourceObservationService,
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  validateFxSourceRow,
  type FxSourceObservation,
  type FxSourceRetrieval,
  type FxSourceRetriever,
} from '../src/index.js';
import {
  FX_SOURCE_ADVISORY_LOCK_KEY,
  FX_SOURCE_BANK_OF_GHANA,
  FX_SOURCE_BANK_OF_GHANA_URL,
} from '@veltrixeye/contracts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR_PATH = path.join(REPO_ROOT, 'packages', 'core', 'src', 'db', 'migrations');
const DB_PORT = 5481;
const RETRIEVED_AT = new Date('2026-10-15T09:30:00.000Z');

let stopDb: () => Promise<void>;
let pool: pg.Pool;

before(async () => {
  const testDir = path.join(REPO_ROOT, '.test');
  mkdirSync(testDir, { recursive: true });
  const dataDir = mkdtempSync(path.join(testDir, 'fx-source-observations-'));
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: 'test',
    password: randomBytes(16).toString('hex'),
    database: 'veltrixeye_fx_source_observations',
  });
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  stopDb = async () => {
    await pool.end();
    await db.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
});

after(async () => {
  await stopDb();
});

/** A validated observation, produced through the real validation path. */
function observation(overrides: { publishedOn?: string; mid?: string; bodyDigest?: string } = {}): FxSourceObservation {
  const publishedOn = overrides.publishedOn ?? '14 Oct 2026';
  const mid = overrides.mid ?? '11.6750';
  const result = validateFxSourceRow(
    {
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
      retrievedAt: RETRIEVED_AT,
      bodyDigest: overrides.bodyDigest ?? 'a'.repeat(64),
      rowDigest: 'b'.repeat(64),
      row: {
        publishedOnText: publishedOn,
        currencyText: 'US Dollar',
        pairText: 'USDGHS',
        buyingText: '11.6692',
        sellingText: '11.6808',
        midText: mid,
      },
    },
    { retrievedBy: 'scheduler' },
  );
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  return result.observation!;
}

/** A stub reader: counts retrievals and returns whatever it is told to. */
function stubRetriever(result: () => Promise<FxSourceRetrieval>): FxSourceRetriever & { calls: number } {
  const stub = {
    sourceId: FX_SOURCE_BANK_OF_GHANA,
    sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
    calls: 0,
    async retrieve(): Promise<FxSourceRetrieval> {
      stub.calls += 1;
      return result();
    },
  };
  return stub;
}

const retrievedResult = (publishedOnText = '14 Oct 2026'): FxSourceRetrieval => ({
  outcome: 'retrieved',
  sourceId: FX_SOURCE_BANK_OF_GHANA,
  sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
  retrievedAt: RETRIEVED_AT,
  bodyDigest: 'c'.repeat(64),
  rowDigest: 'd'.repeat(64),
  row: {
    publishedOnText,
    currencyText: 'US Dollar',
    pairText: 'USDGHS',
    buyingText: '11.6692',
    sellingText: '11.6808',
    midText: '11.6750',
  },
});

const countRows = async (table: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number.parseInt(rows[0]!.count, 10);
};

describe('migration 0038 — additive, and the newest', () => {
  test('0038 is present, is the newest migration, and nothing is numbered after it', () => {
    const files = readdirSync(MIGRATIONS_DIR_PATH)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    assert.equal(files.length, 38, 'the observation migration is the only new migration');
    assert.equal(files.at(-1), '0038_billing_fx_source_observations.sql');
    assert.equal(files.filter((file) => file.startsWith('0038_')).length, 1);
    assert.equal(
      files.filter((file) => Number.parseInt(file.slice(0, 4), 10) > 38).length,
      0,
      'nothing is numbered after 0038',
    );
  });

  test('0038 is forward-only: it drops, alters and rewrites nothing existing', () => {
    const source = readFileSync(
      path.join(MIGRATIONS_DIR_PATH, '0038_billing_fx_source_observations.sql'),
      'utf8',
    );
    const sql = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--.*$/gm, '');
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|FUNCTION|TRIGGER)\b/i);
    assert.doesNotMatch(sql, /\bALTER\s+TABLE\b/i);
    assert.doesNotMatch(sql, /\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/i);
    assert.doesNotMatch(sql, /\bRENAME\b/i);
    // It creates exactly one table, and it is the observation table.
    const created = [...sql.matchAll(/CREATE TABLE\s+([a-z_]+)/gi)].map((match) => match[1]);
    assert.deepEqual(created, ['billing_fx_source_observations']);
    assert.match(sql, /billing_fx_source_observations_append_only/);
    assert.match(sql, /CREATE UNIQUE INDEX billing_fx_source_observations_key_uniq/);
  });

  test('the table exists with the approved URL, source vocabulary and coherence CHECKs', async () => {
    const { rows } = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'billing_fx_source_observations'::regclass AND contype = 'c'
        ORDER BY conname`,
    );
    const definitions = rows.map((row) => row.definition).join('\n');
    // PostgreSQL normalizes the definitions, so these are asserted in their
    // normalized form (a single-value IN is rewritten to `=`, for example).
    assert.ok(
      rows.some((row) => row.conname === 'billing_fx_source_observations_source_check'),
      'the approved publisher vocabulary is enforced by the database',
    );
    assert.match(definitions, /source_id = 'bank_of_ghana'::text/);
    assert.ok(
      definitions.includes(`source_url = '${FX_SOURCE_BANK_OF_GHANA_URL}'::text`),
      'the approved URL is pinned by the database',
    );
    assert.match(definitions, /buying_scaled <= mid_rate_scaled/);
    assert.match(definitions, /mid_rate_scaled <= selling_scaled/);
    assert.match(definitions, /rate_scale >= 1\) AND \(rate_scale <= 18/);
    assert.match(
      definitions,
      /retrieved_at >= \(\(published_on\)::timestamp without time zone AT TIME ZONE 'UTC'::text\)/,
      'the publication day is compared at UTC midnight, never in the session time zone',
    );
  });

  test('the observation table has no foreign key to the FX authority, in either direction', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_constraint
        WHERE contype = 'f'
          AND (conrelid = 'billing_fx_source_observations'::regclass
               OR confrelid = 'billing_fx_source_observations'::regclass)`,
    );
    assert.equal(rows[0]!.count, '0', 'observations and rate versions are structurally separate');

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('billing_fx_source_observations', 'billing_fx_rate_versions')`,
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.equal(names.includes('fx_rate_version_id'), false);
    assert.equal(names.includes('observation_id'), false);
  });
});

describe('observation rows — immutable and deduplicated', () => {
  test('a valid observation is recorded, and the same publication is a duplicate', async () => {
    const store = new BillingFxSourceObservationStore(pool);
    const first = await store.record(observation());
    assert.equal(first.status, 'recorded');
    assert.match(first.stored.id, /^[0-9a-f-]{36}$/);

    const again = await store.record(observation({ bodyDigest: 'e'.repeat(64) }));
    assert.equal(again.status, 'duplicate', 'a second read of the same publication inserts nothing');
    assert.equal(again.stored.id, first.stored.id);
    assert.equal(again.stored.observation.bodyDigest, first.stored.observation.bodyDigest);
    assert.equal(await store.count(FX_SOURCE_BANK_OF_GHANA), 1);
  });

  test('a corrected republication of the same date is a NEW row, and the history is preserved', async () => {
    const store = new BillingFxSourceObservationStore(pool);
    const before = await store.count(FX_SOURCE_BANK_OF_GHANA);
    const corrected = await store.record(observation({ mid: '11.6751' }));
    assert.equal(corrected.status, 'recorded');
    assert.equal(await store.count(FX_SOURCE_BANK_OF_GHANA), before + 1);
    const recent = await store.listRecent(FX_SOURCE_BANK_OF_GHANA, 5);
    assert.ok(recent.some((entry) => entry.observation.midRateDecimal === '11.6750'));
    assert.ok(recent.some((entry) => entry.observation.midRateDecimal === '11.6751'));
  });

  test('an observation is immutable: UPDATE and DELETE are refused by the database', async () => {
    const store = new BillingFxSourceObservationStore(pool);
    // A distinctly dated row (same figures, a different publication day), so the
    // immutable row's identity is unambiguous below.
    const stored = await store.record(observation({ publishedOn: '13 Oct 2026' }));
    assert.equal(stored.status, 'recorded');

    await assert.rejects(
      () => pool.query(`UPDATE billing_fx_source_observations SET mid_rate_decimal = '1.0' WHERE id = $1`, [stored.stored.id]),
      (error: { code?: string }) => {
        assert.equal(error.code, '27000', 'append-only: SQLSTATE 27000');
        return true;
      },
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM billing_fx_source_observations WHERE id = $1`, [stored.stored.id]),
      (error: { code?: string }) => {
        assert.equal(error.code, '27000');
        return true;
      },
    );
    const still = await pool.query(`SELECT mid_rate_decimal FROM billing_fx_source_observations WHERE id = $1`, [
      stored.stored.id,
    ]);
    assert.equal(still.rows[0]!.mid_rate_decimal, '11.6750');
  });

  test('the CHECKs refuse an unapproved URL, an unapproved publisher, an incoherent row and a credential label', async () => {
    const insert = (overrides: Record<string, unknown>) => {
      const columns = [
        'source_id',
        'observation_key',
        'base_currency',
        'quote_currency',
        'published_on',
        'buying_scaled',
        'selling_scaled',
        'mid_rate_scaled',
        'rate_scale',
        'buying_decimal',
        'selling_decimal',
        'mid_rate_decimal',
        'body_digest',
        'row_digest',
        'source_url',
        'retrieved_at',
        'retrieved_by',
      ];
      const values: Record<string, unknown> = {
        source_id: 'bank_of_ghana',
        observation_key: randomUUID().replace(/-/g, ''),
        base_currency: 'USD',
        quote_currency: 'GHS',
        published_on: '2026-10-12',
        buying_scaled: 1_166_920,
        selling_scaled: 1_168_080,
        mid_rate_scaled: 1_167_500,
        rate_scale: 4,
        buying_decimal: '11.6692',
        selling_decimal: '11.6808',
        mid_rate_decimal: '11.6750',
        body_digest: 'f'.repeat(64),
        row_digest: '0'.repeat(64),
        source_url: FX_SOURCE_BANK_OF_GHANA_URL,
        retrieved_at: '2026-10-12T17:00:00.000Z',
        retrieved_by: 'scheduler',
        ...overrides,
      };
      return pool.query(
        `INSERT INTO billing_fx_source_observations (${columns.join(', ')})
         VALUES (${columns.map((_column, index) => `$${index + 1}`).join(', ')})`,
        columns.map((column) => values[column]),
      );
    };

    await assert.rejects(() => insert({ source_id: 'reuters' }), /source_check|violates check constraint/);
    await assert.rejects(
      () => insert({ source_url: 'https://mirror.example.com/bog' }),
      /url_check|violates check constraint/,
    );
    await assert.rejects(() => insert({ mid_rate_scaled: 1_100_000 }), /coherence_check|violates check constraint/);
    await assert.rejects(() => insert({ retrieved_by: 'scheduler-token' }), /shape_check|violates check constraint/);
    await assert.rejects(
      () => insert({ published_on: '2026-10-14', retrieved_at: '2026-10-12T17:00:00.000Z' }),
      /retrieved_check|violates check constraint/,
    );
    await assert.rejects(() => insert({ body_digest: 'not-a-digest' }), /digest_check|violates check constraint/);
    // The refusal above wrote nothing.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM billing_fx_source_observations WHERE body_digest = $1`,
      ['f'.repeat(64)],
    );
    assert.equal(rows[0]!.count, '0');
  });

  test('latest() and listRecent() order by publication date, newest first, with a bounded limit', async () => {
    const store = new BillingFxSourceObservationStore(pool);
    const latest = await store.latest(FX_SOURCE_BANK_OF_GHANA);
    assert.equal(latest?.observation.publishedOn, '2026-10-14', 'the newest publication is 14 Oct 2026');

    const recent = await store.listRecent(FX_SOURCE_BANK_OF_GHANA, 3);
    assert.ok(recent.length <= 3);
    const dates = recent.map((entry) => entry.observation.publishedOn);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest publication first');

    const capped = await store.listRecent(FX_SOURCE_BANK_OF_GHANA, 500);
    assert.ok(capped.length <= 50, 'the report read is bounded, so history cannot grow a response');
  });
});

describe('the check service — overlap, reporting and the publication boundary', () => {
  test('an overlap is refused WITHOUT fetching, and reports the current state', async () => {
    const retriever = stubRetriever(async () => retrievedResult());
    const service = new FxSourceObservationService(pool, retriever);

    const blocker = await pool.connect();
    try {
      const locked = await blocker.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [FX_SOURCE_ADVISORY_LOCK_KEY],
      );
      assert.equal(locked.rows[0]!.acquired, true);

      const result = await service.runCheck({ asOf: RETRIEVED_AT });
      assert.equal(result.overlapSkipped, true);
      assert.equal(retriever.calls, 0, 'an overlapping check must not fetch');
      assert.equal(result.retrieval.outcome, 'not_attempted');
      assert.equal(result.databaseWrites, 0);
      assert.equal(result.record.status, 'not_attempted');
      // The report is still computed: skipping work must not hide staleness.
      assert.equal(result.report.state, 'fresh');
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [FX_SOURCE_ADVISORY_LOCK_KEY]);
      blocker.release();
    }
  });

  test('a check records one row, dedups on the next run, and publishes nothing', async () => {
    const before = await countRows('billing_fx_source_observations');
    const retriever = stubRetriever(async () => retrievedResult('12 Oct 2026'));
    const service = new FxSourceObservationService(pool, retriever);

    const first = await service.runCheck({ asOf: RETRIEVED_AT });
    assert.equal(first.overlapSkipped, false);
    assert.equal(first.retrieval.outcome, 'retrieved');
    assert.equal(first.validation?.valid, true);
    assert.equal(first.record.status, 'recorded');
    assert.equal(first.databaseWrites, 1);
    assert.equal(first.published, false);
    assert.equal(first.approved, false);
    assert.equal(first.decision, 'need_source');
    assert.notEqual(first.record.observationId, null);
    // The report describes the newest publication of the source, and its retained
    // count mirrors the store exactly.
    assert.equal(first.report.latest?.publishedOn, '2026-10-14');
    assert.equal(
      first.report.observationsRetained,
      await countRows('billing_fx_source_observations'),
    );

    const second = await service.runCheck({ asOf: RETRIEVED_AT });
    assert.equal(second.record.status, 'duplicate');
    assert.equal(second.databaseWrites, 0);
    assert.equal(await countRows('billing_fx_source_observations'), before + 1, 'exactly one row was appended');
    assert.equal(retriever.calls, 2, 'a duplicate still counts as a completed check');

    // THE BOUNDARY: the observation path touched no authority, no price and no
    // provider plan.
    assert.equal(await countRows('billing_fx_rate_versions'), 0);
    assert.equal(await countRows('billing_pricing_snapshots'), 0);
    assert.equal(await countRows('billing_provider_plans'), 0);
  });

  test('an unavailable publisher writes nothing and is reported as a failure', async () => {
    const before = await countRows('billing_fx_source_observations');
    const service = new FxSourceObservationService(
      pool,
      stubRetriever(async () => ({
        outcome: 'unavailable',
        sourceId: FX_SOURCE_BANK_OF_GHANA,
        sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
        retrievedAt: RETRIEVED_AT,
        status: 503,
        reason: 'http_status',
        detail: 'The source answered HTTP 503.',
        bodyDigest: null,
      })),
    );

    const result = await service.runCheck({ asOf: RETRIEVED_AT });
    assert.equal(result.retrieval.outcome, 'unavailable');
    assert.equal(result.retrieval.reason, 'http_status');
    assert.equal(result.record.status, 'not_attempted');
    assert.equal(result.databaseWrites, 0);
    assert.equal(await countRows('billing_fx_source_observations'), before, 'a broken source is not an observation');
    // …and it is visible: the report still describes the last KNOWN observation.
    assert.equal(result.report.state, 'fresh');
  });

  test('a row that does not validate writes nothing and names the reason', async () => {
    const before = await countRows('billing_fx_source_observations');
    const service = new FxSourceObservationService(
      pool,
      stubRetriever(async () => ({
        ...retrievedResult('12 Oct 2026'),
        row: {
          publishedOnText: '12 Oct 2026',
          currencyText: 'US Dollar',
          pairText: 'USDGHS',
          buyingText: '11.9000',
          sellingText: '11.6808',
          midText: '11.6750',
        },
      })),
    );

    const result = await service.runCheck({ asOf: RETRIEVED_AT });
    assert.equal(result.validation?.valid, false);
    assert.ok(result.validation?.issues.some((issue) => issue.code === 'incoherent'));
    assert.equal(result.record.status, 'not_attempted');
    assert.equal(await countRows('billing_fx_source_observations'), before);
  });

  test('a reader that throws is reported, never turned into a rate', async () => {
    const service = new FxSourceObservationService(
      pool,
      {
        sourceId: FX_SOURCE_BANK_OF_GHANA,
        sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
        async retrieve() {
          throw new Error('boom: postgres://user:pa55w0rd@host/db');
        },
      },
    );
    const result = await service.runCheck({ asOf: RETRIEVED_AT });
    assert.equal(result.retrieval.outcome, 'unavailable');
    assert.equal(result.retrieval.reason, 'network');
    assert.equal(result.record.status, 'not_attempted');
    assert.equal(JSON.stringify(result).includes('pa55w0rd'), false, 'no transport text is echoed');
    assert.equal(result.decision, 'need_source');
  });

  test('report() alone is read-only: it fetches nothing and writes nothing', async () => {
    const before = await countRows('billing_fx_source_observations');
    const retriever = stubRetriever(async () => retrievedResult());
    const service = new FxSourceObservationService(pool, retriever);

    const report = await service.report(new Date('2026-10-20T00:00:00.000Z'));
    assert.equal(retriever.calls, 0, 'a report opens no outbound call');
    assert.equal(await countRows('billing_fx_source_observations'), before);
    assert.equal(report.state, 'stale', 'four days past a 4-day bound is stale');
    assert.equal(report.pricingPolicySatisfiable, false);
    assert.equal(report.decision, 'need_source');
  });

  test('the policy pinned in code is the policy the report applies', async () => {
    const service = new FxSourceObservationService(pool, stubRetriever(async () => retrievedResult()));
    const report = await service.report(RETRIEVED_AT);
    assert.equal(report.warningAfterSeconds, FX_SOURCE_OBSERVATION_POLICY.warningAfterSeconds);
    assert.equal(report.staleAfterSeconds, FX_SOURCE_OBSERVATION_POLICY.staleAfterSeconds);
    assert.equal(report.limitations.length, 3);
  });
});
