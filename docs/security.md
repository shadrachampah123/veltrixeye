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
- **Session hygiene (M7.2)**: expired sessions are removed at API boot
  (`runStartupHousekeeping` — the platform runs no scheduler by design, so
  boot is the cleanup point), bounding `sessions` growth; `GET
  /api/users/me` returns at most `MAX_SESSIONS_LISTED` (100) newest
  sessions plus the caller's current session whenever it would otherwise
  be cut off by the cap.

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
- `POST /api/users/me/password`: **5/min per IP** (M7.2 — a credential
  endpoint: it verifies the current password, so it is limited like login
  and register; 5/min is far above legitimate use).
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
- `POST /api/internal/notifications/deliveries/run` and
  `…/maintenance`: **30/min per IP** (M7.3 — administrative, additionally
  gated by a shared secret; see below).
- `POST /api/execution/safety/kill-switch/activate` and `…/clear`: **15/min
  per IP**; `POST /api/execution/safety/emergency-stop`: **6/min per IP**
  (M8.6). These are fail-safe controls: the limits exist to bound abuse loops,
  never to make stopping harder than acting — arming and emergency stop are
  idempotent, and reads (`GET /api/execution/safety*`) are unlimited beyond
  the global cap.
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

Every row carries the acting request's IP and user agent (M7.2): the
service-layer strategy lifecycle events (`strategy.created`,
`strategy.updated`, `strategy.deleted`, `strategy.version_created`,
`strategy.version_updated`, `strategy.version_published`,
`strategy.version_deprecated`) now receive the request context from the
HTTP layer, so no audit event is left without attribution.

Alert audit events are written to mirror exactly what happened: a dedup replay
emits `alert.replayed` (never a second `alert.created`) and
`alert.delivery_recorded` is emitted only when a ledger row was actually
inserted, so the log cannot be misread as two deliveries. Generation is
explicitly invoked (no scheduler), so every alert in the log has a matching
user request.

## Emergency stop hierarchy (M8.6)

The M8.6 safety controls form one-way brakes: **every safety endpoint can make
the platform stop MORE, and none can make it run MORE.**

- Kill-switch `activate`/`clear`/`emergency-stop` refuse `scope=global` at
  the schema level (the user-facing enum omits it) and again in the service
  (`403`); the global switch is operator/environment territory only. Clearing
  requires a reason — an unexplained disarm is not possible through this API.
- `EXECUTION_GLOBAL_KILL_SWITCH=true` cannot be overridden from inside the
  app: `KillSwitchService` ORs the environment pin into every read, so no DB
  row or request can un-activate it, and `GET /api/execution/safety` reports
  `globalForcedByEnvironment` honestly.
- The loss-limit circuit breaker writes through the SAME audited path
  (`kill_switches` + `kill_switch_events` + `audit_events`, source
  `circuit_breaker`); `risk_policies.circuit_breaker_enabled` is
  platform-owned — user policy PATCHes cannot disable the breaker.
- Switch history is owner-scoped; cross-tenant arm/clear attempts observe a
  masked `404` identical to “nonexistent”. `audit_events` metadata for safety
  actions carries scope/target/reason — no secrets, ever.
- Deliberate asymmetry inherited from M8.1 and kept: position exits and
  reconciliation are NOT kill-switch-blocked (risk reduction stays available
  during an incident); only NEW entry is refused. Turning automation OFF is
  always allowed; turning it ON additionally refuses (409) while any switch is
  armed.

## Audit log additions

Safety actions emit `safety.kill_switch_activated`,
`safety.kill_switch_cleared`, `safety.emergency_stop` and
`safety.circuit_breaker_tripped` to `audit_events` (append-only, trigger-
guarded, ip + user-agent) — the emergency stop additionally mirrors a
`execution_events` row so the execution ledger alone answers “when did this
account stop?”. `kill_switch_events` is append-only by its own guard trigger.

## Alert delivery is stub-only (M6)

