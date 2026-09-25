import { z } from 'zod';
import { BILLING_PROVIDER } from './billing-catalogue.js';
import { billingIsoDateTimeSchema } from './billing-refs.js';

/**
 * Billing Step 6 (roadmap item 8a) — the customer provisioning RESULT.
 *
 * What `POST /api/billing/customer` answers after it has ensured that the
 * signed-in user has a local, provider-backed billing customer. It is the
 * signed-in user's OWN record, reduced to what a client may need:
 *
 *  - NO provider customer id/code, NO local row id and NO user id are
 *    returned. The provider identifiers are reference data for the adapter,
 *    not something the browser needs, and the subject is always the session.
 *  - `status` is pinned to `provisioned`: every other `billing_customers`
 *    status is a refusal, never a result.
 *  - `entitlementsChanged` and `grantsExecution` are `z.literal(false)`:
 *    provisioning a provider customer is identity bookkeeping. It buys
 *    nothing, confirms nothing and can never widen an entitlement or grant
 *    execution — that is unrepresentable in this contract.
 */

/**
 * How the result was reached.
 *  - `created`: no provider customer existed for the account email; the
 *    provider created one and it was persisted locally.
 *  - `linked`: the provider already had a customer for the account email; it
 *    was persisted locally (no provider creation).
 *  - `already_provisioned`: a usable local customer already existed; nothing
 *    was called and nothing was written.
 */
export const BILLING_CUSTOMER_PROVISIONING_OUTCOMES = ['created', 'linked', 'already_provisioned'] as const;
export type BillingCustomerProvisioningOutcome = (typeof BILLING_CUSTOMER_PROVISIONING_OUTCOMES)[number];
export const billingCustomerProvisioningOutcomeSchema = z.enum(BILLING_CUSTOMER_PROVISIONING_OUTCOMES);

export const billingCustomerProvisioningResultSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    outcome: billingCustomerProvisioningOutcomeSchema,
    status: z.literal('provisioned'),
    /** The normalized (lowercase) account email presented to the provider. */
    email: z
      .string()
      .email()
      .max(254)
      .refine((value) => value === value.toLowerCase(), { message: 'email must be normalized to lowercase' }),
    provisionedAt: billingIsoDateTimeSchema,
    /** The local identity satisfies checkout's existing-customer requirement. */
    checkoutReady: z.literal(true),
    entitlementsChanged: z.literal(false),
    grantsExecution: z.literal(false),
  })
  .strict();
export type BillingCustomerProvisioningResult = z.infer<typeof billingCustomerProvisioningResultSchema>;
