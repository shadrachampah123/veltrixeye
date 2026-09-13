# Market Data (M2) — Ingestion, Storage, Retrieval

M2 connects VeltrixEye to real market data: one primary provider (Twelve Data),
a global shared candle store, fetch-through reads, explicit backfills, and the
Markets UI. Historical only — no realtime, no scanner, no evaluation.

Licensing for everything below: [provider-licensing.md](./provider-licensing.md).
That document gates production operation; this one describes the mechanics.

## Architecture

```
Twelve Data REST ──► TwelveDataProvider ──► IngestionService ──► candles (Postgres)
  (time_series)        (normalize, page,        (fetch-through,      ▲
                        resample, validate)      backfill, prune)    │
                                                                     │ read
API: GET /api/market-data/candles ───────────────────────────────────┘
     GET /api/market-data/coverage   POST /api/market-data/backfill
Web: /markets (status, coverage, backfill) + /markets/[assetClass]/[symbol]
```

Dependency rules still hold: the provider package depends only on
`@veltrixeye/contracts`; core depends on the `MarketDataProvider` interface
(never the implementation); the API wires the concrete provider at boot; the
web app only calls HTTP.

## Universe (M2: 8 instruments)

| Normalized | Twelve Data symbol | Asset class |
|---|---|---|
| EURUSD | EUR/USD | forex |
| GBPUSD | GBP/USD | forex |
| USDJPY | USD/JPY | forex |
| XAUUSD | XAU/USD | commodity |
| BTCUSD | BTC/USD (Binance venue) | crypto |
| ETHUSD | ETH/USD (Binance venue) | crypto |
| AAPL | AAPL | stock |
| SPY | SPY | ETF |

Mappings live in `instrument_provider_symbols` (seeded by migration 0008) and
in the provider's symbol table — the two must agree. `index/SPX500` keeps its
M1 identifier row but has **no mapping and no candles** (S&P index licensing;
see provider-licensing.md). Crypto series are pinned to one venue
(`TWELVE_DATA_CRYPTO_EXCHANGE`, default Binance) so the stored series is
deterministic; changing the venue defines a different series.

## Intervals, resampling, timezones

Native vendor intervals: 1min, 5min, 15min, 30min, 1h, 2h, 4h, 8h, 1day,
1week, 1month. Three canonical timeframes are served by deterministic
epoch-aligned resampling: **3m ← 1m ×3, 12h ← 1h ×12, 3d ← 1d ×3**
(open = first open, close = last close, high/low = extremes, volume = sum
only when every member reports one, else null).

The vendor reports wall-clock datetimes in the listing venue's zone
(`meta.exchange_timezone`); the provider converts to epoch-ms (UTC) via Intl
(two passes, DST-safe) and never guesses. Storage, API, and UI all speak
epoch-ms (UTC); the UI renders UTC explicitly.

## Fetch-through reads

`GET /api/market-data/candles?assetClass&symbol&timeframe&from&to&limit`
(`from` inclusive, `to` exclusive, epoch-ms; default limit 500, max 5000):

1. Resolve the normalized instrument (unknown → 404).
2. Reject ranges starting before the retention cutoff (400).
3. Compare with stored earliest/latest: fetch the missing head `[from,
   earliest)` and/or tail `[latest, to)` from the provider (at most two
   calls) — the tail only fires when another full period fits past the
   last stored bar, otherwise the read is a pure cache hit. Validate,
   upsert, prune beyond retention, record an `ingestion_runs` row.
   Interior bars are assumed complete once written.
4. Read `[from, to)` from the store. A range holding more than `limit`
   candles is rejected (400) — never silently truncated.

The response reports `fetchedFromProvider` so callers (and tests) can tell
cache hits from fills. Reads are auth-gated and rate-limited (60/min/IP).

## Backfill (explicit, manual, audited)

`POST /api/market-data/backfill` with `{ instruments (≤8), timeframes, from,
to }`. The service validates instruments, per-timeframe retention, and the
50,000-candle estimate cap (over → 400 with split guidance), then fetches
pairs sequentially, upserts, prunes, and records one `ingestion_runs` row with
per-pair results (`completed` / `partial` / `failed`). One pair's failure does
not abort the others. Every backfill is also written to `audit_events`
(`market_data.backfill`). Rate limit: 5/min/IP. **No scheduler exists in M2**
— backfill plus fetch-through are the only writers.

## Retention (approved M2 policy)

| Timeframe | Max lookback |
|---|---|
| 1m, 3m | 30 days |
| 5m | 90 days |
| 15m, 30m | 180 days |
| 1h, 2h, 4h, 8h, 12h | 1 year |
| 1d, 3d, 1w, 1M | 5 years |

Anchors (1m/5m/15m/1H/daily) are the approved values; neighbors interpolate
conservatively. Retention is enforced three ways: reads and backfills reject
out-of-window ranges, and every write prunes rows older than the cutoff.
Storage stays bounded with no background jobs.

## Coverage + runs ledger

`GET /api/market-data/coverage` reports per instrument × timeframe counts and
earliest/latest timestamps — the UI's grid and any operator's first stop.
`ingestion_runs` records every fetch-through fill and backfill (trigger,
status, provider, request + per-pair results, counts, errors, acting user).
The candle table itself carries `provider_slug` + `fetched_at` provenance per
row.

## Failure semantics

Provider failures map to provider-agnostic errors (no keys, URLs, or vendor
internals leak): upstream outage/auth → `502 provider_unavailable`, upstream
rate limit → `429 rate_limited`, bad range → 400, unknown instrument → 404.
With no provider registered (missing API key), reads and backfills answer 502
with an actionable message; everything else keeps working. Invalid vendor
bars (non-finite, non-positive, OHLC-violating) fail the call — nothing
invalid is ever persisted (the table's CHECKs enforce the same invariants).

## Markets UI

`/markets`: provider status, instrument × timeframe coverage grid, manual
backfill card. `/markets/[assetClass]/[symbol]`: timeframe/limit selectors,
latest-first candle table (UTC), served-vs-fetched badge. Both carry the
"Market data by Twelve Data" attribution line. No raw-data export exists
(display only, per the licensing terms).

## M2 limitations (explicit)

- Historical only: `capabilities.realtime === false`; `subscribeRealtime`
  throws; no WebSockets anywhere.
- No session calendar or market-state upstream: `getTradingSessions`
  returns `[]`, `getMarketStatus` returns `unknown`. M3 sources sessions
  elsewhere; nothing is fabricated.
- `index/SPX500` excluded (index licensing). Crypto venue pinned (Binance).
- Fetch-through assumes interior completeness; deep-gap repair is via
  backfill (a gap ledger can come in M3 if the engine needs it).
- Vendor page size 5000/request; backfill cap 50,000/request — large
  histories are built with sequential bounded calls, never one giant one.
