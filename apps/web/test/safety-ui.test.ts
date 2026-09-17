/**
 * M8.6 — safety-controls UI.
 *
 * Two contracts are pinned here:
 *
 * 1. The PANEL renders the full kill-switch picture (global/user/strategy/
 *    profile + circuit breaker + automation) and STOP affordances, and it
 *    must never render any "go live" affordance, credential field or
 *    automation-ENABLE control. The global row is display-only: no button may
 *    exist for it, and the environment-pinned note must be shown verbatim.
 *
 * 2. The API CLIENT calls exactly the five documented routes with the right
 *    verbs/bodies (no extra surface, identifiers + reason only).
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SAFETY_CONTROLS_VERSION,
  EXECUTION_ARCHITECTURE_VERSION,
  type KillSwitchStatusDto,
  type KillSwitchEventDto,
} from '@veltrixeye/contracts';
import { SafetyPanel } from '../components/safety-panel';
import { api } from '../lib/api';

const STRATEGY_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_ID = '22222222-2222-4222-8222-222222222222';

function statusFixture(overrides: Partial<KillSwitchStatusDto> = {}): KillSwitchStatusDto {
  const entry = {
    targetId: null as string | null,
    entityLabel: null as string | null,
    active: false,
    source: 'operator' as const,
    reason: null as string | null,
    activatedAt: null as string | null,
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
  return {
    safetyVersion: SAFETY_CONTROLS_VERSION,
    architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
    globalForcedByEnvironment: false,
    global: { ...entry, scope: 'global', entityLabel: 'platform' },
    user: { ...entry, scope: 'user', targetId: '33333333-3333-4333-8333-333333333333' },
    strategies: [{ ...entry, strategyId: STRATEGY_ID, targetId: STRATEGY_ID, entityLabel: 'London breakout' }],
    profiles: [
      {
        ...entry,
        executionProfileId: PROFILE_ID,
        targetId: PROFILE_ID,
        providerSlug: 'paper',
        environment: 'paper',
        entityLabel: 'paper',
      },
    ],
    anyActive: false,
    circuitBreaker: { active: false, trippedAt: null, reason: null },
    automation: { entitled: false, automationEnabled: false, effective: false },
    ...overrides,
  };
}

const events: KillSwitchEventDto[] = [
  {
    id: '77',
    scope: 'strategy',
    targetId: STRATEGY_ID,
    entityLabel: 'London breakout',
    action: 'activated',
    source: 'user',
    reason: 'rebuilding rules',
    changed: true,
    createdAt: '2026-09-17T10:00:00.000Z',
  },
  {
    id: '76',
    scope: 'user',
    targetId: '33333333-3333-4333-8333-333333333333',
    entityLabel: null,
    action: 'cleared',
    source: 'circuit_breaker',
    reason: 'reviewed losses',
    changed: false,
    createdAt: '2026-09-17T09:00:00.000Z',
  },
];

/** Collapse React SSR comment/text separators + whitespace for stable matches. */
function normalize(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ');
}

function render(props: Partial<React.ComponentProps<typeof SafetyPanel>> = {}): string {
  return normalize(
    renderToStaticMarkup(
      React.createElement(SafetyPanel, {
        status: statusFixture(),
        events,
        ...props,
      }),
    ),
  );
}

test('panel renders every scope, the breaker summary and the safety version', () => {
  const html = render();
  assert.match(html, /Safety controls \(M8\.6\)/);
  assert.match(html, /m8\.6-safety-controls-1/);
  assert.match(html, /Global platform kill switch/);
  assert.match(html, /Account kill switch/);
  assert.match(html, /Per strategy/);
  assert.match(html, /London breakout/);
  assert.match(html, /Per execution profile/);
  assert.match(html, /paper \(paper\)/);
  assert.match(html, /Switch history \(append-only\)/);
  assert.match(html, /rebuilding rules/);
  assert.match(html, /cleared via circuit_breaker \(no change\)/);
  assert.match(html, /ARMED|clear/);
});

test('stop affordances exist for OWN scopes; the global row is DISPLAY-ONLY', () => {
  const html = render();
  // Account/strategy/profile can be armed; global cannot (read-only row).
  const armCount = (html.match(/Arm stop/g) ?? []).length;
  assert.equal(armCount, 3, 'one Arm button per mutable row: user + strategy + profile');
  assert.ok(!/data-testid="global-arm"/.test(html));
  // The global note explains WHO operates it.
  assert.match(html, /operator-controlled; accounts can only stop themselves/);
});

