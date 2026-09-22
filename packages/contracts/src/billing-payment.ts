import { z } from 'zod';
import {
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  billingIntervalSchema,
  commercialPlanIdSchema,
  type BillingInterval,
  type CommercialPlanId,
} from './billing-catalogue.js';
import { providerEventReferenceSchema, providerReferenceSchema, sha256HexSchema } from './billing-refs.js';

/**
 * Billing PR3 — provider-neutral PAYMENT and PRICING contracts.
 *
 * The commercial catalogue is priced in USD. Customers are charged the USD
 * price's equivalent in a PAYMENT currency (Ghana: GHS), converted server-side
 * through the authoritative, versioned FX boundary. These schemas are the
 * canonical vocabulary for that arrangement:
 *
 *   commercial USD amount  (the catalogue price — the only price authority)
 *            ↓
 *   FX snapshot            (rate + scale + version + effective/captured time)
 *            ↓
 *   payment GHS amount     (integer pesewas — what the customer is charged)
 *
 * WHAT THIS MODULE IS NOT
 *  - It is not a price source. No amount here is ever derived or restated: the
 *    catalogue (`./billing-catalogue.ts`) stays the single authority, and the
 *    conversion lives in the pure server-side pricing boundary
 *    (`packages/core/src/billing/pricing.ts`).
 *  - It is not a provider contract. No provider field name, endpoint, header,
 *    status word, event name or plan-code format appears here; a provider
 *    adapter receives an ALREADY-AUTHORIZED payment authorization and normalizes
 *    what the provider says into these types.
 *  - It grants nothing. Billing state can never widen an entitlement or grant
 *    execution; `canAccessAutomation` stays `false` for every plan.
 *
 * Money is ALWAYS an integer in minor units (never a float), and every object is
 * `.strict()`, so a provider-shaped or client-shaped extra field is a validation
 * failure rather than a silent pass-through.
 */

/* -------------------------------------------------------------------------- */
/* Payment currency and minor units                                           */
/* -------------------------------------------------------------------------- */

/**
 * Payment currencies this build understands. GHS is the initial Ghana payment
 * currency; adding another market is an additive change here plus an approved
 * provider-plan epoch — never a silent fallback (an unsupported currency fails
 * closed).
 */
export const BILLING_PAYMENT_CURRENCIES = ['GHS'] as const;
export type BillingPaymentCurrency = (typeof BILLING_PAYMENT_CURRENCIES)[number];
export const billingPaymentCurrencySchema = z.enum(BILLING_PAYMENT_CURRENCIES);

/**
 * Minor-unit exponent per payment currency: the number of decimal places in the
 * currency's subunit, i.e. the factor by which a major-unit amount is scaled to
 * reach the integer amount a provider expects (GHS: pesewa = 2 ⇒ major × 100).
 *
 * This is a currency fact (ISO 4217 GHS has two minor digits), recorded so the
 * exponent is explicit and CHECKABLE rather than assumed at a call site. The
 * provider's own acceptance of that unit is verified by the adapter against the
 * documented provider rules, not by this constant.
 */
export const BILLING_PAYMENT_AMOUNT_EXPONENT: Readonly<Record<BillingPaymentCurrency, number>> =
  Object.freeze({ GHS: 2 });

/** Rounding modes the pricing boundary may apply. Exactly one final step. */
export const BILLING_ROUNDING_MODES = ['half_up'] as const;
export type BillingRoundingMode = (typeof BILLING_ROUNDING_MODES)[number];
export const billingRoundingModeSchema = z.enum(BILLING_ROUNDING_MODES);

/** Where an FX rate version came from. Provenance is recorded, never inferred. */
export const BILLING_FX_SOURCES = ['db', 'ops', 'import', 'config'] as const;
export type BillingFxSource = (typeof BILLING_FX_SOURCES)[number];
export const billingFxSourceSchema = z.enum(BILLING_FX_SOURCES);

/** Integer minor-unit amount, safe for exact arithmetic in JavaScript. */
function minorAmountSchema() {
  return z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger, { message: 'a minor-unit amount must be a safe integer' });
}

/* -------------------------------------------------------------------------- */
/* Payment amount — what the customer is actually charged                     */
/* -------------------------------------------------------------------------- */

export const billingPaymentAmountSchema = z
  .object({
    paymentCurrency: billingPaymentCurrencySchema,
    /**
     * The canonical payable amount in the payment currency's minor unit
     * (GHS pesewas). Produced by the server-side pricing boundary only.
     */
    paymentAmountMinor: minorAmountSchema(),
    /** Minor-unit exponent the amount was computed for (GHS: 2). */
    paymentAmountExponent: z.number().int().min(0).max(3),
  })
  .strict()
  .superRefine((amount, ctx) => {
    const expected = BILLING_PAYMENT_AMOUNT_EXPONENT[amount.paymentCurrency];
    if (amount.paymentAmountExponent !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `paymentAmountExponent must be ${expected} for ${amount.paymentCurrency}`,
      });
    }
  });
export type BillingPaymentAmount = z.infer<typeof billingPaymentAmountSchema>;

/* -------------------------------------------------------------------------- */
/* FX snapshot — the exact rate a payment was priced with                     */
/* -------------------------------------------------------------------------- */

