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
- All three are per-IP limits configured in `apps/api/src/app.ts` (global)
  and `apps/api/src/routes/auth.ts` (per-route overrides), and each is
  covered by a test in `apps/api/test/api.test.ts`.
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
(success + failure), strategy create/update/publish/deprecate/delete.
Rows carry user id, action, IP, user agent, and metadata.

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
- Production deployment hardening (TLS termination, WAF, secret manager,
  least-privilege DB roles, log redaction) is an operational task for
  deployment time — see [milestones.md](./milestones.md).
