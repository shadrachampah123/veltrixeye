# Milestone Boundaries

This repository currently contains **Milestones M1 + M2 + M3 + M4 + M5,
M6 Phases 1–4, M7.1, M7.2, M7.3, M7.4, M7.5, M8.1, M8.2, M8.3, M8.4, M8.5,
M8.6 and M8.7**. The boundaries below
are deliberate and enforced: M1 shipped foundations and contracts; M2 added real historical
market data; M3 added deterministic strategy evaluation; M4 added
deterministic setup detection and lifecycle management; M5 added
deterministic setup quality scoring; M6 Phases 1–3 add the backtest
engine/service and explicit setup alerts with a **stub-only** delivery
ledger; M6 Phase 4 adds the backtest and alert surfaces in the web app; M7.1
adds the core browser trading workflow (evaluate → detect → score →
transition → alert → acknowledge); M7.2 hardens the whole surface for
commercial readiness (reference-data protection, audit attribution,
credential-endpoint limiting, session hygiene). M8.3 adds an **internal,
deterministic paper execution simulator** — simulated fills and positions
only, no broker, no demo account, no live execution. Still, nothing that
schedules, streams, sends real notifications, or executes a real trade.

## M1 — delivered (Product Foundation & Architecture)

- **Monorepo & stack** — npm workspaces, TypeScript ESM, Fastify 5 API,
  Next.js 15 web shell, plain `pg`, zod, embedded Postgres for dev/test.
- **Database foundation** — 7 migrations with indexes, FKs, uniqueness and
  timestamps; idempotent, non-destructive, run at boot and in tests.
- **Auth foundation** — argon2id password hashing, server-side hashed
  sessions, owner-scoped authorization boundary, no user enumeration.
- **User/account model** with SaaS-tier readiness (`free`/`pro`/`premium`
  column) — **no billing**.
- **Strategy domain model** — User, Strategy, StrategyVersion,
  StrategyCondition, RuleGroup, Timeframe, MarketScope, SessionFilter,
  RiskConfiguration, FilterConfiguration.
- **Extensible condition registry** — 19 types, 4 classifications, code
  not DB-enum (additive, no fragile list).
- **Immutable, traceable versioning** — enforced at service + DB-trigger +
  append-only layers.
- **Multi-timeframe roles** — assigned, never hard-coded.
- **Provider abstraction** — interfaces + empty registry + normalized
  instrument model; **no provider implemented**.
- **Quality-score foundation** — 0–100 bands + `qualityGrade`; **no
  scoring logic**.
- **Setup-lifecycle foundation** — 8 states + append-only events/scores;
  **no scanner**.
- **Risk-config foundation** — min RR 1:2, SL/TP, min quality; **no engine**.
- **Security baseline** — helmet headers, rate limiting, audit log, strict
  input validation, same-origin web↔API.
- **UI shell** — auth, dashboard, strategy list/create/edit, settings.
- **Production deployment target for the API** — `Dockerfile` (multi-stage,
  non-root, pinned by the lockfile) plus a `render.yaml` Blueprint declaring
  the Docker web service, its health check and its environment; the production
  web app reaches the API through the same-origin `/api` rewrite configured by
  `API_INTERNAL_BASE`. Migrations apply at boot under a Postgres advisory
  lock (or explicitly via `npm run db:migrate`), and
  `GET /api/health/ready` reports database connectivity **and** migration /
  schema state. Runbook: [deployment.md](./deployment.md).
- **Documentation** — 11 topics (this directory).
- **Automated tests** — 77 passing (contracts 20, core 30, api 27) plus
  clean typecheck, lint and production build.

## M2 — delivered (Historical Market Data)

- **First real provider** — `packages/providers/twelve-data` implements
  `MarketDataProvider` (historical OHLCV; `realtime: false`), registered at
  boot when `TWELVE_DATA_API_KEY` is set. All 14 canonical timeframes served
  (native vendor intervals + deterministic resampling for 3m/12h/3d).
- **8-instrument universe** — EURUSD, GBPUSD, USDJPY, XAUUSD, BTCUSD, ETHUSD,
  AAPL, SPY with provider-symbol mappings. `index/SPX500` keeps its M1
  identifier but is **excluded from ingestion** (S&P index licensing).
- **Global shared candle store** — migration 0008 (`candles` + ingestion
  ledger `ingestion_runs`); idempotent upserts, CHECK-enforced OHLC
  invariants, provenance per row.
- **Fetch-through reads** — `GET /api/market-data/candles` fills missing
  head/tail from the provider, persists, then serves from the store.
- **Explicit manual backfill** — `POST /api/market-data/backfill` (bounded,
  audited). **No scheduler/cron.**
- **Retention policy** — 1m 30d, 5m 90d, 15m 180d, 1h 1y, daily 5y
  (neighbors interpolate); enforced on read, backfill, and write-prune.
- **Coverage ledger** — `GET /api/market-data/coverage` (counts +
  earliest/latest per instrument × timeframe).
- **Markets UI** — provider status, coverage grid, candle viewer (UTC),
  manual backfill card, vendor attribution. No raw-data export.
- **Licensing verified + recorded** — [provider-licensing.md](./provider-licensing.md):
  storage, Venture+-gated commercial display, and non-reverse-engineerable
  derived signals are permitted; redistribution is not (and not shipped).
- **Provider-agnostic failures** — 502/429/400/404 mapping with no vendor
  internals leaked; unkeyed deploys boot and answer 502 on market routes.
- **Docs + deployment** — [market-data.md](./market-data.md), environment and
  deployment runbooks extended, `Dockerfile`/`render.yaml` carry the provider
  (key as a platform secret).
- **Automated tests** — 167 passing (contracts 27, core 54, provider 33,
  api 43, web 10) plus clean typecheck, lint and production build.

## M3 — delivered (Deterministic Strategy Evaluation)

- **Evaluation contracts** — `packages/contracts/src/evaluation.ts`: the
  evaluation request, per-condition/per-group/per-direction/per-instrument
  result DTOs, the deterministic `engineVersion`
  (`m3-deterministic-eval-1`), and scope caps — exported from the contracts
  index.
- **Pure indicator primitives** — `packages/core/src/strategies/evaluation/indicators.ts`:
  Wilder ATR, strict-fractal swing/pivot detection, candle anatomy,
  engulfing, ATR displacement, level touches, zones, order blocks, FVG,
  supply/demand, break/retest, HTF trend/structure classification, and UTC
  session windows — all pure functions, explicit edge cases, no clock, no
  I/O.
- **Condition handlers** — exactly one handler per one of the 19 registry
  types, keyed by `conditionType`; direction-sensitive types evaluated per
  direction; unknown types / invalid params → `unsupported`; short history →
  `insufficient_data`; `news_filter`/`spread_filter` **always fail closed**
  (no data source, never faked); the engine never silently passes.
- **Deterministic engine** — pure
  `(config, candlesByRole, asOfMs) → result`: group AND/OR under a top-level
  AND, `required`/`confirmation` must satisfy, `disqualifying` vetoes,
  `optional` reported only, fail-closed inside OR groups, per-direction
  outcomes, deterministic candidate entry/SL/TP for `rr_requirement`
  (LONG-convention levels; per-direction levels deferred to M4).
