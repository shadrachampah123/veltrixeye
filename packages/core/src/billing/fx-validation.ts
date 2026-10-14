import {
  BILLING_FX_SOURCES,
  BILLING_PAYMENT_CURRENCIES,
  type BillingFxSource,
  type BillingPaymentCurrency,
} from '@veltrixeye/contracts';
import {
  BILLING_FX_POLICY,
  BillingFxError,
  assertFxRateVersionFresh,
  fxRateAgeSeconds,
  parseFxRateVersion,
  type BillingFxPolicy,
} from './fx-rate-versions.js';

/**
 * Billing FX evidence validation — the DRY-RUN-ONLY candidate checker behind
 * `npm run billing:fx:validate`.
 *
 * WHAT THIS MODULE IS
 *  - A pure validator for a CANDIDATE USD→GHS rate and its evidence (source,
 *    provenance/reference, capture + effective timestamps, operator, reason).
 *  - Exact-decimal only: a rate arrives as a decimal STRING and is converted
 *    to the scaled-integer form the existing FX authority uses
 *    (`fxRateScaled = rate × 10^fxRateScale`, `BillingFxRateVersion`). No
 *    float ever touches the rate; exponent notation is refused.
 *  - A reuse of the existing authority, not a competing one: currency, source
 *    vocabulary, precision bounds, timestamp ordering and the 15-minute
 *    freshness bound are all enforced by delegating to
 *    `parseFxRateVersion()` / `assertFxRateVersionFresh()` in
 *    `./fx-rate-versions.ts` under `BILLING_FX_POLICY`.
 *
 * WHAT THIS MODULE NEVER DOES
 *  - It never approves a source and never publishes a rate. The decision is
 *    ALWAYS `need_source`: no authoritative FX source has been approved in
 *    code or policy, so even a fully consistent candidate stays at
 *    `need_source` until an operator approval decision is taken and recorded
 *    OUTSIDE this validator. (The historical 11.58 GHS/USD rate is not an
 *    approved current rate and receives no special handling here.)
 *  - It never writes to a database, calls an external service, reads a clock
 *    implicitly (the evaluation instant is injected), reads the environment,
 *    or accepts a publication/approval instruction: publication and approval
 *    flags are refused, not ignored.
 *  - It cannot detect a conflict with already-published versions (two rates
 *    effective at the same instant): a dry run performs no database read by
 *    design, so that ambiguity check stays with the durable authority's
 *    resolver (`resolveFxRateVersion`) if publication is ever separately
 *    approved. This limitation is reported on every result.
 */

/* -------------------------------------------------------------------------- */
/* Decision vocabulary                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The only decision this validator can return. Kept as a literal so no code
 * path here can produce `approved`, `publishable` or any equivalent.
 */
export const FX_VALIDATION_DECISION = 'need_source' as const;
export type FxValidationDecision = typeof FX_VALIDATION_DECISION;

/** Why the decision cannot move past `need_source` from inside a dry run. */
export const FX_VALIDATION_DECISION_REASON =
  'No authoritative FX source has been approved in code or policy, so a dry-run ' +
  'validation can confirm at most that the supplied evidence is internally ' +
  'consistent, fresh and complete. Source approval is a separate, recorded ' +
  'operator decision; this validator never approves a source and never publishes a rate.';

/** Limitations a dry run is structurally unable to overcome (never hidden). */
export const FX_VALIDATION_LIMITATIONS: readonly string[] = Object.freeze([
  'A dry run performs no database read, so a conflict with an already-published ' +
    'rate version effective at the same instant cannot be detected here; the ' +
    'durable authority (resolveFxRateVersion) must re-check ambiguity before ' +
    'any separately approved publication.',
  'A dry run performs no external call, so the supplied provenance/reference ' +
    'is checked for presence and shape only — its truth is established by the ' +
    'operator approval decision, not by this validator.',
]);

/**
 * Input keys that attempt to turn validation into publication or approval.
 * Their presence with a truthy value is a refusal (`prohibited_flag`), never
 * a silent ignore: an instruction to publish must fail loudly.
 */
export const FX_PROHIBITED_PUBLICATION_KEYS: readonly string[] = Object.freeze([
  'publish',
  'published',
  'publishRate',
  'approve',
  'approved',
  'approval',
  'apply',
  'confirm',
  'confirmed',
  'write',
  'register',
  'live',
]);

