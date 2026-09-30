/**
 * Billing — LEGACY FREE PLACEHOLDER ROW REMEDIATION
 * (`BillingLegacyFreeRowRemediationService` + the operator CLI), against a real
 * database.
 *
 * The production symptom this closes: a valid live checkout reaches the API and
 * answers `pricing_lock_required` (HTTP 409). Accounts created before Model C
 * carry a `free`/`active`, provider-less `subscriptions` row with
 * `locked_pricing_snapshot_id IS NULL` (migration 0014's backfill, or the
 * removed eager registration path). Migration 0032 makes the lock immutable at
 * creation, so such a row can never become commercial: it can only make the
 * first checkout fail closed. The free state is the ABSENCE of a commercial
 * record, so the row is removed out of band — by a named operator, one account
 * at a time, audited — and the account checks out normally again.
 *
 * What this suite pins:
 *
 *  1. THE REPORTED BUG, END TO END — a legacy placeholder makes a valid LIVE
 *     checkout fail with `pricing_lock_required`; after remediation the SAME
 *     checkout initializes against the live epoch, and the sold row that the
 *     normal row-less path writes carries its immutable pricing lock. A
 *     row-less (Model-C) account was never affected.
 *  2. NOTHING ELSE MOVES — the removal is entitlement-neutral
 *     (`getBillingState` answers the identical free DTO), `users.plan` is
 *     untouched, the provisioning `billing_customers` fact survives, and every
 *     other account/row is exactly as it was.
 *  3. REFUSES EVERYTHING THAT IS NOT A PLACEHOLDER — a sold/locked row, a row
 *     with provider identity, a period, a cancellation, a sync fact, an initial
 *     `state_version` change, or an account whose `users.plan` is not free, all
 *     refuse with the failed predicate NAMED, and nothing is written. Even a
 *     `processed` provider event (which the database's own retention trigger
 *     would let CASCADE away) refuses: no evidence is ever deleted.
 *  4. SAFE BY DEFAULT — a dry run validates the whole operation and writes
 *     nothing; `--apply` commits exactly one DELETE plus its
 *     `billing.legacy_free_row_removed` audit event; the audit event names the
 *     operator and the reason, carries a snapshot of the removed facts, and
 *     commits in the SAME transaction (a refusal writes no audit row at all).
 *     Re-running on an already remediated account reports `absent` and writes
 *     nothing.
 *  5. THE PREDICATE CANNOT DRIFT BEHIND THE SCHEMA — every commercial-state
 *     column of `subscriptions` is named by a declared predicate.
 *  6. NO ROUTE, NO TRANSPORT, NO KEY, NO LOCK WRITE — the module and the CLI
 *     contain no transport, no provider import, no secret and no environment
 *     read except the CLI's own `.env` boundary helper; the pricing lock is
 *     only ever READ (the 0032 trigger is left alone), and no statement in the
 *     module UPDATEs anything.
 *  7. THE OPERATOR CLI, END TO END — dry run, apply, idempotent re-run, usage
 *     errors (exit 2), refusals (exit 1) and the wired npm script.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Pool } from 'pg';
import {
  BILLING_LEGACY_FREE_ROW_REMEDIATION_AUDIT_ACTION,
  BillingCheckoutError,
  BillingCheckoutService,
  BillingLegacyFreeRowRemediationService,
  LEGACY_FREE_ROW_PREDICATES,
  createBillingProviderRegistry,
  createFreeSubscription,
  createUnimplementedBillingProvider,
  getBillingState,
  isBillingLegacyFreeRowRemediationError,
  verifyPricingSnapshot,
  type BillingCheckoutRequest,
} from '../src/index.js';
import {
  startBillingTestDb,
  insertEpoch,
  insertUser,
  retireActiveEpochs,
  seedCommercialSubscription,
  AS_OF,
  PRO_MONTHLY,
} from './helpers/billing-checkout.js';

const DB_PORT = 5545;
const OPERATOR = 'ops@example.test';
const REASON = 'pre-Model-C free placeholder blocked live checkout';
const AUDIT_ACTION = BILLING_LEGACY_FREE_ROW_REMEDIATION_AUDIT_ACTION;

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let pool: Pool;
let calls: BillingCheckoutRequest[];
let checkout: BillingCheckoutService;
let remediation: BillingLegacyFreeRowRemediationService;

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  pool = db.pool;
}, { timeout: 180_000 });

beforeEach(async () => {
  await retireActiveEpochs(pool);
  calls = [];
  // The composition the API uses for a LIVE deployment: the registered adapter
  // carries the domain, so checkout selects live epochs only.
  const providers = createBillingProviderRegistry();
  providers.register({
    ...createUnimplementedBillingProvider(),
    mode: 'live',
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
  checkout = new BillingCheckoutService({
    db: pool,
    providers,
    callbackUrl: 'https://app.example.test/settings',
    now: () => AS_OF,
    // The production precondition (Billing Step 6): the account's billing
    // customer must exist. Asserting it here pins that remediation never
    // removes the customer fact.
    requireExistingCustomer: async (userId: string) => {
      const { rows } = await pool.query(
        'SELECT 1 FROM billing_customers WHERE user_id = $1',
        [userId],
      );
      if (rows.length === 0) throw new Error('billing customer is missing');
    },
  });
  remediation = new BillingLegacyFreeRowRemediationService({ db: pool, now: () => AS_OF });
});

after(async () => {
  await db?.stop();
});

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

/** The 0014 backfill / pre-Model-C eager registration shape, verbatim. */
async function insertLegacyPlaceholder(userId: string): Promise<void> {
  await createFreeSubscription(pool, userId);
}

