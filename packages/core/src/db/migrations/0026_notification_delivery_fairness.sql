-- 0026: durable cross-worker fairness state for single-job claims
-- Additive only. This state is independent of delivery-row retention.

CREATE TABLE notification_delivery_fairness (
  singleton       boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_channel    text NOT NULL DEFAULT 'webhook' CHECK (last_channel IN ('email', 'webhook')),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO notification_delivery_fairness (singleton, last_channel)
VALUES (true, 'webhook');

COMMENT ON TABLE notification_delivery_fairness IS
  'M9.1 durable round-robin state; never removed by notification delivery cleanup.';
