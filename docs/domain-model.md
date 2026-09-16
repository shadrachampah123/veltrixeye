# Domain Model

All persistence lives in seven Postgres migrations under
`packages/core/src/db/migrations/`. Migrations run at API boot and in every
test suite (tracked in a `schema_migrations` table; they are idempotent and
never destructive).

```
0001_identity_and_audit.sql      users, sessions, audit_events
0002_markets_and_providers.sql   data_providers, instruments,
                                 instrument_provider_symbols
0003_strategies_and_versions.sql strategies, strategy_versions
0004_strategy_configuration.sql  strategy_timeframes, strategy_market_scopes,
                                 strategy_market_scope_instruments,
                                 strategy_session_filters,
                                 strategy_risk_config, strategy_filters
0005_rules_and_conditions.sql    strategy_rule_groups, strategy_conditions
0006_setups_lifecycle.sql        setups, setup_state_events, setup_scores
0007_version_immutability.sql    trigger-based immutability guards
0008_market_candles.sql          candles, ingestion_runs
0009_setup_detection_keys.sql    setups.as_of_ms + detection idempotency key
0016_execution_architecture.sql  execution profiles/requests/orders/positions,
                                 kill switches, automation flag
0017_risk_engine.sql             risk policies, instrument specs, account
                                 state, risk decisions, reservations
```

## Entities

### users
- `id` uuid PK, `email` (unique, lowercase-enforced by `CHECK (email = lower(email))`),
  `password_hash` (argon2id — never the plain password), `name`,
  `plan` (`free | pro | premium`, default `free` — SaaS tier readiness, no
  billing), `created_at`/`updated_at`/`deleted_at` (soft delete).
- `CHECK` constraints enforce email length 3–254, name 1–80.

### sessions
- Server-side sessions: `user_id` → users (CASCADE), `token_hash`
  (sha256 of the random token; only the hash is stored), `user_agent`,
  `created_at`, `expires_at`, `revoked_at`.
- The cookie holds the raw token; the DB holds the hash, so a DB leak does
  not leak live sessions.

### audit_events
- Append-only log (`user_id`, `action`, `ip`, `user_agent`, `metadata`
  JSONB, `created_at`). Guarded by an append-only trigger (see
  0007): UPDATE/DELETE are rejected.

### data_providers / instruments / instrument_provider_symbols
- `data_providers`: registry rows (`slug` unique, `status`
  `planned | active | deprecated`). M1 keeps the table + interface; no
  provider is implemented.
- `instruments`: the **normalized, provider-independent** instrument
  (`asset_class` + `symbol` unique; e.g. `forex/EURUSD`).
- `instrument_provider_symbols`: the **only** place provider-specific
  tickers exist (`provider_id` + `provider_symbol` → `instrument_id`).
  Strategy configuration must never reference provider symbols.
  See [provider-abstraction.md](./provider-abstraction.md).

### strategies
- Parent record: `user_id`, `name` (unique per user, case-insensitive),
  `description`, `status` (`draft | active | paused | archived`),
  timestamps. Strategy-level metadata is mutable; the *definition* is not.

### strategy_versions
- One row per version: `strategy_id`, `version_number` (unique per
  strategy), `status` (`draft | published | deprecated`), `changelog`,
  `created_by`, `published_at`.
- Rules enforced across service + DB + triggers:
  - strictly increasing `version_number`,
  - **at most one draft** per strategy (partial unique index),
  - a non-draft version is **immutable** (0007 triggers reject UPDATE;
    the only allowed transition is `published → deprecated`, which only
    flips the deprecation flag),
  - "current version" = highest published version (computed, no pointer).
- Everything about a version (timeframes, market scope, sessions, risk,
  filters, rule groups, conditions) is owned by the version row
  (`ON DELETE CASCADE`), so a version is a complete self-contained
  snapshot. See [strategy-model.md](./strategy-model.md).

### setups / setup_state_events / setup_scores
- The engine's persisted output (schema in M1, written from M4):
  - `setups`: a detected setup instance — `strategy_version_id` (FK, the
    traceability anchor), `instrument_id`, `state` (CHECK-constrained to
    the 8 lifecycle states), `direction`, `detected_at`, `as_of_ms` (the M3
    anchor; part of the M4 0009 idempotency key with version/instrument/
    direction), `entry_price`, `stop_loss_price`, `tp1/tp2/tp3`,
    `quality_score` (latest M5 score total; NULL until scored), `metadata`.
  - `setup_state_events`: append-only state transitions
    (`from_state`, `to_state`, `reason`).
  - `setup_scores`: append-only quality scores — `total` CHECK 0–100,
    `grade` CHECK restricted to the known grades, `components` JSONB,
    `engine_version`, and `as_of_ms` (the M3 scoring anchor; part of the
    M5 0010 idempotency key with setup/engine version). See
    [setup-scoring.md](./setup-scoring.md).
- Lifecycle states: `developing | watching | almost_ready | confirmed |
  triggered | invalidated | expired | completed`.

## Invariants that matter

- **Ownership boundary**: every strategy operation is owner-scoped in the
  service layer; another user's strategy is indistinguishable from a
  non-existent one (404, never 403).
- **Traceability**: `setups.strategy_version_id` points at the exact
  immutable version — historical alerts/backtests always resolve to the
  definition that produced them.
- **Integrity over convenience**: unique indexes, FKs with explicit
  cascade rules, CHECK constraints, and 0007 triggers all fail loudly.