function subscriptionRow(userId: string) {
  return pool
    .query<{
      id: string;
      plan: string;
      status: string;
      provider: string | null;
      catalogue_plan: string | null;
      billing_interval: string | null;
      locked_pricing_snapshot_id: string | null;
      state_version: number;
    }>('SELECT * FROM subscriptions WHERE user_id = $1', [userId])
    .then((r) => r.rows[0]);
}

/** The remediation audit events for ONE account: the suite shares a database. */
function auditRows(userId: string) {
  return pool
    .query<{ entity_id: string | null; user_id: string | null; metadata: Record<string, unknown> }>(
      'SELECT * FROM audit_events WHERE action = $1 AND user_id = $2 ORDER BY id',
      [AUDIT_ACTION, userId],
    )
    .then((r) => r.rows);
}

async function auditCount(userId: string): Promise<number> {
  return (await auditRows(userId)).length;
}

/** Run the live checkout the way the API route does and return the outcome. */
async function liveCheckout(userId: string) {
  return checkout
    .checkout(userId, PRO_MONTHLY)
    .then((session) => ({ session, error: null as unknown }))
    .catch((error: unknown) => ({ session: null, error }));
}

/* ========================================================================== */
/* 1–2. The reported bug: repro, remediation, and the checkout that follows    */
/* ========================================================================== */

