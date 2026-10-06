import { z } from 'zod';
import { assetClassSchema, instrumentSymbolSchema } from './assets.js';
import type { CandleDto } from './ingestion.js';
import type { StrategyVersionConfig } from './strategies.js';

/**
 * Deterministic backtesting contracts (M6 Phase 1).
 *
 * A backtest replays a PUBLISHED strategy version over stored candles: at
 * every setup-timeframe close in [from, to) it re-runs the pure M3 engine on
 * the candles closed at that anchor, derives M4 levels purely in memory, and
 * scores with the pure M5 engine — then tracks each simulated setup
 * candle-by-candle to a deterministic exit. The replay:
 *
 *  - reads ONLY from the shared candle store (Phase 2 service) and NEVER
 *    triggers provider fetch-through — it works identically with no provider
 *    key, and missing history is reported honestly, never fabricated;
 *  - writes NOTHING to the live `setups` / `setup_scores` /
 *    `setup_state_events` tables (replay uses the pure engines, never the
 *    M4/M5 services);
 *  - reads NO wall clock: `from`/`to` are explicit epoch-ms bounds and every
 *    anchor, entry, exit and score derives from them plus stored candles.
 *
 * Pinned rules (see docs/backtesting.md):
 *  - entry is the signal-candle close (`signal_close` — no next-open model);
 *  - a candle touching BOTH stop and target resolves to the stop
 *    (`stop_first` — conservative, not configurable);
 *  - exits are evaluated on the setup timeframe only;
 *  - R-multiples are the primary result; currency P&L exists only when the
 *    caller explicitly supplies `riskPerTrade` (no invented account size);
 *  - costs (fee/slippage/spread) are explicit PIPS inputs, defaulting to
 *    zero, converted to price units with the instrument's pip size
 *    (`instrument_risk_specs.pip_size`, M8.2) — the same unit every other
 *    cost input in the platform uses. The SAME authoritative pip size is
 *    threaded into the M3 engine so the replay's levels and its costs are
 *    converted consistently (one instrument, one pip size). Spread is NEVER
 *    sourced from market data (no spread feed exists);
 *  - every timeframe ROLE the version reads must be covered over the anchors
 *    the run evaluates: a required bias/entry series that ends early is a
 *    fail-closed error, never a stale replay (see `MAX_BACKTEST_ROLE_CANDLES`).
 *
 * Phase 1 ships these contracts, the 0011 migration, and the pure engine.
 * The Phase 2 service adds retention checks, compute bounds, persistence,
 * API routes and audit events — reusing these exact schemas.
 */

/**
 * Pinned identifier stored on every backtest run produced by this engine.
 *
 * Version history:
 *  - `m6-backtest-1` — initial deterministic replay;
 *  - `m6-backtest-2` — long-window per-role candle coverage;
 *  - `m6-backtest-3` — instrument-aware (pip-size) cost conversion;
 *  - `m6-backtest-4` — the replay's M3 level derivation receives the SAME
 *    authoritative `instrument_risk_specs.pip_size` used for costs, so a
 *    pip-denominated risk buffer converts identically everywhere in the run.
 */
export const BACKTEST_ENGINE_VERSION = 'm6-backtest-4';

/** Max evaluated anchors (setup closes) per backtest run. */
export const MAX_BACKTEST_STEPS = 4500;

/** Instruments per backtest call in M6 (one instrument per run; multi-instrument replays are N runs). */
export const MAX_BACKTEST_INSTRUMENTS_PER_CALL = 1;

/** Default hold cap, in setup-timeframe closed candles after the signal. */
export const DEFAULT_MAX_HOLD_CANDLES = 100;

/**
 * Max candles ONE timeframe role may load for a single backtest run.
 *
 * A replay consumes candles per ROLE, not per anchor: a 4h setup with a 15m
 * entry needs 16 entry candles for every anchor it evaluates. The loader
 * therefore sizes each role's window from that role's own period (see
 * `packages/core/src/backtest/engine.ts`) instead of from
 * `MAX_BACKTEST_STEPS`. This constant is the hard ceiling on that window: a
 * request whose coverage need exceeds it FAILS CLOSED (400, "split the
 * range") instead of loading a truncated prefix and silently replaying stale
 * role candles for the rest of the run.
 */
