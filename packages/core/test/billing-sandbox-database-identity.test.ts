/**
 * Billing Step 4 remediation — the DATABASE IDENTITY ALLOWLIST, against real
 * PostgreSQL (PR #150 review, finding H1 and M1; PR #151).
 *
 * The review found that the sandbox identity guard trusted a database COMMENT
 * (`veltrixeye:billing-sandbox:v1`) that anyone with ownership could set, and
 * that a loopback hostname proves nothing about which database answers it. The
 * remediation decides identity from a reviewed allowlist that is pinned by
 * SHA-256 and kept outside the protected database, then verifies the CONNECTED
 * database (name AND cluster system identifier) on the write connection.
 *
 * Two embedded clusters are booted for real:
 *   - `main`      — the approved embedded test sandbox. It carries NO comment
 *                   and NO marker: it is approved by the allowlist alone.
 *   - `lookalike` — a second cluster with the SAME database name and its own
 *                   system identifier, standing in for a non-approved database
 *                   reached through a localhost tunnel.
 *
 * Nothing here touches a production database or a real provider. The committed
 * allowlist is empty by design; the in-process cases inject a test allowlist
 * that names only the embedded clusters, and the CLI cases prove that the real,
 * empty committed allowlist refuses every target.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Pool } from 'pg';
import {
  BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
  BillingPlanProvisioningService,
  BillingLivePlanRegistrationService,
  DATABASE_IDENTITY_ALLOWLIST_RELATIVE_PATH,
  DATABASE_IDENTITY_ALLOWLIST_SHA256,
  LIVE_PLAN_CODE_KEYS,
  DatabaseIdentityError,
  createPool,
  isBillingLivePlanRegistrationError,
  isBillingProvisioningError,
  loadDatabaseIdentityAllowlist,
  parseDatabaseIdentityAllowlist,
  providerIntervalForBillingInterval,
  resolveDatabaseTarget,
  cataloguePriceMinor,
  computePaymentAmountMinor,
} from '../src/index.js';
import {
  approveSandboxDatabase,
  createFxPrincipals,
  PRODUCTION_TEST_TARGET_ID,
  publishApprovedFx,
  SANDBOX_TEST_TARGET_ID,
  startBillingTestDb,
  type FxPrincipals,
  type SandboxTestIdentity,
} from './helpers/billing-checkout.js';

// Unique per suite file (see the port ledger in helpers/billing-checkout.ts).
const MAIN_PORT = 5611;
const LOOKALIKE_PORT = 5612;
const OPERATOR = 'ops-identity-allowlist-01';
const REASON = 'register the four sandbox Paystack plan epochs for the Step 4 runbook';
const REFERENCE = 'paystack-dashboard-identity-allowlist';
const FX_REFERENCE = 'ops-identity-fx-board-1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

let main: Awaited<ReturnType<typeof startBillingTestDb>>;
let lookalike: Awaited<ReturnType<typeof startBillingTestDb>>;
let FX: FxPrincipals;
/** The approved embedded sandbox (allowlist + selector). */
let SANDBOX: SandboxTestIdentity;
/** The same embedded database approved as a PRODUCTION target (live-path cases). */
let PRODUCTION: SandboxTestIdentity;

before(async () => {
  main = await startBillingTestDb(MAIN_PORT);
  lookalike = await startBillingTestDb(LOOKALIKE_PORT);
  FX = await createFxPrincipals(main.pool, main.dbUrl);
  SANDBOX = await approveSandboxDatabase(main.pool);
  PRODUCTION = await approveSandboxDatabase(main.pool, PRODUCTION_TEST_TARGET_ID, 'production');
}, { timeout: 240_000 });

beforeEach(async () => {
  await main.pool.query("UPDATE billing_provider_plans SET status='retired', retired_at=now(), retired_reason='next test' WHERE status='active'");
});

after(async () => {
  await FX?.close();
  await main?.stop();
  await lookalike?.stop();
});

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const REGISTERED_AT = new Date();
let fxTick = 0;

