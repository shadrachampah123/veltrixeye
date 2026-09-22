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
}

export interface BillingState {
  subscription: SubscriptionDto;
  entitlements: Entitlements;
  /**
   * Display-only provider state for the row. It is NOT a payment confirmation
   * and it never widens an entitlement — `entitlements` above is the only
   * capability statement, resolved fail-closed by `resolveEntitlements()`.
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
 * pending. `paymentConfirmed` is a static `false`, never derived from
 * `provider_state`: an unverified provider value is not payment confirmation.
 */
function toProviderStatus(row: SubscriptionStateRow): BillingProviderStatusDto {
  return {
    provider: row.provider ?? null,
    providerState: row.provider_state ?? null,
    paymentConfirmed: false,
  };
}

export async function getBillingState(db: Pool, userId: string): Promise<BillingState> {
  const { rows } = await db.query<SubscriptionStateRow>(
    'SELECT * FROM subscriptions WHERE user_id = $1',
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
      entitlements: resolveEntitlements('free', 'active', null),
      providerStatus: noProviderStatus(),
    };
  }
  
  const row = rows[0]!;
  const sub = toSubscriptionDto(row);
  return {
    subscription: sub,
    // A provider-backed row (a checkout) resolves to the free tier until a
    // payment-confirmation authority exists; a historical row is unchanged.
    entitlements: resolveEntitlements(sub.plan, sub.status, row.provider),
    providerStatus: toProviderStatus(row),
  };
}

export async function createFreeSubscription(db: Pool, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}
