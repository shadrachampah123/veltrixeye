-- 0016: execution architecture foundation (M8.1)
--
-- M8.1 builds the execution ARCHITECTURE and safety boundary only:
--
--   execution_profiles  — user-owned paper/demo/live account configs
--                         (live is impossible: CHECK below + service gates)
--   execution_requests  — idempotent, server-validated execution decisions
--                         (the ONLY entry point toward a future order)
--   execution_orders    — order lifecycle rows (state machine enforced by
--                         CHECK + application transition validation)
--   execution_positions — position rows, reconciliation-ready
--   execution_events    — append-only execution audit trail
--   kill_switches       — global/user/strategy/profile emergency stops
--   users.automation_enabled — the explicit user automation switch (default OFF)
--
-- Hard safety properties encoded here:
--  - NO credentials anywhere: providers are referenced by slug only; broker
--    passwords/keys are never modeled (environment/secret management only).
--  - `environment = 'live'` rows are impossible (CHECK), matching the M8.1
--    boundary that only paper profiles may exist.
--  - Idempotency: execution_requests carries UNIQUE (setup_id,
--    execution_profile_id, action) and a UNIQUE derived idempotency key;
--    orders carry a globally UNIQUE client_order_id and idempotency_key.
--  - Additive only: CREATE TABLE/INDEX/TRIGGER + one ADD COLUMN with a
--    NOT NULL DEFAULT. No existing constraint altered.

-- ---------------------------------------------------------------------------
-- Explicit automation switch (default OFF; only flipped through the
-- entitlement-gated service path — never by raw client input).
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN automation_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Execution profiles (account configuration)
-- ---------------------------------------------------------------------------
CREATE TABLE execution_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mode         text NOT NULL,
  -- M8.1: mode and environment are the same value; the split exists so a
  -- future provider can serve one mode in one environment (e.g. a bridge
  -- adapter), without a schema change.
  environment  text NOT NULL,
  provider_slug text NOT NULL,
  -- Platform-side reference ONLY (e.g. a paper account label). Must never
  -- hold a credential; see CHECKs + application validation.
  account_ref  text,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (mode IN ('paper', 'demo', 'live')),
  CHECK (environment IN ('paper', 'demo', 'live')),
  CHECK (mode = environment),
  -- M8.1 hard boundary: live execution is impossible at the storage layer.
  CHECK (environment <> 'live'),
  CHECK (char_length(provider_slug) BETWEEN 1 AND 64),
  CHECK (account_ref IS NULL OR char_length(account_ref) BETWEEN 1 AND 128)
);

-- One profile per (user, mode): a paper account is a singleton per user.
CREATE UNIQUE INDEX execution_profiles_user_mode_idx ON execution_profiles (user_id, mode);
CREATE INDEX execution_profiles_user_idx ON execution_profiles (user_id, created_at DESC);

CREATE TRIGGER execution_profiles_set_updated_at
BEFORE UPDATE ON execution_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Execution requests (idempotent decision intake)
-- ---------------------------------------------------------------------------
CREATE TABLE execution_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  setup_id             uuid NOT NULL REFERENCES setups (id) ON DELETE CASCADE,
  action               text NOT NULL,
  status               text NOT NULL DEFAULT 'requested',
  -- When status = 'rejected': which safety gate refused, and why.
  rejection_gate       text,
  rejection_reason     text,
  -- The server-validated decision snapshot (provenance: strategy, version,
  -- setup, levels, RR, quality, anchor). Frozen at intake time.
  decision             jsonb NOT NULL,
  -- sha256 of the stable identity user+setup+profile+action. Retries and
  -- duplicates collapse onto it.
  idempotency_key      text NOT NULL,
  architecture_version text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (action IN ('open_long', 'open_short', 'close_position')),
  CHECK (status IN ('requested', 'rejected')),
  CHECK (char_length(idempotency_key) = 64),
  CHECK (
    (status = 'rejected' AND rejection_gate IS NOT NULL)
    OR (status = 'requested' AND rejection_gate IS NULL AND rejection_reason IS NULL)
  )
);

