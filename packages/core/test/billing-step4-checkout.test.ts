/**
 * Billing Step 4 — checkout compatibility against epochs registered through
 * the provisioning workflow.
 *
 * Step 4 added a NEW way to register epochs (the authorized sandbox
 * provisioning workflow) and repaired the epoch-store register/retire paths.
 * These tests pin that the chain
 *
 *     catalogue → provisioned epoch → pinned FX version → pricing snapshot
 *       → subscription pricing lock → provider checkout request
 *
 * behaves exactly as the existing design demands (D-1 … D-9), and that nothing
 * about checkout, locking or the fail-closed posture changed:
 *  - each marketed combination checks out against ITS epoch and amount;
 *  - a newer FX version never reprices a registered epoch, and the epoch's
 *    (older) FX version stays usable at checkout (D-9);
 *  - a missing, retired or arithmetically incoherent epoch fails closed;
 *  - the excluded GHS 2.00 evidence plan is still refused by checkout itself;
 *  - an existing locked subscription bypasses new epoch selection entirely,
 *    and a NULL lock stays `pricing_lock_required` (D-1, D-8).
 *
 * The provisioning flow itself never calls a provider; these tests assert only
 * on local state and an injected provider stub (which records requests instead
 * of opening a socket).
 */
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  BillingCheckoutService,
  BillingFxRateVersionStore,
  BillingPlanProvisioningService,
  BillingPricingSnapshotStore,
  createBillingProviderRegistry,
  createFreeSubscription,
  createUnimplementedBillingProvider,
  cataloguePriceMinor,
  computePaymentAmountMinor,
  providerIntervalForBillingInterval,
  UserService,
  verifyPricingSnapshot,
  type BillingCheckoutRequest,
} from '../src/index.js';
import {
  startBillingTestDb,
  insertEpoch,
  insertFx,
  insertUser,
  retireActiveEpochs,
  retireEpoch,
  AS_OF,
} from './helpers/billing-checkout.js';

const DB_PORT = 5496;
const ELITE_ANNUAL = { cataloguePlan: 'elite', interval: 'annual' } as const;
const EXCLUDED_EVIDENCE_PLAN = ['PLN', 'u0l4961hhipl6ek'].join('_');

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let calls: BillingCheckoutRequest[];
let service: BillingCheckoutService;
before(async () => {
  db = await startBillingTestDb(DB_PORT);
}, { timeout: 180_000 });
beforeEach(async () => {
  await retireActiveEpochs(db.pool);
  calls = [];
  const providers = createBillingProviderRegistry();
  providers.register({
    ...createUnimplementedBillingProvider(),
    async initializeCheckout(request) {
      calls.push(request);
      const snapshot = verifyPricingSnapshot(request.pricing);
      return {
        provider: 'paystack',
        status: 'initialized',
        reference: request.reference,
        providerReference: request.reference,
        authorizationUrl: 'https://checkout.example.test/authorize',
        amountMinor: snapshot.commercialAmountMinor,
        currency: 'USD',
        payment: snapshot.payment,
        pricing: snapshot,
        idempotencyKey: request.idempotencyKey,
        initializedAt: AS_OF.toISOString(),
      };
    },
  });
  service = new BillingCheckoutService({
    db: db.pool,
    providers,
    callbackUrl: 'https://app.example.test/settings',
    now: () => AS_OF,
    requireExistingCustomer: async () => {}, // Directory/adapter coverage lives in the API suite.
  });
});
after(async () => {
  await db?.stop();
});

/* -------------------------------------------------------------------------- */
/* Provision the four sandbox epochs through the Step 4 workflow               */
/* -------------------------------------------------------------------------- */

type Combo = 'pro/monthly' | 'pro/annual' | 'elite/monthly' | 'elite/annual';

