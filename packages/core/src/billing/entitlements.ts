import type { UserPlan } from '@veltrixeye/contracts';

/**
 * ENTITLEMENT ENFORCEMENT — the only place plan limits are resolved.
 *
 * Keyed on the **internal** plan values (`free` / `pro` / `premium`, stored in
 * `users.plan` and `subscriptions.plan`), never on the commercial catalogue
 * (`starter` / `pro` / `elite`). The active-strategy ceilings below align those
 * internal values with Starter / Pro / Elite without renaming stored values or
 * rewriting any customer's subscription or strategy records. Starter remains
 * unavailable as a checkout plan until its internal-plan mapping is resolved.
 *
 * `canAccessAutomation` is `false` for every plan and must stay that way: the
 * commercial catalogue cannot grant execution capability.
 *
 * This module is deliberately provider-agnostic: it reads `plan` + `status` and
 * nothing else. The read-side gate that decides whether a subscription row is
 * allowed to reach this matrix at all lives beside it, in
 * `./entitlement-resolution.ts`.
 */

export interface Entitlements {
  maxStrategies: number | null;
  maxBacktestsPerMonth: number;
  maxAlertsPerMonth: number;
  maxSavedSetups: number;
  canAccessScanner: boolean;
  canAccessAdvancedStrategies: boolean;
  canAccessAdvancedAlerts: boolean;
  canAccessAutomation: boolean; // M8 future
}

/**
 * The free tier, exported so the read-side resolver in
 * `./entitlement-resolution.ts` can return THIS object instead of restating a
 * second matrix. There is exactly one definition of every tier.
 */
export const FREE_ENTITLEMENTS: Entitlements = {
  // The existing no-subscription tier receives Starter's advertised allowance.
  maxStrategies: 1,
  maxBacktestsPerMonth: 100,
  maxAlertsPerMonth: 1000,
  maxSavedSetups: 1000,
  canAccessScanner: false,
  canAccessAdvancedStrategies: false,
  canAccessAdvancedAlerts: false,
  canAccessAutomation: false,
};

const PRO_ENTITLEMENTS: Entitlements = {
  maxStrategies: 5,
  maxBacktestsPerMonth: 1000,
  maxAlertsPerMonth: 5000,
  maxSavedSetups: 5000,
  canAccessScanner: true,
  canAccessAdvancedStrategies: true,
  canAccessAdvancedAlerts: true,
  canAccessAutomation: false, // M8 future, off for everyone for now
};

// `null` is the explicit unlimited sentinel in the public entitlement DTO.
const PREMIUM_ENTITLEMENTS: Entitlements = {
  maxStrategies: null,
  maxBacktestsPerMonth: 5000,
  maxAlertsPerMonth: 10000,
  maxSavedSetups: 10000,
  canAccessScanner: true,
  canAccessAdvancedStrategies: true,
  canAccessAdvancedAlerts: true,
  canAccessAutomation: false, // M8 future
};

export function getEntitlements(plan: UserPlan, status: string): Entitlements {
  // If subscription is not in a valid active state, fall back to free
  if (!['active', 'trialing', 'past_due'].includes(status)) {
    return FREE_ENTITLEMENTS;
  }

  switch (plan) {
    case 'premium':
      return PREMIUM_ENTITLEMENTS;
    case 'pro':
      return PRO_ENTITLEMENTS;
    case 'free':
    default:
      return FREE_ENTITLEMENTS;
  }
}
