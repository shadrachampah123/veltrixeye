# M10.0 verification report

Date: 2026-09-19 (UTC). Base: production-verified `main`
`4c2023aed2b974544db0c4cb40837701aec93757`, confirmed against the remote before
implementation and again after regression checks.

## Results

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
4. Legacy M8.4 MT5 normalizers retain raw provider messages/error causes. They are
   unchanged and not used by M10. Review them before any future real integration;
   the M10 path forwards only allowlisted errors/events.

M10 intentionally cannot be promoted to live: durable cross-process idempotency,
production authorization resolution, durable audit, broker reconciliation,
credential management and a reviewed protocol implementation remain prerequisites
for a later milestone. Per-instance simulation idempotency is not a claim of
exactly-once broker execution across restarts.

No merge, production deployment, live enablement or broker action is part of this
PR. See [architecture and limitations](./m10-execution-transport.md).
