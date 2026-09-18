import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  EXECUTION_ARCHITECTURE_VERSION,
  ExecutionProviderError,
  PAPER_RISK_DECISION_MAX_AGE_MS,
  PAPER_SIMULATOR_VERSION,
  RISK_ENGINE_VERSION,
  executionIdempotencyKey,
  isExecutionProviderError,
  type AssetClass,
  type ExecutionDecisionInput,
  type ExecutionProvider,
  type ExecutionSubmitOrderOutcome,
  type ExecutionSubmitOrderRequest,
  type InstrumentRiskSpec,
  type OrderSide,
  type PaperExitReason,
  type PaperFillDto,
  type PaperOrderDto,
  type PaperPositionDto,
  type PaperPositionOutcomeDto,
  type PaperSimulationGateId,
  type PaperSimulationResultDto,
  type PaperStatusDto,
  type ReconciliationDto,
  type Timeframe,
} from '@veltrixeye/contracts';
import type { AuditService, AuditEntry } from '../audit.js';
import { Errors } from '../errors.js';
import { Dec } from '../risk/decimal.js';
import type { RiskEngineService } from '../risk/service.js';
import { AuditCollector, type PaperEventLogger } from './paper-events.js';
import type { AutomationService } from './automation.js';
import type { KillSwitchService } from './kill-switch.js';
import {
  PAPER_COST_MODEL_NONE,
  buildServerExecutionDecision,
  computeEntryFill,
  computeExitFill,
  detectExit,
  grossRealizedPl,
  netRealizedPl,
  paperClientOrderId,
  paperProviderPositionId,
  unrealizedPl,
  type PaperCostModel,
  type PaperCandle,
  type PaperOrderKind,
} from './paper-engine.js';
import { evaluatePaperSimulationGates } from './paper-gates.js';
import type { SimulatorMarketPriceSource } from './paper-market.js';
import { reconcileOrderState, reconcilePositionState } from './reconciliation.js';
import { assertOrderTransition } from './order-machine.js';
import { evaluateExecutionGates } from './gates.js';

/**
 * M8.3 — the paper execution simulator service.
 *
 * THE ONLY component in the platform that can turn a server-issued decision
 * into a simulated order, fill, position and P&L. It is:
 *
 *  - deterministic: an injected clock and a pure engine produce identical
 *    numbers for identical inputs; there is no randomness in any financial
 *    value (the only random value is the in-memory authorization id);
 *  - server-authoritative: the decision is built from the persisted setup, the
 *    position size comes from the persisted M8.2 risk verdict and the price
 *    comes from the shared candle store. No caller-supplied approval, size,
 *    price, P&L or execution state is accepted anywhere;
 *  - fail-closed: every refusal is recorded (append-only execution event,
 *    platform audit, reconciliation finding) and leaves no financial state
 *    behind;
 *  - idempotent: order/position/fill identities derive from
 *    (user, setup, profile, action); unique constraints serialize retries and
 *    concurrent twins; repeated fill processing collapses onto the first fill;
 *  - internal only: the single provider is the in-process paper simulator.
 *    There is no broker client, no credential, no external trading call and no
 *    code path that could send an order anywhere.
 */

export interface PaperFailureMode {
  /**
   * Deterministically fail the fill AFTER the order is authorized (the order
   * lands in `failed` with a reason, no fill, no position). Test hook — never
   * reachable from client input.
   */
  fillFailure?: boolean;
  /** Deterministically fail before the fill (order lands in `failed`). */
  orderRejection?: boolean;
}

export interface PaperExecutionServiceDeps {
  market: SimulatorMarketPriceSource;
  risk: RiskEngineService;
  killSwitches: KillSwitchService;
  automation: AutomationService;
  audit: AuditService;
  /** Lazily resolved so the provider can be constructed after this service. */
  provider: () => ExecutionProvider | undefined;
}

export interface PaperExecutionServiceOptions {
  costs?: PaperCostModel;
  logger?: PaperEventLogger;
  failureMode?: PaperFailureMode;
  /** Authorization TTL (ms). In-memory, single-use, never persisted. */
  authorizationTtlMs?: number;
  /**
   * Clock used ONLY to age in-memory authorizations. Defaults to wall time.
   *
   * This is deliberately separate from the caller-supplied `nowMs` evaluation
   * timestamps: a caller must never be able to keep an authorization alive (or
   * make it expire) by choosing a timestamp. Tests inject a fixed clock so the
   * TTL stays deterministic without ever touching financial values.
   */
  clock?: () => number;
}

interface PaperAuthorization {
  id: string;
  userId: string;
  executionProfileId: string;
  setupId: string;
  instrumentId: string;
  assetClass: AssetClass;
  symbol: string;
  side: OrderSide;
  kind: PaperOrderKind;
  quantity: number;
  clientOrderId: string;
  idempotencyKey: string;
  decision: ExecutionDecisionInput;
  riskDecisionId: string | null;
  engineVersion: string;
  positionId: string | null;
  /** Stable per-identity key: the paper position id derives from it. */
  positionKey: string;
  referencePrice: number;
  referencePriceMs: number;
  spec: InstrumentRiskSpec;
  timeframe: Timeframe;
  createdMs: number;
  consumed: boolean;
}

export class PaperIntegrityError extends Error {
  readonly findings: string[];
  constructor(findings: string[]) {
    super(`paper execution integrity check failed: ${findings.join(', ')}`);
    this.name = 'PaperIntegrityError';
    this.findings = findings;
  }
}

const SILENT_LOGGER: PaperEventLogger = { info: () => {}, warn: () => {} };

/** Lifecycle steps a successful paper order goes through, in order. */
const ORDER_STEPS = [
  { from: 'requested', to: 'validating', event: 'order_validating' },
  { from: 'validating', to: 'submitted', event: 'order_submitted' },
  { from: 'submitted', to: 'accepted', event: 'order_accepted' },
  { from: 'accepted', to: 'filled', event: 'order_filled' },
] as const;

/** Lifecycle steps a failing paper order goes through, in order. */
const ORDER_FAILURE_STEPS = [
  { from: 'requested', to: 'validating', event: 'order_validating' },
  { from: 'validating', to: 'submitted', event: 'order_submitted' },
  { from: 'submitted', to: 'failed', event: 'order_failed' },
] as const;