- **Evaluation service + API** — `POST
  /api/strategies/:strategyId/versions/:versionId/evaluate`: session auth,
  owner-scoped with masked 404s, **published versions only** (draft → 400),
  zod-validated `{ asOf? }` body, ≤ 50 instruments per evaluation, dedicated
  20 req/min rate limit, `strategy.evaluated` audit event, generic safe
  errors.
- **Store-only data access** — evaluation reads the shared candle store and
  **never triggers provider fetch-through**: it works identically with no
  provider key, and unseeded instruments answer 200 with
  `insufficient_data`. Explicit `asOf` anchor; only closed candles; no wall
  clock inside the engine (same inputs → byte-identical result).
- **Read-only guarantee** — evaluation writes nothing: zero rows in
  `setups` / `setup_scores` / `setup_state_events`, enforced by tests.
- **Docs** — [strategy-engine-contract.md](./strategy-engine-contract.md)
  rewritten to the implemented M3 semantics and the M3/M4 boundary.
- **Automated tests** — 253 passing (contracts 27, core 106, provider 33,
  api 77, web 10) plus clean typecheck, lint and production build.

## M4 — delivered (Setup Detection)

- **Detection contracts** — `packages/contracts/src/detection.ts`: the
  eight repo-defined lifecycle states, the explicit transition table, the
  pinned `detectorVersion` (`m4-setup-detect-1`), detection/transition/list
  zod schemas, and setup/event/detection response DTOs — exported from
  the contracts index.
- **Setup detection service** — `SetupService` consumes the M3
  `EvaluationService` (never condition logic of its own): ownership
  masking, published-only (deprecated detects, matching M3), and
  store-only reads are all inherited. Qualifying directions (`passed`)
  persist exactly one `confirmed` setup plus one `NULL → confirmed` event;
  anything else writes nothing and returns the M3 failure reasons.
- **Per-direction levels** — long setups keep the M3 LONG-convention
  candidate; short setups mirror every leg around the entry (same risk
  distance, stop above, targets below) via the pure `detectionLevels`
  function; null/degenerate candidates degrade to nulls, never fabrications.
- **Explicit state machine** — forward chain plus
  invalidated/expired exits from every non-terminal state; terminal states
  absorbing. Every transition validates first, runs under
  `SELECT … FOR UPDATE` in a transaction, and records exactly one event;
  invalid transitions roll back with zero partial writes.
- **Idempotency** — migration 0009 adds `as_of_ms` plus
  `UNIQUE (strategy_version_id, instrument_id, direction, as_of_ms)`;
  repeats return the existing setup and concurrent duplicates serialize on
  the constraint (one setup, one event per key, proven by tests).
- **Determinism** — `asOf` is required on every detection/transition call;
  no `Date.now` exists anywhere in the M4 decision path. Same version +
  instrument + direction + anchor + candles ⇒ same setup.
- **Setup API** — `POST …/versions/:versionId/detect` (20 req/min,
  `setup.detected` audit), `GET /api/setups` (owner-scoped filters),
  `GET /api/setups/:setupId` (setup + lifecycle history), and
  `POST /api/setups/:setupId/transitions` (60 req/min,
  `setup.transitioned` audit); foreign/malformed ids are masked 404s.
- **No scoring, no providers, no scheduler** — `setup_scores` is never
  written and `quality_score` stays NULL (M5 owns scoring); M4 performs no
  provider call and detection is explicitly invoked (no cron/workers).
- **Docs** — [setup-detection.md](./setup-detection.md) specifies the
  implemented M4 semantics and the M4/M5 boundary.
- **Automated tests** — 295 passing (contracts 37, core 116, provider 33,
  api 99, web 10) plus clean typecheck, lint and production build.

## M5 — delivered (Setup Quality Scoring)

- **Scoring contracts** — `packages/contracts/src/scoring.ts` extended on
  the M1 foundation (grade bands, `qualityGrade`, `ScoreComponent`,
  `QualityScoringEngine`): the pinned engine version
  `m5-quality-score-1`, score/history/request zod DTOs, and the typed M5
  scoring context (M3 direction evaluation + `minRr` + anchor).
- **Deterministic engine** — pure
  `(direction evaluation, minRr, asOfMs) → score` in
  `@veltrixeye/core`: seven pinned components whose weights sum to 100
  (required 25, confirmation 15, disqualifier clearance 20, optional
  support 15, directional alignment 10, setup completeness 10, data
  sufficiency 5); gate components treat "none declared" as vacuously
  clear, evidence components award nothing for absence of declaration;
  directions that do not pass their M3 evaluation are capped at 64
  (grade `ignore`), so insufficient data can never manufacture quality.
  No clock, no randomness, no I/O inside scoring logic.
- **Idempotency key** — additive migration **0010** adds
  `setup_scores.as_of_ms` + `UNIQUE (setup_id, engine_version, as_of_ms)`;
  concurrent duplicates serialize via `INSERT … ON CONFLICT DO NOTHING`
  (the conflict path never aborts a transaction); replays return the
  stored row without re-evaluating. Migrations 0001–0009 untouched.
- **Scoring service + API** — `ScoringService` rebuilds the context
  through the existing M3 `EvaluationService` (ownership masking,
  published-only, store-only reads — never a provider); terminal setups
  are refused, never mutated. `POST /api/setups/:setupId/score`
  (20 req/min, `setup.scored` audit) and
  `GET /api/setups/:setupId/scores` (append-only history); both
  session-authenticated with masked 404s.
- **Append-only persistence** — score row + `setups.quality_score`
  refresh commit atomically; history rows are never updated or deleted
  (0007 trigger); scoring never transitions a setup (M4 owns lifecycle).
- **Robustness fix in M4's duplicate path (semantics unchanged)** — M4's
  `insertOrGetSetup` now resolves detection-key races with
  `ON CONFLICT DO NOTHING` instead of catching `23505`: under load the
  error-based path could rarely leave a pooled client in an aborted
  transaction (flaky 500s, pre-existing and reproduced on the M4-only
  tree). Observable behaviour is identical — one setup and one event per
  key, losers return the winner's row — and all M4 tests remain green.
- **Docs** — [setup-scoring.md](./setup-scoring.md) specifies the pinned
  formula, missing-data rules, idempotency, API, and the M4/M5/M6
  boundaries.
- **Automated tests** — 341 passing (contracts 45, core 138, provider 33,
  api 115, web 10) plus clean typecheck, lint and production build.

## M6 Phases 1–4 — delivered (Backtests + Setup Alerts, explicitly invoked)

M6 has four planned phases, all delivered. Nothing in M6 runs automatically: there is **no scheduler, scanner,
worker, queue, cron, polling loop or background job** anywhere in the API or
core packages, and no real alert delivery of any kind.

### Phase 1 — contracts + migrations (PR #10)

- **Backtest contracts** — `packages/contracts/src/backtest.ts`: pinned engine
  version `m6-backtest-1`, bounds, exit/cost policies, run/trade/metrics DTOs.
- **Alert contracts** — `packages/contracts/src/alerts.ts`: statuses
  (`pending`/`acknowledged`/`suppressed`), eligible trigger states
  (`confirmed`/`triggered`), channels (`stub` + reserved
  `email`/`webhook`/`push`), delivery statuses, the skipped reason
  (`below_min_quality`), request/response/DTO schemas.