/** Publish an approved FX version into `pool`, fresh at REGISTERED_AT. */
async function publishFx(rateScaled = 12_500_000n): Promise<string> {
  const tick = fxTick++;
  const capturedAt = new Date(REGISTERED_AT.getTime() - (60 + tick) * 1000);
  const version = await publishApprovedFx(FX, {
    fxRateScaled: rateScaled,
    fxRateScale: 6,
    effectiveFrom: capturedAt,
    capturedAt,
    source: 'ops',
    sourceReference: FX_REFERENCE,
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

function planCodes(): Record<string, string> {
  return Object.fromEntries(LIVE_PLAN_CODE_KEYS.map((key) => [key, `PLN_${randomUUID().replaceAll('-', '')}`]));
}

/** Counts on a database: every test-mode epoch row and every registration audit row. */
async function footprint(target: Pool) {
  const epochs = await target.query("SELECT count(*)::int AS n FROM billing_provider_plans WHERE mode = 'test'");
  const audits = await target.query('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [
    BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
  ]);
  return { epochs: epochs.rows[0].n as number, audits: audits.rows[0].n as number };
}

/** The SQL a pool's connections issue, in order (a pure observation). */
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

/** A pool that must never be asked for a connection or a query. */
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
    if (isBillingLivePlanRegistrationError(error)) return { reason: error.reason, message: error.message };
    throw error;
  }
  assert.fail('expected a typed refusal');
}

/** A test allowlist: the given entries, parsed by the real parser. */
function allowlistOf(entries: unknown[]) {
  return parseDatabaseIdentityAllowlist({ schemaVersion: 1, entries });
}

function sandboxRequest(extra: Record<string, unknown> = {}) {
  return {
    fxRateVersionId: randomUUID(),
    evidence: evidenceBatch(),
    databaseTarget: SANDBOX.target,
    audit: { operatorId: OPERATOR, reason: REASON },
    ...extra,
  };
}

function sandboxService(db: Pool, allowlist = SANDBOX.allowlist) {
  return new BillingPlanProvisioningService({ db, mode: 'test', now: () => REGISTERED_AT, identityAllowlist: allowlist });
}

/** The embedded lookalike's own database name, read on its own cluster (never on main). */
async function lookalikeDatabaseName(): Promise<string> {
  const { rows } = await lookalike.pool.query('SELECT current_database() AS name');
  return rows[0].name as string;
}

/* ========================================================================== */
/* A. Pre-connection: no identity, no target, no connection                    */
/* ========================================================================== */

