'use client';

import * as React from 'react';
import type { BacktestRunDto, BacktestTrade } from '@veltrixeye/contracts';
import { Badge, Card, CardHeader, Monospace } from '@/components/ui';
import {
  backtestOutcomeLabel,
  directionLabel,
  exitReasonLabel,
  exitReasonTone,
  formatEpochMsUtc,
  formatR,
  metricTiles,
  truncationIndicators,
} from '@/lib/backtest-form';
import { formatDateTime, formatPrice } from '@/lib/formats';

/**
 * Backtest result presentation (M6 Phase 4).
 *
 * Pure render components: every value is taken from the API's run/trade DTOs.
 * No metric is recomputed here, and every nullable figure renders as an em
 * dash — a null from the API means "not defined for this run" (e.g. a profit
 * factor with no losing trades), never zero.
 */

export function BacktestRunSummary({
  run,
  created,
}: {
  run: BacktestRunDto;
  /** Present only for a just-submitted run: `false` means the run was replayed. */
  created?: boolean;
}) {
  const outcome = created === undefined ? null : backtestOutcomeLabel(created);
  const limits = truncationIndicators({ truncated: false, notes: run.notes });

  return (
    <Card>
      <CardHeader
        title={`${run.instrument.symbol} · ${directionLabel(run.direction)} · v${run.versionNumber}`}
        subtitle={`${formatEpochMsUtc(run.fromMs)} → ${formatEpochMsUtc(run.toMs)}`}
        actions={
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Badge tone={run.status === 'completed' ? 'success' : 'danger'}>{run.status}</Badge>
            <Badge tone="neutral">engine {run.engineVersion}</Badge>
            {outcome && <Badge tone={outcome.tone === 'success' ? 'success' : 'info'}>{outcome.title}</Badge>}
          </div>
        }
      />
      <dl className="grid gap-x-6 gap-y-2 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <SummaryItem label="Asset class" value={run.instrument.assetClass} />
        <SummaryItem label="Direction replayed" value={directionLabel(run.direction)} />
        <SummaryItem label="Stop-loss exit" value={run.exitPolicy.stopLoss === 'level' ? 'Level' : 'None (hold through)'} />
        <SummaryItem
          label="Take-profit leg"
          value={run.exitPolicy.takeProfit === 'none' ? 'None' : run.exitPolicy.takeProfit.toUpperCase()}
        />
        <SummaryItem label="Max hold" value={`${run.exitPolicy.maxHoldCandles} setup candles`} />
        <SummaryItem label="Fee per side" value={formatPrice(run.costPolicy.feePerSide)} />
        <SummaryItem label="Slippage per side" value={formatPrice(run.costPolicy.slippagePerSide)} />
        <SummaryItem label="Spread (entry)" value={formatPrice(run.costPolicy.spread)} />
        <SummaryItem
          label="Risk per trade"
          value={run.costPolicy.riskPerTrade === undefined ? 'not set (R only)' : formatPrice(run.costPolicy.riskPerTrade)}
        />
        <SummaryItem label="Entry timing" value="Signal close (pinned)" />
        <SummaryItem label="Same-candle rule" value="Stop first (pinned)" />
        <SummaryItem label="Created" value={formatDateTime(run.createdAt)} />
      </dl>
      <div className="border-t border-ink-700 px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          <span>Config hash</span>
          <Monospace>{run.configHash}</Monospace>
        </div>
        {limits.length > 0 && (
          <ul className="mt-2 space-y-1">
            {limits.map((l) => (
              <li key={l} className="text-xs text-amber-450">
                {l}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-ink-100">{value}</dd>
    </div>
  );
}

export function BacktestMetricsGrid({
  metrics,
  showsCurrency,
}: {
  metrics: BacktestRunDto['metrics'];
  showsCurrency: boolean;
}) {
  const tiles = metricTiles(metrics, { showsCurrency });
  return (
    <Card>
      <CardHeader
        title="Results"
        subtitle="R-multiples are the primary result; currency appears only when a risk per trade was supplied"
      />
      <dl className="grid grid-cols-2 gap-px bg-ink-700 sm:grid-cols-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="bg-ink-800 px-4 py-3">
            <dt className="text-[11px] uppercase tracking-wider text-ink-400">{t.label}</dt>
            <dd
              className={`mt-1 font-mono text-lg ${
                t.tone === 'success' ? 'text-signal-400' : t.tone === 'danger' ? 'text-danger-450' : 'text-ink-50'
              }`}
            >
              {t.value}
            </dd>
            {t.hint && <dd className="mt-0.5 text-[11px] text-ink-500">{t.hint}</dd>}
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function BacktestNotesList({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) {
    return (
      <Card>
        <CardHeader title="Engine notes" subtitle="Warm-up, truncation and data-gap reporting from the engine" />
        <p className="px-5 py-6 text-center text-sm text-ink-400">No engine notes for this run.</p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Engine notes" subtitle="Warm-up, truncation and data-gap reporting from the engine" />
      <ul className="divide-y divide-ink-750">
        {notes.map((note) => (
          <li key={note} className="px-5 py-3 text-sm text-ink-300">
            {note}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function BacktestTradesTable({
  trades,
  truncated,
  limit,
  onLoadMore,
  loadingMore,
}: {
  trades: readonly BacktestTrade[];
  truncated: boolean;
  /** How many trades are currently shown (from the trades endpoint's limit). */
  limit?: number;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  const hasMore = typeof limit === 'number' && trades.length >= limit;

  return (
    <Card>
      <CardHeader
        title={`Trades (${trades.length})`}
        subtitle="One row per simulated setup, in run order"
        actions={
          truncated ? <Badge tone="warning">truncated</Badge> : undefined
        }
      />
      {trades.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-ink-400">
          No setups qualified in this range, so there are no trades to show.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-sm">
            <caption className="sr-only">Simulated trades with entry, levels, exit and R result</caption>
            <thead>
              <tr className="border-b border-ink-700 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th scope="col" className="px-4 py-2.5 font-medium">#</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Signal (UTC)</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Dir</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Entry</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Stop</th>
                <th scope="col" className="px-4 py-2.5 font-medium">TP1 / TP2 / TP3</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Score</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Exit</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Exit price</th>
                <th scope="col" className="px-4 py-2.5 font-medium text-right">R</th>
                <th scope="col" className="px-4 py-2.5 font-medium text-right">Currency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-750">
              {trades.map((t) => (
                <tr key={`${t.seq}-${t.direction}-${t.signalAsOfMs}`} className="hover:bg-ink-750/40">
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-400">{t.seq}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-300">{formatEpochMsUtc(t.signalAsOfMs)}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={t.direction === 'long' ? 'success' : 'danger'}>{t.direction}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{formatPrice(t.entryPrice)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{formatPrice(t.stopLossPrice)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-300">
                    {formatPrice(t.tp1Price)} / {formatPrice(t.tp2Price)} / {formatPrice(t.tp3Price)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-300">
                    {t.qualityScore === null ? '—' : `${t.qualityScore}${t.qualityGrade ? ` (${t.qualityGrade})` : ''}`}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={exitReasonTone(t.exitReason)}>{exitReasonLabel(t.exitReason)}</Badge>
                    {t.exitAsOfMs !== null && (
                      <div className="mt-0.5 font-mono text-[11px] text-ink-500">{formatEpochMsUtc(t.exitAsOfMs)}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{formatPrice(t.exitPrice)}</td>
                  <td
                    className={`px-4 py-2.5 text-right font-mono text-xs ${
                      t.pnlR === null ? 'text-ink-500' : t.pnlR > 0 ? 'text-signal-400' : t.pnlR < 0 ? 'text-danger-450' : 'text-ink-200'
                    }`}
                  >
                    {formatR(t.pnlR)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-ink-300">
                    {t.pnlCurrency === null ? '—' : t.pnlCurrency.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && (
        <p className="border-t border-ink-700 px-5 py-3 text-xs text-amber-450">
          This run holds more trades than are shown — the API stores and returns at most 500 per run.
        </p>
      )}
      {hasMore && onLoadMore && (
        <div className="border-t border-ink-700 px-5 py-3">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="rounded-md border border-ink-600 px-3 py-1.5 text-xs text-ink-200 transition-colors hover:bg-ink-750 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more trades'}
          </button>
        </div>
      )}
    </Card>
  );
}
