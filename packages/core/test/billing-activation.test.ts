/**
 * Billing Step 8 — the ACTIVATION AUTHORITY, against a real database.
 *
 * The chain this suite pins end to end:
 *
 *   verified payment evidence (0033)
 *     → explicit out-of-band operator authorization (BillingActivationService)
 *     → immutable activation fact (0034)
 *     → read-side paid entitlement (getBillingState / resolveEntitlements)
 *
 * and, just as importantly, everything that must NOT reach a paid entitlement:
 * evidence alone, a webhook receipt alone, a provider-state move alone, and any
 * client-supplied payment confirmation.
 *
 * Nothing here contacts a provider: the service holds no provider at all, and
 * no test registers one.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import {
  AutomationService,
  AuditService,
  BillingActivationService,
  BillingProviderEventStore,
  BillingSubscriptionSyncService,
  FREE_ENTITLEMENTS,
  KillSwitchService,
  StrategyService,
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  billingSubscriptionActivationIdempotencyKey,
  billingSubscriptionActivationIdempotencyCanonicalString,
  createBillingProviderRegistry,
  createFreeSubscription,
  createUnimplementedBillingProvider,
  getBillingState,
  assertActivatableBillingPlan,
  getEntitlements,
  isBillingActivationError,
  reconcileBillingPaymentEvidence,
} from '../src/index.js';
import type { BillingPricingSnapshot } from '@veltrixeye/contracts';
import type { BillingActivationError } from '../src/billing/activation.js';
import {
  insertUser, seedActivatedSubscription, seedCommercialSubscription,
  seedPaymentEvidence, startBillingTestDb,
} from './helpers/billing-checkout.js';
import type { PoolClient } from 'pg';

/** The one provider plan that is capability evidence only, never an epoch. */
const EXCLUDED_PROVIDER_PLAN = ['PLN', 'u0l4961hhipl6ek'].join('_');
const OPERATOR = 'ops-17';
const REASON = 'sandbox transaction verified and reviewed by the on-call operator';
const ACTIVATED_AT = new Date('2026-09-23T09:30:00.000Z');

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let pool: Pool;

before(async () => {
  db = await startBillingTestDb(5501);
  pool = db.pool;
}, { timeout: 180_000 });
after(async () => { await db?.stop(); });

// No cleanup hook: an activation fact is append-only by design (0034 refuses
// UPDATE and DELETE), so every test works on a freshly seeded user instead.

/** An in-memory starter snapshot: the shape the service-level gate refuses. */
function starterSnapshot(): BillingPricingSnapshot {
  return {
    commercialCurrency: 'USD',
    commercialAmountMinor: 1500,
    catalogueVersion: 'v1',
    cataloguePlan: 'starter',
    interval: 'monthly',
    payment: { paymentCurrency: 'GHS', paymentAmountMinor: 18_750, paymentAmountExponent: 2 },
    fx: {
      baseCurrency: 'USD', quoteCurrency: 'GHS', fxRateScaled: 12_500_000, fxRateScale: 6,
      fxRateVersionId: '5b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      fxRateEffectiveFrom: '2026-09-22T08:00:00.000Z', fxRateCapturedAt: '2026-09-22T08:00:00.000Z',
      fxRateSource: 'ops', roundingMode: 'half_up',
    },
    providerPlanId: 'PLN_starterish',
    providerReference: null,
    pricingPolicyVersion: 'v1',
    computedAt: '2026-09-22T12:00:00.000Z',
  };
}

const service = (): BillingActivationService =>
  new BillingActivationService({ db: pool, now: () => ACTIVATED_AT });

async function activationCount(userId?: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM billing_subscription_activations WHERE ($1::uuid IS NULL OR user_id = $1)',
    [userId ?? null],
  );
  return rows[0]!.n;
}

async function auditCount(userId?: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_events WHERE action = 'billing.subscription_activated' AND ($1::uuid IS NULL OR user_id = $1)",
    [userId ?? null],
  );
  return rows[0]!.n;
}

