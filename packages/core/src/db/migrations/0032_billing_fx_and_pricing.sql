-- 0032: Billing PR3 — server-controlled USD→GHS pricing authority and
-- immutable GHS provider-plan epochs.
--
-- The commercial catalogue stays USD. A customer transacting in GHS pays the
-- GHS equivalent of the USD price, computed by the server from a versioned,
-- operator-published FX rate, and a recurring subscription's GHS amount is
-- LOCKED at creation. This migration adds the durable state those rules need —
-- and NOTHING else:
--
--   * `billing_fx_rate_versions`  — the FX authority. Append-only, immutable,
--     one row per published rate version. A rate is never fetched from a market
--     feed, never read from a browser, and never inferred: only what an
--     operator published here (or an explicitly imported/configured value
--     recorded here) can price a payment.
--   * `billing_provider_plans`    — immutable epochs mapping a (plan, interval)
--     to the exact GHS plan the provider will charge in, pinned to the FX and
--     pricing/catalogue versions it was derived from. One ACTIVE epoch per
--     (provider, mode, plan, interval, currency); retiring is one-way, and the
--     amounts of an existing epoch can never be edited.
--   * `billing_pricing_snapshots` — the immutable record of ONE pricing
--     decision: the USD catalogue amount, the GHS payable amount, the FX facts
--     used, the rounding mode and the deterministic idempotency key.
--   * `subscriptions.locked_pricing_snapshot_id` — the lock. Set when a
--     provider-backed subscription is created, immutable afterwards, so an
--     authorized recurring amount can never be silently repriced.
--
-- Design rules encoded in the schema (and nowhere relaxed):
--
--  * NO live activation. `billing_provider_plans.mode` is pinned to `test` and
--    `payment_currency` to `GHS`; nothing here enables a live charge, a
--    production credential or a checkout route. Enabling live mode is an
--    additive migration plus the operational work of a later PR, deliberately.
--  * NO second pricing authority. Amounts are never stored as free-form prices:
--    a snapshot is an AUDIT RECORD of a computed decision, and the catalogue
--    (PR1) plus the FX versions here remain the only inputs.
--  * NO provider vocabulary in the pricing path. The only provider reference in
--    this migration is the plan identifier a provider itself issued, kept as an
--    opaque string; there is no provider URL, header or status string.
--  * NO money arithmetic in SQL and no floating point anywhere. The one
--    half-up rounding step lives in `packages/core/src/billing/pricing.ts`
--    (integer/BigInt only) and is NOT re-implemented here — a second
--    implementation would be a drift hazard. The database enforces the facts it
--    can check on its own: positivity, scale ranges, currency coherence with the
--    referenced FX version, the documented provider minimum, and immutability.
--  * NO raw payloads, no credentials, no PII: FX versions carry an operator
--    label, never a key; credential-shaped text is refused outright.
--
-- Compatibility (hard requirement): `subscriptions.currency` and
-- `subscriptions_currency_check CHECK (currency = 'USD')` are UNTOUCHED — the
-- commercial currency stays USD. The single change to `subscriptions` is one
-- ADDITIVE nullable column (plus its foreign key and a scope guard that only
-- reads existing columns) and one immutability trigger. No column is renamed,
-- dropped, retyped or re-defaulted, no existing row is modified, and this
-- migration contains no UPDATE, no INSERT and no DELETE against existing data.
--
-- This migration is ADDITIVE and forward-only: CREATE TABLE / CREATE INDEX /
-- CREATE FUNCTION / CREATE TRIGGER / COMMENT, plus `ADD COLUMN IF NOT EXISTS`
-- and guarded `ADD CONSTRAINT`. Migrations 0001–0031 are byte-identical, no
-- object created earlier is redefined or replaced, and the `set_updated_at()`
-- helper from 0001 is reused, never redeclared.
--
-- Nothing in this migration enables execution. Automation, live execution and
-- broker execution stay OFF for every plan regardless of billing state.

