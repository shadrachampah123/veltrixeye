# Automated Trading Execution Architecture (M8.1)

M8.1 builds the **execution architecture and safety boundary only**. It is a
foundation milestone:

- **NO broker, MT5 or Exness connectivity exists anywhere in this repository.**
- **NO order can reach a broker, demo account or external venue.** M8.3 adds
  the internal **paper simulator** (see below): it creates *simulated* orders
  and positions only, priced from the platform's own candle store. The single
  registered provider is still the platform's own `paper` adapter, and broker
  operations (`cancel`, `modify`, `getOrder`, `closePosition`) still throw a
  normalized `unavailable` error.
- **Live execution is impossible by construction**: the service layer refuses
  it, and migration `0016` carries `CHECK (environment <> 'live')`.
- **No credentials are modeled**: execution profiles store a provider slug and
  a non-secret reference only. Broker passwords/keys have no column, no route
  and no planned home in the database — future provider credentials belong in
  environment/secret management, server-side.
- **Automation stays OFF for every plan**: `canAccessAutomation` is false on
  all entitlement tiers, the user switch defaults to `false`, and the only
  mutation path requires the entitlement first — so neither API requests nor
  raw database state can switch automation on in M8.1.

## Position in the pipeline

The execution layer sits strictly AFTER the existing strategy/risk pipeline
and never bypasses it:

```
Market Data → Strategy Detection → Setup Qualification → Signal/Quality
Validation → Risk Engine → Execution Decision → Execution Provider
→ Order → Position → Reconciliation
```

In M8.1 the chain is proven through **Execution Decision**. M8.2 fills the
**Risk Engine** step: intake always calls the server-side risk engine and
feeds the persisted verdict into the gates. A client-provided approval
boolean is ignored. **Risk approval is still not permission to execute** —
automation stays OFF and the paper provider reports not-ready, so no intake
can be accepted. Full risk-engine design: [risk.md](./risk.md).

## Domain model

| Concept | Table(s) | Notes |
|---|---|---|
| Execution profile | `execution_profiles` | user-owned; `paper` only in M8.1; provider slug + non-secret `account_ref`; `enabled` flag |
| Execution request | `execution_requests` | idempotent decision intake; frozen decision snapshot; `requested`/`rejected` |
| Order | `execution_orders` | full lifecycle schema; M8.1 creates none |
| Position | `execution_positions` | reconciliation-ready (`provider_position_id` unique per profile) |
| Execution audit | `execution_events` | append-only trail (trigger-guarded) |
| Kill switch | `kill_switches` | global/user/strategy/profile scopes |
| Automation switch | `users.automation_enabled` | default `false`, entitlement-gated mutation |

## Order state machine

```
requested → validating → submitted → accepted → partially_filled → filled
    ↘ rejected/failed/cancelled            ↘ rejected/cancelled/expired/failed
```

- Terminal states (`filled`, `rejected`, `cancelled`, `expired`, `failed`) are
  absorbing; `assertOrderTransition` throws on anything illegal
  (`packages/core/src/execution/order-machine.ts`).
- Same-state repeats are caller no-ops, **except**
  `partially_filled → partially_filled` (progressive fills).
- M8.1 defines and tests the machine; a future executor (M8.2+) is the only
  component that may drive transitions, and it must call
  `assertOrderTransition` before persisting one.

## Idempotency

Execution identity is **derived, never random**:

```
identity = user + setup + execution profile + action
idempotency_key = sha256(identity)          -- UNIQUE
UNIQUE (setup_id, execution_profile_id, action)
client_order_id = "ve-" + sha256(identity)[0..24)  -- UNIQUE, future orders
```

The setup already encodes strategy/version/instrument/direction/anchor, so
the identity is complete. Retries, HTTP replays and concurrent twins collapse
onto the first row (`ON CONFLICT`-safe insert + re-read), returning it with
`replayed: true` — a duplicate order is impossible at the database level.
Covered by sequential-replay and 8-way concurrent tests.

## Safety gates

Every future execution must pass ALL 15 gates, evaluated in pinned order,
fail-closed (`packages/core/src/execution/gates.ts`):

1. `authenticated` — valid session
2. `authorized` — caller owns setup + profile (DB-proven)
3. `entitlement` — subscription includes automation
4. `automation_on` — entitlement AND explicit user switch
5. `profile_enabled` — profile exists, enabled, environment `paper` (M8.1)
6. `kill_switch` — no active global/user/strategy/profile switch
7. `valid_signal` — eligible setup state, matching direction, quality ≥ min
8. `risk_decision` — approved by the M8.2 risk engine (must be a
   **server-issued** decision with `decisionId` + `engineVersion`; a client
   `{ approved: true }` fails closed)
