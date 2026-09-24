import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BILLING_PROVIDER, type NormalizedBillingEvent } from '@veltrixeye/contracts';
import {
  BillingProviderEventStore,
  BillingWebhookReceiver,
  billingCheckoutReference,
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  createBillingEventSubjectResolver,
  createBillingProviderRegistry,
  createUnimplementedBillingProvider,
  isBillingWebhookError,
  BillingPricingSnapshotStore,
  type BillingProviderRawEvent,
} from '../src/index.js';
import { startBillingTestDb, insertEpoch, insertUser, deriveSnapshot } from './helpers/billing-checkout.js';

/* ==========================================================================
   Billing Step 5.2 — the receiver against a REAL database (embedded PG).

   Covers what only the database can prove: the ledger's idempotency UNIQUE
   collapsing replays, the composite subject FK, the credential-shaped
   failure_reason CHECK, and the subject resolver's lookups against the real
   directories — including the checkout-reference derivation, which reuses
   exactly the function checkout uses (never a restatement of it).
   ========================================================================== */

const SECRET = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const RECEIVED_AT = new Date('2027-06-01T00:00:00.000Z');
const sign = (raw: string) => createHmac('sha512', SECRET).update(raw).digest('hex');

let db: Awaited<ReturnType<typeof startBillingTestDb>>;

before(async () => {
  db = await startBillingTestDb(5495);
}, { timeout: 180_000 });
after(async () => { await db?.stop(); });
beforeEach(async () => {
  // 0031's retention trigger refuses to delete an unprocessed event — so a
  // test cleanup must first move rows out of `received` (a later
  // synchronization step owns real transitions; this is test hygiene only).
  await db.pool.query(
    `UPDATE billing_provider_events SET status = 'processed', processed_at = now() WHERE status = 'received'`,
  );
  await db.pool.query('DELETE FROM billing_provider_events');
});

async function ledgerRows() {
  const { rows } = await db.pool.query(
    `SELECT event_type, idempotency_key, payload_hash, subscription_id, user_id,
            provider_customer_id, provider_subscription_id, provider_reference,
            status, failure_reason, occurred_at, received_at
       FROM billing_provider_events ORDER BY created_at`,
  );
  return rows;
}

