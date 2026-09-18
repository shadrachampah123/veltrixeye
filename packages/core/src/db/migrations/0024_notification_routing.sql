-- 0024: notification quiet hours, strategy routing and webhook delivery secret

CREATE TABLE notification_user_settings (
  user_id                  uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  quiet_hours_start_minute integer,
  quiet_hours_end_minute   integer,
  quiet_hours_timezone     text NOT NULL DEFAULT 'UTC',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (quiet_hours_start_minute IS NULL OR quiet_hours_start_minute BETWEEN 0 AND 1439),
  CHECK (quiet_hours_end_minute IS NULL OR quiet_hours_end_minute BETWEEN 0 AND 1439),
  CHECK ((quiet_hours_start_minute IS NULL) = (quiet_hours_end_minute IS NULL)),
  CHECK (char_length(quiet_hours_timezone) BETWEEN 1 AND 64)
);
CREATE TRIGGER notification_user_settings_set_updated_at
BEFORE UPDATE ON notification_user_settings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE strategy_notification_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  strategy_id uuid NOT NULL REFERENCES strategies (id) ON DELETE CASCADE,
  muted       boolean NOT NULL DEFAULT false,
  channels    text[],
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (channels IS NULL OR cardinality(channels) <= 2),
  CHECK (channels IS NULL OR channels <@ ARRAY['email', 'webhook']::text[]),
  FOREIGN KEY (strategy_id, user_id) REFERENCES strategies (id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX strategy_notification_preferences_user_strategy_uniq
  ON strategy_notification_preferences (user_id, strategy_id);
CREATE INDEX strategy_notification_preferences_user_idx
  ON strategy_notification_preferences (user_id);
CREATE TRIGGER strategy_notification_preferences_set_updated_at
BEFORE UPDATE ON strategy_notification_preferences
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE strategy_notification_preferences IS
  'M9.1: owner-scoped per-strategy mute and channel routing; null channels means all enabled global channels.';
