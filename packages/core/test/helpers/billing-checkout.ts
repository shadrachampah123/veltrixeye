import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { startEmbeddedPostgres } from '../../../../scripts/db/embedded.mjs';
import {
  createPool, runMigrations, MIGRATIONS_DIR, BILLING_CATALOGUE_VERSION,
  BILLING_PRICING_POLICY_VERSION, cataloguePriceMinor, computePaymentAmountMinor,
  priceFromProviderPlanEpoch,
} from '../../src/index.js';
import type { BillingInterval, CommercialPlanId } from '@veltrixeye/contracts';

export const AS_OF = new Date('2026-09-22T12:00:00.000Z');
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
