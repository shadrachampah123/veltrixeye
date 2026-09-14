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
write).

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
param, capped at 5000). The service uses it to bound its store queries.

## Evaluation semantics

For each instrument in scope, for each direction (`long`, `short`):

1. Each condition is evaluated by the handler registered for its
   `conditionType` against the candles for its `timeframeRole` (role `any`
   uses the setup candles; `htf_alignment` always uses the HTF role), using
   its `params`. Direction-sensitive conditions (support/resistance, order
   blocks, FVG, supply/demand, sweeps, structure, engulfing direction, …)
   are evaluated **per direction**; `direction: 'either'` may satisfy via
   either side.
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
**candidate** deterministically, LONG-convention (per-direction levels are
an M4 concern): entry is the last closed setup candle's close; the stop is
`fixed` (entry − buffer), `structure` (last confirmed pivot low below entry,
minus buffer; fallback: window low − buffer), or `atr` (entry − ATR(14) −
buffer); RR take-profits are `entry + riskDistance × {tp1Rr, tp2Rr,
tp3Rr}` with `achievableRr = tp3Rr`; a `structure` TP method targets the
nearest pivot beyond entry. A degenerate candidate (non-positive risk
distance) is `null` and noted — never fabricated.

## Producing output

`evaluate(config, candlesByRoleAndInstrument, asOfMs)` returns a pure
`EvaluationResultDto` (`@veltrixeye/contracts`, validated by
`evaluationResultSchema`): `engineVersion` (`m3-deterministic-eval-1`),
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

No setup detection or persistence, no setup-lifecycle transitions, no
quality scoring, no scheduler/cron or live scanner, no realtime streaming,
no alert delivery, no backtester, and no provider fetch-through. The M3
result DTO is deliberately shaped so M4 can consume it additively.
