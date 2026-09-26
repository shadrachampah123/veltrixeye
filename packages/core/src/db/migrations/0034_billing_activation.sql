-- 0034: Billing Step 8 — the ACTIVATION AUTHORITY ledger.
--
-- This migration adds the durable, immutable, append-only ACTIVATION FACT
-- table. It is the ONLY durable state Step 8 adds, and it is the missing
-- half of the paid-entitlement authority:
--
--   verified payment evidence (0033)  →  out-of-band operator authorization
--                                     →  immutable activation fact (this)
--                                     →  read-side paid entitlement
--
-- WHAT THIS TABLE IS
--  - a record that an OPERATOR, out of band, authorized the activation of one
--    commercial subscription whose payment evidence was already verified and
--    reconciled. It is an authorization FACT, never a payment observation and
--    never a provider statement.
--  - the ONLY thing the read side consults to decide whether a provider-backed
--    subscription row may resolve to its paid entitlement (see
--    `packages/core/src/billing/entitlement-resolution.ts`).
--
-- WHAT THIS TABLE IS NOT
--  - It is NOT payment evidence. Evidence is `billing_verified_transactions`
--    (0033) and stays evidence; an activation row REFERENCES it and can never
--    replace it.
--  - It is NOT a subscription state machine. Nothing here writes
--    `subscriptions.plan`, `subscriptions.status`, `subscriptions.provider_state`
--    or any synchronization bookkeeping, and nothing here writes `users.plan`.
--  - It is NOT reachable from HTTP. There is no activation route, no admin
--    role, no operator endpoint, no activation token and no provider call: the
--    only writer is the out-of-band, DB-connected CLI
--    (`scripts/billing/activate.ts`) driven by an operator.
--  - It grants NO execution. `canAccessAutomation` stays `false` for every
--    plan, and automation/live execution/broker execution stay OFF.
--
-- Design rules encoded here (and nowhere relaxed):
--
-- * ONE FACT PER SUBSCRIPTION. `subscription_id` is UNIQUE: a subscription is
--   activated exactly once, and a replayed activation collapses onto the
--   existing fact (idempotent replay), never a second row.
-- * EVIDENCE-BOUND. `evidence_id` is a NOT NULL foreign key to
--   `billing_verified_transactions` and is UNIQUE: an activation can only ever
--   point at durable, verified payment evidence, and one evidence row can
--   activate at most one subscription.
-- * IMMUTABLE + APPEND-ONLY. Every UPDATE and every DELETE is refused by
--   trigger. A correction is a manual review, never a silent edit.
-- * COHERENCE IS THE DATABASE'S JOB. The coherence trigger re-derives, from the
--   live rows, that the fact agrees with its subscription, its immutable
--   pricing snapshot and its verified evidence on user, subscription,
--   snapshot, plan, interval, provider plan, provider, reference, currency,
--   amount, exponent and evidence hash — and that neither a Starter catalogue
--   plan nor the excluded capability-evidence provider plan can be activated.
-- * OPERATOR IDENTITY IS RECORDED, NEVER INFERRED. `operator_id` and
--   `activation_reason` are NOT NULL: an activation without a named operator
--   and a stated reason is unrepresentable. Neither is a credential, a token
--   or a secret, and credential-shaped text is refused by CHECK.
-- * NO PAYLOAD, NO SECRET, NO CARD MATERIAL. Only canonical identifiers, the
--   SHA-256 evidence hash and the deterministic idempotency key are stored.
--
-- Compatibility: this migration is ADDITIVE and forward-only. It creates one
-- table, its indexes, triggers and comments, and touches no existing table,
-- column, index or trigger. Migrations 0001–0033 are byte-identical, no object
-- created earlier is redefined, and the `set_updated_at()` helper from 0001 is
-- reused, never redeclared.
--
-- Nothing here enables execution. Automation, live execution and broker
-- execution stay OFF for every plan regardless of activation.

