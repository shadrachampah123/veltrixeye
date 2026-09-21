import type { UserPlan } from '@veltrixeye/contracts';

/**
 * ENTITLEMENT ENFORCEMENT — the only place plan limits are resolved.
 *
 * Keyed on the **internal** plan values (`free` / `pro` / `premium`, stored in
 * `users.plan` and `subscriptions.plan`), never on the commercial catalogue
 * (`starter` / `pro` / `elite`). PR1 introduces the commercial catalogue in
 * `./catalogue.ts`; it changes nothing here. Renaming the stored values or
 * migrating existing users requires a migration (0031) and is out of scope for
 * PR1 — see docs/billing.md "Compatibility boundary".
 *
 * `canAccessAutomation` is `false` for every plan and must stay that way: the
 * commercial catalogue cannot grant execution capability.
 */

export interface Entitlements {
  maxStrategies: number;
  maxBacktestsPerMonth: number;
  maxAlertsPerMonth: number;
  maxSavedSetups: number;
  canAccessScanner: boolean;
  canAccessAdvancedStrategies: boolean;
  canAccessAdvancedAlerts: boolean;
  canAccessAutomation: boolean; // M8 future
}

const FREE_ENTITLEMENTS: Entitlements = {
  maxStrategies: 100,
  maxBacktestsPerMonth: 100,
  maxAlertsPerMonth: 1000,
  maxSavedSetups: 1000,
  canAccessScanner: false,
  canAccessAdvancedStrategies: false,
  canAccessAdvancedAlerts: false,
  canAccessAutomation: false,
};

const PRO_ENTITLEMENTS: Entitlements = {
  maxStrategies: 500,
  maxBacktestsPerMonth: 1000,
  maxAlertsPerMonth: 5000,
  maxSavedSetups: 5000,
  canAccessScanner: true,
  canAccessAdvancedStrategies: true,
  canAccessAdvancedAlerts: true,
  canAccessAutomation: false, // M8 future, off for everyone for now
};

const PREMIUM_ENTITLEMENTS: Entitlements = {
  maxStrategies: 1000,
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