describe('legacy free row remediation — the production 409, end to end', () => {
  test('a legacy placeholder makes a valid LIVE checkout fail closed with pricing_lock_required', async () => {
    const user = await insertUser(pool); // has a billing customer, as the live UX does
    await insertLegacyPlaceholder(user.id);
    await insertEpoch(pool, { mode: 'live' });

    // The reported symptom, at its source: checkout refuses before pricing or
    // provider work, exactly as docs/billing.md's Model C section requires.
    const { session, error } = await liveCheckout(user.id);
    assert.equal(session, null);
    assert.ok(error instanceof BillingCheckoutError);
    assert.equal((error as BillingCheckoutError).reason, 'pricing_lock_required');
    assert.equal(calls.length, 0, 'nothing reached the provider');

    // The row is still a placeholder: the refusal changed nothing.
    const row = await subscriptionRow(user.id);
    assert.equal(row?.locked_pricing_snapshot_id, null);
    assert.equal(await auditCount(user.id), 0);
  });

  test('remediation removes only the placeholder and the SAME live checkout then initializes', async () => {
    const user = await insertUser(pool);
    await insertLegacyPlaceholder(user.id);
    await insertEpoch(pool, { mode: 'live' });
    const before = await getBillingState(pool, user.id, { mode: 'live' });

    // --- Dry run: validated, and nothing written at all. ---
    const dry = await remediation.remediate({
      user: user.email.toUpperCase(), // an email reference is still resolved
      operatorId: OPERATOR,
      reason: REASON,
    });
    assert.equal(dry.outcome, 'dry_run');
    assert.equal(dry.applied, false);
    assert.equal(dry.auditAction, null);
    assert.equal(dry.removedAt, null);
    assert.equal(dry.row?.plan, 'free');
    assert.equal(dry.row?.lockedPricingSnapshotId, null);
    assert.ok(await subscriptionRow(user.id), 'the dry run wrote nothing');
    assert.equal(await auditCount(user.id), 0);

    // --- Apply: one DELETE, one audit event, together. ---
    const applied = await remediation.remediate({
      user: user.id,
      operatorId: OPERATOR,
      reason: REASON,
      apply: true,
    });
    assert.equal(applied.outcome, 'removed');
    assert.equal(applied.applied, true);
    assert.equal(applied.auditAction, AUDIT_ACTION);
    assert.equal(applied.removedAt, AS_OF.toISOString());
    assert.equal(applied.row?.subscriptionId, dry.row?.subscriptionId);
    assert.equal(await subscriptionRow(user.id), undefined, 'the placeholder is gone');

    // --- The audit record: one row, naming who, why and what was removed. ---
    const audits = await auditRows(user.id);
    assert.equal(audits.length, 1);
    const audit = audits[0]!;
    assert.equal(audit.entity_id, applied.row?.subscriptionId);
    assert.equal(audit.user_id, user.id);
    assert.equal(audit.metadata.operatorId, OPERATOR);
    assert.equal(audit.metadata.reason, REASON);
    assert.equal(audit.metadata.source, 'operator_cli');
    assert.deepEqual(audit.metadata.guards, {
      providerEvents: 0,
      verifiedTransactions: 0,
      activations: 0,
    });
    assert.deepEqual(audit.metadata.removedSubscription, applied.row);

    // --- ENTITLEMENT PARITY: every entitlement, access and provider fact is
    //     unchanged; the ONLY reported difference is the commercial identity,
    //     which becomes the documented '' of a state that was never sold. ---
    const after = await getBillingState(pool, user.id, { mode: 'live' });
    assert.deepEqual(after.entitlements, before.entitlements);
    assert.deepEqual(after.providerStatus, before.providerStatus);
    assert.equal(after.mode, before.mode);
    assert.equal(after.subscription.plan, 'free');
    assert.equal(after.subscription.status, 'active');
    assert.equal(after.subscription.currentPeriodEnd, null);
    assert.equal(after.subscription.cancelAtPeriodEnd, false);
    assert.equal(before.subscription.id, applied.row?.subscriptionId);
    assert.equal(after.subscription.id, '', 'nothing was ever sold: no commercial identity');

    // The account's enforcement column and its provisioning customer survive:
    // remediation removes the sale-less placeholder, nothing else.
    const { rows: userRows } = await pool.query<{ plan: string }>(
      'SELECT plan FROM users WHERE id = $1',
      [user.id],
    );
    assert.equal(userRows[0]?.plan, 'free');

    // --- The same live checkout now takes the normal row-less path. ---
    const { session, error } = await liveCheckout(user.id);
    assert.equal(error, null, `checkout must not refuse: ${String(error)}`);
    assert.equal(session?.status, 'initialized');
    assert.equal(calls.length, 1, 'exactly one provider checkout was initialized');
    assert.equal(calls[0]?.plan.cataloguePlan, 'pro');

    // The sale wrote the LOCKED commercial row atomically — the invariant the
    // placeholder could never satisfy.
    const sold = await subscriptionRow(user.id);
    assert.equal(sold?.provider, 'paystack');
    assert.equal(sold?.plan, 'pro');
    assert.equal(sold?.catalogue_plan, 'pro');
    assert.equal(sold?.billing_interval, 'monthly');
    assert.ok(sold?.locked_pricing_snapshot_id, 'the sold row carries its pricing lock');
  });

  test('a row-less Model-C account was never affected — and is reported `absent`', async () => {
    const user = await insertUser(pool);
    await insertEpoch(pool, { mode: 'live' });

    // Remediation of a row-less account is a finding, not an error: the account
    // already IS the supported free state, so --apply writes nothing at all.
    const result = await remediation.remediate({
      user: user.id,
      operatorId: OPERATOR,
      reason: REASON,
      apply: true,
    });
    assert.equal(result.outcome, 'absent');
    assert.equal(result.applied, false);
    assert.equal(result.row, null);
    assert.equal(result.auditAction, null);
    assert.equal(await auditCount(user.id), 0, 'nothing to remediate writes no audit event');

    // And this account was never the bug: its live checkout initializes.
    const { session, error } = await liveCheckout(user.id);
    assert.equal(error, null);
    assert.equal(session?.status, 'initialized');
  });
});

