# Setup Detection (M4)

M4 is the deterministic setup-detection layer. It consumes M3 evaluation
results and persists detected setups plus their lifecycle transitions in
the existing `setups` / `setup_state_events` tables:

```
market candles → M3 strategy evaluation → M4 detected setup + lifecycle
```

## What M4 does

- Runs the M3 evaluation for one instrument of a **published** strategy
  version at an explicit `asOf` anchor (no wall clock anywhere in M4).
- Persists exactly one setup per qualifying direction (`passed`), in state
  `confirmed`, with deterministic entry/SL/TP levels.
- Returns the existing setup — writing nothing — when the same detection
  is repeated, including under concurrent requests.
- Transitions setups through an explicit state machine, one event per
  transition, fully atomic.
- Leaves scoring entirely to M5: `setup_scores` is never written and
  `quality_score` stays NULL.

## What M4 does NOT do

No quality scoring (M5), no alerts (M6), no backtester, no realtime
streaming, no scheduler/cron/queue workers, no provider calls, no AI.

## Lifecycle

States are exactly the eight the 0006 schema defines — M4 invents none:

```
developing → watching → almost_ready → confirmed → triggered → completed
     ↘ invalidated / expired (reachable from every non-terminal state)
```

Detection enters the machine at **`confirmed`**: M4 has no progressive
scanner, so a qualifying evaluation (every required/confirmation condition
satisfied, no disqualifying veto) is by definition confirmed, not
developing. The earlier states exist in the machine for forward-compatible
transitions; nothing in M4 creates them.

The machine (`SETUP_TRANSITIONS` in `@veltrixeye/contracts`,
`assertTransition` in `@veltrixeye/core`) is the single validator every
transition path calls before writing:

| From | Allowed `toState` |
|---|---|
| developing | watching, invalidated, expired |
| watching | almost_ready, invalidated, expired |
| almost_ready | confirmed, invalidated, expired |
| confirmed | triggered, invalidated, expired |
| triggered | completed, invalidated, expired |
| completed / invalidated / expired | *(terminal — none)* |

Terminal states are absorbing: requesting the current state is an
idempotent success (`transitioned: false`, no new event), and any other
outbound transition from a terminal state is rejected.

## Detection semantics

`POST /api/strategies/:strategyId/versions/:versionId/detect`
`{ instrument: { assetClass, symbol }, direction?, asOf }`
(`asOf` **required**; omit `direction` for both, reported long-first):

1. Resolve the instrument (unknown → 404).
2. Run `EvaluationService.evaluateVersion` — ownership masking,
   published-only (draft → 400; deprecated versions detect, matching M3),
   and store-only candle reads are all inherited. M4 contains zero
   condition logic.
3. The instrument must be in the version's evaluated scope, else 400.
4. Per direction: `passed` qualifies; anything else (`unsatisfied`,
   `insufficient_data`, `unsupported`, vetoes) yields
   `{ qualified: false, setup: null }` with the M3 `failureReasons` and
   writes nothing — the engine never silently passes, and neither does M4.
5. A qualifying direction inserts one setup row plus one `NULL → confirmed`
   state event (`reason: 'detected'`), atomically.

`detected_at` and the event's `created_at` are the supplied anchor (not
the clock); `metadata` carries the pinned `detectorVersion`
(`m4-setup-detect-1`), `asOfMs`, and the M3 `engineVersion`.
`expires_at` stays NULL — no expiry duration is defined yet, so expiry is
an explicit transition, not a computed deadline.

Detection never transitions, invalidates, or resurrects existing setups:
a repeat against a terminal setup returns it unchanged.

## Levels

M3's candidate is LONG-convention ("per-direction levels deferred to
M4"). M4 fulfills that: long setups store the candidate as-is; short
setups mirror every leg around the entry (`2 × entry − price`), preserving
the exact risk distance with the stop above and the targets below. A null
candidate persists as all-null levels, and a mirrored leg that would land
on the wrong side degrades to null rather than storing inverted levels.
Pure function: `detectionLevels` in `@veltrixeye/core`.

## Idempotency and concurrency

The detection key `(strategy_version_id, instrument_id, direction,
as_of_ms)` is a UNIQUE constraint (migration 0009). Repeats fast-path on
a SELECT; concurrent duplicates serialize on the constraint — the loser
catches `23505` and re-selects the winner's committed row, so exactly one
setup and one event exist per key. Transitions take `SELECT … FOR UPDATE`
inside a transaction: concurrent same-state repeats collapse into one
transition plus idempotent no-ops, and invalid transitions roll back with
zero partial writes.

## Setup endpoints

| Endpoint | Purpose |
|---|---|
| `POST …/versions/:versionId/detect` | detect (20 req/min, audit `setup.detected`) |
| `GET /api/setups` | own setups, newest first; optional `strategyId`, `versionId`, `state`, `direction`, `limit` (≤ 100) |
| `GET /api/setups/:setupId` | one setup + lifecycle events, oldest first |
| `POST /api/setups/:setupId/transitions` | `{ toState, reason?, asOf }` (60 req/min, audit `setup.transitioned`) |

All are session-authenticated and owner-scoped through the setup's
strategy: foreign or malformed ids are masked 404s, never 403s.

## Determinism

Same version + instrument + direction + `asOfMs` + candle data ⇒ same
setup decision, same levels, same row identity. Distinct anchors are
distinct detections. No `Date.now` exists anywhere in the M4 decision
path; the only timestamps are caller-supplied anchors (row `updated_at`
remains trigger-maintained metadata, as in M1–M3).
