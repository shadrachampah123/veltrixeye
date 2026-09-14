-- 0009: setup-detection idempotency key (M4)
--
-- M4 detection must be idempotent: re-running detection for the same
-- strategy version + instrument + direction + asOfMs must return the
-- existing setup instead of inserting a duplicate — even under concurrent
-- requests. Application-level "check then insert" cannot guarantee that, so
-- the key lives in the schema as a UNIQUE constraint and concurrent
-- duplicates are serialized by it (the loser catches the 23505 violation
-- and re-selects the winner's row).
--
-- `as_of_ms` is the deterministic M3 evaluation anchor the setup was
-- detected from (NOT a wall-clock timestamp): same version + instrument +
-- direction + anchor + candles ⇒ same setup, always.
--
-- This migration is additive and safe on databases that already hold setup
-- rows (M1–M3 never wrote any, but the backfill covers them anyway):
-- existing rows inherit their anchor from `detected_at`.

ALTER TABLE setups ADD COLUMN as_of_ms bigint;

UPDATE setups
SET as_of_ms = (EXTRACT(EPOCH FROM detected_at) * 1000)::bigint
WHERE as_of_ms IS NULL;

ALTER TABLE setups ALTER COLUMN as_of_ms SET NOT NULL;

ALTER TABLE setups
  ADD CONSTRAINT setups_detection_key_uniq
  UNIQUE (strategy_version_id, instrument_id, direction, as_of_ms);

COMMENT ON COLUMN setups.as_of_ms IS
  'M4: deterministic M3 evaluation anchor (epoch-ms UTC) this setup was detected from. Part of the detection idempotency key.';
