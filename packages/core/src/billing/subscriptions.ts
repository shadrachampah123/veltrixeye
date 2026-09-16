import { Pool } from 'pg';
import { type SubscriptionDto, type UserPlan } from '@veltrixeye/contracts';
import { getEntitlements, type Entitlements } from './entitlements.js';

export interface BillingState {
  subscription: SubscriptionDto;
  entitlements: Entitlements;
}

function toSubscriptionDto(row: any): SubscriptionDto {
  return {
    id: row.id,
    plan: row.plan as UserPlan,
    status: row.status,
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

export async function getBillingState(db: Pool, userId: string): Promise<BillingState> {
  const { rows } = await db.query(
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
      entitlements: getEntitlements('free', 'active'),
    };
  }
  
  const sub = toSubscriptionDto(rows[0]);
  return {
    subscription: sub,
    entitlements: getEntitlements(sub.plan, sub.status),
  };
}

export async function createFreeSubscription(db: Pool, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}
