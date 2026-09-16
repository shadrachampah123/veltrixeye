import { z } from 'zod';
import { ASSET_CLASSES, instrumentSymbolSchema, type AssetClass } from './assets.js';
import { TIMEFRAMES } from './timeframes.js';

/**
 * M8.1 — Automated Trading Execution Architecture (contracts).
 *
 * M8.1 builds ONLY the execution architecture and safety boundary:
 * domain model, provider abstraction, idempotency, order state machine,
 * safety gates, kill-switch contract and audit events.
 *
 * Hard boundaries pinned by this milestone:
 *  - NO broker/MT5/Exness connectivity of any kind.
 *  - NO order ever leaves the platform: providers registered in M8.1 report
 *    themselves not ready, and every submit-family operation throws.
 *  - `live` execution is impossible by construction (schema + DB CHECK + no
 *    credentials anywhere).
 *  - Automation stays OFF for every plan (`canAccessAutomation` is false on
 *    all entitlement tiers and no code path flips it in M8.1).
 */

/** Pinned architecture version recorded on execution rows/events. */
export const EXECUTION_ARCHITECTURE_VERSION = 'm8.1-execution-arch-1';

/* -------------------------------------------------------------------------- */
/* Modes & environments                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Execution modes. `paper` = internal simulation, `demo` = broker demo
 * account, `live` = real funds. M8.1 permits modeling `paper` profiles ONLY.
 */
