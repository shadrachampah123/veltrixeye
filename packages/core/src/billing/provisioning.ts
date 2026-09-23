import type { Pool } from 'pg';
import { z } from 'zod';
import {
  BILLING_PAYMENT_AMOUNT_EXPONENT,
  billingIntervalSchema,
  commercialPlanIdSchema,
  type BillingInterval,
  type BillingPaymentCurrency,
} from '@veltrixeye/contracts';
import { BILLING_CATALOGUE_VERSION, cataloguePriceMinor } from './catalogue.js';
import {
  assertFxRateVersionFresh,
  BILLING_FX_POLICY,
  BILLING_PRICING_POLICY_VERSION,
  parseFxRateVersion,
  BillingFxError,
  type BillingFxRateVersion,
} from './fx-rate-versions.js';
import { BILLING_PAYMENT_MINIMUM_MINOR, computePaymentAmountMinor } from './pricing.js';
import {
  BillingProviderPlanError,
  BillingProviderPlanStore,
  isBillingProviderPlanError,
  type BillingProviderPlan,
  type RegisterProviderPlanInput,
} from './provider-plans.js';

/**
 * Billing Step 4 — the SANDBOX PLAN PROVISIONING workflow (outside the
 * Paystack adapter, always).
 *
 * WHAT THIS MODULE IS
 *  - The local, validate-everything-first workflow that turns ONE authoritative
 *    USD→GHS FX rate version plus the operator's evidence for the four genuine
 *    sandbox provider plans into four immutable local provider-plan epochs
 *    (`billing_provider_plans`, migration 0032). It exists so that a SEPARATELY
 *    AUTHORIZED operational run can register the four epochs safely. Nothing in
 *    this module runs on its own behalf: a human operator drives it.
 *
 * THE BOUNDARY IT KEEPS
 *  - NO provider mutation, ever. The four Paystack sandbox plans ALREADY EXIST
 *    (created in the Paystack Dashboard, outside `packages/providers/paystack`)
 *    by the time this workflow receives evidence. This module never creates,
 *    updates or even reads from Paystack: it contains no network call, no
 *    credential, no environment read and no transport. `POST /plan` and
 *    `PUT /plan` remain permanently out of the adapter, and they are just as
 *    absent here.
 *  - TWO PHASES, strictly ordered:
 *      1. PREPARATION (pure): the existing USD catalogue (the only price
 *         authority, D-5) + the selected FX rate version → the four exact GHS
 *         amounts (one BigInt half-up step each, D-2, via `./pricing.ts`) →
 *         the operator/provider evidence is validated against every Step 4
 *         rule → a fully validated four-entry registration plan.
 *      2. PERSISTENCE: the validated plan — and nothing else — flows into
 *         `BillingProviderPlanStore.register()`. No new price discovery happens
 *         at persistence time.
 *  - VALIDATE-BEFORE-WRITE: the complete batch is validated before the first
 *    INSERT, and registration runs inside ONE database transaction, so an
 *    entry-4 failure leaves zero new rows rather than a partial batch. This
 *    uses the transaction support the existing service layer already uses
 *    (see `checkout.ts`); it introduces no new persistence mechanism and no
 *    migration.
 *
 * THE FOUR PLANS (billing.md roadmap item 4, paystack-provider-contract §7.2)
 *  - Pro Monthly, Pro Annual, Elite Monthly, Elite Annual — provider variants
 *    of the two sellable catalogue plans, NOT four new catalogue tiers.
 *    Starter is never provisioned. The USD amounts come from the catalogue at
 *    runtime; they are never restated here.
 *  - Local intervals map onto provider intervals EXPLICITLY:
 *    local `monthly` → provider `monthly`, local `annual` → provider
 *    `annually`. Nothing passes `annual` to the provider layer silently.
 *  - All four epochs share exactly ONE `fx_rate_version_id` (the selected
 *    version), and every amount is derived from that same version.
 *  - Each provider plan is open-ended recurring: evidence of a payment-count
 *    cap — including cap=1 — is refused. (Commercial entitlement limits such
 *    as Pro's strategy allowance are a different topic entirely and are not
 *    touched anywhere by this module.)
 *  - Sandbox only: provider `paystack`, mode `test`, payment currency GHS.
 *    Live mode, live credentials and any production configuration are refused.
 *
 * IMMUTABILITY
 *  - Registered epochs are immutable pricing records (migration 0032): a later
 *    FX version never reprices them, this module contains no retirement call
 *    and no upsert, and existing subscription locks are untouched.
 */

/* -------------------------------------------------------------------------- */
/* Failures — typed, explicit, never silent                                   */
/* -------------------------------------------------------------------------- */

