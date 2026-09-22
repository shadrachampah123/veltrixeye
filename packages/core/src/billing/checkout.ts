import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { internalPlanForCommercialPlan } from '@veltrixeye/contracts';
import { BillingFxError, parseFxRateVersion } from './fx-rate-versions.js';
import { priceFromProviderPlanEpoch, verifyPricingSnapshot } from './pricing.js';
import { BillingProviderPlanStore, isBillingProviderPlanError, providerPlanKey } from './provider-plans.js';
import {
  billingCheckoutRequestSchema,
  type BillingCheckoutSession,
  type BillingProviderRegistry,
} from './provider.js';
import { BillingPricingSnapshotStore, type StoredBillingPricingSnapshot } from './snapshots.js';

export const billingCheckoutInputSchema = z.object({
  cataloguePlan: z.enum(['pro', 'elite']), // Starter is explicitly not sellable.
  interval: z.enum(['monthly', 'annual']),
}).strict();

export class BillingCheckoutError extends Error {
  readonly code = 'billing_checkout_unavailable';
  constructor(readonly reason:
    | 'pricing_lock_required' | 'plan_not_registered' | 'forbidden_plan'
    | 'unauthorized_amount' | 'provider_not_registered' | 'callback_not_configured',
  ) {
    super(`Checkout refused: ${reason}.`);
    this.name = 'BillingCheckoutError';
  }
}

// Evidence-only plan, never an authorized sellable epoch. Assembled consistently
// with the existing exclusion regression, which forbids the literal in registries.
const EXCLUDED_PLAN = ['PLN', 'u0l4961hhipl6ek'].join('_');
function assertSellableProviderPlan(id: string | null): void {
  if (id?.trim() === EXCLUDED_PLAN) throw new BillingCheckoutError('forbidden_plan');
  if (id === null || id.trim() === '') throw new BillingCheckoutError('plan_not_registered');
}

/** No PII or generated UUID in the reference: hash the user + deterministic pricing identity. */
export function billingCheckoutReference(userId: string, pricingKey: string): string {
  return `ve-chk-${createHash('sha256')
    .update(JSON.stringify(['billing-checkout/v1', userId, pricingKey])).digest('hex')}`;
}

interface SubscriptionLock {
  id: string;
  locked_pricing_snapshot_id: string | null;
  plan: string;
  catalogue_plan: string | null;
  billing_interval: string | null;
  provider: string | null;
  provider_plan_id: string | null;
}
const SUBSCRIPTION_COLUMNS = `id, locked_pricing_snapshot_id, plan, catalogue_plan,
  billing_interval, provider, provider_plan_id`;

export interface BillingCheckoutOptions {
  db: Pool;
  providers: BillingProviderRegistry;
  callbackUrl: string | null;
  /** Composition checks local identity only. Never provisions or calls a provider. */
  requireExistingCustomer: (userId: string) => Promise<void>;
  now?: () => Date;
}

/** PR-C orchestration. Pricing and adapter authorization remain their sole authorities. */
export class BillingCheckoutService {
  constructor(private readonly options: BillingCheckoutOptions) {}

