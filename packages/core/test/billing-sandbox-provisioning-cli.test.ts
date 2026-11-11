/**
 * Billing Step 4 — the SANDBOX PLAN-PROVISIONING operator CLI
 * (`npm run billing:provision:sandbox`), against a real database.
 *
 * What this suite pins:
 *
 *  1. THIN WRAPPER, NO AUTHORITY — the CLI source carries no transport, no
 *     provider import, no key material, exactly one environment boundary, no
 *     FX publication call, and the npm script is wired to it.
 *  2. FAIL-CLOSED USAGE — missing or blank required inputs, malformed JSON,
 *     repeated flags, mutually exclusive flags and every unknown flag
 *     (publication, approval, rate or mode options this tool must never
 *     have) exit 2 before anything is validated or written.
 *  3. MODE IS A GATE, NEVER A SWITCH — anything but an explicit
 *     `PAYSTACK_MODE=test` (including `live`, `sandbox`, empty and absent)
 *     refuses before the first connection, even with `--apply`, and writes
 *     nothing; evidence from another domain is a typed `mode_mismatch`
 *     refusal, never a silent relabel.
 *  4. DRY RUN IS THE DEFAULT AND WRITES NOTHING — the default (and explicit
 *     `--dry-run`) validates the complete four-entry batch against the
 *     durable FX row — slots, exact catalogue × FX amounts, GHS, exponent 2,
 *     intervals, uncapped caps, unique genuine codes, one shared FX version,
 *     freshness — and leaves zero rows behind. Every typed refusal
 *     (`missing`, `stale`, `amount_mismatch`, `interval_mismatch`,
 *     `currency_mismatch`, `exponent_mismatch`, `cap_mismatch`,
 *     `invalid_provider_plan`, `excluded_provider_plan`,
 *     `duplicate_provider_plan`, `plan_matrix`, `mode_mismatch`,
 *     `below_minimum`, `invalid_evidence`, `audit_required`) exits 1 with
 *     nothing written.
 *  5. `--apply` REGISTERS EXACTLY THE VALIDATED BATCH — the four epochs plus
 *     ONE transactional `billing.provider_plans_registered` audit event
 *     together; a mismatch or a conflict leaves zero new rows of either
 *     kind. Registering confirms no payment and grants no execution.
 *  6. THE SERVICE DRY-RUN ENTRY POINT — `validateSandboxPlanEpochs` returns
 *     the validated batch and cannot write.
 *  7. THE DATABASE BOUNDARY — `PAYSTACK_MODE` is the provider gate, never
 *     database isolation: `--apply` additionally refuses any `DATABASE_URL`
 *     that is not a verified local loopback target (production-shaped,
 *     remote-unverified, query-redirected, KEY=VALUE or unparseable), with
 *     no target echoed, BEFORE the evidence is parsed or a pool exists;
 *     dry runs skip the gate entirely and keep writing nothing.
 *
 * Nothing here contacts a provider, publishes an FX rate or touches a
 * production database: the suite boots its own embedded PostgreSQL, exactly
 * like the other billing suites. The refusal runs are networkless by
 * construction — the guard fires while the target is still just a string.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
  BillingPlanProvisioningService,
  isBillingProvisioningError,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  providerIntervalForBillingInterval,
} from '../src/index.js';
import { retireActiveEpochs, startBillingTestDb, approveSandboxDatabase, createFxPrincipals, publishApprovedFx, type FxPrincipals, type SandboxTestIdentity } from './helpers/billing-checkout.js';

// Unique per suite file (see the port ledger across packages/core/test/*.test.ts).
const DB_PORT = 5549;

const OPERATOR = 'ops-sandbox-provisioning-01';
const REASON = 'register the four sandbox Paystack plan epochs for the Step 4 runbook';
const REFERENCE = 'paystack-dashboard-sandbox-plans-2026-10-14';

/**
 * One FX anchor for the whole suite: every published version is placed at a
 * STRICTLY DISTINCT millisecond offset from this anchor (so the durable
 * uniqueness index can never collide), while remaining inside the 900-second
 * freshness window for the child processes' REAL clock — the stale fixture
 * is deliberately placed outside it.
 */
