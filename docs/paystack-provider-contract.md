# Paystack provider contract (sandbox)

> **Status: sandbox seam only. This document describes what the adapter in
> `packages/providers/paystack` does, and — more importantly — what is
> deliberately NOT done because the provider does not publish it.**
>
> Nothing in this repository takes a live payment. `POST /api/billing/checkout`
> exists, but it only *initializes* a sandbox checkout through the
> `transaction/initialize` operation below — it never verifies or confirms a
> payment. There is no checkout UI, no webhook receiver, no signature
> verification, no subscription synchronization, no billing portal, no
> production credential and no live activation. The sandbox adapter is
> registered by `apps/api` **only** when a sandbox key is configured, and it
> reports itself as `live: false` with `implemented: false` while seam
> operations remain unimplemented.
>
> **The provider event contract DOES now exist (§2.1)**: `normalizeEvent` maps a
> delivered Paystack event onto the canonical billing event contract for the
> four events whose payload shapes Paystack publishes. It is a pure function —
> it receives nothing, verifies no signature, reads no clock, writes no ledger
> row, confirms no payment and grants nothing. Until the receiver in
> [billing.md](./billing.md) step 6b lands, no delivery can reach it.
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
| Webhook delivery body | A POST with a JSON body `{ event, data }`; the payload publishes **no event id** and **no signature inside the body** (the signature is the `x-paystack-signature` header) | Webhooks / Events |
| Verified event payloads | Published, field-for-field payload shapes exist for `charge.success`, `subscription.create`, `invoice.update`, `invoice.payment_failed`, `invoice.create` and `subscription.expiring_cards` | Events / Subscriptions guide |
| Subscription statuses | `active`, `non-renewing`, `attention`, `completed`, `cancelled` (the guide also writes `complete` for a finished subscription) | Subscriptions guide |
| Invoice failure detail | `invoice.description` carries "more information about what went wrong when attempting to charge the card" | Subscriptions guide |
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
- **Payload shapes for several published event names.** `subscription.disable`,
  `subscription.not_renew`, `subscription.enable` and `charge.failed` are named
  in the documentation but **no payload shape is published for them**, so the
  adapter does not normalize them (§2.1). An event *name* is not evidence about
  an event *payload*, and inventing fields from a name is exactly the guesswork
  this document forbids.
- **A currency on an invoice event.** `invoice.*` payloads carry an `amount` but
  no currency of their own; the only currency on them sits inside the
  `transaction` object, which the provider documents as sometimes **empty**.
- **An event identifier.** No published payload carries a provider event id, so
  de-duplication cannot rely on one (§2.1).
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
| `describe()` | **implemented** | `{ provider: 'paystack', baseUrl: 'https://api.paystack.co', mode: 'test', live: false, implemented: false, timeoutMs, operations: { implemented: [...], unimplemented: [...] }, events: { receiver: 'none', signatureVerification: 'none', confirmsPayment: false, grantsExecution: false, supported: [...], canonicalEventTypes: {...}, unsupported: [...] } }` — the key is never included |
| `findCustomer` | **implemented** | `GET /customer/:email_or_code` |
| `createCustomer` | **implemented** | `POST /customer` |
| `initializeCheckout` | **implemented** | `POST /transaction/initialize` |
| `findSubscription` | **not implemented** | no verified subscription *read* operation → `PaystackNotImplementedError` |
| `verifySubscription` | **not implemented** | same reason |
| `synchronizeSubscription` | **not implemented** | subscription synchronization is out of scope for this change |
| `cancelSubscription` | **not implemented** | the documented disable operation needs the subscription code **and** its `email_token`, which this build does not persist |
| `normalizeEvent` | **implemented** (§2.1) | **no provider call** — a pure normalization of the delivered payload against the published shapes in `src/events.ts`. There is still **no receiver**: nothing in this repository accepts a webhook, so this operation is only reachable by a caller that already holds a verified delivery |

Consequences:

- `implemented` stays **`false`** on purpose. The seam defines eight operations:
  this build makes real provider calls for three, normalizes events locally for
  a fourth, and refuses the remaining four. A caller must treat a
  non-implemented provider as unavailable rather than assume the rest work.
- Unimplemented operations **reject with a typed error**; they never return a
  permissive default and never fall back to a different behaviour.
- `PAYSTACK_IMPLEMENTED_OPERATIONS` and `PAYSTACK_UNIMPLEMENTED_REASONS` (both
  exported) are the single source of truth for the tables above, and a test
  asserts that every unimplemented operation rejects **without touching the
  transport** — as does `normalizeEvent`, which is asserted to perform no I/O at
  all.

### 2.1 The verified webhook event contract (`src/events.ts`)