/* ========================================================================== */
/* 3. Refusals — nothing that is not a placeholder is ever deleted             */
/* ========================================================================== */

describe('legacy free row remediation — refusals', () => {
  test('refuses a sold, provider-backed, locked row', async () => {
    const user = await insertUser(pool);
    const commercial = await seedCommercialSubscription(pool, user.id, { mode: 'live' });

    const error = await remediation
      .remediate({ user: user.id, operatorId: OPERATOR, reason: REASON, apply: true })
      .then(() => null, (e: unknown) => e);
    assert.ok(isBillingLegacyFreeRowRemediationError(error));
    assert.equal(error.reason, 'no_legacy_free_row');
    assert.ok(error.failedPredicates?.includes('pricing_lock_is_null'));
    assert.ok(error.failedPredicates?.includes('provider_is_null'));

    // The sold row is intact and still checks out under ITS lock.
    const row = await subscriptionRow(user.id);
    assert.equal(row?.id, commercial.subscriptionId);
    assert.equal(row?.locked_pricing_snapshot_id, commercial.pricingSnapshotId);
    assert.equal(await auditCount(user.id), 0);
    const { session, error: checkoutError } = await liveCheckout(user.id);
    assert.equal(checkoutError, null);
    assert.equal(session?.status, 'initialized');
  });

  test('refuses when the account claims a paid plan', async () => {
    const user = await insertUser(pool);
    await insertLegacyPlaceholder(user.id);
    await pool.query("UPDATE users SET plan = 'pro' WHERE id = $1", [user.id]);

    const error = await remediation
      .remediate({ user: user.id, operatorId: OPERATOR, reason: REASON, apply: true })
      .then(() => null, (e: unknown) => e);
    assert.ok(isBillingLegacyFreeRowRemediationError(error));
    assert.equal(error.reason, 'no_legacy_free_row');
    assert.deepEqual(error.failedPredicates, ['account_plan_is_free']);
    assert.ok(await subscriptionRow(user.id), 'nothing was deleted');
    assert.equal(await auditCount(user.id), 0);
  });

  test('refuses a placeholder carrying a PROCESSED provider event: no CASCADE ever erases evidence', async () => {
    const user = await insertUser(pool);
    await insertLegacyPlaceholder(user.id);
    const row = await subscriptionRow(user.id);
    // The database's own retention trigger only protects `received` events, so
    // a `processed` event would be CASCADE-deleted silently. This tool refuses
    // on ANY event row: evidence is never removed, not even by cascade.
    const idempotencyKey = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await pool.query(
      `INSERT INTO billing_provider_events
         (event_type, idempotency_key, payload_hash, subscription_id, user_id, status, processed_at)
       VALUES ('payment.succeeded', $1, $2, $3, $4, 'processed', now())`,
      [idempotencyKey, 'f'.repeat(64), row!.id, user.id],
    );

    const error = await remediation
      .remediate({ user: user.id, operatorId: OPERATOR, reason: REASON, apply: true })
      .then(() => null, (e: unknown) => e);
    assert.ok(isBillingLegacyFreeRowRemediationError(error));
    assert.equal(error.reason, 'no_legacy_free_row');
    assert.deepEqual(error.failedPredicates, ['no_provider_events']);

    const surviving = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM billing_provider_events WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    assert.equal(surviving.rows[0]?.n, 1, 'the event row survives');
    assert.ok(await subscriptionRow(user.id), 'the placeholder survives');
    assert.equal(await auditCount(user.id), 0);
  });

  /**
   * One legal mutation per predicate CATEGORY: the refusal must name the
   * predicate that failed. (Some columns cannot be mutated alone — e.g. a
   * provider identity requires `provider` — so they are covered by the row
   * above and by the completeness pin below.)
   */
  const DRIFT: ReadonlyArray<{ predicate: string; sql: string }> = [
    { predicate: 'plan_is_free', sql: "UPDATE subscriptions SET plan = 'premium' WHERE user_id = $1" },
    { predicate: 'status_is_active', sql: "UPDATE subscriptions SET status = 'trialing' WHERE user_id = $1" },
    { predicate: 'catalogue_version_is_null', sql: "UPDATE subscriptions SET catalogue_version = 'catalogue.v1' WHERE user_id = $1" },
    { predicate: 'provider_is_null', sql: "UPDATE subscriptions SET provider = 'paystack' WHERE user_id = $1" },
    { predicate: 'provider_state_is_null', sql: "UPDATE subscriptions SET provider = 'paystack', provider_state = 'pending' WHERE user_id = $1" },
    { predicate: 'current_period_start_is_null', sql: 'UPDATE subscriptions SET current_period_start = now() WHERE user_id = $1' },
    { predicate: 'current_period_end_is_null', sql: 'UPDATE subscriptions SET current_period_end = now() WHERE user_id = $1' },
    { predicate: 'cancel_at_period_end_is_false', sql: 'UPDATE subscriptions SET cancel_at_period_end = true WHERE user_id = $1' },
    { predicate: 'cancel_at_is_null', sql: 'UPDATE subscriptions SET cancel_at = now() WHERE user_id = $1' },
    { predicate: 'cancelled_at_is_null', sql: "UPDATE subscriptions SET status = 'canceled', cancelled_at = now() WHERE user_id = $1" },
    { predicate: 'sync_state_is_never_synced', sql: "UPDATE subscriptions SET sync_state = 'synced', last_sync_source = 'manual', last_synced_at = now() WHERE user_id = $1" },
    { predicate: 'sync_required_is_false', sql: 'UPDATE subscriptions SET sync_required = true WHERE user_id = $1' },
    { predicate: 'state_version_is_initial', sql: 'UPDATE subscriptions SET state_version = 2 WHERE user_id = $1' },
    { predicate: 'last_event_idempotency_key_is_null', sql: "UPDATE subscriptions SET last_event_idempotency_key = repeat('a', 64) WHERE user_id = $1" },
  ];

  for (const drift of DRIFT) {
    test(`refuses drift: ${drift.predicate} (${drift.sql.slice(0, 52)}…)`, async () => {
      const user = await insertUser(pool);
      await insertLegacyPlaceholder(user.id);
      await pool.query(drift.sql, [user.id]);

      const error = await remediation
        .remediate({ user: user.id, operatorId: OPERATOR, reason: REASON, apply: true })
        .then(() => null, (e: unknown) => e);
      assert.ok(isBillingLegacyFreeRowRemediationError(error), `${drift.predicate} must refuse`);
      assert.equal(error.reason, 'no_legacy_free_row');
      assert.ok(
        error.failedPredicates?.includes(drift.predicate),
        `refusal must name ${drift.predicate}: got ${error.failedPredicates?.join(', ')}`,
      );
      assert.ok(await subscriptionRow(user.id), 'the drifted row survives');
      assert.equal(await auditCount(user.id), 0, 'a refusal writes no audit event');
    });
  }

  test('refuses an unknown account, an empty reference and invalid operator text', async () => {
    const user = await insertUser(pool);
    await insertLegacyPlaceholder(user.id);

    const unknown = await remediation
      .remediate({ user: 'nobody@example.test', operatorId: OPERATOR, reason: REASON, apply: true })
      .then(() => null, (e: unknown) => e);
    assert.ok(isBillingLegacyFreeRowRemediationError(unknown));
    assert.equal(unknown.reason, 'unknown_user');

    const blank = await remediation
      .remediate({ user: '   ', operatorId: OPERATOR, reason: REASON, apply: true })
      .then(() => null, (e: unknown) => e);
    assert.ok(isBillingLegacyFreeRowRemediationError(blank));
    assert.equal(blank.reason, 'unknown_user');

    for (const [operatorId, reason] of [
      ['', REASON],
      ['   ', REASON],
      [OPERATOR, ''],
      ['a'.repeat(129), REASON],
      [OPERATOR, 'b'.repeat(501)],
      // The SHARED credential-shape rule (the same one the activation and
      // provisioning services apply): keyword material is refused, never
      // recorded in an audit event.
      ['api_key_0123456789abcdef', REASON],
      [OPERATOR, 'presented credential: bearer abc'],
    ] as const) {
      const error = await remediation
        .remediate({ user: user.id, operatorId, reason, apply: true })
        .then(() => null, (e: unknown) => e);
      assert.ok(
        isBillingLegacyFreeRowRemediationError(error),
        `operator text must be validated: ${operatorId.slice(0, 12)}/${reason.slice(0, 12)}`,
      );
      assert.equal(error.reason, 'invalid_operator');
    }

    assert.ok(await subscriptionRow(user.id));
    assert.equal(await auditCount(user.id), 0);
  });

  test('refuses on a concurrent change instead of deleting on stale terms', async () => {
    const user = await insertUser(pool);
    await insertLegacyPlaceholder(user.id);

    // Simulate a writer that flips the row AFTER the eligibility check but
    // BEFORE the DELETE commits: the DELETE's own WHERE clause must not match,
    // and the transaction must refuse rather than report a removal.
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM subscriptions WHERE user_id = $1 FOR UPDATE', [user.id]);
      const pending = remediation.remediate({
        user: user.id,
        operatorId: OPERATOR,
        reason: REASON,
        apply: true,
      });
      // The service blocks on the row lock (SELECT … FOR UPDATE / DELETE); once
      // the competing transaction commits its drift, the predicate is re-checked
      // against the new row version and the DELETE matches nothing.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await other.query(
        "UPDATE subscriptions SET cancelled_at = now(), status = 'canceled' WHERE user_id = $1",
        [user.id],
      );
      await other.query('COMMIT');
      const error = await pending.then(() => null, (e: unknown) => e);
      assert.ok(isBillingLegacyFreeRowRemediationError(error), `expected a refusal, got ${String(error)}`);
      assert.ok(
        error.reason === 'concurrent_change' || error.reason === 'no_legacy_free_row',
        `expected a stale-terms refusal, got ${error.reason}`,
      );
    } finally {
      other.release();
    }

    assert.ok(await subscriptionRow(user.id), 'the drifted row survives');
    assert.equal(await auditCount(user.id), 0, 'no removal was recorded');
  });
});

