import { z } from 'zod';
import {
  BILLING_CURRENCY,
  BILLING_INTERVALS,
  COMMERCIAL_PLAN_CATALOGUE,
  billingIntervalSchema,
  type BillingInterval,
} from './billing-catalogue.js';
import {
  billingFxSourceSchema,
  billingPaymentAmountSchema,
  billingPaymentCurrencySchema,
  billingRoundingModeSchema,
  type BillingFxSnapshot,
  type BillingPaymentAmount,
  type BillingPricingSnapshot,
} from './billing-payment.js';
import { billingIsoDateTimeSchema, billingUuidSchema } from './billing-refs.js';
import type { BillingStateDto } from './billing.js';

/**
 * Billing Step 9 — the SANDBOX CHECKOUT SURFACE contracts.
 *
 * Step 9 puts the already-delivered server-side checkout (`POST
 * /api/billing/checkout`, PR-C) in front of the signed-in user on `/settings`,
 * and nothing else. This module is the vocabulary that surface speaks:
 *
 *  1. `billingCheckoutRequestDtoSchema` — the ONLY body the browser may send
 *     (`{ cataloguePlan, interval }`, `.strict()`);
 *  2. `billingCheckoutSessionDtoSchema` — the ONLY checkout-session shape the
 *     API may answer with, plus `projectBillingCheckoutSession()`, the single
 *     projection that produces it;
 *  3. `BILLING_CHECKOUT_CHOICES` — the exactly-four sellable plan × interval
 *     choices, derived from the authoritative catalogue (never restated);
 *  4. `resolveBillingCheckoutState()` — the pure derivation of the five UI
 *     states (`free`, `awaiting_verification`, `evidence_recorded`,
 *     `activated`, `unavailable`) from server facts plus one UI-local fact.
 *
 * WHAT THE PROJECTION REMOVES (and why it is a projection, not a pass-through)
 *
 * The provider seam's session (`BillingCheckoutSession` in
 * `packages/core/src/billing/provider.ts`) is an INTERNAL object: it carries
 * our checkout `reference`, the provider's `providerReference`, the
 * `idempotencyKey`, the provider id and the whole immutable
 * `BillingPricingSnapshot` (including `providerPlanId`, `catalogueVersion`,
 * `pricingPolicyVersion` and `computedAt`). None of that is needed to show a
 * price and a payment link, and all of it is useful to an attacker (a
 * reference is the input to the verification read; an idempotency key and a
 * provider plan code are internal identity). The DTO therefore publishes ONLY:
 *
 *   - the session `status` and the `authorizationUrl` (verbatim, unmodified —
 *     the browser navigates to exactly what the server returned);
 *   - the COMMERCIAL price (catalogue USD minor units + display string);
 *   - the exact PAYMENT amount (GHS minor units + display string);
 *   - the FX DISCLOSURE the pricing decisions require — rate, version and
 *     time (`billing.md` → *Decisions*: "USD price (prominent) + exact GHS
 *     amount + rate, version and time. GHS is shown before payment").
 *
 * The projection input type below deliberately does not even NAME the omitted
 * fields, so the projection cannot leak what it never reads.
 *
 * WHAT THIS MODULE IS NOT
 *  - It is not a price source. Every amount is copied from a server-side
 *    pricing decision (the immutable snapshot) or from the frozen catalogue;
 *    nothing here computes, converts, rounds or re-rates money.
 *  - It is not an entitlement. `paymentConfirmed`, `planChanged`,
 *    `entitlementsChanged`, `grantsExecution` and `canAccessAutomation` are
 *    `z.literal(false)`: a checkout session is an OFFER to pay. Payment
 *    confirmation stays derived from the Billing Step 8 activation fact, and
 *    entitlements stay resolved server-side.
 *  - It is not a confirmation path. Recording evidence (Step 7) and activating
 *    an entitlement (Step 8, out-of-band operator CLI) are unchanged by this
 *    module; the `evidence_recorded` state below is a DISPLAY fact about what
 *    the current UI session was told, never an authority.
 *  - It knows no provider. No endpoint, header, plan-code format, signature or
 *    credential appears here, and the provider's own identifiers are exactly
 *    what the projection strips.
 *
 * Money is always an integer in minor units and every display string is built
 * with integer (BigInt) arithmetic — there is no float anywhere in this file.
 */

