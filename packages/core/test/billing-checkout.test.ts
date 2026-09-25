import { after, before, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  BillingCheckoutService, BillingPricingSnapshotStore, BillingProviderPlanStore,
  createBillingProviderRegistry, createUnimplementedBillingProvider, createFreeSubscription,
  billingCheckoutReference, pricingIdempotencyKey, verifyPricingSnapshot,
  FREE_ENTITLEMENTS, UserService, getBillingState,
  type BillingCheckoutRequest,
} from '../src/index.js';
import {
  startBillingTestDb, insertEpoch, insertFx, insertUser, retireActiveEpochs,
  retireEpoch, deriveSnapshot, PRO_MONTHLY, AS_OF,
} from './helpers/billing-checkout.js';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let calls: BillingCheckoutRequest[];
let service: BillingCheckoutService;
const reason = (expected: string) => (error: unknown) => (error as { reason?: string }).reason === expected;
/** Every pricing decision ever persisted, linked or not. */
const snapshotCount = async () => (await db.pool.query('SELECT count(*)::int AS c FROM billing_pricing_snapshots')).rows[0].c as number;
/** Pricing decisions no sold subscription points at — the orphan the blocker left. */
const orphanSnapshotCount = async () => (await db.pool.query(
  'SELECT count(*)::int AS c FROM billing_pricing_snapshots s'
  + ' WHERE NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.locked_pricing_snapshot_id = s.id)',
)).rows[0].c as number;
before(async () => { db = await startBillingTestDb(5491); }, { timeout: 180_000 });
after(async () => { await db?.stop(); });
beforeEach(async () => {
  await retireActiveEpochs(db.pool);
  calls = [];
  const providers = createBillingProviderRegistry();
  providers.register({ ...createUnimplementedBillingProvider(), async initializeCheckout(request) {
    calls.push(request);
    const snapshot = verifyPricingSnapshot(request.pricing);
    return {
      provider: 'paystack', status: 'initialized', reference: request.reference,
      providerReference: request.reference, authorizationUrl: 'https://checkout.example.test/authorize',
      amountMinor: snapshot.commercialAmountMinor, currency: 'USD',
      payment: snapshot.payment, pricing: snapshot, idempotencyKey: request.idempotencyKey,
      initializedAt: AS_OF.toISOString(),
    };
  } });
  service = new BillingCheckoutService({
    db: db.pool, providers, callbackUrl: 'https://app.example.test/settings', now: () => AS_OF,
    requireExistingCustomer: async () => {}, // Actual directory/adapter covered by the API suite.
  });
});

test('active epoch selects exact stale FX version, persists once, and INSERTs active/pending lock', async () => {
  const facts = await insertEpoch(db.pool);
  await insertFx(db.pool, 20_000_000); // Must not resolve the newest FX.
  const user = await insertUser(db.pool);
  const session = await service.checkout(user.id, PRO_MONTHLY);
  assert.deepEqual(session.pricing, deriveSnapshot(facts));
  assert.equal(session.payment?.paymentAmountMinor, 48_750);
  const { rows } = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  assert.equal(rows.length, 1, 'exactly one commercial subscription row exists');
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].provider_state, 'pending');
  assert.equal(rows[0].provider, 'paystack');
  assert.equal(rows[0].currency, 'USD');
  assert.equal(rows[0].plan, 'pro');
  assert.equal(rows[0].provider_plan_id, facts.epoch.provider_plan_id);
  const stored = await new BillingPricingSnapshotStore(db.pool).findById(rows[0].locked_pricing_snapshot_id);
  assert.deepEqual(stored?.snapshot, session.pricing);
  assert.equal(stored?.idempotencyKey, session.idempotencyKey);
  assert.equal(calls.length, 1);
});

