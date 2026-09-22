import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BillingPricingSnapshotStore, pricingIdempotencyKey } from '../src/index.js';
import { deriveSnapshot, insertEpoch, startBillingTestDb } from './helpers/billing-checkout.js';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let store: BillingPricingSnapshotStore;
let facts: Awaited<ReturnType<typeof insertEpoch>>;
before(async () => {
  db = await startBillingTestDb(5490);
  store = new BillingPricingSnapshotStore(db.pool);
  facts = await insertEpoch(db.pool);
}, { timeout: 180_000 });
after(async () => { await db?.stop(); });

test('persists the complete snapshot including reference and computedAt, and reads by either identity', async () => {
  const snapshot = { ...deriveSnapshot(facts), providerReference: 've-audit-reference' };
  const stored = await store.create(snapshot);
  assert.deepEqual(stored.snapshot, snapshot);
  assert.equal(stored.idempotencyKey, pricingIdempotencyKey(snapshot));
  assert.deepEqual(await store.findById(stored.id), stored);
  assert.deepEqual(await store.findByIdempotencyKey(stored.idempotencyKey), stored);
  assert.equal(await store.findById(randomUUID()), null);
  assert.equal(await store.findByIdempotencyKey('0'.repeat(64)), null);
});

test('retries and concurrent inserts collapse onto the first immutable snapshot', async () => {
  const snapshot = deriveSnapshot(facts);
  const original = await store.findByIdempotencyKey(pricingIdempotencyKey(snapshot));
  assert.ok(original);
  const results = await Promise.all(Array.from({ length: 10 }, (_, n) => store.create({
    ...snapshot, computedAt: new Date(Date.parse(snapshot.computedAt) + n * 1000).toISOString(),
  })));
  for (const result of results) assert.deepEqual(result, original);
  const count = await db.pool.query('SELECT count(*) FROM billing_pricing_snapshots');
  assert.equal(count.rows[0].count, '1');
  await assert.rejects(db.pool.query('UPDATE billing_pricing_snapshots SET provider_reference=$1 WHERE id=$2', ['changed', original.id]),
    /append-only/);
});

test('refuses invalid inputs and malformed/tampered returned rows', async () => {
  const snapshot = deriveSnapshot(facts);
  await assert.rejects(store.create({ ...snapshot, payment: { ...snapshot.payment, paymentAmountMinor: 1 } }));
  const { rows } = await db.pool.query('SELECT * FROM billing_pricing_snapshots LIMIT 1');
  for (const changed of [
    { payment_amount_minor: '12345' }, { idempotency_key: '0'.repeat(64) },
    { fx_rate_scaled: '9007199254740993' }, { catalogue_plan: 'unknown' },
    { provider: 'other' }, { created_at: 'invalid' },
  ]) {
    // Read-boundary fault injection only; the database trigger is never disabled.
    const broken = new BillingPricingSnapshotStore({ query: async () => ({ rows: [{ ...rows[0], ...changed }] }) } as never);
    await assert.rejects(broken.findById(rows[0].id));
    await assert.rejects(broken.findByIdempotencyKey(rows[0].idempotency_key));
    await assert.rejects(broken.create(snapshot));
  }
});

test('simultaneous first INSERTs return the same winner, including the no-return conflict path', async () => {
  const snapshot = { ...deriveSnapshot(facts), providerPlanId: 'PLN_snapshot_race' };
  const results = await Promise.all(Array.from({ length: 8 }, () => store.create(snapshot)));
  for (const result of results) assert.deepEqual(result, results[0]);
  const rows = await db.pool.query('SELECT * FROM billing_pricing_snapshots WHERE idempotency_key=$1', [pricingIdempotencyKey(snapshot)]);
  assert.equal(rows.rowCount, 1);
});
