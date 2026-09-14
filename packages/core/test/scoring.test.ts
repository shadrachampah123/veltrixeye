import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  M5_SCORE_ENGINE_VERSION,
  qualityGrade,
  type CandidateLevels,
  type ConditionOutcome,
  type DirectionEvaluation,
  type EvaluationOutcomeStatus,
  type GroupOutcome,
  type M5ScoringContext,
  type SessionFilterOutcome,
} from '@veltrixeye/contracts';
import {
  createQualityScoringEngine,
  M5_COMPONENT_WEIGHTS,
  M5_FAILING_DIRECTION_CAP,
  scoreSetupQuality,
} from '../src/index.js';

const AS_OF = 1_800_000_000_000;

const CANDIDATE: CandidateLevels = {
  entryPrice: 101.3,
  stopLossPrice: 100.3,
  riskDistance: 1,
  tp1Price: 102.3,
  tp2Price: 103.3,
  tp3Price: 104.3,
  achievableRr: 3,
  basis: 'fixed stop 1 pips from entry; RR targets above',
};

function cond(
  conditionType: string,
  classification: ConditionOutcome['classification'],
  status: EvaluationOutcomeStatus,
  timeframeRole: ConditionOutcome['timeframeRole'] = 'setup',
): ConditionOutcome {
  return { conditionType, classification, timeframeRole, status, detail: `${conditionType}: ${status}` };
}

function group(name: string, conditions: ConditionOutcome[], logic: 'AND' | 'OR' = 'AND'): GroupOutcome {
  const gating = conditions.some((c) => c.classification === 'required' || c.classification === 'confirmation');
  const veto = conditions.some((c) => c.classification === 'disqualifying');
  return {
    name,
    logic,
    satisfied: conditions.every((c) => c.status === 'satisfied'),
    relevance: gating ? 'pass' : veto ? 'veto' : 'ignore',
    conditions,
  };
}

function dirEval(args: {
  groups?: GroupOutcome[];
  sessionFilters?: SessionFilterOutcome[];
  candidate?: CandidateLevels | null;
  passed?: boolean;
  direction?: 'long' | 'short';
}): DirectionEvaluation {
  return {
    direction: args.direction ?? 'long',
    passed: args.passed ?? true,
    groups: args.groups ?? [],
    sessionFilters: args.sessionFilters ?? [],
    candidate: args.candidate === undefined ? CANDIDATE : args.candidate,
    failureReasons: args.passed === false ? ['fixture: direction does not pass'] : [],
  };
}

function ctx(evaluation: DirectionEvaluation, overrides: Partial<Omit<M5ScoringContext, 'evaluation'>> = {}): M5ScoringContext {
  return { evaluation, minRr: 2, asOfMs: AS_OF, ...overrides };
}

function byName(score: ReturnType<typeof scoreSetupQuality>, name: string) {
  const component = score.components.find((c) => c.name === name);
  assert.ok(component, `component "${name}" missing from breakdown`);
  return component;
}

/** The rich fixture: every classification present, everything in favour. */
function richEvaluation(): DirectionEvaluation {
  return dirEval({
    groups: [
      group('gate', [
        cond('engulfing_candle', 'required', 'satisfied'),
        cond('displacement', 'confirmation', 'satisfied'),
        cond('news_filter', 'disqualifying', 'unsatisfied', 'any'),
      ]),
      group('support', [cond('fvg', 'optional', 'satisfied', 'entry'), cond('order_block', 'optional', 'satisfied', 'entry')]),
      group('bias', [cond('htf_alignment', 'required', 'satisfied', 'htf_bias')]),
    ],
  });
}

