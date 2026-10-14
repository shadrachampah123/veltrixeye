/**
 * Billing FX evidence validation (`billing:fx:validate`) — the dry-run-only
 * candidate checker.
 *
 * Pins the safety properties the CLI exists for:
 *  - an internally consistent, fresh candidate VALIDATES, but the decision
 *    stays `need_source` and nothing is approved or published (no
 *    authoritative source has been approved in code or policy);
 *  - exact decimal handling in the existing authority's scaled-integer form
 *    (no float ever interprets a rate);
 *  - missing, blank, malformed, stale, future-dated or ambiguous-timestamp
 *    evidence fails closed with a named issue;
 *  - publication/approval instructions are refused, not ignored;
 *  - the CLI runs with no database configuration at all, proving a dry run
 *    opens no connection and produces no side effect.
 *
 * No database and no network are involved in this suite.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_FX_POLICY,
  FX_VALIDATION_DECISION,
  isBillingFxError,
  parseFxRateDecimal,
  validateFxRateCandidate,
  type FxRateCandidateInput,
} from '../src/index.js';

const AS_OF = '2026-09-22T09:05:00.000Z';

function candidate(overrides: Record<string, unknown> = {}): FxRateCandidateInput & Record<string, unknown> {
  return {
    rate: '12.345678',
    source: 'Example Central Bank daily bulletin',
    fxSource: 'ops',
    sourceReference: 'bulletin-2026-09-22-usd-ghs',
    baseCurrency: 'USD',
    quoteCurrency: 'GHS',
    capturedAt: '2026-09-22T09:00:00.000Z',
    effectiveFrom: '2026-09-22T09:00:00.000Z',
    operator: 'ops@example.com',
    reason: 'Candidate rate presented for dry-run evidence validation',
    ...overrides,
  };
}

const validate = (input: unknown, asOf: string = AS_OF) => validateFxRateCandidate(input, { asOf });

describe('FX validation — a consistent candidate', () => {
  test('validates, yet the decision stays need_source with nothing approved or published', () => {
    const result = validate(candidate());
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.decision, FX_VALIDATION_DECISION);
    assert.equal(result.decision, 'need_source');
    assert.equal(result.approved, false);
    assert.equal(result.published, false);
    assert.equal(result.dryRun, true);
    assert.equal(result.databaseWrites, 0);
    assert.equal(result.externalCalls, 0);
    assert.deepEqual(result.issues, []);
    assert.ok(result.checks.every((check) => check.status === 'pass'));
    // The effective-time conflict limitation is disclosed, never hidden.
    assert.ok(result.limitations.some((text) => /already-published/.test(text)));
  });

  test('normalizes the rate into the authority scaled-integer form, exactly', () => {
    const result = validate(candidate());
    assert.equal(result.candidate?.fxRateScaled, '12345678');
    assert.equal(result.candidate?.fxRateScale, 6);
    assert.equal(result.candidate?.rateDecimal, '12.345678');
    assert.equal(result.candidate?.baseCurrency, 'USD');
    assert.equal(result.candidate?.quoteCurrency, 'GHS');
    assert.equal(result.candidate?.maxAgeSeconds, BILLING_FX_POLICY.maxAgeSeconds);
    assert.equal(result.candidate?.pricingPolicyVersion, BILLING_FX_POLICY.version);
    assert.equal(result.candidate?.ageSeconds, 300);
  });

  test('an unfamiliar source name is validated as evidence but never approved', () => {
    const result = validate(candidate({ source: 'Some Unapproved Feed' }));
    assert.equal(result.valid, true);
    assert.equal(result.decision, 'need_source', 'no source name self-approves');
    assert.equal(result.approved, false);
  });
});

describe('FX validation — exact decimal handling', () => {
  test('parses decimals exactly (string digits to scaled integer, no floats)', () => {
    assert.deepEqual(parseFxRateDecimal('12.500'), { scaled: 12500n, scale: 3 });
    assert.deepEqual(parseFxRateDecimal('0.000001'), { scaled: 1n, scale: 6 });
    assert.deepEqual(parseFxRateDecimal('12'), { scaled: 120n, scale: 1 });
    assert.deepEqual(parseFxRateDecimal(' 12.5 '), { scaled: 125n, scale: 1 });
  });

  test('refuses float-shaped, signed, exponent or imprecise rates', () => {
    for (const rate of ['1.25e1', '-12.5', '+12.5', '12,5', '.5', '12.', '12.5.5', 'NaN', 'Infinity', '0', '0.000', '']) {
      const result = validate(candidate({ rate }));
      assert.equal(result.valid, false, `rate "${rate}" must be refused`);
      assert.equal(result.decision, 'need_source');
    }
    // A JSON number is a float carrier: refused outright, never interpreted.
    assert.equal(validate(candidate({ rate: 12.5 as never })).valid, false);
    // Precision beyond the policy bound (18 fractional digits) is refused.
    assert.equal(validate(candidate({ rate: '12.1234567890123456789' })).valid, false);
    assert.throws(
      () => parseFxRateDecimal('1e2'),
      (error: unknown) => isBillingFxError(error) && error.reason === 'invalid',
    );
  });
});

describe('FX validation — missing and invalid evidence fails closed', () => {
  test('an empty candidate reports the missing evidence and validates nothing', () => {
    const result = validate({});
    assert.equal(result.valid, false);
    assert.equal(result.candidate, null);
    assert.equal(result.decision, 'need_source');
    const fields = new Set(result.issues.map((issue) => issue.field));
    for (const field of ['rate', 'source', 'sourceReference', 'operator', 'reason', 'capturedAt', 'effectiveFrom']) {
      assert.ok(fields.has(field), `missing ${field} is reported`);
    }
  });

  test('each missing or blank required field is a named refusal', () => {
    for (const field of ['rate', 'source', 'fxSource', 'sourceReference', 'baseCurrency', 'quoteCurrency', 'capturedAt', 'effectiveFrom', 'operator', 'reason'] as const) {
      for (const blank of [undefined, '', '   ']) {
        const result = validate(candidate({ [field]: blank }));
        assert.equal(result.valid, false, `${field}=${String(blank)} must fail closed`);
        assert.ok(
          result.issues.some((issue) => issue.field === field && issue.code === 'missing_evidence'),
          `${field} reports missing_evidence`,
        );
      }
    }
  });

  test('wrong currencies and unknown provenance are refused', () => {
    assert.equal(validate(candidate({ baseCurrency: 'EUR' })).issues[0]?.code, 'unsupported_currency');
    assert.equal(validate(candidate({ baseCurrency: 'EUR' })).valid, false);
    assert.equal(validate(candidate({ quoteCurrency: 'USD' })).valid, false);
    assert.equal(validate(candidate({ quoteCurrency: 'NGN' })).valid, false);
    const badSource = validate(candidate({ fxSource: 'central-bank' }));
    assert.equal(badSource.valid, false);
    assert.ok(badSource.issues.some((issue) => issue.field === 'fxSource' && issue.code === 'unsupported_source'));
  });

  test('timestamps must be timezone-bearing, ordered and not yet-effective refused', () => {
    // Naive timestamps are ambiguous and refused, never guessed.
    assert.equal(validate(candidate({ capturedAt: '2026-09-22T09:00:00' })).valid, false);
    assert.equal(validate(candidate({ effectiveFrom: '2026-09-22T09:00:00+00:00', capturedAt: 'not-a-dateZ' })).valid, false);
    // Captured after effective is a back-dated rate (the authority's rule).
    const backdated = validate(candidate({ capturedAt: '2026-09-22T09:04:00.000Z' }));
    assert.equal(backdated.valid, false);
    // A rate that is not yet effective cannot price at the evaluation instant.
    const future = validate(candidate({ effectiveFrom: '2026-09-22T09:10:00.000Z', capturedAt: '2026-09-22T09:04:00.000Z' }));
    assert.equal(future.valid, false);
    assert.ok(future.issues.some((issue) => issue.code === 'not_yet_effective'));
  });
});

describe('FX validation — freshness (the existing 15-minute policy bound)', () => {
  test('a capture exactly at the maximum age validates; one second older is stale', () => {
    const atBound = validate(
      candidate({ capturedAt: '2026-09-22T08:50:00.000Z', effectiveFrom: '2026-09-22T08:50:00.000Z' }),
    );
    assert.equal(atBound.valid, true, JSON.stringify(atBound.issues));
    assert.equal(atBound.candidate?.ageSeconds, BILLING_FX_POLICY.maxAgeSeconds);

    const stale = validate(
      candidate({ capturedAt: '2026-09-22T08:49:59.000Z', effectiveFrom: '2026-09-22T08:49:59.000Z' }),
    );
    assert.equal(stale.valid, false);
    assert.ok(stale.issues.some((issue) => issue.code === 'stale'));
    assert.equal(stale.checks.find((check) => check.name === 'freshness')?.status, 'fail');
    assert.equal(stale.decision, 'need_source');
  });

  test('a capture in the future relative to the evaluation instant is refused', () => {
    const result = validate(
      candidate({ capturedAt: '2026-09-22T09:06:00.000Z', effectiveFrom: '2026-09-22T09:06:00.000Z' }),
    );
    assert.equal(result.valid, false);
  });
});

describe('FX validation — publication and approval are prohibited', () => {
  test('publication/approval flags on the candidate are refused, not ignored', () => {
    for (const flag of ['publish', 'published', 'approve', 'approved', 'apply', 'confirm', 'write', 'register', 'live']) {
      const result = validate(candidate({ [flag]: true }));
      assert.equal(result.valid, false, `--${flag} must be refused`);
      assert.ok(result.issues.some((issue) => issue.code === 'prohibited_flag'));
      assert.equal(result.published, false);
      assert.equal(result.approved, false);
      assert.equal(result.checks.find((check) => check.name === 'publication_guard')?.status, 'fail');
    }
  });
});

/* ========================================================================== */
/* The operator CLI, end to end                                               */
/* ========================================================================== */

