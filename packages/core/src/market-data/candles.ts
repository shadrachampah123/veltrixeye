import type pg from 'pg';
import type { AssetClass, CandleDto, CoverageDto, Timeframe } from '@veltrixeye/contracts';
import { Errors } from '../errors.js';

export interface ResolvedInstrument {
  id: string;
  assetClass: AssetClass;
  symbol: string;
  displayName: string | null;
}

/**
 * Global shared candle store (M2). Market data belongs to no user: every
 * authenticated caller reads the same rows. All writes flow through
 * `upsertCandles` (idempotent; corrections overwrite), and retention is
 * enforced by pruning on write — M2 has no scheduler.
 *
 * Prices are numeric(24,10) in Postgres (returned as strings by pg) and are
 * converted to numbers on read. Every value is validated on write: finite,
 * positive, OHLC-invariant, non-negative volume.
 */
export class CandleStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Resolve a normalized (assetClass, symbol) to its instruments row. */
  async resolveInstrument(assetClass: string, symbol: string): Promise<ResolvedInstrument | null> {
    const res = await this.pool.query<{
      id: string;
      asset_class: string;
      symbol: string;
      display_name: string | null;
    }>('SELECT id, asset_class, symbol, display_name FROM instruments WHERE asset_class = $1 AND symbol = $2', [
      assetClass,
      symbol.toUpperCase(),
    ]);
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, assetClass: row.asset_class as AssetClass, symbol: row.symbol, displayName: row.display_name };
  }

  /**
   * Idempotent bulk upsert. Returns the number of input candles stored
   * (inserted + corrected). Rejects invalid candles before touching the DB.
   */
  async upsertCandles(args: {
    instrumentId: string;
    timeframe: Timeframe;
    providerSlug: string;
    candles: readonly CandleDto[];
  }): Promise<number> {
    if (args.candles.length === 0) return 0;
    for (const c of args.candles) assertValidCandle(c);
    // Dedupe by time (last wins) so one call can never conflict with itself.
    const byTime = new Map<number, CandleDto>();
    for (const c of args.candles) byTime.set(c.time, c);
    const rows = [...byTime.values()];
    const times = rows.map((c) => c.time);
    const opens = rows.map((c) => c.open);
    const highs = rows.map((c) => c.high);
    const lows = rows.map((c) => c.low);
    const closes = rows.map((c) => c.close);
    const volumes = rows.map((c) => c.volume);
    await this.pool.query(
      `INSERT INTO candles (instrument_id, timeframe, ts, open, high, low, close, volume, provider_slug, fetched_at)
       SELECT $1, $2, ts, open, high, low, close, volume, $3, now()
       FROM UNNEST($4::bigint[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[])
         AS u(ts, open, high, low, close, volume)
       ON CONFLICT (instrument_id, timeframe, ts) DO UPDATE SET
         open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume,
         provider_slug = EXCLUDED.provider_slug, fetched_at = now()`,
      [args.instrumentId, args.timeframe, args.providerSlug, times, opens, highs, lows, closes, volumes],
    );
    return rows.length;
  }

  /** Range read, ascending by time. `limit` caps the rows returned. */
  async queryCandles(args: {
    instrumentId: string;
    timeframe: Timeframe;
    from: number;
    to: number;
    limit: number;
  }): Promise<CandleDto[]> {
    const res = await this.pool.query<{
      ts: string;
      open: string;
      high: string;
      low: string;
      close: string;
      volume: string | null;
    }>(
      `SELECT ts, open, high, low, close, volume FROM candles
       WHERE instrument_id = $1 AND timeframe = $2 AND ts >= $3 AND ts < $4
       ORDER BY ts ASC LIMIT $5`,
      [args.instrumentId, args.timeframe, args.from, args.to, args.limit],
    );
    return res.rows.map((r) => ({
      time: Number(r.ts),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: r.volume === null ? null : Number(r.volume),
    }));
  }

  /** Count + earliest/latest inside one range (drives fetch-through gap math). */
  async rangeStats(args: {
    instrumentId: string;
    timeframe: Timeframe;
    from: number;
    to: number;
  }): Promise<{ count: number; earliest: number | null; latest: number | null }> {
    const res = await this.pool.query<{ count: string; earliest: string | null; latest: string | null }>(
      `SELECT count(*)::text AS count, min(ts)::text AS earliest, max(ts)::text AS latest
       FROM candles WHERE instrument_id = $1 AND timeframe = $2 AND ts >= $3 AND ts < $4`,
      [args.instrumentId, args.timeframe, args.from, args.to],
    );
    const row = res.rows[0];
    return {
      count: Number(row?.count ?? 0),
      earliest: row?.earliest == null ? null : Number(row.earliest),
      latest: row?.latest == null ? null : Number(row.latest),
    };
  }

  /** Coverage ledger: per instrument × timeframe counts + earliest/latest. */
  async getCoverage(args: { instrumentId?: string; timeframe?: Timeframe }): Promise<CoverageDto[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (args.instrumentId !== undefined) {
      params.push(args.instrumentId);
      conditions.push(`c.instrument_id = $${params.length}`);
    }
    if (args.timeframe !== undefined) {
      params.push(args.timeframe);
      conditions.push(`c.timeframe = $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.pool.query<{
      asset_class: string;
      symbol: string;
      display_name: string | null;
      timeframe: string;
      candle_count: string;
      earliest_time: string | null;
      latest_time: string | null;
    }>(
      `SELECT i.asset_class, i.symbol, i.display_name, c.timeframe,
              count(*)::text AS candle_count,
              min(c.ts)::text AS earliest_time, max(c.ts)::text AS latest_time
       FROM candles c JOIN instruments i ON i.id = c.instrument_id
       ${where}
       GROUP BY i.asset_class, i.symbol, i.display_name, c.timeframe
       ORDER BY i.asset_class, i.symbol, c.timeframe`,
      params,
    );
    return res.rows.map((r) => ({
      assetClass: r.asset_class as AssetClass,
      symbol: r.symbol,
      displayName: r.display_name,
      timeframe: r.timeframe as Timeframe,
      candleCount: Number(r.candle_count),
      earliestTime: r.earliest_time === null ? null : Number(r.earliest_time),
      latestTime: r.latest_time === null ? null : Number(r.latest_time),
    }));
  }

  /** Delete rows older than the retention cutoff. Returns rows removed. */
  async pruneBeyondRetention(args: { instrumentId: string; timeframe: Timeframe; cutoffMs: number }): Promise<number> {
    const res = await this.pool.query(
      'DELETE FROM candles WHERE instrument_id = $1 AND timeframe = $2 AND ts < $3',
      [args.instrumentId, args.timeframe, args.cutoffMs],
    );
    return res.rowCount ?? 0;
  }
}

function assertValidCandle(c: CandleDto): void {
  const fail = (why: string): never => {
    throw Errors.invalidInput(`Invalid candle at time ${c.time}: ${why}`);
  };
  if (!Number.isInteger(c.time) || c.time <= 0) fail('time must be a positive integer (epoch-ms)');
  for (const [name, v] of [
    ['open', c.open],
    ['high', c.high],
    ['low', c.low],
    ['close', c.close],
  ] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${name} must be a positive finite number`);
  }
  if (!(c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close))) {
    fail('OHLC invariant violated (low ≤ open/close ≤ high)');
  }
  if (c.volume !== null && (typeof c.volume !== 'number' || !Number.isFinite(c.volume) || c.volume < 0)) {
    fail('volume must be null or a non-negative finite number');
  }
}
