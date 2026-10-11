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
 * (`Math.max(nowMs - lookbackMs, retentionCutoffMs(timeframe, nowMs) + 1)`).
 *
 * Clock skew: `nowMs` here is the *browser's* clock, while the API validates
 * `from` against its own (`retentionCutoffMs(timeframe, Date.now())` on the
 * server). A browser running even a few seconds behind the server computes a
 * cutoff that is *earlier* than the server's, so a start sitting exactly on the
 * browser's cutoff still breaches the server's window and the read is rejected.
 * The clamp therefore keeps `RETENTION_SAFETY_MARGIN_MS` of headroom past the
 * cutoff — comfortably beyond real-world NTP skew — so the request survives the
 * server's validation at the cost of at most one candle of history.
 */
import { retentionCutoffMs, RETENTION_DAYS, type Timeframe } from '@veltrixeye/contracts';

/**
 * Headroom kept past the retention cutoff when clamping `from`.
 *
 * The browser derives the window from its own clock and the API validates with
 * the server's; any browser that is behind the server would otherwise land on a
 * start the server considers too old. 60s dwarfs observed clock skew (NTP
 * disciplines to milliseconds) and costs at most one candle of history.
 */
export const RETENTION_SAFETY_MARGIN_MS = 60_000;

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
 * The start is clamped to the retention cutoff plus a safety margin, so the
 * result is always acceptable to the API's retention guard even when the
 * server's clock runs ahead of the browser's. Pure — `nowMs` is injected so the
 * boundary is testable.
 */
export function candleRequestRange(timeframe: Timeframe, limit: number, nowMs: number): CandleRange {
  const to = nowMs;
  const minutes = TIMEFRAME_MINUTES[timeframe] ?? 1440;
  const requestedFrom = to - limit * minutes * 60_000;
  const from = Math.max(requestedFrom, retentionCutoffMs(timeframe, to) + RETENTION_SAFETY_MARGIN_MS);
  return {
    from,
    to,
    clamped: from !== requestedFrom,
    retentionDays: RETENTION_DAYS[timeframe],
  };
}
