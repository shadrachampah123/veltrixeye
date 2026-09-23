# Paystack provider contract (sandbox)

> **Status: sandbox seam only. This document describes what the adapter in
> `packages/providers/paystack` does, and — more importantly — what is
> deliberately NOT done because the provider does not publish it.**
>
> Nothing in this repository takes a live payment. `POST /api/billing/checkout`
> exists, but it only *initializes* a sandbox checkout through the
> `transaction/initialize` operation below — it never verifies or confirms a
> payment. There is no checkout UI, no webhook receiver, no subscription
> synchronization, no billing portal, no production credential and no live
> activation. The sandbox adapter is registered by `apps/api` **only** when a
> sandbox key is configured, and it reports itself as `live: false` with
> `implemented: false` while seam operations remain unimplemented.
>
> **Every statement about Paystack below is taken from Paystack's official
> documentation** (`paystack.com/docs/*`, `support.paystack.com`). Where the
> documentation is silent, the adapter **fails closed** and this document says
> so explicitly, rather than guessing a behaviour. A behaviour that is not
> documented here is not implemented.

## 1. Facts the adapter is allowed to rely on

| Fact | Value / rule | Where it comes from |
| --- | --- | --- |
| API base URL | `https://api.paystack.co` (the same host serves test and live; the **key** selects the environment) | API reference |
| Authorization | `Authorization: Bearer <SECRET_KEY>`, secret keys are `sk_` (`sk_test_` sandbox / `sk_live_` live) | Authentication |
| Request/response encoding | JSON request bodies, JSON responses | API reference |
| Amounts | Integers in the **minor unit** (`base × 100`, including for XOF) | API reference |
| GHS minor unit | **pesewa** (1/100 of a cedi) | API reference |
| GHS minimum charge | **₵0.10** (= 10 pesewas) | API reference |
| Test mode | Settlements are not processed and some channels are unavailable in test mode | Authentication |
| Customer create | `POST /customer` — `email` required; optional `first_name`, `last_name`, `phone`, `metadata`; returns a customer object with `customer_code` (`CUS_…`) and numeric `id` | Customer API |
| Customer fetch | `GET /customer/:email_or_code` — accepts **either** an email or a `customer_code`; returns the customer with its `authorizations[]` | Customer API |
| Customer 404s | **Two distinct documented 404 shapes exist**: an unauthorized/invalid-key envelope and a not-found envelope | Customer API |
| Transaction initialize | `POST /transaction/initialize` — `amount` **and** `email` required; optional `reference`, `callback_url`, `channels`, `metadata`, `plan`; returns `authorization_url`, `access_code`, `reference` | Transaction API |
| Plan on initialize | Supplying `plan` **overrides** the supplied `amount` | Transaction API |
| Transaction verify | `GET /transaction/verify/:reference` — returns `status`, `amount`, `currency`, `customer`, `plan`, `authorization.reusable`, `paid_at` | Transaction API |
| Plan create | `POST /plan` — `name`, amount in subunits, `interval` (`monthly`, `annually`, …), optional `currency`; returns a plan object with `plan_code` (`PLN_…`) and numeric `id` | Plan API |
| Plan update | `PUT /plan/:code` accepts `update_existing_subscriptions` (**defaults to `true`**) | Plan API |
| Subscription create | `POST /subscription` — `customer`, `plan`, optional `authorization`, `start_date`; returns `SUB_…` and an `email_token` | Subscription API |
| Subscription enable/disable | Require **both** `code` and `token` | Subscription API |
| Subscription prerequisites | Creating a subscription requires an existing customer authorization (card and direct debit documented) | Subscriptions guide |
| Retry behaviour | **"Subscriptions aren't retried"** — a failed recurring charge is not retried by Paystack | Subscriptions guide |
| Billing-cycle events | `subscription.create` → `invoice.create` → `charge.success` \| `invoice.payment_failed` → `invoice.update` | Subscriptions guide |
| Billing day | A plan whose billing day is ≤ 28 bills on the same day; 29th–31st bill on the 28th | Subscriptions guide |
| Webhook signature | `x-paystack-signature` = HMAC-SHA512 of the **raw** request body keyed by the secret key | Webhooks |
| Webhook retries | Live: retries at 3-minute intervals (×4) then hourly for up to 72 h. Test: hourly for up to 10 h. 30-second timeout | Webhooks |
| Refund | Partial refunds supported (`amount` ≤ original); statuses `pending`, `processing`, `processed`, `failed`, `needs-attention` | Refund API |
| Test cards | Published test-card list (success, failure, refund-scenario, API-error, EFT, mobile money, dedicated virtual account) | Test payments |

