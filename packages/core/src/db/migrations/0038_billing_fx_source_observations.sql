-- 0038: Billing FX **source observations** — an append-only record of what an
-- approved external publisher published, kept DELIBERATELY SEPARATE from the
-- pricing authority.
--
-- WHY A SEPARATE TABLE (this is the whole point of the migration):
--
--   * `billing_fx_rate_versions` (0032) is the FX AUTHORITY. A row there can
--     price a payment, and only an operator-approved publication writes one.
--   * This table records what an approved publisher (today: the Bank of Ghana's
--     published daily interbank FX rates) had published when we read it. An
--     observation CANNOT price a payment: it is not read by the pricing path,
--     it carries no authority, and it is not a candidate rate version.
--
--   The two are never joined and this migration creates NO foreign key between
--   them, in either direction. Recording an observation therefore cannot
--   publish a rate, cannot alter the rate in force, and cannot reprice anything
--   already sold. Promotion of an observation to an authoritative version — if
--   that is ever approved — remains a separate, reviewed operator operation
--   that writes to 0032's table under its own approval boundary.
--
-- Design rules encoded here (and nowhere relaxed):
--
--   * APPEND-ONLY and IMMUTABLE. `UPDATE` and `DELETE` are refused by trigger,
--     so an observation can never be edited, re-dated or removed. A corrected
--     republication of the same date is a NEW row: the history of what was
--     published stays intact.
--   * DEDUPLICATED. A deterministic `observation_key` (SHA-256 over the
--     publisher, the pair, the publication date and the exact figures) is
--     UNIQUE per source, so a scheduler that runs too often inserts nothing —
--     and re-reading the same publication is a recognized duplicate rather than
--     a second observation.
--   * ONE APPROVED PUBLISHER, PINNED. `source_id` is constrained to the
--     approved vocabulary and `source_url` is constrained to the approved
--     literal URL. A deployment cannot observe an arbitrary host, and a
--     third-party mirror of the same figures is not this source.
--   * EXACT ARITHMETIC ONLY. Figures are scaled integers with ONE shared scale
--     (rate = value / 10^rate_scale). There is no float column, and the
--     published decimal strings are retained verbatim as evidence alongside the
--     integers, so the digits read from the publisher remain auditable.
--   * NO CREDENTIALS, NO PAYLOADS. A short retrieval label only; the retrieved
--     page is represented by a SHA-256 digest, never stored.
--   * NO SCHEDULING AND NO PUBLICATION IN SQL. This migration adds no job, no
--     trigger that publishes, no function that prices and no default that
--     enables anything. Running the check is an operator/scheduler decision;
--     publishing a rate is a separate approved operation.
--
-- This migration is ADDITIVE and forward-only: CREATE TABLE / CREATE INDEX /
-- CREATE FUNCTION / CREATE TRIGGER / COMMENT, preceded by a pre-flight guard.
-- Migrations 0001–0037 are byte-identical, no existing object is redefined or
-- replaced, and there is no UPDATE, no INSERT and no DELETE against existing
-- data.

