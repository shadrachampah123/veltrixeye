import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MIN_RR,
  DEFAULT_RISK_POLICY,
  PLATFORM_RISK_CEILINGS,
  RISK_ENGINE_VERSION,
  RISK_REJECTION_CODES,
  RISK_RESERVATION_TTL_MS,
  isRiskRejectionCode,
  platformCeilingsDto,
  riskDecisionDtoSchema,
  riskPolicyUpdateSchema,
  riskSessionWindowSchema,
} from '../src/index.js';

describe('m8.2 risk engine constants', () => {
  test('engine version is pinned', () => {
    assert.equal(RISK_ENGINE_VERSION, 'm8.2-risk-engine-1');
  });

  test('reservation TTL is a pinned safety constant (not an env var)', () => {
    assert.equal(RISK_RESERVATION_TTL_MS, 60_000);
  });

  test('platform ceilings are the hard envelope (min RR 1:2, 1% per trade)', () => {
    assert.equal(PLATFORM_RISK_CEILINGS.minRr, DEFAULT_MIN_RR);
    assert.equal(PLATFORM_RISK_CEILINGS.minRr, 2);
    assert.equal(PLATFORM_RISK_CEILINGS.maxRiskPctPerTrade, 1);
    assert.equal(PLATFORM_RISK_CEILINGS.maxDailyLossPct, 5);
    assert.equal(PLATFORM_RISK_CEILINGS.maxWeeklyLossPct, 10);
    assert.equal(PLATFORM_RISK_CEILINGS.maxSimultaneousPositions, 5);
    assert.equal(PLATFORM_RISK_CEILINGS.maxPositionSize, 100);
    assert.ok(DEFAULT_RISK_POLICY.riskPctPerTrade <= PLATFORM_RISK_CEILINGS.maxRiskPctPerTrade);
    assert.ok(DEFAULT_RISK_POLICY.minRr >= PLATFORM_RISK_CEILINGS.minRr);
  });

  test('rejection codes are pinned and complete', () => {
    assert.equal(RISK_REJECTION_CODES[0], 'KILL_SWITCH_ACTIVE');
    assert.ok(RISK_REJECTION_CODES.includes('RR_BELOW_MINIMUM'));
    assert.ok(RISK_REJECTION_CODES.includes('DAILY_LOSS_LIMIT'));
    assert.ok(RISK_REJECTION_CODES.includes('CORRELATION_EXPOSURE_LIMIT'));
    assert.equal(isRiskRejectionCode('RR_BELOW_MINIMUM'), true);
    assert.equal(isRiskRejectionCode('approved'), false);
    assert.equal(isRiskRejectionCode('YES'), false);
  });

  test('platformCeilingsDto is a frozen-shape copy of the constants', () => {
    const dto = platformCeilingsDto();
    assert.equal(dto.maxRiskPctPerTrade, 1);
    assert.equal(dto.minRr, 2);
  });
});

describe('m8.2 risk policy update schema (cannot weaken ceilings)', () => {
  test('a value inside the envelope parses', () => {
    const parsed = riskPolicyUpdateSchema.safeParse({ riskPctPerTrade: 0.5, minRr: 2 });
    assert.equal(parsed.success, true);
  });

  test('50% risk is refused (platform max is 1%)', () => {
    const parsed = riskPolicyUpdateSchema.safeParse({ riskPctPerTrade: 50 });
    assert.equal(parsed.success, false);
  });

  test('minRr below the platform floor is refused', () => {
    const parsed = riskPolicyUpdateSchema.safeParse({ minRr: 1 });
    assert.equal(parsed.success, false);
  });

  test('stricter minRr is accepted', () => {
    const parsed = riskPolicyUpdateSchema.safeParse({ minRr: 3 });
    assert.equal(parsed.success, true);
  });

  test('unknown / credential-shaped fields are refused (strict)', () => {
    assert.equal(riskPolicyUpdateSchema.safeParse({ riskPctPerTrade: 0.5, password: 'x' }).success, false);
    assert.equal(riskPolicyUpdateSchema.safeParse({ approved: true }).success, false);
    assert.equal(riskPolicyUpdateSchema.safeParse({ apiKey: 'sk' }).success, false);
  });

  test('paper equity outside bounds is refused', () => {
    assert.equal(riskPolicyUpdateSchema.safeParse({ paperEquity: 1 }).success, false);
    assert.equal(riskPolicyUpdateSchema.safeParse({ paperEquity: 50_000_000 }).success, false);
    assert.equal(riskPolicyUpdateSchema.safeParse({ paperEquity: 10_000 }).success, true);
  });
});

describe('m8.2 session windows are UTC-only', () => {
  test('named and utc_hours windows parse; extra fields do not', () => {
    assert.equal(riskSessionWindowSchema.safeParse({ kind: 'named', name: 'london' }).success, true);
    assert.equal(
      riskSessionWindowSchema.safeParse({ kind: 'utc_hours', startHour: 7, endHour: 16 }).success,
      true,
    );
    assert.equal(
      riskSessionWindowSchema.safeParse({ kind: 'named', name: 'london', timezone: 'America/New_York' }).success,
      false,
    );
  });
});

describe('m8.2 risk decision DTO', () => {
  test('an approved decision requires a server id and engine version', () => {
    const parsed = riskDecisionDtoSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      outcome: 'approved',
      rejectionCode: null,
      reason: 'risk checks passed',
      riskPct: 0.5,
      monetaryRisk: 50,
      positionSize: 0.1,
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11,
      rr: 2,
      currentExposure: {
        openPositions: 0,
        reservedPositions: 0,
        totalOpenRisk: 0,
        instrumentOpenRisk: 0,
        directionOpenRisk: 0,
      },
      projectedExposure: {
        openPositions: 1,
        reservedPositions: 0,
        totalOpenRisk: 50,
        instrumentOpenRisk: 50,
        directionOpenRisk: 50,
      },
      policyVersion: 1,
      engineVersion: RISK_ENGINE_VERSION,
      evaluatedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.equal(parsed.success, true);
  });

  test('a client-invented engine version is refused', () => {
    const parsed = riskDecisionDtoSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      outcome: 'approved',
      rejectionCode: null,
      reason: 'ok',
      riskPct: 0.5,
      monetaryRisk: 50,
      positionSize: 0.1,
      entryPrice: 1.1,
      stopLossPrice: 1.095,
      takeProfitPrice: 1.11,
      rr: 2,
      currentExposure: {
        openPositions: 0,
        reservedPositions: 0,
        totalOpenRisk: 0,
        instrumentOpenRisk: 0,
        directionOpenRisk: 0,
      },
      projectedExposure: {
        openPositions: 1,
        reservedPositions: 0,
        totalOpenRisk: 50,
        instrumentOpenRisk: 50,
        directionOpenRisk: 50,
      },
      policyVersion: 1,
      engineVersion: 'client-says-so',
      evaluatedAt: '2024-01-01T00:00:00.000Z',
    });
    assert.equal(parsed.success, false);
  });
});
