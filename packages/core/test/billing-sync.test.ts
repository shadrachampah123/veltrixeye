import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  BILLING_LIFECYCLE_STATES,
  SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE,
  providerStateRequiresReview,
  type ProviderSubscriptionState,
  type SubscriptionStatus,
} from '@veltrixeye/contracts';
import {
  BILLING_SYNC_REASONS,
  BillingSubscriptionSyncError,
  billingSyncVerificationKey,
  isBillingSubscriptionSyncError,
  planSync,
} from '../src/index.js';

/* ==========================================================================
   Later-billing-PR #7 — the pure synchronization decision and the source
   boundaries (no database; see billing-sync-db.test.ts for the real writes).
   ========================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'billing', 'sync.ts'), 'utf8');
const WEBHOOK_SOURCE = readFileSync(path.join(HERE, '..', 'src', 'billing', 'webhook.ts'), 'utf8');
const REFERENCE = `ve-chk-${'0'.repeat(64)}`;
/** Source with block and line comments removed (doc comments may name forbidden symbols). */
const codeOnly = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SYNC_CODE = codeOnly(SYNC_SOURCE);

const observed = (overrides: Partial<ProviderSubscriptionState> = {}): ProviderSubscriptionState => ({
  provider: 'paystack',
  state: 'unknown',
  providerSubscriptionId: null,
  providerSubscriptionCode: null,
  providerCustomerId: null,
  providerCustomerCode: null,
  providerPlanId: null,
  providerReference: REFERENCE,
  cataloguePlan: null,
  interval: null,
  currency: null,
  payment: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  cancelledAt: null,
  cancellationReason: null,
  sourceEventIdempotencyKey: null,
  observedAt: '2027-06-01T00:00:00.000Z',
  ...overrides,
});

const local = (customer: { provider_customer_id: string | null; provider_customer_code: string | null } | null = null, providerSubscriptionId: string | null = null) => ({
  reference: REFERENCE,
  row: { provider_subscription_id: providerSubscriptionId },
  customer,
});

const FROM: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due', 'canceled', 'expired'];

describe('PR #7 — planSync applies state ONLY through the canonical mapping', () => {
  for (const state of BILLING_LIFECYCLE_STATES) {
    for (const from of FROM) {
      it(`${from} + verified ${state}`, () => {
        const plan = planSync(from, observed({ state }), local());
        const target = SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE[state];
        if (target === null) {
          assert.equal(plan.toStatus, null, 'a null mapping never moves status');
          assert.equal(plan.providerState, state);
          if (state === 'unprovisioned') {
            assert.equal(plan.outcome, 'ignored');
            assert.equal(plan.syncRequired, false);
          } else {
            assert.ok(providerStateRequiresReview(state));
            assert.equal(plan.outcome, 'requires_manual_review', 'null → manual review');
            assert.equal(plan.syncState, 'conflict');
            assert.equal(plan.syncRequired, true);
            assert.equal(plan.reason, BILLING_SYNC_REASONS.reviewRequired);
          }
        } else {
          assert.equal(plan.toStatus, target);
          assert.equal(plan.outcome, target === from ? 'unchanged' : 'updated');
          assert.equal(plan.syncState, 'synced');
          assert.equal(plan.syncRequired, false);
          assert.equal(plan.reason, null);
        }
      });
    }
  }

  it('cancellation-shaped fields never move status on their own', () => {
    const plan = planSync('active', observed({
      state: 'unknown', cancelAtPeriodEnd: true, cancelledAt: '2027-05-01T00:00:00.000Z', cancellationReason: 'user',
    }), local());
    assert.equal(plan.outcome, 'requires_manual_review');
    assert.equal(plan.toStatus, null);
  });
});

describe('PR #7 — identity disagreement applies nothing', () => {
  const customer = { provider_customer_id: '42', provider_customer_code: 'CUS_mine' };
  const cases: Array<[string, Partial<ProviderSubscriptionState>, ReturnType<typeof local>]> = [
    ['different reference', { state: 'active', providerReference: 've-chk-other' }, local(customer)],
    ['different customer code', { state: 'active', providerCustomerCode: 'CUS_theirs' }, local(customer)],
    ['different customer id', { state: 'active', providerCustomerId: '43' }, local(customer)],
    ['different subscription id', { state: 'active', providerSubscriptionId: 'SUB_theirs' }, local(customer, 'SUB_mine')],
  ];
  for (const [label, overrides, context] of cases) {
    it(label, () => {
      const plan = planSync('active', observed(overrides), context);
      assert.equal(plan.outcome, 'conflict');
      assert.equal(plan.toStatus, null);
      assert.equal(plan.providerState, null, 'an untrusted observation is not recorded');
      assert.equal(plan.syncRequired, true);
      assert.equal(plan.reason, BILLING_SYNC_REASONS.identityConflict);
    });
  }

  it('absent identifiers on either side are not a disagreement', () => {
    assert.equal(planSync('active', observed({ state: 'active', providerReference: null }), local()).outcome, 'unchanged');
    assert.equal(
      planSync('active', observed({ state: 'active', providerCustomerCode: 'CUS_x' }), local(null)).outcome,
      'unchanged',
    );
    assert.equal(
      planSync('active', observed({ state: 'active', providerCustomerCode: 'CUS_mine', providerCustomerId: '42' }),
        local({ provider_customer_id: '42', provider_customer_code: 'CUS_mine' })).outcome,
      'unchanged',
    );
  });
});

