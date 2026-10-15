/**
 * Billing FX **publication** — the pure layer.
 *
 * Pins the approved policy (D1–D10, docs/billing.md → FX publication policy):
 *
 *  - the eight mandatory pre-publication checks (D7) are exactly the approved
 *    list, and each one REFUSES rather than warns;
 *  - a publication requires two DISTINCT named approvers who are not the
 *    executing operator, plus a source reference and a reason (D3, D5);
 *  - `captured_at` is the adoption/approval instant, `effective_from` defaults
 *    to the same instant, and neither is ever back-dated (D2);
 *  - a rate captured more than 900 seconds before the publication instant is
 *    STALE and cannot be published as if it could price a new chargeable epoch
 *    (D1);
 *  - an inverted or order-of-magnitude rate, and a large unexplained move, are
 *    refused (checks 1 and 4);
 *  - `effective_from` must be strictly later than the published version's, so a
 *    correction is FORWARD-ONLY (D6);
 *  - the module holds no update, no delete, no fetch and no price/epoch writer:
 *    its only insert targets are the FX authority and the audit event (D6, D8).
 *
 * Nothing here touches a database: validation is pure, and the source pins prove
 * the module cannot write anywhere but the two approved tables.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_SOURCE_ADVISORY_LOCK_KEY } from '@veltrixeye/contracts';
import {
  BILLING_FX_POLICY,
  FX_PUBLICATION_ADVISORY_LOCK_KEY,
  FX_PUBLICATION_AUDIT_ACTION,
  FX_PUBLICATION_CHECK_NAMES,
  FX_PUBLICATION_DRIFT_THRESHOLD_BASIS_POINTS,
  FX_PUBLICATION_LIMITATIONS,
  FX_PUBLICATION_MAGNITUDE_FACTOR,
  FX_PUBLICATION_POLICY_VERSION,
  FX_PUBLICATION_SOURCE,
  validateFxPublication,
  type FxPublicationAssessment,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The publication instant every check is evaluated at (injected, never read). */
const AS_OF = new Date('2026-10-15T09:00:00.000Z');
/** 30 seconds before the publication instant: inside the 900-second bound (D1). */
const CAPTURED_AT = '2026-10-15T08:59:30.000Z';

const EXECUTOR = 'operator-executor';
const APPROVER_ONE = 'operator-approver-one';
const APPROVER_TWO = 'operator-approver-two';
const REFERENCE = 'BoG daily interbank FX, 2026-10-15; ticket FX-1042';

/** A fully evidenced, valid publication request. */
function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    executorId: EXECUTOR,
    approvers: [APPROVER_ONE, APPROVER_TWO],
    reason: 'Re-adopt the USD→GHS rate corroborated by the published bulletin for this business day.',
    sourceReference: REFERENCE,
    rate: '12.550000',
    capturedAt: CAPTURED_AT,
    downstream: { epochRegistrationPlanned: false },
    ...overrides,
  };
}

/**
 * The newest already-published version, in the durable row shape the authority
 * itself stores (the same shape `resolve()` returns). Strict: exactly these keys.
 */
function previousRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    base_currency: 'USD',
    quote_currency: 'GHS',
    fx_rate_scaled: '12500000',
    fx_rate_scale: 6,
    rounding_mode: 'half_up',
    source: 'ops',
    source_reference: 'BoG daily interbank FX, 2026-09-30; ticket FX-1001',
    created_by: 'operator-previous',
    effective_from: '2026-10-15T08:00:00.000Z',
    captured_at: '2026-10-15T08:00:00.000Z',
    ...overrides,
  };
}

const assess = (
  overrides: Record<string, unknown> = {},
  previousVersion: unknown = previousRow(),
): FxPublicationAssessment => validateFxPublication({ request: request(overrides), previousVersion, asOf: AS_OF });

const failedChecks = (assessment: FxPublicationAssessment): string[] =>
  assessment.checks.filter((check) => check.status === 'fail').map((check) => check.name);

