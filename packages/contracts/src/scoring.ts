/**
 * Setup-quality scoring — contracts (foundation in M1, engine contracts in M5).
 *
 * M1 stored the shapes scores need (`setup_scores` = one immutable row per
 * scoring run, `components` = JSONB breakdown, `engineVersion` = the engine
 * that produced the row). M5 pins the scoring engine and its wire contracts:
 *  - `M5_SCORE_ENGINE_VERSION` identifies the pinned scoring formula — a
 *    changed formula MUST ship under a NEW version string, never silently
 *    reuse this one;
 *  - the engine is pure: identical (strategy version, setup, evaluation,
 *    instrument, timeframe, asOfMs) inputs always produce the identical
 *    score — no wall clock, no randomness, no I/O inside scoring logic;
 *  - `setup_scores.as_of_ms` (migration 0010) records the deterministic
 *    M3 evaluation anchor a score was computed from and, together with
 *    (setup_id, engine_version), forms the idempotency key;
 *  - the score is an objective measure of SETUP QUALITY (evidence strength
 *    and completeness). It is NOT a prediction and implies no probability
 *    of profit.
 */

import { z } from 'zod';
import { setupDtoSchema } from './detection.js';
import type { DirectionEvaluation } from './evaluation.js';

export const QUALITY_GRADE_BANDS = [
  { grade: 'A+' as const, min: 90 },
  { grade: 'A' as const, min: 85 },
  { grade: 'B' as const, min: 75 },
  { grade: 'C' as const, min: 65 },
  { grade: 'ignore' as const, min: 0 },
];

export type QualityGrade = 'A+' | 'A' | 'B' | 'C' | 'ignore';

/** Map a 0–100 score to its documented grade band. Pure function. */
export function qualityGrade(score: number): QualityGrade {
  const clamped = Math.max(0, Math.min(100, score));
  for (const band of QUALITY_GRADE_BANDS) {
    if (clamped >= band.min) return band.grade;
  }
  return 'ignore';
}

/**
 * Pinned M5 scoring-engine identifier, stored in `setup_scores.engine_version`.
 * The formula behind this version is documented in docs/setup-scoring.md and
 * frozen: any future formula change MUST introduce a new version string.
 */
export const M5_SCORE_ENGINE_VERSION = 'm5-quality-score-1';

/** Default/max page size for the score-history endpoint. */
export const DEFAULT_SCORE_HISTORY_LIMIT = 50;
export const MAX_SCORE_HISTORY_LIMIT = 100;

export interface ScoreComponent {
  /** Stable component identifier (e.g. "structure_quality"). */
  name: string;
  /** Human-readable name (e.g. "Structure quality"). */
  label: string;
  /** Relative weight of the component (weights need not sum to 1). */
  weight: number;
  /** Component score, 0–100. */
  score: number;
  /** Raw contribution to the total (points awarded, ≥ 0). */
  points: number;
  /** Maximum contribution to the total (points available). */
  maxPoints: number;
  /** Explanation of why this score was awarded. */
  explanation: string;
}

export const scoreComponentSchema = z
  .object({
    name: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    weight: z.number().min(0).max(100),
    score: z.number().min(0).max(100),
    points: z.number().min(0).max(100),
    maxPoints: z.number().min(0).max(100),
    explanation: z.string().min(1).max(1000),
  })
  .strict();

export interface SetupQualityScore {
  /** Total score, 0–100 (integer). */
  total: number;
  grade: QualityGrade;
  components: ScoreComponent[];
  /** Identifier of the scoring engine/version that produced this score. */
  engineVersion: string;
  /**
   * ISO-8601 rendering of the scoring anchor (asOfMs) — deterministic,
   * NEVER a wall-clock read inside scoring logic.
   */
  generatedAt: string; // ISO-8601
}

export const setupQualityScoreSchema = z
  .object({
    total: z.number().int().min(0).max(100),
    grade: z.enum(['A+', 'A', 'B', 'C', 'ignore']),
    components: z.array(scoreComponentSchema).min(1).max(50),
    engineVersion: z.string().min(1).max(120),
    generatedAt: z.string().datetime(),
  })
  .strict();

