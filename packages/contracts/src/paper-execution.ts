import { z } from 'zod';
import { ASSET_CLASSES } from './assets.js';
import {
  executionOrderDtoSchema,
  executionPositionDtoSchema,
} from './execution.js';
import { RISK_ENGINE_VERSION } from './risk-engine.js';

/**
 * M8.3 — Paper/Demo Execution Simulator (contracts).
 *
 * M8.3 makes the M8.1 execution architecture *simulate* execution internally.
 * It is a deterministic, in-process paper simulator and nothing else:
 *
 *  - NO broker, MT5, Exness or external trading API exists (or is reachable)
 *    anywhere in this milestone;
 *  - NO live/demo order can leave the platform — the only registered provider
 *    is the internal paper simulator, and `execution_profiles` still cannot
 *    hold `demo`/`live` (M8.1 CHECK) or any credential;
 *  - the M8.2 risk engine remains MANDATORY: a paper order is only ever built
 *    from a server-issued, approved `risk_decisions` row, and a client cannot
 *    supply approval, position size, price, P&L or execution state;
 *  - `automation_enabled` stays OFF and `canAccessAutomation` stays false for
 *    every plan, so the M8.1 *automated* path still cannot produce an order.
 *
 * Paper simulation is therefore explicitly a **user-initiated simulation**,
 * never automation: it is not scheduled, not triggered by the scanner, and
 * every row it writes is marked `simulated = true` with the simulator version.
 */

/** Pinned simulator version recorded on paper orders/positions/fills. */
export const PAPER_SIMULATOR_VERSION = 'm8.3-paper-sim-1';

/**
 * A cited (client-selected) risk decision must be fresh: an approval is a
 * statement about current exposure, so a stale one cannot authorize a paper
 * order. A fresh decision is always produced server-side at simulation time;
 * this TTL bounds how long an *explicitly cited* one stays usable.
 */
export const PAPER_RISK_DECISION_MAX_AGE_MS = 5 * 60_000;

/** Conservative bound on candles walked per SL/TP evaluation. */
export const PAPER_MAX_EVALUATION_CANDLES = 500;

/** Fills the paper simulator can produce. */
export const PAPER_FILL_TYPES = ['entry', 'stop_loss', 'take_profit', 'close'] as const;
export type PaperFillType = (typeof PAPER_FILL_TYPES)[number];

/** Terminal reasons a paper position can carry. */
export const PAPER_EXIT_REASONS = ['stop_loss', 'take_profit', 'close'] as const;
export type PaperExitReason = (typeof PAPER_EXIT_REASONS)[number];

/** Reconciliation scopes and outcomes (M8.5 foundation). */
export const RECONCILIATION_SCOPES = ['order', 'position'] as const;
export type ReconciliationScope = (typeof RECONCILIATION_SCOPES)[number];

export const RECONCILIATION_OUTCOMES = ['ok', 'mismatch'] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];

/**
 * The best-effort recovery states the simulator refuses to paper over. Every
 * one of these FAILS CLOSED: the simulator records the finding and refuses to
 * touch financial state rather than silently "fixing" it.
 */
export const PAPER_RECONCILIATION_FINDINGS = [
  'order_fill_quantity_mismatch',
  'order_filled_but_no_fill_row',
  'order_fill_exceeds_quantity',
  'order_filled_without_price',
  'order_terminal_without_reason',
  'fill_ledger_sum_mismatch',
  'position_missing',
  'position_quantity_not_positive',
  'position_entry_price_invalid',
  'position_open_with_exit_data',
  'position_open_without_order',
  'position_metadata_missing',
  'position_closed_without_exit_price',
  'position_closed_without_realized_pl',
  'position_direction_conflicts_with_order',
  'position_symbol_conflicts_with_order',
  'position_realized_pl_mismatch',
  'position_duplicate_exit_fills',
  'position_order_tenant_mismatch',
] as const;
export type PaperReconciliationFinding = (typeof PAPER_RECONCILIATION_FINDINGS)[number];

