'use client';

import * as React from 'react';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import type {
  PaperFillDto,
  PaperOrderDto,
  PaperPositionDto,
  PaperStatusDto,
  ReconciliationDto,
} from '@veltrixeye/contracts';

/**
 * M8.3 — paper execution panel.
 *
 * A SIMULATION-ONLY surface. It renders what the internal paper simulator did
 * with server-issued decisions and makes the safety boundary explicit:
 *
 *  - the only actions are "simulate this setup", "evaluate open positions"
 *    (apply SL/TP from server market data) and "close this simulated position";
 *  - there is no live-trading control, no broker/demo-connection form, no
 *    credential field and no way to submit an order to an external venue —
 *    nothing here can reach a broker because nothing in the platform can;
 *  - every number shown (entry, exit, P&L, mark) is server-computed; this
 *    component only displays it.
 */
export interface PaperExecutionPanelProps {
  status: PaperStatusDto | null;
  orders: readonly PaperOrderDto[];
  positions: readonly PaperPositionDto[];
  fills: readonly PaperFillDto[];
  reconciliations: readonly ReconciliationDto[];
  /** Stable id of the setup to simulate (server-issued record). */
  setupId: string;
  onSetupIdChange: (value: string) => void;
  profileOptions: readonly { id: string; label: string }[];
  selectedProfileId: string;
  onProfileChange: (value: string) => void;
  onSimulate: () => void;
  onEvaluate: () => void;
  onClosePosition: (positionId: string) => void;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

const pl = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`;

const price = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toFixed(5);

export function PaperExecutionPanel(props: PaperExecutionPanelProps) {
  const { status } = props;
  const open = props.positions.filter((p) => p.status === 'open');
  const closed = props.positions.filter((p) => p.status === 'closed');
  const latest = props.reconciliations[0] ?? null;

  return (
    <Card>
      <CardHeader
        title="Paper execution (simulation)"
        subtitle="Internal simulator only — no broker, no MT5/Exness, no live or demo account"
        actions={
          <Badge tone={status?.providerHealthy ? 'success' : 'neutral'}>
            {status?.providerHealthy ? 'simulator ready' : 'simulator unavailable'}
          </Badge>
        }
      />
      <div className="space-y-4 px-5 pb-5 text-sm">
        {/* Boundary statement — always visible. */}
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Automated execution is <strong>OFF</strong> for every plan in this milestone and
          live execution is not available. Paper results are deterministic simulations of
          what the approved decision would have done — they are not broker fills and are not
          a guarantee of future performance.
        </p>

        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <div className="text-xs text-ink-400">Open positions</div>
            <div className="text-lg">{status?.openPositions ?? 0}</div>
          </div>
          <div>
            <div className="text-xs text-ink-400">Closed positions</div>
            <div className="text-lg">{status?.closedPositions ?? 0}</div>
          </div>
          <div>
            <div className="text-xs text-ink-400">Open P&amp;L (simulated)</div>
            <div className="text-lg">{pl(status?.openPl)}</div>
          </div>
          <div>
            <div className="text-xs text-ink-400">Closed P&amp;L (simulated)</div>
            <div className="text-lg">{pl(status?.closedPl)}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs text-ink-400">
            Setup id
            <input
              className="mt-1 w-72 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100"
              value={props.setupId}
              onChange={(e) => props.onSetupIdChange(e.target.value)}
              placeholder="00000000-0000-4000-8000-000000000000"
              aria-label="Setup id to simulate"
            />
          </label>
          <label className="flex flex-col text-xs text-ink-400">
            Execution profile
            <select
              className="mt-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-sm text-ink-100"
              value={props.selectedProfileId}
              onChange={(e) => props.onProfileChange(e.target.value)}
              aria-label="Paper execution profile"
            >
              <option value="">select a profile…</option>
              {props.profileOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <Button onClick={props.onSimulate} disabled={props.busy}>
            Simulate
          </Button>
          <Button onClick={props.onEvaluate} disabled={props.busy}>
            Evaluate open positions
          </Button>
        </div>

        {props.error && <p className="text-xs text-red-400">{props.error}</p>}
        {props.notice && <p className="text-xs text-emerald-400">{props.notice}</p>}

        {/* Orders */}
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">Paper orders</div>
          {props.orders.length === 0 ? (
            <p className="text-ink-400">No simulated orders yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-ink-400">
                <tr>
                  <th className="py-1">Side</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Qty</th>
                  <th>Fill</th>
                  <th>SL</th>
                  <th>TP</th>
                  <th>Fees</th>
                  <th>Slippage</th>
                </tr>
              </thead>
              <tbody>
                {props.orders.map((o) => (
                  <tr key={o.id} className="border-t border-ink-800">
                    <td className="py-1 uppercase">{o.side}</td>
                    <td>{o.orderType}</td>
                    <td>{o.status}</td>
                    <td>{o.quantity}</td>
                    <td>{price(o.averageFillPrice)}</td>
                    <td>{price(o.stopLossPrice)}</td>
                    <td>{price(o.takeProfitPrice)}</td>
                    <td>{o.fees.toFixed(2)}</td>
                    <td>{o.slippage.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Positions */}
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">
            Paper positions ({open.length} open / {closed.length} closed)
          </div>
          {props.positions.length === 0 ? (
            <p className="text-ink-400">No simulated positions yet.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="text-ink-400">
                <tr>
                  <th className="py-1">Symbol</th>
                  <th>Direction</th>
                  <th>Status</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>Mark</th>
                  <th>Unrealized</th>
                  <th>Realized</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {props.positions.map((p) => (
                  <tr key={p.id} className="border-t border-ink-800">
                    <td className="py-1">{p.symbol}</td>
                    <td className="uppercase">{p.direction}</td>
                    <td>{p.status}</td>
                    <td>{price(p.averageEntryPrice)}</td>
                    <td>{price(p.exitPrice)}</td>
                    <td>{price(p.markPrice)}</td>
                    <td>{pl(p.unrealizedPl)}</td>
                    <td>{pl(p.realizedPl)}</td>
                    <td>
                      {p.status === 'open' && (
                        <Button
                          variant="ghost"
                          onClick={() => props.onClosePosition(p.id)}
                          disabled={props.busy}
                        >
                          Close (simulated)
                        </Button>
                      )}
                      {p.status === 'closed' && p.exitReason ? (
                        <span className="text-ink-400">{p.exitReason}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Fills */}
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">Fill ledger</div>
          {props.fills.length === 0 ? (
            <p className="text-ink-400">No simulated fills yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {props.fills.map((f) => (
                <li key={f.id} className="flex items-center justify-between">
                  <span className="uppercase text-ink-300">{f.fillType}</span>
                  <span className="text-ink-400">
                    {f.quantity} @ {price(f.price)} · fees {f.fees.toFixed(2)} · slippage{' '}
                    {f.slippage.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Reconciliation */}
        <div>
          <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">
            Reconciliation (M8.5 foundation)
          </div>
          {props.reconciliations.length === 0 ? (
            <p className="text-ink-400">No reconciliation records yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {props.reconciliations.slice(0, 10).map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span className="text-ink-300">
                    {r.scope} {r.outcome === 'ok' ? 'consistent' : 'mismatch'}
                  </span>
                  <span className={r.outcome === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
                    {r.findings.length === 0 ? 'no findings' : r.findings.join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {latest && (
            <p className="mt-1 text-xs text-ink-400">
              Impossible states are reported and refused, never silently corrected.
            </p>
          )}
        </div>

        {status && (
          <p className="text-xs text-ink-400">
            Simulator {status.simulatorVersion} · risk engine {status.riskEngineVersion} ·
            automated path blocked at {status.automatedPathGate ?? 'entitlement'} · live
            execution available: {String(status.liveExecutionAvailable)}
          </p>
        )}
      </div>
    </Card>
  );
}
