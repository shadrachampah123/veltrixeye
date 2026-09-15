# Setup Alerts (M6, Phases 1–4)

M6 alerts notify an owner when one of their setups reaches an actionable state
with sufficient quality. Like M4 detection and M5 scoring, alert generation is
**invoked explicitly, never automatic**: there is no scheduler, scanner, queue,
or background worker anywhere in this milestone.

- **Phase 1** — versioned contracts (`@veltrixeye/contracts`) and the alert +
  delivery tables (`0012_alerts.sql`).
- **Phase 2** — `AlertService` and the HTTP surface
  (`/api/setups/:setupId/alerts`, `/api/alerts`).
- **Phase 3** — the `AlertSender` stub boundary, the pinned generation gates,
  replay-safe ledgering, audit events, and the end-to-end lifecycle tests.
- **Phase 4** — the web UI: alert list, alert detail, acknowledgement and
  explicit generation from an owned setup (`apps/web`, frontend only — no new
  endpoint, no backend change).

Delivery is **stub-only**: an append-only ledger row is written in the same
transaction as the alert, and nothing is transmitted. No email, webhook, push,
vendor SDK, new environment variable, credential, scheduler, worker, queue,
cron or background job exists in M6.

## 1. Contracts (`packages/contracts/src/alerts.ts`)

- **Statuses**: `pending`, `acknowledged` (`suppressed` is a reserved value the
  M6 service never writes).
- **Trigger states** (= eligible setup states): `confirmed`, `triggered`.
- **Channels**: `stub` (the only one written), plus reserved `email`,
  `webhook`, `push` values so real delivery needs no migration later.
- **Delivery statuses**: `delivered`, `failed` (the stub always writes
  `delivered`).
- **Skipped reason**: `below_min_quality` — the single silent outcome of a
  valid generation request.
- **DTOs**: `alertGenerateRequestSchema`, `alertGenerateResponseSchema`,
  `alertListQuerySchema`, `alertListResponseSchema`, `alertDtoSchema`,
  `alertDeliveryDtoSchema`, `alertDetailDtoSchema`,
  `alertAcknowledgeRequestSchema`.

## 2. Generation rules (pinned order)

`AlertService.generateAlert` (in `packages/core/src/alerts/service.ts`) is the
only writer of `alerts` / `alert_deliveries`. It consumes the existing M4
lifecycle state and the existing M5 score — it never re-evaluates conditions,
never re-scores, and never transitions a setup.

1. **Ownership** — the setup must exist and belong to the caller through the
   existing chain `setups.strategy_version_id → strategy_versions.strategy_id →
   strategies.user_id`. Unknown *or* foreign ids are masked as **404** so
   existence is never disclosed.
2. **Eligible state** — only `confirmed` and `triggered` may generate. Any
   other state is refused with **400**:
   - terminal states (`completed`, `invalidated`, `expired`) →
     `Setup is in terminal state "<state>" — no alert can be generated for an
     invalidated, expired or completed setup.`
   - pre-confirmation states (`developing`, `watching`, `almost_ready`) →
     `Setup is in state "<state>" — only confirmed or triggered setups can
     generate alerts.`

   The state gate runs **before** the score gate, so an ineligible setup is
   refused for the real reason. It is then **re-checked under a row lock
   inside the generation transaction** (`SELECT state FROM setups WHERE id =
   $1 FOR SHARE`, immediately after `BEGIN`): that share lock conflicts with
   the `FOR UPDATE` M4's `SetupService.transitionSetup` holds while changing
   state, so a transition that lands while generation is in flight either
   blocks until the alert commits or is seen by the re-check and refused —
   an alert is never written for a setup that is terminal by commit time.
3. **M5 score required** — a `setup_scores` row must exist at the setup's own
   detection anchor (`setups.as_of_ms`). Missing → **400**
   `Setup has no quality score at its detection anchor — score the setup before
   generating an alert.` The alert's `scoreId` / `scoreEngineVersion` /
   `qualityScore` / `qualityGrade` all come from that row.
4. **`minQualityScore` gate** — the version's `risk.minQualityScore` (default
   from the strategy config, `0` if absent) is compared against the stored
   score total. `total >= gate` passes; `total < gate` is **silence**: HTTP
   **200** with `{alert: null, created: false, skippedReason:
   'below_min_quality'}`, no alert row, no ledger row. A below-gate setup is a
   normal outcome, not an error.
