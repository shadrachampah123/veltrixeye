import type { Pool } from 'pg';
import { z } from 'zod';
import {
  BILLING_CREDENTIAL_SHAPED_RE,
  type BillingInterval,
  type BillingPaymentCurrency,
  type BillingProviderMode,
} from '@veltrixeye/contracts';
import { BILLING_CATALOGUE_VERSION, cataloguePriceMinor } from './catalogue.js';
import { BillingFxError, BILLING_PRICING_POLICY_VERSION, parseFxRateVersion } from './fx-rate-versions.js';
import { computePaymentAmountMinor } from './pricing.js';
import {
  BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
  BillingPlanProvisioningService,
  BillingProvisioningError,
  providerIntervalForBillingInterval,
  prepareSandboxProvisioningBatch,
  SANDBOX_PLAN_MATRIX,
  type ProviderPlanInterval,
  type SandboxProviderPlanEvidence,
  type ValidatedSandboxProvisioningBatch,
} from './provisioning.js';
import type { BillingProviderPlan } from './provider-plans.js';

/**
 * LIVE plan registration — the operator path that turns the four SUPPLIED live
 * Paystack plan codes into the four live provider-plan epochs
 * (`billing_provider_plans`, `mode = 'live'`).
 *
 * WHY THIS MODULE EXISTS
 *  - Enabling live mode (migration 0035 + `PAYSTACK_MODE=live`, PR #66) makes
 *    the schema and the services *capable* of recording live-domain facts. It
 *    deliberately does NOT register the four live provider-plan epochs: those
 *    provider plans are created by an operator in the Paystack dashboard
 *    (outside this repository, exactly as in the sandbox Step 4 run), and the
 *    four `PLN_…` codes the dashboard issues must be supplied to this build.
 *    This module is the only path that consumes them.
 *
 * WHAT THE OPERATOR SUPPLIES (never a credential, never committed here)
 *  - the FOUR live plan codes — one per combination: `pro-monthly`,
 *    `pro-annual`, `elite-monthly`, `elite-annual`. They are opaque provider
 *    identifiers; they are supplied at run time (environment/CLI) and are
 *    NEVER stored in this repository, in a test fixture or in a migration.
 *  - the operator identity, a stated reason and a provenance label.
 *  - the id of the ONE already-published FX version the four amounts derive
 *    from (registration never publishes a rate).
 *  - optionally, the GHS amounts the operator observed in the dashboard — they
 *    are EVIDENCE and must equal the derived amount exactly.
 *
 * WHAT IT GUARANTEES
 *  - FAIL-CLOSED ON MODE: the service registers live epochs ONLY when it was
 *    explicitly constructed with `mode: 'live'`. Any other (or absent) mode is
 *    refused (`not_live_mode`) before a single row is read or written, so a
 *    deployment that is not configured for live can never create a live
 *    epoch — and a live deployment can never "fall back" to the test domain.
 *  - THE SAME FOUR-PLAN BATCH RULES AS THE SANDBOX PATH, unchanged: exactly
 *    Pro Monthly / Pro Annual / Elite Monthly / Elite Annual, one shared FX
 *    version, the derivation (catalogue USD minor × FX, one half-up step,
 *    BigInt only) as the authority, GHS, exponent 2, uncapped, explicit
 *    local→provider interval mapping, genuine non-placeholder `PLN_…` codes,
 *    no duplicates, and Starter refused. The excluded GHS 2.00
 *    capability-evidence plan is refused too.
 *  - ATOMIC + AUDITABLE: the four epochs and ONE
 *    `billing.provider_plans_registered` audit event commit on the same
 *    database transaction (the provisioning service writes the audit event on
 *    its own client). Live mode REQUIRES the operator descriptor, so an
 *    unaudited live epoch is unrepresentable: a conflict, a refusal or a
 *    failing audit write leaves zero rows.
 *  - A DRY RUN THAT IS REALLY READ-ONLY: `dryRun` validates the complete batch
 *    (mode gate, codes, operator, FX freshness, derivation, exclusions) and
 *    writes nothing at all — no epoch, no audit event.
 *  - NO PROVIDER CALL OF ANY KIND: this module contains no transport, no
 *    fetch, no adapter import, no credential and no environment read. It never
 *    creates, updates or reads a Paystack plan; the plans already exist. The
 *    only I/O it performs is SQL against the repository's own tables.
 *
 * WHAT IT NEVER DOES
 *  - no payment confirmation, no activation, no entitlement and no execution:
 *    registering a live epoch makes it *selectable* by live checkout — it is
 *    not a payment, not a sale and not a capability grant. `canAccessAutomation`
 *    and `grantsExecution` stay `false` for every plan.
 *  - no FX publication, no epoch retirement, no upsert and no automatic
 *    rotation: a later FX version never reprices an existing epoch.
 */

