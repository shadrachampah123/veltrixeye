import type { Pool } from 'pg';
import { z } from 'zod';
import {
  BILLING_PROVIDER,
  BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT,
  billingPaymentCurrencySchema,
  billingProviderModeSchema,
  billingVerifiedPaymentRecordDtoSchema,
  billingVerifiedPaymentRecordsDtoSchema,
  type BillingProviderMode,
  type BillingVerifiedPaymentRecordsDto,
} from '@veltrixeye/contracts';

/**
 * Billing Step 9b-R1 — authenticated user's read-only verified-payment view.
 *
 * The caller supplies the user id from the authenticated session and the mode
 * from server configuration. This function reads only the stored evidence
 * ledger, scopes every query by both values, returns at most the newest 25
 * records, and projects only stored amount/currency/exponent/timestamps.
 *
 * It has no write, provider, FX, entitlement, activation or execution path.
 * A verification record remains evidence only; this reader neither confirms
 * payment to entitlements nor contacts Paystack to fill in missing history.
 */

/* -------------------------------------------------------------------------- */
/* Selected-row boundary                                                      */
/* -------------------------------------------------------------------------- */

const safePositiveMinorUnitsSchema = z
  .union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)),
    z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .refine((value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), {
        message: 'a minor-unit amount must be a safe integer',
      }),
  ])
  .transform((value) => Number(value));

const storedInstantSchema = z
  .union([z.date(), z.string().datetime()])
  .transform((value) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString()));

/** Exactly the display columns selected below; no identifiers or provider data. */
const paymentRecordRowSchema = z
  .object({
    payment_amount_minor: safePositiveMinorUnitsSchema,
    payment_currency: billingPaymentCurrencySchema,
    payment_amount_exponent: z.literal(2),
    paid_at: storedInstantSchema,
    verified_at: storedInstantSchema,
  })
  .strict();

/**
 * Read the newest verified payment records for one authenticated account and
 * one server-selected Paystack mode. This function never accepts request data.
 * A malformed persisted row fails closed; the API replaces the failure with
 * `UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS` rather than returning a
 * partial or untrusted list.
 */
export async function readBillingVerifiedPaymentRecords(
  db: Pool,
  userId: string,
  mode: BillingProviderMode,
): Promise<BillingVerifiedPaymentRecordsDto> {
  const parsedMode = billingProviderModeSchema.safeParse(mode);
  if (!parsedMode.success) throw new Error('The configured billing mode is not supported by this read.');

  const { rows } = await db.query(
    `SELECT payment_amount_minor, payment_currency, payment_amount_exponent, paid_at, verified_at
       FROM billing_verified_transactions
      WHERE user_id = $1 AND provider = $2 AND provider_domain = $3
      ORDER BY paid_at DESC, verified_at DESC, id DESC
      LIMIT $4`,
    [userId, BILLING_PROVIDER, parsedMode.data, BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT + 1],
  );

  const hasMore = rows.length > BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT;
  const records = rows.slice(0, BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT).map((raw) => {
    const row = paymentRecordRowSchema.safeParse(raw);
    if (!row.success) {
      // Do not include the raw database row or provider-shaped value in the
      // exception: callers log this failure server-side and fail closed.
      throw new Error('A stored verified payment record is not usable by the read-only view.');
    }
    return billingVerifiedPaymentRecordDtoSchema.parse({
      amountMinor: row.data.payment_amount_minor,
      currency: row.data.payment_currency,
      exponent: row.data.payment_amount_exponent,
      paidAt: row.data.paid_at,
      verifiedAt: row.data.verified_at,
    });
  });

  return billingVerifiedPaymentRecordsDtoSchema.parse({
    state: 'available',
    mode: parsedMode.data,
    records,
    hasMore,
  });
}
