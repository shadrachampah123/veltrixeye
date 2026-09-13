import type pg from 'pg';
import {
  MAX_BACKFILL_CANDLES,
  RETENTION_DAYS,
  isProviderError,
  retentionCutoffMs,
  timeframeMinutes,
  type AssetClass,
  type BackfillPairResult,
  type BackfillResponseDto,
  type CandlesResponseDto,
  type CandleDto,
  type IngestionStatus,
  type IngestionTrigger,
  type MarketDataProvider,
  type Timeframe,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { CandleStore } from './candles.js';
import type { ProviderRegistry } from './registry.js';

/** Preferred provider id; falls back to any registered historical provider. */
const PREFERRED_PROVIDER_ID = 'twelve-data';

export interface CandleReadRequest {
  assetClass: AssetClass;
  symbol: string;
  timeframe: Timeframe;
  from: number;
  to: number;
  limit: number;
  /** Wall clock (injectable for tests). */
  nowMs?: number;
  /** Acting user, recorded on fetch-through runs. */
  initiatedBy?: string;
}

export interface BackfillRequest {
  instruments: { assetClass: AssetClass; symbol: string }[];
  timeframes: Timeframe[];
  from: number;
  to: number;
  initiatedBy: string;
  nowMs?: number;
}

/**
 * Market-data ingestion (M2): fetch-through reads + explicit backfills over
 * the global shared candle store.
 *
 * Fetch-through gap math is deliberately simple: when a range is requested,
 * the store's existing head/tail decide what to fetch —
 *
 *  - empty range → fetch [from, to)
 *  - from < earliest → fetch [from, earliest)
 *  - another full period fits past latest → fetch [latest, to)
 *    (else the window is covered: a pure cache hit)
 *
 * Interior bars are assumed complete once written (ingestion is
 * append-and-correct; partial failures are re-fetched by the next read or an
 * explicit backfill). This keeps every read to at most two provider calls
 * with no gap ledger to maintain. See docs/market-data.md.
 */
export class IngestionService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: ProviderRegistry,
    private readonly store: CandleStore,
  ) {}

  /** Read candles, fetching + persisting missing head/tail first. */
  async getCandles(req: CandleReadRequest): Promise<CandlesResponseDto> {
    const nowMs = req.nowMs ?? Date.now();
    const instrument = await this.store.resolveInstrument(req.assetClass, req.symbol);
    if (!instrument) {
      throw Errors.notFound(`Unknown instrument "${req.assetClass}/${req.symbol}"`);
    }
    assertWithinRetention(req.timeframe, req.from, nowMs);

    const stats = await this.store.rangeStats({
      instrumentId: instrument.id,
      timeframe: req.timeframe,
      from: req.from,
      to: req.to,
    });
    const ranges = missingRanges(req.from, req.to, stats.earliest, stats.latest, timeframeMinutes(req.timeframe) * 60_000);
    let fetchedFromProvider = false;
    if (ranges.length > 0) {
      const provider = this.requireProvider();
      let upserted = 0;
      try {
        for (const [from, to] of ranges) {
          const candles = await provider.getHistoricalCandles({
            instrument: { assetClass: instrument.assetClass, symbol: instrument.symbol },
            timeframe: req.timeframe,
            from,
            to,
          });
          upserted += await this.store.upsertCandles({
            instrumentId: instrument.id,
            timeframe: req.timeframe,
            providerSlug: provider.id,
            candles: toDtos(candles),
          });
        }
      } catch (err) {
        await this.recordRun({
          trigger: 'fetch_through',
          status: 'failed',
          providerSlug: provider.id,
          request: fetchThroughRequest(instrument, req, ranges),
          candlesUpserted: upserted,
          error: runErrorMessage(err),
          initiatedBy: req.initiatedBy ?? null,
        });
        throw mapProviderError(err);
      }
      await this.store.pruneBeyondRetention({
        instrumentId: instrument.id,
        timeframe: req.timeframe,
        cutoffMs: retentionCutoffMs(req.timeframe, nowMs),
      });
      await this.recordRun({
        trigger: 'fetch_through',
        status: 'completed',
        providerSlug: provider.id,
        request: fetchThroughRequest(instrument, req, ranges),
        candlesUpserted: upserted,
        error: null,
        initiatedBy: req.initiatedBy ?? null,
      });
      fetchedFromProvider = true;
    }

    // limit+1 read: a full page means the range genuinely exceeds `limit`
    // (never silently truncate a scanner's input).
    const rows = await this.store.queryCandles({
      instrumentId: instrument.id,
      timeframe: req.timeframe,
      from: req.from,
      to: req.to,
      limit: req.limit + 1,
    });
    if (rows.length > req.limit) {
      throw Errors.invalidInput(
        `Range holds more than the ${req.limit}-candle limit — narrow the range or raise the limit (max 5000).`,
      );
    }
    return {
      instrument: { assetClass: instrument.assetClass, symbol: instrument.symbol, displayName: instrument.displayName },
      timeframe: req.timeframe,
      from: req.from,
      to: req.to,
      fetchedFromProvider,
      candles: rows,
    };
  }

  /**
   * Explicit, audited backfill over instruments × timeframes × [from, to).
   * Bounded by retention (per timeframe) and MAX_BACKFILL_CANDLES (total
   * estimate); pairs are fetched sequentially so provider credit usage stays
   * predictable. One pair's failure does not abort the others.
   */
  async backfill(req: BackfillRequest): Promise<BackfillResponseDto> {
    const nowMs = req.nowMs ?? Date.now();
    const provider = this.requireProvider();
    const resolved: { id: string; assetClass: AssetClass; symbol: string }[] = [];
    for (const inst of req.instruments) {
      const found = await this.store.resolveInstrument(inst.assetClass, inst.symbol);
      if (!found) throw Errors.notFound(`Unknown instrument "${inst.assetClass}/${inst.symbol}"`);
      resolved.push({ id: found.id, assetClass: found.assetClass, symbol: found.symbol });
    }
    for (const tf of req.timeframes) assertWithinRetention(tf, req.from, nowMs);
    const estimate = req.timeframes.reduce(
      (sum, tf) => sum + resolved.length * (Math.ceil((req.to - req.from) / (timeframeMinutes(tf) * 60_000)) + 1),
      0,
    );
    if (estimate > MAX_BACKFILL_CANDLES) {
      throw Errors.invalidInput(
        `Backfill estimates ~${estimate} candles, over the ${MAX_BACKFILL_CANDLES} cap — split it into smaller ranges.`,
      );
    }

    const runId = await this.openRun({
      trigger: 'backfill',
      providerSlug: provider.id,
      request: {
        instruments: resolved.map((r) => `${r.assetClass}/${r.symbol}`),
        timeframes: req.timeframes,
        from: req.from,
        to: req.to,
      },
      initiatedBy: req.initiatedBy,
    });
    const startedAt = new Date(nowMs).toISOString();
    const pairs: BackfillPairResult[] = [];
    let upserted = 0;
    for (const inst of resolved) {
      for (const tf of req.timeframes) {
        try {
          const candles = await provider.getHistoricalCandles({
            instrument: { assetClass: inst.assetClass, symbol: inst.symbol },
            timeframe: tf,
            from: req.from,
            to: req.to,
          });
          const n = await this.store.upsertCandles({
            instrumentId: inst.id,
            timeframe: tf,
            providerSlug: provider.id,
            candles: toDtos(candles),
          });
          await this.store.pruneBeyondRetention({
            instrumentId: inst.id,
            timeframe: tf,
            cutoffMs: retentionCutoffMs(tf, nowMs),
          });
          upserted += n;
          pairs.push({ assetClass: inst.assetClass, symbol: inst.symbol, timeframe: tf, status: 'completed', candlesUpserted: n, error: null });
        } catch (err) {
          pairs.push({
            assetClass: inst.assetClass,
            symbol: inst.symbol,
            timeframe: tf,
            status: 'failed',
            candlesUpserted: 0,
            error: runErrorMessage(err),
          });
        }
      }
    }
    const failed = pairs.filter((p) => p.status === 'failed').length;
    const status: IngestionStatus = failed === 0 ? 'completed' : failed === pairs.length ? 'failed' : 'partial';
    const finishedAt = new Date().toISOString();
    await this.closeRun(runId, {
      status,
      candlesUpserted: upserted,
      error: status === 'completed' ? null : `${failed} of ${pairs.length} pairs failed`,
      pairs,
    });
    return { runId, status, provider: provider.id, from: req.from, to: req.to, candlesUpserted: upserted, pairs, startedAt, finishedAt };
  }

  private requireProvider(): MarketDataProvider {
    const preferred = this.registry.get(PREFERRED_PROVIDER_ID);
    if (preferred?.capabilities.historical) return preferred;
    for (const info of this.registry.list()) {
      const candidate = this.registry.get(info.id);
      if (candidate?.capabilities.historical) return candidate;
    }
    throw Errors.providerUnavailable('No market-data provider is registered — ingestion is unavailable.');
  }

  private async recordRun(args: {
    trigger: IngestionTrigger;
    status: IngestionStatus;
    providerSlug: string;
    request: Record<string, unknown>;
    candlesUpserted: number;
    error: string | null;
    initiatedBy: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion_runs (trigger, status, provider_slug, request, candles_upserted, error, initiated_by, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [args.trigger, args.status, args.providerSlug, JSON.stringify(args.request), args.candlesUpserted, args.error, args.initiatedBy],
    );
  }

  private async openRun(args: {
    trigger: IngestionTrigger;
    providerSlug: string;
    request: Record<string, unknown>;
    initiatedBy: string;
  }): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO ingestion_runs (trigger, status, provider_slug, request, initiated_by)
       VALUES ($1, 'running', $2, $3, $4) RETURNING id`,
      [args.trigger, args.providerSlug, JSON.stringify(args.request), args.initiatedBy],
    );
    const id = res.rows[0]?.id;
    if (!id) throw Errors.internal('Failed to open ingestion run');
    return id;
  }

  private async closeRun(
    runId: string,
    args: { status: IngestionStatus; candlesUpserted: number; error: string | null; pairs: BackfillPairResult[] },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ingestion_runs
       SET status = $2, candles_upserted = $3, error = $4,
           request = request || jsonb_build_object('pairs', $5::jsonb),
           finished_at = now()
       WHERE id = $1`,
      [runId, args.status, args.candlesUpserted, args.error, JSON.stringify(args.pairs)],
    );
  }
}

