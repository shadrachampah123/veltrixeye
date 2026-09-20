# Gate 9 — durable provider mutation persistence (submit only)

**Status:** implemented (replacement authority for the unrecovered §22/§24/§31
Gate 9 persistence material)
**Scope:** durable persistence and recovery safety for **provider order-submit
mutations only**
**Live broker execution:** excluded. No MT5/Exness transport is enabled, wired
or activated by this work.
**Migration:** `0029_provider_mutation_persistence.sql`. Migration `0028` is
byte-identical (SHA-256
`25359093d0304d84d82982750c58ee1bb054edacf29d1d4971a32ecfb5c9e49f`, unchanged).
Gate 9 Step 3b (M2 — durable single-use barrier consumption) added **no
migration**: consumption is enforced in application code against the schema
0029 already provides.
Gate 9 Step 3c (M3 — structural duplicate-mutation and retry invariants, §6a)
adds `0030_provider_mutation_lineage_invariants.sql` (additive only: three
partial unique indexes + a refusing pre-flight). Migration `0029` is
byte-identical (SHA-256
`a8c4cde5fc8dc2e0cc48b253e9d881f90cdc7f825d323a67a8defd382bde9ce7`, unchanged).

This document is the record of how the Gate 9 persistence contract is
implemented, and the read-only safety review that closes §17.

## 1. What exists now

| Layer | File |
|---|---|
| Vocabulary, state machines, sanitization, normalization | `packages/contracts/src/provider-mutations.ts` |
| Durable ledger service | `packages/core/src/execution/provider-mutations.ts` |
| Schema, triggers, guards | `packages/core/src/db/migrations/0029_provider_mutation_persistence.sql` |
| Lineage / managed-order unique indexes (M3) | `packages/core/src/db/migrations/0030_provider_mutation_lineage_invariants.sql` |
| Fake-provider crash/recovery suite | `packages/core/test/m10-gate9-mutation-persistence.test.ts` |
| Single-use barrier-consumption suite (M2) | `packages/core/test/m10-gate9-barrier-consumption.test.ts` |
| Structural duplicate-mutation / retry invariant suite (M3) | `packages/core/test/m10-gate9-m3-invariants.test.ts` |
| Migration suites | `packages/core/test/m10-gate9-migrations.test.ts` (0029), `packages/core/test/m10-gate9-m3-migrations.test.ts` (0030) |
| Contract suite | `packages/contracts/test/m10-gate9-persistence.test.ts` |

Nothing in `apps/`, no route, no worker, no provider registry entry and no
transport wiring was added or changed. The M8.4 MT5 boundary stays disabled and
`MT5ExecutionTransport` remains unavailable.

## 2. Durable intent (§2)

`execution_provider_intents` (created by 0019) is extended **additively** into
the authoritative ledger. Every provider-submit attempt has a committed intent
row before the provider mutation call is permitted, carrying:

| Contract requirement | Column(s) |
|---|---|
| intent ID | `id` |
| user/profile ownership | `user_id`, `execution_profile_id` |
| mutation kind = `submit` | `mutation_kind` (Gate 9 persists `submit` only) |
| client order ID | `client_order_id` (globally unique for Gate 9 rows) |
| idempotency key | `idempotency_key` (64-hex) |
| account/provider/environment binding | `provider_slug`, `environment`, `account_ref`, `broker_server_ref` |
| canonical request identity/hash | `request_hash` (sha-256 of the canonical request) |
| current intent state | `status` |
| retry lineage | `parent_intent_id`, `root_intent_id`, `attempt`, `superseded_by_intent_id` |
| creation/update timestamps | `created_at`, `updated_at`, `submitted_at`, `resolved_at` |
| reconciliation requirement | `reconciliation_required`, `reconciliation_state` |
| terminal evidence | `outcome`, `terminal_evidence`, `resolution`, `uncertainty_reason` |
| risk linkage | `risk_decision_id`, `order_id` |
| credential reference (never a value) | `credential_ref`, `credential_fingerprint` |

No secret, credential, raw provider payload, provider error text or
authentication token is persisted: no column can hold one, and a persisted
receipt is rejected by a database CHECK if it contains a credential-shaped key
(`provider_receipt_keys_allowed`).

## 3. Intent state machine (§3)

```text
prepared → submitting → confirmed
                     ├─ rejected
                     └─ uncertain → reconciled
```

