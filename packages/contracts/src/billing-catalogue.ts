import { z } from 'zod';
import { type UserPlan } from './users.js';

/**
 * PR1 — Authoritative commercial catalogue (Starter / Pro / Elite).
 *
 * This module defines **what the product sells**. It is deliberately NOT the
 * same thing as:
 *
 *  1. **Entitlement enforcement** — what the server enforces today lives in
 *     `packages/core/src/billing/entitlements.ts` and is keyed on the existing
 *     internal plan values (`free` / `pro` / `premium`, see `USER_PLANS`).
 *     Nothing in this catalogue changes `getEntitlements()` or any limit check.
 *  2. **Future execution capabilities** — automation, live execution and broker
 *     execution are all still OFF for every plan. "Priority execution" on Elite
 *     is a **commercial descriptor only**; the `capabilityGrants` block below is
 *     typed to make it impossible to encode a capability grant here.
 *
 * The catalogue object is defined exactly once (here) and frozen, so the API and
 * the web UI render from one source. The *server-side authority* is
 * `packages/core/src/billing/catalogue.ts`, which validates this object at
 * module load and is the only module allowed to map catalogue entries onto
 * enforcement decisions (today: none — see the compatibility mapping below).
 *
 * Prices are operator-defined. Amounts are integer **minor units** (USD cents)
 * to keep money out of floating point; `display` is the human-facing string.
 *
 * No checkout, portal, provider call, webhook or credential exists yet — this
 * is a catalogue, not a payment flow.
 */

/** Selected payment provider (PR1 decision; integration lands in later PRs). */
export const BILLING_PROVIDER = 'paystack' as const;

/** Single commercial currency for the catalogue. */
export const BILLING_CURRENCY = 'USD' as const;

/** Catalogue version — bump when commercial values change. */
export const BILLING_CATALOGUE_VERSION = 'billing-catalogue-1';

/** Commercial (sold) plans, in ascending order. */
export const COMMERCIAL_PLANS = ['starter', 'pro', 'elite'] as const;
export type CommercialPlanId = (typeof COMMERCIAL_PLANS)[number];
export const commercialPlanIdSchema = z.enum(COMMERCIAL_PLANS);

/** Billing intervals offered for every commercial plan. */
export const BILLING_INTERVALS = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];
export const billingIntervalSchema = z.enum(BILLING_INTERVALS);

/** Integer minor units (USD cents) — never a float. */
export const planPriceSchema = z.object({
  interval: billingIntervalSchema,
  currency: z.literal('USD'),
  amountMinor: z.number().int().nonnegative(),
  display: z.string().min(1),
});
export type PlanPrice = z.infer<typeof planPriceSchema>;

export const planPricingSchema = z
  .object({
    monthly: planPriceSchema,
    annual: planPriceSchema,
  })
  .superRefine((pricing, ctx) => {
    if (pricing.monthly.interval !== 'monthly') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'monthly price must carry interval "monthly"' });
    }
    if (pricing.annual.interval !== 'annual') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'annual price must carry interval "annual"' });
    }
    if (pricing.monthly.currency !== BILLING_CURRENCY || pricing.annual.currency !== BILLING_CURRENCY) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `prices must be denominated in ${BILLING_CURRENCY}` });
    }
  });
export type PlanPricing = z.infer<typeof planPricingSchema>;

/** Active-strategy allowance (the commercial promise, not the enforced limit). */
export const activeStrategyLimitSchema = z
  .object({
    limit: z.number().int().positive().nullable(),
    unlimited: z.boolean(),
    display: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.unlimited && value.limit !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unlimited plans must not carry a numeric limit' });
    }
    if (!value.unlimited && value.limit === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'limited plans must carry a numeric limit' });
    }
  });
export type ActiveStrategyLimit = z.infer<typeof activeStrategyLimitSchema>;

export const MARKET_COVERAGE_SCOPES = ['single-category', 'forex-crypto-stocks'] as const;
export type MarketCoverageScope = (typeof MARKET_COVERAGE_SCOPES)[number];
export const marketCoverageSchema = z.object({
  scope: z.enum(MARKET_COVERAGE_SCOPES),
  display: z.string().min(1),
});
export type MarketCoverage = z.infer<typeof marketCoverageSchema>;