/**
 * Head/tail ranges missing from [from, to), given stored earliest/latest.
 *
 * The tail fetch starts at `latest` (not after it) so a previously stored
 * forming bar is corrected by re-fetch — but it only fires when another
 * full period fits past the last stored bar. Otherwise the window is
 * covered and the read is a pure cache hit (fetchedFromProvider=false).
 */
export function missingRanges(
  from: number,
  to: number,
  earliest: number | null,
  latest: number | null,
  periodMs: number,
): [number, number][] {
  if (earliest === null || latest === null) return [[from, to]];
  const ranges: [number, number][] = [];
  if (from < earliest) ranges.push([from, earliest]);
  if (latest + periodMs < to) ranges.push([latest, to]);
  return ranges;
}

function assertWithinRetention(timeframe: Timeframe, from: number, nowMs: number): void {
  const cutoff = retentionCutoffMs(timeframe, nowMs);
  if (from < cutoff) {
    throw Errors.invalidInput(
      `Range starts before the ${RETENTION_DAYS[timeframe]}-day retention window for ${timeframe} — start at ${new Date(cutoff).toISOString()} or later.`,
    );
  }
}

function toDtos(candles: { time: number; open: number; high: number; low: number; close: number; volume: number | null }[]): CandleDto[] {
  return candles.map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

function fetchThroughRequest(
  instrument: { assetClass: AssetClass; symbol: string },
  req: CandleReadRequest,
  ranges: [number, number][],
): Record<string, unknown> {
  return {
    instrument: `${instrument.assetClass}/${instrument.symbol}`,
    timeframe: req.timeframe,
    from: req.from,
    to: req.to,
    fetchedRanges: ranges.map(([from, to]) => ({ from, to })),
  };
}

/** User-safe run error text (never vendor internals — detail stays in `cause`). */
function runErrorMessage(err: unknown): string {
  if (isProviderError(err)) return `${err.kind}: ${err.message}`;
  return err instanceof Error ? err.message : 'Unknown ingestion error';
}

/** Map provider failures to domain errors (user-safe messages, status-coded). */
export function mapProviderError(err: unknown): Error {
  if (isProviderError(err)) {
    switch (err.kind) {
      case 'rate_limited':
        return Errors.rateLimited('Market-data provider rate limit reached. Try again shortly.');
      case 'invalid_request':
        return Errors.invalidInput('The market-data provider rejected this range.');
      case 'not_found':
        return Errors.notFound('Instrument is unknown to the market-data provider.');
      case 'unauthorized':
      case 'unavailable':
        return Errors.providerUnavailable('Market-data provider is temporarily unavailable. Try again shortly.', err);
    }
  }
  if (err instanceof Error) return err;
  return Errors.internal('Market-data ingestion failed');
}