*(M7.3 note: the request path is unchanged — generation still writes only the
local stub ledger row. M7.3 added a durable outbox + worker that delivers
**outside** the request; see
[Alert notification delivery (M7.3)](#alert-notification-delivery-m73) below.)

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

## Alert notification delivery (M7.3)

- **The request path still performs no external I/O.** Generating an alert
  writes the alert, its stub ledger row and **one** durable outbox job in a
  single transaction; delivery happens later, in the worker. Regression tests
  assert zero network calls during generation even with SMTP configured.
- **Administrative routes are invisible until configured.**
  `POST /api/internal/notifications/deliveries/{run,maintenance}` require the
  `x-veltrixeye-worker-token` header; when `NOTIFICATION_WORKER_TOKEN` is unset
  they return **404** (not 401), so an unconfigured deployment advertises no
  administrative surface. The token is compared in constant time over SHA-256
  digests, and the routes are additionally rate limited (30/min per IP).
- **The worker endpoints accept no content.** Their bodies accept only
  `batchSize` / retention days; ids, recipients, channels and payloads are
  rejected with 400. A caller can say "process a batch", never "send this".
- **Owner scoping of notification records.** `GET
  /api/alerts/:alertId/notifications` is session-authenticated and owner-scoped;
  foreign, unknown and malformed ids are masked **404**s. The DTO exposes
  status, attempts, failure category, provider and timestamps only — never the
  recipient, the rendered payload, the provider error or an upstream id.
- **Credentials stay server-side and out of logs.** SMTP settings are read from
  the API environment and held by the adapter; `describe()` (the boot log)
  publishes host/port/from/auth-mode only. Provider errors are redacted before
  they are stored in `last_error` or written to a log line, and the deployment
  also hands the worker a scrubber for the credentials it configured. Worker log
  lines carry job id, alert id, user id, channel, attempt, status, provider,
  response code and failure category — no recipient, no payload, no secret.
- **No fake delivery.** With no configured provider a job is recorded
  `unavailable` (never `delivered`), and it is terminal, so a misconfigured
  deployment cannot spin on retries. `unavailable` jobs are re-queued
  automatically — bounded by the batch size — once a configured provider exists.
- **Duplicates are prevented at four levels**: `UNIQUE (alert_id, channel)`,
  `UNIQUE (idempotency_key)`, `FOR UPDATE SKIP LOCKED` claiming, and a stable
  per-job `Message-ID` so a receiver can collapse a retry after a timeout.
- **Bounded retries.** `attempts <= max_attempts` is a `CHECK` constraint, the
  claim requires `attempts < max_attempts`, and staleness recovery dead-letters
  a job whose lease expired repeatedly — an infinite loop is not expressible.
- **Retention deletes only finished work**: aged `delivered` (30 d) and
  `failed` (120 d) rows; `pending`, `processing` and `unavailable` rows are
  never deleted.

## Data integrity as security

- Strategy version immutability (0007 triggers) — published history
  cannot be silently rewritten by any code path, including "oops"
  admin scripts.
- Append-only guards on `setup_state_events` and `setup_scores` — engine
  output history is tamper-evident.
- Ownership + cascade rules mean a user's delete cannot touch another
  user's data.
- **Platform-managed reference data (M7.2)**: the shared `instruments`
  table is global, read-only reference data. A strategy version may only
  **reference** instruments that already exist; user input can neither
  mint new rows nor rewrite a platform instrument's `display_name`.
  Unknown symbols are rejected with a 400 at version write time. (The
  pre-M7.2 upsert let any user create symbols that then appeared in every
  other user's scope-`all` evaluations and market lists, and rename shared
  instruments for everyone.)

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

## Risk engine (M8.2)

- **Server-authoritative.** A client `{ approved: true }` is not a risk
  decision. The execution gate requires a persisted `decisionId` and
  `engineVersion` issued by `RiskEngineService`.
- **Ceilings are unweakenable.** `PATCH /api/risk/policy` rejects values
  outside `PLATFORM_RISK_CEILINGS`; database CHECKs make a 50% risk
  setting unrepresentable. Owner-scoped reads (masked by session).
- **No P&L injection.** Daily/weekly/consecutive loss counters live in
  `risk_account_states` and have no public writer. Client-supplied P&L is
  not an argument to `evaluate`.
- **No secrets.** Risk tables have no credential columns; `[risk]` logs
  carry ids, outcome and rejection code only. See [risk.md](./risk.md).
- **No execution path.** There is still no order-placement endpoint.
  Automation remains OFF.
