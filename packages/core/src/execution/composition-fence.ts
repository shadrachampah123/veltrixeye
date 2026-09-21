/**
 * B1 remediation — shared composition guards (H2, H3, H4, H5, M3, M5).
 *
 * Pure helpers plus the final safety fence used by the execution composition
 * (`composition.ts`), the execution intake (`intake.ts`), and the composed
 * paper entry (`paper-service.ts`). This module is a leaf: it depends only on
 * contracts, the readiness resolver, the authorization context rule, and
 * error constructors — so all three consumers share one implementation with
 * no import cycle.
 *
 * Contents:
 *  - H2 `freezeCompositionInput` / `assertCompositionInputUnchanged`:
 *    validate caller input once, snapshot it immutably, and detect any later
 *    caller mutation (fail closed rather than mix contexts).
 *  - H3 `resolveBrokerAccountAuthorization`: authoritative broker-account
 *    authorization. No grant mechanism exists in this platform version, so
 *    every non-paper provider fails closed. The signature deliberately takes
 *    no account/server fields: editable profile metadata is never consulted.
 *  - M3 `evaluateProviderReadinessForGate`: the FULL provider health record
 *    is evaluated by the single authoritative readiness resolver
 *    (`providerHealth` profile) BEFORE anything is projected into the gate
 *    input — never reduced to `{ healthy }`, never truthiness-coerced.
 *  - H4 `toGate9RiskHandoff`: build the Gate 9 risk handoff from the live
 *    risk reservation, failing closed unless a positive decimal exposure is
 *    represented (an approval can never reach Gate 9 as '0').
 *  - M5 `mapBrokerSubmitOutcome`: canonical outcome mapping (accepted vs
 *    rejected vs uncertain vs duplicate), unit-tested for every class.
 *  - H5 `runFinalSafetyFence`: the race-safe final authorization/safety
 *    linearization point, run with fresh reads immediately before the
 *    authoritative submission boundary.
 */

import type pg from 'pg';
import type {
  ExecutionGateId,
  ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import { resolveExecutionReadiness } from './readiness.js';
import {
  assertAuthorizationContext,
  type AuthorizationExecutionContext,
  type ExecutionAuthorization,
} from './authorization.js';
import type { CanonicalSubmitResult } from './submit-boundary.js';

/* -------------------------------------------------------------------------- */
/* H2 — immutable composition context                                          */
/* -------------------------------------------------------------------------- */

/** Structural shape of the composition caller input (see composition.ts). */
export interface CompositionInputShape {
  userId: string;
  executionProfileId: string;
  setupId: string;
  action?: 'open_long' | 'open_short' | 'close_position';
  riskDecisionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  nowMs?: number;
}

export interface FrozenCompositionInput {
  readonly userId: string;
  readonly executionProfileId: string;
  readonly setupId: string;
  readonly action: 'open_long' | 'open_short' | 'close_position' | undefined;
  readonly riskDecisionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly nowMs: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * H2 — validate caller input and snapshot it immutably.
 *
 * Must be the FIRST thing the composition entry point does, before any
 * `await`. Every subsequent ownership lookup and downstream operation uses
 * ONLY the returned frozen snapshot — never the mutable caller object.
 * Invalid input throws `invalidInput` before any database access.
 */
export function freezeCompositionInput(input: CompositionInputShape): FrozenCompositionInput {
  if (!input || typeof input !== 'object') {
    throw Errors.invalidInput('Execution composition input is missing');
  }
  const uuid = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw Errors.invalidInput(`Execution composition requires a valid ${field}`);
    }
    return value;
  };
  const nullableString = (value: unknown, field: string, maxLength: number): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
      throw Errors.invalidInput(`Execution composition received an invalid ${field}`);
    }
    return value;
  };
  const action = input.action;
  if (action !== undefined && action !== 'open_long' && action !== 'open_short' && action !== 'close_position') {
    throw Errors.invalidInput('Execution composition received an invalid action');
  }
  const riskDecisionId = input.riskDecisionId;
  if (riskDecisionId !== null && riskDecisionId !== undefined && (typeof riskDecisionId !== 'string' || !UUID_PATTERN.test(riskDecisionId))) {
    throw Errors.invalidInput('Execution composition received an invalid riskDecisionId');
  }
  const nowMs = input.nowMs ?? Date.now();
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || !(nowMs > 0)) {
    throw Errors.invalidInput('Execution composition received an invalid nowMs');
  }
  return Object.freeze({
    userId: uuid(input.userId, 'userId'),
    executionProfileId: uuid(input.executionProfileId, 'executionProfileId'),
    setupId: uuid(input.setupId, 'setupId'),
    action,
    riskDecisionId: riskDecisionId ?? null,
    ip: nullableString(input.ip, 'ip', 128),
    userAgent: nullableString(input.userAgent, 'userAgent', 512),
    nowMs,
  });
}

