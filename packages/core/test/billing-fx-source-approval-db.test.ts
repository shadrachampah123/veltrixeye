/**
 * Billing Step 4 remediation — FX SOURCE APPROVAL, enforced by PostgreSQL.
 *
 * PR #150 review findings addressed here:
 *   H2  an approval was free text (`approvedBy`) and unauthenticated;
 *       approver and publisher could be the same person.
 *   H3  approvals lived in mutable `audit_events` rows that anyone with table
 *       access could insert, update or delete.
 *   H4  one approval published any number of rates, and nothing bound the
 *       approval to the rate, the source, the reference or the instants.
 *
 * Every case below runs against a real embedded PostgreSQL 18 cluster with the
 * full migration set (0040 included). Principals are real LOGINS: an approver,
 * a publisher and an ordinary application login. The database decides who may
 * do what; this suite never sets a role or flag in application code.
 *
 * HONEST SCOPE. The DBA script (`scripts/billing/fx-approval-roles.sql`) is run
 * in the fixture, so the protected objects are owned by the dedicated NOLOGIN
 * owner role, NOT by the application login. The fixture's test superuser can
 * still bypass the triggers (the documented superuser trust boundary); the suite
 * proves the controls against every NON-owner principal (the application login
 * and the approver/publisher logins), proves the owner-level append-only
 * triggers fire on UPDATE, DELETE and TRUNCATE, and proves the fail-closed
 * ownership assertion refuses a mis-owned object.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type {
  BillingFxError} from '../src/index.js';
import {
  BillingFxRateVersionStore,
  createPool,
  BillingFxSourceApprovalStore,
  DatabaseIdentityError,
  DATABASE_IDENTITY_ALLOWLIST_RELATIVE_PATH,
  FX_APPROVAL_VALIDITY_SECONDS,
  FX_RATE_PUBLISHED_AUDIT_ACTION,
  FX_SOURCE_APPROVED_AUDIT_ACTION,
  isBillingFxError,
  loadDatabaseIdentityAllowlist,
  parseDatabaseIdentityAllowlist,
  resolveDatabaseTarget,
} from '../src/index.js';
import {
  createFxPrincipals,
  createPlainLogin,
  databaseUrlAsLogin,
  publishApprovedFx,
  startBillingTestDb,
  type FxPrincipals,
} from './helpers/billing-checkout.js';

// Unique per suite file (see the port ledger in helpers/billing-checkout.ts).
const DB_PORT = 5613;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const EFFECTIVE = new Date('2026-10-01T09:00:00.000Z');
const CAPTURED = new Date('2026-10-01T08:59:00.000Z');
const REFERENCE = 'ops-fx-board-approval-1';
const FX_RATE = 12_500_000n;

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let FX: FxPrincipals;
let app: Awaited<ReturnType<typeof createPlainLogin>>;
let instant = 0;

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  FX = await createFxPrincipals(db.pool, db.dbUrl);
  app = await createPlainLogin(db.pool, db.dbUrl, 'fx_app');
}, { timeout: 240_000 });

after(async () => {
  await app?.pool.end();
  await FX?.close();
  await db?.stop();
});

beforeEach(() => {
  // Every test publishes at its own instant, so versions never collide.
  instant += 1;
});

/** A fresh, distinct effective/capture pair for one test. */
function instants(): { effectiveFrom: Date; capturedAt: Date } {
  const effectiveFrom = new Date(EFFECTIVE.getTime() + instant * 60_000);
  const capturedAt = new Date(CAPTURED.getTime() + instant * 60_000);
  return { effectiveFrom, capturedAt };
}

async function refusalOf(run: () => Promise<unknown>): Promise<BillingFxError> {
  try {
    await run();
  } catch (error) {
    if (isBillingFxError(error)) return error;
    throw error;
  }
  assert.fail('expected a typed FX refusal, but the operation succeeded');
}

function approvalInput(overrides: Partial<Parameters<BillingFxSourceApprovalStore['recordApproval']>[0]> = {}) {
  const { effectiveFrom, capturedAt } = instants();
  return {
    source: 'ops' as const,
    sourceReference: REFERENCE,
    fxRateScaled: FX_RATE,
    fxRateScale: 6,
    effectiveFrom,
    capturedAt,
    reason: 'approve the USD→GHS rate from the approved ops board for this publication',
    ...overrides,
  };
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query(sql, params);
  return Number((rows[0] as { n: string | number }).n);
}

/* ========================================================================== */
/* H2 — who may approve, and who may publish                                   */
/* ========================================================================== */

