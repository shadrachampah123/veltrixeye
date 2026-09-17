/**
 * M8.3 — paper execution UI.
 *
 * The panel must show simulated orders/positions/fills/P&L and the
 * reconciliation trail, and must NEVER offer a live-trading affordance:
 * no broker/MT5/Exness connection, no credential field, no "go live" button,
 * no order submission to an external venue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PAPER_SIMULATOR_VERSION,
  RISK_ENGINE_VERSION,
  type PaperFillDto,
  type PaperOrderDto,
  type PaperPositionDto,
  type PaperStatusDto,
  type ReconciliationDto,
} from '@veltrixeye/contracts';
import { PaperExecutionPanel } from '../components/paper-execution-panel';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const POSITION_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';

const status: PaperStatusDto = {
  simulatorVersion: PAPER_SIMULATOR_VERSION,
  riskEngineVersion: RISK_ENGINE_VERSION,
  providerId: 'paper',
  providerConfigured: true,
  providerHealthy: true,
  providerReason: null,
  automationOff: true,
  automationReasons: ['entitlement_not_granted'],
  automatedPathGate: 'entitlement',
  profiles: 1,
  orders: 1,
  openPositions: 1,
  closedPositions: 1,
  fills: 2,
  openPl: 50,
  closedPl: 100,
  lastReconciliationOutcome: 'ok',
  liveExecutionAvailable: false,
};

const order: PaperOrderDto = {
  id: ORDER_ID,
  executionProfileId: PROFILE_ID,
  executionRequestId: null,
  clientOrderId: 've-abc',
  providerSlug: 'paper',
  providerOrderId: ORDER_ID,
  assetClass: 'forex',
  symbol: 'EURUSD',
  side: 'buy',
  orderType: 'market',
  quantity: 0.1,
  requestedPrice: null,
  stopLossPrice: 1.095,
  takeProfitPrice: 1.11,
  status: 'filled',
  rejectReason: null,
  idempotencyKey: 'a'.repeat(64),
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  submittedAt: '2024-01-01T00:00:00.000Z',
  filledAt: '2024-01-01T00:00:00.000Z',
  setupId: '44444444-4444-4444-8444-444444444444',
  riskDecisionId: '55555555-5555-4555-8555-555555555555',
  filledQuantity: 0.1,
  averageFillPrice: 1.1,
  fees: 0,
  slippage: 0,
  referencePrice: 1.1,
  referencePriceMs: 1_700_000_000_000,
  simulated: true,
  simulatorVersion: PAPER_SIMULATOR_VERSION,
};

const position: PaperPositionDto = {
  id: POSITION_ID,
  executionProfileId: PROFILE_ID,
  providerSlug: 'paper',
  providerPositionId: 'paper-abc',
  assetClass: 'forex',
  symbol: 'EURUSD',
  direction: 'long',
  quantity: 0.1,
  averageEntryPrice: 1.1,
  stopLossPrice: 1.095,
  takeProfitPrice: 1.11,
  realizedPl: null,
  unrealizedPl: 50,
  status: 'open',
  openedAt: '2024-01-01T00:00:00.000Z',
  closedAt: null,
  updatedAt: '2024-01-01T00:00:00.000Z',
  setupId: '44444444-4444-4444-8444-444444444444',
  openedByOrderId: ORDER_ID,
  closedByOrderId: null,
  exitPrice: null,
  exitReason: null,
  fees: 0,
  slippage: 0,
  markPrice: 1.105,
  markPriceMs: 1_700_000_300_000,
  simulated: true,
  simulatorVersion: PAPER_SIMULATOR_VERSION,
};

const fill: PaperFillDto = {
  id: '66666666-6666-4666-8666-666666666666',
  executionProfileId: PROFILE_ID,
  orderId: ORDER_ID,
  positionId: POSITION_ID,
  setupId: '44444444-4444-4444-8444-444444444444',
  sequence: 1,
  fillType: 'entry',
  quantity: 0.1,
  price: 1.1,
  fees: 0,
  slippage: 0,
  referencePrice: 1.1,
  simulated: true,
  idempotencyKey: 'b'.repeat(64),
  createdAt: '2024-01-01T00:00:00.000Z',
};

const reconciliation: ReconciliationDto = {
  id: '77777777-7777-4777-8777-777777777777',
  executionProfileId: PROFILE_ID,
  orderId: ORDER_ID,
  positionId: POSITION_ID,
  scope: 'order',
  outcome: 'ok',
  findings: [],
  expected: {},
  actual: {},
  simulatorVersion: PAPER_SIMULATOR_VERSION,
  createdAt: '2024-01-01T00:00:00.000Z',
};

function render(extra: Partial<React.ComponentProps<typeof PaperExecutionPanel>> = {}): string {
  return renderToStaticMarkup(
    React.createElement(PaperExecutionPanel, {
      status,
      orders: [order],
      positions: [position],
      fills: [fill],
      reconciliations: [reconciliation],
      setupId: '',
      onSetupIdChange: () => {},
      profileOptions: [{ id: PROFILE_ID, label: 'paper · paper' }],
      selectedProfileId: PROFILE_ID,
      onProfileChange: () => {},
      onSimulate: () => {},
      onEvaluate: () => {},
      onClosePosition: () => {},
      busy: false,
      error: null,
      notice: null,
      ...extra,
    }),
  );
}

test('renders simulated orders, positions, fills and P&L', () => {
  const html = render();
  assert.match(html, /Paper execution \(simulation\)/);
  assert.match(html, /EURUSD/);
  assert.match(html, /1\.10000/); // entry price
  assert.match(html, /1\.10500/); // mark price
  assert.match(html, /\+50\.00/); // unrealized P&L
  assert.match(html, /\+100\.00/); // closed P&L
  assert.match(html, /entry/); // fill ledger
  assert.match(html, /consistent/); // reconciliation outcome
});

test('states the safety boundary: automation OFF, live unavailable, results simulated', () => {
  const html = render();
  assert.match(html, /Automated execution is <strong>OFF<\/strong>/);
  assert.match(html, /live execution is not available/i);
  assert.match(html, /not broker fills/);
});

test('offers no live-trading, broker, credential or connection affordance', () => {
  const html = render().toLowerCase();
  // The panel names the venues and credentials it does NOT use only inside
  // explicit negative statements ("no broker, no MT5/Exness", "not broker
  // fills"). Those statements are the boundary; everything else must be free
  // of any such affordance.
  const withoutNegations = html
    .replace(/internal simulator only[^<]*/g, '')
    .replace(/they are not broker fills[^<]*/g, '');
  for (const needle of [
    'mt5',
    'exness',
    'broker',
    'demo account',
    'connect account',
    'broker login',
    'enable live',
    'go live',
    'live trading',
    'api key',
    'apikey',
    'api_key',
    'password',
    'secret',
    '<form',
    'type="password"',
    'place order',
    'buy now',
    'sell now',
  ]) {
    assert.ok(!withoutNegations.includes(needle), `paper panel must not offer "${needle}"`);
  }
  // …and the negative statements themselves are present.
  assert.match(html, /no broker, no mt5\/exness/);
  assert.match(html, /not broker fills/);
  // The only actions are the simulation controls (html is lower-cased above).
  assert.match(html, /simulate/);
  assert.match(html, /evaluate open positions/);
  assert.match(html, /close \(simulated\)/);
});

test('a mismatch in the trail is surfaced as a finding, not hidden', () => {
  const html = render({
    reconciliations: [
      { ...reconciliation, outcome: 'mismatch', findings: ['order_fill_quantity_mismatch'] },
    ],
  });
  assert.match(html, /order_fill_quantity_mismatch/);
  assert.match(html, /never silently corrected/);
});

test('shows the simulator/risk versions and the blocked automated path', () => {
  const html = render();
  assert.match(html, new RegExp(PAPER_SIMULATOR_VERSION));
  assert.match(html, new RegExp(RISK_ENGINE_VERSION));
  assert.match(html, /blocked at entitlement/);
  assert.match(html, /live execution available: false/);
});
