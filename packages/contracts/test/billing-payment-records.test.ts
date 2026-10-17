import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT,
  UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS,
  billingVerifiedPaymentRecordDtoSchema,
  billingVerifiedPaymentRecordsDtoSchema,
} from '../src/index.js';

const record = {
  amountMinor: 12_345,
  currency: 'GHS',
  exponent: 2,
  paidAt: '2026-10-16T10:00:00.000Z',
  verifiedAt: '2026-10-16T10:01:00.000Z',
} as const;

describe('Billing Step 9b-R1 — strict verified payment records contracts', () => {
  test('a record exposes only the persisted amount and instants', () => {
    assert.deepEqual(billingVerifiedPaymentRecordDtoSchema.parse(record), record);
    assert.deepEqual(Object.keys(record).sort(), ['amountMinor', 'currency', 'exponent', 'paidAt', 'verifiedAt']);
  });

  test('record amounts stay positive, safe integer GHS minor units', () => {
    for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        billingVerifiedPaymentRecordDtoSchema.safeParse({ ...record, amountMinor }).success,
        false,
        `${amountMinor} is not a valid minor-unit amount`,
      );
    }
    assert.equal(billingVerifiedPaymentRecordDtoSchema.safeParse({ ...record, exponent: 3 }).success, false);
    assert.equal(billingVerifiedPaymentRecordDtoSchema.safeParse({ ...record, currency: 'USD' }).success, false);
  });

  test('the available response is mode-scoped, bounded and rejects added identifiers', () => {
    const response = billingVerifiedPaymentRecordsDtoSchema.parse({
      state: 'available', mode: 'test', records: [record], hasMore: false,
    });
    assert.equal(response.state, 'available');
    assert.equal(response.mode, 'test');

    assert.equal(
      billingVerifiedPaymentRecordsDtoSchema.safeParse({
        state: 'available', mode: 'test', records: [{ ...record, id: 'internal-row-id' }], hasMore: false,
      }).success,
      false,
      'unknown identity fields are refused',
    );
    assert.equal(
      billingVerifiedPaymentRecordsDtoSchema.safeParse({
        state: 'available',
        mode: 'test',
        records: Array.from({ length: BILLING_VERIFIED_PAYMENT_RECORDS_LIMIT + 1 }, () => record),
        hasMore: true,
      }).success,
      false,
      'a server response cannot exceed the fixed page limit',
    );
  });

  test('the unavailable response claims no mode, records or older history', () => {
    assert.deepEqual(UNAVAILABLE_BILLING_VERIFIED_PAYMENT_RECORDS, {
      state: 'unavailable', mode: null, records: [], hasMore: false,
    });
    assert.equal(
      billingVerifiedPaymentRecordsDtoSchema.safeParse({
        state: 'unavailable', mode: 'test', records: [record], hasMore: true,
      }).success,
      false,
    );
  });
});
