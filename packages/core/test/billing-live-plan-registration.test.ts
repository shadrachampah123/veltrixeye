/**
 * Billing — LIVE plan registration (the four supplied live plan codes → the
 * four live provider-plan epochs), against a real database.
 *
 * What this suite pins:
 *
 *  1. SUPPLIED CODES — the operator-supplied configuration is exactly the four
 *     provisionable slots (`pro-monthly`, `pro-annual`, `elite-monthly`,
 *     `elite-annual`): Starter, unknown/partial slots, blank or reused codes,
 *     malformed JSON and malformed observations are all refused with a typed
 *     reason, and nothing is inferred.
 *  2. MODE IS PERMISSION-BY-CONFIGURATION — a service that is not explicitly
 *     configured for live refuses (`not_live_mode`) BEFORE reading or writing
 *     anything; a live dry run validates the whole batch and writes nothing;
 *     a live WRITE always carries the operator descriptor.
 *  3. THE SAME FOUR-PLAN RULES AS THE SANDBOX PATH — one shared, fresh,
 *     operator-selected FX version; amounts derived from the catalogue × FX
 *     (never taken from evidence); GHS, exponent 2, uncapped, the explicit
 *     interval mapping, genuine `PLN_…` codes unique in the batch, Starter
 *     never provisioned and the excluded capability-evidence plan refused.
 *  4. ATOMIC + AUDITABLE — the four live epochs and ONE
 *     `billing.provider_plans_registered` audit event commit together; a
 *     conflict, a failing audit write or any refusal leaves zero new rows of
 *     either kind; a live registration without an operator descriptor is
 *     `audit_required` and writes nothing.
 *  5. NO PROVIDER, NO ENVIRONMENT, NO EXECUTION — the module and the CLI that
 *     drives it contain no transport, no fetch, no provider import and no
 *     environment read; registering an epoch confirms no payment, activates
 *     nothing and grants no execution.
 *  6. SANDBOX BEHAVIOUR PRESERVED — a test-mode batch still registers without
 *     an audit descriptor and writes no audit event, and the two domains never
 *     see each other's epochs.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  BILLING_CATALOGUE_VERSION,
  BILLING_PRICING_POLICY_VERSION,
  BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
  BillingFxRateVersionStore,
  BillingLivePlanRegistrationService,
  BillingPlanProvisioningService,
  BillingProviderPlanStore,
  EXCLUDED_PROVIDER_PLAN_CODE,
  LIVE_PLAN_CODE_KEYS,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  isBillingFxError,
  isBillingLivePlanRegistrationError,
  isBillingProviderPlanError,
  isBillingProvisioningError,
  migrationStatus,
  MIGRATIONS_DIR,
  parseLivePlanCodes,
  parseLivePlanCodesConfig,
  parseObservedAmountsMinor,
  providerPlanKey,
  buildLivePlanRegistrationEvidence,
  prepareSandboxProvisioningBatch,
} from '../src/index.js';
import { retireActiveEpochs, seedCommercialSubscription, startBillingTestDb, insertUser } from './helpers/billing-checkout.js';

// Unique per suite file: every DB-backed core suite binds its own port.
const DB_PORT = 5533;

/** The pinned batch instant: the freshness anchor and every epoch's valid_from. */
const REGISTERED_AT = new Date('2026-09-29T10:00:00.000Z');
const OPERATOR = 'ops-live-registration-01';
const REASON = 'register the four live Paystack plan epochs for the go-live review';
const REFERENCE = 'paystack-dashboard-live-plans-2026-09-29';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let pool: Pool;

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  pool = db.pool;
}, { timeout: 180_000 });

beforeEach(async () => {
  // Epochs are history and are never deleted; the active surface is emptied
  // between tests, exactly as the other billing suites do.
  await retireActiveEpochs(pool);
});

after(async () => {
  await db?.stop();
});

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

/** One instant per batch, anchored to the pinned registration instant. */
function liveRegistration(mode: 'test' | 'live' = 'live', registeredAt: Date = REGISTERED_AT) {
  return new BillingLivePlanRegistrationService({
    db: pool,
    mode,
    now: () => registeredAt,
  });
}

let fxSequence = 0;

/** Publish an operator FX version INSIDE the freshness window of the batch. */
async function publishFx(rateScaled = 12_500_000n, capturedSecondsBefore = 120) {
  const fxVersions = new BillingFxRateVersionStore(pool);
  const capturedAt = new Date(REGISTERED_AT.getTime() - (capturedSecondsBefore + fxSequence++) * 1000);
  return fxVersions.publish({
    fxRateScaled: rateScaled,
    fxRateScale: 6,
    effectiveFrom: capturedAt,
    capturedAt,
    source: 'ops',
    sourceReference: 'ops-live-fx-board-1',
    createdBy: OPERATOR,
  });
}

/**
 * An FX version anchored to the REAL clock: the CLI runs in a child process
 * with the real clock (no injected instant), so its batch must be inside the
 * live freshness window at the moment it runs.
 */
async function publishFxNow(capturedSecondsBefore = 30) {
  const fxVersions = new BillingFxRateVersionStore(pool);
  const capturedAt = new Date(Date.now() - (capturedSecondsBefore + fxSequence++) * 1000);
  return fxVersions.publish({
    fxRateScaled: 12_500_000n,
    fxRateScale: 6,
    effectiveFrom: capturedAt,
    capturedAt,
    source: 'ops',
    sourceReference: 'ops-live-fx-board-1',
    createdBy: OPERATOR,
  });
}

