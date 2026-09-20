-- 0029: M10 Gate 9 — durable provider mutation persistence (submit only).
--
-- Replacement authority for the previously unrecovered Gate 9 §22/§24/§31
-- persistence material. Scope: durable persistence and recovery safety for
-- provider order-SUBMIT mutations. Cancel/modify/close are out of scope.
--
-- This migration is ADDITIVE ONLY. Migration 0028 is not modified, no existing
-- constraint is dropped or weakened, and no table is dropped.
--
-- Hard properties encoded here:
--  * a provider-submit intent exists (committed) BEFORE the provider call;
--  * an unresolved intent/reservation/receipt/evidence row CANNOT be deleted
--    (retention §15) — expiry of the unrelated 60s risk TTL cannot erase it;
--  * the intent state machine is enforced by trigger, so a terminal state can
--    never fall back to `prepared`/`submitting` and an `uncertain` intent can
--    only leave through `reconciled`;
--  * every state change bumps `state_version`, so a stale/concurrent writer
--    loses instead of overwriting newer durable state;
--  * NO secret is storable: credential fields are reference identifiers and a
--    non-secret fingerprint, and a persisted receipt is rejected at the
--    database level if it carries a credential-shaped key.
--
-- Nothing in this migration enables live MT5/Exness execution, wires a broker
-- transport, activates a provider, or performs automatic repair/retry/cancel.

