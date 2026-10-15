/**
 * Billing FX **source observations** — the pure half.
 *
 * Pins the safety properties the feature exists for:
 *  - an observation is normalized from EXACT decimals (no float ever touches a
 *    published figure), with all legs rescaled to ONE scale;
 *  - an incoherent, unparseable, unrecognised or future-dated published row is
 *    refused with a named issue and produces NO observation — never a
 *    "roughly usable" one;
 *  - the dedup identity is over WHAT was published (publisher, pair, date,
 *    figures), not over when it was fetched, so re-reading a publication cannot
 *    create a second observation while a corrected republication of the same
 *    date is preserved;
 *  - the staleness report derives its limits (never/fresh/warning/stale) and
 *    states, derived rather than hardcoded, that a business-daily publisher can
 *    never satisfy the 900 s pricing bound;
 *  - the decision is ALWAYS `need_source`: observing a rate is not approving it,
 *    and no code path here can publish, approve or price.
 *
 * No database and no network are involved in this suite.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FX_SOURCE_BANK_OF_GHANA,
  FX_SOURCE_BANK_OF_GHANA_URL,
} from '@veltrixeye/contracts';
import {
  BILLING_FX_POLICY,
  FX_SOURCE_APPROVED_URLS,
  FX_SOURCE_OBSERVATION_POLICY as CORE_POLICY,
  analyzeFxSourceObservations,
  fxSourceObservationKey,
  parsePublishedOn,
  subtractScaled,
  summarizeFxSourceObservation,
  validateFxSourceRow,
  type FxSourceObservation,
  type FxSourceObservationValidation,
  type FxSourceRowTexts,
  type FxSourceRetrievalInput,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const RETRIEVED_AT = new Date('2026-10-15T09:30:00.000Z');
const BODY_DIGEST = 'a'.repeat(64);
const ROW_DIGEST = 'b'.repeat(64);

/**
 * The Bank of Ghana's published figures for 14 Oct 2026 (buying 11.6692, selling
 * 11.6808, mid 11.6750), as the reader extracts them.
 */
function publishedRow(overrides: Partial<FxSourceRowTexts> = {}): FxSourceRowTexts {
  return {
    publishedOnText: '14 Oct 2026',
    currencyText: 'US Dollar',
    pairText: 'USDGHS',
    buyingText: '11.6692',
    sellingText: '11.6808',
    midText: '11.6750',
    ...overrides,
  };
}

function retrieval(overrides: Partial<FxSourceRetrievalInput> = {}): FxSourceRetrievalInput {
  return {
    sourceId: FX_SOURCE_BANK_OF_GHANA,
    sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
    retrievedAt: RETRIEVED_AT,
    bodyDigest: BODY_DIGEST,
    rowDigest: ROW_DIGEST,
    row: publishedRow(),
    ...overrides,
  };
}

const validate = (input: unknown) => validateFxSourceRow(input, { retrievedBy: 'scheduler' });

function expectValid(input: unknown): FxSourceObservation {
  const result = validate(input);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.notEqual(result.observation, null);
  return result.observation!;
}

function expectRefusal(inputOrResult: unknown, code: string, field?: string) {
  // Accepts either a raw input (validated here) or an already-validated result,
  // so a test can assert against a validator call made with explicit options.
  const result =
    inputOrResult !== null && typeof inputOrResult === 'object' && 'issues' in inputOrResult
      ? (inputOrResult as FxSourceObservationValidation)
      : validate(inputOrResult);
  assert.equal(result.valid, false, 'must fail closed');
  assert.equal(result.observation, null, 'a refused row produces no observation');
  assert.equal(result.decision, 'need_source');
  const issue = result.issues.find((entry) => entry.code === code && (field === undefined || entry.field === field));
  assert.ok(
    issue,
    `expected an issue ${code}${field ? ` on ${field}` : ''}; got ${JSON.stringify(result.issues)}`,
  );
  return result;
}

