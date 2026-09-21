/**
 * B1 — authorization/composition layer.
 *
 * The single authoritative execution composition that sits between caller
 * identifiers and the canonical submit boundaries (Gate 9 for broker,
 * the paper fill for paper).
 *
 * ```text
 * identifiers (user, profile, setup) + optional action
 *   ↓  H2: validate + freeze immutable snapshot (before any await)
 * owner-scoped profile + setup loads (masked 404s)
 *   ↓  M2/H6: server-built decision via the established validated path
 * idempotency derivation (identity of the ACTUAL action)
 *   ↓  M5: replay pre-check — resolved duplicates return before any
 *          risk/authorization/persistence/submission work
 * fresh gate inputs (automation, kill-switches, risk approval, full-record
 * provider readiness via the authoritative resolver, H3 grant fail-closed
 * for broker, environment safety, universe membership)
 *   ↓  18 gates, pinned order, fail-closed
 * execution_requests persistence (M4: only recognized identity conflicts
 * recover, and only onto a verified existing row)
 *   ↓  B1 authorization mint (one-shot, TTL-bound, full-context binding)
 * H5 final safety fence (fresh re-reads immediately before submit)
 *   ↓
 * paper  → PaperExecutionService.executeComposedEntry (M6: the B1
 *           authorization is consumed by the handoff; no second authority,
 *           no stranded reservation, Gate 9 untouched)
 * broker → submitOrderThroughGate9 (H4: live reservation + positive decimal
 *           exposure handed over; H1: expected context armed one-shot)
 *   ↓  M5: canonical outcome mapping (accepted/rejected/uncertain/duplicate)
 * ```
 *
 * This module never creates a second submit path, never enables live, never
 * stores credentials, never bypasses Gate 9, and never invents provenance.
 * It composes existing services: automation, kill-switches, risk, provider
 * registry, readiness resolver, authorization, Gate 9 ledger, B2 boundary,
 * and the paper simulator.
 *
 * B1 remediation map: H1 (context-bound consumption + one-shot handoff),
 * H2 (immutable snapshot + mutation detection), H3 (broker fail-closed, no
 * fake grant), H4 (live reservation + positive exposure handoff, release
 * only into durable ownership or abandonment), H5 (final fence), H6 (action
 * integrity via the validated decision path), M1 (immutable auth records),
 * M2 (real provenance), M3 (full-record readiness), M4 (fail-closed
 * persistence), M5 (canonical outcomes + replay pre-check), M6 (paper
 * handoff), M7 (production-seam coverage in tests).
 */

import type pg from 'pg';
import {
  EXECUTION_ARCHITECTURE_VERSION,
  type ExecutionDecisionInput,
  type ExecutionGateId,
} from '@veltrixeye/contracts';
import { deriveClientOrderId, executionIdempotencyHash as executionIdempotencyHashFn } from './intake.js';
import { buildServerExecutionDecision } from './paper-engine.js';
import { evaluateExecutionGates, type ExecutionGateInput, type ExecutionGateResult } from './gates.js';
import type { ExecutionProviderRegistry } from './registry.js';
import type { AutomationService } from './automation.js';
import type { KillSwitchService } from './kill-switch.js';
import type { RiskEngineService } from '../risk/service.js';
import type { AuditService } from '../audit.js';
import type {
  MutationExecutionResult,
  ProviderIntentRecord,
  ProviderMutationLedger,
} from './provider-mutations.js';
import type {
  AuthorizationContextHandoff,
  AuthorizationExecutionContext,
  ExecutionAuthorizationService,
} from './authorization.js';
import {
  assertCompositionInputUnchanged,
  evaluateProviderReadinessForGate,
  freezeCompositionInput,
  mapBrokerSubmitOutcome,
  resolveBrokerAccountAuthorization,
  runFinalSafetyFence,
  toAuthorizationRequestBinding,
  toGate9RiskHandoff,
} from './composition-fence.js';
import type {
  ComposedPaperEntryIdentity,
  ComposedPaperEntryResult,
  PaperExecutionService,
} from './paper-service.js';
import {
  submitOrderThroughGate9,
  type SubmitBarrierHandoff,
  type CanonicalSubmitResult,
} from './submit-boundary.js';
import { Errors } from '../errors.js';

export interface CompositionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const SILENT_LOGGER: CompositionLogger = { info: () => {}, warn: () => {} };

export interface ExecutionCompositionInput {
  userId: string;
  executionProfileId: string;
  setupId: string;
  /**
   * Optional: restate the authoritative direction-derived action. Any other
   * value — including the cross-direction open and `close_position` — is
   * rejected: this opening-order path never invents or switches actions.
   */
  action?: 'open_long' | 'open_short' | 'close_position';
  /**
   * Caller-supplied riskDecisionId for validation (optional). The composition
   * never trusts it: risk is always freshly evaluated, and a supplied id that
   * does not match the fresh evaluation's decision is rejected.
   */
  riskDecisionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  nowMs?: number;
}

export interface ExecutionCompositionResult {
  accepted: boolean;
  replayed: boolean;
  gate: ExecutionGateResult;
  authorizationId: string | null;
  clientOrderId: string | null;
  idempotencyKey: string | null;
  /** Broker path only: the canonical Gate 9 boundary outcome. */
  providerOutcome: CanonicalSubmitResult | null;
  /** Paper path only: the composed paper fill outcome (never a Gate 9 shape). */
  paperOutcome: ComposedPaperEntryResult | null;
  riskDecisionId: string | null;
  requestId: string | null;
}

interface SetupProvenanceRow {
  setup_id: string;
  state: string;
  direction: 'long' | 'short';
  as_of_ms: string;
  entry_price: string | null;
  stop_loss_price: string | null;
  tp1_price: string | null;
  quality_score: number | null;
  strategy_version_id: string;
  strategy_id: string;
  strategy_owner: string;
  instrument_id: string;
  asset_class: string;
  symbol: string;
  min_quality_score: number | null;
  setup_timeframe: string | null;
  entry_timeframe: string | null;
}

interface ProfileRow {
  id: string;
  enabled: boolean;
  environment: string;
  provider_slug: string;
  account_ref: string | null;
  broker_server: string | null;
}

