'use client';

import * as React from 'react';
import type { SetupDto, StrategySummaryDto, StrategyVersionSummaryDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Alert, Button, Card, CardHeader, Field, LinkButton, Select, Spinner } from '@/components/ui';
import { GenerateAlertPanel } from '@/components/generate-alert-panel';
import { SetupsTable } from '@/components/setup-panels';
import { SetupCardGrid } from '@/components/setup-card';
import { SetupHistoryTimeline } from '@/components/signal-history';
import { describeApiError } from '@/lib/api-errors';
import {
  DEFAULT_SETUPS_PAGE_SIZE,
  SETUP_DIRECTION_FILTERS,
  SETUP_PAGE_SIZES,
  SETUP_STATE_FILTERS,
  type SetupPageSize,
} from '@/lib/workbench';
import { BRAND } from '@/lib/brand';

function SetupsContent() {
  const [strategies, setStrategies] = React.useState<StrategySummaryDto[]>([]);
  const [strategyId, setStrategyId] = React.useState('');
  const [versions, setVersions] = React.useState<StrategyVersionSummaryDto[]>([]);
  const [versionId, setVersionId] = React.useState('');
  const [state, setState] = React.useState('');
  const [direction, setDirection] = React.useState('');
  const [limit, setLimit] = React.useState<SetupPageSize>(DEFAULT_SETUPS_PAGE_SIZE);
  const [setups, setSetups] = React.useState<SetupDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [view, setView] = React.useState<'cards' | 'table' | 'timeline'>('cards');

  React.useEffect(() => {
    api
      .listStrategies()
      .then(({ strategies: list }) => setStrategies(list))
      .catch(() => setStrategies([]));
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (strategyId === '') {
      setVersions([]);
      setVersionId('');
      return () => {
        cancelled = true;
      };
    }
    api
      .getStrategy(strategyId)
      .then(({ strategy }) => {
        if (!cancelled) setVersions(strategy.versions);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [strategyId]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listSetups({
        strategyId: strategyId || undefined,
        versionId: versionId || undefined,
        state: state || undefined,
        direction: direction || undefined,
        limit,
      });
      setSetups(res.setups);
    } catch (err) {
      setSetups([]);
      setError(describeApiError(err, 'Could not load your setups. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [strategyId, versionId, state, direction, limit]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = strategyId !== '' || versionId !== '' || state !== '' || direction !== '';

  return (
    <AppShell>
      <PageHeader
        title="Setups"
        subtitle={`Detected from your published versions — market, direction, timeframe, entry, SL, TP, R/R, quality/conditions, status · ${BRAND.stage} safety preserved`}
        actions={
          <>
            <div className="flex items-center gap-1 rounded-md border border-ink-600 bg-ink-800 p-0.5">
              <button onClick={() => setView('cards')} className={`rounded px-2.5 py-1 text-xs font-medium ${view === 'cards' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}>Cards</button>
              <button onClick={() => setView('table')} className={`rounded px-2.5 py-1 text-xs font-medium ${view === 'table' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}>Table</button>
              <button onClick={() => setView('timeline')} className={`rounded px-2.5 py-1 text-xs font-medium ${view === 'timeline' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}>History</button>
            </div>
            <LinkButton href="/workbench" variant="secondary">Workbench</LinkButton>
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger" role="alert">{error}</Alert>
        </div>
      )}

      {/* Filter */}
      <Card className="mb-5">
        <CardHeader title="Filter & Workflow" subtitle="API-filtered · owner-scoped · HTF bias → setup → entry context" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Strategy">
            <Select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
              <option value="">All strategies</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Version" hint={strategyId === '' ? 'Choose a strategy first' : undefined}>
            <Select value={versionId} disabled={strategyId === ''} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">All versions</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>v{v.versionNumber} · {v.status}</option>
              ))}
            </Select>
          </Field>
          <Field label="State">
            <Select value={state} onChange={(e) => setState(e.target.value)}>
              {SETUP_STATE_FILTERS.map((option) => (
                <option key={option.value || 'all'} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Direction">
            <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
              {SETUP_DIRECTION_FILTERS.map((option) => (
                <option key={option.value || 'both'} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Page size">
            <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value) as SetupPageSize)}>
              {SETUP_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size} setups</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="border-t border-ink-700 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
            <span>Setup detail includes:</span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5">Market</span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5">Direction</span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5">Timeframe HTF→Setup→Entry</span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5">Entry / SL / TP / R:R</span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5">Quality / Conditions</span>
            <span className="rounded bg-ink-800 px-1.5 py-0.5">Status & Lifecycle</span>
          </div>
        </div>
      </Card>

      {setups === null ? (
        <Spinner label="Loading your setups" />
      ) : view === 'cards' ? (
        <SetupCardGrid setups={setups} />
      ) : view === 'table' ? (
        <SetupsTable setups={setups} filtered={filtered} />
      ) : (
        <SetupHistoryTimeline setups={setups} />
      )}

      <p className="mt-4 text-xs text-ink-500">
        Setups appear only after an explicit detection run on a published version at an explicit anchor. Scoring (M5) and lifecycle transitions (M4) live on each setup’s detail page. No background scanner creates setups on its own — scanner triggers evaluation pipeline.
      </p>

      <div className="mt-6">
        <GenerateAlertPanel />
      </div>
    </AppShell>
  );
}

export default function SetupsPage() {
  return (
    <RequireAuth>
      <SetupsContent />
    </RequireAuth>
  );
}