const code = (): string => `PLN_${randomUUID().replaceAll('-', '')}`;

type Slot = (typeof LIVE_PLAN_CODE_KEYS)[number];

const MATRIX: ReadonlyArray<readonly [Slot, 'pro' | 'elite', 'monthly' | 'annual']> = [
  ['pro-monthly', 'pro', 'monthly'],
  ['pro-annual', 'pro', 'annual'],
  ['elite-monthly', 'elite', 'monthly'],
  ['elite-annual', 'elite', 'annual'],
];

/** Fresh, genuine-format codes: one per slot, never a literal in this file. */
function planCodes(): Record<Slot, string> {
  return {
    'pro-monthly': code(),
    'pro-annual': code(),
    'elite-monthly': code(),
    'elite-annual': code(),
  };
}

function derived(plan: 'pro' | 'elite', interval: 'monthly' | 'annual', rateScaled = 12_500_000n): bigint {
  return computePaymentAmountMinor({
    usdMinor: BigInt(cataloguePriceMinor(plan, interval)),
    rateScaled,
    rateScale: 6,
  });
}

function liveRequest(overrides: Record<string, unknown> = {}) {
  return {
    fxRateVersionId: '',
    planCodes: planCodes(),
    operatorId: OPERATOR,
    reason: REASON,
    evidenceReference: REFERENCE,
    ...overrides,
  };
}

const catchError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
};

const liveReason = (error: unknown): string => {
  assert.ok(
    isBillingLivePlanRegistrationError(error),
    `expected a BillingLivePlanRegistrationError, got ${String(error)}`,
  );
  return error.reason;
};

const provisioningReason = (error: unknown): string => {
  assert.ok(isBillingProvisioningError(error), `expected a BillingProvisioningError, got ${String(error)}`);
  return error.reason;
};

/** The ACTIVE epochs of one domain: retired history is retained and never counted. */
async function epochRows(mode: 'test' | 'live') {
  const { rows } = await pool.query(
    `SELECT catalogue_plan, billing_interval, provider_plan_id, payment_amount_minor::text AS amount,
            payment_currency, payment_amount_exponent, fx_rate_version_id::text AS fx, status, mode,
            provider_plan_reference, valid_from
       FROM billing_provider_plans WHERE mode = $1 AND status = 'active'
      ORDER BY CASE catalogue_plan WHEN 'pro' THEN 0 ELSE 1 END,
               CASE billing_interval WHEN 'monthly' THEN 0 ELSE 1 END`,
    [mode],
  );
  return rows;
}

/** Every live epoch row ever written (active + retired): history is retained. */
async function epochHistory(mode: 'test' | 'live') {
  const { rows } = await pool.query('SELECT id FROM billing_provider_plans WHERE mode = $1', [mode]);
  return rows.length;
}

const auditCount = async (): Promise<number> =>
  (await auditRows()).length;

async function auditRows(action = BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION) {
  const { rows } = await pool.query(
    `SELECT action, entity_type, entity_id, metadata FROM audit_events WHERE action = $1 ORDER BY id`,
    [action],
  );
  return rows;
}

/* ========================================================================== */
/* 1. The four supplied code slots (pure)                                     */
/* ========================================================================== */

