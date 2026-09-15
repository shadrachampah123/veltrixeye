'use client';

import * as React from 'react';
import type { SetupDto, StrategySummaryDto, StrategyVersionSummaryDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Alert, Button, Card, CardHeader, Field, LinkButton, Select, Spinner } from '@/components/ui';
import { GenerateAlertPanel } from '@/components/generate-alert-panel';
import { SetupsTable } from '@/components/setup-panels';
import { describeApiError } from '@/lib/api-errors';
import {
  DEFAULT_SETUPS_PAGE_SIZE,
  SETUP_DIRECTION_FILTERS,
  SETUP_PAGE_SIZES,
  SETUP_STATE_FILTERS,
  type SetupPageSize,
} from '@/lib/workbench';

/**
 * Setups (M7.1) — GET /api/setups with the API's own filters.
 *
 * Owner-scoped by the API, and never derived from an id: the list only ever
 * contains the signed-in user's setups. Detection does not run on its own, so
 * an empty list is the expected state until a workbench run has detected one.
 * The generate-alert panel below is the existing M6 flow, reused unchanged.
 */
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

  React.useEffect(() => {
    api
      .listStrategies()
      .then(({ strategies: list }) => setStrategies(list))
      .catch(() => setStrategies([]));
  }, []);

  // The version filter is scoped to the chosen strategy: versions belong to a
  // strategy, and the API validates `versionId` against the caller's own rows.
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
        subtitle="Detected from your own published versions at an explicit anchor — no background scanner"
        actions={
          <>
            <LinkButton href="/workbench" variant="secondary">
              Strategy workbench
            </LinkButton>
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </Button>
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

      <Card className="mb-5">
        <CardHeader title="Filter" subtitle="Applied by the API — only your own setups are ever returned" />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Strategy">
            <Select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
              <option value="">All strategies</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Version" hint={strategyId === '' ? 'Choose a strategy first' : undefined}>
            <Select value={versionId} disabled={strategyId === ''} onChange={(e) => setVersionId(e.target.value)}>
              <option value="">All versions</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber} · {v.status}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="State">
            <Select value={state} onChange={(e) => setState(e.target.value)}>
              {SETUP_STATE_FILTERS.map((option) => (
                <option key={option.value || 'all'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Direction">
            <Select value={direction} onChange={(e) => setDirection(e.target.value)}>
              {SETUP_DIRECTION_FILTERS.map((option) => (
                <option key={option.value || 'both'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Page size">
            <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value) as SetupPageSize)}>
              {SETUP_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} setups
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {setups === null ? <Spinner label="Loading your setups" /> : <SetupsTable setups={setups} filtered={filtered} />}

      <p className="mt-4 text-xs text-ink-500">
        Setups appear only after an explicit detection run on a published version. Scoring and lifecycle transitions live on
        each setup’s detail page.
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
