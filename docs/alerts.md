# Setup Alerts (M6, Phases 1 & 2)

M6 alerts notify an owner when one of their setups reaches an actionable
state with sufficient quality. Like M4 detection and M5 scoring, alert
generation is **invoked explicitly, never automatic**: there is no
scheduler, scanner, queue, or background worker.

Phase 1 covers the versioned contracts (`@veltrixeye/contracts`) and the
alert + delivery tables (`0012_alerts.sql`). Phase 2 adds `AlertService`
and the HTTP surface (`/api/setups/:setupId/alerts`, `/api/alerts`).
There is still no real delivery, no vendor SDKs, no email/webhook/push
sending, no new env vars, no scheduler/worker/queue/cron/background.

## What Phase 1 does

- Defines lifecycle: alert generated from one owned setup when (1) setup is
  in eligible state (`confirmed` or `triggered`), (2) M5 score exists at
  detection anchor, (3) score total ≥ version's `risk.minQualityScore`.
- Deduplicates by `(setup_id, trigger_state)`: at most two alerts per setup.
- Status `pending` → `acknowledged` | `suppressed`, with `acknowledged_at`.
- Records delivery attempts in append-only `alert_deliveries` ledger with
  `channel`, `status`, `attempt`, `error`, `payload_hash` (sha256).

## What Phase 2 adds

`AlertService` (`packages/core/src/alerts/service.ts`) is the only writer
of `alerts` / `alert_deliveries`:

### Generation (pinned order)

1. **Owner + eligible state**: setup must exist, belong to caller
   (via `strategies.user_id`), and be in `confirmed` or `triggered`.
   Other states → 400 `Setup is in state "..."`. Foreign → masked 404.
2. **M5 score required**: `setup_scores` row at `setup.as_of_ms`
   (detection anchor) must exist, else 400 `has no quality score`.
3. **Quality gate**: load version config via `StrategyService.getVersion`
   (owner-scoped) and compare `score.total` against
   `config.risk.minQualityScore` (default 0). If below gate, return
   `{alert:null, delivery:null, created:false, skippedReason:
   'below_min_quality'}` — silence, no row, no delivery, HTTP 200 with
   `skippedReason`. Not an error.
4. **Trigger state**: caller may pass `triggerState` (`confirmed` |
   `triggered`). If omitted, effective = setup's current state. If
   `triggered` requested but setup is only `confirmed` → 400 logical
   progression error. `confirmed` alert allowed when setup is `triggered`
   (triggered implies confirmed past).
5. **Deterministic content**: `title` ≤280 chars, e.g.
   `EURUSD long confirmed (score 82/A)`. `body` structured payload
   `{setupId, strategyId, strategyVersionId, versionNumber, instrument,
   direction, triggerState, qualityScore, qualityGrade, minQualityScore,
   entryPrice, stopLossPrice, tp1/2/3Price, scoreId, scoreEngineVersion,
   detectedAt, asOfMs}` — never raw candles, licensing-safe.
6. **Transactional idempotency**: `INSERT INTO alerts ... ON CONFLICT
   (setup_id, trigger_state) DO NOTHING`. Winner inserts; losers re-select.
   Exactly one `stub` delivery per generated alert:
   `INSERT INTO alert_deliveries (alert_id, channel='stub',
   status='delivered', attempt=1, payload_hash) ON CONFLICT (alert_id,
   channel, payload_hash) DO NOTHING`. Concurrent identical submissions
   collapse to one alert + one delivery; `created` flag tells caller.
7. **Local/no-network**: no provider, no email/webhook SDK, no fetch.
   Payload hash = `sha256(JSON.stringify(canonicalize({alertId,title,body})))`
   where `canonicalize` sorts keys recursively, Date→ISO. Deterministic stub.

### Listing & detail

- `listAlerts({userId, strategyId?, status?, limit})` — owner-scoped,
  newest first, joins `instruments` + `strategy_versions` for DTO enrichment.
- `getAlert({userId, alertId})` — returns `{alert, deliveries}` (deliveries
  up to 64, ordered by id). Masked 404 if not owned.

### Acknowledgement

- `acknowledgeAlert({userId, alertId})` — `SELECT ... FOR UPDATE`,
  `UPDATE alerts SET status='acknowledged',
  acknowledged_at=COALESCE(acknowledged_at, now()) WHERE id=$1`.
  Idempotent repeated ack preserves first `acknowledgedAt`. Returns detail
  DTO. Owner-scoped, masked 404.

### Invariants preserved

- No real delivery: only `channel='stub'` inserted; `email`/`webhook`/`push`
  reserved in schema but never written by service. No network I/O.
- No `setups` / `setup_scores` / `setup_state_events` mutation.
- Safe DTOs: no raw candles, no secrets.
- Deterministic stub: same alert id + title + body → same payload hash.

## HTTP API (Phase 2)

All routes session-authenticated, owner-scoped masked 404, Zod-validated,
audited, licensing-safe.

- `POST /api/setups/:setupId/alerts`
  Body: `{triggerState?: 'confirmed'|'triggered'}` (strict).
  Rate limit 20/min. Returns `{alert, delivery, created, skippedReason?}`.
  200 when `created=false` or skipped (gate), 201 when created. Errors:
  400 state/gate/score/validation, 401 auth, 404 masked foreign setup,
  429 rate limit.
  Audit: `alert.generated` with `setupId, triggerState, qualityScore,
  minQualityScore, created, skippedReason?`; `alert.delivery_recorded`
  on delivery insert.

- `GET /api/alerts?strategyId?&status?&limit?` — list owned alerts.

- `GET /api/alerts/:id` — detail `{alert, deliveries}`.

- `POST /api/alerts/:id/acknowledge`
  Rate limit 60/min (higher than generate). Idempotent. Returns detail.
  Audit: `alert.acknowledged` with `alertId, setupId, triggerState`.

Error mapping: 400 invalidInput (state, score missing, gate logic),
401 unauthenticated, 404 masked foreign, 422 Zod, 429 rate limit.

Rate limits tiered: generate 20/min, acknowledge 60/min.

## What M6 does NOT do (still)

No UI (Phase 4), no real alert delivery/email/webhook/push, no vendor SDKs,
no new secrets/env vars, no scheduler/worker/queue/cron/background job/
polling, no AI, no billing, no second market-data provider, no Twelve Data
credential requirement.

## Storage (0012)

`alerts` stores owner, setup, strategy version, instrument, direction,
triggering state, score snapshot, deterministic title (≤280), structured body
(levels, score ref — never raw candles), mutable status. Uniqueness
`(setup_id, trigger_state)` dedupes. `alert_deliveries` is append-only
(`append_only_guard()` trigger reused); ledger rows never updated/deleted.
Uniqueness `(alert_id, channel, payload_hash)` makes stub delivery idempotent.
Both tables owner-scoped, cascade with setup.
