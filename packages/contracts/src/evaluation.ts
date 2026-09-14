import { z } from 'zod';
import { assetClassSchema, instrumentSymbolSchema } from './assets.js';
import { conditionClassificationSchema } from './conditions.js';
import type { StrategyVersionConfig } from './strategies.js';
import type { CandleDto } from './ingestion.js';

/**
 * Deterministic strategy evaluation (M3).
 *
 * The engine evaluates a PUBLISHED strategy version's immutable configuration
 * against candles that are ALREADY in the shared store. It never fetches from
 * a provider, never touches the database, never reads the wall clock, and
 * never persists anything — it is a pure function of
 * `(config, candles, asOfMs, instrument)` (see docs/strategy-engine-contract.md).
 *
 * Statuses (fail-closed by design):
 *  - satisfied        — the condition holds for this direction
 *  - unsatisfied      — the condition was evaluated and does not hold
 *  - insufficient_data — not enough closed candle history to evaluate; a
 *                       required/confirmation/disqualifying condition in this
 *                       state blocks the direction (never passes silently)
 *  - unsupported      — the platform has no data source / no handler for this
 *                       condition (e.g. news calendar, spread feed); blocks
 *                       the direction the same way
 *
 * M3/M4 boundary: M3 RETURNS evaluation results over a read-only API and
 * writes nothing. Setup persistence, lifecycle transitions, quality scoring,
 * scanners and alerts are later milestones.
 */

/** Pinned identifier stored alongside any future evaluation artifacts. */
export const DETERMINISTIC_ENGINE_VERSION = 'm3-deterministic-eval-1';

/** Hard cap on instruments evaluated in one request (scope "all" is capped). */
export const MAX_EVALUATION_INSTRUMENTS = 50;

export const EVALUATION_OUTCOME_STATUSES = [
  'satisfied',
  'unsatisfied',
  'insufficient_data',
  'unsupported',
] as const;
export type EvaluationOutcomeStatus = (typeof EVALUATION_OUTCOME_STATUSES)[number];

/** POST body for the evaluate endpoint. `asOf` pins the evaluation anchor. */
export const evaluationRequestSchema = z
  .object({
    /** Anchor in epoch-ms (UTC). Omitted ⇒ the API pins it to the current time. */
    asOf: z.number().int().positive().max(9_999_999_999_999).optional(),
  })
  .strict();
export type EvaluationRequest = z.infer<typeof evaluationRequestSchema>;
export type EvaluationRequestInput = z.input<typeof evaluationRequestSchema>;

export const conditionOutcomeSchema = z
  .object({
    conditionType: z.string().min(1),
    classification: conditionClassificationSchema,
    timeframeRole: z.enum(['htf_bias', 'setup', 'entry', 'any']),
    status: z.enum(EVALUATION_OUTCOME_STATUSES),
    /** Deterministic, human-readable explanation (numbers included). */
    detail: z.string().min(1),
  })
  .strict();
export type ConditionOutcome = z.infer<typeof conditionOutcomeSchema>;

export const groupOutcomeSchema = z
  .object({
    name: z.string().min(1),
    logic: z.enum(['AND', 'OR']),
    /** Group satisfaction per its logic over member statuses (empty ⇒ true). */
    satisfied: z.boolean(),
    /**
     * How the group affects pass/fail for a direction:
     *  - pass   — contains ≥1 required|confirmation ⇒ must be satisfied
     *  - veto   — only disqualifying members (a satisfied disqualifying
     *             condition vetoes at CONDITION level regardless of group logic)
     *  - ignore — optional-only ⇒ reported, never decides pass/fail
     */
    relevance: z.enum(['pass', 'veto', 'ignore']),
    conditions: z.array(conditionOutcomeSchema).max(100),
  })
  .strict();
export type GroupOutcome = z.infer<typeof groupOutcomeSchema>;

