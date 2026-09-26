import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  BILLING_PROVIDER,
  billingVerifiedTransactionSchema,
  internalPlanForCommercialPlan,
  type BillingInterval,
  type BillingPaymentEvidence,
  type BillingPricingSnapshot,
  type BillingVerifiedTransaction,
  type CommercialPlanId,
} from '@veltrixeye/contracts';
import { recordAuditEvent } from '../audit.js';
import { billingCheckoutReference } from './checkout.js';
import { reconcileBillingPaymentEvidence } from './payment-reconciliation.js';
import { verifyPricingSnapshot } from './pricing.js';
import { BillingPricingSnapshotStore, type StoredBillingPricingSnapshot } from './snapshots.js';
import {
  BillingVerifiedTransactionStore,
  isBillingVerifiedTransactionError,
} from './verified-transactions.js';

/**
 * Billing Step 8 — the ACTIVATION AUTHORITY.
 *
 * The one missing half of the paid-entitlement authority. Verified payment
 * evidence (`billing_verified_transactions`, migration 0033) proves a
 * transaction happened; it is EVIDENCE, never authority. What turns evidence
 * into a paid entitlement is an explicit, out-of-band OPERATOR AUTHORIZATION,
 * recorded here as an immutable ACTIVATION FACT:
 *
 * ```text
 * verified payment evidence
 *   → explicit out-of-band operator authorization (this service, via the CLI)
 *   → immutable activation fact (billing_subscription_activations, 0034)
 *   → read-side paid entitlement (resolveEntitlements, provider-backed + activated)
 * ```
 *
 * The authority is invoked by an operator running a DB-connected CLI
 * (`scripts/billing/activate.ts`) with an explicit operator identity and an
 * explicit reason. There is no HTTP route, no admin role, no operator
 * endpoint, no activation token and no provider call: nothing a user session
 * can reach is capable of invoking this.
 *
 * WHAT THE SERVICE GUARANTEES (in this order)
 *  1. an explicit operator identity AND reason are required;
 *  2. the commercial subscription is located (by the user's email or uuid);
 *  3. a legacy NULL-lock subscription is refused;
 *  4. the immutable pricing snapshot is validated;
 *  5. Starter and the excluded capability-evidence provider plan are refused;
 *  6. matching verified transaction evidence is located;
 *  7. that evidence must be a successful SANDBOX transaction;
 *  8. the exact payment reconciliation is re-run from the stored evidence;
 *  9. one DB client and one transaction are used;
 * 10. the subscription row is locked `FOR UPDATE`;
 * 11. exactly one activation fact is inserted;
 * 12. the transactional `billing.subscription_activated` audit event is inserted;
 * 13. both commit together;
 * 14. any failure rolls everything back;
 * 15. an already-activated subscription returns an idempotent replay;
 * 16. the subscription's plan / status / provider state are never written;
 * 17. `users.plan` is never written;
 * 18. Paystack is never called — this service holds no provider at all.
 *
 * WHAT THIS IS NOT
 *  - Not a payment verifier. It never contacts a provider and never
 *    re-observes a payment: it re-runs the EXISTING pure reconciliation over
 *    the durable evidence, so a wrong amount, currency, exponent, reference or
 *    customer is refused exactly as verification would refuse it.
 *  - Not a state machine. It moves no subscription column, so an activation
 *    can never change a plan, a lifecycle status or a provider state.
 *  - Not an execution grant. `canAccessAutomation` stays `false` for every
 *    plan, and automation / live execution / broker execution stay OFF.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export const BILLING_ACTIVATION_ERROR_REASONS = [
  /** Missing, oversized or credential-shaped operator identity or reason. */
  'invalid_operator_input',
  /** Malformed user reference or evidence identifier. */
  'invalid_input',
  /** No user matches the given email or uuid. */
  'user_not_found',
  /** The user has no commercial subscription row. */
  'subscription_not_found',
  /** A legacy NULL-lock subscription is never activatable. */
  'pricing_lock_required',
  /** The locked pricing snapshot could not be read. */
  'pricing_snapshot_not_found',
  /** The stored pricing snapshot fails the pricing contract. */
  'invalid_snapshot',
  /** Starter is not a sellable plan. */
  'forbidden_plan',
  /** The capability-evidence provider plan is never an epoch. */
  'excluded_provider_plan',
  /** The snapshot is not bound to a provider plan epoch. */
  'plan_not_registered',
  /** The subscription row disagrees with its own locked snapshot. */
  'incoherent_subscription',
  /** No verified payment evidence matches this subscription. */
  'payment_evidence_not_found',
  /** The evidence is not a successful sandbox transaction. */
  'evidence_not_successful',
  /** The exact payment reconciliation refused the evidence. */
  'reconciliation_failed',
  /** The stored evidence row is malformed. */
  'invalid_evidence_row',
  /** The database coherence trigger refused the fact. */
  'incoherent_activation',
  /** A concurrent writer created a different fact for the same subscription. */
  'conflict',
] as const;
export type BillingActivationErrorReason = (typeof BILLING_ACTIVATION_ERROR_REASONS)[number];

