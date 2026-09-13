# Timeframes

## Canonical set

`packages/contracts/src/timeframes.ts` defines the canonical timeframe
vocabulary (the `TIMEFRAMES` constant) and `CANONICAL_MINUTES`:

```
1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M
```

- Minutes: `1m 3m 5m 15m 30m` (lowercase `m` = minutes)
- Hours: `1h … 12h`
- Days/weeks: `1d 3d 1w`
- **`1M` (capital M) = one month** — the single case where capitalization
  matters. This disambiguation is deliberate: free-form input like
  `90m` normalizes to minutes, while `1M` is the canonical month label.

`normalizeTimeframe(input)` accepts free-form minute values (`"90m"`,
`"90 M"`, `90`) and returns the canonical label, or rejects unknown
values. Everything downstream (DB CHECK constraints, provider
capabilities, engine requests) uses canonical labels only.

## Roles — timeframes are assigned, never hard-coded

A strategy version assigns timeframes to **roles**
(`strategy_timeframes` table, one row per role):

| role | meaning |
|---|---|
| `htf_bias` | higher-timeframe directional bias (reference: 1D/4H) |
| `setup` | the structure where setups form (reference: 1H) |
| `entry` | the execution timeframe for confirmations (reference: 15M/5M) |

The 1D/4H → 1H → 15M/5M combination is a **reference example**, not a
constraint: the role set is open, the CHECK constraint only pins the role
*names* (`htf_bias | setup | entry`) so the engine can reason about
"which timeframe serves which job", while any canonical timeframe may
fill any role. A user building a 4H-bias / 30m-setup / 5m-entry strategy
needs no code change.

Each condition also declares a `defaultTimeframeRole`
(`htf_bias | setup | entry | 'any'`) in its registry entry — this powers
the UI pre-fill and documents the condition's natural horizon, but a
persisted condition's `timeframe_role` can be set to whatever the user
chose.

## Where timeframes appear

- `strategy_timeframes` (per version, per role) — the strategy's own
  horizons.
- Condition entries' `timeframe_role` — which horizon a condition
  applies to at evaluation time.
- `MarketDataProvider.capabilities.timeframes` — what a data source can
  serve.
- `GET /api/strategies/meta` — serves the canonical list to the UI so the
  editor never hard-codes timeframes either.

## Invariants

- DB CHECK: stored timeframes must be canonical labels
  (`strategy_timeframes.timeframe IN (...)`).
- `htf_alignment`-style comparisons (HTF vs LTF) are defined by the roles
  present on the version, not by literal labels.
- No code path may branch on a literal timeframe string for business
  logic; branching belongs to the role. (Enforced by review + tests;
  the meta endpoint is the only place the list is served to clients.)
