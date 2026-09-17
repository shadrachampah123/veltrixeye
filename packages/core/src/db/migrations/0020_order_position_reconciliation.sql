-- 0020: M8.5 — Order & Position Reconciliation
-- Additive only. New tables for reconciliation runs, findings, snapshots
-- and resolution bookkeeping. No credentials. No destructive actions enabled.

CREATE TABLE reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  trigger text NOT NULL DEFAULT 'manual',
  health_state text NOT NULL DEFAULT 'synchronized',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  failure_reason text,
  expected_orders integer NOT NULL DEFAULT 0,
  expected_positions integer NOT NULL DEFAULT 0,
  provider_orders integer NOT NULL DEFAULT 0,
  provider_positions integer NOT NULL DEFAULT 0,
  matched_orders integer NOT NULL DEFAULT 0,
  matched_positions integer NOT NULL DEFAULT 0,
  findings_total integer NOT NULL DEFAULT 0,
  findings_open integer NOT NULL DEFAULT 0,
  provider_unavailable boolean NOT NULL DEFAULT false,
  expected_order_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_position_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_order_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_position_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_order_pairs jsonb NOT NULL DEFAULT '[]'::jsonb,
  matched_position_pairs jsonb NOT NULL DEFAULT '[]'::jsonb,
  architecture_version text NOT NULL,
  reconciliation_version text NOT NULL,
  lock_key bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('started','provider_snapshot_acquired','matching','findings_created','resolved','no_action','failed')),
  CHECK (trigger IN ('manual','startup','scheduled','post_submit')),
  CHECK (health_state IN ('synchronized','mismatch_detected','uncertain','provider_unavailable','manual_resolution_required')),
  CHECK (expected_orders >= 0),
  CHECK (expected_positions >= 0),
  CHECK (provider_orders >= 0),
  CHECK (provider_positions >= 0),
  CHECK (matched_orders >= 0),
  CHECK (matched_positions >= 0),
  CHECK (findings_total >= 0),
  CHECK (findings_open >= 0)
);
CREATE INDEX reconciliation_runs_user_idx ON reconciliation_runs (user_id, started_at DESC);
CREATE INDEX reconciliation_runs_profile_idx ON reconciliation_runs (execution_profile_id, started_at DESC);
CREATE INDEX reconciliation_runs_status_idx ON reconciliation_runs (status);
CREATE INDEX reconciliation_runs_health_idx ON reconciliation_runs (health_state) WHERE health_state <> 'synchronized';
CREATE TRIGGER reconciliation_runs_set_updated_at
BEFORE UPDATE ON reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE reconciliation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reconciliation_runs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  provider_unavailable boolean NOT NULL DEFAULT false,
  provider_unavailable_reason text,
  orders_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  positions_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(provider_id) BETWEEN 1 AND 64)
);
CREATE INDEX reconciliation_snapshots_run_idx ON reconciliation_snapshots (run_id);
CREATE INDEX reconciliation_snapshots_user_idx ON reconciliation_snapshots (user_id, created_at DESC);

CREATE TABLE reconciliation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES reconciliation_runs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  code text NOT NULL,
  severity text NOT NULL DEFAULT 'error',
  scope text NOT NULL,
  internal_order_id uuid REFERENCES execution_orders (id) ON DELETE SET NULL,
  internal_position_id uuid REFERENCES execution_positions (id) ON DELETE SET NULL,
  provider_order_id text,
  provider_position_id text,
  expected_field text,
  expected_value jsonb,
  actual_value jsonb,
  detail jsonb,
  resolution_state text NOT NULL DEFAULT 'open',
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (code IN (
    'internal_order_missing_at_provider','provider_order_missing_internally',
    'internal_position_missing_at_provider','provider_position_missing_internally',
    'status_mismatch','partial_fill_quantity_mismatch','filled_quantity_mismatch',
    'direction_mismatch','symbol_mismatch','entry_price_mismatch',
    'stop_loss_mismatch','take_profit_mismatch','unexpected_provider_state',
    'stale_state','uncertain_outcome','provider_unavailable','ambiguous_match','tenant_mismatch')),
  CHECK (severity IN ('info','warning','error','critical')),
  CHECK (scope IN ('order','position','provider','snapshot','run')),
  CHECK (resolution_state IN ('open','acknowledged','resolved','ignored')),
  CHECK (provider_order_id IS NULL OR char_length(provider_order_id) BETWEEN 1 AND 128),
  CHECK (provider_position_id IS NULL OR char_length(provider_position_id) BETWEEN 1 AND 128),
  CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 500)
);
CREATE INDEX reconciliation_findings_user_idx ON reconciliation_findings (user_id, created_at DESC);
CREATE INDEX reconciliation_findings_run_idx ON reconciliation_findings (run_id);
CREATE INDEX reconciliation_findings_profile_idx ON reconciliation_findings (execution_profile_id, created_at DESC);
CREATE INDEX reconciliation_findings_state_idx ON reconciliation_findings (resolution_state) WHERE resolution_state <> 'resolved' AND resolution_state <> 'ignored';
CREATE INDEX reconciliation_findings_code_idx ON reconciliation_findings (code);
CREATE TRIGGER reconciliation_findings_set_updated_at
BEFORE UPDATE ON reconciliation_findings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Idempotency ledger: a run with an identical (profile, trigger, provider) within
-- the dedupe window collapses to the existing run instead of producing a new one.
-- We also use pg_advisory_xact_lock on a derived bigint to serialize concurrent runs.

COMMENT ON TABLE reconciliation_runs IS 'M8.5 provider-neutral reconciliation runs. No credentials; destructive corrective actions are gated OFF.';
COMMENT ON TABLE reconciliation_snapshots IS 'M8.5 immutable provider state snapshot captured at the start of a reconciliation run.';
COMMENT ON TABLE reconciliation_findings IS 'M8.5 mismatch findings requiring review (or auto-resolution when safety permits).';
COMMENT ON COLUMN reconciliation_runs.lock_key IS 'Advisory-lock key used to serialize concurrent reconciliation runs for the same profile.';