/* -------------------------------------------------------------------------- */
/* Failures — typed, explicit, never silent                                   */
/* -------------------------------------------------------------------------- */

export type BillingLivePlanRegistrationFailureReason =
  /**
   * The service was not explicitly configured for the live provider domain.
   * Nothing was read and nothing was written.
   */
  | 'not_live_mode'
  /** The supplied configuration (env/CLI value) is unusable. */
  | 'invalid_config'
  /** The registration request itself is malformed. */
  | 'invalid_input'
  /**
   * A Starter code was supplied. Starter is NOT sellable in this build — it
   * has no internal plan value, no entitlement definition and no provider plan
   * — so no registration path accepts it, live or sandbox.
   */
  | 'starter_not_provisionable'
  /** The supplied codes are not exactly the four provisionable combinations. */
  | 'plan_matrix'
  /** One provider plan code was supplied for more than one combination. */
  | 'duplicate_provider_plan'
  /** Missing, malformed or credential-shaped operator identity/reason/label. */
  | 'invalid_operator'
  /** A supplied observation (for example an amount) is malformed. */
  | 'invalid_evidence'
  /** The registration instant is missing or not finite. */
  | 'invalid_instant';

export class BillingLivePlanRegistrationError extends Error {
  readonly code = 'billing_live_plan_registration_refused' as const;

  constructor(
    readonly reason: BillingLivePlanRegistrationFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingLivePlanRegistrationError';
  }
}

export function isBillingLivePlanRegistrationError(
  error: unknown,
): error is BillingLivePlanRegistrationError {
  return error instanceof BillingLivePlanRegistrationError;
}

/* -------------------------------------------------------------------------- */
/* The four supplied plan codes                                               */
/* -------------------------------------------------------------------------- */

/**
 * The four operator-supplied code slots, one per provisionable combination.
 * The key vocabulary is canonical and closed: nothing else is accepted, so a
 * typo can never silently register the wrong combination.
 */
export const LIVE_PLAN_CODE_KEYS = [
  'pro-monthly',
  'pro-annual',
  'elite-monthly',
  'elite-annual',
] as const;
export type LivePlanCodeKey = (typeof LIVE_PLAN_CODE_KEYS)[number];

/** The combination each slot registers, in deterministic matrix order. */
export const LIVE_PLAN_CODE_KEY_ENTRIES: readonly {
  readonly key: LivePlanCodeKey;
  readonly cataloguePlan: 'pro' | 'elite';
  readonly interval: BillingInterval;
}[] = Object.freeze(
  SANDBOX_PLAN_MATRIX.map((entry) =>
    Object.freeze({
      key: `${entry.cataloguePlan}-${entry.interval}` as LivePlanCodeKey,
      cataloguePlan: entry.cataloguePlan,
      interval: entry.interval,
    }),
  ),
);

const KNOWN_CODE_KEYS: ReadonlySet<string> = new Set(LIVE_PLAN_CODE_KEYS);

/**
 * Keys that name the Starter tier. They are refused with their own reason and
 * their own message: a Starter code is not "an unknown key" — it is a
 * deliberate, documented non-sellable tier (`docs/billing.md`, Billing Step
 * 10a), and the refusal says so.
 */
const STARTER_CODE_KEY_PATTERN = /^starter\b|^starter[-_]|^starter$/i;