describe('PR #7 — errors, keys and reasons', () => {
  it('typed sync errors carry a reason and no provider detail', () => {
    const cause = new Error('sk_test_secretvalue leaked?');
    const error = new BillingSubscriptionSyncError('verification_unavailable', { cause });
    assert.ok(isBillingSubscriptionSyncError(error));
    assert.equal(error.code, 'billing_sync_unavailable');
    assert.ok(!error.message.includes('sk_test_'));
    assert.ok(!isBillingSubscriptionSyncError(new Error('x')));
  });

  it('the verification key is deterministic per (subscription, version)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    assert.equal(billingSyncVerificationKey(id, 1), billingSyncVerificationKey(id, 1));
    assert.notEqual(billingSyncVerificationKey(id, 1), billingSyncVerificationKey(id, 2));
    assert.match(billingSyncVerificationKey(id, 1), /^[0-9a-f]{64}$/);
  });

  it('every reason is storable: ≤ 200 characters and never credential-shaped', () => {
    for (const reason of Object.values(BILLING_SYNC_REASONS)) {
      assert.ok(reason.length > 0 && reason.length <= 200, reason);
      assert.doesNotMatch(reason, /(password|passwd|token|secret|api[_-]?key|authorization|private[_-]?key|credential|bearer)/i);
    }
  });
});

describe('PR #7 — source boundaries', () => {
  it('sync never writes plan or any commercial, lock, period or cancellation column', () => {
    const updates = [...SYNC_SOURCE.matchAll(/UPDATE subscriptions\s+SET([\s\S]*?)WHERE/g)].map((m) => m[1]!);
    assert.equal(updates.length, 1, 'exactly one subscriptions UPDATE');
    const assigned = [...updates[0]!.matchAll(/(\w+)\s*=/g)].map((m) => m[1]!).sort();
    assert.deepEqual(assigned, [
      'last_event_idempotency_key', 'last_sync_source', 'last_synced_at', 'provider_state',
      'state_version', 'status', 'sync_required', 'sync_state',
    ]);
    assert.doesNotMatch(SYNC_SOURCE, /INSERT INTO subscriptions/);
    assert.doesNotMatch(SYNC_SOURCE, /UPDATE users/i);
    assert.match(SYNC_SOURCE, /WHERE id = \$1 AND state_version = \$2/, 'optimistic concurrency guard');
    assert.match(SYNC_SOURCE, /SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE\[observed\.state\]/, 'the one mapping');
  });

  it('sync reaches the provider only through the seam and performs no transport', () => {
    assert.doesNotMatch(SYNC_CODE, /@veltrixeye\/provider-paystack/);
    assert.doesNotMatch(SYNC_CODE, /process\.env/);
    assert.doesNotMatch(SYNC_CODE, /\bfetch\s*\(/);
    assert.doesNotMatch(SYNC_CODE, /https?:\/\//);
    assert.doesNotMatch(SYNC_CODE, /getEntitlements|resolveEntitlements|canAccessAutomation|FREE_ENTITLEMENTS/);
    assert.match(SYNC_SOURCE, /provider\.verifySubscription\(request\)/);
  });

  it('the webhook receiver stays receipt-only: no verification, no claim/settle, no state write', () => {
    const start = WEBHOOK_SOURCE.indexOf('export class BillingWebhookReceiver');
    assert.ok(start > 0);
    const receiver = WEBHOOK_SOURCE.slice(start);
    for (const forbidden of [
      /verifySubscription/, /synchronizeSubscription/, /claimReceivedBillingProviderEvents/,
      /settleBillingProviderEvents/, /UPDATE\s+subscriptions/i, /BillingSubscriptionSyncService/,
    ]) {
      assert.doesNotMatch(receiver, forbidden, `the receiver must not contain ${forbidden}`);
    }
    // The receiver's only ledger write is still the fixed `received` INSERT.
    assert.match(WEBHOOK_SOURCE, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, 'received', \$11, \$12, \$13\)/);
    assert.doesNotMatch(WEBHOOK_SOURCE, /from '\.\/sync\.js'/, 'webhook.ts does not import sync');
  });

  it('ledger transitions only move processing columns, and only from received', () => {
    const update = /UPDATE billing_provider_events([\s\S]*?)`/.exec(WEBHOOK_SOURCE)?.[1] ?? '';
    assert.match(update, /WHERE id = ANY\(\$1::uuid\[\]\) AND status = 'received'/);
    const assigned = [...(update.split('WHERE')[0] ?? '').matchAll(/(\w+)\s*=/g)].map((m) => m[1]!).sort();
    assert.deepEqual(assigned, ['failure_reason', 'processed_at', 'status']);
  });
});
