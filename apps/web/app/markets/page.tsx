'use client';

import * as React from 'react';
import Link from 'next/link';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError, type MarketInstrument, type RegisteredProvider } from '@/lib/api';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Spinner } from '@/components/ui';
import type { AssetClass, CoverageDto, Timeframe } from '@veltrixeye/contracts';
import { WatchlistPanel, MarketSelector } from '@/components/watchlist';
import { BRAND } from '@/lib/brand';

const GRID_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];
const BACKFILL_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '1d'];

function MarketsContent() {
  const [providers, setProviders] = React.useState<RegisteredProvider[] | null>(null);
  const [providerNote, setProviderNote] = React.useState<string | undefined>(undefined);
  const [instruments, setInstruments] = React.useState<MarketInstrument[] | null>(null);
  const [coverage, setCoverage] = React.useState<CoverageDto[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<'overview' | 'watchlist' | 'selector'>('overview');

  const load = React.useCallback(() => {
    setError(null);
    Promise.all([api.listProviders(), api.listInstruments(), api.getCoverage()])
      .then(([p, i, c]) => {
        setProviders(p.providers);
        setProviderNote(p.note);
        setInstruments(i.instruments);
        setCoverage(c.coverage);
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : 'Failed to load market data');
        setProviders([]);
        setInstruments([]);
        setCoverage([]);
      });
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const coverageByKey = React.useMemo(() => {
    const map = new Map<string, CoverageDto>();
    for (const c of coverage ?? []) map.set(`${c.assetClass}/${c.symbol}/${c.timeframe}`, c);
    return map;
  }, [coverage]);

  return (
    <AppShell>
      <PageHeader
        title="Markets"
        subtitle={`${BRAND.name} market workspace — watchlist, instrument selection, historical data store for deterministic strategies · ${BRAND.stage}`}
        actions={
          <>
            <div className="flex items-center gap-1 rounded-md border border-ink-600 bg-ink-800 p-0.5">
              <button onClick={() => setView('overview')} className={`rounded px-2.5 py-1 text-xs font-medium ${view === 'overview' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}>Overview</button>
              <button onClick={() => setView('watchlist')} className={`rounded px-2.5 py-1 text-xs font-medium ${view === 'watchlist' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}>Watchlist</button>
              <button onClick={() => setView('selector')} className={`rounded px-2.5 py-1 text-xs font-medium ${view === 'selector' ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}>Selector</button>
            </div>
            <Button variant="secondary" onClick={load}>Refresh</Button>
          </>
        }
      />

      {error && (
        <div className="mb-6">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {providers === null || instruments === null || coverage === null ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          {/* Provider + quick stats */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Data Provider" subtitle="Historical feed status — real production data, not mock" />
              <div className="px-5 py-4">
                {providers.length === 0 ? (
                  <div className="flex items-center gap-3">
                    <Badge tone="danger">offline</Badge>
                    <p className="text-sm text-ink-300">{providerNote ?? 'No market-data provider is registered.'}</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {providers.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center gap-3">
                        <span className="text-sm font-medium text-ink-50">{p.name}</span>
                        <Badge tone="success">connected</Badge>
                        {p.capabilities.historical ? <Badge tone="info">historical</Badge> : <Badge tone="warning">no history</Badge>}
                        {!p.capabilities.realtime && <Badge tone="neutral">no realtime (M2)</Badge>}
                        <span className="font-mono text-xs text-ink-400">{p.capabilities.timeframes.length} timeframes · {p.capabilities.maxLookbackDays}d lookback</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 text-xs text-ink-500">Market data by Twelve Data. Index values (e.g. SPX500) excluded — see docs. {BRAND.safety.executionNote}.</div>
              </div>
            </Card>
            <Card>
              <CardHeader title="Watchlist Quick" subtitle="Local selection — scanner & markets filter" />
              <div className="p-4">
                <WatchlistPanel instruments={instruments} />
              </div>
            </Card>
          </div>

          {view === 'watchlist' ? (
            <WatchlistPanel instruments={instruments} />
          ) : view === 'selector' ? (
            <MarketSelector instruments={instruments} />
          ) : (
            <>
              <Card>
                <CardHeader title={`Instruments (${instruments.length})`} subtitle="Normalized symbols with stored candle counts per timeframe — HTF bias → setup → entry uses these" />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                        <th className="px-5 py-2.5 font-medium">Instrument</th>
                        {GRID_TIMEFRAMES.map((tf) => (
                          <th key={tf} className="px-3 py-2.5 text-right font-medium">{tf}</th>
                        ))}
                        <th className="px-5 py-2.5">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-750">
                      {instruments.map((i) => (
                        <tr key={`${i.assetClass}/${i.symbol}`} className="transition-colors hover:bg-ink-750/50">
                          <td className="px-5 py-3">
                            <div className="font-medium text-ink-50">{i.symbol}</div>
                            <div className="text-xs capitalize text-ink-400">{i.assetClass}{i.displayName ? ` · ${i.displayName}` : ''}</div>
                          </td>
                          {GRID_TIMEFRAMES.map((tf) => {
                            const c = coverageByKey.get(`${i.assetClass}/${i.symbol}/${tf}`);
                            return (
                              <td key={tf} className="px-3 py-3 text-right font-mono text-xs text-ink-300">
                                {c ? c.candleCount.toLocaleString() : '—'}
                              </td>
                            );
                          })}
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <Link href={`/markets/${i.assetClass}/${i.symbol}`} className="text-xs text-signal-400 hover:underline">View</Link>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>

              <MarketSelector instruments={instruments} />

              <BackfillCard instruments={instruments} onDone={load} />
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}

function BackfillCard({ instruments, onDone }: { instruments: MarketInstrument[]; onDone: () => void }) {
  const [selected, setSelected] = React.useState<string[]>(() => instruments.slice(0, 2).map((i) => `${i.assetClass}/${i.symbol}`));
  const [timeframe, setTimeframe] = React.useState<Timeframe>('1d');
  const [days, setDays] = React.useState('30');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const toggle = (key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const run = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const to = Date.now();
      const from = to - Number(days) * 86_400_000;
      const res = await api.backfill({
        instruments: selected.map((key) => {
          const found = instruments.find((x) => `${x.assetClass}/${x.symbol}` === key);
          return { assetClass: (found?.assetClass ?? 'forex') as AssetClass, symbol: found?.symbol ?? '' };
        }),
        timeframes: [timeframe],
        from,
        to,
      });
      setResult(`${res.status}: ${res.candlesUpserted.toLocaleString()} candles stored across ${res.pairs.length} pair(s).`);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Backfill failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Manual Backfill" subtitle="Ingest bounded history — audited, no scheduler, HTF→setup→entry needs candles" />
      <div className="space-y-4 px-5 py-4">
        <Field label="Instruments" hint="SPX500 has no provider mapping and cannot be backfilled.">
          <div className="flex flex-wrap gap-2">
            {instruments.map((i) => {
              const key = `${i.assetClass}/${i.symbol}`;
              const active = selected.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggle(key)}
                  className={`rounded border px-2 py-1 font-mono text-xs transition-colors ${active ? 'border-signal-500/50 bg-signal-500/10 text-signal-400' : 'border-ink-600 bg-ink-850 text-ink-300 hover:text-ink-100'}`}
                >
                  {i.symbol}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timeframe">
            <Select value={timeframe} onChange={(e) => setTimeframe(e.target.value as Timeframe)}>
              {BACKFILL_TIMEFRAMES.map((tf) => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </Select>
          </Field>
          <Field label="Lookback (days)" hint="Must fit retention window.">
            <Input type="number" min={1} max={1825} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        {result && <Alert tone="success">{result}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <div>
          <Button onClick={() => void run()} disabled={busy || selected.length === 0}>{busy ? 'Backfilling…' : `Backfill ${selected.length} instrument(s)`}</Button>
        </div>
        <p className="text-xs text-ink-400">Retention: 1m 30d · 5m 90d · 15m 180d · 1h 1y · daily 5y. Ranges beyond retention rejected. M8.7 safety preserved — no live trading.</p>
      </div>
    </Card>
  );
}

export default function MarketsPage() {
  return (
    <RequireAuth>
      <MarketsContent />
    </RequireAuth>
  );
}
