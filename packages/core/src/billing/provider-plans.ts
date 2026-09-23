import { z } from 'zod';
import type { Pool } from 'pg';
import {
  BILLING_CURRENCY,
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  BILLING_PAYMENT_CURRENCIES,
  BILLING_PROVIDER,
  billingIntervalSchema,
  commercialPlanIdSchema,
  type BillingInterval,
  type BillingPaymentCurrency,
  type BillingPricingSnapshot,
  type CommercialPlanId,
} from '@veltrixeye/contracts';
import { Errors } from '../errors.js';
import { BILLING_PRICING_POLICY_VERSION } from './fx-rate-versions.js';

/**
 * Billing PR3 — provider-plan EPOCHS (the immutable GHS plan mapping).
 *
 * A provider charge must never be produced from a "current price" read at call
 * time. Instead the platform registers, for each sellable plan + interval, an
 * immutable epoch row (`billing_provider_plans`, migration 0032) that records:
 *
 *   * the provider and its sandbox mode;
 *   * the commercial plan (`pro` | `elite` — Starter is not sellable) and the
 *     interval (monthly | annual);
 *   * the payment currency (GHS) and the EXACT amount in minor units;
 *   * the provider's own plan identifier for that amount;
 *   * the FX rate version, the pricing-policy version and the catalogue version
 *     the amount was derived under;
 *   * a lifecycle: `active` (the one sellable epoch for its key) or `retired`
 *     (retained history).
 *
 * RULES THIS MODULE ENFORCES
 *  - ONE active epoch per (provider, mode, plan, interval, payment currency);
 *    a second one is a conflict, never "the latest row wins".
 *  - A retired epoch is refused for a NEW charge, and can never go back to
 *    active: retirement is one-way.
 *  - A mismatch on plan, interval, currency, amount, provider, mode, FX version
 *    or pricing policy FAILS CLOSED. There is no fallback mapping and no
 *    "closest amount".
 *  - A customer's LOCKED amount is never silently replaced: a new price is a
 *    NEW epoch row (plus a new provider-side plan), and subscriptions already
 *    locked to the old amount keep it (`./pricing.ts` verifies the lock).
 *
 * Nothing here calls a provider, and nothing here computes a price: the amount
 * is derived by `./pricing.ts` from the catalogue and an authoritative FX
 * version, and is frozen into the epoch.
 */

/* -------------------------------------------------------------------------- */
/* Row contract                                                               */
/* -------------------------------------------------------------------------- */

const timestamp = z.union([z.date(), z.string().datetime()]).transform((value) => new Date(value));
const scaledInteger = z.union([
  z.bigint(),
  z.string().regex(/^[0-9]+$/, 'a scaled integer must be an unsigned integer string'),
  z.number().int().safe(),
]);

export const billingProviderPlanRowSchema = z
  .object({
    id: z.string().uuid(),
    provider: z.string(),
    mode: z.string(),
    catalogue_plan: z.string(),
    billing_interval: z.string(),
    payment_currency: z.string(),
    payment_amount_minor: scaledInteger.transform((value) => BigInt(value)),
    payment_amount_exponent: z.number().int(),
    provider_plan_id: z.string(),
    provider_plan_reference: z.string().nullable().optional(),
    fx_rate_version_id: z.string().uuid(),
    pricing_policy_version: z.string(),
    catalogue_version: z.string(),
    status: z.string(),
    valid_from: timestamp,
    retired_at: timestamp.nullable().optional(),
    retired_reason: z.string().nullable().optional(),
  })
  .strict();

export type BillingProviderPlanRow = z.infer<typeof billingProviderPlanRowSchema>;

export const BILLING_PROVIDER_PLAN_STATUSES = ['active', 'retired'] as const;
export type BillingProviderPlanStatus = (typeof BILLING_PROVIDER_PLAN_STATUSES)[number];

