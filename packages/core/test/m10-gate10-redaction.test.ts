/**
 * M10 Gate 10 — legacy M8.4 MT5 response-normalizer redaction.
 *
 * Proves that provider-controlled data (error objects, messages, codes, stacks,
 * request/header objects, order free text, health reasons, account logins)
 * never crosses the adapter boundary, and that an ambiguous order-submission
 * failure can never be reported as a certain outcome.
 *
 * Every secret-looking value below is a fabricated test sentinel. No real
 * credential, endpoint, broker account, or network operation is involved.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  EXECUTION_FAILURE_CATEGORIES,
  ExecutionProviderError,
  type ExecutionFailureCategory,
  type ExecutionProviderHealth,
  type ExecutionSubmitOrderRequest,
} from '@veltrixeye/contracts';
import {
  DisabledMT5Transport,
  MT5_TRANSPORT_UNHEALTHY_REASON,
  PROVIDER_MISSING_REASON,
  ProviderReconciliationSnapshotProvider,
  createMT5ExecutionProvider,
  normalizeMT5Error,
  normalizeMT5Order,
  toSafeProviderHealth,
  type MT5AccountSnapshot,
  type MT5OrderRequest,
  type MT5OrderSnapshot,
  type MT5PositionSnapshot,
  type MT5SymbolSnapshot,
  type MT5Transport,
  type MT5TransportHealth,
} from '../src/index.js';

/* Fabricated sentinels — never real credentials. */
const SECRET = 'FAKE-BROKER-PASSWORD-sentinel-7f3a9c2e';
const TOKEN = 'fake-bearer-token-sentinel-0123456789abcdef';
const LOGIN = '90012345-fake-login-sentinel';
const SENTINELS = [SECRET, TOKEN, LOGIN];
const NOW = 1_700_000_000_000;
const SUBMISSION = 'order submission';
const LOOKUP = 'order lookup';
const AMBIGUOUS: readonly ExecutionFailureCategory[] = ['timeout', 'connection', 'unknown', 'uncertain'];

/** Every representation a consumer, logger or serializer could reach. */
function representations(value: unknown): string[] {
  const out: string[] = [inspect(value, { depth: 20, showHidden: true })];
  if (value instanceof Error) {
    out.push(String(value.message), String(value.stack ?? ''), JSON.stringify(value, Object.getOwnPropertyNames(value)));
  } else {
    out.push(JSON.stringify(value) ?? '');
  }
  return out;
}
function assertNoSentinel(value: unknown, context: string): void {
  for (const text of representations(value)) {
    for (const sentinel of SENTINELS) assert.equal(text.includes(sentinel), false, `${context}: sentinel leaked: ${text.slice(0, 200)}`);
  }
}
function assertSafeShape(err: ExecutionProviderError, context: string): void {
  assert.ok(err instanceof ExecutionProviderError, `${context}: ExecutionProviderError`);
  assert.equal('cause' in err, false, `${context}: no cause property at all`);
  assert.equal(err.cause, undefined, `${context}: cause is undefined`);
  // `name` is assigned by the contract class itself; nothing else may be enumerable.
  assert.deepEqual(Object.keys(err).sort(), ['category', 'name', 'retryable', 'uncertain'], `${context}: only contract fields are enumerable`);
  assert.equal(err.name, 'ExecutionProviderError', `${context}: contract name`);
  assert.ok((EXECUTION_FAILURE_CATEGORIES as readonly string[]).includes(err.category), `${context}: closed category`);
  assert.ok(err.message.length > 0 && err.message.length < 160, `${context}: fixed short message`);
  assert.equal([...err.message].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f), false, `${context}: single-line, control-free message`);
  assertNoSentinel(err, context);
}
function transportError(message: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(message);
  Object.assign(e, extra);
  return e;
}
/** A hostile upstream error: secrets in every place a real client library puts them. */
function hostileError(message: string): Error {
  const e = transportError(message, {
    code: `E_${SECRET}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    request: { url: `https://bridge.invalid/login?password=${SECRET}`, body: { login: LOGIN, password: SECRET } },
    response: { data: { detail: `token ${TOKEN}` } },
    config: { auth: { username: LOGIN, password: SECRET } },
    login: LOGIN,
  });
  e.stack = `Error: ${message}\n    at bridge.request (/srv/bridge/client.js:1:1) password=${SECRET}\n    at login (${LOGIN})`;
  return e;
}