const FX_ANCHOR = Date.now();
let fxTick = 0;

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
/** The marked sandbox database's explicit identity expectation (set in before()). */
let SANDBOX_IDENT: SandboxTestIdentity;
let FX: FxPrincipals;
let pool: Pool;

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  SANDBOX_IDENT = await approveSandboxDatabase(db.pool);
  FX = await createFxPrincipals(db.pool, db.dbUrl);
  pool = db.pool;
}, { timeout: 180_000 });

beforeEach(async () => {
  // Epochs are history and are never deleted; the active surface is emptied
  // between tests, exactly as the other billing suites do.
  await retireActiveEpochs(pool);
});

after(async () => {
  await FX?.close();
  await db?.stop();
});

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

/**
 * Publish an operator FX version at a distinct anchor offset. Defaults are
 * fresh (30 s + tick) for the real-clock child process; `capturedSecondsBefore
 * = 1000` models a version that has aged past the 900-second policy bound.
 */
async function publishFxNow(options: { rateScaled?: bigint; capturedSecondsBefore?: number } = {}) {
  const tick = fxTick++;
  // Every version sits at a strictly distinct offset from the anchor, so the
  // durable uniqueness index can never collide within this suite.
  const capturedAt = new Date(FX_ANCHOR - ((options.capturedSecondsBefore ?? 30) + tick) * 1000);
  return publishApprovedFx(FX, {
    fxRateScaled: options.rateScaled ?? 12_500_000n,
    fxRateScale: 6,
    effectiveFrom: capturedAt,
    capturedAt,
    source: 'ops',
    sourceReference: 'ops-sandbox-fx-board-1',
  });
}

const code = (): string => `PLN_${randomUUID().replaceAll('-', '')}`;

type Combo = 'pro/monthly' | 'pro/annual' | 'elite/monthly' | 'elite/annual';

const COMBOS: ReadonlyArray<readonly [Combo, 'pro' | 'elite', 'monthly' | 'annual']> = [
  ['pro/monthly', 'pro', 'monthly'],
  ['pro/annual', 'pro', 'annual'],
  ['elite/monthly', 'elite', 'monthly'],
  ['elite/annual', 'elite', 'annual'],
];

/** The amount the selected FX version derives for a combination (catalogue × FX, half-up). */
function derived(
  plan: 'pro' | 'elite',
  interval: 'monthly' | 'annual',
  rateScaled = 12_500_000n,
): bigint {
  return computePaymentAmountMinor({
    usdMinor: BigInt(cataloguePriceMinor(plan, interval)),
    rateScaled,
    rateScale: 6,
  });
}

/**
 * The four Step 4 evidence entries exactly as the runbook assembles them —
 * fresh genuine codes and the derived amounts — overridable per combination
 * to model a wrong observation.
 */
function evidenceBatch(
  overrides: Partial<Record<Combo, Record<string, unknown>>> = {},
): { evidence: Record<string, unknown>[]; codes: Record<Combo, string> } {
  const codes = {} as Record<Combo, string>;
  const evidence = COMBOS.map(([combo, plan, interval]) => {
    const providerPlanId = code();
    codes[combo] = providerPlanId;
    return {
      cataloguePlan: plan,
      interval,
      providerInterval: providerIntervalForBillingInterval(interval),
      providerPlanId,
      paymentCurrency: 'GHS',
      paymentAmountMinor: derived(plan, interval).toString(),
      paymentAmountExponent: 2,
      mode: 'test',
      paymentCountCap: 'uncapped',
      evidenceReference: REFERENCE,
      ...(overrides[combo] ?? {}),
    };
  });
  return { evidence, codes };
}

