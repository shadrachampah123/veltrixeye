# Production Deployment

M1 ships a **production deployment target for the API** (`apps/api`) and the
wiring that lets the production web app talk to it. Nothing here contains a
credential: every secret is supplied by the operator at deploy time
(see [security.md](./security.md)).

## Topology

```
browser ──https──> Vercel (Next.js web app, apps/web)
                        │  server-side rewrite: /api/* → API_INTERNAL_BASE
                        └──https──> API service (Fastify, apps/api, Docker)
                                        │
                                        └──TLS──> managed PostgreSQL 14+
```

- The browser only ever calls **same-origin `/api/...`**. The API's origin is
  never exposed to the client — it lives in the Vercel project env var
  `API_INTERNAL_BASE` and is resolved at **build time** by
  `apps/web/next.config.mjs`.
- The API is a long-running Node/Fastify process with a `pg` pool, boot-time
  migrations, in-memory rate limiting and server-side sessions. It is **not**
  a serverless workload: it must run on a host that keeps a process alive
  (container/PaaS), not as a Vercel Function. That is why M1 pins a container
  image plus a Render Blueprint instead of folding the API into Vercel.
- No CORS is involved anywhere: the web app proxies server-side, and the API
  still emits no `Access-Control-Allow-Origin` header
  (see [security.md](./security.md)).

## What the repository provides

| File | Purpose |
|---|---|
| `Dockerfile` | Production image for `apps/api` (multi-stage, non-root, no dev deps, no secrets). Host-agnostic: Render, Fly, Railway, Cloud Run, ECS, a plain VM. |
| `.dockerignore` | Keeps `.env*`, `.git`, `node_modules`, tests and docs out of the image. |
| `render.yaml` | Render **Blueprint**: one Docker web service, health check `/api/health/ready`, env vars wired, `DATABASE_URL` prompted as a secret (`sync: false`). |
| `apps/api` | Unchanged API. Runs TypeScript through `tsx` (the workspace packages are TS sources), so the image has no compile step. `tsx` is a runtime dependency of the API workspace for that reason. |
| `scripts/db/migrate-cli.ts` | Existing migration CLI (`npm run db:migrate`), also usable inside the image. |
| `apps/web/next.config.mjs` | Same-origin `/api/*` rewrite driven by `API_INTERNAL_BASE`, with build-time fail-fast in production. |

### Why Render (and why a container)

- The API needs a **long-lived process**, HTTPS, health checks and a place to
  run migrations. Render's Docker web service provides all of that, keeps the
  image portable, and deploys straight from `main` in this GitHub repo.
- `render.yaml` makes the deployment **reproducible from the repository**
  (infrastructure as code) instead of a set of dashboard clicks, so the
  configuration is reviewable in a PR.
