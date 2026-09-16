import type { UserPlan } from '@veltrixeye/contracts';

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
