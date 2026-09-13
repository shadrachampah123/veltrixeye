# Provider Abstraction

Market data providers (Yahoo, Alpha Vantage, TradingView, broker feeds,
anything) are **replaceable by design**. None is implemented in M1 — this
document is the contract a provider must satisfy.

TradingView is explicitly *not* the engine: the platform owns the
pipeline (market data → analysis → evaluation → setup → scoring → alerts)
and treats external data sources as interchangeable inputs.

## The interface

`packages/contracts/src/market-data.ts` defines:

```ts
interface MarketDataProvider {
  readonly id: string;             // stable machine id, e.g. "provider-example"
  readonly name: string;           // human-readable
  readonly capabilities: {
    historical: boolean;
    realtime: boolean;
    timeframes: readonly Timeframe[];   // canonical timeframes it can serve
    maxLookbackDays: number;            // Infinity = unlimited
  };
  getSymbols(query?: SymbolQuery): Promise<NormalizedInstrument[]>;
  getHistoricalCandles(req: HistoricalCandlesRequest): Promise<Candle[]>;
  subscribeRealtime(sub: RealtimeSubscription): RealtimeCandleStream;
  getTradingSessions(instrument: NormalizedInstrument): Promise<TradingSession[]>;
  getMarketStatus(instrument: NormalizedInstrument): Promise<MarketStatus>;
}
```

- `getHistoricalCandles` — bounded OHLCV for one instrument/timeframe
  (capped lookback; the caller paginates).
- `subscribeRealtime` — a cancellable live candle stream (M1 defines the
  type; no live ingestion runs).
- `getSymbols` — discovery, **always normalized** (see below).
- `getTradingSessions` — the session calendar (e.g. London/NY/Asia) for an
  instrument; feeds `session_requirement` and the UI's session filter.
- `getMarketStatus` — open/closed (+ next open/close) for an instrument.

## Normalized instruments — the anti-coupling layer

```
instruments (canonical: asset_class + symbol, e.g. forex/EURUSD)
        ▲
        │ referenced by strategies, setups, everything
        │
instrument_provider_symbols (the ONLY table that stores provider tickers)
        │
        ▼
data_providers (provider registry rows)
```

- Strategies, versions, setups, and engine logic reference
  `instruments.id` or `(asset_class, symbol)`.
- A provider's own ticker strings live **only** in
  `instrument_provider_symbols`. When a provider renames a symbol, the
  fix is a data update in one table — no strategy migration.
- Symbols are normalized on write: trimmed, uppercased, and validated
  (`instrumentSymbolSchema` in `packages/contracts/src/assets.ts`), so
  `eurusd` from one provider and `EURUSD` from another collide into the
  same row.

## ProviderRegistry (in-memory, M1 shape)

`packages/core/src/market-data/registry.ts` holds an
id → `MarketDataProvider` map:

- `register(provider)` — throws on duplicate id (fail fast on config
  errors).
- `get(id)`, `list()`, `size`.
- The registry starts **empty** in M1; boot-time wiring of real providers
  (from config/env, later milestones) will `register` implementations
  here. `GET /api/market-data/providers` lists what's registered.

## Adding a provider

See [how-to-add-provider.md](./how-to-add-provider.md) for the step-by-step.

## What this buys

- Swap Yahoo → Alpha Vantage → broker API without touching strategies,
  the engine, or the UI.
- Multi-provider: the same instrument can have symbols in several
  providers; the platform can reconcile/compare later.
- Determinism: strategies are provider-agnostic, so the same version
  evaluates identically regardless of which feed is attached.
