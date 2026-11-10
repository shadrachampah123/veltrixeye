import { z } from 'zod';
import { assetClassSchema, instrumentSymbolSchema } from './assets.js';
import { CONDITION_TYPE_REGISTRY, type ConditionType } from './conditions.js';
import { EVALUATION_OUTCOME_STATUSES } from './evaluation.js';

/**
 * Setup detection contracts (M4).
 *
 * M4 consumes the M3 evaluation result and persists detected setups plus
 * their lifecycle transitions. It never evaluates conditions itself (M3
 * owns that), never scores (M5 owns that), and never touches a provider.
 *
 * Lifecycle states are EXACTLY the eight states the 0006 schema CHECK
 * constraint defines — M4 invents no states. Detection enters the machine
 * at `confirmed`: M4 has no progressive scanner, so a qualifying evaluation
 * (every required/confirmation condition satisfied, no veto) is by
 * definition a confirmed setup, not a developing one.
 */

/** The eight lifecycle states from the `setups.state` CHECK constraint. */
export const SETUP_STATES = [
  'developing',
  'watching',
  'almost_ready',
  'confirmed',
  'triggered',
  'invalidated',
  'expired',
  'completed',
] as const;
export type SetupState = (typeof SETUP_STATES)[number];

/** Terminal states: no outbound transition exists; repeats are no-ops. */
export const SETUP_TERMINAL_STATES = ['completed', 'invalidated', 'expired'] as const;
export type SetupTerminalState = (typeof SETUP_TERMINAL_STATES)[number];

/**
 * The explicit M4 state machine: allowed outbound transition per state.
 * Forward chain plus invalidation/expiry exits from every non-terminal
 * state. Anything not listed here is rejected without any write.
 */
export const SETUP_TRANSITIONS: Record<SetupState, readonly SetupState[]> = {
  developing: ['watching', 'invalidated', 'expired'],
  watching: ['almost_ready', 'invalidated', 'expired'],
  almost_ready: ['confirmed', 'invalidated', 'expired'],
  confirmed: ['triggered', 'invalidated', 'expired'],
  triggered: ['completed', 'invalidated', 'expired'],
  completed: [],
  invalidated: [],
  expired: [],
};

/** State every M4-detected setup is created in. */
export const SETUP_INITIAL_STATE = 'confirmed' as const satisfies SetupState;

/**
 * Pinned detector identifier, stored in `setups.metadata.detectorVersion`
 * and every detection state-event payload — the M4 analogue of M3's
 * `DETERMINISTIC_ENGINE_VERSION`. Never change once released.
 */
export const DETECTOR_VERSION = 'm4-setup-detect-1';

/** Default/max page size for the setup list endpoint. */
export const DEFAULT_SETUPS_LIMIT = 50;
export const MAX_SETUPS_LIMIT = 100;

export const setupStateSchema = z.enum(SETUP_STATES);
export const setupDirectionSchema = z.enum(['long', 'short']);
export type SetupDirection = z.infer<typeof setupDirectionSchema>;

/** Instrument selector for detection (normalized, provider-independent). */
export const detectionInstrumentSchema = z
  .object({
    assetClass: assetClassSchema,
    symbol: instrumentSymbolSchema,
  })
  .strict();
export type DetectionInstrument = z.infer<typeof detectionInstrumentSchema>;

/**
 * POST …/versions/:versionId/detect body. `asOf` is REQUIRED: M4 performs
 * no wall-clock read anywhere in the detection path, so the caller must
 * supply the explicit evaluation anchor. Omit `direction` to detect both
 * directions (reported long-first, deterministically).
 */
export const detectionRequestSchema = z
  .object({
    instrument: detectionInstrumentSchema,
    direction: setupDirectionSchema.optional(),
    asOf: z.number().int().positive().max(9_999_999_999_999),
  })
  .strict();
export type DetectionRequest = z.infer<typeof detectionRequestSchema>;
export type DetectionRequestInput = z.input<typeof detectionRequestSchema>;

/**
 * POST /api/setups/:setupId/transitions body. `asOf` is REQUIRED: the
 * transition event's timestamp is the supplied anchor, never the clock.
 */
export const setupTransitionRequestSchema = z
  .object({
    toState: setupStateSchema,
    reason: z.string().trim().min(1).max(280).optional(),
    asOf: z.number().int().positive().max(9_999_999_999_999),
  })
  .strict();
export type SetupTransitionRequest = z.infer<typeof setupTransitionRequestSchema>;

/** GET /api/setups query (all values arrive as strings over HTTP). */
export const setupListQuerySchema = z
  .object({
    strategyId: z.string().guid().optional(),
    versionId: z.string().guid().optional(),
    state: setupStateSchema.optional(),
    direction: setupDirectionSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_SETUPS_LIMIT).default(DEFAULT_SETUPS_LIMIT),
  })
  .strict();
