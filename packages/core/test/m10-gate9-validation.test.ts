import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BridgeProtocolViolation,
  ExecutionProviderError,
  type ExecutionProvider,
  type ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';
import {
  BRIDGE_DEFAULT_POLICY,
  DisabledMT5Transport,
  READINESS_PROFILES,
  assertExecutionReadiness,
  bridgeOrderIdentityError,
  bridgeQuoteError,
  bridgeReadinessError,
  bridgeVolumeError,
  createMT5ExecutionProvider,
  explicitHealthFlags,
  isExecutionReady,
  normalizeBridgeProviderStatus,
  normalizeMT5Order,
  readinessRequirements,
  readinessViolationCode,
  ProviderReconciliationSnapshotProvider,
  resolveExecutionReadiness,
  validateBridgeInstrument,
  validateBridgeOrderIdentity,
  type MT5OrderRequest,
  type MT5OrderSnapshot,
  type MT5ProviderConfig,
  type MT5SymbolSnapshot,
  type MT5Transport,
  type MT5TransportHealth,
} from '../src/index.js';

/**
 * M10 Gate 9 Step 2 — pre-provider enforcement of the bridge contract.
 *
 * The contracts suite proves the protocol *shape*; this suite proves that the
 * execution path actually refuses to act on it: every Gate 9 check runs BEFORE
 * a byte can reach a transport, a refusal is deterministic (never an unknown
 * outcome), and the recorded transport calls prove no provider call happened.
 * No network, credentials, database, or vendor artifact is used.
 */

const NOW = 1_700_000_000_000;
const HEX24 = 'a'.repeat(24);
const HEX20 = 'b'.repeat(20);
const CLIENT_ORDER_ID = `ve-${HEX24}`;

/** A broker row that satisfies the whole instrument contract. */
const symbolRow = (patch: Partial<MT5SymbolSnapshot> = {}): MT5SymbolSnapshot => ({
  symbol: 'XAUUSDm', assetClass: 'commodity', bid: 1999.9, ask: 2000.1, quoteTimestampMs: NOW,
  contractSize: 100, volumeMin: 0.01, volumeMax: 10, volumeStep: 0.01, digits: 2,
  tickSize: 0.01, orderTypes: ['market', 'limit'], tradeMode: 'open', ...patch,
});

/** Projects a broker row the way the MT5 adapter does (§9 input shape). */
const contractOf = (row: MT5SymbolSnapshot, canonical = 'XAUUSD') => ({
  assetClass: row.assetClass,
  canonicalSymbol: canonical,
  providerSymbol: row.symbol,
  contractSize: row.contractSize,
  tickSize: row.tickSize,
  priceDigits: row.digits,
  minVolume: row.volumeMin,
  maxVolume: row.volumeMax,
  volumeStep: row.volumeStep,
  orderTypes: row.orderTypes,
  tradingStatus: row.tradeMode,
  quote: row.bid !== undefined && row.ask !== undefined && row.quoteTimestampMs !== undefined
    ? { symbol: row.symbol, bid: row.bid, ask: row.ask, timestampMs: row.quoteTimestampMs }
    : null,
});

const orderRow = (patch: Partial<MT5OrderSnapshot> = {}): MT5OrderSnapshot => ({
  ticket: '123', clientOrderId: CLIENT_ORDER_ID, symbol: 'XAUUSDm', status: 'accepted',
  volume: 0.1, timestampMs: NOW, ...patch,
} as MT5OrderSnapshot);

/**
 * Records every call so a test can assert the absence of a provider call, not
 * merely the presence of an error. `healthRecord` and `symbolRowValue` are
 * `unknown` on purpose: hostile/partial records are the subject of the tests.
 */
class RecordingTransport implements MT5Transport {
  configured = true;
  calls: string[] = [];
  healthRecord: unknown = { configured: true, authenticated: true, connected: true, healthy: true };
  symbolRowValue: unknown = symbolRow();
  existing: MT5OrderSnapshot | null = null;
  submitResult: MT5OrderSnapshot = orderRow();
  submitError: Error | null = null;

  private note(name: string): void { this.calls.push(name); }
  count(name: string): number { return this.calls.filter((c) => c === name).length; }