async function provisionSandboxEpochs(rateScaled = 12_500_000n) {
  const registeredAt = new Date();
  const fx = await new BillingFxRateVersionStore(db.pool).publish({
    fxRateScaled: rateScaled,
    fxRateScale: 6,
    effectiveFrom: new Date(registeredAt.getTime() - 300_000),
    capturedAt: new Date(registeredAt.getTime() - 300_000),
    source: 'ops',
    sourceReference: 'ops-sandbox-fx-1',
    createdBy: 'ops@example.com',
  });
  const combos: ReadonlyArray<['pro' | 'elite', 'monthly' | 'annual']> = [
    ['pro', 'monthly'],
    ['pro', 'annual'],
    ['elite', 'monthly'],
    ['elite', 'annual'],
  ];
  const codes = {} as Record<Combo, string>;
  const evidence = combos.map(([plan, interval]) => {
    const code = `PLN_${randomUUID().replaceAll('-', '')}`;
    codes[`${plan}/${interval}` as Combo] = code;
    return {
      cataloguePlan: plan,
      interval,
      providerInterval: providerIntervalForBillingInterval(interval),
      providerPlanId: code,
      paymentCurrency: 'GHS',
      paymentAmountMinor: computePaymentAmountMinor({
        usdMinor: BigInt(cataloguePriceMinor(plan, interval)),
        rateScaled: fx.fxRateScaled,
        rateScale: fx.fxRateScale,
      }),
      paymentAmountExponent: 2,
      mode: 'test',
      paymentCountCap: 'uncapped',
      evidenceReference: 'ops-sandbox-evidence-2026-09-22',
    };
  });
  const provisioningService = new BillingPlanProvisioningService({ db: db.pool, now: () => registeredAt });
  const epochs = await provisioningService.registerSandboxPlanEpochs({
    fxRateVersionId: fx.id,
    evidence,
  });
  return { fx, epochs, codes };
}

const reason = (expected: string) => (error: unknown) =>
  (error as { reason?: string }).reason === expected;

/** The derived GHS (pesewa) amounts at the default 12.5 GHS/USD sandbox rate. */
const EXPECTED_PAYMENT: Readonly<Record<Combo, number>> = {
  'pro/monthly': 48_750,
  'pro/annual': 487_500,
  'elite/monthly': 123_750,
  'elite/annual': 1_237_500,
};

/* -------------------------------------------------------------------------- */
/* F. Checkout against the provisioned epochs                                  */
/* -------------------------------------------------------------------------- */

test('a missing epoch fails closed (before provisioning exists)', async () => {
  // First test in the file: billing_provider_plans holds no active epoch here.
  const user = await insertUser(db.pool);
  await assert.rejects(service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' }), reason('plan_not_registered'));
  assert.equal(calls.length, 0, 'fail closed before the provider is ever called');
});

test('each combination checks out against its provisioned epoch, amount and provider plan', async () => {
  const { fx, codes } = await provisionSandboxEpochs();
  for (const [combo, expectedAmount] of Object.entries(EXPECTED_PAYMENT) as Array<[Combo, number]>) {
    const [cataloguePlan, interval] = combo.split('/') as ['pro' | 'elite', 'monthly' | 'annual'];
    const user = await insertUser(db.pool);
    const session = await service.checkout(user.id, { cataloguePlan, interval });

    assert.equal(session.payment?.paymentAmountMinor, expectedAmount, `${combo} pays the epoch amount`);
    assert.equal(session.payment?.paymentCurrency, 'GHS');
    assert.equal(session.pricing?.fx.fxRateVersionId, fx.id, 'the snapshot pins the epoch FX version');
    assert.equal(session.pricing?.providerPlanId, codes[combo], 'the request carries the epoch provider plan');
    assert.equal(session.pricing?.commercialAmountMinor, cataloguePriceMinor(cataloguePlan, interval), 'USD stays the catalogue (D-5)');

    const { rows } = await db.pool.query(
      `SELECT plan, provider, currency, catalogue_plan, billing_interval, provider_plan_id, locked_pricing_snapshot_id
         FROM subscriptions WHERE user_id = $1`,
      [user.id],
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row['provider'], 'paystack');
    assert.equal(row['currency'], 'USD', 'the commercial currency never moves (0032)');
    assert.equal(row['plan'], cataloguePlan === 'pro' ? 'pro' : 'premium', 'the canonical internal mapping');
    assert.equal(row['catalogue_plan'], cataloguePlan);
    assert.equal(row['billing_interval'], interval);
    assert.equal(row['provider_plan_id'], codes[combo]);
    const stored = await new BillingPricingSnapshotStore(db.pool).findById(row['locked_pricing_snapshot_id']);
    assert.equal(stored?.snapshot.payment.paymentAmountMinor, expectedAmount, 'the lock stores the same authorized amount');
    assert.equal(stored?.idempotencyKey, session.idempotencyKey);
  }
});

test('a newer FX version never reprices a provisioned epoch, and the epoch FX stays usable', async () => {
  const { fx } = await provisionSandboxEpochs();
  await insertFx(db.pool, 20_000_000); // a newer, very different rate is now the newest

  const user = await insertUser(db.pool);
  const session = await service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' });
  assert.equal(session.payment?.paymentAmountMinor, 48_750, 'still the provisioned 12.5-derived amount');
  assert.equal(session.pricing?.fx.fxRateVersionId, fx.id, 'the epoch FX version — never "latest FX"');
  assert.equal(session.pricing?.fx.fxRateScaled, 12_500_000);
});

test('a retired epoch fails closed for a new checkout', async () => {
  await provisionSandboxEpochs();
  const { rows } = await db.pool.query(
    "SELECT id FROM billing_provider_plans WHERE catalogue_plan = 'pro' AND billing_interval = 'monthly' AND status = 'active'",
  );
  await retireEpoch(db.pool, rows[0]!['id']);

  const user = await insertUser(db.pool);
  await assert.rejects(service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' }), reason('retired'));
  assert.equal(calls.length, 0);
});

test('an epoch whose stored facts do not verify arithmetically fails closed', async () => {
  // Not provisioned: a hand-inserted inconsistent epoch (amount ≠ catalogue × FX).
  await insertEpoch(db.pool, { amount: 48_751 });
  const user = await insertUser(db.pool);
  await assert.rejects(service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' }), reason('invalid_snapshot'));
  assert.equal(calls.length, 0);
});

test('the excluded GHS 2.00 evidence plan is refused by checkout itself', async () => {
  // The provisioning workflow refuses to register it; this pins the INDEPENDENT
  // checkout-side exclusion that never reached through provisioning (regression).
  await insertEpoch(db.pool, { providerPlanId: EXCLUDED_EVIDENCE_PLAN });
  const user = await insertUser(db.pool);
  await assert.rejects(service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' }), reason('forbidden_plan'));
  assert.equal(calls.length, 0);
});

test('an existing locked subscription bypasses new epochs and later FX entirely', async () => {
  const first = await provisionSandboxEpochs();
  const user = await insertUser(db.pool);
  const firstSession = await service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' });
  const lockBefore = await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id]);

  // Rotate everything a new sale would see: retire the epochs, provision a
  // second batch at a different rate, and let yet another FX version exist.
  await retireActiveEpochs(db.pool);
  await provisionSandboxEpochs(20_000_000n);
  await insertFx(db.pool, 30_000_000);

  // Even a request for a DIFFERENT plan keeps the locked decision (D-1, D-8).
  const again = await service.checkout(user.id, ELITE_ANNUAL);
  assert.deepEqual(again, firstSession, 'the locked checkout is byte-identical');
  assert.deepEqual((await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id])).rows, lockBefore.rows);
  assert.equal(again.payment?.paymentAmountMinor, 48_750);
  assert.equal(again.pricing?.fx.fxRateVersionId, first.fx.id, 'the lock still pins the ORIGINAL epoch FX');
  assert.equal(calls.length, 2);
});