describe('Step 5.2 (db) — BillingProviderEventStore', () => {
  it('records one row per idempotency key; replays collapse onto it', async () => {
    const store = new BillingProviderEventStore(db.pool);
    const payloadHash = billingEventPayloadHash({ event: 'charge.success', data: { n: 1 } });
    const input = {
      provider: BILLING_PROVIDER,
      eventType: 'payment.succeeded' as const,
      providerEventId: null,
      idempotencyKey: billingEventIdempotencyKey({
        provider: BILLING_PROVIDER, providerEventId: null, eventType: 'payment.succeeded',
        occurredAt: null, payloadHash,
      }),
      payloadHash,
      subscriptionId: null, userId: null,
      providerCustomerId: 'CUS_a', providerSubscriptionId: null, providerReference: null,
      failureReason: null, occurredAt: null, receivedAt: RECEIVED_AT.toISOString(),
    };
    assert.equal((await store.record(input)).outcome, 'recorded');
    assert.equal((await store.record(input)).outcome, 'replayed');
    assert.equal((await store.record(input)).outcome, 'replayed');
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM billing_provider_events');
    assert.equal(rows[0]!.n, 1);
    // A DIFFERENT payload never collapses onto the same row.
    const otherHash = billingEventPayloadHash({ event: 'charge.success', data: { n: 2 } });
    await store.record({
      ...input,
      payloadHash: otherHash,
      idempotencyKey: billingEventIdempotencyKey({
        provider: BILLING_PROVIDER, providerEventId: null, eventType: 'payment.succeeded',
        occurredAt: null, payloadHash: otherHash,
      }),
    });
    const second = await db.pool.query('SELECT count(*)::int AS n FROM billing_provider_events');
    assert.equal(second.rows[0]!.n, 2);
  });

  it('the database is the last line of defence: a credential-shaped reason is refused by 0031', async () => {
    const store = new BillingProviderEventStore(db.pool);
    const payloadHash = billingEventPayloadHash({ event: 'x' });
    await assert.rejects(store.record({
      provider: BILLING_PROVIDER,
      eventType: 'unrecognized',
      providerEventId: null,
      idempotencyKey: billingEventIdempotencyKey({
        provider: BILLING_PROVIDER, providerEventId: null, eventType: 'unrecognized',
        occurredAt: null, payloadHash,
      }),
      payloadHash,
      subscriptionId: null, userId: null,
      providerCustomerId: null, providerSubscriptionId: null, providerReference: null,
      failureReason: 'the password was echoed back',
      occurredAt: null, receivedAt: RECEIVED_AT.toISOString(),
    }));
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM billing_provider_events');
    assert.equal(rows[0]!.n, 0);
  });

  it('0031 retention: an unprocessed event cannot be deleted (evidence survives)', async () => {
    const store = new BillingProviderEventStore(db.pool);
    const payloadHash = billingEventPayloadHash({ event: 'retention-probe' });
    await store.record({
      provider: BILLING_PROVIDER,
      eventType: 'unrecognized',
      providerEventId: null,
      idempotencyKey: billingEventIdempotencyKey({
        provider: BILLING_PROVIDER, providerEventId: null, eventType: 'unrecognized',
        occurredAt: null, payloadHash,
      }),
      payloadHash,
      subscriptionId: null, userId: null,
      providerCustomerId: null, providerSubscriptionId: null, providerReference: null,
      failureReason: null, occurredAt: null, receivedAt: RECEIVED_AT.toISOString(),
    });
    await assert.rejects(db.pool.query('DELETE FROM billing_provider_events'));
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM billing_provider_events');
    assert.equal(rows[0]!.n, 1);
  });

  it('a half-bound subject is refused (both ids or neither)', async () => {
    const store = new BillingProviderEventStore(db.pool);
    const payloadHash = billingEventPayloadHash({ event: 'y' });
    await assert.rejects(store.record({
      provider: BILLING_PROVIDER,
      eventType: 'unrecognized',
      providerEventId: null,
      idempotencyKey: billingEventIdempotencyKey({
        provider: BILLING_PROVIDER, providerEventId: null, eventType: 'unrecognized',
        occurredAt: null, payloadHash,
      }),
      payloadHash,
      subscriptionId: null, userId: randomUUID(),
      providerCustomerId: null, providerSubscriptionId: null, providerReference: null,
      failureReason: null, occurredAt: null, receivedAt: RECEIVED_AT.toISOString(),
    }));
  });
});

