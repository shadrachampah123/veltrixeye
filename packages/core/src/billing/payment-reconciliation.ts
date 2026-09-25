import { z } from 'zod';
import {
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  billingPaymentCurrencySchema,
  type BillingPaymentCurrency,
  type BillingPricingSnapshot,
} from '@veltrixeye/contracts';
import {
  BILLING_PAYMENT_RECONCILIATION_FAILURE_REASONS,
  type BillingPaymentReconciliationFailureReason,
  type BillingVerifiedTransaction,
} from '@veltrixeye/contracts';
import { verifyPricingSnapshot } from './pricing.js';

/**
 * Billing Step 7 — pure, deterministic PAYMENT RECONCILIATION.
 *
 * Compares verified provider transaction facts against the immutable
 * checkout pricing snapshot that authorized the payment. Every check is
 * exact-integer, fail-closed and credential-free.
 *
 * WHAT IT VERIFIES (at minimum, in this order)
 *  - checkout reference matches the expected deterministic reference
 *  - provider is Paystack
 *  - provider domain is test (sandbox)
 *  - transaction status is acceptable for payment evidence (`success` only)
 *  - currency exactly matches the snapshot
 *  - amount exactly matches the snapshot (integer minor units)
 *  - exponent matches (GHS: 2)
 *  - required `paid_at` is present and valid
 *  - pricing snapshot belongs to the same billing context (verifiable &
 *    coherent)
 *  - provider/customer identity is coherent when a local customer is known
 *
 * WHAT IT NEVER DOES
 *  - it never coerces, tolerates or converts. A mismatch is a typed
 *    failure, never a silent pass.
 *  - it never reads the network, the database or the environment: pure
 *    function of its inputs.
 *  - it never infers subscription lifecycle. The verified lifecycle
 *    remains `unknown`; this function confirms a TRANSACTION, never a
 *    subscription state.
 *  - it never grants entitlements or execution. It returns a typed
 *    success/failure, nothing more.
 *
 * Reuses existing pricing validation helpers where appropriate instead of
 * duplicating arithmetic (verifyPricingSnapshot, BILLING_PAYMENT_AMOUNT_EXPONENT).
 */

export class BillingPaymentReconciliationError extends Error {
  readonly code = 'billing_payment_reconciliation_failed' as const;
  constructor(
    readonly reason: BillingPaymentReconciliationFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingPaymentReconciliationError';
  }
}

export function isBillingPaymentReconciliationError(
  error: unknown,
): error is BillingPaymentReconciliationError {
  return error instanceof BillingPaymentReconciliationError;
}

export interface BillingPaymentReconciliationInput {
  /** Verified transaction facts as normalized from the provider. */
  verified: BillingVerifiedTransaction;
  /** Deterministic checkout reference derived from the locked snapshot. */
  expectedReference: string;
  /** Immutable pricing snapshot that authorized the checkout. */
  snapshot: BillingPricingSnapshot;
  /** Local billing customer for the user, when known (for identity coherence). */
  localCustomer?: { providerCustomerId: string | null; providerCustomerCode: string | null } | null;
}

export type BillingPaymentReconciliationOutcome =
  | { ok: true }
  | { ok: false; reason: BillingPaymentReconciliationFailureReason; message: string };

/**
 * Pure, deterministic reconciliation. Returns `{ok: true}` only when EVERY
 * check passes; otherwise the first failure reason (typed) with a fixed,
 * credential-free message.
 */