/** One validated code slot: the combination it registers and the raw code. */
export interface LivePlanCodeEntry {
  readonly key: LivePlanCodeKey;
  readonly cataloguePlan: 'pro' | 'elite';
  readonly interval: BillingInterval;
  readonly providerPlanId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the FOUR supplied live plan codes — pure, no I/O.
 *
 * Refuses: a non-object, an empty/partial map, an unknown or Starter key, a
 * non-string/blank/oversized code, and one code reused for two combinations.
 * The provider-plan code SHAPE (documented `PLN_…`), the placeholder/fixture
 * markers and the excluded capability-evidence plan are validated by the
 * batch admission step this function feeds (`prepareSandboxProvisioningBatch`)
 * — one implementation, never a second copy of those rules here.
 */
export function parseLivePlanCodes(raw: unknown): readonly LivePlanCodeEntry[] {
  if (!isPlainObject(raw)) {
    throw new BillingLivePlanRegistrationError(
      'plan_matrix',
      'The live plan codes must be supplied as one object mapping each of the four combinations ' +
        `(${LIVE_PLAN_CODE_KEYS.join(', ')}) to the provider plan code the dashboard issued.`,
    );
  }

  const keys = Object.keys(raw);
  const starterKey = keys.find((key) => STARTER_CODE_KEY_PATTERN.test(key.trim()));
  if (starterKey !== undefined) {
    throw new BillingLivePlanRegistrationError(
      'starter_not_provisionable',
      `"${starterKey}" names the Starter tier, which is not sellable in this build: Starter has no internal ` +
        'plan value, no entitlement definition and no provider plan, so it is never registered as an epoch ' +
        '(see docs/billing.md — Starter disposition). Nothing was registered.',
    );
  }

  const unknownKeys = keys.filter((key) => !KNOWN_CODE_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new BillingLivePlanRegistrationError(
      'plan_matrix',
      `Unknown live plan code slot(s) ${unknownKeys.map((key) => `"${key}"`).join(', ')}. The only accepted ` +
        `slots are ${LIVE_PLAN_CODE_KEYS.join(', ')} (Pro and Elite × monthly and annual).`,
    );
  }

  const missingKeys = LIVE_PLAN_CODE_KEYS.filter((key) => !keys.includes(key));
  if (missingKeys.length > 0) {
    throw new BillingLivePlanRegistrationError(
      'plan_matrix',
      `A live plan registration is exactly the four provisionable combinations; ` +
        `${missingKeys.map((key) => `"${key}"`).join(', ')} ${missingKeys.length === 1 ? 'is' : 'are'} missing. ` +
        'A partial batch is never registered.',
    );
  }

  const entries: LivePlanCodeEntry[] = [];
  const seenCodes = new Map<string, LivePlanCodeKey>();
  for (const slot of LIVE_PLAN_CODE_KEY_ENTRIES) {
    const value = raw[slot.key];
    if (typeof value !== 'string') {
      throw new BillingLivePlanRegistrationError(
        'plan_matrix',
        `The live plan code for "${slot.key}" must be a string (the provider-issued code, verbatim).`,
      );
    }
    const code = value.trim();
    if (code === '' || code.length > 128) {
      throw new BillingLivePlanRegistrationError(
        'plan_matrix',
        `The live plan code for "${slot.key}" must be a non-empty string of at most 128 characters. ` +
          'Nothing was registered.',
      );
    }
    const existing = seenCodes.get(code);
    if (existing !== undefined) {
      throw new BillingLivePlanRegistrationError(
        'duplicate_provider_plan',
        `The code "${code}" was supplied for both "${existing}" and "${slot.key}". One provider plan is ` +
          'never mapped to two local combinations.',
      );
    }
    seenCodes.set(code, slot.key);
    entries.push({ ...slot, providerPlanId: code });
  }

  return entries;
}

/**
 * Parse the operator-supplied configuration value (`PAYSTACK_LIVE_PLAN_CODES`,
 * a JSON object of the four slots) — pure, no environment read. A malformed
 * JSON document or a structurally unusable map is `invalid_config`, so the
 * operator tooling can classify it as a configuration error (nothing was
 * attempted) instead of a refusal.
 */
export function parseLivePlanCodesConfig(raw: string): Record<LivePlanCodeKey, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BillingLivePlanRegistrationError(
      'invalid_config',
      'PAYSTACK_LIVE_PLAN_CODES must be a JSON object mapping the four slots to the live provider plan ' +
        `codes (for example {"pro-monthly":"PLN_…","pro-annual":"PLN_…","elite-monthly":"PLN_…","elite-annual":"PLN_…"}). ` +
        'It could not be parsed as JSON.',
      { cause: error },
    );
  }
  try {
    const entries = parseLivePlanCodes(parsed);
    const map = {} as Record<LivePlanCodeKey, string>;
    for (const entry of entries) map[entry.key] = entry.providerPlanId;
    return map;
  } catch (error) {
    if (isBillingLivePlanRegistrationError(error)) {
      throw new BillingLivePlanRegistrationError('invalid_config', error.message, { cause: error });
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Observed amounts (optional operator evidence)                              */
/* -------------------------------------------------------------------------- */

const scaledInteger = z.union([
  z.bigint(),
  z.string().regex(/^[0-9]+$/, 'a minor-unit amount must be an unsigned integer string'),
  z.number().int().safe(),
]);

/**
 * The GHS amounts the operator OBSERVED on the dashboard plans, keyed by the
 * same four slots. Optional: when a slot is absent the derived amount is used,
 * and the absence is visible in the dry-run output. When a slot is present it
 * is evidence — the batch admission step compares it against
 * `half_up(catalogue USD minor × FX)` and refuses any disagreement.
 */
export function parseObservedAmountsMinor(raw: unknown): Readonly<Partial<Record<LivePlanCodeKey, bigint>>> {
  if (raw === undefined || raw === null) return Object.freeze({});
  if (!isPlainObject(raw)) {
    throw new BillingLivePlanRegistrationError(
      'invalid_evidence',
      'Observed amounts must be supplied as one object keyed by the four live plan code slots.',
    );
  }
  const result: Partial<Record<LivePlanCodeKey, bigint>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_CODE_KEYS.has(key)) {
      throw new BillingLivePlanRegistrationError(
        'invalid_evidence',
        `Observed amount supplied for unknown slot "${key}"; the accepted slots are ` +
          `${LIVE_PLAN_CODE_KEYS.join(', ')}.`,
      );
    }
    const parsed = scaledInteger.safeParse(value);
    const amount = parsed.success ? BigInt(parsed.data) : null;
    if (amount === null || amount < 0n) {
      throw new BillingLivePlanRegistrationError(
        'invalid_evidence',
        `The observed amount for "${key}" must be an UNSIGNED integer number of GHS minor units ` +
          '(pesewas) — never a decimal string, a float or a negative amount.',
        { cause: parsed.success ? undefined : parsed.error },
      );
    }
    result[key as LivePlanCodeKey] = amount;
  }
  return Object.freeze(result);
}

