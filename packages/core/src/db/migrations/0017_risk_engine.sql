-- 0017: risk management engine (M8.2)
--
-- Server-authoritative risk policy, instrument contract specs, optional
-- correlation groups, account-state snapshots, reservations (concurrency)
-- and an append-only risk-decision audit trail.
--
-- Hard safety properties encoded here:
--  - NO credentials / API keys / broker secrets anywhere.
--  - User-editable risk numbers are CHECK-constrained to the platform
--    ceilings (1% per trade, 5% daily loss, 5 simultaneous positions, …).
--    A client cannot persist a 50% risk setting.
--  - min_rr cannot go below the platform floor of 2 (1:2).
--  - paper equity is a simulation parameter bounded [100, 1_000_000].
--  - risk_decisions and risk_reservations never hold secrets.
--  - Additive only: CREATE TABLE/INDEX/TRIGGER. No existing constraint
--    altered. Migrations 0001–0016 untouched.
--
-- M8.2 still does NOT execute trades: no order-placement path is added.

-- ---------------------------------------------------------------------------
-- Instrument contract specifications (position-sizing inputs)
-- ---------------------------------------------------------------------------
CREATE TABLE instrument_risk_specs (
  instrument_id  uuid PRIMARY KEY REFERENCES instruments (id) ON DELETE CASCADE,
  contract_size  numeric(24, 10) NOT NULL,
  pip_size       numeric(24, 10) NOT NULL,
  pnl_mode       text NOT NULL,
  quote_currency text NOT NULL,
  min_quantity   numeric(24, 10) NOT NULL,
  quantity_step  numeric(24, 10) NOT NULL,
  max_quantity   numeric(24, 10) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (pnl_mode IN ('quote_linear', 'base_linear')),
  CHECK (contract_size > 0),
  CHECK (pip_size > 0),
  CHECK (min_quantity > 0),
  CHECK (quantity_step > 0),
  CHECK (max_quantity > 0),
  CHECK (max_quantity >= min_quantity),
  CHECK (char_length(quote_currency) BETWEEN 3 AND 8)
);

CREATE TRIGGER instrument_risk_specs_set_updated_at
BEFORE UPDATE ON instrument_risk_specs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed specs for the platform universe. These are configuration, not
-- invented at evaluation time. Missing specs fail closed.
INSERT INTO instrument_risk_specs
  (instrument_id, contract_size, pip_size, pnl_mode, quote_currency, min_quantity, quantity_step, max_quantity)
SELECT i.id, v.contract_size, v.pip_size, v.pnl_mode, v.quote_currency, v.min_quantity, v.quantity_step, v.max_quantity
FROM instruments i
JOIN (VALUES
  ('forex',     'EURUSD', 100000::numeric, 0.0001::numeric, 'quote_linear', 'USD', 0.01::numeric, 0.01::numeric, 100::numeric),
  ('forex',     'GBPUSD', 100000::numeric, 0.0001::numeric, 'quote_linear', 'USD', 0.01::numeric, 0.01::numeric, 100::numeric),
  ('forex',     'USDJPY', 100000::numeric, 0.01::numeric,   'base_linear',  'JPY', 0.01::numeric, 0.01::numeric, 100::numeric),
  ('commodity', 'XAUUSD', 100::numeric,    0.01::numeric,   'quote_linear', 'USD', 0.01::numeric, 0.01::numeric, 100::numeric),
  ('crypto',    'BTCUSD', 1::numeric,      0.01::numeric,   'quote_linear', 'USD', 0.001::numeric, 0.001::numeric, 100::numeric),
  ('crypto',    'ETHUSD', 1::numeric,      0.01::numeric,   'quote_linear', 'USD', 0.001::numeric, 0.001::numeric, 100::numeric),
  ('stock',     'AAPL',   1::numeric,      0.01::numeric,   'quote_linear', 'USD', 1::numeric,    1::numeric,    100::numeric),
  ('etf',       'SPY',    1::numeric,      0.01::numeric,   'quote_linear', 'USD', 1::numeric,    1::numeric,    100::numeric),
  ('index',     'SPX500', 1::numeric,      0.01::numeric,   'quote_linear', 'USD', 1::numeric,    1::numeric,    100::numeric)
) AS v(asset_class, symbol, contract_size, pip_size, pnl_mode, quote_currency, min_quantity, quantity_step, max_quantity)
  ON i.asset_class = v.asset_class AND i.symbol = v.symbol