`normalizeEvent(request)` turns ONE delivered provider event into the canonical
`NormalizedBillingEvent` (`packages/contracts/src/billing-provider.ts`). It is a
**pure** function of the seam request: no transport, no clock, no directory, no
database, no mutation of the payload. Two calls with the same request produce
byte-identical results.

**Supported events — the only four whose payload shapes Paystack publishes:**

| Provider event | Canonical event type(s) | `occurredAt` | Subject references reported | Payment amount reported |
| --- | --- | --- | --- | --- |
| `charge.success` | `payment.succeeded` | `data.paid_at` (**required**) | `providerCustomerId` = `data.customer.customer_code`; `providerReference` = `data.reference`; `providerSubscriptionId` = **null** (a charge payload documents no subscription, and its `plan` object is *not* one) | `data.amount` + `data.currency`, validated against the canonical GHS exponent |
| `subscription.create` | `subscription.created` | `data.created_at` (the payload carries both `createdAt` and `created_at` with **different** values; only the snake_case field every documented payload carries is used) | `providerCustomerId` = `data.customer.customer_code`; `providerSubscriptionId` = `data.subscription_code`; `providerReference` = **null** | `data.amount` with the currency read from `data.plan.currency` (the subscription amount has no currency of its own), cross-checked against `data.plan.amount` |
| `invoice.update` | `invoice.processed` when `data.paid === true`, `invoice.failed` when `data.paid === false` — the provider documents this event as carrying "the final status of the invoice" and instructs the integrator to inspect the invoice object | `data.paid_at` when carried, else `data.created_at` | `providerCustomerId` = `data.customer.customer_code`; `providerSubscriptionId` = `data.subscription.subscription_code` (**required**); `providerReference` = `data.transaction.reference` when present, else **null** | **none** — an invoice documents no currency of its own, so no amount is asserted |
| `invoice.payment_failed` | `invoice.failed` | as above | as above | **none**, as above |

Subscription state comes only from the documented status vocabulary:
`active → active`, `non-renewing → unsubscribed`, `cancelled → cancelled`,
`completed → expired`. **`attention` deliberately maps to `unknown`**: the guide
describes it as a retry state while also stating "subscriptions aren't retried",
and `unknown` is the state that changes no authoritative subscription status and
asks for review. Anything else is `unknown` too.

**Intentionally unsupported events** (`PAYSTACK_UNSUPPORTED_EVENT_REASONS`, exported):

| Provider event | Why it is not supported |
| --- | --- |
| `invoice.create` | Its payload **is** published and verified (pinned as a fixture), but the canonical vocabulary has **no "invoice created" event type**. Mapping it onto `invoice.processed`/`invoice.failed` would assert an outcome the delivery does not state, and redesigning the canonical vocabulary is out of scope for a provider change. It normalizes to `unrecognized`. |
| `subscription.disable` | Event name published, **payload shape not published**. Its documented status (`complete`) also contradicts the status list. Unsupported until a payload is verified. |
| `subscription.not_renew` | Event name published, **payload shape not published**. Unsupported until verified. |
| `subscription.enable` | Not part of the published webhook vocabulary and no payload published. |
| `subscription.expiring_cards` | Published payload whose `data` is an **array of expiring cards**: no payment outcome, no mappable subscription state, and card-expiry detail this build must never ingest. |
| `charge.failed` | **Not in the published webhook vocabulary at all**; a failed recurring charge is documented to arrive as `invoice.payment_failed`. |

Everything else the provider documents (`charge.dispute.*`, `refund.*`,
`transfer.*`, `customeridentification.*`, `dedicatedaccount.*`,
`paymentrequest.*`) is outside billing-event scope and normalizes to
`unrecognized`.

**Two different outcomes for two different problems:**

- An event name this build does **not** support is **not an error**: it returns
  the canonical `unrecognized` event with `occurredAt: null`, `subject: null`
  and `data: null`, so a delivery can be recorded without asserting anything.
- A **supported** event whose payload is missing a required field, carries a
  wrong type, contradicts itself, reports a non-`test` domain, or quotes a
  currency/amount this build does not understand **is** an error: a typed
  `PaystackAdapterError` (`unexpected_response`, or `invalid_configuration` for
  a non-sandbox domain, `invalid_request` for a malformed seam request). A
  malformed payment or subscription fact is never silently downgraded to
  `unrecognized`.

**What the normalizer never reads, maps or persists:**

- `data.subscription.email_token` — the provider's **cancellation credential**.
  It appears in published invoice payloads; no code path in this package reads
  it, and a fixture pins that supplying it (with any value) changes nothing.
- `data.authorization` (authorization code, BIN, last4, expiry, signature) and
  any card/brand/expiry detail — credential-shaped material.
- `data.customer.email`, `first_name`, `last_name`, `phone`, and
  `data.ip_address` — personal data the canonical contract has no field for.
