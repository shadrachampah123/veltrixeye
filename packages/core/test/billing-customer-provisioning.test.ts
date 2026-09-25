import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  BILLING_CUSTOMER_STATUSES,
  billingCustomerProvisioningResultSchema,
  type BillingCustomerIdentity,
} from '@veltrixeye/contracts';
import {
  BILLING_CUSTOMER_PROVISIONING_ERROR_REASONS,
  BillingCustomerService,
  FREE_ENTITLEMENTS,
  billingCustomerCreateKey,
  createBillingProviderRegistry,
  createUnimplementedBillingProvider,
  decideExistingBillingCustomer,
  getBillingState,
  isBillingCustomerProvisioningError,
  isCheckoutReadyBillingCustomer,
  usableProviderCustomerIdentity,
  type BillingCustomerCreateRequest,
  type BillingCustomerQuery,
  type BillingCustomerRow,
} from '../src/index.js';
import { insertUser, startBillingTestDb } from './helpers/billing-checkout.js';

/* ==========================================================================
   Billing Step 6 (roadmap item 8a) — BillingCustomerService against a REAL
   database (embedded PG, migrations 0001–0032; no new migration).

   The provider is a stub behind the canonical seam (findCustomer /
   createCustomer), so every provider outcome — found, created, failure,
   malformed — can be exercised without any network. The actual Paystack
   adapter with a fake transport is exercised end-to-end in
   apps/api/test/billing-customer.test.ts.
   ========================================================================== */

const NOW = new Date('2026-09-24T10:00:00.000Z');

let db: Awaited<ReturnType<typeof startBillingTestDb>>;

before(async () => {
  db = await startBillingTestDb(5521);
}, { timeout: 180_000 });
after(async () => { await db?.stop(); });

type Finder = (request: BillingCustomerQuery) => Promise<BillingCustomerIdentity | null>;
type Creator = (request: BillingCustomerCreateRequest) => Promise<BillingCustomerIdentity>;

interface Calls { find: BillingCustomerQuery[]; create: BillingCustomerCreateRequest[] }
let calls: Calls;
beforeEach(() => { calls = { find: [], create: [] }; });

let codeSequence = 0;
const newCode = () => `CUS_${(codeSequence++).toString().padStart(4, '0')}${randomUUID().replaceAll('-', '').slice(0, 10)}`;

/** A canonical identity exactly as the Paystack adapter would return it. */
function identity(request: { userId: string; email: string }, overrides: Partial<BillingCustomerIdentity> = {}): BillingCustomerIdentity {
  return {
    id: randomUUID(),
    userId: request.userId,
    provider: 'paystack',
    email: request.email,
    providerCustomerId: String(100_000 + codeSequence),
    providerCustomerCode: newCode(),
    status: 'provisioned',
    lastReference: null,
    provisionedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function serviceWith(options: { find?: Finder; create?: Creator; registered?: boolean } = {}) {
  const registry = createBillingProviderRegistry();
  if (options.registered !== false) {
    registry.register({
      ...createUnimplementedBillingProvider(),
      findCustomer: async (request: BillingCustomerQuery) => {
        calls.find.push(request);
        return (options.find ?? (async () => null))(request);
      },
      createCustomer: async (request: BillingCustomerCreateRequest) => {
        calls.create.push(request);
        return (options.create ?? (async (r) => identity(r)))(request);
      },
    });
  }
  return new BillingCustomerService({ db: db.pool, providers: registry, now: () => NOW });
}

const customerRows = async (userId: string) =>
  (await db.pool.query('SELECT * FROM billing_customers WHERE user_id = $1', [userId])).rows as Record<string, unknown>[];

const snapshotOf = async (userId: string) => ({
  customers: await customerRows(userId),
  subscriptions: (await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId])).rows,
  user: (await db.pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows,
});

async function refusal(promise: Promise<unknown>, reason: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(isBillingCustomerProvisioningError(error), `expected a provisioning refusal, got ${String(error)}`);
    assert.equal(error.reason, reason);
    assert.match(error.message, /Nothing was changed\./);
    assert.ok(!error.message.includes('sk_test_'), 'no credential in any refusal');
    return true;
  });
}