export const EXECUTION_MODES = ['paper', 'demo', 'live'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * The ONLY environment M8.1 may persist. Enforced in three places:
 * the service layer, the DTO schema below, and a database CHECK constraint.
 */
export const M8_1_ALLOWED_ENVIRONMENTS: readonly ExecutionMode[] = ['paper'];

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

export const ORDER_SIDES = ['buy', 'sell'] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

/** Not every provider supports every type — capabilities declare support. */
export const ORDER_TYPES = ['market', 'limit', 'stop', 'stop_limit'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = [
  'requested',
  'validating',
  'submitted',
  'accepted',
  'partially_filled',
  'filled',
  'rejected',
  'cancelled',
  'expired',
  'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses from which no further transition exists. */
export const ORDER_TERMINAL_STATUSES: readonly OrderStatus[] = [
  'filled',
  'rejected',
  'cancelled',
  'expired',
  'failed',
];

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return (ORDER_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/* -------------------------------------------------------------------------- */
/* Positions                                                                   */
/* -------------------------------------------------------------------------- */

export const POSITION_STATUSES = ['open', 'closed'] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Execution actions (the intent carried by an execution request)              */
/* -------------------------------------------------------------------------- */

export const EXECUTION_ACTIONS = ['open_long', 'open_short', 'close_position'] as const;
export type ExecutionAction = (typeof EXECUTION_ACTIONS)[number];

export const EXECUTION_REQUEST_STATUSES = ['requested', 'rejected'] as const;
export type ExecutionRequestStatus = (typeof EXECUTION_REQUEST_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Provider failure taxonomy                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Normalized execution-provider failure categories. Providers MUST map every
 * upstream failure onto one of these; raw provider payloads never propagate
 * through the application.
 */
export const EXECUTION_FAILURE_CATEGORIES = [
  'authentication',
  'validation',
  'insufficient_funds',
  'market_closed',
  'rate_limited',
  'timeout',
  'unavailable',
  'rejected',
  'unknown',
] as const;
export type ExecutionFailureCategory = (typeof EXECUTION_FAILURE_CATEGORIES)[number];

/**
 * The normalized error every execution provider throws. Mirrors the
 * market-data `ProviderError` pattern: kind + user-safe message, internals in
 * `cause` only.
 */
export class ExecutionProviderError extends Error {
  readonly category: ExecutionFailureCategory;

  constructor(category: ExecutionFailureCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExecutionProviderError';
    this.category = category;
  }
}

export function isExecutionProviderError(err: unknown): err is ExecutionProviderError {
  return err instanceof ExecutionProviderError;
}

/* -------------------------------------------------------------------------- */
/* Provider abstraction                                                        */
/* -------------------------------------------------------------------------- */

/** The id of the built-in (future) paper provider. No broker ids exist yet. */
export const PAPER_EXECUTION_PROVIDER_ID = 'paper';

export interface ExecutionProviderCapabilities {
  /** Environments this provider can serve. */
  modes: readonly ExecutionMode[];
  /** Order types this provider understands. */
  orderTypes: readonly OrderType[];
}

export interface ExecutionSubmitOrderRequest {
  /** Platform-generated stable order identity (never client-chosen). */
  clientOrderId: string;
  /** Stable execution identity (user+setup+profile+action derived). */
  idempotencyKey: string;
  assetClass: AssetClass;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  /** Null for market orders; required for limit/stop types. */
  requestedPrice: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}

export interface ExecutionSubmitOrderOutcome {
  providerOrderId: string;
  status: 'accepted' | 'rejected';
  filledQuantity?: number;
  averagePrice?: number | null;
  /** Provider receipt, already scrubbed of anything sensitive. */
  receipt?: Record<string, unknown>;
}

export interface ExecutionProviderOrderState {
  providerOrderId: string;
  status: OrderStatus;
  filledQuantity: number;
  averagePrice: number | null;
  raw?: Record<string, unknown>;
}

export interface ExecutionProviderPositionState {
  providerPositionId: string;
  assetClass: AssetClass;
  symbol: string;
  direction: 'long' | 'short';
  quantity: number;
  averageEntryPrice: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  unrealizedPl: number | null;
}

export interface ExecutionProviderHealth {
  healthy: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

/**
 * Provider-neutral execution boundary. Future adapters (paper simulator,
 * broker demo, MT5/Exness bridge) implement this WITHOUT touching strategy,
 * risk or entitlement logic — those run upstream and hand the provider a
 * fully validated decision.
 *
 * M8.1 ships exactly one implementation (paper) whose trading operations all
 * throw `ExecutionProviderError('unavailable', …)` — the simulator is M8.3.
 */
export interface ExecutionProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ExecutionProviderCapabilities;
  /** False ⇔ the adapter refuses all trading operations honestly. */
  readonly configured: boolean;

  /** Operator-safe view: NEVER includes credentials or secrets. */
  describe(): Record<string, unknown>;
  health(): Promise<ExecutionProviderHealth>;

  submitOrder(request: ExecutionSubmitOrderRequest): Promise<ExecutionSubmitOrderOutcome>;
  cancelOrder(providerOrderId: string): Promise<void>;
  modifyOrder(
    providerOrderId: string,
    changes: { stopLossPrice?: number | null; takeProfitPrice?: number | null },
  ): Promise<void>;
  getOrder(providerOrderId: string): Promise<ExecutionProviderOrderState | null>;
  listOrders(): Promise<ExecutionProviderOrderState[]>;
  listPositions(): Promise<ExecutionProviderPositionState[]>;
  closePosition(providerPositionId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Kill switch                                                                 */
/* -------------------------------------------------------------------------- */

export const KILL_SWITCH_SCOPES = ['global', 'user', 'strategy', 'execution_profile'] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

/* -------------------------------------------------------------------------- */
/* Safety gates                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The complete ordered gate list. Execution may proceed ONLY when every gate
 * passes; evaluation stops at the first failure (fail-closed). Gates 1–2 are
 * enforced by the API/session layer; the remaining gates by the execution
 * gate service. The list is pinned so audits and UI can enumerate it.
 */
export const EXECUTION_GATE_IDS = [
  'authenticated',
  'authorized',
  'entitlement',
  'automation_on',
  'profile_enabled',
  'kill_switch',
  'valid_signal',
  'risk_decision',
  'valid_symbol',
  'valid_order_params',
  'valid_stop_loss',
  'valid_take_profit',
  'acceptable_rr',
  'exposure_limits',
  'provider_healthy',
] as const;
export type ExecutionGateId = (typeof EXECUTION_GATE_IDS)[number];

/* -------------------------------------------------------------------------- */
/* Execution decision contract                                                 */
/* -------------------------------------------------------------------------- */

const priceSchema = z.number().positive().finite();
const epochMsSchema = z.number().int().positive().max(9_999_999_999_999);

/**
 * The central execution decision contract. An execution attempt is ONLY ever
 * built from this server-validated shape — the execution layer never invents
 * a trade. Provenance fields (strategy/version/setup ids, asOf anchor,
 * quality score) let every future order be traced back to the exact signal.
 */
export const executionDecisionSchema = z
  .object({
    strategyId: z.string().uuid(),
    strategyVersionId: z.string().uuid(),
    setupId: z.string().uuid(),
    action: z.enum(EXECUTION_ACTIONS),
    assetClass: z.enum(ASSET_CLASSES),
    symbol: instrumentSymbolSchema,
    /** Setup timeframe context (canonical). */
    timeframe: z.enum(TIMEFRAMES),
    direction: z.enum(['long', 'short']),
    entryPrice: priceSchema,
    stopLossPrice: priceSchema,
    takeProfitPrice: priceSchema,
    /** RR the upstream pipeline expects this setup to carry (≥ 1). */
    expectedRr: z.number().positive().max(100),
    qualityScore: z.number().int().min(0).max(100),
    /** The version's configured minQualityScore the signal already cleared. */
    minQualityScore: z.number().int().min(0).max(100),
    /** Detection anchor of the setup — part of the stable identity. */
    asOfMs: epochMsSchema,
  })
  .strict()
  .superRefine((d, ctx) => {
    // Directional sanity: SL must protect, TP must reward, per direction.
    if (d.direction === 'long') {
      if (!(d.stopLossPrice < d.entryPrice)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stopLossPrice'],
          message: 'long setups require stopLossPrice < entryPrice',
        });
      }
      if (!(d.takeProfitPrice > d.entryPrice)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['takeProfitPrice'],
          message: 'long setups require takeProfitPrice > entryPrice',
        });
      }
    } else {
      if (!(d.stopLossPrice > d.entryPrice)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stopLossPrice'],
          message: 'short setups require stopLossPrice > entryPrice',
        });
      }
      if (!(d.takeProfitPrice < d.entryPrice)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['takeProfitPrice'],
          message: 'short setups require takeProfitPrice < entryPrice',
        });
      }
    }
    // Action/direction coherence.
    const expectedDirection = d.action === 'open_short' ? 'short' : 'long';
    if (d.action !== 'close_position' && d.direction !== expectedDirection) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action'],
        message: `action "${d.action}" conflicts with direction "${d.direction}"`,
      });
    }
    // The claimed RR must be achievable from the actual levels (tolerance for
    // floating-point rounding upstream).
    const risk = Math.abs(d.entryPrice - d.stopLossPrice);
    const reward = Math.abs(d.takeProfitPrice - d.entryPrice);
    if (risk > 0 && reward / risk + 1e-9 < d.expectedRr) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedRr'],
        message: 'expectedRr exceeds the RR implied by the entry/SL/TP levels',
      });
    }
  });