/* -------------------------------------------------------------------------- */
/* Candidate input + result                                                   */
/* -------------------------------------------------------------------------- */

/** A candidate rate + evidence, exactly as an operator supplies it. */
export interface FxRateCandidateInput {
  /** Exact decimal GHS per 1 USD, as a string (e.g. `"12.500000"`). */
  rate?: string;
  /** The claimed authoritative source (free-text name; never approved here). */
  source?: string;
  /** Internal provenance vocabulary (`BILLING_FX_SOURCES`: db|ops|import|config). */
  fxSource?: string;
  /** Provenance/reference: bulletin, document or ticket identifying the rate. */
  sourceReference?: string;
  /** When the rate was captured, ISO 8601 WITH a timezone designator. */
  capturedAt?: string;
  /** When the rate becomes effective, ISO 8601 WITH a timezone designator. */
  effectiveFrom?: string;
  /** The operator presenting the evidence. */
  operator?: string;
  /** Why this rate is being presented. */
  reason?: string;
  /** Must equal the policy base currency (USD). */
  baseCurrency?: string;
  /** Must equal the policy quote/payment currency (GHS). */
  quoteCurrency?: string;
}

export type FxValidationIssueCode =
  | 'missing_evidence'
  | 'invalid'
  | 'unsupported_currency'
  | 'unsupported_source'
  | 'stale'
  | 'not_yet_effective'
  | 'prohibited_flag';

export interface FxValidationIssue {
  readonly field: string;
  readonly code: FxValidationIssueCode;
  readonly message: string;
  /** The validation dimension this issue fails (see FxValidationCheck). */
  readonly check?: string;
}

export interface FxValidationCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail';
}

/** The normalized candidate, present only when every check passes. */
export interface FxValidatedCandidate {
  readonly baseCurrency: string;
  readonly quoteCurrency: BillingPaymentCurrency;
  /** The rate exactly as supplied (trimmed decimal string). */
  readonly rateDecimal: string;
  /** `rate × 10^fxRateScale` as an integer string (the authority's form). */
  readonly fxRateScaled: string;
  readonly fxRateScale: number;
  readonly roundingMode: string;
  readonly source: string;
  readonly fxSource: BillingFxSource;
  readonly sourceReference: string;
  readonly capturedAt: string;
  readonly effectiveFrom: string;
  readonly operator: string;
  readonly reason: string;
  /** Age of the capture at the evaluation instant, in seconds. */
  readonly ageSeconds: number;
  readonly maxAgeSeconds: number;
  readonly pricingPolicyVersion: string;
}

export interface FxValidationResult {
  readonly decision: FxValidationDecision;
  readonly decisionReason: string;
  /** True only when every evidence check passes. NEVER an approval. */
  readonly valid: boolean;
  readonly dryRun: true;
  readonly published: false;
  readonly approved: false;
  readonly databaseWrites: 0;
  readonly externalCalls: 0;
  readonly evaluatedAt: string;
  readonly checks: readonly FxValidationCheck[];
  readonly issues: readonly FxValidationIssue[];
  readonly candidate: FxValidatedCandidate | null;
  readonly limitations: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Exact decimal handling                                                     */
/* -------------------------------------------------------------------------- */

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Parse an exact decimal rate string into the authority's scaled-integer
 * form. Refuses anything a float would have to interpret: exponent notation,
 * signs, thousands separators, a bare fraction, or more fractional digits
 * than the policy precision bound (`maxScale`). `"12"` is normalized to
 * scale 1 (`120 @ 1`) so it still satisfies the authority's minimum scale
 * without changing its value.
 *
 * Throws `BillingFxError('invalid')` — the authority's own error type.
 */
export function parseFxRateDecimal(rate: string): { scaled: bigint; scale: number } {
  const text = rate.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    throw new BillingFxError(
      'invalid',
      `The FX rate "${rate}" is not an exact decimal string (examples of the accepted form: "12.5", "12.500000"). ` +
        'Exponent notation, signs, separators and bare fractions are refused so no float ever interprets the rate.',
    );
  }
  const integerPart = match[1]!;
  const fractionPart = match[2] ?? '';
  if (fractionPart.length > BILLING_FX_POLICY.maxScale) {
    throw new BillingFxError(
      'invalid',
      `The FX rate "${rate}" carries ${fractionPart.length} fractional digits; the ${BILLING_FX_POLICY.version} ` +
        `policy allows at most ${BILLING_FX_POLICY.maxScale} (scale ${BILLING_FX_POLICY.minScale}–${BILLING_FX_POLICY.maxScale}).`,
    );
  }
  // Exact integer construction: concatenate digits, never multiply floats.
  const scale = Math.max(fractionPart.length, BILLING_FX_POLICY.minScale);
  const scaledText =
    fractionPart.length === scale
      ? `${integerPart}${fractionPart}`
      : `${integerPart}${fractionPart}${'0'.repeat(scale - fractionPart.length)}`;
  const scaled = BigInt(scaledText);
  if (scaled <= 0n) {
    throw new BillingFxError('invalid', 'An FX rate must be strictly positive.');
  }
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BillingFxError(
      'invalid',
      'The FX rate exceeds the largest exactly representable scaled integer; the pricing boundary refuses to round it.',
    );
  }
  return { scaled, scale };
}

