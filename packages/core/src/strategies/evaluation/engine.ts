import {
  DETERMINISTIC_ENGINE_VERSION,
  anchorOffsetOf,
  getConditionType,
  timeframeMinutes,
  type ConditionTimeframeRole,
  type CandleDto,
  type DirectionEvaluation,
  type EvaluationEngine,
  type EvaluationEngineInput,
  type EvaluationEngineResult,
  type GroupOutcome,
  type ConditionOutcome,
  type CandidateLevels,
  type SessionFilterOutcome,
} from '@veltrixeye/contracts';
import { CONDITION_HANDLERS, parseParams } from './handlers.js';
import {
  atrWilder,
  bufferToPrice,
  lastPivotHighAbove,
  lastPivotLowBelow,
  structuralTarget,
  timeInSession,
  validPipSize,
  type Candle,
} from './indicators.js';

/**
 * The deterministic strategy-evaluation engine (M3).
 *
 * Pure function of `(published config, closed candles per role, instrument,
 * asOfMs)` → per-direction evaluation. It:
 *  - treats the configuration as immutable input (published versions are
 *    frozen by DB triggers — the engine only ever reads it),
 *  - evaluates only candles that are CLOSED at the anchor
 *    (`time + period ≤ asOfMs`),
 *  - honours each condition's optional `anchorOffsetCandles`
 *    (`m3-deterministic-eval-3`): the condition is evaluated against ITS
 *    role's candle series with the anchor moved that many candles of that
 *    role's timeframe back, so a coarser prerequisite (e.g. a 4h sweep on the
 *    previous closed 4h candle) can precede finer ones on the same anchor.
 *    `0` — every config stored before the param existed — is the latest closed
 *    candle, byte-identical to the pre-offset behaviour,
 *  - applies rule-group AND/OR logic with top-level AND across groups,
 *  - derives pass/fail per direction from condition classifications,
 *  - fails CLOSED on `insufficient_data`/`unsupported` (see handlers.ts),
 *  - converts `pips` risk buffers with the instrument's AUTHORITATIVE pip size
 *    (`instrument_risk_specs.pip_size`, passed in as `pipSize` on the input)
 *    and only that value — no symbol heuristic exists, and a pips buffer with
 *    a missing/invalid/zero pip size fails CLOSED for both directions
 *    (`pct` buffers do not need it),
 *  - derives candidate entry/SL/TP deterministically for `rr_requirement`,
 *  - persists nothing and never touches the clock, database or providers.
 *
 * Classification semantics (pinned, docs/strategy-engine-contract.md):
 *  - a group containing ≥1 required|confirmation condition must be satisfied
 *    per the group's own logic (OR groups pass when ANY member is satisfied);
 *  - a satisfied disqualifying condition vetoes the direction at CONDITION
 *    level, regardless of group logic;
 *  - a disqualifying condition that cannot be evaluated (insufficient_data /
 *    unsupported) also vetoes — a veto that cannot be ruled out still vetoes;
 *  - required|confirmation conditions that cannot be evaluated block the
 *    direction even inside a satisfied OR group (never silently pass);
 *  - optional-only groups are reported with relevance "ignore" and never
 *    decide pass/fail;
 *  - an empty group is vacuously satisfied;
 *  - version-level sessionFilters are an additional per-direction gate.
 */

/** Half-open candle window used for candidate level derivation. */
const CANDIDATE_WINDOW = 50;
/** ATR period pinned for ATR-based candidate stops. */
const CANDIDATE_ATR_PERIOD = 14;

/**
 * The candle role a condition actually reads.
 *
 * `timeframeRole: 'any'` means the SETUP role (its evaluation convention),
 * except htf_alignment which means the HTF/bias role. Exported so callers
 * that must size or validate role coverage (M6 backtest) use the SAME mapping
 * as the engine and the warm-up windows — there is exactly one role
 * convention.
 */