describe('H1 — pre-connection refusals (the forbidden pool is never touched)', () => {
  test('no reviewed allowlist supplied → refused before any connection', async () => {
    const service = new BillingPlanProvisioningService({ db: forbiddenPool, mode: 'test' });
    const write = await refusalOf(service.registerSandboxPlanEpochs(sandboxRequest()));
    const dry = await refusalOf(service.validateSandboxPlanEpochs(sandboxRequest()));
    assert.equal(write.reason, 'database_identity_unverified');
    assert.equal(dry.reason, 'database_identity_unverified');
    assert.match(write.message, /allowlist/);
  });

  test('a run that selects no allowlist entry is refused before any connection', async () => {
    const service = sandboxService(forbiddenPool);
    const request = { fxRateVersionId: randomUUID(), evidence: evidenceBatch() };
    assert.equal((await refusalOf(service.registerSandboxPlanEpochs(request))).reason, 'database_identity_unverified');
  });

  test('an id that is not in the reviewed allowlist is refused (nothing is connected)', async () => {
    const service = sandboxService(forbiddenPool);
    const refusal = await refusalOf(
      service.registerSandboxPlanEpochs(sandboxRequest({ databaseTarget: { targetId: 'not-approved' } })),
    );
    assert.equal(refusal.reason, 'database_identity_unverified');
    assert.match(refusal.message, /not in the reviewed/);
  });

  test('a SANDBOX entry cannot authorize a LIVE write (sandbox-to-live crossover)', async () => {
    const live = new BillingPlanProvisioningService({ db: forbiddenPool, mode: 'live', identityAllowlist: SANDBOX.allowlist });
    const refusal = await refusalOf(live.registerSandboxPlanEpochs(sandboxRequest()));
    assert.equal(refusal.reason, 'database_identity_unverified');
    assert.match(refusal.message, /sandbox entry/);
  });

  test('a PRODUCTION entry cannot authorize a sandbox write', async () => {
    const test = new BillingPlanProvisioningService({ db: forbiddenPool, mode: 'test', identityAllowlist: PRODUCTION.allowlist });
    const refusal = await refusalOf(test.registerSandboxPlanEpochs(sandboxRequest({ databaseTarget: PRODUCTION.target })));
    assert.equal(refusal.reason, 'database_identity_unverified');
    assert.match(refusal.message, /production entry/);
  });

  test('runtime-supplied name and system identifier are NOT an authority (legacy shape refused)', async () => {
    const service = sandboxService(forbiddenPool);
    const legacy = await refusalOf(
      service.registerSandboxPlanEpochs({
        fxRateVersionId: randomUUID(),
        evidence: evidenceBatch(),
        databaseIdentity: { databaseName: SANDBOX.databaseName, systemIdentifier: SANDBOX.systemIdentifier },
      }),
    );
    assert.equal(legacy.reason, 'invalid_evidence');
    const smuggled = await refusalOf(
      service.registerSandboxPlanEpochs(sandboxRequest({ databaseTarget: { targetId: SANDBOX_TEST_TARGET_ID, databaseName: SANDBOX.databaseName } })),
    );
    assert.equal(smuggled.reason, 'invalid_evidence', 'a name smuggled beside the id is an unknown key');
  });

  test('a malformed selector is refused as invalid input', async () => {
    const service = sandboxService(forbiddenPool);
    for (const targetId of ['Embedded Test', '../etc', '', 'UPPER']) {
      const refusal = await refusalOf(service.registerSandboxPlanEpochs(sandboxRequest({ databaseTarget: { targetId } })));
      assert.equal(refusal.reason, 'invalid_evidence', JSON.stringify(targetId));
    }
  });

  test('a production run without its typed confirmation is refused before any connection', async () => {
    const live = new BillingPlanProvisioningService({ db: forbiddenPool, mode: 'live', identityAllowlist: PRODUCTION.allowlist });
    const refusal = await refusalOf(live.registerSandboxPlanEpochs(sandboxRequest({ databaseTarget: PRODUCTION.target })));
    assert.equal(refusal.reason, 'database_identity_unverified');
    assert.match(refusal.message, /confirmation/);
  });
});

/* ========================================================================== */
/* B. Connected: the database the write actually reaches                       */
/* ========================================================================== */