/* ========================================================================== */
/* 5. The predicate cannot drift behind the schema                             */
/* ========================================================================== */

describe('legacy free row remediation — the predicate covers the schema', () => {
  test('every commercial-state column of `subscriptions` is named by a predicate', async () => {
    const predicateSql = LEGACY_FREE_ROW_PREDICATES.map((p) => p.sql).join(' AND ');
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'subscriptions'`,
    );
    // Identity, ownership, currency (single-valued) and timestamps are not
    // commercial state. Every OTHER column must appear in the predicate, so a
    // future migration that adds a commercial column to `subscriptions` fails
    // this test until the destructive tool's eligibility grows with it.
    const exempt = new Set(['id', 'user_id', 'currency', 'created_at', 'updated_at']);
    const missing = rows
      .map((r) => r.column_name)
      .filter((column) => !exempt.has(column) && !predicateSql.includes(column));
    assert.deepEqual(missing, [], `predicate is missing: ${missing.join(', ')}`);

    // The refusals above are the behavioural half of this pin: every predicate
    // is reachable, so none of them is decoration.
    assert.equal(new Set(LEGACY_FREE_ROW_PREDICATES.map((p) => p.name)).size,
      LEGACY_FREE_ROW_PREDICATES.length, 'predicate names are unique');
  });
});

/* ========================================================================== */
/* 6. The boundary it keeps                                                    */
/* ========================================================================== */

describe('legacy free row remediation — the boundary it keeps', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (relative: string) =>
    readFileSync(path.resolve(here, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('the module has no transport, no provider, no secret, no environment and no lock write', () => {
    const module = read('../src/billing/legacy-free-row-remediation.ts');
    assert.doesNotMatch(module, /\bfetch\s*\(/, 'no transport');
    assert.doesNotMatch(module, /https?:\/\//, 'no provider URL');
    assert.doesNotMatch(module, /provider-paystack|PaystackFetchFn|createPaystackProvider/, 'no provider import');
    assert.doesNotMatch(module, /process\.env/, 'no environment read in the module');
    assert.doesNotMatch(module, /PAYSTACK_SECRET_KEY|sk_live_|sk_test_/, 'no key material');
    assert.doesNotMatch(module, /resolveEntitlements|BillingActivationService|canAccessAutomation/, 'no entitlement path');
    // The lock is READ only: no UPDATE anywhere, and in particular no write to
    // the immutable lock column or the trigger that guards it.
    assert.doesNotMatch(module, /\bUPDATE\s+subscriptions\b/i, 'never updates a subscription');
    assert.doesNotMatch(module, /SET\s+locked_pricing_snapshot_id/i, 'never writes the pricing lock');
    assert.doesNotMatch(module, /DROP\s+TRIGGER|ALTER\s+TABLE|CREATE\s+TRIGGER/i, 'never touches the schema');
    // The one and only write is the audited DELETE.
    assert.match(module, /DELETE FROM subscriptions s/);
    assert.match(module, /recordAuditEvent\(client, \{/);
  });

  test('the CLI is operator tooling: one environment boundary, no transport, no key, no domain', () => {
    const cli = read('../../../scripts/billing/remediate-legacy-free-row.ts');
    assert.doesNotMatch(cli, /\bfetch\s*\(/, 'no transport');
    assert.doesNotMatch(cli, /https?:\/\//, 'no provider URL');
    assert.doesNotMatch(cli, /provider-paystack|PaystackFetchFn|createPaystackProvider/, 'no provider import');
    assert.doesNotMatch(cli, /PAYSTACK_SECRET_KEY|sk_live_|sk_test_/, 'no key material');
    // The only environment read is the CLI's own boundary helper: environment
    // first, then the repo-root `.env` — never inside a business module.
    assert.equal((cli.match(/process\.env/g) ?? []).length, 1);
    assert.match(cli, /return process\.env\[key\] \?\? readDotEnvValue\(key\)/);
    assert.match(cli, /DATABASE_URL/, 'the only configuration is the database');
    // No provider DOMAIN is consulted: a placeholder row carries none, and this
    // tool touches no provider fact in either domain.
    assert.doesNotMatch(cli, /PAYSTACK_MODE/);
  });

  test('the npm script is wired to the CLI', () => {
    const pkg = JSON.parse(read('../../../package.json')) as {
      scripts: Record<string, string>;
    };
    assert.equal(
      pkg.scripts['billing:remediate:legacy-free-row'],
      'tsx scripts/billing/remediate-legacy-free-row.ts',
    );
  });
});

/* ========================================================================== */
/* 7. The operator CLI, end to end                                             */
/* ========================================================================== */

describe('legacy free row remediation — the operator CLI', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');

  /** Run the CLI exactly as an operator would, in a child process. */
  function cli(env: Record<string, string>, args: readonly string[]) {
    return spawnSync('node', ['--import', 'tsx', 'scripts/billing/remediate-legacy-free-row.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    });
  }

  test('dry run validates and writes nothing; --apply removes and audits; re-run reports absent', async () => {
    const user = await insertUser(pool);
    await insertLegacyPlaceholder(user.id);
    const row = await subscriptionRow(user.id);

    const dry = cli({ DATABASE_URL: db.dbUrl }, [
      '--user', user.email, '--by', OPERATOR, '--reason', REASON,
    ]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).outcome, 'dry_run');
    assert.ok(await subscriptionRow(user.id), 'the dry run wrote nothing');
    assert.equal(await auditCount(user.id), 0);

    const applied = cli({ DATABASE_URL: db.dbUrl }, [
      '--user', user.id, '--by', OPERATOR, '--reason', REASON, '--apply',
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    const appliedJson = JSON.parse(applied.stdout);
    assert.equal(appliedJson.outcome, 'removed');
    assert.equal(appliedJson.applied, true);
    assert.equal(appliedJson.removedSubscription.subscriptionId, row?.id);
    assert.equal(appliedJson.auditAction, AUDIT_ACTION);
    assert.equal(await subscriptionRow(user.id), undefined);
    assert.equal(await auditCount(user.id), 1);

    const again = cli({ DATABASE_URL: db.dbUrl }, [
      '--user', user.id, '--by', OPERATOR, '--reason', REASON, '--apply',
    ]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).outcome, 'absent');
    assert.equal(await auditCount(user.id), 1, 'a re-run writes no second audit event');
  });

  test('usage errors exit 2; refusals exit 1; nothing is written either way', async () => {
    const user = await insertUser(pool);
    await insertLegacyPlaceholder(user.id);

    const missingBy = cli({ DATABASE_URL: db.dbUrl }, ['--user', user.id, '--reason', REASON]);
    assert.equal(missingBy.status, 2);
    assert.match(missingBy.stderr, /--by/);

    const contradictory = cli({ DATABASE_URL: db.dbUrl }, [
      '--user', user.id, '--by', OPERATOR, '--reason', REASON, '--apply', '--dry-run',
    ]);
    assert.equal(contradictory.status, 2);
    assert.match(contradictory.stderr, /mutually exclusive/);

    const noDatabase = cli({ DATABASE_URL: '' }, [
      '--user', user.id, '--by', OPERATOR, '--reason', REASON,
    ]);
    assert.equal(noDatabase.status, 2);
    assert.match(noDatabase.stderr, /DATABASE_URL is not set/);

    const unknown = cli({ DATABASE_URL: db.dbUrl }, [
      '--user', 'nobody@example.test', '--by', OPERATOR, '--reason', REASON, '--apply',
    ]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown_user/);

    // A sold row refuses with the failed predicate named.
    const buyer = await insertUser(pool);
    await seedCommercialSubscription(pool, buyer.id, { mode: 'live' });
    const sold = cli({ DATABASE_URL: db.dbUrl }, [
      '--user', buyer.id, '--by', OPERATOR, '--reason', REASON, '--apply',
    ]);
    assert.equal(sold.status, 1);
    assert.match(sold.stderr, /no_legacy_free_row/);
    assert.match(sold.stderr, /pricing_lock_is_null/);

    assert.ok(await subscriptionRow(user.id), 'every refusal left the placeholder alone');
    assert.ok(await subscriptionRow(buyer.id), 'every refusal left the sold row alone');
    assert.equal(await auditCount(user.id), 0);
    assert.equal(await auditCount(buyer.id), 0);
  });
});
