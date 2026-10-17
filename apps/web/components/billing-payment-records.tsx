'use client';

import * as React from 'react';
import { Badge, Card, CardHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/formats';
import type {
  BillingVerifiedPaymentRecordDto,
  BillingVerifiedPaymentRecordsDto,
} from '@veltrixeye/contracts';

/**
 * Billing Step 9b-R1 — display-only view of the server's bounded,
 * session-scoped verified-payment records answer. It performs no fetch and
 * offers no billing action; only stored evidence reaches the component.
 */
export interface BillingPaymentRecordsPanelProps {
  records: BillingVerifiedPaymentRecordsDto | null;
  unavailable?: boolean;
}

/** Format integer GHS pesewas without converting the amount to a float. */
export function formatGhsMinorUnits(amountMinor: number): string {
  const amount = BigInt(amountMinor);
  const whole = amount / 100n;
  const pesewas = String(amount % 100n).padStart(2, '0');
  const groupedWhole = new Intl.NumberFormat('en-GH', {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(whole);
  return `GHS ${groupedWhole}.${pesewas}`;
}

export function BillingPaymentRecordsPanel({ records, unavailable = false }: BillingPaymentRecordsPanelProps) {
  const header = (
    <CardHeader
      title="Verified Payment Records"
      subtitle="Read-only · the 25 newest verified records"
    />
  );

  if (!records) {
    return (
      <Card>
        {header}
        <div className="px-5 py-5 text-sm text-ink-400">
          {unavailable
            ? 'Verified payment records could not be read. No records are claimed.'
            : 'Loading verified payment records…'}
        </div>
      </Card>
    );
  }

  if (records.state === 'unavailable') {
    return (
      <Card>
        {header}
        <div className="px-5 py-5 text-sm text-ink-400">
          Verified payment records could not be read. No records are claimed.
        </div>
      </Card>
    );
  }

  const modeLabel = records.mode === 'test' ? 'sandbox/test' : 'live';

  return (
    <Card>
      <CardHeader
        title="Verified Payment Records"
        subtitle={`Read-only · ${modeLabel} mode · up to 25 newest records`}
        actions={<Badge tone="neutral">{records.records.length} record{records.records.length === 1 ? '' : 's'}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        <p className="text-xs leading-snug text-ink-300">
          Only transactions verified through VeltrixEye in {modeLabel} mode appear here. This is not a complete invoice,
          renewal, failed-payment, refund or provider-issued receipt history.
        </p>

        {records.records.length === 0 ? (
          <p className="rounded-md border border-ink-700 px-3 py-3 text-sm text-ink-400">
            No verified payment records are available for this account in {modeLabel} mode.
          </p>
        ) : (
          <ol className="divide-y divide-ink-750" aria-label="Verified payment records">
            {records.records.map((record, index) => (
              <PaymentRecordRow key={recordKey(record, index)} record={record} />
            ))}
          </ol>
        )}

        {records.hasMore && (
          <p className="text-[11px] text-ink-500">
            Showing the 25 newest records. Older records are outside this bounded view.
          </p>
        )}

        <div className="rounded-md border border-amber-450/20 bg-amber-450/5 px-3 py-2.5 text-[11px] leading-snug text-ink-400">
          <strong className="text-amber-450">Evidence only:</strong> a verified record does not activate a plan or
          entitlement. Activation remains a separate out-of-band operator action; automation, live execution and broker
          execution remain unavailable.
        </div>
      </div>
    </Card>
  );
}

function recordKey(record: BillingVerifiedPaymentRecordDto, index: number): string {
  // The DTO intentionally carries no row id; index is a presentation-only key.
  return `${record.paidAt}:${record.verifiedAt}:${record.amountMinor}:${index}`;
}

function PaymentRecordRow({ record }: { record: BillingVerifiedPaymentRecordDto }) {
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="font-medium text-ink-100">{formatGhsMinorUnits(record.amountMinor)}</div>
        <div className="mt-1 text-xs text-ink-400">Paid {formatDateTime(record.paidAt)}</div>
        <div className="mt-0.5 text-[11px] text-ink-500">Verified {formatDateTime(record.verifiedAt)}</div>
      </div>
      <Badge tone="success">verified evidence</Badge>
    </li>
  );
}
