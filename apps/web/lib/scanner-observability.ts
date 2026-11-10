/**
 * Scanner observability view model (Observability PR 3/3).
 *
 * Everything here is pure and framework-free so the rules can be tested without
 * a browser. The principles it encodes:
 *
 *  - **Aggregates and detail come from different readers.** Counts always come
 *    from `readScannerRunPairAggregate` (never derived from the item sample);
 *    individual observations only from `readScannerRunPairs`. A block that
 *    cannot be read is *unavailable* — never zero, never fabricated.
 *  - **Withheld is not missing.** A system run returns the aggregate half only,
 *    so it is explicitly "withheld for privacy", not "no data".
 *  - **The UI does not depend on the API for privacy.** A run the viewer does
 *    not own never renders observations even if a full block somehow arrives.
 */
import {
  readScannerRunPairAggregate,
  readScannerRunPairs,
  type ScannerPairItem,
  type ScannerRunDto,
  type ScannerRunPairAggregate,
  type ScannerRunPairs,
  type ScannerRunScope,
} from '@veltrixeye/contracts';
import { ApiError } from './api';

/* ------------------------------------------------------------------------- */
/* Scope                                                                     */
/* ------------------------------------------------------------------------- */

export interface ScannerRunScopeOption {
  value: ScannerRunScope;
  label: string;
  /** One sentence shown under the control and exposed to assistive tech. */
  description: string;
}

export const SCANNER_RUN_SCOPE_OPTIONS: readonly ScannerRunScopeOption[] = [
  {
    value: 'mine',
    label: 'My runs',
    description: 'Scans you triggered yourself, with their per-pair detail.',
  },
  {
    value: 'system',
    label: 'System',
    description:
      'The automatic 5-minute cycle. Aggregate metrics only — per-pair observations are withheld because they mix every account.',
  },
  {
    value: 'all',
    label: 'All runs',
    description: 'Your runs plus the automatic cycle. Per-pair detail only for the runs you own.',
  },
] as const;

/** Page size requested for the run list (the API caps at 100). */
export const SCANNER_RUNS_LIMIT = 20;

/**
 * The request a scope selection issues. The scope is always sent explicitly so
 * the request matches the control the user sees; the client still omits the
 * parameter when no scope is chosen (`api.listScannerRuns({ limit })`).
 */
export function buildScannerRunsRequest(
  scope: ScannerRunScope,
  limit: number = SCANNER_RUNS_LIMIT,
): { limit: number; scope: ScannerRunScope } {
  return { limit, scope };
}

/**
 * Who a tenant-facing run belongs to, as far as the payload can tell.
 *
 *  - `owner`  — `metadata.triggeredBy` is present. Redaction keeps it only for
 *               the viewer's own runs, so a present key means "mine".
 *  - `system` — no `triggeredBy`, and the caller obtained the run from a scope
 *               that can only contain own runs plus the automatic cycle
 *               (`system`/`all`), so it is the system runner's.
 *  - `other`  — no `triggeredBy` and no scope to disambiguate. This is the
 *               global `getHealth().lastRun` case: the newest run may be another
 *               tenant's manual scan, which is redacted exactly like a system
 *               run. The UI must not claim it came from the automatic cycle.
 *
 * The failure mode is always conservative: anything not provably the viewer's
 * is treated as not-owned, so it can show aggregate metrics but never detail.
 */
export type ScannerRunAudience = 'owner' | 'system' | 'other';

export function runAudience(
  run: Pick<ScannerRunDto, 'metadata'>,
  scope?: ScannerRunScope,
): ScannerRunAudience {
  if (run.metadata.triggeredBy !== undefined) return 'owner';
  if (scope === 'system' || scope === 'all') return 'system';
  return 'other';
}

/** Empty-state copy, which must not imply the scanner is broken. */
export function scannerRunsEmptyCopy(scope: ScannerRunScope): string {
  if (scope === 'system') {
    return 'No automatic runs recorded yet. The 5-minute scan cycle writes one every time it executes.';
  }
  if (scope === 'all') {
    return 'No scanner runs recorded yet. Trigger a scan, or wait for the automatic cycle.';
  }
  return 'You have not triggered a scan yet. Use “Trigger Scan” to run one, or switch to System to see the automatic cycle.';
}

/** Safe, entitlement-aware wording for a failed run-list request. */
export function describeScannerRunsError(err: unknown): string {
  if (err instanceof ApiError) {
    // A 403 here is the scanner entitlement, and its message is written for the
    // user ("Scanner access requires a Pro or Premium subscription").
    if (err.status === 403) return err.message;
    if (err.status === 401) return 'Your session is no longer valid. Sign in again to continue.';
    if (err.status < 500 && err.message) return err.message;
  }
  return 'Could not load scanner runs. Please try again.';
}

/* ------------------------------------------------------------------------- */
/* Outcome breakdown                                                         */
/* ------------------------------------------------------------------------- */

export type ScannerOutcomeKey = 'evaluated' | 'cursor_skipped' | 'stale' | 'failed';