`submitting → reconciled` is the operator/verified-resolution path for an
intent that crashed in flight: such an intent is unresolved (§8) and may only
be closed by documented evidence (§14). It can never produce a new submission.
`confirmed`, `rejected` and `reconciled` are terminal; `uncertain` is not
terminal but never leaves except through `reconciled`.

One append-only `submitting → submitting` **event** also exists (M2): the
durable consumption of the single-use submit barrier, recorded immediately
before the provider call (§9a). It is not a state transition — the status does
not change — and no new state was introduced.

Enforced by `provider_intent_state_guard()` (BEFORE UPDATE trigger) and mirrored
in `PROVIDER_INTENT_TRANSITIONS` for the application layer.

## 4. Mutation reservation (§4)

`execution_provider_mutation_reservations` is the provider-mutation ledger. It
is deliberately **not** `risk_reservations`, which keeps its own responsibilities
(risk-exposure accounting) and its own 60-second crash-recovery TTL.

* States: `reserved`, `known_completed`, `known_rejected`, `uncertain`.
* `uncertain` ⇒ `requires_reconciliation = true`; the two known states ⇒ false
  (CHECK-constrained, so the rule cannot be violated by a writer).
* `risk_reservation_id` references the risk row with `ON DELETE SET NULL`: TTL
  reclamation of the risk row **cannot** delete or invalidate the mutation row,
  which keeps its own exposure copy (`monetary_risk`, `symbol`, `direction`).
* A BEFORE DELETE trigger refuses to delete a reservation that is `reserved` or
  `uncertain` — no TTL, lease, cleanup job or restart can erase it (§10, §15).

## 5. Outcome, receipt and identity verification (§5)

`normalizeSubmitOutcome` (contracts) maps every provider response onto
`accepted | rejected | uncertain`:

* accepted: a valid response whose status is in the accepted vocabulary
  (`requested`, `placed`, `accepted`, `partial`, `filled`), whose identity
  matches the intended client order/idempotency/account, and which carries a
  provider ticket;
* rejected: the same identity verification with a rejection vocabulary status
  (`rejected`, `cancelled`, `canceled`, `expired`);
* **everything else is uncertain** — timeout, transport failure, lost response,
  malformed response, unknown/unsupported/missing status, and identity mismatch
  after a mutation may already have occurred.

A missing response is never interpreted as rejection, and `failed` is not a
provider status at all, so "we could not read the state" can never be laundered
into a definitive failure.

Receipts (`execution_provider_receipts`) are append-only and sanitized: only
allowlisted, type-checked, bounded scalars are copied, a definitive outcome
requires `identity_verified = true` plus terminal evidence, and an uncertain
outcome carries no evidence and claims no provider ticket. A response carrying a
credential-shaped key is **refused, not redacted** — the mutation stays
uncertain rather than being recorded with a scrubbed payload.

## 6. Idempotency and retry (§6)

Unique mutation identity is enforced in three places:
`client_order_id` (unique for Gate 9 rows), `(profile, idempotency_key)` and
`(profile, mutation_kind, request_hash)`, plus a per-identity advisory lock
inside the barrier transaction.

A repeated request with the same profile/account, mutation kind, client order
id, idempotency key and canonical request hash resolves against the existing
intent and returns `duplicate` **without** invoking the provider — including
after a restart, after a TTL expiry, and under concurrency.

A retry (`prepareRetry`) is permitted only when:

1. the original intent is resolved as `rejected`, or `reconciled` as
   `provider_rejected` / `provider_absent` — a `confirmed` or
   `reconciled`/`provider_accepted` original is **never** retried
   (`duplicate_mutation`, §6a);
2. the retry carries a **new** client order id and **new** idempotency key;
3. fresh risk decision and execution authorization ids are supplied — fresh
   meaning an existing risk decision owned by the same user/profile that no
   Gate 9 intent has consumed, and an authorization id no Gate 9 retry has
   consumed (`retry_requires_fresh_authorization`, §6a);
4. the original is the newest member of its lineage and is not already
   superseded, its lineage has no unresolved member, and the retry keeps the
   original's provider/environment/account binding and managed order (§6a).

The retry receives `attempt = parent.attempt + 1`, `parent_intent_id`,
`root_intent_id`, and marks the original `superseded_by_intent_id` by a
compare-and-swap in the same transaction. An unresolved original is never
retried (`uncertainty_unresolved`).

### 6a. Structural duplicate-mutation and retry invariants (M3, Step 3c)

