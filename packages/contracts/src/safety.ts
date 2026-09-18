import { z } from 'zod';
import { KILL_SWITCH_SCOPES } from './execution.js';

/**
 * M8.6 — Kill-switch & safety controls (contracts).
 *
 * M8.6 strengthens the emergency-stop machinery M8.1 introduced, WITHOUT
 * relaxing any earlier boundary:
 *
 *  - Four scopes remain (global / user / strategy / execution_profile). An
 *    ACTIVE switch refuses new execution everywhere — both the automated
 *    path (gate 6 `kill_switch`) and user-initiated paper simulations
 *    (paper gate `kill_switch`). Risk-REDUCING actions (closing or
 *    evaluating an already-open simulated position) are intentionally never
 *    blocked: a stop must not strand exposure.
 *  - Every switch change is durably audited: an append-only
 *    `kill_switch_events` ledger (one row per change attempt — including
 *    no-ops — with actor, reason, source, and whether state changed).
 *  - Users can STOP themselves (any scope they own) from any device, without
 *    an entitlement and without confirmation friction: stopping is always
 *    allowed; only platform-level GLOBAL switches are operator/environment
 *    territory and are never mutable through the user API.
 *  - A deployment-level `EXECUTION_GLOBAL_KILL_SWITCH=true` pins the global
 *    switch ON regardless of database state; it cannot be cleared through any
 *    API. That is the operator's last-resort lever when the database itself
 *    is unavailable to normal tooling.
 *  - Loss-limit circuit breakers: when the M8.2 risk engine rejects on a
 *    daily/weekly/consecutive-loss breach, the user's kill switch trips
 *    automatically and STAYS tripped until explicitly cleared with a reason
 *    (the rejection alone was a per-decision refusal; the breaker makes the
 *    stop durable).
 *  - Emergency stop: one call activates the user kill switch, forces the
 *    automation switch OFF (the safe direction — always allowed, even without
 *    an entitlement) and disables the user's execution profiles.
 *  - Automation enable is additionally blocked while any kill switch is
 *    active, and automation disable is now possible without an entitlement
 *    (turning a safety control OFF is never gated by a subscription).
 *
 * M8.7 extends the safety surface with drawdown-based circuit breakers:
 *  - Daily/weekly/maximum drawdown limits computed from authoritative
 *    internal account data (immutable initial equity + cumulative realized P&L).
 *  - Configurable warning and hard-stop thresholds for each drawdown type.
 *  - Hard-stops trip the circuit breaker (durable kill switch + event).
 *  - Warnings surface in the safety status but do not trip the breaker.
 *  - Missing/stale/contradictory equity data fails closed.
 *
 * Live execution remains impossible by construction; nothing here grants a
 * trading capability — M8.7 only strengthens the brakes.
 */

/** Pinned safety-controls version (audit/UI; rows keep their own versions). */
export const SAFETY_CONTROLS_VERSION = 'm8.7-safety-controls-1';

/** Where a switch state came from. Machine-stable vocabulary. */
export const KILL_SWITCH_SOURCES = ['operator', 'user', 'circuit_breaker'] as const;
export type KillSwitchSource = (typeof KILL_SWITCH_SOURCES)[number];

/** What happened to a switch. Events are appended for BOTH (even no-ops). */
export const KILL_SWITCH_EVENT_ACTIONS = ['activated', 'cleared'] as const;
export type KillSwitchEventAction = (typeof KILL_SWITCH_EVENT_ACTIONS)[number];

/**
 * Scopes a USER may act on through the API. `global` is deliberately absent:
 * the platform-wide switch is operator/environment territory only. The
 * service layer re-checks this so a crafted request can never reach it.
 */
export const MUTABLE_KILL_SWITCH_SCOPES = ['user', 'strategy', 'execution_profile'] as const;
export type MutableKillSwitchScope = (typeof MUTABLE_KILL_SWITCH_SCOPES)[number];

