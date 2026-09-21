# Billing (in progress)

> **PR1 (this change) establishes the authoritative commercial catalogue and
> reconciles the roadmap. Nothing here takes a payment.**
>
> There is no checkout, no payment initialization, no Paystack API call, no
> billing portal, no webhook, no subscription synchronization and no
> production credential. The only billing route remains the read-only
> `GET /api/billing/me` that has existed since M7.4.

## Decisions (operator-confirmed)

| Decision | Value |
| --- | --- |
| Payment provider | **Paystack** |
| Currency | **USD** (single commercial currency) |
| Development credentials | **Sandbox / test keys only** — never committed, never in source control |
| Production credentials | Not present; a later billing PR |
| Render plan | **Free** — unchanged by billing work |
| Billing webhook / signature security | Later billing PRs (not PR1) |
| Migration 0031 | **Not created in PR1** (later billing PR) |

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
   atomic limit checks in the routes. **Unchanged by PR1.** Limits are still
   resolved from the internal plan value and subscription status.
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
`elite`. PR1 renames nothing and migrates no user: changing the stored values
would require a migration (0031) and would affect existing rows, which is
explicitly out of scope for this PR.

The two vocabularies coexist through an explicit, documented mapping that is
**display/commercial only** — entitlement enforcement never consults it:

| Internal value (stored) | Commercial plan | Mapped today? |
| --- | --- | --- |
| `free` | — (default, not sold) | n/a |
| `pro` | **Pro** ($39 / $390) | ✅ 1:1, same name |
| `premium` | **Elite** ($99 / $990) | ✅ highest internal tier |
| — | **Starter** ($15 / $150) | ❌ no internal value yet → needs **migration 0031** |

Consequences:

- An existing `pro` user keeps exactly the limits they have today; we simply
  also call their tier "Pro" commercially.
- An existing `premium` user keeps exactly the limits they have today; they are
  shown the **Elite** catalogue row (same `canAccessAutomation: false`, same
  numbers — the name changes, the enforcement does not).
- A `free` user keeps the free entitlement set; free is not a sold tier and has
  no catalogue row.
- **Starter cannot be sold until migration 0031** introduces its internal plan
  value. That migration is a later billing PR; PR1 only records the gap
  (`unmappedCommercialPlans()` returns `['starter']`).

If a later change would require altering the stored enum or migrating existing
users, that is the point to stop and widen scope deliberately — it is not part
of PR1.

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
- **Provider columns already exist** (`subscriptions.provider`,
  `provider_customer_id`, `provider_subscription_id` from migration 0014) and
  remain unused until a later billing PR populates them.

## Later billing PRs (explicitly NOT in PR1)

Roughly in order; each is its own PR and may be re-scoped:

1. **Migration 0031** — the internal plan value(s) needed to sell Starter (and
   any provider/interval columns the integration needs). Migrations 0001–0030
   stay byte-identical.
2. **Paystack checkout / payment initialization** — server-side initialization
   with sandbox keys, no secrets in source control.
3. **Webhook receiver + security** — signature verification, replay/idempotency
   protection, rate limiting, audit, and redaction (following the existing
   webhook hardening in M9.1/M9.2).
4. **Verification + subscription synchronization** — reconcile provider state
   into `subscriptions` (status, period end, cancellation) without letting the
   provider widen any entitlement.
5. **Customer / subscription creation and billing portal** — provider customer
   records and self-serve portal.
6. **UI** — checkout and portal surfaces in `apps/web` (today the plan
   comparison is display-only).
7. **Production credentials + go-live** only after the above, and only on the
   existing Render Free deployment unless the plan decision changes.

None of these steps may enable execution. Automation, live execution and
broker execution stay OFF regardless of billing state.
