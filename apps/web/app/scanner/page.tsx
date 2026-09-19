'use client';

import * as React from 'react';
import Link from 'next/link';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Card, CardHeader, Badge, Button, Spinner } from '@/components/ui';
import type { ScannerHealthDto, ScannerRunDto, SetupDto } from '@veltrixeye/contracts';
import type { MarketInstrument } from '@/lib/api';
import { WatchlistPanel } from '@/components/watchlist';
import { SetupCardGrid } from '@/components/setup-card';
import { BRAND } from '@/lib/brand';

function ScannerContent() {
  const [health, setHealth] = React.useState<ScannerHealthDto | null>(null);
  const [runs, setRuns] = React.useState<ScannerRunDto[] | null>(null);
  const [setups, setSetups] = React.useState<SetupDto[] | null>(null);
  const [instruments, setInstruments] = React.useState<MarketInstrument[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [triggering, setTriggering] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const [h, r, s, i] = await Promise.all([
        api.getScannerHealth(),
        api.listScannerRuns({ limit: 20 }),
        api.listSetups({ limit: 12 }).then((res) => res.setups),
        api.listInstruments().then((res) => res.instruments).catch(() => []),
      ]);
      setHealth(h);
      setRuns(r.runs);
      setSetups(s);
      setInstruments(i as any);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load scanner status');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const handleTrigger = async () => {
    try {
      setTriggering(true);
      await api.triggerScanner({ force: false });
      await load();
    } catch (e: any) {
      setError(e?.message ?? 'Failed to trigger scanner');
    } finally {
      setTriggering(false);
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Market Scanner Workspace"
        subtitle={`${BRAND.name} live scanner — HTF bias → setup → entry workflow, real market data through deterministic pipeline · ${BRAND.stage} safety preserved`}
        actions={
          <>
            <Link href="/markets">
              <Button variant="secondary">Markets</Button>
            </Link>
            <Link href="/workbench">
              <Button variant="secondary">Workbench</Button>
            </Link>
            <Button onClick={handleTrigger} disabled={triggering}>{triggering ? 'Triggering...' : 'Trigger Scan'}</Button>
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
      )}

      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {/* Workspace overview */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Scanner Health — Production Workspace" subtitle="Real production state — not mock, server-authoritative, M8.7 drawdown protection active" />
              <div className="px-5 py-4">
                {health ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-ink-400">Status & Provider</div>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge tone={health.status === 'running' ? 'info' : health.status === 'degraded' ? 'warning' : health.status === 'unavailable' ? 'danger' : 'success'}>{health.status}</Badge>
                        <span className="text-sm text-ink-100">{health.provider ?? 'no provider'}</span>
                      </div>
                      <div className="mt-1 text-xs text-ink-400">{health.isProviderAvailable ? 'Twelve Data available — real data' : 'Unavailable — set TWELVE_DATA_API_KEY'}</div>
                    </div>
                    <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-ink-400">Expected Interval & Runs</div>
                      <div className="mt-1 text-sm text-ink-100">{Math.round(health.expectedIntervalMs / 60000)} minutes interval</div>
                      <div className="mt-1 text-xs text-ink-400">{health.activeRuns} active · {health.recentFailures} failures (1h) · {health.dataFreshness.staleRejectionCount} stale (24h)</div>
                    </div>
                    <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-ink-400">Last Successful Scan</div>
                      <div className="mt-1 text-sm text-ink-100">{health.lastSuccessfulRun ? new Date(health.lastSuccessfulRun.finishedAt ?? health.lastSuccessfulRun.startedAt).toLocaleString() : 'never'}</div>
                      <div className="mt-1 text-xs text-ink-400">Data freshness: {health.dataFreshness.newestCandleTime ? new Date(health.dataFreshness.newestCandleTime).toLocaleString() : 'none'}</div>
                    </div>
                    <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-ink-400">HTF → Setup → Entry</div>
                      <div className="mt-2 flex items-center gap-1 text-xs">
                        <span className="rounded border border-info-450/30 bg-info-450/10 px-1.5 py-0.5 text-info-450">HTF 1D</span>
                        <span className="text-ink-500">→</span>
                        <span className="rounded border border-signal-500/30 bg-signal-500/10 px-1.5 py-0.5 text-signal-400">Setup 1H</span>
                        <span className="text-ink-500">→</span>
                        <span className="rounded border border-amber-450/30 bg-amber-450/10 px-1.5 py-0.5 text-amber-450">Entry 15m</span>
                      </div>
                      <div className="mt-1 text-[11px] text-ink-500">Timeframe workflow used across strategies</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-ink-400">No health data</div>
                )}
              </div>
            </Card>

            <div className="space-y-4">
              <WatchlistPanel instruments={instruments ?? undefined} />
              <Card>
                <CardHeader title="Scanner Safety" subtitle="M8.7 controls preserved" />
                <div className="space-y-2 p-4 text-xs text-ink-400">
                  <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-signal-500" /> Automation OFF by default</div>
                  <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-signal-500" /> Paper simulation only — no live trading</div>
                  <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-signal-500" /> Drawdown protection active</div>
                  <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-signal-500" /> Kill-switch & circuit breaker enforced</div>
                  <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-signal-500" /> Risk ceilings server-side</div>
                </div>
              </Card>
            </div>
          </div>

          {/* Last run detail */}
          {health?.lastRun && (
            <Card>
              <CardHeader title={`Last Run ${health.lastRun.id.slice(0, 8)} — ${health.lastRun.status}`} subtitle="Observability: scan start/completion, provider latency, symbols/timeframes, detection counts" />
              <div className="px-5 py-4 text-sm">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Strategies" value={health.lastRun.strategiesScanned} />
                  <Metric label="Instruments" value={health.lastRun.instrumentsScanned} />
                  <Metric label="Candles" value={health.lastRun.candlesFetched} />
                  <Metric label="Duration" value={health.lastRun.finishedAt ? `${Math.round((new Date(health.lastRun.finishedAt).getTime() - new Date(health.lastRun.startedAt).getTime()) / 1000)}s` : 'running'} />
                  <Metric label="Setups Detected" value={health.lastRun.setupsDetected} tone="info" />
                  <Metric label="Setups Created" value={health.lastRun.setupsCreated} tone="success" />
                  <Metric label="Alerts" value={health.lastRun.alertsCreated} tone="info" />
                  <Metric label="Stale / Failures" value={`${health.lastRun.staleRejections} / ${health.lastRun.providerFailures}`} tone="warning" />
                </div>
                {health.lastRun.symbolsProcessed.length > 0 && (
                  <div className="mt-4">
                    <div className="text-[11px] uppercase tracking-wider text-ink-400">Symbols Processed</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {health.lastRun.symbolsProcessed.map((sym) => (
                        <span key={sym} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-ink-300">{sym}</span>
                      ))}
                    </div>
                  </div>
                )}
                {health.lastRun.timeframesProcessed.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] uppercase tracking-wider text-ink-400">Timeframes Processed</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {health.lastRun.timeframesProcessed.map((tf) => (
                        <span key={tf} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-ink-300">{tf}</span>
                      ))}
                    </div>
                  </div>
                )}
                {health.lastRun.error && <div className="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">{health.lastRun.error}</div>}
              </div>
            </Card>
          )}

          {/* Recent setups from scanner */}
          {setups && setups.length > 0 && (
            <Card>
              <CardHeader title={`Recent Setups from Scanner (${setups.length})`} subtitle="Latest signals — market, direction, timeframe, entry, SL, TP, RR, quality, status" actions={<Link href="/setups" className="text-xs text-signal-400 hover:underline">View all setups →</Link>} />
              <div className="p-4">
                <SetupCardGrid setups={setups.slice(0, 6)} />
              </div>
            </Card>
          )}

          {/* Runs list */}
          <Card>
            <CardHeader title="Recent Scanner Runs" subtitle="Observability — full pipeline: start/completion, provider health, detection, alert creation" />
            <div className="divide-y divide-ink-700">
              {runs === null ? (
                <div className="px-5 py-6 text-sm text-ink-400">Loading...</div>
              ) : runs.length === 0 ? (
                <div className="px-5 py-6 text-sm text-ink-400">No scanner runs yet. Trigger a scan to start processing real market data through HTF→setup→entry workflow.</div>
              ) : (
                runs.map((run) => (
                  <div key={run.id} className="px-5 py-3.5 transition-colors hover:bg-ink-750/50">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : run.status === 'running' ? 'info' : 'warning'}>{run.status}</Badge>
                      <span className="font-mono text-sm text-ink-100">{run.id.slice(0, 8)}</span>
                      <span className="text-xs text-ink-400">{new Date(run.startedAt).toLocaleString()}</span>
                      <span className="text-xs text-ink-500">· {run.providerSlug}</span>
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-ink-400 sm:grid-cols-2 lg:grid-cols-4">
                      <span>{run.strategiesScanned} strategies · {run.instrumentsScanned} instruments</span>
                      <span>{run.candlesFetched} candles · {run.setupsDetected} detections</span>
                      <span>{run.setupsCreated} created · {run.alertsCreated} alerts</span>
                      <span>{run.staleRejections} stale · {run.providerFailures} failures</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'success' | 'info' | 'warning' }) {
  const color = tone === 'success' ? 'text-signal-400' : tone === 'info' ? 'text-info-450' : tone === 'warning' ? 'text-amber-450' : 'text-ink-100';
  return (
    <div className="rounded-md border border-ink-700 bg-ink-850/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`mt-1 font-mono text-sm font-medium ${color}`}>{value}</div>
    </div>
  );
}

export default function ScannerPage() {
  return (
    <RequireAuth>
      <ScannerContent />
    </RequireAuth>
  );
}
