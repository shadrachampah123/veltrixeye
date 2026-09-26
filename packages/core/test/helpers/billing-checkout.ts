import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { startEmbeddedPostgres } from '../../../../scripts/db/embedded.mjs';
import {
  billingCheckoutReference, billingSubscriptionActivationIdempotencyKey,
  billingVerifiedTransactionEvidenceHash, billingVerifiedTransactionIdempotencyKey,
  createPool, runMigrations, MIGRATIONS_DIR, BILLING_CATALOGUE_VERSION,
  BILLING_PRICING_POLICY_VERSION, BillingPricingSnapshotStore,
  cataloguePriceMinor, computePaymentAmountMinor, priceFromProviderPlanEpoch,
} from '../../src/index.js';
import { internalPlanForCommercialPlan } from '@veltrixeye/contracts';
import type { BillingInterval, CommercialPlanId } from '@veltrixeye/contracts';

export const AS_OF = new Date('2026-09-22T12:00:00.000Z');
/** The capability-evidence plan code that is never a sellable epoch. */
const EXCLUDED_EPOCH_PLAN = ['PLN', 'u0l4961hhipl6ek'].join('_');
export const PRO_MONTHLY = { cataloguePlan: 'pro', interval: 'monthly' } as const;
export const EPOCH_COLUMNS = `id, provider, mode, catalogue_plan, billing_interval, payment_currency,
  payment_amount_minor, payment_amount_exponent, provider_plan_id, provider_plan_reference,
  fx_rate_version_id, pricing_policy_version, catalogue_version, status, valid_from, retired_at, retired_reason`;
let sequence = 0;

export async function startBillingTestDb(port: number) {
  const testDir = path.resolve(MIGRATIONS_DIR, '../../../../../.test');
  mkdirSync(testDir, { recursive: true });
  const dataDir = mkdtempSync(path.join(testDir, 'billing-prc-'));
  const db = await startEmbeddedPostgres({ dataDir, port, user: 'test', password: randomUUID(), database: 'billing_prc' });
  const pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  return {
    pool, dbUrl: db.dbUrl,
    async stop() { await pool.end(); await db.stop(); rmSync(dataDir, { recursive: true, force: true }); },
  };
}

export async function insertFx(pool: Pool, rateScaled = 12_500_000) {
  // Intentionally hours older than asOf: epoch checkout MUST NOT apply freshness.
  const captured = new Date(Date.parse('2026-09-22T08:00:00.000Z') + sequence++ * 1000);
  const { rows } = await pool.query(
    `INSERT INTO billing_fx_rate_versions (fx_rate_scaled, fx_rate_scale, source, effective_from, captured_at)
     VALUES ($1,6,'ops',$2,$2) RETURNING *`, [rateScaled, captured],
  );
  return rows[0]!;
}

export async function insertEpoch(pool: Pool, options: {
  plan?: CommercialPlanId; interval?: BillingInterval; providerPlanId?: string;
  rateScaled?: number; amount?: number;
} = {}) {
  const fx = await insertFx(pool, options.rateScaled);
  const plan = options.plan ?? 'pro';
  const interval = options.interval ?? 'monthly';
  const usd = cataloguePriceMinor(plan, interval);
  const amount = options.amount ?? Number(computePaymentAmountMinor({
    usdMinor: BigInt(usd), rateScaled: BigInt(fx.fx_rate_scaled), rateScale: fx.fx_rate_scale,
  }));
  const { rows } = await pool.query(
    `INSERT INTO billing_provider_plans (catalogue_plan, billing_interval, payment_amount_minor,
       provider_plan_id, fx_rate_version_id, pricing_policy_version, catalogue_version,
       catalogue_amount_minor, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${EPOCH_COLUMNS}`,
    [plan, interval, amount, options.providerPlanId ?? `PLN_${randomUUID().replaceAll('-', '')}`,
      fx.id, BILLING_PRICING_POLICY_VERSION, BILLING_CATALOGUE_VERSION, usd, fx.effective_from],
  );
  return { epoch: rows[0]!, fx };
}

