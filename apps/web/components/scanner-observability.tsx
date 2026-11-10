'use client';

/**
 * Scanner observability UI (Observability PR 3/3).
 *
 * Pure presentational pieces, so every state — including the ones that only
 * happen on bad data — can be rendered and asserted without a browser. The
 * page (`app/scanner/page.tsx`) only wires API calls to these.
 *
 * Rules visible in the markup:
 *  - outcomes are shown from the aggregate counters, in the same order, on every
 *    run that has them;
 *  - a run with no readable pair block says "unavailable" and shows **no**
 *    counts — zero is a measurement, absence is not;
 *  - a run the viewer does not own shows its aggregates plus an explicit
 *    "per-pair details withheld" notice, and never an observation;
 *  - a pure cursor-skip run is described as a successful no-op.
 */
import * as React from 'react';
import type { ScannerPairItem, ScannerRunDto, ScannerRunScope } from '@veltrixeye/contracts';
import { Alert, Badge, Button, Card, CardHeader, Spinner } from '@/components/ui';
import {
  SCANNER_OUTCOME_LABELS,
  SCANNER_OUTCOME_ORDER,
  SCANNER_RUN_SCOPE_OPTIONS,
  describePairDiagnostics,
  describeScannerOutcomes,
  readScannerPairSummary,
  runAudience,
  scannerRunsEmptyCopy,
  type ScannerOutcomeKey,
  type ScannerPairSummary,
  type ScannerPairTotals,
  type ScannerRunAudience,
  type ScannerRunsState,
} from '@/lib/scanner-observability';

const OUTCOME_DOT: Record<ScannerOutcomeKey, string> = {
  evaluated: 'bg-signal-500',
  cursor_skipped: 'bg-info-450',
  stale: 'bg-amber-450',
  failed: 'bg-danger-450',
};

const OUTCOME_TEXT: Record<ScannerOutcomeKey, string> = {
  evaluated: 'text-signal-400',
  cursor_skipped: 'text-info-450',
  stale: 'text-amber-450',
  failed: 'text-danger-450',
};

/**
 * How many stored observations are rendered per run. The API caps the stored
 * sample at 200; 12 keeps a long list scannable. The disclosure label is derived
 * from this same constant, so it can never claim to show more than it draws.
 */
export const PAIR_ITEM_PREVIEW_LIMIT = 12;

const OUTCOME_BADGE: Record<ScannerOutcomeKey, 'success' | 'info' | 'warning' | 'danger'> = {
  evaluated: 'success',
  cursor_skipped: 'info',
  stale: 'warning',
  failed: 'danger',
};

/* ------------------------------------------------------------------------- */
/* Scope control                                                             */
/* ------------------------------------------------------------------------- */

