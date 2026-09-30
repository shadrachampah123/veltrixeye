'use client';

import * as React from 'react';
import { Badge, Card, CardHeader } from '@/components/ui';
import {
  BILLING_CHECKOUT_SELLABLE_PLANS,
  BILLING_CURRENCY,
  BILLING_PROVIDER,
  COMMERCIAL_PLAN_CATALOGUE,
  commercialPlanCatalogueEntry,
  commercialPlanForInternalPlan,
  resolveBillingCheckoutState,
  type BillingCheckoutState,
  type BillingStateDto,
  type PlanCatalogueEntry,
  type UserPlan,
} from '@veltrixeye/contracts';
import { BRAND } from '@/lib/brand';
import { formatDateTime } from '@/lib/formats';

export interface SubscriptionPanelProps {
  billing: BillingStateDto | null;
  /**
   * Billing Step 9: true once THIS UI session was told by
   * `POST /api/billing/verify` that verified payment evidence was recorded. It
   * is a display fact, never an authority — the server still reports
   * `paymentConfirmed: false` until an operator writes the activation fact.
   */
  evidenceRecorded?: boolean;
  /** True when the billing read failed, rather than still being in flight. */
  unavailable?: boolean;
}

export function SubscriptionPanel({
  billing,
  evidenceRecorded = false,
  unavailable = false,
}: SubscriptionPanelProps) {
  if (!billing) {
    // Billing Step 9: a FAILED read is its own state. It must not be presented
    // as the free state (nothing is known) and not as a payment state.
    if (unavailable) {
      return (
        <Card>
          <CardHeader
            title="Subscription"
            subtitle="Entitlement & plan limits"
            actions={<Badge tone="danger">billing unavailable</Badge>}
          />
          <div className="space-y-2 px-5 py-6 text-sm text-ink-400">
            <p>
              <strong className="text-danger-450">Billing unavailable:</strong> the server&rsquo;s billing state could
              not be read, so nothing here is claimed, offered or confirmed.
            </p>
            <p className="text-xs text-ink-500">
              Limits are enforced server-side, so the limits that apply are the last ones the API enforced. Reload the
              page to read the billing state again.
            </p>
          </div>
        </Card>
      );
    }
    return (
      <Card>
        <CardHeader title="Subscription" subtitle="Entitlement & plan limits" />
        <div className="px-5 py-6 text-sm text-ink-400">Loading billing state…</div>
      </Card>
    );
  }

  const ent = billing.entitlements;
  const sub = billing.subscription;
  // A provider-backed row is a CHECKOUT, not a purchase. `paymentConfirmed` is
  // DERIVED server-side from the durable activation fact (Billing Step 8), and
  // the server has already resolved an unactivated row to the free tier — so the
  // panel must never present its `status: active` as a confirmed paid
  // subscription. Display only: this component grants nothing and cannot change
  // any limit.
  const providerStatus = billing.providerStatus;
  // The server-reported provider domain: the copy below is only ever rendered
  // with a READ billing state, so the mode is known here — never guessed.
  const mode = billing.mode;
  // Billing Step 9 — the SAME five-state vocabulary the checkout surface uses,
  // derived by the same pure function, so the two panels cannot disagree about
  // what the server said: free / awaiting verification / evidence awaiting
  // operator activation / activated / unavailable.
  const checkoutState: BillingCheckoutState = resolveBillingCheckoutState({
    billing,
    evidenceRecorded,
    unavailable,
  });
  const awaitingVerification = checkoutState === 'awaiting_verification';
  const evidenceAwaitingActivation = checkoutState === 'evidence_recorded';
  const awaitingConfirmation = awaitingVerification || evidenceAwaitingActivation;
  // A non-commercial operator grant (migration 0036): the account holds a
  // commercial tier WITHOUT having bought anything. The server reported it, so
  // the limits above are genuinely the server's; this block only explains WHY,
  // and it states plainly that no payment was made. Display-only: this panel
  // offers no action and can change nothing.
  const grant = billing.entitlementGrant;
  // The commercial name comes from the frozen catalogue (Pro / Elite), never
  // from a literal here, so a catalogue rename cannot desynchronise this copy.
  const grantLabel = grant === null ? null : commercialPlanCatalogueEntry(grant.plan)?.name ?? grant.plan;

  return (
    <Card>
      <CardHeader
        title="Subscription & Entitlements"
        subtitle="Plan foundations — server-authoritative, no client-side bypass"
        actions={
          evidenceAwaitingActivation ? (
            <Badge tone="info">evidence · awaiting operator activation</Badge>
          ) : awaitingVerification ? (
            <Badge tone="warning">
              {providerStatus.providerState ?? 'pending'} · awaiting verification
            </Badge>
          ) : checkoutState === 'unavailable' ? (
            <Badge tone="danger">billing unavailable</Badge>
          ) : (
            <Badge tone={sub.status === 'active' ? 'success' : 'warning'}>{sub.status}</Badge>
          )
        }
      />
      <div className="space-y-5 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-signal-600/20 text-signal-400 font-semibold">{sub.plan.slice(0, 2).toUpperCase()}</div>
          <div>
            <div className="text-sm font-semibold capitalize text-ink-50">
              {sub.plan} plan
              {awaitingVerification ? (
                <span className="ml-2 text-[11px] font-normal normal-case text-amber-450">
                  awaiting payment verification
                </span>
              ) : evidenceAwaitingActivation ? (
                <span className="ml-2 text-[11px] font-normal normal-case text-info-450">
                  evidence recorded · awaiting operator activation
                </span>
              ) : null}
            </div>
            <div className="text-xs text-ink-400">
              {sub.currentPeriodEnd ? `Renews ${formatDateTime(sub.currentPeriodEnd)}` : 'No renewal date'} · {BRAND.name} {BRAND.version}
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <EntitlementRow label="Strategies" value={`${ent.maxStrategies}`} hint="Max saved strategies" />
          <EntitlementRow label="Backtests / month" value={`${ent.maxBacktestsPerMonth}`} hint="Historical replay limit" />
          <EntitlementRow label="Alerts / month" value={`${ent.maxAlertsPerMonth}`} hint="Scored alerts" />
          <EntitlementRow label="Saved setups" value={`${ent.maxSavedSetups}`} hint="Persisted setups" />
        </div>

        <div className="rounded-md border border-ink-700 bg-ink-850/50 p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-300">Feature Access</div>
          <div className="grid gap-2 text-xs">
            <FeatureRow label="Advanced strategies" enabled={ent.canAccessAdvancedStrategies} />
            <FeatureRow label="Advanced alerts" enabled={ent.canAccessAdvancedAlerts} />
            <FeatureRow label="Live scanner" enabled={ent.canAccessScanner} />
            <FeatureRow label="Automation (M8)" enabled={ent.canAccessAutomation} note="Automation remains OFF by default — safety preserved" />
          </div>
        </div>

        {awaitingVerification ? (
          <div className="rounded-md border border-amber-450/30 bg-amber-450/10 px-3 py-2.5 text-[11px] leading-snug text-ink-300">
            <strong className="text-amber-450">Payment not confirmed:</strong> this {sub.plan} subscription was
            created by a {providerStatus.provider ?? 'billing provider'} checkout and the provider last reported{' '}
            &ldquo;{providerStatus.providerState ?? 'pending'}&rdquo;. A provider state is never treated as a
            payment, so the free-plan limits shown above are what the server enforces until verified evidence exists
            and an operator activates the subscription out of band.
          </div>
        ) : null}

        {evidenceAwaitingActivation ? (
          <div className="rounded-md border border-info-450/30 bg-info-450/10 px-3 py-2.5 text-[11px] leading-snug text-ink-300">
            <strong className="text-info-450">Payment evidence recorded &mdash; awaiting operator activation:</strong>{' '}
            verified evidence exists for this {sub.plan} checkout, and the server still reports{' '}
            <span className="font-mono">paymentConfirmed: false</span>. Evidence is a receipt, never an activation, so
            the free-plan limits shown above are what the server enforces until an operator records the activation out
            of band. Nothing on this page can do that.
          </div>
        ) : null}

        {grant !== null ? (
          <div className="rounded-md border border-signal-500/30 bg-signal-500/10 px-3 py-2.5 text-[11px] leading-snug text-ink-300">
            <strong className="text-signal-400">Operator grant &mdash; no payment was made:</strong> this account holds
            the {grantLabel} entitlement tier by a standing, non-commercial grant an operator recorded out of band, so
            the limits shown above are the ones the server enforces. This is <strong>not</strong> a purchase: no
            checkout exists, nothing was charged, and the server still reports{' '}
            <span className="font-mono">paymentConfirmed: false</span>. Automation, live execution and broker execution
            stay off for every plan regardless.
          </div>
        ) : null}

        {checkoutState === 'unavailable' ? (
          <div className="rounded-md border border-danger-450/30 bg-danger-450/10 px-3 py-2.5 text-[11px] leading-snug text-ink-300">
            <strong className="text-danger-450">Billing unavailable:</strong> the billing state could not be read or
            the {mode === 'test' ? 'sandbox ' : ''}checkout is refusing. The limits shown are the last ones the server
            enforced; nothing here is offered and nothing is claimed.
          </div>
        ) : null}

        <div className="rounded-md border border-amber-450/20 bg-amber-450/5 px-3 py-2.5 text-[11px] leading-snug text-ink-400">
          <strong className="text-amber-450">Entitlement foundation:</strong> All limits are enforced server-side. The UI never grants access — it only displays what the API returns. M8.7 safety controls (drawdown protection, kill-switch, automation OFF) remain active regardless of plan.
          {awaitingConfirmation ? (
            <>
              {' '}The server reports <span className="font-mono text-ink-300">paymentConfirmed: false</span> for this
              row, so the limits above are the ones it enforces — no display, provider state or receipt widens them.
            </>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function EntitlementRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-1 font-mono text-sm font-semibold text-ink-50">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div>}
    </div>
  );
}

function FeatureRow({ label, enabled, note }: { label: string; enabled: boolean; note?: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div>
        <span className="text-ink-200">{label}</span>
        {note && <span className="ml-2 text-[10px] text-ink-500">· {note}</span>}
      </div>
      <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'Included' : 'Not included'}</Badge>
    </div>
  );
}

/**
 * Plan comparison — rendered from the single authoritative commercial catalogue
 * (`@veltrixeye/contracts` billing catalogue), never from local placeholder
 * values. Display only: the UI cannot grant anything the API does not already
 * return. Since Billing Step 9 a SANDBOX checkout surface exists next to this
 * card (`billing-checkout.tsx`), and Billing Portal v1 added the read-only
 * overview card (`billing-portal.tsx`); there is still no self-serve
 * cancellation, no invoice or payment-method surface and no live payment.
 *
 * `currentPlan` is the **internal** plan value (`free` / `pro` / `premium`);
 * the commercial counterpart comes from the documented compatibility mapping.
 *
 * Billing Step 10a: the cards distinguish what is SOLD from what merely exists
 * in the catalogue. Sellability comes from `BILLING_CHECKOUT_SELLABLE_PLANS`
 * and nothing else; a catalogue entry without a sellable plan (today: Starter)
 * is marked "Not available yet" and explained as a catalogue concept with no
 * enforced entitlement tier. Pro/Elite rendering and the current-plan badge are
 * unchanged, and no card offers any action.
 */
export function PlanComparison({
  currentPlan,
  mode = 'test',
}: {
  currentPlan: UserPlan;
  /**
   * The configured provider domain of the billing state (null while the read
   * has not answered). Defaults to the sandbox copy for direct renders; the
   * page passes the server-reported mode so a live build never claims
   * sandbox — and an unknown mode claims neither.
   */
  mode?: 'test' | 'live' | null;
}) {
  const currentCommercialPlan = commercialPlanForInternalPlan(currentPlan);
  // Billing Step 10a — sellability is DERIVED, never restated here: the sellable
  // plans are exactly `BILLING_CHECKOUT_SELLABLE_PLANS` (Pro + Elite), and every
  // other catalogue entry is a catalogue CONCEPT only. Starter is therefore
  // rendered as "Not available yet" and nothing about it is offered, priced for
  // payment, provisioned or activatable: no internal plan value, no entitlement
  // definition and no provider plan exists for it, and the server refuses it at
  // every gate. This is a display distinction and it grants nothing.
  const sellablePlans: readonly string[] = BILLING_CHECKOUT_SELLABLE_PLANS;
  const unavailableCataloguePlans = COMMERCIAL_PLAN_CATALOGUE.filter(
    (plan) => !sellablePlans.includes(plan.id),
  );

  return (
    <Card>
      <CardHeader
        title="Plan Comparison"
        subtitle={`Authoritative commercial catalogue · ${BILLING_CURRENCY} · billed via ${
          BILLING_PROVIDER === 'paystack' ? 'Paystack' : BILLING_PROVIDER
        } · no payment flow yet`}
      />
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        {COMMERCIAL_PLAN_CATALOGUE.map((plan) => {
          const isCurrent = plan.id === currentCommercialPlan;
          const isSellable = sellablePlans.includes(plan.id);
          return (
            <div key={plan.id} className={`rounded-lg border p-4 ${isCurrent ? 'border-signal-500/50 bg-signal-500/5' : isSellable ? 'border-ink-700 bg-ink-800' : 'border-ink-700 bg-ink-850/60'}`}>
              <div className="flex items-center justify-between">
                <span className={`font-semibold ${isSellable ? 'text-ink-50' : 'text-ink-300'}`}>{plan.name}</span>
                {isCurrent && <Badge tone="success">Current</Badge>}
                {!isSellable && <Badge tone="neutral">Not available yet</Badge>}
              </div>
              <div className={`mt-1 font-mono text-lg ${isSellable ? 'text-ink-100' : 'text-ink-400'}`}>
                {plan.pricing.monthly.display}
                <span className="text-xs text-ink-400">/mo</span>
                <span className="ml-2 text-sm text-ink-300">
                  {plan.pricing.annual.display}
                  <span className="text-xs text-ink-400">/yr</span>
                </span>
              </div>
              <PlanCatalogueFeatures plan={plan} />
            </div>
          );
        })}
      </div>
      <div className="border-t border-ink-700 px-5 py-3 text-[11px] leading-snug text-ink-400">
        Prices are {BILLING_CURRENCY} and come from the server-side catalogue.{' '}
        {currentCommercialPlan === null
          ? `Your account is on the internal "${currentPlan}" plan, which has no commercial catalogue counterpart — nothing changes for you.`
          : 'Enforced limits are unchanged and continue to come from the API.'}{' '}
        {unavailableCataloguePlans.length > 0 ? (
          <p className="mt-2">
            <strong className="text-ink-300">
              {`${unavailableCataloguePlans.map((plan) => plan.name).join(' and ')} ${
                unavailableCataloguePlans.length === 1
                  ? 'is a catalogue concept only.'
                  : 'are catalogue concepts only.'
              }`}
            </strong>{' '}
            <span>
              Not offered and not purchasable in this build, with no enforced entitlement tier: the prices and
              allowances on its card are the commercial concept, not a plan the server sells, prices, provisions or
              activates. Every catalogue entry that is not a sellable plan is marked &ldquo;Not available yet&rdquo;.
            </span>
          </p>
        ) : null}
        {mode === 'live' ? (
          <>
            <strong className="text-amber-450">Live billing:</strong> the checkout surface on this page initializes a
            provider <em>live-mode</em> checkout, shows the server&rsquo;s price and FX disclosure and can record
            verified payment evidence. The overview card above is read-only: it states the server&rsquo;s answer and
            offers no action. This page cannot activate a plan — activation is an out-of-band operator action — and
            there is still no saved payment method and no self-serve cancellation. &ldquo;Priority execution&rdquo; on
            Elite is a commercial descriptor only: automation, live execution and broker execution remain unavailable
            on every plan.
          </>
        ) : mode === 'test' ? (
          <>
            <strong className="text-amber-450">Sandbox billing only:</strong> the checkout surface on this page
            initializes a provider <em>sandbox</em> (test-mode) checkout, shows the server&rsquo;s price and FX
            disclosure and can record verified payment evidence. The overview card above is read-only: it states the
            server&rsquo;s answer and offers no action. This page cannot activate a plan — activation is an
            out-of-band operator action — and there is still no saved payment method, no self-serve cancellation and
            no live payment. &ldquo;Priority execution&rdquo; on Elite is a commercial descriptor only: automation,
            live execution and broker execution remain unavailable on every plan.
          </>
        ) : (
          <>
            <strong className="text-amber-450">Billing:</strong> the checkout surface on this page initializes a
            provider checkout in the domain the server has configured, shows the server&rsquo;s price and FX
            disclosure and can record verified payment evidence. The overview card above is read-only: it states the
            server&rsquo;s answer and offers no action. This page cannot activate a plan — activation is an
            out-of-band operator action — and there is still no saved payment method and no self-serve cancellation.
            &ldquo;Priority execution&rdquo; on Elite is a commercial descriptor only: automation, live execution and
            broker execution remain unavailable on every plan.
          </>
        )}
      </div>
    </Card>
  );
}

function PlanCatalogueFeatures({ plan }: { plan: PlanCatalogueEntry }) {
  return (
    <ul className="mt-3 space-y-1 text-xs text-ink-400">
      <li className="flex items-center gap-1.5">
        <span className="text-signal-500">✓</span> {plan.activeStrategies.display} active{' '}
        {plan.activeStrategies.unlimited || (plan.activeStrategies.limit ?? 0) > 1 ? 'strategies' : 'strategy'}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="text-signal-500">✓</span> {plan.markets.display}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="text-signal-500">✓</span> {plan.tradeFrequency.display}
      </li>
      {plan.tradeFrequency.note ? <li className="pl-4 text-[10px] text-ink-500">{plan.tradeFrequency.note}</li> : null}
      <li className="flex items-center gap-1.5">
        <span className="text-ink-500">✕</span> No automation or live execution
      </li>
    </ul>
  );
}