class MockTransport implements MT5Transport {
  configured = true;
  submitted: MT5OrderRequest[] = [];
  accountCalls = 0;
  existing: MT5OrderSnapshot | null = null;
  submitError: unknown = null;
  submitResult: Partial<MT5OrderSnapshot> = {};
  healthResult: MT5TransportHealth = { configured: true, authenticated: true, connected: true, healthy: true };
  healthError: unknown = null;
  accountResult: MT5AccountSnapshot = { login: LOGIN, broker: `Broker ${SECRET}`, server: `Server ${TOKEN}`, currency: 'USD', balance: 10_000, equity: 10_000, marginFree: 9_000 };
  symbolRow: MT5SymbolSnapshot = {
    symbol: 'XAUUSDm', assetClass: 'commodity', bid: 1999.9, ask: 2000.1, quoteTimestampMs: NOW,
    contractSize: 100, volumeMin: 0.01, volumeMax: 10, volumeStep: 0.01, digits: 2,
    tickSize: 0.01, orderTypes: ['market', 'limit'], tradeMode: 'open',
  };
  async health() { if (this.healthError) throw this.healthError; return this.healthResult; }
  async account() { this.accountCalls += 1; return this.accountResult; }
  async symbol(symbol: string) { return symbol === this.symbolRow.symbol ? this.symbolRow : null; }
  async submitOrder(order: MT5OrderRequest): Promise<MT5OrderSnapshot> {
    this.submitted.push(order);
    if (this.submitError) throw this.submitError;
    return { ticket: '123', clientOrderId: order.clientOrderId, symbol: order.symbol, status: 'accepted', volume: order.volume, timestampMs: NOW, ...this.submitResult };
  }
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
  // Gate 9 §11 (B2): a durable VeltrixEye client order identity is required
  // before any transport call, so the fixture uses the accepted 24-hex form.
  clientOrderId: `ve-${'a'.repeat(24)}`, idempotencyKey: 'a'.repeat(64), authorizationId: 'server-auth',
  assetClass: 'commodity', symbol: 'XAUUSD', side: 'buy', orderType: 'market', quantity: 0.1,
  requestedPrice: null, stopLossPrice: 1990, takeProfitPrice: 2020, ...patch,
});
const provider = (transport: MT5Transport = new MockTransport(), patch = {}) => createMT5ExecutionProvider(transport, {
  enabled: true, environment: 'demo', broker: 'Example MT5 Broker', server: 'Example-Demo',
  accountRef: 'masked-account', symbols: new Map([['XAUUSD', 'XAUUSDm']]), now: () => NOW, ...patch,
});

describe('Gate 10 — normalizeMT5Error classification branches (non-submission operation)', () => {
  const branches: ReadonlyArray<[label: string, error: unknown, category: ExecutionFailureCategory, message: string]> = [
    ['timeout', transportError('request timeout'), 'timeout', `${LOOKUP} timed out before submission was confirmed`],
    ['timedout code', transportError('bridge failure', { code: 'ETIMEDOUT' }), 'timeout', `${LOOKUP} timed out before submission was confirmed`],
    ['timed out phrasing', transportError('Request timed out'), 'timeout', `${LOOKUP} timed out before submission was confirmed`],
    ['connect', transportError('connect ECONNREFUSED 127.0.0.1:443'), 'connection', 'Broker connection failed'],
    ['socket', transportError('socket hang up'), 'connection', 'Broker connection failed'],
    ['network', transportError('network unreachable'), 'connection', 'Broker connection failed'],
    ['auth', transportError('auth failed'), 'authentication', 'Broker authentication failed'],
    ['login', transportError('bad login'), 'authentication', 'Broker authentication failed'],
    ['credential', transportError('invalid credential'), 'authentication', 'Broker authentication failed'],
    ['numeric code 10017', transportError('rejected', { code: 10017 }), 'authentication', 'Broker authentication failed'],
    ['symbol', transportError('unknown symbol'), 'invalid_symbol', 'Broker rejected the instrument'],
    ['lot', transportError('invalid lot'), 'invalid_volume', 'Broker rejected the volume'],
    ['volume', transportError('invalid volume'), 'invalid_volume', 'Broker rejected the volume'],
    ['margin', transportError('not enough margin'), 'insufficient_funds', 'Broker reported insufficient margin'],
    ['fund', transportError('insufficient funds'), 'insufficient_funds', 'Broker reported insufficient margin'],
    ['market closed', transportError('market closed'), 'market_closed', 'Broker market is closed or trading is disabled'],
    ['trade disabled', transportError('trade disabled'), 'market_closed', 'Broker market is closed or trading is disabled'],
    ['unknown (previously untested)', transportError('weird vendor state'), 'unknown', `${LOOKUP} failed with an unrecognized broker response`],
    ['responseLost', transportError('response lost', { responseLost: true }), 'uncertain', `${LOOKUP} outcome is uncertain; reconciliation is required`],
  ];
  for (const [label, error, category, message] of branches) {
    test(`${label} → ${category} with a fixed message and no cause`, () => {
      const err = normalizeMT5Error(error, LOOKUP);
      assert.equal(err.category, category);
      assert.equal(err.message, message);
      assert.equal(err.uncertain, category === 'uncertain');
      assert.equal(err.retryable, false);
      assertSafeShape(err, label);
    });
  }

  test('responseLost takes precedence over every other signal', () => {
    for (const message of ['bad login', 'request timeout', 'invalid symbol', 'insufficient margin', 'market closed']) {
      const err = normalizeMT5Error(transportError(message, { responseLost: true }), LOOKUP);
      assert.equal(err.category, 'uncertain', message);
      assert.equal(err.uncertain, true, message);
    }
    // Only a literal `true` counts; truthy junk is ignored.
    assert.equal(normalizeMT5Error(transportError('bad login', { responseLost: 'yes' }), LOOKUP).category, 'authentication');
  });

  test('existing precedence for non-submission operations is unchanged (auth before timeout/connection)', () => {
    assert.equal(normalizeMT5Error(transportError('timeout waiting for login'), LOOKUP).category, 'authentication');
    assert.equal(normalizeMT5Error(transportError('connection refused during auth'), LOOKUP).category, 'authentication');
    assert.equal(normalizeMT5Error(transportError('symbol timeout'), LOOKUP).category, 'timeout');
  });
});

