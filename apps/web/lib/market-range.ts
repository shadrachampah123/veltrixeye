/**
 * Historical-candles request window (M2 market data).
 *
 * The instrument page asks for `limit` candles at a chosen timeframe and
 * derives a start time from that span. Retention, however, caps how far back
 * ANY read may reach (see `RETENTION_DAYS` in `@veltrixeye/contracts`), and the
 * API rejects a range that starts before the cutoff rather than silently
 * truncating it (`assertWithinRetention` throws `invalidInput`).
 *
 * Several perfectly ordinary selections therefore used to fail outright —
 * 5,000 daily candles spans ~13.7 years against a 1,825-day cap, and 5,000
 * 4-hour candles spans ~833 days against a 365-day cap. Clamping the start to
 * the retention cutoff keeps those selections usable: the UI shows the most
 * recent candles the store is allowed to hold and reports that the window was
 * shortened, instead of surfacing a validation error as if the request were
 * malformed.
 *
 * This mirrors the clamp the scheduled warmer already applies
 * (`Math.max(nowMs - lookbackMs, retentionCutoff + 1)`).
 */
import { retentionCutoffMs, RETENTION_DAYS, type Timeframe } from '@veltrixeye/contracts';

/** Minutes per bar for every canonical timeframe. */
export const TIMEFRAME_MINUTES: Record<string, number> = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '8h': 480,
  '12h': 720,
  '1d': 1440,
  '3d': 4320,
  '1w': 10080,
  '1M': 43200,
};

/** A resolved [from, to) window for a candles read, both epoch-ms (UTC). */
export interface CandleRange {
  from: number;
  to: number;
  /** True when retention shortened the requested span. */
  clamped: boolean;
  /** Maximum lookback in days for `timeframe` (the cap that was applied). */
  retentionDays: number;
}

/**
 * Resolve the window for a read of `limit` candles at `timeframe` ending now.
 *
 * The start is clamped to the retention cutoff, so the result is always
 * acceptable to the API's retention guard. Pure — `nowMs` is injected so the
 * boundary is testable.
 */
export function candleRequestRange(timeframe: Timeframe, limit: number, nowMs: number): CandleRange {
  const to = nowMs;
  const minutes = TIMEFRAME_MINUTES[timeframe] ?? 1440;
  const requestedFrom = to - limit * minutes * 60_000;
  const from = Math.max(requestedFrom, retentionCutoffMs(timeframe, to));
  return {
    from,
    to,
    clamped: from !== requestedFrom,
    retentionDays: RETENTION_DAYS[timeframe],
  };
}
