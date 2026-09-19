'use client';

import * as React from 'react';
import Link from 'next/link';
import type { SetupDto, StrategyDetailDto, ScannerHealthDto } from '@veltrixeye/contracts';
import { Badge, Card, CardHeader } from '@/components/ui';
import { BRAND } from '@/lib/brand';
import { SetupCard } from '@/components/setup-card';

export function DashboardStats({ strategies, setups, scannerHealth }: { strategies: StrategyDetailDto[]; setups: SetupDto[]; scannerHealth: ScannerHealthDto | null }) {
  const published = strategies.filter((s) => s.currentVersion);
  const activeSetups = setups.filter((s) => !['expired', 'invalidated', 'completed'].includes(s.state));
  const avgQuality = setups.length > 0 ? Math.round(setups.filter((s) => s.qualityScore !== null).reduce((acc, s) => acc + (s.qualityScore ?? 0), 0) / Math.max(1, setups.filter((s) => s.qualityScore !== null).length)) : null;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Strategies" value={strategies.length} sub={`${published.length} published · ${strategies.length - published.length} draft`} href="/strategies" />
      <StatCard label="Active Setups" value={activeSetups.length} sub={`${setups.length} total · ${avgQuality !== null ? `avg Q ${avgQuality}` : 'not scored yet'}`} href="/setups" />
      <StatCard label="Scanner" value={scannerHealth?.status === 'running' ? 'Running' : scannerHealth?.status ?? '—'} sub={scannerHealth ? `${scannerHealth.activeRuns} active · ${scannerHealth.recentFailures} failures (1h)` : 'Loading…'} href="/scanner" tone={scannerHealth?.status === 'running' ? 'success' : scannerHealth?.status === 'degraded' ? 'warning' : 'neutral'} />
      <StatCard label="Safety" value={`M8.7`} sub={`Automation OFF · ${BRAND.safety.executionNote}`} href="/trading" tone="info" />
    </div>
  );
}

function StatCard({ label, value, sub, href, tone }: { label: string; value: string | number; sub: string; href: string; tone?: 'success' | 'warning' | 'info' | 'neutral' }) {
  return (
    <Link href={href}>
      <Card className="group px-5 py-4 transition-all hover:border-ink-600 hover:shadow-md hover:shadow-black/20">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-2xl font-semibold text-ink-50 group-hover:text-signal-400">{value}</span>
              {tone && <Badge tone={tone === 'success' ? 'success' : tone === 'warning' ? 'warning' : tone === 'info' ? 'info' : 'neutral'}>{tone}</Badge>}
            </div>
            <div className="mt-1 text-xs text-ink-400">{sub}</div>
          </div>
          <span className="text-ink-600 group-hover:text-ink-400">→</span>
        </div>
      </Card>
    </Link>
  );
}

export function DashboardRecentSetups({ setups }: { setups: SetupDto[] }) {
  const recent = setups.slice(0, 6);
  if (recent.length === 0) {
    return (
      <Card>
        <CardHeader title="Recent Setups" subtitle="Latest detected signals — newest first" actions={<Link href="/setups" className="text-xs text-signal-400 hover:underline">View all →</Link>} />
        <div className="px-5 py-8 text-center text-sm text-ink-400">No setups yet. Run detection from workbench.</div>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title={`Recent Setups (${recent.length})`} subtitle="Latest signals with entry, SL, TP, RR" actions={<Link href="/setups" className="text-xs text-signal-400 hover:underline">View all →</Link>} />
      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {recent.map((s) => (
          <SetupCard key={s.id} setup={s} />
        ))}
      </div>
    </Card>
  );
}

export function DashboardWorkflowIntro() {
  return (
    <Card>
      <CardHeader title="HTF → Setup → Entry Workflow" subtitle="Deterministic, no live trading — M8.7 safety preserved" />
      <div className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <WorkflowStep icon="◧" title="HTF Bias" desc="Higher-timeframe trend filter determines directional bias. Uses 1d, 4h, 1w." tone="info" />
          <WorkflowStep icon="◉" title="Setup" desc="Pattern & structure detection on setup timeframe. Generates confirmed setups." tone="success" />
          <WorkflowStep icon="◎" title="Entry" desc="Precise entry timing, SL/TP, R/R calculation. Entry timeframe for execution level." tone="warning" />
        </div>
        <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3 text-xs leading-relaxed text-ink-400">
          <strong className="text-ink-200">How it works:</strong> Define a deterministic strategy with 3 timeframes (HTF bias, setup, entry) and rule groups. Evaluate at an explicit anchor (no wall clock), detect setups (idempotent per version/instrument/direction/anchor), score quality (M5 engine), transition lifecycle (M4 state machine), generate alerts (stub ledger — no real delivery yet). All steps are explicit and audited.
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/workbench" className="inline-flex items-center justify-center rounded-md bg-signal-600 px-4 py-2 text-sm font-medium text-white hover:bg-signal-500">
            Open Workbench →
          </Link>
          <Link href="/strategies" className="inline-flex items-center justify-center rounded-md border border-ink-600 bg-ink-800 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-ink-700">
            View Strategies
          </Link>
          <Link href="/markets" className="inline-flex items-center justify-center rounded-md border border-ink-600 bg-ink-800 px-4 py-2 text-sm font-medium text-ink-100 hover:bg-ink-700">
            Markets & Watchlist
          </Link>
        </div>
      </div>
    </Card>
  );
}

function WorkflowStep({ icon, title, desc, tone }: { icon: string; title: string; desc: string; tone: 'info' | 'success' | 'warning' }) {
  const color = tone === 'info' ? 'border-info-450/30 bg-info-450/10 text-info-450' : tone === 'success' ? 'border-signal-500/30 bg-signal-500/10 text-signal-400' : 'border-amber-450/30 bg-amber-450/10 text-amber-450';
  return (
    <div className={`rounded-lg border p-3 ${color}`}>
      <div className="flex items-center gap-2">
        <span className="text-base">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wider">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed opacity-90">{desc}</p>
    </div>
  );
}

export function DashboardScannerWorkspace({ health }: { health: ScannerHealthDto | null }) {
  if (!health) {
    return (
      <Card>
        <CardHeader title="Scanner Workspace" subtitle="Live market scanning — production data flow" />
        <div className="px-5 py-6 text-sm text-ink-400">Loading scanner health…</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Scanner Workspace"
        subtitle={`Status ${health.status} · ${health.provider ?? 'no provider'} · interval ${Math.round(health.expectedIntervalMs / 60000)}m`}
        actions={<Link href="/scanner" className="text-xs text-signal-400 hover:underline">Open scanner →</Link>}
      />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-400">Last Run</div>
          <div className="mt-1 text-sm text-ink-100">
            {health.lastSuccessfulRun ? new Date(health.lastSuccessfulRun.finishedAt ?? health.lastSuccessfulRun.startedAt).toLocaleString() : 'Never'}
          </div>
          <div className="mt-1 text-xs text-ink-400">
            {health.lastRun ? `${health.lastRun.strategiesScanned} strategies · ${health.lastRun.instrumentsScanned} instruments · ${health.lastRun.setupsDetected} detections` : 'No run data'}
          </div>
        </div>
        <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-400">Data Freshness</div>
          <div className="mt-1 text-sm text-ink-100">
            {health.dataFreshness.newestCandleTime ? new Date(health.dataFreshness.newestCandleTime).toLocaleString() : 'No candles'}
          </div>
          <div className="mt-1 text-xs text-ink-400">{health.dataFreshness.staleRejectionCount} stale rejections (24h) · {health.recentFailures} failures (1h)</div>
        </div>
      </div>
    </Card>
  );
}
