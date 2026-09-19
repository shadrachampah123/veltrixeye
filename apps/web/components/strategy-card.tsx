'use client';

import * as React from 'react';
import Link from 'next/link';
import type { StrategyDetailDto } from '@veltrixeye/contracts';
import { Badge, Card } from '@/components/ui';
import { timeframesLabel } from '@/lib/formats';
import { TimeframeWorkflow } from '@/components/timeframe-workflow';

export interface StrategyCardProps {
  strategy: StrategyDetailDto;
  onSelect?: (id: string) => void;
}

function getDeterministicType(strategy: StrategyDetailDto): { label: string; tone: 'success' | 'info' | 'warning' | 'neutral'; description: string } {
  const v = strategy.currentVersion;
  const groups = v?.config.ruleGroups ?? [];
  const conditionCount = groups.reduce((acc, g) => acc + (g.conditions?.length ?? 0), 0);
  
  // Heuristic based on rule groups - presentation only, not business logic
  if (conditionCount === 0) {
    return { label: 'Empty Draft', tone: 'neutral', description: 'No conditions yet — define HTF bias, setup, entry' };
  }
  if (groups.length >= 3) {
    return { label: 'Multi-Factor', tone: 'success', description: `${groups.length} rule groups · ${conditionCount} conditions` };
  }
  if (groups.length === 2) {
    return { label: 'Dual Confirmation', tone: 'info', description: `${groups.length} rule groups · ${conditionCount} conditions` };
  }
  return { label: 'Single Signal', tone: 'warning', description: `${groups.length} rule group · ${conditionCount} conditions` };
}

export function StrategyCard({ strategy }: StrategyCardProps) {
  const current = strategy.currentVersion;
  const draft = strategy.versions.find((v) => v.status === 'draft');
  const type = getDeterministicType(strategy);

  return (
    <Card className="group relative overflow-hidden transition-all hover:border-ink-600 hover:shadow-lg hover:shadow-black/20">
      {/* Accent line */}
      <div className="absolute left-0 top-0 h-full w-0.5 bg-signal-600/60 group-hover:bg-signal-500" />

      <div className="p-5">
        {/* Header */}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Link href={`/strategies/${strategy.id}`} className="block">
              <h3 className="truncate text-[15px] font-semibold text-ink-50 group-hover:text-signal-400 transition-colors">
                {strategy.name}
              </h3>
            </Link>
            {strategy.description ? (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-400">{strategy.description}</p>
            ) : (
              <p className="mt-1 text-xs italic text-ink-500">No description</p>
            )}
          </div>
          <Badge tone={type.tone}>{type.label}</Badge>
        </div>

        {/* Timeframe workflow */}
        {current?.config.timeframes ? (
          <div className="mb-3">
            <TimeframeWorkflow timeframes={current.config.timeframes} size="sm" />
          </div>
        ) : (
          <div className="mb-3 rounded-md border border-dashed border-ink-600 bg-ink-850/50 px-3 py-2 text-xs text-ink-500">
            No timeframes configured — set HTF bias, setup, entry in version
          </div>
        )}

        {/* Meta */}
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
          {current ? (
            <>
              <Badge tone="success">v{current.versionNumber} live</Badge>
              <span className="text-ink-500">{timeframesLabel(current.config.timeframes ?? null)}</span>
            </>
          ) : draft ? (
            <>
              <Badge tone="warning">v{draft.versionNumber} draft</Badge>
              <span className="text-ink-500">Publish to evaluate</span>
            </>
          ) : (
            <Badge tone="neutral">No version</Badge>
          )}
          <span className="text-ink-600">·</span>
          <span className="text-ink-400">{type.description}</span>
        </div>

        {/* Market scope */}
        {current?.config.marketScope && (
          <div className="mb-4 text-[11px] text-ink-400">
            {current.config.marketScope.mode === 'instruments'
              ? `${current.config.marketScope.instruments?.length ?? 0} instruments scoped`
              : 'All instruments · capped per run'}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Link
            href={`/strategies/${strategy.id}`}
            className="inline-flex items-center justify-center rounded-md bg-ink-700 px-3 py-1.5 text-xs font-medium text-ink-100 transition-colors hover:bg-ink-600"
          >
            Open
          </Link>
          {current && (
            <Link
              href={`/strategies/${strategy.id}/versions/${current.id}`}
              className="inline-flex items-center justify-center rounded-md border border-ink-600 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
            >
              Workbench
            </Link>
          )}
          {draft && (
            <Link
              href={`/strategies/${strategy.id}/edit`}
              className="inline-flex items-center justify-center rounded-md border border-amber-450/30 bg-amber-450/10 px-3 py-1.5 text-xs font-medium text-amber-450 transition-colors hover:bg-amber-450/15"
            >
              Edit draft
            </Link>
          )}
          <div className="ml-auto text-[10px] text-ink-500">
            {strategy.versions.length} version{strategy.versions.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function StrategyCardGrid({ strategies }: { strategies: StrategyDetailDto[] }) {
  if (strategies.length === 0) {
    return (
      <Card className="px-6 py-14 text-center">
        <p className="text-sm text-ink-300">No strategies yet.</p>
        <p className="mt-1 text-xs text-ink-400">Deterministic strategies are defined with HTF bias → setup → entry timeframes.</p>
      </Card>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {strategies.map((s) => (
        <StrategyCard key={s.id} strategy={s} />
      ))}
    </div>
  );
}