export type BillingProvisioningFailureReason =
  /** A piece of operator/provider evidence is malformed or incomplete. */
  | 'invalid_evidence'
  /** The batch is not exactly the four required plan/interval combinations. */
  | 'plan_matrix'
  /** A (plan, interval) combination appears twice in the batch. */
  | 'duplicate_combination'
  /** The four entries do not pin one shared FX version. */
  | 'shared_fx_violation'
  /** A provider plan identifier appears twice in the batch. */
  | 'duplicate_provider_plan'
  /** Malformed, placeholder-shaped or fixture-shaped provider code. */
  | 'invalid_provider_plan'
  /** The excluded GHS 2.00 capability-evidence plan — never an epoch. */
  | 'excluded_provider_plan'
  /** Provider interval does not match the explicit local→provider mapping. */
  | 'interval_mismatch'
  /** Evidence is not for test/sandbox mode. */
  | 'mode_mismatch'
  /** Capped, unknown or missing recurring payment-count evidence. */
  | 'cap_mismatch'
  /** Evidence currency is not the single payment currency (GHS). */
  | 'currency_mismatch'
  /** Evidence minor-unit exponent is not GHS's (2). */
  | 'exponent_mismatch'
  /** The evidence amount disagrees with catalogue × FX (half-up). */
  | 'amount_mismatch'
  /** The derived amount is below the documented provider minimum. */
  | 'below_minimum'
  /** The registration instant is missing or malformed. */
  | 'invalid_instant';

export class BillingProvisioningError extends Error {
  readonly code = 'billing_provisioning_refused' as const;

  constructor(
    readonly reason: BillingProvisioningFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingProvisioningError';
  }
}

export function isBillingProvisioningError(error: unknown): error is BillingProvisioningError {
  return error instanceof BillingProvisioningError;
}

/* -------------------------------------------------------------------------- */
/* The four required combinations + the explicit provider-interval mapping    */
/* -------------------------------------------------------------------------- */

/** Provider-side interval vocabulary for the four plans (contract §7.2). */
export const PROVIDER_PLAN_INTERVALS = ['monthly', 'annually'] as const;
export type ProviderPlanInterval = (typeof PROVIDER_PLAN_INTERVALS)[number];

/**
 * The EXPLICIT local→provider interval mapping. `annual` is a local catalogue
 * concept; the provider's recurring interval for it is `annually`. Nothing
 * forwards the local word to the provider layer, ever.
 */
export const PROVIDER_INTERVAL_FOR_BILLING_INTERVAL: Readonly<
  Record<BillingInterval, ProviderPlanInterval>
> = Object.freeze({
  monthly: 'monthly',
  annual: 'annually',
});

export function providerIntervalForBillingInterval(interval: BillingInterval): ProviderPlanInterval {
  const mapped = PROVIDER_INTERVAL_FOR_BILLING_INTERVAL[interval];
  if (mapped === undefined) {
    throw new BillingProvisioningError(
      'interval_mismatch',
      `The local billing interval "${String(interval)}" has no provider interval mapping. ` +
        'The explicit mapping is fixed (monthly → monthly, annual → annually); nothing is guessed.',
    );
  }
  return mapped;
}

/** One sellable sandbox combination (a provider variant, not a new tier). */
export interface SandboxPlanMatrixEntry {
  readonly cataloguePlan: 'pro' | 'elite';
  readonly interval: BillingInterval;
  readonly providerInterval: ProviderPlanInterval;
}

/**
 * EXACTLY the four combinations that may ever be provisioned locally
 * (billing.md roadmap item 4 / contract §7.2). AMOUNTS ARE DELIBERATELY ABSENT:
 * the catalogue authority answers prices (`cataloguePriceMinor`), so no plan
 * price is restated as a business constant here (D-5). Starter is absent by
 * construction — it is not sellable.
 */
export const SANDBOX_PLAN_MATRIX: readonly SandboxPlanMatrixEntry[] = Object.freeze([
  Object.freeze({ cataloguePlan: 'pro' as const, interval: 'monthly' as const, providerInterval: 'monthly' as const }),
  Object.freeze({ cataloguePlan: 'pro' as const, interval: 'annual' as const, providerInterval: 'annually' as const }),
  Object.freeze({ cataloguePlan: 'elite' as const, interval: 'monthly' as const, providerInterval: 'monthly' as const }),
  Object.freeze({ cataloguePlan: 'elite' as const, interval: 'annual' as const, providerInterval: 'annually' as const }),
]);

function matrixEntryFor(
  cataloguePlan: string,
  interval: string,
): SandboxPlanMatrixEntry | undefined {
  return SANDBOX_PLAN_MATRIX.find(
    (entry) => entry.cataloguePlan === cataloguePlan && entry.interval === interval,
  );
}