M3 makes the following invariants structural: each is verified inside the
`prepareSubmit` / `prepareRetry` transaction **after** the relevant advisory
lock is held (lock, read and write in one transaction), and each is mirrored
by a partial unique index in migration `0030` so that no writer — concurrent,
restarted or one that bypasses the lock — can persist a violating row.

| Invariant | Application check (error) | 0030 index |
|---|---|---|
| At most one **unresolved** provider mutation (`prepared` / `submitting` / `uncertain`) per managed order (`order_id`, scoped to its execution profile) | `unresolved_order_mutation` | `execution_provider_intents_order_live_uniq` on `(execution_profile_id, order_id)` for live rows |
| A provider-accepted submit (`confirmed`, or `reconciled` as `provider_accepted`) closes the order identity: no retry and no start-over for the **same** `order_id`; another order after confirmation needs a distinct logical order identity | `duplicate_mutation` | same index (its predicate includes provider-accepted rows) |
| After an explicit `provider_absent` (or `rejected` / `provider_rejected`) resolution, a new mutation for that order may proceed — by start-over **or** by retry, whichever comes first | — | rows leave the index predicate on resolution |
| A parent intent has at most one retry (no sibling retries) | `parent_already_superseded` | `execution_provider_intents_parent_uniq` on `(parent_intent_id)` |
| A retry continues the **newest** lineage member; a stale/older member is refused even when its superseded pointer is missing | `stale_parent_intent` | `execution_provider_intents_lineage_attempt_uniq` on `(root_intent_id, attempt)` |
| A lineage never contains duplicate attempts | (same) | same index |
| Retry target binding is coherent: `provider_slug`, `environment`, `account_ref`, and the managed order identity (an omitted `orderId` inherits the parent's — a retry never escapes the order invariant) | `binding_mismatch` | — |
| A retry needs a fresh caller-supplied risk decision and authorization reference | `retry_requires_fresh_authorization` | — |
| Uncertain mutations keep blocking until reconciliation / operator resolution resolves them | `unresolved_order_mutation` / `uncertainty_unresolved` | live index |
| Different orders, execution profiles and provider/environment/account bindings remain independent wherever the identity model permits them | — | indexes are keyed per execution profile |

Identity model (deliberately preserved): **no global uniqueness on
`client_order_id` is introduced**; the 0019/0029 per-profile identity indexes
are unchanged. The order-level index is keyed by
`(execution_profile_id, order_id)` — `order_id` references the
`execution_orders` primary key, and the composite `(execution_profile_id,
user_id)` ownership FK from 0029 binds the profile to its user. When no
`order_id` is supplied, the pre-existing identity-based semantics apply
unchanged (two different identities are two independent mutations).

Gate 9 does **not** generate, evaluate or approve risk decisions or execution
authorizations. The freshness check is structural only: the risk decision row
must exist, belong to the same user and execution profile, and not already back
another Gate 9 intent; the authorization id must not already appear in a Gate 9
retry's durable event detail. No risk-engine logic (exposure, sizing, drawdown,
TTL policy) lives in the ledger.

## 7. Reconciliation (§7)

`recordReconciliationObservation` is observation only. It records the finding
against the original intent, account and client-order identity, and only moves
durable state when it is current and identity-verified:

| Observation | Effect |
|---|---|
| `matched` + accepted-vocabulary status | intent → `reconciled`, `provider_accepted` |
| `matched` + rejection-vocabulary status | intent → `reconciled`, `provider_rejected` |
| `not_found` | recorded as a proven observation (`applied = false`); intent remains `uncertain`, reservation remains `uncertain`, `requiresOperatorResolution = true`. No automatic `provider_absent` transition occurs — provider absence becomes durable only through explicit operator resolution |
| `mismatched` | observation only (`applied = false`); the intent stays unresolved and needs operator resolution (`requiresOperatorResolution = true`) |
| `uncertain` | continued uncertainty (`applied = false`); nothing is concluded |

Valid `not_found` reconciliation is intentionally fail-closed. Because absence
from an external query cannot prove with certainty that a remote system did not
execute or will not eventually acknowledge an order, `recordReconciliationObservation`
records the observation in `execution_provider_reconciliation_observations` with
`applied = false` and returns `requiresOperatorResolution = true`. The intent
and its mutation reservation both remain `uncertain`, unresolved exposure remains
counted, and `prepareRetry` remains blocked (`uncertainty_unresolved`). There is
no automatic transition to `provider_absent` or `reconciled`. Durable provider
absence is established only through explicit operator resolution (`resolveByOperator`).