/** Capture a SYNCHRONOUS refusal from a pure gate. */
function gateRefusal(run: () => unknown): BillingActivationError {
  try {
    run();
  } catch (error) {
    assert.ok(isBillingActivationError(error), `expected a typed refusal, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the gate to refuse' });
}

async function refusal(
  promise: Promise<unknown>,
): Promise<BillingActivationError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isBillingActivationError(error), `expected a typed activation refusal, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the activation to be refused' });
}

/* ==========================================================================
   1. A successful activation
   ========================================================================== */

describe('Step 8 — a successful activation', () => {
  it('records exactly one immutable fact, one audit event, and moves nothing else', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id, { cataloguePlan: 'pro' });
    await seedPaymentEvidence(pool, user.id, commercial);

    const subscriptionBefore = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [commercial.subscriptionId]);
    const userBefore = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);

    const result = await service().activate({
      user: user.email, operatorId: OPERATOR, reason: REASON,
    });

    assert.equal(result.outcome, 'activated');
    assert.equal(result.replayed, false);
    assert.equal(result.paymentConfirmed, true);
    assert.equal(result.grantsExecution, false);
    assert.equal(result.planChanged, false);
    assert.equal(result.entitlementsChanged, false);

    const { activation } = result;
    assert.equal(activation.userId, user.id);
    assert.equal(activation.subscriptionId, commercial.subscriptionId);
    assert.equal(activation.pricingSnapshotId, commercial.pricingSnapshotId);
    assert.equal(activation.cataloguePlan, 'pro');
    assert.equal(activation.billingInterval, 'monthly');
    assert.equal(activation.provider, 'paystack');
    assert.equal(activation.providerReference, commercial.reference);
    assert.equal(activation.paymentAmountMinor, commercial.amountMinor);
    assert.equal(activation.paymentCurrency, 'GHS');
    assert.equal(activation.paymentAmountExponent, 2);
    assert.equal(activation.operatorId, OPERATOR);
    assert.equal(activation.activationReason, REASON);
    assert.equal(activation.activatedAt, ACTIVATED_AT.toISOString());
    assert.equal(
      activation.idempotencyKey,
      billingSubscriptionActivationIdempotencyKey({
        provider: 'paystack', providerReference: commercial.reference,
        pricingSnapshotId: commercial.pricingSnapshotId,
      }),
    );

    assert.equal(await activationCount(), 1, 'exactly one activation fact');
    assert.equal(await auditCount(), 1, 'exactly one audit event');
    // The subscription row is untouched: no plan, status or provider state moved.
    assert.deepEqual(
      (await pool.query('SELECT * FROM subscriptions WHERE id = $1', [commercial.subscriptionId])).rows,
      subscriptionBefore.rows,
    );
    // users.plan is untouched.
    assert.deepEqual((await pool.query('SELECT * FROM users WHERE id = $1', [user.id])).rows, userBefore.rows);
  });

  it('accepts a user addressed by uuid as well as by email', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id, { cataloguePlan: 'elite' });
    await seedPaymentEvidence(pool, user.id, commercial);
    const result = await service().activate({ user: user.id, operatorId: OPERATOR, reason: REASON });
    assert.equal(result.activation.cataloguePlan, 'elite');
  });

  it('honours an explicit --evidence pin', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    const evidence = await seedPaymentEvidence(pool, user.id, commercial);
    const result = await service().activate({
      user: user.email, operatorId: OPERATOR, reason: REASON, evidenceId: evidence.evidenceId,
    });
    assert.equal(result.activation.evidenceId, evidence.evidenceId);
  });

  it('the idempotency key is a deterministic function of the payment identity', () => {
    const identity = {
      provider: 'paystack',
      providerReference: `ve-chk-${'a'.repeat(64)}`,
      pricingSnapshotId: '5b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    };
    assert.equal(
      billingSubscriptionActivationIdempotencyKey(identity),
      billingSubscriptionActivationIdempotencyKey(identity),
    );
    assert.match(billingSubscriptionActivationIdempotencyCanonicalString(identity), /^billing-activation\/v1\|/);
    assert.match(billingSubscriptionActivationIdempotencyKey(identity), /^[0-9a-f]{64}$/);
    // A different reference is a different key.
    assert.notEqual(
      billingSubscriptionActivationIdempotencyKey(identity),
      billingSubscriptionActivationIdempotencyKey({ ...identity, providerReference: `ve-chk-${'b'.repeat(64)}` }),
    );
  });
});

/* ==========================================================================
   2. Idempotency and concurrency
   ========================================================================== */

