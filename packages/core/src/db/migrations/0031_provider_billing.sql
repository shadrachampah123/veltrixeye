-- 0031: Billing PR2 — provider-backed billing persistence (Paystack-ready).
--
-- Adds ONLY the durable state a payment-provider integration needs, so that a
-- later billing PR can persist provider-backed subscriptions without another
-- schema change. NOTHING in this migration contacts a provider: no HTTP call,
-- no checkout, no portal, no webhook receiver, no signature verification, no
-- subscription synchronization worker, no credential and no route. Every
-- column added here stays NULL / at its default until a later billing PR
-- writes to it.
--
-- Design rules encoded in the schema:
--
--  * `subscriptions` (0014) remains the ONE authoritative subscription row per
--    user and the ONLY source entitlements are resolved from — `plan` +
--    `status`, resolved by `packages/core/src/billing/entitlements.ts`. This
--    migration ADDS provider/catalogue columns to that row; it creates no
--    second subscription table, no second plan vocabulary and no second
--    entitlement system, renames no column and drops no constraint.
--  * Provider state is stored SEPARATELY from authoritative state:
--    `provider_state` is what the provider last reported (canonical
--    vocabulary, never a provider-specific string), `status` stays what the
--    platform enforces. A later synchronization PR maps one onto the other;
--    the mapping can never widen an entitlement, because entitlements read
--    `plan`/`status` only.
--  * `billing_customers` holds provider customer identity, one row per
--    (provider, user), with the provider's own identifiers kept unique per
--    provider so two users can never share one provider customer.
--  * `billing_provider_events` is an append-only provider-event ledger. Its
--    UNIQUE `idempotency_key` (and the partial UNIQUE on the provider's own
--    event id) make a replayed, retried or duplicated provider event collapse
--    onto one row; identity columns are immutable by trigger and an
--    unprocessed event cannot be deleted. Raw provider payloads are NEVER
--    stored — only a SHA-256 payload hash and normalized identity fields, the
--    same redaction posture as the Gate 9 receipt ledger (0029).
--
-- Compatibility with the existing plan vocabulary (hard requirement):
--
--  * `users.plan` (0001) and `subscriptions.plan` (0014) keep exactly
--    `free | pro | premium`. No value is renamed, removed or rewritten, and no
--    existing row is touched: this migration contains no UPDATE, no INSERT and
--    no DELETE.
--  * The COMMERCIAL catalogue vocabulary (`starter | pro | elite`, see
--    `packages/contracts/src/billing-catalogue.ts`) is persisted in a separate
--    nullable column `subscriptions.catalogue_plan`, CHECK-constrained to the
--    canonical compatibility mapping (`pro` → `pro`, `premium` → `elite`,
--    `free` → none). `catalogue_plan` is therefore NULL for every existing row
--    and stays NULL for anything that was not sold through a provider.
--  * Consequence, deliberately: **Starter still cannot be persisted or sold.**
--    Selling it needs (a) a new internal plan value in 0001/0014's CHECKs,
--    (b) an entitlement definition for it in `entitlements.ts`, and (c) a
--    widening of `subscriptions_catalogue_plan_mapping_check` below. All three
--    are entitlement changes and belong to a later billing PR — not here.
--
-- This migration is ADDITIVE and forward-only: CREATE TABLE / CREATE INDEX /
-- CREATE FUNCTION / CREATE TRIGGER / COMMENT, plus `ADD COLUMN IF NOT EXISTS`
-- and guarded `ADD CONSTRAINT`. Migrations 0001–0030 are byte-identical, no
-- object created earlier is redefined or replaced, and the `set_updated_at()`
-- helper from 0001 is reused, never redeclared.
--
-- Nothing in this migration enables execution. Automation, live execution and
-- broker execution stay OFF for every plan; no execution table, gate, trigger
-- or column is touched, and Elite's "priority execution" remains a commercial
-- catalogue descriptor only.

-- ---------------------------------------------------------------------------
-- 0. Pre-flight: refuse (never repair) if existing rows would violate a new
--    constraint. The provider columns from 0014 have no writer yet, so both
--    counts are expected to be zero; if they are not, an operator must resolve
--    the conflict before this migration can apply. Nothing is rewritten here.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  duplicate_provider_subscriptions integer;
  unknown_providers                integer;