Staleness is decided by the database (`provider_reconciliation_observation_staleness_guard`):
an observation about an attempt that a newer retry in the same lineage has
superseded, or about an intent that already has a definitive outcome, is written
with `stale = true` and can never be applied.

Gate 9 does not repair, resubmit, cancel or close anything.

## 8. Crash recovery (§8)

| Crash point | Durable interpretation | Where it is pinned |
|---|---|---|
| Before intent commit | No provider call; nothing durable | `prepareSubmit` throws `pre_call_persistence_failed`; transaction rolled back |
| After intent commit, before barrier consumption | `submitting` + `reserved`, unresolved, never re-sent | barrier commits status `submitting` in the same transaction; the minted barrier is the only path to a provider call |
| Barrier consumption fails or matches zero rows | No provider call; durable state unchanged (rolled back) | `executeSubmit` throws `barrier_not_consumable` or `pre_call_persistence_failed` before the call |
| After barrier consumption, before provider call | Barrier spent: exactly one consumption event durably recorded; the intent stays `submitting` and unresolved | `consumeSubmitBarrier` committed; the consumed `stateVersion` can never authorize a call again |
| During provider call | `uncertain` (`timeout` / `connection_failure`) | `executeSubmit` catch → uncertainty |
| After acceptance, before receipt commit | `uncertain` (`receipt_persistence_failure`) | receipt write failure path |
| After rejection, before receipt commit | `uncertain` (`receipt_persistence_failure`) | same path |
| Receipt committed, outcome transition fails (`state_commit_failed`) | intent stays `submitting`, but the barrier is already spent — a reuse attempt matches zero rows and cannot call the provider | `consumeSubmitBarrier` CAS on the exact `state_version` |
| Malformed/unknown response | `uncertain` | `normalizeSubmitOutcome` |
| Process restart | intent/reservation survive; in-flight intents become `uncertain` (`process_restart`); any barrier minted before the restart is retired — its version can no longer match | `recoverAfterRestart` + barrier CAS |

The system never infers `no stored response = provider rejected`, and never
infers `reservation expired = provider mutation did not happen`. A crash or
recovery at any point also never re-arms a barrier: consumption is permanent
because the version advance is permanent.

## 9. Transaction boundary (§9)

```text
BEGIN prepare/transition
  pg_advisory_xact_lock(order:<profile>:<order_id>)      ← M3, when order_id is present
  pg_advisory_xact_lock(<profile>:<client_order_id>)      ← identity lock (M1)
  identity lookup → existing? COMMIT, return duplicate
  live-order read (unresolved / provider-accepted?)       ← M3, same transaction as the lock
    → unresolved_order_mutation / duplicate_mutation (ROLLBACK, no provider call)
  insert intent (prepared)
  transition intent → submitting
  insert mutation reservation
  append intent events
COMMIT                       ← the pre-provider persistence barrier (mints SubmitBarrier)
BEGIN barrier consumption (CAS)
  UPDATE intent
    WHERE id = barrier.intentId
      AND mutation_kind = 'submit'
      AND status = 'submitting'
      AND state_version = barrier.stateVersion   ← exact compare-and-swap
      AND user_id / execution_profile_id / client_order_id / idempotency_key /
          attempt / request_hash / provider_slug / environment / account_ref
          all match the durable row
  advance state_version (0029 trigger)
  append submitting → submitting consumption event
COMMIT                       ← the single-use provider-call gate
provider call                ← still no transaction is open
BEGIN  insert sanitized receipt  COMMIT
BEGIN  transition intent + reservation  COMMIT
```

No transaction is held open across the remote provider call — the provider call
itself is **not** transactional; only its durable before- and after-states are.
A persistence failure before the provider call is fail-closed: the provider
function is never invoked. If the receipt write or the state transition fails
after the call, the mutation remains uncertain and requires reconciliation.

`prepareRetry` (M3) is one transaction as well:

```text
BEGIN retry
  pg_advisory_xact_lock(lineage:<profile>:<root_intent_id>)
  re-read parent (ownership, resolved, identity not reused, non-empty risk/authz)
  pg_advisory_xact_lock(order:<profile>:<order_id>)       ← parent's order unless the caller names it
  pg_advisory_xact_lock(<profile>:<new client_order_id>)
  identity lookup → existing? COMMIT, return duplicate (replayed retry)
  parent not superseded → newest attempt → eligible (rejected / provider_rejected / provider_absent)
  binding + order coherent → no unresolved lineage member → live-order read
  fresh risk decision / authorization reference
  insert retry (attempt + 1, parent, root) → submitting → reservation
  UPDATE parent SET superseded_by_intent_id WHERE superseded_by_intent_id IS NULL AND state_version = <read>
  append events
COMMIT                       ← exactly one retry; two concurrent retries yield one success
```

Lock order is fixed — lineage → order → identity (prepareSubmit: order →
identity) — so the two preparers can never deadlock. Failures inside the locked
checks roll everything back (`pre_call_persistence_failed`); a 0030 index
violation is reported with the M3 vocabulary above.

### 9a. Barrier semantics — the single-use provider-call authorization invariant

> **A provider call for intent I may occur only after a committed write advances
> `I.state_version` from exactly `barrier.stateVersion` while
> `I.status = 'submitting'`. Because every UPDATE advances `state_version`, a
> given barrier value can authorize at most one provider call.**

`prepareSubmit` mints the barrier **and** commits the `prepared → submitting`
authorization; `executeSubmit` then consumes the barrier in a short, separate
transaction (`consumeSubmitBarrier`) immediately before invoking the provider
function. The consume CAS is scoped to the full durable intent identity and the
appropriate execution context — intent id, exact `state_version`,
`status = 'submitting'`, tenant ownership (`user_id`, `execution_profile_id`),
mutation identity (`client_order_id`, `idempotency_key`, `request_hash`,
`attempt`) and binding (`provider_slug`, `environment`, `account_ref`). The
barrier object is untrusted input: every field must match the committed row.

The consuming write itself advances `state_version` (0029 trigger), which is
what makes the barrier single-use. A simple pre-call **read** of the state would
not be sufficient: after a `state_commit_failed` the intent is still
`status = 'submitting'`, so a read check would pass and a reused barrier could
invoke the provider a second time. The CAS is immune to this — the version has
already moved past `barrier.stateVersion`, the consume matches zero rows, and
the provider is never called. Reuse after a confirmed, rejected, reconciled or
uncertain outcome, after `state_commit_failed`, after restart recovery, after
operator resolution, or with a forged/stale barrier therefore fails closed.

Error semantics (fail closed in every case; the provider function is never
invoked):

| Consume outcome | Result |
|---|---|
| CAS matches zero rows (already consumed / superseded / forged / unknown intent / wrong tenant) | `ProviderMutationError('barrier_not_consumable')` — rolled back, nothing durable changes |
| Database failure during consumption | `ProviderMutationError('pre_call_persistence_failed')` — rolled back, nothing durable changes |
| CAS succeeds | one committed `submitting → submitting` consumption event; only then is the provider function invoked |

Consumption is append-only audit evidence, recorded through the existing
mutation-event mechanism with `detail.barrier = 'submit_barrier_consumed'` and
the consumed-from version; it claims no outcome, and no new event vocabulary,
state or migration was introduced. A failed consume attempt writes nothing: it
neither consumes the barrier nor disturbs durable state.

## 10. The existing 60-second risk TTL (§10)

`risk_reservations` keeps its TTL semantics and its reclaim path is untouched —
Gate 9 makes no change to risk, entitlement or kill-switch behavior.

The invariant is enforced on the mutation side: the mutation reservation keeps
`monetary_risk`, `symbol` and `direction`, and survives TTL reclamation of the
risk row (`ON DELETE SET NULL`). `unresolvedMutationExposure(profile)` reports
the durable exposure held by unresolved mutations, so restart, cleanup or TTL
expiry cannot authorize an unsafe duplicate mutation.

## 11. Attestation and credential boundary (§11)

Reference-only binding: `credential_ref` (identifier),
`credential_fingerprint` (non-secret sha-256), environment and account
references. `secretManagerIntegrated` is `false` in the contract
(`PROVIDER_MUTATION_SECRET_MANAGER_INTEGRATED`) and the binding schema refuses
any other value. No live credential is activated and no production broker
connectivity is introduced.

## 12. Database requirements (§12)

* One new migration, `0029`; `0028` is byte-identical and no earlier migration
  file was touched.
* `execution_orders.status` vocabulary, order-transition rules, global
  client-order/idempotency uniqueness and append-only history are untouched.