/**
 * An activation refusal. NOTHING was written: the transaction is rolled back
 * before this is thrown, so the subscription, the evidence ledger, the audit
 * log and the activation table are exactly as they were.
 */
export class BillingActivationError extends Error {
  readonly code = 'billing_activation_refused' as const;

  constructor(
    readonly reason: BillingActivationErrorReason,
    message: string,
    readonly detail?: { reconciliationReason?: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingActivationError';
  }
}

export function isBillingActivationError(error: unknown): error is BillingActivationError {
  return error instanceof BillingActivationError;
}

/* -------------------------------------------------------------------------- */
/* The activation fact                                                        */
/* -------------------------------------------------------------------------- */

export interface BillingSubscriptionActivation {
  id: string;
  userId: string;
  subscriptionId: string;
  pricingSnapshotId: string;
  evidenceId: string;
  cataloguePlan: CommercialPlanId;
  billingInterval: BillingInterval;
  provider: string;
  providerPlanId: string | null;
  providerReference: string;
  paymentCurrency: string;
  paymentAmountMinor: number;
  paymentAmountExponent: number;
  evidenceHash: string;
  /** The operator who authorized the activation, out of band. */
  operatorId: string;
  /** The operator-stated reason. */
  activationReason: string;
  activatedAt: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Canonical string the activation idempotency key is the SHA-256 of. It is
 * derived ONLY from fields no client can supply — the provider, the
 * server-derived checkout reference and the immutable pricing snapshot — so
 * the same activation always hashes to the same key and a replay collapses
 * onto the one existing fact.
 */
export function billingSubscriptionActivationIdempotencyCanonicalString(input: {
  provider: string;
  providerReference: string;
  pricingSnapshotId: string;
}): string {
  return ['billing-activation/v1', input.provider, input.providerReference, input.pricingSnapshotId].join('|');
}

/** Deterministic idempotency key for one activation. */
export function billingSubscriptionActivationIdempotencyKey(input: {
  provider: string;
  providerReference: string;
  pricingSnapshotId: string;
}): string {
  return createHash('sha256')
    .update(billingSubscriptionActivationIdempotencyCanonicalString(input))
    .digest('hex');
}

/** The transactional audit action an activation writes. */
export const BILLING_ACTIVATION_AUDIT_ACTION = 'billing.subscription_activated';

/* -------------------------------------------------------------------------- */
/* Row contract                                                               */
/* -------------------------------------------------------------------------- */

const isoDateTime = z.string().datetime();
const uuid = z.string().uuid();
const integer = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().safe());

const activationRowSchema = z
  .object({
    id: uuid,
    user_id: uuid,
    subscription_id: uuid,
    pricing_snapshot_id: uuid,
    evidence_id: uuid,
    catalogue_plan: z.enum(['pro', 'elite']),
    billing_interval: z.enum(['monthly', 'annual']),
    provider: z.literal(BILLING_PROVIDER),
    provider_plan_id: z.string().min(1).max(128).nullable(),
    provider_reference: z.string().min(1).max(190),
    payment_currency: z.literal('GHS'),
    payment_amount_minor: integer,
    payment_amount_exponent: z.literal(2),
    evidence_hash: z.string().regex(/^[0-9a-f]{64}$/),
    operator_id: z.string().min(1).max(128),
    activation_reason: z.string().min(1).max(500),
    activated_at: z.union([z.date(), isoDateTime]).transform((value) => new Date(value).toISOString()),
    idempotency_key: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.union([z.date(), isoDateTime]).transform((value) => new Date(value).toISOString()),
    updated_at: z.union([z.date(), isoDateTime]).transform((value) => new Date(value).toISOString()),
  })
  .strict();

function fromActivationRow(row: unknown): BillingSubscriptionActivation {
  const parsed = activationRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new BillingActivationError(
      'invalid_evidence_row',
      `The stored activation fact is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      undefined,
      { cause: parsed.error },
    );
  }
  const r = parsed.data;
  const expectedKey = billingSubscriptionActivationIdempotencyKey({
    provider: r.provider,
    providerReference: r.provider_reference,
    pricingSnapshotId: r.pricing_snapshot_id,
  });
  if (expectedKey !== r.idempotency_key) {
    throw new BillingActivationError(
      'invalid_evidence_row',
      'The stored activation idempotency key does not verify against its identity.',
    );
  }
  return {
    id: r.id,
    userId: r.user_id,
    subscriptionId: r.subscription_id,
    pricingSnapshotId: r.pricing_snapshot_id,
    evidenceId: r.evidence_id,
    cataloguePlan: r.catalogue_plan,
    billingInterval: r.billing_interval,
    provider: r.provider,
    providerPlanId: r.provider_plan_id,
    providerReference: r.provider_reference,
    paymentCurrency: r.payment_currency,
    paymentAmountMinor: r.payment_amount_minor,
    paymentAmountExponent: r.payment_amount_exponent,
    evidenceHash: r.evidence_hash,
    operatorId: r.operator_id,
    activationReason: r.activation_reason,
    activatedAt: r.activated_at,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Input validation (operator authorization is explicit, never inferred)      */
/* -------------------------------------------------------------------------- */

const OPERATOR_ID_MAX = 128;
const REASON_MAX = 500;
const USER_REF_MAX = 320;

/** Credential-shaped text is never an operator identity or a reason. */
const CREDENTIAL_SHAPE =
  /(password|passwd|secret|token|api[_-]?key|apikey|authorization|bearer|private[_-]?key|credential)/i;

/** The one provider plan that is capability evidence only, never an epoch. */
const EXCLUDED_PROVIDER_PLAN = ['PLN', 'u0l4961hhipl6ek'].join('_');

export function isExcludedBillingProviderPlan(providerPlanId: string | null | undefined): boolean {
  return providerPlanId?.trim() === EXCLUDED_PROVIDER_PLAN;
}

const activationInputSchema = z
  .object({
    /** The user to activate: an email address or a user uuid. */
    user: z.string().trim().min(1).max(USER_REF_MAX),
    /**
     * The operator authorizing the activation. Required, never inferred: the
     * bounds are enforced by `assertOperatorIdentity` so the refusal is the
     * typed `invalid_operator_input` rather than a generic schema failure.
     */
    operatorId: z.string().trim(),
    /** Why the operator authorized it. Required, never inferred. */
    reason: z.string().trim(),
    /** Optional explicit evidence row to activate. */
    evidenceId: z.string().uuid().nullable().optional(),
    /** Optional explicit activation instant (tests/backfills only). */
    activatedAt: isoDateTime.optional(),
  })
  .strict();

export interface BillingActivationRequest {
  user: string;
  operatorId: string;
  reason: string;
  evidenceId?: string | null;
  activatedAt?: string;
}

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

export interface BillingActivationResult {
  /** `activated` wrote the fact; `already_activated` replayed it. */
  outcome: 'activated' | 'already_activated';
  /** True exactly when an existing fact was returned instead of a new one. */
  replayed: boolean;
  activation: BillingSubscriptionActivation;
  /**
   * Derived from the existence of the activation fact — the same derivation
   * the read side performs. Never accepted as input and never stored as a
   * second mutable authority.
   */
  paymentConfirmed: true;
  /** Pinned false: an activation never grants execution. */
  grantsExecution: false;
  /** Pinned false: an activation writes no plan column. */
  planChanged: false;
  /** Pinned false by construction here; the read side is what widens. */
  entitlementsChanged: false;
}

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

/** Thin read access to the immutable activation facts. Never writes. */
export class BillingActivationStore {
  constructor(private readonly db: Pick<Pool | PoolClient, 'query'>) {}

  async findById(id: string): Promise<BillingSubscriptionActivation | null> {
    const { rows } = await this.db.query('SELECT * FROM billing_subscription_activations WHERE id = $1', [id]);
    return rows[0] === undefined ? null : fromActivationRow(rows[0]);
  }

  async findBySubscriptionId(subscriptionId: string): Promise<BillingSubscriptionActivation | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM billing_subscription_activations WHERE subscription_id = $1',
      [subscriptionId],
    );
    return rows[0] === undefined ? null : fromActivationRow(rows[0]);
  }

  /** Whether a durable activation fact exists for the subscription. */
  async isActivated(subscriptionId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM billing_subscription_activations WHERE subscription_id = $1',
      [subscriptionId],
    );
    return rows.length > 0;
  }
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

interface SubscriptionFactRow {
  id: string;
  user_id: string;
  plan: string;
  status: string;
  provider: string | null;
  catalogue_plan: string | null;
  billing_interval: string | null;
  provider_plan_id: string | null;
  locked_pricing_snapshot_id: string | null;
}

export interface BillingActivationOptions {
  db: Pool;
  now?: () => Date;
}

export class BillingActivationService {
  constructor(private readonly options: BillingActivationOptions) {}

  /**
   * Authorize the activation of one user's commercial subscription.
   *
   * Everything happens on ONE client inside ONE transaction: the subscription
   * row is locked `FOR UPDATE`, the activation fact and its audit event are
   * inserted, and both commit together. Any refusal rolls the whole thing
   * back, so a failed activation leaves no trace at all.
   */
  async activate(input: BillingActivationRequest): Promise<BillingActivationResult> {
    const parsed = activationInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BillingActivationError(
        'invalid_input',
        `The activation request is not canonical: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        undefined,
        { cause: parsed.error },
      );
    }
    const request = parsed.data;

