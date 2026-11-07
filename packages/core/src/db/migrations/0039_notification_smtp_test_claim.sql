-- 0039: isolated one-time SMTP diagnostic claim.
-- This table is intentionally separate from notification_deliveries/outbox.
-- A claim is permanent: an ambiguous SMTP timeout must never trigger a duplicate send.
CREATE TABLE notification_smtp_test_claims (
  test_key text PRIMARY KEY
    CHECK (test_key = 'production-smtp-diagnostic-v1'),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL DEFAULT 'claimed'
    CHECK (outcome IN ('claimed', 'delivered', 'failed')),
  failure_category text NULL
    CHECK (failure_category IS NULL OR failure_category IN
      ('none', 'configuration', 'transient', 'permanent', 'timeout', 'stale', 'unknown')),
  finished_at timestamptz NULL,
  CHECK ((outcome = 'claimed' AND finished_at IS NULL) OR
         (outcome <> 'claimed' AND finished_at IS NOT NULL))
);