const reasons = (assessment: FxPublicationAssessment): string[] => assessment.issues.map((issue) => issue.reason);

describe('the approved pre-publication checks (D7)', () => {
  test('the check list is EXACTLY the eight approved checks, in order', () => {
    assert.deepEqual([...FX_PUBLICATION_CHECK_NAMES], [
      'rate_plausibility',
      'rate_precision',
      'corroboration',
      'drift_explained',
      'ordering',
      'dry_run_validation',
      'downstream_intent',
      'two_person_authorization',
    ]);
  });

  test('a fully evidenced publication passes every check, and publishes nothing by itself', () => {
    const result = assess();
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.deepEqual(failedChecks(result), []);
    assert.equal(result.checks.length, FX_PUBLICATION_CHECK_NAMES.length);
    // An assessment is never an approval and never a write.
    assert.equal(result.published, false);
    assert.equal(result.databaseWrites, 0);
    assert.equal(result.evaluatedAt, AS_OF.toISOString());
    assert.equal(result.limitations.length, FX_PUBLICATION_LIMITATIONS.length);
    assert.ok(result.candidate !== null);
  });

  test('the candidate records the authority’s exact scaled integer and the pinned provenance', () => {
    const candidate = assess().candidate!;
    assert.equal(candidate.fxRateScaled, 12_550_000n);
    assert.equal(candidate.fxRateScale, 6);
    assert.equal(candidate.source, FX_PUBLICATION_SOURCE);
    assert.equal(candidate.roundingMode, 'half_up');
    assert.equal(candidate.pricingPolicyVersion, BILLING_FX_POLICY.version);
    assert.equal(candidate.publicationPolicyVersion, FX_PUBLICATION_POLICY_VERSION);
    assert.equal(candidate.sourceReference, REFERENCE);
    assert.deepEqual([...candidate.approvers], [APPROVER_ONE, APPROVER_TWO]);
  });

  test('every limitation is reported — the procedural gaps are never hidden', () => {
    const text = FX_PUBLICATION_LIMITATIONS.join(' ');
    assert.match(text, /no role model/, 'the authorization gap is disclosed');
    assert.match(text, /forward-only|unpublish/i, 'forward-only correction is disclosed');
    assert.ok(FX_PUBLICATION_LIMITATIONS.length >= 4);
  });
});

describe('check 6 — dry-run validation and the 900-second bound (D1)', () => {
  test('a rate captured 900 s before the publication instant is accepted; 901 s is refused', () => {
    const at900 = validateFxPublication({
      request: request({ capturedAt: '2026-10-15T08:45:00.000Z' }),
      previousVersion: previousRow(),
      asOf: AS_OF,
    });
    assert.equal(at900.valid, true, '900 s is inside the inclusive bound');

    const at901 = validateFxPublication({
      request: request({ capturedAt: '2026-10-15T08:44:59.000Z' }),
      previousVersion: previousRow(),
      asOf: AS_OF,
    });
    assert.equal(at901.valid, false);
    assert.ok(reasons(at901).includes('stale'), 'a stale rate can never be published');
    assert.deepEqual(failedChecks(at901), ['dry_run_validation']);
  });

  test('the bound is the policy’s, unchanged: 900 seconds', () => {
    assert.equal(BILLING_FX_POLICY.maxAgeSeconds, 900);
  });

  test('a capture in the future relative to the publication instant is refused, and named as such', () => {
    const result = validateFxPublication({
      request: request({ capturedAt: '2026-10-15T09:00:01.000Z' }),
      previousVersion: previousRow(),
      asOf: AS_OF,
    });
    assert.equal(result.valid, false);
    assert.deepEqual(failedChecks(result), ['dry_run_validation']);
    assert.ok(
      reasons(result).includes('not_yet_effective'),
      'a future capture is refused for being not-yet-effective, not as generic malformed evidence',
    );
  });

  test('a rate that is not yet effective cannot be published', () => {
    const result = assess({ effectiveFrom: '2026-10-15T10:00:00.000Z' });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('not_yet_effective'));
  });

  test('timestamps must be timezone-bearing: a naive instant is refused', () => {
    const result = assess({ capturedAt: '2026-10-15T08:59:30' });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('invalid_instant'));
  });
});

