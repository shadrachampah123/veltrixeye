-- 0011: deterministic backtest runs + per-trade history (M6)
--
-- A backtest replays a PUBLISHED strategy version over stored candles: at
-- every setup-timeframe close in [from_ms, to_ms) it re-runs the pure M3
-- engine on the candles closed at that anchor, derives M4 levels purely in
-- memory, scores with the pure M5 engine, and tracks each simulated setup
-- candle-by-candle to a deterministic exit.
--
-- These tables persist the replay's deterministic OUTPUT only:
--  - backtest_runs   = one row per replay (owner-scoped ledger with the
--                      exact inputs + aggregate metrics for listing/sorting);
--  - backtest_trades = one row per simulated setup/trade in seq order
--                      (append-only history — guarded below).
--
-- The replay itself never touches the live `setups` / `setup_scores` /
-- `setup_state_events` tables (it uses the pure engines, never the M4/M5
-- services) and never triggers provider fetch-through. Repeating the same
-- replay returns the existing run: the idempotency key is
-- (user, version, instrument, direction, engine version, range, config_hash).
--
-- This migration is additive: CREATE TABLE/INDEX/TRIGGER only. The
-- `append_only_guard()` function already exists (0007) and is reused here,
-- never redefined.

CREATE TABLE backtest_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  strategy_id         uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions (id),
  instrument_id       uuid NOT NULL REFERENCES instruments (id),
  direction           text NOT NULL,
  engine_version      text NOT NULL,
  -- Replay bounds, epoch-ms (UTC): anchors are setup closes in [from_ms, to_ms).
  from_ms             bigint NOT NULL,
  to_ms               bigint NOT NULL,
  -- Exit + cost policy snapshots exactly as requested (see contracts/backtest.ts).
  exit_policy         jsonb NOT NULL DEFAULT '{}',
  cost_policy         jsonb NOT NULL DEFAULT '{}',
  -- sha256 hex over (version, instrument, direction, range, policies).
  config_hash         text NOT NULL,
  -- Runs are synchronous and bounded (no background worker in M6), so a run
  -- is either recorded complete or recorded failed — there is no `running`.
  status              text NOT NULL DEFAULT 'completed',
  -- Aggregates computed by the pure engine, stored for listing/sorting.
  steps_evaluated     integer NOT NULL DEFAULT 0,
  setups_detected     integer NOT NULL DEFAULT 0,
  trades_closed       integer NOT NULL DEFAULT 0,
  expectancy_r        numeric(12, 4),
  win_rate            numeric(6, 4),
  profit_factor       numeric(12, 4),
  max_drawdown_r      numeric(12, 4),
  metrics             jsonb NOT NULL DEFAULT '{}',
  notes               jsonb NOT NULL DEFAULT '[]',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (direction IN ('long', 'short', 'both')),
  CHECK (from_ms > 0 AND to_ms > 0 AND from_ms < to_ms),
  CHECK (char_length(engine_version) BETWEEN 1 AND 64),
  CHECK (char_length(config_hash) = 64),
  CHECK (status IN ('completed', 'failed')),
  CHECK (steps_evaluated >= 0 AND setups_detected >= 0 AND trades_closed >= 0)
);

-- Same user + same deterministic inputs = same run (idempotent replay).
CREATE UNIQUE INDEX backtest_runs_idempotency_uniq
  ON backtest_runs (user_id, strategy_version_id, instrument_id, direction, engine_version, from_ms, to_ms, config_hash);

CREATE INDEX backtest_runs_user_idx ON backtest_runs (user_id, created_at DESC);
CREATE INDEX backtest_runs_strategy_idx ON backtest_runs (strategy_id, created_at DESC);

COMMENT ON TABLE backtest_runs IS
  'M6: deterministic backtest replays (one instrument per run). Repeating identical inputs returns the existing row via backtest_runs_idempotency_uniq.';

-- One row per simulated setup/trade, in seq order. Aggregates only — no
-- candle data is stored here (licensing: derived results must not be
-- reverse-engineerable into the raw series).
CREATE TABLE backtest_trades (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  instrument_id   uuid NOT NULL REFERENCES instruments (id),
  direction       text NOT NULL,
  signal_as_of_ms bigint NOT NULL,
  entry_price     numeric(24, 10),
  stop_loss_price numeric(24, 10),
  tp1_price       numeric(24, 10),
  tp2_price       numeric(24, 10),
  tp3_price       numeric(24, 10),
  quality_score   integer,
  quality_grade   text,
  exit_reason     text NOT NULL,
  exit_price      numeric(24, 10),
  exit_as_of_ms   bigint,
  pnl_r           numeric(12, 4),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq),
  CHECK (direction IN ('long', 'short')),
  CHECK (signal_as_of_ms > 0),
  CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100),
  CHECK (quality_grade IS NULL OR quality_grade IN ('A+', 'A', 'B', 'C', 'ignore')),
  CHECK (exit_reason IN ('stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3',
                         'max_hold', 'range_end', 'no_levels'))
);

CREATE INDEX backtest_trades_run_idx ON backtest_trades (run_id, seq);

COMMENT ON TABLE backtest_trades IS
  'M6: append-only per-trade backtest history. no_levels rows record setups without deterministic levels (null exit/P&L) — they are never skipped.';

CREATE TRIGGER backtest_trades_append_only
BEFORE UPDATE OR DELETE ON backtest_trades
FOR EACH ROW EXECUTE FUNCTION append_only_guard();