-- THE idempotency guarantee: one intent per (setup, profile, action).
CREATE UNIQUE INDEX execution_requests_intent_idx
  ON execution_requests (setup_id, execution_profile_id, action);
CREATE UNIQUE INDEX execution_requests_idempotency_idx
  ON execution_requests (idempotency_key);
CREATE INDEX execution_requests_user_idx ON execution_requests (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Orders (lifecycle rows; M8.1 never advances them past creation-time state)
-- ---------------------------------------------------------------------------
CREATE TABLE execution_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  execution_request_id uuid REFERENCES execution_requests (id) ON DELETE SET NULL,
  -- Platform-generated stable order identity. Globally unique: a retry can
  -- never mint a second order identity.
  client_order_id      text NOT NULL,
  provider_slug        text NOT NULL,
  provider_order_id    text,
  asset_class          text NOT NULL,
  symbol               text NOT NULL,
  side                 text NOT NULL,
  order_type           text NOT NULL,
  quantity             numeric(24, 10) NOT NULL,
  requested_price      numeric(24, 10),
  stop_loss_price      numeric(24, 10),
  take_profit_price    numeric(24, 10),
  filled_quantity      numeric(24, 10) NOT NULL DEFAULT 0,
  average_fill_price   numeric(24, 10),
  status               text NOT NULL,
  reject_reason        text,
  idempotency_key      text NOT NULL,
  architecture_version text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  submitted_at         timestamptz,
  filled_at            timestamptz,
  CHECK (side IN ('buy', 'sell')),
  CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit')),
  CHECK (status IN (
    'requested', 'validating', 'submitted', 'accepted', 'partially_filled',
    'filled', 'rejected', 'cancelled', 'expired', 'failed'
  )),
  CHECK (quantity > 0),
  CHECK (filled_quantity >= 0 AND filled_quantity <= quantity),
  CHECK (char_length(client_order_id) BETWEEN 1 AND 64),
  CHECK (char_length(idempotency_key) = 64),
  CHECK (char_length(provider_slug) BETWEEN 1 AND 64),
  CHECK (provider_order_id IS NULL OR char_length(provider_order_id) BETWEEN 1 AND 128),
  CHECK (symbol ~ '^[A-Z0-9][A-Z0-9._:-]*$' AND char_length(symbol) <= 32)
);

CREATE UNIQUE INDEX execution_orders_client_order_id_idx ON execution_orders (client_order_id);
CREATE UNIQUE INDEX execution_orders_idempotency_idx ON execution_orders (idempotency_key);
CREATE INDEX execution_orders_user_idx ON execution_orders (user_id, created_at DESC);
CREATE INDEX execution_orders_profile_idx ON execution_orders (execution_profile_id, created_at DESC);
CREATE INDEX execution_orders_status_idx ON execution_orders (status);

