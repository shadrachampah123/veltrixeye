import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIMEFRAMES,
  normalizeTimeframe,
  timeframeMinutes,
  strategyTimeframesSchema,
  ERROR_CODES,
  ProviderError,
  isProviderError,
  RETENTION_DAYS,
  retentionCutoffMs,
  MAX_CANDLES_PER_REQUEST,
  MAX_BACKFILL_CANDLES,
  MAX_BACKFILL_INSTRUMENTS,
  candleQuerySchema,
  candleDtoSchema,
  backfillRequestSchema,
  coverageDtoSchema,
  qualityGrade,
  CONDITION_TYPE_REGISTRY,
  CONDITION_CLASSIFICATIONS,
  listConditionTypes,
  getConditionType,
  strategyConditionSchema,
  riskConfigurationSchema,
  marketScopeSchema,
  registerSchema,
  loginSchema,
  changePasswordSchema,
  strategyCreateSchema,
  DEFAULT_MIN_RR,
  DEFAULT_MIN_QUALITY_SCORE,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Timeframes
// ---------------------------------------------------------------------------

test('timeframe: normalizes common display formats to canonical values', () => {
  assert.equal(normalizeTimeframe('1D'), '1d');
  assert.equal(normalizeTimeframe('4H'), '4h');
  assert.equal(normalizeTimeframe('1h'), '1h');
  assert.equal(normalizeTimeframe('15m'), '15m');
  assert.equal(normalizeTimeframe('60m'), '1h');
  assert.equal(normalizeTimeframe('240m'), '4h');
  assert.equal(normalizeTimeframe('1W'), '1w');
  assert.equal(normalizeTimeframe(' 15M '), '15m');
});

test('timeframe: rejects values outside the canonical vocabulary', () => {
  assert.equal(normalizeTimeframe('2d'), null); // not in vocabulary
  assert.equal(normalizeTimeframe('99m'), null);
  assert.equal(normalizeTimeframe('abc'), null);
  assert.equal(normalizeTimeframe(''), null);
  assert.equal(normalizeTimeframe('1x'), null);
});

test('timeframe: canonical list contains the reference-strategy timeframes', () => {
  for (const tf of ['1d', '4h', '1h', '15m', '5m']) {
    assert.ok((TIMEFRAMES as readonly string[]).includes(tf), `missing ${tf}`);
  }
});

test('timeframe: strategyTimeframesSchema enforces all three roles', () => {
  const ok = strategyTimeframesSchema.safeParse({ htf_bias: '1d', setup: '1h', entry: '15m' });
  assert.equal(ok.success, true);
  const missing = strategyTimeframesSchema.safeParse({ htf_bias: '1d', setup: '1h' });
  assert.equal(missing.success, false);
  const badValue = strategyTimeframesSchema.safeParse({ htf_bias: '2d', setup: '1h', entry: '15m' });
  assert.equal(badValue.success, false);
  const extraKey = strategyTimeframesSchema.safeParse({ htf_bias: '1d', setup: '1h', entry: '15m', extra: 'x' });
  assert.equal(extraKey.success, false); // strict
});

// ---------------------------------------------------------------------------
// Quality grade bands (product requirement)
// ---------------------------------------------------------------------------

test('quality: grade bands match the documented 0-100 scale', () => {
  assert.equal(qualityGrade(100), 'A+');
  assert.equal(qualityGrade(90), 'A+');
  assert.equal(qualityGrade(89), 'A');
  assert.equal(qualityGrade(85), 'A');
  assert.equal(qualityGrade(84), 'B');
  assert.equal(qualityGrade(75), 'B');
  assert.equal(qualityGrade(74), 'C');
  assert.equal(qualityGrade(65), 'C');
  assert.equal(qualityGrade(64), 'ignore');
  assert.equal(qualityGrade(0), 'ignore');
});

test('quality: out-of-range input is clamped, not thrown', () => {
  assert.equal(qualityGrade(-5), 'ignore');
  assert.equal(qualityGrade(140), 'A+');
});

// ---------------------------------------------------------------------------
// Condition registry
// ---------------------------------------------------------------------------

const REQUIRED_SPEC_TYPES = [
  'liquidity_sweep',
  'choch',
  'bos',
  'break_retest',
  'order_block',
  'fvg',
  'support',
  'resistance',
  'supply',
  'demand',
  'rejection_candle',
  'engulfing_candle',
  'displacement',
  'rr_requirement',
  'session_requirement',
  'news_filter',
  'volatility_filter',
  'spread_filter',
  'htf_alignment',
];

test('conditions: registry contains every spec-required condition type', () => {
  for (const type of REQUIRED_SPEC_TYPES) {
    assert.ok(CONDITION_TYPE_REGISTRY[type], `missing condition type ${type}`);
  }
});

