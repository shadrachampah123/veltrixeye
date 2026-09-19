import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import {
  RISK_ENGINE_VERSION, type ExecutionTransportEvent, type TransportAuthorization,
  type TransportContext, type TransportSubmitRequest,
} from '@veltrixeye/contracts';
import {
  createSafeExecutionTransport, createTransportDispatcher, DryRunExecutionTransport,
  MT5ExecutionTransport, ExecutionTransportError, validateExecutionTransportConfig,
  getEntitlements, type ExecutionGateInput, type DryRunTransportOptions,
  type TransportExecutionAuthority,
} from '../src/index.js';

const NOW = 1_800_000_000_000;
const context = (executionId: string = randomUUID()): TransportContext => ({
  executionId, requestId: randomUUID(), correlationId: randomUUID(), timestamp: new Date(NOW).toISOString(),
});
const request = (): TransportSubmitRequest => ({ ...context(), order: {
  symbol: 'EURUSD', side: 'buy', orderType: 'market', quantity: 0.1, price: null, stopLoss: 1.095, takeProfit: 1.11,
} });
/** Synthetic server authority only. Production entitlements remain automation OFF. */
function gates(overrides: Partial<ExecutionGateInput> = {}): ExecutionGateInput {
  return {
    authenticated: true, authorized: true,
    entitlements: { ...getEntitlements('premium', 'active'), canAccessAutomation: true },
    automation: { entitled: true, automationEnabled: true },
    profile: { enabled: true, environment: 'paper' },
    killSwitches: { global: false, user: false, strategy: false, profile: false },
    decision: {
      strategyId: 's', strategyVersionId: 'v', setupId: 'setup', action: 'open_long',
      assetClass: 'forex', symbol: 'EURUSD', timeframe: '1h', direction: 'long',
      entryPrice: 1.1, stopLossPrice: 1.095, takeProfitPrice: 1.11, expectedRr: 2,
      qualityScore: 80, minQualityScore: 65, asOfMs: NOW,
    },
    setup: { id: 'setup', direction: 'long', state: 'confirmed' },
    instrumentKnown: true, riskDecision: { approved: true, decisionId: randomUUID(), engineVersion: RISK_ENGINE_VERSION },
    minRr: 2, exposureWithinLimits: true, providerHealth: { healthy: true },
    environmentSafe: true, brokerAuthorized: true, accountAuthorized: true, ...overrides,
  };
}
const authority = (overrides: Partial<TransportExecutionAuthority> = {}): TransportExecutionAuthority => ({
  resolveGates: async () => gates(),
  authorizeExecution: async () => ({ granted: true, authorizationId: 'synthetic-test-only' }), ...overrides,
});
class ObservedDryRun extends DryRunExecutionTransport {
  calls = { connect: 0, submit: 0, cancel: 0 };
  protected override async exchange(operation: 'connect' | 'submit' | 'cancel', input: TransportContext, signal: AbortSignal): Promise<unknown> {
    this.calls[operation]++;
    return super.exchange(operation, input, signal);
  }
}
async function fixture(options: DryRunTransportOptions = {}, auth = authority()) {
  const events: ExecutionTransportEvent[] = [];
  const transport = new ObservedDryRun({ now: () => NOW, timeoutMs: 20, audit: (event) => events.push(event), ...options });
  await transport.connect(context());
  return { transport, events, dispatcher: createTransportDispatcher(transport, auth) };
}

// File-wide tripwires: every scenario below fails if it attempts network or starts a terminal/process.
let forbiddenCalls = 0;
before(() => {
  const forbidden = () => { forbiddenCalls++; throw new Error('M10 attempted forbidden I/O'); };
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(Socket.prototype, 'connect', forbidden);
  mock.method(http, 'request', forbidden); mock.method(https, 'request', forbidden);
  mock.method(tls, 'connect', forbidden); mock.method(dgram, 'createSocket', forbidden);
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    mock.method(childProcess, method, forbidden);
  }
});
after(() => { mock.restoreAll(); assert.equal(forbiddenCalls, 0, 'no broker, MT5, network or process invocation'); });