- **Migrations 0011 (backtests) + 0012 (alerts)** — additive only; 0001–0010
  untouched. `0012` adds `alerts` (dedup `UNIQUE (setup_id, trigger_state)`,
  owner/strategy indexes, status + score CHECKs) and the append-only
  `alert_deliveries` ledger (idempotency key
  `(alert_id, channel, payload_hash)`, reusing `append_only_guard()`); no
  migration changed in Phase 3.

### Phase 2 — services + API (PR #11)

- **Pure backtest engine** (`runBacktest`) with a canonical `config_hash`, plus
  `BacktestService` (store-only, owner-scoped, idempotent, bounded) and
  `POST/GET /api/backtests*` (20/min, audited, masked 404) —
  see [backtesting.md](./backtesting.md).
- **`AlertService`** (`packages/core/src/alerts/service.ts`) and the alert HTTP
  surface — see [alerts.md](./alerts.md).

### Phase 3 — stub delivery boundary + lifecycle correctness (this change)

- **`AlertSender` + `StubAlertSender`** (`packages/core/src/alerts/sender.ts`):
  the single delivery boundary, rendering a deterministic sha256 payload hash
  locally. `AlertService` **refuses any non-`stub` sender at construction**
  (`NonStubSenderError`), so real email/webhook/push delivery cannot be enabled
  by configuration, environment variable or a one-line wiring change.
- **Pinned generation gates** (order enforced and tested): ownership + masked
  404 → eligible state (`confirmed`/`triggered`; terminal states get a
  dedicated 400, pre-confirmation states get the state message) → required M5
  score at the detection anchor (400) → `risk.minQualityScore` gate (silent
  200 + `skippedReason: 'below_min_quality'`, no rows) → trigger-state
  progression rule.
- **Replay-safe ledgering**: the delivery payload is rendered from the
  **persisted** alert, so a replay (or any later upstream change) can never
  mint a second `alert_deliveries` row, and the sender is not even called on a
  replay. A missing ledger row is repaired exactly once and reported via
  `deliveryCreated`, so audit events stay truthful. Replay returns the
  original alert, title, body and `createdAt`.
- **Accurate audit events**: `alert.created`, `alert.replayed`,
  `alert.delivery_recorded` (only on a real ledger insert), `alert.skipped`
  (with score/grade/gate context) and `alert.acknowledged`.
- **Idempotent acknowledgement**: one `UPDATE` on the first call; repeats are
  accepted no-ops that preserve the original `acknowledgedAt`, with no extra
  ledger or state rows.
- **Tiered rate limits**: generation 20/min, acknowledgement 60/min, both with
  boundary 429 tests; a 429 writes nothing.
- **Zero external I/O** is proven, not asserted: API and core tests spy on
  `fetch`/`http`/`https`/`tls`/`dns`/`net` and verify a full
  generate → acknowledge flow touches only the local Postgres pool (the spy's
  liveness is checked with a deliberate local probe).
- **Docs** — [alerts.md](./alerts.md) rewritten for the Phase 3 semantics
  (gates, stub-only delivery, acknowledgement, audit events, future channel
  architecture) and [security.md](./security.md) extended with the alert rate
  limits, audit events and the stub-only delivery guarantees.
- **Automated tests** — 457 passing (contracts 68, core 187, provider 33,
  api 159, web 10) plus clean typecheck, lint and production build. The alert
  suite alone covers authentication, owner isolation, masked 404, eligible and
  terminal states, the missing-score 400, the `minQualityScore` boundary, dedup,
  8-way concurrent generation, ledger invariants, the defensive repair path,
  acknowledgement idempotency, rate limits, audit accuracy, zero network I/O,
  absence of stray DB writes, and non-collapse of distinct setups/triggers.

### Phase 4 — backtest + alert UI (this change)

Frontend only: `apps/web` consumes the Phase 2/3 API and adds **no endpoint,
migration, service, provider or delivery channel**.

- **Backtests** — `/backtests` (history, strategy filter), `/backtests/new`
  (published-version + instrument + range + exit/cost/sizing inputs, built from
  the shared `backtestRequestSchema`), `/backtests/:id` (run summary, metrics,
  engine notes, truncation indicators, trade table with paging).
- **Alerts** — `/alerts` (list, status/strategy filters, explicit generation
  from an owned setup) and `/alerts/:id` (trigger state, score/grade, delivery
  ledger, idempotent acknowledgement).
- **Outcome honesty** — a backtest replay (`created: false`) is labelled as a
  replay; an alert dedup replay is "alert already exists"; a
  `below_min_quality` gate result is "no alert generated". None of the three is
  presented as a new result.
- **Stub-delivery messaging** — every alert surface states that delivery is a
  local stub ledger record and that no email, webhook, push, SMS or broker
  notification is sent; there is no notification-provider configuration in the
  UI, because none exists in M6.
- **Authorization** — unchanged and enforced by the API: every list is
  owner-scoped, foreign/unknown ids stay masked 404s, and no page infers
  ownership from a URL id.
