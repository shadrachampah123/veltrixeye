# Live Scanner — Production Market Flow (M7.5)

M7.5 turns the explicitly-invoked detection path (M4) into a production scanner that processes **real market data** through the complete existing strategy pipeline:

```
Market Data
→ Normalization
→ Validation/Freshness Checks
→ Strategy Detection
→ Setup Qualification
→ Scoring
→ Risk/Quality Validation
→ Alert Generation
→ Notification Outbox
```

## Production Market-Data Provider

**Provider in production: Twelve Data (historical OHLCV)**

- Implementation: `packages/providers/twelve-data` — `TwelveDataProvider` implements `MarketDataProvider` (historical only, `realtime: false`)
- Registered at boot when `TWELVE_DATA_API_KEY` is set (server-side only, never logged, never sent to browsers)
- The API boots without a key (dev/test or unkeyed deploy) and market-data routes answer 502 until a key is set
- All 14 canonical timeframes served: native vendor intervals where they exist (1m…1M), deterministic epoch-aligned resampling otherwise (3m ← 1m, 12h ← 1h, 3d ← 1d)
- Crypto series pinned to one venue (`TWELVE_DATA_CRYPTO_EXCHANGE`, default `Binance`) so stored series is deterministic
- No mock/demo data is ever substituted in production — provider must exist, otherwise scanner reports `unavailable`
- Development/test fixtures are clearly distinguished: `MockProvider` in tests, never used in production code path

See `docs/provider-abstraction.md` and `docs/market-data.md` for the abstraction and licensing.

## Scanner Execution Mechanism / Frequency

**Mechanism:**

