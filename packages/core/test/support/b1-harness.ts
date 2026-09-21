/**
 * Shared scripted harness for the B1 remediation tests.
 *
 * Philosophy: failures under test are RACES BETWEEN READS. Real Postgres
 * cannot interleave a state flip between two reads deterministically, so
 * these tests script every dependency behind the composition seams
 * (pool, automation, kill-switches, risk, audit, paper, ledger, providers)
 * and flip state by call count. The PG-backed files (b1-m6-m7-*, b1-h4-*)
 * cover the same paths end-to-end against embedded Postgres.
 */
import type pg from 'pg';

/* -------------------------------------------------------------------------- */
/* scripted pool                                                              */
/* -------------------------------------------------------------------------- */

export interface ScriptedCall {
  text: string;
  params: unknown[];
}

type Responder = (callIndex: number, text: string, params: unknown[]) => unknown[];

export class ScriptPool {
  readonly calls: ScriptedCall[] = [];
  private readonly scripts: Array<{ needle: string; respond: Responder }> = [];

  /** Match queries whose text contains `needle` (first match wins). */
  on(needle: string, rowsOrFn: unknown[] | Responder): this {
    const respond: Responder =
      typeof rowsOrFn === 'function' ? (rowsOrFn as Responder) : () => rowsOrFn;
    this.scripts.push({ needle, respond });
    return this;
  }

