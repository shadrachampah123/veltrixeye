import { createHash } from 'node:crypto';
import {
  BILLING_CURRENCY,
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  billingFxSnapshotSchema,
  billingPricingSnapshotSchema,
  type BillingFxSnapshot,
  type BillingInterval,
  type BillingPaymentCurrency,
  type BillingPricingSnapshot,
  type CommercialPlanId,
} from '@veltrixeye/contracts';
import { BILLING_CATALOGUE_VERSION, cataloguePriceMinor, unmappedCommercialPlans } from './catalogue.js';
import {
  BILLING_FX_POLICY,
  BILLING_PRICING_POLICY_VERSION,
  type BillingFxPolicy,
} from './fx-rate-versions.js';

/**
 * Billing PR3 — the pure USD→payment-currency pricing boundary.
 *
 * WHAT THIS MODULE IS
 *  - The ONE place a payable amount is computed. Input: the authoritative
 *    catalogue amount (USD, minor units) for a plan + interval, plus an
 *    already-authoritative FX snapshot (resolved by `./fx-rate-versions.ts`),
 *    plus the instant the price is being taken at. Output: an auditable
 *    pricing snapshot.
 *  - Pure and deterministic: no I/O, no network, no clock, no randomness, no
 *    provider call. The same inputs always produce the same amount and the same
 *    snapshot, which is why a charge can be explained years later.
 *  - Integer-only: all arithmetic is `bigint`. A floating-point money
 *    calculation is impossible here — there is no float anywhere in this file's
 *    computation, and the tests assert that by source.
 *
 * WHAT THIS MODULE IS NOT
 *  - It is NOT a price source: the commercial amount always comes from the
 *    catalogue (`./catalogue.ts`), which is the single authority. A client,
 *    a provider, a header, a query parameter or an environment variable can
 *    never supply a price through this boundary.
 *  - It does NOT fetch, derive or guess an FX rate: it consumes a rate that
 *    `./fx-rate-versions.ts` resolved from the platform's own immutable version
 *    table.
 *  - It never calls the payment provider, never creates a plan and never
 *    charges anything.
 *
 * ROUNDING (D-2): exactly ONE final rounding step, half-up, applied to the
 * exact ratio `usd_minor × rate_scaled / D`, where `D = 10^rate_scale` is the
 * power of ten the rate is expressed in (`fxRateScaled = rate × 10^scale`):
 *
 *     payable_minor = floor( (2 · usd_minor · rate_scaled + D) / (2 · D) )
 *
 * Two units cancel deliberately: a USD CENT is 1/100 of the commercial unit and
 * a GHS PESEWA is 1/100 of the payment unit, so the minor-unit answer is
 * `usd_minor × rate` — no exponent correction is applied on top, and none may
 * be. The whole computation is integer arithmetic (see
 * `computePaymentAmountMinor`): the rounding step is the ONLY place precision is
 * decided.
 */

/* -------------------------------------------------------------------------- */
/* Policy constants                                                           */
/* -------------------------------------------------------------------------- */

export { BILLING_PRICING_POLICY_VERSION };

/**
 * The minimum chargeable amount per payment currency, in minor units. GHS:
 * ₵0.10 = 10 pesewas — the documented minimum for the payment provider's Ghana
 * (GHS) transactions. A computed amount below a documented provider minimum is
 * a hard failure, never rounded up silently and never charged as zero.
 */
export const BILLING_PAYMENT_MINIMUM_MINOR: Readonly<Record<BillingPaymentCurrency, bigint>> =
  Object.freeze({ GHS: 10n });

export type BillingPricingFailureReason =
  | 'invalid_input'
  | 'unsupported_currency'
  | 'invalid_fx'
  | 'stale_fx'
  | 'below_minimum'
  | 'unsupported_amount'
  | 'invalid_snapshot'
  | 'amount_mismatch';

/** A pricing decision that cannot be made. Always fail closed. */
export class BillingPricingError extends Error {
  readonly code = 'billing_pricing_failed' as const;

  constructor(
    readonly reason: BillingPricingFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingPricingError';
  }
}

export function isBillingPricingError(error: unknown): error is BillingPricingError {
  return error instanceof BillingPricingError;
}

/* -------------------------------------------------------------------------- */
/* Exact integer conversion (the ONLY rounding step)                          */
/* -------------------------------------------------------------------------- */

/**
 * Convert a minor-unit amount at one FX rate into the payment currency, with
 * exactly one half-up rounding step and integer arithmetic only.
 *
 * `usdMinor` and `rateScaled` must be non-negative integers (BigInt);
 * `rateScale` a positive integer. The exact ratio is
 * `usdMinor · rateScaled / rateScale`, and the result is that ratio rounded
 * half-up to an integer:
 *
 *     floor( (2·usdMinor·rateScaled + rateScale) / (2·rateScale) )
 *
 * (equivalently `floor(x + 1/2)` for the exact rational `x`). No intermediate
 * value is rounded, truncated or rounded twice.
 */