describe('m5 scoring engine — determinism and shape', () => {
  test('identical inputs always produce the identical score (no clock, no randomness)', () => {
    const evaluation = richEvaluation();
    const a = scoreSetupQuality(ctx(evaluation));
    const b = scoreSetupQuality(ctx(evaluation));
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    // A different anchor changes ONLY generatedAt — the score itself is a
    // function of the evaluation content.
    const later = scoreSetupQuality(ctx(evaluation, { asOfMs: AS_OF + 3_600_000 }));
    assert.equal(later.total, a.total);
    assert.deepEqual(later.components, a.components);
    assert.notEqual(later.generatedAt, a.generatedAt);
  });

  test('score version is the pinned m5 identifier', () => {
    const score = scoreSetupQuality(ctx(richEvaluation()));
    assert.equal(score.engineVersion, 'm5-quality-score-1');
    assert.equal(score.engineVersion, M5_SCORE_ENGINE_VERSION);
    const engine = createQualityScoringEngine();
    assert.equal(engine.version, M5_SCORE_ENGINE_VERSION);
    assert.equal(engine.id, 'veltrixeye-setup-quality');
  });

  test('generatedAt is the deterministic ISO rendering of the anchor', () => {
    const score = scoreSetupQuality(ctx(richEvaluation()));
    assert.equal(score.generatedAt, new Date(AS_OF).toISOString());
  });

  test('total is an integer bounded to 0–100 and graded by the documented bands', () => {
    for (const evaluation of [richEvaluation(), dirEval({ groups: [], passed: true, candidate: null })]) {
      const score = scoreSetupQuality(ctx(evaluation));
      assert.ok(Number.isInteger(score.total));
      assert.ok(score.total >= 0 && score.total <= 100);
      assert.equal(score.grade, qualityGrade(score.total));
    }
  });

  test('breakdown is exactly the seven pinned components with weights summing to 100', () => {
    const score = scoreSetupQuality(ctx(richEvaluation()));
    assert.deepEqual(
      score.components.map((c) => c.name),
      [
        'required_conditions',
        'confirmation_conditions',
        'disqualifier_clearance',
        'optional_support',
        'directional_alignment',
        'setup_completeness',
        'data_sufficiency',
      ],
    );
    const weightSum = score.components.reduce((sum, c) => sum + c.weight, 0);
    assert.equal(weightSum, 100);
    for (const c of score.components) {
      assert.equal(c.maxPoints, c.weight, `${c.name}: maxPoints must equal weight`);
      assert.ok(c.points >= 0 && c.points <= c.maxPoints, `${c.name}: points within [0, maxPoints]`);
      assert.ok(c.score >= 0 && c.score <= 100, `${c.name}: score within [0, 100]`);
      // points = weight * score/100 up to the 2-decimal display rounding.
      assert.ok(Math.abs(c.points - (c.weight * c.score) / 100) < 0.011, `${c.name}: points consistent with score`);
      assert.ok(c.explanation.length > 0, `${c.name}: explanation present`);
    }
    // Without the failing-direction cap the total is exactly round(Σ points).
    assert.equal(score.total, Math.round(score.components.reduce((sum, c) => sum + c.points, 0)));
    assert.equal(Object.values(M5_COMPONENT_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  });

  test('a fully supported passing setup earns a top-band score', () => {
    const score = scoreSetupQuality(ctx(richEvaluation()));
    assert.equal(score.total, 100);
    assert.equal(score.grade, 'A+');
    assert.equal(byName(score, 'required_conditions').points, 25);
    assert.equal(byName(score, 'optional_support').points, 15);
  });
});

describe('m5 scoring engine — component contributions', () => {
  test('required conditions contribute proportionally to satisfaction', () => {
    const full = scoreSetupQuality(
      ctx(dirEval({ groups: [group('g', [cond('a', 'required', 'satisfied'), cond('b', 'required', 'satisfied')])] })),
    );
    assert.equal(byName(full, 'required_conditions').score, 100);
    assert.equal(byName(full, 'required_conditions').points, 25);

    const half = scoreSetupQuality(
      ctx(
        dirEval({
          passed: false,
          groups: [group('g', [cond('a', 'required', 'satisfied'), cond('b', 'required', 'unsatisfied')])],
        }),
      ),
    );
    assert.equal(byName(half, 'required_conditions').score, 50);
    assert.equal(byName(half, 'required_conditions').points, 12.5);
    assert.ok(byName(half, 'required_conditions').explanation.includes('b (unsatisfied)'));
  });

  test('confirmation conditions contribute the same way', () => {
    const score = scoreSetupQuality(
      ctx(dirEval({ groups: [group('g', [cond('a', 'confirmation', 'satisfied'), cond('b', 'confirmation', 'insufficient_data')])] })),
    );
    assert.equal(byName(score, 'confirmation_conditions').score, 50);
    assert.equal(byName(score, 'confirmation_conditions').points, 7.5);
  });

  test('vacuous gate components (none declared) are clear, with explicit explanations', () => {
    const score = scoreSetupQuality(ctx(dirEval({ groups: [] })));
    const required = byName(score, 'required_conditions');
    const confirmation = byName(score, 'confirmation_conditions');
    const clearance = byName(score, 'disqualifier_clearance');
    assert.equal(required.points, 25);
    assert.equal(confirmation.points, 15);
    assert.equal(clearance.points, 20);
    assert.ok(required.explanation.includes('no required conditions declared'));
    assert.ok(confirmation.explanation.includes('no confirmation conditions declared'));
    assert.ok(clearance.explanation.includes('no disqualifying conditions declared'));
  });

  test('optional support earns nothing when none are declared (absence of evidence)', () => {
    const score = scoreSetupQuality(ctx(dirEval({ groups: [] })));
    const optional = byName(score, 'optional_support');
    assert.equal(optional.points, 0);
    assert.ok(optional.explanation.includes('no optional conditions declared'));
  });

  test('optional support is proportional when declared', () => {
    const score = scoreSetupQuality(
      ctx(
        dirEval({
          groups: [
            group('required', [cond('a', 'required', 'satisfied')]),
            group('extra', [cond('o1', 'optional', 'satisfied'), cond('o2', 'optional', 'unsatisfied')]),
          ],
        }),
      ),
    );
    const optional = byName(score, 'optional_support');
    assert.equal(optional.score, 50);
    assert.equal(optional.points, 7.5);
    assert.ok(optional.explanation.includes('o2 (unsatisfied)'));
  });

  test('disqualifying clearance: unsatisfied clears, satisfied vetoes, unevaluable fails closed', () => {
    const cleared = scoreSetupQuality(
      ctx(dirEval({ groups: [group('veto', [cond('news_filter', 'disqualifying', 'unsatisfied', 'any')])] })),
    );
    assert.equal(byName(cleared, 'disqualifier_clearance').points, 20);

    const vetoed = scoreSetupQuality(
      ctx(dirEval({ passed: false, groups: [group('veto', [cond('news_filter', 'disqualifying', 'satisfied', 'any')])] })),
    );
    assert.equal(byName(vetoed, 'disqualifier_clearance').points, 0);
    assert.ok(byName(vetoed, 'disqualifier_clearance').explanation.includes('news_filter (satisfied)'));

    const notRuledOut = scoreSetupQuality(
      ctx(
        dirEval({
          passed: false,
          groups: [group('veto', [cond('news_filter', 'disqualifying', 'insufficient_data', 'any')])],
        }),
      ),
    );
    assert.equal(byName(notRuledOut, 'disqualifier_clearance').points, 0);
    assert.ok(byName(notRuledOut, 'disqualifier_clearance').explanation.includes('insufficient_data'));
  });

  test('directional alignment uses htf_bias-role conditions; disqualifiers excluded', () => {
    const aligned = scoreSetupQuality(
      ctx(dirEval({ groups: [group('bias', [cond('htf_alignment', 'required', 'satisfied', 'htf_bias')])] })),
    );
    assert.equal(byName(aligned, 'directional_alignment').points, 10);

    const none = scoreSetupQuality(ctx(dirEval({ groups: [group('g', [cond('a', 'required', 'satisfied')])] })));
    assert.equal(byName(none, 'directional_alignment').points, 0);
    assert.ok(byName(none, 'directional_alignment').explanation.includes('no higher-timeframe bias conditions declared'));

    // A disqualifying condition on the htf role belongs to clearance, not alignment.
    const disqOnHtf = scoreSetupQuality(
      ctx(dirEval({ groups: [group('bias', [cond('htf_alignment', 'disqualifying', 'unsatisfied', 'htf_bias')])] })),
    );
    assert.equal(byName(disqOnHtf, 'directional_alignment').points, 0);
    assert.equal(byName(disqOnHtf, 'disqualifier_clearance').points, 20);
  });

  test('setup completeness: candidate, targets, RR and session filters each count a quarter', () => {
    const complete = scoreSetupQuality(ctx(dirEval({ groups: [group('g', [cond('a', 'required', 'satisfied')])] })));
    assert.equal(byName(complete, 'setup_completeness').points, 10);

    const noCandidate = scoreSetupQuality(
      ctx(dirEval({ groups: [group('g', [cond('a', 'required', 'satisfied')])], candidate: null })),
    );
    // candidate missing ⇒ entry/stop, targets and RR checks all fail; no filters ⇒ that check passes.
    assert.equal(byName(noCandidate, 'setup_completeness').score, 25);
    assert.equal(byName(noCandidate, 'setup_completeness').points, 2.5);

    const weakRr = scoreSetupQuality(
      ctx(
        dirEval({
          groups: [group('g', [cond('a', 'required', 'satisfied')])],
          candidate: { ...CANDIDATE, achievableRr: 1.5 },
        }),
        { minRr: 2 },
      ),
    );
    assert.equal(byName(weakRr, 'setup_completeness').score, 75);
    assert.ok(byName(weakRr, 'setup_completeness').explanation.includes('achievable R:R'));

    const missingTargets = scoreSetupQuality(
      ctx(
        dirEval({
          groups: [group('g', [cond('a', 'required', 'satisfied')])],
          candidate: { ...CANDIDATE, tp2Price: null, tp3Price: null },
        }),
      ),
    );
    assert.equal(byName(missingTargets, 'setup_completeness').score, 75);

    const blockedSession: SessionFilterOutcome = {
      session: 'london',
      mode: 'include',
      timezone: 'utc',
      status: 'unsatisfied',
      detail: 'anchor candle is outside session',
    };
    const sessionFail = scoreSetupQuality(
      ctx(dirEval({ groups: [group('g', [cond('a', 'required', 'satisfied')])], sessionFilters: [blockedSession] })),
    );
    assert.equal(byName(sessionFail, 'setup_completeness').score, 75);
    assert.ok(byName(sessionFail, 'setup_completeness').explanation.includes('session filters'));
  });

  test('insufficient data can never manufacture quality', () => {
    const evaluation = dirEval({
      passed: false,
      candidate: null,
      groups: [group('g', [cond('engulfing_candle', 'required', 'insufficient_data')])],
    });
    const score = scoreSetupQuality(ctx(evaluation));
    assert.equal(byName(score, 'required_conditions').points, 0);
    assert.equal(byName(score, 'data_sufficiency').points, 0);
    assert.ok(byName(score, 'data_sufficiency').explanation.includes('insufficient_data or unsupported'));
    assert.ok(score.total <= M5_FAILING_DIRECTION_CAP);
    assert.equal(score.grade, 'ignore');
  });

  test('unsupported conditions earn no optional support and reduce data sufficiency', () => {
    const evaluation = dirEval({
      groups: [
        group('g', [cond('a', 'required', 'satisfied')]),
        group('news', [cond('news_filter', 'optional', 'unsupported', 'any')]),
      ],
    });
    const score = scoreSetupQuality(ctx(evaluation));
    assert.equal(byName(score, 'optional_support').points, 0);
    assert.equal(byName(score, 'data_sufficiency').score, 50); // 1 of 2 evaluable
    assert.equal(byName(score, 'data_sufficiency').points, 2.5);
  });

  test('data sufficiency with no declared conditions/filters earns nothing', () => {
    const score = scoreSetupQuality(ctx(dirEval({ groups: [] })));
    assert.equal(byName(score, 'data_sufficiency').points, 0);
    assert.ok(byName(score, 'data_sufficiency').explanation.includes('no conditions or session filters declared'));
  });
});

describe('m5 scoring engine — failing-direction cap and lifecycle neutrality', () => {
  test('a direction that does not pass is capped below the C band (grade ignore)', () => {
    // Rich evidence but the required gate is unsatisfied ⇒ passed=false.
    const evaluation = dirEval({
      passed: false,
      groups: [
        group('gate', [
          cond('engulfing_candle', 'required', 'unsatisfied'),
          cond('displacement', 'confirmation', 'satisfied'),
        ]),
        group('extra', [cond('o1', 'optional', 'satisfied')]),
        group('bias', [cond('htf_alignment', 'optional', 'satisfied', 'htf_bias')]),
      ],
    });
    const score = scoreSetupQuality(ctx(evaluation));
    const uncapped = score.components.reduce((sum, c) => sum + c.points, 0);
    assert.ok(uncapped > M5_FAILING_DIRECTION_CAP, 'fixture would score above the cap without the rule');
    assert.equal(score.total, M5_FAILING_DIRECTION_CAP);
    assert.equal(score.grade, 'ignore');
  });

  test('the cap never raises a score that is already below it', () => {
    const evaluation = dirEval({
      passed: false,
      candidate: null,
      groups: [group('g', [cond('a', 'required', 'unsatisfied')])],
    });
    const score = scoreSetupQuality(ctx(evaluation));
    assert.ok(score.total < M5_FAILING_DIRECTION_CAP);
    assert.equal(score.total, Math.round(score.components.reduce((sum, c) => sum + c.points, 0)));
  });

  test('a passing minimal setup lands in a middle band — quality is earned, not given', () => {
    // Mirrors an M4-detected setup from a single-required-condition strategy:
    // 25 required + 15 confirmation (vacuous) + 20 clearance (vacuous) +
    // 0 optional (none declared) + 0 alignment (none declared) +
    // 10 completeness + 5 data sufficiency = 75.
    const score = scoreSetupQuality(ctx(dirEval({ groups: [group('entry', [cond('engulfing_candle', 'required', 'satisfied')])] })));
    assert.equal(score.total, 75);
    assert.equal(score.grade, 'B');
  });
});

describe('m5 scoring engine — QualityScoringEngine adapter boundary', () => {
  test('the adapter produces exactly what the pure engine produces', async () => {
    const engine = createQualityScoringEngine();
    const evaluation = richEvaluation();
    const viaAdapter = await engine.score({
      strategyVersionId: '11111111-1111-1111-1111-111111111111',
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long',
      context: { evaluation, minRr: 2, asOfMs: AS_OF },
    });
    assert.deepEqual(viaAdapter, scoreSetupQuality(ctx(evaluation)));
  });

  test('malformed context is rejected with a caller error — never a silent score', async () => {
    const engine = createQualityScoringEngine();
    const base = {
      strategyVersionId: '11111111-1111-1111-1111-111111111111',
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      direction: 'long' as const,
    };
    await assert.rejects(engine.score({ ...base, context: {} }), /evaluation/);
    await assert.rejects(
      engine.score({ ...base, context: { evaluation: { broken: true }, minRr: 2, asOfMs: AS_OF } }),
      /evaluation/,
    );
    await assert.rejects(
      engine.score({ ...base, context: { evaluation: richEvaluation(), minRr: -1, asOfMs: AS_OF } }),
      /minRr/,
    );
    await assert.rejects(
      engine.score({ ...base, context: { evaluation: richEvaluation(), minRr: 2, asOfMs: 0 } }),
      /asOfMs/,
    );
    await assert.rejects(
      engine.score({ ...base, direction: 'short', context: { evaluation: richEvaluation(), minRr: 2, asOfMs: AS_OF } }),
      /direction/,
    );
  });
});