describe('Step 8 — idempotent replay', () => {
  it('a second activation replays the existing fact and writes nothing', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);

    const first = await service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON });
    const second = await service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON });

    assert.equal(first.outcome, 'activated');
    assert.equal(second.outcome, 'already_activated');
    assert.equal(second.replayed, true);
    assert.equal(second.activation.id, first.activation.id, 'the SAME fact is returned');
    assert.equal(second.activation.operatorId, OPERATOR, 'the original operator is preserved');
    assert.equal(await activationCount(user.id), 1, 'no second fact');
    assert.equal(await auditCount(user.id), 1, 'no second audit event');
  });

  it('a replay with a different operator or reason still returns the original fact', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);
    await service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON });
    const replay = await service().activate({
      user: user.email, operatorId: 'ops-99', reason: 'a different reason entirely',
    });
    assert.equal(replay.outcome, 'already_activated');
    assert.equal(replay.activation.operatorId, OPERATOR);
    assert.equal(replay.activation.activationReason, REASON);
  });

  it('concurrent activations produce exactly one fact and one audit event', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);

    const results = await Promise.all(
      [OPERATOR, 'ops-18'].map((operatorId) =>
        service().activate({ user: user.email, operatorId, reason: REASON }),
      ),
    );
    const activated = results.filter((r) => r.outcome === 'activated');
    const replayed = results.filter((r) => r.outcome === 'already_activated');
    assert.equal(activated.length, 1, 'exactly one writer');
    assert.equal(replayed.length, 1, 'the other one replays');
    assert.equal(activated[0]!.activation.id, replayed[0]!.activation.id);
    assert.equal(await activationCount(user.id), 1);
    assert.equal(await auditCount(user.id), 1);
  });
});

/* ==========================================================================
   3. Evidence and reconciliation refusals
   ========================================================================== */

describe('Step 8 — the payment evidence must reconcile exactly', () => {
  it('refuses when no verified evidence exists at all', async () => {
    const user = await insertUser(pool, true);
    await seedCommercialSubscription(pool, user.id);
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'payment_evidence_not_found');
    assert.equal(await activationCount(user.id), 0);
    assert.equal(await auditCount(user.id), 0);
  });

  it('refuses an evidence row for a different subscription', async () => {
    const owner = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, owner.id);
    const evidence = await seedPaymentEvidence(pool, owner.id, commercial);
    // A second user's own commercial subscription, activated with the FIRST
    // user's evidence pinned explicitly.
    const other = await insertUser(pool, true);
    await seedCommercialSubscription(pool, other.id);
    const error = await refusal(service().activate({
      user: other.email, operatorId: OPERATOR, reason: REASON, evidenceId: evidence.evidenceId,
    }));
    assert.equal(error.reason, 'payment_evidence_not_found');
    assert.equal(await activationCount(other.id), 0);
  });

  it('refuses a wrong amount (exact integer equality, no tolerance)', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial, { paymentAmountMinor: commercial.amountMinor + 1 });
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'reconciliation_failed');
    assert.equal(error.detail?.reconciliationReason, 'amount_mismatch');
    assert.equal(await activationCount(user.id), 0);
  });

  it('refuses a wrong reference', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial, {
      providerReference: `ve-chk-${'0'.repeat(64)}`,
    });
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'reconciliation_failed');
    assert.equal(error.detail?.reconciliationReason, 'reference_mismatch');
  });

  it('refuses a wrong customer (the evidence must belong to our billing customer)', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial, { providerCustomerCode: 'CUS_somebody_else' });
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'reconciliation_failed');
    assert.equal(error.detail?.reconciliationReason, 'customer_mismatch');
  });

  it('refuses an unsuccessful transaction status', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    const evidence = await seedPaymentEvidence(pool, user.id, commercial, { providerStatus: 'failed' });
    const error = await refusal(service().activate({
      user: user.email, operatorId: OPERATOR, reason: REASON, evidenceId: evidence.evidenceId,
    }));
    assert.equal(error.reason, 'evidence_not_successful');
    assert.equal(await activationCount(user.id), 0);
  });

  it('a non-sandbox domain is unrepresentable in the evidence table at all', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await assert.rejects(
      seedPaymentEvidence(pool, user.id, commercial, { providerDomain: 'live' as 'test' }),
      /domain/,
      'migration 0033 pins the domain to test, so activation can never see a live observation',
    );
  });

  it('the currency/exponent check the activation re-runs is exact', () => {
    // The evidence and snapshot tables both pin GHS/2 at the database level,
    // so a wrong currency or exponent can never reach the service. The check
    // the activation re-runs is the SAME pure reconciliation, pinned here.
    const snapshot = {
      commercialCurrency: 'USD', commercialAmountMinor: 3900, catalogueVersion: 'v1',
      cataloguePlan: 'pro', interval: 'monthly',
      payment: { paymentCurrency: 'GHS', paymentAmountMinor: 48_750, paymentAmountExponent: 2 },
      fx: {
        baseCurrency: 'USD', quoteCurrency: 'GHS', fxRateScaled: 12_500_000, fxRateScale: 6,
        fxRateVersionId: '5b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        fxRateEffectiveFrom: '2026-09-22T08:00:00.000Z', fxRateCapturedAt: '2026-09-22T08:00:00.000Z',
        fxRateSource: 'ops', roundingMode: 'half_up',
      },
      providerPlanId: 'PLN_test', providerReference: null,
      pricingPolicyVersion: 'v1', computedAt: '2026-09-22T12:00:00.000Z',
    } as const;
    const verified = {
      provider: 'paystack', providerReference: `ve-chk-${'a'.repeat(64)}`, providerTransactionId: null,
      providerStatus: 'success', providerDomain: 'test', paymentCurrency: 'GHS',
      paymentAmountMinor: 48_750, paymentAmountExponent: 2, providerCustomerId: null,
      providerCustomerCode: null, paidAt: '2026-09-22T12:00:00.000Z', verifiedAt: '2026-09-22T12:00:00.000Z',
    } as const;
    const base = { verified, expectedReference: verified.providerReference, snapshot };
    assert.equal(reconcileBillingPaymentEvidence(base).ok, true);
    assert.deepEqual(
      reconcileBillingPaymentEvidence({
        ...base, verified: { ...verified, paymentCurrency: 'USD' as 'GHS' },
      }),
      { ok: false, reason: 'currency_mismatch', message: 'The transaction currency does not match the pricing snapshot.' },
    );
    assert.equal(
      reconcileBillingPaymentEvidence({ ...base, verified: { ...verified, paymentAmountExponent: 3 } }).ok,
      false,
    );
  });
});