  async query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    const callIndex = this.calls.length;
    this.calls.push({ text, params: params ?? [] });
    const script = this.scripts.find((s) => text.includes(s.needle));
    if (!script) {
      throw new Error(`ScriptPool: unexpected query #${callIndex}: ${text.slice(0, 120)}`);
    }
    const rows = script.respond(callIndex, text, params ?? []);
    return { rows, rowCount: rows.length };
  }

  count(needle: string): number {
    return this.calls.filter((c) => c.text.includes(needle)).length;
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

/* -------------------------------------------------------------------------- */
/* scripted services                                                          */
/* -------------------------------------------------------------------------- */

export interface ScriptedAutomationState {
  entitled: boolean;
  enabled: boolean;
}

/** readState returns the scripted entry by call count (last entry repeats). */
export function stubAutomation(script: ScriptedAutomationState | ScriptedAutomationState[]): {
  service: any;
  calls: number;
} {
  const steps = Array.isArray(script) ? script : [script];
  const state = { calls: 0 };
  const service = {
    async getStatus(_userId: string) {
      const step = steps[Math.min(state.calls, steps.length - 1)]!;
      return {
        entitled: step.entitled,
        automationEnabled: step.enabled,
        globalKillSwitch: false,
        userKillSwitch: false,
        effective: step.entitled && step.enabled,
        reasons: step.entitled && step.enabled ? [] : ['not_entitled_or_disabled'],
      };
    },
    async readState(_userId: string) {
      const step = steps[Math.min(state.calls, steps.length - 1)]!;
      state.calls += 1;
      return {
        entitlements: {
          maxStrategies: 100,
          maxBacktestsPerMonth: 100,
          maxAlertsPerMonth: 1000,
          maxSavedSetups: 1000,
          canAccessScanner: true,
          canAccessAdvancedStrategies: true,
          canAccessAdvancedAlerts: true,
          canAccessAutomation: step.entitled,
        },
        automationEnabled: step.enabled,
      };
    },
  };
  return {
    service,
    get calls() {
      return state.calls;
    },
  } as { service: any; calls: number };
}

export interface ScriptedKillState {
  active: boolean;
  global?: boolean;
  user?: boolean;
  strategy?: boolean;
  profile?: boolean;
}

/** anyActive returns the scripted entry by call count (last entry repeats). */
export function stubKills(script: ScriptedKillState | ScriptedKillState[]): {
  service: any;
  calls: number;
} {
  const steps = Array.isArray(script) ? script : [script];
  const state = { calls: 0 };
  const service = {
    async anyActive(_args: unknown) {
      const step = steps[Math.min(state.calls, steps.length - 1)]!;
      state.calls += 1;
      return {
        active: step.active,
        global: step.global ?? step.active,
        user: step.user ?? false,
        strategy: step.strategy ?? false,
        profile: step.profile ?? false,
      };
    },
  };
  return {
    service,
    get calls() {
      return state.calls;
    },
  } as { service: any; calls: number };
}

export function stubAudit(): { service: any; entries: any[] } {
  const entries: any[] = [];
  return {
    entries,
    service: {
      async log(entry: any) {
        entries.push(entry);
        return { id: `audit-${entries.length}` };
      },
    },
  };
}

export function stubRisk(opts: {
  decision: any;
  release?: (id: string) => void;
  reservations?: Array<any | null> | any | null;
}): { service: any; evaluateCalls: any[]; released: string[]; reservationArgs: any[] } {
  const evaluateCalls: any[] = [];
  const released: string[] = [];
  const reservationArgs: any[] = [];
  const steps =
    opts.reservations === undefined || opts.reservations === null || Array.isArray(opts.reservations)
      ? (opts.reservations as Array<any | null> | undefined)
      : [opts.reservations];
  let reservationCalls = 0;
  return {
    evaluateCalls,
    released,
    reservationArgs,
    service: {
      async evaluate(input: any) {
        evaluateCalls.push(input);
        return opts.decision;
      },
      async releaseReservation(id: string) {
        released.push(id);
        opts.release?.(id);
      },
      async getActiveReservation(args: { riskDecisionId: string; executionProfileId: string; nowMs?: number }) {
        reservationArgs.push(args);
        if (!steps) return null;
        const row = steps[Math.min(reservationCalls, steps.length - 1)];
        reservationCalls += 1;
        return row ?? null;
      },
    },
  };
}

export function stubPaper(opts: {
  identity?: any;
  identityFn?: (input: any) => any;
  execute?: any;
  executeFn?: (input: any) => any;
}): { service: any; identityCalls: any[]; executeCalls: any[] } {
  const identityCalls: any[] = [];
  const executeCalls: any[] = [];
  return {
    identityCalls,
    executeCalls,
    service: {
      async deriveComposedEntryIdentity(input: any) {
        identityCalls.push(input);
        if (opts.identityFn) return opts.identityFn(input);
        return opts.identity;
      },
      async executeComposedEntry(input: any) {
        executeCalls.push(input);
        if (opts.executeFn) return opts.executeFn(input);
        return opts.execute;
      },
    },
  };
}

export function stubLedger(opts: { intent?: any; receipt?: any }): {
  service: any;
  intentCalls: any[];
  receiptCalls: any[];
} {
  const intentCalls: any[] = [];
  const receiptCalls: any[] = [];
  return {
    intentCalls,
    receiptCalls,
    service: {
      async resolveByIdentity(input: any) {
        intentCalls.push(input);
        return opts.intent ?? null;
      },
      async getReceipt(intentId: string) {
        receiptCalls.push(intentId);
        return opts.receipt ?? null;
      },
    },
  };
}

export function stubProvider(opts: {
  id: string;
  environment?: string;
  health?: any;
  submitFn?: (input: any) => Promise<any>;
}): { provider: any; submitCalls: any[] } {
  const submitCalls: any[] = [];
  const provider = {
    id: opts.id,
    describe() {
      return { id: opts.id, environment: opts.environment ?? 'demo' };
    },
    async health() {
      return (
        opts.health ?? {
          configured: true,
          authenticated: true,
          connected: true,
          available: true,
          healthy: true,
          state: 'healthy',
          checkedAt: new Date().toISOString(),
        }
      );
    },
    async submitOrder(input: any) {
      submitCalls.push(input);
      if (opts.submitFn) return opts.submitFn(input);
      throw new Error('stubProvider: unexpected submitOrder');
    },
  };
  return { provider, submitCalls };
}

export function stubRegistry(providers: any[]): any {
  const map = new Map(providers.map((p) => [p.id, p]));
  return {
    get: (id: string) => map.get(id),
  };
}

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

export const B1 = {
  user: '11111111-1111-4111-8111-111111111111',
  profile: '22222222-2222-4222-8222-222222222222',
  setup: '33333333-3333-4333-8333-333333333333',
  strategy: '44444444-4444-4444-a444-444444444444',
  version: '55555555-5555-4555-8555-555555555555',
  instrument: '66666666-6666-4666-8666-666666666666',
  request: '77777777-7777-4777-8777-777777777777',
  decision: '88888888-8888-4888-8888-888888888888',
};

export function profileRow(env: 'paper' | 'broker', overrides: Record<string, unknown> = {}): any {
  return {
    id: B1.profile,
    enabled: true,
    environment: env === 'paper' ? 'paper' : 'demo',
    provider_slug: env === 'paper' ? 'paper' : 'mt5',
    account_ref: env === 'paper' ? null : 'acct-1',
    broker_server: env === 'paper' ? null : 'Exness-MT5',
    ...overrides,
  };
}

/** Row for the composition setup SELECT (SetupProvenanceRow shape). */
export function setupRow(direction: 'long' | 'short' = 'long', overrides: Record<string, unknown> = {}): any {
  const long = direction === 'long';
  return {
    setup_id: B1.setup,
    state: 'confirmed',
    direction,
    as_of_ms: '1786000000000',
    entry_price: '1.10000',
    stop_loss_price: long ? '1.09000' : '1.11000',
    tp1_price: long ? '1.12000' : '1.08000',
    quality_score: 80,
    strategy_version_id: B1.version,
    strategy_id: B1.strategy,
    strategy_owner: B1.user,
    instrument_id: B1.instrument,
    asset_class: 'forex',
    symbol: 'EURUSD',
    min_quality_score: 60,
    setup_timeframe: '5m',
    entry_timeframe: '15m',
    ...overrides,
  };
}

/** Scripted approved risk decision (PersistedRiskDecision shape). */
export function riskDecision(overrides: Record<string, unknown> = {}): any {
  const emptyExposure = {
    openPositions: 0,
    reservedPositions: 0,
    totalOpenRisk: 0,
    instrumentOpenRisk: 0,
    directionOpenRisk: 0,
  };
  return {
    id: B1.decision,
    outcome: 'approved',
    rejectionCode: null,
    reason: 'within policy',
    riskPct: 0.5,
    monetaryRisk: 50,
    positionSize: 0.5,
    entryPrice: 1.1,
    stopLossPrice: 1.09,
    takeProfitPrice: 1.12,
    rr: 2,
    currentExposure: { ...emptyExposure },
    projectedExposure: { ...emptyExposure, reservedPositions: 1, totalOpenRisk: 50 },
    policyVersion: 1,
    engineVersion: 'm8.2-risk-engine-1',
    evaluatedAt: '2026-09-21T00:00:00.000Z',
    exposureWithinLimits: true,
    effectiveMinRr: 2,
    violations: [],
    ...overrides,
  };
}

/** Live reservation row for the decision above (matches the real getActiveReservation shape). */
export function reservationFor(decision: any, overrides: Record<string, unknown> = {}): any {
  return {
    id: `res-${decision.id.slice(0, 8)}`,
    monetaryRisk: decision.monetaryRisk,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

/** Default 64-hex identity for paper composed entries. */
export function paperIdentity(overrides: Record<string, unknown> = {}): any {
  return {
    clientOrderId: `ve-${'b1'.repeat(12)}`,
    orderIdempotencyKey: 'a'.repeat(64),
    attempt: 1,
    liveOrder: null,
    ...overrides,
  };
}

export function paperFill(overrides: Record<string, unknown> = {}): any {
  return {
    status: 'filled',
    providerOrderId: 'paper-order-1',
    orderId: 'paper-order-1',
    filledQuantity: '0.50000000',
    averagePrice: '1.10000',
    attempt: 1,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* composition wiring (REAL authorization + fence, scripted surroundings)      */
/* -------------------------------------------------------------------------- */

import { ExecutionCompositionService } from '../../src/execution/composition.js';
import {
  ExecutionAuthorizationService,
  createAuthorizationContextHandoff,
} from '../../src/execution/authorization.js';

export interface WiredComposition {
  service: ExecutionCompositionService;
  authorization: ExecutionAuthorizationService;
  authHandoff: ReturnType<typeof createAuthorizationContextHandoff>;
  automation: ReturnType<typeof stubAutomation>;
  kills: ReturnType<typeof stubKills>;
  risk: ReturnType<typeof stubRisk>;
  audit: ReturnType<typeof stubAudit>;
  paper: ReturnType<typeof stubPaper>;
  ledger: ReturnType<typeof stubLedger>;
  providers: Array<{ provider: any; submitCalls: any[] }>;
}

/**
 * Build a composition with the REAL authorization service, the REAL context
 * handoff, and the REAL final fence (run inside the composition), surrounded
 * by scripted pool/services. The submit handoff is a stub: the broker submit
 * path is unreachable in these tests (H3 fails closed first) except in the
 * replay-pre-check tests, which never reach submit either.
 */
export function wireComposition(opts: {
  pool: ScriptPool;
  automation?: ScriptedAutomationState | ScriptedAutomationState[];
  kills?: ScriptedKillState | ScriptedKillState[];
  decision?: any;
  reservations?: Array<any | null> | any | null;
  paperIdentity?: any;
  paperExecute?: any;
  paperExecuteFn?: (input: any) => any;
  paperIdentityFn?: (input: any) => any;
  ledgerIntent?: any;
  ledgerReceipt?: any;
  providers?: Array<{ provider: any; submitCalls: any[] }>;
  clockMs?: number;
}): WiredComposition {
  const decision = opts.decision ?? riskDecision();
  const authorization = new ExecutionAuthorizationService({
    clock: () => opts.clockMs ?? Date.now(),
  });
  const authHandoff = createAuthorizationContextHandoff(authorization, {
    clock: () => opts.clockMs ?? Date.now(),
  });
  const automation = stubAutomation(opts.automation ?? { entitled: true, enabled: true });
  const kills = stubKills(opts.kills ?? { active: false });
  const risk = stubRisk({
    decision,
    reservations:
      opts.reservations === undefined ? reservationFor(decision) : (opts.reservations as any),
  });
  const audit = stubAudit();
  const paper = stubPaper({
    identity: opts.paperIdentity ?? paperIdentity(),
    execute: opts.paperExecute ?? paperFill(),
    executeFn: opts.paperExecuteFn,
    identityFn: opts.paperIdentityFn,
  });
  const ledger = stubLedger({ intent: opts.ledgerIntent, receipt: opts.ledgerReceipt });
  const providers =
    opts.providers ??
    [stubProvider({ id: 'paper' }), stubProvider({ id: 'mt5', environment: 'demo' })];
  const service = new ExecutionCompositionService(opts.pool.asPool(), {
    automation: automation.service,
    killSwitches: kills.service,
    providers: stubRegistry(providers.map((p) => p.provider)),
    risk: risk.service,
    audit: audit.service,
    providerMutations: ledger.service,
    submitHandoff: { consumeAuthorization: async () => null } as any,
    authorization,
    authHandoff,
    paper: paper.service,
  });
  return { service, authorization, authHandoff, automation, kills, risk, audit, paper, ledger, providers };
}

/**
 * Script the standard happy-path pool responses. `profileEnv` selects the
 * profile row; per-test overrides adjust individual scripts afterwards via
 * additional `.on()` calls placed BEFORE these (first match wins) or by
 * passing responder functions here.
 */
export function scriptHappyPath(
  pool: ScriptPool,
  opts: {
    profileEnv?: 'paper' | 'broker';
    profile?: any;
    setup?: any;
    replayRows?: unknown[] | ((callIndex: number) => unknown[]);
    requestId?: string;
    conflictRows?: unknown[] | ((callIndex: number) => unknown[]);
    insertFn?: (callIndex: number, text: string, params: unknown[]) => unknown[];
    fenceProfile?: unknown[] | ((callIndex: number) => unknown[]);
  } = {},
): ScriptPool {
  const profile = opts.profile ?? profileRow(opts.profileEnv ?? 'paper');
  // NOTE: the fence profile SELECT (`SELECT id, enabled ...`) is a prefix of
  // nothing else, but the full profile SELECT contains a longer column list;
  // match the early full select on its distinctive `account_ref` column so a
  // test can script the fence read independently (first match wins).
  pool.on('account_ref', () => [profile]);
  pool.on('FROM setups st', () => [opts.setup ?? setupRow()]);
  pool.on('SELECT id, user_id, status FROM execution_requests', () =>
    typeof opts.replayRows === 'function' ? opts.replayRows(0) : (opts.replayRows ?? []),
  );
  pool.on('SELECT id FROM instruments', () => [{ id: B1.instrument }]);
  pool.on('INSERT INTO execution_requests', (callIndex, text, params) =>
    opts.insertFn ? opts.insertFn(callIndex, text, params) : [{ id: opts.requestId ?? B1.request }],
  );
  pool.on('SELECT id, user_id FROM execution_requests', () =>
    typeof opts.conflictRows === 'function' ? opts.conflictRows(0) : (opts.conflictRows ?? []),
  );
  pool.on('SELECT id, enabled FROM execution_profiles', () =>
    typeof opts.fenceProfile === 'function'
      ? opts.fenceProfile(0)
      : (opts.fenceProfile ?? [{ id: profile.id, enabled: profile.enabled }]),
  );
  pool.on('INSERT INTO execution_events', () => [{ id: 'evt-1' }]);
  return pool;
}
