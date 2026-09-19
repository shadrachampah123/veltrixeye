'use client';

import * as React from 'react';
import { Badge, Card, CardHeader } from '@/components/ui';
import type { BillingStateDto } from '@veltrixeye/contracts';
import { BRAND } from '@/lib/brand';
import { formatDateTime } from '@/lib/formats';

export function SubscriptionPanel({ billing }: { billing: BillingStateDto | null }) {
  if (!billing) {
    return (
      <Card>
        <CardHeader title="Subscription" subtitle="Entitlement & plan limits" />
        <div className="px-5 py-6 text-sm text-ink-400">Loading billing state…</div>
      </Card>
    );
  }

  const ent = billing.entitlements;
  const sub = billing.subscription;

  return (
    <Card>
      <CardHeader
        title="Subscription & Entitlements"
        subtitle="Plan foundations — server-authoritative, no client-side bypass"
        actions={<Badge tone={sub.status === 'active' ? 'success' : 'warning'}>{sub.status}</Badge>}
      />
      <div className="space-y-5 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-signal-600/20 text-signal-400 font-semibold">{sub.plan.slice(0, 2).toUpperCase()}</div>
          <div>
            <div className="text-sm font-semibold capitalize text-ink-50">{sub.plan} plan</div>
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

        <div className="rounded-md border border-amber-450/20 bg-amber-450/5 px-3 py-2.5 text-[11px] leading-snug text-ink-400">
          <strong className="text-amber-450">Entitlement foundation:</strong> All limits are enforced server-side. The UI never grants access — it only displays what the API returns. M8.7 safety controls (drawdown protection, kill-switch, automation OFF) remain active regardless of plan.
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

export function PlanComparison({ currentPlan }: { currentPlan: string }) {
  const plans = [
    { id: 'free', name: 'Free', price: '$0', features: ['3 strategies', '10 backtests/mo', '5 alerts/mo', 'Scanner: No', 'Automation: No'] },
    { id: 'starter', name: 'Starter', price: '$29', features: ['10 strategies', '100 backtests/mo', '50 alerts/mo', 'Scanner: Yes', 'Automation: No'] },
    { id: 'pro', name: 'Pro', price: '$99', features: ['Unlimited strategies', 'Unlimited backtests', 'Unlimited alerts', 'Scanner: Yes', 'Automation: Paper only'] },
  ];
  return (
    <Card>
      <CardHeader title="Plan Comparison" subtitle="Foundation for future subscription UI — no payment flow yet" />
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = plan.id === currentPlan;
          return (
            <div key={plan.id} className={`rounded-lg border p-4 ${isCurrent ? 'border-signal-500/50 bg-signal-500/5' : 'border-ink-700 bg-ink-800'}`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink-50">{plan.name}</span>
                {isCurrent && <Badge tone="success">Current</Badge>}
              </div>
              <div className="mt-1 font-mono text-lg text-ink-100">{plan.price}<span className="text-xs text-ink-400">/mo</span></div>
              <ul className="mt-3 space-y-1 text-xs text-ink-400">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-1.5"><span className="text-signal-500">✓</span> {f}</li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
