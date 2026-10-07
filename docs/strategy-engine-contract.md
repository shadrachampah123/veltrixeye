# How the Engine Consumes a StrategyVersion

This is the contract implemented by the **M3 deterministic strategy-evaluation
engine**. M1 shipped every *shape* — the version DTO, the immutable config,
the condition registry, the scoring interfaces, and the setup tables. M2
shipped the shared candle store. M3 ships the engine itself: a pure,
deterministic evaluator that reads a **published** version and the candle
store and **reports** whether each instrument currently satisfies the
strategy — without persisting anything.

## What the engine reads

The engine loads a **published** `StrategyVersionDetailDto` (via
`StrategyService.getVersion`). Because a published version is **immutable**
(frozen by the 0007 triggers), the engine can trust the config: the exact
definition that produced a result is preserved forever.

`config` (`StrategyVersionConfig`) contains:

- `timeframes` — role → canonical timeframe (`htf_bias`, `setup`, `entry`).
- `marketScope` — `all`, or an explicit normalized-instrument list.
- `sessionFilters` — optional session constraints (UTC windows, or named
  sessions; `exchange` timezone is **unsupported** and fails closed).
- `risk` — min RR, SL method/buffer, TP method, TP1/2/3, min quality score.
- `filters` — optional strategy-level filters (reported, not yet enforced).
- `ruleGroups[]` — named groups, each with `logic` (`AND`/`OR`) and
  `conditions[]`.

Each condition carries `conditionType` (a registry key), `classification`
(`required`/`optional`/`confirmation`/`disqualifying`), `timeframeRole`,
and a `params` object (a **complete** snapshot — defaults baked in at
write). `params` may also carry `anchorOffsetCandles` (default `0`, see
"Sequential anchors" below), the one param the ENGINE consumes rather than a
handler.

### Candles come from the store — never from a provider

Evaluation reads **only** from the shared candle store (`CandleStore`).
It **never** triggers provider fetch-through: evaluation works identically
on a deployment with no provider key. The caller supplies
`candlesByRole` (role → ascending candles for the resolved timeframe) and an
explicit `asOfMs` anchor. Only **closed** candles participate:
`time + periodMs ≤ asOfMs`. There is **no wall clock inside the engine** —
the only clock read in the whole path is the API edge defaulting `asOf` to
"now" when the request omits it.

