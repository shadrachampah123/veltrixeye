import { z } from 'zod';
import { billingPaymentCurrencySchema } from './billing-payment.js';
import { billingIsoDateTimeSchema, billingProviderModeSchema } from './billing-refs.js';

/**
 * Billing Step 9b-R1 — read-only verified-payment-records contracts.
 *
 * These records are a bounded projection of `billing_verified_transactions`,
 * not a provider invoice or a complete billing history. Amounts remain integer
 * minor units; the client receives no row, user, subscription, provider or
 * checkout identifiers, references, hashes, pricing snapshots or secrets.
 * The DTO is informational only: a verified record is evidence, never an
 * activation or an execution/automation grant.
 */
export const BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT = 25;

/** One stored amount and its two persisted instants — no derived billing facts. */
export const billingVerifiedPaymentRecordDtoSchema = z
  .object({
    amountMinor: z.number().int().positive().refine(Number.isSafeInteger, {
      message: 'a minor-unit amount must be a safe integer',
    }),
    currency: billingPaymentCurrencySchema,
    exponent: z.literal(2),
    /** Provider-reported payment instant, preserved from the evidence row. */
    paidAt: billingIsoDateTimeSchema,
    /** Local verification instant, preserved from the evidence row. */
    verifiedAt: billingIsoDateTimeSchema,
  })
  .strict();
export type BillingVerifiedPaymentRecordDto = z.infer<typeof billingVerifiedPaymentRecordDtoSchema>;

const availableRecordsSchema = z
  .object({
    state: z.literal('available'),
    /** Provider mode selected by server configuration; never client supplied. */
    mode: billingProviderModeSchema,
    records: z.array(billingVerifiedPaymentRecordDtoSchema).max(BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT),
    /** True when at least one older record exists beyond this bounded view. */
    hasMore: z.boolean(),
  })
  .strict();

const unavailableRecordsSchema = z
  .object({
    state: z.literal('unavailable'),
    mode: z.null(),
    records: z.array(billingVerifiedPaymentRecordDtoSchema).length(0),
    hasMore: z.literal(false),
  })
  .strict();

/** Strict, minimal API answer for `GET /api/billing/verified-payment-records`. */
export const billingVerifiedPaymentRecordsDtoSchema = z.discriminatedUnion('state', [
  availableRecordsSchema,
  unavailableRecordsSchema,
]);
export type BillingVerifiedPaymentRecordsDto = z.infer<typeof billingVerifiedPaymentRecordsDtoSchema>;

/** The fail-closed answer claims no records or provider mode when the read fails. */
export const UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS: BillingVerifiedPaymentRecordsDto = Object.freeze(
  billingVerifiedPaymentRecordsDtoSchema.parse({
    state: 'unavailable',
    mode: null,
    records: [],
    hasMore: false,
  }),
);
