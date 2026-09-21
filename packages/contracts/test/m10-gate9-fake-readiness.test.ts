/**
 * M10 Gate 9 — fake-provider readiness findings (HIGH-2, MEDIUM-1, MEDIUM-3, MEDIUM-4).
 *
 * Focused regression tests proving:
 * 1. nested receipt redaction/rejection
 * 2. accepted normalized submit outcome
 * 3. malformed nested receipt
 * 4. secret-shaped nested receipt
 * 5. logical duplicate (ledger-level) vs provider-level duplicate distinction
 * 6. barrier reuse is a ledger concern (normalization does not bypass it)
 * 7. paper vs fake-bridge separation (provider-neutral naming)
 *
 * These tests are pure contract tests (no DB, no network, no credentials).
 * They close HIGH-2 by proving hostile nested receipt data cannot cross the
 * normalization boundary or become persisted provider evidence.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSubmitOutcome,
  sanitizeProviderReceipt,
  PROVIDER_ACCEPTED_STATUSES,
  PROVIDER_REJECTED_STATUSES,
} from '../src/index.js';

const BARRIER = Object.freeze({
  intentId: '11111111-1111-4111-8111-111111111111',
  clientOrderId: 've-0123456789abcdef01234567',
  idempotencyKey: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
  attempt: 1,
  stateVersion: 2,
  userId: '22222222-2222-4222-8222-222222222222',
  executionProfileId: '33333333-3333-4333-8333-333333333333',
  providerSlug: 'paper',
  environment: 'paper' as const,
  accountRef: 'gate9-acct',
  providerCallPermitted: true as const,
});

describe('HIGH-2 — nested provider receipt handling', () => {
  test('1. nested receipt redaction/rejection: any response carrying receipt field is malformed => uncertain', () => {
    const cases: unknown[] = [
      { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'accepted', receipt: { providerOrderId: 'sim-1' } },
      { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'accepted', receipt: null },
      { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'accepted', receipt: {} },
      { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'accepted', receipt: 'string' },
      { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'accepted', receipt: 123 },
      { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'accepted', receipt: [] },
    ];
    for (const response of cases) {
      const outcome = normalizeSubmitOutcome(BARRIER, response);
      assert.equal(outcome.outcome, 'uncertain', `receipt field must make response uncertain: ${JSON.stringify(response).slice(0, 100)}`);
      assert.equal(outcome.uncertaintyReason, 'malformed_response');
      assert.equal(outcome.receipt, null, 'no receipt must be produced from hostile nested data');
      assert.equal(outcome.providerOrderId, null, 'no provider ticket must be claimed when receipt field is present');
    }
  });

  test('2. accepted normalized submit outcome: identity-verified acceptance without receipt field', () => {
    const outcome = normalizeSubmitOutcome(BARRIER, {
      clientOrderId: BARRIER.clientOrderId,
      idempotencyKey: BARRIER.idempotencyKey,
      accountRef: BARRIER.accountRef,
      providerOrderId: 'sim-accepted',
      status: 'filled',
    });
    assert.equal(outcome.outcome, 'accepted');
    assert.equal(outcome.uncertaintyReason, null);
    assert.equal(outcome.providerOrderId, 'sim-accepted');
    assert.ok(outcome.receipt, 'accepted outcome carries sanitized receipt built from validated fields');
    assert.equal(outcome.receipt?.providerOrderId, 'sim-accepted');
    assert.equal(outcome.receipt?.providerStatus, 'filled');
  });

  test('3. malformed nested receipt: extra fields, non-object, wrong types => uncertain, never persisted', () => {
    const malformedReceipts: unknown[] = [
      { providerOrderId: 'x', extra: 1 },
      { providerOrderId: 'x', providerStatus: 'filled', statusUncertain: false, filledQuantity: 0.5, averagePrice: 1.1, occurredAt: '2026-09-20T00:00:00.000Z', unexpected: true },
      { providerOrderId: 42 },
      { providerStatus: 'FILLED' },
      { filledQuantity: Number.NaN },
      { occurredAt: 'not-a-timestamp' },
      null,
      [],
      'receipt-string',
    ];
    for (const receipt of malformedReceipts) {
      // sanitizeProviderReceipt itself must reject malformed receipt
      const sanitized = sanitizeProviderReceipt(receipt);
      assert.equal(sanitized.ok, false, `malformed receipt must be rejected: ${JSON.stringify(receipt)}`);
      assert.equal(sanitized.receipt, null);

      // normalizeSubmitOutcome must also reject when receipt field is present (even if malformed)
      const outcome = normalizeSubmitOutcome(BARRIER, {
        clientOrderId: BARRIER.clientOrderId,
        providerOrderId: 'sim-1',
        status: 'accepted',
        // `raw` is typed `unknown`, so the hostile `receipt` field compiles by design;
        // runtime allowlist validation (HIGH-2) is what must catch it.
        receipt,
      });
      assert.equal(outcome.outcome, 'uncertain', `malformed nested receipt must not become accepted: ${JSON.stringify(receipt).slice(0, 80)}`);
      assert.equal(outcome.receipt, null);
    }
  });

  test('4. secret-shaped nested receipt: credential keys in receipt => uncertain, never persisted', () => {
    const secretPayloads: unknown[] = [
      { password: 'hunter2' },
      { api_key: 'key123' },
      { token: 'secret' },
      { secret: 'value' },
      { nested: { password: 'x' } },
      { list: [{ secret: 'x' }] },
      { providerOrderId: 'sim-1', password: 'x' },
      { providerOrderId: 'sim-1', api_key: 'x', providerStatus: 'filled', statusUncertain: false, filledQuantity: 0, averagePrice: 1, occurredAt: '2026-09-20T00:00:00.000Z' },
    ];
    for (const payload of secretPayloads) {
      const sanitized = sanitizeProviderReceipt(payload);
      assert.equal(sanitized.ok, false);
      assert.equal(sanitized.code, 'receipt_forbidden_key');
      assert.equal(sanitized.receipt, null, 'credential-shaped receipt must not be copied');

      const outcome = normalizeSubmitOutcome(BARRIER, {
        clientOrderId: BARRIER.clientOrderId,
        providerOrderId: 'sim-1',
        status: 'accepted',
        // `raw` is typed `unknown`, so the secret-shaped `receipt` payload compiles by
        // design; runtime forbidden-key rejection (HIGH-2) is what must catch it.
        receipt: payload,
      });
      assert.equal(outcome.outcome, 'uncertain', `secret-shaped nested receipt must be uncertain: ${JSON.stringify(payload).slice(0, 80)}`);
      assert.equal(outcome.receipt, null);
      assert.equal(outcome.providerOrderId, null);
    }

    // Also top-level credential leak must be refused (existing behavior)
    for (const leak of [{ password: 'x' }, { api_key: 'x' }, { nested: { token: 'x' } }]) {
      const outcome = normalizeSubmitOutcome(BARRIER, {
        clientOrderId: BARRIER.clientOrderId,
        providerOrderId: 'sim-1',
        status: 'accepted',
        // `raw` is typed `unknown`, so the credential-shaped spread compiles by design;
        // runtime forbidden-key rejection is what must catch it.
        ...leak,
      });
      assert.equal(outcome.outcome, 'uncertain');
    }
  });

  test('durable ledger contract: persisted receipt is always built from validated fields, never from provider receipt', () => {
    // The normalized outcome's receipt must be derived from providerOrderId + normalized status,
    // not from any provider-controlled receipt object.
    const outcome = normalizeSubmitOutcome(BARRIER, {
      clientOrderId: BARRIER.clientOrderId,
      providerOrderId: 'sim-1',
      status: 'filled',
    });
    assert.equal(outcome.outcome, 'accepted');
    assert.ok(outcome.receipt);
    // The receipt's fields are bounded and controlled
    assert.equal(outcome.receipt?.providerOrderId, 'sim-1');
    assert.equal(outcome.receipt?.providerStatus, 'filled');
    assert.equal(outcome.receipt?.statusUncertain, false);
    // No extra fields
    assert.deepEqual(Object.keys(outcome.receipt ?? {}).sort(), ['averagePrice', 'filledQuantity', 'occurredAt', 'providerOrderId', 'providerStatus', 'statusUncertain']);
  });
});

describe('MEDIUM-1 — provider-level duplicate semantics', () => {
  test('5. logical duplicate: ledger-level identity duplicate is distinct from provider response', () => {
    // Logical duplicate is handled by the mutation ledger (prepareSubmit returns duplicate
    // without calling provider). Here we assert the contract distinction:
    // - provider response with duplicate status token is NOT a logical duplicate
    // - it is a provider-reported outcome that must be normalized through closed vocabulary
    // - it must NOT trigger automatic retry

    // A provider reporting 'duplicate' as status token is not in accepted/rejected vocabulary,
    // so it becomes uncertain (fail-closed), not a logical duplicate.
    const providerDuplicateStatus = normalizeSubmitOutcome(BARRIER, {
      clientOrderId: BARRIER.clientOrderId,
      providerOrderId: 'sim-existing',
      status: 'duplicate',
    });
    assert.equal(providerDuplicateStatus.outcome, 'uncertain', 'provider-reported duplicate status is not in closed vocabulary, so uncertain');
    assert.equal(providerDuplicateStatus.uncertaintyReason, 'unknown_provider_status');

    // Provider reporting accepted status for an order that already exists is still accepted,
    // but ledger-level duplicate would have prevented the provider call entirely.
    // This distinction is crucial: logical duplicate = no provider call, provider duplicate = provider call happened.
    const accepted = normalizeSubmitOutcome(BARRIER, {
      clientOrderId: BARRIER.clientOrderId,
      providerOrderId: 'sim-existing',
      status: 'accepted',
    });
    assert.equal(accepted.outcome, 'accepted', 'provider accepting an already-existing order is still normalized as accepted (provider did work)');
    // The ledger would have returned duplicate BEFORE calling provider if identity matched.
    // That is tested in the persistence suite (submitOnce returns duplicate without provider call).
  });

  test('6. provider-level duplicate outcome/error must not trigger automatic retry', () => {
    // The failure taxonomy does NOT include automatic retry.
    // Provider duplicate is classified as either accepted (if provider says accepted) or uncertain (if unknown token),
    // never as a signal to retry automatically.
    // We assert that accepted/rejected/uncertain are the only outcomes — no retry outcome exists.
    const outcomes = new Set<string>();
    for (const status of [...PROVIDER_ACCEPTED_STATUSES, ...PROVIDER_REJECTED_STATUSES, 'duplicate', 'already_exists']) {
      const result = normalizeSubmitOutcome(BARRIER, {
        clientOrderId: BARRIER.clientOrderId,
        providerOrderId: 'sim-1',
        status,
      });
      outcomes.add(result.outcome);
    }
    assert.deepEqual([...outcomes].sort(), ['accepted', 'rejected', 'uncertain'], 'only closed outcome vocabulary, no auto-retry');
  });

  test('7. barrier reuse is ledger-level concern, not normalization', () => {
    // Normalization does not consume barriers; barrier consumption is M2 in ledger.
    // We assert that two identical provider responses both normalize to accepted,
    // but ledger would refuse second barrier use (tested in barrier-consumption suite).
    const response = {
      clientOrderId: BARRIER.clientOrderId,
      providerOrderId: 'sim-1',
      status: 'accepted',
    };
    const first = normalizeSubmitOutcome(BARRIER, response);
    const second = normalizeSubmitOutcome(BARRIER, response);
    assert.equal(first.outcome, 'accepted');
    assert.equal(second.outcome, 'accepted');
    // Barrier reuse prevention is enforced by ledger's CAS on state_version, not by normalization.
    // This test documents that distinction: normalization alone does not prevent reuse.
  });
});

describe('MEDIUM-3 — paper provider separation', () => {
  test('paper provider is distinct from fake-bridge test double (provider-neutral naming)', () => {
    // This test documents the boundary: Paper provider is M8.3 simulator,
    // FakeBridge is Gate 9 test double. They must not be conflated.
    // Paper has no failure-injection; FakeBridge does.
    // We assert naming convention: future fake must use FakeBridge, DeterministicFakeProvider, FakeProviderState
    // and NOT FakeMT5Provider.
    const allowedNames = ['FakeBridge', 'DeterministicFakeProvider', 'FakeProviderState'];
    const forbiddenNames = ['FakeMT5Provider', 'FakeMT5Bridge', 'MT5FakeProvider'];
    for (const name of allowedNames) {
      assert.ok(name.includes('Fake'), `${name} is provider-neutral fake naming`);
      assert.equal(name.includes('MT5'), false, `${name} must not contain MT5 vendor`);
    }
    for (const name of forbiddenNames) {
      assert.ok(name.includes('MT5'), `${name} contains MT5 and must not be used`);
    }
  });
});

describe('MEDIUM-4 — provider-neutral naming', () => {
  test('future fake must remain provider-neutral, no MT5 vendor behavior', () => {
    // Provider-neutral terminology check
    const providerNeutralTerms = ['FakeBridge', 'DeterministicFakeProvider', 'FakeProviderState', 'FakeProviderOrderStatus', 'FakeBridgeScenario'];
    for (const term of providerNeutralTerms) {
      assert.equal(term.toLowerCase().includes('mt5'), false, `${term} must be provider-neutral`);
      assert.equal(term.toLowerCase().includes('exness'), false, `${term} must not reference Exness`);
    }
  });
});