-- ---------------------------------------------------------------------------
-- Pre-flight: refuse if the billing foundations this ledger extends are
-- missing. This keeps the migration from failing halfway through.
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

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_verified_transactions') THEN
    missing := array_append(missing, 'billing_verified_transactions');
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = format(
        '0034 refused: the billing foundations it extends are missing (%s). '
        || 'Migrations 0031 (provider billing), 0032 (FX/pricing) and 0033 (payment evidence) must be applied first; nothing was modified.',
        array_to_string(missing, ', ')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. `billing_subscription_activations` — the immutable activation fact.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_subscription_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Billing context: an activation is always for a known user, their
  -- commercial subscription and the immutable pricing snapshot that
  -- authorized the sale. All three are foreign keys, so an orphan row is
  -- impossible.
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  pricing_snapshot_id uuid NOT NULL REFERENCES billing_pricing_snapshots (id),

  -- The verified payment evidence this activation rests on. NOT NULL and
  -- UNIQUE: an activation without durable evidence is unrepresentable, and
  -- one evidence row activates at most one subscription.
  evidence_id uuid NOT NULL REFERENCES billing_verified_transactions (id),

  -- What was activated, copied from the immutable pricing snapshot at
  -- activation time so the fact is self-describing and never re-derived.
  -- Starter is NOT persistable here: it is not a sellable plan.
  catalogue_plan text NOT NULL,
  billing_interval text NOT NULL,
  provider text NOT NULL DEFAULT 'paystack',
  provider_plan_id text,
  provider_reference text NOT NULL,

  -- The exact payment the evidence verified, copied from the evidence row.
  payment_currency text NOT NULL DEFAULT 'GHS',
  payment_amount_minor bigint NOT NULL,
  payment_amount_exponent integer NOT NULL DEFAULT 2,

  -- SHA-256 of the canonical verified facts that authorized this activation
  -- (copied from the evidence row so the fact stays self-describing). The raw
  -- provider payload is never stored anywhere in this path.
  evidence_hash text NOT NULL,

  -- WHO authorized the activation, out of band, and WHY. Never inferred,
  -- never a credential, never a token.
  operator_id text NOT NULL,
  activation_reason text NOT NULL,

  -- The instant the operator authorized the activation.
  activated_at timestamptz NOT NULL DEFAULT now(),

  -- Deterministic idempotency key (SHA-256 hex of the canonical activation
  -- identity). Collapses a replayed activation onto the one existing fact.
  idempotency_key text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- -----------------------------------------------------------------------
  -- Strict constraints: paystack only, GHS/2 only, sellable plans only,
  -- hex formats, length bounds, credential-shaped rejection.
  -- -----------------------------------------------------------------------

  CONSTRAINT billing_subscription_activations_provider_check
    CHECK (provider = 'paystack'),
  CONSTRAINT billing_subscription_activations_catalogue_plan_check
    CHECK (catalogue_plan IN ('pro', 'elite')),
  CONSTRAINT billing_subscription_activations_interval_check
    CHECK (billing_interval IN ('monthly', 'annual')),
  CONSTRAINT billing_subscription_activations_currency_check
    CHECK (payment_currency = 'GHS'),
  CONSTRAINT billing_subscription_activations_exponent_check
    CHECK (payment_amount_exponent = 2),
  CONSTRAINT billing_subscription_activations_amount_check
    CHECK (payment_amount_minor > 0),
  CONSTRAINT billing_subscription_activations_provider_reference_check
    CHECK (char_length(provider_reference) BETWEEN 1 AND 190),
  CONSTRAINT billing_subscription_activations_provider_plan_id_check
    CHECK (provider_plan_id IS NULL OR char_length(provider_plan_id) BETWEEN 1 AND 128),
  CONSTRAINT billing_subscription_activations_evidence_hash_check
    CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_subscription_activations_idempotency_key_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_subscription_activations_operator_id_check
    CHECK (char_length(operator_id) BETWEEN 1 AND 128),
  CONSTRAINT billing_subscription_activations_reason_check
    CHECK (char_length(activation_reason) BETWEEN 1 AND 500),
  -- No credential-shaped material may ever be persisted as an activation.
  CONSTRAINT billing_subscription_activations_credential_shape_check
    CHECK (
      operator_id !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND activation_reason !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND provider_reference !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND coalesce(provider_plan_id, '') !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
    )
);

-- Exactly ONE activation fact per subscription: the paid entitlement of a
-- provider-backed row is a single, durable, replayable decision.
CREATE UNIQUE INDEX billing_subscription_activations_subscription_uniq
  ON billing_subscription_activations (subscription_id);

-- One evidence row activates at most one subscription.
CREATE UNIQUE INDEX billing_subscription_activations_evidence_uniq
  ON billing_subscription_activations (evidence_id);

-- Deterministic idempotency: a replayed activation collapses onto one row.
CREATE UNIQUE INDEX billing_subscription_activations_idempotency_uniq
  ON billing_subscription_activations (idempotency_key);

