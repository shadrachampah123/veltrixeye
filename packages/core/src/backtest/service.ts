/* eslint-disable @typescript-eslint/no-explicit-any */
import type pg from 'pg';
import {
  BACKTEST_ENGINE_VERSION,
  MAX_BACKTEST_ROLE_CANDLES,
  MAX_BACKTEST_TRADES,
  backtestDirectionSchema,
  backtestInstrumentSchema,
  backtestMetricsSchema,
  timeframeMinutes,
  type BacktestDirection,
  type BacktestListQuery,
  type BacktestRunDto,
  type BacktestTrade,
  type Timeframe,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import type { StrategyService } from '../strategies/strategies.js';
import type { CandleStore } from '../market-data/candles.js';
import {
  anchorHorizonMs,
  roleCoverageWindow,
  runBacktest,
  setupCoverageWindow,
  type BacktestRoleWindow,
} from './engine.js';
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

    // 5. Resolve instrument + its pip size.
    //
    // Costs are pips, so the engine needs the instrument's pip size to convert
    // them into price units (see `resolvePipSize` in engine.ts). The spec lives
    // in `instrument_risk_specs` (M8.2, migration 0017) — the same table the
    // risk/execution engines size positions from. A missing spec is only fatal
    // when the cost policy is non-zero (the engine enforces that), so a
    // costless replay of an instrument without a spec still runs.
    const resolved = await this.candles.resolveInstrument(instrumentParsed.assetClass, instrumentParsed.symbol);
    if (!resolved) {
      throw Errors.notFound(`Unknown instrument "${instrumentParsed.assetClass}/${instrumentParsed.symbol}"`);
    }
    const pipSize = await this.loadPipSize(resolved.id);

    // 6. Load required candles (store-only, never provider).
    //
    // M6.2 coverage: each role's window is sized from that ROLE's own period
    // (see engine.ts), not from MAX_BACKTEST_STEPS. One anchor costs one setup
    // candle but setupPeriod/entryPeriod entry candles, so a per-role budget of
    // "one candle per step" truncated the finer roles and left every later
    // anchor replaying a stale prefix. The setup role is loaded first because
    // it defines the anchors: the bias/entry windows are measured to the last
    // anchor this run will actually evaluate, and capped by
    // MAX_BACKTEST_ROLE_CANDLES (fail closed, never a truncated replay).
    const setupWindow = setupCoverageWindow({
      config,
      fromMs: args.from,
      toMs: args.to,
      maxHoldCandles: parsed.exitPolicy.maxHoldCandles,
    });
    assertWithinRoleCap('setup', config.timeframes.setup, setupWindow);

    const setupCandles = await this.candles.queryCandles({
      instrumentId: resolved.id,
      timeframe: config.timeframes.setup,
      from: setupWindow.from,
      to: setupWindow.to,
      limit: setupWindow.limit,
    });

    const horizonMs = anchorHorizonMs({
      setup: setupCandles,
      setupPeriodMs: timeframeMinutes(config.timeframes.setup) * 60_000,
      fromMs: args.from,
      toMs: args.to,
    });

    const htfWindow = roleCoverageWindow({ role: 'htf_bias', config, fromMs: args.from, horizonMs });
    const entryWindow = roleCoverageWindow({ role: 'entry', config, fromMs: args.from, horizonMs });
    assertWithinRoleCap('htf_bias', config.timeframes.htf_bias, htfWindow);
    assertWithinRoleCap('entry', config.timeframes.entry, entryWindow);

    const [htfCandles, entryCandles] = await Promise.all([
      this.candles.queryCandles({
        instrumentId: resolved.id,
        timeframe: config.timeframes.htf_bias,
        from: htfWindow.from,
        to: htfWindow.to,
        limit: htfWindow.limit,
      }),
      this.candles.queryCandles({
        instrumentId: resolved.id,
        timeframe: config.timeframes.entry,
        from: entryWindow.from,
        to: entryWindow.to,
        limit: entryWindow.limit,
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
      pipSize,
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
      // The non-commercial operator grant (migration 0036) is read alongside
      // them.
      const entitlementRes = await client.query<{ plan: string; status: string; provider: string | null; activated: boolean }>(`
        SELECT plan, status, provider,
               EXISTS (SELECT 1 FROM billing_subscription_activations a
                        WHERE a.subscription_id = subscriptions.id) AS activated
          FROM subscriptions WHERE user_id = $1 FOR UPDATE
      `, [args.userId]);
      // The non-commercial operator grant (migration 0036) is an ACCOUNT-level
      // authority, so it is read in its own statement against the unique
      // index: an account with no subscription row — the Model C free state,
      // and the normal state of a granted account — still resolves its grant,
      // and the `FOR UPDATE` row lock above is untouched. `null` fails closed.
      const grantRes = await client.query<{ granted_plan: string | null }>(
        'SELECT plan AS granted_plan FROM billing_entitlement_grants WHERE user_id = $1',
        [args.userId],
      );
      
      const subRow = entitlementRes.rows[0] || { plan: 'free', status: 'active', provider: null, activated: false };
      const grantedPlan = (grantRes.rows[0]?.granted_plan ?? null) as UserPlan | null;
      const entitlements = resolveEntitlements(
        subRow.plan as UserPlan,
        subRow.status,
        subRow.provider,
        subRow.activated === true,
        grantedPlan,
      );
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

  /**
   * Instrument pip size (price units per pip) from `instrument_risk_specs`
   * (M8.2, migration 0017) — undefined when the instrument has no spec.
   * Costs are pips and are converted with this value; the pure engine refuses
   * a non-zero cost policy without it, so no unit is ever assumed here.
   */
  private async loadPipSize(instrumentId: string): Promise<number | undefined> {
    const res = await this.pool.query<{ pip_size: string }>(
      'SELECT pip_size FROM instrument_risk_specs WHERE instrument_id = $1',
      [instrumentId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const pipSize = Number(row.pip_size);
    return Number.isFinite(pipSize) && pipSize > 0 ? pipSize : undefined;
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

/**
 * M6.2 fail-closed bound: a run may never load more than
 * `MAX_BACKTEST_ROLE_CANDLES` candles for one role. Crossing the cap means the
 * range cannot be covered at this strategy's timeframes, and a truncated
 * (stale) replay is worse than no replay — refuse it and say how to proceed.
 */
function assertWithinRoleCap(role: string, timeframe: Timeframe, window: BacktestRoleWindow): void {
  if (window.limit <= MAX_BACKTEST_ROLE_CANDLES) return;
  throw Errors.invalidInput(
    `Backtest range is too long to cover at this version's timeframes: the ${role} timeframe (${timeframe}) ` +
      `would need more than ${MAX_BACKTEST_ROLE_CANDLES} candles. Split the range into shorter backtests ` +
      `(or backtest a version with a coarser ${role} timeframe).`,
  );
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