export const TRADE_FREQUENCY_TIERS = ['delayed', 'real-time', 'real-time-priority'] as const;
export type TradeFrequencyTier = (typeof TRADE_FREQUENCY_TIERS)[number];

/**
 * Commercial trade-frequency descriptor.
 *
 * `grantsExecution` is pinned to `false` by the type: a frequency tier
 * describes delivery/servicing expectations, never an execution capability.
 */
export const tradeFrequencySchema = z.object({
  tier: z.enum(TRADE_FREQUENCY_TIERS),
  display: z.string().min(1),
  grantsExecution: z.literal(false),
  note: z.string().min(1).optional(),
});
export type TradeFrequency = z.infer<typeof tradeFrequencySchema>;

/**
 * Capability grants a commercial plan could ever carry. Every field is pinned
 * to the literal `false`, so this catalogue cannot express (and therefore cannot
 * accidentally grant) live execution, broker execution or automation.
 */
export const commercialCapabilityGrantsSchema = z.object({
  liveExecution: z.literal(false),
  brokerExecution: z.literal(false),
  automation: z.literal(false),
});
export type CommercialCapabilityGrants = z.infer<typeof commercialCapabilityGrantsSchema>;

export const planCatalogueEntrySchema = z.object({
  id: commercialPlanIdSchema,
  name: z.string().min(1),
  currency: z.literal('USD'),
  pricing: planPricingSchema,
  activeStrategies: activeStrategyLimitSchema,
  markets: marketCoverageSchema,
  tradeFrequency: tradeFrequencySchema,
  capabilityGrants: commercialCapabilityGrantsSchema,
});
export type PlanCatalogueEntry = z.infer<typeof planCatalogueEntrySchema>;

export const billingCatalogueSchema = z
  .object({
    version: z.string().min(1),
    provider: z.literal(BILLING_PROVIDER),
    currency: z.literal(BILLING_CURRENCY),
    plans: z.array(planCatalogueEntrySchema).min(1),
  })
  .superRefine((catalogue, ctx) => {
    const ids = catalogue.plans.map((plan) => plan.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'catalogue plan ids must be unique' });
    }
    for (const expected of COMMERCIAL_PLANS) {
      if (!ids.includes(expected)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `catalogue is missing plan "${expected}"` });
      }
    }
  });
export type BillingCatalogue = z.infer<typeof billingCatalogueSchema>;

const STARTER: PlanCatalogueEntry = {
  id: 'starter',
  name: 'Starter',
  currency: 'USD',
  pricing: {
    monthly: { interval: 'monthly', currency: 'USD', amountMinor: 1500, display: '$15' },
    annual: { interval: 'annual', currency: 'USD', amountMinor: 15000, display: '$150' },
  },
  activeStrategies: { limit: 1, unlimited: false, display: '1' },
  markets: { scope: 'single-category', display: '1 market category' },
  tradeFrequency: { tier: 'delayed', display: 'Delayed / limited', grantsExecution: false },
  capabilityGrants: { liveExecution: false, brokerExecution: false, automation: false },
};

const PRO: PlanCatalogueEntry = {
  id: 'pro',
  name: 'Pro',
  currency: 'USD',
  pricing: {
    monthly: { interval: 'monthly', currency: 'USD', amountMinor: 3900, display: '$39' },
    annual: { interval: 'annual', currency: 'USD', amountMinor: 39000, display: '$390' },
  },
  activeStrategies: { limit: 5, unlimited: false, display: '5' },
  markets: { scope: 'forex-crypto-stocks', display: 'Forex + crypto + stocks' },
  tradeFrequency: { tier: 'real-time', display: 'Real-time', grantsExecution: false },
  capabilityGrants: { liveExecution: false, brokerExecution: false, automation: false },
};

