'use client';

import * as React from 'react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { RequireAuth } from '@/components/auth-context';
import { api, ApiError } from '@/lib/api';
import { Card, CardHeader, Badge, Spinner, Button } from '@/components/ui';
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
  ReconciliationFindingDto,
  ReconciliationRunDto,
  ReconciliationStatusDto,
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
  const [reconStatus, setReconStatus] = React.useState<ReconciliationStatusDto | null>(null);
  const [reconRuns, setReconRuns] = React.useState<ReconciliationRunDto[]>([]);
  const [reconFindings, setReconFindings] = React.useState<ReconciliationFindingDto[]>([]);
  const [reconBusy, setReconBusy] = React.useState(false);
  const [reconError, setReconError] = React.useState<string | null>(null);
  const [reconNotice, setReconNotice] = React.useState<string | null>(null);
  const [paperSetupId, setPaperSetupId] = React.useState('');
  const [paperProfileId, setPaperProfileId] = React.useState('');
  const [paperBusy, setPaperBusy] = React.useState(false);
  const [paperError, setPaperError] = React.useState<string | null>(null);
  const [paperNotice, setPaperNotice] = React.useState<string | null>(null);

  const loadReconciliation = React.useCallback(async () => {
    const [rs, rr, rf] = await Promise.all([
      api.getReconciliationStatus(),
      api.listReconciliationRuns({ limit: 10 }),
      api.listReconciliationFindings({ limit: 25, state: 'open' }),
    ]);
    setReconStatus(rs);
    setReconRuns(rr.runs);
    setReconFindings(rf.findings);
  }, []);

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
        try {
          await loadReconciliation();
        } catch {
          // Surface still renders without reconciliation data.
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

  const runReconcile = async (profileId: string) => {
    if (!profileId) {
      setReconError('Select a paper execution profile first.');
      return;
    }
    setReconBusy(true);
    setReconError(null);
    setReconNotice(null);
    try {
      await api.triggerReconciliationRun({ executionProfileId: profileId, trigger: 'manual' });
      await loadReconciliation();
      setReconNotice('Reconciliation run complete. No corrective actions were taken.');
    } catch (e) {
      setReconError(e instanceof Error ? e.message : 'Reconciliation failed');
    } finally {
      setReconBusy(false);
    }
  };

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
              subtitle="Provider-neutral registry — paper is internal; MT5 is an unavailable integration boundary"
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
                MT5/Exness-compatible configuration is modeled without a broker transport.
                Connection status is never inferred from configuration. No real or broker-demo
                order can be placed from this platform today.
              </p>
            </div>
          </Card>

          {/* Profiles */}
          <Card>
            <CardHeader
              title="Execution & broker profiles"
              subtitle="Paper simulation and disabled MT5 demo connection metadata"
            />
            <div className="space-y-3 px-5 pb-5 text-sm">
              {profiles !== null && profiles.length === 0 && (
                <p className="text-ink-400">No execution profiles yet.</p>
              )}
              {profiles?.map((profile) => (
                <div key={profile.id} className="flex items-center justify-between">
                  <span className="capitalize">
                    {profile.mode} <span className="text-xs text-ink-400">via {profile.providerSlug}</span>
                    {profile.brokerServer ? <span className="block text-xs text-ink-400">{profile.brokerServer} · {profile.accountRef} · {profile.connectionStatus}</span> : null}
                    {profile.symbolMappings.length > 0 ? <span className="block text-xs text-ink-400">{profile.symbolMappings.length} explicit symbol mapping(s)</span> : null}
                  </span>
                  <Badge tone={profile.enabled ? 'success' : 'neutral'}>
                    {profile.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </div>
              ))}
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <strong>Live trading unavailable in M8.4.</strong> Broker profiles contain only
                non-secret references and explicit symbol mappings. Credentials are not accepted
                or stored, and the MT5 transport is disabled.
              </p>
            </div>
          </Card>

          {/* M8.5 Reconciliation status */}
          <Card>
            <CardHeader
              title="Order & position reconciliation (M8.5)"
              subtitle="Provider-neutral comparison between internal state and provider state. Fail-closed; no automatic repair."
              actions={
                <Badge
                  tone={
                    reconStatus?.healthState === 'synchronized'
                      ? 'success'
                      : reconStatus?.healthState === 'provider_unavailable'
                        ? 'neutral'
                        : reconStatus?.healthState === 'uncertain'
                          ? 'warning'
                          : 'danger'
                  }
                >
                  {reconStatus?.healthState ?? 'initializing'}
                </Badge>
              }
            />
            <div className="space-y-3 px-5 pb-5 text-sm">
              <div className="grid gap-2 sm:grid-cols-4">
                <div>
                  <div className="text-xs text-ink-400">Open findings</div>
                  <div className="text-lg">{reconStatus?.openFindings ?? 0}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-400">Total runs</div>
                  <div className="text-lg">{reconStatus?.totalRuns ?? 0}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-400">Last run</div>
                  <div className="text-sm">
                    {reconStatus?.lastRun
                      ? new Date(reconStatus.lastRun.startedAt).toLocaleString()
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ink-400">Corrective actions</div>
                  <div className="text-lg">disabled</div>
                </div>
              </div>
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <strong>Safety gates active.</strong> Reconciliation never creates, cancels or
                closes orders automatically. Uncertain outcomes remain uncertain until an
                operator acknowledges them; provider unavailability fails closed.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <Button
                  onClick={() => void runReconcile(paperProfileId)}
                  disabled={reconBusy || !paperProfileId}
                >
                  Run reconciliation
                </Button>
              </div>
              {reconError && <p className="text-xs text-red-400">{reconError}</p>}
              {reconNotice && <p className="text-xs text-emerald-400">{reconNotice}</p>}

              {reconFindings.length > 0 && (
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">
                    Findings requiring attention
                  </div>
                  <ul className="space-y-1 text-xs">
                    {reconFindings.slice(0, 10).map((f) => (
                      <li key={f.id} className="flex items-start justify-between gap-2">
                        <span className="text-red-400">{f.code}</span>
                        <span className="text-ink-400">
                          {f.scope}
                          {f.resolutionState !== 'open' ? ` · ${f.resolutionState}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {reconRuns.length > 0 && (
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">
                    Recent runs
                  </div>
                  <ul className="space-y-1 text-xs">
                    {reconRuns.slice(0, 5).map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-2">
                        <span className="text-ink-300">{r.providerId} · {r.trigger}</span>
                        <span
                          className={
                            r.healthState === 'synchronized'
                              ? 'text-emerald-400'
                              : r.healthState === 'uncertain'
                                ? 'text-amber-400'
                                : r.healthState === 'provider_unavailable'
                                  ? 'text-ink-400'
                                  : 'text-red-400'
                          }
                        >
                          {r.healthState} · {r.summary.findingsOpen} open
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
              profileOptions={(profiles ?? []).filter((profile) => profile.providerSlug === 'paper').map((profile) => ({
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
