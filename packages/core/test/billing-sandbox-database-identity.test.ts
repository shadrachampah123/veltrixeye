/**
 * Billing Step 4 remediation — the SANDBOX DATABASE IDENTITY GUARD, against
 * real PostgreSQL.
 *
 * Audit finding (CRITICAL): a loopback hostname proves nothing about which
 * database answers it — a `localhost` port-forward or SSH tunnel can reach a
 * production cluster. This suite proves the guard decides on the CONNECTED
 * database, not on the connection string.
 *
 * Two separate embedded clusters are booted for real:
 *   - `main`      — the sandbox. Marked with `veltrixeye:billing-sandbox:v1`.
 *   - `lookalike` — stands in for a production database reached through a
 *                   tunnel. Its own cluster, its own system identifier, and
 *                   (in the tunnel case) no sandbox marker.
 *
 * What this suite pins:
 *   A. SERVICE, pre-connection — a test-mode run without an explicit identity
 *      expectation, or with a malformed one, is refused before any connection.
 *   B. SERVICE, connected database — a tunnel to an UNMARKED database, a marked
 *      database from ANOTHER cluster, a wrong database name and a wrong cluster
 *      identifier are each refused, and the refused target is left unchanged.
 *   C. SERVICE, write path ordering — on the write transaction's own connection,
 *      the identity is read after BEGIN and before any business read or INSERT,
 *      and a failed identity rolls the transaction back.
 *   D. SERVICE, dry run — the identity is verified before the FX authority is read.
 *   E. CLI — a non-loopback (production-shaped) target is refused before any
 *      connection, for dry runs and for --apply; the identity flags are mandatory
 *      and strictly formatted; a tunnel and a mismatch exit 1 with nothing written.
 *
 * Nothing here touches a real production database or a real provider: both
 * clusters are throwaway embedded instances under the gitignored `.test/`.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
  BILLING_SANDBOX_DATABASE_MARKER,
  BillingFxRateVersionStore,
  BillingPlanProvisioningService,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  isBillingProvisioningError,
  providerIntervalForBillingInterval,
  type SandboxDatabaseIdentityExpectation,
} from '../src/index.js';
import {
  fxSourceApprovalFor,
  markSandboxDatabase,
  retireActiveEpochs,
  startBillingTestDb,
} from './helpers/billing-checkout.js';

// Unique per suite file (see the port ledger in helpers/billing-checkout.ts).
const MAIN_PORT = 5611;
const LOOKALIKE_PORT = 5612;
const OPERATOR = 'ops-sandbox-identity-01';
const REASON = 'register the four sandbox Paystack plan epochs for the Step 4 runbook';
const REFERENCE = 'paystack-dashboard-sandbox-plans-identity';
const FX_REFERENCE = 'ops-identity-fx-board-1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let main: Awaited<ReturnType<typeof startBillingTestDb>>;
let lookalike: Awaited<ReturnType<typeof startBillingTestDb>>;
/** The operator's authorized expectation for the MAIN sandbox. */
let MAIN_IDENT: SandboxDatabaseIdentityExpectation;

before(async () => {
  main = await startBillingTestDb(MAIN_PORT);
  lookalike = await startBillingTestDb(LOOKALIKE_PORT);
  MAIN_IDENT = await markSandboxDatabase(main.pool);
}, { timeout: 240_000 });

beforeEach(async () => {
  await retireActiveEpochs(main.pool);
  await retireActiveEpochs(lookalike.pool);
});

after(async () => {
  await main?.stop();
  await lookalike?.stop();
});

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

const REGISTERED_AT = new Date();
let fxTick = 0;

/** Publish an approved FX version into `target`, fresh at REGISTERED_AT. */
async function publishFx(target: Pool, rateScaled = 12_500_000n): Promise<string> {
  const tick = fxTick++;
  const capturedAt = new Date(REGISTERED_AT.getTime() - (60 + tick) * 1000);
  const version = await new BillingFxRateVersionStore(target).publish({
    fxRateScaled: rateScaled,
    fxRateScale: 6,
    effectiveFrom: capturedAt,
    capturedAt,
    source: 'ops',
    sourceReference: FX_REFERENCE,
    createdBy: OPERATOR,
    sourceApprovalId: await fxSourceApprovalFor(target, FX_REFERENCE),
  });
  return version.id;
}