/**
 * H2 — detect caller mutation after an `await`.
 *
 * The composition calls this after every awaited stage that precedes a
 * trust decision. If the caller mutated the original input object while the
 * composition was awaiting (ownership for A, then the object switched to
 * B), the submission is rejected here rather than allowed to combine
 * A-owned and B-owned state. Legitimate callers never mutate, so this is a
 * no-op for every honest flow.
 */
export function assertCompositionInputUnchanged(
  live: CompositionInputShape,
  snapshot: FrozenCompositionInput,
): void {
  const drifted =
    !live ||
    typeof live !== 'object' ||
    live.userId !== snapshot.userId ||
    live.executionProfileId !== snapshot.executionProfileId ||
    live.setupId !== snapshot.setupId ||
    (live.action ?? undefined) !== snapshot.action ||
    (live.riskDecisionId ?? null) !== snapshot.riskDecisionId ||
    (live.nowMs ?? snapshot.nowMs) !== snapshot.nowMs;
  if (drifted) {
    throw Errors.invalidInput('Execution composition input changed during evaluation; refusing to mix execution contexts');
  }
}

/* -------------------------------------------------------------------------- */
/* H3 — authoritative broker-account authorization                             */
/* -------------------------------------------------------------------------- */

export interface BrokerAccountGrantInput {
  providerSlug: string;
  environment: string;
}

/**
 * H3 — authoritative broker-account authorization.
 *
 * The platform was audited for an authoritative grant/binding between
 * tenant/user/profile, provider, environment, broker account, and server:
 * none exists. `execution_profiles.account_ref` / `broker_server` are
 * user-editable labels (`updateBrokerProfile`), `testBrokerProfile` persists
 * no verified handshake, and no code path ever records a server-verified
 * broker-account grant — so editable metadata matching the operator's
 * `describe()` configuration is NOT proof of authorization, and no fake
 * grant mechanism is invented here.
 *
 * Fail-closed rule:
 *  - the internal paper simulator (`paper`/`paper`) involves no broker
 *    account at all and is authorized by construction;
 *  - every other provider/environment is NOT authorized.
 *
 * A future milestone that introduces a server-verified broker handshake
 * (credential verification, account ownership proof) is the only thing that
 * may extend this function. Until then the broker composition path cannot
 * pass the `broker_authorized` / `account_authorized` gates.
 */
export function resolveBrokerAccountAuthorization(
  input: BrokerAccountGrantInput,
): { brokerAuthorized: boolean; accountAuthorized: boolean } {
  if (input.providerSlug === 'paper' && input.environment === 'paper') {
    return { brokerAuthorized: true, accountAuthorized: true };
  }
  return { brokerAuthorized: false, accountAuthorized: false };
}

/* -------------------------------------------------------------------------- */
/* M3 — provider readiness semantics                                           */
/* -------------------------------------------------------------------------- */

export interface ProviderReadinessForGate {
  /**
   * The ONLY value projected into the `provider_healthy` gate input. It is
   * the authoritative decision (`ready`), not a coerced flag: `true` only
   * when the full record states every `providerHealth` condition explicitly.
   */
  readonly gateValue: { healthy: boolean };
  readonly ready: boolean;
  readonly code: string;
  readonly state: string | null;
  readonly evaluatedAt: string;
}

/**
 * M3 — evaluate the FULL provider health record with the single
 * authoritative readiness resolver before projecting anything into gates.
 *
 * The previous code reduced the record to `{ healthy }` first (and, in
 * intake, truthiness-coerced it with `Boolean(rawHealth.healthy)`), so an
 * apparently healthy-but-uncertain provider — `healthy: true` with
 * `available: false`, an uncertain state, or a malformed flag — could pass
 * `provider_healthy`. Here the whole record (availability flags,
 * uncertainty, state, readiness conditions) is resolved under the
 * `providerHealth` profile, and only the decision is projected. Gate 9
 * vocabulary is untouched: the gate still receives `{ healthy }`.
 */