9. `valid_symbol` — platform market universe membership
10. `valid_order_params` — positive prices, valid anchor (sizing lands in M8.2)
11. `valid_stop_loss` — SL protects the entry per direction
12. `valid_take_profit` — TP rewards the entry per direction
13. `acceptable_rr` — expected RR ≥ version minimum and achievable from levels
14. `exposure_limits` — exposure verdict from the M8.2 risk engine
15. `provider_healthy` — provider reports healthy (**paper reports not ready**)

Unknown inputs fail closed: a missing decision, a missing or
non-server-issued risk decision, unevaluated exposure or unknown provider
health all refuse execution. M8.2 produces a real risk decision; execution
still cannot proceed because later gates (entitlement, automation, provider
health) refuse.

## Kill switch

`kill_switches` rows (one per scope+target, upserted):

- `global` — platform-wide emergency stop
- `user` — per-account stop
- `strategy` — per-strategy disable
- `execution_profile` — per-profile disable

An active switch anywhere in scope makes gate 6 fail: **no new execution may
be accepted**. M8.1 ships the contract, the read helpers, the setter (used by
operators/tests) and status surfacing in `/api/execution/automation`; no UI.

## Provider abstraction

`ExecutionProvider` (contracts) — provider-neutral operations: `submitOrder`,
`cancelOrder`, `modifyOrder`, `getOrder`, `listOrders`, `listPositions`,
`closePosition`, plus `health()` and a credential-free `describe()`.
Capabilities declare supported modes and order types, so core logic never
assumes a feature exists.

All failures normalize into `ExecutionProviderError` with one of:
`authentication`, `validation`, `insufficient_funds`, `market_closed`,
`rate_limited`, `timeout`, `unavailable`, `rejected`, `unknown`. Raw provider
payloads never propagate; secrets never exist to leak.

**Registered providers in M8.1: `paper` only.** Its boundary is in place for
the M8.3 simulator; today every trading operation throws
`ExecutionProviderError('unavailable')`.

## Paper execution simulator (M8.3)

M8.3 fills the **Execution Provider → Order → Position → SL/TP → P&L →
Reconciliation** part of the chain **internally**. It is a deterministic
simulator, not a broker integration:

- **Inputs are server-issued only.** A simulation request carries identifiers
  (`setupId`, `executionProfileId`, optional `riskDecisionId`) and nothing
  else. The server rebuilds the decision from the owned setup, calls the M8.2
  risk engine, and only then can an order exist. A client `{ approved: true }`,
  price, quantity or P&L field is a 400.
- **Market data is the platform's own.** `CandleStoreMarketPriceSource` reads
  the same `candles` table the scanner uses. Prices must exist, be positive
  and be fresh (per-instrument `STALE_THRESHOLDS_MS`); stale, future,
  missing or non-positive prices refuse the simulation. There is no second
  market-data provider and no external quote.
- **Deterministic fills.** Market orders fill at the reference price with
  adverse slippage; stops fill at the stop with adverse slippage; take
  profits fill at the level; explicit closes fill at the current reference
  price. All arithmetic is the M8.2 `Dec` (bigint, 10 dp) — never a float.
- **State machine + ledger.** `execution_orders`/`execution_positions` are
  transitioned through the M8.1 states; fills are appended to
  `execution_fills` (exactly-once per `(order_id, sequence)`, unique
  idempotency key, append-only trigger). Repeated submissions replay the
  existing result instead of creating a duplicate.
- **SL/TP from candles.** `detectExit` walks the candles after entry in
  chronological order. A candle that touches both levels resolves to the
  **stop** (conservative) and records a `paper_sl_tp_conflict` event.
- **Reconciliation foundation (M8.5).** Each fill/close writes an
  `execution_reconciliations` record comparing expected vs stored state.
  Inconsistencies are *reported* and the write fails closed — nothing is
  silently corrected.
- **P&L is simulated.** Realized/unrealized P&L, fees and slippage are
  simulated values. Paper results are **not** broker fills and are not a
  guarantee of future performance.

Paper endpoints (session-authenticated, owner-scoped):

| Route | Purpose |
|---|---|
| `GET /api/execution/paper/status` | simulator readiness + simulated P&L summary |
| `POST /api/execution/paper/simulate` | simulate the server's decision for one owned setup |
| `GET /api/execution/paper/orders` \| `/positions` \| `/fills` | owner-scoped read models |
| `POST /api/execution/paper/positions/:id/close` | close a simulated position at the server price |
| `POST /api/execution/paper/evaluate` | apply SL/TP to open simulated positions |
| `GET /api/execution/paper/reconciliations` | reconciliation trail |
| `POST /api/execution/paper/reconcile` | read-only consistency sweep |