describe('Gate 10 — order submission can never become falsely certain', () => {
  const cases: ReadonlyArray<[label: string, message: string, category: ExecutionFailureCategory, uncertain: boolean]> = [
    ['timeout', 'request timeout', 'timeout', true],
    ['timedout', 'ETIMEDOUT', 'timeout', true],
    ['connect', 'connect ECONNREFUSED', 'connection', true],
    ['socket', 'socket hang up', 'connection', true],
    ['network', 'network error', 'connection', true],
    ['auth', 'auth failed', 'authentication', false],
    ['login', 'bad login', 'authentication', false],
    ['symbol', 'invalid symbol', 'invalid_symbol', false],
    ['lot', 'invalid lot size', 'invalid_volume', false],
    ['volume', 'invalid volume', 'invalid_volume', false],
    ['margin', 'insufficient margin', 'insufficient_funds', false],
    ['fund', 'not enough funds', 'insufficient_funds', false],
    ['market closed', 'market closed', 'market_closed', false],
    ['trade disabled', 'trade disabled', 'market_closed', false],
    ['unknown', 'vendor_new_failure', 'uncertain', true],
  ];
  for (const [label, message, category, uncertain] of cases) {
    test(`${label} → ${category} uncertain=${uncertain}`, () => {
      const err = normalizeMT5Error(transportError(message), SUBMISSION);
      assert.equal(err.category, category);
      assert.equal(err.uncertain, uncertain);
      assertSafeShape(err, label);
    });
  }

  test('unrecognized submission failure keeps the fixed uncertain message', () => {
    const err = normalizeMT5Error(transportError('vendor_new_failure'), SUBMISSION);
    assert.equal(err.message, 'Order submission returned an unrecognized broker state; reconciliation is required');
    assert.equal(err.uncertain, true);
  });

  test('responseLost precedence during submission', () => {
    for (const message of ['invalid symbol', 'bad login', 'market closed', 'insufficient margin', 'request timeout']) {
      const err = normalizeMT5Error(transportError(message, { responseLost: true }), SUBMISSION);
      assert.equal(err.category, 'uncertain', message);
      assert.equal(err.uncertain, true, message);
      assert.equal(err.message, `${SUBMISSION} outcome is uncertain; reconciliation is required`);
    }
  });

  test('a substring in a timeout/connection message cannot downgrade the outcome to a certain rejection', () => {
    const mixed: ReadonlyArray<[string, ExecutionFailureCategory]> = [
      ['timeout while waiting for login response', 'timeout'],
      ['request timed out: invalid symbol pending', 'timeout'],
      ['insufficient margin (socket closed)', 'connection'],
      ['market closed? connection reset by peer', 'connection'],
      ['invalid volume; network partition', 'connection'],
      ['credential check timeout', 'timeout'],
    ];
    for (const [message, category] of mixed) {
      const err = normalizeMT5Error(transportError(message), SUBMISSION);
      assert.equal(err.category, category, message);
      assert.equal(err.uncertain, true, message);
    }
  });

  test('property: no submission failure with an ambiguous category is ever certain, and `unknown` never appears', () => {
    const words = ['timeout', 'timedout', 'connect', 'network', 'socket', 'auth', 'login', 'credential', '10017', 'symbol', 'volume', 'lot', 'margin', 'fund', 'market closed', 'trade disabled', 'zzz', '', 'done', SECRET];
    for (const a of words) {
      for (const b of words) {
        for (const error of [transportError(`${a} ${b}`), transportError(`${b}`, { code: a }), { message: `${a} ${b}` }, `${a} ${b}`]) {
          const err = normalizeMT5Error(error, SUBMISSION);
          assert.notEqual(err.category, 'unknown', `${a}|${b}`);
          if (AMBIGUOUS.includes(err.category)) assert.equal(err.uncertain, true, `${a}|${b} → ${err.category}`);
          assertSafeShape(err, `${a}|${b}`);
        }
      }
    }
  });

  test('provider-level submit: timeout and connection failures surface as uncertain, exactly one submission attempt', async () => {
    for (const message of ['request timeout', 'socket hang up', 'vendor_new_failure']) {
      const t = new MockTransport();
      t.submitError = hostileError(message);
      await assert.rejects(provider(t).submitOrder(request()), (e: unknown) => {
        assert.ok(e instanceof ExecutionProviderError);
        assert.equal(e.uncertain, true, message);
        assertSafeShape(e, message);
        return true;
      });
      assert.equal(t.submitted.length, 1);
    }
  });
});

