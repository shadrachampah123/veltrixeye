'use client';

import * as React from 'react';
import Link from 'next/link';
import type { AlertDto } from '@veltrixeye/contracts';
import { Badge, Button, Card, CardHeader, Monospace } from '@/components/ui';
import {
  alertStatusLabel,
  alertStatusTone,
  gradeTone,
  isAcknowledged,
  readAlertBody,
  triggerStateLabel,
} from '@/lib/alerts-view';
import { formatDateTime } from '@/lib/formats';
import { StubDeliveryHint } from '@/components/stub-delivery-notice';

/** Alert list (M6 Phase 4) — the caller's own alerts, newest first. */
export function AlertsTable({ alerts }: { alerts: readonly AlertDto[] }) {
  if (alerts.length === 0) {
    return (
      <Card className="px-6 py-14 text-center">
        <p className="text-sm text-ink-300">No alerts match this view.</p>
        <p className="mt-1 text-xs text-ink-400">
          Alerts are generated explicitly from one of your setups in the <em>confirmed</em> or <em>triggered</em> state
          whose quality score meets the version’s minimum. Use “Generate from a setup” below.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={`Alerts (${alerts.length})`} subtitle="Newest first — generated from your own setups" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <caption className="sr-only">Your generated setup alerts with trigger state, score and status</caption>
          <thead>
            <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <th scope="col" className="px-5 py-2.5 font-medium">Alert</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Instrument</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Trigger</th>
              <th scope="col" className="px-5 py-2.5 font-medium text-right">Score</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Acknowledged</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Created</th>
              <th scope="col" className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-750">
            {alerts.map((alert) => {
              const body = readAlertBody(alert.body);
              return (
                <tr key={alert.id} className="transition-colors hover:bg-ink-750/50">
                  <td className="max-w-72 px-5 py-3">
                    <Link href={`/alerts/${alert.id}`} className="block truncate font-medium text-ink-50 hover:text-signal-400">
                      {alert.title}
                    </Link>
                    <div className="mt-0.5 text-[11px] text-ink-500">
                      v{alert.versionNumber} · {alert.direction}
                    </div>
                  </td>
                  <td className="px-5 py-3">
                    <Monospace>{alert.instrument.symbol}</Monospace>
                    <div className="mt-0.5 text-[11px] text-ink-500">{alert.instrument.assetClass}</div>
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone="info">{triggerStateLabel(alert.triggerState)}</Badge>
                  </td>
                  <td className="px-5 py-3 text-right font-mono text-xs text-ink-200">
                    {alert.qualityScore}
                    {body.qualityGrade && (
                      <span className="ml-1.5">
                        <Badge tone={gradeTone(body.qualityGrade)}>{body.qualityGrade}</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <Badge tone={alertStatusTone(alert.status)}>{alertStatusLabel(alert.status)}</Badge>
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-400">
                    {isAcknowledged(alert) ? formatDateTime(alert.acknowledgedAt) : '—'}
                  </td>
                  <td className="px-5 py-3 text-xs text-ink-400">{formatDateTime(alert.createdAt)}</td>
                  <td className="px-5 py-3 text-right">
                    <Link href={`/alerts/${alert.id}`} className="text-xs text-signal-400 hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-ink-700 px-5 py-3">
        <StubDeliveryHint />
      </div>
    </Card>
  );
}

/** Empty state used when the caller has never generated an alert. */
export function AlertsNeverGeneratedState({ onGoToGenerator }: { onGoToGenerator?: () => void }) {
  return (
    <Card className="px-6 py-14 text-center">
      <p className="text-sm text-ink-300">You have not generated any alerts yet.</p>
      <p className="mx-auto mt-1 max-w-lg text-xs text-ink-400">
        An alert is created explicitly from one of your setups — there is no background scanner in this milestone, so
        nothing is generated for you automatically.
      </p>
      {onGoToGenerator && (
        <div className="mt-4">
          <Button variant="secondary" onClick={onGoToGenerator}>
            Go to “Generate from a setup”
          </Button>
        </div>
      )}
    </Card>
  );
}