function evidenceBatch(): Record<string, unknown>[] {
  const combos: ReadonlyArray<['pro' | 'elite', 'monthly' | 'annual']> = [
    ['pro', 'monthly'],
    ['pro', 'annual'],
    ['elite', 'monthly'],
    ['elite', 'annual'],
  ];
  return combos.map(([plan, interval]) => ({
    cataloguePlan: plan,
    interval,
    providerInterval: providerIntervalForBillingInterval(interval),
    providerPlanId: `PLN_${randomUUID().replaceAll('-', '')}`,
    paymentCurrency: 'GHS',
    paymentAmountMinor: computePaymentAmountMinor({
      usdMinor: BigInt(cataloguePriceMinor(plan, interval)),
      rateScaled: 12_500_000n,
      rateScale: 6,
    }).toString(),
    paymentAmountExponent: 2,
    mode: 'test',
    paymentCountCap: 'uncapped',
    evidenceReference: REFERENCE,
  }));
}

/** Counts on a database: every test-mode epoch row and every registration audit row. */
async function footprint(target: Pool) {
  const epochs = await target.query("SELECT count(*)::int AS n FROM billing_provider_plans WHERE mode = 'test'");
  const audits = await target.query(
    'SELECT count(*)::int AS n FROM audit_events WHERE action = $1',
    [BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION],
  );
  return { epochs: epochs.rows[0].n as number, audits: audits.rows[0].n as number };
}

/** The SQL a pool's transaction connections issue, in order (a pure observation). */
function recordingPool(real: Pool, log: string[]): Pool {
  return {
    connect: async () => {
      const client = await real.connect();
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (text: unknown, ...rest: unknown[]) => {
        const sql = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
        log.push(sql.replace(/\s+/g, ' ').trim());
        return original(text, ...rest);
      };
      return client;
    },
    query: real.query.bind(real),
  } as unknown as Pool;
}

/** A pool that must never be asked for a connection. */
const forbiddenPool = {
  connect: async () => {
    throw new Error('the identity refusal must happen before any connection');
  },
  query: async () => {
    throw new Error('the identity refusal must happen before any query');
  },
} as unknown as Pool;

async function refusalOf(promise: Promise<unknown>): Promise<{ reason: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isBillingProvisioningError(error)) return { reason: error.reason, message: error.message };
    throw error;
  }
  assert.fail('expected a typed provisioning refusal');
}

function identityRequest(extra: Record<string, unknown> = {}) {
  return { fxRateVersionId: randomUUID(), evidence: evidenceBatch(), databaseIdentity: MAIN_IDENT, ...extra };
}

/* ========================================================================== */
/* A. Pre-connection: an identity must be named and well formed               */
/* ========================================================================== */

describe('sandbox identity — pre-connection refusals (no connection is ever opened)', () => {
  test('a test-mode run without an explicit identity expectation is refused before any connection', async () => {
    const service = new BillingPlanProvisioningService({ db: forbiddenPool, mode: 'test' });
    const request = { fxRateVersionId: randomUUID(), evidence: evidenceBatch() };
    const write = await refusalOf(service.registerSandboxPlanEpochs(request));
    const dry = await refusalOf(service.validateSandboxPlanEpochs(request));
    assert.equal(write.reason, 'database_identity_unverified');
    assert.equal(dry.reason, 'database_identity_unverified');
    assert.match(write.message, /requires the explicit database identity expectation/);
  });

  test('a malformed identity expectation is refused as malformed input, before any connection', async () => {
    const service = new BillingPlanProvisioningService({ db: forbiddenPool, mode: 'test' });
    const malformed: ReadonlyArray<Record<string, unknown>> = [
      { databaseName: 'has space', systemIdentifier: '7000000000000000001' },
      { databaseName: 'veltrixeye_sandbox', systemIdentifier: 'not-digits' },
      { databaseName: '', systemIdentifier: '7000000000000000001' },
      { databaseName: 'veltrixeye_sandbox', systemIdentifier: '7000000000000000001', extra: true },
    ];
    for (const databaseIdentity of malformed) {
      const refusal = await refusalOf(service.registerSandboxPlanEpochs(identityRequest({ databaseIdentity })));
      assert.equal(refusal.reason, 'invalid_evidence', JSON.stringify(databaseIdentity));
    }
  });
});

/* ========================================================================== */
/* B. The CONNECTED database decides — tunnels, lookalikes and mismatches      */
/* ========================================================================== */

