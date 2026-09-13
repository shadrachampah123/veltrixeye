import {
  TIMEFRAMES,
  ProviderError,
  timeframeMinutes,
  type Candle,
  type HistoricalCandlesRequest,
  type MarketDataProvider,
  type MarketStatus,
  type NormalizedInstrument,
  type ProviderCapabilities,
  type RealtimeCandleStream,
  type RealtimeSubscription,
  type SymbolQuery,
  type TradingSession,
  type AssetClass,
} from '@veltrixeye/contracts';
import { TwelveDataClient, type TwelveDataClientConfig } from './client.js';
import { intervalPlan, toTwelveSymbol, fromTwelveSymbol } from './symbols.js';
import { resampleCandles } from './resample.js';
import { twelveDateTimeToMs, formatTwelveDate } from './datetime.js';

export const TWELVE_DATA_PROVIDER_ID = 'twelve-data';
/** Vendor page size: at most 5000 values per time_series request. */
export const TWELVE_DATA_PAGE_SIZE = 5000;
/**
 * Honest lookback floor: 1-minute bars exist from 2020-02-10; daily bars run
 * to first listing. The single-number capability reports the floor so no
 * caller plans a range the vendor cannot serve.
 */
export const TWELVE_DATA_MAX_LOOKBACK_DAYS = 2190;
/** Absolute page guard so a misbehaving upstream can never loop forever. */
const MAX_PAGES_PER_CALL = 200;

/**
 * Twelve Data market-data provider (M2 primary: historical OHLCV only).
 *
 *  - Serves every canonical timeframe: native vendor intervals where they
 *    exist (1m…1M), deterministic epoch-aligned resampling otherwise
 *    (3m ← 1m, 12h ← 1h, 3d ← 1d).
 *  - Crypto series are pinned to one venue (config.cryptoExchange) so the
 *    stored series is deterministic. Changing the venue later defines a
 *    different series — see the package README.
 *  - Realtime is disabled (capabilities.realtime === false); M2 is
 *    historical-only by approved scope.
 *  - No session calendar or market-state endpoint exists upstream, so
 *    getTradingSessions returns [] and getMarketStatus returns 'unknown'
 *    (honest, never fabricated). M3 sources sessions elsewhere.
 */
export class TwelveDataProvider implements MarketDataProvider {
  readonly id = TWELVE_DATA_PROVIDER_ID;
  readonly name = 'Twelve Data';
  readonly capabilities: ProviderCapabilities = {
    historical: true,
    realtime: false,
    timeframes: TIMEFRAMES,
    maxLookbackDays: TWELVE_DATA_MAX_LOOKBACK_DAYS,
  };

  constructor(private readonly client: TwelveDataClient, private readonly cryptoExchange: string) {}

  async getHistoricalCandles(request: HistoricalCandlesRequest): Promise<Candle[]> {
    if (!Number.isInteger(request.from) || !Number.isInteger(request.to) || request.from >= request.to) {
      throw new ProviderError('invalid_request', 'Candle range must satisfy from < to (epoch-ms)');
    }
    const symbol = toTwelveSymbol(request.instrument.assetClass, request.instrument.symbol);
    const plan = intervalPlan(request.timeframe);
    const sourceMinutes =
      plan.kind === 'native' ? timeframeMinutes(request.timeframe) : timeframeMinutes(plan.source);
    const exchange = request.instrument.assetClass === 'crypto' ? this.cryptoExchange : undefined;

    const source = await this.fetchSourceRange(symbol, plan.interval, request.from, request.to, exchange);
    const candles = plan.kind === 'native' ? source : resampleCandles(source, sourceMinutes * 60_000, plan.factor);
    // Vendor bounds are inclusive; the contract is [from, to).
    return candles.filter((c) => c.time >= request.from && c.time < request.to);
  }

  async getSymbols(query?: SymbolQuery): Promise<NormalizedInstrument[]> {
    if (!query?.search || query.search.trim() === '') return [];
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
    const rows = await this.client.symbolSearch(query.search.trim(), limit + (query.offset ?? 0));
    const mapped: NormalizedInstrument[] = [];
    for (const row of rows) {
      const assetClass = mapInstrumentType(row.type);
      if (query.assetClass !== undefined && assetClass !== query.assetClass) continue;
      const symbol = fromTwelveSymbol(row.symbol);
      if (!/^[A-Z0-9][A-Z0-9._:-]*$/.test(symbol) || symbol.length > 32) continue;
      mapped.push({ assetClass, symbol, displayName: row.name.slice(0, 80) });
    }
    const offset = Math.max(query.offset ?? 0, 0);
    return mapped.slice(offset, offset + limit);
  }