test('elite annual uses canonical premium mapping', async () => {
  await insertEpoch(db.pool, { plan: 'elite', interval: 'annual' });
  const user = await insertUser(db.pool);
  const session = await service.checkout(user.id, { cataloguePlan: 'elite', interval: 'annual' });
  assert.equal(session.pricing?.cataloguePlan, 'elite');
  const result = await db.pool.query('SELECT plan FROM subscriptions WHERE user_id=$1', [user.id]);
  assert.equal(result.rows[0].plan, 'premium');
});

test('missing, retired-only and ambiguous epochs fail closed without provider calls', async (t) => {
  // No annual epoch has ever existed in this suite for Pro.
  const user = await insertUser(db.pool);
  await assert.rejects(service.checkout(user.id, { ...PRO_MONTHLY, interval: 'annual' }), reason('plan_not_registered'));
  const facts = await insertEpoch(db.pool);
  await retireEpoch(db.pool, facts.epoch.id);
  await assert.rejects(service.checkout(user.id, PRO_MONTHLY), reason('retired'));
  // DB uniqueness prevents real ambiguity. Fault-inject duplicate rows at the
  // store boundary without dropping the index or changing selection semantics.
  const originalQuery = db.pool.query.bind(db.pool);
  t.mock.method(db.pool, 'query', ((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM billing_provider_plans')) {
      return Promise.resolve({ rows: [facts.epoch, { ...facts.epoch, id: randomUUID() }]
        .map((row) => ({ ...row, status: 'active' })) });
    }
    return originalQuery(sql, params);
  }) as typeof db.pool.query);
  await assert.rejects(service.checkout(user.id, PRO_MONTHLY), reason('ambiguous'));
  assert.equal(calls.length, 0);
});