/* -------------------------------------------------------------------------- */
/* Timestamp handling                                                         */
/* -------------------------------------------------------------------------- */

const TIMEZONE_DESIGNATOR = /(?:[zZ]|[+-][0-9]{2}:[0-9]{2})$/;

/**
 * Parse an ISO 8601 timestamp that MUST carry a timezone. A naive timestamp
 * is ambiguous (whose wall clock?) and is refused rather than guessed.
 */
function parseTimestampWithTimezone(field: string, raw: string, issues: FxValidationIssue[]): Date | null {
  const text = raw.trim();
  if (!TIMEZONE_DESIGNATOR.test(text)) {
    issues.push({
      field,
      code: 'invalid',
      message: `${field} "${raw}" carries no timezone designator; a timezone-bearing ISO 8601 timestamp (Z or ±hh:mm) is required so the instant is unambiguous.`,
    });
    return null;
  }
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    issues.push({ field, code: 'invalid', message: `${field} "${raw}" is not a valid timestamp.` });
    return null;
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* The validator                                                              */
/* -------------------------------------------------------------------------- */

const CHECK_NAMES = [
  'publication_guard',
  'evidence_presence',
  'provenance',
  'currency',
  'decimal_precision',
  'timestamps',
  'freshness',
] as const;

type CheckName = (typeof CHECK_NAMES)[number];

const FIELD_TO_CHECK: Readonly<Record<string, CheckName>> = Object.freeze({
  publish: 'publication_guard',
  published: 'publication_guard',
  publishRate: 'publication_guard',
  approve: 'publication_guard',
  approved: 'publication_guard',
  approval: 'publication_guard',
  apply: 'publication_guard',
  confirm: 'publication_guard',
  confirmed: 'publication_guard',
  write: 'publication_guard',
  register: 'publication_guard',
  live: 'publication_guard',
  rate: 'decimal_precision',
  source: 'provenance',
  fxSource: 'provenance',
  sourceReference: 'provenance',
  operator: 'evidence_presence',
  reason: 'evidence_presence',
  baseCurrency: 'currency',
  quoteCurrency: 'currency',
  capturedAt: 'timestamps',
  effectiveFrom: 'timestamps',
});

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function requiredText(
  record: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
  minLength: number,
  maxLength: number,
  issues: FxValidationIssue[],
): string | null {
  const raw = record[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    issues.push({
      field,
      code: 'missing_evidence',
      message: `${label} is required and must be supplied explicitly; missing evidence fails closed.`,
    });
    return null;
  }
  const value = raw.trim();
  if (value.length < minLength || value.length > maxLength) {
    issues.push({
      field,
      code: 'invalid',
      message: `${label} must be between ${minLength} and ${maxLength} characters so the evidence is identifiable and auditable.`,
    });
    return null;
  }
  return value;
}

/** Internal candidate row id: validation mints no durable version identity. */
const CANDIDATE_ROW_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Validate one candidate rate + its evidence at an injected instant.
 *
 * Pure and deterministic: no I/O, no clock (pass `asOf`), no environment.
 * Candidate problems are reported in `issues` (never thrown, never defaulted);
 * only a malformed injected `asOf` throws, because then no evaluation
 * instant exists at all.
 *
 * The result's `decision` is `need_source` in EVERY outcome — see the module
 * header. `valid: true` means "internally consistent evidence", not approval.
 */
export function validateFxRateCandidate(
  input: unknown,
  options?: { asOf?: Date | string; policy?: BillingFxPolicy },
): FxValidationResult {
  const policy = options?.policy ?? BILLING_FX_POLICY;

  const asOf =
    options?.asOf === undefined
      ? new Date()
      : typeof options.asOf === 'string'
        ? parseTimestampWithTimezone('asOf', options.asOf, [])
        : options.asOf;
  if (asOf === null || !(asOf instanceof Date) || !Number.isFinite(asOf.getTime())) {
    throw new BillingFxError(
      'invalid',
      'A finite, timezone-bearing evaluation instant (asOf) is required to validate FX evidence.',
    );
  }

  const issues: FxValidationIssue[] = [];
  const record: Readonly<Record<string, unknown>> =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Readonly<Record<string, unknown>>)
      : {};

  if (record === null || Object.keys(record).length === 0) {
    issues.push({
      field: 'input',
      code: 'missing_evidence',
      message: 'A candidate rate with its full evidence is required; an empty candidate fails closed.',
    });
  }

  /* Publication / approval guard — refused, never ignored. */
  for (const key of FX_PROHIBITED_PUBLICATION_KEYS) {
    if (key in record && isTruthyFlag(record[key])) {
      issues.push({
        field: key,
        code: 'prohibited_flag',
        message:
          `"${key}" is prohibited: this validator is dry-run only and can neither publish an FX rate ` +
          'nor approve a source. Remove the flag and keep the decision at need_source.',
      });
    }
  }

  /* Required evidence (fail closed on anything missing or blank). */
  const rateText = requiredText(record, 'rate', 'The FX rate', 1, 64, issues);
  const source = requiredText(record, 'source', 'The authoritative source', 3, 200, issues);
  const sourceReference = requiredText(record, 'sourceReference', 'The provenance/reference', 3, 500, issues);
  const operator = requiredText(record, 'operator', 'The operator', 3, 200, issues);
  const reason = requiredText(record, 'reason', 'The reason', 10, 1000, issues);
  const baseCurrencyText = requiredText(record, 'baseCurrency', 'The base currency', 3, 3, issues);
  const quoteCurrencyText = requiredText(record, 'quoteCurrency', 'The quote currency', 3, 3, issues);
  const fxSourceText = requiredText(record, 'fxSource', 'The provenance channel (fxSource)', 1, 32, issues);
  const capturedAtText = requiredText(record, 'capturedAt', 'The capture timestamp', 1, 64, issues);
  const effectiveFromText = requiredText(record, 'effectiveFrom', 'The effective timestamp', 1, 64, issues);

  /* Currency: the policy pair, and nothing else. */
  if (baseCurrencyText !== null && baseCurrencyText !== policy.baseCurrency) {
    issues.push({
      field: 'baseCurrency',
      code: 'unsupported_currency',
      message: `A base currency of "${baseCurrencyText}" cannot price a ${policy.baseCurrency} commercial amount.`,
    });
  }
  if (quoteCurrencyText !== null) {
    if (!(BILLING_PAYMENT_CURRENCIES as readonly string[]).includes(quoteCurrencyText)) {
      issues.push({
        field: 'quoteCurrency',
        code: 'unsupported_currency',
        message: `A quote currency of "${quoteCurrencyText}" is not a supported payment currency.`,
      });
    } else if (quoteCurrencyText !== policy.quoteCurrency) {
      issues.push({
        field: 'quoteCurrency',
        code: 'unsupported_currency',
        message: `A quote currency of "${quoteCurrencyText}" is not the configured payment currency "${policy.quoteCurrency}".`,
      });
    }
  }

  /* Provenance channel: the authority's recorded vocabulary, never inferred. */
  let fxSource: BillingFxSource | null = null;
  if (fxSourceText !== null) {
    if ((BILLING_FX_SOURCES as readonly string[]).includes(fxSourceText)) {
      fxSource = fxSourceText as BillingFxSource;
    } else {
      issues.push({
        field: 'fxSource',
        code: 'unsupported_source',
        message: `Unknown provenance channel "${fxSourceText}" (accepted: ${BILLING_FX_SOURCES.join(', ')}). Provenance is recorded in the authority's vocabulary, never invented.`,
      });
    }
  }

  /* Exact decimal rate (the authority's scaled-integer form, no floats). */
  let decimal: { scaled: bigint; scale: number } | null = null;
  if (rateText !== null) {
    try {
      decimal = parseFxRateDecimal(rateText);
    } catch (error) {
      if (error instanceof BillingFxError) {
        issues.push({ field: 'rate', code: 'invalid', message: error.message });
      } else {
        throw error;
      }
    }
  }

  /* Timestamps: timezone-bearing, parseable. */
  const capturedAt = capturedAtText !== null ? parseTimestampWithTimezone('capturedAt', capturedAtText, issues) : null;
  const effectiveFrom =
    effectiveFromText !== null ? parseTimestampWithTimezone('effectiveFrom', effectiveFromText, issues) : null;

  /*
   * Delegate the joint checks to the existing authority: build the candidate
   * in the durable row's shape and let `parseFxRateVersion` enforce currency,
   * source, precision, positivity and captured-at-or-before-effective, then
   * let `assertFxRateVersionFresh` enforce the 15-minute freshness bound.
   * The candidate row id is an internal placeholder only — validation mints
   * no version identity and the id never leaves this function.
   */
  let candidate: FxValidatedCandidate | null = null;
  if (
    decimal !== null &&
    capturedAt !== null &&
    effectiveFrom !== null &&
    baseCurrencyText !== null &&
    quoteCurrencyText !== null &&
    fxSource !== null &&
    source !== null &&
    sourceReference !== null &&
    operator !== null &&
    reason !== null &&
    rateText !== null
  ) {
    try {
      const version = parseFxRateVersion({
        id: CANDIDATE_ROW_ID,
        base_currency: baseCurrencyText,
        quote_currency: quoteCurrencyText,
        fx_rate_scaled: decimal.scaled.toString(),
        fx_rate_scale: decimal.scale,
        rounding_mode: policy.roundingMode,
        source: fxSource,
        source_reference: sourceReference,
        created_by: operator,
        effective_from: effectiveFrom,
        captured_at: capturedAt,
      });
      assertFxRateVersionFresh(version, asOf, policy);
      if (effectiveFrom.getTime() > asOf.getTime()) {
        issues.push({
          field: 'effectiveFrom',
          code: 'not_yet_effective',
          message:
            `The rate only becomes effective at ${effectiveFrom.toISOString()}, after the evaluation instant ` +
            `${asOf.toISOString()}; a rate that is not yet effective cannot price a payment.`,
        });
      } else {
        candidate = {
          baseCurrency: version.baseCurrency,
          quoteCurrency: version.quoteCurrency,
          rateDecimal: rateText,
          fxRateScaled: version.fxRateScaled.toString(),
          fxRateScale: version.fxRateScale,
          roundingMode: version.roundingMode,
          source,
          fxSource: version.source,
          sourceReference,
          capturedAt: version.capturedAt.toISOString(),
          effectiveFrom: version.effectiveFrom.toISOString(),
          operator,
          reason,
          ageSeconds: fxRateAgeSeconds(version, asOf),
          maxAgeSeconds: policy.maxAgeSeconds,
          pricingPolicyVersion: policy.version,
        };
      }
    } catch (error) {
      if (error instanceof BillingFxError) {
        const code: FxValidationIssueCode =
          error.reason === 'missing'
            ? 'missing_evidence'
            : error.reason === 'ambiguous'
              ? 'invalid'
              : error.reason;
        issues.push({ field: 'capturedAt', code, message: error.message });
      } else {
        throw error;
      }
    }
  }

  const checkForIssue = (issue: FxValidationIssue): CheckName => {
    if (issue.code === 'prohibited_flag') return 'publication_guard';
    if (issue.code === 'stale') return 'freshness';
    if (issue.code === 'not_yet_effective') return 'freshness';
    if (issue.field === 'capturedAt' && /future|old at pricing time/.test(issue.message)) return 'freshness';
    return FIELD_TO_CHECK[issue.field] ?? 'evidence_presence';
  };

  const valid = issues.length === 0 && candidate !== null;
  const checks: FxValidationCheck[] = CHECK_NAMES.map((name) => ({
    name,
    status: issues.some((issue) => checkForIssue(issue) === name) ? 'fail' : 'pass',
  }));

  return {
    decision: FX_VALIDATION_DECISION,
    decisionReason: FX_VALIDATION_DECISION_REASON,
    valid,
    dryRun: true,
    published: false,
    approved: false,
    databaseWrites: 0,
    externalCalls: 0,
    evaluatedAt: asOf.toISOString(),
    checks,
    issues,
    candidate: valid ? candidate : null,
    limitations: FX_VALIDATION_LIMITATIONS,
  };
}
