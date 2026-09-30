-- 0016: Add user_id to scanner_runs for tenant privacy (F4 fix)
--
-- The scanner_runs ledger was previously global to all Pro/Premium users,
-- exposing other users' UUIDs in metadata (triggeredBy, strategyId).
-- This migration adds a user_id column and backfills it from metadata->>'triggeredBy'
-- for existing rows, enabling owner-scoped access.

ALTER TABLE scanner_runs
  ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Backfill user_id from metadata for existing rows
UPDATE scanner_runs
SET user_id = (metadata->>'triggeredBy')::uuid
WHERE user_id IS NULL
  AND metadata->>'triggeredBy' IS NOT NULL
  AND (metadata->>'triggeredBy') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Index for owner-scoped queries
CREATE INDEX scanner_runs_user_id_idx ON scanner_runs (user_id, started_at DESC);

COMMENT ON COLUMN scanner_runs.user_id IS 'Owner of this scanner run (for tenant privacy). Backfilled from metadata.triggeredBy for existing rows.';