export function RunScopeControl({
  value,
  onChange,
}: {
  value: ScannerRunScope;
  onChange: (scope: ScannerRunScope) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Scanner run scope"
      data-testid="run-scope-control"
      className="flex flex-wrap items-center gap-1.5"
    >
      {SCANNER_RUN_SCOPE_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            data-scope={option.value}
            aria-pressed={active}
            title={option.description}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-500 ${
              active
                ? 'border-signal-500/40 bg-signal-500/15 text-signal-400'
                : 'border-ink-600 bg-ink-700 text-ink-300 hover:bg-ink-600 hover:text-ink-100'
            }`}
          >
            {option.label}
            <span className="sr-only"> — {option.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function scopeDescription(scope: ScannerRunScope): string {
  return SCANNER_RUN_SCOPE_OPTIONS.find((option) => option.value === scope)?.description ?? '';
}

/* ------------------------------------------------------------------------- */
/* Outcome bar + legend                                                      */
/* ------------------------------------------------------------------------- */

export function PairOutcomeBar({ totals }: { totals: ScannerPairTotals }) {
  const segments = SCANNER_OUTCOME_ORDER.filter((key) => totals[key] > 0);
  const label = SCANNER_OUTCOME_ORDER.map((key) => `${SCANNER_OUTCOME_LABELS[key]}: ${totals[key]}`).join(', ');

  if (totals.pairs === 0) {
    return (
      <div
        data-testid="pair-outcome-bar"
        role="img"
        aria-label="Pair outcomes — no pairs walked"
        className="h-2 w-full rounded bg-ink-700"
      />
    );
  }

  return (
    <div
      data-testid="pair-outcome-bar"
      role="img"
      aria-label={`Pair outcomes — ${label}`}
      className="flex h-2 w-full overflow-hidden rounded bg-ink-700"
    >
      {segments.map((key) => (
        <span key={key} data-outcome={key} className={OUTCOME_DOT[key]} style={{ flex: `${totals[key]} 1 0%` }} />
      ))}
    </div>
  );
}

export function PairOutcomeLegend({ totals }: { totals: ScannerPairTotals }) {
  return (
    <div
      data-testid="pair-outcome-legend"
      className="mt-2 grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4"
    >
      {SCANNER_OUTCOME_ORDER.map((key) => (
        <div
          key={key}
          className="flex items-center justify-between gap-2 rounded border border-ink-700 bg-ink-850/50 px-2 py-1"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-ink-300">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${OUTCOME_DOT[key]}`} />
            <span className="truncate">{SCANNER_OUTCOME_LABELS[key]}</span>
          </span>
          <span className={`shrink-0 font-mono ${OUTCOME_TEXT[key]}`}>{totals[key]}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Per-pair observations                                                     */
/* ------------------------------------------------------------------------- */

function formatCursor(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

export function PairItemList({
  items,
  totals,
  truncated,
  limit = PAIR_ITEM_PREVIEW_LIMIT,
}: {
  items: readonly ScannerPairItem[];
  totals: ScannerPairTotals;
  truncated: boolean;
  limit?: number;
}) {
  if (items.length === 0) {
    return <div className="text-xs text-ink-400">No pairs were walked in this run.</div>;
  }

  const shown = items.slice(0, limit);

  return (
    <div data-testid="pair-item-list" className="text-xs">
      <div className="hidden gap-2 border-b border-ink-700 pb-1 text-[10px] uppercase tracking-wider text-ink-400 sm:grid sm:grid-cols-12">
        <span className="col-span-2">Symbol</span>
        <span className="col-span-1">TF</span>
        <span className="col-span-2">Outcome</span>
        <span className="col-span-4">Reason</span>
        <span className="col-span-3">Setup candle (UTC)</span>
      </div>
      <div className="divide-y divide-ink-700/60">
        {shown.map((item, index) => {
          const diagnostics = describePairDiagnostics(item);
          return (
            <div
              key={`${item.symbol}-${item.timeframe}-${item.outcome}-${item.cursorMs ?? 'none'}-${index}`}
              className="grid grid-cols-2 gap-1 py-1.5 sm:grid-cols-12 sm:items-center sm:gap-2"
            >
              <span className="col-span-2 font-mono text-ink-100">{item.symbol}</span>
              <span className="col-span-1 text-ink-400">{item.timeframe}</span>
              <span className="col-span-2">
                <Badge tone={OUTCOME_BADGE[item.outcome]}>{SCANNER_OUTCOME_LABELS[item.outcome]}</Badge>
              </span>
              <span className="col-span-4 truncate text-ink-400" title={item.reason ?? undefined}>
                {item.reason ?? '—'}
              </span>
              <span className="col-span-3 font-mono text-[11px] text-ink-400">{formatCursor(item.cursorMs)}</span>
              {diagnostics && (
                <span
                  data-testid="pair-diagnostic"
                  className="col-span-2 truncate text-[11px] text-ink-500 sm:col-span-12"
                  title={diagnostics}
                >
                  {diagnostics}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 text-[11px] text-ink-500">
        Showing {shown.length} of {totals.pairs} pairs
        {truncated ? ' — the stored sample is capped, totals still cover every pair' : ''}.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* One run's outcome block                                                   */
/* ------------------------------------------------------------------------- */

export function ScannerRunOutcomes({
  summary,
  audience = 'owner',
}: {
  summary: ScannerPairSummary;
  audience?: ScannerRunAudience;
}) {
  if (summary.kind === 'unavailable') {
    return (
      <div
        data-testid="pair-outcomes-unavailable"
        className="rounded-md border border-ink-700 bg-ink-850/50 px-3 py-2 text-xs text-ink-400"
      >
        <span className="font-medium text-ink-300">Pair outcomes unavailable.</span>{' '}
        {summary.reason === 'missing'
          ? 'This run has no per-pair record — it predates per-pair observability, or none was written. No counts are shown rather than guessed.'
          : 'The recorded pair data could not be read, so no outcome counts are shown rather than invented.'}
      </div>
    );
  }

  const breakdown = describeScannerOutcomes(summary.aggregate.totals);

  return (
    <div data-testid="pair-outcomes" className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span data-testid="pair-outcomes-headline" className="text-sm text-ink-100">
          {breakdown.headline}
        </span>
        {breakdown.noOp && <Badge tone="info">No-op</Badge>}
        <span className="text-[11px] text-ink-500">
          {summary.aggregate.conditions.satisfied} conditions satisfied · {summary.aggregate.conditions.unsatisfied} unsatisfied
        </span>
      </div>
      <PairOutcomeBar totals={summary.aggregate.totals} />
      <PairOutcomeLegend totals={summary.aggregate.totals} />
      <p className="text-xs text-ink-400">{breakdown.detail}</p>

      {summary.kind === 'detail' ? (
        <details data-testid="pair-items" className="rounded-md border border-ink-700 bg-ink-850/30 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-ink-200">
            Per-pair observations (
            {Math.min(summary.items.length, PAIR_ITEM_PREVIEW_LIMIT)} shown of{' '}
            {summary.aggregate.totals.pairs})
          </summary>
          <div className="mt-2">
            <PairItemList
              items={summary.items}
              totals={summary.aggregate.totals}
              truncated={summary.aggregate.truncated}
            />
          </div>
        </details>
      ) : summary.detailWithheld ? (
        <div data-testid="pair-details-withheld">
          <Alert tone="info" title="Per-pair details withheld">
            {audience === 'system'
              ? 'This run came from the automatic scan cycle and mixes pairs from every account, so only aggregate outcome metrics are shown.'
              : audience === 'other'
                ? 'This run was not triggered from your session, so only aggregate outcome metrics are shown — individual pair observations are withheld.'
                : 'Individual pair observations are not shown for this run. Aggregate outcome metrics remain accurate.'}
          </Alert>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Run row                                                                   */
/* ------------------------------------------------------------------------- */

function statusTone(status: ScannerRunDto['status']): 'success' | 'danger' | 'info' | 'warning' {
  return status === 'completed' ? 'success' : status === 'failed' ? 'danger' : status === 'running' ? 'info' : 'warning';
}

export function ScannerRunRow({ run, scope }: { run: ScannerRunDto; scope?: ScannerRunScope }) {
  // A list is fetched for one scope, so the scope disambiguates an unowned row:
  // `system`/`all` can only contain own runs plus the automatic cycle's.
  const audience = runAudience(run, scope);
  const summary = readScannerPairSummary(run.metadata, { allowDetail: audience === 'owner' });

  return (
    <div data-testid="scanner-run-row" data-run-id={run.id} className="px-5 py-4 transition-colors hover:bg-ink-750/40">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(run.status)}>{run.status}</Badge>
        <span className="font-mono text-sm text-ink-100">{run.id.slice(0, 8)}</span>
        <span className="text-xs text-ink-400">{new Date(run.startedAt).toLocaleString()}</span>
        <span className="text-xs text-ink-500">· {run.providerSlug}</span>
        {audience === 'system' && <Badge tone="neutral">System</Badge>}
      </div>

      <div className="mt-2 grid gap-1 text-xs text-ink-400 sm:grid-cols-2 lg:grid-cols-4">
        <span>
          {run.strategiesScanned} strategies · {run.instrumentsScanned} instruments
        </span>
        <span>
          {run.candlesFetched} candles · {run.setupsDetected} detections
        </span>
        <span>
          {run.setupsCreated} created · {run.alertsCreated} alerts
        </span>
        <span>
          {run.staleRejections} stale · {run.providerFailures} failures
        </span>
      </div>

      <div className="mt-3">
        <ScannerRunOutcomes summary={summary} audience={audience} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Last run (global health)                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The `getHealth().lastRun` block.
 *
 * This run is the newest row in the shared ledger, which may be another
 * tenant's manual scan — redacted exactly like a system run. Without a scope the
 * payload cannot distinguish the two, so this block never labels the run
 * "System" and never claims it came from the automatic cycle; it simply says the
 * detail belongs to someone else.
 */
export function ScannerLastRunOutcomes({ run }: { run: ScannerRunDto }) {
  const audience = runAudience(run);
  return (
    <div data-testid="last-run-outcomes">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-400">Pair outcomes</span>
        {audience === 'system' && <Badge tone="neutral">System</Badge>}
      </div>
      <ScannerRunOutcomes
        summary={readScannerPairSummary(run.metadata, { allowDetail: audience === 'owner' })}
        audience={audience}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Run list card                                                             */
/* ------------------------------------------------------------------------- */

export function ScannerRunsCard({
  state,
  onScopeChange,
  onRetry,
}: {
  state: ScannerRunsState;
  onScopeChange: (scope: ScannerRunScope) => void;
  onRetry: () => void;
}) {
  const { runs, loading, error, scope } = state;

  return (
    <Card>
      <CardHeader
        title="Recent Scanner Runs"
        subtitle={scopeDescription(scope)}
        actions={<RunScopeControl value={scope} onChange={onScopeChange} />}
      />

      <div className="px-5 py-4">
        {runs === null && loading && <Spinner label="Loading scanner runs" />}

        {runs === null && !loading && error && (
          <div data-testid="runs-error" className="space-y-3">
            <Alert tone="danger" role="alert" title="Could not load scanner runs">
              {error}
            </Alert>
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}

        {runs !== null && (
          <div className="space-y-3">
            {error && (
              <div data-testid="runs-error" className="space-y-2">
                <Alert tone="danger" role="alert" title="Refreshing scanner runs failed">
                  {error}
                </Alert>
                <Button variant="secondary" onClick={onRetry}>
                  Retry
                </Button>
              </div>
            )}

            {loading && (
              <div role="status" className="text-xs text-ink-400">
                Refreshing…
              </div>
            )}

            {runs.length === 0 ? (
              <div data-testid="runs-empty" className="py-4 text-sm text-ink-400">
                {scannerRunsEmptyCopy(scope)}
              </div>
            ) : (
              <div className="-mx-5 divide-y divide-ink-700 border-t border-ink-700">
                {runs.map((run) => (
                  <ScannerRunRow key={run.id} run={run} scope={scope} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