/** Activation/clear reason — required, bounded, and never a credential. */
export const killSwitchReasonSchema = z
  .string()
  .trim()
  .min(3, 'A reason of at least 3 characters is required')
  .max(400, 'Reason is too long (max 400 characters)')
  // Reason text is rendered in dashboards and logs. The whitelist keeps
  // ordinary prose while refusing markup/escape characters (< > & " backtick)
  // and anything control-like — the same "safe strings" discipline the audit
  // trail uses elsewhere. Credential-shaped values (long opaque tokens) fail
  // the length bound; colons/spaces pass naturally for notes like "incident: X".
  .regex(/^[A-Za-z0-9 .,;:!?'()@#%+=/[\]{}_-]+$/, 'Reason contains unsupported characters');

const uuidSchema = z.string().uuid();
const isoDateTimeSchema = z.string();

/**
 * `POST /api/execution/safety/kill-switch/activate|clear` body.
 *
 * - `scope=user` NEVER accepts a `targetId`: the session user is the target.
 *   (A client cannot aim a switch at somebody else's account.)
 * - `scope=strategy|execution_profile` requires `targetId`; ownership is
 *   re-proven server-side and answered with a masked 404 otherwise.
 * - `scope=global` cannot even be parsed (not in the enum).
 */
function buildKillSwitchMutationSchema() {
  return z
    .object({
      scope: z.enum(MUTABLE_KILL_SWITCH_SCOPES),
      targetId: uuidSchema.optional(),
      reason: killSwitchReasonSchema,
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.scope === 'user' && v.targetId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetId'],
          message: 'The user-scope kill switch always targets the session account; targetId is not accepted',
        });
      }
      if (v.scope !== 'user' && v.targetId === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetId'],
          message: `Kill switch scope "${v.scope}" requires a targetId`,
        });
      }
    });
}

export const killSwitchActivateSchema = buildKillSwitchMutationSchema();
export type KillSwitchActivateInput = z.infer<typeof killSwitchActivateSchema>;

export const killSwitchClearSchema = buildKillSwitchMutationSchema();
export type KillSwitchClearInput = z.infer<typeof killSwitchClearSchema>;

/** `POST /api/execution/safety/emergency-stop` body — reason optional. */
export const EMERGENCY_STOP_DEFAULT_REASON = 'Emergency stop requested from the account UI';
export const emergencyStopSchema = z
  .object({
    reason: killSwitchReasonSchema.optional(),
  })
  .strict();
export type EmergencyStopInput = z.infer<typeof emergencyStopSchema>;

/* -------------------------------------------------------------------------- */
/* DTOs                                                                        */
/* -------------------------------------------------------------------------- */