    // 1. Explicit operator + reason. Both are required, bounded and
    //    credential-free; neither is ever inferred from a session.
    const operatorId = assertOperatorIdentity(request.operatorId);
    const reason = assertActivationReason(request.reason);

    const client = await this.options.db.connect();
    try {
      await client.query('BEGIN');

      // 2. Locate the user (email or uuid), then their commercial subscription.
      const user = await this.readUser(client, request.user);
      if (user === null) {
        throw new BillingActivationError(
          'user_not_found',
          'Activation refused: no user matches the given email or identifier.',
        );
      }

      // 10. Lock the subscription row for the whole transaction, so two
      //     concurrent activations serialize and the second replays.
      const subscription = await this.selectSubscriptionForUpdate(client, user.id);
      if (subscription === undefined) {
        throw new BillingActivationError(
          'subscription_not_found',
          'Activation refused: the user has no commercial subscription to activate.',
        );
      }

      // 15. Idempotent replay: an existing fact is returned as-is.
      const existing = await new BillingActivationStore(client).findBySubscriptionId(subscription.id);
      if (existing !== null) {
        await client.query('COMMIT');
        return replayResult(existing);
      }

      // 3. Legacy NULL-lock subscriptions are never activatable.
      if (subscription.locked_pricing_snapshot_id === null) {
        throw new BillingActivationError(
          'pricing_lock_required',
          'Activation refused: the subscription has no locked pricing snapshot. A legacy NULL-lock row is never activatable.',
        );
      }

      // 4. The immutable pricing snapshot must exist and verify.
      const stored = await new BillingPricingSnapshotStore(client).findById(
        subscription.locked_pricing_snapshot_id,
      );
      if (stored === null) {
        throw new BillingActivationError(
          'pricing_snapshot_not_found',
          'Activation refused: the locked pricing snapshot could not be read.',
        );
      }
      const snapshot = verifySnapshot(stored);

      // 5. Starter and the excluded capability-evidence plan are refused.
      assertActivatableBillingPlan(snapshot);

      // The subscription row must agree with the snapshot it is locked to.
      assertSubscriptionCoherent(subscription, snapshot);

      // 6./7./8. Locate the matching verified evidence and re-run the exact
      //         payment reconciliation against it.
      const evidence = await this.locateEvidence(client, {
        evidenceId: request.evidenceId ?? null,
        subscriptionId: subscription.id,
        pricingSnapshotId: stored.id,
      });
      if (evidence === null) {
        throw new BillingActivationError(
          'payment_evidence_not_found',
          'Activation refused: no verified payment evidence exists for this subscription and its locked pricing snapshot.',
        );
      }
      if (
        evidence.provider !== BILLING_PROVIDER ||
        evidence.providerDomain !== 'test' ||
        evidence.providerStatus !== 'success'
      ) {
        throw new BillingActivationError(
          'evidence_not_successful',
          'Activation refused: the payment evidence is not a successful sandbox paystack transaction.',
        );
      }

      const expectedReference = billingCheckoutReference(user.id, stored.idempotencyKey);
      const localCustomer = await this.readLocalCustomer(client, user.id);
      const verified = billingVerifiedTransactionSchema.parse({
        provider: evidence.provider,
        providerReference: evidence.providerReference,
        providerTransactionId: evidence.providerTransactionId,
        providerStatus: evidence.providerStatus,
        providerDomain: evidence.providerDomain,
        paymentCurrency: evidence.paymentCurrency,
        paymentAmountMinor: evidence.paymentAmountMinor,
        paymentAmountExponent: evidence.paymentAmountExponent,
        providerCustomerId: evidence.providerCustomerId,
        providerCustomerCode: evidence.providerCustomerCode,
        paidAt: evidence.paidAt,
        verifiedAt: evidence.verifiedAt,
      } satisfies BillingVerifiedTransaction);

      const reconciliation = reconcileBillingPaymentEvidence({
        verified,
        expectedReference,
        snapshot,
        localCustomer,
      });
      if (!reconciliation.ok) {
        throw new BillingActivationError(
          'reconciliation_failed',
          `Activation refused: the payment evidence does not reconcile against the locked pricing snapshot (${reconciliation.reason}).`,
          { reconciliationReason: reconciliation.reason },
        );
      }

      // 11. Exactly one activation fact.
      const activatedAt = (request.activatedAt !== undefined ? new Date(request.activatedAt) : this.now()).toISOString();
      const idempotencyKey = billingSubscriptionActivationIdempotencyKey({
        provider: BILLING_PROVIDER,
        providerReference: evidence.providerReference,
        pricingSnapshotId: stored.id,
      });

      let activation: BillingSubscriptionActivation;
      try {
        const inserted = await client.query(
          `INSERT INTO billing_subscription_activations (
             user_id, subscription_id, pricing_snapshot_id, evidence_id,
             catalogue_plan, billing_interval, provider, provider_plan_id, provider_reference,
             payment_currency, payment_amount_minor, payment_amount_exponent, evidence_hash,
             operator_id, activation_reason, activated_at, idempotency_key
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
          [
            user.id,
            subscription.id,
            stored.id,
            evidence.id,
            snapshot.cataloguePlan,
            snapshot.interval,
            BILLING_PROVIDER,
            snapshot.providerPlanId,
            evidence.providerReference,
            evidence.paymentCurrency,
            evidence.paymentAmountMinor,
            evidence.paymentAmountExponent,
            evidence.evidenceHash,
            operatorId,
            reason,
            activatedAt,
            idempotencyKey,
          ],
        );
        if (inserted.rows[0] !== undefined) {
          activation = fromActivationRow(inserted.rows[0]);
        } else {
          // Lost the race on the deterministic key: the winner's fact is
          // returned instead, so a concurrent activation replays rather than
          // duplicating.
          const winner = await new BillingActivationStore(client).findBySubscriptionId(subscription.id);
          if (winner === null) {
            throw new BillingActivationError(
              'conflict',
              'Activation refused: a conflicting activation fact already exists for this subscription.',
            );
          }
          await client.query('COMMIT');
          return replayResult(winner);
        }
      } catch (error) {
        if (isBillingActivationError(error)) throw error;
        throw mapDatabaseRefusal(error);
      }

      // 12. The transactional audit event, on the SAME client/transaction.
      try {
        await recordAuditEvent(client, {
          userId: user.id,
          action: BILLING_ACTIVATION_AUDIT_ACTION,
          entityType: 'subscription',
          entityId: subscription.id,
          metadata: {
            activationId: activation.id,
            operatorId,
            reason,
            evidenceId: evidence.id,
            pricingSnapshotId: stored.id,
            idempotencyKey: activation.idempotencyKey,
            provider: BILLING_PROVIDER,
            providerReference: evidence.providerReference,
            cataloguePlan: snapshot.cataloguePlan,
            billingInterval: snapshot.interval,
            paymentCurrency: evidence.paymentCurrency,
            paymentAmountMinor: evidence.paymentAmountMinor,
            paymentAmountExponent: evidence.paymentAmountExponent,
            activatedAt,
            // Pinned: an activation never grants execution and never moves a
            // plan or a provider state.
            grantsExecution: false,
            planChanged: false,
          },
        });
      } catch (error) {
        // The audit event is part of the fact: if it cannot be written, the
        // activation does not exist.
        throw new BillingActivationError(
          'invalid_input',
          'Activation refused: the audit event could not be written, so no activation fact was recorded.',
          undefined,
          { cause: error },
        );
      }

      // 13. Both commit together.
      await client.query('COMMIT');

      return {
        outcome: 'activated',
        replayed: false,
        activation,
        paymentConfirmed: true,
        grantsExecution: false,
        planChanged: false,
        entitlementsChanged: false,
      };
    } catch (error) {
      // 14. Roll everything back on failure.
      await client.query('ROLLBACK').catch(() => undefined);
      throw isBillingActivationError(error) ? error : mapDatabaseRefusal(error);
    } finally {
      client.release();
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /** A user is addressable by uuid or by email; nothing else is accepted. */
  private async readUser(
    client: PoolClient,
    reference: string,
  ): Promise<{ id: string; email: string } | null> {
    const asUuid = z.string().uuid().safeParse(reference);
    const { rows } = asUuid.success
      ? await client.query<{ id: string; email: string }>(
          'SELECT id, email FROM users WHERE id = $1',
          [reference],
        )
      : await client.query<{ id: string; email: string }>(
          'SELECT id, email FROM users WHERE email = $1',
          [reference],
        );
    return rows[0] ?? null;
  }

  private async selectSubscriptionForUpdate(
    client: PoolClient,
    userId: string,
  ): Promise<SubscriptionFactRow | undefined> {
    const { rows } = await client.query<SubscriptionFactRow>(
      `SELECT id, user_id, plan, status, provider, catalogue_plan, billing_interval,
              provider_plan_id, locked_pricing_snapshot_id
         FROM subscriptions WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    return rows[0];
  }

  /**
   * Locate the verified payment evidence this activation rests on. With an
   * explicit evidence id the operator pins the row; otherwise the matching
   * row is derived from the subscription and its locked snapshot (the
   * provider reference is deterministic, so at most one can match).
   */
  private async locateEvidence(
    client: PoolClient,
    args: { evidenceId: string | null; subscriptionId: string; pricingSnapshotId: string },
  ): Promise<BillingPaymentEvidence | null> {
    const store = new BillingVerifiedTransactionStore(client);
    if (args.evidenceId !== null) {
      const pinned = await store.findById(args.evidenceId);
      if (pinned === null) return null;
      if (
        pinned.subscriptionId !== args.subscriptionId ||
        pinned.pricingSnapshotId !== args.pricingSnapshotId
      ) {
        return null;
      }
      return pinned;
    }
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM billing_verified_transactions
        WHERE subscription_id = $1 AND pricing_snapshot_id = $2
          AND provider = $3 AND provider_domain = 'test' AND provider_status = 'success'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [args.subscriptionId, args.pricingSnapshotId, BILLING_PROVIDER],
    );
    const id = rows[0]?.id;
    if (id === undefined) return null;
    return store.findById(id);
  }

  private async readLocalCustomer(
    client: PoolClient,
    userId: string,
  ): Promise<{ providerCustomerId: string | null; providerCustomerCode: string | null } | null> {
    const { rows } = await client.query<{
      provider_customer_id: string | null;
      provider_customer_code: string | null;
    }>(
      `SELECT provider_customer_id, provider_customer_code
         FROM billing_customers WHERE provider = $1 AND user_id = $2`,
      [BILLING_PROVIDER, userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      providerCustomerId: row.provider_customer_id,
      providerCustomerCode: row.provider_customer_code,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function assertOperatorIdentity(operatorId: string): string {
  const value = operatorId.trim();
  if (value.length === 0 || value.length > OPERATOR_ID_MAX) {
    throw new BillingActivationError(
      'invalid_operator_input',
      'Activation refused: an explicit operator identity is required (1-128 characters).',
    );
  }
  if (CREDENTIAL_SHAPE.test(value)) {
    throw new BillingActivationError(
      'invalid_operator_input',
      'Activation refused: the operator identity must not be credential-shaped.',
    );
  }
  return value;
}

function assertActivationReason(reason: string): string {
  const value = reason.trim();
  if (value.length === 0 || value.length > REASON_MAX) {
    throw new BillingActivationError(
      'invalid_operator_input',
      'Activation refused: an explicit activation reason is required (1-500 characters).',
    );
  }
  if (CREDENTIAL_SHAPE.test(value)) {
    throw new BillingActivationError(
      'invalid_operator_input',
      'Activation refused: the activation reason must not be credential-shaped.',
    );
  }
  return value;
}

function verifySnapshot(stored: StoredBillingPricingSnapshot): BillingPricingSnapshot {
  try {
    return verifyPricingSnapshot(stored.snapshot);
  } catch (error) {
    throw new BillingActivationError(
      'invalid_snapshot',
      `Activation refused: the locked pricing snapshot is invalid: ${error instanceof Error ? error.message : 'unknown'}`,
      undefined,
      { cause: error },
    );
  }
}

/**
 * The commercial-identity gate: Starter is not sellable, an unbound snapshot
 * has no plan to sell, and the capability-evidence provider plan is never an
 * activation target. Exported so the gate is directly testable (the snapshot
 * table pins `catalogue_plan` to pro|elite, so the Starter branch is defence
 * in depth that a database-only test cannot reach).
 */
export function assertActivatableBillingPlan(snapshot: BillingPricingSnapshot): void {
  if (snapshot.cataloguePlan === 'starter') {
    throw new BillingActivationError(
      'forbidden_plan',
      'Activation refused: starter is not a sellable plan and cannot be activated.',
    );
  }
  if (snapshot.providerPlanId === null || snapshot.providerPlanId.trim() === '') {
    throw new BillingActivationError(
      'plan_not_registered',
      'Activation refused: the locked pricing snapshot is not bound to a provider plan epoch.',
    );
  }
  if (isExcludedBillingProviderPlan(snapshot.providerPlanId)) {
    throw new BillingActivationError(
      'excluded_provider_plan',
      'Activation refused: the excluded capability-evidence provider plan is never activatable.',
    );
  }
}

function assertSubscriptionCoherent(
  subscription: SubscriptionFactRow,
  snapshot: BillingPricingSnapshot,
): void {
  if (
    subscription.provider !== BILLING_PROVIDER ||
    subscription.catalogue_plan !== snapshot.cataloguePlan ||
    subscription.billing_interval !== snapshot.interval ||
    subscription.provider_plan_id !== snapshot.providerPlanId ||
    subscription.plan !== internalPlanForCommercialPlan(snapshot.cataloguePlan)
  ) {
    throw new BillingActivationError(
      'incoherent_subscription',
      'Activation refused: the subscription row disagrees with the pricing snapshot it is locked to.',
    );
  }
}

/** Map a database refusal (trigger, constraint, race) onto a typed reason. */
function mapDatabaseRefusal(error: unknown): BillingActivationError {
  if (isBillingVerifiedTransactionError(error)) {
    return new BillingActivationError(
      'invalid_evidence_row',
      `Activation refused: the stored payment evidence is not usable (${error.reason}).`,
      undefined,
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('billing_subscription_activations coherence')) {
    return new BillingActivationError(
      'incoherent_activation',
      `Activation refused by the database coherence trigger: ${message}`,
      undefined,
      { cause: error },
    );
  }
  if (message.includes('billing_subscription_activations is append-only')) {
    return new BillingActivationError(
      'incoherent_activation',
      'Activation refused: an activation fact is immutable once recorded.',
      undefined,
      { cause: error },
    );
  }
  return new BillingActivationError('conflict', `Activation failed: ${message}`, undefined, {
    cause: error,
  });
}

function replayResult(activation: BillingSubscriptionActivation): BillingActivationResult {
  return {
    outcome: 'already_activated',
    replayed: true,
    activation,
    paymentConfirmed: true,
    grantsExecution: false,
    planChanged: false,
    entitlementsChanged: false,
  };
}