BEGIN
  SELECT count(*) INTO duplicate_provider_subscriptions FROM (
    SELECT provider, provider_subscription_id
      FROM subscriptions
     WHERE provider_subscription_id IS NOT NULL
     GROUP BY provider, provider_subscription_id
    HAVING count(*) > 1
  ) AS d;

  SELECT count(*) INTO unknown_providers
    FROM subscriptions
   WHERE provider IS NOT NULL
     AND provider NOT IN ('paystack');

  IF duplicate_provider_subscriptions > 0 OR unknown_providers > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        '0031 refused: existing subscriptions rows conflict with the billing constraints '
        || '(%s provider subscription identifier(s) shared by more than one row, '
        || '%s row(s) carrying a provider other than paystack). No data was modified; '
        || 'review and resolve the conflicting rows before re-running this migration.',
        duplicate_provider_subscriptions, unknown_providers
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Provider customer identity — one row per (provider, user).
-- ---------------------------------------------------------------------------
CREATE TABLE billing_customers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Billing provider. Only 'paystack' exists; a second provider is an additive
  -- enum change plus a new adapter behind the seam.
  provider               text NOT NULL DEFAULT 'paystack',
  -- The provider's own customer identifiers (reference identifiers only —
  -- never a credential, token, card or bank detail).
  provider_customer_id   text,
  provider_customer_code text,
  -- Normalized (lowercase) account email presented to the provider.
  email                  text NOT NULL,
  status                 text NOT NULL DEFAULT 'unprovisioned',
  -- Most recent provider reference associated with this customer
  -- (transaction/checkout reference), for traceability only.
  last_reference         text,
  provisioned_at         timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (provider IN ('paystack')),
  CHECK (status IN ('unprovisioned', 'provisioned', 'suspended', 'unavailable')),
  CHECK (email = lower(email)),
  CHECK (char_length(email) BETWEEN 3 AND 254),
  CHECK (provider_customer_id IS NULL OR char_length(provider_customer_id) BETWEEN 1 AND 128),
  CHECK (provider_customer_code IS NULL OR char_length(provider_customer_code) BETWEEN 1 AND 128),
  CHECK (last_reference IS NULL OR char_length(last_reference) BETWEEN 1 AND 190),
  -- Coherence: a provisioned customer carries at least one provider identifier,
  -- and `provisioned_at` is only ever set once the customer exists upstream.
  CHECK (status <> 'provisioned' OR provider_customer_id IS NOT NULL OR provider_customer_code IS NOT NULL),
  CHECK (provisioned_at IS NULL OR status <> 'unprovisioned')
);

-- One provider customer per user, and no provider identifier shared by two users.
CREATE UNIQUE INDEX billing_customers_provider_user_uniq
  ON billing_customers (provider, user_id);
