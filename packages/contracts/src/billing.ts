import { z } from 'zod';
import { userPlanSchema } from './users.js';
import { billingProviderModeSchema } from './billing-refs.js';

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

/**
 * A non-commercial, operator-authorized entitlement grant in force for the
 * session's own account (migration 0036, `billing_entitlement_grants`).
 *
 * This is DISCLOSURE, never authority and never a payment. It exists so an
 * account that holds a commercial entitlement tier WITHOUT having bought
 * anything is told why its limits are what they are, rather than being shown a
 * "free plan" card with Pro limits on it.
 *
 * What it deliberately does NOT carry — and the strict schema is what enforces
 * it, so the omission is a property of the code rather than a convention at a
 * call site:
 *  - no operator identity and no reason: an account learns the fact of its own
 *    entitlement, never who decided it or why (the same discipline the
 *    read-only billing overview already applies);
 *  - no id, no idempotency key, no grant kind, no instant;
 *  - and above all **no payment fact of any kind** — a grant is not a purchase,
 *    so there is no provider, reference, amount, currency or confirmation to
 *    carry even in principle.
 *
 * Its presence does **not** move `providerStatus.paymentConfirmed`. That field
 * is derived from the activation fact (0034) alone and stays `false` for a
 * granted account, permanently and correctly: no money changed hands.
 */
export const billingEntitlementGrantDtoSchema = z
  .object({
    /**
     * The INTERNAL plan value whose enforced tier is granted: `pro` (commercial
     * Pro) or `premium` (commercial Elite). `free` is ungrantable and Starter
     * has no enforced tier, so neither can appear here.
     */
    plan: userPlanSchema,
  })
  .strict();
export type BillingEntitlementGrantDto = z.infer<typeof billingEntitlementGrantDtoSchema>;

/** Alias used inside core, where the DTO is the disclosure projection. */
export type BillingEntitlementGrantDisclosure = BillingEntitlementGrantDto;

export const billingStateDtoSchema = z.object({
  /**
   * The configured provider mode this response is served in: `test`
   * (sandbox, the default) or `live`. Display-only — the UI derives its copy
   * ("Sandbox Checkout" vs "Checkout") from this field so a live deployment
   * never claims to be a sandbox, and vice versa. It never widens any
   * capability in the payload.
   */
  mode: billingProviderModeSchema,
  subscription: subscriptionDtoSchema,
  entitlements: entitlementsDtoSchema,
  providerStatus: billingProviderStatusDtoSchema,
  /**
   * The non-commercial operator grant in force for this account, or `null`.
   *
   * Always present (`null` when there is none) so a client never has to
   * distinguish "no grant" from "this build does not know about grants".
   * `entitlements` above is still the ONLY capability statement in this
   * response — this field explains it, it never widens it, and it never
   * confirms a payment.
   */
  entitlementGrant: billingEntitlementGrantDtoSchema.nullable(),
});
export type BillingStateDto = z.infer<typeof billingStateDtoSchema>;
