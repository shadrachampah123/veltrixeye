import { z } from 'zod';
import { ASSET_CLASSES } from './assets.js';
import { DEFAULT_MIN_RR } from './risk.js';

/**
 * M8.2 — Risk Management Engine contracts.
 *
 * Server-authoritative, deterministic, fail-closed. A client-provided
 * boolean is NEVER a risk approval: the only valid approval is a
 * server-issued `RiskDecisionDto` produced by the engine.
 *
 * M8.2 does NOT execute trades. Risk approval ≠ permission to execute.
 * Automation stays OFF; no broker/demo/paper orders are placed.
 */

/** Pinned engine version recorded on every risk decision. */
export const RISK_ENGINE_VERSION = 'm8.2-risk-engine-1';

/**
 * How long an in-flight `risk_reservations` row remains authoritative.
 *
 * Intake is expected to release the row as soon as downstream gates refuse
 * (they always do in M8.2). If a process crashes between `evaluate()` COMMIT
 * and that release, the next evaluation on the same profile reclaims any row
 * whose `expires_at` is ≤ the evaluation clock so a stale reservation cannot
 * permanently consume simultaneous-position / exposure budget.
 *
 * 60s is far longer than gate evaluation and far shorter than a stuck crash.
 * Not an environment variable — a pinned safety constant.
 */
export const RISK_RESERVATION_TTL_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* Platform safety ceilings (immutable, server-controlled)                     */
/* -------------------------------------------------------------------------- */

/**
 * Hard platform ceilings. User-editable settings may only request a value
 * INSIDE this envelope. The engine also re-enforces these at evaluation
 * time so a crafted row cannot weaken safety.
 *
 * Percentages are percent-of-equity (1 = 1%). Monetary values are account
 * currency units (paper USD).
 */
export const PLATFORM_RISK_CEILINGS = {
  /** Maximum risk % of equity per new trade. */
  maxRiskPctPerTrade: 1,
  /** Absolute monetary cap per new trade. */
  maxMonetaryRiskPerTrade: 10_000,
  /** Maximum daily realized loss as % of equity. */
  maxDailyLossPct: 5,
  /** Maximum weekly realized loss as % of equity. */
  maxWeeklyLossPct: 10,
  /** Maximum consecutive losing trades before new risk is refused. */
  maxConsecutiveLosses: 5,
  /** Maximum simultaneous open + reserved positions. */
  maxSimultaneousPositions: 5,
  /** Maximum total open (and reserved) risk as % of equity. */
  maxTotalOpenRiskPct: 5,
  /** Maximum open risk in one instrument as % of equity. */
  maxExposurePerInstrumentPct: 2,
  /** Maximum open risk in one direction as % of equity. */
  maxExposurePerDirectionPct: 3,
  /** Maximum quantity (lots/contracts/shares) the sizer may return. */
  maxPositionSize: 100,
  /** Platform minimum reward:risk. Client cannot go below this. */
  minRr: DEFAULT_MIN_RR,
  /** Paper-account equity bounds (simulation parameter, not a live balance). */
  minPaperEquity: 100,
  maxPaperEquity: 1_000_000,
  defaultPaperEquity: 10_000,
} as const;

export type PlatformRiskCeilings = typeof PLATFORM_RISK_CEILINGS;

/** Default user policy — always inside the platform envelope. */
export const DEFAULT_RISK_POLICY = {
  enabled: true,
  riskPctPerTrade: 0.5,
  maxMonetaryRiskPerTrade: 500,
  maxDailyLossPct: 3,
  maxWeeklyLossPct: 6,
  maxConsecutiveLosses: 3,
  maxSimultaneousPositions: 3,
  maxTotalOpenRiskPct: 3,
  maxExposurePerInstrumentPct: 1,
  maxExposurePerDirectionPct: 2,
  minRr: DEFAULT_MIN_RR,
  maxSpreadPips: null as number | null,
  maxSlippagePips: null as number | null,
  allowedSessions: null as readonly RiskSessionWindow[] | null,
  correlationRequired: false,
  maxCorrelationGroupExposurePct: 2,
} as const;

