import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  BILLING_LIFECYCLE_STATES,
  BILLING_PROVIDER,
  SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE,
  subscriptionSyncResultSchema,
  type BillingEventType,
  type BillingLifecycleState,
  type NormalizedBillingEvent,
  type ProviderSubscriptionState,
} from '@veltrixeye/contracts';
import {
  BILLING_SYNC_REASONS,
  BillingPricingSnapshotStore,
  BillingProviderEventStore,
  BillingSubscriptionSyncService,
  BillingWebhookReceiver,
  FREE_ENTITLEMENTS,
  billingCheckoutReference,
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  billingSyncVerificationKey,
  createBillingProviderRegistry,
  createFreeSubscription,
  createUnimplementedBillingProvider,
  getBillingState,
  isBillingSubscriptionSyncError,
  type BillingProviderRawEvent,
  type BillingSubscriptionVerifyRequest,
} from '../src/index.js';
import {
  deriveSnapshot, insertEpoch, insertUser, retireActiveEpochs, startBillingTestDb,
} from './helpers/billing-checkout.js';

/* ==========================================================================
   Later-billing-PR #7 — BillingSubscriptionSyncService against a REAL
   database (embedded PG, migrations 0001–0032; no new migration).

   The provider is a stub behind the canonical seam, so every canonical
   lifecycle state can be exercised (the Paystack adapter itself only ever
   reports `unknown`: its verify read publishes no subscription status — see
   packages/providers/paystack/test/verify.test.ts).
   ========================================================================== */

const SECRET = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const NOW = new Date('2027-06-01T12:00:00.000Z');

/** The columns synchronization is allowed to move — nothing else. */
const SYNC_WRITABLE_COLUMNS = new Set([
  'status', 'provider_state', 'sync_state', 'sync_required', 'last_sync_source',
  'last_synced_at', 'last_event_idempotency_key', 'state_version', 'updated_at',
]);

let db: Awaited<ReturnType<typeof startBillingTestDb>>;

before(async () => {
  db = await startBillingTestDb(5497);
}, { timeout: 180_000 });
after(async () => { await db?.stop(); });
beforeEach(async () => {
  // 0031 refuses to delete unprocessed rows; test hygiene only.
  await db.pool.query(
    `UPDATE billing_provider_events SET status = 'ignored', processed_at = now() WHERE status = 'received'`,
  );
  await db.pool.query('DELETE FROM billing_provider_events');
});

interface Fixture {
  userId: string;
  subscriptionId: string;
  reference: string;
  customerCode: string;
}