* Enforced where technically appropriate: unique mutation identity,
  account/profile ownership (FKs + ownership checks in the service), retry
  lineage (FKs + CHECK), valid FKs, and protection against stale/concurrent
  updates (`state_version` bumped by trigger; `UPDATE … WHERE state_version = $n`
  refuses a stale writer with `concurrent_state_change`).
* Upgrade safety: the new state-coherence CHECK and the global client-order
  unique index are scoped to Gate 9 rows (`idempotency_key IS NOT NULL`), and
  pre-existing `uncertain` rows are backfilled to require reconciliation, so an
  in-place 0028 → 0029 upgrade cannot fail on historical data.
* M3 adds `0030_provider_mutation_lineage_invariants.sql` — additive only:
  `execution_provider_intents_parent_uniq (parent_intent_id) WHERE parent_intent_id IS NOT NULL`,
  `execution_provider_intents_lineage_attempt_uniq (root_intent_id, attempt) WHERE root_intent_id IS NOT NULL`,
  and `execution_provider_intents_order_live_uniq (execution_profile_id, order_id)`
  for rows that are unresolved or provider-accepted (`order_id IS NOT NULL AND
  idempotency_key IS NOT NULL`). No DROP, ALTER, function replacement or data
  rewrite; `0029` is byte-identical and its triggers/CAS semantics (M2) are
  untouched. Legacy rows carry no lineage and no idempotency key, so they can
  never participate. A pre-flight refuses to apply (rolling back, modifying
  nothing) if existing Gate 9 rows already violate an invariant — conflicts
  are for an operator to review, never for a migration to "clean up".
  `execution_provider_intents` has no production writer other than the Gate 9
  ledger, which nothing in `apps/` invokes.

## 13. Test inventory (§13)

`packages/core/test/m10-gate9-mutation-persistence.test.ts` — 32 tests against
a real embedded PostgreSQL with an injected fake provider; every assertion reads
durable database state.

| §13 scenario | Test |
|---|---|
| 1 successful acceptance | `1. successful provider acceptance is durably confirmed with verified evidence` |
| 2 duplicate/idempotent | `2. …`, `2b. …` |
| 3 verified rejection | `3. …` |
| 4 timeout | `4. timeout fails closed…` |
| 5 lost response | `5. lost response fails closed…` |
| 6 malformed response | `6. malformed response fails closed…` |
| 7 unknown provider status | `7. unknown provider status…`, `7b. identity verification failure…`, `7c. transport failure…` |
| 8 crash before provider call | `8. …`, `8b. …` |
| 9 crash during/after provider call | `9. …`, `9b. …` |
| 10 restart and recovery | `10. an in-flight mutation survives restart…` |
| 11 receipt-persistence failure | `11. …` |
| 12 concurrent duplicates | `12. …`, `12b. …` |
| 13 reconciliation after uncertainty | `13. …`, `13b. verified absence is recorded as absence, never as a rejection`, `13c. valid not_found reconciliation preserves uncertainty and blocks retry until operator resolution` |
| 14 retry after resolved uncertainty | `14. …` |
| 15 retry while uncertainty remains | `15. …` |
| 16 stale reconciliation vs newer retry | `16. …`, `16b. …` |
| 17 risk-TTL expiry while uncertain | `17. risk-reservation expiry cannot erase unresolved mutation safety` |

Boundary tests: fail-closed identity validation, credential-shaped provider
responses, terminal-state immutability, retention of unresolved evidence, submit
only, no credential-shaped columns, and operator-resolution evidence rules.

`packages/core/test/m10-gate9-barrier-consumption.test.ts` — 12 focused M2
(single-use barrier consumption) tests against the same embedded PostgreSQL.
They never merely assert final database state: every scenario counts provider
invocations explicitly, and every reuse/forge/failure scenario proves the
provider invocation count did not change.

| M2 scenario | Test |
|---|---|
| Valid barrier consumed once: consume CAS → provider → receipt/outcome | `M2-1. …` |
| Sequential reuse after confirmed/rejected outcome | `M2-2. …` |
| Sequential reuse after uncertain outcome | `M2-3. …` |
| Reuse after `state_commit_failed` (defeats a pre-call READ check) | `M2-4. …` |
| Reuse after restart recovery | `M2-5. …` |
| Reuse after operator resolution | `M2-6. …` |
| Concurrent execution of one barrier → at most one provider call | `M2-7. …` |
| Forged/stale `stateVersion` cannot call the provider | `M2-8. …` |
| Zero-row CAS: unknown intent or wrong tenant cannot call the provider | `M2-9. …` |
| Database failure during consumption → `pre_call_persistence_failed`, no provider call | `M2-10. …` |
| Durable consume event persisted exactly once, audit detail, no secrets | `M2-11. …` |
| Retry barriers are single-use too | `M2-12. …` |