/* -------------------------------------------------------------------------- */
/* Rejection codes (pinned, deterministic)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Structured rejection codes. The engine returns the FIRST matching code
 * in this array's order when multiple checks fail; `violations` on the
 * audit payload lists every code that fired.
 */
export const RISK_REJECTION_CODES = [
  'KILL_SWITCH_ACTIVE',
  'POLICY_DISABLED',
  'INVALID_DIRECTION',
  'INVALID_SYMBOL',
  'UNSUPPORTED_SYMBOL',
  'INVALID_ENTRY',
  'INVALID_STOP_LOSS',
  'INVALID_TAKE_PROFIT',
  'INVALID_PRICES',
  'MISSING_SL',
  'MISSING_TP',
  'SL_WRONG_SIDE',
  'TP_WRONG_SIDE',
  'STOP_DISTANCE_NOT_POSITIVE',
  'ZERO_RISK_DISTANCE',
  'MISSING_INSTRUMENT_METADATA',
  'INVALID_CONTRACT_SPEC',
  'ZERO_OR_NEGATIVE_EQUITY',
  'OVERFLOW',
  'SESSION_NOT_ALLOWED',
  'RR_INVALID',
  'RR_BELOW_MINIMUM',
  'SPREAD_EXCEEDS_MAXIMUM',
  'SLIPPAGE_EXCEEDS_MAXIMUM',
  'STRATEGY_RESTRICTION',
  'DAILY_LOSS_LIMIT',
  'WEEKLY_LOSS_LIMIT',
  'CONSECUTIVE_LOSS_LIMIT',
  'POSITION_SIZE_UNCOMPUTABLE',
  'POSITION_SIZE_BELOW_MINIMUM',
  'POSITION_SIZE_EXCEEDS_MAXIMUM',
  'MONETARY_RISK_EXCEEDS_LIMIT',
  'SIMULTANEOUS_POSITION_LIMIT',
  'TOTAL_OPEN_RISK_LIMIT',
  'INSTRUMENT_EXPOSURE_LIMIT',
  'DIRECTION_EXPOSURE_LIMIT',
  'CORRELATION_METADATA_UNAVAILABLE',
  'CORRELATION_EXPOSURE_LIMIT',
  'OPEN_POSITION_RISK_UNCOMPUTABLE',
] as const;
export type RiskRejectionCode = (typeof RISK_REJECTION_CODES)[number];

export const RISK_DECISION_OUTCOMES = ['approved', 'rejected'] as const;
export type RiskDecisionOutcome = (typeof RISK_DECISION_OUTCOMES)[number];

/* -------------------------------------------------------------------------- */
/* Sessions (UTC, never a user timezone)                                       */
/* -------------------------------------------------------------------------- */

export const RISK_SESSION_NAMES = ['asia', 'london', 'new_york', 'sydney'] as const;
export type RiskSessionName = (typeof RISK_SESSION_NAMES)[number];

/**
 * Named windows are the same UTC hours the evaluation engine uses.
 * Custom windows are exclusive-end hour ranges in UTC (endHour 24 = 00:00
 * next day). A wrapping window (endHour <= startHour) covers midnight.
 */
export const riskSessionWindowSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('named'),
      name: z.enum(RISK_SESSION_NAMES),
    })
    .strict(),
  z
    .object({
      kind: z.literal('utc_hours'),
      startHour: z.number().int().min(0).max(23),
      endHour: z.number().int().min(0).max(24),
    })
    .strict(),
]);
export type RiskSessionWindow = z.infer<typeof riskSessionWindowSchema>;

/* -------------------------------------------------------------------------- */
/* Instrument contract specification                                           */
/* -------------------------------------------------------------------------- */

export const INSTRUMENT_PNL_MODES = ['quote_linear', 'base_linear'] as const;
export type InstrumentPnlMode = (typeof INSTRUMENT_PNL_MODES)[number];

