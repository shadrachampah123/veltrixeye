'use client';

import * as React from 'react';
import Link from 'next/link';
import type { SetupDto } from '@veltrixeye/contracts';
import { Badge, Card } from '@/components/ui';
import { formatDateTime, formatPrice } from '@/lib/formats';
import { setupStateLabel, setupStateTone } from '@/lib/workbench';
import { TimeframeBadge } from '@/components/timeframe-workflow';

function calculateRR(entry: number | null, sl: number | null, tp: number | null): string {
  if (entry === null || sl === null || tp === null) return '—';
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return '—';
  return (reward / risk).toFixed(2) + 'R';
}

function qualityTone(score: number | null): 'success' | 'info' | 'warning' | 'neutral' {
  if (score === null) return 'neutral';
  if (score >= 75) return 'success';
  if (score >= 50) return 'info';
  if (score >= 25) return 'warning';
  return 'neutral';
}

export interface SetupCardProps {
  setup: SetupDto;
  showTimeframes?: boolean;
}

export function SetupCard({ setup, showTimeframes = false }: SetupCardProps) {
  const rr1 = calculateRR(setup.entryPrice, setup.stopLossPrice, setup.tp1Price);
  const rr2 = calculateRR(setup.entryPrice, setup.stopLossPrice, setup.tp2Price);

  return (
    <Card className="group relative overflow-hidden transition-all hover:border-ink-600 hover:shadow-lg hover:shadow-black/20">
      <div className="absolute left-0 top-0 h-full w-0.5 bg-ink-700 group-hover:bg-signal-600/60" />

      <div className="p-4">
        {/* Header: market + direction + status */}
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-ink-50">{setup.instrument.symbol}</span>
              <Badge tone={setup.direction === 'long' ? 'success' : 'danger'}>{setup.direction}</Badge>
              <span className="text-[11px] capitalize text-ink-400">{setup.instrument.assetClass}</span>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone={setupStateTone(setup.state)}>{setupStateLabel(setup.state)}</Badge>
              {setup.qualityScore !== null && <Badge tone={qualityTone(setup.qualityScore)}>Q {setup.qualityScore}</Badge>}
            </div>
          </div>
          <Link
            href={`/setups/${setup.id}`}
            className="shrink-0 rounded-md bg-ink-700 px-2.5 py-1 text-xs font-medium text-ink-200 transition-colors hover:bg-ink-600 hover:text-ink-50"
          >
            Detail
          </Link>
        </div>

        {/* Levels: Entry, SL, TP, RR */}
        <div className="mb-3 grid grid-cols-3 gap-2 rounded-md bg-ink-850/70 p-2.5">
          <div>
            <div className="text-[9px] uppercase tracking-wider text-ink-500">Entry</div>
            <div className="font-mono text-xs font-medium text-ink-100">{formatPrice(setup.entryPrice)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-ink-500">Stop Loss</div>
            <div className="font-mono text-xs font-medium text-danger-450">{formatPrice(setup.stopLossPrice)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-ink-500">TP1 / R:R</div>
            <div className="font-mono text-xs font-medium text-signal-400">
              {formatPrice(setup.tp1Price)} <span className="text-[10px] text-ink-400">· {rr1}</span>
            </div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-ink-500">TP2</div>
            <div className="font-mono text-xs text-ink-300">{formatPrice(setup.tp2Price)} <span className="text-[10px] text-ink-500">· {rr2}</span></div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-ink-500">TP3</div>
            <div className="font-mono text-xs text-ink-300">{formatPrice(setup.tp3Price)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase tracking-wider text-ink-500">Version</div>
            <div className="font-mono text-xs text-ink-400">v{setup.versionNumber}</div>
          </div>
        </div>

        {/* Timeframes if available via metadata? Show generic workflow hint */}
        {showTimeframes && (
          <div className="mb-3 flex gap-1">
            <TimeframeBadge role="htf_bias" timeframe="1d" />
            <TimeframeBadge role="setup" timeframe="1h" />
            <TimeframeBadge role="entry" timeframe="15m" />
          </div>
        )}

        {/* Footer: detected + conditions summary */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-ink-500">Detected {formatDateTime(setup.detectedAt)}</span>
          <span className="text-ink-400">
            {setup.qualityScore === null ? 'Not scored' : `Quality ${setup.qualityScore}`}
          </span>
        </div>

        {/* Quality/conditions hint */}
        <div className="mt-2 text-[10px] text-ink-500">
          Anchor: {new Date(setup.asOfMs).toISOString().slice(0, 16).replace('T', ' ')} UTC
        </div>
      </div>
    </Card>
  );
}

export function SetupCardGrid({ setups, emptyMessage }: { setups: SetupDto[]; emptyMessage?: string }) {
  if (setups.length === 0) {
    return (
      <Card className="px-6 py-12 text-center">
        <p className="text-sm text-ink-300">{emptyMessage ?? 'No setups yet.'}</p>
        <p className="mt-1 text-xs text-ink-400">Run detection from the workbench at an explicit anchor to create setups.</p>
      </Card>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {setups.map((s) => (
        <SetupCard key={s.id} setup={s} />
      ))}
    </div>
  );
}

export function SetupDetailLevels({ setup }: { setup: SetupDto }) {
  const rr1 = calculateRR(setup.entryPrice, setup.stopLossPrice, setup.tp1Price);
  const rr2 = calculateRR(setup.entryPrice, setup.stopLossPrice, setup.tp2Price);
  const rr3 = calculateRR(setup.entryPrice, setup.stopLossPrice, setup.tp3Price);

  const rows = [
    { label: 'Market', value: `${setup.instrument.symbol} · ${setup.instrument.assetClass}`, mono: true },
    { label: 'Direction', value: setup.direction, badge: setup.direction === 'long' ? 'success' as const : 'danger' as const },
    { label: 'Status', value: setupStateLabel(setup.state), tone: setupStateTone(setup.state) },
    { label: 'Timeframe', value: 'HTF→Setup→Entry workflow (see strategy version)', mono: false },
    { label: 'Entry Price', value: formatPrice(setup.entryPrice), mono: true },
    { label: 'Stop Loss', value: formatPrice(setup.stopLossPrice), mono: true },
    { label: 'TP1', value: `${formatPrice(setup.tp1Price)} · ${rr1}`, mono: true },
    { label: 'TP2', value: `${formatPrice(setup.tp2Price)} · ${rr2}`, mono: true },
    { label: 'TP3', value: `${formatPrice(setup.tp3Price)} · ${rr3}`, mono: true },
    { label: 'R/R (TP1)', value: rr1, mono: true },
    { label: 'Quality Score', value: setup.qualityScore === null ? 'Not scored' : String(setup.qualityScore), mono: true },
    { label: 'Conditions', value: setup.qualityScore === null ? 'Score to see condition breakdown' : 'See quality panel for component scores', mono: false },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => {
        const r = row as any;
        return (
          <div key={r.label} className="rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-400">{r.label}</div>
            <div className={`mt-1 text-sm ${r.mono ? 'font-mono' : ''} text-ink-100`}>
              {r.badge ? <Badge tone={r.badge}>{r.value}</Badge> : r.tone ? <Badge tone={r.tone}>{r.value}</Badge> : r.value}
            </div>
          </div>
        );
      })}
    </div>
  );
}
