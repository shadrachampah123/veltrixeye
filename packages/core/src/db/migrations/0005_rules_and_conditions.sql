-- 0005: rule groups and conditions
--
-- Rule model:
--   strategy_rule_groups  — named stages (e.g. "HTF Bias", "Structure",
--                           "Entry", "Filters") that group conditions;
--                           conditions within a group are combined with the
--                           group's logic (AND/OR). Groups are combined with
--                           AND at the version level.
--   strategy_conditions   — typed, parameterized rules. `condition_type` is
--                           TEXT (not a DB enum) on purpose: the set of valid
--                           types is the extensible in-code registry in
--                           packages/contracts (see docs/strategy-model.md).
--
-- Classification semantics:
--   required       — must be satisfied
--   optional       — may contribute to the quality score only
--   confirmation   — must be satisfied (evaluated at the entry timeframe)
--   disqualifying  — if satisfied, the setup is rejected
--
-- `parent_group_id` exists so groups can be nested later WITHOUT a schema
-- migration; M1 only creates flat groups (parent_group_id IS NULL).

CREATE TABLE strategy_rule_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id      uuid NOT NULL REFERENCES strategy_versions (id) ON DELETE CASCADE,
  parent_group_id uuid REFERENCES strategy_rule_groups (id) ON DELETE CASCADE,
  name            text NOT NULL,
  logic           text NOT NULL,
  position        integer NOT NULL DEFAULT 0,
  CHECK (char_length(name) BETWEEN 1 AND 80),
  CHECK (logic IN ('AND', 'OR')),
  CHECK (position >= 0 AND position <= 10000)
);

CREATE INDEX strategy_rule_groups_version_idx ON strategy_rule_groups (version_id, position);
-- Flat M1 groups have unique positions within a version.
CREATE UNIQUE INDEX strategy_rule_groups_flat_position
  ON strategy_rule_groups (version_id, position) WHERE parent_group_id IS NULL;

CREATE TABLE strategy_conditions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       uuid NOT NULL REFERENCES strategy_rule_groups (id) ON DELETE CASCADE,
  condition_type text NOT NULL,
  classification text NOT NULL,
  timeframe_role text NOT NULL,
  params         jsonb NOT NULL DEFAULT '{}',
  description    text,
  position       integer NOT NULL DEFAULT 0,
  UNIQUE (group_id, position),
  CHECK (char_length(condition_type) BETWEEN 1 AND 64),
  CHECK (classification IN ('required', 'optional', 'confirmation', 'disqualifying')),
  CHECK (timeframe_role IN ('htf_bias', 'setup', 'entry', 'any')),
  CHECK (description IS NULL OR char_length(description) <= 280),
  CHECK (position >= 0 AND position <= 10000)
);

CREATE INDEX strategy_conditions_group_idx ON strategy_conditions (group_id, position);
CREATE INDEX strategy_conditions_type_idx ON strategy_conditions (condition_type);
