/**
 * Billing Step 4 remediation — FX SOURCE APPROVAL, enforced on the durable
 * authority, against real PostgreSQL.
 *
 * Audit finding (HIGH): `BillingFxRateVersionStore.publish()` accepted any
 * `source` without an approval. This suite pins the mechanism that replaces it:
 *
 *   - an approval is a recorded `billing.fx_source_approved` audit event naming
 *     a permitted source, an exact publication reference, the USD→GHS pair, the
 *     human operator and the reason;
 *   - `publish()` refuses unless it cites the id of a recorded approval whose
 *     source, reference, pair and decision match the publication EXACTLY;
 *   - the publication and the approval it cited are audited together, in one
 *     transaction;
 *   - recording an approval is never a publication.
 *
 * Nothing here publishes a real rate or approves a real source: every approval
 * is a throwaway fixture in the embedded test database.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Pool } from 'pg';
import {
  BillingFxError,
  BillingFxRateVersionStore,
  BillingFxSourceApprovalStore,
  FX_PUBLICATION_PERMITTED_SOURCES,
  FX_RATE_PUBLISHED_AUDIT_ACTION,
  FX_SOURCE_APPROVED_AUDIT_ACTION,
  type FxSourceApprovalInput,
} from '../src/index.js';
import { retireActiveEpochs, startBillingTestDb } from './helpers/billing-checkout.js';

const DB_PORT = 5613;
const REFERENCE = 'ops-fx-approval-board-2026-11-03';
const OPERATOR = 'ops-fx-approval-01';
const REASON = 'approve the named ops board for the USD→GHS publication under test';

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let pool: Pool;

before(async () => {
  db = await startBillingTestDb(DB_PORT);
  pool = db.pool;
}, { timeout: 180_000 });

beforeEach(async () => {
  await retireActiveEpochs(pool);
});

after(async () => {
  await db?.stop();
});

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

let tick = 0;

function approvalInput(overrides: Partial<FxSourceApprovalInput> = {}): FxSourceApprovalInput {
  return {
    source: 'ops',
    sourceReference: REFERENCE,
    approvedBy: OPERATOR,
    reason: REASON,
    ...overrides,
  };
}

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0]!.n);
}

const fxRows = () => countRows('SELECT count(*)::int AS n FROM billing_fx_rate_versions');
const approvalRows = () =>
  countRows('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [FX_SOURCE_APPROVED_AUDIT_ACTION]);
const publishAudits = () =>
  countRows('SELECT count(*)::int AS n FROM audit_events WHERE action = $1', [FX_RATE_PUBLISHED_AUDIT_ACTION]);

/** A publication attempt with an arbitrary approval id and overrides. */
function publishWith(
  approvalId: unknown,
  overrides: Partial<{ source: string; sourceReference: string | null; effectiveFrom: Date }> = {},
) {
  const effectiveFrom = overrides.effectiveFrom ?? new Date(Date.now() - (120 + tick++) * 60_000);
  return new BillingFxRateVersionStore(pool).publish({
    fxRateScaled: 12_500_000n,
    fxRateScale: 6,
    effectiveFrom,
    capturedAt: effectiveFrom,
    source: (overrides.source ?? 'ops') as 'ops',
    sourceReference: overrides.sourceReference === undefined ? REFERENCE : overrides.sourceReference,
    createdBy: OPERATOR,
    sourceApprovalId: approvalId as string,
  });
}

async function expectRefusal(promise: Promise<unknown>, reason: string): Promise<BillingFxError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof BillingFxError, `a typed FX refusal, got ${String(error)}`);
    assert.equal(error.reason, reason);
    return error;
  }
  assert.fail(`expected a ${reason} refusal`);
}

/* ========================================================================== */
/* 1. Recording an approval — a decision, never a publication                  */
/* ========================================================================== */