export const MAX_BACKTEST_ROLE_CANDLES = 60000;

/** Max trades persisted per run (deterministic: first N in seq order + truncation flag). */
export const MAX_BACKTEST_TRADES = 500;

/** Default/max page size for the backtest list endpoint (Phase 2). */
export const DEFAULT_BACKTESTS_LIMIT = 50;
export const MAX_BACKTESTS_LIMIT = 100;

/** Which M3 directions a backtest replays (`both` reports long-first, deterministically). */
export const backtestDirectionSchema = z.enum(['long', 'short', 'both']);
export type BacktestDirection = z.infer<typeof backtestDirectionSchema>;

/** Instrument selector for a backtest (normalized, provider-independent). */
export const backtestInstrumentSchema = z
  .object({
    assetClass: assetClassSchema,
    symbol: instrumentSymbolSchema,
  })
  .strict();
export type BacktestInstrument = z.infer<typeof backtestInstrumentSchema>;

/**
 * Exit policy — explicit, every field pinned with a default.
 *
 *  - `stopLoss: 'level'` honors the derived stop; `'none'` holds through it
 *    (for R:R analysis — the stop is still used to normalize R).
 *  - `takeProfit` selects which derived target leg exits the trade (`'none'`
 *    disables target exits). A null leg can never be touched; when the strategy
 *    uses its single structural target (stored as TP1), the default TP3 policy
 *    resolves to that available TP1 instead of disabling target exits.
 *  - `maxHoldCandles` exits at the close of the Nth setup candle after the
 *    signal when no level was touched first (intra-candle touches precede
 *    the max-hold close by construction).
 *  - `sameCandleRule` / `entryTiming` are literals, not choices: every M6
 *    result is comparable because the rule cannot vary.
 */
export const backtestExitPolicySchema = z
  .object({
    stopLoss: z.enum(['level', 'none']).default('level'),
    takeProfit: z.enum(['tp1', 'tp2', 'tp3', 'none']).default('tp3'),
    maxHoldCandles: z.number().int().min(1).max(5000).default(DEFAULT_MAX_HOLD_CANDLES),
    sameCandleRule: z.literal('stop_first').default('stop_first'),
    entryTiming: z.literal('signal_close').default('signal_close'),
  })
  .strict();
export type BacktestExitPolicy = z.infer<typeof backtestExitPolicySchema>;
export type BacktestExitPolicyInput = z.input<typeof backtestExitPolicySchema>;

/**
 * Cost + sizing policy — explicit PIP inputs (the platform cost convention:
 * risk `maxSpreadPips`/`maxSlippagePips`, execution fee pips).
 *
 *  - `feePerSide` / `slippagePerSide` apply adversely on BOTH sides;
 *  - `spread` applies adversely at entry only;
 *  - pips become price units via the instrument's `pip_size`
 *    (`instrument_risk_specs`, M8.2 — e.g. 0.0001 EURUSD, 0.01 XAUUSD), which
 *    is why costs are instrument-aware: 1 on gold is 1 cent, not 1 dollar;
 *  - `riskPerTrade` (optional) only scales R into currency P&L — it never
 *    changes entries, exits or R.
 */
export const backtestCostPolicySchema = z
  .object({
    feePerSide: z.number().min(0).finite().default(0),
    slippagePerSide: z.number().min(0).finite().default(0),
    spread: z.number().min(0).finite().default(0),
    riskPerTrade: z.number().positive().finite().max(1e12).optional(),
  })
  .strict();
export type BacktestCostPolicy = z.infer<typeof backtestCostPolicySchema>;
export type BacktestCostPolicyInput = z.input<typeof backtestCostPolicySchema>;

/** POST …/backtests body (Phase 2 route). `from` inclusive, `to` exclusive, epoch-ms (UTC). */
export const backtestRequestSchema = z
  .object({
    instrument: backtestInstrumentSchema,
    direction: backtestDirectionSchema.default('both'),
    from: z.number().int().positive().max(9_999_999_999_999),
    to: z.number().int().positive().max(9_999_999_999_999),
    exitPolicy: backtestExitPolicySchema.default({}),
    costPolicy: backtestCostPolicySchema.default({}),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.from >= b.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: '`from` must be earlier than `to`' });
    }
  });