/** A provider-backed subscription exactly as checkout leaves it (status active, provider_state pending). */
async function providerBacked(options: { plan?: 'pro' | 'elite'; status?: string } = {}): Promise<Fixture> {
  const cataloguePlan = options.plan ?? 'pro';
  // One active epoch per plan (0032): retire the previous test's epoch first.
  // Existing locks are immutable, so earlier fixtures are unaffected.
  await retireActiveEpochs(db.pool);
  const facts = await insertEpoch(db.pool, { plan: cataloguePlan });
  const snapshot = deriveSnapshot(facts);
  const stored = await new BillingPricingSnapshotStore(db.pool).create(snapshot);
  const user = await insertUser(db.pool, true);
  const { rows } = await db.pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, catalogue_plan, billing_interval, currency,
       provider, provider_plan_id, provider_state, locked_pricing_snapshot_id)
     VALUES ($1, $2, $3, $4, 'monthly', 'USD', 'paystack', $5, 'pending', $6)
     RETURNING id`,
    [user.id, cataloguePlan === 'elite' ? 'premium' : 'pro', options.status ?? 'active', cataloguePlan,
      snapshot.providerPlanId, stored.id],
  );
  const customer = await db.pool.query(
    'SELECT provider_customer_code FROM billing_customers WHERE user_id = $1', [user.id],
  );
  return {
    userId: user.id,
    subscriptionId: rows[0]!.id as string,
    reference: billingCheckoutReference(user.id, stored.idempotencyKey),
    customerCode: customer.rows[0]!.provider_customer_code as string,
  };
}

function observed(overrides: Partial<ProviderSubscriptionState> = {}): ProviderSubscriptionState {
  return {
    provider: 'paystack',
    state: 'unknown',
    providerSubscriptionId: null,
    providerSubscriptionCode: null,
    providerCustomerId: null,
    providerCustomerCode: null,
    providerPlanId: null,
    providerReference: null,
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
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function serviceWith(
  verify: (request: BillingSubscriptionVerifyRequest) => Promise<ProviderSubscriptionState>,
  extras: { normalizeEvent?: (request: BillingProviderRawEvent) => Promise<NormalizedBillingEvent> } = {},
) {
  const calls: BillingSubscriptionVerifyRequest[] = [];
  const registry = createBillingProviderRegistry();
  registry.register({
    ...createUnimplementedBillingProvider(),
    verifySubscription: async (request: BillingSubscriptionVerifyRequest) => {
      calls.push(request);
      return verify(request);
    },
    ...extras,
  });
  return {
    calls,
    registry,
    service: new BillingSubscriptionSyncService({ db: db.pool, providers: registry, now: () => NOW }),
  };
}

const reporting = (fixture: Fixture, state: BillingLifecycleState, overrides: Partial<ProviderSubscriptionState> = {}) =>
  async () => observed({ state, providerReference: fixture.reference, providerCustomerCode: fixture.customerCode, ...overrides });

async function subscriptionRow(id: string): Promise<Record<string, unknown>> {
  const { rows } = await db.pool.query('SELECT * FROM subscriptions WHERE id = $1', [id]);
  return rows[0] as Record<string, unknown>;
}

function changedColumns(before: Record<string, unknown>, afterRow: Record<string, unknown>): string[] {
  return Object.keys(before).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(afterRow[key]),
  );
}

async function recordEvent(
  fixture: Pick<Fixture, 'subscriptionId' | 'userId'> | null,
  eventType: BillingEventType,
  options: { failureReason?: string | null; seed?: string } = {},
) {
  const payloadHash = billingEventPayloadHash({ event: eventType, seed: options.seed ?? randomUUID() });
  const identity = {
    provider: BILLING_PROVIDER, providerEventId: null, eventType, occurredAt: null, payloadHash,
  };
  const idempotencyKey = billingEventIdempotencyKey(identity);
  await new BillingProviderEventStore(db.pool).record({
    ...identity,
    idempotencyKey,
    subscriptionId: fixture?.subscriptionId ?? null,
    userId: fixture?.userId ?? null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    providerReference: null,
    failureReason: options.failureReason ?? null,
    receivedAt: new Date(NOW.getTime() - 60_000).toISOString(),
  });
  return idempotencyKey;
}

async function ledger(idempotencyKey: string) {
  const { rows } = await db.pool.query(
    `SELECT status, processed_at, failure_reason FROM billing_provider_events WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return rows[0] as { status: string; processed_at: Date | null; failure_reason: string | null };
}

/* -------------------------------------------------------------------------- */

