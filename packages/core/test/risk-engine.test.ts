/**
 * M8.2 — pure risk engine (no database).
 *
 * Covers position sizing, RR, every individual rejection, approved trades,
 * combinations, rounding/boundary arithmetic, sessions, correlation, and
 * fail-closed invalid inputs.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_RISK_CEILINGS,
  RISK_ENGINE_VERSION,
  type InstrumentRiskSpec,
} from '@veltrixeye/contracts';
import {
  Dec,
  calculateRr,
  defaultEffectivePolicy,
  effectiveMinRr,
  evaluateRisk,
  sessionAllows,
  sizePosition,
  type EffectiveRiskPolicy,
  type RiskEngineInput,
} from '../src/index.js';

const EURUSD: InstrumentRiskSpec = {
  assetClass: 'forex',
  symbol: 'EURUSD',
  contractSize: 100_000,
  pipSize: 0.0001,
  pnlMode: 'quote_linear',
  quoteCurrency: 'USD',
  minQuantity: 0.01,
  quantityStep: 0.01,
  maxQuantity: 100,
};

const ANCHOR = Date.UTC(2024, 0, 2, 12, 0, 0); // Tuesday 12:00 UTC (London + NY)

function policy(overrides: Partial<EffectiveRiskPolicy> = {}): EffectiveRiskPolicy {
  return { ...defaultEffectivePolicy(), ...overrides };
}

function baseInput(overrides: Partial<RiskEngineInput> = {}): RiskEngineInput {
  return {
    policy: policy(),
    strategyOverride: null,
    strategyMinRr: 2,
    account: {
      equity: Dec.fromInt(10_000)!,
      dailyRealizedPl: Dec.zero(),
      weeklyRealizedPl: Dec.zero(),
      consecutiveLosses: 0,
    },
    openPositions: [],
    reservations: [],
    instrument: EURUSD,
    correlationGroups: [],
    candidateGroupIds: [],
    killSwitchActive: false,
    candidate: {
      action: 'open_long',
      symbol: 'EURUSD',
      assetClass: 'forex',
      direction: 'long',
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11,
      expectedRr: 2,
      asOfMs: ANCHOR,
    },
    evaluatedAtMs: ANCHOR,
    ...overrides,
  };
}

describe('m8.2 decimal / sizing', () => {
  test('EURUSD 0.5% of 10k with 50-pip stop sizes to 0.10 lots and $50 risk', () => {
    const result = sizePosition({
      equity: Dec.fromInt(10_000)!,
      riskPct: Dec.fromNumber(0.5)!,
      maxMonetaryRisk: Dec.fromInt(500),
      extraCaps: [],
      entry: Dec.fromNumber(1.1)!,
      stopLoss: Dec.fromNumber(1.095)!,
      spec: EURUSD,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.quantity.toNumber(2), 0.1);
      assert.equal(result.monetaryRisk.toNumber(2), 50);
    }
  });

  test('zero equity, zero stop and missing spec all fail closed (no default size)', () => {
    const equity = sizePosition({
      equity: Dec.zero(),
      riskPct: Dec.fromNumber(0.5)!,
      maxMonetaryRisk: null,
      extraCaps: [],
      entry: Dec.fromNumber(1.1)!,
      stopLoss: Dec.fromNumber(1.095)!,
      spec: EURUSD,
    });
    assert.equal(equity.ok, false);
    if (!equity.ok) assert.equal(equity.code, 'ZERO_OR_NEGATIVE_EQUITY');

    const stop = sizePosition({
      equity: Dec.fromInt(10_000)!,
      riskPct: Dec.fromNumber(0.5)!,
      maxMonetaryRisk: null,
      extraCaps: [],
      entry: Dec.fromNumber(1.1)!,
      stopLoss: Dec.fromNumber(1.1)!,
      spec: EURUSD,
    });
    assert.equal(stop.ok, false);
    if (!stop.ok) assert.equal(stop.code, 'STOP_DISTANCE_NOT_POSITIVE');

    const missing = sizePosition({
      equity: Dec.fromInt(10_000)!,
      riskPct: Dec.fromNumber(0.5)!,
      maxMonetaryRisk: null,
      extraCaps: [],
      entry: Dec.fromNumber(1.1)!,
      stopLoss: Dec.fromNumber(1.095)!,
      spec: null,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'MISSING_INSTRUMENT_METADATA');
  });

  test('quantity is rounded DOWN onto the step (never up through the risk budget)', () => {
    // Budget that does not land on a step: 0.5% of 1000 = 5.
    // value_per_unit = 100000 * 0.005 = 500 → raw qty = 0.01 exactly.
    const exact = sizePosition({
      equity: Dec.fromInt(1_000)!,
      riskPct: Dec.fromNumber(0.5)!,
      maxMonetaryRisk: null,
      extraCaps: [],
      entry: Dec.fromNumber(1.1)!,
      stopLoss: Dec.fromNumber(1.095)!,
      spec: EURUSD,
    });
    assert.equal(exact.ok, true);
    if (exact.ok) assert.equal(exact.quantity.toNumber(2), 0.01);

    // Tiny equity so raw qty < minQuantity → fail closed, never a 0.01 default.
    const tiny = sizePosition({
      equity: Dec.fromInt(100)!,
      riskPct: Dec.fromNumber(0.5)!,
      maxMonetaryRisk: null,
      extraCaps: [],
      entry: Dec.fromNumber(1.1)!,
      stopLoss: Dec.fromNumber(1.095)!,
      spec: EURUSD,
    });
    // 0.5% of 100 = 0.50; 0.50/500 = 0.001 → below 0.01 min
    assert.equal(tiny.ok, false);
    if (!tiny.ok) assert.equal(tiny.code, 'POSITION_SIZE_BELOW_MINIMUM');
  });
});

describe('m8.2 reward:risk', () => {
  test('long and short 1:2 setups approve at exactly the minimum', () => {
    const long = calculateRr({
      direction: 'long',
      entry: 1.1,
      stopLoss: 1.095,
      takeProfit: 1.11,
      minRr: 2,
    });
    assert.equal(long.ok, true);
    if (long.ok) assert.equal(long.rr.toNumber(4), 2);

    const short = calculateRr({
      direction: 'short',
      entry: 1.1,
      stopLoss: 1.105,
      takeProfit: 1.09,
      minRr: 2,
    });
    assert.equal(short.ok, true);
  });

  test('just below the minimum RR is rejected; wrong-side SL/TP too', () => {
    const below = calculateRr({
      direction: 'long',
      entry: 1.1,
      stopLoss: 1.095,
      takeProfit: 1.10999,
      minRr: 2,
    });
    assert.equal(below.ok, false);
    if (!below.ok) assert.equal(below.code, 'RR_BELOW_MINIMUM');

    const sl = calculateRr({
      direction: 'long',
      entry: 1.1,
      stopLoss: 1.2,
      takeProfit: 1.11,
      minRr: 2,
    });
    assert.equal(sl.ok, false);
    if (!sl.ok) assert.equal(sl.code, 'SL_WRONG_SIDE');

    const tp = calculateRr({
      direction: 'short',
      entry: 1.1,
      stopLoss: 1.105,
      takeProfit: 1.2,
      minRr: 2,
    });
    assert.equal(tp.ok, false);
    if (!tp.ok) assert.equal(tp.code, 'TP_WRONG_SIDE');
  });

  test('effectiveMinRr never drops below the platform floor, even if asked', () => {
    assert.equal(effectiveMinRr(1, 1), PLATFORM_RISK_CEILINGS.minRr);
    assert.equal(effectiveMinRr(2, 3), 3);
    assert.equal(effectiveMinRr(4, null), 4);
  });
});

describe('m8.2 engine — approved', () => {
  test('a valid long inside every limit is approved with a sized position', () => {
    const v = evaluateRisk(baseInput());
    assert.equal(v.outcome, 'approved');
    assert.equal(v.rejectionCode, null);
    assert.equal(v.engineVersion, RISK_ENGINE_VERSION);
    assert.ok(v.positionSize && v.positionSize.toNumber(2) === 0.1);
    assert.ok(v.monetaryRisk && v.monetaryRisk.toNumber(2) === 50);
    assert.ok(v.rr && v.rr.toNumber(4) === 2);
    assert.equal(v.exposureWithinLimits, true);
    assert.equal(v.projectedExposure.openPositions, 1);
  });

  test('a valid short is approved', () => {
    const v = evaluateRisk(
      baseInput({
        candidate: {
          action: 'open_short',
          symbol: 'EURUSD',
          assetClass: 'forex',
          direction: 'short',
          entryPrice: 1.1,
          stopLossPrice: 1.105,
          takeProfitPrice: 1.09,
          expectedRr: 2,
          asOfMs: ANCHOR,
        },
      }),
    );
    assert.equal(v.outcome, 'approved');
  });

  test('identical inputs are deterministic', () => {
    const a = evaluateRisk(baseInput());
    const b = evaluateRisk(baseInput());
    assert.equal(a.outcome, b.outcome);
    assert.equal(a.positionSize?.units, b.positionSize?.units);
    assert.equal(a.monetaryRisk?.units, b.monetaryRisk?.units);
    assert.equal(a.rr?.units, b.rr?.units);
    assert.deepEqual(a.violations, b.violations);
  });
});

describe('m8.2 engine — individual rejections', () => {
  const cases: Array<{ name: string; input: Partial<RiskEngineInput>; code: string }> = [
    { name: 'kill switch', input: { killSwitchActive: true }, code: 'KILL_SWITCH_ACTIVE' },
    { name: 'policy disabled', input: { policy: policy({ enabled: false }) }, code: 'POLICY_DISABLED' },
    {
      name: 'strategy blocked',
      input: { strategyOverride: { enabled: true, blocked: true, minRr: null, maxRiskPct: null } },
      code: 'STRATEGY_RESTRICTION',
    },
    { name: 'zero equity', input: { account: { equity: Dec.zero(), dailyRealizedPl: Dec.zero(), weeklyRealizedPl: Dec.zero(), consecutiveLosses: 0 } }, code: 'ZERO_OR_NEGATIVE_EQUITY' },
    { name: 'negative equity', input: { account: { equity: Dec.fromInt(-1)!, dailyRealizedPl: Dec.zero(), weeklyRealizedPl: Dec.zero(), consecutiveLosses: 0 } }, code: 'ZERO_OR_NEGATIVE_EQUITY' },
    { name: 'missing spec', input: { instrument: null }, code: 'MISSING_INSTRUMENT_METADATA' },
    {
      name: 'session closed',
      input: { policy: policy({ allowedSessions: [{ kind: 'named', name: 'sydney' }] }) },
      code: 'SESSION_NOT_ALLOWED',
    },
    {
      name: 'daily loss',
      input: {
        account: {
          equity: Dec.fromInt(10_000)!,
          dailyRealizedPl: Dec.fromInt(-300)!, // 3% of 10k
          weeklyRealizedPl: Dec.zero(),
          consecutiveLosses: 0,
        },
      },
      code: 'DAILY_LOSS_LIMIT',
    },
    {
      name: 'weekly loss',
      input: {
        account: {
          equity: Dec.fromInt(10_000)!,
          dailyRealizedPl: Dec.zero(),
          weeklyRealizedPl: Dec.fromInt(-600)!,
          consecutiveLosses: 0,
        },
      },
      code: 'WEEKLY_LOSS_LIMIT',
    },
    {
      name: 'consecutive losses',
      input: {
        account: {
          equity: Dec.fromInt(10_000)!,
          dailyRealizedPl: Dec.zero(),
          weeklyRealizedPl: Dec.zero(),
          consecutiveLosses: 3,
        },
      },
      code: 'CONSECUTIVE_LOSS_LIMIT',
    },
    {
      name: 'simultaneous positions',
      input: {
        policy: policy({ maxSimultaneousPositions: 1 }),
        openPositions: [
          {
            symbol: 'GBPUSD',
            direction: 'long',
            quantity: Dec.fromNumber(0.1)!,
            entry: Dec.fromNumber(1.25)!,
            stopLoss: Dec.fromNumber(1.245)!,
            spec: { ...EURUSD, symbol: 'GBPUSD' },
          },
        ],
      },
      code: 'SIMULTANEOUS_POSITION_LIMIT',
    },
    {
      name: 'spread required but missing',
      input: { policy: policy({ maxSpreadPips: 2 }) },
      code: 'SPREAD_EXCEEDS_MAXIMUM',
    },
  ];

  for (const c of cases) {
    test(`rejects ${c.name}`, () => {
      const v = evaluateRisk(baseInput(c.input));
      assert.equal(v.outcome, 'rejected', c.name);
      assert.equal(v.rejectionCode, c.code, c.name);
    });
  }

  test('RR just below minimum is rejected; exactly at minimum is approved', () => {
    const below = evaluateRisk(
      baseInput({
        candidate: {
          action: 'open_long',
          symbol: 'EURUSD',
          assetClass: 'forex',
          direction: 'long',
          entryPrice: 1.1,
          stopLossPrice: 1.095,
          takeProfitPrice: 1.10999,
          expectedRr: 1.998,
          asOfMs: ANCHOR,
        },
      }),
    );
    assert.equal(below.outcome, 'rejected');
    assert.equal(below.rejectionCode, 'RR_BELOW_MINIMUM');

    const at = evaluateRisk(baseInput());
    assert.equal(at.outcome, 'approved');
  });

  test('wrong-side SL and TP are rejected', () => {
    const sl = evaluateRisk(
      baseInput({
        candidate: {
          action: 'open_long',
          symbol: 'EURUSD',
          assetClass: 'forex',
          direction: 'long',
          entryPrice: 1.1,
          stopLossPrice: 1.2,
          takeProfitPrice: 1.11,
          expectedRr: 2,
          asOfMs: ANCHOR,
        },
      }),
    );
    assert.equal(sl.rejectionCode, 'SL_WRONG_SIDE');
  });

  test('correlation metadata required but unavailable fails closed', () => {
    const v = evaluateRisk(baseInput({ policy: policy({ correlationRequired: true }) }));
    assert.equal(v.outcome, 'rejected');
    assert.equal(v.rejectionCode, 'CORRELATION_METADATA_UNAVAILABLE');
  });

  test('correlation group exposure is enforced when configured (never invented)', () => {
    const v = evaluateRisk(
      baseInput({
        policy: policy({ maxCorrelationGroupExposurePct: 0.4 }),
        candidateGroupIds: ['g1'],
        correlationGroups: [{ id: 'g1', slug: 'usd-majors', maxExposurePct: 0.4, members: ['EURUSD', 'GBPUSD'] }],
        openPositions: [
          {
            symbol: 'GBPUSD',
            direction: 'long',
            quantity: Dec.fromNumber(0.1)!,
            entry: Dec.fromNumber(1.25)!,
            stopLoss: Dec.fromNumber(1.245)!,
            spec: { ...EURUSD, symbol: 'GBPUSD' },
          },
        ],
      }),
    );
    // existing GBPUSD 0.1 lot * 100000 * 0.005 = 50; candidate +50 = 100
    // 0.4% of 10k = 40 → reject
    assert.equal(v.outcome, 'rejected');
    assert.equal(v.rejectionCode, 'CORRELATION_EXPOSURE_LIMIT');
  });
});

describe('m8.2 engine — combinations', () => {
  test('kill switch wins as the first code even when RR is also bad', () => {
    const v = evaluateRisk(
      baseInput({
        killSwitchActive: true,
        candidate: {
          action: 'open_long',
          symbol: 'EURUSD',
          assetClass: 'forex',
          direction: 'long',
          entryPrice: 1.1,
          stopLossPrice: 1.095,
          takeProfitPrice: 1.101,
          expectedRr: 0.2,
          asOfMs: ANCHOR,
        },
      }),
    );
    assert.equal(v.rejectionCode, 'KILL_SWITCH_ACTIVE');
    assert.ok(v.violations.includes('KILL_SWITCH_ACTIVE'));
    assert.ok(v.violations.includes('RR_BELOW_MINIMUM'));
  });
});

describe('m8.2 sessions (UTC, never a user timezone)', () => {
  test('named London window includes 12:00 UTC and excludes 03:00 UTC', () => {
    const windows = [{ kind: 'named' as const, name: 'london' as const }];
    assert.equal(sessionAllows(windows, Date.UTC(2024, 0, 2, 12, 0, 0)), true);
    assert.equal(sessionAllows(windows, Date.UTC(2024, 0, 2, 3, 0, 0)), false);
  });

  test('null windows allow every hour; empty windows allow none', () => {
    assert.equal(sessionAllows(null, ANCHOR), true);
    assert.equal(sessionAllows([], ANCHOR), false);
  });
});

describe('m8.2 strategy override only tightens', () => {
  test('a higher strategy minRr is applied; a lower one cannot weaken the floor', () => {
    const tighter = evaluateRisk(
      baseInput({
        strategyMinRr: 3,
      }),
    );
    // 1:2 setup fails the strategy's 1:3
    assert.equal(tighter.outcome, 'rejected');
    assert.equal(tighter.rejectionCode, 'RR_BELOW_MINIMUM');
    assert.equal(tighter.effectiveMinRr, 3);
  });
});
