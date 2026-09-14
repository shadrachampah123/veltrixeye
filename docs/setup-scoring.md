# Setup Quality Scoring (M5)

M5 is the deterministic quality-scoring layer. It consumes an existing
M4 setup, rebuilds its M3 evaluation context, and produces a reproducible,
explainable **setup quality score** persisted in the append-only
`setup_scores` table:

```
market candles → M3 strategy evaluation → M4 detected setup → M5 quality score
```

A quality score is an objective measure of the **strength and completeness
of the evidence** behind a detected setup. It is **not** a prediction: it
implies no probability of profit and no expected outcome.

## What M5 does

- Scores one owned setup at a deterministic anchor via
  `POST /api/setups/:setupId/score`.
- Rebuilds the scoring context exclusively through the existing M3
  `EvaluationService.evaluateVersion` — ownership masking, published-only
  gate, and store-only candle reads are inherited. M5 contains zero
  condition logic and performs zero provider calls.
- Runs the pure scoring engine (`scoreSetupQuality` in `@veltrixeye/core`)
  — no clock reads, no randomness, no I/O inside scoring logic.
- Persists one append-only `setup_scores` row per scoring context and
  refreshes `setups.quality_score` transactionally with the insert.
- Serves the append-only score history via `GET /api/setups/:setupId/scores`.

## What M5 does NOT do

No alerting/notifications (M6), no backtesting, no trade execution, no
realtime/WebSockets, no scheduler/cron/queues, no AI/ML, no provider calls
or fetch-through, and **no lifecycle changes**: scoring never confirms,
triggers, completes, invalidates, or expires a setup — M4 owns lifecycle.

## Scoring engine contract

The engine is pinned as **`m5-quality-score-1`**
(`M5_SCORE_ENGINE_VERSION` in `@veltrixeye/contracts`), stored in
`setup_scores.engine_version`. The formula below is frozen for this
version: **any formula change MUST ship under a new version string** — the
same version must always mean the same score.

Guarantees: identical `(strategy version, setup, evaluation result,
instrument, timeframe, asOfMs)` inputs always produce the identical score.
The engine reads only the M3 `DirectionEvaluation` of the setup's
direction, the version's configured `minRr`, and the anchor — nothing else.
`generatedAt` is the ISO-8601 rendering of the anchor, never a wall-clock
read.

## Formula (`m5-quality-score-1`)

Seven fixed components; weights sum to exactly 100. Each component reports
a 0–100 `score`, a raw contribution (`points`), a maximum contribution
(`maxPoints` = weight), and a deterministic `explanation`. The total is
`round(Σ points)` clamped to 0–100; the grade follows the M1 bands
(A+ ≥ 90, A ≥ 85, B ≥ 75, C ≥ 65, else `ignore`).