/** Normalized, validated provider-plan epoch. */
export interface BillingProviderPlan {
  readonly id: string;
  readonly provider: string;
  readonly mode: string;
  readonly cataloguePlan: CommercialPlanId;
  readonly interval: BillingInterval;
  readonly paymentCurrency: BillingPaymentCurrency;
  readonly paymentAmountMinor: bigint;
  readonly paymentAmountExponent: number;
  readonly providerPlanId: string;
  readonly providerPlanReference: string | null;
  readonly fxRateVersionId: string;
  readonly pricingPolicyVersion: string;
  readonly catalogueVersion: string;
  readonly status: BillingProviderPlanStatus;
  readonly validFrom: Date;
  readonly retiredAt: Date | null;
}

/** The identity of one sellable epoch (everything except the amount). */
export interface BillingProviderPlanKey {
  readonly provider: string;
  readonly mode: string;
  readonly cataloguePlan: CommercialPlanId;
  readonly interval: BillingInterval;
  readonly paymentCurrency: BillingPaymentCurrency;
}

export type BillingProviderPlanFailureReason =
  | 'invalid'
  | 'not_found'
  | 'ambiguous'
  | 'retired'
  | 'mismatch'
  | 'conflict'
  | 'forbidden_plan';

export class BillingProviderPlanError extends Error {
  readonly code = 'billing_provider_plan_unusable' as const;

  constructor(
    readonly reason: BillingProviderPlanFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingProviderPlanError';
  }
}

