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
 *
 * Nothing here contacts a provider, publishes an FX rate or touches a
 * production database: the suite boots its own embedded PostgreSQL, exactly
 * like the other billing suites.
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
  BillingFxRateVersionStore,
  BillingPlanProvisioningService,
  EXCLUDED_PROVIDER_PLAN_CODE,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  providerIntervalForBillingInterval,
} from '../src/index.js';
import { retireActiveEpochs, startBillingTestDb } from './helpers/billing-checkout.js';

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
let pool: Pool;

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  pool = db.pool;
}, { timeout: 180_000 });

beforeEach(async () => {
  // Epochs are history and are never deleted; the active surface is emptied
  // between tests, exactly as the other billing suites do.
  await retireActiveEpochs(pool);
});

after(async () => {
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
  const fxVersions = new BillingFxRateVersionStore(pool);
  return fxVersions.publish({
    fxRateScaled: options.rateScaled ?? 12_500_000n,
    fxRateScale: 6,
    effectiveFrom: capturedAt,
    capturedAt,
    source: 'ops',
    sourceReference: 'ops-sandbox-fx-board-1',
    createdBy: OPERATOR,
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
    '--by', OPERATOR,
    '--reason', REASON,
    '--evidence', JSON.stringify(evidence),
  ];
}

/** The sandbox configuration every DB-reaching run uses. */
function sandboxEnv(): Record<string, string> {
  return { DATABASE_URL: db.dbUrl, PAYSTACK_MODE: 'test' };
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

/** The ACTIVE test-domain epochs, in matrix order. */
async function activeTestEpochs() {
  const { rows } = await pool.query(
    `SELECT catalogue_plan, billing_interval, provider_plan_id, payment_currency,
            payment_amount_exponent, payment_amount_minor::text AS amount,
            provider_plan_reference, fx_rate_version_id::text AS fx, status, mode
       FROM billing_provider_plans
      WHERE mode = 'test' AND status = 'active'
      ORDER BY CASE catalogue_plan WHEN 'pro' THEN 0 ELSE 1 END,
               CASE billing_interval WHEN 'monthly' THEN 0 ELSE 1 END`,
  );
  return rows;
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
      '--by', OPERATOR,
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
      '--by', '   ',
      '--reason', REASON,
      '--evidence', '[]',
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blank values are refused/);

    const blankEvidence = cli({}, [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', ' ',
    ]);
    assert.equal(blankEvidence.status, 2);
    assert.match(blankEvidence.stderr, /blank values are refused/);
  });

  test('malformed --evidence JSON, repeated flags and conflicting flags are usage errors', () => {
    const malformed = cli(preConnectionEnv('test'), [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '{not json',
    ]);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /--evidence is not valid JSON/);

    const repeated = cli({}, [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR,
      '--by', 'someone-else',
      '--reason', REASON,
      '--evidence', '[]',
    ]);
    assert.equal(repeated.status, 2);
    assert.match(repeated.stderr, /supplied twice/);

    const conflicting = cli({}, [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '[]',
      '--apply',
      '--dry-run',
    ]);
    assert.equal(conflicting.status, 2);
    assert.match(conflicting.stderr, /mutually exclusive/);
  });

  test('a structurally unusable request is a typed invalid_evidence refusal — exit 1, no connection needed', () => {
    // Valid JSON that is not an evidence array: the CLI passes it through and
    // the service's strict input schema refuses it (exit 1, nothing written).
    const result = cli(preConnectionEnv('test'), [
      '--fx-rate-version', randomUUID(),
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '42',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refused \(invalid_evidence\)/);
    assert.match(result.stderr, /Nothing was written/);

    const badUuid = cli(preConnectionEnv('test'), [
      '--fx-rate-version', 'not-a-uuid',
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', JSON.stringify([]),
    ]);
    assert.equal(badUuid.status, 1);
    assert.match(badUuid.stderr, /refused \(invalid_evidence\)/);
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
    const fx = await publishFxNow();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const { evidence } = evidenceBatch({ 'pro/monthly': { mode: 'live' } });
    const result = cli(sandboxEnv(), baseArgs(fx.id, evidence));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused \(mode_mismatch\)/);
    assert.match(result.stderr, /Nothing was written/);
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});

