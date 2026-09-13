# Milestone Boundaries

This repository currently contains **Milestone M1 — Product Foundation &
Architecture** only. The boundary below is deliberate and enforced: M1
ships foundations and contracts, and nothing that detects signals, moves
live data, or delivers alerts.

## M1 — delivered

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
- **Documentation** — 10 topics (this directory).
- **Automated tests** — 73 passing (contracts 20, core 28, api 25) plus
  clean typecheck, lint and production build.

## Explicitly NOT in M1 (by design, deferred)

- Signal / setup **detection** and any live **scanner**.
- Technical-analysis, liquidity, structure (BOS/CHoCH), order-block, FVG
  and related **algorithms**.
- **Market-data ingestion** — no live data, **no provider implemented**.
- **WebSockets** / realtime streaming of data.
- **Backtester**.
- **Alert delivery** (Telegram / email / push) and **TradingView
  integration**.
- **AI** in the signal path — evaluation is deterministic rules; AI is
  never the core signal engine.
- **Payments, billing, marketplace**.
- **Production deployment hardening** (TLS termination, WAF, secret
  manager, least-privilege DB roles) — an operational task for deploy
  time, not a code deliverable.

## After M1 (later milestones, outline only)

1. Implement at least one market-data provider + historical/live
   ingestion.
2. A **deterministic strategy-evaluation engine** that consumes a
   published `StrategyVersion` (see
   [strategy-engine-contract.md](./strategy-engine-contract.md)).
3. Setup detection + lifecycle transitions.
4. A quality-scoring engine.
5. Backtester, then alert delivery.

Each of these is its own milestone. **M2 has NOT been started.** The
foundation in M1 is specifically shaped so each of these is additive —
no rewrite of the schema, contracts, or UI is required.
