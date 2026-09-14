import {
  MAX_BACKTEST_STEPS,
  backtestCostPolicySchema,
  backtestExitPolicySchema,
  timeframeMinutes,
} from '@veltrixeye/contracts';
import type {
  BacktestCostPolicy,
  BacktestEngineInput,
  BacktestEngineResult,
  BacktestExitPolicy,
  BacktestExitReason,
  BacktestMetrics,
  BacktestTrade,
  CandleDto,
  DirectionEvaluation,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import { createEvaluationEngine } from '../strategies/evaluation/engine.js';
import { requiredWindows } from '../strategies/evaluation/service.js';
import { detectionLevels } from '../setups/levels.js';
import { scoreSetupQuality } from '../scoring/engine.js';

/**
 * The deterministic backtest replay engine (M6 Phase 1).
 *
 * PURE: same inputs ⇒ byte-identical outputs. No database, no provider, no
 * ingestion, no wall clock, no network, no filesystem, no randomness. The
 * engine consumes ONLY the published version config, stored candles (loaded
 * by the Phase 2 service), and explicit bounds/policies — and returns
 * in-memory trades, metrics and notes. It persists nothing and calls no
 * service: M3/M4/M5 are reused through their pure functions
 * (`evaluate` / `detectionLevels` / `scoreSetupQuality`), never through
 * `EvaluationService` / `SetupService` / `ScoringService` (those write live
 * rows — replay must never touch `setups`, `setup_scores` or
 * `setup_state_events`).
 *
 * Replay rules (pinned — see docs/backtesting.md):
 *  - anchors are setup-timeframe closes in [fromMs, toMs), ascending, capped
 *    at MAX_BACKTEST_STEPS (first N win, plus a truncation note);
 *  - at every anchor each role sees ONLY candles with
 *    `time + rolePeriod ≤ anchor` (exact M3 closed-candle semantics);
 *  - a passing M3 direction becomes an in-memory setup via `detectionLevels`
 *    and is scored via `scoreSetupQuality` at the anchor;
 *  - entry is the signal-candle close (`signal_close`); exits are tracked
 *    candle-by-candle on the setup timeframe only;
 *  - a candle touching BOTH stop and target resolves to the stop
 *    (`stop_first` — conservative, not configurable);
 *  - costs are explicit inputs (fee/slippage per side, spread at entry);
 *  - R-multiples are primary; currency P&L exists only with `riskPerTrade`.
 *
 * Metrics denominators (pinned):
 *  - `setupsDetected` counts EVERY qualifying signal, including `no_levels`;
 *  - `tradesClosed` counts trades with any exit except `no_levels`;
 *  - `wins` = closed trades with `pnlR > 0`, `losses` = `pnlR < 0`
 *    (breakeven `pnlR === 0` counts in neither, but in all denominators);
 *  - `winRate` / `expectancyR` divide by `tradesClosed`;
 *  - `profitFactor` = grossWin / |grossLoss|, null when there is no loss
 *    (never Infinity — JSON cannot represent it);
 *  - `maxDrawdownR` is the max peak-to-trough decline of the cumulative-R
 *    equity curve in `seq` order (≥ 0; null with no closed trades).
 */
export function runBacktest(input: BacktestEngineInput): BacktestEngineResult {
  const exitPolicy = parseExitPolicy(input.exitPolicy);
  const costPolicy = parseCostPolicy(input.costPolicy);
  const config = input.config;
  if (!config.timeframes) {
    throw Errors.invalidInput('Backtest requires config.timeframes (published versions always have them).');
  }
  if (!config.risk) {
    throw Errors.invalidInput('Backtest requires config.risk (published versions always have it).');
  }
  const { fromMs, toMs } = input;
  if (!Number.isInteger(fromMs) || fromMs <= 0 || !Number.isInteger(toMs) || toMs <= 0) {
    throw Errors.invalidInput('Backtest range bounds must be positive integer epoch-ms.');
  }
  if (fromMs >= toMs) {
    throw Errors.invalidInput('Backtest range must satisfy fromMs < toMs.');
  }

  const directions: Array<'long' | 'short'> = input.direction === 'both' ? ['long', 'short'] : [input.direction];
  const setupPeriodMs = timeframeMinutes(config.timeframes.setup) * 60_000;
  const htfPeriodMs = timeframeMinutes(config.timeframes.htf_bias) * 60_000;
  const entryPeriodMs = timeframeMinutes(config.timeframes.entry) * 60_000;

  // Defensively sorted + deduplicated (last wins — the store-upsert convention),
  // so caller ordering and duplicate timestamps can never change the result.
  const setup = prepareSeries(input.candles.setup);
  const htf = prepareSeries(input.candles.htf_bias);
  const entry = prepareSeries(input.candles.entry);

  const allAnchors = anchorsInRange(setup, setupPeriodMs, fromMs, toMs);
  const truncated = allAnchors.length > MAX_BACKTEST_STEPS;
  const anchors = truncated ? allAnchors.slice(0, MAX_BACKTEST_STEPS) : allAnchors;

  const notes: string[] = [];
  if (anchors.length === 0) {
    notes.push(
      `No setup-timeframe closes in [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}) — nothing evaluated.`,
    );
    return { trades: [], metrics: emptyMetrics(costPolicy), notes, stepsEvaluated: 0 };
  }
  if (truncated) {
    notes.push(
      `Anchor range holds ${allAnchors.length} setup closes — evaluated the first ${MAX_BACKTEST_STEPS} in ascending order (MAX_BACKTEST_STEPS). Split the range to cover the rest.`,
    );
  }

  // Warm-up reporting reuses the M3 window math verbatim — there is exactly
  // one warm-up algorithm in the codebase. Anchors below the window still
  // evaluate (M3 fails closed on insufficient_data); the note reports them.
  const warmupSetup = requiredWindows(config).setup;
  let warmingUp = 0;

  const engine = createEvaluationEngine();
  const trades: BacktestTrade[] = [];
  let noLevels = 0;

  // Monotonic prefix pointers (anchors ascend, so prefixes only grow):
  // each anchor's evaluation receives ONLY the candles closed at that
  // anchor — look-ahead is structurally impossible, not just avoided.
  let htfEnd = 0;
  let setupEnd = 0;
  let entryEnd = 0;
  for (const anchor of anchors) {
    htfEnd = advancePrefix(htf, htfPeriodMs, anchor, htfEnd);
    setupEnd = advancePrefix(setup, setupPeriodMs, anchor, setupEnd);
    entryEnd = advancePrefix(entry, entryPeriodMs, anchor, entryEnd);
    const htfPrefix = htf.slice(0, htfEnd);
    const setupPrefix = setup.slice(0, setupEnd);
    const entryPrefix = entry.slice(0, entryEnd);
    if (setupPrefix.length < warmupSetup) warmingUp += 1;

    const result = engine.evaluate({
      config,
      instrument: input.instrument,
      candles: { htf_bias: htfPrefix, setup: setupPrefix, entry: entryPrefix },
      asOfMs: anchor,
    });

    for (const direction of directions) {
      const dirEval = direction === 'long' ? result.long : result.short;
      if (!dirEval.passed) continue;
      const signal = setupPrefix[setupPrefix.length - 1];
      if (!signal) continue; // unreachable for publishable configs (a pass needs candles)
      const trade = simulateTrade({
        seq: trades.length,
        direction,
        anchor,
        signal,
        setup,
        setupEnd,
        setupPeriodMs,
        toMs,
        dirEval,
        minRr: config.risk.minRr,
        exitPolicy,
        costPolicy,
      });
      if (trade.exitReason === 'no_levels') noLevels += 1;
      trades.push(trade);
    }
  }

  if (warmingUp > 0) {
    notes.push(
      `${warmingUp} of ${anchors.length} anchors had fewer than ${warmupSetup} setup candles (the M3 required warm-up window); those anchors evaluated on available history only (insufficient_data fails closed).`,
    );
  }
  const gaps = countGaps(setup, setupPeriodMs);
  if (gaps > 0) {
    notes.push(
      `Setup series contains ${gaps} gaps wider than 2× the setup timeframe; exits spanning gaps use the next available candle (no interpolation).`,
    );
  }
  if (noLevels > 0) {
    notes.push(
      `${noLevels} qualifying setups recorded as no_levels (no deterministic entry/stop); excluded from R statistics.`,
    );
  }

  const metrics = computeMetrics(trades, anchors.length, costPolicy);
  if (metrics.tradesClosed > 0 && metrics.losses === 0 && metrics.wins > 0) {
    notes.push('Profit factor is undefined (no losing trades); reported as null.');
  }
  return { trades, metrics, notes, stepsEvaluated: anchors.length };
}

/** Sort ascending by time; on duplicate timestamps the LAST candle wins (store-upsert convention). */
function prepareSeries(candles: readonly CandleDto[]): CandleDto[] {
  const byTime = new Map<number, CandleDto>();
  for (const c of candles) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Setup closes in [fromMs, toMs), ascending. */
function anchorsInRange(
  setup: readonly CandleDto[],
  setupPeriodMs: number,
  fromMs: number,
  toMs: number,
): number[] {
  const anchors: number[] = [];
  for (const c of setup) {
    const close = c.time + setupPeriodMs;
    if (close >= fromMs && close < toMs) anchors.push(close);
  }
  return anchors;
}

/** Advance a prefix pointer while candles are closed at the anchor. */
function advancePrefix(candles: readonly CandleDto[], periodMs: number, anchor: number, start: number): number {
  let end = start;
  while (end < candles.length) {
    const c = candles[end];
    if (!c || c.time + periodMs > anchor) break;
    end += 1;
  }
  return end;
}

function parseExitPolicy(policy: unknown): BacktestExitPolicy {
  const parsed = backtestExitPolicySchema.safeParse(policy ?? {});
  if (!parsed.success) {
    throw Errors.invalidInput(
      `Invalid backtest exit policy (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}).`,
    );
  }
  return parsed.data;
}

function parseCostPolicy(policy: unknown): BacktestCostPolicy {
  const parsed = backtestCostPolicySchema.safeParse(policy ?? {});
  if (!parsed.success) {
    throw Errors.invalidInput(
      `Invalid backtest cost policy (${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}).`,
    );
  }
  return parsed.data;
}

interface TradeSimulationInput {
  seq: number;
  direction: 'long' | 'short';
  anchor: number;
  signal: CandleDto;
  /** Full prepared setup series (ascending, deduplicated). */
  setup: CandleDto[];
  /** Prefix end at the anchor (the signal is `setup[setupEnd - 1]`). */
  setupEnd: number;
  setupPeriodMs: number;
  toMs: number;
  dirEval: DirectionEvaluation;
  minRr: number;
  exitPolicy: BacktestExitPolicy;
  costPolicy: BacktestCostPolicy;
}

/**
 * Simulate one qualifying setup: pure M4 levels + pure M5 score, then a
 * candle-by-candle exit scan over the setup candles strictly AFTER the
 * signal and closed within the range. Overlapping trades are independent —
 * each signal gets its own scan (no position netting in M6 core).
 */
function simulateTrade(t: TradeSimulationInput): BacktestTrade {
  const score = scoreSetupQuality({ evaluation: t.dirEval, minRr: t.minRr, asOfMs: t.anchor });
  const levels = detectionLevels(t.dirEval.candidate, t.direction);
  const base = {
    seq: t.seq,
    direction: t.direction,
    signalAsOfMs: t.anchor,
    entryPrice: levels?.entryPrice ?? null,
    stopLossPrice: levels?.stopLossPrice ?? null,
    tp1Price: levels?.tp1Price ?? null,
    tp2Price: levels?.tp2Price ?? null,
    tp3Price: levels?.tp3Price ?? null,
    qualityScore: score.total,
    qualityGrade: score.grade,
  };

  const entry = levels?.entryPrice ?? null;
  const stop = levels?.stopLossPrice ?? null;
  const riskDistance = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
  if (levels === null || entry === null || stop === null || riskDistance === null || !(riskDistance > 0)) {
    // Honest record — the setup qualified but has no measurable risk.
    return {
      ...base,
      exitReason: 'no_levels',
      exitPrice: null,
      exitAsOfMs: null,
      pnlR: null,
      pnlCurrency: null,
    };
  }

  const tpTarget = selectTarget(t.exitPolicy, levels);
  const tpReason: BacktestExitReason =
    t.exitPolicy.takeProfit === 'tp1'
      ? 'take_profit_1'
      : t.exitPolicy.takeProfit === 'tp2'
        ? 'take_profit_2'
        : 'take_profit_3';

  // Exit scan: subsequent setup candles (open after the signal) closed within
  // the range, in time order. Intra-candle touches precede the max-hold close
  // by construction; same-candle SL+TP resolves to the stop (stop_first).
  let exitReason: BacktestExitReason = 'range_end';
  let exitPrice = entry;
  let exitAsOfMs = t.anchor;
  let held = 0;
  for (let i = t.setupEnd; i < t.setup.length; i++) {
    const c = t.setup[i];
    if (!c || c.time + t.setupPeriodMs > t.toMs) break;
    held += 1;
    const slTouched = t.exitPolicy.stopLoss === 'level' && isStopTouched(t.direction, c, stop);
    const tpTouched = tpTarget !== null && isTargetTouched(t.direction, c, tpTarget);
    if (slTouched && tpTouched) {
      exitReason = 'stop_loss';
      exitPrice = stop;
      exitAsOfMs = c.time + t.setupPeriodMs;
      break;
    }
    if (slTouched) {
      exitReason = 'stop_loss';
      exitPrice = stop;
      exitAsOfMs = c.time + t.setupPeriodMs;
      break;
    }
    if (tpTouched && tpTarget !== null) {
      exitReason = tpReason;
      exitPrice = tpTarget;
      exitAsOfMs = c.time + t.setupPeriodMs;
      break;
    }
    if (held === t.exitPolicy.maxHoldCandles) {
      exitReason = 'max_hold';
      exitPrice = c.close;
      exitAsOfMs = c.time + t.setupPeriodMs;
      break;
    }
    exitPrice = c.close;
    exitAsOfMs = c.time + t.setupPeriodMs;
  }
  if (exitReason === 'range_end' && held === 0) {
    // Signal on the last in-range candle: exit at entry (costs still apply).
    exitPrice = entry;
    exitAsOfMs = t.anchor;
  }

  // Costs are adverse by construction: fee/slippage on both sides, spread at entry.
  const totalCost = 2 * (t.costPolicy.feePerSide + t.costPolicy.slippagePerSide) + t.costPolicy.spread;
  const signedMove = t.direction === 'long' ? exitPrice - entry : entry - exitPrice;
  const pnlR = round4((signedMove - totalCost) / riskDistance);
  const pnlCurrency = t.costPolicy.riskPerTrade !== undefined ? round2(pnlR * t.costPolicy.riskPerTrade) : null;
  return { ...base, exitReason, exitPrice, exitAsOfMs, pnlR, pnlCurrency };
}

/** The selected take-profit leg (a null leg can never be touched). */
function selectTarget(
  exitPolicy: BacktestExitPolicy,
  levels: NonNullable<ReturnType<typeof detectionLevels>>,
): number | null {
  if (exitPolicy.takeProfit === 'tp1') return levels.tp1Price;
  if (exitPolicy.takeProfit === 'tp2') return levels.tp2Price;
  if (exitPolicy.takeProfit === 'tp3') return levels.tp3Price;
  return null;
}

function isStopTouched(direction: 'long' | 'short', candle: CandleDto, stop: number): boolean {
  return direction === 'long' ? candle.low <= stop : candle.high >= stop;
}

function isTargetTouched(direction: 'long' | 'short', candle: CandleDto, target: number): boolean {
  return direction === 'long' ? candle.high >= target : candle.low <= target;
}

/** Gaps (consecutive spacing > 2× period) in an ascending prepared series. */
function countGaps(series: readonly CandleDto[], periodMs: number): number {
  let gaps = 0;
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (prev && cur && cur.time - prev.time > 2 * periodMs) gaps += 1;
  }
  return gaps;
}

function computeMetrics(
  trades: readonly BacktestTrade[],
  stepsEvaluated: number,
  costPolicy: BacktestCostPolicy,
): BacktestMetrics {
  const closed = trades.filter((t) => t.exitReason !== 'no_levels' && t.pnlR !== null);
  const wins = closed.filter((t) => (t.pnlR ?? 0) > 0);
  const losses = closed.filter((t) => (t.pnlR ?? 0) < 0);
  const totalR = round4(closed.reduce((sum, t) => sum + (t.pnlR ?? 0), 0));
  const grossWin = wins.reduce((sum, t) => sum + (t.pnlR ?? 0), 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, t) => sum + (t.pnlR ?? 0), 0));

  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const t of closed) {
    equity += t.pnlR ?? 0;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    stepsEvaluated,
    setupsDetected: trades.length,
    tradesClosed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? round4(wins.length / closed.length) : null,
    expectancyR: closed.length > 0 ? round4(totalR / closed.length) : null,
    profitFactor: grossLossAbs > 0 ? round4(grossWin / grossLossAbs) : null,
    maxDrawdownR: closed.length > 0 ? round4(maxDrawdown) : null,
    avgWinR: wins.length > 0 ? round4(grossWin / wins.length) : null,
    avgLossR: losses.length > 0 ? round4(-grossLossAbs / losses.length) : null,
    totalR,
    totalCurrency: costPolicy.riskPerTrade !== undefined ? round2(totalR * costPolicy.riskPerTrade) : null,
  };
}

function emptyMetrics(costPolicy: BacktestCostPolicy): BacktestMetrics {
  return {
    stepsEvaluated: 0,
    setupsDetected: 0,
    tradesClosed: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    expectancyR: null,
    profitFactor: null,
    maxDrawdownR: null,
    avgWinR: null,
    avgLossR: null,
    totalR: 0,
    totalCurrency: costPolicy.riskPerTrade !== undefined ? 0 : null,
  };
}

/** Round to 4 decimals (R values); normalizes -0 to 0 for stable equality. */
function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return rounded === 0 ? 0 : rounded;
}

/** Round to 2 decimals (currency values); normalizes -0 to 0. */
function round2(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}
