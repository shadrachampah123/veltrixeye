import {
  BACKTEST_EXIT_REASONS,
  DEFAULT_BACKTESTS_LIMIT,
  MAX_BACKTESTS_LIMIT,
  DEFAULT_MAX_HOLD_CANDLES,
  MAX_BACKTEST_STEPS,
  MAX_BACKTEST_TRADES,
  backtestRequestSchema,
  type BacktestDirection,
  type BacktestExitReason,
  type BacktestExitPolicyInput,
  type BacktestCostPolicyInput,
  type BacktestMetrics,
  type BacktestTrade,
} from '@veltrixeye/contracts';
import type { BacktestCreateInput } from '@/lib/api';

/**
 * Backtest form model + result formatting (M6 Phase 4, frontend only).
 *
 * Everything the API owns stays with the API: this module only mirrors the
 * *input* rules closely enough to fail fast in the browser, then hands the
 * final body to `backtestRequestSchema` from `@veltrixeye/contracts` so the
 * payload that leaves the browser is exactly the payload the route accepts.
 * The server remains authoritative — a 400 is still rendered, never hidden.
 *
 * Nothing here computes a metric. Every number shown by the results UI is a
 * field the API returned (`BacktestMetrics` / `BacktestTrade`); formatters
 * only render them, and every nullable metric renders as an em dash rather
 * than a fabricated zero.
 */

/** Longest range the backtest service accepts (mirrors `MAX_RANGE_MS` in `packages/core`). */
export const MAX_BACKTEST_RANGE_MS = 10 * 365 * 24 * 3600 * 1000;

/** Page sizes used by the backtest UI. */
export const TRADES_PAGE_SIZES = [50, 100, 250, MAX_BACKTEST_TRADES] as const;
export type TradesPageSize = (typeof TRADES_PAGE_SIZES)[number];

export const STOP_LOSS_OPTIONS = ['level', 'none'] as const;
export type StopLossOption = (typeof STOP_LOSS_OPTIONS)[number];

export const TAKE_PROFIT_OPTIONS = ['tp1', 'tp2', 'tp3', 'none'] as const;
export type TakeProfitOption = (typeof TAKE_PROFIT_OPTIONS)[number];

export const DIRECTION_OPTIONS = ['long', 'short', 'both'] as const;

/** Field keys the form can report an error against. */
export const BACKTEST_FORM_FIELDS = [
  'strategyVersion',
  'instrument',
  'from',
  'to',
  'maxHoldCandles',
  'feePerSide',
  'slippagePerSide',
  'spread',
  'riskPerTrade',
] as const;
export type BacktestFormField = (typeof BACKTEST_FORM_FIELDS)[number];

export type BacktestFormErrors = Partial<Record<BacktestFormField, string>>;

/**
 * Form state. Numbers are held as raw input strings so a half-typed value
 * (`"1."`, `""`) is representable and reported as a validation error instead
 * of silently coercing to 0.
 */
export interface BacktestFormState {
  strategyId: string;
  versionId: string;
  assetClass: string;
  symbol: string;
  direction: BacktestDirection;
  /** `datetime-local` values (wall-clock in the browser's zone, no offset). */
  fromValue: string;
  toValue: string;
  stopLoss: StopLossOption;
  takeProfit: TakeProfitOption;
  maxHoldCandles: string;
  feePerSide: string;
  slippagePerSide: string;
  spread: string;
  /** Optional: only scales R into currency, never changes entries or exits. */
  riskPerTrade: string;
}

/** Quick range presets, applied against an explicit "now" (never a hidden clock read). */
export const BACKTEST_RANGE_PRESETS = [
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: '180d', label: 'Last 6 months', days: 180 },
  { id: '365d', label: 'Last 12 months', days: 365 },
] as const;
export type BacktestRangePresetId = (typeof BACKTEST_RANGE_PRESETS)[number]['id'];

const DAY_MS = 24 * 3600 * 1000;