describe('PR #7 (db) — every canonical state goes through the ONE mapping', () => {
  const expectations: Record<BillingLifecycleState, { outcome: string; status: string; syncState: string; syncRequired: boolean; review: boolean }> = {
    active: { outcome: 'unchanged', status: 'active', syncState: 'synced', syncRequired: false, review: false },
    trialing: { outcome: 'updated', status: 'trialing', syncState: 'synced', syncRequired: false, review: false },
    past_due: { outcome: 'updated', status: 'past_due', syncState: 'synced', syncRequired: false, review: false },
    cancelled: { outcome: 'updated', status: 'canceled', syncState: 'synced', syncRequired: false, review: false },
    unsubscribed: { outcome: 'updated', status: 'canceled', syncState: 'synced', syncRequired: false, review: false },
    expired: { outcome: 'updated', status: 'expired', syncState: 'synced', syncRequired: false, review: false },
    unprovisioned: { outcome: 'ignored', status: 'active', syncState: 'pending', syncRequired: false, review: false },
    pending: { outcome: 'requires_manual_review', status: 'active', syncState: 'conflict', syncRequired: true, review: true },
    unknown: { outcome: 'requires_manual_review', status: 'active', syncState: 'conflict', syncRequired: true, review: true },
  };

  it('covers the whole canonical vocabulary', () => {
    assert.deepEqual(Object.keys(expectations).sort(), [...BILLING_LIFECYCLE_STATES].sort());
  });

  for (const state of BILLING_LIFECYCLE_STATES) {
    it(`${state} → ${expectations[state].outcome} (status ${expectations[state].status})`, async () => {
      const fixture = await providerBacked();
      const before = await subscriptionRow(fixture.subscriptionId);
      const { service, calls } = serviceWith(reporting(fixture, state));
      const result = await service.synchronize(fixture.userId);
      const expected = expectations[state];

      assert.deepEqual(subscriptionSyncResultSchema.parse(result), result, 'canonical result');
      assert.equal(result.outcome, expected.outcome);
      assert.equal(result.requiresManualReview, expected.review);
      assert.equal(result.providerState, state);
      assert.equal(result.fromStatus, 'active');
      assert.equal(result.toStatus, SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE[state]);
      assert.equal(result.planChanged, false);
      assert.equal(result.entitlementsChanged, false);
      assert.equal(result.grantsExecution, false);
      assert.equal(result.stateVersion, 2);
      assert.equal(calls.length, 1);

      const afterRow = await subscriptionRow(fixture.subscriptionId);
      assert.equal(afterRow.status, expected.status);
      assert.equal(afterRow.provider_state, state);
      assert.equal(afterRow.sync_state, expected.syncState);
      assert.equal(afterRow.sync_required, expected.syncRequired);
      assert.equal(afterRow.last_sync_source, 'verification');
      assert.equal((afterRow.last_synced_at as Date).toISOString(), NOW.toISOString());
      assert.equal(afterRow.state_version, 2);

      // `plan` and every commercial/lock/period/cancellation column are byte-identical.
      for (const column of changedColumns(before, afterRow)) {
        assert.ok(SYNC_WRITABLE_COLUMNS.has(column), `synchronization must not write ${column}`);
      }
      for (const column of ['plan', 'catalogue_plan', 'billing_interval', 'locked_pricing_snapshot_id',
        'provider_plan_id', 'current_period_start', 'current_period_end', 'cancel_at', 'cancelled_at',
        'cancellation_reason', 'cancel_at_period_end', 'provider_reference', 'provider_customer_id',
        'provider_subscription_id', 'provider_subscription_code']) {
        assert.deepEqual(afterRow[column], before[column], `${column} unchanged`);
      }
    });
  }

  it('an elite (premium) subscription keeps its plan byte-identical through an update', async () => {
    const fixture = await providerBacked({ plan: 'elite' });
    const before = await subscriptionRow(fixture.subscriptionId);
    const { service } = serviceWith(reporting(fixture, 'expired'));
    const result = await service.synchronize(fixture.userId);
    assert.equal(result.outcome, 'updated');
    const afterRow = await subscriptionRow(fixture.subscriptionId);
    assert.equal(afterRow.plan, 'premium');
    assert.equal(afterRow.catalogue_plan, 'elite');
    assert.equal(afterRow.plan, before.plan);
    assert.equal(afterRow.status, 'expired');
  });
});

describe('PR #7 (db) — verification request', () => {
  it('verifies OUR derived checkout reference with a deterministic key and no subscription id', async () => {
    const fixture = await providerBacked();
    const { service, calls } = serviceWith(reporting(fixture, 'unknown'));
    await service.synchronize(fixture.userId);
    assert.equal(calls.length, 1);
    const request = calls[0]!;
    assert.equal(request.provider, 'paystack');
    assert.equal(request.userId, fixture.userId);
    assert.equal(request.providerReference, fixture.reference);
    assert.equal(request.providerSubscriptionId, undefined);
    assert.equal(request.idempotencyKey, billingSyncVerificationKey(fixture.subscriptionId, 1));
    assert.equal(request.requestedAt, NOW.toISOString());
  });
});

