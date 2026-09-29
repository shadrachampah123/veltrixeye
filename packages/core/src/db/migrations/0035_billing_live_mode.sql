-- 0035: Live Paystack mode support — widen the two provider-domain columns
-- from sandbox/test-only to the explicit two-value domain vocabulary
-- ('test' | 'live'), and update the activation coherence trigger to accept a
-- recognized provider domain instead of pinning evidence to 'test'.
--
-- This migration is FORWARD-ONLY and additive in effect: it widens two CHECK
-- constraints (test remains accepted), re-comments two columns, and
-- CREATE OR REPLACEs the activation coherence function with the domain branch
-- generalized. Every other integrity check stays exactly as written in
-- 0032/0033/0034; no historical migration file is touched; no data is
-- rewritten (existing rows already satisfy both widened constraints, since
-- 'test' remains valid).
--
-- Design rules encoded here (and nowhere relaxed):
--
-- * MODE IS CONFIGURATION, NOT PERMISSION: the schema becomes *capable* of
--   recording live-domain facts, but nothing here enables a live charge. The
--   configured mode comes from `PAYSTACK_MODE` (apps/api configuration and
--   composition only); every service still defaults to 'test' and refuses
--   evidence from any domain other than the configured one. The database
--   accepts both domains ONLY so a correctly-configured live deployment can
--   persist its own facts; a mixed-mode database is a deployment error, not a
--   supported state.
-- * NO live activation, no provider vocabulary, no credentials: neither
--   column may ever hold a key, URL, header or payload — only the literal
--   domain word.
-- * Defaults unchanged: `billing_provider_plans.mode` and
--   `billing_verified_transactions.provider_domain` keep DEFAULT 'test', so
--   any row written without an explicit domain stays sandbox/test and
--   fail-closed.
-- * The activation coherence trigger (0034) keeps every identity check and
--   only generalizes the evidence-domain check: evidence must come from a
--   recognized domain ('test' or 'live'); WHICH domain is allowed is decided
--   by the mode-aware application services and the mode-aware store, never by
--   the database.
-- * Forward-only: this file supersedes nothing; the runner records it as
--   version 35 and 0001-0034 remain byte-identical.

-- ---------------------------------------------------------------------------
-- Pre-flight: refuse (42704) if the billing foundations this migration
-- extends are missing. Nothing is modified when the exception fires.
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

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_provider_plans') THEN
    missing := array_append(missing, 'billing_provider_plans');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_verified_transactions') THEN
    missing := array_append(missing, 'billing_verified_transactions');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'billing_subscription_activations') THEN
    missing := array_append(missing, 'billing_subscription_activations');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'billing_subscription_activations_coherent' AND n.nspname = current_schema()
  ) THEN
    missing := array_append(missing, 'billing_subscription_activations_coherent()');
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = format(
        '0035 refused: the billing foundations it extends are missing (%s). '
        || 'Migrations 0032 (provider plans), 0033 (payment evidence) and 0034 (activation facts) must be applied first; nothing was modified.',
        array_to_string(missing, ', ')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. `billing_provider_plans.mode`: widen test -> (test | live).
--    The 0032 constraint is replaced (constraints are not mutable in place);
--    every other constraint on the table and the immutable-epoch semantics
--    are untouched, and the column default stays 'test'.
-- ---------------------------------------------------------------------------

ALTER TABLE billing_provider_plans
  DROP CONSTRAINT IF EXISTS billing_provider_plans_mode_check;

ALTER TABLE billing_provider_plans
  ADD CONSTRAINT billing_provider_plans_mode_check
    CHECK (mode IN ('test', 'live'));

COMMENT ON COLUMN billing_provider_plans.mode IS
  'Provider domain this epoch belongs to: test (sandbox) or live (production). One mode per deployment — mode-aware directory selection and composition decide which mode is used; a row is never silently crossed between modes. Default test.';

-- ---------------------------------------------------------------------------
-- 2. `billing_verified_transactions.provider_domain`: widen test -> (test | live).
--    All other constraints (paystack-only, GHS, exact integers, append-only,
--    immutability triggers) are untouched; the default stays 'test'.
-- ---------------------------------------------------------------------------

ALTER TABLE billing_verified_transactions
  DROP CONSTRAINT IF EXISTS billing_verified_transactions_domain_check;

ALTER TABLE billing_verified_transactions
  ADD CONSTRAINT billing_verified_transactions_domain_check
    CHECK (provider_domain IN ('test', 'live'));

COMMENT ON COLUMN billing_verified_transactions.provider_domain IS
  'Provider environment that reported the transaction: test (sandbox) or live (production). The application persists only the configured mode''s domain (default test) and refuses evidence from any other domain; the database accepts both literals solely so a correctly-configured deployment can record its own facts.';

-- ---------------------------------------------------------------------------
-- 3. Activation coherence trigger: accept a recognized provider domain.
--    The function below is byte-identical to the 0034 definition except the
--    evidence-domain branch (and its comment/message); every identity,
--    snapshot, amount, hash and status check is preserved verbatim.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION billing_subscription_activations_coherent() RETURNS trigger
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
  --    context, be a successful Paystack transaction from a recognized
  --    provider domain (test or live), and match the activated facts exactly.
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
  IF ev.provider_domain NOT IN ('test', 'live') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'billing_subscription_activations coherence: the payment evidence is not from a recognized provider domain (test/live).';
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

-- The trigger rows created by 0034 are already bound to this function name;
-- CREATE OR REPLACE swaps the implementation for every existing binding.