describe('live plan registration — the four supplied code slots', () => {
  test('accepts exactly the four slots and keeps matrix order', () => {
    const supplied = planCodes();
    const entries = parseLivePlanCodes(supplied);
    assert.equal(entries.length, 4);
    for (const [index, [slot, plan, interval]] of MATRIX.entries()) {
      const entry = entries[index]!;
      assert.equal(entry.key, slot);
      assert.equal(entry.cataloguePlan, plan);
      assert.equal(entry.interval, interval);
      assert.equal(entry.providerPlanId, supplied[slot], 'the code is carried verbatim');
    }
    assert.deepEqual(
      entries.map((entry) => entry.key),
      [...LIVE_PLAN_CODE_KEYS],
      'the canonical slot vocabulary is closed and ordered',
    );
  });

  test('refuses Starter with its own reason, in every spelling', async () => {
    for (const starterSlot of ['starter', 'starter-monthly', 'starter-annual', 'starter_monthly']) {
      const supplied = { ...planCodes(), [starterSlot]: code() };
      const error = await catchError(() => Promise.resolve(parseLivePlanCodes(supplied)));
      assert.equal(liveReason(error), 'starter_not_provisionable', `${starterSlot} is never provisioned`);
      assert.match((error as Error).message, /Starter.*not sellable/i);
    }
  });

  test('refuses partial, oversized, unknown and duplicated supplies', async () => {
    const supplied = planCodes();

    const missing = await catchError(() =>
      Promise.resolve(parseLivePlanCodes({ ...supplied, 'elite-annual': undefined })),
    );
    assert.equal(liveReason(missing), 'plan_matrix');
    assert.match((missing as Error).message, /elite-annual/);

    const partial = { 'pro-monthly': supplied['pro-monthly'] };
    assert.equal(
      liveReason(await catchError(() => Promise.resolve(parseLivePlanCodes(partial)))),
      'plan_matrix',
    );

    const unknown = await catchError(() =>
      Promise.resolve(parseLivePlanCodes({ ...supplied, 'elite-monthly-extra': code() })),
    );
    assert.equal(liveReason(unknown), 'plan_matrix');
    assert.match((unknown as Error).message, /elite-monthly-extra/);

    const duplicated = { ...supplied, 'elite-annual': supplied['pro-monthly'] };
    assert.equal(
      liveReason(await catchError(() => Promise.resolve(parseLivePlanCodes(duplicated)))),
      'duplicate_provider_plan',
      'one provider plan is never mapped to two local combinations',
    );

    for (const bad of ['', '   ', 42, null, { code: code() }]) {
      const error = await catchError(() =>
        Promise.resolve(parseLivePlanCodes({ ...supplied, 'pro-monthly': bad })),
      );
      assert.equal(liveReason(error), 'plan_matrix', `slot value ${JSON.stringify(bad)} is refused`);
    }

    const oversized = { ...supplied, 'pro-monthly': `PLN_${'a'.repeat(200)}` };
    assert.equal(
      liveReason(await catchError(() => Promise.resolve(parseLivePlanCodes(oversized)))),
      'plan_matrix',
    );

    for (const notAnObject of [null, [], 'PLN_x', 7]) {
      assert.equal(
        liveReason(await catchError(() => Promise.resolve(parseLivePlanCodes(notAnObject)))),
        'plan_matrix',
      );
    }
  });

  test('parses the operator JSON configuration and classifies config errors', () => {
    const supplied = planCodes();
    const parsed = parseLivePlanCodesConfig(JSON.stringify(supplied));
    assert.deepEqual(parsed, supplied);

    const malformed = catchError(() => Promise.resolve(parseLivePlanCodesConfig('{not json')));
    return malformed.then((error) => {
      assert.equal(liveReason(error), 'invalid_config');
      assert.match((error as Error).message, /PAYSTACK_LIVE_PLAN_CODES/);
    });
  });

  test('a structurally unusable configuration is invalid_config (never a silent default)', async () => {
    const error = await catchError(() =>
      Promise.resolve(parseLivePlanCodesConfig(JSON.stringify({ 'pro-monthly': code() }))),
    );
    assert.equal(liveReason(error), 'invalid_config');
    assert.match((error as Error).message, /pro-annual|elite-monthly|elite-annual/);

    const starter = await catchError(() =>
      Promise.resolve(parseLivePlanCodesConfig(JSON.stringify({ ...planCodes(), starter: code() }))),
    );
    assert.equal(liveReason(starter), 'invalid_config');
  });

  test('observed amounts are unsigned integers or refused', async () => {
    const observed = parseObservedAmountsMinor({ 'pro-monthly': 48_750, 'elite-annual': '123750', 'pro-annual': 1n });
    assert.equal(observed['pro-monthly'], 48_750n);
    assert.equal(observed['elite-annual'], 123_750n);
    assert.equal(observed['pro-annual'], 1n);
    assert.deepEqual(parseObservedAmountsMinor(undefined), {});

    for (const bad of [12.5, '48.75', -1, '1e3', true]) {
      const error = await catchError(() =>
        Promise.resolve(parseObservedAmountsMinor({ 'pro-monthly': bad })),
      );
      assert.equal(liveReason(error), 'invalid_evidence', `${JSON.stringify(bad)} is refused`);
    }
    const unknown = await catchError(() => Promise.resolve(parseObservedAmountsMinor({ starter: 1 })));
    assert.equal(liveReason(unknown), 'invalid_evidence');
  });
});

/* ========================================================================== */
/* 2. Evidence assembly: the derivation stays the authority (pure)            */
/* ========================================================================== */