export class ExecutionCompositionService {
  private readonly logger: CompositionLogger;

  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: {
      automation: AutomationService;
      killSwitches: KillSwitchService;
      providers: ExecutionProviderRegistry;
      risk: RiskEngineService;
      audit: AuditService;
      providerMutations: ProviderMutationLedger;
      submitHandoff: SubmitBarrierHandoff;
      authorization: ExecutionAuthorizationService;
      /** H1 — one-shot expected-context handoff for the broker provider. */
      authHandoff: AuthorizationContextHandoff;
      /** M6 — the paper simulator for the composed paper path. */
      paper: PaperExecutionService;
    },
    options?: { logger?: CompositionLogger },
  ) {
    this.logger = options?.logger ?? SILENT_LOGGER;
  }

  /**
   * The B1 composition entry point: from identifiers to submit.
   *
   * Fail-closed throughout: invalid input throws before any state access; a
   * caller mutation mid-flight throws rather than mixing contexts; missing
   * or foreign resources are masked 404s; gate failures release the risk
   * hold and return rejections; persistence failures stop before submit;
   * fence failures revoke the authorization and release the hold; provider
   * outcomes are mapped canonically and never projected as accepted unless
   * the provider verifiably accepted.
   */
  async composeAndSubmit(input: ExecutionCompositionInput): Promise<ExecutionCompositionResult> {
    // H2.1 — validate caller input and snapshot the authoritative
    // identity/context BEFORE any await. Everything below uses `snap`.
    const snap = freezeCompositionInput(input);
    const nowMs = snap.nowMs;
    const checkUnchanged = (): void => assertCompositionInputUnchanged(input, snap);

    // 1. Profile — owner-scoped masked 404.
    const profileRes = await this.pool.query<ProfileRow>(
      `SELECT id, enabled, environment, provider_slug, account_ref, broker_server
       FROM execution_profiles WHERE id = $1 AND user_id = $2`,
      [snap.executionProfileId, snap.userId],
    );
    checkUnchanged();
    const profile = profileRes.rows[0];
    if (!profile) throw Errors.notFound('Execution profile not found');
    const isPaper = profile.provider_slug === 'paper';

    // 2. Setup provenance — owner-scoped masked 404, with the full row the
    // server-built decision needs (levels, quality, risk config, timeframes).
    const setupRes = await this.pool.query<SetupProvenanceRow>(
      `SELECT st.id AS setup_id, st.state, st.direction, st.as_of_ms,
              st.entry_price, st.stop_loss_price, st.tp1_price, st.quality_score,
              st.strategy_version_id, v.strategy_id, s.user_id AS strategy_owner,
              i.id AS instrument_id, i.asset_class, i.symbol,
              rc.min_quality_score,
              (SELECT tf.timeframe FROM strategy_timeframes tf
                WHERE tf.version_id = st.strategy_version_id AND tf.role = 'setup' LIMIT 1) AS setup_timeframe,
              (SELECT tf.timeframe FROM strategy_timeframes tf
                WHERE tf.version_id = st.strategy_version_id AND tf.role = 'entry' LIMIT 1) AS entry_timeframe
       FROM setups st
       JOIN strategy_versions v ON v.id = st.strategy_version_id
       JOIN strategies s ON s.id = v.strategy_id
       JOIN instruments i ON i.id = st.instrument_id
       LEFT JOIN strategy_risk_config rc ON rc.version_id = st.strategy_version_id
       WHERE st.id = $1`,
      [snap.setupId],
    );
    checkUnchanged();
    const setup = setupRes.rows[0];
    if (!setup || setup.strategy_owner !== snap.userId) throw Errors.notFound('Setup not found');

    // 3. Server-built decision (M2: the established validated path — real
    // provenance or fail-closed; H6: action integrity).
    if (snap.action === 'close_position') {
      return this.rejectDecision(
        snap, profile, setup,
        'close_position is not supported by this opening-order composition path',
        nowMs,
      );
    }
    const built = buildServerExecutionDecision({
      setupId: setup.setup_id,
      strategyId: setup.strategy_id,
      strategyVersionId: setup.strategy_version_id,
      assetClass: setup.asset_class,
      symbol: setup.symbol,
      direction: setup.direction,
      state: setup.state,
      asOfMs: Number(setup.as_of_ms),
      entryPrice: numOrNull(setup.entry_price),
      stopLossPrice: numOrNull(setup.stop_loss_price),
      tp1Price: numOrNull(setup.tp1_price),
      qualityScore: setup.quality_score,
      minQualityScore: setup.min_quality_score,
      timeframe: setup.setup_timeframe ?? setup.entry_timeframe,
    });
    if (!built.ok) {
      return this.rejectDecision(snap, profile, setup, built.reason, nowMs);
    }
    const decision: ExecutionDecisionInput = built.decision;
    // H6 — the override may only restate the authoritative action derived
    // from the setup direction. A cross-direction open is rejected here,
    // before any persistence or submission. (The decision itself was built
    // by `buildServerExecutionDecision`, which enforces
    // `executionDecisionSchema`, so the action/direction coherence,
    // directional sanity, and RR achievability are already proven.)
    if (snap.action !== undefined && snap.action !== decision.action) {
      return this.rejectDecision(
        snap, profile, setup,
        `action "${snap.action}" conflicts with the setup direction "${setup.direction}"`,
        nowMs,
      );
    }

    // 4. Idempotency (H6: the identity of the ACTUAL submitted action).
    const idempotencyKey = executionIdempotencyHashFn({
      userId: snap.userId,
      setupId: setup.setup_id,
      executionProfileId: profile.id,
      action: decision.action,
    });
    const clientOrderId = deriveClientOrderId(idempotencyKey);

    // 5. Paper order identity derivation (M6, read-only). The B1 binding for
    // the paper path covers the exact paper identity, including the attempt
    // index for retries after failure. Also feeds the replay pre-check.
    let paperIdentity: ComposedPaperEntryIdentity | null = null;
    if (isPaper) {
      paperIdentity = await this.deps.paper.deriveComposedEntryIdentity({
        userId: snap.userId,
        executionProfileId: profile.id,
        setupId: setup.setup_id,
        baseHash: idempotencyKey,
      });
      checkUnchanged();
    }

    // 6. Replay pre-check (M5) — BEFORE risk, authorization, persistence,
    // and submission. Already-resolved duplicates return here without
    // allocating any of that work.
    const replay = await this.checkReplay({
      snap, profile, setup, decision, idempotencyKey, clientOrderId, paperIdentity, nowMs,
    });
    checkUnchanged();
    if (replay) return replay;

    // 7. Fresh gate inputs. Risk is evaluated first: its verdict feeds the
    // gates, and an approval holds a reservation until the durable handoff.
    const automationState = await this.deps.automation.readState(snap.userId);
    checkUnchanged();
    const killSwitches = await this.deps.killSwitches.anyActive({
      userId: snap.userId,
      strategyId: setup.strategy_id,
      executionProfileId: profile.id,
    });
    checkUnchanged();
    const provider = this.deps.providers.get(profile.provider_slug);
    const rawHealth = provider ? await provider.health().catch(() => null) : null;
    checkUnchanged();
    // M3 — the FULL record goes through the authoritative resolver; only the
    // decision is projected into the gate input (Gate 9 vocabulary kept).
    const readiness = evaluateProviderReadinessForGate(rawHealth);

    // Risk engine — ONLY source of approval. Never the caller-supplied id:
    // a supplied riskDecisionId that disagrees with the fresh evaluation is
    // rejected below (the composition never executes on a foreign verdict).
    const risk = await this.deps.risk.evaluate({
      userId: snap.userId,
      executionProfileId: profile.id,
      decision,
      reserveOnApprove: true,
    });
    checkUnchanged();
    if (snap.riskDecisionId !== null && snap.riskDecisionId !== risk.id) {
      await this.deps.risk.releaseReservation(risk.id);
      const gate: ExecutionGateResult = {
        passed: false,
        failedGate: 'risk_decision',
        reason: 'supplied risk decision does not match the fresh risk evaluation',
        evaluated: ['authenticated', 'authorized', 'entitlement', 'automation_on', 'profile_enabled', 'kill_switch', 'valid_signal', 'risk_decision'],
      };
      await this.auditRejection({ snap, profileId: profile.id, setupId: setup.setup_id, gate, riskDecisionId: risk.id });
      return {
        accepted: false, replayed: false, gate,
        authorizationId: null, clientOrderId, idempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: risk.id, requestId: null,
      };
    }

    // H3 — authoritative broker-account authorization. No grant mechanism
    // exists, so broker paths fail closed here; editable profile metadata
    // is never consulted (the resolver does not even accept it).
    const grant = resolveBrokerAccountAuthorization({
      providerSlug: profile.provider_slug,
      environment: profile.environment,
    });

    // Environment safety: live never passes. Paper/demo are the only values
    // that can reach the gates; the profile gate enforces the same rule.
    const environmentSafe = profile.environment === 'paper' || profile.environment === 'demo';

    // Instrument known — platform universe membership (not provider).
    const instrumentKnownRes = await this.pool.query<{ id: string }>(
      `SELECT id FROM instruments WHERE id = $1`,
      [setup.instrument_id],
    );
    checkUnchanged();
    const instrumentKnown = instrumentKnownRes.rows.length === 1;

    const gateInput: ExecutionGateInput = {
      authenticated: true,
      authorized: true,
      entitlements: automationState.entitlements,
      automation: {
        entitled: automationState.entitlements.canAccessAutomation,
        automationEnabled: automationState.automationEnabled,
      },
      profile: { enabled: profile.enabled, environment: profile.environment as 'paper' | 'demo' | 'live' },
      killSwitches: {
        global: killSwitches.global,
        user: killSwitches.user,
        strategy: killSwitches.strategy,
        profile: killSwitches.profile,
      },
      decision,
      setup: { id: setup.setup_id, direction: setup.direction, state: setup.state },
      instrumentKnown,
      riskDecision: {
        approved: risk.outcome === 'approved',
        reason: risk.reason,
        decisionId: risk.id,
        engineVersion: risk.engineVersion,
      },
      minRr: risk.effectiveMinRr,
      exposureWithinLimits: risk.exposureWithinLimits,
      providerHealth: readiness.gateValue,
      environmentSafe,
      brokerAuthorized: grant.brokerAuthorized,
      accountAuthorized: grant.accountAuthorized,
    };

    const gate = evaluateExecutionGates(gateInput);

    if (!gate.passed) {
      // The attempt is abandoned with zero exposure: nothing was submitted
      // and no durable representation exists, so the hold is released (H4).
      await this.deps.risk.releaseReservation(risk.id);
      await this.auditRejection({
        snap, profileId: profile.id, setupId: setup.setup_id, gate, riskDecisionId: risk.id,
        extra: { readinessCode: readiness.code, providerState: readiness.state },
      });
      return {
        accepted: false, replayed: false, gate,
        authorizationId: null, clientOrderId, idempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: risk.id, requestId: null,
      };
    }

    // Defense in depth (the profile gate already proved this): only paper or
    // demo may proceed past this point, ever.
    if (profile.environment !== 'paper' && profile.environment !== 'demo') {
      await this.deps.risk.releaseReservation(risk.id);
      throw Errors.internal('Execution composition reached submission for a forbidden environment');
    }
    const environment = profile.environment;

    // 8. Persist the execution request (M4: fail-closed — only a recognized
    // identity conflict recovers, and only onto a verified existing row;
    // every other persistence error stops before submit without acceptance).
    let requestId: string | null = null;
    try {
      const inserted = await this.pool.query<{ id: string }>(
        `INSERT INTO execution_requests
           (user_id, execution_profile_id, setup_id, action, status, decision, idempotency_key, architecture_version)
         VALUES ($1,$2,$3,$4,'requested',$5,$6,$7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          snap.userId,
          profile.id,
          setup.setup_id,
          decision.action,
          JSON.stringify(decision),
          idempotencyKey,
          EXECUTION_ARCHITECTURE_VERSION,
        ],
      );
      checkUnchanged();
      if (inserted.rows[0]) {
        requestId = inserted.rows[0].id;
      }
    } catch (err) {
      if (!isUniqueViolation(err)) {
        await this.deps.risk.releaseReservation(risk.id);
        throw err;
      }
    }
    checkUnchanged();
    if (requestId === null) {
      // Either ON CONFLICT DO NOTHING swallowed a conflict row, or the
      // insert threw a recognized identity conflict (23505): recover ONLY
      // onto a verified same-user row. This runs OUTSIDE the try so a
      // failed resolution releases the reservation exactly once (inside
      // resolveRequestRowOrFail) instead of twice.
      requestId = await this.resolveRequestRowOrFail(snap, idempotencyKey, risk.id);
    }
    checkUnchanged();

    // 9. Quantity backstop: the approval must carry a usable size. (The risk
    // engine sizes every open approval; this guards the submit binding.)
    const quantity = risk.positionSize;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || !(quantity > 0)) {
      await this.deps.risk.releaseReservation(risk.id);
      const failGate: ExecutionGateResult = {
        passed: false,
        failedGate: 'risk_decision',
        reason: 'approved risk decision carries no usable position size',
        evaluated: gate.evaluated,
      };
      await this.auditRejection({ snap, profileId: profile.id, setupId: setup.setup_id, gate: failGate, riskDecisionId: risk.id, requestId });
      return {
        accepted: false, replayed: false, gate: failGate,
        authorizationId: null, clientOrderId, idempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: risk.id, requestId,
      };
    }

    // 10. Mint the one-shot B1 authorization (H1: full immutable execution
    // context from the authoritative snapshot + profile row; M1: validated,
    // frozen). Paper binds the derived paper identity; broker binds the
    // canonical mutation identity.
    const submitClientOrderId = isPaper && paperIdentity ? paperIdentity.clientOrderId : clientOrderId;
    const submitIdempotencyKey = isPaper && paperIdentity ? paperIdentity.orderIdempotencyKey : idempotencyKey;
    const side = decision.direction === 'long' ? 'buy' : 'sell';
    const authContext: AuthorizationExecutionContext = {
      userId: snap.userId,
      executionProfileId: profile.id,
      providerSlug: profile.provider_slug,
      environment,
      accountRef: profile.account_ref ?? null,
      brokerServerRef: profile.broker_server ?? null,
      setupId: setup.setup_id,
      riskDecisionId: risk.id,
    };
    let authorizationId: string;
    try {
      const auth = this.deps.authorization.createAuthorization({
        userId: snap.userId,
        executionProfileId: profile.id,
        clientOrderId: submitClientOrderId,
        idempotencyKey: submitIdempotencyKey,
        symbol: decision.symbol,
        side,
        quantity,
        assetClass: decision.assetClass,
        orderType: 'market',
        stopLossPrice: decision.stopLossPrice,
        takeProfitPrice: decision.takeProfitPrice,
        requestedPrice: null,
        providerSlug: profile.provider_slug,
        environment,
        accountRef: profile.account_ref,
        brokerServerRef: profile.broker_server,
        riskDecisionId: risk.id,
        setupId: setup.setup_id,
      });
      authorizationId = auth.id;
    } catch (err) {
      await this.deps.risk.releaseReservation(risk.id);
      throw err;
    }

    // 11. Final safety fence (H5) — fresh re-reads immediately before the
    // authoritative submission boundary. Never the early snapshot alone.
    let fence: Awaited<ReturnType<typeof runFinalSafetyFence>>;
    try {
      fence = await runFinalSafetyFence(
        {
          pool: this.pool,
          automation: this.deps.automation,
          killSwitches: this.deps.killSwitches,
          authorization: this.deps.authorization,
          risk: this.deps.risk,
        },
        {
          userId: snap.userId,
          executionProfileId: profile.id,
          strategyId: setup.strategy_id,
          setupId: setup.setup_id,
          providerSlug: profile.provider_slug,
          environment,
          accountRef: profile.account_ref ?? null,
          brokerServerRef: profile.broker_server ?? null,
          riskDecisionId: risk.id,
          authorizationId,
          nowMs,
        },
      );
    } catch (err) {
      this.deps.authorization.revokeAuthorization(authorizationId);
      await this.deps.risk.releaseReservation(risk.id);
      throw err;
    }
    if (!fence.ok) {
      // Fail closed: no provider submission. The minted authorization is
      // revoked (never stranded) and the risk hold released (H4: the attempt
      // is abandoned with zero exposure).
      this.deps.authorization.revokeAuthorization(authorizationId);
      await this.deps.risk.releaseReservation(risk.id);
      const failGate: ExecutionGateResult = {
        passed: false,
        failedGate: fence.failedGate,
        reason: fence.reason,
        evaluated: gate.evaluated,
      };
      await this.auditRejection({ snap, profileId: profile.id, setupId: setup.setup_id, gate: failGate, riskDecisionId: risk.id, requestId, authorizationId });
      return {
        accepted: false, replayed: false, gate: failGate,
        authorizationId, clientOrderId: submitClientOrderId, idempotencyKey: submitIdempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: risk.id, requestId,
      };
    }

    // 12. Submit. No await stands between the fence and the submit call
    // other than the submit itself — this is the linearization point.
    if (isPaper) {
      if (!paperIdentity) throw Errors.internal('Paper identity was not derived for a paper submission');
      return this.submitPaper({
        snap, profile, setup, decision, gate, riskId: risk.id,
        exposureWithinLimits: risk.exposureWithinLimits, effectiveMinRr: risk.effectiveMinRr,
        quantity, authorizationId, authContext, paperIdentity,
        idempotencyKey, clientOrderId, requestId, nowMs,
      });
    }
    return this.submitBroker({
      snap, profile, setup, decision, gate, riskId: risk.id,
      quantity, side, authorizationId, authContext,
      idempotencyKey, clientOrderId, requestId, nowMs, environment,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* replay pre-check (M5)                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * M5 — return an already-resolved duplicate before any risk,
   * authorization, persistence, or submission work is allocated.
   *
   * Paper: a live paper order for this identity (from an earlier composed
   * attempt, or from the direct simulate flow) replays as accepted.
   * Broker: a durable Gate 9 intent for this identity replays its resolved
   * outcome (accepted/rejected) or its honest unresolved state — read-only,
   * no provider call, no new exposure. Anything else proceeds (a request row
   * without durable execution means the prior attempt never submitted).
   */
  private async checkReplay(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profile: ProfileRow;
    setup: SetupProvenanceRow;
    decision: ExecutionDecisionInput;
    idempotencyKey: string;
    clientOrderId: string;
    paperIdentity: ComposedPaperEntryIdentity | null;
    nowMs: number;
  }): Promise<ExecutionCompositionResult | null> {
    const { snap, profile, idempotencyKey, clientOrderId, paperIdentity } = args;
    const isPaper = profile.provider_slug === 'paper';

    const requestRes = await this.pool.query<{ id: string; user_id: string; status: string }>(
      `SELECT id, user_id, status FROM execution_requests WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const requestRow = requestRes.rows[0] ?? null;
    if (requestRow && requestRow.user_id !== snap.userId) {
      // Identity anomaly (the key binds the user): fail closed, masked.
      this.logger.warn('execution identity anomaly: request row owned by another user', {
        executionProfileId: profile.id,
      });
      const gate: ExecutionGateResult = {
        passed: false,
        failedGate: 'authorized',
        reason: 'execution identity does not belong to the caller',
        evaluated: ['authenticated', 'authorized'],
      };
      await this.auditRejection({ snap, profileId: profile.id, setupId: args.setup.setup_id, gate, riskDecisionId: null });
      return {
        accepted: false, replayed: false, gate,
        authorizationId: null, clientOrderId, idempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: null, requestId: null,
      };
    }

    if (isPaper) {
      if (paperIdentity?.liveOrder) {
        // Resolved: the fill already exists durably. No risk, auth, Gate 9,
        // or second fill — report the existing execution.
        const paperOutcome: ComposedPaperEntryResult = {
          status: 'replayed',
          providerOrderId: paperIdentity.liveOrder.providerOrderId,
          orderId: paperIdentity.liveOrder.orderId,
          attempt: paperIdentity.attempt,
        };
        await this.auditReplay({ snap, profileId: profile.id, setupId: args.setup.setup_id, requestId: requestRow?.id ?? null, paperOutcome });
        return {
          accepted: true, replayed: true,
          gate: { passed: true, failedGate: null, reason: null, evaluated: [] },
          authorizationId: null,
          clientOrderId: paperIdentity.clientOrderId,
          idempotencyKey: paperIdentity.orderIdempotencyKey,
          providerOutcome: null, paperOutcome,
          riskDecisionId: null, requestId: requestRow?.id ?? null,
        };
      }
      return null;
    }

    // Broker: consult the durable ledger by mutation identity.
    const intent = await this.deps.providerMutations.resolveByIdentity({
      executionProfileId: profile.id,
      clientOrderId,
      idempotencyKey,
    });
    if (!intent) return null;
    if (intent.userId !== snap.userId || intent.executionProfileId !== profile.id) {
      this.logger.warn('execution identity anomaly: intent owned by another context', {
        executionProfileId: profile.id,
      });
      const gate: ExecutionGateResult = {
        passed: false,
        failedGate: 'authorized',
        reason: 'execution identity does not belong to the caller',
        evaluated: ['authenticated', 'authorized'],
      };
      await this.auditRejection({ snap, profileId: profile.id, setupId: args.setup.setup_id, gate, riskDecisionId: null });
      return {
        accepted: false, replayed: false, gate,
        authorizationId: null, clientOrderId, idempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: null, requestId: requestRow?.id ?? null,
      };
    }
    return this.replayBrokerIntent({ snap, profileId: profile.id, setupId: args.setup.setup_id, intent, clientOrderId, idempotencyKey, requestId: requestRow?.id ?? null });
  }

  /**
   * Project a durable broker intent onto a replay result, mirroring the B2
   * duplicate-resolution semantics exactly (read-only: no submit, no
   * provider call). Only a durably resolved intent with its real provider
   * order id projects an outcome; anything unresolved stays explicitly
   * unresolved — never accepted, never rejected.
   */
  private async replayBrokerIntent(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profileId: string;
    setupId: string;
    intent: ProviderIntentRecord;
    clientOrderId: string;
    idempotencyKey: string;
    requestId: string | null;
  }): Promise<ExecutionCompositionResult> {
    const { snap, profileId, setupId, intent, clientOrderId, idempotencyKey, requestId } = args;
    const result: MutationExecutionResult = {
      providerCalled: false,
      outcome: intent.outcome ?? 'uncertain',
      intentId: intent.id,
      clientOrderId: intent.clientOrderId,
      idempotencyKey: intent.idempotencyKey ?? '',
      attempt: intent.attempt,
      intentState: intent.status,
      reservationState: null,
      uncertaintyReason: intent.uncertaintyReason,
      requiresReconciliation: intent.status === 'uncertain' || intent.status === 'submitting',
      receiptId: null,
      providerOrderId: null,
      evidence: intent.terminalEvidence,
      persistenceFailure: null,
    };
    if (intent.status === 'rejected') {
      const receipt = await this.deps.providerMutations.getReceipt(intent.id);
      const providerOutcome: CanonicalSubmitResult = {
        status: 'ok',
        kind: 'duplicate',
        result,
        providerOutcome: {
          providerOrderId: receipt?.providerOrderId ?? null,
          status: 'rejected',
          receipt: { duplicate: true, intentStatus: intent.status, receiptId: receipt?.id ?? null },
        },
      };
      await this.auditReplay({ snap, profileId, setupId, requestId, brokerOutcome: providerOutcome });
      return {
        accepted: false, replayed: true,
        gate: { passed: true, failedGate: null, reason: null, evaluated: [] },
        authorizationId: null, clientOrderId, idempotencyKey,
        providerOutcome, paperOutcome: null, riskDecisionId: null, requestId,
      };
    }
    if (intent.status === 'confirmed') {
      const receipt = await this.deps.providerMutations.getReceipt(intent.id);
      if (!receipt?.providerOrderId) {
        // Fail-safe (B2 parity): a confirmed intent without its verified
        // ticket never projects an acceptance.
        const providerOutcome: CanonicalSubmitResult = {
          status: 'error',
          kind: 'duplicate_unresolved',
          message:
            `duplicate resolution reached a confirmed intent without a durable provider ` +
            `order id (intent ${intent.id}); an acceptance is never projected without its ` +
            'verified ticket — reconcile the intent before resubmitting',
          result,
        };
        await this.auditReplay({ snap, profileId, setupId, requestId, brokerOutcome: providerOutcome });
        return {
          accepted: false, replayed: true,
          gate: { passed: false, failedGate: null, reason: providerOutcome.message, evaluated: [] },
          authorizationId: null, clientOrderId, idempotencyKey,
          providerOutcome, paperOutcome: null, riskDecisionId: null, requestId,
        };
      }
      const providerOutcome: CanonicalSubmitResult = {
        status: 'ok',
        kind: 'duplicate',
        result,
        providerOutcome: {
          providerOrderId: receipt.providerOrderId,
          status: 'accepted',
          receipt: { duplicate: true, intentStatus: intent.status, receiptId: receipt.id },
        },
      };
      await this.auditReplay({ snap, profileId, setupId, requestId, brokerOutcome: providerOutcome });
      return {
        accepted: true, replayed: true,
        gate: { passed: true, failedGate: null, reason: null, evaluated: [] },
        authorizationId: null, clientOrderId, idempotencyKey,
        providerOutcome, paperOutcome: null, riskDecisionId: null, requestId,
      };
    }
    const providerOutcome: CanonicalSubmitResult = {
      status: 'error',
      kind: 'duplicate_unresolved',
      message:
        `duplicate resolution reached an intent in state '${intent.status}'; the provider ` +
        'outcome is not durably resolved and is never projected as accepted or rejected',
      result,
    };
    await this.auditReplay({ snap, profileId, setupId, requestId, brokerOutcome: providerOutcome });
    return {
      accepted: false, replayed: true,
      gate: { passed: false, failedGate: null, reason: providerOutcome.message, evaluated: [] },
      authorizationId: null, clientOrderId, idempotencyKey,
      providerOutcome, paperOutcome: null, riskDecisionId: null, requestId,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* submit paths                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * M6 — hand the operation to the paper simulator. The B1 authorization is
   * consumed by the handoff (verified on replay/reject paths, consumed
   * exactly once on the fill path); any leftover is revoked here so no
   * accepted paper result can strand a grant. Gate 9 is never touched on
   * this path. The risk reservation was already released by the paper
   * service on every exit path; the catch below only backstops a throw
   * before the handoff established its own cleanup.
   */
  private async submitPaper(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profile: ProfileRow;
    setup: SetupProvenanceRow;
    decision: ExecutionDecisionInput;
    gate: ExecutionGateResult;
    riskId: string;
    exposureWithinLimits: boolean;
    effectiveMinRr: number;
    quantity: number;
    authorizationId: string;
    authContext: AuthorizationExecutionContext;
    paperIdentity: ComposedPaperEntryIdentity;
    idempotencyKey: string;
    clientOrderId: string;
    requestId: string;
    nowMs: number;
  }): Promise<ExecutionCompositionResult> {
    const { snap, profile, setup, decision, gate, riskId, quantity, authorizationId, authContext, paperIdentity, idempotencyKey, requestId } = args;
    let paperOutcome: ComposedPaperEntryResult;
    try {
      paperOutcome = await this.deps.paper.executeComposedEntry({
        b1AuthorizationId: authorizationId,
        context: authContext,
        userId: snap.userId,
        executionProfileId: profile.id,
        setupId: setup.setup_id,
        baseHash: idempotencyKey,
        clientOrderId: paperIdentity.clientOrderId,
        orderIdempotencyKey: paperIdentity.orderIdempotencyKey,
        attempt: paperIdentity.attempt,
        decision,
        quantity,
        exposureWithinLimits: args.exposureWithinLimits,
        effectiveMinRr: args.effectiveMinRr,
        riskDecisionId: riskId,
        nowMs: args.nowMs,
        meta: { ip: snap.ip, userAgent: snap.userAgent },
      });
    } catch (err) {
      this.deps.authorization.revokeAuthorization(authorizationId);
      await this.deps.risk.releaseReservation(riskId);
      throw err;
    }
    // The fill path consumed the B1 authorization; the verify-only paths did
    // not. Revoke any leftover so no outcome strands a grant (idempotent).
    this.deps.authorization.revokeAuthorization(authorizationId);

    if (paperOutcome.status === 'filled' || paperOutcome.status === 'replayed') {
      await this.auditSuccess({
        snap, profileId: profile.id, setupId: setup.setup_id, gate,
        requestId, riskId, authorizationId,
        clientOrderId: paperIdentity.clientOrderId,
        replayed: paperOutcome.status === 'replayed',
        paperOutcome,
      });
      return {
        accepted: true, replayed: paperOutcome.status === 'replayed', gate,
        authorizationId, clientOrderId: paperIdentity.clientOrderId, idempotencyKey: paperIdentity.orderIdempotencyKey,
        providerOutcome: null, paperOutcome, riskDecisionId: riskId, requestId,
      };
    }
    // The gates passed but the simulator refused: the gate stays passed
    // (truthful — the gates did pass) while acceptance is false and the
    // paper outcome carries the refusal reason.
    await this.auditRejection({
      snap, profileId: profile.id, setupId: setup.setup_id, gate,
      riskDecisionId: riskId, requestId, authorizationId,
      reasonOverride: paperOutcome.reason,
      extra: { paperStatus: paperOutcome.status },
    });
    return {
      accepted: false, replayed: false, gate,
      authorizationId, clientOrderId: paperIdentity.clientOrderId, idempotencyKey: paperIdentity.orderIdempotencyKey,
      providerOutcome: null, paperOutcome, riskDecisionId: riskId, requestId,
    };
  }

  /**
   * Broker submit through the single canonical boundary (Gate 9 + B2).
   *
   * H4: the live risk reservation and its positive decimal exposure are
   * handed to the durable intent; the risk hold is released only once the
   * intent owns the exposure (or the attempt is abandoned pre-call with zero
   * exposure). H1: the expected execution context is armed one-shot
   * immediately before the boundary. M5: the canonical result is mapped to
   * accepted/rejected/uncertain/duplicate without projection errors.
   */
  private async submitBroker(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profile: ProfileRow;
    setup: SetupProvenanceRow;
    decision: ExecutionDecisionInput;
    gate: ExecutionGateResult;
    riskId: string;
    quantity: number;
    side: 'buy' | 'sell';
    authorizationId: string;
    authContext: AuthorizationExecutionContext;
    idempotencyKey: string;
    clientOrderId: string;
    requestId: string;
    nowMs: number;
    environment: 'paper' | 'demo';
  }): Promise<ExecutionCompositionResult> {
    const { snap, profile, setup, decision, gate, riskId, quantity, side, authorizationId, authContext, idempotencyKey, clientOrderId, requestId, nowMs, environment } = args;

    // H4 — the handoff fails closed unless the reservation is live and a
    // positive decimal exposure is represented (never '0').
    const reservation = await this.deps.risk.getActiveReservation({
      riskDecisionId: riskId,
      executionProfileId: profile.id,
      nowMs,
    });
    let handoff: ReturnType<typeof toGate9RiskHandoff>;
    try {
      handoff = toGate9RiskHandoff({ riskDecisionId: riskId, reservation, nowMs });
    } catch (err) {
      this.deps.authorization.revokeAuthorization(authorizationId);
      await this.deps.risk.releaseReservation(riskId);
      const failGate: ExecutionGateResult = {
        passed: false,
        failedGate: 'risk_decision',
        reason: err instanceof Error ? err.message : 'risk handoff unavailable',
        evaluated: gate.evaluated,
      };
      await this.auditRejection({ snap, profileId: profile.id, setupId: setup.setup_id, gate: failGate, riskDecisionId: riskId, requestId, authorizationId });
      return {
        accepted: false, replayed: false, gate: failGate,
        authorizationId, clientOrderId, idempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: riskId, requestId,
      };
    }

    const provider = this.deps.providers.get(profile.provider_slug);
    if (!provider) {
      // Unreachable in practice (health was read from this provider), but
      // never assume a registry entry survived the flight.
      this.deps.authorization.revokeAuthorization(authorizationId);
      await this.deps.risk.releaseReservation(riskId);
      const failGate: ExecutionGateResult = {
        passed: false,
        failedGate: 'provider_healthy',
        reason: 'execution provider is no longer registered',
        evaluated: gate.evaluated,
      };
      await this.auditRejection({ snap, profileId: profile.id, setupId: setup.setup_id, gate: failGate, riskDecisionId: riskId, requestId, authorizationId });
      return {
        accepted: false, replayed: false, gate: failGate,
        authorizationId, clientOrderId, idempotencyKey,
        providerOutcome: null, paperOutcome: null, riskDecisionId: riskId, requestId,
      };
    }

    const request = toAuthorizationRequestBinding({
      clientOrderId,
      idempotencyKey,
      authorizationId,
      assetClass: decision.assetClass,
      symbol: decision.symbol,
      side,
      orderType: 'market',
      quantity,
      requestedPrice: null,
      stopLossPrice: decision.stopLossPrice,
      takeProfitPrice: decision.takeProfitPrice,
    });

    // H1 — arm the expected execution context one-shot, synchronously,
    // immediately before the Gate 9 boundary (no interleave window).
    this.deps.authHandoff.arm(authorizationId, authContext);
    let outcome: CanonicalSubmitResult;
    try {
      outcome = await submitOrderThroughGate9({
        ledger: this.deps.providerMutations,
        provider,
        userId: snap.userId,
        executionProfileId: profile.id,
        providerSlug: profile.provider_slug,
        environment,
        accountRef: profile.account_ref,
        brokerServerRef: profile.broker_server,
        credentialRef: null,
        credentialFingerprint: null,
        riskDecisionId: riskId,
        riskReservationId: handoff.riskReservationId,
        monetaryRisk: handoff.monetaryRisk,
        riskExpiresAt: handoff.riskExpiresAt,
        request,
        handoff: this.deps.submitHandoff,
      });
    } catch (err) {
      this.deps.authHandoff.revoke(authorizationId);
      this.deps.authorization.revokeAuthorization(authorizationId);
      await this.deps.risk.releaseReservation(riskId);
      throw err;
    }
    // Unconditional idempotent cleanup: the submit path consumed both the
    // handoff entry and the B1 authorization; duplicate/refusal paths leave
    // them pending and they must not strand.
    this.deps.authHandoff.revoke(authorizationId);
    this.deps.authorization.revokeAuthorization(authorizationId);
    // H4 — the durable intent owns the exposure from here (accepted,
    // rejected, uncertain, or duplicate-onto-durable). On a pre-call refusal
    // no intent exists AND no provider call happened: the attempt is
    // abandoned with zero exposure, so releasing is equally correct —
    // holding would block legitimate later attempts until TTL.
    await this.deps.risk.releaseReservation(riskId);

    const mapped = mapBrokerSubmitOutcome(outcome);
    if (mapped.accepted) {
      await this.auditSuccess({
        snap, profileId: profile.id, setupId: setup.setup_id, gate,
        requestId, riskId, authorizationId, clientOrderId,
        replayed: mapped.replayed, brokerOutcome: outcome,
      });
    } else if (mapped.disposition === 'uncertain' || mapped.disposition === 'unresolved_duplicate') {
      await this.auditUncertain({
        snap, profileId: profile.id, setupId: setup.setup_id, gate,
        requestId, riskId, authorizationId, clientOrderId, outcome,
        replayed: mapped.replayed,
      });
    } else {
      await this.auditRejection({
        snap, profileId: profile.id, setupId: setup.setup_id, gate,
        riskDecisionId: riskId, requestId, authorizationId,
        reasonOverride: mapped.disposition === 'submitted_rejected'
          ? 'broker rejected the order'
          : mapped.disposition === 'duplicate_rejected'
            ? 'broker rejected the order (duplicate resolution)'
            : 'broker submission was refused before the provider call',
        extra: { disposition: mapped.disposition, replayed: mapped.replayed },
      });
    }
    return {
      accepted: mapped.accepted, replayed: mapped.replayed, gate,
      authorizationId, clientOrderId, idempotencyKey,
      providerOutcome: outcome, paperOutcome: null, riskDecisionId: riskId, requestId,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* persistence recovery (M4)                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * M4 — recover an identity conflict onto a VERIFIED existing row: the row
   * must exist and must belong to the snapshot's user. Anything else fails
   * closed (reservation released, loud internal error, no submit).
   */
  private async resolveRequestRowOrFail(
    snap: ReturnType<typeof freezeCompositionInput>,
    idempotencyKey: string,
    riskId: string,
  ): Promise<string> {
    const existing = await this.pool.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM execution_requests WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) {
      await this.deps.risk.releaseReservation(riskId);
      throw Errors.internal('Execution request identity could not be resolved after an identity conflict');
    }
    if (row.user_id !== snap.userId) {
      await this.deps.risk.releaseReservation(riskId);
      throw Errors.internal('Execution request identity resolved to another user');
    }
    return row.id;
  }

  /* ---------------------------------------------------------------------- */
  /* decision rejection (M2/H6, before risk/persistence/submission)           */
  /* ---------------------------------------------------------------------- */

  private async rejectDecision(
    snap: ReturnType<typeof freezeCompositionInput>,
    profile: ProfileRow,
    setup: SetupProvenanceRow,
    reason: string,
    _nowMs: number,
  ): Promise<ExecutionCompositionResult> {
    const gate: ExecutionGateResult = {
      passed: false,
      failedGate: 'valid_signal' as ExecutionGateId,
      reason,
      evaluated: ['authenticated', 'authorized', 'entitlement', 'automation_on', 'profile_enabled', 'kill_switch', 'valid_signal'],
    };
    await this.auditRejection({ snap, profileId: profile.id, setupId: setup.setup_id, gate, riskDecisionId: null });
    return {
      accepted: false, replayed: false, gate,
      authorizationId: null, clientOrderId: null, idempotencyKey: null,
      providerOutcome: null, paperOutcome: null, riskDecisionId: null, requestId: null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* audit trail                                                             */
  /* ---------------------------------------------------------------------- */

  private async auditRejection(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profileId: string;
    setupId: string;
    gate: ExecutionGateResult;
    riskDecisionId: string | null;
    requestId?: string | null;
    authorizationId?: string | null;
    reasonOverride?: string | null;
    extra?: Record<string, unknown>;
  }): Promise<void> {
    const { snap, profileId, setupId, gate, riskDecisionId } = args;
    try {
      await this.pool.query(
        `INSERT INTO execution_events
           (user_id, execution_profile_id, setup_id, event, to_status, reason, metadata, ip, user_agent)
         VALUES ($1,$2,$3,'execution_rejected','rejected',$4,$5,$6,$7)`,
        [
          snap.userId,
          profileId,
          setupId,
          args.reasonOverride ?? gate.reason,
          JSON.stringify({
            requestId: args.requestId ?? null,
            gate: gate.failedGate ?? null,
            evaluated: gate.evaluated,
            riskDecisionId,
            authorizationId: args.authorizationId ?? null,
            architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
            ...(args.extra ?? {}),
          }),
          snap.ip ?? null,
          snap.userAgent ?? null,
        ],
      );
      await this.deps.audit.log({
        userId: snap.userId,
        action: 'execution.rejected',
        entityType: 'execution_request',
        entityId: args.requestId ?? setupId,
        ip: snap.ip ?? null,
        userAgent: snap.userAgent ?? null,
        metadata: {
          setupId,
          executionProfileId: profileId,
          gate: gate.failedGate ?? null,
          reason: (args.reasonOverride ?? gate.reason) ?? null,
          riskDecisionId,
        },
      });
    } catch {
      // Audit failure must not block gate refusal
    }
    this.logger.info('execution composition rejected', {
      setupId,
      gate: gate.failedGate ?? null,
      reason: (args.reasonOverride ?? gate.reason) ?? null,
    });
  }

  private async auditSuccess(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profileId: string;
    setupId: string;
    gate: ExecutionGateResult;
    requestId: string;
    riskId: string;
    authorizationId: string;
    clientOrderId: string;
    replayed: boolean;
    brokerOutcome?: CanonicalSubmitResult;
    paperOutcome?: ComposedPaperEntryResult;
  }): Promise<void> {
    const { snap, profileId, setupId, gate, requestId, riskId, authorizationId, clientOrderId } = args;
    await this.pool.query(
      `INSERT INTO execution_events
         (user_id, execution_profile_id, setup_id, event, to_status, reason, metadata, ip, user_agent)
       VALUES ($1,$2,$3,'execution_requested','requested',$4,$5,$6,$7)`,
      [
        snap.userId,
        profileId,
        setupId,
        null,
        JSON.stringify({
          requestId,
          gate: null,
          evaluated: gate.evaluated,
          replayed: args.replayed,
          architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
          riskDecisionId: riskId,
          clientOrderId,
          authorizationId,
        }),
        snap.ip ?? null,
        snap.userAgent ?? null,
      ],
    );
    await this.deps.audit.log({
      userId: snap.userId,
      action: 'execution.requested',
      entityType: 'execution_request',
      entityId: requestId,
      ip: snap.ip ?? null,
      userAgent: snap.userAgent ?? null,
      metadata: {
        setupId,
        executionProfileId: profileId,
        gate: null,
        clientOrderId,
        replayed: args.replayed,
      },
    });
    this.logger.info('execution composition accepted', {
      requestId,
      setupId,
      clientOrderId,
      replayed: args.replayed,
    });
  }

  /**
   * Uncertainty is neither acceptance nor rejection: the submission WAS made
   * (or a duplicate resolved onto an unresolved intent) and reconciliation
   * owns it now. Recorded as `execution_requested` with explicit uncertainty
   * metadata — never as a rejection (which would imply nothing was sent).
   */
  private async auditUncertain(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profileId: string;
    setupId: string;
    gate: ExecutionGateResult;
    requestId: string;
    riskId: string;
    authorizationId: string;
    clientOrderId: string;
    outcome: CanonicalSubmitResult;
    replayed: boolean;
  }): Promise<void> {
    const { snap, profileId, setupId, gate, requestId, riskId, authorizationId, clientOrderId, outcome } = args;
    const message = outcome.status === 'error' ? outcome.message : 'provider outcome uncertain';
    await this.pool.query(
      `INSERT INTO execution_events
         (user_id, execution_profile_id, setup_id, event, to_status, reason, metadata, ip, user_agent)
       VALUES ($1,$2,$3,'execution_requested','requested',$4,$5,$6,$7)`,
      [
        snap.userId,
        profileId,
        setupId,
        message,
        JSON.stringify({
          requestId,
          gate: null,
          evaluated: gate.evaluated,
          uncertain: true,
          replayed: args.replayed,
          architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
          riskDecisionId: riskId,
          clientOrderId,
          authorizationId,
        }),
        snap.ip ?? null,
        snap.userAgent ?? null,
      ],
    );
    await this.deps.audit.log({
      userId: snap.userId,
      action: 'execution.requested',
      entityType: 'execution_request',
      entityId: requestId,
      ip: snap.ip ?? null,
      userAgent: snap.userAgent ?? null,
      metadata: {
        setupId,
        executionProfileId: profileId,
        gate: null,
        clientOrderId,
        uncertain: true,
        replayed: args.replayed,
      },
    });
    this.logger.warn('execution composition uncertain', {
      requestId,
      setupId,
      clientOrderId,
      replayed: args.replayed,
    });
  }

  private async auditReplay(args: {
    snap: ReturnType<typeof freezeCompositionInput>;
    profileId: string;
    setupId: string;
    requestId: string | null;
    brokerOutcome?: CanonicalSubmitResult;
    paperOutcome?: ComposedPaperEntryResult;
  }): Promise<void> {
    const { snap, profileId, setupId, requestId } = args;
    try {
      await this.pool.query(
        `INSERT INTO execution_events
           (user_id, execution_profile_id, setup_id, event, to_status, reason, metadata, ip, user_agent)
         VALUES ($1,$2,$3,'execution_requested','requested',$4,$5,$6,$7)`,
        [
          snap.userId,
          profileId,
          setupId,
          null,
          JSON.stringify({
            requestId,
            replayed: true,
            architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
          }),
          snap.ip ?? null,
          snap.userAgent ?? null,
        ],
      );
    } catch {
      // Audit failure must not block an honest replay report.
    }
    this.logger.info('execution composition replayed', { setupId, requestId });
  }
}

function numOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
