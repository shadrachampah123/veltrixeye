'use client';

import * as React from 'react';
import Link from 'next/link';
import type { SetupDto, AlertDto, BacktestRunDto } from '@veltrixeye/contracts';
import { Badge, Card, CardHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/formats';
import { setupStateLabel, setupStateTone } from '@/lib/workbench';

export interface SignalHistoryProps {
  setups: SetupDto[];
  alerts?: AlertDto[];
  backtests?: BacktestRunDto[];
}

export function SignalHistory({ setups, alerts = [], backtests = [] }: SignalHistoryProps) {
  // Combine into timeline sorted by time descending
  const timeline = React.useMemo(() => {
    const items: Array<{ time: string; type: 'setup' | 'alert' | 'backtest'; id: string; label: string; detail: string; href: string }> = [];

    for (const s of setups) {
      items.push({
        time: s.detectedAt,
        type: 'setup',
        id: s.id,
        label: `${s.instrument.symbol} ${s.direction} setup`,
        detail: `v${s.versionNumber} · ${setupStateLabel(s.state)} · Q${s.qualityScore ?? '—'}`,
        href: `/setups/${s.id}`,
      });
    }
    for (const a of alerts) {
      items.push({
        time: a.createdAt,
        type: 'alert',
        id: a.id,
        label: `Alert ${a.status}`,
        detail: `${a.instrument?.symbol ?? '—'} · ${a.direction ?? '—'} · Q ${a.qualityScore ?? '—'}`,
        href: `/alerts/${a.id}`,
      });
    }
    for (const b of backtests) {
      items.push({
        time: b.createdAt,
        type: 'backtest',
        id: b.id,
        label: `Backtest ${b.status}`,
        detail: `${b.instrument.symbol} · ${new Date(b.fromMs).toLocaleDateString()}→${new Date(b.toMs).toLocaleDateString()}`,
        href: `/backtests/${b.id}`,
      });
    }

    return items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 50);
  }, [setups, alerts, backtests]);

  if (timeline.length === 0) {
    return (
      <Card>
        <CardHeader title="Signal History" subtitle="Setup, alert and backtest timeline — newest first" />
        <div className="px-5 py-8 text-center text-sm text-ink-400">No history yet. Run evaluation → detection → scoring to create signals.</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader title={`Signal History (${timeline.length})`} subtitle="Combined timeline — setups, alerts, backtests · newest first" />
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-6 top-0 h-full w-px bg-ink-700 sm:left-8" />

        <ol className="divide-y divide-ink-750">
          {timeline.map((item) => (
            <li key={`${item.type}-${item.id}`} className="relative flex gap-4 px-5 py-3.5 sm:gap-5">
              {/* Dot */}
              <div className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] sm:ml-2 ${
                item.type === 'setup'
                  ? 'border-signal-500/40 bg-signal-500/15 text-signal-400'
                  : item.type === 'alert'
                    ? 'border-info-450/40 bg-info-450/15 text-info-450'
                    : 'border-amber-450/40 bg-amber-450/15 text-amber-450'
              }`}>
                {item.type === 'setup' ? '◉' : item.type === 'alert' ? '◎' : '◫'}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={item.href} className="text-sm font-medium text-ink-50 hover:text-signal-400 hover:underline">
                    {item.label}
                  </Link>
                  <Badge tone={item.type === 'setup' ? 'success' : item.type === 'alert' ? 'info' : 'warning'}>{item.type}</Badge>
                  <span className="text-xs text-ink-500">{formatDateTime(item.time)}</span>
                </div>
                <div className="mt-0.5 text-xs text-ink-400">{item.detail}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

export function SetupHistoryTimeline({ setups }: { setups: SetupDto[] }) {
  const grouped = React.useMemo(() => {
    // Group by date
    const byDate = new Map<string, SetupDto[]>();
    for (const s of setups) {
      const date = new Date(s.detectedAt).toDateString();
      const list = byDate.get(date) ?? [];
      list.push(s);
      byDate.set(date, list);
    }
    return Array.from(byDate.entries()).sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime());
  }, [setups]);

  if (setups.length === 0) {
    return (
      <Card>
        <CardHeader title="Setup History" subtitle="Detected setups grouped by day" />
        <div className="px-5 py-8 text-center text-sm text-ink-400">No setups detected yet.</div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {grouped.map(([date, items]) => (
        <Card key={date}>
          <CardHeader title={date} subtitle={`${items.length} setup${items.length === 1 ? '' : 's'} detected`} />
          <div className="divide-y divide-ink-750">
            {items.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-5 py-3">
                <Badge tone={s.direction === 'long' ? 'success' : 'danger'}>{s.direction}</Badge>
                <span className="font-mono text-sm text-ink-50">{s.instrument.symbol}</span>
                <Badge tone={setupStateTone(s.state)}>{setupStateLabel(s.state)}</Badge>
                <span className="ml-auto text-xs text-ink-400">{formatDateTime(s.detectedAt)}</span>
                <Link href={`/setups/${s.id}`} className="text-xs text-signal-400 hover:underline">
                  Open
                </Link>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
