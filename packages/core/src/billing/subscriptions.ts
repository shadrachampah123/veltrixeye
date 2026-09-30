import type { Pool } from 'pg';
import {
  type BillingEntitlementGrantDisclosure,
  type BillingProviderMode,
  type BillingProviderStatusDto,
  type SubscriptionDto,
  type UserPlan,
} from '@veltrixeye/contracts';
import type { Entitlements } from './entitlements.js';
import { resolveEntitlements } from './entitlement-resolution.js';
import { grantableEntitlementPlan } from './entitlement-grants.js';

/** Columns the billing-state read needs beyond the 0014 subscription shape. */
interface SubscriptionStateRow {
  /**
   * `null` when the account has NO subscription row — the Model C free state.
   * The read is anchored on `users` (LEFT JOIN) precisely so such an account
   * still resolves its non-commercial operator grant.
   */
  id: string | null;
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
  /**
   * The tier named by a non-commercial operator grant for this ACCOUNT
   * (migration 0036), or `null`. It is an account-level authority, not a fact
   * about a row — a granted account characteristically has no row at all, which
   * is why the read is anchored on `users`.
   */
  granted_plan: string | null;
}

export interface BillingState {
  /**
   * The configured provider mode this state is reported in (`test`, the
   * default, or `live`) — the display-only field of the billing-state DTO.
   * Composition/routes pass the configured mode; direct callers get `test`.
   */
  mode: BillingProviderMode;
  subscription: SubscriptionDto;
  entitlements: Entitlements;
  /**
   * Display-only provider state for the row. It is NOT a payment confirmation
   * by itself and it never widens an entitlement — `entitlements` above is the
   * only capability statement, resolved fail-closed by `resolveEntitlements()`.
   */
  providerStatus: BillingProviderStatusDto;
  /**
   * The non-commercial operator grant in force for this account, or `null`.
   *
   * This is DISCLOSURE, never authority and never a payment: it exists so the
   * account can be told WHY its limits are what they are, when nothing was ever
   * sold. `providerStatus.paymentConfirmed` stays `false` for a granted account
   * — permanently — because it is derived from the activation fact alone and no
   * money changed hands. It carries no operator identity and no reason.
   */
  entitlementGrant: BillingEntitlementGrantDisclosure | null;
}

/** No subscription row at all: nothing was ever sold, so nothing is provider-backed. */
function noProviderStatus(): BillingProviderStatusDto {
  return { provider: null, providerState: null, paymentConfirmed: false };
}

function toSubscriptionDto(row: SubscriptionStateRow & { id: string }): SubscriptionDto {
  return {
    id: row.id,
    plan: row.plan as UserPlan,
    status: row.status as SubscriptionDto['status'],
    currentPeriodEnd: row.current_period_end ? row.current_period_end.toISOString() : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

/**
 * The minimal projection of a grant: WHICH tier it confers, and nothing else.
 *
 * Deliberately NOT published: the operator identity, the reason, the row id, the
 * idempotency key and the instant. This is the same disclosure discipline the
 * read-only billing overview already applies — an account learns the fact of its
 * own entitlement, never who decided it or why, and never anything
 * payment-shaped.
 */
function toEntitlementGrant(row: SubscriptionStateRow): BillingEntitlementGrantDisclosure | null {
  // Narrowed with the SAME authority the grant service validates and writes
  // with (`grantableEntitlementPlan`), never with a second copy of the tier
  // list: a value the resolver would honour can never be silently undeclared
  // here, so a granted account is always disclosed.
  if (row.granted_plan === null) return null;
  const plan = grantableEntitlementPlan(row.granted_plan);
  return plan === null ? null : { plan };
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

export async function getBillingState(
  db: Pool,
  userId: string,
  options?: { mode?: BillingProviderMode },
): Promise<BillingState> {
  const mode = options?.mode ?? 'test';
  const { rows } = await db.query<SubscriptionStateRow>(
    `SELECT sub.*,
            EXISTS (
              SELECT 1 FROM billing_subscription_activations a
               WHERE a.subscription_id = sub.id
            ) AS activated,
            (
              SELECT g.plan FROM billing_entitlement_grants g
               WHERE g.user_id = u.id
            ) AS granted_plan
       FROM users u
       LEFT JOIN subscriptions sub ON sub.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );

  // Anchored on `users` with a LEFT JOIN so a granted account — which by
  // definition has no `subscriptions` row — still yields one row carrying its
  // grant. A row-less account comes back with every `sub.*` column NULL, which
  // is exactly the Model C free state.
  const row = rows[0];
  if (row === undefined || row.id === null) {
    // If no subscription row exists, treat as free
    const sub: SubscriptionDto = {
      id: '',
      plan: 'free',
      status: 'active',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
    return {
      mode,
      subscription: sub,
      // provider IS NULL: the historical, unchanged free resolution — except
      // that a non-commercial operator grant is an ACCOUNT-level authority and
      // is honoured even with no row.
      entitlements: resolveEntitlements(
        'free',
        'active',
        null,
        false,
        (row?.granted_plan ?? null) as UserPlan | null,
      ),
      providerStatus: noProviderStatus(),
      entitlementGrant: row === undefined ? null : toEntitlementGrant(row),
    };
  }

  // Narrowed above: `row.id` is non-null on this path, so the DTO is the real
  // row (and not the documented `''` placeholder of the free state).
  const sub = toSubscriptionDto({ ...row, id: row.id! });
  return {
    mode,
    subscription: sub,
    // A provider-backed row resolves to the free tier until an immutable
    // activation fact exists (evidence alone is never authority); a historical
    // row is unchanged, and `users.plan` is never read or written here. A
    // non-commercial operator grant (migration 0036) is a separate,
    // account-level authority and is read here as well.
    entitlements: resolveEntitlements(
      sub.plan,
      sub.status,
      row.provider,
      row.activated === true,
      row.granted_plan as UserPlan | null,
    ),
    providerStatus: toProviderStatus(row),
    entitlementGrant: toEntitlementGrant(row),
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