describe('H1 — the CONNECTED database is verified on the write connection', () => {
  test('an approved sandbox with NO comment and NO marker is handled per policy: it registers', async () => {
    const { rows } = await main.pool.query('SELECT shobj_description(d.oid, \'pg_database\') AS comment FROM pg_database d WHERE d.datname = current_database()');
    assert.equal(rows[0].comment, null, 'the approved database carries no comment at all');
    const before = await footprint(main.pool);
    const fx = await publishFx();
    const registered = await sandboxService(main.pool).registerSandboxPlanEpochs(sandboxRequest({ fxRateVersionId: fx }));
    assert.equal(registered.length, 4);
    for (const epoch of registered) assert.equal(epoch.mode, 'test');
    const after = await footprint(main.pool);
    assert.equal(after.epochs - before.epochs, 4);
    assert.equal(after.audits - before.audits, 1);
  });

  test('a database COMMENT cannot approve anything: a marked database that is not allowlisted is refused', async () => {
    await lookalike.pool.query(`COMMENT ON DATABASE "${await lookalikeDatabaseName()}" IS 'veltrixeye:billing-sandbox:v1'`);
    const empty = allowlistOf([]);
    const refusal = await refusalOf(
      sandboxService(lookalike.pool, empty).registerSandboxPlanEpochs(sandboxRequest()),
    );
    assert.equal(refusal.reason, 'database_identity_unverified');
    assert.match(refusal.message, /not in the reviewed/);
    assert.deepEqual(await footprint(lookalike.pool), { epochs: 0, audits: 0 });
  });

  test('a marked lookalike with the SAME name but another cluster identifier is refused (wrong sysid)', async () => {
    const before = await footprint(lookalike.pool);
    const refusal = await refusalOf(
      sandboxService(lookalike.pool).registerSandboxPlanEpochs(sandboxRequest()),
    );
    assert.equal(refusal.reason, 'database_identity_mismatch');
    assert.match(refusal.message, /CLUSTER IDENTIFIER/);
    assert.deepEqual(await footprint(lookalike.pool), before);
  });

  test('wrong database NAME on the same cluster is refused', async () => {
    const otherName = `billing_other_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const mainBefore = await footprint(main.pool);
    await main.pool.query(`CREATE DATABASE "${otherName}"`);
    const url = new URL(main.dbUrl);
    url.pathname = `/${otherName}`;
    const otherPool = createPool({ databaseUrl: url.toString() });
    try {
      const refusal = await refusalOf(sandboxService(otherPool).validateSandboxPlanEpochs(sandboxRequest()));
      assert.equal(refusal.reason, 'database_identity_mismatch');
      assert.match(refusal.message, /NAME/);
    } finally {
      await otherPool.end();
    }
    assert.deepEqual(await footprint(main.pool), mainBefore, 'the approved database is untouched');
  });

  test('a localhost tunnel to a NON-approved database is refused on the connected identity', async () => {
    const before = await footprint(lookalike.pool);
    const refusal = await refusalOf(
      sandboxService(lookalike.pool, SANDBOX.allowlist).validateSandboxPlanEpochs(sandboxRequest()),
    );
    assert.equal(refusal.reason, 'database_identity_mismatch');
    assert.deepEqual(await footprint(lookalike.pool), before);
  });

  test('an identity that cannot be read is never assumed to match (empty catalogue row)', async () => {
    const emptyRead = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
      query: async () => ({ rows: [] }),
    } as unknown as Pool;
    const refusal = await refusalOf(sandboxService(emptyRead).validateSandboxPlanEpochs(sandboxRequest()));
    assert.equal(refusal.reason, 'database_identity_unverified');
    assert.match(refusal.message, /could not be read/);
  });

  test('an identity query that throws is refused as unverified, never as a pass', async () => {
    const throwing = {
      connect: async () => ({
        query: async () => {
          throw new Error('simulated catalogue failure');
        },
        release: () => undefined,
      }),
      query: async () => {
        throw new Error('simulated catalogue failure');
      },
    } as unknown as Pool;
    assert.equal((await refusalOf(sandboxService(throwing).validateSandboxPlanEpochs(sandboxRequest()))).reason, 'database_identity_unverified');
  });

  test('dry run: the identity is verified BEFORE the FX authority is read', async () => {
    const log: string[] = [];
    const fx = await publishFx();
    const batch = await sandboxService(recordingPool(main.pool, log)).validateSandboxPlanEpochs(sandboxRequest({ fxRateVersionId: fx }));
    assert.equal(batch.registrations.length, 4);
    const identityAt = log.findIndex((sql) => sql.includes('current_database'));
    const fxAt = log.findIndex((sql) => sql.includes('billing_fx_rate_versions'));
    assert.ok(identityAt >= 0, 'the identity was read');
    assert.ok(fxAt > identityAt, 'the FX row was read only after the identity was proven');
  });

  test('write path: the identity is read inside the transaction, after BEGIN and before the first INSERT', async () => {
    const log: string[] = [];
    const fx = await publishFx();
    await sandboxService(recordingPool(main.pool, log)).registerSandboxPlanEpochs(sandboxRequest({ fxRateVersionId: fx }));
    const begin = log.findIndex((sql) => sql === 'BEGIN');
    const identityAt = log.findIndex((sql) => sql.includes('current_database'));
    const insertAt = log.findIndex((sql) => sql.startsWith('INSERT INTO billing_provider_plans'));
    assert.ok(begin >= 0 && identityAt > begin, 'identity read after BEGIN');
    assert.ok(insertAt > identityAt, 'the first INSERT follows the identity check');
  });
});

/* ========================================================================== */
/* C. The allowlist file, its pin and its parser — all fail closed             */
/* ========================================================================== */

describe('H1 — the allowlist is loaded, pinned and parsed fail-closed', () => {
  const committed = path.join(REPO_ROOT, DATABASE_IDENTITY_ALLOWLIST_RELATIVE_PATH);
  let scratch: string;
  before(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'identity-allowlist-'));
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  function writeAllowlist(name: string, text: string): { file: string; sha: string } {
    const file = path.join(scratch, name);
    writeFileSync(file, text, 'utf8');
    return { file, sha: createHash('sha256').update(text).digest('hex') };
  }

  test('the committed allowlist loads, matches its pin, and approves NOTHING', () => {
    const allowlist = loadDatabaseIdentityAllowlist(committed);
    assert.equal(allowlist.entries.length, 0, 'the committed allowlist is empty by design');
    assert.equal(
      createHash('sha256').update(readFileSync(committed)).digest('hex'),
      DATABASE_IDENTITY_ALLOWLIST_SHA256,
    );
  });

  test('a missing allowlist file is refused (allowlist_missing)', () => {
    assert.throws(
      () => loadDatabaseIdentityAllowlist(path.join(scratch, 'does-not-exist.json')),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'allowlist_missing',
    );
  });

  test('an edited allowlist that no longer matches the pinned digest is refused (allowlist_pin_mismatch)', () => {
    const edited = writeAllowlist('edited.json', JSON.stringify({ schemaVersion: 1, entries: [
      { id: 'self-approved', environment: 'sandbox', databaseName: 'billing_prc', systemIdentifier: '1' },
    ] }));
    assert.throws(
      () => loadDatabaseIdentityAllowlist(edited.file),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'allowlist_pin_mismatch',
    );
  });

  test('malformed JSON, under its own matching digest, is refused (allowlist_malformed)', () => {
    const bad = writeAllowlist('bad.json', '{ not json');
    assert.throws(
      () => loadDatabaseIdentityAllowlist(bad.file, bad.sha),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'allowlist_malformed',
    );
  });

  test('the parser refuses every malformed shape, one at a time', () => {
    const good = { id: 'embedded-a', environment: 'sandbox', databaseName: 'billing_prc', systemIdentifier: '7706660598224461137' };
    const cases: Array<[string, unknown]> = [
      ['wrong schemaVersion', { schemaVersion: 2, entries: [] }],
      ['unknown top-level key', { schemaVersion: 1, entries: [], approvedBy: 'me' }],
      ['unknown entry key', { schemaVersion: 1, entries: [{ ...good, marker: 'veltrixeye:billing-sandbox:v1' }] }],
      ['non-digit system identifier', { schemaVersion: 1, entries: [{ ...good, systemIdentifier: '12a' }] }],
      ['system identifier too long', { schemaVersion: 1, entries: [{ ...good, systemIdentifier: '1'.repeat(20) }] }],
      ['environment outside the enum', { schemaVersion: 1, entries: [{ ...good, environment: 'staging' }] }],
      ['database name with a space', { schemaVersion: 1, entries: [{ ...good, databaseName: 'bad name' }] }],
      ['duplicate id', { schemaVersion: 1, entries: [good, { ...good, databaseName: 'other' }] }],
      ['same identity repeated', { schemaVersion: 1, entries: [good, { ...good, id: 'embedded-b' }] }],
      [
        'same identity under BOTH environments',
        { schemaVersion: 1, entries: [good, { ...good, id: 'embedded-prod', environment: 'production' }] },
      ],
      ['more than twenty entries', { schemaVersion: 1, entries: Array.from({ length: 21 }, (_, i) => ({ ...good, id: `embedded-${i}`, databaseName: `db_${i}` })) }],
    ];
    for (const [label, raw] of cases) {
      assert.throws(
        () => parseDatabaseIdentityAllowlist(raw),
        (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'allowlist_malformed',
        label,
      );
    }
    assert.equal(parseDatabaseIdentityAllowlist({ schemaVersion: 1, entries: [good] }).entries.length, 1);
  });

  test('target resolution: a production target needs its typed confirmation, repeated exactly', () => {
    const allowlist = allowlistOf([
      { id: 'prod-a', environment: 'production', databaseName: 'billing_prc', systemIdentifier: '5' },
    ]);
    assert.throws(
      () => resolveDatabaseTarget(allowlist, 'production', 'prod-a'),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'confirmation_missing',
    );
    assert.throws(
      () => resolveDatabaseTarget(allowlist, 'production', 'prod-a', 'prod-b'),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'confirmation_missing',
    );
    assert.equal(resolveDatabaseTarget(allowlist, 'production', 'prod-a', 'prod-a').systemIdentifier, '5');
  });

  test('target resolution: an environment crossover is refused in both directions', () => {
    const allowlist = allowlistOf([
      { id: 'sandbox-a', environment: 'sandbox', databaseName: 'billing_prc', systemIdentifier: '6' },
      { id: 'prod-a', environment: 'production', databaseName: 'billing_prod', systemIdentifier: '7' },
    ]);
    assert.throws(
      () => resolveDatabaseTarget(allowlist, 'production', 'sandbox-a', 'sandbox-a'),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'environment_mismatch',
    );
    assert.throws(
      () => resolveDatabaseTarget(allowlist, 'sandbox', 'prod-a'),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'environment_mismatch',
    );
  });

  test('the identity source never consults a database comment or a marker', () => {
    const sources = [
      'packages/core/src/billing/database-identity.ts',
      'packages/core/src/billing/provisioning.ts',
      'packages/core/src/billing/live-plan-registration.ts',
      'scripts/billing/provision-sandbox.ts',
      'scripts/billing/provision-live.ts',
    ];
    for (const relative of sources) {
      const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      assert.equal(text.includes('veltrixeye:billing-sandbox'), false, `${relative} has no marker string`);
      assert.equal(/shobj_description/.test(text), false, `${relative} reads no database comment`);
    }
  });
});

/* ========================================================================== */
/* D. M1 — the production (live) path, with its own policy                     */
/* ========================================================================== */

describe('M1 — the live path verifies a PRODUCTION target, never a sandbox one', () => {
  test('a live registration naming a production entry on the WRONG cluster is refused (dry run reads nothing)', async () => {
    const live = new BillingLivePlanRegistrationService({
      db: lookalike.pool,
      mode: 'live',
      identityAllowlist: PRODUCTION.allowlist,
    });
    const before = await footprint(lookalike.pool);
    const refusal = await refusalOf(
      live.registerLivePlanEpochs({
        targetId: PRODUCTION_TEST_TARGET_ID,
        confirmTargetId: PRODUCTION_TEST_TARGET_ID,
        fxRateVersionId: randomUUID(),
        planCodes: planCodes(),
        operatorId: OPERATOR,
        reason: REASON,
        evidenceReference: REFERENCE,
        dryRun: true,
      }),
    );
    assert.equal(refusal.reason, 'database_identity_refused');
    assert.deepEqual(await footprint(lookalike.pool), before);
  });

  test('a live registration with no allowlist at all is refused before any connection', async () => {
    const live = new BillingLivePlanRegistrationService({ db: forbiddenPool, mode: 'live' });
    const refusal = await refusalOf(
      live.registerLivePlanEpochs({
        targetId: PRODUCTION_TEST_TARGET_ID,
        confirmTargetId: PRODUCTION_TEST_TARGET_ID,
        fxRateVersionId: randomUUID(),
        planCodes: planCodes(),
        operatorId: OPERATOR,
        reason: REASON,
        evidenceReference: REFERENCE,
        dryRun: true,
      }),
    );
    assert.equal(refusal.reason, 'database_identity_refused');
  });

  test('a live registration selecting a SANDBOX entry is refused before any connection (crossover)', async () => {
    const live = new BillingLivePlanRegistrationService({ db: forbiddenPool, mode: 'live', identityAllowlist: SANDBOX.allowlist });
    const refusal = await refusalOf(
      live.registerLivePlanEpochs({
        targetId: SANDBOX_TEST_TARGET_ID,
        confirmTargetId: SANDBOX_TEST_TARGET_ID,
        fxRateVersionId: randomUUID(),
        planCodes: planCodes(),
        operatorId: OPERATOR,
        reason: REASON,
        evidenceReference: REFERENCE,
        dryRun: true,
      }),
    );
    assert.equal(refusal.reason, 'database_identity_refused');
  });

  test('a live registration without the typed confirmation is refused before any connection', async () => {
    const live = new BillingLivePlanRegistrationService({ db: forbiddenPool, mode: 'live', identityAllowlist: PRODUCTION.allowlist });
    const refusal = await refusalOf(
      live.registerLivePlanEpochs({
        targetId: PRODUCTION_TEST_TARGET_ID,
        fxRateVersionId: randomUUID(),
        planCodes: planCodes(),
        operatorId: OPERATOR,
        reason: REASON,
        evidenceReference: REFERENCE,
        dryRun: true,
      }),
    );
    assert.equal(refusal.reason, 'database_identity_refused');
  });
});

/* ========================================================================== */
/* E. The CLIs — the committed (empty) allowlist refuses every target          */
/* ========================================================================== */

function runCli(script: string, env: Record<string, string | null>, args: readonly string[]) {
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete childEnv[key];
    else childEnv[key] = value;
  }
  return spawnSync('node', ['--import', 'tsx', script, ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

const FX_ID = '11111111-1111-4111-8111-111111111111';
const SANDBOX_CLI_ARGS = ['--fx-rate-version', FX_ID, '--by', OPERATOR, '--reason', REASON, '--evidence', '[]'];

describe('H1 — the sandbox CLI refuses unreviewed targets and the retired flags', () => {
  test('the retired --expect-database / --expect-system-identifier flags are unknown arguments (exit 2)', () => {
    const result = runCli('scripts/billing/provision-sandbox.ts', { PAYSTACK_MODE: 'test', DATABASE_URL: 'postgres://127.0.0.1:1/x' }, [
      ...SANDBOX_CLI_ARGS,
      '--expect-database',
      SANDBOX.databaseName,
      '--expect-system-identifier',
      SANDBOX.systemIdentifier,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument: --expect-database/);
  });

  test('a loopback tunnel to a NON-approved database with an unreviewed id exits 2 and writes nothing', async () => {
    const before = await footprint(lookalike.pool);
    const result = runCli('scripts/billing/provision-sandbox.ts', {
      PAYSTACK_MODE: 'test',
      DATABASE_URL: lookalike.dbUrl,
    }, [...SANDBOX_CLI_ARGS, '--target', SANDBOX_TEST_TARGET_ID, '--apply']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not in the reviewed/);
    assert.deepEqual(await footprint(lookalike.pool), before);
  });

  test('--target is mandatory and must be an allowlist id (exit 2, nothing connected)', () => {
    const noTarget = runCli('scripts/billing/provision-sandbox.ts', { PAYSTACK_MODE: 'test', DATABASE_URL: 'postgres://127.0.0.1:1/x' }, SANDBOX_CLI_ARGS);
    assert.equal(noTarget.status, 2);
    assert.match(noTarget.stderr, /--target is required/);
    const malformed = runCli('scripts/billing/provision-sandbox.ts', { PAYSTACK_MODE: 'test', DATABASE_URL: 'postgres://127.0.0.1:1/x' }, [
      ...SANDBOX_CLI_ARGS,
      '--target',
      'Not A Valid Id',
    ]);
    assert.equal(malformed.status, 2);
  });

  test('a remote (production-shaped) DATABASE_URL is refused by the loopback gate before the allowlist is read', () => {
    const result = runCli('scripts/billing/provision-sandbox.ts', {
      PAYSTACK_MODE: 'test',
      DATABASE_URL: 'postgres://ops@db.production.example.invalid:5432/veltrixeye',
    }, [...SANDBOX_CLI_ARGS, '--target', SANDBOX_TEST_TARGET_ID, '--apply']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not resolve to a local loopback host/);
  });

  test('a loopback URL carrying host= or hostaddr= is refused: query parameters cannot redirect the connection', () => {
    for (const redirect of ['?host=198.51.100.7', '?hostaddr=198.51.100.7', '?host=/tmp']) {
      const result = runCli('scripts/billing/provision-sandbox.ts', {
        PAYSTACK_MODE: 'test',
        DATABASE_URL: `postgres://u:p@localhost:5432/veltrixeye${redirect}`,
      }, [...SANDBOX_CLI_ARGS, '--target', SANDBOX_TEST_TARGET_ID, '--apply']);
      assert.equal(result.status, 2, redirect);
      assert.match(result.stderr, /could redirect the real connection/, redirect);
    }
  });

  test('a URL with no host cannot be completed by PGHOST: the loopback gate refuses it (exit 2)', () => {
    const result = runCli('scripts/billing/provision-sandbox.ts', {
      PAYSTACK_MODE: 'test',
      DATABASE_URL: 'postgres://u:p@/veltrixeye',
      PGHOST: '198.51.100.7',
    }, [...SANDBOX_CLI_ARGS, '--target', SANDBOX_TEST_TARGET_ID, '--apply']);
    assert.equal(result.status, 2);
    // The URL parser rejects an empty host outright; either refusal is a plain exit 2.
    assert.match(result.stderr, /not a parseable postgres connection target|does not resolve to a local loopback host/);
  });
});

