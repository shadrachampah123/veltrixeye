'use client';

import * as React from 'react';
import Link from 'next/link';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth, useAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Button, Card, CardHeader, Spinner } from '@/components/ui';
import { BRAND } from '@/lib/brand';
import type { StrategyDetailDto, SetupDto, ScannerHealthDto, BillingStateDto } from '@veltrixeye/contracts';
import { DashboardStats, DashboardRecentSetups, DashboardWorkflowIntro, DashboardScannerWorkspace } from '@/components/dashboard-widgets';
import { StrategyCardGrid } from '@/components/strategy-card';
import { WatchlistPanel } from '@/components/watchlist';
import { SubscriptionPanel } from '@/components/subscription-panel';

function DashboardContent() {
  const { user } = useAuth();
  const [strategies, setStrategies] = React.useState<StrategyDetailDto[] | null>(null);
  const [setups, setSetups] = React.useState<SetupDto[] | null>(null);
  const [scannerHealth, setScannerHealth] = React.useState<ScannerHealthDto | null>(null);
  const [billing, setBilling] = React.useState<BillingStateDto | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [stratList, setupList] = await Promise.all([
          api.listStrategies().then(async ({ strategies: list }) => {
            const details = await Promise.all(list.map((s) => api.getStrategy(s.id).then((r) => r.strategy)));
            return details;
          }),
          api.listSetups({ limit: 20 }).then((r) => r.setups),
        ]);
        if (cancelled) return;
        setStrategies(stratList);
        setSetups(setupList);
      } catch (e: any) {
        if (!cancelled) {
          setStrategies([]);
          setSetups([]);
          setError(e?.message ?? 'Failed to load dashboard data');
        }
      }

      try {
        const [health, bill] = await Promise.all([api.getScannerHealth(), api.getBillingState()]);
        if (!cancelled) {
          setScannerHealth(health);
          setBilling(bill);
        }
      } catch {
        // Non-critical — dashboard still renders without scanner/billing
        if (!cancelled) {
          setScannerHealth(null);
          setBilling(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = strategies === null || setups === null;

  return (
    <AppShell>
      <PageHeader
        title={`Welcome back, ${user?.name ?? 'trader'}`}
        subtitle={`${BRAND.name} · ${BRAND.tagline} · ${BRAND.stage} — deterministic scanner, no live trading`}
        actions={
          <>
            <Link href="/workbench">
              <Button variant="secondary">Workbench</Button>
            </Link>
            <Link href="/strategies/new">
              <Button>+ New strategy</Button>
            </Link>
          </>
        }
      />

      {/* M8.7 Safety banner — preserved */}
      <div className="mb-6 rounded-lg border border-signal-500/30 bg-signal-500/10 px-4 py-3 text-sm text-signal-400">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="font-semibold">{BRAND.stage} · Safety preserved.</strong>
          <span className="text-ink-300">
            Automation {BRAND.safety.automationDefault} · {BRAND.safety.executionNote} · {BRAND.safety.riskNote} · Drawdown protection active (daily 2%/3%, weekly 4%/6%, max 8%/10%).
          </span>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-danger-450/30 bg-danger-450/10 px-4 py-3 text-sm text-danger-450">{error}</div>
      )}

      {loading ? (
        <Spinner label="Loading dashboard" />
      ) : (
        <div className="space-y-6">
          {/* Stats */}
          <DashboardStats strategies={strategies!} setups={setups!} scannerHealth={scannerHealth} />

          {/* Workflow intro */}
          <DashboardWorkflowIntro />

          {/* Two-column: recent strategies + scanner workspace */}
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader
                  title="Your Strategies"
                  subtitle="Deterministic configs with HTF bias → setup → entry"
                  actions={
                    <Link href="/strategies" className="text-xs text-signal-400 hover:underline">
                      View all →
                    </Link>
                  }
                />
                <div className="p-4">
                  <StrategyCardGrid strategies={(strategies ?? []).slice(0, 3)} />
                  {(strategies?.length ?? 0) === 0 && (
                    <div className="mt-4 text-center">
                      <Link href="/strategies/new" className="inline-flex items-center justify-center rounded-md bg-signal-600 px-4 py-2 text-sm font-medium text-white hover:bg-signal-500">
                        Create first strategy
                      </Link>
                    </div>
                  )}
                </div>
              </Card>

              <DashboardRecentSetups setups={setups ?? []} />
            </div>

            <div className="space-y-6">
              <DashboardScannerWorkspace health={scannerHealth} />

              <WatchlistPanel />

              <SubscriptionPanel billing={billing} />

              {/* Quick actions */}
              <Card>
                <CardHeader title="Quick Actions" subtitle="Common workflows — all explicit, no automation" />
                <div className="space-y-2 p-4">
                  <Link href="/markets" className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5 text-sm hover:bg-ink-750">
                    <span className="text-ink-100">Browse Markets & Watchlist</span>
                    <span className="text-ink-500">→</span>
                  </Link>
                  <Link href="/workbench" className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5 text-sm hover:bg-ink-750">
                    <span className="text-ink-100">Evaluate → Detect → Score</span>
                    <span className="text-ink-500">→</span>
                  </Link>
                  <Link href="/setups" className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5 text-sm hover:bg-ink-750">
                    <span className="text-ink-100">Setup History & Lifecycle</span>
                    <span className="text-ink-500">→</span>
                  </Link>
                  <Link href="/trading" className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5 text-sm hover:bg-ink-750">
                    <span className="text-ink-100">Trading Safety & Paper Sim</span>
                    <span className="text-ink-500">→</span>
                  </Link>
                  <Link href="/settings" className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5 text-sm hover:bg-ink-750">
                    <span className="text-ink-100">Settings & Subscription</span>
                    <span className="text-ink-500">→</span>
                  </Link>
                </div>
              </Card>

              {/* Branding footer card */}
              <Card>
                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-signal-600 font-mono text-xs font-bold text-white">{BRAND.short}</div>
                    <div>
                      <div className="text-sm font-semibold text-ink-50">{BRAND.name}</div>
                      <div className="text-[11px] text-ink-400">{BRAND.description}</div>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                    <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Automation OFF</div>
                    <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Paper only</div>
                    <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Drawdown protected</div>
                    <div className="rounded bg-ink-850 px-2 py-1.5 text-ink-400">Kill-switch active</div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
