import type { Pool } from 'pg';
import {
  type BillingProviderStatusDto,
  type SubscriptionDto,
  type UserPlan,
} from '@veltrixeye/contracts';
import type { Entitlements } from './entitlements.js';
import { resolveEntitlements } from './entitlement-resolution.js';

/** Columns the billing-state read needs beyond the 0014 subscription shape. */
interface SubscriptionStateRow {
  id: string;
  plan: string;
  status: string;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  provider: string | null;
  provider_state: string | null;
  /**
   * Whether a durable activation FACT exists for this row (Billing Step 8,
   * migration 0034). This is the only payment-confirmation authority in the
   * build; it is derived, never stored on the subscription and never accepted
   * from a client.
   */
  activated: boolean;
}

export interface BillingState {
  subscription: SubscriptionDto;
  entitlements: Entitlements;
  /**
   * Display-only provider state for the row. It is NOT a payment confirmation
   * by itself and it never widens an entitlement — `entitlements` above is the
   * only capability statement, resolved fail-closed by `resolveEntitlements()`.
   */
  providerStatus: BillingProviderStatusDto;
}

/** No subscription row at all: nothing was ever sold, so nothing is provider-backed. */
function noProviderStatus(): BillingProviderStatusDto {
  return { provider: null, providerState: null, paymentConfirmed: false };
}

function toSubscriptionDto(row: SubscriptionStateRow): SubscriptionDto {
  return {
    id: row.id,
    plan: row.plan as UserPlan,
    status: row.status as SubscriptionDto['status'],
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

/**
 * Publishes what the provider last reported so a pending checkout is visible as
 * pending, and whether an operator has authorized an activation for this row.
 *
 * `paymentConfirmed` is DERIVED from the existence of the durable activation
 * fact (`billing_subscription_activations`, migration 0034) — never from
 * `provider_state`, which is a non-authoritative provider value, and never
 * from client input. There is no `payment_confirmed` column: the fact table is
 * the single authority and this field is a read of it.
 */
function toProviderStatus(row: SubscriptionStateRow): BillingProviderStatusDto {
  return {
    provider: row.provider ?? null,
    providerState: row.provider_state ?? null,
    paymentConfirmed: row.activated === true,
  };
}

export async function getBillingState(db: Pool, userId: string): Promise<BillingState> {
  const { rows } = await db.query<SubscriptionStateRow>(
    `SELECT *,
            EXISTS (
              SELECT 1 FROM billing_subscription_activations a
               WHERE a.subscription_id = subscriptions.id
            ) AS activated
       FROM subscriptions WHERE user_id = $1`,
    [userId]
  );

  if (rows.length === 0) {
    // If no subscription row exists, treat as free
    const sub: SubscriptionDto = {
      id: '',
      plan: 'free',
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
    return {
      subscription: sub,
      // provider IS NULL: the historical, unchanged free resolution.
      entitlements: resolveEntitlements('free', 'active', null, false),
      providerStatus: noProviderStatus(),
    };
  }

  const row = rows[0]!;
  const sub = toSubscriptionDto(row);
  return {
    subscription: sub,
    // A provider-backed row resolves to the free tier until an immutable
    // activation fact exists (evidence alone is never authority); a historical
    // row is unchanged, and `users.plan` is never read or written here.
    entitlements: resolveEntitlements(sub.plan, sub.status, row.provider, row.activated === true),
    providerStatus: toProviderStatus(row),
  };
}

/**
 * Insert a `free`/`active` subscription row if the user has none.
 *
 * NOT PART OF THE MODEL C LIFECYCLE, and never called by registration
 * (`UserService.create`) or by the free fallback: since Model C a user without
 * a `subscriptions` row IS the free state (see `getBillingState` above), and the
 * only row the product creates is the commercial one written atomically by
 * `BillingCheckoutService.checkout()` together with its immutable pricing lock.
 * Kept exported because it is the honest way for tests/fixtures to materialise
 * the LEGACY shape — a pre-Model-C row with `locked_pricing_snapshot_id = NULL`
 * — which stays fail-closed (`pricing_lock_required`) and must never be
 * upgraded in place (migration 0032 makes the lock immutable). It grants
 * nothing: `provider` stays NULL, which is the historical, non-commercial row.
 */
export async function createFreeSubscription(db: Pool, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}
