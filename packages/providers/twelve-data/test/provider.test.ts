import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isProviderError, type ProviderFailureKind } from '@veltrixeye/contracts';
import { TwelveDataClient, type FetchFn } from '../src/client.js';
import { TwelveDataProvider } from '../src/provider.js';

// ---------------------------------------------------------------------------
// Mock fetch harness (no network)
// ---------------------------------------------------------------------------

type Handler = (url: URL) => { status: number; body: unknown };

const ok = (body: unknown) => ({ status: 200, body });

function makeFetch(handler: Handler, seen: URL[] = []): FetchFn {
  return (async (url: string) => {
    const parsed = new URL(url);
    seen.push(parsed);
    const { status, body } = handler(parsed);
    return { status, json: async () => body };
  }) as FetchFn;
}

function wire(handler: Handler, seen: URL[] = []): { provider: TwelveDataProvider; seen: URL[] } {
  const client = new TwelveDataClient(
    {
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      timeoutMs: 1000,
      maxRequestsPerMinute: 100_000, // no throttle in tests
      cryptoExchange: 'Binance',
    },
    makeFetch(handler, seen),
  );
  return { provider: new TwelveDataProvider(client, 'Binance'), seen };
}

function timeSeriesBody(values: unknown[], extraMeta: Record<string, unknown> = {}) {
  return {
    meta: {
      symbol: 'EUR/USD',
      interval: '1day',
      exchange_timezone: 'UTC',
      ...extraMeta,
    },
    values,
    status: 'ok',
  };
}

function value(datetime: string, open: string, high = open, low = open, close = open, volume?: string) {
  return { datetime, open, high, low, close, ...(volume === undefined ? {} : { volume }) };
}

function day(datetime: string, o: string, h: string, l: string, c: string, volume?: string) {
  return value(datetime, o, h, l, c, volume);
}

const EURUSD = { assetClass: 'forex' as const, symbol: 'EURUSD' };

// ---------------------------------------------------------------------------
// Capabilities + discovery + honest gaps
// ---------------------------------------------------------------------------

test('provider: capabilities are historical-only with full timeframe coverage', () => {
  const { provider } = wire(() => ({ status: 200, body: {} }));
  assert.equal(provider.id, 'twelve-data');
  assert.equal(provider.name, 'Twelve Data');
  assert.equal(provider.capabilities.historical, true);
  assert.equal(provider.capabilities.realtime, false);
  assert.equal(provider.capabilities.timeframes.length, 14);
  assert.ok(provider.capabilities.maxLookbackDays >= 2190);
});

test('provider: getSymbols returns [] without a search; maps vendor rows otherwise', async () => {
  const { provider } = wire((url) => {
    assert.ok(url.pathname.endsWith('/symbol_search'));
    return {
      status: 200,
      body: {
        data: [
          { symbol: 'EUR/USD', instrument_name: 'Euro/US Dollar', instrument_type: 'Physical Currency' },
          { symbol: 'AAPL', instrument_name: 'Apple Inc', instrument_type: 'Common Stock' },
        ],
      },
    };
  });
  assert.deepEqual(await provider.getSymbols(), []);
  assert.deepEqual(await provider.getSymbols({ search: '   ' }), []);

  const all = await provider.getSymbols({ search: 'a' });
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { assetClass: 'forex', symbol: 'EURUSD', displayName: 'Euro/US Dollar' });
  assert.deepEqual(all[1], { assetClass: 'stock', symbol: 'AAPL', displayName: 'Apple Inc' });

  const stocks = await provider.getSymbols({ search: 'a', assetClass: 'stock' });
  assert.equal(stocks.length, 1);
  assert.equal(stocks[0]!.symbol, 'AAPL');

  const paged = await provider.getSymbols({ search: 'a', limit: 1, offset: 1 });
  assert.equal(paged.length, 1);
  assert.equal(paged[0]!.symbol, 'AAPL');
});