describe('Step 5.2 (db) — local subject resolution against the real directories', () => {
  it('resolves a provider customer id/code onto billing_customers', async () => {
    const user = await insertUser(db.pool, true);
    const { rows } = await db.pool.query(
      'SELECT provider_customer_code FROM billing_customers WHERE user_id = $1', [user.id],
    );
    const code = rows[0]!.provider_customer_code as string;
    const resolver = createBillingEventSubjectResolver(db.pool);
    const resolved = await resolver({
      providerCustomerId: code, providerSubscriptionId: null, providerReference: null,
    });
    assert.ok(resolved);
    assert.equal(resolved.userId, user.id);
    // No subscription row exists yet: the pair cannot be completed.
    assert.equal(resolved.subscriptionId, null);
    assert.ok(resolved.billingCustomerId);

    // Once checkout's subscription row exists (the realistic state by the
    // time charge events arrive), the user's UNIQUE row completes the pair.
    const { rows: subRows } = await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, currency, provider, provider_state)
       VALUES ($1, 'pro', 'active', 'USD', 'paystack', 'pending') RETURNING id`,
      [user.id],
    );
    const completed = await resolver({
      providerCustomerId: code, providerSubscriptionId: null, providerReference: null,
    });
    assert.ok(completed);
    assert.equal(completed.userId, user.id);
    assert.equal(completed.subscriptionId, subRows[0]!.id);

    // Unknown identifiers resolve to nothing — never to a guess.
    assert.equal(await resolver({
      providerCustomerId: 'CUS_unknown', providerSubscriptionId: null, providerReference: null,
    }), null);
  });

  it('resolves a provider subscription id onto the authoritative subscription row', async () => {
    const user = await insertUser(db.pool, false);
    await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, currency, provider, provider_state, provider_subscription_id)
       VALUES ($1, 'pro', 'active', 'USD', 'paystack', 'active', $2)`,
      [user.id, 'SUB_dbtest0001'],
    );
    const resolver = createBillingEventSubjectResolver(db.pool);
    const resolved = await resolver({
      providerCustomerId: null, providerSubscriptionId: 'SUB_dbtest0001', providerReference: null,
    });
    assert.ok(resolved);
    assert.equal(resolved.userId, user.id);
    assert.ok(resolved.subscriptionId);
  });

  it('resolves our own checkout reference onto the subscription that locked the snapshot', async () => {
    const facts = await insertEpoch(db.pool);
    const snapshot = deriveSnapshot(facts);
    const stored = await new BillingPricingSnapshotStore(db.pool).create(snapshot);
    const user = await insertUser(db.pool, false);
    const { rows } = await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, catalogue_plan, billing_interval, currency,
         provider, provider_plan_id, provider_state, locked_pricing_snapshot_id)
       VALUES ($1, 'pro', 'active', 'pro', 'monthly', 'USD', 'paystack', $2, 'pending', $3)
       RETURNING id`,
      [user.id, snapshot.providerPlanId, stored.id],
    );
    const subscriptionId = rows[0]!.id as string;

    const resolver = createBillingEventSubjectResolver(db.pool);
    const reference = billingCheckoutReference(user.id, stored.idempotencyKey);
    const resolved = await resolver({
      providerCustomerId: null, providerSubscriptionId: null, providerReference: reference,
    });
    assert.ok(resolved, 'the checkout reference must resolve to its owner');
    assert.equal(resolved.userId, user.id);
    assert.equal(resolved.subscriptionId, subscriptionId);
    // A reference-shaped value that matches nothing resolves to nothing.
    assert.equal(await resolver({
      providerCustomerId: null, providerSubscriptionId: null,
      providerReference: `ve-chk-${'0'.repeat(64)}`,
    }), null);
    // A non-reference string never triggers the scan path.
    assert.equal(await resolver({
      providerCustomerId: null, providerSubscriptionId: null, providerReference: 'some-other-ref',
    }), null);
  });

  it('a disagreement between resolution paths binds NOTHING', async () => {
    const userA = await insertUser(db.pool, true);
    const userB = await insertUser(db.pool, false);
    await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, currency, provider, provider_state, provider_subscription_id)
       VALUES ($1, 'pro', 'active', 'USD', 'paystack', 'active', $2)`,
      [userB.id, 'SUB_conflict01'],
    );
    const { rows } = await db.pool.query(
      'SELECT provider_customer_code FROM billing_customers WHERE user_id = $1', [userA.id],
    );
    const resolver = createBillingEventSubjectResolver(db.pool);
    assert.equal(await resolver({
      providerCustomerId: rows[0]!.provider_customer_code as string,
      providerSubscriptionId: 'SUB_conflict01',
      providerReference: null,
    }), null);
  });
});