test('MODEL C: registration creates no subscription row; the free fallback is the missing row', async () => {
  const before = await db.pool.query('SELECT count(*)::int AS c FROM billing_pricing_snapshots');
  const user = await new UserService(db.pool).create({
    email: `model-c-${randomUUID()}@example.test`, passwordHash: 'x'.repeat(32), name: 'Model C user',
  });

  // Registration is identity only: the same user, the unchanged users.plan
  // default, and NO billing provisioning of any kind.
  assert.equal(user.plan, 'free');
  assert.equal(
    (await db.pool.query('SELECT plan FROM users WHERE id=$1', [user.id])).rows[0].plan, 'free',
  );
  const rows = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  assert.equal(rows.rowCount, 0, 'registration must not create a subscriptions row');
  assert.deepEqual(
    (await db.pool.query('SELECT count(*)::int AS c FROM billing_pricing_snapshots')).rows,
    before.rows, 'registration writes no pricing state either',
  );

  // The missing row IS the supported free state: free/active, unconfirmed, no
  // commercial entitlement and no automation, with no row invented to say so.
  const state = await getBillingState(db.pool, user.id);
  assert.equal(state.subscription.plan, 'free');
  assert.equal(state.subscription.status, 'active');
  assert.deepEqual(state.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
  assert.deepEqual(state.entitlements, FREE_ENTITLEMENTS);
  assert.equal(state.entitlements.canAccessAutomation, false);

  // ...and the FIRST commercial checkout is the one path that creates the sold
  // subscription together with its immutable pricing lock, atomically.
  const facts = await insertEpoch(db.pool);
  const snapshotsBefore = await snapshotCount();
  const session = await service.checkout(user.id, PRO_MONTHLY);
  assert.deepEqual(session.pricing, deriveSnapshot(facts));
  const created = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  assert.equal(created.rowCount, 1, 'exactly one commercial subscription');
  assert.equal(
    await snapshotCount(), snapshotsBefore + 1,
    'exactly one pricing snapshot is persisted, and it is the one the sale locked',
  );
  assert.equal(created.rows[0].plan, 'pro');
  assert.equal(created.rows[0].provider, 'paystack');
  assert.equal(created.rows[0].provider_state, 'pending');
  assert.equal(created.rows[0].provider_plan_id, facts.epoch.provider_plan_id);
  assert.ok(created.rows[0].locked_pricing_snapshot_id, 'the lock is written with the subscription');
  const stored = await new BillingPricingSnapshotStore(db.pool).findById(created.rows[0].locked_pricing_snapshot_id);
  assert.deepEqual(stored?.snapshot, session.pricing);
  // The lock is a pricing fact only: the row it belongs to is still unconfirmed
  // and grants nothing.
  assert.equal((await getBillingState(db.pool, user.id)).providerStatus.paymentConfirmed, false);
  assert.deepEqual((await getBillingState(db.pool, user.id)).entitlements, FREE_ENTITLEMENTS);
  assert.equal(calls.length, 1);
});

test('NULL lock refuses before epoch lookup and leaves the entire subscription unchanged', async () => {
  const user = await insertUser(db.pool);
  // The LEGACY shape (what registration used to create) is modelled explicitly;
  // it stays fail-closed and is never upgraded by checkout.
  await createFreeSubscription(db.pool, user.id);
  const read = () => db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
  const snapshotsBefore = await snapshotCount();
  const before = await read();
  const find = mock.method(BillingProviderPlanStore.prototype, 'findActive', async () => { throw new Error('must not price'); });
  try {
    await assert.rejects(service.checkout(user.id, PRO_MONTHLY), reason('pricing_lock_required'));
    assert.deepEqual((await read()).rows, before.rows);
    assert.equal(await snapshotCount(), snapshotsBefore, 'the NULL-lock refusal prices nothing');
    assert.equal(find.mock.callCount(), 0);
    assert.equal(calls.length, 0);
  } finally { find.mock.restore(); }
});

test('locked A wins over requested plan, rotation B, and later FX; reference and snapshot stay identical', async () => {
  const facts = await insertEpoch(db.pool);
  const oldUser = await insertUser(db.pool);
  const first = await service.checkout(oldUser.id, PRO_MONTHLY);
  const lockBefore = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [oldUser.id]);
  await retireEpoch(db.pool, facts.epoch.id);
  const newer = await insertEpoch(db.pool, { rateScaled: 20_000_000 });
  await insertFx(db.pool, 25_000_000);
  const retry = await service.checkout(oldUser.id, { cataloguePlan: 'elite', interval: 'annual' });
  assert.deepEqual(retry, first);
  assert.deepEqual((await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [oldUser.id])).rows, lockBefore.rows);
  verifyPricingSnapshot(retry.pricing);
  // Mock provider here only observes historical selection; real adapter's
  // mandatory retired-plan rejection is tested through API composition.
  const newUser = await insertUser(db.pool);
  const fresh = await service.checkout(newUser.id, PRO_MONTHLY);
  assert.deepEqual(fresh.pricing, deriveSnapshot(newer));
  assert.equal(fresh.payment?.paymentAmountMinor, 78_000);
  assert.notEqual(fresh.reference, first.reference);
});

test('an existing lock does not consult active epochs or FX at all', async () => {
  await insertEpoch(db.pool);
  const user = await insertUser(db.pool);
  const first = await service.checkout(user.id, PRO_MONTHLY);
  const find = mock.method(BillingProviderPlanStore.prototype, 'findActive', async () => { throw new Error('must not reprice'); });
  try {
    const second = await service.checkout(user.id, PRO_MONTHLY);
    assert.deepEqual(second, first);
    assert.equal(find.mock.callCount(), 0);
  } finally { find.mock.restore(); }
});

