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

/**
 * Regression: the minor-unit magnitude check must be TOTAL.
 *
 * `payment_amount_minor` reaches the reader as whatever the driver returned,
 * so it can be any string. Zod keeps evaluating later checks after an earlier
 * one fails (to collect every issue), so a refinement that called
 * `BigInt(value)` directly was reached by values that had already failed the
 * digit-only regex — `"abc"` and `"1.2"` made `BigInt()` throw a `SyntaxError`
 * that escaped `safeParse()` instead of producing a validation failure.
 *
 * The reader throws its own fail-closed error ONLY on
 * `paymentRecordRowSchema.safeParse(raw) === { success: false }`. Reaching
 * exactly that error therefore proves `safeParse` returned `success: false`;
 * any other error name (`SyntaxError`, `RangeError`, …) would mean validation
 * threw instead.
 */
test('a malformed minor-unit string fails closed instead of escaping validation', async () => {
  const malformed: readonly unknown[] = [
    'abc', '1.2', '', '0', '-5', '01', ' 12 ', '1e3', '+7', 'NaN', 'Infinity',
    '0x10', '1_000', 'sk_test_0123456789abcdef0123456789abcdef01234567',
  ];

  for (const amount of malformed) {
    const { pool } = stubPool([row({ payment_amount_minor: amount })]);
    await assert.rejects(
      readBillingVerifiedPaymentRecords(pool, USER_ID, 'test'),
      (error: unknown) => {
        assert.ok(error instanceof Error, 'a failed validation is reported as an Error');
        assert.equal(
          error.name,
          'Error',
          `payment_amount_minor=${JSON.stringify(amount)} escaped validation as ${error.name} ` +
            'instead of returning success: false',
        );
        assert.match(
          error.message,
          /not usable by the read-only view/,
          'the reader fails closed with its own message',
        );
        assert.doesNotMatch(error.message, /BigInt|Cannot convert/i, 'no conversion error leaks');
        return true;
      },
      `payment_amount_minor=${JSON.stringify(amount)} must fail closed`,
    );
  }
});

test('the accepted-amount rules are unchanged: valid amounts accepted, zero/negative/unsafe refused', async () => {
  const accepted: readonly [label: string, amount: unknown, expected: number][] = [
    ['a driver-returned BIGINT string', '12345', 12_345],
    ['an integer number', 12_345, 12_345],
    ['a bigint', 12_345n, 12_345],
    ['the smallest positive amount', '1', 1],
    ['Number.MAX_SAFE_INTEGER', '9007199254740991', 9_007_199_254_740_991],
  ];

  for (const [label, amount, expected] of accepted) {
    const { pool } = stubPool([row({ payment_amount_minor: amount })]);
    const result = await readBillingVerifiedPaymentRecords(pool, USER_ID, 'test');
    assert.equal(result.state, 'available', `${label} stays accepted`);
    if (result.state !== 'available') assert.fail(`expected ${label} to be accepted`);
    assert.equal(result.records[0]?.amountMinor, expected, `${label} keeps its exact value`);
  }

  // Zero, negatives and anything above the safe-integer projection are still refused.
  const refused: readonly [label: string, amount: unknown][] = [
    ['zero number', 0],
    ['zero string', '0'],
    ['negative number', -1],
    ['negative string', '-1'],
    ['negative bigint', -1n],
    ['MAX_SAFE_INTEGER + 1 as a number', 9_007_199_254_740_992],
    ['MAX_SAFE_INTEGER + 1 as a string', '9007199254740992'],
    ['MAX_SAFE_INTEGER + 1 as a bigint', 9_007_199_254_740_992n],
    ['a fractional number', 1.2],
    ['a non-integer number', 12_345.5],
  ];

  for (const [label, amount] of refused) {
    const { pool } = stubPool([row({ payment_amount_minor: amount })]);
    await assert.rejects(
      readBillingVerifiedPaymentRecords(pool, USER_ID, 'test'),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, 'Error', `${label} must fail closed, not throw ${error.name}`);
        assert.match(error.message, /not usable by the read-only view/);
        return true;
      },
      `${label} stays refused`,
    );
  }
});

test('a refused row is never echoed back, whatever its amount looked like', async () => {
  const { pool } = stubPool([row({
    payment_amount_minor: 'sk_test_0123456789abcdef0123456789abcdef01234567',
    provider_reference: 'sensitive-checkout-reference',
  })]);

  await assert.rejects(
    readBillingVerifiedPaymentRecords(pool, USER_ID, 'test'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'Error');
      const message = error.message + JSON.stringify((error as { cause?: unknown }).cause ?? '');
      assert.doesNotMatch(message, /sk_test_|sensitive-checkout-reference/i);
      return true;
    },
  );
});
