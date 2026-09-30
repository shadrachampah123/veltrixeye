import type { UserPlan } from '@veltrixeye/contracts';
import { getEntitlements, type Entitlements } from './entitlements.js';

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
 * grant exists                          → getEntitlements(grant, status)  (the operator grant)
 * no grant, provider IS NULL, no act    → getEntitlements(plan, status)  (unchanged history)
 * no grant, provider IS NULL, activated → FREE_ENTITLEMENTS               (incoherent: fail closed)
 * no grant, provider IS NOT NULL, no act → FREE_ENTITLEMENTS              (evidence is not authority)
 * no grant, provider IS NOT NULL, act   → getEntitlements(plan, status)   (the activation fact)
 * ```
 *
 * The four no-grant rows are `resolvePaidTier` — the tier the PAID authority
 * alone confers — and `resolveEntitlements` is exactly `getEntitlements` of
 * whichever tier those rules name. Splitting the decision out means the WRITE
 * path can ask the SAME question the read path answers ("what does this
 * account hold without a grant?") without restating the provider/activation
 * rules a third time: see `assertGrantDoesNotNarrow` in
 * `./entitlement-grants.ts`.
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
 * THE GRANT (migration 0036) IS A SECOND, SEPARATE AUTHORITY — not a hole in
 * the first. `BillingActivationService` is unreachable for an account that has
 * no verified payment, and verified payment is only ever produced by a REAL
 * provider read, so the payment path is (correctly) closed to any account that
 * has not paid. A non-commercial grant
 * (`BillingEntitlementGrantService`) is how a NAMED OPERATOR gives one named
 * account a commercial tier without a purchase. It carries no payment field of
 * any kind, it is consulted only here, and it cannot make a granted account
 * look paid: `paymentConfirmed` is still derived from the activation fact
 * alone and stays `false` for a granted account.
 *
 * THE GRANT IS CHECKED FIRST because it is an ACCOUNT-level authority, not a
 * statement about one subscription row: a granted account characteristically
 * has no `subscriptions` row at all (since Model C that absence IS the free
 * state), so the grant has to be able to stand on its own. It is not an escape
 * hatch for the payment rules below — it confers exactly the tier its own fact
 * names, and every payment rule is otherwise unchanged.
 *
 * WHAT THIS IS NOT.
 *  - Not a second entitlement matrix: the paid and free tiers returned here
 *    ARE the objects owned by `./entitlements.ts`.
 *  - Not a payment decision. It never confirms, denies, records or verifies a
 *    payment; it reads durable facts that someone else authorized.
 *  - Not a write. It performs no I/O and never touches `users.plan`.
 *  - Not a status mapper: `status` is still the authoritative lifecycle value
 *    and is passed through untouched for every tier, granted or not — a granted
 *    account whose authoritative status does not carry a paid period still
 *    resolves to the free tier.
 *  - Not an execution grant: `canAccessAutomation` is false in every tier, so a
 *    grant adds no capability the matrix did not already define.
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
 *
 * `grantedPlan` is a REQUIRED fifth parameter for the same reason, and it
 * carries the grant's OWN tier rather than a boolean: the account-level grant
 * names the tier it confers, and a reader that forgets to ask passes
 * `undefined`, which is not a plan, and therefore takes the ordinary free path.
 */

/**
 * The tier the PAID authority alone confers on a subscription row, with no
 * operator grant in the picture. This is the whole of the provider/activation
 * policy, lifted out of `resolveEntitlements` so there is exactly one statement
 * of it and the write path can evaluate it too.
 *
 * Returns `'free'` for every state that is not an authorized paid period, and
 * the row's own `plan` for one that is. The caller is still responsible for
 * passing the authoritative `status` to `getEntitlements` — a lapsed
 * `canceled` row therefore reports its `premium` plan here and resolves to the
 * free tier there, exactly as before this split.
 */
export function resolvePaidTier(
  plan: UserPlan,
  provider: string | null,
  activated: boolean,
): UserPlan {
  if (provider !== null) {
    // Provider-backed: an unconfirmed checkout, or an activated one.
    if (activated !== true) return 'free';
    return plan;
  }
  // No provider: a historical (or free) row. An activation fact for such a row
  // is incoherent — the database refuses one — so fail closed rather than
  // honouring a state that cannot legitimately exist.
  return activated === true ? 'free' : plan;
}

export function resolveEntitlements(
  plan: UserPlan,
  status: string,
  provider: string | null,
  activated: boolean,
  grantedPlan: UserPlan | null,
): Entitlements {
  // A standing, operator-authorized non-commercial grant (migration 0036): it
  // confers exactly the tier its own fact names, and is still gated by the
  // authoritative lifecycle status. A grant that would NARROW what the paid
  // rules below already confer is refused at write time
  // (`assertGrantDoesNotNarrow`), so this precedence can never be used to take
  // an entitlement away from an account that has one.
  if (grantedPlan != null) return getEntitlements(grantedPlan, status);
  return getEntitlements(resolvePaidTier(plan, provider, activated), status);
}
