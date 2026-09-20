# M10.0 verification report

Date: 2026-09-19 (UTC). Base: production-verified `main`
`4c2023aed2b974544db0c4cb40837701aec93757`, confirmed against the remote before
implementation and again after regression checks.

## M10.0 results (original PR commit)

| Check | Result |
|---|---|
| Full existing suite before adding M10 tests | 1,161 passed, 0 failed/skipped |
| New M10 tests | 77 passed (69 core, 8 API configuration) |
| Final `npm test` | **1,238 passed, 0 failed, 0 skipped** |
| Contracts | 122 passed |
| Core | 620 passed |
| Twelve Data provider | 33 passed |
| API | 280 passed |
| Web | 183 passed |
| Changed TypeScript files: ESLint | Passed |
| `git diff --check` | Passed |
| Workspace typechecks | Contracts, provider, API and web pass; core blocked by the pre-existing test error below; no M10 diagnostics |
| Full-repository ESLint | Pre-existing 19 errors / 1 warning; no changed-file findings |

Both full-suite runs passed on their first attempt, without skips, retries,
safety-test edits, or CI changes. Tests include embedded PostgreSQL migrations;
no production database was used.

### Safety and compatibility regressions

- **M8.7: PASS.** Drawdown, risk engine, execution gates, safety/kill-switch and
  automation tests remain unchanged and pass. No safety implementation was
  modified; the new dispatcher calls the existing gate evaluator.
- **M9.1: PASS.** Notification/fairness, concurrency and migration tests pass;
  notification code is unchanged.
- **M9.2: PASS.** Push, outbox, SecretManager, API and migration tests pass;
  notification/SecretManager code is unchanged.
- **Migration 0028: intact.** Fresh database and upgrade tests pass. Its SHA-256
  matches the base byte-for-byte:
  `25359093d0304d84d82982750c58ee1bb054edacf29d1d4971a32ecfb5c9e49f`.
- **No migration added; no production schema change.**
- New transport tests install network/process tripwires and assert zero calls
  across all scenarios. No MT5/broker network client or SDK was added. No broker
  was contacted; no real credentials, live orders, modifications or closes used.

### New test coverage

Connection/disconnection, concurrent connects, unavailable state, explicitly
non-live health/session status; deterministic acknowledgement/rejection; deadline,
transport failure, malformed and mismatched responses; uncertain/sticky outcomes
and late-response suppression; 100-way duplicate submission, conflicting IDs,
UUID canonicalization and bounded capacity; cancellation success/rejection/faults,
duplicate and unknown orders; strict request validation; fixed-message error and
audit sanitization; audit sink failures before/after exchange; forged/reused/
cross-adapter/request-mutated capabilities; caller mutation during authorization;
automation OFF, all four kill-switch scopes, risk/ownership/exposure/environment/
broker/account denial, explicit execution authorization rejection and resolver
failure; config defaults/missing/complete/invalid live opt-in; API boot validation.

## Pre-existing blockers / security findings

Verified using an untouched `git archive` of the base (no branch switch):

1. `npm run typecheck` fails at
   `packages/core/test/push-provider.test.ts:63`: `string | undefined` is passed to
   `string[].includes`. The final all-workspace run reports that same sole error.
   This also blocks the existing CI typecheck step. Not changed in this focused PR.
2. `npm run lint` reports the same **19 errors / 1 warning** on the base and M10:
   service-worker globals and existing notification/SecretManager test/source lint
   issues. All M10/modified TypeScript files pass targeted ESLint. Not repaired here
   to avoid unrelated changes to M9 behavior.
3. `npm audit` reports **2 vulnerable packages (1 high, 1 moderate)** in the existing
   Next/PostCSS dependency chain, including PostCSS XSS/source-map disclosure
   advisories. No dependency or lockfile changes are introduced; remediation needs
   a separate compatibility-reviewed dependency update.
4. Legacy M8.4 MT5 normalizers retained raw provider messages/error causes at
   M10.0/M10.1. **Resolved under Gate 10** (see below): they now emit fixed-message,
   closed-category errors with no `cause`, structured receipts without broker text,
   and allowlisted health reasons. They remain unused by the M10 transport path,
   which forwards only allowlisted errors/events.

