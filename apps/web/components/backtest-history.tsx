'use client';

import * as React from 'react';
import Link from 'next/link';
import type { BacktestRunDto } from '@veltrixeye/contracts';
import { Badge, Button, Card, CardHeader, Monospace } from '@/components/ui';
import { directionLabel, formatEpochMsUtc, formatR, formatRate } from '@/lib/backtest-form';
import { formatDateTime } from '@/lib/formats';

/** Backtest history list (M6 Phase 4) — the caller's own runs, newest first. */
export function BacktestHistoryTable({ runs }: { runs: readonly BacktestRunDto[] }) {
  if (runs.length === 0) {
    return (
      <Card className="px-6 py-14 text-center">
        <p className="text-sm text-ink-300">No backtests yet.</p>
        <p className="mt-1 text-xs text-ink-400">
          A backtest replays one of your published strategy versions over stored candles. Nothing is fetched from a
          provider and no live setup is written.
        </p>
        <Link href="/backtests/new" className="mt-4 inline-block">
          <Button>Run your first backtest</Button>
        </Link>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={`Recent runs (${runs.length})`} subtitle="Newest first; identical inputs replay the same run" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <caption className="sr-only">Your backtest runs with headline results</caption>
          <thead>
            <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <th scope="col" className="px-5 py-2.5 font-medium">Instrument</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Version</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Direction</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Range (UTC)</th>
              <th scope="col" className="px-5 py-2.5 font-medium text-right">Trades</th>
              <th scope="col" className="px-5 py-2.5 font-medium text-right">Win rate</th>
              <th scope="col" className="px-5 py-2.5 font-medium text-right">Net R</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Created</th>
              <th scope="col" className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-750">
            {runs.map((run) => (
              <tr key={run.id} className="transition-colors hover:bg-ink-750/50">
                <td className="px-5 py-3">
                  <Link href={`/backtests/${run.id}`} className="font-medium text-ink-50 hover:text-signal-400">
                    <Monospace>{run.instrument.symbol}</Monospace>
                  </Link>
                  <div className="mt-0.5 text-[11px] text-ink-500">{run.instrument.assetClass}</div>
                </td>
                <td className="px-5 py-3 font-mono text-xs text-ink-300">v{run.versionNumber}</td>
                <td className="px-5 py-3 text-xs text-ink-300">{directionLabel(run.direction)}</td>
                <td className="px-5 py-3 font-mono text-[11px] text-ink-400">
                  {formatEpochMsUtc(run.fromMs)}
                  <br />→ {formatEpochMsUtc(run.toMs)}
                </td>
                <td className="px-5 py-3 text-right font-mono text-xs text-ink-200">{run.metrics.tradesClosed}</td>
                <td className="px-5 py-3 text-right font-mono text-xs text-ink-200">{formatRate(run.metrics.winRate)}</td>
                <td className="px-5 py-3 text-right font-mono text-xs">
                  <span className={run.metrics.totalR > 0 ? 'text-signal-400' : run.metrics.totalR < 0 ? 'text-danger-450' : 'text-ink-200'}>
                    {formatR(run.metrics.totalR)}
                  </span>
                </td>
                <td className="px-5 py-3 text-xs text-ink-400">{formatDateTime(run.createdAt)}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    {run.status === 'failed' && <Badge tone="danger">failed</Badge>}
                    <Link href={`/backtests/${run.id}`} className="text-xs text-signal-400 hover:underline">
                      View
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
