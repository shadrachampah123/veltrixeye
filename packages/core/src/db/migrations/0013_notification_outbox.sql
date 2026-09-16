-- 0013: durable notification outbox (M7.3)
--
-- M6/M7.2 delivery is a STUB ledger row (`alert_deliveries`): nothing leaves
-- the process. M7.3 adds the real delivery pipeline next to it, without
-- touching the alert ledger or the alert domain:
--
--   alert created  →  notification_deliveries row (same transaction)
--                  →  worker claims it (FOR UPDATE SKIP LOCKED)
--                  →  provider adapter sends it
--                  →  delivered / retry scheduled / failed / unavailable
--
-- Design rules encoded in the schema:
--  - ONE job per (alert, channel): `UNIQUE (alert_id, channel)` is the
--    idempotency guarantee. A replayed generation request, a retried HTTP
--    call, a concurrent twin or a restarted worker all collapse onto the one
--    row — no duplicate notification is possible at the database level.
--  - `idempotency_key` is UNIQUE too, and is what the provider sends upstream
--    (email: `Message-ID`), so a retry after a timeout can be de-duplicated by
--    the receiver as well.
--  - the payload is stored VERBATIM: what is delivered is the server-rendered
--    content frozen at generation time, never a re-render that a client or a
--    later state change could influence.
--  - attempts are bounded (`attempts <= max_attempts`), so no code path can
--    loop forever; the lease (`locked_at`) is what lets stale work be
--    recovered after a crash.
--  - `unavailable` is a distinct terminal state: no provider configured is
--    NOT a delivery and NOT a provider fault, and it must never be recorded
--    as either.
--
-- This migration is additive: CREATE TABLE/INDEX/TRIGGER only. The
-- `set_updated_at()` function already exists (0001) and is reused, never
-- redefined. No existing column, table, index or constraint is altered.

CREATE TABLE notification_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id              uuid NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Delivery channel. Only 'email' has an adapter in M7.3; a new channel is
  -- an additive enum + provider change (see docs/notification-delivery.md).
  channel               text NOT NULL,
  -- Renderer/version that produced `payload` (part of the idempotency key).
  template              text NOT NULL,
  -- sha256(template|channel|alert_id) — one job per alert and channel.
  idempotency_key       text NOT NULL,
  -- sha256 of the canonical rendered payload (content audit / drift check).
  payload_hash          text NOT NULL,
  -- The exact server-rendered message (subject/text/structured facts).
  payload               jsonb NOT NULL,
  -- Destination for the channel (the owner's account email at enqueue time).
  recipient             text NOT NULL,

  status                text NOT NULL DEFAULT 'pending',
  attempts              integer NOT NULL DEFAULT 0,
  max_attempts          integer NOT NULL DEFAULT 5,

  -- Last provider that handled the job + its receipt (traceability only).
  provider              text,
  provider_message_id   text,
  provider_response_code text,

  -- Why the last attempt ended as it did (see NOTIFICATION_FAILURE_CATEGORIES).
  failure_category      text NOT NULL DEFAULT 'none',
  -- Redacted, truncated provider error. Ops-only: never returned to browsers.
  last_error            text,

  -- Retry scheduling + lease (worker crash recovery).
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  locked_at             timestamptz,
  locked_by             text,

  delivered_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CHECK (channel IN ('email')),
  CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'unavailable')),
  CHECK (
    failure_category IN ('none', 'configuration', 'transient', 'permanent', 'timeout', 'stale', 'unknown')
  ),
  CHECK (attempts >= 0 AND attempts <= 100),
  CHECK (max_attempts BETWEEN 1 AND 10),
  -- The retry budget is enforced by the schema as well as by the worker.
  CHECK (attempts <= max_attempts),
  CHECK (char_length(idempotency_key) = 64),
  CHECK (char_length(payload_hash) = 64),
  CHECK (char_length(recipient) BETWEEN 3 AND 320),
  CHECK (char_length(template) BETWEEN 1 AND 64),
  CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 320),
  CHECK (provider_response_code IS NULL OR char_length(provider_response_code) <= 32),
  CHECK (last_error IS NULL OR char_length(last_error) <= 600)
);

-- Idempotency: at most one delivery job per alert and channel.
CREATE UNIQUE INDEX notification_deliveries_alert_channel_uniq
  ON notification_deliveries (alert_id, channel);
CREATE UNIQUE INDEX notification_deliveries_idempotency_uniq
  ON notification_deliveries (idempotency_key);

-- Worker claim: due pending jobs, oldest first (partial → stays small).
CREATE INDEX notification_deliveries_claim_idx
  ON notification_deliveries (next_attempt_at ASC, created_at ASC)
  WHERE status = 'pending';

-- Lease recovery + queue inspection.
CREATE INDEX notification_deliveries_processing_idx
  ON notification_deliveries (locked_at)
  WHERE status = 'processing';
CREATE INDEX notification_deliveries_status_idx
  ON notification_deliveries (status, next_attempt_at);

-- Owner-scoped reads (the alert ownership check is the API's; this keeps the
-- per-alert lookup indexed) and retention cleanup.
CREATE INDEX notification_deliveries_alert_idx ON notification_deliveries (alert_id);
CREATE INDEX notification_deliveries_user_idx ON notification_deliveries (user_id, created_at DESC);
CREATE INDEX notification_deliveries_delivered_idx
  ON notification_deliveries (delivered_at)
  WHERE status = 'delivered';

COMMENT ON TABLE notification_deliveries IS
  'M7.3: durable alert-delivery outbox. One job per (alert, channel); claimed with FOR UPDATE SKIP LOCKED, retried with bounded exponential backoff, dead-lettered on permanent failure or retry exhaustion.';

-- Keep updated_at current on every transition (same helper as 0001/0003/0006).
CREATE TRIGGER notification_deliveries_set_updated_at
BEFORE UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
