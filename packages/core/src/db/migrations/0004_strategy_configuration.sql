-- 0004: per-version strategy configuration
-- All configuration tables are owned by a strategy version (ON DELETE CASCADE),
-- so a version is a complete, self-contained definition.

-- --- Timeframes (one row per role; roles are independent) ---
CREATE TABLE strategy_timeframes (
  version_id uuid NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  role       text NOT NULL,
  timeframe  text NOT NULL,
  PRIMARY KEY (version_id, role),
  CHECK (role IN ('htf_bias', 'setup', 'entry')),
  CHECK (timeframe IN ('1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d','3d','1w','1M'))
);

-- --- Market scope ---
CREATE TABLE strategy_market_scopes (
  version_id uuid PRIMARY KEY REFERENCES strategy_versions (id) ON DELETE CASCADE,
  mode       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode IN ('all', 'instruments'))
);

CREATE TABLE strategy_market_scope_instruments (
  version_id    uuid NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  instrument_id uuid NOT NULL REFERENCES instruments (id),
  PRIMARY KEY (version_id, instrument_id)
);

CREATE INDEX strategy_market_scope_instruments_instrument_idx
  ON strategy_market_scope_instruments (instrument_id);

-- --- Session filters ---
CREATE TABLE strategy_session_filters (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  session    text NOT NULL,
  mode       text NOT NULL,
  timezone   text NOT NULL,
  UNIQUE (version_id, session),
  CHECK (session IN ('asia', 'london', 'new_york', 'sydney')),
  CHECK (mode IN ('include', 'exclude')),
  CHECK (timezone IN ('utc', 'exchange'))
);

CREATE INDEX strategy_session_filters_version_idx ON strategy_session_filters (version_id);

-- --- Risk configuration ---
CREATE TABLE strategy_risk_config (
  version_id            uuid PRIMARY KEY REFERENCES strategy_versions (id) ON DELETE CASCADE,
  min_rr                numeric(8, 2) NOT NULL,
  stop_loss_method      text NOT NULL,
  stop_loss_buffer      numeric(10, 2) NOT NULL,
  stop_loss_buffer_unit text NOT NULL,
  take_profit_method    text NOT NULL,
  tp1_rr                numeric(8, 2) NOT NULL,
  tp2_rr                numeric(8, 2) NOT NULL,
  tp3_rr                numeric(8, 2) NOT NULL,
  min_quality_score     integer NOT NULL,
  CHECK (min_rr > 0 AND min_rr <= 100),
  CHECK (stop_loss_method IN ('structure', 'fixed', 'atr')),
  CHECK (stop_loss_buffer >= 0 AND stop_loss_buffer <= 10000),
  CHECK (stop_loss_buffer_unit IN ('pips', 'pct')),
  CHECK (take_profit_method IN ('rr', 'structure', 'manual')),
  CHECK (tp1_rr > 0 AND tp2_rr > 0 AND tp3_rr > 0),
  CHECK (tp1_rr < tp2_rr AND tp2_rr < tp3_rr),
  CHECK (min_quality_score BETWEEN 0 AND 100)
);

-- --- Strategy-level filters (news / volatility / spread) ---
-- params is deliberately JSONB: filter parameters are structured but expected
-- to evolve per filter type; relational ownership (version_id, filter_type,
-- enabled, position) stays in columns.
CREATE TABLE strategy_filters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  filter_type text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  params      jsonb NOT NULL DEFAULT '{}',
  position    integer NOT NULL DEFAULT 0,
  UNIQUE (version_id, filter_type),
  CHECK (filter_type IN ('news', 'volatility', 'spread')),
  CHECK (position >= 0)
);

CREATE INDEX strategy_filters_version_idx ON strategy_filters (version_id, position);
