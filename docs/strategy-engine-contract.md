# How the Engine Consumes a StrategyVersion

This is the contract a **future deterministic strategy-evaluation engine**
(M2+) implements. M1 ships every *shape* the engine needs — the version
DTO, the immutable config, the condition registry, the scoring interfaces,
and the setup tables — but **no engine, no detection, no ingestion**.

## What the engine reads

The engine loads a **published** `StrategyVersionDetailDto` (via
`StrategyService.getVersion` / `GET /api/strategies/:id/versions/:versionId`).

Because a published version is **immutable** (frozen by the 0007 triggers),
the engine can trust the config: the exact definition that produced a setup
is preserved forever, and `setups.strategy_version_id` is the
traceability anchor that ties any setup/score back to that definition.

`config` (`StrategyVersionConfig`) contains:

- `timeframes` — role → canonical timeframe (`htf_bias`, `setup`, `entry`).
- `marketScope` — `all`, or an explicit normalized-instrument list.
- `sessionFilters` — optional session constraints.
- `risk` — min RR, SL method/buffer, TP method, TP1/2/3, min quality score.
- `filters` — optional strategy-level filters.
- `ruleGroups[]` — named groups, each with `logic` (`AND`/`OR`) and
  `conditions[]`.

Each condition carries `conditionType` (a registry key), `classification`
(`required`/`optional`/`confirmation`/`disqualifying`), `timeframeRole`,
and a `params` object (a **complete** snapshot — defaults baked in at
write).

## Evaluation loop (per instrument × per version)

1. Resolve instruments from `marketScope` (normalized, provider-agnostic).
2. For each timeframe role, fetch candles through the
   `ProviderRegistry` → `MarketDataProvider.getHistoricalCandles`.
3. Evaluate each `ruleGroup`: apply its `logic` (`AND`/`OR`) over its
   member conditions.
4. Each condition is evaluated by a handler for its `conditionType` (added
   later) against the candles/zones for its `timeframeRole`, using its
   `params`. Its `classification` determines the effect:
   - `required` — must be satisfied.
   - `confirmation` — must be satisfied at the entry timeframe.
   - `optional` — may contribute to the quality score.
   - `disqualifying` — if satisfied, the setup is **rejected**.
5. A setup **passes** when every `required` + `confirmation` condition is
   satisfied **and** no `disqualifying` condition is satisfied.

## Producing output

- A passing setup → insert a `setups` row with `strategy_version_id`,
  `instrument_id`, `state` (e.g. `developing`), `direction`, and
  entry/SL/TP derived from the version's `risk` config.
- State transitions → **append** to `setup_state_events`
  (append-only; UPDATE/DELETE are rejected by a trigger).
- Quality scoring → call `QualityScoringEngine.score(ScoringInput)` and
  persist the `SetupQualityScore` to `setup_scores` (append-only), using
  `qualityGrade(total)` for the band. `engineVersion` ties the stored
  score to the engine build that produced it.

## Determinism requirements

- **Same version + same input data = same result.** No hidden global
  state, no wall-clock dependence beyond the data, and **no AI in the
  signal path** — evaluation is deterministic rules.
- Condition evaluation is a **pure function** of `(candles, params)` — no
  side effects.
- The scoring engine is **I/O-free with respect to storage**: it receives
  a `ScoringInput` and *returns* a `SetupQualityScore`; persistence is the
  caller's responsibility (keeps the engine testable and swappable).
- Data access happens **only** through the `ProviderRegistry` and the
  contracts interfaces — never through a concrete provider.

## What M1 already provides for the engine

- The version DTO + **immutable** config (a complete snapshot).
- The **condition registry** (19 types) with strict `paramSchema`s — the
  engine adds a handler per `conditionType`.
- `qualityGrade`, `QUALITY_GRADE_BANDS`, and the
  `SetupQualityScore` / `QualityScoringEngine` interfaces.
- `setups` / `setup_state_events` / `setup_scores` tables with CHECK
  constraints and append-only guards.
- The `ProviderRegistry` + `MarketDataProvider` interfaces.
- The 8 setup-lifecycle states.

## What M1 does NOT provide

No detection / TA / liquidity / structure algorithms, no data ingestion,
no live scanner, no backtester, and no alert delivery. Those arrive in
later milestones on top of this contract.