/* -------------------------------------------------------------------------- */
/* Evidence assembly (pure)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the four provider-plan EVIDENCE entries (the input contract the
 * sandbox Step 4 batch has always used) from the four supplied live codes:
 * `mode: 'live'`, GHS, exponent 2, uncapped, the explicit provider interval,
 * and the amount the operator observed when one was supplied (otherwise the
 * derived amount, which the batch compares against the derivation anyway).
 *
 * Pure: no database, no clock, no network, no environment. It derives amounts
 * from the catalogue and the FX version it is given — it never invents a
 * price, never publishes a rate and never reads a provider.
 */
export function buildLivePlanRegistrationEvidence(params: {
  planCodes: unknown;
  fxVersion: unknown;
  evidenceReference: string;
  observedAmountsMinor?: unknown;
}): readonly SandboxProviderPlanEvidence[] {
  const entries = parseLivePlanCodes(params.planCodes);
  const fx = parseFxRateVersion(params.fxVersion);
  const observed = parseObservedAmountsMinor(params.observedAmountsMinor);

  return entries.map((entry) => {
    const derived = computePaymentAmountMinor({
      usdMinor: BigInt(cataloguePriceMinor(entry.cataloguePlan, entry.interval)),
      rateScaled: fx.fxRateScaled,
      rateScale: fx.fxRateScale,
    });
    return {
      cataloguePlan: entry.cataloguePlan,
      interval: entry.interval,
      providerInterval: providerIntervalForBillingInterval(entry.interval),
      providerPlanId: entry.providerPlanId,
      paymentCurrency: 'GHS',
      // The observation is evidence; the derivation stays the authority and
      // the batch admission step compares the two.
      paymentAmountMinor: observed[entry.key] ?? derived,
      paymentAmountExponent: 2,
      mode: 'live',
      paymentCountCap: 'uncapped',
      evidenceReference: params.evidenceReference,
    } satisfies SandboxProviderPlanEvidence;
  });
}

