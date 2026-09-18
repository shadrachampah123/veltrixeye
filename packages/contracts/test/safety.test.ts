import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMERGENCY_STOP_DEFAULT_REASON,
  EXECUTION_ARCHITECTURE_VERSION,
  KILL_SWITCH_EVENT_ACTIONS,
  KILL_SWITCH_SCOPES,
  KILL_SWITCH_SOURCES,
  MUTABLE_KILL_SWITCH_SCOPES,
  RISK_CIRCUIT_BREAKER_CODES,
  SAFETY_CONTROLS_VERSION,
  emergencyStopResultDtoSchema,
  emergencyStopSchema,
  isCircuitBreakerCode,
  killSwitchActivateSchema,
  killSwitchClearSchema,
  killSwitchEntryDtoSchema,
  killSwitchEventDtoSchema,
  killSwitchEventListQuerySchema,
  killSwitchMutationResultDtoSchema,
  killSwitchStatusDtoSchema,
  type KillSwitchEntryDto,
  type KillSwitchStatusDto,
} from '../src/index.js';

/**
 * M8.6 — safety-controls contract tests.
 *
 * These pin the STRENGTHENED emergency-stop vocabulary: what a client may and
 * may not ask the safety API to do. Nothing here is about enabling anything —
 * the surface can only ADD stops, and the contract refuses the rest:
 *  - `global` is not a user-mutable scope (not even parseable);
 *  - `user` scope never accepts a targetId (you cannot aim a switch at
 *    somebody else's account);
 *  - a reason is REQUIRED on activate AND clear (auditability is not opt-out);
 *  - the ledgers' DTOs are strict (no credential-shaped extras).
 */

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

