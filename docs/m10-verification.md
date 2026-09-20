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

### Superseded by Gate 9 (2026-09-20): provider status vocabulary

The bullet "Status mapping is unchanged" above described Gate 10's scope only. Gate
9 §18/§21 replaces that mapping with the protocol's closed, case-sensitive
`PROVIDER_ORDER_STATUS_VOCABULARY`: an unknown, missing, malformed or case-variant
provider status (`FILLED`, `' Accepted '`, `''`, a non-string) is no longer folded
into a durable status or into `failed` at all. It normalizes to `status: null` with
`statusUncertain: true`, which the MT5 adapter surfaces as an uncertain
`ExecutionProviderError` and reconciliation preserves as the snapshot-only
`uncertain` status plus an `uncertain_outcome` finding. Gate 10's redaction
behavior is unchanged; the Gate 10 expectation was updated to the stricter rule in
`packages/core/test/m10-gate10-redaction.test.ts` ("unsupported statuses stay
unknown (Gate 9 §18/§21)").

Not part of this gate: broker/bridge/demo integration (Gate 9), any merge,
production deployment or live enablement.

## Gate 9 — MT5 bridge protocol contract: Step 2 (pre-provider validation)

Date: 2026-09-20 (UTC). Base: `main` `6fbeda415414f87863292b662319b50c973d91a2`
(PR #33). Status: **Step 2 of the Gate 9 plan is implemented and verified.** This
is protocol-contract and validation work only — **no broker, bridge, demo or live
connectivity**, no credential use, no migration, no route, and no provider is
registered or wired. It is explicitly **not** a claim that Gate 9 as a whole is
closed.

Scope (files): `packages/contracts/src/mt5-bridge-protocol.ts` (new),
`packages/contracts/src/index.ts`, `execution.ts`, `reconciliation.ts`;
`packages/core/src/execution/protocol.ts` (new), `readiness.ts` (new), `index.ts`,
`mt5.ts`, `gates.ts`, `paper-gates.ts`, `provider-health.ts`,
`reconciliation-service.ts`; tests
`packages/contracts/test/m10-gate9-protocol.test.ts` (new),
`packages/core/test/m10-gate9-validation.test.ts` (new),
`packages/core/test/m10-gate9-reconciliation.test.ts` (new),
`packages/core/test/mt5.test.ts`, `packages/core/test/m10-gate10-redaction.test.ts`;
docs `m10-execution-transport.md` and this report.

### Landed in this step

- **Protocol identity and strictness.** `veltrixeye.mt5-bridge` at `1.0.0` with
  explicit per-message identity, strict (non-passthrough) schemas, bounded
  strings/numbers/timestamps, closed enums, and semver rules that reject a higher
  MAJOR instead of reinterpreting it (MINOR mismatch rejected, PATCH tolerated,
  malformed rejected — never coerced).
- **Durable order identity (B2).** `ve-<24 hex>` and `ve-<20 hex>-rN` with
  deterministic refusal codes; checked **first** in the MT5 submit path, ahead of
  health, symbol lookup and idempotency lookup, so a malformed identity yields a
  certain pre-exchange refusal and provably zero transport calls.
- **One readiness rule (B5, R7.4.4).** `readiness.ts` resolves readiness for the
  M8.1 gates, M8.3 paper gates, MT5 health projection, MT5 execution path and the
  reconciliation snapshot adapter from one strict implementation: explicit boolean
  `true` only, per-profile conditions, uncertain state refuses, and a
  dependency-chain rule so a narrower profile cannot be satisfied by a record that
  asserts availability while admitting it is not connected or authenticated.
  Readiness remains a precondition, never an authorization.
- **Quote freshness (B6).** Two-sided window `-5000 ms … +15000 ms` by default,
  inclusive bounds, floored age, future-beyond-skew refused, non-finite override
  refused instead of disabling the check.
- **Instrument and sizing (B7).** Closed instrument-contract validation (asset
  class, symbol identity, contract size, tick size, digits, volume min/max/step,
  order types, trading status) plus range and step alignment; the historical
  zero-step `Infinity` comparison that let every volume through is closed at the
  contract level.
- **Provider status normalization (B9).** Closed, case-sensitive vocabulary in the
  protocol; unknown/malformed/case-variant states become `status: null` +
  `statusUncertain: true` and never `failed`/`rejected`; the MT5 adapter surfaces
  them as uncertain and reconciliation records an `uncertain_outcome` finding
  (§20/§21), never status drift, never a fabricated absence, never a repair.
- **Audit boundary (§24/§25/§31 partial).** A strict audit-event contract with
  credential-shaped keys and provider payloads **rejected** (not redacted),
  definitive outcomes requiring verified evidence, and uncertain outcomes requiring
  the uncertainty flag.

### Deliberately not in this step

- **Nothing is wired.** There is no provider-registry entry, no route (no
  `/test-connection` endpoint exists or was added), no transport selection and no
  config knob for `veltrixeye.mt5-bridge`: no production path consults the new
  module yet, so MT5 stays disabled-by-default and every real behavior is
  unchanged.
- **Provider-side durability is later work.** §22's "persist locally uncertain
  before the provider call" and §24's submit-intent/reservation/receipt storage
  need the persistence step and are deferred with the adapter work, together with
  the operator runbook and an end-to-end fake-bridge harness.
- **No secret-manager binding.** §31's attestation-to-credential binding is not
  implemented; the protocol carries non-secret reference fields only, and an
  unusable attestation refuses the handshake (`attestation_mismatch`) rather than
  being retried as an envelope problem.
- **Open item — vendor price rules.** The limit/stop price-rule text for MT5 is
  absent from this repository, so price handling stays at the bounded price schema
  plus tick/digits contract compatibility. No vendor-specific price behavior was
  invented, and none should be assumed from this step.

### Verification

| Check | Result |
|---|---|
| Contracts | 197 passed (75 new Gate 9 protocol tests) |
| Core (full, embedded PostgreSQL included) | 757 passed |
| New Gate 9 core suites | 32 pre-provider validation + 5 reconciliation-uncertainty tests |
| Twelve Data provider / API / Web | 33 / 282 / 183 passed |
| Full `npm test` | **1,452 passed, 0 failed, 0 skipped** |
| `npm run typecheck` | 0 errors |
| Changed-file ESLint / `git diff --check` | Clean |
| Migration 0028 SHA-256 | Byte-identical to base: `25359093d0304d84d82982750c58ee1bb054edacf29d1d4971a32ecfb5c9e49f`; no migration 0029 |
| `ORDER_STATUSES` | unchanged (10 members, no `uncertain`); `uncertain` is snapshot-only vocabulary |

Both suites are deterministic and offline: no network, no credential, no vendor
artifact and no real account. `packages/contracts/src/mt5-bridge-protocol.ts`,
`packages/core/src/execution/protocol.ts` and `readiness.ts` contain no
`node:http`/`node:net`/`node:child_process` import, no environment access and no
filesystem access, and `apps/` is untouched by this step.

### Superseded expectation from Gate 10

Gate 10 recorded "status mapping is unchanged". Gate 9 §18/§21 supersedes that:
unsupported provider statuses (including case variants such as `FILLED`) are no
longer mapped to a durable status or to `failed`, but to explicit uncertainty.
`packages/core/test/m10-gate10-redaction.test.ts` was updated to the stricter
expectation ("unsupported statuses stay unknown (Gate 9 §18/§21)"). Gate 10's
redaction guarantees (fixed messages, no cause/stack, allowlisted reasons, bounded
receipts) are unchanged and still pass.
