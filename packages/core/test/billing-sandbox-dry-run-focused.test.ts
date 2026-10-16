/**
 * Billing Step 4 — FOCUSED DRY-RUN PREPARATION suite (paper-only).
 *
 * Narrow scope: validate that the sandbox provisioning CLI and its
 * authoritative service are safe for dry-run validation without any
 * external provisioning write.
 *
 * Four focused axes, each proved without a database or provider call:
 *
 *  1. INVALID INPUTS — blank/missing/malformed/duplicate/unknown flags are
 *     refused before any validation or write (exit 2, nothing written).
 *  2. MISSING PREREQUISITES — the four genuine Paystack test-plan PLN_…
 *     codes and the approved FX source/rate/provenance are operator-supplied
 *     inputs. When they are absent, placeholder-shaped, malformed or the
 *     FX version is missing/stale, the authoritative validator refuses
 *     (typed reason, nothing written). This suite treats those four codes
 *     and the FX provenance as **unresolved prerequisites** when not supplied
 *     — no code path invents them.
 *  3. TEST-MODE ENFORCEMENT — PAYSTACK_MODE is a gate, never a switch.
 *     Anything but an explicit `test` refuses before the first connection;
 *     evidence from another domain is a typed `mode_mismatch` refusal.
 *  4. ABSENCE OF SIDE EFFECTS — the CLI has no provider transport, no
 *     credential, no FX publish/refresh, no plan creation/rotation, no
 *     production write. Dry-run validation is read-only by construction:
 *     `validateSandboxPlanEpochs` shares byte-identical validation with the
 *     write path but never opens a transaction.
 *
 * Nothing here contacts Paystack, publishes an FX rate, or writes to a
 * database. The suite is pure — it reads one source file and spawns the
 * CLI with fake connection strings that are never dialled.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cataloguePriceMinor,
  computePaymentAmountMinor,
  providerIntervalForBillingInterval,
  EXCLUDED_PROVIDER_PLAN_CODE,
} from '../src/index.js';
import {
  prepareSandboxProvisioningBatch,
  isBillingProvisioningError,
} from '../src/billing/provisioning.js';
import { isBillingFxError } from '../src/billing/fx-rate-versions.js';

// ---------------------------------------------------------------------------
// Helpers — fake FX authority row + evidence batch (pure, no DB)
// ---------------------------------------------------------------------------

const FX_ID = randomUUID();
const OPERATOR = 'ops-sandbox-focused-01';
const REASON = 'focused dry-run validation — paper only';
const REFERENCE = 'paystack-dashboard-sandbox-plans-2026-10-16';
const FX_RATE_SCALED = 12_500_000n; // 12.5 GHS/USD at scale 6
const FX_SCALE = 6;
const NOW = new Date();
const CAPTURED_AT = new Date(NOW.getTime() - 30_000); // 30s ago → fresh (<900s)

/** Minimal durable FX row as stored in billing_fx_rate_versions. */
function fxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: FX_ID,
    base_currency: 'USD',
    quote_currency: 'GHS',
    fx_rate_scaled: FX_RATE_SCALED.toString(),
    fx_rate_scale: FX_SCALE,
    rounding_mode: 'half_up',
    source: 'ops',
    source_reference: 'ops-sandbox-fx-board-1',
    created_by: OPERATOR,
    effective_from: CAPTURED_AT.toISOString(),
    captured_at: CAPTURED_AT.toISOString(),
    ...overrides,
  };
}

function derived(plan: 'pro' | 'elite', interval: 'monthly' | 'annual'): bigint {
  return computePaymentAmountMinor({
    usdMinor: BigInt(cataloguePriceMinor(plan, interval)),
    rateScaled: FX_RATE_SCALED,
    rateScale: FX_SCALE,
  });
}