describe('H2 — authenticated, authorized principals only', () => {
  test('an ordinary application login cannot record an approval (no membership)', async () => {
    const error = await refusalOf(() => new BillingFxSourceApprovalStore(app.pool, undefined, FX.identity).recordApproval(approvalInput()));
    assert.equal(error.reason, 'principal_unauthorized');
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approvals WHERE approver_principal = $1', [app.login]), 0);
  });

  test('the publisher login cannot record an approval — it is not an approver', async () => {
    const error = await refusalOf(() => new BillingFxSourceApprovalStore(FX.publisherPool, undefined, FX.identity).recordApproval(approvalInput()));
    assert.equal(error.reason, 'principal_unauthorized');
  });

  test('the approver login cannot publish — it is not a publisher', async () => {
    const approval = await FX.approvals.recordApproval(approvalInput());
    const error = await refusalOf(() =>
      new BillingFxRateVersionStore(FX.approverPool, undefined, FX.identity).publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom: approval.effectiveFrom,
        capturedAt: approval.capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      }),
    );
    assert.equal(error.reason, 'principal_unauthorized');
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.approvalId]), 0);
  });

  test('the approval records the AUTHENTICATED login, never a caller-supplied name', async () => {
    const approval = await FX.approvals.recordApproval(approvalInput());
    assert.equal(approval.approverPrincipal, FX.approverLogin);
    const { rows } = await db.pool.query(
      'SELECT approver_principal FROM billing_fx_source_approvals WHERE id = $1',
      [approval.approvalId],
    );
    assert.equal(rows[0]!.approver_principal, FX.approverLogin);
    // The store's input type has no approver field at all: a caller cannot name one.
    assert.equal('approvedBy' in (approvalInput() as Record<string, unknown>), false);
  });

  test('the audit trail names the approver and the publisher logins, not free text', async () => {
    const version = await publishApprovedFx(FX, { ...instants(), sourceReference: REFERENCE, reason: 'audit trail' });
    const approvedAudit = await db.pool.query(
      `SELECT metadata FROM audit_events WHERE action = $1 AND entity_id = $2`,
      [FX_SOURCE_APPROVED_AUDIT_ACTION, (await consumptionFor(version.id))!.approval_id],
    );
    assert.equal((approvedAudit.rows[0]!.metadata as Record<string, unknown>).approverPrincipal, FX.approverLogin);
    const publishedAudit = await db.pool.query(
      `SELECT metadata FROM audit_events WHERE action = $1 AND entity_id = $2`,
      [FX_RATE_PUBLISHED_AUDIT_ACTION, version.id],
    );
    const metadata = publishedAudit.rows[0]!.metadata as Record<string, unknown>;
    assert.equal(metadata.approverPrincipal, FX.approverLogin);
    assert.equal(metadata.publisherPrincipal, FX.publisherLogin);
  });

  test('separation of duties: one login holding BOTH roles cannot approve and publish its own approval', async () => {
    const both = `fx_both_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const password = randomUUID();
    await db.pool.query(`CREATE ROLE "${both}" LOGIN PASSWORD '${password}'`);
    await db.pool.query(`GRANT veltrixeye_fx_approver, veltrixeye_fx_publisher TO "${both}"`);
    const bothPool = createPool({ databaseUrl: databaseUrlAsLogin(db.dbUrl, both, password) });
    try {
      const approval = await new BillingFxSourceApprovalStore(bothPool, undefined, FX.identity).recordApproval(approvalInput());
      assert.equal(approval.approverPrincipal, both);
      const error = await refusalOf(() =>
        new BillingFxRateVersionStore(bothPool, undefined, FX.identity).publish({
          fxRateScaled: FX_RATE,
          fxRateScale: 6,
          effectiveFrom: approval.effectiveFrom,
          capturedAt: approval.capturedAt,
          source: 'ops',
          sourceReference: REFERENCE,
          sourceApprovalId: approval.approvalId,
        }),
      );
      assert.equal(error.reason, 'separation_of_duties');
      assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.approvalId]), 0);
    } finally {
      await bothPool.end();
    }
  });

  test('the schema itself refuses a consumption whose approver equals its publisher', async () => {
    // A rate version with no consumption yet (owner fixture insert, as the other suites do).
    const { effectiveFrom, capturedAt } = instants();
    const { rows: versionRows } = await db.pool.query(
      `INSERT INTO billing_fx_rate_versions (fx_rate_scaled, fx_rate_scale, source, effective_from, captured_at)
       VALUES (12500000, 6, 'ops', $1, $2) RETURNING id`,
      [effectiveFrom, capturedAt],
    );
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    await assert.rejects(
      db.pool.query(
        `INSERT INTO billing_fx_source_approval_consumptions
           (approval_id, fx_rate_version_id, approver_principal, publisher_principal, consumed_at)
         VALUES ($1, $2, 'same-login', 'same-login', now())`,
        [approval.approvalId, versionRows[0]!.id],
      ),
      (error: { code?: string }) => error.code === '23514',
    );
  });
});

/* ========================================================================== */
/* H3 — append-only records, and no ordinary write path                        */
/* ========================================================================== */

describe('H3 — approval records are append-only and not writable by the application', () => {
  test('the application login cannot INSERT a forged approval row', async () => {
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_fx_source_approvals (source, source_reference, base_currency, quote_currency,
           fx_rate_scaled, fx_rate_scale, rounding_mode, effective_from, captured_at, fingerprint, reason,
           approver_principal, approved_at, expires_at)
         VALUES ('ops', 'forged', 'USD', 'GHS', 1, 6, 'half_up', now(), now(), 'x', 'forged', 'someone', now(), now() + interval '1 hour')`,
      ),
      (error: { code?: string }) => error.code === '42501',
    );
  });

  test('a forged billing.fx_source_approved AUDIT row cannot publish — it is not an approval', async () => {
    await db.pool.query(
      `INSERT INTO audit_events (user_id, action, entity_type, entity_id, metadata)
       VALUES (NULL, $1, 'billing_fx_source_approval', '987654321',
               jsonb_build_object('approvalId','987654321','approverPrincipal','someone-else'))`,
      [FX_SOURCE_APPROVED_AUDIT_ACTION],
    );
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approvals WHERE id = 987654321'), 0);
    const { effectiveFrom, capturedAt } = instants();
    const error = await refusalOf(() =>
      new BillingFxRateVersionStore(FX.publisherPool, undefined, FX.identity).publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom,
        capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: '987654321',
      }),
    );
    assert.equal(error.reason, 'source_not_approved');
  });

  test('UPDATE of an approval is refused for the owner (trigger) and for the application (privilege)', async () => {
    const approval = await FX.approvals.recordApproval(approvalInput());
    await assert.rejects(
      db.pool.query('UPDATE billing_fx_source_approvals SET reason = $2 WHERE id = $1', [approval.approvalId, 'rewritten']),
      (error: { code?: string; message?: string }) =>
        error.code === '42501' && /append-only/.test(error.message ?? ''),
    );
    await assert.rejects(
      app.pool.query('UPDATE billing_fx_source_approvals SET reason = $2 WHERE id = $1', [approval.approvalId, 'x']),
      (error: { code?: string }) => error.code === '42501',
    );
    const { rows } = await db.pool.query('SELECT reason FROM billing_fx_source_approvals WHERE id = $1', [approval.approvalId]);
    assert.equal(rows[0]!.reason, approvalInput().reason, 'the stored reason is unchanged');
  });

  test('DELETE of an approval is refused for the owner (trigger) and for the application (privilege)', async () => {
    const approval = await FX.approvals.recordApproval(approvalInput());
    await assert.rejects(
      db.pool.query('DELETE FROM billing_fx_source_approvals WHERE id = $1', [approval.approvalId]),
      (error: { code?: string }) => error.code === '42501',
    );
    await assert.rejects(
      app.pool.query('DELETE FROM billing_fx_source_approvals WHERE id = $1', [approval.approvalId]),
      (error: { code?: string }) => error.code === '42501',
    );
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approvals WHERE id = $1', [approval.approvalId]), 1);
  });

  test('TRUNCATE is refused: approvals by the foreign key, consumptions by the statement trigger', async () => {
    // Approvals are referenced by consumptions, so PostgreSQL refuses the
    // statement before any trigger runs (0A000). Either way nothing is removed.
    const before = await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approvals');
    await assert.rejects(
      db.pool.query('TRUNCATE billing_fx_source_approvals'),
      (error: { code?: string }) => error.code === '0A000' || error.code === '42501',
    );
    // Consumptions are referenced by nothing, so the append-only trigger is what refuses.
    await assert.rejects(
      db.pool.query('TRUNCATE billing_fx_source_approval_consumptions'),
      (error: { code?: string; message?: string }) =>
        error.code === '42501' && /append-only/.test(error.message ?? ''),
    );
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approvals'), before);
  });

  test('UPDATE and DELETE of a consumption are refused for the owner', async () => {
    const version = await publishApprovedFx(FX, { ...instants(), sourceReference: REFERENCE });
    const consumption = await consumptionFor(version.id);
    assert.ok(consumption, 'the publication consumed exactly one approval');
    await assert.rejects(
      db.pool.query('UPDATE billing_fx_source_approval_consumptions SET publisher_principal = $1 WHERE approval_id = $2', ['x', consumption.approval_id]),
      (error: { code?: string }) => error.code === '42501',
    );
    await assert.rejects(
      db.pool.query('DELETE FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [consumption.approval_id]),
      (error: { code?: string }) => error.code === '42501',
    );
  });

  test('the application login cannot write rate versions directly, and cannot call publish by hand', async () => {
    const { effectiveFrom, capturedAt } = instants();
    await assert.rejects(
      app.pool.query(
        `INSERT INTO billing_fx_rate_versions (fx_rate_scaled, fx_rate_scale, source, effective_from, captured_at)
         VALUES (12500000, 6, 'ops', $1, $2)`,
        [effectiveFrom, capturedAt],
      ),
      (error: { code?: string }) => error.code === '42501',
    );
    await assert.rejects(
      app.pool.query(`SELECT billing_publish_fx_rate_version(1::bigint,'ops','x','USD','GHS',1::bigint,6,'half_up',now(),now())`),
      (error: { code?: string }) => error.code === '42501',
    );
    await assert.rejects(
      app.pool.query(`SELECT billing_record_fx_source_approval('ops','x','USD','GHS',1::bigint,6,'half_up',now(),now(),'r')`),
      (error: { code?: string }) => error.code === '42501',
    );
  });
});

