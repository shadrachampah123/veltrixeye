-- 0027: durable per-queue claim ledger for notification fairness (M9.1 remediation)
--
-- The reviewed fairness rule preferred "the queue with less history", computed
-- as sum(attempts) over notification_deliveries and
-- notification_webhook_deliveries under advisory lock 611_231_008. Those rows
-- age out through the outbox's normal cleanup(), so retention alone could
-- reset one queue's score and make the preference lifecycle-dependent.
-- Migration 0026 made the round-robin TURN durable, but a batch claim still
-- has no durable score to consult.
--
-- This migration completes the durable state: one monotonic lifetime counter
-- per queue, incremented inside the very transaction that flips jobs to
-- 'processing' (same coordination, same advisory lock). The counters are never
-- decremented, never cleaned up, and never derived from delivery rows, so
-- neither retention nor alert cascades nor retries can rewind them.
--
-- Additive only: ALTER TABLE ... ADD COLUMN with defaults on the existing
-- singleton row. No existing table, index, constraint or column is altered;
-- safe to apply in place on databases that already ran 0026.

ALTER TABLE notification_delivery_fairness
  ADD COLUMN email_claims   bigint NOT NULL DEFAULT 0 CHECK (email_claims >= 0),
  ADD COLUMN webhook_claims bigint NOT NULL DEFAULT 0 CHECK (webhook_claims >= 0);

COMMENT ON COLUMN notification_delivery_fairness.email_claims IS
  'M9.1: lifetime email-queue claims; incremented only inside the claiming transaction under advisory lock 611_231_008; immune to retention cleanup and cascade deletes.';
COMMENT ON COLUMN notification_delivery_fairness.webhook_claims IS
  'M9.1: lifetime webhook-queue claims; same durable rules as email_claims.';