### What is NOT documented (so the adapter refuses to assume it)

- **Idempotency.** No idempotency-key header, no documented de-duplication
  window for `POST /transaction/initialize` or `POST /customer`.
- **Plan archival.** No documented way to delete or archive a plan, and no
  documented rule for what happens to existing subscribers if a plan changes.
- **A provider status vocabulary.** The documentation lists lifecycle *events*,
  not an exhaustive set of transaction/subscription status strings.
- **Subscription plan-change semantics** (in-place change vs new subscription,
  re-authorization, timing).
- **Session/checkout expiry semantics** for an unused `authorization_url`.
- **Any GHS-specific capability guarantee** for a given account (see §7).

Consequences, enforced in code:

1. **Local deterministic idempotency.** `billing_provider_events.idempotency_key`
   (0031) and `billing_pricing_snapshots.idempotency_key` (0032) are local,
   deterministic and unique. A retried request recomputes the same key; the
   database refuses the duplicate. No provider idempotency is relied upon.
2. **No plan mutation.** `PUT /plan` is never called — a price change is a NEW
   local epoch plus a NEW provider plan, and the previous epoch is RETIRED
   locally (source-assertion test: `test/source-assertions.test.ts`).
3. **Fail closed on the unknown.** An unrecognized status becomes `unknown`
   (manual review), an unrecognized event becomes `unrecognized`, and an
   ambiguous 404 is an error rather than "customer not found".

## 2. The seam operations

`BillingProvider` (in `packages/core/src/billing/provider.ts`) is
provider-neutral. The Paystack adapter (`implemented: false` is honest — see
below) implements it as follows:

| Operation | State | Documented operation used |
| --- | --- | --- |
| `describe()` | **implemented** | `{ provider: 'paystack', baseUrl: 'https://api.paystack.co', mode: 'test', live: false, implemented: false, timeoutMs, operations: { implemented: [...], unimplemented: [...] } }` — the key is never included |
| `findCustomer` | **implemented** | `GET /customer/:email_or_code` |
| `createCustomer` | **implemented** | `POST /customer` |
| `initializeCheckout` | **implemented** | `POST /transaction/initialize` |
| `findSubscription` | **not implemented** | no verified subscription *read* operation → `PaystackNotImplementedError` |
| `verifySubscription` | **not implemented** | same reason |
| `synchronizeSubscription` | **not implemented** | subscription synchronization is out of scope for this change |
| `cancelSubscription` | **not implemented** | the documented disable operation needs the subscription code **and** its `email_token`, which this build does not persist |
| `normalizeEvent` | **not implemented** | no webhook receiver exists and event *payload shapes* are not verified — the documented event **names** are not enough to safely normalize a payload |

Consequences:

- `implemented` stays **`false`** on purpose. The seam defines eight operations
  and this build performs three; a caller must treat a non-implemented provider
  as unavailable rather than assume the rest work.
- Unimplemented operations **reject with a typed error**; they never return a
  permissive default and never fall back to a different behaviour.
- `PAYSTACK_IMPLEMENTED_OPERATIONS` and `PAYSTACK_UNIMPLEMENTED_REASONS` (both
  exported) are the single source of truth for the tables above, and a test
  asserts that every unimplemented operation rejects **without touching the
  transport**.

## 3. Transport posture (`src/client.ts`)