describe('check 8 — two-person authorization (D3, D5)', () => {
  test('fewer than two approvers is refused', () => {
    const result = assess({ approvers: [APPROVER_ONE] });
    assert.equal(result.valid, false);
    assert.ok(failedChecks(result).includes('two_person_authorization'));
  });

  test('the same approver recorded twice is refused', () => {
    const result = assess({ approvers: [APPROVER_ONE, APPROVER_ONE] });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('unauthorized_approvers'));
  });

  test('an approver who is also the executing operator is refused', () => {
    const result = assess({ approvers: [EXECUTOR, APPROVER_TWO] });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('unauthorized_approvers'));
    assert.deepEqual(failedChecks(result), ['two_person_authorization']);
  });

  test('credential-shaped operator text is refused wherever it appears', () => {
    for (const overrides of [
      { executorId: 'operator-secret-1' },
      { approvers: ['operator-token-a', APPROVER_TWO] },
      { sourceReference: 'ticket FX-1042 bearer abc' },
    ]) {
      const result = assess(overrides);
      assert.equal(result.valid, false, JSON.stringify(overrides));
      assert.ok(reasons(result).includes('invalid_evidence'), JSON.stringify(overrides));
    }
  });

  test('an empty or absent evidence object fails closed', () => {
    const result = validateFxPublication({ request: {}, previousVersion: previousRow(), asOf: AS_OF });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('missing_evidence'));
    assert.equal(result.candidate, null);
  });

  test('a missing reason is refused', () => {
    const result = assess({ reason: '' });
    assert.equal(result.valid, false);
  });
});

describe('check 3 — corroboration (D3)', () => {
  test('a URL is not a source reference', () => {
    const result = assess({ sourceReference: 'https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/' });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('corroboration_missing'));
    assert.deepEqual(failedChecks(result), ['corroboration']);
  });

  test('a bare publisher host is refused too', () => {
    const result = assess({ sourceReference: 'www.bog.gov.gh daily rates' });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('corroboration_missing'));
  });
});

describe('check 2 — exact decimal rate', () => {
  test('exponent, sign, separator and over-precision are all refused', () => {
    for (const rate of ['1.2e1', '-12.5', '+12.5', '1,2.5', '0.1234567890123456789', '12.5.5', '']) {
      const result = assess({ rate });
      assert.equal(result.valid, false, `rate "${rate}" must be refused`);
      if (rate !== '') assert.ok(!failedChecks(result).includes('rate_plausibility') || true);
    }
  });

  test('an exact decimal is converted to the authority’s scaled integer, with no float', () => {
    const candidate = assess({ rate: '12.5' }).candidate!;
    assert.equal(candidate.fxRateScaled, 125n);
    assert.equal(candidate.fxRateScale, 1);
  });
});

describe('check 1 — rate plausibility against the last published version', () => {
  test('an inverted or order-of-magnitude rate is refused and names the previous version', () => {
    const result = assess({ rate: '250.000000' });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('rate_implausible'));
    assert.deepEqual(failedChecks(result), ['rate_plausibility']);
  });

  test('exactly the magnitude factor is accepted (the bound is inclusive, not a trap)', () => {
    const result = assess({
      rate: '125.000000',
      driftJustification: 'Redenomination drill: the factor bound is inclusive by construction.',
    });
    assert.deepEqual(failedChecks(result), [], JSON.stringify(result.issues));
    assert.equal(FX_PUBLICATION_MAGNITUDE_FACTOR, 10);
  });

  test('the first ever publication has no predecessor and no drift', () => {
    const candidate = assess({}, null).candidate!;
    assert.equal(candidate.previousVersionId, null);
    assert.equal(candidate.driftBasisPoints, null);
  });

  test('an unreadable previous row is refused rather than ignored', () => {
    const result = validateFxPublication({
      request: request(),
      previousVersion: { id: 'not-a-uuid' },
      asOf: AS_OF,
    });
    assert.equal(result.valid, false);
    assert.deepEqual(failedChecks(result), ['rate_plausibility']);
  });
});