test('concurrent absent-row checkouts with different candidates use one winning immutable lock and leave no orphaned snapshot', async () => {
  await insertEpoch(db.pool);
  await insertEpoch(db.pool, { plan: 'elite' });
  const user = await insertUser(db.pool);
  const snapshotsBefore = await snapshotCount();
  const orphansBefore = await orphanSnapshotCount();
  // Barrier on the PRICING DERIVATION, before any transaction exists: every
  // request has independently derived its candidate (three price Pro/monthly,
  // three price Elite/monthly) BEFORE any of them tries to INSERT, so this is
  // a real UNIQUE(user_id) race between six simultaneous first checkouts.
  const original = BillingProviderPlanStore.prototype.findActive;
  let ready = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const findActive = mock.method(BillingProviderPlanStore.prototype, 'findActive', async function (
    this: BillingProviderPlanStore, ...args: Parameters<typeof original>
  ) {
    if (++ready === 6) release();
    await barrier;
    return original.apply(this, args);
  });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, n) => service.checkout(user.id, {
      cataloguePlan: n % 2 ? 'pro' : 'elite', interval: 'monthly',
    })));
    for (const result of results) assert.deepEqual(result, results[0]);
    const rows = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
    assert.equal(rows.rowCount, 1, 'exactly one winning commercial subscription');
    assert.equal(calls.length, 6);
    assert.equal(ready, 6, 'every candidate was derived before any INSERT');
    // ATOMICITY: the five losing candidates are discarded together with their
    // own attempts. The only pricing decision that survives is the winner's,
    // and it is exactly the one the immutable lock points at: no unlinked
    // append-only snapshot is left behind by a losing checkout.
    assert.equal(await snapshotCount(), snapshotsBefore + 1, 'exactly one pricing snapshot survives the race');
    assert.equal(await orphanSnapshotCount(), orphansBefore, 'no new unlinked pricing decision');
    const stored = await new BillingPricingSnapshotStore(db.pool).findById(rows.rows[0].locked_pricing_snapshot_id);
    assert.deepEqual(stored?.snapshot, results[0]!.pricing, 'the lock points at the surviving snapshot');
    assert.ok(['pro', 'elite'].includes(stored!.snapshot.cataloguePlan));
  } finally { findActive.mock.restore(); }
});

test('a database failure after the snapshot INSERT rolls snapshot, subscription and lock back together', async () => {
  await insertEpoch(db.pool);
  const user = await insertUser(db.pool);
  const snapshotsBefore = await snapshotCount();
  // A REAL database failure, injected at the point the blocker cares about:
  // the snapshot row already exists inside the transaction and the sold
  // subscription INSERT is then refused by a temporary AFTER INSERT trigger.
  // Test-only object: no migration, no product object, dropped below.
  await db.pool.query(`CREATE FUNCTION billing_test_refuse_sale() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected: sold subscription refused'; END $$;`);
  await db.pool.query(`CREATE TRIGGER billing_test_refuse_sale AFTER INSERT ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION billing_test_refuse_sale();`);
  try {
    await assert.rejects(service.checkout(user.id, PRO_MONTHLY), /injected: sold subscription refused/);
  } finally {
    await db.pool.query('DROP TRIGGER IF EXISTS billing_test_refuse_sale ON subscriptions');
    await db.pool.query('DROP FUNCTION IF EXISTS billing_test_refuse_sale()');
  }
  assert.equal(
    (await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id])).rowCount, 0,
    'no commercial subscription survives the failed transaction',
  );
  assert.equal(
    (await db.pool.query(
      'SELECT count(*)::int AS c FROM subscriptions WHERE user_id=$1 AND locked_pricing_snapshot_id IS NOT NULL',
      [user.id],
    )).rows[0].c, 0, 'no pricing lock survives',
  );
  assert.equal(await snapshotCount(), snapshotsBefore, 'the snapshot INSERT was rolled back with it');
  assert.equal(calls.length, 0);
});

test('a refusal after BOTH writes and before COMMIT still discards the snapshot', async () => {
  await insertEpoch(db.pool);
  const user = await insertUser(db.pool);
  const snapshotsBefore = await snapshotCount();
  // The in-transaction re-read of the persisted snapshot runs AFTER the
  // snapshot INSERT and the subscription INSERT and BEFORE COMMIT: refusing it
  // proves both already-written rows are discarded, not merely left unlinked.
  const findById = mock.method(BillingPricingSnapshotStore.prototype, 'findById', async () => {
    throw new Error('injected: persisted snapshot refused before COMMIT');
  });
  try {
    await assert.rejects(service.checkout(user.id, PRO_MONTHLY), /injected: persisted snapshot refused before COMMIT/);
  } finally { findById.mock.restore(); }
  assert.equal(
    (await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id])).rowCount, 0,
    'the sold subscription is gone',
  );
  assert.equal(await snapshotCount(), snapshotsBefore, 'the snapshot is gone with it');
  assert.equal(calls.length, 0);
});