describe('observation validation — a consistent published row', () => {
  test('normalizes exact decimals at one scale, with nothing approved or published', () => {
    const observation = expectValid(retrieval());

    assert.equal(observation.sourceId, 'bank_of_ghana');
    assert.equal(observation.baseCurrency, 'USD');
    assert.equal(observation.quoteCurrency, 'GHS');
    assert.equal(observation.publishedOn, '2026-10-14');
    assert.equal(observation.rateScale, 4);
    assert.equal(observation.buyingScaled, 116_692n);
    assert.equal(observation.sellingScaled, 116_808n);
    assert.equal(observation.midRateScaled, 116_750n);
    assert.equal(observation.midRateDecimal, '11.6750');
    assert.equal(observation.retrievedAt.toISOString(), RETRIEVED_AT.toISOString());

    const result = validate(retrieval());
    assert.equal(result.decision, 'need_source');
    assert.match(result.decisionReason, /not approving it/);
    // The limitation that a digest proves the read, not the publisher's
    // correctness, is disclosed on every result.
    assert.ok(result.limitations.some((text) => /proves WHAT was read/.test(text)));
    assert.ok(result.limitations.some((text) => /900 s/.test(text)));
  });

  test('legs published at different precisions are rescaled to ONE common scale, exactly', () => {
    const observation = expectValid(
      retrieval({ row: publishedRow({ buyingText: '11.6', sellingText: '11.6808', midText: '11.675' }) }),
    );
    assert.equal(observation.rateScale, 4);
    assert.equal(observation.buyingScaled, 116_000n);
    assert.equal(observation.midRateScaled, 116_750n);
    // The published decimal strings are kept verbatim as evidence.
    assert.equal(observation.buyingDecimal, '11.6');
    assert.equal(observation.midRateDecimal, '11.675');
  });

  test('the other accepted publication-date form is understood too', () => {
    const observation = expectValid(retrieval({ row: publishedRow({ publishedOnText: 'Oct 14, 2026' }) }));
    assert.equal(observation.publishedOn, '2026-10-14');
  });

  test('the decision can never be anything but need_source', () => {
    for (const input of [retrieval(), retrieval({ sourceId: 'someone_else' }), null, {}]) {
      assert.equal(validate(input).decision, 'need_source');
    }
  });
});