describe('M10 connection, health, session and safe MT5 boundary', () => {
  test('disconnected → connecting → connected → disconnected; session explicitly simulated, never authenticated', async () => {
    const events: ExecutionTransportEvent[] = [];
    const t = new ObservedDryRun({ now: () => NOW, audit: (e) => events.push(e) });
    assert.equal((await t.health(context())).state, 'disconnected');
    assert.equal((await t.session(context())).account, 'none');
    const connected = await t.connect(context());
    assert.equal(connected.state, 'connected'); assert.equal(connected.live, false); assert.equal(connected.mode, 'dry-run');
    assert.equal((await t.session(context())).authenticated, false);
    assert.equal((await t.session(context())).account, 'simulated');
    await t.connect(context()); assert.equal(t.calls.connect, 1);
    await t.disconnect(context());
    assert.deepEqual(events.map((e) => [e.from, e.to]), [
      ['disconnected', 'connecting'], ['connecting', 'connected'], ['connected', 'disconnected'],
    ]);
    assert.equal((await t.session(context())).state, 'inactive');
  });
  test('concurrent connects share one exchange', async () => {
    const t = new ObservedDryRun();
    const results = await Promise.all(Array.from({ length: 10 }, () => t.connect(context())));
    assert.ok(results.every((r) => r.healthy)); assert.equal(t.calls.connect, 1);
  });
  for (const scenario of ['reject', 'timeout', 'failure', 'malformed'] as const) {
    test(`connect ${scenario} → unavailable`, async () => {
      const t = new ObservedDryRun({ timeoutMs: 5, scenarios: { connect: scenario } });
      assert.equal((await t.connect(context())).state, 'unavailable');
      assert.equal((await t.health(context())).healthy, false);
      assert.equal((await t.session(context())).account, 'none');
    });
  }
  test('disconnect aborts in-flight connection without resurrection', async () => {
    const t = new ObservedDryRun({ scenarios: { connect: 'timeout' } });
    const pending = t.connect(context());
    await t.disconnect(context()); await pending;
    assert.equal((await t.health(context())).state, 'disconnected');
  });
  test('MT5 disabled boundary cannot submit or cancel, including through an approving test authority', async () => {
    const t = new MT5ExecutionTransport();
    assert.equal((await t.connect(context())).state, 'unavailable');
    const d = createTransportDispatcher(t, authority());
    const r = request();
    assert.equal((await d.submit(r)).error?.code, 'unavailable');
    assert.equal((await d.cancel({ ...context(r.executionId), orderId: `sim-${'a'.repeat(32)}` })).error?.code, 'unavailable');
    assert.equal(t.mode, 'disabled'); assert.equal(t.live, false);
  });
});

