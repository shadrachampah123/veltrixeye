import type { UserPlan } from '@veltrixeye/contracts';
import { FREE_ENTITLEMENTS, getEntitlements, type Entitlements } from './entitlements.js';

/**
 * READ-SIDE ENTITLEMENT RESOLUTION — the fail-closed gate in front of the plan
 * matrix.
 *
 * `./entitlements.ts` resolves limits from the internal `plan` + `status` pair
 * and stays provider-agnostic. This module is the ONLY place where a
 * subscription row's `provider` column may influence an entitlement, and it can
 * only ever narrow one:
 *
 * ```text
 * provider IS NULL, no activation      → getEntitlements(plan, status)  (unchanged history)
 * provider IS NULL, activated          → FREE_ENTITLEMENTS               (incoherent: fail closed)
 * provider IS NOT NULL, not activated  → FREE_ENTITLEMENTS               (evidence is not authority)
 * provider IS NOT NULL, activated      → getEntitlements(plan, status)   (the activation fact)
 * ```
 *
 * WHY. A row whose `provider` is set was created by a payment-provider
 * checkout (`BillingCheckoutService`), which INSERTs `status = 'active'`
 * together with `provider_state = 'pending'` BEFORE any money has moved.
 * Verified payment evidence (migration 0033) proves a transaction happened but
 * is deliberately only EVIDENCE: it grants nothing. What authorizes a paid
 * entitlement is an explicit, out-of-band OPERATOR AUTHORIZATION recorded as
 * an immutable activation fact (migration 0034,
 * `BillingActivationService`). Until that fact exists, no provider-reported
 * value — `provider_state`, `status`, or anything else on the row — is
 * authority, so a provider-backed row is granted nothing above the free tier.
 *
 * WHAT THIS IS NOT.
 *  - Not a second entitlement matrix: the paid and free tiers returned here
 *    ARE the objects owned by `./entitlements.ts`.
 *  - Not a payment decision. It never confirms, denies, records or verifies a
 *    payment; it reads a durable fact that someone else authorized.
 *  - Not a write. It performs no I/O and never touches `users.plan`.
 *  - Not a status mapper: `status` is still the authoritative lifecycle value
 *    and is passed through untouched for historical rows.
 *  - Not an execution grant: `canAccessAutomation` is false in every tier.
 *
 * `provider` is a REQUIRED parameter compared with `!== null` on purpose: a
 * reader that forgets to SELECT the column resolves to `undefined`, which is
 * `!== null`, and therefore lands on the free tier — never on a paid one.
 *
 * `activated` is a REQUIRED fourth parameter for the same reason: a reader
 * that forgets to ask whether an activation fact exists passes `undefined`,
 * which is not `true`, and therefore fails closed to the free tier for every
 * provider-backed row. A paid entitlement for a provider-backed row is
 * reachable ONLY by explicitly passing the durable activation state.
 */
export function resolveEntitlements(
  plan: UserPlan,
  status: string,
  provider: string | null,
  activated: boolean,
): Entitlements {
  if (provider !== null) {
    // Provider-backed: an unconfirmed checkout, or an activated one.
    if (activated !== true) return FREE_ENTITLEMENTS;
    return getEntitlements(plan, status);
  }
  // No provider: a historical (or free) row. An activation fact for such a row
  // is incoherent — the database refuses one — so fail closed rather than
  // honouring a state that cannot legitimately exist.
  if (activated === true) return FREE_ENTITLEMENTS;
  return getEntitlements(plan, status);
}