describe('observation validation — refusals', () => {
  test('an unapproved source id or URL is refused (a publisher is approved in code)', () => {
    expectRefusal(retrieval({ sourceId: 'reuters' }), 'unsupported_source', 'sourceId');
    expectRefusal(
      retrieval({ sourceUrl: 'https://mirror.example.com/bog-daily-rates' }),
      'unsupported_source',
      'sourceUrl',
    );
    // The approved URL map is closed and matches the schema's CHECK literal.
    assert.deepEqual({ ...FX_SOURCE_APPROVED_URLS }, { bank_of_ghana: FX_SOURCE_BANK_OF_GHANA_URL });
    const migration = readFileSync(
      path.join(
        REPO_ROOT,
        'packages',
        'core',
        'src',
        'db',
        'migrations',
        '0038_billing_fx_source_observations.sql',
      ),
      'utf8',
    );
    assert.ok(
      migration.includes(`source_url = '${FX_SOURCE_BANK_OF_GHANA_URL}'`),
      'the database CHECK must pin the same approved URL as the code',
    );
    assert.ok(
      migration.includes(`source_id IN ('bank_of_ghana')`),
      'the database CHECK must pin the same approved source vocabulary as the code',
    );
  });

  test('evidence cannot be optional: digests, retrieval instant and attribution are required', () => {
    expectRefusal(retrieval({ bodyDigest: '' }), 'invalid', 'bodyDigest');
    expectRefusal(retrieval({ bodyDigest: 'ABC' }), 'invalid', 'bodyDigest');
    expectRefusal(retrieval({ rowDigest: 'z'.repeat(64) }), 'invalid', 'rowDigest');
    expectRefusal(retrieval({ retrievedAt: new Date('nope') }), 'invalid', 'retrievedAt');
    expectRefusal(
      validateFxSourceRow(retrieval(), { retrievedBy: '' }),
      'missing_evidence',
      'retrievedBy',
    );
    expectRefusal(
      validateFxSourceRow(retrieval(), { retrievedBy: 'scheduler-with-a-token' }),
      'credential_shaped',
      'retrievedBy',
    );
    expectRefusal(
      validateFxSourceRow(retrieval(), { retrievedBy: 'x'.repeat(65) }),
      'missing_evidence',
      'retrievedBy',
    );
  });

  test('the currency pair and the currency label must both name USD→GHS', () => {
    expectRefusal(retrieval({ row: publishedRow({ pairText: 'EURGHS' }) }), 'unsupported_currency', 'pairText');
    expectRefusal(
      retrieval({ row: publishedRow({ currencyText: 'Pound Sterling' }) }),
      'unsupported_currency',
      'currencyText',
    );
  });

  test('the publication date must be an unambiguous, plausible day', () => {
    for (const publishedOnText of ['18/09/2026', '2026-09-18', 'Sep 2026', '32 Sep 2026', '18 Foo 2026', '']) {
      expectRefusal(retrieval({ row: publishedRow({ publishedOnText }) }), 'unparseable', 'publishedOnText');
    }
  });

  test('a publication date after the retrieval instant is refused (no tolerance)', () => {
    expectRefusal(
      retrieval({ row: publishedRow({ publishedOnText: '16 Oct 2026' }) }),
      'invalid',
      'publishedOnText',
    );
    // The same day as the retrieval is fine.
    expectValid(retrieval({ row: publishedRow({ publishedOnText: '15 Oct 2026' }) }));
  });

  test('only exact decimals are accepted: no exponent, sign, separator or over-precision', () => {
    for (const midText of ['1.1e1', '-11.675', '11,675', '.675', '11.6750000000000000000000', 'abc', '']) {
      const result = validate(retrieval({ row: publishedRow({ midText }) }));
      assert.equal(result.valid, false, `"${midText}" must be refused`);
      assert.equal(result.observation, null);
      assert.ok(result.issues.some((issue) => issue.field === 'midText'));
    }
  });

  test('an incoherent published row is refused: buying ≤ mid ≤ selling', () => {
    expectRefusal(
      retrieval({ row: publishedRow({ buyingText: '11.7000', midText: '11.6750' }) }),
      'incoherent',
      'buyingText',
    );
    expectRefusal(
      retrieval({ row: publishedRow({ sellingText: '11.6000', midText: '11.6750' }) }),
      'incoherent',
      'sellingText',
    );
    // Buying == mid == selling is coherent (no spread), and is accepted.
    const flat = expectValid(
      retrieval({ row: publishedRow({ buyingText: '11.6750', sellingText: '11.6750' }) }),
    );
    assert.equal(flat.midRateScaled, flat.buyingScaled);
  });

  test('a malformed or empty input is refused rather than defaulted', () => {
    for (const input of [null, undefined, 'USDGHS', 42, []]) {
      const result = validate(input);
      assert.equal(result.valid, false);
      assert.equal(result.observation, null);
    }
  });
});

describe('dedup identity', () => {
  test('is over WHAT was published, not when it was read', () => {
    const first = expectValid(retrieval());
    const second = expectValid(retrieval({ retrievedAt: new Date('2026-10-15T21:00:00.000Z') }));
    assert.equal(first.observationKey, second.observationKey, 're-reading a publication is a duplicate');
    assert.match(first.observationKey, /^[0-9a-f]{64}$/);
  });

  test('changes when any published figure, the day or the pair changes', () => {
    const base = expectValid(retrieval());
    for (const row of [
      publishedRow({ midText: '11.6751' }),
      publishedRow({ buyingText: '11.6693' }),
      publishedRow({ sellingText: '11.6809' }),
      publishedRow({ publishedOnText: '13 Oct 2026' }),
    ]) {
      const other = expectValid(retrieval({ row }));
      assert.notEqual(other.observationKey, base.observationKey, JSON.stringify(row));
    }
  });

  test('the raw digest key helper is deterministic and order-independent of inputs', () => {
    const identity = {
      sourceId: 'bank_of_ghana',
      baseCurrency: 'USD',
      quoteCurrency: 'GHS',
      publishedOn: '2026-10-14',
      buyingScaled: 116_692n,
      sellingScaled: 116_808n,
      midRateScaled: 116_750n,
      rateScale: 4,
    };
    assert.equal(fxSourceObservationKey(identity), fxSourceObservationKey({ ...identity }));
    assert.notEqual(fxSourceObservationKey(identity), fxSourceObservationKey({ ...identity, rateScale: 6 }));
  });
});