/** Display order: the outcome that did work first, the no-op last-but-first-listed. */
export const SCANNER_OUTCOME_ORDER: readonly ScannerOutcomeKey[] = [
  'evaluated',
  'cursor_skipped',
  'stale',
  'failed',
] as const;

export const SCANNER_OUTCOME_LABELS: Record<ScannerOutcomeKey, string> = {
  evaluated: 'Evaluated',
  cursor_skipped: 'Cursor skipped',
  stale: 'Stale',
  failed: 'Failed',
};

export type ScannerPairTotals = ScannerRunPairAggregate['totals'];

export interface ScannerOutcomeBreakdown {
  totals: ScannerPairTotals;
  /** Whole-percent share per outcome; rounding may not sum to exactly 100. */
  percent: Record<ScannerOutcomeKey, number>;
  /** One sentence stating what happened, e.g. "10 of 10 pairs already evaluated this setup bar." */
  headline: string;
  /** The sentence that explains *why* it happened; never blames the user. */
  detail: string;
  /**
   * True when the run evaluated nothing because every pair had already been
   * processed — an idempotent no-op, not a failed or empty scan.
   */
  noOp: boolean;
}

/**
 * Turn the aggregate counters into the copy the UI shows.
 *
 * Deliberately never distinguishes "the scanner did nothing" from "the scanner
 * was broken": a pure cursor-skip run is a *successful* no-op and is described
 * as such, while stale/failed pairs are named individually.
 */
export function describeScannerOutcomes(totals: ScannerPairTotals): ScannerOutcomeBreakdown {
  const { pairs, evaluated, cursor_skipped: skipped, stale, failed } = totals;
  const percent = {} as Record<ScannerOutcomeKey, number>;
  for (const key of SCANNER_OUTCOME_ORDER) {
    percent[key] = pairs === 0 ? 0 : Math.round((totals[key] / pairs) * 100);
  }

  if (pairs === 0) {
    return {
      totals,
      percent,
      headline: 'No pairs were walked in this run.',
      detail:
        'The run completed without a single (strategy, instrument) pair to process, so there is no outcome to report.',
      noOp: false,
    };
  }

  if (evaluated === 0 && stale === 0 && failed === 0 && skipped === pairs) {
    return {
      totals,
      percent,
      headline: `${pairs} of ${pairs} pairs already evaluated this setup bar.`,
      detail:
        'Every pair was skipped at its cursor: the latest closed setup candle had already been processed for all of them. This is an idempotent no-op — no new market data was evaluated, and nothing failed.',
      noOp: true,
    };
  }

  if (evaluated === pairs) {
    return {
      totals,
      percent,
      headline: `${pairs} of ${pairs} pairs evaluated.`,
      detail: 'Every pair reached the detection engine on this bar.',
      noOp: false,
    };
  }

  const rest: string[] = [];
  if (skipped > 0) rest.push(`${skipped} skipped (already processed)`);
  if (stale > 0) rest.push(`${stale} stale`);
  if (failed > 0) rest.push(`${failed} failed`);

  return {
    totals,
    percent,
    headline: evaluated === 0 ? `No pairs were evaluated (${pairs} walked).` : `${evaluated} of ${pairs} pairs evaluated.`,
    detail:
      rest.length > 0
        ? `Of the remaining pairs: ${rest.join(', ')}.`
        : 'The remaining pairs were not evaluated.',
    noOp: evaluated === 0 && skipped === pairs,
  };
}

/* ------------------------------------------------------------------------- */
/* Per-pair evaluation diagnostics (PR A)                                    */
/* ------------------------------------------------------------------------- */

/**
 * Human wording for a direction's evaluation state. Closed vocabulary — the
 * server sends one of five values, and anything else renders as the raw value
 * rather than being silently dropped.
 */
const DIRECTION_STATE_LABELS: Record<string, string> = {
  qualified: 'qualified',
  not_qualified: 'not qualified',
  blocked: 'blocked by limit',
  error: 'error',
  not_run: 'not run',
};

/** Cap for the rendered line, so one pair cannot distort the table. */
export const PAIR_DIAGNOSTIC_TEXT_MAX = 240;

/**
 * One bounded sentence explaining what a pair actually did, or `null` when the
 * run predates PR A diagnostics (or the pair simply has none).
 *
 * It reads, in order: the stage the pair reached, the pair-level cause codes,
 * each direction's state (with the failing condition codes that explain a
 * rejection), and the per-role candle counts. Every value comes from a closed
 * vocabulary or is a count, so this never renders tenant text — and it is only
 * ever reached for a run the viewer owns, because the observation sample is
 * withheld for every other run.
 */