M10 intentionally cannot be promoted to live: durable cross-process idempotency,
production authorization resolution, durable audit, broker reconciliation,
credential management and a reviewed protocol implementation remain prerequisites
for a later milestone. Per-instance simulation idempotency is not a claim of
exactly-once broker execution across restarts.

No merge, production deployment, live enablement or broker action is part of this
PR. See [architecture and limitations](./m10-execution-transport.md).


## M10.1 — review-blocker fixes

Scope: only `transport/adapters.ts`, its M10 tests, and the two M10 documents.
No M8.7 gate/risk/safety change, M9.1/M9.2 behavior change, production wiring,
dependency change, migration or schema change.

### Resolution

1. **Async audit failure safety:** `audit` explicitly accepts `void | Promise<void>`.
   Every call is awaited inside a fixed-message sanitizing boundary. Synchronous
   throws and asynchronous rejections cannot retain raw errors/causes or escape as
   unhandled sink rejections. Pre-exchange audit failure prevents exchange;
   post-exchange failure preserves deduplication. Connection/operation reservations
   survive asynchronous audit, and disconnect/reconnect epochs prevent resurrection
   or exchange on a replacement connection after an audit wait.
2. **Cancellation preflight:** initially invalid preflight does not reserve an
   execution/request identity or consume capacity. Corrected and post-acknowledgement
   requests can proceed. A later pre-exchange failure releases only the cancellation
   execution reservation, retaining request-ID bindings. The attempt flag is set at
   the actual exchange invocation; every attempted/uncertain cancellation stays
   cached, including failed terminal audit. Submission reservations are never
   released. There are no automatic retries.

### Verification after the fixes

| Check | Result |
|---|---|
| New M10.1 regressions | **25 passed** |
| All M10 tests (94 core + 8 API config) | **102 passed, 0 failed/skipped** |
| Full `npm test` | **1,263 passed, 0 failed/skipped** |
| Workspace counts | contracts 122; core 645; provider 33; API 280; web 183 |
| Separate M8.7/M9.1/M9.2 regression run | **238 passed, 0 failed/skipped** |
| Typecheck before vs after fixes | Identical output: sole pre-existing `push-provider.test.ts:63` error; all other workspaces pass |
| Changed-file ESLint / diff whitespace check | Passed |
| Migration 0028 checksum | Identical to M10.0 and main (hash above) |

The 25 added cases cover sync throws and async rejections; sanitized output and no
unhandled rejection; successful awaited async audit; pre/post-exchange audit
failure; 100-way submission deduplication during audit; connection/disconnect
races; wrong-ID correction; cancellation before/during acknowledgement; reconnect
retry; concurrent cancellation aliases/conflicts; and sticky attempted cancellation
rejection/timeout/transport-failure/malformed-response results.

The separate regression run includes core M8.7 drawdown, execution, safety controls,
risk engine/service; M9.1/M9.2 notification/outbox/migration tests; notification
outbox, push provider and SecretManager; plus execution and M9.1/M9.2 API tests.
The existing suite remains unchanged. All test exchanges are local doubles/internal
simulations, not MT5 or broker simulations/connections. M10's file-wide network and
process-start tripwires reported zero forbidden calls. Database tests use local
embedded PostgreSQL with synthetic test credentials, not production credentials.

The pre-existing typecheck/CI, lint and dependency findings above remain outside
this two-blocker fix. Legacy MT5 normalizers were not changed by M10.1 and remain
unwired to M10; their redaction review was completed and closed under Gate 10
(below). The in-memory, per-instance idempotency limitation is unchanged.

No merge or deployment command is part of this fix. Existing GitHub/Vercel preview
automation is unchanged and may react to the required PR branch push; this is not
production deployment authorization.

## Gate 10 — legacy MT5 normalizer redaction (CLOSED)