/* ========================================================================== */
/* H4 — exact-rate binding, single use, expiry, concurrency, rollback          */
/* ========================================================================== */

describe('H4 — an approval authorizes exactly one rate, once, within its window', () => {
  test('a valid approval publishes, consumes the approval and links it to the version', async () => {
    const version = await publishApprovedFx(FX, { ...instants(), sourceReference: REFERENCE });
    const consumption = await consumptionFor(version.id);
    assert.ok(consumption, 'the consumption row links the approval to the published version');
    assert.equal(consumption.fx_rate_version_id, version.id);
    assert.equal(consumption.publisher_principal, FX.publisherLogin);
    assert.equal(consumption.approver_principal, FX.approverLogin);
  });

  test('reuse: the same approval cannot publish a second version, at the same or any other rate', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    const publish = (rate: bigint) =>
      FX.publications.publish({
        fxRateScaled: rate,
        fxRateScale: 6,
        effectiveFrom,
        capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      });
    const first = await publish(FX_RATE);
    assert.equal(first.fxRateScaled, FX_RATE);
    assert.equal((await refusalOf(() => publish(FX_RATE))).reason, 'approval_consumed');
    assert.equal((await refusalOf(() => publish(99_900_000n))).reason, 'approval_consumed');
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.approvalId]), 1);
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_rate_versions WHERE effective_from = $1', [effectiveFrom]), 1);
  });

  test('rate value change after approval is refused (approval_mismatch → source_not_approved)', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    for (const rate of [12_500_001n, 99_900_000n, 1n]) {
      const error = await refusalOf(() =>
        FX.publications.publish({
          fxRateScaled: rate,
          fxRateScale: 6,
          effectiveFrom,
          capturedAt,
          source: 'ops',
          sourceReference: REFERENCE,
          sourceApprovalId: approval.approvalId,
        }),
      );
      assert.equal(error.reason, 'source_not_approved', `rate ${rate}`);
    }
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.approvalId]), 0, 'no rate change consumed it');
  });

  test('scale change after approval is refused', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    const error = await refusalOf(() =>
      FX.publications.publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 4,
        effectiveFrom,
        capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      }),
    );
    assert.equal(error.reason, 'source_not_approved');
  });

  test('source change after approval is refused (ops approved, import published)', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    const error = await refusalOf(() =>
      FX.publications.publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom,
        capturedAt,
        source: 'import',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      }),
    );
    assert.equal(error.reason, 'source_not_approved');
  });

  test('source reference change after approval is refused, including a trailing-space variant', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    for (const sourceReference of ['ops-fx-board-2', `${REFERENCE} `]) {
      const error = await refusalOf(() =>
        FX.publications.publish({
          fxRateScaled: FX_RATE,
          fxRateScale: 6,
          effectiveFrom,
          capturedAt,
          source: 'ops',
          sourceReference,
          sourceApprovalId: approval.approvalId,
        }),
      );
      assert.equal(error.reason, 'source_not_approved', JSON.stringify(sourceReference));
    }
  });

  test('effective instant change after approval is refused', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    const error = await refusalOf(() =>
      FX.publications.publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom: new Date(effectiveFrom.getTime() + 1000),
        capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      }),
    );
    assert.equal(error.reason, 'source_not_approved');
  });

  test('capture instant change after approval is refused (one microsecond is enough)', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    const error = await refusalOf(() =>
      FX.publications.publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom,
        capturedAt: new Date(capturedAt.getTime() - 1),
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      }),
    );
    assert.equal(error.reason, 'source_not_approved');
  });

  test('an expired approval cannot publish; the window is one hour', async () => {
    assert.equal(FX_APPROVAL_VALIDITY_SECONDS, 3600);
    const { effectiveFrom, capturedAt } = instants();
    // Owner fixture: a row whose approval time is two hours ago, so it is expired now.
    // The fingerprint is computed by the database function, as the real writer does.
    const { rows } = await db.pool.query(
      `INSERT INTO billing_fx_source_approvals (source, source_reference, base_currency, quote_currency,
          fx_rate_scaled, fx_rate_scale, rounding_mode, effective_from, captured_at, fingerprint, reason,
          approver_principal, approved_at, expires_at)
        SELECT 'ops', $1, 'USD', 'GHS', $2::bigint, 6, 'half_up', $3, $4,
               billing_fx_approval_fingerprint('ops', $1, 'USD', 'GHS', $2::bigint, 6, 'half_up', $3, $4),
               'expired fixture', $5, now() - interval '2 hours', now() - interval '1 hour'
        RETURNING id`,
      [REFERENCE, FX_RATE.toString(), effectiveFrom, capturedAt, FX.approverLogin],
    );
    const error = await refusalOf(() =>
      FX.publications.publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom,
        capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: String(rows[0]!.id),
      }),
    );
    assert.equal(error.reason, 'approval_expired');
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [rows[0]!.id]), 0);
  });

  test('a fresh approval is valid for exactly one hour from recording', async () => {
    const approval = await FX.approvals.recordApproval(approvalInput());
    const remaining = (approval.expiresAt.getTime() - Date.now()) / 1000;
    assert.ok(remaining > 3500 && remaining <= 3600, `expires in ${remaining}s`);
  });

  test('concurrency: two simultaneous publications of ONE approval — exactly one succeeds', async () => {
    const { effectiveFrom, capturedAt } = instants();
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt }));
    const attempts = await Promise.allSettled(
      [0, 1].map(() =>
        FX.publications.publish({
          fxRateScaled: FX_RATE,
          fxRateScale: 6,
          effectiveFrom,
          capturedAt,
          source: 'ops',
          sourceReference: REFERENCE,
          sourceApprovalId: approval.approvalId,
        }),
      ),
    );
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one publication wins');
    assert.equal(rejected.length, 1);
    assert.equal(isBillingFxError(rejected[0]!.reason) ? rejected[0]!.reason.reason : 'other', 'approval_consumed');
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.approvalId]), 1);
    assert.equal(await countRows(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = $1 AND entity_id = $2`,
      [FX_RATE_PUBLISHED_AUDIT_ACTION, (fulfilled[0] as PromiseFulfilledResult<{ id: string }>).value.id],
    ), 1);
  });

  test('rollback: a publication that fails after its approval checks leaves NO consumption, version or audit', async () => {
    // Establish a published version at an instant, through its own approval.
    const taken = instants();
    await publishApprovedFx(FX, { ...taken, sourceReference: REFERENCE });
    // A second approval for the SAME pair and instant: the version insert collides (23505).
    const approval = await FX.approvals.recordApproval(approvalInput({ effectiveFrom: taken.effectiveFrom, capturedAt: taken.capturedAt }));
    const before = {
      versions: await countRows('SELECT count(*)::text AS n FROM billing_fx_rate_versions'),
      consumptions: await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions'),
      published: await countRows('SELECT count(*)::text AS n FROM audit_events WHERE action = $1', [FX_RATE_PUBLISHED_AUDIT_ACTION]),
    };
    const error = await refusalOf(() =>
      FX.publications.publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom: taken.effectiveFrom,
        capturedAt: taken.capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      }),
    );
    assert.equal(error.reason, 'ambiguous');
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_rate_versions'), before.versions);
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions'), before.consumptions);
    assert.equal(await countRows('SELECT count(*)::text AS n FROM audit_events WHERE action = $1', [FX_RATE_PUBLISHED_AUDIT_ACTION]), before.published);
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.approvalId]), 0, 'the failed attempt left no misleading consumption');
  });

  test('an unconsumed approval stays usable after a rolled-back attempt that never reached consumption', async () => {
    const at = instants();
    const approval = await FX.approvals.recordApproval(approvalInput(at));
    // A rate mismatch is refused before any write.
    await refusalOf(() =>
      FX.publications.publish({
        fxRateScaled: 1n,
        fxRateScale: 6,
        effectiveFrom: at.effectiveFrom,
        capturedAt: at.capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: approval.approvalId,
      }),
    );
    const version = await FX.publications.publish({
      fxRateScaled: FX_RATE,
      fxRateScale: 6,
      effectiveFrom: at.effectiveFrom,
      capturedAt: at.capturedAt,
      source: 'ops',
      sourceReference: REFERENCE,
      sourceApprovalId: approval.approvalId,
    });
    assert.equal(version.fxRateScaled, FX_RATE);
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.approvalId]), 1);
  });
});

/* ========================================================================== */
/* Input policy — the store refuses what the database would not allow          */
/* ========================================================================== */

describe('approval input policy', () => {
  test('a database-copy or config-supplied source can never be approved', async () => {
    for (const source of ['db', 'config'] as const) {
      const error = await refusalOf(() =>
        FX.approvals.recordApproval(approvalInput({ source: source as 'ops' })),
      );
      assert.equal(error.reason, 'source_not_permitted', source);
    }
  });

  test('a credential-shaped reference or reason is refused before any write', async () => {
    const error = await refusalOf(() =>
      FX.approvals.recordApproval(approvalInput({ sourceReference: 'api_key=0123456789' })),
    );
    assert.equal(error.reason, 'invalid');
    const reasonError = await refusalOf(() =>
      FX.approvals.recordApproval(approvalInput({ reason: 'Authorization: Bearer abcdef' })),
    );
    assert.equal(reasonError.reason, 'invalid');
  });

  test('capture after effect is refused by the store and by the table', async () => {
    const { effectiveFrom } = instants();
    const error = await refusalOf(() =>
      FX.approvals.recordApproval(approvalInput({ effectiveFrom, capturedAt: new Date(effectiveFrom.getTime() + 1) })),
    );
    assert.equal(error.reason, 'invalid');
  });

  test('a database-side approval for an unpermitted source is refused by the function', async () => {
    await assert.rejects(
      db.pool.query(
        `SELECT * FROM billing_record_fx_source_approval('db','x','USD','GHS',1::bigint,6,'half_up',now(),now(),'r')`,
      ),
      (error: { code?: string }) => error.code === '42501' || error.code === 'P0001',
    );
  });
});

/* ========================================================================== */
/* H-A — expiry is evaluated against WALL-CLOCK time, not transaction start    */
/* ========================================================================== */

describe('H-A — an expiry that passes during a transaction is enforced', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * An approval whose one-hour window closes `seconds` in the future, inserted
   * through the database's own fingerprint function (owner fixture, exactly as
   * the real writer would). `expires_at` is computed ONCE in a CTE so the
   * `expires_at = approved_at + interval '1 hour'` CHECK holds exactly.
   */
  async function insertApprovalExpiringIn(
    seconds: number,
  ): Promise<{ id: string; expiresAt: Date; effectiveFrom: Date; capturedAt: Date }> {
    const { effectiveFrom, capturedAt } = instants();
    const { rows } = await db.pool.query(
      `WITH exp AS (
         SELECT clock_timestamp() + make_interval(secs => $5::double precision) AS expires_at
       )
       INSERT INTO billing_fx_source_approvals (
         source, source_reference, base_currency, quote_currency,
         fx_rate_scaled, fx_rate_scale, rounding_mode, effective_from, captured_at,
         fingerprint, reason, approver_principal, approved_at, expires_at
       )
       SELECT 'ops', $1, 'USD', 'GHS', $2::bigint, 6, 'half_up', $3, $4,
              billing_fx_approval_fingerprint('ops', $1, 'USD', 'GHS', $2::bigint, 6, 'half_up', $3, $4),
              'adversarial expiry fixture', $6,
              exp.expires_at - interval '1 hour', exp.expires_at
         FROM exp
       RETURNING id, expires_at`,
      [REFERENCE, FX_RATE.toString(), effectiveFrom, capturedAt, seconds, FX.approverLogin],
    );
    return {
      id: String(rows[0]!.id),
      expiresAt: new Date(rows[0]!.expires_at as Date),
      effectiveFrom,
      capturedAt,
    };
  }

  test('a transaction begun before expiry cannot publish after the window closes', async () => {
    // 1. An approval whose window closes a few seconds from now.
    const approval = await insertApprovalExpiringIn(5);
    assert.ok(
      approval.expiresAt.getTime() > Date.now() + 1000,
      'the approval is still inside its window when the transaction begins',
    );

    // 2. Begin a transaction BEFORE expiry and hold it open across the boundary.
    const client = await FX.publisherPool.connect();
    let refused = false;
    try {
      await client.query('BEGIN');
      // 3. Let wall-clock time pass the expiry while the transaction is open.
      await sleep(6500);
      // 4. Attempt publication INSIDE that same transaction.
      await assert.rejects(
        client.query(
          `SELECT * FROM billing_publish_fx_rate_version(
             $1::bigint, 'ops', $2, 'USD', 'GHS', $3::bigint, 6, 'half_up', $4, $5)`,
          [approval.id, REFERENCE, FX_RATE.toString(), approval.effectiveFrom, approval.capturedAt],
        ),
        (error: { code?: string; message?: string }) =>
          error.code === 'P0001' && error.message === 'approval_expired',
      );
      refused = true;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    assert.ok(refused, 'publication was refused with approval_expired');

    // 6. Nothing was committed: no version, no consumption, no success audit.
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM billing_fx_rate_versions WHERE effective_from = $1', [approval.effectiveFrom]),
      0,
      'no FX version was committed',
    );
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approval_consumptions WHERE approval_id = $1', [approval.id]),
      0,
      'no consumption was committed',
    );
    assert.equal(
      await countRows(
        `SELECT count(*)::text AS n FROM audit_events WHERE action = $1 AND metadata->>'approvalId' = $2`,
        [FX_RATE_PUBLISHED_AUDIT_ACTION, approval.id],
      ),
      0,
      'no success audit event was committed',
    );
    // The approval row itself is still present and unconsumed (append-only).
    assert.equal(
      await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approvals WHERE id = $1', [approval.id]),
      1,
    );
  });
});

/* ========================================================================== */
/* H-B — object ownership is separated from the application login             */
/* ========================================================================== */

describe('H-B — the protected approval objects are owned by the owner role', () => {
  const OWNER = 'veltrixeye_fx_approval_owner';
  const PROTECTED_TABLES = [
    'billing_fx_source_approvals',
    'billing_fx_source_approval_consumptions',
    'billing_fx_rate_versions',
  ];
  const PROTECTED_FUNCS = [
    'billing_fx_approval_fingerprint',
    'billing_fx_principal_has_role',
    'billing_fx_approval_records_append_only',
    'billing_record_fx_source_approval',
    'billing_publish_fx_rate_version',
    'billing_assert_fx_approval_ownership',
  ];
  const PROTECTED_TRIGGERS = [
    'billing_fx_source_approvals_append_only',
    'billing_fx_source_approvals_no_truncate',
    'billing_fx_source_approval_consumptions_append_only',
    'billing_fx_source_approval_consumptions_no_truncate',
  ];

  test('the owner role is NOLOGIN and owns every protected object', async () => {
    const { rows } = await db.pool.query<{ rolcanlogin: boolean }>(
      'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1',
      [OWNER],
    );
    assert.equal(rows.length, 1, 'the owner role exists');
    assert.equal(rows[0]!.rolcanlogin, false, 'the owner role cannot log in');

    for (const table of PROTECTED_TABLES) {
      const r = await db.pool.query<{ owner: string }>(
        `SELECT c.relowner::regrole::text AS owner FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1`,
        [table],
      );
      assert.equal(r.rows[0]!.owner, OWNER, `${table} is owned by the owner role`);
    }
    for (const fn of PROTECTED_FUNCS) {
      const r = await db.pool.query<{ owner: string }>(
        `SELECT p.proowner::regrole::text AS owner FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [fn],
      );
      assert.equal(r.rows[0]!.owner, OWNER, `${fn} is owned by the owner role`);
    }
    for (const trig of PROTECTED_TRIGGERS) {
      // A trigger is owned by its table's owner (PostgreSQL has no
      // ALTER TRIGGER ... OWNER TO), so the trigger is covered by the table
      // ownership check. Here we confirm each trigger exists and is enabled.
      const r = await db.pool.query<{ enabled: string; table_owner: string }>(
        `SELECT t.tgenabled::text AS enabled, c.relowner::regrole::text AS table_owner
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal AND n.nspname = 'public' AND t.tgname = $1`,
        [trig],
      );
      assert.equal(r.rows[0]!.enabled, 'O', `${trig} is enabled`);
      assert.equal(r.rows[0]!.table_owner, OWNER, `${trig} belongs to a table owned by the owner role`);
    }
  });

  test('the ownership assertion passes for the provisioned deployment', async () => {
    // Any login may run the read-only assertion (EXECUTE is granted to PUBLIC);
    // it reads the catalogue only and reveals no data.
    await app.pool.query('SELECT billing_assert_fx_approval_ownership()');
  });

  test('the application login cannot alter triggers, drop functions or move ownership', async () => {
    await assert.rejects(
      app.pool.query('ALTER TABLE billing_fx_source_approvals DISABLE TRIGGER billing_fx_source_approvals_append_only'),
      (error: { code?: string }) => error.code === '42501',
    );
    await assert.rejects(
      app.pool.query(
        'DROP FUNCTION billing_record_fx_source_approval(text, text, text, text, bigint, integer, text, timestamptz, timestamptz, text)',
      ),
      (error: { code?: string }) => error.code === '42501',
    );
    await assert.rejects(
      app.pool.query('ALTER TABLE billing_fx_rate_versions OWNER TO veltrixeye_fx_approver'),
      (error: { code?: string }) => error.code === '42501',
    );
  });

  test('the ownership assertion is fail-closed: it refuses a mis-owned object', async () => {
    // Temporarily move one protected object back to the superuser fixture, so
    // the assertion must detect the wrong owner, then restore it.
    await db.pool.query('ALTER TABLE billing_fx_source_approvals OWNER TO "test"');
    try {
      await assert.rejects(
        db.pool.query('SELECT billing_assert_fx_approval_ownership()'),
        (error: { code?: string; message?: string }) =>
          error.code === 'P0001' && /ownership_incorrect/.test(error.message ?? ''),
      );
    } finally {
      await db.pool.query(`ALTER TABLE billing_fx_source_approvals OWNER TO ${OWNER}`);
    }
    // Restored: the assertion is silent again.
    await db.pool.query('SELECT billing_assert_fx_approval_ownership()');
  });
});