test('conditions: every registry entry is well-formed and extensible', () => {
  const types = listConditionTypes();
  assert.ok(types.length >= REQUIRED_SPEC_TYPES.length);
  for (const def of types) {
    assert.ok(def.type.length > 0);
    assert.ok(def.label.length > 0);
    assert.ok(def.description.length > 0);
    assert.ok(def.categories.length > 0);
    assert.ok(def.defaultTimeframeRole);
    // every schema must accept {} (all fields have defaults, except where noted)
    const parsed = def.paramSchema.safeParse({});
    if (def.type !== 'spread_filter') {
      assert.equal(parsed.success, true, `${def.type} should accept {} (defaults): ${parsed.success ? '' : JSON.stringify(parsed.error?.issues)}`);
    }
    // unknown keys must be rejected (strict)
    const bad = def.paramSchema.safeParse({ __unknown_key__: 1 });
    assert.equal(bad.success, false, `${def.type} must reject unknown keys`);
  }
});

test('conditions: param schemas validate type-specific values', () => {
  const sweep = getConditionType('liquidity_sweep')!;
  assert.equal(sweep.paramSchema.safeParse({ side: 'above', lookbackCandles: 50 }).success, true);
  assert.equal(sweep.paramSchema.safeParse({ side: 'diagonal' }).success, false);
  assert.equal(sweep.paramSchema.safeParse({ side: 'above', lookbackCandles: -1 }).success, false);

  const rr = getConditionType('rr_requirement')!;
  assert.equal(rr.paramSchema.safeParse({ minRr: 2 }).success, true);
  assert.equal(rr.paramSchema.safeParse({ minRr: 0 }).success, false);

  const vol = getConditionType('volatility_filter')!;
  assert.equal(vol.paramSchema.safeParse({ min: 1, max: 0.5 }).success, false); // max <= min
  assert.equal(vol.paramSchema.safeParse({ min: 0.5, max: 2 }).success, true);
});

test('conditions: strategyConditionSchema enforces the registry + classification', () => {
  const ok = strategyConditionSchema.safeParse({
    conditionType: 'bos',
    classification: 'required',
    timeframeRole: 'setup',
    params: { direction: 'bullish' },
  });
  assert.equal(ok.success, true, JSON.stringify(ok.success ? '' : ok.error?.issues));

  const unknownType = strategyConditionSchema.safeParse({
    conditionType: 'does_not_exist',
    classification: 'required',
    timeframeRole: 'setup',
  });
  assert.equal(unknownType.success, false);

  for (const classification of CONDITION_CLASSIFICATIONS) {
    const c = strategyConditionSchema.safeParse({
      conditionType: 'support',
      classification,
      timeframeRole: 'setup',
    });
    assert.equal(c.success, true, `classification ${classification} must be accepted`);
  }

  const badClassification = strategyConditionSchema.safeParse({
    conditionType: 'support',
    classification: 'maybe',
    timeframeRole: 'setup',
  });
  assert.equal(badClassification.success, false);

  const badParams = strategyConditionSchema.safeParse({
    conditionType: 'liquidity_sweep',
    classification: 'required',
    timeframeRole: 'setup',
    params: { side: 'sideways' },
  });
  assert.equal(badParams.success, false);
});

// ---------------------------------------------------------------------------
// Risk configuration
// ---------------------------------------------------------------------------

test('risk: defaults — minimum RR is 1:2 and min quality score is 65', () => {
  const parsed = riskConfigurationSchema.parse({});
  assert.equal(parsed.minRr, 2);
  assert.equal(DEFAULT_MIN_RR, 2);
  assert.equal(parsed.minQualityScore, 65);
  assert.equal(DEFAULT_MIN_QUALITY_SCORE, 65);
});

test('risk: configurable values are accepted and persisted as-is', () => {
  const parsed = riskConfigurationSchema.parse({
    minRr: 3.5,
    stopLossMethod: 'atr',
    stopLossBuffer: 2.5,
    stopLossBufferUnit: 'pct',
    takeProfitMethod: 'rr',
    tp1Rr: 1.5,
    tp2Rr: 3,
    tp3Rr: 4.5,
    minQualityScore: 80,
  });
  assert.equal(parsed.minRr, 3.5);
  assert.equal(parsed.stopLossMethod, 'atr');
  assert.equal(parsed.minQualityScore, 80);
});

test('risk: take-profit targets must increase for rr method', () => {
  const bad = riskConfigurationSchema.safeParse({ takeProfitMethod: 'rr', tp1Rr: 3, tp2Rr: 2, tp3Rr: 1 });
  assert.equal(bad.success, false);
});

