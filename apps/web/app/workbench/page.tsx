'use client';

import * as React from 'react';
import Link from 'next/link';
import type { StrategyDetailDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Alert, Badge, Card, CardHeader, LinkButton, Spinner } from '@/components/ui';
import { describeApiError } from '@/lib/api-errors';
import { formatDate, timeframesLabel } from '@/lib/formats';
import { draftVersion, evaluableVersions } from '@/lib/workbench';
import { TimeframeWorkflow, TimeframeWorkflowDetailed } from '@/components/timeframe-workflow';
import { BRAND } from '@/lib/brand';

function WorkbenchContent() {
  const [strategies, setStrategies] = React.useState<StrategyDetailDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api
      .listStrategies()
      .then(async ({ strategies: list }) => {
        const details = await Promise.all(list.map((s) => api.getStrategy(s.id).then((r) => r.strategy)));
        if (!cancelled) setStrategies(details);
      })
      .catch((err) => {
        if (cancelled) return;
        setStrategies([]);
        setError(describeApiError(err, 'Could not load your strategies. Try again.'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const withVersions = (strategies ?? []).filter((s) => evaluableVersions(s).length > 0);
  const withoutVersions = (strategies ?? []).filter((s) => evaluableVersions(s).length === 0);

  return (
    <AppShell>
      <PageHeader
        title="Strategy Workbench"
        subtitle={`HTF bias → setup → entry timeframe workflow — evaluate, detect, score, transition · ${BRAND.stage} safety preserved`}
        actions={<LinkButton href="/setups" variant="secondary">All setups</LinkButton>}
      />

      {/* HTF → Setup → Entry workflow explanation - Phase 3 core */}
      <Card className="mb-6">
        <CardHeader title="HTF → Setup → Entry Timeframe Workflow" subtitle="Deterministic — the core of every strategy, no live trading" />
        <div className="space-y-4 p-5">
          <TimeframeWorkflowDetailed timeframes={{ htf_bias: '1d', setup: '1h', entry: '15m' }} />

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-md border border-info-450/30 bg-info-450/5 p-3">
              <div className="flex items-center gap-2"><Badge tone="info">HTF Bias</Badge><span className="text-xs font-medium text-ink-100">Higher-timeframe trend</span></div>
              <p className="mt-2 text-xs leading-relaxed text-ink-400">Determines directional bias (long/short/neutral) from higher timeframe (e.g., 1d, 4h, 1w). Filters out counter-trend setups. Server-evaluated, store-only.</p>
              <div className="mt-2 text-[11px] text-ink-500">Example: 1d EMA 200 trend, 4h structure</div>
            </div>
            <div className="rounded-md border border-signal-500/30 bg-signal-500/5 p-3">
              <div className="flex items-center gap-2"><Badge tone="success">Setup</Badge><span className="text-xs font-medium text-ink-100">Pattern formation</span></div>
              <p className="mt-2 text-xs leading-relaxed text-ink-400">Where patterns and structures are detected (e.g., 1h, 15m). Generates confirmed setups with entry, SL, TP, R/R. Idempotent per version/instrument/direction/anchor.</p>
              <div className="mt-2 text-[11px] text-ink-500">Example: 1h BOS, order block, FVG</div>
            </div>
            <div className="rounded-md border border-amber-450/30 bg-amber-450/5 p-3">
              <div className="flex items-center gap-2"><Badge tone="warning">Entry</Badge><span className="text-xs font-medium text-ink-100">Precise timing</span></div>
              <p className="mt-2 text-xs leading-relaxed text-ink-400">Precise execution level and confirmation on entry timeframe (e.g., 15m, 5m, 1m). Determines exact entry, SL, TP levels and R/R calculation.</p>
              <div className="mt-2 text-[11px] text-ink-500">Example: 15m entry trigger, 5m confirmation</div>
            </div>
          </div>

          <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
            <div className="text-xs font-medium text-ink-200">Four explicit steps — nothing runs on schedule</div>
            <ol className="mt-2 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <li className="flex gap-2"><Badge tone="info">1</Badge><span className="text-ink-300"><strong className="text-ink-100">Evaluate</strong> — M3 engine scores rule groups/conditions per instrument at explicit anchor. Store-only.</span></li>
              <li className="flex gap-2"><Badge tone="info">2</Badge><span className="text-ink-300"><strong className="text-ink-100">Detect</strong> — M4 persists one setup per qualifying direction at same anchor. Idempotent replay returns existing.</span></li>
              <li className="flex gap-2"><Badge tone="info">3</Badge><span className="text-ink-300"><strong className="text-ink-100">Score & Transition</strong> — M5 quality, M4 state machine. API final authority.</span></li>
              <li className="flex gap-2"><Badge tone="info">4</Badge><span className="text-ink-300"><strong className="text-ink-100">Alert</strong> — Generate alert from setup, stub ledger — no real delivery yet.</span></li>
            </ol>
          </div>

          <div className="rounded-md border border-signal-500/20 bg-signal-500/5 px-3 py-2 text-[11px] leading-relaxed text-ink-400">
            <strong className="text-signal-400">{BRAND.stage} Safety:</strong> Evaluation is store-only (no provider fetch), detection is idempotent, scoring append-only, transitions state-machine validated. No live trading path, automation OFF, drawdown protection active, kill-switch enforced. All steps explicit anchor — no wall clock.
          </div>
        </div>
      </Card>

      {error && (
        <div className="mb-4">
          <Alert tone="danger" role="alert">{error}</Alert>
        </div>
      )}

      {strategies === null ? (
        <Spinner label="Loading your strategies" />
      ) : strategies.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">You do not have any strategies yet.</p>
          <p className="mt-1 text-xs text-ink-400">A strategy version must exist and be published before it can be evaluated with HTF→setup→entry workflow.</p>
          <Link href="/strategies/new" className="mt-4 inline-block"><span className="text-xs text-signal-400 underline underline-offset-2">Create a strategy</span></Link>
        </Card>
      ) : withVersions.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">No published version yet.</p>
          <p className="mt-1 text-xs text-ink-400">Only published versions can be evaluated or detected — publish a draft version first.</p>
          <Link href="/strategies" className="mt-4 inline-block"><span className="text-xs text-signal-400 underline underline-offset-2">Go to your strategies</span></Link>
        </Card>
      ) : (
        <div className="space-y-5">
          {withVersions.map((strategy) => {
            const draft = draftVersion(strategy);
            return (
              <Card key={strategy.id}>
                <CardHeader
                  title={strategy.name}
                  subtitle={strategy.description ?? 'No description'}
                  actions={<Link href={`/strategies/${strategy.id}`} className="text-xs text-ink-300 underline underline-offset-2">Strategy detail</Link>}
                />
                <ul className="divide-y divide-ink-750">
                  {evaluableVersions(strategy).map((version) => {
                    // Use currentVersion's timeframes if available — version detail config requires extra fetch
                    const timeframes = strategy.currentVersion?.config.timeframes ?? null;
                    return (
                      <li key={version.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm text-ink-50">v{version.versionNumber}</span>
                            {version.isCurrent ? <Badge tone="success">current</Badge> : version.status === 'published' ? <Badge tone="info">published</Badge> : <Badge tone="neutral">deprecated</Badge>}
                            <span className="text-xs text-ink-400">{version.status === 'deprecated' ? 'frozen — still evaluable' : `published ${formatDate(version.publishedAt)}`}</span>
                          </div>
                          <p className="mt-1 text-xs text-ink-400">{version.changelog ?? 'No changelog'} · {timeframesLabel(timeframes)}</p>
                          {timeframes && (
                            <div className="mt-2">
                              <TimeframeWorkflow timeframes={timeframes} size="sm" />
                            </div>
                          )}
                        </div>
                        <LinkButton href={`/strategies/${strategy.id}/versions/${version.id}`}>Open workbench</LinkButton>
                      </li>
                    );
                  })}
                </ul>
                {draft && <p className="border-t border-ink-750 px-5 py-3 text-xs text-ink-400">v{draft.versionNumber} is still a draft — it cannot be evaluated or detected until it is published.</p>}
              </Card>
            );
          })}

          {withoutVersions.length > 0 && (
            <Card>
              <CardHeader title="Waiting on a published version" subtitle="Draft-only strategies — publish to enable HTF→setup→entry workflow" />
              <ul className="divide-y divide-ink-750">
                {withoutVersions.map((strategy) => {
                  const draft = draftVersion(strategy);
                  return (
                    <li key={strategy.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                      <div className="min-w-0 flex-1">
                        <Link href={`/strategies/${strategy.id}`} className="text-sm font-medium text-ink-50 hover:text-signal-400">{strategy.name}</Link>
                        <p className="mt-0.5 text-xs text-ink-400">{draft ? `Draft v${draft.versionNumber} is unpublished.` : 'No versions yet.'} Publish a version to make it evaluable with HTF bias → setup → entry.</p>
                      </div>
                      <LinkButton href={`/strategies/${strategy.id}`} variant="secondary">Open strategy</LinkButton>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      )}
    </AppShell>
  );
}

export default function WorkbenchPage() {
  return (
    <RequireAuth>
      <WorkbenchContent />
    </RequireAuth>
  );
}