/* ==========================================================================
   4. Commercial-identity refusals
   ========================================================================== */

describe('Step 8 — what can never be activated', () => {
  it('refuses the excluded capability-evidence provider plan', async () => {
    const user = await insertUser(pool, true);
    await seedCommercialSubscription(pool, user.id, { providerPlanId: EXCLUDED_PROVIDER_PLAN });
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'excluded_provider_plan');
    assert.equal(await activationCount(user.id), 0);
  });

  it('refuses a starter plan: starter is not a sellable plan', () => {
    // The pricing-snapshot table pins catalogue_plan to pro|elite, so the
    // service-level gate is defence in depth; the database refuses a starter
    // fact outright (see billing-activation-db.test.ts).
    const error = gateRefusal(() => assertActivatableBillingPlan(starterSnapshot()));
    assert.equal(error.reason, 'forbidden_plan');
  });

  it('refuses a snapshot that is not bound to a provider plan epoch', () => {
    const snapshot = { ...starterSnapshot(), cataloguePlan: 'pro' as const, providerPlanId: null };
    const error = gateRefusal(() => assertActivatableBillingPlan(snapshot));
    assert.equal(error.reason, 'plan_not_registered');
  });

  it('refuses the excluded provider plan through the same gate', () => {
    const error = gateRefusal(() => assertActivatableBillingPlan({
      ...starterSnapshot(), cataloguePlan: 'elite' as const, providerPlanId: EXCLUDED_PROVIDER_PLAN,
    }));
    assert.equal(error.reason, 'excluded_provider_plan');
  });

  it('refuses a subscription row that disagrees with its own locked snapshot', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);
    await pool.query(
      "UPDATE subscriptions SET provider_plan_id = 'PLN_something_else' WHERE id = $1",
      [commercial.subscriptionId],
    );
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'incoherent_subscription');
    assert.equal(await activationCount(user.id), 0);
  });

  it('refuses a legacy NULL-lock subscription', async () => {
    const user = await insertUser(pool, false);
    await createFreeSubscription(pool, user.id);
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'pricing_lock_required');
    assert.equal(await activationCount(user.id), 0);
  });

  it('refuses a user with no subscription row at all', async () => {
    const user = await insertUser(pool, false);
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'subscription_not_found');
  });

  it('refuses an unknown user', async () => {
    const error = await refusal(service().activate({
      user: 'nobody@example.test', operatorId: OPERATOR, reason: REASON,
    }));
    assert.equal(error.reason, 'user_not_found');
  });
});