/**
 * Run the CLI exactly as an operator would, in a child process. A `null`
 * value REMOVES the key from the spawned environment (how the "absent mode"
 * case is forced, whatever this process happens to export).
 */
function cli(env: Record<string, string | null>, args: readonly string[]) {
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(env)) {
    if (value === null) delete childEnv[key];
    else childEnv[key] = value;
  }
  return spawnSync('node', ['--import', 'tsx', 'scripts/billing/provision-sandbox.ts', ...args], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
    env: childEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function baseArgs(fxId: string, evidence: readonly unknown[]): string[] {
  return [
    '--fx-rate-version', fxId,
    '--by', OPERATOR, '--target', 'embedded-test-sandbox',
    '--reason', REASON,
    '--evidence', JSON.stringify(evidence),
  ];
}

/** A configuration that never reaches a connection (pre-connection refusals). */
function preConnectionEnv(mode?: string): Record<string, string> {
  const env: Record<string, string> = { DATABASE_URL: 'postgres://127.0.0.1:1/preconnection' };
  if (mode !== undefined) env.PAYSTACK_MODE = mode;
  return env;
}

/** Every test-domain epoch row ever written (active + retired): history is retained. */
async function testEpochHistory(): Promise<number> {
  const { rows } = await pool.query(
    "SELECT id FROM billing_provider_plans WHERE mode = 'test'",
  );
  return rows.length;
}

const auditCount = async (): Promise<number> => {
  const { rows } = await pool.query(
    `SELECT id FROM audit_events WHERE action = $1`,
    [BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION],
  );
  return rows.length;
};

/* ========================================================================== */
/* 1. Boundary — the CLI source and its wiring                                */
/* ========================================================================== */

describe('sandbox provisioning CLI — the boundary it keeps', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (relative: string) =>
    readFileSync(path.resolve(here, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('the CLI is operator tooling: no transport, no key, one environment boundary, no FX publication', () => {
    const cli = read('../../../scripts/billing/provision-sandbox.ts');
    assert.doesNotMatch(cli, /\bfetch\s*\(/, 'no transport');
    assert.doesNotMatch(cli, /https?:\/\//, 'no provider URL');
    assert.doesNotMatch(cli, /provider-paystack|PaystackFetchFn|createPaystackProvider/, 'no provider import');
    assert.doesNotMatch(cli, /PAYSTACK_SECRET_KEY|sk_live_|sk_test_/, 'no key material');
    // The only environment read is the CLI's own boundary helper: environment
    // first, then the repo-root `.env` — never inside a business module.
    assert.equal((cli.match(/process\.env/g) ?? []).length, 1);
    assert.match(cli, /return process\.env\[key\] \?\? readDotEnvValue\(key\)/);
    assert.match(cli, /PAYSTACK_MODE/, 'the CLI gates on the configured provider domain');
    assert.match(cli, /mode: 'test'/, 'the service is constructed with the pinned sandbox domain');
    assert.match(cli, /--apply/, 'the commit path exists behind an explicit flag');
    assert.match(cli, /validateSandboxPlanEpochs/, 'the dry run goes through the service');
    assert.match(cli, /registerSandboxPlanEpochs/, 'the apply path goes through the service');
    // The FX authority is read-only from here: the CLI holds no publication
    // surface at all — publishing stays a separate approved operation.
    assert.doesNotMatch(cli, /\.publish\s*\(/, 'no FX publication call');
    assert.doesNotMatch(cli, /BillingFxRateVersionStore/, 'the CLI never holds the FX writer');
    assert.doesNotMatch(cli, /resolveEntitlements|BillingActivationService|canAccessAutomation/, 'no entitlement or activation path');
    // Refusals state plainly that nothing was written.
    assert.match(cli, /Nothing was written/);
  });

  test('the --apply database gate is a loopback allowlist that runs before the pool exists', () => {
    const cli = read('../../../scripts/billing/provision-sandbox.ts');
    assert.match(cli, /loopback/, 'the write gate is a verified-local (loopback) allowlist');
    assert.match(cli, /production or unverified/, 'the refusal states the rule, not the target');
    // The gate must be evaluated BEFORE any pool is created — no connection,
    // let alone a write, may exist when it refuses.
    assert.ok(
      cli.indexOf('localDatabaseTargetRejection(databaseUrl)') <
        cli.indexOf('createPool({ databaseUrl })'),
      'the database-target gate precedes pool creation',
    );
    // The gate is consulted only for the write path.
    assert.match(cli, /if \(args\.apply\)/, 'the database gate belongs to --apply only');
  });

  test('the npm script is wired to the CLI', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(here, '..', '..', '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    assert.equal(
      pkg.scripts['billing:provision:sandbox'],
      'tsx scripts/billing/provision-sandbox.ts',
    );
  });

  test('publication, approval, rate and mode flags are unknown arguments — exit 2', () => {
    for (const [flag, value] of [
      ['--publish', 'yes'],
      ['--approve', 'yes'],
      ['--rate', '12.5'],
      ['--fx-source', 'ops'],
      ['--mode', 'live'],
      ['--plan', 'pro-monthly=PLN_deadbeef01'],
    ] as const) {
      const result = cli({}, ['--fx-rate-version', randomUUID(), flag, value]);
      assert.equal(result.status, 2, `${flag} must be a usage error`);
      assert.match(result.stderr, /unknown argument/);
    }
  });
});

/* ========================================================================== */
/* 2. Usage and configuration — fail closed before any connection              */
/* ========================================================================== */

describe('sandbox provisioning CLI — missing and malformed inputs', () => {
  const present = (omit: string): string[] => {
    const args = [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR, '--target', 'embedded-test-sandbox',
      '--reason', REASON,
      '--evidence', '[]',
    ];
    const out: string[] = [];
    for (let index = 0; index < args.length; index += 2) {
      if (args[index] !== omit) out.push(args[index]!, args[index + 1]!);
    }
    return out;
  };

  test('every required flag is required — no defaults, nothing run', () => {
    const cases: ReadonlyArray<readonly [string, string[]]> = [
      ['no arguments', []],
      ['missing --fx-rate-version', present('--fx-rate-version')],
      ['missing --by', present('--by')],
      ['missing --reason', present('--reason')],
      ['missing --evidence', present('--evidence')],
    ];
    for (const [label, args] of cases) {
      const result = cli({}, args);
      assert.equal(result.status, 2, label);
      assert.match(result.stderr, /--fx-rate-version, --by, --reason and --evidence are all required/, label);
    }
  });

  test('blank required values are refused', () => {
    const result = cli({}, [
      '--fx-rate-version', randomUUID(),
      '--by', '   ', '--target', 'embedded-test-sandbox',
      '--reason', REASON,
      '--evidence', '[]',
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blank values are refused/);

    const blankEvidence = cli({}, [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR, '--target', 'embedded-test-sandbox',
      '--reason', REASON,
      '--evidence', ' ',
    ]);
    assert.equal(blankEvidence.status, 2);
    assert.match(blankEvidence.stderr, /blank values are refused/);
  });

  test('malformed --evidence JSON, repeated flags and conflicting flags are usage errors', () => {
    const malformed = cli(preConnectionEnv('test'), [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR, '--target', 'embedded-test-sandbox',
      '--reason', REASON,
      '--evidence', '{not json',
    ]);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /--evidence is not valid JSON/);

    const repeated = cli({}, [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR, '--target', 'embedded-test-sandbox',
      '--by', 'someone-else', '--target', 'embedded-test-sandbox',
      '--reason', REASON,
      '--evidence', '[]',
    ]);
    assert.equal(repeated.status, 2);
    assert.match(repeated.stderr, /supplied twice/);

    const conflicting = cli({}, [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR, '--target', 'embedded-test-sandbox',
      '--reason', REASON,
      '--evidence', '[]',
      '--apply',
      '--dry-run',
    ]);
    assert.equal(conflicting.status, 2);
    assert.match(conflicting.stderr, /mutually exclusive/);
  });

  test('a structurally unusable request is a typed invalid_evidence refusal, in-process, before any connection', async () => {
    // The CLI cannot reach the service's typed refusals without an approved
    // sandbox entry in the committed allowlist (which is empty by design), so
    // the same service the CLI wraps is exercised in-process. Its pool fails the
    // test if it is ever asked to connect: the refusal is pre-connection.
    const service = new BillingPlanProvisioningService({
      db: { connect: async () => { throw new Error('must be refused before any connection'); } } as never,
      mode: 'test',
      identityAllowlist: SANDBOX_IDENT.allowlist,
    });
    const audit = { operatorId: OPERATOR, reason: REASON };
    for (const input of [
      { fxRateVersionId: randomUUID(), evidence: 42, databaseTarget: SANDBOX_IDENT.target, audit },
      { fxRateVersionId: 'not-a-uuid', evidence: [], databaseTarget: SANDBOX_IDENT.target, audit },
    ]) {
      await assert.rejects(
        service.registerSandboxPlanEpochs(input),
        (error: unknown) => isBillingProvisioningError(error) && error.reason === 'invalid_evidence',
      );
    }
  });
});

/* ========================================================================== */
/* 3. Mode — a gate, never a switch                                           */
/* ========================================================================== */

describe('sandbox provisioning CLI — PAYSTACK_MODE is a gate, never a switch', () => {
  test('anything but an explicit "test" refuses before connecting — even with --apply', async () => {
    const fx = await publishFxNow();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const args = [...baseArgs(fx.id, evidenceBatch().evidence), '--apply'];

    for (const configured of ['live', 'LIVE', 'sandbox', 'test ', '']) {
      const result = cli(preConnectionEnv(configured), args);
      assert.equal(result.status, 2, `PAYSTACK_MODE=${JSON.stringify(configured)} is a configuration error`);
      assert.match(result.stderr, /PAYSTACK_MODE must be exactly "test"/);
    }

    // Absent: the key is REMOVED from the spawned environment outright, so
    // "absent" cannot inherit a value from this process.
    const absent = cli(
      { DATABASE_URL: 'postgres://127.0.0.1:1/preconnection', PAYSTACK_MODE: null },
      args,
    );
    assert.equal(absent.status, 2, 'an absent mode is not an explicit sandbox pin');
    assert.match(absent.stderr, /PAYSTACK_MODE must be exactly "test"/);
    assert.match(absent.stderr, /got nothing/);

    assert.equal(await testEpochHistory(), historyBefore, 'no epoch row was written');
    assert.equal(await auditCount(), auditsBefore, 'no audit event was written');
  });

  test('evidence from another domain is a typed mode_mismatch refusal — never relabelled', async () => {
    // In-process on the real embedded database: the CLI cannot reach this
    // refusal without an approved sandbox entry (see the note above).
    const fx = await publishFxNow();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const { evidence } = evidenceBatch({ 'pro/monthly': { mode: 'live' } });
    const service = new BillingPlanProvisioningService({ db: pool, mode: 'test', identityAllowlist: SANDBOX_IDENT.allowlist });
    await assert.rejects(
      service.validateSandboxPlanEpochs({
        fxRateVersionId: fx.id,
        evidence,
        databaseTarget: SANDBOX_IDENT.target,
        audit: { operatorId: OPERATOR, reason: REASON },
      }),
      (error: unknown) => isBillingProvisioningError(error) && error.reason === 'mode_mismatch',
    );
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});

/* ========================================================================== */
/* 4. Dry run — the default                                                    */
/* ========================================================================== */

/*
 * PR #151 (H1 remediation): the subprocess SUCCESS path (`--target … --apply` and
 * `--target … ` dry run, printing the batch) is NOT exercised by any test in this
 * file, because the committed allowlist is empty by design and a test-only
 * override is refused. Coverage of the service the CLI wraps is in-process:
 *   - billing-step4-provisioning-db.test.ts: registerSandboxPlanEpochs against the
 *     embedded database with an injected test allowlist (four epochs, one audit,
 *     atomicity, conflict rollback);
 *   - billing-sandbox-database-identity.test.ts: the identity matrix, and the
 *     dry run (validateSandboxPlanEpochs) reading nothing before identity holds.
 * The CLI's own output formatting and exit mapping on success are therefore
 * UNVERIFIED by a test. The refusal matrix through the CLI is covered here.
 */

describe('sandbox provisioning — validateSandboxPlanEpochs cannot write', () => {
  test('the dry-run entry point returns the validated batch and persists nothing', async () => {
    const fx = await publishFxNow();
    const { evidence } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const service = new BillingPlanProvisioningService({ identityAllowlist: SANDBOX_IDENT.allowlist, db: pool, mode: 'test' });
    const batch = await service.validateSandboxPlanEpochs({ databaseTarget: SANDBOX_IDENT.target,
      fxRateVersionId: fx.id,
      evidence,
      audit: { operatorId: OPERATOR, reason: REASON },
    });

    assert.equal(batch.mode, 'test');
    assert.equal(batch.fxVersion.id, fx.id);
    assert.equal(batch.registrations.length, 4);
    for (const [index, [combo, plan, interval]] of COMBOS.entries()) {
      const registration = batch.registrations[index]!;
      assert.equal(`${registration.cataloguePlan}-${registration.interval}`, combo.replace('/', '-'));
      assert.equal(registration.paymentAmountMinor, derived(plan, interval));
      assert.equal(registration.providerInterval, interval === 'annual' ? 'annually' : 'monthly');
      assert.equal(registration.fxRateVersionId, fx.id, 'one shared FX-version identity');
    }

    assert.equal(await testEpochHistory(), historyBefore, 'validation writes no epoch');
    assert.equal(await auditCount(), auditsBefore, 'validation writes no audit event');
  });

  test('the dry-run entry point applies the same refusals as the write path', async () => {
    const fx = await publishFxNow();
    const { evidence } = evidenceBatch({
      'pro/monthly': { paymentCurrency: 'USD' },
    });
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const service = new BillingPlanProvisioningService({ identityAllowlist: SANDBOX_IDENT.allowlist, db: pool, mode: 'test' });

    await assert.rejects(
      () => service.validateSandboxPlanEpochs({ databaseTarget: SANDBOX_IDENT.target, fxRateVersionId: fx.id, evidence }),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'reason' in error &&
        (error as { reason: unknown }).reason === 'currency_mismatch',
    );
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});

/* ========================================================================== */
/* 8. THE DATABASE BOUNDARY — `--apply` writes only to a verified local target */
/* ========================================================================== */

describe('sandbox provisioning CLI — the database boundary', () => {
  // The provider-domain pin (`PAYSTACK_MODE=test`) is NOT database
  // isolation: a test-mode run pointed at a production or unverified
  // `DATABASE_URL` must be impossible. The gate fires before the evidence
  // is parsed and before any pool exists, so every refusal below happens
  // while the target is still just a string — no connection, no DNS, no
  // write. (The hostnames used are reserved shapes only; nothing is ever
  // resolved or dialled.) `--by` / `--reason` / `--fx-rate-version` are
  // valid so the target gate is the FIRST thing that can refuse.
  const requiredArgs = (evidence: readonly unknown[] = []): string[] => [
    '--fx-rate-version', randomUUID(),
    '--by', OPERATOR, '--target', 'embedded-test-sandbox',
    '--reason', REASON,
    '--evidence', JSON.stringify(evidence),
  ];

  test('--apply refuses production-shaped and unverified database targets before any connection or write', async () => {
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const targets: ReadonlyArray<readonly [string, string]> = [
      ['production-shaped managed host', 'postgres://veltrix:fake-credential@dpg-sandbox-provisioning.render.com/veltrixeye'],
      ['remote unverified host', 'postgres://veltrix:fake-credential@db.internal.example.invalid:5432/veltrixeye'],
      ['loopback with a query that would redirect the real target', 'postgres://veltrix:fake-credential@127.0.0.1:5433/veltrixeye?host=db.example.invalid'],
      ['KEY=VALUE (non-URL) form — not positively verifiable as local', 'host=db.example.invalid dbname=veltrixeye'],
      ['unparseable garbage', 'not-a-connection-string'],
    ];
    for (const [label, databaseUrl] of targets) {
      const result = cli(
        { DATABASE_URL: databaseUrl, PAYSTACK_MODE: 'test' },
        [...requiredArgs(), '--apply'],
      );
      assert.equal(result.status, 2, `${label} must be refused before any connection: ${result.stderr}`);
      assert.match(result.stderr, /--apply refuses this database target/, label);
      assert.match(result.stderr, /production or unverified/, label);
      assert.match(result.stderr, /PAYSTACK_MODE=test/, label);
      assert.match(result.stderr, /Nothing was written/, label);
      // The refusal echoes NOTHING about the configured target — not the
      // hostname, not the database name, not the credential.
      assert.ok(!result.stderr.includes('render.com'), 'no hostname is echoed');
      assert.ok(!result.stderr.includes('example.invalid'), 'no hostname is echoed');
      assert.ok(!result.stderr.includes('fake-credential'), 'no credential is echoed');
      assert.ok(!result.stderr.includes('veltrixeye'), 'no database name is echoed');
      // The mode gate is untouched: this is the target gate firing.
      assert.ok(!result.stderr.includes('must be exactly'), 'not the mode gate');
    }
    assert.equal(await testEpochHistory(), historyBefore, 'no epoch row was written');
    assert.equal(await auditCount(), auditsBefore, 'no audit event was written');
  });

  test('the target gate covers dry runs too: an unverifiable target is refused before any connection', async () => {
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    // Same unverifiable target, WITHOUT --apply. Identity can only be checked
    // by connecting, so a dry run is held to the same loopback gate: it is
    // refused before any pool exists (exit 2), never connected to.
    const result = cli(
      { DATABASE_URL: 'not-a-connection-string', PAYSTACK_MODE: 'test' },
      requiredArgs(),
    );
    assert.equal(result.status, 2, `the dry run is gated: ${result.stderr}`);
    assert.match(result.stderr, /the dry run refuses this database target/);
    assert.doesNotMatch(result.stderr, /--apply refuses this database target/);
    assert.equal(await testEpochHistory(), historyBefore, 'a dry run writes no epoch');
    assert.equal(await auditCount(), auditsBefore, 'a dry run writes no audit event');
  });

  test('a verified local target passes the loopback gate and is then refused by the reviewed allowlist', async () => {
    // Positive control, full stack: a loopback DATABASE_URL and `--apply` pass
    // the database-target gate; the run then reaches the reviewed allowlist,
    // which has no sandbox entry in the committed file, and refuses there.
    // Nothing is written on either side of the gate.
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const result = cli(
      { DATABASE_URL: 'postgres://127.0.0.1:5549/veltrixeye', PAYSTACK_MODE: 'test' },
      ['--fx-rate-version', 'not-a-uuid', '--by', OPERATOR, '--target', 'embedded-test-sandbox', '--reason', REASON, '--evidence', '[]', '--apply'],
    );
    assert.equal(result.status, 2, `the gate passed; the allowlist refused: ${result.stderr}`);
    assert.match(result.stderr, /not in the reviewed sandbox allowlist|not in the reviewed/);
    assert.doesNotMatch(result.stderr, /--apply refuses this database target/);
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});