export function reconcileBillingPaymentEvidence(
  input: BillingPaymentReconciliationInput,
): BillingPaymentReconciliationOutcome {
  const { verified, expectedReference, snapshot, localCustomer } = input;

  // 1. Snapshot must be verifiable and internally coherent (pricing helpers).
  try {
    verifyPricingSnapshot(snapshot);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_snapshot',
      message: `The pricing snapshot is invalid: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }

  // 2. Reference must match the deterministic checkout reference.
  if (verified.providerReference !== expectedReference) {
    return {
      ok: false,
      reason: 'reference_mismatch',
      message: `The provider reference does not match the expected checkout reference.`,
    };
  }

  // 3. Provider must be Paystack (only provider in this build).
  if (verified.provider !== 'paystack') {
    return {
      ok: false,
      reason: 'provider_mismatch',
      message: `The provider is not paystack.`,
    };
  }

  // 4. Domain must be test (sandbox-only).
  if (verified.providerDomain !== 'test') {
    return {
      ok: false,
      reason: 'domain_mismatch',
      message: `The provider domain is not test (sandbox).`,
    };
  }

  // 5. Status must be acceptable for payment evidence. Only `success` is.
  // Paystack documents `success` as the successful transaction status;
  // any other status (failed, abandoned, reversed, etc.) is not evidence.
  if (verified.providerStatus !== 'success') {
    return {
      ok: false,
      reason: 'invalid_status',
      message: `The transaction status is not acceptable for payment evidence: ${verified.providerStatus}`,
    };
  }

  // 6. Currency must exactly match the snapshot (and be GHS, by snapshot validation).
  const currencyParse = billingPaymentCurrencySchema.safeParse(verified.paymentCurrency);
  if (!currencyParse.success || verified.paymentCurrency !== snapshot.payment.paymentCurrency) {
    return {
      ok: false,
      reason: 'currency_mismatch',
      message: `The transaction currency does not match the pricing snapshot.`,
    };
  }

  // 7. Exponent must match (GHS: 2) and must match the snapshot.
  const expectedExponent = BILLING_PAYMENT_AMOUNT_EXPONENT[verified.paymentCurrency as BillingPaymentCurrency];
  if (verified.paymentAmountExponent !== expectedExponent) {
    return {
      ok: false,
      reason: 'exponent_mismatch',
      message: `The transaction exponent does not match ${verified.paymentCurrency} (expected ${expectedExponent}).`,
    };
  }
  if (verified.paymentAmountExponent !== snapshot.payment.paymentAmountExponent) {
    return {
      ok: false,
      reason: 'exponent_mismatch',
      message: `The transaction exponent does not match the snapshot exponent.`,
    };
  }

  // 8. Amount must exactly match the snapshot (integer minor units).
  if (verified.paymentAmountMinor !== snapshot.payment.paymentAmountMinor) {
    return {
      ok: false,
      reason: 'amount_mismatch',
      message: `The transaction amount does not match the authorized snapshot amount.`,
    };
  }

  // 9. Required paid_at must be present and valid.
  if (verified.paidAt === null || verified.paidAt === undefined) {
    return {
      ok: false,
      reason: 'missing_paid_at',
      message: `The transaction is missing required paid_at.`,
    };
  }
  const paidAtParse = z.string().datetime().safeParse(verified.paidAt);
  if (!paidAtParse.success) {
    return {
      ok: false,
      reason: 'missing_paid_at',
      message: `The transaction paid_at is not a valid datetime.`,
    };
  }

  // 10. Snapshot must belong to the same billing context.
  // At minimum the snapshot must be internally coherent (already verified)
  // and its payment currency/amount must have been checked above. We also
  // ensure the snapshot's commercial identity is coherent: a snapshot for
  // a different plan that somehow has the same amount should still be
  // considered a mismatch if the snapshot's idempotency or provider plan
  // does not align with the expected checkout. Since this pure function
  // only knows the snapshot object itself, we treat a snapshot that fails
  // the strict contract as a snapshot_mismatch (already handled as
  // invalid_snapshot). For an otherwise valid snapshot, we consider it a
  // mismatch only when the snapshot's providerReference (if present) is
  // bound to a different reference than the expected one.
  if (
    snapshot.providerReference !== null &&
    snapshot.providerReference !== expectedReference
  ) {
    return {
      ok: false,
      reason: 'snapshot_mismatch',
      message: `The pricing snapshot is bound to a different checkout reference.`,
    };
  }

  // 11. Provider/customer identity must be coherent.
  // When a local customer is known, the verified transaction must either
  // carry no customer identifier (treated as not a disagreement) or carry
  // one that matches the local record. A verified code/id that disagrees
  // with the local billing customer is a mismatch.
  if (localCustomer !== undefined && localCustomer !== null) {
    const localCode = localCustomer.providerCustomerCode;
    const localId = localCustomer.providerCustomerId;
    const verifiedCode = verified.providerCustomerCode;
    const verifiedId = verified.providerCustomerId;

    const codeDisagrees =
      verifiedCode !== null && localCode !== null && verifiedCode !== localCode;
    const idDisagrees =
      verifiedId !== null && localId !== null && verifiedId !== localId;

    // If the verified transaction carries a customer identifier that is
    // provider-customer-shaped but the local record has none, we treat it
    // as a mismatch when the local customer should have one (i.e., a
    // provisioned customer). However, for pure reconciliation we only
    // fail when BOTH sides have a value and they disagree — an absent
    // verified identifier is not a disagreement (the provider may omit it
    // in some flows), and an absent local identifier is handled by the
    // confirmation service as snapshot_mismatch before reconciliation.
    if (codeDisagrees || idDisagrees) {
      return {
        ok: false,
        reason: 'customer_mismatch',
        message: `The provider customer identity does not match the local billing customer.`,
      };
    }

    // If the local customer has a code but the verified transaction has
    // neither code nor id, that is also incoherent: a transaction for a
    // known customer should carry at least one identifier.
    // We treat this as customer_mismatch only when the local customer is
    // provisioned (has a code) and the verified transaction has none.
    if (
      localCode !== null &&
      verifiedCode === null &&
      verifiedId === null
    ) {
      return {
        ok: false,
        reason: 'customer_mismatch',
        message: `The transaction carries no provider customer identity while a local customer is known.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Throwing variant: throws BillingPaymentReconciliationError on failure.
 * Useful for callers that want to fail closed with a typed error.
 */
export function assertBillingPaymentEvidenceReconciled(
  input: BillingPaymentReconciliationInput,
): void {
  const result = reconcileBillingPaymentEvidence(input);
  if (!result.ok) {
    throw new BillingPaymentReconciliationError(result.reason, result.message);
  }
}
