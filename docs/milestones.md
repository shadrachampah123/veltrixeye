# Milestone Boundaries

This repository currently contains **Milestones M1 + M2**. The boundaries
below are deliberate and enforced: M1 shipped foundations and contracts; M2
adds real historical market data — and nothing that detects signals, scores,
backtests, or delivers alerts.

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

## Explicitly NOT in M1+M2 (by design, deferred)

- Signal / setup **detection** and any live **scanner**.
- Technical-analysis, liquidity, structure (BOS/CHoCH), order-block, FVG
  and related **algorithms**.
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

## After M2 (later milestones, outline only)

1. A **deterministic strategy-evaluation engine** that consumes a
   published `StrategyVersion` (see
   [strategy-engine-contract.md](./strategy-engine-contract.md)), reading
   candles from the M2 store.
2. Setup detection + lifecycle transitions.
3. A quality-scoring engine.
4. Backtester, then alert delivery.

Each of these is its own milestone. The M2 store, coverage ledger, and
provider abstraction are specifically shaped so each is additive — no
rewrite of the schema, contracts, or UI is required.
