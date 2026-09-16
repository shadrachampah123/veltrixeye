-- 0015: live scanner execution state (M7.5)
--
-- M7.5 turns the explicitly-invoked detection path (M4) into a production
-- scanner that processes real market data through the full pipeline:
--
--   Market Data → Normalization → Validation/Freshness → Strategy Detection
--   → Setup Qualification → Scoring → Risk/Quality Validation → Alert Generation
--   → Notification Outbox
--
-- Requirements encoded in the schema:
--  - scanner_runs: append-only ledger of every scan execution (observability,
--    health, last-successful-scan, failure triage). Status is running |
--    completed | failed | partial (some strategies failed, some succeeded).
--  - scanner_cursors: per (strategy_version, instrument, timeframe) last
--    processed candle time. Prevents re-processing the same closed candle
--    repeatedly and survives restarts. Updated transactionally with a run.
--  - Advisory locking (application-level, not a table) serialises concurrent
--    scanner executions — the service uses pg_try_advisory_lock with a fixed
--    key so two workers/instances never overlap. The table itself does NOT
--    enforce locking; it records what happened.
--
-- This migration is additive: CREATE TABLE/INDEX/TRIGGER only. No existing
-- table, column, index or constraint is altered. The set_updated_at() helper
-- from 0001 is reused.

CREATE TABLE scanner_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                text NOT NULL,
  provider_slug         text NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz,
  strategies_scanned    integer NOT NULL DEFAULT 0,
  instruments_scanned   integer NOT NULL DEFAULT 0,
  candles_fetched       integer NOT NULL DEFAULT 0,
  setups_detected       integer NOT NULL DEFAULT 0,
  setups_created        integer NOT NULL DEFAULT 0,
  alerts_created        integer NOT NULL DEFAULT 0,
  stale_rejections      integer NOT NULL DEFAULT 0,
  provider_failures     integer NOT NULL DEFAULT 0,
  symbols_processed     jsonb NOT NULL DEFAULT '[]'::jsonb,
  timeframes_processed  jsonb NOT NULL DEFAULT '[]'::jsonb,
  error                 text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  CHECK (strategies_scanned >= 0),
  CHECK (instruments_scanned >= 0),
  CHECK (candles_fetched >= 0),
  CHECK (setups_detected >= 0),
  CHECK (setups_created >= 0),
  CHECK (alerts_created >= 0),
  CHECK (stale_rejections >= 0),
  CHECK (provider_failures >= 0),
  CHECK (char_length(provider_slug) BETWEEN 1 AND 64)
);

CREATE INDEX scanner_runs_status_idx ON scanner_runs (status, started_at DESC);
CREATE INDEX scanner_runs_started_at_idx ON scanner_runs (started_at DESC);
CREATE INDEX scanner_runs_created_at_idx ON scanner_runs (created_at DESC);

COMMENT ON TABLE scanner_runs IS
  'M7.5: append-only ledger of live scanner executions. One row per run, updated from running → completed/failed/partial. Used for health, last-successful-scan, and operational observability.';

CREATE TRIGGER scanner_runs_set_updated_at
BEFORE UPDATE ON scanner_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-version/instrument/timeframe cursor: last closed candle that was
-- processed. Prevents re-processing the same candle after a restart and
-- allows the scanner to skip instruments whose latest candle has not advanced.
CREATE TABLE scanner_cursors (
  strategy_version_id   uuid NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  instrument_id         uuid NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
  timeframe             text NOT NULL,
  last_candle_time      bigint NOT NULL,
  last_scan_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy_version_id, instrument_id, timeframe),
  CHECK (timeframe IN ('1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d','3d','1w','1M')),
  CHECK (last_candle_time > 0)
);

CREATE INDEX scanner_cursors_instrument_idx ON scanner_cursors (instrument_id, timeframe);
CREATE INDEX scanner_cursors_version_idx ON scanner_cursors (strategy_version_id);
CREATE INDEX scanner_cursors_updated_at_idx ON scanner_cursors (updated_at DESC);

COMMENT ON TABLE scanner_cursors IS
  'M7.5: last processed candle per (strategy_version, instrument, timeframe). Survives restarts and prevents duplicate processing of the same closed candle.';

CREATE TRIGGER scanner_cursors_set_updated_at
BEFORE UPDATE ON scanner_cursors
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