export function evaluateProviderReadinessForGate(rawHealth: unknown): ProviderReadinessForGate {
  const { decision } = resolveExecutionReadiness(rawHealth, 'providerHealth');
  const state =
    typeof rawHealth === 'object' && rawHealth !== null && typeof (rawHealth as Record<string, unknown>).state === 'string'
      ? ((rawHealth as Record<string, unknown>).state as string)
      : null;
  return {
    gateValue: { healthy: decision.ready },
    ready: decision.ready,
    code: decision.code,
    state,
    evaluatedAt: decision.evaluatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* H4 — authoritative risk/exposure handoff                                    */
/* -------------------------------------------------------------------------- */

export interface LiveRiskReservation {
  readonly id: string;
  /** Decimal-string exposure copy, exactly as stored (numeric(24,10)). */
  readonly monetaryRisk: string;
  readonly expiresAt: Date;
}

export interface Gate9RiskHandoff {
  readonly riskDecisionId: string;
  readonly riskReservationId: string;
  readonly monetaryRisk: string;
  readonly riskExpiresAt: Date;
}

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/**
 * H4 — build the Gate 9 risk handoff from the live risk reservation.
 *
 * Fails closed unless a positive decimal exposure is represented: an
 * approval without a live reservation, with a zero/non-numeric exposure, or
 * with an expired reservation can never reach Gate 9 (and specifically can
 * never reach it as `monetaryRisk: '0'`). The caller must hold the
 * reservation until the Gate 9 intent durably takes ownership, and must
 * release it exactly once the intent (accepted, rejected, or uncertain) or
 * the attempt outcome is durable — see the composition submit paths.
 */
export function toGate9RiskHandoff(input: {
  riskDecisionId: string;
  reservation: LiveRiskReservation | null;
  nowMs: number;
}): Gate9RiskHandoff {
  const reservation = input.reservation;
  if (!reservation) {
    throw Errors.invalidInput('Risk reservation is not available for the Gate 9 handoff; refusing to submit unaccounted exposure');
  }
  if (typeof reservation.id !== 'string' || reservation.id.length === 0) {
    throw Errors.invalidInput('Risk reservation identity is missing for the Gate 9 handoff');
  }
  if (
    typeof reservation.monetaryRisk !== 'string' ||
    !DECIMAL_PATTERN.test(reservation.monetaryRisk) ||
    !(Number(reservation.monetaryRisk) > 0)
  ) {
    throw Errors.invalidInput('Approved risk exposure is not a positive decimal amount; refusing to submit it as zero');
  }
  const expiresMs = reservation.expiresAt instanceof Date ? reservation.expiresAt.getTime() : NaN;
  if (!Number.isFinite(expiresMs) || expiresMs <= input.nowMs) {
    throw Errors.invalidInput('Risk reservation has expired; refusing to submit on lapsed exposure cover');
  }
  return {
    riskDecisionId: input.riskDecisionId,
    riskReservationId: reservation.id,
    monetaryRisk: reservation.monetaryRisk,
    riskExpiresAt: reservation.expiresAt,
  };
}

/* -------------------------------------------------------------------------- */
/* M5 — canonical outcome mapping                                              */
/* -------------------------------------------------------------------------- */

export type BrokerSubmitDisposition =
  | 'submitted_accepted'
  | 'submitted_rejected'
  | 'duplicate_accepted'
  | 'duplicate_rejected'
  | 'uncertain'
  | 'unresolved_duplicate'
  | 'refused';

export interface MappedBrokerSubmitOutcome {
  readonly accepted: boolean;
  readonly replayed: boolean;
  readonly disposition: BrokerSubmitDisposition;
}

/**
 * M5 — map the canonical Gate 9 boundary result onto composition outcome
 * flags. Pure and total over the closed `CanonicalSubmitResult` vocabulary:
 *
 *  - provider accepted            → accepted, not a replay
 *  - provider rejected            → NOT accepted (never projected as accepted)
 *  - duplicate onto confirmed     → accepted AND replayed
 *  - duplicate onto rejected      → rejected AND replayed
 *  - provider uncertain           → NOT accepted, uncertainty preserved
 *  - duplicate onto unresolved    → NOT accepted, replayed, unresolved
 *  - pre-call refusal             → NOT accepted (no provider call happened)
 */
export function mapBrokerSubmitOutcome(outcome: CanonicalSubmitResult): MappedBrokerSubmitOutcome {
  if (outcome.status === 'ok') {
    const accepted = outcome.providerOutcome.status === 'accepted';
    if (outcome.kind === 'duplicate') {
      return {
        accepted,
        replayed: true,
        disposition: accepted ? 'duplicate_accepted' : 'duplicate_rejected',
      };
    }
    return {
      accepted,
      replayed: false,
      disposition: accepted ? 'submitted_accepted' : 'submitted_rejected',
    };
  }
  switch (outcome.kind) {
    case 'provider_uncertain':
      return { accepted: false, replayed: false, disposition: 'uncertain' };
    case 'duplicate_unresolved':
      return { accepted: false, replayed: true, disposition: 'unresolved_duplicate' };
    default:
      return { accepted: false, replayed: false, disposition: 'refused' };
  }
}

/* -------------------------------------------------------------------------- */
/* H5 — final safety/authorization fence                                       */
/* -------------------------------------------------------------------------- */

/** Minimal structural dependencies, satisfied by the real services and by test doubles. */
export interface FinalFenceDeps {
  pool: Pick<pg.Pool, 'query'>;
  automation: {
    readState(userId: string): Promise<{ entitlements: { canAccessAutomation: boolean }; automationEnabled: boolean }>;
  };
  killSwitches: {
    anyActive(args: { userId: string; strategyId?: string | null; executionProfileId?: string | null }): Promise<{ active: boolean }>;
  };
  authorization: {
    peekAuthorization(authorizationId: string): ExecutionAuthorization | null;
  };
  risk: {
    getActiveReservation(args: {
      riskDecisionId: string;
      executionProfileId: string;
      nowMs?: number;
    }): Promise<{ id: string } | null>;
  };
}

export interface FinalFenceInput {
  readonly userId: string;
  readonly executionProfileId: string;
  readonly strategyId: string;
  readonly setupId: string | null;
  readonly providerSlug: string;
  readonly environment: 'paper' | 'demo';
  readonly accountRef: string | null;
  readonly brokerServerRef: string | null;
  readonly riskDecisionId: string;
  readonly authorizationId: string;
  readonly nowMs: number;
}

export type FinalFenceFailCode =
  | 'profile_disabled'
  | 'automation_revoked'
  | 'entitlement_revoked'
  | 'kill_switch_active'
  | 'authorization_revoked'
  | 'risk_reservation_lapsed';

export type FinalFenceResult =
  | { ok: true }
  | { ok: false; code: FinalFenceFailCode; failedGate: ExecutionGateId; reason: string };

/**
 * H5 — the race-safe final authorization/safety linearization point.
 *
 * Runs with FRESH reads immediately before the authoritative submission
 * boundary (Gate 9 for broker, the paper fill for paper). A stop, profile
 * disablement, automation disablement, entitlement revocation, authorization
 * revocation/expiry, or risk-reservation lapse that lands after the early
 * gate reads is caught here and fails closed — no provider submission is
 * made. Gate 9 itself is untouched: this fence sits strictly before it.
 *
 * The fence never trusts the early snapshot for safety state: profile,
 * automation/entitlements, kill switches, authorization liveness + exact
 * context binding (H1, via peek + compare — no consumption), and risk
 * reservation liveness are all re-read. It does not throw for safety
 * failures (it returns them); infrastructure errors propagate so the caller
 * can fail closed loudly without claiming acceptance.
 */
export async function runFinalSafetyFence(
  deps: FinalFenceDeps,
  input: FinalFenceInput,
): Promise<FinalFenceResult> {
  // 1. Profile — fresh owner-scoped read. Disabled or vanished ⇒ refuse.
  const profileRes = await deps.pool.query<{ id: string; enabled: boolean }>(
    `SELECT id, enabled FROM execution_profiles WHERE id = $1 AND user_id = $2`,
    [input.executionProfileId, input.userId],
  );
  const profile = profileRes.rows[0];
  if (!profile || profile.enabled !== true) {
    return {
      ok: false,
      code: 'profile_disabled',
      failedGate: 'profile_enabled',
      reason: 'execution profile is disabled or no longer available',
    };
  }

  // 2. Automation + entitlements — fresh read. Either revoked ⇒ refuse.
  let automationState: { entitlements: { canAccessAutomation: boolean }; automationEnabled: boolean };
  try {
    automationState = await deps.automation.readState(input.userId);
  } catch {
    return {
      ok: false,
      code: 'automation_revoked',
      failedGate: 'automation_on',
      reason: 'automation state is unavailable at the final safety fence',
    };
  }
  if (!automationState.entitlements.canAccessAutomation) {
    return {
      ok: false,
      code: 'entitlement_revoked',
      failedGate: 'entitlement',
      reason: 'automation entitlement was revoked before submission',
    };
  }
  if (!automationState.automationEnabled) {
    return {
      ok: false,
      code: 'automation_revoked',
      failedGate: 'automation_on',
      reason: 'automation was disabled before submission',
    };
  }

  // 3. Kill switches — fresh read across scopes. Any active ⇒ refuse.
  const kill = await deps.killSwitches.anyActive({
    userId: input.userId,
    strategyId: input.strategyId,
    executionProfileId: input.executionProfileId,
  });
  if (kill.active) {
    return {
      ok: false,
      code: 'kill_switch_active',
      failedGate: 'kill_switch',
      reason: 'a kill switch was activated before submission',
    };
  }

  // 4. Authorization — liveness plus H1 exact context binding, verified
  // without consuming (consumption happens exactly once, at submit).
  const expectedContext: AuthorizationExecutionContext = {
    userId: input.userId,
    executionProfileId: input.executionProfileId,
    providerSlug: input.providerSlug,
    environment: input.environment,
    accountRef: input.accountRef,
    brokerServerRef: input.brokerServerRef,
    setupId: input.setupId,
    riskDecisionId: input.riskDecisionId,
  };
  const live = deps.authorization.peekAuthorization(input.authorizationId);
  if (!live) {
    return {
      ok: false,
      code: 'authorization_revoked',
      failedGate: 'authorized',
      reason: 'execution authorization was revoked or expired before submission',
    };
  }
  try {
    assertAuthorizationContext(live, expectedContext);
  } catch {
    return {
      ok: false,
      code: 'authorization_revoked',
      failedGate: 'authorized',
      reason: 'execution authorization does not match the submission context',
    };
  }

  // 5. Risk reservation — must still be live. The reservation is the
  // exposure cover that the durable handoff (Gate 9 intent / paper
  // position) is about to take over; a lapsed reservation ⇒ refuse.
  const reservation = await deps.risk.getActiveReservation({
    riskDecisionId: input.riskDecisionId,
    executionProfileId: input.executionProfileId,
    nowMs: input.nowMs,
  });
  if (!reservation) {
    return {
      ok: false,
      code: 'risk_reservation_lapsed',
      failedGate: 'risk_decision',
      reason: 'risk reservation lapsed before submission',
    };
  }

  return { ok: true };
}

/**
 * Build the exact request object the authorization binds, for consumers
 * that verify-then-consume (paper handoff). Pure structural helper so the
 * composition and the paper service construct byte-identical bindings.
 */
export function toAuthorizationRequestBinding(input: {
  clientOrderId: string;
  idempotencyKey: string;
  authorizationId: string;
  assetClass: ExecutionSubmitOrderRequest['assetClass'];
  symbol: string;
  side: 'buy' | 'sell';
  orderType: ExecutionSubmitOrderRequest['orderType'];
  quantity: number;
  requestedPrice: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
}): ExecutionSubmitOrderRequest {
  return {
    clientOrderId: input.clientOrderId,
    idempotencyKey: input.idempotencyKey,
    authorizationId: input.authorizationId,
    assetClass: input.assetClass,
    symbol: input.symbol,
    side: input.side,
    orderType: input.orderType,
    quantity: input.quantity,
    requestedPrice: input.requestedPrice,
    stopLossPrice: input.stopLossPrice,
    takeProfitPrice: input.takeProfitPrice,
  };
}