-- ---------------------------------------------------------------------------
-- Pre-flight: this migration extends the PR2 billing model. Refuse to run
-- against a database where 0031 is not present, with a message that says
-- exactly what is missing, instead of failing halfway through.
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

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'subscriptions' AND column_name = 'currency') THEN
    missing := array_append(missing, 'subscriptions.currency');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'subscriptions' AND column_name = 'billing_interval') THEN
    missing := array_append(missing, 'subscriptions.billing_interval');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'subscriptions' AND column_name = 'catalogue_plan') THEN
    missing := array_append(missing, 'subscriptions.catalogue_plan');
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42704',
      MESSAGE = format(
        '0032 refused: the billing foundations it extends are missing (%s). '
        || 'Migration 0031 (provider billing) must be applied first; nothing was modified.',
        array_to_string(missing, ', ')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. `billing_fx_rate_versions` — the versioned FX authority.
--
-- One row = one published rate version for a currency pair, valid from
-- `effective_from`. `fx_rate_scaled` / `fx_rate_scale` express the rate as an
-- exact scaled integer (rate = fx_rate_scaled / 10^fx_rate_scale): e.g. 12.5
-- GHS per USD is stored as 12500000 @ scale 6. There is no float column, so no
-- payment can ever be priced from an inexact value.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_fx_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Currency pair. Pinned: the commercial catalogue is USD and the payment
  -- currency is GHS. A new pair is an additive migration, deliberately.
  base_currency text NOT NULL DEFAULT 'USD',
  quote_currency text NOT NULL DEFAULT 'GHS',

  -- The rate itself, exactly.
  fx_rate_scaled bigint NOT NULL,
  fx_rate_scale integer NOT NULL,
  rounding_mode text NOT NULL DEFAULT 'half_up',

  -- Provenance. `source` is the canonical vocabulary of WHERE the rate came
  -- from; `source_reference` is a short human label (a board/ticket reference),
  -- never a URL and never a credential.
  source text NOT NULL,
  source_reference text,
  created_by text,

  -- Validity and audit timestamps. A version becomes authoritative at
  -- `effective_from`; `captured_at` is when the rate was captured and
  -- `published_at` when it was published as authoritative. `captured_at` can
  -- never be later than `effective_from`, so a version cannot be back-dated and
  -- a past payment can never be repriced by a later insertion.
  effective_from timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_fx_rate_versions_currency_pair_check
    CHECK (base_currency = 'USD' AND quote_currency = 'GHS'),
  CONSTRAINT billing_fx_rate_versions_rate_check
    CHECK (fx_rate_scaled > 0 AND fx_rate_scale BETWEEN 1 AND 18),
  CONSTRAINT billing_fx_rate_versions_rounding_check
    CHECK (rounding_mode IN ('half_up')),
  CONSTRAINT billing_fx_rate_versions_source_check
    CHECK (source IN ('db', 'ops', 'import', 'config')),
  CONSTRAINT billing_fx_rate_versions_source_reference_check
    CHECK (source_reference IS NULL OR char_length(source_reference) BETWEEN 1 AND 190),
  CONSTRAINT billing_fx_rate_versions_created_by_check
    CHECK (created_by IS NULL OR char_length(created_by) BETWEEN 1 AND 190),
  CONSTRAINT billing_fx_rate_versions_captured_check
    CHECK (captured_at <= effective_from),
  CONSTRAINT billing_fx_rate_versions_published_check
    CHECK (published_at >= captured_at),
  -- No credential-shaped material may ever be recorded as a rate reference.
  CONSTRAINT billing_fx_rate_versions_reference_shape_check
    CHECK (
      coalesce(source_reference, '') !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
      AND coalesce(created_by, '') !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)'
    )
);

-- One published version per pair per instant. A tie is a contradiction, not a
-- choice: the resolver refuses to guess which of two rates was in force.
CREATE UNIQUE INDEX billing_fx_rate_versions_pair_effective_uniq
  ON billing_fx_rate_versions (base_currency, quote_currency, effective_from);