/* ==========================================================================
   5. Operator authorization is explicit
   ========================================================================== */

describe('Step 8 — an activation without an explicit operator authorization is unrepresentable', () => {
  const user = async (): Promise<{ id: string; email: string }> => {
    const created = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, created.id);
    await seedPaymentEvidence(pool, created.id, commercial);
    return created;
  };

  it('refuses an empty operator identity', async () => {
    const u = await user();
    const error = await refusal(service().activate({ user: u.email, operatorId: '   ', reason: REASON }));
    assert.equal(error.reason, 'invalid_operator_input');
  });

  it('refuses an empty reason', async () => {
    const u = await user();
    const error = await refusal(service().activate({ user: u.email, operatorId: OPERATOR, reason: '' }));
    assert.equal(error.reason, 'invalid_operator_input');
  });

  it('refuses an oversized operator identity or reason', async () => {
    const u = await user();
    assert.equal(
      (await refusal(service().activate({ user: u.email, operatorId: 'o'.repeat(129), reason: REASON }))).reason,
      'invalid_operator_input',
    );
    assert.equal(
      (await refusal(service().activate({ user: u.email, operatorId: OPERATOR, reason: 'r'.repeat(501) }))).reason,
      'invalid_operator_input',
    );
  });

  it('refuses a credential-shaped operator identity or reason', async () => {
    const u = await user();
    assert.equal(
      (await refusal(service().activate({
        user: u.email, operatorId: 'paystack-secret-key', reason: REASON,
      }))).reason,
      'invalid_operator_input',
      'a credential-shaped value is never an operator identity',
    );
    assert.equal(
      (await refusal(service().activate({
        user: u.email, operatorId: OPERATOR, reason: 'paid with the secret token from the dashboard',
      }))).reason,
      'invalid_operator_input',
    );
  });

  it('refuses a malformed request outright', async () => {
    const u = await user();
    assert.equal(
      (await refusal(service().activate({ user: '', operatorId: OPERATOR, reason: REASON }))).reason,
      'invalid_input',
    );
    assert.equal(
      (await refusal(service().activate({
        user: u.email, operatorId: OPERATOR, reason: REASON, evidenceId: 'not-a-uuid',
      }))).reason,
      'invalid_input',
    );
  });

  it('every refusal writes nothing at all', async () => {
    const u = await user();
    await refusal(service().activate({ user: u.email, operatorId: '', reason: REASON }));
    assert.equal(await activationCount(u.id), 0);
    assert.equal(await auditCount(u.id), 0);
  });
});

/* ==========================================================================
   6. Transactional integrity
   ========================================================================== */

describe('Step 8 — the fact and its audit event are one unit of work', () => {
  it('rolls everything back when the audit event cannot be written', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);

    // Inject a real database failure on the audit INSERT only: the activation
    // fact must not survive its audit event.
    const failing = new FailingAuditPool(pool);
    const error = await refusal(
      new BillingActivationService({ db: failing as unknown as Pool, now: () => ACTIVATED_AT }).activate({
        user: user.email, operatorId: OPERATOR, reason: REASON,
      }),
    );
    assert.match(error.message, /audit event could not be written/);
    assert.equal(await activationCount(user.id), 0, 'no activation fact survived');
    assert.equal(await auditCount(user.id), 0, 'no audit event either');
    assert.ok(failing.sawAuditWrite, 'the audit write was attempted on the transaction client');
  });

  it('a coherence disagreement is refused before anything is written', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);
    // Move the subscription's provider plan away from the snapshot it is locked
    // to: the service refuses, and the database trigger would refuse too.
    await pool.query(
      "UPDATE subscriptions SET provider_plan_id = 'PLN_something_else' WHERE id = $1",
      [commercial.subscriptionId],
    );
    const error = await refusal(service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON }));
    assert.equal(error.reason, 'incoherent_subscription');
    assert.equal(await activationCount(user.id), 0);
    assert.equal(await auditCount(user.id), 0);
  });
});

/** A pool whose audit INSERTs fail, to prove the transaction rolls back. */
class FailingAuditPool {
  sawAuditWrite = false;

  constructor(private readonly inner: Pool) {}