describe('Step 5.2 (db) — receiver end-to-end (real store + resolver, stubbed seam)', () => {
  function receiverWith(normalizeEvent: (request: BillingProviderRawEvent) => Promise<NormalizedBillingEvent>) {
    const registry = createBillingProviderRegistry();
    registry.register({ ...createUnimplementedBillingProvider(), normalizeEvent });
    return new BillingWebhookReceiver({ db: db.pool, providers: registry, secretKey: SECRET });
  }

  it('records a verified delivery and binds the resolved subject', async () => {
    const user = await insertUser(db.pool, true);
    const { rows } = await db.pool.query(
      'SELECT provider_customer_code FROM billing_customers WHERE user_id = $1', [user.id],
    );
    const code = rows[0]!.provider_customer_code as string;
    // Checkout creates the subscription row before any charge event can
    // arrive; mirror that state so the subject pair can be bound.
    const { rows: subRows } = await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, currency, provider, provider_state)
       VALUES ($1, 'pro', 'active', 'USD', 'paystack', 'pending') RETURNING id`,
      [user.id],
    );
    const subscriptionId = subRows[0]!.id as string;

    const receiver = receiverWith(async (request) => {
      const payloadHash = billingEventPayloadHash(request.payload);
      const input = {
        provider: BILLING_PROVIDER, providerEventId: null,
        eventType: 'payment.succeeded' as const, occurredAt: '2026-09-22T10:15:02.000Z', payloadHash,
      };
      return {
        identity: { ...input, idempotencyKey: billingEventIdempotencyKey(input), receivedAt: request.receivedAt },
        category: 'payment',
        subject: {
          userId: null, subscriptionId: null, billingCustomerId: null,
          providerCustomerId: code, providerSubscriptionId: null, providerReference: null,
        },
        data: null,
        grantsExecution: false,
      };
    });

    const payload = { event: 'charge.success', data: { domain: 'test', customer: { customer_code: code } } };
    const raw = JSON.stringify(payload);
    const receipt = await receiver.receive({
      rawBody: Buffer.from(raw), signatureHeader: sign(raw), receivedAt: RECEIVED_AT,
    });
    assert.equal(receipt.outcome, 'recorded');
    assert.equal(receipt.subjectResolved, true);

    const ledger = await ledgerRows();
    assert.equal(ledger.length, 1);
    const row = ledger[0]!;
    assert.equal(row.event_type, 'payment.succeeded');
    assert.equal(row.status, 'received');
    assert.equal(row.user_id, user.id);
    assert.equal(row.subscription_id, subscriptionId); // the pair is bound, or not at all
    assert.equal(row.provider_customer_id, code);
    assert.equal(row.payload_hash, billingEventPayloadHash(payload));
    assert.equal(row.failure_reason, null);

    // The SAME delivery again collapses onto the same row.
    const replay = await receiver.receive({
      rawBody: Buffer.from(raw), signatureHeader: sign(raw), receivedAt: RECEIVED_AT,
    });
    assert.equal(replay.outcome, 'replayed');
    assert.equal((await ledgerRows()).length, 1);
  });

  it('an unverifiable signature writes nothing at all', async () => {
    const receiver = receiverWith(async () => {
      throw new Error('normalizeEvent must never run without a verified signature');
    });
    const raw = JSON.stringify({ event: 'charge.success', data: {} });
    await assert.rejects(receiver.receive({
      rawBody: Buffer.from(raw), signatureHeader: 'f'.repeat(128), receivedAt: RECEIVED_AT,
    }));
    assert.equal((await ledgerRows()).length, 0);
  });

  it('a resolution failure surfaces as persistence_failed, never a wrong owner', async () => {
    const receiver = new BillingWebhookReceiver({
      db: db.pool,
      providers: (() => {
        const registry = createBillingProviderRegistry();
        registry.register({
          ...createUnimplementedBillingProvider(),
          normalizeEvent: async (request: BillingProviderRawEvent) => {
            const payloadHash = billingEventPayloadHash(request.payload);
            const input = {
              provider: BILLING_PROVIDER, providerEventId: null,
              eventType: 'payment.succeeded' as const, occurredAt: null, payloadHash,
            };
            return {
              identity: { ...input, idempotencyKey: billingEventIdempotencyKey(input), receivedAt: request.receivedAt },
              category: 'payment',
              subject: {
                userId: null, subscriptionId: null, billingCustomerId: null,
                providerCustomerId: 'CUS_anything', providerSubscriptionId: null, providerReference: null,
              },
              data: null,
              grantsExecution: false,
            };
          },
        });
        return registry;
      })(),
      secretKey: SECRET,
      // A resolver that claims a subscription that does not exist: the
      // composite FK must refuse the insert rather than store a false bond.
      resolveSubject: async () => ({
        userId: randomUUID(),
        subscriptionId: randomUUID(),
        billingCustomerId: null,
      }),
    });
    const raw = JSON.stringify({ event: 'charge.success', data: {} });
    await assert.rejects(
      receiver.receive({ rawBody: Buffer.from(raw), signatureHeader: sign(raw), receivedAt: RECEIVED_AT }),
      (error: unknown) => isBillingWebhookError(error) && error.reason === 'persistence_failed',
    );
    assert.equal((await ledgerRows()).length, 0);
  });
});