describe('PR #7 (db) — ledger received → processed / ignored / failed', () => {
  it('an applied sync processes bound events, ignores bound unrecognized ones, leaves others alone', async () => {
    const fixture = await providerBacked();
    const other = await providerBacked();
    const paid = await recordEvent(fixture, 'payment.succeeded');
    const unrecognized = await recordEvent(fixture, 'unrecognized', { failureReason: 'refused delivery kept as evidence' });
    const invoice = await recordEvent(fixture, 'invoice.processed');
    const foreign = await recordEvent(other, 'payment.succeeded');
    const unbound = await recordEvent(null, 'payment.succeeded');

    const { service } = serviceWith(reporting(fixture, 'active'));
    const result = await service.synchronize(fixture.userId);
    assert.equal(result.outcome, 'unchanged');
    assert.deepEqual([...result.appliedEventIdempotencyKeys].sort(), [paid, invoice].sort());

    for (const key of [paid, invoice]) {
      const row = await ledger(key);
      assert.equal(row.status, 'processed');
      assert.equal(row.processed_at?.toISOString(), NOW.toISOString());
      assert.equal(row.failure_reason, null);
    }
    const ignored = await ledger(unrecognized);
    assert.equal(ignored.status, 'ignored');
    assert.equal(ignored.failure_reason, 'refused delivery kept as evidence', 'an existing reason is kept');
    assert.equal((await ledger(foreign)).status, 'received', "another subscription's events are untouched");
    assert.equal((await ledger(unbound)).status, 'received', 'unbound events are untouched');

    const row = await subscriptionRow(fixture.subscriptionId);
    assert.ok([paid, invoice].includes(row.last_event_idempotency_key as string));
  });

  it('a review outcome ignores bound events with the review reason and applies nothing', async () => {
    const fixture = await providerBacked();
    const paid = await recordEvent(fixture, 'payment.succeeded');
    const { service } = serviceWith(reporting(fixture, 'unknown'));
    const result = await service.synchronize(fixture.userId);
    assert.equal(result.outcome, 'requires_manual_review');
    assert.deepEqual(result.appliedEventIdempotencyKeys, []);
    assert.equal(result.reason, BILLING_SYNC_REASONS.reviewRequired);
    const row = await ledger(paid);
    assert.equal(row.status, 'ignored');
    assert.equal(row.failure_reason, BILLING_SYNC_REASONS.reviewRequired);
    assert.equal((await subscriptionRow(fixture.subscriptionId)).last_event_idempotency_key, null);
  });

  it('an identity conflict fails bound events and moves neither status nor provider_state', async () => {
    for (const overrides of [
      { providerCustomerCode: 'CUS_someoneelse' },
      { providerReference: 've-chk-not-ours' },
      { providerSubscriptionId: null, provider: 'paystack' as const, providerCustomerId: null, providerCustomerCode: 'CUS_mismatch' },
    ]) {
      const fixture = await providerBacked();
      const paid = await recordEvent(fixture, 'payment.succeeded');
      const before = await subscriptionRow(fixture.subscriptionId);
      const { service } = serviceWith(reporting(fixture, 'cancelled', overrides));
      const result = await service.synchronize(fixture.userId);
      assert.equal(result.outcome, 'conflict');
      assert.equal(result.requiresManualReview, true);
      assert.equal(result.toStatus, null);
      assert.equal(result.providerState, null);
      assert.equal(result.reason, BILLING_SYNC_REASONS.identityConflict);
      const afterRow = await subscriptionRow(fixture.subscriptionId);
      assert.equal(afterRow.status, before.status);
      assert.equal(afterRow.provider_state, before.provider_state);
      assert.equal(afterRow.sync_state, 'conflict');
      assert.equal(afterRow.sync_required, true);
      const row = await ledger(paid);
      assert.equal(row.status, 'failed');
      assert.equal(row.failure_reason, BILLING_SYNC_REASONS.identityConflict);
    }
  });
});