ON CONFLICT (instrument_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Optional correlation groups (configuration-driven; never invented)
-- ---------------------------------------------------------------------------
CREATE TABLE correlation_groups (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL,
  name             text NOT NULL,
  max_exposure_pct numeric(8, 4),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug),
  CHECK (char_length(slug) BETWEEN 1 AND 64),
  CHECK (char_length(name) BETWEEN 1 AND 80),
  CHECK (max_exposure_pct IS NULL OR (max_exposure_pct > 0 AND max_exposure_pct <= 5))
);

CREATE TABLE instrument_correlation_groups (
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
  group_id      uuid NOT NULL REFERENCES correlation_groups (id) ON DELETE CASCADE,
  PRIMARY KEY (instrument_id, group_id)
);

CREATE INDEX instrument_correlation_groups_group_idx
  ON instrument_correlation_groups (group_id);

-- ---------------------------------------------------------------------------
-- Per-user risk policy (server-owned; one row per user)
-- ---------------------------------------------------------------------------
CREATE TABLE risk_policies (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  enabled                           boolean NOT NULL DEFAULT true,
  policy_version                    integer NOT NULL DEFAULT 1,
  risk_pct_per_trade                numeric(8, 4) NOT NULL,
  max_monetary_risk_per_trade       numeric(24, 10),
  max_daily_loss_pct                numeric(8, 4) NOT NULL,
  max_weekly_loss_pct               numeric(8, 4) NOT NULL,
  max_consecutive_losses            integer NOT NULL,
  max_simultaneous_positions        integer NOT NULL,
  max_total_open_risk_pct           numeric(8, 4) NOT NULL,
  max_exposure_per_instrument_pct   numeric(8, 4) NOT NULL,
  max_exposure_per_direction_pct    numeric(8, 4) NOT NULL,
  min_rr                            numeric(8, 4) NOT NULL,
  max_spread_pips                   numeric(12, 4),
  max_slippage_pips                 numeric(12, 4),
  allowed_sessions                  jsonb,
  correlation_required              boolean NOT NULL DEFAULT false,
  max_correlation_group_exposure_pct numeric(8, 4) NOT NULL,
  paper_equity                      numeric(24, 10) NOT NULL,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id),
  CHECK (policy_version > 0),
  CHECK (risk_pct_per_trade > 0 AND risk_pct_per_trade <= 1),
  CHECK (max_monetary_risk_per_trade IS NULL OR (max_monetary_risk_per_trade > 0 AND max_monetary_risk_per_trade <= 10000)),
  CHECK (max_daily_loss_pct > 0 AND max_daily_loss_pct <= 5),
  CHECK (max_weekly_loss_pct > 0 AND max_weekly_loss_pct <= 10),
  CHECK (max_consecutive_losses > 0 AND max_consecutive_losses <= 5),
  CHECK (max_simultaneous_positions > 0 AND max_simultaneous_positions <= 5),
  CHECK (max_total_open_risk_pct > 0 AND max_total_open_risk_pct <= 5),
  CHECK (max_exposure_per_instrument_pct > 0 AND max_exposure_per_instrument_pct <= 2),
  CHECK (max_exposure_per_direction_pct > 0 AND max_exposure_per_direction_pct <= 3),
  CHECK (min_rr >= 2 AND min_rr <= 100),
  CHECK (max_spread_pips IS NULL OR max_spread_pips > 0),
  CHECK (max_slippage_pips IS NULL OR max_slippage_pips > 0),
  CHECK (max_correlation_group_exposure_pct > 0 AND max_correlation_group_exposure_pct <= 5),
  CHECK (paper_equity >= 100 AND paper_equity <= 1000000),
  CHECK (allowed_sessions IS NULL OR jsonb_typeof(allowed_sessions) = 'array')
);

CREATE UNIQUE INDEX risk_policies_user_idx ON risk_policies (user_id);

CREATE TRIGGER risk_policies_set_updated_at
BEFORE UPDATE ON risk_policies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Optional per-strategy restrictions (can only TIGHTEN the user policy)
-- ---------------------------------------------------------------------------
CREATE TABLE risk_strategy_overrides (
  strategy_id   uuid PRIMARY KEY REFERENCES strategies (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  enabled       boolean NOT NULL DEFAULT true,
  blocked       boolean NOT NULL DEFAULT false,
  min_rr        numeric(8, 4),
  max_risk_pct  numeric(8, 4),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (min_rr IS NULL OR (min_rr >= 2 AND min_rr <= 100)),
  CHECK (max_risk_pct IS NULL OR (max_risk_pct > 0 AND max_risk_pct <= 1))
);

CREATE INDEX risk_strategy_overrides_user_idx ON risk_strategy_overrides (user_id);

CREATE TRIGGER risk_strategy_overrides_set_updated_at
BEFORE UPDATE ON risk_strategy_overrides
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Server-owned account snapshot (never trust client P&L / loss counters)
-- ---------------------------------------------------------------------------
CREATE TABLE risk_account_states (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  daily_realized_pl    numeric(24, 10) NOT NULL DEFAULT 0,
  weekly_realized_pl   numeric(24, 10) NOT NULL DEFAULT 0,
  consecutive_losses   integer NOT NULL DEFAULT 0,
  daily_window_start   date NOT NULL,
  weekly_window_start  date NOT NULL,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_profile_id),
  CHECK (consecutive_losses >= 0),
  CHECK (version > 0)
);