/* ========================================================================== */
/* 4. Dry run — the default                                                    */
/* ========================================================================== */

describe('sandbox provisioning CLI — dry run is the default and writes nothing', () => {
  test('the default run validates the whole batch against the durable FX row and persists nothing', async () => {
    const fx = await publishFxNow();
    const { evidence, codes } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const result = cli(sandboxEnv(), baseArgs(fx.id, evidence));
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout) as {
      outcome: string;
      dryRun: boolean;
      mode: string;
      providerCalls: number;
      fxRateVersionId: string;
      auditAction: string | null;
      grantsExecution: boolean;
      paymentConfirmed: boolean;
      plan: Array<Record<string, unknown>>;
    };
    assert.equal(output.outcome, 'dry_run');
    assert.equal(output.dryRun, true);
    assert.equal(output.mode, 'test');
    assert.equal(output.providerCalls, 0);
    assert.equal(output.fxRateVersionId, fx.id);
    assert.equal(output.auditAction, null, 'a dry run records no audit event');
    assert.equal(output.grantsExecution, false);
    assert.equal(output.paymentConfirmed, false);
    assert.equal(output.plan.length, 4);

    for (const [index, [combo, plan, interval]] of COMBOS.entries()) {
      const entry = output.plan[index]!;
      assert.equal(entry.slot, combo.replace('/', '-'), `slot order: ${combo}`);
      assert.equal(entry.cataloguePlan, plan);
      assert.equal(entry.billingInterval, interval);
      assert.equal(entry.providerInterval, interval === 'annual' ? 'annually' : 'monthly');
      assert.equal(entry.providerPlanId, codes[combo]);
      assert.equal(entry.paymentCurrency, 'GHS');
      assert.equal(entry.paymentAmountMinor, derived(plan, interval).toString());
      assert.equal(entry.epochId, null, 'a dry run reports no epoch');
      assert.equal(entry.status, null);
    }

    assert.equal(await testEpochHistory(), historyBefore, 'a dry run writes no epoch');
    assert.equal(await auditCount(), auditsBefore, 'a dry run writes no audit event');
    assert.match(result.stderr, /Nothing was written/);
  });

  test('an explicit --dry-run behaves identically to the default', async () => {
    const fx = await publishFxNow();
    const { evidence } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const result = cli(sandboxEnv(), [...baseArgs(fx.id, evidence), '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { outcome: string; dryRun: boolean };
    assert.equal(output.outcome, 'dry_run');
    assert.equal(output.dryRun, true);
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });

  test('an FX version that does not exist is refused as missing — no promotion, nothing written', async () => {
    const { evidence } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const result = cli(sandboxEnv(), baseArgs(randomUUID(), evidence));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused \(missing\)/);
    assert.match(result.stderr, /Nothing was written/);
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });

  test('a stale FX version is refused — 900 seconds is the authority, not a suggestion', async () => {
    const fx = await publishFxNow({ capturedSecondsBefore: 1000 });
    const { evidence } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const result = cli(sandboxEnv(), baseArgs(fx.id, evidence));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused \(stale\)/);
    assert.match(result.stderr, /Nothing was written/);
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });

  test('a credential-shaped operator identity is refused before anything runs', async () => {
    const fx = await publishFxNow();
    const { evidence } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const result = cli(sandboxEnv(), [
      '--fx-rate-version', fx.id,
      '--by', 'ops-bearer-identifier-1',
      '--reason', REASON,
      '--evidence', JSON.stringify(evidence),
    ]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused \(audit_required\)/);
    assert.match(result.stderr, /credential-shaped/);
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});

/* ========================================================================== */
/* 5. The refusal matrix — every Step 4 rule, through the CLI                 */
/* ========================================================================== */

describe('sandbox provisioning CLI — the typed refusal matrix (dry run)', () => {
  test('amount, interval, currency, exponent, cap, code, matrix, mode and FX-identity violations all refuse', async () => {
    const fx = await publishFxNow();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const wrongAmount = derived('elite', 'annual') + 1n;
    const cases: ReadonlyArray<{ label: string; reason: string; args: string[] }> = [
      {
        label: 'amount mismatch',
        reason: 'amount_mismatch',
        args: baseArgs(fx.id, evidenceBatch({
          'elite/annual': { paymentAmountMinor: wrongAmount.toString() },
        }).evidence),
      },
      {
        label: 'interval mismatch',
        reason: 'interval_mismatch',
        args: baseArgs(fx.id, evidenceBatch({
          'elite/annual': { providerInterval: 'monthly' },
        }).evidence),
      },
      {
        label: 'currency mismatch',
        reason: 'currency_mismatch',
        args: baseArgs(fx.id, evidenceBatch({
          'elite/annual': { paymentCurrency: 'USD' },
        }).evidence),
      },
      {
        label: 'exponent mismatch',
        reason: 'exponent_mismatch',
        args: baseArgs(fx.id, evidenceBatch({
          'elite/annual': { paymentAmountExponent: 0 },
        }).evidence),
      },
      {
        label: 'capped payment count',
        reason: 'cap_mismatch',
        args: baseArgs(fx.id, evidenceBatch({
          'elite/annual': { paymentCountCap: { capped: true, maxPayments: 1 } },
        }).evidence),
      },
      {
        label: 'unknown payment count',
        reason: 'cap_mismatch',
        args: baseArgs(fx.id, evidenceBatch({
          'elite/annual': { paymentCountCap: 'unknown' },
        }).evidence),
      },
      {
        label: 'placeholder plan code',
        reason: 'invalid_provider_plan',
        args: baseArgs(fx.id, evidenceBatch({
          'pro/monthly': { providerPlanId: 'PLN_sample0000001' },
        }).evidence),
      },
      {
        label: 'malformed plan code',
        reason: 'invalid_provider_plan',
        args: baseArgs(fx.id, evidenceBatch({
          'pro/monthly': { providerPlanId: 'pro-monthly-plan' },
        }).evidence),
      },
      {
        label: 'excluded capability-evidence plan',
        reason: 'excluded_provider_plan',
        args: baseArgs(fx.id, evidenceBatch({
          'pro/monthly': { providerPlanId: EXCLUDED_PROVIDER_PLAN_CODE },
        }).evidence),
      },
      {
        label: 'duplicate plan code',
        reason: 'duplicate_provider_plan',
        args: (() => {
          const batch = evidenceBatch();
          return baseArgs(fx.id, batch.evidence.map((entry) => (
            entry.cataloguePlan === 'elite' && entry.interval === 'annual'
              ? { ...entry, providerPlanId: batch.codes['pro/monthly'] }
              : entry
          )));
        })(),
      },
      {
        label: 'a fifth slot',
        reason: 'plan_matrix',
        args: baseArgs(fx.id, [...evidenceBatch().evidence, {
          cataloguePlan: 'starter',
          interval: 'monthly',
          providerInterval: 'monthly',
          providerPlanId: code(),
          paymentCurrency: 'GHS',
          paymentAmountMinor: '1500',
          paymentAmountExponent: 2,
          mode: 'test',
          paymentCountCap: 'uncapped',
          evidenceReference: REFERENCE,
        }]),
      },
      {
        label: 'a partial batch',
        reason: 'plan_matrix',
        args: baseArgs(fx.id, evidenceBatch().evidence.slice(0, 3)),
      },
      {
        label: 'an FX id smuggled into evidence',
        reason: 'invalid_evidence',
        args: baseArgs(fx.id, evidenceBatch({
          'pro/monthly': { fxRateVersionId: randomUUID() },
        }).evidence),
      },
    ];

    for (const { label, reason, args } of cases) {
      const result = cli(sandboxEnv(), args);
      assert.equal(result.status, 1, `${label}: expected a typed refusal\n${result.stderr}`);
      assert.match(result.stderr, new RegExp(`refused \\(${reason}\\)`), label);
      assert.match(result.stderr, /Nothing was written/, label);
    }

    assert.equal(await testEpochHistory(), historyBefore, 'no refusal wrote an epoch');
    assert.equal(await auditCount(), auditsBefore, 'no refusal wrote an audit event');
  });

  test('an amount derived below the provider minimum is refused (below_minimum)', async () => {
    // A deliberately tiny rate: catalogue × FX falls under 10 pesewas, so the
    // batch refuses on the derived amount itself — evidence cannot fix it.
    const fx = await publishFxNow({ rateScaled: 1000n });
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const { evidence } = evidenceBatch();

    const result = cli(sandboxEnv(), baseArgs(fx.id, evidence));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused \(below_minimum\)/);
    assert.match(result.stderr, /Nothing was written/);
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});

/* ========================================================================== */
/* 6. --apply — the explicit commit path                                       */
/* ========================================================================== */

describe('sandbox provisioning CLI — --apply registers exactly the validated batch', () => {
  test('--apply registers the four epochs and ONE audit event together, and grants nothing', async () => {
    const fx = await publishFxNow();
    const { evidence, codes } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const result = cli(sandboxEnv(), [...baseArgs(fx.id, evidence), '--apply']);
    assert.equal(result.status, 0, result.stderr);

    const output = JSON.parse(result.stdout) as {
      outcome: string;
      dryRun: boolean;
      mode: string;
      providerCalls: number;
      fxRateVersionId: string;
      auditAction: string | null;
      grantsExecution: boolean;
      paymentConfirmed: boolean;
      plan: Array<Record<string, unknown>>;
    };
    assert.equal(output.outcome, 'registered');
    assert.equal(output.dryRun, false);
    assert.equal(output.mode, 'test');
    assert.equal(output.providerCalls, 0, 'no provider call is possible from this tool');
    assert.equal(output.fxRateVersionId, fx.id);
    assert.equal(output.auditAction, BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION);
    assert.equal(output.grantsExecution, false, 'a registered epoch grants no execution');
    assert.equal(output.paymentConfirmed, false, 'a registered epoch confirms no payment');
    assert.equal(output.plan.length, 4);
    for (const [index, [combo, plan, interval]] of COMBOS.entries()) {
      const entry = output.plan[index]!;
      assert.equal(entry.slot, combo.replace('/', '-'));
      assert.equal(entry.providerPlanId, codes[combo]);
      assert.equal(entry.paymentAmountMinor, derived(plan, interval).toString());
      assert.notEqual(entry.epochId, null, 'the CLI reports the persisted epoch id');
      assert.equal(entry.status, 'active');
    }

    // Durable rows: exactly the four combinations, test mode, GHS, exponent 2,
    // the derived amounts, the real codes, one shared fresh FX version and
    // the operator's provenance label.
    const rows = await activeTestEpochs();
    assert.equal(rows.length, 4);
    for (const [index, [combo, plan, interval]] of COMBOS.entries()) {
      const row = rows[index]!;
      assert.equal(`${row.catalogue_plan}-${row.billing_interval}`, combo.replace('/', '-'));
      assert.equal(row.mode, 'test');
      assert.equal(row.status, 'active');
      assert.equal(row.payment_currency, 'GHS');
      assert.equal(row.payment_amount_exponent, 2);
      assert.equal(row.amount, derived(plan, interval).toString());
      assert.equal(row.provider_plan_id, codes[combo]);
      assert.equal(row.provider_plan_reference, REFERENCE);
      assert.equal(row.fx, fx.id, 'all four epochs pin the one shared FX version');
    }
    assert.equal(await testEpochHistory(), historyBefore + 4);
    assert.equal(await auditCount(), auditsBefore + 1);

    // The transactional audit event names the operator, the reason and the
    // shared FX version — and pins that nothing was granted or confirmed.
    const { rows: auditRows } = await pool.query(
      `SELECT metadata FROM audit_events WHERE action = $1 ORDER BY id DESC LIMIT 1`,
      [BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION],
    );
    assert.equal(auditRows.length, 1);
    const metadata = auditRows[0]!.metadata as {
      mode: string;
      operatorId: string;
      reason: string;
      fxRateVersionId: string;
      grantsExecution: boolean;
      paymentConfirmed: boolean;
      epochs: unknown[];
    };
    assert.equal(metadata.mode, 'test');
    assert.equal(metadata.operatorId, OPERATOR);
    assert.equal(metadata.reason, REASON);
    assert.equal(metadata.fxRateVersionId, fx.id);
    assert.equal(metadata.grantsExecution, false);
    assert.equal(metadata.paymentConfirmed, false);
    assert.equal(metadata.epochs.length, 4);
  });

  test('a mismatched batch is refused under --apply before any write', async () => {
    const fx = await publishFxNow();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();
    const { evidence } = evidenceBatch({
      'pro/annual': { paymentAmountMinor: (derived('pro', 'annual') + 1n).toString() },
    });

    const result = cli(sandboxEnv(), [...baseArgs(fx.id, evidence), '--apply']);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused \(amount_mismatch\)/);
    assert.match(result.stderr, /Nothing was written/);
    assert.equal(await testEpochHistory(), historyBefore, 'no epoch was written');
    assert.equal(await auditCount(), auditsBefore, 'no audit event was written');
  });

  test('a second --apply of the same codes conflicts and rolls back — the batch is atomic', async () => {
    const first = await publishFxNow();
    const { evidence, codes } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const applied = cli(sandboxEnv(), [...baseArgs(first.id, evidence), '--apply']);
    assert.equal(applied.status, 0, applied.stderr);
    const historyAfterFirst = await testEpochHistory();
    const auditsAfterFirst = await auditCount();
    assert.equal(historyAfterFirst, historyBefore + 4, 'the first apply registered its four epochs');
    assert.equal(auditsAfterFirst, auditsBefore + 1, 'the first apply recorded its one audit event');

    // A fresh FX version (the first is only usable for its own registration
    // window) but the SAME four provider codes: the store must refuse the
    // collision and roll the entire second batch back.
    const second = await publishFxNow();
    const replay = cli(sandboxEnv(), [...baseArgs(second.id, evidence), '--apply']);
    assert.equal(replay.status, 1, replay.stderr);
    assert.match(replay.stderr, /refused \(conflict\)/);
    assert.match(replay.stderr, /rolls back together/);
    assert.equal(await testEpochHistory(), historyAfterFirst, 'no partial batch survived');
    assert.equal(await auditCount(), auditsAfterFirst, 'the rolled-back run recorded no audit event');
    assert.equal(codes['pro/monthly'], evidence[0]!.providerPlanId, 'the codes were genuinely reused');
  });
});

/* ========================================================================== */
/* 7. The service dry-run entry point (directly)                               */
/* ========================================================================== */

describe('sandbox provisioning — validateSandboxPlanEpochs cannot write', () => {
  test('the dry-run entry point returns the validated batch and persists nothing', async () => {
    const fx = await publishFxNow();
    const { evidence } = evidenceBatch();
    const historyBefore = await testEpochHistory();
    const auditsBefore = await auditCount();

    const service = new BillingPlanProvisioningService({ db: pool, mode: 'test' });
    const batch = await service.validateSandboxPlanEpochs({
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
    const service = new BillingPlanProvisioningService({ db: pool, mode: 'test' });

    await assert.rejects(
      () => service.validateSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'reason' in error &&
        (error as { reason: unknown }).reason === 'currency_mismatch',
    );
    assert.equal(await testEpochHistory(), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});