export const sessionFilterOutcomeSchema = z
  .object({
    session: z.enum(['asia', 'london', 'new_york', 'sydney']),
    mode: z.enum(['include', 'exclude']),
    timezone: z.enum(['utc', 'exchange']),
    status: z.enum(EVALUATION_OUTCOME_STATUSES),
    detail: z.string().min(1),
  })
  .strict();
export type SessionFilterOutcome = z.infer<typeof sessionFilterOutcomeSchema>;

/**
 * Deterministic candidate trade levels derived from the version's risk config
 * at the anchor (pure; never persisted in M3 — M4 persists setups).
 * `achievableRr` is the reward:risk the pinned target method offers.
 */
export const candidateLevelsSchema = z
  .object({
    entryPrice: z.number().positive().finite(),
    stopLossPrice: z.number().positive().finite(),
    /** |entry − stop| in price units (> 0). */
    riskDistance: z.number().positive().finite(),
    tp1Price: z.number().positive().finite().nullable(),
    tp2Price: z.number().positive().finite().nullable(),
    tp3Price: z.number().positive().finite().nullable(),
    achievableRr: z.number().positive().finite().nullable(),
    basis: z.string().min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!(c.riskDistance > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['riskDistance'], message: 'riskDistance must be positive' });
    }
  });
export type CandidateLevels = z.infer<typeof candidateLevelsSchema>;

export const directionEvaluationSchema = z
  .object({
    direction: z.enum(['long', 'short']),
    passed: z.boolean(),
    groups: z.array(groupOutcomeSchema).max(50),
    sessionFilters: z.array(sessionFilterOutcomeSchema).max(16),
    candidate: candidateLevelsSchema.nullable(),
    /** Why the direction failed (empty when passed) — deterministic strings. */
    failureReasons: z.array(z.string()).max(200),
  })
  .strict();
export type DirectionEvaluation = z.infer<typeof directionEvaluationSchema>;

export const instrumentEvaluationSchema = z
  .object({
    assetClass: assetClassSchema,
    symbol: instrumentSymbolSchema,
    directions: z
      .object({ long: directionEvaluationSchema, short: directionEvaluationSchema })
      .strict(),
    anyPassed: z.boolean(),
  })
  .strict();
export type InstrumentEvaluation = z.infer<typeof instrumentEvaluationSchema>;

export const evaluationResultSchema = z
  .object({
    strategyId: z.string().uuid(),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    engineVersion: z.string().min(1),
    /** The anchor the evaluation was pinned to (epoch-ms, UTC). */
    asOfMs: z.number().int().positive(),
    /** ISO-8601 rendering of asOfMs (deterministic; NOT the wall clock). */
    evaluatedAt: z.string().datetime(),
    instruments: z.array(instrumentEvaluationSchema).max(MAX_EVALUATION_INSTRUMENTS),
    /** True when scope "all" exceeded MAX_EVALUATION_INSTRUMENTS. */
    truncated: z.boolean(),
    notes: z.array(z.string()),
  })
  .strict();
export type EvaluationResultDto = z.infer<typeof evaluationResultSchema>;

/** Closed candles per timeframe role (the engine's only data input). */
export interface EvaluationCandleSet {
  htf_bias: CandleDto[];
  setup: CandleDto[];
  entry: CandleDto[];
}

export interface EvaluationEngineInput {
  /** Published (immutable) version configuration. Treated as read-only. */
  config: StrategyVersionConfig;
  instrument: { assetClass: string; symbol: string };
  candles: EvaluationCandleSet;
  asOfMs: number;
}

export interface EvaluationEngineResult {
  long: DirectionEvaluation;
  short: DirectionEvaluation;
  notes: string[];
}

/**
 * The deterministic engine's interface — pure, storage-free, provider-free,
 * wall-clock-free. Mirrors the QualityScoringEngine precedent: I/O-free with
 * respect to storage so it stays testable and swappable.
 */
export interface EvaluationEngine {
  readonly engineVersion: string;
  evaluate(input: EvaluationEngineInput): EvaluationEngineResult;
}