describe('sandbox identity — the connected database decides', () => {
  test('a localhost tunnel to an UNMARKED database is refused and nothing is written there', async () => {
    // The lookalike is reachable through the "tunnel" (its loopback URL) and
    // would otherwise happily accept writes: it carries no sandbox marker.
    const fxId = await publishFx(lookalike.pool);
    const before = await footprint(lookalike.pool);
    const service = new BillingPlanProvisioningService({ db: lookalike.pool, mode: 'test', now: () => REGISTERED_AT });

    const refusal = await refusalOf(service.registerSandboxPlanEpochs(identityRequest({ fxRateVersionId: fxId })));
    assert.equal(refusal.reason, 'database_identity_unverified');
    assert.match(refusal.message, /no sandbox marker/);
    assert.deepEqual(await footprint(lookalike.pool), before, 'the unmarked target is unchanged');
  });

  test('a database MARKED as sandbox in ANOTHER cluster is refused by its cluster identifier', async () => {
    // An operator marks the wrong cluster by mistake. The marker alone is not
    // enough: the pinned cluster system identifier must match as well.
    await lookalike.pool.query(
      `COMMENT ON DATABASE "billing_prc" IS '${BILLING_SANDBOX_DATABASE_MARKER}'`,
    );
    try {
      const fxId = await publishFx(lookalike.pool);
      const before = await footprint(lookalike.pool);
      const service = new BillingPlanProvisioningService({ db: lookalike.pool, mode: 'test', now: () => REGISTERED_AT });
      const refusal = await refusalOf(service.registerSandboxPlanEpochs(identityRequest({ fxRateVersionId: fxId })));
      assert.equal(refusal.reason, 'database_identity_mismatch');
      assert.match(refusal.message, /cluster identifier/);
      assert.deepEqual(await footprint(lookalike.pool), before, 'nothing was written to the other cluster');
    } finally {
      await lookalike.pool.query(`COMMENT ON DATABASE "billing_prc" IS NULL`);
    }
  });

  test('a marker that is not the sandbox marker is a mismatch, not a pass', async () => {
    await lookalike.pool.query(`COMMENT ON DATABASE "billing_prc" IS 'veltrixeye:billing-live:v1'`);
    try {
      const fxId = await publishFx(lookalike.pool);
      const service = new BillingPlanProvisioningService({ db: lookalike.pool, mode: 'test', now: () => REGISTERED_AT });
      const refusal = await refusalOf(service.registerSandboxPlanEpochs(identityRequest({ fxRateVersionId: fxId })));
      assert.equal(refusal.reason, 'database_identity_mismatch');
    } finally {
      await lookalike.pool.query(`COMMENT ON DATABASE "billing_prc" IS NULL`);
    }
  });

  test('the right marker and cluster, but a different authorized database NAME, is a mismatch', async () => {
    const fxId = await publishFx(main.pool);
    const before = await footprint(main.pool);
    const service = new BillingPlanProvisioningService({ db: main.pool, mode: 'test', now: () => REGISTERED_AT });
    const refusal = await refusalOf(
      service.registerSandboxPlanEpochs(identityRequest({
        fxRateVersionId: fxId,
        databaseIdentity: { databaseName: 'some_other_database', systemIdentifier: MAIN_IDENT.systemIdentifier },
      })),
    );
    assert.equal(refusal.reason, 'database_identity_mismatch');
    assert.match(refusal.message, /database name/);
    assert.deepEqual(await footprint(main.pool), before);
  });

  test('the right marker and name, but a different cluster identifier, is a mismatch', async () => {
    const fxId = await publishFx(main.pool);
    const before = await footprint(main.pool);
    const service = new BillingPlanProvisioningService({ db: main.pool, mode: 'test', now: () => REGISTERED_AT });
    const refusal = await refusalOf(
      service.registerSandboxPlanEpochs(identityRequest({
        fxRateVersionId: fxId,
        databaseIdentity: { databaseName: MAIN_IDENT.databaseName, systemIdentifier: '1' },
      })),
    );
    assert.equal(refusal.reason, 'database_identity_mismatch');
    assert.match(refusal.message, /cluster identifier/);
    assert.deepEqual(await footprint(main.pool), before);
  });

  test('a valid sandbox target passes: the dry run validates the batch and writes nothing', async () => {
    const fxId = await publishFx(main.pool);
    const before = await footprint(main.pool);
    const service = new BillingPlanProvisioningService({ db: main.pool, mode: 'test', now: () => REGISTERED_AT });
    const batch = await service.validateSandboxPlanEpochs(identityRequest({ fxRateVersionId: fxId }));
    assert.equal(batch.registrations.length, 4);
    assert.deepEqual(await footprint(main.pool), before, 'a dry run writes nothing');
  });

  test('a valid sandbox target passes the write path and registers the four epochs with their audit event', async () => {
    const fxId = await publishFx(main.pool);
    const before = await footprint(main.pool);
    const service = new BillingPlanProvisioningService({ db: main.pool, mode: 'test', now: () => REGISTERED_AT });
    const epochs = await service.registerSandboxPlanEpochs(identityRequest({
      fxRateVersionId: fxId,
      audit: { operatorId: OPERATOR, reason: REASON },
    }));
    assert.equal(epochs.length, 4);
    const after = await footprint(main.pool);
    assert.equal(after.epochs, before.epochs + 4);
    assert.equal(after.audits, before.audits + 1);
  });
});

