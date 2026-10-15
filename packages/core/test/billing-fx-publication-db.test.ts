/**
 * Billing FX **publication** — against a real PostgreSQL (embedded, ephemeral).
 *
 * Pins the durable properties the approved policy rests on:
 *
 *  - **D4 atomicity.** The version row and its `billing.fx_rate_published` audit
 *    event commit together or not at all. When the audit write fails the
 *    publication FAILS and the version is rolled back — a published rate with no
 *    record of who approved it is unrepresentable.
 *  - **D8/D9 price isolation.** Publishing a rate leaves `billing_provider_plans`,
 *    `billing_pricing_snapshots`, `subscriptions` (including every
 *    `locked_pricing_snapshot_id`) and every Paystack plan identifier
 *    BYTE-IDENTICAL. A customer-facing price changes only through a separately
 *    approved epoch rotation, which this feature never performs.
 *  - **D5 fail closed.** Evidence that does not satisfy the two-person rule is
 *    refused before the first INSERT.
 *  - **D6 forward-only correction.** A correction is a NEW version with a later
 *    `effective_from`; the superseded version is untouched and remains
 *    resolvable for its own window. Nothing is ever updated or deleted.
 *  - **D1/D2.** The written row carries the operator's adoption instant, and the
 *    900-second bound is applied before the write.
 *
 * The database is the same embedded-postgres harness the rest of the suite uses:
 * a temporary data directory on the loopback interface, destroyed after the run.
 * No production or remote database is contacted, and no rate is published
 * anywhere outside this ephemeral test instance.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import {
  BillingFxRateVersionStore,
  FX_PUBLICATION_AUDIT_ACTION,
  FxPublicationError,
  FxPublicationService,
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
} from '../src/index.js';
import { insertUser, seedCommercialSubscription } from './helpers/billing-checkout.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PORT = 5551;

/**
 * A monotonic clock for the tests. Every publication must be strictly LATER than
 * the last one (ordering is enforced, not assumed), and every capture must be
 * inside the 900-second bound, so the fixtures advance one minute at a time from
 * a base well after the seeded fixtures.
 */
const BASE_MS = Date.parse('2026-10-15T10:00:00.000Z');
let tick = 0;
const nextInstant = (): { capturedAt: string; effectiveFrom: string; asOf: Date } => {
  tick += 1;
  const instant = new Date(BASE_MS + tick * 60_000).toISOString();
  return { capturedAt: instant, effectiveFrom: instant, asOf: new Date(BASE_MS + tick * 60_000 + 30_000) };
};

const EXECUTOR = 'operator-executor';
const APPROVERS = ['operator-approver-one', 'operator-approver-two'];
const REFERENCE = 'BoG daily interbank FX, 2026-10-15; ticket FX-1042';

let pool: pg.Pool;
let stopDb: () => Promise<void>;

before(async () => {
  const testDir = path.join(REPO_ROOT, '.test');
  mkdirSync(testDir, { recursive: true });
  const dataDir = mkdtempSync(path.join(testDir, 'fx-publication-'));
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: 'test',
    password: randomBytes(16).toString('hex'),
    database: 'veltrixeye_fx_publication',
  });
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  stopDb = async () => {
    await pool.end();
    await db.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
});

