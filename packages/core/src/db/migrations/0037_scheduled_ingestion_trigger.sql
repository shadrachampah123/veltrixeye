-- 0037: widen ingestion_runs trigger CHECK to include 'scheduled' (P1)
--
-- P1 adds a scheduled/pre-emptive candle ingestion service that runs before
-- each scanner cycle. Its ingestion_runs rows use trigger = 'scheduled', which
-- the original CHECK (fetch_through | backfill) would reject. This migration
-- drops and recreates the constraint with the new value included.
--
-- Additive: no column, index or other constraint is altered. Existing rows
-- are untouched — they remain valid under either constraint variant.

DO $$
DECLARE
  rec RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ingestion_runs'::regclass
      AND contype = 'c'
      AND conkey @> ARRAY[(SELECT ordinal_position::smallint FROM information_schema.columns WHERE table_name = 'ingestion_runs' AND column_name = 'trigger')]
      AND pg_get_constraintdef(oid) NOT LIKE '%scheduled%'
  ) THEN
    -- Drop the old trigger CHECK constraint(s) on the trigger column
    FOR rec IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'ingestion_runs'::regclass
        AND contype = 'c'
        AND conkey @> ARRAY[(SELECT ordinal_position::smallint FROM information_schema.columns WHERE table_name = 'ingestion_runs' AND column_name = 'trigger')]
    LOOP
      EXECUTE format('ALTER TABLE ingestion_runs DROP CONSTRAINT %I', rec.conname);
    END LOOP;
    -- Add the widened CHECK
    ALTER TABLE ingestion_runs ADD CHECK (trigger IN ('fetch_through', 'backfill', 'scheduled'));
  END IF;
END $$;