- **Docs** — [backtesting.md](./backtesting.md#web-ui-m6-phase-4) and
  [alerts.md](./alerts.md#8-web-ui-m6-phase-4) gained a Phase 4 UI section.
- **Automated tests** — 531 passing (contracts 68, core 187, provider 33,
  api 160, web 83) plus clean typecheck, lint and production build. The 73 new
  web tests cover form defaults/validation, the submitted request body against
  the shared contract, metric and trade rendering (including null metrics and
  truncation), history/detail, alert list/detail, the created / replayed /
  skipped outcomes, acknowledgement idempotency, the API client's request
  shapes and error copy, and the truthfulness of the stub-delivery wording.

## M7.2 — delivered (Commercial Readiness Hardening)

M7.1 (PR #14) delivered the core browser workflow
(evaluate → detect → score → transition → alert → acknowledge, frontend
only). M7.2 is the hardening pass over the whole M1–M7.1 surface: every
finding below was **verified against the current code** before changing
it; the rest of the audit surface (authorization/owner scoping,
server-side validation, state-machine and idempotency behaviour, error
handling, rate-limit pinning, production env handling, stub-only
delivery) was re-verified and already met the bar, so it is unchanged.

- **Platform-managed `instruments` table** — a strategy version may only
  *reference* instruments that already exist in the shared platform
  universe. The previous upsert let any user create new instrument rows
  (which then appeared in every other user's scope-`all` evaluations and
  market lists) and rewrite a platform instrument's `display_name` for
  everyone. Unknown symbols are now rejected with a 400 at version write
  time; user-supplied `displayName` no longer mutates the shared table.
- **Audit attribution on strategy lifecycle events** — `strategy.created`,
  `strategy.updated`, `strategy.deleted`, `strategy.version_created`,
  `strategy.version_updated`, `strategy.version_published` and
  `strategy.version_deprecated` now record the acting request's IP and
  user agent (previously NULL, unlike every other audit event). A
  `strategy.updated` event is also written now (the update route
  previously audited nothing).
- **Password-change rate limit** — `POST /api/users/me/password` (a
  credential endpoint: it verifies the current password) is limited to
  5/min per IP, like login and register (previously only the global
  300/min applied).
- **Session hygiene** — expired sessions are deleted at API boot
  (`runStartupHousekeeping`; the platform runs no scheduler by design),
  and the per-user session list is capped at 100 newest sessions plus the
  caller's current session whenever it would otherwise be cut off, so
  `GET /api/users/me` stays bounded while the user can always see and
  revoke their own device.
- **No schema change**: all four fixes are additive at the service/route
  layer; migrations 0001–0012 are untouched.
- **Docs** — [security.md](./security.md) (rate limits, session hygiene,
  reference-data protection, audit attribution).
- **Tests** — `apps/api/test/commercial-hardening.test.ts` (11 tests:
  pollution attempts, display-name overwrite, unknown-symbol swap,
  legitimate workflow, cross-user isolation, unauthenticated access, audit
  IP/UA for create/update/publish/delete, the 5-then-429 password boundary
  with a separate-IP control, housekeeping, and the bounded
  current-inclusive session list) plus core service-level regressions for
  the instrument guard and the session cap/cleanup.

## M7.3 — delivered (Alert Delivery Infrastructure)

M7.3 makes alert delivery reliable, observable, retryable and extensible
**without** coupling the strategy engine (or the alert service) to any external
notification provider. Alert generation still performs zero external I/O: it
writes a durable outbox row in the same transaction as the alert, and a worker
delivers it. Full design: [notification-delivery.md](./notification-delivery.md).

- **Durable outbox** — migration `0013_notification_outbox.sql` adds
  `notification_deliveries`: one job per `(alert_id, channel)` (UNIQUE) plus a
  UNIQUE `idempotency_key`, with `attempts <= max_attempts` as a CHECK, the
  rendered payload stored verbatim, the recipient snapshotted from
  `users.email`, provider receipt columns, `failure_category`, `last_error`,
  `next_attempt_at` and a `locked_at`/`locked_by` lease.
- **Idempotent by construction** — a replayed generation request, a retried
  HTTP call, a concurrent twin, a crashed worker and a second worker process all
  collapse onto the one row (`ON CONFLICT DO NOTHING` +
  `FOR UPDATE SKIP LOCKED` claiming + a stable per-job `Message-ID` so a
  receiver can suppress a duplicate caused by a provider timeout).
- **Worker** — `DeliveryWorker.runOnce()` (bounded batch): recover stale →
  re-queue `unavailable` jobs whose provider is now configured → claim → send →
  record. Exponential backoff with deterministic per-job jitter, a bounded
  attempt budget, transient vs permanent vs timeout vs configuration
  classification, dead-lettering on exhaustion, and lease-based crash recovery
  (also run once at API boot).
- **Invocation that fits the platform** — an in-process ticker
  (`NOTIFICATION_WORKER_ENABLED`, default on, overlap-guarded, `unref`'d) AND a
  token-protected `POST /api/internal/notifications/deliveries/run` for an
  external scheduler (Render Cron Job). Both are safe to run at the same time;
  nothing depends on a process that may be asleep.
- **Provider abstraction** — `NotificationProvider` +
  `NotificationProviderRegistry`; the only adapter in this milestone is
  **email / SMTP** (`nodemailer`, no transitive dependencies), configured
  entirely through `SMTP_*` / `NOTIFICATION_FROM`. Unconfigured ⇒ jobs are
  recorded `unavailable`, never `delivered` — no fake success, no silent drop.
- **Security** — internal worker routes return **404** when no
  `NOTIFICATION_WORKER_TOKEN` is set, otherwise compare it in constant time
  (SHA-256 + `timingSafeEqual`) and accept only `batchSize` / retention days
  (ids, recipients, channels and payloads are 400s). Owner-scoped
  `GET /api/alerts/:alertId/notifications` returns status/attempts/category
  only — never a recipient, payload or provider error. Credentials stay
  server-side, are absent from `describe()`/logs, and are redacted out of
  stored provider errors.
- **Observability + cleanup** — every attempt is recorded on the row
  (attempt, status, provider, response code, failure category, redacted
  error, timestamps); structured worker log lines carry ids and categories
  only; `…/maintenance` recovers stale work, applies retention (delivered 30 d,
  failed 120 d — never pending/processing/unavailable) and reports queue depth.
- **Unchanged M6/M7.1/M7.2 behaviour** — `AlertSender`/`StubAlertSender`, the
  `NonStubSenderError` guard, the stub ledger row, the generation gates, dedup,
  acknowledgement idempotency, the generate response schema and the web copy
  are all untouched; every pre-existing test still passes (two assertions in
  `packages/core/test/m6-migrations.test.ts` were updated for the longer
  migration chain: `expectedCount` 12 → 13, `latestApplied` → `0013`).
- **Tests** — **690 passing** (contracts 73, core 229, provider 33, api 188,
  web 167) vs 630 before the milestone (+5 contracts, +38 core, +17 api);
  clean typecheck, lint and production build. New suites:
  `packages/contracts/test/notifications.test.ts`,
  `packages/core/test/notification-outbox.test.ts` (29 tests: enqueue
  idempotency, transactional enqueue, SKIP LOCKED claiming, delivery,
  backoff, budget exhaustion, permanent failure, timeout de-duplication, stale
  recovery, concurrent workers, unavailable/re-queue, retention, rendering,
  redaction), `packages/core/test/m7-notification-migrations.test.ts`
  (9 schema tests) and `apps/api/test/notifications.test.ts` (17 HTTP tests:
  one job per alert, replay, no in-request delivery, zero I/O, owner scoping,
  token protection, run/maintenance endpoints, credential hygiene).

## M7.4 — delivered (Subscription / Entitlement Foundation)

- `subscriptions` table (migration 0014) with plan/status/period and provider
  id columns; unique per user; backfilled from the M1 `users.plan` column.
- Server-authoritative `getEntitlements(plan, status)`: Free/Pro/Premium
  limits (strategies, backtests/month, alerts/month, saved setups) plus
  `canAccessScanner`, advanced-strategy/alert placeholders and
  `canAccessAutomation` (false for every plan).
- Atomic limit enforcement (`SELECT … FOR UPDATE` on the subscription row)
  for strategies, setups and alerts; route-level backtest limit.
- `GET /api/billing/me` read-only surface; **no mutation path exists** — a
  client cannot change plan, status or limits. Billing provider integration
  is a later milestone.

## M7.5 — delivered (Live Scanner / Production Market Flow)

Production scanner over real Twelve Data market data through the full
pipeline (normalization → validation/freshness → M4 detection → M5 scoring →
quality-gated alerts → notification outbox). Advisory locking, cursors,
four-layer dedup, stale-data policy, restart recovery, entitlement-gated API
and the `/scanner` UI. Full design: [scanner.md](./scanner.md).

## M8.1 — delivered (Automated Trading Execution Architecture)

Execution **architecture and safety boundary only** — no broker, MT5 or
Exness connectivity; no real, demo or simulated order can be placed.

- Domain model: execution profiles, idempotent execution requests, order and
  position schemas, append-only execution audit trail, kill switches,
  explicit automation switch (`users.automation_enabled`, default OFF).
- Live execution impossible by construction (service refusal + DB CHECK);
  no credentials modeled anywhere.
- Provider abstraction (`ExecutionProvider`) with normalized failure
  taxonomy; exactly one provider registered (paper), which in M8.1 reports
  not-ready and refuses every trading operation (the internal simulator
  shipped later, in M8.3, behind the same boundary).
- Pinned order state machine with absorbing terminals; invalid transitions
  rejected.
- 15 ordered safety gates, fail-closed; in M8.1 the risk-decision and
  exposure gates can never pass, so no intake can be accepted.
- Idempotency from stable derived identity (user + setup + profile +
  action), enforced by unique constraints.
- Read/status API surface + `/trading` readiness page; no order-placement
  endpoint exists. Full design: [execution.md](./execution.md).

## M8.2 — delivered (Risk Management Engine)

Central server-side risk engine that produces the decision M8.1's
`risk_decision` / `exposure_limits` gates consume. Full design:
[risk.md](./risk.md).

- Deterministic, fail-closed engine (`m8.2-risk-engine-1`): account risk,
  trade-requirement checks, UTC session controls, strategy tighten-only
  overrides, position sizing, RR (floor 1:2), daily/weekly/consecutive
  loss limits, open-exposure limits, optional correlation groups.
- Platform safety ceilings are immutable and CHECK-enforced; a user may
  only request a value inside the envelope.
- Server-issued decisions only — a client `{ approved: true }` is not a
  risk approval.
- Advisory-locked evaluation + reservations so concurrent twins cannot
  both pass on stale exposure.
- Read/bounded PATCH `/api/risk/policy` + decision history; Trading page
  risk panel. **No order is executed.** Automation stays OFF.

## M8.3 — delivered (Paper / Demo Execution Simulator)

An **internal, deterministic execution simulator**. Signals now travel the
whole pipeline inside the platform: strategy signal → risk engine →
execution decision → paper order → fill → position → SL/TP → P&L →
reconciliation. Full design: [execution.md](./execution.md).

- **No broker, MT5, Exness or external trading API is contacted anywhere.**
  No credential is stored or accepted, and no live order can be created:
  the simulator's only market data is the platform's own `candles` table.
- Server-issued inputs only: a simulation request carries identifiers, and
  the server rebuilds the decision and calls the M8.2 risk engine before an
  order can exist. A client `{ approved: true }` (or price/size/P&L/state)
  is a 400.
- Deterministic fills on the M8.2 `Dec` bigint arithmetic: market BUY/SELL,
  long/short, full fills, adverse slippage, optional deterministic costs,
  SL exits, TP exits and explicit closes; first-touch SL/TP detection with a
  conservative stop-wins rule on a conflicted candle.
- Order lifecycle driven through the pinned M8.1 state machine; positions
  opened/closed with entry, exit, quantity, direction, fees, slippage and
  realized/unrealized/net P&L recorded server-side.
- Migration `0018_paper_execution.sql` (additive): order provenance +
  simulated-provenance CHECK, position exit/mark columns + exit-state CHECK,
  append-only `execution_fills` (exactly-once per order+sequence, unique
  idempotency key) and append-only `execution_reconciliations`.
- Idempotency preserved end to end: a repeated submission replays the
  stored result, repeated fill/close processing is a no-op, and no duplicate
  order or position is created.
- Reconciliation **foundation** for M8.5: expected-vs-simulated order and
  position state is compared, inconsistencies are recorded and fail closed —
  never silently corrected.
- Deterministic failure paths, all auditable: invalid or non-positive price,
  stale or missing market data, rejected order, fill failure, duplicate
  fill, SL/TP conflict, missing position, inconsistent state.
- API + UI: `/api/execution/paper/*` (status, simulate, orders, positions,
  fills, close, evaluate, reconciliations, reconcile) and a Trading-page
  paper panel showing simulated orders/positions, entry/exit, open and
  closed P&L and the reconciliation trail. **No live-trading control, no
  broker credential form, no MT5/Exness configuration, no demo-account
  connection.**
- Automation remains **OFF** for every plan (`canAccessAutomation` false on
  all tiers); the automated path is blocked at the entitlement gate.
- Paper results are simulations, not broker fills, and are not a guarantee
  of future performance.

## Explicitly NOT in M1–M8.3 (by design, deferred)

- Setup **realtime** updates (the scanner polls; no streaming).
- **Realtime streaming / WebSockets**; session calendar and market-state
  feeds (provider honestly reports gaps).
- **Channels other than email** (webhook, push, SMS/Telegram): M7.3 built the
  outbox, the worker and the provider boundary they plug into, and shipped the
  email adapter only. **TradingView integration** is likewise not built.
- **User notification preferences** (per-channel opt-in, quiet hours,
  per-strategy routing): deliberately not built in M7.3 — an alert goes to the
  owner's account email.
- **Automated trade EXECUTION against a broker** — M8.1 built the execution
  architecture and safety boundary, M8.2 the risk engine that feeds those
  gates, and M8.3 the internal paper simulator that exercises the whole
  chain. **No broker is contacted and no real or demo order can be placed**;
  automation stays OFF and alerts remain suggestions, never orders.
- **Operational broker/demo connectivity** — M8.4 provides the MT5 provider
  and disabled transport boundary only. A validated bridge and approved
  external secret-management integration remain future work.
- **Live reconciliation against a broker** — M8.5 delivered the
  provider-neutral machinery (runs, findings, snapshots, local resolution,
  uncertain-outcome preservation) against the providers that exist (paper);
  *broker-side* import and repair still await an operational transport, and
  **destructive corrective actions remain gated OFF by design**.
- **Billing integration** — M7.4 built the subscription/entitlement
  foundation; no payment provider, checkout, portal or webhooks exist yet.
- **AI** in the signal path — evaluation is deterministic rules; AI is
  never the core signal engine.
- **Marketplace** with paid plans or revenue sharing.
- **Second provider implementation** (EODHD approved as fallback, not built).
- **Raw-data export / redistribution** (needs an Enterprise/add-on license).
- **Production deployment hardening** (TLS termination, WAF, secret
  manager, least-privilege DB roles) — an operational task for deploy
  time, not a code deliverable.

## After M8.4 (historical outline)

M8.4 once closed the section with this outline: reconciliation (M8.5), safety
controls (M8.6), then channels/billing. Both M8 milestones were delivered as
described below; the superseded forward-looking list now lives in
[After M8.6](#after-m86-later-work-outline-only). Each milestone is additive —
no rewrite of the schema, contracts, or UI — and M8.6 continues that property:
safety controls were added alongside the existing gates, never inside them.

## M8.4 — delivered (Broker / MT5 Integration Boundary)

Provider-neutral broker contracts now cover normalized health, account and
instrument metadata, orders and positions. `MT5Provider` depends only on
`MT5Transport`; no hosting topology or vendor protocol is invented. Exness is
an example MT5 broker/server, not a separate engine.

- Production composition uses `DisabledMT5Transport`: MT5 reports unconfigured,
  unavailable and unhealthy. No real transport or broker connectivity is
  operational, and no successful response is fabricated.
- Paper and broker demo remain separate. Disabled demo metadata profiles and
  explicit canonical-to-broker symbol mappings are owner-scoped; no plaintext
  credentials or secret references are stored because a production broker
  secret manager does not yet exist.
- Broker constraints and quote freshness are additional fail-closed checks;
  risk-safe volume is never increased to satisfy a broker minimum.
- Stable client ids, pre-submit lookup, normalized errors, and explicit
  uncertain/lost-response handling prepare M8.5 reconciliation without blind
  retries.
- Safe authenticated provider/profile status and connection-test routes plus
  minimal Trading UI were added. There is no broker order route or live button.
- Defense in depth now pins 18 execution gates, ending with environment,
  broker, and account authorization. The original live-profile DB prohibition,
  provider hard-stop, automation OFF state, and `canAccessAutomation: false`
  all remain intact.

**M8.4 does not enable live trading.** M8.5 adds full reconciliation, M8.6
strengthens kill-switch/safety controls, and M8.7 is the earliest milestone
that may consider controlled live automation after all validation is complete.

## M8.5 — delivered (Order & Position Reconciliation)

Provider-neutral reconciliation of platform execution state against an
execution provider's actual order/position state. Full surface:
`packages/contracts/src/reconciliation.ts`,
`packages/core/src/execution/reconciliation*.ts`,
`/api/execution/reconciliation/*` and the Trading-page panel.

- Runs are **idempotent and concurrency-safe** (per-user/profile advisory
  locks), carry the pinned `m8.5-reconciliation-1` version and a persisted
  expected-vs-provider snapshot; matching is by **stable identifiers only** —
  never a guess, and ambiguous matches become findings instead of merges.
- Classifies mismatches with stable machine-readable codes (missing-order/
  position either way, status, quantity, direction, price, stale state,
  uncertain outcome, provider unavailable, tenant mismatch) and surfaces
  `synchronized` / `mismatch_detected` / `uncertain` / `provider_unavailable`
  / `manual_resolution_required` summaries.
- **Fail-closed recovery policy:** uncertain broker outcomes are never
  auto-rejected or blind-retried; M8.4's durable `execution_provider_intents`
  are reconciled, not discarded. Composition dispatches the owner-scoped paper
  snapshot provider for paper profiles; the disabled MT5 transport honestly
  reports `provider_unavailable`.
- Findings support **local resolution bookkeeping only** (`acknowledge` /
  `mark_resolved` / `ignore` with an audit note). Destructive correction —
  cancel/resubmit/close at the provider — is explicitly gated OFF.
- Migration `0020_order_position_reconciliation.sql` (additive):
  `reconciliation_runs`, `reconciliation_findings`, `reconciliation_snapshots`
  with tenant FKs, CHECK-enumerated statuses/codes, and indexes. **No
  credentials, no live path; automation stays OFF.**

## M8.6 — delivered (Kill-Switch & Safety Controls)

Strengthens the emergency-stop machinery M8.1 introduced into a full,
user-operable safety-control surface. Design: [execution.md](./execution.md)
§ “Safety controls (M8.6)”.

- **Provenance + history:** `kill_switches` records `source`
  (`operator | user | circuit_breaker`), the acting user and the activation
  moment; a new **append-only `kill_switch_events` ledger** records every
  change attempt — including redundant calls (`changed = false`) — with
  scope, target, resolved owner, actor, reason and source. A trigger stamps
  missing activation times, so even raw operator SQL keeps history honest.
- **User-facing kill-switch API:** arm/clear the account, any owned strategy,
  or any owned execution-profile switch with a REQUIRED reason
  (`/api/execution/safety/kill-switch/activate|clear`), an owner-scoped
  status read model, and switch history. Stopping never requires an
  entitlement; cross-tenant targets are masked 404s. The **global scope is
  never user-mutable** — service and schema both refuse it.
- **Deployment-level global switch:** `EXECUTION_GLOBAL_KILL_SWITCH=true`
  pins the platform-wide stop ON regardless of database state — every account
  fails gate 6 (automation) and the paper `kill_switch` gate, status/automation
  read models name the environment as the reason, and no API can clear the
  pin. It can only stop; it grants nothing.
- **Emergency stop:** one atomic call (advisory-locked) arms the user switch,
  forces `automation_enabled` OFF (the safe direction — always allowed) and
  disables every execution profile; mirrored into `audit_events` (ip
  attribution) and `execution_events`. Position exits and other
  risk-reducing actions deliberately remain available — a stop must never
  strand exposure.
- **Automatic loss-limit circuit breaker:** when the M8.2 risk engine rejects
  on a daily/weekly/consecutive-loss breach, the user kill switch is TRIPPED
  durably (source `circuit_breaker`) instead of the refusal being
  per-decision-only; explicit, reason-carrying clearing is required and the
  trip is idempotent (no reason overwrite, no event spam). The trip can never
  crash the risk call, and the breaker cannot be disarmed by user policy
  input (`risk_policies.circuit_breaker_enabled` is platform-owned).
- **Automation asymmetry hardened:** turning automation OFF is a safety
  control and is always allowed; turning it ON additionally refuses (409)
  while any kill switch is armed — the switch outranks any plan claim, and
  the entitlement guarantee (`canAccessAutomation: false` on every plan) is
  untouched.
- Migration `0021_safety_controls.sql` (additive; no prior constraint
  altered). Trading-page panel with arm/clear + confirmed EMERGENCY STOP +
  append-only history; UI can only ever add stops.
- **M8.6 changes no execution capability**: live execution remains impossible
  (0016 CHECK intact), no broker connectivity, no credentials, alerts remain
  suggestions.

## M8.7 — delivered (Advanced Risk Circuit Breakers & Safety Completion)

Completes the final M8 milestone with all remaining risk/safety controls.

- **Drawdown protection:** daily/weekly/maximum drawdown limits computed from authoritative internal account data (paper equity + cumulative realized P&L). Deterministic, fail-closed: missing/stale/uninitialized data produces `EQUITY_DATA_UNAVAILABLE` and refuses automation.
- **Configurable thresholds:** warning and hard-stop levels for each drawdown type. Safe defaults (daily 2%/3%, weekly 4%/6%, max 8%/10%); platform ceilings (daily ≤10%, weekly ≤15%, max ≤25%); CHECK constraints enforce warning ≤ hard-stop. User-editable within platform ceilings; cannot bypass global kill switch.
- **Circuit-breaker integration:** new codes `DAILY_DRAWDOWN_LIMIT`, `WEEKLY_DRAWDOWN_LIMIT`, `MAX_DRAWDOWN_LIMIT`, and `EQUITY_DATA_UNAVAILABLE` all trip the M8.6 circuit breaker (durable user kill switch with append-only event). Warnings surface in the safety status without tripping.
- **Safety status extended:** the safety panel now shows drawdown protection state (current account value, peak equity, drawdown percentages, warning/hard-stop active flags).
- **Migration 0022** (additive; no prior constraint altered): drawdown columns on `risk_policies` and `risk_account_states` (peak equity, daily high, weekly open, cumulative realized P&L, initialization flag).
- **M8.7 changes no execution capability**: live execution remains impossible (0016 CHECK intact), no broker connectivity, no credentials, automation OFF for every plan, DisabledMT5Transport disabled.

## M9.1 — delivered (Notification Preferences, Routing, Webhook Tenant Integrity, Durable Fairness)

Completes the second notification channel and preference system, plus durable fairness remediation.

- **Preferences:** `notification_preferences` table (owner-scoped, channel `email|webhook`, enabled, endpoint_url, signing_secret) + `notification_user_settings` (quiet hours start/end minute + timezone) + `strategy_notification_preferences` (per-strategy mute + channel routing, null = all enabled). Migration `0023_notification_preferences.sql` + `0024_notification_routing.sql`.
- **Webhook outbox:** `notification_webhook_deliveries` separate table (because `0013` email-only CHECK), with tenant integrity FKs composite `(alert_id,user_id)` and `(alert_id,strategy_id)` enforced in `0025_webhook_tenant_integrity.sql` via unique indexes on `alerts(id,user_id)` and `alerts(id,strategy_id)`.
- **Webhook provider:** `createWebhookNotificationProvider` with SSRF protection (`webhook-security.ts` HTTPS only, no URL creds, resolves all DNS, rejects private/loopback/link-local/multicast/reserved/special-purpose IPv4/IPv6 including IPv4-mapped IPv6, pinned address, no redirect, bounded deadline), HMAC `x-veltrixeye-signature` from per-destination signing secret, outcome mapping 2xx delivered, 408/429/5xx retryable, else permanent, timeout handling.
- **Durable fairness (remediation):** `notification_delivery_fairness` singleton table `0026` with `last_channel`, advisory lock `611_231_008` + `FOR UPDATE` + `FOR UPDATE SKIP LOCKED` claim, lifetime counters `email_claims, webhook_claims` added in `0027_notification_fairness_ledger.sql` (additive ALTER TABLE). Counters only grow inside claiming transaction, rollback-safe, immune to cleanup/cascade/retries/stale recovery/restart. Single-row and batch claims both use durable ledger, not `sum(attempts)`.
- **API:** `GET/PUT /api/notifications/preferences`, `GET/PUT /api/notifications/preferences/strategies/:strategyId`, owner-scoped, rate-limited 30/min, audit logged, DTOs never contain secrets.
- **Tests:** 1407-line `notification-outbox.test.ts` covering ledger byte-identical across cleanup/cascade, batch fairness durable, 5-round balanced, worker-id bias, retries/stale no disturb, 4-way concurrent, invalid limits, rollback, plus `m91-migrations.test.ts` fresh 27 and upgrade 0022→0027.
- **Production:** verified `https://veltrixeye-api.onrender.com/api/health/ready` → `applied 27 expected 27 latest 0027_notification_fairness_ledger.sql pending [] checksumsMatch true`.

## M9.2 — delivered (Push Channel + Preferences UI + Secret Hardening + 3-Way Fairness)

Extends M9.1 with third channel, UI, and application-level secret encryption at rest.

- **Contracts:** `NOTIFICATION_CHANNELS = ['email','webhook','push']`, max channels 2→3 in `notificationPreferencesResponseSchema`, `notificationPreferencesRequestSchema`, `strategyNotificationPreferenceSchema`, `strategyNotificationPreferenceRequestSchema`. New strict schemas `pushSubscriptionKeysSchema` (`p256dh` base64url 20-512, `auth` base64url 10-512), `pushSubscriptionSchema` (`endpoint` https URL max 2048 + keys), `pushSubscriptionRequestSchema`, `vapidPublicKeyResponseSchema`. No generic unvalidated JSON blob, secrets excluded from response DTOs.
- **Secret management:** `SecretManager` abstraction `packages/core/src/notifications/secret-manager.ts` — AES-256-GCM, 32-byte key `WEBHOOK_SECRET_ENCRYPTION_KEY` (base64 32B), random IV 12B per encryption, authTag 16B, versioned format `v<version>:<base64(iv+tag+ciphertext)>`, key-version column. `EnvKeySecretManager` production, `NoopSecretManager` test/dev only. Production fails closed if key missing/invalid in `NODE_ENV=production` — `createSecretManager` throws, boot fails, no silent fallback. Redaction includes encryption key and decrypted values. Render's encrypted env vars alone do NOT constitute DB secret protection (explicitly documented).
- **Migration 0028:** `0028_push_channel_and_secret_hardening.sql` additive/data-preserving, safe from production 0027 applied. Creates `notification_push_deliveries` (same shape as webhook, channel push, recipient push endpoint, signing_secret JSON keys, encrypted columns, FKs to strategies/users/alerts composite, indexes claim/processing/status/user, trigger `set_updated_at`). Adds `signing_secret_encrypted` + `signing_secret_key_version` to `notification_preferences`, `notification_webhook_deliveries`, `notification_push_deliveries` with length checks. Extends channel CHECKs safely via DO blocks inspecting `pg_constraint` definition (no assumed names): drops old `channel IN ('email','webhook')` and replaces with `IN ('email','webhook','push')`, drops `cardinality(channels) <=2` → `<=3` and `channels <@ ARRAY['email','webhook']` → include push, drops `last_channel IN ('email','webhook')` → include push. Adds `push_claims bigint NOT NULL DEFAULT 0 CHECK >=0` to `notification_delivery_fairness`. Existing data preserved, existing plaintext webhook secrets have safe migration path: app reads prefer encrypted, fallback plaintext, new writes encrypted and null out plaintext.
- **Push provider:** `packages/core/src/notifications/push.ts` reuses `NotificationProvider` interface, uses `web-push` package (or transport seam for tests). Config `VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_ENABLED, PUSH_PROVIDER_TIMEOUT_MS`. `configured` honest (VAPID keys + subject present). `describe()` never contains private key. `send()` validates endpoint HTTPS, parses subscription JSON (p256dh/auth), payload JSON (idempotencyKey, template, subject, text, data), VAPID JWT, outcome 200/201 delivered, 404/410 permanent subscription failure, 429 retryable, 5xx retryable, timeout/network retryable, redaction of private key and subscription keys via `describeError`.
- **Three-way fairness:** extends ledger to `push_claims`, `last_channel IN ('email','webhook','push')`. Decision uses lifetime claim counts: queue with fewer lifetime claims preferred, balanced queues continue round-robin from `last_channel` (canonical order email→webhook→push, distance from last). Every committed claim increments its counter transactionally under advisory lock `611_231_008` + `FOR UPDATE`, rollback rolls back counter, cleanup never decrements, retries/stale never increment, restart cannot reset. Batch: quotas distributed fairly (e.g. limit 5 → [2,2,1] in preference order), unused capacity of drained queue goes to others, so capacity not stranded. No worker-ID hash/parity logic.
- **Preferences:** `NotificationPreferenceService` now takes `SecretManager`, encrypts webhook signing secrets and push keys on write (stores in `signing_secret_encrypted`, nulls plaintext), decrypts on `deliveryTargets` (prefers encrypted, fallback plaintext for migration), owner-scoped, HTTPS-only validation for webhook/push, write-only API perspective. `upsertPushSubscription` validates strict schema, encrypted persistence. GET responses never return webhook secret, push p256dh/auth, encryption key, VAPID private key. Preserves quiet hours, strategy routing, email fallback.
- **API:** extended `GET/PUT /api/notifications/preferences` to support push, `GET/PUT /api/notifications/preferences/strategies/...` supports push max 3. New `GET /api/notifications/push/vapid-public-key` authenticated returns `{publicKey}` (404 when not configured). New `POST /api/notifications/push/subscriptions` authenticated owner-scoped validates strict schema, encrypted at rest, audit `notification.push_subscription_created` with truncated endpoint (no keys). New `DELETE /api/notifications/preferences/:channel` narrowly scoped for push/webhook/email. Preserves constant-time worker token checking, rate limiting 30/min, 404 masking, authentication, tenant scoping.
- **Web UI:** `apps/web/components/notification-preferences.tsx` added to Settings: email toggle (always enabled fallback), webhook configuration (URL + write-only secret input placeholder ••••), push permission state (unsupported/default/granted/denied), push subscribe/unsubscribe (serviceWorker registration, `pushManager.subscribe` with VAPID public key, `subscriptionToRequest`, POST to API, unsubscribe via `unsubscribe()` + DELETE), quiet hours (start/end minutes + timezone), strategy routing display, clear error/loading states, never displays stored secrets/keys, uses centralized `BRAND`. Service worker `apps/web/public/sw.js` handles push events (showNotification with subject/text, data alertId/url, tag idempotencyKey) and notificationclick (focus/open `/alerts/:id`), pushsubscriptionchange resubscribe best-effort.
- **Configuration/Render:** `render.yaml` adds `WEBHOOK_SECRET_ENCRYPTION_KEY sync:false`, `VAPID_PUBLIC_KEY sync:false`, `VAPID_PRIVATE_KEY sync:false`, `VAPID_SUBJECT sync:false`, `PUSH_ENABLED true`, `PUSH_PROVIDER_TIMEOUT_MS 15000`. Docs updated, no secrets in repo. Production config requires encryption key when secret encryption enabled, VAPID private server-only.
- **Tests:** contracts push accepted/invalid, channel max 3, invalid HTTP rejected, secrets excluded; migrations fresh through 0028 and upgrade 0027→0028, data preserved, constraints correct, push_claims 0, checksumsMatch; secret manager encryption/decryption, random IV, wrong key fails, key version, malformed fails, production missing-key fail-closed, redaction; preferences push ownership, encrypted persistence, webhook encrypted, no leakage, routing, quiet hours; push provider configured/unconfigured, success 201, 404/410 permanent, 429 retryable, 5xx retryable, timeout retryable, private-key redaction; outbox push enqueue/claim, 3-way fairness balanced, one empty queue fills capacity, cleanup durability, retries/stale, cascade, concurrent, rollback, invalid limits; API auth, owner scoping, rate limits, no secret leakage; web rendering, permission denied, subscribe/unsubscribe, SW behaviour, no hard-coded branding; regression all workspaces.
- **M8.7 unchanged, M9.1 fairness preserved, automation OFF, live execution impossible, VAPID private server-only, secrets encrypted at rest, production fails closed.**

## M10.0 / Gates 9 + 10 — delivered (non-live execution transport foundation, durable provider mutation persistence, MT5 normalizer redaction)

Foundation work only: **no broker, bridge, demo or live connectivity and no
order leaves the platform.** See [m10-execution-transport.md](./m10-execution-transport.md)
and [m10-verification.md](./m10-verification.md).

- **M10.0 transport foundation:** provider-neutral `ExecutionTransport` contracts,
  a server-only dispatcher (fresh gates + a separate execution authorization
  before every submit/cancel), an opaque one-use request-bound capability, a
  bounded in-process idempotency ledger, sanitized errors/audit events, and two
  non-live adapters (`MT5ExecutionTransport` permanently unavailable,
  `DryRunExecutionTransport` for tests). `EXECUTION_TRANSPORT_MODE=mt5-live`
  always fails startup.
- **Gate 9 Step 2 (pre-provider validation):** the `veltrixeye.mt5-bridge`
  protocol contract at `1.0.0` (strict, bounded, no credential field, live
  environment refused), a single readiness interpretation, durable client-order
  identity (`ve-<24 hex>` / `ve-<20 hex>-rN`) checked before anything else,
  two-sided quote freshness, instrument/volume validation, and provider-status
  normalization that keeps unknown states unknown.
- **Gate 9 persistence step ([gate9-provider-mutation-persistence.md](./gate9-provider-mutation-persistence.md)):**
  durable persistence and recovery safety for **provider order-submit
  mutations only** (cancel/modify/close out of scope).
  - migration **`0029_provider_mutation_persistence.sql`** (additive; `0028`
    byte-identical) extends `execution_provider_intents` and adds the mutation
    reservation, sanitized receipt, reconciliation-observation, resolution and
    append-only event tables, with trigger-enforced state machines, DELETE
    guards for unresolved rows, optimistic-concurrency versioning and a
    database-side credential-key guard;
  - `ProviderMutationLedger` implements the pre-provider persistence barrier
    (intent + reservation committed before the provider call, no transaction
    held open across it), outcome normalization (timeout/lost/malformed/unknown
    ⇒ `uncertain`, never `rejected`), retry lineage, observation-only
    reconciliation, evidence-bearing operator resolution and restart recovery;
  - the existing 60-second risk-reservation TTL keeps its risk-exposure meaning
    but can never erase unresolved mutation safety;
  - **no secret-manager integration, no live wiring, no automatic
    repair/retry/cancel/close**, and no change to order-status vocabulary or to
    risk/notification/entitlement/kill-switch behavior.
- **Gate 10 (legacy MT5 response-normalizer redaction):** recorded in
  [m10-verification.md](./m10-verification.md) — raw provider messages/causes
  removed from the legacy M8.4 MT5 normalization, health/account and
  persistence/audit paths; fixed-message closed-category errors, sanitized
  receipts, allowlisted health reasons. **PASS / CLOSED**; no remediation
  remains.
- **M10 promotion-gate closure (2026-09-20):** Gate 9's documented scope is
  complete — Step 2 (pre-provider validation) and Steps 3a/3b/3c (durable
  provider mutation persistence) are satisfied — and Gate 9 is **CLOSED /
  PROMOTED**: PR #39 is merged into `main` and production migration `0030` is
  applied. Gate 10 is **PASS / CLOSED**. Gate 9 and Gate 10 are the currently
  documented numbered M10 promotion gates — **there is no Gate 11 defined in
  this repository** — and neither gate completed provider/live transport
  wiring: the future work below remains future, separately reviewed work.

## After M10 (later work, outline only)

The items below are deliberately **unnumbered**: the numbered M10
promotion-gate sequence (Gate 9, Gate 10) is complete and closed, and no
Gate 11 exists or is assigned to future work. Everything here is future,
separately reviewed work — including provider/transport adapter wiring, the
fake-bridge/operator harness where applicable, provider registry/live
integration, secret-manager binding, reconciliation scheduling,
retention/archival, real broker/MT5/Exness integration and live execution
enablement — and is **not** completed by Gate 9 or Gate 10.

1. **Operational broker transport** — validate a concrete MT5 bridge and an approved external secret manager on demo infrastructure. M8.4 deliberately ships neither and makes no connectivity claim. M8.5/M8.6/M8.7/M9.1/M9.2 prepare reconciliation, safety plumbing, drawdown protection, notification fairness and secret hardening for it; the transport itself is gated on external validation.
2. **Billing** (provider, webhooks, checkout/portal) lands alongside or after.
3. **More channels** (SMS/Telegram) behind same registry if needed.
