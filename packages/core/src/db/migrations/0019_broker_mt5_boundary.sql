-- 0019: M8.4 provider-neutral broker / MT5 integration boundary.
-- No credentials and no network endpoints are stored. Existing live-profile CHECK remains.

ALTER TABLE execution_profiles
  ADD COLUMN broker_server text,
  ADD COLUMN connection_status text NOT NULL DEFAULT 'unconfigured',
  ADD CONSTRAINT execution_profiles_broker_server_check
    CHECK (broker_server IS NULL OR char_length(broker_server) BETWEEN 1 AND 128),
  ADD CONSTRAINT execution_profiles_connection_status_check
    CHECK (connection_status IN ('unconfigured', 'disabled', 'unavailable', 'connected', 'degraded')),
  ADD CONSTRAINT execution_profiles_broker_fields_check
    CHECK (
      (provider_slug = 'paper' AND mode = 'paper' AND broker_server IS NULL)
      OR (provider_slug = 'mt5' AND mode = 'demo')
    );

-- Explicit canonical -> broker symbol mapping. Clients cannot override it per order.
CREATE TABLE execution_symbol_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  instrument_id uuid NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
  broker_symbol text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (broker_symbol ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  CHECK (char_length(broker_symbol) BETWEEN 1 AND 64),
  UNIQUE (execution_profile_id, instrument_id),
  UNIQUE (execution_profile_id, broker_symbol)
);
CREATE INDEX execution_symbol_mappings_profile_idx ON execution_symbol_mappings (execution_profile_id);
CREATE TRIGGER execution_symbol_mappings_set_updated_at
BEFORE UPDATE ON execution_symbol_mappings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Durable intent/uncertainty foundation for M8.5. The M8.4 API exposes no submit route.
CREATE TABLE execution_provider_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  execution_profile_id uuid NOT NULL REFERENCES execution_profiles (id) ON DELETE CASCADE,
  order_id uuid REFERENCES execution_orders (id) ON DELETE SET NULL,
  client_order_id text NOT NULL,
  provider_slug text NOT NULL,
  status text NOT NULL DEFAULT 'prepared',
  provider_order_id text,
  failure_category text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('prepared', 'submitting', 'confirmed', 'rejected', 'uncertain', 'reconciled')),
  CHECK (char_length(client_order_id) BETWEEN 1 AND 64),
  CHECK (provider_order_id IS NULL OR char_length(provider_order_id) BETWEEN 1 AND 128),
  UNIQUE (execution_profile_id, client_order_id)
);
CREATE INDEX execution_provider_intents_user_idx ON execution_provider_intents (user_id, created_at DESC);
CREATE INDEX execution_provider_intents_uncertain_idx ON execution_provider_intents (status) WHERE status = 'uncertain';
CREATE TRIGGER execution_provider_intents_set_updated_at
BEFORE UPDATE ON execution_provider_intents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE execution_symbol_mappings IS 'M8.4 explicit canonical-to-broker symbol mappings; never overridable on order submission.';
COMMENT ON TABLE execution_provider_intents IS 'M8.4 idempotency and uncertain-outcome ledger foundation for M8.5 reconciliation. Contains no credentials.';
COMMENT ON COLUMN execution_profiles.account_ref IS 'Non-secret opaque account label only. Never an MT5 login password or credential.';
COMMENT ON COLUMN execution_profiles.broker_server IS 'Public broker/server label (for example an MT5 demo server), never a network credential.';