describe('staleness report', () => {
  const observationAt = (publishedOn: string, retrievedAt: string): FxSourceObservation => {
    const result = validateFxSourceRow(
      retrieval({
        retrievedAt: new Date(retrievedAt),
        row: publishedRow({
          publishedOnText: `${publishedOn.split('-')[2]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(publishedOn.split('-')[1]) - 1]} ${publishedOn.split('-')[0]}`,
        }),
      }),
      { retrievedBy: 'scheduler' },
    );
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    return result.observation!;
  };

  test('no observations at all is `never` — a truthful state, never a green one', () => {
    const report = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [],
      asOf: RETRIEVED_AT,
    });
    assert.equal(report.state, 'never');
    assert.equal(report.observed, false);
    assert.equal(report.latest, null);
    assert.equal(report.ageSeconds, null);
    assert.equal(report.changed, null);
    assert.equal(report.midChangeDecimal, null);
    assert.equal(report.decision, 'need_source');
  });

  test('fresh, warning and stale follow the published thresholds exactly', () => {
    const asOf = new Date('2026-10-20T00:00:00.000Z'); // publication date 2026-10-14
    const observation = observationAt('2026-10-14', '2026-10-14T17:00:00.000Z');
    const report = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [observation],
      asOf,
    });

    assert.equal(report.ageSeconds, 6 * 24 * 60 * 60);
    assert.equal(report.warningAfterSeconds, 2 * 24 * 60 * 60);
    assert.equal(report.staleAfterSeconds, 4 * 24 * 60 * 60);
    assert.equal(report.state, 'stale');

    const atWarningEdge = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [observation],
      asOf: new Date('2026-10-16T00:00:00.000Z'),
    });
    assert.equal(atWarningEdge.ageSeconds, 2 * 24 * 60 * 60);
    assert.equal(atWarningEdge.state, 'warning');

    const beforeWarning = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [observation],
      asOf: new Date('2026-10-15T23:59:59.000Z'),
    });
    assert.equal(beforeWarning.state, 'fresh');

    const atStaleEdge = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [observation],
      asOf: new Date('2026-10-18T00:00:00.000Z'),
    });
    assert.equal(atStaleEdge.state, 'stale');
  });

  test('the newest publication wins regardless of input order, and the previous is reported', () => {
    const older = observationAt('2026-10-13', '2026-10-13T17:00:00.000Z');
    const newer = observationAt('2026-10-14', '2026-10-14T17:00:00.000Z');

    const forward = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [older, newer],
      asOf: new Date('2026-10-15T00:00:00.000Z'),
    });
    const reversed = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [newer, older],
      asOf: new Date('2026-10-15T00:00:00.000Z'),
    });
    assert.deepEqual(forward, reversed);
    assert.equal(forward.latest?.publishedOn, '2026-10-14');
    assert.equal(forward.previous?.publishedOn, '2026-10-13');
    assert.equal(forward.changed, false, 'identical figures on consecutive days: no change');
    assert.equal(forward.midChangeDecimal, '0.0000');
    assert.equal(forward.observationsRetained, 2);
  });

  test('a changed mid rate is reported as an exact decimal difference, never a float', () => {
    const yesterdays = validateFxSourceRow(
      retrieval({
        retrievedAt: new Date('2026-10-13T17:00:00.000Z'),
        row: publishedRow({ publishedOnText: '13 Oct 2026', buyingText: '11.7000', sellingText: '11.7118', midText: '11.7059' }),
      }),
      { retrievedBy: 'scheduler' },
    ).observation!;
    const todays = validateFxSourceRow(
      retrieval({
        retrievedAt: new Date('2026-10-14T17:00:00.000Z'),
        row: publishedRow({ publishedOnText: '14 Oct 2026', buyingText: '11.6692', sellingText: '11.6808', midText: '11.6750' }),
      }),
      { retrievedBy: 'scheduler' },
    ).observation!;

    const report = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [yesterdays, todays],
      asOf: new Date('2026-10-15T00:00:00.000Z'),
    });
    assert.equal(report.changed, true);
    assert.equal(report.midChangeDecimal, '-0.0309');
    assert.equal(report.observationsRetained, 2);
  });

  test('the pricing bound is DERIVED, and a business-daily publisher can never satisfy it', () => {
    const report = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [],
      asOf: RETRIEVED_AT,
    });
    assert.equal(report.pricingPolicySatisfiable, false);
    assert.equal(report.pricingMaxAgeSeconds, BILLING_FX_POLICY.maxAgeSeconds);
    assert.equal(report.pricingMaxAgeSeconds, 900);
    assert.equal(report.pricingPolicyVersion, BILLING_FX_POLICY.version);
    assert.equal(report.publicationIntervalSeconds, CORE_POLICY.publicationIntervalSeconds);
    assert.match(report.pricingPolicyReason, /900s old/);
    assert.match(report.pricingPolicyReason, /never price a payment/);

    // The derivation is real, not a hardcoded false: with a hypothetical policy
    // whose bound covers the publication interval, it flips to true.
    const satisfied = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [],
      asOf: RETRIEVED_AT,
      pricingPolicy: { ...BILLING_FX_POLICY, maxAgeSeconds: 24 * 60 * 60 },
    });
    assert.equal(satisfied.pricingPolicySatisfiable, true);
    assert.match(satisfied.pricingPolicyReason, /approved operator decision/);
  });

  test('the summary carries no bigint and no internal object', () => {
    const observation = expectValid(retrieval());
    const summary = summarizeFxSourceObservation(observation);
    const json = JSON.stringify(summary);
    assert.equal(json.includes('116750'), false, 'scaled integers are not exposed in the summary');
    assert.equal(summary.midRateDecimal, '11.6750');
    assert.equal(summary.retrievedBy, 'scheduler');
  });

  test('an invalid `asOf` yields no age rather than a fictional one', () => {
    const observation = expectValid(retrieval());
    const report = analyzeFxSourceObservations({
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      observations: [observation],
      asOf: new Date('nope'),
    });
    assert.equal(report.ageSeconds, null);
    assert.equal(report.state, 'never');
  });
});

