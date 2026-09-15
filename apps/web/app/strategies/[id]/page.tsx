'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Monospace, Spinner } from '@/components/ui';
import { formatDate, formatDateTime } from '@/lib/formats';
import type { StrategyDetailDto, StrategyVersionDetailDto } from '@veltrixeye/contracts';

function StrategyDetailContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [strategy, setStrategy] = React.useState<StrategyDetailDto | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    api
      .getStrategy(params.id)
      .then((r) => setStrategy(r.strategy))
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) setNotFound(true);
        else setError('Failed to load strategy');
      });
  }, [params.id]);

  React.useEffect(() => {
    load();
  }, [load]);

  const draft = strategy?.versions.find((v) => v.status === 'draft') ?? null;
  const current = strategy?.currentVersion ?? null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <AppShell>
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">Strategy not found.</p>
          <Link href="/strategies" className="mt-3 inline-block">
            <Button variant="secondary">Back to strategies</Button>
          </Link>
        </Card>
      </AppShell>
    );
  }

  if (!strategy) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title={strategy.name}
        subtitle={strategy.description ?? 'No description'}
        actions={
          <>
            {draft && (
              <Link href={`/strategies/${strategy.id}/edit`}>
                <Button variant="secondary">Edit draft v{draft.versionNumber}</Button>
              </Link>
            )}
            <Button
              disabled={busy || !draft}
              onClick={() =>
                draft &&
                void act(async () => {
                  await api.publishVersion(strategy.id, draft.id);
                  router.refresh();
                })
              }
            >
              {draft ? `Publish v${draft.versionNumber}` : 'No draft to publish'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* Current version */}
          <Card>
            <CardHeader
              title="Current version"
              subtitle={current ? `v${current.versionNumber} · published ${formatDate(current.publishedAt)}` : 'Not published yet'}
              actions={
                current ? (
                  <Link
                    href={`/strategies/${strategy.id}/versions/${current.id}`}
                    className="text-xs text-signal-400 underline underline-offset-2"
                  >
                    Evaluate &amp; detect
                  </Link>
                ) : undefined
              }
            />
            {current ? (
              <VersionConfigView version={current} />
            ) : (
              <div className="px-5 py-8 text-center text-sm text-ink-400">
                No published version. Fill in the draft and publish it to make it the active definition.
              </div>
            )}
          </Card>

          {/* Version history */}
          <Card>
            <CardHeader
              title="Version history"
              subtitle="Published versions are immutable — changes require a new version"
              actions={
                <Button
                  variant="secondary"
                  disabled={busy || !!draft}
                  title={draft ? 'Resolve the existing draft first (publish or discard it)' : undefined}
                  onClick={() =>
                    void act(async () => {
                      const source = current?.id ?? draft?.id;
                      await api.createVersion(strategy.id, { fromVersionId: source ?? undefined });
                    })
                  }
                >
                  + New version
                </Button>
              }
            />
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th className="px-5 py-2.5 font-medium">Version</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Changelog</th>
                  <th className="px-5 py-2.5 font-medium">Created</th>
                  <th className="px-5 py-2.5 font-medium">Published</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-750">
                {strategy.versions.map((v) => (
                  <tr key={v.id}>
                    <td className="px-5 py-2.5 font-mono text-xs">v{v.versionNumber}</td>
                    <td className="px-5 py-2.5">
                      {v.status === 'published' ? (
                        v.isCurrent ? <Badge tone="success">current</Badge> : <Badge tone="info">published</Badge>
                      ) : v.status === 'draft' ? (
                        <Badge tone="warning">draft</Badge>
                      ) : (
                        <Badge tone="neutral">deprecated</Badge>
                      )}
                    </td>
                    <td className="max-w-52 truncate px-5 py-2.5 text-xs text-ink-300">{v.changelog ?? '—'}</td>
                    <td className="px-5 py-2.5 text-xs text-ink-400">{formatDate(v.createdAt)}</td>
                    <td className="px-5 py-2.5 text-xs text-ink-400">{formatDate(v.publishedAt)}</td>
                    <td className="px-5 py-2.5 text-right text-xs">
                      <span className="inline-flex items-center gap-3">
                        {v.status !== 'draft' && (
                          <Link
                            href={`/strategies/${strategy.id}/versions/${v.id}`}
                            className="text-ink-300 hover:text-signal-400"
                          >
                            Evaluate &amp; detect
                          </Link>
                        )}
                        {v.status === 'published' && v.isCurrent && (
                          <button
                            className="text-ink-400 hover:text-danger-450 disabled:opacity-50"
                            disabled={busy}
                            onClick={() => void act(() => api.deprecateVersion(strategy.id, v.id))}
                          >
                            Deprecate
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Strategy" />
            <dl className="space-y-3 px-5 py-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-400">Status</dt>
                <dd>
                  <Badge tone={strategy.status === 'active' ? 'success' : 'neutral'}>{strategy.status}</Badge>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-400">Created</dt>
                <dd className="text-ink-200">{formatDate(strategy.createdAt)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-400">Versions</dt>
                <dd className="font-mono text-ink-200">{strategy.versions.length}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Lifecycle" subtitle="Setup states for this strategy's setups (M3+)" />
            <div className="flex flex-wrap gap-1.5 px-5 py-4">
              {['developing', 'watching', 'almost_ready', 'confirmed', 'triggered', 'completed', 'invalidated', 'expired'].map((s) => (
                <Badge key={s} tone={s === 'invalidated' || s === 'expired' ? 'danger' : s === 'completed' ? 'success' : 'neutral'}>
                  {s.replace('_', ' ')}
                </Badge>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Danger zone" />
            <div className="space-y-2 px-5 py-4">
              <p className="text-xs text-ink-400">
                Deleting a strategy with published versions is blocked to preserve traceability. Archive it instead.
              </p>
              <select
                className="w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100"
                value={strategy.status}
                disabled={busy}
                onChange={(e) => void act(() => api.updateStrategy(strategy.id, { status: e.target.value as StrategyDetailDto['status'] }))}
              >
                <option value="draft">Status: draft</option>
                <option value="active">Status: active</option>
                <option value="paused">Status: paused</option>
                <option value="archived">Status: archived</option>
              </select>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm('Delete this strategy and all of its draft versions?')) {
                    void act(async () => {
                      await api.deleteStrategy(strategy.id);
                      router.push('/strategies');
                    });
                  }
                }}
              >
                Delete strategy
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function VersionConfigView({ version }: { version: StrategyVersionDetailDto }) {
  const c = version.config;
  return (
    <div className="space-y-5 px-5 py-4">
      <div>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">Timeframes</h3>
        {c.timeframes ? (
          <div className="flex gap-2">
            <TfChip label="HTF bias" value={c.timeframes.htf_bias} />
            <TfChip label="Setup" value={c.timeframes.setup} />
            <TfChip label="Entry" value={c.timeframes.entry} />
          </div>
        ) : (
          <p className="text-sm text-ink-400">Not set</p>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">Market scope</h3>
        {c.marketScope?.mode === 'all' ? (
          <p className="text-sm text-ink-200">All instruments</p>
        ) : c.marketScope?.instruments ? (
          <div className="flex flex-wrap gap-1.5">
            {c.marketScope.instruments.map((i) => (
              <Badge key={`${i.assetClass}:${i.symbol}`} tone="neutral">
                <Monospace>{i.symbol}</Monospace>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-400">Not set</p>
        )}
      </div>

      {c.sessionFilters && c.sessionFilters.length > 0 && (
        <div>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">Session filters</h3>
          <div className="flex flex-wrap gap-1.5">
            {c.sessionFilters.map((s) => (
              <Badge key={`${s.session}-${s.mode}`} tone={s.mode === 'exclude' ? 'danger' : 'info'}>
                {s.mode} {s.session}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">Risk</h3>
        {c.risk ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm md:grid-cols-3">
            <RiskItem label="Min R:R" value={`1 : ${c.risk.minRr}`} />
            <RiskItem label="Stop-loss" value={`${c.risk.stopLossMethod}${c.risk.stopLossBuffer > 0 ? ` +${c.risk.stopLossBuffer} ${c.risk.stopLossBufferUnit}` : ''}`} />
            <RiskItem label="Take-profit" value={c.risk.takeProfitMethod === 'rr' ? `1:${c.risk.tp1Rr} / 1:${c.risk.tp2Rr} / 1:${c.risk.tp3Rr}` : c.risk.takeProfitMethod} />
            <RiskItem label="Min quality score" value={String(c.risk.minQualityScore)} />
          </div>
        ) : (
          <p className="text-sm text-ink-400">Not set</p>
        )}
      </div>

      {c.filters && c.filters.length > 0 && (
        <div>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">Global filters</h3>
          <div className="flex flex-wrap gap-1.5">
            {c.filters.map((f) => (
              <Badge key={f.type} tone={f.enabled ? 'info' : 'neutral'}>
                {f.type}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-400">
          Rules — {c.ruleGroups.length} stage{c.ruleGroups.length === 1 ? '' : 's'},{' '}
          {c.ruleGroups.reduce((n, g) => n + g.conditions.length, 0)} condition
          {c.ruleGroups.reduce((n, g) => n + g.conditions.length, 1) === 1 ? '' : 's'}
        </h3>
        <div className="space-y-3">
          {c.ruleGroups.map((g, i) => (
            <div key={i} className="rounded-md border border-ink-700 bg-ink-850 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-ink-100">{g.name}</span>
                <Badge tone="neutral">{g.logic}</Badge>
              </div>
              <ul className="space-y-1">
                {g.conditions.map((cd, j) => (
                  <li key={j} className="flex items-center gap-2 text-xs">
                    <Badge
                      tone={
                        cd.classification === 'required'
                          ? 'success'
                          : cd.classification === 'confirmation'
                            ? 'info'
                            : cd.classification === 'disqualifying'
                              ? 'danger'
                              : 'neutral'
                      }
                    >
                      {cd.classification}
                    </Badge>
                    <span className="text-ink-200">{cd.conditionType.replaceAll('_', ' ')}</span>
                    <span className="text-ink-500">·</span>
                    <span className="text-ink-400">{cd.timeframeRole === 'any' ? 'any TF' : cd.timeframeRole}</span>
                  </li>
                ))}
                {g.conditions.length === 0 && <li className="text-xs text-ink-500">— empty stage —</li>}
              </ul>
            </div>
          ))}
          {c.ruleGroups.length === 0 && <p className="text-sm text-ink-400">No rules yet.</p>}
        </div>
      </div>

      <p className="text-[11px] text-ink-500">
        Created {formatDateTime(version.createdAt)}
        {version.publishedAt ? ` · Published ${formatDateTime(version.publishedAt)}` : ''}
      </p>
    </div>
  );
}

function TfChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-ink-600 bg-ink-850 px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="font-mono text-sm text-ink-50">{value.toUpperCase()}</div>
    </div>
  );
}

function RiskItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-ink-750 pb-1.5">
      <span className="text-xs text-ink-400">{label}</span>
      <Monospace>{value}</Monospace>
    </div>
  );
}

export default function StrategyDetailPage() {
  return (
    <RequireAuth>
      <StrategyDetailContent />
    </RequireAuth>
  );
}