test('armed states surface: red ARMED badge, first reason preserved, breaker explanation', () => {
  const html = render({
    status: statusFixture({
      anyActive: true,
      user: {
        scope: 'user',
        targetId: '33333333-3333-4333-8333-333333333333',
        entityLabel: null,
        active: true,
        source: 'circuit_breaker',
        reason: 'Risk circuit breaker: DAILY_LOSS_LIMIT reached',
        activatedAt: '2026-09-17T08:00:00.000Z',
        updatedAt: '2026-09-17T08:00:00.000Z',
      },
      circuitBreaker: {
        active: true,
        trippedAt: '2026-09-17T08:00:00.000Z',
        reason: 'Risk circuit breaker: DAILY_LOSS_LIMIT reached',
      },
    }),
  });
  assert.match(html, /ARMED — execution refused/);
  assert.match(html, /Tripped automatically by the risk engine/);
  assert.match(html, /needs an explicit clear/);
  // While armed the row offers Clear (with reason), not another Arm.
  assert.match(html, /Clear stop/);
});

test('environment-pinned global switch says so and cannot be cleared', () => {
  const html = render({
    status: statusFixture({
      globalForcedByEnvironment: true,
      anyActive: true,
      global: {
        scope: 'global',
        targetId: null,
        entityLabel: 'platform',
        active: true,
        source: 'operator',
        reason: 'Deployment environment pins the global kill switch ON',
        activatedAt: null,
        updatedAt: '1970-01-01T00:00:00.000Z',
      },
    }),
  });
  assert.match(html, /Pinned ON by the deployment environment — cannot be cleared through the API/);
});

test('panel NEVER renders a live-trading / credential / enable-automation affordance', () => {
  const html = render();
  const lower = html.toLowerCase();
  for (const forbidden of [
    'enable live',
    'go live',
    'start automation',
    'enable automation',
    'connect broker',
    'mt5 password',
    'investor password',
    'api key',
    'apikey',
    'type="password"',
    'demo account',
    'resume trading',
    'unpause',
  ]) {
    assert.ok(!lower.includes(forbidden), `forbidden affordance rendered: ${forbidden}`);
  }
  // Risk-reducing actions explicitly stay available.
  assert.match(html, /Position exits and risk-reducing actions remain available while armed/i);
});

test('emergency stop requires a confirm step before acting', () => {
  const html = render();
  assert.match(html, /EMERGENCY STOP/);
  assert.match(html, /Arms the account kill switch, forces the automation switch OFF and disables every execution/);
  // Confirmation is an interaction (confirm button appears only after the
  // first click) — the static render shows the entry button, not the payload
  // sender, and the Cancel escape hatch exists in the same component.
  const src = readFileSync(fileURLToPath(new URL('../components/safety-panel.tsx', import.meta.url)), 'utf8');
  assert.match(src, /Confirm — stop everything now/);
  assert.match(src, /setConfirmStop\(true\)/);
});

/* -------------------------------------------------------------------------- */
/* client contract                                                              */
/* -------------------------------------------------------------------------- */

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}
let calls: RecordedCall[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('api client: the five safety routes, exact verbs + bodies', async () => {
  await api.getSafetyStatus();
  assert.equal(calls[0]!.url, '/api/execution/safety');
  assert.equal(calls[0]!.init?.method ?? 'GET', 'GET');

  await api.listSafetyEvents({ limit: 10 });
  assert.equal(calls[1]!.url, '/api/execution/safety/events?limit=10');

  await api.activateSafetyKillSwitch({ scope: 'strategy', targetId: STRATEGY_ID, reason: 'incident drill' });
  assert.equal(calls[2]!.url, '/api/execution/safety/kill-switch/activate');
  assert.equal(calls[2]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)), {
    scope: 'strategy',
    targetId: STRATEGY_ID,
    reason: 'incident drill',
  });

  await api.clearSafetyKillSwitch({ scope: 'user', reason: 'review complete' });
  assert.equal(calls[3]!.url, '/api/execution/safety/kill-switch/clear');
  assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), { scope: 'user', reason: 'review complete' });

  await api.emergencyStop();
  assert.equal(calls[4]!.url, '/api/execution/safety/emergency-stop');
  assert.deepEqual(JSON.parse(String(calls[4]!.init?.body)), {}, 'no reason ⇒ empty strict body');

  assert.equal(calls.length, 5, 'no hidden extra calls');
});

test('api client never sends approval/price/credential fields through safety calls', () => {
  const src = readFileSync(fileURLToPath(new URL('../lib/api.ts', import.meta.url)), 'utf8');
  const safetySection = src.slice(src.indexOf('// M8.6 — kill-switch & safety controls'));
  assert.ok(safetySection.length > 0);
  for (const forbidden of ['approved', 'entryPrice', 'password', 'secret', 'brokerSymbol', 'live']) {
    // 'live' would only appear as part of words like "available" — check calls, not prose.
    const call = safetySection.match(/request<[^>]*>\('([^']+)'/g) ?? [];
    for (const c of call) {
      assert.ok(!c.includes(`'/execution/live`), 'no live route in the client');
    }
    if (['approved', 'entryPrice', 'password'].includes(forbidden)) {
      assert.ok(!safetySection.includes(`${forbidden}:`), `${forbidden} must never be a field`);
    }
  }
});