| # | Component | Weight | Meaning |
|---|---|---|---|
| 1 | `required_conditions` | 25 | 100 × (satisfied / declared) for `required` conditions. None declared ⇒ 100 (vacuously clear, exactly M3's satisfaction semantics). |
| 2 | `confirmation_conditions` | 15 | Same rule for `confirmation` conditions. |
| 3 | `disqualifier_clearance` | 20 | 100 × (ruled out / declared) for `disqualifying` conditions. A disqualifier is cleared only when evaluated `unsatisfied`; `satisfied` vetoes and `insufficient_data`/`unsupported` are NOT cleared (fail closed). None declared ⇒ 100. |
| 4 | `optional_support` | 15 | 100 × (satisfied / declared) for `optional` conditions. None declared ⇒ **0** — absence of evidence earns no points. |
| 5 | `directional_alignment` | 10 | 100 × (satisfied / declared) for non-disqualifying conditions on the `htf_bias` timeframe role. None declared ⇒ **0**. |
| 6 | `setup_completeness` | 10 | Four equal sub-checks (2.5 each): candidate entry/stop derived; all three TP targets derived; achievable R:R ≥ the version's `minRr`; every session filter satisfied at the anchor (no filters ⇒ vacuously satisfied). |
| 7 | `data_sufficiency` | 5 | 100 × (evaluable / total) across conditions + session filters, where evaluable means `satisfied` or `unsatisfied`. Nothing declared ⇒ **0**. |

Design rule: **gate components** (1–3) treat "none declared" as vacuously
clear and award full points — mirroring M3's pass semantics; **evidence
components** (4, 5, 7) award nothing when nothing is declared, so quality
is never manufactured from the absence of evidence.

### Failing-direction cap

If the setup's direction does **not** pass its M3 evaluation at the
scoring anchor (any veto, unsatisfied gate, or unevaluable gate condition —
including `insufficient_data`), the total is capped at **64**
(`M5_FAILING_DIRECTION_CAP`), the highest integer below the C band. A
failing direction therefore always grades `ignore`: scoring never
manufactures a high-quality score from an evaluation that did not pass.

Reference points (pinned arithmetic):

- Fully supported passing setup (every classification present and in
  favour, complete candidate, RR ≥ minRr) ⇒ **100 / A+**.
- Minimal passing setup (single satisfied required condition, complete
  candidate, RR ≥ minRr, nothing else declared) ⇒ 25 + 15 + 20 + 0 + 0 +
  10 + 5 = **75 / B**.

## Missing / insufficient data — explicit rules

- **Insufficient candles**: any gate condition in `insufficient_data`
  means the direction does not pass ⇒ the 64 cap applies; the condition
  also contributes zero to its component and lowers data sufficiency.
- **Unsupported condition**: treated exactly like `insufficient_data` for
  gates; for optional conditions it earns no support and lowers data
  sufficiency.
- **Missing optional data**: optional conditions simply earn nothing;
  they never block.
- **Missing candidate levels**: candidate-derived sub-checks of setup
  completeness fail (null candidate ⇒ entry/stop, targets and RR checks
  all fail; `manual` take-profit methods report no measurable R:R).
- **Incomplete evaluation** (direction not passing at the anchor): the
  failing-direction cap applies. Scoring is still recorded — honestly.
- **Invalid setup state**: setups in terminal states (`completed`,
  `invalidated`, `expired`) are refused with 400 and never scored; M5
  never transitions them.

## Scoring context and idempotency

The scoring context is `(setup_id, engine_version, as_of_ms)`. Migration
**0010** adds `setup_scores.as_of_ms` (NOT NULL) and
`UNIQUE (setup_id, engine_version, as_of_ms)` — the additive requirement
for safe idempotent/versioned scoring on the existing append-only table
(migrations 0001–0009 are untouched).

- The anchor defaults to the setup's own detection anchor
  (`setups.as_of_ms`), i.e. scoring reproduces the exact context the setup
  was detected from. An explicit `asOf` re-scores at another point in
  time; each distinct anchor is a distinct scoring context.
- A replayed context returns the stored row (`created: false`) without
  re-evaluating — one score per context, forever.
- Concurrent duplicates serialize with
  `INSERT … ON CONFLICT (setup_id, engine_version, as_of_ms) DO NOTHING`:
  exactly one insert wins; losers commit a no-op and return the winner's
  row. The conflict path never aborts a transaction.
- `setup_scores` remains append-only (0007 trigger): history rows are
  never updated or deleted; `setups.quality_score` is refreshed inside the
  same transaction as the insert and reflects the latest score only.
- `setup_scores.created_at` is written as the scoring anchor (the M4
  transition convention), so stored rows are fully deterministic in
  (setup, engine version, anchor).

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/setups/:setupId/score` | `{ asOf? }` — score at the anchor (default: the setup's detection anchor). 20 req/min, audit `setup.scored`. Returns `{ setup, score, created }`. |
| `GET /api/setups/:setupId/scores` | Append-only score history, newest anchor first; optional `limit` (≤ 100, default 50). |

Both are session-authenticated and owner-scoped through the setup's
strategy (setup → `strategy_versions` → `strategies.user_id`): foreign or
malformed ids are masked 404s, never 403s. Scoring inherits M3's
published-only gate (draft version ⇒ 400) and never calls a provider —
the evaluation service reads the shared candle store only.

The score breakdown exposes component names, labels, weights, scores,
raw/max contributions and explanations — evidence, not implementation
secrets: no candle payloads, no internal queries.

## Audit

Every scoring request records `setup.scored` (entity `setup`) with
`{ total, grade, engineVersion, asOfMs, created }` metadata, matching the
M3/M4 audit conventions.

## Boundaries

- M3 is consumed through `EvaluationService` — M5 re-implements no
  condition logic and changes none.
- M4 lifecycle is untouched — scoring writes no `setup_state_events` and
  never transitions a setup.
- No M6 functionality: no alerts, no `minQualityScore` enforcement (the
  risk-config field stays a downstream concern), no notifications.
- No scheduler, no background scanning, no realtime — scoring is
  explicitly invoked.
