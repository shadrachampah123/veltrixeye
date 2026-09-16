import { z } from 'zod';
import { userPlanSchema } from './users.js';

export const subscriptionStatusSchema = z.enum(['active', 'trialing', 'past_due', 'canceled', 'expired']);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

export const subscriptionDtoSchema = z.object({
  id: z.string(),
  plan: userPlanSchema,
  status: subscriptionStatusSchema,
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
});
export type SubscriptionDto = z.infer<typeof subscriptionDtoSchema>;

export const entitlementsDtoSchema = z.object({
  maxStrategies: z.number(),
  maxBacktestsPerMonth: z.number(),
  maxAlertsPerMonth: z.number(),
  maxSavedSetups: z.number(),
  canAccessScanner: z.boolean(),
  canAccessAdvancedStrategies: z.boolean(),
  canAccessAdvancedAlerts: z.boolean(),
  canAccessAutomation: z.boolean(),
});
export type EntitlementsDto = z.infer<typeof entitlementsDtoSchema>;

export const billingStateDtoSchema = z.object({
  subscription: subscriptionDtoSchema,
  entitlements: entitlementsDtoSchema,
});
export type BillingStateDto = z.infer<typeof billingStateDtoSchema>;