test('risk: invalid values rejected', () => {
  assert.equal(riskConfigurationSchema.safeParse({ minRr: 0 }).success, false);
  assert.equal(riskConfigurationSchema.safeParse({ minRr: -1 }).success, false);
  assert.equal(riskConfigurationSchema.safeParse({ minQualityScore: 101 }).success, false);
  assert.equal(riskConfigurationSchema.safeParse({ minQualityScore: -1 }).success, false);
  assert.equal(riskConfigurationSchema.safeParse({ stopLossMethod: 'vibes' }).success, false);
});

// ---------------------------------------------------------------------------
// Market scope
// ---------------------------------------------------------------------------

test('marketScope: instruments mode requires at least one instrument', () => {
  assert.equal(marketScopeSchema.safeParse({ mode: 'instruments' }).success, false);
  assert.equal(marketScopeSchema.safeParse({ mode: 'instruments', instruments: [] }).success, false);
  assert.equal(
    marketScopeSchema.safeParse({ mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'eurusd' }] })
      .success,
    true,
  );
});

test('marketScope: all mode rejects explicit instruments; symbols are uppercased', () => {
  assert.equal(marketScopeSchema.safeParse({ mode: 'all', instruments: [{ assetClass: 'forex', symbol: 'EURUSD' }] }).success, false);
  const parsed = marketScopeSchema.parse({ mode: 'instruments', instruments: [{ assetClass: 'forex', symbol: 'eurusd' }] });
  assert.equal(parsed.instruments?.[0]?.symbol, 'EURUSD');
});

// ---------------------------------------------------------------------------
// Auth payloads
// ---------------------------------------------------------------------------

test('auth: register enforces email + password policy', () => {
  assert.equal(registerSchema.safeParse({ email: 'not-an-email', password: 'abc12345' }).success, false);
  assert.equal(registerSchema.safeParse({ email: 'a@b.co', password: 'short' }).success, false);
  assert.equal(registerSchema.safeParse({ email: 'a@b.co', password: 'lettersonly' }).success, false); // no digit
  assert.equal(registerSchema.safeParse({ email: 'a@b.co', password: '12345678' }).success, false); // no letter
  assert.equal(registerSchema.safeParse({ email: 'a@b.co', password: 'goodPass1' }).success, true);
  // emails are normalized to lowercase
  const parsed = registerSchema.parse({ email: 'User@Example.COM', password: 'goodPass1' });
  assert.equal(parsed.email, 'user@example.com');
});

test('auth: login accepts any non-empty password (server verifies)', () => {
  assert.equal(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success, true);
  assert.equal(loginSchema.safeParse({ email: 'a@b.co' }).success, false);
});

test('auth: changePassword rejects same current/new password', () => {
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'goodPass1', newPassword: 'goodPass1' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'goodPass1', newPassword: 'newPass1' }).success, true);
});

// ---------------------------------------------------------------------------
// Strategy create payload
// ---------------------------------------------------------------------------

test('strategy create: name rules and nested config validation', () => {
  assert.equal(strategyCreateSchema.safeParse({ name: 'x' }).success, false); // too short
  assert.equal(strategyCreateSchema.safeParse({ name: 'My Strategy' }).success, true);
  assert.equal(
    strategyCreateSchema.safeParse({
      name: 'My Strategy',
      version: {
        timeframes: { htf_bias: '1d', setup: '1h', entry: '15m' },
        marketScope: { mode: 'all' },
        risk: { minRr: 2 },
        ruleGroups: [
          {
            name: 'Entry',
            logic: 'AND',
            conditions: [{ conditionType: 'liquidity_sweep', classification: 'required', timeframeRole: 'setup', params: { side: 'below' } }],
          },
        ],
      },
    }).success,
    true,
  );
  // unknown top-level key rejected
  assert.equal(strategyCreateSchema.safeParse({ name: 'My Strategy', bogus: 1 }).success, false);
});

// ---------------------------------------------------------------------------
// Timeframe durations + ingestion contracts (M2)
// ---------------------------------------------------------------------------

test('timeframe: timeframeMinutes reports the documented durations', () => {
  assert.equal(timeframeMinutes('1m'), 1);
  assert.equal(timeframeMinutes('15m'), 15);
  assert.equal(timeframeMinutes('1h'), 60);
  assert.equal(timeframeMinutes('4h'), 240);
  assert.equal(timeframeMinutes('1d'), 1440);
  assert.equal(timeframeMinutes('1w'), 10080);
  assert.equal(timeframeMinutes('1M'), 43200);
  for (const tf of TIMEFRAMES) {
    assert.ok(timeframeMinutes(tf) > 0, `${tf} has a duration`);
  }
});