export async function retireEpoch(pool: Pool, id: string) {
  await pool.query("UPDATE billing_provider_plans SET status='retired', retired_at=now(), retired_reason='rotation' WHERE id=$1", [id]);
}

export async function retireActiveEpochs(pool: Pool) {
  await pool.query("UPDATE billing_provider_plans SET status='retired', retired_at=now(), retired_reason='next test' WHERE status='active'");
}

export async function insertUser(pool: Pool, customer = true) {
  const { rows } = await pool.query(
    "INSERT INTO users(email,password_hash,name) VALUES($1,'unused-test-hash','Checkout test') RETURNING id,email",
    [`${randomUUID()}@example.test`],
  );
  const user = rows[0] as { id: string; email: string };
  // Test fixture only; production checkout never inserts a billing customer.
  if (customer) await pool.query(
    `INSERT INTO billing_customers(user_id,email,provider_customer_code)
     VALUES($1,$2,$3)`, [user.id, user.email, `CUS_${randomUUID().replaceAll('-', '')}`],
  );
  return user;
}

export function deriveSnapshot(facts: Awaited<ReturnType<typeof insertEpoch>>) {
  return priceFromProviderPlanEpoch({ ...facts, fxVersion: facts.fx, asOf: AS_OF, providerReference: null });
}

/* ==========================================================================
   Billing Step 8 fixtures — the full activation shape, written coherently.

   A test that needs an ACTIVATABLE subscription needs three coherent rows:
   the immutable pricing snapshot, the locked commercial subscription and the
   verified sandbox payment evidence. These helpers write exactly those, plus
   (on request) the immutable activation fact, using the same derivations the
   production services use — never a restatement of them.
   ========================================================================== */

/**
 * Reuse the ACTIVE epoch for a plan + interval when one exists (a test that
 * seeds two users must not fight the one-active-epoch rule), and create a new
 * one only when an explicit provider plan code is requested — in which case
 * the existing active epoch for that key is retired first, exactly as a
 * deliberate rotation would.
 */
async function findOrCreateEpoch(
  pool: Pool,
  plan: CommercialPlanId,
  interval: BillingInterval,
  providerPlanId?: string,
): Promise<Awaited<ReturnType<typeof insertEpoch>>> {
  if (providerPlanId !== undefined) {
    await retireActiveEpochs(pool);
    return insertEpoch(pool, { plan, interval, providerPlanId });
  }
  const existing = await pool.query(
    `SELECT ${EPOCH_COLUMNS} FROM billing_provider_plans
      WHERE catalogue_plan = $1 AND billing_interval = $2 AND status = 'active'
      ORDER BY valid_from DESC LIMIT 1`,
    [plan, interval],
  );
  // The capability-evidence plan is never a sellable epoch: if a previous test
  // left it active, retire it and provision a real one instead.
  if (existing.rows[0]?.provider_plan_id === EXCLUDED_EPOCH_PLAN) {
    await retireActiveEpochs(pool);
    existing.rows.length = 0;
  }
  if (existing.rows[0] !== undefined) {
    const fx = await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [
      existing.rows[0].fx_rate_version_id,
    ]);
    return { epoch: existing.rows[0], fx: fx.rows[0] };
  }
  return insertEpoch(pool, { plan, interval });
}

export interface SeedCommercialOptions {
  cataloguePlan?: CommercialPlanId;
  interval?: BillingInterval;
  /** Provider plan epoch code; defaults to a fresh synthetic code. */
  providerPlanId?: string;
  /** Provider state written on the subscription row (defaults to `pending`). */
  providerState?: string | null;
}

export interface SeededCommercial {
  subscriptionId: string;
  pricingSnapshotId: string;
  pricingSnapshotIdempotencyKey: string;
  reference: string;
  amountMinor: number;
  cataloguePlan: CommercialPlanId;
  interval: BillingInterval;
}

/**
 * Materialise the checkout shape for `userId`: an epoch, its immutable pricing
 * snapshot and the locked commercial subscription row that points at it. The
 * user must NOT already have a `subscriptions` row — the 0032 lock is immutable
 * at creation, so a legacy NULL-lock row can never be upgraded.
 */