export function isBillingProviderPlanError(error: unknown): error is BillingProviderPlanError {
  return error instanceof BillingProviderPlanError;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Normalize and validate one epoch row. Anything unknown (plan, interval,
 * currency, exponent, status, mode) is rejected here — an epoch the platform
 * does not fully understand can never be used to charge.
 */
export function parseProviderPlan(row: unknown): BillingProviderPlan {
  const parsed = billingProviderPlanRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new BillingProviderPlanError(
      'invalid',
      `The provider-plan epoch is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const value = parsed.data;

  if (value.provider !== BILLING_PROVIDER) {
    throw new BillingProviderPlanError('invalid', `Unknown billing provider "${value.provider}".`);
  }
  if (value.mode !== 'test') {
    throw new BillingProviderPlanError(
      'invalid',
      `Provider mode "${value.mode}" is not usable: billing is sandbox-only in this build.`,
    );
  }
  if (!commercialPlanIdSchema.safeParse(value.catalogue_plan).success) {
    throw new BillingProviderPlanError('invalid', `Unknown commercial plan "${value.catalogue_plan}".`);
  }
  if (value.catalogue_plan === 'starter') {
    throw new BillingProviderPlanError(
      'forbidden_plan',
      'Starter is not sellable: no provider-plan epoch can exist for it.',
    );
  }
  if (!billingIntervalSchema.safeParse(value.billing_interval).success) {
    throw new BillingProviderPlanError('invalid', `Unknown billing interval "${value.billing_interval}".`);
  }
  if (!(BILLING_PAYMENT_CURRENCIES as readonly string[]).includes(value.payment_currency)) {
    throw new BillingProviderPlanError(
      'invalid',
      `Unsupported payment currency "${value.payment_currency}".`,
    );
  }
  if (value.payment_amount_minor <= 0n) {
    throw new BillingProviderPlanError('invalid', 'A provider-plan amount must be strictly positive.');
  }
  if (
    value.payment_amount_exponent !==
    BILLING_PAYMENT_AMOUNT_EXPONENT[value.payment_currency as BillingPaymentCurrency]
  ) {
    throw new BillingProviderPlanError(
      'invalid',
      `Provider-plan amount exponent ${value.payment_amount_exponent} does not match ${value.payment_currency}.`,
    );
  }
  if (!(BILLING_PROVIDER_PLAN_STATUSES as readonly string[]).includes(value.status)) {
    throw new BillingProviderPlanError('invalid', `Unknown provider-plan status "${value.status}".`);
  }
  if (value.provider_plan_id.trim() === '') {
    throw new BillingProviderPlanError('invalid', 'A provider-plan epoch requires the provider plan identifier.');
  }

  return {
    id: value.id,
    provider: value.provider,
    mode: value.mode,
    cataloguePlan: value.catalogue_plan as CommercialPlanId,
    interval: value.billing_interval as BillingInterval,
    paymentCurrency: value.payment_currency as BillingPaymentCurrency,
    paymentAmountMinor: value.payment_amount_minor,
    paymentAmountExponent: value.payment_amount_exponent,
    providerPlanId: value.provider_plan_id,
    providerPlanReference: value.provider_plan_reference ?? null,
    fxRateVersionId: value.fx_rate_version_id,
    pricingPolicyVersion: value.pricing_policy_version,
    catalogueVersion: value.catalogue_version,
    status: value.status as BillingProviderPlanStatus,
    validFrom: value.valid_from,
    retiredAt: value.retired_at ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Selection (pure)                                                           */
/* -------------------------------------------------------------------------- */

export function providerPlanKeyMatches(
  plan: BillingProviderPlan,
  key: BillingProviderPlanKey,
): boolean {
  return (
    plan.provider === key.provider &&
    plan.mode === key.mode &&
    plan.cataloguePlan === key.cataloguePlan &&
    plan.interval === key.interval &&
    plan.paymentCurrency === key.paymentCurrency
  );
}

/**
 * Select the ONE active epoch for a key. Fails closed when:
 *  - no epoch matches                 → `not_found`
 *  - more than one active epoch matches → `ambiguous`
 *  - only retired epochs match         → `retired`
 *
 * Retired epochs are NEVER a fallback for a new charge.
 */
export function selectActiveProviderPlan(
  plans: readonly unknown[],
  key: BillingProviderPlanKey,
): BillingProviderPlan {
  const parsed = plans.map((row) => parseProviderPlan(row));
  const matching = parsed.filter((plan) => providerPlanKeyMatches(plan, key));

  if (matching.length === 0) {
    throw new BillingProviderPlanError(
      'not_found',
      `No provider-plan epoch exists for ${key.cataloguePlan}/${key.interval} (${key.paymentCurrency}). ` +
        'Nothing is charged: a plan must be registered before it can be sold.',
    );
  }

  const active = matching.filter((plan) => plan.status === 'active');
  if (active.length === 0) {
    throw new BillingProviderPlanError(
      'retired',
      `Every provider-plan epoch for ${key.cataloguePlan}/${key.interval} is retired. ` +
        'A retired epoch is history and is never used for a new charge.',
    );
  }
  if (active.length > 1) {
    throw new BillingProviderPlanError(
      'ambiguous',
      `More than one active provider-plan epoch exists for ${key.cataloguePlan}/${key.interval} ` +
        `(${active.map((plan) => plan.id).join(', ')}). An ambiguous mapping is never used.`,
    );
  }

  return active[0]!;
}

export interface ProviderPlanExpectation {
  cataloguePlan: CommercialPlanId;
  interval: BillingInterval;
  paymentAmountMinor: bigint;
  paymentCurrency: BillingPaymentCurrency;
  providerPlanId: string;
  fxRateVersionId: string;
  pricingPolicyVersion: string;
  mode?: string;
  provider?: string;
}

/**
 * Require an epoch to match an authorized pricing snapshot EXACTLY: same plan,
 * interval, currency, amount and provider plan identifier, and the same FX
 * version + pricing policy the amount was derived under. This is the check that
 * makes "never silently replace a customer's locked GHS amount" real — a
 * mismatch is a hard failure, never a re-rate and never a fallback epoch.
 */
export function assertProviderPlanMatches(
  plan: BillingProviderPlan,
  expectation: ProviderPlanExpectation,
): void {
  const expectedProvider = expectation.provider ?? BILLING_PROVIDER;
  const expectedMode = expectation.mode ?? 'test';

  const problems: string[] = [];
  if (plan.provider !== expectedProvider) problems.push(`provider ${plan.provider} ≠ ${expectedProvider}`);
  if (plan.mode !== expectedMode) problems.push(`mode ${plan.mode} ≠ ${expectedMode}`);
  if (plan.cataloguePlan !== expectation.cataloguePlan) {
    problems.push(`plan ${plan.cataloguePlan} ≠ ${expectation.cataloguePlan}`);
  }
  if (plan.interval !== expectation.interval) {
    problems.push(`interval ${plan.interval} ≠ ${expectation.interval}`);
  }
  if (plan.paymentCurrency !== expectation.paymentCurrency) {
    problems.push(`currency ${plan.paymentCurrency} ≠ ${expectation.paymentCurrency}`);
  }
  if (plan.paymentAmountMinor !== expectation.paymentAmountMinor) {
    problems.push(
      `amount ${plan.paymentAmountMinor.toString()} ≠ ${expectation.paymentAmountMinor.toString()} minor units`,
    );
  }
  if (plan.paymentAmountExponent !== BILLING_PAYMENT_AMOUNT_EXPONENT[expectation.paymentCurrency]) {
    problems.push(`exponent ${plan.paymentAmountExponent} ≠ ${BILLING_PAYMENT_AMOUNT_EXPONENT[expectation.paymentCurrency]}`);
  }
  if (plan.providerPlanId !== expectation.providerPlanId) {
    problems.push(`provider plan identifier "${plan.providerPlanId}" ≠ "${expectation.providerPlanId}"`);
  }
  if (plan.fxRateVersionId !== expectation.fxRateVersionId) {
    problems.push(`FX version ${plan.fxRateVersionId} ≠ ${expectation.fxRateVersionId}`);
  }
  if (plan.pricingPolicyVersion !== expectation.pricingPolicyVersion) {
    problems.push(`pricing policy ${plan.pricingPolicyVersion} ≠ ${expectation.pricingPolicyVersion}`);
  }
  if (plan.status !== 'active') {
    problems.push(`status ${plan.status} is not usable for a new charge`);
  }

  if (problems.length > 0) {
    throw new BillingProviderPlanError(
      'mismatch',
      `The provider-plan epoch does not match the authorized payment (${problems.join('; ')}). ` +
        'Fail closed: no re-rate, no fallback mapping and no charge.',
    );
  }
}

/** Expectation derived from a locked/authorized pricing snapshot. */
export function providerPlanExpectationFromSnapshot(
  snapshot: BillingPricingSnapshot,
  providerPlanId: string,
): ProviderPlanExpectation {
  return {
    cataloguePlan: snapshot.cataloguePlan,
    interval: snapshot.interval,
    paymentAmountMinor: BigInt(snapshot.payment.paymentAmountMinor),
    paymentCurrency: snapshot.payment.paymentCurrency,
    providerPlanId,
    fxRateVersionId: snapshot.fx.fxRateVersionId,
    pricingPolicyVersion: snapshot.pricingPolicyVersion,
  };
}

/**
 * Retirement is ONE-WAY and timestamped: a retired epoch can never be made
 * active again (and a history row can never be rewritten — the database
 * enforces both).
 */
export function assertProviderPlanRetirable(plan: BillingProviderPlan): void {
  if (plan.status === 'retired') {
    throw new BillingProviderPlanError(
      'retired',
      `Provider-plan epoch ${plan.id} is already retired; retirement is one-way and retired epochs are history.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Durable epochs (Postgres)                                                  */
/* -------------------------------------------------------------------------- */

export interface RegisterProviderPlanInput {
  cataloguePlan: CommercialPlanId;
  interval: BillingInterval;
  paymentCurrency: BillingPaymentCurrency;
  paymentAmountMinor: bigint;
  /**
   * The catalogue USD amount (minor units) the payment amount was derived
   * from. REQUIRED — migration 0032 stores it (`catalogue_amount_minor`,
   * NOT NULL) so an epoch always records both sides of its own derivation
   * and can be audited against the catalogue version it pins.
   */
  catalogueAmountMinor: bigint;
  providerPlanId: string;
  providerPlanReference?: string | null;
  fxRateVersionId: string;
  pricingPolicyVersion?: string;
  catalogueVersion: string;
  validFrom?: Date;
  mode?: string;
  provider?: string;
}

/**
 * READ/WRITE PROJECTION RULE (Step 4 repair): every statement that returns an
 * epoch row to the parser projects EXACTLY the domain columns — never the
 * full row. The durable table additionally carries `catalogue_amount_minor`
 * and the `created_at` / `updated_at` audit columns, and the strict row
 * parser refuses any shape it does not fully understand, so a full-row
 * RETURNING would turn a valid epoch into a hard failure. Durable audit columns stay queryable
 * through direct SQL; the statement projections below (the lookup SELECT and
 * both RETURNING clauses) must stay textually identical — the Step 4 suite
 * asserts that.
 */
export class BillingProviderPlanStore {
  constructor(
    private readonly db: Pick<Pool, 'query'>,
    private readonly policyVersion: string = BILLING_PRICING_POLICY_VERSION,
  ) {}

  /** The active epoch for a key, or a typed failure. Never a fallback. */
  async findActive(key: BillingProviderPlanKey): Promise<BillingProviderPlan> {
    const { rows } = await this.db.query(
      `SELECT id, provider, mode, catalogue_plan, billing_interval, payment_currency,
              payment_amount_minor, payment_amount_exponent, provider_plan_id,
              provider_plan_reference, fx_rate_version_id, pricing_policy_version,
              catalogue_version, status, valid_from, retired_at, retired_reason
         FROM billing_provider_plans
        WHERE provider = $1 AND mode = $2 AND catalogue_plan = $3
          AND billing_interval = $4 AND payment_currency = $5
        ORDER BY valid_from DESC`,
      [key.provider, key.mode, key.cataloguePlan, key.interval, key.paymentCurrency],
    );
    if (rows.length === 0) {
      throw new BillingProviderPlanError(
        'not_found',
        `No provider-plan epoch exists for ${key.cataloguePlan}/${key.interval} (${key.paymentCurrency}).`,
      );
    }
    return selectActiveProviderPlan(rows, key);
  }

  /**
   * Register a NEW epoch. The amount must already have been produced by
   * `./pricing.ts`; a second active epoch for the same key is refused by the
   * database's partial unique index (surfaced as a conflict, never repaired
   * automatically, never upserted and never retired implicitly).
   *
   * The INSERT records BOTH sides of the derivation: the catalogue USD amount
   * (`catalogue_amount_minor`, required — migration 0032 declares it NOT NULL)
   * and the exact payment-currency amount, alongside the FX version, pricing
   * policy and catalogue version they were derived under.
   */
  async register(input: RegisterProviderPlanInput): Promise<BillingProviderPlan> {
    if (input.cataloguePlan === 'starter') {
      throw new BillingProviderPlanError('forbidden_plan', 'Starter is not sellable and cannot be registered.');
    }
    const exponent = BILLING_PAYMENT_AMOUNT_EXPONENT[input.paymentCurrency];
    if (exponent === undefined) {
      throw new BillingProviderPlanError(
        'invalid',
        `Unsupported payment currency "${input.paymentCurrency}" for a provider-plan epoch.`,
      );
    }
    if (input.paymentAmountMinor <= 0n) {
      throw new BillingProviderPlanError('invalid', 'A provider-plan amount must be strictly positive.');
    }
    if (input.catalogueAmountMinor <= 0n) {
      throw new BillingProviderPlanError(
        'invalid',
        'A provider-plan epoch must record the strictly positive catalogue amount it was derived from.',
      );
    }

    try {
      // The RETURNING projection matches the strict epoch parser exactly:
      // a full-row RETURNING would additionally yield catalogue_amount_minor
      // and the created_at/updated_at audit columns, which the parser refuses by design.
      const { rows } = await this.db.query(
        `INSERT INTO billing_provider_plans
           (provider, mode, catalogue_plan, billing_interval, payment_currency,
            payment_amount_minor, payment_amount_exponent, provider_plan_id,
            provider_plan_reference, fx_rate_version_id, pricing_policy_version,
            catalogue_version, catalogue_amount_minor, status, valid_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active', COALESCE($14, now()))
         RETURNING id, provider, mode, catalogue_plan, billing_interval, payment_currency,
                   payment_amount_minor, payment_amount_exponent, provider_plan_id,
                   provider_plan_reference, fx_rate_version_id, pricing_policy_version,
                   catalogue_version, status, valid_from, retired_at, retired_reason`,
        [
          input.provider ?? BILLING_PROVIDER,
          input.mode ?? 'test',
          input.cataloguePlan,
          input.interval,
          input.paymentCurrency,
          input.paymentAmountMinor.toString(),
          exponent,
          input.providerPlanId,
          input.providerPlanReference ?? null,
          input.fxRateVersionId,
          input.pricingPolicyVersion ?? this.policyVersion,
          input.catalogueVersion,
          input.catalogueAmountMinor.toString(),
          input.validFrom ?? null,
        ],
      );
      return parseProviderPlan(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BillingProviderPlanError(
          'conflict',
          'Another active provider-plan epoch already exists for this plan/interval, or this provider plan ' +
            'identifier is already registered. Retire the existing epoch explicitly; nothing was changed.',
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Retire an epoch: the ONLY lifecycle transition, one-way, timestamped, with
   * a reason. The amount, the provider plan identifier and every pricing column
   * are immutable (enforced by trigger in migration 0032), so a retirement can
   * never rewrite what a customer was charged.
   */
  async retire(planId: string, reason: string): Promise<BillingProviderPlan> {
    // Same explicit projection as register(): a full-row RETURNING would
    // surface the durable audit columns the strict epoch parser refuses.
    const { rows } = await this.db.query(
      `UPDATE billing_provider_plans
          SET status = 'retired', retired_at = now(), retired_reason = $2
        WHERE id = $1
        RETURNING id, provider, mode, catalogue_plan, billing_interval, payment_currency,
                  payment_amount_minor, payment_amount_exponent, provider_plan_id,
                  provider_plan_reference, fx_rate_version_id, pricing_policy_version,
                  catalogue_version, status, valid_from, retired_at, retired_reason`,
      [planId, reason],
    );
    if (rows.length === 0) {
      throw new BillingProviderPlanError('not_found', `No provider-plan epoch ${planId} exists.`);
    }
    return parseProviderPlan(rows[0]);
  }

  /** True when a usable (active) epoch exists — used by fail-closed composition. */
  async isUsable(key: BillingProviderPlanKey): Promise<boolean> {
    try {
      await this.findActive(key);
      return true;
    } catch (error) {
      if (isBillingProviderPlanError(error)) return false;
      throw Errors.providerUnavailable('The provider-plan mapping could not be read.', error);
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** The key for a plan/interval in the sandbox payment currency. */
export function providerPlanKey(
  cataloguePlan: CommercialPlanId,
  interval: BillingInterval,
  options?: { provider?: string; mode?: string; paymentCurrency?: BillingPaymentCurrency },
): BillingProviderPlanKey {
  return {
    provider: options?.provider ?? BILLING_PROVIDER,
    mode: options?.mode ?? 'test',
    cataloguePlan,
    interval,
    paymentCurrency: options?.paymentCurrency ?? 'GHS',
  };
}

/** Commercial currency the epoch's amount was derived from. */
export const PROVIDER_PLAN_COMMERCIAL_CURRENCY = BILLING_CURRENCY;
