import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  BILLING_PROVIDER,
  SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE,
  providerSubscriptionStateSchema,
  subscriptionStatusSchema,
  subscriptionSyncResultSchema,
  unappliedSyncResult,
  type BillingLifecycleState,
  type BillingSyncOutcome,
  type BillingSyncState,
  type ProviderSubscriptionState,
  type SubscriptionStatus,
  type SubscriptionSyncResult,
} from '@veltrixeye/contracts';
import { billingCheckoutReference } from './checkout.js';
import { billingSubscriptionVerifyRequestSchema, type BillingProviderRegistry } from './provider.js';
import {
  claimReceivedBillingProviderEvents,
  settleBillingProviderEvents,
  type ClaimedBillingProviderEvent,
  type SettledBillingProviderEventState,
} from './webhook.js';

/**
 * Later-billing-PR #7 — VERIFY + SYNCHRONIZE a provider-backed subscription.
 * SANDBOX ONLY.
 *
 * One call = one user's provider-backed subscription:
 *
 *   1. read the local row (no lock held across the network);
 *   2. derive OUR checkout reference from the locked pricing snapshot, through
 *      the SAME `billingCheckoutReference` checkout uses;
 *   3. ask the provider — through the canonical seam only — to VERIFY that
 *      reference (`verifySubscription`, one documented read);
 *   4. in ONE transaction: claim the `received` ledger rows bound to the
 *      subscription, apply the verified state through
 *      `SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE` (the ONLY path from provider
 *      state to `subscriptions.status`) guarded by `state_version` optimistic
 *      concurrency, write the synchronization bookkeeping, and settle the
 *      claimed ledger rows exactly once;
 *   5. return the canonical `SubscriptionSyncResult`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 * ---------------------------------------------------------------------------
 *  - It never writes `plan` (the entitlement identity), `catalogue_plan`,
 *    `billing_interval`, the price lock, periods or cancellation fields. The
 *    only columns it moves are `status` (via the canonical mapping, and only
 *    when a mapping exists), `provider_state` (the canonical lifecycle value),
 *    and the 0031 synchronization bookkeeping (`sync_state`, `sync_required`,
 *    `last_sync_source`, `last_synced_at`, `last_event_idempotency_key`,
 *    `state_version`).
 *  - It never widens an entitlement. A provider-backed row still resolves to
 *    the free tier through `resolveEntitlements` (the provider→FREE gate is
 *    unchanged), and the result pins `planChanged`, `entitlementsChanged` and
 *    `grantsExecution` to `false` at the type level.
 *  - It never applies an unmodelled state. `unknown`, `pending` (and any state
 *    the mapping sends to `null`) leave `status` exactly as it is and flag the
 *    row for manual review (`sync_state = 'conflict'`, `sync_required = true`).
 *  - It never infers cancellation, periods or a plan from a provider response,
 *    and it never persists a provider payload: only canonical values reach the
 *    database, and the verified observation itself is not stored.
 *  - It is not called by the webhook receiver. Receipt stays receipt-only; the
 *    receiver performs no verification and moves no state.
 *  - It performs no transport and reads no environment: the provider and the
 *    database are injected, and the provider is reached through the seam.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export const BILLING_SYNC_ERROR_REASONS = ['provider_not_registered', 'verification_unavailable'] as const;
export type BillingSubscriptionSyncErrorReason = (typeof BILLING_SYNC_ERROR_REASONS)[number];

/**
 * A synchronization that could not reach a verified provider view. Nothing was
 * written: the subscription row and the ledger are exactly as they were, so the
 * unsettled ledger rows remain `received` for a later attempt.
 */
export class BillingSubscriptionSyncError extends Error {
  readonly code = 'billing_sync_unavailable';

  constructor(
    readonly reason: BillingSubscriptionSyncErrorReason,
    options?: { cause?: unknown },
  ) {
    super(
      reason === 'provider_not_registered'
        ? 'Synchronization refused: no billing provider is registered. Nothing was changed.'
        : 'Synchronization refused: the provider verification did not produce a usable result. Nothing was changed.',
      options,
    );
    this.name = 'BillingSubscriptionSyncError';
  }
}

