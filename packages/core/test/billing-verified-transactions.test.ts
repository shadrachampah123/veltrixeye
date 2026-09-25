import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  billingPaymentEvidenceIdempotencyCanonicalString,
  billingPaymentEvidenceSchema,
  type BillingVerifiedTransaction,
} from '@veltrixeye/contracts';
import {
  BillingVerifiedTransactionStore,
  billingVerifiedTransactionEvidenceHash,
  billingVerifiedTransactionIdempotencyKey,
  isBillingVerifiedTransactionError,
} from '../src/billing/verified-transactions.js';
import { BillingPricingSnapshotStore } from '../src/billing/snapshots.js';
import { insertUser, startBillingTestDb, insertEpoch } from './helpers/billing-checkout.js';

/* ==========================================================================
   Billing Step 7 — durable payment-evidence store (migration 0033).

   Append-only, integer minor units GHS/2, unique provider ref + idempotency
   key, immutable, no card/secrets, preserve redaction, idempotent replay,
   concurrent safe (first writer wins via UNIQUE), conflicting fails closed.
   ========================================================================== */

const NOW = new Date('2026-09-24T10:00:00.000Z');
const PAID_AT = '2026-09-24T10:01:00.000Z';
const VERIFIED_AT = '2026-09-24T10:02:00.000Z';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
before(async () => { db = await startBillingTestDb(5523); }, { timeout: 180_000 });
after(async () => { await db?.stop(); });

function verified(reference: string, overrides: Partial<BillingVerifiedTransaction> = {}): BillingVerifiedTransaction {
  const base: BillingVerifiedTransaction = {
    provider: 'paystack',
    providerReference: reference,
    providerTransactionId: String(100_000 + Math.floor(Math.random() * 900_000)),
    providerStatus: 'success',
    providerDomain: 'test',
    paymentCurrency: 'GHS',
    paymentAmountMinor: 48750,
    paymentAmountExponent: 2,
    providerCustomerId: '42',
    providerCustomerCode: 'CUS_testCode123',
    paidAt: PAID_AT,
    verifiedAt: VERIFIED_AT,
  };
  return { ...base, ...overrides } as BillingVerifiedTransaction;
}