-- Tenant lookup: the activation facts of one user, newest first.
CREATE INDEX billing_subscription_activations_user_idx
  ON billing_subscription_activations (user_id, created_at DESC);
CREATE INDEX billing_subscription_activations_pricing_snapshot_idx
  ON billing_subscription_activations (pricing_snapshot_id);
CREATE INDEX billing_subscription_activations_created_at_idx
  ON billing_subscription_activations (created_at DESC);

COMMENT ON TABLE billing_subscription_activations IS
  'Billing Step 8: append-only, immutable ACTIVATION FACTS — one row per subscription, written only by the out-of-band operator CLI after verified payment evidence exists. The only authority the read side consults to grant a provider-backed subscription its paid entitlement. Never payment evidence, never a subscription state change, never an execution grant, never reachable from HTTP.';

COMMENT ON COLUMN billing_subscription_activations.subscription_id IS
  'The commercial subscription this fact activates. UNIQUE: a subscription is activated exactly once and a replay collapses onto the existing fact.';
COMMENT ON COLUMN billing_subscription_activations.pricing_snapshot_id IS
  'The immutable pricing snapshot the activated sale was locked to (0032). Copied into the fact so it never has to be re-derived.';
COMMENT ON COLUMN billing_subscription_activations.evidence_id IS
  'The durable verified-transaction evidence this activation rests on (0033). NOT NULL and UNIQUE: evidence is a prerequisite, never a substitute.';
COMMENT ON COLUMN billing_subscription_activations.catalogue_plan IS
  'Commercial plan activated (pro | elite). Starter is not sellable and is refused by CHECK and by the coherence trigger.';
COMMENT ON COLUMN billing_subscription_activations.provider_plan_id IS
  'The provider plan epoch the locked amount came from. Must equal the snapshot and the subscription; the excluded capability-evidence plan is refused.';
COMMENT ON COLUMN billing_subscription_activations.provider_reference IS
  'Our deterministic checkout reference (ve-chk-… hash of user + pricing identity) whose verified transaction authorized this activation.';
COMMENT ON COLUMN billing_subscription_activations.payment_amount_minor IS
  'The exact integer minor-unit amount that was verified (GHS pesewas). Must equal the locked snapshot and the evidence exactly; no float, no tolerance.';
COMMENT ON COLUMN billing_subscription_activations.evidence_hash IS
  'SHA-256 hex of the canonical verified facts, copied from the evidence row. The raw provider payload is never persisted.';
COMMENT ON COLUMN billing_subscription_activations.operator_id IS
  'Identity of the operator who authorized this activation, out of band. NOT NULL: an activation without a named operator is unrepresentable. Never a credential or token.';
COMMENT ON COLUMN billing_subscription_activations.activation_reason IS
  'The operator-stated reason for the activation. NOT NULL: an activation without a stated reason is unrepresentable. Never a credential or token.';
COMMENT ON COLUMN billing_subscription_activations.activated_at IS
  'Instant the operator authorized the activation. An instant, never derived from provider state.';
COMMENT ON COLUMN billing_subscription_activations.idempotency_key IS
  'Deterministic SHA-256 hex key for the activation identity (provider | reference | pricing snapshot). A replayed activation collapses onto the existing fact.';

-- ---------------------------------------------------------------------------
-- Append-only and immutable. An activation fact is recorded once; a
-- correction is a manual review, never a silent edit, and a fact is never
-- deleted — it is the audit trail of what an operator authorized.
-- ---------------------------------------------------------------------------

CREATE FUNCTION billing_subscription_activations_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_subscription_activations is append-only: an activation fact is immutable once recorded. '
             || 'A correction is a manual review, never a silent overwrite.';
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '27000',
    MESSAGE = 'billing_subscription_activations rows are never deleted: they are the audit trail of operator-authorized activations.';
END $$;

CREATE TRIGGER billing_subscription_activations_append_only
  BEFORE UPDATE OR DELETE ON billing_subscription_activations
  FOR EACH ROW EXECUTE FUNCTION billing_subscription_activations_append_only();

-- ---------------------------------------------------------------------------
-- Coherence. The database is the last line of defence: an activation fact
-- must agree, on every identity-bearing field, with the live subscription,
-- its immutable pricing snapshot and the verified payment evidence it
-- claims. Every disagreement is refused BEFORE the row exists.
-- ---------------------------------------------------------------------------

CREATE FUNCTION billing_subscription_activations_coherent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sub subscriptions%ROWTYPE;
  snap billing_pricing_snapshots%ROWTYPE;
  ev billing_verified_transactions%ROWTYPE;
