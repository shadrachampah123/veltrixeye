'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Field, Select, Spinner } from '@/components/ui';
import type { CandlesResponseDto, CoverageDto, Timeframe } from '@veltrixeye/contracts';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
const LIMITS = [100, 500, 1000, 5000];

const TIMEFRAME_MINUTES: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '8h': 480,
  '12h': 720,
  '1d': 1440,
  '3d': 4320,
  '1w': 10080,
  '1M': 43200,
};

function formatCandleTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function InstrumentContent() {
  const params = useParams<{ assetClass: string; symbol: string }>();
  const assetClass = decodeURIComponent(params.assetClass);
  const symbol = decodeURIComponent(params.symbol).toUpperCase();

  const [timeframe, setTimeframe] = React.useState<Timeframe>('1d');
  const [limit, setLimit] = React.useState(500);
  const [data, setData] = React.useState<CandlesResponseDto | null>(null);
  const [coverage, setCoverage] = React.useState<CoverageDto[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    const to = Date.now();
    const minutes = TIMEFRAME_MINUTES[timeframe] ?? 1440;
    const from = to - limit * minutes * 60_000;
    Promise.all([
      api.getCandles({ assetClass, symbol, timeframe, from: String(from), to: String(to), limit: String(limit) }),
      api.getCoverage(),
    ])
      .then(([candles, cov]) => {
        setData(candles);
        setCoverage(cov.coverage.filter((c) => c.assetClass === assetClass && c.symbol === symbol));
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : 'Failed to load candles');
        setData(null);
      })
      .finally(() => setLoading(false));
  }, [assetClass, symbol, timeframe, limit]);

  React.useEffect(() => {
    load();
  }, [load]);

  const rows = React.useMemo(() => (data ? [...data.candles].reverse() : []), [data]);

  return (
    <AppShell>
      <PageHeader
        title={`${symbol} · ${assetClass}`}
        subtitle={data?.instrument.displayName ?? 'Historical candles (shared store)'}
        actions={
          <>
            <Link href="/markets">
              <Button variant="secondary">All markets</Button>
            </Link>
            <Button variant="secondary" onClick={load}>
              Refresh
            </Button>
          </>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Field label="Timeframe">
          <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Candles (latest first)">
          <Select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((n) => (
              <option key={n} value={String(n)}>
                {n.toLocaleString()}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {error && (
        <div className="mb-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : (
        data && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral">
                {data.candles.length.toLocaleString()} candles
              </Badge>
              {data.fetchedFromProvider ? (
                <Badge tone="info">fetched missing range from provider</Badge>
              ) : (
                <Badge tone="success">served from store</Badge>
              )}
              {coverage && coverage.length > 0 && (
                <span className="font-mono text-xs text-ink-400">
                  stored:{' '}
                  {coverage.map((c) => `${c.timeframe}=${c.candleCount.toLocaleString()}`).join(' · ')}
                </span>
              )}
            </div>

            <Card>
              <CardHeader title={`${symbol} · ${timeframe}`} subtitle="Open time is UTC · volume is null where the market reports none" />
              {rows.length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-ink-400">
                  No candles in this window yet. Run a backfill from the Markets page, or pick a
                  shorter lookback.
                </p>
              ) : (
                <div className="max-h-[560px] overflow-auto">
                  <table className="w-full font-mono text-xs">
                    <thead className="sticky top-0 bg-ink-800">
                      <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                        <th className="px-5 py-2.5 font-medium">Open (UTC)</th>
                        <th className="px-3 py-2.5 text-right font-medium">Open</th>
                        <th className="px-3 py-2.5 text-right font-medium">High</th>
                        <th className="px-3 py-2.5 text-right font-medium">Low</th>
                        <th className="px-3 py-2.5 text-right font-medium">Close</th>
                        <th className="px-3 py-2.5 text-right font-medium">Volume</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-750">
                      {rows.map((c) => {
                        const up = c.close >= c.open;
                        return (
                          <tr key={c.time} className="transition-colors hover:bg-ink-750/50">
                            <td className="px-5 py-1.5 text-ink-300">{formatCandleTime(c.time)}</td>
                            <td className="px-3 py-1.5 text-right text-ink-100">{c.open}</td>
                            <td className="px-3 py-1.5 text-right text-ink-100">{c.high}</td>
                            <td className="px-3 py-1.5 text-right text-ink-100">{c.low}</td>
                            <td className={`px-3 py-1.5 text-right ${up ? 'text-signal-400' : 'text-danger-450'}`}>
                              {c.close}
                            </td>
                            <td className="px-3 py-1.5 text-right text-ink-300">
                              {c.volume === null ? '—' : c.volume.toLocaleString()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="border-t border-ink-700 px-5 py-3 font-sans text-xs text-ink-400">
                Market data by Twelve Data.
              </p>
            </Card>
          </div>
        )
      )}
    </AppShell>
  );
}

export default function InstrumentPage() {
  return (
    <RequireAuth>
      <InstrumentContent />
    </RequireAuth>
  );
}