test('ingestion: retention table matches the approved M2 policy', () => {
  assert.equal(RETENTION_DAYS['1m'], 30);
  assert.equal(RETENTION_DAYS['5m'], 90);
  assert.equal(RETENTION_DAYS['15m'], 180);
  assert.equal(RETENTION_DAYS['1h'], 365);
  assert.equal(RETENTION_DAYS['1d'], 1825);
  for (const tf of TIMEFRAMES) {
    assert.ok(RETENTION_DAYS[tf] > 0, `${tf} has retention`);
  }
  const now = Date.UTC(2026, 8, 13);
  assert.equal(retentionCutoffMs('1d', now), now - 1825 * 86_400_000);
  assert.equal(retentionCutoffMs('1m', now), now - 30 * 86_400_000);
});

test('ingestion: candle query validates instrument, range, and limit', () => {
  const base = { assetClass: 'forex', symbol: 'eurusd', timeframe: '1h', from: 1000, to: 2000 };
  const ok = candleQuerySchema.safeParse(base);
  assert.equal(ok.success, true);
  if (ok.success) {
    assert.equal(ok.data.symbol, 'EURUSD'); // normalized
    assert.equal(ok.data.limit, 500); // default
  }
  assert.equal(candleQuerySchema.safeParse({ ...base, from: 2000, to: 2000 }).success, false); // from >= to
  assert.equal(candleQuerySchema.safeParse({ ...base, from: 3000, to: 2000 }).success, false);
  assert.equal(candleQuerySchema.safeParse({ ...base, limit: MAX_CANDLES_PER_REQUEST + 1 }).success, false);
  assert.equal(candleQuerySchema.safeParse({ ...base, timeframe: '2d' }).success, false);
  assert.equal(candleQuerySchema.safeParse({ ...base, assetClass: 'fx' }).success, false);
  assert.equal(candleQuerySchema.safeParse({ ...base, bogus: 1 }).success, false); // strict
  // query-string coercion (numbers arrive as strings over HTTP)
  const coerced = candleQuerySchema.safeParse({ ...base, from: '1000', to: '2000', limit: '100' });
  assert.equal(coerced.success, true);
});

test('ingestion: candle DTO enforces the OHLC invariant', () => {
  const good = { time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: null };
  assert.equal(candleDtoSchema.safeParse(good).success, true);
  assert.equal(candleDtoSchema.safeParse({ ...good, volume: 12.5 }).success, true);
  assert.equal(candleDtoSchema.safeParse({ ...good, low: 5 }).success, false); // low > open/close
  assert.equal(candleDtoSchema.safeParse({ ...good, high: 0.1 }).success, false);
  assert.equal(candleDtoSchema.safeParse({ ...good, open: -1 }).success, false);
  assert.equal(candleDtoSchema.safeParse({ ...good, volume: -2 }).success, false);
  assert.equal(candleDtoSchema.safeParse({ ...good, time: 1.5 }).success, false);
});

test('ingestion: backfill request is bounded and deduped', () => {
  const inst = { assetClass: 'forex', symbol: 'EURUSD' };
  const base = { instruments: [inst], timeframes: ['1d'], from: 1000, to: 2000 };
  assert.equal(backfillRequestSchema.safeParse(base).success, true);
  assert.equal(backfillRequestSchema.safeParse({ ...base, instruments: [] }).success, false);
  assert.equal(
    backfillRequestSchema.safeParse({ ...base, instruments: [inst, inst] }).success,
    false,
    'duplicate instruments rejected',
  );
  assert.equal(
    backfillRequestSchema.safeParse({ ...base, timeframes: ['1d', '1d'] }).success,
    false,
    'duplicate timeframes rejected',
  );
  assert.equal(backfillRequestSchema.safeParse({ ...base, from: 2000, to: 1000 }).success, false);
  const tooMany = { ...base, instruments: Array.from({ length: MAX_BACKFILL_INSTRUMENTS + 1 }, (_, i) => ({ ...inst, symbol: `S${i}` })) };
  assert.equal(backfillRequestSchema.safeParse(tooMany).success, false);
  assert.ok(MAX_BACKFILL_CANDLES > 0);
});

test('ingestion: coverage DTO shape', () => {
  const row = {
    assetClass: 'crypto',
    symbol: 'btcusd',
    displayName: null,
    timeframe: '1h',
    candleCount: 10,
    earliestTime: 1000,
    latestTime: 2000,
  };
  const parsed = coverageDtoSchema.safeParse(row);
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.symbol, 'BTCUSD');
  assert.equal(coverageDtoSchema.safeParse({ ...row, candleCount: -1 }).success, false);
});

test('market-data: ProviderError kinds + error code registry', () => {
  assert.equal(ERROR_CODES.PROVIDER_UNAVAILABLE, 'provider_unavailable');
  for (const kind of ['unavailable', 'rate_limited', 'invalid_request', 'not_found', 'unauthorized'] as const) {
    const err = new ProviderError(kind, 'msg');
    assert.equal(err.kind, kind);
    assert.ok(isProviderError(err));
  }
  assert.equal(isProviderError(new Error('x')), false);
});
