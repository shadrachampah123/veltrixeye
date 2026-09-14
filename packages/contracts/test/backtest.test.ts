import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKTEST_ENGINE_VERSION,
  DEFAULT_BACKTESTS_LIMIT,
  DEFAULT_MAX_HOLD_CANDLES,
  MAX_BACKTESTS_LIMIT,
  MAX_BACKTEST_INSTRUMENTS_PER_CALL,
  MAX_BACKTEST_STEPS,
  MAX_BACKTEST_TRADES,
  backtestCostPolicySchema,
  backtestExitPolicySchema,
  backtestListQuerySchema,
  backtestMetricsSchema,
  backtestRequestSchema,
  backtestRunDetailDtoSchema,
  backtestRunDtoSchema,
  backtestTradeDtoSchema,
} from '../src/index.js';

const INSTRUMENT = { assetClass: 'forex', symbol: 'EURUSD' } as const;
const FROM = 1_800_000_000_000;
const TO = FROM + 24 * 3_600_000;

function validTrade(overrides: Record<string, unknown> = {}) {
  return {
    seq: 0,
    direction: 'long',
    signalAsOfMs: FROM,
    entryPrice: 1.1,
    stopLossPrice: 1.099,
    tp1Price: 1.101,
    tp2Price: 1.102,
    tp3Price: 1.103,
    qualityScore: 75,
    qualityGrade: 'B',
    exitReason: 'take_profit_1',
    exitPrice: 1.101,
    exitAsOfMs: FROM + 3_600_000,
    pnlR: 1,
    pnlCurrency: null,
    ...overrides,
  };
}

function validMetrics(overrides: Record<string, unknown> = {}) {
  return {
    stepsEvaluated: 10,
    setupsDetected: 2,
    tradesClosed: 2,
    wins: 1,
    losses: 1,
    winRate: 0.5,
    expectancyR: 0.5,
    profitFactor: 2,
    maxDrawdownR: 1,
    avgWinR: 2,
    avgLossR: -1,
    totalR: 1,
    totalCurrency: null,
    ...overrides,
  };
}

function validRun(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    strategyId: '22222222-2222-4222-8222-222222222222',
    strategyVersionId: '33333333-3333-4333-8333-333333333333',
    versionNumber: 1,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'both',
    engineVersion: BACKTEST_ENGINE_VERSION,
    fromMs: FROM,
    toMs: TO,
    exitPolicy: {},
    costPolicy: {},
    configHash: 'a'.repeat(64),
    status: 'completed',
    metrics: validMetrics(),
    notes: [],
    createdAt: new Date(FROM).toISOString(),
    ...overrides,
  };
}