test('provider: sessions/status/subscribe gaps are honest, not fabricated', async () => {
  const { provider } = wire(() => ({ status: 200, body: {} }));
  assert.deepEqual(await provider.getTradingSessions(EURUSD), []);
  const status = await provider.getMarketStatus(EURUSD);
  assert.equal(status.state, 'unknown');
  assert.deepEqual(status.instrument, EURUSD);
  assert.throws(
    () => provider.subscribeRealtime({ instruments: [EURUSD], timeframe: '1d' }),
    /historical-only/,
  );
});

// ---------------------------------------------------------------------------
// getHistoricalCandles
// ---------------------------------------------------------------------------

test('provider: parses vendor bars into ascending normalized candles', async () => {
  const { provider } = wire(() =>
    ok(
      timeSeriesBody([
        day('2026-09-11', '1.18', '1.19', '1.17', '1.185'),
        day('2026-09-10', '1.17', '1.18', '1.16', '1.175'),
        day('2026-09-09', '1.16', '1.17', '1.15', '1.165'),
      ]),
    ),
  );
  const candles = await provider.getHistoricalCandles({
    instrument: EURUSD,
    timeframe: '1d',
    from: Date.UTC(2026, 8, 9),
    to: Date.UTC(2026, 8, 12),
  });
  assert.equal(candles.length, 3);
  assert.deepEqual(
    candles.map((c) => c.time),
    [Date.UTC(2026, 8, 9), Date.UTC(2026, 8, 10), Date.UTC(2026, 8, 11)],
  );
  assert.deepEqual(candles[0], {
    time: Date.UTC(2026, 8, 9),
    open: 1.16,
    high: 1.17,
    low: 1.15,
    close: 1.165,
    volume: null, // FX reports no volume
    state: 'closed',
  });
});

test('provider: enforces the [from, to) window', async () => {
  const { provider } = wire(() =>
    ok(
      timeSeriesBody([
        day('2026-09-11', '1.18', '1.19', '1.17', '1.185'),
        day('2026-09-10', '1.17', '1.18', '1.16', '1.175'),
        day('2026-09-09', '1.16', '1.17', '1.15', '1.165'),
      ]),
    ),
  );
  const candles = await provider.getHistoricalCandles({
    instrument: EURUSD,
    timeframe: '1d',
    from: Date.UTC(2026, 8, 10),
    to: Date.UTC(2026, 8, 11), // excludes the 11th (to-exclusive)
  });
  assert.deepEqual(
    candles.map((c) => c.time),
    [Date.UTC(2026, 8, 10)],
  );
});

test('provider: request shape, symbols, and crypto venue pinning on the wire', async () => {
  const seen: URL[] = [];
  const { provider } = wire(() => ok(timeSeriesBody([])), seen);
  await provider.getHistoricalCandles({
    instrument: { assetClass: 'crypto', symbol: 'BTCUSD' },
    timeframe: '1d',
    from: 0,
    to: 1,
  });
  await provider.getHistoricalCandles({ instrument: { assetClass: 'stock', symbol: 'AAPL' }, timeframe: '1d', from: 0, to: 1 });
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.pathname.endsWith('/time_series'));
  assert.equal(seen[0]!.searchParams.get('symbol'), 'BTC/USD');
  assert.equal(seen[0]!.searchParams.get('interval'), '1day');
  assert.equal(seen[0]!.searchParams.get('order'), 'ASC');
  assert.equal(seen[0]!.searchParams.get('exchange'), 'Binance');
  assert.equal(seen[0]!.searchParams.get('apikey'), 'test-key');
  assert.ok(seen[0]!.searchParams.get('start_date'));
  assert.ok(seen[0]!.searchParams.get('end_date'));
  assert.equal(seen[1]!.searchParams.get('exchange'), null);
  assert.equal(seen[1]!.searchParams.get('symbol'), 'AAPL');
});

