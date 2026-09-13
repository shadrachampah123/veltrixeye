import { z } from 'zod';
import { ProviderError } from '@veltrixeye/contracts';

export interface TwelveDataClientConfig {
  /** Server-side API key. Travels in the query string (Twelve Data's auth design) — never log it. */
  apiKey: string;
  /** REST base URL, no trailing slash. Overridable for tests. */
  baseUrl: string;
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Client-side rate cap (requests/minute). Must stay under the plan's credits/min. */
  maxRequestsPerMinute: number;
  /** Crypto venue pinned for deterministic series (e.g. "Binance"). */
  cryptoExchange: string;
  /** Throttle window in ms. Production default 60000; tests inject a small window. */
  throttleWindowMs?: number;
}

/** Minimal fetch surface the client needs (global fetch satisfies this). */
export type FetchFn = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; json(): Promise<unknown> }>;

const timeSeriesBarSchema = z
  .object({
    datetime: z.string().min(1),
    open: z.string().min(1),
    high: z.string().min(1),
    low: z.string().min(1),
    close: z.string().min(1),
    volume: z.string().optional(),
  })
  .passthrough();

const timeSeriesOkSchema = z
  .object({
    meta: z
      .object({
        symbol: z.string(),
        interval: z.string(),
        exchange: z.string().optional(),
        exchange_timezone: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough(),
    values: z.array(timeSeriesBarSchema),
  })
  .passthrough();

const errorSchema = z.object({ status: z.literal('error'), message: z.string(), code: z.number() }).passthrough();

const symbolSearchSchema = z
  .object({
    data: z.array(
      z
        .object({
          symbol: z.string(),
          instrument_name: z.string(),
          exchange: z.string().optional(),
          exchange_timezone: z.string().optional(),
          instrument_type: z.string().optional(),
          country: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface TimeSeriesBar {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

export interface TimeSeriesPage {
  symbol: string;
  interval: string;
  exchangeTimezone: string | undefined;
  bars: TimeSeriesBar[];
}

export interface SymbolSearchRow {
  symbol: string;
  name: string;
  type: string;
  exchange: string | undefined;
}

/**
 * Thin Twelve Data REST client: request shaping, response validation, error
 * mapping, timeouts, and client-side rate throttling. All vendor quirks
 * (query-string auth, stringly numbers, error envelopes) stay inside this
 * file; callers see typed pages and ProviderError failures.
 */
export class TwelveDataClient {
  private readonly requestTimes: number[] = [];

  constructor(
    private readonly config: TwelveDataClientConfig,
    private readonly fetchFn: FetchFn = ((url: string, init: { signal: AbortSignal; headers: Record<string, string> }) =>
      fetch(url, init)) as FetchFn,
  ) {
    if (config.apiKey === '') throw new Error('TwelveDataClient: apiKey must not be empty');
    if (config.maxRequestsPerMinute < 1) throw new Error('TwelveDataClient: maxRequestsPerMinute must be ≥ 1');
  }

  /** One time_series page (≤5000 values, ascending). Callers page across ranges. */
  async timeSeries(params: {
    symbol: string;
    interval: string;
    startDate: string;
    endDate: string;
    exchange?: string;
  }): Promise<TimeSeriesPage> {
    const query: Record<string, string> = {
      symbol: params.symbol,
      interval: params.interval,
      start_date: params.startDate,
      end_date: params.endDate,
      order: 'ASC',
      apikey: this.config.apiKey,
    };
    if (params.exchange !== undefined) query['exchange'] = params.exchange;
    const json = await this.get('/time_series', query);
    const parsed = timeSeriesOkSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError('unavailable', 'Market-data provider returned an unexpected response shape');
    }
    return {
      symbol: parsed.data.meta.symbol,
      interval: parsed.data.meta.interval,
      exchangeTimezone: parsed.data.meta.exchange_timezone,
      bars: parsed.data.values,
    };
  }

  /** Symbol discovery (bounded by the caller). */
  async symbolSearch(search: string, outputsize: number): Promise<SymbolSearchRow[]> {
    const json = await this.get('/symbol_search', {
      symbol: search,
      outputsize: String(outputsize),
      apikey: this.config.apiKey,
    });
    const parsed = symbolSearchSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError('unavailable', 'Market-data provider returned an unexpected response shape');
    }
    return parsed.data.data.map((r) => ({
      symbol: r.symbol,
      name: r.instrument_name,
      type: r.instrument_type ?? '',
      exchange: r.exchange,
    }));
  }

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    await this.throttle();
    const url = `${this.config.baseUrl}${path}?${new URLSearchParams(query).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (res.status === 429) {
        throw new ProviderError('rate_limited', 'Market-data provider rate limit reached. Try again shortly.');
      }
      if (res.status >= 500) {
        throw new ProviderError('unavailable', 'Market-data provider is temporarily unavailable. Try again shortly.');
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ProviderError('unavailable', 'Market-data provider returned an unreadable response');
      }
      const err = errorSchema.safeParse(json);
      if (err.success) throw this.mapVendorError(err.data.code);
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError('unauthorized', 'Market-data provider credentials were rejected');
      }
      if (res.status === 404) {
        throw new ProviderError('not_found', 'Instrument is unknown to the market-data provider');
      }
      if (res.status >= 400) {
        throw new ProviderError('unavailable', 'Market-data provider rejected the request');
      }
      return json;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError('unavailable', 'Market-data provider timed out. Try again shortly.', { cause: err });
      }
      // Network/DNS/TLS failures: upstream is unreachable, never our bug to leak.
      throw new ProviderError('unavailable', 'Market-data provider is temporarily unavailable. Try again shortly.', {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private mapVendorError(code: number): ProviderError {
    if (code === 400) return new ProviderError('invalid_request', 'Market-data provider rejected the request parameters');
    if (code === 401) return new ProviderError('unauthorized', 'Market-data provider credentials were rejected');
    if (code === 404) return new ProviderError('not_found', 'Instrument is unknown to the market-data provider');
    if (code === 429) return new ProviderError('rate_limited', 'Market-data provider rate limit reached. Try again shortly.');
    return new ProviderError('unavailable', 'Market-data provider is temporarily unavailable. Try again shortly.');
  }

  /** Token bucket: at most maxRequestsPerMinute calls per rolling window. */
  private async throttle(): Promise<void> {
    const windowMs = this.config.throttleWindowMs ?? 60_000;
    for (;;) {
      const cutoff = Date.now() - windowMs;
      while (this.requestTimes.length > 0 && (this.requestTimes[0] ?? 0) <= cutoff) {
        this.requestTimes.shift();
      }
      if (this.requestTimes.length < this.config.maxRequestsPerMinute) break;
      const oldest = this.requestTimes[0] ?? Date.now();
      const waitMs = Math.max(0, oldest + windowMs - Date.now()) + 5;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.requestTimes.push(Date.now());
  }
}
