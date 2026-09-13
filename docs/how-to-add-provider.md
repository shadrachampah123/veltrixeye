# How to Add a Market-Data Provider

M1 ships the provider **contract** (the `MarketDataProvider` interface),
the **registry** (`ProviderRegistry`), and the **normalized instrument
model** — but no provider. Adding a real provider is therefore an
**additive** task: create a package, implement the interface, register it,
and seed symbol mappings. No domain code (engine, scanner, UI) changes.

See [provider-abstraction.md](./provider-abstraction.md) for the design
and the "why".

## 1. Create the provider package

`packages/providers/<name>/` — a small package whose **only** dependency
on the repo is `@veltrixeye/contracts`. Provider-specific concerns (API
quirks, rate-limit logic, auth, licensing) live **inside** this package
and must never leak into the domain.

## 2. Implement `MarketDataProvider`

Checklist, per member:

- `id` — stable machine id, e.g. `"provider-example"`. Never change once
  released.
- `name` — human-readable, e.g. `"Example Data"`.
- `capabilities` — be **honest**: `historical`, `realtime`, the canonical
  `timeframes[]` you can serve, and `maxLookbackDays` (`Infinity` =
  unlimited). The engine relies on these.
- `getSymbols(query?)` → `NormalizedInstrument[]` — discovery, **always
  normalized** (map provider tickers to `assetClass` + canonical symbol).
- `getHistoricalCandles(request)` → `Candle[]` — bounded OHLCV; epoch-ms
  UTC timestamps; `state` is `closed` or `forming`. Respect
  `maxLookbackDays`; the caller paginates.
- `subscribeRealtime(subscription)` → `RealtimeCandleStream` — an
  `AsyncIterable<Candle>` that **must be cancellable** via `close()`.
- `getTradingSessions(instrument)` → `TradingSession[]`.
- `getMarketStatus(instrument)` → `MarketStatus`.

## 3. Keep provider symbols out of the domain

- Map every provider ticker to a normalized instrument. Symbols are
  normalized on the way in (trim + uppercase) — reuse
  `instrumentSymbolSchema` from `@veltrixeye/contracts`.
- If a symbol isn't in `instruments` yet, upsert it, then record the
  mapping in `instrument_provider_symbols`
  (`provider_id` + `provider_symbol` → `instrument_id`).
- **Never** write a provider ticker string into strategy configuration or
  any domain table.

## 4. Register it at boot

```ts
import { createProviderRegistry } from '@veltrixeye/core';
import { exampleProvider } from '@veltrixeye/providers-example';

const registry = createProviderRegistry();
registry.register(exampleProvider); // throws on duplicate id
```

Also insert a `data_providers` row
(`slug`, `display_name`, `status = 'active'`). `GET
/api/market-data/providers` will then list it.

## 5. Test it

- **Unit**: symbol → normalized-instrument mapping and normalization.
- **Integration**: register in a `ProviderRegistry`, call
  `getHistoricalCandles` against real/sandbox data, and assert the output
  is normalized, bounded, and correctly typed.

## Pitfalls

- Storing provider tickers in strategy config (breaks provider-agnosticism).
- Lying about `capabilities` (engine requests timeframes you can't serve).
- Forgetting `close()` on the realtime stream (leaked connections).
- Returning non-canonical timeframe labels.
- Surfacing provider-specific errors instead of provider-agnostic ones.
