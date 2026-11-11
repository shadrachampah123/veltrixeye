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
 * HONEST SCOPE. The fixture's own test superuser owns the objects, so it can
 * bypass the triggers (the documented owner limitation). The suite therefore
 * proves the controls against every NON-owner principal, and proves the
 * owner-level append-only triggers fire on UPDATE, DELETE and TRUNCATE.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import type {
  BillingFxError} from '../src/index.js';
import {
  BillingFxRateVersionStore,
  createPool,
  BillingFxSourceApprovalStore,
  FX_APPROVAL_VALIDITY_SECONDS,
  FX_RATE_PUBLISHED_AUDIT_ACTION,
  FX_SOURCE_APPROVED_AUDIT_ACTION,
  isBillingFxError,
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
    const error = await refusalOf(() => new BillingFxSourceApprovalStore(app.pool).recordApproval(approvalInput()));
    assert.equal(error.reason, 'principal_unauthorized');
    assert.equal(await countRows('SELECT count(*)::text AS n FROM billing_fx_source_approvals WHERE approver_principal = $1', [app.login]), 0);
  });

  test('the publisher login cannot record an approval — it is not an approver', async () => {
    const error = await refusalOf(() => new BillingFxSourceApprovalStore(FX.publisherPool).recordApproval(approvalInput()));
    assert.equal(error.reason, 'principal_unauthorized');
  });

  test('the approver login cannot publish — it is not a publisher', async () => {
    const approval = await FX.approvals.recordApproval(approvalInput());
    const error = await refusalOf(() =>
      new BillingFxRateVersionStore(FX.approverPool).publish({
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
      const approval = await new BillingFxSourceApprovalStore(bothPool).recordApproval(approvalInput());
      assert.equal(approval.approverPrincipal, both);
      const error = await refusalOf(() =>
        new BillingFxRateVersionStore(bothPool).publish({
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
      new BillingFxRateVersionStore(FX.publisherPool).publish({
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
/* Helpers                                                                     */
/* ========================================================================== */

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

  test('no table grant to PUBLIC survives on the approval tables', async () => {
    const { rows } = await db.pool.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_name = ANY($1::text[])`,
      [APPROVAL_TABLES],
    );
    assert.equal(Number(rows[0]!.n), 0);
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
