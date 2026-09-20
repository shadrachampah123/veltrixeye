/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M10 Gate 9 §20/§21/§22 (B9) — reconciliation preserves provider uncertainty.
 *
 * Runs the provider-neutral reconciliation service against a real embedded
 * Postgres (same harness as M8.5) and pins the safety properties the Gate 9
 * contract requires of an unobservable provider state:
 *
 *  - a matched order whose provider state is uncertain becomes an
 *    `uncertain_outcome` finding, never a `status_mismatch` (which reads as
 *    "the broker contradicts us" and invites repair);
 *  - an unmatched provider order with an uncertain state is not evidence of a
 *    missing internal order, and an uncertain internal submission is not
 *    evidence of an order missing at the provider;
 *  - the captured snapshot keeps the explicit `uncertain` status;
 *  - no durable order status is rewritten, and no repair/retry/cancel happens.
 *
 * No provider, network, credential or live path is involved.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  MT5_EXECUTION_PROVIDER_ID,
  PAPER_EXECUTION_PROVIDER_ID,
  type ReconciliationProviderOrder,
  type ReconciliationProviderPosition,
} from '@veltrixeye/contracts';
import {
  AuditService,
  ReconciliationService,
  UserService,
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  type ReconciliationSnapshotProvider,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5463;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_m10_gate9_reconciliation';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;

const uniqueEmail = () => `m10g9_${randomBytes(6).toString('hex')}@example.com`;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m10-gate9-reconciliation');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({ dataDir, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME });
  stopDb = db.stop;
  pool = createPool({ databaseUrl: db.dbUrl });
  await runMigrations(pool, MIGRATIONS_DIR);
  users = new UserService(pool);
  audit = new AuditService(pool);
}, { timeout: 240_000 });

after(async () => {
  await pool?.end();
  await stopDb?.();
});

async function makeUser(): Promise<string> {
  const u = await users.create({ email: uniqueEmail(), passwordHash: 'x'.repeat(32), name: 'M10 Gate 9 Tester' });
  return u.id;
}

