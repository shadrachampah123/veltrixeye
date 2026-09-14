-- 0010: setup-score idempotency key (M5)
--
-- M5 scoring must be idempotent: re-scoring the same setup with the same
-- engine version at the same anchor must return the existing score row
-- instead of inserting a duplicate — even under concurrent requests.
-- Application-level "check then insert" cannot guarantee that, so the key
-- lives in the schema as a UNIQUE constraint and concurrent duplicates are
-- serialized by it (the loser catches the 23505 violation and re-selects
-- the winner's row), exactly like the 0009 detection key.
--
-- `as_of_ms` is the deterministic M3 evaluation anchor the score was
-- computed from (NOT a wall-clock timestamp): same setup + engine version
-- + anchor ⇒ same scoring context ⇒ exactly one score row, always.
-- `setup_scores.created_at` mirrors the M4 transition convention: the
-- service writes the supplied scoring anchor into it, so a score row is
-- fully deterministic in (setup, engine version, anchor).
--
-- This migration is additive and safe on existing databases: no code before
-- M5 ever wrote `setup_scores` (M4 deliberately never scores), so the table
-- is empty in practice. The nullable-then-NOT-NULL backfill mirrors the
-- 0009 pattern anyway, deriving the anchor from `created_at` for any
-- hypothetical pre-existing rows.

ALTER TABLE setup_scores ADD COLUMN as_of_ms bigint;

UPDATE setup_scores
SET as_of_ms = (EXTRACT(EPOCH FROM created_at) * 1000)::bigint
WHERE as_of_ms IS NULL;

ALTER TABLE setup_scores ALTER COLUMN as_of_ms SET NOT NULL;

ALTER TABLE setup_scores
  ADD CONSTRAINT setup_scores_context_uniq
  UNIQUE (setup_id, engine_version, as_of_ms);

COMMENT ON COLUMN setup_scores.as_of_ms IS
  'M5: deterministic M3 evaluation anchor (epoch-ms UTC) this score was computed from. Part of the scoring idempotency key.';
