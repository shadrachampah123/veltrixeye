# Deterministic Backtesting (M6, Phases 1 & 2)

M6 backtesting replays a published strategy version over historical candles
and records what its own detection, level, and scoring layers would have
seen — with no look-ahead, no provider calls, and no randomness.

```
stored candles → M3 evaluation → M4 levels → M5 quality → M6 replay + R accounting
```

A backtest measures how a strategy's rules would have behaved on past data.
It is **not** a prediction: it implies no probability of future profit.

Phase 1 covers the pure replay engine (`runBacktest` in `@veltrixeye/core`),
the versioned contracts (`@veltrixeye/contracts`), and the append-only result
tables (`0011_backtests.sql`). Phase 2 adds the application boundary
(`BacktestService`) and the HTTP surface (`/api/backtests`). There is still
no worker, scheduler, queue, cron, or background job — a run is invoked
explicitly via API, executes synchronously in memory, and its results are
recorded transactionally.

## What Phase 1 does

- Replays one instrument over `[fromMs, toMs)` via the pure
  `runBacktest({ config, instrument, candles, fromMs, toMs, direction,
  exitPolicy, costPolicy })` engine — no database, no providers, no clock.
- Derives replay anchors as setup closes in `[fromMs, toMs)` (from
  inclusive, to exclusive), deterministically capped at the first
  `MAX_BACKTEST_STEPS` (2000) anchors with a truncation note.
- Evaluates each anchor through the **real M3 engine**
  (`evaluateStrategyVersion`) on look-ahead-proof prefixes: per role, only
  candles fully closed at the anchor, with `htf_alignment` on the HTF role —
  exactly live semantics.
- Derives entry/stop/targets through the **real M4 math**
  (`detectionLevels` over the M3 candidate), scores every setup through the
  **real M5 engine** (`scoreSetupQuality`), and enters at the signal-candle
  close (`entryTiming: 'signal_close'`).
- Exits on the setup timeframe in pinned order — stop, then target, then
  max-hold, then range end — with same-candle ties resolving to the stop
  (`sameCandleRule: 'stop_first'`); equality with a level counts as a touch.
- Records setups that pass M3 but have no deterministic levels as
  `no_levels` rows (never skipped, excluded from R statistics).
- Attributes explicit costs (`feePerSide`, `slippagePerSide`, `spread`,
  optional `riskPerTrade`) and reports R-primary metrics (win rate,
  expectancy, profit factor, max drawdown, averages).
- Persists runs and trades in `backtest_runs` / `backtest_trades`
  (migration `0011`): idempotent replays collapse via the full-input
  uniqueness key, trades are append-only.

## What Phase 2 adds

`BacktestService` (`packages/core/src/backtest/service.ts`) is the only
writer of `backtest_runs` / `backtest_trades`:

- **Provider-free**: loads candles exclusively from `CandleStore`
  (`market_candles` table). Never imports provider registry, never calls
  `TwelveDataProvider`, never performs network I/O. If no candles exist for
  the requested range the engine runs over an empty anchor set (valid run
  with zero trades), not an error — callers can distinguish via metrics.
- **Owner-scoped & published-only**: every call requires `userId`.
  Strategy + version must exist, belong to the user, and be published
  (`status = 'published'`). Otherwise masked 404 (foreign) or 400 (draft).
  Version config is validated via the existing `strategyVersionConfigSchema`
  (M3/M4/M5 rules unchanged).
- **Pure engine delegation**: after loading and validating candles,
  `BacktestService` calls the pure `runBacktest` from Phase 1. No new
  evaluation logic, no change to `m6-backtest-1` semantics.
- **Transactional persistence with Phase 1 idempotency**: a winner inserts
  `backtest_runs` row + up to `MAX_BACKTEST_TRADES` trades in one
  transaction. `config_hash` uniqueness (`backtest_runs_idempotency_uniq`
  on `(user_id, strategy_version_id, instrument_id, direction,
  engine_version, from_ms, to_ms, config_hash)`) makes replay idempotent:
  second call with same canonical config returns `created=false` and the
  existing run. Concurrent identical submissions use `ON CONFLICT DO NOTHING`
  + re-select; exactly one winner inserts, all others collapse.
- **Canonical `config_hash` (pinned)**: `computeConfigHash` in
  `packages/core/src/backtest/canonical.ts`:
  1. Zod-parse `exitPolicy` and `costPolicy` through their contract schemas
     with defaults (`stopLoss: 'level'`, `takeProfit: 'tp3'`,
     `maxHoldCandles: 100`, `sameCandleRule: 'stop_first'`,
     `entryTiming: 'signal_close'`, fees 0). `{}` and
     `{stopLoss:'level',...}` become byte-identical after parsing.
  2. Build canonical object `{ exitPolicy: <parsed>, costPolicy: <parsed> }`
     — only policies are hashed. Remaining idempotency dimensions
     (`user_id`, `strategy_version_id`, `instrument_id`, `direction`,
     `engine_version`, `from_ms`, `to_ms`) are enforced by the unique index
     `backtest_runs_idempotency_uniq`. Instrument symbol normalization
     (`eurusd` vs `EURUSD`) is handled by `CandleStore.resolveInstrument`
     → `instrument_id`; direction normalization by Zod; range by integer
     columns. Hashing only policies keeps hash focused on the part where
     JSON key ordering could cause logical duplicates.
  3. Canonicalize recursively: sort object keys alphabetically at every
     level, preserve array order, leave primitives unchanged.
  4. Stable stringify: `JSON.stringify(canonicalized)` with no whitespace,
     then `sha256` hex (64 lowercase chars). Key ordering in caller JSON is
     irrelevant; only deterministic representation matters.
  5. Validated against `/^[0-9a-f]{64}$/` before persistence.
  6. Documented here and in code; changing algorithm requires new engine
     version.