export function conditionRole(condition: {
  conditionType: string;
  timeframeRole: ConditionTimeframeRole;
}): 'htf_bias' | 'setup' | 'entry' {
  return condition.timeframeRole === 'any'
    ? condition.conditionType === 'htf_alignment'
      ? 'htf_bias'
      : 'setup'
    : condition.timeframeRole === 'htf_bias'
      ? 'htf_bias'
      : condition.timeframeRole === 'entry'
        ? 'entry'
        : 'setup';
}

/**
 * The candle set ONE condition is evaluated against.
 *
 * With `anchorOffsetCandles: 0` (the default for every config stored before
 * the param existed) this is the anchor set, unchanged. With a positive offset
 * the series of the role the condition READS is truncated by that many candles
 * — the role's anchor moves back `offset` bars — and every other role is
 * untouched, so a handler keeps receiving exactly the shape it always did.
 *
 * An offset deeper than the available history yields a shorter (possibly
 * empty) series, which a handler reports as `insufficient_data`: fail closed,
 * never a silent re-anchoring on the latest candle. Candidate levels
 * (`rr_requirement`) stay derived at the EVALUATION anchor — they are a
 * property of the version's risk config, not of a condition's role series.
 */
function conditionCandles(
  closed: EvaluationEngineInput['candles'],
  role: 'htf_bias' | 'setup' | 'entry',
  offset: number,
): EvaluationEngineInput['candles'] {
  if (offset <= 0) return closed;
  const series = closed[role];
  return { ...closed, [role]: series.slice(0, Math.max(0, series.length - offset)) };
}

export function createEvaluationEngine(): EvaluationEngine {
  return {
    engineVersion: DETERMINISTIC_ENGINE_VERSION,
    evaluate,
  };
}

function evaluate(input: EvaluationEngineInput): EvaluationEngineResult {
  const { config, instrument, candles, asOfMs, pipSize } = input;
  if (!config.timeframes) throw new Error('engine requires config.timeframes (published versions always have them)');
  if (!config.risk) throw new Error('engine requires config.risk (published versions always have it)');

  const notes: string[] = [];
  const closed = {
    htf_bias: closedCandles(candles.htf_bias, timeframeMinutes(config.timeframes.htf_bias) * 60_000, asOfMs),
    setup: closedCandles(candles.setup, timeframeMinutes(config.timeframes.setup) * 60_000, asOfMs),
    entry: closedCandles(candles.entry, timeframeMinutes(config.timeframes.entry) * 60_000, asOfMs),
  };

  // Pip-based level conversion uses the instrument's authoritative pip size
  // ONLY (`instrument_risk_specs.pip_size`, resolved by EvaluationService /
  // BacktestService). A `pips` buffer with a missing, invalid or zero pip size
  // cannot be converted, so it fails CLOSED: no candidate levels are invented,
  // and neither direction can pass. `pct` buffers never need a pip size.
  const pipBufferUnresolved = config.risk.stopLossBufferUnit === 'pips' && validPipSize(pipSize) === null;
  const candidateLong = deriveCandidate(config.risk, closed.setup, pipSize, 'long');
  const candidateShort = deriveCandidate(config.risk, closed.setup, pipSize, 'short');
  if (pipBufferUnresolved) {
    notes.push(
      `No candidate levels could be derived: the ${config.risk.stopLossBuffer} ${config.risk.stopLossBufferUnit} ` +
        `stop-loss buffer requires the instrument pip size (instrument_risk_specs.pip_size), which is missing or ` +
        `invalid for ${instrument.symbol} — pip-based conversion fails closed.`,
    );
  } else if (candidateLong === null && candidateShort === null) {
    notes.push(
      'No deterministic candidate entry/stop could be derived at the anchor (insufficient setup history or no structural stop); rr_requirement evaluates as insufficient_data.',
    );
  } else if (candidateLong === null || candidateShort === null) {
    const missing = candidateLong === null ? 'long' : 'short';
    notes.push(
      `No deterministic candidate entry/stop could be derived for ${missing} at the anchor (insufficient setup history or no structural stop on that side); rr_requirement evaluates as insufficient_data for ${missing}.`,
    );
  }
  if (config.filters.length > 0) {
    notes.push(
      `Strategy-level filters are reported but not enforced in M3 (${config.filters.map((f) => f.type).join(', ')}); express filters as rule-group conditions to have them enforced.`,
    );
  }

  const long = evaluateDirection('long', config, closed, candidateLong, pipBufferUnresolved);
  const short = evaluateDirection('short', config, closed, candidateShort, pipBufferUnresolved);
  return { long, short, notes };
}

