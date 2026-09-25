-- 0033: Billing Step 7 — durable payment-evidence for verified Paystack transactions.
--
-- This migration adds the durable, append-only evidence table for VERIFIED
-- provider transactions. It is the ONLY durable state Step 7 adds, and it
-- deliberately does NOT activate entitlements, does NOT change the catalogue
-- plan, does NOT change provider lifecycle state, does NOT grant automation
-- or execution, and does NOT change paymentConfirmed to true. The existing
-- provider-backed FREE entitlement gate and the existing fail-closed
-- paymentConfirmed contract remain untouched.
--
-- The table `billing_verified_transactions` records one row per verified
-- Paystack transaction that has been reconciled against its immutable
-- pricing snapshot. It is the confirmation authority's EVIDENCE ledger:
-- a receipt that a provider transaction was verified through the documented
-- GET /transaction/verify/:reference read, in sandbox/test mode, and that
-- the observed amount/currency/exponent/reference/domain/status/customer
-- coherently matches the checkout snapshot that authorized it.
--
-- Design rules encoded here (and nowhere relaxed):
--
-- * PAYSTACK ONLY, SANDBOX ONLY: `provider` is pinned to `paystack` and
--   `provider_domain` to `test`. A live domain or a different provider is
--   refused at the database level, and enabling live mode is an additive
--   migration in a later PR.
-- * EXACT INTEGER MONEY ONLY: `payment_amount_minor` is a positive bigint
--   in the payment currency's minor unit (GHS pesewa), `payment_currency`
--   is pinned to `GHS` and `payment_amount_exponent` to 2 (ISO 4217).
--   There is no numeric/float/double column, and no money arithmetic is
--   performed in SQL — the one half-up step lives in
--   `packages/core/src/billing/pricing.ts` and is verified by the
--   reconciliation service.
-- * POSITIVE AMOUNT, GHS EXPONENT 2, UNIQUE REFERENCE + UNIQUE IDEMPOTENCY:
--   a transaction reference identifies one provider transaction and is
--   UNIQUE per provider; the deterministic idempotency key is UNIQUE and
--   collapses a replayed verification onto one row. A second, conflicting
--   observation for the same reference is a hard failure, never an overwrite.
-- * IMMUTABLE EVIDENCE, APPEND-ONLY: identity columns (user, subscription,
--   pricing snapshot, provider, reference, transaction identifier, amount,
--   currency/exponent, status/domain, customer identifiers, paid_at,
--   verified_at, evidence hash, idempotency key) are immutable by trigger;
--   the table is append-only (UPDATE and DELETE are refused). A correction
--   is a manual review, never a silent edit.
-- * NO CARD AUTHORIZATION MATERIAL: no `authorization_code`, `bin`, `last4`,
--   expiry, `card_type`, `bank`, `brand`, `signature` or reusable flag is
--   stored, typed or logged. The provider's `authorization` object is never
--   read, and credential-shaped text is refused outright.
-- * PAYLOAD REDACTION POSTURE: the raw provider payload is never persisted;
--   only a SHA-256 `evidence_hash` of the canonical verified facts (or the
--   canonical payload JSON where appropriate) and the deterministic
--   `idempotency_key` are stored, mirroring the 0029 Gate-9 receipt ledger
--   and the 0031 provider-event ledger.
-- * STRICT FOREIGN KEYS: every row references an existing `users`,
--   `subscriptions` and `billing_pricing_snapshots` row. A verified
--   transaction without a known user, subscription and pricing snapshot
--   cannot be recorded.
--
-- Compatibility: this migration is ADDITIVE and forward-only. It creates
-- one table, its indexes, triggers and comments, and touches no existing
-- table, column, index or trigger. Migrations 0001–0032 are byte-identical,
-- no object created earlier is redefined, and the `set_updated_at()` helper
-- from 0001 is reused, never redeclared. No paymentConfirmed, entitlement
-- or broker/live-execution column is changed.
--
-- Nothing here enables execution. Automation, live execution and broker
-- execution stay OFF for every plan regardless of payment evidence.

