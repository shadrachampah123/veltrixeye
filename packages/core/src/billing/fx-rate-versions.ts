import { z } from 'zod';
import type { Pool } from 'pg';
import {
  BILLING_CREDENTIAL_SHAPED_RE,
  BILLING_CURRENCY,
  BILLING_FX_SOURCES,
  BILLING_PAYMENT_CURRENCIES,
  BILLING_ROUNDING_MODES,
  type BillingFxSnapshot,
  type BillingFxSource,
  type BillingPaymentCurrency,
  type BillingRoundingMode,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';

/**
 * Billing PR3 — the AUTHORITATIVE, server-side FX rate boundary.
 *
 * The commercial catalogue is priced in USD; customers are charged the payment
 * currency (Ghana: GHS). This module owns the only FX facts the platform
 * accepts:
 *
 *   * a rate version is a durable, immutable, append-only ROW
 *     (`billing_fx_rate_versions`, migration 0032) published by the platform or
 *     an operator;
 *   * a rate is resolved by `effective_from <= asOf`, newest first — never by
 *     "the latest one that exists";
 *   * freshness is bounded: a rate older than the approved maximum age can
 *     never price a payment (`BILLING_FX_POLICY.maxAgeSeconds`, 15 minutes);
 *   * anything unknown, missing, stale, ambiguous or malformed FAILS CLOSED —
 *     there is no default rate, no last-known-good fallback and no partial
 *     conversion.
 *
 * WHAT THIS MODULE NEVER DOES
 *  - It makes NO network call, of any kind. Rates are never fetched from a
 *    market feed, a provider API, a browser or a client. The only I/O is
 *    Postgres, and only through the repository at the bottom of this file
 *    (`BillingFxRateVersionStore`), which is optional to use — the resolver
 *    itself is pure.
 *  - It never converts, rounds or computes a payable amount: that is
 *    `./pricing.ts`, which consumes a resolved version through the pure
 *    `toBillingFxSnapshot()` below.
 *  - It never accepts a rate supplied by a caller outside the platform's own
 *    durable authority. `BillingFxRateVersionStore.publish()` is the only
 *    writing path, and it writes a new immutable version (never an update).
 *
 * Callers inject the time they price at (`asOf`). Nothing in this file reads a
 * clock implicitly, so pricing is reproducible and testable.
 */

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The approved pricing/FX policy. Recorded on every snapshot as
 * `pricingPolicyVersion`, so a snapshot taken under an older policy stays
 * explainable after this constant changes.
 */
export const BILLING_PRICING_POLICY_VERSION = 'pr3-usd-ghs-v1' as const;

export interface BillingFxPolicy {
  readonly version: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: BillingPaymentCurrency;
  readonly roundingMode: BillingRoundingMode;
  /** Maximum age of a rate version at pricing time (D-3: fifteen minutes). */
  readonly maxAgeSeconds: number;
  /** Allowed range for the scaled-integer rate, mirroring the 0032 CHECKs. */
  readonly minScale: number;
  readonly maxScale: number;
}

export const BILLING_FX_POLICY: BillingFxPolicy = Object.freeze({
  version: BILLING_PRICING_POLICY_VERSION,
  baseCurrency: BILLING_CURRENCY,
  quoteCurrency: 'GHS' as BillingPaymentCurrency,
  roundingMode: 'half_up' as BillingRoundingMode,
  maxAgeSeconds: 15 * 60,
  minScale: 1,
  maxScale: 18,
});

/* -------------------------------------------------------------------------- */
/* Row contract (what the durable authority stores)                           */
/* -------------------------------------------------------------------------- */

/**
 * Durable row shapes. `pg` returns `bigint` (int8) columns as strings and
 * `timestamptz` as `Date`, so the input shape accepts both and the parsed shape
 * is normalized (BigInt / Date). Anything else is a validation failure — a
 * malformed authority row must never become a price.
 */
const scaledInteger = z.union([
  z.bigint(),
  z.string().regex(/^[0-9]+$/, 'a scaled integer must be an unsigned integer string'),
  z.number().int().safe(),
]);

const timestamp = z.union([z.date(), z.string().datetime()]).transform((value) => new Date(value));

export const billingFxRateVersionRowSchema = z
  .object({
    id: z.string().guid(),
    base_currency: z.string(),
    quote_currency: z.string(),
    fx_rate_scaled: scaledInteger.transform((value) => BigInt(value)),
    fx_rate_scale: z.number().int(),
    rounding_mode: z.string(),
    source: z.string(),
    source_reference: z.string().nullable().optional(),
    created_by: z.string().nullable().optional(),
    effective_from: timestamp,
    captured_at: timestamp,
    published_at: timestamp.optional(),
    created_at: timestamp.optional(),
  })
  .strict();

export type BillingFxRateVersionRow = z.infer<typeof billingFxRateVersionRowSchema>;

/** Normalized, validated FX rate version. */
export interface BillingFxRateVersion {
  readonly id: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: BillingPaymentCurrency;
  readonly fxRateScaled: bigint;
  readonly fxRateScale: number;
  readonly roundingMode: BillingRoundingMode;
  readonly source: BillingFxSource;
  readonly sourceReference: string | null;
  readonly createdBy: string | null;
  readonly effectiveFrom: Date;
  readonly capturedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Failures — typed, explicit, never silent                                   */
/* -------------------------------------------------------------------------- */

export type BillingFxFailureReason =
  | 'missing'
  | 'stale'
  | 'invalid'
  | 'ambiguous'
  | 'unsupported_currency'
  /**
   * Publication refused: the source approval is missing, unrecorded, malformed,
   * or does not match this exact source, source reference and currency pair.
   * Nothing was written.
   */
  | 'source_not_approved'
  /** Publication refused: the source is not in {@link FX_PUBLICATION_PERMITTED_SOURCES}. */
  | 'source_not_permitted'
  /** Publication refused: the approval was already consumed by an earlier publication (single-use). */
  | 'approval_consumed'
  /** Publication refused: the approval is past its validity window. */
  | 'approval_expired'
  /** Publication refused: the publisher login is the login that recorded the approval. */
  | 'separation_of_duties'
  /** Refused by the database: the session login lacks the required approver or publisher role. */
  | 'principal_unauthorized';

/** A rate that cannot price a payment. Always a hard failure (fail closed). */
export class BillingFxError extends Error {
  readonly code = 'billing_fx_unavailable' as const;

  constructor(
    readonly reason: BillingFxFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingFxError';
  }
}

export function isBillingFxError(error: unknown): error is BillingFxError {
  return error instanceof BillingFxError;
}

/* -------------------------------------------------------------------------- */
/* Validation + resolution (pure)                                             */
/* -------------------------------------------------------------------------- */

function ms(value: Date): number {
  return value.getTime();
}

/**
 * Validate one authority row in isolation. Returns the normalized version or
 * throws `BillingFxError('invalid')`: an unusable rate is never "roughly
 * usable".
 */
export function parseFxRateVersion(row: unknown): BillingFxRateVersion {
  const parsed = billingFxRateVersionRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new BillingFxError(
      'invalid',
      `The FX rate version is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const value = parsed.data;

  if (value.base_currency !== BILLING_FX_POLICY.baseCurrency) {
    throw new BillingFxError(
      'unsupported_currency',
      `An FX rate for base currency "${value.base_currency}" cannot price a ${BILLING_FX_POLICY.baseCurrency} commercial amount.`,
    );
  }
  if (!(BILLING_PAYMENT_CURRENCIES as readonly string[]).includes(value.quote_currency)) {
    throw new BillingFxError(
      'unsupported_currency',
      `An FX rate quoting "${value.quote_currency}" is not a supported payment currency.`,
    );
  }
  if (!(BILLING_FX_SOURCES as readonly string[]).includes(value.source)) {
    throw new BillingFxError('invalid', `Unknown FX rate source "${value.source}".`);
  }
  if (!(BILLING_ROUNDING_MODES as readonly string[]).includes(value.rounding_mode)) {
    throw new BillingFxError('invalid', `Unsupported rounding mode "${value.rounding_mode}".`);
  }
  if (value.fx_rate_scaled <= 0n) {
    throw new BillingFxError('invalid', 'An FX rate must be strictly positive.');
  }
  if (
    !Number.isInteger(value.fx_rate_scale) ||
    value.fx_rate_scale < BILLING_FX_POLICY.minScale ||
    value.fx_rate_scale > BILLING_FX_POLICY.maxScale
  ) {
    throw new BillingFxError(
      'invalid',
      `An FX rate scale must be an integer between ${BILLING_FX_POLICY.minScale} and ${BILLING_FX_POLICY.maxScale}.`,
    );
  }
  if (!Number.isFinite(ms(value.effective_from)) || !Number.isFinite(ms(value.captured_at))) {
    throw new BillingFxError('invalid', 'An FX rate version must carry valid timestamps.');
  }
  if (ms(value.captured_at) > ms(value.effective_from)) {
    throw new BillingFxError(
      'invalid',
      'A rate is captured (published) at or before the moment it becomes effective; a back-dated version is rejected.',
    );
  }

  return {
    id: value.id,
    baseCurrency: value.base_currency,
    quoteCurrency: value.quote_currency as BillingPaymentCurrency,
    fxRateScaled: value.fx_rate_scaled,
    fxRateScale: value.fx_rate_scale,
    roundingMode: value.rounding_mode as BillingRoundingMode,
    source: value.source as BillingFxSource,
    sourceReference: value.source_reference ?? null,
    createdBy: value.created_by ?? null,
    effectiveFrom: value.effective_from,
    capturedAt: value.captured_at,
  };
}

/** Age of a rate version at `asOf`, in seconds (negative when not yet captured). */
export function fxRateAgeSeconds(version: BillingFxRateVersion, asOf: Date): number {
  return (ms(asOf) - ms(version.capturedAt)) / 1000;
}

/**
 * Enforce the approved freshness bound. A rate that has aged past the policy
 * maximum can never price a NEW payment — the caller must publish a new
 * version instead (fail closed, never "the closest we have").
 */
export function assertFxRateVersionFresh(
  version: BillingFxRateVersion,
  asOf: Date,
  policy: BillingFxPolicy = BILLING_FX_POLICY,
): void {
  const ageSeconds = fxRateAgeSeconds(version, asOf);
  if (ageSeconds < 0) {
    throw new BillingFxError(
      'invalid',
      `FX rate version ${version.id} is captured in the future relative to the pricing instant.`,
    );
  }
  if (ageSeconds > policy.maxAgeSeconds) {
    throw new BillingFxError(
      'stale',
      `FX rate version ${version.id} is ${Math.floor(ageSeconds)}s old at pricing time; ` +
        `the ${policy.version} policy allows at most ${policy.maxAgeSeconds}s. Publish a new rate version.`,
    );
  }
}

/**
 * Resolve the ONE rate version in force at `asOf`: the newest version whose
 * `effective_from` is at or before the pricing instant, which must also satisfy
 * the freshness bound.
 *
 * Two versions effective at the same instant are ambiguous, and ambiguity is
 * never resolved by picking one: it fails closed. (Migration 0032's UNIQUE
 * index on (base, quote, effective_from) makes this unreachable for durable
 * rows; the check exists so the resolver cannot silently prefer a row.)
 */
export function resolveFxRateVersion(params: {
  versions: readonly unknown[];
  asOf: Date;
  policy?: BillingFxPolicy;
}): BillingFxRateVersion {
  const policy = params.policy ?? BILLING_FX_POLICY;
  const asOfMs = ms(params.asOf);

  if (!Number.isFinite(asOfMs)) {
    throw new BillingFxError('invalid', 'A pricing instant is required to resolve an FX rate.');
  }

  const effective = params.versions
    .map((row) => parseFxRateVersion(row))
    .filter((version) => ms(version.effectiveFrom) <= asOfMs);

  if (effective.length === 0) {
    throw new BillingFxError(
      'missing',
      `No FX rate version for ${policy.baseCurrency}→${policy.quoteCurrency} is effective at the pricing instant. ` +
        'A payment can never be priced without an authoritative, effective rate version.',
    );
  }

  effective.sort((a, b) => ms(b.effectiveFrom) - ms(a.effectiveFrom));
  const newest = effective[0]!;
  const runnerUp = effective[1];

  if (runnerUp && ms(runnerUp.effectiveFrom) === ms(newest.effectiveFrom)) {
    throw new BillingFxError(
      'ambiguous',
      `Two FX rate versions (${runnerUp.id}, ${newest.id}) are effective at ${newest.effectiveFrom.toISOString()}; ` +
        'an ambiguous rate is never priced and never guessed.',
    );
  }

  assertFxRateVersionFresh(newest, params.asOf, policy);
  return newest;
}

/** The snapshot a pricing decision records for a resolved version (pure). */
export function toBillingFxSnapshot(version: BillingFxRateVersion): BillingFxSnapshot {
  return {
    baseCurrency: version.baseCurrency as typeof BILLING_CURRENCY,
    quoteCurrency: version.quoteCurrency,
    fxRateScaled: Number(version.fxRateScaled),
    fxRateScale: version.fxRateScale,
    fxRateVersionId: version.id,
    fxRateEffectiveFrom: version.effectiveFrom.toISOString(),
    fxRateCapturedAt: version.capturedAt.toISOString(),
    fxRateSource: version.source,
    roundingMode: version.roundingMode,
  };
}

/**
 * Deterministic identity of a published rate version, so publishing the same
 * version twice is a recognized duplicate rather than a second rate. (No
 * provider idempotency semantics are involved anywhere in billing.)
 */
export function fxRateVersionKey(params: {
  baseCurrency: string;
  quoteCurrency: string;
  effectiveFrom: Date;
}): string {
  return `${params.baseCurrency}|${params.quoteCurrency}|${params.effectiveFrom.toISOString()}`;
}

/* -------------------------------------------------------------------------- */
/* Durable authority (the ONLY writer of rate versions)                       */
/* -------------------------------------------------------------------------- */

export interface PublishFxRateVersionInput {
  fxRateScaled: bigint;
  fxRateScale: number;
  /** REQUIRED: bound by the approval (the approval fingerprint covers it). */
  effectiveFrom: Date;
  /** REQUIRED: bound by the approval (the approval fingerprint covers it). */
  capturedAt: Date;
  source: BillingFxSource;
  /** The published source reference the approval must name exactly. */
  sourceReference: string;
  roundingMode?: BillingRoundingMode;
  /**
   * The id of the RECORDED, UNCONSUMED, UNEXPIRED approval whose fingerprint
   * equals this exact rate. The publisher is the authenticated database login.
   */
  sourceApprovalId: string;
}

/* -------------------------------------------------------------------------- */
/* Source approval — database-enforced, authenticated principal, single-use   */
/* -------------------------------------------------------------------------- */

/**
 * The FX sources that MAY be approved for publication. `db` (a copy of the
 * platform's own rows) and `config` (an environment-supplied value) are never a
 * market-rate source and are refused outright. Being in this list approves
 * nothing: every publication needs its own recorded, unconsumed, unexpired
 * approval of that exact rate.
 *
 * Policy note: a proposed default for operator review, not an external approval.
 */
export const FX_PUBLICATION_PERMITTED_SOURCES: readonly BillingFxSource[] = Object.freeze([
  'ops',
  'import',
] as BillingFxSource[]);

/** Audit action written by the database when an approval is recorded. */
export const FX_SOURCE_APPROVED_AUDIT_ACTION = 'billing.fx_source_approved' as const;
/** Audit action written by the database when a rate is published. */
export const FX_RATE_PUBLISHED_AUDIT_ACTION = 'billing.fx_rate_published' as const;
/** The approval validity window. Enforced by the database (migration 0040). */
export const FX_APPROVAL_VALIDITY_SECONDS = 60 * 60;

export interface FxSourceApprovalInput {
  /** Must be in {@link FX_PUBLICATION_PERMITTED_SOURCES}. */
  source: BillingFxSource;
  /** The named publication reference (a board or ticket reference). */
  sourceReference: string;
  /** The EXACT proposed rate this approval authorizes. */
  fxRateScaled: bigint;
  fxRateScale: number;
  /** The EXACT proposed effective instant. */
  effectiveFrom: Date;
  /** The EXACT proposed capture instant. */
  capturedAt: Date;
  /** The stated reason for the approval. */
  reason: string;
}

export interface RecordedFxSourceApproval {
  /** The durable approval id to cite at publication. */
  readonly approvalId: string;
  /** The authenticated database login that recorded it. Never caller-supplied. */
  readonly approverPrincipal: string;
  readonly expiresAt: Date;
  /** SHA-256 over every bound field; publication must reproduce it exactly. */
  readonly fingerprint: string;
  readonly source: BillingFxSource;
  readonly sourceReference: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly fxRateScaled: bigint;
  readonly fxRateScale: number;
  readonly effectiveFrom: Date;
  readonly capturedAt: Date;
}

const APPROVAL_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
/** True when the text holds a C0 control character or DEL (checked by code point). */
function containsControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Map a database refusal to a typed failure. Only fixed, reviewed tokens raised
 * by migration 0040 and SQLSTATEs are recognised; anything else is rethrown
 * unchanged so an unexpected failure is never reported as a typed refusal.
 */
function toFxError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === '42501') {
    // Only the two reviewed refusals are "not authorized": the function's own
    // membership check, or EXECUTE denied to a login outside the required role.
    // Any other permission failure is a fault and is rethrown unchanged.
    if (
      message === 'billing_fx_principal_unauthorized' ||
      (typeof message === 'string' &&
        /^permission denied for function billing_(record_fx_source_approval|publish_fx_rate_version)$/.test(message))
    ) {
      return new BillingFxError(
        'principal_unauthorized',
        'The database login is not authorized for this FX operation (it is not a member of the required role). Nothing was written.',
        { cause: error },
      );
    }
    return error;
  }
  if (code === '23505') {
    return new BillingFxError(
      'ambiguous',
      'A published rate already exists for this pair and instant. Nothing was published.',
      { cause: error },
    );
  }
  if (code === '23514') {
    return new BillingFxError(
      'invalid',
      'The FX approval or publication violates a recorded constraint. Nothing was written.',
      { cause: error },
    );
  }
  if (code === 'P0001') {
    switch (message) {
      case 'approval_not_found':
        return new BillingFxError('source_not_approved', 'FX publication refused: the cited source approval does not exist. Nothing was published.', { cause: error });
      case 'approval_mismatch':
        return new BillingFxError(
          'source_not_approved',
          'FX publication refused: the cited approval does not authorize this exact rate (source, reference, pair, rate, scale, rounding, effective or capture time differ). Nothing was published.',
          { cause: error },
        );
      case 'approval_consumed':
        return new BillingFxError('approval_consumed', 'FX publication refused: this approval was already used. Nothing was published.', { cause: error });
      case 'approval_expired':
        return new BillingFxError('approval_expired', 'FX publication refused: this approval has expired. Record a new approval. Nothing was published.', { cause: error });
      case 'separation_of_duties':
        return new BillingFxError('separation_of_duties', 'FX publication refused: the publisher login recorded this approval. Approver and publisher must differ. Nothing was published.', { cause: error });
      case 'source_not_permitted':
        return new BillingFxError('source_not_permitted', 'FX source is not permitted for publication. Nothing was written.', { cause: error });
      default:
        return error;
    }
  }
  return error;
}

function assertApprovalTextNotCredentialShaped(fields: Record<string, string>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (BILLING_CREDENTIAL_SHAPED_RE.test(value)) {
      throw new BillingFxError(
        'invalid',
        `The FX source approval's "${field}" is credential-shaped and is refused: an approval names a publication reference and a reason, never key or token material.`,
      );
    }
  }
}