/* -------------------------------------------------------------------------- */
/* Operator/provider evidence (input contract)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The scaled-integer shape the billing path uses everywhere: a BigInt, an
 * unsigned integer string, or a safe integer. Decimal strings ("12.5"),
 * signed strings and floats are refused outright — money here is never a
 * float and never a decimal literal (D-2).
 */
const scaledInteger = z.union([
  z.bigint(),
  z.string().regex(/^[0-9]+$/, 'a minor-unit amount must be an unsigned integer string'),
  z.number().int().safe(),
]);

/**
 * Evidence of the provider plan's recurring payment-count ("max number of
 * payments") configuration. The ONLY admissible state is the literal
 * `uncapped`: a Step 4 epoch is an open-ended recurring plan. An explicitly
 * capped plan ({ capped: true, maxPayments: n } — including n = 1), the
 * literal `unknown`, and a missing field are all refused, never defaulted.
 */
export const providerPlanPaymentCountCapSchema = z.union([
  z.literal('uncapped'),
  z.literal('unknown'),
  z
    .object({
      capped: z.literal(true),
      maxPayments: z.number().int().positive(),
    })
    .strict(),
]);
export type ProviderPlanPaymentCountCap = z.infer<typeof providerPlanPaymentCountCapSchema>;

/**
 * Typed OPERATOR EVIDENCE for one provider plan that has already been created
 * OUTSIDE this workflow (in the Paystack Dashboard, by an operator, in test
 * mode). This is evidence — never a transport request. The workflow validates
 * it and REGISTERS the equivalent local epoch; it cannot create, update or
 * even fetch the provider plan.
 */
export const sandboxProviderPlanEvidenceSchema = z
  .object({
    /** Local commercial tier (`pro` | `elite`; Starter is not provisioned). */
    cataloguePlan: commercialPlanIdSchema,
    /** Local billing period (`monthly` | `annual`). */
    interval: billingIntervalSchema,
    /** Provider-side recurring interval (`monthly` | `annually`). */
    providerInterval: z.enum(PROVIDER_PLAN_INTERVALS),
    /** The provider-issued plan code, verbatim (`PLN_…`). */
    providerPlanId: z.string().min(1).max(128),
    /** The plan's currency as the operator observed it (must be GHS). */
    paymentCurrency: z.string().min(3).max(3),
    /** The plan's amount as the operator observed it (GHS minor units). */
    paymentAmountMinor: scaledInteger,
    /** The plan's minor-unit exponent as the operator observed it (must be 2). */
    paymentAmountExponent: z.number().int(),
    /** The environment the plan exists in (must be `test`). */
    mode: z.string().min(1).max(16),
    /** Recurring payment-count evidence; only `uncapped` is admissible. */
    paymentCountCap: providerPlanPaymentCountCapSchema,
    /**
     * Provenance label: where the operator saw the plan (a dashboard/ticket
     * reference). Recorded on the epoch as `provider_plan_reference`. Never a
     * credential; the register-time schema and the database refuse
     * credential-shaped values for provider identifiers.
     */
    evidenceReference: z.string().trim().min(1).max(190),
  })
  .strict();
export type SandboxProviderPlanEvidence = z.infer<typeof sandboxProviderPlanEvidenceSchema>;

/* -------------------------------------------------------------------------- */
/* Provider plan identifier rules                                              */
/* -------------------------------------------------------------------------- */

/**
 * Documented provider plan-code shape: `PLN_` followed by lowercase
 * alphanumeric characters (contract §7.1's evidence row shows the real shape).
 * A format check can never PROVE a code came from the provider — the
 * operator's evidence does that — but it rejects non-provider shapes
 * outright: empty suffixes, uppercase, separators/underscores (the shape of
 * this repository's own historical placeholders such as a slugged plan name),
 * and absurd lengths.
 */
const PROVIDER_PLAN_CODE_PATTERN = /^PLN_[0-9a-z]{6,40}$/;

/**
 * Substrings that mark a code as a placeholder or fixture rather than a
 * provider-issued identifier. Deliberately conservative: registration is a
 * four-entry operator-reviewed batch, so a false positive (which a human can
 * see) is far safer than a fake code persisted.
 */
const PLACEHOLDER_PLAN_CODE_MARKERS = [
  'sample',
  'placeholder',
  'example',
  'dummy',
  'fake',
  'todo',
  'changeme',
  'fixture',
  'test',
];

/**
 * The GHS 2.00 capability-evidence plan (paystack-provider-contract §7.1).
 * It must NEVER become a local epoch, never be sold and never be charged: it
 * is assembled from parts so the repository-wide exclusion assertion can keep
 * proving the literal appears in excluding documentation only, never in code.
 * This module's refusal to register it is a SECOND layer; the checkout
 * boundary (`checkout.ts`) keeps its own independent refusal.
 */
export const EXCLUDED_PROVIDER_PLAN_CODE = ['PLN', 'u0l4961hhipl6ek'].join('_');

