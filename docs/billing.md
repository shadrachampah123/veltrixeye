# Billing (in progress)

> **Step 7 (this change) establishes durable payment evidence** (`billing_verified_transactions`, migration `0033`), and a sandbox transaction-verification + reconciliation boundary (`POST /api/billing/verify`). **Transaction verification through the documented `GET /transaction/verify/:reference` read is the confirmation authority for evidence.** `charge.success` remains a receipt/event signal and does not itself activate payment. **Exact amount/currency reconciliation is required** against the immutable pricing snapshot. **Payment evidence does NOT activate entitlements in Step 7.** The verification records evidence only — it changes no subscription plan, no provider lifecycle state, no automation and no execution. **Subscription lifecycle remains `unknown` for Paystack transaction verification** (the verified transaction status is never promoted to a subscription state). **Live Paystack remains prohibited** — sandbox/test only (`domain: test`, `sk_test_` keys). Production `GET /api/health/ready` is 32/32, but **production FX/provider-plan provisioning is NOT verified** — the previous audit established that production provisioning is not verified, and this change publishes no FX rate, registers no provider-plan epoch, creates no Paystack plan and provisions no production data.
>
> **Current billing surface:** four session-authenticated billing routes exist —
> `GET /api/billing/me` (read-only state), `POST /api/billing/checkout`
> (PR-C: sandbox checkout initialization against a registered epoch and an
> operator-published FX rate; it writes a pending provider-backed row and an
> immutable pricing lock, and it never *confirms* a payment), `POST /api/billing/customer` (Billing Step 6: sandbox customer provisioning, idempotent) and the new `POST /api/billing/verify` (Step 7: sandbox transaction verification + reconciliation + durable evidence, empty body, per-IP rate-limited to 10/min) — plus the Step 5.2 **secure webhook receiver** `POST /api/billing/webhook`
> (signature-verified, rate-limited, source-IP allow-listed; it records ONE
> `billing_provider_events` row per verified delivery and nothing else) —
> and the Later-billing-PR #7 **verification + synchronization** route
> `POST /api/billing/sync` (session-authenticated, no request body; it
> verifies the caller's own checkout reference through the documented
> transaction-verify read and applies the result only through
> `SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE` — see *Verification +
> synchronization (Later-billing-PR #7)* below). The verify response publishes
> no subscription status, so every Paystack-verified state is `unknown`
> (manual review): no status moves and nothing is granted via sync.
> **Step 7 `POST /api/billing/verify` likewise confirms NOTHING to entitlements:** it records one `billing_verified_transactions` row per verified checkout reference after exact reconciliation, and returns a structured `BillingPaymentVerificationResult` (`verified: true` with evidence, or `verified: false` with a typed failure reason). `paymentConfirmed` on `GET /api/billing/me` stays `false`, `grantsExecution` stays `false`, and `resolveEntitlements` stays provider→FREE.
> There is still no checkout UI and no `apps/web` billing change, no billing
> portal, no refund/proration/dunning execution, no notification, no live
> payment, no production credential, no production activation and no Starter
> selling.
> **Receipt is still not confirmation**: the webhook receiver records deliveries; `POST /api/billing/sync` applies the canonical status mapping without confirming payment; `POST /api/billing/verify` records verified-transaction evidence after reconciliation — none of them changes subscription plan or grants execution.
>
> **Account capabilities are only partially verified.** Whether this account
> can transact in **GHS** (AC1) or run **GHS recurring** subscriptions (AC2) is
> unverified, and no recurring end-to-end run has happened (AC7). The account's
> **GHS test-plan capability** has since been verified from operator-reported
> Dashboard evidence (a GHS 2.00 monthly test plan — capability evidence only,
> never an epoch), but none of the four production-shaped Pro/Elite ×
> monthly/annual sandbox plans exist yet, so AC5 is not fully cleared and no
> plan has been registered locally. See
> [paystack-provider-contract.md](./paystack-provider-contract.md) §7 and §7.1.
>
> **Pricing-lock lifecycle (Model C — "checkout-created commercial
> subscription"):** registration no longer creates a `subscriptions` row. A user
> with no row IS the free state (`free` / `active` / `paymentConfirmed: false`,
> free entitlements, no automation); the first commercial checkout is the ONE
> path that derives the active provider-plan epoch and its pinned FX price and
> writes the sold subscription together with its immutable pricing lock,
> atomically, still arbitrated by `UNIQUE (user_id)`. The lock stays a pricing
> fact: not payment confirmation, not entitlement activation, not execution
> authorization. Pre-existing rows with a NULL lock remain fail-closed
> (`pricing_lock_required`) with no remediation path in this change, and the
> activation/confirmation authority remains a separate, unimplemented step.
> See *The pricing-lock lifecycle — Model C*.
>
> PR1 (merged, `ab27948`) established the authoritative commercial catalogue;
> PR2 (merged) added the canonical billing contracts, the provider seam and
> migration `0031_provider_billing.sql`; PR3 (merged) added USD→GHS pricing, FX authority, provider-plan epochs and the sandbox Paystack adapter. **Step 7 adds payment evidence only — it changes no price, no entitlement and no execution: `canAccessAutomation` stays `false` for every plan, `paymentConfirmed` stays `false`, and `grantsExecution`/`planChanged`/`entitlementsChanged` stay `false`.**

## Decisions (operator-confirmed)

| Decision | Value |
| --- | --- |
| Payment provider | **Paystack** |
| Currency | **USD** (single commercial currency) |
| Development credentials | **Sandbox / test keys only** — never committed, never in source control |
| Production credentials | Not present; a later billing PR |
| Render plan | **Free** — unchanged by billing work |
| Billing webhook / signature security | Later billing PRs (not PR2) |
| Migration 0031 | **Created in PR2** — `0031_provider_billing.sql`; migrations 0001–0030 stay byte-identical (now pinned by SHA-256 in the PR3 suite too) |
| Payment currency | **GHS.** The customer pays the GHS equivalent of the USD catalogue price; the catalogue stays USD |
| FX authority | **Server-controlled and versioned** (`billing_fx_rate_versions`). Never browser-supplied, never a market feed, never Paystack |
| FX freshness | **≤ 15 minutes** at pricing time (`pr3-usd-ghs-v1` policy). Older ⇒ refuse to start a new payment |
| Rounding | **One half-up step**, integer/BigInt only, on the final conversion. No floats anywhere in the billing path |
| Recurring GHS amount | **Locked at subscription creation** (`subscriptions.locked_pricing_snapshot_id`, immutable by trigger). A rate or catalogue change never reprices an existing subscriber |
| Refunds | Use the amount **actually charged**. A refund never re-rates |
| Disclosure | USD price (prominent) + exact GHS amount + rate, version and time. GHS is shown before payment |
| Migration 0032 | **Created in PR3** — `0032_billing_fx_and_pricing.sql`; migrations 0001–0031 are byte-identical |
| Migration 0033 | **Created in Step 7** — `0033_billing_payment_evidence.sql`; migrations 0001–0032 stay byte-identical — append-only `billing_verified_transactions` (durable payment evidence, Paystack sandbox only, integer minor units GHS exponent 2, unique provider ref + idempotency key, `evidence_hash`, no card/secrets, preserve redaction) |
| Paystack API integration | **Sandbox seam only, five of eight operations** (`findCustomer`, `createCustomer`, `initializeCheckout`, `verifySubscription` (`GET /transaction/verify/:reference`) — provider calls — plus `normalizeEvent`, a pure local normalization of delivered events). `POST /api/billing/checkout` initializes sandbox checkouts through `initializeCheckout` (PR-C); the Step 5.2 receiver (`POST /api/billing/webhook`) verifies deliveries and records them in `billing_provider_events` — it confirms nothing; **Step 7 `POST /api/billing/verify` verifies the caller's own checkout reference through `verifySubscription` and reconciles it against the immutable pricing snapshot before recording durable evidence in `billing_verified_transactions` — it likewise confirms no payment to entitlements**. No live key, `implemented` stays `false` for `findSubscription`/`synchronizeSubscription`/`cancelSubscription` |
| Provider plan mutation | **Never.** `PUT /plan` is never called; a price change is a NEW epoch + a NEW provider plan, and the previous epoch is retired locally |
| Entitlements / execution | **Unchanged.** `canAccessAutomation` stays `false` for every plan |

## Pricing decisions (D-1 … D-9)

The pricing rules the billing path obeys, numbered so that other documents,
migrations and code comments can cite one rule instead of restating it. Each
entry names a **refusal** as often as it names a computation.

| # | Decision |
| --- | --- |
| **D-1** | A subscription's price is **locked at creation** and is never recomputed from a later FX version, a later catalogue change or a later provider-plan change |
| **D-2** | Pricing uses **exactly one half-up rounding step**, in integer/BigInt arithmetic. No float, and no second rounding anywhere in the path |
| **D-3** | A **new** price may only use an FX version captured no more than **15 minutes** before the pricing instant (`BILLING_FX_POLICY.maxAgeSeconds = 900`). Older ⇒ refuse. A stale rate is never priced from |
| **D-4** | A **pending** checkout keeps the amount already quoted to the customer. FX freshness does not reprice it |
| **D-5** | The **USD catalogue is the only source of catalogue prices**. No price literal is restated in the pricing path and none is derived at runtime |
| **D-6** | A **refund never re-rates** the original purchase; it uses the amount actually charged |
| **D-7** | Local pricing and idempotency decisions are **deterministic** — the same inputs collapse onto the same snapshot row and the same `idempotency_key` |
| **D-8** | Locked-subscription verification **never re-rates**. An FX version ageing out does not change a locked amount |
| **D-9** | **Provider-plan epoch pricing** — an epoch freezes its GHS amount at registration. See below |

**D-3 is a freshness rule for pricing *instants* only**: creating a new one-off
price, or registering a new provider-plan epoch. It is not a rule that keeps
re-validating an amount a customer has already been shown (D-4), an amount a
provider plan is already registered at (D-9), or an amount already locked to a
subscription (D-1, D-8).

### D-9 — Provider-plan epoch pricing

A Paystack provider-plan epoch (`billing_provider_plans`) **freezes its GHS
amount when the epoch is registered**:

- The amount is fixed **at registration**, from an FX version that is **fresh at
  registration time** — no more than 900 seconds old (D-3).
- `amount = half_up(catalogue USD minor amount × epoch FX rate)` — one half-up
  step, integer arithmetic (D-2, D-5).
- The epoch amount is **immutable after registration**. The schema refuses the
  edit, and nothing in the billing path recomputes it.
- **A later FX version does not invalidate or reprice an existing active
  epoch.** A new rate is a reason to *consider* a new epoch, never a reason to
  change an old one.
- **Plan-bound checkout derives its pricing snapshot from the active
  provider-plan epoch** — the epoch's amount, the epoch's FX version and the
  epoch's FX facts.
- **The epoch's FX facts are the disclosed FX facts** for that plan-bound
  checkout: the rate, version and time the epoch was registered at — not a live
  rate.
- A **new provider plan plus a new epoch** is required only when an operator
  **deliberately** changes the price: retire the epoch (`active → retired`,
  one-way) and register a new one bound to a new provider plan.
- **Existing locked subscriptions are never repriced** (D-1, D-8) — not by a
  later FX version, not by a new epoch, and not by retiring the epoch they were
  sold under.

**The governing recurring-plan invariant:**

> The GHS amount a Paystack plan charges is fixed at the moment the epoch is
> registered, equals `half_up(catalogueUsdMinor × epochRate)` computed under a
> then-fresh FX version, and is thereafter the only amount that may be quoted,
> initialized, locked or verified for that epoch. It changes only by retiring
> the epoch and registering a new one bound to a new provider plan; it is never
> recomputed from a later FX version.

#### Implementation boundary — what D-9 does not ship yet

- The **epoch-derived pricing entry point is `priceFromProviderPlanEpoch`**
  (`packages/core/src/billing/pricing.ts`). D-9 is the decision; that function
  is the implementation: it derives a plan-bound snapshot from an active epoch
  without re-rating it.
- Plan-bound checkout **fails closed** rather than silently repricing an old
  epoch: no active epoch ⇒ `plan_not_registered`; an
  epoch that does not authorize the requested amount exactly ⇒ `plan_mismatch`
  (`assertProviderPlanMatches`). A refusal is the intended behaviour here, not a
  gap to be worked around.
- The **15-minute freshness rule applies to NEW one-off pricing and to NEW
  provider-plan epoch registration** — never to an already-registered epoch at
  checkout time. An epoch whose FX version is now hours old is still valid; what
  is invalid is *deriving a new amount* from it.
- The existing **GHS 2.00 test plan `PLN_u0l4961hhipl6ek` is capability evidence
  only and must NEVER be registered as a `billing_provider_plans` epoch**
  ([paystack-provider-contract.md](./paystack-provider-contract.md) §7.1). Its
  amount is not FX-derived, no FX version exists to pin it to, and its
  single-invoice shape contradicts a recurring epoch.

## Authoritative commercial catalogue

The catalogue is defined exactly once, deeply frozen and validated at module
load:

- `packages/contracts/src/billing-catalogue.ts` — the single catalogue object,
  its Zod schemas and the compatibility mapping to the internal plan values.
- `packages/core/src/billing/catalogue.ts` — the **server-side authority**: it
  validates the catalogue when the module is imported (a malformed catalogue is
  a boot failure, never a silent fallback) and exposes the server accessors.

| Plan | Monthly (USD) | Annual (USD) | Active strategies | Markets | Trade frequency |
| --- | --- | --- | --- | --- | --- |
| **Starter** | $15 | $150 | 1 | 1 market category | Delayed / limited |
| **Pro** | $39 | $390 | 5 | Forex + crypto + stocks | Real-time |
| **Elite** | $99 | $990 | Unlimited | Forex + crypto + stocks | Real-time + priority execution |

Notes:

- Prices are **operator-defined** and stored as integer minor units (USD cents)
  alongside a display string. They are not derived or recalculated anywhere.
- Annual pricing is exactly as defined above (each annual amount equals ten
  monthly amounts). It is not reinterpreted by code.
- "Active strategies", "markets" and "trade frequency" are **commercial
  descriptors** of what each tier is sold as. They are not the enforced
  entitlement numbers (see below).

The old placeholder plan table in the web UI (a hand-written `Free $0 /
Starter $29 / Pro $99` list with invented limits) is **gone**: the plan
comparison now renders from this catalogue, so there is one source of truth.

## Three layers, deliberately separate

1. **Commercial catalogue** — what is *sold*: Starter/Pro/Elite, USD prices,
   and the advertised active-strategy / market / trade-frequency descriptors.
   Display and pricing only; it grants nothing.
2. **Entitlement enforcement** — what the server *enforces today*:
   `packages/core/src/billing/entitlements.ts` (`getEntitlements`) plus the
   atomic limit checks in the routes. **Unchanged by PR1 and by PR2.** Limits
   are still resolved from the internal plan value and subscription status.
3. **Future execution capabilities** — automation, live execution and broker
   execution. **Still OFF for every plan.** They are gated by
   `canAccessAutomation` (currently `false` for all plans), the execution
   gate stack and Gate 9 — none of which the catalogue touches.

### "Priority execution" (Elite) is not an execution capability

Elite's *Real-time + priority execution* row is a **commercial entitlement
definition only**. It does **not**:

- enable live execution or broker execution;
- wire B1 composition or the B2 submit boundary;
- bypass Gate 9 (or any other execution gate);
- change `canAccessAutomation`;
- add MT5/Exness support, broker credentials, or an order-placement route.

This is enforced by the type system as well as by documentation: every entry
carries `capabilityGrants` typed as
`{ liveExecution: false; brokerExecution: false; automation: false }` and
`tradeFrequency.grantsExecution: false`, so the catalogue cannot express a
capability grant.

## Compatibility boundary — commercial catalogue ⇄ stored plan values

The database stores **internal** plan values `free` / `pro` / `premium`
(CHECK-constrained in migration `0001` `users.plan` and migration `0014`
`subscriptions.plan`). The commercial catalogue is `starter` / `pro` /
`elite`. PR1 renamed nothing and migrated no user, and **PR2 does not either**:
migration 0031 leaves both CHECKs exactly as they are and adds the commercial
vocabulary in a separate column instead.

The two vocabularies coexist through an explicit, documented mapping that is
**display/commercial only** — entitlement enforcement never consults it. Since
PR2 the mapping is also enforced by the database
(`subscriptions_catalogue_plan_mapping_check`):

| Internal value (stored) | Commercial plan | Mapped today? |
| --- | --- | --- |
| `free` | — (default, not sold) | n/a — `catalogue_plan` must be `NULL` |
| `pro` | **Pro** ($39 / $390) | ✅ 1:1, same name |
| `premium` | **Elite** ($99 / $990) | ✅ highest internal tier |
| — | **Starter** ($15 / $150) | ❌ no internal value yet → needs a **later** migration + an entitlement decision |

Consequences:

- An existing `pro` user keeps exactly the limits they have today; we simply
  also call their tier "Pro" commercially.
- An existing `premium` user keeps exactly the limits they have today; they are
  shown the **Elite** catalogue row (same `canAccessAutomation: false`, same
  numbers — the name changes, the enforcement does not).
- A `free` user keeps the free entitlement set; free is not a sold tier and has
  no catalogue row. Since Model C a free user typically has **no
  `subscriptions` row at all** (`UserService.create` provisions none), and the
  missing row is what resolves to free — see *The pricing-lock lifecycle —
  Model C*.
- **Starter still cannot be sold.** Migration 0031 persists the *catalogue*
  identity of a provider-backed subscription, but it deliberately does **not**
  add an internal plan value for Starter: doing so would create a plan whose
  entitlements are undefined (it would fall through `getEntitlements()` to the
  free set) and would therefore be an entitlement change, which is outside
  PR2's scope. `unmappedCommercialPlans()` still returns `['starter']`, and the
  database enforces the same fact (see below).

If a later change would require altering the stored enum or migrating existing
users, that is the point to stop and widen scope deliberately — it was not part
of PR1 and it is not part of PR2.

## Billing persistence model (PR2 — migration `0031_provider_billing.sql`)

Migration 0031 is the next migration after 0030, is **additive and
forward-only**, and changes no historical migration (0001–0030 are
byte-identical; the suite `packages/core/test/billing-pr2-migrations.test.ts`
pins recorded SHA-256 checksums for 0001, 0014 and 0030). It contains no
`UPDATE`, no `INSERT`, no `DELETE`, no `DROP`, no `RENAME` and no redefinition
of an object created earlier — every existing row survives untouched.

It persists provider-backed billing state in **three places**, none of which is
a second entitlement system:

### 1. `subscriptions` — the one authoritative row, extended

`subscriptions` (0014) stays the single subscription row per user
(`UNIQUE (user_id)`) and the **only** source entitlements are resolved from:
`getEntitlements(plan, status)`. 0031 adds columns; it renames nothing, drops
no constraint and does not weaken the 0014 `plan`/`status` CHECKs.

| Group | Columns (all new) | Purpose |
| --- | --- | --- |
| Commercial identity | `catalogue_plan`, `billing_interval`, `currency`, `catalogue_version` | Which catalogue plan/interval a subscription was sold as. `currency` is pinned to `USD`; `catalogue_version` records `BILLING_CATALOGUE_VERSION`. **No price is stored** — the catalogue stays the only price source. |
| Provider identity | `billing_customer_id` → `billing_customers`, `provider_plan_id`, `provider_subscription_code`, `provider_reference`, `provider_state` | Reference identifiers only. `provider_state` is the **canonical** provider-reported lifecycle (`unprovisioned`, `pending`, `active`, `trialing`, `past_due`, `cancelled`, `unsubscribed`, `expired`, `unknown`) — a provider-specific status word is normalized behind the seam before it can be stored. |
| Period / cancellation | `cancel_at`, `cancelled_at`, `cancellation_reason` (with 0014's `current_period_start/end`, `cancel_at_period_end`) | Period coherence (`start < end`) and cancellation coherence are CHECK-enforced. |
| Synchronization | `sync_state`, `last_sync_source`, `last_synced_at`, `sync_required`, `last_event_idempotency_key`, `state_version` | Bookkeeping, written since Later-billing-PR #7 by `BillingSubscriptionSyncService` only. Defaults are inert (`never_synced` / `none` / `false` / `1`); `state_version` cannot decrease (trigger), so a stale writer loses. |

Invariants the database enforces:

- `plan` remains exactly `free | pro | premium` — **no value was added,
  renamed or removed**, on `users.plan` (0001) or `subscriptions.plan` (0014).
- `catalogue_plan` is bound to the canonical compatibility mapping
  (`pro` → `pro`, `premium` → `elite`, `free` → none) by
  `subscriptions_catalogue_plan_mapping_check`. `catalogue_plan = 'starter'`
  is therefore **rejected for every internal plan value**: the database encodes
  the same fact as `unmappedCommercialPlans()`.
- `billing_interval` requires a `catalogue_plan`; provider columns require a
  `provider`; `provider` is pinned to `paystack`.
- A provider subscription identifier belongs to exactly one row
  (`UNIQUE (provider, provider_subscription_id)` and the same for
  `provider_subscription_code`). A pre-flight refuses the migration outright —
  without modifying data — if existing rows would violate it.

### 2. `billing_customers` — provider customer identity

One row per `(provider, user)`, holding the provider's customer id/code, the
normalized lowercase account email, a lifecycle status
(`unprovisioned | provisioned | suspended | unavailable`) and `provisioned_at`.
A provisioned customer must carry a provider identifier, and neither
`provider_customer_id` nor `provider_customer_code` can be shared by two users.
Reference identifiers only: no credential, card or bank detail is storable.
Deleting a customer clears `subscriptions.billing_customer_id`
(`ON DELETE SET NULL`) instead of cascading away the authoritative row.

### 3. `billing_provider_events` — append-only idempotency ledger

The durable record a provider event needs so a replayed or duplicated delivery
collapses onto one row:

- `idempotency_key` — `sha256(provider | provider_event_id | event_type |
  occurred_at | payload_hash)`, **UNIQUE**;
- `(provider, provider_event_id)` — **UNIQUE** where present;
- `event_type` — the **canonical** vocabulary only
  (`customer.*`, `payment.*`, `subscription.*`, `invoice.*`, `unrecognized`);
  a provider-specific name such as `charge.success` is rejected, so
  normalization must happen behind the seam;
- `payload_hash` — sha256 of the received payload. **The payload itself is
  never stored** (same redaction posture as the Gate 9 receipt ledger, 0029),
  and credential-shaped text is rejected in `failure_reason`;
- `(subscription_id, user_id)` — a composite FK to `subscriptions (id,
  user_id)`, so an event can never be bound to another user's subscription
  (the 0025 tenant-integrity pattern); both are set or both are `NULL`;
- identity columns are immutable (trigger) and an **unprocessed event cannot be
  deleted** (trigger) — a crash or a cleanup job cannot erase evidence of an
  unapplied provider event.

In PR2 nothing read or wrote these tables. Since **Step 5.2**,
`billing_provider_events` rows are appended by exactly ONE writer — the secure
webhook receiver (`POST /api/billing/webhook`), which appends `received` rows
and never processes them onwards. Since **Later-billing-PR #7**, the ONLY
processing transitions (`received → processed | ignored | failed`) and the
ONLY writes of the subscription synchronization columns come from
`BillingSubscriptionSyncService` (`POST /api/billing/sync`); no worker or
scheduler applies events. `billing_customers` still has no route-wired
writer. `subscriptions_sync_required_idx` exists so a later scheduled
synchronization does not need another migration — PR #7 needed none.

## Pricing in GHS (PR3 — migration `0032_billing_fx_and_pricing.sql`)

The catalogue is USD and stays USD. What a customer **pays** is the GHS
equivalent of the USD price, computed on the server from an FX version an
operator published. Four pieces make that safe.

### 1. The FX authority — `billing_fx_rate_versions`

Append-only and immutable: one row per published rate version, expressed as an
exact scaled integer (`rate = fx_rate_scaled / 10^fx_rate_scale`; 12.5 GHS/USD is
`12500000 @ 6`). There is no float column anywhere in the pricing path.

- `UNIQUE (base, quote, effective_from)` — one rate per pair per instant. Two
  versions effective at the same moment are a **contradiction**, not a choice:
  the resolver refuses to guess.
- `captured_at <= effective_from` — a version can never be **back-dated**, so a
  past payment can never be repriced by a later insertion.
- A published version is **never edited and never deleted** (trigger, SQLSTATE
  `27000`). A correction is a new version with a later `effective_from`.
- Provenance is canonical (`db | ops | import | config`) and credential-shaped
  labels are refused outright.

`packages/core/src/billing/fx-rate-versions.ts` resolves the newest version
effective at or before the requested instant, refuses a version older than
`BILLING_FX_POLICY.maxAgeSeconds` (900 s), refuses an ambiguous set, and never
touches the network. The clock is injected.

### 2. The pricing boundary — `pricing.ts`

One implementation, integer-only:

```
payable = (2·usdMinor·rateScaled + 10^scale) / (2·10^scale)     // half-up, one step
```

- The USD amount comes from the **catalogue** (`cataloguePriceMinor`) and from
  nowhere else: no price literal is restated in the pricing module, and a source
  assertion proves it.
- An unsellable plan (Starter) and a below-minimum amount (documented GHS
  minimum ₵0.10 = 10 pesewas) are refused — never rounded up into a charge.
- A stale, future-dated, foreign or malformed FX snapshot refuses to price.
- `verifyPricingSnapshot()` validates an **existing** snapshot **without**
  re-rating it: ageing a rate never invalidates an amount a customer already
  authorized (D-1/D-4/D-8), and a provider-reported amount that differs from the
  authorized one — in either direction — is an incident.
- `pricingIdempotencyKey()` derives a deterministic 64-hex local key, so the
  same decision always collapses onto the same row (`UNIQUE idempotency_key`).

### 3. Provider-plan epochs — `billing_provider_plans`

An epoch maps a commercial (plan, interval) to the exact GHS plan a provider
charges in, pinned to the FX version and pricing/catalogue versions it came from.

- ONE **active** epoch per (provider, mode, plan, interval, currency) — a second
  active epoch is a database conflict, never "newest wins".
- Sandbox only (`mode = 'test'`), GHS only, **Pro/Elite only** (Starter is not
  sellable), amount ≥ ₵0.10.
- Everything that defines *what is charged* is **immutable**; the only permitted
  change is `active → retired`, it is one-way, and epochs are never deleted.
- `assertProviderPlanMatches` (core) compares an epoch against an authorized
  snapshot on provider, mode, plan, interval, currency + exponent, exact amount,
  provider plan identifier, FX version, pricing policy and active status — and
  the Paystack adapter calls exactly that function, so there is one
  implementation of the rule.
- **The amount an epoch freezes at registration — and why a later FX version
  never changes it — is D-9.** An epoch's FX facts are the FX facts disclosed on
  a plan-bound checkout, and plan-bound checkout derives its snapshot from the
  active epoch rather than re-rating it. See *Pricing decisions (D-1 … D-9)*.

### 4. The lock — `subscriptions.locked_pricing_snapshot_id`

`billing_pricing_snapshots` records ONE pricing decision (USD amount, GHS
amount, FX facts, rounding mode, policy/catalogue versions, local idempotency
key) and is append-only: it is evidence of what was quoted and charged. A
snapshot's FX facts must be **exactly** those of the version it references
(BEFORE INSERT trigger), and it can never be updated or deleted.

A sold, provider-backed subscription carries that snapshot in
`subscriptions.locked_pricing_snapshot_id`, written **at creation** and
**immutable afterwards** — not to a newer snapshot, not to another amount, not
to `NULL`. The database refuses a late lock too: the price is written when the
subscription is created, or the subscription has no price.

`subscriptions.currency` and `CHECK (currency = 'USD')` are untouched: the
**commercial** currency stays USD, and the lock's scope guard only *reads* it.

### 5. The pricing-lock lifecycle — Model C ("checkout-created commercial subscription")

**The subscription row is a commercial artefact, so it is created by the
commercial event — the first checkout — and by nothing else.**

```text
registration (UserService.create)     → user row + session/audit only. NO subscriptions row.
user with no subscriptions row        → free fallback: plan 'free', status 'active',
                                        paymentConfirmed false, FREE entitlements,
                                        canAccessAutomation false, no provider
first commercial checkout             → active provider-plan epoch + pinned FX price
                                        → pricing snapshot + sold subscription + immutable
                                          pricing lock, atomically, under UNIQUE (user_id)
existing NULL-lock row                → pricing_lock_required (fail closed, unchanged)
```

| Rule | Where it lives |
| --- | --- |
| Registration creates the user exactly as before — same single INSERT, same transaction, same unique-email conflict mapping, same `users.plan` default — and **no billing state** (no `subscriptions` row, no `billing_customers` row, no pricing snapshot, no provider call) | `packages/core/src/auth/users.ts`. There is no billing, FX or provider import in that module |
| A **missing** `subscriptions` row IS the supported free state: `plan: 'free'`, `status: 'active'`, `paymentConfirmed: false`, `FREE_ENTITLEMENTS`, `canAccessAutomation: false`, `providerStatus = { provider: null, providerState: null, paymentConfirmed: false }`, and `subscription.id = ''` (nothing was ever sold, so there is no commercial identity to report) | `getBillingState` (`packages/core/src/billing/subscriptions.ts`) and every entitlement reader — `resolveEntitlements('free', 'active', null)`. No row is invented to represent free access |
| The **only** commercial creation path is the first `BillingCheckoutService.checkout()` for a row-less user: it derives the active provider-plan epoch, pins the epoch's FX version/amount into a pricing snapshot, INSERTs the sold subscription with `provider = 'paystack'`, `provider_state = 'pending'` and `locked_pricing_snapshot_id = <snapshot>`, and commits — one transaction | `packages/core/src/billing/checkout.ts` (`obtainLock`, `ON CONFLICT (user_id) DO NOTHING`). Pricing authority stays in `pricing.ts`/`provider-plans.ts`; nothing is recomputed here |
| **Concurrency arbitration is the database's**, not the service's: `UNIQUE (user_id)` (`subscriptions_user_id_idx`, 0014) decides which racing first checkout creates the row; the loser re-reads the committed winner and uses ITS lock. `FOR UPDATE` cannot lock an absent row, so the INSERT is the arbiter | as before — unchanged by Model C |
| The **client supplies the catalogue plan and interval only**. It cannot supply a snapshot, an amount, an FX rate, a provider plan id, a user id or a callback/return authority: the request body is `.strict()` on `{ cataloguePlan ∈ {pro, elite}, interval ∈ {monthly, annual} }`, and the provider call is built entirely from the locked snapshot | `billingCheckoutInputSchema` + `billingCheckoutRequestSchema` |
| **The pricing lock is a pricing/quote fact — and nothing else.** It is written when the commercial subscription is created, and it is **not** payment confirmation, **not** entitlement activation and **not** execution authorization: the checkout response buys nothing, `paymentConfirmed` stays `false`, and the provider-backed row resolves to `FREE_ENTITLEMENTS` | migration 0032 + `resolveEntitlements` |
| **The lock is immutable.** Migration 0032's `subscriptions_locked_pricing_immutable` trigger refuses repointing, re-rating AND clearing: `NULL` → non-NULL can never be written after creation. A price change applies to NEW subscriptions only | migration 0032 (**unchanged by Model C; 0001–0033 are byte-identical**) |

**Why registration used to create a free row, and why it no longer does.** The
0014-era free row had `provider IS NULL` and `locked_pricing_snapshot_id` did
not exist yet (it arrives additively in 0032), so the row could not carry a
price. Once 0032 made the lock immutable at creation, an eager
`free`/`active` row could never become a commercial one — the only thing it
could do is make the first checkout fail closed with `pricing_lock_required`.
Model C removes the premature row instead of weakening the invariant: the
free state is represented by the ABSENCE of a commercial record, which is also
what "nothing has been sold yet" means.

**Legacy NULL-lock rows remain fail closed — deliberately.** Any subscription
row that already exists with `locked_pricing_snapshot_id IS NULL` (created by
the previous registration behaviour, by the 0014 backfill, or by an operator)
continues to be refused at checkout with `pricing_lock_required`, and the
0032 trigger refuses to attach a lock to it later. This milestone adds **no
remediation path, no migration, no backfill and no repair job** for those rows;
they are handled by operators out of band. Do not "fix" one by editing the
trigger.

**Adjacent steps stay separate and unimplemented here.**

- **Step 4 operator provisioning remains a prerequisite:** no provider-plan
  epoch and no FX version are published by this change, so a row-less checkout
  still fails closed with `plan_not_registered` until an operator runs the
  Step 4 runbook (dashboard plans + FX publication + one registration call).
  Provisioning registers pricing authority for future sales; it never repairs
  an existing row.
- **The activation/confirmation authority (Step 8 of the pricing-lock
  milestone — not this change) is NOT implemented.** Payment confirmation,
  payment evidence, entitlement
  activation, webhooks, synchronization and execution are separate concerns
  that this change does not touch, and the pricing lock grants none of them.
  Nothing in Model C may be used as a substitute for that authority.
- **Known follow-up (not fixed here):** an active epoch can be *retired*
  between the active-epoch lookup and the pricing-lock creation, because the
  epoch read is not taken under `FOR SHARE` and no active re-check is performed
  inside the lock transaction. The outcome is fail-closed rather than unsafe —
  the lock is created from what was active at lookup time, and the Paystack
  adapter independently refuses a retired/mismatched epoch, so no charge is
  initialized — but it is a race worth fixing deliberately in its own change.
  No scope expansion was made for it here.

### 6. The sandbox adapter and its composition

`packages/providers/paystack` implements three documented provider operations
(`findCustomer`, `createCustomer`, `initializeCheckout`) against
`https://api.paystack.co`, accepts **`sk_test_` keys only**, performs exactly one
HTTP attempt (no retry, no idempotency header — Paystack documents neither for
outbound calls), prices nothing and converts nothing. It also implements
`normalizeEvent` (Step 5.1) as a **pure** function over the four event payloads
Paystack publishes — no transport, no clock, no database. Since Step 5.2 the
**receiver that delivers to it exists outside the adapter**
(`apps/api/src/billing-webhook.ts` + `packages/core/src/billing/webhook.ts`),
so the package itself remains receiver-free by a pinned test. Everything else
rejects with `PaystackNotImplementedError`, and `implemented` stays **`false`**.

`apps/api/src/billing-composition.ts` registers the adapter **only** when a
sandbox key is configured; with no key the registry stays empty, so a caller
that reaches for billing gets a loud failure rather than a half-configured
provider. Registration depends on stable prerequisites only — a rate ageing out
after 15 minutes must not unregister the provider; data-dependent decisions are
made per call and fail closed there.

Details, including the exact documented facts and the two documented 404s, are
in [paystack-provider-contract.md](./paystack-provider-contract.md).

### What PR3 deliberately leaves undone

| Item | Why |
| --- | --- |
| Provisioning Pro/Elite sandbox plans | **AC5** partially verified — GHS test-plan **capability** is confirmed (contract §7.1), and the Step 4 provisioning **workflow** now exists (`provisioning.ts`), but the four production-shaped plan IDs do not exist yet, so nothing may be sold. The GHS 2.00 test plan is capability evidence only and is never registered |
| GHS recurring end-to-end | **AC7** unverified |
| Checkout UI | Out of scope — the checkout **route** now exists (PR-C: `POST /api/billing/checkout`, reaching `initializeCheckout` for sandbox sessions only); no web surface drives it |
| ~~Webhook receiver + signature processing~~ | **Delivered by Step 5.2** (`POST /api/billing/webhook`): `x-paystack-signature` verification (HMAC-SHA512 over the RAW body, constant-time), a documented source-IP allow-list, per-IP rate limiting, local subject resolution, and exactly one `billing_provider_events` row per verified delivery (replays collapse; refused deliveries are kept as `unrecognized` evidence). **Receipt only** — no confirmation, no synchronization, no entitlement effect (step 6b below) |
| ~~Subscription read/verify/sync~~ | **Delivered by Later-billing-PR #7** (`POST /api/billing/sync`): verification through the documented `GET /transaction/verify/:reference` read, synchronization through `SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE`. There is still **no subscription read** (`findSubscription` refused), and because the verify response publishes no subscription status every Paystack-verified state is `unknown` → manual review — no status moves, nothing is granted |
| Cancellation | The documented disable operation needs the subscription code **and** its `email_token`, which this build does not persist |
| Refunds, proration, dunning | Out of scope |

## Provider seam (PR2 — boundary only)

| Layer | File | Role |
| --- | --- | --- |
| Canonical contracts | `packages/contracts/src/billing-provider.ts` | Zod-validated, `.strict()`, provider-neutral representations: provider identity, customer identity, plan/interval identity, subscription state, provider-reported subscription state, provider event identity, normalized billing events, synchronization results. |
| Server-side seam | `packages/core/src/billing/provider.ts` | The `BillingProvider` interface, the seam's request/result schemas, an empty `BillingProviderRegistry`, a fail-closed placeholder, and pure hashing helpers. |
| Catalogue authority | `packages/core/src/billing/catalogue.ts` (PR1, unchanged) | The only source of plans, prices and limits. The seam resolves plan identity and amounts **through** it. |
| Entitlement enforcement | `packages/core/src/billing/entitlements.ts` (unchanged) | Resolves limits from the internal `plan` + `status`. It neither imports nor consults the seam or the catalogue. |

The seam declares exactly the operations a later Paystack PR must implement —
`findCustomer`, `createCustomer`, `initializeCheckout`, `findSubscription`,
`verifySubscription`, `synchronizeSubscription`, `cancelSubscription`,
`normalizeEvent` — and **implements none of them**:

- `createBillingProviderRegistry()` starts **empty**; nothing anywhere
  registers a Paystack provider.
- `createUnimplementedBillingProvider()` is the fail-closed placeholder: every
  operation rejects with `BillingProviderNotImplementedError` (`code:
  'billing_provider_not_implemented'`), so a caller that reaches for the seam
  today gets a loud, honest error instead of a silent no-op or an accidental
  network call.
- `provider.ts` imports `node:crypto`, `zod`, `@veltrixeye/contracts` and
  `./catalogue.js` — nothing else. It contains no HTTP client, no endpoint, no
  credential handling and no `process.env` read, and it restates no price
  (asserted by `packages/core/test/billing-provider.test.ts`).
- `live` is pinned to `false` by the type **and** guarded at registration:
  billing is not an execution transport and can never be wired as one.

Provider-specific detail stays behind the boundary. A future Paystack adapter
normalizes what the provider says into these contracts; because every schema is
`.strict()`, a provider-shaped extra field is a validation failure rather than
a pass-through.

### One path from provider state to authoritative status

`SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE` (contracts) is the only mapping from a
canonical provider state onto the authoritative 0014 status vocabulary:

| Provider state | `subscriptions.status` | Note |
| --- | --- | --- |
| `active` | `active` | |
| `trialing` | `trialing` | |
| `past_due` | `past_due` | still entitled today, per `getEntitlements` |
| `cancelled`, `unsubscribed` | `canceled` | 0014 spells it `canceled` |
| `expired` | `expired` | |
| `unprovisioned`, `pending`, `unknown` | `null` — **no change** | never applied silently; flagged for manual review |

`null` means "this provider state does not authorize a status change": the
authoritative status stays exactly as it is and the sync result must carry
`requiresManualReview: true`. An ambiguous or unmodelled provider state can
therefore never widen an entitlement — the fail-safe direction. The
synchronization result additionally pins `planChanged`, `entitlementsChanged`
and `grantsExecution` to `false` at the type level: synchronization moves
status, period and cancellation state, never the plan value and never an
execution capability.

## Read-side entitlement hardening — provider-backed rows fail closed

Checkout initialization (`BillingCheckoutService`, `POST /api/billing/checkout`)
INSERTs the subscription row **before any money moves**. Since Model C this is
the FIRST commercial checkout of a user with no subscription row (registration
no longer creates one — see *The pricing-lock lifecycle — Model C*):

```sql
INSERT INTO subscriptions (…, status, provider, provider_state, locked_pricing_snapshot_id)
VALUES (…, 'active', 'paystack', 'pending', <snapshot>)
```

`status = 'active'` is the authoritative 0014 lifecycle value and `plan` is the
internal value the requested commercial plan maps onto (`pro` / `premium`). Read
through `getEntitlements(plan, status)` alone, that row therefore looked exactly
like a paid subscription — while nothing had been charged. This build has **no
payment-confirmation authority**: the Step 5.2 webhook receiver *records*
deliveries (with `x-paystack-signature` verification), but recording is not
confirming — there is no transaction verification and nothing that applies a
recorded event to an entitlement (see the list below). An initialized checkout
is not a payment, and no `provider_state` value can make it one.

### The rule

| Subscription row | Entitlements |
| --- | --- |
| **no row at all** (every user who has never checked out — the Model C free state) | `FREE_ENTITLEMENTS` via `resolveEntitlements('free', 'active', null)` — reported as free/active/unconfirmed |
| `provider IS NULL` (every historical row) | `getEntitlements(plan, status)` — **unchanged** |
| `provider IS NOT NULL` (any checkout row) | `FREE_ENTITLEMENTS` — regardless of `status` or `provider_state` |

### The implementation

- **`packages/core/src/billing/entitlement-resolution.ts`** — one function,
  `resolveEntitlements(plan, status, provider)`. It is the only place the
  `provider` column may influence an entitlement, and it can only ever narrow
  one. `provider` is a required third argument compared with `!== null`, so a
  reader that forgets to SELECT the column resolves to free, never to paid.
- **`packages/core/src/billing/entitlements.ts`** — unchanged and still
  provider-agnostic. It only gained `export` on the existing
  `FREE_ENTITLEMENTS`, so the resolver returns *that* object instead of
  restating a second matrix. `getEntitlements(plan, status)` keeps its exact
  signature.
- **Every production entitlement reader** now selects `provider` and calls the
  resolver: `getBillingState`, `StrategyService.createStrategy`,
  `SetupService.insertOrGetSetup`, `AlertService.generateAlert`,
  `BacktestService.createBacktest`, `ScannerService.getEligibleStrategies`, the
  three scanner route gates (`health` / `runs` / `trigger`) and
  `AutomationService.readState`.
- **`GET /api/billing/me`** additionally publishes `providerStatus`:
  `{ provider, providerState, paymentConfirmed }`. The first two are the stored
  columns as **display information**; `paymentConfirmed` is pinned to
  `z.literal(false)` the same way the sync result pins `grantsExecution`, so a
  confirmed payment is unrepresentable in this build. The subscription's
  authoritative `plan` and `status` are still reported exactly as stored — the
  response does not lie about the row, it stops implying that the row is paid.
- **`apps/web` `SubscriptionPanel`** renders that state: a provider-backed row
  is badged with its provider state plus "unconfirmed" and carries an explicit
  "Payment not confirmed" notice. No button, link, portal or checkout surface
  was added.

### What this deliberately does not do

No migration (the schema already carries everything needed), no Paystack
change, no confirmation, no pricing or pricing-lock change, no change to the
checkout INSERT shape, no change to `PUBLIC_APPLICATION_ORIGIN` or any
production configuration, no change to `users.plan`, and no change to any
execution safety gate. (The Step 5.2 webhook receiver, which landed later,
only *records* deliveries — it never applies one.) `canAccessAutomation`
remains `false` for every plan, every status and every provider.

Removing the gate is the job of the confirmation authority in step 6/7 below —
not of a display layer, and not of a provider state.

## What is still NOT implemented (PR2 scope, updated through PR-C and Step 4)

Explicitly absent — each is a later PR, and none of them may enable execution.
PR3 added the **sandbox** Paystack client (three documented operations, test
keys only, one attempt per call) and migration 0032's pricing state; PR-C wired
sandbox checkout initialization; Step 4 added the plan-provisioning workflow;
Step 5.1 added the verified webhook event contract and normalizer; **Step 5.2
added the secure webhook receiver** (`POST /api/billing/webhook`: signature
verification, source-IP allow-list, rate limiting, subject resolution and the
ledger write — receipt only) — while everything below remains true at the
**product** level:

- **No payment *confirmation* authority and no checkout UI**: `POST
  /api/billing/checkout` now initializes sandbox checkouts (PR-C), and the
  Step 5.2 receiver now **records** provider deliveries — but recording is
  not confirming: no transaction verification, no sync — so a provider-backed
  subscription stays execution-inert (`paymentConfirmed` is pinned `false`;
  the hardening sweep pins the same), and there is no UI, no redirect
  handling beyond the callback configuration. `billing_customers` now has
  exactly one writer — the Billing Step 6 customer provisioning flow
  (`POST /api/billing/customer`, see below) — which records provider customer
  identity only and grants nothing.
- **No billing portal** and no customer self-serve surface.
- **No webhook-driven state change.** The receiver writes
  `billing_provider_events` rows (`received`) and never touches
  `subscriptions`, entitlements or any execution gate. A recorded
  `payment.succeeded` row is a provider-reported receipt awaiting a
  synchronization step, not an applied payment.
- **Synchronization is on-demand and verified only** (Later-billing-PR #7) —
  no worker, scheduler or background queue. The caller's own
  `POST /api/billing/sync` is the only trigger; it settles that
  subscription's `received` ledger rows and writes the PR2 bookkeeping
  columns. `billing_provider_events` rows are appended ONLY by the Step 5.2
  receiver;
  `billing_fx_rate_versions` / `billing_provider_plans` /
  `billing_pricing_snapshots` are written through core modules only (FX
  publication and Step 4 epoch registration are operator-driven local actions,
  checkout snapshot/lock writes ride the checkout request) — never by a
  client, a market feed or the provider.
- **Epoch-derived pricing now has one caller — and four unprovisioned plans.**
  `priceFromProviderPlanEpoch` (`packages/core/src/billing/pricing.ts`) derives
  a plan-bound pricing snapshot from an active `billing_provider_plans` epoch
  (D-9), and `BillingCheckoutService` calls exactly that entry point per
  checkout; the Step 4 provisioning workflow
  (`packages/core/src/billing/provisioning.ts`) validates and registers those
  epochs, but **no epoch has been registered yet** — the four sandbox plans and
  the authoritative FX version remain operator inputs — so the route fails
  closed (`plan_not_registered`) until they exist. A plan-bound checkout
  **fails closed** (`plan_not_registered` / `plan_mismatch`) rather than
  silently repricing an old epoch, and the 15-minute freshness rule (D-3) is a
  rule about *new* pricing instants (registration and rate publication), not
  about an epoch already registered.
- **No billing UI and no pricing UI change** (`apps/web` is untouched; the plan
  comparison still renders the PR1 catalogue).
- **No notification change** (M9.1/M9.2 untouched).
- **No production credential, no live key, no `render.yaml` or Vercel change.**
  Two sandbox-only environment variables exist (`PAYSTACK_SECRET_KEY`,
  `PAYSTACK_TIMEOUT_MS`); a live key is refused at boot.
- **No execution change**: B1, B2, Gate 9, the M10 transport, paper execution,
  MT5/Exness and broker integration are untouched; no new execution permission
  exists; `canAccessAutomation` remains `false` for `free`, `pro` and
  `premium`; Elite's "priority execution" remains a commercial descriptor only.
- **No new internal plan value.** Starter is still not sellable (see above).

### Prerequisite discovered, deliberately not started

Making **Starter** sellable needs three changes that are all outside PR2's
scope: an internal plan value in the 0001/0014 CHECKs, an entitlement
definition for it in `entitlements.ts` (an entitlement change), and a widening
of `subscriptions_catalogue_plan_mapping_check`. PR2 stops at the boundary and
records the gap instead of expanding into entitlement work.

## Operational notes

- **Render stays on the Free plan.** Billing work does not change the Render
  Blueprint (`render.yaml`), instance type or service topology. Free-instance
  caveats (spin-down, per-instance rate limits) are unchanged — see
  [deployment.md](./deployment.md).
- **Secrets:** Paystack keys are environment configuration only. Development
  uses **sandbox/test keys**; no key value is ever committed. `.env.example`
  documents local development values; production secrets are set in the
  platform (Render/Vercel) and never in Git. See
  [environment.md](./environment.md) and [security.md](./security.md).
- **No provider-backed billing row has ever been written in production.**
  Migration 0014 added `subscriptions.provider`, `provider_customer_id` and
  `provider_subscription_id`; migration 0031 added the rest of the
  provider-backed model (interval, catalogue identity, canonical provider state,
  cancellation and synchronization bookkeeping) plus `billing_customers` and
  `billing_provider_events`; migration 0032 adds the FX/plan/snapshot state and
  the immutable subscription price lock. Every one of those columns is `NULL` or
  at its inert default on every existing row: the provider-backed subscription
  the checkout route writes is provider-unconfirmed by construction
  (`paymentConfirmed` is not a column an operator can set), and no plan
  has been provisioned (AC5 capability verified, four plan IDs pending — the
  Step 4 runbook below).
- **FX publishing is an operator action, not a feature.** `billing_fx_rate_versions`
  is append-only and written through `BillingFxRateVersionStore.publish()` —
  called out-of-band by an operator (the Step 4 runbook includes the call), by
  direct operator approval only; PR3 shipped the authority, the resolution
  rules and the tests, not a rate feed and not an admin endpoint.

## Later billing PRs

Roughly in order; each is its own PR and may be re-scoped.

1. ~~**Migration 0031**~~ — **delivered by PR2**
   (`0031_provider_billing.sql`).
2. ~~**Paystack adapter**~~ — **partially delivered by PR3**: the sandbox
   adapter implements the three documented operations it can (customer create /
   fetch, transaction initialize), normalizes delivered events locally
   (Step 5.1) and fails closed on the rest. The customer
   provisioning flow (persisting `billing_customers`) still lands with a later PR
   because it needs a route/worker, and every remaining operation needs either a
   verified read operation or the out-of-scope webhook/sync work.
3. ~~**USD→GHS pricing + FX authority**~~ — **delivered by PR3** (migration
   `0032`, `fx-rate-versions.ts`, `pricing.ts`, `provider-plans.ts`).
4. **Plan provisioning** — Pro/Elite × monthly/annual sandbox plans, registered
   as local epochs. **Partially delivered by Step 4 (this PR):** the local
   provisioning workflow now exists —
   `packages/core/src/billing/provisioning.ts` validates the whole four-plan
   batch against the operator-selected FX version and registers the four
   immutable epochs atomically, completely outside the adapter. **GHS plan
   capability is verified** (contract §7.1), so the only thing between here and
   a provisioned state is the separately-authorized operator run below
   (dashboard plan creation + FX publication + one registration call). Its
   prerequisites, **all** of them before any of the four plans is created:
   - **(a) An authoritative FX version must exist first** — a published
     `billing_fx_rate_versions` row. Every plan amount is derived from the
     catalogue USD price through that version: no FX version, no plan amount
     (D-3, D-9).
   - **(b) One FX version for all four plans.** The four production-shaped plans
     must use amounts derived from the **same** FX version used for epoch
     registration, so the four epoch amounts are mutually consistent and every
     epoch pins the **same FX version ID**.
   - **(c) The four plans are exactly:** **Pro Monthly**, **Pro Annual**,
     **Elite Monthly**, **Elite Annual** — **GHS**, **test mode**, intervals
     `monthly` / `annually`.
   - **(d) No invoice / payment-count cap** on the production-shaped plans. The
     GHS 2.00 evidence plan is `max payments = 1`; a recurring epoch is
     open-ended, and a capped plan cannot be registered as one.
   - **(e) Each registered epoch references that same FX version ID and the
     plan's real `PLN_` code** — the code Paystack actually issued, never a
     placeholder and never the throwaway plan's.
   - **(f) A provisioning path that keeps `PUT`/`POST /plan` out of
     `packages/providers/paystack`.** The adapter **must not** gain `/plan`
     mutation capability (the source assertion forbids plan mutation there);
     provisioning happens outside the adapter, and the adapter only ever reads
     against a locally registered epoch. **Delivered now** (Step 4 module;
     source-pinned).
   - **(g) The throwaway GHS 2.00 plan remains excluded** — capability evidence
     only, **never** registered as an epoch. The Step 4 workflow refuses it
     (`excluded_provider_plan`), independently of checkout's own refusal.

   The separately-authorized operator run is documented as a runbook in
   *Sandbox plan provisioning (Step 4)* below.
5. ~~**Checkout / payment initialization route**~~ — **delivered by PR-C**:
   `POST /api/billing/checkout` (server-side initialization behind
   `initializeCheckout`, session-authenticated, epoch- and lock-bound). The
   checkout **UI** and AC1/AC2/AC5/AC7 remain open.
6. **Webhook events** — split in two, because the provider-contract half could
   be built on published evidence while the network half cannot be built safely
   without it:
   - **(a) Verified event contract + normalizer — DELIVERED (Step 5.1).**
     `packages/providers/paystack/src/events.ts` pins the supported vocabulary
     (`charge.success`, `subscription.create`, `invoice.update`,
     `invoice.payment_failed`), the canonical mapping, the documented
     occurrence instants, the status→lifecycle-state table and the
     failure-detail sanitizer; `normalizeEvent` implements the seam operation as
     a **pure** function (no transport, no clock, no directory, no database, no
     mutation). Repository-pinned delivery fixtures with per-field provenance
     live in `packages/providers/paystack/test/fixtures/webhook/`. Events whose
     payload shapes Paystack does **not** publish (`subscription.disable`,
     `subscription.not_renew`, `subscription.enable`, `charge.failed`), and
     `invoice.create` and `subscription.expiring_cards` (verified payloads with
     no faithful canonical mapping), are recorded as **unsupported** and
     normalize to `unrecognized` rather than being guessed. See
     [paystack-provider-contract.md](./paystack-provider-contract.md) §2.1.
     **Receipt is still not confirmation, and normalization still grants
     nothing.**
   - **(b) Webhook receiver + security — DELIVERED (Step 5.2).**
     `POST /api/billing/webhook` (registered ONLY when a sandbox key is
     configured — with no key the endpoint does not exist). In request order:
     per-IP rate limit (`PAYSTACK_WEBHOOK_RATE_LIMIT_MAX`, default 30/min);
     the documented provider source-IP allow-list
     (`PAYSTACK_WEBHOOK_ALLOWED_IPS`, defaulting to the three addresses the
     provider documents, `/0` refused); raw-body capture scoped to the route;
     `x-paystack-signature` verification (HMAC-SHA512 of the **raw** body
     keyed by the sandbox secret key, constant-time compare) BEFORE any
     parsing; seam normalization (Step 5.1); local subject resolution against
     `billing_customers` / `subscriptions` / the checkout-reference
     derivation — a disagreement binds NOTHING; and exactly one
     `billing_provider_events` row per delivery, replays collapsing via the
     0031 UNIQUE `idempotency_key`. A verified delivery the receiver must
     refuse (unparseable body, or a payload the seam refuses) is kept as an
     `unrecognized` row with a sanitized `failure_reason` and answered 400,
     so the provider's documented retry schedule surfaces it. **What it still
     is not:** not a payment confirmation, not a transaction verification,
     not a synchronization — `subscriptions` is never written, no entitlement
     changes, `paymentConfirmed` stays unrepresentable, and nothing here can
     grant execution. Payloads are never stored or logged (hash only). The
     receiver lives in `apps/api/src/billing-webhook.ts` (transport) and
     `packages/core/src/billing/webhook.ts` (security pipeline + ledger); the
     Step 5.1 package test still pins `packages/providers/paystack` free of
     any receiver.
7. ~~**Verification + subscription synchronization**~~ — **delivered by
   Later-billing-PR #7 (sandbox only)**; see *Verification + synchronization
   (Later-billing-PR #7)* below. Verification uses the documented
   transaction-verify read; there is still no subscription read, and the
   verify response publishes no subscription status, so every
   Paystack-verified state is `unknown` → manual review. Applying a real
   subscription lifecycle state still requires a documented source for one.
8. **Customer provisioning flow and billing portal** — persisting
   `billing_customers` and a self-serve portal.
   - **8a. Customer provisioning — delivered by Billing Step 6 (sandbox
     only)**; see *Customer provisioning (Billing Step 6)* below.
   - 8b. Billing portal — not started.
9. **Web UI** — checkout and portal surfaces in `apps/web`.
10. **Starter entitlement decision** — internal plan value, limits, and the
    mapping widening described above.
11. **Refunds / proration / dunning execution** — each its own PR, each using
    the amount actually charged (never a re-rate).
12. **Production credentials + go-live** only after all of the above, and only
    on the existing Render Free deployment unless the plan decision changes.

None of these steps may enable execution. Automation, live execution and broker
execution stay OFF regardless of billing state.

## Customer provisioning (Billing Step 6)

**Status: delivered, sandbox only. It grants nothing.** No migration: it writes
the existing 0031 `billing_customers` table.

| Layer | File | Role |
| --- | --- | --- |
| Contract | `packages/contracts/src/billing-customer.ts` | `BillingCustomerProvisioningResult`: outcome (`created` / `linked` / `already_provisioned`), `status: 'provisioned'`, email, `provisionedAt`, `checkoutReady: true`; `entitlementsChanged` and `grantsExecution` pinned `z.literal(false)`. No provider identifier, row id or user id is returned. |
| Service | `packages/core/src/billing/customers.ts` | `BillingCustomerService.ensureCustomer(userId)`: reads the account email from `users`; an existing `provisioned` row with a code is returned with no provider call; `suspended` / `unavailable`, a code-less `provisioned` row or a placeholder whose email disagrees are refused (operator review); otherwise `findCustomer` → (only if none) `createCustomer` through the seam, strict identity validation (same user, same email, `provisioned`, carries a customer code, no key-shaped identifier), then ONE conditional `INSERT … ON CONFLICT (provider, user_id) DO UPDATE … WHERE status = 'unprovisioned'`. In-process single-flight per user; the 0031 unique indexes arbitrate across instances (first writer wins, the loser returns the winner). Every refusal writes nothing. |
| Composition | `apps/api/src/billing-composition.ts` | `composeBillingCustomers(db, registry)`. The row it writes is what checkout's existing `requireExistingCustomer` reads. |
| Route | `apps/api/src/routes/billing.ts` | `POST /api/billing/customer` — session-authenticated, no body (the subject and email are always the session user's), per-IP limit `BILLING_CUSTOMER_RATE_LIMIT_MAX = 10`/min. Refusals: `409 conflict` for local-state reasons (`customer_not_provisionable`, `customer_identity_incomplete`, `customer_identity_conflict`, `account_unavailable`), `502 provider_unavailable` otherwise (`provider_not_registered`, `provider_unavailable`, `provider_response_unusable`). |

What it deliberately does not do: it never touches `subscriptions`, `users`,
entitlements, pricing, the webhook ledger or any execution gate; the
provider→FREE gate and `paymentConfirmed` are unchanged; there is no billing
portal, no checkout UI and no email-change synchronization.

## Payment evidence + transaction reconciliation (Billing Step 7)

**Status: delivered, sandbox (Paystack) only. It records evidence, it grants nothing.** No entitlements are activated and no execution is granted. `paymentConfirmed` on `GET /api/billing/me` stays `false`, and the verification result pins `grantsExecution` / `planChanged` / `entitlementsChanged` to `false`. The verification is confirmation-authority for evidence only — `charge.success` remains a receipt/event signal and is never treated as a payment activation.

| Layer | File | Role |
| --- | --- | --- |
| Schema | `packages/core/src/db/migrations/0033_billing_payment_evidence.sql` | Append-only `billing_verified_transactions` (durable payment evidence). Paystack sandbox only (`provider = 'paystack'`, `provider_domain = 'test'`, CHECK-pinned), integer minor units GHS/2 (`payment_amount_minor` BIGINT > 0, `payment_amount_exponent = 2`, `payment_currency = 'GHS'`, CHECK-pinned), unique provider reference (`provider_reference` UNIQUE) + deterministic idempotency key (`idempotency_key` UNIQUE — 64-hex SHA-256 of the canonical evidence identity `billing-verified-transaction/v1 | provider | provider_reference | pricing_snapshot_id`, derived server-side, never a client value), `evidence_hash` (64-hex SHA-256 over the canonical verified facts — the raw provider payload is never stored), `provider_transaction_id` (`text`, nullable), `provider_status` (`text`), `paid_at` (`timestamptz`, NOT NULL), `verified_at` (`timestamptz`), `pricing_snapshot_id` FK, `subscription_id` FK, `user_id` FK, `provider_customer_id` / `provider_customer_code` (`text`, nullable), no card/secrets columns, credential-shaped text refused by CHECK, redaction preserved (no PAN/expiry/CVV). Immutable by table design — an append-only trigger refuses UPDATE and DELETE, and a conflicting observation is a hard failure, never an overwrite. Prior migrations 0001–0032 stay byte-identical. |
| Reconciliation | `packages/core/src/billing/payment-reconciliation.ts` | Pure deterministic reconciliation of a verified Paystack transaction against its immutable pricing snapshot: `reconcileBillingPaymentEvidence({ verified, expectedReference, snapshot, localCustomer? })` returns a `BillingPaymentReconciliationOutcome` (`{ ok: true }` or `{ ok: false; reason, message }`) — it does not throw for reconciliation mismatches (a throwing variant, `assertBillingPaymentEvidenceReconciled` → `BillingPaymentReconciliationError`, exists for fail-closed callers). Reuses the strict snapshot validator (`verifyPricingSnapshot`) and the per-currency exponent table (`BILLING_PAYMENT_AMOUNT_EXPONENT`) already used by checkout. Checks, in order: snapshot verifiable and internally coherent (else `invalid_snapshot`); provider reference equals the expected checkout reference (`reference_mismatch`); provider is `paystack` (`provider_mismatch`); domain is `test` (`domain_mismatch`); **provider status is exactly `success` — `failed`, `abandoned` or any other status is never acceptable payment evidence** (`invalid_status`); currency exactly matches the snapshot (`currency_mismatch`); exponent matches the currency table and the snapshot (GHS: 2; `exponent_mismatch`); amount is an integer > 0 minor units and **exactly equals** the locked snapshot's `payment_amount_minor` (`amount_mismatch` — exact equality, no tolerance, no currency conversion, no re-rating); `paid_at` is present and a valid ISO-8601 datetime (missing or malformed ⇒ `missing_paid_at`); the snapshot is not bound to a different checkout reference (`snapshot_mismatch`); and, when the local billing customer is known, the provider customer identity is coherent (disagreeing id/code, or no customer identity on a transaction for a provisioned customer, ⇒ `customer_mismatch`). The complete typed reason set is `reference_mismatch`, `amount_mismatch`, `currency_mismatch`, `exponent_mismatch`, `invalid_status`, `missing_paid_at`, `provider_mismatch`, `domain_mismatch`, `customer_mismatch`, `snapshot_mismatch`, `invalid_snapshot` (`BillingPaymentReconciliationFailureReason`). |
| Verified transactions store | `packages/core/src/billing/verified-transactions.ts` | Durable evidence store. `BillingVerifiedTransactionStore.record({ userId, subscriptionId, pricingSnapshotId, verified, verifiedAt? })` re-checks the paystack/`test`/GHS/exp-2 invariants at the boundary, computes `idempotencyKey = sha256('billing-verified-transaction/v1|' + provider + '|' + providerReference + '|' + pricingSnapshotId)` (`billingVerifiedTransactionIdempotencyKey`) and `evidenceHash = sha256(JSON array ['billing-verified-transaction-evidence/v1', provider, providerReference, providerTransactionId, providerStatus, providerDomain, paymentCurrency, paymentAmountMinor, paymentAmountExponent, providerCustomerId, providerCustomerCode, paidAt, verifiedAt])` (`billingVerifiedTransactionEvidenceHash`), then `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`; a unique violation on `provider_reference` or the idempotency key re-reads the existing row — a replayed observation with the same facts returns the winner's row, and a conflicting observation fails closed with `BillingVerifiedTransactionError` (reason `conflict`, never an overwrite). Readers `findByProviderReference` / `findByIdempotencyKey` / `findById` return `BillingPaymentEvidence | null`; every read re-validates the row against `billingPaymentEvidenceSchema` and re-derives its idempotency key. |
| Transaction verify parser | `packages/providers/paystack/src/provider.ts` (+ `client.ts`) | Extends `verifySubscription` (built on `GET /transaction/verify/:reference`) to capture `paidAt` (the provider's `paid_at` — REQUIRED, a valid ISO-8601 datetime; missing or malformed is a typed `PaystackAdapterError` refusal, never a null downstream) and `providerTransactionId` (`data.id`, normalized to a string, nullable), and publishes `providerTransactionStatus` (`data.status`, verbatim and uninterpreted — the client interprets no status vocabulary). The client strictly validates the documented fields only (including `customer.id` / `customer.customer_code` where present; the `authorization` object is never read), and the seam enforces **sandbox/test domain** (`data.domain !== 'test'` ⇒ `PaystackAdapterError` `response_conflict`) and **reference equality** (else `reference_conflict`), and the reported payment must parse as this build's shape (`GHS`, integer minor amount, exponent 2 via `billingPaymentAmountSchema`). Lifecycle remains `unknown` (`PAYSTACK_VERIFIED_TRANSACTION_LIFECYCLE_STATE`). No `charge.success` promotion, no plan publish. |
| Confirmation service | `packages/core/src/billing/confirmation.ts` | `BillingPaymentConfirmationService` (constructed with `{ db, providers, now? }`) exposes `confirm(userId)` — narrow, evidence-only: (1) auth via the session `userId` the route supplies (the caller's OWN transaction only), (2) locate the user's provider-backed `subscriptions` row and its `locked_pricing_snapshot_id` (missing ⇒ structured `verified: false` / `snapshot_mismatch`, never a throw), (3) derive the deterministic checkout reference server-side from the user + locked-snapshot identity (`billingCheckoutReference(userId, snapshot.idempotencyKey)` ⇒ `ve-chk-` + SHA-256 hex, never client-supplied), (4) verify through the provider seam (`provider.verifySubscription(request)` with a server-built request), (5) build the normalized `BillingVerifiedTransaction` facts from the observed state, (6) reconcile purely against the snapshot (`reconcileBillingPaymentEvidence`), (7) persist idempotently in `billing_verified_transactions` (an idempotent replay returns the existing `BillingPaymentEvidence` row with `replayed: true`; conflicting existing evidence is refused as a typed `BillingPaymentConfirmationError`), (8) return `BillingPaymentVerificationResult` (`verified: true` with `evidence`, or `verified: false` with a typed `failureReason` + fixed credential-free `failureMessage`). **Does NOT activate entitlements/plan/lifecycle/execution** — it writes only the evidence table and returns evidence; `paymentConfirmed`/`grantsExecution`/`planChanged`/`entitlementsChanged` are pinned `false` by contract. Provider-not-registered and verification-unavailable (including conflicting-evidence refusals) are thrown as typed `BillingPaymentConfirmationError` (reason union `provider_not_registered` | `subscription_not_found` | `pricing_snapshot_not_found` | `verification_unavailable`) for the route to map to `502`. |
| Composition | `apps/api/src/billing-composition.ts` | `composeBillingVerify(db, registry): BillingPaymentConfirmationService` — constructs the service with `{ db, providers }` (seam-provided `verifySubscription`, evidence-only, no provider DB access in the adapter). Always composed — no feature flag. |
| Route | `apps/api/src/routes/billing.ts` | `POST /api/billing/verify` — session-authenticated, `requireAuth`, `isEmptyBody` (any payload ⇒ `400 invalidInput`; never client-supplied `reference` or secret), `userId` from session only, per-IP limit `BILLING_VERIFY_RATE_LIMIT_MAX = 10`/min, server-derived reference. Outcome: `200` with `billingPaymentVerificationResultSchema` (`verified: boolean`, `evidence: BillingPaymentEvidence | null`, `failureReason: BillingPaymentReconciliationFailureReason | null`, `failureMessage ≤ 200 chars | null`, `providerReference`, `providerStatus | null`, `replayed`, `verifiedAt`, and `grantsExecution: false`, `planChanged: false`, `entitlementsChanged: false` pinned at the type level). Subscription/snapshot missing or any reconciliation mismatch ⇒ `200 verified:false` with the typed `failureReason` (`snapshot_mismatch`, `reference_mismatch`, …) — never a throw. Provider-not-registered, verification-unavailable and conflicting-evidence refusals ⇒ `502 provider_unavailable` via `isBillingPaymentConfirmationError` → `Errors.providerUnavailable` — this endpoint returns no `409`. |
| Contracts | `packages/contracts/src/billing-provider.ts` (+ `billing-payment-evidence.ts`) | `providerSubscriptionStateSchema` now also carries optional `paidAt: string | null`, `providerTransactionId: string | null` and `providerTransactionStatus: string | null` (verbatim provider transaction status) alongside the canonical lifecycle `state` (which stays `unknown` for Paystack verification). `packages/contracts/src/billing-payment-evidence.ts` (new) defines the canonical Step 7 vocabulary: the typed failure-reason set `BILLING_PAYMENT_RECONCILIATION_FAILURE_REASONS` + `billingPaymentReconciliationFailureReasonSchema` (`BillingPaymentReconciliationFailureReason`); `billingVerifiedTransactionSchema` (normalized provider-reported facts — `provider: 'paystack'`, `providerReference`, `providerTransactionId | null`, `providerStatus`, `providerDomain`, `paymentCurrency`, `paymentAmountMinor`, `paymentAmountExponent`, customer id/code, `paidAt | null`, `verifiedAt`); `billingPaymentEvidenceSchema` (the durable evidence row — `idempotencyKey`/`evidenceHash` as 64-hex SHA-256, `providerDomain: literal('test')`, `paymentCurrency: 'GHS'`, exponent pinned 2, NOT NULL `paidAt`); the pure idempotency derivation `billingPaymentEvidenceIdempotencyCanonicalString`; and `billingPaymentVerificationResultSchema` (`verified`, `evidence`, `failureReason`, `failureMessage`, `providerReference`, `providerStatus`, `replayed`, `verifiedAt`, `grantsExecution/planChanged/entitlementsChanged: literal(false)`) — the existing billing-state DTO keeps `paymentConfirmed: z.literal(false)` and it is never set to `true` by this flow. |

What Step 7 deliberately does not do:

- Never uses `charge.success` as payment confirmation — the webhook event is receipt only; only `GET /transaction/verify/:reference` after strict validation and exact reconciliation counts as evidence authority.
- Never promotes the provider's transaction status to a subscription lifecycle — only `success` is an acceptable evidence status; every other status (`failed`, `abandoned`, `reversed`, …) is a typed `invalid_status` reconciliation failure. The provider still reports `state: unknown` and lifecycle stays `unknown`; no `subscriptions.status` or `provider_state` is written.
- Never writes `subscriptions`, `users`, entitlements, automation gates or execution — the evidence table is the only writer; the provider→FREE gate (`resolveEntitlements`) and `paymentConfirmed` are unchanged.
- Never converts currency, never re-rates and never applies tolerance — amount is integer minor-unit GHS/2 exact equality between the verified `data.amount` and the locked snapshot's `payment_amount_minor` (`payment.paymentAmountMinor`); any mismatch is `amount_mismatch` (`verified:false`).
- Never accepts a client-supplied reference, amount, currency, customer_code or secret — the reference is derived from the locked snapshot and every field is validated server-side against `test` domain / `GHS` / `paystack`.
- Never touches production: no live key, no production credential, no plan mutation (`PUT /plan` is still never called), no FX publication and no `apps/web` change. The four sandbox epochs (when Step 4 is run) remain the only provider plans.

Idempotency + concurrency: `idempotency_key` is the deterministic SHA-256 hex of the canonical evidence identity — `sha256('billing-verified-transaction/v1|paystack|<providerReference>|<pricingSnapshotId>')`, derived server-side from fields no client can supply — and `evidence_hash` is the SHA-256 of the canonical verified facts. Together they make verification idempotent per (reference, snapshot): a second `POST /api/billing/verify` for the same verified observation returns the same `evidence` row with `replayed: true`; concurrent writers race on the `provider_reference` / `idempotency_key` UNIQUE constraints and the loser returns the winner's row (no duplicate evidence); a conflicting observation for the same reference is refused closed (`conflict` ⇒ `502 provider_unavailable`), never a silent overwrite.

## Verification + synchronization (Later-billing-PR #7)

**Status: delivered, sandbox only. It grants nothing.** Contract detail:
[paystack-provider-contract.md](./paystack-provider-contract.md) §2.3.

| Layer | File | Role |
| --- | --- | --- |
| Transport | `packages/providers/paystack/src/client.ts` | `verifyTransaction(reference)` → documented `GET /transaction/verify/:reference`; documented fields only (`domain`, `status`, `reference`, `amount`, `currency`, `customer.id`, `customer.customer_code`), one attempt, typed fail-closed errors, nothing retained. |
| Adapter | `packages/providers/paystack/src/provider.ts` | `verifySubscription` built on that read. Requires OUR checkout reference; refuses a subscription-id-only request before any call; reports lifecycle state **`unknown`** always. `findSubscription`, `synchronizeSubscription`, `cancelSubscription` still refuse; `implemented` stays `false`. |
| Sync | `packages/core/src/billing/sync.ts` | `BillingSubscriptionSyncService`: one verification per call, then ONE transaction that claims the subscription's `received` ledger rows, applies status ONLY through `SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE` guarded by `state_version`, writes the bookkeeping and settles the claimed rows. |
| Ledger | `packages/core/src/billing/webhook.ts` | `claimReceivedBillingProviderEvents` / `settleBillingProviderEvents` — the only processing transitions; the receiver never calls them. |
| Route | `apps/api/src/routes/billing.ts` | `POST /api/billing/sync` — session-authenticated, no body, per-IP limit `BILLING_SYNC_RATE_LIMIT_MAX = 10`/min, canonical `SubscriptionSyncResult` response, `provider_unavailable` refusal (nothing written) when no provider is registered or verification fails. |

What it asserts, and what it deliberately does not:

- **(a) Transaction verify is the read operation** — the only documented
  provider read this build uses for a subscription.
- **(b) No subscription GET** is used or implemented.
- **(c) Undocumented statuses fail closed.** The verify response carries a
  transaction status and **no subscription status**; a transaction status
  (e.g. `success`) is never promoted to a subscription state. Every
  Paystack-verified state is therefore `unknown`.
- **(d) No cancellation is inferred** from unpublished shapes: no
  cancellation, period or plan fact is read or written.
- **(e) No paid grant.** Only `status` (via the canonical mapping, when one
  exists), `provider_state` and the 0031 bookkeeping move; `plan` is never
  written; the provider→FREE entitlement gate (`resolveEntitlements`) is
  unchanged, `paymentConfirmed` stays `false`, and the result pins
  `planChanged` / `entitlementsChanged` / `grantsExecution` to `false`.
- **(f) The Step 4 operator run is still pending** (below): no epoch is
  registered and no FX version is published in the deployed environment.

Outcome table (the mapping is the contracts' single source of truth):

| Verified state | Outcome | `status` | `sync_state` / `sync_required` | Bound `received` ledger rows |
| --- | --- | --- | --- | --- |
| `active`, `trialing`, `past_due`, `cancelled`, `unsubscribed`, `expired` | `updated` (or `unchanged` when already equal) | mapped value | `synced` / `false` | `processed` (`unrecognized` rows → `ignored`) |
| `unprovisioned` | `ignored` | unchanged | `pending` / `false` | `ignored` |
| `pending`, `unknown` (**every Paystack verification today**) | `requires_manual_review` | unchanged | `conflict` / `true` | `ignored` |
| identity disagreement (reference, customer or subscription id) | `conflict` | unchanged (`provider_state` too) | `conflict` / `true` | `failed` |
| a concurrent writer moved `state_version` first | `conflict` | unchanged | unchanged | untouched (`received`) |
| verification failed / no provider | refused (`provider_unavailable`) | unchanged | unchanged | untouched (`received`) |

No migration: every column and CHECK used here is from 0031. The webhook
receiver is unchanged and stays receipt-only — it performs no verification and
moves no state.

## Sandbox plan provisioning (Step 4)

**Status: the workflow exists; the run has not happened.** No sandbox plan is
provisioned and no FX rate is published in the deployed environment. This
section is the runbook for the separately-authorized operator run that
registers the four sandbox epochs; executing it is an explicit operational
decision, never implied by this repository.

Step 4 adds `packages/core/src/billing/provisioning.ts` — the **outside-adapter**
workflow that registers the four production-shaped sandbox plans
(paystack-provider-contract.md §7.2) as local `billing_provider_plans` epochs.
It also repairs `BillingProviderPlanStore.register()` (migration 0032 declares
`catalogue_amount_minor` NOT NULL, so registration must persist it) and keeps
every store projection parser-compatible (the strict epoch parser refuses the
durable audit columns a full-row `RETURNING` would add; both `RETURNING`
clauses and the lookup `SELECT` project the explicit column list).

**What the workflow guarantees before anything is written**

- The batch is exactly **Pro Monthly, Pro Annual, Elite Monthly, Elite Annual**
  — Starter and every other combination is refused; nothing is priced "new".
- Exactly **one operator-selected FX version** is used: the workflow reads the
  durable `billing_fx_rate_versions` row by id — never "latest", never a newer
  row, never a constructed or fixture rate. It must be USD→GHS, `half_up`,
  already effective at the registration instant, and fresh
  (`registration_time − captured_at ≤ 900 s`, inclusive at 900; 901 s is
  refused). An id that does not exist is `missing`, not a promotion.
- Each plan's GHS amount is **derived, never taken from evidence**:
  `half_up(catalogue USD minor × FX rate)` via
  `computePaymentAmountMinor`/`cataloguePriceMinor` — the two existing
  authorities. Evidence confirms the derivation; it can never override it.
  Anything below Paystack's documented GHS minimum (10 pesewas) is refused.
- Evidence must show **test mode**, **GHS**, minor-unit exponent 2, the
  explicit provider interval for the local period (`monthly` → `monthly`,
  `annual` → `annually`), an **uncapped** recurring plan (a payment-count cap
  — including the evidence plan's `max payments = 1` — is refused), and a
  genuine, non-placeholder `PLN_…` code, unique within the batch.
- The GHS 2.00 capability-evidence plan (§7.1, assembled in code so no source
  file carries the literal) is refused at batch admission
  (`excluded_provider_plan`) — an independent second refusal on top of
  checkout's `forbidden_plan`. It can never become an epoch.
- Only after the **whole** batch validates does anything persist: the four
  `register()` calls run inside **one transaction**; a write-time conflict
  (combination already active, or a provider code already registered anywhere)
  rolls the entire batch back. Nothing is upserted, nothing is retired
  automatically, no partial batch can exist.
- The module contains no transport, no credential and no environment read, it
  never publishes FX and never retires an epoch (source-pinned in tests).

**Runbook (operator, separately authorized — sandbox only)**

1. **Agree the inputs before touching anything.** This run needs: (a) the four
   plan amounts, derived from the catalogue
   (`billing-catalogue.ts` — Pro $39/mo, Pro $390/yr, Elite $99/mo,
   Elite $990/yr) through ONE published FX version — not a rate typed into a
   dashboard; and (b) the four real provider codes the dashboard issues.
2. **Confirm authorization and environment.** This run uses **test/sandbox
   mode only** (`sk_test_` elsewhere; this module reads no key at all). Live
   mode is refused by the code and forbidden here.
3. **Publish the FX version first.** Insert the operator-approved USD→GHS rate
   via `BillingFxRateVersionStore.publish({ fxRateScaled, fxRateScale, effectiveFrom, capturedAt, source: 'ops', … })`
   with `effective_from = captured_at`. Registration must run within
   **900 seconds** of `captured_at`.
4. **Create the four plans in the Paystack Dashboard** (manual, test
   environment — the adapter never mutates plans): plan names for Pro/Elite ×
   monthly/annual, currency **GHS**, interval **monthly**/**annually**, **no
   invoice/payment-count limit**, amount **exactly** the derived GHS figure.
   Record each `PLN_…` code as issued.
5. **Verify the exclusion.** If any recorded code equals the §7.1
   capability-evidence plan, STOP — that plan is never an epoch.
6. **Assemble evidence** — one entry per plan with: `cataloguePlan`,
   `interval`, `providerInterval` (the mapping above), `providerPlanId`
   (real code), `paymentCurrency: 'GHS'`, `paymentAmountMinor` (the derived
   amount as an integer), `paymentAmountExponent: 2`, `mode: 'test'`,
   `paymentCountCap: 'uncapped'`, and an `evidenceReference` provenance label
   (e.g. the dashboard/ticket reference — never a credential).
7. **Register.** Call
   `BillingPlanProvisioningService.registerSandboxPlanEpochs({ fxRateVersionId, evidence })`.
   On success it returns the four epochs in matrix order, all `active`, all
   pinning the same `fx_rate_version_id`.
8. **On ANY refusal, stop.** A `BillingProvisioningError` reason
   (`invalid_evidence`, `plan_matrix`, `interval_mismatch`, `mode_mismatch`,
   `currency_mismatch`, `exponent_mismatch`, `cap_mismatch`, `amount_mismatch`,
   `below_minimum`, `invalid_provider_plan`, `excluded_provider_plan`,
   `duplicate_combination`, `duplicate_provider_plan`, `shared_fx_violation`,
   `invalid_instant`) or `BillingFxError` (`missing` / `stale` / `invalid` /
   `unsupported_currency`) means **nothing was written**. Fix the *input*
   (evidence or FX selection) and rerun the whole batch — never retry the same
   input in a loop.
9. **On a conflict (`billing_provider_plan_unusable`, reason `conflict`)
   stop likewise.** Inspect `billing_provider_plans` read-only; if an epoch
   must be replaced, that is a **separate, explicitly approved** retirement —
   never part of provisioning.
10. **After a successful run, verify the four rows** (`SELECT ... FROM
    billing_provider_plans WHERE status = 'active'`): exactly the four
    combinations, one shared `fx_rate_version_id`, test mode, GHS, the derived
    amounts and the real `PLN_…` codes. Checkout then works end-to-end for
    those combinations (PR-C) with amounts frozen by the epochs — a later FX
    publication never reprices them (D-9).

Registration does not notify anyone, synchronize anything or confirm any
payment: it only makes the four epochs *selectable* by checkout. AC5 clears
when these four epochs exist **and** the dashboard plans match them.
