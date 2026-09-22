import { z } from 'zod';
import type { Pool } from 'pg';
import {
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
    id: z.string().uuid(),
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
  | 'unsupported_currency';

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
  effectiveFrom: Date;
  capturedAt?: Date;
  source: BillingFxSource;
  sourceReference?: string | null;
  createdBy?: string | null;
  roundingMode?: BillingRoundingMode;
}

/**
 * Postgres-backed authority for FX rate versions.
 *
 * `publish()` APPENDS a version (an immutable row). There is no update path and
 * no delete path, by construction here and by trigger in migration 0032: a
 * published rate can never be edited or re-dated, so a payment that was priced
 * at 09:00 can still be explained later.
 */
export class BillingFxRateVersionStore {
  constructor(
    private readonly db: Pool,
    private readonly policy: BillingFxPolicy = BILLING_FX_POLICY,
  ) {}

  async publish(input: PublishFxRateVersionInput): Promise<BillingFxRateVersion> {
    const capturedAt = input.capturedAt ?? new Date();
    const { rows } = await this.db.query(
      `INSERT INTO billing_fx_rate_versions
         (base_currency, quote_currency, fx_rate_scaled, fx_rate_scale, rounding_mode,
          source, source_reference, created_by, effective_from, captured_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       RETURNING *`,
      [
        this.policy.baseCurrency,
        this.policy.quoteCurrency,
        input.fxRateScaled.toString(),
        input.fxRateScale,
        input.roundingMode ?? this.policy.roundingMode,
        input.source,
        input.sourceReference ?? null,
        input.createdBy ?? null,
        input.effectiveFrom,
        capturedAt,
      ],
    );
    return parseFxRateVersion(rows[0]);
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
