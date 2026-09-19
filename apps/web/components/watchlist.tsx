'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import { useWatchlist } from '@/lib/watchlist';
import type { MarketInstrument } from '@/lib/api';

export function WatchlistPanel({ instruments }: { instruments?: MarketInstrument[] }) {
  const { items, hydrated, remove, clear } = useWatchlist();

  if (!hydrated) {
    return (
      <Card>
        <CardHeader title="Watchlist" subtitle="Your selected markets — stored locally" />
        <div className="px-5 py-6 text-sm text-ink-400">Loading watchlist…</div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={`Watchlist (${items.length})`}
        subtitle="Local selection — no server write, used to filter scanner & markets"
        actions={
          items.length > 0 ? (
            <Button variant="ghost" onClick={clear}>
              Clear
            </Button>
          ) : undefined
        }
      />
      <div className="divide-y divide-ink-750">
        {items.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-ink-300">No markets in watchlist.</p>
            <p className="mt-1 text-xs text-ink-400">Add from Markets page — tap the star to track instruments you care about.</p>
            <Link href="/markets" className="mt-3 inline-block text-xs text-signal-400 hover:underline">
              Browse markets →
            </Link>
          </div>
        ) : (
          items.map((item) => (
            <div key={`${item.assetClass}/${item.symbol}`} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium text-ink-50">{item.symbol}</span>
                  <Badge tone="neutral">{item.assetClass}</Badge>
                </div>
                <div className="mt-0.5 text-[11px] text-ink-500">Added {new Date(item.addedAt).toLocaleDateString()}</div>
              </div>
              <Link
                href={`/markets/${item.assetClass}/${item.symbol}`}
                className="text-xs text-ink-400 hover:text-signal-400 hover:underline"
              >
                View
              </Link>
              <Button variant="ghost" onClick={() => remove(item.assetClass, item.symbol)}>
                Remove
              </Button>
            </div>
          ))
        )}
      </div>
      {instruments && items.length > 0 && (
        <div className="border-t border-ink-700 px-5 py-3 text-[11px] text-ink-500">
          {items.filter((w) => !instruments.some((i) => i.symbol === w.symbol && i.assetClass === w.assetClass)).length > 0
            ? 'Some watchlist items are not in current instrument list (may need backfill).'
            : 'All watchlist items found in market data.'}
        </div>
      )}
    </Card>
  );
}

export function MarketSelector({ instruments }: { instruments: MarketInstrument[]; onSelect?: (assetClass: string, symbol: string) => void }) {
  const { has, toggle } = useWatchlist();
  const [filter, setFilter] = React.useState('');
  const [assetFilter, setAssetFilter] = React.useState<string>('all');

  const assetClasses = React.useMemo(() => {
    const set = new Set(instruments.map((i) => i.assetClass));
    return ['all', ...Array.from(set)];
  }, [instruments]);

  const filtered = React.useMemo(() => {
    return instruments.filter((i) => {
      const matchesSearch = filter === '' || i.symbol.toLowerCase().includes(filter.toLowerCase()) || (i.displayName ?? '').toLowerCase().includes(filter.toLowerCase());
      const matchesAsset = assetFilter === 'all' || i.assetClass === assetFilter;
      return matchesSearch && matchesAsset;
    });
  }, [instruments, filter, assetFilter]);

  return (
    <Card>
      <CardHeader title={`Markets (${filtered.length}/${instruments.length})`} subtitle="Select instruments for scanner & watchlist — deterministic, no live trading" />
      <div className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search symbol or name…"
            className="w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-signal-500 focus:outline-none focus:ring-1 focus:ring-signal-500/50 sm:w-64"
          />
          <select
            value={assetFilter}
            onChange={(e) => setAssetFilter(e.target.value)}
            className="rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 focus:border-signal-500 focus:outline-none"
          >
            {assetClasses.map((ac) => (
              <option key={ac} value={ac}>
                {ac === 'all' ? 'All asset classes' : ac}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.slice(0, 60).map((inst) => {
            const starred = has(inst.assetClass, inst.symbol);
            return (
              <div
                key={`${inst.assetClass}/${inst.symbol}`}
                className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors ${starred ? 'border-signal-500/40 bg-signal-500/10' : 'border-ink-700 bg-ink-800 hover:bg-ink-750'}`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium text-ink-50">{inst.symbol}</span>
                    <span className="text-[11px] capitalize text-ink-400">{inst.assetClass}</span>
                  </div>
                  {inst.displayName && <div className="truncate text-[11px] text-ink-500">{inst.displayName}</div>}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => toggle(inst.assetClass, inst.symbol)}
                    className={`rounded px-1.5 py-1 text-xs transition-colors ${starred ? 'bg-signal-600 text-white' : 'bg-ink-700 text-ink-300 hover:bg-ink-600'}`}
                    title={starred ? 'Remove from watchlist' : 'Add to watchlist'}
                  >
                    {starred ? '★' : '☆'}
                  </button>
                  <Link href={`/markets/${inst.assetClass}/${inst.symbol}`} className="rounded bg-ink-700 px-2 py-1 text-xs text-ink-300 hover:bg-ink-600 hover:text-ink-100">
                    View
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
        {filtered.length > 60 && <p className="text-xs text-ink-500">Showing 60 of {filtered.length} — refine search to see more.</p>}
        {filtered.length === 0 && <p className="py-6 text-center text-sm text-ink-400">No instruments match your filter.</p>}
      </div>
    </Card>
  );
}