`packages/core/test/m10-gate9-m3-invariants.test.ts` — 21 focused M3 tests
against an embedded PostgreSQL. Concurrency tests use real concurrent database
transactions (separate pool connections), hold the winning transaction open
inside its locked check while sampling `pg_stat_activity` to prove the
competitors are blocked on the advisory lock, and assert how many operations
were actually authorized — never just the final rows.

| M3 scenario | Test |
|---|---|
| Concurrent duplicate submit for one order (different client order ids) → exactly one authorized | `M3-1. …`, `M3-1b. …` |
| Concurrent retry from one parent → exactly one retry, parent superseded once | `M3-2. …` |
| Sibling retry | `M3-3. …` |
| Start-over against an unresolved order; order-less identity semantics unchanged | `M3-4. …` |
| `provider_absent` resolution permits a new mutation (start-over or retry, not both) | `M3-5. …` |
| Uncertain mutation remains blocking through inconclusive reconciliation | `M3-6. …` |
| Retry binding mismatch (provider, environment, account, managed order) | `M3-7. …` |
| Stale parent (superseded pointer present / missing) | `M3-8. …` |
| Fresh risk/authorization reference requirement; Gate 9 mints none | `M3-9. …` |
| Different orders / execution profiles / bindings independent | `M3-10. …`, `M3-11. …`, `M3-12. …` |
| `state_commit_failed` interaction (incl. unchanged M2 barrier behaviour) | `M3-13. …` |
| Restart / reconciliation interaction | `M3-14. …` |
| Confirmed intent never retried; same order identity closed after confirmation | `M3-15. …` |
| Database failure inside the locked checks → rolled back, nothing created | `M3-16. …` |
| 0030 indexes exercised directly with raw concurrent transactions (order, parent, lineage attempt); legacy rows outside the index still block the ledger | `M3-17. …`, `M3-17b. …`, `M3-17c. …` |
| Bypassed application check → 0030 index still fails closed, reported with the M3 vocabulary (`unresolved_order_mutation` / `duplicate_mutation` / `parent_already_superseded` / `stale_parent_intent`) | `M3-18. …` |

`packages/core/test/m10-gate9-m3-migrations.test.ts` — 4 migration tests:
`0029` checksum pinned, `0030` additive-only tripwire, fresh apply creates
exactly the three partial unique indexes (and no new client-order index),
in-place 0029 → 0030 upgrade preserves every row, and `0030` refuses to apply
on conflicting rows without modifying anything.

## 14. Operator resolution (§14)

`resolveByOperator` requires an unresolved intent, an actor identity
(`operator:<id>` or `system:<component>`), a documented evidence reference and
(operator path) the resolving user. It writes an append-only
`execution_provider_resolutions` row, preserves the original client-order and
idempotency identity, and never deletes the uncertain record. Marking a finding
"resolved" is not evidence: an empty evidence reference is refused. Operator
resolution is also the only path through which an uncertain mutation can transition
to `provider_absent`, durably releasing its reservation after human/external review.

## 15. Retention (§15)

No automatic deletion of unresolved intents, reservations, receipts,
observations, resolutions or events is introduced — there is no cleanup routine
in Gate 9 at all. Unresolved rows are additionally protected by DELETE guards
and append-only triggers, so they survive process restart, worker restart and
ordinary cleanup jobs. Archival/retention policy remains separate future work.

## 16. Explicit non-goals (§16)

Not authorized and not present: live MT5 execution, Exness execution, production
broker connectivity, automatic trade execution, automatic reconciliation repair,
automatic retry, automatic cancellation/closure, secret-manager integration,
changes to the order-status vocabulary, modification of migration `0028`,
notification-system changes, or changes to unrelated risk/entitlement/kill-switch
behavior.

## 17. Completion criteria (§17) — read-only safety review

