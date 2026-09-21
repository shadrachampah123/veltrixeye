# Billing (in progress)

> **PR2 (this change) adds the billing persistence model (migration `0031`),
> the canonical billing contracts and the Paystack provider SEAM. Nothing here
> takes a payment.**
>
> **No Paystack API integration exists yet.** There is no Paystack API call, no
> HTTP request of any kind, no checkout, no payment initialization, no billing
> portal, no webhook route, no webhook signature verification, no subscription
> synchronization, no credential and no API-key change. The only billing route
> remains the read-only `GET /api/billing/me` that has existed since M7.4.
>
> PR1 (merged, `ab27948`) established the authoritative commercial catalogue;
> PR2 changes no price, no plan limit and no commercial definition.

## Decisions (operator-confirmed)

| Decision | Value |
| --- | --- |
| Payment provider | **Paystack** |
| Currency | **USD** (single commercial currency) |
| Development credentials | **Sandbox / test keys only** — never committed, never in source control |
| Production credentials | Not present; a later billing PR |
| Render plan | **Free** — unchanged by billing work |
| Billing webhook / signature security | Later billing PRs (not PR2) |
| Migration 0031 | **Created in PR2** — `0031_provider_billing.sql`; migrations 0001–0030 stay byte-identical |
| Paystack API integration | **None.** PR2 defines the provider seam only (no call, no route, no credential) |
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

## What PR2 does NOT implement

Explicitly absent — each is a later PR, and none of them may enable execution:

- **No Paystack API integration.** No HTTP call, no client, no endpoint, no
  retry/timeout policy.
- **No checkout** and no payment initialization (no route, no redirect, no
  session handling).
- **No billing portal** and no customer self-serve surface.
- **No webhook route, no webhook processing, no signature verification**, no
  replay protection beyond the ledger's idempotency keys, no rate limiting.
- **No subscription synchronization** — no worker, scheduler, queue claim or
  writer for the new columns.
- **No billing UI and no pricing UI change** (`apps/web` is untouched; the plan
  comparison still renders the PR1 catalogue).
- **No notification change** (M9.1/M9.2 untouched).
- **No credential, API key, environment, `render.yaml` or Vercel change.**
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
- **Provider columns exist but are still unused.** Migration 0014 added
  `subscriptions.provider`, `provider_customer_id` and `provider_subscription_id`;
  migration 0031 adds the rest of the provider-backed model (interval,
  catalogue identity, canonical provider state, cancellation and
  synchronization bookkeeping) plus `billing_customers` and
  `billing_provider_events`. **Nothing writes them yet**: every new column is
  `NULL` or at its inert default on every existing row, and the first writer
  lands with a later billing PR.

## Later billing PRs (explicitly NOT in PR2)

Roughly in order; each is its own PR and may be re-scoped. PR2 delivered the
persistence model, the contracts and the seam, so each of these can now be
implemented behind an existing boundary without another schema change:

1. ~~**Migration 0031**~~ — **delivered by PR2**
   (`0031_provider_billing.sql`), except the internal plan value needed to sell
   Starter, which is an entitlement change and stays deferred (see
   "Prerequisite discovered, deliberately not started").
2. **Paystack adapter** — implement `BillingProvider` against the sandbox API
   and register it in `BillingProviderRegistry`; sandbox keys only, no secrets
   in source control.
3. **Paystack checkout / payment initialization** — server-side initialization
   behind `initializeCheckout`, plus its route.
4. **Webhook receiver + security** — signature verification, replay/idempotency
   protection (the `billing_provider_events` ledger already exists), rate
   limiting, audit and redaction, following the existing webhook hardening in
   M9.1/M9.2.
5. **Verification + subscription synchronization** — reconcile provider state
   into `subscriptions` through `SUBSCRIPTION_STATUS_FOR_PROVIDER_STATE`
   (status, period, cancellation) without letting the provider widen any
   entitlement.
6. **Customer / subscription creation and billing portal** — provider customer
   records (`billing_customers`) and self-serve portal.
7. **UI** — checkout and portal surfaces in `apps/web` (today the plan
   comparison is display-only).
8. **Starter entitlement decision** — internal plan value, limits, and the
   mapping widening described above.
9. **Production credentials + go-live** only after the above, and only on the
   existing Render Free deployment unless the plan decision changes.

None of these steps may enable execution. Automation, live execution and
broker execution stay OFF regardless of billing state.