- Database-backed advisory locking: `pg_try_advisory_lock(875421009)` — pinned key `SCANNER_ADVISORY_LOCK_KEY`
- Advisory lock ownership hardening (M7 audit finding F5, extended by the
  `unlock_returned_false` / `scan skipped: already running` investigation — see
  [Advisory lock ownership hardening](#advisory-lock-ownership-hardening)
  below): acquire and release are pid-stamped, ownership is proven immediately
  after acquisition and re-proven by a heartbeat during the run, and any
  unprovable state is logged with sanitized diagnostics (no credentials,
  tokens, or tenant/strategy UUIDs) while the pooled client is terminated and
  evicted (`release(true)`) so a leaked session-level lock can never block
  future scans
- Only one scanner run executes at a time across all processes/instances; concurrent triggers return `skipped: true, reason: 'already_running'` with last run info
- Runs are recorded in `scanner_runs` table (append-only ledger): status `running → completed|failed|partial`, provider slug, metrics, error, metadata
- Cursors in `scanner_cursors` table: per `(strategy_version_id, instrument_id, timeframe)` last processed closed candle open time — prevents re-processing same closed candle, survives restarts
- MTF anchor alignment (M7 audit finding F14): detection and scoring anchor `asOfMs` to the **close time** (`time + period`) of the latest fully-closed setup candle (`c.time + setupPeriodMs <= nowMs`), never a forming bar's open or future close (zero lookahead, aligned with backtest anchor semantics)
- Recovery on restart: `recoverStaleRuns()` marks runs older than 30 minutes that are still `running` as `failed` (crash/deploy safety)
- In-process ticker (optional): when `SCANNER_ENABLED=true`, the API starts an interval timer (`SCANNER_INTERVAL_MS`) that calls `scanner.runOnce()` — safe to run alongside manual triggers due to advisory locking
- Manual trigger via `POST /api/scanner/trigger` (session-authenticated, entitlement-gated, rate limited 10/min)

### Advisory lock ownership hardening

`pg_try_advisory_lock` is **session** state: the lock belongs to the server
backend that took it, not to the client object and not to the logical job. The
production symptom set `scanner advisory unlock failed` /
`unlock_returned_false` / `scan skipped: already running` (and the identical
warm-cycle messages) is consistent with that identity being lost or
unverifiable. `packages/core/src/db/advisory-lock.ts` therefore implements a
single, shared, hardened path used by both the scanner and the scheduled
warm cycle:

| Guarantee | How |
|---|---|
| **Ownership is recorded atomically** | `SELECT pg_backend_pid(), pg_try_advisory_lock($1)` — the pid returned *is* the pid that evaluated the acquire |
| **Ownership is proven before the job runs** | the lock must be visible in `pg_locks` for that same pid (`classid/objid` reconstruction of the bigint key); otherwise the cycle refuses to run and the session is evicted |
| **Losing ownership mid-run fails closed** | a heartbeat re-verifies every `min(leaseMs / 4, 60 s)` (min 1 s, disabled at `0`) and the run is aborted at the next strategy boundary; **the terminal status decision re-verifies ownership synchronously**, so no run is ever recorded `completed`/`partial` without a fresh proof. Aborts raise a `conflict` error and log `scanner advisory lock lost while scanning`. The 60 s cap matters: at the production lease (`SCANNER_LEASE_MS=1800000`) `leaseMs / 4` is 7.5 minutes, which would let a scan keep working long after its session died |
| **An inherited lock is never re-acquired** | before acquiring, the session is asked whether it *already* holds the key. Advisory locks are re-entrant per session, so acquiring on top of a leaked level would return `true`, let two jobs run "exclusively", and leave one level behind after a single unlock. The acquire refuses (`already_owned`) and the session is evicted without stacking a level |
| **Release outcomes are classified** | `released` / `not_owned` (`unlock_returned_false`) / `session_changed` (release evaluated on a different backend) / `still_held` (unlock returned true but the key survives — a stacked level) / `query_error`; every non-clean outcome destroys and evicts the session |
| **A release is proven, not assumed** | `pg_advisory_unlock` answers "one level removed", so a successful unlock is followed by an ownership proof; if the key is still visible on the session the result is `still_held` and the session is destroyed |
| **Every terminal success path proves ownership** | the proof runs synchronously before the final status decision **and** before the early "no eligible strategies" success return, so a zero-work run can no longer be recorded `completed` after the lock was lost |
| **Contention is actionable** | the skip log names the holder: `holderPid`, `holderState`, `holderIdleMs`, `holderSuspectedOrphaned` |
| **An acquire failure cannot leak a lock** | an error thrown by the acquire statement evicts the session (the server may have applied the lock before the connection died) — the scanner previously returned that session to the pool intact |

Why `session_changed` matters: a transaction-mode connection pooler (PgBouncer,
or Neon's `-pooler` endpoint) can serve two statements of one client from two
backends. The acquire then succeeds on backend A while the release runs on
backend B and returns `false`, leaving A's lock orphaned — the exact shape of a
permanent `already running`. The pid comparison detects this instead of
reporting a mysterious unlock failure, and the run refuses to proceed without a
proven lock.

### Session-pinned connection requirement (production)

Session-level advisory locks only work if the connection that acquires the lock
is the connection that later releases it and re-proves ownership. The scanner
and the warm cycle therefore require a **session-pinned** PostgreSQL
connection:

- **Supported:** a direct connection to PostgreSQL, or a pooler in **session**
  mode (PgBouncer `pool_mode=session`).
- **Not supported:** **transaction-mode** pooling (PgBouncer
  `pool_mode=transaction`, and Neon's `-pooler` endpoint). There, consecutive
  statements of one client may run on different backends; the lock survives on
  the acquiring backend while the release reports `false`.
- **How it is detected (no guessing):** the helper compares
  `pg_backend_pid()` between the pre-check, the acquire, the heartbeat and the
  release. Any change is reported as `session_changed` and the cycle refuses to
  run rather than overlapping — a visible skip, never silent duplication.
- **Operator action if it appears:** point the database connection used by the
  API/worker at a non-pooled (or session-pooled) endpoint, or configure session
  pooling for that connection. This is a deployment decision for the owner; no
  code path bypasses the check, and the service never falls back to "run anyway".
- **Assumption:** ownership proof reads `pg_locks`, and advisory locks are
  visible there for the acquiring backend on the PostgreSQL versions exercised
  by the regression suite. If a future server version hid them, the acquire
  would fail closed (`not_owned`) rather than run unguarded — loud, not silent.

No credentials, connection strings or hostnames are logged by any of these
paths; diagnostics carry pid, `pg_stat_activity` state and state age only.

**Frequency:**

- Expected interval: **5 minutes** (`SCANNER_EXPECTED_INTERVAL_MS = 300_000`)
- Configurable via `SCANNER_INTERVAL_MS` (30s–1h, default 5m)
- Actual frequency depends on deployment: if `SCANNER_ENABLED=false` (dev default), scanner only runs when manually triggered; in production, enable with `SCANNER_ENABLED=true`
- The scanner itself does not enforce a cron — it is invoked by the ticker or external scheduler; advisory locking ensures no overlapping duplicate scans

### Orphan detection (and why an idle session is not a dead scanner)

`suspectedOrphaned` is **diagnostic only**: nothing is terminated automatically.
It is set when, and only when, the holder backend is in `pg_stat_activity` state
`idle` **and** has been in that state for at least the orphan threshold. A
session that is `active`, `idle in transaction`, or whose `pg_stat_activity`
row is unreadable (`holderDetailsUnavailable: true`) is never called an orphan.

The threshold is **not** a fixed 120 s. It is derived together with the
heartbeat (`deriveAdvisoryLockTiming` in `packages/core/src/db/advisory-lock.ts`):

| Value | Rule | Production value |
|---|---|---|
| Heartbeat | `min(leaseMs / 4, 60 s)`, floor 1 s, `0` disables | `60 s` (lease `1800000`) |
| Orphan threshold | `max(120 s, 2 × heartbeat)` unless explicitly overridden | `120 s` |

The `2 × heartbeat` floor is the important part. A **healthy** long-running scan
looks like an idle session between two heartbeats: its only activity is one
`pg_locks` read per heartbeat, so for almost the whole period `pg_stat_activity`
reports `idle`. If the threshold were shorter than a heartbeat, a live scan
would be labelled a suspected orphan for part of every period — which is exactly
what the earlier `leaseMs / 4` heartbeat with a fixed 120 s threshold did (450 s
heartbeat vs 120 s threshold: ~73 % of every period a healthy scan looked
abandoned). With one derivation for both values that can no longer happen: a
session is only flagged once it has been idle for at least two missed
heartbeats.

How to read the flag:

- **`holderSuspectedOrphaned: false`** — the holder checked in within the last
  two heartbeat periods. It is alive; the skip is ordinary contention.
- **`holderSuspectedOrphaned: true`** — the holder has not run a heartbeat for
  at least two periods. *Likely* abandoned (killed process, suspended compute,
  connection dropped without a clean unlock), but still only a suspicion: the
  session may be blocked in a long statement whose `pg_stat_activity` snapshot
  is stale. Confirm before restarting anything with the read-only query below.
- Anything else — `holderDetailsUnavailable`, or no holder at all despite a
  failed acquire — means the diagnosis is incomplete; do not read it as "dead".

Diagnose a held lock without changing anything (read-only, safe to run while the
API is live):

```sql
SELECT l.pid,
       ((l.classid::bigint << 32) | l.objid::bigint) AS key,
       a.application_name,
       a.state,
       now() - a.state_change                       AS idle_for,
       a.backend_start,
       a.client_addr
  FROM pg_locks l
  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.locktype = 'advisory'
   AND l.granted
   AND ((l.classid::bigint << 32) | l.objid::bigint)
       IN (875421009, 875421010, 875421011)
 ORDER BY l.pid;
```

Reading it: `875421009` is the scanner, `875421010` the FX source, `875421011`
scheduled ingestion — three different subsystems, so a row here tells you *which*
one is holding. `backend_start` older than the last restart means a session that
outlived its process (stale); a steadily growing `idle_for` past two heartbeats
means a stuck session; a short-lived holder that appears exactly when an
`already held` message is logged means ordinary contention, not a leak.

Session teardown always releases the lock, so evicting a session (which this
codebase does only on unprovable ownership, never on a suspicion) is the only
recovery primitive used. A genuinely orphaned lock from a *previous* process
cannot be reaped by killing a session that no longer exists — restart the
holder's compute or let it time out.

**Duplicate Prevention:**

- **Scanner-level:** advisory lock + cursor check — if latest setup timeframe candle time equals `scanner_cursors.last_candle_time`, skip instrument
- **Setup-level:** `setups` table unique key `(strategy_version_id, instrument_id, direction, as_of_ms)` — `ON CONFLICT DO NOTHING`, concurrent duplicates serialize, loser returns winner's row, exactly one setup per detection key
- **Alert-level:** `alerts` table unique key `(setup_id, trigger_state)` — at most two alerts per setup (`confirmed` + `triggered`), replays return existing alert, no second ledger row
- **Notification-level:** `notification_deliveries` unique key `(alert_id, channel)` — one outbox job per alert and channel, replays collapse

**Failure/Retry Behavior:**

- Provider timeout: wrapped in `withTimeout(providerTimeoutMs)`, throws `Provider timeout after Xms`, retried with bounded exponential backoff
- Provider errors: `rate_limited`, `unavailable`, `unauthorized`, `not_found`, `invalid_request` mapped to domain errors; retryable failures retried up to `SCANNER_MAX_RETRIES` (default 3) with base `1s`, max `10s`, jitter 500ms
- Malformed provider response: `toCandle` validates every bar (finite, positive, OHLC invariant, non-negative volume); invalid bar throws `ProviderError('unavailable')`, fails the call loudly, no partial persistence
- Missing symbol: validated against `instruments` table (platform universe); arbitrary unsupported symbols rejected with 400 `Unsupported instrument — not in market universe`
- Stale data: checked via `checkFreshness` and `checkMultiTimeframeFreshness` — stale data never generates alerts, counted as `stale_rejections`, logged for observability
- Database failure: transaction rollback, run marked `failed` or `partial`, error recorded, no alert created when required data cannot be trusted
- Scanner worker restart: stale `running` runs recovered at boot, cursors survive restart, advisory lock released on disconnect
- Avoid runaway retries: bounded retry count, exponential backoff capped, no infinite loops, `MAX_PAGES_PER_CALL` guard in provider

## Symbols / Timeframes Supported

**Symbols (market universe, from migration 0002):**

- `forex/EURUSD`, `forex/GBPUSD`, `forex/USDJPY`
- `commodity/XAUUSD` (Gold)
- `index/SPX500` (excluded from ingestion due to licensing, but exists in universe)
- `crypto/BTCUSD`, `crypto/ETHUSD`
- `stock/AAPL`
- `etf/SPY`

Users cannot select arbitrary unsupported provider symbols to bypass the market universe — symbols are validated against `instruments` table, and provider-specific tickers live only in `instrument_provider_symbols`.

**Timeframes (canonical, from `TIMEFRAMES`):**

- `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`

**Strategy requirements (preserved):**

- HTF: `4h` / `1d` (higher-timeframe bias)
- Setup: `1h` (setup timeframe)
- Entry: `15m` / `5m` (entry timeframe)

Scanner supports the full canonical set but enforces that a strategy version has valid `htf_bias`, `setup`, `entry` timeframes assigned (normalized via `normalizeTimeframe` handling variants like `4H`, `1D`, `60m`).

**Normalization:**

- Symbol identifiers: uppercase, regex `/^[A-Z0-9][A-Z0-9._:-]*$/`, max 32 chars, asset class validated against `ASSET_CLASSES`
- Exchange/provider symbol formats: `toTwelveSymbol` / `fromTwelveSymbol` in provider package (e.g., `EURUSD` → `EUR/USD` for Twelve Data)
- Timeframe identifiers: `normalizeTimeframe` handles `1m`, `4H`, `1D`, `60m` → canonical `1m`, `4h`, `1d`, `1h` via `TIMEFRAME_ALIASES` and contract parser
- Timestamps: epoch milliseconds UTC, positive integer, max `9_999_999_999_999`
- OHLCV values: positive finite numbers, OHLC invariant `low ≤ open/close ≤ high`, volume null or non-negative finite, impossible prices >1e9 rejected

## Stale-Data Policy

**Never generate a trading alert from invalid or stale market data.**

- Thresholds per timeframe (`STALE_THRESHOLDS_MS`):
  - `1m`: 5m, `3m`: 10m, `5m`: 15m, `15m`: 45m, `30m`: 90m
  - `1h`: 2h, `2h`: 4h, `4h`: 8h, `8h`: 16h, `12h`: 24h
  - `1d`: 36h, `3d`: 4d, `1w`: 8d, `1M`: 35d
- Freshness check: `nowMs - latestCandleTime` vs threshold; future candles (clock skew) also rejected
- Multi-timeframe: all required timeframes must be fresh; HTF context missing, setup timeframe missing, or entry timeframe missing → stale rejection, no alert
- Incomplete responses: if requested range much larger than actual and received count <10, flagged as `incomplete_candle_response`
- Stale rejections are recorded in `scanner_runs.stale_rejections` and logged with structured info (instrument, timeframe, age, reason) without secrets
- Provider latency/failure also logged: `provider latency`, `provider failure`, `stale data rejected`, `detection counts`, `alert creation`, `scanner errors`

## Observability

Structured operational information (no secrets, no excessive raw payloads):

- Scan start/completion: `scan started` with runId, provider, strategyId, force, nowMs; `scan completed` with status, strategiesScanned, instrumentsScanned, setupsDetected, setupsCreated, alertsCreated, staleRejections, providerFailures, durationMs
- Provider latency/failure: `provider fetch failed, retrying` with instrument, timeframe, attempt, delayMs, error; `duplicate candles detected`, `out-of-order candles detected`
- Symbols/timeframes processed: stored in `scanner_runs.symbols_processed` (jsonb array) and `timeframes_processed`
- Stale-data rejection: `stale data rejected` with instrument, reason, ages; `multi-timeframe validation failed`
- Detection counts: `setupsDetected`, `setupsCreated` per run
- Alert creation: `alert created from live scan` with strategyId, setupId, alertId, instrument, direction, qualityScore
- Scanner errors: `strategy scan failed`, `instrument scan failed`, `scan failed` with error message

Logs never contain API keys, credentials, tokens, sensitive user data, or full provider secrets — redaction via `redactSecrets`.

### Candle-source counters (Phase A)

Candle accounting is attributed to the path that actually loaded the candles, so an operational view can tell "no candles were available" apart from "candles were loaded and nothing qualified":

| Counter | Meaning |
|---|---|
| `scanner_runs.candles_fetched` | **Total** candles handed to the pipeline this run (`store + provider`). This is the Scanner UI's "Candles" metric |
| `metadata.candles.store` | **Closed** candles served by the shared `candles` store fast path (read, normalized, validated, fresh). The currently forming candle is excluded, so this is the count the pipeline can actually act on |
| `metadata.candles.provider` | Candles returned by the market-data provider (fetch-through), counted exactly as the **batch came back** — including any still-forming candle the provider served. This is the historical meaning of `candles_fetched` |
| `metadata.candles.total` | Same value as `scanner_runs.candles_fetched`; always equal to `store + provider` |
| `metadata.duplicateCandleSkips` | Instrument pairs skipped (cursor hit) because the setup candle had already been processed — one per skipped instrument pair, not per direction evaluation |

Rules:

- Every candle is counted **exactly once**, on the path that loaded it, through a single funnel — `total === store + provider` is therefore an invariant, not a coincidence.
- Per-cycle cache hits are re-uses of a batch another pair already counted, so they add nothing: a second strategy scanning the same instrument × timeframe reports the same totals, not double.
- Counters are **per run** and never cumulative.
- The two sources are **not comparable candle for candle**: the store path counts closed candles only (the forming candle is filtered out before counting), while the provider path counts the batch exactly as returned. The same instrument × timeframe can therefore report `store = N` and `provider = N + 1`; that difference is the forming candle, not an accounting error.
- `duplicateCandleSkips` increments **once per skipped instrument pair**, not once per direction evaluation: a single skipped pair prevents both of its directions from being re-evaluated on an already-processed candle.
- A cursor-skipped run still reports its loaded candles (the fetch precedes the cursor check) **and** `duplicateCandleSkips ≥ 1`, which is what makes a skip distinguishable from a failed evaluation.
- These counters are non-identifying, so they survive tenant metadata redaction (unlike `errors`/`strategyId`/`triggeredBy`).

### Per-pair evaluation outcomes (Phase B)

Cursor skips and evaluations used to be indistinguishable in the ledger: a run
that skipped every pair (because no new setup candle had closed) looked exactly
like a run that evaluated every strategy and found nothing. Phase B records one
**mutually exclusive** outcome per (strategy, instrument) pair in
`scanner_runs.metadata.pairs`, so "nothing was evaluated" can never be reported
as "everything was evaluated and nothing matched".

| Outcome | Meaning | Carries condition counts? |
|---|---|---|
| `evaluated` | The pair reached M3 (`setups.detect`) for both directions | **Yes** |
| `cursor_skipped` | The closed setup candle at `cursorMs` was already processed for this pair (`scanner_cursors` hit). An idempotent no-op — **not** an evaluation | No |
| `stale` | Rejected before evaluation: `mtf_invalid`, a `{htf,setup,entry}_stale_candle` freshness reason, or `no_closed_candle` | No |
| `failed` | An error aborted the pair; `reason` is a bounded cause code (`rate_limited`, `provider_unavailable`, a domain error code, or `error`) | No |

Shape (additive jsonb, `v: 1`):

```json
"pairs": {
  "v": 1,
  "totals":     { "pairs": 10, "evaluated": 0, "cursor_skipped": 10, "stale": 0, "failed": 0 },
  "conditions": { "satisfied": 0, "unsatisfied": 0, "insufficient_data": 0, "unsupported": 0 },
  "truncated": false,
  "items": [
    { "strategyId": "…", "assetClass": "commodity", "symbol": "XAUUSD", "timeframe": "1h",
      "outcome": "cursor_skipped", "cursorMs": 1762711200000, "anchorMs": 1762714800000,
      "reason": "cursor_hit" }
  ]
}
```

Rules:

- **Mutually exclusive, always reconciled.** Exactly one observation is recorded per pair walked, on every exit path (including a throw), so `evaluated + cursor_skipped + stale + failed === totals.pairs`. `metadata.duplicateCandleSkips` is now **derived** from `totals.cursor_skipped` rather than counted separately, so the historical counter and the per-pair detail cannot drift.
- **Totals are never computed from `items`.** `items` is a bounded sample (≤ `SCANNER_RUN_PAIR_ITEMS_MAX` = 200); `totals`/`conditions` always cover **every** pair, and `truncated` says whether the sample is partial.
- **The sample is deterministic**: the first 200 observations ordered by `(assetClass, symbol, timeframe, strategyId, outcome)` — a content-derived order, independent of strategy iteration order, so the same run always persists the same sample.
- **`conditions` covers evaluated pairs only.** A skip, a stale rejection and a failure contribute nothing; summing them would misreport an unevaluated pair as an evaluated one. The four counters come from the engine's per-condition statuses, aggregated across both directions, and are only collected when the scanner calls `setups.detect({ includeDiagnostics: true })` — the M4 HTTP endpoint does not, so its response is unchanged.
- **`failureReasons` is `evaluated`-only** (max 2 per pair, 160 chars each) and is sanitized with `sanitizeScannerError(..., redactUuids = true)` before storage: no strategy UUIDs, keys, tokens or URLs.
- **Redaction is recursive.** `redactScannerRunMetadata` now strips `triggeredBy`, `strategyId`, `versionId`, `errors` and `failureReasons` **at any depth**, so the owner sees which strategy produced each pair while every other viewer (including anyone reading a system run through `getHealth`) sees counts only.

**Runs recorded before Phase B:** they carry no `metadata.pairs` key at all.
`readScannerRunPairs(metadata)` returns `null` for them (and for a malformed or
future-version block) — render "detail unavailable", never "zero pairs". No
backfill is performed.

**Runs recorded before Phase A (historical metadata):** rows written before these counters existed carry **no** `metadata.candles` object and no `metadata.duplicateCandleSkips`. Their `scanner_runs.candles_fetched` values keep their historical, provider-only meaning; nothing is rewritten or backfilled. Treat a missing `metadata.candles` key — not a zero — as the marker of a pre-Phase-A run, and note that `metadata.candles.total === candles_fetched` only holds for runs recorded after this change.

## API / UI

**API (session-authenticated, entitlement-gated):**

- `GET /api/scanner/health` — real production state: status `idle|running|degraded|unavailable`, lastRun, lastSuccessfulRun, provider, isProviderAvailable, expectedIntervalMs, activeRuns, recentFailures, dataFreshness (newestCandleTime, staleRejectionCount)
- `GET /api/scanner/runs?status=&limit=` — list recent runs (observability), **owner-scoped**: only runs the session user initiated
- `POST /api/scanner/trigger` — manual trigger with optional `strategyId`, `instruments` (validated against universe), `force` boolean; uses advisory locking, returns 201 created or 200 skipped; rate limited 10/min; audited as `scanner.triggered` / `scanner.trigger_skipped`

All session endpoints check `canAccessScanner` entitlement server-side (free → 403).

**Internal worker API (F3: token-protected, sleep-safe external scheduler invocation):**

- `POST /api/internal/scanner/run` — recovers stale running scans (`started_at < now - leaseMs`), then executes one system scan under PostgreSQL advisory lock `SCANNER_ADVISORY_LOCK_KEY` (875421009). Accepts strict JSON `{ force?: boolean, leaseMs?: number }`; returns operator-redacted `{ run, skipped, reason?, recovered }`.
- `POST /api/internal/scanner/maintenance` — recovers stale running scans, then prunes terminal `scanner_runs` older than `SCANNER_RUN_RETENTION_DAYS` (F15; bounded, counts-only log, response shape unchanged), and returns bounded operational health `{ recovered, activeRuns, recentFailures, status, isProviderAvailable }` without tenant identifiers or provider secrets.
- Both internal routes require `x-veltrixeye-worker-token: <SCANNER_WORKER_TOKEN>` (validated in constant time over SHA-256 digests; session cookies alone return `401`) and return `404` when `SCANNER_WORKER_TOKEN` is unset. Rate limited 30/min.
- In-process `startScannerWorkerTicker` (`apps/api/src/scanner-worker.ts`) runs the same `runWorkerOnce()` + periodic `runMaintenance()` cycle with in-process overlap protection, unref'd timers, and a `stop()` method that awaits both the active tick and `ScannerService.waitForInFlight()` before shutdown closes the database pool.

**UI (minimal, no dashboard redesign):**

- New page `/scanner` — shows health/status, last successful scan, data freshness, active/error state, last run detail (strategies, instruments, candles, detections, alerts, stale, failures, symbols, timeframes, duration, error), and recent runs list
- Added to navigation as "Live Scanner" with icon `◐`
- Dashboard banner updated? No — preserved existing M2 banner, scanner UI is separate page
- Scanner status reflects real production state, not mock/static

## Security

- Provider credentials remain server-side: `TWELVE_DATA_API_KEY` never logged, never returned by any route, only used in provider client
- Users cannot select arbitrary unsupported provider symbols to bypass market universe: `normalizeSymbol` + `instruments` table check, 400 on unsupported
- Scanner endpoints remain authenticated/authorized: session auth required, 401 unauthenticated, 403 free users, strategy ownership check for filtered scans
- Scanner run ledger is tenant-private (M7 audit finding F4): `scanner_runs` is a single global table whose `metadata` holds `triggeredBy` (user UUID) and `strategyId` (strategy UUID), so `ScannerService.listRuns(query, viewerUserId)` filters rows to the caller's own runs, and `ScannerService.getHealth(viewerUserId)` — which stays global because the scanner is one shared pipeline — runs the embedded `lastRun`/`lastSuccessfulRun` DTOs through `redactScannerRunMetadata`, dropping `triggeredBy`, `strategyId` and `errors` (entries embed `strategy <uuid>: …`) unless the run belongs to the viewer. System runs (`triggeredBy = 'system'`) belong to no tenant and are never returned to one. Omitting `viewerUserId` keeps the previous unscoped behaviour for trusted in-process/operator callers; no HTTP route does so, and the architecture defines no admin role.
- Redaction is **recursive** (Phase B): `metadata.pairs.items[]` carries a `strategyId` and the engine's `failureReasons` for that strategy, so a top-level-only filter would have leaked them through `getHealth` (global) and the operator/scheduler responses. `redactScannerRunMetadata` walks the whole metadata tree (bounded depth, array-safe, never mutating its input) and drops `triggeredBy`, `strategyId`, `versionId`, `errors` and `failureReasons` at any depth for anyone who does not own the run. Non-identifying counts (`totals`, `conditions`, `candles`, `symbols`, `timeframes`) survive, which is what makes a system run shareable at all.
- Subscription limits remain server-authoritative: `getEntitlements(plan, status)` checked in scanner service and API routes, `maxSavedSetups` enforced in `SetupService`, `maxAlerts` etc. enforced
- No client-controlled signal generation is trusted: scanner generates signals server-side only from validated, fresh, normalized production data; alert payload rendered from persisted alert + published version config, never from request input

## Scope Boundary (M7.5 is strictly production market-data and scanner pipeline)

**DO NOT implement (belongs to M8):**

- Automated trading, broker orders, MT5 execution, Exness execution, live order placement, portfolio execution, M8 risk engine, M8 kill switch

## Testing

Comprehensive tests added:

- `packages/core/test/scanner.test.ts` — unit + integration:
  - Symbol & timeframe normalization (valid, invalid asset class, malformed symbol, variants like 4H/1D/60m, unsupported timeframe, valid/invalid OHLCV, duplicate/out-of-order detection in batch)
  - Data freshness & integrity (valid data, empty response, duplicate, out-of-order, invalid OHLC, zero prices, stale, future, multi-timeframe correlation requires all timeframes, multi-timeframe freshness rejects stale setup)
  - Provider failure handling (timeout with bounded retry, failure does not generate alerts, recovery after failure)
  - Scanner execution & concurrency (advisory locking prevents overlapping, duplicate prevention via cursors, restart/recovery marks stale running as failed, health reflects real state, listRuns)
  - Security & entitlements (free cannot access, pro can, rejects unsupported symbols, credentials not exposed in health)
  - Observability (metrics without secrets)
  - F4 tenant privacy (`describe('F4: Scanner tenant privacy')`): `redactScannerRunMetadata` pure unit tests (own run passes through, other-tenant and system runs drop `triggeredBy`/`strategyId`/`errors`, input not mutated), `listRuns(query, viewerUserId)` owner scoping (own run visible, other tenant's run + their user/strategy UUIDs absent, system runs hidden, `status` filter composes with scoping, unscoped read still returns the whole ledger), `getHealth(viewerUserId)` redaction (global last run kept, tenant identifiers dropped, own identifiers preserved), and a real `triggerScan` run being visible to its owner only
  - F5 advisory unlock reliability (`describe('F5: Advisory unlock reliability')`): `sanitizeScannerUnlockError` pure unit tests (preserves safe message/code, redacts URL credentials, bearer tokens, key-value secrets and tenant/strategy UUIDs, bounds length), clean unlock returns pooled client intact without error logs, thrown unlock query error and native PostgreSQL `25P02` aborted-transaction unlock error and `unlocked: false` response are logged safely without secrets or tenant UUIDs, evict/destroy the pooled connection (`release(true)`), clear the session-level advisory lock in `pg_locks`, allow immediate subsequent scans to recover, and preserve single-instance advisory-lock skipping when held
  - F14 MTF anchor alignment (`describe('F14: MTF anchor alignment (no lookahead)')`): forming tail setup candle is excluded so detection anchors at the close (`time + period`) of the latest fully-closed setup candle (`<= nowMs`, never a future close), cursor stores the open of that closed candle and re-arms on roll, and all-closed setup batches anchor at the latest candle's close matching backtest semantics

- `packages/contracts/test/scanner-pairs.test.ts` — Phase B contract:
  - the four pair outcomes are mutually exclusive and must sum to `totals.pairs` (a disagreement is rejected);
  - an unknown outcome, a future `v`, and a malformed block are rejected; `readScannerRunPairs` returns `null` (never a throw, never "zero pairs") for historical/absent/malformed metadata;
  - a truncated run keeps `totals.pairs = 250` with exactly `min(cap, pairs)` items, and a short sample is rejected;
  - `conditionSummary` is an optional addition: a detection item without it still validates, so the M4 response shape is unchanged.

- `packages/core/test/scanner-observability.test.ts` — Phase B integration (own embedded database):
  - B1 a cursor skip records `cursor_skipped` with **no** condition counts and **no** engine reasons, and `metadata.duplicateCandleSkips` is derived from `totals.cursor_skipped`; a no-op run stays `completed` with 0 detections;
  - B2 an evaluated pair aggregates both directions' condition statuses and caps reasons at 2 per pair; engine reasons are sanitized before storage (a strategy UUID and a `sk_live_…` key never reach metadata text);
  - B3 a freshness rejection records `stale` with the role-prefixed cause code and no condition counts (MTF tolerates the lag, freshness does not);
  - B4 a provider failure records `failed` with the bounded `rate_limited` cause, while `providerFailures`/`instrumentsScanned` keep their existing values;
  - B5 250 observations ⇒ totals over all pairs, `items` capped at 200, `truncated: true`, identical sample under a reversed input order, and the block round-trips through the published schema;
  - B6 recursive redaction: the owner keeps `strategyId` inside `items[]`, non-owner and operator views drop it at any depth together with `failureReasons`, counts survive, and the input is never mutated;
  - B7 a legacy run without the block parses as "detail unavailable".
  - Phase A (A1–A3) still passes unmodified, proving scanning behaviour and idempotency are unchanged.

- `apps/api/test/scanner.test.ts` — API integration:
  - Unauthenticated 401, free user 403, pro user can access health (real state), list runs, trigger scanner with advisory locking, validates strategy ownership, rejects unsupported instruments, health does not expose secrets, rate limited
  - F4 tenant privacy (HTTP): `GET /api/scanner/runs` returns only the session user's runs and never another tenant's user/strategy UUID; `GET /api/scanner/health` keeps the global last-run view but redacts other tenants' identifiers while preserving the viewer's own; a run triggered via `POST /api/scanner/trigger` is listed for its owner and invisible to another tenant

**Results:**

- Core: 262 tests, 0 fail (previously 258 passing + 4 new scanner tests, plus migration count fixes)
- API: 200 tests, 0 fail (previously 191 + 9 new scanner API tests)
- Contracts, provider-twelve-data, web: existing suites still passing
- Typecheck: clean across all workspaces
- Lint: 2 pre-existing errors (alerts.ts and strategies.ts `getBillingState` unused) — not introduced by M7.5, clearly distinguished; 0 new errors
- Production build: succeeds (API + Web, Next.js 15.5.25, 17 pages including new `/scanner`)

## Files Changed

- New migration: `packages/core/src/db/migrations/0015_scanner_runs.sql` — scanner_runs + scanner_cursors tables
- New contracts: `packages/contracts/src/scanner.ts` — scanner DTOs, health, trigger, stale thresholds, advisory lock key, aliases, limits
- Updated: `packages/contracts/src/index.ts` — export scanner
- New core scanner: `packages/core/src/scanner/normalization.ts`, `validation.ts`, `freshness.ts`, `service.ts`, `index.ts`
- Updated: `packages/core/src/index.ts` — export scanner
- Updated: `packages/core/src/billing/subscriptions.ts` — fix lint (import type, any → typed)
- Updated: `packages/core/test/m6-migrations.test.ts` and `m7-notification-migrations.test.ts` — expect 15 migrations (0015 added)
- New tests: `packages/core/test/scanner.test.ts`
- New API routes: `apps/api/src/routes/scanner.ts` — health, runs, trigger
- Updated: `apps/api/src/app.ts` — wire scanner service, add recovery, register routes
- Updated: `apps/api/src/server.ts` — scanner recovery + ticker (when SCANNER_ENABLED=true)
- Updated: `apps/api/src/config.ts` — scanner env vars (SCANNER_ENABLED, SCANNER_INTERVAL_MS, SCANNER_PROVIDER_TIMEOUT_MS, SCANNER_MAX_RETRIES, SCANNER_RETRY_BASE_MS, SCANNER_RETRY_MAX_MS) + ScannerConfig interface
- New API tests: `apps/api/test/scanner.test.ts`
- New web UI: `apps/web/app/scanner/page.tsx` — health, last run, recent runs, trigger button
- Updated: `apps/web/lib/api.ts` — scanner API client methods
- Updated: `apps/web/components/app-shell.tsx` — add Live Scanner nav
- Updated: `.env.example` — scanner env vars documentation
- New docs: `docs/scanner.md` — full M7.5 documentation

## Migration(s)

- `0015_scanner_runs.sql` — creates `scanner_runs` and `scanner_cursors` tables with indexes, checks, triggers, comments. Additive only.

## Environment Variables Required

**No new required variables** — all scanner env vars have defaults and are optional:

- `SCANNER_ENABLED` (bool, default false) — run scanner ticker in-process
- `SCANNER_INTERVAL_MS` (int 30s–1h, default 300000 = 5m)
- `SCANNER_LEASE_MS` (int 30s–2h, default 1800000 = 30m) — stale running scan recovery horizon
- `SCANNER_RUN_RETENTION_DAYS` (int 1–3650, default 90) — terminal `scanner_runs` retention, **pinned to `90` in `render.yaml`** so the production window is auditable in the blueprint. The maintenance sweep (`runMaintenance`, run by the internal maintenance route and every 6th in-process ticker cycle) deletes `completed`/`failed` runs whose `started_at` is older than this window, in bounded batches (500 rows per statement, at most 20 statements per sweep). `running` and `partial` runs, `scanner_cursors`, and the newest terminal run and newest completed run (the rows behind health's `lastRun`/`lastSuccessfulRun`) are always kept. Logs contain counts only — and only when a sweep deletes something.
- **Retention observability (F15)** — because a young ledger deletes nothing, "no log line" cannot distinguish "the sweep ran and found nothing to do" from "the sweep never ran". Every sweep *attempt* is therefore recorded in-process and reported by the unauthenticated `GET /api/health` under `retention.scannerRuns` (`lastSweepAt`, `sweepAgeMs`, `sweeps`, `lastSweepDeleted`, `totalDeleted`, `lastSweepRetentionDays`, `lastSweepDurationMs`, `lastSweepBatchCeilingReached`, `failures`, `lastFailureAt`, `lastFailureCode`) — counts, timings, the applied window and a machine code only, never a row id, tenant identifier, SQL statement or error message. The counters are process-local (a restart resets them) and reading them never triggers a sweep, so an operator can confirm maintenance is executing without a worker token, a log search or a production SQL session.
- `SCANNER_PROVIDER_TIMEOUT_MS` (int 1s–120s, default 15000)
- `SCANNER_MAX_RETRIES` (int 0–10, default 3)
- `SCANNER_RETRY_BASE_MS` (int 100–60000, default 1000)
- `SCANNER_RETRY_MAX_MS` (int 1s–120s, default 10000)
- `SCANNER_WORKER_TOKEN` (string, default empty) — shared secret for `POST /api/internal/scanner/run` and `POST /api/internal/scanner/maintenance` (empty = those routes return 404)

Existing provider variable still required for production data:

- `TWELVE_DATA_API_KEY` — Twelve Data API key (server-side, never logged)

## Production Market-Data Provider

**Twelve Data (historical OHLCV)** — `packages/providers/twelve-data`, id `twelve-data`, registered when `TWELVE_DATA_API_KEY` set. Serves all canonical timeframes via native intervals + deterministic resampling. No mock/demo data in production.

## Scanner Execution Mechanism / Frequency

- Advisory lock `875421009` prevents overlapping across in-process ticks, manual triggers, and external scheduler invocations
- Runs every **5 minutes** (expected, configurable via `SCANNER_INTERVAL_MS`), driven either by the overlap-safe in-process ticker (`startScannerWorkerTicker`) or by an external scheduler calling `POST /api/internal/scanner/run` with `x-veltrixeye-worker-token`
- Cursors prevent re-processing same closed candle across restarts or duplicate invocations
- Safe on restart and sleep-resume via `recoverStaleRuns(leaseMs)` and `waitForInFlight()` on graceful shutdown
- Manual trigger via API + optional in-process ticker

## Symbols / Timeframes Supported

- Symbols: EURUSD, GBPUSD, USDJPY, XAUUSD, SPX500 (excluded from ingestion), BTCUSD, ETHUSD, AAPL, SPY — plus any future instruments added via migration (validated against `instruments` table)
- Timeframes: all 14 canonical (`1m`…`1M`), with strategy requirements HTF 4H/1D, Setup 1H, Entry 15M/5M preserved
- Normalization: symbol uppercase + regex, timeframe aliases (4H→4h, 1D→1d, 60m→1h), timestamp epoch ms, OHLCV validation

## Stale-Data Policy

- Never generate alert from stale/invalid data
- Thresholds: 5m→15m, 15m→45m, 1h→2h, 4h→8h, 1d→36h, etc.
- Multi-timeframe: all must be fresh
- Stale rejections counted and logged, no alert created

## Duplicate-Prevention Mechanism

- Advisory lock (execution)
- Cursors (candle-level)
- `setups` unique key (version, instrument, direction, asOf) — setup dedup
- `alerts` unique key (setup_id, trigger_state) — alert dedup
- `notification_deliveries` unique key (alert_id, channel) — outbox dedup

## Failure / Retry Behavior

- Scanner-owned fetch deadline → typed timeout, retry with backoff (max 3, base 1s, max 10s, jitter)
- Ingestion-mapped `rate_limited` / `provider_unavailable` → retry, then mark run partial/failed; classification uses error codes, never message text
- Invalid request, unknown instrument, malformed response or unrelated errors → no retry; fail closed, no alert
- Missing symbol → 400 unsupported
- Stale data → skip, count rejection, no alert
- DB failure → rollback, run failed, no alert
- Restart → recover stale running runs

## Remaining Blockers

- None for M7.5 — scanner is production-ready for real market data flow
- Provider is historical-only (`realtime: false`) — live scanner uses fetch-through historical endpoint repeatedly (every 5m) which is correct for M7.5 scope; true realtime streaming is future milestone
- Scanner ticker disabled by default in dev (`SCANNER_ENABLED=false`) — enable in production or trigger manually
- No automated trading / broker orders (M8 boundary respected)
