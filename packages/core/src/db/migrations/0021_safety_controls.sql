-- 0021: kill-switch & safety controls (M8.6)
--
-- M8.6 strengthens the emergency-stop machinery WITHOUT relaxing any earlier
-- boundary. Live execution remains impossible (`0016` CHECK untouched); no
-- credentials are modeled anywhere; automation stays OFF by default.
--
-- What this migration adds (all additive — no existing constraint altered):
--   kill_switches.source/actor_user_id/activated_at — provenance for the
--       current state: which kind of control last moved the switch, which
--       user moved it, and when the latest activation happened.
--   kill_switch_events — APPEND-ONLY history ledger. Every change attempt is
--       recorded (including redundant activate/clear calls, with
--       `changed = false`), with scope, target, resolved owner user id,
--       actor, reason, source and timestamp. Rows are never updatable or
--       deletable (guard trigger), so the trail cannot be rewritten.
--   risk_policies.circuit_breaker_enabled — platform safety control (default
--       ON). When the risk engine rejects on a loss-limit breach it trips the
--       user's kill switch durably; users cannot turn this off through the
--       API (the column has no route).

-- ---------------------------------------------------------------------------
-- Kill switches: provenance for the current state
-- ---------------------------------------------------------------------------
ALTER TABLE kill_switches ADD COLUMN source text NOT NULL DEFAULT 'operator';
ALTER TABLE kill_switches ADD COLUMN actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE kill_switches ADD COLUMN activated_at timestamptz;

ALTER TABLE kill_switches
  ADD CONSTRAINT kill_switches_source_check
  CHECK (source IN ('operator', 'user', 'circuit_breaker'));

-- Self-healing provenance: ANY write that flips a switch ON without a stamp
-- (legacy operator SQL, test seeds, future tooling) gets one from the DB
-- itself — the audit timestamp cannot be accidentally omitted. Writes that go
-- through KillSwitchService already supply the exact moment; an ACTIVE row
-- therefore always answers "when did this arm?".
CREATE OR REPLACE FUNCTION kill_switches_stamp_activation() RETURNS trigger AS $$
BEGIN
  IF NEW.active AND NEW.activated_at IS NULL THEN
    NEW.activated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kill_switches_stamp_activation
BEFORE INSERT OR UPDATE OF active ON kill_switches
FOR EACH ROW EXECUTE FUNCTION kill_switches_stamp_activation();

-- ---------------------------------------------------------------------------
-- Kill-switch event ledger (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE kill_switch_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Resolved owner of the affected switch (NULL only for global switches with
  -- no acting user). Tenant reads filter on this column.
  user_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  scope          text NOT NULL,
  -- NULL for the global switch; otherwise the id of the scoped entity.
  target_id      uuid,
  action         text NOT NULL,
  source         text NOT NULL,
  reason         text,
  -- false ⇔ the call did not change state (redundant activate/clear); it is
  -- STILL recorded so the trail shows every attempt, not just the wins.
  changed        boolean NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (scope IN ('global', 'user', 'strategy', 'execution_profile')),
  CHECK (action IN ('activated', 'cleared')),
  CHECK (source IN ('operator', 'user', 'circuit_breaker')),
  CHECK (
    (scope = 'global' AND target_id IS NULL)
    OR (scope <> 'global' AND target_id IS NOT NULL)
  ),
  CHECK (action <> 'activated' OR source <> 'circuit_breaker' OR changed),
  CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX kill_switch_events_user_idx ON kill_switch_events (user_id, created_at DESC);
CREATE INDEX kill_switch_events_scope_idx ON kill_switch_events (scope, target_id, created_at DESC);

CREATE TRIGGER kill_switch_events_append_only
BEFORE UPDATE OR DELETE ON kill_switch_events
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

COMMENT ON TABLE kill_switch_events IS
  'M8.6: append-only kill-switch history — every activate/clear attempt with actor, source and reason. Never updated, never deleted.';
COMMENT ON COLUMN kill_switches.source IS
  'M8.6: which control last moved the switch (operator | user | circuit_breaker).';

-- ---------------------------------------------------------------------------
-- Risk policies: automatic circuit breaker (platform-owned safety default)
-- ---------------------------------------------------------------------------
ALTER TABLE risk_policies
  ADD COLUMN circuit_breaker_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN risk_policies.circuit_breaker_enabled IS
  'M8.6: a loss-limit rejection also trips the user kill switch (durable stop until explicitly cleared). Not user-editable; no API writes this column.';