-- ---------------------------------------------------------------------------
-- 0. Receipt sanitization guard (database-side twin of the contract rule).
--    Credential-shaped keys are REJECTED, never redacted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION provider_receipt_keys_allowed(payload jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  forbidden text[] := ARRAY[
    'password', 'passwd', 'token', 'secret', 'apikey', 'api_key',
    'authorization', 'privatekey', 'credential'
  ];
  entry record;
  key_name text;
BEGIN
  IF payload IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(payload) = 'object' THEN
    FOR key_name IN SELECT jsonb_object_keys(payload) LOOP
      IF regexp_replace(lower(key_name), '[^a-z_]', '', 'g') = ANY(forbidden) THEN
        RETURN false;
      END IF;
    END LOOP;
    FOR entry IN SELECT value FROM jsonb_each(payload) LOOP
      IF NOT provider_receipt_keys_allowed(entry.value) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  ELSIF jsonb_typeof(payload) = 'array' THEN
    FOR entry IN SELECT value FROM jsonb_array_elements(payload) AS value LOOP
      IF NOT provider_receipt_keys_allowed(entry.value) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. Extend `execution_provider_intents` into the authoritative submit ledger
--    (additive: new columns only; existing columns/constraints untouched).
-- ---------------------------------------------------------------------------
ALTER TABLE execution_provider_intents
  ADD COLUMN IF NOT EXISTS mutation_kind text NOT NULL DEFAULT 'submit',
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_hash text,
  ADD COLUMN IF NOT EXISTS environment text,
  ADD COLUMN IF NOT EXISTS account_ref text,
  ADD COLUMN IF NOT EXISTS broker_server_ref text,
  ADD COLUMN IF NOT EXISTS credential_ref text,
  ADD COLUMN IF NOT EXISTS credential_fingerprint text,
  ADD COLUMN IF NOT EXISTS parent_intent_id uuid,
  ADD COLUMN IF NOT EXISTS root_intent_id uuid,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS reconciliation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_state text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS uncertainty_reason text,
  ADD COLUMN IF NOT EXISTS terminal_evidence text,
  ADD COLUMN IF NOT EXISTS resolution text,
  ADD COLUMN IF NOT EXISTS superseded_by_intent_id uuid,
  ADD COLUMN IF NOT EXISTS risk_decision_id uuid,
  ADD COLUMN IF NOT EXISTS state_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

-- Data-preserving backfill: a pre-existing uncertain intent keeps requiring
-- reconciliation under Gate 9. No row is deleted or rewritten in any other way.
UPDATE execution_provider_intents
   SET reconciliation_required = true,
       reconciliation_state = 'pending',
       outcome = 'uncertain'
 WHERE status = 'uncertain'
   AND (reconciliation_required IS DISTINCT FROM true
        OR reconciliation_state IS DISTINCT FROM 'pending'
        OR outcome IS DISTINCT FROM 'uncertain');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_mutation_kind_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_mutation_kind_check
      CHECK (mutation_kind IN ('submit', 'cancel', 'modify', 'close'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_idempotency_key_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_idempotency_key_check
      CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_request_hash_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_request_hash_check
      CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_environment_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_environment_check
      CHECK (environment IS NULL OR environment IN ('paper', 'demo'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_binding_refs_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_binding_refs_check
      CHECK (
        (account_ref IS NULL OR char_length(account_ref) BETWEEN 1 AND 128)
        AND (broker_server_ref IS NULL OR char_length(broker_server_ref) BETWEEN 1 AND 128)
        AND (credential_ref IS NULL OR char_length(credential_ref) BETWEEN 1 AND 128)
        AND (credential_fingerprint IS NULL OR credential_fingerprint ~ '^[0-9a-f]{64}$')
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_attempt_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_attempt_check
      CHECK (attempt >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_reconciliation_state_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_reconciliation_state_check
      CHECK (reconciliation_state IN ('not_required', 'pending', 'resolved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_outcome_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('accepted', 'rejected', 'uncertain'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_uncertainty_reason_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_uncertainty_reason_check
      CHECK (uncertainty_reason IS NULL OR uncertainty_reason IN (
        'timeout', 'connection_failure', 'lost_response', 'malformed_response',
        'unknown_provider_status', 'identity_verification_failed',
        'receipt_persistence_failure', 'state_commit_failed', 'process_restart',
        'crash_before_provider_call'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_terminal_evidence_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_terminal_evidence_check
      CHECK (terminal_evidence IS NULL OR terminal_evidence IN (
        'provider_response_verified', 'reconciliation_verified',
        'operator_resolution', 'pre_exchange_reservation_proof'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_resolution_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_resolution_check
      CHECK (resolution IS NULL OR resolution IN ('provider_accepted', 'provider_rejected', 'provider_absent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_state_version_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_state_version_check
      CHECK (state_version >= 1);
  END IF;

  -- State/outcome coherence. These are the durable expression of:
  --   * an unknown outcome is NEVER a rejection;
  --   * a definitive outcome always carries identity-verified evidence;
  --   * an unresolved intent never carries a definitive outcome.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_state_coherence_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_state_coherence_check
      -- Scoped to Gate 9 rows (every row written by the mutation ledger carries
      -- an idempotency key). Pre-0029 rows keep their original semantics and
      -- can never be transitioned by the Gate 9 ledger, so no historical row is
      -- rewritten or rejected here.
      CHECK (idempotency_key IS NULL OR (
        (
          status IN ('prepared', 'submitting')
          AND outcome IS NULL
          AND resolved_at IS NULL
          AND terminal_evidence IS NULL
          AND resolution IS NULL
        )
        OR (
          status = 'confirmed'
          AND outcome = 'accepted'
          AND reconciliation_required = false
          AND terminal_evidence IS NOT NULL
          AND uncertainty_reason IS NULL
          AND resolved_at IS NOT NULL
        )
        OR (
          status = 'rejected'
          AND outcome = 'rejected'
          AND reconciliation_required = false
          AND terminal_evidence IS NOT NULL
          AND uncertainty_reason IS NULL
          AND resolved_at IS NOT NULL
        )
        OR (
          status = 'uncertain'
          AND outcome = 'uncertain'
          AND reconciliation_required = true
          AND reconciliation_state = 'pending'
          AND terminal_evidence IS NULL
          AND resolved_at IS NULL
        )
        OR (
          status = 'reconciled'
          AND terminal_evidence IS NOT NULL
          AND resolution IS NOT NULL
          AND resolved_at IS NOT NULL
          AND (outcome IS NULL OR outcome IN ('accepted', 'rejected'))
          AND reconciliation_state = 'resolved'
          AND reconciliation_required = false
        )
      ));
  END IF;

  -- Retry lineage: a retry always points at its parent and its root; an
  -- original attempt never claims a parent.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_lineage_check') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_lineage_check
      CHECK (
        (attempt = 1 AND parent_intent_id IS NULL AND root_intent_id IS NULL)
        OR (attempt > 1 AND parent_intent_id IS NOT NULL AND root_intent_id IS NOT NULL
            AND parent_intent_id <> id AND root_intent_id <> id)
      );
  END IF;
END $$;

-- Unique mutation identity (§6): one durable intent per client-order identity,
-- per idempotency key and per canonical request hash, inside one account.
-- Global client-order uniqueness for Gate 9 mutations (a retry can never reuse
-- an existing durable identity). Pre-0029 rows keep the per-profile uniqueness
-- of 0019, so no historical data can block this migration.
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_client_order_uniq
  ON execution_provider_intents (client_order_id)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_idempotency_uniq
  ON execution_provider_intents (execution_profile_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_request_uniq
  ON execution_provider_intents (execution_profile_id, mutation_kind, request_hash)
  WHERE request_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_intents_mutation_uniq
  ON execution_provider_intents (execution_profile_id, mutation_kind, client_order_id);

CREATE INDEX IF NOT EXISTS execution_provider_intents_profile_idx
  ON execution_provider_intents (execution_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_provider_intents_unresolved_idx
  ON execution_provider_intents (execution_profile_id, status)
  WHERE status IN ('prepared', 'submitting', 'uncertain');
CREATE INDEX IF NOT EXISTS execution_provider_intents_lineage_idx
  ON execution_provider_intents (root_intent_id, attempt DESC)
  WHERE root_intent_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_provider_intents_parent_intent_fk'
  ) THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_parent_intent_fk
      FOREIGN KEY (parent_intent_id) REFERENCES execution_provider_intents (id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_provider_intents_root_intent_fk'
  ) THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_root_intent_fk
      FOREIGN KEY (root_intent_id) REFERENCES execution_provider_intents (id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_provider_intents_superseded_fk'
  ) THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_superseded_fk
      FOREIGN KEY (superseded_by_intent_id) REFERENCES execution_provider_intents (id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_provider_intents_risk_decision_fk'
  ) THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_risk_decision_fk
      FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Intent state machine + retention guards
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION provider_intent_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'prepared'   AND NEW.status = 'submitting')
      OR (OLD.status = 'submitting' AND NEW.status IN ('confirmed', 'rejected', 'uncertain'))
      -- Operator resolution of an intent that crashed in flight: such an intent
      -- is unresolved (§8) and may only be closed by documented evidence (§14).
      -- It can never become a new submission.
      OR (OLD.status = 'submitting' AND NEW.status = 'reconciled')
      OR (OLD.status = 'uncertain'   AND NEW.status = 'reconciled')
    ) THEN
      RAISE EXCEPTION 'illegal provider intent transition % -> %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Optimistic concurrency: every write advances the version, so a stale or
  -- concurrent writer cannot overwrite newer durable state.
  NEW.state_version := OLD.state_version + 1;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_intents_state_guard') THEN
    CREATE TRIGGER execution_provider_intents_state_guard
    BEFORE UPDATE ON execution_provider_intents
    FOR EACH ROW EXECUTE FUNCTION provider_intent_state_guard();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION provider_intent_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- §15: unresolved mutation evidence must survive restart, worker restart and
  -- ordinary cleanup. No TTL, lease or timeout may erase it.
  IF OLD.status IN ('prepared', 'submitting', 'uncertain') THEN
    RAISE EXCEPTION 'unresolved provider intent % (status %) cannot be deleted', OLD.id, OLD.status
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_intents_delete_guard') THEN
    CREATE TRIGGER execution_provider_intents_delete_guard
    BEFORE DELETE ON execution_provider_intents
    FOR EACH ROW EXECUTE FUNCTION provider_intent_delete_guard();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Mutation reservation (§4, §10)
--
--    Distinct from `risk_reservations`: that table remains responsible for
--    risk-exposure accounting and keeps its 60s crash-recovery TTL. This row
--    is the provider-mutation ledger: it keeps its own exposure copy so that
--    TTL reclamation of the risk row cannot erase unresolved mutation safety.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_provider_mutation_reservations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id             uuid NOT NULL REFERENCES execution_provider_intents (id),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id  uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  order_id              uuid REFERENCES execution_orders (id) ON DELETE SET NULL,
  risk_decision_id      uuid REFERENCES risk_decisions (id) ON DELETE SET NULL,
  -- The unrelated risk-exposure row. Reclaiming it (60s TTL) sets this to NULL;
  -- it must never delete or invalidate THIS row.
  risk_reservation_id   uuid REFERENCES risk_reservations (id) ON DELETE SET NULL,
  mutation_kind         text NOT NULL DEFAULT 'submit',
  client_order_id       text NOT NULL,
  idempotency_key       text NOT NULL,
  symbol                text,
  direction             text,
  monetary_risk         numeric(24, 10) NOT NULL DEFAULT 0,
  state                 text NOT NULL DEFAULT 'reserved',
  requires_reconciliation boolean NOT NULL DEFAULT false,
  -- Mirror of the risk TTL for observability only. Expiry here is NEVER proof
  -- that the mutation did not happen, and never authorizes a new submission.
  risk_expires_at       timestamptz,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_provider_mutation_reservations_kind_check
    CHECK (mutation_kind IN ('submit', 'cancel', 'modify', 'close')),
  CONSTRAINT execution_provider_mutation_reservations_state_check
    CHECK (state IN ('reserved', 'known_completed', 'known_rejected', 'uncertain')),
  CONSTRAINT execution_provider_mutation_reservations_idempotency_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_provider_mutation_reservations_client_order_check
    CHECK (char_length(client_order_id) BETWEEN 1 AND 64),
  CONSTRAINT execution_provider_mutation_reservations_direction_check
    CHECK (direction IS NULL OR direction IN ('long', 'short')),
  CONSTRAINT execution_provider_mutation_reservations_symbol_check
    CHECK (symbol IS NULL OR (symbol ~ '^[A-Z0-9][A-Z0-9._:-]*$' AND char_length(symbol) <= 32)),
  CONSTRAINT execution_provider_mutation_reservations_risk_check
    CHECK (monetary_risk >= 0),
  CONSTRAINT execution_provider_mutation_reservations_version_check
    CHECK (version >= 1),
  -- §4: uncertainty always requires reconciliation; definitive outcomes do not.
  CONSTRAINT execution_provider_mutation_reservations_coherence_check
    CHECK (
      (state = 'uncertain' AND requires_reconciliation = true)
      OR (state = 'known_completed' AND requires_reconciliation = false)
      OR (state = 'known_rejected' AND requires_reconciliation = false)
      OR (state = 'reserved' AND requires_reconciliation = false)
    ),
  CONSTRAINT execution_provider_mutation_reservations_intent_uniq
    UNIQUE (intent_id),
  CONSTRAINT execution_provider_mutation_reservations_idempotency_uniq
    UNIQUE (execution_profile_id, idempotency_key),
  CONSTRAINT execution_provider_mutation_reservations_client_order_uniq
    UNIQUE (execution_profile_id, mutation_kind, client_order_id)
);

CREATE INDEX IF NOT EXISTS execution_provider_mutation_reservations_profile_idx
  ON execution_provider_mutation_reservations (execution_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_provider_mutation_reservations_unresolved_idx
  ON execution_provider_mutation_reservations (execution_profile_id, state)
  WHERE state IN ('reserved', 'uncertain');
CREATE INDEX IF NOT EXISTS execution_provider_mutation_reservations_user_idx
  ON execution_provider_mutation_reservations (user_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_mutation_reservations_set_updated_at') THEN
    CREATE TRIGGER execution_provider_mutation_reservations_set_updated_at
    BEFORE UPDATE ON execution_provider_mutation_reservations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION provider_mutation_reservation_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'reserved' AND NEW.state IN ('known_completed', 'known_rejected', 'uncertain'))
      OR (OLD.state = 'uncertain' AND NEW.state IN ('known_completed', 'known_rejected'))
    ) THEN
      RAISE EXCEPTION 'illegal provider mutation reservation transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_mutation_reservations_state_guard') THEN
    CREATE TRIGGER execution_provider_mutation_reservations_state_guard
    BEFORE UPDATE ON execution_provider_mutation_reservations
    FOR EACH ROW EXECUTE FUNCTION provider_mutation_reservation_state_guard();
  END IF;
END $$;

-- §10: a reservation cannot be deleted solely because the 60s risk TTL expired.
CREATE OR REPLACE FUNCTION provider_mutation_reservation_delete_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state IN ('reserved', 'uncertain') THEN
    RAISE EXCEPTION 'unresolved provider mutation reservation % (state %) cannot be deleted', OLD.id, OLD.state
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_mutation_reservations_delete_guard') THEN
    CREATE TRIGGER execution_provider_mutation_reservations_delete_guard
    BEFORE DELETE ON execution_provider_mutation_reservations
    FOR EACH ROW EXECUTE FUNCTION provider_mutation_reservation_delete_guard();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Identity-verified, sanitized provider receipt (§5, §11)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_provider_receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id             uuid NOT NULL REFERENCES execution_provider_intents (id),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id  uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  client_order_id       text NOT NULL,
  idempotency_key       text NOT NULL,
  provider_slug         text NOT NULL,
  provider_order_id     text,
  outcome               text NOT NULL,
  -- Closed vocabulary: never provider text.
  uncertainty_reason    text,
  provider_status       text,
  status_uncertain      boolean NOT NULL DEFAULT false,
  identity_verified     boolean NOT NULL DEFAULT false,
  evidence              text,
  -- Allowlisted, sanitized receipt. No provider payload, no credential.
  receipt               jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_provider_receipts_outcome_check
    CHECK (outcome IN ('accepted', 'rejected', 'uncertain')),
  CONSTRAINT execution_provider_receipts_uncertainty_reason_check
    CHECK (uncertainty_reason IS NULL OR uncertainty_reason IN (
      'timeout', 'connection_failure', 'lost_response', 'malformed_response',
      'unknown_provider_status', 'identity_verification_failed',
      'receipt_persistence_failure', 'state_commit_failed', 'process_restart',
      'crash_before_provider_call'
    )),
  CONSTRAINT execution_provider_receipts_status_check
    CHECK (provider_status IS NULL OR provider_status IN (
      'requested', 'validating', 'submitted', 'accepted', 'partially_filled',
      'filled', 'rejected', 'cancelled', 'expired', 'failed', 'uncertain'
    )),
  CONSTRAINT execution_provider_receipts_idempotency_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_provider_receipts_client_order_check
    CHECK (char_length(client_order_id) BETWEEN 1 AND 64),
  CONSTRAINT execution_provider_receipts_provider_order_check
    CHECK (provider_order_id IS NULL OR char_length(provider_order_id) BETWEEN 1 AND 128),
  CONSTRAINT execution_provider_receipts_evidence_check
    CHECK (evidence IS NULL OR evidence IN (
      'provider_response_verified', 'reconciliation_verified',
      'operator_resolution', 'pre_exchange_reservation_proof'
    )),
  -- §2/§11: NOTHING secret-shaped can be persisted here.
  CONSTRAINT execution_provider_receipts_sanitized_check
    CHECK (provider_receipt_keys_allowed(receipt)),
  -- A definitive outcome carries identity-verified evidence; an uncertain one
  -- carries none (§23) and no provider ticket is claimed.
  CONSTRAINT execution_provider_receipts_outcome_coherence_check
    CHECK (
      (outcome = 'uncertain' AND evidence IS NULL AND uncertainty_reason IS NOT NULL AND provider_order_id IS NULL)
      OR (outcome = 'accepted' AND evidence IS NOT NULL AND uncertainty_reason IS NULL
          AND identity_verified = true AND provider_order_id IS NOT NULL)
      OR (outcome = 'rejected' AND evidence IS NOT NULL AND uncertainty_reason IS NULL
          AND identity_verified = true)
    )
);

-- At most one DEFINITIVE receipt per intent: a late or duplicate receipt cannot
-- rewrite the recorded outcome. Repeated uncertainty observations stay allowed.
CREATE UNIQUE INDEX IF NOT EXISTS execution_provider_receipts_definitive_uniq
  ON execution_provider_receipts (intent_id) WHERE outcome IN ('accepted', 'rejected');
CREATE INDEX IF NOT EXISTS execution_provider_receipts_intent_idx
  ON execution_provider_receipts (intent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_provider_receipts_profile_idx
  ON execution_provider_receipts (execution_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_provider_receipts_client_order_idx
  ON execution_provider_receipts (client_order_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_receipts_append_only') THEN
    CREATE TRIGGER execution_provider_receipts_append_only
    BEFORE UPDATE OR DELETE ON execution_provider_receipts
    FOR EACH ROW EXECUTE FUNCTION append_only_guard();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Reconciliation observations (§7) — observation only, never a repair.
--    A stale observation is marked stale and cannot move durable state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_provider_reconciliation_observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id             uuid NOT NULL REFERENCES execution_provider_intents (id),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id  uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  client_order_id       text NOT NULL,
  idempotency_key       text NOT NULL,
  provider_order_id     text,
  -- The attempt this observation describes. Staleness is judged against the
  -- newest attempt in the intent's retry lineage (§7).
  attempt               integer NOT NULL,
  outcome               text NOT NULL,
  provider_status       text,
  status_uncertain      boolean NOT NULL DEFAULT false,
  observed_at           timestamptz NOT NULL,
  -- True when a newer retry or a newer definitive outcome already exists.
  stale                 boolean NOT NULL DEFAULT false,
  superseded_by_intent_id uuid REFERENCES execution_provider_intents (id),
  applied               boolean NOT NULL DEFAULT false,
  evidence              text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_provider_reconciliation_observations_outcome_check
    CHECK (outcome IN ('matched', 'mismatched', 'not_found', 'uncertain')),
  CONSTRAINT execution_provider_reconciliation_observations_status_check
    CHECK (provider_status IS NULL OR provider_status IN (
      'requested', 'validating', 'submitted', 'accepted', 'partially_filled',
      'filled', 'rejected', 'cancelled', 'expired', 'failed', 'uncertain'
    )),
  CONSTRAINT execution_provider_reconciliation_observations_attempt_check
    CHECK (attempt >= 1),
  CONSTRAINT execution_provider_reconciliation_observations_evidence_check
    CHECK (evidence IS NULL OR evidence IN (
      'provider_response_verified', 'reconciliation_verified',
      'operator_resolution', 'pre_exchange_reservation_proof'
    )),
  CONSTRAINT execution_provider_reconciliation_observations_idempotency_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_provider_reconciliation_observations_client_order_check
    CHECK (char_length(client_order_id) BETWEEN 1 AND 64),
  -- A stale observation is never applied to durable state.
  CONSTRAINT execution_provider_reconciliation_observations_apply_check
    CHECK (applied = false OR stale = false),
  -- `not_found` is a proven observation of absence: it carries no provider
  -- status and is never recorded as a rejection (§7).
  CONSTRAINT execution_provider_reconciliation_observations_not_found_check
    CHECK (outcome <> 'not_found' OR (provider_status IS NULL AND status_uncertain = false)),
  CONSTRAINT execution_provider_reconciliation_observations_uncertain_check
    CHECK (outcome <> 'uncertain' OR (status_uncertain = true AND evidence IS NULL)),
  CONSTRAINT execution_provider_reconciliation_observations_matched_check
    CHECK (outcome NOT IN ('matched', 'mismatched') OR provider_status IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS execution_provider_reconciliation_observations_intent_idx
  ON execution_provider_reconciliation_observations (intent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_provider_reconciliation_observations_profile_idx
  ON execution_provider_reconciliation_observations (execution_profile_id, observed_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_reconciliation_observations_append_only') THEN
    CREATE TRIGGER execution_provider_reconciliation_observations_append_only
    BEFORE UPDATE OR DELETE ON execution_provider_reconciliation_observations
    FOR EACH ROW EXECUTE FUNCTION append_only_guard();
  END IF;
END $$;

-- Staleness is decided by the database, not by a caller's opinion: an
-- observation about an attempt that a newer retry has already superseded can
-- never be presented as current.
CREATE OR REPLACE FUNCTION provider_reconciliation_observation_staleness_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  newest_attempt integer;
  newer_intent uuid;
  current_status text;
BEGIN
  SELECT status INTO current_status FROM execution_provider_intents WHERE id = NEW.intent_id;
  SELECT i.attempt, i.id INTO newest_attempt, newer_intent
    FROM execution_provider_intents i
   WHERE (i.root_intent_id = (
            SELECT COALESCE(root.root_intent_id, root.id) FROM execution_provider_intents root WHERE root.id = NEW.intent_id
          )
          OR i.id = (
            SELECT COALESCE(root.root_intent_id, root.id) FROM execution_provider_intents root WHERE root.id = NEW.intent_id
          ))
     AND i.attempt > NEW.attempt
   ORDER BY i.attempt DESC, i.created_at DESC
   LIMIT 1;

  IF newest_attempt IS NOT NULL THEN
    NEW.stale := true;
    NEW.superseded_by_intent_id := newer_intent;
  ELSIF current_status IS NOT NULL AND current_status IN ('confirmed', 'rejected', 'reconciled') THEN
    NEW.stale := true;
  END IF;
  IF NEW.stale THEN
    NEW.applied := false;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_reconciliation_observations_staleness') THEN
    CREATE TRIGGER execution_provider_reconciliation_observations_staleness
    BEFORE INSERT ON execution_provider_reconciliation_observations
    FOR EACH ROW EXECUTE FUNCTION provider_reconciliation_observation_staleness_guard();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Operator resolution (§14) — evidence-bearing, never a silent deletion.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_provider_resolutions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id             uuid NOT NULL REFERENCES execution_provider_intents (id),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id  uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  client_order_id       text NOT NULL,
  idempotency_key       text NOT NULL,
  -- Who/what resolved it: `operator:<user-id>` or `system:<component>`.
  actor                 text NOT NULL,
  resolved_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  resolution            text NOT NULL,
  -- Approved evidence kind. Marking a finding "resolved" is NOT evidence.
  evidence              text NOT NULL,
  -- Documented evidence reference (bounded, free of secrets).
  evidence_reference    text,
  note                  text,
  from_status           text NOT NULL,
  to_status             text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_provider_resolutions_resolution_check
    CHECK (resolution IN ('provider_accepted', 'provider_rejected', 'provider_absent')),
  CONSTRAINT execution_provider_resolutions_evidence_check
    CHECK (evidence IN (
      'provider_response_verified', 'reconciliation_verified',
      'operator_resolution', 'pre_exchange_reservation_proof'
    )),
  CONSTRAINT execution_provider_resolutions_to_status_check
    CHECK (to_status = 'reconciled' AND from_status IN ('submitting', 'uncertain')),
  CONSTRAINT execution_provider_resolutions_actor_check
    CHECK (actor ~ '^(operator|system):[A-Za-z0-9._:-]{1,96}$'),
  CONSTRAINT execution_provider_resolutions_evidence_reference_check
    CHECK (evidence_reference IS NULL OR char_length(evidence_reference) BETWEEN 1 AND 256),
  CONSTRAINT execution_provider_resolutions_note_check
    CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  CONSTRAINT execution_provider_resolutions_idempotency_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_provider_resolutions_client_order_check
    CHECK (char_length(client_order_id) BETWEEN 1 AND 64),
  -- An operator resolution must name its documented evidence; a system
  -- resolution must carry verified provider/reconciliation evidence.
  CONSTRAINT execution_provider_resolutions_evidence_binding_check
    CHECK (
      (evidence = 'operator_resolution' AND evidence_reference IS NOT NULL AND resolved_by IS NOT NULL)
      OR (evidence <> 'operator_resolution' AND evidence_reference IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS execution_provider_resolutions_intent_idx
  ON execution_provider_resolutions (intent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_provider_resolutions_profile_idx
  ON execution_provider_resolutions (execution_profile_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_resolutions_append_only') THEN
    CREATE TRIGGER execution_provider_resolutions_append_only
    BEFORE UPDATE OR DELETE ON execution_provider_resolutions
    FOR EACH ROW EXECUTE FUNCTION append_only_guard();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Append-only mutation transition ledger (restart/audit evidence)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS execution_provider_mutation_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id     uuid NOT NULL REFERENCES execution_provider_intents (id),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  client_order_id text NOT NULL,
  idempotency_key text NOT NULL,
  attempt       integer NOT NULL,
  from_state    text,
  to_state      text NOT NULL,
  outcome       text,
  evidence      text,
  uncertainty_reason text,
  actor         text NOT NULL DEFAULT 'system:mutation-ledger',
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_provider_mutation_events_state_check
    CHECK (to_state IN ('prepared', 'submitting', 'confirmed', 'rejected', 'uncertain', 'reconciled')),
  CONSTRAINT execution_provider_mutation_events_from_state_check
    CHECK (from_state IS NULL OR from_state IN ('prepared', 'submitting', 'confirmed', 'rejected', 'uncertain', 'reconciled')),
  CONSTRAINT execution_provider_mutation_events_outcome_check
    CHECK (outcome IS NULL OR outcome IN ('accepted', 'rejected', 'uncertain')),
  CONSTRAINT execution_provider_mutation_events_evidence_check
    CHECK (evidence IS NULL OR evidence IN (
      'provider_response_verified', 'reconciliation_verified',
      'operator_resolution', 'pre_exchange_reservation_proof'
    )),
  CONSTRAINT execution_provider_mutation_events_uncertainty_reason_check
    CHECK (uncertainty_reason IS NULL OR uncertainty_reason IN (
      'timeout', 'connection_failure', 'lost_response', 'malformed_response',
      'unknown_provider_status', 'identity_verification_failed',
      'receipt_persistence_failure', 'state_commit_failed', 'process_restart',
      'crash_before_provider_call'
    )),
  CONSTRAINT execution_provider_mutation_events_attempt_check
    CHECK (attempt >= 1),
  CONSTRAINT execution_provider_mutation_events_idempotency_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT execution_provider_mutation_events_client_order_check
    CHECK (char_length(client_order_id) BETWEEN 1 AND 64),
  CONSTRAINT execution_provider_mutation_events_detail_check
    CHECK (jsonb_typeof(detail) = 'object' AND provider_receipt_keys_allowed(detail))
);

CREATE INDEX IF NOT EXISTS execution_provider_mutation_events_intent_idx
  ON execution_provider_mutation_events (intent_id, id DESC);
CREATE INDEX IF NOT EXISTS execution_provider_mutation_events_profile_idx
  ON execution_provider_mutation_events (execution_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_provider_mutation_events_user_idx
  ON execution_provider_mutation_events (user_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'execution_provider_mutation_events_append_only') THEN
    CREATE TRIGGER execution_provider_mutation_events_append_only
    BEFORE UPDATE OR DELETE ON execution_provider_mutation_events
    FOR EACH ROW EXECUTE FUNCTION append_only_guard();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Ownership: every Gate 9 row is provably owned by the profile's user.
--    A composite FK (not just two independent FKs) makes cross-tenant rows
--    impossible even if a future writer forgets to check.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS execution_profiles_id_user_idx
  ON execution_profiles (id, user_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_intents_profile_owner_fk') THEN
    ALTER TABLE execution_provider_intents
      ADD CONSTRAINT execution_provider_intents_profile_owner_fk
      FOREIGN KEY (execution_profile_id, user_id) REFERENCES execution_profiles (id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_mutation_reservations_owner_fk') THEN
    ALTER TABLE execution_provider_mutation_reservations
      ADD CONSTRAINT execution_provider_mutation_reservations_owner_fk
      FOREIGN KEY (execution_profile_id, user_id) REFERENCES execution_profiles (id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_receipts_owner_fk') THEN
    ALTER TABLE execution_provider_receipts
      ADD CONSTRAINT execution_provider_receipts_owner_fk
      FOREIGN KEY (execution_profile_id, user_id) REFERENCES execution_profiles (id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_reconciliation_observations_owner_fk') THEN
    ALTER TABLE execution_provider_reconciliation_observations
      ADD CONSTRAINT execution_provider_reconciliation_observations_owner_fk
      FOREIGN KEY (execution_profile_id, user_id) REFERENCES execution_profiles (id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_resolutions_owner_fk') THEN
    ALTER TABLE execution_provider_resolutions
      ADD CONSTRAINT execution_provider_resolutions_owner_fk
      FOREIGN KEY (execution_profile_id, user_id) REFERENCES execution_profiles (id, user_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'execution_provider_mutation_events_owner_fk') THEN
    ALTER TABLE execution_provider_mutation_events
      ADD CONSTRAINT execution_provider_mutation_events_owner_fk
      FOREIGN KEY (execution_profile_id, user_id) REFERENCES execution_profiles (id, user_id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON TABLE execution_provider_intents IS
  'M10 Gate 9: authoritative durable ledger for provider-submit mutations (§22/§31). One committed intent per mutation identity BEFORE the provider call; state machine + retention enforced by trigger; contains no credentials.';
COMMENT ON TABLE execution_provider_mutation_reservations IS
  'M10 Gate 9: provider-mutation reservation ledger (§4/§10). Distinct from risk_reservations (risk-exposure accounting, 60s TTL): an unresolved mutation reservation cannot be deleted by TTL, cleanup or restart.';
COMMENT ON TABLE execution_provider_receipts IS
  'M10 Gate 9: append-only, identity-verified sanitized provider receipts (§5/§11). Credential-shaped keys are rejected at the database level; provider payloads and secrets are never stored.';
COMMENT ON TABLE execution_provider_reconciliation_observations IS
  'M10 Gate 9: observation-only reconciliation results (§7). A stale observation is marked stale by trigger and can never overwrite a newer retry or a newer definitive outcome.';
COMMENT ON TABLE execution_provider_resolutions IS
  'M10 Gate 9: append-only operator/verified resolution records (§14). Preserves the original mutation identity and records who resolved it and on what documented evidence; never deletes the uncertain record.';
COMMENT ON TABLE execution_provider_mutation_events IS
  'M10 Gate 9: append-only transition ledger for provider mutation intents (restart/audit evidence, §8/§24).';
COMMENT ON COLUMN execution_provider_mutation_reservations.risk_reservation_id IS
  'Reference to the unrelated risk-exposure reservation. TTL reclamation of that row sets this to NULL and never deletes this mutation reservation.';
COMMENT ON COLUMN execution_provider_intents.credential_ref IS
  'Reference identifier only. Never a password, token, private key or secret payload (§11).';