/* ========================================================================== */
/* M-A — the FX stores verify the connected database identity                 */
/* ========================================================================== */

describe('M-A — the FX stores verify the connected database identity', () => {
  test('a store with NO configured identity refuses before any connection', async () => {
    await assert.rejects(
      new BillingFxSourceApprovalStore(FX.approverPool, undefined, undefined).recordApproval(approvalInput()),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'identity_not_configured',
    );
    const { effectiveFrom, capturedAt } = instants();
    await assert.rejects(
      new BillingFxRateVersionStore(FX.publisherPool, undefined, undefined).publish({
        fxRateScaled: FX_RATE,
        fxRateScale: 6,
        effectiveFrom,
        capturedAt,
        source: 'ops',
        sourceReference: REFERENCE,
        sourceApprovalId: '1',
      }),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'identity_not_configured',
    );
  });

  test('a store bound to a WRONG identity refuses the connected database', async () => {
    const realName = (await db.pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
    const wrong = parseDatabaseIdentityAllowlist({
      schemaVersion: 1,
      entries: [{ id: 'wrong-sysid', environment: 'sandbox', databaseName: realName, systemIdentifier: '1' }],
    }).entries[0]!;
    await assert.rejects(
      new BillingFxSourceApprovalStore(FX.approverPool, undefined, wrong).recordApproval(approvalInput()),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'identity_mismatch',
    );
  });

  test('the committed allowlist is empty and authorizes nothing (empty by default)', () => {
    const allowlist = loadDatabaseIdentityAllowlist(path.join(REPO_ROOT, DATABASE_IDENTITY_ALLOWLIST_RELATIVE_PATH));
    assert.equal(allowlist.entries.length, 0, 'the committed allowlist is empty by design');
    assert.throws(
      () => resolveDatabaseTarget(allowlist, 'sandbox', 'any-target'),
      (error: unknown) => error instanceof DatabaseIdentityError && error.reason === 'target_not_approved',
    );
  });

  test('an explicitly authorized local test identity is verified and the write proceeds', async () => {
    const identity = FX.identity;
    const approval = await new BillingFxSourceApprovalStore(FX.approverPool, undefined, identity).recordApproval(
      approvalInput(),
    );
    assert.equal(approval.approverPrincipal, FX.approverLogin);
    const version = await new BillingFxRateVersionStore(FX.publisherPool, undefined, identity).publish({
      fxRateScaled: FX_RATE,
      fxRateScale: 6,
      effectiveFrom: approval.effectiveFrom,
      capturedAt: approval.capturedAt,
      source: 'ops',
      sourceReference: REFERENCE,
      sourceApprovalId: approval.approvalId,
    });
    assert.equal(version.fxRateScaled, FX_RATE);
  });

  test('the identity is read on the SAME connection, before the writer call', async () => {
    const log: string[] = [];
    const recorded = recordingPool(FX.approverPool, log);
    await new BillingFxSourceApprovalStore(recorded, undefined, FX.identity).recordApproval(approvalInput());
    const identityAt = log.findIndex((sql) => sql.includes('current_database'));
    const writerAt = log.findIndex((sql) => sql.includes('billing_record_fx_source_approval'));
    assert.ok(identityAt >= 0, 'the identity was read');
    assert.ok(writerAt > identityAt, 'the writer call follows the identity check on the same connection');
  });
});

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

/** Wrap a pool so the SQL each connection issues is recorded, in order. */
function recordingPool(real: Pool, log: string[]): Pool {
  return {
    connect: async () => {
      const client = await real.connect();
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
        text: unknown,
        ...rest: unknown[]
      ) => {
        const sql = typeof text === 'string' ? text : String((text as { text?: string })?.text ?? '');
        log.push(sql.replace(/\s+/g, ' ').trim());
        return original(text, ...rest);
      };
      return client;
    },
    query: real.query.bind(real),
  } as unknown as Pool;
}

