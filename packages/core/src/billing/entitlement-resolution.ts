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
 * provider IS NULL      → getEntitlements(plan, status)   (unchanged history)
 * provider IS NOT NULL  → FREE_ENTITLEMENTS               (fail closed)
 * ```
 *
 * WHY. A row whose `provider` is set was created by a payment-provider checkout
 * (`BillingCheckoutService`), which INSERTs `status = 'active'` together with
 * `provider_state = 'pending'` BEFORE any money has moved. This build has no
 * payment-confirmation authority: no webhook receiver, no signature
 * verification, no transaction verification. Until one exists, no
 * provider-reported value — `provider_state`, `status`, or anything else on the
 * row — is evidence of payment, so a provider-backed row is granted nothing
 * above the free tier.
 *
 * WHAT THIS IS NOT.
 *  - Not a second entitlement matrix: the free tier returned here IS the
 *    `FREE_ENTITLEMENTS` object owned by `./entitlements.ts`.
 *  - Not a payment decision. It never confirms, denies, records or verifies a
 *    payment; it only declines to grant anything paid.
 *  - Not a write. It performs no I/O and never touches `users.plan`.
 *  - Not a status mapper: `status` is still the authoritative lifecycle value
 *    and is passed through untouched for historical rows.
 *
 * `provider` is a REQUIRED parameter compared with `!== null` on purpose: a
 * reader that forgets to SELECT the column resolves to `undefined`, which is
 * `!== null`, and therefore lands on the free tier — never on a paid one.
 * Removing this gate requires a real confirmation authority first; see
 * docs/billing.md.
 */
export function resolveEntitlements(
  plan: UserPlan,
  status: string,
  provider: string | null,
): Entitlements {
  if (provider !== null) return FREE_ENTITLEMENTS;
  return getEntitlements(plan, status);
}