`requiredWindows(config)` computes how much history each role needs (base
120 per role, floors for FVG/supply/demand/HTF, plus every `lookback*`-style
param and every condition's `anchorOffsetCandles`, capped at 5000). The service
uses it to bound its store queries; M6 sizes its warm-up and per-role coverage
windows from the same function, so live evaluation and replay fetch the same
history.

## Evaluation semantics

For each instrument in scope, for each direction (`long`, `short`):

1. Each condition is evaluated by the handler registered for its
   `conditionType` against the candles for its `timeframeRole` (role `any`
   uses the setup candles; `htf_alignment` always uses the HTF role), using
   its `params`. Direction-sensitive conditions (support/resistance, order
   blocks, FVG, supply/demand, sweeps, structure, engulfing direction, …)
   are evaluated **per direction**; `direction: 'either'` may satisfy via
   either side.
### Sequential anchors — `anchorOffsetCandles`

Every condition type accepts one extra optional param, `anchorOffsetCandles`
(integer ≥ 0, default **0**), applied by the ENGINE and never by a handler:

- **0** (and absent, which is what every config stored before the param existed
  contains) evaluates the condition against the latest CLOSED candle of its
  `timeframeRole` — the pre-`m3-deterministic-eval-3` behaviour, unchanged.
- **N > 0** evaluates the condition against that role's candle series
  truncated by N candles: the role's anchor moves back N bars, counted in the
  role's OWN timeframe. Every other role is untouched, and the handler receives
  exactly the shape it always did.

This is the minimum needed to express a SEQUENCE on one anchor:

```
4h liquidity sweep   (timeframeRole htf_bias, anchorOffsetCandles: 1)  ← completed on the previous 4h candle
1h break & retest    (timeframeRole setup,    anchorOffsetCandles: 0)  ← at the anchor
15m rejection candle (timeframeRole entry,    anchorOffsetCandles: 0)  ← at the anchor
```

Without the offset all three legs must hold on the SAME anchor candle, which is
a different (and stricter) claim than "the sweep came first, then the trigger".
An offset deeper than the fetched history leaves the handler with too few
candles, so it reports `insufficient_data` and the direction fails closed —
never a silent re-anchoring on the latest candle. Candidate levels
(`rr_requirement`) remain derived at the EVALUATION anchor: they are a property
of the version's risk config, not of a condition's role series.

`requiredWindows` adds each condition's offset to that condition's role window,
so `EvaluationService`'s store reads and M6's warm-up/coverage windows
(`setupCoverageWindow`, `roleCoverageWindow`) fetch the history the offset can
read. The offset is echoed in the condition outcome's detail
(`[anchor offset N × 4h]`) so a result can always be traced back to the exact
candles behind it.

2. A condition outcome is one of:
   - `satisfied` — the condition currently holds.
   - `unsatisfied` — it does not hold (with a deterministic detail string).
   - `insufficient_data` — not enough closed history to decide. **Fail
     closed**: a `required`/`confirmation` condition that cannot be
     evaluated blocks the direction even inside an otherwise-satisfied OR
     group; a `disqualifying` condition that cannot be evaluated is
     reported ("could not be ruled out") but is not a veto.
   - `unsupported` — unknown `conditionType`, params outside the registry
     schema, or a handler-level unsupported case (e.g. `session_requirement`
     with `timezone: 'exchange'`). **The engine never silently passes** a
     condition it cannot understand.
   - `news_filter` and `spread_filter` **always** return
     `insufficient_data` — there is no news-calendar or spread data source,
     and the engine refuses to fake one.
3. Each `ruleGroup` applies its `logic`: `AND` (an empty group is
   satisfied) or `OR` (any member satisfied). Groups combine with a
   top-level `AND`.
4. Classification effects:
   - `required` — must be `satisfied`.
   - `confirmation` — must be `satisfied` at the entry timeframe.
   - `optional` — reported only; never gates the direction.
   - `disqualifying` — if `satisfied`, the direction is **vetoed**.
5. A direction **passes** when every group is satisfied, every
   `required` + `confirmation` condition is `satisfied`, and no
   `disqualifying` condition is `satisfied`.

### Candidate entry/SL/TP (rr_requirement only)

When the version's risk config demands it, the engine derives a
**candidate** deterministically: entry is the last closed setup candle's
close; the stop is `fixed` (entry − buffer), `structure` (last confirmed
pivot low below entry for longs or pivot high above entry for shorts, with a
window-extreme fallback), or `atr` (entry − ATR(14) − buffer). RR
take-profits remain LONG-convention at `entry + riskDistance × {tp1Rr,
tp2Rr, tp3Rr}` with `achievableRr = tp3Rr`. A `structure` TP method stores
the nearest opposing swing as its sole TP1 (lowest pivot high above entry
for longs, highest pivot low below entry for shorts) and measures
`achievableRr` to that target. A degenerate candidate (non-positive risk
distance) is `null` and noted — never fabricated.

The buffer → price conversion is **pip-authoritative** (`m3-deterministic-eval-2`):
a `pips` buffer is multiplied by the instrument's pip size from
`instrument_risk_specs.pip_size` (M8.2, migration 0017), passed in as the
engine input's `pipSize`. There is no symbol/quote heuristic anywhere in M3.
A `pips` buffer with a missing, non-finite or non-positive pip size cannot be
converted, so it **fails closed**: no candidate levels are derived and
neither direction may pass for that anchor (the failure reason and a note name
`instrument_risk_specs.pip_size`). A `pct` buffer scales off the entry price
and never needs a spec. `EvaluationService` resolves the pip size for each
evaluated instrument; the M6 backtest service passes the same column into its
replays, so live evaluation and replay agree.

## Producing output

`evaluate(config, candlesByRoleAndInstrument, asOfMs)` returns a pure
`EvaluationResultDto` (`@veltrixeye/contracts`, validated by
`evaluationResultSchema`): `engineVersion` (`m3-deterministic-eval-3`),
`asOfMs`, `truncated`, and per instrument `per-direction` outcomes with
groups, condition outcomes, session-filter outcomes, the optional candidate,
`failureReasons`, and `notes`. **Nothing is written.** M3 does not insert
`setups`, `setup_scores`, or `setup_state_events` — persistence, state
transitions, and quality scoring are the M4 boundary (they will consume this
exact result).

The API surface is
`POST /api/strategies/:strategyId/versions/:versionId/evaluate`:
session-authenticated, owner-scoped (foreign/missing versions are masked
404s), **published versions only** (draft → 400), zod-validated body
(`{ asOf?: number }`), bounded scope (≤ 50 instruments; `scope: all`
enumerates the instrument universe and reports truncation), a dedicated
20 req/min rate limit, a `strategy.evaluated` audit event, and generic safe
errors. Same version + same store + same `asOf` → byte-identical response.

## Determinism requirements

- **Same version + same input data + same `asOfMs` = same result.** No
  hidden global state, no wall clock inside the engine, and **no AI in the
  signal path** — evaluation is deterministic rules.
- Condition evaluation is a **pure function** of `(candles, params,
  direction, risk, asOfMs)` — no side effects, no I/O.
- Indicator primitives (Wilder ATR, strict-fractal pivots, candle anatomy,
  engulfing, displacement, level touches, zones, OB/FVG/supply-demand,
  break/retest, HTF structure bias, UTC session windows) live in
  `packages/core/src/strategies/evaluation/indicators.ts` and are pure.

## What M3 does NOT provide (the M4 boundary)

M4 consumes this exact result DTO additively: setup detection, persistence
and lifecycle transitions shipped in M4 (see
[setup-detection.md](./setup-detection.md)). Still out of scope: quality
scoring (M5), alert delivery (M6), backtester, scheduler/cron and live
scanners, realtime streaming, and provider fetch-through.