const ELITE: PlanCatalogueEntry = {
  id: 'elite',
  name: 'Elite',
  currency: 'USD',
  pricing: {
    monthly: { interval: 'monthly', currency: 'USD', amountMinor: 9900, display: '$99' },
    annual: { interval: 'annual', currency: 'USD', amountMinor: 99000, display: '$990' },
  },
  activeStrategies: { limit: null, unlimited: true, display: 'Unlimited' },
  markets: { scope: 'forex-crypto-stocks', display: 'Forex + crypto + stocks' },
  tradeFrequency: {
    tier: 'real-time-priority',
    display: 'Real-time + priority execution',
    grantsExecution: false,
    note: 'Commercial descriptor only — grants no execution capability. Automation, live execution and broker execution remain unavailable on every plan.',
  },
  capabilityGrants: { liveExecution: false, brokerExecution: false, automation: false },
};

/** Deep-freeze so no consumer can mutate a price, a limit or a capability grant. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * The single authoritative commercial catalogue, deeply frozen.
 */
const PLANS: PlanCatalogueEntry[] = [deepFreeze(STARTER), deepFreeze(PRO), deepFreeze(ELITE)];

export const BILLING_CATALOGUE: BillingCatalogue = Object.freeze({
  version: BILLING_CATALOGUE_VERSION,
  provider: BILLING_PROVIDER,
  currency: BILLING_CURRENCY,
  plans: PLANS,
});

/** Catalogue plans in ascending commercial order. */
export const COMMERCIAL_PLAN_CATALOGUE: readonly PlanCatalogueEntry[] = PLANS;

const PLAN_BY_ID: Readonly<Record<CommercialPlanId, PlanCatalogueEntry>> = Object.freeze({
  starter: STARTER,
  pro: PRO,
  elite: ELITE,
});

export function getCommercialPlan(planId: CommercialPlanId): PlanCatalogueEntry {
  return PLAN_BY_ID[planId];
}

export function commercialPlanPrice(planId: CommercialPlanId, interval: BillingInterval): PlanPrice {
  return getCommercialPlan(planId).pricing[interval];
}

// ---------------------------------------------------------------------------
// Compatibility boundary — commercial catalogue ⇄ internal plan values
// ---------------------------------------------------------------------------
//
// The database stores internal plan values `free` / `pro` / `premium`
// (migration 0001 `users.plan`, migration 0014 `subscriptions.plan`, both
// CHECK-constrained). The commercial catalogue is `starter` / `pro` / `elite`.
//
// PR1 renames nothing and migrates no user: changing the stored enum would
// require a migration (0031) and affect existing rows, which is explicitly out
// of scope here. Instead the two vocabularies coexist through the mapping
// below, which is **display/commercial only** and is never consulted by
// entitlement enforcement:
//
//   internal `pro`     → commercial `pro`    (1:1, same name)
//   internal `premium` → commercial `elite`  (highest internal tier)
//   internal `free`    → no commercial plan  (default, not sold)
//   commercial `starter` → no internal value yet (needs migration 0031)
//
// Entitlements continue to be resolved from the internal value, so an existing
// `premium` user keeps exactly the limits they have today — calling them
// "Elite" changes what we *sell* them, not what the server *enforces*.

export const COMMERCIAL_PLAN_FOR_INTERNAL_PLAN: Readonly<Record<UserPlan, CommercialPlanId | null>> = Object.freeze({
  free: null,
  pro: 'pro',
  premium: 'elite',
});

export const INTERNAL_PLAN_FOR_COMMERCIAL_PLAN: Readonly<Record<CommercialPlanId, UserPlan | null>> = Object.freeze({
  starter: null, // requires a new internal plan value — migration 0031, later PR
  pro: 'pro',
  elite: 'premium',
});

/** Commercial counterpart of an internal plan value, or `null` when there is none. */
export function commercialPlanForInternalPlan(plan: UserPlan): CommercialPlanId | null {
  return COMMERCIAL_PLAN_FOR_INTERNAL_PLAN[plan];
}

/** Internal plan value a commercial plan maps onto today, or `null` when it has none yet. */
export function internalPlanForCommercialPlan(planId: CommercialPlanId): UserPlan | null {
  return INTERNAL_PLAN_FOR_COMMERCIAL_PLAN[planId];
}

/** Catalogue entry for an internal plan value, or `null` when the plan is not sold. */
export function commercialPlanCatalogueEntry(plan: UserPlan): PlanCatalogueEntry | null {
  const planId = commercialPlanForInternalPlan(plan);
  return planId === null ? null : getCommercialPlan(planId);
}