export const instrumentRiskSpecSchema = z
  .object({
    assetClass: z.enum(ASSET_CLASSES),
    symbol: z.string().min(1).max(32),
    /** Units of the instrument's base per 1.0 quantity. */
    contractSize: z.number().positive().finite(),
    pipSize: z.number().positive().finite(),
    /**
     * quote_linear: monetary_risk = qty × contractSize × |entry−SL|
     *   (quote currency is the account currency).
     * base_linear:  monetary_risk = qty × contractSize × |entry−SL| / entry
     *   (base currency is the account currency — e.g. USDJPY).
     */
    pnlMode: z.enum(INSTRUMENT_PNL_MODES),
    quoteCurrency: z.string().min(3).max(8),
    minQuantity: z.number().positive().finite(),
    quantityStep: z.number().positive().finite(),
    maxQuantity: z.number().positive().finite(),
  })
  .strict();
export type InstrumentRiskSpec = z.infer<typeof instrumentRiskSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Policy DTOs                                                                 */
/* -------------------------------------------------------------------------- */

const pctSchema = (max: number) => z.number().positive().max(max).finite();
const moneySchema = z.number().positive().finite().max(PLATFORM_RISK_CEILINGS.maxMonetaryRiskPerTrade);

export const riskPolicyDtoSchema = z
  .object({
    id: z.string().uuid(),
    enabled: z.boolean(),
    policyVersion: z.number().int().positive(),
    riskPctPerTrade: z.number(),
    maxMonetaryRiskPerTrade: z.number().nullable(),
    maxDailyLossPct: z.number(),
    maxWeeklyLossPct: z.number(),
    maxConsecutiveLosses: z.number().int(),
    maxSimultaneousPositions: z.number().int(),
    maxTotalOpenRiskPct: z.number(),
    maxExposurePerInstrumentPct: z.number(),
    maxExposurePerDirectionPct: z.number(),
    minRr: z.number(),
    maxSpreadPips: z.number().nullable(),
    maxSlippagePips: z.number().nullable(),
    allowedSessions: z.array(riskSessionWindowSchema).nullable(),
    correlationRequired: z.boolean(),
    maxCorrelationGroupExposurePct: z.number(),
    paperEquity: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type RiskPolicyDto = z.infer<typeof riskPolicyDtoSchema>;

/**
 * User-editable subset. Every field is optional; omitted keys are left
 * unchanged. Values outside the platform envelope are REJECTED (not
 * silently clamped) so a client cannot raise risk above the ceiling.
 */
export const riskPolicyUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    riskPctPerTrade: pctSchema(PLATFORM_RISK_CEILINGS.maxRiskPctPerTrade).optional(),
    maxMonetaryRiskPerTrade: moneySchema.nullable().optional(),
    maxDailyLossPct: pctSchema(PLATFORM_RISK_CEILINGS.maxDailyLossPct).optional(),
    maxWeeklyLossPct: pctSchema(PLATFORM_RISK_CEILINGS.maxWeeklyLossPct).optional(),
    maxConsecutiveLosses: z
      .number()
      .int()
      .positive()
      .max(PLATFORM_RISK_CEILINGS.maxConsecutiveLosses)
      .optional(),
    maxSimultaneousPositions: z
      .number()
      .int()
      .positive()
      .max(PLATFORM_RISK_CEILINGS.maxSimultaneousPositions)
      .optional(),
    maxTotalOpenRiskPct: pctSchema(PLATFORM_RISK_CEILINGS.maxTotalOpenRiskPct).optional(),
    maxExposurePerInstrumentPct: pctSchema(PLATFORM_RISK_CEILINGS.maxExposurePerInstrumentPct).optional(),
    maxExposurePerDirectionPct: pctSchema(PLATFORM_RISK_CEILINGS.maxExposurePerDirectionPct).optional(),
    /** Must be ≥ platform minRr. Higher (stricter) is allowed. */
    minRr: z.number().min(PLATFORM_RISK_CEILINGS.minRr).max(100).finite().optional(),
    maxSpreadPips: z.number().positive().max(1_000).finite().nullable().optional(),
    maxSlippagePips: z.number().positive().max(1_000).finite().nullable().optional(),
    allowedSessions: z.array(riskSessionWindowSchema).max(16).nullable().optional(),
    correlationRequired: z.boolean().optional(),
    maxCorrelationGroupExposurePct: pctSchema(PLATFORM_RISK_CEILINGS.maxTotalOpenRiskPct).optional(),
    paperEquity: z
      .number()
      .min(PLATFORM_RISK_CEILINGS.minPaperEquity)
      .max(PLATFORM_RISK_CEILINGS.maxPaperEquity)
      .finite()
      .optional(),
  })
  .strict();