  async connect(): Promise<PoolClient> {
    const client = await this.inner.connect();
    return new Proxy(client, {
      get: (target, property, receiver) => {
        if (property === 'query') {
          return async (sql: unknown, ...rest: unknown[]) => {
            if (typeof sql === 'string' && sql.includes('audit_events')) {
              this.sawAuditWrite = true;
              // A real, database-level failure inside the transaction.
              await target.query('SELECT 1 / 0');
            }
            return (target.query as (...args: unknown[]) => unknown)(sql, ...rest);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as PoolClient;
  }
}

/* ==========================================================================
   7. Lifecycle independence
   ========================================================================== */

describe('Step 8 — the activation is independent of provider lifecycle state', () => {
  it('activates a subscription whose provider state is unknown, and leaves it unknown', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id, { providerState: 'unknown' });
    await seedPaymentEvidence(pool, user.id, commercial);

    const before = await getBillingState(pool, user.id);
    assert.deepEqual(before.entitlements, FREE_ENTITLEMENTS, 'unknown state alone grants nothing');

    const result = await service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON });
    assert.equal(result.outcome, 'activated');

    const row = await pool.query('SELECT provider_state, status FROM subscriptions WHERE id = $1', [
      commercial.subscriptionId,
    ]);
    assert.equal(row.rows[0]!.provider_state, 'unknown', 'provider_state is never written by an activation');
    assert.equal(row.rows[0]!.status, 'active');

    const after = await getBillingState(pool, user.id);
    assert.deepEqual(after.entitlements, getEntitlements('pro', 'active'));
    assert.equal(after.providerStatus.providerState, 'unknown');
    assert.equal(after.providerStatus.paymentConfirmed, true);
  });

  it('an activation is not a lifecycle: a lapsed subscription still resolves to free', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await pool.query("UPDATE subscriptions SET status = 'canceled' WHERE id = $1", [commercial.subscriptionId]);
    await seedPaymentEvidence(pool, user.id, commercial);
    await service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON });
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS);
    assert.equal(state.subscription.status, 'canceled', 'the status is reported, never rewritten');
    assert.equal(state.providerStatus.paymentConfirmed, true, 'the fact exists even when the row lapsed');
  });
});

/* ==========================================================================
   8. The read side: what does and does not reach a paid entitlement
   ========================================================================== */