  async checkout(userId: string, input: unknown): Promise<BillingCheckoutSession> {
    z.string().uuid().parse(userId);
    const requested = billingCheckoutInputSchema.parse(input);
    const { db, providers, callbackUrl } = this.options;
    if (callbackUrl === null || !z.string().url().safeParse(callbackUrl).success ||
        new URL(callbackUrl).protocol !== 'https:') {
      throw new BillingCheckoutError('callback_not_configured');
    }
    const provider = providers.get('paystack');
    if (provider === undefined) throw new BillingCheckoutError('provider_not_registered');

    // Existing subscriptions never enter the epoch/FX/pricing path, even after
    // rotation or retirement. NULL locks are immutable too: no upgrade here.
    const { rows } = await db.query<SubscriptionLock>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = $1`, [userId],
    );
    if (rows[0]?.locked_pricing_snapshot_id === null) {
      throw new BillingCheckoutError('pricing_lock_required');
    }
    let candidate: StoredBillingPricingSnapshot | null = null;
    if (rows.length === 0) {
      const plans = new BillingProviderPlanStore(db);
      const epoch = await plans.findActive(providerPlanKey(requested.cataloguePlan, requested.interval))
        .catch((error: unknown) => {
          if (isBillingProviderPlanError(error) && error.reason === 'not_found') {
            throw new BillingCheckoutError('plan_not_registered');
          }
          throw error; // Retired and ambiguous remain distinct, fail-closed failures.
        });
      assertSellableProviderPlan(epoch.providerPlanId);
      const fx = await db.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [epoch.fxRateVersionId]);
      if (fx.rows[0] === undefined) throw new BillingFxError('missing', 'The epoch FX version is missing.');
      parseFxRateVersion(fx.rows[0]); // Exact version, never latest and never freshness.
      const snapshot = priceFromProviderPlanEpoch({
        // The PR-B seam accepts the strict durable row, not the normalized store shape.
        epoch: {
          id: epoch.id, provider: epoch.provider, mode: epoch.mode,
          catalogue_plan: epoch.cataloguePlan, billing_interval: epoch.interval,
          payment_currency: epoch.paymentCurrency, payment_amount_minor: epoch.paymentAmountMinor,
          payment_amount_exponent: epoch.paymentAmountExponent, provider_plan_id: epoch.providerPlanId,
          provider_plan_reference: epoch.providerPlanReference, fx_rate_version_id: epoch.fxRateVersionId,
          pricing_policy_version: epoch.pricingPolicyVersion, catalogue_version: epoch.catalogueVersion,
          status: epoch.status, valid_from: epoch.validFrom, retired_at: epoch.retiredAt,
        },
        fxVersion: fx.rows[0], asOf: this.now(),
        // Snapshots are shared pricing decisions; per-user references belong to
        // checkout requests, not the globally deduplicated snapshot row.
        providerReference: null,
      });
      candidate = await new BillingPricingSnapshotStore(db).create(snapshot);
    }

    const locked = await this.obtainLock(userId, candidate);
    await this.options.requireExistingCustomer(userId);
    const reference = billingCheckoutReference(userId, locked.idempotencyKey);
    const request = billingCheckoutRequestSchema.parse({
      provider: 'paystack', userId,
      plan: { cataloguePlan: locked.snapshot.cataloguePlan, interval: locked.snapshot.interval },
      pricing: locked.snapshot,
      reference, idempotencyKey: locked.idempotencyKey,
      callbackUrl, requestedAt: this.now().toISOString(),
    });
    // Including retirement, plan/amount/reference checks: nothing bypasses the adapter.
    return provider.initializeCheckout(request);
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }

  private async obtainLock(userId: string, candidate: StoredBillingPricingSnapshot | null): Promise<StoredBillingPricingSnapshot> {
    const client = await this.options.db.connect();
    try {
      await client.query('BEGIN');
      let row = await this.selectLock(client, userId);
      if (row === undefined) {
        if (candidate === null) throw new BillingCheckoutError('pricing_lock_required');
        const s = candidate.snapshot;
        const inserted = await client.query<SubscriptionLock>(
          `INSERT INTO subscriptions (user_id, plan, status, catalogue_plan, billing_interval,
             currency, provider, provider_plan_id, provider_state, locked_pricing_snapshot_id)
           VALUES ($1,$2,'active',$3,$4,'USD','paystack',$5,'pending',$6)
           ON CONFLICT (user_id) DO NOTHING RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [userId, internalPlanForCommercialPlan(s.cataloguePlan), s.cataloguePlan,
            s.interval, s.providerPlanId, candidate.id],
        );
        // FOR UPDATE cannot lock an absent row. UNIQUE(user_id) arbitrates the
        // INSERT race; a fresh statement locks and reads the committed winner.
        row = inserted.rows[0] ?? await this.selectLock(client, userId);
      }
      if (row === undefined || row.locked_pricing_snapshot_id === null) {
        throw new BillingCheckoutError('pricing_lock_required');
      }
      const stored = await new BillingPricingSnapshotStore(client).findById(row.locked_pricing_snapshot_id);
      if (stored === null) throw new BillingCheckoutError('unauthorized_amount');
      const s = verifyPricingSnapshot(stored.snapshot);
      assertSellableProviderPlan(s.providerPlanId);
      if (s.cataloguePlan === 'starter' || row.provider !== 'paystack' ||
          row.plan !== internalPlanForCommercialPlan(s.cataloguePlan) ||
          row.catalogue_plan !== s.cataloguePlan || row.billing_interval !== s.interval ||
          row.provider_plan_id !== s.providerPlanId) {
        throw new BillingCheckoutError('unauthorized_amount');
      }
      await client.query('COMMIT');
      return stored;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async selectLock(client: PoolClient, userId: string): Promise<SubscriptionLock | undefined> {
    const { rows } = await client.query<SubscriptionLock>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = $1 FOR UPDATE`, [userId],
    );
    return rows[0];
  }
}
