/* eslint-disable @typescript-eslint/no-explicit-any */
import type pg from 'pg';
import {
  BACKTEST_ENGINE_VERSION,
  MAX_BACKTEST_TRADES,
  MAX_BACKTEST_STEPS,
  backtestDirectionSchema,
  backtestInstrumentSchema,
  backtestMetricsSchema,
  timeframeMinutes,
  type BacktestDirection,
  type BacktestListQuery,
  type BacktestRunDto,
  type BacktestTrade,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { StrategyService } from '../strategies/strategies.js';
import type { CandleStore } from '../market-data/candles.js';
import { requiredWindows } from '../strategies/evaluation/service.js';
import { runBacktest } from './engine.js';
import { resolveEntitlements } from '../billing/entitlement-resolution.js';
import type { UserPlan } from '@veltrixeye/contracts';
import { computeConfigHash, isValidConfigHash } from './canonical.js';

/**
 * BacktestService (M6 Phase 2) — the application/service boundary around the
 * pure M6.1 engine.
 *
 * Guarantees:
 *  - provider-free: loads candles ONLY from CandleStore, never IngestionService,
 *    never network I/O.
 *  - owner-scoped: every method requires userId and goes through
 *    StrategyService.getVersion for masked 404s and published-only gate.
 *  - deterministic idempotency: same canonical config → same run, via
 *    `backtest_runs_idempotency_uniq` + canonical config_hash (see canonical.ts).
 *  - concurrent safety: INSERT ... ON CONFLICT DO NOTHING + re-select.
 *  - no side effects: never writes setups, setup_scores, setup_state_events,
 *    ingestion_runs.
 *  - respects MAX_BACKTEST_STEPS (engine) and MAX_BACKTEST_TRADES (persistence).
 */

export interface CreateBacktestArgs {
  userId: string;
  strategyId: string;
  versionId: string;
  instrument: { assetClass: string; symbol: string };
  direction?: BacktestDirection;
  from: number;
  to: number;
  exitPolicy?: unknown;
  costPolicy?: unknown;
  /** Test seam: wall clock used to reject future ranges. */
  nowMs?: number;
}

export interface BacktestRunRow {
  id: string;
  user_id: string;
  strategy_id: string;
  strategy_version_id: string;
  instrument_id: string;
  direction: string;
  engine_version: string;
  from_ms: string; // int8 as text
  to_ms: string;
  exit_policy: unknown;
  cost_policy: unknown;
  config_hash: string;
  status: string;
  steps_evaluated: number;
  setups_detected: number;
  trades_closed: number;
  expectancy_r: string | null;
  win_rate: string | null;
  profit_factor: string | null;
  max_drawdown_r: string | null;
  metrics: unknown;
  notes: unknown;
  created_at: Date;
}

export interface BacktestTradeRow {
  id: string;
  run_id: string;
  seq: number;
  instrument_id: string;
  direction: string;
  signal_as_of_ms: string;
  entry_price: string | null;
  stop_loss_price: string | null;
  tp1_price: string | null;
  tp2_price: string | null;
  tp3_price: string | null;
  quality_score: number | null;
  quality_grade: string | null;
  exit_reason: string;
  exit_price: string | null;
  exit_as_of_ms: string | null;
  pnl_r: string | null;
  created_at: Date;
}

export interface CreateBacktestResult {
  run: BacktestRunDto;
  trades: BacktestTrade[];
  truncated: boolean;
  created: boolean;
}

export class BacktestService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly strategies: StrategyService,
    private readonly candles: CandleStore,
  ) {}

  /**
   * Create (or replay) a backtest run.
   *
   * Validates, normalizes, enforces owner scope, loads required candles,
   * runs the pure engine, and persists transactionally with idempotency.
   */
  async createBacktest(args: CreateBacktestArgs): Promise<CreateBacktestResult> {
    const nowMs = args.nowMs ?? Date.now();

    // 1. Validate instrument + direction via contracts (normalizes symbol).
    const instrumentParsed = backtestInstrumentSchema.parse(args.instrument);
    const directionParsed = backtestDirectionSchema.parse(args.direction ?? 'both');

    // 2. Validate range bounds.
    if (!Number.isInteger(args.from) || args.from <= 0) {
      throw Errors.invalidInput('`from` must be a positive integer epoch-ms.');
    }
    if (!Number.isInteger(args.to) || args.to <= 0) {
      throw Errors.invalidInput('`to` must be a positive integer epoch-ms.');
    }
    if (args.from >= args.to) {
      throw Errors.invalidInput('`from` must be earlier than `to`.');
    }
    // Future ranges are invalid — backtests are over historical data only.
    if (args.to > nowMs) {
      throw Errors.invalidInput('`to` must not be in the future.');
    }
    if (args.from > nowMs) {
      throw Errors.invalidInput('`from` must not be in the future.');
    }
    // Guard against absurdly large ranges that would load excessive data.
    // Engine caps steps at 2000, but we still reject ranges > 10y to avoid
    // accidental huge queries.
    const MAX_RANGE_MS = 10 * 365 * 24 * 3600 * 1000;
    if (args.to - args.from > MAX_RANGE_MS) {
      throw Errors.invalidInput('Backtest range exceeds maximum allowed span (10 years).');
    }

    // 3. Canonical config_hash (validates policies via Zod).
    let parsed;
    try {
      parsed = computeConfigHash(args.exitPolicy, args.costPolicy);
    } catch (err) {
      // Zod errors become 400 invalid_input via error handler; preserve message.
      if ((err as { name?: string }).name === 'ZodError') {
        throw Errors.invalidInput(`Invalid backtest policy: ${(err as Error).message}`);
      }
      throw err;
    }
    if (!isValidConfigHash(parsed.hash)) {
      throw Errors.invalidInput('Invalid config_hash format.');
    }

    // 4. Resolve strategy/version with ownership + published gate (M3/M4/M5 rule).
    const version = await this.strategies.getVersion(args.userId, args.strategyId, args.versionId);
    if (version.status === 'draft') {
      throw Errors.invalidInput('Only published versions can be backtested — a draft is still mutable. Publish the version first.');
    }
    const config = version.config;
    if (!config.timeframes) {
      throw Errors.invalidInput('Published version is missing its timeframe configuration.');
    }
    if (!config.risk) {
      throw Errors.invalidInput('Published version is missing its risk configuration.');
    }

    // 5. Resolve instrument.
    const resolved = await this.candles.resolveInstrument(instrumentParsed.assetClass, instrumentParsed.symbol);
    if (!resolved) {
      throw Errors.notFound(`Unknown instrument "${instrumentParsed.assetClass}/${instrumentParsed.symbol}"`);
    }

    // 6. Load required candles (store-only, never provider).
    const windows = requiredWindows(config);
    const setupPeriodMs = timeframeMinutes(config.timeframes.setup) * 60_000;
    const htfPeriodMs = timeframeMinutes(config.timeframes.htf_bias) * 60_000;
    const entryPeriodMs = timeframeMinutes(config.timeframes.entry) * 60_000;

    // For each role, load from (from - window*period - period) to to.
    // The extra period ensures we include a candle whose close is exactly at from.
    const htfFrom = args.from - windows.htf_bias * htfPeriodMs - htfPeriodMs;
    const setupFrom = args.from - windows.setup * setupPeriodMs - setupPeriodMs;
    const entryFrom = args.from - windows.entry * entryPeriodMs - entryPeriodMs;

    // Limit: window + MAX_BACKTEST_STEPS + margin, capped to 10k to avoid unbounded loads.
    const htfLimit = Math.min(10000, windows.htf_bias + MAX_BACKTEST_STEPS + 500);
    const setupLimit = Math.min(10000, windows.setup + MAX_BACKTEST_STEPS + 500);
    const entryLimit = Math.min(10000, windows.entry + MAX_BACKTEST_STEPS + 500);

    const [htfCandles, setupCandles, entryCandles] = await Promise.all([
      this.candles.queryCandles({
        instrumentId: resolved.id,
        timeframe: config.timeframes.htf_bias,
        from: Math.max(0, htfFrom),
        to: args.to,
        limit: htfLimit,
      }),
      this.candles.queryCandles({
        instrumentId: resolved.id,
        timeframe: config.timeframes.setup,
        from: Math.max(0, setupFrom),
        to: args.to,
        limit: setupLimit,
      }),
      this.candles.queryCandles({
        instrumentId: resolved.id,
        timeframe: config.timeframes.entry,
        from: Math.max(0, entryFrom),
        to: args.to,
        limit: entryLimit,
      }),
    ]);

    // 7. Run pure engine (no I/O, no side effects).
    const engineResult = runBacktest({
      config,
      instrument: { assetClass: resolved.assetClass, symbol: resolved.symbol },
      candles: {
        htf_bias: htfCandles,
        setup: setupCandles,
        entry: entryCandles,
      },
      fromMs: args.from,
      toMs: args.to,
      direction: directionParsed,
      exitPolicy: parsed.exitPolicy,
      costPolicy: parsed.costPolicy,
    });

    // 8. Enforce MAX_BACKTEST_TRADES at persistence boundary.
    const allTrades = engineResult.trades;
    const truncated = allTrades.length > MAX_BACKTEST_TRADES;
    const tradesToPersist = truncated ? allTrades.slice(0, MAX_BACKTEST_TRADES) : allTrades;

    // 9. Persist transactionally with idempotency.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // M7.4 Atomic entitlement enforcement
      // `provider` and the durable activation fact are read for the
      // fail-closed entitlement gate: a provider-backed row is an unconfirmed
      // checkout — never a purchase — until an operator has authorized an
      // immutable activation fact for it (Billing Step 8, migration 0034).
      const entitlementRes = await client.query<{ plan: string; status: string; provider: string | null; activated: boolean }>(`
        SELECT plan, status, provider,
               EXISTS (SELECT 1 FROM billing_subscription_activations a
                        WHERE a.subscription_id = subscriptions.id) AS activated
          FROM subscriptions WHERE user_id = $1 FOR UPDATE
      `, [args.userId]);
      
      const subRow = entitlementRes.rows[0] || { plan: 'free', status: 'active', provider: null, activated: false };
      const entitlements = resolveEntitlements(subRow.plan as UserPlan, subRow.status, subRow.provider, subRow.activated === true);
      const maxBacktests = entitlements.maxBacktestsPerMonth;
      
      const countRes = await client.query(
        "SELECT count(*)::int AS c FROM backtest_runs WHERE user_id = $1 AND created_at >= date_trunc('month', now())",
        [args.userId]
      );
      if (countRes.rows[0].c >= maxBacktests) {
        throw Errors.forbidden(`Backtest limit reached. Your plan allows up to ${maxBacktests} backtests per month.`);
      }

      // Attempt insert run.
      const runRes = await client.query<BacktestRunRow>(
        `INSERT INTO backtest_runs
           (user_id, strategy_id, strategy_version_id, instrument_id, direction, engine_version,
            from_ms, to_ms, exit_policy, cost_policy, config_hash, status,
            steps_evaluated, setups_detected, trades_closed,
            expectancy_r, win_rate, profit_factor, max_drawdown_r,
            metrics, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (user_id, strategy_version_id, instrument_id, direction, engine_version, from_ms, to_ms, config_hash) DO NOTHING
         RETURNING *`,
        [
          args.userId,
          args.strategyId,
          args.versionId,
          resolved.id,
          directionParsed,
          BACKTEST_ENGINE_VERSION,
          args.from,
          args.to,
          JSON.stringify(parsed.exitPolicy),
          JSON.stringify(parsed.costPolicy),
          parsed.hash,
          'completed',
          engineResult.metrics.stepsEvaluated,
          engineResult.metrics.setupsDetected,
          engineResult.metrics.tradesClosed,
          engineResult.metrics.expectancyR,
          engineResult.metrics.winRate,
          engineResult.metrics.profitFactor,
          engineResult.metrics.maxDrawdownR,
          JSON.stringify(engineResult.metrics),
          JSON.stringify(engineResult.notes),
        ],
      );

      const insertedRow = runRes.rows[0];
      if (insertedRow) {
        // Winner: insert trades.
        if (tradesToPersist.length > 0) {
          // Bulk insert via loop (500 rows max, acceptable).
          for (const trade of tradesToPersist) {
            await client.query(
              `INSERT INTO backtest_trades
                 (run_id, seq, instrument_id, direction, signal_as_of_ms,
                  entry_price, stop_loss_price, tp1_price, tp2_price, tp3_price,
                  quality_score, quality_grade, exit_reason, exit_price, exit_as_of_ms, pnl_r)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
              [
                insertedRow.id,
                trade.seq,
                resolved.id,
                trade.direction,
                trade.signalAsOfMs,
                trade.entryPrice,
                trade.stopLossPrice,
                trade.tp1Price,
                trade.tp2Price,
                trade.tp3Price,
                trade.qualityScore,
                trade.qualityGrade,
                trade.exitReason,
                trade.exitPrice,
                trade.exitAsOfMs,
                trade.pnlR,
              ],
            );
          }
        }
        await client.query('COMMIT');
        // Re-read trades from DB to ensure numeric rounding is consistent
        // between created and replayed paths (numeric(24,10) → Number).
        const persistedTradesRes = await this.pool.query<BacktestTradeRow>(
          'SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY seq ASC',
          [insertedRow.id],
        );
        const persistedTrades = persistedTradesRes.rows.map(toTradeDto);
        const runDto = toRunDto(insertedRow, resolved, version.versionNumber);
        return { run: runDto, trades: persistedTrades, truncated, created: true };
      }

      // Lost race or existing run: commit no-op and re-select existing.
      await client.query('COMMIT');
      const existing = await this.findExistingRun(
        args.userId,
        args.versionId,
        resolved.id,
        directionParsed,
        args.from,
        args.to,
        parsed.hash,
      );
      if (!existing) {
        throw Errors.internal('Backtest conflict could not be resolved');
      }
      const existingTrades = await this.pool.query<BacktestTradeRow>(
        'SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY seq ASC',
        [existing.id],
      );
      const trades = existingTrades.rows.map(toTradeDto);
      const existingTruncated = existing.setups_detected > trades.length;
      const runDto = toRunDto(existing, resolved, version.versionNumber);
      return { run: runDto, trades, truncated: existingTruncated, created: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async countBacktestsThisMonth(userId: string): Promise<number> {
    const res = await this.pool.query(
      `SELECT count(*)::int AS c FROM backtest_runs 
       WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
      [userId]
    );
    return res.rows[0].c;
  }

  async listBacktests(args: { userId: string } & BacktestListQuery): Promise<{ runs: BacktestRunDto[] }> {
    const values: unknown[] = [args.userId];
    const where = ['r.user_id = $1'];
    if (args.strategyId) {
      values.push(args.strategyId);
      where.push(`r.strategy_id = $${values.length}`);
    }
    if (args.versionId) {
      values.push(args.versionId);
      where.push(`r.strategy_version_id = $${values.length}`);
    }
    values.push(args.limit);
    const res = await this.pool.query<BacktestRunRow & { asset_class: string; symbol: string; version_number: number }>(
      `SELECT r.*, i.asset_class, i.symbol, v.version_number
       FROM backtest_runs r
       JOIN instruments i ON i.id = r.instrument_id
       JOIN strategy_versions v ON v.id = r.strategy_version_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $${values.length}`,
      values,
    );
    const runs = res.rows.map((row) =>
      toRunDto(row, { assetClass: row.asset_class as any, symbol: row.symbol }, row.version_number),
    );
    return { runs };
  }

  async getBacktest(args: { userId: string; runId: string }): Promise<CreateBacktestResult> {
    const run = await this.pool.query<BacktestRunRow & { asset_class: string; symbol: string; version_number: number }>(
      `SELECT r.*, i.asset_class, i.symbol, v.version_number
       FROM backtest_runs r
       JOIN instruments i ON i.id = r.instrument_id
       JOIN strategy_versions v ON v.id = r.strategy_version_id
       WHERE r.id = $1 AND r.user_id = $2`,
      [args.runId, args.userId],
    );
    const row = run.rows[0];
    if (!row) throw Errors.notFound('Backtest not found');
    const tradesRes = await this.pool.query<BacktestTradeRow>('SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY seq ASC', [row.id]);
    const trades = tradesRes.rows.map(toTradeDto);
    const truncated = row.setups_detected > trades.length;
    const dto = toRunDto(row, { assetClass: row.asset_class as any, symbol: row.symbol }, row.version_number);
    return { run: dto, trades, truncated, created: false };
  }

  async getTrades(args: { userId: string; runId: string; limit: number }): Promise<{ run: BacktestRunDto; trades: BacktestTrade[]; truncated: boolean }> {
    const run = await this.pool.query<BacktestRunRow & { asset_class: string; symbol: string; version_number: number }>(
      `SELECT r.*, i.asset_class, i.symbol, v.version_number
       FROM backtest_runs r
       JOIN instruments i ON i.id = r.instrument_id
       JOIN strategy_versions v ON v.id = r.strategy_version_id
       WHERE r.id = $1 AND r.user_id = $2`,
      [args.runId, args.userId],
    );
    const row = run.rows[0];
    if (!row) throw Errors.notFound('Backtest not found');
    const tradesRes = await this.pool.query<BacktestTradeRow>(
      'SELECT * FROM backtest_trades WHERE run_id = $1 ORDER BY seq ASC LIMIT $2',
      [row.id, args.limit],
    );
    const trades = tradesRes.rows.map(toTradeDto);
    const truncated = row.setups_detected > trades.length || row.setups_detected > args.limit;
    const dto = toRunDto(row, { assetClass: row.asset_class as any, symbol: row.symbol }, row.version_number);
    return { run: dto, trades, truncated };
  }

  private async findExistingRun(
    userId: string,
    versionId: string,
    instrumentId: string,
    direction: string,
    fromMs: number,
    toMs: number,
    configHash: string,
  ): Promise<BacktestRunRow | null> {
    const res = await this.pool.query<BacktestRunRow>(
      `SELECT * FROM backtest_runs
       WHERE user_id = $1 AND strategy_version_id = $2 AND instrument_id = $3
         AND direction = $4 AND engine_version = $5 AND from_ms = $6 AND to_ms = $7 AND config_hash = $8`,
      [userId, versionId, instrumentId, direction, BACKTEST_ENGINE_VERSION, fromMs, toMs, configHash],
    );
    return res.rows[0] ?? null;
  }
}

function toRunDto(
  row: BacktestRunRow & { asset_class?: string; symbol?: string; version_number?: number },
  instrument: { assetClass: string; symbol: string },
  versionNumber: number,
): BacktestRunDto {
  // Metrics stored as jsonb, but we also have individual columns for sorting.
  // Prefer metrics jsonb for full DTO, fallback to columns if needed.
  let metrics: any;
  try {
    metrics = typeof row.metrics === 'string' ? JSON.parse(row.metrics as unknown as string) : row.metrics;
  } catch {
    metrics = {};
  }
  // Validate via schema? We'll trust stored but ensure shape.
  const parsedMetrics = backtestMetricsSchema.safeParse(metrics);
  const finalMetrics = parsedMetrics.success ? parsedMetrics.data : {
    stepsEvaluated: row.steps_evaluated,
    setupsDetected: row.setups_detected,
    tradesClosed: row.trades_closed,
    wins: 0,
    losses: 0,
    winRate: row.win_rate ? Number(row.win_rate) : null,
    expectancyR: row.expectancy_r ? Number(row.expectancy_r) : null,
    profitFactor: row.profit_factor ? Number(row.profit_factor) : null,
    maxDrawdownR: row.max_drawdown_r ? Number(row.max_drawdown_r) : null,
    avgWinR: null,
    avgLossR: null,
    totalR: 0,
    totalCurrency: null,
  };

  let exitPolicy: any;
  let costPolicy: any;
  let notes: any;
  try {
    exitPolicy = typeof row.exit_policy === 'string' ? JSON.parse(row.exit_policy as unknown as string) : row.exit_policy;
  } catch {
    exitPolicy = {};
  }
  try {
    costPolicy = typeof row.cost_policy === 'string' ? JSON.parse(row.cost_policy as unknown as string) : row.cost_policy;
  } catch {
    costPolicy = {};
  }
  try {
    notes = typeof row.notes === 'string' ? JSON.parse(row.notes as unknown as string) : row.notes;
  } catch {
    notes = [];
  }

  return {
    id: row.id,
    strategyId: row.strategy_id,
    strategyVersionId: row.strategy_version_id,
    versionNumber,
    instrument: {
      assetClass: (row.asset_class ?? instrument.assetClass) as any,
      symbol: row.symbol ?? instrument.symbol,
    },
    direction: row.direction as any,
    engineVersion: row.engine_version,
    fromMs: Number(row.from_ms),
    toMs: Number(row.to_ms),
    exitPolicy,
    costPolicy,
    configHash: row.config_hash,
    status: row.status as any,
    metrics: finalMetrics,
    notes: Array.isArray(notes) ? notes : [],
    createdAt: row.created_at.toISOString(),
  };
}

function toTradeDto(row: BacktestTradeRow): BacktestTrade {
  return {
    seq: row.seq,
    direction: row.direction as any,
    signalAsOfMs: Number(row.signal_as_of_ms),
    entryPrice: row.entry_price !== null ? Number(row.entry_price) : null,
    stopLossPrice: row.stop_loss_price !== null ? Number(row.stop_loss_price) : null,
    tp1Price: row.tp1_price !== null ? Number(row.tp1_price) : null,
    tp2Price: row.tp2_price !== null ? Number(row.tp2_price) : null,
    tp3Price: row.tp3_price !== null ? Number(row.tp3_price) : null,
    qualityScore: row.quality_score,
    qualityGrade: row.quality_grade as any,
    exitReason: row.exit_reason as any,
    exitPrice: row.exit_price !== null ? Number(row.exit_price) : null,
    exitAsOfMs: row.exit_as_of_ms !== null ? Number(row.exit_as_of_ms) : null,
    pnlR: row.pnl_r !== null ? Number(row.pnl_r) : null,
    pnlCurrency: null, // not stored in trades table (licensing + aggregate only)
  };
}
