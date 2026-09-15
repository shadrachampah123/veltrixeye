# Milestone Boundaries

This repository currently contains **Milestones M1 + M2 + M3 + M4 + M5,
M6 Phases 1–4, and M7.1 + M7.2**. The boundaries below are deliberate and
enforced: M1 shipped foundations and contracts; M2 added real historical
market data; M3 added deterministic strategy evaluation; M4 added
deterministic setup detection and lifecycle management; M5 added
deterministic setup quality scoring; M6 Phases 1–3 add the backtest
engine/service and explicit setup alerts with a **stub-only** delivery
ledger; M6 Phase 4 adds the backtest and alert surfaces in the web app; M7.1
adds the core browser trading workflow (evaluate → detect → score →
transition → alert → acknowledge); M7.2 hardens the whole surface for
commercial readiness (reference-data protection, audit attribution,
credential-endpoint limiting, session hygiene). Still, nothing that
schedules, streams, sends real notifications, or executes trades.

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

## Explicitly NOT in M1+M2+M3+M4+M5+M6 (by design, deferred)

- A live **scanner** (detection stays explicitly invoked) and setup
  **realtime** updates.
- **Realtime streaming / WebSockets**; session calendar and market-state
  feeds (provider honestly reports gaps).
- **Real alert delivery** — email, webhook, push or Telegram. M6 records a
  local stub ledger entry only ([alerts.md](./alerts.md#3-stub-delivery-ledger-zero-external-io));
  a real channel needs an outbox + worker, provider credentials and its own
  security review. **TradingView integration** is likewise not built.
- **Automated trade execution** (M8) — alerts are suggestions, never orders.
- **Billing / subscriptions** — the M1 `users.tier` column exists, but no
  billing logic acts on it.
- **AI** in the signal path — evaluation is deterministic rules; AI is
  never the core signal engine.
- **Marketplace** with paid plans or revenue sharing.
- **Second provider implementation** (EODHD approved as fallback, not built).
- **Raw-data export / redistribution** (needs an Enterprise/add-on license).
- **Production deployment hardening** (TLS termination, WAF, secret
  manager, least-privilege DB roles) — an operational task for deploy
  time, not a code deliverable.

## After M6 (later work, outline only)

1. **Real alert delivery** (channels + outbox/worker) with the security review
   described in [alerts.md](./alerts.md#10-future-channelprovider-architecture).
   The Phase 4 UI already labels delivery as stub-only, so enabling a real
   channel is a backend change plus a copy change, not a UI rebuild.
2. A **live scanner** on top of the M4 detection service (still explicitly
   owned by the user, never a hidden cron), then **M8 trade execution** and
   **billing** as their own milestones.

Each of these is its own milestone. The M3 engine, M4 detector, M5 scoring
engine, result DTOs, store, and provider abstraction are specifically
shaped so each is additive — no rewrite of the schema, contracts, or UI is
required.
