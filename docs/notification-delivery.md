# Alert Notification Delivery (M7.3)

M7.3 turns M6's **stub** delivery ledger into a real delivery pipeline. Alert
generation still performs **no external I/O**: it writes a durable outbox row
in the same transaction as the alert, and a separate worker delivers it.

```
strategy → evaluate → detect → score → transition → alert
                                                      │
                          ┌───────────────────────────┘ (same transaction)
                          ▼
                 durable outbox row (notification_deliveries)
                          │
        ┌─────────────────┼──────────────────────────────┐
        ▼                 ▼                              ▼
  in-process ticker   POST /internal/…/run        manual runOnce()
  (every 60s)         (external cron, token)      (script / test)
        └─────────────────┼──────────────────────────────┘
                          ▼
                    worker: claim → send → record
                          │
                          ▼
                  provider adapter (email / SMTP)
                          │
        ┌─────────────────┼─────────────────┬──────────────────┐
        ▼                 ▼                 ▼                  ▼
    delivered       retry scheduled      failed          unavailable
                    (backoff)          (dead letter)   (not configured)
```

Scope of this milestone: **reliable delivery infrastructure only**. No
automated trading (M8), no billing, no user preference centre, no second
channel, no scheduler inside the request path.

## 1. What already existed (M6/M7.2)

| Piece | State before M7.3 |
|---|---|
| `alerts` + `alert_deliveries` (0012) | unchanged — the append-only **stub ledger** still records one local row per alert |
| `AlertSender` / `StubAlertSender` | unchanged — the request-path sender is still the local stub, and `AlertService` still **refuses any non-stub sender** (`NonStubSenderError`) |
| UI copy ("recorded on the stub ledger") | unchanged — the ledger is still what the alert screens describe |
| generation gates, dedup, acknowledgement | unchanged and covered by the M6/M7.1 tests |

M7.3 adds a **parallel, real** pipeline next to the ledger rather than
replacing it, so nothing that worked before moved.

## 2. Outbox (`notification_deliveries`, migration 0013)

One row per **(alert, channel)** — the product rule is "an alert is notified
once per channel", and the database enforces it:

```sql
CREATE UNIQUE INDEX notification_deliveries_alert_channel_uniq
  ON notification_deliveries (alert_id, channel);
CREATE UNIQUE INDEX notification_deliveries_idempotency_uniq
  ON notification_deliveries (idempotency_key);
```