describe('Gate 10 — pass-through ExecutionProviderError is rebuilt from contract fields only', () => {
  test('a new instance with fixed message; category/uncertain/retryable preserved; cause, stack and extras dropped', () => {
    const upstream = new ExecutionProviderError('validation', `bridge said: password=${SECRET}`, { cause: hostileError(`token ${TOKEN}`), retryable: true });
    Object.assign(upstream, { request: { headers: { authorization: TOKEN } }, login: LOGIN });
    upstream.stack = `ExecutionProviderError: ${SECRET}\n    at x (${LOGIN})`;
    const err = normalizeMT5Error(upstream, LOOKUP);
    assert.notEqual(err, upstream);
    assert.equal(err.category, 'validation');
    assert.equal(err.retryable, true);
    assert.equal(err.uncertain, false);
    assert.equal(err.message, `${LOOKUP} failed broker validation`);
    assert.equal('request' in err, false);
    assert.equal('login' in err, false);
    assertSafeShape(err, 'pass-through');
  });

  test('every category round-trips to itself with a fixed message (positive control)', () => {
    for (const category of EXECUTION_FAILURE_CATEGORIES) {
      const err = normalizeMT5Error(new ExecutionProviderError(category, SECRET, { cause: SECRET }), LOOKUP);
      assert.equal(err.category, category);
      assert.equal(err.uncertain, category === 'uncertain');
      assertSafeShape(err, category);
    }
  });

  test('uncertain=true is preserved, and the order-submission floor applies to pass-through ambiguous categories too', () => {
    assert.equal(normalizeMT5Error(new ExecutionProviderError('validation', 'x', { uncertain: true }), LOOKUP).uncertain, true);
    assert.equal(normalizeMT5Error(new ExecutionProviderError('timeout', 'x'), LOOKUP).uncertain, false);
    for (const category of AMBIGUOUS) {
      assert.equal(normalizeMT5Error(new ExecutionProviderError(category, 'x', { uncertain: false }), SUBMISSION).uncertain, true, category);
    }
    // Definite categories are not widened.
    assert.equal(normalizeMT5Error(new ExecutionProviderError('invalid_volume', 'x'), SUBMISSION).uncertain, false);
  });

  test('a category outside the closed set (only reachable through a cast) becomes unknown', () => {
    const forged = new ExecutionProviderError('bogus_category' as ExecutionFailureCategory, SECRET);
    const err = normalizeMT5Error(forged, LOOKUP);
    assert.equal(err.category, 'unknown');
    assertSafeShape(err, 'forged category');
    assert.equal(normalizeMT5Error(forged, SUBMISSION).uncertain, true);
  });

  test('DisabledMT5Transport errors pass through as unavailable with a fixed message (transport itself untouched)', async () => {
    const upstream = await new DisabledMT5Transport().account().then(() => null, (e: unknown) => e);
    assert.ok(upstream instanceof ExecutionProviderError);
    assert.equal(upstream.message, 'MT5 transport is not configured; no broker communication was attempted');
    const err = normalizeMT5Error(upstream, 'account lookup');
    assert.equal(err.category, 'unavailable');
    assert.equal(err.uncertain, false);
    assert.equal(err.message, 'MT5 provider is unavailable');
    assertSafeShape(err, 'disabled transport');
  });
});

