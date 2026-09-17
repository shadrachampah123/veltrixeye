/**
 * M8.2 — risk policy UI.
 *
 * The panel must distinguish User Risk Setting from Platform Safety Limit,
 * must not offer live trading / broker credentials / order execution, and
 * must state that M8.2 does not execute orders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PLATFORM_RISK_CEILINGS,
  RISK_ENGINE_VERSION,
  type RiskAccountSnapshotDto,
  type RiskPolicyDto,
} from '@veltrixeye/contracts';
import { RiskPolicyPanel } from '../components/risk-policy-panel';

const policy: RiskPolicyDto = {
  id: '11111111-1111-4111-8111-111111111111',
  enabled: true,
  policyVersion: 1,
  riskPctPerTrade: 0.5,
  maxMonetaryRiskPerTrade: 500,
  maxDailyLossPct: 3,
  maxWeeklyLossPct: 6,
  maxConsecutiveLosses: 3,
  maxSimultaneousPositions: 3,
  maxTotalOpenRiskPct: 3,
  maxExposurePerInstrumentPct: 1,
  maxExposurePerDirectionPct: 2,
  minRr: 2,
  maxSpreadPips: null,
  maxSlippagePips: null,
  allowedSessions: null,
  correlationRequired: false,
  maxCorrelationGroupExposurePct: 2,
  paperEquity: 10_000,
  // M8.6 — platform-controlled circuit breaker (read-only in the DTO).
  circuitBreakerEnabled: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const account: RiskAccountSnapshotDto = {
  equity: 10_000,
  dailyRealizedPl: 0,
  weeklyRealizedPl: 0,
  consecutiveLosses: 0,
  openPositions: 0,
  reservedPositions: 0,
  totalOpenRisk: 0,
  dailyWindowStart: '2024-01-01',
  weeklyWindowStart: '2024-01-01',
};

function render(extra: Partial<React.ComponentProps<typeof RiskPolicyPanel>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(RiskPolicyPanel, {
      policy,
      ceilings: { ...PLATFORM_RISK_CEILINGS },
      account,
      engineVersion: RISK_ENGINE_VERSION,
      ...extra,
    }),
  );
}

test('RiskPolicyPanel labels User Risk Setting vs Platform Safety Limit', () => {
  const html = render();
  assert.ok(html.includes('User Risk Setting'));
  assert.ok(html.includes('Platform Safety Limit'));
  assert.ok(html.includes('0.5%'));
  assert.ok(html.includes(`${PLATFORM_RISK_CEILINGS.maxRiskPctPerTrade}%`));
  assert.ok(html.includes('1:2'));
  assert.ok(html.includes(RISK_ENGINE_VERSION));
});

test('RiskPolicyPanel states that no orders are executed and automation stays off-limits', () => {
  const html = render();
  assert.ok(html.includes('No real, demo or paper orders are executed'));
  assert.ok(html.includes('Risk approval is not permission to trade'));
  assert.ok(html.includes('Automation remains OFF'));
  assert.ok(html.includes('no live trading button'));
  assert.ok(html.includes('no broker credential form'));
  assert.ok(!/enable live trading|connect (exness|mt5)|place order/i.test(html));
  assert.ok(!html.toLowerCase().includes('password'));
  assert.ok(!html.toLowerCase().includes('api key'));
});

test('RiskPolicyPanel does not offer an order-submit control', () => {
  const html = render({ onSave: () => {} });
  assert.ok(html.includes('Save risk settings'));
  assert.ok(!html.includes('>Execute<'));
  assert.ok(!/trade now/i.test(html));
  assert.ok(!/type="password"/.test(html));
});