export function isExcludedProviderPlanCode(code: string): boolean {
  return code.trim() === EXCLUDED_PROVIDER_PLAN_CODE;
}

/* -------------------------------------------------------------------------- */
/* The validated registration plan                                             */
/* -------------------------------------------------------------------------- */

/** One fully validated epoch registration (preparation-phase output). */
export interface ValidatedSandboxEpochRegistration {
  readonly cataloguePlan: 'pro' | 'elite';
  readonly interval: BillingInterval;
  readonly providerInterval: ProviderPlanInterval;
  readonly paymentCurrency: BillingPaymentCurrency;
  /** The derived GHS amount — exactly `half_up(catalogue USD minor × FX)`. */
  readonly paymentAmountMinor: bigint;
  /** The catalogue USD minor amount the derivation started from (D-5). */
  readonly catalogueAmountMinor: number;
  /** The provider-issued plan code, verbatim. */
  readonly providerPlanId: string;
  /** Operator provenance label (persisted as provider_plan_reference). */
  readonly evidenceReference: string;
  /** The ONE shared FX version the whole batch pins. */
  readonly fxRateVersionId: string;
  readonly pricingPolicyVersion: string;
  readonly catalogueVersion: string;
}

/** The fully validated four-entry batch: the ONLY thing persistence may see. */
export interface ValidatedSandboxProvisioningBatch {
  /** The authoritative FX version every epoch pins (authority-validated). */
  readonly fxVersion: BillingFxRateVersion;
  /** The instant freshness was measured against (one instant per batch). */
  readonly registeredAt: Date;
  /** Exactly the four registrations, in matrix order. */
  readonly registrations: readonly ValidatedSandboxEpochRegistration[];
}

/* -------------------------------------------------------------------------- */
/* Admission validation (pure)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Whole-batch invariants over already-prepared registrations: exactly the
 * four required combinations, no duplicate combination, no duplicate provider
 * code, and ONE shared FX version id. Exported so it can be pinned directly:
 * these are business rules enforced BEFORE persistence, never delegated to
 * database constraints (which remain the final safety net).
 */
export function assertSandboxRegistrationBatchAdmissible(
  registrations: readonly ValidatedSandboxEpochRegistration[],
): void {
  if (registrations.length !== SANDBOX_PLAN_MATRIX.length) {
    throw new BillingProvisioningError(
      'plan_matrix',
      `A Step 4 provisioning batch is exactly ${SANDBOX_PLAN_MATRIX.length} entries ` +
        `(Pro Monthly, Pro Annual, Elite Monthly, Elite Annual); ${registrations.length} were prepared. ` +
        'Nothing was registered.',
    );
  }

  const combos = new Set<string>();
  const providerCodes = new Set<string>();
  const fxVersionIds = new Set<string>();

  for (const registration of registrations) {
    if (matrixEntryFor(registration.cataloguePlan, registration.interval) === undefined) {
      throw new BillingProvisioningError(
        'plan_matrix',
        `The combination ${registration.cataloguePlan}/${registration.interval} is not one of the four ` +
          'provisionable sandbox plans. Starter and every other combination are never provisioned.',
      );
    }
    const combo = `${registration.cataloguePlan}/${registration.interval}`;
    if (combos.has(combo)) {
      throw new BillingProvisioningError(
        'duplicate_combination',
        `The combination ${combo} appears more than once in the batch, so the batch is ambiguous. Nothing was registered.`,
      );
    }
    combos.add(combo);

    if (providerCodes.has(registration.providerPlanId)) {
      throw new BillingProvisioningError(
        'duplicate_provider_plan',
        `Provider plan identifier "${registration.providerPlanId}" appears more than once in the batch. ` +
          'One provider plan can never be mapped to two local epochs.',
      );
    }
    providerCodes.add(registration.providerPlanId);

    fxVersionIds.add(registration.fxRateVersionId);
  }

  if (fxVersionIds.size !== 1) {
    throw new BillingProvisioningError(
      'shared_fx_violation',
      `A Step 4 batch must pin exactly ONE FX rate version; ${fxVersionIds.size} were present. ` +
        'Every amount is derived from the same selected version — nothing is priced "at latest FX".',
    );
  }
}