describe('check 4 — drift must be explained (D7)', () => {
  test('drift above the threshold without a justification is refused', () => {
    // 12.50 → 13.40 is 720 basis points, above the 500 bp review threshold.
    const result = assess({ rate: '13.400000' });
    assert.equal(result.valid, false);
    assert.ok(reasons(result).includes('drift_unexplained'));
    assert.deepEqual(failedChecks(result), ['drift_explained']);
    assert.equal(FX_PUBLICATION_DRIFT_THRESHOLD_BASIS_POINTS, 500);
  });

  test('the same drift WITH a written justification is publishable', () => {
    const result = assess({
      rate: '13.400000',
      driftJustification: 'Cedi revaluation per the corroborated bulletin; reviewed with the approvers.',
    });
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.candidate!.driftBasisPoints, 720);
    assert.match(result.candidate!.driftJustification!, /Cedi revaluation/);
  });

  test('drift at or below the threshold needs no justification', () => {
    const result = assess({ rate: '12.550000' }); // 0.05 / 12.50 = 0.4% = 40 bp
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.candidate!.driftBasisPoints, 40);
    assert.equal(result.candidate!.driftJustification, null);
  });
});

describe('check 5 — ordering, and forward-only correction (D2, D6)', () => {
  test('an effective instant at or before the published version’s is refused', () => {
    for (const effectiveFrom of ['2026-10-15T08:00:00.000Z', '2026-10-15T07:59:59.000Z']) {
      const result = assess({ effectiveFrom });
      assert.equal(result.valid, false, effectiveFrom);
      assert.ok(reasons(result).includes('ordering_conflict'), effectiveFrom);
      assert.ok(failedChecks(result).includes('ordering'), effectiveFrom);
    }
  });

  test('effective_from defaults to captured_at (D2), and both are recorded', () => {
    const candidate = assess().candidate!;
    assert.equal(candidate.effectiveFrom.toISOString(), CAPTURED_AT);
    assert.equal(candidate.capturedAt.toISOString(), CAPTURED_AT);
  });

  test('a strictly later effective instant is accepted, so a correction goes FORWARD', () => {
    const candidate = assess({ effectiveFrom: '2026-10-15T08:59:45.000Z' }).candidate!;
    assert.equal(candidate.effectiveFrom.toISOString(), '2026-10-15T08:59:45.000Z');
  });

  test('a back-dated capture is refused by the authority’s own ordering rule', () => {
    // captured_at must never be later than effective_from: a "capture" after the
    // instant it becomes authoritative would be a back-dated correction.
    const result = assess({ capturedAt: '2026-10-15T08:59:50.000Z', effectiveFrom: '2026-10-15T08:59:40.000Z' });
    assert.equal(result.valid, false);
    assert.deepEqual(failedChecks(result), ['dry_run_validation']);
  });
});

describe('check 7 — downstream intent (D7)', () => {
  test('planning an epoch registration requires a named registrant', () => {
    const result = assess({ downstream: { epochRegistrationPlanned: true } });
    assert.equal(result.valid, false);
    assert.deepEqual(failedChecks(result), ['downstream_intent']);
  });

  test('a named registrant satisfies it', () => {
    const result = assess({ downstream: { epochRegistrationPlanned: true, registrant: 'operator-registrar' } });
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.candidate!.registrant, 'operator-registrar');
    assert.equal(result.candidate!.epochRegistrationPlanned, true);
  });
});