after(async () => {
  await stopDb();
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Evidence for ONE publication on the next free instant. `asOf`/`capturedAt`/
 * `effectiveFrom` are always supplied together so a test cannot accidentally
 * publish outside the 900-second bound or at a colliding instant.
 */
function evidence(
  timeline: { capturedAt: string; effectiveFrom: string; asOf: Date },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executorId: EXECUTOR,
    approvers: [...APPROVERS],
    reason: 'Re-adopt the USD→GHS rate corroborated by the published bulletin for this business day.',
    sourceReference: REFERENCE,
    rate: '12.550000',
    capturedAt: timeline.capturedAt,
    effectiveFrom: timeline.effectiveFrom,
    downstream: { epochRegistrationPlanned: false },
    ...overrides,
  };
}

function service(): FxPublicationService {
  return new FxPublicationService(pool);
}

const countRows = async (table: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number.parseInt(rows[0]!.count, 10);
};

/** A content digest of an entire table — the strongest "nothing changed" claim. */
async function tableDigest(table: string, orderBy: string): Promise<string> {
  const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

const PUBLICATION_AUDIT_ROWS = async (): Promise<Array<Record<string, unknown>>> => {
  const { rows } = await pool.query(
    'SELECT * FROM audit_events WHERE action = $1 ORDER BY created_at DESC',
    [FX_PUBLICATION_AUDIT_ACTION],
  );
  return rows;
};

/* -------------------------------------------------------------------------- */
/* The two approved rows, committed together (D4)                             */
/* -------------------------------------------------------------------------- */

describe('a publication writes exactly two rows, atomically (D4)', () => {
  test('the FX version and its audit event are both present, and the audit names the approvals', async () => {
    const timeline = nextInstant();
    const result = await service().publish(evidence(timeline), timeline.asOf);

    const row = await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [result.version.id]);
    assert.equal(row.rows.length, 1, 'the version row was committed');
    const written = row.rows[0]!;
    assert.equal(written.source, 'ops');
    assert.equal(written.created_by, EXECUTOR);
    assert.equal(written.source_reference, REFERENCE);
    assert.equal(written.fx_rate_scaled, '12550000');
    assert.equal(written.fx_rate_scale, 6);
    // D2: the recorded capture is the adoption instant, never a bulletin time.
    assert.equal(new Date(written.captured_at).toISOString(), timeline.capturedAt);
    assert.equal(new Date(written.effective_from).toISOString(), timeline.effectiveFrom);

    const audits = await PUBLICATION_AUDIT_ROWS();
    const audit = audits.find((entry) => entry.entity_id === result.version.id);
    assert.ok(audit !== undefined, 'the audit event was committed with the version');
    assert.equal(audit.action, FX_PUBLICATION_AUDIT_ACTION);
    assert.equal(audit.entity_type, 'billing_fx_rate_version');

    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.operatorId, EXECUTOR);
    assert.deepEqual(metadata.approvers, APPROVERS);
    assert.equal(metadata.sourceReference, REFERENCE);
    assert.match(String(metadata.reason), /corroborated by the published bulletin/);
    assert.equal(metadata.fxRateScaled, '12550000');
    assert.equal(metadata.capturedAt, timeline.capturedAt);
    assert.equal(metadata.effectiveFrom, timeline.effectiveFrom);
    assert.equal(metadata.publicationPolicyVersion, 'fx-publication-v1');
  });

  test('the audit states plainly that no price, payment or execution moved', async () => {
    const audits = await PUBLICATION_AUDIT_ROWS();
    for (const audit of audits) {
      const metadata = audit.metadata as Record<string, unknown>;
      assert.equal(metadata.priceChanged, false);
      assert.equal(metadata.providerPlansUnchanged, true);
      assert.equal(metadata.paymentConfirmed, false);
      assert.equal(metadata.grantsExecution, false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Price isolation (D8, D9)                                                   */
/* -------------------------------------------------------------------------- */

describe('price isolation — a publication never moves a customer price (D8, D9)', () => {
  test('plans, snapshots, subscriptions and Paystack identifiers are byte-identical', async () => {
    const user = await insertUser(pool, true);
    const seeded = await seedCommercialSubscription(pool, user.id);

    const before = {
      plans: await tableDigest('billing_provider_plans', 'valid_from, id'),
      snapshots: await tableDigest('billing_pricing_snapshots', 'created_at, id'),
      subscriptions: await tableDigest('subscriptions', 'user_id'),
      observations: await tableDigest('billing_fx_source_observations', 'retrieved_at, id'),
      fxCount: await countRows('billing_fx_rate_versions'),
    };

    const epochBefore = (
      await pool.query(
        `SELECT provider_plan_id, payment_amount_minor, payment_amount_exponent, payment_currency,
                fx_rate_version_id, status
           FROM billing_provider_plans ORDER BY valid_from, id`,
      )
    ).rows;
    const lockBefore = (
      await pool.query('SELECT locked_pricing_snapshot_id, provider_plan_id FROM subscriptions ORDER BY user_id')
    ).rows;

    const timeline = nextInstant();
    const result = await service().publish(evidence(timeline, { rate: '12.560000' }), timeline.asOf);

    assert.equal((await countRows('billing_fx_rate_versions')), before.fxCount + 1, 'exactly one version was added');
    assert.equal(await tableDigest('billing_provider_plans', 'valid_from, id'), before.plans);
    assert.equal(await tableDigest('billing_pricing_snapshots', 'created_at, id'), before.snapshots);
    assert.equal(await tableDigest('subscriptions', 'user_id'), before.subscriptions);
    assert.equal(await tableDigest('billing_fx_source_observations', 'retrieved_at, id'), before.observations);

    const epochAfter = (
      await pool.query(
        `SELECT provider_plan_id, payment_amount_minor, payment_amount_exponent, payment_currency,
                fx_rate_version_id, status
           FROM billing_provider_plans ORDER BY valid_from, id`,
      )
    ).rows;
    const lockAfter = (
      await pool.query('SELECT locked_pricing_snapshot_id, provider_plan_id FROM subscriptions ORDER BY user_id')
    ).rows;
    assert.deepEqual(epochAfter, epochBefore, 'no epoch amount or Paystack plan id moved');
    assert.deepEqual(lockAfter, lockBefore, 'no subscription lock moved');

    // The new version is not referenced by anything that prices a customer.
    const referencing = await pool.query<{ count: string }>(
      `SELECT (
         (SELECT count(*) FROM billing_provider_plans WHERE fx_rate_version_id = $1)
       + (SELECT count(*) FROM billing_pricing_snapshots WHERE fx_rate_version_id = $1)
       )::text AS count`,
      [result.version.id],
    );
    assert.equal(referencing.rows[0]!.count, '0', 'no epoch or snapshot pins the new version');

    // The seeded subscription still points at its own original snapshot.
    assert.equal(seeded.subscriptionId.length > 0, true);
    assert.equal(lockAfter.length, lockBefore.length);
  });

  test('the epochs on file still pin their ORIGINAL fx versions, never the newest one', async () => {
    const { rows } = await pool.query<{ fx_rate_version_id: string }>(
      'SELECT fx_rate_version_id FROM billing_provider_plans',
    );
    assert.ok(rows.length > 0, 'the fixture has an epoch to check');
    const newest = await pool.query<{ id: string }>(
      'SELECT id FROM billing_fx_rate_versions ORDER BY effective_from DESC LIMIT 1',
    );
    for (const row of rows) {
      assert.notEqual(row.fx_rate_version_id, newest.rows[0]!.id, 'an epoch never follows the newest rate implicitly');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Atomicity: an audit failure publishes nothing (D4)                          */
/* -------------------------------------------------------------------------- */

describe('the audit write is fatal, not best-effort (D4)', () => {
  test('when the audit write fails, the version is rolled back and nothing is published', async () => {
    const before = await countRows('billing_fx_rate_versions');
    const timeline = nextInstant();
    const targetInstant = timeline.effectiveFrom;

    await pool.query(`
      CREATE FUNCTION test_block_fx_publication_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit unavailable (test)';
      END $$;
    `);
    await pool.query(`
      CREATE TRIGGER test_block_fx_publication_audit
        BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION test_block_fx_publication_audit();
    `);

    try {
      const error = await service()
        .publish(evidence(timeline, { rate: '12.570000' }), timeline.asOf)
        .then(
          () => null,
          (caught: unknown) => caught,
        );
      assert.ok(error instanceof FxPublicationError, 'the publication refused');
      assert.equal((error as FxPublicationError).reason, 'audit_failed');
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS test_block_fx_publication_audit ON audit_events');
      await pool.query('DROP FUNCTION IF EXISTS test_block_fx_publication_audit()');
    }

    assert.equal(await countRows('billing_fx_rate_versions'), before, 'the version was rolled back');
    const orphan = await pool.query('SELECT id FROM billing_fx_rate_versions WHERE effective_from = $1', [
      targetInstant,
    ]);
    assert.equal(orphan.rows.length, 0, 'no un-audited version exists');
  });

  test('once the audit can be written again, the identical publication succeeds', async () => {
    // Proves the previous refusal was the audit failure and not the evidence.
    const timeline = nextInstant();
    const result = await service().publish(evidence(timeline, { rate: '12.570000' }), timeline.asOf);
    const audits = await PUBLICATION_AUDIT_ROWS();
    assert.ok(audits.some((entry) => entry.entity_id === result.version.id));
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals write nothing (D3, D5)                                            */
/* -------------------------------------------------------------------------- */

describe('a refused publication writes nothing (D3, D5)', () => {
  test('invalid evidence is refused before the first INSERT', async () => {
    const before = await countRows('billing_fx_rate_versions');
    const timeline = nextInstant();
    await assert.rejects(
      () => service().publish(evidence(timeline, { approvers: [EXECUTOR, APPROVERS[1]!] }), timeline.asOf),
      (error: unknown) => error instanceof FxPublicationError && error.reason === 'unauthorized_approvers',
    );
    assert.equal(await countRows('billing_fx_rate_versions'), before);
  });

  test('a stale capture is refused before the first INSERT (D1)', async () => {
    const before = await countRows('billing_fx_rate_versions');
    // The effective instant is strictly later than the last version (ordering
    // passes), but the CAPTURE is 901 s before the publication instant, so the
    // 900-second bound refuses it: a stale rate may not be published as though it
    // could price a new chargeable epoch.
    const timeline = nextInstant();
    await assert.rejects(
      () =>
        service().publish(
          evidence(timeline, {
            capturedAt: new Date(Date.parse(timeline.effectiveFrom) - 901_000).toISOString(),
          }),
          timeline.asOf,
        ),
      (error: unknown) => error instanceof FxPublicationError && error.reason === 'stale',
    );
    assert.equal(await countRows('billing_fx_rate_versions'), before);
  });

  test('a publication that is only ASSESSED writes nothing at all', async () => {
    const before = await countRows('billing_fx_rate_versions');
    const auditBefore = (await PUBLICATION_AUDIT_ROWS()).length;
    const timeline = nextInstant();
    const assessment = await service().assess(evidence(timeline, { rate: '12.580000' }), timeline.asOf);
    assert.equal(assessment.valid, true, JSON.stringify(assessment.issues));
    assert.equal(await countRows('billing_fx_rate_versions'), before, 'a dry run never writes');
    assert.equal((await PUBLICATION_AUDIT_ROWS()).length, auditBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* Forward-only correction (D6)                                               */
/* -------------------------------------------------------------------------- */

describe('corrections are forward-only (D6)', () => {
  test('a correction is a NEW version; the superseded one is untouched and both resolve', async () => {
    const firstTimeline = nextInstant();
    const first = await service().publish(evidence(firstTimeline, { rate: '12.600000' }), firstTimeline.asOf);
    const firstRow = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [first.version.id]))
      .rows[0]!;

    const correctionTimeline = nextInstant();
    const correction = await service().publish(
      evidence(correctionTimeline, {
        rate: '12.601000',
        reason: 'Correct the figure published minutes earlier; the corroborating bulletin figure is 12.601.',
        sourceReference: 'BoG daily interbank FX, 2026-10-15; correction ticket FX-1043',
      }),
      correctionTimeline.asOf,
    );

    assert.notEqual(correction.version.id, first.version.id, 'a correction is a new version, never an edit');

    const reread = (await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [first.version.id]))
      .rows[0]!;
    assert.deepEqual(reread, firstRow, 'the superseded version is byte-identical');

    // Both remain resolvable for their own windows: history is intact.
    const store = new BillingFxRateVersionStore(pool);
    const between = new Date(Date.parse(firstTimeline.effectiveFrom) + 1_000);
    const after = new Date(Date.parse(correctionTimeline.effectiveFrom) + 1_000);
    assert.equal((await store.resolve(between)).id, first.version.id);
    assert.equal((await store.resolve(after)).id, correction.version.id);
  });

  test('a published version can neither be updated nor deleted (append-only, SQLSTATE 27000)', async () => {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM billing_fx_rate_versions ORDER BY effective_from DESC LIMIT 1',
    );
    const id = rows[0]!.id;
    await assert.rejects(() => pool.query('UPDATE billing_fx_rate_versions SET fx_rate_scaled = 1 WHERE id = $1', [id]));
    await assert.rejects(() => pool.query('DELETE FROM billing_fx_rate_versions WHERE id = $1', [id]));
    const still = await pool.query('SELECT * FROM billing_fx_rate_versions WHERE id = $1', [id]);
    assert.equal(still.rows.length, 1, 'the version survived both attempts');
  });

  test('two versions effective at the same instant cannot exist — the second is refused', async () => {
    // Plant a version at an instant by hand, then try to publish at the same one.
    const planted = nextInstant();
    const instant = planted.effectiveFrom;
    await pool.query(
      `INSERT INTO billing_fx_rate_versions
         (fx_rate_scaled, fx_rate_scale, source, effective_from, captured_at)
       VALUES (12610000, 6, 'ops', $1, $1)`,
      [instant],
    );
    const before = await countRows('billing_fx_rate_versions');

    const colliding = nextInstant();
    await assert.rejects(
      () => service().publish(evidence(colliding, { rate: '12.611000', effectiveFrom: instant }), colliding.asOf),
      (error: unknown) => error instanceof FxPublicationError && error.reason === 'ordering_conflict',
    );
    assert.equal(await countRows('billing_fx_rate_versions'), before, 'nothing was written');
  });
});
