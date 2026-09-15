'use client';

import * as React from 'react';
import type { BacktestRunDto, StrategySummaryDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Alert, Button, Card, CardHeader, Field, LinkButton, Select, Spinner } from '@/components/ui';
import { BacktestHistoryTable } from '@/components/backtest-history';
import { DEFAULT_BACKTESTS_PAGE_SIZE, backtestHistoryCopy } from '@/lib/backtest-form';
import { describeApiError } from '@/lib/api-errors';

/**
 * Backtest history (M6 Phase 4) — GET /api/backtests.
 *
 * Owner-scoped by the API: the list only ever contains the signed-in user's
 * runs, and the UI never derives ownership from an id.
 */
function BacktestsContent() {
  const [strategies, setStrategies] = React.useState<StrategySummaryDto[]>([]);
  const [strategyId, setStrategyId] = React.useState('');
  const [runs, setRuns] = React.useState<BacktestRunDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    api
      .listStrategies()
      .then(({ strategies: list }) => setStrategies(list))
      .catch(() => setStrategies([]));
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listBacktests({
        strategyId: strategyId || undefined,
        limit: DEFAULT_BACKTESTS_PAGE_SIZE,
      });
      setRuns(res.runs);
    } catch (err) {
      setRuns([]);
      setError(describeApiError(err, 'Could not load your backtests. Try again.'));
    } finally {
      setLoading(false);
    }
  }, [strategyId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppShell>
      <PageHeader
        title="Backtests"
        subtitle="Deterministic replays of your published strategy versions over stored candles"
        actions={
          <LinkButton href="/backtests/new">+ New backtest</LinkButton>
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
        <CardHeader title="Filter" subtitle={backtestHistoryCopy().subtitle} />
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
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
          <div className="flex items-end">
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </Button>
          </div>
        </div>
      </Card>

      {runs === null ? <Spinner label="Loading your backtests" /> : <BacktestHistoryTable runs={runs} />}

      <p className="mt-4 text-xs text-ink-500">
        A run reads the shared candle store only — it never calls a market-data provider and never writes a live setup.
        {backtestHistoryCopy().footnote}
      </p>
    </AppShell>
  );
}

export default function BacktestsPage() {
  return (
    <RequireAuth>
      <BacktestsContent />
    </RequireAuth>
  );
}