5. **Trigger state** — the caller may pass `triggerState` (`confirmed` /
   `triggered`). Omitted → the setup's current state is used (already
   eligible). `triggered` requires the setup to actually be `triggered`
   (else **400**: no forward-looking alerts). `confirmed` remains valid once
   the setup has progressed to `triggered`, because triggered implies
   confirmed.
6. **Deterministic content** — `title` = `<SYMBOL> <direction> <triggerState>
   (score <total>/<grade>)`, capped at 280 chars; `body` is a structured
   payload (`setupId`, `strategyId`, `strategyVersionId`, `versionNumber`,
   instrument, direction, triggerState, qualityScore, qualityGrade,
   minQualityScore, entry/SL/TP1–3 prices, `scoreId`,
   `scoreEngineVersion`, `detectedAt`, `asOfMs`). **Never raw candles** —
   licensing-safe by construction.
7. **Deduplication** — `UNIQUE (setup_id, trigger_state)` (0012). A setup can
   therefore produce at most two alerts: one `confirmed` and one `triggered`.
   A replay returns the existing alert (`created: false`) with its **original**
   `createdAt`, title and body; nothing is rewritten.
8. **Transactionality** — the alert row and its stub ledger row commit in one
   transaction. Concurrency is resolved by the database, not by
   check-then-insert: the loser of the alert insert reads the winner's row, and
   the ledger insert is idempotent on `(alert_id, channel, payload_hash)`.

## 3. Stub delivery ledger (zero external I/O)

`AlertSender` (`packages/core/src/alerts/sender.ts`) is the single delivery
boundary. M6 ships exactly one implementation:

- `StubAlertSender.channel === 'stub'`.
- `send()` renders `sha256(JSON.stringify(canonicalize({alertId, title, body})))`
  where `canonicalize` sorts keys recursively (arrays keep their order) and
  normalizes `Date` → ISO. No clock, no randomness, no I/O.
- It returns `{status: 'delivered', attempt: 1, payloadHash, error: null}`.

`AlertService` writes exactly **one** `alert_deliveries` row per alert with
that result, in the same transaction:

- The payload is rendered from the **persisted** alert (`title`/`body` read
  back from `alerts`), so a replay — or any later upstream change — hashes to
  the original value and can never mint a second ledger row.
- A replay does not call the sender at all: the existing ledger row is
  returned. The service also self-heals an alert that has no ledger row
  (a state the transactional write path cannot produce) by writing exactly one
  row, and reports `deliveryCreated: true` only when a row was actually
  inserted, so audit events stay truthful.
- `alert_deliveries` is append-only (`append_only_guard()` from 0007): rows are
  never updated or deleted.

**Hard rule:** `AlertService` refuses any sender whose channel is not `stub`
(`NonStubSenderError`) at construction time. Real email/webhook/push delivery
needs an outbox + worker, provider credentials and its own security review —
none of which exists in M6, and none of which can be switched on by
misconfiguration.

## 4. HTTP API

All routes are session-authenticated, owner-scoped with masked 404s,
Zod-validated (`strict()`), tiered rate limited, audited, and licensing-safe.

| Route | Limit | Notes |
| --- | --- | --- |
| `POST /api/setups/:setupId/alerts` | 20/min | Body `{triggerState?: 'confirmed' \| 'triggered'}` (strict). **201** when created, **200** on replay, **200** with `skippedReason` when gated, **400** state/score/validation, **401**, **404** masked, **429**. |
| `GET /api/alerts?strategyId?&status?&limit?` | global | Owner-scoped list, newest first (`limit` 1–100, default 50). |
| `GET /api/alerts/:id` | global | `{alert, deliveries}` (deliveries ≤ 64, oldest first). Foreign/unknown/malformed id → 404. |
| `POST /api/alerts/:id/acknowledge` | 60/min | Empty strict body. **200** idempotent; **404** masked; **429**. |

Generation response shape:

```jsonc
// 201 created
{ "alert": { /* AlertDto */ }, "deliveries": [ { /* AlertDeliveryDto, channel: "stub" */ } ], "created": true }
// 200 replay (same alert id + same ledger entry, never a second one)
{ "alert": { /* identical row */ }, "deliveries": [ /* identical entry */ ], "created": false }
// 200 gate skip (nothing written)
{ "alert": null, "created": false, "skippedReason": "below_min_quality" }
```

## 5. Acknowledgement

`POST /api/alerts/:id/acknowledge` is **idempotent**:

- The row is read `SELECT … FOR UPDATE` under the caller's ownership check.
- The first call performs exactly one `UPDATE` to `status = 'acknowledged'`
  with `acknowledged_at = now()`.
