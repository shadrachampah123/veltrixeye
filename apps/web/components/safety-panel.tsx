'use client';

import * as React from 'react';
import { Badge, Button, Card, CardHeader, Input } from '@/components/ui';
import type { KillSwitchEntryDto, KillSwitchEventDto, KillSwitchStatusDto } from '@veltrixeye/contracts';

/**
 * M8.6 — Safety controls panel (Trading page).
 *
 * Shows the account's full kill-switch picture and gives the user the brakes:
 *  - account-wide stop, per-strategy stops, per-profile stops (arm/clear with
 *    a required reason);
 *  - the platform global switch — DISPLAY ONLY (operator/environment only;
 *    when `EXECUTION_GLOBAL_KILL_SWITCH=true` it cannot be cleared anywhere);
 *  - the automatic loss-limit circuit breaker (armed by the risk engine,
 *    cleared only by an explicit, audited action here);
 *  - the emergency stop: one click (with confirm) arms the user switch,
 *    forces automation OFF and disables every execution profile;
 *  - the append-only switch history for this account.
 *
 * Deliberately NOT here: any "enable automation" control (entitlement-gated
 * server-side and refused while a switch is armed), anything live, and any
 * broker credential form. Every action in this panel can only ADD stops.
 */

const ACTIVE_LABEL = 'ARMED — execution refused';
const CLEAR_LABEL = 'clear';

export interface SafetyPanelProps {
  status: KillSwitchStatusDto | null;
  events: KillSwitchEventDto[];
  busy?: boolean;
  error?: string | null;
  notice?: string | null;
  onActivate?: (input: { scope: 'user' | 'strategy' | 'execution_profile'; targetId?: string; reason: string }) => Promise<void> | void;
  onClear?: (input: { scope: 'user' | 'strategy' | 'execution_profile'; targetId?: string; reason: string }) => Promise<void> | void;
  onEmergencyStop?: (reason: string) => Promise<void> | void;
  onRefresh?: () => Promise<void> | void;
}

function switchTone(entry: { active: boolean }): 'danger' | 'success' {
  return entry.active ? 'danger' : 'success';
}