/** Zero-pad to two digits (used by the `datetime-local` serializer). */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Epoch-ms → the value a `<input type="datetime-local">` expects (local time). */
export function toDateTimeLocalValue(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(
    d.getMinutes(),
  )}`;
}

/** `datetime-local` value → epoch-ms, or null when absent/unparseable. */
export function fromDateTimeLocalValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** A fresh form: last 90 days ending "now", pinned exit/cost defaults. */
export function createBacktestFormState(nowMs: number, presetId: BacktestRangePresetId = '90d'): BacktestFormState {
  const preset = BACKTEST_RANGE_PRESETS.find((p) => p.id === presetId) ?? BACKTEST_RANGE_PRESETS[1];
  return {
    strategyId: '',
    versionId: '',
    assetClass: '',
    symbol: '',
    direction: 'both',
    fromValue: toDateTimeLocalValue(nowMs - preset.days * DAY_MS),
    toValue: toDateTimeLocalValue(nowMs),
    stopLoss: 'level',
    takeProfit: 'tp3',
    maxHoldCandles: String(DEFAULT_MAX_HOLD_CANDLES),
    feePerSide: '0',
    slippagePerSide: '0',
    spread: '0',
    riskPerTrade: '',
  };
}

/** Apply a range preset, keeping every other field untouched. */
export function applyRangePreset(
  state: BacktestFormState,
  presetId: BacktestRangePresetId,
  nowMs: number,
): BacktestFormState {
  const preset = BACKTEST_RANGE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return state;
  return {
    ...state,
    fromValue: toDateTimeLocalValue(nowMs - preset.days * DAY_MS),
    toValue: toDateTimeLocalValue(nowMs),
  };
}

/** Parse a non-negative finite decimal input; null when blank/invalid. */
function parseNonNegative(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Parse the optional positive `riskPerTrade`; `undefined` means "not supplied". */
function parseRiskPerTrade(value: string): { ok: true; value: number | undefined } | { ok: false } {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return { ok: false };
  return { ok: true, value: n };
}

export interface BacktestFormValidation {
  errors: BacktestFormErrors;
  valid: boolean;
  /** Parsed epoch-ms bounds (present even when other fields are invalid). */
  fromMs: number | null;
  toMs: number | null;
}

/**
 * Client-side mirror of the route/service input rules:
 * required selections, `from < to`, no future bounds, ≤ 10-year span,
 * `maxHoldCandles` 1–5000, non-negative costs, optional positive risk size.
 *
 * `nowMs` is injected so the "not in the future" rule is testable and so the
 * browser never disagrees with itself between renders.
 */
export function validateBacktestForm(state: BacktestFormState, nowMs: number): BacktestFormValidation {
  const errors: BacktestFormErrors = {};

  if (!state.strategyId || !state.versionId) {
    errors.strategyVersion = 'Choose a strategy and one of its published versions.';
  }
  if (!state.assetClass || !state.symbol.trim()) {
    errors.instrument = 'Choose an instrument with stored market data.';
  }

  const fromMs = fromDateTimeLocalValue(state.fromValue);
  const toMs = fromDateTimeLocalValue(state.toValue);

  if (fromMs === null) errors.from = 'Choose a start date and time for the replay.';
  if (toMs === null) errors.to = 'Choose an end date and time for the replay.';

  if (fromMs !== null && toMs !== null) {
    if (fromMs >= toMs) {
      errors.from = 'The start must be earlier than the end.';
    } else if (toMs - fromMs > MAX_BACKTEST_RANGE_MS) {
      errors.to = 'The range is longer than the 10-year maximum.';
    }
  }
  // Future bounds are rejected by the service too (`to must not be in the future`).
  if (toMs !== null && toMs > nowMs) errors.to = 'The end must not be in the future.';
  if (fromMs !== null && fromMs > nowMs) errors.from = 'The start must not be in the future.';

  const hold = state.maxHoldCandles.trim();
  if (hold === '' || !/^\d+$/.test(hold)) {
    errors.maxHoldCandles = 'Enter a whole number of setup-timeframe candles.';
  } else {
    const n = Number(hold);
    if (n < 1 || n > 5000) errors.maxHoldCandles = 'Max hold must be between 1 and 5000 candles.';
  }

  if (parseNonNegative(state.feePerSide) === null) {
    errors.feePerSide = 'Fee per side must be a number ≥ 0 (price units).';
  }
  if (parseNonNegative(state.slippagePerSide) === null) {
    errors.slippagePerSide = 'Slippage per side must be a number ≥ 0 (price units).';
  }
  if (parseNonNegative(state.spread) === null) {
    errors.spread = 'Spread must be a number ≥ 0 (price units, applied at entry).';
  }
  if (!parseRiskPerTrade(state.riskPerTrade).ok) {
    errors.riskPerTrade = 'Risk per trade must be a positive number (or left blank).';
  }

  return { errors, valid: Object.keys(errors).length === 0, fromMs, toMs };
}

export type BuildBacktestRequestResult =
  | { ok: true; body: BacktestCreateInput }
  | { ok: false; errors: BacktestFormErrors };

/**
 * Validate, then run the payload through the shared contract schema. The
 * returned body is `backtestRequestSchema`'s *parsed* output (pinned
 * `stop_first` / `signal_close` included, cost defaults applied), so what the
 * browser sends is byte-equivalent to what the route will parse.
 */
export function buildBacktestRequest(state: BacktestFormState, nowMs: number): BuildBacktestRequestResult {
  const { errors, valid, fromMs, toMs } = validateBacktestForm(state, nowMs);
  if (!valid || fromMs === null || toMs === null) return { ok: false, errors };

  const riskPerTrade = parseRiskPerTrade(state.riskPerTrade);
  if (!riskPerTrade.ok) return { ok: false, errors };

  const exitPolicy: BacktestExitPolicyInput = {
    stopLoss: state.stopLoss,
    takeProfit: state.takeProfit,
    maxHoldCandles: Number(state.maxHoldCandles.trim()),
  };
  const costPolicy: BacktestCostPolicyInput = {
    feePerSide: parseNonNegative(state.feePerSide) ?? 0,
    slippagePerSide: parseNonNegative(state.slippagePerSide) ?? 0,
    spread: parseNonNegative(state.spread) ?? 0,
    ...(riskPerTrade.value === undefined ? {} : { riskPerTrade: riskPerTrade.value }),
  };

  const parsed = backtestRequestSchema.safeParse({
    instrument: { assetClass: state.assetClass, symbol: state.symbol.trim() },
    direction: state.direction,
    from: fromMs,
    to: toMs,
    exitPolicy,
    costPolicy,
  });
  if (!parsed.success) {
    const mapped: BacktestFormErrors = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      const key = path.startsWith('costPolicy.riskPerTrade')
        ? 'riskPerTrade'
        : path.startsWith('costPolicy.feePerSide')
          ? 'feePerSide'
          : path.startsWith('costPolicy.slippagePerSide')
            ? 'slippagePerSide'
            : path.startsWith('costPolicy.spread')
              ? 'spread'
              : path.startsWith('exitPolicy.maxHoldCandles')
                ? 'maxHoldCandles'
                : path === 'from'
                  ? 'from'
                  : path === 'to'
                    ? 'to'
                    : path.startsWith('instrument')
                      ? 'instrument'
                      : 'strategyVersion';
      mapped[key] ??= issue.message;
    }
    return { ok: false, errors: mapped };
  }

  return {
    ok: true,
    body: { strategyId: state.strategyId, versionId: state.versionId, ...parsed.data },
  };
}

// ---------------------------------------------------------------------------
// Result formatting — renders API values, never derives new ones
// ---------------------------------------------------------------------------

const EXIT_REASON_LABELS: Record<BacktestExitReason, string> = {
  stop_loss: 'Stop loss',
  take_profit_1: 'Take profit 1',
  take_profit_2: 'Take profit 2',
  take_profit_3: 'Take profit 3',
  max_hold: 'Max hold',
  range_end: 'Range end',
  no_levels: 'No levels',
};

export function exitReasonLabel(reason: BacktestExitReason): string {
  return EXIT_REASON_LABELS[reason] ?? String(reason);
}

export function exitReasonTone(reason: BacktestExitReason): 'success' | 'danger' | 'warning' | 'neutral' {
  if (reason.startsWith('take_profit')) return 'success';
  if (reason === 'stop_loss') return 'danger';
  if (reason === 'no_levels') return 'neutral';
  return 'warning';
}

export function isExitReason(value: string): value is BacktestExitReason {
  return (BACKTEST_EXIT_REASONS as readonly string[]).includes(value);
}

/** `+1.25R` / `-0.50R` / `0.00R`, em dash for a metric the API did not supply. */
export function formatR(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}R`;
}

