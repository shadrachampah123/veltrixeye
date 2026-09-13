-- 0002: normalized markets, instruments, provider abstraction
--
-- Normalized market model:
--   instruments                  = canonical, provider-independent instruments
--   data_providers               = registry of market-data providers
--   instrument_provider_symbols  = the ONLY place provider-specific tickers exist
--
-- Strategy logic must reference instruments by (asset_class, symbol) or
-- instruments.id. Provider tickers must never appear in strategy config.
-- See docs/provider-abstraction.md.

CREATE TABLE data_providers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL,
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'planned',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug),
  CHECK (status IN ('planned', 'active', 'deprecated'))
);

CREATE TABLE instruments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_class  text NOT NULL,
  symbol       text NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_class, symbol),
  CHECK (char_length(symbol) BETWEEN 1 AND 32),
  CHECK (char_length(asset_class) BETWEEN 2 AND 24)
);

CREATE INDEX instruments_asset_class_idx ON instruments (asset_class);

CREATE TABLE instrument_provider_symbols (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id   uuid NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
  provider_id     uuid NOT NULL REFERENCES data_providers (id) ON DELETE CASCADE,
  provider_symbol text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A provider ticker maps to exactly one normalized instrument.
  UNIQUE (provider_id, provider_symbol)
);

CREATE INDEX instrument_provider_symbols_instrument_idx
  ON instrument_provider_symbols (instrument_id);
CREATE INDEX instrument_provider_symbols_provider_idx
  ON instrument_provider_symbols (provider_id);

-- Canonical instruments available at M1. These are identifiers (not market
-- data). The set is intentionally small and can grow via future migrations
-- or an admin flow.
INSERT INTO instruments (asset_class, symbol, display_name) VALUES
  ('forex', 'EURUSD', 'EUR / USD'),
  ('forex', 'GBPUSD', 'GBP / USD'),
  ('forex', 'USDJPY', 'USD / JPY'),
  ('commodity', 'XAUUSD', 'Gold / USD'),
  ('index', 'SPX500', 'S&P 500 Index'),
  ('crypto', 'BTCUSD', 'Bitcoin / USD'),
  ('crypto', 'ETHUSD', 'Ethereum / USD'),
  ('stock', 'AAPL', 'Apple Inc.'),
  ('etf', 'SPY', 'SPDR S&P 500 ETF')
ON CONFLICT (asset_class, symbol) DO NOTHING;
