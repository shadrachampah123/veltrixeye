# Security

M1 establishes the security baseline every later milestone builds on.
This is a *baseline*, not a claim of full production hardening —
remaining items are listed at the bottom.

## Authentication

- **Password hashing**: argon2id (`argon2` package). Only the hash is
  stored (`users.password_hash`). Weak passwords are rejected at
  register (zod rules in `packages/contracts/src/auth.ts`).
- **Sessions**: server-side, 30-day default TTL (configurable, max 90).
  The cookie carries a random token; the DB stores only its **sha256
  hash**, so a database leak does not leak active sessions.
- **Cookie**: `HttpOnly`, `SameSite=Strict`, path `/`, `Secure`
  automatically in production (`COOKIE_SECURE=auto` → secure when
  `NODE_ENV=production`).
- **Authorization boundary**: every strategy/version/setup read and
  write is owner-scoped in `StrategyService`; another user's resources
  return **404** (not 403) so existence is never disclosed.
- **No user enumeration**: register reports a conflict only for a
  *valid* email that already exists; login uses one generic
  `Invalid email or password` 401 for both wrong-password and
  unknown-user, with **dummy argon2 verification** on the unknown-user
  path so response timing doesn't distinguish the two.

## Input validation

- Every HTTP route validates its body/query/params with the shared zod
  schemas from `@veltrixeye/contracts` *before* any service call.
- Strict objects: unknown fields are rejected (`strict()`), so clients
  can't smuggle extra keys into stored configs.
- JSON body limit 256 KB (`bodyLimit`).
- Malformed JSON and other framework parse errors are mapped to a
  structured 400 (`invalid_input`), never a 500.

## Transport & header hardening (helmet + app config)

