'use client';

import * as React from 'react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Card, CardHeader, Badge, Button, Spinner } from '@/components/ui';
import type { ScannerHealthDto, ScannerRunDto } from '@veltrixeye/contracts';

function ScannerContent() {
  const [health, setHealth] = React.useState<ScannerHealthDto | null>(null);
  const [runs, setRuns] = React.useState<ScannerRunDto[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [triggering, setTriggering] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setLoading(true);
      const [h, r] = await Promise.all([api.getScannerHealth(), api.listScannerRuns({ limit: 20 })]);
      setHealth(h);
      setRuns(r.runs);
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
        title="Live Scanner"
        subtitle="Production market-data and scanner pipeline — real data through the full strategy pipeline"
        actions={<Button onClick={handleTrigger} disabled={triggering}>{triggering ? 'Triggering...' : 'Trigger Scan'}</Button>}
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : (
        <>
          {/* Health */}
          <Card className="mb-6">
            <CardHeader title="Scanner Health" subtitle="Real production state — not mock/static" />
            <div className="px-5 py-4">
              {health ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-ink-400">Status</div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge tone={health.status === 'running' ? 'info' : health.status === 'degraded' ? 'warning' : health.status === 'unavailable' ? 'danger' : 'success'}>
                        {health.status}
                      </Badge>
                      <span className="text-sm text-ink-300">{health.provider ?? 'no provider'} — {health.isProviderAvailable ? 'available' : 'unavailable'}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-ink-400">Expected Interval</div>
                    <div className="mt-1 text-sm text-ink-100">{Math.round(health.expectedIntervalMs / 60000)} minutes</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-ink-400">Last Successful Scan</div>
                    <div className="mt-1 text-sm text-ink-100">{health.lastSuccessfulRun ? new Date(health.lastSuccessfulRun.finishedAt ?? health.lastSuccessfulRun.startedAt).toLocaleString() : 'never'}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-ink-400">Active Runs / Recent Failures</div>
                    <div className="mt-1 text-sm text-ink-100">{health.activeRuns} active, {health.recentFailures} failures (1h)</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-ink-400">Data Freshness</div>
                    <div className="mt-1 text-sm text-ink-100">
                      Newest candle: {health.dataFreshness.newestCandleTime ? new Date(health.dataFreshness.newestCandleTime).toLocaleString() : 'none'} — {health.dataFreshness.staleRejectionCount} stale rejections (24h)
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-ink-400">Provider</div>
                    <div className="mt-1 text-sm text-ink-100">{health.provider ?? 'none'} — {health.isProviderAvailable ? 'Twelve Data (historical) — real production data' : 'unavailable (set TWELVE_DATA_API_KEY)'}</div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-ink-400">No health data</div>
              )}
            </div>
          </Card>

          {/* Last run detail */}
          {health?.lastRun && (
            <Card className="mb-6">
              <CardHeader title="Last Run" subtitle={`Run ${health.lastRun.id.slice(0, 8)} — ${health.lastRun.status}`} />
              <div className="px-5 py-4 text-sm">
                <div className="grid gap-2 md:grid-cols-3">
                  <div>Strategies: {health.lastRun.strategiesScanned}</div>
                  <div>Instruments: {health.lastRun.instrumentsScanned}</div>
                  <div>Candles: {health.lastRun.candlesFetched}</div>
                  <div>Setups detected: {health.lastRun.setupsDetected}</div>
                  <div>Setups created: {health.lastRun.setupsCreated}</div>
                  <div>Alerts: {health.lastRun.alertsCreated}</div>
                  <div>Stale rejections: {health.lastRun.staleRejections}</div>
                  <div>Provider failures: {health.lastRun.providerFailures}</div>
                  <div>Duration: {health.lastRun.finishedAt ? `${Math.round((new Date(health.lastRun.finishedAt).getTime() - new Date(health.lastRun.startedAt).getTime()) / 1000)}s` : 'running'}</div>
                </div>
                {health.lastRun.symbolsProcessed.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs uppercase tracking-wider text-ink-400">Symbols</div>
                    <div className="mt-1 text-xs text-ink-300">{health.lastRun.symbolsProcessed.join(', ')}</div>
                  </div>
                )}
                {health.lastRun.timeframesProcessed.length > 0 && (
                  <div className="mt-2">
                    <div className="text-xs uppercase tracking-wider text-ink-400">Timeframes</div>
                    <div className="mt-1 text-xs text-ink-300">{health.lastRun.timeframesProcessed.join(', ')}</div>
                  </div>
                )}
                {health.lastRun.error && (
                  <div className="mt-3 rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">{health.lastRun.error}</div>
                )}
              </div>
            </Card>
          )}

          {/* Runs list */}
          <Card>
            <CardHeader title="Recent Runs" subtitle="Observability — scan start/completion, provider latency/failure, symbols/timeframes, detection counts, alert creation, errors" />
            <div className="divide-y divide-ink-700">
              {runs === null ? (
                <div className="px-5 py-6 text-sm text-ink-400">Loading...</div>
              ) : runs.length === 0 ? (
                <div className="px-5 py-6 text-sm text-ink-400">No scanner runs yet. Trigger a scan to start processing real market data.</div>
              ) : (
                runs.map((run) => (
                  <div key={run.id} className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'danger' : run.status === 'running' ? 'info' : 'warning'}>{run.status}</Badge>
                      <span className="text-sm font-mono text-ink-100">{run.id.slice(0, 8)}</span>
                      <span className="text-xs text-ink-400">{new Date(run.startedAt).toLocaleString()}</span>
                      <span className="text-xs text-ink-400">— {run.providerSlug}</span>
                    </div>
                    <div className="mt-1 text-xs text-ink-400">
                      {run.strategiesScanned} strategies, {run.instrumentsScanned} instruments, {run.candlesFetched} candles, {run.setupsDetected} detections, {run.setupsCreated} created, {run.alertsCreated} alerts, {run.staleRejections} stale, {run.providerFailures} failures
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </>
      )}
    </AppShell>
  );
}

export default function ScannerPage() {
  return (
    <RequireAuth>
      <ScannerContent />
    </RequireAuth>
  );
}
