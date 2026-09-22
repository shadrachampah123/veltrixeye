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

/**
 * Read-only provider display state carried alongside a billing-state response.
 *
 * This is INFORMATION, never authority. Nothing here confirms a payment, and
 * nothing here can widen an entitlement: `entitlements` is the only capability
 * statement in the response, and for a provider-backed subscription it is the
 * free tier until a real payment-confirmation authority exists.
 *
 * A subscription row whose `provider` is set was created by a checkout
 * (`provider_state = 'pending'`, `status = 'active'`) BEFORE any money moved.
 * Publishing the provider and its reported state is what stops that row from
 * being presented to the user as a confirmed paid subscription.
 *
 * `paymentConfirmed` is pinned to `z.literal(false)` the same way the provider
 * seam pins `grantsExecution` / `planChanged` / `entitlementsChanged`: in this
 * build a confirmed payment is UNREPRESENTABLE, so no caller can read the field
 * as `true` and no producer can emit `true`. Turning it into a real boolean is
 * the job of the (still absent) confirmation authority, not of a display layer.
 *
 * `provider` and `providerState` are opaque nullable strings rather than the
 * `billing-provider.js` enums: that module imports this one, so importing it
 * back would create a cycle, and these two fields are display text that is
 * never compared against, mapped, or used to resolve an entitlement. The
 * persisted vocabulary stays owned by migration `0031_provider_billing.sql`.
 */
export const billingProviderStatusDtoSchema = z
  .object({
    /** Billing provider the row was created through; `null` for historical rows. */
    provider: z.string().nullable(),
    /** The provider's last reported lifecycle state; `null` when never reported. */
    providerState: z.string().nullable(),
    /** Always `false`: no payment-confirmation authority exists in this build. */
    paymentConfirmed: z.literal(false),
  })
  .strict();
export type BillingProviderStatusDto = z.infer<typeof billingProviderStatusDtoSchema>;

export const billingStateDtoSchema = z.object({
  subscription: subscriptionDtoSchema,
  entitlements: entitlementsDtoSchema,
  providerStatus: billingProviderStatusDtoSchema,
});
export type BillingStateDto = z.infer<typeof billingStateDtoSchema>;