export function isBillingSubscriptionSyncError(error: unknown): error is BillingSubscriptionSyncError {
  return error instanceof BillingSubscriptionSyncError;
}

/* -------------------------------------------------------------------------- */
/* Fixed, credential-free reasons (≤ 200 characters, storable in 0031)        */
/* -------------------------------------------------------------------------- */

export const BILLING_SYNC_REASONS = Object.freeze({
  noProviderSubscription: 'no provider-backed subscription exists for this user; nothing to synchronize',
  noPricingLock:
    'the provider-backed subscription has no locked pricing snapshot, so no checkout reference can be verified',
  reviewRequired: 'the verified provider state maps to no subscription status; left unchanged for manual review',
  unprovisioned: 'the provider reports nothing provisioned yet; subscription status left unchanged',
  identityConflict: 'the verified provider view disagrees with the local billing identity; nothing was applied',
  staleVersion: 'the subscription changed while it was being verified (stale state_version); nothing was applied',
});

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export interface BillingSubscriptionSyncOptions {
  db: Pool;
  providers: BillingProviderRegistry;
  now?: () => Date;
}

interface SyncSubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  provider: string | null;
  provider_subscription_id: string | null;
  state_version: number;
  pricing_idempotency_key: string | null;
}

interface LocalCustomerRow {
  provider_customer_id: string | null;
  provider_customer_code: string | null;
}

/** The planned effect of one verified observation (decided before any write). */
interface SyncPlan {
  outcome: Extract<BillingSyncOutcome, 'updated' | 'unchanged' | 'ignored' | 'requires_manual_review' | 'conflict'>;
  toStatus: SubscriptionStatus | null;
  /** Canonical lifecycle value to persist, or null to leave `provider_state` untouched. */
  providerState: BillingLifecycleState | null;
  syncState: Exclude<BillingSyncState, 'never_synced'>;
  syncRequired: boolean;
  reason: string | null;
}

/** Deterministic idempotency key of one verification request (subscription, version). */
export function billingSyncVerificationKey(subscriptionId: string, stateVersion: number): string {
  return createHash('sha256')
    .update(JSON.stringify(['billing-sync-verify/v1', subscriptionId, stateVersion]))
    .digest('hex');
}

export class BillingSubscriptionSyncService {
  constructor(private readonly options: BillingSubscriptionSyncOptions) {}

  /**
   * Verify and synchronize the user's provider-backed subscription.
   *
   * Returns a canonical result for every decided outcome (including review and
   * conflict). Throws `BillingSubscriptionSyncError` — with nothing written —
   * when no provider is registered or the verification produced no usable
   * provider view.
   */
  async synchronize(userId: string): Promise<SubscriptionSyncResult> {
    const user = z.string().uuid().parse(userId);
    const provider = this.options.providers.get(BILLING_PROVIDER);
    if (provider === undefined) throw new BillingSubscriptionSyncError('provider_not_registered');

    const { db } = this.options;
    const row = await readSubscription(db, user);
    if (row === undefined || row.provider === null) {
      // Nothing provider-backed: no provider call, no write.
      return unappliedSyncResult({
        provider: BILLING_PROVIDER,
        userId: user,
        subscriptionId: null,
        outcome: 'ignored',
        reason: BILLING_SYNC_REASONS.noProviderSubscription,
        syncedAt: this.now().toISOString(),
        stateVersion: row?.state_version ?? 1,
      });
    }
    if (row.pricing_idempotency_key === null) {
      // A provider-backed row always carries a price lock (checkout writes it);
      // one without cannot be tied to a checkout reference. Review, no call.
      return unappliedSyncResult({
        provider: BILLING_PROVIDER,
        userId: user,
        subscriptionId: row.id,
        outcome: 'requires_manual_review',
        reason: BILLING_SYNC_REASONS.noPricingLock,
        syncedAt: this.now().toISOString(),
        stateVersion: row.state_version,
      });
    }

    const reference = billingCheckoutReference(row.user_id, row.pricing_idempotency_key);
    const request = billingSubscriptionVerifyRequestSchema.parse({
      provider: BILLING_PROVIDER,
      userId: user,
      providerReference: reference,
      idempotencyKey: billingSyncVerificationKey(row.id, row.state_version),
      requestedAt: this.now().toISOString(),
    });

    // ONE provider read, outside any transaction. Any failure — transport,
    // provider refusal, reference/domain conflict, malformed response — is an
    // unknown outcome: nothing is written and the ledger rows stay `received`.
    let observed: ProviderSubscriptionState;
    try {
      observed = providerSubscriptionStateSchema.parse(await provider.verifySubscription(request));
    } catch (error) {
      throw new BillingSubscriptionSyncError('verification_unavailable', { cause: error });
    }

    const customer = await readLocalCustomer(db, user);
    const fromStatus = subscriptionStatusSchema.parse(row.status);
    const plan = planSync(fromStatus, observed, { reference, row, customer });
    return this.apply(row, fromStatus, plan);
  }