export async function seedCommercialSubscription(
  pool: Pool,
  userId: string,
  options: SeedCommercialOptions = {},
): Promise<SeededCommercial> {
  const cataloguePlan = options.cataloguePlan ?? 'pro';
  const interval = options.interval ?? 'monthly';
  const facts = await findOrCreateEpoch(pool, cataloguePlan, interval, options.providerPlanId);
  const snapshot = deriveSnapshot(facts);
  const persisted = await new BillingPricingSnapshotStore(pool).create(snapshot);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO subscriptions (user_id, plan, status, catalogue_plan, billing_interval,
       currency, provider, provider_plan_id, provider_state, locked_pricing_snapshot_id)
     VALUES ($1,$2,'active',$3,$4,'USD','paystack',$5,$6,$7)
     ON CONFLICT (user_id) DO NOTHING RETURNING id`,
    [userId, internalPlanForCommercialPlan(cataloguePlan), cataloguePlan, interval,
      facts.epoch.provider_plan_id, options.providerState ?? 'pending', persisted.id],
  );
  if (rows[0] === undefined) {
    throw new Error('seedCommercialSubscription: the user already has a subscription row');
  }
  return {
    subscriptionId: rows[0].id,
    pricingSnapshotId: persisted.id,
    pricingSnapshotIdempotencyKey: persisted.idempotencyKey,
    reference: billingCheckoutReference(userId, persisted.idempotencyKey),
    amountMinor: persisted.snapshot.payment.paymentAmountMinor,
    cataloguePlan,
    interval,
  };
}

export interface SeedEvidenceOptions {
  /** Defaults to the deterministic checkout reference (the coherent case). */
  providerReference?: string;
  /** Defaults to the locked snapshot amount. */
  paymentAmountMinor?: number;
  /** Defaults to `GHS`. */
  paymentCurrency?: 'GHS';
  /** Defaults to `2`. */
  paymentAmountExponent?: number;
  /** Defaults to `success`. */
  providerStatus?: string;
  /** Defaults to `test`. */
  providerDomain?: 'test';
  /** Defaults to null; pass a code to model a wrong-customer observation. */
  providerCustomerCode?: string | null;
  paidAt?: Date;
}

/** Insert one durable verified-transaction evidence row for a subscription. */
export async function seedPaymentEvidence(
  pool: Pool,
  userId: string,
  commercial: SeededCommercial,
  options: SeedEvidenceOptions = {},
): Promise<{ evidenceId: string; evidenceHash: string }> {
  const providerReference = options.providerReference ?? commercial.reference;
  const paymentAmountMinor = options.paymentAmountMinor ?? commercial.amountMinor;
  const paymentCurrency = options.paymentCurrency ?? 'GHS';
  const paymentAmountExponent = options.paymentAmountExponent ?? 2;
  const providerStatus = options.providerStatus ?? 'success';
  const providerDomain = options.providerDomain ?? 'test';
  const paidAt = (options.paidAt ?? AS_OF).toISOString();
  const verifiedAt = AS_OF.toISOString();
  // Default to the local billing customer's code so the coherent case
  // reconciles; an explicit code models a wrong-customer observation.
  const customerCode = options.providerCustomerCode !== undefined
    ? options.providerCustomerCode
    : (await pool.query<{ provider_customer_code: string | null }>(
        'SELECT provider_customer_code FROM billing_customers WHERE user_id = $1',
        [userId],
      )).rows[0]?.provider_customer_code ?? null;
  const evidenceHash = billingVerifiedTransactionEvidenceHash({
    provider: 'paystack',
    providerReference,
    providerTransactionId: null,
    providerStatus,
    providerDomain,
    paymentCurrency,
    paymentAmountMinor,
    paymentAmountExponent,
    providerCustomerId: null,
    providerCustomerCode: customerCode,
    paidAt,
    verifiedAt,
  });
  const idempotencyKey = billingVerifiedTransactionIdempotencyKey({
    provider: 'paystack', providerReference, pricingSnapshotId: commercial.pricingSnapshotId,
  });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO billing_verified_transactions (
       user_id, subscription_id, pricing_snapshot_id, provider, provider_reference,
       provider_transaction_id, payment_amount_minor, payment_currency,
       payment_amount_exponent, provider_status, provider_domain,
       provider_customer_id, provider_customer_code, paid_at, verified_at,
       evidence_hash, idempotency_key
     ) VALUES ($1,$2,$3,'paystack',$4,NULL,$5,$6,$7,$8,$9,NULL,$10,$11,$12,$13,$14)
     ON CONFLICT (provider_reference) DO NOTHING RETURNING id`,
    [userId, commercial.subscriptionId, commercial.pricingSnapshotId, providerReference,
      paymentAmountMinor, paymentCurrency, paymentAmountExponent, providerStatus,
      providerDomain, customerCode, paidAt, verifiedAt,
      evidenceHash, idempotencyKey],
  );
  const evidenceId = rows[0]?.id
    ?? (await pool.query<{ id: string }>(
        'SELECT id FROM billing_verified_transactions WHERE provider_reference = $1',
        [providerReference],
      )).rows[0]!.id;
  return { evidenceId, evidenceHash };
}