export type SetupListQuery = z.infer<typeof setupListQuerySchema>;

/** One row of `setups`, joined with its strategy/version/instrument identity. */
export const setupDtoSchema = z
  .object({
    id: z.string().guid(),
    strategyId: z.string().guid(),
    strategyVersionId: z.string().guid(),
    versionNumber: z.number().int().positive(),
    instrument: detectionInstrumentSchema,
    state: setupStateSchema,
    direction: setupDirectionSchema,
    /** The M3 anchor this setup was detected from (epoch-ms, UTC). */
    asOfMs: z.number().int().positive(),
    detectedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    entryPrice: z.number().positive().finite().nullable(),
    stopLossPrice: z.number().positive().finite().nullable(),
    tp1Price: z.number().positive().finite().nullable(),
    tp2Price: z.number().positive().finite().nullable(),
    tp3Price: z.number().positive().finite().nullable(),
    /** Latest M5 quality score total; null until the setup has been scored. */
    qualityScore: z.number().int().min(0).max(100).nullable(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SetupDto = z.infer<typeof setupDtoSchema>;

/** One row of `setup_state_events` (append-only transition log). */
export const setupStateEventDtoSchema = z
  .object({
    id: z.number().int().positive(),
    setupId: z.string().guid(),
    fromState: setupStateSchema.nullable(),
    toState: setupStateSchema,
    reason: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();
export type SetupStateEventDto = z.infer<typeof setupStateEventDtoSchema>;

/** Setup plus its full lifecycle history (oldest first). */
export const setupDetailDtoSchema = z
  .object({
    setup: setupDtoSchema,
    events: z.array(setupStateEventDtoSchema).max(64),
  })
  .strict();
export type SetupDetailDto = z.infer<typeof setupDetailDtoSchema>;

/**
 * Aggregated M3 condition outcomes for one evaluated direction.
 *
 * Observability only: it never changes a qualification decision. The four
 * counters always sum to the number of conditions the engine actually walked,
 * so a strategy that "evaluates but never qualifies" is distinguishable from
 * one that cannot be evaluated at all (`insufficient_data`/`unsupported`).
 */
export const conditionSummarySchema = z
  .object({
    satisfied: z.number().int().min(0),
    unsatisfied: z.number().int().min(0),
    insufficient_data: z.number().int().min(0),
    unsupported: z.number().int().min(0),
  })
  .strict();
export type ConditionSummary = z.infer<typeof conditionSummarySchema>;

/**
 * Bounded list of the conditions a direction did NOT satisfy.
 *
 * This is the missing link between "the counts say three conditions were
 * unsatisfied" and "the liquidity sweep is the one that blocked it": the counts
 * in `conditionSummary` aggregate away *which* condition failed, and
 * `failureReasons` only carries rule-group-level sentences. The scanner stores
 * these as `metadata.pairs.items[].diagnostics.directions[<dir>].failing`.
 *
 * Bounded by construction — the engine walks the version's rule groups in
 * config order, so the first `DETECTION_CONDITION_OUTCOMES_MAX` entries are
 * deterministic. Never includes `satisfied` conditions (they explain nothing
 * about a failure) and never includes free text: the type comes from
 * `CONDITION_TYPE_REGISTRY`, which the config write path validates against.
 */
export const DETECTION_CONDITION_OUTCOMES_MAX = 4;

export const detectionConditionOutcomeSchema = z
  .object({
    /** A registered condition type (`liquidity_sweep`, `news_filter`, …). */
    conditionType: z.string().min(1).max(64),
    /** Why it failed: `unsatisfied`, `insufficient_data` or `unsupported`. */
    status: z.enum(EVALUATION_OUTCOME_STATUSES),
  })
  .strict();
export type DetectionConditionOutcome = z.infer<typeof detectionConditionOutcomeSchema>;

/**
 * Condition types the engine can report — derived from the single registry, so a
 * new condition type becomes valid evidence automatically and nothing else drifts.
 */
export const DETECTION_CONDITION_TYPES = Object.keys(CONDITION_TYPE_REGISTRY) as ConditionType[];

/**
 * Statuses that a *failing* condition entry may carry.
 *
 * `satisfied` is deliberately excluded: an entry stored in `failing` says the
 * condition did **not** pass, so `liquidity_sweep:satisfied` is a contradiction
 * rather than evidence.
 */
export const CONDITION_FAILURE_STATUSES = ['unsatisfied', 'insufficient_data', 'unsupported'] as const;
export type ConditionFailureStatus = (typeof CONDITION_FAILURE_STATUSES)[number];

/** Longest `<conditionType>:<status>` this model can produce. */
export const CONDITION_FAILING_CODE_MAX_CHARS = 64;

function isConditionType(value: unknown): value is ConditionType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONDITION_TYPE_REGISTRY, value);
}

function isConditionFailureStatus(value: unknown): value is ConditionFailureStatus {
  return typeof value === 'string' && (CONDITION_FAILURE_STATUSES as readonly string[]).includes(value);
}

/**
 * The stored form of one failing condition: `<conditionType>:<status>`, or
 * `null` when either half is not part of its enum.
 *
 * Shared by the scanner (which writes the codes) and the contract (which
 * validates them), so a stored code can only ever name a real condition type
 * and a real failure status.
 */
export function conditionFailingCode(conditionType: unknown, status: unknown): string | null {
  if (!isConditionType(conditionType) || !isConditionFailureStatus(status)) return null;
  return `${conditionType}:${status}`;
}

/** Parse a stored failing code back into its parts, or `null` if it is not one. */
export function parseConditionFailingCode(
  value: unknown,
): { conditionType: ConditionType; status: ConditionFailureStatus } | null {
  if (typeof value !== 'string' || value.length > CONDITION_FAILING_CODE_MAX_CHARS) return null;
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const conditionType = value.slice(0, separator);
  const status = value.slice(separator + 1);
  if (!isConditionType(conditionType) || !isConditionFailureStatus(status)) return null;
  return { conditionType, status };
}

/**
 * A single failing-condition code. Stricter than "machine-like token": both
 * halves must come from their enums, so an arbitrary `foo:bar` is refused
 * instead of being presented as condition evidence.
 */
export const conditionFailingCodeSchema = z
  .string()
  .min(1)
  .max(CONDITION_FAILING_CODE_MAX_CHARS)
  .refine((value) => parseConditionFailingCode(value) !== null, {
    message: 'failing condition codes must be <conditionType>:<status> from the condition registry',
  });

/** Per-direction detection outcome. */
export const detectionItemDtoSchema = z
  .object({
    direction: setupDirectionSchema,
    /** Whether the M3 direction passed (the sole qualification rule). */
    qualified: z.boolean(),
    /** The setup: newly created, pre-existing, or null when not qualifying. */
    setup: setupDtoSchema.nullable(),
    /** True only when this call created the setup row. */
    created: z.boolean(),
    /** M3 failure reasons (empty when qualified) — deterministic strings. */
    failureReasons: z.array(z.string()).max(200),
    /**
     * Per-condition status counts for this direction.
     *
     * Populated only when the caller asks for diagnostics
     * (`SetupsService.detect({ includeDiagnostics: true })`, used by the live
     * scanner). The M4 HTTP endpoint does not request it, so its response shape
     * is unchanged. Optional because historical/other callers omit it.
     */
    conditionSummary: conditionSummarySchema.optional(),
    /**
     * Which conditions blocked this direction, bounded and in config order.
     *
     * Like `conditionSummary`, populated only when the caller asks for
     * diagnostics, so the M4 HTTP response shape is unchanged. Optional because
     * historical callers and stubbed detectors omit it; the scanner treats a
     * missing value as "no per-condition detail" rather than as a failure.
     */
    conditionOutcomes: z.array(detectionConditionOutcomeSchema).max(DETECTION_CONDITION_OUTCOMES_MAX).optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (!item.qualified && (item.setup !== null || item.created)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['setup'],
        message: 'a non-qualifying detection must not return or create a setup',
      });
    }
    if (item.qualified && item.setup === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['setup'],
        message: 'a qualifying detection must return a setup',
      });
    }
  });
export type DetectionItemDto = z.infer<typeof detectionItemDtoSchema>;

/** POST …/detect response. */
export const detectionResponseDtoSchema = z
  .object({
    strategyId: z.string().guid(),
    versionId: z.string().guid(),
    versionNumber: z.number().int().positive(),
    instrument: detectionInstrumentSchema,
    asOfMs: z.number().int().positive(),
    detectorVersion: z.string().min(1),
    engineVersion: z.string().min(1),
    detections: z.array(detectionItemDtoSchema).min(1).max(2),
  })
  .strict();
export type DetectionResponseDto = z.infer<typeof detectionResponseDtoSchema>;

/** POST /api/setups/:setupId/transitions response. */
export const setupTransitionResponseDtoSchema = z
  .object({
    setup: setupDtoSchema,
    /** False when the setup was already in `toState` (idempotent no-op). */
    transitioned: z.boolean(),
    /** The recorded event, or null when this call was a no-op repeat. */
    event: setupStateEventDtoSchema.nullable(),
  })
  .strict();
export type SetupTransitionResponseDto = z.infer<typeof setupTransitionResponseDtoSchema>;