describe('live plan registration — evidence assembly', () => {
  test('builds the four live evidences from the supplied codes and the derivation', async () => {
    const fx = await publishFx();
    const fxRow = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [fx.id])).rows[0];
    const supplied = planCodes();

    const evidence = buildLivePlanRegistrationEvidence({
      planCodes: supplied,
      fxVersion: fxRow,
      evidenceReference: REFERENCE,
    });

    assert.equal(evidence.length, 4);
    for (const [index, [slot, plan, interval]] of MATRIX.entries()) {
      const entry = evidence[index]!;
      assert.equal(entry.cataloguePlan, plan);
      assert.equal(entry.interval, interval);
      assert.equal(entry.providerInterval, interval === 'annual' ? 'annually' : 'monthly');
      assert.equal(entry.providerPlanId, supplied[slot]);
      assert.equal(entry.mode, 'live', 'the evidence is live-domain by construction');
      assert.equal(entry.paymentCurrency, 'GHS');
      assert.equal(entry.paymentAmountExponent, 2);
      assert.equal(entry.paymentCountCap, 'uncapped');
      assert.equal(entry.evidenceReference, REFERENCE);
      assert.equal(BigInt(entry.paymentAmountMinor as bigint), derived(plan, interval));
    }

    // An observation is EVIDENCE: a disagreeing one is refused by the batch.
    const observed = buildLivePlanRegistrationEvidence({
      planCodes: supplied,
      fxVersion: fxRow,
      evidenceReference: REFERENCE,
      observedAmountsMinor: { 'pro-monthly': Number(derived('pro', 'monthly')) + 1 },
    });
    const mismatch = await catchError(() =>
      Promise.resolve(
        prepareSandboxProvisioningBatch({
          fxVersion: fxRow,
          evidence: observed,
          registeredAt: REGISTERED_AT,
          mode: 'live',
        }),
      ),
    );
    assert.equal(provisioningReason(mismatch), 'amount_mismatch');

    // A matching observation is accepted and keeps the derivation.
    const matching = buildLivePlanRegistrationEvidence({
      planCodes: supplied,
      fxVersion: fxRow,
      evidenceReference: REFERENCE,
      observedAmountsMinor: { 'pro-monthly': Number(derived('pro', 'monthly')) },
    });
    const batch = prepareSandboxProvisioningBatch({
      fxVersion: fxRow,
      evidence: matching,
      registeredAt: REGISTERED_AT,
      mode: 'live',
    });
    assert.equal(batch.registrations[0]!.paymentAmountMinor, derived('pro', 'monthly'));
  });

  test('the excluded capability-evidence plan is refused before any write', async () => {
    const fx = await publishFx();
    const fxRow = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [fx.id])).rows[0];
    const evidence = buildLivePlanRegistrationEvidence({
      planCodes: { ...planCodes(), 'pro-monthly': EXCLUDED_PROVIDER_PLAN_CODE },
      fxVersion: fxRow,
      evidenceReference: REFERENCE,
    });
    const error = await catchError(() =>
      Promise.resolve(
        prepareSandboxProvisioningBatch({
          fxVersion: fxRow,
          evidence,
          registeredAt: REGISTERED_AT,
          mode: 'live',
        }),
      ),
    );
    assert.equal(provisioningReason(error), 'excluded_provider_plan');
  });

  test('placeholder-shaped codes are refused by the shared admission rules', async () => {
    const fx = await publishFx();
    const fxRow = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [fx.id])).rows[0];
    for (const placeholder of ['PLN_placeholder01', 'PLN_live_sample0001', 'pln_lowercase01', 'PLN_FIXTURE0001']) {
      const evidence = buildLivePlanRegistrationEvidence({
        planCodes: { ...planCodes(), 'pro-monthly': placeholder },
        fxVersion: fxRow,
        evidenceReference: REFERENCE,
      });
      const error = await catchError(() =>
        Promise.resolve(
          prepareSandboxProvisioningBatch({
            fxVersion: fxRow,
            evidence,
            registeredAt: REGISTERED_AT,
            mode: 'live',
          }),
        ),
      );
      assert.equal(
        provisioningReason(error),
        'invalid_provider_plan',
        `${placeholder} is never a provider plan code`,
      );
    }
  });
});

/* ========================================================================== */
/* 3. The mode gate, the operator descriptor and the dry run (DB)             */
/* ========================================================================== */

describe('live plan registration — fail-closed gates', () => {
  test('migration 0035 is present and applied (the live epoch schema)', async () => {
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.equal(status.expectedCount, 35);
    assert.equal(status.appliedCount, 35);
    assert.equal(status.latestApplied, '0035_billing_live_mode.sql');
  });

  test('a service that is not explicitly live refuses before anything is read or written', async () => {
    for (const service of [liveRegistration('test'), new BillingLivePlanRegistrationService({ db: pool })]) {
      const error = await catchError(() =>
        service.registerLivePlanEpochs(liveRequest({ fxRateVersionId: randomUUID() })),
      );
      assert.equal(liveReason(error), 'not_live_mode');
      assert.match((error as Error).message, /PAYSTACK_MODE=live|configured provider mode/);
    }
    assert.equal((await epochRows('live')).length, 0, 'no live epoch was written');
    assert.equal((await auditRows()).length, 0, 'no audit event was written');
  });

  test('a live dry run validates the whole batch and writes nothing', async () => {
    const fx = await publishFx();
    const result = await liveRegistration().registerLivePlanEpochs(
      liveRequest({ fxRateVersionId: fx.id, dryRun: true }),
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.epochs.length, 0);
    assert.equal(result.mode, 'live');
    assert.equal(result.plan.fxRateVersionId, fx.id);
    assert.equal(result.plan.registeredAt.getTime(), REGISTERED_AT.getTime());
    assert.equal(result.plan.fxRateScaled, 12_500_000n);
    assert.equal(result.plan.pricingPolicyVersion, BILLING_PRICING_POLICY_VERSION);
    assert.equal(result.plan.catalogueVersion, BILLING_CATALOGUE_VERSION);
    for (const [index, [slot, plan, interval]] of MATRIX.entries()) {
      const entry = result.plan.entries[index]!;
      assert.equal(entry.key, slot);
      assert.equal(entry.paymentAmountMinor, derived(plan, interval));
      assert.equal(entry.amountObserved, false);
    }
    assert.equal((await epochRows('live')).length, 0, 'a dry run writes no epoch');
    assert.equal((await auditRows()).length, 0, 'a dry run writes no audit event');
  });

  test('a live dry run still refuses an unusable FX version and unusable operator input', async () => {
    const missing = await catchError(() =>
      liveRegistration().registerLivePlanEpochs(liveRequest({ fxRateVersionId: randomUUID(), dryRun: true })),
    );
    assert.ok(isBillingFxError(missing), 'a missing FX version is a typed FX refusal');
    assert.equal((missing as { reason: string }).reason, 'missing');

    // Stale beyond the 900-second window: 901 s is refused (inclusive at 900).
    const stale = await publishFx(12_500_000n, 901);
    const staleError = await catchError(() =>
      liveRegistration().registerLivePlanEpochs(liveRequest({ fxRateVersionId: stale.id, dryRun: true })),
    );
    assert.equal((staleError as { reason: string }).reason, 'stale');

    const usable = await publishFx(12_500_000n, 30);
    for (const bad of [
      { operatorId: '' },
      { reason: '' },
      { evidenceReference: '' },
      { operatorId: 'ops sk_live_secret01' },
      { reason: 'apikey 12345' },
      { evidenceReference: 'token abc' },
    ]) {
      const error = await catchError(() =>
        liveRegistration().registerLivePlanEpochs(
          liveRequest({ fxRateVersionId: usable.id, dryRun: true, ...bad }),
        ),
      );
      assert.equal(liveReason(error), 'invalid_operator', `${JSON.stringify(bad)} is refused`);
    }
  });

  test('a live registration without the operator descriptor (raw provisioning) is audit_required', async () => {
    const fx = await publishFx();
    const fxRow = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [fx.id])).rows[0];
    const evidence = buildLivePlanRegistrationEvidence({
      planCodes: planCodes(),
      fxVersion: fxRow,
      evidenceReference: REFERENCE,
    });
    const service = new BillingPlanProvisioningService({ db: pool, mode: 'live', now: () => REGISTERED_AT });
    const error = await catchError(() =>
      service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence }),
    );
    assert.equal(provisioningReason(error), 'audit_required');
    assert.equal(await epochHistory('live'), 0, 'no epoch row of any status was written');

    // A credential-shaped descriptor is refused too: the audit record names a
    // human and a reason, never key material.
    for (const shapedAudit of [
      { operatorId: 'ops', reason: 'apikey 0123456789abcdef' },
      { operatorId: 'ops', reason: 'Authorization: Bearer abcdef' },
      { operatorId: 'svc token 01', reason: REASON },
    ]) {
      const shaped = await catchError(() =>
        service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence, audit: shapedAudit }),
      );
      assert.equal(
        provisioningReason(shaped),
        'audit_required',
        `${JSON.stringify(shapedAudit)} is credential-shaped and refused`,
      );
    }
    assert.equal(await epochHistory('live'), 0);
    assert.equal((await auditRows()).length, 0);
  });
});