/**
 * Records FX source approvals through the database. AUTHORIZATION IS THE
 * DATABASE LOGIN: `billing_record_fx_source_approval()` refuses any session whose
 * login is not a member of `veltrixeye_fx_approver`, and records that login as
 * the approver. This class accepts no approver identity from its caller, so a
 * free-text name can never stand in for an authenticated principal.
 *
 * The approval binds the exact rate (value, scale, pair, source, reference,
 * effective and capture instants), expires after {@link FX_APPROVAL_VALIDITY_SECONDS},
 * and can be consumed once. It never publishes a rate.
 *
 * LIMITATION: "the database login" is a person only when each approver has an
 * individual login. The application's shared DATABASE_URL login must not be an
 * approver; see scripts/billing/fx-approval-roles.sql.
 */
export class BillingFxSourceApprovalStore {
  constructor(
    private readonly db: Pool,
    private readonly policy: BillingFxPolicy = BILLING_FX_POLICY,
  ) {}

  async recordApproval(input: FxSourceApprovalInput): Promise<RecordedFxSourceApproval> {
    if (!(BILLING_FX_SOURCES as readonly string[]).includes(input.source)) {
      throw new BillingFxError('invalid', `Unknown FX rate source "${String(input.source)}".`);
    }
    if (!(FX_PUBLICATION_PERMITTED_SOURCES as readonly string[]).includes(input.source)) {
      throw new BillingFxError(
        'source_not_permitted',
        `FX source "${input.source}" is not permitted for publication, so it cannot be approved.`,
      );
    }
    const sourceReference = typeof input.sourceReference === 'string' ? input.sourceReference.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (sourceReference === '' || sourceReference.length > 190 || containsControlCharacter(sourceReference)) {
      throw new BillingFxError('invalid', 'The FX source approval needs a plain publication reference of 1–190 characters.');
    }
    if (reason === '' || reason.length > 500 || containsControlCharacter(reason)) {
      throw new BillingFxError('invalid', 'The FX source approval needs a reason of 1–500 characters.');
    }
    assertApprovalTextNotCredentialShaped({ sourceReference, reason });
    if (typeof input.fxRateScaled !== 'bigint' || input.fxRateScaled <= 0n) {
      throw new BillingFxError('invalid', 'The FX source approval needs a positive rate value.');
    }
    if (!Number.isInteger(input.fxRateScale) || input.fxRateScale < 1 || input.fxRateScale > 18) {
      throw new BillingFxError('invalid', 'The FX source approval needs a rate scale between 1 and 18.');
    }
    if (!(input.effectiveFrom instanceof Date) || !Number.isFinite(input.effectiveFrom.getTime())) {
      throw new BillingFxError('invalid', 'The FX source approval needs a valid effective instant.');
    }
    if (!(input.capturedAt instanceof Date) || !Number.isFinite(input.capturedAt.getTime())) {
      throw new BillingFxError('invalid', 'The FX source approval needs a valid capture instant.');
    }
    if (input.capturedAt.getTime() > input.effectiveFrom.getTime()) {
      throw new BillingFxError('invalid', 'A rate is captured at or before the moment it becomes effective.');
    }

    let row: Record<string, unknown> | undefined;
    try {
      const { rows } = await this.db.query(
        `SELECT out_approval_id::text AS approval_id, out_approver_principal AS approver_principal,
                out_expires_at AS expires_at, out_fingerprint AS fingerprint
           FROM billing_record_fx_source_approval($1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10)`,
        [
          input.source,
          sourceReference,
          this.policy.baseCurrency,
          this.policy.quoteCurrency,
          input.fxRateScaled.toString(),
          input.fxRateScale,
          this.policy.roundingMode,
          input.effectiveFrom,
          input.capturedAt,
          reason,
        ],
      );
      row = rows[0] as Record<string, unknown> | undefined;
    } catch (error) {
      throw toFxError(error);
    }
    if (row === undefined) {
      throw new BillingFxError('invalid', 'The FX source approval was not recorded.');
    }
    return Object.freeze({
      approvalId: String(row.approval_id),
      approverPrincipal: String(row.approver_principal),
      expiresAt: new Date(row.expires_at as Date),
      fingerprint: String(row.fingerprint),
      source: input.source,
      sourceReference,
      baseCurrency: this.policy.baseCurrency,
      quoteCurrency: this.policy.quoteCurrency,
      fxRateScaled: input.fxRateScaled,
      fxRateScale: input.fxRateScale,
      effectiveFrom: input.effectiveFrom,
      capturedAt: input.capturedAt,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Durable authority — publication                                            */
/* -------------------------------------------------------------------------- */

/**
 * Postgres-backed authority for FX rate versions.
 *
 * `publish()` calls `billing_publish_fx_rate_version()`, which in ONE database
 * transaction: checks the publisher role; locks and checks the approval (exists,
 * not consumed, not expired, publisher ≠ approver, fingerprint equal to this exact
 * rate); inserts the version; records the consumption; and writes the
 * `billing.fx_rate_published` audit event. Any failure rolls all of it back, so no
 * version, consumption or audit row can exist without the others.
 *
 * Versions are append-only (migration 0032). The public INSERT privilege on the
 * table is revoked (migration 0040): publication goes through the function.
 */
export class BillingFxRateVersionStore {
  constructor(
    private readonly db: Pool,
    private readonly policy: BillingFxPolicy = BILLING_FX_POLICY,
  ) {}

  async publish(input: PublishFxRateVersionInput): Promise<BillingFxRateVersion> {
    if (!(FX_PUBLICATION_PERMITTED_SOURCES as readonly string[]).includes(input.source)) {
      throw new BillingFxError(
        'source_not_permitted',
        `FX source "${input.source}" is not permitted for publication. Nothing was published.`,
      );
    }
    const sourceReference = typeof input.sourceReference === 'string' ? input.sourceReference : '';
    if (sourceReference.trim() === '') {
      throw new BillingFxError(
        'source_not_approved',
        'FX publication refused: a source reference is required, because the approval names it. Nothing was published.',
      );
    }
    if (typeof input.sourceApprovalId !== 'string' || !APPROVAL_ID_PATTERN.test(input.sourceApprovalId)) {
      throw new BillingFxError(
        'source_not_approved',
        'FX publication refused: the cited source approval id is missing or malformed. Nothing was published.',
      );
    }
    if (!(input.capturedAt instanceof Date) || !Number.isFinite(input.capturedAt.getTime())) {
      throw new BillingFxError('invalid', 'FX publication needs a valid capture instant. Nothing was published.');
    }
    if (!(input.effectiveFrom instanceof Date) || !Number.isFinite(input.effectiveFrom.getTime())) {
      throw new BillingFxError('invalid', 'FX publication needs a valid effective instant. Nothing was published.');
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const { rows: idRows } = await client.query(
        `SELECT * FROM billing_publish_fx_rate_version($1::bigint, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10)`,
        [
          input.sourceApprovalId,
          input.source,
          sourceReference,
          this.policy.baseCurrency,
          this.policy.quoteCurrency,
          input.fxRateScaled.toString(),
          input.fxRateScale,
          input.roundingMode ?? this.policy.roundingMode,
          input.effectiveFrom,
          input.capturedAt,
        ],
      );
      await client.query('COMMIT');
      return parseFxRateVersion(idRows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw toFxError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Resolve the version in force at `asOf`. Only versions already effective are
   * read, newest first; the resolver then applies the freshness bound. A
   * missing/stale/ambiguous rate is a hard failure.
   */
  async resolve(at?: Date): Promise<BillingFxRateVersion> {
    const asOf = at ?? new Date();
    const { rows } = await this.db.query(
      `SELECT * FROM billing_fx_rate_versions
        WHERE base_currency = $1
          AND quote_currency = $2
          AND effective_from <= $3
        ORDER BY effective_from DESC
        LIMIT 2`,
      [this.policy.baseCurrency, this.policy.quoteCurrency, asOf],
    );
    if (rows.length === 0) {
      throw new BillingFxError(
        'missing',
        `No FX rate version for ${this.policy.baseCurrency}→${this.policy.quoteCurrency} is effective at the pricing instant.`,
      );
    }
    return resolveFxRateVersion({ versions: rows, asOf, policy: this.policy });
  }

  /** True when a usable rate exists at `at` — used by fail-closed composition. */
  async isUsable(at?: Date): Promise<boolean> {
    try {
      await this.resolve(at);
      return true;
    } catch (error) {
      if (isBillingFxError(error)) return false;
      throw Errors.providerUnavailable('The FX rate authority could not be read.', error);
    }
  }
}
