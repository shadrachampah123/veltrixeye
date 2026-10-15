import type { Pool } from 'pg';
import type pg from 'pg';
import { z } from 'zod';
import { BILLING_CREDENTIAL_SHAPED_RE, type BillingFxSource } from '@veltrixeye/contracts';
import { recordAuditEvent } from '../audit.js';
import {
  BILLING_FX_POLICY,
  BillingFxError,
  assertFxRateVersionFresh,
  parseFxRateVersion,
  type BillingFxPolicy,
  type BillingFxRateVersion,
} from './fx-rate-versions.js';
import { parseFxRateDecimal } from './fx-validation.js';

/**
 * Billing FX **publication** — the operator-approved write boundary for
 * `billing_fx_rate_versions`.
 *
 * WHY THIS EXISTS. Migration 0032 shipped the FX authority, the resolution
 * rules and the tests, but deliberately no publication path: `publish()` was
 * reachable only out-of-band, so a rate version could be written by anyone able
 * to open a database connection, with `source_reference` and `created_by`
 * NULLABLE and no audit record at all. This module is the missing boundary. It
 * adds NO authority of its own: every currency, precision, timestamp-ordering
 * and freshness rule still comes from `./fx-rate-versions.ts` under
 * `BILLING_FX_POLICY`, and the conversion rules are untouched.
 *
 * The approved policy it encodes (D1–D10 — see docs/billing.md → FX publication
 * policy):
 *
 *  - **D1** the 900-second bound is unchanged, and it is enforced when a NEW
 *    chargeable pricing epoch is registered (and when a new one-off price is
 *    computed), never by substituting a newer rate at checkout.
 *  - **D2** `captured_at` is the actual adoption/approval instant and
 *    `effective_from` the approved effective instant, defaulting to the same
 *    instant. Neither is ever back-dated to the publisher's bulletin time.
 *  - **D3** a publication requires a named executing operator, a source
 *    reference, a reason and an explicitly recorded human approval.
 *  - **D4** the `billing.fx_rate_published` audit event is written on the SAME
 *    transaction as the version row: if the audit write fails, the publication
 *    fails and rolls back. The version table stays append-only.
 *  - **D5** two DISTINCT named approvers plus the executing operator, with
 *    written per-publication approval evidence. No role model is invented: when
 *    the required evidence is absent, this module FAILS CLOSED.
 *  - **D6** corrections are forward-only. There is no unpublish, no delete, no
 *    back-dating and no update path — here or in the database.
 *  - **D7** the eight mandatory pre-publication checks below.
 *  - **D8/D9** a publication never mutates a plan amount, a pricing snapshot, a
 *    subscription lock or a Paystack plan identifier: it writes exactly one FX
 *    version row and one audit row, and nothing else. A customer-facing price
 *    changes only through a separately approved epoch rotation.
 *  - **D10** the CLI in front of this service is dry-run by default and refuses
 *    a non-loopback database target before a pool exists.
 *
 * WHAT THIS MODULE NEVER DOES
 *  - it never fetches a rate: no network call, no provider import — the rate is
 *    operator-supplied evidence, exactly like a plan code;
 *  - it never reads or writes a price, a plan, an epoch or an entitlement;
 *  - it never calls `BillingFxRateVersionStore.publish()`: it opens its own
 *    transaction, because the version row and its audit event must commit or
 *    roll back together, which the pool-scoped `publish()` cannot express;
 *  - it never updates or deletes a version: the only new statements are one
 *    `INSERT` into the authority table and one audit `INSERT`.
 *
 * The observation layer is NOT involved and remains separate: observing a
 * published figure is not approving it (see `./fx-source-observations.ts`).
 */

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export const FX_PUBLICATION_POLICY_VERSION = 'fx-publication-v1' as const;

/** The transactional audit action a publication writes (D4). */
export const FX_PUBLICATION_AUDIT_ACTION = 'billing.fx_rate_published' as const;

/**
 * The provenance channel an operator publication records (D3). Pinned to the
 * authority's own vocabulary — never inferred, never free text.
 */
export const FX_PUBLICATION_SOURCE: BillingFxSource = 'ops';