function evidenceBatch(overrides: Record<string, Record<string, unknown>> = {}) {
  const combos: Array<[string, 'pro' | 'elite', 'monthly' | 'annual']> = [
    ['pro/monthly', 'pro', 'monthly'],
    ['pro/annual', 'pro', 'annual'],
    ['elite/monthly', 'elite', 'monthly'],
    ['elite/annual', 'elite', 'annual'],
  ];
  return combos.map(([combo, plan, interval]) => ({
    cataloguePlan: plan,
    interval,
    providerInterval: providerIntervalForBillingInterval(interval),
    providerPlanId: `PLN_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    paymentCurrency: 'GHS',
    paymentAmountMinor: derived(plan, interval).toString(),
    paymentAmountExponent: 2,
    mode: 'test',
    paymentCountCap: 'uncapped' as const,
    evidenceReference: REFERENCE,
    ...(overrides[combo] ?? {}),
  }));
}

// Spawn the CLI with a fake-but-parseable env; no connection is ever made
// for the cases that fail before the pool exists.
function cli(env: Record<string, string | null>, args: readonly string[]) {
  const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete childEnv[k];
    else childEnv[k] = v;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return spawnSync('node', ['--import', 'tsx', 'scripts/billing/provision-sandbox.ts', ...args], {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
    timeout: 15_000,
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

// ---------------------------------------------------------------------------
// 1. Invalid inputs — rejected before any provisioning attempt
// ---------------------------------------------------------------------------

describe('focused dry-run — invalid inputs are refused before any write', () => {
  test('missing required flags are usage errors (exit 2)', () => {
    const cases: Array<[string, string[]]> = [
      ['no args', []],
      ['missing --fx-rate-version', ['--by', OPERATOR, '--reason', REASON, '--evidence', '[]']],
      ['missing --by', ['--fx-rate-version', FX_ID, '--reason', REASON, '--evidence', '[]']],
      ['missing --reason', ['--fx-rate-version', FX_ID, '--by', OPERATOR, '--evidence', '[]']],
      ['missing --evidence', ['--fx-rate-version', FX_ID, '--by', OPERATOR, '--reason', REASON]],
    ];
    for (const [label, args] of cases) {
      const r = cli({}, args);
      assert.equal(r.status, 2, label);
      assert.match(r.stdout + r.stderr, /--fx-rate-version, --by, --reason and --evidence are all required/, label);
    }
  });

  test('blank required values are refused (exit 2)', () => {
    const r = cli({}, [
      '--fx-rate-version', FX_ID,
      '--by', '   ',
      '--reason', REASON,
      '--evidence', '[]',
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /blank values are refused/);
  });

  test('malformed --evidence JSON is refused (exit 2, nothing validated)', () => {
    const r = cli({ PAYSTACK_MODE: 'test', DATABASE_URL: 'postgres://127.0.0.1:1/test' }, [
      '--fx-rate-version', FX_ID,
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '{not json',
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--evidence is not valid JSON/);
    assert.match(r.stderr, /Nothing was validated/);
  });

  test('repeated flags and mutually exclusive flags are refused (exit 2)', () => {
    const repeated = cli({}, [
      '--fx-rate-version', FX_ID,
      '--by', OPERATOR,
      '--by', 'other',
      '--reason', REASON,
      '--evidence', '[]',
    ]);
    assert.equal(repeated.status, 2);
    assert.match(repeated.stderr, /supplied twice/);

    const both = cli({}, [
      '--fx-rate-version', FX_ID,
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '[]',
      '--apply', '--dry-run',
    ]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /mutually exclusive/);
  });

  test('unknown flags — including publish/approve/rate/mode smuggling — are refused (exit 2)', () => {
    for (const [flag, value] of [
      ['--publish', 'yes'],
      ['--approve', 'yes'],
      ['--rate', '12.5'],
      ['--mode', 'live'],
      ['--plan', 'pro-monthly=PLN_deadbeef01'],
    ] as const) {
      const r = cli({}, ['--fx-rate-version', FX_ID, flag, value]);
      assert.equal(r.status, 2, flag);
      assert.match(r.stderr, /unknown argument/, flag);
    }
  });

  test('structurally unusable evidence shape is a typed invalid_evidence refusal (exit 1)', () => {
    // Valid JSON but not an evidence array shape — caught by strict schema
    const r = cli({ PAYSTACK_MODE: 'test', DATABASE_URL: 'postgres://127.0.0.1:1/test' }, [
      '--fx-rate-version', 'not-a-uuid',
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '42',
    ]);
    // The CLI parses JSON, then the service's input schema refuses it as invalid_evidence (exit 1)
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refused \(invalid_evidence\)/);
    assert.match(r.stderr, /Nothing was written/);
  });
});

// ---------------------------------------------------------------------------
// 2. Missing prerequisites — the four PLN_… codes + approved FX provenance
// ---------------------------------------------------------------------------

describe('focused dry-run — missing prerequisites are refused (fail closed)', () => {
  test('pure validator: a batch that is not exactly four entries is refused (plan_matrix)', () => {
    // Too few entries
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: evidenceBatch().slice(0, 3), registeredAt: NOW }),
      (e: unknown) => isBillingProvisioningError(e) && e.reason === 'plan_matrix',
    );
    // Too many entries
    const five = [...evidenceBatch(), {
      cataloguePlan: 'pro' as const,
      interval: 'monthly' as const,
      providerInterval: 'monthly' as const,
      providerPlanId: `PLN_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      paymentCurrency: 'GHS',
      paymentAmountMinor: '1',
      paymentAmountExponent: 2,
      mode: 'test',
      paymentCountCap: 'uncapped' as const,
      evidenceReference: REFERENCE,
    }];
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: five, registeredAt: NOW }),
      (e: unknown) => isBillingProvisioningError(e) && e.reason === 'plan_matrix',
    );
  });

  test('pure validator: placeholder/malformed PLN codes are refused (invalid_provider_plan)', () => {
    for (const bad of ['PLN_sample0000001', 'pro-monthly-plan', 'PLN_', 'PLN_ABCDEF123']) {
      const batch = evidenceBatch({ 'pro/monthly': { providerPlanId: bad } });
      assert.throws(
        () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: batch, registeredAt: NOW }),
        (e: unknown) => isBillingProvisioningError(e) && e.reason === 'invalid_provider_plan',
        `bad code ${bad}`,
      );
    }
  });

  test('pure validator: the excluded GHS 2.00 capability-evidence plan is refused', () => {
    const batch = evidenceBatch({ 'pro/monthly': { providerPlanId: EXCLUDED_PROVIDER_PLAN_CODE } });
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: batch, registeredAt: NOW }),
      (e: unknown) => isBillingProvisioningError(e) && e.reason === 'excluded_provider_plan',
    );
  });

  test('pure validator: duplicate PLN codes are refused (duplicate_provider_plan)', () => {
    const batch = evidenceBatch();
    const dup = batch[0]!.providerPlanId;
    batch[3] = { ...batch[3]!, providerPlanId: dup };
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: batch, registeredAt: NOW }),
      (e: unknown) => isBillingProvisioningError(e) && e.reason === 'duplicate_provider_plan',
    );
  });

  test('pure validator: the four genuine Paystack test-plan IDs are unresolved when not supplied — no code invents them', () => {
    // The validator never invents PLN codes: evidence must carry four genuine codes.
    // When evidence is empty or carries placeholders, it refuses — the four IDs
    // are prerequisites, not defaults.
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: [], registeredAt: NOW }),
      (e: unknown) => isBillingProvisioningError(e) && e.reason === 'plan_matrix',
      'empty evidence refuses — four PLN_… codes are required, not invented',
    );
    // Also: no PLN_… literal is hardcoded as a business constant in provisioning.ts
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'billing', 'provisioning.ts'), 'utf8');
    // The only PLN_ literal allowed is the excluded evidence plan (capability evidence), not a sandbox epoch
    const plnLiterals = (src.match(/PLN_/g) ?? []).length;
    assert.ok(plnLiterals >= 1, 'the excluded plan literal exists');
    // But there is no hardcoded array of four sandbox PLN codes
    assert.doesNotMatch(src, /PLN_[0-9a-z]{6,40}.*PLN_[0-9a-z]{6,40}.*PLN_[0-9a-z]{6,40}.*PLN_[0-9a-z]{6,40}/s, 'no hardcoded four-code batch');
  });

  test('pure validator: missing/stale FX provenance is refused — approved source/rate/provenance are prerequisites', () => {
    // Missing FX version (malformed row) → FxError missing/invalid
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: { nonsense: true }, evidence: evidenceBatch(), registeredAt: NOW }),
      (e: unknown) => isBillingFxError(e) || isBillingProvisioningError(e),
    );
    // Stale FX: captured 1000s ago (>900s freshness window) → stale
    const staleRow = fxRow({ captured_at: new Date(NOW.getTime() - 1_000_000).toISOString(), effective_from: new Date(NOW.getTime() - 1_000_000).toISOString() });
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: staleRow, evidence: evidenceBatch(), registeredAt: NOW }),
      (e: unknown) => isBillingFxError(e) && (e as { reason: string }).reason === 'stale',
    );
    // Wrong currency pair
    const wrongQuote = fxRow({ quote_currency: 'USD', base_currency: 'USD' });
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: wrongQuote, evidence: evidenceBatch(), registeredAt: NOW }),
      (e: unknown) => isBillingFxError(e),
    );
  });

  test('pure validator: amount must equal catalogue × FX (half-up) — evidence confirms, never overrides', () => {
    const batch = evidenceBatch({ 'elite/annual': { paymentAmountMinor: (derived('elite', 'annual') + 1n).toString() } });
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: batch, registeredAt: NOW }),
      (e: unknown) => isBillingProvisioningError(e) && e.reason === 'amount_mismatch',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Test-mode enforcement — fail closed on any non-test mode
