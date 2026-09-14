import {
  directionEvaluationSchema,
  M5_SCORE_ENGINE_VERSION,
  qualityGrade,
  type ConditionOutcome,
  type M5ScoringContext,
  type QualityScoringEngine,
  type ScoreComponent,
  type ScoringInput,
  type SessionFilterOutcome,
  type SetupQualityScore,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';

/**
 * The deterministic setup-quality scoring engine (M5).
 *
 * Pure function of `(M3 direction evaluation, version minRr, asOfMs)` →
 * a bounded, explainable 0–100 quality score. It:
 *  - consumes ONLY data produced by M3/M4 (never candles directly, never a
 *    provider, never the database),
 *  - never reads the wall clock, never generates randomness, performs no
 *    I/O of any kind — identical inputs always produce the identical score,
 *  - scores SETUP QUALITY (strength and completeness of the evidence behind
 *    a detected setup). It makes no prediction and implies no probability
 *    of profit,
 *  - fails safely: unevaluable conditions (insufficient_data/unsupported)
 *    never earn points and always reduce data sufficiency.
 *
 * Formula (pinned as `m5-quality-score-1`, docs/setup-scoring.md):
 *  - seven fixed components whose weights sum to 100; component scores are
 *    0–100 and the total is the weight-weighted average rounded to the
 *    nearest integer (then clamped to 0–100);
 *  - GATE components (required, confirmation, disqualifier clearance) treat
 *    "none declared" as vacuously clear — exactly M3's satisfaction
 *    semantics — and earn full points;
 *  - EVIDENCE components (optional support, directional alignment, data
 *    sufficiency) earn NO points when nothing is declared: absence of
 *    evidence is never rewarded with manufactured quality;
 *  - a direction that does NOT pass its M3 evaluation at the scoring anchor
 *    can never produce an actionable score: the total is capped at 64
 *    (grade "ignore", below the C band at 65).
 *
 * Changing ANY rule above requires a NEW engine version string — the same
 * version must always mean the same formula.
 */

/** Component weights — pinned, sum to exactly 100. */
export const M5_COMPONENT_WEIGHTS = {
  required_conditions: 25,
  confirmation_conditions: 15,
  disqualifier_clearance: 20,
  optional_support: 15,
  directional_alignment: 10,
  setup_completeness: 10,
  data_sufficiency: 5,
} as const;
export type M5ComponentName = keyof typeof M5_COMPONENT_WEIGHTS;

/**
 * Hard cap applied when the scored direction does not pass its M3
 * evaluation at the scoring anchor. 64 is the highest integer below the
 * C band (≥ 65), so a failing direction always grades "ignore".
 */
export const M5_FAILING_DIRECTION_CAP = 64;

/**
 * Score one direction evaluation. Pure and synchronous — the async interface
 * required by `QualityScoringEngine` is provided by `createQualityScoringEngine`.
 */
export function scoreSetupQuality(context: M5ScoringContext): SetupQualityScore {
  const { evaluation, asOfMs } = context;
  const conditions = evaluation.groups.flatMap((g) => g.conditions);

  const components: ScoreComponent[] = [
    gateComponent(
      'required_conditions',
      'Required condition strength',
      M5_COMPONENT_WEIGHTS.required_conditions,
      conditions.filter((c) => c.classification === 'required'),
      'required',
    ),
    gateComponent(
      'confirmation_conditions',
      'Confirmation condition strength',
      M5_COMPONENT_WEIGHTS.confirmation_conditions,
      conditions.filter((c) => c.classification === 'confirmation'),
      'confirmation',
    ),
    clearanceComponent(
      M5_COMPONENT_WEIGHTS.disqualifier_clearance,
      conditions.filter((c) => c.classification === 'disqualifying'),
    ),
    evidenceComponent(
      'optional_support',
      'Optional condition support',
      M5_COMPONENT_WEIGHTS.optional_support,
      conditions.filter((c) => c.classification === 'optional'),
      'no optional conditions declared — no additional support',
    ),
    alignmentComponent(
      M5_COMPONENT_WEIGHTS.directional_alignment,
      conditions.filter((c) => c.timeframeRole === 'htf_bias' && c.classification !== 'disqualifying'),
    ),
    completenessComponent(M5_COMPONENT_WEIGHTS.setup_completeness, context),
    dataSufficiencyComponent(M5_COMPONENT_WEIGHTS.data_sufficiency, conditions, evaluation.sessionFilters),
  ];

  // Total = round(Σ points) over the persisted (2-decimal) component
  // contributions, clamped, then capped for failing directions — so the
  // stored breakdown is arithmetically verifiable against the total.
  const pointsTotal = components.reduce((sum, c) => sum + c.points, 0);
  let total = Math.max(0, Math.min(100, Math.round(pointsTotal)));
  if (!evaluation.passed) {
    total = Math.min(total, M5_FAILING_DIRECTION_CAP);
  }

  return {
    total,
    grade: qualityGrade(total),
    components,
    engineVersion: M5_SCORE_ENGINE_VERSION,
    generatedAt: new Date(asOfMs).toISOString(),
  };
}

/** Round to 2 decimals for display; internal totals keep exact values. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Build a component from a fraction of satisfied evidence [0..1]. */
function component(
  name: M5ComponentName,
  label: string,
  weight: number,
  fraction: number,
  explanation: string,
): ScoreComponent {
  const clamped = Math.max(0, Math.min(1, fraction));
  return {
    name,
    label,
    weight,
    score: round2(clamped * 100),
    points: round2(weight * clamped),
    maxPoints: weight,
    explanation,
  };
}

/** satisfied / declared for a classification; vacuous gates earn full marks. */
function gateComponent(
  name: 'required_conditions' | 'confirmation_conditions',
  label: string,
  weight: number,
  declared: ConditionOutcome[],
  kind: 'required' | 'confirmation',
): ScoreComponent {
  if (declared.length === 0) {
    return component(
      name,
      label,
      weight,
      1,
      `no ${kind} conditions declared — nothing to satisfy (vacuously clear)`,
    );
  }
  const satisfied = declared.filter((c) => c.status === 'satisfied').length;
  const fraction = satisfied / declared.length;
  const unsatisfied = declared.filter((c) => c.status !== 'satisfied');
  const explanation =
    satisfied === declared.length
      ? `${satisfied}/${declared.length} ${kind} conditions satisfied at the anchor`
      : `${satisfied}/${declared.length} ${kind} conditions satisfied; not satisfied: ${unsatisfied
          .map((c) => `${c.conditionType} (${c.status})`)
          .join(', ')}`;
  return component(name, label, weight, fraction, explanation);
}

/**
 * Disqualifying clearance: a disqualifier is cleared only when evaluated and
 * UNSATISFIED. Satisfied disqualifiers veto; unevaluable ones (insufficient
 * data / unsupported) fail closed and are NOT cleared.
 */
function clearanceComponent(weight: number, declared: ConditionOutcome[]): ScoreComponent {
  if (declared.length === 0) {
    return component(
      'disqualifier_clearance',
      'Disqualifying-condition clearance',
      weight,
      1,
      'no disqualifying conditions declared — nothing to rule out',
    );
  }
  const cleared = declared.filter((c) => c.status === 'unsatisfied').length;
  const fraction = cleared / declared.length;
  const unresolved = declared.filter((c) => c.status !== 'unsatisfied');
  const explanation =
    cleared === declared.length
      ? `all ${declared.length} disqualifying conditions ruled out (unsatisfied)`
      : `${cleared}/${declared.length} disqualifying conditions ruled out; unresolved: ${unresolved
          .map((c) => `${c.conditionType} (${c.status})`)
          .join(', ')}`;
  return component('disqualifier_clearance', 'Disqualifying-condition clearance', weight, fraction, explanation);
}

/** satisfied / declared for optional support; absence earns nothing. */
function evidenceComponent(
  name: M5ComponentName,
  label: string,
  weight: number,
  declared: ConditionOutcome[],
  emptyExplanation: string,
): ScoreComponent {
  if (declared.length === 0) {
    return component(name, label, weight, 0, emptyExplanation);
  }
  const satisfied = declared.filter((c) => c.status === 'satisfied').length;
  const fraction = satisfied / declared.length;
  const explanation =
    satisfied === declared.length
      ? `${satisfied}/${declared.length} optional conditions support the setup`
      : `${satisfied}/${declared.length} optional conditions satisfied; unsupporting: ${declared
          .filter((c) => c.status !== 'satisfied')
          .map((c) => `${c.conditionType} (${c.status})`)
          .join(', ')}`;
  return component(name, label, weight, fraction, explanation);
}

/**
 * Directional alignment: non-disqualifying conditions evaluated on the
 * higher-timeframe bias role. Absence earns nothing (no alignment evidence).
 */
function alignmentComponent(weight: number, declared: ConditionOutcome[]): ScoreComponent {
  if (declared.length === 0) {
    return component(
      'directional_alignment',
      'Directional alignment (HTF)',
      weight,
      0,
      'no higher-timeframe bias conditions declared — no directional-alignment evidence',
    );
  }
  const satisfied = declared.filter((c) => c.status === 'satisfied').length;
  const fraction = satisfied / declared.length;
  const explanation =
    satisfied === declared.length
      ? `${satisfied}/${declared.length} higher-timeframe bias conditions align with the setup direction`
      : `${satisfied}/${declared.length} higher-timeframe bias conditions satisfied; misaligned/unevaluated: ${declared
          .filter((c) => c.status !== 'satisfied')
          .map((c) => `${c.conditionType} (${c.status})`)
          .join(', ')}`;
  return component('directional_alignment', 'Directional alignment (HTF)', weight, fraction, explanation);
}

/**
 * Setup completeness — four equally weighted sub-checks:
 *  1. a deterministic candidate (entry + stop) was derived at the anchor;
 *  2. all three take-profit targets were derived;
 *  3. the achievable risk:reward meets the version's configured minimum;
 *  4. every version session filter is satisfied at the anchor
 *     (no filters declared ⇒ vacuously satisfied).
 */
function completenessComponent(weight: number, context: M5ScoringContext): ScoreComponent {
  const { evaluation, minRr } = context;
  const candidate = evaluation.candidate;
  const checks: Array<{ name: string; ok: boolean }> = [
    { name: 'candidate entry/stop derived', ok: candidate !== null },
    {
      name: 'all take-profit targets derived',
      ok: candidate !== null && candidate.tp1Price !== null && candidate.tp2Price !== null && candidate.tp3Price !== null,
    },
    {
      name: `achievable R:R meets the configured minimum (${minRr})`,
      ok: candidate !== null && candidate.achievableRr !== null && candidate.achievableRr >= minRr,
    },
    {
      name: 'all session filters satisfied at the anchor',
      ok: evaluation.sessionFilters.every((sf) => sf.status === 'satisfied'),
    },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const fraction = passed / checks.length;
  const failing = checks.filter((c) => !c.ok).map((c) => c.name);
  const explanation =
    failing.length === 0
      ? `setup is complete: ${checks.map((c) => c.name).join('; ')}`
      : `${passed}/${checks.length} completeness checks passed; failing: ${failing.join('; ')}`;
  return component('setup_completeness', 'Setup completeness', weight, fraction, explanation);
}

/**
 * Data sufficiency: the share of conditions + session filters that were
 * actually evaluable (satisfied or unsatisfied). Conditions in
 * insufficient_data/unsupported never earn points anywhere else either, so
 * missing data can never manufacture quality.
 */
function dataSufficiencyComponent(
  weight: number,
  conditions: ConditionOutcome[],
  sessionFilters: SessionFilterOutcome[],
): ScoreComponent {
  const universe = conditions.length + sessionFilters.length;
  if (universe === 0) {
    return component(
      'data_sufficiency',
      'Data sufficiency',
      weight,
      0,
      'no conditions or session filters declared — no data-sufficiency evidence',
    );
  }
  const evaluable =
    conditions.filter((c) => c.status === 'satisfied' || c.status === 'unsatisfied').length +
    sessionFilters.filter((sf) => sf.status === 'satisfied' || sf.status === 'unsatisfied').length;
  const fraction = evaluable / universe;
  const explanation =
    evaluable === universe
      ? `all ${universe} conditions and session filters were evaluable at the anchor`
      : `${evaluable}/${universe} conditions/session filters evaluable — the rest reported insufficient_data or unsupported`;
  return component('data_sufficiency', 'Data sufficiency', weight, fraction, explanation);
}

/**
 * The engine as the M1 `QualityScoringEngine` interface: validates the
 * untyped `ScoringInput.context` at the boundary, then delegates to the
 * pure `scoreSetupQuality`. Malformed context is a caller error (400-class),
 * never a silent zero score.
 */
export function createQualityScoringEngine(): QualityScoringEngine {
  return {
    id: 'veltrixeye-setup-quality',
    version: M5_SCORE_ENGINE_VERSION,
    async score(input: ScoringInput): Promise<SetupQualityScore> {
      const ctx = parseScoringContext(input);
      return scoreSetupQuality(ctx);
    },
  };
}

/** Runtime validation of the untyped engine boundary (pure, no I/O). */
export function parseScoringContext(input: ScoringInput): M5ScoringContext {
  const context = input.context ?? {};
  const evaluation = directionEvaluationSchema.safeParse(context.evaluation);
  if (!evaluation.success) {
    throw Errors.invalidInput(
      `Scoring context is malformed: "evaluation" failed validation (${evaluation.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}).`,
    );
  }
  if (evaluation.data.direction !== input.direction) {
    throw Errors.invalidInput(
      `Scoring context is malformed: evaluation direction "${evaluation.data.direction}" does not match setup direction "${input.direction}".`,
    );
  }
  const minRr = context.minRr;
  if (typeof minRr !== 'number' || !Number.isFinite(minRr) || minRr <= 0) {
    throw Errors.invalidInput('Scoring context is malformed: "minRr" must be a positive finite number.');
  }
  const asOfMs = context.asOfMs;
  if (typeof asOfMs !== 'number' || !Number.isInteger(asOfMs) || asOfMs <= 0) {
    throw Errors.invalidInput('Scoring context is malformed: "asOfMs" must be a positive integer.');
  }
  return { evaluation: evaluation.data, minRr, asOfMs };
}
