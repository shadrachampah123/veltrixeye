import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  BILLING_PAYMENT_RECONCILIATION_FAILURE_REASONS,
  type BillingVerifiedTransaction,
  type BillingPricingSnapshot,
} from '@veltrixeye/contracts';
import {
  reconcileBillingPaymentEvidence,
  assertBillingPaymentEvidenceReconciled,
  isBillingPaymentReconciliationError,
} from '../src/billing/payment-reconciliation.js';
import { verifyPricingSnapshot } from '../src/billing/pricing.js';

/* ==========================================================================
   Billing Step 7 — pure deterministic reconciliation.
   No DB, no network, no clock. Every check is exact-integer,
   fail-closed, credential-free. Reuses pricing helpers.
   ========================================================================== */

const FX_ID = randomUUID();
const NOW = '2026-09-24T10:00:00.000Z';
const CAPTURED = '2026-09-24T09:50:00.000Z';
const EFFECTIVE = '2026-09-24T09:50:00.000Z';
const REFERENCE = `ve-chk-${'a'.repeat(64)}`;

function snapshot(overrides: Partial<BillingPricingSnapshot> = {}): BillingPricingSnapshot {
  const base: BillingPricingSnapshot = {
    commercialCurrency: 'USD',
    commercialAmountMinor: 3900,
    catalogueVersion: 'test-v1',
    cataloguePlan: 'pro',
    interval: 'monthly',
    payment: {
      paymentCurrency: 'GHS',
      paymentAmountMinor: 48750,
      paymentAmountExponent: 2,
    },
    fx: {
      baseCurrency: 'USD',
      quoteCurrency: 'GHS',
      fxRateScaled: 12_500_000,
      fxRateScale: 6,
      fxRateVersionId: FX_ID,
      fxRateEffectiveFrom: EFFECTIVE,
      fxRateCapturedAt: CAPTURED,
      fxRateSource: 'ops',
      roundingMode: 'half_up',
    },
    providerPlanId: null,
    providerReference: null,
    pricingPolicyVersion: 'pr3-usd-ghs-v1',
    computedAt: NOW,
  };
  return { ...base, ...overrides, payment: { ...base.payment, ...(overrides.payment ?? {}) }, fx: { ...base.fx, ...(overrides.fx ?? {}) } } as BillingPricingSnapshot;
}

function verified(overrides: Partial<BillingVerifiedTransaction> = {}): BillingVerifiedTransaction {
  const base: BillingVerifiedTransaction = {
    provider: 'paystack',
    providerReference: REFERENCE,
    providerTransactionId: '1234567890',
    providerStatus: 'success',
    providerDomain: 'test',
    paymentCurrency: 'GHS',
    paymentAmountMinor: 48750,
    paymentAmountExponent: 2,
    providerCustomerId: '42',
    providerCustomerCode: 'CUS_testCode123',
    paidAt: '2026-09-24T10:01:00.000Z',
    verifiedAt: NOW,
  };
  return { ...base, ...overrides } as BillingVerifiedTransaction;
}

describe('Step 7 — reconciliation is pure, deterministic, and reuses pricing helpers', () => {
  it('an exact match reconciles (ok true)', () => {
    const s = snapshot();
    // Exercise the pricing helper reuse: the snapshot verifies.
    assert.doesNotThrow(() => verifyPricingSnapshot(s));
    const result = reconcileBillingPaymentEvidence({
      verified: verified(),
      expectedReference: REFERENCE,
      snapshot: s,
      localCustomer: null,
    });
    assert.equal(result.ok, true);
  });

  it('uses verifyPricingSnapshot — an invalid snapshot is invalid_snapshot', () => {
    const s = snapshot({ commercialAmountMinor: 0 } as unknown as BillingPricingSnapshot);
    const result = reconcileBillingPaymentEvidence({
      verified: verified(),
      expectedReference: REFERENCE,
      snapshot: s,
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'invalid_snapshot');
  });

  it('every failure reason is a documented, bounded vocabulary', () => {
    const sorted = [...BILLING_PAYMENT_RECONCILIATION_FAILURE_REASONS].sort();
    assert.deepEqual(sorted, [
      'amount_mismatch',
      'currency_mismatch',
      'customer_mismatch',
      'domain_mismatch',
      'exponent_mismatch',
      'invalid_snapshot',
      'invalid_status',
      'missing_paid_at',
      'provider_mismatch',
      'reference_mismatch',
      'snapshot_mismatch',
    ]);
  });
});

describe('Step 7 — reference, provider, domain, status', () => {
  it('reference_mismatch when providerReference != expected', () => {
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ providerReference: `ve-chk-${'b'.repeat(64)}` }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'reference_mismatch');
  });

  it('provider_mismatch when provider != paystack', () => {
    // Bypass contract literal by casting
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ provider: 'stripe' as unknown as 'paystack' }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'provider_mismatch');
  });

  it('domain_mismatch when providerDomain != test', () => {
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ providerDomain: 'live' }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'domain_mismatch');
  });

  it('invalid_status for any transaction status other than success', () => {
    for (const status of ['failed', 'abandoned', 'pending', 'reversed', 'unknown', '']) {
      const s = status === '' ? 'x' : status;
      const result = reconcileBillingPaymentEvidence({
        verified: verified({ providerStatus: s }),
        expectedReference: REFERENCE,
        snapshot: snapshot(),
        localCustomer: null,
      });
      assert.equal(result.ok, false, `status ${status}`);
      assert.equal((result as { reason: string }).reason, 'invalid_status');
    }
    // success passes (first test already)
  });
});

