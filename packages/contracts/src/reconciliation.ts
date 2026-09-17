import { z } from 'zod';
import { ASSET_CLASSES } from './assets.js';
import {
  EXECUTION_ARCHITECTURE_VERSION,
  ORDER_SIDES,
  ORDER_STATUSES,
  ORDER_TYPES,
} from './execution.js';

/**
 * M8.5 — Order & Position Reconciliation (contracts).
 *
 * Production-grade reconciliation layer comparing VeltrixEye's internal
 * execution state against an execution provider's actual order/position
 * state. Key safety properties:
 *
 *  - Provider-neutral; never coupled to MT5/Exness.
 *  - Fail-closed when the provider is unavailable.
 *  - Deterministic matching by stable identifiers; never guesses.
 *  - Classifies mismatches with stable machine-readable codes.
 *  - Preserves uncertain-outcome state — never auto-rejects after a timeout.
 *  - Destructive recovery is explicitly gated OFF in M8.5; mismatches produce
 *    findings requiring manual resolution, never blind cancel/resubmit/close.
 *  - Runs are idempotent and concurrency-safe via PostgreSQL advisory locks.
 *  - All endpoints enforce tenant ownership.
 *  - DisabledMT5Transport remains disabled; no broker network calls, no
 *    credentials, no live/demo profiles.
 */

/** Pinned reconciliation architecture version. */
export const RECONCILIATION_VERSION = 'm8.5-reconciliation-1';

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

export const RECONCILIATION_RUN_STATUSES = [
  'started',
  'provider_snapshot_acquired',
  'matching',
  'findings_created',
  'resolved',
  'no_action',
  'failed',
] as const;
export type ReconciliationRunStatus = (typeof RECONCILIATION_RUN_STATUSES)[number];

export const RECONCILIATION_RUN_TRIGGERS = ['manual', 'startup', 'scheduled', 'post_submit'] as const;
export type ReconciliationRunTrigger = (typeof RECONCILIATION_RUN_TRIGGERS)[number];

/* -------------------------------------------------------------------------- */
/* Mismatch codes — stable, machine-readable                                  */
/* -------------------------------------------------------------------------- */

export const RECONCILIATION_MISMATCH_CODES = [
  'internal_order_missing_at_provider',
  'provider_order_missing_internally',
  'internal_position_missing_at_provider',
  'provider_position_missing_internally',
  'status_mismatch',
  'partial_fill_quantity_mismatch',
  'filled_quantity_mismatch',
  'direction_mismatch',
  'symbol_mismatch',
  'entry_price_mismatch',
  'stop_loss_mismatch',
  'take_profit_mismatch',
  'unexpected_provider_state',
  'stale_state',
  'uncertain_outcome',
  'provider_unavailable',
  'ambiguous_match',
  'tenant_mismatch',
] as const;
export type ReconciliationMismatchCode = (typeof RECONCILIATION_MISMATCH_CODES)[number];

/**
 * Summary status surfaced by a reconciliation run — drives UI colour and
 * operator workflow.
 */
export const RECONCILIATION_HEALTH_STATES = [
  'synchronized',
  'mismatch_detected',
  'uncertain',
  'provider_unavailable',
  'manual_resolution_required',
] as const;
export type ReconciliationHealthState = (typeof RECONCILIATION_HEALTH_STATES)[number];

/* -------------------------------------------------------------------------- */
/* Finding resolution states                                                  */
/* -------------------------------------------------------------------------- */

export const RECONCILIATION_FINDING_STATES = [
  'open',
  'acknowledged',
  'resolved',
  'ignored',
] as const;
export type ReconciliationFindingState = (typeof RECONCILIATION_FINDING_STATES)[number];

/**
 * Resolution actions permitted in M8.5. NONE of these perform destructive
 * broker operations: they only update the local resolution bookkeeping.
 * Destructive auto-repair is explicitly gated off.
 */
export const RECONCILIATION_RESOLUTION_ACTIONS = [
  'acknowledge',
  'mark_resolved',
  'ignore',
] as const;
export type ReconciliationResolutionAction = (typeof RECONCILIATION_RESOLUTION_ACTIONS)[number];

/* -------------------------------------------------------------------------- */
/* Snapshot interfaces (provider-neutral)                                      */
/* -------------------------------------------------------------------------- */

const uuidSchema = z.string().uuid();
const isoDateTimeSchema = z.string();

export const reconciliationProviderOrderSchema = z
  .object({
    providerOrderId: z.string().min(1).max(128),
    clientOrderId: z.string().max(64).nullable().optional(),
    idempotencyKey: z.string().max(128).nullable().optional(),
    assetClass: z.enum(ASSET_CLASSES).optional(),
    symbol: z.string().min(1).max(64).optional(),
    side: z.enum(ORDER_SIDES).optional(),
    orderType: z.enum(ORDER_TYPES).optional(),
    quantity: z.number().positive().optional(),
    requestedPrice: z.number().positive().nullable().optional(),
    filledQuantity: z.number().min(0).optional(),
    averagePrice: z.number().positive().nullable().optional(),
    stopLossPrice: z.number().positive().nullable().optional(),
    takeProfitPrice: z.number().positive().nullable().optional(),
    status: z.enum(ORDER_STATUSES).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ReconciliationProviderOrder = z.infer<typeof reconciliationProviderOrderSchema>;

export const reconciliationProviderPositionSchema = z
  .object({
    providerPositionId: z.string().min(1).max(128),
    assetClass: z.enum(ASSET_CLASSES).optional(),
    symbol: z.string().min(1).max(64).optional(),
    direction: z.enum(['long', 'short']).optional(),
    quantity: z.number().positive().optional(),
    averageEntryPrice: z.number().positive().optional(),
    stopLossPrice: z.number().positive().nullable().optional(),
    takeProfitPrice: z.number().positive().nullable().optional(),
    unrealizedPl: z.number().nullable().optional(),
    openedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    raw: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ReconciliationProviderPosition = z.infer<typeof reconciliationProviderPositionSchema>;

export const reconciliationSnapshotSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    accountRef: z.string().max(128).nullable(),
    retrievedAt: isoDateTimeSchema,
    orders: z.array(reconciliationProviderOrderSchema),
    positions: z.array(reconciliationProviderPositionSchema),
    providerUnavailable: z.boolean().default(false),
    providerUnavailableReason: z.string().max(256).nullable().optional(),
  })
  .strict();
export type ReconciliationProviderSnapshot = z.infer<typeof reconciliationSnapshotSchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                       */
/* -------------------------------------------------------------------------- */

export const reconciliationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    executionProfileId: uuidSchema.optional(),
  })
  .strict();