- Free is enough to stand the service up. If you need an always-on API, switch
  `plan: free` → `plan: starter` in `render.yaml` (or in the dashboard) — see
  [Free instance caveats](#free-instance-caveats).
- Any other container host works with the same image; see
  [Alternative hosts](#alternative-hosts).

## Prerequisites

1. A **PostgreSQL 14+** database reachable over TLS (Neon, Supabase, Render
   Postgres, RDS …) and its connection string. Managed Postgres is expected —
   the API just needs `DATABASE_URL`.
2. A **Render account** connected to this GitHub repository (free tier is
   fine).
3. The existing **Vercel project** for `apps/web` (Root Directory `apps/web`,
   see the README).

## Step 1 — Provision the database

Create the database at your provider and copy its connection string, e.g.

```
postgres://USER:PASSWORD@HOST:5432/DBNAME
```

Notes:

- Use the provider's **pooled/primary** connection string. `DATABASE_POOL_MAX`
  (default 10) is per API instance; keep `instances × DATABASE_POOL_MAX` below
  the provider's connection limit.
- `DATABASE_SSL_MODE` defaults to `require` in the Blueprint (TLS without
  certificate verification — the pragmatic setting for managed Postgres).
  Prefer `verify-full` when the provider publishes a CA: set
  `DATABASE_SSL_MODE=verify-full` and point `NODE_EXTRA_CA_CERTS` at the CA
  bundle.
- **Never** put this string in the repository. It is entered in the Render
  dashboard (Step 2).

## Step 2 — Deploy the API

### Render Blueprint (recommended)

1. Render Dashboard → **New → Blueprint** → pick this repository → **Apply**.
   Render reads `render.yaml` and creates the web service `veltrixeye-api`.
2. When prompted, paste **`DATABASE_URL`** (the only `sync: false` value). It is
   stored encrypted on the service; it is never written to the repo.
3. Wait for the image build and the first deploy to finish. The service must
   answer `GET /api/health/ready` with `200` before Render routes traffic to
   it (`healthCheckPath` in the blueprint), which also means the schema was
   migrated successfully.
4. Copy the service URL from the dashboard (Render assigns
   `https://<service-name>.onrender.com` unless a custom domain is set).
   **That URL is the value for `API_INTERNAL_BASE` in Step 4.**

Everything the service must be is set by the blueprint: `NODE_ENV=production`,
`HOST=0.0.0.0`, `PORT`, `DATABASE_SSL_MODE`, `LOG_LEVEL`, health check, and the
Docker build. HTTPS is terminated by Render.

### Alternative hosts

The same image runs anywhere a container can listen on `$PORT`:

```bash
# build and smoke-test locally against any Postgres
docker build -t veltrixeye-api .
docker run --rm -p 4000:4000 \
  -e DATABASE_URL='postgres://…' \
  -e DATABASE_SSL_MODE=require \
  veltrixeye-api
```

- **Fly.io**: `fly launch --dockerfile Dockerfile --no-deploy` then
  `fly secrets set DATABASE_URL=…` and `fly deploy`; keep the process
  single-instance (`fly scale count 1`) unless you move rate limiting to a
  shared store (see [Scaling](#scaling-and-rate-limiting)).
- **Railway / Cloud Run / ECS / a VM**: build the image, set the same env vars,
  expose the container port, and point the platform health check at
  `/api/health/ready`. Terminate TLS at the platform (the API does not speak
  TLS itself; it sets HSTS in production and expects an HTTPS terminator in
  front of it).

## Step 3 — Migrations

The API applies migrations **at boot** (`apps/api/src/server.ts` →
`runMigrations`) and refuses to start if the database cannot be migrated.
This is the existing behaviour, and it is safe to leave as the primary
mechanism:

- Migrations are **additive only** — the runner has no reset/drop path, and
  every migration file in `packages/core/src/db/migrations` was reviewed to
  contain no `DROP`/`TRUNCATE`/`DELETE`.
- Each migration runs inside a transaction and is recorded in
  `schema_migrations` with a SHA-256 checksum.
- Changed files for already-applied migrations are **refused** (drift
  protection) instead of silently re-applied.
- A **Postgres advisory lock** serialises concurrent runners, so a rolling
  deploy, a second instance, or an operator running the CLI at the same time
  cannot double-apply a migration or race the `schema_migrations` table.

To run migrations **without starting the service** — before a deploy, from CI,
or while inspecting state:

```bash
# from the repository (environment or repo-root .env supplies DATABASE_URL)
npm run db:migrate             # apply pending migrations
npm run db:migrate -- --status # read-only: list applied migrations

# or from the built image, no checkout required
docker run --rm -e DATABASE_URL='postgres://…' veltrixeye-api npm run db:migrate -- --status
```

Optional: on a **paid** Render instance type you can also add

```yaml
    preDeployCommand: npm run db:migrate
```

to the service in `render.yaml`. Render then migrates after the image build and
before the new instance takes traffic, and a failed migration cancels the
deploy. It is not required: boot-time migrations already run under the advisory
lock, and `preDeployCommand` is not available on free instance types.

Migrations are never destructive and M1 adds no new migration.

## Step 4 — Point the web app at the API

In the **Vercel project** (Settings → Environment Variables):

| Variable | Environment | Value |
|---|---|---|
| `API_INTERNAL_BASE` | Production | the API origin from Step 2, e.g. `https://veltrixeye-api.onrender.com` |
| `API_INTERNAL_BASE` | Preview (optional) | the same API, or a staging API, so PR previews work |

Then **redeploy** the web app: the rewrite destination is compiled into the
build, so the variable only takes effect on a new deployment.

Guard rails (in `apps/web/next.config.mjs`):

- On a Vercel **production** build, a missing `API_INTERNAL_BASE` **fails the
  build** with an actionable message. Vercel keeps serving the previous
  deployment, so production never silently proxies to `localhost`.
- On a Vercel production build, a non-`https://` value fails the build —
  credentials and session cookies must not cross the network in plaintext.
- Local development is unaffected: `apps/web/.env.local` (from `npm run setup`)
  points at `http://127.0.0.1:4000`, and non-Vercel builds fall back to that
  default with a console warning.

The API origin stays server-side: it is read from `next.config.mjs` (not a
`NEXT_PUBLIC_*` variable), so it is never shipped to the browser.

## Step 5 — Verify the deployment

```bash
API_BASE='https://<your-api-host>'   # the URL you copied in Step 2
WEB_BASE='https://<your-web-host>'   # the Vercel production URL

# liveness (no database round-trip)
curl -sS "$API_BASE/api/health"            # {"status":"ok",...}

# readiness: database + migration/schema state
curl -sS "$API_BASE/api/health/ready"
# {"status":"ready","database":"up","schema":{"applied":7,"expected":7,
#   "latest":"0007_version_immutability.sql","pending":[],"checksumsMatch":true}}

# security headers + no CORS
curl -sSI "$API_BASE/api/health" | grep -Ei 'strict-transport|x-frame|content-security|access-control'

# the web app reaches the API through its own origin
curl -sS "$WEB_BASE/api/health/ready"

# end-to-end through the web app: register, then log in
curl -sS -X POST "$WEB_BASE/api/auth/register" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"<strong-password>","name":"You"}'
curl -sS -i -X POST "$WEB_BASE/api/auth/login" -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"<strong-password>"}' | grep -i 'set-cookie'
```

A `503` from `/api/health/ready` is meaningful: `database: down` means the
database is unreachable, `reason: pending migrations` or
`reason: migration checksum mismatch` means the running build and the database
disagree. The failing `schema` block is included in the response.

## Environment variables

| Variable | Required | Production value |
|---|---|---|
| `DATABASE_URL` | **yes** | managed Postgres connection string (secret) |
| `NODE_ENV` | yes (set by blueprint) | `production` |
| `PORT` / `HOST` | recommended | `4000` / `0.0.0.0` (Render injects `PORT`; the blueprint pins both) |
| `DATABASE_SSL_MODE` | recommended | `require` (or `verify-full` + `NODE_EXTRA_CA_CERTS`) |
| `DATABASE_POOL_MAX` | no (default 10) | keep `instances × pool ≤ provider limit` |
| `SESSION_COOKIE_NAME` | no (default `ve_session`) | changing it forces re-login |
| `COOKIE_SECURE` | no (default `auto`) | `auto` → `Secure` in production |
| `SESSION_TTL_DAYS` | no (default 30) | 1–90 |
| `LOG_LEVEL` | no (default `info`) | `info` in production |

Missing or malformed values make the API **fail at boot** with an itemized
error (`loadConfig` zod validation) instead of misbehaving at runtime.
The web app's only deployment variable is `API_INTERNAL_BASE` (Step 4).

## What the deployment preserves

| Property | Where it lives | Effect in production |
|---|---|---|
| Authentication | `apps/api/src/routes/auth.ts` | argon2id hashes, generic 401s, timing parity on unknown users |
| Sessions | `apps/api/src/session-auth.ts` | server-side hashed session tokens; `HttpOnly`, `SameSite=Strict`, `Secure` cookie (HTTPS + `NODE_ENV=production`); token is never sent to a different origin (same-origin proxy only) |
| Owner isolation | `packages/core/src/strategies/*` | every query is scoped to the acting user; other users' resources return 404 |
| Rate limiting | `apps/api/src/app.ts`, `routes/auth.ts` | 300/min global, 10/min login, 5/h register — per instance (see below) |
| Audit logging | `packages/core/src/audit.ts` | register/login/failure/logout/password-change/strategy actions recorded in `audit_events` |
| Security headers | Fastify helmet | CSP deny-all, `nosniff`, `X-Frame-Options: DENY`, HSTS in production, no CORS headers, `X-Powered-By` hidden |
| Transport | Render/Vercel TLS | HTTPS end to end; `DATABASE_SSL_MODE` covers API→database |
| Secrets | platform env vars | nothing in the repo, nothing in the image (`.dockerignore` excludes `.env*`) |

### Scaling and rate limiting

`@fastify/rate-limit` uses an in-memory store, so limits are **per instance**.
Keep the API at one instance (`numInstances: 1`, the default) for exact
limits; if you scale out, either accept per-instance limits or add a shared
store. `trustProxy: true` is unchanged from M1: the app trusts the
`X-Forwarded-For` chain it sits behind. If you ever expose the API directly
(not just behind Vercel), pin the trusted proxy hops or key limits on a
verified header — deployment hardening tracked in
[milestones.md](./milestones.md).

### Free instance caveats

Render free web services **spin down after ~15 minutes without traffic** and
take roughly a minute to wake, so the first request after an idle period can
fail or be slow, and they do not support pre-deploy commands. For a
production-grade always-on API, change `plan: free` to `plan: starter` in
`render.yaml` (or in the dashboard) — the blueprint, health check and
migrations are unaffected.

### Operations

- **Logs**: Render streams the Fastify logger (`LOG_LEVEL=info`); request logs
  go to the platform, not to a file.
- **Rollback**: Render keeps previous deploys — roll back the service, and if
  the rollback's build needs a schema the database does not have, migrations
  refuse rather than guess (drift protection).
- **Backups**: use your Postgres provider's automated backups. This project
  never wipes or resets data; no deployment step is destructive.
- **Uptime checks**: point external monitoring at `/api/health/ready`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Deploy fails on the health check | API could not reach the database, or migrations failed | inspect the deploy log; the boot error names the failing variable or migration |
| `/api/health/ready` → `503`, `database: down` | wrong `DATABASE_URL`, TLS mode, or provider allow-list | check the connection string, `DATABASE_SSL_MODE`, and the provider's IP allow-list (Render instances have dynamic egress IPs — allow the public internet or use a private connection) |
| `/api/health/ready` → `503`, `reason: pending migrations` | an instance is running a build whose migrations were not applied | redeploy; boot-time migrations (or `npm run db:migrate`) will converge the schema |
| Web app returns 500 on `/api/*` | `API_INTERNAL_BASE` wrong, unset at build time, or the API is asleep | fix the Vercel variable and redeploy; upgrade the API off the free plan to avoid spin-down |
| Login succeeds but the session does not stick | cookie is `Secure` while the page is served over plain HTTP | always reach the app over HTTPS (the API sets `Secure` cookies in production by design) |
| `429` on login/register | rate limits working as designed (10/min, 5/h per IP) | expected; wait or use another IP |

## Not part of M1

WAF, secret manager, least-privilege database roles, log redaction, custom
domains and autoscaling are operational hardening items listed in
[milestones.md](./milestones.md). M1 delivers the deployment target, the
migration safety and the web↔API wiring only.