test('a concurrent free-subscription INSERT wins without any NULL-lock mutation', async () => {
  // Simulates a LEGACY (pre-Model-C) free row racing the first checkout: the
  // row wins the UNIQUE(user_id) race and the checkout fails closed.
  await insertEpoch(db.pool);
  const user = await insertUser(db.pool);
  const snapshotsBefore = await snapshotCount();
  const original = BillingPricingSnapshotStore.prototype.create;
  const create = mock.method(BillingPricingSnapshotStore.prototype, 'create', async function (
    this: BillingPricingSnapshotStore, ...args: Parameters<typeof original>
  ) {
    const snapshot = await original.apply(this, args);
    await createFreeSubscription(db.pool, user.id);
    return snapshot;
  });
  try {
    await assert.rejects(service.checkout(user.id, PRO_MONTHLY), reason('pricing_lock_required'));
    assert.equal(calls.length, 0);
    const result = await db.pool.query('SELECT plan, locked_pricing_snapshot_id, state_version FROM subscriptions WHERE user_id=$1', [user.id]);
    assert.deepEqual(result.rows[0], { plan: 'free', locked_pricing_snapshot_id: null, state_version: 1 });
    // The candidate this attempt priced is discarded with the failed sale: the
    // losing checkout leaves no unlinked snapshot behind it either.
    assert.equal(await snapshotCount(), snapshotsBefore);
  } finally { create.mock.restore(); }
});

test('a sneaked excluded epoch never persists a checkout authorization', async () => {
  const excluded = ['PLN', 'u0l4961hhipl6ek'].join('_');
  for (const providerPlanId of [excluded, ` ${excluded} `]) {
    const facts = await insertEpoch(db.pool, { providerPlanId });
    const user = await insertUser(db.pool);
    const before = await db.pool.query('SELECT count(*) FROM billing_pricing_snapshots');
    await assert.rejects(service.checkout(user.id, PRO_MONTHLY), reason('forbidden_plan'));
    assert.deepEqual((await db.pool.query('SELECT count(*) FROM billing_pricing_snapshots')).rows, before.rows);
    assert.equal((await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.id])).rowCount, 0);
    assert.equal(calls.length, 0);
    await retireEpoch(db.pool, facts.epoch.id);
  }
});

test('rejects starter, unknown interval and client pricing/callback/user fields', async () => {
  await insertEpoch(db.pool);
  const user = await insertUser(db.pool);
  for (const input of [
    { ...PRO_MONTHLY, cataloguePlan: 'starter' }, { ...PRO_MONTHLY, interval: 'weekly' },
    { ...PRO_MONTHLY, callbackUrl: 'https://evil.example.test' }, { ...PRO_MONTHLY, userId: randomUUID() },
    { ...PRO_MONTHLY, amount: 1 },
    // The client cannot supply the pricing decision itself — not the snapshot,
    // not the FX facts, not the amount, not the provider plan identity.
    { ...PRO_MONTHLY, pricing: { paymentAmountMinor: 1 } },
    { ...PRO_MONTHLY, lockedPricingSnapshotId: randomUUID() },
    { ...PRO_MONTHLY, fxRateScaled: 1, fxRateScale: 6 },
    { ...PRO_MONTHLY, providerPlanId: 'PLN_client_supplied' },
    { ...PRO_MONTHLY, payment: { paymentAmountMinor: 1, paymentCurrency: 'GHS', paymentAmountExponent: 2 } },
  ]) await assert.rejects(service.checkout(user.id, input));
  assert.equal(calls.length, 0);
});

