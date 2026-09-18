-- 0023: per-user notification preferences and dedicated webhook outbox (M9.1)
-- 0013 is production-applied and intentionally remains email-only. Webhook
-- jobs therefore use a separate table rather than changing its channel check.

CREATE UNIQUE INDEX strategies_id_user_uniq
  ON strategies (id, user_id);

CREATE TABLE notification_webhook_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id              uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  strategy_id           uuid NOT NULL,
  channel               text NOT NULL DEFAULT 'webhook' CHECK (channel = 'webhook'),
  template              text NOT NULL,
  idempotency_key       text NOT NULL,
  payload_hash          text NOT NULL,
  payload               jsonb NOT NULL,
  recipient             text NOT NULL,
  signing_secret        text,
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
  CHECK (signing_secret IS NULL OR char_length(signing_secret) BETWEEN 1 AND 512),
  CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'unavailable')),
  CHECK (failure_category IN ('none', 'configuration', 'transient', 'permanent', 'timeout', 'stale', 'unknown')),
  CHECK (attempts >= 0 AND attempts <= 100),
  CHECK (max_attempts BETWEEN 1 AND 10),
  CHECK (attempts <= max_attempts),
  CHECK (last_error IS NULL OR char_length(last_error) <= 600)
);
CREATE UNIQUE INDEX notification_webhook_deliveries_alert_uniq
  ON notification_webhook_deliveries (alert_id);
CREATE UNIQUE INDEX notification_webhook_deliveries_idempotency_uniq
  ON notification_webhook_deliveries (idempotency_key);
CREATE INDEX notification_webhook_deliveries_claim_idx
  ON notification_webhook_deliveries (next_attempt_at, created_at) WHERE status = 'pending';
CREATE INDEX notification_webhook_deliveries_processing_idx
  ON notification_webhook_deliveries (locked_at) WHERE status = 'processing';
CREATE INDEX notification_webhook_deliveries_status_idx
  ON notification_webhook_deliveries (status, next_attempt_at);
CREATE INDEX notification_webhook_deliveries_user_idx
  ON notification_webhook_deliveries (user_id, created_at DESC);
CREATE TRIGGER notification_webhook_deliveries_set_updated_at
BEFORE UPDATE ON notification_webhook_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_preferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel         text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  endpoint_url    text,
  signing_secret  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (channel IN ('email', 'webhook')),
  CHECK (endpoint_url IS NULL OR char_length(endpoint_url) BETWEEN 8 AND 2048),
  CHECK (signing_secret IS NULL OR char_length(signing_secret) BETWEEN 1 AND 512),
  CHECK (channel = 'webhook' OR (endpoint_url IS NULL AND signing_secret IS NULL)),
  CHECK (channel = 'email' OR endpoint_url IS NOT NULL)
);
CREATE UNIQUE INDEX notification_preferences_user_channel_uniq ON notification_preferences (user_id, channel);
CREATE INDEX notification_preferences_user_idx ON notification_preferences (user_id);
CREATE TRIGGER notification_preferences_set_updated_at
BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE notification_preferences IS
  'M9.1 preferences; webhook signing secrets are write-only at the application boundary and currently plaintext in the database.';
COMMENT ON TABLE notification_webhook_deliveries IS
  'M9.1 webhook outbox; separate from the production email-only notification_deliveries table.';