test('a NULL lock stays pricing_lock_required — provisioning never upgrades it', async () => {
  await provisionSandboxEpochs();
  const user = await insertUser(db.pool);
  // Model C: a registration-created user has no row at all, so the legacy
  // NULL-lock shape is seeded explicitly. Provisioning an epoch registers
  // pricing authority for NEW sales only; it never repairs this row.
  await createFreeSubscription(db.pool, user.id);
  await assert.rejects(service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' }), reason('pricing_lock_required'));
  assert.equal(calls.length, 0);
});

test('Model C: a registered (row-less) user checks out against a provisioned epoch', async () => {
  const { codes } = await provisionSandboxEpochs();
  // Real registration path: identity only, no billing subscription row.
  const user = await new UserService(db.pool).create({
    email: `step4-model-c-${randomUUID()}@example.test`, passwordHash: 'x'.repeat(32), name: 'Step 4 Model C',
  });
  assert.equal(
    (await db.pool.query('SELECT count(*)::int AS c FROM subscriptions WHERE user_id=$1', [user.id])).rows[0]!['c'],
    0, 'registration provisions nothing',
  );

  const session = await service.checkout(user.id, { cataloguePlan: 'pro', interval: 'monthly' });
  assert.equal(session.payment?.paymentAmountMinor, 48_750);
  assert.equal(session.pricing?.providerPlanId, codes['pro/monthly']);
  const { rows } = await db.pool.query(
    `SELECT plan, provider, catalogue_plan, billing_interval, provider_plan_id, locked_pricing_snapshot_id
       FROM subscriptions WHERE user_id = $1`,
    [user.id],
  );
  assert.equal(rows.length, 1, 'the commercial subscription is created exactly once');
  assert.equal(rows[0]!['provider'], 'paystack');
  assert.equal(rows[0]!['plan'], 'pro');
  assert.equal(rows[0]!['catalogue_plan'], 'pro');
  assert.equal(rows[0]!['billing_interval'], 'monthly');
  assert.ok(rows[0]!['locked_pricing_snapshot_id'], 'the lock is created with the sold subscription');
  assert.equal(calls.length, 1);
});