describe('PR #7 (db) — idempotent replay and optimistic concurrency', () => {
  it('replaying the same verified state changes no status, plan or ledger row again', async () => {
    const fixture = await providerBacked();
    const paid = await recordEvent(fixture, 'payment.succeeded');
    const { service } = serviceWith(reporting(fixture, 'cancelled'));
    const first = await service.synchronize(fixture.userId);
    assert.equal(first.outcome, 'updated');
    assert.deepEqual(first.appliedEventIdempotencyKeys, [paid]);
    const afterFirst = await subscriptionRow(fixture.subscriptionId);
    const ledgerAfterFirst = await ledger(paid);

    const second = await service.synchronize(fixture.userId);
    assert.equal(second.outcome, 'unchanged');
    assert.equal(second.fromStatus, 'canceled');
    assert.equal(second.toStatus, 'canceled');
    assert.deepEqual(second.appliedEventIdempotencyKeys, []);
    assert.equal(second.stateVersion, first.stateVersion + 1);
    const afterSecond = await subscriptionRow(fixture.subscriptionId);
    assert.equal(afterSecond.status, 'canceled');
    assert.equal(afterSecond.plan, afterFirst.plan);
    assert.equal(afterSecond.last_event_idempotency_key, paid, 'the last applied key is kept');
    assert.deepEqual(await ledger(paid), ledgerAfterFirst, 'a settled row is never re-settled');
  });

  it('a writer that lands during verification wins: the stale sync applies nothing', async () => {
    const fixture = await providerBacked();
    const paid = await recordEvent(fixture, 'payment.succeeded');
    const { service } = serviceWith(async () => {
      // A concurrent writer bumps the version while the provider is being read.
      await db.pool.query('UPDATE subscriptions SET state_version = state_version + 1 WHERE id = $1', [fixture.subscriptionId]);
      return observed({ state: 'expired', providerReference: fixture.reference });
    });
    const before = await subscriptionRow(fixture.subscriptionId);
    const result = await service.synchronize(fixture.userId);
    assert.equal(result.outcome, 'conflict');
    assert.equal(result.requiresManualReview, true);
    assert.equal(result.reason, BILLING_SYNC_REASONS.staleVersion);
    assert.equal(result.stateVersion, 2, 'reports the winning version');
    const afterRow = await subscriptionRow(fixture.subscriptionId);
    assert.equal(afterRow.status, before.status);
    assert.equal(afterRow.provider_state, before.provider_state);
    assert.equal(afterRow.sync_state, 'never_synced');
    assert.equal(afterRow.last_synced_at, null);
    assert.equal((await ledger(paid)).status, 'received', 'the loser settles nothing');
  });

  it('the database refuses a stale (decreasing) version outright', async () => {
    const fixture = await providerBacked();
    await db.pool.query('UPDATE subscriptions SET state_version = 5 WHERE id = $1', [fixture.subscriptionId]);
    await assert.rejects(
      () => db.pool.query('UPDATE subscriptions SET state_version = 4 WHERE id = $1', [fixture.subscriptionId]),
      /state_version cannot decrease/,
    );
  });
});