CREATE INDEX billing_fx_rate_versions_lookup_idx
  ON billing_fx_rate_versions (base_currency, quote_currency, effective_from DESC);

COMMENT ON TABLE billing_fx_rate_versions IS
  'Billing PR3: the append-only, immutable FX authority (USD->GHS). A payment is priced only from a version published here; rates are never fetched from a market feed or supplied by a client.';

COMMENT ON COLUMN billing_fx_rate_versions.fx_rate_scaled IS
  'Exact scaled rate. rate = fx_rate_scaled / 10^fx_rate_scale (e.g. 12500000 @ 6 = 12.5 GHS per USD). Integer only — there is no float column anywhere in the pricing path.';
COMMENT ON COLUMN billing_fx_rate_versions.source IS
  'Canonical provenance (db | ops | import | config). Provider-neutral: names the authority the version came from, never a provider status or payload.';
COMMENT ON COLUMN billing_fx_rate_versions.effective_from IS
  'Instant this version becomes authoritative. A version is immutable once inserted, so a published rate can never be edited or back-dated.';

-- Append-only: a published version is never edited and never deleted. A
-- correction is a NEW version with a later `effective_from`, so the history of
-- what was charged under what rate stays intact.
CREATE FUNCTION billing_fx_rate_versions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_fx_rate_versions is append-only: a published FX version is immutable. '
             || 'Publish a corrected version with a later effective_from instead.';
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '27000',
    MESSAGE = 'billing_fx_rate_versions is append-only: a published FX version is never deleted. '
           || 'Publish a superseding version instead.';
END $$;

CREATE TRIGGER billing_fx_rate_versions_append_only
  BEFORE UPDATE OR DELETE ON billing_fx_rate_versions
  FOR EACH ROW EXECUTE FUNCTION billing_fx_rate_versions_append_only();