test('provider: invalid range and unmappable symbol fail fast (no HTTP)', async () => {
  const seen: URL[] = [];
  const { provider } = wire(() => ok(timeSeriesBody([])), seen);
  await assert.rejects(
    () => provider.getHistoricalCandles({ instrument: EURUSD, timeframe: '1d', from: 5, to: 5 }),
    (e: unknown) => isProviderError(e) && e.kind === 'invalid_request',
  );
  await assert.rejects(
    () => provider.getHistoricalCandles({ instrument: { assetClass: 'forex', symbol: 'NOPE' }, timeframe: '1d', from: 0, to: 1 }),
    (e: unknown) => isProviderError(e) && e.kind === 'invalid_request',
  );
  assert.equal(seen.length, 0);
});

test('provider: resampled timeframes request the anchor interval and aggregate', async () => {
  const seen: URL[] = [];
  // six 1m bars → two 3m buckets
  const values = [0, 1, 2, 3, 4, 5].map((m) =>
    value(`2026-09-13 00:0${m}:00`, '100', '110', '90', `${100 + m}`, '10'),
  );
  const { provider } = wire(() => ok(timeSeriesBody(values, { interval: '1min' })), seen);
  const candles = await provider.getHistoricalCandles({
    instrument: EURUSD,
    timeframe: '3m',
    from: Date.UTC(2026, 8, 13, 0, 0, 0),
    to: Date.UTC(2026, 8, 13, 0, 6, 0),
  });
  assert.equal(seen[0]!.searchParams.get('interval'), '1min');
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], {
    time: Date.UTC(2026, 8, 13, 0, 0, 0),
    open: 100,
    high: 110,
    low: 90,
    close: 102,
    volume: 30,
    state: 'closed',
  });
  assert.equal(candles[1]!.time, Date.UTC(2026, 8, 13, 0, 3, 0));
});

test('provider: short page ends pagination with a single call', async () => {
  const seen: URL[] = [];
  const { provider } = wire(() => ok(timeSeriesBody([day('2026-09-10', '1', '1', '1', '1')])), seen);
  const candles = await provider.getHistoricalCandles({
    instrument: EURUSD,
    timeframe: '1d',
    from: Date.UTC(2026, 8, 10),
    to: Date.UTC(2026, 8, 11),
  });
  assert.equal(candles.length, 1);
  assert.equal(seen.length, 1);
});

test('provider: full 5000-bar page advances the cursor (no end_date walking)', async () => {
  const seen: URL[] = [];
  let calls = 0;
  const start = Date.UTC(2020, 0, 1);
  const full = Array.from({ length: 5000 }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return day(iso, '1', '1', '1', '1');
  });
  const { provider } = wire(() => {
    calls += 1;
    return calls === 1 ? ok(timeSeriesBody(full)) : ok(timeSeriesBody([]));
  }, seen);
  const candles = await provider.getHistoricalCandles({
    instrument: EURUSD,
    timeframe: '1d',
    from: start,
    to: Date.UTC(2040, 0, 1),
  });
  assert.equal(candles.length, 5000);
  assert.equal(calls, 2);
  // second page advances start_date to/past the last bar seen (the +1ms
  // cursor truncates to the same second at vendor date resolution; the
  // provider dedupes any re-fetched bar by timestamp)
  const lastBar = start + 4999 * 86_400_000;
  const startDate = seen[1]!.searchParams.get('start_date')!;
  assert.ok(new Date(`${startDate.replace(' ', 'T')}Z`).getTime() >= lastBar, startDate);
});

test('provider: page with no in-window bars stops pagination (no-progress guard)', async () => {
  const seen: URL[] = [];
  // vendor returns bars outside the requested window — must not loop
  const { provider } = wire(() => ok(timeSeriesBody([day('2020-01-01', '1', '1', '1', '1')])), seen);
  const candles = await provider.getHistoricalCandles({
    instrument: EURUSD,
    timeframe: '1d',
    from: Date.UTC(2026, 8, 10),
    to: Date.UTC(2026, 8, 11),
  });
  assert.deepEqual(candles, []);
  assert.equal(seen.length, 1);
});

