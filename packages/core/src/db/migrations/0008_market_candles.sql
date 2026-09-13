-- 0008: market-data candle store + ingestion ledger (M2)
--
-- The candle store is GLOBAL and shared: ingested OHLCV belongs to no user
-- (market data is not per-user) and every authenticated user reads the same
-- rows. Writes come only from ingestion (fetch-through on cache miss +
-- explicit backfill); there is no scheduler in M2.
--
-- Time is stored as epoch milliseconds (UTC), matching the Candle contract.
-- Storage is bounded by the retention policy (see docs/market-data.md);
-- ingestion prunes rows older than the per-timeframe cutoff on write.

CREATE TABLE candles (
  instrument_id uuid NOT NULL REFERENCES instruments (id),
  timeframe     text NOT NULL,
  -- Candle OPEN time, epoch ms (UTC).
  ts            bigint NOT NULL,
  open          numeric(24, 10) NOT NULL,
  high          numeric(24, 10) NOT NULL,
  low           numeric(24, 10) NOT NULL,
  close         numeric(24, 10) NOT NULL,
  -- NULL where the market reports no volume (e.g. spot FX).
  volume        numeric(30, 10),
  provider_slug text NOT NULL,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, timeframe, ts),
  CHECK (timeframe IN ('1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d','3d','1w','1M')),
  CHECK (ts > 0),
  CHECK (open > 0 AND high > 0 AND low > 0 AND close > 0),
  CHECK (low <= open AND low <= close AND high >= open AND high >= close),
  CHECK (volume IS NULL OR volume >= 0),
  CHECK (char_length(provider_slug) BETWEEN 1 AND 64)
);

-- Range scans per instrument × timeframe (the only read pattern).
CREATE INDEX candles_instrument_timeframe_ts_idx ON candles (instrument_id, timeframe, ts);
-- Retention pruning per timeframe.
CREATE INDEX candles_retention_idx ON candles (timeframe, ts);

-- Audit ledger for every ingestion run (fetch-through + backfill): what was
-- requested, what was stored, what failed. Mutable only in status/counters
-- while a run is in flight (running → completed/partial/failed); rows are
-- never deleted by the application.
CREATE TABLE ingestion_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger          text NOT NULL,
  status           text NOT NULL DEFAULT 'running',
  provider_slug    text NOT NULL,
  -- The request as issued (instruments, timeframes, from/to) plus per-pair
  -- results once finished. Structured JSONB, not an opaque blob.
  request          jsonb NOT NULL DEFAULT '{}',
  candles_upserted integer NOT NULL DEFAULT 0,
  error            text,
  initiated_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CHECK (trigger IN ('fetch_through', 'backfill')),
  CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  CHECK (candles_upserted >= 0),
  CHECK (char_length(provider_slug) BETWEEN 1 AND 64)
);

CREATE INDEX ingestion_runs_started_idx ON ingestion_runs (started_at DESC);

-- M2 primary provider registry row (see docs/provider-licensing.md).
INSERT INTO data_providers (slug, display_name, status)
VALUES ('twelve-data', 'Twelve Data', 'active')
ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, status = 'active';

-- Provider-symbol mappings for the M2 8-instrument universe.
-- index/SPX500 intentionally has NO mapping: S&P index licensing excludes it
-- from M2 ingestion (see docs/provider-licensing.md). Its M1 identifier row
-- stays untouched; it simply has no candles and no coverage.
INSERT INTO instrument_provider_symbols (instrument_id, provider_id, provider_symbol)
SELECT i.id, p.id, m.provider_symbol
FROM (VALUES
  ('forex',     'EURUSD', 'EUR/USD'),
  ('forex',     'GBPUSD', 'GBP/USD'),
  ('forex',     'USDJPY', 'USD/JPY'),
  ('commodity', 'XAUUSD', 'XAU/USD'),
  ('crypto',    'BTCUSD', 'BTC/USD'),
  ('crypto',    'ETHUSD', 'ETH/USD'),
  ('stock',     'AAPL',   'AAPL'),
  ('etf',       'SPY',    'SPY')
) AS m(asset_class, symbol, provider_symbol)
JOIN instruments i ON i.asset_class = m.asset_class AND i.symbol = m.symbol
JOIN data_providers p ON p.slug = 'twelve-data'
ON CONFLICT (provider_id, provider_symbol) DO NOTHING;
