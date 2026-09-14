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
| `DATABASE_URL` | connection string | **required** | secret 1 of 2 (with `TWELVE_DATA_API_KEY`). |
| `DATABASE_SSL_MODE` | `disable` \| `require` \| `verify-full` | `disable` | production should use `verify-full`. |
| `DATABASE_POOL_MAX` | int 1–50 | `10` | pool size. |
| `SESSION_COOKIE_NAME` | string 3–64 | `ve_session` | renaming forces re-login. |
| `COOKIE_SECURE` | `auto` \| `always` \| `never` | `auto` | `auto` = Secure only in production. |
| `SESSION_TTL_DAYS` | int 1–90 | `30` | session lifetime. |
| `LOG_LEVEL` | string | `info` | fastify log level. |
| `TRUSTED_PROXY_CIDRS` | comma/space-separated CIDRs, IPs, or `loopback`\|`linklocal`\|`uniquelocal` | Cloudflare edge + Render-internal ranges | **Security boundary**: the only proxies allowed to speak for the client in `X-Forwarded-For`. Decides `req.ip`, which keys every rate limit and is stored in `audit_events.ip` / `sessions.ip`. Replaces (never appends to) the default; a `/0` or malformed entry fails the boot. See [Client IP attribution](#client-ip-attribution-trusted_proxy_cidrs). |
| `TWELVE_DATA_API_KEY` | secret, ≤128 chars | *(empty = no market data)* | M2 primary provider key. **Server-side only** — never in the repo, image, or browser. Unset: API boots, market routes answer 502. Production display requires a Business (Venture+) plan — see [provider-licensing.md](./provider-licensing.md). |
| `TWELVE_DATA_BASE_URL` | URL | `https://api.twelvedata.com` | Provider REST base (override for tests only). |
| `TWELVE_DATA_TIMEOUT_MS` | int 1000–120000 | `15000` | Per-request upstream timeout. |
| `TWELVE_DATA_MAX_RPM` | int 1–10000 | `50` | Client-side upstream cap (keep under plan credits/min). |
| `TWELVE_DATA_CRYPTO_EXCHANGE` | string 1–32 | `Binance` | Pinned crypto venue (defines the stored series — don't change casually). |

### Client IP attribution (`TRUSTED_PROXY_CIDRS`)

`req.ip` is not a raw socket value: Fastify walks the `X-Forwarded-For` chain
from the TCP peer outward and returns the **first address that is not in the
trusted list**. The list therefore decides who is allowed to claim a client
address — and `req.ip` is the key for every rate limit (300/min global,
10/min login, 5/h register, 60/min candles, 5/min backfill) as well as the
value written to `audit_events.ip` and `sessions.ip`.

The default pins exactly the infrastructure in front of the deployed API:

| Hop | Trusted entries | Why |
|---|---|---|
| Render's own network | `loopback`, `linklocal`, `uniquelocal` | the load balancer and internal hops are private/link-local addresses; `loopback` also keeps local dev and tests working |
| Cloudflare | the 15 published IPv4 + 7 published IPv6 ranges | every Render public web service sits behind Cloudflare, which appends the address it saw |

The full default value (what the schema substitutes when the variable is
unset), if you need to extend it:

```
loopback,linklocal,uniquelocal,173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13,104.24.0.0/14,172.64.0.0/13,131.0.72.0/22,2400:cb00::/32,2606:4700::/32,2803:f800::/32,2405:b500::/32,2405:8100::/32,2a06:98c0::/29,2c0f:f248::/32
```

Rules and consequences:

- **Setting the variable replaces the default**; it does not append. Copy the
  value above and add your hop if you need to change it.
- `0.0.0.0/0`, `::/0`, a malformed address/prefix, an unknown name, or an
  empty list are **rejected at boot** with
  `Invalid environment configuration: - TRUSTED_PROXY_CIDRS: …`. Trusting
  everybody is the vulnerability this variable exists to prevent, so it cannot
  be expressed.
- Never set Fastify's `trustProxy` to `true` or a number in code. `true` makes
  `req.ip` the leftmost (client-chosen) header value; a number does **not**
  mean "N hops" in Fastify 5 — it fails closed and trusts nothing, which
  collapses every caller into one bucket. Both are covered by regression tests
  in `apps/api/test/trust-proxy.test.ts`.
- **Stale Cloudflare ranges fail closed**: if the list ever lags behind
  Cloudflare's published ranges, the walk stops at the Cloudflare edge and
  those callers share a bucket. Symptom to watch: rate-limit 429s that hit
  many unrelated users at once. Re-fetch
  <https://www.cloudflare.com/ips-v4> / <https://www.cloudflare.com/ips-v6>
  and update `apps/api/src/trust-proxy.ts`.

**Known limit — Vercel-proxied traffic.** The web app rewrites `/api/*`
server-side (`next.config.mjs`), so those requests reach Cloudflare from a
**Vercel egress** address. Vercel publishes no egress range, so that hop cannot
be pinned by default: `req.ip` resolves to the Vercel egress address and all
web-proxied callers share one rate-limit bucket. This is coarser than ideal but
never attacker-chosen, and it is the reason the API's own origin
(`*.onrender.com`) is the one that must be spoof-proof. The remedy is
configuration, not code: enable **Vercel Static IPs** (paid add-on) and add the
fixed egress addresses to `TRUSTED_PROXY_CIDRS`. Vercel overwrites
`X-Forwarded-For` rather than appending to it, so once that hop is trusted the
walk lands on the browser address Vercel vouches for.

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

- The service needs **two** secrets: the `DATABASE_URL` credentials and
  the `TWELVE_DATA_API_KEY` provider key (server-side only — it travels in
  upstream query strings by vendor design, so it must never reach logs or
  browsers). Session tokens are server-side (random per session, stored
  hashed) — no JWT secret is required.
- **No secrets in source control, none in the frontend.** Never commit
  `.env` / `.env.local`.
- **No invented production credentials.** Real values are injected by the
  operator at deploy time; the code contains no stand-in production
  values. See [security.md](./security.md).