export class PaperExecutionService {
  private readonly costs: PaperCostModel;
  private readonly logger: PaperEventLogger;
  private readonly failureMode: PaperFailureMode;
  private readonly authorizationTtlMs: number;
  private readonly clock: () => number;
  private readonly authorizations = new Map<string, PaperAuthorization>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly deps: PaperExecutionServiceDeps,
    options?: PaperExecutionServiceOptions,
  ) {
    this.costs = options?.costs ?? PAPER_COST_MODEL_NONE;
    this.logger = options?.logger ?? SILENT_LOGGER;
    this.failureMode = options?.failureMode ?? {};
    this.authorizationTtlMs = options?.authorizationTtlMs ?? 60_000;
    this.clock = options?.clock ?? (() => Date.now());
  }

  /* ---------------------------------------------------------------------- */
  /* Status + read models                                                   */
  /* ---------------------------------------------------------------------- */

  async status(userId: string): Promise<PaperStatusDto> {
    const automation = await this.deps.automation.getStatus(userId);
    const provider = this.deps.provider();
    const health = provider ? await provider.health() : null;
    const automatedPathGate = await this.automatedPathGate(userId, provider, health);

    const counts = await this.pool.query<{
      orders: string;
      open_positions: string;
      closed_positions: string;
      fills: string;
      open_pl: string | null;
      closed_pl: string | null;
      profiles: string;
    }>(
      `SELECT
         (SELECT count(*) FROM execution_orders WHERE user_id = $1 AND simulated)::text AS orders,
         (SELECT count(*) FROM execution_positions WHERE user_id = $1 AND simulated AND status = 'open')::text AS open_positions,
         (SELECT count(*) FROM execution_positions WHERE user_id = $1 AND simulated AND status = 'closed')::text AS closed_positions,
         (SELECT count(*) FROM execution_fills WHERE user_id = $1 AND simulated)::text AS fills,
         (SELECT coalesce(sum(unrealized_pl), 0) FROM execution_positions WHERE user_id = $1 AND simulated AND status = 'open')::text AS open_pl,
         (SELECT coalesce(sum(realized_pl), 0) FROM execution_positions WHERE user_id = $1 AND simulated AND status = 'closed')::text AS closed_pl,
         (SELECT count(*) FROM execution_profiles WHERE user_id = $1)::text AS profiles`,
      [userId],
    );
    const row = counts.rows[0];

    const last = await this.pool.query<{ outcome: 'ok' | 'mismatch' }>(
      `SELECT outcome FROM execution_reconciliations WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );

    return {
      simulatorVersion: PAPER_SIMULATOR_VERSION,
      riskEngineVersion: RISK_ENGINE_VERSION,
      providerId: provider?.id ?? 'paper',
      providerConfigured: provider?.configured ?? false,
      providerHealthy: health?.healthy ?? false,
      providerReason: health?.reason ?? null,
      automationOff: !automation.effective,
      automationReasons: automation.reasons,
      automatedPathGate,
      profiles: Number(row?.profiles ?? 0),
      orders: Number(row?.orders ?? 0),
      openPositions: Number(row?.open_positions ?? 0),
      closedPositions: Number(row?.closed_positions ?? 0),
      fills: Number(row?.fills ?? 0),
      openPl: Number(row?.open_pl ?? 0),
      closedPl: Number(row?.closed_pl ?? 0),
      lastReconciliationOutcome: last.rows[0]?.outcome ?? null,
      liveExecutionAvailable: false,
    };
  }

  async listOrders(userId: string, limit: number): Promise<{ orders: PaperOrderDto[] }> {
    const res = await this.pool.query<OrderRow>(
      `SELECT * FROM execution_orders WHERE user_id = $1 AND simulated
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return { orders: res.rows.map(toPaperOrderDto) };
  }

  async listPositions(userId: string, limit: number): Promise<{ positions: PaperPositionDto[] }> {
    const res = await this.pool.query<PositionRow>(
      `SELECT * FROM execution_positions WHERE user_id = $1 AND simulated
        ORDER BY opened_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return { positions: res.rows.map(toPaperPositionDto) };
  }

  async listFills(userId: string, limit: number): Promise<{ fills: PaperFillDto[] }> {
    const res = await this.pool.query<FillRow>(
      `SELECT * FROM execution_fills WHERE user_id = $1 AND simulated
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return { fills: res.rows.map(toFillDto) };
  }

  async listReconciliations(
    userId: string,
    limit: number,
  ): Promise<{ reconciliations: ReconciliationDto[] }> {
    const res = await this.pool.query<ReconciliationRow>(
      `SELECT * FROM execution_reconciliations WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return { reconciliations: res.rows.map(toReconciliationDto) };
  }

  /* ---------------------------------------------------------------------- */
  /* Simulation                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Simulate execution of a server-issued decision for one owned setup.
   * The only client inputs are identifiers; everything else is server state.
   */
  async simulate(args: {
    userId: string;
    setupId: string;
    executionProfileId: string;
    riskDecisionId?: string | null;
    nowMs?: number;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
  }): Promise<PaperSimulationResultDto> {
    const nowMs = args.nowMs ?? Date.now();
    const collector = new AuditCollector();

    // 1. Profile — owner-scoped (masked 404), resolved from the DB.
    const profileRes = await this.pool.query<{
      id: string;
      enabled: boolean;
      environment: string;
    }>(
      `SELECT id, enabled, environment FROM execution_profiles
        WHERE id = $1 AND user_id = $2`,
      [args.executionProfileId, args.userId],
    );
    const profile = profileRes.rows[0];
    if (!profile) throw Errors.notFound('Execution profile not found');

    // 2. Setup provenance — owner-scoped (masked 404), with the version
    //    configuration the decision and the risk engine need.
    const setupRes = await this.pool.query<SetupRow>(
      `SELECT st.id AS setup_id, st.state, st.direction, st.as_of_ms,
              st.entry_price, st.stop_loss_price, st.tp1_price, st.quality_score,
              st.strategy_version_id, v.strategy_id, s.user_id AS owner,
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
      [args.setupId],
    );
    const setup = setupRes.rows[0];
    if (!setup || setup.owner !== args.userId) throw Errors.notFound('Setup not found');

    // 3. Server-built execution decision (never client-supplied).
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
      const levelProblem =
        built.reason.includes('entry price') ||
        built.reason.includes('stop loss') ||
        built.reason.includes('take profit') ||
        built.reason.includes('levels');
      return this.refuse({
        userId: args.userId,
        profileId: profile.id,
        setupId: setup.setup_id,
        gate: levelProblem ? 'valid_order_params' : 'valid_signal',
        reason: built.reason,
        nowMs,
        collector,
        meta: args.meta,
      });
    }
    const decision = built.decision;

    // 4. Idempotency: an intent that already produced a live (non-failed)
    //    order replays it instead of simulating again.
    const baseHash = hashIdentity(
      executionIdempotencyKey({
        userId: args.userId,
        setupId: setup.setup_id,
        executionProfileId: profile.id,
        action: decision.action,
      }),
    );
    const firstOrderId = paperClientOrderId(baseHash, 'entry');
    const existing = await this.pool.query<OrderRow>(
      'SELECT * FROM execution_orders WHERE client_order_id = $1',
      [firstOrderId],
    );
    const existingOrder = existing.rows[0];
    if (existingOrder && existingOrder.status !== 'failed' && existingOrder.status !== 'rejected') {
      return this.replayResult(args.userId, setup.setup_id, profile.id, existingOrder, collector);
    }
    // A previously failed attempt is retried under a NEW deterministic attempt
    // index: a successful simulation is never repeated, and a retry can never
    // mint an unbounded number of orders (the index is derived from state).
    const attempt = existingOrder ? (await this.failedAttemptCount(args.userId, profile.id, setup.setup_id)) + 1 : 1;
    const clientOrderId =
      attempt === 1 ? firstOrderId : `ve-${baseHash.slice(0, 20)}-r${attempt}`;
    const orderIdempotency = orderIdempotencyKey(baseHash, 'entry', attempt);

    // 5. M8.2 risk engine — the ONLY source of an approval, always re-run so
    //    the verdict reflects CURRENT state (exposure, equity, kill switches).
    const riskDecision = await this.deps.risk.evaluate({
      userId: args.userId,
      executionProfileId: profile.id,
      decision,
      nowMs,
      reserveOnApprove: true,
    });

    const cited = await this.validateCitedDecision({
      userId: args.userId,
      executionProfileId: profile.id,
      setupId: setup.setup_id,
      decision,
      riskDecisionId: args.riskDecisionId ?? null,
      nowMs,
    });
    if (cited.kind === 'not_found') {
      await this.deps.risk.releaseReservation(riskDecision.id);
      await this.refuse({
        userId: args.userId,
        profileId: profile.id,
        setupId: setup.setup_id,
        gate: 'risk_decision_issued',
        reason: 'risk decision was not found for this account',
        nowMs,
        collector,
        meta: args.meta,
      });
      throw Errors.notFound('Risk decision not found');
    }

    // 6. Server market price (the only price source) + instrument spec.
    const timeframe = decision.timeframe;
    const spec = await this.loadInstrumentSpec(setup.asset_class, setup.symbol);
    const market = await this.deps.market.latestPrice({
      instrumentId: setup.instrument_id,
      timeframe,
      nowMs,
    });

    // 7. GATES — pinned order, fail-closed.
    const provider = this.deps.provider();
    const health = provider ? await provider.health() : null;
    const killSwitches = await this.deps.killSwitches.anyActive({
      userId: args.userId,
      strategyId: decision.strategyId,
      executionProfileId: profile.id,
    });
    const automation = await this.deps.automation.getStatus(args.userId);
    const automatedPathGate = await this.automatedPathGate(args.userId, provider, health);

    const gate = evaluatePaperSimulationGates({
      authenticated: true,
      authorized: true,
      profile: { enabled: profile.enabled, environment: profile.environment },
      killSwitches,
      providerHealth: health
        ? { healthy: health.healthy, configured: provider?.configured ?? false }
        : null,
      decision,
      setup: { id: setup.setup_id, direction: setup.direction, state: setup.state },
      riskDecision: {
        outcome: cited.kind === 'rejected' ? 'rejected' : riskDecision.outcome,
        reason: cited.kind === 'rejected' ? cited.reason : riskDecision.reason,
        decisionId: cited.kind === 'rejected' ? cited.decisionId : riskDecision.id,
        engineVersion: cited.kind === 'rejected' ? cited.engineVersion : riskDecision.engineVersion,
        positionSize: cited.kind === 'rejected' ? null : riskDecision.positionSize,
        rr: cited.kind === 'rejected' ? null : riskDecision.rr,
        exposureWithinLimits: cited.kind === 'rejected' ? null : riskDecision.exposureWithinLimits,
      },
      effectiveMinRr: riskDecision.effectiveMinRr,
      instrumentSpec: spec,
      fillPrice: market.ok ? market.price.price : null,
      marketPrice: market.ok
        ? {
            price: market.price.price,
            ageMs: market.price.ageMs,
            thresholdMs: market.price.thresholdMs,
          }
        : null,
      // The market interface is the authority on WHY it has no usable price
      // (missing candle, malformed OHLC, stale, future timestamp).
      marketPriceError: market.ok ? null : market.reason,
    });

    if (!gate.passed) {
      await this.deps.risk.releaseReservation(riskDecision.id);
      return this.refuse({
        userId: args.userId,
        profileId: profile.id,
        setupId: setup.setup_id,
        gate: gate.failedGate ?? 'valid_signal',
        reason: gate.reason ?? 'paper simulation refused',
        nowMs,
        collector,
        meta: args.meta,
        extra: {
          riskDecisionId: riskDecision.id,
          riskOutcome: riskDecision.outcome,
          evaluated: gate.evaluated,
          automationOff: !automation.effective,
          automatedPathGate,
        },
      });
    }

    // 8. Authorize + submit through the provider boundary. The authorization
    //    is in-memory, single-use and never client-visible: the provider
    //    refuses any submit that does not carry one.
    if (!market.ok) {
      // Unreachable (the freshness gate precedes this), but never assume.
      await this.deps.risk.releaseReservation(riskDecision.id);
      return this.refuse({
        userId: args.userId,
        profileId: profile.id,
        setupId: setup.setup_id,
        gate: 'market_price_fresh',
        reason: market.reason,
        nowMs,
        collector,
        meta: args.meta,
      });
    }
    const price = market.price;
    const quantity = riskDecision.positionSize as number;
    const side: OrderSide = decision.direction === 'long' ? 'buy' : 'sell';
    const authorization = this.createAuthorization({
      userId: args.userId,
      executionProfileId: profile.id,
      setupId: setup.setup_id,
      instrumentId: setup.instrument_id,
      assetClass: setup.asset_class as AssetClass,
      symbol: setup.symbol,
      side,
      kind: 'entry',
      quantity,
      clientOrderId,
      idempotencyKey: orderIdempotency,
      decision,
      riskDecisionId: riskDecision.id,
      engineVersion: riskDecision.engineVersion,
      positionId: null,
      positionKey: baseHash,
      referencePrice: price.price,
      referencePriceMs: price.timeMs,
      spec: spec as InstrumentRiskSpec,
      timeframe,
    });

    const request: ExecutionSubmitOrderRequest = {
      clientOrderId,
      idempotencyKey: orderIdempotency,
      authorizationId: authorization.id,
      assetClass: decision.assetClass,
      symbol: decision.symbol,
      side,
      orderType: 'market',
      quantity,
      requestedPrice: null,
      stopLossPrice: decision.stopLossPrice,
      takeProfitPrice: decision.takeProfitPrice,
    };

    // The reservation is no longer needed: the position (or the failure) is
    // about to be recorded, and positions count toward exposure directly.
    await this.deps.risk.releaseReservation(riskDecision.id);

    let outcome: ExecutionSubmitOrderOutcome | null = null;
    let failureReason: string | null = null;
    try {
      outcome = provider ? await provider.submitOrder(request) : null;
      if (!outcome) failureReason = 'paper simulator is not registered';
    } catch (err) {
      if (isExecutionProviderError(err)) {
        failureReason = err.message;
      } else if (err instanceof PaperIntegrityError) {
        failureReason = `simulated execution failed an integrity check (${err.findings.join(', ')})`;
      } else {
        throw err;
      }
    }

    if (!outcome || outcome.status === 'rejected') {
      return this.refuse({
        userId: args.userId,
        profileId: profile.id,
        setupId: setup.setup_id,
        gate: null,
        reason: failureReason ?? 'paper order was not filled',
        nowMs,
        collector,
        meta: args.meta,
        extra: {
          riskDecisionId: riskDecision.id,
          automatedPathGate,
          evaluated: gate.evaluated,
        },
      });
    }

    return this.completedResult({
      userId: args.userId,
      setupId: setup.setup_id,
      executionProfileId: profile.id,
      clientOrderId,
      riskDecisionId: riskDecision.id,
      riskEngineVersion: riskDecision.engineVersion,
      positionSize: quantity,
      automatedPathGate,
      nowMs,
      collector,
      meta: args.meta,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Position lifecycle (SL / TP / close)                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Evaluate every open paper position against server market data and apply
   * SL/TP deterministically. No client input beyond the caller's session.
   */
  async evaluateOpenPositions(args: {
    userId: string;
    nowMs?: number;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
  }): Promise<{ evaluated: number; closed: number; outcomes: PaperPositionOutcomeDto[] }> {
    const nowMs = args.nowMs ?? Date.now();
    const open = await this.loadOpenPositions(args.userId);
    const outcomes: PaperPositionOutcomeDto[] = [];
    for (const position of open) {
      const outcome = await this.evaluatePosition({ userId: args.userId, position, nowMs, meta: args.meta });
      if (outcome) outcomes.push(outcome);
    }
    return {
      evaluated: outcomes.length,
      closed: outcomes.filter((o) => o.exitReason !== null).length,
      outcomes,
    };
  }

  /** Close one owned paper position at the current server market price. */
  async closePosition(args: {
    userId: string;
    positionId: string;
    nowMs?: number;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
  }): Promise<PaperPositionOutcomeDto> {
    const nowMs = args.nowMs ?? Date.now();
    const position = await this.loadPosition(args.userId, args.positionId);
    if (!position) throw Errors.notFound('Paper position not found');
    if (position.status !== 'open') throw Errors.invalidInput('Paper position is already closed');
    const outcome = await this.evaluatePosition({
      userId: args.userId,
      position,
      nowMs,
      meta: args.meta,
      forceClose: true,
    });
    if (!outcome) throw Errors.internal('Paper position could not be evaluated');
    return outcome;
  }

  private async evaluatePosition(args: {
    userId: string;
    position: LoadedPosition;
    nowMs: number;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
    forceClose?: boolean;
  }): Promise<PaperPositionOutcomeDto | null> {
    const { position } = args;
    const collector = new AuditCollector();

    // A position without its opening order or its instrument is an
    // inconsistent state: record it and fail closed (never guess provenance).
    if (!position.opened_by_order_id || !position.instrument_id || !position.timeframe) {
      await this.recordReconciliation({
        userId: args.userId,
        executionProfileId: position.execution_profile_id,
        orderId: position.opened_by_order_id,
        positionId: position.id,
        scope: 'position',
        findings: ['position_metadata_missing'],
        expected: { openedByOrderId: 'present', instrumentId: 'present', timeframe: 'present' },
        actual: {
          openedByOrderId: position.opened_by_order_id,
          instrumentId: position.instrument_id,
          timeframe: position.timeframe,
        },
        nowMs: args.nowMs,
      });
      collector.add('reconciliation_mismatch', { findings: ['position_metadata_missing'] });
      await this.flushEvents({
        userId: args.userId,
        executionProfileId: position.execution_profile_id,
        positionId: position.id,
        setupId: position.setup_id,
        events: collector,
        nowMs: args.nowMs,
        meta: args.meta,
      });
      return null;
    }

    const timeframe = position.timeframe as Timeframe;
    const candles = await this.deps.market.candlesSince({
      instrumentId: position.instrument_id,
      timeframe,
      sinceMs: position.opened_at.getTime(),
      nowMs: args.nowMs,
      limit: 500,
    });
    const spec = await this.loadInstrumentSpec(position.asset_class, position.symbol);
    if (!spec) {
      await this.recordReconciliation({
        userId: args.userId,
        executionProfileId: position.execution_profile_id,
        orderId: position.opened_by_order_id,
        positionId: position.id,
        scope: 'position',
        findings: ['position_metadata_missing'],
        expected: { instrumentRiskSpec: 'present' },
        actual: { instrumentRiskSpec: 'missing' },
        nowMs: args.nowMs,
      });
      return null;
    }

    const stopLoss = numOrNull(position.stop_loss_price);
    const takeProfit = numOrNull(position.take_profit_price);
    const lastCandle: PaperCandle | undefined = candles[candles.length - 1];

    let detection: ReturnType<typeof detectExit> = null;
    if (!args.forceClose && stopLoss !== null && takeProfit !== null) {
      detection = detectExit({
        direction: position.direction,
        stopLossPrice: stopLoss,
        takeProfitPrice: takeProfit,
        candles,
      });
    }

    if (args.forceClose || detection) {
      const exitReason: PaperExitReason = args.forceClose
        ? 'close'
        : (detection?.reason as PaperExitReason);
      if (detection?.conflict) {
        // An ambiguous bar (both levels touched) is recorded and resolved
        // CONSERVATIVELY at the stop — never in the trader's favour.
        collector.add('paper_sl_tp_conflict', {
          candleTime: detection.candleTime,
          stopLossPrice: stopLoss,
          takeProfitPrice: takeProfit,
          resolution: 'stop_loss',
          simulated: true,
        });
      }
      const referencePrice = args.forceClose
        ? await this.requireFreshClose(position.instrument_id, timeframe, args.nowMs, collector)
        : (exitReason === 'stop_loss' ? stopLoss : takeProfit) as number;
      if (referencePrice === null) {
        await this.flushEvents({
          userId: args.userId,
          executionProfileId: position.execution_profile_id,
          positionId: position.id,
          setupId: position.setup_id,
          events: collector,
          nowMs: args.nowMs,
          meta: args.meta,
        });
        return null;
      }
      return this.submitExitOrder({
        userId: args.userId,
        position,
        kind: exitReason,
        quantity: Number(position.quantity),
        referencePrice,
        referencePriceMs: args.forceClose ? args.nowMs : (lastCandle?.time ?? args.nowMs),
        spec,
        timeframe,
        nowMs: args.nowMs,
        meta: args.meta,
        collector,
      });
    }

    // No exit: refresh the mark price and unrealized P&L from server data.
    if (!lastCandle) return null;
    const entry = Dec.fromNumber(Number(position.average_entry_price));
    const mark = Dec.fromNumber(lastCandle.close);
    const quantity = Dec.fromNumber(Number(position.quantity));
    if (!entry || !mark || !quantity) return null;
    const gross = unrealizedPl({
      direction: position.direction,
      entryPrice: entry,
      exitPrice: mark,
      markPrice: mark,
      quantity,
      spec,
    });
    if (!gross) return null;
    const unrealized = gross.toNumber(10);
    await this.pool.query(
      `UPDATE execution_positions
          SET unrealized_pl = $2, mark_price = $3, mark_price_ms = $4
        WHERE id = $1 AND status = 'open'`,
      [position.id, unrealized.toFixed(10), lastCandle.close, lastCandle.time],
    );
    return {
      progressed: true,
      positionId: position.id,
      exitReason: null,
      realizedPl: null,
      markPrice: lastCandle.close,
      order: null,
      fills: [],
      events: [],
    };
  }

  private async requireFreshClose(
    instrumentId: string,
    timeframe: Timeframe,
    nowMs: number,
    collector: AuditCollector,
  ): Promise<number | null> {
    const price = await this.deps.market.latestPrice({ instrumentId, timeframe, nowMs });
    if (!price.ok) {
      collector.add('paper_execution_rejected', {
        reason: price.reason,
        stale: price.stale,
        invalidData: price.invalidData,
      });
      return null;
    }
    return price.price.price;
  }

  /* ---------------------------------------------------------------------- */
  /* Provider-side fill (the ONLY way an order becomes a fill)              */
  /* ---------------------------------------------------------------------- */

  /**
   * Called by the paper provider adapter. The caller MUST present a
   * server-issued authorization id; there is no other way to reach this
   * method, and no way to reach it from client input.
   */
  async submitAuthorizedOrder(args: {
    authorizationId: string;
    request: ExecutionSubmitOrderRequest;
  }): Promise<ExecutionSubmitOrderOutcome> {
    const authorization = this.authorizations.get(args.authorizationId);
    if (authorization) this.authorizations.delete(args.authorizationId);
    if (!authorization || authorization.consumed) {
      throw new ExecutionProviderError(
        'validation',
        'no server-issued paper authorization for this order',
      );
    }
    if (this.clock() - authorization.createdMs > this.authorizationTtlMs) {
      throw new ExecutionProviderError('validation', 'paper authorization has expired');
    }
    if (
      authorization.clientOrderId !== args.request.clientOrderId ||
      authorization.idempotencyKey !== args.request.idempotencyKey ||
      authorization.symbol !== args.request.symbol ||
      authorization.side !== args.request.side ||
      Math.abs(authorization.quantity - args.request.quantity) > 1e-9 ||
      args.request.orderType !== 'market' ||
      args.request.requestedPrice !== null
    ) {
      throw new ExecutionProviderError(
        'validation',
        'paper order request does not match its server-issued authorization',
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const collector = new AuditCollector();

      // A concurrent twin may already hold the deterministic identity. The
      // unique index is the authority; this is the fast, friendly path.
      const existing = await client.query<OrderRow>(
        'SELECT * FROM execution_orders WHERE client_order_id = $1',
        [authorization.clientOrderId],
      );
      const existingOrder = existing.rows[0];
      if (existingOrder) {
        await client.query('ROLLBACK');
        return {
          providerOrderId: existingOrder.id,
          status: 'accepted',
          filledQuantity: Number(existingOrder.filled_quantity),
          averagePrice: numOrNull(existingOrder.average_fill_price),
          receipt: { replay: true, status: existingOrder.status },
        };
      }

      // Closing a paper position and updating the account ledger share these
      // locks with policy updates and risk evaluation. The user lock comes
      // first everywhere, preventing paperEquity from racing baseline setup.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'risk-policy',
        authorization.userId,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `risk:${authorization.userId}`,
        authorization.executionProfileId,
      ]);
      // Re-check after serialization: a concurrent close may have committed
      // while this transaction waited for the profile lock.
      const serializedExisting = await client.query<OrderRow>(
        'SELECT * FROM execution_orders WHERE client_order_id = $1',
        [authorization.clientOrderId],
      );
      const serializedOrder = serializedExisting.rows[0];
      if (serializedOrder) {
        await client.query('ROLLBACK');
        return {
          providerOrderId: serializedOrder.id,
          status: 'accepted',
          filledQuantity: Number(serializedOrder.filled_quantity),
          averagePrice: numOrNull(serializedOrder.average_fill_price),
          receipt: { replay: true, status: serializedOrder.status },
        };
      }
      const orderId = await this.insertOrder(client, authorization);

      if (this.failureMode.orderRejection || this.failureMode.fillFailure) {
        const reason = this.failureMode.orderRejection
          ? 'simulated order rejection (deterministic failure mode)'
          : 'simulated fill failure (deterministic failure mode)';
        for (const step of ORDER_FAILURE_STEPS) {
          assertOrderTransition(step.from, step.to);
          collector.add(
            step.event,
            { simulated: true },
            { fromStatus: step.from, toStatus: step.to, reason },
          );
        }
        await client.query(
          `UPDATE execution_orders SET status = 'failed', reject_reason = $2 WHERE id = $1`,
          [orderId, reason],
        );
        await this.persistEvents(client, {
          userId: authorization.userId,
          profileId: authorization.executionProfileId,
          orderId,
          positionId: authorization.positionId,
          setupId: authorization.setupId,
          events: collector,
          nowMs: authorization.createdMs,
        });
        await client.query('COMMIT');
        throw new ExecutionProviderError('rejected', reason);
      }

      const outcome = await this.fillOrder(client, { authorization, orderId, collector });
      await client.query('COMMIT');
      return outcome;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof PaperIntegrityError) {
        // Fail closed, loudly: the mutation is rolled back and the finding is
        // recorded in the append-only reconciliation trail for M8.5.
        await this.persistIntegrityFailure(authorization, err.findings).catch((persistErr) => {
          this.logger.warn('paper integrity finding could not be recorded', {
            findings: err.findings,
            error: persistErr instanceof Error ? persistErr.message : 'unknown',
          });
        });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertOrder(
    client: pg.PoolClient,
    authorization: PaperAuthorization,
  ): Promise<string> {
    const decision =
      authorization.kind === 'entry'
        ? authorization.decision
        : { ...authorization.decision, action: 'close_position' as const };
    const res = await client.query<{ id: string }>(
      `INSERT INTO execution_orders
         (user_id, execution_profile_id, execution_request_id, client_order_id, provider_slug,
          asset_class, symbol, side, order_type, quantity, requested_price, stop_loss_price,
          take_profit_price, filled_quantity, average_fill_price, status, reject_reason,
          idempotency_key, architecture_version, setup_id, risk_decision_id, decision, simulated,
          simulator_version, fees, slippage, reference_price, reference_price_ms,
          created_at, updated_at)
       VALUES ($1,$2,NULL,$3,'paper',$4,$5,$6,'market',$7,NULL,$8,$9,0,NULL,'requested',NULL,
               $10,$11,$12,$13,$14,true,$15,0,0,$16,$17,
               to_timestamp($18 / 1000.0), to_timestamp($18 / 1000.0))
       RETURNING id`,
      [
        authorization.userId,
        authorization.executionProfileId,
        authorization.clientOrderId,
        authorization.assetClass,
        authorization.symbol,
        authorization.side,
        authorization.quantity,
        decision.stopLossPrice,
        decision.takeProfitPrice,
        authorization.idempotencyKey,
        EXECUTION_ARCHITECTURE_VERSION,
        authorization.setupId,
        authorization.riskDecisionId,
        JSON.stringify(decision),
        PAPER_SIMULATOR_VERSION,
        authorization.referencePrice,
        authorization.referencePriceMs,
        authorization.createdMs,
      ],
    );
    const row = res.rows[0];
    if (!row) throw Errors.internal('paper order could not be created');
    return row.id;
  }

  private async fillOrder(
    client: pg.PoolClient,
    args: { authorization: PaperAuthorization; orderId: string; collector: AuditCollector },
  ): Promise<ExecutionSubmitOrderOutcome> {
    const { authorization, orderId, collector } = args;
    const quantity = Dec.fromNumber(authorization.quantity) as Dec;

    const fill = authorization.kind === 'entry'
      ? computeEntryFill({
          direction: authorization.decision.direction,
          referencePrice: Dec.fromNumber(authorization.referencePrice) as Dec,
          quantity,
          spec: authorization.spec,
          costs: this.costs,
        })
      : computeExitFill({
          direction: authorization.decision.direction,
          reason: authorization.kind,
          level: Dec.fromNumber(authorization.referencePrice) as Dec,
          referencePrice: Dec.fromNumber(authorization.referencePrice) as Dec,
          quantity,
          spec: authorization.spec,
          costs: this.costs,
        });
    if (!fill) {
      throw new ExecutionProviderError(
        'validation',
        'paper fill could not be computed from the server-supplied state',
      );
    }

    // Validate every transition BEFORE recording any of them.
    for (const step of ORDER_STEPS) assertOrderTransition(step.from, step.to);

    const filledAtMs = authorization.createdMs;
    await client.query(
      `UPDATE execution_orders
          SET status = 'filled', provider_order_id = id, filled_quantity = quantity,
              average_fill_price = $2, fees = $3, slippage = $4,
              submitted_at = to_timestamp($5 / 1000.0), filled_at = to_timestamp($5 / 1000.0),
              updated_at = to_timestamp($5 / 1000.0)
        WHERE id = $1`,
      [orderId, fill.price.toFixed(10), fill.fees.toFixed(10), fill.slippageCost.toFixed(10), filledAtMs],
    );

    let positionId: string;
    let positionApplied = true;
    let realizedPl: number | null = null;
    if (authorization.kind === 'entry') {
      positionId = await this.openPositionRow(client, { authorization, orderId, fill, collector, filledAtMs });
    } else {
      const closed = await this.closePositionRow(client, { authorization, orderId, fill, collector, filledAtMs });
      positionId = closed.positionId;
      positionApplied = closed.applied;
      realizedPl = closed.realizedPl;
    }

    // The position close and the authoritative risk-ledger increment are in
    // the same transaction. A rollback therefore cannot leave either side
    // committed, and replayed closes do not increment the ledger again.
    if (positionApplied && authorization.kind !== 'entry' && realizedPl !== null) {
      await this.deps.risk.recordRealizedPlInTransaction(client, {
        userId: authorization.userId,
        executionProfileId: authorization.executionProfileId,
        realizedPl,
        nowMs: filledAtMs,
      });
    }

    if (positionApplied) {
      const fillRes = await client.query<{ id: string }>(
        `INSERT INTO execution_fills
           (user_id, execution_profile_id, order_id, position_id, setup_id, sequence, fill_type,
            quantity, price, fees, slippage, reference_price, simulated, idempotency_key, created_at)
         VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,true,$12, to_timestamp($13 / 1000.0))
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          authorization.userId,
          authorization.executionProfileId,
          orderId,
          positionId,
          authorization.setupId,
          authorization.kind,
          authorization.quantity,
          fill.price.toFixed(10),
          fill.fees.toFixed(10),
          fill.slippageCost.toFixed(10),
          authorization.referencePrice,
          fillIdempotencyKey(authorization.idempotencyKey),
          filledAtMs,
        ],
      );
      if (!fillRes.rows[0]) {
        // The ledger already holds this exact fill: duplicate processing is a
        // no-op — never a second position and never a second P&L swing.
        collector.add('paper_fill_duplicate_ignored', { orderId });
      }
    }

    for (const step of ORDER_STEPS) {
      collector.add(
        step.event,
        { simulated: true },
        { fromStatus: step.from, toStatus: step.to },
      );
    }

    // Reconciliation INSIDE the transaction: a mismatch rolls the whole
    // mutation back, so an inconsistent financial state is never committed.
    const findings = await this.reconcileInTransaction(client, {
      userId: authorization.userId,
      executionProfileId: authorization.executionProfileId,
      orderId,
      positionId,
      collector,
      nowMs: filledAtMs,
    });
    if (findings.length > 0) {
      throw new PaperIntegrityError(findings);
    }

    // Persist the lifecycle + reconciliation events ONLY once the state is
    // known to be consistent (a mismatch rolls everything back above).
    await this.persistEvents(client, {
      userId: authorization.userId,
      profileId: authorization.executionProfileId,
      orderId,
      positionId,
      setupId: authorization.setupId,
      events: collector,
      nowMs: filledAtMs,
    });

    return {
      providerOrderId: orderId,
      status: 'accepted',
      filledQuantity: authorization.quantity,
      averagePrice: fill.price.toNumber(10),
      receipt: {
        simulatorVersion: PAPER_SIMULATOR_VERSION,
        fillPrice: fill.price.toFixed(10),
        fees: fill.fees.toFixed(10),
        slippage: fill.slippageCost.toFixed(10),
        referencePrice: authorization.referencePrice,
        referencePriceMs: authorization.referencePriceMs,
        replayed: !positionApplied,
      },
    };
  }

  private async openPositionRow(
    client: pg.PoolClient,
    args: {
      authorization: PaperAuthorization;
      orderId: string;
      fill: { price: Dec; fees: Dec; slippageCost: Dec };
      collector: AuditCollector;
      filledAtMs: number;
    },
  ): Promise<string> {
    const { authorization, orderId, fill, collector, filledAtMs } = args;
    const providerPositionId = paperProviderPositionId(authorization.positionKey);
    const res = await client.query<{ id: string }>(
      `INSERT INTO execution_positions
         (user_id, execution_profile_id, provider_slug, provider_position_id, asset_class, symbol,
          direction, quantity, average_entry_price, stop_loss_price, take_profit_price,
          realized_pl, unrealized_pl, status, opened_at, setup_id, opened_by_order_id,
          fees, slippage, mark_price, mark_price_ms, simulated, simulator_version, created_at, updated_at)
       VALUES ($1,$2,'paper',$3,$4,$5,$6,$7,$8,$9,$10,NULL,0,'open', to_timestamp($11 / 1000.0),
               $12,$13,$14,$15,$8,$16,true,$17, to_timestamp($11 / 1000.0), to_timestamp($11 / 1000.0))
       ON CONFLICT (execution_profile_id, provider_position_id) WHERE provider_position_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        authorization.userId,
        authorization.executionProfileId,
        providerPositionId,
        authorization.assetClass,
        authorization.symbol,
        authorization.decision.direction,
        authorization.quantity,
        fill.price.toFixed(10),
        authorization.decision.stopLossPrice,
        authorization.decision.takeProfitPrice,
        filledAtMs,
        authorization.setupId,
        orderId,
        fill.fees.toFixed(10),
        fill.slippageCost.toFixed(10),
        authorization.referencePriceMs,
        PAPER_SIMULATOR_VERSION,
      ],
    );
    const row = res.rows[0];
    if (row) {
      collector.add('position_opened', {
        direction: authorization.decision.direction,
        quantity: authorization.quantity,
        fillPrice: fill.price.toFixed(10),
        setupId: authorization.setupId,
        simulated: true,
      });
      return row.id;
    }
    // The position already exists for this identity: never duplicate it.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM execution_positions
        WHERE execution_profile_id = $1 AND provider_position_id = $2`,
      [authorization.executionProfileId, providerPositionId],
    );
    const existingId = existing.rows[0]?.id;
    if (!existingId) throw Errors.internal('paper position could not be resolved after conflict');
    collector.add('paper_fill_duplicate_ignored', { positionId: existingId });
    return existingId;
  }

  private async closePositionRow(
    client: pg.PoolClient,
    args: {
      authorization: PaperAuthorization;
      orderId: string;
      fill: { price: Dec; fees: Dec; slippageCost: Dec };
      collector: AuditCollector;
      filledAtMs: number;
    },
  ): Promise<{ positionId: string; applied: boolean; realizedPl: number | null }> {
    const { authorization, orderId, fill, collector, filledAtMs } = args;
    const positionId = authorization.positionId;
    if (!positionId) {
      throw new ExecutionProviderError('validation', 'exit order has no target position');
    }

    const current = await client.query<PositionRow>(
      'SELECT * FROM execution_positions WHERE id = $1 FOR UPDATE',
      [positionId],
    );
    const position = current.rows[0];
    if (!position) {
      collector.add('paper_position_missing', { positionId });
      throw new ExecutionProviderError('rejected', 'paper position to close was not found');
    }
    if (position.status !== 'open') {
      // Repeated exit processing: the position is already closed. No second
      // fill, no second P&L swing — the caller replays the stored outcome.
      collector.add('paper_fill_duplicate_ignored', { positionId, alreadyClosed: true });
      return { positionId, applied: false, realizedPl: null };
    }
    if (position.id !== authorization.positionId || position.symbol !== authorization.symbol) {
      throw new ExecutionProviderError('validation', 'exit authorization does not match the position');
    }

    const entryPrice = Dec.fromNumber(Number(position.average_entry_price));
    const quantity = Dec.fromNumber(Number(position.quantity));
    if (!entryPrice || !quantity) {
      throw new ExecutionProviderError('validation', 'paper position has invalid entry state');
    }
    const entryFees = Dec.fromString(position.fees) ?? Dec.zero();
    const gross = grossRealizedPl({
      direction: position.direction,
      entryPrice,
      exitPrice: fill.price,
      quantity,
      spec: authorization.spec,
    });
    if (!gross) throw new ExecutionProviderError('validation', 'realized P&L could not be computed');
    const net = netRealizedPl({ gross, entryFees, exitFees: fill.fees });
    if (!net) throw new ExecutionProviderError('validation', 'net P&L could not be computed');

    const totalFees = entryFees.add(fill.fees);
    const totalSlippage = (Dec.fromString(position.slippage) ?? Dec.zero()).add(fill.slippageCost);

    await client.query(
      `UPDATE execution_positions
          SET status = 'closed', exit_price = $2, exit_reason = $3, realized_pl = $4,
              unrealized_pl = 0, fees = $5, slippage = $6, closed_at = to_timestamp($7 / 1000.0),
              closed_by_order_id = $8, mark_price = $2, mark_price_ms = $9
        WHERE id = $1 AND status = 'open'`,
      [
        positionId,
        fill.price.toFixed(10),
        authorization.kind,
        net.toFixed(10),
        totalFees.toFixed(10),
        totalSlippage.toFixed(10),
        filledAtMs,
        orderId,
        authorization.referencePriceMs,
      ],
    );
    collector.add('position_closed', {
      exitReason: authorization.kind,
      exitPrice: fill.price.toFixed(10),
      realizedPl: net.toFixed(10),
      entryPrice: entryPrice.toFixed(10),
      quantity: quantity.toFixed(10),
      grossPl: gross.toFixed(10),
      fees: totalFees.toFixed(10),
      simulated: true,
    });
    return { positionId, applied: true, realizedPl: net.toNumber(10) };
  }

  private async submitExitOrder(args: {
    userId: string;
    position: LoadedPosition;
    kind: PaperExitReason;
    quantity: number;
    referencePrice: number;
    referencePriceMs: number;
    spec: InstrumentRiskSpec;
    timeframe: Timeframe;
    nowMs: number;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
    collector: AuditCollector;
  }): Promise<PaperPositionOutcomeDto | null> {
    const { position } = args;
    const identityHash = hashIdentity(
      executionIdempotencyKey({
        userId: args.userId,
        setupId: position.setup_id ?? position.id,
        executionProfileId: position.execution_profile_id,
        action: 'close_position',
      }),
    );
    const clientOrderId = paperClientOrderId(identityHash, args.kind);
    const orderIdempotency = orderIdempotencyKey(identityHash, args.kind, 1);

    // Repeated SL/TP processing is a no-op: an existing exit order is replayed.
    const existing = await this.pool.query<OrderRow>(
      'SELECT * FROM execution_orders WHERE client_order_id = $1',
      [clientOrderId],
    );
    if (existing.rows[0]) {
      const order = existing.rows[0];
      const fills = await this.loadFillsForOrder(order.id);
      const current = await this.loadPositionById(args.userId, position.id);
      return {
        progressed: false,
        positionId: position.id,
        exitReason: (current?.exit_reason as PaperExitReason) ?? null,
        realizedPl: current ? numOrNull(current.realized_pl) : null,
        markPrice: current ? numOrNull(current.mark_price) : null,
        order: toPaperOrderDto(order),
        fills: fills.map(toFillDto),
        events: [],
      };
    }

    const openingDecision = position.opening_decision as ExecutionDecisionInput | null;
    if (!openingDecision) {
      await this.recordReconciliation({
        userId: args.userId,
        executionProfileId: position.execution_profile_id,
        orderId: position.opened_by_order_id,
        positionId: position.id,
        scope: 'position',
        findings: ['position_metadata_missing'],
        expected: { openingDecision: 'present' },
        actual: { openingDecision: 'missing' },
        nowMs: args.nowMs,
      });
      return null;
    }

    const side: OrderSide = position.direction === 'long' ? 'sell' : 'buy';
    const authorization = this.createAuthorization({
      userId: args.userId,
      executionProfileId: position.execution_profile_id,
      setupId: position.setup_id ?? position.id,
      instrumentId: position.instrument_id as string,
      assetClass: position.asset_class as AssetClass,
      symbol: position.symbol,
      side,
      kind: args.kind,
      quantity: args.quantity,
      clientOrderId,
      idempotencyKey: orderIdempotency,
      decision: {
        ...openingDecision,
        action: 'close_position',
        entryPrice: Number(position.average_entry_price),
        stopLossPrice: Number(position.stop_loss_price),
        takeProfitPrice: Number(position.take_profit_price),
      },
      riskDecisionId: position.risk_decision_id,
      engineVersion: RISK_ENGINE_VERSION,
      positionId: position.id,
      positionKey: identityHash,
      referencePrice: args.referencePrice,
      referencePriceMs: args.referencePriceMs,
      spec: args.spec,
      timeframe: args.timeframe,
    });

    const request: ExecutionSubmitOrderRequest = {
      clientOrderId,
      idempotencyKey: orderIdempotency,
      authorizationId: authorization.id,
      assetClass: position.asset_class as AssetClass,
      symbol: position.symbol,
      side,
      orderType: 'market',
      quantity: args.quantity,
      requestedPrice: null,
      stopLossPrice: Number(position.stop_loss_price),
      takeProfitPrice: Number(position.take_profit_price),
    };

    const provider = this.deps.provider();
    try {
      if (provider) await provider.submitOrder(request);
    } catch (err) {
      if (!isExecutionProviderError(err)) throw err;
      await this.persistExitFailure({
        userId: args.userId,
        profileId: position.execution_profile_id,
        positionId: position.id,
        setupId: position.setup_id,
        reason: err.message,
        nowMs: args.nowMs,
        meta: args.meta,
      });
      return {
        progressed: false,
        positionId: position.id,
        exitReason: null,
        realizedPl: null,
        markPrice: null,
        order: null,
        fills: [],
        events: ['paper_exit_failed'],
      };
    }

    const updatedPosition = await this.loadPositionById(args.userId, position.id);
    const orderRow = await this.pool.query<OrderRow>(
      'SELECT * FROM execution_orders WHERE client_order_id = $1',
      [clientOrderId],
    );
    const fills = orderRow.rows[0] ? await this.loadFillsForOrder(orderRow.rows[0].id) : [];
    const realized = updatedPosition ? numOrNull(updatedPosition.realized_pl) : null;

    // Simulated P&L is accounted for inside fillOrder's transaction. Keep
    // this audit entry after the commit so audit failure cannot roll back the
    // already-committed financial mutation or double-count it on replay.
    if (realized !== null && updatedPosition?.status === 'closed') {
      await this.deps.audit.log({
        userId: args.userId,
        action: 'execution.paper_position_closed',
        entityType: 'execution_position',
        entityId: position.id,
        ip: args.meta?.ip ?? null,
        userAgent: args.meta?.userAgent ?? null,
        metadata: {
          exitReason: args.kind,
          realizedPl: realized,
          simulated: true,
          simulatorVersion: PAPER_SIMULATOR_VERSION,
        },
      });
    }

    // Exit-path observations (for example a conservative SL/TP conflict on an
    // ambiguous bar) are part of the append-only trail, not just the response.
    if (args.collector.names().length > 0) {
      await this.flushEvents({
        userId: args.userId,
        executionProfileId: position.execution_profile_id,
        orderId: orderRow.rows[0]?.id ?? null,
        positionId: position.id,
        setupId: position.setup_id,
        events: args.collector,
        nowMs: args.nowMs,
        meta: args.meta,
      });
    }

    return {
      progressed: true,
      positionId: position.id,
      exitReason: updatedPosition?.status === 'closed' ? args.kind : null,
      realizedPl: realized,
      markPrice: updatedPosition ? numOrNull(updatedPosition.mark_price) : null,
      order: orderRow.rows[0] ? toPaperOrderDto(orderRow.rows[0]) : null,
      fills: fills.map(toFillDto),
      events: args.collector.names(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Reconciliation (explicit, on demand)                                   */
  /* ---------------------------------------------------------------------- */

  /** Owner-scoped reconciliation sweep. Never mutates financial state. */
  async reconcile(args: { userId: string; nowMs?: number }): Promise<{
    ok: boolean;
    findings: string[];
    reconciliations: ReconciliationDto[];
  }> {
    const nowMs = args.nowMs ?? Date.now();
    const orders = await this.pool.query<OrderRow>(
      `SELECT * FROM execution_orders WHERE user_id = $1 AND simulated
        ORDER BY created_at DESC LIMIT 200`,
      [args.userId],
    );
    const positions = await this.pool.query<PositionRow>(
      `SELECT * FROM execution_positions WHERE user_id = $1 AND simulated
        ORDER BY opened_at DESC LIMIT 200`,
      [args.userId],
    );
    const fills = await this.pool.query<FillRow>(
      `SELECT * FROM execution_fills WHERE user_id = $1 AND simulated
        ORDER BY created_at DESC LIMIT 1000`,
      [args.userId],
    );
    const fillStates = fills.rows.map(toFillState);
    const orderById = new Map(orders.rows.map((o) => [o.id, toOrderState(o)]));

    const findings: string[] = [];
    const written: ReconciliationRow[] = [];

    for (const order of orders.rows) {
      const result = reconcileOrderState({ order: toOrderState(order), fills: fillStates });
      findings.push(...result.findings);
      written.push(
        await this.recordReconciliation({
          userId: args.userId,
          executionProfileId: order.execution_profile_id,
          orderId: order.id,
          positionId: null,
          scope: 'order',
          findings: result.findings,
          expected: result.expected,
          actual: result.actual,
          nowMs,
        }),
      );
    }

    for (const position of positions.rows) {
      const spec = await this.loadInstrumentSpec(position.asset_class, position.symbol);
      const result = reconcilePositionState({
        position: toPositionState(position),
        openingOrder: position.opened_by_order_id
          ? orderById.get(position.opened_by_order_id) ?? null
          : null,
        closingOrder: position.closed_by_order_id
          ? orderById.get(position.closed_by_order_id) ?? null
          : null,
        fills: fillStates,
        spec,
      });
      findings.push(...result.findings);
      written.push(
        await this.recordReconciliation({
          userId: args.userId,
          executionProfileId: position.execution_profile_id,
          orderId: position.opened_by_order_id,
          positionId: position.id,
          scope: 'position',
          findings: result.findings,
          expected: result.expected,
          actual: result.actual,
          nowMs,
        }),
      );
    }

    const unique = [...new Set(findings)];

    // The sweep appends its own reconciliation events: one per impossible
    // state (with the findings) and a single summary "passed" for the rest.
    const collector = new AuditCollector();
    const mismatched = written.filter((row) => row.outcome === 'mismatch');
    for (const row of mismatched) {
      collector.add('reconciliation_mismatch', {
        scope: row.scope,
        findings: row.findings,
        orderId: row.order_id,
        positionId: row.position_id,
      });
    }
    if (mismatched.length < written.length) {
      collector.add('reconciliation_passed', {
        scope: 'sweep',
        checked: written.length - mismatched.length,
      });
    }
    if (written.length > 0) {
      await this.flushEvents({
        userId: args.userId,
        executionProfileId: null,
        events: collector,
        nowMs,
      });
    }

    return {
      ok: unique.length === 0,
      findings: unique,
      reconciliations: written.map(toReconciliationDto),
    };
  }

  private async reconcileInTransaction(
    client: pg.PoolClient,
    args: {
      userId: string;
      executionProfileId: string;
      orderId: string;
      positionId: string;
      collector: AuditCollector;
      nowMs: number;
    },
  ): Promise<string[]> {
    const orderRes = await client.query<OrderRow>('SELECT * FROM execution_orders WHERE id = $1', [
      args.orderId,
    ]);
    const order = orderRes.rows[0];
    if (!order) return ['order_filled_but_no_fill_row'];

    const orderFills = await client.query<FillRow>(
      'SELECT * FROM execution_fills WHERE order_id = $1 ORDER BY sequence ASC',
      [args.orderId],
    );
    const orderResult = reconcileOrderState({
      order: toOrderState(order),
      fills: orderFills.rows.map(toFillState),
    });
    const findings = [...orderResult.findings];

    const positionRes = await client.query<PositionRow>(
      'SELECT * FROM execution_positions WHERE id = $1',
      [args.positionId],
    );
    const position = positionRes.rows[0];
    if (!position) {
      findings.push('position_missing');
    } else {
      const positionFills = await client.query<FillRow>(
        'SELECT * FROM execution_fills WHERE position_id = $1 ORDER BY sequence ASC',
        [args.positionId],
      );
      // The order being filled may be the EXIT order: a position is always
      // reconciled against its opening order (direction/symbol/provenance),
      // with the current order reported separately as the closing order.
      const openingOrderRes = position.opened_by_order_id
        ? await client.query<OrderRow>('SELECT * FROM execution_orders WHERE id = $1', [
            position.opened_by_order_id,
          ])
        : { rows: [] as OrderRow[] };
      const openingOrder = openingOrderRes.rows[0] ?? null;
      const closingOrder = order.id !== position.opened_by_order_id ? order : null;
      const spec = await this.loadInstrumentSpec(position.asset_class, position.symbol);
      const positionResult = reconcilePositionState({
        position: toPositionState(position),
        openingOrder: openingOrder ? toOrderState(openingOrder) : null,
        closingOrder: closingOrder ? toOrderState(closingOrder) : null,
        fills: positionFills.rows.map(toFillState),
        spec,
      });
      findings.push(...positionResult.findings);
      await this.writeReconciliationRow(client, {
        userId: args.userId,
        executionProfileId: args.executionProfileId,
        orderId: args.orderId,
        positionId: args.positionId,
        scope: 'position',
        findings: positionResult.findings,
        expected: positionResult.expected,
        actual: positionResult.actual,
        nowMs: args.nowMs,
      });
    }

    await this.writeReconciliationRow(client, {
      userId: args.userId,
      executionProfileId: args.executionProfileId,
      orderId: args.orderId,
      positionId: args.positionId,
      scope: 'order',
      findings: orderResult.findings,
      expected: orderResult.expected,
      actual: orderResult.actual,
      nowMs: args.nowMs,
    });

    const unique = [...new Set(findings)];
    if (unique.length > 0) {
      args.collector.add('reconciliation_mismatch', { findings: unique });
    } else {
      args.collector.add('reconciliation_passed', { scope: 'order+position' });
    }
    return unique;
  }

  /* ---------------------------------------------------------------------- */
  /* internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async automatedPathGate(
    userId: string,
    provider: ExecutionProvider | undefined,
    health: { healthy: boolean } | null,
  ): Promise<string | null> {
    // Informational: which M8.1 gate refuses the AUTOMATED path today. Uses
    // the real gate service (never a re-implementation) with a null decision,
    // because in this platform the automation gates always refuse first.
    const { entitlements, automationEnabled } = await this.deps.automation.readState(userId);
    const killSwitches = await this.deps.killSwitches.anyActive({ userId });
    const result = evaluateExecutionGates({
      authenticated: true,
      authorized: true,
      entitlements,
      automation: { entitled: entitlements.canAccessAutomation, automationEnabled },
      profile: null,
      killSwitches,
      decision: null,
      setup: null,
      instrumentKnown: false,
      riskDecision: null,
      minRr: null,
      exposureWithinLimits: null,
      providerHealth: provider && health ? { healthy: health.healthy } : null,
      environmentSafe: true,
      brokerAuthorized: true,
      accountAuthorized: true,
    });
    return result.failedGate;
  }

  private async failedAttemptCount(
    userId: string,
    profileId: string,
    setupId: string,
  ): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM execution_orders
        WHERE user_id = $1 AND execution_profile_id = $2 AND setup_id = $3 AND simulated
          AND status IN ('failed', 'rejected')
          AND (decision ->> 'action') IS DISTINCT FROM 'close_position'`,
      [userId, profileId, setupId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  private createAuthorization(
    args: Omit<PaperAuthorization, 'id' | 'consumed' | 'createdMs'>,
  ): PaperAuthorization {
    const authorization: PaperAuthorization = {
      id: randomUUID(),
      consumed: false,
      createdMs: this.clock(),
      ...args,
    };
    this.authorizations.set(authorization.id, authorization);
    // Bound the in-memory map: authorizations are single-use and short-lived.
    if (this.authorizations.size > 500) {
      const cutoff = authorization.createdMs - this.authorizationTtlMs;
      for (const [id, auth] of this.authorizations) {
        if (auth.createdMs < cutoff) this.authorizations.delete(id);
      }
    }
    return authorization;
  }

  private async validateCitedDecision(args: {
    userId: string;
    executionProfileId: string;
    setupId: string;
    decision: ExecutionDecisionInput;
    riskDecisionId: string | null;
    nowMs: number;
  }): Promise<
    | { kind: 'fresh' }
    | { kind: 'not_found' }
    | { kind: 'rejected'; reason: string; decisionId: string; engineVersion: string }
  > {
    if (!args.riskDecisionId) return { kind: 'fresh' };
    const res = await this.pool.query<{
      id: string;
      user_id: string;
      execution_profile_id: string | null;
      setup_id: string | null;
      outcome: 'approved' | 'rejected';
      rejection_code: string | null;
      engine_version: string;
      entry_price: string;
      stop_loss_price: string;
      take_profit_price: string;
      evaluated_at: Date;
    }>('SELECT * FROM risk_decisions WHERE id = $1', [args.riskDecisionId]);
    const row = res.rows[0];
    // Unknown or foreign decisions are masked exactly like every other
    // owner-scoped resource: the caller learns nothing about other tenants.
    if (!row || row.user_id !== args.userId) return { kind: 'not_found' };

    const mismatched =
      row.execution_profile_id !== args.executionProfileId ||
      row.setup_id !== args.setupId ||
      row.engine_version !== RISK_ENGINE_VERSION ||
      Math.abs(Number(row.entry_price) - args.decision.entryPrice) > 1e-9 ||
      Math.abs(Number(row.stop_loss_price) - args.decision.stopLossPrice) > 1e-9 ||
      Math.abs(Number(row.take_profit_price) - args.decision.takeProfitPrice) > 1e-9;
    if (mismatched) {
      return {
        kind: 'rejected',
        reason:
          'cited risk decision does not match this setup/profile or the pinned risk engine version',
        decisionId: row.id,
        engineVersion: row.engine_version,
      };
    }
    if (args.nowMs - row.evaluated_at.getTime() > PAPER_RISK_DECISION_MAX_AGE_MS) {
      return {
        kind: 'rejected',
        reason: 'cited risk decision has expired',
        decisionId: row.id,
        engineVersion: row.engine_version,
      };
    }
    if (row.outcome !== 'approved') {
      return {
        kind: 'rejected',
        reason: `cited risk decision rejected the execution (${row.rejection_code ?? 'unknown'})`,
        decisionId: row.id,
        engineVersion: row.engine_version,
      };
    }
    return { kind: 'fresh' };
  }

  private async loadInstrumentSpec(
    assetClass: string,
    symbol: string,
  ): Promise<InstrumentRiskSpec | null> {
    const res = await this.pool.query<{
      asset_class: string;
      symbol: string;
      contract_size: string;
      pip_size: string;
      pnl_mode: string;
      quote_currency: string;
      min_quantity: string;
      quantity_step: string;
      max_quantity: string;
    }>(
      `SELECT i.asset_class, i.symbol, s.contract_size, s.pip_size, s.pnl_mode, s.quote_currency,
              s.min_quantity, s.quantity_step, s.max_quantity
         FROM instrument_risk_specs s
         JOIN instruments i ON i.id = s.instrument_id
        WHERE i.asset_class = $1 AND i.symbol = $2`,
      [assetClass, symbol],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      assetClass: row.asset_class as InstrumentRiskSpec['assetClass'],
      symbol: row.symbol,
      contractSize: Number(row.contract_size),
      pipSize: Number(row.pip_size),
      pnlMode: row.pnl_mode as InstrumentRiskSpec['pnlMode'],
      quoteCurrency: row.quote_currency,
      minQuantity: Number(row.min_quantity),
      quantityStep: Number(row.quantity_step),
      maxQuantity: Number(row.max_quantity),
    };
  }

  private async loadOpenPositions(userId: string): Promise<LoadedPosition[]> {
    const res = await this.pool.query<LoadedPosition>(POSITION_QUERY + ` AND p.status = 'open' AND p.simulated
        ORDER BY p.opened_at ASC LIMIT 200`, [userId]);
    return res.rows;
  }

  private async loadPosition(
    userId: string,
    positionId: string,
  ): Promise<LoadedPosition | null> {
    const res = await this.pool.query<LoadedPosition>(
      POSITION_QUERY + ` AND p.user_id = $1 AND p.id = $2`,
      [userId, positionId],
    );
    return res.rows[0] ?? null;
  }

  private async loadPositionById(userId: string, positionId: string): Promise<PositionRow | null> {
    const res = await this.pool.query<PositionRow>(
      'SELECT * FROM execution_positions WHERE id = $1 AND user_id = $2',
      [positionId, userId],
    );
    return res.rows[0] ?? null;
  }

  private async loadFillsForOrder(orderId: string): Promise<FillRow[]> {
    const res = await this.pool.query<FillRow>(
      'SELECT * FROM execution_fills WHERE order_id = $1 ORDER BY sequence ASC',
      [orderId],
    );
    return res.rows;
  }

  private async persistExitFailure(args: {
    userId: string;
    profileId: string;
    positionId: string;
    setupId: string | null;
    reason: string;
    nowMs: number;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO execution_events
         (user_id, execution_profile_id, setup_id, position_id, event, reason, metadata, ip, user_agent, created_at)
       VALUES ($1,$2,$3,$4,'paper_exit_failed',$5,$6,$7,$8, to_timestamp($9 / 1000.0))`,
      [
        args.userId,
        args.profileId,
        args.setupId,
        args.positionId,
        args.reason,
        JSON.stringify({ simulated: true, simulatorVersion: PAPER_SIMULATOR_VERSION }),
        args.meta?.ip ?? null,
        args.meta?.userAgent ?? null,
        args.nowMs,
      ],
    );
    this.logger.warn('paper exit failed', { positionId: args.positionId, reason: args.reason });
  }

  /**
   * Record an integrity finding after the mutation transaction was rolled
   * back. Uses a fresh connection (the failed transaction is gone) and never
   * touches order, position or P&L rows.
   */
  private async persistIntegrityFailure(
    authorization: PaperAuthorization,
    findings: string[],
  ): Promise<void> {
    await this.recordReconciliation({
      userId: authorization.userId,
      executionProfileId: authorization.executionProfileId,
      orderId: null,
      positionId: null,
      scope: 'order',
      findings,
      expected: { integrity: 'consistent' },
      actual: { integrity: 'inconsistent', clientOrderId: authorization.clientOrderId },
      nowMs: authorization.createdMs,
    });
    await this.pool.query(
      `INSERT INTO execution_events
         (user_id, execution_profile_id, setup_id, event, reason, metadata, created_at)
       VALUES ($1,$2,$3,'reconciliation_mismatch',$4,$5, to_timestamp($6 / 1000.0))`,
      [
        authorization.userId,
        authorization.executionProfileId,
        authorization.setupId,
        `no financial state was written (${findings.join(', ')})`,
        JSON.stringify({
          findings,
          clientOrderId: authorization.clientOrderId,
          simulated: true,
          simulatorVersion: PAPER_SIMULATOR_VERSION,
          failedClosed: true,
        }),
        authorization.createdMs,
      ],
    );
    this.logger.warn('paper execution failed an integrity check and rolled back', {
      findings,
      clientOrderId: authorization.clientOrderId,
    });
  }

  private async refuse(args: {
    userId: string;
    profileId: string | null;
    setupId: string | null;
    gate: PaperSimulationGateId | null;
    reason: string;
    nowMs: number;
    collector: AuditCollector;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
    extra?: Record<string, unknown>;
  }): Promise<PaperSimulationResultDto> {
    args.collector.add('paper_execution_rejected', {
      gate: args.gate,
      reason: args.reason,
      ...args.extra,
    });
    await this.flushEvents({
      userId: args.userId,
      executionProfileId: args.profileId,
      setupId: args.setupId,
      events: args.collector,
      nowMs: args.nowMs,
      meta: args.meta,
    });
    await this.deps.audit.log({
      userId: args.userId,
      action: 'execution.paper_rejected',
      entityType: 'execution_request',
      entityId: args.setupId,
      ip: args.meta?.ip ?? null,
      userAgent: args.meta?.userAgent ?? null,
      metadata: {
        gate: args.gate,
        reason: args.reason,
        setupId: args.setupId,
        executionProfileId: args.profileId,
        simulated: false,
        automationOff: true,
      },
    });
    this.logger.info('paper simulation refused', {
      userId: args.userId,
      gate: args.gate,
      reason: args.reason,
    });
    return {
      simulated: false,
      replayed: false,
      simulatorVersion: PAPER_SIMULATOR_VERSION,
      gate: args.gate,
      reason: args.reason,
      setupId: args.setupId,
      executionProfileId: args.profileId,
      riskDecisionId: (args.extra?.riskDecisionId as string | undefined) ?? null,
      riskEngineVersion: RISK_ENGINE_VERSION,
      positionSize: null,
      order: null,
      position: null,
      fills: [],
      events: args.collector.names(),
      automationOff: true,
      automatedPathGate: (args.extra?.automatedPathGate as string | undefined) ?? null,
    };
  }

  private async replayResult(
    userId: string,
    setupId: string,
    profileId: string,
    order: OrderRow,
    collector: AuditCollector,
  ): Promise<PaperSimulationResultDto> {
    const fills = await this.loadFillsForOrder(order.id);
    const positionRes = await this.pool.query<PositionRow>(
      `SELECT * FROM execution_positions
        WHERE execution_profile_id = $1 AND (opened_by_order_id = $2 OR closed_by_order_id = $2)
        ORDER BY opened_at DESC LIMIT 1`,
      [order.execution_profile_id, order.id],
    );
    const position = positionRes.rows[0] ?? null;
    collector.add('paper_order_replayed', { orderId: order.id, status: order.status });
    await this.flushEvents({
      userId,
      executionProfileId: profileId,
      setupId,
      orderId: order.id,
      positionId: position?.id ?? null,
      events: collector,
      nowMs: Date.now(),
    });
    return {
      simulated: order.status === 'filled',
      replayed: true,
      simulatorVersion: PAPER_SIMULATOR_VERSION,
      gate: null,
      reason: null,
      setupId,
      executionProfileId: profileId,
      riskDecisionId: order.risk_decision_id,
      riskEngineVersion: RISK_ENGINE_VERSION,
      positionSize: Number(order.filled_quantity) > 0 ? Number(order.filled_quantity) : Number(order.quantity),
      order: toPaperOrderDto(order),
      position: position ? toPaperPositionDto(position) : null,
      fills: fills.map(toFillDto),
      events: collector.names(),
      automationOff: true,
      automatedPathGate: null,
    };
  }

  private async completedResult(args: {
    userId: string;
    setupId: string;
    executionProfileId: string;
    clientOrderId: string;
    riskDecisionId: string;
    riskEngineVersion: string;
    positionSize: number;
    automatedPathGate: string | null;
    nowMs: number;
    collector: AuditCollector;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
  }): Promise<PaperSimulationResultDto> {
    const orderRes = await this.pool.query<OrderRow>(
      'SELECT * FROM execution_orders WHERE client_order_id = $1',
      [args.clientOrderId],
    );
    const order = orderRes.rows[0];
    const fills = order ? await this.loadFillsForOrder(order.id) : [];
    const positionRes = order
      ? await this.pool.query<PositionRow>(
          'SELECT * FROM execution_positions WHERE opened_by_order_id = $1 LIMIT 1',
          [order.id],
        )
      : { rows: [] as PositionRow[] };
    const position = positionRes.rows[0] ?? null;

    // The per-order events were written inside the fill transaction; this
    // attempt-level event ties the simulation to its audit entry.
    args.collector.add('paper_result_recorded', {
      orderId: order?.id ?? null,
      status: order?.status ?? null,
      simulated: order?.status === 'filled',
    });
    await this.flushEvents({
      userId: args.userId,
      executionProfileId: args.executionProfileId,
      setupId: args.setupId,
      orderId: order?.id ?? null,
      positionId: position?.id ?? null,
      events: args.collector,
      nowMs: args.nowMs,
      meta: args.meta,
    });

    if (order) {
      await this.deps.audit.log({
        userId: args.userId,
        action: 'execution.paper_simulated',
        entityType: 'execution_order',
        entityId: order.id,
        ip: args.meta?.ip ?? null,
        userAgent: args.meta?.userAgent ?? null,
        metadata: {
          setupId: args.setupId,
          executionProfileId: args.executionProfileId,
          side: order.side,
          quantity: Number(order.quantity),
          status: order.status,
          riskDecisionId: args.riskDecisionId,
          simulatorVersion: PAPER_SIMULATOR_VERSION,
          automationOff: true,
        },
      });
    }
    this.logger.info('paper simulation completed', {
      userId: args.userId,
      setupId: args.setupId,
      orderId: order?.id ?? null,
      status: order?.status ?? null,
    });

    return {
      simulated: order?.status === 'filled',
      replayed: false,
      simulatorVersion: PAPER_SIMULATOR_VERSION,
      gate: null,
      reason: null,
      setupId: args.setupId,
      executionProfileId: args.executionProfileId,
      riskDecisionId: args.riskDecisionId,
      riskEngineVersion: args.riskEngineVersion,
      positionSize: args.positionSize,
      order: order ? toPaperOrderDto(order) : null,
      position: position ? toPaperPositionDto(position) : null,
      fills: fills.map(toFillDto),
      events: args.collector.names(),
      automationOff: true,
      automatedPathGate: args.automatedPathGate,
    };
  }

  private async persistEvents(
    client: pg.PoolClient,
    args: {
      userId: string;
      profileId: string | null;
      events: AuditCollector;
      nowMs: number;
      orderId?: string | null;
      positionId?: string | null;
      setupId?: string | null;
    },
  ): Promise<void> {
    for (const entry of args.events.entries()) {
      await client.query(
        `INSERT INTO execution_events
           (user_id, execution_profile_id, order_id, position_id, setup_id, event, from_status,
            to_status, reason, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_timestamp($11 / 1000.0))`,
        [
          args.userId,
          args.profileId,
          args.orderId ?? null,
          args.positionId ?? null,
          args.setupId ?? null,
          entry.event,
          entry.fromStatus ?? null,
          entry.toStatus ?? null,
          entry.reason ?? null,
          JSON.stringify({ ...entry.metadata, simulatorVersion: PAPER_SIMULATOR_VERSION }),
          args.nowMs,
        ],
      );
    }
  }

  private async flushEvents(args: {
    userId: string;
    executionProfileId: string | null;
    events: AuditCollector;
    nowMs: number;
    orderId?: string | null;
    positionId?: string | null;
    setupId?: string | null;
    meta?: Pick<AuditEntry, 'ip' | 'userAgent'>;
  }): Promise<void> {
    for (const entry of args.events.entries()) {
      await this.pool.query(
        `INSERT INTO execution_events
           (user_id, execution_profile_id, order_id, position_id, setup_id, event, from_status,
            to_status, reason, metadata, ip, user_agent, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, to_timestamp($13 / 1000.0))`,
        [
          args.userId,
          args.executionProfileId,
          args.orderId ?? null,
          args.positionId ?? null,
          args.setupId ?? null,
          entry.event,
          entry.fromStatus ?? null,
          entry.toStatus ?? null,
          entry.reason ?? null,
          JSON.stringify({ ...entry.metadata, simulatorVersion: PAPER_SIMULATOR_VERSION }),
          args.meta?.ip ?? null,
          args.meta?.userAgent ?? null,
          args.nowMs,
        ],
      );
    }
  }

  private async writeReconciliationRow(
    q: pg.PoolClient | pg.Pool,
    args: {
      userId: string;
      executionProfileId: string;
      orderId: string | null;
      positionId: string | null;
      scope: 'order' | 'position';
      findings: readonly string[];
      expected: Record<string, unknown>;
      actual: Record<string, unknown>;
      nowMs: number;
    },
  ): Promise<void> {
    await q.query(
      `INSERT INTO execution_reconciliations
         (user_id, execution_profile_id, order_id, position_id, scope, outcome, findings,
          expected, actual, simulator_version, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_timestamp($11 / 1000.0))`,
      [
        args.userId,
        args.executionProfileId,
        args.orderId,
        args.positionId,
        args.scope,
        args.findings.length === 0 ? 'ok' : 'mismatch',
        JSON.stringify(args.findings),
        JSON.stringify(args.expected),
        JSON.stringify(args.actual),
        PAPER_SIMULATOR_VERSION,
        args.nowMs,
      ],
    );
  }

  private async recordReconciliation(args: {
    userId: string;
    executionProfileId: string;
    orderId: string | null;
    positionId: string | null;
    scope: 'order' | 'position';
    findings: readonly string[];
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
    nowMs: number;
  }): Promise<ReconciliationRow> {
    const res = await this.pool.query<ReconciliationRow>(
      `INSERT INTO execution_reconciliations
         (user_id, execution_profile_id, order_id, position_id, scope, outcome, findings,
          expected, actual, simulator_version, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_timestamp($11 / 1000.0))
       RETURNING *`,
      [
        args.userId,
        args.executionProfileId,
        args.orderId,
        args.positionId,
        args.scope,
        args.findings.length === 0 ? 'ok' : 'mismatch',
        JSON.stringify(args.findings),
        JSON.stringify(args.expected),
        JSON.stringify(args.actual),
        PAPER_SIMULATOR_VERSION,
        args.nowMs,
      ],
    );
    return res.rows[0] as ReconciliationRow;
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const POSITION_QUERY = `
  SELECT p.*, i.id AS instrument_id, o.decision AS opening_decision,
         o.risk_decision_id AS risk_decision_id,
         v.strategy_id AS strategy_id, st.strategy_version_id AS strategy_version_id,
         coalesce(
           (SELECT tf.timeframe FROM strategy_timeframes tf
             WHERE tf.version_id = st.strategy_version_id AND tf.role = 'setup' LIMIT 1),
           (o.decision ->> 'timeframe')
         ) AS timeframe
    FROM execution_positions p
    LEFT JOIN execution_orders o ON o.id = p.opened_by_order_id
    LEFT JOIN setups st ON st.id = p.setup_id
    LEFT JOIN strategy_versions v ON v.id = st.strategy_version_id
    LEFT JOIN instruments i ON i.asset_class = p.asset_class AND i.symbol = p.symbol
   WHERE p.user_id = $1`;

function hashIdentity(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function orderIdempotencyKey(hash: string, kind: PaperOrderKind, attempt: number): string {
  return createHash('sha256')
    .update(`paper:order:${kind}:${hash}:${attempt}`, 'utf8')
    .digest('hex');
}

function fillIdempotencyKey(orderIdempotency: string): string {
  return createHash('sha256').update(`paper:fill:${orderIdempotency}`, 'utf8').digest('hex');
}

function numOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface SetupRow {
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
  owner: string;
  instrument_id: string;
  asset_class: string;
  symbol: string;
  min_quality_score: number | null;
  setup_timeframe: string | null;
  entry_timeframe: string | null;
}

interface OrderRow {
  id: string;
  user_id: string;
  execution_profile_id: string;
  execution_request_id: string | null;
  client_order_id: string;
  provider_slug: string;
  provider_order_id: string | null;
  asset_class: string;
  symbol: string;
  side: 'buy' | 'sell';
  order_type: string;
  quantity: string;
  requested_price: string | null;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  filled_quantity: string;
  average_fill_price: string | null;
  status: string;
  reject_reason: string | null;
  idempotency_key: string;
  architecture_version: string;
  setup_id: string | null;
  risk_decision_id: string | null;
  decision: unknown;
  simulated: boolean;
  simulator_version: string | null;
  fees: string;
  slippage: string;
  reference_price: string | null;
  reference_price_ms: string | null;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  filled_at: Date | null;
}

interface PositionRow {
  id: string;
  user_id: string;
  execution_profile_id: string;
  provider_slug: string;
  provider_position_id: string | null;
  asset_class: string;
  symbol: string;
  direction: 'long' | 'short';
  quantity: string;
  average_entry_price: string;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  realized_pl: string | null;
  unrealized_pl: string | null;
  status: 'open' | 'closed';
  opened_at: Date;
  closed_at: Date | null;
  updated_at: Date;
  created_at: Date;
  setup_id: string | null;
  opened_by_order_id: string | null;
  closed_by_order_id: string | null;
  exit_price: string | null;
  exit_reason: string | null;
  fees: string;
  slippage: string;
  mark_price: string | null;
  mark_price_ms: string | null;
  simulated: boolean;
  simulator_version: string | null;
}

type LoadedPosition = PositionRow & {
  instrument_id: string | null;
  opening_decision: unknown;
  risk_decision_id: string | null;
  strategy_id: string | null;
  strategy_version_id: string | null;
  timeframe: string | null;
};

interface FillRow {
  id: string;
  user_id: string;
  execution_profile_id: string;
  order_id: string;
  position_id: string | null;
  setup_id: string | null;
  sequence: number;
  fill_type: string;
  quantity: string;
  price: string;
  fees: string;
  slippage: string;
  reference_price: string | null;
  simulated: boolean;
  idempotency_key: string;
  created_at: Date;
}

interface ReconciliationRow {
  id: string;
  execution_profile_id: string;
  order_id: string | null;
  position_id: string | null;
  scope: 'order' | 'position';
  outcome: 'ok' | 'mismatch';
  findings: string[];
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  simulator_version: string;
  created_at: Date;
}

function toPaperOrderDto(row: OrderRow): PaperOrderDto {
  return {
    id: row.id,
    executionProfileId: row.execution_profile_id,
    executionRequestId: row.execution_request_id,
    clientOrderId: row.client_order_id,
    providerSlug: row.provider_slug,
    providerOrderId: row.provider_order_id,
    assetClass: row.asset_class as PaperOrderDto['assetClass'],
    symbol: row.symbol,
    side: row.side,
    orderType: row.order_type as PaperOrderDto['orderType'],
    quantity: Number(row.quantity),
    requestedPrice: numOrNull(row.requested_price),
    stopLossPrice: numOrNull(row.stop_loss_price),
    takeProfitPrice: numOrNull(row.take_profit_price),
    status: row.status as PaperOrderDto['status'],
    rejectReason: row.reject_reason,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
    filledAt: row.filled_at ? row.filled_at.toISOString() : null,
    setupId: row.setup_id,
    riskDecisionId: row.risk_decision_id,
    filledQuantity: Number(row.filled_quantity),
    averageFillPrice: numOrNull(row.average_fill_price),
    fees: Number(row.fees),
    slippage: Number(row.slippage),
    referencePrice: numOrNull(row.reference_price),
    referencePriceMs: row.reference_price_ms === null ? null : Number(row.reference_price_ms),
    simulated: row.simulated,
    simulatorVersion: row.simulator_version,
  };
}

function toPaperPositionDto(row: PositionRow): PaperPositionDto {
  return {
    id: row.id,
    executionProfileId: row.execution_profile_id,
    providerSlug: row.provider_slug,
    providerPositionId: row.provider_position_id,
    assetClass: row.asset_class as PaperPositionDto['assetClass'],
    symbol: row.symbol,
    direction: row.direction,
    quantity: Number(row.quantity),
    averageEntryPrice: Number(row.average_entry_price),
    stopLossPrice: numOrNull(row.stop_loss_price),
    takeProfitPrice: numOrNull(row.take_profit_price),
    realizedPl: numOrNull(row.realized_pl),
    unrealizedPl: numOrNull(row.unrealized_pl),
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
    setupId: row.setup_id,
    openedByOrderId: row.opened_by_order_id,
    closedByOrderId: row.closed_by_order_id,
    exitPrice: numOrNull(row.exit_price),
    exitReason: (row.exit_reason as PaperPositionDto['exitReason']) ?? null,
    fees: Number(row.fees),
    slippage: Number(row.slippage),
    markPrice: numOrNull(row.mark_price),
    markPriceMs: row.mark_price_ms === null ? null : Number(row.mark_price_ms),
    simulated: row.simulated,
    simulatorVersion: row.simulator_version,
  };
}

function toFillDto(row: FillRow): PaperFillDto {
  return {
    id: row.id,
    executionProfileId: row.execution_profile_id,
    orderId: row.order_id,
    positionId: row.position_id,
    setupId: row.setup_id,
    sequence: row.sequence,
    fillType: row.fill_type as PaperFillDto['fillType'],
    quantity: Number(row.quantity),
    price: Number(row.price),
    fees: Number(row.fees),
    slippage: Number(row.slippage),
    referencePrice: numOrNull(row.reference_price),
    simulated: row.simulated,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  };
}

function toReconciliationDto(row: ReconciliationRow): ReconciliationDto {
  return {
    id: row.id,
    executionProfileId: row.execution_profile_id,
    orderId: row.order_id,
    positionId: row.position_id,
    scope: row.scope,
    outcome: row.outcome,
    findings: row.findings as ReconciliationDto['findings'],
    expected: row.expected ?? {},
    actual: row.actual ?? {},
    simulatorVersion: row.simulator_version,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function toFillState(row: FillRow) {
  return {
    orderId: row.order_id,
    positionId: row.position_id,
    userId: row.user_id,
    executionProfileId: row.execution_profile_id,
    sequence: row.sequence,
    fillType: row.fill_type,
    quantity: row.quantity,
    price: row.price,
    fees: row.fees,
    slippage: row.slippage,
  };
}

function toOrderState(row: OrderRow) {
  return {
    id: row.id,
    userId: row.user_id,
    executionProfileId: row.execution_profile_id,
    symbol: row.symbol,
    side: row.side,
    quantity: row.quantity,
    filledQuantity: row.filled_quantity,
    averageFillPrice: row.average_fill_price,
    status: row.status,
    rejectReason: row.reject_reason,
    simulated: row.simulated,
  };
}

function toPositionState(row: PositionRow) {
  return {
    id: row.id,
    userId: row.user_id,
    executionProfileId: row.execution_profile_id,
    symbol: row.symbol,
    direction: row.direction,
    quantity: row.quantity,
    averageEntryPrice: row.average_entry_price,
    stopLossPrice: row.stop_loss_price,
    takeProfitPrice: row.take_profit_price,
    exitPrice: row.exit_price,
    exitReason: row.exit_reason,
    realizedPl: row.realized_pl,
    status: row.status,
    closedAt: row.closed_at,
    openedByOrderId: row.opened_by_order_id,
    closedByOrderId: row.closed_by_order_id,
    simulated: row.simulated,
  };
}