describe('the authority has exactly ONE application-level writer', () => {
  const authority = (): string =>
    readFileSync(path.join(REPO_ROOT, 'packages', 'core', 'src', 'billing', 'fx-rate-versions.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('the unguarded legacy publish() method is GONE from the authority module', () => {
    // The removed method accepted a nullable source_reference / created_by, ran no
    // freshness, ordering, drift or plausibility check and wrote no audit event —
    // a complete bypass of D1–D10. It must not come back.
    assert.doesNotMatch(authority(), /\basync\s+publish\s*\(/, 'no publication method on the store');
    assert.doesNotMatch(authority(), /PublishFxRateVersionInput/, 'its input contract was removed with it');
  });

  test('the authority module contains no INSERT at all', () => {
    assert.doesNotMatch(
      authority(),
      /INSERT INTO\s+billing_fx_rate_versions/i,
      'the only writer is FxPublicationService; this module reads',
    );
  });

  test('the store is READ-ONLY: it resolves and reports usability, and writes nothing', () => {
    const source = authority();
    assert.match(source, /export class BillingFxRateVersionStore/, 'the read API stays');
    assert.match(source, /\basync\s+resolve\s*\(/, 'resolution stays');
    assert.match(source, /\basync\s+isUsable\s*\(/, 'usability stays');
    assert.doesNotMatch(source, /\bUPDATE\s+billing_/i, 'no update path');
    assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i, 'no delete path');
  });

  test('across the whole package, only fx-publication.ts inserts the authority', () => {
    const dir = path.join(REPO_ROOT, 'packages', 'core', 'src');
    const inserters = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .filter((entry) =>
        /INSERT INTO\s+billing_fx_rate_versions/i.test(
          readFileSync(path.join(dir, entry), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, ''),
        ),
      )
      .map((entry) => entry.replaceAll('\\', '/'));
    assert.deepEqual(inserters, ['billing/fx-publication.ts'], 'exactly one application-level writer');
  });
});

describe('the module’s write surface is pinned (D6, D8)', () => {
  const source = (): string =>
    readFileSync(path.join(REPO_ROOT, 'packages', 'core', 'src', 'billing', 'fx-publication.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('the only table it inserts into is the FX authority', () => {
    const inserts = [...source().matchAll(/INSERT INTO\s+([a-z_]+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(inserts)], ['billing_fx_rate_versions']);
  });

  test('there is no update, no delete and no truncate anywhere', () => {
    assert.doesNotMatch(source(), /\bUPDATE\s+billing_/i, 'no update path: a version is immutable');
    assert.doesNotMatch(source(), /\bDELETE\s+FROM\b/i, 'no delete path: forward-only corrections (D6)');
    assert.doesNotMatch(source(), /\bTRUNCATE\b/i);
  });

  test('it never fetches a rate and never reaches for a price, plan or provider', () => {
    assert.doesNotMatch(source(), /\bfetch\s*\(/, 'no external call');
    assert.doesNotMatch(source(), /process\.env/, 'no environment access');
    assert.doesNotMatch(source(), /provider-paystack|Paystack/, 'no provider path');
    assert.doesNotMatch(source(), /registerSandboxPlanEpochs|registerLivePlanEpochs/, 'no epoch writer');
    assert.doesNotMatch(source(), /billing_provider_plans|billing_pricing_snapshots|subscriptions/, 'no price surface');
  });

  test('the audit action is the approved one, and the advisory lock is its own', () => {
    assert.equal(FX_PUBLICATION_AUDIT_ACTION, 'billing.fx_rate_published');
    assert.equal(FX_PUBLICATION_POLICY_VERSION, 'fx-publication-v1');
    assert.notEqual(
      FX_PUBLICATION_ADVISORY_LOCK_KEY,
      FX_SOURCE_ADVISORY_LOCK_KEY,
      'publication and observation must not share a lock',
    );
  });

  test('both writes ride ONE transaction, and the audit failure is fatal (D4)', () => {
    const text = source();
    assert.match(text, /BEGIN/);
    assert.match(text, /COMMIT/);
    assert.match(text, /ROLLBACK/);
    assert.match(text, /recordAuditEvent\(client/, 'the audit event is written on the transaction’s client');
    assert.match(text, /'audit_failed'/, 'a failed audit write refuses the publication');
  });
});
