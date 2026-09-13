/**
 * Setup-quality scoring — types and grade bands only (M1).
 *
 * The actual scoring engine arrives in a later milestone. These contracts
 * define its shape so scores can be stored and explained without any
 * database redesign:
 *  - `setup_scores` stores one immutable row per scoring run,
 *  - `components` is a JSONB breakdown (name, weight, score, explanation),
 *  - `engineVersion` ties a stored score to the engine that produced it.
 */

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

export interface ScoreComponent {
  /** Stable component identifier (e.g. "structure_quality"). */
  name: string;
  /** Human-readable name (e.g. "Structure quality"). */
  label: string;
  /** Relative weight of the component (weights need not sum to 1). */
  weight: number;
  /** Component score, 0–100. */
  score: number;
  /** Explanation of why this score was awarded. */
  explanation: string;
}

export interface SetupQualityScore {
  /** Total score, 0–100 (integer). */
  total: number;
  grade: QualityGrade;
  components: ScoreComponent[];
  /** Identifier of the scoring engine/version that produced this score. */
  engineVersion: string;
  generatedAt: string; // ISO-8601
}

/**
 * The future scoring engine implements this interface.
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
