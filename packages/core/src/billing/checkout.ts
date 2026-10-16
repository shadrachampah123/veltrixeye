import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  internalPlanForCommercialPlan,
  type BillingPricingSnapshot,
  type BillingProviderMode,
} from '@veltrixeye/contracts';
import { BillingFxError, parseFxRateVersion } from './fx-rate-versions.js';
import { priceFromProviderPlanEpoch, verifyPricingSnapshot } from './pricing.js';
import {
  BillingProviderPlanError,
  BillingProviderPlanStore,
  assertProviderPlanMatches,
  isBillingProviderPlanError,
  parseProviderPlan,
  providerPlanExpectationFromSnapshot,
  providerPlanKey,
} from './provider-plans.js';
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
    // The pricing DECISION for a row-less user is derived here (epoch + FX
    // reads only) but is deliberately NOT persisted here: the snapshot row is
    // written inside the subscription/lock transaction, on the same client, so
    // the snapshot, the sold subscription and the immutable pricing lock are
    // one atomic unit of work.
    let candidate: BillingPricingSnapshot | null = null;
    // The epoch the candidate was priced from. The active-epoch lookup in
    // this branch is NOT the sale's authorization by itself: the epoch can be
    // retired after this lookup and before the pricing lock commits, so
    // `obtainLock` re-validates THIS epoch, by id, inside the lock
    // transaction (below).
    let candidateEpoch: { id: string; mode: BillingProviderMode } | null = null;
    if (rows.length === 0) {
      // The configured provider domain travels with the REGISTERED adapter
      // (composition injects it): the store, the directory key and the epoch
      // parse below all resolve in that domain, so a live deployment can
      // never select a test epoch and a test deployment never selects a live
      // one. No default is consulted here — `provider.mode` is explicit.
      const plans = new BillingProviderPlanStore(db, undefined, provider.mode);
      const epoch = await plans.findActive(
        providerPlanKey(requested.cataloguePlan, requested.interval, { mode: provider.mode }),
      )
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
        mode: provider.mode,
      });
      // Pure decision, no write: `obtainLock` persists it inside the
      // subscription/lock transaction it belongs to.
      candidate = snapshot;
      candidateEpoch = { id: epoch.id, mode: provider.mode };
    }

    const locked = await this.obtainLock(userId, candidate, candidateEpoch);
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

  /**
   * Create the sold subscription and its immutable pricing lock — atomically
   * with the pricing snapshot the lock points at.
   *
   * `candidate` is the pricing DECISION for a row-less user: already derived,
   * not yet persisted. Its snapshot row is INSERTed here, inside this
   * transaction and on this transaction's client, immediately before the
   * subscription row that locks it. Snapshot, sold subscription and lock are
   * therefore committed together or discarded together — a failure after the
   * snapshot INSERT leaves no snapshot, no subscription and no lock behind.
   */
  private async obtainLock(
    userId: string,
    candidate: BillingPricingSnapshot | null,
    candidateEpoch: { id: string; mode: BillingProviderMode } | null,
  ): Promise<StoredBillingPricingSnapshot> {
    const client = await this.options.db.connect();
    try {
      await client.query('BEGIN');
      let row = await this.selectLock(client, userId);
      if (row === undefined) {
        if (candidate === null || candidateEpoch === null) {
          throw new BillingCheckoutError('pricing_lock_required');
        }
        // EPOCH RETIREMENT RACE (the deliberate fix for the follow-up recorded
        // in docs/billing.md): the epoch was read as active OUTSIDE this
        // transaction, so it may have been retired since. Re-read THAT epoch,
        // by id, on this transaction's client and under FOR SHARE — which
        // serializes against the retirement UPDATE: either the retirement
        // committed first and this re-read sees `retired` and refuses, or
        // this lock commits first and the retirement waits, so the sale was
        // authorized by an epoch that was active at its lock instant. The
        // re-read epoch must still match the candidate snapshot EXACTLY;
        // nothing is repriced, no replacement epoch is selected and no
        // snapshot, subscription or lock survives a refusal (the transaction
        // rolls back). Existing locked rows never enter this path: retirement
        // after a sale does not rewrite or re-validate that sale's lock.
        await this.assertCandidateEpochStillActive(client, candidateEpoch, candidate);
        // ATOMICITY SEAM: the snapshot INSERT rides this client/transaction.
        // The subscription INSERT needs the snapshot id (the lock is a FK and
        // migration 0032 makes it immutable at creation), so the snapshot is
        // written first and the pair is protected by a savepoint: if this
        // attempt loses the UNIQUE(user_id) race, or any later validation in
        // this transaction refuses, the candidate snapshot goes with it.
        await client.query('SAVEPOINT billing_pricing_snapshot');
        const persisted = await new BillingPricingSnapshotStore(client).create(candidate);
        const s = persisted.snapshot;
        const inserted = await client.query<SubscriptionLock>(
          `INSERT INTO subscriptions (user_id, plan, status, catalogue_plan, billing_interval,
             currency, provider, provider_plan_id, provider_state, locked_pricing_snapshot_id)
           VALUES ($1,$2,'active',$3,$4,'USD','paystack',$5,'pending',$6)
           ON CONFLICT (user_id) DO NOTHING RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [userId, internalPlanForCommercialPlan(s.cataloguePlan), s.cataloguePlan,
            s.interval, s.providerPlanId, persisted.id],
        );
        // FOR UPDATE cannot lock an absent row. UNIQUE(user_id) arbitrates the
        // INSERT race; a fresh statement locks and reads the committed winner.
        row = inserted.rows[0];
        if (row === undefined) {
          // Another checkout created the row: discard this attempt's candidate
          // snapshot (it must never survive as an unlinked append-only row) and
          // re-read the winner's committed lock.
          await client.query('ROLLBACK TO SAVEPOINT billing_pricing_snapshot');
          row = await this.selectLock(client, userId);
        }
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

  /**
   * Re-validate, inside the lock transaction, the epoch a row-less candidate
   * was priced from. The row is locked `FOR SHARE` on the transaction's own
   * client, parsed through the canonical epoch contract in the configured
   * provider domain, required to still be `active`, and required to match the
   * candidate snapshot exactly (plan, interval, currency, amount, provider
   * plan, FX version and pricing policy — the same comparison the adapter
   * performs before a charge). Any divergence fails closed; the caller's
   * rollback discards the whole sale.
   */
  private async assertCandidateEpochStillActive(
    client: PoolClient,
    candidateEpoch: { id: string; mode: BillingProviderMode },
    candidate: BillingPricingSnapshot,
  ): Promise<void> {
    const { rows } = await client.query(
      `SELECT id, provider, mode, catalogue_plan, billing_interval, payment_currency,
              payment_amount_minor, payment_amount_exponent, provider_plan_id,
              provider_plan_reference, fx_rate_version_id, pricing_policy_version,
              catalogue_version, status, valid_from, retired_at, retired_reason
         FROM billing_provider_plans
        WHERE id = $1 FOR SHARE`,
      [candidateEpoch.id],
    );
    if (rows[0] === undefined) throw new BillingCheckoutError('plan_not_registered');
    const epoch = parseProviderPlan(rows[0], { allowedMode: candidateEpoch.mode });
    if (epoch.status !== 'active') {
      throw new BillingProviderPlanError(
        'retired',
        `Provider-plan epoch ${epoch.id} was retired after it was selected for this checkout. ` +
          'A retired epoch is history and is never used for a new charge.',
      );
    }
    if (candidate.providerPlanId === null) throw new BillingCheckoutError('unauthorized_amount');
    assertProviderPlanMatches(
      epoch,
      providerPlanExpectationFromSnapshot(candidate, candidate.providerPlanId, { mode: candidateEpoch.mode }),
    );
  }

  private async selectLock(client: PoolClient, userId: string): Promise<SubscriptionLock | undefined> {
    const { rows } = await client.query<SubscriptionLock>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = $1 FOR UPDATE`, [userId],
    );
    return rows[0];
  }
}