export type ExecutionDecisionInput = z.infer<typeof executionDecisionSchema>;

/* -------------------------------------------------------------------------- */
/* DTO schemas                                                                 */
/* -------------------------------------------------------------------------- */

const uuidSchema = z.string().uuid();
const isoDateTimeSchema = z.string();

export const executionProfileDtoSchema = z
  .object({
    id: uuidSchema,
    mode: z.enum(EXECUTION_MODES),
    environment: z.enum(EXECUTION_MODES),
    providerSlug: z.string().min(1).max(64),
    /** Platform-side reference only. NEVER a credential. */
    accountRef: z.string().max(128).nullable(),
    enabled: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type ExecutionProfileDto = z.infer<typeof executionProfileDtoSchema>;

/** M8.1 only ever accepts paper profile creation. */
export const executionProfileCreateSchema = z
  .object({
    mode: z.enum(EXECUTION_MODES),
    providerSlug: z.string().trim().min(1).max(64),
    accountRef: z.string().trim().max(128).optional(),
  })
  .strict();
export type ExecutionProfileCreateInput = z.infer<typeof executionProfileCreateSchema>;

export const executionOrderDtoSchema = z
  .object({
    id: uuidSchema,
    executionProfileId: uuidSchema,
    executionRequestId: uuidSchema.nullable(),
    clientOrderId: z.string().min(1).max(64),
    providerSlug: z.string().min(1).max(64),
    providerOrderId: z.string().max(128).nullable(),
    assetClass: z.enum(ASSET_CLASSES),
    symbol: z.string(),
    side: z.enum(ORDER_SIDES),
    orderType: z.enum(ORDER_TYPES),
    quantity: z.number(),
    requestedPrice: z.number().nullable(),
    stopLossPrice: z.number().nullable(),
    takeProfitPrice: z.number().nullable(),
    status: z.enum(ORDER_STATUSES),
    rejectReason: z.string().nullable(),
    idempotencyKey: z.string(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    submittedAt: isoDateTimeSchema.nullable(),
    filledAt: isoDateTimeSchema.nullable(),
  })
  .strict();
export type ExecutionOrderDto = z.infer<typeof executionOrderDtoSchema>;

export const executionPositionDtoSchema = z
  .object({
    id: uuidSchema,
    executionProfileId: uuidSchema,
    providerSlug: z.string().min(1).max(64),
    providerPositionId: z.string().max(128).nullable(),
    assetClass: z.enum(ASSET_CLASSES),
    symbol: z.string(),
    direction: z.enum(['long', 'short']),
    quantity: z.number(),
    averageEntryPrice: z.number(),
    stopLossPrice: z.number().nullable(),
    takeProfitPrice: z.number().nullable(),
    realizedPl: z.number().nullable(),
    unrealizedPl: z.number().nullable(),
    status: z.enum(POSITION_STATUSES),
    openedAt: isoDateTimeSchema,
    closedAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type ExecutionPositionDto = z.infer<typeof executionPositionDtoSchema>;

export const executionRequestDtoSchema = z
  .object({
    id: uuidSchema,
    executionProfileId: uuidSchema,
    setupId: uuidSchema,
    action: z.enum(EXECUTION_ACTIONS),
    status: z.enum(EXECUTION_REQUEST_STATUSES),
    rejectionGate: z.enum(EXECUTION_GATE_IDS).nullable(),
    rejectionReason: z.string().nullable(),
    /** Server-validated decision snapshot (provenance). */
    decision: executionDecisionSchema,
    architectureVersion: z.string(),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type ExecutionRequestDto = z.infer<typeof executionRequestDtoSchema>;

export const executionAuditEventDtoSchema = z
  .object({
    id: z.string(),
    entityType: z.enum(['order', 'position', 'request', 'profile', 'automation']),
    orderId: uuidSchema.nullable(),
    positionId: uuidSchema.nullable(),
    executionProfileId: uuidSchema.nullable(),
    setupId: uuidSchema.nullable(),
    event: z.string().min(1).max(64),
    fromStatus: z.string().max(32).nullable(),
    toStatus: z.string().max(32).nullable(),
    reason: z.string().nullable(),
    metadata: z.record(z.unknown()),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type ExecutionAuditEventDto = z.infer<typeof executionAuditEventDtoSchema>;

export const automationStatusDtoSchema = z
  .object({
    /** Server-authoritative: the subscription entitlement allows automation. */
    entitled: z.boolean(),
    /** The user's explicit switch (default false; only settable if entitled). */
    automationEnabled: z.boolean(),
    globalKillSwitch: z.boolean(),
    userKillSwitch: z.boolean(),
    /** entitled && automationEnabled && no kill switch — the only ON that counts. */
    effective: z.boolean(),
    /** Why `effective` is false (stable machine-readable tokens). */
    reasons: z.array(z.string()),
  })
  .strict();
export type AutomationStatusDto = z.infer<typeof automationStatusDtoSchema>;

export const executionStatusDtoSchema = z
  .object({
    automation: automationStatusDtoSchema,
    architectureVersion: z.string(),
    providers: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          configured: z.boolean(),
          healthy: z.boolean(),
          reason: z.string().nullable(),
        })
        .strict(),
    ),
    profiles: z.number().int().min(0),
  })
  .strict();
export type ExecutionStatusDto = z.infer<typeof executionStatusDtoSchema>;

export const executionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ExecutionListQuery = z.infer<typeof executionListQuerySchema>;

export const automationToggleSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type AutomationToggleInput = z.infer<typeof automationToggleSchema>;

/**
 * Stable execution identity (idempotency). Derived, NEVER random per attempt:
 * the same user + setup + profile + intent always hashes to the same key, so
 * retries collapse instead of duplicating. The `asOfMs` anchor is part of the
 * setup's own unique detection identity and therefore needs no extra term.
 */
export function executionIdempotencyKey(args: {
  userId: string;
  setupId: string;
  executionProfileId: string;
  action: ExecutionAction;
}): string {
  return ['exec', args.userId, args.setupId, args.executionProfileId, args.action].join(':');
}