-- ---------------------------------------------------------------------------
-- Pre-flight: refuse if the billing foundations this evidence ledger extends
-- are missing. This keeps the migration from failing halfway through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'set_updated_at' AND n.nspname = current_schema()
  ) THEN
    missing := array_append(missing, 'set_updated_at()');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
    missing := array_append(missing, 'users');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions') THEN
    missing := array_append(missing, 'subscriptions');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_pricing_snapshots') THEN
    missing := array_append(missing, 'billing_pricing_snapshots');
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = format(
        '0033 refused: the billing foundations it extends are missing (%s). '
        || 'Migrations 0031 (provider billing) and 0032 (FX/pricing) must be applied first; nothing was modified.',
        array_to_string(missing, ', ')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. `billing_verified_transactions` — durable payment evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_verified_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Billing context: the evidence is always for a known user, their
  -- subscription and the immutable pricing snapshot that authorized the
  -- checkout. All three are foreign keys, so an orphan row is impossible.
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  pricing_snapshot_id uuid NOT NULL REFERENCES billing_pricing_snapshots (id),

  -- Provider identity. Pinned to Paystack and to sandbox/test only.
  provider text NOT NULL DEFAULT 'paystack',
  provider_reference text NOT NULL,
  -- The provider's own transaction identifier (numeric id string where the
  -- verify payload carries one). Nullable: older deliveries may not carry it,
  -- and it is never required to create evidence — the reference is the
  -- canonical identity.
  provider_transaction_id text,

  -- What was verified: the amount the provider reported, in payment-currency
  -- minor units, with its exponent. All three are CHECK-enforced to the
  -- sandbox GHS facts, and no float column exists anywhere in this path.
  payment_amount_minor bigint NOT NULL,
  payment_currency text NOT NULL DEFAULT 'GHS',
  payment_amount_exponent integer NOT NULL DEFAULT 2,

  -- Provider-reported facts as observed during verification.
  provider_status text NOT NULL,
  provider_domain text NOT NULL DEFAULT 'test',

  -- Provider customer identity as observed (where the verify payload carries
  -- one). Either may be null when the provider does not echo one, but when
  -- present they are reference-shaped identifiers, never credential-shaped.
  provider_customer_id text,
  provider_customer_code text,

  -- The instant the provider reports the transaction was paid, and the
  -- instant this platform verified it. Both are instants, not derived.
  paid_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),

  -- Payload/evidence hash (SHA-256 hex of the canonical verified facts or
  -- the canonical payload JSON). The raw provider payload is never stored.
  evidence_hash text NOT NULL,

  -- Deterministic idempotency key (SHA-256 hex of the canonical evidence
  -- identity). Collapses a replayed verification onto one row via the UNIQUE
  -- index.
  idempotency_key text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- -----------------------------------------------------------------------
  -- Strict constraints: paystack only, test only, GHS only, positive amount,
  -- credential-shaped rejection, hex formats, length bounds.
  -- -----------------------------------------------------------------------

  CONSTRAINT billing_verified_transactions_provider_check
    CHECK (provider = 'paystack'),
  CONSTRAINT billing_verified_transactions_currency_check
    CHECK (payment_currency = 'GHS'),
  CONSTRAINT billing_verified_transactions_exponent_check
    CHECK (payment_amount_exponent = 2),
  CONSTRAINT billing_verified_transactions_amount_check
    CHECK (payment_amount_minor > 0),
  CONSTRAINT billing_verified_transactions_domain_check
    CHECK (provider_domain = 'test'),
  CONSTRAINT billing_verified_transactions_provider_reference_check
    CHECK (char_length(provider_reference) BETWEEN 1 AND 190),
  CONSTRAINT billing_verified_transactions_provider_transaction_id_check
    CHECK (provider_transaction_id IS NULL OR char_length(provider_transaction_id) BETWEEN 1 AND 128),
  CONSTRAINT billing_verified_transactions_provider_status_check
    CHECK (char_length(provider_status) BETWEEN 1 AND 64),
  CONSTRAINT billing_verified_transactions_provider_customer_id_check
    CHECK (provider_customer_id IS NULL OR char_length(provider_customer_id) BETWEEN 1 AND 128),
  CONSTRAINT billing_verified_transactions_provider_customer_code_check
    CHECK (provider_customer_code IS NULL OR char_length(provider_customer_code) BETWEEN 1 AND 128),
  CONSTRAINT billing_verified_transactions_evidence_hash_check
    CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_verified_transactions_idempotency_key_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  -- No credential-shaped material may ever be persisted as evidence.
  CONSTRAINT billing_verified_transactions_reference_shape_check
    CHECK (
      provider_reference !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND coalesce(provider_transaction_id, '') !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND coalesce(provider_customer_id, '') !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND coalesce(provider_customer_code, '') !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND provider_status !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
    ),
  -- Hex keys are exactly 64 lowercase hex characters (SHA-256).
  CONSTRAINT billing_verified_transactions_provider_reference_shape_check
    CHECK (provider_reference !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)')
);

-- Provider reference is the canonical provider identity: globally unique.
CREATE UNIQUE INDEX billing_verified_transactions_provider_reference_uniq
  ON billing_verified_transactions (provider_reference);

-- Deterministic idempotency: a replayed verification collapses onto one row.
CREATE UNIQUE INDEX billing_verified_transactions_idempotency_uniq
  ON billing_verified_transactions (idempotency_key);

-- Tenant lookup: all evidence for a user or subscription, newest first.
CREATE INDEX billing_verified_transactions_user_idx
  ON billing_verified_transactions (user_id, created_at DESC);
CREATE INDEX billing_verified_transactions_subscription_idx
  ON billing_verified_transactions (subscription_id, created_at DESC);
CREATE INDEX billing_verified_transactions_pricing_snapshot_idx
  ON billing_verified_transactions (pricing_snapshot_id);
CREATE INDEX billing_verified_transactions_paid_at_idx
  ON billing_verified_transactions (paid_at DESC);
CREATE INDEX billing_verified_transactions_created_at_idx
  ON billing_verified_transactions (created_at DESC);