describe('Gate 10 — nothing provider-controlled survives normalization', () => {
  test('raw cause, stack, headers, request, config, response and enumerable props do not survive', () => {
    for (const operation of [LOOKUP, SUBMISSION, 'health check', 'account lookup']) {
      for (const message of ['bad login', 'request timeout', 'socket closed', 'invalid symbol', 'weird', `password=${SECRET}`]) {
        const upstream = hostileError(message);
        const err = normalizeMT5Error(upstream, operation);
        assertSafeShape(err, `${operation}/${message}`);
        assert.equal(err.stack?.includes('bridge.request'), false, 'upstream stack frames do not survive');
        for (const key of ['headers', 'request', 'response', 'config', 'login', 'code']) assert.equal(key in err, false, key);
      }
    }
  });

  test('realistic secret shapes in provider messages never survive', () => {
    const messages = [
      `Authorization: Bearer ${TOKEN}`,
      `login=${LOGIN} password=${SECRET} server=Broker-Demo`,
      `{"password":"${SECRET}","token":"${TOKEN}"}`,
      `mt5://${LOGIN}:${SECRET}@terminal.invalid:443/timeout`,
      `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----`,
    ];
    for (const message of messages) {
      for (const operation of [LOOKUP, SUBMISSION]) assertSafeShape(normalizeMT5Error(hostileError(message), operation), message.slice(0, 20));
    }
  });

  test('very long provider messages: bounded classification, fixed short output, no retention', () => {
    const huge = `request timeout ${'x'.repeat(1_000_000)} ${SECRET}`;
    const err = normalizeMT5Error(transportError(huge), LOOKUP);
    assert.equal(err.category, 'timeout');
    assertSafeShape(err, 'huge');
    // A keyword beyond the classification window is not consulted: fail closed.
    const late = `${'x'.repeat(5_000)} bad login`;
    assert.equal(normalizeMT5Error(transportError(late), LOOKUP).category, 'unknown');
    const lateSubmission = normalizeMT5Error(transportError(late), SUBMISSION);
    assert.equal(lateSubmission.category, 'uncertain');
    assert.equal(lateSubmission.uncertain, true);
  });

  test('newline, ANSI and log-injection content never survives', () => {
    const injected = `\x1b[31mlogin failed\x1b[0m\r\n[FAKE-AUDIT] user=admin action=approve password=${SECRET}\n\x00\x07`;
    const err = normalizeMT5Error(transportError(injected), LOOKUP);
    assert.equal(err.category, 'authentication');
    assertSafeShape(err, 'injected');
    const everything = inspect(err, { showHidden: true, depth: 20 });
    for (const needle of ['FAKE-AUDIT', 'password=', '\x1b', '\x00', '\x07', 'user=admin']) assert.equal(everything.includes(needle), false, needle);
  });

  test('non-Error thrown values normalize safely and are never retained', () => {
    const throwingProxy = new Proxy({}, { get() { throw new Error(`trap ${SECRET}`); }, has() { throw new Error('trap'); } });
    const throwingGetter = Object.defineProperty({}, 'message', { get() { throw new Error(SECRET); }, enumerable: true });
    const throwingCode = { message: 'timeout', code: { toString() { throw new Error(SECRET); } } };
    const values: unknown[] = [
      undefined, null, 42, true, 'timeout', `login ${SECRET}`, Symbol('sym'), 10n, [SECRET], () => SECRET,
      { message: 'timeout', code: 'ETIMEDOUT' }, { message: SECRET, password: SECRET }, { code: 10017 },
      { message: { nested: 'timeout' } }, { responseLost: true, message: `login ${SECRET}` },
      throwingProxy, throwingGetter, throwingCode, new Date(0), new Map([[SECRET, SECRET]]),
    ];
    for (const value of values) {
      for (const operation of [LOOKUP, SUBMISSION]) {
        const err = normalizeMT5Error(value, operation);
        assertSafeShape(err, `${operation}/${typeof value}`);
        if (operation === SUBMISSION) assert.notEqual(err.category, 'unknown');
        if (operation === SUBMISSION && AMBIGUOUS.includes(err.category)) assert.equal(err.uncertain, true);
      }
    }
    // Primitive hints are still honoured on plain objects; strings are not treated as messages.
    assert.equal(normalizeMT5Error({ message: 'timeout', code: 'ETIMEDOUT' }, LOOKUP).category, 'timeout');
    assert.equal(normalizeMT5Error({ responseLost: true, message: 'login' }, LOOKUP).category, 'uncertain');
    assert.equal(normalizeMT5Error('timeout', LOOKUP).category, 'unknown');
    assert.equal(normalizeMT5Error({ message: { nested: 'timeout' } }, LOOKUP).category, 'unknown');
    assert.equal(normalizeMT5Error(throwingProxy, LOOKUP).category, 'unknown');
    // A non-primitive `code` is ignored (its throwing toString is never invoked); the message hint still classifies.
    assert.equal(normalizeMT5Error(throwingCode, LOOKUP).category, 'timeout');
  });
});

