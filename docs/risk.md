# Risk Management Engine (M8.2)

M8.2 is the **central server-side risk engine**. It produces the risk
decision that M8.1's `risk_decision` and `exposure_limits` gates consume.

**M8.2 does not execute trades.** No real, demo or paper order is placed.
Automation stays OFF. There is no broker, MT5 or Exness connectivity.
Risk approval is **not** permission to execute — every M8.1 safety gate
still has to pass, and the paper provider still reports not-ready.

## Position in the pipeline

```
Market Data → Strategy Detection → Setup Qualification → Signal/Quality
Validation → Risk Engine → Execution Decision → Execution Provider
```

The intake service (`ExecutionIntakeService`) always calls
`RiskEngineService.evaluate` and feeds the **server-issued** decision
into `evaluateExecutionGates`. A client-provided `{ approved: true }`
fails the gate: the verdict must carry a persisted `decisionId` and
`engineVersion`.

## Architecture

| Piece | Location |
|---|---|
| Contracts | `packages/contracts/src/risk-engine.ts` |
| Decimal arithmetic | `packages/core/src/risk/decimal.ts` |
| Position sizing | `packages/core/src/risk/sizing.ts` |
| Reward:risk | `packages/core/src/risk/rr.ts` |
| Policy ceilings | `packages/core/src/risk/policy.ts` |
| Pure engine | `packages/core/src/risk/engine.ts` |
| Persistence / locks | `packages/core/src/risk/service.ts` |
| Schema | `packages/core/src/db/migrations/0017_risk_engine.sql` |
| HTTP | `GET/PATCH /api/risk/policy`, `GET /api/risk/decisions` |

The engine is **pure**: same authoritative inputs ⇒ same verdict. The
service supplies those inputs from the database (never from client P&L,
open-position counts or loss counters) and persists the result.

Engine version: `m8.2-risk-engine-1`.

## Risk-policy model

One server-owned `risk_policies` row per user. Defaults sit inside the
platform envelope; CHECKs make a 50% risk setting **unrepresentable**.

User-editable fields (PATCH `/api/risk/policy`) are rejected — not
silently clamped — when they exceed a ceiling or drop `minRr` below 2.

Optional `risk_strategy_overrides` can only **tighten** (higher min RR,
lower risk %, or `blocked`).

Paper equity is a **simulation parameter** bounded
`[100, 1_000_000]`, default `10_000`. It is not a live broker balance.

## Platform safety ceilings

Immutable, server-controlled (`PLATFORM_RISK_CEILINGS`):

| Ceiling | Value |
|---|---|
| Max risk % per trade | 1% |
| Max monetary risk per trade | 10_000 |
| Max daily loss % | 5% |
| Max weekly loss % | 10% |
| Max consecutive losses | 5 |
| Max simultaneous positions | 5 |
| Max total open risk % | 5% |
| Max exposure per instrument % | 2% |
| Max exposure per direction % | 3% |
| Max position size | 100 |
| Minimum RR | **1:2** |
| Paper equity | 100 – 1_000_000 |

The engine re-applies these at evaluation time so a crafted row cannot
weaken safety.

## Position-sizing formula

Uses 10-decimal bigint arithmetic (`Dec`). No IEEE-754 shortcut.

```
budget = min(
  equity × riskPct / 100,
  maxMonetaryRiskPerTrade,          # if set
  remaining daily-loss budget,
  remaining weekly-loss budget,
  remaining total-open-risk budget,
  remaining instrument-exposure budget,
  remaining direction-exposure budget
)

stop_distance = |entry − stopLoss|          # must be > 0

quote_linear:  value_per_unit = contractSize × stop_distance
base_linear:   value_per_unit = contractSize × stop_distance / entry

raw_qty = budget / value_per_unit           # ROUND_DOWN
qty     = floor(raw_qty onto quantityStep)
monetary_risk = qty × value_per_unit
```

Fail-closed (never a silent default size) when equity ≤ 0, stop
distance ≤ 0, the spec is missing/invalid, qty < min, qty > max, or any
intermediate overflows.

`quote_linear` is for instruments whose quote currency is the account
currency (EURUSD, XAUUSD, BTCUSD, equities). `base_linear` is for
USDJPY-style pairs. Specs are seeded in `instrument_risk_specs`; a
missing spec rejects the trade.

## Reward:risk formula

```
long:  risk = entry − SL     reward = TP − entry
short: risk = SL − entry     reward = entry − TP
rr    = reward / risk
```