-- ---------------------------------------------------------------------------
-- 2. `billing_provider_plans` — immutable GHS plan epochs.
--
-- A provider plan is created in the provider's own currency and can never be
-- repriced: changing an amount means a NEW local epoch plus a NEW provider plan,
-- with the previous epoch RETIRED. Historical subscribers keep the epoch they
-- were sold (see the subscription lock below), so nothing about an existing
-- customer's amount changes when the catalogue or the rate moves.
--
-- The provider identifier is opaque and required — charging is impossible
-- without it — and it is unique per provider so one provider plan can never be
-- mapped to two different local plans.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_provider_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  provider text NOT NULL DEFAULT 'paystack',
  -- Sandbox only, pinned. Enabling live mode is an additive migration in a
  -- later PR and never an edit of an existing epoch.
  mode text NOT NULL DEFAULT 'test',

  -- Plan identity. `starter` is deliberately absent: it has no internal plan
  -- value and no entitlement definition, so it cannot be persisted or sold.
  catalogue_plan text NOT NULL,
  billing_interval text NOT NULL,
  payment_currency text NOT NULL DEFAULT 'GHS',
  -- What the provider will actually charge, in the payment currency's minor
  -- units, and the amount is what the provider minimum allows: the documented
  -- minimum for GHS is 0.10 = 10 pesewas, so 10 is the floor here.
  payment_amount_minor bigint NOT NULL,
  payment_amount_exponent integer NOT NULL DEFAULT 2,

  -- The provider's own plan identifier, exactly as issued by the provider and
  -- used verbatim in charging operations. Opaque: never parsed, never derived.
  provider_plan_id text NOT NULL,
  provider_plan_reference text,

  -- The pricing provenance this epoch was derived from. A later rate change
  -- never rewrites these: it creates a new epoch.
  fx_rate_version_id uuid NOT NULL REFERENCES billing_fx_rate_versions (id),
  pricing_policy_version text NOT NULL,
  catalogue_version text NOT NULL,
  catalogue_amount_minor bigint NOT NULL,

  status text NOT NULL DEFAULT 'active',
  valid_from timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_provider_plans_provider_check
    CHECK (provider IN ('paystack')),
  CONSTRAINT billing_provider_plans_mode_check
    CHECK (mode IN ('test')),
  CONSTRAINT billing_provider_plans_catalogue_plan_check
    CHECK (catalogue_plan IN ('pro', 'elite')),
  CONSTRAINT billing_provider_plans_interval_check
    CHECK (billing_interval IN ('monthly', 'annual')),
  CONSTRAINT billing_provider_plans_currency_check
    CHECK (payment_currency = 'GHS'),
  CONSTRAINT billing_provider_plans_exponent_check
    CHECK (payment_amount_exponent = 2),
  CONSTRAINT billing_provider_plans_amount_check
    CHECK (payment_amount_minor >= 10 AND catalogue_amount_minor > 0),
  CONSTRAINT billing_provider_plans_provider_plan_id_check
    CHECK (char_length(provider_plan_id) BETWEEN 1 AND 128),
  CONSTRAINT billing_provider_plans_provider_plan_reference_check
    CHECK (provider_plan_reference IS NULL OR char_length(provider_plan_reference) BETWEEN 1 AND 190),
  CONSTRAINT billing_provider_plans_versions_check
    CHECK (
      char_length(pricing_policy_version) BETWEEN 1 AND 64
      AND char_length(catalogue_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT billing_provider_plans_status_check
    CHECK (status IN ('active', 'retired')),
  -- Lifecycle coherence: a retired epoch always carries a timestamp, and an
  -- active one never does.
  CONSTRAINT billing_provider_plans_retirement_check
    CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT billing_provider_plans_retired_reason_check
    CHECK (retired_reason IS NULL OR char_length(retired_reason) BETWEEN 1 AND 190),
  CONSTRAINT billing_provider_plans_provider_plan_id_shape_check
    CHECK (provider_plan_id !~* '(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)')
);

-- One epoch per provider plan identifier, per provider.
CREATE UNIQUE INDEX billing_provider_plans_provider_plan_uniq
  ON billing_provider_plans (provider, mode, provider_plan_id);

-- Exactly ONE active epoch per (provider, mode, plan, interval, currency): a
-- second one is a conflict, never "the newest row wins". Retired history is
-- unbounded on purpose — it is the audit trail of what was sold when.
CREATE UNIQUE INDEX billing_provider_plans_one_active_uniq
  ON billing_provider_plans (provider, mode, catalogue_plan, billing_interval, payment_currency)
  WHERE status = 'active';

CREATE INDEX billing_provider_plans_active_lookup_idx
  ON billing_provider_plans (provider, mode, catalogue_plan, billing_interval, payment_currency, status);

CREATE INDEX billing_provider_plans_fx_version_idx
  ON billing_provider_plans (fx_rate_version_id);

COMMENT ON TABLE billing_provider_plans IS
  'Billing PR3: immutable epochs mapping a commercial (plan, interval) to the exact sandbox GHS plan a provider charges in. Amounts are never edited: a change is a new epoch plus a new provider plan, with the previous epoch retired. Historical subscribers keep their locked amount.';

COMMENT ON COLUMN billing_provider_plans.payment_amount_minor IS
  'Recurring amount the provider charges, in GHS minor units (pesewas), pinned to the authorized amount. Immutable per epoch; >= 10 because the documented provider minimum for GHS is 0.10.';
COMMENT ON COLUMN billing_provider_plans.provider_plan_id IS
  'The identifier the provider itself issued for this plan, used verbatim in charging operations. Opaque: never derived, parsed or rewritten locally.';
COMMENT ON COLUMN billing_provider_plans.fx_rate_version_id IS
  'The FX version this GHS amount was derived from. A later rate change never rewrites an existing epoch — it creates a new one.';

-- Lifecycle: active -> retired only, once, and never back. A retired epoch
-- cannot be reactivated, and can never be deleted (it is the audit trail of what
-- was sold under which provider plan).
CREATE FUNCTION billing_provider_plans_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_provider_plans rows are never deleted: retire the epoch instead so the '
             || 'provider plan an existing subscriber was sold remains auditable.';
  END IF;

  IF OLD.status = 'retired' AND NEW.status = 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'A retired billing_provider_plans epoch can never be reactivated. Register a new epoch.';
  END IF;

  -- Only the lifecycle may move. Everything that defines WHAT is charged is
  -- immutable, so an existing subscriber's amount cannot be silently rewritten.
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.catalogue_plan IS DISTINCT FROM OLD.catalogue_plan
     OR NEW.billing_interval IS DISTINCT FROM OLD.billing_interval
     OR NEW.payment_currency IS DISTINCT FROM OLD.payment_currency
     OR NEW.payment_amount_minor IS DISTINCT FROM OLD.payment_amount_minor
     OR NEW.payment_amount_exponent IS DISTINCT FROM OLD.payment_amount_exponent
     OR NEW.provider_plan_id IS DISTINCT FROM OLD.provider_plan_id
     OR NEW.provider_plan_reference IS DISTINCT FROM OLD.provider_plan_reference
     OR NEW.fx_rate_version_id IS DISTINCT FROM OLD.fx_rate_version_id
     OR NEW.pricing_policy_version IS DISTINCT FROM OLD.pricing_policy_version
     OR NEW.catalogue_version IS DISTINCT FROM OLD.catalogue_version
     OR NEW.catalogue_amount_minor IS DISTINCT FROM OLD.catalogue_amount_minor
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_provider_plans epochs are immutable: the only permitted change is '
             || 'status active -> retired (with retired_at/retired_reason). '
             || 'A different amount or provider plan requires a NEW epoch.';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER billing_provider_plans_lifecycle
  BEFORE UPDATE OR DELETE ON billing_provider_plans
  FOR EACH ROW EXECUTE FUNCTION billing_provider_plans_lifecycle();

CREATE TRIGGER billing_provider_plans_set_updated_at
  BEFORE UPDATE ON billing_provider_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. `billing_pricing_snapshots` — the immutable record of one pricing decision.
--
-- Written when a payment or subscription is authorized and never changed: it is
-- the audit record of the USD amount, the GHS amount the customer is charged,
-- the FX facts used, the rounding mode and the policy/catalogue versions. The
-- deterministic `idempotency_key` makes a retried decision collapse onto one
-- row, so a retry can never produce a second, differently-priced charge.
--
-- The conversion itself is NOT re-implemented in SQL (one half-up step in
-- `pricing.ts` is the only implementation); the trigger below only enforces that
-- the FX facts recorded on a snapshot are exactly those of the version it
-- references.
-- ---------------------------------------------------------------------------

CREATE TABLE billing_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What was sold, in the commercial currency.
  commercial_currency text NOT NULL DEFAULT 'USD',
  commercial_amount_minor bigint NOT NULL,
  catalogue_plan text NOT NULL,
  billing_interval text NOT NULL,
  catalogue_version text NOT NULL,

  -- What will be charged, in the payment currency.
  payment_currency text NOT NULL DEFAULT 'GHS',
  payment_amount_minor bigint NOT NULL,
  payment_amount_exponent integer NOT NULL DEFAULT 2,

  -- The FX facts used, copied so the snapshot is self-contained even though the
  -- version row it references is immutable too.
  fx_rate_scaled bigint NOT NULL,
  fx_rate_scale integer NOT NULL,
  fx_rate_version_id uuid NOT NULL REFERENCES billing_fx_rate_versions (id),
  fx_rate_effective_from timestamptz NOT NULL,
  fx_rate_captured_at timestamptz NOT NULL,
  fx_rate_source text NOT NULL,
  rounding_mode text NOT NULL DEFAULT 'half_up',
  pricing_policy_version text NOT NULL,

  -- Provider traceability only: the provider plan this decision was bound to (if
  -- one existed) and OUR OWN reference for the checkout/subscription. No
  -- provider payload, no provider status string, no credential.
  provider text NOT NULL DEFAULT 'paystack',
  provider_plan_id text,
  provider_reference text,

  -- Deterministic local idempotency: the same pricing decision always hashes to
  -- the same key, and a second insert of that key is refused.
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_pricing_snapshots_commercial_currency_check
    CHECK (commercial_currency = 'USD'),
  CONSTRAINT billing_pricing_snapshots_commercial_amount_check
    CHECK (commercial_amount_minor > 0),
  -- `starter` cannot appear: it is not sellable, so no pricing decision for it
  -- can exist.
  CONSTRAINT billing_pricing_snapshots_catalogue_plan_check
    CHECK (catalogue_plan IN ('pro', 'elite')),
  CONSTRAINT billing_pricing_snapshots_interval_check
    CHECK (billing_interval IN ('monthly', 'annual')),
  CONSTRAINT billing_pricing_snapshots_payment_currency_check
    CHECK (payment_currency = 'GHS'),
  CONSTRAINT billing_pricing_snapshots_payment_amount_check
    CHECK (payment_amount_minor > 0 AND payment_amount_exponent = 2),
  CONSTRAINT billing_pricing_snapshots_fx_check
    CHECK (fx_rate_scaled > 0 AND fx_rate_scale BETWEEN 1 AND 18),
  CONSTRAINT billing_pricing_snapshots_rounding_check
    CHECK (rounding_mode IN ('half_up')),
  CONSTRAINT billing_pricing_snapshots_fx_source_check
    CHECK (fx_rate_source IN ('db', 'ops', 'import', 'config')),
  CONSTRAINT billing_pricing_snapshots_policy_check
    CHECK (
      char_length(pricing_policy_version) BETWEEN 1 AND 64
      AND char_length(catalogue_version) BETWEEN 1 AND 64
    ),
  CONSTRAINT billing_pricing_snapshots_provider_check
    CHECK (provider IN ('paystack')),
  CONSTRAINT billing_pricing_snapshots_provider_plan_id_check
    CHECK (provider_plan_id IS NULL OR char_length(provider_plan_id) BETWEEN 1 AND 128),
  CONSTRAINT billing_pricing_snapshots_provider_reference_check
    CHECK (provider_reference IS NULL OR char_length(provider_reference) BETWEEN 1 AND 190),
  CONSTRAINT billing_pricing_snapshots_idempotency_key_check
    CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT billing_pricing_snapshots_fx_order_check
    CHECK (fx_rate_captured_at <= fx_rate_effective_from)
);