export type ReconciliationListQuery = z.infer<typeof reconciliationListQuerySchema>;

export const reconciliationRunTriggerSchema = z
  .object({
    executionProfileId: uuidSchema,
    trigger: z.enum(RECONCILIATION_RUN_TRIGGERS).default('manual'),
  })
  .strict();
export type ReconciliationRunTriggerInput = z.infer<typeof reconciliationRunTriggerSchema>;

export const reconciliationFindingResolveSchema = z
  .object({
    action: z.enum(RECONCILIATION_RESOLUTION_ACTIONS),
    note: z.string().max(500).optional(),
  })
  .strict();
export type ReconciliationFindingResolveInput = z.infer<
  typeof reconciliationFindingResolveSchema
>;

export const reconciliationFindingDtoSchema = z
  .object({
    id: uuidSchema,
    runId: uuidSchema,
    code: z.enum(RECONCILIATION_MISMATCH_CODES),
    severity: z.enum(['info', 'warning', 'error', 'critical']),
    scope: z.enum(['order', 'position', 'provider', 'snapshot', 'run']),
    internalOrderId: uuidSchema.nullable(),
    internalPositionId: uuidSchema.nullable(),
    providerOrderId: z.string().max(128).nullable(),
    providerPositionId: z.string().max(128).nullable(),
    expectedField: z.string().max(64).nullable(),
    expectedValue: z.unknown(),
    actualValue: z.unknown(),
    detail: z.record(z.string(), z.unknown()).nullable(),
    resolutionState: z.enum(RECONCILIATION_FINDING_STATES),
    resolvedBy: uuidSchema.nullable(),
    resolvedAt: isoDateTimeSchema.nullable(),
    resolutionNote: z.string().max(500).nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type ReconciliationFindingDto = z.infer<typeof reconciliationFindingDtoSchema>;

export const reconciliationRunDtoSchema = z
  .object({
    id: uuidSchema,
    executionProfileId: uuidSchema,
    providerId: z.string().min(1).max(64),
    status: z.enum(RECONCILIATION_RUN_STATUSES),
    trigger: z.enum(RECONCILIATION_RUN_TRIGGERS),
    healthState: z.enum(RECONCILIATION_HEALTH_STATES),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema.nullable(),
    failureReason: z.string().max(500).nullable(),
    summary: z.object({
      expectedOrders: z.number().int().min(0),
      expectedPositions: z.number().int().min(0),
      providerOrders: z.number().int().min(0),
      providerPositions: z.number().int().min(0),
      matchedOrders: z.number().int().min(0),
      matchedPositions: z.number().int().min(0),
      findingsTotal: z.number().int().min(0),
      findingsOpen: z.number().int().min(0),
    }),
    architectureVersion: z.string(),
    reconciliationVersion: z.string(),
    providerUnavailable: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type ReconciliationRunDto = z.infer<typeof reconciliationRunDtoSchema>;

export const reconciliationStatusDtoSchema = z
  .object({
    lastRun: reconciliationRunDtoSchema.nullable(),
    healthState: z.enum(RECONCILIATION_HEALTH_STATES),
    openFindings: z.number().int().min(0),
    totalRuns: z.number().int().min(0),
    architectureVersion: z.string(),
    reconciliationVersion: z.string(),
    automationOff: z.literal(true),
    liveExecutionAvailable: z.literal(false),
  })
  .strict();
export type ReconciliationStatusDto = z.infer<typeof reconciliationStatusDtoSchema>;

export const reconciliationRunDetailDtoSchema = reconciliationRunDtoSchema.extend({
  findings: z.array(reconciliationFindingDtoSchema),
  expectedOrderRefs: z.array(z.string().max(128)),
  expectedPositionRefs: z.array(z.string().max(128)),
  providerOrderIds: z.array(z.string().max(128)),
  providerPositionIds: z.array(z.string().max(128)),
  matchedOrderPairs: z.array(z.object({
    internalOrderId: uuidSchema,
    providerOrderId: z.string().max(128),
  })),
  matchedPositionPairs: z.array(z.object({
    internalPositionId: uuidSchema,
    providerPositionId: z.string().max(128),
  })),
});
export type ReconciliationRunDetailDto = z.infer<typeof reconciliationRunDetailDtoSchema>;

export const reconciliationTriggerResponseSchema = z
  .object({
    run: reconciliationRunDtoSchema,
    findingsCreated: z.number().int().min(0),
    /** Destructive repair is gated off in M8.5 — always false. */
    correctiveActionsTaken: z.literal(false),
  })
  .strict();
export type ReconciliationTriggerResponse = z.infer<
  typeof reconciliationTriggerResponseSchema
>;

// Version re-export for convenience.
export { EXECUTION_ARCHITECTURE_VERSION };