describe('FX source approval — recording the decision', () => {
  test('a valid approval is recorded as an auditable decision and publishes nothing', async () => {
    const fxBefore = await fxRows();
    const approvals = await approvalRows();
    const recorded = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());

    assert.match(recorded.approvalId, /^[1-9][0-9]*$/, 'the approval id is the durable audit id');
    assert.equal(recorded.source, 'ops');
    assert.equal(recorded.sourceReference, REFERENCE);
    assert.equal(recorded.baseCurrency, 'USD');
    assert.equal(recorded.quoteCurrency, 'GHS');
    assert.ok(recorded.approvedAt instanceof Date && Number.isFinite(recorded.approvedAt.getTime()));
    assert.equal(await approvalRows(), approvals + 1, 'exactly one approval decision was recorded');
    assert.equal(await fxRows(), fxBefore, 'recording an approval is never a publication');

    const { rows } = await pool.query('SELECT metadata FROM audit_events WHERE id = $1::bigint', [recorded.approvalId]);
    assert.equal(rows[0].metadata.decision, 'approved');
    assert.equal(rows[0].metadata.approvedBy, OPERATOR);
    assert.equal(rows[0].metadata.reason, REASON);
  });

  test('only the permitted sources can be approved; db and config are refused outright', async () => {
    assert.deepEqual([...FX_PUBLICATION_PERMITTED_SOURCES].sort(), ['import', 'ops']);
    const store = new BillingFxSourceApprovalStore(pool);
    for (const source of ['db', 'config']) {
      await expectRefusal(store.recordApproval(approvalInput({ source: source as 'ops' })), 'source_not_permitted');
    }
  });

  test('malformed or credential-shaped approval evidence is refused and records nothing', async () => {
    const store = new BillingFxSourceApprovalStore(pool);
    const approvals = await approvalRows();
    const invalid: ReadonlyArray<Partial<FxSourceApprovalInput> & Record<string, unknown>> = [
      { source: 'bogus' as 'ops' },
      { sourceReference: '' },
      { sourceReference: '   ' },
      { sourceReference: 'x'.repeat(191) },
      { sourceReference: 'bearer abcdef' },
      { sourceReference: 'api_key=0123' },
      { approvedBy: '' },
      { approvedBy: 'svc token 01' },
      { reason: '' },
      { reason: 'secret reason' },
      { extra: true },
    ];
    for (const evidence of invalid) {
      await expectRefusal(store.recordApproval(approvalInput(evidence)), 'invalid');
    }
    assert.equal(await approvalRows(), approvals, 'no malformed approval was recorded');
  });

  test('approval evidence is refused before any database call', async () => {
    const exploding = {
      query: async () => {
        throw new Error('no query may be issued for invalid approval evidence');
      },
    } as unknown as Pool;
    await expectRefusal(
      new BillingFxSourceApprovalStore(exploding).recordApproval(approvalInput({ sourceReference: '' })),
      'invalid',
    );
    await expectRefusal(
      new BillingFxSourceApprovalStore(exploding).recordApproval(approvalInput({ source: 'config' as 'ops' })),
      'source_not_permitted',
    );
  });
});

/* ========================================================================== */
/* 2. Publication fails closed without a matching recorded approval            */
/* ========================================================================== */

describe('FX source approval — publication fails closed', () => {
  test('an unapproved publication (no approval id) is refused and writes nothing', async () => {
    const fx = await fxRows();
    const audits = await publishAudits();
    for (const missing of [undefined, null, '', '   ']) {
      await expectRefusal(publishWith(missing), 'source_not_approved');
    }
    assert.equal(await fxRows(), fx, 'no rate version was written');
    assert.equal(await publishAudits(), audits);
  });

  test('a malformed approval id is refused without reaching the audit table', async () => {
    const fx = await fxRows();
    for (const malformed of ['abc', '0', '01', '-5', '1; DROP TABLE audit_events', '9'.repeat(25), '1.5']) {
      await expectRefusal(publishWith(malformed), 'source_not_approved');
    }
    assert.equal(await fxRows(), fx);
  });

  test('a well-formed id that names no recorded approval is refused — approval must come first', async () => {
    const fx = await fxRows();
    // A plausible but never-recorded id: approval is not retro-fitted.
    await expectRefusal(publishWith('999999999999'), 'source_not_approved');
    assert.equal(await fxRows(), fx);
    // Recording the approval afterwards makes the very same publication succeed.
    const recorded = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    const version = await publishWith(recorded.approvalId);
    assert.equal(version.source, 'ops');
  });

  test('an id that names an audit event which is not an approval is refused', async () => {
    const unrelated = await pool.query(
      `INSERT INTO audit_events (action, entity_type, entity_id, metadata)
       VALUES ('billing.unrelated_event', 'billing_fx_source', 'unrelated', '{}'::jsonb)
       RETURNING id::text AS id`,
    );
    await expectRefusal(publishWith(unrelated.rows[0].id), 'source_not_approved');
  });

  test('an approval for a DIFFERENT source is refused (an import approval does not authorize ops)', async () => {
    const importApproval = await new BillingFxSourceApprovalStore(pool).recordApproval(
      approvalInput({ source: 'import', sourceReference: 'import-board-x' }),
    );
    await expectRefusal(
      publishWith(importApproval.approvalId, { source: 'ops', sourceReference: 'import-board-x' }),
      'source_not_approved',
    );
  });

  test('an approval for a DIFFERENT reference is refused', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    await expectRefusal(
      publishWith(approval.approvalId, { sourceReference: 'some-other-board' }),
      'source_not_approved',
    );
  });

  test('a publication without a source reference is refused, even with an approval id', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    await expectRefusal(publishWith(approval.approvalId, { sourceReference: null }), 'source_not_approved');
    await expectRefusal(publishWith(approval.approvalId, { sourceReference: '  ' }), 'source_not_approved');
  });

  test('a non-permitted source is refused at publication, whatever approval is cited', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    for (const source of ['db', 'config']) {
      await expectRefusal(publishWith(approval.approvalId, { source }), 'source_not_permitted');
    }
  });
});