| Criterion | Status | Evidence |
|---|---|---|
| Durable submit intent exists before every provider-submit mutation | ✅ | `prepareSubmit` commits intent + reservation, then returns the barrier; `executeSubmit` only accepts a barrier |
| A barrier authorizes at most one provider call (M2 single-use consumption) | ✅ | `consumeSubmitBarrier` CAS on the exact `state_version` while `submitting`, committed before the call; `M2-1`–`M2-12` count provider invocations explicitly |
| Pre-call persistence failure blocks the provider call | ✅ | `8. a crash before intent commit permits no provider call at all`; `M2-10` (consume failure) |
| Duplicate submission prevented across restart/concurrency | ✅ | `2`, `8b`, `10`, `12`, `12b`, `M2-7`; unique indexes + advisory lock + barrier CAS |
| Uncertain outcomes survive restart | ✅ | `10`, `recoverAfterRestart`, DELETE guards |
| The 60s TTL cannot erase unresolved mutation safety | ✅ | `17`; `risk_reservation_id … ON DELETE SET NULL` + DELETE guard |
| Provider receipts are identity-verified and sanitized | ✅ | `execution_provider_receipts` CHECKs, `sanitizeProviderReceipt`, credential-leak test |
| Malformed/unknown responses fail closed into uncertainty | ✅ | `4`–`7c` |
| Retry requires resolution and a new mutation identity | ✅ | `14`, `15` |
| At most one unresolved mutation per managed order; concurrent submissions with different identities cannot both pass (M3) | ✅ | `M3-1`, `M3-1b`, `M3-4`, `M3-10`–`M3-12`; order advisory lock + live-order read in one transaction + `0030` index (`M3-17`) |
| One retry per parent, newest-member-only, no duplicate attempts (M3) | ✅ | `M3-2`, `M3-3`, `M3-8`; lineage lock + parent CAS + `0030` indexes (`M3-17b`) |
| Confirmed / provider-accepted intents are never retried or started over under the same order (M3) | ✅ | `M3-13`–`M3-15` |
| Retry keeps binding + order identity and needs a fresh risk/authz reference; Gate 9 mints neither (M3) | ✅ | `M3-7`, `M3-9`, `M3-11` |
| `provider_absent` releases the order; uncertainty keeps blocking (M3) | ✅ | `M3-5`, `M3-6`, `M3-14` |
| Reconciliation cannot overwrite a newer attempt | ✅ | `16`, `16b`, staleness trigger |
| All required fake-provider crash/recovery tests pass | ✅ | 32/32 in `m10-gate9-mutation-persistence.test.ts` |
| No live broker transport enabled | ✅ | No transport, route, registry entry or config change; `apps/` untouched |
| Migration `0028` unchanged | ✅ | SHA-256 `25359093…c5c9e49f`; `git diff` empty for that file |
| Migration `0029` unchanged; `0030` additive and refuses on conflicting data | ✅ | SHA-256 `a8c4cde5…2bde9ce7` pinned by `m10-gate9-m3-migrations.test.ts`; additive-only tripwire; conflict-refusal test |
| Fresh read-only safety review passes | ✅ | This section; no code path in the change performs network I/O, credential use or order mutation |

### Review walk-through (read-only)

1. **Entry points.** The only new exported code is `ProviderMutationLedger`
   plus pure contract helpers. Nothing imports it in `apps/`; nothing registers
   a provider; no route or worker exists.
2. **Network.** `packages/core/src/execution/provider-mutations.ts` imports only
   `node:crypto`-free contract helpers and `pg`. No `http`, `net`, `tls`,
   `child_process`, `fetch`, or environment access.
3. **Credentials.** No column, parameter or JSON field can carry a secret value;
   a forbidden-key CHECK guards persisted receipts and event details, and the
   binding schema pins `secretManagerIntegrated: false`.
4. **Fail-closed defaults.** Any failure outside a verified acceptance or
   rejection produces `uncertain` with reconciliation required; any failure
   before the barrier commit produces no provider call.
5. **Blast radius.** Six new tables, additive columns on one existing table, and
   triggers that only refuse illegal transitions/deletions. Earlier migrations,
   order status vocabulary, risk/notification behavior and `apps/` are untouched.
6. **M3 (Step 3c).** Three partial unique indexes and application checks inside
   the existing prepare transactions. `consumeSubmitBarrier` and the M2 barrier
   semantics, the provider call path, reconciliation, operator resolution,
   restart recovery, the risk engine, transport authorization, the kill switch
   and `apps/` are untouched; no automatic retry or repair is introduced.