/**
 * Pinned advisory-lock key serializing publications inside a transaction, so
 * two concurrent publications cannot both observe the same "latest version" and
 * then race past the ordering and drift checks. Distinct from the observation
 * layer's `FX_SOURCE_ADVISORY_LOCK_KEY` (875_421_010) — different lock,
 * different subsystem, no shared serialization.
 */
export const FX_PUBLICATION_ADVISORY_LOCK_KEY = 875_421_011;

/** Two distinct named approvers, and no fewer (D5). */
export const FX_PUBLICATION_APPROVER_COUNT = 2;

/**
 * A rate outside this factor of the previously published rate is described as
 * implausible and refused (check 1). A factor, not a currency threshold: it
 * catches an inverted or order-of-magnitude figure without encoding a market
 * view. Only applied when a previous version exists.
 */
export const FX_PUBLICATION_MAGNITUDE_FACTOR = 10;

/**
 * Relative drift above which the reason must carry an explicit written
 * justification (check 4): 500 basis points = 5%. Below the threshold no
 * justification is required; above it, a publication without one is refused.
 * The threshold is a review trigger, NOT a price view and not a limit on the
 * rate — a large move is publishable, it simply may not be published silently.
 */
export const FX_PUBLICATION_DRIFT_THRESHOLD_BASIS_POINTS = 500;

/** Bounds mirrored from the authority's CHECKs, so refusals are typed here too. */
const MAX_OPERATOR_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 190;
const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 1000;
const MIN_DRIFT_JUSTIFICATION_LENGTH = 10;
const MAX_DRIFT_JUSTIFICATION_LENGTH = 1000;

/* -------------------------------------------------------------------------- */
/* Failures — typed, explicit, never silent                                   */
/* -------------------------------------------------------------------------- */

export type FxPublicationFailureReason =
  /** The evidence object is absent, empty or not an object. */
  | 'missing_evidence'
  /** A required field is absent, blank, over-long or credential-shaped. */
  | 'invalid_evidence'
  /** Fewer than two approvers, an approver equal to the executor, or two identical approvers. */
  | 'unauthorized_approvers'
  /** The rate is not an exact, in-range decimal. */
  | 'invalid_rate'
  /** The rate is inverted or off by an order of magnitude against the last published version. */
  | 'rate_implausible'
  /** No usable source reference, or a reference that is a URL. */
  | 'corroboration_missing'
  /** Drift beyond the threshold without a written justification. */
  | 'drift_unexplained'
  /** Not strictly later than the last published version's `effective_from`. */
  | 'ordering_conflict'
  /** Captured before the pricing instant by more than the policy bound (`stale`). */
  | 'stale'
  /** Not yet effective, or captured after the instant. */
  | 'not_yet_effective'
  /** A timestamp is missing, unparseable or not timezone-bearing. */
  | 'invalid_instant'
  /** The database refused the insert (a same-instant version already exists). */
  | 'conflict'
  /** The transactional audit event could not be written; nothing was published. */
  | 'audit_failed';

/** A publication that cannot proceed. Always a hard failure (fail closed). */
export class FxPublicationError extends Error {
  readonly code = 'billing_fx_publication_refused' as const;

  constructor(
    readonly reason: FxPublicationFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FxPublicationError';
  }
}

export function isFxPublicationError(error: unknown): error is FxPublicationError {
  return error instanceof FxPublicationError;
}

/* -------------------------------------------------------------------------- */
/* Request evidence (D3, D5)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The written approval evidence a publication must carry.
 *
 * `approvers` are the two DISTINCT named humans who approved this specific
 * publication; `executorId` is the named human (or named operator run) who
 * performs it. All three must be distinct — an approver who is also the
 * executor is not a second person.
 *
 * These are SUPPLIED identities. This module never derives, looks up or infers
 * a name, and it holds no role model: identities are evidence the operator
 * presents, and their truthfulness is a procedural control (see docs/billing.md).
 */