/* ========================================================================== */
/* 3. An approved publication succeeds and is audited with its approval        */
/* ========================================================================== */

describe('FX source approval — approved publication', () => {
  test('an approved publication writes the version and one audit event citing the approval, atomically', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    const fx = await fxRows();
    const audits = await publishAudits();

    const version = await publishWith(approval.approvalId);

    assert.equal(version.source, 'ops');
    assert.equal(version.sourceReference, REFERENCE);
    assert.equal(await fxRows(), fx + 1);
    assert.equal(await publishAudits(), audits + 1);
    const { rows } = await pool.query(
      'SELECT metadata FROM audit_events WHERE action = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1',
      [FX_RATE_PUBLISHED_AUDIT_ACTION, version.id],
    );
    assert.equal(rows[0].metadata.approvalId, approval.approvalId, 'the publication names the approval it cited');
    assert.equal(rows[0].metadata.sourceReference, REFERENCE);
    assert.equal(rows[0].metadata.fxRateScaled, '12500000');
  });

  test('an import-source publication is approvable and publishes when the approval matches', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(
      approvalInput({ source: 'import', sourceReference: 'import-board-approved' }),
    );
    const effectiveFrom = new Date(Date.now() - (300 + tick++) * 60_000);
    const version = await new BillingFxRateVersionStore(pool).publish({
      fxRateScaled: 12_000_000n,
      fxRateScale: 6,
      effectiveFrom,
      capturedAt: effectiveFrom,
      source: 'import',
      sourceReference: 'import-board-approved',
      sourceApprovalId: approval.approvalId,
    });
    assert.equal(version.source, 'import');
  });

  test('one approval covers its exact source and reference across publications at different instants', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    const first = await publishWith(approval.approvalId);
    const second = await publishWith(approval.approvalId);
    assert.notEqual(first.id, second.id);
    assert.equal(first.sourceReference, second.sourceReference);
  });

  test('a failed publication rolls back its audit event: a duplicate instant leaves one publication audit only', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    const effectiveFrom = new Date(Date.now() - (500 + tick++) * 60_000);
    await publishWith(approval.approvalId, { effectiveFrom });
    const audits = await publishAudits();
    const fx = await fxRows();

    // The durable uniqueness index refuses the same pair at the same instant.
    await assert.rejects(publishWith(approval.approvalId, { effectiveFrom }));
    assert.equal(await publishAudits(), audits, 'no audit event survived the rolled-back publication');
    assert.equal(await fxRows(), fx, 'no version survived the rolled-back publication');
  });
});

/* ========================================================================== */
/* 4. The approval is recorded through the same audit authority                */
/* ========================================================================== */

describe('FX source approval — audit integration', () => {
  test('the approval is an ordinary audit event readable by the audit authority', async () => {
    const approval = await new BillingFxSourceApprovalStore(pool).recordApproval(approvalInput());
    const { rows } = await pool.query('SELECT action, entity_type, metadata FROM audit_events WHERE id = $1::bigint', [
      approval.approvalId,
    ]);
    assert.equal(rows[0].action, FX_SOURCE_APPROVED_AUDIT_ACTION);
    assert.equal(rows[0].entity_type, 'billing_fx_source');
    assert.equal(rows[0].metadata.sourceReference, REFERENCE);
  });
});