describe('exact decimal arithmetic', () => {
  test('subtractScaled is exact for positive, negative, zero and integer scales', () => {
    assert.equal(subtractScaled(116_750n, 117_059n, 4), '-0.0309');
    assert.equal(subtractScaled(117_059n, 116_750n, 4), '0.0309');
    assert.equal(subtractScaled(116_750n, 116_750n, 4), '0.0000');
    assert.equal(subtractScaled(1n, 0n, 0), '1');
    assert.equal(subtractScaled(0n, 1n, 0), '-1');
    assert.equal(subtractScaled(10n, 9n, 1), '0.1');
  });

  test('parsePublishedOn accepts only the two unambiguous forms', () => {
    assert.equal(parsePublishedOn('18 Sep 2026'), '2026-09-18');
    assert.equal(parsePublishedOn('1 Sep 2026'), '2026-09-01');
    assert.equal(parsePublishedOn('Sep 18, 2026'), '2026-09-18');
    assert.equal(parsePublishedOn('September 18, 2026'), '2026-09-18');
    for (const text of ['31 Feb 2026', '18 SeptXXX 2026', '2026-09-18', '18/09/2026', '', 'today']) {
      assert.equal(parsePublishedOn(text), null, text);
    }
  });
});

describe('the module cannot reach the pricing authority', () => {
  test('no fetch, no publication, no rate-version store and no price anywhere in the module', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'packages', 'core', 'src', 'billing', 'fx-source-observations.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    assert.doesNotMatch(source, /\bfetch\s*\(/, 'no external call: the transport is injected');
    assert.doesNotMatch(source, /BillingFxRateVersionStore/, 'no handle on the FX rate authority');
    assert.doesNotMatch(source, /\.publish\s*\(/, 'no publication path');
    assert.doesNotMatch(source, /process\.env/, 'no environment access');
    assert.doesNotMatch(source, /catalogue|Paystack|provider_plans|epoch/i, 'no pricing or provider path');
    // The only table it writes is its own.
    const tables = [...source.matchAll(/(?:INSERT INTO|FROM|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual([...new Set(tables)], ['billing_fx_source_observations']);
    assert.equal(
      CORE_POLICY.staleAfterSeconds > CORE_POLICY.warningAfterSeconds,
      true,
      'the stale bound is looser than the warning bound, so the order is fresh → warning → stale',
    );
    assert.equal(CORE_POLICY.warningAfterSeconds >= CORE_POLICY.publicationIntervalSeconds, true);
  });
});