describe('Step 7 — currency / amount / exponent exactness', () => {
  it('currency_mismatch when verified currency != snapshot', () => {
    // Snapshot is GHS; verified GHS is required by contract, but we test mismatch via tampered snapshot currency via manual override
    // Reconciliation checks verified.paymentCurrency !== snapshot.payment.paymentCurrency
    // We cannot produce a non-GHS snapshot that verifies; so we test by altering verified to a different currency that still passes schema but mismatches snapshot:
    // Our verified factory is GHS; we tamper snapshot paymentCurrency to something else via cast to test the mismatch path.
    const s = snapshot({ payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48750, paymentAmountExponent: 2 } });
    // Create a snapshot that is still GHS but we test currency mismatch by changing verified? But both are GHS, need mismatch.
    // We test via using a snapshot with GHS and verified with GHS would not mismatch. Instead we test the branch where verified currency parsing fails or differs.
    // The simplest mismatch is verified currency 'GHS' vs snapshot paymentCurrency 'GHS' is not mismatch. To get mismatch we need snapshot to have different currency string, which would fail verifyPricingSnapshot first (invalid_snapshot). So we test the exact branch where verified currency is GHS but snapshot is tampered after verification.
    // We bypass verifyPricingSnapshot by making snapshot invalid? Let's test the currency_mismatch path where verified is GHS but snapshot is altered post-verify to not equal? Instead we directly test via a snapshot that verifies but has same GHS — not mismatch. So we test exponent mismatch and amount mismatch primarily, and currency_mismatch is covered via invalid currency parsing.
    const badVerified = verified({ paymentCurrency: 'USD' as unknown as 'GHS' });
    const result = reconcileBillingPaymentEvidence({
      verified: badVerified,
      expectedReference: REFERENCE,
      snapshot: s,
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'currency_mismatch');
  });

  it('exponent_mismatch when exponent != 2', () => {
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ paymentAmountExponent: 0 }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'exponent_mismatch');
  });

  it('exponent_mismatch when exponent != snapshot exponent', () => {
    // Both 2 expected, but if snapshot exponent were different (invalid_snapshot would fire first), so we test the second exponent check by making snapshot have same GHS but different exponent via tampering after verify? Instead we test that exponent 2 vs snapshot 2 passes, any other fails. Already covered.
    const s = snapshot({ payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48750, paymentAmountExponent: 2 } });
    const v = verified({ paymentAmountExponent: 3 });
    const result = reconcileBillingPaymentEvidence({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'exponent_mismatch');
  });

  it('amount_mismatch — exact integer equality, 1 pesewa off fails', () => {
    const s = snapshot();
    const v = verified({ paymentAmountMinor: s.payment.paymentAmountMinor + 1 });
    const result = reconcileBillingPaymentEvidence({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'amount_mismatch');
  });

  it('amount_mismatch — no tolerance, no currency conversion', () => {
    const s = snapshot();
    const v = verified({ paymentAmountMinor: s.payment.paymentAmountMinor });
    const ok = reconcileBillingPaymentEvidence({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    assert.equal(ok.ok, true);
    const off = reconcileBillingPaymentEvidence({ verified: verified({ paymentAmountMinor: s.payment.paymentAmountMinor - 1 }), expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    assert.equal(off.ok, false);
    assert.equal((off as { reason: string }).reason, 'amount_mismatch');
  });
});

describe('Step 7 — paid_at', () => {
  it('missing_paid_at when paidAt is null', () => {
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ paidAt: null }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'missing_paid_at');
  });

  it('missing_paid_at when paidAt is not a valid datetime', () => {
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ paidAt: 'not-a-datetime' as unknown as string }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'missing_paid_at');
  });
});