- Every repeat is accepted (`200`) and **writes nothing**: the original
  `acknowledgedAt` is preserved and returned unchanged. There is no duplicate
  state change, no extra ledger row, no re-delivery.
- Acks are audited per accepted request (`alert.acknowledged`), which is how
  the rate-limit/abuse signal stays visible.

## 6. Audit events

| Action | When | Metadata (selected) |
| --- | --- | --- |
| `alert.created` | this call inserted the alert | `setupId`, `triggerState`, `qualityScore`, `qualityGrade`, `minQualityScore`, `channel` |
| `alert.replayed` | dedup hit — the alert already existed | same, with `created: false` |
| `alert.delivery_recorded` | a **new** ledger row was written | `alertId`, `setupId`, `channel`, `status`, `attempt`, `payloadHash` |
| `alert.skipped` | `minQualityScore` gate refused generation | `reason`, `triggerState`, `qualityScore`, `qualityGrade`, `minQualityScore` |
| `alert.acknowledged` | every accepted acknowledge request | `setupId`, `triggerState`, `status`, `acknowledgedAt` |

A replay emits `alert.replayed` (never a second `alert.created`) and never a
second `alert.delivery_recorded`, so the audit log cannot be read as "two
deliveries happened".

## 7. Storage (0012, unchanged)

`alerts` stores owner, setup, strategy version, instrument, direction,
triggering state, the score snapshot, deterministic title (≤ 280) and the
structured body (levels + score reference — never raw candles); `status` is
mutable (`pending` → `acknowledged`). `UNIQUE (setup_id, trigger_state)`
dedupes. `alert_deliveries` is the append-only ledger, unique on
`(alert_id, channel, payload_hash)`. Both tables cascade with the setup and are
owner-scoped through `alerts.user_id`.

## 8. Web UI (M6 Phase 4)

Frontend only — `apps/web` consumes the endpoints above and adds no endpoint,
migration, service or delivery channel of its own.

| Route | Consumes |
| --- | --- |
| `/alerts` | `GET /api/alerts`, `GET /api/setups` (eligible states), `POST /api/setups/:setupId/alerts` |
| `/alerts/:id` | `GET /api/alerts/:id`, `POST /api/alerts/:id/acknowledge` |

- **List** — status/strategy filters, trigger state, quality score + grade,
  status, created and acknowledged times, per-row link to detail. Owner scope is
  the API's; the UI never infers ownership from an id.
- **Detail** — instrument/setup identity, trigger state, score and grade, the
  `minQualityScore` gate that allowed generation, levels from the structured
  body (read field-by-field, never dumped as raw JSON), the delivery ledger and
  acknowledgement.
- **Acknowledge** — the control is disabled while the request is in flight and
  stays disabled once the API reports `acknowledged`, mirroring the API's
  idempotency; re-acknowledging is reported as a no-op that kept the original
  timestamp.
- **Generate** — the three outcomes are rendered distinctly: `created` (a new
  alert), `created: false` with an alert (the existing dedup winner — "alert
  already exists"), and `alert: null` with `skippedReason: 'below_min_quality'`
  ("no alert generated"). 400s (terminal/ineligible state, missing score at the
  detection anchor) and 429s are surfaced with the API's own message. Setups in
  a non-eligible state show a disabled action with the reason.
- **Stub-delivery messaging** — every alert surface states that delivery is a
  local stub ledger record and that no email, webhook, push, SMS or broker
  notification is sent. There is no notification-provider configuration
  anywhere in the UI, because none exists in M6.

## 9. What M6 does NOT do (still)

No real alert delivery (email/webhook/push),
no vendor SDKs, no new secrets or environment variables, no
scheduler/worker/queue/cron/background job/polling/scanner, no AI, no billing,
no trade execution (M8), no second market-data provider, and no Twelve Data
credential requirement — alerts work with no provider registered at all.

## 10. Future channel/provider architecture

Real delivery is additive and deliberately deferred:

1. Implement `AlertSender` for the channel (`channel: 'email' | 'webhook' |
   'push'`), keeping `send()` a pure function of the persisted alert.
2. Inject it where `AlertService` is constructed and relax the M6
   `NonStubSenderError` guard in the same reviewed change.
3. Move the send out of the request transaction into an outbox + worker
   (the ledger already records `attempt`, `status`, `error`, `payload_hash`,
   and the channel CHECK already accepts the new values — no migration).
4. Add the provider credentials as platform secrets, plus the security review:
   per-channel redaction, retry/backoff, and delivery-rate limits.

Until then, the honest statement is: **M6 "delivery" is a local ledger entry,
not a notification.**