/* ========================================================================== */
/* C. The write path checks identity INSIDE its transaction, before any INSERT */
/* ========================================================================== */

describe('sandbox identity — write-path ordering', () => {
  test('on the write transaction: BEGIN, then the identity read, then the FX read, then the INSERTs', async () => {
    const fxId = await publishFx(main.pool);
    const log: string[] = [];
    const service = new BillingPlanProvisioningService({
      db: recordingPool(main.pool, log),
      mode: 'test',
      now: () => REGISTERED_AT,
    });
    await service.registerSandboxPlanEpochs(identityRequest({
      fxRateVersionId: fxId,
      audit: { operatorId: OPERATOR, reason: REASON },
    }));
    const at = (pattern: RegExp) => log.findIndex((sql) => pattern.test(sql));
    const begin = at(/^BEGIN$/);
    const identity = at(/pg_control_system/);
    const fxRead = at(/FROM billing_fx_rate_versions/);
    const firstInsert = at(/^INSERT INTO billing_provider_plans/);
    assert.ok(begin >= 0 && identity > begin, 'the identity is read inside the transaction');
    assert.ok(fxRead > identity, 'the FX authority is read only after the identity is proven');
    assert.ok(firstInsert > identity, 'no epoch is inserted before the identity is proven');
    assert.ok(at(/^COMMIT$/) > firstInsert);
  });

  test('a failed identity on the write path rolls the transaction back and inserts nothing', async () => {
    const fxId = await publishFx(main.pool);
    const before = await footprint(main.pool);
    const log: string[] = [];
    const service = new BillingPlanProvisioningService({
      db: recordingPool(main.pool, log),
      mode: 'test',
      now: () => REGISTERED_AT,
    });
    const refusal = await refusalOf(service.registerSandboxPlanEpochs(identityRequest({
      fxRateVersionId: fxId,
      databaseIdentity: { databaseName: MAIN_IDENT.databaseName, systemIdentifier: '2' },
      audit: { operatorId: OPERATOR, reason: REASON },
    })));
    assert.equal(refusal.reason, 'database_identity_mismatch');
    assert.ok(log.some((sql) => sql === 'ROLLBACK'), 'the transaction was rolled back');
    assert.ok(!log.some((sql) => /^INSERT INTO billing_provider_plans/.test(sql)), 'no INSERT was issued');
    assert.ok(!log.some((sql) => /^COMMIT$/.test(sql)), 'nothing was committed');
    assert.deepEqual(await footprint(main.pool), before);
  });

  test('the dry run reads the identity before the FX authority', async () => {
    const fxId = await publishFx(main.pool);
    const log: string[] = [];
    const service = new BillingPlanProvisioningService({
      db: recordingPool(main.pool, log),
      mode: 'test',
      now: () => REGISTERED_AT,
    });
    await service.validateSandboxPlanEpochs(identityRequest({ fxRateVersionId: fxId }));
    const identity = log.findIndex((sql) => /pg_control_system/.test(sql));
    const fxRead = log.findIndex((sql) => /FROM billing_fx_rate_versions/.test(sql));
    assert.ok(identity >= 0 && fxRead > identity, 'identity first, then the FX read');
    assert.ok(!log.some((sql) => /^(BEGIN|INSERT|UPDATE|DELETE)/.test(sql)), 'the dry run opens no write');
  });
});

/* ========================================================================== */
/* E. The CLI: production-shaped targets, mandatory flags, tunnels, mismatches */
/* ========================================================================== */