/* ========================================================================== */
/* 4. The real live registration (DB)                                         */
/* ========================================================================== */

describe('live plan registration — the registered batch', () => {
  test('registers the four live epochs from the supplied codes, atomically and audited', async () => {
    const fx = await publishFx();
    const supplied = planCodes();
    const result = await liveRegistration().registerLivePlanEpochs(
      liveRequest({ fxRateVersionId: fx.id, planCodes: supplied }),
    );

    assert.equal(result.dryRun, false);
    assert.equal(result.auditAction, BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION);
    assert.equal(result.epochs.length, 4);

    const rows = await epochRows('live');
    assert.equal(rows.length, 4);
    for (const [index, [slot, plan, interval]] of MATRIX.entries()) {
      const row = rows[index]!;
      const epoch = result.epochs[index]!;
      assert.equal(row.catalogue_plan, plan);
      assert.equal(row.billing_interval, interval);
      assert.equal(row.provider_plan_id, supplied[slot], 'the supplied code is stored verbatim');
      assert.equal(row.amount, derived(plan, interval).toString());
      assert.equal(row.payment_currency, 'GHS');
      assert.equal(row.payment_amount_exponent, 2);
      assert.equal(row.fx, fx.id, 'one shared FX version across the batch');
      assert.equal(row.status, 'active');
      assert.equal(row.mode, 'live');
      assert.equal(row.provider_plan_reference, REFERENCE);
      assert.equal(row.valid_from.toISOString(), REGISTERED_AT.toISOString());
      assert.equal(epoch.mode, 'live');
      assert.equal(epoch.paymentAmountMinor, derived(plan, interval));
    }

    // ONE transactional audit event, on the same transaction as the epochs.
    const audits = await auditRows();
    assert.equal(audits.length, 1);
    const metadata = audits[0]!.metadata as Record<string, unknown>;
    assert.equal(audits[0]!.entity_type, 'billing_provider_plan');
    assert.equal(audits[0]!.entity_id, fx.id, 'the batch is identified by its shared FX version');
    assert.equal(metadata.mode, 'live');
    assert.equal(metadata.operatorId, OPERATOR);
    assert.equal(metadata.reason, REASON);
    assert.equal(metadata.fxRateVersionId, fx.id);
    assert.equal(metadata.pricingPolicyVersion, BILLING_PRICING_POLICY_VERSION);
    assert.equal(metadata.catalogueVersion, BILLING_CATALOGUE_VERSION);
    assert.equal(metadata.grantsExecution, false);
    assert.equal(metadata.paymentConfirmed, false);
    const auditedEpochs = metadata.epochs as Array<Record<string, unknown>>;
    assert.equal(auditedEpochs.length, 4);
    for (const [index, [slot, plan, interval]] of MATRIX.entries()) {
      const audited = auditedEpochs[index]!;
      assert.equal(audited.cataloguePlan, plan);
      assert.equal(audited.billingInterval, interval);
      assert.equal(audited.providerInterval, interval === 'annual' ? 'annually' : 'monthly');
      assert.equal(audited.providerPlanId, supplied[slot]);
      assert.equal(audited.paymentAmountMinor, derived(plan, interval).toString());

      // The live directory resolves the epoch; the test directory never does.
      const liveStore = new BillingProviderPlanStore(pool, undefined, 'live');
      const found = await liveStore.findActive(providerPlanKey(plan, interval, { mode: 'live' }));
      assert.equal(found.providerPlanId, supplied[slot]);
      const testStore = new BillingProviderPlanStore(pool);
      const crossDomain = await catchError(() =>
        testStore.findActive(providerPlanKey(plan, interval, { mode: 'live' })),
      );
      assert.ok(
        crossDomain !== null && isBillingProviderPlanError(crossDomain),
        'a test-mode directory never reads a live epoch',
      );
    }

    // Registering epochs is not a sale: no subscription, no activation, no
    // entitlement was created anywhere.
    const { rows: activations } = await pool.query('SELECT id FROM billing_subscription_activations');
    assert.equal(activations.length, 0, 'registration activates nothing');
    const { rows: subscriptions } = await pool.query('SELECT id FROM subscriptions');
    assert.equal(subscriptions.length, 0, 'registration sells nothing');
  });

  test('a replayed batch is a conflict that rolls back and writes no audit event', async () => {
    const fx = await publishFx();
    const supplied = planCodes();
    const request = liveRequest({ fxRateVersionId: fx.id, planCodes: supplied });
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();
    await liveRegistration().registerLivePlanEpochs(request);
    assert.equal((await epochRows('live')).length, 4);
    assert.equal(await epochHistory('live'), historyBefore + 4);
    assert.equal(await auditCount(), auditsBefore + 1, 'one audit event per registered batch');

    // Same combination, one fresh code: the store refuses before the audit
    // event can be written, and the whole batch rolls back.
    const fresh = await publishFx(12_500_000n, 60);
    const conflict = await catchError(() =>
      liveRegistration().registerLivePlanEpochs(
        liveRequest({
          fxRateVersionId: fresh.id,
          planCodes: { ...supplied, 'elite-annual': code() },
        }),
      ),
    );
    assert.ok(isBillingProviderPlanError(conflict), `expected a plan conflict, got ${String(conflict)}`);
    assert.equal((conflict as { reason: string }).reason, 'conflict');
    assert.equal((await epochRows('live')).length, 4, 'no partial batch survived');
    assert.equal(await epochHistory('live'), historyBefore + 4, 'no row of any status was written by the refusal');
    assert.equal(await auditCount(), auditsBefore + 1, 'the rolled-back batch wrote no audit event');

    // A code already registered to another epoch is a conflict too.
    const other = await catchError(() =>
      liveRegistration().registerLivePlanEpochs(
        liveRequest({ fxRateVersionId: fresh.id, planCodes: { ...planCodes(), 'pro-monthly': supplied['pro-monthly'] } }),
      ),
    );
    assert.ok(isBillingProviderPlanError(other));
    assert.equal(await epochHistory('live'), historyBefore + 4);
    assert.equal(await auditCount(), auditsBefore + 1);
  });

  test('a failing audit write rolls the four epochs back with it', async () => {
    const fx = await publishFx();
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();
    // Test-only failure injection: the audit table refuses this action for the
    // duration of the test, so the atomicity of "epochs + audit event" is
    // observed from the outside (nothing may survive the refusal).
    await pool.query(`
      CREATE OR REPLACE FUNCTION test_refuse_registration_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = '${BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION}' THEN
          RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'test: audit refused';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await pool.query(`
      CREATE TRIGGER test_refuse_registration_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_refuse_registration_audit();
    `);
    try {
      const error = await catchError(() =>
        liveRegistration().registerLivePlanEpochs(
          liveRequest({ fxRateVersionId: fx.id, planCodes: planCodes() }),
        ),
      );
      assert.equal(provisioningReason(error), 'audit_required');
      assert.match((error as Error).message, /audit event could not be written/);
      assert.equal(await epochHistory('live'), historyBefore, 'the epochs rolled back with the audit event');
      assert.equal(await auditCount(), auditsBefore);
    } finally {
      await pool.query('DROP TRIGGER test_refuse_registration_audit ON audit_events');
      await pool.query('DROP FUNCTION test_refuse_registration_audit()');
    }
  });

  test('an observed amount that disagrees with the derivation is refused before any write', async () => {
    const fx = await publishFx();
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();
    const error = await catchError(() =>
      liveRegistration().registerLivePlanEpochs(
        liveRequest({
          fxRateVersionId: fx.id,
          observedAmountsMinor: { 'pro-monthly': Number(derived('pro', 'monthly')) + 1 },
        }),
      ),
    );
    assert.equal(provisioningReason(error), 'amount_mismatch');
    assert.equal((await epochRows('live')).length, 0);
    assert.equal(await epochHistory('live'), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});

/* ========================================================================== */
/* 5. Sandbox behaviour preserved (DB)                                        */
/* ========================================================================== */

describe('live plan registration — the sandbox path is unchanged', () => {
  test('a test-mode batch still registers without an audit descriptor and writes no audit event', async () => {
    const fx = await publishFx();
    const fxRow = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [fx.id])).rows[0];
    const supplied = planCodes();
    const evidence = buildLivePlanRegistrationEvidence({
      planCodes: supplied,
      fxVersion: fxRow,
      evidenceReference: REFERENCE,
    }).map((entry) => ({ ...entry, mode: 'test' }));

    const auditsBefore = await auditCount();
    const service = new BillingPlanProvisioningService({ db: pool, mode: 'test', now: () => REGISTERED_AT });
    const registered = await service.registerSandboxPlanEpochs({ fxRateVersionId: fx.id, evidence });
    assert.equal(registered.length, 4);
    for (const epoch of registered) assert.equal(epoch.mode, 'test');
    assert.equal((await epochRows('test')).length, 4);
    assert.equal(await auditCount(), auditsBefore, 'sandbox registration keeps its historical behaviour');

    // And the sandbox path never crosses into the live domain: the four live
    // combinations are still unprovisioned.
    assert.equal((await epochRows('live')).length, 0);
  });

  test('Starter stays unrepresentable in the database as well as in code', async () => {
    const fx = await publishFx();
    const historyBefore = await epochHistory('live');
    const error = await pool.query(
      `INSERT INTO billing_provider_plans (mode, catalogue_plan, billing_interval, payment_amount_minor,
         provider_plan_id, fx_rate_version_id, pricing_policy_version, catalogue_version,
         catalogue_amount_minor, valid_from)
       VALUES ('live', 'starter', 'monthly', 1000, $1, $2, $3, $4, 1500, now())
       RETURNING id`,
      [code(), fx.id, BILLING_PRICING_POLICY_VERSION, BILLING_CATALOGUE_VERSION],
    ).then(
      () => null,
      (refusal: { code?: string }) => refusal,
    );
    assert.ok(error !== null && error.code === '23514', 'the catalogue_plan CHECK refuses starter');
    assert.equal(await epochHistory('live'), historyBefore, 'no starter row of any status exists');
  });
});

/* ========================================================================== */
/* 6. No provider, no environment, no execution (source pinning)              */
/* ========================================================================== */

describe('live plan registration — the boundary it keeps', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (relative: string) =>
    readFileSync(path.resolve(here, relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('the module carries no transport, no provider import and no environment read', () => {
    const module = read('../src/billing/live-plan-registration.ts');
    assert.doesNotMatch(module, /\bfetch\s*\(/, 'no transport');
    assert.doesNotMatch(module, /https?:\/\//, 'no provider URL');
    assert.doesNotMatch(module, /provider-paystack|PaystackFetchFn|createPaystackProvider/, 'no provider import');
    assert.doesNotMatch(module, /process\.env/, 'no environment read in the module');
    assert.doesNotMatch(module, /PAYSTACK_SECRET_KEY|sk_live_|sk_test_/, 'no key material');
    // No payment confirmation and no capability grant is reachable from here.
    assert.doesNotMatch(module, /resolveEntitlements|BillingActivationService|canAccessAutomation/, 'no entitlement path');
  });

  test('the CLI is operator tooling: configuration in, no transport, no key material', () => {
    const cli = read('../../../scripts/billing/provision-live.ts');
    assert.doesNotMatch(cli, /\bfetch\s*\(/, 'no transport');
    assert.doesNotMatch(cli, /https?:\/\//, 'no provider URL');
    assert.doesNotMatch(cli, /provider-paystack|PaystackFetchFn|createPaystackProvider/, 'no provider import');
    assert.doesNotMatch(cli, /PAYSTACK_SECRET_KEY|sk_live_|sk_test_/, 'no key material');
    // The only environment read is the CLI's own boundary helper: environment
    // first, then the repo-root `.env` — never inside a business module.
    assert.equal((cli.match(/process\.env/g) ?? []).length, 1);
    assert.match(cli, /return process\.env\[key\] \?\? readDotEnvValue\(key\)/);
    assert.match(cli, /PAYSTACK_MODE/, 'the CLI gates on the configured provider domain');
    assert.match(cli, /PAYSTACK_LIVE_PLAN_CODES/, 'the codes are operator-supplied configuration');
  });

  test('registering live epochs confirms no payment and grants no execution', async () => {
    const fx = await publishFx();
    const auditsBefore = await auditCount();
    await liveRegistration().registerLivePlanEpochs(liveRequest({ fxRateVersionId: fx.id }));

    // A live deployment may now SELL against the registered epochs (checkout
    // selects them) — but nothing is confirmed by their existence: the
    // provider-backed subscription stays pending and unactivated.
    const user = await insertUser(pool);
    const commercial = await seedCommercialSubscription(pool, user.id, { mode: 'live' });
    assert.equal(commercial.cataloguePlan, 'pro');

    const state = await pool.query(
      `SELECT s.provider_state,
              EXISTS (SELECT 1 FROM billing_subscription_activations a WHERE a.subscription_id = s.id) AS activated
         FROM subscriptions s WHERE s.id = $1`,
      [commercial.subscriptionId],
    );
    assert.equal(state.rows[0]!.activated, false, 'a registered epoch is not a payment confirmation');
    assert.equal(state.rows[0]!.provider_state, 'pending');
    const epochs = await epochRows('live');
    assert.equal(epochs.length, 4);
    assert.equal(await auditCount(), auditsBefore + 1, 'seeding a subscription writes no registration audit event');
  });
});


/* ========================================================================== */
/* 7. The operator CLI (scripts/billing/provision-live.ts), end to end         */
/* ========================================================================== */

describe('live plan registration — the operator CLI', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');

  /** Run the CLI exactly as an operator would, in a child process. */
  function cli(env: Record<string, string>, args: readonly string[]) {
    return spawnSync('node', ['--import', 'tsx', 'scripts/billing/provision-live.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    });
  }

  const baseArgs = (fxId: string) => [
    '--fx-rate-version', fxId,
    '--by', OPERATOR,
    '--reason', REASON,
    '--reference', REFERENCE,
  ];

  test('refuses without an explicit live configuration, and writes nothing', async () => {
    const fx = await publishFxNow();
    const supplied = planCodes();
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();

    for (const configuredMode of ['test', 'sandbox', 'LIVE']) {
      const result = cli(
        { DATABASE_URL: db.dbUrl, PAYSTACK_MODE: configuredMode, PAYSTACK_LIVE_PLAN_CODES: JSON.stringify(supplied) },
        baseArgs(fx.id),
      );
      assert.equal(result.status, 2, `PAYSTACK_MODE=${configuredMode} is a configuration error`);
      assert.match(result.stderr, /PAYSTACK_MODE must be exactly "live"/);
    }

    const absent = cli(
      { DATABASE_URL: db.dbUrl, PAYSTACK_LIVE_PLAN_CODES: JSON.stringify(supplied) },
      baseArgs(fx.id),
    );
    assert.equal(absent.status, 2, 'an absent mode is not a live deployment');
    assert.equal(await epochHistory('live'), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });

  test('refuses unusable supplied configuration before it connects', async () => {
    const fx = await publishFxNow();
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();
    const malformed = cli(
      { DATABASE_URL: db.dbUrl, PAYSTACK_MODE: 'live', PAYSTACK_LIVE_PLAN_CODES: '{not json' },
      baseArgs(fx.id),
    );
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /PAYSTACK_LIVE_PLAN_CODES/);

    const starter = cli(
      {
        DATABASE_URL: db.dbUrl,
        PAYSTACK_MODE: 'live',
        PAYSTACK_LIVE_PLAN_CODES: JSON.stringify({ ...planCodes(), starter: code() }),
      },
      baseArgs(fx.id),
    );
    assert.equal(starter.status, 2, 'a Starter slot in configuration is a configuration error');
    assert.match(starter.stderr, /Starter/);

    const partialFlags = cli(
      { DATABASE_URL: db.dbUrl, PAYSTACK_MODE: 'live', PAYSTACK_LIVE_PLAN_CODES: JSON.stringify(planCodes()) },
      [...baseArgs(fx.id), '--plan', `pro-monthly=${code()}`],
    );
    assert.equal(partialFlags.status, 2, 'a partial --plan set is refused');
    assert.equal(await epochHistory('live'), historyBefore, 'no live epoch row was written');
    assert.equal(await auditCount(), auditsBefore, 'no audit event was written');
  });

  test('a dry run prints the validated plan and writes nothing', async () => {
    const fx = await publishFxNow();
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();
    const result = cli(
      { DATABASE_URL: db.dbUrl, PAYSTACK_MODE: 'live', PAYSTACK_LIVE_PLAN_CODES: JSON.stringify(planCodes()) },
      [...baseArgs(fx.id), '--dry-run'],
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.outcome, 'dry_run');
    assert.equal(output.dryRun, true);
    assert.equal(output.mode, 'live');
    assert.equal(output.providerCalls, 0);
    assert.equal(output.auditAction, null);
    assert.equal(output.fxRateVersionId, fx.id);
    assert.equal((output.plan as unknown[]).length, 4);
    assert.equal(await epochHistory('live'), historyBefore, 'a dry run writes no epoch');
    assert.equal(await auditCount(), auditsBefore, 'a dry run writes no audit event');
  });

  test('registers the four live epochs from the supplied codes, atomically and audited', async () => {
    const fx = await publishFxNow();
    const supplied = planCodes();
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();

    const result = cli(
      { DATABASE_URL: db.dbUrl, PAYSTACK_MODE: 'live', PAYSTACK_LIVE_PLAN_CODES: JSON.stringify(supplied) },
      baseArgs(fx.id),
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      outcome: string;
      auditAction: string;
      grantsExecution: boolean;
      paymentConfirmed: boolean;
      plan: Array<Record<string, unknown>>;
    };
    assert.equal(output.outcome, 'registered');
    assert.equal(output.auditAction, BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION);
    assert.equal(output.grantsExecution, false);
    assert.equal(output.paymentConfirmed, false);
    assert.equal(output.plan.length, 4);
    for (const [index, [slot, plan, interval]] of MATRIX.entries()) {
      const entry = output.plan[index]!;
      assert.equal(entry.slot, slot);
      assert.equal(entry.providerPlanId, supplied[slot]);
      assert.equal(entry.billingInterval, interval);
      assert.equal(entry.providerInterval, interval === 'annual' ? 'annually' : 'monthly');
      assert.equal(entry.paymentAmountMinor, derived(plan, interval).toString());
      assert.notEqual(entry.epochId, null, 'the CLI reports the persisted epoch id');
    }

    assert.equal((await epochRows('live')).length, 4);
    assert.equal(await epochHistory('live'), historyBefore + 4);
    assert.equal(await auditCount(), auditsBefore + 1);
  });

  test('a refused batch exits 1 and leaves the database untouched', async () => {
    const fx = await publishFxNow();
    const historyBefore = await epochHistory('live');
    const auditsBefore = await auditCount();
    const result = cli(
      {
        DATABASE_URL: db.dbUrl,
        PAYSTACK_MODE: 'live',
        PAYSTACK_LIVE_PLAN_CODES: JSON.stringify({ ...planCodes(), 'elite-annual': 'PLN_placeholder01' }),
      },
      baseArgs(fx.id),
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refused \(invalid_provider_plan\)/);
    assert.match(result.stderr, /Nothing was written/);
    assert.equal(await epochHistory('live'), historyBefore);
    assert.equal(await auditCount(), auditsBefore);
  });
});