export const fxPublicationRequestSchema = z
  .object({
    /** The named human or named operator run executing the publication. */
    executorId: z.string().trim().min(1).max(MAX_OPERATOR_LENGTH),
    /** Exactly two distinct named approvers (D5). */
    approvers: z.array(z.string().trim().min(1).max(MAX_OPERATOR_LENGTH)).length(FX_PUBLICATION_APPROVER_COUNT),
    /** Why this rate is being published; also the drift justification when required. */
    reason: z.string().trim().min(MIN_REASON_LENGTH).max(MAX_REASON_LENGTH),
    /** The corroborating bulletin/document/ticket identifier (D3). Never a URL. */
    sourceReference: z.string().trim().min(3).max(MAX_REFERENCE_LENGTH),
    /** The exact decimal GHS-per-USD rate, as published (`"12.500000"`). */
    rate: z.string().trim().min(1).max(64),
    /** The adoption/approval instant (D2). ISO 8601 WITH a timezone designator. */
    capturedAt: z.string().trim().min(1).max(64),
    /** The approved effective instant (D2). Defaults to `capturedAt`. */
    effectiveFrom: z.string().trim().min(1).max(64).optional(),
    /** Written justification, REQUIRED when the relative drift exceeds the threshold (check 4). */
    driftJustification: z.string().trim().min(MIN_DRIFT_JUSTIFICATION_LENGTH).max(MAX_DRIFT_JUSTIFICATION_LENGTH).optional(),
    /** Confirmed downstream intent (check 7): who consumes the version, and whether epochs follow. */
    downstream: z
      .object({
        /** True when provider-plan epochs are to be registered against this version. */
        epochRegistrationPlanned: z.boolean(),
        /** Who will perform that registration. Required when the above is true. */
        registrant: z.string().trim().min(1).max(MAX_OPERATOR_LENGTH).optional(),
      })
      .strict(),
  })
  .strict();

export type FxPublicationRequest = z.infer<typeof fxPublicationRequestSchema>;

/* -------------------------------------------------------------------------- */
/* The eight mandatory pre-publication checks (D7)                            */
/* -------------------------------------------------------------------------- */

export const FX_PUBLICATION_CHECK_NAMES = [
  'rate_plausibility',
  'rate_precision',
  'corroboration',
  'drift_explained',
  'ordering',
  'dry_run_validation',
  'downstream_intent',
  'two_person_authorization',
] as const;

export type FxPublicationCheckName = (typeof FX_PUBLICATION_CHECK_NAMES)[number];

export interface FxPublicationCheck {
  readonly name: FxPublicationCheckName;
  readonly status: 'pass' | 'fail';
}

export interface FxPublicationIssue {
  readonly field: string;
  readonly reason: FxPublicationFailureReason;
  readonly check: FxPublicationCheckName;
  readonly message: string;
}

/** The normalized, fully validated publication — present only when every check passes. */
export interface ValidatedFxPublication {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly fxRateScaled: bigint;
  readonly fxRateScale: number;
  readonly rateDecimal: string;
  readonly roundingMode: string;
  readonly source: BillingFxSource;
  readonly sourceReference: string;
  readonly executorId: string;
  readonly approvers: readonly string[];
  readonly reason: string;
  readonly driftJustification: string | null;
  readonly driftBasisPoints: number | null;
  readonly capturedAt: Date;
  readonly effectiveFrom: Date;
  readonly epochRegistrationPlanned: boolean;
  readonly registrant: string | null;
  readonly pricingPolicyVersion: string;
  readonly publicationPolicyVersion: string;
  readonly previousVersionId: string | null;
}

export interface FxPublicationAssessment {
  /** True only when all eight checks pass. NEVER an approval by itself. */
  readonly valid: boolean;
  readonly checks: readonly FxPublicationCheck[];
  readonly issues: readonly FxPublicationIssue[];
  readonly candidate: ValidatedFxPublication | null;
  readonly evaluatedAt: string;
  readonly databaseWrites: 0;
  readonly published: false;
  readonly limitations: readonly string[];
}

/** Limitations reported on every assessment (never hidden, never softened). */
export const FX_PUBLICATION_LIMITATIONS: readonly string[] = Object.freeze([
  'The check module performs no database read of its own: an assessment carries databaseWrites 0 and is ' +
    'not a publication. Only `FxPublicationService.publish()` writes, and only inside one transaction.',
  'A source reference is checked for presence, shape and credential-safety — not for truth. Whether the ' +
    'cited bulletin actually published this figure is established by the human approval decision (D3/D5), ' +
    'which is a procedural control this code cannot verify.',
  'The two approver identities are evidence supplied by the operator. This module has no role model, so it ' +
    'cannot verify that an approver is a different PERSON from the executor, only that the recorded ' +
    'identities differ. That residual gap is documented, not hidden.',
  'A publication cannot be unpublish. Corrections are forward-only: a corrected rate is a NEW version with a ' +
    'later effective_from, and the superseded version remains in the history permanently (D6).',
]);

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                            */
/* -------------------------------------------------------------------------- */