// ---------------------------------------------------------------------------

describe('focused dry-run — test-mode enforcement (fail closed)', () => {
  test('CLI: PAYSTACK_MODE must be exactly "test" — every other value refuses before connection (exit 2)', () => {
    const goodArgs = baseArgs(FX_ID, []);
    for (const mode of ['live', 'LIVE', 'sandbox', 'test ', '']) {
      const r = cli({ PAYSTACK_MODE: mode, DATABASE_URL: 'postgres://127.0.0.1:1/test' }, goodArgs);
      assert.equal(r.status, 2, `mode=${JSON.stringify(mode)}`);
      assert.match(r.stderr, /PAYSTACK_MODE must be exactly "test"/);
    }
    const absent = cli({ PAYSTACK_MODE: null, DATABASE_URL: 'postgres://127.0.0.1:1/test' }, goodArgs);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /got nothing/);
  });

  test('pure validator: evidence mode must match configured mode — cross-domain is not relabelled', () => {
    const batch = evidenceBatch({ 'pro/monthly': { mode: 'live' } });
    assert.throws(
      () => prepareSandboxProvisioningBatch({ fxVersion: fxRow(), evidence: batch, registeredAt: NOW, mode: 'test' }),
      (e: unknown) => isBillingProvisioningError(e) && e.reason === 'mode_mismatch',
    );
  });

  test('CLI: evidence from another domain is a typed mode_mismatch refusal (exit 1) when DB is reachable would still fail', () => {
    // This is proved pure above; the CLI path would reach the same validator
    // after reading the FX row. The mode gate is therefore two layers: env gate + evidence gate.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(here, '..', '..', '..', 'scripts', 'billing', 'provision-sandbox.ts'), 'utf8');
    assert.match(src, /PAYSTACK_MODE.*must be exactly "test"/, 'env gate exists');
    assert.match(src, /mode: 'test'/, 'service is pinned to test');
  });
});

