'use client';

import * as React from 'react';
import type { StrategyTimeframes, Timeframe } from '@veltrixeye/contracts';
import { TIMEFRAME_ROLE_LABELS } from '@veltrixeye/contracts';

export interface TimeframeWorkflowProps {
  timeframes: StrategyTimeframes | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  showLabels?: boolean;
  interactive?: boolean;
  onSelect?: (role: 'htf_bias' | 'setup' | 'entry', tf: Timeframe) => void;
}

const ROLE_ORDER: Array<{ role: 'htf_bias' | 'setup' | 'entry'; icon: string; color: string }> = [
  { role: 'htf_bias', icon: '◧', color: 'border-info-450/40 bg-info-450/10 text-info-450' },
  { role: 'setup', icon: '◉', color: 'border-signal-500/40 bg-signal-500/10 text-signal-400' },
  { role: 'entry', icon: '◎', color: 'border-amber-450/40 bg-amber-450/10 text-amber-450' },
];

export function TimeframeWorkflow({ timeframes, size = 'md', showLabels = true, interactive = false, onSelect }: TimeframeWorkflowProps) {
  const sm = size === 'sm';
  const lg = size === 'lg';

  if (!timeframes) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed border-ink-600 bg-ink-850/50 px-3 py-2 text-xs text-ink-500">
        <span>HTF → Setup → Entry not configured</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1 ${sm ? 'text-xs' : lg ? 'text-sm' : 'text-[13px]'}`}>
      {ROLE_ORDER.map((item, idx) => {
        const tf = timeframes[item.role] as Timeframe;
        return (
          <React.Fragment key={item.role}>
            <div
              className={`group relative flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 transition-colors ${item.color} ${
                interactive ? 'cursor-pointer hover:brightness-110' : ''
              } ${sm ? 'px-2 py-1' : ''}`}
              title={TIMEFRAME_ROLE_LABELS[item.role]}
              onClick={() => interactive && onSelect?.(item.role, tf)}
            >
              <span className="text-[11px] leading-none">{item.icon}</span>
              <div className="flex flex-col">
                {showLabels && (
                  <span className="text-[9px] font-medium uppercase tracking-wider opacity-80">
                    {item.role === 'htf_bias' ? 'HTF Bias' : item.role === 'setup' ? 'Setup' : 'Entry'}
                  </span>
                )}
                <span className={`font-mono font-semibold leading-none ${sm ? 'text-[11px]' : 'text-xs'}`}>{tf.toUpperCase()}</span>
              </div>
            </div>
            {idx < ROLE_ORDER.length - 1 && (
              <div className="flex items-center px-0.5 text-ink-600">
                <span className={`${sm ? 'text-[10px]' : 'text-xs'}`}>→</span>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function TimeframeWorkflowDetailed({ timeframes }: { timeframes: StrategyTimeframes }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {ROLE_ORDER.map((item) => {
        const tf = timeframes[item.role];
        const isHtf = item.role === 'htf_bias';
        const isSetup = item.role === 'setup';
        return (
          <div key={item.role} className={`rounded-lg border p-3 ${item.color}`}>
            <div className="flex items-center gap-2">
              <span className="text-sm">{item.icon}</span>
              <span className="text-xs font-medium uppercase tracking-wider">{TIMEFRAME_ROLE_LABELS[item.role]}</span>
            </div>
            <div className="mt-2 font-mono text-lg font-semibold">{tf.toUpperCase()}</div>
            <p className="mt-1 text-[11px] leading-snug opacity-80">
              {isHtf
                ? 'Higher-timeframe trend filter — determines directional bias'
                : isSetup
                  ? 'Setup formation — where patterns and structures are detected'
                  : 'Entry timing — precise execution level and confirmation'}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function TimeframeBadge({ role, timeframe }: { role: 'htf_bias' | 'setup' | 'entry'; timeframe: Timeframe }) {
  const meta = ROLE_ORDER.find((r) => r.role === role);
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta?.color ?? 'border-ink-600 bg-ink-800 text-ink-300'}`}>
      <span>{meta?.icon}</span>
      <span className="uppercase">{role === 'htf_bias' ? 'HTF' : role}</span>
      <span className="font-mono">{timeframe.toUpperCase()}</span>
    </span>
  );
}
