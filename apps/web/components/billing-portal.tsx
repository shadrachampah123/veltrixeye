'use client';

import * as React from 'react';
import { Badge, Card, CardHeader } from '@/components/ui';
import {
  getCommercialPlan,
  type BillingPortalState,
  type BillingPortalSummaryDto,
} from '@veltrixeye/contracts';
import { formatDateTime } from '@/lib/formats';

/**
 * Billing Portal v1 — the READ-ONLY billing overview card on `/settings`.
 *
 * WHAT THIS COMPONENT IS
 *
 * A display surface for exactly one server answer: `GET /api/billing/portal`
 * (`BillingPortalSummaryDto`). It renders the six states distinctly —
 * free, awaiting payment verification, evidence awaiting operator activation,
 * activated, unknown, unavailable — and it shows a plan, an interval and a
 * renewal date ONLY when the server sent one. When the server sends `null`
 * (no stored period end, no stated cancellation, no stated plan) the card says
 * so; it never substitutes a guess, a placeholder or a locally calculated date.
 *
 * It renders no internal or provider identity because the DTO carries none: no
 * user/customer/subscription id, no provider code or reference, no transaction
 * reference, no evidence hash, no idempotency key and no pricing snapshot can
 * reach this component, and the card breaks any of those into "unavailable"
 * copy rather than echoing them.
 *
 * WHAT THIS COMPONENT DELIBERATELY IS NOT
 *  - Not self-service billing. There is NO cancellation control, NO invoice or
 *    payment-history surface, NO payment-method management, NO plan change and
 *    NO subscription editing anywhere in this file — and no API call at all:
 *    the component takes its data as a prop and performs no fetch. The only
 *    billing action in the product remains the sandbox checkout surface
 *    (`billing-checkout.tsx`).
 *  - Not a payment confirmation and not an entitlement. `activated` is the
 *    server's reading of the immutable operator activation fact; nothing
 *    rendered here confirms a payment, moves a plan or widens a limit.
 *  - Not an execution grant. `canAccessAutomation` stays `false` on every plan,
 *    so the card states that automation and live execution remain unavailable.
 */

/** The six states, each with its own label, tone and explanation. */
export const BILLING_PORTAL_STATE_COPY: Readonly<
  Record<BillingPortalState, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; body: string }>
> = Object.freeze({
  free: {
    label: 'free plan',
    tone: 'neutral',
    body:
      'No commercial subscription is on file for this account. The free plan is what the server enforces, and nothing ' +
      'is charged or owed. Creating a sandbox checkout is the only path that writes a subscription — and a checkout on ' +
      'its own buys nothing.',
  },
  awaiting_verification: {
    label: 'awaiting payment verification',
    tone: 'warning',
    body:
      'A checkout exists for this account and no payment has been verified yet. The stored status of that checkout is ' +
      'not a payment: the plan stays free-entitled until verified evidence exists AND an operator authorizes the ' +
      'activation out of band.',
  },
  evidence_awaiting_activation: {
    label: 'evidence recorded · awaiting operator activation',
    tone: 'info',
    body:
      'Verified payment evidence has been recorded for this checkout. Evidence is a receipt, never an activation: the ' +
      'account stays on the free entitlement until an operator records the activation out of band. Nothing on this ' +
      'page can do that.',
  },
  activated: {
    label: 'activated',
    tone: 'success',
    body:
      'An operator authorized this subscription, so the server has a confirmed payment for the plan shown below and ' +
      'the paid entitlements are in force. Automation, live execution and broker execution remain unavailable on ' +
      'every plan.',
  },
  unknown: {
    label: 'billing state unknown',
    tone: 'warning',
    body:
      'The server holds a subscription record it cannot classify honestly — for example a record that needs operator ' +
      'review, or one that has no payment authority behind it. Nothing is claimed here: no plan, no renewal date and ' +
      'no cancellation state are shown, and nothing on this page can change that.',
  },
  unavailable: {
    label: 'billing unavailable',
    tone: 'danger',
    body:
      'The billing overview could not be read, so nothing is claimed, offered or confirmed. The entitlements that ' +
      'apply are the last ones the server enforced. Reload the page to read the overview again.',
  },
});

export interface BillingPortalPanelProps {
  /** The server summary, or `null` while it is loading / unreadable. */
  portal: BillingPortalSummaryDto | null;
  /** True when the read FAILED, as opposed to still being in flight. */
  unavailable?: boolean;
}