describe('M10 operational requests, idempotency and cancellation', () => {
  test('successful deterministic acknowledgement with correlated audit and status', async () => {
    const { dispatcher, transport, events } = await fixture(); const r = request();
    const result = await dispatcher.submit(r);
    assert.equal(result.state, 'acknowledged'); assert.equal(result.requestId, r.requestId);
    assert.equal(result.executionId, r.executionId); assert.equal(result.correlationId, r.correlationId);
    assert.equal(result.timestamp, new Date(NOW).toISOString()); assert.match(result.orderId!, /^sim-/);
    assert.equal(result.live, false); assert.equal(result.error, null);
    const t2 = await fixture(); assert.equal((await t2.dispatcher.submit(r)).orderId, result.orderId);
    assert.equal((await transport.orderStatus(context(r.executionId))).state, 'acknowledged');
    assert.deepEqual(events.filter((e) => e.operation === 'submit').map((e) => [e.from, e.to]), [
      ['connected', 'submitting'], ['submitting', 'acknowledged'],
    ]);
    for (const event of events.filter((e) => e.operation === 'submit')) {
      assert.equal(event.executionId, r.executionId); assert.equal(event.requestId, r.requestId);
      assert.equal(event.correlationId, r.correlationId); assert.equal(event.timestamp, result.timestamp);
      assert.ok(Object.isFrozen(event)); assert.equal('order' in event, false);
    }
  });
  for (const [scenario, code, state, uncertain] of [
    ['reject', 'rejected', 'rejected', false], ['timeout', 'timeout', 'failed', true],
    ['failure', 'transport_failure', 'failed', true], ['malformed', 'malformed_response', 'failed', true],
  ] as const) {
    test(`submission ${scenario} is sanitized and sticky, no automatic retry`, async () => {
      const { dispatcher, transport } = await fixture({ scenarios: { submit: scenario } }); const r = request();
      const result = await dispatcher.submit(r);
      assert.equal(result.state, state); assert.equal(result.error?.code, code);
      assert.equal(result.error?.outcomeUnknown, uncertain);
      assert.deepEqual(await dispatcher.submit(r), result); assert.equal(transport.calls.submit, 1);
    });
  }
  test('100 concurrent and sequential duplicate requests submit exactly once', async () => {
    const { dispatcher, transport } = await fixture(); const r = request();
    const results = await Promise.all(Array.from({ length: 100 }, () => dispatcher.submit(r)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(transport.calls.submit, 1);
    const replay = await dispatcher.submit({ ...r, ...context(r.executionId) });
    assert.equal(replay.requestId, r.requestId, 'replay retains original acknowledgement identity');
    assert.equal(transport.calls.submit, 1);
  });
  test('execution ID payload conflict and request ID cross-execution conflict fail closed', async () => {
    const { dispatcher, transport } = await fixture(); const r = request(); await dispatcher.submit(r);
    assert.equal((await dispatcher.submit({ ...r, order: { ...r.order, quantity: 0.2 } })).error?.code, 'idempotency_conflict');
    assert.equal((await dispatcher.submit({ ...r, executionId: randomUUID() })).error?.code, 'idempotency_conflict');
    const retry = { ...r, ...context(r.executionId) }; await dispatcher.submit(retry);
    assert.equal((await dispatcher.submit({ ...retry, executionId: randomUUID() })).error?.code, 'idempotency_conflict');
    assert.equal(transport.calls.submit, 1);
  });
  test('UUID case variants normalize to one identity', async () => {
    const { dispatcher, transport } = await fixture(); const r = request(); await dispatcher.submit(r);
    await dispatcher.submit({ ...r, executionId: r.executionId.toUpperCase(), requestId: r.requestId.toUpperCase() });
    assert.equal(transport.calls.submit, 1);
  });
  test('capacity exhaustion refuses new identities without evicting existing deduplication', async () => {
    const { dispatcher, transport } = await fixture({ maxExecutions: 1 }); const r = request();
    const first = await dispatcher.submit(r);
    assert.equal((await dispatcher.submit(request())).error?.code, 'capacity_exceeded');
    assert.deepEqual(await dispatcher.submit(r), first); assert.equal(transport.calls.submit, 1);
  });
  test('cancellation and duplicate cancellation are deterministic; status is cancelled', async () => {
    const { dispatcher, transport } = await fixture(); const r = request(); const result = await dispatcher.submit(r);
    const cancel = { ...context(r.executionId), orderId: result.orderId! };
    const results = await Promise.all(Array.from({ length: 10 }, () => dispatcher.cancel(cancel)));
    assert.ok(results.every((row) => row.state === 'cancelled'));
    assert.equal(transport.calls.cancel, 1);
    assert.equal((await transport.orderStatus(context(r.executionId))).state, 'cancelled');
    assert.deepEqual(await dispatcher.submit(r), result); assert.equal(transport.calls.submit, 1);
  });
  for (const scenario of ['reject', 'timeout', 'failure', 'malformed'] as const) {
    test(`cancellation ${scenario} is sticky and never retried`, async () => {
      const { dispatcher, transport } = await fixture({ scenarios: { cancel: scenario } });
      const r = request(); const result = await dispatcher.submit(r);
      const cancel = { ...context(r.executionId), orderId: result.orderId! };
      const cancelled = await dispatcher.cancel(cancel);
      assert.equal(cancelled.state, scenario === 'reject' ? 'rejected' : 'failed');
      assert.deepEqual(await dispatcher.cancel(cancel), cancelled); assert.equal(transport.calls.cancel, 1);
      assert.equal((await transport.orderStatus(context(r.executionId))).state, scenario === 'reject' ? 'acknowledged' : 'failed');
    });
  }
  test('unknown/mismatched order cancellation never crosses the boundary', async () => {
    const { dispatcher, transport } = await fixture(); const r = request(); await dispatcher.submit(r);
    assert.equal((await dispatcher.cancel({ ...context(r.executionId), orderId: `sim-${'a'.repeat(32)}` })).error?.code, 'not_found');
    assert.equal((await dispatcher.cancel({ ...context(), orderId: `sim-${'b'.repeat(32)}` })).error?.code, 'not_found');
    assert.equal(transport.calls.cancel, 0);
    assert.equal((await transport.orderStatus(context())).error?.code, 'not_found');
  });
  test('disconnected submission fails, reconnect cannot automatically retry it', async () => {
    const { dispatcher, transport } = await fixture(); await transport.disconnect(context());
    const r = request(); const result = await dispatcher.submit(r);
    assert.equal(result.error?.code, 'unavailable'); await transport.connect(context());
    assert.deepEqual(await dispatcher.submit(r), result); assert.equal(transport.calls.submit, 0);
  });
  test('status surfaces submitting and disconnect aborts pending submission', async () => {
    const { dispatcher, transport } = await fixture({ scenarios: { submit: 'timeout' }, timeoutMs: 1000 });
    const r = request(); const pending = dispatcher.submit(r);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await transport.orderStatus(context(r.executionId))).state, 'submitting');
    await transport.disconnect(context());
    assert.equal((await pending).error?.code, 'unavailable');
    assert.equal((await pending).error?.outcomeUnknown, true);
  });
  test('late response after timeout cannot change cached failure or trigger another submission', async () => {
    let finish!: (value: unknown) => void;
    class LateTransport extends ObservedDryRun {
      protected override async exchange(op: 'connect' | 'submit' | 'cancel', input: TransportContext, signal: AbortSignal) {
        if (op !== 'submit') return super.exchange(op, input, signal);
        this.calls.submit++;
        return new Promise((resolve) => { finish = resolve; });
      }
    }
    const t = new LateTransport({ timeoutMs: 5 }); await t.connect(context());
    const d = createTransportDispatcher(t, authority()); const r = request(); const failed = await d.submit(r);
    finish({ requestId: r.requestId, executionId: r.executionId, correlationId: r.correlationId,
      timestamp: r.timestamp, state: 'acknowledged', orderId: `sim-${'a'.repeat(32)}` });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failed.error?.code, 'timeout'); assert.deepEqual(await d.submit(r), failed);
    assert.equal((await t.orderStatus(context(r.executionId))).state, 'failed'); assert.equal(t.calls.submit, 1);
  });
});

