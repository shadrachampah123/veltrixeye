'use client';

import * as React from 'react';
import Link from 'next/link';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Button, Card, CardHeader, Spinner, Badge } from '@/components/ui';
import type { StrategyDetailDto } from '@veltrixeye/contracts';
import { StrategyCardGrid } from '@/components/strategy-card';
import { TimeframeWorkflow } from '@/components/timeframe-workflow';
import { BRAND } from '@/lib/brand';

function StrategiesContent() {
  const [strategies, setStrategies] = React.useState<StrategyDetailDto[] | null>(null);
  const [view, setView] = React.useState<'grid' | 'list'>('grid');

  const load = React.useCallback(() => {
    api
      .listStrategies()
      .then(async ({ strategies: list }) => {
        const details = await Promise.all(list.map((s) => api.getStrategy(s.id).then((r) => r.strategy)));
        setStrategies(details);
      })
      .catch(() => setStrategies([]));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const published = strategies?.filter((s) => s.currentVersion) ?? [];
  const drafts = strategies?.filter((s) => !s.currentVersion) ?? [];

  return (
    <AppShell>
      <PageHeader
        title="Strategies"
        subtitle={`${BRAND.name} deterministic strategies — HTF bias → setup → entry, server-authoritative evaluation`}
        actions={
          <>
            <div className="flex items-center gap-1 rounded-md border border-ink-600 bg-ink-800 p-0.5">
              <button
                onClick={() => setView('grid')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${view === 'grid' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}
              >
                Grid
              </button>
              <button
                onClick={() => setView('list')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${view === 'list' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}
              >
                List
              </button>
            </div>
            <Link href="/strategies/new">
              <Button>+ New strategy</Button>
            </Link>
          </>
        }
      />

      {/* Stats */}
      {strategies !== null && (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Card className="px-5 py-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-400">Total Strategies</div>
                <div className="mt-1 font-mono text-2xl text-ink-50">{strategies.length}</div>
              </div>
              <Badge tone="neutral">{published.length} live</Badge>
            </div>
          </Card>
          <Card className="px-5 py-4">
            <div className="text-[11px] uppercase tracking-wider text-ink-400">Published</div>
            <div className="mt-1 font-mono text-2xl text-signal-400">{published.length}</div>
            <div className="mt-1 text-xs text-ink-500">Evaluable & detectable</div>
          </Card>
          <Card className="px-5 py-4">
            <div className="text-[11px] uppercase tracking-wider text-ink-400">Drafts</div>
            <div className="mt-1 font-mono text-2xl text-amber-450">{drafts.length}</div>
            <div className="mt-1 text-xs text-ink-500">Need publish to run</div>
          </Card>
        </div>
      )}

      {strategies === null ? (
        <Spinner />
      ) : strategies.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <div className="mx-auto max-w-md">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-ink-800 text-ink-400">⌘</div>
            <h3 className="mt-4 text-sm font-semibold text-ink-50">No strategies yet</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-400">
              Deterministic strategies are defined with HTF bias → setup → entry timeframes and rule groups. They are evaluated at an explicit anchor, never by wall clock.
            </p>
            <Link href="/strategies/new" className="mt-4 inline-block">
              <Button>Create your first strategy</Button>
            </Link>
            <div className="mt-6 rounded-md border border-ink-700 bg-ink-850/50 p-3 text-left">
              <div className="text-xs font-medium text-ink-200">Example workflow:</div>
              <ol className="mt-1 list-decimal space-y-1 pl-4 text-[11px] text-ink-400">
                <li>Define HTF bias (e.g., 1d), setup (e.g., 1h), entry (e.g., 15m)</li>
                <li>Add rule groups: trend filter, structure, confirmation</li>
                <li>Publish version → evaluate at anchor → detect setups</li>
              </ol>
            </div>
          </div>
        </Card>
      ) : view === 'grid' ? (
        <StrategyCardGrid strategies={strategies} />
      ) : (
        <Card>
          <CardHeader title={`All strategies (${strategies.length})`} subtitle="Deterministic — server validates publish, evaluation is store-only" />
          <div className="divide-y divide-ink-700">
            {strategies.map((s) => {
              const v = s.currentVersion;
              const draft = s.versions.find((x) => x.status === 'draft');
              return (
                <div key={s.id} className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-ink-750/50 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/strategies/${s.id}`} className="truncate font-medium text-ink-50 hover:text-signal-400">
                        {s.name}
                      </Link>
                      {v ? <Badge tone="success">v{v.versionNumber} live</Badge> : draft ? <Badge tone="warning">v{draft.versionNumber} draft</Badge> : <Badge tone="neutral">no version</Badge>}
                    </div>
                    {s.description && <p className="mt-1 truncate text-xs text-ink-400">{s.description}</p>}
                    {v?.config.timeframes && (
                      <div className="mt-2">
                        <TimeframeWorkflow timeframes={v.config.timeframes} size="sm" />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href={`/strategies/${s.id}`} className="text-xs text-ink-300 hover:text-signal-400 hover:underline">
                      View
                    </Link>
                    {v && (
                      <Link href={`/strategies/${s.id}/versions/${v.id}`} className="rounded-md bg-ink-700 px-2.5 py-1 text-xs text-ink-100 hover:bg-ink-600">
                        Workbench
                      </Link>
                    )}
                    {draft && (
                      <Link href={`/strategies/${s.id}/edit`} className="rounded-md border border-amber-450/30 bg-amber-450/10 px-2.5 py-1 text-xs text-amber-450 hover:bg-amber-450/15">
                        Edit draft
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Safety note */}
      <div className="mt-6 rounded-md border border-ink-700 bg-ink-800 px-4 py-3 text-xs leading-relaxed text-ink-400">
        <strong className="text-ink-200">M8.7 Safety preserved:</strong> Strategies are deterministic definitions only. Evaluation is store-only, detection is idempotent, scoring is append-only. No live trading path — paper simulation only, automation OFF by default, drawdown protection enforced server-side.
      </div>
    </AppShell>
  );
}

export default function StrategiesPage() {
  return (
    <RequireAuth>
      <StrategiesContent />
    </RequireAuth>
  );
}
