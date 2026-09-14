# Deterministic Backtesting (M6, Phase 1)

M6 backtesting replays a published strategy version over historical candles
and records what its own detection, level, and scoring layers would have
seen — with no look-ahead, no provider calls, and no randomness. Phase 1
covers the pure replay engine (`runBacktest` in `@veltrixeye/core`), the
versioned contracts (`@veltrixeye/contracts`), and the append-only result
tables (`0011_backtests.sql`). There is no HTTP surface, no worker, and no
scheduler: a run is invoked explicitly, executes synchronously in memory,
and its results are recorded by a later phase.

```
stored candles → M3 evaluation → M4 levels → M5 quality → M6 replay + R accounting
```

A backtest measures how a strategy's rules would have behaved on past data.
It is **not** a prediction: it implies no probability of future profit.

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

## What Phase 1 does NOT do

No HTTP routes, no web UI, no scheduler/worker/queue/cron, no realtime or
streaming, no trade execution, no AI/ML, no billing, no second provider, no
credential handling, and no alert delivery (see `docs/alerts.md`). The
engine never calls providers or `IngestionService` — callers supply candles
from the store. Overlapping trades are tracked independently (no netting,
no portfolio accounting).

## Engine contract

The engine is pinned as **`m6-backtest-1`**
(`BACKTEST_ENGINE_VERSION` in `@veltrixeye/contracts`), stored on every
run row. Any change to anchors, evaluation, exits, costs, or metrics
requires a new version string — the same version must always mean the same
replay.

Bounds (all pinned in contracts, none configurable):

- `MAX_BACKTEST_STEPS` (2000): anchors evaluated per call; over-range
  replays keep the **first** 2000 anchors and note the truncation.
- `MAX_BACKTEST_INSTRUMENTS_PER_CALL` (1): one instrument per call.
- `MAX_BACKTEST_TRADES` (500): stored trades per run.
- `DEFAULT_MAX_HOLD_CANDLES` (100): exits range over at most
  `maxHoldCandles` (1–5000) subsequent setup candles.

Exit policy (`BacktestExitPolicy`): `stopLoss` (`level` | `none`),
`takeProfit` (`tp1` | `tp2` | `tp3` | `none`), `maxHoldCandles`,
`sameCandleRule` (`stop_first`, pinned), `entryTiming` (`signal_close`,
pinned). `none` disables that exit leg but never changes level
derivation — R stays normalized by the version's stop.

Cost policy (`BacktestCostPolicy`): `feePerSide`, `slippagePerSide`,
`spread` (all ≥ 0, default 0), `riskPerTrade` (optional, > 0). Costs apply
identically to every closed trade, including zero-hold exits at entry:
`pnlR = (signedPriceMove − totalCost) / riskDistance`, rounded to 4
decimals; `pnlCurrency = pnlR × riskPerTrade` (2 decimals) only when
`riskPerTrade` is set.

## Determinism and look-ahead protection

- Anchors are a pure function of setup closes and `[fromMs, toMs)`.
- Every anchor evaluation sees only per-role prefixes closed at that
  anchor; candles beyond `toMs` are dropped before evaluation; HTF candles
  still open at the anchor are excluded.
- Input order never matters (defensive time sort); duplicate timestamps
  deduplicate last-wins, mirroring store upserts.
- Warm-up is reported, never skipped: anchors below the M3
  `requiredWindows` history for any role proceed through the real handlers
  (fail-closed as in live evaluation) and are counted in a note.
- Gaps wider than 2× the median role spacing are noted; exits scan the
  next available candle — nothing is interpolated.
- Identical inputs replay byte-identically, including notes; every trade
  and metric validates against its contract schema.

## Metrics

Computed over closed trades only (`no_levels` excluded), in signal order:

- `wins` (`pnlR > 0`) / `losses` (`pnlR < 0`); breakeven (`pnlR = 0`)
  counts in neither; `winRate = wins / tradesClosed`.
- `expectancyR` (mean R), `avgWinR` / `avgLossR` (null when empty),
  `totalR` (0 when empty).
- `profitFactor = grossWin / |grossLoss|` — `0` when every trade loses,
  `null` (noted) when there are no losses.
- `maxDrawdownR`: peak-to-trough decline of the R equity curve in signal
  order (null when empty, ≥ 0 otherwise).
- `totalCurrency` only when `riskPerTrade` is set.

## Storage (0011)

`backtest_runs` stores the replay inputs (version, instrument, direction,
range, policy snapshots, `config_hash`) and the metric aggregates; the
`(user, version, instrument, direction, engine_version, range,
config_hash)` uniqueness key makes identical replays idempotent.
`backtest_trades` stores one append-only row per simulated setup in `seq`
order — aggregates only, never candle data (provider licensing forbids
storing anything the raw series could be reverse-engineered from).