- `data.plan.plan_code`, `data.plan.interval`, `data.plan.name` — a provider
  plan is **not** an authorization. `cataloguePlan` and `interval` are always
  `null` from an event; only a locally registered plan epoch maps a provider
  plan onto the catalogue.
- `data.metadata`, `data.gateway_response`, `data.fees*`, `data.log`,
  `data.next_payment_date` (the date of the *next* charge, not a period
  boundary), and the camelCase `createdAt` twin.
- **The raw body.** The payload is hashed (`identity.payloadHash`) and dropped;
  the normalized event carries no envelope, no `payload`/`rawBody`/`body` field
  and no provider-only key. Nothing is logged.

**Failure detail.** The only provider-authored sentence ever mapped is
`invoice.description` → `data.failureReason`, and only for a failed invoice. It
is collapsed to one line, passed through the package redaction pass, hard-bounded
to the durable 600-character limit, and — if it is *still* credential-shaped
(`password`, `token`, `secret`, `api key`, `authorization`, `private key`,
`credential`, `bearer`) — replaced **whole** by
`PAYSTACK_WITHHELD_FAILURE_DETAIL` ("provider failure detail withheld"). A
credential-shaped failure reason is therefore never produced, which is also what
migration 0031's CHECK would refuse to store. Refusal messages are equally
careful: they name the provider event and the **field path** (`data.paid_at`),
never a payload value.

**Identity and idempotency.** Derived by core, never invented here:
`payloadHash = billingEventPayloadHash(body)` over the whole `{event, data}`
envelope (canonical, key-sorted JSON, so delivery key order is irrelevant), and
`idempotencyKey = billingEventIdempotencyKey({provider, providerEventId,
eventType, occurredAt, payloadHash})`. `providerEventId` comes **only** from the
seam request (Paystack payloads publish none) and must itself be
reference-shaped. Two deliveries of the same event collapse onto one
`billing_provider_events` row via migration 0031's unique key; two *different*
payloads never do, including two `unrecognized` ones.

**Local subject fields are always `null`.** `userId`, `subscriptionId` and
`billingCustomerId` are resolved by the receiver against the local directories
before anything is persisted; the durable ledger binds an event to its owner
with a composite key that is either fully resolved or fully null.

**Webhook receipt is NOT payment confirmation.** A normalized
`payment.succeeded` or `invoice.processed` event is a *provider-reported
receipt* of one delivery. It is not a transaction verification (the documented
`GET /transaction/verify/:reference` read is not performed by this build), not a
subscription synchronization, and not evidence that money settled — in sandbox,
settlements are not processed at all.

**Normalization can never grant execution.** `grantsExecution` is pinned
`false` by the canonical contract (`z.literal(false)`), so no payload — however
insistent — can produce a grant, and billing state is not an execution
entitlement. Catalogue identity (`cataloguePlan`, `interval`) is likewise never
derived from a payload.

**Fixtures.** `packages/providers/paystack/test/fixtures/webhook/*.json` pin one
delivery body per case. Each fixture records, beside the payload, the official
page(s) it came from, the field names verified there, and how the values were
adapted to this repository's sandbox GHS flow (placeholder codes, `domain:
"test"`, and `DO_NOT_PERSIST` sentinels for every value the normalizer must
never read). Published quirks are preserved deliberately — the empty
`transaction` object, the `period_start` **after** `period_end`, the
`createdAt`/`created_at` twins, the `email_token` on an invoice payload, the
array-shaped `subscription.expiring_cards` data — so the tests exercise the real
shapes rather than a tidied-up idea of them. One fixture is marked
`synthetic: true`: an adversarial credential-shaped `description`, which no
provider documentation contains, pinned so the redaction rule is tested against
a file.

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

Event normalization (§2.1) uses three of the same reasons and no new ones:

| Situation | Reason |
| --- | --- |
| The seam request itself is not canonical (no `provider`/`payload`/`receivedAt`, a non-ISO receipt instant, an extra field such as a raw body, or a `providerEventId` that is not a reference-shaped identifier) | `invalid_request` |
| A delivery reports a domain other than `test` | `invalid_configuration` |
| A **supported** event whose payload is missing a required field, mis-typed, self-contradictory (`charge.success` with a non-success status; a subscription whose plan amount disagrees with its own amount), or quotes a currency/amount this build cannot normalize | `unexpected_response` |
| An **unsupported or unknown** event name | *no error* — the canonical `unrecognized` event |

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

The event contract in §2.1 changes exactly one line of that list's meaning, and
none of its substance: `normalizeEvent` is now implemented, but it is still
**unreachable from the network**. There is no HTTP route, no raw-body handling,
no `x-paystack-signature` verification, no IP allow-list, no rate limiting, no
event persistence and no entitlement effect anywhere in this repository — a
package test asserts that the provider source contains none of those things.
Until the receiver lands, the only way to call `normalizeEvent` is from a test
or from server-side code that already holds a verified delivery.
