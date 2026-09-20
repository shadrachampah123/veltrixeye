/**
 * M10 Gate 9 — provider-mutation persistence contract tests.
 *
 * Pure, deterministic contract tests for the vocabulary and the
 * normalization/sanitization rules the durable ledger relies on:
 *
 *  - the intent state machine (§3) and the reservation rules (§4);
 *  - outcome normalization (§5): unknown is never rejection;
 *  - receipt sanitization (§11): credential-shaped keys are rejected, not
 *    redacted, and only allowlisted scalars survive;
 *  - canonical request identity (§6) — browser-safe canonicalization only;
 *  - the reference-only credential boundary (§11).
 *
 * Note: Node-specific sha-256 hashing (`canonicalMutationRequestHash`) was
 * moved to `@veltrixeye/core` to keep `@veltrixeye/contracts` browser-safe
 * (Vercel build regression). Contracts now tests only the stable canonical
 * form; hashing semantics are verified in core.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeMutationRequest,
  isMutationIdentityHash,
  isProviderIntentTerminal,
  isProviderIntentTransitionAllowed,
  isProviderIntentUnresolved,
  isProviderReservationTransitionAllowed,
  normalizeSubmitOutcome,
  providerCredentialBindingSchema,
  PROVIDER_INTENT_STATES,
  PROVIDER_MUTATION_OUTCOMES,
  PROVIDER_MUTATION_RESERVATION_STATES,
  PROVIDER_MUTATION_SECRET_MANAGER_INTEGRATED,
  PROVIDER_RESOLUTIONS,
  PROVIDER_UNCERTAINTY_REASONS,
  sanitizeProviderReceipt,
  verifyProviderResponseIdentity,
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

describe('Gate 9 §3 — intent state machine', () => {
  test('the vocabulary is exactly the contract states', () => {
    assert.deepEqual([...PROVIDER_INTENT_STATES], ['prepared', 'submitting', 'confirmed', 'rejected', 'uncertain', 'reconciled']);
  });

  test('only the documented transitions are allowed', () => {
    assert.equal(isProviderIntentTransitionAllowed('prepared', 'submitting'), true);
    assert.equal(isProviderIntentTransitionAllowed('submitting', 'confirmed'), true);
    assert.equal(isProviderIntentTransitionAllowed('submitting', 'rejected'), true);
    assert.equal(isProviderIntentTransitionAllowed('submitting', 'uncertain'), true);
    assert.equal(isProviderIntentTransitionAllowed('uncertain', 'reconciled'), true);
    // Operator resolution of an intent that crashed in flight.
    assert.equal(isProviderIntentTransitionAllowed('submitting', 'reconciled'), true);
  });

  test('a terminal state never returns to prepared or submitting', () => {
    for (const state of ['confirmed', 'rejected', 'reconciled'] as const) {
      for (const target of ['prepared', 'submitting', 'uncertain'] as const) {
        assert.equal(isProviderIntentTransitionAllowed(state, target), false, `${state} -> ${target}`);
      }
      assert.equal(isProviderIntentTerminal(state), true);
    }
    // An uncertain intent is unresolved, not terminal.
    assert.equal(isProviderIntentTerminal('uncertain'), false);
    assert.equal(isProviderIntentUnresolved('uncertain'), true);
    assert.equal(isProviderIntentUnresolved('prepared'), true);
    assert.equal(isProviderIntentUnresolved('submitting'), true);
    assert.equal(isProviderIntentUnresolved('confirmed'), false);
  });

  test('an uncertain state can only leave through reconciled', () => {
    for (const target of PROVIDER_INTENT_STATES) {
      const allowed = isProviderIntentTransitionAllowed('uncertain', target);
      assert.equal(allowed, target === 'reconciled', `uncertain -> ${target}`);
    }
  });
});

describe('Gate 9 §4 — mutation reservation rules', () => {
  test('the vocabulary is exactly the contract states', () => {
    assert.deepEqual([...PROVIDER_MUTATION_RESERVATION_STATES], ['reserved', 'known_completed', 'known_rejected', 'uncertain']);
  });

  test('uncertainty may resolve, definitive outcomes are terminal', () => {
    assert.equal(isProviderReservationTransitionAllowed('reserved', 'uncertain'), true);
    assert.equal(isProviderReservationTransitionAllowed('reserved', 'known_completed'), true);
    assert.equal(isProviderReservationTransitionAllowed('reserved', 'known_rejected'), true);
    assert.equal(isProviderReservationTransitionAllowed('uncertain', 'known_completed'), true);
    assert.equal(isProviderReservationTransitionAllowed('uncertain', 'known_rejected'), true);
    // A resolved reservation never returns to reserved (a TTL cannot do that).
    for (const state of ['known_completed', 'known_rejected'] as const) {
      for (const target of PROVIDER_MUTATION_RESERVATION_STATES) {
        assert.equal(isProviderReservationTransitionAllowed(state, target), false, `${state} -> ${target}`);
      }
    }
    assert.equal(isProviderReservationTransitionAllowed('uncertain', 'reserved'), false);
  });
});

describe('Gate 9 §5 — outcome normalization', () => {
  test('an identity-verified acceptance is accepted', () => {
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
    assert.ok(outcome.receipt, 'an acceptance carries a sanitized receipt');
  });

  test('an identity-verified rejection is rejected', () => {
    const outcome = normalizeSubmitOutcome(BARRIER, {
      clientOrderId: BARRIER.clientOrderId,
      providerOrderId: null,
      status: 'rejected',
    });
    assert.equal(outcome.outcome, 'rejected');
    assert.equal(outcome.uncertaintyReason, null);
  });

  test('every unreadable response is uncertain, never rejected', () => {
    const cases: Array<[string, unknown, string]> = [
      ['missing response', null, 'lost_response'],
      ['undefined response', undefined, 'lost_response'],
      ['non-object response', 'accepted', 'malformed_response'],
      ['unknown field', { clientOrderId: BARRIER.clientOrderId, status: 'accepted', unexpected: 1 }, 'malformed_response'],
      ['unknown status token', { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'WEIRD' }, 'unknown_provider_status'],
      ['failed is not a provider status', { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'failed' }, 'unknown_provider_status'],
      ['missing client order id', { providerOrderId: 'sim-1', status: 'accepted' }, 'identity_verification_failed'],
      ['wrong client order id', { clientOrderId: 've-ffffffffffffffffffffffff', providerOrderId: 'sim-1', status: 'accepted' }, 'identity_verification_failed'],
      ['accepted without a ticket', { clientOrderId: BARRIER.clientOrderId, status: 'accepted' }, 'identity_verification_failed'],
      ['case-variant status', { clientOrderId: BARRIER.clientOrderId, providerOrderId: 'sim-1', status: 'FILLED' }, 'unknown_provider_status'],
    ];
    for (const [name, response, reason] of cases) {
      const outcome = normalizeSubmitOutcome(BARRIER, response);
      assert.equal(outcome.outcome, 'uncertain', `${name} must be uncertain`);
      assert.equal(outcome.uncertaintyReason, reason, `${name} reason`);
      assert.equal(outcome.providerOrderId, null, `${name} claims no provider ticket`);
    }
  });

  test('credential material in a provider response is refused, never redacted', () => {
    for (const leak of [{ password: 'x' }, { api_key: 'x' }, { nested: { token: 'x' } }, { list: [{ secret: 'x' }] }]) {
      const outcome = normalizeSubmitOutcome(BARRIER, {
        clientOrderId: BARRIER.clientOrderId,
        providerOrderId: 'sim-1',
        status: 'accepted',
        receipt: leak,
      });
      assert.equal(outcome.outcome, 'uncertain', 'a response we refuse to read cannot be accepted');
    }
  });

  test('the uncertainty vocabulary is closed', () => {
    assert.deepEqual([...PROVIDER_MUTATION_OUTCOMES], ['accepted', 'rejected', 'uncertain']);
    assert.ok(PROVIDER_UNCERTAINTY_REASONS.includes('timeout'));
    assert.ok(PROVIDER_UNCERTAINTY_REASONS.includes('lost_response'));
    assert.ok(PROVIDER_UNCERTAINTY_REASONS.includes('receipt_persistence_failure'));
    assert.ok(PROVIDER_RESOLUTIONS.includes('provider_absent'));
  });
});

describe('Gate 9 §11 — sanitized receipts and the credential boundary', () => {
  test('only allowlisted, type-checked fields survive', () => {
    const result = sanitizeProviderReceipt({
      providerOrderId: 'sim-1',
      providerStatus: 'filled',
      statusUncertain: false,
      filledQuantity: 0.5,
      averagePrice: 1.1,
      occurredAt: '2026-09-20T00:00:00.000Z',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.receipt, {
      providerOrderId: 'sim-1',
      providerStatus: 'filled',
      statusUncertain: false,
      filledQuantity: 0.5,
      averagePrice: 1.1,
      occurredAt: '2026-09-20T00:00:00.000Z',
    });
  });

  test('credential-shaped keys are rejected, not redacted', () => {
    for (const payload of [
      { password: 'hunter2' },
      { api_key: 'k' },
      { nested: { authorization: 'Bearer x' } },
      { list: [{ privateKey: 'k' }] },
    ]) {
      const result = sanitizeProviderReceipt(payload);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'receipt_forbidden_key');
      assert.equal(result.receipt, null, 'nothing is copied');
    }
  });

  test('unexpected or invalid fields are rejected', () => {
    assert.equal(sanitizeProviderReceipt(null).code, 'receipt_not_an_object');
    assert.equal(sanitizeProviderReceipt([]).code, 'receipt_not_an_object');
    assert.equal(sanitizeProviderReceipt({ providerOrderId: 'x', extra: 1 }).code, 'receipt_field_invalid');
    assert.equal(sanitizeProviderReceipt({ providerOrderId: 42 }).code, 'receipt_field_invalid');
    assert.equal(sanitizeProviderReceipt({ providerStatus: 'FILLED' }).code, 'receipt_field_invalid');
    assert.equal(sanitizeProviderReceipt({ filledQuantity: Number.NaN }).code, 'receipt_field_invalid');
    assert.equal(sanitizeProviderReceipt({ occurredAt: 'not-a-timestamp' }).code, 'receipt_field_invalid');
  });

  test('the credential binding is reference-only and never integrated', () => {
    const parsed = providerCredentialBindingSchema.safeParse({
      credentialRef: 'cred-ref-1',
      credentialFingerprint: 'c'.repeat(64),
      environment: 'demo',
      accountRef: 'acct-1',
      brokerServerRef: 'demo-server',
      secretManagerIntegrated: false,
    });
    assert.equal(parsed.success, true);
    assert.equal(PROVIDER_MUTATION_SECRET_MANAGER_INTEGRATED, false, 'no secret manager is wired by Gate 9');
    // A live environment or an "integrated" claim is refused.
    assert.equal(providerCredentialBindingSchema.safeParse({
      credentialRef: null, credentialFingerprint: null, environment: 'live',
      accountRef: null, brokerServerRef: null, secretManagerIntegrated: false,
    }).success, false);
    assert.equal(providerCredentialBindingSchema.safeParse({
      credentialRef: null, credentialFingerprint: null, environment: 'paper',
      accountRef: null, brokerServerRef: null, secretManagerIntegrated: true,
    }).success, false);
  });
});

describe('Gate 9 §6 — canonical request identity (browser-safe)', () => {
  test('the canonical form is stable and order-independent', () => {
    const a = canonicalizeMutationRequest({ clientOrderId: 've-1', symbol: 'EURUSD', nested: { b: 2, a: 1 } });
    const b = canonicalizeMutationRequest({ nested: { a: 1, b: 2 }, symbol: 'EURUSD', clientOrderId: 've-1' });
    assert.equal(a, b);
    assert.equal(canonicalizeMutationRequest({ b: 1, a: [1, 2] }), '{"a":[1,2],"b":1}');
  });

  test('a different request produces a different canonical form', () => {
    const a = canonicalizeMutationRequest({ clientOrderId: 've-1', quantity: 1 });
    const b = canonicalizeMutationRequest({ clientOrderId: 've-1', quantity: 2 });
    assert.notEqual(a, b);
  });

  test('identity hash format is validated', () => {
    assert.equal(isMutationIdentityHash('a'.repeat(64)), true);
    assert.equal(isMutationIdentityHash('not-a-hash'), false);
  });
});

describe('Gate 9 §5 — provider response identity verification', () => {
  test('a response naming another order is not verified', () => {
    assert.equal(verifyProviderResponseIdentity({
      clientOrderId: BARRIER.clientOrderId,
      idempotencyKey: BARRIER.idempotencyKey,
      accountRef: BARRIER.accountRef,
      response: { clientOrderId: 've-ffffffffffffffffffffffff' },
    }).code, 'client_order_id_mismatch');
    assert.equal(verifyProviderResponseIdentity({
      clientOrderId: BARRIER.clientOrderId,
      idempotencyKey: BARRIER.idempotencyKey,
      accountRef: BARRIER.accountRef,
      response: { clientOrderId: BARRIER.clientOrderId, idempotencyKey: 'f'.repeat(64) },
    }).code, 'idempotency_key_mismatch');
    assert.equal(verifyProviderResponseIdentity({
      clientOrderId: BARRIER.clientOrderId,
      idempotencyKey: BARRIER.idempotencyKey,
      accountRef: BARRIER.accountRef,
      response: { clientOrderId: BARRIER.clientOrderId, accountRef: 'another-account' },
    }).code, 'account_binding_mismatch');
    assert.equal(verifyProviderResponseIdentity({
      clientOrderId: BARRIER.clientOrderId,
      idempotencyKey: BARRIER.idempotencyKey,
      accountRef: BARRIER.accountRef,
      response: {},
    }).code, 'missing_client_order_id');
    assert.equal(verifyProviderResponseIdentity({
      clientOrderId: BARRIER.clientOrderId,
      idempotencyKey: BARRIER.idempotencyKey,
      accountRef: BARRIER.accountRef,
      response: { clientOrderId: BARRIER.clientOrderId },
    }).ok, true);
  });
});
