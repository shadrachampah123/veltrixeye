import {
  DETERMINISTIC_ENGINE_VERSION,
  getConditionType,
  timeframeMinutes,
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
 *  - applies rule-group AND/OR logic with top-level AND across groups,
 *  - derives pass/fail per direction from condition classifications,
 *  - fails CLOSED on `insufficient_data`/`unsupported` (see handlers.ts),
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

export function createEvaluationEngine(): EvaluationEngine {
  return {
    engineVersion: DETERMINISTIC_ENGINE_VERSION,
    evaluate,
  };
}

function evaluate(input: EvaluationEngineInput): EvaluationEngineResult {
  const { config, instrument, candles, asOfMs } = input;
  if (!config.timeframes) throw new Error('engine requires config.timeframes (published versions always have them)');
  if (!config.risk) throw new Error('engine requires config.risk (published versions always have it)');

  const notes: string[] = [];
  const closed = {
    htf_bias: closedCandles(candles.htf_bias, timeframeMinutes(config.timeframes.htf_bias) * 60_000, asOfMs),
    setup: closedCandles(candles.setup, timeframeMinutes(config.timeframes.setup) * 60_000, asOfMs),
    entry: closedCandles(candles.entry, timeframeMinutes(config.timeframes.entry) * 60_000, asOfMs),
  };

  const candidate = deriveCandidate(config.risk, closed.setup, instrument.symbol);
  if (candidate === null) {
    notes.push(
      'No deterministic candidate entry/stop could be derived at the anchor (insufficient setup history or no structural stop); rr_requirement evaluates as insufficient_data.',
    );
  }
  if (config.filters.length > 0) {
    notes.push(
      `Strategy-level filters are reported but not enforced in M3 (${config.filters.map((f) => f.type).join(', ')}); express filters as rule-group conditions to have them enforced.`,
    );
  }

  const long = evaluateDirection('long', config, closed, candidate, asOfMs);
  const short = evaluateDirection('short', config, closed, candidate, asOfMs);
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
  _asOfMs: number,
): DirectionEvaluation {
  const failureReasons: string[] = [];

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
      const result = handler({
        candles: closed,
        timeframeRole: condition.timeframeRole,
        params,
        direction,
        risk: config.risk!,
        asOfMs: 0, // handlers are anchor-independent; the anchor filtered the candles
        candidate,
      });
      return { ...base, status: result.status, detail: result.detail };
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
 *  - entry        = close of the last closed setup candle;
 *  - structure SL = most recent confirmed pivot beyond entry (fallback: the
 *                   extreme of the candidate window if strictly beyond entry);
 *  - fixed SL     = entry ∓ stopLossBuffer (converted via pips/pct);
 *  - atr SL       = entry ∓ ATR(14) ∓ buffer;
 *  - rr method    = TP1/2/3 at risk multiples (tp1Rr..tp3Rr), achievableRr = tp3Rr;
 *  - structure    = achievableRr measured to the nearest opposing swing;
 *  - manual       = no targets (achievableRr null) — rr_requirement reports
 *                   "unsupported" for that method.
 *
 * Returns null when the configured method's minimum data is unavailable or
 * the resulting risk distance is not strictly positive.
 */
export function deriveCandidate(
  risk: NonNullable<EvaluationEngineInput['config']['risk']>,
  setupClosed: Candle[],
  symbol: string,
): CandidateLevels | null {
  if (setupClosed.length < 2) return null;
  const window = setupClosed.slice(-CANDIDATE_WINDOW);
  const entry = setupClosed[setupClosed.length - 1]?.close;
  if (entry === undefined) return null;
  const buffer = bufferToPrice(risk.stopLossBuffer, risk.stopLossBufferUnit, entry, symbol);
  // PINNED: candidate levels use the LONG convention (stops below entry,
  // rr targets above). rr_requirement only consumes riskDistance and
  // achievableRr, which are direction-neutral; M4 derives per-direction
  // levels when it persists setups.
  const long = true;

  let stop: number | null = null;
  let basis: string;
  if (risk.stopLossMethod === 'structure') {
    const pivot = long ? lastPivotLowBelow(window, entry) : lastPivotHighAbove(window, entry);
    if (pivot) {
      stop = long ? pivot.price - buffer : pivot.price + buffer;
      basis = `structure stop at ${pivot.price} (recent swing) minus buffer`;
    } else {
      // Fallback: window extreme strictly beyond entry.
      const extreme = Math.min(...window.map((c) => c.low));
      if (extreme >= entry) return null;
      stop = extreme - buffer;
      basis = `structure stop at window extreme ${extreme} minus buffer`;
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
    const target = structuralTarget(window, 'long', entry);
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