/** Keep only candles fully closed at the anchor, defensively sorted by time. */
function closedCandles(candles: CandleDto[], periodMs: number, asOfMs: number): Candle[] {
  return candles
    .filter((c) => c.time + periodMs <= asOfMs)
    .slice()
    .sort((a, b) => a.time - b.time);
}

function evaluateDirection(
  direction: 'long' | 'short',
  config: EvaluationEngineInput['config'],
  closed: EvaluationEngineInput['candles'],
  candidate: CandidateLevels | null,
  /** True when a pips buffer could not be converted for lack of a valid pip size. */
  pipBufferUnresolved: boolean,
): DirectionEvaluation {
  const failureReasons: string[] = [];

  // Fail closed: without the authoritative instrument pip size a `pips` risk
  // buffer cannot become a price distance, so no direction may pass on levels
  // that were never derivable.
  if (pipBufferUnresolved) {
    failureReasons.push(
      `risk configuration uses a ${config.risk!.stopLossBuffer} ${config.risk!.stopLossBufferUnit} stop-loss buffer, ` +
        'but the instrument pip size (instrument_risk_specs.pip_size) is missing or invalid — pip-based levels fail closed',
    );
  }

  const groups: GroupOutcome[] = config.ruleGroups.map((group) => {
    const conditions: ConditionOutcome[] = group.conditions.map((condition) => {
      const base = {
        conditionType: condition.conditionType,
        classification: condition.classification,
        timeframeRole: condition.timeframeRole,
      };
      const def = getConditionType(condition.conditionType);
      if (!def) {
        return { ...base, status: 'unsupported', detail: `unknown condition type "${condition.conditionType}"` };
      }
      const params = parseParams(condition.conditionType, condition.params);
      if (params === null) {
        return { ...base, status: 'unsupported', detail: `params for "${condition.conditionType}" failed registry validation` };
      }
      const handler = CONDITION_HANDLERS[condition.conditionType];
      if (!handler) {
        return { ...base, status: 'unsupported', detail: `no handler registered for "${condition.conditionType}"` };
      }
      // Sequential anchors: the condition is evaluated against its role's
      // series shifted `anchorOffsetCandles` bars back (0 = the latest closed
      // candle). Handlers are untouched — they still receive one candle set
      // and read a single role from it.
      const offset = anchorOffsetOf(condition.params);
      const role = conditionRole(condition);
      const result = handler({
        candles: conditionCandles(closed, role, offset),
        timeframeRole: condition.timeframeRole,
        params,
        direction,
        risk: config.risk!,
        asOfMs: 0, // handlers are anchor-independent; the anchor filtered the candles
        candidate,
      });
      return {
        ...base,
        status: result.status,
        // The offset is part of the outcome so a result can always be read
        // back to the exact candles it was computed from (offset 0 — every
        // pre-existing config — keeps the historical detail string verbatim).
        detail:
          offset > 0
            ? `${result.detail} [anchor offset ${offset} × ${config.timeframes![role]}]`
            : result.detail,
      };
    });

    const satisfied =
      group.logic === 'AND'
        ? conditions.length === 0 || conditions.every((c) => c.status === 'satisfied')
        : conditions.some((c) => c.status === 'satisfied');
    const relevance = group.conditions.some(
      (c) => c.classification === 'required' || c.classification === 'confirmation',
    )
      ? 'pass'
      : group.conditions.some((c) => c.classification === 'disqualifying')
        ? 'veto'
        : 'ignore';
    return { name: group.name, logic: group.logic, satisfied, relevance, conditions };
  });

  for (const group of groups) {
    if (group.relevance === 'pass' && !group.satisfied) {
      failureReasons.push(`rule group "${group.name}" (${group.logic}) is not satisfied`);
    }
    for (const condition of group.conditions) {
      if (condition.classification === 'disqualifying' && condition.status === 'satisfied') {
        failureReasons.push(`disqualifying condition "${condition.conditionType}" in group "${group.name}" is satisfied`);
      }
      if (
        (condition.classification === 'required' || condition.classification === 'confirmation') &&
        (condition.status === 'insufficient_data' || condition.status === 'unsupported')
      ) {
        failureReasons.push(
          `required condition "${condition.conditionType}" in group "${group.name}" could not be evaluated (${condition.status})`,
        );
      }
      if (
        condition.classification === 'disqualifying' &&
        (condition.status === 'insufficient_data' || condition.status === 'unsupported')
      ) {
        failureReasons.push(
          `disqualifying condition "${condition.conditionType}" in group "${group.name}" could not be ruled out (${condition.status})`,
        );
      }
    }
  }

  // Version-level session filters: an extra per-direction gate on the anchor
  // candle (setup role). "exchange" timezones cannot be resolved in M3 and
  // fail closed, like the session_requirement condition.
  const sessionFilters: SessionFilterOutcome[] = config.sessionFilters.map((sf) => {
    const anchor = closed.setup[closed.setup.length - 1] ?? null;
    if (!anchor) {
      return { session: sf.session, mode: sf.mode, timezone: sf.timezone, status: 'insufficient_data', detail: 'no closed setup candle at the anchor' };
    }
    if (sf.timezone === 'exchange') {
      return {
        session: sf.session,
        mode: sf.mode,
        timezone: sf.timezone,
        status: 'unsupported',
        detail: 'timezone "exchange" needs an exchange calendar the platform does not have — set timezone "utc"',
      };
    }
    const inSession = timeInSession(anchor.time, sf.session);
    const satisfied = sf.mode === 'include' ? inSession : !inSession;
    const hour = new Date(anchor.time).toISOString().slice(11, 13);
    return {
      session: sf.session,
      mode: sf.mode,
      timezone: sf.timezone,
      status: satisfied ? 'satisfied' : 'unsatisfied',
      detail: `anchor candle (UTC ${hour}:00) is ${inSession ? 'inside' : 'outside'} session "${sf.session}" (${sf.mode})`,
    };
  });
  for (const sf of sessionFilters) {
    if (sf.status === 'insufficient_data' || sf.status === 'unsupported' || sf.status === 'unsatisfied') {
      failureReasons.push(`session filter ${sf.session} (${sf.mode}) blocked the direction (${sf.status})`);
    }
  }

  return {
    direction,
    passed: failureReasons.length === 0,
    groups,
    sessionFilters,
    candidate,
    failureReasons,
  };
}

