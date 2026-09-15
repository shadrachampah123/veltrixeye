'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import type { BacktestRunDto } from '@veltrixeye/contracts';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Card, LinkButton, Spinner } from '@/components/ui';
import {
  BacktestMetricsGrid,
  BacktestNotesList,
  BacktestRunSummary,
  BacktestTradesTable,
} from '@/components/backtest-results';
import {
  applyTradesPage,
  nextTradesPageSize,
  type TradesPageSize,
  type TradesPageState,
} from '@/lib/backtest-form';
import { describeApiError } from '@/lib/api-errors';

/** First trade page requested, and the empty view it is applied to. */
const FIRST_TRADES_PAGE = 50 as const;
const EMPTY_TRADES_PAGE: TradesPageState = { trades: [], truncated: false, limit: FIRST_TRADES_PAGE };

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
  /** Trades currently shown, always the union of everything fetched so far. */
  const [page, setPage] = React.useState<TradesPageState | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setRun(null);
    setPage(null);
    setNotFound(false);
    setError(null);
    // The run (metrics, policies, notes) comes from the detail endpoint; the
    // trade list comes from the paged endpoint so that one response shape — and
    // therefore one meaning of `truncated` — drives the table.
    Promise.all([api.getBacktest(runId), api.getBacktestTrades(runId, FIRST_TRADES_PAGE)])
      .then(([detail, first]) => {
        if (cancelled) return;
        setRun(detail.run);
        setPage(
          applyTradesPage(EMPTY_TRADES_PAGE, {
            trades: first.trades,
            truncated: first.truncated,
            limit: FIRST_TRADES_PAGE,
          }),
        );
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

  /**
   * Fetch a larger page and MERGE it into what is on screen.
   *
   * A replacement would be wrong twice over: `GET /:id/trades?limit=N` returns
   * only the first N rows, so overwriting a fuller list silently deletes
   * trades the user was reading, and the limit-aware `truncated` flag would
   * then be reported as if the run itself were cut short.
   */
  const loadMore = async (next: TradesPageSize) => {
    setLoadingMore(true);
    setError(null);
    try {
      const res = await api.getBacktestTrades(runId, next);
      setPage((prev) =>
        applyTradesPage(prev ?? EMPTY_TRADES_PAGE, {
          trades: res.trades,
          truncated: res.truncated,
          limit: next,
        }),
      );
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
          <LinkButton href="/backtests" variant="secondary" className="mt-3">
            Back to backtests
          </LinkButton>
        </Card>
      </AppShell>
    );
  }

  const nextLimit = page ? nextTradesPageSize(page.trades.length) : undefined;

  return (
    <AppShell>
      <PageHeader
        title="Backtest result"
        subtitle="Deterministic replay output — R-multiples first, currency only when a risk per trade was supplied"
        actions={
          <LinkButton href="/backtests" variant="secondary">
            All backtests
          </LinkButton>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        </div>
      )}

      {run === null ? (
        <Spinner label="Loading backtest" />
      ) : (
        <div className="space-y-5">
          <BacktestRunSummary run={run} />
          <BacktestMetricsGrid metrics={run.metrics} showsCurrency={run.costPolicy.riskPerTrade !== undefined} />
          <BacktestNotesList notes={run.notes} />
          {page === null ? (
            <Spinner label="Loading trades" />
          ) : (
            <BacktestTradesTable
              trades={page.trades}
              truncated={page.truncated}
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
