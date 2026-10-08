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
  SetupQualityScore,
  StrategyVersionConfig,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import { createEvaluationEngine } from '../strategies/evaluation/engine.js';
import { validPipSize } from '../strategies/evaluation/indicators.js';
import { conditionRole, requiredWindows } from '../strategies/evaluation/service.js';
import { detectionLevels } from '../setups/levels.js';
import { scoreSetupQuality } from '../scoring/engine.js';

/**
 * The deterministic backtest replay engine (M6 Phase 1 + M6.2 coverage).
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
 *  - a role the version reads must be COVERED at the anchor: a bias/entry
 *    series that is empty or already exhausted fails the run closed
 *    (see `assertRoleCoverage`) — a stale prefix is never replayed as
 *    current data;
 *  - a passing M3 direction is scored via `scoreSetupQuality` at the anchor
 *    and gated by the published version's `risk.minQualityScore` — the SAME
 *    gate `AlertService.generateAlert` enforces live — BEFORE it becomes an
 *    in-memory setup: a below-minimum setup is not counted in
 *    `setupsDetected` and produces no trade (not even a `no_levels` row);
 *  - a setup that clears the gate becomes an in-memory trade via
 *    `detectionLevels`;
 *  - entry is the signal-candle close (`signal_close`); exits are tracked
 *    candle-by-candle on the setup timeframe only;
 *  - a candle touching BOTH stop and target resolves to the stop
 *    (`stop_first` — conservative, not configurable);
 *  - costs are explicit inputs in PIPS (fee/slippage per side, spread at
 *    entry), converted to price units with the instrument's pip size, so the
 *    same policy means the same thing on EURUSD and XAUUSD;
 *  - that SAME authoritative pip size (`instrument_risk_specs.pip_size`) is
 *    passed to M3 for every anchor, so a version whose risk buffer is in pips
 *    derives exactly the levels live evaluation would (M3 fails the direction
 *    closed when the pip size is missing/invalid — the replay never invents
 *    one, and `pct` buffers never need it);
 *  - R-multiples are primary; currency P&L exists only with `riskPerTrade`.
 *
 * Metrics denominators (pinned):
 *  - `setupsDetected` counts every qualifying signal that ALSO clears the
 *    version's `minQualityScore` gate, including `no_levels`;
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
  /**
   * The instrument's authoritative pip size (`instrument_risk_specs.pip_size`)
   * or undefined when it has no spec. It is threaded into BOTH conversions the
   * replay performs — M3 level derivation and cost pricing — so one run can
   * never mix pip sizes.
   */
  const pipSize = resolvePipSize(input.pipSize, costPolicy);
  /**
   * Cost conversion factor. `pipSize` is guaranteed defined whenever the cost
   * policy is non-zero (`resolvePipSize` refuses otherwise), so the `?? 1`
   * fallback is only reachable when every cost is zero — where the multiplier
   * is inert (0 × anything = 0).
   */
  const costPipSize = pipSize ?? 1;
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
  /**
   * The published version's alert gate, read from the SAME config the live
   * path reads (`AlertService.generateAlert` compares the M5 total against
   * `version.config.risk.minQualityScore`). A qualifying setup that scores
   * below it never becomes a simulated trade — backtest qualification must
   * match the live alert gate, so a setup live would never alert on is never
   * counted here. The schema defaults the field, so `?? 0` only guards a
   * hand-built config (0 = no gate, the historical behaviour).
   */
  const minQualityScore = config.risk.minQualityScore ?? 0;
  let gatedByQuality = 0;

  // M6.2: only roles the version reads can make a replay stale. The setup
  // role is the anchor source — it is covered at its own anchor by
  // construction — but the bias and entry roles are loaded independently and
  // can run out mid-range (see `roleCoverageWindow`).
  const coverageRoles = requiredCoverageRoles(config);

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
    assertRoleCoverage('htf_bias', htf, htfPeriodMs, anchor, htfEnd, coverageRoles.htf_bias);
    assertRoleCoverage('entry', entry, entryPeriodMs, anchor, entryEnd, coverageRoles.entry);
    const htfPrefix = htf.slice(0, htfEnd);
    const setupPrefix = setup.slice(0, setupEnd);
    const entryPrefix = entry.slice(0, entryEnd);
    if (setupPrefix.length < warmupSetup) warmingUp += 1;

    const result = engine.evaluate({
      config,
      instrument: input.instrument,
      // Same authoritative pip size as the cost conversion below: M3 derives
      // the trade levels the replay then charges costs against.
      pipSize,
      candles: { htf_bias: htfPrefix, setup: setupPrefix, entry: entryPrefix },
      asOfMs: anchor,
    });

    for (const direction of directions) {
      const dirEval = direction === 'long' ? result.long : result.short;
      if (!dirEval.passed) continue;
      const signal = setupPrefix[setupPrefix.length - 1];
      if (!signal) continue; // unreachable for publishable configs (a pass needs candles)
      // M6-backtest-5 score gate: the M5 quality score is computed at the
      // anchor and compared against the version's `minQualityScore` BEFORE
      // any level derivation or trade simulation — a below-minimum setup is
      // skipped entirely (no trade, no `no_levels` row, no `setupsDetected`
      // count), exactly as the live alert gate would silence it.
      const score = scoreSetupQuality({
        evaluation: dirEval,
        minRr: config.risk.minRr,
        takeProfitMethod: config.risk.takeProfitMethod,
        asOfMs: anchor,
      });
      if (score.total < minQualityScore) {
        gatedByQuality += 1;
        continue;
      }
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
        score,
        takeProfitMethod: config.risk.takeProfitMethod,
        exitPolicy,
        costPolicy,
        pipSize: costPipSize,
      });
      if (trade.exitReason === 'no_levels') noLevels += 1;
      trades.push(trade);
    }
  }

  if (gatedByQuality > 0) {
    notes.push(
      `${gatedByQuality} qualifying setup(s) scored below the version's minQualityScore (${minQualityScore}) ` +
        `and were not simulated — the same gate live alerts enforce.`,
    );
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

// ---------------------------------------------------------------------------
// Loader coverage (M6.2) — pure planning helpers for BacktestService
// ---------------------------------------------------------------------------

/**
 * The exact [from, to) window and row cap that cover ONE timeframe role for
 * one backtest run. The service passes these straight to
 * `CandleStore.queryCandles`, which reads ascending — so the cap keeps the
 * EARLIEST candles, which are the ones the replay consumes first.
 */
export interface BacktestRoleWindow {
  /** Inclusive lower bound on candle open time. */
  from: number;
  /** Exclusive upper bound on candle open time. */
  to: number;
  /** Row cap — the largest number of candles the replay can consume. */
  limit: number;
}

/**
 * WHY THIS EXISTS. A replay consumes candles per ROLE, not per anchor: one
 * anchor costs one setup candle but `setupPeriod / entryPeriod` entry candles
 * (16 for a 4h setup with a 15m entry). The pre-M6.2 loader capped every role
 * at `warm-up + MAX_BACKTEST_STEPS + 500`, i.e. it budgeted ONE candle per
 * anchor for every role. Past that cap the ascending store read returned a
 * truncated prefix, the prefix pointer stopped advancing, and every later
 * anchor silently re-evaluated the SAME stale bias/entry candle — a long
 * backtest reported confident results computed on history that had already
 * ended. Coverage is now derived from each role's own period, and the
 * engine fails closed (`assertRoleCoverage`) if a required role still runs
 * out before an anchor.
 */
export function setupCoverageWindow(args: {
  config: StrategyVersionConfig;
  fromMs: number;
  toMs: number;
  maxHoldCandles: number;
}): BacktestRoleWindow {
  const periodMs = rolePeriodMs(args.config, 'setup');
  const warmup = requiredWindows(args.config).setup;
  return {
    // Warm-up candles (closed before `fromMs`) are never anchors but M3 needs
    // them: same `window + 1` alignment the live evaluation service uses.
    from: Math.max(0, args.fromMs - (warmup + 1) * periodMs),
    // Anchors are setup closes < toMs, and the exit scan stops at the range
    // end, so nothing past `toMs` can ever be read.
    to: args.toMs,
    // warm-up + one candle per evaluated anchor + the max-hold exit tail of
    // the last anchor (+2 alignment candles).
    limit: warmup + 1 + MAX_BACKTEST_STEPS + Math.max(0, args.maxHoldCandles) + 2,
  };
}

/**
 * Latest setup close the engine will evaluate for this range — the coverage
 * horizon for every non-anchor role. Zero anchors ⇒ `fromMs` (nothing to
 * cover). Reuses `anchorsInRange`, so the horizon can never disagree with
 * the anchors the engine actually replays.
 */
export function anchorHorizonMs(args: {
  setup: readonly CandleDto[];
  setupPeriodMs: number;
  fromMs: number;
  toMs: number;
}): number {
  const anchors = anchorsInRange(
    prepareSeries(args.setup),
    args.setupPeriodMs,
    args.fromMs,
    args.toMs,
  );
  const lastEvaluated = anchors[Math.min(anchors.length, MAX_BACKTEST_STEPS) - 1];
  return lastEvaluated ?? args.fromMs;
}

/**
 * Coverage for a role that does NOT define anchors (bias / entry): every
 * candle of that timeframe closed at or before the last evaluated anchor,
 * plus one more candle.
 *
 * The extra candle is the freshness witness: it opens at or after the
 * horizon, so it can never enter a prefix (`time + period > anchor` for every
 * anchor), yet its presence proves the series was not truncated inside the
 * replay. Without it a coarse role (say a weekly bias) whose next candle only
 * opens after the horizon would look "exhausted" and fail closed for a
 * perfectly covered run.
 */
export function roleCoverageWindow(args: {
  role: 'htf_bias' | 'entry';
  config: StrategyVersionConfig;
  fromMs: number;
  horizonMs: number;
}): BacktestRoleWindow {
  const periodMs = rolePeriodMs(args.config, args.role);
  const warmup = requiredWindows(args.config)[args.role];
  const from = Math.max(0, args.fromMs - (warmup + 1) * periodMs);
  const to = args.horizonMs + periodMs;
  return {
    from,
    to,
    limit: warmup + 1 + Math.ceil((to - from) / periodMs) + 1,
  };
}

function rolePeriodMs(config: StrategyVersionConfig, role: 'htf_bias' | 'setup' | 'entry'): number {
  const timeframes = config.timeframes;
  if (!timeframes) {
    throw Errors.invalidInput('Backtest requires config.timeframes (published versions always have them).');
  }
  return timeframeMinutes(timeframes[role]) * 60_000;
}

/**
 * Roles the version actually READS. Only these can make a run stale — a
 * version with no bias/entry condition never looks at those candles, so an
 * empty or short series there is irrelevant (and must not fail the run).
 */
export function requiredCoverageRoles(config: StrategyVersionConfig): Record<'htf_bias' | 'setup' | 'entry', boolean> {
  const roles = { htf_bias: false, setup: false, entry: false };
  for (const group of config.ruleGroups) {
    for (const condition of group.conditions) {
      roles[conditionRole(condition)] = true;
    }
  }
  return roles;
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

/**
 * FAIL-CLOSED coverage guard for one non-anchor role (M6.2).
 *
 * A replay is only meaningful while each required role still has candles
 * closing at the anchor. Two states are rejected instead of silently
 * replaying history that has already ended:
 *
 *  - MISSING: the role has no candles at all, so every anchor would evaluate
 *    with an empty (and, per M3, insufficient-data) prefix;
 *  - STALE: the pointer has consumed the whole series while the last loaded
 *    candle closed BEFORE the anchor — the store read was truncated (or the
 *    history simply stops), so the next anchor would re-read that same old
 *    candle as if it were current.
 *
 * An empty PREFIX at an anchor is not an error: that is the ordinary warm-up
 * / not-yet-closed state that M3 already reports as `insufficient_data`.
 */
function assertRoleCoverage(
  role: 'htf_bias' | 'entry',
  series: readonly CandleDto[],
  periodMs: number,
  anchor: number,
  end: number,
  required: boolean,
): void {
  if (!required) return;
  const label = role === 'htf_bias' ? 'bias (htf_bias)' : 'entry';
  const last = series[series.length - 1];
  if (!last) {
    throw Errors.invalidInput(
      `Backtest cannot evaluate this version: no ${label}-timeframe candles were loaded for the requested range, ` +
        `but the version reads them. Ingest ${label}-timeframe history for the range (or backtest a version whose rules do not use the ${label} timeframe).`,
    );
  }
  if (end === series.length && last.time + periodMs < anchor) {
    throw Errors.invalidInput(
      `Backtest coverage for the ${label} timeframe ends at ${new Date(last.time + periodMs).toISOString()} — ` +
        `before the anchor ${new Date(anchor).toISOString()}. Replaying further would re-use stale ${label} candles, ` +
        `so the run was refused: split the range into shorter backtests or ingest more ${label}-timeframe history.`,
    );
  }
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

/** Total modeled cost of one trade, in pips (fee/slippage both sides, spread at entry). */
function totalCostPips(costPolicy: BacktestCostPolicy): number {
  return 2 * (costPolicy.feePerSide + costPolicy.slippagePerSide) + costPolicy.spread;
}

/**
 * The instrument's authoritative pip size (price units per pip) for every pip
 * conversion in the replay: pip-denominated COSTS and pip-denominated M3 risk
 * buffers.
 *
 * Returns the value unchanged (or undefined when the instrument has no spec).
 * A non-zero cost policy without a pip size is refused — otherwise an absent
 * value would silently reintroduce the unit bug this guards against. A
 * costless replay is scale-independent for costs, so it may omit the value,
 * but the engine still passes it on to M3, where a `pips` risk buffer fails
 * closed without it. The service resolves the value from
 * `instrument_risk_specs.pip_size` (M8.2); here it is validated at the pure
 * engine boundary.
 */
function resolvePipSize(pipSize: number | undefined, costPolicy: BacktestCostPolicy): number | undefined {
  if (pipSize !== undefined && validPipSize(pipSize) === null) {
    throw Errors.invalidInput('Backtest pipSize must be a positive finite number of price units per pip.');
  }
  if (totalCostPips(costPolicy) === 0) return pipSize; // costless: nothing to convert
  if (pipSize === undefined) {
    throw Errors.invalidInput(
      'Backtest costs are pips and require the instrument pip size (instrument_risk_specs.pip_size), ' +
        'but none was supplied for this instrument.',
    );
  }
  return pipSize;
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
  /**
   * The M5 quality score computed at the anchor by the caller — already
   * gated by the version's `minQualityScore` (m6-backtest-5). Simulating a
   * trade never re-scores: one anchor, one score, one gate.
   */
  score: SetupQualityScore;
  takeProfitMethod: NonNullable<StrategyVersionConfig['risk']>['takeProfitMethod'];
  exitPolicy: BacktestExitPolicy;
  costPolicy: BacktestCostPolicy;
  /**
   * Cost conversion factor (price units per pip): the instrument's
   * authoritative pip size, or `1` when the cost policy is all-zero (inert).
   */
  pipSize: number;
}

/**
 * Simulate one QUALIFIED setup (M3 passed AND the version's `minQualityScore`
 * gate cleared — the caller scored and gated it): pure M4 levels over the M3
 * candidate, then a candle-by-candle exit scan over the setup candles
 * strictly AFTER the signal and closed within the range. Overlapping trades
 * are independent — each signal gets its own scan (no position netting in
 * M6 core).
 */
function simulateTrade(t: TradeSimulationInput): BacktestTrade {
  const score = t.score;
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

  const tpTarget = selectTarget(t.exitPolicy, levels, t.takeProfitMethod);

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
    const tpTouched = tpTarget !== null && isTargetTouched(t.direction, c, tpTarget.price);
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
      exitReason = tpTarget.exitReason;
      exitPrice = tpTarget.price;
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

  // Costs are adverse by construction: fee/slippage on both sides, spread at
  // entry. The policy is in pips, so one instrument-aware conversion happens
  // here — the same policy on XAUUSD (pip 0.01) costs 100× the price units of
  // EURUSD (pip 0.0001), which is exactly what "1 pip" means for each.
  const totalCost = totalCostPips(t.costPolicy) * t.pipSize;
  const signedMove = t.direction === 'long' ? exitPrice - entry : entry - exitPrice;
  const pnlR = round4((signedMove - totalCost) / riskDistance);
  const pnlCurrency = t.costPolicy.riskPerTrade !== undefined ? round2(pnlR * t.costPolicy.riskPerTrade) : null;
  return { ...base, exitReason, exitPrice, exitAsOfMs, pnlR, pnlCurrency };
}

/** The selected take-profit leg (a null leg can never be touched). */
function selectTarget(
  exitPolicy: BacktestExitPolicy,
  levels: NonNullable<ReturnType<typeof detectionLevels>>,
  takeProfitMethod: NonNullable<StrategyVersionConfig['risk']>['takeProfitMethod'],
): { price: number; exitReason: BacktestExitReason } | null {
  if (exitPolicy.takeProfit === 'tp1') {
    return levels.tp1Price === null ? null : { price: levels.tp1Price, exitReason: 'take_profit_1' };
  }
  if (exitPolicy.takeProfit === 'tp2') {
    return levels.tp2Price === null ? null : { price: levels.tp2Price, exitReason: 'take_profit_2' };
  }
  if (exitPolicy.takeProfit === 'tp3') {
    if (levels.tp3Price !== null) return { price: levels.tp3Price, exitReason: 'take_profit_3' };
    // Structural TP is a single level stored in tp1. The backtest policy's
    // default is tp3, so let that default resolve to the available structural
    // target rather than silently running without a take-profit level.
    if (takeProfitMethod === 'structure' && levels.tp1Price !== null) {
      return { price: levels.tp1Price, exitReason: 'take_profit_1' };
    }
  }
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