| Column | Purpose |
|---|---|
| `alert_id`, `user_id` | what is being delivered and to whom (FK, `ON DELETE CASCADE`) |
| `channel`, `template` | which channel and which renderer (`alert.email.v1`) |
| `idempotency_key` | `sha256(template｜channel｜alert_id)` — one job per alert, and the key the provider sends upstream (`Message-ID`) |
| `payload`, `payload_hash` | the **server-rendered** message, stored verbatim, plus `sha256` of its canonical JSON |
| `recipient` | the destination (the owner's account email at enqueue time) |
| `status` | `pending` → `processing` → `delivered` / `failed` / `unavailable` |
| `attempts`, `max_attempts` | bounded retry budget (`CHECK (attempts <= max_attempts)`) |
| `provider`, `provider_message_id`, `provider_response_code` | the receipt from the last attempt |
| `failure_category`, `last_error` | why it failed (`none`/`configuration`/`transient`/`permanent`/`timeout`/`stale`/`unknown`) plus a short **redacted** message |
| `next_attempt_at`, `locked_at`, `locked_by` | retry scheduling and the worker lease |
| `delivered_at`, `created_at`, `updated_at` | audit trail (`updated_at` maintained by the shared `set_updated_at()` trigger) |

The payload is rendered from the **persisted** alert (`title`/`body`) plus the
published version's `timeframes.setup`, so a client cannot influence direction,
entry, stop loss, take profits, quality score, strategy result or alert
identity — it can only ask for an alert to be generated
(`packages/core/src/notifications/render.ts`).

## 3. Idempotency

Four independent guards, so no duplicate delivery can be created by:

| Guard | Stops |
|---|---|
| `UNIQUE (alert_id, channel)` | replayed generation, double-clicks, concurrent twins, worker restarts |
| `UNIQUE (idempotency_key)` | a second job for the same logical message (even if the channel index were dropped) |
| `FOR UPDATE SKIP LOCKED` claim | two workers delivering the same job simultaneously |
| stable `Message-ID` per job | a receiver-side duplicate when a provider accepted the message but the reply timed out |

`AlertService.generateAlert` enqueues with `ON CONFLICT … DO NOTHING` inside
the alert transaction, so **alert + job commit together**: an alert can never
exist without exactly one job per channel, and a job can never exist without an
alert.

## 4. Worker (`packages/core/src/notifications/worker.ts`)

`DeliveryWorker.runOnce(batchSize?)` is a bounded, idempotent batch:

1. **recover stale** — jobs still `processing` past their lease (`leaseMs`,
   default 120 s) return to `pending`; those that already used their budget are
   dead-lettered with `failure_category = 'stale'`. This is the crash/deploy
   recovery path and it runs on every invocation, including at API boot.
2. **re-queue `unavailable`** — only for channels that now have a *configured*
   provider, and bounded by the batch size. The attempt counter resets, because
   the previous attempts never reached a provider.
3. **claim** — one statement, `FOR UPDATE SKIP LOCKED`, `attempts + 1`, lease
   stamped, ordered by `next_attempt_at`. Two concurrent invocations (two
   processes, or the ticker and a cron call) get disjoint sets.
4. **send + record** — each job goes to the provider for its channel; the
   outcome is mapped to delivered / retry-scheduled / dead-lettered /
   unavailable.

Invocation (all three are safe to run at the same time):

| Mechanism | Where | Notes |
|---|---|---|
| in-process ticker | `apps/api/src/delivery-worker.ts`, started in `server.ts` | `NOTIFICATION_WORKER_ENABLED` (default **true**), interval 60 s, overlap-guarded, `unref`'d, never throws |
| scheduled HTTP call | `POST /api/internal/notifications/deliveries/run` | `NOTIFICATION_WORKER_TOKEN`; for an external cron (Render Cron Job) — the correct answer when the instance may be asleep |
| manual | `worker.runOnce()` | scripts, tests, ops |

The API is a container that a platform may stop at any time (the Render free
tier spins down), so nothing depends on the ticker being alive: the lease plus
stale recovery guarantees a job is never lost, and an external scheduler can
drain the queue whenever it likes.

## 5. Retry policy

| Setting | Default | Meaning |
|---|---|---|
| `NOTIFICATION_MAX_ATTEMPTS` | `5` | send attempts per job (schema-capped at 10) |
| `NOTIFICATION_BACKOFF_BASE_MS` | `30_000` | attempt *n* waits `base · 2^(n-1)` |
| `NOTIFICATION_BACKOFF_MAX_MS` | `3_600_000` | cap |
| `NOTIFICATION_BACKOFF_JITTER_MS` | `5_000` | deterministic per-job jitter (hash of the idempotency key) so a retry burst spreads out |
| `NOTIFICATION_LEASE_MS` | `120_000` | how long a claim may stay `processing` |
| `NOTIFICATION_PROVIDER_TIMEOUT_MS` | `15_000` | per-attempt provider budget |

| Provider outcome | Row result |
|---|---|
| `delivered` | `delivered` (terminal) + provider receipt |
| `retryable` (4xx, DNS, connection reset) | `pending` with backoff; dead-lettered when the budget is gone |
| `timeout` | `pending` with backoff (same `Message-ID` on the retry) |
| `permanent` (5xx, `EMESSAGE`, `EENVELOPE`) | `failed` immediately — never burns the budget |
| `unavailable` (`EAUTH`, 535/530/534) | `unavailable` — configuration, not a delivery |
| unexpected exception | `pending` with backoff, `failure_category = 'unknown'` |

Retry loops are impossible by construction: the claim itself requires
`attempts < max_attempts`, and `unavailable` is terminal until configuration
changes.

## 6. Provider abstraction

`NotificationProvider` (`packages/core/src/notifications/provider.ts`) is the
only place that knows an external service exists:

```ts
interface NotificationProvider {
  readonly channel: NotificationChannel; // 'email'
  readonly name: string;                 // 'smtp'
  readonly configured: boolean;          // credentials present?
  describe(): Record<string, unknown>;   // operator-safe, never a secret
  send(req: NotificationSendRequest): Promise<NotificationSendResult>;
}
```

The core (strategy engine, alert service, outbox, worker) never imports a
provider — it resolves one through `NotificationProviderRegistry`. Adding
`push`, `webhook` or `sms` later is additive: a new enum value, a new adapter,
one `registry.register()` line in `createAppContext`.

**Implemented in M7.3: `email` via SMTP** (`notifications/email.ts`,
`nodemailer`, no transitive dependencies). It works with any SMTP endpoint —
the operator's own server or a transactional vendor's SMTP relay:

- implicit TLS on port 465, **STARTTLS required** otherwise (`requireTLS`);
- lazy transporter, so an unconfigured deployment opens no socket;
- deterministic `Message-ID: <idempotencyKey@from-domain>` on every attempt;
- `Auto-Submitted: auto-generated` + `X-Auto-Response-Suppress: All` so
  vacation bots cannot bounce into a loop;
- SMTP reply codes mapped to outcomes (4xx → retry, 5xx → dead letter,
  535/530/534 → unavailable).

Nothing was added for demonstration purposes: no second vendor, no SDK wrapper,
no hard-coded credentials.

> **No credentials ⇒ no fake success.** With `SMTP_HOST` / `NOTIFICATION_FROM`
> empty the adapter reports `configured: false` and every job is recorded
> `unavailable` (never `delivered`). Production is switched on purely through
> environment variables — see [environment.md](./environment.md).

## 7. Security

| Control | Implementation |
|---|---|
| internal worker routes are unreachable by default | `NOTIFICATION_WORKER_TOKEN` empty ⇒ the routes answer **404** (not 401), so an unconfigured deployment advertises nothing |
| constant-time token check | SHA-256 digests compared with `timingSafeEqual` (`routes/notifications.ts`) |
| rate limited | 30/min per IP on both internal routes, on top of the global 300/min |
| no caller-supplied content | the run/maintenance bodies accept **only** `batchSize` / retention days; ids, recipients, channels and payloads are rejected with 400 |
| owner scoping | `GET /api/alerts/:alertId/notifications` is session-authenticated and owner-scoped; foreign/unknown/malformed ids are masked 404s |
| minimal DTO | the owner sees status, attempts, failure category, provider and timestamps — never the recipient, payload, provider error or upstream id |
| credentials stay server-side | SMTP settings live in the API environment; `describe()` logs host/port/from/auth-mode only; provider errors are redacted before they are stored or logged |
| no secrets in logs | worker log lines carry job id, alert id, user id, channel, attempt, status, provider, response code and failure category — no recipient, no payload, no credential |
| safe cleanup | retention deletes aged `delivered` (30 d) and `failed` (120 d) rows only; `pending`, `processing` and `unavailable` rows are never deleted |

## 8. Observability

Every attempt is recorded on the row itself, so a failure can be triaged
without tailing logs:

```
id | alert_id | user_id | channel | status     | attempts | failure_category | provider | provider_response_code | last_error | next_attempt_at | delivered_at
```

Structured worker log lines (`[notifications] …`) repeat the same fields plus
`retryDelayMs`. `POST /api/internal/notifications/deliveries/maintenance`
returns `{ recovered, deadLettered, requeued, deleted, depth }`, where `depth`
is the queue depth per status — the number to alert on (`pending` growing,
`failed` non-zero).

## 9. Operations

```bash
# schema (like every other migration, applied at boot and by this CLI)
npm run db:migrate -- --status

# drain the queue once (local / ops)
curl -X POST https://<api>/api/internal/notifications/deliveries/run \
  -H "x-veltrixeye-worker-token: $NOTIFICATION_WORKER_TOKEN"

# stale recovery + retention + queue depth
curl -X POST https://<api>/api/internal/notifications/deliveries/maintenance \
  -H "x-veltrixeye-worker-token: $NOTIFICATION_WORKER_TOKEN"
```

To enable email delivery in production, set `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS` and `NOTIFICATION_FROM` on the API service (secrets in
the platform dashboard, never in the repository) and redeploy. Until then the
API logs a warning on every boot and every job is recorded `unavailable` —
visible, honest, and re-queued automatically once credentials exist.

## 10. What M7.3 does NOT do

No user notification-preference system (an alert goes to the owner's account
email — preferences are their own milestone), no second channel, no template
editor, no in-app inbox, no websockets, no scheduler inside the request path,
no trade execution (M8), no billing.
