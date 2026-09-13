# VeltrixEye

> **Milestone M1 — Product Foundation & Architecture**
> A general-purpose SaaS platform where traders define **their own** deterministic trading strategies, scan markets against them, and receive explained, scored alerts.

## Status

This repository currently contains **M1 only**: application foundation, domain model, database schema with migrations, authentication, strategy versioning, market/instrument abstractions, provider abstraction interfaces, security baseline, UI shell, tests, and documentation.

**Not yet implemented** (by design, later milestones): market-data ingestion, technical-analysis/structure detection, live scanner, backtesting, alert delivery, billing. See [docs/milestones.md](docs/milestones.md).

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
                     provider/scoring abstractions (no HTTP)
apps/api             Fastify HTTP layer (routes, validation, sessions, rate limits)
apps/web             Next.js UI shell (auth, dashboard, strategies, settings)
scripts/             Dev/test database bootstrap, setup, migration CLI
docs/                Architecture, domain model, strategy model, security, environment
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
| `npm run db:migrate` | Apply SQL migrations to `DATABASE_URL` |
| `npm test` | Run all test suites (contracts, core, API — real Postgres) |
| `npm run typecheck` | Strict TypeScript check (project references) |
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
> by this Vercel project; in M1 the web app calls it via the same-origin
> `/api` rewrite (`API_INTERNAL_BASE`).

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
