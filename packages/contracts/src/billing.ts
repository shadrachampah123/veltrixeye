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
 * This is INFORMATION, never authority. Nothing here confirms a payment by
 * itself, and nothing here can widen an entitlement: `entitlements` is the only
 * capability statement in the response, and for a provider-backed subscription
 * it stays the free tier unless a durable activation fact exists.
 *
 * A subscription row whose `provider` is set was created by a checkout
 * (`provider_state = 'pending'`, `status = 'active'`) BEFORE any money moved.
 * Publishing the provider and its reported state is what stops that row from
 * being presented to the user as a confirmed paid subscription.
 *
 * `paymentConfirmed` is a real boolean, and it is DERIVED — never accepted as
 * input and never stored as a second mutable authority. The only thing that
 * makes it `true` is the existence of an immutable activation fact
 * (`billing_subscription_activations`, migration 0034) written by the
 * out-of-band operator CLI (`BillingActivationService`). Verified payment
 * evidence alone (migration 0033) does NOT set it: evidence is a receipt, and a
 * receipt is not authority. There is deliberately no `payment_confirmed`
 * column anywhere, so no client payload, provider event or synchronization can
 * ever write this value.
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
    /**
     * `true` only when a durable activation fact exists for this subscription
     * (Billing Step 8). Always `false` for a historical (`provider IS NULL`)
     * row, for a provider-backed checkout that was never activated, and for
     * every row that only has payment evidence.
     */
    paymentConfirmed: z.boolean(),
  })
  .strict();
export type BillingProviderStatusDto = z.infer<typeof billingProviderStatusDtoSchema>;

export const billingStateDtoSchema = z.object({
  subscription: subscriptionDtoSchema,
  entitlements: entitlementsDtoSchema,
  providerStatus: billingProviderStatusDtoSchema,
});
export type BillingStateDto = z.infer<typeof billingStateDtoSchema>;