/**
 * Deterministic candidate levels from the version's risk config (pinned):
 *
 *  - `pipSize`    = the instrument's authoritative pip size
 *                   (`instrument_risk_specs.pip_size`). A `pips`
 *                   `stopLossBuffer` is converted with THAT value and only
 *                   that value — there is no symbol heuristic, and a missing /
 *                   invalid / zero pip size makes this function return null
 *                   (fail closed);
 *  - entry        = close of the last closed setup candle;
 *  - structure SL = most recent confirmed pivot on the stop side — pivot low
 *                   below entry for longs (minus buffer), pivot high above
 *                   entry for shorts (plus buffer); fallback: the window low
 *                   (long) / window high (short) if strictly beyond entry;
 *  - fixed SL     = entry − stopLossBuffer (LONG-convention; M4 mirrors for
 *                   shorts — direction-neutral for M3's riskDistance);
 *  - atr SL       = entry − ATR(14) − buffer (LONG-convention, same reason);
 *  - rr method    = TP1/2/3 at risk multiples above entry (LONG-convention),
 *                   achievableRr = tp3Rr (direction-neutral);
 *  - structure TP = the nearest opposing swing for `direction` stored as
 *                   TP1, with achievableRr measured to that target (TP2/TP3
 *                   remain null; rr_requirement reports "insufficient_data"
 *                   when no target exists);
 *  - manual       = no targets (achievableRr null) — rr_requirement reports
 *                   "unsupported" for that method.
 *
 * Returns null when the configured method's minimum data is unavailable or
 * the resulting risk distance is not strictly positive.
 */