CREATE UNIQUE INDEX billing_pricing_snapshots_idempotency_uniq
  ON billing_pricing_snapshots (idempotency_key);

CREATE INDEX billing_pricing_snapshots_fx_version_idx
  ON billing_pricing_snapshots (fx_rate_version_id);

CREATE INDEX billing_pricing_snapshots_provider_plan_idx
  ON billing_pricing_snapshots (provider, provider_plan_id);

COMMENT ON TABLE billing_pricing_snapshots IS
  'Billing PR3: append-only audit record of ONE pricing decision (USD amount -> GHS amount at a versioned rate). Immutable, never deleted, idempotent by deterministic local key. The conversion itself is implemented once, in packages/core/src/billing/pricing.ts.';

COMMENT ON COLUMN billing_pricing_snapshots.payment_amount_minor IS
  'The GHS amount the customer is charged, in pesewas, produced by exactly one half-up rounding step in the pricing boundary. For a subscription this is also the locked recurring amount.';
COMMENT ON COLUMN billing_pricing_snapshots.idempotency_key IS
  'sha256 of the canonical pricing decision (catalogue/plan/interval/USD amount/GHS amount/FX version/policy). A retry recomputes the same key; a second insert is impossible.';

-- Append-only, and never deleted: a snapshot is the record of what a customer
-- was actually quoted and charged.
CREATE FUNCTION billing_pricing_snapshots_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_pricing_snapshots is append-only: a pricing decision that was quoted or '
             || 'charged is never edited. Record a new decision instead.';
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '27000',
    MESSAGE = 'billing_pricing_snapshots rows are never deleted: they are the audit record of what '
           || 'a customer was quoted and charged.';