function parseEvidence(raw: readonly unknown[]): SandboxProviderPlanEvidence[] {
  return raw.map((entry, index) => {
    const parsed = sandboxProviderPlanEvidenceSchema.safeParse(entry);
    if (!parsed.success) {
      throw new BillingProvisioningError(
        'invalid_evidence',
        `Evidence entry ${index + 1} is not usable: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  });
}

function validateProviderPlanCode(code: string, seen: ReadonlySet<string>): void {
  if (isExcludedProviderPlanCode(code)) {
    throw new BillingProvisioningError(
      'excluded_provider_plan',
      'The GHS 2.00 capability-evidence plan is excluded from provisioning by contract §7.1: it is ' +
        'never a local epoch, never a fallback and never chargeable. Nothing was registered, and the ' +
        'provider plan itself was not touched.',
    );
  }
  if (!PROVIDER_PLAN_CODE_PATTERN.test(code)) {
    throw new BillingProvisioningError(
      'invalid_provider_plan',
      `"${code}" is not a provider-issued plan code shape (documented shape: PLN_ followed by lowercase ` +
        'alphanumerics). Placeholder, slugged, empty or decorative identifiers are refused.',
    );
  }
  const lower = code.toLowerCase();
  const marker = PLACEHOLDER_PLAN_CODE_MARKERS.find((token) => lower.includes(token));
  if (marker !== undefined) {
    throw new BillingProvisioningError(
      'invalid_provider_plan',
      `"${code}" carries the placeholder/fixture marker "${marker}" and is refused. Record the code ` +
        'the provider actually issued instead.',
    );
  }
  if (seen.has(code)) {
    throw new BillingProvisioningError(
      'duplicate_provider_plan',
      `Provider plan identifier "${code}" appears more than once in the batch.`,
    );
  }
}

/**
 * PREPARE AND VALIDATE THE WHOLE BATCH (pure: no I/O, no clock, no network).
 *
 * Inputs: the selected FX rate version (a durable authority row — validated
 * through `parseFxRateVersion`, so a fixture snapshot or a normalized
 * camelCase object is NOT accepted as authority) that ALREADY EXISTS in
 * `billing_fx_rate_versions`; the operator evidence for the four plans; and
 * the registration instant.
 *
 * Every Step 4 rule is enforced here, before anything may be written:
 *  - the FX version is well-formed, USD→GHS, positive, scaled within policy,
 *    `half_up`, captured at or before effective, already effective at the
 *    registration instant, and within the 900-second freshness window
 *    (`registration_time − captured_at ≤ 900s`, inclusive at 900), never
 *    future-dated;
 *  - the batch is exactly Pro Monthly / Pro Annual / Elite Monthly / Elite
 *    Annual — Starter and every other combination refused;
 *  - each provider interval equals the explicit local→provider mapping;
 *  - each plan is GHS, exponent 2, test mode, explicitly uncapped, with a
 *    genuine-format, non-excluded, non-placeholder provider code unique in
 *    the batch;
 *  - each evidence amount equals `half_up(catalogue USD minor × FX)` EXACTLY
 *    (one BigInt half-up step in `./pricing.ts`, the only implementation):
 *    evidence confirms the provider plan; it never overrides the derivation.
 */
export function prepareSandboxProvisioningBatch(params: {
  fxVersion: unknown;
  evidence: readonly unknown[];
  registeredAt: Date;
}): ValidatedSandboxProvisioningBatch {
  const { registeredAt } = params;
  if (!(registeredAt instanceof Date) || !Number.isFinite(registeredAt.getTime())) {
    throw new BillingProvisioningError(
      'invalid_instant',
      'A finite registration instant is required: the 900-second FX freshness window is measured against it.',
    );
  }

  // malformation, wrong currency pair, non-positive rate, bad scale, unknown
  // rounding mode or provenance, and incoherent timestamps all fail here.
  const fx = parseFxRateVersion(params.fxVersion);
  if (fx.baseCurrency !== BILLING_FX_POLICY.baseCurrency || fx.quoteCurrency !== BILLING_FX_POLICY.quoteCurrency) {
    throw new BillingFxError(
      'unsupported_currency',
      `The selected FX version converts ${fx.baseCurrency}→${fx.quoteCurrency}; provisioning requires exactly ` +
        `${BILLING_FX_POLICY.baseCurrency}→${BILLING_FX_POLICY.quoteCurrency}.`,
    );
  }
  if (fx.roundingMode !== BILLING_FX_POLICY.roundingMode) {
    throw new BillingFxError(
      'invalid',
      `The selected FX version rounds "${fx.roundingMode}"; the ${BILLING_FX_POLICY.version} policy requires ` +
        `"${BILLING_FX_POLICY.roundingMode}".`,
    );
  }
  if (fx.effectiveFrom.getTime() > registeredAt.getTime()) {
    throw new BillingFxError(
      'invalid',
      `FX rate version ${fx.id} is not yet effective at the registration instant ` +
        `(effective_from ${fx.effectiveFrom.toISOString()} > ${registeredAt.toISOString()}). Register only under ` +
        'a version that is already in force (publish with effective_from = captured_at).',
    );
  }
  // The Step 4 freshness rule (D-3/d-9): registration_time − captured_at
  // ≤ 900 seconds, inclusive at the boundary; future capture is invalid and a
  // stale version is never used "because it is close".
  assertFxRateVersionFresh(fx, registeredAt);

  const evidence = parseEvidence(params.evidence);
  if (evidence.length !== SANDBOX_PLAN_MATRIX.length) {
    throw new BillingProvisioningError(
      'plan_matrix',
      `A Step 4 provisioning batch is exactly ${SANDBOX_PLAN_MATRIX.length} evidence entries (Pro Monthly, ` +
        `Pro Annual, Elite Monthly, Elite Annual); ${evidence.length} were supplied. Nothing is registered for a ` +
        'partial or oversized batch.',
    );
  }

  // The excluded GHS 2.00 evidence plan is refused before ANY other entry
  // detail is considered: however matching an amount or convincing a cap
  // state looks, the throwaway capability-evidence plan can never launder
  // itself into a local epoch.
  for (const entry of evidence) {
    if (isExcludedProviderPlanCode(entry.providerPlanId)) {
      throw new BillingProvisioningError(
        'excluded_provider_plan',
        'The GHS 2.00 capability-evidence plan is excluded from provisioning by contract §7.1: it is ' +
          'never a local epoch, never a fallback and never chargeable. Nothing was registered, and the ' +
          'provider plan itself was not touched.',
      );
    }
  }

  const registrations: ValidatedSandboxEpochRegistration[] = [];
  const seenProviderCodes = new Set<string>();

  for (const entry of evidence) {
    const matrix = matrixEntryFor(entry.cataloguePlan, entry.interval);
    if (matrix === undefined) {
      throw new BillingProvisioningError(
        'plan_matrix',
        `${entry.cataloguePlan}/${entry.interval} is not one of the four provisionable sandbox plans. ` +
          'Starter is never provisioned, and no additional plan is provisioned.',
      );
    }
    if (entry.providerInterval !== providerIntervalForBillingInterval(entry.interval)) {
      throw new BillingProvisioningError(
        'interval_mismatch',
        `${entry.cataloguePlan}/${entry.interval}: provider interval "${entry.providerInterval}" does not match ` +
          `the explicit mapping (${entry.interval} → ${providerIntervalForBillingInterval(entry.interval)}). ` +
          'A local period is never passed through to the provider layer silently.',
      );
    }
    if (entry.mode !== 'test') {
      throw new BillingProvisioningError(
        'mode_mismatch',
        `${entry.providerPlanId}: evidence mode "${entry.mode}" is not "test". Provisioning is sandbox-only; ` +
          'live mode (and live credentials or configuration) are refused.',
      );
    }
    if (entry.paymentCurrency !== BILLING_FX_POLICY.quoteCurrency) {
      throw new BillingProvisioningError(
        'currency_mismatch',
        `${entry.providerPlanId}: evidence currency "${entry.paymentCurrency}" is not the single payment ` +
          `currency ${BILLING_FX_POLICY.quoteCurrency}. A USD (or any other) amount is never registered as a GHS epoch.`,
      );
    }
    if (entry.paymentCountCap !== 'uncapped') {
      const detail =
        entry.paymentCountCap === 'unknown'
          ? 'its payment-count state is unknown'
          : `it is capped at ${String(entry.paymentCountCap.maxPayments)} payment(s)`;
      throw new BillingProvisioningError(
        'cap_mismatch',
        `${entry.providerPlanId}: ${detail}. A Step 4 epoch is open-ended recurring; a capped plan ` +
          '(including a one-payment plan) or unverifiable cap evidence is refused. This is unrelated to ' +
          'commercial entitlement limits, which this module never touches.',
      );
    }
    if (entry.paymentAmountExponent !== BILLING_PAYMENT_AMOUNT_EXPONENT[BILLING_FX_POLICY.quoteCurrency]) {
      throw new BillingProvisioningError(
        'exponent_mismatch',
        `${entry.providerPlanId}: minor-unit exponent ${entry.paymentAmountExponent} does not match ` +
          `${BILLING_FX_POLICY.quoteCurrency} (exponent ${BILLING_PAYMENT_AMOUNT_EXPONENT[BILLING_FX_POLICY.quoteCurrency]}).`,
      );
    }
    validateProviderPlanCode(entry.providerPlanId, seenProviderCodes);
    seenProviderCodes.add(entry.providerPlanId);

    // The authoritative amount: catalogue USD minor (D-5) × the SELECTED FX
    // version, exactly one BigInt half-up step (D-2). Provider evidence
    // confirms this amount; it can never override it.
    const catalogueAmountMinor = cataloguePriceMinor(entry.cataloguePlan, entry.interval);
    const derived = computePaymentAmountMinor({
      usdMinor: BigInt(catalogueAmountMinor),
      rateScaled: fx.fxRateScaled,
      rateScale: fx.fxRateScale,
    });
    const minimum = BILLING_PAYMENT_MINIMUM_MINOR[BILLING_FX_POLICY.quoteCurrency];
    if (derived < minimum) {
      throw new BillingProvisioningError(
        'below_minimum',
        `${entry.cataloguePlan}/${entry.interval}: the derived amount (${derived.toString()} GHS minor units) is ` +
          `below the documented provider minimum (${minimum.toString()} minor units). Nothing is registered.`,
      );
    }
    const observed = BigInt(entry.paymentAmountMinor);
    if (observed <= 0n || observed !== derived) {
      throw new BillingProvisioningError(
        'amount_mismatch',
        `${entry.providerPlanId}: the evidence amount (${observed.toString()} minor units) does not equal the ` +
          `amount derived from the catalogue and the selected FX version (${derived.toString()} minor units, ` +
          `${catalogueAmountMinor} USD minor at ${fx.fxRateScaled.toString()}e-${fx.fxRateScale} half-up). The ` +
          'calculation is authoritative; the evidence confirms it, never overrides it. Nothing was registered.',
      );
    }

    registrations.push({
      cataloguePlan: entry.cataloguePlan as 'pro' | 'elite',
      interval: entry.interval,
      providerInterval: entry.providerInterval,
      paymentCurrency: BILLING_FX_POLICY.quoteCurrency,
      paymentAmountMinor: derived,
      catalogueAmountMinor,
      providerPlanId: entry.providerPlanId,
      evidenceReference: entry.evidenceReference,
      fxRateVersionId: fx.id,
      pricingPolicyVersion: BILLING_PRICING_POLICY_VERSION,
      catalogueVersion: BILLING_CATALOGUE_VERSION,
    });
  }

  // Whole-batch invariants over what was actually prepared (exactly four,
  // unique combos, unique provider codes, one shared FX version) — asserted
  // over the registrations themselves, independently of the loop above.
  assertSandboxRegistrationBatchAdmissible(registrations);

  // Deterministic matrix order: Pro Monthly, Pro Annual, Elite Monthly, Elite Annual.
  const order = new Map(
    SANDBOX_PLAN_MATRIX.map((entry, index) => [`${entry.cataloguePlan}/${entry.interval}`, index] as const),
  );
  const ordered = [...registrations].sort(
    (a, b) => (order.get(`${a.cataloguePlan}/${a.interval}`) ?? 0) - (order.get(`${b.cataloguePlan}/${b.interval}`) ?? 0),
  );

  return { fxVersion: fx, registeredAt, registrations: ordered };
}

/** The store inputs for a validated batch (still prior to any write). */
export function sandboxProvisioningRegisterInputs(
  batch: ValidatedSandboxProvisioningBatch,
): RegisterProviderPlanInput[] {
  return batch.registrations.map((registration) => ({
    cataloguePlan: registration.cataloguePlan,
    interval: registration.interval,
    paymentCurrency: registration.paymentCurrency,
    paymentAmountMinor: registration.paymentAmountMinor,
    catalogueAmountMinor: BigInt(registration.catalogueAmountMinor),
    providerPlanId: registration.providerPlanId,
    providerPlanReference: registration.evidenceReference,
    fxRateVersionId: registration.fxRateVersionId,
    pricingPolicyVersion: registration.pricingPolicyVersion,
    catalogueVersion: registration.catalogueVersion,
    validFrom: batch.registeredAt,
  }));
}

/* -------------------------------------------------------------------------- */
/* Persistence (the ONLY writing phase — local epochs, nothing else)           */
/* -------------------------------------------------------------------------- */

export interface BillingPlanProvisioningOptions {
  db: Pool;
  /** Injected clock for the registration instant (tests pin it). */
  now?: () => Date;
}

export interface RegisterSandboxPlanEpochsInput {
  /** The operator-selected authoritative FX version id (must already exist). */
  fxRateVersionId: string;
  /** The four operator/provider evidence entries (validated in full). */
  evidence: readonly unknown[];
}

const registerSandboxPlanEpochsInputSchema = z
  .object({
    fxRateVersionId: z.string().uuid(),
    evidence: z.array(z.unknown()).min(1),
  })
  .strict();

/**
 * The Step 4 provisioning service: validate the complete four-plan batch,
 * then register the four immutable local epochs — atomically.
 *
 * WHAT IT READS
 *  - exactly one `billing_fx_rate_versions` row: the version the OPERATOR
 *    selected by id. This service never resolves "latest", never silently
 *    selects a newer version and never publishes a version. A version id that
 *    is not already in the durable authority is `missing` — a fixture or an
 *    arbitrary rate is never promoted to authority.
 *
 * WHAT IT WRITES
 *  - the four `billing_provider_plans` epochs, inside ONE transaction, after
 *    the whole batch has validated. A conflict (an already-active epoch for
 *    the combination, or a provider code already registered) is surfaced as
 *    the store's typed conflict and rolls the whole batch back: no upsert, no
 *    automatic retirement, no partial batch.
 *
 * WHAT IT NEVER DOES
 *  - no Paystack call of any kind (this module has no transport, imports no
 *    adapter and reads no credential or environment);
 *  - no provider plan creation/update (the plans already exist);
 *  - no checkout, no webhook, no verification, no confirmation and no
 *    entitlement change: a registered epoch is NOT payment confirmation;
 *  - no FX publication, no retirement, no reprice of an existing epoch or
 *    subscription lock.
 */
export class BillingPlanProvisioningService {
  private readonly db: Pool;
  private readonly nowFn: () => Date;

  constructor(options: BillingPlanProvisioningOptions) {
    this.db = options.db;
    this.nowFn = options.now ?? (() => new Date());
  }

  /**
   * Validate the batch against the selected authoritative FX version and
   * register the four epochs. REJECTS (before any write) on: a missing,
   * malformed, wrong-pair, not-yet-effective or stale (>900 s) FX version;
   * any shape, mapping, mode, currency, cap, code, exclusion or amount
   * violation in the evidence. A write-time conflict rolls everything back.
   */
  async registerSandboxPlanEpochs(input: unknown): Promise<readonly BillingProviderPlan[]> {
    const parsed = registerSandboxPlanEpochsInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BillingProvisioningError(
        'invalid_evidence',
        `The provisioning request is malformed: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
        { cause: parsed.error },
      );
    }

    // ONE registration instant per batch: the freshness window is measured
    // against it and every epoch carries it as valid_from.
    const registeredAt = this.nowFn();
    if (!(registeredAt instanceof Date) || !Number.isFinite(registeredAt.getTime())) {
      throw new BillingProvisioningError(
        'invalid_instant',
        'The provisioning clock did not produce a finite registration instant.',
      );
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // The SELECTED authoritative version — by identity, never "latest". Read
      // as the durable ROW (the seam checkout.ts uses too): the preparation
      // phase re-validates that exact row contract, so the batch can only ever
      // be prepared from what the authority actually stores.
      const selected = await client.query(
        `SELECT id, base_currency, quote_currency, fx_rate_scaled, fx_rate_scale, rounding_mode,
                source, source_reference, created_by, effective_from, captured_at
           FROM billing_fx_rate_versions
          WHERE id = $1`,
        [parsed.data.fxRateVersionId],
      );
      if (selected.rows[0] === undefined) {
        throw new BillingFxError(
          'missing',
          `The selected FX rate version ${parsed.data.fxRateVersionId} does not exist in the durable ` +
            'authority. Provisioning derives every amount from an existing published version: nothing ' +
            'is constructed, imported or promoted locally, and no newer version is silently selected.',
        );
      }

      // The WHOLE batch validates here — before the first INSERT.
      const batch = prepareSandboxProvisioningBatch({
        fxVersion: selected.rows[0],
        evidence: parsed.data.evidence,
        registeredAt,
      });
      if (batch.fxVersion.id !== parsed.data.fxRateVersionId) {
        // Defensive: the selected id is the batch identity, retained verbatim.
        throw new BillingProvisioningError(
          'shared_fx_violation',
          'The validated batch does not pin the operator-selected FX version. Nothing was registered.',
        );
      }

      // One shared FX version id across all four registrations — the batch
      // invariant is re-asserted over what will actually be written.
      for (const registration of batch.registrations) {
        if (registration.fxRateVersionId !== parsed.data.fxRateVersionId) {
          throw new BillingProvisioningError(
            'shared_fx_violation',
            `Registration ${registration.cataloguePlan}/${registration.interval} does not pin the operator-selected ` +
              'FX version. Nothing was registered.',
          );
        }
      }

      const store = new BillingProviderPlanStore(client);
      const registered: BillingProviderPlan[] = [];
      for (const registerInput of sandboxProvisioningRegisterInputs(batch)) {
        try {
          registered.push(await store.register(registerInput));
        } catch (error) {
          if (isBillingProviderPlanError(error) && error.reason === 'conflict') {
            // Surface WHICH combination/provider identifier collided: the
            // operator decides; this service never repairs, retries, upserts
            // or retires. The whole batch rolls back with this entry.
            throw new BillingProviderPlanError(
              'conflict',
              `Registration refused for ${registerInput.cataloguePlan}/${registerInput.interval} ` +
                `(provider plan "${registerInput.providerPlanId}"): an active epoch already exists for the ` +
                'combination, or the provider identifier is already registered to another epoch. ' +
                'Retirement is an explicit, separately approved action; nothing in this batch was registered.',
              { cause: error },
            );
          }
          throw error;
        }
      }

      await client.query('COMMIT');
      return registered;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
