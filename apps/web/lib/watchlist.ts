'use client';

import * as React from 'react';

export interface WatchlistItem {
  assetClass: string;
  symbol: string;
  addedAt: number;
}

const STORAGE_KEY = 'veltrixeye:watchlist';

function readStorage(): WatchlistItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WatchlistItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((i) => typeof i.symbol === 'string' && typeof i.assetClass === 'string');
  } catch {
    return [];
  }
}

function writeStorage(items: WatchlistItem[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore quota
  }
}

export function useWatchlist() {
  const [items, setItems] = React.useState<WatchlistItem[]>(() => readStorage());
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    setItems(readStorage());
    setHydrated(true);
  }, []);

  const save = React.useCallback((next: WatchlistItem[]) => {
    setItems(next);
    writeStorage(next);
  }, []);

  const add = React.useCallback(
    (assetClass: string, symbol: string) => {
      const key = `${assetClass}/${symbol}`;
      if (items.some((i) => `${i.assetClass}/${i.symbol}` === key)) return;
      const next = [...items, { assetClass, symbol, addedAt: Date.now() }];
      save(next);
    },
    [items, save],
  );

  const remove = React.useCallback(
    (assetClass: string, symbol: string) => {
      const key = `${assetClass}/${symbol}`;
      const next = items.filter((i) => `${i.assetClass}/${i.symbol}` !== key);
      save(next);
    },
    [items, save],
  );

  const toggle = React.useCallback(
    (assetClass: string, symbol: string) => {
      const key = `${assetClass}/${symbol}`;
      if (items.some((i) => `${i.assetClass}/${i.symbol}` === key)) {
        remove(assetClass, symbol);
      } else {
        add(assetClass, symbol);
      }
    },
    [items, add, remove],
  );

  const has = React.useCallback(
    (assetClass: string, symbol: string) => {
      const key = `${assetClass}/${symbol}`;
      return items.some((i) => `${i.assetClass}/${i.symbol}` === key);
    },
    [items],
  );

  const clear = React.useCallback(() => {
    save([]);
  }, [save]);

  return { items, hydrated, add, remove, toggle, has, clear };
}