BEGIN
  -- 1. The subscription must exist and belong to the stated user.
  SELECT * INTO sub FROM subscriptions WHERE id = NEW.subscription_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the subscription does not exist.';
  END IF;
  IF sub.user_id <> NEW.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the stated user does not own the subscription.';
  END IF;

  -- 2. The subscription must be provider-backed and locked to this snapshot.
  IF sub.provider IS NULL OR sub.provider <> NEW.provider THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the subscription is not provider-backed, so no payment can have been made against it.';
  END IF;
  IF sub.locked_pricing_snapshot_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the subscription has no locked pricing snapshot (a legacy NULL-lock row is never activatable).';
  END IF;
  IF sub.locked_pricing_snapshot_id <> NEW.pricing_snapshot_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the subscription is locked to a different pricing snapshot.';
  END IF;

  -- 3. The commercial identity must agree with the subscription row.
  IF sub.catalogue_plan <> NEW.catalogue_plan THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the catalogue plan disagrees with the subscription.';
  END IF;
  IF sub.billing_interval <> NEW.billing_interval THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the billing interval disagrees with the subscription.';
  END IF;
  IF sub.provider_plan_id IS DISTINCT FROM NEW.provider_plan_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the provider plan disagrees with the subscription.';
  END IF;

  -- 4. Starter is not a sellable plan, and the capability-evidence plan is
  --    never an activation target.
  IF NEW.catalogue_plan = 'starter' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: starter is not a sellable plan and cannot be activated.';
  END IF;
  -- The excluded plan code is ASSEMBLED from parts, exactly as the code that
  -- excludes it does: the repository pins that the capability-evidence plan
  -- code appears only in the documenting contract and never as a literal in
  -- code, tests or migrations (packages/core/test/billing-epoch-pricing.test.ts).
  IF NEW.provider_plan_id IS NOT NULL AND NEW.provider_plan_id = 'PLN_' || 'u0l4961hhipl6ek' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the excluded capability-evidence provider plan is never activatable.';
  END IF;

  -- 5. The immutable pricing snapshot must exist and match the fact exactly.
  SELECT * INTO snap FROM billing_pricing_snapshots WHERE id = NEW.pricing_snapshot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the pricing snapshot does not exist.';
  END IF;
  IF snap.catalogue_plan <> NEW.catalogue_plan
     OR snap.billing_interval <> NEW.billing_interval
     OR snap.payment_currency <> NEW.payment_currency
     OR snap.payment_amount_minor <> NEW.payment_amount_minor
     OR snap.payment_amount_exponent <> NEW.payment_amount_exponent
     OR snap.provider_plan_id IS DISTINCT FROM NEW.provider_plan_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the pricing snapshot disagrees with the activation facts.';
  END IF;

  -- 6. The verified payment evidence must exist, belong to the same billing
  --    context, be a successful SANDBOX Paystack transaction, and match the
  --    activated facts exactly.
  SELECT * INTO ev FROM billing_verified_transactions WHERE id = NEW.evidence_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence does not exist.';
  END IF;
  IF ev.user_id <> NEW.user_id
     OR ev.subscription_id <> NEW.subscription_id
     OR ev.pricing_snapshot_id <> NEW.pricing_snapshot_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence belongs to a different billing context.';
  END IF;
  IF ev.provider <> NEW.provider THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence was not reported by the same provider.';
  END IF;
  IF ev.provider_domain <> 'test' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence is not sandbox/test evidence.';
  END IF;
  IF ev.provider_status <> 'success' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence is not a successful transaction.';
  END IF;
  IF ev.provider_reference <> NEW.provider_reference THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence reference disagrees with the activation.';
  END IF;
  IF ev.payment_currency <> NEW.payment_currency
     OR ev.payment_amount_minor <> NEW.payment_amount_minor
     OR ev.payment_amount_exponent <> NEW.payment_amount_exponent THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence amount, currency or exponent disagrees with the activation.';
  END IF;
  IF ev.evidence_hash <> NEW.evidence_hash THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence hash disagrees with the activation.';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER billing_subscription_activations_coherent
  BEFORE INSERT ON billing_subscription_activations
  FOR EACH ROW EXECUTE FUNCTION billing_subscription_activations_coherent();

CREATE TRIGGER billing_subscription_activations_set_updated_at
  BEFORE UPDATE ON billing_subscription_activations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