async function makeProfile(userId: string, provider = PAPER_EXECUTION_PROVIDER_ID): Promise<string> {
  const id = randomUUID();
  const mode = provider === MT5_EXECUTION_PROVIDER_ID ? 'demo' : 'paper';
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,$3,$3,$4,'m10g9-acct',true,$5)`,
    [id, userId, mode, provider, mode === 'demo' ? 'unavailable' : 'connected'],
  );
  return id;
}

async function insertOrder(userId: string, profileId: string, over: Partial<{
  clientOrderId: string;
  providerOrderId: string | null;
  status: string;
  symbol: string;
  quantity: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  idempotencyKey: string;
}> = {}): Promise<string> {
  const id = randomUUID();
  const qty = over.quantity ?? 1;
  const status = over.status ?? 'filled';
  const filledQty = over.filledQuantity ?? (status === 'filled' ? qty : 0);
  const avg = over.averageFillPrice ?? (status === 'filled' ? 1.1 : null);
  const idem = createHash('sha256').update(over.idempotencyKey ?? `m10g9:${id}`, 'utf8').digest('hex');
  await pool.query(
    `INSERT INTO execution_orders
       (id, user_id, execution_profile_id, client_order_id, provider_slug, provider_order_id,
        asset_class, symbol, side, order_type, quantity, requested_price, stop_loss_price,
        take_profit_price, filled_quantity, average_fill_price, status, idempotency_key,
        architecture_version, simulated, simulator_version, decision, fees, slippage,
        reference_price, reference_price_ms, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'paper',$5,'forex',$6,'buy','market',$7,NULL,NULL,NULL,$8,$9,$10,$11,'m8.1-execution-arch-1',
             true,'m10-gate9-test','{"action":"open_long","source":"m10-gate9-test"}'::jsonb,0,0,$9,$12,now(),now())`,
    [
      id, userId, profileId,
      // Gate 9 §11: the durable identity is VeltrixEye's own; a provider ticket
      // alone is never the join key.
      over.clientOrderId ?? `ve-${id.replace(/-/g, '').slice(0, 24)}`,
      over.providerOrderId ?? null,
      over.symbol ?? 'EURUSD',
      qty, filledQty, avg, status, idem,
      avg === null ? null : Date.now(),
    ],
  );
  return id;
}

function staticSnapshot(
  orders: ReconciliationProviderOrder[],
  positions: ReconciliationProviderPosition[] = [],
  providerId = PAPER_EXECUTION_PROVIDER_ID,
): ReconciliationSnapshotProvider {
  return {
    async getSnapshot() {
      return { providerId, accountRef: null, retrievedAt: new Date().toISOString(), orders, positions, providerUnavailable: false };
    },
  };
}

const build = (snapshots: ReconciliationSnapshotProvider) => new ReconciliationService(pool as any, { snapshots, audit });

const codesOf = (findings: Array<{ code: string }>) => findings.map((f) => f.code).sort();

/** Fails with a readable label instead of a TypeScript-only index guard. */
function one<T>(rows: readonly T[], label: string): T {
  const value = rows[0];
  assert.ok(value !== undefined, `expected at least one: ${label}`);
  return value;
}

async function snapshotOrdersFor(runId: string): Promise<Array<Record<string, unknown>>> {
  const res = await pool.query<{ orders_snapshot: unknown }>(
    'SELECT orders_snapshot FROM reconciliation_snapshots WHERE run_id = $1',
    [runId],
  );
  const row = res.rows[0]?.orders_snapshot;
  return Array.isArray(row) ? row as Array<Record<string, unknown>> : [];
}

/* -------------------------------------------------------------------------- */
test('Gate 9 §21: an uncertain provider state on a matched order is uncertainty, not drift', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const orderId = await insertOrder(userId, profileId, {
    status: 'submitted', providerOrderId: 'g9-tkt-1', quantity: 1, filledQuantity: 0, averageFillPrice: null,
  });
  const svc = build(staticSnapshot([
    // A snapshot that could not establish the provider state: no status word,
    // only the explicit uncertainty marker.
    { providerOrderId: 'g9-tkt-1', statusUncertain: true, filledQuantity: 0 },
  ]));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.healthState, 'uncertain');
  const detail = await svc.getRunDetail(userId, res.run.id);
  const uncertain = detail.findings.filter((f) => f.code === 'uncertain_outcome');
  assert.equal(uncertain.length, 1);
  assert.equal(one(uncertain, 'uncertain finding').internalOrderId, orderId);
  assert.equal(one(uncertain, 'uncertain finding').expectedField, 'provider_order_status');
  assert.equal(one(uncertain, 'uncertain finding').severity, 'critical');
  assert.equal(codesOf(detail.findings).includes('status_mismatch'), false, 'uncertainty must never be reported as status drift');
  assert.equal(codesOf(detail.findings).includes('internal_order_missing_at_provider'), false);
  assert.equal(codesOf(detail.findings).includes('order_repaired'), false);
  // No repair: the durable order row is untouched, and the closed vocabulary is
  // never widened with a fabricated provider status.
  const order = await pool.query<{ status: string; provider_order_id: string | null; filled_quantity: string }>(
    'SELECT status, provider_order_id, filled_quantity FROM execution_orders WHERE id = $1',
    [orderId],
  );
  const stored = one(order.rows, 'order row');
  assert.equal(stored.status, 'submitted');
  assert.equal(stored.provider_order_id, 'g9-tkt-1');
  assert.equal(Number(stored.filled_quantity), 0);
});

test('Gate 9 §21: `uncertain` is preserved in the captured snapshot, not coerced', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertOrder(userId, profileId, { status: 'submitted', providerOrderId: 'g9-tkt-2', averageFillPrice: null, filledQuantity: 0 });
  const svc = build(staticSnapshot([
    // The provider row carries the explicit snapshot status (as produced by the
    // MT5 adapter for a status outside the closed vocabulary).
    { providerOrderId: 'g9-tkt-2', status: 'uncertain', statusUncertain: true, filledQuantity: 0 },
  ]));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const snapshot = await snapshotOrdersFor(res.run.id);
  assert.equal(snapshot.length, 1);
  const row = one(snapshot, 'uncertain snapshot row');
  assert.equal(row.status, 'uncertain');
  assert.equal(row.statusUncertain, true);
  assert.notEqual(row.status, 'failed');
  assert.notEqual(row.status, 'rejected');
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'uncertain_outcome'));
  assert.equal(codesOf(detail.findings).includes('status_mismatch'), false);
});

test('Gate 9 §21: an unmatched provider order with an uncertain state is never a missing internal order', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc = build(staticSnapshot([
    { providerOrderId: 'g9-orphan-1', status: 'uncertain', statusUncertain: true },
    { providerOrderId: 'g9-orphan-2', status: 'filled', filledQuantity: 1, averagePrice: 1.1 },
  ]));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  const uncertain = detail.findings.filter((f) => f.code === 'uncertain_outcome');
  assert.equal(uncertain.length, 1, 'only the uncertain orphan row produces an uncertainty finding');
  assert.equal(one(uncertain, 'uncertain finding').internalOrderId, null);
  assert.equal(one(uncertain, 'uncertain finding').providerOrderId, 'g9-orphan-1');
  assert.equal(one(uncertain, 'uncertain finding').expectedField, 'internal_order');
  // The definitively-known orphan is still reported as an orphan...
  assert.ok(detail.findings.some((f) => f.code === 'provider_order_missing_internally' && f.providerOrderId === 'g9-orphan-2'));
  // ...and the uncertain one is never folded into that category.
  assert.equal(detail.findings.some((f) => f.code === 'provider_order_missing_internally' && f.providerOrderId === 'g9-orphan-1'), false);
  assert.equal(res.run.healthState, 'uncertain', 'an uncertainty finding dominates the run health');
});

test('Gate 9 §22: an internal submission with no provider confirmation stays unresolved', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId, MT5_EXECUTION_PROVIDER_ID);
  await insertOrder(userId, profileId, { status: 'submitted', providerOrderId: null, averageFillPrice: null, filledQuantity: 0 });
  await insertOrder(userId, profileId, { status: 'rejected', providerOrderId: null, averageFillPrice: null, filledQuantity: 0 });
  const svc = build(staticSnapshot([], [], MT5_EXECUTION_PROVIDER_ID));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.equal(codesOf(detail.findings).includes('internal_order_missing_at_provider'), false, 'an unconfirmed submission is not proof of absence');
  assert.ok(detail.findings.some((f) => f.code === 'uncertain_outcome'));
  assert.equal(res.run.healthState, 'uncertain');
  const statuses = await pool.query<{ status: string }>(
    'SELECT status FROM execution_orders WHERE execution_profile_id = $1 ORDER BY status',
    [profileId],
  );
  assert.deepEqual(statuses.rows.map((r) => r.status), ['rejected', 'submitted'], 'the durable statuses are neither repaired nor reinterpreted');
});

test('Gate 9 §21 control: a definitive provider status still reconciles normally', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertOrder(userId, profileId, { status: 'filled', providerOrderId: 'g9-clean-1', quantity: 1, filledQuantity: 1, averageFillPrice: 1.1 });
  const clean = build(staticSnapshot([{ providerOrderId: 'g9-clean-1', status: 'filled', filledQuantity: 1, averagePrice: 1.1 }]));
  const res = await clean.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.healthState, 'synchronized');
  const detail = await clean.getRunDetail(userId, res.run.id);
  assert.deepEqual(codesOf(detail.findings), []);
  const control = one(await snapshotOrdersFor(res.run.id), 'control snapshot row');
  assert.equal(control.status, 'filled');
  assert.equal('statusUncertain' in control, false, 'a known status carries no uncertainty marker');
});