- **Fetch is injected.** `PaystackClient` takes a `fetchFn` (defaulting to
  global `fetch`) and a clock. Tests inject a stub that records calls — the
  suite opens **no sockets**.
- **One host, a constant.** `PAYSTACK_API_BASE_URL = 'https://api.paystack.co'`;
  there is no configuration key for it, so no deployment can repoint the
  adapter, and a test cannot accidentally reach the real API.
- **Sandbox only.** `secretKey` must start with `sk_test_`; `sk_live_`, `pk_*`
  and empty keys are refused **at construction**. `PAYSTACK_LIVE` is pinned
  `false`.
- **One attempt, no retries.** Paystack documents retries for **webhooks**, not
  for outbound API calls, so the client never retries and never backs off.
- **No idempotency header.** Not documented → not sent. Local deterministic keys
  (0031 `billing_provider_events.idempotency_key`, 0032
  `billing_pricing_snapshots.idempotency_key`) are what make a retry safe.
- **Bounded, redacted failure.** Errors carry a typed reason (`PaystackFailureReason`),
  a message bounded to `PAYSTACK_ERROR_MESSAGE_MAX` and redacted
  (`redactPaystackMessage` removes the configured key verbatim, any
  `(sk|pk)_(test|live)_…` shape, `Bearer …` values and `field: value` credential
  assignments; ordinary prose such as "invalid authorization" is preserved so an
  operator can still diagnose it).
- **No payload persistence.** No raw provider body is logged or stored.

### The two documented 404s

`GET /customer/:email_or_code` documents **two different 404 envelopes**. The
client classifies a 404 by its message, conservatively:

| 404 response | Classification | Result |
| --- | --- | --- |
| readable body whose message is **authorization-shaped** (`unauthor…`) | `provider_rejected` | error — an authorization problem is never "no customer" |
| readable body whose message names a missing **customer** (`customer` + `not found` / `does not exist` / `no customer`) | `not_found` | `fetchCustomer` returns `null` |
| any other message, or an unreadable/empty body | `ambiguous_not_found` | error — ambiguity is never resolved as "absent" |

### The provider call itself

`initializeCheckout` sends `amount` (the authorized GHS minor amount, verbatim),
`currency: 'GHS'` (explicitly, never relying on the integration default),
`email`, our `reference`, an optional `https` `callback_url`, the provider plan
id when the charge is plan-bound, and a small `metadata` block carrying ONLY our
own reference, the pricing-policy version and the FX version id (traceability,
no personal data, no amount the provider did not receive in `amount`).

`POST /transaction/initialize` is documented as treating `plan` as
**overriding** `amount`, so a plan-bound charge is only sent after the local
epoch has been proven to authorize exactly that amount (§4 below and
`assertProviderPlanMatches` in core).

For a **plan-bound** charge the amount sent is the **frozen epoch amount** — the
GHS amount fixed when the epoch was registered ([billing.md](./billing.md) D-9) —
and the FX facts disclosed with that checkout are the **epoch's** FX facts, not
a live rate. The adapter never re-rates an existing epoch from a later FX
version: it holds no rate and no catalogue amount, and it does no arithmetic
(§5). A later rate reaches a customer only through a **new** epoch bound to a
**new** provider plan, never by mutating this one.

Outcome handling: a documented provider rejection returns `status: 'failed'`; an
unknown outcome (transport error, timeout, unreadable response) returns
`status: 'unavailable'`. **Neither is an initialization**, and neither is ever
retried blindly. A reference the provider does not echo back is a
`reference_conflict` (an error), never an accepted success.

## 4. Fail-closed reason vocabulary

`PaystackFailureReason` (`src/errors.ts`, all of them refusals, none a retry):

`invalid_configuration`, `invalid_request`, `unauthorized_amount`,
`plan_not_registered`, `plan_mismatch`, `customer_not_provisioned`,
`not_implemented`, `not_found`, `ambiguous_not_found`, `provider_rejected`,
`provider_unavailable`, `unexpected_response`, `reference_conflict`,
`response_conflict`.