describe('Gate 10 — normalizeMT5Order keeps only bounded structured data', () => {
  const row = (patch: Partial<MT5OrderSnapshot> = {}): MT5OrderSnapshot => ({ ticket: '42', symbol: 'XAUUSDm', status: 'filled', volume: 1, filledVolume: 1, averagePrice: 2000, retcode: 10009, message: `done; token=${TOKEN}`, timestampMs: NOW, ...patch });

  test('the broker message is never exposed, in any receipt field', () => {
    const state = normalizeMT5Order(row());
    assert.deepEqual(state, { providerOrderId: '42', status: 'filled', filledQuantity: 1, averagePrice: 2000, raw: { retcode: 10009, timestampMs: NOW } });
    assert.equal('message' in (state.raw ?? {}), false);
    assertNoSentinel(state, 'order state');
  });

  test('mapped status behaviour is preserved; unsupported statuses stay unknown (Gate 9 §18/§21)', () => {
    const expected: Record<string, string> = { requested: 'submitted', placed: 'accepted', accepted: 'accepted', partial: 'partially_filled', filled: 'filled', rejected: 'rejected', cancelled: 'cancelled', canceled: 'cancelled', expired: 'expired' };
    for (const [status, mapped] of Object.entries(expected)) assert.equal(normalizeMT5Order(row({ status })).status, mapped, status);
    // Gate 9 tightened this: an unmappable provider status used to be folded
    // into a definitive `failed` (and case variants were silently lowercased).
    // Both are now an explicitly uncertain state — "we could not read the
    // provider" is never evidence that the broker rejected or failed the order.
    for (const status of ['FILLED', 'vendor_new_state', '', ' Accepted ']) {
      const state = normalizeMT5Order(row({ status }));
      assert.equal(state.status, null, status);
      assert.equal(state.statusUncertain, true, status);
    }
  });

  test('retcode and timestamp are bounded integers or null', () => {
    for (const retcode of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000, 2 ** 53, '10009' as unknown as number]) {
      assert.equal(normalizeMT5Order(row({ retcode })).raw?.retcode, null, String(retcode));
    }
    for (const retcode of [0, 10009, 999_999]) assert.equal(normalizeMT5Order(row({ retcode })).raw?.retcode, retcode);
    assert.equal(normalizeMT5Order(row({ retcode: undefined })).raw?.retcode, null);
    for (const timestampMs of [-1, 1.5, Number.NaN, 10_000_000_000_000, 'now' as unknown as number]) {
      assert.equal(normalizeMT5Order(row({ timestampMs })).raw?.timestampMs, null, String(timestampMs));
    }
    assert.equal(normalizeMT5Order(row({ timestampMs: NOW })).raw?.timestampMs, NOW);
  });

  test('providerOrderId is validated and bounded before it can reach persistence', () => {
    for (const ticket of ['1', '123', 'a'.repeat(128), 'T-1_2.3:4', 'ABC123']) assert.equal(normalizeMT5Order(row({ ticket })).providerOrderId, ticket);
    const invalid: unknown[] = ['', ' ', 'a'.repeat(129), 'bad ticket', 'tick\net', '-lead', '.lead', `x${SECRET}\x1b[0m`, 'ticket;DROP', '{"id":1}', 123, null, undefined, { toString: () => '123' }];
    for (const ticket of invalid) {
      assert.throws(() => normalizeMT5Order(row({ ticket: ticket as string })), (e: unknown) => {
        assert.ok(e instanceof ExecutionProviderError);
        assert.equal(e.category, 'uncertain');
        assert.equal(e.uncertain, true);
        assertSafeShape(e, `ticket ${String(ticket)}`);
        return true;
      }, `ticket ${String(ticket)}`);
    }
  });

  test('provider-level: receipts never carry the broker message and malformed tickets fail closed as uncertain', async () => {
    const t = new MockTransport();
    t.submitResult = { message: `filled; password=${SECRET}`, retcode: 10009 };
    const out = await provider(t).submitOrder(request());
    assert.deepEqual(out.receipt, { retcode: 10009, timestampMs: NOW });
    assertNoSentinel(out, 'submit outcome');

    const malformed = new MockTransport();
    malformed.submitResult = { ticket: `999 ${SECRET}` };
    await assert.rejects(provider(malformed).submitOrder(request()), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'uncertain' && e.uncertain);

    const existing = new MockTransport();
    existing.existing = { ticket: 'x'.repeat(200), clientOrderId: `ve-${'a'.repeat(24)}`, symbol: 'XAUUSDm', status: 'accepted', volume: 0.1, timestampMs: NOW, message: SECRET };
    await assert.rejects(provider(existing).submitOrder(request()), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'uncertain' && e.uncertain);
    assert.equal(existing.submitted.length, 0, 'never resubmits when the existing order cannot be identified');
    await assert.rejects(provider(existing).listOrders(), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'uncertain');
    await assert.rejects(provider(existing).getOrder('x'), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'uncertain');
  });

  test('position tickets are validated the same way; valid positions still normalize', async () => {
    const t = new MockTransport();
    const position = (ticket: string): MT5PositionSnapshot => ({ ticket, symbol: 'XAUUSDm', side: 'buy', volume: 0.1, priceOpen: 2000, stopLoss: 1990, takeProfit: 2020, profit: 1.5 });
    t.positions = async () => [position('555')];
    t.position = async () => position('555');
    assert.deepEqual(await provider(t).listPositions(), [{ providerPositionId: '555', assetClass: 'other', symbol: 'XAUUSD', direction: 'long', quantity: 0.1, averageEntryPrice: 2000, stopLossPrice: 1990, takeProfitPrice: 2020, unrealizedPl: 1.5 }]);
    t.positions = async () => [position(`555 ${SECRET}`)];
    t.position = async () => position('x'.repeat(129));
    await assert.rejects(provider(t).listPositions(), (e: unknown) => { assert.ok(e instanceof ExecutionProviderError); assert.equal(e.category, 'uncertain'); assertSafeShape(e, 'positions'); return true; });
    await assert.rejects(provider(t).getPosition('555'), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'uncertain');
  });
});