CREATE TRIGGER execution_orders_set_updated_at
BEFORE UPDATE ON execution_orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Positions (reconciliation-ready)
-- ---------------------------------------------------------------------------
CREATE TABLE execution_positions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id  uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  provider_slug         text NOT NULL,
  provider_position_id  text,
  asset_class           text NOT NULL,
  symbol                text NOT NULL,
  direction             text NOT NULL,
  quantity              numeric(24, 10) NOT NULL,
  average_entry_price   numeric(24, 10) NOT NULL,
  stop_loss_price       numeric(24, 10),
  take_profit_price     numeric(24, 10),
  realized_pl           numeric(24, 10),
  unrealized_pl         numeric(24, 10),
  status                text NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (direction IN ('long', 'short')),
  CHECK (status IN ('open', 'closed')),
  CHECK (quantity > 0),
  CHECK (average_entry_price > 0),
  CHECK (char_length(provider_slug) BETWEEN 1 AND 64),
  CHECK (provider_position_id IS NULL OR char_length(provider_position_id) BETWEEN 1 AND 128),
  CHECK (symbol ~ '^[A-Z0-9][A-Z0-9._:-]*$' AND char_length(symbol) <= 32),
  CHECK (
    (status = 'open' AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);

CREATE INDEX execution_positions_user_idx ON execution_positions (user_id, status, opened_at DESC);
CREATE INDEX execution_positions_profile_idx ON execution_positions (execution_profile_id, status);
CREATE UNIQUE INDEX execution_positions_provider_idx
  ON execution_positions (execution_profile_id, provider_position_id)
  WHERE provider_position_id IS NOT NULL;

CREATE TRIGGER execution_positions_set_updated_at
BEFORE UPDATE ON execution_positions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Execution audit trail (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE execution_events (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid REFERENCES execution_profiles (id) ON DELETE SET NULL,
  order_id             uuid REFERENCES execution_orders (id) ON DELETE SET NULL,
  position_id          uuid REFERENCES execution_positions (id) ON DELETE SET NULL,
  setup_id             uuid REFERENCES setups (id) ON DELETE SET NULL,
  event                text NOT NULL,
  from_status          text,
  to_status            text,
  reason               text,
  metadata             jsonb NOT NULL DEFAULT '{}',
  ip                   text,
  user_agent           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(event) BETWEEN 1 AND 64)
);

CREATE INDEX execution_events_user_idx ON execution_events (user_id, created_at DESC);
CREATE INDEX execution_events_order_idx ON execution_events (order_id);
CREATE INDEX execution_events_position_idx ON execution_events (position_id);
CREATE INDEX execution_events_setup_idx ON execution_events (setup_id);

CREATE TRIGGER execution_events_append_only
BEFORE UPDATE OR DELETE ON execution_events
FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- ---------------------------------------------------------------------------
-- Kill switches (emergency stop contract)
-- ---------------------------------------------------------------------------
CREATE TABLE kill_switches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text NOT NULL,
  -- NULL for the global switch; otherwise the id of the scoped entity.
  target_id  uuid,
  active     boolean NOT NULL DEFAULT false,
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope IN ('global', 'user', 'strategy', 'execution_profile')),
  CHECK (
    (scope = 'global' AND target_id IS NULL)
    OR (scope <> 'global' AND target_id IS NOT NULL)
  )
);

-- Exactly one row per (scope, target): the switch state is upserted, never
-- duplicated. (Two partial-index-style uniques: global singleton + targets.)
CREATE UNIQUE INDEX kill_switches_global_idx ON kill_switches (scope) WHERE scope = 'global';
CREATE UNIQUE INDEX kill_switches_target_idx ON kill_switches (scope, target_id) WHERE scope <> 'global';

CREATE TRIGGER kill_switches_set_updated_at
BEFORE UPDATE ON kill_switches
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE execution_profiles IS
  'M8.1: user-owned execution account configuration. Credentials are NEVER stored here — provider_slug + account_ref (a non-secret reference) only.';
COMMENT ON TABLE execution_requests IS
  'M8.1: idempotent server-validated execution decisions. UNIQUE (setup, profile, action) collapses retries and duplicates.';
COMMENT ON TABLE execution_orders IS
  'M8.1: order lifecycle rows. M8.1 creates none — no provider can trade yet; the schema exists so M8.2+ has a pinned, auditable lifecycle.';
COMMENT ON TABLE execution_positions IS
  'M8.1: position rows, reconciliation-ready (provider_position_id unique per profile when present).';
COMMENT ON TABLE execution_events IS
  'M8.1: append-only execution audit trail (execution_requested, order_*, position_*, …).';
COMMENT ON TABLE kill_switches IS
  'M8.1: emergency stop contract — global, per-user, per-strategy, per-profile. Active switch ⇒ no new execution may be accepted.';