Date: 2026-09-20 (UTC). Base: `main` `3b0c0e29a4961b438e638a174b221acd3c9e96bf`.
Status: **remediation completed; final read-only verification: PASS.** This gate
is internal safety/redaction work only — it is not broker, bridge or demo
integration.

Scope (working-tree files): `packages/core/src/execution/mt5.ts`,
`provider-health.ts` (new), `index.ts`, `profiles.ts`, `reconciliation-service.ts`,
`apps/api/src/routes/execution.ts`; tests `packages/core/test/m10-gate10-redaction.test.ts`
(new), `mt5.test.ts`, `reconciliation.test.ts`, `apps/api/test/execution.test.ts`.

### Remediation

- **Raw provider causes/messages removed** from the affected MT5 normalization
  paths. `normalizeMT5Error` builds every result from a closed category and a fixed
  message with no `cause`, stack, headers, request or enumerable provider
  properties; an upstream `ExecutionProviderError` is rebuilt from its contract
  fields, never returned verbatim. Classification reads only primitive
  `code`/`message`/`responseLost` hints inside a bounded (2,048-character) window.
- **Order-submission uncertainty hardened.** Timeout/connection signals are
  classified before authentication and forced `uncertain`; unrecognized submission
  failures are `uncertain`; `responseLost` takes precedence over every other
  signal; provider text can no longer downgrade an ambiguous submission failure to
  a certain outcome.
- **`normalizeMT5Order`** keeps bounded structured receipts only (`retcode`,
  `timestampMs`); the broker `message` is never retained; order and position
  tickets are validated (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`) and otherwise fail
  closed as `uncertain`. Status mapping is unchanged.
- **Provider health/account information safely projected.** MT5 health emits
  strict booleans and an allowlisted reason (or the fixed
  `mt5_transport_reported_unhealthy` token) with no `detail`; every API route,
  the broker connection test and the reconciliation snapshot adapter use the
  closed `toSafeProviderHealth` projection. Account info requires the configured
  account reference and server, never falls back to the broker login, and exposes
  configured broker/server labels only.
- **Persistence/audit paths.** Reconciliation persists closed
  `provider_error:<category>` tokens instead of error text; connection-test audit
  metadata records closed-enum facts only (no `reason`).
- **Regression coverage added:** 72 focused Gate 10 tests (every classification
  branch, unknown, pass-through, cause/stack removal, fabricated secret sentinels,
  1 MB messages, newline/ANSI injection, non-Error throws, submission-uncertainty
  property test, responseLost precedence, receipt/ticket validation, health
  projection, account fallbacks, positive controls), 3 reconciliation persistence
  tests and 2 API route/audit tests; one receipt expectation updated.

### Verification (final read-only audit, then closure re-run)

| Check | Result |
|---|---|
| Focused core (Gate 10 + MT5 + execution + M10 transport) | 217 passed |
| Core reconciliation (embedded PostgreSQL) / API execution + M10 config | 22 / 28 passed |
| Full `npm test` | **1,340 passed, 0 failed, 0 skipped** (contracts 122; core 720; provider 33; API 282; web 183) |
| `npm run typecheck` | 0 errors on this base |
| Changed-file ESLint / `git diff --check` | Passed |
| Migration 0028 SHA-256 | Byte-identical to base: `25359093d0304d84d82982750c58ee1bb054edacf29d1d4971a32ecfb5c9e49f`; no migration 0029 |

### Safety boundaries (unchanged from base)

- **No broker/demo/MT5 connectivity introduced;** no credentials added; the
  changed files contain no network, environment or filesystem access.
- **`DisabledMT5Transport` remains active** and its class body is byte-identical
  to the base.
- **No live execution enabled:** the M8.4 live prohibition (`Live MT5 execution is
  prohibited in M8.4`, `live_execution_prohibited_m8_4`, paper-only allowed
  environments) is intact; automation and the scanner remain disabled.
- Execution safety gates, kill switches, risk/safety services, entitlements,
  contracts, `app.ts` wiring and the migrations directory are unchanged.

Not part of this gate: broker/bridge/demo integration (Gate 9), any merge,
production deployment or live enablement.
