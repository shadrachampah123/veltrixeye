'use client';

import * as React from 'react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, Badge, Spinner } from '@/components/ui';
import { RiskPolicyPanel } from '@/components/risk-policy-panel';
import { PaperExecutionPanel } from '@/components/paper-execution-panel';
import type {
  ExecutionStatusDto,
  ExecutionProfileDto,
  PaperFillDto,
  PaperOrderDto,
  PaperPositionDto,
  PaperStatusDto,
  ReconciliationDto,
  RiskPolicyStatusDto,
} from '@veltrixeye/contracts';

/**
 * Trading (M8.1) — execution READINESS only.
 *
 * Deliberately minimal and read-only:
 *  - shows the server-authoritative automation state (OFF by default and for
 *    every plan in M8.1) and why;
 *  - shows registered execution providers and their honest health (M8.3: the
 *    internal paper SIMULATOR is ready; there is still no broker);
 *  - lists the caller's execution profiles (paper only);
 *  - M8.3 adds the paper-execution panel: simulate a server-issued decision,
 *    see simulated orders/positions/fills, entry/exit prices, open and closed
 *    simulated P&L and the reconciliation trail.
 *
 * Intentionally NOT here (per the M8.1/M8.2/M8.3 boundary): no "Enable Live
 * Trading" button, no broker credential forms, no live/demo-account
 * connection, no MT5/Exness configuration and no control capable of placing a
 * real order. Every paper action is a request to the INTERNAL simulator.
 */
function TradingContent() {
  const [status, setStatus] = React.useState<ExecutionStatusDto | null>(null);
  const [profiles, setProfiles] = React.useState<ExecutionProfileDto[] | null>(null);
  const [risk, setRisk] = React.useState<RiskPolicyStatusDto | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [riskSaving, setRiskSaving] = React.useState(false);
  const [riskError, setRiskError] = React.useState<string | null>(null);
  const [riskNotice, setRiskNotice] = React.useState<string | null>(null);
  const [paperStatus, setPaperStatus] = React.useState<PaperStatusDto | null>(null);
  const [paperOrders, setPaperOrders] = React.useState<PaperOrderDto[]>([]);
  const [paperPositions, setPaperPositions] = React.useState<PaperPositionDto[]>([]);
  const [paperFills, setPaperFills] = React.useState<PaperFillDto[]>([]);
  const [paperReconciliations, setPaperReconciliations] = React.useState<ReconciliationDto[]>([]);
  const [paperSetupId, setPaperSetupId] = React.useState('');
  const [paperProfileId, setPaperProfileId] = React.useState('');
  const [paperBusy, setPaperBusy] = React.useState(false);
  const [paperError, setPaperError] = React.useState<string | null>(null);
  const [paperNotice, setPaperNotice] = React.useState<string | null>(null);

  const loadPaper = React.useCallback(async () => {
    const [ps, po, pp, pf, pr] = await Promise.all([
      api.getPaperStatus(),
      api.listPaperOrders({ limit: 25 }),
      api.listPaperPositions({ limit: 25 }),
      api.listPaperFills({ limit: 25 }),
      api.listPaperReconciliations({ limit: 25 }),
    ]);
    setPaperStatus(ps);
    setPaperOrders(po.orders);
    setPaperPositions(pp.positions);
    setPaperFills(pf.fills);
    setPaperReconciliations(pr.reconciliations);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, p, r] = await Promise.all([
          api.getExecutionStatus(),
          api.listExecutionProfiles(),
          api.getRiskPolicy(),
        ]);
        if (cancelled) return;
        setStatus(s);
        setProfiles(p.profiles);
        setRisk(r);
        setError(null);
        try {
          await loadPaper();
        } catch {
          // The readiness surface still renders when the paper panel cannot load.
        }
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

  const saveRisk = async (patch: { riskPctPerTrade: number; minRr: number; paperEquity: number }) => {
    setRiskSaving(true);
    setRiskError(null);
    setRiskNotice(null);
    try {
      const next = await api.updateRiskPolicy(patch);
      setRisk(next);
      setRiskNotice('Risk settings saved. Platform safety limits still apply.');
    } catch (e) {
      setRiskError(e instanceof ApiError ? e.message : 'Failed to save risk settings');
    } finally {
      setRiskSaving(false);
    }
  };

  const runPaper = async (action: () => Promise<unknown>, notice: string) => {
    setPaperBusy(true);
    setPaperError(null);
    setPaperNotice(null);
    try {
      await action();
      await loadPaper();
      setPaperNotice(notice);
    } catch (e) {
      setPaperError(e instanceof ApiError ? e.message : 'Paper simulation failed');
    } finally {
      setPaperBusy(false);
    }
  };

  const simulate = () =>
    runPaper(
      () =>
        api.simulatePaperExecution({
          setupId: paperSetupId.trim(),
          executionProfileId: paperProfileId,
        }),
      'Simulation complete. Results are simulated, not broker fills.',
    );

  const evaluate = () =>
    runPaper(
      () => api.evaluatePaperPositions(),
      'Open simulated positions evaluated against server market data.',
    );

  const closePaperPosition = (positionId: string) =>
    runPaper(
      () => api.closePaperPosition(positionId),
      'Simulated position closed at the server price.',
    );

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

          <div className="lg:col-span-2">
            <PaperExecutionPanel
              status={paperStatus}
              orders={paperOrders}
              positions={paperPositions}
              fills={paperFills}
              reconciliations={paperReconciliations}
              setupId={paperSetupId}
              onSetupIdChange={setPaperSetupId}
              profileOptions={(profiles ?? []).map((profile) => ({
                id: profile.id,
                label: `${profile.mode} · ${profile.providerSlug}`,
              }))}
              selectedProfileId={paperProfileId}
              onProfileChange={setPaperProfileId}
              onSimulate={() => void simulate()}
              onEvaluate={() => void evaluate()}
              onClosePosition={(id) => void closePaperPosition(id)}
              busy={paperBusy}
              error={paperError}
              notice={paperNotice}
            />
          </div>

          {risk && (
            <div className="lg:col-span-2">
              <RiskPolicyPanel
                policy={risk.policy}
                ceilings={risk.platformCeilings}
                account={risk.account}
                engineVersion={risk.engineVersion}
                saving={riskSaving}
                error={riskError}
                notice={riskNotice}
                onSave={(patch) => void saveRisk(patch)}
              />
            </div>
          )}
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