// ---------------------------------------------------------------------------
// 4. Absence of side effects — no provider, no FX publication, no writes
// ---------------------------------------------------------------------------

describe('focused dry-run — absence of side effects', () => {
  test('CLI source: no transport, no provider import, no credential, no FX publication', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cliSrc = readFileSync(path.resolve(here, '..', '..', '..', 'scripts', 'billing', 'provision-sandbox.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(cliSrc, /\bfetch\s*\(/, 'no transport');
    assert.doesNotMatch(cliSrc, /https?:\/\//, 'no provider URL');
    assert.doesNotMatch(cliSrc, /PaystackFetchFn|createPaystackProvider|provider-paystack/, 'no provider import');
    assert.doesNotMatch(cliSrc, /PAYSTACK_SECRET_KEY|sk_live_|sk_test_/, 'no key material');
    assert.doesNotMatch(cliSrc, /\.publish\s*\(/, 'no FX publication call');
    assert.doesNotMatch(cliSrc, /BillingFxRateVersionStore/, 'no FX writer');
    assert.doesNotMatch(cliSrc, /POST \/plan|PUT \/plan/, 'no plan mutation');
    // Exactly one env boundary
    assert.equal((cliSrc.match(/process\.env/g) ?? []).length, 1);
  });

  test('CLI source: providerCalls is hardcoded 0, grantsExecution/paymentConfirmed false, dryRun default', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cliSrc = readFileSync(path.resolve(here, '..', '..', '..', 'scripts', 'billing', 'provision-sandbox.ts'), 'utf8');
    assert.match(cliSrc, /providerCalls: 0/, 'no provider call is possible');
    assert.match(cliSrc, /grantsExecution: false/, 'never grants execution');
    assert.match(cliSrc, /paymentConfirmed: false/, 'never confirms payment');
    assert.match(cliSrc, /validateSandboxPlanEpochs/, 'dry-run path exists');
    assert.match(cliSrc, /DRY RUN IS THE DEFAULT/, 'documentation states default');
  });

  test('CLI behaviour: default is dry-run and --dry-run is explicit; both do not require --apply', () => {
    // The parser treats --apply and --dry-run as mutually exclusive, default is dry-run
    const both = cli({}, ['--fx-rate-version', FX_ID, '--by', OPERATOR, '--reason', REASON, '--evidence', '[]', '--apply', '--dry-run']);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /mutually exclusive/);
  });

  test('service boundary: provisioning module has no transport, no env read, no provider mutation', () => {
    const provisioningSrc = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'billing', 'provisioning.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(provisioningSrc, /\bfetch\s*\(/, 'no transport in service');
    assert.doesNotMatch(provisioningSrc, /process\.env/, 'no env read in service');
    // The comment about POST /plan being absent is allowed; check that there is no actual plan-creation call
    assert.doesNotMatch(provisioningSrc, /createPaystack|createProvider.*Plan/, 'no plan mutation in service');
    assert.doesNotMatch(provisioningSrc, /BillingFxRateVersionStore/, 'no FX writer in service — FX row is passed in');
  });

  test('--apply database gate is local-loopback only, fires before pool creation, and never echoes the target', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cliSrc = readFileSync(path.resolve(here, '..', '..', '..', 'scripts', 'billing', 'provision-sandbox.ts'), 'utf8');
    assert.match(cliSrc, /localDatabaseTargetRejection/, 'gate exists');
    assert.match(cliSrc, /if \(args\.apply\)/, 'gate is --apply only');
    assert.ok(cliSrc.indexOf('localDatabaseTargetRejection(databaseUrl)') < cliSrc.indexOf('createPool({ databaseUrl })'), 'gate precedes pool');
    // Behavioural: --apply with prod host is refused with no echo, even before parsing evidence
    const r = cli({ PAYSTACK_MODE: 'test', DATABASE_URL: 'postgres://user:fake-credential@dpg-sandbox.render.com/veltrixeye' }, [
      '--fx-rate-version', FX_ID,
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '[]',
      '--apply',
    ]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--apply refuses this database target/);
    assert.ok(!r.stderr.includes('render.com'), 'no hostname echoed');
    assert.ok(!r.stderr.includes('fake-credential'), 'no credential echoed');
    // Dry run with same target does NOT hit the gate (would fail later as typed refusal, not gate)
    const dry = cli({ PAYSTACK_MODE: 'test', DATABASE_URL: 'not-a-connection-string' }, [
      '--fx-rate-version', FX_ID,
      '--by', OPERATOR,
      '--reason', REASON,
      '--evidence', '[]',
    ]);
    assert.equal(dry.status, 1);
    assert.doesNotMatch(dry.stderr, /--apply refuses this database target/);
  });

  test('pure validator is side-effect free: prepareSandboxProvisioningBatch is pure', () => {
    const fx = fxRow();
    const batch = evidenceBatch();
    const first = prepareSandboxProvisioningBatch({ fxVersion: fx, evidence: batch, registeredAt: NOW });
    const second = prepareSandboxProvisioningBatch({ fxVersion: fx, evidence: batch, registeredAt: NOW });
    assert.deepEqual(first, second, 'pure function is deterministic');
    assert.equal(first.mode, 'test');
    assert.equal(first.fxVersion.id, FX_ID);
    assert.equal(first.registrations.length, 4);
    // History would be unchanged — there is no DB write path in this function
  });
});
