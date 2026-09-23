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
| `PAYSTACK_SECRET_KEY` | secret, ≤256 chars, **must start with `sk_test_`** | *(empty = billing unavailable)* | Billing PR3. **Sandbox only**: a live key (`sk_live_`) or a public key (`pk_*`) fails the boot — no deployment can move live money by setting a variable. Empty ⇒ the Paystack provider is **not registered** (the registry stays empty and a caller fails loudly) — fail closed, never a half-configured provider. **Server-side only**: never in the repo, an image, a log, a response or the database. |
| `PAYSTACK_TIMEOUT_MS` | int 1000–60000 | `15000` | Per-request timeout for the single Paystack HTTP attempt. There is **no retry** (Paystack documents retries for webhooks, not for outbound calls) and no configurable base URL: the adapter talks to `https://api.paystack.co` and nothing else. |
| `SMTP_HOST` | string | *(empty = email delivery unavailable)* | M7.3 email channel. Empty (with `NOTIFICATION_FROM`) ⇔ the SMTP adapter reports unconfigured and jobs are recorded `unavailable`, never `delivered`. |
| `SMTP_PORT` | int 1–65535 | `587` | 587 = submission + STARTTLS (required), 465 = implicit TLS. |
| `SMTP_SECURE` | `auto` \| `always` \| `never` | `auto` | `auto` = implicit TLS on port 465 only; STARTTLS is mandatory otherwise. |
| `SMTP_USER` | string | *(empty = no AUTH)* | SMTP username (often the vendor's API key). |
| `SMTP_PASS` | secret, ≤512 chars | *(empty)* | SMTP password / API secret. **Server-side only** — never logged, never returned by a route, redacted out of provider errors. |
| `NOTIFICATION_FROM` | ≤320 chars | *(empty)* | From address, e.g. `VeltrixEye Alerts <alerts@example.com>`. |
| `NOTIFICATION_PROVIDER_TIMEOUT_MS` | int 1000–120000 | `15000` | Per-attempt provider budget. |
| `NOTIFICATION_MAX_ATTEMPTS` | int 1–10 | `5` | Send attempts per job before it is dead-lettered. |
| `NOTIFICATION_BACKOFF_BASE_MS` | int 1000–600000 | `30000` | Attempt *n* waits `base · 2^(n-1)` ms. |
| `NOTIFICATION_BACKOFF_MAX_MS` | int 1000–21600000 | `3600000` | Backoff cap. |
| `NOTIFICATION_BACKOFF_JITTER_MS` | int 0–60000 | `5000` | Deterministic per-job jitter that spreads retry bursts. |
| `NOTIFICATION_LEASE_MS` | int 5000–3600000 | `120000` | How long a claim may stay `processing` before another run recovers it. |
| `NOTIFICATION_WORKER_ENABLED` | `true` \| `false` | `true` | Run the delivery worker on an interval inside the API process. |
| `NOTIFICATION_WORKER_INTERVAL_MS` | int 5000–3600000 | `60000` | Interval between batches. |
| `NOTIFICATION_WORKER_BATCH_SIZE` | int 1–200 | `25` | Jobs claimed per batch. |
| `NOTIFICATION_WORKER_TOKEN` | secret, ≤256 chars | *(empty)* | Shared secret for `POST /api/internal/notifications/deliveries/*` (external cron). **Empty ⇒ those routes return 404.** |
| `NOTIFICATION_RETENTION_DELIVERED_DAYS` | int 1–3650 | `30` | How long delivered rows are kept. |
| `NOTIFICATION_RETENTION_FAILED_DAYS` | int 1–3650 | `120` | How long dead letters are kept (failure audit trail). |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | secret, 32-byte base64 | *(empty, required in production)* | M9.2 AES-256-GCM key for webhook signing secrets and push keys at rest. **Server-only, never logged, never returned, redacted.** Production fails closed if missing/invalid. Generate: `openssl rand -base64 32`. Render's encrypted env vars alone do NOT constitute DB secret protection. |
| `VAPID_PUBLIC_KEY` | string, base64url | *(empty = push unavailable)* | M9.2 VAPID public key for Web Push. Safe to expose via authenticated `GET /api/notifications/push/vapid-public-key`. |
| `VAPID_PRIVATE_KEY` | secret, base64url | *(empty = push unavailable)* | M9.2 VAPID private key — **server-only, never logged, never returned, never in describe(), redacted**. |
| `VAPID_SUBJECT` | string, mailto/https | *(empty = push unavailable)* | M9.2 VAPID subject claim, e.g. `mailto:alerts@example.com`. |
| `PUSH_ENABLED` | `true` \| `false` | `true` | M9.2 enable push channel. `false` disables push provider (jobs become `unavailable`). |
| `PUSH_PROVIDER_TIMEOUT_MS` | int 1000–120000 | `15000` | M9.2 per-attempt push provider budget. |
| `SCANNER_ENABLED` | `true` \| `false` | `false` | M7.5 live scanner. `false` (dev default) ⇔ scanner only runs when triggered via API; `true` starts an in-process ticker that calls `scanner.runOnce()` every `SCANNER_INTERVAL_MS`. Safe with concurrent triggers due to advisory locking. |
| `SCANNER_INTERVAL_MS` | int 30000–3600000 | `300000` | Interval between scanner runs when `SCANNER_ENABLED=true` (5m default). |
| `SCANNER_PROVIDER_TIMEOUT_MS` | int 1000–120000 | `15000` | Per-request provider timeout for scanner fetches. |
| `SCANNER_MAX_RETRIES` | int 0–10 | `3` | Retry attempts for transient provider failures. |
| `SCANNER_RETRY_BASE_MS` | int 100–60000 | `1000` | Base backoff for retries. |
| `SCANNER_RETRY_MAX_MS` | int 1000–120000 | `10000` | Max backoff cap. |
| `EXECUTION_GLOBAL_KILL_SWITCH` | `true` \| `false` (strict) | `false` | M8.6 deployment-level global kill switch. `true` pins the platform-wide emergency stop ON for EVERY account regardless of database state: new execution (automation gates and paper simulation) is refused, `GET /api/execution/automation` reports `global_kill_switch_forced_by_environment`, and no API can clear the pin — only changing this value and redeploying. It GRANTS nothing; live execution remains impossible either way. |

Empty-string values (a platform dashboard often writes one for a skipped
secret) are treated as "not set" for the numeric variables above, so they fall
back to the default instead of failing the boot with `NaN`.

**M8.2 introduces no new environment variables** for the risk engine (it is
entirely server-side configuration: platform ceilings + per-user policy
rows). Future provider credentials stay out of the database. **M8.6 adds
exactly one variable** — `EXECUTION_GLOBAL_KILL_SWITCH` above — and it is a
stop, not a feature flag: leaving it unset/false is the normal state, and the
only way it changes behavior is by making MORE refuse.

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

- The service needs up to **five** secrets: the `DATABASE_URL` credentials,
  the `TWELVE_DATA_API_KEY` provider key (server-side only — it travels in
  upstream query strings by vendor design, so it must never reach logs or
  browsers), `PAYSTACK_SECRET_KEY` (sandbox/test-mode only; refused unless it
  starts with `sk_test_`), and — once delivery is switched on — `SMTP_PASS` and
  `NOTIFICATION_WORKER_TOKEN`. Session tokens are server-side (random per
  session, stored hashed) — no JWT secret is required.
- Delivery credentials never leave the API process: they are read at boot, held
  by the SMTP adapter, redacted out of provider error text before that text is
  stored or logged, and they are absent from `describe()`, from every HTTP
  response and from the worker's log lines.
- **No secrets in source control, none in the frontend.** Never commit
  `.env` / `.env.local`.
- **No invented production credentials.** Real values are injected by the
  operator at deploy time; the code contains no stand-in production
  values. See [security.md](./security.md).
- **Billing credentials are sandbox-only by construction.** The billing
  configuration exposes exactly two variables (above), the Paystack adapter
  refuses any key that is not a `sk_test_` test key before it can build a
  request, reports `live: false`, and never includes a credential in
  `describe()`. Billing is not a live-payment path: `POST /api/billing/checkout`
  exists, but it initializes **sandbox** checkouts only and never confirms a
  payment (no webhook, no verification path — the session can never upgrade an
  entitlement). See [paystack-provider-contract.md](./paystack-provider-contract.md).

## M8.4 MT5 boundary

M8.4 adds **no MT5 environment variables**. The registered MT5 provider uses
an unconfigured/disabled transport and has no network endpoint or credential.
Do not add broker passwords to `.env`, the database, or client configuration.
A later operational transport requires an approved external secret-management
boundary and explicit validation; configuration must never imply health or
enable live execution.
