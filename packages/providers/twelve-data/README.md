# `@veltrixeye/provider-twelve-data`

Twelve Data `MarketDataProvider` implementation — VeltrixEye's M2 primary
market-data source (historical OHLCV only).

Per [how-to-add-provider](../../../../docs/how-to-add-provider.md), this
package's only repo dependency is `@veltrixeye/contracts`. All vendor quirks
(query-string auth, stringly numbers, error envelopes, interval names, venue
pinning) stay inside this package; callers see normalized instruments,
epoch-ms candles, and `ProviderError` failures.

## Contents

| File | Responsibility |
|---|---|
| `client.ts` | Thin REST client: request shaping, zod response validation, error mapping, timeouts, client-side rate throttle |
| `provider.ts` | `MarketDataProvider`: range paging (≤5000/page), bar validation, resampling, symbol discovery |
| `symbols.ts` | Normalized ↔ vendor symbol mapping; native-interval table + resample plans |
| `datetime.ts` | Vendor wall-clock → epoch-ms (UTC) via Intl; request date formatting |
| `resample.ts` | Pure deterministic aggregation (3m ← 1m, 12h ← 1h, 3d ← 1d) |

## Configuration

```ts
import { createTwelveDataProvider } from '@veltrixeye/provider-twelve-data';

const provider = createTwelveDataProvider({
  apiKey: process.env.TWELVE_DATA_API_KEY, // server-side only, never logged
  baseUrl: 'https://api.twelvedata.com',
  timeoutMs: 15000,
  maxRequestsPerMinute: 50, // keep under the plan's credits/min
  cryptoExchange: 'Binance', // venue pinned for deterministic crypto series
});
registry.register(provider);
```

## Notes that matter

- **Historical only**: `capabilities.realtime === false`. `subscribeRealtime`
  throws; sessions return `[]`; market status returns `unknown`. Honest
  gaps, not fabricated data.
- **Lookback**: `maxLookbackDays: 2190` (1-minute bars exist from 2020-02-10;
  daily runs deeper). Retention caps in `@veltrixeye/contracts` stay inside
  this floor.
- **Volume**: null where the market reports none (spot FX). Resampling sums
  volume only when every member reports it.
- **Crypto venue**: changing `cryptoExchange` defines a different price
  series. The ingestion layer records the provider, not the venue — do not
  change the venue casually in production.
- **Licensing**: storing, displaying (Business/Venture+ plan), and deriving
  non-reverse-engineerable signals are permitted; redistribution is not.
  See [docs/provider-licensing.md](../../../../docs/provider-licensing.md).

## Tests

Fixture-driven, no network: `npm run test --workspace @veltrixeye/provider-twelve-data`.
Live verification is an operator step (ingest a small range, compare against
the vendor dashboard), never part of CI.