describe('Gate 10 — provider health never repeats a transport reason verbatim', () => {
  test('unknown transport reasons collapse to the constant token; detail/extras never appear', async () => {
    const t = new MockTransport();
    t.healthResult = { configured: true, authenticated: true, connected: false, healthy: false, reason: `terminal rejected login ${LOGIN} password=${SECRET}`, detail: { password: SECRET }, token: TOKEN } as MT5TransportHealth;
    const h = await provider(t).health();
    assert.deepEqual(h, { configured: true, authenticated: true, connected: false, available: false, healthy: false, state: 'unavailable', reason: MT5_TRANSPORT_UNHEALTHY_REASON, checkedAt: new Date(NOW).toISOString() });
    assert.equal('detail' in h, false);
    assertNoSentinel(h, 'health');
  });

  test('allowlisted reasons are preserved; a healthy transport carries no reason', async () => {
    const t = new MockTransport();
    t.healthResult = { configured: false, authenticated: false, connected: false, healthy: false, reason: 'mt5_transport_unconfigured' };
    assert.equal((await provider(t).health()).reason, 'mt5_transport_unconfigured');
    t.healthResult = { configured: true, authenticated: true, connected: true, healthy: false, reason: 'mt5_transport_reported_unhealthy' };
    const degraded = await provider(t).health();
    assert.equal(degraded.state, 'degraded'); assert.equal(degraded.reason, MT5_TRANSPORT_UNHEALTHY_REASON);
    t.healthResult = { configured: true, authenticated: true, connected: true, healthy: true, reason: `ignored ${SECRET}` };
    const healthy = await provider(t).health();
    assert.equal(healthy.state, 'healthy'); assert.equal(healthy.reason, undefined);
    assertNoSentinel(healthy, 'healthy');
  });

  test('non-boolean transport flags are treated as false (never truthy strings)', async () => {
    const t = new MockTransport();
    t.healthResult = { configured: 'yes', authenticated: 1, connected: {}, healthy: 'true', reason: 42 } as unknown as MT5TransportHealth;
    const h = await provider(t).health();
    assert.deepEqual([h.configured, h.authenticated, h.connected, h.available, h.healthy, h.state, h.reason], [false, false, false, false, false, 'unavailable', MT5_TRANSPORT_UNHEALTHY_REASON]);
  });

  test('a throwing transport keeps the existing err.category reason and leaks nothing', async () => {
    const t = new MockTransport();
    t.healthError = hostileError(`login rejected ${SECRET}`);
    const h = await provider(t).health();
    assert.equal(h.state, 'unavailable'); assert.equal(h.reason, 'authentication');
    assertNoSentinel(h, 'throwing health');
    await assert.rejects(provider(t).getAccountInfo(), (e: unknown) => { assert.ok(e instanceof ExecutionProviderError); assertSafeShape(e, 'requireAvailable'); return true; });
  });

  test('disabled and live fixed literals are unchanged (positive control)', async () => {
    assert.equal((await provider(new MockTransport(), { enabled: false }).health()).reason, 'mt5_provider_disabled');
    assert.equal((await provider(new MockTransport(), { environment: 'live' }).health()).reason, 'live_execution_prohibited_m8_4');
    const disabled = createMT5ExecutionProvider(new DisabledMT5Transport(), { enabled: false, environment: 'demo', broker: null, server: null, accountRef: null, symbols: new Map(), now: () => NOW });
    assert.equal((await disabled.health()).reason, 'mt5_transport_unconfigured');
  });
});

describe('Gate 10 — account info exposes configured identifiers only', () => {
  test('the broker login never becomes accountRef and provider broker/server strings are not exposed', async () => {
    const t = new MockTransport();
    const account = await provider(t).getAccountInfo();
    assert.deepEqual(account, { accountRef: 'masked-account', broker: 'Example MT5 Broker', server: 'Example-Demo', environment: 'demo', currency: 'USD', balance: 10_000, equity: 10_000, marginFree: 9_000 });
    assertNoSentinel(account, 'account');
  });

  test('without a configured account reference the lookup fails closed before touching the transport', async () => {
    const t = new MockTransport();
    await assert.rejects(provider(t, { accountRef: null }).getAccountInfo(), (e: unknown) => {
      assert.ok(e instanceof ExecutionProviderError); assert.equal(e.category, 'unavailable'); assertSafeShape(e, 'no accountRef'); return true;
    });
    await assert.rejects(provider(t, { server: null }).getAccountInfo(), (e: unknown) => e instanceof ExecutionProviderError && e.category === 'unavailable');
    assert.equal(t.accountCalls, 0);
  });

  test('a missing configured broker label falls back to the configured server, never to the transport', async () => {
    const account = await provider(new MockTransport(), { broker: null }).getAccountInfo();
    assert.equal(account?.broker, 'Example-Demo');
    assertNoSentinel(account, 'account without broker label');
  });

  test('currency and balances are validated; malformed provider values are withheld', async () => {
    const t = new MockTransport();
    t.accountResult = { login: LOGIN, broker: 'x', server: 'y', currency: `U$D ${SECRET}\n`, balance: Number.NaN, equity: '1000' as unknown as number, marginFree: Number.POSITIVE_INFINITY };
    const account = await provider(t).getAccountInfo();
    assert.deepEqual([account?.currency, account?.balance, account?.equity, account?.marginFree], [null, null, null, null]);
    assertNoSentinel(account, 'malformed account');
    t.accountResult = { login: LOGIN, broker: 'x', server: 'y', currency: 'usd' };
    assert.equal((await provider(t).getAccountInfo())?.currency, 'usd');
  });

  test('describe() still exposes configured values only (positive control)', () => {
    const text = JSON.stringify(provider().describe());
    assertNoSentinel(text, 'describe');
    assert.match(text, /"liveExecutionAvailable":false/);
  });
});