COMMENT ON TABLE billing_verified_transactions IS
  'Billing Step 7: append-only, immutable evidence for verified Paystack transactions (sandbox/test only). One row per verified checkout reference, reconciled against its immutable pricing snapshot. Evidence is SHA-256 addressed, idempotent by deterministic key, and never grants entitlements, automation or execution. Raw provider payloads and card authorization material are never stored.';

COMMENT ON COLUMN billing_verified_transactions.provider_reference IS
  'Our deterministic checkout reference (ve-chk-… hash of user + pricing snapshot). UNIQUE: one evidence row per provider transaction. Never credential-shaped material.';
COMMENT ON COLUMN billing_verified_transactions.provider_transaction_id IS
  'The provider''s own transaction identifier (numeric id string where the verify payload carries one). Nullable, opaque, never derived and never a credential — only a provider reference.';
COMMENT ON COLUMN billing_verified_transactions.payment_amount_minor IS
  'Verified payment amount in GHS minor units (pesewas), integer only. Must equal the locked pricing snapshot''s payment amount exactly; no float, no tolerance.';
COMMENT ON COLUMN billing_verified_transactions.provider_status IS
  'Provider-reported transaction status as observed during verification (documented value, e.g. success). Uninterpreted here; only reconciliation decides evidence validity.';
COMMENT ON COLUMN billing_verified_transactions.provider_domain IS
  'Provider environment that reported the transaction. Pinned to test (sandbox) — live is refused.';
COMMENT ON COLUMN billing_verified_transactions.paid_at IS
  'Provider-reported instant the transaction was paid (paid_at). Required for payment evidence; a transaction without it is not evidence.';
COMMENT ON COLUMN billing_verified_transactions.verified_at IS
  'Local instant the transaction was verified through the documented GET /transaction/verify/:reference read.';
COMMENT ON COLUMN billing_verified_transactions.evidence_hash IS
  'SHA-256 hex of the canonical verified facts (or canonical payload JSON). The raw provider payload is never persisted — only its hash.';
COMMENT ON COLUMN billing_verified_transactions.idempotency_key IS
  'Deterministic SHA-256 hex key for the verified transaction (provider | reference | amount | snapshot). A replayed verification collapses onto the existing row; a conflicting observation for the same reference is refused.';

-- ---------------------------------------------------------------------------
-- Append-only and immutable evidence. A verified transaction is observed
-- once; a correction is a manual review, never a silent edit, and a
-- verified row is never deleted — it is the audit trail of what was
-- verified.
-- ---------------------------------------------------------------------------

CREATE FUNCTION billing_verified_transactions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_verified_transactions is append-only: a verified payment evidence row is immutable once recorded. '
             || 'A conflicting observation is a hard failure requiring review, not a silent overwrite.';
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '27000',
    MESSAGE = 'billing_verified_transactions rows are never deleted: they are the audit trail of verified payments.';
END $$;

CREATE TRIGGER billing_verified_transactions_append_only
  BEFORE UPDATE OR DELETE ON billing_verified_transactions
  FOR EACH ROW EXECUTE FUNCTION billing_verified_transactions_append_only();

-- Identity immutability is enforced by the append-only trigger above (every
-- UPDATE is refused). The trigger below documents that intent at the column
-- level and is kept for parity with billing_provider_events: an UPDATE that
-- somehow bypassed the append-only guard would still be refused here.
CREATE FUNCTION billing_verified_transactions_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.user_id IS DISTINCT FROM OLD.user_id)
     OR (NEW.subscription_id IS DISTINCT FROM OLD.subscription_id)
     OR (NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id)
     OR (NEW.provider IS DISTINCT FROM OLD.provider)
     OR (NEW.provider_reference IS DISTINCT FROM OLD.provider_reference)
     OR (NEW.provider_transaction_id IS DISTINCT FROM OLD.provider_transaction_id)
     OR (NEW.payment_amount_minor IS DISTINCT FROM OLD.payment_amount_minor)
     OR (NEW.payment_currency IS DISTINCT FROM OLD.payment_currency)
     OR (NEW.payment_amount_exponent IS DISTINCT FROM OLD.payment_amount_exponent)
     OR (NEW.provider_status IS DISTINCT FROM OLD.provider_status)
     OR (NEW.provider_domain IS DISTINCT FROM OLD.provider_domain)
     OR (NEW.provider_customer_id IS DISTINCT FROM OLD.provider_customer_id)
     OR (NEW.provider_customer_code IS DISTINCT FROM OLD.provider_customer_code)
     OR (NEW.paid_at IS DISTINCT FROM OLD.paid_at)
     OR (NEW.verified_at IS DISTINCT FROM OLD.verified_at)
     OR (NEW.evidence_hash IS DISTINCT FROM OLD.evidence_hash)
     OR (NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key) THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_verified_transactions identity is immutable: a verified payment evidence row cannot be changed.';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER billing_verified_transactions_identity_immutable_trg
  BEFORE UPDATE ON billing_verified_transactions
  FOR EACH ROW EXECUTE FUNCTION billing_verified_transactions_identity_immutable();

CREATE TRIGGER billing_verified_transactions_set_updated_at
  BEFORE UPDATE ON billing_verified_transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