export function computePaymentAmountMinor(params: {
  usdMinor: bigint;
  rateScaled: bigint;
  rateScale: number;
}): bigint {
  const { usdMinor, rateScaled, rateScale } = params;

  if (usdMinor <= 0n) {
    throw new BillingPricingError(
      'invalid_input',
      'A commercial amount must be strictly positive to be converted.',
    );
  }
  if (rateScaled <= 0n) {
    throw new BillingPricingError('invalid_fx', 'An FX rate must be strictly positive.');
  }
  if (
    !Number.isInteger(rateScale) ||
    rateScale < BILLING_FX_POLICY.minScale ||
    rateScale > BILLING_FX_POLICY.maxScale
  ) {
    throw new BillingPricingError(
      'invalid_fx',
      `An FX rate scale must be an integer between ${BILLING_FX_POLICY.minScale} and ${BILLING_FX_POLICY.maxScale}.`,
    );
  }

  // D = 10^rateScale: the denominator the scaled rate is expressed against.
  // `rateScaled / 10^rateScale` IS the rate, so the exact payable amount is
  // `usdMinor · rateScaled / D` (see the module header on why the currency
  // exponents cancel), rounded half-up in exactly one step:
  //   floor(x + 1/2) = floor((2·N + D) / (2·D))  for the exact ratio x = N/D.
  const denominator = 10n ** BigInt(rateScale);
  const numerator = 2n * usdMinor * rateScaled + denominator;
  return numerator / (2n * denominator);
}

/** Narrow a computed minor amount to a JSON-safe integer, or fail closed. */
function toSafeMinor(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BillingPricingError(
      'unsupported_amount',
      `${label} exceeds the largest exactly representable amount; the pricing boundary refuses to round it.`,
    );
  }
  return Number(value);
}

/* -------------------------------------------------------------------------- */
/* Freshness                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Freshness of a NEW price: the snapshot's captured-at must be within the
 * approved maximum age at the pricing instant (D-3). This is enforced when
 * pricing, and deliberately NOT when verifying a locked snapshot — an
 * authorized recurring amount stays exactly as authorized after its rate ages
 * (D-1 = A, D-8).
 */