export function describePairDiagnostics(item: Pick<ScannerPairItem, 'diagnostics'>): string | null {
  const diagnostics = item.diagnostics;
  if (!diagnostics) return null;

  const parts: string[] = [`Stage: ${diagnostics.stage}`];
  if (diagnostics.codes && diagnostics.codes.length > 0) {
    parts.push(`codes: ${diagnostics.codes.join(', ')}`);
  }

  for (const direction of ['long', 'short'] as const) {
    const entry = diagnostics.directions?.[direction];
    if (!entry) continue;
    const label = DIRECTION_STATE_LABELS[entry.state] ?? entry.state;
    const failing = entry.failing && entry.failing.length > 0 ? ` (${entry.failing.join(', ')})` : '';
    parts.push(`${direction} ${label}${failing}`);
  }

  if (diagnostics.data) {
    const { htf, setup, entry } = diagnostics.data;
    parts.push(`candles ${htf.candles}/${setup.candles}/${entry.candles}`);
  }

  return parts.join(' · ').slice(0, PAIR_DIAGNOSTIC_TEXT_MAX);
}

/* ------------------------------------------------------------------------- */
/* Pair summary (aggregate vs detail vs unavailable)                          */
/* ------------------------------------------------------------------------- */

/**
 * Why a run has no readable pair data.
 *  - `missing`    — no `pairs` key at all (recorded before per-pair observability).
 *  - `malformed`  — a key is present but cannot be read as an aggregate block.
 */
export type ScannerPairUnavailableReason = 'missing' | 'malformed';

export type ScannerPairSummary =
  | { kind: 'unavailable'; reason: ScannerPairUnavailableReason }
  | {
      kind: 'aggregate';
      aggregate: ScannerRunPairAggregate;
      /** True when observations exist server-side but are not disclosed to this viewer. */
      detailWithheld: boolean;
    }
  | { kind: 'detail'; aggregate: ScannerRunPairAggregate; items: ScannerPairItem[] };

export interface PairSummaryOptions {
  /**
   * Whether observations may be rendered. `false` for a run the viewer does not
   * own: the UI then treats even a complete block as withheld, so a server-side
   * redaction regression cannot become a client-side leak.
   */
  allowDetail?: boolean;
}

/**
 * Read a run's pair metadata into exactly one of three states.
 *
 * Counts always come from `readScannerRunPairAggregate`; the item sample is
 * read with `readScannerRunPairs` and only used for the `detail` state. A block
 * that fails either reader is `unavailable` — the UI renders that explicitly
 * instead of showing zeros.
 */
export function readScannerPairSummary(
  metadata: Record<string, unknown> | null | undefined,
  options: PairSummaryOptions = {},
): ScannerPairSummary {
  const aggregate = readScannerRunPairAggregate(metadata ?? null);
  if (!aggregate) {
    const hasPairsKey = Boolean(metadata) && typeof metadata === 'object' && 'pairs' in (metadata as object);
    return { kind: 'unavailable', reason: hasPairsKey ? 'malformed' : 'missing' };
  }

  const block: ScannerRunPairs | null = readScannerRunPairs(metadata ?? null);
  const allowDetail = options.allowDetail !== false;

  if (block && allowDetail) {
    return { kind: 'detail', aggregate, items: block.items };
  }

  return {
    kind: 'aggregate',
    aggregate,
    // Nothing is withheld when the run genuinely walked no pairs.
    detailWithheld: block !== null ? block.items.length > 0 : aggregate.totals.pairs > 0,
  };
}

/* ------------------------------------------------------------------------- */
/* Runs fetch state                                                          */
/* ------------------------------------------------------------------------- */

export interface ScannerRunsState {
  scope: ScannerRunScope;
  /** `null` until a list has loaded for the current scope. */
  runs: ScannerRunDto[] | null;
  loading: boolean;
  error: string | null;
  /** Bumped per request so a slow, superseded response can be discarded. */
  requestId: number;
}

export type ScannerRunsAction =
  | { type: 'scope'; scope: ScannerRunScope }
  | { type: 'refresh' }
  | { type: 'loaded'; requestId: number; runs: ScannerRunDto[] }
  | { type: 'failed'; requestId: number; error: string };

export function initialScannerRunsState(scope: ScannerRunScope = 'mine'): ScannerRunsState {
  return { scope, runs: null, loading: true, error: null, requestId: 0 };
}

/**
 * State machine for the run list.
 *
 *  - switching scope clears the previous scope's rows (they would be labelled
 *    with the wrong scope) and starts a fresh request;
 *  - re-selecting the active scope does nothing (no pointless round trip);
 *  - refreshing keeps the rows visible while the new request is in flight;
 *  - a response whose `requestId` is stale is ignored, so fast switching can
 *    never paint the wrong scope's runs.
 */
export function scannerRunsReducer(state: ScannerRunsState, action: ScannerRunsAction): ScannerRunsState {
  switch (action.type) {
    case 'scope':
      if (action.scope === state.scope) return state;
      return { scope: action.scope, runs: null, loading: true, error: null, requestId: state.requestId + 1 };
    case 'refresh':
      return { ...state, loading: true, error: null, requestId: state.requestId + 1 };
    case 'loaded':
      if (action.requestId !== state.requestId) return state;
      return { ...state, runs: action.runs, loading: false, error: null };
    case 'failed':
      if (action.requestId !== state.requestId) return state;
      return { ...state, loading: false, error: action.error };
    default:
      return state;
  }
}