/** ISO 8601 that MUST carry a timezone designator — a naive instant is refused. */
const TIMESTAMP_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

function parseInstant(text: string): Date | null {
  if (!TIMESTAMP_WITH_TIMEZONE.test(text)) return null;
  const value = new Date(text);
  return Number.isFinite(value.getTime()) ? value : null;
}

function isUrlShaped(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^www\./i.test(text);
}

/* -------------------------------------------------------------------------- */
/* Pure validation (the eight checks)                                         */
/* -------------------------------------------------------------------------- */

export interface ValidateFxPublicationInput {
  readonly request: unknown;
  /** The newest published version, or null when none exists. Read by the caller. */
  readonly previousVersion?: unknown;
  /** The instant the publication is evaluated at (injected — nothing here reads a clock). */
  readonly asOf: Date;
  readonly policy?: BillingFxPolicy;
}

/**
 * Validate one publication candidate against the eight mandatory checks.
 *
 * PURE: no I/O, no clock, no database. `previousVersion` is supplied by the
 * caller (the service reads it; a test supplies it directly), so the ordering,
 * magnitude and drift checks are deterministic and reproducible.
 *
 * Throws only on a programming error (a non-finite `asOf`); every evidence
 * failure is returned as a typed issue, never thrown, so a caller can report
 * all failures at once instead of one per attempt.
 */
