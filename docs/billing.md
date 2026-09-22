# Billing (in progress)

> **PR3 (this change) adds provider-neutral USD→GHS pricing, the immutable FX /
> provider-plan / pricing-snapshot state (migration `0032`), and a SANDBOX
> Paystack adapter.** Nothing here takes a live payment.
>
> **What PR3 does NOT do:** there is no checkout route and no checkout UI, no
> `apps/web` change, no webhook receiver, no webhook signature processing, no
> subscription synchronization, no billing portal, no refund/proration/dunning
> execution, no notification, no live payment, no production credential, no
> production activation and no Starter selling. `GET /api/billing/me` remains
> the only billing route.
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
> PR1 (merged, `ab27948`) established the authoritative commercial catalogue;
> PR2 (merged) added the canonical billing contracts, the provider seam and
> migration `0031_provider_billing.sql`. PR3 changes no price and no
> entitlement: `canAccessAutomation` stays `false` for every plan.

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
| Paystack API integration | **Sandbox seam only, three of eight operations** (`findCustomer`, `createCustomer`, `initializeCheckout`). No checkout route, no live key, `implemented: false` |
| Provider plan mutation | **Never.** `PUT /plan` is never called; a price change is a NEW epoch + a NEW provider plan, and the previous epoch is retired locally |
| Entitlements / execution | **Unchanged.** `canAccessAutomation` stays `false` for every plan |

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
  no catalogue row.
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
| Synchronization | `sync_state`, `last_sync_source`, `last_synced_at`, `sync_required`, `last_event_idempotency_key`, `state_version` | Bookkeeping for a later sync PR. Defaults are inert (`never_synced` / `none` / `false` / `1`); `state_version` cannot decrease (trigger), so a stale writer loses. |

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

Nothing reads or writes these tables in PR2: there is no receiver, no worker
and no scheduler. `subscriptions_sync_required_idx` exists so a later
synchronization PR does not need another migration.

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

### 5. The sandbox adapter and its composition

`packages/providers/paystack` implements three documented operations
(`findCustomer`, `createCustomer`, `initializeCheckout`) against
`https://api.paystack.co`, accepts **`sk_test_` keys only**, performs exactly one
HTTP attempt (no retry, no idempotency header — Paystack documents neither for
outbound calls), prices nothing and converts nothing. Everything else rejects
with `PaystackNotImplementedError`, and `implemented` stays **`false`**.

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
| Provisioning Pro/Elite sandbox plans | **AC5** partially verified — GHS test-plan **capability** is confirmed (contract §7.1), but the four production-shaped plan IDs do not exist yet, so nothing may be sold. The GHS 2.00 test plan is capability evidence only and is never registered |
| GHS recurring end-to-end | **AC7** unverified |
| Checkout route / UI | Out of scope; the adapter's `initializeCheckout` is unreachable from HTTP |
| Webhook receiver + signature processing | Out of scope. `normalizeEvent` is unimplemented because event **payload shapes** are not verified — documented event names are not enough to guess them |
| Subscription read/verify/sync | No verified subscription read operation, and synchronization is out of scope |
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

## What is still NOT implemented (PR2 scope, updated by PR3)

Explicitly absent — each is a later PR, and none of them may enable execution.
PR3 changed two bullets: a **sandbox** Paystack client now exists (three
documented operations, test keys only, one attempt per call, no route), and
migration 0032 gives the pricing state a writer path through core modules —
while everything below remains true at the **product** level:

- **No checkout** and no payment initialization **route**: no endpoint, no
  redirect, no session handling, no UI. `initializeCheckout` exists on the
  adapter but nothing in `apps/api` can call it from HTTP; there is no customer
  provisioning flow either, so `billing_customers` has no writer yet.
- **No billing portal** and no customer self-serve surface.
- **No webhook route, no webhook processing, no signature verification**, no
  replay protection beyond the ledger's idempotency keys, no rate limiting.
- **No subscription synchronization** — no worker, scheduler, queue claim or
  writer for the PR2 columns. `billing_provider_events` and
  `billing_fx_rate_versions` / `billing_provider_plans` /
  `billing_pricing_snapshots` likewise have no writer wired to a route; the FX
  versions are published by an operator/ops path (a later PR), never by a client
  or a market feed.
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
  at its inert default on every existing row, and **no route, worker or client
  can write them yet** — the adapter is unreachable from HTTP, and no plan
  has been provisioned (AC5 capability verified, four plan IDs pending).
- **FX publishing is an operator action, not a feature.** `billing_fx_rate_versions`
  is written by the ops path that lands in a later PR; PR3 ships the authority,
  the resolution rules and the tests, not a rate feed and not an admin endpoint.

## Later billing PRs

Roughly in order; each is its own PR and may be re-scoped.

1. ~~**Migration 0031**~~ — **delivered by PR2**
   (`0031_provider_billing.sql`).
2. ~~**Paystack adapter**~~ — **partially delivered by PR3**: the sandbox
   adapter implements the three documented operations it can (customer create /
   fetch, transaction initialize) and fails closed on the rest. The customer
   provisioning flow (persisting `billing_customers`) still lands with a later PR
   because it needs a route/worker, and every remaining operation needs either a
   verified read operation or the out-of-scope webhook/sync work.
3. ~~**USD→GHS pricing + FX authority**~~ — **delivered by PR3** (migration
   `0032`, `fx-rate-versions.ts`, `pricing.ts`, `provider-plans.ts`).
4. **Plan provisioning** — Pro/Elite × monthly/annual sandbox plans, registered
   as local epochs. **GHS plan capability verified** (contract §7.1), so this
   milestone may begin; it is **not started**. Prerequisites before any of the
   four plans is created: (a) a published `billing_fx_rate_versions` row, since
   every plan amount is derived from the catalogue USD price through that
   version — no FX version, no plan amount; (b) a decided provisioning path
   that keeps `PUT`/`POST /plan` out of `packages/providers/paystack` (the
   source assertion forbids plan mutation there). The GHS 2.00 test plan is
   capability evidence only and is **never** registered as an epoch.
5. **Checkout / payment initialization route** — server-side initialization
   behind `initializeCheckout`, plus its route and UI. Not before AC1/AC2/AC5/AC7.
6. **Webhook receiver + security** — signature verification
   (`x-paystack-signature`, HMAC-SHA512 of the raw body), replay/idempotency
   protection (the `billing_provider_events` ledger already exists), rate
   limiting, audit and redaction. Requires verified event payload shapes.
7. **Verification + subscription synchronization** — reconcile provider state
   into `subscriptions` through `SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE`
   without letting the provider widen any entitlement. Requires a verified
   subscription read operation and a verified status vocabulary.
8. **Customer provisioning flow and billing portal** — persisting
   `billing_customers` and a self-serve portal.
9. **Web UI** — checkout and portal surfaces in `apps/web`.
10. **Starter entitlement decision** — internal plan value, limits, and the
    mapping widening described above.
11. **Refunds / proration / dunning execution** — each its own PR, each using
    the amount actually charged (never a re-rate).
12. **Production credentials + go-live** only after all of the above, and only
    on the existing Render Free deployment unless the plan decision changes.

None of these steps may enable execution. Automation, live execution and broker
execution stay OFF regardless of billing state.