describe('M10 unchanged authoritative safety gates and explicit execution authorization', () => {
  const denied: Array<[string, Partial<ExecutionGateInput>]> = [
    ['automation OFF', { automation: { entitled: true, automationEnabled: false } }],
    ...(['global', 'user', 'strategy', 'profile'] as const).map((scope): [string, Partial<ExecutionGateInput>] => [
      `${scope} kill-switch`, { killSwitches: { global: false, user: false, strategy: false, profile: false, [scope]: true } },
    ]),
    ['risk rejection', { riskDecision: { approved: false, decisionId: randomUUID(), engineVersion: RISK_ENGINE_VERSION } }],
    ['forged risk approval', { riskDecision: { approved: true } }],
    ['unknown risk', { riskDecision: null }], ['exposure rejection', { exposureWithinLimits: false }],
    ['execution ownership rejection', { authorized: false }], ['broker unauthorized', { brokerAuthorized: false }],
    ['account unauthorized', { accountAuthorized: false }], ['unsafe environment', { environmentSafe: false }],
    ['live profile', { profile: { enabled: true, environment: 'live' } }],
    ['production entitlements', { entitlements: getEntitlements('premium', 'active') }],
  ];
  for (const [name, override] of denied) {
    test(`${name}: neither submit nor cancel invokes transport exchange or execution authorizer`, async () => {
      let authorized = 0;
      const { dispatcher, transport } = await fixture({}, authority({
        resolveGates: async () => gates(override),
        authorizeExecution: async () => { authorized++; return { granted: true, authorizationId: 'test' }; },
      }));
      await assert.rejects(dispatcher.submit(request()), /Execution authorization denied/);
      await assert.rejects(dispatcher.cancel({ ...context(), orderId: `sim-${'a'.repeat(32)}` }), /Execution authorization denied/);
      assert.equal(transport.calls.submit, 0); assert.equal(transport.calls.cancel, 0); assert.equal(authorized, 0);
    });
  }
  for (const decision of [null, { granted: false, authorizationId: 'test' }, { granted: true, authorizationId: '' }]) {
    test(`execution authorization ${JSON.stringify(decision)} fails closed`, async () => {
      const { dispatcher, transport } = await fixture({}, authority({ authorizeExecution: async () => decision }));
      await assert.rejects(dispatcher.submit(request()), /Execution authorization denied/);
      assert.equal(transport.calls.submit, 0);
    });
  }
  test('gates are checked again on replay, after automation is turned OFF', async () => {
    let enabled = true;
    const { dispatcher, transport } = await fixture({}, authority({ resolveGates: async () => gates({
      automation: { entitled: true, automationEnabled: enabled },
    }) }));
    const r = request(); await dispatcher.submit(r); enabled = false;
    await assert.rejects(dispatcher.submit(r), /Execution authorization denied/); assert.equal(transport.calls.submit, 1);
  });
  test('capabilities are request-bound, adapter-bound and consumed only once', async () => {
    const primary = await fixture(); const other = await fixture();
    let saved: TransportAuthorization | undefined;
    const original = primary.transport.submit.bind(primary.transport);
    primary.transport.submit = async (r, permit) => { saved = permit; return original(r, permit); };
    const r = request(); await primary.dispatcher.submit(r);
    assert.equal((await original(r, saved!)).error?.code, 'unauthorized');
    assert.equal((await other.transport.submit(r, saved!)).error?.code, 'unauthorized');
    primary.transport.submit = async (r, permit) => original({ ...r, order: { ...r.order, quantity: 99 } }, permit);
    assert.equal((await primary.dispatcher.submit(request())).error?.code, 'unauthorized');
    primary.transport.submit = async (r, permit) => other.transport.submit(r, permit);
    assert.equal((await primary.dispatcher.submit(request())).error?.code, 'unauthorized');
    assert.equal(primary.transport.calls.submit, 1); assert.equal(other.transport.calls.submit, 0);
  });
  test('caller mutation during authorization cannot change the authorized request', async () => {
    const r = request();
    const { dispatcher, transport } = await fixture({}, authority({ resolveGates: async (snapshot) => {
      assert.ok(Object.isFrozen(snapshot));
      assert.ok('order' in snapshot && Object.isFrozen(snapshot.order));
      r.order.quantity = 999;
      return gates();
    } }));
    const result = await dispatcher.submit(r);
    assert.equal(result.state, 'acknowledged'); assert.equal(transport.calls.submit, 1);
    assert.equal((await dispatcher.submit(r)).error?.code, 'idempotency_conflict');
  });
  test('direct calls with fabricated authorization cannot cross the boundary', async () => {
    const { transport } = await fixture();
    const fake = { granted: true, authorizationId: 'client-claim' } as unknown as TransportAuthorization;
    assert.equal((await transport.submit(request(), fake)).error?.code, 'unauthorized');
    assert.equal((await transport.cancel({ ...context(), orderId: `sim-${'a'.repeat(32)}` }, fake)).error?.code, 'unauthorized');
    assert.equal(transport.calls.submit + transport.calls.cancel, 0);
  });
});

