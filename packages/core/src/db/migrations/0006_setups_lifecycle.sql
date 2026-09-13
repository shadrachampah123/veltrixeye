-- 0006: setup lifecycle foundation (no scanner logic yet)
--
-- A "setup" is a detected candidate trade on a specific instrument, always
-- traceable to the strategy version that produced it (strategy_version_id).
-- M1 creates the lifecycle schema only; state transitions are driven by the
-- future scanner (M3+).
--
-- Lifecycle: developing → watching → almost_ready → confirmed → triggered → completed
--                                                    ↘ invalidated / expired

CREATE TABLE setups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions (id),
  instrument_id       uuid NOT NULL REFERENCES instruments (id),
  state               text NOT NULL DEFAULT 'developing',
  direction           text NOT NULL,
  detected_at         timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  entry_price         numeric(24, 10),
  stop_loss_price     numeric(24, 10),
  tp1_price           numeric(24, 10),
  tp2_price           numeric(24, 10),
  tp3_price           numeric(24, 10),
  quality_score       integer,
  metadata            jsonb NOT NULL DEFAULT '{}',
  CHECK (state IN ('developing', 'watching', 'almost_ready', 'confirmed',
                   'triggered', 'invalidated', 'expired', 'completed')),
  CHECK (direction IN ('long', 'short')),
  CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100)
);

CREATE INDEX setups_version_state_idx ON setups (strategy_version_id, state);
CREATE INDEX setups_instrument_state_idx ON setups (instrument_id, state);
CREATE INDEX setups_active_expires_idx
  ON setups (expires_at)
  WHERE state NOT IN ('invalidated', 'expired', 'completed');

CREATE TRIGGER setups_set_updated_at
BEFORE UPDATE ON setups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only state transition log: every change of a setup's state is
-- recorded here and can never be edited or removed (guarded in 0007).
CREATE TABLE setup_state_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setup_id   uuid NOT NULL REFERENCES setups (id) ON DELETE CASCADE,
  from_state text,
  to_state   text NOT NULL,
  reason     text,
  payload    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_state IN ('developing', 'watching', 'almost_ready', 'confirmed',
                      'triggered', 'invalidated', 'expired', 'completed')),
  CHECK (from_state IS NULL OR from_state IN ('developing', 'watching', 'almost_ready',
               'confirmed', 'triggered', 'invalidated', 'expired', 'completed'))
);

CREATE INDEX setup_state_events_setup_idx ON setup_state_events (setup_id, created_at);

-- Immutable scoring history: one row per scoring run, so any setup's score
-- history is fully traceable to the engine version that produced it.
CREATE TABLE setup_scores (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  setup_id       uuid NOT NULL REFERENCES setups (id) ON DELETE CASCADE,
  engine_version text NOT NULL,
  total          integer NOT NULL,
  grade          text NOT NULL,
  components     jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (total BETWEEN 0 AND 100),
  CHECK (grade IN ('A+', 'A', 'B', 'C', 'ignore')),
  CHECK (char_length(engine_version) BETWEEN 1 AND 120)
);

CREATE INDEX setup_scores_setup_idx ON setup_scores (setup_id, created_at DESC);
