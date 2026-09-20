import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSET_CLASSES,
  BRIDGE_MARKET_CLOSED_CONDITION,
  BRIDGE_NORMALIZED_STATUSES,
  CLIENT_ORDER_ID_PREFIX,
  MT5_BRIDGE_DEFAULT_CLOCK_SKEW_MS,
  MT5_BRIDGE_DEFAULT_MAX_QUOTE_AGE_MS,
  MT5_BRIDGE_PROTOCOL_ID,
  MT5_BRIDGE_PROTOCOL_VERSION,
  ORDER_STATUSES,
  PROVIDER_ORDER_STATUS_VOCABULARY,
  RECONCILIATION_SNAPSHOT_ORDER_STATUSES,
  TRANSPORT_READINESS_CONDITIONS,
  bridgeAccountBindingSchema,
  bridgeAuditEventSchema,
  bridgeCancelOrderSchema,
  bridgeClosePositionSchema,
  bridgeHandshakeRequestSchema,
  bridgeHandshakeResultSchema,
  bridgeInstrumentContractSchema,
  bridgeModifyOrderSchema,
  bridgeMutationOutcomeSchema,
  bridgeQuoteSchema,
  bridgeReadinessDecisionSchema,
  bridgeReconciliationLookupSchema,
  bridgeReconciliationResultSchema,
  bridgeReservationSchema,
  bridgeSubmitOrderSchema,
  bridgeTicketMappingSchema,
  bridgeTransportHealthSchema,
  containsForbiddenAuditKey,
  deriveRetryClientOrderId,
  evaluateBridgeHandshake,
  evaluateProtocolCompatibility,
  evaluateQuoteFreshness,
  isBridgeEnvironmentAccepted,
  isExplicitTrue,
  isPriceCompatibleWithInstrument,
  isProtocolVersionAccepted,
  isVeltrixClientOrderId,
  normalizeProviderOrderStatus,
  parseBridgeMessage,
  parseProtocolVersion,
  readBridgeHealthFlags,
  resolveBridgeReadiness,
  validateBridgeAccountBinding,
  validateBridgeClientOrderId,
  validateInstrumentContract,
  validateVolumeAgainstInstrument,
  type BridgeInstrumentContract,
} from '../src/index.js';

/**
 * M10 Gate 9 — `veltrixeye.mt5-bridge` protocol contract tests.
 *
 * Pure, offline and deterministic: no network, no provider, no database and no
 * credentials. These pin the CONTRACT (identity/version, strictness, bounded
 * values, closed vocabularies and the fail-closed rules); the core suite then
 * exercises the same rules through the real execution paths.
 */

const NOW = 1_700_000_000_000;
const HEX24 = 'a'.repeat(24);
const HEX20 = 'b'.repeat(20);
const IDEMPOTENCY = 'c'.repeat(64);
const clientOrderId = (hex = HEX24) => `${CLIENT_ORDER_ID_PREFIX}${hex}`;

const binding = (patch: Record<string, unknown> = {}) => ({
  protocolId: MT5_BRIDGE_PROTOCOL_ID,
  protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION,
  accountRef: 'demo-account-1',
  broker: 'example-broker',
  server: 'example-demo-01',
  environment: 'demo',
  ...patch,
});

const quote = (patch: Record<string, unknown> = {}) => ({
  symbol: 'XAUUSDm',
  bid: 1999.9,
  ask: 2000.1,
  timestampMs: NOW,
  ...patch,
});

const instrument = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  assetClass: 'commodity',
  canonicalSymbol: 'XAUUSD',
  providerSymbol: 'XAUUSDm',
  contractSize: 100,
  tickSize: 0.01,
  priceDigits: 2,
  minVolume: 0.01,
  maxVolume: 10,
  volumeStep: 0.01,
  orderTypes: ['market', 'limit'],
  tradingStatus: 'open',
  quote: quote(),
  ...patch,
});