/**
 * The immutable record of the FX rate a pricing decision used. Scaled integers
 * only — a floating-point money calculation is never permitted, and a float here
 * is a validation failure.
 *
 * `fxRateEffectiveFrom` is when the rate became authoritative;
 * `fxRateCapturedAt` is when it was captured/published (always at or before the
 * moment it became effective). Freshness (the approved maximum age) is measured
 * from `fxRateCapturedAt`, server-side, by the pricing boundary.
 */
export const billingFxSnapshotSchema = z
  .object({
    baseCurrency: z.literal(BILLING_CURRENCY),
    quoteCurrency: billingPaymentCurrencySchema,
    /** Rate × 10^scale, as an integer: quote-major units per one base unit. */
    fxRateScaled: minorAmountSchema(),
    /** Power of ten `fxRateScaled` is expressed in (never zero). */
    fxRateScale: z.number().int().min(1).max(18),
    /** Identity of the immutable rate version this snapshot came from. */
    fxRateVersionId: z.string().uuid(),
    fxRateEffectiveFrom: z.string().datetime(),
    fxRateCapturedAt: z.string().datetime(),
    fxRateSource: billingFxSourceSchema,
    roundingMode: billingRoundingModeSchema,
  })
  .strict()
  .superRefine((fx, ctx) => {
    if (Date.parse(fx.fxRateCapturedAt) > Date.parse(fx.fxRateEffectiveFrom)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a rate is captured (published) at or before the moment it becomes effective',
      });
    }
  });
export type BillingFxSnapshot = z.infer<typeof billingFxSnapshotSchema>;

/* -------------------------------------------------------------------------- */
/* Pricing snapshot — the auditable record of one pricing decision            */
/* -------------------------------------------------------------------------- */

/**
 * Everything needed to explain, years later and without re-deriving anything,
 * what was sold and what was charged: the commercial USD price, the payment
 * currency amount, the rate and its version, the rounding applied and the
 * policy version in force.
 *
 * The snapshot is a RECORD of a payment decision — never a price catalogue.
 * The catalogue remains the only source of the commercial amount.
 */
export const billingPricingSnapshotSchema = z
  .object({
    commercialCurrency: z.literal(BILLING_CURRENCY),
    /** Catalogue price in USD minor units (cents) for plan + interval. */
    commercialAmountMinor: minorAmountSchema(),
    catalogueVersion: z.string().trim().min(1).max(64),
    cataloguePlan: commercialPlanIdSchema,
    interval: billingIntervalSchema,
    payment: billingPaymentAmountSchema,
    fx: billingFxSnapshotSchema,
    /**
     * Provider plan this decision is bound to, when one exists (the immutable
     * GHS plan epoch). `null` for a decision that is not yet bound to a plan.
     */
    providerPlanId: providerReferenceSchema.nullable(),
    /** Our own reference for the intended purchase, when one exists. */
    providerReference: providerEventReferenceSchema.nullable(),
    /** Version of the rounding + freshness policy applied. */
    pricingPolicyVersion: z.string().trim().min(1).max(64),
    computedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.fx.baseCurrency !== snapshot.commercialCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the FX snapshot base currency must be the commercial currency',
      });
    }
    if (snapshot.fx.quoteCurrency !== snapshot.payment.paymentCurrency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the FX snapshot quote currency must be the payment currency',
      });
    }
  });
export type BillingPricingSnapshot = z.infer<typeof billingPricingSnapshotSchema>;

/* -------------------------------------------------------------------------- */
/* Payment authorization — what a provider adapter is allowed to charge       */
/* -------------------------------------------------------------------------- */

/**
 * The already-authorized payment a provider adapter may act on: the exact
 * payable amount, the pricing snapshot that produced it, and (for a recurring
 * subscription) the provider plan the amount belongs to.
 *
 * The adapter never prices, never converts and never reads a rate: it receives
 * this object and must fail closed if any check against it fails. `reference` is
 * OUR transaction reference; `providerPlanId` is an opaque provider identifier.
 */
export const billingPaymentAuthorizationSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    /** Our own transaction reference (surfaced back by the provider). */
    reference: providerEventReferenceSchema,
    pricing: billingPricingSnapshotSchema,
    /** Provider plan identifier for a recurring charge, when there is one. */
    providerPlanId: providerReferenceSchema.nullable(),
    idempotencyKey: sha256HexSchema,
    authorizedAt: z.string().datetime(),
  })
  .strict();
export type BillingPaymentAuthorization = z.infer<typeof billingPaymentAuthorizationSchema>;

/* -------------------------------------------------------------------------- */
/* Accessors                                                                  */
/* -------------------------------------------------------------------------- */

/** The payable amount a snapshot authorizes, in payment-currency minor units. */
export function billingPayableAmountMinor(plan: BillingPricingSnapshot): number {
  return plan.payment.paymentAmountMinor;
}

/**
 * True when the snapshot converts between two different currencies. The
 * comparison widens to `string` deliberately: today's payment-currency enum
 * (GHS) is statically disjoint from the commercial currency (USD), and a future
 * market whose payment currency IS the commercial currency must answer `false`
 * rather than fail to compile.
 */
export function billingIsCrossCurrency(snapshot: BillingPricingSnapshot): boolean {
  return (
    (snapshot.payment.paymentCurrency as string) !== (snapshot.commercialCurrency as string)
  );
}

/** Plan identity (commercial) carried by a pricing snapshot. */
export function billingSnapshotPlanIdentity(snapshot: BillingPricingSnapshot): {
  cataloguePlan: CommercialPlanId;
  interval: BillingInterval;
} {
  return { cataloguePlan: snapshot.cataloguePlan, interval: snapshot.interval };
}