  async health(): Promise<MT5TransportHealth> { this.note('health'); return this.healthRecord as MT5TransportHealth; }
  async account() {
    this.note('account');
    return { login: 'masked-account', broker: 'Example MT5 Broker', server: 'Example-Demo', currency: 'USD', balance: 10_000 };
  }
  async symbol(symbol: string): Promise<MT5SymbolSnapshot | null> {
    this.note('symbol');
    const row = this.symbolRowValue as MT5SymbolSnapshot;
    return symbol === row.symbol ? row : null;
  }
  async submitOrder(_order: MT5OrderRequest) {
    this.note('submitOrder');
    if (this.submitError) throw this.submitError;
    return this.submitResult;
  }
  async findOrderByClientId() { this.note('findOrderByClientId'); return this.existing; }
  async cancelOrder() { this.note('cancelOrder'); }
  async modifyOrder() { this.note('modifyOrder'); }
  async order() { this.note('order'); return this.existing; }
  async orders() { this.note('orders'); return this.existing ? [this.existing] : []; }
  async position() { this.note('position'); return null; }
  async positions() { this.note('positions'); return []; }
  async closePosition() { this.note('closePosition'); }
}

const transportOf = (patch: Partial<RecordingTransport> = {}): RecordingTransport => Object.assign(new RecordingTransport(), patch);
const providerOf = (transport: RecordingTransport, patch: Partial<MT5ProviderConfig> = {}) =>
  createMT5ExecutionProvider(transport, {
    enabled: true, environment: 'demo', broker: 'Example MT5 Broker', server: 'Example-Demo',
    accountRef: 'masked-account', symbols: new Map([['XAUUSD', 'XAUUSDm']]), now: () => NOW, ...patch,
  });

const request = (patch: Partial<ExecutionSubmitOrderRequest> = {}): ExecutionSubmitOrderRequest => ({
  clientOrderId: CLIENT_ORDER_ID, idempotencyKey: 'c'.repeat(64), authorizationId: 'server-auth',
  assetClass: 'commodity', symbol: 'XAUUSD', side: 'buy', orderType: 'market', quantity: 0.1,
  requestedPrice: null, stopLossPrice: 1990, takeProfitPrice: 2020, ...patch,
});

/** Asserts a pre-exchange refusal: certain, categorized, payload-free. */
function assertRefusal(label: string, category: string, codeFragment: string, messageFragment: string) {
  return (err: unknown) => {
    assert.ok(err instanceof ExecutionProviderError, `${label}: expected a provider error`);
    assert.equal(err.category, category, `${label}: category`);
    assert.equal(err.uncertain, false, `${label}: a refusal before submission is never an unknown outcome`);
    assert.match(err.message, new RegExp(codeFragment), `${label}: code`);
    assert.match(err.message, new RegExp(messageFragment), `${label}: message`);
    assert.equal(err.message.includes('XAUUSDm'), false, `${label}: the broker row must not leak into the error`);
    return true;
  };
}

