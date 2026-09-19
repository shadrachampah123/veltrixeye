-- 0028: push channel + secret hardening (M9.2)
-- Additive/data-preserving, safe from production state 0027 applied.
-- Adds:
--  * notification_push_deliveries (separate table because 0013 is email-only)
--  * encrypted secret columns + key version where needed
--  * push_claims to notification_delivery_fairness
--  * extends channel CHECKs to include push
--
-- IMPORTANT: Do NOT assume PostgreSQL-generated constraint names.
-- Before dropping/replacing CHECK constraints, inspect actual definition.

-- ---------------------------------------------------------------------------
-- 1. Push delivery outbox
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_push_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id              uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  strategy_id           uuid NOT NULL,
  channel               text NOT NULL DEFAULT 'push' CHECK (channel = 'push'),
  template              text NOT NULL,
  idempotency_key       text NOT NULL,
  payload_hash          text NOT NULL,
  payload               jsonb NOT NULL,
  recipient             text NOT NULL,
  signing_secret        text,
  signing_secret_encrypted text,
  signing_secret_key_version integer,
  status                text NOT NULL DEFAULT 'pending',
  attempts              integer NOT NULL DEFAULT 0,
  max_attempts          integer NOT NULL DEFAULT 5,
  provider              text,
  provider_message_id   text,
  provider_response_code text,
  failure_category      text NOT NULL DEFAULT 'none',
  last_error            text,
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  locked_at             timestamptz,
  locked_by             text,
  delivered_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (strategy_id, user_id) REFERENCES strategies (id, user_id) ON DELETE CASCADE,
  CHECK (char_length(idempotency_key) = 64),
  CHECK (char_length(payload_hash) = 64),
  CHECK (char_length(recipient) BETWEEN 8 AND 2048),
  CHECK (char_length(template) BETWEEN 1 AND 64),
  CHECK (signing_secret IS NULL OR char_length(signing_secret) BETWEEN 1 AND 4096),
  CHECK (signing_secret_encrypted IS NULL OR char_length(signing_secret_encrypted) BETWEEN 8 AND 8192),
  CHECK (signing_secret_key_version IS NULL OR signing_secret_key_version >= 0),
  CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'unavailable')),
  CHECK (failure_category IN ('none', 'configuration', 'transient', 'permanent', 'timeout', 'stale', 'unknown')),
  CHECK (attempts >= 0 AND attempts <= 100),
  CHECK (max_attempts BETWEEN 1 AND 10),
  CHECK (attempts <= max_attempts),
  CHECK (last_error IS NULL OR char_length(last_error) <= 600)
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_push_deliveries_alert_uniq
  ON notification_push_deliveries (alert_id);
CREATE UNIQUE INDEX IF NOT EXISTS notification_push_deliveries_idempotency_uniq
  ON notification_push_deliveries (idempotency_key);