function cli(env: Record<string, string | null>, args: readonly string[]) {
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete childEnv[key];
    else childEnv[key] = value;
  }
  return spawnSync('node', ['--import', 'tsx', 'scripts/billing/provision-sandbox.ts', ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function cliArgs(extra: string[] = [], identity: { db?: string; sid?: string } | 'none' = {}): string[] {
  const base = [
    '--fx-rate-version', randomUUID(),
    '--by', OPERATOR,
    '--reason', REASON,
    '--evidence', JSON.stringify(evidenceBatch()),
  ];
  if (identity === 'none') return [...base, ...extra];
  return [
    ...base,
    '--expect-database', identity.db ?? MAIN_IDENT.databaseName,
    '--expect-system-identifier', identity.sid ?? MAIN_IDENT.systemIdentifier,
    ...extra,
  ];
}

describe('sandbox identity — CLI boundary', () => {
  test('a production-shaped (non-loopback) target is refused before any connection, for dry runs and --apply', () => {
    const target = 'postgres://veltrix:fake-credential@dpg-prod-shaped.render.com/veltrixeye';
    for (const extra of [[], ['--apply']]) {
      const result = cli({ PAYSTACK_MODE: 'test', DATABASE_URL: target }, cliArgs(extra));
      assert.equal(result.status, 2, `${extra.join(' ') || 'dry run'} is refused: ${result.stderr}`);
      assert.match(result.stderr, /refuses this database target/);
      assert.match(result.stderr, /production or unverified/);
      assert.ok(!result.stderr.includes('render.com'), 'no hostname echoed');
      assert.ok(!result.stderr.includes('fake-credential'), 'no credential echoed');
      assert.ok(!result.stdout.includes('"outcome"'), 'no outcome was produced');
    }
  });

  test('the identity flags are mandatory for every run, dry or applied', () => {
    const loopback = { PAYSTACK_MODE: 'test', DATABASE_URL: main.dbUrl };
    for (const [label, args] of [
      ['neither flag', cliArgs([], 'none')],
      ['only --expect-database', cliArgs(['--expect-database', MAIN_IDENT.databaseName], 'none')],
      ['only --expect-system-identifier', cliArgs(['--expect-system-identifier', MAIN_IDENT.systemIdentifier], 'none')],
    ] as const) {
      for (const extra of [[], ['--apply']]) {
        const result = cli(loopback, [...args, ...extra]);
        assert.equal(result.status, 2, `${label} is a usage error: ${result.stderr}`);
        assert.match(result.stderr, /--expect-database and --expect-system-identifier are both required/, label);
      }
    }
  });

  test('malformed identity values are usage errors, before any connection', () => {
    const loopback = { PAYSTACK_MODE: 'test', DATABASE_URL: main.dbUrl };
    for (const identity of [
      { db: 'has space', sid: MAIN_IDENT.systemIdentifier },
      { db: 'x;DROP', sid: MAIN_IDENT.systemIdentifier },
      { db: MAIN_IDENT.databaseName, sid: '12ab' },
      { db: MAIN_IDENT.databaseName, sid: '1'.repeat(21) },
      { db: MAIN_IDENT.databaseName, sid: '-1' },
    ]) {
      const result = cli(loopback, cliArgs([], identity));
      assert.equal(result.status, 2, JSON.stringify(identity));
      assert.match(result.stderr, /must be a plain database name/, JSON.stringify(identity));
    }
  });

  test('a localhost tunnel to an unmarked database exits 1 with nothing written, for dry runs and --apply', async () => {
    const fxId = await publishFx(lookalike.pool);
    const before = await footprint(lookalike.pool);
    for (const extra of [[], ['--apply']]) {
      const args = cliArgs(extra);
      // Use this run's FX id (the one published on the lookalike).
      args[1] = fxId;
      const result = cli(
        { PAYSTACK_MODE: 'test', DATABASE_URL: lookalike.dbUrl },
        args,
      );
      assert.equal(result.status, 1, `${extra.join(' ') || 'dry run'} is refused on the tunnel: ${result.stderr}`);
      assert.match(result.stderr, /refused \(database_identity_unverified\)/);
      assert.match(result.stderr, /Nothing was written/);
    }
    assert.deepEqual(await footprint(lookalike.pool), before, 'the tunnel target is unchanged');
  });

  test('a valid marked sandbox target through the same CLI path exits 0 on a dry run', async () => {
    const fxId = await publishFx(main.pool);
    const args = cliArgs();
    args[1] = fxId;
    const result = cli(
      { PAYSTACK_MODE: 'test', DATABASE_URL: main.dbUrl },
      args,
    );
    assert.equal(result.status, 0, `the sandbox target validates: ${result.stderr}`);
    assert.match(result.stdout, /"outcome": "dry_run"/);
  });
});