Notable mappings: a missing/inexact authorized amount is always
`unauthorized_amount`; a plan or epoch mismatch is `plan_mismatch` (retired and
unregistered plans are refusals, not warnings); a 5xx/timeout/unreadable body is
`provider_unavailable`; a provider-reported customer whose email contradicts the
email we sent is `response_conflict`.

## 5. Money rules the adapter obeys

- The adapter **never prices** and **never converts**. It receives an authorized
  `BillingPricingSnapshot` (USD catalogue amount + GHS payable amount + FX
  version + rounding mode) and sends exactly
  `paymentAmountMinor` in GHS pesewas; it refuses to proceed without it.
- **Plan-bound checkout uses the epoch's frozen amount.** When the charge is
  plan-bound, `paymentAmountMinor` is the amount the active
  `billing_provider_plans` epoch was **registered** at, and the epoch's FX
  version is the FX fact disclosed with it. The adapter never re-rates an
  existing epoch from a later FX version — `PUT /plan` is never called, and the
  15-minute FX freshness rule applies to **new** one-off pricing and to **new**
  epoch registration, not to an epoch that is already registered
  ([billing.md](./billing.md) D-9).
- A provider-reported amount or currency that differs from the authorized
  snapshot in **any** way is an incident (`amount_mismatch`), for both
  under-charges and over-charges.
- No floating-point arithmetic exists anywhere in the billing path, and the
  only rounding step is one half-up step in
  `packages/core/src/billing/pricing.ts`.

## 6. Sandbox facts vs capabilities (never conflated)

Test keys and test cards (`4084 0840 8408 4081` for success, `4084 0800 0000 5408`
for failure, the refund-scenario and API-error cards, the documented EFT and
mobile-money test values) exist **because the provider publishes them**. Their
existence is not evidence about this account: it says nothing about whether GHS
is enabled for a given integration, whether a Ghanaian entity can transact
GHS recurring, or whether settlements are available.

## 7. Account-level unknowns (blocking, deliberately unresolved)

These are **not** documented for our account and are therefore not assumed
anywhere in code or documentation:

| # | Unknown | Why it blocks |
| --- | --- | --- |
| AC1 | Whether this account can transact in **GHS** | Nothing GHS can be enabled for real customers until verified |
| AC2 | Whether this account can do **GHS recurring** subscriptions | Recurring GHS is the product requirement; unverified |
| AC5 | Whether Pro/Elite × monthly/annual sandbox **plan IDs** exist | No plan may be provisioned or sold without them. **Capability layer verified** (see §7.1); the four production-shaped plan IDs still do not exist (see §7.2) |
| AC7 | Whether a sandbox **GHS recurring** end-to-end run completes | No recurring-E2E readiness claim without it |

### 7.1 Account-specific evidence: GHS test-plan capability (operator-reported)

The following is **operator-reported Paystack Dashboard evidence**, recorded
here verbatim. It was created manually in the Dashboard (test mode) — not by
this repository, not by the adapter, and not by any code path. It has not been
re-read through the API (`GET /plan/:code`) from this repository.