CREATE INDEX IF NOT EXISTS notification_push_deliveries_claim_idx
  ON notification_push_deliveries (next_attempt_at, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS notification_push_deliveries_processing_idx
  ON notification_push_deliveries (locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS notification_push_deliveries_status_idx
  ON notification_push_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS notification_push_deliveries_user_idx
  ON notification_push_deliveries (user_id, created_at DESC);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'notification_push_deliveries_set_updated_at') THEN
    CREATE TRIGGER notification_push_deliveries_set_updated_at
    BEFORE UPDATE ON notification_push_deliveries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMENT ON TABLE notification_push_deliveries IS
  'M9.2 push outbox; separate from email-only and webhook tables; signing_secret holds JSON keys encrypted at rest via SecretManager.';

-- ---------------------------------------------------------------------------
-- 2. Encrypted secret columns for existing tables
-- ---------------------------------------------------------------------------
-- notification_preferences
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS signing_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS signing_secret_key_version integer;

DO $$
BEGIN
  -- Add check constraints for new columns if not exists, allowing version 0 for Noop (dev/test only)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_signing_secret_encrypted_len') THEN
    ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_signing_secret_encrypted_len
      CHECK (signing_secret_encrypted IS NULL OR char_length(signing_secret_encrypted) BETWEEN 8 AND 8192);
  END IF;
  -- Drop old version check if exists with >=1, replace with >=0 to allow Noop in tests
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_signing_secret_key_version_check') THEN
    ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_signing_secret_key_version_check;
  END IF;
  ALTER TABLE notification_preferences
    ADD CONSTRAINT notification_preferences_signing_secret_key_version_check
    CHECK (signing_secret_key_version IS NULL OR signing_secret_key_version >= 0);
END $$;

-- notification_webhook_deliveries
ALTER TABLE notification_webhook_deliveries
  ADD COLUMN IF NOT EXISTS signing_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS signing_secret_key_version integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_webhook_deliveries_signing_secret_encrypted_len') THEN
    ALTER TABLE notification_webhook_deliveries
      ADD CONSTRAINT notification_webhook_deliveries_signing_secret_encrypted_len
      CHECK (signing_secret_encrypted IS NULL OR char_length(signing_secret_encrypted) BETWEEN 8 AND 8192);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_webhook_deliveries_signing_secret_key_version_check') THEN
    ALTER TABLE notification_webhook_deliveries DROP CONSTRAINT notification_webhook_deliveries_signing_secret_key_version_check;
  END IF;
  ALTER TABLE notification_webhook_deliveries
    ADD CONSTRAINT notification_webhook_deliveries_signing_secret_key_version_check
    CHECK (signing_secret_key_version IS NULL OR signing_secret_key_version >= 0);
END $$;

-- Update existing signing_secret length checks from 512 to 4096 for push keys JSON
-- We need to drop old length checks safely by inspecting definition
DO $$
DECLARE
  r RECORD;
BEGIN
  -- notification_preferences signing_secret length
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notification_preferences'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%signing_secret%char_length%512%'
  LOOP
    EXECUTE format('ALTER TABLE notification_preferences DROP CONSTRAINT %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notification_webhook_deliveries'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%signing_secret%char_length%512%'
  LOOP
    EXECUTE format('ALTER TABLE notification_webhook_deliveries DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_signing_secret_len') THEN
    ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_signing_secret_len
      CHECK (signing_secret IS NULL OR char_length(signing_secret) BETWEEN 1 AND 4096);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_webhook_deliveries_signing_secret_len') THEN
    ALTER TABLE notification_webhook_deliveries
      ADD CONSTRAINT notification_webhook_deliveries_signing_secret_len
      CHECK (signing_secret IS NULL OR char_length(signing_secret) BETWEEN 1 AND 4096);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Extend channel CHECK constraints to include push
-- ---------------------------------------------------------------------------
-- notification_preferences channel IN ('email','webhook') -> ('email','webhook','push')
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notification_preferences'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%channel%'
      AND pg_get_constraintdef(oid) ILIKE '%email%'
      AND pg_get_constraintdef(oid) ILIKE '%webhook%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%push%'
  LOOP
    EXECUTE format('ALTER TABLE notification_preferences DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_channel_check_m92') THEN
    ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_channel_check_m92
      CHECK (channel IN ('email', 'webhook', 'push'));
  END IF;
END $$;

-- notification_preferences endpoint_url / signing_secret logic:
-- Old: CHECK (channel = 'webhook' OR (endpoint_url IS NULL AND signing_secret IS NULL))
-- Old: CHECK (channel = 'email' OR endpoint_url IS NOT NULL)
-- Need to extend to allow push: push also requires endpoint_url, may have signing_secret (keys)
-- Robust drop: any check that mentions both channel and endpoint_url (the two old ones)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notification_preferences'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%channel%'
      AND pg_get_constraintdef(oid) ILIKE '%endpoint_url%'
      AND conname NOT LIKE 'notification_preferences_channel_check_m92'
      AND conname NOT LIKE 'notification_preferences_webhook_push_endpoint_check'
      AND conname NOT LIKE 'notification_preferences_signing_secret%'
      AND conname NOT LIKE 'notification_preferences_endpoint_url%'
  LOOP
    EXECUTE format('ALTER TABLE notification_preferences DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_webhook_push_endpoint_check') THEN
    ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_webhook_push_endpoint_check
      CHECK (
        (channel = 'email')
        OR
        (channel IN ('webhook', 'push') AND endpoint_url IS NOT NULL)
      );
  END IF;
END $$;

-- For safety, ensure email does not accept webhook fields is enforced at app layer,
-- DB layer will allow but app validates. To keep DB permissive for future, we
-- only enforce that webhook/push must have endpoint_url.

-- strategy_notification_preferences: cardinality <=2 -> <=3 and channels <@ ARRAY['email','webhook'] -> include push
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'strategy_notification_preferences'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%cardinality%'
      AND pg_get_constraintdef(oid) ILIKE '%channels%'
      AND pg_get_constraintdef(oid) ILIKE '%<=%2%'
  LOOP
    EXECUTE format('ALTER TABLE strategy_notification_preferences DROP CONSTRAINT %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'strategy_notification_preferences'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%channels%'
      AND pg_get_constraintdef(oid) ILIKE '%email%'
      AND pg_get_constraintdef(oid) ILIKE '%webhook%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%push%'
  LOOP
    EXECUTE format('ALTER TABLE strategy_notification_preferences DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_notification_preferences_channels_cardinality_m92') THEN
    ALTER TABLE strategy_notification_preferences
      ADD CONSTRAINT strategy_notification_preferences_channels_cardinality_m92
      CHECK (channels IS NULL OR cardinality(channels) <= 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_notification_preferences_channels_allowed_m92') THEN
    ALTER TABLE strategy_notification_preferences
      ADD CONSTRAINT strategy_notification_preferences_channels_allowed_m92
      CHECK (channels IS NULL OR channels <@ ARRAY['email', 'webhook', 'push']::text[]);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Extend fairness ledger to push
-- ---------------------------------------------------------------------------
ALTER TABLE notification_delivery_fairness
  ADD COLUMN IF NOT EXISTS push_claims bigint NOT NULL DEFAULT 0 CHECK (push_claims >= 0);

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Drop any existing last_channel check, regardless of whether Postgres rewrote IN to = ANY
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notification_delivery_fairness'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%last_channel%'
  LOOP
    EXECUTE format('ALTER TABLE notification_delivery_fairness DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_delivery_fairness_last_channel_check_m92') THEN
    ALTER TABLE notification_delivery_fairness
      ADD CONSTRAINT notification_delivery_fairness_last_channel_check_m92
      CHECK (last_channel IN ('email', 'webhook', 'push'));
  END IF;
END $$;

COMMENT ON COLUMN notification_delivery_fairness.push_claims IS
  'M9.2 lifetime push-queue claims; incremented only inside claiming transaction under advisory lock 611_231_008; immune to retention cleanup and cascade deletes, same durable rules as email_claims/webhook_claims.';

-- ---------------------------------------------------------------------------
-- 5. Ensure composite unique indexes for push tenant integrity (already FK, but add unique for alert)
-- ---------------------------------------------------------------------------
-- alert_id unique already created above, but also ensure alert_id+user and alert_id+strategy FKs exist (they do via table def)

-- ---------------------------------------------------------------------------
-- 6. Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE notification_preferences IS
  'M9.2 preferences; webhook signing secrets and push subscription keys are encrypted at rest via SecretManager (AES-256-GCM) using WEBHOOK_SECRET_ENCRYPTION_KEY; never returned by API, never logged.';