/**
 * M8.3 pinned paper-simulation gate list (fail-closed, evaluated in order,
 * evaluation stops at the first failure).
 *
 * It is deliberately a SEPARATE list from M8.1's `EXECUTION_GATE_IDS`:
 *  - the M8.1 gates govern the *automated* path (intake → order) and are
 *    untouched — automation OFF still refuses that path outright;
 *  - this list governs the *user-initiated simulation* path, whose scope is
 *    "simulate what the server-issued decision would have done", never
 *    "place an automated order".
 *
 * Every gate that protects money and provenance is enforced identically:
 * kill switch, provenance, server-issued risk decision, position size,
 * SL/TP, RR, exposure and market-data freshness.
 */
export const PAPER_SIMULATION_GATE_IDS = [
  'authenticated',
  'authorized',
  'paper_profile',
  'kill_switch',
  'provider_ready',
  'valid_signal',
  'risk_decision_issued',
  'risk_approved',
  'valid_position_size',
  'valid_symbol',
  // Market data precedes the price-based gates: SL/TP, RR and order
  // parameters are meaningless without a fresh, positive server price, so a
  // missing/stale price must be reported as `market_price_fresh` rather than
  // as a confusing "invalid order parameters" refusal.
  'market_price_fresh',
  'valid_order_params',
  'valid_stop_loss',
  'valid_take_profit',
  'acceptable_rr',
  'exposure_limits',
] as const;
export type PaperSimulationGateId = (typeof PAPER_SIMULATION_GATE_IDS)[number];

/* -------------------------------------------------------------------------- */
/* DTOs                                                                        */
/* -------------------------------------------------------------------------- */

const uuidSchema = z.string().uuid();
const isoDateTimeSchema = z.string();

/**
 * Simulation request. The ONLY client inputs are identifiers — never a price,
 * size, approval, P&L or execution state. Everything else is loaded from the
 * database (setup levels, risk verdict, market data).
 */
export const paperSimulateSchema = z
  .object({
    setupId: uuidSchema,
    executionProfileId: uuidSchema,
    /**
     * Optional: a previously server-issued risk decision to execute. It can
     * only ever NARROW the simulation (it must exist, be owned, match the
     * setup/profile, be approved, carry the pinned engine version and be
     * fresh) — a fresh decision is always produced server-side regardless.
     */
    riskDecisionId: uuidSchema.optional(),
  })
  .strict();
export type PaperSimulateInput = z.infer<typeof paperSimulateSchema>;

/** Position actions take no client input at all: no price, no quantity. */
export const paperPositionActionSchema = z.object({}).strict();
export type PaperPositionActionInput = z.infer<typeof paperPositionActionSchema>;

export const paperOrderDtoSchema = executionOrderDtoSchema
  .extend({
    setupId: uuidSchema.nullable(),
    riskDecisionId: uuidSchema.nullable(),
    filledQuantity: z.number().min(0),
    averageFillPrice: z.number().nullable(),
    fees: z.number().min(0),
    slippage: z.number().min(0),
    referencePrice: z.number().nullable(),
    referencePriceMs: z.number().int().nullable(),
    simulated: z.boolean(),
    simulatorVersion: z.string().nullable(),
  })
  .strict();
export type PaperOrderDto = z.infer<typeof paperOrderDtoSchema>;

export const paperPositionDtoSchema = executionPositionDtoSchema
  .extend({
    setupId: uuidSchema.nullable(),
    openedByOrderId: uuidSchema.nullable(),
    closedByOrderId: uuidSchema.nullable(),
    exitPrice: z.number().nullable(),
    exitReason: z.enum(PAPER_EXIT_REASONS).nullable(),
    fees: z.number().min(0),
    slippage: z.number().min(0),
    markPrice: z.number().nullable(),
    markPriceMs: z.number().int().nullable(),
    simulated: z.boolean(),
    simulatorVersion: z.string().nullable(),
  })
  .strict();
export type PaperPositionDto = z.infer<typeof paperPositionDtoSchema>;