const submitMessage = (patch: Record<string, unknown> = {}) => ({
  protocolId: MT5_BRIDGE_PROTOCOL_ID,
  protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION,
  accountBinding: binding(),
  idempotencyKey: IDEMPOTENCY,
  clientOrderId: clientOrderId(),
  symbol: 'XAUUSD',
  side: 'buy',
  orderType: 'market',
  volume: 0.1,
  price: null,
  stopLoss: 1990,
  takeProfit: 2020,
  ...patch,
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §2/§34 — protocol identity and version compatibility', () => {
  test('the pinned identity/version are explicit constants', () => {
    assert.equal(MT5_BRIDGE_PROTOCOL_ID, 'veltrixeye.mt5-bridge');
    assert.equal(MT5_BRIDGE_PROTOCOL_VERSION, '1.0.0');
  });

  test('the exact supported contract is accepted', () => {
    assert.deepEqual(parseProtocolVersion('1.0.0'), { major: 1, minor: 0, patch: 0 });
    assert.equal(evaluateProtocolCompatibility('1.0.0').decision, 'compatible');
    assert.equal(isProtocolVersionAccepted('1.0.0'), true);
  });

  test('PATCH differences never change contract semantics', () => {
    for (const version of ['1.0.1', '1.0.42', '1.0.999999']) {
      assert.equal(evaluateProtocolCompatibility(version).decision, 'compatible', version);
    }
  });

  test('a higher MAJOR is rejected and never reinterpreted', () => {
    for (const version of ['2.0.0', '99.0.0', '10.1.0']) {
      const decision = evaluateProtocolCompatibility(version);
      assert.equal(decision.decision, 'rejected_higher_major', version);
      assert.equal(decision.accepted, false, version);
      assert.equal(decision.higherMajor, true, version);
    }
  });

  test('a lower MAJOR is rejected too — it is not assumed to be a subset', () => {
    assert.equal(evaluateProtocolCompatibility('0.9.9').decision, 'rejected_lower_major');
    assert.equal(isProtocolVersionAccepted('0.9.9'), false);
  });

  test('MAJOR, MINOR and PATCH compatibility are distinguished', () => {
    assert.equal(evaluateProtocolCompatibility('1.1.0').decision, 'rejected_minor_ahead');
    assert.equal(evaluateProtocolCompatibility('0.9.0').decision, 'rejected_lower_major');
    assert.equal(evaluateProtocolCompatibility('1.0.7').decision, 'compatible');
  });

  test('malformed version tokens are invalid, never coerced', () => {
    for (const raw of ['', '1', '1.0', '1.0.0.0', '01.0.0', '1.0.0-beta', 'v1.0.0', '1.0.x', ' 1.0.0', '1.0.0 ', '1.-1.0', null, undefined, 1.0, {}, [], true, '9007199254740993.0.0']) {
      assert.equal(parseProtocolVersion(raw), null, JSON.stringify(raw));
      assert.equal(evaluateProtocolCompatibility(raw).decision, 'rejected_invalid_version', JSON.stringify(raw));
      assert.equal(isProtocolVersionAccepted(raw), false, JSON.stringify(raw));
    }
  });

  test('identity and version are explicit in the message — never defaulted', () => {
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ protocolVersion: '1.0.0' })).success, true);
    const { protocolId: _protocolId, ...withoutIdentity } = submitMessage();
    assert.equal(bridgeSubmitOrderSchema.safeParse(withoutIdentity).success, false);
    const { protocolVersion: _protocolVersion, ...withoutVersion } = submitMessage();
    assert.equal(bridgeSubmitOrderSchema.safeParse(withoutVersion).success, false);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §3 — strict contract validation', () => {
  test('unknown fields are rejected on every strict protocol message', () => {
    const cases: Array<[string, { safeParse: (v: unknown) => { success: boolean } }, unknown]> = [
      ['submit', bridgeSubmitOrderSchema, submitMessage({ vendorHint: 'fill me' })],
      ['cancel', bridgeCancelOrderSchema, { protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: '1.0.0', accountBinding: binding(), idempotencyKey: IDEMPOTENCY, clientOrderId: clientOrderId(), providerTicket: 'T-1', extra: 1 }],
      ['modify', bridgeModifyOrderSchema, { protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: '1.0.0', accountBinding: binding(), idempotencyKey: IDEMPOTENCY, clientOrderId: clientOrderId(), providerTicket: 'T-1', symbol: 'XAUUSD', stopLoss: 1990, takeProfit: null, retcode: 10009 }],
      ['close', bridgeClosePositionSchema, { protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: '1.0.0', accountBinding: binding(), idempotencyKey: IDEMPOTENCY, providerTicket: 'T-1', clientOrderId: null, force: true }],
      ['handshake', bridgeHandshakeRequestSchema, { protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: '1.0.0', requestedCapabilities: [], accountBinding: binding(), attestation: null, transportReadiness: null, autoTrade: true }],
      ['health', bridgeTransportHealthSchema, { configured: true, authenticated: true, connected: true, available: true, healthy: true, state: 'ready', checkedAt: '2026-09-20T00:00:00.000Z', providerDetail: { margin: 'yes' } }],
      ['quote', bridgeQuoteSchema, quote({ providerNote: 'trade now' })],
      ['instrument', bridgeInstrumentContractSchema, instrument({ brokerSays: 'ignore steps' })],
      ['binding', bridgeAccountBindingSchema, binding({ login: '12345' })],
    ];
    for (const [name, schema, message] of cases) {
      assert.equal(schema.safeParse(message).success, false, `${name} must reject unknown fields`);
      assert.equal(schema.safeParse(undefined).success, false, `${name} must reject a missing message`);
      assert.equal(schema.safeParse(null).success, false, `${name} must reject null`);
    }
  });

  test('bounded string lengths are enforced', () => {
    assert.equal(bridgeAccountBindingSchema.safeParse(binding({ accountRef: 'x'.repeat(129) })).success, false);
    assert.equal(bridgeAccountBindingSchema.safeParse(binding({ accountRef: '' })).success, false);
    assert.equal(bridgeAccountBindingSchema.safeParse(binding({ accountRef: 'spaces not allowed' })).success, false);
    assert.equal(bridgeAccountBindingSchema.safeParse(binding({ accountRef: 'newline\nx' })).success, false);
    assert.equal(bridgeAccountBindingSchema.safeParse(binding({ accountRef: 'emoji😀' })).success, false);
    assert.equal(bridgeQuoteSchema.safeParse(quote({ symbol: 'X'.repeat(33) })).success, false);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ idempotencyKey: 'd'.repeat(63) })).success, false);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ idempotencyKey: 'D'.repeat(64) })).success, false);
  });

  test('bounded numeric values are enforced', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, 1e13]) {
      assert.equal(bridgeQuoteSchema.safeParse(quote({ bid: bad })).success, false, String(bad));
      assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ volume: bad })).success, false, String(bad));
    }
    for (const bad of [-1, 0.5, Number.NaN, 1e15, '2' as unknown as number]) {
      assert.equal(bridgeInstrumentContractSchema.safeParse(instrument({ priceDigits: bad })).success, false, String(bad));
    }
    // Epoch timestamps are bounded integers: a float, a string or a huge value is invalid.
    for (const bad of [0, -1, 1.5, Number.NaN, 1e16, '1700000000000' as unknown as number]) {
      assert.equal(bridgeQuoteSchema.safeParse(quote({ timestampMs: bad })).success, false, String(bad));
    }
  });

  test('closed vocabularies reject invalid enum values', () => {
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ side: 'BUY' })).success, false);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ orderType: 'stop_limit' })).success, false);
    assert.equal(bridgeHandshakeRequestSchema.safeParse({ protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: '1.0.0', requestedCapabilities: ['margin_call'], accountBinding: binding() }).success, false);
    assert.equal(bridgeHandshakeRequestSchema.safeParse({ protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: '1.0.0', requestedCapabilities: ['LIVE_EXECUTE'], accountBinding: binding() }).success, false);
    assert.equal(bridgeTransportHealthSchema.safeParse({ configured: true, authenticated: true, connected: true, available: true, healthy: true, state: 'probably', checkedAt: '2026-09-20T00:00:00.000Z' }).success, false);
  });

  test('invalid timestamps are rejected', () => {
    const healthy = { configured: true, authenticated: true, connected: true, available: true, healthy: true, state: 'ready' };
    assert.equal(bridgeTransportHealthSchema.safeParse({ ...healthy, checkedAt: 'yesterday' }).success, false);
    assert.equal(bridgeTransportHealthSchema.safeParse({ ...healthy, checkedAt: NOW }).success, false);
    assert.equal(bridgeTransportHealthSchema.safeParse(healthy).success, false, 'checkedAt is required');
  });

  test('a provider instrument row cannot smuggle fields into the contract', () => {
    const row = instrument({ leverage: 500, maxLeverage: 'unlimited' });
    assert.equal(bridgeInstrumentContractSchema.safeParse(row).success, false);
    // The pure validator is strict too, so a vendor row with extra keys cannot
    // reach the sizing path at all — it is not silently narrowed and accepted.
    const decision = validateInstrumentContract(row);
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'instrument_malformed');
    assert.equal(decision.contract, null);
  });

  test('parseBridgeMessage fails with a closed code and never echoes the payload', () => {
    assert.throws(
      () => parseBridgeMessage(bridgeQuoteSchema, { symbol: 'X', bid: 1, ask: 2, timestampMs: NOW, secret: 'hunter2' }, 'quote_malformed'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as { code?: string }).code, 'quote_malformed');
        assert.equal(String(err).includes('hunter2'), false);
        assert.equal(String(err).includes('secret'), false);
        assert.equal((err as { outcomeUnknown?: boolean }).outcomeUnknown, false, 'a pre-call rejection is not an unknown outcome');
        return true;
      },
    );
    assert.equal(parseBridgeMessage(bridgeQuoteSchema, quote()).bid, 1999.9);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §11 (B2) — durable client order identity', () => {
  test('the initial and retry forms are the accepted identities', () => {
    assert.deepEqual(validateBridgeClientOrderId(clientOrderId()), { ok: true, code: 'ok', retry: null, hash: HEX24 });
    assert.deepEqual(validateBridgeClientOrderId(`${CLIENT_ORDER_ID_PREFIX}${HEX20}-r7`), { ok: true, code: 'ok', retry: 7, hash: HEX20 });
    assert.equal(isVeltrixClientOrderId(`${CLIENT_ORDER_ID_PREFIX}${HEX20}-r999999999`), true);
    assert.equal(validateBridgeClientOrderId(`ve-${'0123456789abcdef012345'}`).ok, false, 'a 22-hex core is not an accepted form');
  });

  test('malformed identities are refused with deterministic codes', () => {
    const cases: Array<[unknown, string]> = [
      [undefined, 'client_order_id_missing'],
      [null, 'client_order_id_missing'],
      [12345, 'client_order_id_not_a_string'],
      [{ toString: () => clientOrderId() }, 'client_order_id_not_a_string'],
      ['', 'client_order_id_prefix_invalid'],
      ['ve-', 'client_order_id_hash_invalid'],
      [`ve-${'a'.repeat(23)}`, 'client_order_id_hash_invalid'],
      [`ve-${'a'.repeat(25)}`, 'client_order_id_hash_invalid'],
      [`ve-${'A'.repeat(24)}`, 'client_order_id_hash_invalid'],
      [`ve-${'g'.repeat(24)}`, 'client_order_id_hash_invalid'],
      ['veltrix-order-1', 'client_order_id_prefix_invalid'],
      ['123456', 'client_order_id_prefix_invalid'],
      ['T-99112', 'client_order_id_prefix_invalid'],
      [`ve-${HEX20}-r0`, 'client_order_id_retry_form_invalid'],
      [`ve-${HEX20}-r01`, 'client_order_id_retry_form_invalid'],
      // `-R1` is not our retry marker at all, so it reads as "not ours".
      [`ve-${HEX20}-R1`, 'client_order_id_hash_invalid'],
      // A retry marker with the wrong hash length is still a retry-shaped id.
      [`ve-${'a'.repeat(24)}-r1`, 'client_order_id_retry_form_invalid'],
      [`ve-${HEX20}-r1000000000`, 'client_order_id_retry_form_invalid'],
      [`ve-${'a'.repeat(70)}`, 'client_order_id_too_long'],
    ];
    for (const [raw, code] of cases) {
      assert.equal(validateBridgeClientOrderId(raw).code, code, JSON.stringify(raw));
      assert.equal(validateBridgeClientOrderId(raw).ok, false, JSON.stringify(raw));
      assert.equal(isVeltrixClientOrderId(raw), false, JSON.stringify(raw));
    }
  });

  test('the schema and the validator agree', () => {
    for (const raw of [clientOrderId(), `${CLIENT_ORDER_ID_PREFIX}${HEX20}-r3`, `ve-${'a'.repeat(24)}x`, 've-XYZ', '', undefined]) {
      assert.equal(
        bridgeSubmitOrderSchema.safeParse(submitMessage({ clientOrderId: raw })).success,
        validateBridgeClientOrderId(raw).ok,
        JSON.stringify(raw),
      );
    }
  });

  test('retry derivation keeps the identity lineage and refuses non-ids', () => {
    // A retry reuses the FIRST 20 hex of the base identity, so the lineage from
    // the original submission to its retry stays derivable and non-enumerable.
    assert.equal(deriveRetryClientOrderId(clientOrderId(), 1), `${CLIENT_ORDER_ID_PREFIX}${'a'.repeat(20)}-r1`);
    assert.equal(deriveRetryClientOrderId(clientOrderId(), 12).endsWith('-r12'), true);
    assert.equal(deriveRetryClientOrderId(`${CLIENT_ORDER_ID_PREFIX}${HEX20}-r4`, 5), `${CLIENT_ORDER_ID_PREFIX}${HEX20}-r5`);
    for (const retry of [0, -1, 1.5, Number.NaN, 1_000_000_000]) {
      assert.throws(() => deriveRetryClientOrderId(clientOrderId(), retry), /retry number/, String(retry));
    }
    assert.throws(() => deriveRetryClientOrderId('vendor-ticket', 1), /durable clientOrderId/);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §4 — account and environment binding', () => {
  test('only the demo environment is accepted by the bridge protocol', () => {
    assert.equal(isBridgeEnvironmentAccepted('demo'), true);
    assert.equal(isBridgeEnvironmentAccepted('live'), false);
    assert.equal(isBridgeEnvironmentAccepted('paper'), false);
    assert.equal(isBridgeEnvironmentAccepted('DEMO'), false);
    assert.equal(isBridgeEnvironmentAccepted(undefined), false);
  });

  test('a live account is refused even when the transport is otherwise correct', () => {
    assert.deepEqual(validateBridgeAccountBinding(binding({ environment: 'live' }), { accountRef: 'demo-account-1' }), {
      ok: false,
      code: 'live_environment_prohibited',
    });
  });

  test('account/environment mismatches fail closed with an explicit code', () => {
    assert.equal(validateBridgeAccountBinding(binding(), { accountRef: 'other-account' }).code, 'account_identity_mismatch');
    assert.equal(validateBridgeAccountBinding(binding({ server: 'evil' }), { accountRef: 'demo-account-1', server: 'example-demo-01' }).code, 'server_identity_mismatch');
    assert.equal(validateBridgeAccountBinding(binding({ broker: 'evil' }), { accountRef: 'demo-account-1', broker: 'example-broker' }).code, 'broker_identity_mismatch');
    assert.equal(validateBridgeAccountBinding(binding({ protocolVersion: '2.0.0' }), { accountRef: 'demo-account-1' }).code, 'protocol_version_unsupported');
    assert.equal(validateBridgeAccountBinding({ unexpected: true }, { accountRef: 'demo-account-1' }).code, 'binding_malformed');
    assert.equal(validateBridgeAccountBinding(binding(), { accountRef: 'demo-account-1', broker: 'example-broker', server: 'example-demo-01' }).ok, true);
  });

  test('the binding carries no credential field', () => {
    for (const key of ['password', 'login', 'token', 'secret']) {
      assert.equal(bridgeAccountBindingSchema.safeParse(binding({ [key]: 'x' })).success, false, key);
    }
    assert.deepEqual(Object.keys(bridgeAccountBindingSchema.parse(binding())), [
      'protocolId', 'protocolVersion', 'accountRef', 'broker', 'server', 'environment',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §7/§26 (B5, R7.4.4) — strict readiness semantics', () => {
  const readyRecord = () => ({
    configured: true, authenticated: true, connected: true, available: true, healthy: true,
    state: 'ready', checkedAt: '2026-09-20T00:00:00.000Z',
  });

  test('only an explicit `true` for every declared condition is ready', () => {
    const ready = readyRecord();
    assert.equal(resolveBridgeReadiness(ready).ready, true);
    assert.equal(resolveBridgeReadiness(ready).code, 'ready');
    assert.deepEqual(resolveBridgeReadiness(ready).satisfied, [...TRANSPORT_READINESS_CONDITIONS]);
    for (const condition of TRANSPORT_READINESS_CONDITIONS) {
      assert.equal(resolveBridgeReadiness({ ...ready, [condition]: false }).ready, false, `false ${condition}`);
      assert.equal(resolveBridgeReadiness({ ...ready, [condition]: 'true' }).code, 'health_malformed', `string ${condition}`);
      assert.equal(resolveBridgeReadiness({ ...ready, [condition]: 1 }).code, 'health_malformed', `number ${condition}`);
      assert.equal(resolveBridgeReadiness({ ...ready, [condition]: {} }).code, 'health_malformed', `object ${condition}`);
      const missing = { ...ready } as Record<string, unknown>;
      delete missing[condition];
      assert.equal(resolveBridgeReadiness(missing).code, 'health_malformed', `missing ${condition}`);
    }
  });

  test('readiness flags never depend on an adjacent truthy field', () => {
    const partial = { configured: 'yes', authenticated: true, connected: true, available: true, healthy: true, state: 'ready', checkedAt: '2026-09-20T00:00:00.000Z' };
    assert.equal(readBridgeHealthFlags(partial).configured, false);
    assert.equal(resolveBridgeReadiness(partial).code, 'health_malformed');
  });

  test('missing, non-object and uncertain health all refuse', () => {
    const ready = readyRecord();
    assert.equal(resolveBridgeReadiness(undefined).code, 'health_missing');
    assert.equal(resolveBridgeReadiness(null).code, 'health_missing');
    assert.equal(resolveBridgeReadiness('connected').code, 'health_not_an_object');
    assert.equal(resolveBridgeReadiness(42).code, 'health_not_an_object');
    assert.equal(resolveBridgeReadiness([]).code, 'health_not_an_object');
    assert.equal(resolveBridgeReadiness({ ...ready, state: 'uncertain' }).code, 'state_uncertain');
    assert.equal(resolveBridgeReadiness({ ...ready, state: 'unknown' }).code, 'state_uncertain');
    for (const health of [undefined, null, 'connected', 42, [], { ...ready, state: 'uncertain' }]) {
      assert.equal(resolveBridgeReadiness(health).ready, false, JSON.stringify(health));
    }
  });

  test('a transport cannot assert availability it has not established', () => {
    const lying = { configured: true, authenticated: true, connected: false, available: true, healthy: true, state: 'ready', checkedAt: '2026-09-20T00:00:00.000Z' };
    assert.equal(resolveBridgeReadiness(lying).code, 'not_connected');
    assert.equal(readBridgeHealthFlags(lying).connected, false);
  });

  test('isExplicitTrue is the single boolean rule', () => {
    for (const truthy of [1, 'yes', 'false', {}, [], () => true]) {
      assert.equal(isExplicitTrue(truthy as unknown), false);
    }
    assert.equal(isExplicitTrue(true), true);
    assert.equal(isExplicitTrue(false), false);
    assert.equal(isExplicitTrue(0), false);
  });

  test('the readiness decision is itself a strict, self-consistent contract', () => {
    assert.equal(bridgeReadinessDecisionSchema.safeParse({ ready: true, code: 'ready', satisfied: ['healthy'], evaluatedAt: '2026-09-20T00:00:00.000Z' }).success, true);
    assert.equal(bridgeReadinessDecisionSchema.safeParse({ ready: true, code: 'not_healthy', satisfied: [], evaluatedAt: '2026-09-20T00:00:00.000Z' }).success, false);
    assert.equal(bridgeReadinessDecisionSchema.safeParse({ ready: false, code: 'ready', satisfied: [], evaluatedAt: '2026-09-20T00:00:00.000Z' }).success, false);
    assert.equal(bridgeReadinessDecisionSchema.safeParse({ ready: false, code: 'whatever', satisfied: [], evaluatedAt: '2026-09-20T00:00:00.000Z' }).success, false);
    assert.equal(bridgeReadinessDecisionSchema.safeParse({ ready: true, code: 'ready', satisfied: ['not_a_condition'], evaluatedAt: '2026-09-20T00:00:00.000Z' }).success, false);
  });

  test('a narrower profile cannot be satisfied by a record that contradicts itself', () => {
    // §7: availability is not a label. A record judged on `available + healthy`
    // (reconciliation's profile) must still be refused when it admits it is not
    // connected or not authenticated — otherwise a derived flag could be
    // asserted while its precondition is explicitly false.
    const notConnected = { configured: true, authenticated: true, connected: false, available: true, healthy: true };
    assert.equal(resolveBridgeReadiness(notConnected, ['available', 'healthy']).ready, false);
    assert.equal(resolveBridgeReadiness(notConnected, ['available', 'healthy']).code, 'not_connected');
    const notAuthenticated = { configured: true, authenticated: false, connected: true, available: true, healthy: true };
    assert.equal(resolveBridgeReadiness(notAuthenticated, ['available', 'healthy']).code, 'not_authenticated');
    assert.equal(resolveBridgeReadiness({ configured: false, healthy: true }, ['healthy']).code, 'not_configured');
    // Every produced code must be inside the decision schema's closed vocabulary.
    for (const record of [notConnected, notAuthenticated, { configured: false, healthy: true }, { healthy: true, available: false, configured: true }]) {
      const decision = resolveBridgeReadiness(record, ['healthy']);
      assert.equal(bridgeReadinessDecisionSchema.safeParse(decision).success, true, JSON.stringify(decision));
    }
    // An UNSTATED dependency is not an assertion of `false`.
    assert.equal(resolveBridgeReadiness({ available: true, healthy: true }, ['available', 'healthy']).ready, true);
    assert.equal(resolveBridgeReadiness({ healthy: true, state: 'ready' }, ['healthy']).ready, true);
  });

  test('the resolver honors the conditions a narrower record declares', () => {
    const gateHealth = { healthy: true };
    assert.equal(resolveBridgeReadiness(gateHealth, ['healthy']).ready, true);
    assert.equal(resolveBridgeReadiness(gateHealth).code, 'health_malformed', 'the full profile still requires every condition');
    assert.equal(resolveBridgeReadiness({ healthy: 'yes' }, ['healthy']).code, 'health_malformed');
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §8 (B6) — two-sided quote freshness', () => {
  test('the default tolerances are the protocol values', () => {
    assert.equal(MT5_BRIDGE_DEFAULT_CLOCK_SKEW_MS, 5000);
    assert.equal(MT5_BRIDGE_DEFAULT_MAX_QUOTE_AGE_MS, 15000);
  });

  test('a fresh quote passes and its age is reported', () => {
    const decision = evaluateQuoteFreshness({ quote: quote(), nowMs: NOW + 1000, maxAgeMs: 15000 });
    assert.equal(decision.fresh, true);
    assert.equal(decision.code, 'fresh');
    assert.equal(decision.ageMs, 1000);
  });

  test('stale quotes fail', () => {
    assert.equal(evaluateQuoteFreshness({ quote: quote(), nowMs: NOW + 15001, maxAgeMs: 15000 }).code, 'quote_stale');
    assert.equal(evaluateQuoteFreshness({ quote: quote({ timestampMs: NOW - 15_001 }), nowMs: NOW }).code, 'quote_stale');
    assert.equal(evaluateQuoteFreshness({ quote: quote(), nowMs: NOW + 15_000, maxAgeMs: 15000 }).fresh, true, 'exactly at the bound is still fresh');
    assert.equal(evaluateQuoteFreshness({ quote: quote(), nowMs: NOW + 15001, maxAgeMs: 15000 }).fresh, false);
  });

  test('future quotes inside the skew window are tolerated and never count as negative age', () => {
    const decision = evaluateQuoteFreshness({ quote: quote({ timestampMs: NOW + 4_999 }), nowMs: NOW });
    assert.equal(decision.fresh, true);
    assert.equal(decision.ageMs, 0);
    assert.equal(decision.forwardSkewMs, 4999);
    assert.equal(evaluateQuoteFreshness({ quote: quote({ timestampMs: NOW + 5_000 }), nowMs: NOW }).fresh, true, 'the tolerance is inclusive');
  });

  test('future quotes beyond the tolerance are invalid, not merely fresh', () => {
    for (const drift of [5001, 60_000, 86_400_000]) {
      const decision = evaluateQuoteFreshness({ quote: quote({ timestampMs: NOW + drift }), nowMs: NOW });
      assert.equal(decision.fresh, false, String(drift));
      assert.equal(decision.code, 'quote_future_beyond_clock_skew', String(drift));
      assert.equal(decision.forwardSkewMs, drift, String(drift));
    }
    // A widened max age must not launder a future timestamp into freshness.
    assert.equal(evaluateQuoteFreshness({ quote: quote({ timestampMs: NOW + 10_000 }), nowMs: NOW, maxAgeMs: Number.MAX_SAFE_INTEGER }).code, 'quote_future_beyond_clock_skew');
  });

  test('malformed quotes and clocks are refused rather than guessed', () => {
    assert.equal(evaluateQuoteFreshness({ quote: undefined, nowMs: NOW }).code, 'quote_missing');
    assert.equal(evaluateQuoteFreshness({ quote: null, nowMs: NOW }).code, 'quote_missing');
    assert.equal(evaluateQuoteFreshness({ quote: 'last tick 1999.9', nowMs: NOW }).code, 'quote_malformed');
    assert.equal(evaluateQuoteFreshness({ quote: { symbol: 'X', bid: '1999.9', ask: 2000, timestampMs: NOW }, nowMs: NOW }).code, 'quote_malformed');
    assert.equal(evaluateQuoteFreshness({ quote: quote({ bid: -1 }), nowMs: NOW }).code, 'quote_malformed');
    assert.equal(evaluateQuoteFreshness({ quote: quote({ bid: Number.NaN }), nowMs: NOW }).code, 'quote_malformed');
    assert.equal(evaluateQuoteFreshness({ quote: quote({ timestampMs: 'yesterday' as unknown as number }), nowMs: NOW }).code, 'quote_timestamp_invalid');
    assert.equal(evaluateQuoteFreshness({ quote: quote({ timestampMs: 0 }), nowMs: NOW }).code, 'quote_timestamp_invalid');
    assert.equal(evaluateQuoteFreshness({ quote: quote({ bid: 2001, ask: 2000 }), nowMs: NOW }).code, 'quote_spread_inverted');
    assert.equal(evaluateQuoteFreshness({ quote: quote(), nowMs: Number.NaN }).code, 'quote_clock_unavailable');
    assert.equal(evaluateQuoteFreshness({ quote: quote(), nowMs: NOW, maxAgeMs: -1 }).code, 'quote_clock_unavailable');
    assert.equal(evaluateQuoteFreshness({ quote: quote(), nowMs: NOW, clockSkewMs: -1 }).code, 'quote_clock_unavailable');
    for (const bad of [undefined, null, 'x', { bid: Number.NaN }, quote({ bid: 'x' as unknown as number })]) {
      assert.equal(evaluateQuoteFreshness({ quote: bad, nowMs: NOW }).fresh, false, JSON.stringify(bad));
    }
  });

  test('freshness is not a substitute for schema validation', () => {
    assert.equal(bridgeQuoteSchema.safeParse(quote({ extraField: 1 })).success, false);
    assert.equal(bridgeQuoteSchema.safeParse(quote()).success, true);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §9 (B7) — instrument contract and volume step', () => {
  test('a fully specified instrument validates', () => {
    const decision = validateInstrumentContract(instrument());
    assert.equal(decision.ok, true);
    assert.equal(decision.code, 'valid');
    assert.equal(decision.contract?.volumeStep, 0.01);
    assert.equal(decision.contract?.providerSymbol, 'XAUUSDm');
  });

  test('zero/invalid sizes, digits, volume bounds and step fail closed', () => {
    const invalid: Array<[string, Record<string, unknown>, string]> = [
      ['contractSize zero', { contractSize: 0 }, 'contract_size_invalid'],
      ['contractSize negative', { contractSize: -100 }, 'contract_size_invalid'],
      ['contractSize NaN', { contractSize: Number.NaN }, 'contract_size_invalid'],
      ['contractSize string', { contractSize: '100' }, 'contract_size_invalid'],
      ['contractSize overflow', { contractSize: Number.MAX_VALUE }, 'contract_size_invalid'],
      ['tickSize zero', { tickSize: 0 }, 'tick_size_invalid'],
      ['tickSize negative', { tickSize: -0.01 }, 'tick_size_invalid'],
      ['tickSize infinite', { tickSize: Number.POSITIVE_INFINITY }, 'tick_size_invalid'],
      ['digits negative', { priceDigits: -1 }, 'price_digits_invalid'],
      ['digits fractional', { priceDigits: 2.5 }, 'price_digits_invalid'],
      ['digits too large', { priceDigits: 13 }, 'price_digits_invalid'],
      ['minVolume zero', { minVolume: 0 }, 'volume_min_invalid'],
      ['maxVolume missing', { maxVolume: undefined }, 'volume_max_invalid'],
      ['maxVolume below min', { maxVolume: 0.001 }, 'volume_range_inverted'],
      ['volumeStep zero', { volumeStep: 0 }, 'volume_step_invalid'],
      ['volumeStep negative', { volumeStep: -0.01 }, 'volume_step_invalid'],
      ['volumeStep NaN', { volumeStep: Number.NaN }, 'volume_step_invalid'],
      ['volumeStep infinite', { volumeStep: Number.POSITIVE_INFINITY }, 'volume_step_invalid'],
      ['volumeStep larger than max', { volumeStep: 1000 }, 'instrument_malformed'],
      ['no order types', { orderTypes: [] }, 'order_types_invalid'],
      ['unknown order type', { orderTypes: ['iceberg'] }, 'order_types_invalid'],
      ['trading status free text', { tradingStatus: 'tradable' }, 'trading_status_invalid'],
      ['asset class free text', { assetClass: 'metals' }, 'instrument_malformed'],
    ];
    for (const [name, patch, code] of invalid) {
      const decision = validateInstrumentContract(instrument(patch));
      assert.equal(decision.ok, false, name);
      assert.equal(decision.code, code, name);
      assert.equal(decision.contract, null, name);
    }
  });

  test('a missing or malformed instrument is refused, not defaulted', () => {
    for (const raw of [undefined, null, 'XAUUSDm', 42, []]) {
      const decision = validateInstrumentContract(raw);
      assert.equal(decision.ok, false, JSON.stringify(raw));
      assert.ok(['instrument_missing', 'instrument_malformed'].includes(decision.code), JSON.stringify(raw));
    }
    assert.equal(validateInstrumentContract(undefined).code, 'instrument_missing');
    assert.equal(validateInstrumentContract(null).code, 'instrument_missing');
    assert.equal(validateInstrumentContract({}).code, 'contract_size_invalid');
  });

  test('instrument identity must match the canonical request', () => {
    assert.equal(validateInstrumentContract(instrument(), { canonicalSymbol: 'EURUSD' }).code, 'symbol_mismatch');
    assert.equal(validateInstrumentContract(instrument(), { providerSymbol: 'EURUSDm' }).code, 'symbol_mismatch');
    assert.equal(validateInstrumentContract(instrument(), { assetClass: 'forex' }).code, 'symbol_mismatch');
    assert.equal(validateInstrumentContract(instrument(), { canonicalSymbol: 'XAUUSD', assetClass: 'commodity' }).ok, true);
    assert.ok(ASSET_CLASSES.length > 0);
  });

  test('schema and validator agree on instrument validity', () => {
    for (const patch of [{}, { volumeStep: 0 }, { priceDigits: 2.5 }, { maxVolume: 0.001 }, { contractSize: 0 }, { orderTypes: [] }, { tradingStatus: 'closed' }, { quote: null }]) {
      const row = instrument(patch);
      assert.equal(
        bridgeInstrumentContractSchema.safeParse(row).success,
        validateInstrumentContract(row).ok,
        JSON.stringify(patch),
      );
    }
  });

  test('volume must be inside the range and an integral multiple of the step', () => {
    const contract = { minVolume: 0.01, maxVolume: 10, volumeStep: 0.01 } as BridgeInstrumentContract;
    for (const volume of [0.01, 0.02, 1, 10]) {
      assert.equal(validateVolumeAgainstInstrument({ volume, contract }).ok, true, String(volume));
    }
    assert.equal(validateVolumeAgainstInstrument({ volume: 0.105, contract }).code, 'volume_not_on_step');
    assert.equal(validateVolumeAgainstInstrument({ volume: 0.001, contract }).code, 'volume_below_minimum');
    assert.equal(validateVolumeAgainstInstrument({ volume: 10.01, contract }).code, 'volume_above_maximum');
    assert.equal(validateVolumeAgainstInstrument({ volume: 0, contract }).code, 'volume_not_positive');
    assert.equal(validateVolumeAgainstInstrument({ volume: -0.01, contract }).code, 'volume_not_positive');
    assert.equal(validateVolumeAgainstInstrument({ volume: Number.NaN, contract }).code, 'volume_not_finite');
    assert.equal(validateVolumeAgainstInstrument({ volume: Number.POSITIVE_INFINITY, contract }).code, 'volume_not_finite');
    assert.equal(validateVolumeAgainstInstrument({ volume: '0.1' as unknown as number, contract }).code, 'volume_not_finite');
    assert.equal(validateVolumeAgainstInstrument({ volume: undefined, contract }).code, 'volume_missing');
  });

  test('a zero/invalid volume step can never be used to size a trade', () => {
    for (const volumeStep of [0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      // The historical bug: `(qty - min) / 0` produced Infinity and
      // `Infinity - Math.round(Infinity)` is NaN, so the alignment test
      // silently PASSED every volume. The step is now validated first.
      const contract = { minVolume: 0.01, maxVolume: 10, volumeStep } as BridgeInstrumentContract;
      for (const volume of [0.01, 1, 10, 999]) {
        const decision = validateVolumeAgainstInstrument({ volume, contract });
        assert.equal(decision.ok, false, `${volumeStep}/${volume}`);
        assert.equal(decision.code, 'volume_step_invalid', `${volumeStep}/${volume}`);
      }
    }
    assert.equal(validateVolumeAgainstInstrument({ volume: 1, contract: null }).code, 'volume_step_invalid');
    assert.equal(validateVolumeAgainstInstrument({ volume: 1, contract: undefined }).code, 'volume_step_invalid');
  });

  test('float representation noise is tolerated but a real misalignment is not', () => {
    const contract = { minVolume: 0.1, maxVolume: 100, volumeStep: 0.1 } as BridgeInstrumentContract;
    for (const volume of [0.3, 0.7000000000000001, 3.4]) {
      assert.equal(validateVolumeAgainstInstrument({ volume, contract }).ok, true, String(volume));
    }
    assert.equal(validateVolumeAgainstInstrument({ volume: 0.35, contract }).code, 'volume_not_on_step');
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §10 — bounded prices and instrument compatibility', () => {
  test('non-finite, zero and negative prices are invalid', () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e13, '1990' as unknown as number, null]) {
      assert.equal(isPriceCompatibleWithInstrument(price, { tickSize: 0.01, priceDigits: 2 }), false, String(price));
    }
    assert.equal(isPriceCompatibleWithInstrument(1990, { tickSize: 0.01, priceDigits: 2 }), true);
    assert.equal(isPriceCompatibleWithInstrument(1990, null), false, 'no contract means no permission');
  });

  test('a price must be representable at the instrument tick and digits', () => {
    assert.equal(isPriceCompatibleWithInstrument(1990.005, { tickSize: 0.01, priceDigits: 2 }), false);
    assert.equal(isPriceCompatibleWithInstrument(1990.01, { tickSize: 0.01, priceDigits: 2 }), true);
    assert.equal(isPriceCompatibleWithInstrument(1990.01, { tickSize: 0.5, priceDigits: 2 }), false);
  });

  test('limit/stop orders must carry a price and market orders must not', () => {
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ orderType: 'limit', price: null })).success, false);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ orderType: 'limit', price: 2010 })).success, true);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ orderType: 'market', price: 2010 })).success, false);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ stopLoss: 0 })).success, false);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ takeProfit: Number.NaN })).success, false);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §5/§6 — handshake and attestation contract', () => {
  const handshake = (patch: Record<string, unknown> = {}) => ({
    protocolId: MT5_BRIDGE_PROTOCOL_ID,
    protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION,
    requestedCapabilities: ['order_submit', 'order_cancel', 'reconciliation_lookup'],
    accountBinding: binding(),
    attestation: null,
    transportReadiness: null,
    ...patch,
  });

  const attestation = (patch: Record<string, unknown> = {}) => ({
    accountRef: 'demo-account-1',
    broker: 'example-broker',
    server: 'example-demo-01',
    environment: 'demo',
    attestedAt: '2026-09-20T00:00:00.000Z',
    identityFingerprint: 'd'.repeat(64),
    credentialBinding: { attestationCredentialRef: 'managed-mt5-demo', brokerCredentialRef: 'managed-mt5-demo', secretManagerIntegrated: false },
    ...patch,
  });

  test('a conforming handshake is accepted with its declared capabilities', () => {
    const decision = evaluateBridgeHandshake(handshake(), { accountRef: 'demo-account-1', broker: 'example-broker', server: 'example-demo-01' });
    assert.equal(decision.ok, true);
    assert.equal(decision.code, 'accepted');
    assert.deepEqual(decision.capabilities, ['order_submit', 'order_cancel', 'reconciliation_lookup']);
  });

  test('handshake validation refuses an unsupported higher MAJOR', () => {
    const decision = evaluateBridgeHandshake(handshake({ protocolVersion: '2.0.0' }), { accountRef: 'demo-account-1' });
    assert.equal(decision.ok, false);
    assert.equal(decision.code, 'protocol_higher_major_rejected');
    assert.equal(evaluateBridgeHandshake(handshake({ protocolVersion: '1.1.0' }), { accountRef: 'demo-account-1' }).code, 'protocol_version_unsupported');
    assert.equal(evaluateBridgeHandshake(handshake({ protocolVersion: 'nonsense' }), { accountRef: 'demo-account-1' }).code, 'handshake_malformed');
  });

  test('a wrong protocol identity or an unknown capability is refused', () => {
    assert.equal(evaluateBridgeHandshake(handshake({ protocolId: 'veltrixeye.other-bridge' }), { accountRef: 'demo-account-1' }).code, 'handshake_malformed');
    assert.equal(bridgeHandshakeRequestSchema.safeParse(handshake({ requestedCapabilities: ['live_execute'] })).success, false, 'no live-execution capability exists');
    assert.equal(evaluateBridgeHandshake(handshake({ requestedCapabilities: ['order_submit', 'order_cancel'] }), { accountRef: 'demo-account-1', supportedCapabilities: ['order_submit'] }).code, 'capability_unsupported');
    // Requesting nothing is legal — and it grants nothing: an accepted
    // health-only handshake must never imply a mutation capability.
    const healthOnly = evaluateBridgeHandshake(handshake({ requestedCapabilities: [] }), { accountRef: 'demo-account-1', supportedCapabilities: ['order_submit'] });
    assert.deepEqual(healthOnly.capabilities, []);
    assert.equal(healthOnly.ok, true);
    assert.equal(evaluateBridgeHandshake(handshake({ requestedCapabilities: ['order_submit'] }), { accountRef: 'demo-account-1', supportedCapabilities: ['order_submit'] }).ok, true);
  });

  test('environment and account mismatches fail closed', () => {
    assert.equal(evaluateBridgeHandshake(handshake({ accountBinding: binding({ environment: 'live' }) }), { accountRef: 'demo-account-1' }).code, 'live_environment_prohibited');
    assert.equal(evaluateBridgeHandshake(handshake({ accountBinding: binding({ environment: 'paper' }) }), { accountRef: 'demo-account-1' }).code, 'environment_unsupported');
    assert.equal(evaluateBridgeHandshake(handshake({ accountBinding: binding({ accountRef: 'other' }) }), { accountRef: 'demo-account-1' }).code, 'account_identity_mismatch');
    assert.equal(evaluateBridgeHandshake(handshake({ accountBinding: binding({ server: 'other-server' }) }), { accountRef: 'demo-account-1', server: 'example-demo-01' }).code, 'account_identity_mismatch');
  });

  test('attestation must agree with the binding, or the handshake fails closed', () => {
    assert.equal(evaluateBridgeHandshake(handshake({ attestation: attestation() }), { accountRef: 'demo-account-1' }).ok, true);
    assert.equal(evaluateBridgeHandshake(handshake({ attestation: attestation({ accountRef: 'other' }) }), { accountRef: 'demo-account-1' }).code, 'attestation_mismatch');
    assert.equal(evaluateBridgeHandshake(handshake({ attestation: attestation({ environment: 'live' }) }), { accountRef: 'demo-account-1' }).code, 'attestation_mismatch');
    assert.equal(evaluateBridgeHandshake(handshake({ attestation: attestation({ server: null }) }), { accountRef: 'demo-account-1' }).code, 'attestation_mismatch');
    // The attestation and broker credentials must share one approved binding.
    assert.equal(evaluateBridgeHandshake(handshake({ attestation: attestation({ credentialBinding: { attestationCredentialRef: 'managed-mt5-demo', brokerCredentialRef: 'somewhere-else', secretManagerIntegrated: false } }) }), { accountRef: 'demo-account-1' }).code, 'attestation_mismatch');
    // A malformed attestation is an attestation failure, not an envelope typo.
    assert.equal(evaluateBridgeHandshake(handshake({ attestation: { accountRef: 'demo-account-1' } }), { accountRef: 'demo-account-1' }).code, 'attestation_mismatch');
  });

  test('no credential value has a place in the protocol', () => {
    for (const field of ['password', 'login', 'token', 'secret', 'credential']) {
      assert.equal(bridgeHandshakeRequestSchema.safeParse(handshake({ [field]: 'x' })).success, false, field);
      assert.equal(bridgeHandshakeRequestSchema.safeParse(handshake({ attestation: attestation({ [field]: 'x' }) })).success, false, `attestation.${field}`);
    }
  });

  test('a handshake result can never be mistaken for a mutation receipt', () => {
    const result = {
      protocolId: MT5_BRIDGE_PROTOCOL_ID,
      protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION,
      supportedCapabilities: ['order_submit'],
      accountBinding: binding(),
      decision: 'accepted',
      attestedAt: '2026-09-20T00:00:00.000Z',
    };
    assert.equal(bridgeHandshakeResultSchema.safeParse(result).success, true);
    for (const smuggled of ['ticket', 'providerOrderId', 'orderId', 'status', 'filledQuantity']) {
      assert.equal(bridgeHandshakeResultSchema.safeParse({ ...result, [smuggled]: '1' }).success, false, smuggled);
    }
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §12/§18 — mutation identity and response normalization', () => {
  test('an unknown, case-variant or malformed provider status stays uncertain', () => {
    for (const raw of ['vendor_new_state', 'FILLED', ' Accepted ', '', 'accepted\n', 3, null, undefined, {}, ['filled'], true]) {
      const normalized = normalizeProviderOrderStatus(raw);
      assert.equal(normalized.status, null, JSON.stringify(raw));
      assert.equal(normalized.statusUncertain, true, JSON.stringify(raw));
      assert.equal(normalized.snapshotStatus, 'uncertain', JSON.stringify(raw));
    }
  });

  test('the closed vocabulary maps exactly, with no case folding', () => {
    const expected: Record<string, string> = {
      requested: 'submitted', placed: 'accepted', accepted: 'accepted', partial: 'partially_filled',
      filled: 'filled', rejected: 'rejected', cancelled: 'cancelled', canceled: 'cancelled', expired: 'expired',
    };
    for (const [raw, mapped] of Object.entries(expected)) {
      assert.equal(normalizeProviderOrderStatus(raw).status, mapped, raw);
      assert.equal(normalizeProviderOrderStatus(raw).statusUncertain, false, raw);
      assert.equal(normalizeProviderOrderStatus(raw).snapshotStatus, mapped, raw);
    }
    assert.equal(Object.keys(PROVIDER_ORDER_STATUS_VOCABULARY).length, Object.keys(expected).length);
    // The normalizer never invents `failed`: it is not in the vocabulary range,
    // so an unreadable state cannot be laundered into a definitive failure.
    assert.equal(Object.values(PROVIDER_ORDER_STATUS_VOCABULARY).includes('failed'), false);
  });

  test('market closure is a deterministic condition, not provider text', () => {
    assert.equal(BRIDGE_MARKET_CLOSED_CONDITION, 'market_closed');
    const normalized = normalizeProviderOrderStatus('market_closed');
    assert.equal(normalized.deterministicCondition, 'market_closed');
    assert.equal(normalized.statusUncertain, true);
  });

  test('the reservation vocabulary distinguishes completed, rejected and uncertain', () => {
    const base = { mutation: 'submit', idempotencyKey: IDEMPOTENCY, clientOrderId: clientOrderId() };
    for (const state of ['reserved', 'known_completed', 'known_rejected', 'uncertain']) {
      assert.equal(bridgeReservationSchema.safeParse({ ...base, state, requiresReconciliation: state === 'uncertain' }).success, true, state);
    }
    assert.equal(bridgeReservationSchema.safeParse({ ...base, state: 'uncertain', requiresReconciliation: false }).success, false);
    assert.equal(bridgeReservationSchema.safeParse({ ...base, state: 'known_completed', requiresReconciliation: true }).success, false);
    assert.equal(bridgeReservationSchema.safeParse({ ...base, state: 'in_flight', requiresReconciliation: false }).success, false);
    assert.equal(bridgeReservationSchema.safeParse({ ...base, state: 'reserved', requiresReconciliation: false, extra: true }).success, false);
    assert.equal(bridgeReservationSchema.safeParse({ ...base, clientOrderId: 'vendor-ticket', requiresReconciliation: false }).success, false);
    assert.equal(bridgeReservationSchema.safeParse({ ...base, idempotencyKey: 'not-durable', requiresReconciliation: false }).success, false);
  });

  test('a definitive outcome requires evidence; an uncertain one requires the flag', () => {
    const base = { mutation: 'submit', idempotencyKey: IDEMPOTENCY, clientOrderId: null, condition: null };
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'uncertain', outcomeUnknown: true, evidence: null }).success, true);
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'uncertain', outcomeUnknown: false, evidence: null }).success, false);
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'uncertain', outcomeUnknown: true, evidence: 'provider_response_verified' }).success, false);
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'rejected', outcomeUnknown: false, evidence: 'provider_response_verified' }).success, true);
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'rejected', outcomeUnknown: false, evidence: null }).success, false);
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'rejected', outcomeUnknown: true, evidence: null }).success, false);
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'timeout', outcomeUnknown: true, evidence: null }).success, false, 'timeout is not an outcome vocabulary member');
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'uncertain', outcomeUnknown: true, evidence: null, condition: 'Market closed, try later' }).success, false, 'conditions are closed tokens');
    assert.equal(bridgeMutationOutcomeSchema.safeParse({ ...base, outcome: 'uncertain', outcomeUnknown: true, evidence: null, condition: 'market_closed' }).success, true);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §19/§20/§21 — ticket mapping and reconciliation identity', () => {
  test('a ticket alone is never storable identity', () => {
    const base = { providerTicket: 'T-1', clientOrderId: null, idempotencyKey: null, accountBinding: binding(), symbol: null };
    assert.equal(bridgeTicketMappingSchema.safeParse(base).success, false);
    assert.equal(bridgeTicketMappingSchema.safeParse({ ...base, clientOrderId: clientOrderId() }).success, true);
    assert.equal(bridgeTicketMappingSchema.safeParse({ ...base, idempotencyKey: IDEMPOTENCY }).success, true);
    assert.equal(bridgeTicketMappingSchema.safeParse({ ...base, symbol: 'XAUUSD' }).success, true);
    assert.equal(bridgeTicketMappingSchema.safeParse({ ...base, clientOrderId: 'vendor-1' }).success, false);
    assert.equal(bridgeTicketMappingSchema.safeParse({ ...base, providerTicket: 'a'.repeat(129) }).success, false);
    assert.equal(bridgeTicketMappingSchema.safeParse({ ...base, clientOrderId: clientOrderId(), providerTicket: 'a'.repeat(128) }).success, true);
    assert.equal(bridgeTicketMappingSchema.safeParse({ ...base, clientOrderId: clientOrderId(), providerTicket: 'a'.repeat(129) }).success, false);
  });

  test('reconciliation lookup requires exactly one durable selector', () => {
    const base = { protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION, accountBinding: binding() };
    assert.equal(bridgeReconciliationLookupSchema.safeParse({ ...base, providerTicket: 'T-1' }).success, true);
    assert.equal(bridgeReconciliationLookupSchema.safeParse({ ...base, clientOrderId: clientOrderId() }).success, true);
    assert.equal(bridgeReconciliationLookupSchema.safeParse({ ...base, idempotencyKey: IDEMPOTENCY }).success, true);
    assert.equal(bridgeReconciliationLookupSchema.safeParse(base).success, false, 'no selector');
    assert.equal(bridgeReconciliationLookupSchema.safeParse({ ...base, providerTicket: 'T-1', clientOrderId: clientOrderId() }).success, false, 'two selectors');
  });

  test('an unobservable provider state is uncertain, never a definitive failure', () => {
    const at = '2026-09-20T00:00:00.000Z';
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'uncertain', status: 'uncertain', statusUncertain: true, requiresReconciliation: true, observedAt: at }).success, true);
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'uncertain', status: null, statusUncertain: true, requiresReconciliation: false, observedAt: at }).success, false);
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'uncertain', status: 'failed', statusUncertain: true, requiresReconciliation: true, observedAt: at }).success, false);
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'matched', status: 'filled', statusUncertain: false, requiresReconciliation: false, observedAt: at }).success, true);
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'matched', status: null, statusUncertain: false, requiresReconciliation: false, observedAt: at }).success, false);
    // `not_found` is a proven absence and carries no status at all.
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'not_found', status: null, statusUncertain: false, requiresReconciliation: false, observedAt: at }).success, true);
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'not_found', status: 'failed', statusUncertain: false, requiresReconciliation: false, observedAt: at }).success, false);
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'not_found', status: 'uncertain', statusUncertain: true, requiresReconciliation: true, observedAt: at }).success, false);
    assert.equal(bridgeReconciliationResultSchema.safeParse({ outcome: 'definitely_failed', status: null, statusUncertain: false, requiresReconciliation: false, observedAt: at }).success, false);
  });

  test('the snapshot status vocabulary adds `uncertain` without touching durable statuses', () => {
    assert.deepEqual(BRIDGE_NORMALIZED_STATUSES, [...ORDER_STATUSES, 'uncertain']);
    assert.deepEqual(RECONCILIATION_SNAPSHOT_ORDER_STATUSES, BRIDGE_NORMALIZED_STATUSES);
    assert.equal((ORDER_STATUSES as readonly string[]).includes('uncertain'), false, 'the durable order-status vocabulary is untouched');
    assert.equal(ORDER_STATUSES.length, 10);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §24/§25/§31 — audit contract and secret boundary', () => {
  const audit = {
    mutation: 'submit',
    clientOrderId: clientOrderId(),
    idempotencyKey: IDEMPOTENCY,
    accountBinding: binding(),
    outcome: 'uncertain',
    outcomeUnknown: true,
    reconciliationState: 'pending',
    durable: true,
    occurredAt: '2026-09-20T00:00:00.000Z',
  };

  test('an audit event carries identity, binding and outcome only', () => {
    assert.equal(bridgeAuditEventSchema.safeParse(audit).success, true);
    assert.deepEqual(Object.keys(bridgeAuditEventSchema.parse(audit)).sort(), [
      'accountBinding', 'clientOrderId', 'durable', 'idempotencyKey', 'mutation', 'occurredAt', 'outcome', 'outcomeUnknown', 'reconciliationState',
    ]);
  });

  test('credential fields and provider payloads are rejected, not redacted', () => {
    for (const key of ['password', 'token', 'secret', 'metadata', 'rawResponse', 'providerMessage', 'payload']) {
      assert.equal(bridgeAuditEventSchema.safeParse({ ...audit, [key]: 'x' }).success, false, key);
    }
  });

  test('nested credential-shaped values are detected', () => {
    assert.equal(containsForbiddenAuditKey({ nested: { api_key: 'x' } }), true);
    assert.equal(containsForbiddenAuditKey({ list: [{ Authorization: 'Bearer x' }] }), true);
    assert.equal(containsForbiddenAuditKey({ nested: { outcome: 'uncertain' } }), false);
    assert.equal(containsForbiddenAuditKey(null), false);
    assert.equal(containsForbiddenAuditKey('password=hunter2'), false);
  });

  test('durable audit is distinguishable from read observability', () => {
    assert.equal(bridgeAuditEventSchema.safeParse({ ...audit, durable: false }).success, true);
    assert.equal(bridgeAuditEventSchema.safeParse({ ...audit, durable: 'yes' }).success, false);
    assert.equal(bridgeAuditEventSchema.safeParse({ ...audit, durable: undefined }).success, false);
    for (const state of ['not_required', 'pending', 'resolved']) {
      assert.equal(bridgeAuditEventSchema.safeParse({ ...audit, reconciliationState: state }).success, true, state);
    }
    assert.equal(bridgeAuditEventSchema.safeParse({ ...audit, reconciliationState: 'ignored' }).success, false);
  });
});