- `Content-Security-Policy: default-src 'none'` — the API serves no
  browser content, so the CSP is deny-all.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
  same-origin`, `Cross-Origin-Opener-Policy: same-origin`,
  `Origin-Agent-Cluster: ?1`, `X-Permitted-Cross-Domain-Policies: none`.
- `X-Powered-By` hidden.
- **No CORS headers are emitted at all** — there is no `@fastify/cors`
  registration and no `WEB_ORIGIN` variable. This is deliberate and
  *stricter* than an allowlist: without `Access-Control-Allow-Origin`,
  browsers refuse to read any cross-origin response from the API, and
  preflights are not answered. The web app never makes a cross-origin
  call — `next.config.mjs` rewrites same-origin `/api/*` to
  `API_INTERNAL_BASE` server-side — and the session cookie is
  `SameSite=Strict`, so it is not sent on cross-site requests either.
  If a future client needs direct cross-origin API access, add
  `@fastify/cors` with an explicit origin allowlist (never `*`) and
  document the variable here.

## Rate limiting

- Global: 300 req/min per IP.
- `POST /api/auth/login`: **10/min per IP** (brute-force).
- `POST /api/auth/register`: **5/hour per IP** (account spam).
- `GET /api/market-data/candles`: **60/min per IP**.
- `POST /api/market-data/backfill`: **5/min per IP**.
- `POST …/versions/:versionId/evaluate`: **20/min per IP** (M3).
- `POST …/versions/:versionId/detect`: **20/min per IP** (M4).
- `POST /api/setups/:setupId/transitions`: **60/min per IP** (M4).
- `POST /api/setups/:setupId/score`: **20/min per IP** (M5).
- `POST /api/backtests`: **20/min per IP** (M6).
- `POST /api/setups/:setupId/alerts`: **20/min per IP** (M6 — generation
  writes an alert + a delivery-ledger row, so it gets the same ceiling as the
  other write-side engine endpoints).
- `POST /api/alerts/:id/acknowledge`: **60/min per IP** (M6 — idempotent
  bookkeeping, deliberately higher than generation but still bounded).
- All are per-IP limits configured in `apps/api/src/app.ts` (global) and
  the route modules (per-route overrides); the auth, evaluate, detect, alert
  generation and alert acknowledgement limits each have a dedicated 429
  regression test (the alert tests also assert the 20-then-429 and 60-then-429
  boundaries, and that a rate-limited request never writes a duplicate alert,
  delivery or audit event).
- 429 responses carry a structured body
  (`{error:{code:'rate_limited', message:'... Try again in Ns.'}}`).
- **"Per IP" means an IP the caller cannot choose** — see the next section.
  A limit keyed on a client-controlled header is not a limit.

## Client IP attribution (proxy trust)

Every per-IP limit, `audit_events.ip` and `sessions.ip` come from Fastify's
`req.ip`, which is derived from `X-Forwarded-For` by walking the chain from the
TCP peer outward and stopping at the **first address that is not in the trusted
proxy list**. The list is therefore a security boundary:

- The app is configured with an explicit list
  (`trustProxy: config.trustedProxies`, from `TRUSTED_PROXY_CIDRS`), never
  `true` and never a number — see `apps/api/src/trust-proxy.ts` for the
  topology and the reasoning.
- The default pins Render's internal hops (`loopback`, `linklocal`,
  `uniquelocal`) plus **Cloudflare's published edge ranges**, because all
  traffic to a Render public web service enters through Cloudflare. Direct
  callers to the API origin are attributed to their real address, and any
  `X-Forwarded-For` values they add sit to the left of the entry Cloudflare
  appended, so they are never reached.
- `trustProxy: true` (the pre-hardening value) trusted every hop, making
  `req.ip` the leftmost — i.e. caller-supplied — value: rotating that header
  minted a fresh bucket per request and bypassed all five limits.
- A number is **not** "trust N hops" in Fastify 5: it fails closed and trusts
  nothing, which would collapse every caller into a single shared bucket
  (safe against spoofing, but one abuser could lock out all logins). Fastify's
  own types reject a number here, so it cannot be set by accident.
- A `/0` entry, a malformed address, an unknown name or an empty list are
  **rejected at boot** (`Invalid environment configuration: -
  TRUSTED_PROXY_CIDRS: …`). "Trust everybody" is not expressible.
- Regressions are pinned by tests:
  `apps/api/test/trust-proxy.test.ts` (parsing, defaults, and side-by-side
  behaviour of the pinned list vs `true` vs a number) and the F1 blocks in
  `apps/api/test/api.test.ts` (rotating spoofed headers against the global,
  login and candles limits through a simulated Render chain).
- **Known limitation**: traffic proxied by the Vercel web app resolves to
  Vercel's egress address (Vercel publishes no egress range), so those callers
  share one bucket — coarser, never attacker-chosen. Vercel Static IPs added to
  `TRUSTED_PROXY_CIDRS` restore per-browser attribution. Details and the
  operational checklist:
  [environment.md](./environment.md#client-ip-attribution-trusted_proxy_cidrs).

## Audit log

`audit_events` (append-only, trigger-guarded) records: registration,
login, failed login, logout, session revocation, password change
(success + failure), strategy create/update/publish/deprecate/delete,
`market_data.backfill`, `strategy.evaluated`, `setup.detected`,
`setup.transitioned`, `setup.scored`, `backtest.created`/`backtest.replayed`/
`backtest.failed`, and the alert lifecycle — `alert.created`,
`alert.replayed`, `alert.delivery_recorded`, `alert.skipped` and
`alert.acknowledged` ([alerts.md](./alerts.md#6-audit-events)).
Rows carry user id, action, IP, user agent, and metadata.

Alert audit events are written to mirror exactly what happened: a dedup replay
emits `alert.replayed` (never a second `alert.created`) and
`alert.delivery_recorded` is emitted only when a ledger row was actually
inserted, so the log cannot be misread as two deliveries. Generation is
explicitly invoked (no scheduler), so every alert in the log has a matching
user request.

## Alert delivery is stub-only (M6)

- **No external delivery exists in this milestone.** The only delivery
  implementation is `StubAlertSender` (`channel: 'stub'`), which renders a
  deterministic sha256 payload hash locally and is recorded in the append-only
  `alert_deliveries` ledger. No email, webhook or push is sent; no vendor SDK,
  no outbound HTTP client, no SMTP, and no new secret or provider credential is
  introduced by alerts.
- **The guard is enforced in code, not by convention.** `AlertService` throws
  `NonStubSenderError` at construction for any sender whose channel is not
  `stub`, so real delivery cannot be switched on by configuration, environment
  variable or a one-line wiring change; it needs a reviewed change that also
  relaxes the guard. Regression tests (API + core) assert both the refusal and
  that a full generate → acknowledge flow performs **zero** network calls
  (fetch/http/https/TLS/DNS sockets are spied on; the only sockets observed are
  the local Postgres pool's, and the spy is proven live with a deliberate local
  probe).
- **Owner scoping and masked 404s are inherited, not re-implemented.** Alerts
  belong to the caller through the existing chain
  (`alerts.user_id` → `setups.strategy_version_id` → `strategies.user_id`).
  Foreign or unknown setups, alerts and acknowledgements all return a plain
  **404** with the same body as a genuinely missing resource, so alert
  existence is never disclosed. A test asserts a cross-user attempt leaves the
  victim's alert untouched (`pending`, no timestamp) and invisible in the
  attacker's list.
- **Generation is gated and cannot be coerced.** Only `confirmed`/`triggered`
  setups with an existing M5 score at the detection anchor, passing the
  version's `minQualityScore`, may generate; terminal setups are refused;
  dedup by `(setup_id, trigger_state)` plus a unique ledger key mean repeated
  or concurrent requests (verified with 8 parallel calls) produce exactly one
  alert and one ledger row.
- **Payloads are licensing-safe.** The alert body carries levels and score
  references only — never raw candles, provider symbols or vendor payloads.
- **Residual risk (accepted, documented).** Until a real channel is added, a
  user cannot be notified out-of-band: alerts are visible only through the
  authenticated API/UI. Real delivery must ship with an outbox + worker,
  per-channel redaction, retry/backoff and delivery-rate limits
  ([alerts.md](./alerts.md#10-future-channelprovider-architecture)).

## Data integrity as security

- Strategy version immutability (0007 triggers) — published history
  cannot be silently rewritten by any code path, including "oops"
  admin scripts.
- Append-only guards on `setup_state_events` and `setup_scores` — engine
  output history is tamper-evident.
- Ownership + cascade rules mean a user's delete cannot touch another
  user's data.

## Secrets & environment

- **No secrets in source control, none in the frontend.** `.env.example`
  is a template; `.env` (generated by `npm run setup` with a random local
  DB password) is git-ignored. Production credentials are supplied by the
  operator via the deployment environment — this repo never contains
  them, and the code contains no invented production values.
- `DATABASE_SSL_MODE` (`disable | require | verify-full`) is explicit per
  environment; production is expected to run `verify-full`.
- The web app calls the API **same-origin** (Next rewrites `/api/*` to
  the internal API base, `API_INTERNAL_BASE`) — no cross-origin exposure,
  no browser-visible backend URL, cookies work without CORS acrobatics.

## Error handling

- Domain errors map to canonical shapes
  (`{error:{code, message, fields?}}`); unexpected errors return a
  generic 500 with a message that leaks nothing about internals.
- 404s for unknown *routes* return JSON (consistent client handling).

## Known remaining items (post-M1)

- No account email verification or password reset flow (intentionally
  out of M1 scope).
- CSRF: mitigated by `SameSite=Strict` cookies + no wildcard CORS; a
  dedicated CSRF scheme is not needed for the current API shape but
  should be revisited if cross-site forms are ever added.
- No request signing / API keys (single-client SaaS for now).
- Requests proxied by the web app share one rate-limit bucket (Vercel's egress
  address is not published, so that hop cannot be pinned yet) — see
  [Client IP attribution](#client-ip-attribution-proxy-trust). Direct API
  traffic is attributed per real client address.
- **Alert delivery is local-only in M6** (`stub` channel + ledger). Real
  email/webhook/push needs an outbox + worker and provider credentials, and is
  deliberately deferred — see [alerts.md](./alerts.md#10-future-channelprovider-architecture).
- Production deployment hardening (TLS termination, WAF, secret manager,
  least-privilege DB roles, log redaction) is an operational task for
  deployment time — see [milestones.md](./milestones.md).