export function deriveCandidate(
  risk: NonNullable<EvaluationEngineInput['config']['risk']>,
  setupClosed: Candle[],
  pipSize?: number,
  direction: 'long' | 'short' = 'long',
): CandidateLevels | null {
  if (setupClosed.length < 2) return null;
  const window = setupClosed.slice(-CANDIDATE_WINDOW);
  const entry = setupClosed[setupClosed.length - 1]?.close;
  if (entry === undefined) return null;
  // Buffer → price units. `pct` scales off the entry price and does not need a
  // pip size; `pips` needs the instrument's authoritative pip size and returns
  // null without one, so the candidate fails closed (never an assumed pip).
  const buffer = bufferToPrice(risk.stopLossBuffer, risk.stopLossBufferUnit, entry, pipSize);
  if (buffer === null) return null;
  // Structure stops are per-direction (stop-side pivots); fixed/atr stops and
  // rr targets stay LONG-convention (stops below, targets above) because M3's
  // consumers only read their direction-neutral riskDistance/achievableRr and
  // M4 mirrors those legs for shorts at persistence time.
  const isLong = direction === 'long';

  let stop: number | null = null;
  let basis: string;
  if (risk.stopLossMethod === 'structure') {
    const pivot = isLong ? lastPivotLowBelow(window, entry) : lastPivotHighAbove(window, entry);
    if (pivot) {
      stop = isLong ? pivot.price - buffer : pivot.price + buffer;
      basis = isLong
        ? `structure stop at ${pivot.price} (recent swing) minus buffer`
        : `structure stop at ${pivot.price} (recent swing) plus buffer`;
    } else {
      // Fallback: window extreme strictly beyond entry on the stop side.
      const extreme = isLong
        ? Math.min(...window.map((c) => c.low))
        : Math.max(...window.map((c) => c.high));
      if (isLong ? extreme >= entry : extreme <= entry) return null;
      stop = isLong ? extreme - buffer : extreme + buffer;
      basis = isLong
        ? `structure stop at window extreme ${extreme} minus buffer`
        : `structure stop at window extreme ${extreme} plus buffer`;
    }
  } else if (risk.stopLossMethod === 'fixed') {
    stop = entry - buffer;
    basis = `fixed stop ${risk.stopLossBuffer}${risk.stopLossBufferUnit} from entry`;
  } else {
    const atr = atrWilder(window, CANDIDATE_ATR_PERIOD);
    if (atr === null) return null;
    stop = entry - atr - buffer;
    basis = `ATR(${CANDIDATE_ATR_PERIOD}) ${atr} below entry plus buffer`;
  }
  if (stop === null || !Number.isFinite(stop) || stop <= 0) return null;
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return null;

  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;
  let achievableRr: number | null = null;
  if (risk.takeProfitMethod === 'rr') {
    tp1 = entry + riskDistance * risk.tp1Rr;
    tp2 = entry + riskDistance * risk.tp2Rr;
    tp3 = entry + riskDistance * risk.tp3Rr;
    achievableRr = risk.tp3Rr;
  } else if (risk.takeProfitMethod === 'structure') {
    const target = structuralTarget(window, direction, entry);
    tp1 = target;
    achievableRr = target === null ? null : Math.abs(target - entry) / riskDistance;
  }

  return {
    entryPrice: entry,
    stopLossPrice: stop,
    riskDistance,
    tp1Price: tp1 !== null && tp1 > 0 ? tp1 : null,
    tp2Price: tp2 !== null && tp2 > 0 ? tp2 : null,
    tp3Price: tp3 !== null && tp3 > 0 ? tp3 : null,
    achievableRr: achievableRr !== null && achievableRr > 0 ? achievableRr : null,
    basis,
  };
}