  subscribeRealtime(_subscription: RealtimeSubscription): RealtimeCandleStream {
    // Programmer error, not a runtime failure: capabilities.realtime is false.
    throw new Error('TwelveDataProvider: realtime streaming is not available (M2 is historical-only)');
  }

  async getTradingSessions(_instrument: NormalizedInstrument): Promise<TradingSession[]> {
    // Twelve Data exposes no session calendar. Returning [] is honest;
    // fabricating London/NY hours here would poison future evaluation.
    return [];
  }

  async getMarketStatus(instrument: NormalizedInstrument): Promise<MarketStatus> {
    return { instrument, state: 'unknown' };
  }

  /** Fetch [from, to) in vendor pages, validate every bar, dedupe by time. */
  private async fetchSourceRange(
    symbol: string,
    interval: string,
    from: number,
    to: number,
    exchange: string | undefined,
  ): Promise<Candle[]> {
    const chunkMs = sourceChunkMs(interval);
    const byTime = new Map<number, Candle>();
    let cursor = from;
    let lastProgress = -1;
    for (let page = 0; page < MAX_PAGES_PER_CALL && cursor < to; page += 1) {
      const end = Math.min(to, cursor + chunkMs);
      const result = await this.client.timeSeries({
        symbol,
        interval,
        startDate: formatTwelveDate(cursor),
        endDate: formatTwelveDate(end),
        exchange,
      });
      if (result.bars.length === 0) break;
      let pageLast = -1;
      for (const bar of result.bars) {
        const time = twelveDateTimeToMs(bar.datetime, result.exchangeTimezone);
        if (time < from || time >= to) continue;
        byTime.set(time, toCandle(bar, time));
        if (time > pageLast) pageLast = time;
      }
      if (pageLast < 0) break; // page carried no in-window bars — nothing more to page
      if (pageLast <= lastProgress) break; // no forward progress — never loop forever
      lastProgress = pageLast;
      if (result.bars.length < TWELVE_DATA_PAGE_SIZE) break; // short page = range exhausted
      // Full page: there may be more bars at/after the last timestamp.
      cursor = pageLast + 1;
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }
}

/** Vendor chunk per page: 5000 source bars (calendar-approximated for day+). */
function sourceChunkMs(interval: string): number {
  const minutes: Record<string, number> = {
    '1min': 1,
    '5min': 5,
    '15min': 15,
    '30min': 30,
    '1h': 60,
    '2h': 120,
    '4h': 240,
    '8h': 480,
    '1day': 1440,
    '1week': 10080,
    '1month': 43200,
  };
  const m = minutes[interval] ?? 1440;
  return m * 60_000 * TWELVE_DATA_PAGE_SIZE;
}

function toCandle(
  bar: { datetime: string; open: string; high: string; low: string; close: string; volume?: string },
  time: number,
): Candle {
  const open = Number(bar.open);
  const high = Number(bar.high);
  const low = Number(bar.low);
  const close = Number(bar.close);
  const volume = bar.volume === undefined || bar.volume === '' ? null : Number(bar.volume);
  const finite = [open, high, low, close].every((n) => Number.isFinite(n));
  const sane =
    finite &&
    open > 0 &&
    high > 0 &&
    low > 0 &&
    close > 0 &&
    low <= Math.min(open, close) &&
    high >= Math.max(open, close) &&
    (volume === null || (Number.isFinite(volume) && volume >= 0));
  if (!sane) {
    // Data-integrity failure: persist nothing, fail the call loudly.
    throw new ProviderError('unavailable', 'Market-data provider returned an invalid price bar');
  }
  return { time, open, high, low, close, volume, state: 'closed' };
}

function mapInstrumentType(type: string): AssetClass {
  const t = type.toLowerCase();
  if (t.includes('forex') || t.includes('fx') || t.includes('currency')) return 'forex';
  if (t.includes('crypto') || t.includes('digital')) return 'crypto';
  if (t.includes('etf') || t.includes('fund')) return 'etf';
  if (t.includes('commodity') || t.includes('metal') || t.includes('energy')) return 'commodity';
  if (t.includes('index')) return 'index';
  if (t.includes('stock') || t.includes('equity') || t.includes('share') || t.includes('adr') || t.includes('common')) {
    return 'stock';
  }
  return 'other';
}

export function createTwelveDataProvider(config: TwelveDataClientConfig): TwelveDataProvider {
  return new TwelveDataProvider(new TwelveDataClient(config), config.cryptoExchange);
}
