import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  BILLING_PROVIDER,
  billingPaymentVerificationResultSchema,
  type BillingPaymentVerificationResult,
  type BillingVerifiedTransaction,
} from '@veltrixeye/contracts';
import { billingCheckoutReference } from './checkout.js';
import { billingSubscriptionVerifyRequestSchema, type BillingProviderRegistry } from './provider.js';
import { BillingPricingSnapshotStore } from './snapshots.js';
import { reconcileBillingPaymentEvidence } from './payment-reconciliation.js';
import {
  BillingVerifiedTransactionStore,
  billingVerifiedTransactionEvidenceHash,
  billingVerifiedTransactionIdempotencyKey,
} from './verified-transactions.js';

export type BillingPaymentConfirmationErrorReason =
  | 'provider_not_registered'
  | 'subscription_not_found'
  | 'pricing_snapshot_not_found'
  | 'verification_unavailable';

export class BillingPaymentConfirmationError extends Error {
  readonly code = 'billing_payment_confirmation_unavailable' as const;
  constructor(
    readonly reason: BillingPaymentConfirmationErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingPaymentConfirmationError';
  }
}

export function isBillingPaymentConfirmationError(error: unknown): error is BillingPaymentConfirmationError {
  return error instanceof BillingPaymentConfirmationError;
}

function verificationIdempotencyKey(userId: string, reference: string, snapshotId: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['billing-payment-verify/v1', userId, reference, snapshotId]))
    .digest('hex');
}

export interface BillingPaymentConfirmationOptions {
  db: Pool;
  providers: BillingProviderRegistry;
  now?: () => Date;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  locked_pricing_snapshot_id: string | null;
  provider: string | null;
  catalogue_plan: string | null;
  billing_interval: string | null;
  provider_plan_id: string | null;
}

export class BillingPaymentConfirmationService {
  constructor(private readonly options: BillingPaymentConfirmationOptions) {}

