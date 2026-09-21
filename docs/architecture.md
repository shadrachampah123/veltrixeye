# Architecture

VeltrixEye is a SaaS platform where users build **deterministic trading
strategies** as composable, typed rules. The platform later evaluates those
strategies against market data, detects setups, scores them, and (in later
milestones) delivers alerts. M1 delivers the foundation only — see
[milestones.md](./milestones.md) for the explicit boundary.

> The product name may change. The name is centralized where it matters
> (web branding in `apps/web/lib/brand.ts`); the architecture itself is
> brand-agnostic.

## Monorepo layout

npm workspaces, TypeScript ESM, Node ≥ 22, `tsx` for dev/test, `node:test`
for tests, plain `pg` (no ORM), zod for validation.

```
packages/
  contracts/   Shared, framework-free definitions: zod schemas + types for
               strategies, conditions, timeframes, risk, scoring, and the
               MarketDataProvider interface. Single source of truth.
  core/        Domain services on top of Postgres: migrations, users,
               sessions, strategies/versions, audit, provider registry,
               and the notification delivery pipeline (outbox + worker +
               provider adapters). No HTTP knowledge.
apps/
  api/         Fastify 5 HTTP layer: auth, users, strategies, market-data
               routes, security middleware, error mapping.
  web/         Next.js 15 (App Router) UI shell: auth pages, dashboard,
               strategy list/create/edit, settings. Talks to the API via a
               same-origin /api rewrite (no CORS, cookies work normally).
scripts/       setup.mjs (env + install), db/dev-up.mjs + db/embedded.mjs
               (embedded Postgres for local dev and tests), db/migrate-cli.ts
```

## Dependency rules

```
web  →  api (HTTP only, same-origin)
api  →  core →  contracts
web  →  contracts (types only, for typed API responses)
```

- **contracts** imports nothing from the repo (only `zod`).
- **core** imports only `contracts` (+ `pg`, `argon2`). It never imports
  Fastify/Next. Services are constructed with an explicit `pg.Pool`.
- **api** wires HTTP → core services via a small `AppContext`
  (`createAppContext` in `apps/api/src/app.ts`).
- **web** never talks to Postgres and never imports `core`/`api`.

Keeping these arrows one-directional is what makes the future signal
engine, backtester, and alert workers pluggable without touching the UI.

In production the same arrows hold, only the transport changes: the web app
runs on Vercel, the API runs as a container behind HTTPS, and the web server
proxies `/api/*` to it via `API_INTERNAL_BASE`. The browser still only ever
talks to one origin. See [deployment.md](./deployment.md).

## Request lifecycle (API)

1. `server.ts` boots the pool, **runs migrations at boot**
   (`runMigrations`, tracked in a `schema_migrations` table), applies
   helmet/rate-limit/body-limit middleware, registers routes, listens.
   (No CORS plugin is registered — the web app calls the API same-origin
   via the Next rewrite, so no `Access-Control-Allow-Origin` is ever
   emitted. See [security.md](./security.md).)
2. Authenticated routes go through `createSessionAuth`
   (`apps/api/src/session-auth.ts`): read the `ve_session` cookie, look up
   the stored sha256 token hash, attach `{ user, sessionToken }` to the
   request. Unknown/missing cookie → 401 with a generic
   `{"error":{"code":"unauthorized",...}}` body (no user enumeration).
3. Every route validates input with **contracts' zod schemas** before
   touching a service. Validation failures return a structured 400
   (`{error:{code:'invalid_input', message, fields:{<path>: string[]}}}`,
   where `fields` is keyed by the offending field path).
4. Services throw domain errors (`Errors.notFound/conflict/...` from
   `packages/core/src/errors.ts`); the API error handler maps them to
   status codes and the canonical error shape. Unexpected errors → 500
   (logged, never leaked).
5. Security-relevant actions (register, login, failed login, logout,
   password change, strategy create/publish/delete) write an
   `audit_events` row via `AuditService`.

## Data flow (target, for orientation)

```
providers → candles → analysis → strategy evaluation (per StrategyVersion)
          → setup detection → quality scoring → alerts
          → risk engine → execution decision → execution provider

alerts → durable outbox (notification_deliveries) → delivery worker
       → notification provider (email/SMTP) → delivered / retried / failed
```

M8.2 ships the risk engine (see [risk.md](./risk.md)). It does not execute
trades.

M1 ships everything *up to* the first arrow: the strategy definition is
stored in a complete, immutable, version-traceable form, and the
`MarketDataProvider` interface + `ProviderRegistry` exist but no provider
is implemented. The `setups` / `setup_state_events` / `setup_scores`
tables and lifecycle states exist as the foundation the engine will write
into. See [engine-contract.md](./engine-contract.md).

## Key design decisions

| Decision | Rationale |
|---|---|
| No ORM, typed `pg` | SQL is the domain model; keeps migrations explicit and reviewable. |
| Contracts package is zod-first | One schema set validates at the HTTP edge, in services, and in tests. `z.input` types describe what clients may send; `z.infer` describes what's stored. |
| Condition types live in a code registry, not a DB enum | Adding a type is an additive code change, never a migration. See [strategy-model.md](./strategy-model.md). |
| Strategy config is normalized to a complete snapshot on write | Historical versions stay deterministic even if registry defaults change later. |
| Immutability enforced at 3 layers (service + DB triggers + append-only guards) | Version history is the product's audit trail; it must not be mutable by accident. |
| Normalized instruments, provider symbols quarantined | Strategies reference `instruments.id` / `(asset_class, symbol)`, never provider tickers. See [provider-abstraction.md](./provider-abstraction.md). |
| Embedded Postgres for dev/test only | Real Postgres 18 in `.test/` / `.dev/`; the app only ever sees a `DATABASE_URL`. |
| Delivery is an outbox, not a request side effect | A provider outage or slow SMTP server can never fail alert generation: the request writes a durable job, a worker delivers it later with bounded retries. See [notification-delivery.md](./notification-delivery.md). |
| Commercial catalogue ≠ entitlement enforcement ≠ execution capability | What is *sold* (Starter/Pro/Elite, USD prices) is a frozen catalogue in `packages/contracts/src/billing-catalogue.ts`, validated by the server-side authority in `packages/core/src/billing/catalogue.ts`; what is *enforced* is `getEntitlements()` keyed on the stored `free`/`pro`/`premium` values; execution capability stays OFF for every plan. See [billing.md](./billing.md). |