/* -------------------------------------------------------------------------- */
/* The validated plan (what the operator is shown, and what will be written)  */
/* -------------------------------------------------------------------------- */

export interface LivePlanRegistrationPlanEntry {
  readonly key: LivePlanCodeKey;
  readonly cataloguePlan: 'pro' | 'elite';
  readonly interval: BillingInterval;
  readonly providerInterval: ProviderPlanInterval;
  readonly providerPlanId: string;
  /** GHS minor units, exactly the derived amount (never a float). */
  readonly paymentAmountMinor: bigint;
  /** The catalogue USD minor amount the derivation started from (D-5). */
  readonly catalogueAmountMinor: number;
  readonly paymentCurrency: BillingPaymentCurrency;
  /** True when the operator supplied (and the derivation accepted) an observation. */
  readonly amountObserved: boolean;
}

export interface LivePlanRegistrationPlan {
  readonly mode: 'live';
  /** ONE instant per batch: the freshness instant and every epoch's valid_from. */
  readonly registeredAt: Date;
  readonly fxRateVersionId: string;
  readonly fxRateScaled: bigint;
  readonly fxRateScale: number;
  readonly pricingPolicyVersion: string;
  readonly catalogueVersion: string;
  /** Exactly the four registrations, in matrix order. */
  readonly entries: readonly LivePlanRegistrationPlanEntry[];
}

export interface LivePlanRegistrationResult {
  readonly mode: 'live';
  /** True when nothing was written (validation only). */
  readonly dryRun: boolean;
  readonly plan: LivePlanRegistrationPlan;
  /** The four registered epochs; EMPTY for a dry run. */
  readonly epochs: readonly BillingProviderPlan[];
  /** The transactional audit action that accompanies a real registration. */
  readonly auditAction: typeof BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION;
}