export type BacktestRequest = z.infer<typeof backtestRequestSchema>;
export type BacktestRequestInput = z.input<typeof backtestRequestSchema>;

/**
 * How a simulated trade ended:
 *  - `stop_loss` / `take_profit_1|2|3` — a level was touched (same-candle
 *    SL+TP resolves to `stop_loss` by the pinned `stop_first` rule);
 *  - `max_hold` — no level touched within `maxHoldCandles` (exit at that
 *    candle's close);
 *  - `range_end` — the range ended first (exit at the last in-range setup
 *    close, or at entry when the signal is on the last in-range candle);
 *  - `no_levels` — no deterministic entry/stop existed (null candidate or
 *    degenerate stop): recorded honestly with null exit/P&L, never skipped.
 */
export const BACKTEST_EXIT_REASONS = [
  'stop_loss',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'max_hold',
  'range_end',
  'no_levels',
] as const;
export type BacktestExitReason = (typeof BACKTEST_EXIT_REASONS)[number];
export const backtestExitReasonSchema = z.enum(BACKTEST_EXIT_REASONS);

/** One simulated setup/trade, in run order (`seq`). */
export const backtestTradeDtoSchema = z
  .object({
    seq: z.number().int().min(0),
    direction: z.enum(['long', 'short']),
    /** The anchor whose M3 evaluation produced this setup (epoch-ms, UTC). */
    signalAsOfMs: z.number().int().positive(),
    entryPrice: z.number().positive().finite().nullable(),
    stopLossPrice: z.number().positive().finite().nullable(),
    tp1Price: z.number().positive().finite().nullable(),
    tp2Price: z.number().positive().finite().nullable(),
    tp3Price: z.number().positive().finite().nullable(),
    /** M5 total at the signal anchor (the setup qualified, so it was scored). */
    qualityScore: z.number().int().min(0).max(100).nullable(),
    qualityGrade: z.enum(['A+', 'A', 'B', 'C', 'ignore']).nullable(),
    exitReason: backtestExitReasonSchema,
    /** Fill price (the touched level, or the resolution candle's close). Null for `no_levels`. */
    exitPrice: z.number().positive().finite().nullable(),
    /** Resolution candle's close time (epoch-ms). Null for `no_levels`. */
    exitAsOfMs: z.number().int().positive().nullable(),
    /** R-multiple net of modeled costs. Null for `no_levels`. */
    pnlR: z.number().finite().nullable(),
    /** `pnlR × riskPerTrade` when supplied, else null. */
    pnlCurrency: z.number().finite().nullable(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.exitReason === 'no_levels') {
      if (t.exitPrice !== null || t.exitAsOfMs !== null || t.pnlR !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['exitReason'],
          message: 'a no_levels trade must have null exitPrice, exitAsOfMs and pnlR',
        });
      }
    } else if (t.exitPrice === null || t.exitAsOfMs === null || t.pnlR === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exitReason'],
        message: 'a closed trade must have exitPrice, exitAsOfMs and pnlR',
      });
    }
  });
export type BacktestTrade = z.infer<typeof backtestTradeDtoSchema>;

/**
 * Run aggregates. Denominators (pinned — see docs/backtesting.md):
 *  - `setupsDetected` counts EVERY qualifying signal, including `no_levels`;
 *  - `tradesClosed` counts trades with any exit except `no_levels`;
 *  - `wins` = closed trades with `pnlR > 0`; `losses` = `pnlR < 0`
 *    (breakeven `pnlR === 0` counts in neither, but in all denominators);
 *  - `winRate` / `expectancyR` divide by `tradesClosed`;
 *  - `profitFactor` = grossWin / |grossLoss| (0 when all trades lose), null when there is no loss
 *    (never Infinity — JSON cannot represent it);
 *  - `maxDrawdownR` is the max peak-to-trough decline of the cumulative-R
 *    equity curve in `seq` order (≥ 0; null with no closed trades).
 */
