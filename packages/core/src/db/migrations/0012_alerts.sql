-- 0012: setup alerts + delivery ledger (M6)
--
-- An alert is generated EXPLICITLY from one owned setup (no scheduler, no
-- scanner in M6 — like M4 detection and M5 scoring, generation is invoked,
-- never automatic). The pinned generation rule:
--   1. the setup is in an eligible state (`confirmed` or `triggered`);
--   2. an M5 score row exists for the setup at its detection anchor;
--   3. that score total is >= the version's `risk.minQualityScore` gate.
--
-- Deduplication: UNIQUE (setup_id, trigger_state), so a setup yields at most
-- two alerts (`confirmed` + `triggered`) — retries collapse onto the row.
--
-- Delivery in M6 is a ledger with a STUB sender: `alert_deliveries` records
-- one append-only row per attempt (`channel: 'stub'`, `status: 'delivered'`)
-- WITHOUT any external I/O. The `email`/`webhook`/`push` channel values are
-- reserved so real delivery needs no migration later.
--
-- This migration is additive: CREATE TABLE/INDEX/TRIGGER only. The
-- `append_only_guard()` function already exists (0007) and is reused here,
-- never redefined.

CREATE TABLE alerts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  setup_id            uuid NOT NULL REFERENCES setups (id) ON DELETE CASCADE,
  strategy_id         uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  strategy_version_id uuid NOT NULL REFERENCES strategy_versions (id),
  instrument_id       uuid NOT NULL REFERENCES instruments (id),
  direction           text NOT NULL,
  -- The setup state that generated this alert (dedup key with setup_id).
  trigger_state       text NOT NULL,
  -- The M5 total at generation (always >= min_quality_score by the gate).
  quality_score       integer NOT NULL,
  -- The version's risk.minQualityScore at generation time (audit trail).
  min_quality_score   integer NOT NULL,
  -- Deterministic human-readable summary (<= 280 chars, like transition reasons).
  title               text NOT NULL,
  -- Structured payload (levels, score reference, links) — never raw candles.
  body                jsonb NOT NULL DEFAULT '{}',
  status              text NOT NULL DEFAULT 'pending',
  acknowledged_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (direction IN ('long', 'short')),
  CHECK (trigger_state IN ('confirmed', 'triggered')),
  CHECK (quality_score BETWEEN 0 AND 100),
  CHECK (min_quality_score BETWEEN 0 AND 100),
  CHECK (status IN ('pending', 'acknowledged', 'suppressed')),
  CHECK (char_length(title) BETWEEN 1 AND 280)
);

-- One alert per setup per triggering state (dedup: retries collapse).
CREATE UNIQUE INDEX alerts_setup_state_uniq ON alerts (setup_id, trigger_state);
CREATE INDEX alerts_user_idx ON alerts (user_id, created_at DESC);
CREATE INDEX alerts_strategy_idx ON alerts (strategy_id, created_at DESC);
CREATE INDEX alerts_status_idx ON alerts (user_id, status, created_at DESC);

COMMENT ON TABLE alerts IS
  'M6: explicitly generated setup alerts. At most one row per (setup, triggering state); generation requires the M5 quality gate to pass.';

CREATE TABLE alert_deliveries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id     uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  channel      text NOT NULL,
  status       text NOT NULL,
  attempt      integer NOT NULL DEFAULT 1,
  error        text,
  -- sha256 hex of the rendered payload (dedup + audit).
  payload_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (channel IN ('stub', 'email', 'webhook', 'push')),
  CHECK (status IN ('delivered', 'failed')),
  CHECK (attempt >= 1),
  CHECK (char_length(payload_hash) = 64)
);

CREATE INDEX alert_deliveries_alert_idx ON alert_deliveries (alert_id, id);
CREATE UNIQUE INDEX alert_deliveries_idempotency_uniq ON alert_deliveries (alert_id, channel, payload_hash);

COMMENT ON TABLE alert_deliveries IS
  'M6: append-only alert delivery ledger. M6 records stub attempts only — no external delivery is performed.';

CREATE TRIGGER alert_deliveries_append_only
BEFORE UPDATE OR DELETE ON alert_deliveries
FOR EACH ROW EXECUTE FUNCTION append_only_guard();