/* -------------------------------------------------------------------------- */
describe('Gate 9 §11 (B2) — durable order identity is refused before any provider call', () => {
  test('a malformed clientOrderId produces zero transport calls', async () => {
    const bad = ['veltrix-order-1', '123456', 'T-99112', 've-XYZ', '', `ve-${'a'.repeat(23)}`, `ve-${'A'.repeat(24)}`, `ve-${HEX20}-r0`, 've-  ' + HEX20];
    for (const clientOrderId of bad) {
      const transport = transportOf();
      await assert.rejects(
        () => providerOf(transport).submitOrder(request({ clientOrderId })),
        assertRefusal(clientOrderId, 'validation', 'client_order_id_', 'rejected before submission'),
        `must refuse ${JSON.stringify(clientOrderId)}`,
      );
      assert.deepEqual(transport.calls, [], `no provider call may follow ${JSON.stringify(clientOrderId)}`);
    }
  });

  test('a missing or non-string identity is refused the same way', async () => {
    for (const clientOrderId of [undefined, null, 42, {}, ['ve-a']]) {
      const transport = transportOf();
      const req = request({ clientOrderId: clientOrderId as unknown as string });
      await assert.rejects(
        () => providerOf(transport).submitOrder(req),
        assertRefusal(JSON.stringify(clientOrderId), 'validation', 'client_order_id_(missing|not_a_string)', 'rejected before submission'),
      );
      assert.deepEqual(transport.calls, [], JSON.stringify(clientOrderId));
    }
  });

  test('identity is checked ahead of health, so an unavailable transport cannot mask it', async () => {
    // Ordering matters: if health ran first, a malformed id against a down
    // transport would surface as `unavailable` and could be retried.
    const transport = transportOf({ healthRecord: { configured: false, authenticated: false, connected: false, healthy: false } });
    await assert.rejects(() => providerOf(transport).submitOrder(request({ clientOrderId: 'veltrix-order-1' })), /client_order_id_/);
    assert.deepEqual(transport.calls, []);
    // A valid identity does reach the readiness check.
    await assert.rejects(() => providerOf(transport).submitOrder(request()), /not ready/);
    assert.deepEqual(transport.calls, ['health']);
  });

  test('a retry identity is accepted and its lineage is derivable', async () => {
    const transport = transportOf();
    const outcome = await providerOf(transport).submitOrder(request({ clientOrderId: `ve-${HEX20}-r1` }));
    assert.equal(outcome.status, 'accepted');
    assert.equal(transport.count('submitOrder'), 1);
    assert.equal(validateBridgeOrderIdentity(`ve-${HEX20}-r1`).retry, 1);
  });

  test('the pure identity helpers never throw and never leak the input', () => {
    assert.equal(bridgeOrderIdentityError(CLIENT_ORDER_ID), null);
    const err = bridgeOrderIdentityError('ve-secret-account-id-12345');
    assert.ok(err instanceof ExecutionProviderError);
    assert.equal(err.message.includes('12345'), false);
    assert.equal(err.message, 'Client order identity rejected before submission (client_order_id_hash_invalid)');
  });

  test('the disabled transport refuses everything, and identity still first', async () => {
    const provider = createMT5ExecutionProvider(new DisabledMT5Transport(), {
      enabled: true, environment: 'demo', broker: null, server: null, accountRef: null, symbols: new Map(), now: () => NOW,
    });
    await assert.rejects(() => provider.submitOrder(request({ clientOrderId: 'veltrix-order-1' })), /client_order_id_/);
    await assert.rejects(() => provider.submitOrder(request()), /disabled|not ready/);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §7/§26 (B5, R7.4.4) — one strict readiness rule for every consumer', () => {
  test('a merely truthy health field never authorizes a request', async () => {
    for (const health of [
      { configured: 'true', authenticated: true, connected: true, healthy: true },
      { configured: true, authenticated: 1, connected: true, healthy: true },
      { configured: true, authenticated: true, connected: {}, healthy: 'yes' },
      { configured: true, authenticated: true, healthy: true },
    ]) {
      const transport = transportOf({ healthRecord: health });
      await assert.rejects(
        () => providerOf(transport).submitOrder(request()),
        assertRefusal(JSON.stringify(health), 'unavailable', 'not ready', 'no request was sent'),
      );
      assert.equal(transport.count('submitOrder'), 0, JSON.stringify(health));
      assert.equal((transport.calls[0] ?? '') === 'health', true);
    }
  });

  test('readiness refusal codes are carried on the error, not only in prose', async () => {
    const cases: Array<[unknown, string, string]> = [
      [undefined, 'unavailable', 'health_missing'],
      [{ configured: true, authenticated: true, connected: true, healthy: 'true' }, 'unavailable', 'health_malformed'],
      [{ configured: true, authenticated: false, connected: true, healthy: true }, 'authentication', 'not_authenticated'],
      [{ configured: true, authenticated: true, connected: false, healthy: true }, 'unavailable', 'not_connected'],
      [{ configured: true, authenticated: true, connected: true, healthy: false }, 'unavailable', 'not_healthy'],
      [{ configured: true, authenticated: true, connected: true, healthy: true, state: 'uncertain' }, 'unavailable', 'state_uncertain'],
    ];
    for (const [health, category, code] of cases) {
      const error = bridgeReadinessError(health, 'transportHealth');
      assert.ok(error, JSON.stringify(health));
      assert.equal(error.category, category, JSON.stringify(health));
      assert.equal(error.readinessCode, code, JSON.stringify(health));
      assert.equal(error.uncertain, false, JSON.stringify(health));
      const transport = transportOf({ healthRecord: health });
      await assert.rejects(() => providerOf(transport).submitOrder(request()), /not ready/);
      assert.equal(transport.count('submitOrder'), 0, JSON.stringify(health));
    }
  });

  test('a contradictory record cannot satisfy a narrower profile either', async () => {
    // Reconciliation judges `available + healthy` only. Before the dependency
    // rule it could be satisfied by a provider that also stated it was not
    // connected — the projection is per-field, so the contradiction survived.
    const contradictory = { configured: true, authenticated: true, connected: false, available: true, healthy: true, state: 'healthy', checkedAt: new Date(NOW).toISOString() };
    assert.equal(resolveExecutionReadiness(contradictory, 'reconciliationHealth').decision.ready, false);
    assert.equal(resolveExecutionReadiness(contradictory, 'reconciliationHealth').decision.code, 'not_connected');
    assert.equal(bridgeReadinessError(contradictory, 'reconciliationHealth')?.readinessCode, 'not_connected');
    const providerStub = ((id: string) => ({
      id,
      name: 'Contradictory test provider',
      capabilities: { modes: ['demo'], orderTypes: [] },
      configured: true,
      describe: () => ({ id, configured: true }),
      health: async () => contradictory,
      getAccountInfo: async () => null,
      getInstrument: async () => null,
      listInstruments: async () => [],
      submitOrder: async () => { throw new ExecutionProviderError('unavailable', 'unused'); },
      cancelOrder: async () => {},
      modifyOrder: async () => {},
      getOrder: async () => null,
      listOrders: async () => [],
      getPosition: async () => null,
      listPositions: async () => [],
      closePosition: async () => {},
    })) as unknown as (id: string) => ExecutionProvider | undefined;
    const snapshots = new ProviderReconciliationSnapshotProvider(providerStub);
    await assert.rejects(
      () => snapshots.getSnapshot({ userId: 'u', executionProfileId: 'p', providerId: 'test-provider' }),
      (err: unknown) => {
        assert.ok(err instanceof ExecutionProviderError);
        assert.equal(err.category, 'unavailable');
        assert.equal(err.message, 'Execution provider is not available');
        return true;
      },
    );
  });

  test('a healthy transport passes, and the health projection agrees', async () => {
    const transport = transportOf();
    const provider = providerOf(transport);
    const health = await provider.health();
    assert.equal(health.healthy, true);
    assert.equal(health.available, true);
    assert.equal(isExecutionReady(health, 'providerHealth'), true);
    assert.equal((await provider.submitOrder(request())).status, 'accepted');
  });

  test('the resolver, the projection and the gate share one rule', () => {
    const record = { configured: true, authenticated: true, connected: true, available: true, healthy: true, state: 'healthy', reason: 'fine' };
    assert.equal(resolveExecutionReadiness(record, 'providerHealth').decision.ready, true);
    assert.deepEqual(explicitHealthFlags({ configured: 'yes', authenticated: 1, available: true }), {
      configured: false, authenticated: false, connected: false, available: true, healthy: false,
    });
    assert.deepEqual(readinessRequirements('transportHealth'), ['configured', 'authenticated', 'connected', 'healthy']);
    assert.deepEqual(Object.keys(READINESS_PROFILES).sort(), ['gateHealth', 'paperGateHealth', 'providerHealth', 'reconciliationHealth', 'transportHealth']);
    assert.equal(resolveExecutionReadiness({ healthy: 'true' }, 'gateHealth').decision.code, 'health_malformed');
    assert.equal(isExecutionReady({ healthy: 'true' }, 'gateHealth'), false);
    assert.equal(readinessViolationCode('health_malformed'), 'readiness_not_explicit');
    assert.equal(readinessViolationCode('state_uncertain'), 'readiness_uncertain');
    assert.equal(readinessViolationCode('not_connected'), 'readiness_unavailable');
  });

  test('assertExecutionReadiness fails closed with a certain outcome', () => {
    assert.doesNotThrow(() => assertExecutionReadiness({ healthy: true }, 'gateHealth', { mutation: 'submit' }));
    for (const health of [undefined, null, 'connected', { healthy: 'true' }, { healthy: false }, { healthy: true, state: 'uncertain' }]) {
      assert.throws(
        () => assertExecutionReadiness(health, 'gateHealth', { mutation: 'submit' }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeProtocolViolation, JSON.stringify(health));
          assert.equal(err.outcomeUnknown, false, JSON.stringify(health));
          assert.equal(err.message, 'Execution transport is not ready');
    assert.equal(err.mutation, 'submit');
    assert.ok(['readiness_not_explicit', 'readiness_unavailable', 'readiness_uncertain'].includes(err.code), JSON.stringify(health));
          return true;
        },
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §8 (B6) — stale and materially future quotes are both refused', () => {
  const submitWithQuote = (quoteTimestampMs: number, patch: Partial<MT5ProviderConfig> = {}) => {
    const transport = transportOf({ symbolRowValue: symbolRow({ quoteTimestampMs }) });
    return { transport, provider: providerOf(transport, patch) };
  };

  test('a fresh quote passes and an exactly-at-the-bound quote still passes', async () => {
    const { provider, transport } = submitWithQuote(NOW - BRIDGE_DEFAULT_POLICY.maxQuoteAgeMs);
    assert.equal((await provider.submitOrder(request())).status, 'accepted');
    assert.equal(transport.count('submitOrder'), 1);
  });

  test('a stale quote is refused before submission', async () => {
    const { provider, transport } = submitWithQuote(NOW - BRIDGE_DEFAULT_POLICY.maxQuoteAgeMs - 1);
    await assert.rejects(() => provider.submitOrder(request()), assertRefusal('stale', 'invalid_price', 'quote_stale', 'Broker quote rejected'));
    assert.equal(transport.count('submitOrder'), 0);
  });

  test('the clock-skew window is inclusive on both sides', async () => {
    assert.equal((await submitWithQuote(NOW + BRIDGE_DEFAULT_POLICY.clockSkewMs).provider.submitOrder(request())).status, 'accepted');
    await assert.rejects(
      () => submitWithQuote(NOW + BRIDGE_DEFAULT_POLICY.clockSkewMs + 1).provider.submitOrder(request()),
      assertRefusal('future', 'invalid_price', 'quote_future_beyond_clock_skew', 'Broker quote rejected'),
    );
  });

  test('a deployment may narrow the window but never widen the tolerance away', async () => {
    const narrow = submitWithQuote(NOW - 2_000, { maxQuoteAgeMs: 1_000 });
    await assert.rejects(() => narrow.provider.submitOrder(request()), /quote_stale/);
    const narrowSkew = submitWithQuote(NOW + 1_500, { clockSkewMs: 1_000 });
    await assert.rejects(() => narrowSkew.provider.submitOrder(request()), /quote_future_beyond_clock_skew/);
    assert.equal(narrowSkew.transport.count('submitOrder'), 0);
    // A non-finite override cannot disable the check.
    await assert.rejects(() => submitWithQuote(NOW - 2_000, { maxQuoteAgeMs: Number.POSITIVE_INFINITY }).provider.submitOrder(request()), /quote_/);
  });

  test('a broker row without a two-sided quote cannot fund a market order', async () => {
    const transport = transportOf({ symbolRowValue: symbolRow({ bid: undefined, ask: undefined, quoteTimestampMs: undefined }) });
    await assert.rejects(() => providerOf(transport).submitOrder(request()), assertRefusal('no quote', 'invalid_price', 'quote_missing', 'Broker quote rejected'));
    assert.equal(transport.count('submitOrder'), 0);
    // A limit order does not consume the live quote, so it is not blocked by it.
    const limit = transportOf({ symbolRowValue: symbolRow({ bid: undefined, ask: undefined, quoteTimestampMs: undefined }) });
    assert.equal((await providerOf(limit).submitOrder(request({ orderType: 'limit', requestedPrice: 2010 }))).status, 'accepted');
  });

  test('an inverted spread is malformed data, not a price', async () => {
    const transport = transportOf({ symbolRowValue: symbolRow({ bid: 2000.5, ask: 2000.1 }) });
    await assert.rejects(() => providerOf(transport).submitOrder(request()), /quote_/);
    assert.equal(transport.count('submitOrder'), 0);
  });

  test('quote rejection is a pure decision for non-transport callers', () => {
    assert.equal(bridgeQuoteError({ quote: null, nowMs: NOW, policy: {} })?.quoteCode, 'quote_missing');
    assert.equal(bridgeQuoteError({ quote: { symbol: 'XAUUSDm', bid: 1999.9, ask: 2000.1, timestampMs: NOW }, nowMs: NOW + 60_000, policy: {} })?.quoteCode, 'quote_stale');
    assert.equal(bridgeQuoteError({ quote: { symbol: 'XAUUSDm', bid: 1999.9, ask: 2000.1, timestampMs: NOW }, nowMs: NOW, policy: {} }), null);
    assert.deepEqual(
      { maxQuoteAgeMs: BRIDGE_DEFAULT_POLICY.maxQuoteAgeMs, clockSkewMs: BRIDGE_DEFAULT_POLICY.clockSkewMs },
      { maxQuoteAgeMs: 15_000, clockSkewMs: 5_000 },
    );
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §9 (B7) — instrument contract and volume step are enforced', () => {
  test('a zero volume step can never size an order', async () => {
    // The historical bug was an `Infinity` comparison that let ANY volume
    // through, so this must fail at the contract level, before sizing.
    for (const volumeStep of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      const transport = transportOf({ symbolRowValue: symbolRow({ volumeStep }) });
      const provider = providerOf(transport);
      await assert.rejects(() => provider.getInstrument('XAUUSD'), /volume_step_invalid/);
      for (const quantity of [0.01, 1, 10, 999]) {
        await assert.rejects(
          () => provider.submitOrder(request({ quantity })),
          assertRefusal(`${volumeStep}/${quantity}`, 'invalid_volume', 'volume_step_invalid', 'rejected before submission'),
          `volumeStep ${volumeStep} must refuse ${quantity}`,
        );
      }
      assert.equal(transport.count('submitOrder'), 0, String(volumeStep));
    }
  });

  test('off-step, below-minimum and above-maximum volumes are refused', async () => {
    for (const [quantity, code] of [['0.105', 'volume_not_on_step'], ['0.001', 'volume_below_minimum'], ['10.01', 'volume_above_maximum'], ['0', 'volume_not_positive'], ['-0.1', 'volume_not_positive'], ['NaN', 'volume_not_finite'], ['Infinity', 'volume_not_finite']] as const) {
      const transport = transportOf();
      const parsed = code === 'volume_not_finite' ? Number.NaN : Number(quantity);
      await assert.rejects(
        () => providerOf(transport).submitOrder(request({ quantity: parsed })),
        assertRefusal(quantity, 'invalid_volume', code, 'Requested volume rejected'),
      );
      assert.equal(transport.count('submitOrder'), 0, quantity);
    }
  });

  test('on-step volumes inside the range pass, float noise included', async () => {
    const transport = transportOf({ symbolRowValue: symbolRow({ volumeMin: 0.1, volumeMax: 100, volumeStep: 0.1 }) });
    for (const quantity of [0.1, 0.7, 3.4, 100]) {
      assert.equal((await providerOf(transport).submitOrder(request({ quantity }))).status, 'accepted', String(quantity));
    }
  });

  test('an unusable contract is refused with the code that names the defect', async () => {
    const cases: Array<[Partial<MT5SymbolSnapshot>, string, string]> = [
      [{ contractSize: 0 }, 'contract_size_invalid', 'validation'],
      [{ contractSize: -100 }, 'contract_size_invalid', 'validation'],
      [{ tickSize: 0 }, 'tick_size_invalid', 'validation'],
      [{ digits: 2.5 }, 'price_digits_invalid', 'validation'],
      [{ digits: -1 }, 'price_digits_invalid', 'validation'],
      [{ volumeMin: 0 }, 'volume_min_invalid', 'validation'],
      [{ volumeMax: 0.001 }, 'volume_range_inverted', 'validation'],
      [{ orderTypes: [] }, 'order_types_invalid', 'validation'],
      [{ volumeStep: 1000 }, 'instrument_malformed', 'validation'],
    ];
    for (const [patch, code, category] of cases) {
      const transport = transportOf({ symbolRowValue: symbolRow(patch) });
      const provider = providerOf(transport);
      await assert.rejects(() => provider.getInstrument('XAUUSD'), assertRefusal(JSON.stringify(patch), category, code, 'Broker instrument contract rejected'));
      await assert.rejects(() => provider.submitOrder(request()), assertRefusal(`submit ${JSON.stringify(patch)}`, category, code, 'rejected before submission'));
      assert.equal(transport.count('submitOrder'), 0, JSON.stringify(patch));
    }
  });

  test('a broker row whose identity does not match the mapping is refused', async () => {
    // A row that does not answer to the configured broker symbol is simply not
    // the instrument we asked for: null, never a substitute.
    const transport = transportOf({ symbolRowValue: symbolRow({ symbol: 'XAUUSDx' }) });
    assert.equal(await providerOf(transport).getInstrument('XAUUSD'), null);
    assert.equal(transport.count('submitOrder'), 0);
    const other = transportOf({ symbolRowValue: symbolRow() });
    await assert.rejects(() => providerOf(other).submitOrder(request({ assetClass: 'forex' })), /does not match the canonical instrument/);
    assert.equal(other.count('submitOrder'), 0);
  });

  test('a closed or unsupported market state refuses execution', async () => {
    for (const tradeMode of ['closed', 'disabled', 'unknown'] as const) {
      const transport = transportOf({ symbolRowValue: symbolRow({ tradeMode }) });
      await assert.rejects(() => providerOf(transport).submitOrder(request()), /Order type or trading status is not supported/);
      assert.equal(transport.count('submitOrder'), 0, tradeMode);
    }
    const unsupported = transportOf({ symbolRowValue: symbolRow({ orderTypes: ['limit'] }) });
    await assert.rejects(() => providerOf(unsupported).submitOrder(request({ orderType: 'stop' })), /Order type or trading status is not supported/);
    assert.equal(unsupported.count('submitOrder'), 0);
  });

  test('unmapped symbols and missing instruments fail closed without a guess', async () => {
    const transport = transportOf();
    await assert.rejects(() => providerOf(transport).submitOrder(request({ symbol: 'US500' })), /No explicit MT5 symbol mapping exists/);
    assert.equal(transport.count('submitOrder'), 0);
    const noRow = transportOf({ symbolRowValue: symbolRow({ symbol: 'OTHER' }) });
    assert.equal(await providerOf(noRow).getInstrument('XAUUSD'), null, 'a broker row that does not exist returns null, never defaults');
    await assert.rejects(() => providerOf(noRow).submitOrder(request()), /does not match the canonical instrument|No broker symbol/);
    assert.equal(noRow.count('submitOrder'), 0);
  });

  test('the instrument and volume helpers are pure and reusable', () => {
    // `validateBridgeInstrument` consumes the PROJECTED contract (exactly what
    // the MT5 adapter builds from a broker row), never the raw snapshot.
    const contract = contractOf(symbolRow());
    assert.equal(validateBridgeInstrument(contract).error, null);
    assert.equal(validateBridgeInstrument(contract, { canonicalSymbol: 'EURUSD' }).error?.category, 'invalid_symbol');
    assert.equal(validateBridgeInstrument(contractOf(symbolRow({ volumeStep: 0 }))).error?.category, 'invalid_volume');
    assert.equal(validateBridgeInstrument(null).error?.message, 'Broker instrument contract rejected before submission (instrument_missing)');
    assert.equal(validateBridgeInstrument({}).error?.message, 'Broker instrument contract rejected before submission (contract_size_invalid)');
    assert.equal(bridgeVolumeError({ volume: 0.105, contract: validateBridgeInstrument(contract).contract })?.volumeCode, 'volume_not_on_step');
    assert.equal(bridgeVolumeError({ volume: 0.1, contract: validateBridgeInstrument(contract).contract }), null);
    assert.equal(bridgeVolumeError({ volume: 0.1, contract: null })?.volumeCode, 'volume_step_invalid');
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §18/§21 (B9) — an unreadable provider state stays uncertain', () => {
  test('a post-submit status outside the vocabulary becomes uncertainty, never failure', async () => {
    for (const status of ['FILLED', 'vendor_new_state', '', 'accepted\n', 3, null, undefined, {}]) {
      const transport = transportOf({ submitResult: orderRow({ status: status as unknown as string }) });
      const provider = providerOf(transport);
      await assert.rejects(
        () => provider.submitOrder(request()),
        (err: unknown) => {
          assert.ok(err instanceof ExecutionProviderError);
          assert.equal(err.category, 'uncertain', JSON.stringify(status));
          assert.equal(err.uncertain, true, JSON.stringify(status));
          // The message is the fixed normalization literal: the raw provider
          // value never appears, and the category is uncertainty, not failure.
          assert.equal(err.message, 'order submission outcome is uncertain; reconciliation is required');
          assert.equal(err.message.includes('FILLED'), false, 'the provider value is never echoed');
          return true;
        },
      );
      assert.equal(transport.count('submitOrder'), 1, JSON.stringify(status));
    }
  });

  test('an existing order with an unreadable state refuses before resubmission', async () => {
    const transport = transportOf({ existing: orderRow({ status: 'weird' as never }) });
    await assert.rejects(() => providerOf(transport).submitOrder(request()), (err: unknown) => {
      assert.ok(err instanceof ExecutionProviderError);
      assert.equal(err.category, 'uncertain');
      assert.match(err.message, /reconciliation is required/);
      return true;
    });
    assert.equal(transport.count('submitOrder'), 0, 'an ambiguous prior order must not be resubmitted');
    // The in-flight path surfaces the same uncertainty through listOrders.
    const states = await providerOf(transport).listOrders();
    assert.equal(states[0]?.status, null);
    assert.equal(states[0]?.statusUncertain, true);
  });

  test('a known status is mapped exactly and case-sensitively', async () => {
    for (const [raw, expected] of Object.entries({ accepted: 'accepted', filled: 'filled', partial: 'partially_filled', canceled: 'cancelled', rejected: 'rejected' })) {
      const transport = transportOf({ submitResult: orderRow({ status: raw as never }) });
      const outcome = await providerOf(transport).submitOrder(request());
      assert.equal(outcome.status, expected === 'rejected' ? 'rejected' : 'accepted', raw);
    }
    const unknownCase = normalizeBridgeProviderStatus('FILLED');
    assert.equal(unknownCase.status, null);
    assert.equal(unknownCase.statusUncertain, true);
    assert.equal(unknownCase.snapshotStatus, 'uncertain');
    assert.equal(normalizeBridgeProviderStatus('filled').statusUncertain, false);
    assert.equal(normalizeBridgeProviderStatus('market_closed').deterministicCondition, 'market_closed');
  });

  test('normalizeMT5Order keeps uncertainty and rejects an unbounded ticket', () => {
    const uncertain = normalizeMT5Order(orderRow({ status: 'FILLED' as never }));
    assert.equal(uncertain.status, null);
    assert.equal(uncertain.statusUncertain, true);
    assert.equal(normalizeMT5Order(orderRow({ status: 'filled' })).status, 'filled');
    assert.throws(() => normalizeMT5Order(orderRow({ ticket: '' })), (err: unknown) => err instanceof ExecutionProviderError);
    assert.throws(() => normalizeMT5Order(orderRow({ ticket: 'x'.repeat(200) })), ExecutionProviderError);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §22 — a refusal never fabricates an order state', () => {
  test('rejected submissions report no outcome rather than a fabricated one', async () => {
    for (const patch of [{ clientOrderId: 'veltrix-order-1' }, { quantity: 0.105 }, { symbol: 'US500' }]) {
      const transport = transportOf({ healthRecord: undefined });
      await assert.rejects(() => providerOf(transport).submitOrder(request(patch)));
      assert.equal(transport.count('submitOrder'), 0);
      assert.equal(normalizeBridgeProviderStatus(undefined).status, null);
      assert.equal(normalizeBridgeProviderStatus(undefined).snapshotStatus, 'uncertain');
    }
  });
});
