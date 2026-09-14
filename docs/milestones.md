# Milestone Boundaries

This repository currently contains **Milestones M1 + M2 + M3 + M4**. The
boundaries below are deliberate and enforced: M1 shipped foundations and
contracts; M2 added real historical market data; M3 added deterministic
strategy evaluation; M4 adds deterministic setup detection and lifecycle
management — and nothing that scores, backtests, schedules, streams, or
delivers alerts.

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

## Explicitly NOT in M1+M2+M3+M4 (by design, deferred)

- A live **scanner** (detection stays explicitly invoked), **quality
  scoring** (M5), and setup **realtime** updates.
- **Realtime streaming / WebSockets**; session calendar and market-state
  feeds (provider honestly reports gaps).
- **Backtester**.
- **Alert delivery** (Telegram / email / push) and **TradingView
  integration**.
- **AI** in the signal path — evaluation is deterministic rules; AI is
  never the core signal engine.
- **Payments, billing, marketplace**.
- **Second provider implementation** (EODHD approved as fallback, not built).
- **Raw-data export / redistribution** (needs an Enterprise/add-on license).
- **Production deployment hardening** (TLS termination, WAF, secret
  manager, least-privilege DB roles) — an operational task for deploy
  time, not a code deliverable.

## After M4 (later milestones, outline only)

1. A quality-scoring engine over the stored setups (M5).
2. Alert delivery (M6).
3. Backtester, then a live scanner on top of the M4 detection service.

Each of these is its own milestone. The M3 engine, M4 detector, result DTOs,
store, and provider abstraction are specifically shaped so each is additive —
no rewrite of the schema, contracts, or UI is required.
