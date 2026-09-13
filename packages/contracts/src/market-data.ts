import type { Timeframe } from './timeframes.js';
import type { NormalizedInstrument } from './assets.js';

/**
 * Market-data provider abstraction (interfaces & types only — M1).
 *
 * ARCHITECTURE RULE (enforced by convention, documented in
 * docs/provider-abstraction.md): everything inside VeltrixEye's domain
 * (strategy engine, scanner, backtester, scoring) depends ONLY on the
 * interfaces and normalized types in this file. Provider-specific symbol
 * strings, API quirks, rate-limit logic and licensing constraints belong
 * exclusively inside a provider implementation.
 *
 * A provider implementation lives outside the domain (e.g. a future
 * `packages/providers/<name>` package) and registers itself with the
 * ProviderRegistry in `packages/core`.
 */

/** Provider-agnostic OHLCV candle. Timestamps are epoch milliseconds (UTC). */
export interface Candle {
  /** Candle open time, epoch ms (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume where the market reports it (e.g. spot FX tick volume may be null). */
  volume: number | null;
  state: 'closed' | 'forming';
}

export interface HistoricalCandlesRequest {
  instrument: NormalizedInstrument;
  timeframe: Timeframe;
  /** Inclusive start, epoch ms (UTC). */
  from: number;
  /** Exclusive end, epoch ms (UTC). */
  to: number;
}

export interface RealtimeSubscription {
  instruments: NormalizedInstrument[];
  timeframe: Timeframe;
  /** Receive an update when the forming candle changes. */
  includeForming?: boolean;
}

/** A live candle feed. Must be cancellable via close(). */
export interface RealtimeCandleStream extends AsyncIterable<Candle> {
  close(): Promise<void>;
}

export interface TradingSession {
  /** Provider-independent session name, e.g. 'london'. */
  name: string;
  /** Local open/close as "HH:mm" in `timezone`. */
  open: string;
  close: string;
  timezone: 'utc' | 'exchange';
  /** ISO-8601 timestamp of the next open, if computable. */
  nextOpenAt?: string;
}

export type MarketState = 'open' | 'closed' | 'pre_market' | 'post_market' | 'unknown';

export interface MarketStatus {
  instrument: NormalizedInstrument;
  state: MarketState;
  nextOpenAt?: string;
  nextCloseAt?: string;
}

export interface SymbolQuery {
  assetClass?: NormalizedInstrument['assetClass'];
  /** Loose filter over normalized/display names. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ProviderCapabilities {
  historical: boolean;
  realtime: boolean;
  /** Canonical timeframes this provider can serve. */
  timeframes: readonly Timeframe[];
  /** Max historical lookback in days (Infinity for unlimited). */
  maxLookbackDays: number;
}

/**
 * The single interface every market-data provider must implement.
 *
 * - getHistoricalCandles(): bounded historical OHLCV data
 * - subscribeRealtime(): live candle stream
 * - getSymbols(): instrument discovery (normalized, provider-agnostic)
 * - getTradingSessions(): session calendar for an instrument
 * - getMarketStatus(): open/closed state for an instrument
 */
export interface MarketDataProvider {
  /** Stable machine id, e.g. "twelve-data". Never change once released. */
  readonly id: string;
  /** Human-readable name, e.g. "Twelve Data". */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  getSymbols(query?: SymbolQuery): Promise<NormalizedInstrument[]>;
  getHistoricalCandles(request: HistoricalCandlesRequest): Promise<Candle[]>;
  subscribeRealtime(subscription: RealtimeSubscription): RealtimeCandleStream;
  getTradingSessions(instrument: NormalizedInstrument): Promise<TradingSession[]>;
  getMarketStatus(instrument: NormalizedInstrument): Promise<MarketStatus>;
}

/**
 * Provider-agnostic failure thrown by MarketDataProvider implementations.
 * The message is user-safe (no API keys, URLs, or vendor internals); detail
 * for operators goes to `cause`. Core maps `kind` to domain errors:
 *
 *  - rate_limited   → 429 rate_limited (caller should back off + retry)
 *  - invalid_request → 400 invalid_input (bad symbol/range the caller sent)
 *  - not_found      → 404 not_found (unknown instrument at the provider)
 *  - unavailable | unauthorized → 502 provider_unavailable (upstream or
 *    server-side credential problem; `unauthorized` additionally means the
 *    operator must check the provider API key)
 */
export type ProviderFailureKind = 'unavailable' | 'rate_limited' | 'invalid_request' | 'not_found' | 'unauthorized';

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;

  constructor(kind: ProviderFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}