Rejects missing SL/TP, wrong-side levels, zero risk distance, invalid
RR, and `rr < effectiveMin`.

`effectiveMin = max(platform minRr, policy minRr, strategy minRr)`.
The client cannot override the floor. **Exactly at the minimum is
approved; anything strictly below is rejected.**

## Loss limits

Computed from `risk_account_states` (server-owned):

- **Daily** — realized P&L since `daily_window_start` (UTC date). At or
  beyond `equity × maxDailyLossPct` ⇒ `DAILY_LOSS_LIMIT`.
- **Weekly** — ISO-week (Monday UTC) window ⇒ `WEEKLY_LOSS_LIMIT`.
- **Consecutive losses** — `consecutive_losses >= max` ⇒
  `CONSECUTIVE_LOSS_LIMIT`.

Windows roll inside the locked transaction. There is no HTTP path to
write P&L; `recordRealizedPl` exists for tests and a future executor.

## Exposure controls

Against open `execution_positions` **plus** in-flight
`risk_reservations`:

- simultaneous positions
- total open risk
- per-instrument open risk
- per-direction open risk

A position without a stop (so open risk is uncomputable) fails closed
(`OPEN_POSITION_RISK_UNCOMPUTABLE`).

## Correlation controls

Optional, configuration-driven groups (`correlation_groups` +
`instrument_correlation_groups`). The engine **never invents**
correlation data.

- If `correlationRequired` and the symbol has no group membership ⇒
  `CORRELATION_METADATA_UNAVAILABLE`.
- If the symbol is in a group, group open risk + candidate risk is
  compared to `max_exposure_pct` (or the policy default).

M8.2 seeds **no** groups. The mechanism is in place for later
configuration.

## Session controls

Optional `allowedSessions`. Named windows (`asia`, `london`,
`new_york`, `sydney`) use the same **UTC** hours as the evaluation
engine. Custom `{ kind: 'utc_hours', startHour, endHour }` windows are
also UTC. A user timezone is never accepted. Outside the window ⇒
`SESSION_NOT_ALLOWED`. `null` = all sessions allowed.

## Kill switch

The engine independently rejects (`KILL_SWITCH_ACTIVE`) when any
applicable M8.1 kill switch is active. The execution gate still checks
kill switches as well. Neither path can be silently bypassed.

## Concurrency

`RiskEngineService.evaluate` takes a transaction-scoped advisory lock
on `(user, execution_profile)` and `SELECT … FOR UPDATE` on the account
row. An approval inserts a `risk_reservations` row so a concurrent twin
sees the reserved exposure. Intake releases the reservation when the
execution gates refuse (which they always do in M8.2).

## Fail-closed behaviour

Unknown, missing or uncomputable inputs reject. There is no default
position size, no assumed correlation, no assumed session, no assumed
spread. A missing risk decision still fails the M8.1 gate.

## Rejection codes

Pinned in `RISK_REJECTION_CODES`. When several checks fail, the public
`rejectionCode` is the first in that list; `violations` (audit only)
lists every code.

## Audit trail

Every evaluation writes:

- an append-only `risk_decisions` row (outcome, code, reason, metrics,
  policy version, engine version, setup/strategy/profile ids);
- a platform `audit_events` row (`risk.approved` / `risk.rejected`).

Never logged: passwords, API keys, broker credentials, tokens, or raw
account secrets. Structured `[risk]` log lines carry ids, outcome, code
and policy version only.

## API / UI

| Route | Purpose |
|---|---|
| `GET /api/risk/policy` | Owner-scoped policy + **platform ceilings** + paper snapshot |
| `PATCH /api/risk/policy` | Bounded update; out-of-envelope values are 400s |
| `GET /api/risk/decisions` | Owner-scoped decision history |

There is **no** endpoint that accepts a client risk approval or places
an order.

The Trading page shows a risk panel that labels **User Risk Setting**
separately from **Platform Safety Limit**. No live-trading button, no
broker credential form, no order ticket.

## Environment variables

M8.2 introduces **none**.

## Current limitations

- No real, demo or paper orders are executed.
- Automation remains OFF for every plan.
- Paper provider is not ready (simulator is M8.3).
- Correlation groups are a mechanism only — none are seeded.
- Paper equity is a simulation parameter, not a broker balance.
- Spread/slippage are enforced only when the policy configures a
  maximum (missing input then fails closed).
