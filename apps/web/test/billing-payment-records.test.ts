/** Billing Step 9b-R1 — the read-only Verified Payment Records Settings panel. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  billingVerifiedPaymentRecordsDtoSchema,
  type BillingVerifiedPaymentRecordsDto,
} from '@veltrixeye/contracts';
import { BillingPaymentRecordsPanel, formatGhsMinorUnits } from '../components/billing-payment-records';

const record = {
  amountMinor: 12_345,
  currency: 'GHS',
  exponent: 2,
  paidAt: '2026-10-16T10:00:00.000Z',
  verifiedAt: '2026-10-16T10:01:00.000Z',
} as const;

function available(overrides: Partial<Extract<BillingVerifiedPaymentRecordsDto, { state: 'available' }>> = {}) {
  return billingVerifiedPaymentRecordsDtoSchema.parse({
    state: 'available', mode: 'test', records: [record], hasMore: false, ...overrides,
  });
}

function render(
  records: BillingVerifiedPaymentRecordsDto | null,
  props: { unavailable?: boolean } = {},
): string {
  return renderToStaticMarkup(React.createElement(BillingPaymentRecordsPanel, { records, ...props }));
}

const source = readFileSync(
  fileURLToPath(new URL('../components/billing-payment-records.tsx', import.meta.url)),
  'utf8',
);

describe('Verified Payment Records panel', () => {
  test('formats GHS minor units exactly without a floating-point amount', () => {
    assert.equal(formatGhsMinorUnits(12_345), 'GHS 123.45');
    assert.equal(formatGhsMinorUnits(10_000), 'GHS 100.00');
    assert.equal(formatGhsMinorUnits(1), 'GHS 0.01');
    assert.doesNotMatch(source, /amountMinor\s*\/\s*100/, 'no floating-point amount conversion is used');
  });

  test('shows only server-supplied amount and persisted paid/verified instants', () => {
    const markup = render(available());
    assert.match(markup, /Verified Payment Records/);
    assert.match(markup, /GHS 123\.45/);
    assert.match(markup, /Paid/);
    assert.match(markup, /Verified/);
    assert.match(markup, /sandbox\/test mode/);
    assert.match(markup, /Only transactions verified through VeltrixEye/);
    assert.match(markup, /not a complete invoice, renewal, failed-payment, refund or provider-issued receipt history/i);
    assert.match(markup, /Evidence only/);
    assert.match(markup, /out-of-band operator action/);
    assert.match(markup, /automation, live execution and broker execution remain unavailable/i);
    assert.doesNotMatch(markup, /provider_reference|ve-chk-|PLN_|CUS_|SUB_/i);
  });

  test('the records view is capped and discloses when older entries are omitted', () => {
    const markup = render(available({ hasMore: true }));
    assert.match(markup, /Showing the 25 newest records/);
    assert.match(markup, /Older records are outside this bounded view/);
    assert.doesNotMatch(markup, /Load more|Next page|View invoice/i);
  });

  test('live mode is stated from the server response and empty history claims no payment', () => {
    const liveMarkup = render(available({ mode: 'live', records: [] }));
    assert.match(liveMarkup, /live mode/);
    assert.match(liveMarkup, /No verified payment records are available/);
    assert.doesNotMatch(liveMarkup, /GHS 123\.45/);
  });

  test('server-unavailable and request-failure states claim no records', () => {
    const unavailable = billingVerifiedPaymentRecordsDtoSchema.parse({
      state: 'unavailable', mode: null, records: [], hasMore: false,
    });
    for (const markup of [render(unavailable), render(null, { unavailable: true })]) {
      assert.match(markup, /could not be read/);
      assert.match(markup, /No records are claimed/);
      assert.doesNotMatch(markup, /GHS \d/);
    }
    assert.match(render(null), /Loading verified payment records/);
  });

  test('the component has no write/action surface, fetch or billing authority', () => {
    assert.doesNotMatch(source, /<button\b|<a\b|<form\b|<input\b/i);
    assert.doesNotMatch(source, /fetch\s*\(|api\.|checkout|cancelSubscription/i);
    assert.doesNotMatch(source, /paymentConfirmed\s*[:=]\s*true|canAccessAutomation\s*[:=]\s*true/);
  });
});
