# Live Scanner — Production Market Flow (M7.5)

M7.5 turns the explicitly-invoked detection path (M4) into a production scanner that processes **real market data** through the complete existing strategy pipeline:

```
Market Data
→ Normalization
→ Validation/Freshness Checks
→ Strategy Detection
→ Setup Qualification
→ Scoring
→ Risk/Quality Validation
→ Alert Generation
→ Notification Outbox
```

## Production Market-Data Provider

**Provider in production: Twelve Data (historical OHLCV)**

- Implementation: `packages/providers/twelve-data` — `TwelveDataProvider` implements `MarketDataProvider` (historical only, `realtime: false`)
- Registered at boot when `TWELVE_DATA_API_KEY` is set (server-side only, never logged, never sent to browsers)
- The API boots without a key (dev/test or unkeyed deploy) and market-data routes answer 502 until a key is set
- All 14 canonical timeframes served: native vendor intervals where they exist (1m…1M), deterministic epoch-aligned resampling otherwise (3m ← 1m, 12h ← 1h, 3d ← 1d)
- Crypto series pinned to one venue (`TWELVE_DATA_CRYPTO_EXCHANGE`, default `Binance`) so stored series is deterministic
- No mock/demo data is ever substituted in production — provider must exist, otherwise scanner reports `unavailable`
- Development/test fixtures are clearly distinguished: `MockProvider` in tests, never used in production code path

See `docs/provider-abstraction.md` and `docs/market-data.md` for the abstraction and licensing.

## Scanner Execution Mechanism / Frequency

**Mechanism:**

- Database-backed advisory locking: `pg_try_advisory_lock(875421009)` — pinned key `SCANNER_ADVISORY_LOCK_KEY`
- Only one scanner run executes at a time across all processes/instances; concurrent triggers return `skipped: true, reason: 'already_running'` with last run info
- Runs are recorded in `scanner_runs` table (append-only ledger): status `running → completed|failed|partial`, provider slug, metrics, error, metadata
- Cursors in `scanner_cursors` table: per `(strategy_version_id, instrument_id, timeframe)` last processed candle time — prevents re-processing same closed candle, survives restarts
- Recovery on restart: `recoverStaleRuns()` marks runs older than 30 minutes that are still `running` as `failed` (crash/deploy safety)
- In-process ticker (optional): when `SCANNER_ENABLED=true`, the API starts an interval timer (`SCANNER_INTERVAL_MS`) that calls `scanner.runOnce()` — safe to run alongside manual triggers due to advisory locking
- Manual trigger via `POST /api/scanner/trigger` (session-authenticated, entitlement-gated, rate limited 10/min)

**Frequency:**

- Expected interval: **5 minutes** (`SCANNER_EXPECTED_INTERVAL_MS = 300_000`)
- Configurable via `SCANNER_INTERVAL_MS` (30s–1h, default 5m)
- Actual frequency depends on deployment: if `SCANNER_ENABLED=false` (dev default), scanner only runs when manually triggered; in production, enable with `SCANNER_ENABLED=true`
- The scanner itself does not enforce a cron — it is invoked by the ticker or external scheduler; advisory locking ensures no overlapping duplicate scans

**Duplicate Prevention:**

- **Scanner-level:** advisory lock + cursor check — if latest setup timeframe candle time equals `scanner_cursors.last_candle_time`, skip instrument
- **Setup-level:** `setups` table unique key `(strategy_version_id, instrument_id, direction, as_of_ms)` — `ON CONFLICT DO NOTHING`, concurrent duplicates serialize, loser returns winner's row, exactly one setup per detection key
- **Alert-level:** `alerts` table unique key `(setup_id, trigger_state)` — at most two alerts per setup (`confirmed` + `triggered`), replays return existing alert, no second ledger row
- **Notification-level:** `notification_deliveries` unique key `(alert_id, channel)` — one outbox job per alert and channel, replays collapse

**Failure/Retry Behavior:**

- Provider timeout: wrapped in `withTimeout(providerTimeoutMs)`, throws `Provider timeout after Xms`, retried with bounded exponential backoff
- Provider errors: `rate_limited`, `unavailable`, `unauthorized`, `not_found`, `invalid_request` mapped to domain errors; retryable failures retried up to `SCANNER_MAX_RETRIES` (default 3) with base `1s`, max `10s`, jitter 500ms
- Malformed provider response: `toCandle` validates every bar (finite, positive, OHLC invariant, non-negative volume); invalid bar throws `ProviderError('unavailable')`, fails the call loudly, no partial persistence
- Missing symbol: validated against `instruments` table (platform universe); arbitrary unsupported symbols rejected with 400 `Unsupported instrument — not in market universe`
- Stale data: checked via `checkFreshness` and `checkMultiTimeframeFreshness` — stale data never generates alerts, counted as `stale_rejections`, logged for observability
- Database failure: transaction rollback, run marked `failed` or `partial`, error recorded, no alert created when required data cannot be trusted
- Scanner worker restart: stale `running` runs recovered at boot, cursors survive restart, advisory lock released on disconnect
- Avoid runaway retries: bounded retry count, exponential backoff capped, no infinite loops, `MAX_PAGES_PER_CALL` guard in provider