describe('m8.6 safety contract — pinned vocabularies', () => {
  test('versions and vocabularies are pinned', () => {
    assert.equal(SAFETY_CONTROLS_VERSION, 'm8.7-safety-controls-1');
    assert.deepEqual(KILL_SWITCH_SOURCES, ['operator', 'user', 'circuit_breaker']);
    assert.deepEqual(KILL_SWITCH_EVENT_ACTIONS, ['activated', 'cleared']);
    // The four M8.1 scopes are unchanged…
    assert.deepEqual(KILL_SWITCH_SCOPES, ['global', 'user', 'strategy', 'execution_profile']);
    // …but `global` is never user-mutable, and the architecture version stamp
    // is untouched (provenance rows keep what they were written with).
    assert.deepEqual(MUTABLE_KILL_SWITCH_SCOPES, ['user', 'strategy', 'execution_profile']);
    assert.ok(!MUTABLE_KILL_SWITCH_SCOPES.includes('global' as never));
    assert.equal(EXECUTION_ARCHITECTURE_VERSION, 'm8.1-execution-arch-1');
  });

  test('circuit-breaker codes are exactly the loss-limit and drawdown family', () => {
    assert.deepEqual(RISK_CIRCUIT_BREAKER_CODES, [
      'DAILY_LOSS_LIMIT',
      'WEEKLY_LOSS_LIMIT',
      'CONSECUTIVE_LOSS_LIMIT',
      'DAILY_DRAWDOWN_LIMIT',
      'WEEKLY_DRAWDOWN_LIMIT',
      'MAX_DRAWDOWN_LIMIT',
      'EQUITY_DATA_UNAVAILABLE',
    ]);
    assert.equal(isCircuitBreakerCode('DAILY_LOSS_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('WEEKLY_LOSS_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('CONSECUTIVE_LOSS_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('DAILY_DRAWDOWN_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('WEEKLY_DRAWDOWN_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('MAX_DRAWDOWN_LIMIT'), true);
    assert.equal(isCircuitBreakerCode('EQUITY_DATA_UNAVAILABLE'), true);
    // KILL_SWITCH_ACTIVE must never re-trip the breaker (no self-referential loop).
    assert.equal(isCircuitBreakerCode('KILL_SWITCH_ACTIVE'), false);
    assert.equal(isCircuitBreakerCode('RR_BELOW_MINIMUM'), false);
    assert.equal(isCircuitBreakerCode('made_up'), false);
  });
});

describe('m8.6 safety contract — mutation request schemas', () => {
  test('user-scope activation parses with reason only', () => {
    const parsed = killSwitchActivateSchema.safeParse({
      scope: 'user',
      reason: 'incident: data feed suspected stale',
    });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data, { scope: 'user', reason: 'incident: data feed suspected stale' });
  });

  test('user scope refuses a targetId — a client cannot aim at another account', () => {
    for (const schema of [killSwitchActivateSchema, killSwitchClearSchema]) {
      const parsed = schema.safeParse({ scope: 'user', targetId: S2, reason: 'stop somebody else' });
      assert.equal(parsed.success, false);
      if (parsed.success) assert.fail('unreachable');
      const issue = parsed.error.issues.find((i) => i.path[0] === 'targetId');
      assert.ok(issue, 'targetId must be the flagged path');
    }
  });

  test('strategy/profile scopes require targetId (uuid only)', () => {
    assert.equal(killSwitchActivateSchema.safeParse({ scope: 'strategy', reason: 'no target' }).success, false);
    assert.equal(
      killSwitchActivateSchema.safeParse({ scope: 'strategy', targetId: S1, reason: 'review this strategy' }).success,
      true,
    );
    assert.equal(
      killSwitchClearSchema.safeParse({ scope: 'execution_profile', targetId: 'not-a-uuid', reason: 'clear' }).success,
      false,
    );
  });

  test('global scope cannot even be parsed into a mutation body', () => {
    const parsed = killSwitchActivateSchema.safeParse({ scope: 'global', reason: 'stop the platform' });
    assert.equal(parsed.success, false);
    assert.equal(killSwitchClearSchema.safeParse({ scope: 'global', reason: 'resume the platform' }).success, false);
  });

  test('reason is required, bounded 3..400, and markdown/HTML-hostile characters are refused', () => {
    assert.equal(killSwitchActivateSchema.safeParse({ scope: 'user' }).success, false);
    assert.equal(killSwitchActivateSchema.safeParse({ scope: 'user', reason: 'ab' }).success, false);
    assert.equal(killSwitchActivateSchema.safeParse({ scope: 'user', reason: 'x'.repeat(401) }).success, false);
    assert.equal(killSwitchActivateSchema.safeParse({ scope: 'user', reason: '<script>alert(1)</script>' }).success, false);
    assert.equal(killSwitchActivateSchema.safeParse({ scope: 'user', reason: '  padded reason  ' }).data?.reason, 'padded reason');
  });

  test('unknown fields are refused (strict) — no price/size/approval smuggling', () => {
    assert.equal(
      killSwitchActivateSchema.safeParse({ scope: 'user', reason: 'ok reason', approved: true }).success,
      false,
    );
    assert.equal(
      killSwitchActivateSchema.safeParse({ scope: 'user', reason: 'ok reason', entryPrice: 1.2 }).success,
      false,
    );
  });

  test('emergency-stop body is optional and strict; the default reason is recorded', () => {
    assert.deepEqual(emergencyStopSchema.parse({}), {});
    assert.equal(emergencyStopSchema.safeParse({ reason: 'vendor outage' }).success, true);
    assert.equal(emergencyStopSchema.safeParse({ resume: true }).success, false);
    assert.ok(EMERGENCY_STOP_DEFAULT_REASON.toLowerCase().includes('emergency stop'));
  });

  test('event-list query bounds the limit like every other list', () => {
    assert.equal(killSwitchEventListQuerySchema.parse({}).limit, 50);
    assert.equal(killSwitchEventListQuerySchema.safeParse({ limit: '200' }).success, true);
    assert.equal(killSwitchEventListQuerySchema.safeParse({ limit: 201 }).success, false);
    assert.equal(killSwitchEventListQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(killSwitchEventListQuerySchema.safeParse({ scope: 'user' }).success, false);
  });
});

/* -------------------------------------------------------------------------- */
/* DTO shapes — strict, credential-free                                         */
/* -------------------------------------------------------------------------- */

const entry: KillSwitchEntryDto = {
  scope: 'user',
  targetId: S1,
  entityLabel: null,
  active: true,
  source: 'circuit_breaker',
  reason: 'Risk circuit breaker: DAILY_LOSS_LIMIT reached',
  activatedAt: '2026-09-17T10:00:00.000Z',
  updatedAt: '2026-09-17T10:00:00.000Z',
};

const status: KillSwitchStatusDto = {
  safetyVersion: SAFETY_CONTROLS_VERSION,
  architectureVersion: EXECUTION_ARCHITECTURE_VERSION,
  globalForcedByEnvironment: false,
  global: { ...entry, scope: 'global', targetId: null, entityLabel: 'platform', active: false, source: 'operator', reason: null, activatedAt: null },
  user: entry,
  strategies: [
    (() => {
      const { scope: _scope, ...rest } = entry;
      void _scope;
      return { ...rest, strategyId: S2, targetId: S2, entityLabel: 'London breakout', active: false, source: 'operator', reason: null, activatedAt: null };
    })(),
  ],
  profiles: [
    (() => {
      const { scope: _scope, ...rest } = entry;
      void _scope;
      return {
        ...rest,
        targetId: '33333333-3333-4333-8333-333333333333',
        executionProfileId: '33333333-3333-4333-8333-333333333333',
        providerSlug: 'paper',
        environment: 'paper',
        entityLabel: 'paper',
        active: false,
        source: 'operator',
        reason: null,
        activatedAt: null,
      };
    })(),
  ],
  anyActive: true,
  circuitBreaker: { active: true, trippedAt: '2026-09-17T10:00:00.000Z', reason: 'Risk circuit breaker: DAILY_LOSS_LIMIT reached' },
  automation: { entitled: false, automationEnabled: false, effective: false },
};

describe('m8.6 safety contract — DTO schemas', () => {
  test('entry DTO pins the full state incl. provenance fields', () => {
    const parsed = killSwitchEntryDtoSchema.safeParse(entry);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
    assert.equal(killSwitchEntryDtoSchema.safeParse({ ...entry, password: 'x' }).success, false);
    assert.equal(killSwitchEntryDtoSchema.safeParse({ ...entry, source: 'ceo' }).success, false);
  });

  test('status DTO parses the sample and refuses extra keys', () => {
    const parsed = killSwitchStatusDtoSchema.safeParse(status);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
    assert.equal(killSwitchStatusDtoSchema.safeParse({ ...status, brokerApiKey: 'x' }).success, false);
  });

  test('status DTO requires the breaker + automation summaries', () => {
    const { circuitBreaker: _cb, ...withoutBreaker } = status;
    assert.equal(killSwitchStatusDtoSchema.safeParse(withoutBreaker).success, false);
    const { automation: _a, ...withoutAutomation } = status;
    assert.equal(killSwitchStatusDtoSchema.safeParse(withoutAutomation).success, false);
  });

  test('event DTO allows changed=false (attempt recorded, state unchanged)', () => {
    const parsed = killSwitchEventDtoSchema.safeParse({
      id: '42',
      scope: 'execution_profile',
      targetId: S2,
      entityLabel: 'paper',
      action: 'activated',
      source: 'user',
      reason: 'already armed; redundant call',
      changed: false,
      createdAt: '2026-09-17T10:05:00.000Z',
    });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues ?? {}));
    assert.equal(
      killSwitchEventDtoSchema.safeParse({ id: '1', scope: 'user', action: 'deleted', source: 'user', changed: true, createdAt: 'x' }).success,
      false,
    );
  });

  test('mutation result wraps the refreshed status; emergency result pins stopped=true', () => {
    assert.equal(
      killSwitchMutationResultDtoSchema.safeParse({ action: 'activated', changed: true, status }).success,
      true,
    );
    assert.equal(
      emergencyStopResultDtoSchema.safeParse({
        stopped: true,
        killSwitchActivated: true,
        automationWasEnabled: false,
        automationDisabled: false,
        profilesDisabled: 1,
        status,
      }).success,
      true,
    );
    // `stopped: false` is not a thing — the endpoint either works or errors.
    assert.equal(
      emergencyStopResultDtoSchema.safeParse({
        stopped: false,
        killSwitchActivated: false,
        automationWasEnabled: false,
        automationDisabled: false,
        profilesDisabled: 0,
        status,
      }).success,
      false,
    );
  });
});