describe('M10 validation and secret-safe failures', () => {
  test('strict requests reject secrets, invalid IDs and malformed orders before authorization', async () => {
    let resolutions = 0;
    const { dispatcher, transport } = await fixture({}, authority({ resolveGates: async () => { resolutions++; return gates(); } }));
    const r = request();
    for (const bad of [
      { ...r, password: 'SENTINEL_SECRET' }, { ...r, requestId: 'SENTINEL_SECRET' },
      { ...r, timestamp: 'invalid' }, { ...r, order: { ...r.order, quantity: NaN } },
      { ...r, order: { ...r.order, quantity: -1 } }, { ...r, order: { ...r.order, stopLoss: null } },
      { ...r, order: { ...r.order, token: 'SENTINEL_SECRET' } },
    ]) {
      await assert.rejects(dispatcher.submit(bad as TransportSubmitRequest), (e: unknown) => {
        assert.ok(e instanceof ExecutionTransportError); assert.doesNotMatch(String(e), /SENTINEL/); return true;
      });
    }
    assert.equal(resolutions, 0); assert.equal(transport.calls.submit, 0);
  });
  test('raw errors, nested secrets and stacks never appear in results or audit', async () => {
    const secret = 'SENTINEL_password_broker_MT5_API_token';
    class SecretTransport extends ObservedDryRun {
      protected override async exchange(op: 'connect' | 'submit' | 'cancel', input: TransportContext, signal: AbortSignal) {
        if (op !== 'submit') return super.exchange(op, input, signal);
        throw Object.assign(new Error(secret), { password: secret, response: { token: secret }, cause: new Error(secret) });
      }
    }
    const events: ExecutionTransportEvent[] = [];
    const t = new SecretTransport({ audit: (e) => events.push(e) }); await t.connect(context());
    const r = await createTransportDispatcher(t, authority()).submit(request());
    assert.equal(r.error?.code, 'transport_failure');
    assert.doesNotMatch(JSON.stringify({ r, events }), /SENTINEL|password|stack|cause|response/);
  });
  for (const fault of ['wrong-request', 'wrong-execution', 'wrong-correlation', 'invalid-state', 'missing-order', 'invalid-time', 'raw-secret', 'rejected-ticket'] as const) {
    test(`malformed wire response ${fault} fails closed`, async () => {
      class MalformedTransport extends ObservedDryRun {
        protected override async exchange(op: 'connect' | 'submit' | 'cancel', input: TransportContext, signal: AbortSignal) {
          const raw = await super.exchange(op, input, signal);
          if (op !== 'submit') return raw;
          const row = raw as Record<string, unknown>;
          if (fault === 'wrong-request') row.requestId = randomUUID();
          if (fault === 'wrong-execution') row.executionId = randomUUID();
          if (fault === 'wrong-correlation') row.correlationId = randomUUID();
          if (fault === 'invalid-state') row.state = 'filled';
          if (fault === 'missing-order') row.orderId = null;
          if (fault === 'invalid-time') row.timestamp = 'bad';
          if (fault === 'raw-secret') row.password = 'SENTINEL_SECRET';
          if (fault === 'rejected-ticket') row.state = 'rejected';
          return row;
        }
      }
      const t = new MalformedTransport(); await t.connect(context());
      const result = await createTransportDispatcher(t, authority()).submit(request());
      assert.equal(result.error?.code, 'malformed_response'); assert.equal(result.error?.outcomeUnknown, true);
      assert.doesNotMatch(JSON.stringify(result), /SENTINEL/);
    });
  }
  test('resolver errors are sanitized and fail closed', async () => {
    for (const method of ['resolveGates', 'authorizeExecution'] as const) {
      const { dispatcher, transport } = await fixture({}, authority({ [method]: async () => { throw new Error('SENTINEL_SECRET'); } }));
      await assert.rejects(dispatcher.submit(request()), (e: unknown) => {
        assert.ok(e instanceof ExecutionTransportError); assert.doesNotMatch(String(e), /SENTINEL/); return true;
      });
      assert.equal(transport.calls.submit, 0);
    }
  });
  test('audit sink failure before submission prevents exchange and remains sticky', async () => {
    const { dispatcher, transport } = await fixture({ audit: (e) => { if (e.operation === 'submit') throw new Error('SENTINEL_SECRET'); } });
    const r = request();
    await assert.rejects(dispatcher.submit(r), /Transport operation failed/);
    await assert.rejects(dispatcher.submit(r), /Transport operation failed/);
    assert.equal(transport.calls.submit, 0);
  });
  test('audit failure after acknowledgement cannot permit duplicate exchange', async () => {
    const { dispatcher, transport } = await fixture({ audit: (e) => {
      if (e.operation === 'submit' && e.to === 'acknowledged') throw new Error('SENTINEL_SECRET');
    } });
    const r = request();
    await assert.rejects(dispatcher.submit(r), /Transport operation failed/);
    await assert.rejects(dispatcher.submit(r), /Transport operation failed/);
    assert.equal(transport.calls.submit, 1);
    assert.equal((await transport.orderStatus(context(r.executionId))).state, 'acknowledged');
  });
  test('configuration defaults disabled; dry-run needs no credentials; forged live factory fails', () => {
    assert.deepEqual(validateExecutionTransportConfig({}), { mode: 'disabled', live: false, timeoutMs: 5000 });
    const config = validateExecutionTransportConfig({ EXECUTION_TRANSPORT_MODE: 'dry-run' });
    assert.equal(createSafeExecutionTransport(config).mode, 'dry-run');
    assert.equal(createSafeExecutionTransport(validateExecutionTransportConfig({})).mode, 'disabled');
    assert.throws(() => createSafeExecutionTransport({ ...config, live: true } as unknown as typeof config), /unavailable/);
    assert.throws(() => createSafeExecutionTransport({ ...config, mode: 'mt5-live' } as unknown as typeof config), /unavailable/);
  });
  for (const env of [
    { EXECUTION_TRANSPORT_MODE: 'live' }, { EXECUTION_TRANSPORT_MODE: '' },
    { EXECUTION_TRANSPORT_TIMEOUT_MS: '0' }, { EXECUTION_TRANSPORT_TIMEOUT_MS: 'Infinity' },
    { EXECUTION_TRANSPORT_TIMEOUT_MS: '60001' }, { EXECUTION_TRANSPORT_TIMEOUT_MS: '1.5' },
  ]) {
    test(`invalid configuration ${JSON.stringify(env)} is rejected`, () => {
      assert.throws(() => validateExecutionTransportConfig(env), /Invalid EXECUTION_TRANSPORT/);
    });
  }
  test('live configuration missing and complete both fail closed with no secret values', () => {
    const env = { EXECUTION_TRANSPORT_MODE: 'mt5-live', NODE_ENV: 'production' };
    assert.throws(() => validateExecutionTransportConfig(env), /missing: MT5_SERVER, MT5_LOGIN, MT5_PASSWORD, MT5_GATEWAY_URL/);
    assert.throws(() => validateExecutionTransportConfig({ ...env, MT5_SERVER: 'SENTINEL', MT5_LOGIN: 'SENTINEL', MT5_PASSWORD: 'SENTINEL', MT5_GATEWAY_URL: 'SENTINEL' }), (e: unknown) => {
      assert.match(String(e), /prohibited in M10/); assert.doesNotMatch(String(e), /SENTINEL/); return true;
    });
  });
});