## Symbols / Timeframes Supported

**Symbols (market universe, from migration 0002):**

- `forex/EURUSD`, `forex/GBPUSD`, `forex/USDJPY`
- `commodity/XAUUSD` (Gold)
- `index/SPX500` (excluded from ingestion due to licensing, but exists in universe)
- `crypto/BTCUSD`, `crypto/ETHUSD`
- `stock/AAPL`
- `etf/SPY`

Users cannot select arbitrary unsupported provider symbols to bypass the market universe — symbols are validated against `instruments` table, and provider-specific tickers live only in `instrument_provider_symbols`.

**Timeframes (canonical, from `TIMEFRAMES`):**

- `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`

**Strategy requirements (preserved):**

- HTF: `4h` / `1d` (higher-timeframe bias)
- Setup: `1h` (setup timeframe)
- Entry: `15m` / `5m` (entry timeframe)

Scanner supports the full canonical set but enforces that a strategy version has valid `htf_bias`, `setup`, `entry` timeframes assigned (normalized via `normalizeTimeframe` handling variants like `4H`, `1D`, `60m`).

**Normalization:**

- Symbol identifiers: uppercase, regex `/^[A-Z0-9][A-Z0-9._:-]*$/`, max 32 chars, asset class validated against `ASSET_CLASSES`
- Exchange/provider symbol formats: `toTwelveSymbol` / `fromTwelveSymbol` in provider package (e.g., `EURUSD` → `EUR/USD` for Twelve Data)
- Timeframe identifiers: `normalizeTimeframe` handles `1m`, `4H`, `1D`, `60m` → canonical `1m`, `4h`, `1d`, `1h` via `TIMEFRAME_ALIASES` and contract parser
- Timestamps: epoch milliseconds UTC, positive integer, max `9_999_999_999_999`
- OHLCV values: positive finite numbers, OHLC invariant `low ≤ open/close ≤ high`, volume null or non-negative finite, impossible prices >1e9 rejected

## Stale-Data Policy

**Never generate a trading alert from invalid or stale market data.**

- Thresholds per timeframe (`STALE_THRESHOLDS_MS`):
  - `1m`: 5m, `3m`: 10m, `5m`: 15m, `15m`: 45m, `30m`: 90m
  - `1h`: 2h, `2h`: 4h, `4h`: 8h, `8h`: 16h, `12h`: 24h
  - `1d`: 36h, `3d`: 4d, `1w`: 8d, `1M`: 35d
- Freshness check: `nowMs - latestCandleTime` vs threshold; future candles (clock skew) also rejected
- Multi-timeframe: all required timeframes must be fresh; HTF context missing, setup timeframe missing, or entry timeframe missing → stale rejection, no alert
- Incomplete responses: if requested range much larger than actual and received count <10, flagged as `incomplete_candle_response`
- Stale rejections are recorded in `scanner_runs.stale_rejections` and logged with structured info (instrument, timeframe, age, reason) without secrets
- Provider latency/failure also logged: `provider latency`, `provider failure`, `stale data rejected`, `detection counts`, `alert creation`, `scanner errors`

## Observability

Structured operational information (no secrets, no excessive raw payloads):

- Scan start/completion: `scan started` with runId, provider, strategyId, force, nowMs; `scan completed` with status, strategiesScanned, instrumentsScanned, setupsDetected, setupsCreated, alertsCreated, staleRejections, providerFailures, durationMs
- Provider latency/failure: `provider fetch failed, retrying` with instrument, timeframe, attempt, delayMs, error; `duplicate candles detected`, `out-of-order candles detected`
- Symbols/timeframes processed: stored in `scanner_runs.symbols_processed` (jsonb array) and `timeframes_processed`
- Stale-data rejection: `stale data rejected` with instrument, reason, ages; `multi-timeframe validation failed`
- Detection counts: `setupsDetected`, `setupsCreated` per run
- Alert creation: `alert created from live scan` with strategyId, setupId, alertId, instrument, direction, qualityScore
- Scanner errors: `strategy scan failed`, `instrument scan failed`, `scan failed` with error message

Logs never contain API keys, credentials, tokens, sensitive user data, or full provider secrets — redaction via `redactSecrets`.

## API / UI

**API (session-authenticated, entitlement-gated):**

