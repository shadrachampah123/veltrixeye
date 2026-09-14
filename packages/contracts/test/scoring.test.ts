import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SCORE_HISTORY_LIMIT,
  M5_SCORE_ENGINE_VERSION,
  MAX_SCORE_HISTORY_LIMIT,
  qualityGrade,
  scoreComponentSchema,
  scoreHistoryQuerySchema,
  setupQualityScoreSchema,
  setupScoreDtoSchema,
  setupScoreRequestSchema,
  setupScoreResponseDtoSchema,
  setupScoreHistoryResponseDtoSchema,
} from '../src/index.js';

const COMPONENT = {
  name: 'required_conditions',
  label: 'Required condition strength',
  weight: 25,
  score: 100,
  points: 25,
  maxPoints: 25,
  explanation: '1/1 required conditions satisfied at the anchor',
};

const SCORE_DTO = {
  id: 1,
  setupId: '11111111-1111-1111-1111-111111111111',
  engineVersion: M5_SCORE_ENGINE_VERSION,
  asOfMs: 1_800_000_000_000,
  total: 75,
  grade: 'B',
  components: [COMPONENT],
  createdAt: new Date(1_800_000_000_000).toISOString(),
};

describe('m5 scoring contracts', () => {
  test('the pinned engine version is the documented M5 identifier', () => {
    assert.equal(M5_SCORE_ENGINE_VERSION, 'm5-quality-score-1');
    assert.ok(M5_SCORE_ENGINE_VERSION.length <= 120); // setup_scores.engine_version CHECK
  });

  test('grade bands match the setup_scores CHECK constraint vocabulary', () => {
    const grades = new Set(['A+', 'A', 'B', 'C', 'ignore'].map((g) => qualityGrade(
      g === 'A+' ? 95 : g === 'A' ? 87 : g === 'B' ? 80 : g === 'C' ? 70 : 10,
    )));
    assert.deepEqual([...grades].sort(), ['A', 'A+', 'B', 'C', 'ignore'].sort());
  });

  test('scoreComponentSchema requires raw + max contribution and an explanation', () => {
    assert.equal(scoreComponentSchema.safeParse(COMPONENT).success, true);
    assert.equal(scoreComponentSchema.safeParse({ ...COMPONENT, points: -1 }).success, false);
    assert.equal(scoreComponentSchema.safeParse({ ...COMPONENT, maxPoints: 101 }).success, false);
    assert.equal(scoreComponentSchema.safeParse({ ...COMPONENT, score: 150 }).success, false);
    const { explanation: _explanation, ...rest } = COMPONENT;
    assert.equal(scoreComponentSchema.safeParse(rest).success, false);
    assert.equal(scoreComponentSchema.safeParse({ ...COMPONENT, unknownKey: 1 }).success, false);
  });

  test('setupQualityScoreSchema validates engine output shapes', () => {
    const valid = {
      total: 75,
      grade: 'B',
      components: [COMPONENT],
      engineVersion: M5_SCORE_ENGINE_VERSION,
      generatedAt: new Date(1_800_000_000_000).toISOString(),
    };
    assert.equal(setupQualityScoreSchema.safeParse(valid).success, true);
    assert.equal(setupQualityScoreSchema.safeParse({ ...valid, total: 101 }).success, false);
    assert.equal(setupQualityScoreSchema.safeParse({ ...valid, total: 74.5 }).success, false);
    assert.equal(setupQualityScoreSchema.safeParse({ ...valid, grade: 'S' }).success, false);
    assert.equal(setupQualityScoreSchema.safeParse({ ...valid, components: [] }).success, false);
  });

  test('setupScoreRequestSchema: asOf is optional, strict, and bounded', () => {
    assert.deepEqual(setupScoreRequestSchema.parse({}), {});
    assert.equal(setupScoreRequestSchema.safeParse({ asOf: 1_800_000_000_000 }).success, true);
    assert.equal(setupScoreRequestSchema.safeParse({ asOf: 1.5 }).success, false);
    assert.equal(setupScoreRequestSchema.safeParse({ asOf: 0 }).success, false);
    assert.equal(setupScoreRequestSchema.safeParse({ asOf: 10_000_000_000_000 }).success, false);
    assert.equal(setupScoreRequestSchema.safeParse({ asOf: 'now' }).success, false);
    assert.equal(setupScoreRequestSchema.safeParse({ asOf: 1, unknown: true }).success, false);
  });

  test('scoreHistoryQuerySchema coerces limit and bounds it', () => {
    assert.equal(scoreHistoryQuerySchema.parse({}).limit, DEFAULT_SCORE_HISTORY_LIMIT);
    assert.equal(scoreHistoryQuerySchema.parse({ limit: '5' }).limit, 5);
    assert.equal(scoreHistoryQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(scoreHistoryQuerySchema.safeParse({ limit: MAX_SCORE_HISTORY_LIMIT + 1 }).success, false);
    assert.equal(scoreHistoryQuerySchema.safeParse({ other: 1 }).success, false);
  });

  test('setupScoreDtoSchema validates persisted score rows', () => {
    assert.equal(setupScoreDtoSchema.safeParse(SCORE_DTO).success, true);
    assert.equal(setupScoreDtoSchema.safeParse({ ...SCORE_DTO, total: 101 }).success, false);
    assert.equal(setupScoreDtoSchema.safeParse({ ...SCORE_DTO, grade: 'S' }).success, false);
    assert.equal(setupScoreDtoSchema.safeParse({ ...SCORE_DTO, engineVersion: '' }).success, false);
    assert.equal(setupScoreDtoSchema.safeParse({ ...SCORE_DTO, asOfMs: 0 }).success, false);
    assert.equal(setupScoreDtoSchema.safeParse({ ...SCORE_DTO, setupId: 'not-a-uuid' }).success, false);
  });

  test('score response DTOs compose setup + score + idempotency flag', () => {
    const setup = {
      id: '11111111-1111-1111-1111-111111111111',
      strategyId: '22222222-2222-2222-2222-222222222222',
      strategyVersionId: '33333333-3333-3333-3333-333333333333',
      versionNumber: 1,
      instrument: { assetClass: 'forex', symbol: 'EURUSD' },
      state: 'confirmed',
      direction: 'long',
      asOfMs: 1_800_000_000_000,
      detectedAt: new Date(1_800_000_000_000).toISOString(),
      updatedAt: new Date(1_800_000_000_000).toISOString(),
      expiresAt: null,
      entryPrice: 101.3,
      stopLossPrice: 100.3,
      tp1Price: 102.3,
      tp2Price: 103.3,
      tp3Price: 104.3,
      qualityScore: 75,
      metadata: {},
    };
    const response = { setup, score: SCORE_DTO, created: true };
    assert.equal(setupScoreResponseDtoSchema.safeParse(response).success, true);
    assert.equal(setupScoreResponseDtoSchema.safeParse({ ...response, created: 'yes' }).success, false);
    const history = { setupId: setup.id, scores: [SCORE_DTO] };
    assert.equal(setupScoreHistoryResponseDtoSchema.safeParse(history).success, true);
    assert.equal(setupScoreHistoryResponseDtoSchema.safeParse({ setupId: 'nope', scores: [] }).success, false);
  });
});
