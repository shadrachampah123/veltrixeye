import { z } from 'zod';
import { assetClassSchema, instrumentSymbolSchema } from './assets.js';

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
    strategyId: z.string().uuid().optional(),
    versionId: z.string().uuid().optional(),
    state: setupStateSchema.optional(),
    direction: setupDirectionSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_SETUPS_LIMIT).default(DEFAULT_SETUPS_LIMIT),
  })
  .strict();
export type SetupListQuery = z.infer<typeof setupListQuerySchema>;

/** One row of `setups`, joined with its strategy/version/instrument identity. */
export const setupDtoSchema = z
  .object({
    id: z.string().uuid(),
    strategyId: z.string().uuid(),
    strategyVersionId: z.string().uuid(),
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
    setupId: z.string().uuid(),
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
    strategyId: z.string().uuid(),
    versionId: z.string().uuid(),
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