CREATE INDEX risk_account_states_user_idx ON risk_account_states (user_id);

CREATE TRIGGER risk_account_states_set_updated_at
BEFORE UPDATE ON risk_account_states
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Append-only risk decisions (the only valid source of "approved")
-- ---------------------------------------------------------------------------
CREATE TABLE risk_decisions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid REFERENCES execution_profiles (id) ON DELETE SET NULL,
  setup_id             uuid REFERENCES setups (id) ON DELETE SET NULL,
  strategy_id          uuid REFERENCES strategies (id) ON DELETE SET NULL,
  outcome              text NOT NULL,
  rejection_code       text,
  reason               text NOT NULL,
  violations           jsonb NOT NULL DEFAULT '[]',
  risk_pct             numeric(12, 6),
  monetary_risk        numeric(24, 10),
  position_size        numeric(24, 10),
  entry_price          numeric(24, 10) NOT NULL,
  stop_loss_price      numeric(24, 10) NOT NULL,
  take_profit_price    numeric(24, 10) NOT NULL,
  rr                   numeric(12, 6),
  current_exposure     jsonb NOT NULL,
  projected_exposure   jsonb NOT NULL,
  policy_version       integer NOT NULL,
  engine_version       text NOT NULL,
  evaluated_at         timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (outcome IN ('approved', 'rejected')),
  CHECK (
    (outcome = 'approved' AND rejection_code IS NULL)
    OR (outcome = 'rejected' AND rejection_code IS NOT NULL)
  ),
  CHECK (char_length(reason) BETWEEN 1 AND 500),
  CHECK (char_length(engine_version) BETWEEN 1 AND 64),
  CHECK (policy_version > 0)
);

CREATE INDEX risk_decisions_user_idx ON risk_decisions (user_id, created_at DESC);
CREATE INDEX risk_decisions_setup_idx ON risk_decisions (setup_id);
CREATE INDEX risk_decisions_profile_idx ON risk_decisions (execution_profile_id, created_at DESC);

CREATE TRIGGER risk_decisions_append_only
BEFORE UPDATE OR DELETE ON risk_decisions
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ---------------------------------------------------------------------------
-- In-flight risk reservations (serialize concurrent approvals)
-- ---------------------------------------------------------------------------
CREATE TABLE risk_reservations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  risk_decision_id     uuid NOT NULL REFERENCES risk_decisions (id) ON DELETE CASCADE,
  symbol               text NOT NULL,
  direction            text NOT NULL,
  monetary_risk        numeric(24, 10) NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Crash recovery: a reservation older than RISK_RESERVATION_TTL_MS is
  -- reclaimed on the next locked evaluation and must not block exposure.
  expires_at           timestamptz NOT NULL,
  UNIQUE (risk_decision_id),
  CHECK (direction IN ('long', 'short')),
  CHECK (monetary_risk >= 0),
  CHECK (symbol ~ '^[A-Z0-9][A-Z0-9._:-]*$' AND char_length(symbol) <= 32)
);

CREATE INDEX risk_reservations_profile_idx ON risk_reservations (execution_profile_id);
CREATE INDEX risk_reservations_expiry_idx ON risk_reservations (execution_profile_id, expires_at);

COMMENT ON TABLE risk_policies IS
  'M8.2: server-owned per-user risk policy. CHECKs enforce platform ceilings; credentials are NEVER stored.';
COMMENT ON TABLE risk_decisions IS
  'M8.2: append-only risk-engine verdicts. A client boolean is never an approval — only a row here is.';
COMMENT ON TABLE risk_account_states IS
  'M8.2: server-owned paper P&L / loss counters. Client-supplied P&L is ignored.';
COMMENT ON TABLE instrument_risk_specs IS
  'M8.2: contract specifications used by position sizing. Missing spec ⇒ fail closed.';
COMMENT ON TABLE correlation_groups IS
  'M8.2: optional, configuration-driven correlation groups. The engine never invents correlation.';
COMMENT ON TABLE risk_reservations IS
  'M8.2: in-flight approved risk that has not yet become a position. Serializes concurrent evaluations. expires_at is a crash-recovery TTL; stale rows are reclaimed under the evaluation lock and do not count toward exposure.';
