import type pg from 'pg';
import {
  STALE_THRESHOLDS_MS,
  type Timeframe,
} from '@veltrixeye/contracts';
import type { PaperCandle } from './paper-engine.js';

/**
 * M8.3 — the ONE market-price interface the paper simulator may consume.
 *
 * Rules this interface exists to enforce:
 *  - prices come from the platform's existing shared candle store (`candles`,
 *    written by the M2/M7 ingestion layer). M8.3 introduces NO second
 *    market-data provider and makes NO external provider call;
 *  - a client can never supply a price, a fill or a P&L: nothing on this
 *    interface accepts caller-provided numbers;
 *  - price and timestamp are validated (positive, finite, not in the future)
 *    and staleness is judged by the EXISTING M7.5 freshness policy
 *    (`STALE_THRESHOLDS_MS` per timeframe) — stale data refuses the fill
 *    instead of producing one from old prices;
 *  - reads are deterministic: the latest candle at or before the evaluation
 *    instant, in ascending order, bounded by the caller.
 */

export interface SimulatorMarketPrice {
  price: number;
  /** Candle open time (epoch ms) the price came from. */
  timeMs: number;
  /** nowMs − timeMs, already validated as ≥ 0. */
  ageMs: number;
  thresholdMs: number;
  timeframe: Timeframe;
  /** Provenance tag for events/audit; there is exactly one source today. */
  source: 'candle_store';
}

export type MarketPriceResult =
  | { ok: true; price: SimulatorMarketPrice }
  | { ok: false; reason: string; invalidData: boolean; stale: boolean };

export interface SimulatorMarketPriceSource {
  /** Latest usable close at or before `nowMs`, freshness-checked. */
  latestPrice(args: {
    instrumentId: string;
    timeframe: Timeframe;
    nowMs: number;
  }): Promise<MarketPriceResult>;
  /** Usable candles in `(sinceMs, nowMs]`, ascending — the SL/TP path. */
  candlesSince(args: {
    instrumentId: string;
    timeframe: Timeframe;
    sinceMs: number;
    nowMs: number;
    limit: number;
  }): Promise<PaperCandle[]>;
}

/** Freshness threshold for a timeframe, with the M7.5 fallback rule. */
export function paperStaleThresholdMs(timeframe: Timeframe): number {
  const configured = STALE_THRESHOLDS_MS[timeframe];
  if (typeof configured === 'number' && configured > 0) return configured;
  // Fallback matches the M7.5 rule: three bars.
  const minutes = Number(timeframe.replace(/[^0-9]/g, '')) || 60;
  return minutes * 60_000 * 3;
}

interface CandleRow {
  ts: string;
  open: string;
  high: string;
  low: string;
  close: string;
}

function usable(row: CandleRow): PaperCandle | null {
  const time = Number(row.ts);
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  if (!Number.isFinite(time) || time <= 0) return null;
  if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }
  if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null;
  if (high < low) return null;
  return { time, open, high, low, close };
}

/**
 * Default source: the shared `candles` store, read-only, owner-agnostic
 * (market data belongs to no user — exactly like every other consumer).
 */
export class CandleStoreMarketPriceSource implements SimulatorMarketPriceSource {
  constructor(private readonly pool: pg.Pool) {}

  async latestPrice(args: {
    instrumentId: string;
    timeframe: Timeframe;
    nowMs: number;
  }): Promise<MarketPriceResult> {
    const thresholdMs = paperStaleThresholdMs(args.timeframe);
    const res = await this.pool.query<CandleRow>(
      `SELECT ts, open, high, low, close FROM candles
        WHERE instrument_id = $1 AND timeframe = $2 AND ts <= $3
        ORDER BY ts DESC LIMIT 5`,
      [args.instrumentId, args.timeframe, args.nowMs],
    );
    if (res.rows.length === 0) {
      return {
        ok: false,
        reason: `no market data for timeframe "${args.timeframe}"`,
        invalidData: false,
        stale: false,
      };
    }
    // Walk back over any malformed rows rather than trusting the newest one.
    for (const row of res.rows) {
      const candle = usable(row);
      if (!candle) continue;
      const ageMs = args.nowMs - candle.time;
      if (ageMs < 0) {
        return {
          ok: false,
          reason: 'market data timestamp is in the future (clock skew)',
          invalidData: true,
          stale: false,
        };
      }
      if (ageMs > thresholdMs) {
        return {
          ok: false,
          reason: `market data is stale (${Math.round(ageMs / 1000)}s old, limit ${Math.round(thresholdMs / 1000)}s)`,
          invalidData: false,
          stale: true,
        };
      }
      return {
        ok: true,
        price: {
          price: candle.close,
          timeMs: candle.time,
          ageMs,
          thresholdMs,
          timeframe: args.timeframe,
          source: 'candle_store',
        },
      };
    }
    return {
      ok: false,
      reason: 'market data is invalid (non-positive or inverted OHLC)',
      invalidData: true,
      stale: false,
    };
  }

  async candlesSince(args: {
    instrumentId: string;
    timeframe: Timeframe;
    sinceMs: number;
    nowMs: number;
    limit: number;
  }): Promise<PaperCandle[]> {
    const res = await this.pool.query<CandleRow>(
      `SELECT ts, open, high, low, close FROM candles
        WHERE instrument_id = $1 AND timeframe = $2 AND ts > $3 AND ts <= $4
        ORDER BY ts ASC LIMIT $5`,
      [args.instrumentId, args.timeframe, args.sinceMs, args.nowMs, Math.max(1, args.limit)],
    );
    const candles: PaperCandle[] = [];
    for (const row of res.rows) {
      const candle = usable(row);
      if (candle) candles.push(candle);
    }
    return candles;
  }
}