export const paperFillDtoSchema = z
  .object({
    id: uuidSchema,
    executionProfileId: uuidSchema,
    orderId: uuidSchema,
    positionId: uuidSchema.nullable(),
    setupId: uuidSchema.nullable(),
    sequence: z.number().int().positive(),
    fillType: z.enum(PAPER_FILL_TYPES),
    quantity: z.number(),
    price: z.number(),
    fees: z.number().min(0),
    slippage: z.number().min(0),
    referencePrice: z.number().nullable(),
    simulated: z.boolean(),
    idempotencyKey: z.string().length(64),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type PaperFillDto = z.infer<typeof paperFillDtoSchema>;

export const reconciliationDtoSchema = z
  .object({
    id: uuidSchema,
    executionProfileId: uuidSchema,
    orderId: uuidSchema.nullable(),
    positionId: uuidSchema.nullable(),
    scope: z.enum(RECONCILIATION_SCOPES),
    outcome: z.enum(RECONCILIATION_OUTCOMES),
    findings: z.array(z.enum(PAPER_RECONCILIATION_FINDINGS)),
    expected: z.record(z.string(), z.unknown()),
    actual: z.record(z.string(), z.unknown()),
    simulatorVersion: z.string(),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type ReconciliationDto = z.infer<typeof reconciliationDtoSchema>;

/**
 * Simulated-execution outcome. `simulated: false` means the attempt was
 * refused by a pinned gate (or failed) — it is never a silent success.
 */
export const paperSimulationResultDtoSchema = z
  .object({
    simulated: z.boolean(),
    replayed: z.boolean(),
    simulatorVersion: z.string(),
    /** Gate that refused the simulation (null when it proceeded). */
    gate: z.enum(PAPER_SIMULATION_GATE_IDS).nullable(),
    reason: z.string().nullable(),
    setupId: uuidSchema.nullable(),
    executionProfileId: uuidSchema.nullable(),
    riskDecisionId: uuidSchema.nullable(),
    riskEngineVersion: z.string().nullable(),
    positionSize: z.number().nullable(),
    order: paperOrderDtoSchema.nullable(),
    position: paperPositionDtoSchema.nullable(),
    fills: z.array(paperFillDtoSchema),
    /** Append-only event names written by this attempt, in order. */
    events: z.array(z.string()),
    /** True when the automated (M8.1) path is still blocked — always true. */
    automationOff: z.boolean(),
    automatedPathGate: z.string().nullable(),
  })
  .strict();
export type PaperSimulationResultDto = z.infer<typeof paperSimulationResultDtoSchema>;

export const paperPositionOutcomeDtoSchema = z
  .object({
    progressed: z.boolean(),
    positionId: uuidSchema,
    exitReason: z.enum(PAPER_EXIT_REASONS).nullable(),
    realizedPl: z.number().nullable(),
    markPrice: z.number().nullable(),
    order: paperOrderDtoSchema.nullable(),
    fills: z.array(paperFillDtoSchema),
    events: z.array(z.string()),
  })
  .strict();
export type PaperPositionOutcomeDto = z.infer<typeof paperPositionOutcomeDtoSchema>;

export const paperStatusDtoSchema = z
  .object({
    simulatorVersion: z.string(),
    riskEngineVersion: z.literal(RISK_ENGINE_VERSION),
    providerId: z.string(),
    providerConfigured: z.boolean(),
    providerHealthy: z.boolean(),
    providerReason: z.string().nullable(),
    /** Server-authoritative automation state — OFF in this milestone. */
    automationOff: z.boolean(),
    automationReasons: z.array(z.string()),
    automatedPathGate: z.string().nullable(),
    profiles: z.number().int().min(0),
    orders: z.number().int().min(0),
    openPositions: z.number().int().min(0),
    closedPositions: z.number().int().min(0),
    fills: z.number().int().min(0),
    /** Sum of stored (last-marked) unrealized P&L across open positions. */
    openPl: z.number(),
    /** Sum of realized P&L across closed positions. */
    closedPl: z.number(),
    lastReconciliationOutcome: z.enum(RECONCILIATION_OUTCOMES).nullable(),
    /** Live/demo execution remains impossible — pinned for the UI. */
    liveExecutionAvailable: z.literal(false),
  })
  .strict();
export type PaperStatusDto = z.infer<typeof paperStatusDtoSchema>;

export const paperListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type PaperListQuery = z.infer<typeof paperListQuerySchema>;

/** Instruments the simulator can price (platform market universe). */
export const PAPER_SUPPORTED_ASSET_CLASSES = ASSET_CLASSES;
