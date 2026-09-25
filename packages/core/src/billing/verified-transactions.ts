import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  BILLING_PROVIDER,
  billingPaymentCurrencySchema,
  type BillingPaymentCurrency,
} from '@veltrixeye/contracts';
import { billingPaymentEvidenceSchema, type BillingPaymentEvidence, type BillingVerifiedTransaction } from '@veltrixeye/contracts';
import { billingPaymentEvidenceIdempotencyCanonicalString } from '@veltrixeye/contracts';

/**
 * Billing Step 7 — durable VERIFIED-TRANSACTION EVIDENCE STORE.
 *
 * One row per verified Paystack transaction, recorded after the
 * transaction has been verified through the documented
 * GET /transaction/verify/:reference read and reconciled against its
 * immutable pricing snapshot. The store is the durable counterpart to the
 * pure reconciliation function (`./payment-reconciliation.ts`).
 *
 * WHAT IT DOES
 *  - `record` inserts one evidence row for a verified transaction that has
 *    already been reconciled. It is idempotent: a replayed observation
 *    with the SAME facts collapses onto the existing row and returns it.
 *  - `findByProviderReference` and `findByIdempotencyKey` are read-only
 *    lookups.
 *  - `safe concurrent calls` are handled by the database UNIQUE indexes:
 *    `provider_reference` and `idempotency_key` are both UNIQUE, so two
 *    concurrent inserts for the same transaction have one winner; the
 *    loser re-reads and returns the winner when the facts match, or fails
 *    closed when they conflict.
 *
 * WHAT IT NEVER DOES
 *  - it never overwrites immutable evidence. A later conflicting
 *    observation for the same provider reference (different amount,
 *    currency, customer, paid_at, etc.) is a hard failure, never a silent
 *    overwrite.
 *  - it never stores a provider payload, card authorization, secret or
 *    credential-shaped value. Only canonical identifiers and a SHA-256
 *    evidence hash are persisted.
 *  - it never grants entitlements or execution. It is an append-only
 *    evidence ledger.
 *
 * All amounts are integers in minor units; GHS exponent stays 2; provider
 * is pinned to `paystack` and domain to `test` by the database CHECKs.
 */

const isoDateTime = z.string().datetime();
const uuid = z.string().uuid();

export class BillingVerifiedTransactionError extends Error {
  readonly code = 'billing_verified_transaction_failed' as const;
  constructor(
    readonly reason: 'conflict' | 'immutable_violation' | 'invalid_input',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingVerifiedTransactionError';
  }
}

export function isBillingVerifiedTransactionError(error: unknown): error is BillingVerifiedTransactionError {
  return error instanceof BillingVerifiedTransactionError;
}

/** Deterministic idempotency key for one verified transaction. */
export function billingVerifiedTransactionIdempotencyKey(input: {
  provider: string;
  providerReference: string;
  pricingSnapshotId: string;
}): string {
  return createHash('sha256')
    .update(billingPaymentEvidenceIdempotencyCanonicalString(input))
    .digest('hex');
}