/* -------------------------------------------------------------------------- */
/* Sellable plans and the request body                                         */
/* -------------------------------------------------------------------------- */

/**
 * The plans a checkout may sell. Starter is deliberately absent: it has no
 * internal plan value yet (`INTERNAL_PLAN_FOR_COMMERCIAL_PLAN.starter === null`)
 * and the server-side checkout input refuses it. This mirrors
 * `packages/core/src/billing/checkout.ts` → `billingCheckoutInputSchema`; the
 * server stays the authority and this constant exists so the browser cannot
 * offer a plan the server would refuse.
 */
export const BILLING_CHECKOUT_SELLABLE_PLANS = ['pro', 'elite'] as const;
export type BillingCheckoutSellablePlan = (typeof BILLING_CHECKOUT_SELLABLE_PLANS)[number];
export const billingCheckoutSellablePlanSchema = z.enum(BILLING_CHECKOUT_SELLABLE_PLANS);

/**
 * The ONLY checkout request body. Two fields, `.strict()`: a client cannot add
 * a price, an amount, a currency, a provider plan, a callback URL, a reference,
 * an idempotency key or a user id — every one of those is server-derived.
 */
export const billingCheckoutRequestDtoSchema = z
  .object({
    cataloguePlan: billingCheckoutSellablePlanSchema,
    interval: billingIntervalSchema,
  })
  .strict();
export type BillingCheckoutRequestDto = z.infer<typeof billingCheckoutRequestDtoSchema>;

/* -------------------------------------------------------------------------- */
/* The four choices (derived from the catalogue, never restated)               */
/* -------------------------------------------------------------------------- */

export const billingCheckoutChoiceSchema = z
  .object({
    cataloguePlan: billingCheckoutSellablePlanSchema,
    interval: billingIntervalSchema,
    /** Commercial plan name, exactly as the catalogue states it. */
    planName: z.string().min(1),
    /** Catalogue price for this plan + interval (USD minor units + display). */
    price: z.object({
      interval: billingIntervalSchema,
      currency: z.literal(BILLING_CURRENCY),
      amountMinor: z.number().int().nonnegative(),
      display: z.string().min(1),
    }).strict(),
  })
  .strict();
export type BillingCheckoutChoice = z.infer<typeof billingCheckoutChoiceSchema>;

/**
 * Exactly four choices: Pro monthly, Pro annual, Elite monthly, Elite annual —
 * in catalogue order, each carrying the catalogue's own price object (the same
 * frozen instance, never a copy with an edited amount).
 *
 * This is the single source the checkout UI renders from, so "what the browser
 * offers" and "what the catalogue sells" cannot drift apart.
 */
export const BILLING_CHECKOUT_CHOICES: readonly BillingCheckoutChoice[] = Object.freeze(
  COMMERCIAL_PLAN_CATALOGUE.filter((plan) =>
    (BILLING_CHECKOUT_SELLABLE_PLANS as readonly string[]).includes(plan.id),
  ).flatMap((plan) =>
    BILLING_INTERVALS.map((interval) => ({
      cataloguePlan: plan.id as BillingCheckoutSellablePlan,
      interval,
      planName: plan.name,
      // The catalogue's own frozen price object — never a restated amount.
      price: plan.pricing[interval],
    })),
  ),
);

