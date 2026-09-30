-- 0036: NON-COMMERCIAL ENTITLEMENT GRANTS — the standing operator grant.
--
-- The activation ledger (0034) is deliberately unreachable for an account that
-- has no verified payment evidence, and verified evidence (0033) is produced
-- ONLY by a real provider read (`GET /transaction/verify/:reference`). So
-- there is, by design, no payment-free way to reach a PAID entitlement through
-- the payment path — which is correct, and is exactly why the owner/super-admin
-- benefit needs its OWN authority rather than a shortcut through the payment
-- one.
--
-- WHAT THIS TABLE IS
--  - a durable, append-only record that a NAMED OPERATOR, out of band, granted
--    one account a commercial entitlement tier (Pro -> `pro`, Elite ->
--    `premium`) WITHOUT a purchase, a provider plan, a checkout, a pricing
--    snapshot, a transaction or a provider call of any kind.
--  - a COMPLEMENT of the payment authority, never a substitute for it. The
--    read side consults it only through `resolveEntitlements(plan, status,
--    provider, activated, grantedPlan)` and it moves no subscription column.
--
-- WHAT THIS TABLE IS NOT — and every one of these is structural, not a
-- convention:
--  - NOT payment evidence. It has no `evidence_id`, no `pricing_snapshot_id`,
--    no `provider`, no `provider_reference`, no `provider_plan_id`, no
--    currency, no amount, no exponent, no transaction id and no
--    `payment_confirmed`. There is no column here that could hold a payment
--    fact, so a grant can never be read as, or turned into, evidence.
--  - NOT an activation. `billing_subscription_activations` (0034) stays the
--    ONLY payment-confirmation authority, and `paymentConfirmed` on
--    `GET /api/billing/me` stays derived from THAT table alone. A granted
--    account reports `paymentConfirmed: false` — forever — because nothing was
--    paid.
--  - NOT a subscription. It writes no `subscriptions` row and no
--    `subscriptions.plan`, and it references no subscription at all: a granted
--    account characteristically has NO subscription row (the Model C free
--    state), so a subscription-scoped fact could not represent it.
--  - NOT reachable from HTTP. There is no grant route, no admin role, no
--    operator endpoint and no grant token. The only writer is the out-of-band,
--    DB-connected CLI (`scripts/billing/grant-entitlements.ts`).
--  - NOT an execution grant. `canAccessAutomation` stays `false` for every
--    plan, granted or not; automation, live execution and broker execution
--    stay OFF. The grant carries the existing `getEntitlements()` tiers
--    verbatim and adds no capability of its own.
--
-- Design rules encoded here (and nowhere relaxed):
--
-- * ONE GRANT PER ACCOUNT. `user_id` is UNIQUE: an account's granted tier is a
--   single, durable decision, and a re-grant or a change of tier is a manual
--   review rather than a second competing row. This keeps the read side free
--   of any "highest wins" / "newest wins" rule.
-- * OPERATOR IDENTITY AND REASON ARE RECORDED, NEVER INFERRED. `operator_id`
--   and `grant_reason` are NOT NULL: a grant without a named operator and a
--   stated reason is unrepresentable. Neither is a credential, a token or a
--   secret, and credential-shaped text is refused by CHECK.
-- * SELLABLE COMMERCIAL TIERS ONLY. `plan` is CHECK-constrained to the two
--   internal values that HAVE an enforced entitlement tier (`pro`, `premium`).
--   Starter is refused here exactly as it is refused by checkout, pricing,
--   provisioning, activation and the portal: it is a catalogue concept with no
--   enforced tier, so granting it would be granting the free limits under a
--   paid name.
-- * IMMUTABLE + APPEND-ONLY. Every UPDATE and every DELETE is refused by
--   trigger. A correction is a manual review, never a silent overwrite, and a
--   grant is never deleted: it is the audit trail of what an operator decided.
-- * DETERMINISTIC IDEMPOTENCY. `idempotency_key` is the SHA-256 of a canonical
--   identity no client can supply, and is UNIQUE, so a replay collapses onto
--   the one existing row.
-- * NO PAYLOAD, NO SECRET, NO CARD MATERIAL, NO PROVIDER COLUMN. Only the
--   account, the granted tier, the operator, the reason and the instant are
--   stored — there is nothing else to store.
--
-- Compatibility: this migration is ADDITIVE and forward-only. It creates one
-- table, its indexes, triggers and comments, and touches no existing table,
-- column, index or trigger. Migrations 0001–0035 are byte-identical, no object
-- created earlier is redefined, and the `set_updated_at()` helper from 0001 is
-- reused, never redeclared. No data is rewritten.
--
-- Nothing here touches Paystack, a live plan registration, a checkout, an
-- entitlement matrix or an execution gate.

