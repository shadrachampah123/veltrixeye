'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { StrategyDetailDto, StrategyVersionDetailDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Card, CardHeader, LinkButton, Select, Spinner } from '@/components/ui';
import { VersionWorkbench } from '@/components/version-workbench';
import { describeApiError } from '@/lib/api-errors';
import { formatDate, timeframesLabel } from '@/lib/formats';
import { evaluableVersions, versionLabel } from '@/lib/workbench';

/**
 * Version workbench (M7.1) — the browser's path into M3 evaluation and M4
 * detection for one published strategy version.
 *
 * The strategy and the version are both loaded through owner-scoped endpoints,
 * so a foreign or unknown id is a masked 404 rendered as "not found": an id in
 * the URL never grants access. The version switcher only offers versions the
 * engines accept (published or deprecated, never a draft).
 */
function VersionWorkbenchContent() {
  const params = useParams<{ id: string; versionId: string }>();
  const router = useRouter();
  const strategyId = params.id;
  const versionId = params.versionId;

  const [strategy, setStrategy] = React.useState<StrategyDetailDto | null>(null);
  const [version, setVersion] = React.useState<StrategyVersionDetailDto | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setStrategy(null);
    setVersion(null);
    setNotFound(false);
    setError(null);
    Promise.all([api.getStrategy(strategyId), api.getVersion(strategyId, versionId)])
      .then(([strategyRes, versionRes]) => {
        if (cancelled) return;
        setStrategy(strategyRes.strategy);
        setVersion(versionRes.version);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) setNotFound(true);
        else setError(describeApiError(err, 'Could not load this strategy version.'));
      });
    return () => {
      cancelled = true;
    };
  }, [strategyId, versionId]);

  if (notFound) {
    return (
      <AppShell>
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">Strategy version not found.</p>
          <p className="mt-1 text-xs text-ink-400">It may belong to another account, or it may never have existed.</p>
          <LinkButton href="/workbench" variant="secondary" className="mt-3">
            Back to the workbench
          </LinkButton>
        </Card>
      </AppShell>
    );
  }

  const versions = strategy ? evaluableVersions(strategy) : [];
  const risk = version?.config.risk;
  const scope = version?.config.marketScope;

  return (
    <AppShell>
      <PageHeader
        title={strategy && version ? `${strategy.name} · v${version.versionNumber}` : 'Version workbench'}
        subtitle="Deterministic evaluation and setup detection at one explicit anchor"
        actions={
          <>
            {strategy && (
              <LinkButton href={`/strategies/${strategy.id}`} variant="secondary">
                Strategy detail
              </LinkButton>
            )}
            <LinkButton href="/setups" variant="secondary">
              All setups
            </LinkButton>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        </div>
      )}

      {strategy === null || version === null ? (
        error ? null : (
          <Spinner label="Loading the version workbench" />
        )
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Version"
              subtitle="Only published (or already deprecated, frozen) versions can be evaluated — a draft is rejected by the API"
              actions={
                <>
                  {version.status === 'draft' ? (
                    <Badge tone="warning">draft</Badge>
                  ) : version.isCurrent ? (
                    <Badge tone="success">current</Badge>
                  ) : (
                    <Badge tone="info">{version.status}</Badge>
                  )}
                </>
              }
            />
            <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-ink-300">
                  Switch version
                </span>
                <Select
                  value={version.id}
                  onChange={(e) => router.push(`/strategies/${strategy.id}/versions/${e.target.value}`)}
                >
                  {versions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {versionLabel(option)}
                    </option>
                  ))}
                </Select>
              </label>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-400">Timeframes</dt>
                  <dd className="text-right text-ink-100">{timeframesLabel(version.config.timeframes)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-400">Market scope</dt>
                  <dd className="text-right text-ink-100">
                    {scope
                      ? scope.mode === 'instruments'
                        ? `${scope.instruments?.length ?? 0} instrument(s)`
                        : 'all known instruments (capped per run)'
                      : 'not configured'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-400">Minimum risk:reward</dt>
                  <dd className="text-right font-mono text-ink-100">{risk ? risk.minRr : '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-400">Minimum quality score</dt>
                  <dd className="text-right font-mono text-ink-100">{risk ? risk.minQualityScore : '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-400">Published</dt>
                  <dd className="text-right text-ink-100">{formatDate(version.publishedAt)}</dd>
                </div>
              </dl>
            </div>
            {version.changelog && (
              <p className="border-t border-ink-750 px-5 py-3 text-xs text-ink-400">{version.changelog}</p>
            )}
          </Card>

          <VersionWorkbench strategy={strategy} version={version} />
        </div>
      )}
    </AppShell>
  );
}

export default function VersionWorkbenchPage() {
  return (
    <RequireAuth>
      <VersionWorkbenchContent />
    </RequireAuth>
  );
}