/** A 0–1 rate as a percentage (`0.425` → `42.5%`); null-safe. */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

/** A plain number with fixed decimals; null-safe. */
export function formatDecimal(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** Epoch-ms → `2024-05-01 13:00 UTC` (the API's anchors are UTC epoch-ms). */
export function formatEpochMsUtc(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())} UTC`;
}

export function directionLabel(direction: BacktestDirection | 'long' | 'short'): string {
  if (direction === 'both') return 'Long + short';
  return direction === 'long' ? 'Long' : 'Short';
}

/** True when a note reports the engine's anchor cap. */
function isAnchorTruncationNote(note: string): boolean {
  return note.includes('MAX_BACKTEST_STEPS');
}

/**
 * Human-readable truncation/limit indicators, derived only from what the API
 * returned — here, the engine's anchor-cap note.
 *
 * Trade truncation is deliberately NOT part of this list: the two read
 * endpoints define `truncated` differently (`GET /:id` compares setups against
 * the stored rows, `GET /:id/trades` also compares against the requested
 * limit), so the trades table derives its own message from the response it
 * actually rendered — see `tradesTruncationMessage`.
 */
export function truncationIndicators(input: { notes: readonly string[] }): string[] {
  const out: string[] = [];
  if (input.notes.some(isAnchorTruncationNote)) {
    out.push(`Anchor limit reached — the first ${MAX_BACKTEST_STEPS} setup closes were evaluated; split the range to cover the rest.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trade paging — monotonic by construction
// ---------------------------------------------------------------------------

/** What the trades table is currently showing, plus the API's own flag. */
export interface TradesPageState {
  /** Merged trades, ascending `seq`. */
  trades: BacktestTrade[];
  /** The `truncated` flag from the response that produced `trades`. */
  truncated: boolean;
  /** The largest page size requested so far. */
  limit: TradesPageSize;
}

/**
 * Union two trade lists by `seq`, ascending.
 *
 * Paging must never shrink what the user is looking at: `GET /:id` returns
 * every stored trade while `GET /:id/trades?limit=N` returns only the first N,
 * so a naive `setTrades(response.trades)` can *remove* rows that were already
 * on screen. Merging makes a smaller response a no-op instead of a regression.
 */
export function mergeTrades(
  existing: readonly BacktestTrade[],
  incoming: readonly BacktestTrade[],
): BacktestTrade[] {
  const bySeq = new Map<number, BacktestTrade>();
  for (const t of existing) bySeq.set(t.seq, t);
  for (const t of incoming) bySeq.set(t.seq, t);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Apply one trades response to the current view. The count never decreases. */
export function applyTradesPage(
  current: TradesPageState,
  page: { trades: readonly BacktestTrade[]; truncated: boolean; limit: TradesPageSize },
): TradesPageState {
  const merged = mergeTrades(current.trades, page.trades);
  const limit = page.limit > current.limit ? page.limit : current.limit;
  return {
    trades: merged,
    // The response covering the most rows is the authority on what remains.
    // The API computes `truncated` relative to the limit it was asked for
    // (`setups > rows || setups > limit`), so a *smaller* page can report
    // `true` for a run a larger page already showed in full — adopting it here
    // would claim missing rows and offer a control that can never return one.
    // A stale smaller page (e.g. a refetch of `?limit=100` over the complete
    // detail result) therefore leaves the flag untouched.
    truncated: page.limit >= current.limit ? page.truncated : current.truncated,
    limit,
  };
}

/**
 * Whether more trades can actually be fetched.
 *
 * Driven by the API's `truncated` flag, not by comparing counts to the page
 * size: the flag is false once the response covers every stored trade, and the
 * API stores at most `MAX_BACKTEST_TRADES` per run, so asking again past that
 * bound could never return another row.
 */
export function tradesHasMore(state: { trades: readonly BacktestTrade[]; truncated: boolean }): boolean {
  return state.truncated && state.trades.length < MAX_BACKTEST_TRADES;
}

/** The next page size above what is already loaded, or undefined at the cap. */
export function nextTradesPageSize(loaded: number): TradesPageSize | undefined {
  return TRADES_PAGE_SIZES.find((size) => size > loaded);
}

/**
 * The honest caption for the trades table:
 *  - not truncated → nothing to say;
 *  - truncated below the storage cap → a page-size limitation, so more can be
 *    loaded;
 *  - truncated at the cap → the run holds more setups than the API stores, and
 *    no request can return them.
 */
export function tradesTruncationMessage(input: { truncated: boolean; loaded: number }): string | null {
  if (!input.truncated) return null;
  if (input.loaded >= MAX_BACKTEST_TRADES) {
    return `This run detected more setups than the API stores per run — at most ${MAX_BACKTEST_TRADES} trades are kept, in signal order.`;
  }
  return `Showing the first ${input.loaded} trades of this run — load more to see the rest.`;
}

/** Copy for the deterministic-replay outcome of POST /api/backtests. */
export function backtestOutcomeLabel(created: boolean): { tone: 'success' | 'info'; title: string; detail: string } {
  return created
    ? {
        tone: 'success',
        title: 'Backtest completed',
        detail: 'A new run was recorded with these exact inputs.',
      }
    : {
        tone: 'info',
        title: 'Identical run replayed',
        detail:
          'This exact configuration was already backtested, so the stored deterministic result was returned — nothing new was created.',
      };
}

/** One metric tile definition; `null` metrics render as an em dash. */
export interface MetricTile {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'success' | 'danger';
}

/**
 * The metric tiles the results UI shows, in order. Every value comes straight
 * out of `BacktestMetrics`; `totalCurrency` is only added when the caller
 * supplied `riskPerTrade` (the API returns null otherwise).
 */
export function metricTiles(metrics: BacktestMetrics, options: { showsCurrency: boolean }): MetricTile[] {
  const tiles: MetricTile[] = [
    { label: 'Setups detected', value: String(metrics.setupsDetected), hint: 'Qualifying signals, incl. no-levels' },
    { label: 'Trades closed', value: String(metrics.tradesClosed), hint: 'Any exit except no_levels' },
    {
      label: 'Wins',
      value: String(metrics.wins),
      hint: 'Closed trades with pnlR > 0',
      tone: 'success',
    },
    {
      label: 'Losses',
      value: String(metrics.losses),
      hint: 'Closed trades with pnlR < 0',
      tone: 'danger',
    },
    { label: 'Win rate', value: formatRate(metrics.winRate), hint: 'wins ÷ trades closed' },
    { label: 'Average R', value: formatR(metrics.expectancyR), hint: 'Expectancy: average R per closed trade' },
    { label: 'Avg win', value: formatR(metrics.avgWinR) },
    { label: 'Avg loss', value: formatR(metrics.avgLossR) },
    { label: 'Net result', value: formatR(metrics.totalR), hint: 'Sum of R across closed trades' },
    { label: 'Max drawdown', value: formatR(metrics.maxDrawdownR), hint: 'Peak-to-trough of cumulative R' },
    {
      label: 'Profit factor',
      value: metrics.profitFactor === null ? '—' : formatDecimal(metrics.profitFactor, 2),
      hint: metrics.profitFactor === null ? 'No losing trades — undefined' : 'gross win ÷ |gross loss|',
    },
    { label: 'Steps evaluated', value: String(metrics.stepsEvaluated), hint: 'Setup closes replayed' },
  ];
  if (options.showsCurrency) {
    tiles.push({ label: 'Total currency', value: formatDecimal(metrics.totalCurrency, 2), hint: 'pnlR × risk per trade' });
  }
  return tiles;
}

/** Default page size for the backtest list. */
export const DEFAULT_BACKTESTS_PAGE_SIZE = DEFAULT_BACKTESTS_LIMIT;

/**
 * Copy for the backtest history page, derived from the page size it actually
 * requests — so the label can never claim a larger page than the query asks
 * for (the API's own maximum is a separate fact and is stated as such).
 */
export function backtestHistoryCopy(limit: number = DEFAULT_BACKTESTS_PAGE_SIZE): {
  subtitle: string;
  footnote: string;
} {
  return {
    subtitle: `Up to the most recent ${limit} runs`,
    footnote: `This view requests the most recent ${limit} runs; the API caps a single page at ${MAX_BACKTESTS_LIMIT}.`,
  };
}