/** The facts the card states, each one derived from the DTO and nothing else. */
function portalDisplayFacts(portal: BillingPortalSummaryDto): {
  plan: string;
  renewal: { value: string; note: string };
  cancellation: { value: string; note: string };
} {
  const plan = portal.plan;
  const parsedPlan = plan === null ? null : getCommercialPlan(plan.cataloguePlan);

  const planLabel =
    plan === null || parsedPlan === null
      ? 'Not stated'
      : `${parsedPlan.name} · ${plan.interval === 'monthly' ? 'monthly' : 'annual'}`;

  // A renewal date is published ONLY when the server persisted one; a missing
  // one is stated as unavailable. Nothing here derives a date from the interval.
  const periodNote =
    portal.state === 'activated'
      ? 'The period end the server has stored for this subscription — never a date calculated from the billing interval.'
      : 'A stored period end, not yet in force: no activation fact confirms a paid period for this record.';

  const renewal =
    portal.periodEnd !== null
      ? { value: formatDateTime(portal.periodEnd), note: periodNote }
      : {
          value: 'Unavailable',
          note:
            portal.state === 'activated'
              ? 'The server has no stored period end for this subscription, and it does not calculate one from the billing interval.'
              : 'No paid period is in force and no period end is stored. The server does not infer a renewal date.',
        };

  const cancellation =
    portal.cancelAtPeriodEnd === null
      ? {
          value: 'Not stated',
          note: 'The server states no cancellation for this account.',
        }
      : portal.cancelAtPeriodEnd
        ? {
            value: 'Ends at period end',
            note: 'The authoritative subscription record says this subscription will not renew.',
          }
        : {
            value: 'Not scheduled to cancel',
            note: 'The server states no ending for this record; a renewal still requires an activated, paid period.',
          };

  return { plan: planLabel, renewal, cancellation };
}

/**
 * The read-only billing overview. Display only: no button, no link, no form, no
 * input and no API call live in this component.
 */
export function BillingPortalPanel({ portal, unavailable = false }: BillingPortalPanelProps) {
  if (!portal) {
    // A FAILED read is its own state. It is never presented as the free state
    // (nothing is known) and never as a payment state.
    if (unavailable) {
      const copy = BILLING_PORTAL_STATE_COPY.unavailable;
      return (
        <Card>
          <CardHeader
            title="Billing Overview"
            subtitle="Read-only · server-derived plan, interval and renewal"
            actions={<Badge tone={copy.tone}>{copy.label}</Badge>}
          />
          <div className="space-y-2 px-5 py-5 text-xs leading-snug text-ink-300">
            <p>{copy.body}</p>
            <p className="text-[11px] text-ink-500">
              No plan, renewal date or cancellation state is shown because none could be read — a failed read is not
              evidence of anything about this account.
            </p>
          </div>
        </Card>
      );
    }
    return (
      <Card>
        <CardHeader title="Billing Overview" subtitle="Read-only · server-derived plan, interval and renewal" />
        <div className="px-5 py-5 text-sm text-ink-400">Loading billing overview…</div>
      </Card>
    );
  }

  const copy = BILLING_PORTAL_STATE_COPY[portal.state];
  const facts = portalDisplayFacts(portal);

  return (
    <Card>
      <CardHeader
        title="Billing Overview"
        subtitle="Read-only · server-derived plan, interval and renewal"
        actions={<Badge tone={copy.tone}>{copy.label}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        <p className="text-xs leading-snug text-ink-300">{copy.body}</p>

        <dl className="grid gap-2 sm:grid-cols-3">
          <PortalFact label="Plan" value={facts.plan} note="Shown only when the server states a commercial plan." />
          <PortalFact
            label="Renewal"
            value={facts.renewal.value}
            note={facts.renewal.note}
          />
          <PortalFact
            label="Cancellation"
            value={facts.cancellation.value}
            note={facts.cancellation.note}
          />
        </dl>

        <div className="rounded-md border border-amber-450/20 bg-amber-450/5 px-3 py-2.5 text-[11px] leading-snug text-ink-400">
          <strong className="text-amber-450">Read-only overview:</strong> this panel only displays the server&rsquo;s
          answer — it offers no billing action at all, and nothing here charges, confirms or activates anything.
          Activation stays an out-of-band operator action, and{' '}
          <span className="font-mono text-ink-300">canAccessAutomation</span> remains false on every plan —
          automation, live execution and broker execution stay unavailable.
        </div>
      </div>
    </Card>
  );
}

function PortalFact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-md border border-ink-700 bg-ink-800 px-3 py-2.5">
      <dt className="text-[11px] uppercase tracking-wider text-ink-400">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-ink-50">{value}</dd>
      <dd className="mt-0.5 text-[11px] leading-snug text-ink-500">{note}</dd>
    </div>
  );
}