/** SHA-256 of the canonical verified facts (payload/evidence hash). */
export function billingVerifiedTransactionEvidenceHash(verified: BillingVerifiedTransaction): string {
  const canonical = JSON.stringify([
    'billing-verified-transaction-evidence/v1',
    verified.provider,
    verified.providerReference,
    verified.providerTransactionId ?? '',
    verified.providerStatus,
    verified.providerDomain,
    verified.paymentCurrency,
    String(verified.paymentAmountMinor),
    String(verified.paymentAmountExponent),
    verified.providerCustomerId ?? '',
    verified.providerCustomerCode ?? '',
    verified.paidAt ?? '',
    verified.verifiedAt,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface RecordBillingVerifiedTransactionInput {
  userId: string;
  subscriptionId: string;
  pricingSnapshotId: string;
  verified: BillingVerifiedTransaction;
  /** Optional explicit verifiedAt; defaults to verified.verifiedAt. */
  verifiedAt?: string;
}

const recordInputSchema = z
  .object({
    userId: uuid,
    subscriptionId: uuid,
    pricingSnapshotId: uuid,
    verified: z.object({
      provider: z.literal(BILLING_PROVIDER),
      providerReference: z.string().min(1).max(190),
      providerTransactionId: z.string().min(1).max(128).nullable(),
      providerStatus: z.string().min(1).max(64),
      providerDomain: z.string().min(1).max(16),
      paymentCurrency: billingPaymentCurrencySchema,
      paymentAmountMinor: z.number().int().positive(),
      paymentAmountExponent: z.number().int().min(0).max(3),
      providerCustomerId: z.string().min(1).max(128).nullable(),
      providerCustomerCode: z.string().min(1).max(128).nullable(),
      paidAt: isoDateTime,
      verifiedAt: isoDateTime,
    }),
  })
  .strict();

interface EvidenceRow {
  id: string;
  user_id: string;
  subscription_id: string;
  pricing_snapshot_id: string;
  provider: string;
  provider_reference: string;
  provider_transaction_id: string | null;
  payment_amount_minor: string | number | bigint;
  payment_currency: string;
  payment_amount_exponent: number;
  provider_status: string;
  provider_domain: string;
  provider_customer_id: string | null;
  provider_customer_code: string | null;
  paid_at: Date | string;
  verified_at: Date | string;
  evidence_hash: string;
  idempotency_key: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const rowSchema = z
  .object({
    id: uuid,
    user_id: uuid,
    subscription_id: uuid,
    pricing_snapshot_id: uuid,
    provider: z.literal(BILLING_PROVIDER),
    provider_reference: z.string().min(1).max(190),
    provider_transaction_id: z.string().min(1).max(128).nullable(),
    payment_amount_minor: z.union([z.number(), z.string(), z.bigint()]).transform((v) => Number(v)),
    payment_currency: billingPaymentCurrencySchema,
    payment_amount_exponent: z.number().int(),
    provider_status: z.string().min(1).max(64),
    provider_domain: z.literal('test'),
    provider_customer_id: z.string().min(1).max(128).nullable(),
    provider_customer_code: z.string().min(1).max(128).nullable(),
    paid_at: z.union([z.date(), z.string().datetime()]).transform((v) => new Date(v).toISOString()),
    verified_at: z.union([z.date(), z.string().datetime()]).transform((v) => new Date(v).toISOString()),
    evidence_hash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotency_key: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.union([z.date(), z.string().datetime()]).transform((v) => new Date(v).toISOString()),
    updated_at: z.union([z.date(), z.string().datetime()]).transform((v) => new Date(v).toISOString()),
  })
  .passthrough();

function fromRow(row: unknown): BillingPaymentEvidence {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    throw new BillingVerifiedTransactionError(
      'invalid_input',
      `The stored payment evidence row is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { cause: parsed.error },
    );
  }
  const r = parsed.data;
  const evidence = {
    id: r.id,
    userId: r.user_id,
    subscriptionId: r.subscription_id,
    pricingSnapshotId: r.pricing_snapshot_id,
    provider: r.provider,
    providerReference: r.provider_reference,
    providerTransactionId: r.provider_transaction_id,
    paymentAmountMinor: r.payment_amount_minor,
    paymentCurrency: r.payment_currency,
    paymentAmountExponent: r.payment_amount_exponent,
    providerStatus: r.provider_status,
    providerDomain: r.provider_domain,
    providerCustomerId: r.provider_customer_id,
    providerCustomerCode: r.provider_customer_code,
    paidAt: r.paid_at,
    verifiedAt: r.verified_at,
    evidenceHash: r.evidence_hash,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const validated = billingPaymentEvidenceSchema.safeParse(evidence);
  if (!validated.success) {
    throw new BillingVerifiedTransactionError(
      'invalid_input',
      `The stored payment evidence does not satisfy the canonical contract: ${validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      { cause: validated.error },
    );
  }
  // Verify idempotency key is deterministic for this identity.
  const expectedKey = billingVerifiedTransactionIdempotencyKey({
    provider: evidence.provider,
    providerReference: evidence.providerReference,
    pricingSnapshotId: evidence.pricingSnapshotId,
  });
  if (expectedKey !== evidence.idempotencyKey) {
    throw new BillingVerifiedTransactionError(
      'invalid_input',
      'The stored evidence idempotency key does not verify against its identity.',
    );
  }
  return validated.data;
}

/**
 * Thin append-only persistence for verified-transaction evidence.
 */
export class BillingVerifiedTransactionStore {
  constructor(private readonly db: Pick<Pool | PoolClient, 'query'>) {}

  async findByProviderReference(providerReference: string): Promise<BillingPaymentEvidence | null> {
    const { rows } = await this.db.query('SELECT * FROM billing_verified_transactions WHERE provider_reference = $1', [
      providerReference,
    ]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<BillingPaymentEvidence | null> {
    const { rows } = await this.db.query('SELECT * FROM billing_verified_transactions WHERE idempotency_key = $1', [
      idempotencyKey,
    ]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  async findById(id: string): Promise<BillingPaymentEvidence | null> {
    const { rows } = await this.db.query('SELECT * FROM billing_verified_transactions WHERE id = $1', [id]);
    return rows[0] === undefined ? null : fromRow(rows[0]);
  }

  /**
   * Record durable payment evidence for a verified transaction that has
   * already been reconciled. Idempotent: a replayed observation with the
   * SAME facts returns the existing row. A conflicting observation for
   * the same provider reference fails closed.
   */
  async record(input: RecordBillingVerifiedTransactionInput): Promise<BillingPaymentEvidence> {
    const parsed = recordInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BillingVerifiedTransactionError(
        'invalid_input',
        `The payment evidence input is not canonical: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        { cause: parsed.error },
      );
    }
    const { userId, subscriptionId, pricingSnapshotId, verified } = parsed.data;

    // Enforce sandbox/test invariants at the service boundary as well.
    if (verified.provider !== BILLING_PROVIDER) {
      throw new BillingVerifiedTransactionError('invalid_input', 'Evidence provider must be paystack.');
    }
    if (verified.providerDomain !== 'test') {
      throw new BillingVerifiedTransactionError('invalid_input', 'Evidence domain must be test.');
    }
    if (verified.paymentCurrency !== 'GHS' || verified.paymentAmountExponent !== 2) {
      throw new BillingVerifiedTransactionError('invalid_input', 'Evidence currency must be GHS with exponent 2.');
    }

    const idempotencyKey = billingVerifiedTransactionIdempotencyKey({
      provider: verified.provider,
      providerReference: verified.providerReference,
      pricingSnapshotId,
    });
    const evidenceHash = billingVerifiedTransactionEvidenceHash(verified);
    const verifiedAt = verified.verifiedAt;
    const paidAt = verified.paidAt;

    // Attempt insert. ON CONFLICT on either unique key does nothing; the
    // loser will re-read and either return the winner (replay) or fail
    // closed (conflict).
    let inserted: EvidenceRow | undefined;
    try {
      const result = await this.db.query(
        `INSERT INTO billing_verified_transactions (
           user_id, subscription_id, pricing_snapshot_id, provider, provider_reference,
           provider_transaction_id, payment_amount_minor, payment_currency,
           payment_amount_exponent, provider_status, provider_domain,
           provider_customer_id, provider_customer_code, paid_at, verified_at,
           evidence_hash, idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [
          userId,
          subscriptionId,
          pricingSnapshotId,
          verified.provider,
          verified.providerReference,
          verified.providerTransactionId,
          verified.paymentAmountMinor,
          verified.paymentCurrency,
          verified.paymentAmountExponent,
          verified.providerStatus,
          verified.providerDomain,
          verified.providerCustomerId,
          verified.providerCustomerCode,
          paidAt,
          verifiedAt,
          evidenceHash,
          idempotencyKey,
        ],
      );
      inserted = result.rows[0] as EvidenceRow | undefined;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const constraint = (error as { constraint?: string })?.constraint ?? '';
      if (
        code === '23505' &&
        (constraint.includes('provider_reference') || constraint.includes('idempotency'))
      ) {
        // Unique violation on either key: a row already exists. Fall through
        // to the replay/conflict logic below.
        inserted = undefined;
      } else {
        throw error;
      }
    }

    if (inserted !== undefined) {
      return fromRow(inserted);
    }

    // No row inserted: either a concurrent winner or an existing row with
    // the same provider_reference or idempotency_key. Re-read by both keys.
    const byKey = await this.findByIdempotencyKey(idempotencyKey);
    if (byKey !== null) {
      // Same idempotency key: the replay case. Ensure facts match, else conflict.
      if (!evidenceEqual(byKey, verified, userId, subscriptionId, pricingSnapshotId, evidenceHash)) {
        throw new BillingVerifiedTransactionError(
          'conflict',
          'Conflicting evidence for the same idempotency key: existing evidence differs from the new observation and will not be overwritten.',
        );
      }
      return byKey;
    }

    const byReference = await this.findByProviderReference(verified.providerReference);
    if (byReference !== null) {
      if (!evidenceEqual(byReference, verified, userId, subscriptionId, pricingSnapshotId, evidenceHash)) {
        throw new BillingVerifiedTransactionError(
          'conflict',
          'Conflicting evidence for the same provider reference: existing evidence differs from the new observation and will not be overwritten.',
        );
      }
      // Same reference but different idempotency key should still be a conflict
      // unless the facts are identical (which would have produced the same key).
      // If facts are identical but keys differ, it means the pricing snapshot
      // differs — also a conflict.
      throw new BillingVerifiedTransactionError(
        'conflict',
        'Conflicting evidence for the same provider reference with a different idempotency key.',
      );
    }

    // Should have found an existing row; if not, the insert failed for an
    // unexpected reason (e.g., provider_reference unique violation without
    // idempotency conflict). Try a second lookup by reference to provide a
    // clearer error, otherwise throw invalid.
    throw new BillingVerifiedTransactionError(
      'conflict',
      'The payment evidence could not be recorded: a conflicting row already exists for the provider reference or idempotency key.',
    );
  }
}

function evidenceEqual(
  existing: BillingPaymentEvidence,
  verified: {
    provider: string;
    providerReference: string;
    providerTransactionId: string | null;
    providerStatus: string;
    providerDomain: string;
    paymentCurrency: string;
    paymentAmountMinor: number;
    paymentAmountExponent: number;
    providerCustomerId: string | null;
    providerCustomerCode: string | null;
    paidAt: string;
    verifiedAt: string;
  },
  userId: string,
  subscriptionId: string,
  pricingSnapshotId: string,
  evidenceHash: string,
): boolean {
  return (
    existing.userId === userId &&
    existing.subscriptionId === subscriptionId &&
    existing.pricingSnapshotId === pricingSnapshotId &&
    existing.provider === verified.provider &&
    existing.providerReference === verified.providerReference &&
    existing.providerTransactionId === verified.providerTransactionId &&
    existing.providerStatus === verified.providerStatus &&
    existing.providerDomain === verified.providerDomain &&
    existing.paymentCurrency === verified.paymentCurrency &&
    existing.paymentAmountMinor === verified.paymentAmountMinor &&
    existing.paymentAmountExponent === verified.paymentAmountExponent &&
    existing.providerCustomerId === verified.providerCustomerId &&
    existing.providerCustomerCode === verified.providerCustomerCode &&
    existing.paidAt === verified.paidAt &&
    existing.evidenceHash === evidenceHash
  );
}
