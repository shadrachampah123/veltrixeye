/**
 * M6 Phase 4 — alert UI render tests.
 *
 * Rendered with `react-dom/server`, so the assertions run the real components.
 * The behaviours that matter most here are the ones a trader could be misled
 * by: acknowledgement state (including idempotency), the created / replayed /
 * skipped distinction, and the stub-delivery wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  alertDeliveryDtoSchema,
  alertDtoSchema,
  alertGenerateResponseSchema,
  type AlertDeliveryDto,
  type AlertDto,
  type AlertGenerateResponse,
  type SetupDto,
} from '@veltrixeye/contracts';
import { AlertsTable, AlertsNeverGeneratedState, GENERATE_PANEL_ANCHOR } from '../components/alerts-table';
import { AlertDetailPanel } from '../components/alert-detail-panel';
import { GenerateAlertOutcomeBanner, SetupGenerateList, SetupGenerateRow } from '../components/generate-alert-panel';
import { classifyGenerateOutcome } from '../lib/alerts-view';
import { StubDeliveryNotice } from '../components/stub-delivery-notice';

const SETUP_ID = '33333333-3333-4333-8333-333333333333';
const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';
const ALERT_ID = '44444444-4444-4444-8444-444444444444';
const noop = () => {};

function alertFixture(overrides: Partial<AlertDto> = {}): AlertDto {
  return alertDtoSchema.parse({
    id: ALERT_ID,
    setupId: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    direction: 'long',
    triggerState: 'confirmed',
    qualityScore: 82,
    minQualityScore: 70,
    title: 'EURUSD long confirmed (score 82/A)',
    body: {
      qualityScore: 82,
      qualityGrade: 'A',
      entryPrice: 1.085,
      stopLossPrice: 1.08,
      tp1Price: 1.095,
      tp2Price: 1.105,
      tp3Price: 1.12,
      scoreId: 17,
      scoreEngineVersion: 'm5-score-1',
      detectedAt: '2024-05-20T12:00:00.000Z',
      asOfMs: 1716206400000,
    },
    status: 'pending',
    acknowledgedAt: null,
    createdAt: '2024-05-20T12:05:00.000Z',
    ...overrides,
  });
}

function deliveryFixture(overrides: Partial<AlertDeliveryDto> = {}): AlertDeliveryDto {
  return alertDeliveryDtoSchema.parse({
    id: 1,
    alertId: ALERT_ID,
    channel: 'stub',
    status: 'delivered',
    attempt: 1,
    error: null,
    payloadHash: 'c'.repeat(64),
    createdAt: '2024-05-20T12:05:00.000Z',
    ...overrides,
  });
}

function setupFixture(overrides: Partial<SetupDto> = {}): SetupDto {
  return {
    id: SETUP_ID,
    strategyId: STRATEGY_ID,
    strategyVersionId: VERSION_ID,
    versionNumber: 3,
    instrument: { assetClass: 'forex', symbol: 'EURUSD' },
    state: 'confirmed',
    direction: 'long',
    asOfMs: 1716206400000,
    detectedAt: '2024-05-20T12:00:00.000Z',
    updatedAt: '2024-05-20T12:00:00.000Z',
    expiresAt: null,
    entryPrice: 1.085,
    stopLossPrice: 1.08,
    tp1Price: 1.095,
    tp2Price: 1.105,
    tp3Price: 1.12,
    qualityScore: 82,
    metadata: {},
    ...overrides,
  } as SetupDto;
}

// ---------------------------------------------------------------------------
// 1. Alert list
// ---------------------------------------------------------------------------

test('AlertsTable renders each alert the API returned, with its state and score', () => {
  const alerts = [
    alertFixture(),
    alertFixture({
      id: '44444444-4444-4444-8444-444444444445',
      triggerState: 'triggered',
      direction: 'short',
      qualityScore: 91,
      status: 'acknowledged',
      acknowledgedAt: '2024-05-21T08:30:00.000Z',
      title: 'GBPUSD short triggered (score 91/A+)',
      instrument: { assetClass: 'forex', symbol: 'GBPUSD' },
    }),
  ];
  const html = renderToStaticMarkup(React.createElement(AlertsTable, { alerts }));

  assert.ok(html.includes('EURUSD long confirmed (score 82/A)'), 'alert title');
  assert.ok(html.includes('GBPUSD'), 'second alert instrument');
  assert.ok(html.includes('Confirmed'), 'trigger state label');
  assert.ok(html.includes('Triggered'));
  assert.ok(html.includes('Pending'), 'status label');
  assert.ok(html.includes('Acknowledged'), 'acknowledged status label');
  assert.ok(html.includes('82'), 'quality score');
  assert.ok(html.includes('A+'), 'grade badge from the alert body');
  assert.ok(html.includes(`href="/alerts/${ALERT_ID}"`), 'detail link');
  assert.ok(html.includes('Alerts (2)'), 'count');
  assert.ok(html.includes('stub ledger only'), 'stub-delivery hint under the list');
  assert.ok(!/email|webhook|telegram|whatsapp|sms/i.test(html), 'no real channel is implied by the list');
});

test('AlertsTable — empty state explains how an alert comes to exist', () => {
  const html = renderToStaticMarkup(React.createElement(AlertsTable, { alerts: [] }));
  assert.ok(html.includes('No alerts match this view.'));
  assert.ok(html.includes('confirmed'), 'names an eligible trigger state');
  assert.ok(html.includes('Generate from a setup'), 'points at the generator');

  const never = renderToStaticMarkup(React.createElement(AlertsNeverGeneratedState, {}));
  assert.ok(never.includes('You have not generated any alerts yet.'));
  assert.ok(never.includes('no background scanner'), 'states that nothing is generated automatically');
  // The call-to-action is a real in-page link to the generator, not a callback
  // the page never wired up (the previous button's onClick was unreachable).
  assert.match(never, new RegExp(`<a[^>]*href="#${GENERATE_PANEL_ANCHOR}"`), 'anchors to the generate panel');
  assert.ok(!never.includes('<button'), 'no button nested inside that anchor');
  assert.ok(never.includes('focus-visible:outline'), 'the link is keyboard reachable and visible');
});

// ---------------------------------------------------------------------------
// 2. Alert detail + acknowledgement
// ---------------------------------------------------------------------------

function detailPanel(props: {
  alert?: AlertDto;
  deliveries?: AlertDeliveryDto[];
  acknowledging?: boolean;
  error?: string | null;
  notice?: string | null;
}): string {
  return renderToStaticMarkup(
    React.createElement(AlertDetailPanel, {
      alert: props.alert ?? alertFixture(),
      deliveries: props.deliveries ?? [deliveryFixture()],
      acknowledging: props.acknowledging ?? false,
      error: props.error ?? null,
      notice: props.notice ?? null,
      onAcknowledge: noop,
    }),
  );
}

test('AlertDetailPanel renders setup/instrument info, score, state and delivery ledger', () => {
  const html = detailPanel({});
  assert.ok(html.includes('EURUSD long confirmed (score 82/A)'), 'title from the API');
  assert.ok(html.includes('forex'), 'asset class');
  assert.ok(html.includes('Confirmed'), 'trigger state');
  assert.ok(html.includes('82 / 100'), 'quality score');
  assert.ok(html.includes('m5-score-1'), 'score engine version');
  assert.ok(html.includes('1.085'), 'entry level from the alert body');
  assert.ok(html.includes('1.08'), 'stop level');
  assert.ok(html.includes('Minimum score gate'), 'the gate that allowed generation');
  assert.ok(html.includes('70'));
  assert.ok(html.includes('Delivery ledger'), 'delivery section');
  assert.ok(html.includes('Stub (local ledger record)'), 'channel wording');
  assert.ok(html.includes('Recorded locally on the stub channel'), 'what actually happened');
  assert.ok(html.includes('c'.repeat(64)), 'payload hash for audit');
  assert.ok(html.includes('Stub delivery only'), 'disclaimer on the detail page');
  assert.ok(html.includes('No email, webhook, push, SMS or broker notification is sent'), 'explicit non-delivery');
  assert.ok(!/notification (was )?sent|email sent|push sent/i.test(html), 'never claims a send');
});

test('AlertDetailPanel — acknowledge is actionable for a pending alert', () => {
  const html = detailPanel({});
  assert.ok(html.includes('>Acknowledge</button>'), 'enabled acknowledge control');
  assert.ok(!html.includes('disabled=""'), 'nothing is disabled in the idle pending state');
  assert.ok(!html.includes('Acknowledging'), 'no in-flight label');
});

test('AlertDetailPanel — acknowledge is disabled and labelled while the request is in flight', () => {
  const html = detailPanel({ acknowledging: true });
  assert.ok(html.includes('Acknowledging…'), 'progress label');
  assert.ok(html.includes('disabled=""'), 'the control cannot fire a second call');
  assert.ok(html.includes('aria-disabled="true"'), 'state exposed to assistive tech');
});

test('AlertDetailPanel — an acknowledged alert is idempotent in the UI', () => {
  const html = detailPanel({
    alert: alertFixture({ status: 'acknowledged', acknowledgedAt: '2024-05-21T08:30:00.000Z' }),
  });
  assert.ok(html.includes('>Acknowledged</button>'), 'the button reads as done');
  assert.ok(html.includes('disabled=""'), 'no second acknowledgement is offered');
  assert.ok(html.includes('This alert is already acknowledged.'), 'explains why it is disabled');
  assert.ok(html.includes('2024'), 'acknowledged timestamp shown');
});

test('AlertDetailPanel — errors and confirmations are rendered, safely', () => {
  const failed = detailPanel({ error: 'The alert could not be acknowledged. Try again.' });
  assert.ok(failed.includes('Could not acknowledge'), 'error heading');
  assert.ok(failed.includes('The alert could not be acknowledged. Try again.'));
  assert.ok(failed.includes('role="alert"'), 'a failed acknowledgement interrupts immediately');
  assert.ok(failed.includes('aria-live="assertive"'));

  const done = detailPanel({
    alert: alertFixture({ status: 'acknowledged', acknowledgedAt: '2024-05-21T08:30:00.000Z' }),
    notice: 'This alert was already acknowledged — the API kept the original timestamp and wrote nothing new.',
  });
  assert.ok(done.includes('This alert was already acknowledged'), 'idempotent replay is described honestly');
  assert.ok(done.includes('role="status"'), 'the confirmation is announced politely');
  assert.ok(done.includes('aria-live="polite"'));

  const noLedger = detailPanel({ deliveries: [] });
  assert.ok(noLedger.includes('No delivery rows were returned for this alert.'), 'honest empty ledger');
});

test('AlertDetailPanel — a reserved delivery channel is never presented as live', () => {
  const html = detailPanel({ deliveries: [deliveryFixture({ channel: 'email', status: 'failed' })] });
  assert.ok(html.includes('email (reserved — not enabled)'), 'reserved channel marked');
  assert.ok(html.includes('not enabled in this milestone'), 'explicitly not a live integration');
});

// ---------------------------------------------------------------------------
// 3. Generate alert from a setup
// ---------------------------------------------------------------------------

test('GenerateAlertOutcomeBanner — created says generated and stub-only', () => {
  const html = renderToStaticMarkup(
    React.createElement(GenerateAlertOutcomeBanner, {
      outcome: { kind: 'created', alert: alertFixture(), deliveries: [deliveryFixture()] },
    }),
  );
  assert.ok(html.includes('Alert generated'), 'created outcome');
  assert.ok(html.includes('Stub delivery only'), 'names the stub mechanism');
  assert.ok(html.includes('No external notification was sent'), 'truthful about delivery');
  assert.ok(html.includes(`href="/alerts/${ALERT_ID}"`), 'link to the new alert');
});

test('GenerateAlertOutcomeBanner — a replay is not presented as a new alert', () => {
  const html = renderToStaticMarkup(
    React.createElement(GenerateAlertOutcomeBanner, {
      outcome: { kind: 'replayed', alert: alertFixture(), deliveries: [deliveryFixture()] },
    }),
  );
  assert.ok(html.includes('Alert already exists'), 'replay outcome');
  assert.ok(html.includes('existing alert was returned'), 'explains dedup');
  assert.ok(html.includes('no second alert'), 'states nothing new was written');
  assert.ok(!html.includes('Alert generated<'), 'does not use the created headline');
});

test('GenerateAlertOutcomeBanner — a quality-gate skip is not presented as generated', () => {
  const html = renderToStaticMarkup(
    React.createElement(GenerateAlertOutcomeBanner, {
      outcome: { kind: 'skipped', reason: 'below_min_quality' },
    }),
  );
  assert.ok(html.includes('No alert generated'), 'skip headline');
  assert.ok(html.includes('below the strategy version'), 'names the gate');
  assert.ok(html.includes('No alert row was written'), 'states nothing was persisted');
  assert.ok(!html.includes('href="/alerts/'), 'a skip links to no alert');
});

test('generate outcome — raw API responses classify and announce through the production helpers', () => {
  // The panel chains classifyGenerateOutcome() → describeGenerateOutcome() →
  // banner. Driving that exact chain from wire-shaped responses proves the
  // created / replayed / skipped distinction a trader sees, rather than a
  // hand-written expectation of it.
  const created = alertGenerateResponseSchema.parse({
    alert: alertFixture(),
    created: true,
    deliveries: [deliveryFixture()],
  });
  const replayed = alertGenerateResponseSchema.parse({
    alert: alertFixture(),
    created: false,
    deliveries: [deliveryFixture()],
  });
  const skipped = alertGenerateResponseSchema.parse({
    alert: null,
    created: false,
    skippedReason: 'below_min_quality',
  });

  const cases: Array<[AlertGenerateResponse, string[], string[]]> = [
    [created, ['Alert generated', 'Stub delivery only', 'No external notification was sent'], ['Alert already exists', 'No alert generated']],
    [replayed, ['Alert already exists', 'no second alert', 'no second delivery row'], ['Alert generated', 'No alert generated']],
    [skipped, ['No alert generated', 'below the strategy version', 'No alert row was written'], ['Alert generated', 'Alert already exists']],
  ];

  for (const [response, expected, absent] of cases) {
    const outcome = classifyGenerateOutcome(response);
    const html = renderToStaticMarkup(React.createElement(GenerateAlertOutcomeBanner, { outcome }));
    for (const text of expected) assert.ok(html.includes(text), `expected "${text}" for ${outcome.kind}`);
    for (const text of absent) assert.ok(!html.includes(text), `must not say "${text}" for ${outcome.kind}`);
    assert.ok(html.includes('role="status"'), 'every outcome is announced to assistive tech');
    assert.ok(html.includes('aria-live="polite"'));
  }

  // The replay must point at the SAME alert id the API returned.
  const replayHtml = renderToStaticMarkup(
    React.createElement(GenerateAlertOutcomeBanner, { outcome: classifyGenerateOutcome(replayed) }),
  );
  assert.ok(replayHtml.includes(`href="/alerts/${ALERT_ID}"`), 'the replay links to the existing alert');
  assert.equal(classifyGenerateOutcome(skipped).kind, 'skipped');
});

test('SetupGenerateRow — enabled for an eligible setup, disabled with a reason otherwise', () => {
  const eligible = renderToStaticMarkup(
    React.createElement(SetupGenerateRow, { setup: setupFixture(), pending: false, onGenerate: noop }),
  );
  assert.ok(eligible.includes('Generate alert'), 'generate action offered');
  assert.ok(eligible.includes('EURUSD'), 'setup instrument');
  assert.ok(eligible.includes('latest score'), 'shows the score the gate will compare');
  assert.ok(!eligible.includes('disabled=""'), 'actionable');

  const pending = renderToStaticMarkup(
    React.createElement(SetupGenerateRow, { setup: setupFixture(), pending: true, onGenerate: noop }),
  );
  assert.ok(pending.includes('Generating…'), 'progress label');
  assert.ok(pending.includes('disabled=""'), 'no double-submit');

  const ineligible = renderToStaticMarkup(
    React.createElement(SetupGenerateRow, { setup: setupFixture({ state: 'expired' }), pending: false, onGenerate: noop }),
  );
  assert.ok(ineligible.includes('disabled=""'), 'ineligible setups cannot generate');
  assert.ok(ineligible.includes('terminal setup'), 'reason is the API’s rule, not a guess');
});

test('SetupGenerateList — empty state says detection must be invoked', () => {
  const html = renderToStaticMarkup(
    React.createElement(SetupGenerateList, { setups: [], pendingSetupId: null, onGenerate: noop }),
  );
  assert.ok(html.includes('No setups found for your account.'));
  assert.ok(html.includes('no background scanner'), 'truthful about how setups appear');
});

// ---------------------------------------------------------------------------
// 4. Stub-delivery messaging
// ---------------------------------------------------------------------------

test('StubDeliveryNotice states the mechanism and that nothing external is enabled', () => {
  const html = renderToStaticMarkup(React.createElement(StubDeliveryNotice, {}));
  assert.ok(html.includes('Stub delivery only'), 'headline');
  assert.ok(html.includes('channel “stub”'), 'names the stub channel');
  assert.ok(html.includes('No email, webhook, push, SMS or broker notification is sent'), 'no false send claim');
  assert.ok(html.includes('real external delivery is not enabled'), 'explicit about the limitation');
  // No provider configuration is offered anywhere in the notice.
  assert.ok(!/<(input|select|button)/i.test(html), 'the notice offers no configuration controls');
});
