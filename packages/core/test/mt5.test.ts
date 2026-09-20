import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionProviderError, type ExecutionSubmitOrderRequest } from '@veltrixeye/contracts';
import {
  DisabledMT5Transport,
  createMT5ExecutionProvider,
  normalizeMT5Error,
  normalizeMT5Order,
  type MT5AccountSnapshot,
  type MT5OrderRequest,
  type MT5OrderSnapshot,
  type MT5PositionSnapshot,
  type MT5SymbolSnapshot,
  type MT5Transport,
} from '../src/index.js';

const NOW = 1_700_000_000_000;
class MockTransport implements MT5Transport {
  configured = true;
  submitted: MT5OrderRequest[] = [];
  existing: MT5OrderSnapshot | null = null;
  submitError: Error | null = null;
  symbolRow: MT5SymbolSnapshot = {
    symbol: 'XAUUSDm', assetClass: 'commodity', bid: 1999.9, ask: 2000.1, quoteTimestampMs: NOW,
    contractSize: 100, volumeMin: 0.01, volumeMax: 10, volumeStep: 0.01, digits: 2,
    tickSize: 0.01, orderTypes: ['market', 'limit'], tradeMode: 'open',
  };
  async health() { return { configured: true, authenticated: true, connected: true, healthy: true }; }
  async account(): Promise<MT5AccountSnapshot> { return { login: 'masked-account', broker: 'Example MT5 Broker', server: 'Example-Demo', currency: 'USD', balance: 10000 }; }
  async symbol(symbol: string) { return symbol === this.symbolRow.symbol ? this.symbolRow : null; }
  async submitOrder(order: MT5OrderRequest) { this.submitted.push(order); if (this.submitError) throw this.submitError; return { ticket: '123', clientOrderId: order.clientOrderId, symbol: order.symbol, status: 'accepted', volume: order.volume, timestampMs: NOW }; }
  async findOrderByClientId() { return this.existing; }
  async cancelOrder() {}
  async modifyOrder() {}
  async order() { return this.existing; }
  async orders() { return this.existing ? [this.existing] : []; }
  async position(): Promise<MT5PositionSnapshot | null> { return null; }
  async positions(): Promise<MT5PositionSnapshot[]> { return []; }
  async closePosition() {}
}
const request = (patch: Partial<ExecutionSubmitOrderRequest> = {}): ExecutionSubmitOrderRequest => ({
  clientOrderId: 'veltrix-order-1', idempotencyKey: 'a'.repeat(64), authorizationId: 'server-auth',
  assetClass: 'commodity', symbol: 'XAUUSD', side: 'buy', orderType: 'market', quantity: 0.1,
  requestedPrice: null, stopLossPrice: 1990, takeProfitPrice: 2020, ...patch,
});
const provider = (transport: MT5Transport = new MockTransport(), patch = {}) => createMT5ExecutionProvider(transport, {
  enabled: true, environment: 'demo', broker: 'Example MT5 Broker', server: 'Example-Demo',
  accountRef: 'masked-account', symbols: new Map([['XAUUSD', 'XAUUSDm']]), now: () => NOW, ...patch,
});

