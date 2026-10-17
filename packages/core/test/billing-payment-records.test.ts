import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { readBillingVerifiedPaymentRecords } from '../src/index.js';

const USER_ID = 'df63a1c6-2f5f-4589-92c7-f07ef80be1dc';
const FIRST_PAID_AT = new Date('2026-10-16T10:00:00.000Z');
const FIRST_VERIFIED_AT = new Date('2026-10-16T10:01:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    payment_amount_minor: '12345',
    payment_currency: 'GHS',
    payment_amount_exponent: 2,
    paid_at: FIRST_PAID_AT,
    verified_at: FIRST_VERIFIED_AT,
    ...overrides,
  };
}

function stubPool(rows: unknown[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('verified-payment reader maps only stored GHS amount and instants', async () => {
  const { pool, calls } = stubPool([row()]);
  const result = await readBillingVerifiedPaymentRecords(pool, USER_ID, 'test');

  assert.deepEqual(result, {
    state: 'available',
    mode: 'test',
    records: [{
      amountMinor: 12_345,
      currency: 'GHS',
      exponent: 2,
      paidAt: '2026-10-16T10:00:00.000Z',
      verifiedAt: '2026-10-16T10:01:00.000Z',
    }],
    hasMore: false,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /FROM billing_verified_transactions/);
  assert.match(calls[0]!.sql, /WHERE user_id = \$1 AND provider = \$2 AND provider_domain = \$3/);
  assert.match(calls[0]!.sql, /ORDER BY paid_at DESC, verified_at DESC, id DESC/);
  assert.match(calls[0]!.sql, /LIMIT \$4/);
  assert.match(
    calls[0]!.sql,
    /SELECT payment_amount_minor, payment_currency, payment_amount_exponent, paid_at, verified_at/,
    'the query projects only displayable stored facts',
  );
  assert.doesNotMatch(
    calls[0]!.sql,
    /SELECT \*|provider_reference|provider_customer|pricing_snapshot|evidence_hash|idempotency_key/i,
    'sensitive references, identities and pricing facts are not selected',
  );
  assert.deepEqual(calls[0]!.params, [USER_ID, 'paystack', 'test', 26]);
  assert.deepEqual(Object.keys(result.records[0]!).sort(), [
    'amountMinor', 'currency', 'exponent', 'paidAt', 'verifiedAt',
  ]);
});

test('verified-payment reader bounds the result and flags older records', async () => {
  const rows = Array.from({ length: 26 }, (_, index) => row({
    paid_at: new Date(FIRST_PAID_AT.getTime() + index * 1000),
    verified_at: new Date(FIRST_VERIFIED_AT.getTime() + index * 1000),
  }));
  const { pool } = stubPool([...rows].reverse());
  const result = await readBillingVerifiedPaymentRecords(pool, USER_ID, 'live');

  assert.equal(result.state, 'available');
  if (result.state !== 'available') assert.fail('expected an available response');
  assert.equal(result.mode, 'live');
  assert.equal(result.records.length, 25);
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.records.map((record) => record.paidAt),
    rows.slice(1).reverse().map((record) => (record.paid_at as Date).toISOString()),
    'the query result is already newest-first and the extra row is not returned',
  );
});

test('malformed or unsafe stored values fail closed without exposing the row', async () => {
  const { pool } = stubPool([row({
    payment_amount_minor: '9007199254740992',
    provider_reference: 'sensitive-checkout-reference',
  })]);
  await assert.rejects(
    readBillingVerifiedPaymentRecords(pool, USER_ID, 'test'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not usable by the read-only view/);
      assert.doesNotMatch(error.message, /sensitive-checkout-reference|9007199254740992/);
      return true;
    },
  );
});
