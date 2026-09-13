import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TIMEFRAMES, isProviderError, type AssetClass, type Timeframe } from '@veltrixeye/contracts';
import {
  NATIVE_INTERVALS,
  RESAMPLE_PLANS,
  intervalPlan,
  toTwelveSymbol,
  fromTwelveSymbol,
} from '../src/symbols.js';

test('symbols: normalized instruments map to documented vendor symbols', () => {
  const cases: Array<[AssetClass, string, string]> = [
    ['forex', 'EURUSD', 'EUR/USD'],
    ['forex', 'gbpusd', 'GBP/USD'],
    ['forex', 'USDJPY', 'USD/JPY'],
    ['commodity', 'XAUUSD', 'XAU/USD'],
    ['crypto', 'BTCUSD', 'BTC/USD'],
    ['crypto', 'ethusd', 'ETH/USD'],
    ['stock', 'AAPL', 'AAPL'],
    ['etf', 'SPY', 'SPY'],
  ];
  for (const [assetClass, symbol, expected] of cases) {
    assert.equal(toTwelveSymbol(assetClass, symbol), expected, symbol);
  }
});

test('symbols: slash-carrying symbols pass through; empty and unmappable throw', () => {
  assert.equal(toTwelveSymbol('forex', 'EUR/USD'), 'EUR/USD');
  assert.throws(() => toTwelveSymbol('forex', '   '), (e: unknown) => isProviderError(e));
  assert.throws(() => toTwelveSymbol('forex', 'NOPE'), (e: unknown) => isProviderError(e));
  assert.throws(() => toTwelveSymbol('forex', 'GBP'), (e: unknown) => isProviderError(e));
});

test('symbols: round-trip normalization strips the slash', () => {
  assert.equal(fromTwelveSymbol('EUR/USD'), 'EURUSD');
  assert.equal(fromTwelveSymbol('BTC/USD'), 'BTCUSD');
  assert.equal(fromTwelveSymbol('AAPL'), 'AAPL');
});

test('symbols: every canonical timeframe is native xor resampled', () => {
  for (const tf of TIMEFRAMES) {
    const native = NATIVE_INTERVALS[tf];
    const plan = RESAMPLE_PLANS[tf];
    assert.ok(Boolean(native) !== Boolean(plan), `${tf}: native xor resample`);
    const resolved = intervalPlan(tf);
    if (native !== undefined) {
      assert.deepEqual(resolved, { kind: 'native', interval: native });
    } else {
      assert.equal(resolved.kind, 'resample');
    }
  }
});

test('symbols: resample plans cover exactly 3m/12h/3d with documented sources', () => {
  assert.deepEqual(Object.keys(RESAMPLE_PLANS).sort(), ['12h', '3d', '3m']);
  assert.deepEqual(RESAMPLE_PLANS['3m'], { source: '1m', factor: 3 });
  assert.deepEqual(RESAMPLE_PLANS['12h'], { source: '1h', factor: 12 });
  assert.deepEqual(RESAMPLE_PLANS['3d'], { source: '1d', factor: 3 });
  assert.deepEqual(intervalPlan('3m'), { kind: 'resample', interval: '1min', source: '1m', factor: 3 });
  assert.deepEqual(intervalPlan('1M'), { kind: 'native', interval: '1month' });
});

test('symbols: unknown timeframe throws a ProviderError', () => {
  assert.throws(() => intervalPlan('2d' as Timeframe), (e: unknown) => isProviderError(e));
});