- **Bounds enforcement**:
  - `MAX_BACKTEST_STEPS` (2000): enforced inside `runBacktest`; if anchor
    count exceeds 2000 the engine evaluates first 2000 and sets
    `notes: ['truncated_steps:2000']`. Service surfaces `truncated=true`
    when `metrics.stepsEvaluated >= MAX_BACKTEST_STEPS` or engine notes
    truncation.
  - `MAX_BACKTEST_TRADES` (500): service stores first 500 trades in `seq`
    order when `run.trades.length > 500`; `truncated=true` in response.
    `GET /:id/trades` paginates up to 500.
- **No side effects**: never inserts into `setups`, `setup_scores`,
  `setup_state_events`, `ingestion_runs`, or any market table. Only
  `backtest_runs` and `backtest_trades`.
- **Licensing-safe**: API responses never include raw candles; only
  aggregates and trade summaries.

## What M6 does NOT do

No web UI (Phase 4), no scheduler/worker/queue/cron/background job/polling,
no realtime/streaming, no trade execution, no AI/ML, no billing, no second
provider, no credential handling, no alert delivery beyond stub ledger,
no Twelve Data credential requirement, no new env vars.

## Engine contract

Pinned as **`m6-backtest-1`** (`BACKTEST_ENGINE_VERSION` in
`@veltrixeye/contracts`), stored on every run row. Any change to anchors,
evaluation, exits, costs, or metrics requires a new version string.

Bounds (pinned in contracts, none configurable):

- `MAX_BACKTEST_STEPS` (2000): anchors evaluated per call.
- `MAX_BACKTEST_INSTRUMENTS_PER_CALL` (1): one instrument per call.
- `MAX_BACKTEST_TRADES` (500): stored trades per run.
- `DEFAULT_MAX_HOLD_CANDLES` (100): max hold default.

Exit policy: `stopLoss` (`level`|`none`), `takeProfit` (`tp1`|`tp2`|`tp3`|
`none`), `maxHoldCandles` (1–5000), `sameCandleRule` (`stop_first`, pinned),
`entryTiming` (`signal_close`, pinned). `none` disables that leg but never
changes level derivation — R stays normalized by version stop.

Cost policy: `feePerSide`, `slippagePerSide`, `spread` (≥0, default 0),
`riskPerTrade` (>0 optional). `pnlR = (signedPriceMove − totalCost) /
riskDistance` rounded 4 decimals; `pnlCurrency = pnlR × riskPerTrade` (2
decimals) only when set.

## Determinism and look-ahead protection

- Anchors pure function of setup closes and `[fromMs,toMs)`.
- Every anchor sees only per-role prefixes closed at anchor; candles beyond
  `toMs` dropped; HTF candles still open excluded.
- Input order irrelevant (time sort); duplicate timestamps last-wins.
- Warm-up reported, never skipped; gaps >2× median spacing noted; exits scan
  next available candle — no interpolation.
- Identical inputs replay byte-identically, including notes; trades/metrics
  validate against contract schemas.
- Persistence fix: after COMMIT, service re-queries `backtest_trades` so both
  `created=true` and `created=false` paths return DB-rounded
  `numeric(24,10)` values, ensuring `deepEqual` replay determinism
  (`100.002` vs `100.00200000000001`).

## HTTP API (Phase 2)

All routes session-authenticated, owner-scoped with masked 404, Zod-validated,
rate-limited (20/min for POST /api/backtests), audited.

- `POST /api/backtests`
  Body: `strategyId` (uuid), `versionId` (uuid), `instrument`
  `{assetClass,symbol}`, `direction?` (`long`|`short`|`both`, default both),
  `from`/`to` (ms, `from < to`, not future), `exitPolicy?`, `costPolicy?`
  (strict, unknown keys 400). Returns `{run, trades, truncated, created}`
  with 201 on create, 200 on replay. Errors: 400 validation/range/draft,
  401 auth, 404 masked foreign/instrument, 429 rate limit.
- `GET /api/backtests?strategyId?&limit?` — list owned runs, newest first.
- `GET /api/backtests/:id` — detail `{run, trades, truncated}`.
- `GET /api/backtests/:id/trades?limit?` — trades paginated (max 500).

Audit: `backtest.created` / `backtest.replayed` / `backtest.failed` with
metadata `strategyId, versionId, instrument, direction, fromMs, toMs,
configHash, created, truncated, stepsEvaluated, setupsDetected, tradesClosed`.

No raw candle fields (`open/high/low/close/volume`) ever in responses.

## Storage (0011)

`backtest_runs` stores replay inputs (version, instrument, direction, range,
policy snapshots, `config_hash`) and metric aggregates; uniqueness key
`(user, version, instrument, direction, engine_version, range, config_hash)`
makes identical replays idempotent. `backtest_trades` stores one row per
simulated setup in `seq` order — aggregates only, never candle data.