/** The choice for a plan + interval, or `null` when it is not sellable. */
export function billingCheckoutChoice(
  cataloguePlan: BillingCheckoutSellablePlan,
  interval: BillingInterval,
): BillingCheckoutChoice | null {
  return (
    BILLING_CHECKOUT_CHOICES.find(
      (choice) => choice.cataloguePlan === cataloguePlan && choice.interval === interval,
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Display helpers — integer arithmetic only, no floats                        */
/* -------------------------------------------------------------------------- */

/**
 * Render a scaled integer (`value = digits × 10^scale`) as a decimal string
 * with exactly `scale` fractional digits. BigInt only: a money string is never
 * produced by dividing a Number.
 */
function scaledIntegerString(value: bigint, scale: number): string {
  if (scale <= 0) return value.toString();
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = magnitude / divisor;
  const fraction = (magnitude % divisor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Drop trailing fractional zeros (`12.500000` → `12.5`, `20.000000` → `20`). */
function trimFractionZeros(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Commercial USD display for a minor-unit amount: whole dollars render without
 * a fraction (`3900` → `$39`), so the string matches the catalogue's own
 * `display` for every price this build sells.
 */
export function billingUsdAmountDisplay(amountMinor: number): string {
  const dollars = scaledIntegerString(BigInt(amountMinor), 2);
  // Whole dollars drop the ".00" fraction, matching the catalogue's `display`.
  return `$${amountMinor % 100 === 0 ? dollars.slice(0, -3) : dollars}`;
}

/** Exact payment-currency display for a minor-unit amount (`GHS 487.50`). */
export function billingPaymentAmountDisplay(payment: BillingPaymentAmount): string {
  return `${payment.paymentCurrency} ${scaledIntegerString(
    BigInt(payment.paymentAmountMinor),
    payment.paymentAmountExponent,
  )}`;
}

/**
 * The FX disclosure line: the exact rate the payment was priced at, rendered
 * from the scaled integer the server persisted (`1 USD = 12.5 GHS`). The rate
 * is never re-derived, never re-quoted and never rounded again here.
 */
export function billingFxRateDisplay(fx: BillingFxSnapshot): string {
  return `1 ${fx.baseCurrency} = ${trimFractionZeros(
    scaledIntegerString(BigInt(fx.fxRateScaled), fx.fxRateScale),
  )} ${fx.quoteCurrency}`;
}

/* -------------------------------------------------------------------------- */
/* The checkout-session DTO (the only shape the browser ever sees)             */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the provider seam's session vocabulary
 * (`BILLING_CHECKOUT_SESSION_STATUSES` in
 * `packages/core/src/billing/provider.ts`). Declared here because contracts is
 * the dependency and core the dependent: core imports this module, so this
 * module cannot import core's constant. The API test suite pins the two
 * vocabularies together.
 */
export const BILLING_CHECKOUT_SESSION_DTO_STATUSES = ['initialized', 'unavailable', 'failed'] as const;
export type BillingCheckoutSessionDtoStatus = (typeof BILLING_CHECKOUT_SESSION_DTO_STATUSES)[number];
export const billingCheckoutSessionDtoStatusSchema = z.enum(BILLING_CHECKOUT_SESSION_DTO_STATUSES);

/**
 * The FX part of the disclosure: rate, version and time. It is a PROJECTION of
 * the immutable snapshot's `fx` block — the rate integers exactly as persisted
 * (never a re-computed float), the version identity, when it was captured and
 * when it became effective, its provenance and the single rounding step.
 *
 * Not carried: the provider plan code, our checkout reference, the provider's
 * reference, the catalogue/policy versions and the snapshot's `computedAt`.
 */
export const billingCheckoutFxDisclosureDtoSchema = z
  .object({
    baseCurrency: z.literal(BILLING_CURRENCY),
    quoteCurrency: billingPaymentCurrencySchema,
    /** Rate × 10^scale, exactly as the server persisted it. */
    fxRateScaled: z.number().int().positive(),
    fxRateScale: z.number().int().min(1).max(18),
    /** Rendered from the two integers above (`1 USD = 12.5 GHS`). */
    rateDisplay: z.string().min(1),
    /** The immutable rate version this price is pinned to (disclosure fact). */
    fxRateVersionId: billingUuidSchema,
    fxRateEffectiveFrom: billingIsoDateTimeSchema,
    fxRateCapturedAt: billingIsoDateTimeSchema,
    fxRateSource: billingFxSourceSchema,
    roundingMode: billingRoundingModeSchema,
  })
  .strict();
export type BillingCheckoutFxDisclosureDto = z.infer<typeof billingCheckoutFxDisclosureDtoSchema>;

/** The commercial (catalogue) price the server priced this checkout at. */
export const billingCheckoutPriceDtoSchema = z
  .object({
    cataloguePlan: billingCheckoutSellablePlanSchema,
    interval: billingIntervalSchema,
    currency: z.literal(BILLING_CURRENCY),
    /** Catalogue amount in USD minor units, as priced server-side. */
    amountMinor: z.number().int().positive(),
    /** Display string derived from `amountMinor` with integer arithmetic. */
    display: z.string().min(1),
  })
  .strict();
export type BillingCheckoutPriceDto = z.infer<typeof billingCheckoutPriceDtoSchema>;

/**
 * The payment link the browser is sent.
 *
 * Pinned to an absolute **https** URL with no embedded credentials, because the
 * checkout surface renders this string VERBATIM as an anchor `href`: a
 * `javascript:`, `data:` or `http:` value would be a script-injection or
 * downgrade vector, and Zod's `.url()` accepts all three. Nothing else about
 * the string is touched — no prefixing, no re-encoding, no query rewriting.
 */
export const billingCheckoutAuthorizationUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, { message: 'an authorization URL must be an absolute https URL without credentials' });
export type BillingCheckoutAuthorizationUrl = z.infer<typeof billingCheckoutAuthorizationUrlSchema>;

/**
 * The strict checkout-session DTO — the ONLY checkout shape that leaves the
 * API. `.strict()` in both directions: the projection cannot add a field, and
 * a client that receives an unknown field is looking at something this build
 * did not produce.
 *
 * `authorizationUrl` is carried VERBATIM: the UI must render exactly this
 * string as the payment link and must never build, rewrite, prefix or
 * re-encode a provider URL. It is `null` unless the session is `initialized`.
 */
export const billingCheckoutSessionDtoSchema = z
  .object({
    status: billingCheckoutSessionDtoStatusSchema,
    /** The provider-hosted payment page, verbatim; `null` unless initialized. */
    authorizationUrl: billingCheckoutAuthorizationUrlSchema.nullable(),
    /** Commercial price (USD) — what the catalogue sells. */
    price: billingCheckoutPriceDtoSchema.nullable(),
    /** Exact payment amount (GHS minor units) — what the customer pays. */
    payment: billingPaymentAmountSchema.nullable(),
    /** Display string for `payment` (`GHS 487.50`). */
    paymentDisplay: z.string().min(1).nullable(),
    /** Rate, version and time — the disclosure shown BEFORE payment. */
    fx: billingCheckoutFxDisclosureDtoSchema.nullable(),
    initializedAt: billingIsoDateTimeSchema,
    /**
     * Pinned by type: a checkout session is an offer to pay. It confirms no
     * payment, changes no plan and no entitlement, and grants no execution —
     * `paymentConfirmed` stays derived from the Step 8 activation fact.
     */
    paymentConfirmed: z.literal(false),
    planChanged: z.literal(false),
    entitlementsChanged: z.literal(false),
    grantsExecution: z.literal(false),
    canAccessAutomation: z.literal(false),
  })
  .strict()
  .superRefine((session, ctx) => {
    if (session.status === 'initialized') {
      // An initialized checkout must be fully disclosed: where to pay, the
      // commercial price, the exact payment amount and the FX rate/version/time.
      if (session.authorizationUrl === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an initialized checkout must carry an authorization URL' });
      }
      if (session.price === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an initialized checkout must disclose its commercial price' });
      }
      if (session.payment === null || session.paymentDisplay === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an initialized checkout must disclose the exact payment amount' });
      }
      if (session.fx === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an initialized checkout must disclose its FX rate, version and time' });
      }
    } else if (session.authorizationUrl !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only an initialized checkout carries an authorization URL' });
    }
    if (session.fx !== null) {
      if (session.payment === null || session.paymentDisplay === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an FX disclosure without a payment amount is meaningless' });
      } else if (session.payment.paymentCurrency !== session.fx.quoteCurrency) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the FX quote currency must be the payment currency' });
      }
      if (session.price !== null && session.price.currency !== session.fx.baseCurrency) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the FX base currency must be the commercial currency' });
      }
    }
    if (session.price !== null && (session.payment === null || session.fx === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a commercial price must be disclosed with its payment amount and FX rate' });
    }
  });
export type BillingCheckoutSessionDto = z.infer<typeof billingCheckoutSessionDtoSchema>;

/* -------------------------------------------------------------------------- */
/* The projection (one implementation, used by the route)                      */
/* -------------------------------------------------------------------------- */

/**
 * The subset of the provider seam's `BillingCheckoutSession` this projection
 * reads. Declared structurally (contracts cannot import core): the omitted
 * fields — `provider`, `reference`, `providerReference`, `idempotencyKey` —
 * are not merely unused, they are UNNAMEABLE here, which is what makes the
 * omission a property of the code rather than a convention at a call site.
 */
export interface BillingCheckoutSessionProjectionInput {
  status: BillingCheckoutSessionDtoStatus;
  authorizationUrl: string | null;
  /** Commercial amount (USD minor units) the seam reports. */
  amountMinor: number;
  currency: typeof BILLING_CURRENCY;
  /** Exact payment amount the provider was asked to charge, when reported. */
  payment?: BillingPaymentAmount | null;
  /** The immutable pricing snapshot the session was initialized from. */
  pricing?: BillingPricingSnapshot | null;
  initializedAt: string;
}

/** A session that cannot be disclosed safely is never forwarded. */
export class BillingCheckoutProjectionError extends Error {
  readonly code = 'billing_checkout_projection_refused' as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BillingCheckoutProjectionError';
  }
}

export function isBillingCheckoutProjectionError(error: unknown): error is BillingCheckoutProjectionError {
  return error instanceof BillingCheckoutProjectionError;
}

/**
 * Project the internal seam session onto the strict DTO.
 *
 * Fail-closed by construction:
 *  - an `initialized` session with no pricing snapshot cannot disclose a price
 *    or an FX rate, so it is refused rather than forwarded (a partial
 *    disclosure would show a payment link with no price next to it);
 *  - a session whose commercial amount disagrees with its own snapshot, or
 *    whose payment amount disagrees with the snapshot's, is refused (the two
 *    must be one pricing decision);
 *  - a snapshot for a plan this build does not sell (`starter`) is refused by
 *    the DTO's plan enum;
 *  - anything else the DTO rejects is wrapped in `BillingCheckoutProjectionError`.
 *
 * The route maps a projection refusal to `502 provider_unavailable`: the
 * browser never receives the raw session, and no reference, provider
 * identifier, idempotency key or internal snapshot reaches it.
 */
export function projectBillingCheckoutSession(
  session: BillingCheckoutSessionProjectionInput,
): BillingCheckoutSessionDto {
  const snapshot = session.pricing ?? null;

  if (snapshot !== null) {
    if (
      snapshot.commercialAmountMinor !== session.amountMinor ||
      snapshot.commercialCurrency !== session.currency
    ) {
      throw new BillingCheckoutProjectionError(
        'The checkout session disagrees with its own pricing snapshot on the commercial amount; nothing is disclosed.',
      );
    }
    const payment = session.payment ?? null;
    if (
      payment !== null &&
      (payment.paymentAmountMinor !== snapshot.payment.paymentAmountMinor ||
        payment.paymentCurrency !== snapshot.payment.paymentCurrency)
    ) {
      throw new BillingCheckoutProjectionError(
        'The checkout session disagrees with its own pricing snapshot on the payment amount; nothing is disclosed.',
      );
    }
  }

  if (session.status === 'initialized' && snapshot === null) {
    throw new BillingCheckoutProjectionError(
      'An initialized checkout session carries no pricing snapshot, so neither the price nor the FX disclosure can be published; the session is never forwarded raw.',
    );
  }

  const payment = snapshot?.payment ?? session.payment ?? null;
  const dto = {
    status: session.status,
    // Verbatim: the string the server received from the provider, unmodified.
    authorizationUrl: session.status === 'initialized' ? session.authorizationUrl : null,
    price:
      snapshot === null
        ? null
        : {
            cataloguePlan: snapshot.cataloguePlan,
            interval: snapshot.interval,
            currency: snapshot.commercialCurrency,
            amountMinor: snapshot.commercialAmountMinor,
            display: billingUsdAmountDisplay(snapshot.commercialAmountMinor),
          },
    payment,
    paymentDisplay: payment === null ? null : billingPaymentAmountDisplay(payment),
    fx:
      snapshot === null
        ? null
        : {
            baseCurrency: snapshot.fx.baseCurrency,
            quoteCurrency: snapshot.fx.quoteCurrency,
            fxRateScaled: snapshot.fx.fxRateScaled,
            fxRateScale: snapshot.fx.fxRateScale,
            rateDisplay: billingFxRateDisplay(snapshot.fx),
            fxRateVersionId: snapshot.fx.fxRateVersionId,
            fxRateEffectiveFrom: snapshot.fx.fxRateEffectiveFrom,
            fxRateCapturedAt: snapshot.fx.fxRateCapturedAt,
            fxRateSource: snapshot.fx.fxRateSource,
            roundingMode: snapshot.fx.roundingMode,
          },
    initializedAt: session.initializedAt,
    paymentConfirmed: false,
    planChanged: false,
    entitlementsChanged: false,
    grantsExecution: false,
    canAccessAutomation: false,
  };

  const parsed = billingCheckoutSessionDtoSchema.safeParse(dto);
  if (!parsed.success) {
    throw new BillingCheckoutProjectionError(
      `The checkout session could not be projected onto the disclosed DTO: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* The five UI states (pure derivation, no I/O)                                */
/* -------------------------------------------------------------------------- */

/**
 * The states the checkout surface must keep visibly distinct:
 *
 *  - `free` — no provider-backed subscription row exists (or a historical
 *    `provider IS NULL` row): the account is free and checkout is offered.
 *  - `awaiting_verification` — a checkout created a provider-backed row
 *    (`provider`, `provider_state`) that no verification has confirmed yet:
 *    the user still has to pay and then ask for verification.
 *  - `evidence_recorded` — verified payment EVIDENCE exists for this checkout
 *    and an operator has not activated it. Evidence is a receipt, never
 *    authority: the account is still free until the Step 8 activation fact
 *    exists, and this state is the honest label for that gap.
 *  - `activated` — the server derived `paymentConfirmed: true` from the
 *    immutable activation fact: the paid entitlement is in force.
 *  - `unavailable` — the billing state could not be read, or the checkout
 *    surface is refusing (no provider registered, no epoch, a provider
 *    refusal). Nothing is offered and nothing is claimed.
 */
export const BILLING_CHECKOUT_STATES = [
  'free',
  'awaiting_verification',
  'evidence_recorded',
  'activated',
  'unavailable',
] as const;
export type BillingCheckoutState = (typeof BILLING_CHECKOUT_STATES)[number];
export const billingCheckoutStateSchema = z.enum(BILLING_CHECKOUT_STATES);

/** The states in which the four choices and the payment link are offered. */
export const BILLING_CHECKOUT_OFFERED_STATES: readonly BillingCheckoutState[] = Object.freeze([
  'free',
  'awaiting_verification',
]);

export function billingCheckoutOffered(state: BillingCheckoutState): boolean {
  return (BILLING_CHECKOUT_OFFERED_STATES as readonly string[]).includes(state);
}

export interface BillingCheckoutStateInput {
  /**
   * The server billing state from `GET /api/billing/me`, or `null` when it
   * could not be read. `providerStatus.paymentConfirmed` is the ONLY
   * activation authority in this derivation — it is derived server-side from
   * the durable activation fact and is never client input.
   */
  billing: BillingStateDto | null;
  /**
   * True once THIS UI session was told by `POST /api/billing/verify` that
   * verified evidence was recorded. It is a display fact about the current UI
   * state, never an authority: it cannot confirm a payment, and a page reload
   * legitimately loses it (the server-derived state then reads
   * `awaiting_verification` again until an operator activates the
   * subscription).
   */
  evidenceRecorded?: boolean;
  /** True when the billing read or the checkout surface is failing. */
  unavailable?: boolean;
}

/**
 * Derive the checkout surface's state. Server facts outrank UI facts, and a
 * stronger server fact outranks a weaker one:
 *
 *   activated (server)  >  evidence recorded (UI)  >  awaiting verification
 *   (server)  >  unavailable  >  free.
 *
 * An unreadable billing state is `unavailable`, never `free`: a client that
 * cannot read the server's answer must not conclude that nothing is owed.
 */
export function resolveBillingCheckoutState(input: BillingCheckoutStateInput): BillingCheckoutState {
  const { billing } = input;
  if (billing === null) return 'unavailable';
  if (billing.providerStatus.paymentConfirmed) return 'activated';
  if (input.evidenceRecorded === true) return 'evidence_recorded';
  if (billing.providerStatus.provider !== null) return 'awaiting_verification';
  if (input.unavailable === true) return 'unavailable';
  return 'free';
}
