# Setup Alerts (M6, Phase 1)

M6 alerts notify an owner when one of their setups reaches an actionable
state with sufficient quality. Like M4 detection and M5 scoring, alert
generation is **invoked explicitly, never automatic**: there is no
scheduler, scanner, queue, or background worker. Phase 1 covers the
versioned contracts (`@veltrixeye/contracts`) and the alert + delivery
tables (`0012_alerts.sql`). Generation and acknowledgment services, HTTP
routes, and real delivery all belong to later phases.

## What Phase 1 does

- Defines the alert lifecycle contract: an alert is generated from one
  owned setup when (1) the setup is in an eligible state (`confirmed` or
  `triggered`), (2) an M5 score exists for the setup at its detection
  anchor, and (3) that score total is ≥ the version's
  `risk.minQualityScore` gate.
- Deduplicates by `(setup_id, trigger_state)`: a setup yields at most two
  alerts (`confirmed` + `triggered`), and generation retries collapse onto
  the existing row.
- Models alert status as `pending` → `acknowledged` | `suppressed`, with
  `acknowledged_at` recording when the owner acted. Status transitions are
  the only mutation alerts support; the service layer (later phase) owns
  the transition rules.
- Records delivery attempts in the append-only `alert_deliveries` ledger:
  one row per attempt with `channel`, `status`, `attempt`, optional
  `error`, and a `payload_hash` (sha256 of the rendered payload) for
  idempotency and audit.

## What Phase 1 does NOT do

No generation/scanning/scheduling of any kind, no HTTP routes, no web UI,
no **real delivery** — the only Phase 1 sender is the `stub` channel,
which records a `delivered` ledger row without any external I/O. The
`email` / `webhook` / `push` channel values are reserved in the schema so
real delivery needs no migration later. No AI/ML, no billing, no
providers, no credentials.

## Generation rule (pinned)

A later-phase `AlertService` must enforce, in order:

1. The setup exists, is owned by the caller, and is in state `confirmed`
   or `triggered` (any other state is a caller error, never an alert).
2. An M5 `setup_scores` row exists for the setup at its detection anchor.
3. That score total is ≥ the version's `risk.minQualityScore` at
   generation time (both values are snapshotted onto the alert row).
4. Upsert onto `(setup_id, trigger_state)` so retries are idempotent.
5. Record exactly one `stub` delivery attempt per generated alert.

Skipped generations (gate not met) produce no row and no delivery — silence
is explicit, not an error.

## Storage (0012)

`alerts` stores the owner, setup, strategy version, instrument, direction,
triggering state, score snapshot, a deterministic human-readable `title`
(≤ 280 chars), a structured `body` payload (levels, score reference —
never raw candles), and the mutable status. `alert_deliveries` is
append-only (the `append_only_guard()` trigger from 0007 is reused, never
redefined); ledger rows can never be updated or deleted. Both tables are
owner-scoped and cascade with their setup, so deleting a setup removes its
alerts and their delivery history.
