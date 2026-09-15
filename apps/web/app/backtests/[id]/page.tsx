'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { BacktestRunDto, BacktestTrade } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, Card, Spinner } from '@/components/ui';
import {
  BacktestMetricsGrid,
  BacktestNotesList,
  BacktestRunSummary,
  BacktestTradesTable,
} from '@/components/backtest-results';
import { TRADES_PAGE_SIZES, type TradesPageSize } from '@/lib/backtest-form';
import { describeApiError } from '@/lib/api-errors';

/**
 * Backtest detail (M6 Phase 4).
 *
 * Consumes `GET /api/backtests/:id` for the run (metrics, policies, engine
 * notes) and `GET /api/backtests/:id/trades?limit=` for the trade list, so
 * paging stays inside the API's own 500-trade bound. A foreign or unknown id is
 * a masked 404 from the API and is rendered as "not found" — the UI never
 * infers ownership from the id in the URL.
 */
function BacktestDetailContent() {
  const params = useParams<{ id: string }>();
  const runId = params.id;

  const [run, setRun] = React.useState<BacktestRunDto | null>(null);
  const [trades, setTrades] = React.useState<BacktestTrade[] | null>(null);
  const [tradesTruncated, setTradesTruncated] = React.useState(false);
  const [limit, setLimit] = React.useState<TradesPageSize>(TRADES_PAGE_SIZES[0]);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setRun(null);
    setTrades(null);
    setNotFound(false);
    setError(null);
    api
      .getBacktest(runId)
      .then((detail) => {
        if (cancelled) return;
        setRun(detail.run);
        setTrades(detail.trades);
        setTradesTruncated(detail.truncated);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) setNotFound(true);
        else setError(describeApiError(err, 'Could not load this backtest.'));
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const loadMore = async (next: TradesPageSize) => {
    setLoadingMore(true);
    setError(null);
    try {
      const res = await api.getBacktestTrades(runId, next);
      setTrades(res.trades);
      setTradesTruncated(res.truncated);
      setLimit(next);
    } catch (err) {
      setError(describeApiError(err, 'Could not load more trades.'));
    } finally {
      setLoadingMore(false);
    }
  };

  if (notFound) {
    return (
      <AppShell>
        <Card className="px-6 py-14 text-center">
          <p className="text-sm text-ink-300">Backtest not found.</p>
          <p className="mt-1 text-xs text-ink-400">It may belong to another account, or it may never have existed.</p>
          <Link href="/backtests" className="mt-3 inline-block">
            <Button variant="secondary">Back to backtests</Button>
          </Link>
        </Card>
      </AppShell>
    );
  }

  const nextLimit = TRADES_PAGE_SIZES.find((s) => s > limit);

  return (
    <AppShell>
      <PageHeader
        title="Backtest result"
        subtitle="Deterministic replay output — R-multiples first, currency only when a risk per trade was supplied"
        actions={
          <Link href="/backtests">
            <Button variant="secondary">All backtests</Button>
          </Link>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {run === null ? (
        <Spinner />
      ) : (
        <div className="space-y-5">
          <BacktestRunSummary run={run} />
          <BacktestMetricsGrid metrics={run.metrics} showsCurrency={run.costPolicy.riskPerTrade !== undefined} />
          <BacktestNotesList notes={run.notes} />
          {trades === null ? (
            <Spinner />
          ) : (
            <BacktestTradesTable
              trades={trades}
              truncated={tradesTruncated}
              limit={limit}
              loadingMore={loadingMore}
              onLoadMore={nextLimit === undefined ? undefined : () => void loadMore(nextLimit)}
            />
          )}
        </div>
      )}
    </AppShell>
  );
}

export default function BacktestDetailPage() {
  return (
    <RequireAuth>
      <BacktestDetailContent />
    </RequireAuth>
  );
}