export function assertFxSnapshotFresh(
  fx: BillingFxSnapshot,
  asOf: Date,
  policy: BillingFxPolicy = BILLING_FX_POLICY,
): void {
  const capturedMs = Date.parse(fx.fxRateCapturedAt);
  const asOfMs = asOf.getTime();
  if (!Number.isFinite(capturedMs) || !Number.isFinite(asOfMs)) {
    throw new BillingPricingError('invalid_input', 'A finite pricing instant and FX capture time are required.');
  }
  const ageSeconds = (asOfMs - capturedMs) / 1000;
  if (ageSeconds < 0) {
    throw new BillingPricingError(
      'invalid_fx',
      'The FX snapshot is captured after the pricing instant; a rate from the future cannot price a payment.',
    );
  }
  if (ageSeconds > policy.maxAgeSeconds) {
    throw new BillingPricingError(
      'stale_fx',
      `The FX rate is ${Math.floor(ageSeconds)}s old at pricing time; the ${policy.version} policy allows at most ` +
        `${policy.maxAgeSeconds}s. Publish a new rate version and price again.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Pricing                                                                    */
/* -------------------------------------------------------------------------- */

export interface PriceCommercialPlanInput {
  /** COMMERCIAL plan from the authoritative catalogue. */
  planId: CommercialPlanId;
  interval: BillingInterval;
  /** FX facts resolved from the platform's immutable rate authority. */
  fx: BillingFxSnapshot;
  /** The pricing instant (injected — nothing here reads a clock). */
  asOf: Date;
  /** Provider plan/secondary reference, when the price is bound to a mapping. */
  providerPlanId?: string | null;
  providerReference?: string | null;
  policy?: BillingFxPolicy;
}

/**
 * Price a catalogue plan in the payment currency and return the auditable
 * snapshot. Fails closed on: an unknown/unsellable plan, a malformed or
 * mismatched FX snapshot, a stale or future-dated rate, a non-positive
 * commercial amount, or a computed amount below the documented provider
 * minimum.
 */
export function priceCommercialPlan(input: PriceCommercialPlanInput): BillingPricingSnapshot {
  const policy = input.policy ?? BILLING_FX_POLICY;

  const fxParsed = billingFxSnapshotSchema.safeParse(input.fx);
  if (!fxParsed.success) {
    throw new BillingPricingError(
      'invalid_fx',
      `The FX snapshot is not usable: ${fxParsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const fx = fxParsed.data;

  if (fx.baseCurrency !== BILLING_CURRENCY) {
    throw new BillingPricingError(
      'unsupported_currency',
      `The FX snapshot converts from "${fx.baseCurrency}"; the commercial catalogue is ${BILLING_CURRENCY}.`,
    );
  }
  if (!(policy.quoteCurrency === fx.quoteCurrency)) {
    throw new BillingPricingError(
      'unsupported_currency',
      `The FX snapshot quotes "${fx.quoteCurrency}", which is not the configured payment currency "${policy.quoteCurrency}".`,
    );
  }
  if (fx.roundingMode !== policy.roundingMode) {
    throw new BillingPricingError(
      'invalid_fx',
      `The FX snapshot records rounding mode "${fx.roundingMode}"; the ${policy.version} policy requires "${policy.roundingMode}".`,
    );
  }

  assertFxSnapshotFresh(fx, input.asOf, policy);

  // A plan that cannot be sold cannot be priced. Sellability is decided by the
  // catalogue authority (a commercial plan with no internal plan value has no
  // entitlement definition and no provider mapping), so an unsellable plan is
  // refused here rather than priced and refused later.
  if (unmappedCommercialPlans().includes(input.planId)) {
    throw new BillingPricingError(
      'invalid_input',
      `The plan "${input.planId}" is not sellable (no internal plan value exists for it), so it cannot be priced.`,
    );
  }

  // The commercial amount — and the only place it can come from.
  const usdMinor = cataloguePriceMinor(input.planId, input.interval);
  if (!Number.isSafeInteger(usdMinor) || usdMinor <= 0) {
    throw new BillingPricingError(
      'invalid_input',
      `The catalogue amount for ${input.planId}/${input.interval} is not a positive integer amount.`,
    );
  }

  const paymentMinor = computePaymentAmountMinor({
    usdMinor: BigInt(usdMinor),
    rateScaled: BigInt(fx.fxRateScaled),
    rateScale: fx.fxRateScale,
  });

  const minimum = BILLING_PAYMENT_MINIMUM_MINOR[fx.quoteCurrency];
  if (paymentMinor < minimum) {
    throw new BillingPricingError(
      'below_minimum',
      `The converted amount (${paymentMinor.toString()} ${fx.quoteCurrency} minor units) is below the documented ` +
        `minimum chargeable amount (${minimum.toString()} minor units). Nothing is charged.`,
    );
  }

  const snapshot: BillingPricingSnapshot = {
    commercialCurrency: BILLING_CURRENCY,
    commercialAmountMinor: usdMinor,
    catalogueVersion: BILLING_CATALOGUE_VERSION,
    cataloguePlan: input.planId,
    interval: input.interval,
    payment: {
      paymentCurrency: fx.quoteCurrency,
      paymentAmountMinor: toSafeMinor(paymentMinor, 'The payable amount'),
      paymentAmountExponent: BILLING_PAYMENT_AMOUNT_EXPONENT[fx.quoteCurrency],
    },
    fx,
    providerPlanId: input.providerPlanId ?? null,
    providerReference: input.providerReference ?? null,
    pricingPolicyVersion: policy.version,
    computedAt: input.asOf.toISOString(),
  };

  // The snapshot schema is `.strict()`: provider plan/reference identifiers are
  // NOT part of the snapshot (they belong on the payment authorization), so an
  // attempt to smuggle them in fails validation here rather than persisting.
  const validated = billingPricingSnapshotSchema.safeParse(snapshot);
  if (!validated.success) {
    throw new BillingPricingError(
      'invalid_snapshot',
      `The produced pricing snapshot is not valid: ${validated.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  return validated.data;
}

/**
 * PRICE A PENDING CHECKOUT AGAIN (D-4): a quote that is still live keeps the
 * amount the customer was shown. A pending checkout re-uses the snapshot it
 * was quoted; this predicate answers "is that snapshot still a valid record of
 * what we quoted?" WITHOUT re-rating it, so a pending checkout can never
 * silently acquire a new price. Freshness is deliberately not part of the
 * answer: an expired quote is expired (the caller decides), not repriced.
 */
export function isPricingSnapshotQuotable(snapshot: unknown): boolean {
  try {
    verifyPricingSnapshot(snapshot);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Verification of a LOCKED snapshot (no re-rating, ever)                     */
/* -------------------------------------------------------------------------- */

/**
 * Validate a pricing snapshot that a subscription is locked to — WITHOUT
 * recomputing it against live FX or the current catalogue.
 *
 * What is checked (all deterministic, all from the snapshot itself):
 *  - the snapshot satisfies the canonical contract (strict shape, integer money,
 *    positive amounts, known plan/interval/currency/exponent/rounding mode);
 *  - the recorded FX facts are internally coherent (a rate captured at or
 *    before it became effective, a positive scaled rate, a supported scale);
 *  - the recorded USD amount and rate DO produce the recorded payment amount
 *    under the recorded rounding mode (an arithmetic identity, not a re-price);
 *  - the amount is at or above the documented minimum for its currency.
 *
 * What is deliberately NOT checked: freshness. A rate that has aged is not a
 * reason to reprice an authorized subscription — the authorized amount stays
 * exactly as authorized (D-8), and refunds use the actual charged amount and
 * are never re-rated (D-6).
 */
export function verifyPricingSnapshot(snapshot: unknown): BillingPricingSnapshot {
  const parsed = billingPricingSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new BillingPricingError(
      'invalid_snapshot',
      `The locked pricing snapshot is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const value = parsed.data;

  const expected = computePaymentAmountMinor({
    usdMinor: BigInt(value.commercialAmountMinor),
    rateScaled: BigInt(value.fx.fxRateScaled),
    rateScale: value.fx.fxRateScale,
  });
  if (BigInt(value.payment.paymentAmountMinor) !== expected) {
    throw new BillingPricingError(
      'invalid_snapshot',
      'The locked pricing snapshot is internally inconsistent: the recorded USD amount and rate do not produce the recorded payment amount.',
    );
  }

  const minimum = BILLING_PAYMENT_MINIMUM_MINOR[value.payment.paymentCurrency];
  if (BigInt(value.payment.paymentAmountMinor) < minimum) {
    throw new BillingPricingError(
      'below_minimum',
      'The locked pricing snapshot records an amount below the documented minimum chargeable amount.',
    );
  }

  return value;
}

/* -------------------------------------------------------------------------- */
/* Deterministic local idempotency                                            */
/* -------------------------------------------------------------------------- */

/**
 * The canonical string a pricing decision is identified by. Every field that
 * could change the amount or the explanation of it is included, in a fixed
 * order, so the same decision always hashes to the same key and a repeated
 * attempt collapses onto the existing snapshot instead of creating a second
 * charge record.
 *
 * Our own transaction reference is deliberately EXCLUDED: it is traceability,
 * not a pricing input, and a retried purchase must collapse onto the decision
 * it retried rather than mint a second pricing record.
 */
export function pricingIdempotencyCanonicalString(snapshot: BillingPricingSnapshot): string {
  return [
    'billing-pricing-snapshot/v1',
    snapshot.commercialCurrency,
    String(snapshot.commercialAmountMinor),
    snapshot.cataloguePlan,
    snapshot.interval,
    snapshot.catalogueVersion,
    snapshot.payment.paymentCurrency,
    String(snapshot.payment.paymentAmountMinor),
    String(snapshot.payment.paymentAmountExponent),
    snapshot.fx.fxRateVersionId,
    String(snapshot.fx.fxRateScaled),
    String(snapshot.fx.fxRateScale),
    snapshot.fx.roundingMode,
    snapshot.providerPlanId ?? '',
    snapshot.pricingPolicyVersion,
  ].join('|');
}

/**
 * Deterministic, LOCAL idempotency key for a pricing decision (sha256 hex).
 * No provider idempotency semantics are assumed anywhere: the key is derived
 * from our own facts and enforced by a UNIQUE index in migration 0032.
 */
export function pricingIdempotencyKey(snapshot: BillingPricingSnapshot): string {
  return createHash('sha256').update(pricingIdempotencyCanonicalString(snapshot)).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Comparison against what a provider reports                                 */
/* -------------------------------------------------------------------------- */

/**
 * Require the amount a provider reports (or would charge) to equal EXACTLY the
 * authorized amount of the locked snapshot — same currency, same minor units,
 * same exponent. A discrepancy is never "close enough": it fails closed so a
 * human can review it (an over-charge and an under-charge are both incidents).
 */
export function assertPaymentAmountMatches(
  snapshot: BillingPricingSnapshot,
  observed: { paymentCurrency: string; paymentAmountMinor: number; paymentAmountExponent: number },
  context: string,
): void {
  const locked = verifyPricingSnapshot(snapshot);
  const expected = locked.payment;
  if (
    observed.paymentCurrency !== expected.paymentCurrency ||
    observed.paymentAmountMinor !== expected.paymentAmountMinor ||
    observed.paymentAmountExponent !== expected.paymentAmountExponent
  ) {
    throw new BillingPricingError(
      'amount_mismatch',
      `${context}: the provider reports ${observed.paymentAmountMinor} ${observed.paymentCurrency} minor units ` +
        `(exponent ${observed.paymentAmountExponent}) but ${expected.paymentAmountMinor} ${expected.paymentCurrency} ` +
        `minor units (exponent ${expected.paymentAmountExponent}) was authorized. No fallback and no re-rate: this is a conflict.`,
    );
  }
}