-- ---------------------------------------------------------------------------
-- Pre-flight: refuse (42704) if the identity foundation this ledger extends is
-- missing, so the migration can never fail halfway through.
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

  -- The grant is ACCOUNT-scoped and deliberately independent of billing, so
  -- the only foundation it actually requires is identity. The billing tables
  -- are listed as a coherence check on the deployment, not a dependency: a
  -- grant must be representable even on an account that never checked out.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscriptions') THEN
    missing := array_append(missing, 'subscriptions');
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = format(
        '0036 refused: the foundations it extends are missing (%s). '
        || 'Migrations 0001 (identity) and 0014 (subscriptions) must be applied first; nothing was modified.',
        array_to_string(missing, ', ')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. `billing_entitlement_grants` — the immutable non-commercial grant fact.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_entitlement_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The account the grant was issued to. A granted account characteristically
  -- has NO `subscriptions` row (that absence IS the free state since Model C),
  -- which is why this fact is account-scoped and references no subscription.
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The INTERNAL plan value whose enforced tier is granted (`pro` | `premium`),
  -- i.e. the commercial Pro / Elite benefit set. Starter is not persistable:
  -- it has no enforced entitlement tier, so a "Starter grant" would hand out
  -- the free limits under a paid name.
  plan text NOT NULL,

  -- What KIND of grant this is. Today exactly one kind exists — `owner`, the
  -- platform/super-admin account that receives the commercial benefit without a
  -- purchase. The vocabulary is closed so a later kind is a deliberate,
  -- reviewed migration rather than a free-text label.
  grant_kind text NOT NULL DEFAULT 'owner',

  -- WHO granted this, out of band, and WHY. Never inferred, never a session
  -- identity, never a credential, a token or a secret.
  operator_id text NOT NULL,
  grant_reason text NOT NULL,

  -- The instant the operator authorized the grant. An instant, never derived
  -- from provider state, a session or a clock reading.
  granted_at timestamptz NOT NULL DEFAULT now(),

  -- Deterministic idempotency key (SHA-256 hex of the canonical grant
  -- identity). Collapses a replayed grant onto the one existing row.
  idempotency_key text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- -----------------------------------------------------------------------
  -- Strict constraints. Note what is ABSENT: there is no provider column, no
  -- reference, no currency, no amount, no exponent, no evidence id and no
  -- payment flag, so this table is structurally incapable of representing a
  -- payment fact.
  -- -----------------------------------------------------------------------

  -- The two internal values that have an enforced entitlement tier. `free` is
  -- refused (a grant of the free tier is a no-op) and `starter` has no
  -- internal value at all.
  CONSTRAINT billing_entitlement_grants_plan_check
    CHECK (plan IN ('pro', 'premium')),

  -- Closed vocabulary; see the column comment.
  CONSTRAINT billing_entitlement_grants_kind_check
    CHECK (grant_kind = 'owner'),

  CONSTRAINT billing_entitlement_grants_operator_id_check
    CHECK (char_length(operator_id) BETWEEN 1 AND 128),
  CONSTRAINT billing_entitlement_grants_reason_check
    CHECK (char_length(grant_reason) BETWEEN 1 AND 500),
  CONSTRAINT billing_entitlement_grants_idempotency_key_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),

  -- No credential-shaped material may ever be persisted as a grant.
  CONSTRAINT billing_entitlement_grants_credential_shape_check
    CHECK (
      operator_id !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND grant_reason !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
    ),

  -- A grant is a statement about a live account, never about a deleted one.
  -- (The FK already cascades with the account; this pins the vocabulary of
  -- that intent so a future edit cannot quietly soften it.)
  CONSTRAINT billing_entitlement_grants_account_check
    CHECK (user_id IS NOT NULL)
);