-- ---------------------------------------------------------------------------
-- Pre-flight: this migration extends the billing model and depends on 0032's
-- authority table existing (so a reviewer can see the separation the schema
-- makes). Refuse to run against a database where it is missing, with a message
-- that says exactly what is missing, instead of failing halfway through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'billing_fx_rate_versions'
  ) THEN
    missing := array_append(missing, 'billing_fx_rate_versions');
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = format(
        '0038 refused: the billing foundations it extends are missing (%s). '
        || 'Migration 0032 (billing FX and pricing) must be applied first; nothing was modified.',
        array_to_string(missing, ', ')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. `billing_fx_source_observations` — what an approved publisher published.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_fx_source_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which approved publisher, and the exact URL it was read from. Both are
  -- closed: adding a publisher is an additive, reviewed migration.
  source_id text NOT NULL,
  source_url text NOT NULL,

  -- Deterministic dedup identity of WHAT was published (see the header). Unique
  -- per source, so the same publication read twice is one row.
  observation_key text NOT NULL,

  -- The pair, pinned. Nothing here prices a payment; this is the pair the
  -- observation is ABOUT.
  base_currency text NOT NULL DEFAULT 'USD',
  quote_currency text NOT NULL DEFAULT 'GHS',

  -- The publisher's own date for the figures.
  published_on date NOT NULL,

  -- The figures, exactly: one shared scale, no float anywhere.
  buying_scaled bigint NOT NULL,
  selling_scaled bigint NOT NULL,
  mid_rate_scaled bigint NOT NULL,
  rate_scale integer NOT NULL,

  -- The figures as published, verbatim, as evidence of what the digits were.
  buying_decimal text NOT NULL,
  selling_decimal text NOT NULL,
  mid_rate_decimal text NOT NULL,

  -- Evidence of the READ (never the payload): digests of the page and of the
  -- normalized row.
  body_digest text NOT NULL,
  row_digest text NOT NULL,

  -- When it was read, and by what (a scheduler/worker/operator label).
  retrieved_at timestamptz NOT NULL,
  retrieved_by text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_fx_source_observations_source_check
    CHECK (source_id IN ('bank_of_ghana')),
  -- The approved URL for the approved source. A mirror or aggregator is a
  -- different decision and cannot be recorded here by accident.
  CONSTRAINT billing_fx_source_observations_url_check
    CHECK (source_url = 'https://www.bog.gov.gh/treasury-and-the-markets/daily-interbank-fx-rates/'),
  CONSTRAINT billing_fx_source_observations_currency_pair_check
    CHECK (base_currency = 'USD' AND quote_currency = 'GHS'),
  CONSTRAINT billing_fx_source_observations_key_check
    CHECK (observation_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_fx_source_observations_body_digest_check
    CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_fx_source_observations_row_digest_check
    CHECK (row_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_fx_source_observations_rate_check
    CHECK (buying_scaled > 0 AND selling_scaled > 0 AND mid_rate_scaled > 0),
  CONSTRAINT billing_fx_source_observations_scale_check
    CHECK (rate_scale BETWEEN 1 AND 18),
  -- Coherence, enforced by the database as well as in code: a published row
  -- whose legs disagree is a corrupted read, not an observation.
  CONSTRAINT billing_fx_source_observations_coherence_check
    CHECK (buying_scaled <= mid_rate_scaled AND mid_rate_scaled <= selling_scaled),
  CONSTRAINT billing_fx_source_observations_decimal_shape_check
    CHECK (
      buying_decimal ~ '^[0-9]+(\.[0-9]+)?$'
      AND selling_decimal ~ '^[0-9]+(\.[0-9]+)?$'
      AND mid_rate_decimal ~ '^[0-9]+(\.[0-9]+)?$'
    ),
  -- The publisher's day cannot be in the future relative to the read. Compared
  -- against UTC midnight explicitly so the check does not depend on the
  -- server's session time zone.
  CONSTRAINT billing_fx_source_observations_retrieved_check
    CHECK (retrieved_at >= (published_on::timestamp AT TIME ZONE 'UTC')),
  CONSTRAINT billing_fx_source_observations_retrieved_by_check
    CHECK (char_length(retrieved_by) BETWEEN 1 AND 64),
  -- No credential-shaped text may ever be recorded as an attribution.
  CONSTRAINT billing_fx_source_observations_retrieved_by_shape_check
    CHECK (
      retrieved_by !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
    )
);

-- Dedup: one row per (publisher, publication content). `ON CONFLICT DO NOTHING`
-- against this index is what makes a too-frequent scheduler harmless.
CREATE UNIQUE INDEX billing_fx_source_observations_key_uniq
  ON billing_fx_source_observations (source_id, observation_key);

-- Report path: newest publication first, for a bounded read.
CREATE INDEX billing_fx_source_observations_lookup_idx
  ON billing_fx_source_observations (source_id, published_on DESC, retrieved_at DESC);

COMMENT ON TABLE billing_fx_source_observations IS
  'Billing FX source observations: append-only, immutable records of what an APPROVED publisher published when it was read (Bank of Ghana, USD->GHS). Deliberately separate from billing_fx_rate_versions — an observation never prices a payment, is not read by the pricing path and has no foreign key to the FX authority. Publishing an authoritative rate version stays a separate, operator-approved operation.';
COMMENT ON COLUMN billing_fx_source_observations.observation_key IS
  'Deterministic SHA-256 dedup identity: source, pair, publication date and the exact figures — never the retrieval instant. Two reads of the same publication collapse to one row; a corrected republication of the same date is a distinct row and is preserved.';
COMMENT ON COLUMN billing_fx_source_observations.source_url IS
  'The approved publisher URL, constrained to the Bank of Ghana daily interbank FX rates page. Third-party mirrors of the same figures are NOT this source.';
COMMENT ON COLUMN billing_fx_source_observations.mid_rate_scaled IS
  'Exact mid rate as a scaled integer: mid = mid_rate_scaled / 10^rate_scale. Integer only — no float column exists in the observation path either.';
COMMENT ON COLUMN billing_fx_source_observations.body_digest IS
  'SHA-256 of the retrieved page. Evidence of WHAT was read; the page itself is never stored. It proves the read, not the correctness of the publisher''s figure.';

-- Append-only: an observation is never edited and never deleted. A correction is
-- a new row for the publisher's later publication date (or a corrected
-- republication of the same date, which has its own key), so what was seen at a
-- point in time can always be explained later.
CREATE FUNCTION billing_fx_source_observations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_fx_source_observations is append-only: an observation is immutable. '
             || 'Record the publisher''s next publication as a new row instead.';
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '27000',
    MESSAGE = 'billing_fx_source_observations is append-only: an observation is never deleted. '
           || 'The history of what a publisher published is kept.';
END $$;

CREATE TRIGGER billing_fx_source_observations_append_only
  BEFORE UPDATE OR DELETE ON billing_fx_source_observations
  FOR EACH ROW EXECUTE FUNCTION billing_fx_source_observations_append_only();

-- ---------------------------------------------------------------------------
-- 2. Note for reviewers, in the schema itself: there is NO link between an
-- observation and the FX authority, and none is intended.
-- ---------------------------------------------------------------------------

COMMENT ON INDEX billing_fx_source_observations_key_uniq IS
  'Deduplication for source observations only. Unrelated to billing_fx_rate_versions: no FK, no shared identity and no promotion path exists between an observation and a published rate version.';