test('reference is deterministic, schema-compatible, user-specific and contains no raw identity', () => {
  const user = randomUUID(), id = 'a'.repeat(64);
  const ref = billingCheckoutReference(user, id);
  assert.equal(ref, billingCheckoutReference(user, id));
  assert.match(ref, /^ve-chk-[0-9a-f]{64}$/);
  assert.ok(!ref.includes(user));
  assert.notEqual(ref, billingCheckoutReference(randomUUID(), id));
  assert.notEqual(ref, billingCheckoutReference(user, 'b'.repeat(64)));
});

test('epoch pricing is the only calculation seam; no subscription UPDATE, DELETE, or idempotency model', () => {
  const source = readFileSync(new URL('../src/billing/checkout.ts', import.meta.url), 'utf8');
  assert.match(source, /priceFromProviderPlanEpoch\(/);
  assert.doesNotMatch(source, /priceCommercialPlan|Date\.now|randomUUID|UPDATE subscriptions|DELETE FROM subscriptions/);
  assert.match(source, /WHERE id = \$1.*epoch\.fxRateVersionId/);
  assert.match(source, /ON CONFLICT \(user_id\) DO NOTHING/);
  // ATOMICITY: the snapshot is persisted inside the subscription/lock
  // transaction, on that transaction's own client — never on the pool, and
  // never before the transaction opens.
  assert.doesNotMatch(source, /new BillingPricingSnapshotStore\(db\)\.create\(/);
  assert.match(source, /new BillingPricingSnapshotStore\(client\)\.create\(/);
  assert.match(source, /SAVEPOINT billing_pricing_snapshot/);
  assert.match(source, /ROLLBACK TO SAVEPOINT billing_pricing_snapshot/);
  const persistence = readFileSync(new URL('../src/billing/snapshots.ts', import.meta.url), 'utf8');
  assert.match(persistence, /pricingIdempotencyKey\(s\)/);
  assert.match(persistence, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
});

test('stored tampering fails verification before provider call', async () => {
  const facts = await insertEpoch(db.pool);
  const stored = await new BillingPricingSnapshotStore(db.pool).create(deriveSnapshot(facts));
  const user = await insertUser(db.pool);
  // A deliberately incoherent append-only audit row: SQL enforces FX identity,
  // while verifyPricingSnapshot owns arithmetic. No invariant is disabled.
  const { rows } = await db.pool.query(`INSERT INTO billing_pricing_snapshots (
    commercial_currency,commercial_amount_minor,catalogue_plan,billing_interval,catalogue_version,
    payment_currency,payment_amount_minor,payment_amount_exponent,fx_rate_scaled,fx_rate_scale,
    fx_rate_version_id,fx_rate_effective_from,fx_rate_captured_at,fx_rate_source,rounding_mode,
    pricing_policy_version,provider_plan_id,idempotency_key,created_at)
    SELECT commercial_currency,commercial_amount_minor,catalogue_plan,billing_interval,catalogue_version,
    payment_currency,payment_amount_minor+1,payment_amount_exponent,fx_rate_scaled,fx_rate_scale,
    fx_rate_version_id,fx_rate_effective_from,fx_rate_captured_at,fx_rate_source,rounding_mode,
    pricing_policy_version,provider_plan_id,$2,created_at FROM billing_pricing_snapshots WHERE id=$1 RETURNING id`,
  [stored.id, pricingIdempotencyKey({ ...stored.snapshot, payment: { ...stored.snapshot.payment, paymentAmountMinor: 48_751 } })]);
  await db.pool.query(`INSERT INTO subscriptions(user_id,plan,provider,catalogue_plan,billing_interval,provider_plan_id,locked_pricing_snapshot_id)
    VALUES($1,'pro','paystack','pro','monthly',$2,$3)`, [user.id, facts.epoch.provider_plan_id, rows[0].id]);
  await assert.rejects(service.checkout(user.id, PRO_MONTHLY), reason('invalid_snapshot'));
  assert.equal(calls.length, 0);
});
