# VeltrixEye

> **Milestones M1-M4 — Foundation, Market Data, Evaluation & Setup Detection**
> A general-purpose SaaS platform where traders define **their own** deterministic trading strategies, scan markets against them, and receive explained, scored alerts.

## Status

This repository currently contains **M1–M4**: application foundation, domain model, database schema with migrations, authentication, strategy versioning, market/instrument abstractions, security baseline, UI shell — plus the first real market-data provider (Twelve Data, historical), a global shared candle store with fetch-through reads and audited backfills, retention enforcement, a coverage ledger, the Markets UI, the deterministic strategy-evaluation engine (M3), and the setup-detection + lifecycle layer (M4).

**Not yet implemented** (by design, later milestones): quality scoring, alert delivery, backtesting, live scanner, billing. See [docs/milestones.md](docs/milestones.md).

## Stack

| Layer | Technology |
| --- | --- |
| Monorepo | npm workspaces, TypeScript (strict), ESLint |
| API | Node 22, Fastify 5 |
| Database | PostgreSQL 14+ (SQL migrations, FKs, triggers). Local dev/test use an embedded Postgres binary; production uses any Postgres via `DATABASE_URL` |
| Web | Next.js 15 (App Router), React 19, Tailwind CSS 4 |
| Validation | Zod (shared schemas in `packages/contracts`) |
| Auth | Argon2id passwords + server-side sessions in httpOnly cookies |

## Repository layout

```
packages/contracts   Shared types + Zod schemas (used by API and Web)
packages/core        Server-side domain: DB access, migrations, auth, strategy services,
                     ingestion + candle store (no HTTP)
packages/providers/twelve-data   First market-data provider (historical OHLCV)
apps/api             Fastify HTTP layer (routes, validation, sessions, rate limits)
apps/web             Next.js UI (auth, dashboard, strategies, markets, settings)
scripts/             Dev/test database bootstrap, setup, migration CLI
docs/                Architecture, domain model, strategy model, market data,
                     provider licensing, security, environment
```

## Quickstart (development)

Requires Node.js ≥ 22 and npm ≥ 10. No external services are needed for local development.

```bash
npm install
npm run setup     # generates .env files (local dev values only)
npm run dev       # starts embedded Postgres + API (:4000) + Web (:3000)
```

Open **http://localhost:3000**, register an account, and start building strategies.

## Scripts

| Command | Description |
| --- | --- |
| `npm run setup` | Create local `.env` files with generated dev secrets |
| `npm run dev` | Run embedded DB + API + Web together |
| `npm run db:migrate` | Apply SQL migrations to `DATABASE_URL` (add `-- --status` to list applied migrations without changing anything) |
| `npm test` | Run all test suites (contracts, core, API — real Postgres) |
| `npm run typecheck` | Strict TypeScript check across all 4 workspaces |
| `npm run lint` | ESLint |
| `npm run build` | Production build of API and Web |

## Deploying the web app to Vercel (monorepo)

The web app lives at `apps/web` inside an npm-workspaces monorepo, and
`@veltrixeye/contracts` is a **private workspace package** (not on the npm
registry). This has two consequences for the Vercel project:

1. **Root Directory must be `apps/web`** (Project → Settings → General).
   With the Root Directory at the monorepo root, the build still succeeds but
   writes the Next.js output to `apps/web/.next`, so Vercel's Next.js builder
   fails with `Routes Manifest Could Not Be Found` (it looks for
   `.next/routes-manifest.json` inside the Root Directory).
2. **Dependencies must be installed from the monorepo root**, otherwise the
   workspace package `@veltrixeye/contracts` cannot be resolved. This is
   pinned in `apps/web/vercel.json`:

```jsonc
// apps/web/vercel.json
{
  "framework": "nextjs",
  "installCommand": "cd ../.. && npm ci", // install all workspaces at the repo root
  "buildCommand": "next build"            // build in apps/web, output -> apps/web/.next
}
```

So the required Vercel project settings are:

| Setting | Value |
| --- | --- |
| Framework | Next.js |
| **Root Directory** | **`apps/web`** |
| Install Command | `cd ../.. && npm ci` (pinned in `apps/web/vercel.json`) |
| Build Command | `next build` (pinned in `apps/web/vercel.json`) |

> The Fastify API (`apps/api`) is a separate service and is **not** deployed
> by this Vercel project; the web app calls it via the same-origin `/api`
> rewrite (`API_INTERNAL_BASE`) — see [Production deployment](#production-deployment).

## Production deployment

The API is a long-running Node/Fastify service (Postgres pool, boot-time
migrations, in-memory rate limiting, server-side sessions), so it deploys as a
container — **not** as a Vercel Function. The repository contains everything
the deployment needs:

| File | Purpose |
| --- | --- |
| `Dockerfile` | Production image for `apps/api` (multi-stage, non-root, dependencies pinned by `package-lock.json`, no secrets inside) |
| `render.yaml` | Render Blueprint: one Docker web service, health check `/api/health/ready`, `DATABASE_URL` entered as an encrypted secret |
| `docs/deployment.md` | Step-by-step runbook (database → API → migrations → Vercel env var → verification) |

```bash
# what the platform does, locally
docker build -t veltrixeye-api .
docker run --rm -p 4000:4000 -e DATABASE_URL='postgres://…' -e DATABASE_SSL_MODE=require veltrixeye-api
```

Production wiring: set `API_INTERNAL_BASE` in the Vercel project to the
deployed API's HTTPS origin (Production, and Preview if you want working PR
previews). Missing or non-HTTPS values fail the Vercel production build on
purpose instead of silently proxying to `localhost`.

Health: `GET /api/health` is liveness; `GET /api/health/ready` reports database
connectivity **and** migration/schema state (`applied`, `expected`, `latest`,
`pending`, `checksumsMatch`) and returns `503` when the schema is behind.

Full details, including the manual steps and the operational caveats (free
instance spin-down, per-instance rate limits): [docs/deployment.md](docs/deployment.md).

## Documentation

Start here:

- [System architecture](docs/architecture.md)
- [Domain model](docs/domain-model.md)
- [Strategy model & versioning](docs/strategy-model.md)
- [Timeframes](docs/timeframes.md)
- [Provider abstraction](docs/provider-abstraction.md)
- [How to add a market-data provider](docs/how-to-add-provider.md)
- [Future strategy-engine contract](docs/strategy-engine-contract.md)
- [Security model](docs/security.md)
- [Environment configuration](docs/environment.md)
- [Milestone boundaries](docs/milestones.md)

## Ground rules (for future developers)

1. **Strategy logic must never import provider code.** The engine consumes the normalized domain in `packages/core` and the contracts in `packages/contracts`. Provider-specific symbols live only in `instrument_provider_symbols`.
2. **Strategies are versioned and immutable once published.** Create a new version to change behavior.
3. **Condition types are an extensible registry**, not a hard-coded list. Add new types in `packages/contracts/src/conditions.ts`.
4. **No secrets in source control.** All configuration flows through environment variables; see [docs/environment.md](docs/environment.md).
5. **Each user is their own tenant.** Every data-access call is scoped by the acting user.