## API surface (M8.1)

| Route | Purpose |
|---|---|
| `GET /api/execution/automation` | server-authoritative automation state + reasons |
| `POST /api/execution/automation` | entitlement-gated switch (403 for every plan in M8.1) |
| `GET /api/execution/status` | readiness snapshot: automation, provider health, profile count |
| `GET /api/execution/profiles` | owner-scoped profiles |
| `POST /api/execution/profiles` | create a **paper** profile (demo/live refused, provider validated) |
| `GET /api/execution/orders` | owner-scoped orders (empty until a provider can trade) |
| `GET /api/execution/positions` | owner-scoped positions (empty) |
| `GET /api/execution/events` | owner-scoped execution audit trail |

**Deliberately absent**: order submission/modification/cancellation to a
broker, direct provider invocation, client-authored execution decisions,
broker credentials, demo-account connection and MT5/Exness configuration.
The paper routes above are the only order-creating surface, and they are
simulations. Decisions are only ever produced server-side by the
strategy → risk pipeline (M8.2+).

## Audit trail

Every intake outcome writes BOTH:

- an append-only `execution_events` row (`execution_requested` /
  `execution_rejected`, gate, reason, evaluated gate list), and
- a platform `audit_events` row (`execution.requested` /
  `execution.rejected`, with ip/user-agent).

Future executor events follow the same vocabulary the schema already carries:
`order_submitted`, `order_accepted`, `order_partially_filled`, `order_filled`,
`order_cancelled`, `order_failed`, `position_opened`, `position_modified`,
`position_closed`. No event ever contains credentials.

## Observability

Structured `[execution]` log lines (ids, gates, statuses, actions) cover
request/reject outcomes; provider responses are categorized before logging.
Nothing logs passwords, keys, tokens or credentials — the paper adapter has
none, and the architecture forbids storing them.

## Environment

**M8.1 introduces no new environment variables.** Future provider credentials
(M8.3+ paper tuning, later demo/broker bridges) will follow the existing
policy: server-side environment/secret management, validated at boot, never
persisted, never logged.

## Testing

- contracts (`execution.test.ts`): decision schema, directional SL/TP rules,
  RR achievability, strictness, pinned gate/status/taxonomy constants, stable
  idempotency identity, error normalization.
- core (`execution.test.ts`): state machine (valid/invalid/terminal), DB
  constraints (live impossible, unique intents, order CHECKs), all 15 gates
  fail-closed, profile/automation/kill-switch services, intake validation,
  ownership masking, entitlement refusal, sequential + concurrent idempotency,
  owner-scoped read models, append-only trail, paper boundary, failure
  taxonomy through the registry.
- api (`execution.test.ts`): authentication on every route, automation
  immutability (including direct-DB flip insufficiency), paper-only profiles,
  unknown-provider refusal, credential-field rejection, cross-user isolation,
  and proof that no order-placement surface exists (all candidate submission
  endpoints 404).
- M8.3 paper execution (`packages/core/test/paper-execution.test.ts` and
  `apps/api/test/paper-execution.test.ts`): pure fill/P&L/exit arithmetic and
  gate ordering, valid long/short simulations, SL/TP exits, fees/slippage,
  risk-decision forgery/citation/invalid-engine-version refusal, kill-switch
  and automation-OFF blocking, idempotent replay and duplicate-fill no-ops,
  stale/missing market data, deterministic fill/order/close failure paths,
  reconciliation mismatch detection (never an auto-correction), tenant
  isolation, the append-only fill ledger and the migration CHECKs, plus an
  API-level assertion that no paper response carries credential material or
  a broker order id.

## Boundaries (what M8.1/M8.2/M8.3 are NOT)

Not implemented, by design — later M8 milestones: **broker/demo connectivity
and MT5/Exness integration (M8.4)**, **live reconciliation jobs against a
broker (M8.5)**, trailing stops, break-even, automated trade placement
(permanently OFF in this milestone set), and any UI beyond the readiness page,
the M8.2 risk-settings panel and the M8.3 paper-execution panel. The M8.3
simulator is internal and deterministic: it never contacts a broker, never
stores a credential and cannot place a live order. The risk engine, position
sizing, loss limits, correlated-exposure controls and session restrictions
shipped in M8.2 ([risk.md](./risk.md)) remain mandatory and still do not
authorise real execution.
