-- 0014: subscriptions and entitlements

CREATE TABLE subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan                 text NOT NULL DEFAULT 'free',
  status               text NOT NULL DEFAULT 'active',
  provider             text,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (plan IN ('free', 'pro', 'premium')),
  CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'expired'))
);

CREATE UNIQUE INDEX subscriptions_user_id_idx ON subscriptions (user_id);
CREATE INDEX subscriptions_provider_sub_idx ON subscriptions (provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;

CREATE TRIGGER subscriptions_set_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Populate existing users with free subscriptions if they don't have one
INSERT INTO subscriptions (user_id, plan, status)
SELECT id, plan, 'active' FROM users;