/** One switch (current state) for a scope+target. `active=false` + absent row share the same shape. */
export const killSwitchEntryDtoSchema = z
  .object({
    scope: z.enum(KILL_SWITCH_SCOPES),
    targetId: uuidSchema.nullable(),
    /** Human label resolved server-side (strategy name, profile provider slug…). */
    entityLabel: z.string().nullable(),
    active: z.boolean(),
    /** Source of the LAST state change (default 'operator' for untouched rows). */
    source: z.enum(KILL_SWITCH_SOURCES),
    reason: z.string().nullable(),
    activatedAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .strict();
export type KillSwitchEntryDto = z.infer<typeof killSwitchEntryDtoSchema>;

/**
 * Full per-user safety picture in one read: every switch that can refuse
 * THIS account's execution, the automation state that produces `effective`,
 * the circuit-breaker summary, and whether the global switch is environment-
 * pinned. The UI renders THIS and nothing else (no separate truth to drift).
 */
/**
 * M8.7 — drawdown protection state surfaced in the safety status.
 * Read-only for users; computed from authoritative internal data.
 */
export const drawdownProtectionStatusSchema = z
  .object({
    /** Current account value (immutable tracked baseline + cumulative realized P&L). */
    currentAccountValue: z.number(),
    /** Highest account value ever recorded. */
    peakEquity: z.number(),
    /** Current drawdown from peak (0–100+ %). */
    currentDrawdownPct: z.number().min(0),
    /** Configured warning threshold for max drawdown. */
    maxDrawdownWarningPct: z.number(),
    /** Configured hard-stop threshold for max drawdown. */
    maxDrawdownLimitPct: z.number(),
    /** Whether max drawdown warning is active. */
    maxDrawdownWarningActive: z.boolean(),
    /** Whether max drawdown hard-stop is active. */
    maxDrawdownLimitActive: z.boolean(),
    /** Daily drawdown from the daily high (0–100+ %). */
    dailyDrawdownPct: z.number().min(0),
    dailyDrawdownWarningPct: z.number(),
    dailyDrawdownLimitPct: z.number(),
    dailyDrawdownWarningActive: z.boolean(),
    dailyDrawdownLimitActive: z.boolean(),
    /** Weekly drawdown from the weekly open (0–100+ %). */
    weeklyDrawdownPct: z.number().min(0),
    weeklyDrawdownWarningPct: z.number(),
    weeklyDrawdownLimitPct: z.number(),
    weeklyDrawdownWarningActive: z.boolean(),
    weeklyDrawdownLimitActive: z.boolean(),
    /** Whether ANY hard-stop threshold is breached. */
    anyHardStopActive: z.boolean(),
    /** Whether data was available for drawdown calculations. */
    dataAvailable: z.boolean(),
  })
  .strict();
export type DrawdownProtectionStatus = z.infer<typeof drawdownProtectionStatusSchema>;

export const killSwitchStatusDtoSchema = z
  .object({
    safetyVersion: z.string(),
    architectureVersion: z.string(),
    /** True when `EXECUTION_GLOBAL_KILL_SWITCH=true` pins global ON. */
    globalForcedByEnvironment: z.boolean(),
    global: killSwitchEntryDtoSchema,
    user: killSwitchEntryDtoSchema,
    strategies: z.array(
      killSwitchEntryDtoSchema
        .omit({ scope: true })
        .extend({ strategyId: uuidSchema })
        .strict(),
    ),
    profiles: z.array(
      killSwitchEntryDtoSchema
        .omit({ scope: true })
        .extend({
          executionProfileId: uuidSchema,
          providerSlug: z.string(),
          environment: z.string(),
        })
        .strict(),
    ),
    /** Any switch in scope right now — the single boolean the UI warns on. */
    anyActive: z.boolean(),
    circuitBreaker: z
      .object({
        /** True when the ACTIVE user switch was tripped by the risk engine. */
        active: z.boolean(),
        trippedAt: isoDateTimeSchema.nullable(),
        reason: z.string().nullable(),
      })
      .strict(),
    automation: z
      .object({
        entitled: z.boolean(),
        automationEnabled: z.boolean(),
        /** entitled && switch && no kill switch — mirrors /execution/automation. */
        effective: z.boolean(),
      })
      .strict(),
    /**
     * M8.7 — drawdown/equity protection state (read-only for users).
     * When `anyHardStopActive` is true, new automated entries are refused.
     * Position exits and safe-direction operations remain possible.
     */
    drawdownProtection: drawdownProtectionStatusSchema.optional(),
  })
  .strict();
export type KillSwitchStatusDto = z.infer<typeof killSwitchStatusDtoSchema>;

/** One appended `kill_switch_events` row (owner-scoped read model). */
export const killSwitchEventDtoSchema = z
  .object({
    id: z.string(),
    scope: z.enum(KILL_SWITCH_SCOPES),
    targetId: uuidSchema.nullable(),
    entityLabel: z.string().nullable(),
    action: z.enum(KILL_SWITCH_EVENT_ACTIONS),
    source: z.enum(KILL_SWITCH_SOURCES),
    reason: z.string().nullable(),
    /** False for a redundant call (activate while already active / clear while already clear). */
    changed: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict();
export type KillSwitchEventDto = z.infer<typeof killSwitchEventDtoSchema>;

export const killSwitchEventListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type KillSwitchEventListQuery = z.infer<typeof killSwitchEventListQuerySchema>;

/** Response of `activate`/`clear`: the outcome plus the refreshed status. */
export const killSwitchMutationResultDtoSchema = z
  .object({
    action: z.enum(KILL_SWITCH_EVENT_ACTIONS),
    changed: z.boolean(),
    status: killSwitchStatusDtoSchema,
  })
  .strict();
export type KillSwitchMutationResultDto = z.infer<typeof killSwitchMutationResultDtoSchema>;

/** Response of `POST /api/execution/safety/emergency-stop`. */
export const emergencyStopResultDtoSchema = z
  .object({
    stopped: z.literal(true),
    killSwitchActivated: z.boolean(),
    automationWasEnabled: z.boolean(),
    automationDisabled: z.boolean(),
    profilesDisabled: z.number().int().min(0),
    status: killSwitchStatusDtoSchema,
  })
  .strict();
export type EmergencyStopResultDto = z.infer<typeof emergencyStopResultDtoSchema>;

/**
 * Loss-limit codes that trip the automatic circuit breaker (the engine's
 * own codes, pinned here so core/UI/tests share one list). KILL_SWITCH_ACTIVE
 * is NOT included — the breaker must never trip itself into a loop, and a
 * switch that is already on needs no re-trip.
 *
 * M8.7 adds drawdown hard-stop codes to the breaker set.
 */
export const RISK_CIRCUIT_BREAKER_CODES = [
  'DAILY_LOSS_LIMIT',
  'WEEKLY_LOSS_LIMIT',
  'CONSECUTIVE_LOSS_LIMIT',
  'DAILY_DRAWDOWN_LIMIT',
  'WEEKLY_DRAWDOWN_LIMIT',
  'MAX_DRAWDOWN_LIMIT',
  'EQUITY_DATA_UNAVAILABLE',
] as const;
export type RiskCircuitBreakerCode = (typeof RISK_CIRCUIT_BREAKER_CODES)[number];

export function isCircuitBreakerCode(code: string): code is RiskCircuitBreakerCode {
  return (RISK_CIRCUIT_BREAKER_CODES as readonly string[]).includes(code);
}
