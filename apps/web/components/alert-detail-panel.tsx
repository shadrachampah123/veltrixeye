'use client';

import * as React from 'react';
import Link from 'next/link';
import type { AlertDeliveryDto, AlertDto } from '@veltrixeye/contracts';
import { Alert, Badge, Button, Card, CardHeader, Monospace } from '@/components/ui';
import {
  acknowledgeControlState,
  alertStatusLabel,
  alertStatusTone,
  deliveryChannelLabel,
  deliveryStatusTone,
  describeDelivery,
  gradeTone,
  readAlertBody,
  triggerStateLabel,
} from '@/lib/alerts-view';
import { formatDateTime, formatPrice } from '@/lib/formats';
import { StubDeliveryNotice } from '@/components/stub-delivery-notice';

/**
 * Alert detail (M6 Phase 4).
 *
 * Presentational and fully prop-driven so the acknowledgement states (idle,
 * in-flight, already-acknowledged) can be asserted in tests. The acknowledge
 * control is disabled while a request is in flight and permanently once the
 * API reports the alert as acknowledged — the API is idempotent, and the UI
 * never re-offers an action it knows is already done.
 */
export interface AlertDetailPanelProps {
  alert: AlertDto;
  deliveries: readonly AlertDeliveryDto[];
  /** True while the acknowledge request is in flight. */
  acknowledging: boolean;
  /** Safe, API-sourced message for a failed acknowledgement. */
  error: string | null;
  /** One-off confirmation shown after a successful acknowledge. */
  notice: string | null;
  onAcknowledge: () => void;
}

export function AlertDetailPanel(props: AlertDetailPanelProps) {
  const { alert, deliveries, acknowledging, error, notice, onAcknowledge } = props;
  const body = readAlertBody(alert.body);
  const ack = acknowledgeControlState(alert, acknowledging);

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger" title="Could not acknowledge">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <CardHeader
          title={alert.title}
          subtitle={`${alert.instrument.symbol} (${alert.instrument.assetClass}) · ${alert.direction} · version ${alert.versionNumber}`}
          actions={
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone="info">{triggerStateLabel(alert.triggerState)}</Badge>
              <Badge tone={alertStatusTone(alert.status)}>{alertStatusLabel(alert.status)}</Badge>
            </div>
          }
        />
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={onAcknowledge} disabled={ack.disabled} aria-disabled={ack.disabled}>
              {ack.label}
            </Button>
            {ack.reason && <span className="text-xs text-ink-400">{ack.reason}</span>}
            {alert.acknowledgedAt && (
              <span className="text-xs text-ink-400">Acknowledged {formatDateTime(alert.acknowledgedAt)}</span>
            )}
          </div>

          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <DetailItem label="Trigger state" value={triggerStateLabel(alert.triggerState)} />
            <DetailItem label="Quality score" value={`${alert.qualityScore} / 100`} />
            <DetailItem
              label="Grade"
              value={body.qualityGrade ?? '—'}
              badge={body.qualityGrade ? gradeTone(body.qualityGrade) : undefined}
            />
            <DetailItem label="Minimum score gate" value={String(alert.minQualityScore)} />
            <DetailItem label="Direction" value={alert.direction} />
            <DetailItem label="Entry" value={formatPrice(body.entryPrice)} />
            <DetailItem label="Stop loss" value={formatPrice(body.stopLossPrice)} />
            <DetailItem
              label="Targets"
              value={`${formatPrice(body.tp1Price)} / ${formatPrice(body.tp2Price)} / ${formatPrice(body.tp3Price)}`}
            />
            <DetailItem label="Setup detected" value={body.detectedAt ? formatDateTime(body.detectedAt) : '—'} />
            <DetailItem label="Alert created" value={formatDateTime(alert.createdAt)} />
            <DetailItem label="Score row" value={body.scoreId === null ? '—' : `#${body.scoreId}`} />
            <DetailItem label="Score engine" value={body.scoreEngineVersion ?? '—'} />
          </dl>

          <div className="flex flex-wrap gap-4 border-t border-ink-700 pt-3 text-[11px] text-ink-400">
            <span>
              Setup <Monospace>{alert.setupId}</Monospace>
            </span>
            <span>
              Strategy <Monospace>{alert.strategyId}</Monospace>
            </span>
            <Link href={`/strategies/${alert.strategyId}`} className="text-signal-400 hover:underline">
              Open strategy
            </Link>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Delivery ledger"
          subtitle="Append-only record of what the platform did with this alert"
        />
        {deliveries.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-400">
            No delivery rows were returned for this alert.
          </p>
        ) : (
          <ul className="divide-y divide-ink-750">
            {deliveries.map((d) => (
              <li key={d.id} className="px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={deliveryStatusTone(d.status)}>{d.status}</Badge>
                  <span className="text-sm text-ink-100">{deliveryChannelLabel(d.channel)}</span>
                  <span className="text-xs text-ink-500">attempt {d.attempt}</span>
                  <span className="text-xs text-ink-500">{formatDateTime(d.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-ink-300">{describeDelivery(d)}</p>
                <p className="mt-1 text-[11px] text-ink-500">
                  Payload hash <Monospace>{d.payloadHash}</Monospace>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <StubDeliveryNotice />
    </div>
  );
}

function DetailItem({
  label,
  value,
  badge,
}: {
  label: string;
  value: string;
  badge?: 'success' | 'info' | 'warning' | 'neutral';
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-ink-100">{badge ? <Badge tone={badge}>{value}</Badge> : value}</dd>
    </div>
  );
}