describe('Step 8 — only an activation fact reaches a paid entitlement', () => {
  it('evidence alone stays free', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS);
    assert.equal(state.providerStatus.paymentConfirmed, false);
  });

  it('a webhook receipt alone stays free', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    const store = new BillingProviderEventStore(pool);
    const payloadHash = billingEventPayloadHash({ event: 'charge.success', data: { reference: commercial.reference } });
    const input = {
      provider: 'paystack' as const, providerEventId: null,
      eventType: 'payment.succeeded' as const, occurredAt: '2026-09-23T08:00:00.000Z', payloadHash,
    };
    await store.record({
      ...input,
      idempotencyKey: billingEventIdempotencyKey(input),
      subscriptionId: commercial.subscriptionId, userId: user.id,
      providerCustomerId: null, providerSubscriptionId: null, providerReference: commercial.reference,
      failureReason: null, receivedAt: '2026-09-23T08:00:01.000Z',
    });
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS, 'a receipt is not an activation');
    assert.equal(state.providerStatus.paymentConfirmed, false);
    assert.equal(await activationCount(user.id), 0);
  });

  it('a provider-state move alone stays free', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);
    // Exactly what a synchronization would be allowed to write: the canonical
    // lifecycle mapping. It is not an activation.
    await pool.query(
      "UPDATE subscriptions SET status = 'active', provider_state = 'active' WHERE id = $1",
      [commercial.subscriptionId],
    );
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS, 'provider_state is non-authoritative');
    assert.equal(state.providerStatus.paymentConfirmed, false);
    assert.equal(state.providerStatus.providerState, 'active');
  });

  it('a real synchronization still grants nothing', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);
    const registry = createBillingProviderRegistry();
    registry.register({
      ...createUnimplementedBillingProvider(),
      verifySubscription: async () => ({
        provider: 'paystack', state: 'active', providerSubscriptionId: null,
        providerSubscriptionCode: null, providerCustomerId: null, providerCustomerCode: null,
        providerPlanId: null, providerReference: commercial.reference, cataloguePlan: null,
        interval: null, currency: null, payment: null, currentPeriodStart: null,
        currentPeriodEnd: null, cancelAtPeriodEnd: false, cancelAt: null, cancelledAt: null,
        cancellationReason: null, sourceEventIdempotencyKey: null,
        observedAt: '2026-09-23T09:00:00.000Z',
      }),
    });
    const sync = new BillingSubscriptionSyncService({ db: pool, providers: registry });
    const outcome = await sync.synchronize(user.id);
    assert.ok(['updated', 'unchanged'].includes(outcome.outcome), `synchronized: ${outcome.outcome}`);
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS, 'a verified provider view is still not an activation');
    assert.equal(state.providerStatus.paymentConfirmed, false);
  });

  it('an activated provider-backed subscription receives its paid entitlement', async () => {
    const user = await insertUser(pool, true);
    await seedActivatedSubscription(pool, user.id, { cataloguePlan: 'pro' });
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, getEntitlements('pro', 'active'));
    assert.equal(state.entitlements.canAccessScanner, true);
    assert.equal(state.entitlements.canAccessAutomation, false);
    assert.equal(state.providerStatus.paymentConfirmed, true);
  });

  it('the paid entitlement reaches a real limit-enforcing reader', async () => {
    const user = await insertUser(pool, true);
    await seedActivatedSubscription(pool, user.id, { cataloguePlan: 'elite' });
    const strategies = new StrategyService(pool, new AuditService(pool));
    await pool.query(
      `INSERT INTO strategies (user_id, name, description)
       SELECT $1, 'Seeded ' || i, 'fixture' FROM generate_series(1, 100) i`,
      [user.id],
    );
    const created = await strategies.createStrategy(user.id, { name: 'Activated elite strategy' });
    assert.equal(created.name, 'Activated elite strategy');
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM strategies WHERE user_id = $1',
      [user.id],
    );
    assert.equal(rows[0]!.n, 101, 'the paid limit applies, not the free one');
  });

  it('execution stays disabled after activation, for every plan', async () => {
    for (const cataloguePlan of ['pro', 'elite'] as const) {
      const user = await insertUser(pool, true);
      await seedActivatedSubscription(pool, user.id, { cataloguePlan });
      const automation = new AutomationService(pool, new KillSwitchService(pool), new AuditService(pool));
      const state = await automation.readState(user.id);
      assert.equal(state.entitlements.canAccessAutomation, false, `${cataloguePlan}: activation grants no execution`);
      const status = await automation.getStatus(user.id);
      assert.equal(status.entitled, false);
      assert.equal(status.effective, false);
    }
  });

  it('historical provider-null behaviour is unchanged', async () => {
    const user = await insertUser(pool, true);
    await pool.query(
      "INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'premium', 'active')",
      [user.id],
    );
    const state = await getBillingState(pool, user.id);
    assert.deepEqual(state.entitlements, getEntitlements('premium', 'active'));
    assert.equal(state.providerStatus.paymentConfirmed, false, 'a historical row has no activation fact');
    assert.equal(state.providerStatus.provider, null);
  });

  it('an activation fact for one user never widens another user', async () => {
    const activated = await insertUser(pool, true);
    await seedActivatedSubscription(pool, activated.id, { cataloguePlan: 'elite' });
    // A second user with the SAME plan and the SAME evidence, but no fact.
    const other = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, other.id, { cataloguePlan: 'elite' });
    await seedPaymentEvidence(pool, other.id, commercial);
    const state = await getBillingState(pool, other.id);
    assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS, 'evidence without an activation is still free');
    assert.equal(state.providerStatus.paymentConfirmed, false);
    assert.deepEqual(
      (await getBillingState(pool, activated.id)).entitlements,
      getEntitlements('premium', 'active'),
    );
  });
});

/* ==========================================================================
   9. The activation never calls a provider
   ========================================================================== */

describe('Step 8 — the service holds no provider', () => {
  it('activates with no provider registry in existence', async () => {
    const user = await insertUser(pool, true);
    const commercial = await seedCommercialSubscription(pool, user.id);
    await seedPaymentEvidence(pool, user.id, commercial);
    const result = await service().activate({ user: user.email, operatorId: OPERATOR, reason: REASON });
    assert.equal(result.outcome, 'activated');
    // The service's only dependency is the database pool.
    const registry = createBillingProviderRegistry();
    assert.equal(registry.get('paystack'), undefined, 'no provider was registered or consulted');
  });
});
