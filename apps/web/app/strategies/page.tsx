'use client';

import * as React from 'react';
import Link from 'next/link';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardHeader, Spinner } from '@/components/ui';
import { formatDate, timeframesLabel } from '@/lib/formats';
import type { StrategyDetailDto } from '@veltrixeye/contracts';

function StrategiesContent() {
  const [strategies, setStrategies] = React.useState<StrategyDetailDto[] | null>(null);

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

  return (
    <AppShell>
      <PageHeader
        title="Strategies"
        subtitle="Define, version and publish your trading strategies"
        actions={
          <Link href="/strategies/new">
            <Button>+ New strategy</Button>
          </Link>
        }
      />

      {strategies === null ? (
        <Spinner />
      ) : strategies.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">No strategies yet.</p>
          <p className="mt-1 text-xs text-ink-400">
            Your reference strategy can be built here — and so can any other deterministic strategy.
          </p>
          <Link href="/strategies/new" className="mt-4 inline-block">
            <Button>Create a strategy</Button>
          </Link>
        </Card>
      ) : (
        <Card>
          <CardHeader title={`All strategies (${strategies.length})`} />
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5 font-medium">Current version</th>
                <th className="px-5 py-2.5 font-medium">Timeframes</th>
                <th className="px-5 py-2.5 font-medium">Updated</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-750">
              {strategies.map((s) => {
                const v = s.currentVersion;
                const draft = s.versions.find((x) => x.status === 'draft');
                return (
                  <tr key={s.id} className="transition-colors hover:bg-ink-750/50">
                    <td className="px-5 py-3">
                      <Link href={`/strategies/${s.id}`} className="font-medium text-ink-50 hover:text-signal-400">
                        {s.name}
                      </Link>
                      {s.description && (
                        <p className="mt-0.5 max-w-72 truncate text-xs text-ink-400">{s.description}</p>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {v ? (
                        <Badge tone="success">active</Badge>
                      ) : draft ? (
                        <Badge tone="warning">draft</Badge>
                      ) : (
                        <Badge tone="neutral">{s.status}</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs">
                      {v ? `v${v.versionNumber}` : draft ? `v${draft.versionNumber} (draft)` : '—'}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-ink-300">
                      {v ? timeframesLabel(v.config.timeframes ?? null) : '—'}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-400">{formatDate(s.updatedAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={draft ? `/strategies/${s.id}/edit` : `/strategies/${s.id}`}
                        className="text-xs text-signal-400 hover:underline"
                      >
                        {draft ? 'Edit draft' : 'View'}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
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
