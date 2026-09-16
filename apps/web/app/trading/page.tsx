'use client';

import * as React from 'react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api } from '@/lib/api';
import { Card, CardHeader, Badge, Spinner } from '@/components/ui';
import type { ExecutionStatusDto, ExecutionProfileDto } from '@veltrixeye/contracts';

/**
 * Trading (M8.1) — execution READINESS only.
 *
 * Deliberately minimal and read-only:
 *  - shows the server-authoritative automation state (OFF by default and for
 *    every plan in M8.1) and why;
 *  - shows registered execution providers and their honest health (paper is
 *    "not ready" until the simulator ships);
 *  - lists the caller's execution profiles (paper only).
 *
 * Intentionally NOT here (per the M8.1 boundary): no "Enable Live Trading"
 * button, no broker credential forms, no live trading dashboard, and no
 * control capable of submitting an order.
 */
function TradingContent() {
  const [status, setStatus] = React.useState<ExecutionStatusDto | null>(null);
  const [profiles, setProfiles] = React.useState<ExecutionProfileDto[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, p] = await Promise.all([api.getExecutionStatus(), api.listExecutionProfiles()]);
        if (cancelled) return;
        setStatus(s);
        setProfiles(p.profiles);
        setError(null);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load execution status');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell>
      <PageHeader
        title="Trading"
        subtitle="Execution architecture status — automated trading is being built behind explicit safety gates"
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && !status ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Automation state */}
          <Card>
            <CardHeader
              title="Automation"
              subtitle="Server-authoritative — entitlement and your explicit switch must both allow it"
            />
            <div className="space-y-3 px-5 pb-5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-300">Automated execution</span>
                <Badge tone={status?.automation.effective ? 'success' : 'neutral'}>
                  {status?.automation.effective ? 'ON' : 'OFF'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-300">Plan entitlement</span>
                <Badge tone={status?.automation.entitled ? 'success' : 'neutral'}>
                  {status?.automation.entitled ? 'included' : 'not included'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-300">Automation switch</span>
                <Badge tone={status?.automation.automationEnabled ? 'success' : 'neutral'}>
                  {status?.automation.automationEnabled ? 'on' : 'off'}
                </Badge>
              </div>
              {status && status.automation.reasons.length > 0 && (
                <p className="text-xs text-ink-400">
                  Why OFF: {status.automation.reasons.join(', ')}
                </p>
              )}
              <p className="text-xs text-ink-400">
                Automation cannot be enabled by API requests alone; it requires a plan
                entitlement and passes emergency kill-switch checks before any execution.
              </p>
            </div>
          </Card>

          {/* Safety state */}
          <Card>
            <CardHeader
              title="Safety"
              subtitle="Emergency stop state — an active switch refuses all new execution"
            />
            <div className="space-y-3 px-5 pb-5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-300">Global kill switch</span>
                <Badge tone={status?.automation.globalKillSwitch ? 'danger' : 'success'}>
                  {status?.automation.globalKillSwitch ? 'ACTIVE' : 'clear'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-300">Account kill switch</span>
                <Badge tone={status?.automation.userKillSwitch ? 'danger' : 'success'}>
                  {status?.automation.userKillSwitch ? 'ACTIVE' : 'clear'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-300">Execution readiness</span>
                <Badge tone="neutral">not active (foundation milestone)</Badge>
              </div>
            </div>
          </Card>

          {/* Providers */}
          <Card>
            <CardHeader
              title="Execution providers"
              subtitle="Registered server-side; no broker connectivity exists in this milestone"
            />
            <div className="space-y-3 px-5 pb-5 text-sm">
              {status && status.providers.length === 0 && (
                <p className="text-ink-400">No execution providers registered.</p>
              )}
              {status?.providers.map((p) => (
                <div key={p.id} className="flex items-center justify-between">
                  <span>
                    {p.name} <span className="text-xs text-ink-400">({p.id})</span>
                  </span>
                  <Badge tone={p.healthy ? 'success' : 'neutral'}>
                    {p.healthy ? 'ready' : p.reason ?? 'not ready'}
                  </Badge>
                </div>
              ))}
              <p className="text-xs text-ink-400">
                Paper execution simulation, demo and broker connectivity arrive in later
                milestones. No real or demo orders can be placed from this platform today.
              </p>
            </div>
          </Card>

          {/* Profiles */}
          <Card>
            <CardHeader
              title="Execution profiles"
              subtitle="Account configuration — paper only in this milestone"
            />
            <div className="space-y-3 px-5 pb-5 text-sm">
              {profiles !== null && profiles.length === 0 && (
                <p className="text-ink-400">No execution profiles yet.</p>
              )}
              {profiles?.map((profile) => (
                <div key={profile.id} className="flex items-center justify-between">
                  <span className="capitalize">
                    {profile.mode} <span className="text-xs text-ink-400">via {profile.providerSlug}</span>
                  </span>
                  <Badge tone={profile.enabled ? 'success' : 'neutral'}>
                    {profile.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </div>
              ))}
              <p className="text-xs text-ink-400">
                Live profiles are impossible in this platform version; credentials are never
                stored — provider connectivity is configured server-side only.
              </p>
            </div>
          </Card>
        </div>
      )}
    </AppShell>
  );
}

export default function TradingPage() {
  return (
    <RequireAuth>
      <TradingContent />
    </RequireAuth>
  );
}
