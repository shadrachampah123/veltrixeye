'use client';

import * as React from 'react';
import Link from 'next/link';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth, useAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Card, CardHeader, Badge, Button, Spinner } from '@/components/ui';
import { formatDate, timeframesLabel } from '@/lib/formats';
import type { StrategyDetailDto } from '@veltrixeye/contracts';

function DashboardContent() {
  const { user } = useAuth();
  const [strategies, setStrategies] = React.useState<StrategyDetailDto[] | null>(null);

  React.useEffect(() => {
    api
      .listStrategies()
      .then(async ({ strategies: list }) => {
        const details = await Promise.all(list.map((s) => api.getStrategy(s.id).then((r) => r.strategy)));
        setStrategies(details);
      })
      .catch(() => setStrategies([]));
  }, []);

  const published = strategies?.filter((s) => s.currentVersion) ?? [];
  const drafts = strategies?.filter((s) => !s.currentVersion) ?? [];

  return (
    <AppShell>
      <PageHeader
        title={`Welcome back, ${user?.name ?? 'trader'}`}
        subtitle="Your strategy workspace"
        actions={
          <Link href="/strategies/new">
            <Button>+ New strategy</Button>
          </Link>
        }
      />

      {/* M2 status banner */}
      <div className="mb-6 rounded-lg border border-info-450/30 bg-info-450/10 px-4 py-3 text-sm text-info-450">
        <strong className="font-semibold">M2 market data.</strong> Historical candles are ingested and stored
        per instrument — explore them under Markets. Strategy evaluation, live scanning and alert delivery
        arrive in later milestones.
      </div>

      {strategies === null ? (
        <Spinner />
      ) : (
        <div className="grid gap-5 md:grid-cols-3">
          <StatCard label="Strategies" value={strategies.length} />
          <StatCard label="Published versions" value={published.length} />
          <StatCard label="In draft" value={drafts.length} />
        </div>
      )}

      <div className="mt-6">
        <Card>
          <CardHeader title="Recent strategies" subtitle="Latest activity across your strategies" />
          <div className="divide-y divide-ink-700">
            {strategies === null ? (
              <Spinner />
            ) : strategies.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm text-ink-400">You don’t have any strategies yet.</p>
                <Link href="/strategies/new" className="mt-3 inline-block">
                  <Button>Create your first strategy</Button>
                </Link>
              </div>
            ) : (
              strategies.map((s) => {
                const v = s.currentVersion;
                return (
                  <Link
                    key={s.id}
                    href={`/strategies/${s.id}`}
                    className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-ink-750"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-50">{s.name}</span>
                        {v ? (
                          <Badge tone="success">v{v.versionNumber} · live</Badge>
                        ) : (
                          <Badge tone="warning">draft</Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-400">
                        {v ? timeframesLabel(v.config.timeframes ?? null) : 'No published version yet'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right text-xs text-ink-400">
                      <div>updated</div>
                      <div className="text-ink-300">{formatDate(s.updatedAt)}</div>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card className="px-5 py-4">
      <div className="font-mono text-3xl text-ink-50">{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wider text-ink-400">{label}</div>
    </Card>
  );
}

export default function DashboardPage() {
  return (
    <RequireAuth>
      <DashboardContent />
    </RequireAuth>
  );
}
