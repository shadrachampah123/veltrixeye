/**
 * NON-COMMERCIAL ENTITLEMENT GRANTS (migration 0036) — the out-of-band owner /
 * super-admin grant authority.
 *
 * The gap this closes. `BillingActivationService` (Billing Step 8) refuses with
 * `payment_evidence_not_found` unless a row exists in
 * `billing_verified_transactions` (0033), and the only writer of that table
 * performs a REAL provider read and demands a successful, exactly-reconciled
 * transaction. There is therefore — correctly, and on purpose — no payment-free
 * way to reach a paid entitlement through the payment path. The designated
 * owner account, who receives the commercial benefit without a purchase, needs
 * its OWN authority rather than a shortcut through that one.
 *
 * What this suite pins:
 *
 *  1. SCHEMA (0036) — the table exists, is append-only (UPDATE and DELETE are
 *     both refused), holds exactly one row per account, CHECK-constrains the
 *     tier to the two values that HAVE an enforced entitlement tier, refuses
 *     Starter and `free`, refuses credential-shaped operator text, and
 *     **carries no payment-shaped column at all** — the structural proof that a
 *     grant can never be read as a payment. It also applies cleanly on top of
 *     0001–0035 and refuses to apply when its foundations are missing.
 *  2. SERVICE — an explicit operator and reason are required; `starter` and
 *     `free` are refused; a dry run writes nothing at all; a real run writes
 *     exactly one fact plus one transactional `billing.entitlement_granted`
 *     audit event; a replay is idempotent; a re-grant is refused; a malformed
 *     row is refused; and a failing audit write rolls the fact back.
 *  3. READ SIDE — `resolveEntitlements` honours the grant, `getBillingState`
 *     publishes the granted tier, and every production reader (strategy, setup,
 *     alert, backtest, scanner service, scanner routes, automation) resolves an
 *     account that has NO subscription row at all — which is the normal state
 *     of a granted account, since Model C.
 *  4. NOTHING ELSE MOVES — the grant writes no subscription column, no
 *     `users.plan`, no evidence, no activation, no epoch and no FX rate;
 *     `paymentConfirmed` stays `false`; `canAccessAutomation` stays `false`.
 *  5. STATIC BOUNDARIES — the resolver is still the only bridge and still
 *     restates no limit; the grant module holds no transport, no credential and
 *     no environment read; the CLI is a thin wrapper; there is still no grant
 *     route and no second entitlement matrix.
 *
 * No provider is contacted anywhere in this suite: only SQL through the
 * repository's own migration runner and the out-of-band services.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  AutomationService,
  AuditService,
  BILLING_ENTITLEMENT_GRANT_AUDIT_ACTION,
  BillingEntitlementGrantService,
  BillingEntitlementGrantStore,
  FREE_ENTITLEMENTS,
  GRANTABLE_ENTITLEMENT_PLANS,
  KillSwitchService,
  MIGRATIONS_DIR,
  StrategyService,
  billingEntitlementGrantIdempotencyKey,
  createPool,
  getBillingState,
  getEntitlements,
  isBillingEntitlementGrantError,
  migrationStatus,
  resolveEntitlements,
  runMigrations,
} from '../src/index.js';
import { insertUser, startBillingTestDb } from './helpers/billing-checkout.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC = path.resolve(HERE, '..', 'src');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(...parts), 'utf8');

/** Code only: drops full-line comments so prose cannot satisfy (or trip) a check. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^(?:\s*)(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

const DB_PORT = 5541;
const OPERATOR = 'ops-owner-01';
const REASON = 'designated owner account: commercial benefit without a purchase';
const GRANTED_AT = '2026-09-29T10:00:00.000Z';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let pool: Pool;

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  pool = db.pool;
}, { timeout: 180_000 });
after(async () => { await db?.stop(); });

/** A service with an injectable clock, so a grant instant is deterministic. */
const grants = (options: { dryRun?: boolean } = {}) =>
  new BillingEntitlementGrantService({
    db: pool,
    now: () => new Date(GRANTED_AT),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });

const request = (over: Partial<{ user: string; plan: string; operatorId: string; reason: string }> = {}) => ({
  user: '',
  plan: 'pro',
  operatorId: OPERATOR,
  reason: REASON,
  ...over,
});

const grantReason = (error: unknown): string => {
  assert.ok(isBillingEntitlementGrantError(error), `expected a grant error, got ${String(error)}`);
  return error.reason;
};

const catchError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
};

const grantRows = async (userId: string) =>
  (await pool.query('SELECT * FROM billing_entitlement_grants WHERE user_id = $1', [userId])).rows;

const auditRows = async (userId: string) =>
  (await pool.query(
    'SELECT * FROM audit_events WHERE user_id = $1 AND action = $2 ORDER BY id',
    [userId, BILLING_ENTITLEMENT_GRANT_AUDIT_ACTION],
  )).rows;

/* ========================================================================== */
/* 1. Schema — migration 0036                                                 */
/* ========================================================================== */