  async confirm(userId: string): Promise<BillingPaymentVerificationResult> {
    const user = z.string().uuid().parse(userId);
    const provider = this.options.providers.get(BILLING_PROVIDER);
    if (provider === undefined) {
      throw new BillingPaymentConfirmationError(
        'provider_not_registered',
        'Payment verification refused: no billing provider is registered. Nothing was verified.',
      );
    }

    const subscription = await this.readSubscription(user);
    if (subscription === undefined || subscription.provider === null) {
      const verifiedAt = this.now().toISOString();
      return billingPaymentVerificationResultSchema.parse({
        verified: false,
        evidence: null,
        failureReason: 'snapshot_mismatch',
        failureMessage: 'No provider-backed subscription exists for this user.',
        providerReference: `ve-chk-${'0'.repeat(64)}`,
        providerStatus: null,
        replayed: false,
        verifiedAt,
        grantsExecution: false,
        planChanged: false,
        entitlementsChanged: false,
      });
    }
    if (subscription.locked_pricing_snapshot_id === null) {
      const verifiedAt = this.now().toISOString();
      return billingPaymentVerificationResultSchema.parse({
        verified: false,
        evidence: null,
        failureReason: 'snapshot_mismatch',
        failureMessage: 'The subscription has no locked pricing snapshot.',
        providerReference: `ve-chk-${'0'.repeat(64)}`,
        providerStatus: null,
        replayed: false,
        verifiedAt,
        grantsExecution: false,
        planChanged: false,
        entitlementsChanged: false,
      });
    }

    const snapshots = new BillingPricingSnapshotStore(this.options.db);
    const stored = await snapshots.findById(subscription.locked_pricing_snapshot_id);
    if (stored === null) {
      const verifiedAt = this.now().toISOString();
      return billingPaymentVerificationResultSchema.parse({
        verified: false,
        evidence: null,
        failureReason: 'snapshot_mismatch',
        failureMessage: 'The locked pricing snapshot could not be read.',
        providerReference: `ve-chk-${'0'.repeat(64)}`,
        providerStatus: null,
        replayed: false,
        verifiedAt,
        grantsExecution: false,
        planChanged: false,
        entitlementsChanged: false,
      });
    }
    const snapshot = stored.snapshot;
    const expectedReference = billingCheckoutReference(user, stored.idempotencyKey);
    const localCustomer = await this.readLocalCustomer(user);

    const verificationKey = verificationIdempotencyKey(user, expectedReference, stored.id);
    const request = billingSubscriptionVerifyRequestSchema.parse({
      provider: BILLING_PROVIDER,
      userId: user,
      providerReference: expectedReference,
      idempotencyKey: verificationKey,
      requestedAt: this.now().toISOString(),
    });

    let observed: import('@veltrixeye/contracts').ProviderSubscriptionState;
    try {
      observed = await provider.verifySubscription(request);
    } catch (error) {
      throw new BillingPaymentConfirmationError('verification_unavailable', 'Payment verification refused: the provider verification did not produce a usable result.', {
        cause: error,
      });
    }

    if (observed.providerReference !== expectedReference) {
      const verifiedAt = this.now().toISOString();
      return billingPaymentVerificationResultSchema.parse({
        verified: false,
        evidence: null,
        failureReason: 'reference_mismatch',
        failureMessage: 'The provider reference does not match the expected checkout reference.',
        providerReference: expectedReference,
        providerStatus: (observed as { providerTransactionStatus?: string | null }).providerTransactionStatus ?? null,
        replayed: false,
        verifiedAt,
        grantsExecution: false,
        planChanged: false,
        entitlementsChanged: false,
      });
    }

    const verifiedAt = this.now().toISOString();
    const transactionStatus =
      (observed as { providerTransactionStatus?: string | null }).providerTransactionStatus ?? 'unknown';
    const verified: BillingVerifiedTransaction = {
      provider: BILLING_PROVIDER,
      providerReference: observed.providerReference ?? expectedReference,
      providerTransactionId: (observed as { providerTransactionId?: string | null }).providerTransactionId ?? null,
      providerStatus: transactionStatus,
      providerDomain: 'test',
      paymentCurrency: (observed.payment?.paymentCurrency as 'GHS') ?? snapshot.payment.paymentCurrency,
      paymentAmountMinor: observed.payment?.paymentAmountMinor ?? snapshot.payment.paymentAmountMinor,
      paymentAmountExponent: observed.payment?.paymentAmountExponent ?? snapshot.payment.paymentAmountExponent,
      providerCustomerId: observed.providerCustomerId,
      providerCustomerCode: observed.providerCustomerCode,
      paidAt: (observed as { paidAt?: string | null }).paidAt ?? null,
      verifiedAt,
    };

    const reconciliation = reconcileBillingPaymentEvidence({
      verified,
      expectedReference,
      snapshot,
      localCustomer,
    });

    if (!reconciliation.ok) {
      return billingPaymentVerificationResultSchema.parse({
        verified: false,
        evidence: null,
        failureReason: reconciliation.reason,
        failureMessage: reconciliation.message.slice(0, 200),
        providerReference: expectedReference,
        providerStatus: verified.providerStatus ?? null,
        replayed: false,
        verifiedAt,
        grantsExecution: false,
        planChanged: false,
        entitlementsChanged: false,
      });
    }

    const store = new BillingVerifiedTransactionStore(this.options.db);
    let evidence: import('@veltrixeye/contracts').BillingPaymentEvidence;
    let replayed = false;
    try {
      const existingByKey = await store.findByIdempotencyKey(
        billingVerifiedTransactionIdempotencyKey({
          provider: BILLING_PROVIDER,
          providerReference: expectedReference,
          pricingSnapshotId: stored.id,
        }),
      );
      if (existingByKey !== null) {
        if (
          existingByKey.providerReference !== verified.providerReference ||
          existingByKey.paymentAmountMinor !== verified.paymentAmountMinor ||
          existingByKey.paymentCurrency !== verified.paymentCurrency ||
          existingByKey.providerStatus !== verified.providerStatus ||
          existingByKey.paidAt !== verified.paidAt
        ) {
          throw new BillingPaymentConfirmationError(
            'verification_unavailable',
            'Conflicting evidence already exists for this provider reference and will not be overwritten.',
          );
        }
        evidence = existingByKey;
        replayed = true;
      } else {
        evidence = await store.record({
          userId: user,
          subscriptionId: subscription.id,
          pricingSnapshotId: stored.id,
          verified,
        });
        replayed = false;
      }
    } catch (error) {
      if (error instanceof BillingPaymentConfirmationError) throw error;
      if ((error as { name?: string })?.name === 'BillingVerifiedTransactionError') {
        throw new BillingPaymentConfirmationError('verification_unavailable', (error as Error).message, {
          cause: error,
        });
      }
      throw new BillingPaymentConfirmationError('verification_unavailable', 'Failed to persist payment evidence.', {
        cause: error,
      });
    }

    return billingPaymentVerificationResultSchema.parse({
      verified: true,
      evidence,
      failureReason: null,
      failureMessage: null,
      providerReference: expectedReference,
      providerStatus: verified.providerStatus,
      replayed,
      verifiedAt: evidence.verifiedAt,
      grantsExecution: false,
      planChanged: false,
      entitlementsChanged: false,
    });
  }

  private async readSubscription(userId: string): Promise<SubscriptionRow | undefined> {
    const { rows } = await this.options.db.query<SubscriptionRow>(
      `SELECT id, user_id, locked_pricing_snapshot_id, provider, catalogue_plan, billing_interval, provider_plan_id
         FROM subscriptions WHERE user_id = $1`,
      [userId],
    );
    return rows[0];
  }

  private async readLocalCustomer(
    userId: string,
  ): Promise<{ providerCustomerId: string | null; providerCustomerCode: string | null } | null> {
    const { rows } = await this.options.db.query<{ provider_customer_id: string | null; provider_customer_code: string | null }>(
      `SELECT provider_customer_id, provider_customer_code FROM billing_customers WHERE provider = $1 AND user_id = $2`,
      [BILLING_PROVIDER, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      providerCustomerId: row.provider_customer_id,
      providerCustomerCode: row.provider_customer_code,
    };
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