async function consumptionFor(key: string | number | bigint): Promise<{
  approval_id: string;
  fx_rate_version_id: string;
  approver_principal: string;
  publisher_principal: string;
} | undefined> {
  const isVersion = typeof key === 'string' && key.includes('-');
  const { rows } = await db.pool.query(
    isVersion
      ? 'SELECT approval_id::text, fx_rate_version_id::text, approver_principal, publisher_principal FROM billing_fx_source_approval_consumptions WHERE fx_rate_version_id = $1'
      : 'SELECT approval_id::text, fx_rate_version_id::text, approver_principal, publisher_principal FROM billing_fx_source_approval_consumptions WHERE approval_id = $1',
    [key],
  );
  return rows[0] as never;
}

/* ========================================================================== */
/* H2/H3 — the grants, read directly from the catalogue (not through a flow)   */
/* ========================================================================== */

describe('H2/H3 — the database grants, read directly from the catalogue', () => {
  const RECORD_SIG = 'billing_record_fx_source_approval(text,text,text,text,bigint,integer,text,timestamptz,timestamptz,text)';
  const PUBLISH_SIG = 'billing_publish_fx_rate_version(bigint,text,text,text,text,bigint,integer,text,timestamptz,timestamptz)';
  const APPROVAL_TABLES = ['billing_fx_source_approvals', 'billing_fx_source_approval_consumptions', 'billing_fx_rate_versions'];

  async function fnExecutable(role: string, signature: string): Promise<boolean> {
    const { rows } = await db.pool.query<{ ok: boolean }>(
      'SELECT has_function_privilege($1, $2, $3) AS ok',
      [role, signature, 'EXECUTE'],
    );
    return rows[0]!.ok;
  }

  test('both writers are SECURITY DEFINER with a pinned search_path; the helper is definer-owned too', async () => {
    for (const name of ['billing_record_fx_source_approval', 'billing_publish_fx_rate_version', 'billing_fx_principal_has_role']) {
      const { rows } = await db.pool.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        'SELECT prosecdef, proconfig FROM pg_proc WHERE proname = $1',
        [name],
      );
      assert.equal(rows.length, 1, `${name} exists exactly once`);
      if (name !== 'billing_fx_principal_has_role') {
        assert.equal(rows[0]!.prosecdef, true, `${name} is SECURITY DEFINER`);
      }
      assert.ok(
        (rows[0]!.proconfig ?? []).some((setting) => setting.startsWith('search_path=')),
        `${name} pins its search_path`,
      );
    }
  });

  test('PUBLIC holds no EXECUTE on either writer or on the membership helper', async () => {
    assert.equal(await fnExecutable('public', RECORD_SIG), false, 'PUBLIC cannot record an approval');
    assert.equal(await fnExecutable('public', PUBLISH_SIG), false, 'PUBLIC cannot publish');
    assert.equal(
      await fnExecutable('public', 'billing_fx_principal_has_role(text)'),
      false,
      'PUBLIC cannot probe membership',
    );
  });

  test('each writer is executable by exactly its own DBA role', async () => {
    assert.equal(await fnExecutable('veltrixeye_fx_approver', RECORD_SIG), true, 'the approver role may record');
    assert.equal(await fnExecutable('veltrixeye_fx_approver', PUBLISH_SIG), false, 'the approver role may NOT publish');
    assert.equal(await fnExecutable('veltrixeye_fx_publisher', PUBLISH_SIG), true, 'the publisher role may publish');
    assert.equal(await fnExecutable('veltrixeye_fx_publisher', RECORD_SIG), false, 'the publisher role may NOT record');
  });

  test('the application login has no EXECUTE, no membership and no table privilege on the approval tables', async () => {
    assert.equal(await fnExecutable(app.login, RECORD_SIG), false);
    assert.equal(await fnExecutable(app.login, PUBLISH_SIG), false);
    for (const table of APPROVAL_TABLES) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
        const { rows } = await db.pool.query<{ ok: boolean }>(
          'SELECT has_table_privilege($1, $2, $3) AS ok',
          [app.login, table, privilege],
        );
        assert.equal(rows[0]!.ok, false, `${app.login} has no ${privilege} on ${table}`);
      }
    }
  });

  test('PUBLIC holds no WRITE grant on the approval tables (read-only rate SELECT is the only exception)', async () => {
    const { rows } = await db.pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_name = ANY($1::text[])
        ORDER BY table_name, privilege_type`,
      [APPROVAL_TABLES],
    );
    const writes = rows.filter((row) => row.privilege_type !== 'SELECT');
    assert.deepEqual(writes, [], 'PUBLIC holds no INSERT/UPDATE/DELETE/TRUNCATE on the approval tables');
    // The deliberate, read-only exception: a published rate is readable by every
    // login, but can only be INSERTED through the approval-enforcing function.
    assert.deepEqual(
      rows.map((row) => `${row.table_name}:${row.privilege_type}`),
      ['billing_fx_rate_versions:SELECT'],
    );
  });

  test('the membership helper is internal: no login can call it directly (EXECUTE is revoked from PUBLIC)', async () => {
    // Its membership answer is exercised through the two writers, which run it
    // as the definer and decide on session_user (the H2 tests above). Called
    // directly, every login — application, approver or publisher — is refused.
    for (const pool of [app.pool, FX.approverPool, FX.publisherPool]) {
      await assert.rejects(
        pool.query('SELECT billing_fx_principal_has_role($1)', ['veltrixeye_fx_approver']),
        (error: { code?: string }) => error.code === '42501',
      );
    }
  });
});
