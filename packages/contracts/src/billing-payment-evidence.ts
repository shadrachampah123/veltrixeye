import { z } from 'zod';
import { BILLING_PROVIDER } from './billing-catalogue.js';
import { billingIsoDateTimeSchema, billingUuidSchema, providerEventReferenceSchema, providerReferenceSchema, sha256HexSchema } from './billing-refs.js';
import { billingPaymentCurrencySchema } from './billing-payment.js';

/**
 * Billing Step 7 — durable PAYMENT EVIDENCE contracts.
 *
 * This module is the canonical vocabulary for the verified-transaction
 * evidence ledger (`billing_verified_transactions`, migration 0033) and for
 * the pure reconciliation that validates a provider-reported transaction
 * against its immutable pricing snapshot.
 *
 * WHAT THIS MODULE IS
 *  - the strict, `.strict()` schemas for evidence identity, evidence rows
 *    and the API result that the verification endpoint returns;
 *  - the failure-reason vocabulary reconciliation uses (typed, bounded,
 *    never provider-shaped);
 *  - the deterministic idempotency derivation for evidence (one
 *    implementation, already covered by the durable UNIQUE index).
 *
 * WHAT THIS MODULE IS NOT
 *  - it is not an entitlement, not a payment-confirmation, not a plan
 *    change and not an execution grant. `paymentConfirmed` stays
 *    `z.literal(false)` on the existing billing-state DTO
 *    (`./billing.ts`), and the evidence DTOs below pin `grantsExecution`,
 *    `planChanged` and `entitlementsChanged` to `false` by type —
 *    evidence is information, never authority.
 *  - it does not store, log or forward a provider payload, a card
 *    authorization, a secret or any credential-shaped value. The payload
 *    is hashed and dropped; only the hash and the canonical fields are
 *    persisted.
 *  - it does not infer subscription lifecycle. The verified lifecycle
 *    remains `unknown` (see `packages/providers/paystack`); evidence
 *    confirms a transaction, never a subscription state.
 *
 * Money is always an integer in minor units (never a float), and every
 * object is `.strict()`, so a provider-shaped or client-shaped extra
 * field is a validation failure rather than a silent pass-through.
 */

/* -------------------------------------------------------------------------- */
/* Reconciliation failure reasons (typed, exhaustive)                         */
/* -------------------------------------------------------------------------- */

export const BILLING_PAYMENT_RECONCILIATION_FAILURE_REASONS = [
  'reference_mismatch',
  'amount_mismatch',
  'currency_mismatch',
  'exponent_mismatch',
  'invalid_status',
  'missing_paid_at',
  'provider_mismatch',
  'domain_mismatch',
  'customer_mismatch',
  'snapshot_mismatch',
  'invalid_snapshot',
] as const;
export type BillingPaymentReconciliationFailureReason =
  (typeof BILLING_PAYMENT_RECONCILIATION_FAILURE_REASONS)[number];
export const billingPaymentReconciliationFailureReasonSchema = z.enum(
  BILLING_PAYMENT_RECONCILIATION_FAILURE_REASONS,
);

/* -------------------------------------------------------------------------- */
/* Verified transaction — the provider-reported facts we act on               */
/* -------------------------------------------------------------------------- */

/**
 * The provider-reported facts for one verified transaction, as normalized
 * behind the Paystack seam. This is a RECEIPT fact, not a price source.
 * Only documented fields are carried; the provider's `authorization`
 * object, fees, logs, IP address and metadata are never read.
 */
export const billingVerifiedTransactionSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    /** Our deterministic checkout reference (ve-chk-…). */
    providerReference: providerEventReferenceSchema,
    /** The provider's own transaction identifier (numeric id string), where the payload carries one. */
    providerTransactionId: providerReferenceSchema.nullable(),
    /** Transaction status as reported (documented value, e.g. success). Uninterpreted beyond acceptance check. */
    providerStatus: z.string().min(1).max(64),
    providerDomain: z.string().min(1).max(16),
    paymentCurrency: billingPaymentCurrencySchema,
    paymentAmountMinor: z.number().int().positive().refine(Number.isSafeInteger, {
      message: 'a minor-unit amount must be a safe integer',
    }),
    /** Exponent for the currency (GHS: 2). Recorded explicitly so exponent mismatches are detectable. */
    paymentAmountExponent: z.number().int().min(0).max(3),
    providerCustomerId: providerReferenceSchema.nullable(),
    providerCustomerCode: providerReferenceSchema.nullable(),
    /** Provider-reported instant the transaction was paid. Required for evidence. */
    paidAt: billingIsoDateTimeSchema.nullable(),
    /** Local instant the transaction was verified. */
    verifiedAt: billingIsoDateTimeSchema,
  })
  .strict();
export type BillingVerifiedTransaction = z.infer<typeof billingVerifiedTransactionSchema>;

/* -------------------------------------------------------------------------- */
/* Durable evidence row (what migration 0033 persists)                        */
/* -------------------------------------------------------------------------- */