describe('m6 backtest contracts', () => {
  test('engine identity and bounds are pinned', () => {
    assert.equal(BACKTEST_ENGINE_VERSION, 'm6-backtest-1');
    assert.equal(MAX_BACKTEST_STEPS, 2000);
    assert.equal(MAX_BACKTEST_INSTRUMENTS_PER_CALL, 1);
    assert.equal(DEFAULT_MAX_HOLD_CANDLES, 100);
    assert.equal(MAX_BACKTEST_TRADES, 500);
    assert.equal(DEFAULT_BACKTESTS_LIMIT, 50);
    assert.equal(MAX_BACKTESTS_LIMIT, 100);
  });

  test('exit policy defaults to level stops, tp3 targets, 100-candle hold', () => {
    const parsed = backtestExitPolicySchema.parse({});
    assert.deepEqual(parsed, {
      stopLoss: 'level',
      takeProfit: 'tp3',
      maxHoldCandles: 100,
      sameCandleRule: 'stop_first',
      entryTiming: 'signal_close',
    });
  });

  test('exit policy accepts every stop/target combination', () => {
    for (const stopLoss of ['level', 'none'] as const) {
      for (const takeProfit of ['tp1', 'tp2', 'tp3', 'none'] as const) {
        const parsed = backtestExitPolicySchema.parse({ stopLoss, takeProfit });
        assert.equal(parsed.stopLoss, stopLoss);
        assert.equal(parsed.takeProfit, takeProfit);
      }
    }
    assert.equal(backtestExitPolicySchema.parse({ maxHoldCandles: 1 }).maxHoldCandles, 1);
    assert.equal(backtestExitPolicySchema.parse({ maxHoldCandles: 5000 }).maxHoldCandles, 5000);
  });

  test('exit policy rejects unknown rules, out-of-range holds and unknown keys', () => {
    assert.equal(backtestExitPolicySchema.safeParse({ stopLoss: 'trailing' }).success, false);
    assert.equal(backtestExitPolicySchema.safeParse({ takeProfit: 'tp4' }).success, false);
    assert.equal(backtestExitPolicySchema.safeParse({ maxHoldCandles: 0 }).success, false);
    assert.equal(backtestExitPolicySchema.safeParse({ maxHoldCandles: 5001 }).success, false);
    assert.equal(backtestExitPolicySchema.safeParse({ maxHoldCandles: 1.5 }).success, false);
    // The pinned literals are not configurable.
    assert.equal(backtestExitPolicySchema.safeParse({ sameCandleRule: 'tp_first' }).success, false);
    assert.equal(backtestExitPolicySchema.safeParse({ entryTiming: 'next_open' }).success, false);
    assert.equal(backtestExitPolicySchema.safeParse({ stopLoss: 'level', extra: 1 }).success, false);
  });

  test('cost policy defaults to frictionless; riskPerTrade is optional', () => {
    assert.deepEqual(backtestCostPolicySchema.parse({}), {
      feePerSide: 0,
      slippagePerSide: 0,
      spread: 0,
    });
    const withRisk = backtestCostPolicySchema.parse({ feePerSide: 0.5, riskPerTrade: 100 });
    assert.equal(withRisk.feePerSide, 0.5);
    assert.equal(withRisk.riskPerTrade, 100);
  });

  test('cost policy rejects negative costs, non-positive risk and unknown keys', () => {
    assert.equal(backtestCostPolicySchema.safeParse({ feePerSide: -0.1 }).success, false);
    assert.equal(backtestCostPolicySchema.safeParse({ slippagePerSide: -1 }).success, false);
    assert.equal(backtestCostPolicySchema.safeParse({ spread: -1 }).success, false);
    assert.equal(backtestCostPolicySchema.safeParse({ feePerSide: Number.NaN }).success, false);
    assert.equal(backtestCostPolicySchema.safeParse({ feePerSide: Number.POSITIVE_INFINITY }).success, false);
    assert.equal(backtestCostPolicySchema.safeParse({ riskPerTrade: 0 }).success, false);
    assert.equal(backtestCostPolicySchema.safeParse({ riskPerTrade: -5 }).success, false);
    assert.equal(backtestCostPolicySchema.safeParse({ feePerSide: 1, rebate: 2 }).success, false);
  });

  test('backtest request applies direction + policy defaults and normalizes the symbol', () => {
    const parsed = backtestRequestSchema.parse({ instrument: { assetClass: 'forex', symbol: 'eurusd' }, from: FROM, to: TO });
    assert.equal(parsed.direction, 'both');
    assert.equal(parsed.instrument.symbol, 'EURUSD');
    assert.equal(parsed.exitPolicy.stopLoss, 'level');
    assert.equal(parsed.costPolicy.feePerSide, 0);
  });

  test('backtest request rejects invalid ranges, directions and unknown keys', () => {
    assert.equal(backtestRequestSchema.safeParse({ instrument: INSTRUMENT, from: TO, to: TO }).success, false);
    assert.equal(backtestRequestSchema.safeParse({ instrument: INSTRUMENT, from: TO, to: FROM }).success, false);
    assert.equal(backtestRequestSchema.safeParse({ instrument: INSTRUMENT, from: -1, to: TO }).success, false);
    assert.equal(backtestRequestSchema.safeParse({ instrument: INSTRUMENT, from: 1.5, to: TO }).success, false);
    assert.equal(
      backtestRequestSchema.safeParse({ instrument: INSTRUMENT, direction: 'sideways', from: FROM, to: TO }).success,
      false,
    );
    assert.equal(
      backtestRequestSchema.safeParse({ instrument: { assetClass: 'nope', symbol: 'X' }, from: FROM, to: TO }).success,
      false,
    );
    assert.equal(
      backtestRequestSchema.safeParse({ instrument: INSTRUMENT, from: FROM, to: TO, leverage: 10 }).success,
      false,
    );
  });

  test('trade DTO accepts every exit reason and enforces the no_levels/closed shape', () => {
    for (const exitReason of [
      'stop_loss',
      'take_profit_1',
      'take_profit_2',
      'take_profit_3',
      'max_hold',
      'range_end',
    ] as const) {
      assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ exitReason })).success, true);
    }
    const noLevels = validTrade({
      exitReason: 'no_levels',
      entryPrice: null,
      stopLossPrice: null,
      exitPrice: null,
      exitAsOfMs: null,
      pnlR: null,
    });
    assert.equal(backtestTradeDtoSchema.safeParse(noLevels).success, true);
    // A no_levels trade must not carry exit/P&L.
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ exitReason: 'no_levels' })).success, false);
    // A closed trade must carry exit/P&L.
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ pnlR: null })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ exitPrice: null })).success, false);
  });

  test('trade DTO rejects bad enums, bounds, non-finite P&L and unknown keys', () => {
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ direction: 'both' })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ exitReason: 'expired' })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ seq: -1 })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ qualityScore: 101 })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ qualityGrade: 'D' })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ pnlR: Number.NaN })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ pnlR: Number.POSITIVE_INFINITY })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse(validTrade({ entryPrice: 0 })).success, false);
    assert.equal(backtestTradeDtoSchema.safeParse({ ...validTrade(), trailing: true }).success, false);
  });

  test('metrics DTO accepts full and empty runs and enforces bounds', () => {
    assert.equal(backtestMetricsSchema.safeParse(validMetrics()).success, true);
    assert.equal(
      backtestMetricsSchema.safeParse(
        validMetrics({
          stepsEvaluated: 0,
          setupsDetected: 0,
          tradesClosed: 0,
          wins: 0,
          losses: 0,
          winRate: null,
          expectancyR: null,
          profitFactor: null,
          maxDrawdownR: null,
          avgWinR: null,
          avgLossR: null,
          totalR: 0,
        }),
      ).success,
      true,
    );
    assert.equal(backtestMetricsSchema.safeParse(validMetrics({ winRate: 2 })).success, false);
    assert.equal(backtestMetricsSchema.safeParse(validMetrics({ winRate: -0.1 })).success, false);
    assert.equal(backtestMetricsSchema.safeParse(validMetrics({ profitFactor: 0 })).success, true); // all-loss runs
    assert.equal(backtestMetricsSchema.safeParse(validMetrics({ profitFactor: -1 })).success, false);
    assert.equal(backtestMetricsSchema.safeParse(validMetrics({ maxDrawdownR: -1 })).success, false);
    assert.equal(backtestMetricsSchema.safeParse(validMetrics({ stepsEvaluated: -1 })).success, false);
    assert.equal(backtestMetricsSchema.safeParse({ ...validMetrics(), sharpe: 1 }).success, false);
  });

  test('run DTO requires a sha256 config hash and a known status', () => {
    assert.equal(backtestRunDtoSchema.safeParse(validRun()).success, true);
    assert.equal(backtestRunDtoSchema.safeParse(validRun({ status: 'failed' })).success, true);
    assert.equal(backtestRunDtoSchema.safeParse(validRun({ configHash: 'abc' })).success, false);
    assert.equal(backtestRunDtoSchema.safeParse(validRun({ configHash: 'Z'.repeat(64) })).success, false);
    assert.equal(backtestRunDtoSchema.safeParse(validRun({ status: 'running' })).success, false);
    assert.equal(backtestRunDtoSchema.safeParse(validRun({ direction: 'long' })).success, true);
    assert.equal(backtestRunDtoSchema.safeParse({ ...validRun(), accountSize: 1 }).success, false);
  });

  test('run detail caps trades at MAX_BACKTEST_TRADES and requires the truncation flag', () => {
    const one = backtestRunDetailDtoSchema.safeParse({ run: validRun(), trades: [validTrade()], truncated: false });
    assert.equal(one.success, true);
    const many = Array.from({ length: MAX_BACKTEST_TRADES + 1 }, (_, seq) => validTrade({ seq }));
    assert.equal(backtestRunDetailDtoSchema.safeParse({ run: validRun(), trades: many, truncated: true }).success, false);
    assert.equal(backtestRunDetailDtoSchema.safeParse({ run: validRun(), trades: [] }).success, false);
  });

  test('list query defaults, coerces and bounds the limit', () => {
    assert.deepEqual(backtestListQuerySchema.parse({}), {
      limit: 50,
    });
    assert.equal(backtestListQuerySchema.parse({ limit: '10' }).limit, 10);
    assert.equal(backtestListQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(backtestListQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(backtestListQuerySchema.safeParse({ strategyId: 'not-a-uuid' }).success, false);
    assert.equal(backtestListQuerySchema.safeParse({ limit: 10, verbose: true }).success, false);
  });
});