describe('FX validation — the operator CLI (scripts/billing/fx-validate.ts)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');

  /** Run the CLI exactly as an operator would, with NO database configured. */
  function cli(args: readonly string[]) {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.PAYSTACK_MODE;
    return spawnSync('node', ['--import', 'tsx', 'scripts/billing/fx-validate.ts', ...args], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
  }

  const validArgs = [
    '--dry-run',
    '--rate', '12.345678',
    '--source', 'Example Central Bank daily bulletin',
    '--fx-source', 'ops',
    '--source-reference', 'bulletin-2026-09-22-usd-ghs',
    '--base-currency', 'USD',
    '--quote-currency', 'GHS',
    '--captured-at', '2026-09-22T09:00:00.000Z',
    '--effective-from', '2026-09-22T09:00:00.000Z',
    '--by', 'ops@example.com',
    '--reason', 'Candidate rate presented for dry-run evidence validation',
    '--as-of', AS_OF,
  ];

  test('a valid dry run exits 0, reports need_source and publishes nothing', () => {
    const result = cli(validArgs);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.outcome, 'validated');
    assert.equal(output.decision, 'need_source');
    assert.equal(output.published, false);
    assert.equal(output.approved, false);
    assert.equal(output.databaseWrites, 0);
    assert.equal(output.externalCalls, 0);
  });

  test('the documented command with no evidence fails closed', () => {
    const result = cli(['--dry-run']);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout) as { decision: string; issues: unknown[] };
    assert.equal(output.decision, 'need_source');
    assert.ok(output.issues.length > 0);
  });

  test('stale evidence is refused by the CLI', () => {
    const staleArgs = validArgs.map((value) =>
      value === '2026-09-22T09:00:00.000Z' ? '2026-09-22T08:00:00.000Z' : value,
    );
    const result = cli(staleArgs);
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout) as { issues: { code: string }[] };
    assert.ok(output.issues.some((issue) => issue.code === 'stale'));
  });

  test('publication flags are rejected by the CLI', () => {
    for (const flag of ['--publish', '--approve', '--apply']) {
      const result = cli([...validArgs, flag]);
      assert.equal(result.status, 1, `${flag} must be rejected`);
      const output = JSON.parse(result.stdout) as { published: boolean; issues: { code: string }[] };
      assert.equal(output.published, false);
      assert.ok(output.issues.some((issue) => issue.code === 'prohibited_flag'));
    }
  });

  test('a run without --dry-run is refused as a usage error', () => {
    const result = cli(validArgs.filter((value) => value !== '--dry-run'));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--dry-run is required/);
  });

  test('the CLI is side-effect free by construction (source pinning)', () => {
    const source = readFileSync(path.join(repoRoot, 'scripts', 'billing', 'fx-validate.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /createPool|DATABASE_URL/, 'no database access');
    assert.doesNotMatch(source, /\bfetch\s*\(/, 'no external call');
    assert.doesNotMatch(source, /process\.env/, 'no environment or settings access');
    assert.doesNotMatch(source, /\.publish\s*\(|BillingFxRateVersionStore/, 'no publication path');
    assert.doesNotMatch(source, /provider-paystack|Paystack/, 'no provider access after comments are stripped'.replace(' after comments are stripped', ''));
  });
});