/**
 * The scoring engine implements this interface.
 * It is deliberately I/O-free with respect to storage: implementations
 * receive the setup context and RETURN the score; persistence is the
 * caller's responsibility (this keeps the engine testable and swappable).
 */
export interface QualityScoringEngine {
  readonly id: string;
  readonly version: string;
  score(input: ScoringInput): Promise<SetupQualityScore>;
}

export interface ScoringInput {
  /** Strategy version id that defines the strategy being evaluated. */
  strategyVersionId: string;
  /** Normalized instrument the setup is on. */
  instrument: { assetClass: string; symbol: string };
  /** Direction the setup proposes. */
  direction: 'long' | 'short';
  /** Structured context the engine may use (candles, zones, structure...). */
  context: Record<string, unknown>;
}

/**
 * The typed M5 scoring context carried inside `ScoringInput.context`:
 * the M3 direction evaluation being scored plus the version's minimum
 * risk:reward (used by the setup-completeness component).
 */
export interface M5ScoringContext {
  /** The M3 evaluation of the setup's direction at the scoring anchor. */
  evaluation: DirectionEvaluation;
  /** The version's configured minimum risk:reward (e.g. 2 means 1:2). */
  minRr: number;
  /** The deterministic scoring anchor (epoch-ms, UTC) the evaluation used. */
  asOfMs: number;
}

/** POST /api/setups/:setupId/score body. */
export const setupScoreRequestSchema = z
  .object({
    /**
     * Scoring anchor (epoch-ms, UTC). Omitted ⇒ the setup's own detection
     * anchor (`setups.as_of_ms`), i.e. the exact context the setup was
     * detected from. Explicit anchors allow re-scoring at other points in
     * time; each distinct (setup, engine version, anchor) is one scoring
     * context and produces at most one score row.
     */
    asOf: z.number().int().positive().max(9_999_999_999_999).optional(),
  })
  .strict();
export type SetupScoreRequest = z.infer<typeof setupScoreRequestSchema>;
export type SetupScoreRequestInput = z.input<typeof setupScoreRequestSchema>;

/** GET /api/setups/:setupId/scores query (values arrive as strings over HTTP). */
export const scoreHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_SCORE_HISTORY_LIMIT).default(DEFAULT_SCORE_HISTORY_LIMIT),
  })
  .strict();
export type ScoreHistoryQuery = z.infer<typeof scoreHistoryQuerySchema>;

/** One row of `setup_scores` (append-only scoring history). */
export const setupScoreDtoSchema = z
  .object({
    id: z.number().int().positive(),
    setupId: z.string().uuid(),
    /** The scoring engine version that produced this row (e.g. M5_SCORE_ENGINE_VERSION). */
    engineVersion: z.string().min(1).max(120),
    /** The deterministic M3 evaluation anchor this score was computed from. */
    asOfMs: z.number().int().positive(),
    total: z.number().int().min(0).max(100),
    grade: z.enum(['A+', 'A', 'B', 'C', 'ignore']),
    /** The explainable breakdown exactly as the engine produced it. */
    components: z.array(scoreComponentSchema).min(1).max(50),
    /** Row timestamp = the scoring anchor (M4 transition convention); NOT a scoring input separate from `asOfMs`. */
    createdAt: z.string().datetime(),
  })
  .strict();
export type SetupScoreDto = z.infer<typeof setupScoreDtoSchema>;

/** POST /api/setups/:setupId/score response. */
export const setupScoreResponseDtoSchema = z
  .object({
    /** The setup after scoring (qualityScore reflects the returned score). */
    setup: setupDtoSchema,
    score: setupScoreDtoSchema,
    /** False when the scoring context already had a score (idempotent replay). */
    created: z.boolean(),
  })
  .strict();
export type SetupScoreResponseDto = z.infer<typeof setupScoreResponseDtoSchema>;

/** GET /api/setups/:setupId/scores response (newest first). */
export const setupScoreHistoryResponseDtoSchema = z
  .object({
    setupId: z.string().uuid(),
    scores: z.array(setupScoreDtoSchema).max(MAX_SCORE_HISTORY_LIMIT),
  })
  .strict();
export type SetupScoreHistoryResponseDto = z.infer<typeof setupScoreHistoryResponseDtoSchema>;
