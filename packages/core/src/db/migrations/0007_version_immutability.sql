-- 0007: structural immutability of published strategy versions
--
-- Policy (see docs/strategy-model.md):
--  * A version in status 'draft' may be updated/deleted by its owner.
--  * Once published, the version row and ALL of its configuration rows are
--    immutable at the database level, not just in application code.
--  * The single allowed transition after publishing is
--    published -> deprecated (status-only change, audited by the service).
--  * setup_state_events and setup_scores are append-only.
--
-- Consequence: a strategy that has published versions cannot be hard-deleted
-- (its history must stay traceable); archive it instead. This is enforced by
-- the service layer with a clear error message.

CREATE OR REPLACE FUNCTION strategy_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('published', 'deprecated') THEN
      RAISE EXCEPTION 'strategy version % is immutable (status: %)',
        OLD.id, OLD.status USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'draft' THEN
    RETURN NEW; -- draft versions are editable (including the publish transition)
  END IF;
  IF OLD.status = 'published'
     AND NEW.status = 'deprecated'
     AND NEW.strategy_id = OLD.strategy_id
     AND NEW.version_number = OLD.version_number
     AND NEW.changelog IS NOT DISTINCT FROM OLD.changelog
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
  THEN
    RETURN NEW; -- the only allowed post-publish transition
  END IF;
  RAISE EXCEPTION 'strategy version % is immutable (status: %)',
    OLD.id, OLD.status USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_versions_guard
BEFORE UPDATE OR DELETE ON strategy_versions
FOR EACH ROW EXECUTE FUNCTION strategy_version_guard();

-- Guard for version-owned configuration tables (INSERT/UPDATE/DELETE).
-- Trigger functions must be RETURNS trigger and read NEW/OLD internally;
-- they cannot receive them as arguments.
CREATE OR REPLACE FUNCTION version_config_guard() RETURNS trigger AS $$
DECLARE
  vid uuid;
  vstatus text;
BEGIN
  vid := COALESCE(NEW.version_id, OLD.version_id);
  SELECT status INTO vstatus FROM strategy_versions WHERE id = vid;
  IF vstatus IS NULL THEN
    -- The version row is already gone: this can only happen mid-cascade from
    -- the version's own deletion (a draft being deleted by the owner). Direct
    -- writes with a missing version are still rejected by the FK constraint.
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF vstatus <> 'draft' THEN
    RAISE EXCEPTION 'strategy version % is immutable (status: %)', vid, vstatus
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_timeframes_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_timeframes
FOR EACH ROW EXECUTE FUNCTION version_config_guard();

CREATE TRIGGER strategy_market_scopes_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_market_scopes
FOR EACH ROW EXECUTE FUNCTION version_config_guard();

CREATE TRIGGER strategy_market_scope_instruments_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_market_scope_instruments
FOR EACH ROW EXECUTE FUNCTION version_config_guard();

CREATE TRIGGER strategy_session_filters_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_session_filters
FOR EACH ROW EXECUTE FUNCTION version_config_guard();

CREATE TRIGGER strategy_risk_config_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_risk_config
FOR EACH ROW EXECUTE FUNCTION version_config_guard();

CREATE TRIGGER strategy_filters_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_filters
FOR EACH ROW EXECUTE FUNCTION version_config_guard();

CREATE TRIGGER strategy_rule_groups_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_rule_groups
FOR EACH ROW EXECUTE FUNCTION version_config_guard();

CREATE OR REPLACE FUNCTION condition_group_guard() RETURNS trigger AS $$
DECLARE
  gid uuid;
  vstatus text;
BEGIN
  gid := COALESCE(NEW.group_id, OLD.group_id);
  SELECT v.status INTO vstatus
  FROM strategy_rule_groups g
  JOIN strategy_versions v ON v.id = g.version_id
  WHERE g.id = gid;
  IF vstatus IS NULL THEN
    -- Group/version already gone: only possible mid-cascade (see above).
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF vstatus <> 'draft' THEN
    RAISE EXCEPTION 'rule group % belongs to an immutable strategy version (status: %)',
      gid, vstatus USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_conditions_guard
BEFORE INSERT OR UPDATE OR DELETE ON strategy_conditions
FOR EACH ROW EXECUTE FUNCTION condition_group_guard();

CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'this table is append-only: % is not allowed', TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER setup_state_events_append_only
BEFORE UPDATE OR DELETE ON setup_state_events
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER setup_scores_append_only
BEFORE UPDATE OR DELETE ON setup_scores
FOR EACH ROW EXECUTE FUNCTION append_only_guard();
