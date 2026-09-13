# Environment Configuration

VeltrixEye is configured **entirely through environment variables**. There are
no hard-coded secrets and no environment-specific code paths.
`.env.example` is a template; the real `.env` / `.env.local` files are
git-ignored and never contain values you would commit.

## How configuration is loaded

- **`npm run setup`** (`scripts/setup.mjs`) generates:
  - a repo-root `.env` with local-dev values for the API + embedded
    Postgres (a random 16-byte database password), and
  - `apps/web/.env.local` with the web app's local values.
  It **never overwrites** an existing file.
- At boot, the API's `loadDotEnv()` (`apps/api/src/config.ts`) reads the
  root `.env` and fills `process.env` for keys that are **not already set**.
  **Real environment variables always win over `.env`.**
- `loadConfig()` validates every variable against a zod schema and
  **fails fast at boot** with an itemized error if anything is missing or
  malformed. A misconfigured environment crashes loudly on start, not
  silently at runtime.

## API variables (`apps/api`)

| variable | type / values | default | notes |
|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | switches prod behavior (e.g. Secure cookies). |
| `PORT` | int 1–65535 | `4000` | API listen port. |
| `HOST` | string | `0.0.0.0` | API bind address. |
| `DATABASE_URL` | connection string | **required** | the only secret the service needs. |
| `DATABASE_SSL_MODE` | `disable` \| `require` \| `verify-full` | `disable` | production should use `verify-full`. |
| `DATABASE_POOL_MAX` | int 1–50 | `10` | pool size. |
| `SESSION_COOKIE_NAME` | string 3–64 | `ve_session` | renaming forces re-login. |
| `COOKIE_SECURE` | `auto` \| `always` \| `never` | `auto` | `auto` = Secure only in production. |
| `SESSION_TTL_DAYS` | int 1–90 | `30` | session lifetime. |
| `LOG_LEVEL` | string | `info` | fastify log level. |

## Web variables (`apps/web`)

| variable | default | notes |
|---|---|---|
| `WEB_PORT` | `3000` | dev server port. |
| `API_INTERNAL_BASE` | `http://127.0.0.1:4000` | server-side address the Next.js `/api/*` rewrite proxies to. The **browser only ever sees same-origin `/api`** — this URL is never exposed to the client (it is read in `next.config.mjs`, not a `NEXT_PUBLIC_*` variable). |

`API_INTERNAL_BASE` is resolved **at build time** (the rewrite destination is
compiled into the build), so in production it must be set in the Vercel project
before the deployment is built, and the web app must be redeployed after
changing it:

| Environment | Value |
|---|---|
| local dev / tests | `http://127.0.0.1:4000` (written to `apps/web/.env.local` by `npm run setup`) |
| Vercel **Production** | the deployed API's HTTPS origin, e.g. `https://<your-api-host>` — **required**; a production build without it (or with a non-HTTPS value) fails on purpose |
| Vercel **Preview** | optional, same or a staging API origin, so PR previews have a backend |

See [deployment.md](./deployment.md) for the full production runbook.

## Per-environment guidance

- **development** — embedded Postgres started by `npm run db:dev`
  (port 5433). `COOKIE_SECURE=auto` → non-secure on local http.
- **test** — each suite boots its own embedded Postgres on a dedicated
  port (core `5434`, api `5435`) and passes explicit variables; the
  `.env` file is not used by tests.
- **production** — a hosted Postgres 14+ (Neon, RDS, Supabase, Render, …) that
  the **operator** provides. You supply the real credentials in the deployment
  environment; **this repo never contains production secrets**. Set
  `NODE_ENV=production`, `COOKIE_SECURE=auto` (→ Secure), and
  `DATABASE_SSL_MODE=require` (or `verify-full` plus `NODE_EXTRA_CA_CERTS`
  when the provider publishes its CA). The API runs in a container
  (`Dockerfile`) behind an HTTPS terminator; the concrete variables and the
  manual steps are listed in [deployment.md](./deployment.md).

## Secrets policy

- The **only** secret this service needs is the `DATABASE_URL`
  credentials. Session tokens are server-side (random per session, stored
  hashed) — no JWT secret is required.
- **No secrets in source control, none in the frontend.** Never commit
  `.env` / `.env.local`.
- **No invented production credentials.** Real values are injected by the
  operator at deploy time; the code contains no stand-in production
  values. See [security.md](./security.md).