export const backtestMetricsSchema = z
  .object({
    stepsEvaluated: z.number().int().min(0),
    setupsDetected: z.number().int().min(0),
    tradesClosed: z.number().int().min(0),
    wins: z.number().int().min(0),
    losses: z.number().int().min(0),
    winRate: z.number().min(0).max(1).finite().nullable(),
    expectancyR: z.number().finite().nullable(),
    profitFactor: z.number().nonnegative().finite().nullable(),
    maxDrawdownR: z.number().min(0).finite().nullable(),
    avgWinR: z.number().finite().nullable(),
    avgLossR: z.number().finite().nullable(),
    totalR: z.number().finite(),
    totalCurrency: z.number().finite().nullable(),
  })
  .strict();
export type BacktestMetrics = z.infer<typeof backtestMetricsSchema>;

/** One row of `backtest_runs` (Phase 2 persistence). */
export const backtestRunDtoSchema = z
  .object({
    id: z.string().uuid(),
    strategyId: z.string().uuid(),
    strategyVersionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    instrument: backtestInstrumentSchema,
    direction: backtestDirectionSchema,
    engineVersion: z.string().min(1).max(64),
    fromMs: z.number().int().positive(),
    toMs: z.number().int().positive(),
    exitPolicy: backtestExitPolicySchema,
    costPolicy: backtestCostPolicySchema,
    /** sha256 hex over (version, instrument, direction, range, policies) — the idempotency basis. */
    configHash: z.string().regex(/^[0-9a-f]{64}$/, 'configHash must be sha256 hex'),
    status: z.enum(['completed', 'failed']),
    metrics: backtestMetricsSchema,
    /** Deterministic engine notes (warm-up, truncation, gaps). */
    notes: z.array(z.string()),
    createdAt: z.string().datetime(),
  })
  .strict();
export type BacktestRunDto = z.infer<typeof backtestRunDtoSchema>;

/** GET /api/backtests/:runId response (Phase 2): the run + its trades (first N in seq order). */
export const backtestRunDetailDtoSchema = z
  .object({
    run: backtestRunDtoSchema,
    trades: z.array(backtestTradeDtoSchema).max(MAX_BACKTEST_TRADES),
    /** True when the run holds more than MAX_BACKTEST_TRADES trades. */
    truncated: z.boolean(),
  })
  .strict();
export type BacktestRunDetailDto = z.infer<typeof backtestRunDetailDtoSchema>;

/** GET /api/backtests query (Phase 2; values arrive as strings over HTTP). */
export const backtestListQuerySchema = z
  .object({
    strategyId: z.string().uuid().optional(),
    versionId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_BACKTESTS_LIMIT).default(DEFAULT_BACKTESTS_LIMIT),
  })
  .strict();
export type BacktestListQuery = z.infer<typeof backtestListQuerySchema>;

/** Closed candles per timeframe role (the replay's only data input — store-loaded by the Phase 2 service). */
export interface BacktestCandleSet {
  htf_bias: CandleDto[];
  setup: CandleDto[];
  entry: CandleDto[];
}

export interface BacktestEngineInput {
  /** Published (immutable) version configuration. Treated as read-only. */
  config: StrategyVersionConfig;
  instrument: { assetClass: string; symbol: string };
  /**
   * Instrument pip size in price units (`instrument_risk_specs.pip_size`,
   * M8.2) — the single authoritative value for EVERY pip conversion in the
   * replay: non-zero cost-policy fields (fee/slippage/spread) are pips and are
   * multiplied by it, and it is threaded into the M3 engine so a `pips` risk
   * buffer derives the same levels the live evaluation would. Required
   * whenever the cost policy is non-zero (the loader resolves it from the
   * instrument spec); costless replays ignore it for costs, but a version
   * whose risk buffer is in pips still needs it (M3 fails closed without it).
   */
  pipSize?: number;
  candles: BacktestCandleSet;
  /** Replay bounds, epoch-ms (UTC): anchors are setup closes in [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  /** Which M3 directions to replay (`both` reports long-first, deterministically). */
  direction: BacktestDirection;
  /** Exit policy input (unparsed — the engine applies pinned defaults at its boundary). */
  exitPolicy?: unknown;
  /** Cost policy input (unparsed — the engine applies pinned defaults at its boundary). */
  costPolicy?: unknown;
}

export interface BacktestEngineResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  notes: string[];
  /** Anchors evaluated (post-cap; a truncation note records the requested count). */
  stepsEvaluated: number;
}