test('provider: invalid vendor bars fail the call (OHLC violation, non-positive, NaN)', async () => {
  const cases = [
    [day('2026-09-10', '1', '1', '5', '1')], // low > high
    [day('2026-09-10', '0', '1', '0', '1')], // non-positive
    [value('2026-09-10', 'abc', '1', '1', '1')], // NaN
    [day('2026-09-10', '1', '1', '1', '1', '-5')], // negative volume
  ];
  for (const values of cases) {
    const { provider } = wire(() => ok(timeSeriesBody(values)));
    await assert.rejects(
      () =>
        provider.getHistoricalCandles({ instrument: EURUSD, timeframe: '1d', from: 0, to: Date.UTC(2026, 8, 12) }),
      (e: unknown) => isProviderError(e) && e.kind === 'unavailable',
      JSON.stringify(values),
    );
  }
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test('provider: vendor error envelopes map to ProviderError kinds', async () => {
  const cases: Array<[unknown, number, ProviderFailureKind]> = [
    [{ status: 'error', message: 'Invalid API key', code: 401 }, 200, 'unauthorized'],
    [{ status: 'error', message: 'run out of credits', code: 429 }, 200, 'rate_limited'],
    [{ status: 'error', message: 'bad symbol', code: 400 }, 200, 'invalid_request'],
    [{ status: 'error', message: 'no such instrument', code: 404 }, 200, 'not_found'],
    [{ status: 'error', message: 'boom', code: 500 }, 200, 'unavailable'],
  ];
  for (const [body, status, kind] of cases) {
    const { provider } = wire(() => ({ status, body }));
    await assert.rejects(
      () => provider.getHistoricalCandles({ instrument: EURUSD, timeframe: '1d', from: 0, to: 1 }),
      (e: unknown) => isProviderError(e) && e.kind === kind,
      JSON.stringify(body),
    );
  }
});

test('provider: HTTP statuses map without an envelope', async () => {
  const cases: Array<[number, ProviderFailureKind]> = [
    [429, 'rate_limited'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [400, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ];
  for (const [status, kind] of cases) {
    const { provider } = wire(() => ({ status, body: { unexpected: true } }));
    await assert.rejects(
      () => provider.getHistoricalCandles({ instrument: EURUSD, timeframe: '1d', from: 0, to: 1 }),
      (e: unknown) => isProviderError(e) && e.kind === kind,
      `HTTP ${status}`,
    );
  }
});

test('provider: network failure becomes unavailable with no leaked internals', async () => {
  const client = new TwelveDataClient(
    {
      apiKey: 'test-key',
      baseUrl: 'https://api.test',
      timeoutMs: 1000,
      maxRequestsPerMinute: 100_000,
      cryptoExchange: 'Binance',
    },
    (async () => {
      throw new Error('socket hang up');
    }) as FetchFn,
  );
  const provider = new TwelveDataProvider(client, 'Binance');
  await assert.rejects(
    () => provider.getHistoricalCandles({ instrument: EURUSD, timeframe: '1d', from: 0, to: 1 }),
    (e: unknown) => {
      assert.ok(isProviderError(e));
      assert.equal(e.kind, 'unavailable');
      assert.ok(!e.message.includes('test-key'), 'message must not leak the key');
      assert.ok(!e.message.includes('socket hang up'), 'message must not leak internals');
      return true;
    },
  );
});

test('provider: malformed payloads are rejected, not trusted', async () => {
  const bodies = [
    { status: 'ok' }, // no values
    { meta: { symbol: 'x' }, values: [{ open: '1', high: '1', low: '1', close: '1' }] }, // no datetime
  ];
  for (const body of bodies) {
    const { provider } = wire(() => ({ status: 200, body }));
    await assert.rejects(
      () => provider.getHistoricalCandles({ instrument: EURUSD, timeframe: '1d', from: 0, to: Date.UTC(2026, 8, 12) }),
      (e: unknown) => isProviderError(e) && e.kind === 'unavailable',
      JSON.stringify(body),
    );
  }
});