END $$;

CREATE TRIGGER billing_pricing_snapshots_append_only
  BEFORE UPDATE OR DELETE ON billing_pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION billing_pricing_snapshots_append_only();

-- FX coherence: the facts recorded on a snapshot must be exactly those of the
-- FX version it references. This keeps the audit record honest without
-- re-implementing the conversion.
CREATE FUNCTION billing_pricing_snapshots_fx_coherence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version billing_fx_rate_versions%ROWTYPE;
BEGIN
  SELECT * INTO version FROM billing_fx_rate_versions WHERE id = NEW.fx_rate_version_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'billing_pricing_snapshots.fx_rate_version_id references an unknown FX version.';
  END IF;

  IF version.base_currency IS DISTINCT FROM NEW.commercial_currency
     OR version.quote_currency IS DISTINCT FROM NEW.payment_currency
     OR version.fx_rate_scaled IS DISTINCT FROM NEW.fx_rate_scaled
     OR version.fx_rate_scale IS DISTINCT FROM NEW.fx_rate_scale
     OR version.rounding_mode IS DISTINCT FROM NEW.rounding_mode
     OR version.source IS DISTINCT FROM NEW.fx_rate_source
     OR version.effective_from IS DISTINCT FROM NEW.fx_rate_effective_from
     OR version.captured_at IS DISTINCT FROM NEW.fx_rate_captured_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'billing_pricing_snapshots must record exactly the FX version it references '
             || '(rate, scale, rounding, source, effective/captured timestamps and currencies). '
             || 'A snapshot that disagrees with its own FX version is refused.';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER billing_pricing_snapshots_fx_coherence
  BEFORE INSERT ON billing_pricing_snapshots
  FOR EACH ROW EXECUTE FUNCTION billing_pricing_snapshots_fx_coherence();