| Field | Value |
| --- | --- |
| Plan name | `VeltrixEye Pro Monthly Test` |
| Plan code | `PLN_u0l4961hhipl6ek` |
| Currency | **GHS** |
| Amount | GHS 2.00 (200 pesewas) |
| Interval | `monthly` |
| Max number of payments | 1 |
| Status | Active |
| Environment | **Test / sandbox** (`domain: test`) |
| Created | 2026-09-22 18:15 (operator's local time) |
| Source | Paystack Dashboard → Plans, reported by the operator |

**What this establishes — and only this:**

- This account's integration **can create an Active plan in GHS, in test
  mode, with a monthly interval**. That is the account-level "GHS plan
  capability" named as the blocker for the plan-provisioning milestone in
  [billing.md](./billing.md).

**What it does NOT establish:**

- AC1 — no GHS transaction has been executed against this account.
- AC2 — no customer authorization, subscription or recurring charge exists;
  a plan with `max payments = 1` is a single-invoice plan, not a recurring
  cycle.
- AC7 — no end-to-end run has occurred.
- The `annually` interval, or any Elite plan, on this account.
- AC5 in full: **none** of the four production-shaped sandbox plans
  (Pro/Elite × monthly/annual) exist yet.

**This plan MUST NOT be registered as a `billing_provider_plans` epoch.** It is
capability evidence only. Its amount (GHS 2.00) is not the FX-derived Pro
monthly price, no `billing_fx_rate_versions` row exists to pin it to, and its
`max payments = 1` contradicts an open-ended subscription epoch;
`assertProviderPlanMatches` would (correctly) refuse it. Nothing may quote,
sell or initialize a checkout against this plan code. It is **not** one of the
four production-shaped plans in §7.2 and is not a substitute for any of them.

### 7.2 The four production-shaped plans (still missing)

AC5 is cleared only when these four exist, and each is registered locally as an
epoch. Nothing here has been created yet. **The registration path is now code:**
Step 4 (`packages/core/src/billing/provisioning.ts`) validates the whole
four-plan batch and registers it atomically outside the adapter — see the
*Sandbox plan provisioning (Step 4)* runbook in
[billing.md](./billing.md). What remains is the separately-authorized operator
run (dashboard plan creation + FX publication + one registration call).

| Plan | Interval | Currency | Mode |
| --- | --- | --- | --- |
| Pro Monthly | `monthly` | **GHS** | **test** |
| Pro Annual | `annually` | **GHS** | **test** |
| Elite Monthly | `monthly` | **GHS** | **test** |
| Elite Annual | `annually` | **GHS** | **test** |

Requirements, all of them ([billing.md](./billing.md) D-9 and its roadmap item) —
each is enforced by the Step 4 workflow before anything is written:

- **No invoice / payment-count cap** on any of the four. The GHS 2.00 evidence
  plan is `max payments = 1`; these are open-ended recurring plans.
- **One FX version for all four.** Each plan's GHS amount must be
  `half_up(catalogueUsdMinor × epochRate)` under the **same** published
  `billing_fx_rate_versions` version (fresh: within 900 s of the registration
  instant, already effective), and each registered epoch must reference
  **that same FX version ID**.
- Each epoch references the plan's **real `PLN_` code** — the code Paystack
  actually issued, never a placeholder.
- **The adapter must not gain `/plan` mutation capability.** `POST`/`PUT /plan`
  stays out of `packages/providers/paystack` (the source assertion forbids plan
  mutation there), so the four plans are provisioned outside the adapter and the
  adapter only ever reads against a registered epoch.
- **The throwaway GHS 2.00 plan stays excluded** — capability evidence only,
  never registered as an epoch. The provisioning workflow refuses it before any
  write (`excluded_provider_plan`), independently of checkout's own refusal.

| F1–F11 | Plan-change timing, re-authorization, in-flight checkout, session expiry, plan-currency mutability, post-failure status, charge-authorization-as-dunning, full event strings, status vocabulary, GHS capability, Ghanaian regulatory posture | Each is undocumented; each is handled by failing closed |

International-payment support (the Dashboard → Preferences request flow, the
documented 1.95 % Ghana international fee, USD payouts only for Kenya/Nigeria)
is likewise an **account capability**, not a code path.

## 8. What this PR deliberately does not build

No checkout route, no checkout UI, no `apps/web` change, no webhook receiver, no
signature processing, no subscription synchronization, no billing portal, no
refund/proration/dunning execution, no notifications, no live payment, no
production credential, no production activation, no Starter selling, no
provider-plan epoch registration, no epoch-derived pricing entry point, no
`/plan` mutation, no FX publication, no Gate 9 work, no broker execution and no
trading logic. The GHS 2.00 test plan is not registered as an epoch. See
[billing.md](./billing.md) for the billing roadmap and for decisions D-1 … D-9.
