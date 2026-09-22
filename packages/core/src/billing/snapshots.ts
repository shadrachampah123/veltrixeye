import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { billingPricingSnapshotSchema, type BillingPricingSnapshot } from '@veltrixeye/contracts';
import { BillingPricingError, pricingIdempotencyKey, verifyPricingSnapshot } from './pricing.js';

export interface StoredBillingPricingSnapshot {
  id: string;
  idempotencyKey: string;
  snapshot: BillingPricingSnapshot;
}

const integer = z.union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number).pipe(z.number().int().safe());
const timestamp = z.union([z.date(), z.string().datetime()])
  .transform((value) => new Date(value).toISOString());
const rowSchema = z.object({
  id: z.string().uuid(),
  commercial_currency: z.literal('USD'),
  commercial_amount_minor: integer,
  catalogue_plan: z.string(),
  billing_interval: z.string(),
  catalogue_version: z.string(),
  payment_currency: z.literal('GHS'),
  payment_amount_minor: integer,
  payment_amount_exponent: integer,
  fx_rate_scaled: integer,
  fx_rate_scale: integer,
  fx_rate_version_id: z.string().uuid(),
  fx_rate_effective_from: timestamp,
  fx_rate_captured_at: timestamp,
  fx_rate_source: z.string(),
  rounding_mode: z.string(),
  pricing_policy_version: z.string(),
  provider: z.literal('paystack'),
  provider_plan_id: z.string().nullable(),
  provider_reference: z.string().nullable(),
  idempotency_key: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: timestamp,
}).strict();

function fromRow(input: unknown): StoredBillingPricingSnapshot {
  const parsedRow = rowSchema.safeParse(input);
  if (!parsedRow.success) {
    throw new BillingPricingError('invalid_snapshot', 'The stored pricing row is malformed.', { cause: parsedRow.error });
  }
  const row = parsedRow.data;
  const parsedSnapshot = billingPricingSnapshotSchema.safeParse({
    commercialCurrency: row.commercial_currency,
    commercialAmountMinor: row.commercial_amount_minor,
    cataloguePlan: row.catalogue_plan,
    interval: row.billing_interval,
    catalogueVersion: row.catalogue_version,
    payment: {
      paymentCurrency: row.payment_currency,
      paymentAmountMinor: row.payment_amount_minor,
      paymentAmountExponent: row.payment_amount_exponent,
    },
    fx: {
      baseCurrency: row.commercial_currency,
      quoteCurrency: row.payment_currency,
      fxRateScaled: row.fx_rate_scaled,
      fxRateScale: row.fx_rate_scale,
      fxRateVersionId: row.fx_rate_version_id,
      fxRateEffectiveFrom: row.fx_rate_effective_from,
      fxRateCapturedAt: row.fx_rate_captured_at,
      fxRateSource: row.fx_rate_source,
      roundingMode: row.rounding_mode,
    },
    providerPlanId: row.provider_plan_id,
    providerReference: row.provider_reference,
    pricingPolicyVersion: row.pricing_policy_version,
    // The existing schema's recording timestamp stores computedAt losslessly.
    computedAt: row.created_at,
  });
  if (!parsedSnapshot.success) {
    throw new BillingPricingError('invalid_snapshot', 'The stored pricing snapshot is malformed.', { cause: parsedSnapshot.error });
  }
  const snapshot = verifyPricingSnapshot(parsedSnapshot.data);
  if (pricingIdempotencyKey(snapshot) !== row.idempotency_key) {
    throw new BillingPricingError('invalid_snapshot', 'The stored pricing idempotency key does not verify.');
  }
  return { id: row.id, idempotencyKey: row.idempotency_key, snapshot };
}

/** Thin append-only persistence; never updates or deletes a pricing decision. */
export class BillingPricingSnapshotStore {
  constructor(private readonly db: Pick<Pool | PoolClient, 'query'>) {}

  async findById(id: string): Promise<StoredBillingPricingSnapshot | null> {
    const { rows } = await this.db.query('SELECT * FROM billing_pricing_snapshots WHERE id = $1', [id]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async findByIdempotencyKey(key: string): Promise<StoredBillingPricingSnapshot | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM billing_pricing_snapshots WHERE idempotency_key = $1', [key],
    );
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async create(input: BillingPricingSnapshot): Promise<StoredBillingPricingSnapshot> {
    const s = verifyPricingSnapshot(billingPricingSnapshotSchema.parse(input));
    const key = pricingIdempotencyKey(s);
    const { rows } = await this.db.query(
      `INSERT INTO billing_pricing_snapshots (
         commercial_currency, commercial_amount_minor, catalogue_plan, billing_interval,
         catalogue_version, payment_currency, payment_amount_minor, payment_amount_exponent,
         fx_rate_scaled, fx_rate_scale, fx_rate_version_id, fx_rate_effective_from,
         fx_rate_captured_at, fx_rate_source, rounding_mode, pricing_policy_version,
         provider, provider_plan_id, provider_reference, idempotency_key, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'paystack',$17,$18,$19,$20)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [s.commercialCurrency, s.commercialAmountMinor, s.cataloguePlan, s.interval,
        s.catalogueVersion, s.payment.paymentCurrency, s.payment.paymentAmountMinor,
        s.payment.paymentAmountExponent, s.fx.fxRateScaled, s.fx.fxRateScale,
        s.fx.fxRateVersionId, s.fx.fxRateEffectiveFrom, s.fx.fxRateCapturedAt,
        s.fx.fxRateSource, s.fx.roundingMode, s.pricingPolicyVersion,
        s.providerPlanId, s.providerReference, key, s.computedAt],
    );
    if (rows[0] !== undefined) return fromRow(rows[0]);
    // A separate statement sees a concurrently committed winner at READ COMMITTED.
    const existing = await this.findByIdempotencyKey(key);
    if (existing === null) {
      throw new BillingPricingError('invalid_snapshot', 'The persisted pricing decision could not be retrieved.');
    }
    return existing;
  }
}