CREATE UNIQUE INDEX billing_customers_provider_customer_id_uniq
  ON billing_customers (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;
CREATE UNIQUE INDEX billing_customers_provider_customer_code_uniq
  ON billing_customers (provider, provider_customer_code)
  WHERE provider_customer_code IS NOT NULL;
CREATE INDEX billing_customers_user_idx ON billing_customers (user_id);

CREATE TRIGGER billing_customers_set_updated_at
BEFORE UPDATE ON billing_customers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. `subscriptions`: additive provider/catalogue columns on the EXISTING
--    authoritative row. Existing columns, defaults and constraints (0014) are
--    untouched; every new column is nullable or carries a safe default, so all
--    existing rows stay valid and unchanged.
-- ---------------------------------------------------------------------------
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS catalogue_plan text,
  ADD COLUMN IF NOT EXISTS billing_interval text,
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS catalogue_version text,
  ADD COLUMN IF NOT EXISTS billing_customer_id uuid REFERENCES billing_customers (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_plan_id text,
  ADD COLUMN IF NOT EXISTS provider_subscription_code text,
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS provider_state text,
  ADD COLUMN IF NOT EXISTS cancel_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS sync_state text NOT NULL DEFAULT 'never_synced',
  ADD COLUMN IF NOT EXISTS last_sync_source text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_event_idempotency_key text,
  ADD COLUMN IF NOT EXISTS state_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  -- Commercial catalogue vocabulary (what is sold), kept separate from `plan`
  -- (what is enforced).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_catalogue_plan_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_catalogue_plan_check
      CHECK (catalogue_plan IS NULL OR catalogue_plan IN ('starter', 'pro', 'elite'));
  END IF;

  -- The canonical compatibility mapping, enforced by the database:
  --   internal `pro`     ⇄ catalogue `pro`
  --   internal `premium` ⇄ catalogue `elite`
  --   internal `free`    → no catalogue plan
  -- `starter` is therefore NOT persistable until a later migration introduces
  -- its internal plan value AND its entitlement definition (see header).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_catalogue_plan_mapping_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_catalogue_plan_mapping_check
      CHECK (
        catalogue_plan IS NULL
        OR (plan = 'pro' AND catalogue_plan = 'pro')
        OR (plan = 'premium' AND catalogue_plan = 'elite')
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_billing_interval_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_billing_interval_check
      CHECK (billing_interval IS NULL OR billing_interval IN ('monthly', 'annual'));
  END IF;

  -- An interval only exists for a sold (catalogue) plan.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_billing_interval_scope_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_billing_interval_scope_check
      CHECK (billing_interval IS NULL OR catalogue_plan IS NOT NULL);
  END IF;

  -- Single commercial currency (the catalogue is USD-only).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_currency_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_currency_check
      CHECK (currency = 'USD');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_catalogue_version_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_catalogue_version_check
      CHECK (catalogue_version IS NULL OR char_length(catalogue_version) BETWEEN 1 AND 64);
  END IF;

  -- Canonical provider-reported lifecycle state. Provider-specific strings
  -- (e.g. a vendor's own status word) are normalized BEFORE they are stored,
  -- so this vocabulary is the only one that ever reaches the database.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_provider_state_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_provider_state_check
      CHECK (provider_state IS NULL OR provider_state IN (
        'unprovisioned', 'pending', 'active', 'trialing', 'past_due',
        'cancelled', 'unsubscribed', 'expired', 'unknown'
      ));
  END IF;

  -- Provider vocabulary. `subscriptions.provider` (0014) was unconstrained
  -- text; every existing row is NULL, so pinning it to the providers that
  -- exist is additive and rewrites nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_provider_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_provider_check
      CHECK (provider IS NULL OR provider IN ('paystack'));
  END IF;

  -- Provider state and provider identifiers require a provider.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_provider_binding_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_provider_binding_check
      CHECK (
        provider IS NOT NULL
        OR (
          provider_state IS NULL
          AND provider_customer_id IS NULL
          AND provider_subscription_id IS NULL
          AND provider_subscription_code IS NULL
          AND provider_plan_id IS NULL
          AND provider_reference IS NULL
          AND billing_customer_id IS NULL
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_provider_refs_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_provider_refs_check
      CHECK (
        (provider_customer_id IS NULL OR char_length(provider_customer_id) BETWEEN 1 AND 128)
        AND (provider_subscription_id IS NULL OR char_length(provider_subscription_id) BETWEEN 1 AND 128)
        AND (provider_subscription_code IS NULL OR char_length(provider_subscription_code) BETWEEN 1 AND 128)
        AND (provider_plan_id IS NULL OR char_length(provider_plan_id) BETWEEN 1 AND 128)
        AND (provider_reference IS NULL OR char_length(provider_reference) BETWEEN 1 AND 190)
      );
  END IF;

  -- Period coherence (both are NULL on every pre-0031 row).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_period_order_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_period_order_check
      CHECK (
        current_period_start IS NULL
        OR current_period_end IS NULL
        OR current_period_start < current_period_end
      );
  END IF;

  -- Cancellation coherence: an effective cancellation timestamp belongs to a
  -- subscription that is cancelled/expired or flagged to cancel at period end.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_cancellation_coherence_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_cancellation_coherence_check
      CHECK (
        cancelled_at IS NULL
        OR cancel_at_period_end = true
        OR status IN ('canceled', 'expired')
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_cancellation_reason_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_cancellation_reason_check
      CHECK (cancellation_reason IS NULL OR cancellation_reason IN (
        'user', 'provider', 'payment_failure', 'expired', 'fraud', 'other'
      ));
  END IF;

  -- Synchronization bookkeeping (written by a later PR; defaults are inert).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_sync_state_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_sync_state_check
      CHECK (sync_state IN ('never_synced', 'pending', 'synced', 'conflict'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_last_sync_source_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_last_sync_source_check
      CHECK (last_sync_source IN ('none', 'webhook', 'verification', 'reconciliation', 'manual'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_sync_coherence_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_sync_coherence_check
      CHECK (last_synced_at IS NULL OR (sync_state <> 'never_synced' AND last_sync_source <> 'none'));
  END IF;

  -- Durable link to the provider-event ledger (idempotency).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_last_event_idempotency_key_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_last_event_idempotency_key_check
      CHECK (last_event_idempotency_key IS NULL OR last_event_idempotency_key ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_state_version_check') THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_state_version_check
      CHECK (state_version >= 1);
  END IF;
END $$;

-- Composite uniqueness so the provider-event ledger can bind an event to a
-- subscription AND its owner in one foreign key (the 0025 tenant-integrity
-- pattern).
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_id_user_uniq ON subscriptions (id, user_id);

-- A provider subscription identifier belongs to exactly one user.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_subscription_uniq
  ON subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_subscription_code_uniq
  ON subscriptions (provider, provider_subscription_code)
  WHERE provider_subscription_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscriptions_billing_customer_idx
  ON subscriptions (billing_customer_id)
  WHERE billing_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_catalogue_plan_idx
  ON subscriptions (catalogue_plan)
  WHERE catalogue_plan IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_provider_state_idx
  ON subscriptions (provider, provider_state)
  WHERE provider IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscriptions_current_period_end_idx
  ON subscriptions (current_period_end)
  WHERE current_period_end IS NOT NULL;
-- Prepared for a later synchronization PR: rows awaiting a provider sync,
-- oldest first. Nothing reads this index in PR2 (no worker exists).
CREATE INDEX IF NOT EXISTS subscriptions_sync_required_idx
  ON subscriptions (last_synced_at ASC NULLS FIRST, updated_at ASC)
  WHERE sync_required;

-- ---------------------------------------------------------------------------
-- 3. Append-only provider-event ledger (idempotency + audit).
-- ---------------------------------------------------------------------------
CREATE TABLE billing_provider_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 text NOT NULL DEFAULT 'paystack',
  -- NORMALIZED event type (canonical vocabulary). A provider's own event name
  -- is mapped onto this vocabulary behind the seam before it is persisted; an
  -- event that cannot be mapped is stored as `unrecognized`, never guessed.
  event_type               text NOT NULL,
  -- The provider's own event identifier, when it sends one.
  provider_event_id        text,
  -- sha256(provider|provider_event_id|event_type|occurred_at|payload_hash).
  -- UNIQUE: a replayed or duplicated delivery collapses onto one row.
  idempotency_key          text NOT NULL,
  -- sha256 of the received payload. The payload itself is NEVER stored.
  payload_hash             text NOT NULL,
  -- Subject of the event, when it could be resolved to a local row. Both are
  -- set or both are NULL; the composite FK binds the event to its owner.
  subscription_id          uuid,
  user_id                  uuid,
  -- Provider references carried by the event (traceability / resolution).
  provider_customer_id     text,
  provider_subscription_id text,
  provider_reference       text,
  status                   text NOT NULL DEFAULT 'received',
  failure_reason           text,
  occurred_at              timestamptz,
  received_at              timestamptz NOT NULL DEFAULT now(),
  processed_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subscription_id, user_id)
    REFERENCES subscriptions (id, user_id) ON DELETE CASCADE,
  CHECK (provider IN ('paystack')),
  CHECK (event_type IN (
    'customer.created', 'customer.updated',
    'payment.succeeded', 'payment.failed', 'payment.pending',
    'subscription.created', 'subscription.updated', 'subscription.activated',
    'subscription.renewed', 'subscription.not_renewing',
    'subscription.cancelled', 'subscription.expired',
    'invoice.processed', 'invoice.failed',
    'unrecognized'
  )),
  CHECK (status IN ('received', 'ignored', 'processed', 'failed')),
  CHECK (char_length(idempotency_key) = 64),
  CHECK (char_length(payload_hash) = 64),
  CHECK (provider_event_id IS NULL OR char_length(provider_event_id) BETWEEN 1 AND 190),
  CHECK (provider_customer_id IS NULL OR char_length(provider_customer_id) BETWEEN 1 AND 128),
  CHECK (provider_subscription_id IS NULL OR char_length(provider_subscription_id) BETWEEN 1 AND 128),
  CHECK (provider_reference IS NULL OR char_length(provider_reference) BETWEEN 1 AND 190),
  CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 600),
  CHECK ((subscription_id IS NULL) = (user_id IS NULL)),
  -- No secret is storable: a failure reason must not carry a credential-shaped
  -- key/value. Mirrors the Gate 9 posture that secrets are rejected, not
  -- redacted after the fact.
  CHECK (failure_reason IS NULL OR failure_reason !~* '(password|passwd|token|secret|api[_-]?key|authorization|private[_-]?key|credential|bearer)'),
  CHECK (processed_at IS NULL OR status IN ('processed', 'ignored', 'failed')),
  CHECK (status <> 'processed' OR processed_at IS NOT NULL)
);

-- Idempotency: one row per derived key, and one row per provider event id.
CREATE UNIQUE INDEX billing_provider_events_idempotency_uniq
  ON billing_provider_events (idempotency_key);
CREATE UNIQUE INDEX billing_provider_events_provider_event_uniq
  ON billing_provider_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX billing_provider_events_subscription_idx
  ON billing_provider_events (subscription_id, received_at DESC)
  WHERE subscription_id IS NOT NULL;
CREATE INDEX billing_provider_events_user_idx
  ON billing_provider_events (user_id, received_at DESC)
  WHERE user_id IS NOT NULL;
-- Unprocessed events, oldest first (a later PR's receiver/worker).
CREATE INDEX billing_provider_events_unprocessed_idx
  ON billing_provider_events (received_at ASC, created_at ASC)
  WHERE status = 'received';
CREATE INDEX billing_provider_events_type_idx
  ON billing_provider_events (event_type, received_at DESC);

-- Identity immutability: an event's provider identity, type, hashes, subject
-- and timing are the audit record. Only processing state may move.
CREATE FUNCTION billing_provider_events_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.provider IS DISTINCT FROM OLD.provider)
     OR (NEW.event_type IS DISTINCT FROM OLD.event_type)
     OR (NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id)
     OR (NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key)
     OR (NEW.payload_hash IS DISTINCT FROM OLD.payload_hash)
     OR (NEW.subscription_id IS DISTINCT FROM OLD.subscription_id)
     OR (NEW.user_id IS DISTINCT FROM OLD.user_id)
     OR (NEW.provider_customer_id IS DISTINCT FROM OLD.provider_customer_id)
     OR (NEW.provider_subscription_id IS DISTINCT FROM OLD.provider_subscription_id)
     OR (NEW.provider_reference IS DISTINCT FROM OLD.provider_reference)
     OR (NEW.occurred_at IS DISTINCT FROM OLD.occurred_at)
     OR (NEW.received_at IS DISTINCT FROM OLD.received_at) THEN
    RAISE EXCEPTION
      'billing_provider_events is append-only: provider event identity cannot change'
      USING ERRCODE = '27000';
  END IF;
  RETURN NEW;
END;
$$;

-- Retention: an event that has not been processed yet cannot be deleted, so a
-- crash, a cleanup job or a retry loop can never erase evidence of an
-- unapplied provider event.
CREATE FUNCTION billing_provider_events_unprocessed_retention()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'received' THEN
    RAISE EXCEPTION
      'billing_provider_events retention: an unprocessed provider event cannot be deleted'
      USING ERRCODE = '27000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER billing_provider_events_identity_immutable_trg
BEFORE UPDATE ON billing_provider_events
FOR EACH ROW EXECUTE FUNCTION billing_provider_events_identity_immutable();

CREATE TRIGGER billing_provider_events_unprocessed_retention_trg
BEFORE DELETE ON billing_provider_events
FOR EACH ROW EXECUTE FUNCTION billing_provider_events_unprocessed_retention();

CREATE TRIGGER billing_provider_events_set_updated_at
BEFORE UPDATE ON billing_provider_events
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Optimistic-concurrency guard on the authoritative subscription row.
--    `state_version` is bumped by the (future) writer; the database refuses a
--    rewind, so a stale or concurrent writer loses instead of overwriting
--    newer durable state.
-- ---------------------------------------------------------------------------
CREATE FUNCTION subscriptions_state_version_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.state_version < OLD.state_version THEN
    RAISE EXCEPTION
      'subscriptions.state_version cannot decrease (stale writer)'
      USING ERRCODE = '27000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER subscriptions_state_version_monotonic_trg
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION subscriptions_state_version_monotonic();

-- ---------------------------------------------------------------------------
-- 5. Operator-facing documentation.
-- ---------------------------------------------------------------------------
COMMENT ON TABLE billing_customers IS
  'Billing PR2: provider customer identity (one row per provider + user). Reference identifiers only — no credential, card or bank detail is storable. Unused until a later billing PR provisions customers.';
COMMENT ON TABLE billing_provider_events IS
  'Billing PR2: append-only provider-event ledger for billing idempotency and audit. UNIQUE idempotency_key collapses replayed/duplicated provider events; identity columns are immutable and unprocessed events cannot be deleted. Raw provider payloads are never stored (hash only). No webhook receiver exists yet.';
COMMENT ON COLUMN subscriptions.plan IS
  'INTERNAL plan value (free | pro | premium) — the value entitlements are resolved from. Unchanged by 0031; the commercial catalogue vocabulary lives in catalogue_plan.';
COMMENT ON COLUMN subscriptions.catalogue_plan IS
  'COMMERCIAL catalogue plan (starter | pro | elite) recorded for provider-backed subscriptions, CHECK-bound to the canonical mapping pro->pro / premium->elite / free->none. Display/commercial identity only: entitlements never read it. NULL for every row that was not sold through a provider.';
COMMENT ON COLUMN subscriptions.status IS
  'AUTHORITATIVE lifecycle state (0014 vocabulary) used by getEntitlements(). provider_state is what the provider reported; it never widens an entitlement.';
COMMENT ON COLUMN subscriptions.provider_state IS
  'Canonical provider-reported lifecycle state, normalized behind the provider seam before persistence. Provider-specific status strings are never stored.';
COMMENT ON COLUMN subscriptions.billing_interval IS
  'Catalogue billing interval (monthly | annual). Requires a catalogue_plan; NULL for unsold/free rows.';
COMMENT ON COLUMN subscriptions.currency IS
  'Commercial currency. The catalogue is USD-only, so this is pinned to USD.';
COMMENT ON COLUMN subscriptions.catalogue_version IS
  'Catalogue version the provider-backed purchase was made against (BILLING_CATALOGUE_VERSION). Prices are never duplicated here — the catalogue stays authoritative.';
COMMENT ON COLUMN subscriptions.last_event_idempotency_key IS
  'Idempotency key of the last provider event applied to this row (billing_provider_events.idempotency_key). Lets a replayed event be recognized without re-reading the ledger.';
COMMENT ON COLUMN subscriptions.state_version IS
  'Optimistic-concurrency version for provider-backed updates. A trigger refuses a decrease, so a stale writer cannot overwrite newer durable state.';
COMMENT ON COLUMN billing_provider_events.idempotency_key IS
  'sha256(provider|provider_event_id|event_type|occurred_at|payload_hash) — the durable idempotency identity of one provider event.';
COMMENT ON COLUMN billing_provider_events.payload_hash IS
  'sha256 of the received provider payload. The payload itself is never persisted (redaction posture, same as the Gate 9 receipt ledger).';
COMMENT ON INDEX subscriptions_provider_subscription_uniq IS
  'Billing PR2: a provider subscription identifier belongs to exactly one subscriptions row (per provider).';
COMMENT ON INDEX subscriptions_sync_required_idx IS
  'Billing PR2: prepared for a later subscription-synchronization PR. No worker reads this index yet.';
