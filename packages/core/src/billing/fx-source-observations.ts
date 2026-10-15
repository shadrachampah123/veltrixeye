import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import {
  FX_SOURCE_ADVISORY_LOCK_KEY,
  FX_SOURCE_BANK_OF_GHANA_URL,
  FX_SOURCE_BASE_CURRENCY,
  FX_SOURCE_IDS,
  FX_SOURCE_QUOTE_CURRENCY,
  type FxSourceFailureReason,
  type FxSourceId,
  type FxSourceRetrievalOutcome,
  type FxSourceStalenessState,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import {
  BILLING_FX_POLICY,
  type BillingFxPolicy,
} from './fx-rate-versions.js';
import { parseFxRateDecimal } from './fx-validation.js';

/**
 * Billing FX **source observations** — read-only monitoring of an external
 * publisher, deliberately OUTSIDE the pricing authority.
 *
 * WHY THIS EXISTS. The platform prices in GHS from an operator-published USD→GHS
 * rate version (migration 0032). Nothing in the platform may fetch a rate: a
 * fetched number that silently becomes a price would be an unaudited, unreviewed
 * authority. This module is the opposite arrangement — it observes what an
 * approved publisher published, records it immutably, and reports how old and
 * how consistent it is, so an operator can make an informed approval decision.
 *
 * THE SEPARATION IS STRUCTURAL, NOT A CONVENTION:
 *  * An observation lives in its own append-only table
 *    (`billing_fx_source_observations`) with NO foreign key to
 *    `billing_fx_rate_versions` and no path that writes one.
 *  * This module holds NO reference to `BillingFxRateVersionStore`, calls no
 *    `publish()` and exposes no publish/approve/apply option. Publication stays
 *    the separate, approved operation it already is (`billing:fx:validate`
 *    keeps every candidate at `need_source`), and every result this module
 *    returns carries the decision `need_source` as a literal.
 *  * Prices, Paystack plans, epochs and the catalogue are never read or written
 *    here, and the observation layer is not consulted by the pricing path.
 *
 * WHAT IT VALIDATES, AND WHAT IT CANNOT. Validation here is *internal
 * consistency and provenance*: exact decimals (no float ever touches a figure),
 * a supported currency pair, coherence (buying ≤ mid ≤ selling), a plausible
 * publisher date, and coherent retrieval timestamps. It cannot establish that a
 * published figure is *correct* — the digest proves what was read, not that the
 * publisher's number is right, and that limitation is reported on every result.
 *
 * THE PRICING BOUND IS NOT SATISFIABLE BY THIS SOURCE, and the report says so
 * explicitly rather than implying a daily bulletin can produce a "fresh" price:
 * `BILLING_FX_POLICY.maxAgeSeconds` is 900 s while a central bank publishes once
 * per business day, so `pricingPolicySatisfiable` is derived as `false`.
 * Reconciling that gap — if it is ever reconcilable — is an approved policy
 * decision, not something this module may do on its own.
 *
 * Callers inject the time (`asOf`) and a retrieval function. Nothing here reads
 * a clock implicitly or opens a socket: the transport lives in a provider
 * package and is passed in as a plain function.
 */

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export const FX_SOURCE_OBSERVATION_POLICY_VERSION = 'fx-source-observation-v1' as const;

export interface FxSourceObservationPolicy {
  readonly version: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  /** Precision bound for a published figure (the pricing authority's bound). */
  readonly maxRateScale: number;
  /**
   * How often the publisher is known to publish, in seconds. This is the basis
   * for `pricingPolicySatisfiable` below — it is a fact about the publisher
   * (business-daily), not a preference.
   */
  readonly publicationIntervalSeconds: number;
  /** Age (since the publisher's own date) at which an observation warns. */
  readonly warningAfterSeconds: number;
  /** Age at which an observation is stale. Covers a weekend plus a holiday. */
  readonly staleAfterSeconds: number;
  /** Bound on the `retrievedBy` label. */
  readonly maxRetrievedByLength: number;
}

export const FX_SOURCE_OBSERVATION_POLICY: FxSourceObservationPolicy = Object.freeze({
  version: FX_SOURCE_OBSERVATION_POLICY_VERSION,
  baseCurrency: FX_SOURCE_BASE_CURRENCY,
  quoteCurrency: FX_SOURCE_QUOTE_CURRENCY,
  maxRateScale: BILLING_FX_POLICY.maxScale,
  publicationIntervalSeconds: 24 * 60 * 60,
  warningAfterSeconds: 2 * 24 * 60 * 60,
  staleAfterSeconds: 4 * 24 * 60 * 60,
  maxRetrievedByLength: 64,
});

/**
 * The approved publisher URL for a source id. A closed map: an observation whose
 * `sourceUrl` is not the approved URL for its source id is refused, and the
 * database CHECK pins the same literal.
 */
export const FX_SOURCE_APPROVED_URLS: Readonly<Record<FxSourceId, string>> = Object.freeze({
  bank_of_ghana: FX_SOURCE_BANK_OF_GHANA_URL,
});

/** Why the decision can never move past `need_source` from inside this module. */
export const FX_SOURCE_DECISION_REASON =
  'Observing a published rate is not approving it. Publishing an authoritative billing FX ' +
  'rate version remains a separate, operator-approved operation; an observation can confirm at ' +
  'most that a named publisher published these exact figures at a known instant, so the ' +
  'decision stays need_source.';

/** Limitations reported on every check (never hidden, never softened). */
export const FX_SOURCE_LIMITATIONS: readonly string[] = Object.freeze([
  'An observation never prices a payment: it is not read by the pricing path and carries no ' +
    'authority. Publishing a rate version that could price a payment stays a separate, ' +
    'operator-approved operation.',
  'A content digest proves WHAT was read and when, not that the publisher’s figure is correct. ' +
    'The truth of a published rate is the publisher’s; corroborating it is an operator decision.',
  'The pricing policy bound (900 s) and a business-daily publisher are incompatible: an ' +
    'observation from this source can never be ‘fresh’ in the pricing sense. Changing that ' +
    'bound would be an approved policy change and is not attempted here.',
]);

/* -------------------------------------------------------------------------- */
/* Normalized observation                                                     */
/* -------------------------------------------------------------------------- */

/** Exact scaled figures sharing ONE scale (see `normalizeRow`). */
export interface FxSourceObservation {
  readonly sourceId: FxSourceId;
  /** Deterministic dedup identity — see `fxSourceObservationKey`. */
  readonly observationKey: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  /** The publisher's own date, as `YYYY-MM-DD`. */
  readonly publishedOn: string;
  readonly buyingScaled: bigint;
  readonly sellingScaled: bigint;
  readonly midRateScaled: bigint;
  /** The common scale all three figures are expressed at. */
  readonly rateScale: number;
  /** The figures as published (canonical exact decimal strings). */
  readonly buyingDecimal: string;
  readonly sellingDecimal: string;
  readonly midRateDecimal: string;
  /** SHA-256 of the retrieved page. */
  readonly bodyDigest: string;
  /** SHA-256 of the normalized published row. */
  readonly rowDigest: string;
  readonly sourceUrl: string;
  readonly retrievedAt: Date;
  /** Who performed the retrieval (`scheduler`, `worker`, an operator label). */
  readonly retrievedBy: string;
}

/** The raw, uninterpreted cells a retrieval produced (provider-independent). */
export interface FxSourceRowTexts {
  readonly publishedOnText: string;
  readonly currencyText: string;
  readonly pairText: string;
  readonly buyingText: string;
  readonly sellingText: string;
  readonly midText: string;
}

export interface FxSourceRetrievalInput {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly retrievedAt: Date;
  readonly bodyDigest: string;
  readonly rowDigest: string;
  readonly row: FxSourceRowTexts;
}

/** The provider result core consumes (structurally satisfied by the provider). */
export type FxSourceRetrieval =
  | {
      readonly outcome: 'retrieved';
      readonly sourceId: string;
      readonly sourceUrl: string;
      readonly retrievedAt: Date;
      readonly bodyDigest: string;
      readonly rowDigest: string;
      readonly row: FxSourceRowTexts;
    }
  | {
      readonly outcome: 'unavailable' | 'unparseable';
      readonly sourceId: string;
      readonly sourceUrl: string;
      readonly retrievedAt: Date;
      readonly status: number | null;
      readonly reason: FxSourceFailureReason;
      readonly detail: string;
      readonly bodyDigest: string | null;
    };

/** The seam the API composes: a read-only retrieval of the approved publisher. */
export interface FxSourceRetriever {
  readonly sourceId: string;
  readonly sourceUrl: string;
  retrieve(): Promise<FxSourceRetrieval>;
}

/* -------------------------------------------------------------------------- */
/* Validation (pure)                                                          */
/* -------------------------------------------------------------------------- */

export type FxSourceValidationIssueCode =
  | 'invalid'
  | 'unsupported_source'
  | 'unsupported_currency'
  | 'unparseable'
  | 'incoherent'
  | 'missing_evidence'
  | 'credential_shaped';

export interface FxSourceValidationIssue {
  readonly field: string;
  readonly code: FxSourceValidationIssueCode;
  readonly message: string;
}

export interface FxSourceObservationValidation {
  readonly valid: boolean;
  readonly issues: readonly FxSourceValidationIssue[];
  readonly observation: FxSourceObservation | null;
  readonly decision: 'need_source';
  readonly decisionReason: string;
  readonly limitations: readonly string[];
}

const HEX_64 = /^[0-9a-f]{64}$/;
const CREDENTIAL_SHAPE =
  /(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)/i;

const MONTHS: readonly string[] = Object.freeze([
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]);

/** `DD Mon YYYY` (the publisher's documented form) or `Mon DD, YYYY`. */
const DATE_DMY = /^([0-9]{1,2})\s+([A-Za-z]{3})[a-z]*\s+([0-9]{4})$/;
const DATE_MDY = /^([A-Za-z]{3})[a-z]*\s+([0-9]{1,2}),?\s+([0-9]{4})$/;

/**
 * Parse the publisher's date cell deterministically. Only the two unambiguous
 * English forms are accepted; anything else (a numeric locale order, an
 * ISO string the publisher does not use, a relative label) is refused rather
 * than guessed, because "which day was this rate for?" is not a question to
 * answer approximately.
 */
export function parsePublishedOn(text: string): string | null {
  const value = text.trim();

  const dmy = DATE_DMY.exec(value);
  if (dmy !== null) {
    const month = MONTHS.indexOf((dmy[2] ?? '').toLowerCase());
    if (month < 0) return null;
    return isoDate(Number.parseInt(dmy[3]!, 10), month + 1, Number.parseInt(dmy[1]!, 10));
  }

  const mdy = DATE_MDY.exec(value);
  if (mdy !== null) {
    const month = MONTHS.indexOf((mdy[1] ?? '').toLowerCase());
    if (month < 0) return null;
    return isoDate(Number.parseInt(mdy[3]!, 10), month + 1, Number.parseInt(mdy[2]!, 10));
  }

  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** UTC midnight of a `YYYY-MM-DD` date, or `null` when malformed. */
function publishedOnInstant(publishedOn: string): Date | null {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(publishedOn);
  if (match === null) return null;
  const iso = isoDate(
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  );
  if (iso === null) return null;
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * Deterministic dedup identity of an observation.
 *
 * Keyed on WHAT was published (publisher, pair, publication date, the three
 * figures and the scale) — never on when we fetched it. Two checks that read
 * the same publication therefore collapse to one row, while a corrected
 * republication of the same date with different figures is a genuinely new row
 * and is preserved: the history of what was published is never overwritten.
 */
export function fxSourceObservationKey(identity: {
  sourceId: string;
  baseCurrency: string;
  quoteCurrency: string;
  publishedOn: string;
  buyingScaled: bigint;
  sellingScaled: bigint;
  midRateScaled: bigint;
  rateScale: number;
}): string {
  return createHash('sha256')
    .update(
      [
        identity.sourceId,
        identity.baseCurrency,
        identity.quoteCurrency,
        identity.publishedOn,
        identity.buyingScaled.toString(),
        identity.sellingScaled.toString(),
        identity.midRateScaled.toString(),
        String(identity.rateScale),
      ].join('|'),
      'utf8',
    )
    .digest('hex');
}

/**
 * Validate one retrieved row and normalize it into an observation.
 *
 * Pure and deterministic: no I/O, no clock, no environment. Problems are
 * REPORTED in `issues` (never thrown, never defaulted) — an incoherent or
 * unrecognised row produces no observation at all, because the alternative
 * (recording something roughly usable) is how an unapproved number becomes a
 * price later.
 *
 * The `decision` is `need_source` in every outcome.
 */
export function validateFxSourceRow(
  input: unknown,
  options?: { policy?: FxSourceObservationPolicy; retrievedBy?: string },
): FxSourceObservationValidation {
  const policy = options?.policy ?? FX_SOURCE_OBSERVATION_POLICY;
  const retrievedBy = options?.retrievedBy ?? 'scheduler';
  const issues: FxSourceValidationIssue[] = [];

  const record =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  if (record === null) {
    return refuse([{ field: 'input', code: 'missing_evidence', message: 'A retrieval result is required; an empty input fails closed.' }]);
  }

  const sourceId = typeof record.sourceId === 'string' ? record.sourceId : '';
  const sourceUrl = typeof record.sourceUrl === 'string' ? record.sourceUrl : '';
  const retrievedAt = record.retrievedAt instanceof Date ? record.retrievedAt : null;
  const bodyDigest = typeof record.bodyDigest === 'string' ? record.bodyDigest : '';
  const rowDigest = typeof record.rowDigest === 'string' ? record.rowDigest : '';
  const row =
    record.row !== null && typeof record.row === 'object' && !Array.isArray(record.row)
      ? (record.row as Record<string, unknown>)
      : null;

  if (!(FX_SOURCE_IDS as readonly string[]).includes(sourceId)) {
    issues.push({
      field: 'sourceId',
      code: 'unsupported_source',
      message: `Unknown FX source "${sourceId}" (approved: ${FX_SOURCE_IDS.join(', ')}). A publisher is approved in code, never supplied at runtime.`,
    });
  } else if (FX_SOURCE_APPROVED_URLS[sourceId as FxSourceId] !== sourceUrl) {
    issues.push({
      field: 'sourceUrl',
      code: 'unsupported_source',
      message: `Source "${sourceId}" must be read from its approved URL; "${sourceUrl}" is not it.`,
    });
  }

  if (retrievedAt === null || !Number.isFinite(retrievedAt.getTime())) {
    issues.push({
      field: 'retrievedAt',
      code: 'invalid',
      message: 'A finite retrieval instant is required; an observation without one cannot be placed in time.',
    });
  }

  for (const [field, value] of [
    ['bodyDigest', bodyDigest],
    ['rowDigest', rowDigest],
  ] as const) {
    if (!HEX_64.test(value)) {
      issues.push({
        field,
        code: 'invalid',
        message: `${field} must be a lowercase SHA-256 hex digest; the evidence of what was read cannot be optional.`,
      });
    }
  }

  if (retrievedBy.trim() === '' || retrievedBy.length > policy.maxRetrievedByLength) {
    issues.push({
      field: 'retrievedBy',
      code: 'missing_evidence',
      message: `The retrieval label must be between 1 and ${policy.maxRetrievedByLength} characters so a retrieval is attributable.`,
    });
  } else if (CREDENTIAL_SHAPE.test(retrievedBy)) {
    issues.push({
      field: 'retrievedBy',
      code: 'credential_shaped',
      message: 'The retrieval label is credential-shaped; no credential material may be recorded on an observation.',
    });
  }

  if (row === null) {
    issues.push({ field: 'row', code: 'missing_evidence', message: 'The published row texts are required.' });
  }

  let publishedOn: string | null = null;
  let buying: { scaled: bigint; scale: number } | null = null;
  let selling: { scaled: bigint; scale: number } | null = null;
  let mid: { scaled: bigint; scale: number } | null = null;

  if (row !== null) {
    const text = (field: string): string => (typeof row[field] === 'string' ? (row[field] as string).trim() : '');

    const pairText = text('pairText').replace(/\s+/g, '').toUpperCase();
    if (pairText !== `${policy.baseCurrency}${policy.quoteCurrency}`) {
      issues.push({
        field: 'pairText',
        code: 'unsupported_currency',
        message: `The published row is pair "${pairText}"; only ${policy.baseCurrency}→${policy.quoteCurrency} can be observed for billing.`,
      });
    }

    const currencyText = text('currencyText').toLowerCase();
    if (!(currencyText.includes('usd') || currencyText.includes('dollar'))) {
      issues.push({
        field: 'currencyText',
        code: 'unsupported_currency',
        message: `The published row is labelled "${text('currencyText')}", which does not name the US dollar.`,
      });
    }

    const publishedOnText = text('publishedOnText');
    publishedOn = parsePublishedOn(publishedOnText);
    if (publishedOn === null) {
      issues.push({
        field: 'publishedOnText',
        code: 'unparseable',
        message:
          `The publication date "${publishedOnText}" is not one of the accepted unambiguous forms ` +
          '(e.g. "18 Sep 2026"); the day a rate belongs to is never approximated.',
      });
    }

    for (const [field, key] of [
      ['buyingText', 'buying'],
      ['sellingText', 'selling'],
      ['midText', 'mid'],
    ] as const) {
      const value = text(field);
      try {
        const parsed = parseFxRateDecimal(value);
        if (parsed.scale > policy.maxRateScale) {
          issues.push({
            field,
            code: 'invalid',
            message: `The published figure "${value}" carries ${parsed.scale} fractional digits; the policy allows at most ${policy.maxRateScale}.`,
          });
          continue;
        }
        if (key === 'buying') buying = parsed;
        else if (key === 'selling') selling = parsed;
        else mid = parsed;
      } catch (error) {
        issues.push({
          field,
          code: 'invalid',
          message: error instanceof Error ? error.message : `The published figure "${value}" is not an exact decimal.`,
        });
      }
    }
  }

  if (publishedOn !== null && retrievedAt !== null) {
    const publishedInstant = publishedOnInstant(publishedOn);
    if (publishedInstant === null) {
      issues.push({ field: 'publishedOnText', code: 'invalid', message: 'The publication date could not be placed in time.' });
    } else if (publishedInstant.getTime() > retrievedAt.getTime()) {
      // Strict, with no tolerance: the publisher's date is a UTC calendar day and
      // the publisher sits in UTC+0, so a date after the retrieval instant means
      // the page (or our clock) is wrong. Refusing to record it is the safe
      // direction, and the refusal is reported rather than hidden.
      issues.push({
        field: 'publishedOnText',
        code: 'invalid',
        message: `The publication date ${publishedOn} is after the retrieval instant ${retrievedAt.toISOString()}; a page cannot publish a future day’s rate.`,
      });
    }
  }

  let buyingScaled: bigint | null = null;
  let sellingScaled: bigint | null = null;
  let midRateScaled: bigint | null = null;
  let rateScale = 0;

  if (buying !== null && selling !== null && mid !== null) {
    rateScale = Math.max(buying.scale, selling.scale, mid.scale);
    const rescale = (value: { scaled: bigint; scale: number }): bigint =>
      value.scale === rateScale ? value.scaled : value.scaled * 10n ** BigInt(rateScale - value.scale);
    buyingScaled = rescale(buying);
    sellingScaled = rescale(selling);
    midRateScaled = rescale(mid);

    if (buyingScaled > midRateScaled) {
      issues.push({
        field: 'buyingText',
        code: 'incoherent',
        message: `The published buying figure (${buyingScaled} @ ${rateScale}) exceeds the mid rate (${midRateScaled} @ ${rateScale}); an incoherent row is not recorded.`,
      });
    }
    if (midRateScaled > sellingScaled) {
      issues.push({
        field: 'sellingText',
        code: 'incoherent',
        message: `The published mid rate (${midRateScaled} @ ${rateScale}) exceeds the selling figure (${sellingScaled} @ ${rateScale}); an incoherent row is not recorded.`,
      });
    }
  }

  const valid = issues.length === 0;
  if (!valid) return refuse(issues);

  const observation: FxSourceObservation = {
    sourceId: sourceId as FxSourceId,
    observationKey: fxSourceObservationKey({
      sourceId,
      baseCurrency: policy.baseCurrency,
      quoteCurrency: policy.quoteCurrency,
      publishedOn: publishedOn!,
      buyingScaled: buyingScaled!,
      sellingScaled: sellingScaled!,
      midRateScaled: midRateScaled!,
      rateScale,
    }),
    baseCurrency: policy.baseCurrency,
    quoteCurrency: policy.quoteCurrency,
    publishedOn: publishedOn!,
    buyingScaled: buyingScaled!,
    sellingScaled: sellingScaled!,
    midRateScaled: midRateScaled!,
    rateScale,
    buyingDecimal: (row!.buyingText as string).trim(),
    sellingDecimal: (row!.sellingText as string).trim(),
    midRateDecimal: (row!.midText as string).trim(),
    bodyDigest,
    rowDigest,
    sourceUrl,
    retrievedAt: retrievedAt!,
    retrievedBy,
  };

  return {
    valid: true,
    issues: [],
    observation,
    decision: 'need_source',
    decisionReason: FX_SOURCE_DECISION_REASON,
    limitations: FX_SOURCE_LIMITATIONS,
  };
}

function refuse(issues: FxSourceValidationIssue[]): FxSourceObservationValidation {
  return {
    valid: false,
    issues,
    observation: null,
    decision: 'need_source',
    decisionReason: FX_SOURCE_DECISION_REASON,
    limitations: FX_SOURCE_LIMITATIONS,
  };
}

/* -------------------------------------------------------------------------- */
/* Staleness (pure)                                                          */
/* -------------------------------------------------------------------------- */

export interface FxSourceObservationSummary {
  readonly observationKey: string;
  readonly publishedOn: string;
  readonly midRateDecimal: string;
  readonly buyingDecimal: string;
  readonly sellingDecimal: string;
  readonly rateScale: number;
  readonly retrievedAt: string;
  readonly bodyDigest: string;
  readonly rowDigest: string;
  readonly retrievedBy: string;
}

export interface FxSourceStalenessReport {
  readonly sourceId: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  /** `never` before the first successful observation — never a green state. */
  readonly state: FxSourceStalenessState;
  readonly observed: boolean;
  readonly latest: FxSourceObservationSummary | null;
  readonly previous: FxSourceObservationSummary | null;
  /** Age of the newest observation's publication date at `asOf`, in seconds. */
  readonly ageSeconds: number | null;
  readonly warningAfterSeconds: number;
  readonly staleAfterSeconds: number;
  /** Observations retained for this source (bounded read window). */
  readonly observationsRetained: number;
  /** True when the newest figures differ from the previous observation's. */
  readonly changed: boolean | null;
  /** Exact decimal change of the mid rate vs the previous observation. */
  readonly midChangeDecimal: string | null;
  readonly publicationIntervalSeconds: number;
  readonly pricingPolicyVersion: string;
  readonly pricingMaxAgeSeconds: number;
  /**
   * Whether a fresh-enough rate COULD come from this source under the current
   * pricing policy. Derived (never hardcoded) and `false` for a business-daily
   * publisher: the pricing bound is 900 s.
   */
  readonly pricingPolicySatisfiable: boolean;
  readonly pricingPolicyReason: string;
  readonly decision: 'need_source';
  readonly decisionReason: string;
  readonly limitations: readonly string[];
}

/** Serialize an observation for a report (no bigint leaks into JSON). */
export function summarizeFxSourceObservation(
  observation: FxSourceObservation,
): FxSourceObservationSummary {
  return {
    observationKey: observation.observationKey,
    publishedOn: observation.publishedOn,
    midRateDecimal: observation.midRateDecimal,
    buyingDecimal: observation.buyingDecimal,
    sellingDecimal: observation.sellingDecimal,
    rateScale: observation.rateScale,
    retrievedAt: observation.retrievedAt.toISOString(),
    bodyDigest: observation.bodyDigest,
    rowDigest: observation.rowDigest,
    retrievedBy: observation.retrievedBy,
  };
}

/** Exact decimal difference of two scaled integers sharing a scale. */
export function subtractScaled(a: bigint, b: bigint, scale: number): string {
  const difference = a - b;
  const negative = difference < 0n;
  const magnitude = negative ? -difference : difference;
  if (scale <= 0) return `${negative ? '-' : ''}${magnitude.toString()}`;
  const digits = magnitude.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Derive the staleness report for a source from its observed history.
 *
 * Pure and deterministic. `observations` may arrive in any order; the newest is
 * chosen by (publication date, then retrieval instant), and a tie in figures is
 * impossible because the dedup key collapses it.
 */
export function analyzeFxSourceObservations(params: {
  sourceId: string;
  observations: readonly FxSourceObservation[];
  asOf: Date;
  policy?: FxSourceObservationPolicy;
  pricingPolicy?: BillingFxPolicy;
  /** How many observations were read (may exceed `observations.length`). */
  observationsRetained?: number;
}): FxSourceStalenessReport {
  const policy = params.policy ?? FX_SOURCE_OBSERVATION_POLICY;
  const pricingPolicy = params.pricingPolicy ?? BILLING_FX_POLICY;
  const asOfMs = params.asOf.getTime();

  const ordered = [...params.observations].sort((left, right) => {
    if (left.publishedOn !== right.publishedOn) {
      return left.publishedOn < right.publishedOn ? 1 : -1;
    }
    return right.retrievedAt.getTime() - left.retrievedAt.getTime();
  });

  const [newest, previous] = ordered;
  const latestInstant = newest === undefined ? null : publishedOnInstant(newest.publishedOn);
  const ageSeconds =
    latestInstant === null || !Number.isFinite(asOfMs)
      ? null
      : Math.floor((asOfMs - latestInstant.getTime()) / 1000);

  let state: FxSourceStalenessState = 'never';
  if (newest !== undefined && ageSeconds !== null) {
    if (ageSeconds >= policy.staleAfterSeconds) state = 'stale';
    else if (ageSeconds >= policy.warningAfterSeconds) state = 'warning';
    else state = 'fresh';
  }

  const changed =
    newest === undefined || previous === undefined
      ? null
      : newest.midRateScaled !== previous.midRateScaled ||
        newest.buyingScaled !== previous.buyingScaled ||
        newest.sellingScaled !== previous.sellingScaled;

  const midChangeDecimal =
    newest === undefined || previous === undefined
      ? null
      : newest.rateScale === previous.rateScale
        ? subtractScaled(newest.midRateScaled, previous.midRateScaled, newest.rateScale)
        : null;

  const satisfiable = pricingPolicy.maxAgeSeconds >= policy.publicationIntervalSeconds;

  return {
    sourceId: params.sourceId,
    baseCurrency: policy.baseCurrency,
    quoteCurrency: policy.quoteCurrency,
    state,
    observed: newest !== undefined,
    latest: newest === undefined ? null : summarizeFxSourceObservation(newest),
    previous: previous === undefined ? null : summarizeFxSourceObservation(previous),
    ageSeconds,
    warningAfterSeconds: policy.warningAfterSeconds,
    staleAfterSeconds: policy.staleAfterSeconds,
    observationsRetained: params.observationsRetained ?? params.observations.length,
    changed,
    midChangeDecimal,
    publicationIntervalSeconds: policy.publicationIntervalSeconds,
    pricingPolicyVersion: pricingPolicy.version,
    pricingMaxAgeSeconds: pricingPolicy.maxAgeSeconds,
    pricingPolicySatisfiable: satisfiable,
    pricingPolicyReason: satisfiable
      ? 'The pricing policy bound is at least as long as the publisher’s interval, so an observation could in principle satisfy it. Publishing still requires an approved operator decision.'
      : `The pricing policy allows a rate at most ${pricingPolicy.maxAgeSeconds}s old, while this publisher publishes every ${policy.publicationIntervalSeconds}s. No observation from this source can ever satisfy the pricing bound, so it can only inform an operator decision — never price a payment.`,
    decision: 'need_source',
    decisionReason: FX_SOURCE_DECISION_REASON,
    limitations: FX_SOURCE_LIMITATIONS,
  };
}

/* -------------------------------------------------------------------------- */
/* Durable store (append-only, deduplicated)                                  */
/* -------------------------------------------------------------------------- */

const scaledInteger = z.union([
  z.bigint(),
  z.string().regex(/^[0-9]+$/, 'a scaled integer must be an unsigned integer string'),
  z.number().int().safe(),
]);

const timestamp = z.union([z.date(), z.string().datetime()]).transform((value) => new Date(value));

/**
 * The publisher's day, normalized to `YYYY-MM-DD`.
 *
 * `pg` parses a `date` column into a `Date` at LOCAL midnight, so the calendar
 * day is recovered from the local components — projecting it through
 * `toISOString()` would shift the day for any server not running in UTC, which
 * would silently re-date a published figure.
 */
const publishedOnDate = z
  .union([z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/), z.string().datetime(), z.date()])
  .transform((value) => {
    if (typeof value === 'string') return value.slice(0, 10);
    const pad = (part: number, width: number) => String(part).padStart(width, '0');
    return `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1, 2)}-${pad(value.getDate(), 2)}`;
  });

export const fxSourceObservationRowSchema = z
  .object({
    id: z.string().uuid(),
    source_id: z.string(),
    observation_key: z.string().regex(HEX_64),
    base_currency: z.string(),
    quote_currency: z.string(),
    published_on: publishedOnDate,
    buying_scaled: scaledInteger.transform((value) => BigInt(value)),
    selling_scaled: scaledInteger.transform((value) => BigInt(value)),
    mid_rate_scaled: scaledInteger.transform((value) => BigInt(value)),
    rate_scale: z.number().int(),
    buying_decimal: z.string(),
    selling_decimal: z.string(),
    mid_rate_decimal: z.string(),
    body_digest: z.string().regex(HEX_64),
    row_digest: z.string().regex(HEX_64),
    source_url: z.string(),
    retrieved_at: timestamp,
    retrieved_by: z.string(),
    created_at: timestamp.optional(),
  })
  .strict();

export type FxSourceObservationRow = z.infer<typeof fxSourceObservationRowSchema>;

/** The stored row plus its durable identity. */
export interface StoredFxSourceObservation {
  readonly id: string;
  readonly observation: FxSourceObservation;
  readonly createdAt: Date | null;
}

function parseObservationRow(row: unknown): StoredFxSourceObservation {
  const parsed = fxSourceObservationRowSchema.safeParse(row);
  if (!parsed.success) {
    throw Errors.internal(
      `A stored FX source observation is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const value = parsed.data;
  const publishedOn = value.published_on;
  return {
    id: value.id,
    createdAt: value.created_at ?? null,
    observation: {
      sourceId: value.source_id as FxSourceId,
      observationKey: value.observation_key,
      baseCurrency: value.base_currency,
      quoteCurrency: value.quote_currency,
      publishedOn,
      buyingScaled: value.buying_scaled,
      sellingScaled: value.selling_scaled,
      midRateScaled: value.mid_rate_scaled,
      rateScale: value.rate_scale,
      buyingDecimal: value.buying_decimal,
      sellingDecimal: value.selling_decimal,
      midRateDecimal: value.mid_rate_decimal,
      bodyDigest: value.body_digest,
      rowDigest: value.row_digest,
      sourceUrl: value.source_url,
      retrievedAt: value.retrieved_at,
      retrievedBy: value.retrieved_by,
    },
  };
}

/**
 * Postgres-backed store for source observations.
 *
 * `record()` APPENDS. There is no update path and no delete path — by
 * construction here and by trigger in migration 0038 — so an observation cannot
 * be edited, re-dated or removed. Recording the same publication twice is
 * recognized as a duplicate by the deterministic observation key and inserts
 * nothing, which is what makes a scheduler that runs too often harmless.
 */
export class BillingFxSourceObservationStore {
  constructor(private readonly db: Pool) {}

  /**
   * Record one observation. Returns `duplicate` (and the existing row) when this
   * exact publication has already been observed.
   */
  async record(observation: FxSourceObservation): Promise<{
    status: 'recorded' | 'duplicate';
    stored: StoredFxSourceObservation;
  }> {
    const { rows } = await this.db.query(
      `INSERT INTO billing_fx_source_observations
         (source_id, observation_key, base_currency, quote_currency, published_on,
          buying_scaled, selling_scaled, mid_rate_scaled, rate_scale,
          buying_decimal, selling_decimal, mid_rate_decimal,
          body_digest, row_digest, source_url, retrieved_at, retrieved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (source_id, observation_key) DO NOTHING
       RETURNING *`,
      [
        observation.sourceId,
        observation.observationKey,
        observation.baseCurrency,
        observation.quoteCurrency,
        observation.publishedOn,
        observation.buyingScaled.toString(),
        observation.sellingScaled.toString(),
        observation.midRateScaled.toString(),
        observation.rateScale,
        observation.buyingDecimal,
        observation.sellingDecimal,
        observation.midRateDecimal,
        observation.bodyDigest,
        observation.rowDigest,
        observation.sourceUrl,
        observation.retrievedAt,
        observation.retrievedBy,
      ],
    );

    if (rows.length > 0) {
      return { status: 'recorded', stored: parseObservationRow(rows[0]) };
    }

    const existing = await this.db.query(
      `SELECT * FROM billing_fx_source_observations
        WHERE source_id = $1 AND observation_key = $2`,
      [observation.sourceId, observation.observationKey],
    );
    if (existing.rows.length === 0) {
      throw Errors.internal(
        'The FX source observation could not be recorded, and no existing observation explains why.',
      );
    }
    return { status: 'duplicate', stored: parseObservationRow(existing.rows[0]) };
  }

  /** The newest observation for a source, or `null` when none exists yet. */
  async latest(sourceId: string): Promise<StoredFxSourceObservation | null> {
    const { rows } = await this.db.query(
      `SELECT * FROM billing_fx_source_observations
        WHERE source_id = $1
        ORDER BY published_on DESC, retrieved_at DESC
        LIMIT 1`,
      [sourceId],
    );
    return rows.length === 0 ? null : parseObservationRow(rows[0]);
  }

  /**
   * The most recent observations for a source, newest publication first. Bounded
   * by `limit` so a report read can never grow with history.
   */
  async listRecent(sourceId: string, limit = 2): Promise<StoredFxSourceObservation[]> {
    const bounded = Math.max(1, Math.min(50, Math.trunc(limit)));
    const { rows } = await this.db.query(
      `SELECT * FROM billing_fx_source_observations
        WHERE source_id = $1
        ORDER BY published_on DESC, retrieved_at DESC
        LIMIT $2`,
      [sourceId, bounded],
    );
    return rows.map((row) => parseObservationRow(row));
  }

  /** How many observations are retained for a source (a bounded count). */
  async count(sourceId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM billing_fx_source_observations WHERE source_id = $1`,
      [sourceId],
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }
}

/* -------------------------------------------------------------------------- */
/* Check service (overlap-safe, read-only, never publishing)                  */
/* -------------------------------------------------------------------------- */

export type FxSourceRecordStatus = 'recorded' | 'duplicate' | 'not_attempted';

export interface FxSourceCheckResult {
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly checkedAt: string;
  /** True when another check held the lock: nothing was fetched or written. */
  readonly overlapSkipped: boolean;
  readonly retrieval: {
    readonly outcome: FxSourceRetrievalOutcome | 'not_attempted';
    readonly reason: FxSourceFailureReason | null;
    readonly status: number | null;
    readonly detail: string | null;
    readonly bodyDigest: string | null;
    readonly rowDigest: string | null;
  };
  readonly validation: { readonly valid: boolean; readonly issues: readonly FxSourceValidationIssue[] } | null;
  readonly record: { readonly status: FxSourceRecordStatus; readonly observationId: string | null };
  readonly report: FxSourceStalenessReport;
  readonly decision: 'need_source';
  readonly decisionReason: string;
  readonly published: false;
  readonly approved: false;
  /** Rows written by this check (0 when nothing was recorded). */
  readonly databaseWrites: number;
  readonly limitations: readonly string[];
}

export interface FxSourceCheckOptions {
  /** Attribution for the retrieval (`scheduler` by default). */
  retrievedBy?: string;
  /** Injected instant (defaults to the process clock at call time). */
  asOf?: Date;
}

export interface FxSourceObservationServiceOptions {
  /** Injected clock (deterministic tests; defaults to real time). */
  clock?: () => Date;
  /** Advisory lock key (defaults to the pinned `FX_SOURCE_ADVISORY_LOCK_KEY`). */
  lockKey?: number;
  policy?: FxSourceObservationPolicy;
  pricingPolicy?: BillingFxPolicy;
  /** Bounded logger — receives short strings only, never a body or a secret. */
  logger?: { info(message: string): void; warn(message: string): void };
}

/**
 * Runs ONE observation check: overlap guard, retrieve, validate, record, report.
 *
 * INVARIANTS (each pinned by a test):
 *  * It never publishes, never approves and never prices: it holds no FX rate
 *    version store, exposes no publish option and writes only to
 *    `billing_fx_source_observations`.
 *  * Overlap protection is a PostgreSQL advisory lock, so an in-process ticker
 *    and an external scheduler (or two instances) cannot fetch or write
 *    concurrently. A check that cannot take the lock does NOT fetch: overlapping
 *    retrieval would spend the publisher's goodwill for no new information.
 *  * A failed or unrecognised retrieval writes nothing and is REPORTED — a
 *    broken source must not look like an unchanged one.
 */
export class FxSourceObservationService {
  private readonly store: BillingFxSourceObservationStore;
  private readonly clock: () => Date;
  private readonly lockKey: number;
  private readonly policy: FxSourceObservationPolicy;
  private readonly pricingPolicy: BillingFxPolicy;
  private readonly logger: { info(message: string): void; warn(message: string): void };

  constructor(
    private readonly pool: Pool,
    private readonly retriever: FxSourceRetriever,
    options: FxSourceObservationServiceOptions = {},
  ) {
    this.store = new BillingFxSourceObservationStore(pool);
    this.clock = options.clock ?? (() => new Date());
    this.lockKey = options.lockKey ?? FX_SOURCE_ADVISORY_LOCK_KEY;
    this.policy = options.policy ?? FX_SOURCE_OBSERVATION_POLICY;
    this.pricingPolicy = options.pricingPolicy ?? BILLING_FX_POLICY;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
  }

  /** The staleness report alone (read-only, opens no lock and fetches nothing). */
  async report(asOf?: Date): Promise<FxSourceStalenessReport> {
    const at = asOf ?? this.clock();
    const [recent, retained] = await Promise.all([
      this.store.listRecent(this.retriever.sourceId, 2),
      this.store.count(this.retriever.sourceId),
    ]);
    return analyzeFxSourceObservations({
      sourceId: this.retriever.sourceId,
      observations: recent.map((entry) => entry.observation),
      asOf: at,
      policy: this.policy,
      pricingPolicy: this.pricingPolicy,
      observationsRetained: retained,
    });
  }

  async runCheck(options: FxSourceCheckOptions = {}): Promise<FxSourceCheckResult> {
    const asOf = options.asOf ?? this.clock();
    const retrievedBy = options.retrievedBy ?? 'scheduler';

    const lockClient = await this.acquireLockClient();
    if (lockClient === null) {
      return this.overlapResult(asOf, 'The observation check could not open a database session for the overlap guard; nothing was fetched or written.');
    }

    let acquired = false;
    let destroyLockClient = false;
    try {
      acquired = await this.tryLock(lockClient);
      if (!acquired) {
        this.logger.info('fx source check skipped: another check holds the observation lock');
        return this.overlapResult(asOf, 'Another FX source observation check held the lock; overlapping retrieval is refused.');
      }

      return await this.runCheckLocked(asOf, retrievedBy);
    } finally {
      if (acquired) {
        const released = await this.releaseLock(lockClient);
        // A session-scoped lock left behind would block every FUTURE check, so a
        // session that cannot prove it released is destroyed, not pooled.
        destroyLockClient = !released;
      }
      if (destroyLockClient) {
        if (typeof (lockClient as { end?: unknown }).end === 'function') {
          await (lockClient as unknown as { end: () => Promise<void> }).end().catch(() => {});
        }
        lockClient.release(true);
      } else {
        lockClient.release();
      }
    }
  }

  private async acquireLockClient(): Promise<PoolClient | null> {
    try {
      return await this.pool.connect();
    } catch (error) {
      this.logger.warn('fx source check: could not connect for the observation lock');
      void error;
      return null;
    }
  }

  private async tryLock(client: PoolClient): Promise<boolean> {
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [this.lockKey],
      );
      return result.rows[0]?.acquired ?? false;
    } catch {
      return false;
    }
  }

  private async releaseLock(client: PoolClient): Promise<boolean> {
    try {
      const result = await client.query<{ unlocked?: boolean; pg_advisory_unlock?: boolean }>(
        'SELECT pg_advisory_unlock($1) AS unlocked',
        [this.lockKey],
      );
      const row = result.rows[0];
      const unlocked =
        typeof row?.unlocked === 'boolean'
          ? row.unlocked
          : typeof row?.pg_advisory_unlock === 'boolean'
            ? row.pg_advisory_unlock
            : false;
      if (!unlocked) {
        this.logger.warn('fx source check: the observation lock was not confirmed released; evicting the session');
      }
      return unlocked;
    } catch {
      this.logger.warn('fx source check: releasing the observation lock failed; evicting the session');
      return false;
    }
  }

  private async runCheckLocked(asOf: Date, retrievedBy: string): Promise<FxSourceCheckResult> {
    let retrieval: FxSourceRetrieval;
    try {
      retrieval = await this.retriever.retrieve();
    } catch {
      // The transport is expected to return a typed outcome; a throw is still a
      // reported failure, never a silent one and never a rate.
      retrieval = {
        outcome: 'unavailable',
        sourceId: this.retriever.sourceId,
        sourceUrl: this.retriever.sourceUrl,
        retrievedAt: this.clock(),
        status: null,
        reason: 'network',
        detail: 'The source reader failed before producing an outcome; nothing was recorded.',
        bodyDigest: null,
      };
    }

    if (retrieval.outcome !== 'retrieved') {
      this.logger.warn(`fx source check: retrieval ${retrieval.outcome} (${retrieval.reason})`);
      return {
        ...(await this.baseResult(asOf, 'not_attempted', null)),
        retrieval: {
          outcome: retrieval.outcome,
          reason: retrieval.reason,
          status: retrieval.status,
          detail: retrieval.detail,
          bodyDigest: retrieval.bodyDigest,
          rowDigest: null,
        },
      };
    }

    const validation = validateFxSourceRow(retrieval, { policy: this.policy, retrievedBy });
    if (!validation.valid || validation.observation === null) {
      this.logger.warn('fx source check: the retrieved row did not validate; nothing was recorded');
      return {
        ...(await this.baseResult(asOf, 'not_attempted', validation)),
        retrieval: {
          outcome: 'retrieved',
          reason: null,
          status: null,
          detail: null,
          bodyDigest: retrieval.bodyDigest,
          rowDigest: retrieval.rowDigest,
        },
      };
    }

    const recorded = await this.store.record(validation.observation);
    const report = await this.report(asOf);
    this.logger.info(
      `fx source check: ${recorded.status === 'recorded' ? 'new observation' : 'already observed'} ` +
        `for ${validation.observation.publishedOn} (staleness ${report.state})`,
    );

    return {
      sourceId: this.retriever.sourceId,
      sourceUrl: this.retriever.sourceUrl,
      checkedAt: asOf.toISOString(),
      overlapSkipped: false,
      retrieval: {
        outcome: 'retrieved',
        reason: null,
        status: null,
        detail: null,
        bodyDigest: retrieval.bodyDigest,
        rowDigest: retrieval.rowDigest,
      },
      validation: { valid: true, issues: [] },
      record: {
        status: recorded.status === 'recorded' ? 'recorded' : 'duplicate',
        observationId: recorded.stored.id,
      },
      report,
      decision: 'need_source',
      decisionReason: FX_SOURCE_DECISION_REASON,
      published: false,
      approved: false,
      databaseWrites: recorded.status === 'recorded' ? 1 : 0,
      limitations: FX_SOURCE_LIMITATIONS,
    };
  }

  /** Build a result that performed no write, then compute the read-only report. */
  private async baseResult(
    asOf: Date,
    recordStatus: FxSourceRecordStatus,
    validation: FxSourceObservationValidation | null,
  ): Promise<Omit<FxSourceCheckResult, 'retrieval'>> {
    return {
      sourceId: this.retriever.sourceId,
      sourceUrl: this.retriever.sourceUrl,
      checkedAt: asOf.toISOString(),
      overlapSkipped: false,
      validation: validation === null ? null : { valid: validation.valid, issues: validation.issues },
      record: { status: recordStatus, observationId: null },
      report: await this.report(asOf),
      decision: 'need_source',
      decisionReason: FX_SOURCE_DECISION_REASON,
      published: false,
      approved: false,
      databaseWrites: 0,
      limitations: FX_SOURCE_LIMITATIONS,
    };
  }

  private async overlapResult(asOf: Date, detail: string): Promise<FxSourceCheckResult> {
    return {
      ...(await this.baseResult(asOf, 'not_attempted', null)),
      overlapSkipped: true,
      retrieval: {
        outcome: 'not_attempted',
        reason: null,
        status: null,
        detail,
        bodyDigest: null,
        rowDigest: null,
      },
    };
  }
}