function SwitchRow(props: {
  title: string;
  subtitle?: string;
  entry: { active: boolean; source: string; reason: string | null; activatedAt: string | null; updatedAt: string };
  readOnly?: boolean;
  onArm?: (reason: string) => void;
  onClear?: (reason: string) => void;
  disabled?: boolean;
}) {
  const { entry } = props;
  const [reason, setReason] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const canArm = !props.readOnly && !entry.active;
  const canClear = !props.readOnly && entry.active;
  const reasonOk = reason.trim().length >= 3;

  return (
    <div className="border-b border-ink-750 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-ink-100">{props.title}</p>
          {props.subtitle && <p className="text-xs text-ink-400">{props.subtitle}</p>}
          {entry.active && entry.reason && (
            <p className="mt-1 text-xs text-red-300/90">Reason: {entry.reason}</p>
          )}
          {entry.active && entry.source === 'circuit_breaker' && (
            <p className="mt-1 text-xs text-amber-300/90">
              Tripped automatically by the risk engine (loss-limit breach) — needs an explicit clear.
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge tone={switchTone(entry)}>{entry.active ? ACTIVE_LABEL : CLEAR_LABEL}</Badge>
          {!props.readOnly && (
            <div className="flex gap-2">
              {canArm && (
                <Button
                  variant="danger"
                  disabled={props.disabled}
                  onClick={() => {
                    if (!editing) setEditing(true);
                  }}
                >
                  Arm stop
                </Button>
              )}
              {canClear && (
                <Button variant="secondary" disabled={props.disabled} onClick={() => setEditing(true)}>
                  Clear stop
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {editing && !props.readOnly && (
        <div className="mt-2 flex items-center gap-2">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required, 3–400 chars)"
            className="flex-1"
            data-testid="safety-reason"
          />
          {canArm && (
            <Button
              variant="danger"
              disabled={!reasonOk || props.disabled}
              onClick={() => {
                if (!reasonOk) return;
                props.onArm?.(reason.trim());
                setReason('');
                setEditing(false);
              }}
            >
              Confirm arm
            </Button>
          )}
          {canClear && (
            <Button
              variant="secondary"
              disabled={!reasonOk || props.disabled}
              onClick={() => {
                if (!reasonOk) return;
                props.onClear?.(reason.trim());
                setReason('');
                setEditing(false);
              }}
            >
              Confirm clear
            </Button>
          )}
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  if (iso.startsWith('1970-01-01')) return 'never';
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return iso;
  }
}

export function SafetyPanel(props: SafetyPanelProps) {
  const { status, events } = props;
  const [confirmStop, setConfirmStop] = React.useState(false);
  const [stopReason, setStopReason] = React.useState('');

  const entry = (fallback: Partial<KillSwitchEntryDto>): KillSwitchEntryDto | undefined =>
    (fallback as KillSwitchEntryDto) ?? undefined;

  return (
    <Card>
      <CardHeader
        title="Safety controls (M8.6)"
        subtitle="Kill switches, automatic circuit breakers and the emergency stop — arming refuses new execution, clearing is always audited"
        actions={
          props.onRefresh ? (
            <Button variant="ghost" onClick={() => void props.onRefresh?.()} disabled={props.busy}>
              Refresh
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-3 px-5 pb-5 text-sm">
        {props.error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {props.error}
          </p>
        )}
        {props.notice && (
          <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            {props.notice}
          </p>
        )}

        <div className="flex items-center justify-between text-xs text-ink-400">
          <span>Safety version</span>
          <span>{status?.safetyVersion ?? 'm8.6-safety-controls-1'}</span>
        </div>

        {/* Emergency stop */}
        <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <p className="text-ink-100">Emergency stop</p>
          <p className="mt-1 text-xs text-ink-400">
            Arms the account kill switch, forces the automation switch OFF and disables every execution
            profile in one step. Closing positions stays available — a stop never strands exposure.
          </p>
          {!confirmStop ? (
            <div className="mt-2">
              <Button variant="danger" disabled={props.busy} onClick={() => setConfirmStop(true)}>
                EMERGENCY STOP
              </Button>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <Input
                value={stopReason}
                onChange={(e) => setStopReason(e.target.value)}
                placeholder="Reason (optional) — e.g. incident, review, data quality"
                data-testid="emergency-reason"
              />
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={props.busy}
                  onClick={() => {
                    void props.onEmergencyStop?.(stopReason.trim() || 'Emergency stop requested from the account UI');
                    setConfirmStop(false);
                    setStopReason('');
                  }}
                >
                  Confirm — stop everything now
                </Button>
                <Button variant="ghost" onClick={() => setConfirmStop(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Global switch (display only) */}
        <SwitchRow
          title="Global platform kill switch"
          subtitle={
            status?.globalForcedByEnvironment
              ? 'Pinned ON by the deployment environment — cannot be cleared through the API'
              : 'Platform-wide stop — operator-controlled; accounts can only stop themselves'
          }
          entry={
            status ? status.global : entry({ active: false, source: 'operator', reason: null, activatedAt: null, updatedAt: '1970-01-01T00:00:00.000Z' })!
          }
          readOnly
        />

        {/* Account switch */}
        <SwitchRow
          title="Account kill switch"
          subtitle={
            status?.circuitBreaker.active
              ? `Circuit breaker armed${status.circuitBreaker.trippedAt ? ` at ${formatWhen(status.circuitBreaker.trippedAt)}` : ''}`
              : 'Stops every new simulated/automated execution for this account'
          }
          entry={
            status ? status.user : entry({ active: false, source: 'operator', reason: null, activatedAt: null, updatedAt: '1970-01-01T00:00:00.000Z' })!
          }
          disabled={props.busy}
          onArm={(reason) => void props.onActivate?.({ scope: 'user', reason })}
          onClear={(reason) => void props.onClear?.({ scope: 'user', reason })}
        />

        {/* Strategy switches */}
        {status && status.strategies.length > 0 && (
          <div className="space-y-0">
            <p className="pt-1 text-xs uppercase tracking-wide text-ink-400">Per strategy</p>
            {status.strategies.map((s) => (
              <SwitchRow
                key={s.strategyId}
                title={s.entityLabel ?? 'Strategy'}
                entry={{ active: s.active, source: s.source, reason: s.reason, activatedAt: s.activatedAt, updatedAt: s.updatedAt }}
                disabled={props.busy}
                onArm={(reason) => void props.onActivate?.({ scope: 'strategy', targetId: s.strategyId, reason })}
                onClear={(reason) => void props.onClear?.({ scope: 'strategy', targetId: s.strategyId, reason })}
              />
            ))}
          </div>
        )}

        {/* Profile switches */}
        {status && status.profiles.length > 0 && (
          <div className="space-y-0">
            <p className="pt-1 text-xs uppercase tracking-wide text-ink-400">Per execution profile</p>
            {status.profiles.map((p) => (
              <SwitchRow
                key={p.executionProfileId}
                title={`${p.providerSlug} (${p.environment})`}
                entry={{ active: p.active, source: p.source, reason: p.reason, activatedAt: p.activatedAt, updatedAt: p.updatedAt }}
                disabled={props.busy}
                onArm={(reason) => void props.onActivate?.({ scope: 'execution_profile', targetId: p.executionProfileId, reason })}
                onClear={(reason) => void props.onClear?.({ scope: 'execution_profile', targetId: p.executionProfileId, reason })}
              />
            ))}
          </div>
        )}

        {/* Automation summary */}
        {status && (
          <div className="flex items-center justify-between border-t border-ink-750 pt-3">
            <span className="text-ink-300">Automation effective state</span>
            <Badge tone={status.automation.effective ? 'danger' : 'neutral'}>
              {status.automation.effective ? 'ON' : 'OFF (all brakes hold)'}
            </Badge>
          </div>
        )}

        {/* History */}
        <div className="border-t border-ink-750 pt-3">
          <p className="text-xs uppercase tracking-wide text-ink-400">Switch history (append-only)</p>
          {events.length === 0 && <p className="mt-2 text-xs text-ink-400">No switch changes recorded.</p>}
          <ul className="mt-2 space-y-1">
            {events.slice(0, 12).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-ink-200">
                  {e.scope}
                  {e.entityLabel ? ` · ${e.entityLabel}` : ''} — {e.action} via {e.source}
                  {!e.changed ? ' (no change)' : ''}
                  {e.reason ? <span className="text-ink-400"> — “{e.reason}”</span> : null}
                </span>
                <span className="shrink-0 text-ink-400">{formatWhen(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-400">
          Kill switches refuse NEW entries (automation gates + paper simulation). Position exits and
          risk-reducing actions remain available while armed. Clearing an armed switch requires a reason
          and is recorded in the append-only ledger. Paper results remain simulations — nothing here
          trades real money, and live execution remains impossible by construction.
        </p>
      </div>
    </Card>
  );
}