describe('PR #7 (db) — refusals write nothing', () => {
  it('a verification failure throws verification_unavailable; row and ledger untouched', async () => {
    const fixture = await providerBacked();
    const paid = await recordEvent(fixture, 'payment.succeeded');
    const before = await subscriptionRow(fixture.subscriptionId);
    for (const verify of [
      async () => { throw new Error('provider unreachable'); },
      async () => ({ not: 'canonical' }) as unknown as ProviderSubscriptionState,
      async () => ({ ...observed(), extra: 'provider-shaped field' }) as unknown as ProviderSubscriptionState,
    ]) {
      const { service } = serviceWith(verify);
      await assert.rejects(
        () => service.synchronize(fixture.userId),
        (error: unknown) => isBillingSubscriptionSyncError(error) && error.reason === 'verification_unavailable',
      );
    }
    assert.deepEqual(await subscriptionRow(fixture.subscriptionId), before);
    assert.equal((await ledger(paid)).status, 'received');
  });

  it('no registered provider refuses with provider_not_registered before any read', async () => {
    const fixture = await providerBacked();
    const before = await subscriptionRow(fixture.subscriptionId);
    const service = new BillingSubscriptionSyncService({
      db: db.pool, providers: createBillingProviderRegistry(), now: () => NOW,
    });
    await assert.rejects(
      () => service.synchronize(fixture.userId),
      (error: unknown) => isBillingSubscriptionSyncError(error) && error.reason === 'provider_not_registered',
    );
    assert.deepEqual(await subscriptionRow(fixture.subscriptionId), before);
  });

  it('a user without a provider-backed row is ignored with no provider call and no write', async () => {
    const free = await insertUser(db.pool, false);
    await createFreeSubscription(db.pool, free.id);
    const { rows: beforeRows } = await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [free.id]);
    const nobody = await insertUser(db.pool, false);
    const { service, calls } = serviceWith(async () => observed({ state: 'active' }));
    for (const userId of [free.id, nobody.id]) {
      const result = await service.synchronize(userId);
      assert.equal(result.outcome, 'ignored');
      assert.equal(result.subscriptionId, null);
      assert.equal(result.requiresManualReview, false);
      assert.equal(result.reason, BILLING_SYNC_REASONS.noProviderSubscription);
    }
    assert.equal(calls.length, 0);
    const { rows: afterRows } = await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [free.id]);
    assert.deepEqual(afterRows, beforeRows);
  });

  it('a provider-backed row without a price lock needs review and is never verified', async () => {
    const user = await insertUser(db.pool, true);
    await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, currency, provider, provider_state)
       VALUES ($1, 'pro', 'active', 'USD', 'paystack', 'pending')`, [user.id],
    );
    const { rows: beforeRows } = await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id]);
    const { service, calls } = serviceWith(async () => observed({ state: 'active' }));
    const result = await service.synchronize(user.id);
    assert.equal(result.outcome, 'requires_manual_review');
    assert.equal(result.reason, BILLING_SYNC_REASONS.noPricingLock);
    assert.equal(calls.length, 0);
    const { rows: afterRows } = await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id]);
    assert.deepEqual(afterRows, beforeRows);
  });

  it('refuses a non-uuid user id before anything', async () => {
    const { service, calls } = serviceWith(async () => observed());
    await assert.rejects(() => service.synchronize('not-a-uuid'));
    assert.equal(calls.length, 0);
  });
});

describe('PR #7 (db) — entitlement boundary and redaction', () => {
  it('a provider-backed row still resolves to FREE after every applied status', async () => {
    for (const state of ['active', 'trialing', 'past_due', 'cancelled', 'expired'] as const) {
      const fixture = await providerBacked({ plan: 'elite' });
      const { service } = serviceWith(reporting(fixture, state));
      await service.synchronize(fixture.userId);
      const billing = await getBillingState(db.pool, fixture.userId);
      assert.deepEqual(billing.entitlements, FREE_ENTITLEMENTS, `${state}: provider→FREE gate unchanged`);
      assert.equal(billing.entitlements.canAccessAutomation, false);
      assert.equal(billing.providerStatus.paymentConfirmed, false);
      assert.equal(billing.providerStatus.provider, 'paystack');
    }
  });

  it('never persists the verified observation (amounts, provider ids, observedAt)', async () => {
    const fixture = await providerBacked();
    const paid = await recordEvent(fixture, 'payment.succeeded');
    const { service } = serviceWith(async () => observed({
      state: 'active',
      providerReference: fixture.reference,
      providerCustomerCode: fixture.customerCode,
      providerCustomerId: '987654321',
      payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_751, paymentAmountExponent: 2 },
      observedAt: '2027-06-01T11:59:59.123Z',
    }));
    await service.synchronize(fixture.userId);
    const subscription = JSON.stringify(await subscriptionRow(fixture.subscriptionId));
    const { rows } = await db.pool.query('SELECT * FROM billing_provider_events WHERE idempotency_key = $1', [paid]);
    const events = JSON.stringify(rows);
    for (const needle of ['48751', '987654321', '11:59:59.123']) {
      assert.ok(!subscription.includes(needle), `subscriptions must not store ${needle}`);
      assert.ok(!events.includes(needle), `ledger must not store ${needle}`);
    }
  });
});

describe('PR #7 (db) — the webhook receiver stays receipt-only', () => {
  it('a verified delivery records a received row, moves no state and never verifies', async () => {
    const fixture = await providerBacked();
    const before = await subscriptionRow(fixture.subscriptionId);
    const { registry, calls } = serviceWith(async () => observed({ state: 'active' }), {
      normalizeEvent: async (request) => {
        const payloadHash = billingEventPayloadHash(request.payload);
        const input = {
          provider: BILLING_PROVIDER, providerEventId: null,
          eventType: 'payment.succeeded' as const, occurredAt: '2027-06-01T11:00:00.000Z', payloadHash,
        };
        return {
          identity: { ...input, idempotencyKey: billingEventIdempotencyKey(input), receivedAt: request.receivedAt },
          category: 'payment',
          subject: {
            userId: null, subscriptionId: null, billingCustomerId: null,
            providerCustomerId: null, providerSubscriptionId: null, providerReference: fixture.reference,
          },
          data: null,
          grantsExecution: false,
        };
      },
    });
    const receiver = new BillingWebhookReceiver({ db: db.pool, providers: registry, secretKey: SECRET });
    const raw = JSON.stringify({ event: 'charge.success', data: { reference: fixture.reference } });
    const receipt = await receiver.receive({
      rawBody: Buffer.from(raw),
      signatureHeader: createHmac('sha512', SECRET).update(raw).digest('hex'),
      receivedAt: NOW,
    });
    assert.equal(receipt.outcome, 'recorded');
    assert.equal(calls.length, 0, 'the receiver never calls verifySubscription');
    assert.deepEqual(await subscriptionRow(fixture.subscriptionId), before, 'the receiver moves no state');
    const { rows } = await db.pool.query(
      'SELECT status, subscription_id FROM billing_provider_events WHERE subscription_id = $1', [fixture.subscriptionId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'received');
  });
});