export interface SeedActivationOptions extends SeedEvidenceOptions {
  operatorId?: string;
  activationReason?: string;
  activatedAt?: Date;
}

/**
 * Write the immutable activation fact for an ALREADY-SEEDED commercial
 * subscription and its evidence. Coherent by construction: every identity
 * field is copied from the live rows, exactly as the production service does.
 */
export async function activateSeededSubscription(
  pool: Pool,
  userId: string,
  commercial: SeededCommercial,
  evidence: { evidenceId: string; evidenceHash: string },
  options: {
    operatorId?: string;
    activationReason?: string;
    activatedAt?: Date;
    paymentAmountMinor?: number;
  } = {},
): Promise<string> {
  const { rows } = await pool.query<{ provider_plan_id: string }>(
    'SELECT provider_plan_id FROM subscriptions WHERE id = $1',
    [commercial.subscriptionId],
  );
  const idempotencyKey = billingSubscriptionActivationIdempotencyKey({
    provider: 'paystack',
    providerReference: commercial.reference,
    pricingSnapshotId: commercial.pricingSnapshotId,
  });
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO billing_subscription_activations (
       user_id, subscription_id, pricing_snapshot_id, evidence_id,
       catalogue_plan, billing_interval, provider, provider_plan_id, provider_reference,
       payment_currency, payment_amount_minor, payment_amount_exponent, evidence_hash,
       operator_id, activation_reason, activated_at, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,$6,'paystack',$7,$8,'GHS',$9,2,$10,$11,$12,$13,$14)
     RETURNING id`,
    [userId, commercial.subscriptionId, commercial.pricingSnapshotId, evidence.evidenceId,
      commercial.cataloguePlan, commercial.interval, rows[0]!.provider_plan_id,
      commercial.reference,
      options.paymentAmountMinor ?? commercial.amountMinor,
      evidence.evidenceHash,
      options.operatorId ?? 'ops-test-operator',
      options.activationReason ?? 'sandbox activation for the Step 8 suite',
      (options.activatedAt ?? AS_OF).toISOString(),
      idempotencyKey],
  );
  return inserted.rows[0]!.id;
}

/**
 * The whole Step-8 shape for `userId`: a locked commercial subscription, its
 * verified sandbox payment evidence, and the immutable activation fact that
 * authorizes the paid entitlement.
 */
export async function seedActivatedSubscription(
  pool: Pool,
  userId: string,
  options: SeedCommercialOptions & SeedActivationOptions = {},
): Promise<SeededCommercial & { evidenceId: string; activationId: string }> {
  const commercial = await seedCommercialSubscription(pool, userId, options);
  const evidence = await seedPaymentEvidence(pool, userId, commercial, options);
  const activationId = await activateSeededSubscription(pool, userId, commercial, evidence, options);
  return { ...commercial, evidenceId: evidence.evidenceId, activationId };
}
