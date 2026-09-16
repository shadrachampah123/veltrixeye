'use client';

import * as React from 'react';
import { Badge, Button, Card, CardHeader, Field, Input } from '@/components/ui';
import type { PlatformRiskCeilingsDto, RiskAccountSnapshotDto, RiskPolicyDto } from '@veltrixeye/contracts';

/**
 * M8.2 — minimum risk-settings surface.
 *
 * Distinguishes **User Risk Setting** from **Platform Safety Limit**.
 * The client cannot weaken a ceiling: the API rejects out-of-envelope
 * values. No live-trading button, no broker credential form, no order
 * execution UI. Automation stays OFF.
 */

export interface RiskPolicyPanelProps {
  policy: RiskPolicyDto;
  ceilings: PlatformRiskCeilingsDto;
  account: RiskAccountSnapshotDto;
  engineVersion: string;
  saving?: boolean;
  error?: string | null;
  notice?: string | null;
  onSave?: (patch: { riskPctPerTrade: number; minRr: number; paperEquity: number }) => void;
}

function Row(props: { label: string; user: string; ceiling: string }) {
  return (
    <div className="grid grid-cols-3 gap-2 border-b border-ink-750 py-2 text-sm last:border-0">
      <span className="text-ink-300">{props.label}</span>
      <span className="text-ink-100">
        <span className="mr-1 text-[10px] uppercase tracking-wide text-ink-400">User Risk Setting</span>
        {props.user}
      </span>
      <span className="text-ink-100">
        <span className="mr-1 text-[10px] uppercase tracking-wide text-ink-400">Platform Safety Limit</span>
        {props.ceiling}
      </span>
    </div>
  );
}

export function RiskPolicyPanel(props: RiskPolicyPanelProps) {
  const { policy, ceilings, account, engineVersion } = props;
  const [riskPct, setRiskPct] = React.useState(String(policy.riskPctPerTrade));
  const [minRr, setMinRr] = React.useState(String(policy.minRr));
  const [equity, setEquity] = React.useState(String(policy.paperEquity));

  return (
    <Card>
      <CardHeader
        title="Risk policy"
        subtitle="Server-authoritative — user settings cannot exceed platform safety limits"
      />
      <div className="space-y-4 px-5 pb-5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-ink-300">Engine</span>
          <Badge tone="neutral">{engineVersion}</Badge>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-ink-300">Policy</span>
          <Badge tone={policy.enabled ? 'success' : 'danger'}>
            {policy.enabled ? 'enabled' : 'disabled'} · v{policy.policyVersion}
          </Badge>
        </div>

        <div className="rounded-md border border-ink-700">
          <div className="grid grid-cols-3 gap-2 border-b border-ink-700 bg-ink-800 px-3 py-2 text-[10px] uppercase tracking-wide text-ink-400">
            <span>Control</span>
            <span>User Risk Setting</span>
            <span>Platform Safety Limit</span>
          </div>
          <div className="px-3">
            <Row label="Risk % / trade" user={`${policy.riskPctPerTrade}%`} ceiling={`${ceilings.maxRiskPctPerTrade}%`} />
            <Row
              label="Max $ risk / trade"
              user={policy.maxMonetaryRiskPerTrade === null ? 'policy % only' : String(policy.maxMonetaryRiskPerTrade)}
              ceiling={String(ceilings.maxMonetaryRiskPerTrade)}
            />
            <Row label="Daily loss %" user={`${policy.maxDailyLossPct}%`} ceiling={`${ceilings.maxDailyLossPct}%`} />
            <Row label="Weekly loss %" user={`${policy.maxWeeklyLossPct}%`} ceiling={`${ceilings.maxWeeklyLossPct}%`} />
            <Row
              label="Consecutive losses"
              user={String(policy.maxConsecutiveLosses)}
              ceiling={String(ceilings.maxConsecutiveLosses)}
            />
            <Row
              label="Simultaneous positions"
              user={String(policy.maxSimultaneousPositions)}
              ceiling={String(ceilings.maxSimultaneousPositions)}
            />
            <Row
              label="Total open risk %"
              user={`${policy.maxTotalOpenRiskPct}%`}
              ceiling={`${ceilings.maxTotalOpenRiskPct}%`}
            />
            <Row label="Minimum RR" user={`1:${policy.minRr}`} ceiling={`1:${ceilings.minRr} (floor)`} />
            <Row
              label="Max position size"
              user="sized by the engine"
              ceiling={String(ceilings.maxPositionSize)}
            />
          </div>
        </div>

        <div className="rounded-md border border-ink-700 px-3 py-3">
          <p className="mb-2 text-xs uppercase tracking-wide text-ink-400">Paper account (simulation only)</p>
          <div className="flex items-center justify-between">
            <span className="text-ink-300">Paper equity</span>
            <span>{account.equity}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-300">Daily realized P&amp;L</span>
            <span>{account.dailyRealizedPl}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-300">Weekly realized P&amp;L</span>
            <span>{account.weeklyRealizedPl}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-300">Consecutive losses</span>
            <span>{account.consecutiveLosses}</span>
          </div>
          <p className="mt-2 text-xs text-ink-400">
            Paper equity is a simulation parameter bounded by the platform
            ({ceilings.minPaperEquity}–{ceilings.maxPaperEquity}). It is not a live
            broker balance and cannot authorize real orders.
          </p>
        </div>

        {props.onSave && (
          <div className="space-y-3 rounded-md border border-ink-700 px-3 py-3">
            <p className="text-xs uppercase tracking-wide text-ink-400">Adjust settings (within platform limits)</p>
            {props.error && (
              <p className="text-sm text-red-400" role="alert">
                {props.error}
              </p>
            )}
            {props.notice && (
              <p className="text-sm text-ink-200" role="status">
                {props.notice}
              </p>
            )}
            <Field label="Risk % per trade" hint={`Maximum ${ceilings.maxRiskPctPerTrade}%`}>
              <Input
                type="number"
                step="0.01"
                min={0.01}
                max={ceilings.maxRiskPctPerTrade}
                value={riskPct}
                onChange={(e) => setRiskPct(e.target.value)}
              />
            </Field>
            <Field label="Minimum RR" hint={`Floor 1:${ceilings.minRr} — higher is stricter`}>
              <Input
                type="number"
                step="0.1"
                min={ceilings.minRr}
                max={100}
                value={minRr}
                onChange={(e) => setMinRr(e.target.value)}
              />
            </Field>
            <Field
              label="Paper equity"
              hint={`${ceilings.minPaperEquity}–${ceilings.maxPaperEquity} (simulation)`}
            >
              <Input
                type="number"
                step="1"
                min={ceilings.minPaperEquity}
                max={ceilings.maxPaperEquity}
                value={equity}
                onChange={(e) => setEquity(e.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                onClick={() =>
                  props.onSave?.({
                    riskPctPerTrade: Number(riskPct),
                    minRr: Number(minRr),
                    paperEquity: Number(equity),
                  })
                }
                disabled={props.saving}
              >
                {props.saving ? 'Saving…' : 'Save risk settings'}
              </Button>
            </div>
          </div>
        )}

        <p className="text-xs text-ink-400">
          No real, demo or paper orders are executed by this milestone. Risk
          approval is not permission to trade. Automation remains OFF. There is
          no live trading button and no broker credential form.
        </p>
      </div>
    </Card>
  );
}
