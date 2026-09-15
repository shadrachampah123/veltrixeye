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

/**
 * Strategy workbench index (M7.1).
 *
 * The entry point of the core workflow: pick a PUBLISHED strategy version and
 * open its workbench. Draft versions are listed as blocked rather than hidden —
 * the API refuses to evaluate a draft, so the UI says so before a click.
 *
 * Everything is owner-scoped by the API; the page shows only the caller's
 * strategies and never runs anything by itself.
 */
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
        title="Strategy workbench"
        subtitle="Evaluate a published version, then detect setups from the same explicit anchor"
        actions={
          <LinkButton href="/setups" variant="secondary">
            All setups
          </LinkButton>
        }
      />

      <Card className="mb-5">
        <CardHeader title="The core workflow" subtitle="Four explicit steps — nothing runs on a schedule or in the background" />
        <ol className="grid gap-4 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <li>
            <div className="flex items-center gap-2">
              <Badge tone="info">1</Badge>
              <span className="font-medium text-ink-100">Evaluate</span>
            </div>
            <p className="mt-1 text-xs text-ink-400">
              The M3 engine scores every rule group and condition for each instrument in the version’s market scope at the
              anchor you set. Store-only — no provider call.
            </p>
          </li>
          <li>
            <div className="flex items-center gap-2">
              <Badge tone="info">2</Badge>
              <span className="font-medium text-ink-100">Detect</span>
            </div>
            <p className="mt-1 text-xs text-ink-400">
              M4 persists one setup per qualifying direction at the same anchor. Repeating it returns the existing setup
              instead of creating a second one.
            </p>
          </li>
          <li>
            <div className="flex items-center gap-2">
              <Badge tone="info">3</Badge>
              <span className="font-medium text-ink-100">Score &amp; transition</span>
            </div>
            <p className="mt-1 text-xs text-ink-400">
              M5 scores the setup’s quality, and the M4 state machine moves it along the lifecycle. The API is the final
              authority for both.
            </p>
          </li>
          <li>
            <div className="flex items-center gap-2">
              <Badge tone="info">4</Badge>
              <span className="font-medium text-ink-100">Alert</span>
            </div>
            <p className="mt-1 text-xs text-ink-400">
              Generate an alert from the setup, then acknowledge it. Delivery in this milestone is a local stub ledger —
              no email, webhook or push is sent.
            </p>
          </li>
        </ol>
      </Card>

      {error && (
        <div className="mb-4">
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        </div>
      )}

      {strategies === null ? (
        <Spinner label="Loading your strategies" />
      ) : strategies.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">You do not have any strategies yet.</p>
          <p className="mt-1 text-xs text-ink-400">
            A strategy version must exist and be published before it can be evaluated.
          </p>
          <Link href="/strategies/new" className="mt-4 inline-block">
            <span className="text-xs text-signal-400 underline underline-offset-2">Create a strategy</span>
          </Link>
        </Card>
      ) : withVersions.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">No published version yet.</p>
          <p className="mt-1 text-xs text-ink-400">
            Only published versions can be evaluated or detected — publish a draft version first.
          </p>
          <Link href="/strategies" className="mt-4 inline-block">
            <span className="text-xs text-signal-400 underline underline-offset-2">Go to your strategies</span>
          </Link>
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
                  actions={
                    <Link href={`/strategies/${strategy.id}`} className="text-xs text-ink-300 underline underline-offset-2">
                      Strategy detail
                    </Link>
                  }
                />
                <ul className="divide-y divide-ink-750">
                  {evaluableVersions(strategy).map((version) => (
                    <li key={version.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm text-ink-50">v{version.versionNumber}</span>
                          {version.isCurrent ? (
                            <Badge tone="success">current</Badge>
                          ) : version.status === 'published' ? (
                            <Badge tone="info">published</Badge>
                          ) : (
                            <Badge tone="neutral">deprecated</Badge>
                          )}
                          <span className="text-xs text-ink-400">
                            {version.status === 'deprecated'
                              ? 'frozen — still evaluable'
                              : `published ${formatDate(version.publishedAt)}`}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-ink-400">
                          {version.changelog ?? 'No changelog'} · {timeframesLabel(strategy.currentVersion?.config.timeframes ?? null)}
                        </p>
                      </div>
                      <LinkButton href={`/strategies/${strategy.id}/versions/${version.id}`}>
                        Open workbench
                      </LinkButton>
                    </li>
                  ))}
                </ul>
                {draft && (
                  <p className="border-t border-ink-750 px-5 py-3 text-xs text-ink-400">
                    v{draft.versionNumber} is still a draft — it cannot be evaluated or detected until it is published.
                  </p>
                )}
              </Card>
            );
          })}

          {withoutVersions.length > 0 && (
            <Card>
              <CardHeader title="Waiting on a published version" subtitle="Draft-only strategies" />
              <ul className="divide-y divide-ink-750">
                {withoutVersions.map((strategy) => {
                  const draft = draftVersion(strategy);
                  return (
                    <li key={strategy.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/strategies/${strategy.id}`}
                          className="text-sm font-medium text-ink-50 hover:text-signal-400"
                        >
                          {strategy.name}
                        </Link>
                        <p className="mt-0.5 text-xs text-ink-400">
                          {draft ? `Draft v${draft.versionNumber} is unpublished.` : 'No versions yet.'} Publish a version
                          to make it evaluable.
                        </p>
                      </div>
                      <LinkButton href={`/strategies/${strategy.id}`} variant="secondary">
                        Open strategy
                      </LinkButton>
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