async function insertCustomer(userId: string, values: Record<string, unknown>) {
  const columns = ['user_id', ...Object.keys(values)];
  const params = [userId, ...Object.values(values)];
  await db.pool.query(
    `INSERT INTO billing_customers (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    params,
  );
}

/* -------------------------------------------------------------------------- */

describe('Step 6 — new customer creation', () => {
  it('finds nothing, creates once, persists a provisioned checkout-ready row', async () => {
    const user = await insertUser(db.pool, false);
    const service = serviceWith();

    const result = await service.ensureCustomer(user.id);
    assert.deepEqual(result, billingCustomerProvisioningResultSchema.parse(result));
    assert.equal(result.outcome, 'created');
    assert.equal(result.status, 'provisioned');
    assert.equal(result.email, user.email);
    assert.equal(result.provisionedAt, NOW.toISOString());
    assert.equal(result.checkoutReady, true);
    assert.equal(result.entitlementsChanged, false);
    assert.equal(result.grantsExecution, false);
    assert.equal(Object.hasOwn(result, 'providerCustomerCode'), false, 'no provider identifier is returned');

    // find BEFORE create; both canonical; the email comes from users.
    assert.equal(calls.find.length, 1);
    assert.deepEqual(calls.find[0], { provider: 'paystack', userId: user.id, email: user.email });
    assert.equal(calls.create.length, 1);
    assert.deepEqual(calls.create[0], {
      provider: 'paystack', userId: user.id, email: user.email,
      idempotencyKey: billingCustomerCreateKey(user.id, user.email), requestedAt: NOW.toISOString(),
    });

    const rows = await customerRows(user.id);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.status, 'provisioned');
    assert.equal(row.provider, 'paystack');
    assert.equal(row.email, user.email);
    assert.match(String(row.provider_customer_code), /^CUS_/);
    assert.ok(row.provider_customer_id !== null);
    assert.equal((row.provisioned_at as Date).toISOString(), NOW.toISOString());
    assert.equal(row.last_reference, null);
    assert.ok(isCheckoutReadyBillingCustomer(row as unknown as BillingCustomerRow));
  });

  it('the creation idempotency key is deterministic per (user, email)', () => {
    const userId = randomUUID();
    assert.equal(billingCustomerCreateKey(userId, 'a@example.test'), billingCustomerCreateKey(userId, 'a@example.test'));
    assert.notEqual(billingCustomerCreateKey(userId, 'a@example.test'), billingCustomerCreateKey(randomUUID(), 'a@example.test'));
    assert.match(billingCustomerCreateKey(userId, 'a@example.test'), /^[0-9a-f]{64}$/);
  });
});

describe('Step 6 — existing provider customer reuse (findCustomer)', () => {
  it('links the provider customer that already exists; never creates', async () => {
    const user = await insertUser(db.pool, false);
    const code = newCode();
    const service = serviceWith({
      find: async (r) => identity({ userId: r.userId, email: r.email! }, { providerCustomerCode: code, providerCustomerId: null }),
      create: async () => { throw new Error('must not create'); },
    });
    const result = await service.ensureCustomer(user.id);
    assert.equal(result.outcome, 'linked');
    assert.equal(calls.find.length, 1);
    assert.equal(calls.create.length, 0);
    const [row] = await customerRows(user.id);
    assert.equal(row!.provider_customer_code, code);
    assert.equal(row!.provider_customer_id, null, 'a code-only identity is persisted as-is');
    assert.equal(row!.status, 'provisioned');
  });

  it('upgrades an unprovisioned placeholder row in place (same row id)', async () => {
    const user = await insertUser(db.pool, false);
    await insertCustomer(user.id, { email: user.email });
    const [placeholder] = await customerRows(user.id);
    assert.equal(placeholder!.status, 'unprovisioned');

    const result = await serviceWith().ensureCustomer(user.id);
    assert.equal(result.outcome, 'created');
    const rows = await customerRows(user.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, placeholder!.id);
    assert.equal(rows[0]!.status, 'provisioned');
  });
});

describe('Step 6 — already-provisioned behaviour and idempotency', () => {
  it('a second call is a pure read: no provider call, row byte-identical', async () => {
    const user = await insertUser(db.pool, false);
    const service = serviceWith();
    const first = await service.ensureCustomer(user.id);
    const before = await customerRows(user.id);
    calls = { find: [], create: [] };

    for (let i = 0; i < 3; i += 1) {
      const again = await service.ensureCustomer(user.id);
      assert.equal(again.outcome, 'already_provisioned');
      assert.equal(again.email, first.email);
      assert.equal(again.provisionedAt, first.provisionedAt);
    }
    assert.equal(calls.find.length + calls.create.length, 0);
    assert.deepEqual(await customerRows(user.id), before);
  });

  it('answers an already-provisioned customer even with NO provider registered', async () => {
    const user = await insertUser(db.pool, false);
    await insertCustomer(user.id, {
      email: user.email, status: 'provisioned', provider_customer_code: newCode(), provisioned_at: NOW,
    });
    const before = await customerRows(user.id);
    const result = await serviceWith({ registered: false }).ensureCustomer(user.id);
    assert.equal(result.outcome, 'already_provisioned');
    assert.deepEqual(await customerRows(user.id), before);
  });
});

describe('Step 6 — local status vocabulary is enforced before any provider call', () => {
  for (const status of ['suspended', 'unavailable'] as const) {
    it(`${status} → customer_not_provisionable, nothing called or written`, async () => {
      const user = await insertUser(db.pool, false);
      await insertCustomer(user.id, { email: user.email, status, provider_customer_code: newCode(), provisioned_at: NOW });
      const before = await snapshotOf(user.id);
      await refusal(serviceWith().ensureCustomer(user.id), 'customer_not_provisionable');
      assert.equal(calls.find.length + calls.create.length, 0);
      assert.deepEqual(await snapshotOf(user.id), before);
    });
  }

  it('provisioned without a provider customer code → customer_identity_incomplete', async () => {
    const user = await insertUser(db.pool, false);
    await insertCustomer(user.id, { email: user.email, status: 'provisioned', provider_customer_id: '9001', provisioned_at: NOW });
    const before = await snapshotOf(user.id);
    await refusal(serviceWith().ensureCustomer(user.id), 'customer_identity_incomplete');
    assert.equal(calls.find.length + calls.create.length, 0);
    assert.deepEqual(await snapshotOf(user.id), before);
  });

  it('an unprovisioned placeholder with a different email → customer_identity_conflict', async () => {
    const user = await insertUser(db.pool, false);
    await insertCustomer(user.id, { email: 'someone-else@example.test' });
    const before = await snapshotOf(user.id);
    await refusal(serviceWith().ensureCustomer(user.id), 'customer_identity_conflict');
    assert.equal(calls.find.length + calls.create.length, 0);
    assert.deepEqual(await snapshotOf(user.id), before);
  });

  it('the pure decision covers the whole canonical vocabulary and refuses anything else', () => {
    const base: BillingCustomerRow = {
      id: randomUUID(), user_id: randomUUID(), provider: 'paystack', email: 'a@example.test',
      provider_customer_id: null, provider_customer_code: 'CUS_x', status: 'provisioned', provisioned_at: NOW,
    };
    const decided = Object.fromEntries(BILLING_CUSTOMER_STATUSES.map((status) =>
      [status, decideExistingBillingCustomer({ ...base, status }, 'a@example.test').kind]));
    assert.deepEqual(decided, { unprovisioned: 'provision', provisioned: 'ready', suspended: 'refuse', unavailable: 'refuse' });
    assert.deepEqual(decideExistingBillingCustomer({ ...base, status: 'active' }, 'a@example.test'),
      { kind: 'refuse', reason: 'customer_not_provisionable' });
    assert.deepEqual(decideExistingBillingCustomer({ ...base, provider: 'stripe' }, 'a@example.test'),
      { kind: 'refuse', reason: 'customer_not_provisionable' });
    assert.deepEqual(decideExistingBillingCustomer({ ...base, provider_customer_code: '  ' }, 'a@example.test'),
      { kind: 'refuse', reason: 'customer_identity_incomplete' });
  });
});

describe('Step 6 — provider failure writes nothing', () => {
  const failures: [string, { find?: Finder; create?: Creator }][] = [
    ['findCustomer throws', { find: async () => { throw new Error('transport failure: timeout'); } }],
    ['createCustomer throws', { create: async () => { throw new Error('provider_rejected 401'); } }],
    ['findCustomer throws an ambiguous-404-like error', {
      find: async () => { throw Object.assign(new Error('ambiguous'), { reason: 'ambiguous_not_found' }); },
    }],
  ];
  for (const [label, stub] of failures) {
    it(`${label} → provider_unavailable`, async () => {
      const user = await insertUser(db.pool, false);
      const before = await snapshotOf(user.id);
      await refusal(serviceWith(stub).ensureCustomer(user.id), 'provider_unavailable');
      assert.deepEqual(await snapshotOf(user.id), before);
      assert.equal((await customerRows(user.id)).length, 0);
    });
  }

  it('a provider failure leaves an unprovisioned placeholder exactly as it was', async () => {
    const user = await insertUser(db.pool, false);
    await insertCustomer(user.id, { email: user.email });
    const before = await snapshotOf(user.id);
    await refusal(serviceWith({ create: async () => { throw new Error('boom'); } }).ensureCustomer(user.id), 'provider_unavailable');
    assert.deepEqual(await snapshotOf(user.id), before);
  });

  it('no registered provider and no local customer → provider_not_registered', async () => {
    const user = await insertUser(db.pool, false);
    await refusal(serviceWith({ registered: false }).ensureCustomer(user.id), 'provider_not_registered');
    assert.equal((await customerRows(user.id)).length, 0);
  });
});

describe('Step 6 — invalid / unusable provider responses write nothing', () => {
  const unusable: [string, (r: { userId: string; email: string }) => unknown, string][] = [
    ['another user id', (r) => identity({ ...r, userId: randomUUID() }), 'provider_response_unusable'],
    ['status unprovisioned', (r) => identity(r, { status: 'unprovisioned', provisionedAt: null }), 'provider_response_unusable'],
    ['status suspended', (r) => identity(r, { status: 'suspended' }), 'provider_response_unusable'],
    ['no provider customer code (id only)', (r) => identity(r, { providerCustomerCode: null }), 'provider_response_unusable'],
    ['no identifiers at all', (r) => identity(r, { providerCustomerCode: null, providerCustomerId: null }), 'provider_response_unusable'],
    ['credential-shaped code', (r) => identity(r, { providerCustomerCode: 'CUS_secret_value' }), 'provider_response_unusable'],
    ['Paystack-key-shaped code', (r) => identity(r, { providerCustomerCode: 'sk_test_0123456789abcdef0123456789abcdef' }), 'provider_response_unusable'],
    ['Paystack-key-shaped id', (r) => identity(r, { providerCustomerId: 'sk_live_0123456789abcdef' }), 'provider_response_unusable'],
    ['uppercase email (not normalized)', (r) => identity(r, { email: r.email.toUpperCase() }), 'provider_response_unusable'],
    ['provider-shaped extra field', (r) => ({ ...identity(r), customer_code: 'CUS_raw' }), 'provider_response_unusable'],
    ['wrong provider', (r) => ({ ...identity(r), provider: 'stripe' }), 'provider_response_unusable'],
    ['null / garbage', () => 'CUS_just_a_string', 'provider_response_unusable'],
    ['a different email', (r) => identity(r, { email: 'other@example.test' }), 'customer_identity_conflict'],
  ];
  for (const [label, make, reason] of unusable) {
    it(`createCustomer returns ${label} → ${reason}`, async () => {
      const user = await insertUser(db.pool, false);
      const before = await snapshotOf(user.id);
      const service = serviceWith({ create: async (r) => make(r) as BillingCustomerIdentity });
      await refusal(service.ensureCustomer(user.id), reason);
      assert.deepEqual(await snapshotOf(user.id), before);
    });
  }

  it('findCustomer returning an unusable identity is refused the same way (no create fallback)', async () => {
    const user = await insertUser(db.pool, false);
    const service = serviceWith({ find: async (r) => identity({ userId: r.userId, email: r.email! }, { providerCustomerCode: null }) });
    await refusal(service.ensureCustomer(user.id), 'provider_response_unusable');
    assert.equal(calls.create.length, 0);
    assert.equal((await customerRows(user.id)).length, 0);
  });

  it('the pure validator accepts exactly the canonical, matching, provisioned, coded identity', () => {
    const r = { userId: randomUUID(), email: 'ok@example.test' };
    const ok = usableProviderCustomerIdentity(identity(r, { providerCustomerCode: '  CUS_trim  ' }), r);
    assert.equal(ok.providerCustomerCode, 'CUS_trim', 'identifiers are persisted in canonical (trimmed) form');
    assert.equal(ok.email, r.email);
  });
});

describe('Step 6 — authorization / isolation', () => {
  it('a provider identity already bound to ANOTHER user is refused; the other row is untouched', async () => {
    const owner = await insertUser(db.pool, false);
    const ownerResult = await serviceWith().ensureCustomer(owner.id);
    assert.equal(ownerResult.outcome, 'created');
    const [ownerRow] = await customerRows(owner.id);

    const intruder = await insertUser(db.pool, false);
    const service = serviceWith({
      create: async (r) => identity(r, {
        providerCustomerCode: ownerRow!.provider_customer_code as string,
        providerCustomerId: ownerRow!.provider_customer_id as string,
      }),
    });
    await assert.rejects(service.ensureCustomer(intruder.id), (error: unknown) => {
      assert.ok(isBillingCustomerProvisioningError(error));
      assert.equal(error.reason, 'customer_identity_conflict');
      assert.ok(!error.message.includes(owner.email), 'never reveals the other user');
      assert.ok(!error.message.includes(String(ownerRow!.provider_customer_code)));
      return true;
    });
    assert.equal((await customerRows(intruder.id)).length, 0);
    assert.deepEqual(await customerRows(owner.id), [ownerRow]);
  });

  it('every call is keyed by the given user only: each user gets their own record', async () => {
    const a = await insertUser(db.pool, false);
    const b = await insertUser(db.pool, false);
    const service = serviceWith();
    const ra = await service.ensureCustomer(a.id);
    const rb = await service.ensureCustomer(b.id);
    assert.equal(ra.email, a.email);
    assert.equal(rb.email, b.email);
    assert.notEqual((await customerRows(a.id))[0]!.provider_customer_code, (await customerRows(b.id))[0]!.provider_customer_code);
    assert.deepEqual(calls.find.map((c) => c.userId), [a.id, b.id]);
  });

  it('refuses a non-uuid subject and an unknown account before any provider call', async () => {
    const service = serviceWith();
    assert.throws(() => service.ensureCustomer('not-a-uuid'));
    await refusal(service.ensureCustomer(randomUUID()), 'account_unavailable');
    assert.equal(calls.find.length + calls.create.length, 0);
  });
});

describe('Step 6 — concurrency', () => {
  it('concurrent calls on one instance share ONE provider round-trip and ONE row', async () => {
    const user = await insertUser(db.pool, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = serviceWith({ find: async () => { await gate; return null; } });
    const pending = Array.from({ length: 10 }, () => service.ensureCustomer(user.id));
    release();
    const results = await Promise.all(pending);
    assert.equal(calls.find.length, 1);
    assert.equal(calls.create.length, 1);
    assert.ok(results.every((r) => r.outcome === 'created' && r.email === user.email));
    assert.equal((await customerRows(user.id)).length, 1);
    // Afterwards, the single-flight slot is released: the next call is a read.
    assert.equal((await service.ensureCustomer(user.id)).outcome, 'already_provisioned');
  });

  it('two instances racing with the SAME provider identity: one row, both succeed', async () => {
    const user = await insertUser(db.pool, false);
    const code = newCode();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create: Creator = async (r) => { await gate; return identity(r, { providerCustomerCode: code, providerCustomerId: null }); };
    const one = serviceWith({ create });
    const two = serviceWith({ create });
    const pending = [one.ensureCustomer(user.id), two.ensureCustomer(user.id)];
    release();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['already_provisioned', 'created']);
    const rows = await customerRows(user.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.provider_customer_code, code);
  });

  it('two instances racing with DIFFERENT identities: first writer wins, loser returns the winner', async () => {
    const user = await insertUser(db.pool, false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const create: Creator = async (r) => { await gate; return identity(r); };
    const pending = [serviceWith({ create }).ensureCustomer(user.id), serviceWith({ create }).ensureCustomer(user.id)];
    release();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ['already_provisioned', 'created']);
    const rows = await customerRows(user.id);
    assert.equal(rows.length, 1, 'never a second local customer for one user');
    assert.equal(rows[0]!.status, 'provisioned');
  });

  it('a concurrent suspension between the provider call and the write is never overwritten', async () => {
    const user = await insertUser(db.pool, false);
    await insertCustomer(user.id, { email: user.email });
    const service = serviceWith({
      create: async (r) => {
        await db.pool.query(`UPDATE billing_customers SET status = 'suspended' WHERE user_id = $1`, [user.id]);
        return identity(r);
      },
    });
    await refusal(service.ensureCustomer(user.id), 'customer_not_provisionable');
    const [row] = await customerRows(user.id);
    assert.equal(row!.status, 'suspended');
    assert.equal(row!.provider_customer_code, null);
  });
});

describe('Step 6 — no entitlement or subscription change', () => {
  it('provisioning touches only billing_customers; entitlements stay FREE', async () => {
    const user = await insertUser(db.pool, false);
    const before = await getBillingState(db.pool, user.id);
    const subsBefore = (await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id])).rows;
    const userBefore = (await db.pool.query('SELECT * FROM users WHERE id = $1', [user.id])).rows;

    const result = await serviceWith().ensureCustomer(user.id);
    assert.equal(result.entitlementsChanged, false);
    assert.equal(result.grantsExecution, false);

    const afterState = await getBillingState(db.pool, user.id);
    assert.deepEqual(afterState, before);
    assert.deepEqual(afterState.entitlements, FREE_ENTITLEMENTS);
    assert.equal(afterState.entitlements.canAccessAutomation, false);
    assert.deepEqual((await db.pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id])).rows, subsBefore);
    assert.deepEqual((await db.pool.query('SELECT * FROM users WHERE id = $1', [user.id])).rows, userBefore);
  });

  it('the result contract makes a capability grant unrepresentable', () => {
    const valid = {
      provider: 'paystack', outcome: 'created', status: 'provisioned', email: 'a@example.test',
      provisionedAt: NOW.toISOString(), checkoutReady: true, entitlementsChanged: false, grantsExecution: false,
    };
    assert.ok(billingCustomerProvisioningResultSchema.safeParse(valid).success);
    for (const override of [
      { entitlementsChanged: true }, { grantsExecution: true }, { status: 'suspended' },
      { checkoutReady: false }, { providerCustomerCode: 'CUS_x' }, { userId: randomUUID() }, { plan: 'pro' },
    ]) {
      assert.equal(billingCustomerProvisioningResultSchema.safeParse({ ...valid, ...override }).success, false, JSON.stringify(override));
    }
  });

  it('every refusal reason is a documented, fixed vocabulary', () => {
    assert.deepEqual([...BILLING_CUSTOMER_PROVISIONING_ERROR_REASONS].sort(), [
      'account_unavailable', 'customer_identity_conflict', 'customer_identity_incomplete',
      'customer_not_provisionable', 'provider_not_registered', 'provider_response_unusable', 'provider_unavailable',
    ]);
  });
});