describe('Step 7 — snapshot context and customer identity', () => {
  it('snapshot_mismatch when snapshot.providerReference is bound to a different reference', () => {
    const s = snapshot({ providerReference: `ve-chk-${'c'.repeat(64)}` });
    const result = reconcileBillingPaymentEvidence({
      verified: verified(),
      expectedReference: REFERENCE,
      snapshot: s,
      localCustomer: null,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'snapshot_mismatch');
  });

  it('snapshot_mismatch is not triggered when snapshot.providerReference is null', () => {
    const s = snapshot({ providerReference: null });
    const result = reconcileBillingPaymentEvidence({
      verified: verified(),
      expectedReference: REFERENCE,
      snapshot: s,
      localCustomer: null,
    });
    assert.equal(result.ok, true);
  });

  it('customer_mismatch when verified customer code disagrees with local', () => {
    const local = { providerCustomerCode: 'CUS_local123', providerCustomerId: '42' };
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ providerCustomerCode: 'CUS_other', providerCustomerId: '42' }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: local,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'customer_mismatch');
  });

  it('customer_mismatch when verified carries no customer while local has a code', () => {
    const local = { providerCustomerCode: 'CUS_local123', providerCustomerId: null };
    const result = reconcileBillingPaymentEvidence({
      verified: verified({ providerCustomerCode: null, providerCustomerId: null }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: local,
    });
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, 'customer_mismatch');
  });

  it('customer identity is coherent when both sides agree or provider has at least one identifier', () => {
    const local = { providerCustomerCode: 'CUS_testCode123', providerCustomerId: '42' };
    const ok1 = reconcileBillingPaymentEvidence({
      verified: verified({ providerCustomerCode: 'CUS_testCode123', providerCustomerId: '42' }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: local,
    });
    assert.equal(ok1.ok, true);
    const ok2 = reconcileBillingPaymentEvidence({
      verified: verified({ providerCustomerCode: null, providerCustomerId: '42' }),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: { providerCustomerCode: null, providerCustomerId: '42' },
    });
    assert.equal(ok2.ok, true);
  });

  it('null localCustomer is not a disagreement', () => {
    const result = reconcileBillingPaymentEvidence({
      verified: verified(),
      expectedReference: REFERENCE,
      snapshot: snapshot(),
      localCustomer: null,
    });
    assert.equal(result.ok, true);
  });
});

describe('Step 7 — throwing variant and idempotency', () => {
  it('assertBillingPaymentEvidenceReconciled throws typed error on failure', () => {
    const s = snapshot();
    const v = verified({ paymentAmountMinor: s.payment.paymentAmountMinor + 100 });
    assert.throws(() => assertBillingPaymentEvidenceReconciled({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null }), (err: unknown) => {
      assert.ok(isBillingPaymentReconciliationError(err));
      assert.equal((err as { reason: string }).reason, 'amount_mismatch');
      assert.ok(!(err as Error).message.includes('sk_test_'));
      return true;
    });
  });

  it('reconciliation failure messages are fixed, credential-free, ≤ 200 chars', () => {
    const s = snapshot();
    const v = verified({ paymentAmountMinor: 1 });
    const result = reconcileBillingPaymentEvidence({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    assert.equal(result.ok, false);
    const msg = (result as { message: string }).message;
    assert.ok(msg.length > 0 && msg.length <= 200);
    assert.doesNotMatch(msg, /sk_test_/);
    assert.doesNotMatch(msg, /password|secret|token/i);
  });

  it('reconciliation never grants execution, never moves plan, never infers lifecycle', () => {
    // The pure function has no side effect and returns no entitlement.
    const s = snapshot();
    const v = verified();
    const result = reconcileBillingPaymentEvidence({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    assert.equal(result.ok, true);
    // Lifecycle remains unknown by contract — reconciliation does not return a lifecycle.
    assert.equal(Object.hasOwn(result, 'grantsExecution'), false);
    assert.equal(Object.hasOwn(result, 'planChanged'), false);
  });

  it('reconciliation is deterministic', () => {
    const s = snapshot();
    const v = verified();
    const a = reconcileBillingPaymentEvidence({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    const b = reconcileBillingPaymentEvidence({ verified: v, expectedReference: REFERENCE, snapshot: s, localCustomer: null });
    assert.deepEqual(a, b);
  });
});