describe('Gate 10 — safe provider-health projection for API/persistence consumers', () => {
  const now = () => new Date(NOW);
  test('projects only the closed field set and drops detail / free-text reasons', () => {
    const adapterHealth: ExecutionProviderHealth = { configured: true, authenticated: true, connected: false, available: false, healthy: false, state: 'unavailable', reason: `terminal said password=${SECRET}`, checkedAt: new Date(NOW).toISOString(), detail: { password: SECRET, login: LOGIN } };
    const safe = toSafeProviderHealth(adapterHealth, now);
    assert.deepEqual(safe, { configured: true, authenticated: true, connected: false, available: false, healthy: false, state: 'unavailable', reason: null, checkedAt: new Date(NOW).toISOString() });
    assertNoSentinel(safe, 'projection');
  });
  test('machine-token reasons and the paper/MT5 fixed literals survive; junk states/timestamps are replaced', () => {
    const base: ExecutionProviderHealth = { configured: true, authenticated: true, connected: true, available: true, healthy: true, state: 'healthy', checkedAt: new Date(NOW).toISOString() };
    for (const reason of ['mt5_transport_unconfigured', 'mt5_provider_disabled', 'live_execution_prohibited_m8_4', MT5_TRANSPORT_UNHEALTHY_REASON, 'paper_simulator_not_bound', 'authentication']) {
      assert.equal(toSafeProviderHealth({ ...base, reason }, now).reason, reason);
    }
    for (const reason of ['Login Failed', 'a b', 'x'.repeat(65), 'reason\n', `token=${TOKEN}`, '']) assert.equal(toSafeProviderHealth({ ...base, reason }, now).reason, null, reason);
    const junk = toSafeProviderHealth({ ...base, state: 'exploded' as never, checkedAt: 'not-a-date', configured: 'yes' as never }, now);
    assert.equal(junk.state, 'unavailable'); assert.equal(junk.checkedAt, new Date(NOW).toISOString()); assert.equal(junk.configured, false);
  });
  test('a missing provider is reported with the fixed provider_missing token', () => {
    assert.deepEqual(toSafeProviderHealth(null, now), { configured: false, authenticated: false, connected: false, available: false, healthy: false, state: 'unavailable', reason: PROVIDER_MISSING_REASON, checkedAt: new Date(NOW).toISOString() });
    assert.equal(toSafeProviderHealth(undefined, now).reason, 'provider_missing');
  });
});

describe('Gate 10 — reconciliation snapshot adapter emits fixed messages only', () => {
  test('unhealthy provider, missing provider and listing failures never carry provider text', async () => {
    const unhealthy = new MockTransport();
    unhealthy.healthResult = { configured: true, authenticated: false, connected: false, healthy: false, reason: `login ${LOGIN} password=${SECRET}` };
    const mt5 = provider(unhealthy);
    const snapshots = new ProviderReconciliationSnapshotProvider((id) => (id === 'mt5' ? mt5 : undefined));
    const args = { userId: 'u', executionProfileId: 'p', providerId: 'mt5' };
    await assert.rejects(snapshots.getSnapshot(args), (e: unknown) => {
      assert.ok(e instanceof ExecutionProviderError); assert.equal(e.category, 'unavailable'); assert.equal(e.message, 'Execution provider is not available'); assertSafeShape(e, 'unhealthy'); return true;
    });
    await assert.rejects(snapshots.getSnapshot({ ...args, providerId: `ghost ${SECRET}` }), (e: unknown) => {
      assert.ok(e instanceof ExecutionProviderError); assert.equal(e.message, 'Execution provider is not registered'); assertSafeShape(e, 'missing'); return true;
    });
    const listingFails = provider(new MockTransport());
    const broken = { ...listingFails, listOrders: async () => { throw hostileError(`listing exploded ${SECRET}`); } };
    const brokenSnapshots = new ProviderReconciliationSnapshotProvider(() => broken);
    await assert.rejects(brokenSnapshots.getSnapshot(args), (e: unknown) => {
      assert.ok(e instanceof ExecutionProviderError); assert.equal(e.message, 'Execution provider listing failed'); assertSafeShape(e, 'listing'); return true;
    });
    const nullThrower = { ...listingFails, listOrders: async () => { throw null; } };
    await assert.rejects(new ProviderReconciliationSnapshotProvider(() => nullThrower).getSnapshot(args), (e: unknown) => e instanceof ExecutionProviderError && e.message === 'Execution provider listing failed');
  });

  test('a healthy MT5 provider snapshot carries structured receipts without broker messages', async () => {
    const t = new MockTransport();
    t.existing = { ticket: '77', clientOrderId: `ve-${'a'.repeat(24)}`, symbol: 'XAUUSDm', status: 'filled', volume: 0.1, filledVolume: 0.1, averagePrice: 2000, retcode: 10009, message: `done password=${SECRET}`, timestampMs: NOW };
    const snapshot = await new ProviderReconciliationSnapshotProvider(() => provider(t)).getSnapshot({ userId: 'u', executionProfileId: 'p', providerId: 'mt5' });
    assert.equal(snapshot.orders.length, 1);
    assert.deepEqual(snapshot.orders[0]?.raw, { retcode: 10009, timestampMs: NOW });
    assertNoSentinel(snapshot, 'snapshot');
  });
});