async function setupContext() {
  const user = await insertUser(db.pool, false);
  // Each test needs a fresh active epoch; retire the previous one so the
  // unique (catalogue_plan, billing_interval) active constraint does not fire.
  await db.pool.query("UPDATE billing_provider_plans SET status='retired', retired_at=now(), retired_reason='next test' WHERE status='active'");
  const facts = await insertEpoch(db.pool);
  const { epoch, fx } = facts;
  const snapshots = new BillingPricingSnapshotStore(db.pool);
  const { deriveSnapshot } = await import('./helpers/billing-checkout.js');
  const derived = deriveSnapshot(facts);
  const storedSnap = await snapshots.create(derived);
  // Create subscription locked to this snapshot, provider paystack.
  const { rows: [sub] } = await db.pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, provider, catalogue_plan, billing_interval, currency, locked_pricing_snapshot_id, provider_plan_id, state_version)
     VALUES ($1,'pro','active','paystack',$2,$3,'USD',$4,$5,1) RETURNING id`,
    [user.id, storedSnap.snapshot.cataloguePlan, storedSnap.snapshot.interval, storedSnap.id, epoch.provider_plan_id],
  );
  const subscriptionId = (sub as { id: string }).id;
  // Ensure billing_customers exists for this user (used by reconciliation but not required for store).
  await db.pool.query(`INSERT INTO billing_customers (user_id, email, status, provider_customer_code, provisioned_at) VALUES ($1,$2,'provisioned',$3, now())`, [user.id, user.email, `CUS_${randomUUID().replaceAll('-', '').slice(0, 10)}`]);

  return { user, snapshot: storedSnap, subscriptionId, epoch };
}

describe('Step 7 — idempotencyKey and evidenceHash are deterministic', () => {
  it('idempotencyKey is sha256 of canonical string and deterministic per (provider, reference, snapshot)', () => {
    const a = billingVerifiedTransactionIdempotencyKey({ provider: 'paystack', providerReference: 've-chk-abc', pricingSnapshotId: randomUUID() });
    const b = billingVerifiedTransactionIdempotencyKey({ provider: 'paystack', providerReference: 've-chk-abc', pricingSnapshotId: randomUUID() });
    assert.notEqual(a, b, 'different snapshot => different key');
    const id = randomUUID();
    assert.equal(
      billingVerifiedTransactionIdempotencyKey({ provider: 'paystack', providerReference: 've-chk-abc', pricingSnapshotId: id }),
      billingVerifiedTransactionIdempotencyKey({ provider: 'paystack', providerReference: 've-chk-abc', pricingSnapshotId: id }),
    );
    assert.match(a, /^[0-9a-f]{64}$/);
    // The canonical string is fixed order.
    const canonical = billingPaymentEvidenceIdempotencyCanonicalString({ provider: 'paystack', providerReference: 've-chk-abc', pricingSnapshotId: id });
    assert.equal(canonical, `billing-verified-transaction/v1|paystack|ve-chk-abc|${id}`);
  });

  it('evidenceHash is deterministic per verified facts', () => {
    const ref = `ve-chk-${'a'.repeat(64)}`;
    const v = verified(ref);
    const h1 = billingVerifiedTransactionEvidenceHash(v);
    const h2 = billingVerifiedTransactionEvidenceHash(v);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
    const v2 = verified(ref, { paymentAmountMinor: v.paymentAmountMinor + 1 });
    assert.notEqual(h1, billingVerifiedTransactionEvidenceHash(v2));
  });
});

describe('Step 7 — durable evidence store: insert, lookup, idempotent replay, concurrent safe, conflicting fails closed', () => {
  it('inserts one evidence row and finds it by reference and by idempotencyKey', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    const reference = `ve-chk-${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '').slice(0, 32)}`.slice(0, 70);
    // Ensure reference shape is 64 hex style but we use ve-chk- prefix; pad to valid length.
    const ref = `ve-chk-${'d'.repeat(64)}`.slice(0, 70);
    // Use unique ref per test
    const uniqueRef = `ve-chk-${randomUUID().replaceAll('-', '').slice(0, 16)}${'e'.repeat(48)}`;
    const v = verified(uniqueRef, { paymentAmountMinor: Number(snapshot.snapshot.payment.paymentAmountMinor) });
    const store = new BillingVerifiedTransactionStore(db.pool);
    const inserted = await store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v });
    assert.ok(billingPaymentEvidenceSchema.safeParse(inserted).success, 'stored row satisfies contract');
    assert.equal(inserted.provider, 'paystack');
    assert.equal(inserted.providerDomain, 'test');
    assert.equal(inserted.paymentCurrency, 'GHS');
    assert.equal(inserted.paymentAmountExponent, 2);
    assert.equal(inserted.paymentAmountMinor, v.paymentAmountMinor);
    assert.equal(inserted.providerReference, uniqueRef);
    assert.equal(inserted.userId, user.id);
    assert.equal(inserted.subscriptionId, subscriptionId);
    assert.equal(inserted.pricingSnapshotId, snapshot.id);
    assert.match(inserted.evidenceHash, /^[0-9a-f]{64}$/);
    assert.match(inserted.idempotencyKey, /^[0-9a-f]{64}$/);
    // No card/secrets columns: the row has no authorization, bin, last4, etc.
    const raw = (await db.pool.query('SELECT * FROM billing_verified_transactions WHERE provider_reference = $1', [uniqueRef])).rows[0] as Record<string, unknown>;
    assert.ok(!Object.hasOwn(raw, 'authorization_code'));
    assert.ok(!Object.hasOwn(raw, 'card_type'));
    assert.ok(!Object.hasOwn(raw, 'bin'));
    assert.ok(!Object.hasOwn(raw, 'last4'));

    const byRef = await store.findByProviderReference(uniqueRef);
    assert.deepEqual(byRef, inserted);
    const byKey = await store.findByIdempotencyKey(inserted.idempotencyKey);
    assert.deepEqual(byKey, inserted);
    const byId = await store.findById(inserted.id);
    assert.deepEqual(byId, inserted);
  });

  it('idempotent replay with SAME facts returns the same row (no duplicate)', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    const uniqueRef = `ve-chk-${randomUUID().replaceAll('-', '').slice(0, 16)}${'f'.repeat(48)}`;
    const v = verified(uniqueRef, { paymentAmountMinor: Number(snapshot.snapshot.payment.paymentAmountMinor) });
    const store = new BillingVerifiedTransactionStore(db.pool);
    const first = await store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v });
    const second = await store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v });
    assert.deepEqual(second, first);
    assert.equal(second.id, first.id);
    const count = (await db.pool.query('SELECT COUNT(*)::int AS c FROM billing_verified_transactions WHERE provider_reference = $1', [uniqueRef])).rows[0] as { c: number };
    assert.equal(count.c, 1);
  });

  it('concurrent inserts for the same transaction are safe: first writer wins, loser returns winner', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    const uniqueRef = `ve-chk-${randomUUID().replaceAll('-', '').slice(0, 16)}${'1'.repeat(48)}`;
    const v = verified(uniqueRef, { paymentAmountMinor: Number(snapshot.snapshot.payment.paymentAmountMinor) });
    const storeA = new BillingVerifiedTransactionStore(db.pool);
    const storeB = new BillingVerifiedTransactionStore(db.pool);
    const [a, b] = await Promise.all([
      storeA.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v }),
      storeB.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v }),
    ]);
    assert.equal(a.id, b.id);
    assert.deepEqual(a, b);
    const count = (await db.pool.query('SELECT COUNT(*)::int AS c FROM billing_verified_transactions WHERE provider_reference = $1', [uniqueRef])).rows[0] as { c: number };
    assert.equal(count.c, 1);
  });

  it('conflicting evidence for the same reference (different amount) fails closed with conflict', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    const uniqueRef = `ve-chk-${randomUUID().replaceAll('-', '').slice(0, 16)}${'2'.repeat(48)}`;
    const amount = Number(snapshot.snapshot.payment.paymentAmountMinor);
    const v1 = verified(uniqueRef, { paymentAmountMinor: amount });
    const v2 = verified(uniqueRef, { paymentAmountMinor: amount + 1 });
    const store = new BillingVerifiedTransactionStore(db.pool);
    const first = await store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v1 });
    assert.ok(first.id);
    await assert.rejects(
      () => store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v2 }),
      (error: unknown) => {
        assert.ok(isBillingVerifiedTransactionError(error), `expected BillingVerifiedTransactionError, got ${String(error)}`);
        assert.equal((error as { reason: string }).reason, 'conflict');
        assert.ok(!(error as Error).message.includes('sk_test_'));
        return true;
      },
    );
    const count = (await db.pool.query('SELECT COUNT(*)::int AS c FROM billing_verified_transactions WHERE provider_reference = $1', [uniqueRef])).rows[0] as { c: number };
    assert.equal(count.c, 1, 'the conflicting observation did not overwrite');
    const existing = await store.findByProviderReference(uniqueRef);
    assert.equal(existing!.paymentAmountMinor, amount);
  });

  it('conflicting evidence for the same idempotency key but different facts fails closed', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    const uniqueRef = `ve-chk-${randomUUID().replaceAll('-', '').slice(0, 16)}${'3'.repeat(48)}`;
    const amount = Number(snapshot.snapshot.payment.paymentAmountMinor);
    const v1 = verified(uniqueRef, { paymentAmountMinor: amount, paidAt: PAID_AT });
    const v2 = verified(uniqueRef, { paymentAmountMinor: amount, paidAt: '2026-09-24T11:00:00.000Z' });
    const store = new BillingVerifiedTransactionStore(db.pool);
    await store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v1 });
    await assert.rejects(() => store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v2 }), (error: unknown) => {
      assert.ok(isBillingVerifiedTransactionError(error));
      assert.equal((error as { reason: string }).reason, 'conflict');
      return true;
    });
  });

  it('refuses non-test domain and non-GHS currency at the service boundary', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    const uniqueRef = `ve-chk-${randomUUID().replaceAll('-', '').slice(0, 16)}${'4'.repeat(48)}`;
    const store = new BillingVerifiedTransactionStore(db.pool);
    const badDomain = verified(uniqueRef, { providerDomain: 'live' as unknown as 'test' });
    await assert.rejects(() => store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: badDomain }), (e: unknown) => {
      assert.ok(isBillingVerifiedTransactionError(e));
      assert.equal((e as { reason: string }).reason, 'invalid_input');
      return true;
    });
    const badCurrency = verified(uniqueRef, { paymentCurrency: 'USD' as unknown as 'GHS' }) as unknown as BillingVerifiedTransaction;
    await assert.rejects(() => store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: badCurrency }), (e: unknown) => {
      assert.ok(isBillingVerifiedTransactionError(e));
      return true;
    });
  });

  it('the table is append-only: UPDATE and DELETE are refused by trigger', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    const uniqueRef = `ve-chk-${randomUUID().replaceAll('-', '').slice(0, 16)}${'5'.repeat(48)}`;
    const v = verified(uniqueRef, { paymentAmountMinor: Number(snapshot.snapshot.payment.paymentAmountMinor) });
    const store = new BillingVerifiedTransactionStore(db.pool);
    const row = await store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v });
    await assert.rejects(db.pool.query(`UPDATE billing_verified_transactions SET payment_amount_minor = 999 WHERE id = $1`, [row.id]), (e: unknown) => {
      assert.ok(String((e as Error).message).toLowerCase().includes('append-only'));
      return true;
    });
    await assert.rejects(db.pool.query(`DELETE FROM billing_verified_transactions WHERE id = $1`, [row.id]), (e: unknown) => {
      assert.ok(String((e as Error).message).toLowerCase().includes('never deleted'));
      return true;
    });
  });

  it('credential-shaped material is refused by CHECK constraint', async () => {
    const { user, snapshot, subscriptionId } = await setupContext();
    // Use a value that definitely matches the credential regex: contains 'secret'
    const credentialRef = `my_secret_value_${randomUUID().replaceAll('-', '').slice(0, 8)}` as unknown as string;
    await assert.rejects(
      db.pool.query(
        `INSERT INTO billing_verified_transactions (user_id, subscription_id, pricing_snapshot_id, provider, provider_reference, payment_amount_minor, payment_currency, payment_amount_exponent, provider_status, provider_domain, paid_at, verified_at, evidence_hash, idempotency_key)
         VALUES ($1,$2,$3,'paystack',$4,100,'GHS',2,'success','test', now(), now(), '${'a'.repeat(64)}', '${'b'.repeat(64)}')`,
        [user.id, subscriptionId, snapshot.id, credentialRef],
      ),
      (e: unknown) => {
        assert.ok(String((e as Error).message).length > 0);
        // Must mention the constraint or be a CHECK violation
        assert.ok(String((e as Error).message).toLowerCase().includes('check') || String((e as Error).message).includes('23514') || String((e as Error).message).toLowerCase().includes('secret') || String((e as Error).message).toLowerCase().includes('credential'));
        return true;
      },
    );
    // Also ensure the store's zod layer refuses credential-shaped verified objects before DB
    const v = verified(`ve-chk-${'6'.repeat(64)}`, { providerReference: credentialRef as unknown as string, paymentAmountMinor: Number(snapshot.snapshot.payment.paymentAmountMinor) } as unknown as Partial<BillingVerifiedTransaction>);
    const store = new BillingVerifiedTransactionStore(db.pool);
    await assert.rejects(() => store.record({ userId: user.id, subscriptionId, pricingSnapshotId: snapshot.id, verified: v }), (e: unknown) => {
      assert.ok(isBillingVerifiedTransactionError(e) || String((e as Error).message).length > 0);
      return true;
    });
  });
});
