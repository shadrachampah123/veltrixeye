# VeltrixEye — M7 Final Commercial Verification Audit

- **Date:** 2026-09-16 (UTC)
- **Audited commit:** `e90843e` (tip of `main`, merge of PR #19 "M7.5 Live Scanner — Production Market Flow")
- **Scope:** AUDIT ONLY. No code changes, no fixes, no M8 work, no deployments, no PRs. One documentation artifact (this file).
- **Milestones under audit:** M1–M6, M7.1–M7.5, PR #18.

---

## 1. Repository & Architecture Audit

**Structure — VERIFIED CONSISTENT.**

| Concern | Location | Status |
|---|---|---|
| Monorepo | npm workspaces: `packages/*`, `packages/providers/*`, `apps/*` | ✅ |
| Contracts package | `packages/contracts` (zod schemas + DTOs, shared by API & Web) | ✅ |
| Core domain package | `packages/core` (DB, auth, strategies, market data, scanner, alerts, notifications, billing — no HTTP) | ✅ |
| Provider package | `packages/providers/twelve-data` implements `MarketDataProvider` | ✅ |
| API | `apps/api` (Fastify 5, thin routes over core services) | ✅ |
| Web | `apps/web` (Next.js 15 App Router; same-origin `/api` rewrite only) | ✅ |
| Database access | `pg` pool in core; services own all SQL; parameterized queries throughout | ✅ |
| Migrations | `packages/core/src/db/migrations` 0001–0015, checksummed runner (`db/migrate.ts`) | ✅ |
| Auth | Argon2id passwords, server-side sessions (SHA-256-hashed 256-bit tokens), httpOnly SameSite=Strict cookies | ✅ |
| Authorization | Owner-scoped service layer (`strategies.user_id` chain), masked 404s, UUID pre-validation | ✅ |
| Scanner | `packages/core/src/scanner` (normalization/validation/freshness/service) over M3/M4/M5/M6 services | ✅ |
| Alerts | `packages/core/src/alerts` + `notifications` (outbox/worker/email provider) | ✅ |
| Subscription/entitlements | `packages/core/src/billing` (`entitlements.ts`, `subscriptions.ts`) + migration 0014 | ✅ |

Layering is respected: routes never touch tables directly for owned resources; the scanner composes the existing `EvaluationService`/`SetupService`/`ScoringService`/`AlertService` rather than re-implementing signal logic; the web app never sees provider secrets (`API_INTERNAL_BASE` is not `NEXT_PUBLIC_*`).

**Dead / duplicated / mocked / stubbed / unreachable paths:**

- `StubAlertSender` + `alert_deliveries` ledger (M6): **intentional, still active** — every alert generation also writes one stub ledger row beside the real M7.3 outbox job. `AlertService` still hard-refuses non-stub senders (`NonStubSenderError`), which remains the guarantee that generation performs zero external I/O. Not dead code, but a deliberately duplicated ledger. (INFORMATIONAL)
- No mock/demo data exists in any production code path: `MockProvider` lives only in tests; the scanner throws `providerUnavailable` instead of substituting data. ✅
- No unreachable routes found; every registered route is wired in `app.ts`. The internal worker routes intentionally register as 404 when `NOTIFICATION_WORKER_TOKEN` is empty.
- `canAccessAdvancedStrategies` / `canAccessAdvancedAlerts` / `canAccessAutomation` are defined and returned to clients but **no code path consumes them** — placeholders, not dead gating. (INFORMATIONAL; see §3)
- Legacy `users.plan` column (M1) still exists and is returned in `UserDto`, but entitlements read **only** `subscriptions`. Migration 0014 backfilled `subscriptions` from it. Dual source of truth, harmless today. (LOW)

---

## 2. Authentication & Authorization

**VERIFIED SOUND.** Evidence-based summary:

- **Auth required where appropriate:** every route requires a session except `GET /api/health`, `GET /api/health/ready` (unauthenticated by design, expose no user data), `POST /api/auth/register|login`, and the token-protected internal worker routes.
- **Server-side authorization:** ownership is enforced in the service layer (`strategies.user_id` chain for versions/setups/scores/backtests/alerts); routes pass only `user.id` from the session — clients never supply an acting identity.
- **IDOR:** all id-addressed reads (`/api/strategies/:id`, `/api/setups/:id`, `/api/backtests/:id`, `/api/alerts/:id`, `/api/alerts/:alertId/notifications`) are owner-joined with **masked 404s** (foreign vs unknown indistinguishable). UUIDs are regex-validated before DB use. Scanner trigger validates `strategyId` ownership. Extensively covered by API tests (200 passing).
- **Admin/platform ops:** none exist; there is no admin role, so no privilege-escalation surface exists yet. Platform reference data (`instruments`) is insert-protected since M7.2.
- **Sessions:** server-side, hashed at rest, expiry enforced at read, rotation + revoke-all on password change, per-user list capped (100), expired rows cleaned at boot.
- **Password change:** requires current password, 5/min/IP limit, audited success/failure.
- **Rate limiting:** global 300/min/IP; register 5/hour/IP; login 10/min/IP; password change 5/min/IP; candles 60/min; backfill 5/min; backtests/eval/detect/score/generate 20/min; acknowledge 60/min; scanner trigger 10/min; internal worker routes 30/min. `trustProxy` is pinned to Cloudflare+Render ranges so `req.ip` cannot be spoofed (regression-tested).
- **Cookies:** httpOnly, SameSite=Strict, Secure in production (`COOKIE_SECURE=auto`). No CORS plugin → same-origin only; CSRF via cross-origin JSON POST is blocked by preflight + SameSite=Strict.
- **Secrets:** no secret is ever serialized to a response (verified in code paths for SMTP pass, Twelve Data key, worker token); `describe()` redacts credentials; worker errors are redacted before storage/logging.

Residual issues:
- Register returns 409 "already exists" (email enumeration via register; login is generic + timing-parity). Accepted trade-off. (INFORMATIONAL)
- **All rate limits are IP-keyed and there is no per-user dimension.** Through the Vercel rewrite, production browser traffic resolves to Vercel egress IPs (not in the default trust list), so *all users share buckets* — notably login's 10/min becomes a **global** 10/min unless Vercel Static IPs are pinned. Documented in code (`app.ts`, `trust-proxy.ts`), but operationally significant for a commercial launch. (MEDIUM — see finding F6)

---

## 3. Subscription & Entitlement Enforcement (M7.4)

**Plans & statuses — VERIFIED.** `subscriptions` table: `plan IN ('free','pro','premium')`, `status IN ('active','trialing','past_due','canceled','expired')`, unique per user, provider columns present but unused.

`getEntitlements(plan, status)` is the single entitlement authority:
- status ∉ {`active`, `trialing`, `past_due`} ⇒ **free entitlements regardless of plan** — canceled/expired users correctly fall back. ✅
- `past_due` retains paid entitlements (grace behavior — intentional).

| Limit | Free | Pro | Premium | Enforcement point |
|---|---|---|---|---|
| max strategies | 100 | 500 | 1000 | `StrategyService.createStrategy` — transactional `SELECT … FOR UPDATE` on subscription + count |
| backtests / month | 100 | 1000 | 5000 | `POST /api/backtests` route (non-atomic, see F3) |
| alerts / month | 1000 | 5000 | 10000 | `AlertService.generateAlert` — transactional, also covers scanner-generated alerts |
| saved setups | 1000 | 5000 | 10000 | `SetupService.detect` — transactional, also covers the scanner |
| scanner access | ✗ | ✓ | ✓ | All 3 scanner routes, server-side, before any work |
| advanced strategies / advanced alerts | ✗ | ✓ | ✓ | **Flags exist but nothing consumes them** — no product surface is gated by them today |
| automation | ✗ | ✗ | ✗ | Placeholder only; **no automation endpoint or code path exists anywhere** — automation remains unavailable until M8 ✅ |

**Client manipulation — NOT POSSIBLE:**
- There is **no route that writes `subscriptions`** (verified by grep: only inserts are registration-time `free/active`, transactional with user creation, plus the 0014 backfill). A client cannot change plan, status, period, or limits; usage counts are computed server-side from owned rows (never client-submitted). ✅
- Billing state endpoint is read-only (`GET /api/billing/me`). ✅
- Free-tier scanner access is refused 403 on health/runs/trigger (regression-tested). ✅

Findings:
- **F1 (MEDIUM):** no regression test covers the status-fallback behavior (`canceled`/`expired`/`past_due`/`trialing` → entitlements). The fallback is a one-line `includes()` in `getEntitlements`; a commercial-critical behavior with zero direct test coverage.
- **F2 (LOW):** legacy `users.plan` duplicates `subscriptions.plan` (see §1).
- (INFORMATIONAL) Free-tier limits are very generous (100 strategies, 1000 alerts/mo); the only hard free/pro gate today is the scanner. Pricing decision, not a defect.

---

## 4. Billing Readiness

**Status: FOUNDATION ONLY.** Explicitly: **no real payment provider exists anywhere in the repository.**

| Billing capability | State |
|---|---|
| Subscription persistence | ✅ `subscriptions` table (migration 0014) with plan/status/period/cancel-at-period-end |
| Provider abstraction | ⚠️ Schema-ready only: `provider`, `provider_customer_id`, `provider_subscription_id` columns; no provider interface/code |
| Customer/provider IDs | ⚠️ Columns exist; never written |
| Checkout | ❌ none |
| Billing portal | ❌ none |
| Webhook infrastructure | ❌ none (no webhook routes, hence no signature verification or idempotent webhook processing to audit) |
| Subscription synchronization | ❌ none (plan/status can today only be changed by direct DB access) |
| Payment failure handling | ⚠️ Only the `past_due` status is *understood* by the entitlement engine; nothing ever sets it |

Entitlements are fully server-authoritative and correctly degrade on non-paying statuses, so a future provider integration is additive (webhook → update `subscriptions` row). But **until billing is built, there is no path for a user to become Pro/Premium**, which means the scanner (the only paid feature) is unusable by real customers. Billing is a hard commercial prerequisite for paid customers — see §17.

---

## 5. Strategy Engine

**VERIFIED DETERMINISTIC AND FAIL-CLOSED.** (Audited only; nothing changed.)

- Condition registry: 19 types including `market_structure` (via structure/ChoCH handlers), `liquidity_sweep`, `choch` (change of character), `break_retest`, support/resistance confirmation, `order_block`, FVG, supply/demand, ATR displacement, session windows — exactly one handler per registered type (`handlers.ts` keyed by `CONDITION_TYPE_REGISTRY`).
- Unknown condition type / invalid params / unregistered handler ⇒ `unsupported`; **required/confirmation conditions in `unsupported`/`insufficient_data` fail CLOSED**, disqualifiers in those states still veto. The engine never silently passes. ✅
- `news_filter` / `spread_filter` fail closed (no data source; never faked). ✅
- Pure engine `(config, candlesByRole, asOfMs) → result`; no clock, no I/O in decision path; engine versions pinned (`m3-deterministic-eval-1`, `m4-setup-detect-1`, `m5-quality-score-1`, `m6-backtest-1`).
- Configuration validation: strict zod schemas; risk config validates `minRr` (default 2 = 1:2), SL/TP methods, monotonic `tp1Rr < tp2Rr < tp3Rr`, `minQualityScore` 0–100 (default 65). Unsupported timeframe/role combinations are rejected at write time (M7.2 instrument-universe guard) and by `normalizeTimeframe` at scan time.
- **No AI/LLM path:** repository-wide scan found zero LLM/AI integrations in the signal path. Deterministic-only. ✅
- Production signals (scanner) flow through the same `EvaluationService` — no bypass, no duplicated condition logic in M7.5. ✅

---

## 6. Live Scanner (M7.5)

**Pipeline traced end-to-end and VERIFIED:**
`Twelve Data fetch (via IngestionService fetch-through) → normalizeCandleBatch → validateCandleBatch + validateMultiTimeframe → checkFreshness/checkMultiTimeframeFreshness → SetupService.detect (M3 evaluation, published versions only) → ScoringService.scoreSetup (M5) → AlertService.generateAlert (minQualityScore gate + monthly cap + dedup) → NotificationOutbox (same transaction)`.

- **Production provider:** Twelve Data (historical), registered at boot only with `TWELVE_DATA_API_KEY`; scanner throws `providerUnavailable` otherwise — **no mock/demo fallback in any production path** (MockProvider is test-only). ✅
- **Symbols:** validated against the platform `instruments` universe; arbitrary provider symbols rejected 400 (tested). ✅
- **Timeframes:** 14 canonical; aliases normalized (`4H`→`4h`, `60m`→`1h`…). ✅
- **Candle validation / stale / duplicates / out-of-order / gaps / impossible prices:** see §7. ✅
- **Provider timeout:** `withTimeout` race wrapper; retries bounded (`SCANNER_MAX_RETRIES`=3, exp backoff capped at `SCANNER_RETRY_MAX_MS`, +jitter). ✅
- **Concurrency protection:** `pg_try_advisory_lock(875421009)` held on a dedicated pooled connection for the run's duration; concurrent triggers return `skipped: already_running`. ✅
- **Duplicate prevention:** advisory lock (runs) + `scanner_cursors` (per version/instrument/timeframe last candle) + setups unique key + alerts unique key + outbox unique key — four layered dedup barriers. ✅
- **Restart recovery:** `recoverStaleRuns()` marks `running` runs older than 30 min as failed at boot and on demand; cursors are durable. ✅
- **Execution mechanism/frequency:** in-process `setInterval` ticker when `SCANNER_ENABLED=true` (default **false**; default interval 5 min), plus session-authenticated manual trigger `POST /api/scanner/trigger` (Pro/Premium only, 10/min).

Findings:
- **F3 (MEDIUM):** **the scanner cannot be invoked by an external scheduler.** Unlike the delivery worker (token-protected internal endpoint), `/api/scanner/trigger` requires a *user session with a paid entitlement*. If the API container sleeps (Render free plan spins down after ~15 min) or `SCANNER_ENABLED` is unset, **no scans happen at all**, and no cron can fix it without a paid user session. Combined with `render.yaml` declaring no `SCANNER_*` vars and `plan: free`, the deployed blueprint ships with the scanner effectively manual-only. Production scanning depends entirely on an always-on API process.
- **F4 (LOW):** `GET /api/scanner/runs` and `/api/scanner/health` return the **global** run ledger to any Pro/Premium user, including `metadata` with other users' `triggeredBy` user-UUIDs and `strategyId` UUIDs. Cross-user exposure limited to opaque UUIDs, but runs are not owner-scoped.
- **F5 (LOW):** advisory unlock failure is silently swallowed (`.catch(() => {})`); a failed unlock on a pooled connection would hold the session-scoped lock and stall all scans until the backend session is recycled. Rare, but unrecoverable without a restart.
- **F6 (LOW):** provider-failure/timeout detection is string-matching on error messages (`isProviderFailure`) — brittle classification, though degradation behavior stays safe.
- (INFORMATIONAL) Efficiency: each `scanInstrument` runs a full `evaluateVersion` over the whole market scope (O(instruments²) work per strategy) and fetches 3×500-candle windows per instrument every run; fine at 9 instruments / ≤50 strategies, not a scalable shape; Twelve Data plan credits (RPM) are the binding constraint.
- (INFORMATIONAL) The anchor `as_of_ms` is the *latest returned* setup candle's open time; Twelve Data may return a forming final bar, which the provider labels `closed`. Signal math is unaffected (`readRole` reads `ts < asOf`; the engine keeps only `time + period ≤ asOf`, i.e. fully closed candles), and cursors re-arm when the bar rolls, but the recorded anchor is semantically a forming bar's open.
- (INFORMATIONAL) `scanner_runs` has no retention/cleanup (≈288 rows/day at 5-min cadence — small, but unbounded).

---

## 7. Market Data Integrity

**VERIFIED.** Four enforcement layers:

1. **Provider (`twelve-data`):** every bar validated (finite, positive, OHLC invariant, volume ≥ 0); an invalid bar throws and persists nothing ("fail loudly"); paging bounded (`MAX_PAGES_PER_CALL`); dedupe by time; `[from, to)` contract enforced.
2. **Store (`CandleStore.upsertCandles` + migration 0008 CHECKs):** same invariants re-validated on write; idempotent upsert (append-and-correct).
3. **Scanner `validateCandleBatch`:** empty response invalid; duplicates invalid; out-of-order invalid; zero/impossible prices invalid; OHLC relationship invalid; >10% gaps invalid (HTF gap-tolerant); incomplete-response detection (expected-span vs received, <10 candles).
4. **Freshness (`STALE_THRESHOLDS_MS`):** per-timeframe thresholds (1m:5m … 1M:35d); **future candles rejected** (clock skew); stale ⇒ rejected, counted in `stale_rejections`, **no alert**.

Multi-timeframe integrity (§8) additionally requires presence, recency (≤3 periods), and minimum depth (HTF ≥50, setup ≥100, entry ≥100 candles) of **all three** roles before any detection runs.

**Invalid or stale data cannot reach alert generation** — validation and freshness gate before `SetupService.detect`, and detection/alerting themselves are deterministic and score-gated. Timestamps are epoch-ms UTC; resampled timeframes (3m/12h/3d) are epoch-aligned deterministically. ✅

---

## 8. Multi-Timeframe Logic

**VERIFIED.** Per-strategy roles come from `strategy_timeframes` (`htf_bias`, `setup`, `entry`); a version missing any role is excluded from scanning (`getEligibleStrategies` skips it). Before detection:

- `validateMultiTimeframe` rejects with `htf_context_missing` / `setup_timeframe_missing` / `entry_timeframe_missing` when the latest candle of any required role is older than 3 periods, and `insufficient_candles_for_correlation` below minimum depths — i.e., **HTF context must actually be present** before an alert can exist. ✅
- `checkMultiTimeframeFreshness` applies the per-timeframe stale thresholds to all three roles; any stale role rejects the whole instrument. ✅
- Candle boundaries: canonical timeframe minutes from contracts; epoch-aligned resampling for non-native intervals; `asOf` anchoring and `ts < asOf` reads keep boundaries consistent. ✅
- The documented "HTF 4H/1D, Setup 1H, Entry 15M/5M" requirement is enforced at **strategy-config write time** (timeframe role validation), not hard-limited in the scanner, which accepts any canonical timeframes a published version declares. Behavior preserved; no change recommended. (INFORMATIONAL — docs/scanner.md wording slightly overstates scanner-side enforcement.)

---

## 9. Alert Generation & Delivery (M7.3)

**VERIFIED.**

- **Creation:** eligible states only (`confirmed`/`triggered`); M5 score at the detection anchor required; `minQualityScore` gate silent-skips (`below_min_quality`); dedup unique `(setup_id, trigger_state)`; monthly per-user alert cap enforced transactionally.
- **Outbox:** `notification_deliveries`, one job per `(alert_id, channel)` (UNIQUE) + UNIQUE `idempotency_key`; payload stored verbatim; `attempts ≤ max_attempts` CHECK; recipient snapshotted; **written in the same transaction as the alert** (verified in `AlertService`).
- **Claims:** atomic `SELECT … FOR UPDATE SKIP LOCKED` — concurrent workers/ticker+cron cannot double-deliver (verified in outbox SQL and covered by 29 outbox tests).
- **Retries/backoff:** exponential (`base·2^(n-1)`, capped) with deterministic per-job jitter; transient/timeout retried, permanent dead-lettered, `unavailable` parked and re-queued when a provider appears.
- **Dead letters:** retry-budget exhaustion marks `failed` (kept 120 days by default).
- **Stale lease recovery:** `locked_at` older than lease ⇒ recovered/dead-lettered; also run at API boot.
- **Worker concurrency:** in-process ticker (overlap-guarded) + optional external cron endpoint; both safe simultaneously.
- **Provider abstraction:** `NotificationProvider` registry; SMTP/nodemailer adapter only.
- **Credential redaction:** SMTP pass/user excluded from `describe()`, redacted from stored errors (adapter + worker-level scrubber), absent from logs.
- **Provider-unavailable ⇒ `unavailable`, never `delivered`** — verified in worker (`deliver()` returns `unavailable` when channel has no configured provider) and honestly surfaced. ✅
- **M7.5 connection:** scanner-generated alerts go through the identical `AlertService.generateAlert` → outbox path (verified in `scanInstrument`). ✅

---

## 10. Database & Migration Safety

**VERIFIED SAFE.**

- 15 migrations, strictly ordered `NNNN_`, applied in filename order; duplicate versions rejected by the runner.
- Runner: single transaction per migration, `schema_migrations` ledger with **SHA-256 checksums**, drift-refusal (an altered applied migration aborts boot), **advisory-lock serialization** of concurrent runners (boot vs CLI vs multi-instance), bounded lock wait.
- All M7 migrations additive only (0013 outbox, 0014 subscriptions, 0015 scanner_runs/cursors): CREATE TABLE/INDEX/TRIGGER, CHECK constraints, FKs with `ON DELETE CASCADE` where appropriate, UNIQUE constraints exactly where idempotency requires (setup key, alert key, outbox keys, subscriptions user).
- Indexes support production queries (scanner_runs status/started, subscriptions user/provider-sub, setups/alerts owner lookups from earlier migrations).
- No destructive statement anywhere; no pending migration at the audited commit (all 15 shipped and applied by tests).
- Production startup cannot corrupt schema: migrations run under lock at boot; `/api/health/ready` returns 503 on pending migrations or checksum mismatch, keeping unmigrated instances out of rotation.
- (INFORMATIONAL) 0014's backfill `INSERT … SELECT` has no `ON CONFLICT` — safe because the runner guarantees one-shot application, but it is the only migration that is not replay-idempotent by itself.

---

## 11. Production Configuration

Server = API container (Render/Docker). Client = Next.js on Vercel (build-time only). "Configured?" reflects what the deployment manifests declare — runtime values are platform secrets and were **not** inspected/invented.

| Variable | Required? | Purpose | Server/Client | Production configured? |
|---|---|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection | Server | Declared in render.yaml (`sync: false`, operator-provided) |
| `DATABASE_SSL_MODE` | Recommended (`require`/`verify-full`) | DB TLS | Server | render.yaml: `require` |
| `DATABASE_POOL_MAX` | No (default 10) | Pool size | Server | render.yaml: 10 |
| `NODE_ENV` | Yes (prod: `production`) | Secure cookies, HSTS, logging | Server | render.yaml: production |
| `PORT` / `HOST` | No (4000/0.0.0.0) | Listen addr | Server | render.yaml set |
| `SESSION_COOKIE_NAME`, `COOKIE_SECURE`, `SESSION_TTL_DAYS`, `LOG_LEVEL` | No (safe defaults) | Session hygiene | Server | Defaults |
| `TRUSTED_PROXY_CIDRS` | No (secure default) | Rate-limit/audit IP attribution | Server | Default (Cloudflare+Render) — must be extended if Vercel Static IPs are bought |
| `TWELVE_DATA_API_KEY` | **Yes for any market data/scanner** | Provider credentials | Server | Declared in render.yaml (`sync: false`); key absent ⇒ market routes 502, scanner `unavailable` |
| `TWELVE_DATA_BASE_URL/_TIMEOUT_MS/_MAX_RPM/_CRYPTO_EXCHANGE` | No (defaults) | Provider tuning | Server | Defaults |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `NOTIFICATION_FROM` | **Yes for email delivery** (empty = honest `unavailable`) | Email channel | Server | Declared in render.yaml (`sync: false`) |
| `NOTIFICATION_*` (timeouts, attempts, backoff, lease, worker enabled/interval/batch, retention) | No (production-sane defaults) | Delivery tuning | Server | render.yaml pins enabled=true, 60s, batch 25 |
| `NOTIFICATION_WORKER_TOKEN` | Only if external cron is used | Protects internal worker endpoints (empty ⇒ 404) | Server | Declared in render.yaml (`sync: false`) |
| `SCANNER_ENABLED` | **Yes for automatic scanning** | Starts the 5-min scanner ticker | Server | **NOT declared in render.yaml** (default false ⇒ manual-only) — missing production var |
| `SCANNER_INTERVAL_MS/_PROVIDER_TIMEOUT_MS/_MAX_RETRIES/_RETRY_BASE_MS/_RETRY_MAX_MS` | No (defaults) | Scanner tuning | Server | Not declared (defaults fine) |
| `API_INTERNAL_BASE` | **Yes (web)** | Server-side rewrite target for `/api` | Client (build-time, never exposed) | Must be set on Vercel; build **fails loud** if missing/non-HTTPS in prod (fail-safe verified) |

**Missing production variables / gaps:** `SCANNER_ENABLED` is absent from render.yaml (blueprint deploys never auto-scan); there are **no billing variables** (none exist yet); no APM/metrics vars (none exist).

---

## 12. Vercel / API / Worker Architecture

- **Vercel:** Next.js web app only (Root Directory `apps/web`, install from monorepo root per `vercel.json`). Stateless; browsers call same-origin `/api/*`, rewritten server-side to `API_INTERNAL_BASE`. No background work runs on Vercel — correctly nothing depends on a long-running Vercel process. ✅
- **API host (Render, Docker):** Fastify service; migrations at boot; hosts the delivery-worker ticker and the scanner ticker **in-process**.
- **Background work:** delivery worker = in-process ticker + optional external cron via token-protected endpoint (sleep-safe by design). Scanner = in-process ticker only (**no external invocation path — finding F3**).
- **Serverless lifecycle:** the architecture explicitly anticipates container sleep (idempotent `runOnce()`, lease recovery at boot, cron fallback for delivery). But the scanner violates this principle: it depends on the API process staying awake. On the blueprint's `plan: free`, both tickers stop during spin-down; docs recommend `starter` for always-on — the blueprint comment acknowledges this.
- **Health endpoints:** `/api/health` (liveness), `/api/health/ready` (DB + migration state, used by Render health check), `/api/scanner/health` (authenticated, Pro+). ✅
- **API connectivity:** `API_INTERNAL_BASE` build-fail protection prevents a production web build from silently proxying to localhost. ✅

---

## 13. Production Security (focused)

| Area | Result |
|---|---|
| IDOR | ✅ Owner-joined service layer, masked 404s, UUID pre-validation, regression-tested. Exception: scanner run ledger cross-user metadata (F4, LOW) |
| Privilege escalation | ✅ No admin surface exists; internal endpoints 404-unless-tokened, constant-time token compare, rate-limited, accept only batch-size/retention knobs |
| AuthN bypass | ✅ None found; session lookup validates revocation/expiry/user-deletion; cookies secure |
| AuthZ bypass | ✅ Entitlements server-authoritative; no client-writable subscription path exists |
| Client-controlled entitlements | ✅ Impossible (no mutation API; usage counted from DB) |
| Secret exposure | ✅ No secret in any response/log path found; redaction in adapter + worker; scanner health tested to not expose secrets |
| Unsafe logging | ✅ Structured logs carry ids/categories only; scanner logger redacts by design; no payloads logged |
| Webhook security | N/A — no webhooks exist (billing not built) |
| Internal worker endpoints | ✅ 404 without token, SHA-256 + timingSafeEqual with token, input schema-restricted |
| Rate limiting | ✅ Tiered + pinned trust proxy. Caveat: shared buckets through Vercel egress (F7, MEDIUM) |
| Input validation | ✅ zod on every body/query; `.strict()` schemas; bodyLimit 256 KB |
| SQL injection | ✅ All queries parameterized; dynamic query building (scanner `listRuns`, backtest list) only appends `$n` placeholders — no string interpolation of user input |
| CSRF | ✅ SameSite=Strict cookies, no CORS registration (same-origin only), JSON content types require preflight |
| CORS | ✅ None configured = browser same-origin enforcement |
| Security headers | ✅ helmet: CSP `default-src 'none'` + `frame-ancestors 'none'` on the API, CORP same-origin, no-referrer, X-Frame-Options deny, HSTS in production |

---

## 14. Data & Privacy

- API responses use explicit DTOs (`toDto`, contracts) — no raw rows leak; `password_hash` never serialized (verified in `UserService.toDto`).
- Credentials never returned: SMTP pass, Twelve Data key, worker token all server-side only.
- Provider secrets never logged (adapter `describe()` excludes them; worker `redact` scrubs configured credentials out of stored errors).
- User isolation: strategies/versions/setups/scores/backtests/alerts/notifications all owner-scoped; candle store is intentionally global platform data (no user content).
- Notification data scope: `GET /api/alerts/:id/notifications` returns status/attempts/category only — never recipient, payload, or provider error. Recipients snapshotted server-side from the owner's account email.
- Scanner runs expose other users' UUIDs in metadata (F4).
- (INFORMATIONAL) No account-deletion flow exists end-to-end (soft-delete column exists; no route), and no notification-preference controls — both pre-billing product gaps.

---

## 15. Testing & Regression Protection

Executed at audited commit `e90843e` (fresh `npm ci`):

- **Tests: 735 passing / 0 failing** — contracts **73**, core **262**, provider-twelve-data **33**, api **200**, web **167**. All suites exit 0 (real embedded Postgres).
- **Typecheck: PASS** (exit 0, all 5 workspaces, `tsc --noEmit`).
- **Lint: FAIL (exit 1)** — exactly **2 errors**, both pre-existing on `main` (introduced by PR #17/M7.4, acknowledged as pre-existing in M7.5 docs, untouched by PR #18/#19):
  - `apps/api/src/routes/alerts.ts:11:18` — `'getBillingState' is defined but never used`
  - `apps/api/src/routes/strategies.ts:32:42` — `'getBillingState' is defined but never used`
  - **0 new failures** attributable to M7.5/PR #18; these two were merged into `main` because **no CI pipeline exists** (`.github/workflows` absent). Not fixed per audit-only scope.
- **Production build: PASS** — API typecheck-build exit 0; Next.js production build "Compiled successfully" (17 app pages incl. `/scanner`).

Commercial/security regression coverage present: auth/ownership/masked-404 suites, rate-limit boundary tests, trust-proxy spoof regression, zero-network-I/O proofs for alert generation, outbox concurrency/idempotency (29 tests), scanner entitlement/concurrency/freshness suites, commercial-hardening suite. **Gap:** no test for subscription-status → entitlement fallback (F1), and only 3 billing API tests.

---

## 16. Production Smoke-Test Readiness

All 14 workflows can be smoke-tested **safely** (no destructive actions, no financial transactions possible — billing does not exist, no trades can be placed):

1. Register/login — ✅ safe (rate limits: 5 register/hour/IP; use sparingly)
2. Authenticated settings — ✅ (`GET /api/users/me`, `PATCH`, password change)
3. Subscription/plan status — ✅ (`GET /api/billing/me`; note: there is no supported way to set a non-free plan without direct DB access, so paid-gating smoke tests require a staging-DB fixture on `subscriptions`)
4. Strategy creation — ✅
5. Strategy limits — ⚠️ testable in principle but free cap is 100 strategies (high); recommend DB-fixture approach
6. Backtest limits — ⚠️ free cap 100/month; same recommendation
7. Saved setup limits — ⚠️ free cap 1000; same recommendation
8. Live scanner — ✅ requires a Pro/Premium subscription row; `POST /api/scanner/trigger` + `GET /api/scanner/health`
9. Market-data freshness — ✅ health endpoint reports `newestCandleTime`; `GET /api/market-data/candles` fetch-through (consumes provider credits)
10. Signal detection — ✅ workbench evaluate→detect flow (store-only, zero provider I/O)
11. Alert generation — ✅ (outbox job created; no external send unless SMTP configured)
12. Notification outbox — ✅ (`GET /api/alerts/:id/notifications`)
13. Notification worker — ✅ (in-process ticker, or internal endpoint with token; unconfigured SMTP ⇒ honest `unavailable`)
14. Alert acknowledgement — ✅ (idempotent)

---

## 17. Commercial Readiness Gaps

**Must fix before M8** (security / reliability / data-integrity / architecture):
1. Restore `npm run lint` to green (remove the two dead M7.4 imports — trivial, code change) **and add CI** enforcing typecheck + lint + tests + build on PRs; a lint-failing `main` merged twice in a row is a process failure.
2. Provide a sleep-safe scanner invocation (token-protected internal trigger analogous to the delivery worker) **or** make `SCANNER_ENABLED=true` on an always-on plan an explicit, documented production requirement and add `SCANNER_*` vars to `render.yaml`. As shipped, scanning silently stops whenever the API sleeps.
3. Add regression tests for subscription-status fallback (`canceled`/`expired` → free entitlements; `past_due` grace) before M8 layers automation entitlements onto the same function.

**Can be completed after M8** (non-critical product improvements):
- Owner-scoped scanner run listing (F4); advisory-unlock hardening (F5); atomic backtest-limit check (F15/F3 in numbering below — the backtest race); scanner efficiency (O(n²) evaluations, fetch volume); `scanner_runs` retention; legacy `users.plan` cleanup; notification preferences/channels; account deletion flow.

**Required for actual paid customers** (none of these block M8 development):
- **Real billing** (provider, checkout, portal, signed+idempotent webhooks, subscription sync, payment-failure handling) — today a user *cannot become* Pro/Premium at all.
- Legal pages: Terms of Service, Privacy Policy, risk disclaimers (trading-signal product), cookie notice.
- Support channel, status page, and error/uptime monitoring/APM (none exist; only structured logs + health endpoints).
- SMTP delivery actually configured in production (currently optional; unconfigured = alerts queued as `unavailable`).
- Twelve Data licensing check for user-facing display at commercial scale (Business/Venture+ per `docs/provider-licensing.md`).
- Vercel Static IPs (or accepted coarser rate-limit buckets) for per-browser rate limiting.

---

## 18. M8 Readiness Boundary

The M7 architecture provides a safe foundation for M8 with the caveats above:

- **Entitlement hook exists:** `canAccessAutomation` is modeled and universally `false`; M8's premium-only automation + explicit ON/OFF can build on `getEntitlements` and the `subscriptions` table (provider columns already reserved).
- **Risk foundation exists:** `riskConfigurationSchema` carries `minRr`, SL/TP methods, `minQualityScore`; M8's risk engine (position sizing, max loss, exposure caps, break-even/trailing, kill switch) has a natural home in per-version config + a new service — nothing in M7 pre-commits execution semantics.
- **No execution anywhere:** alerts are provably advisory (zero-I/O generation proofs, stub-sender refusal guard). No broker/MT5/Exness code exists — the boundary is clean.
- **Deterministic signal path intact:** M8 execution will consume deterministic setups/scores; no AI path to inherit or entangle.
- **Idempotency/durability patterns proven** (outbox, advisory locks, cursor ledgers) — the same patterns can be reused for order/position reconciliation and audit trails.
- **Fix before M8 merges** (not before M8 design): lint+CI (must-fix #1), scanner sleep-safety (must-fix #2), status-fallback regression tests (must-fix #3). The backtest-limit race (LOW) and remaining LOW items may land alongside M8 work.

---

## 19. Findings Register

| # | Severity | Finding |
|---|---|---|
| F1 | MEDIUM | No regression test for subscription status → entitlement fallback (`canceled`/`expired`/`past_due`/`trialing`) |
| F2 | LOW | Legacy `users.plan` column duplicates `subscriptions.plan` (returned in `UserDto`, ignored by entitlements) |
| F3 | MEDIUM | Scanner has no external-scheduler invocation path; scanning silently stops when the API process sleeps; `render.yaml` ships `plan: free` and no `SCANNER_*` vars |
| F4 | LOW | Scanner runs/health ledger is global to all paid users; metadata leaks other users' `triggeredBy`/`strategyId` UUIDs |
| F5 | LOW | Scanner advisory-unlock failure silently swallowed; could stall scans until connection recycling/restart |
| F6 | LOW | Provider-failure classification via error-message string matching (brittle, safe-degrading) |
| F7 | MEDIUM | All rate limits IP-keyed; via Vercel rewrite all users share buckets (incl. login 10/min) unless Vercel Static IPs are pinned — documented trade-off, unresolved |
| F8 | MEDIUM | `npm run lint` fails on `main` (2 unused-import errors introduced by M7.4) and no CI exists to catch it |
| F9 | LOW | Backtest monthly limit enforced non-atomically at the route layer (TOCTOU over-usage possible within rate-limit bounds), unlike other limits |
| F10 | LOW | `render.yaml` free plan: API spin-down halts worker + scanner tickers (~1 min wake latency); docs recommend paid plan but blueprint doesn't encode it |
| F11 | INFORMATIONAL | Billing is foundation-only — no payment provider exists; no path for a user to become Pro/Premium |
| F12 | INFORMATIONAL | Advanced-strategy/advanced-alert entitlement flags gate nothing (no such features exist); automation flag universally off — correct for pre-M8 |
| F13 | INFORMATIONAL | Free tier limits are generous; scanner is the only hard paywall |
| F14 | INFORMATIONAL | Scanner anchor uses latest (possibly forming) candle open time; signal math uses only closed candles — safe, semantically subtle |
| F15 | INFORMATIONAL | No retention for `scanner_runs`; no APM/metrics; email-only notifications; no user notification preferences; no account-deletion route; milestones.md/README not updated for M7.4/M7.5 (doc drift) |

No BLOCKER- or HIGH-severity defects were found.

---

M7 FINAL VERDICT

**Overall status:** READY FOR M8

BLOCKERS

- None.

HIGH

- None.

MEDIUM

- F1: No regression tests for subscription-status entitlement fallback (`canceled`/`expired`/`past_due`/`trialing`) — commercial-critical logic covered only indirectly.
- F3: Scanner cannot be invoked by an external scheduler; scanning silently stops if the API process sleeps; `render.yaml` declares no `SCANNER_*` vars and defaults to the spin-down-prone free plan.
- F7: Per-IP rate limits collapse into shared buckets for all users behind the Vercel rewrite (login 10/min becomes global) unless Vercel Static IPs are added to `TRUSTED_PROXY_CIDRS`.
- F8: `npm run lint` fails on `main` (2 pre-existing unused-import errors from M7.4 in `apps/api/src/routes/alerts.ts:11` and `apps/api/src/routes/strategies.ts:32`), and no CI pipeline enforces lint/typecheck/tests/build.

LOW

- F2: Legacy `users.plan` duplicates `subscriptions.plan`.
- F4: Scanner run ledger not owner-scoped; cross-user UUID exposure in metadata.
- F5: Scanner advisory-unlock errors silently swallowed; potential lock leak on pooled connection.
- F6: Provider-failure/timeout detection via string matching on error messages.
- F9: Backtest monthly limit check is non-atomic (route-level TOCTOU), unlike strategy/setup/alert limits.
- F10: Blueprint's Render free-plan choice halts all in-process background work on spin-down.

INFORMATIONAL

- F11: Billing = foundation only; **no real payment provider exists**; no checkout/portal/webhooks; no path for a user to become Pro/Premium.
- F12: Advanced-strategy/advanced-alert entitlement flags gate nothing yet; `canAccessAutomation` is universally false with no automation code path — automation correctly unavailable until M8.
- F13: Free-tier limits are generous (100 strategies, 100 backtests/mo, 1000 alerts/mo, 1000 setups); scanner is the only hard paywall.
- F14: Scanner detection anchor is the latest (possibly forming) candle's open time; evaluation only ever consumes fully closed candles — no signal impact.
- F15: No `scanner_runs` retention; no APM/metrics; email is the only notification channel; no notification preferences; no account-deletion route; README/milestones.md lag M7.4/M7.5 (doc drift); register endpoint permits email enumeration (login does not); 0014 backfill is not replay-idempotent by itself (runner guarantees one-shot).

Production dependencies

- Always-on API container (Render `starter` or equivalent) for the scanner ticker and delivery-worker ticker — or accept manual-only scanning.
- Managed Postgres 14+ with `DATABASE_SSL_MODE=require` (prefer `verify-full`).
- `TWELVE_DATA_API_KEY` (Business/Venture+ plan for commercial user-facing display per docs/provider-licensing.md).
- SMTP credentials (`SMTP_HOST/PORT/USER/PASS` + `NOTIFICATION_FROM`) for real email delivery; absent ⇒ alerts honestly queue as `unavailable`.
- `API_INTERNAL_BASE` (HTTPS API origin) on Vercel — build fails loudly without it.
- Optional: `NOTIFICATION_WORKER_TOKEN` + external cron for sleep-safe outbox draining.
- Optional (recommended): Vercel Static IPs added to `TRUSTED_PROXY_CIDRS` for per-browser rate-limit attribution.

Missing environment variables

- `SCANNER_ENABLED` (and optionally `SCANNER_INTERVAL_MS`) — absent from `render.yaml`; without it the deployed blueprint never auto-scans.
- No billing variables exist yet (none are defined in code) — required once a payment provider is chosen.
- No APM/monitoring variables (no such integration exists).

Existing pre-production issues

- `npm run lint` red on `main` (2 unused imports from M7.4).
- No CI pipeline (`.github/workflows` absent) — lint/typecheck/tests/build not enforced on PRs.
- Scanner sleep-safety gap (no external invocation path).
- Backtest limit race; scanner run ledger cross-user metadata; advisory-unlock swallow; string-matched provider-failure classification; legacy `users.plan`.

Required fixes before M8

- Fix the two unused imports so `npm run lint` passes (tiny code change; audit-only scope prevented doing it here).
- Add CI enforcing typecheck + lint + tests + production build on pull requests.
- Add a sleep-safe scanner trigger (token-protected internal endpoint) or codify `SCANNER_ENABLED=true` on an always-on instance as a hard production requirement (update `render.yaml`).
- Add regression tests for `getEntitlements` status fallbacks (canceled/expired → free; past_due/trialing → paid) before M8 extends the entitlement surface.

Safe to begin M8?

- YES
- The M7 foundation is architecturally sound for M8: server-authoritative entitlements with an explicit automation placeholder, a deterministic signal pipeline the scanner already exercises end-to-end, proven idempotency/durability patterns (outbox, advisory locks, cursors), zero execution surfaces, and no AI in the signal path. The four "required fixes" are small and can be completed before (or, for the last three, alongside) the first M8 merge; none of them requires reworking any M7 subsystem.

Validation results

- Tests: **PASS — 735/735** (contracts 73, core 262, provider-twelve-data 33, api 200, web 167), 0 failures, real embedded Postgres.
- Typecheck: **PASS** (all 5 workspaces, exit 0).
- Lint: **FAIL — 2 pre-existing errors** (`getBillingState` unused in `apps/api/src/routes/alerts.ts:11` and `apps/api/src/routes/strategies.ts:32`, introduced by M7.4/PR #17, acknowledged as pre-existing in M7.5 docs; 0 new errors from M7.5/PR #18).
- Production build: **PASS** (API typecheck build + Next.js 15 production build compiled successfully, 17 pages).

Final recommendation

The M7 implementation provides a sufficient technical foundation to begin M8. Authentication, authorization, entitlement enforcement, market-data integrity, deterministic signal generation, alert delivery, and migration safety were all verified against the code and are covered by 735 passing tests. No blocker- or high-severity defects were found. The repository is not perfectly clean — `npm run lint` fails with two pre-existing unused imports, there is no CI to prevent recurrence, the scanner lacks a sleep-safe external trigger, and subscription-status fallbacks lack direct regression tests — but each is a small, well-understood fix that does not threaten the M7 architecture. Billing remains foundation-only with no payment provider, which is the dominant commercial gap before accepting real paying customers, but it does not block M8 development. Recommendation: proceed to M8, sequencing the four required fixes (lint fix, CI, scanner invocation path, entitlement-fallback tests) at or before the first M8 merge.