export type RiskPolicyUpdateInput = z.infer<typeof riskPolicyUpdateSchema>;

export const platformRiskCeilingsDtoSchema = z
  .object({
    maxRiskPctPerTrade: z.number(),
    maxMonetaryRiskPerTrade: z.number(),
    maxDailyLossPct: z.number(),
    maxWeeklyLossPct: z.number(),
    maxConsecutiveLosses: z.number(),
    maxSimultaneousPositions: z.number(),
    maxTotalOpenRiskPct: z.number(),
    maxExposurePerInstrumentPct: z.number(),
    maxExposurePerDirectionPct: z.number(),
    maxPositionSize: z.number(),
    minRr: z.number(),
    minPaperEquity: z.number(),
    maxPaperEquity: z.number(),
    defaultPaperEquity: z.number(),
  })
  .strict();
export type PlatformRiskCeilingsDto = z.infer<typeof platformRiskCeilingsDtoSchema>;

/* -------------------------------------------------------------------------- */
/* Account snapshot (server-owned; never client-supplied P&L)                  */
/* -------------------------------------------------------------------------- */

export const riskAccountSnapshotDtoSchema = z
  .object({
    equity: z.number(),
    dailyRealizedPl: z.number(),
    weeklyRealizedPl: z.number(),
    consecutiveLosses: z.number().int().min(0),
    openPositions: z.number().int().min(0),
    reservedPositions: z.number().int().min(0),
    totalOpenRisk: z.number(),
    dailyWindowStart: z.string(),
    weeklyWindowStart: z.string(),
  })
  .strict();
export type RiskAccountSnapshotDto = z.infer<typeof riskAccountSnapshotDtoSchema>;

export const riskPolicyStatusDtoSchema = z
  .object({
    policy: riskPolicyDtoSchema,
    platformCeilings: platformRiskCeilingsDtoSchema,
    account: riskAccountSnapshotDtoSchema,
    engineVersion: z.literal(RISK_ENGINE_VERSION),
  })
  .strict();
export type RiskPolicyStatusDto = z.infer<typeof riskPolicyStatusDtoSchema>;

/* -------------------------------------------------------------------------- */
/* Risk decision                                                               */
/* -------------------------------------------------------------------------- */

export const riskExposureSnapshotSchema = z
  .object({
    openPositions: z.number().int().min(0),
    reservedPositions: z.number().int().min(0),
    totalOpenRisk: z.number(),
    instrumentOpenRisk: z.number(),
    directionOpenRisk: z.number(),
  })
  .strict();
export type RiskExposureSnapshot = z.infer<typeof riskExposureSnapshotSchema>;

export const riskDecisionDtoSchema = z
  .object({
    id: z.string().uuid(),
    outcome: z.enum(RISK_DECISION_OUTCOMES),
    rejectionCode: z.enum(RISK_REJECTION_CODES).nullable(),
    reason: z.string().min(1).max(500),
    riskPct: z.number().nullable(),
    monetaryRisk: z.number().nullable(),
    positionSize: z.number().nullable(),
    entryPrice: z.number(),
    stopLossPrice: z.number(),
    takeProfitPrice: z.number(),
    rr: z.number().nullable(),
    currentExposure: riskExposureSnapshotSchema,
    projectedExposure: riskExposureSnapshotSchema,
    policyVersion: z.number().int().positive(),
    engineVersion: z.literal(RISK_ENGINE_VERSION),
    evaluatedAt: z.string(),
  })
  .strict();
export type RiskDecisionDto = z.infer<typeof riskDecisionDtoSchema>;

export const riskDecisionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type RiskDecisionListQuery = z.infer<typeof riskDecisionListQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function isRiskRejectionCode(value: unknown): value is RiskRejectionCode {
  return typeof value === 'string' && (RISK_REJECTION_CODES as readonly string[]).includes(value);
}

export function platformCeilingsDto(): PlatformRiskCeilingsDto {
  return { ...PLATFORM_RISK_CEILINGS };
}