describe('M1 — the production CLI requires a reviewed target and a typed confirmation', () => {
  const LIVE_ARGS = ['--fx-rate-version', FX_ID, '--by', OPERATOR, '--reason', REASON];
  /**
   * Well-formed fixture plan codes: the CLI checks their SHAPE before it reads
   * the allowlist, so these tests reach the identity gate. No code is ever
   * submitted to a provider here, and none is a real plan.
   */
  const LIVE_CODES = JSON.stringify({
    'pro-monthly': 'PLN_8f3a1c9e7b2d',
    'pro-annual': 'PLN_1d6e4b0a9c7f',
    'elite-monthly': 'PLN_5a2c8e1f4b9d',
    'elite-annual': 'PLN_7b0d3f6a2e8c',
  });

  test('--target and --confirm-target are both mandatory (exit 2)', () => {
    const none = runCli('scripts/billing/provision-live.ts', { PAYSTACK_MODE: 'live', DATABASE_URL: 'postgres://127.0.0.1:1/x' }, LIVE_ARGS);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /--target and --confirm-target are both required/);
    const onlyTarget = runCli('scripts/billing/provision-live.ts', { PAYSTACK_MODE: 'live', DATABASE_URL: 'postgres://127.0.0.1:1/x' }, [
      ...LIVE_ARGS,
      '--target',
      PRODUCTION_TEST_TARGET_ID,
    ]);
    assert.equal(onlyTarget.status, 2);
  });

  test('a confirmation that does not repeat the target is refused (exit 2)', () => {
    const result = runCli('scripts/billing/provision-live.ts', { PAYSTACK_MODE: 'live', DATABASE_URL: 'postgres://127.0.0.1:1/x', PAYSTACK_LIVE_PLAN_CODES: LIVE_CODES }, [
      ...LIVE_ARGS,
      '--target',
      PRODUCTION_TEST_TARGET_ID,
      '--confirm-target',
      'something-else',
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not in the reviewed|confirmation/);
  });

  test('a target absent from the committed production allowlist is refused before DATABASE_URL is read (exit 2)', () => {
    const result = runCli('scripts/billing/provision-live.ts', { PAYSTACK_MODE: 'live', DATABASE_URL: null, PAYSTACK_LIVE_PLAN_CODES: LIVE_CODES }, [
      ...LIVE_ARGS,
      '--target',
      PRODUCTION_TEST_TARGET_ID,
      '--confirm-target',
      PRODUCTION_TEST_TARGET_ID,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not in the reviewed production allowlist/);
  });

  test('the production CLI does not accept the sandbox-only flags (exit 2)', () => {
    const result = runCli('scripts/billing/provision-live.ts', { PAYSTACK_MODE: 'live', DATABASE_URL: 'postgres://127.0.0.1:1/x' }, [
      ...LIVE_ARGS,
      '--expect-database',
      'x',
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument/);
  });
});
