-- 0003: strategies and strategy versions
--
-- strategies         = parent record (mutable metadata + status)
-- strategy_versions  = immutable-by-design snapshots of a strategy definition
--
-- Versioning rules (enforced here + in the service layer + triggers in 0007):
--  * version_number is unique per strategy and strictly increasing
--  * at most ONE draft version per strategy at any time
--  * a version with status <> 'draft' is immutable (see 0007)
--  * "current" version = highest published version (computed, no pointer)

CREATE TABLE strategies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'draft',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(name) BETWEEN 2 AND 80),
  CHECK (description IS NULL OR char_length(description) <= 500),
  CHECK (status IN ('draft', 'active', 'paused', 'archived'))
);

-- Strategy names are unique per user (case-insensitive), excluding soft-deleted.
CREATE UNIQUE INDEX strategies_user_name_unique
  ON strategies (user_id, lower(name));
CREATE INDEX strategies_user_idx ON strategies (user_id, created_at DESC);

CREATE TRIGGER strategies_set_updated_at
BEFORE UPDATE ON strategies
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE strategy_versions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id    uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
  changelog      text,
  created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  CHECK (version_number > 0),
  CHECK (status IN ('draft', 'published', 'deprecated')),
  CHECK (changelog IS NULL OR char_length(changelog) <= 500),
  CHECK (status = 'draft' OR published_at IS NOT NULL),
  CHECK (status <> 'draft' OR published_at IS NULL)
);

CREATE UNIQUE INDEX strategy_versions_strategy_number
  ON strategy_versions (strategy_id, version_number);
-- At most one draft version per strategy.
CREATE UNIQUE INDEX strategy_versions_single_draft
  ON strategy_versions (strategy_id) WHERE status = 'draft';
CREATE INDEX strategy_versions_strategy_idx
  ON strategy_versions (strategy_id, version_number DESC);