export function validateFxPublication(
  input: ValidateFxPublicationInput,
): FxPublicationAssessment {
  const policy = input.policy ?? BILLING_FX_POLICY;
  const asOf = input.asOf;
  const issues: FxPublicationIssue[] = [];

  const fail = (
    field: string,
    reason: FxPublicationFailureReason,
    check: FxPublicationCheckName,
    message: string,
  ): void => {
    issues.push({ field, reason, check, message });
  };

  if (!Number.isFinite(asOf.getTime())) {
    throw new FxPublicationError(
      'invalid_instant',
      'A finite evaluation instant (asOf) is required to validate an FX publication.',
    );
  }

  /* --- Shape: the evidence object itself (D3) ------------------------------ */
  const parsed = fxPublicationRequestSchema.safeParse(input.request);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    const path = parsed.error.issues[0]?.path.join('.') ?? '';
    // A malformed approval identity is an AUTHORIZATION failure, not a generic
    // evidence failure: the two-person rule is what the shape check protects.
    const check: FxPublicationCheckName =
      path.startsWith('approvers') || path.includes('executorId')
        ? 'two_person_authorization'
        : 'dry_run_validation';
    fail('request', 'missing_evidence', check, `The publication evidence is incomplete or malformed: ${summary}.`);
    return {
      valid: false,
      checks: FX_PUBLICATION_CHECK_NAMES.map((name) => ({
        name,
        status: issues.some((issue) => issue.check === name) ? 'fail' : 'pass',
      })),
      issues,
      candidate: null,
      evaluatedAt: asOf.toISOString(),
      databaseWrites: 0,
      published: false,
      limitations: FX_PUBLICATION_LIMITATIONS,
    };
  }

  const request = parsed.data;

  /* --- Check 8: two-person authorization (D5) ------------------------------ */
  // Evaluated early: an unauthorized publication must never look "nearly right".
  const approvers = [...request.approvers];
  const distinct = new Set(approvers);
  if (distinct.size !== approvers.length) {
    fail(
      'approvers',
      'unauthorized_approvers',
      'two_person_authorization',
      'The two approvers must be two DIFFERENT named people; the same name was recorded twice.',
    );
  }
  for (const approver of approvers) {
    if (approver === request.executorId) {
      fail(
        'approvers',
        'unauthorized_approvers',
        'two_person_authorization',
        `Approver "${approver}" is also the executing operator. Two-person authorization requires two ` +
          'approvers who are not the person executing the publication.',
      );
    }
  }
  for (const [field, value] of [
    ['executorId', request.executorId],
    ['approvers', approvers.join(' ')],
    ['sourceReference', request.sourceReference],
  ] as const) {
    if (BILLING_CREDENTIAL_SHAPED_RE.test(value)) {
      fail(
        field,
        'invalid_evidence',
        'two_person_authorization',
        `The "${field}" value is credential-shaped and is refused: a publication records named people and a ` +
          'reference, never key or token material.',
      );
    }
  }

  /* --- Check 3: corroboration (D3) ----------------------------------------- */
  if (isUrlShaped(request.sourceReference)) {
    fail(
      'sourceReference',
      'corroboration_missing',
      'corroboration',
      'The source reference must identify the corroborating bulletin, document or ticket — not a URL. A ' +
        'publisher URL is not evidence that a figure was published, and the approved publisher host is ' +
        'already pinned elsewhere.',
    );
  }

  /* --- Check 2: exact decimal rate ----------------------------------------- */
  let decimal: { scaled: bigint; scale: number } | null = null;
  try {
    decimal = parseFxRateDecimal(request.rate);
  } catch (error) {
    if (error instanceof BillingFxError) {
      fail('rate', 'invalid_rate', 'rate_precision', error.message);
    } else {
      throw error;
    }
  }

  /* --- Check 1: magnitude / direction against the last published version ---- */
  let previous: BillingFxRateVersion | null = null;
  if (input.previousVersion !== undefined && input.previousVersion !== null) {
    try {
      previous = parseFxRateVersion(input.previousVersion);
    } catch (error) {
      if (error instanceof BillingFxError) {
        fail(
          'previousVersion',
          'missing_evidence',
          'rate_plausibility',
          `The previously published FX version could not be read, so this rate cannot be sanity-checked ` +
            `against it: ${error.message}`,
        );
      } else {
        throw error;
      }
    }
  }

  let driftBasisPoints: number | null = null;
  if (decimal !== null && previous !== null) {
    // Exact rational comparison, no float: compare 10^a·r_new against factor·10^b·r_prev.
    const newValue = decimal.scaled * 10n ** BigInt(previous.fxRateScale);
    const oldValue = previous.fxRateScaled * 10n ** BigInt(decimal.scale);
    const factor = BigInt(FX_PUBLICATION_MAGNITUDE_FACTOR);
    if (newValue > factor * oldValue || newValue * factor < oldValue) {
      fail(
        'rate',
        'rate_implausible',
        'rate_plausibility',
        `A rate of ${request.rate} GHS per USD is more than ${FX_PUBLICATION_MAGNITUDE_FACTOR}x away from the ` +
          `last published version (${previous.fxRateScaled}@${previous.fxRateScale}). This is normally an ` +
          'inverted or mis-entered figure; nothing was published.',
      );
    } else {
      // Drift in basis points, integer arithmetic only.
      const delta = newValue >= oldValue ? newValue - oldValue : oldValue - newValue;
      driftBasisPoints = Number((delta * 10_000n) / oldValue);
    }
  }

  /* --- Check 4: drift explained -------------------------------------------- */
  const driftJustification = request.driftJustification ?? null;
  if (
    driftBasisPoints !== null &&
    driftBasisPoints > FX_PUBLICATION_DRIFT_THRESHOLD_BASIS_POINTS &&
    driftJustification === null
  ) {
    fail(
      'driftJustification',
      'drift_unexplained',
      'drift_explained',
      `This rate moves ${driftBasisPoints} basis points from the last published version, above the ` +
        `${FX_PUBLICATION_DRIFT_THRESHOLD_BASIS_POINTS}-basis-point review threshold. Supply a written ` +
        'justification, or correct the rate: a large move may be published deliberately, never silently.',
    );
  }

  /* --- Timestamps (D2) ------------------------------------------------------ */
  const capturedAt = parseInstant(request.capturedAt);
  if (capturedAt === null) {
    fail(
      'capturedAt',
      'invalid_instant',
      'dry_run_validation',
      'The capture instant must be a timezone-bearing ISO 8601 timestamp — it is the adoption/approval ' +
        'instant, never the publisher’s bulletin time.',
    );
  }
  // Default: the same instant. The effective instant is NEVER inferred from the
  // publisher, and neither value is ever back-dated (D2).
  const effectiveFromText = request.effectiveFrom ?? request.capturedAt;
  const effectiveFrom = parseInstant(effectiveFromText);
  if (effectiveFrom === null) {
    fail(
      'effectiveFrom',
      'invalid_instant',
      'dry_run_validation',
      'The effective instant must be a timezone-bearing ISO 8601 timestamp (omit it to use the capture ' +
        'instant).',
    );
  }

  /* --- Check 5: ordering ---------------------------------------------------- */
  if (effectiveFrom !== null && previous !== null) {
    if (effectiveFrom.getTime() <= previous.effectiveFrom.getTime()) {
      fail(
        'effectiveFrom',
        'ordering_conflict',
        'ordering',
        `The effective instant ${effectiveFrom.toISOString()} is not strictly later than the version already ` +
          `published at ${previous.effectiveFrom.toISOString()} (${previous.id}). A correction is published ` +
          'FORWARD, with a later effective instant; a published version is never re-dated.',
      );
    }
  }

  /* --- Check 6: internal validation + freshness (the dry-run authorities) --- */
  // A capture in the future is refused EXPLICITLY, before the authority is
  // consulted, so the refusal names the right cause ('not_yet_effective' rather
  // than a generic malformed-evidence error). The authority's own check remains
  // in force below as defence in depth.
  const captureIsFuture = capturedAt !== null && capturedAt.getTime() > asOf.getTime();
  if (captureIsFuture) {
    fail(
      'capturedAt',
      'not_yet_effective',
      'dry_run_validation',
      `The rate was captured at ${capturedAt.toISOString()}, after the publication instant ` +
        `${asOf.toISOString()}: a capture in the future cannot be published, and the capture instant is the ` +
        'adoption/approval instant, never a later one.',
    );
  }

  if (!captureIsFuture && decimal !== null && capturedAt !== null && effectiveFrom !== null) {
    try {
      const version = parseFxRateVersion({
        id: CANDIDATE_ROW_ID,
        base_currency: policy.baseCurrency,
        quote_currency: policy.quoteCurrency,
        fx_rate_scaled: decimal.scaled.toString(),
        fx_rate_scale: decimal.scale,
        rounding_mode: policy.roundingMode,
        source: FX_PUBLICATION_SOURCE,
        source_reference: request.sourceReference,
        created_by: request.executorId,
        effective_from: effectiveFrom,
        captured_at: capturedAt,
      });
      // The 900-second bound (D1), unchanged: a version that cannot legally
      // price a NEW chargeable epoch must not be published as if it could.
      assertFxRateVersionFresh(version, asOf, policy);
      if (effectiveFrom.getTime() > asOf.getTime()) {
        fail(
          'effectiveFrom',
          'not_yet_effective',
          'dry_run_validation',
          `The rate only becomes effective at ${effectiveFrom.toISOString()}, after the publication instant ` +
            `${asOf.toISOString()}; a rate that is not yet effective cannot price a payment.`,
        );
      }
    } catch (error) {
      if (error instanceof BillingFxError) {
        const reason: FxPublicationFailureReason =
          error.reason === 'stale'
            ? 'stale'
            : error.reason === 'missing'
              ? 'missing_evidence'
              : error.reason === 'invalid'
                ? 'invalid_evidence'
                : 'invalid_evidence';
        fail(
          error.reason === 'stale' ? 'capturedAt' : 'request',
          reason,
          'dry_run_validation',
          error.message,
        );
      } else {
        throw error;
      }
    }
  }

  /* --- Check 7: downstream intent ------------------------------------------- */
  if (request.downstream.epochRegistrationPlanned && request.downstream.registrant === undefined) {
    fail(
      'downstream.registrant',
      'invalid_evidence',
      'downstream_intent',
      'Provider-plan epochs are to be registered against this version, so the named registrant is ' +
        'required: the 900-second bound means a registration must follow within 15 minutes, and an ' +
        'unattended publication cannot satisfy it.',
    );
  }

  const valid = issues.length === 0;
  const checks: FxPublicationCheck[] = FX_PUBLICATION_CHECK_NAMES.map((name) => ({
    name,
    status: issues.some((issue) => issue.check === name) ? 'fail' : 'pass',
  }));

  const candidate: ValidatedFxPublication | null =
    valid && decimal !== null && capturedAt !== null && effectiveFrom !== null
      ? {
          baseCurrency: policy.baseCurrency,
          quoteCurrency: policy.quoteCurrency,
          fxRateScaled: decimal.scaled,
          fxRateScale: decimal.scale,
          rateDecimal: request.rate.trim(),
          roundingMode: policy.roundingMode,
          source: FX_PUBLICATION_SOURCE,
          sourceReference: request.sourceReference,
          executorId: request.executorId,
          approvers,
          reason: request.reason,
          driftJustification,
          driftBasisPoints,
          capturedAt,
          effectiveFrom,
          epochRegistrationPlanned: request.downstream.epochRegistrationPlanned,
          registrant: request.downstream.registrant ?? null,
          pricingPolicyVersion: policy.version,
          publicationPolicyVersion: FX_PUBLICATION_POLICY_VERSION,
          previousVersionId: previous === null ? null : previous.id,
        }
      : null;

  return {
    valid,
    checks,
    issues,
    candidate,
    evaluatedAt: asOf.toISOString(),
    databaseWrites: 0,
    published: false,
    limitations: FX_PUBLICATION_LIMITATIONS,
  };
}