function planFromBatch(
  batch: ValidatedSandboxProvisioningBatch,
  observedKeys: ReadonlySet<string>,
): LivePlanRegistrationPlan {
  return {
    mode: 'live',
    registeredAt: batch.registeredAt,
    fxRateVersionId: batch.fxVersion.id,
    fxRateScaled: batch.fxVersion.fxRateScaled,
    fxRateScale: batch.fxVersion.fxRateScale,
    pricingPolicyVersion: BILLING_PRICING_POLICY_VERSION,
    catalogueVersion: BILLING_CATALOGUE_VERSION,
    entries: batch.registrations.map((registration) => ({
      key: `${registration.cataloguePlan}-${registration.interval}` as LivePlanCodeKey,
      cataloguePlan: registration.cataloguePlan,
      interval: registration.interval,
      providerInterval: registration.providerInterval,
      providerPlanId: registration.providerPlanId,
      paymentAmountMinor: registration.paymentAmountMinor,
      catalogueAmountMinor: registration.catalogueAmountMinor,
      paymentCurrency: registration.paymentCurrency,
      amountObserved: observedKeys.has(`${registration.cataloguePlan}-${registration.interval}`),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* The service                                                                 */
/* -------------------------------------------------------------------------- */

const registerLivePlanEpochsInputSchema = z
  .object({
    fxRateVersionId: z.string().uuid(),
    planCodes: z.unknown(),
    operatorId: z.string(),
    reason: z.string(),
    evidenceReference: z.string(),
    observedAmountsMinor: z.unknown().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

/**
 * Validate one piece of operator identity/justification text: present, within
 * its documented bound, and NEVER credential-shaped (the audit record names a
 * human, a reason and a provenance label — not a key, a token or a password).
 */
function operatorTextOrRefuse(kind: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new BillingLivePlanRegistrationError(
      'invalid_operator',
      `The ${kind} is required: a live registration names the operator (--by), the reason (--reason) and ` +
        'the provenance label (--reference). Nothing was registered.',
    );
  }
  if (trimmed.length > max) {
    throw new BillingLivePlanRegistrationError(
      'invalid_operator',
      `The ${kind} must be at most ${max} characters.`,
    );
  }
  if (BILLING_CREDENTIAL_SHAPED_RE.test(trimmed)) {
    throw new BillingLivePlanRegistrationError(
      'invalid_operator',
      `The ${kind} is credential-shaped and is refused: registration records an operator identity, a reason ` +
        'and a provenance label, never key, token or password material.',
    );
  }
  return trimmed;
}

export interface BillingLivePlanRegistrationOptions {
  db: Pool;
  /**
   * The configured provider domain. There is no default: the value is the
   * configured `PAYSTACK_MODE`, and the service refuses every registration
   * unless it is exactly `live`. Passing `test` (or omitting the option, which
   * means `test`) makes the service a loud no-op — the fail-closed posture.
   */
  mode?: BillingProviderMode;
  /** Injected clock for the registration instant (tests pin it). */
  now?: () => Date;
}

export interface RegisterLivePlanEpochsInput {
  /** The ONE already-published FX version the four amounts derive from. */
  fxRateVersionId: string;
  /** The four supplied live plan codes, keyed by the four slots. */
  planCodes: Readonly<Record<LivePlanCodeKey, string>>;
  /** The named human or named operator run that authorized this batch. */
  operatorId: string;
  /** Why this batch is being registered. */
  reason: string;
  /** Provenance label for where the codes were read (dashboard/ticket label). */
  evidenceReference: string;
  /** Optional GHS amounts the operator observed on the dashboard plans. */
  observedAmountsMinor?: Partial<Record<LivePlanCodeKey, number | string | bigint>>;
  /** Validate the whole batch and write NOTHING. */
  dryRun?: boolean;
}

/**
 * The LIVE plan registration authority: the only supported path that writes
 * live-domain provider-plan epochs from the four operator-supplied codes.
 *
 * It composes — never duplicates — the Step 4 provisioning rules: the batch is
 * prepared and validated by `prepareSandboxProvisioningBatch` and persisted by
 * `BillingPlanProvisioningService`, both in `mode: 'live'`, with the operator
 * audit descriptor attached so the four epochs and their audit event are one
 * transaction.
 */
export class BillingLivePlanRegistrationService {
  private readonly db: Pool;
  private readonly nowFn: () => Date;
  private readonly mode: BillingProviderMode;

  constructor(options: BillingLivePlanRegistrationOptions) {
    this.db = options.db;
    this.nowFn = options.now ?? (() => new Date());
    this.mode = options.mode ?? 'test';
  }

  /** The configured provider domain this service will (or will not) write in. */
  get configuredMode(): BillingProviderMode {
    return this.mode;
  }

  /**
   * Validate (and, unless `dryRun`, register) the four live epochs.
   *
   * Refuses, before any write: a service that is not configured for live
   * (`not_live_mode`), a malformed request (`invalid_input`), a missing or
   * credential-shaped operator/reason/label (`invalid_operator`), a bad
   * instant (`invalid_instant`), Starter or a partial/unknown slot set
   * (`starter_not_provisionable` / `plan_matrix`), a reused code
   * (`duplicate_provider_plan`), a missing/malformed/stale/unshared FX version,
   * and every existing evidence rule (shape, exclusion, cap, currency,
   * exponent, interval, amount). A write-time conflict rolls the whole batch
   * back — the operator decides, this service never repairs.
   */
  async registerLivePlanEpochs(input: unknown): Promise<LivePlanRegistrationResult> {
    // 1. THE MODE GATE. A service that is not explicitly live does nothing at
    //    all: no adapter, no SQL, no environment, no fallback to test.
    if (this.mode !== 'live') {
      throw new BillingLivePlanRegistrationError(
        'not_live_mode',
        `Live plan registration is refused: the configured provider mode is "${this.mode}". ` +
          'Registering live provider-plan epochs requires the explicit live configuration ' +
          '(PAYSTACK_MODE=live) — a test-mode build can never create a live epoch, and nothing was written.',
      );
    }

    // 2. The request contract.
    const parsed = registerLivePlanEpochsInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BillingLivePlanRegistrationError(
        'invalid_input',
        `The live plan registration request is malformed: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
        { cause: parsed.error },
      );
    }
    const operatorId = operatorTextOrRefuse('operator id', parsed.data.operatorId, 128);
    const reason = operatorTextOrRefuse('reason', parsed.data.reason, 500);
    const evidenceReference = operatorTextOrRefuse('provenance label', parsed.data.evidenceReference, 190);

    // 3. ONE instant per batch (the FX freshness instant and every valid_from).
    const registeredAt = this.nowFn();
    if (!(registeredAt instanceof Date) || !Number.isFinite(registeredAt.getTime())) {
      throw new BillingLivePlanRegistrationError(
        'invalid_instant',
        'The registration clock did not produce a finite registration instant.',
      );
    }

    // 4. The four supplied codes (Starter, unknown/partial slots and duplicate
    //    codes are refused here; shape/exclusion rules come from the batch).
    const codes = parseLivePlanCodes(parsed.data.planCodes);
    const observedKeys = new Set(Object.keys({ ...(parsed.data.observedAmountsMinor ?? {}) }));

    // 5. The operator-selected FX version, by IDENTITY: never "latest", never a
    //    constructed or fixture rate. Read as the durable ROW — the same row
    //    the provisioning service re-reads inside its own transaction.
    const { rows } = await this.db.query(
      `SELECT id, base_currency, quote_currency, fx_rate_scaled, fx_rate_scale, rounding_mode,
              source, source_reference, created_by, effective_from, captured_at
         FROM billing_fx_rate_versions
        WHERE id = $1`,
      [parsed.data.fxRateVersionId],
    );
    if (rows[0] === undefined) {
      throw new BillingFxError(
        'missing',
        `The selected FX rate version ${parsed.data.fxRateVersionId} does not exist in the durable ` +
          'authority. Live registration derives every amount from an existing published version: nothing is ' +
          'constructed, imported or promoted locally, and no newer version is silently selected.',
      );
    }

    // 6. Evidence + the WHOLE batch validated (pure) — the same admission rules
    //    the sandbox path uses, in `mode: 'live'`.
    const evidence = buildLivePlanRegistrationEvidence({
      planCodes: Object.fromEntries(codes.map((entry) => [entry.key, entry.providerPlanId])),
      fxVersion: rows[0],
      evidenceReference,
      observedAmountsMinor: parsed.data.observedAmountsMinor,
    });
    const batch = prepareSandboxProvisioningBatch({
      fxVersion: rows[0],
      evidence,
      registeredAt,
      mode: 'live',
    });
    if (batch.fxVersion.id !== parsed.data.fxRateVersionId) {
      throw new BillingProvisioningError(
        'shared_fx_violation',
        'The validated batch does not pin the operator-selected FX version. Nothing was registered.',
      );
    }
    const plan = planFromBatch(batch, observedKeys);

    // 7. A dry run stops here: everything validated, nothing written.
    if (parsed.data.dryRun === true) {
      return {
        mode: 'live',
        dryRun: true,
        plan,
        epochs: [],
        auditAction: BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
      };
    }

    // 8. Persistence: the four epochs + their audit event, one transaction.
    //    The service re-reads the FX row and re-validates the batch inside
    //    that transaction — this call cannot write a partial or unaudited
    //    batch, and a conflict rolls everything back.
    const provisioning = new BillingPlanProvisioningService({
      db: this.db,
      now: () => registeredAt,
      mode: 'live',
    });
    const epochs = await provisioning.registerSandboxPlanEpochs({
      fxRateVersionId: parsed.data.fxRateVersionId,
      evidence,
      audit: { operatorId, reason },
    });

    return {
      mode: 'live',
      dryRun: false,
      plan,
      epochs,
      auditAction: BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
    };
  }
}