// No real endpoint, credential, broker account, or network operation is used by this suite.
describe('M8.4 MT5 provider boundary', () => {
  test('unconfigured disabled transport reports honestly', async () => {
    const p = createMT5ExecutionProvider(new DisabledMT5Transport(), { enabled: false, environment: 'demo', broker: null, server: null, accountRef: null, symbols: new Map(), now: () => NOW });
    assert.equal(p.configured, false);
    assert.deepEqual(await p.health(), { configured: false, authenticated: false, connected: false, available: false, healthy: false, state: 'disabled', reason: 'mt5_transport_unconfigured', checkedAt: new Date(NOW).toISOString() });
    await assert.rejects(p.getAccountInfo(), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable');
  });

  test('disabled configured provider is unavailable, never merely healthy by configuration', async () => {
    const h = await provider(new MockTransport(), { enabled: false }).health();
    assert.equal(h.configured, true); assert.equal(h.available, false); assert.equal(h.healthy, false); assert.equal(h.state, 'disabled');
  });

  test('live environment hard-stop overrides a healthy transport', async () => {
    const p = provider(new MockTransport(), { environment: 'live' });
    assert.equal((await p.health()).reason, 'live_execution_prohibited_m8_4');
    await assert.rejects(p.submitOrder(request()), /Live MT5 execution is prohibited/);
  });

  test('normalizes account and instrument metadata with explicit symbol mapping', async () => {
    const p = provider();
    const account = await p.getAccountInfo();
    assert.equal(account?.environment, 'demo'); assert.equal(account?.server, 'Example-Demo');
    const instrument = await p.getInstrument('XAUUSD');
    assert.equal(instrument?.providerSymbol, 'XAUUSDm'); assert.equal(instrument?.contractSize, 100);
    assert.equal(instrument?.minVolume, 0.01); assert.equal(instrument?.volumeStep, 0.01);
    assert.deepEqual(instrument?.quote, { bid: 1999.9, ask: 2000.1, spread: 0.1999999999998181, timestampMs: NOW });
  });

  test('missing explicit symbol mapping fails closed', async () => {
    await assert.rejects(provider().getInstrument('EURUSD'), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'invalid_symbol');
    await assert.rejects(provider().submitOrder(request({ symbol: 'EURUSD', assetClass: 'forex' })), /No explicit MT5 symbol mapping/);
  });

  test('deterministically translates normalized orders without symbol override', async () => {
    const t = new MockTransport(); const result = await provider(t).submitOrder(request());
    assert.equal(result.providerOrderId, '123'); assert.equal(result.status, 'accepted');
    assert.deepEqual(t.submitted[0], { clientOrderId: 'veltrix-order-1', symbol: 'XAUUSDm', side: 'buy', orderType: 'market', volume: 0.1, price: null, stopLoss: 1990, takeProfit: 2020 });
  });

  test('rejects missing server authorization and mandatory SL/TP', async () => {
    await assert.rejects(provider().submitOrder(request({ authorizationId: undefined })), /server-issued/);
    await assert.rejects(provider().submitOrder(request({ stopLossPrice: null })), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'invalid_protection');
    await assert.rejects(provider().submitOrder(request({ takeProfitPrice: null })), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'invalid_protection');
  });

  test('rejects invalid volume and never rounds size upward', async () => {
    for (const quantity of [0.001, 10.01, 0.105]) await assert.rejects(provider().submitOrder(request({ quantity })), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'invalid_volume');
  });

  test('rejects missing, contradictory, and stale prices', async () => {
    for (const changes of [
      { bid: undefined, ask: undefined },
      { bid: 2001, ask: 2000 },
      { quoteTimestampMs: NOW - 15_001 },
    ]) {
      const t = new MockTransport(); t.symbolRow = { ...t.symbolRow, ...changes };
      await assert.rejects(provider(t).submitOrder(request()), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'invalid_price');
    }
  });

  test('normalizes broker order state and a structured receipt without the broker message', () => {
    // Gate 10: the receipt keeps bounded structured data only; the broker's
    // free-text `message` is provider-controlled and is never retained.
    assert.deepEqual(normalizeMT5Order({ ticket: '42', symbol: 'XAUUSDm', status: 'partial', volume: 1, filledVolume: 0.4, averagePrice: 2000, retcode: 10009, message: 'done', timestampMs: NOW }), {
      providerOrderId: '42', status: 'partially_filled', filledQuantity: 0.4, averagePrice: 2000,
      raw: { retcode: 10009, timestampMs: NOW },
    });
  });

  test('normalizes authentication, connection, timeout, broker validation and margin failures', () => {
    const cases = [['bad login', 'authentication'], ['socket disconnected', 'connection'], ['request timeout', 'timeout'], ['invalid symbol', 'invalid_symbol'], ['invalid volume', 'invalid_volume'], ['insufficient margin', 'insufficient_funds'], ['market closed', 'market_closed']] as const;
    for (const [message, category] of cases) assert.equal(normalizeMT5Error(new Error(message), 'test').category, category);
  });

  test('unknown broker response becomes an uncertain execution state', async () => {
    const t = new MockTransport();
    t.submitOrder = async () => ({ ticket: 'maybe', clientOrderId: 'veltrix-order-1', symbol: 'XAUUSDm', status: 'vendor_new_state', volume: 0.1, timestampMs: NOW });
    await assert.rejects(provider(t).submitOrder(request()), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'uncertain' && e.uncertain);
  });

  test('lost response is uncertain, never mislabeled rejection or blindly retried', async () => {
    const t = new MockTransport(); const error = new Error('response lost') as Error & { responseLost: boolean }; error.responseLost = true; t.submitError = error;
    await assert.rejects(provider(t).submitOrder(request()), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'uncertain' && e.uncertain);
    assert.equal(t.submitted.length, 1);
  });

  test('duplicate retry resolves by client id before submit', async () => {
    const t = new MockTransport(); t.existing = { ticket: 'already', clientOrderId: 'veltrix-order-1', symbol: 'XAUUSDm', status: 'accepted', volume: 0.1, timestampMs: NOW };
    const out = await provider(t).submitOrder(request());
    assert.equal(out.providerOrderId, 'already'); assert.equal(t.submitted.length, 0);
  });

  test('description contains no credentials and makes live status explicit', () => {
    const text = JSON.stringify(provider().describe());
    assert.equal(/password|token|apiKey|secretRef/i.test(text), false);
    assert.match(text, /"liveExecutionAvailable":false/);
  });
});