/* -------------------------------------------------------------------------- */
describe('Gate 9 §13 — submit message contract', () => {
  test('every required element is present in the accepted message', () => {
    const parsed = bridgeSubmitOrderSchema.parse(submitMessage());
    assert.equal(parsed.protocolId, MT5_BRIDGE_PROTOCOL_ID);
    assert.equal(parsed.accountBinding.accountRef, 'demo-account-1');
    assert.equal(parsed.symbol, 'XAUUSD');
    assert.equal(parsed.volume, 0.1);
    assert.equal(parsed.clientOrderId, clientOrderId());
    assert.equal(parsed.idempotencyKey, IDEMPOTENCY);
  });

  test('invalid values in any required element are refused', () => {
    const invalid: Array<Record<string, unknown>> = [
      { symbol: 'xauusd' },
      { symbol: '' },
      { symbol: 'XAUUSD spot' },
      { volume: 0 },
      { volume: Number.NaN },
      { side: 'BUY' },
      { orderType: 'iceberg' },
      { clientOrderId: 'vendor-ticket' },
      { idempotencyKey: 'short' },
      { protocolVersion: 'not-semver' },
      { stopLoss: -1 },
      { takeProfit: '2020' },
    ];
    for (const patch of invalid) {
      assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage(patch)).success, false, JSON.stringify(patch));
    }
  });

  test('version and environment policy live outside the message shape', () => {
    // A higher MAJOR is a well-formed version: the message schema accepts the
    // shape and the COMPATIBILITY evaluator refuses it. Keeping those separate
    // is what stops a vendor row from being reinterpreted by a "fixed" regex.
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ protocolVersion: '2.0.0' })).success, true);
    assert.equal(evaluateProtocolCompatibility('2.0.0').accepted, false);
  });

  test('the shape accepts a live environment but the binding rule refuses it', () => {
    // Separating shape from policy keeps the schema honest: `live` is a real
    // environment word, so it must be rejected by an explicit rule, not by a
    // vocabulary accident that a later contributor could "fix".
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ accountBinding: binding({ environment: 'live' }) })).success, true);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ accountBinding: binding({ environment: 'production' }) })).success, false);
    assert.equal(validateBridgeAccountBinding(binding({ environment: 'live' }), { accountRef: 'demo-account-1' }).code, 'live_environment_prohibited');
  });

  test('a client cannot override the broker symbol or add fields', () => {
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ providerSymbol: 'XAUUSDm' })).success, false);
    assert.equal(bridgeSubmitOrderSchema.safeParse(submitMessage({ brokerSymbol: 'XAUUSDm' })).success, false);
    assert.equal(bridgeCancelOrderSchema.safeParse({
      protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION, accountBinding: binding(),
      idempotencyKey: IDEMPOTENCY, clientOrderId: clientOrderId(), providerTicket: 'T-1',
    }).success, true);
    assert.equal(bridgeModifyOrderSchema.safeParse({
      protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION, accountBinding: binding(),
      idempotencyKey: IDEMPOTENCY, clientOrderId: clientOrderId(), providerTicket: 'T-1', symbol: 'XAUUSD', stopLoss: null, takeProfit: null,
    }).success, false, 'a modify must change at least one permitted price field');
    assert.equal(bridgeModifyOrderSchema.safeParse({
      protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION, accountBinding: binding(),
      idempotencyKey: IDEMPOTENCY, clientOrderId: clientOrderId(), providerTicket: 'T-1', symbol: 'XAUUSD', stopLoss: 1990.5, takeProfit: null,
    }).success, true);
  });

  test('close identifies the position by ticket with an optional durable order id', () => {
    assert.equal(bridgeClosePositionSchema.safeParse({
      protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION, accountBinding: binding(),
      idempotencyKey: IDEMPOTENCY, providerTicket: 'P-9', clientOrderId: null,
    }).success, true);
    assert.equal(bridgeClosePositionSchema.safeParse({
      protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION, accountBinding: binding(),
      idempotencyKey: IDEMPOTENCY, providerTicket: '', clientOrderId: null,
    }).success, false);
    assert.equal(bridgeClosePositionSchema.safeParse({
      protocolId: MT5_BRIDGE_PROTOCOL_ID, protocolVersion: MT5_BRIDGE_PROTOCOL_VERSION, accountBinding: binding(),
      idempotencyKey: IDEMPOTENCY, providerTicket: 'P-9', clientOrderId: clientOrderId(), volume: 1,
    }).success, false);
  });
});