  private async apply(
    row: SyncSubscriptionRow,
    fromStatus: SubscriptionStatus,
    plan: SyncPlan,
  ): Promise<SubscriptionSyncResult> {
    const syncedAt = this.now().toISOString();
    const client = await this.options.db.connect();
    try {
      await client.query('BEGIN');
      const claimed = await claimReceivedBillingProviderEvents(client, {
        subscriptionId: row.id,
        userId: row.user_id,
      });
      const settlement = settlementFor(plan, claimed);
      const lastAppliedKey = settlement.processed.at(-1)?.idempotencyKey ?? null;

      // Optimistic concurrency: the write lands only on the version that was
      // verified. `plan` and every commercial column are absent from SET.
      const updated = await client.query<{ state_version: number }>(
        `UPDATE subscriptions
            SET status = COALESCE($3, status),
                provider_state = COALESCE($4, provider_state),
                sync_state = $5,
                sync_required = $6,
                last_sync_source = 'verification',
                last_synced_at = $7,
                last_event_idempotency_key = COALESCE($8, last_event_idempotency_key),
                state_version = state_version + 1
          WHERE id = $1 AND state_version = $2 AND provider = $9
          RETURNING state_version`,
        [
          row.id,
          row.state_version,
          plan.outcome === 'updated' ? plan.toStatus : null,
          plan.providerState,
          plan.syncState,
          plan.syncRequired,
          syncedAt,
          lastAppliedKey,
          BILLING_PROVIDER,
        ],
      );
      const written = updated.rows[0];
      if (written === undefined) {
        // A newer writer won. Nothing of ours lands; the claimed rows are
        // released untouched by the rollback.
        await client.query('ROLLBACK');
        const current = await readSubscription(this.options.db, row.user_id);
        return unappliedSyncResult({
          provider: BILLING_PROVIDER,
          userId: row.user_id,
          subscriptionId: row.id,
          outcome: 'conflict',
          reason: BILLING_SYNC_REASONS.staleVersion,
          syncedAt,
          stateVersion: current?.state_version ?? row.state_version,
        });
      }

      await settle(client, settlement.processed, 'processed', syncedAt, null);
      await settle(client, settlement.ignored, 'ignored', syncedAt, plan.reason);
      await settle(client, settlement.failed, 'failed', syncedAt, plan.reason);
      await client.query('COMMIT');

      return subscriptionSyncResultSchema.parse({
        provider: BILLING_PROVIDER,
        userId: row.user_id,
        subscriptionId: row.id,
        outcome: plan.outcome,
        fromStatus,
        toStatus: plan.toStatus,
        providerState: plan.providerState,
        appliedEventIdempotencyKeys: settlement.processed.map((event) => event.idempotencyKey),
        requiresManualReview: plan.outcome === 'requires_manual_review' || plan.outcome === 'conflict',
        reason: plan.reason,
        syncedAt,
        stateVersion: written.state_version,
        planChanged: false,
        entitlementsChanged: false,
        grantsExecution: false,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}

/* -------------------------------------------------------------------------- */
/* Pure decision                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Decide the effect of a verified observation. Pure: no I/O. Identity is
 * checked first — a verified view that disagrees with the local billing
 * identity applies NOTHING (not even `provider_state`).
 */
export function planSync(
  fromStatus: SubscriptionStatus,
  observed: ProviderSubscriptionState,
  local: {
    reference: string;
    row: { provider_subscription_id: string | null };
    customer: LocalCustomerRow | null;
  },
): SyncPlan {
  const disagrees = (remote: string | null, mine: string | null | undefined): boolean =>
    remote !== null && mine !== null && mine !== undefined && remote !== mine;
  if (
    observed.provider !== BILLING_PROVIDER ||
    disagrees(observed.providerReference, local.reference) ||
    disagrees(observed.providerSubscriptionId, local.row.provider_subscription_id) ||
    disagrees(observed.providerCustomerCode, local.customer?.provider_customer_code) ||
    disagrees(observed.providerCustomerId, local.customer?.provider_customer_id)
  ) {
    return {
      outcome: 'conflict',
      toStatus: null,
      providerState: null,
      syncState: 'conflict',
      syncRequired: true,
      reason: BILLING_SYNC_REASONS.identityConflict,
    };
  }

  // The ONLY path from provider state to authoritative status.
  const target = SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE[observed.state];
  if (target === null) {
    if (observed.state === 'unprovisioned') {
      return {
        outcome: 'ignored',
        toStatus: null,
        providerState: observed.state,
        syncState: 'pending',
        syncRequired: false,
        reason: BILLING_SYNC_REASONS.unprovisioned,
      };
    }
    return {
      outcome: 'requires_manual_review',
      toStatus: null,
      providerState: observed.state,
      syncState: 'conflict',
      syncRequired: true,
      reason: BILLING_SYNC_REASONS.reviewRequired,
    };
  }
  return {
    outcome: target === fromStatus ? 'unchanged' : 'updated',
    toStatus: target,
    providerState: observed.state,
    syncState: 'synced',
    syncRequired: false,
    reason: null,
  };
}

/** Which claimed ledger rows move where, for one plan. */
function settlementFor(
  plan: SyncPlan,
  claimed: readonly ClaimedBillingProviderEvent[],
): Record<SettledBillingProviderEventState, ClaimedBillingProviderEvent[]> {
  const none: ClaimedBillingProviderEvent[] = [];
  switch (plan.outcome) {
    case 'updated':
    case 'unchanged':
      return {
        processed: claimed.filter((event) => event.eventType !== 'unrecognized'),
        ignored: claimed.filter((event) => event.eventType === 'unrecognized'),
        failed: none,
      };
    case 'conflict':
      return { processed: none, ignored: none, failed: [...claimed] };
    case 'ignored':
    case 'requires_manual_review':
      return { processed: none, ignored: [...claimed], failed: none };
  }
}

/* -------------------------------------------------------------------------- */
/* Local reads                                                                */
/* -------------------------------------------------------------------------- */

async function readSubscription(db: Pool, userId: string): Promise<SyncSubscriptionRow | undefined> {
  const { rows } = await db.query<SyncSubscriptionRow>(
    `SELECT s.id, s.user_id, s.status, s.provider, s.provider_subscription_id, s.state_version,
            p.idempotency_key AS pricing_idempotency_key
       FROM subscriptions s
       LEFT JOIN billing_pricing_snapshots p ON p.id = s.locked_pricing_snapshot_id
      WHERE s.user_id = $1`,
    [userId],
  );
  return rows[0];
}

async function readLocalCustomer(db: Pool, userId: string): Promise<LocalCustomerRow | null> {
  const { rows } = await db.query<LocalCustomerRow>(
    `SELECT provider_customer_id, provider_customer_code
       FROM billing_customers
      WHERE provider = $1 AND user_id = $2`,
    [BILLING_PROVIDER, userId],
  );
  return rows[0] ?? null;
}

async function settle(
  client: PoolClient,
  events: readonly ClaimedBillingProviderEvent[],
  state: SettledBillingProviderEventState,
  processedAt: string,
  failureReason: string | null,
): Promise<void> {
  await settleBillingProviderEvents(client, {
    ids: events.map((event) => event.id),
    state,
    processedAt,
    failureReason,
  });
}
