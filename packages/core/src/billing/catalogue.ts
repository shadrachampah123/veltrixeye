import {
  BILLING_CATALOGUE,
  BILLING_CATALOGUE_VERSION,
  COMMERCIAL_PLANS,
  billingCatalogueSchema,
  commercialPlanForInternalPlan,
  getCommercialPlan,
  internalPlanForCommercialPlan,
  type BillingCatalogue,
  type BillingInterval,
  type CommercialPlanId,
  type PlanCatalogueEntry,
} from '@veltrixeye/contracts';
import type { UserPlan } from '@veltrixeye/contracts';

/**
 * PR1 — server-side billing catalogue authority.
 *
 * Three layers are kept strictly separate, and this module is the boundary
 * between the first two:
 *
 *   1. COMMERCIAL CATALOGUE (this module) — what is *sold*: Starter/Pro/Elite,
 *      USD monthly + annual prices, active-strategy allowance, market coverage
 *      and the trade-frequency descriptor. Display/pricing only.
 *   2. ENTITLEMENT ENFORCEMENT — `packages/core/src/billing/entitlements.ts`.
 *      Unchanged by PR1: limits are still resolved from the internal plan value
 *      (`free` / `pro` / `premium`) plus subscription status. No catalogue field
 *      feeds a limit check.
 *   3. FUTURE EXECUTION CAPABILITIES — automation / live / broker execution stay
 *      OFF for every plan. Elite's "priority execution" is a commercial
 *      descriptor; it does not enable execution, touch Gate 9, wire B1/B2
 *      composition, change `canAccessAutomation`, or add broker/MT5/Exness
 *      functionality.
 *
 * No provider call, checkout, portal, webhook, verification or subscription
 * synchronization exists here — those are later billing PRs.
 */

export {
  BILLING_CATALOGUE,
  BILLING_CATALOGUE_VERSION,
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  COMMERCIAL_PLANS,
  commercialPlanForInternalPlan,
  getCommercialPlan,
  internalPlanForCommercialPlan,
  type BillingCatalogue,
  type BillingInterval,
  type CommercialPlanId,
  type PlanCatalogueEntry,
} from '@veltrixeye/contracts';

/**
 * The catalogue the server serves from, validated once at module load. A
 * malformed catalogue is a boot-time failure, never a silent fallback.
 */
const parsed = billingCatalogueSchema.safeParse(BILLING_CATALOGUE);
if (!parsed.success) {
  throw new Error(
    `Invalid commercial billing catalogue (${BILLING_CATALOGUE_VERSION}): ${parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')}`,
  );
}

export const SERVER_BILLING_CATALOGUE: BillingCatalogue = BILLING_CATALOGUE;

/** Catalogue entry for a commercial plan id (server-side accessor). */
export function planCatalogueEntry(planId: CommercialPlanId): PlanCatalogueEntry {
  return getCommercialPlan(planId);
}

/**
 * Catalogue entry for an **internal** plan value, or `null` when that internal
 * value has no commercial counterpart (`free`) — see the compatibility mapping
 * documented in `packages/contracts/src/billing-catalogue.ts`.
 *
 * Display/commercial use only: entitlement enforcement never calls this.
 */
export function catalogueEntryForPlan(plan: UserPlan): PlanCatalogueEntry | null {
  const planId = commercialPlanForInternalPlan(plan);
  return planId === null ? null : getCommercialPlan(planId);
}

/** USD price (minor units) for a commercial plan and interval. */
export function cataloguePriceMinor(planId: CommercialPlanId, interval: BillingInterval): number {
  return getCommercialPlan(planId).pricing[interval].amountMinor;
}

/**
 * Commercial plans that cannot be sold yet because no internal plan value
 * exists for them (Starter). Selling them requires migration 0031 — later PR.
 */
export function unmappedCommercialPlans(): CommercialPlanId[] {
  return COMMERCIAL_PLANS.filter((planId) => internalPlanForCommercialPlan(planId) === null);
}