- `GET /api/scanner/health` — real production state: status `idle|running|degraded|unavailable`, lastRun, lastSuccessfulRun, provider, isProviderAvailable, expectedIntervalMs, activeRuns, recentFailures, dataFreshness (newestCandleTime, staleRejectionCount)
- `GET /api/scanner/runs?status=&limit=` — list recent runs (observability)
- `POST /api/scanner/trigger` — manual trigger with optional `strategyId`, `instruments` (validated against universe), `force` boolean; uses advisory locking, returns 201 created or 200 skipped; rate limited 10/min; audited as `scanner.triggered` / `scanner.trigger_skipped`

All endpoints check `canAccessScanner` entitlement server-side (free → 403).

**UI (minimal, no dashboard redesign):**

- New page `/scanner` — shows health/status, last successful scan, data freshness, active/error state, last run detail (strategies, instruments, candles, detections, alerts, stale, failures, symbols, timeframes, duration, error), and recent runs list
- Added to navigation as "Live Scanner" with icon `◐`
- Dashboard banner updated? No — preserved existing M2 banner, scanner UI is separate page
- Scanner status reflects real production state, not mock/static

## Security

- Provider credentials remain server-side: `TWELVE_DATA_API_KEY` never logged, never returned by any route, only used in provider client
- Users cannot select arbitrary unsupported provider symbols to bypass market universe: `normalizeSymbol` + `instruments` table check, 400 on unsupported
- Scanner endpoints remain authenticated/authorized: session auth required, 401 unauthenticated, 403 free users, strategy ownership check for filtered scans
- Subscription limits remain server-authoritative: `getEntitlements(plan, status)` checked in scanner service and API routes, `maxSavedSetups` enforced in `SetupService`, `maxAlerts` etc. enforced
- No client-controlled signal generation is trusted: scanner generates signals server-side only from validated, fresh, normalized production data; alert payload rendered from persisted alert + published version config, never from request input

## Scope Boundary (M7.5 is strictly production market-data and scanner pipeline)

**DO NOT implement (belongs to M8):**

- Automated trading, broker orders, MT5 execution, Exness execution, live order placement, portfolio execution, M8 risk engine, M8 kill switch

## Testing

Comprehensive tests added:

- `packages/core/test/scanner.test.ts` — unit + integration:
  - Symbol & timeframe normalization (valid, invalid asset class, malformed symbol, variants like 4H/1D/60m, unsupported timeframe, valid/invalid OHLCV, duplicate/out-of-order detection in batch)
  - Data freshness & integrity (valid data, empty response, duplicate, out-of-order, invalid OHLC, zero prices, stale, future, multi-timeframe correlation requires all timeframes, multi-timeframe freshness rejects stale setup)
  - Provider failure handling (timeout with bounded retry, failure does not generate alerts, recovery after failure)
  - Scanner execution & concurrency (advisory locking prevents overlapping, duplicate prevention via cursors, restart/recovery marks stale running as failed, health reflects real state, listRuns)
  - Security & entitlements (free cannot access, pro can, rejects unsupported symbols, credentials not exposed in health)
  - Observability (metrics without secrets)

- `apps/api/test/scanner.test.ts` — API integration:
  - Unauthenticated 401, free user 403, pro user can access health (real state), list runs, trigger scanner with advisory locking, validates strategy ownership, rejects unsupported instruments, health does not expose secrets, rate limited

**Results:**

- Core: 262 tests, 0 fail (previously 258 passing + 4 new scanner tests, plus migration count fixes)
- API: 200 tests, 0 fail (previously 191 + 9 new scanner API tests)
- Contracts, provider-twelve-data, web: existing suites still passing
- Typecheck: clean across all workspaces
- Lint: 2 pre-existing errors (alerts.ts and strategies.ts `getBillingState` unused) — not introduced by M7.5, clearly distinguished; 0 new errors
- Production build: succeeds (API + Web, Next.js 15.5.25, 17 pages including new `/scanner`)

## Files Changed