/** A placeholder row id used to reuse the authority's parser. Never persisted. */
const CANDIDATE_ROW_ID = '00000000-0000-4000-8000-000000000000';

/* -------------------------------------------------------------------------- */
/* Durable publication (the only approved writer)                             */
/* -------------------------------------------------------------------------- */

export interface FxPublicationResult {
  readonly version: BillingFxRateVersion;
  readonly assessment: FxPublicationAssessment;
  readonly auditEntityId: string;
  readonly publishedAt: string;
}

/**
 * The approved writer for `billing_fx_rate_versions`.
 *
 * One transaction, exactly two INSERTs: the version row and its
 * `billing.fx_rate_published` audit row (D4). A publication that cannot record
 * who authorized it does not exist — the audit failure propagates and rolls the
 * version back. Nothing else is read for writing and nothing else is written
 * (D8), so a publication cannot move a price, an epoch or a provider plan.
 */
export class FxPublicationService {
  constructor(
    private readonly db: Pool,
    private readonly options: { policy?: BillingFxPolicy; now?: () => Date } = {},
  ) {}

  private get policy(): BillingFxPolicy {
    return this.options.policy ?? BILLING_FX_POLICY;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Read-only assessment (D10's dry run): reads the newest published version and
   * runs all eight checks. Opening no transaction and issuing no INSERT, it can
   * publish nothing.
   */
  async assess(request: unknown, asOf?: Date): Promise<FxPublicationAssessment> {
    const instant = asOf ?? this.now();
    const previous = await this.readLatestVersion(this.db, instant);
    return validateFxPublication({ request, previousVersion: previous, asOf: instant, policy: this.policy });
  }

  /**
   * Publish an approved rate version, atomically with its audit event.
   *
   * Every check runs INSIDE the transaction, after the advisory lock and before
   * the first INSERT, so no evidence is validated against a stale view of the
   * authority and a concurrent publication cannot slip between the ordering
   * check and the write.
   */
  async publish(request: unknown, asOf?: Date): Promise<FxPublicationResult> {
    const instant = asOf ?? this.now();
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Serialize publications: the ordering and drift checks read the latest
      // version, and two racing runs must not both read the same predecessor.
      await client.query('SELECT pg_advisory_xact_lock($1)', [FX_PUBLICATION_ADVISORY_LOCK_KEY]);

      const previous = await this.readLatestVersion(client, instant);
      const assessment = validateFxPublication({
        request,
        previousVersion: previous,
        asOf: instant,
        policy: this.policy,
      });

      if (!assessment.valid || assessment.candidate === null) {
        const primary = assessment.issues[0];
        throw new FxPublicationError(
          primary?.reason ?? 'invalid_evidence',
          `The publication was refused (${assessment.issues.length} issue(s)); nothing was written. ` +
            assessment.issues.map((issue) => `[${issue.check}] ${issue.message}`).join(' '),
        );
      }

      const candidate = assessment.candidate;

      const { rows } = await client.query(
        `INSERT INTO billing_fx_rate_versions
           (base_currency, quote_currency, fx_rate_scaled, fx_rate_scale, rounding_mode,
            source, source_reference, created_by, effective_from, captured_at, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         RETURNING *`,
        [
          candidate.baseCurrency,
          candidate.quoteCurrency,
          candidate.fxRateScaled.toString(),
          candidate.fxRateScale,
          candidate.roundingMode,
          candidate.source,
          candidate.sourceReference,
          candidate.executorId,
          candidate.effectiveFrom,
          candidate.capturedAt,
        ],
      );

      let version: BillingFxRateVersion;
      try {
        version = parseFxRateVersion(rows[0]);
      } catch (error) {
        throw new FxPublicationError(
          error instanceof BillingFxError ? 'invalid_evidence' : 'invalid_evidence',
          'The published row did not re-read as a valid FX version; the publication was rolled back.',
          { cause: error },
        );
      }

      // D4 — the audit event rides THIS transaction. `recordAuditEvent`
      // propagates failure rather than swallowing it, which is exactly why it is
      // the right helper here: a swallowed failure would leave a published rate
      // with no record of who approved it.
      try {
        await recordAuditEvent(client, {
          action: FX_PUBLICATION_AUDIT_ACTION,
          entityType: 'billing_fx_rate_version',
          entityId: version.id,
          metadata: {
            operatorId: candidate.executorId,
            approvers: [...candidate.approvers],
            reason: candidate.reason,
            sourceReference: candidate.sourceReference,
            fxRateVersionId: version.id,
            // Written as a string: money/rate arithmetic is integer and JSON has
            // no BigInt, so the audit record never rounds a rate.
            fxRateScaled: candidate.fxRateScaled.toString(),
            fxRateScale: candidate.fxRateScale,
            roundingMode: candidate.roundingMode,
            source: candidate.source,
            capturedAt: candidate.capturedAt.toISOString(),
            effectiveFrom: candidate.effectiveFrom.toISOString(),
            driftBasisPoints: candidate.driftBasisPoints,
            driftJustification: candidate.driftJustification,
            epochRegistrationPlanned: candidate.epochRegistrationPlanned,
            registrant: candidate.registrant,
            previousVersionId: candidate.previousVersionId,
            pricingPolicyVersion: candidate.pricingPolicyVersion,
            publicationPolicyVersion: candidate.publicationPolicyVersion,
            // Pinned: publishing a rate confirms no payment, grants no execution
            // and moves no price. A customer-facing amount changes only through a
            // separately approved epoch rotation (D9).
            paymentConfirmed: false,
            grantsExecution: false,
            priceChanged: false,
            providerPlansUnchanged: true,
          },
        });
      } catch (error) {
        throw new FxPublicationError(
          'audit_failed',
          'The FX publication was refused: the transactional audit event could not be written, so no rate ' +
            'version was published.',
          { cause: error },
        );
      }

      await client.query('COMMIT');
      return {
        version,
        assessment,
        auditEntityId: version.id,
        publishedAt: version.capturedAt.toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isFxPublicationError(error)) throw error;
      // A unique-index violation on (base, quote, effective_from) is a
      // same-instant contradiction, never something to retry into place.
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        throw new FxPublicationError(
          'conflict',
          'A rate version is already effective at that instant. One rate per pair per instant is the ' +
            'authority’s rule; two versions effective at the same moment are a contradiction, not a choice. ' +
            'Nothing was published.',
          { cause: error },
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** The newest version by `effective_from`, read on the caller's client. */
  private async readLatestVersion(
    runner: Pick<pg.Pool | pg.PoolClient, 'query'>,
    _asOf: Date,
  ): Promise<unknown | null> {
    const { rows } = await runner.query(
      `SELECT * FROM billing_fx_rate_versions
        WHERE base_currency = $1 AND quote_currency = $2
        ORDER BY effective_from DESC
        LIMIT 1`,
      [this.policy.baseCurrency, this.policy.quoteCurrency],
    );
    return rows[0] ?? null;
  }
}