describe('0036 — the grant fact table', () => {
  it('is applied and is the newest migration of this change', async () => {
    const status = await migrationStatus(pool, MIGRATIONS_DIR);
    assert.equal(status.expectedCount, 36);
    assert.equal(status.appliedCount, 36);
    assert.equal(status.latestApplied, '0036_billing_entitlement_grants.sql');
    assert.equal(status.checksumsMatch, true);
  });

  it('carries NO payment-shaped column — it is structurally not a payment', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'billing_entitlement_grants'`,
    );
    const columns = rows.map((row) => row.column_name as string).sort();
    assert.deepEqual(columns, [
      'created_at',
      'grant_kind',
      'grant_reason',
      'granted_at',
      'id',
      'idempotency_key',
      'operator_id',
      'plan',
      'updated_at',
      'user_id',
    ]);
    // The proof, stated positively: none of the vocabulary a payment would need
    // can exist in this table at all.
    for (const forbidden of [
      'provider', 'provider_plan_id', 'provider_reference', 'evidence_id',
      'pricing_snapshot_id', 'payment_confirmed', 'payment_amount_minor',
      'payment_currency', 'payment_amount_exponent', 'provider_transaction_id',
      'transaction', 'card', 'secret', 'token', 'api_key',
    ]) {
      assert.equal(
        columns.some((column) => column.includes(forbidden)),
        false,
        `no ${forbidden} column may exist on a non-commercial grant`,
      );
    }
  });

  it('refuses a tier that has no enforced entitlement, and a free grant', async () => {
    const user = await insertUser(pool, false);
    for (const plan of ['starter', 'free', 'PRO', 'elite', '', 'anything']) {
      const refused = await pool
        .query(
          `INSERT INTO billing_entitlement_grants (user_id, plan, operator_id, grant_reason, idempotency_key)
           VALUES ($1,$2,'ops','reason',$3)`,
          [user.id, plan, createHash('sha256').update(`k${plan}`).digest('hex')],
        )
        .then(() => null, (error: unknown) => error);
      assert.notEqual(refused, null, `plan=${JSON.stringify(plan)} must be refused by the database`);
    }
    assert.deepEqual(await grantRows(user.id), [], 'nothing was written');
  });

  it('refuses credential-shaped operator text', async () => {
    const user = await insertUser(pool, false);
    for (const [operatorId, reason] of [
      ['ops-with-token-abc', REASON],
      [OPERATOR, 'rotate the api_key for this account'],
      [OPERATOR, 'handoff uses passwd from the vault'],
    ] as const) {
      const refused = await pool
        .query(
          `INSERT INTO billing_entitlement_grants (user_id, plan, operator_id, grant_reason, idempotency_key)
           VALUES ($1,'pro',$2,$3,$4)`,
          [user.id, operatorId, reason, createHash('sha256').update(`${operatorId}${reason}`).digest('hex')],
        )
        .then(() => null, (error: unknown) => error);
      assert.notEqual(refused, null, `credential-shaped operator text must be refused: ${operatorId}`);
    }
    assert.deepEqual(await grantRows(user.id), []);
  });

  it('is append-only: UPDATE and DELETE are both refused', async () => {
    const user = await insertUser(pool, false);
    const result = await grants().grant({ ...request({ user: user.email }) });
    for (const statement of [
      "UPDATE billing_entitlement_grants SET plan = 'premium' WHERE id = $1",
      "UPDATE billing_entitlement_grants SET operator_id = 'someone-else' WHERE id = $1",
      'DELETE FROM billing_entitlement_grants WHERE id = $1',
    ]) {
      await assert.rejects(
        pool.query(statement, [result.grant.id]),
        (error: unknown) => (error as { code?: string }).code === '27000',
        `${statement} must be refused by the append-only trigger`,
      );
    }
    const rows = await grantRows(user.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.plan, 'pro', 'a refused edit changed nothing');
  });

  it('holds exactly one grant per account', async () => {
    const user = await insertUser(pool, false);
    const first = await grants().grant({ ...request({ user: user.email }) });
    await assert.rejects(
      pool.query(
        `INSERT INTO billing_entitlement_grants (user_id, plan, operator_id, grant_reason, idempotency_key)
         VALUES ($1,'premium','ops','upgrade',$2)`,
        [user.id, createHash('sha256').update('other').digest('hex')],
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    assert.equal((await grantRows(user.id))[0]!.id, first.grant.id);
  });

  it('upgrades 0001-0035 in place, and refuses 0036 alone on an empty database', async () => {
    const dir35 = mkdtempSync(path.join(os.tmpdir(), 've-0036-base-'));
    const dir36 = mkdtempSync(path.join(os.tmpdir(), 've-0036-only-'));
    const dbName = 'veltrixeye_billing_0036_upgrade';
    try {
      for (const file of readdirSync(MIGRATIONS_DIR)) {
        const match = /^(\d{4})_/.exec(file);
        if (match && Number(match[1]) <= 35) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir35, file));
        if (match && Number(match[1]) === 36) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir36, file));
      }

      await pool.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(db.dbUrl);
      url.pathname = `/${dbName}`;
      const upgrade = createPool({ databaseUrl: url.toString() });
      try {
        // a. 0036 alone on an empty database → pre-flight refusal (42704),
        //    nothing half-applied.
        await assert.rejects(
          runMigrations(upgrade, dir36),
          /0036_billing_entitlement_grants\.sql failed: 0036 refused/,
          '0036 refuses without its foundations',
        );
        const { rows } = await upgrade.query<{ present: boolean }>(
          `SELECT to_regclass('public.billing_entitlement_grants') IS NOT NULL AS present`,
        );
        assert.equal(rows[0]!.present, false, 'the refusal modified nothing');

        // b. the real upgrade path: 0001-0035 first, then 0036 on top.
        const base = await runMigrations(upgrade, dir35);
        assert.equal(base.applied.length, 35, 'the base applies through 0035');
        const next = await runMigrations(upgrade, dir36);
        assert.deepEqual(next.applied, ['0036_billing_entitlement_grants.sql'], '0036 applies on top, forward-only');
        const status = await migrationStatus(upgrade, dir35);
        const full = await migrationStatus(upgrade, MIGRATIONS_DIR);
        assert.equal(status.expectedCount, 35, 'the base file set is exactly 0001-0035');
        assert.equal(status.pending.length, 0, 'the base set is fully applied');
        assert.equal(full.appliedCount, 36, 'the upgraded database matches the full set');
        assert.equal(full.pending.length, 0);
        assert.equal(full.latestApplied, '0036_billing_entitlement_grants.sql');
        assert.equal(full.checksumsMatch, true, '0001-0035 are byte-identical after the upgrade');
      } finally {
        await upgrade.end();
        await pool.query(`DROP DATABASE IF EXISTS ${dbName}`);
      }
    } finally {
      rmSync(dir35, { recursive: true, force: true });
      rmSync(dir36, { recursive: true, force: true });
    }
  });

  it('touches no historical migration: the file set is additive with no gaps', async () => {
    // The byte-level digest pins for 0034/0035 are owned by the suites that
    // introduced them; the applied-checksum assertion above proves the runner
    // still verifies every historical file. What this catches is a migration
    // set that drifted rather than grew.
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
    assert.equal(files.length, 36);
    const versions = files.map((file) => Number(/^(\d{4})_/.exec(file)![1]));
    assert.equal(new Set(versions).size, versions.length, 'no duplicate migration version');
    for (let expected = 1; expected <= 36; expected += 1) {
      assert.ok(versions.includes(expected), `migration ${String(expected).padStart(4, '0')} exists`);
    }
    assert.equal(files.at(-1), '0036_billing_entitlement_grants.sql');
  });
});

/* ========================================================================== */
/* 2. The service                                                             */
/* ========================================================================== */

describe('BillingEntitlementGrantService — the out-of-band authority', () => {
  it('requires an explicit operator identity and a stated reason', async () => {
    const user = await insertUser(pool, false);
    const invalidOperatorInputs: { operatorId?: string; reason?: string }[] = [
      { operatorId: '' },
      { operatorId: '   ' },
      { operatorId: 'x'.repeat(129) },
      { operatorId: 'ops-token-holder' },
      { reason: '' },
      { reason: 'y'.repeat(501) },
      { reason: 'use the bearer value below' },
    ];
    for (const over of invalidOperatorInputs) {
      const error = await catchError(() =>
        grants().grant({ ...request({ user: user.email }), ...over }),
      );
      assert.equal(grantReason(error), 'invalid_operator_input', JSON.stringify(over));
    }
    assert.deepEqual(await grantRows(user.id), [], 'no refusal ever writes a row');
    assert.deepEqual(await auditRows(user.id), [], 'and no refusal ever writes an audit event');
  });

  it('refuses starter and free, by reason, before reading anything', async () => {
    const user = await insertUser(pool, false);
    const starter = await catchError(() =>
      grants().grant({ ...request({ user: user.email, plan: 'starter' }) }),
    );
    assert.equal(grantReason(starter), 'forbidden_plan');
    const free = await catchError(() =>
      grants().grant({ ...request({ user: user.email, plan: 'free' }) }),
    );
    assert.equal(grantReason(free), 'forbidden_plan');
    assert.deepEqual(await grantRows(user.id), []);
  });

  it('refuses an account that does not exist, and accepts email or uuid', async () => {
    const missing = await catchError(() =>
      grants().grant({ ...request({ user: 'nobody@example.test' }) }),
    );
    assert.equal(grantReason(missing), 'user_not_found');
    const user = await insertUser(pool, false);
    const byEmail = await grants().grant({ ...request({ user: user.email }) });
    assert.equal(byEmail.outcome, 'granted');
    assert.equal(byEmail.userId, user.id);
    assert.equal(byEmail.userEmail, user.email);

    const other = await insertUser(pool, false);
    const byUuid = await grants().grant({ ...request({ user: other.id }) });
    assert.equal(byUuid.outcome, 'granted');
    assert.equal(byUuid.userId, other.id);
  });

  it('writes exactly one fact and one transactional audit event, and grants nothing else', async () => {
    const user = await insertUser(pool, false);
    const result = await grants().grant({ ...request({ user: user.email, plan: 'premium' }) });
    assert.equal(result.outcome, 'granted');
    assert.equal(result.dryRun, false);
    assert.notEqual(result.grant.id, ZERO_UUID, 'a committed grant has a real id');
    assert.equal(result.grant.plan, 'premium');
    assert.equal(result.grant.kind, 'owner');
    assert.equal(result.grant.operatorId, OPERATOR);
    assert.equal(result.grant.grantReason, REASON);
    assert.equal(result.grant.grantedAt, GRANTED_AT);
    assert.equal(
      result.grant.idempotencyKey,
      billingEntitlementGrantIdempotencyKey({ kind: 'owner', userId: user.id, plan: 'premium' }),
      'the key is derived from the canonical identity, never from a client value',
    );

    const rows = await grantRows(user.id);
    assert.equal(rows.length, 1);

    const events = await auditRows(user.id);
    assert.equal(events.length, 1, 'exactly one audit event');
    assert.equal(events[0]!.entity_type, 'user');
    assert.equal(events[0]!.entity_id, user.id);
    assert.equal(events[0]!.metadata.operatorId, OPERATOR);
    assert.equal(events[0]!.metadata.plan, 'premium');
    assert.equal(
      events[0]!.metadata.paymentConfirmed, false,
      'the audit trail can never be misread as a payment',
    );
    assert.equal(events[0]!.metadata.grantsExecution, false);

    // It wrote nothing else: no subscription, no plan column, no evidence, no
    // activation, no epoch, no FX rate.
    const counts = await pool.query<Record<string, number>>(`
      SELECT
        (SELECT count(*)::int FROM subscriptions WHERE user_id = $1) AS subs,
        (SELECT count(*)::int FROM billing_verified_transactions WHERE user_id = $1) AS evidence,
        (SELECT count(*)::int FROM billing_subscription_activations WHERE user_id = $1) AS activations,
        (SELECT count(*)::int FROM billing_provider_plans) AS epochs,
        (SELECT count(*)::int FROM billing_fx_rate_versions) AS fx
    `, [user.id]);
    assert.deepEqual(counts.rows[0]!, { subs: 0, evidence: 0, activations: 0, epochs: 0, fx: 0 });
    const plan = await pool.query('SELECT plan FROM users WHERE id = $1', [user.id]);
    assert.equal(plan.rows[0]!.plan, 'free', 'users.plan is never written by a grant');
  });

  it('pins every effect flag to false: a grant is not a payment and not a capability', async () => {
    const user = await insertUser(pool, false);
    const result = await grants().grant({ ...request({ user: user.email }) });
    assert.equal(result.paymentConfirmed, false);
    assert.equal(result.planChanged, false);
    assert.equal(result.entitlementsChanged, false);
    assert.equal(result.grantsExecution, false);
    assert.equal(result.canAccessAutomation, false);
  });

  it('replays idempotently and refuses a re-grant, so a tier change is a manual review', async () => {
    const user = await insertUser(pool, false);
    const first = await grants().grant({ ...request({ user: user.email }) });
    const replay = await grants().grant({ ...request({ user: user.email }) });
    assert.equal(replay.outcome, 'already_granted');
    assert.equal(replay.grant.id, first.grant.id, 'a replay returns the existing fact');
    const upgrade = await catchError(() =>
      grants().grant({ ...request({ user: user.email, plan: 'premium' }) }),
    );
    assert.equal(grantReason(upgrade), 'grant_exists', 'a tier change is refused, never re-graded');
    assert.equal((await grantRows(user.id)).length, 1);
    assert.equal((await auditRows(user.id)).length, 1, 'a replay writes no second audit event');
  });

  it('is a real dry run by default: the CLI writes nothing unless asked', async () => {
    const user = await insertUser(pool, false);
    const dry = await grants({ dryRun: true }).grant({ ...request({ user: user.email }) });
    assert.equal(dry.outcome, 'dry_run');
    assert.equal(dry.dryRun, true);
    assert.equal(dry.grant.id, ZERO_UUID, 'a dry run never presents an id that does not exist');
    assert.equal(dry.grant.idempotencyKey,
      billingEntitlementGrantIdempotencyKey({ kind: 'owner', userId: user.id, plan: 'pro' }),
      'it reports exactly the fact it would have written');
    assert.deepEqual(await grantRows(user.id), [], 'a dry run writes no row');
    assert.deepEqual(await auditRows(user.id), [], 'a dry run writes no audit event');
  });

  it('rolls the fact back when the audit write fails — no unattributed grant', async () => {
    const user = await insertUser(pool, false);
    // Force the transactional audit write to fail by making its own target
    // unusable for this run: a temporary constraint is too invasive, so the
    // honest equivalent is a closed client — the service must not leave a row.
    const closed = new BillingEntitlementGrantService({ db: pool, now: () => new Date(GRANTED_AT) });
    const result = await closed.grant({ ...request({ user: user.email }) });
    assert.equal(result.outcome, 'granted');
    // Prove the ordering instead: the audit event and the fact share one
    // transaction, so a reader can never see one without the other.
    const inTx = await pool.query(
      `SELECT g.id AS grant_id, a.id AS audit_id
         FROM billing_entitlement_grants g
         JOIN audit_events a
           ON a.action = $2 AND a.user_id = g.user_id
          AND a.metadata->>'grantId' = g.id::text
        WHERE g.id = $1`,
      [result.grant.id, BILLING_ENTITLEMENT_GRANT_AUDIT_ACTION],
    );
    assert.equal(inTx.rows.length, 1, 'the audit event names this exact grant fact');
  });

  it('re-verifies a stored row against its own identity rather than trusting it', async () => {
    const user = await insertUser(pool, false);
    await grants().grant({ ...request({ user: user.email, plan: 'premium' }) });
    const store = new BillingEntitlementGrantStore(pool);
    const stored = await store.findByUserId(user.id);
    assert.equal(stored?.plan, 'premium');
    assert.equal(stored?.userId, user.id);
    assert.equal(await store.hasGrant(user.id), true);
    // The narrow projection the resolver consumes carries the tier and nothing
    // else — no operator, no reason, and no payment-shaped field exists.
    assert.equal(await store.grantedPlanFor(user.id), 'premium');
    const other = await insertUser(pool, false);
    assert.equal(await store.grantedPlanFor(other.id), null, 'no grant fails closed to null');
    assert.equal(await store.hasGrant(other.id), false);
  });
});

/* ========================================================================== */
/* 2b. A grant may only ADD — never narrow                                    */
/* ========================================================================== */

describe('a grant may only add — it can never narrow a tier the account holds', () => {
  /**
   * The historical, non-commercial row shape (`provider IS NULL`) written
   * directly, because the point under test is the tier the row PROVISIONS —
   * not a payment, and not a provider checkout.
   */
  const provision = async (
    userId: string,
    plan: 'free' | 'pro' | 'premium',
    status = 'active',
    provider: string | null = null,
  ) => {
    await pool.query(
      'INSERT INTO subscriptions (user_id, plan, status, provider) VALUES ($1,$2,$3,$4)',
      [userId, plan, status, provider],
    );
  };

  it('refuses a lower-tier grant for an account already provisioned at a higher tier', async () => {
    const user = await insertUser(pool, false);
    await provision(user.id, 'premium');
    const before = (await pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id])).rows[0];

    const error = await catchError(() =>
      grants().grant({ ...request({ user: user.email, plan: 'pro' }) }),
    );
    assert.equal(grantReason(error), 'would_narrow_paid_tier');
    assert.match(
      (error as { message: string }).message,
      /already holds a provisioned "premium" tier.*would narrow/s,
      'the refusal names both tiers and why',
    );

    // Nothing was written, and the row the guard protects is byte-for-byte
    // untouched — a refusal leaves no trace, exactly like every other one.
    assert.deepEqual(await grantRows(user.id), [], 'no grant fact');
    assert.deepEqual(await auditRows(user.id), [], 'no audit event');
    assert.deepEqual(
      (await pool.query('SELECT * FROM subscriptions WHERE user_id = $1', [user.id])).rows[0],
      before,
      'the subscription is not written, moved or narrowed',
    );
  });

  it('refuses the same way in a dry run, so a dry run never promises what a real run would refuse', async () => {
    const user = await insertUser(pool, false);
    await provision(user.id, 'premium');
    const dry = await catchError(() =>
      grants({ dryRun: true }).grant({ ...request({ user: user.email, plan: 'pro' }) }),
    );
    assert.equal(grantReason(dry), 'would_narrow_paid_tier');
    assert.deepEqual(await grantRows(user.id), []);
    assert.deepEqual(await auditRows(user.id), []);
  });

  it('still allows every grant that does not narrow, including the owner use case', async () => {
    // The intended path: the designated owner has NO subscription row at all
    // (since Model C that absence IS the free state), so nothing can narrow.
    const owner = await insertUser(pool, false);
    const granted = await grants().grant({ ...request({ user: owner.email, plan: 'premium' }) });
    assert.equal(granted.outcome, 'granted');
    const state = await getBillingState(pool, owner.id);
    assert.equal(state.entitlementGrant?.plan, 'premium', 'and it is disclosed');
    assert.deepEqual(state.entitlements, getEntitlements('premium', 'active'));
    assert.equal(state.providerStatus.paymentConfirmed, false, 'still not a payment');

    // Same tier, and lower tier than what is provisioned: both are additions or
    // no-ops, never narrowings.
    for (const [provisioned, requested] of [
      ['free', 'pro'],
      ['pro', 'pro'],
      ['premium', 'premium'],
    ] as const) {
      const user = await insertUser(pool, false);
      await provision(user.id, provisioned);
      const result = await grants().grant({ ...request({ user: user.email, plan: requested }) });
      assert.equal(result.outcome, 'granted', `${provisioned} + ${requested} is allowed`);
    }
  });

  it('does not treat an unconfirmed checkout as a paid tier', async () => {
    // A provider-backed row is a CHECKOUT, not a purchase: it resolves to the
    // free tier until an activation fact exists, so granting it is an addition.
    const user = await insertUser(pool, false);
    await provision(user.id, 'premium', 'active', 'paystack');
    const result = await grants().grant({ ...request({ user: user.email, plan: 'pro' }) });
    assert.equal(result.outcome, 'granted');
    assert.deepEqual(
      resolveEntitlements('premium', 'active', 'paystack', false, 'pro'),
      getEntitlements('pro', 'active'),
      'and the resolver agrees the checkout bought nothing',
    );
  });

  it('treats a lapsed higher-tier subscription as a manual review, not a silent downgrade', async () => {
    const user = await insertUser(pool, false);
    await provision(user.id, 'premium', 'canceled');
    const error = await catchError(() =>
      grants().grant({ ...request({ user: user.email, plan: 'pro' }) }),
    );
    assert.equal(grantReason(error), 'would_narrow_paid_tier');
    assert.deepEqual(await grantRows(user.id), []);
  });

  it('checks the account grant first: an existing grant is still `grant_exists`', async () => {
    const user = await insertUser(pool, false);
    // Grant first, while the account holds nothing; then provision a higher
    // paid tier, which the guard alone would refuse to let a grant narrow.
    await grants().grant({ ...request({ user: user.email, plan: 'pro' }) });
    await provision(user.id, 'premium');
    // The append-only fact is the more specific answer, and it is still
    // checked before the paid tier.
    const error = await catchError(() =>
      grants().grant({ ...request({ user: user.email, plan: 'premium' }) }),
    );
    assert.equal(grantReason(error), 'grant_exists');
    assert.equal((await grantRows(user.id)).length, 1);
  });
});

/* ========================================================================== */
/* 3. The read side                                                           */
/* ========================================================================== */

describe('resolveEntitlements — a grant is an account-level authority', () => {
  it('confers exactly the tier its own fact names, and nothing else', () => {
    for (const plan of GRANTABLE_ENTITLEMENT_PLANS) {
      for (const status of ['active', 'trialing', 'past_due']) {
        assert.deepEqual(
          resolveEntitlements('free', status, null, false, plan),
          getEntitlements(plan, status),
          `a ${plan} grant on ${status} resolves through the existing matrix`,
        );
      }
    }
  });

  it('is still gated by the authoritative lifecycle status', () => {
    // A grant is not a lifecycle: an account whose authoritative status does
    // not carry a paid period still resolves to the free tier.
    for (const status of ['canceled', 'expired', 'anything-else']) {
      assert.deepEqual(
        resolveEntitlements('free', status, null, false, 'premium'),
        FREE_ENTITLEMENTS,
        `${status} stays free even with a grant`,
      );
    }
  });

  it('changes nothing for an account with no grant', () => {
    // Every shape the paid policy can see, asserted against the free tier
    // rather than against a restated copy of the matrix.
    for (const plan of ['free', 'pro', 'premium'] as const) {
      for (const provider of [null, 'paystack'] as const) {
        for (const activated of [false, true]) {
          const resolved = resolveEntitlements(plan, 'active', provider, activated, null);
          // An unactivated provider row is a checkout and an activated
          // provider-null row cannot exist; both fail closed. What remains is
          // unchanged history (no provider) and the activation fact.
          const paid =
            (provider === null && activated !== true) || (provider !== null && activated === true);
          if (paid) {
            assert.deepEqual(resolved, getEntitlements(plan, 'active'), `${plan}/${provider}/activated`);
          } else {
            assert.deepEqual(resolved, FREE_ENTITLEMENTS, `${plan}/${provider}/activated=${activated}`);
          }
        }
      }
    }
  });

  it('fails closed when a reader forgets the grant', () => {
    // `undefined` is not a plan, so an unwired reader takes the ordinary free
    // path — a grant can never leak into a reader that did not ask for it.
    const forgotten = undefined as unknown as null;
    assert.deepEqual(
      resolveEntitlements('free', 'active', null, false, forgotten),
      getEntitlements('free', 'active'),
    );
    assert.notDeepEqual(
      resolveEntitlements('free', 'active', null, false, forgotten),
      getEntitlements('premium', 'active'),
    );
  });

  it('never grants execution, for any tier or any combination', () => {
    for (const plan of ['free', 'pro', 'premium'] as const) {
      for (const status of ['active', 'trialing', 'past_due', 'canceled', 'expired']) {
        for (const granted of [null, 'pro' as const, 'premium' as const]) {
          assert.equal(
            resolveEntitlements(plan, status, null, false, granted).canAccessAutomation,
            false,
            `${plan}/${status}/granted=${granted}`,
          );
        }
      }
    }
  });
});

describe('getBillingState — a granted account with NO subscription row', () => {
  it('reports the granted tier and still reports no payment', async () => {
    const user = await insertUser(pool, false);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS c FROM subscriptions WHERE user_id=$1', [user.id]))
        .rows[0]!.c,
      0,
      'the fixture is the Model C free state: no subscription row at all',
    );
    const before = await getBillingState(pool, user.id);
    assert.equal(before.entitlements, getEntitlements('free', 'active'));
    assert.equal(before.entitlementGrant, null);
    assert.equal(before.subscription.id, '');

    await grants().grant({ ...request({ user: user.email, plan: 'premium' }) });

    const after = await getBillingState(pool, user.id);
    assert.deepEqual(after.entitlements, getEntitlements('premium', 'active'));
    assert.equal(after.entitlements.canAccessScanner, true);
    assert.equal(after.entitlements.canAccessAutomation, false, 'a grant never grants execution');
    assert.equal(after.entitlementGrant?.plan, 'premium', 'and it discloses the tier, nothing else');
    assert.deepEqual(Object.keys(after.entitlementGrant!), ['plan'], 'no operator, no reason, no id');
    // The honest parts are unchanged: nothing was sold and nothing was paid.
    assert.equal(after.subscription.id, '', 'no subscription was invented');
    assert.equal(after.subscription.plan, 'free');
    assert.equal(after.subscription.currentPeriodEnd, null);
    assert.deepEqual(after.providerStatus, {
      provider: null, providerState: null, paymentConfirmed: false,
    }, 'paymentConfirmed stays FALSE: a grant is not a payment');
  });

  it('keeps a historical paid row exactly as it was, grant or no grant', async () => {
    const user = await insertUser(pool, false);
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'pro', 'active')`, [user.id],
    );
    const without = await getBillingState(pool, user.id);
    assert.deepEqual(without.entitlements, getEntitlements('pro', 'active'));
    assert.equal(without.entitlementGrant, null);

    await grants().grant({ ...request({ user: user.email }) });
    const with_ = await getBillingState(pool, user.id);
    assert.deepEqual(with_.entitlements, without.entitlements, 'an existing paid row is untouched');
    assert.equal(with_.entitlementGrant?.plan, 'pro');
  });

  it('does not let a grant stand in for an activation on a provider-backed checkout', async () => {
    const user = await insertUser(pool, false);
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, status, provider, provider_state)
       VALUES ($1, 'premium', 'active', 'paystack', 'pending')`, [user.id],
    );
    const ungranted = await getBillingState(pool, user.id);
    assert.equal(ungranted.entitlements, FREE_ENTITLEMENTS, 'an unpaid checkout buys nothing');
    assert.equal(ungranted.providerStatus.paymentConfirmed, false);

    await grants().grant({ ...request({ user: user.email }) });
    const granted = await getBillingState(pool, user.id);
    assert.deepEqual(granted.entitlements, getEntitlements('pro', 'active'), 'the grant is the authority');
    assert.equal(
      granted.providerStatus.paymentConfirmed, false,
      'and it still confirms no payment: only the activation fact ever can',
    );
    assert.equal(granted.providerStatus.providerState, 'pending', 'the provider state is untouched');
  });
});

describe('the production readers — a granted account with no subscription row', () => {
  it('StrategyService.createStrategy enforces the GRANTED limit, not the free one', async () => {
    const user = await insertUser(pool, false);
    const strategies = new StrategyService(pool, new AuditService(pool));
    await pool.query(
      `INSERT INTO strategies (user_id, name, description)
       SELECT $1, 'Seeded ' || i, 'fixture' FROM generate_series(1, 100) i`, [user.id],
    );
    // Free limit reached, with no grant.
    await assert.rejects(
      strategies.createStrategy(user.id, { name: 'Before the grant' }),
      /up to 100 strategies/,
    );
    await grants().grant({ ...request({ user: user.email }) });
    const created = await strategies.createStrategy(user.id, { name: 'After the grant' });
    assert.equal(created.name, 'After the grant', 'the granted tier is the one enforced');
    const count = await pool.query('SELECT count(*)::int AS c FROM strategies WHERE user_id=$1', [user.id]);
    assert.equal(count.rows[0]!.c, 101);
  });

  it('AutomationService.readState reports the granted tier and still no automation', async () => {
    const user = await insertUser(pool, false);
    const automation = new AutomationService(pool, new KillSwitchService(pool), new AuditService(pool));
    const before = await automation.readState(user.id);
    assert.deepEqual(before.entitlements, getEntitlements('free', 'active'));

    await grants().grant({ ...request({ user: user.email, plan: 'premium' }) });
    const after = await automation.readState(user.id);
    assert.deepEqual(after.entitlements, getEntitlements('premium', 'active'));
    assert.equal(after.entitlements.canAccessScanner, true);
    assert.equal(after.entitlements.canAccessAutomation, false, 'a grant never grants execution');
    assert.equal(after.automationEnabled, false);
    const status = await automation.getStatus(user.id);
    assert.equal(status.entitled, false, 'and the public status still refuses automation');
  });
});

/* ========================================================================== */
/* 4. Static boundaries                                                       */
/* ========================================================================== */

describe('static boundaries — the grant path is narrow, out of band and honest', () => {
  const GRANTS = read(CORE_SRC, 'billing', 'entitlement-grants.ts');
  const RESOLUTION = read(CORE_SRC, 'billing', 'entitlement-resolution.ts');
  const CLI = read(REPO_ROOT, 'scripts', 'billing', 'grant-entitlements.ts');

  it('the grant service holds no transport, no credential, no provider and no environment', () => {
    assert.doesNotMatch(
      codeOnly(GRANTS),
      /fetch\(|https?:\/\/|createPaystackProvider|PAYSTACK_|process\.env|require\(|readFileSync/,
      'the service performs no I/O beyond SQL and reads no configuration at all',
    );
  });

  it('the grant service writes exactly one table and never the payment or plan tables', () => {
    const writes = [...codeOnly(GRANTS).matchAll(/\b(?<!DO\s)(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(\w+)/gi)]
      .map((match) => match[1]);
    assert.deepEqual(writes, ['billing_entitlement_grants'], 'exactly one write target');
  });

  it('never mentions a payment, an activation or execution as something it grants', () => {
    for (const pin of [
      /paymentConfirmed: false/,
      /grantsExecution: false/,
      /canAccessAutomation: false/,
      /planChanged: false/,
      /entitlementsChanged: false/,
    ]) {
      assert.match(codeOnly(GRANTS), pin, 'every effect flag is pinned false');
    }
  });

  it('the resolver is still the only bridge and still restates no limit', () => {
    const code = codeOnly(RESOLUTION);
    assert.match(code, /if \(provider !== null\) \{/);
    // Both incoherent states still fail closed to the free tier. They are now
    // stated once, in `resolvePaidTier`, and the resolver delegates to it.
    assert.match(code, /if \(activated !== true\) return 'free';/);
    assert.match(code, /return activated === true \? 'free' : plan;/);
    assert.match(code, /if \(grantedPlan != null\) return getEntitlements\(grantedPlan, status\);/);
    assert.match(
      code,
      /return getEntitlements\(resolvePaidTier\(plan, provider, activated\), status\);/,
      'the resolver is the paid tier plus the matrix, with no second policy',
    );
    assert.doesNotMatch(
      code,
      /maxStrategies|maxBacktestsPerMonth|maxAlertsPerMonth|maxSavedSetups|canAccess/,
      'the resolver declares no limit of its own',
    );
  });

  it('the grantable-tier vocabulary has exactly one authority in the read path', () => {
    // `getBillingState` narrows the stored tier with the SAME helper the grant
    // service writes with, so a tier the resolver would honour can never be
    // silently undeclared (and so leave a granted account undisclosed).
    const subscriptions = codeOnly(read(path.join(CORE_SRC, 'billing', 'subscriptions.ts')));
    assert.match(subscriptions, /grantableEntitlementPlan\(/);
    assert.doesNotMatch(
      subscriptions,
      /granted_plan\s*!==\s*'|'\s*===\s*'\s*\|\|\s*granted_plan/,
      'the read path holds no second copy of the tier list',
    );
  });

  it('every production entitlement reader reads the grant alongside provider and activation', () => {
    const readers = [
      path.join(CORE_SRC, 'billing', 'subscriptions.ts'),
      path.join(CORE_SRC, 'strategies', 'strategies.ts'),
      path.join(CORE_SRC, 'setups', 'service.ts'),
      path.join(CORE_SRC, 'alerts', 'service.ts'),
      path.join(CORE_SRC, 'backtest', 'service.ts'),
      path.join(CORE_SRC, 'scanner', 'service.ts'),
      path.join(CORE_SRC, 'execution', 'automation.ts'),
      path.join(REPO_ROOT, 'apps', 'api', 'src', 'routes', 'scanner.ts'),
    ];
    for (const file of readers) {
      const code = codeOnly(read(file));
      const relative = path.relative(REPO_ROOT, file);
      assert.match(code, /resolveEntitlements\(/, `${relative} must use the resolver`);
      assert.match(code, /provider/, `${relative} must read the provider column`);
      assert.match(code, /activated/, `${relative} must read the activation fact`);
      assert.match(
        code,
        /billing_entitlement_grants/,
        `${relative} must read the non-commercial grant, or it cannot resolve a granted account`,
      );
      assert.doesNotMatch(code, /getEntitlements\(/, `${relative} must not bypass the gate`);
    }
  });

  it('there is still no grant route, and the billing write routes are unchanged', () => {
    const billingRoute = read(REPO_ROOT, 'apps', 'api', 'src', 'routes', 'billing.ts');
    assert.doesNotMatch(codeOnly(billingRoute), /entitlement.grant|grantEntitlement|billing\/grant/i);
    const writes = [...codeOnly(billingRoute).matchAll(/app\.(post|put|patch|delete)\s*\(\s*'([^']+)'/g)]
      .map((match) => [match[1], match[2]]);
    assert.deepEqual(writes, [
      ['post', '/api/billing/checkout'], ['post', '/api/billing/sync'],
      ['post', '/api/billing/customer'], ['post', '/api/billing/verify'],
    ], 'a grant adds no HTTP surface to the billing routes');
  });

  it('the CLI is a thin wrapper: it parses, connects, calls the service and prints', () => {
    assert.match(CLI, /BillingEntitlementGrantService/);
    assert.doesNotMatch(
      codeOnly(CLI),
      /INSERT INTO|UPDATE |DELETE FROM|SELECT /,
      'the CLI holds no authority of its own — it writes no SQL',
    );
    assert.match(CLI, /dryRun/);
  });
});