export const billingPaymentEvidenceSchema = z
  .object({
    id: billingUuidSchema,
    userId: billingUuidSchema,
    subscriptionId: billingUuidSchema,
    pricingSnapshotId: billingUuidSchema,
    provider: z.literal(BILLING_PROVIDER),
    providerReference: providerEventReferenceSchema,
    providerTransactionId: providerReferenceSchema.nullable(),
    paymentAmountMinor: z.number().int().positive().refine(Number.isSafeInteger, {
      message: 'a minor-unit amount must be a safe integer',
    }),
    paymentCurrency: billingPaymentCurrencySchema,
    paymentAmountExponent: z.number().int().min(0).max(3),
    providerStatus: z.string().min(1).max(64),
    providerDomain: z.literal('test'),
    providerCustomerId: providerReferenceSchema.nullable(),
    providerCustomerCode: providerReferenceSchema.nullable(),
    paidAt: billingIsoDateTimeSchema,
    verifiedAt: billingIsoDateTimeSchema,
    evidenceHash: sha256HexSchema,
    idempotencyKey: sha256HexSchema,
    createdAt: billingIsoDateTimeSchema,
    updatedAt: billingIsoDateTimeSchema,
  })
  .strict()
  .superRefine((evidence, ctx) => {
    if (evidence.paymentAmountExponent !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'paymentAmountExponent must be 2 for GHS',
      });
    }
    if (evidence.paymentCurrency !== 'GHS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'paymentCurrency must be GHS in this build',
      });
    }
  });
export type BillingPaymentEvidence = z.infer<typeof billingPaymentEvidenceSchema>;

/* -------------------------------------------------------------------------- */
/* Evidence idempotency (pure, deterministic, no I/O)                         */
/* -------------------------------------------------------------------------- */

/**
 * Canonical string the evidence idempotency key is the SHA-256 of.
 * Every field that defines the evidence identity is included, in a fixed
 * order, so the same verified observation always hashes to the same key
 * and a replayed verification collapses onto one row.
 */
export function billingPaymentEvidenceIdempotencyCanonicalString(input: {
  provider: string;
  providerReference: string;
  pricingSnapshotId: string;
}): string {
  return ['billing-verified-transaction/v1', input.provider, input.providerReference, input.pricingSnapshotId].join(
    '|',
  );
}

/* -------------------------------------------------------------------------- */
/* Verification result — what POST /api/billing/verify answers                */
/* -------------------------------------------------------------------------- */

/**
 * The structured result of a verification attempt. It is the ONLY
 * verification-related DTO the API produces, and it is intentionally
 * separate from `BillingStateDto` (`./billing.ts`), so the existing
 * `paymentConfirmed: z.literal(false)` contract is never touched.
 *
 * `verified` is true only when reconciliation succeeded and durable
 * evidence was recorded (or re-read on idempotent replay). Every other
 * case is `verified: false` with a typed failure reason, and never a
 * provider payload or secret.
 *
 * `grantsExecution`, `planChanged` and `entitlementsChanged` are pinned
 * `false` at the type level: evidence is information, never authority.
 */
export const billingPaymentVerificationResultSchema = z
  .object({
    verified: z.boolean(),
    /** Present when verified is true: the durable evidence row. */
    evidence: billingPaymentEvidenceSchema.nullable(),
    /** Present when verified is false: why reconciliation or verification failed. */
    failureReason: billingPaymentReconciliationFailureReasonSchema.nullable(),
    /** Human-readable, fixed, credential-free detail for operators (≤ 200 chars). */
    failureMessage: z.string().max(200).nullable(),
    /** The checkout reference this verification derived server-side. */
    providerReference: providerEventReferenceSchema,
    /** Observed provider status, when a provider response was obtained. */
    providerStatus: z.string().min(1).max(64).nullable(),
    /** Whether this was an idempotent replay of existing evidence. */
    replayed: z.boolean(),
    verifiedAt: billingIsoDateTimeSchema,
    // Pinned: evidence never grants execution, never changes plan/entitlements.
    grantsExecution: z.literal(false),
    planChanged: z.literal(false),
    entitlementsChanged: z.literal(false),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.verified && result.evidence === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a verified result requires evidence' });
    }
    if (!result.verified && result.failureReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'an unverified result requires a failure reason' });
    }
    if (result.verified && result.failureReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a verified result cannot carry a failure reason' });
    }
  });
export type BillingPaymentVerificationResult = z.infer<typeof billingPaymentVerificationResultSchema>;

/* -------------------------------------------------------------------------- */
/* Evidence DTO for the existing billing-state — kept SEPARATE                */
/* -------------------------------------------------------------------------- */

/**
 * The existing billing-state DTO still pins `paymentConfirmed` to `false`
 * (see `packages/contracts/src/billing.ts`). That contract is re-exported
 * here only for convenience in tests that assert the safety invariants —
 * it is not redefined and it is not widened.
 */
export { billingProviderStatusDtoSchema } from './billing.js';
export type { BillingProviderStatusDto } from './billing.js';
