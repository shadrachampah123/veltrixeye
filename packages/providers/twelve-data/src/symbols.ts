import { ProviderError, type AssetClass, type Timeframe } from '@veltrixeye/contracts';

/**
 * Twelve Data native `time_series` intervals. Canonical timeframes missing
 * from this table are served by deterministic resampling (RESAMPLE_PLANS),
 * so the provider honestly serves every canonical timeframe.
 */
export const NATIVE_INTERVALS: Record<string, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '8h': '8h',
  '1d': '1day',
  '1w': '1week',
  '1M': '1month',
};

export interface ResamplePlan {
  /** Native source interval to fetch. */
  source: Timeframe;
  /** Source buckets per target bucket. */
  factor: number;
}

/** Non-native canonical timeframes: fetch `source`, aggregate `factor` buckets. */
export const RESAMPLE_PLANS: Partial<Record<Timeframe, ResamplePlan>> = {
  '3m': { source: '1m', factor: 3 },
  '12h': { source: '1h', factor: 12 },
  '3d': { source: '1d', factor: 3 },
};

export type IntervalPlan =
  | { kind: 'native'; interval: string }
  | { kind: 'resample'; interval: string; source: Timeframe; factor: number };

/** Resolve how a canonical timeframe is served (native or resampled). */
export function intervalPlan(timeframe: Timeframe): IntervalPlan {
  const native = NATIVE_INTERVALS[timeframe];
  if (native !== undefined) return { kind: 'native', interval: native };
  const plan = RESAMPLE_PLANS[timeframe];
  if (plan === undefined) {
    throw new ProviderError('invalid_request', `Timeframe "${timeframe}" is not servable by this provider`);
  }
  const sourceInterval = NATIVE_INTERVALS[plan.source];
  if (sourceInterval === undefined) {
    throw new ProviderError('unavailable', 'Market-data provider interval table is misconfigured');
  }
  return { kind: 'resample', interval: sourceInterval, source: plan.source, factor: plan.factor };
}

/**
 * Map a normalized instrument to its Twelve Data symbol.
 *
 *  - forex / crypto / commodity: Twelve Data quotes "BASE/QUOTE"
 *    (EUR/USD, USD/JPY, BTC/USD, XAU/USD). Normalized symbols carry no
 *    slash, so a leading or trailing USD leg is split off; anything else
 *    must already contain a slash (non-USD crosses are out of scope in M2).
 *  - stock / etf / index / other: the symbol itself (AAPL, SPY).
 */
export function toTwelveSymbol(assetClass: AssetClass, symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  if (upper === '') {
    throw new ProviderError('invalid_request', 'Instrument symbol must not be empty');
  }
  if (assetClass === 'stock' || assetClass === 'etf' || assetClass === 'index' || assetClass === 'other') {
    return upper;
  }
  if (upper.includes('/')) return upper;
  if (upper.length > 3 && upper.startsWith('USD')) {
    return `USD/${upper.slice(3)}`;
  }
  if (upper.length > 3 && upper.endsWith('USD')) {
    return `${upper.slice(0, -3)}/USD`;
  }
  throw new ProviderError(
    'invalid_request',
    `Cannot map instrument "${assetClass}/${symbol}" to a Twelve Data symbol`,
  );
}

/** Map a Twelve Data symbol back to normalized form (slash removed, uppercased). */
export function fromTwelveSymbol(symbol: string): string {
  return symbol.replace('/', '').toUpperCase();
}