- New migration: `packages/core/src/db/migrations/0015_scanner_runs.sql` — scanner_runs + scanner_cursors tables
- New contracts: `packages/contracts/src/scanner.ts` — scanner DTOs, health, trigger, stale thresholds, advisory lock key, aliases, limits
- Updated: `packages/contracts/src/index.ts` — export scanner
- New core scanner: `packages/core/src/scanner/normalization.ts`, `validation.ts`, `freshness.ts`, `service.ts`, `index.ts`
- Updated: `packages/core/src/index.ts` — export scanner
- Updated: `packages/core/src/billing/subscriptions.ts` — fix lint (import type, any → typed)
- Updated: `packages/core/test/m6-migrations.test.ts` and `m7-notification-migrations.test.ts` — expect 15 migrations (0015 added)
- New tests: `packages/core/test/scanner.test.ts`
- New API routes: `apps/api/src/routes/scanner.ts` — health, runs, trigger
- Updated: `apps/api/src/app.ts` — wire scanner service, add recovery, register routes
- Updated: `apps/api/src/server.ts` — scanner recovery + ticker (when SCANNER_ENABLED=true)
- Updated: `apps/api/src/config.ts` — scanner env vars (SCANNER_ENABLED, SCANNER_INTERVAL_MS, SCANNER_PROVIDER_TIMEOUT_MS, SCANNER_MAX_RETRIES, SCANNER_RETRY_BASE_MS, SCANNER_RETRY_MAX_MS) + ScannerConfig interface
- New API tests: `apps/api/test/scanner.test.ts`
- New web UI: `apps/web/app/scanner/page.tsx` — health, last run, recent runs, trigger button
- Updated: `apps/web/lib/api.ts` — scanner API client methods
- Updated: `apps/web/components/app-shell.tsx` — add Live Scanner nav
- Updated: `.env.example` — scanner env vars documentation
- New docs: `docs/scanner.md` — full M7.5 documentation

## Migration(s)

- `0015_scanner_runs.sql` — creates `scanner_runs` and `scanner_cursors` tables with indexes, checks, triggers, comments. Additive only.

## Environment Variables Required

**No new required variables** — all scanner env vars have defaults and are optional:

- `SCANNER_ENABLED` (bool, default false) — run scanner ticker in-process
- `SCANNER_INTERVAL_MS` (int 30s–1h, default 300000 = 5m)
- `SCANNER_PROVIDER_TIMEOUT_MS` (int 1s–120s, default 15000)
- `SCANNER_MAX_RETRIES` (int 0–10, default 3)
- `SCANNER_RETRY_BASE_MS` (int 100–60000, default 1000)
- `SCANNER_RETRY_MAX_MS` (int 1s–120s, default 10000)

Existing provider variable still required for production data:

- `TWELVE_DATA_API_KEY` — Twelve Data API key (server-side, never logged)

No new secrets introduced.

## Production Market-Data Provider

**Twelve Data (historical OHLCV)** — `packages/providers/twelve-data`, id `twelve-data`, registered when `TWELVE_DATA_API_KEY` set. Serves all canonical timeframes via native intervals + deterministic resampling. No mock/demo data in production.

## Scanner Execution Mechanism / Frequency

- Advisory lock `875421009` prevents overlapping
- Runs every **5 minutes** (expected, configurable via `SCANNER_INTERVAL_MS`)
- Cursors prevent re-processing same candle
- Safe on restart via `recoverStaleRuns()`
- Manual trigger via API + optional in-process ticker

## Symbols / Timeframes Supported

- Symbols: EURUSD, GBPUSD, USDJPY, XAUUSD, SPX500 (excluded from ingestion), BTCUSD, ETHUSD, AAPL, SPY — plus any future instruments added via migration (validated against `instruments` table)
- Timeframes: all 14 canonical (`1m`…`1M`), with strategy requirements HTF 4H/1D, Setup 1H, Entry 15M/5M preserved
- Normalization: symbol uppercase + regex, timeframe aliases (4H→4h, 1D→1d, 60m→1h), timestamp epoch ms, OHLCV validation

## Stale-Data Policy

- Never generate alert from stale/invalid data
- Thresholds: 5m→15m, 15m→45m, 1h→2h, 4h→8h, 1d→36h, etc.
- Multi-timeframe: all must be fresh
- Stale rejections counted and logged, no alert created

## Duplicate-Prevention Mechanism

- Advisory lock (execution)
- Cursors (candle-level)
- `setups` unique key (version, instrument, direction, asOf) — setup dedup
- `alerts` unique key (setup_id, trigger_state) — alert dedup
- `notification_deliveries` unique key (alert_id, channel) — outbox dedup

## Failure / Retry Behavior

- Provider timeout → retry with backoff (max 3, base 1s, max 10s, jitter)
- Rate limit / unavailable → retry, then mark run partial/failed
- Malformed response → fail loudly, no persistence
- Missing symbol → 400 unsupported
- Stale data → skip, count rejection, no alert
- DB failure → rollback, run failed, no alert
- Restart → recover stale running runs

## Remaining Blockers

- None for M7.5 — scanner is production-ready for real market data flow
- Provider is historical-only (`realtime: false`) — live scanner uses fetch-through historical endpoint repeatedly (every 5m) which is correct for M7.5 scope; true realtime streaming is future milestone
- Scanner ticker disabled by default in dev (`SCANNER_ENABLED=false`) — enable in production or trigger manually
- No automated trading / broker orders (M8 boundary respected)
