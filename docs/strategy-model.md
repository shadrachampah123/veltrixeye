# Strategy Model

A strategy is a versioned, deterministic rule set. This document describes
how it is modeled, validated, and protected.

## Versioning

- A `strategy` holds mutable metadata (name, description, status). Its
  definition lives in `strategy_version` rows.
- **Drafts**: at most one per strategy. The UI editor edits the draft
  (full-replace semantics on the config).
- **Publishing**: `publishVersion` validates the config
  (`validatePublishable` — required timeframes, at least one *required or
  confirmation* condition group that can actually pass, valid risk
  configuration), then flips `draft → published` with a `published_at`.
  Publishing a version that is not draft-only-conflicting is rejected.
- **New versions**: created from the current version (`fromVersionId`
  clones the whole config) — the old version is frozen, the clone becomes
  the new draft.
- **Immutability**: after publish, a version's config tables are frozen by
  DB triggers (0007). `strategy_version_guard` rejects any UPDATE to
  non-deprecation fields on non-draft versions; `version_config_guard` /
  `condition_group_guard` reject INSERT/UPDATE/DELETE into the config
  tables of non-draft versions. Deprecation (`published → deprecated`)
  only flips a flag and is the one allowed mutation.
- **Delete rules**: a strategy can be deleted only while its single
  version is a draft; strategies with published history can be
  **archived** but not deleted (history must remain traceable).

The stored config is a **complete snapshot**: on every write, condition
params are run through the type's zod `paramSchema` (defaults baked in),
so a version read back 3 years later evaluates identically even if
registry defaults change.

## Condition types (extensible registry)

`packages/contracts/src/conditions.ts` exports
`CONDITION_TYPE_REGISTRY` — the single source of truth for condition
types. It is deliberately **code, not a database enum**: the
`strategy_conditions.condition_type` column is `text`, and the API
validates against the registry. Adding a type = add one registry entry
(additive, no migration, no fragile list to update elsewhere).

Each entry declares: `type` (stable snake_case id), `label`,
`description`, `categories`, `defaultTimeframeRole`, and a **strict**
`paramSchema` (unknown param keys rejected).

The 19 M1 types:

| type | label | categories | default role |
|---|---|---|---|
| `liquidity_sweep` | Liquidity sweep | price_action, structure | setup |
| `choch` | Change of character (CHoCH) | structure | setup |
| `bos` | Break of structure (BOS) | structure | setup |
| `break_retest` | Break & retest | structure, price_action | setup |
| `order_block` | Order block | zone, price_action | setup |
| `fvg` | Fair value gap | zone | setup |
| `support` | Support level | level | setup |
| `resistance` | Resistance level | level | setup |
| `supply` | Supply zone | zone | setup |
| `demand` | Demand zone | zone | setup |
| `rejection_candle` | Rejection candle | price_action | entry |
| `engulfing_candle` | Engulfing candle | price_action | entry |
| `displacement` | Displacement | price_action, structure | setup |
| `rr_requirement` | Risk:reward requirement | risk | any |
| `session_requirement` | Session requirement | time | any |
| `news_filter` | News filter | market_filter | any |
| `volatility_filter` | Volatility filter | market_filter | any |
| `spread_filter` | Spread filter | market_filter | any |
| `htf_alignment` | HTF alignment | structure | setup |

Note: the registry stores **definitions only** — no detection logic. The
M1 param schemas encode the *shape* of what a future engine will need
(e.g. `liquidity_sweep.side: above|below`, `news_filter.maxImportance`).

## Classifications

Every persisted condition carries one of:

- `required` — must be satisfied for the setup to pass.
- `optional` — may contribute to the quality score.
- `confirmation` — must be satisfied at the entry timeframe.
- `disqualifying` — if satisfied, the setup is rejected.

Publish validation requires the strategy to contain at least one
`required` or `confirmation` condition (a strategy that can never pass is
not publishable); optional/disqualifying-only strategies are rejected.

## Rule groups

Conditions are organized into named **rule groups** with boolean `logic`
(`AND | OR`) over their member conditions; groups are ordered by
`position` (the API derives `position` from array order, so authoring
order is authoritative). The future engine evaluates each group
independently, then combines groups (top-level AND semantics in M1's
model). The structure is intentionally simple now; adding nesting or
weighted groups later is additive to the schema.

## Reference strategy (structure only)

The reference flow that shaped this model — **1D/4H bias → 1H structure →
liquidity id → sweep → CHoCH/BOS → OB/FVG/S&R → break & retest → 15M/5M
confirmation → entry/SL/TP1-3 → RR → quality score → filters → alert** —
is representable entirely with the types above (e.g. `htf_alignment` for
the bias, `liquidity_sweep` + `choch`/`bos` + `order_block`/`fvg`/
`support`/`resistance` for structure, `rejection_candle`/
`engulfing_candle` as entry-timeframe confirmations, `rr_requirement` +
`session_requirement` + `news_filter`/`volatility_filter`/`spread_filter`
as filters). M1 implements **no detection**; the model is the contract the
engine will fulfill.

## Quality score & risk configuration (foundation only)

- `strategy_risk_config` (one row per version): `min_rr` (default **2** =
  1:2), `stop_loss_method` (`structure | atr | fixed`) + buffer + unit,
  `take_profit_method` (`structure | rr | manual`), `tp1_rr < tp2_rr <
  tp3_rr` (enforced), `min_quality_score` (default **65**).
- Quality grades are pure constants in
  `packages/contracts/src/scoring.ts`: `90–100 A+`, `85–89 A`, `75–84 B`,
  `65–74 C`, `<65 Ignore`, plus `qualityGrade(score)` mapping. **No
  scoring logic** ships in M1 — only the scale, so engine output and
  storage already agree on grades.