-- Exactly ONE grant per account: the granted tier is a single, durable
-- decision, and a re-grant or a tier change is a manual review — never a
-- second competing row the read side would have to rank.
CREATE UNIQUE INDEX billing_entitlement_grants_user_uniq
  ON billing_entitlement_grants (user_id);

-- Deterministic idempotency: a replayed grant collapses onto one row.
CREATE UNIQUE INDEX billing_entitlement_grants_idempotency_uniq
  ON billing_entitlement_grants (idempotency_key);

-- The read side's lookup path (`… WHERE g.user_id = <account>`), and the audit
-- trail's time ordering.
CREATE INDEX billing_entitlement_grants_created_at_idx
  ON billing_entitlement_grants (created_at DESC);

COMMENT ON TABLE billing_entitlement_grants IS
  'Non-commercial, append-only OPERATOR GRANTS — one row per account, written only by the out-of-band `npm run billing:grant` CLI. A standing, named-operator authorization of a commercial entitlement tier for an account that made no purchase. NOT payment evidence, NOT an activation, NOT a subscription, NOT a payment confirmation, NOT an execution grant, and never reachable from HTTP. Structurally carries no provider, reference, currency, amount, transaction or evidence column, so it can never be read as a payment.';

COMMENT ON COLUMN billing_entitlement_grants.user_id IS
  'The account the grant was issued to. UNIQUE: exactly one grant per account, so the read side never has to rank competing grants. A granted account typically has no `subscriptions` row at all — which is why this fact is account-scoped.';

COMMENT ON COLUMN billing_entitlement_grants.plan IS
  'The INTERNAL plan value whose enforced tier is granted: pro (commercial Pro) or premium (commercial Elite). CHECK-constrained, so Starter — a catalogue concept with no enforced tier — is never persistable, exactly as on every other entitlement path.';

COMMENT ON COLUMN billing_entitlement_grants.grant_kind IS
  'Closed vocabulary of grant kinds. Today exactly one exists: owner (the designated owner/super-admin account that receives the commercial benefit without a purchase). A new kind requires a deliberate migration.';

COMMENT ON COLUMN billing_entitlement_grants.operator_id IS
  'Identity of the operator who issued this grant, out of band. NOT NULL: a grant without a named operator is unrepresentable. Never a credential, a token, a session identity or a secret.';

COMMENT ON COLUMN billing_entitlement_grants.grant_reason IS
  'The operator-stated reason for the grant. NOT NULL: a grant without a stated reason is unrepresentable. Never a credential or a token.';

COMMENT ON COLUMN billing_entitlement_grants.granted_at IS
  'Instant the operator authorized the grant. An instant, never derived from provider state, a session or a payment.';

COMMENT ON COLUMN billing_entitlement_grants.idempotency_key IS
  'Deterministic SHA-256 hex key for the canonical grant identity (grant kind | account | tier). A replayed grant collapses onto the existing fact.';

-- ---------------------------------------------------------------------------
-- Append-only and immutable. A grant is recorded once; a correction is a
-- manual review, never a silent edit, and a grant is never deleted — it is the
-- audit trail of what an operator decided. This is deliberately identical to
-- the 0034 activation posture: a wrong fact is reviewed, not rewritten.
-- ---------------------------------------------------------------------------

CREATE FUNCTION billing_entitlement_grants_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_entitlement_grants is append-only: a grant is immutable once recorded. '
             || 'A correction is a manual review, never a silent overwrite.';
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '27000',
    MESSAGE = 'billing_entitlement_grants rows are never deleted: they are the audit trail of operator-authorized grants.';
END $$;

CREATE TRIGGER billing_entitlement_grants_append_only
  BEFORE UPDATE OR DELETE ON billing_entitlement_grants
  FOR EACH ROW EXECUTE FUNCTION billing_entitlement_grants_append_only();