-- ---------------------------------------------------------------------------
-- 4. `subscriptions.locked_pricing_snapshot_id` — the lock (D-1).
--
-- One ADDITIVE nullable column. It is written when a provider-backed
-- subscription is created and is IMMUTABLE afterwards: the authorized recurring
-- GHS amount can never be silently repriced (or cleared) by a later rate,
-- catalogue or plan change. Refunds use the amount that was actually charged, so
-- they never re-rate either.
--
-- `subscriptions.currency` and its `CHECK (currency = 'USD')` are untouched: the
-- commercial currency stays USD, and the guard below only READS it.
-- ---------------------------------------------------------------------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS locked_pricing_snapshot_id uuid
    REFERENCES billing_pricing_snapshots (id);

DO $$
BEGIN
  -- A locked price only exists for a sold, provider-backed subscription in the
  -- single commercial currency. Unsold/free rows stay NULL.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_locked_pricing_scope_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_locked_pricing_scope_check
      CHECK (
        locked_pricing_snapshot_id IS NULL
        OR (
          provider IS NOT NULL
          AND catalogue_plan IS NOT NULL
          AND billing_interval IS NOT NULL
          AND currency = 'USD'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN subscriptions.locked_pricing_snapshot_id IS
  'Billing PR3: the pricing decision the subscription was sold under. Written at creation and immutable afterwards (trigger) — an authorized recurring GHS amount is never silently repriced. NULL for unsold/free rows.';

CREATE FUNCTION subscriptions_locked_pricing_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.locked_pricing_snapshot_id IS DISTINCT FROM OLD.locked_pricing_snapshot_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '27000',
      MESSAGE = 'subscriptions.locked_pricing_snapshot_id is immutable: the authorized recurring '
             || 'amount is locked at subscription creation and can never be repriced, re-rated or '
             || 'cleared. A price change applies to NEW subscriptions only.';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER subscriptions_locked_pricing_immutable
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION subscriptions_locked_pricing_immutable();
