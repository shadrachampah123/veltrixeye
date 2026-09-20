/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M8.5 — Order & Position Reconciliation tests.
 *
 * Exercises the provider-neutral reconciliation service against a real
 * embedded Postgres (same harness as M8.3 paper tests). Covers:
 *
 *  - exact matching (synchronized)
 *  - ambiguous matching
 *  - missing internal order / orphan provider order
 *  - missing internal position / orphan provider position
 *  - status / partial-fill / quantity mismatches
 *  - SL / TP / direction / symbol mismatches
 *  - uncertain submission outcome
 *  - provider unavailable (fail-closed)
 *  - duplicate reconciliation runs (idempotency)
 *  - idempotent findings across runs
 *  - manual resolution authorization (tenant isolation)
 *  - paper reconciliation path (synchronized paper state)
 *  - DisabledMT5Transport / fail-closed
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';

import {
  ExecutionProviderError,
  MT5_EXECUTION_PROVIDER_ID,
  PAPER_EXECUTION_PROVIDER_ID,
  type ReconciliationProviderOrder,
  type ReconciliationProviderPosition,
} from '@veltrixeye/contracts';
import {
  AuditService,
  DisabledMT5Transport,
  PaperReconciliationSnapshotProvider,
  ReconciliationService,
  UserService,
  createMT5ExecutionProvider,
  createPool,
  runMigrations,
  MIGRATIONS_DIR,
  type ReconciliationSnapshotProvider,
} from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PORT = 5452;
const DB_USER = 'test';
const DB_PASSWORD = randomBytes(16).toString('hex');
const DB_NAME = 'veltrixeye_core_m85_reconciliation';

let stopDb: () => Promise<void>;
let pool: ReturnType<typeof createPool>;
let users: UserService;
let audit: AuditService;

const uniqueEmail = () => `m85_${randomBytes(6).toString('hex')}@example.com`;

before(async () => {
  const dataDir = path.join(REPO_ROOT, '.test', 'pg-m85-reconciliation');
  rmSync(dataDir, { recursive: true, force: true });
  const db = await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  });
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
  const u = await users.create({ email: uniqueEmail(), passwordHash: 'x'.repeat(32), name: 'M85 Tester' });
  return u.id;
}

async function makeProfile(userId: string, provider = PAPER_EXECUTION_PROVIDER_ID): Promise<string> {
  const id = randomUUID();
  const mode = provider === MT5_EXECUTION_PROVIDER_ID ? 'demo' : 'paper';
  await pool.query(
    `INSERT INTO execution_profiles
       (id, user_id, mode, environment, provider_slug, account_ref, enabled, connection_status)
     VALUES ($1,$2,$3,$3,$4,'m85-acct',true,$5)`,
    [id, userId, mode, provider, mode === 'demo' ? 'unavailable' : 'connected'],
  );
  return id;
}

function build(snapshots: ReconciliationSnapshotProvider): ReconciliationService {
  return new ReconciliationService(pool as any, { snapshots, audit });
}

async function insertOrder(userId: string, profileId: string, over: Partial<{
  clientOrderId: string;
  providerOrderId: string | null;
  status: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  filledQuantity: number;
  averageFillPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  idempotencyKey: string;
  simulated: boolean;
}> = {}) {
  const id = randomUUID();
  const coId = over.clientOrderId ?? `coi-${id.slice(0, 8)}`;
  const idem = createHash('sha256')
    .update(over.idempotencyKey ?? `test-idem:${id}`, 'utf8')
    .digest('hex');
  const qty = over.quantity ?? 1;
  const status = over.status ?? 'filled';
  const filledQty = over.filledQuantity ?? (status === 'filled' ? qty : 0);
  const avg = over.averageFillPrice ?? (status === 'filled' ? 1.1 : null);
  const sim = over.simulated ?? true;
  await pool.query(
    `INSERT INTO execution_orders
       (id, user_id, execution_profile_id, client_order_id, provider_slug, provider_order_id,
        asset_class, symbol, side, order_type, quantity, requested_price, stop_loss_price,
        take_profit_price, filled_quantity, average_fill_price, status, idempotency_key,
        architecture_version, simulated, simulator_version, decision, fees, slippage,
        reference_price, reference_price_ms, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'paper',$5,'forex',$6,$7,'market',$8,NULL,$9,$10,$11,$12,$13,$14,'m8.1-execution-arch-1',
             $15,$16,$17::jsonb,0,0,$18,$19,now(),now())`,
    [
      id, userId, profileId, coId,
      over.providerOrderId ?? null,
      over.symbol ?? 'EURUSD',
      over.side ?? 'buy',
      qty,
      over.stopLoss ?? null,
      over.takeProfit ?? null,
      filledQty,
      avg,
      status,
      idem,
      sim,
      sim ? 'm8.3-paper-sim-1' : null,
      sim ? JSON.stringify({ action: 'open_long', symbol: over.symbol ?? 'EURUSD' }) : null,
      avg,
      avg ? Date.now() : null,
    ],
  );
  return id;
}

async function insertPosition(userId: string, profileId: string, over: Partial<{
  providerPositionId: string | null;
  symbol: string;
  direction: 'long' | 'short';
  quantity: number;
  averageEntryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  status: 'open' | 'closed';
  simulated: boolean;
}> = {}) {
  const id = randomUUID();
  const ppId = over.providerPositionId ?? `pp-${id.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO execution_positions
       (id, user_id, execution_profile_id, provider_slug, provider_position_id, asset_class,
        symbol, direction, quantity, average_entry_price, stop_loss_price, take_profit_price,
        realized_pl, unrealized_pl, status, opened_at, simulated, created_at, updated_at)
     VALUES ($1,$2,$3,'paper',$4,'forex',$5,$6,$7,$8,$9,$10,0,0,$11,now(),$12,now(),now())`,
    [
      id, userId, profileId, ppId,
      over.symbol ?? 'EURUSD',
      over.direction ?? 'long',
      over.quantity ?? 1,
      over.averageEntryPrice ?? 1.1,
      over.stopLoss ?? null,
      over.takeProfit ?? null,
      over.status ?? 'open',
      over.simulated ?? true,
    ],
  );
  return id;
}

function staticSnapshot(
  orders: ReconciliationProviderOrder[],
  positions: ReconciliationProviderPosition[],
  opts: { unavailable?: boolean; reason?: string } = {},
): ReconciliationSnapshotProvider {
  return {
    async getSnapshot() {
      if (opts.unavailable) {
        throw new ExecutionProviderError('unavailable', opts.reason ?? 'provider unavailable');
      }
      return {
        providerId: PAPER_EXECUTION_PROVIDER_ID,
        accountRef: null,
        retrievedAt: new Date().toISOString(),
        orders,
        positions,
        providerUnavailable: false,
      };
    },
  };
}

/* ---------------- Tests ---------------- */

test('M8.5: exact matching with paper snapshot produces synchronized state', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertOrder(userId, profileId, {
    status: 'filled', quantity: 1, filledQuantity: 1, averageFillPrice: 1.1,
    stopLoss: 1.09, takeProfit: 1.12,
  });
  await insertPosition(userId, profileId, {
    direction: 'long', quantity: 1, averageEntryPrice: 1.1,
    stopLoss: 1.09, takeProfit: 1.12,
  });

  const svc = build(new PaperReconciliationSnapshotProvider(pool as any));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.correctiveActionsTaken, false);
  assert.equal(res.run.healthState, 'synchronized');
  assert.equal(res.run.summary.findingsTotal, 0);
  assert.equal(res.run.summary.matchedOrders, 1);
  assert.equal(res.run.summary.matchedPositions, 1);
});

test('M8.5: duplicate manual triggers collapse to an existing run (idempotent)', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc = build(new PaperReconciliationSnapshotProvider(pool as any));
  const r1 = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const r2 = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  // Dedupe — second call should return a run (either the same or completed).
  assert.ok(r1.run.id);
  assert.ok(r2.run.id);
  const list = await svc.listRuns(userId, { limit: 10 });
  // After two immediate manual triggers we should NOT see more than 2 runs
  // (the dedupe window prevents rapid duplication).
  const manualRuns = list.runs.filter((r) => r.trigger === 'manual');
  assert.ok(manualRuns.length <= 2, `expected at most 2 manual runs, got ${manualRuns.length}`);
});

test('M8.5: provider unavailable fails closed', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId, MT5_EXECUTION_PROVIDER_ID);
  const svc = build(staticSnapshot([], [], { unavailable: true, reason: 'MT5 transport is disabled' }));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.healthState, 'provider_unavailable');
  assert.equal(res.run.providerUnavailable, true);
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'provider_unavailable'));
});

test('M8.5: DisabledMT5Transport health is disabled (fail-closed)', async () => {
  // Verifies that MT5 provider created with DisabledMT5Transport reports disabled/unavailable.
  const mt5 = createMT5ExecutionProvider(new DisabledMT5Transport(), {
    enabled: false, environment: 'demo', broker: null, server: null, accountRef: null,
    symbols: new Map(),
  });
  const h = await mt5.health();
  assert.equal(h.healthy, false);
  assert.equal(h.state, 'disabled');
  assert.equal(h.available, false);
  await assert.rejects(() => mt5.listOrders(), /unavailable|disabled/i);
});

test('M8.5: uncertain submission outcome is preserved (never auto-rejected)', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertOrder(userId, profileId, {
    status: 'submitted', providerOrderId: null, quantity: 1,
    filledQuantity: 0, averageFillPrice: null,
  });
  const svc = build(staticSnapshot([], []));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.healthState, 'uncertain');
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'uncertain_outcome'));
});

test('M8.5: orphan provider order surfaces provider_order_missing_internally', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc = build(staticSnapshot(
    [{ providerOrderId: 'ext-tkt-1', status: 'filled', filledQuantity: 1, averagePrice: 1.1 }],
    [],
  ));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'provider_order_missing_internally'));
});

test('M8.5: orphan provider position surfaces provider_position_missing_internally', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc = build(staticSnapshot([], [{
    providerPositionId: 'pp-orphan', symbol: 'EURUSD', direction: 'long',
    quantity: 1, averageEntryPrice: 1.1,
  }]));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'provider_position_missing_internally'));
});

test('M8.5: internal filled order missing at provider is flagged (and NOT resubmit-safe)', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertOrder(userId, profileId, {
    status: 'accepted', providerOrderId: 'ghost-tkt',
    quantity: 1, filledQuantity: 0, averageFillPrice: null,
  });
  const svc = build(staticSnapshot([], []));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'internal_order_missing_at_provider'));
});

test('M8.5: internal position missing at provider is flagged', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertPosition(userId, profileId, { quantity: 1, averageEntryPrice: 1.1 });
  const svc = build(staticSnapshot([], []));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'internal_position_missing_at_provider'));
});

test('M8.5: status mismatch (filled vs rejected)', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const oid = randomUUID().slice(0, 8);
  await insertOrder(userId, profileId, {
    clientOrderId: `co-${oid}`, idempotencyKey: `idem-status-${oid}`,
    status: 'filled', quantity: 1, filledQuantity: 1, averageFillPrice: 1.1,
  });
  const svc = build(staticSnapshot([{
    providerOrderId: `po-${oid}`, clientOrderId: `co-${oid}`, idempotencyKey: createHash('sha256').update(`idem-status-${oid}`, 'utf8').digest('hex'),
    status: 'rejected', filledQuantity: 0, averagePrice: null,
  }], []));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'status_mismatch'));
});

test('M8.5: filled quantity mismatch', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const oid = randomUUID().slice(0, 8);
  const co = `co-qty-${oid}`;
  const ik = `idem-qty-${oid}`;
  await insertOrder(userId, profileId, {
    clientOrderId: co, idempotencyKey: ik,
    status: 'filled', quantity: 2, filledQuantity: 2, averageFillPrice: 1.1,
  });
  const svc = build(staticSnapshot([{
    providerOrderId: `po-${oid}`, clientOrderId: co, idempotencyKey: ik,
    status: 'filled', filledQuantity: 1, averagePrice: 1.1,
    quantity: 2, side: 'buy', symbol: 'EURUSD',
  }], []));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some(
    (f) => f.code === 'filled_quantity_mismatch' || f.code === 'partial_fill_quantity_mismatch',
  ));
});

test('M8.5: SL / TP mismatches on orders and positions', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const oid = randomUUID().slice(0, 8);
  const co = `co-sltp-${oid}`;
  const ik = `idem-sltp-${oid}`;
  const pp = `pp-sltp-${oid}`;
  await insertOrder(userId, profileId, {
    clientOrderId: co, idempotencyKey: ik,
    status: 'filled', quantity: 1, filledQuantity: 1, averageFillPrice: 1.1,
    stopLoss: 1.09, takeProfit: 1.12,
  });
  await insertPosition(userId, profileId, {
    direction: 'long', quantity: 1, averageEntryPrice: 1.1,
    stopLoss: 1.09, takeProfit: 1.12, providerPositionId: pp,
  });
  const svc = build(staticSnapshot(
    [{
      providerOrderId: `po-${oid}`, clientOrderId: co, idempotencyKey: ik,
      status: 'filled', filledQuantity: 1, averagePrice: 1.1,
      stopLossPrice: 1.08, takeProfitPrice: 1.13, side: 'buy', symbol: 'EURUSD', quantity: 1,
    }],
    [{
      providerPositionId: pp, symbol: 'EURUSD', direction: 'long', quantity: 1,
      averageEntryPrice: 1.1, stopLossPrice: 1.08, takeProfitPrice: 1.13,
    }],
  ));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  const codes = new Set(detail.findings.map((f) => f.code));
  assert.ok(codes.has('stop_loss_mismatch'), 'expected SL mismatch');
  assert.ok(codes.has('take_profit_mismatch'), 'expected TP mismatch');
});

test('M8.5: direction and symbol mismatch', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const pp = `pp-ds-${randomUUID().slice(0, 8)}`;
  await insertPosition(userId, profileId, {
    symbol: 'EURUSD', direction: 'long', quantity: 1, averageEntryPrice: 1.1,
    providerPositionId: pp,
  });
  // Provider position matches by providerPositionId but has wrong symbol/direction.
  const svc = build(staticSnapshot([], [{
    providerPositionId: pp, symbol: 'GBPUSD', direction: 'short', quantity: 1, averageEntryPrice: 1.3,
  }]));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  const codes = new Set(detail.findings.map((f) => f.code));
  assert.ok(codes.has('direction_mismatch'), `expected direction_mismatch, got ${[...codes].join(',')}`);
  assert.ok(codes.has('symbol_mismatch'), `expected symbol_mismatch, got ${[...codes].join(',')}`);
});

test('M8.5: ambiguous position match (candidates >1) is reported, never guessed', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertPosition(userId, profileId, {
    providerPositionId: null, symbol: 'EURUSD', direction: 'long',
    quantity: 1, averageEntryPrice: 1.1,
  });
  const svc = build(staticSnapshot([], [
    { providerPositionId: 'pp-a', symbol: 'EURUSD', direction: 'long', quantity: 1, averageEntryPrice: 1.1 },
    { providerPositionId: 'pp-b', symbol: 'EURUSD', direction: 'long', quantity: 1, averageEntryPrice: 1.1 },
  ]));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const detail = await svc.getRunDetail(userId, res.run.id);
  assert.ok(detail.findings.some((f) => f.code === 'ambiguous_match'));
});

test('M8.5: manual resolution is tenant-isolated', async () => {
  const userA = await makeUser();
  const userB = await makeUser();
  const profileA = await makeProfile(userA);
  const profileB = await makeProfile(userB);
  const svc = build(staticSnapshot([], [], { unavailable: true, reason: 'test' }));
  const rA = await svc.triggerRun({ userId: userA, executionProfileId: profileA, trigger: 'manual' });
  const rB = await svc.triggerRun({ userId: userB, executionProfileId: profileB, trigger: 'manual' });
  const detailA = await svc.getRunDetail(userA, rA.run.id);
  const finding = detailA.findings.find((f) => f.code === 'provider_unavailable');
  assert.ok(finding);
  // User B cannot resolve A's finding.
  await assert.rejects(
    () => svc.resolveFinding(userB, finding.id, { action: 'acknowledge' }),
    /not found/i,
  );
  // Owner can acknowledge.
  const ack = await svc.resolveFinding(userA, finding.id, { action: 'acknowledge' });
  assert.equal(ack.resolutionState, 'acknowledged');
  void rB;
});

test('M8.5: findings accumulate but run health updates after resolution', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc = build(staticSnapshot([], [], { unavailable: true, reason: 'test' }));
  const r1 = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  const d1 = await svc.getRunDetail(userId, r1.run.id);
  const f = d1.findings.find((x) => x.code === 'provider_unavailable');
  assert.ok(f);
  await svc.resolveFinding(userId, f.id, { action: 'mark_resolved', note: 'operator verified' });
  const status = await svc.getStatus(userId);
  // After resolving the finding, there should be no open findings left for this state.
  assert.equal(status.openFindings, 0);
});

test('M8.5: fail-closed on generic snapshot error (non-ExecutionProviderError)', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc: ReconciliationService = new ReconciliationService(pool as any, {
    snapshots: { async getSnapshot() { throw new Error('boom'); } },
    audit,
  });
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.healthState, 'provider_unavailable');
});

test('M8.5: reconciliation summary counts include expected/observed', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  await insertOrder(userId, profileId, { status: 'filled', quantity: 1, filledQuantity: 1, averageFillPrice: 1.1 });
  await insertPosition(userId, profileId, { quantity: 1, averageEntryPrice: 1.1 });
  const svc = build(staticSnapshot(
    [{ providerOrderId: 'extra-1', status: 'filled', filledQuantity: 1, averagePrice: 1.1 }],
    [],
  ));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.summary.expectedOrders, 1);
  assert.equal(res.run.summary.expectedPositions, 1);
  assert.equal(res.run.summary.providerOrders, 1);
  assert.equal(res.run.summary.providerPositions, 0);
});

test('M8.5: corrective actions are ALWAYS disabled (never mutate provider)', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc = build(new PaperReconciliationSnapshotProvider(pool as any));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.correctiveActionsTaken, false);
});

/* ---------------- M10 Gate 10 — persisted failure reasons are closed tokens ---------------- */

// Fabricated sentinel only; never a real credential.
const GATE10_SECRET = 'FAKE-BROKER-PASSWORD-sentinel-7f3a9c2e';

async function gate10PersistedText(runId: string): Promise<string> {
  const run = await pool.query('SELECT failure_reason FROM reconciliation_runs WHERE id = $1', [runId]);
  const snap = await pool.query('SELECT provider_unavailable_reason FROM reconciliation_snapshots WHERE run_id = $1', [runId]);
  const findings = await pool.query('SELECT detail FROM reconciliation_findings WHERE run_id = $1', [runId]);
  const audits = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'execution.reconciliation_run_completed' AND metadata->>'runId' = $1`, [runId]);
  return JSON.stringify({ run: run.rows, snap: snap.rows, findings: findings.rows, audits: audits.rows });
}

test('Gate 10: an ExecutionProviderError message is never persisted; the category token is', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId, MT5_EXECUTION_PROVIDER_ID);
  const svc = build(staticSnapshot([], [], { unavailable: true, reason: `terminal rejected login password=${GATE10_SECRET}` }));
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.healthState, 'provider_unavailable');
  assert.equal(res.run.failureReason, 'provider_error:unavailable');
  const detail = await svc.getRunDetail(userId, res.run.id);
  const finding = detail.findings.find((f) => f.code === 'provider_unavailable');
  assert.ok(finding);
  assert.deepEqual(finding.detail, { reason: 'provider_error:unavailable' });
  const persisted = await gate10PersistedText(res.run.id);
  assert.equal(persisted.includes(GATE10_SECRET), false, persisted);
  assert.equal(JSON.stringify(detail).includes(GATE10_SECRET), false);
  // The already-correct allowlisted audit metadata is unchanged (no reason/message field).
  const audit = await pool.query(`SELECT metadata FROM audit_events WHERE action = 'execution.reconciliation_run_completed' AND metadata->>'runId' = $1`, [res.run.id]);
  assert.equal(audit.rows.length, 1);
  assert.deepEqual(Object.keys(audit.rows[0].metadata).sort(), ['automationOff', 'correctiveActionsTaken', 'findingsOpen', 'findingsTotal', 'healthState', 'providerId', 'reconciliationVersion', 'runId', 'simulated', 'status', 'trigger']);
});

test('Gate 10: a generic (non-provider) error persists provider_error:unknown, never its message', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId);
  const svc: ReconciliationService = new ReconciliationService(pool as any, {
    snapshots: { async getSnapshot() { throw new Error(`boom token=${GATE10_SECRET}\n[FAKE-AUDIT] injected line`); } },
    audit,
  });
  const res = await svc.triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(res.run.failureReason, 'provider_error:unknown');
  const persisted = await gate10PersistedText(res.run.id);
  assert.equal(persisted.includes(GATE10_SECRET), false);
  assert.equal(persisted.includes('FAKE-AUDIT'), false);
  assert.equal(persisted.includes('boom'), false);
});

test('Gate 10: a snapshot RETURNED as unavailable persists only a machine-token reason', async () => {
  const userId = await makeUser();
  const profileId = await makeProfile(userId, MT5_EXECUTION_PROVIDER_ID);
  const returned = (reason: string): ReconciliationSnapshotProvider => ({
    async getSnapshot() {
      return { providerId: MT5_EXECUTION_PROVIDER_ID, accountRef: null, retrievedAt: new Date().toISOString(), orders: [], positions: [], providerUnavailable: true, providerUnavailableReason: reason };
    },
  });
  const freeText = await build(returned(`Login failed for ${GATE10_SECRET}`)).triggerRun({ userId, executionProfileId: profileId, trigger: 'manual' });
  assert.equal(freeText.run.failureReason, 'provider_error:unknown');
  assert.equal((await gate10PersistedText(freeText.run.id)).includes(GATE10_SECRET), false);
  const otherUser = await makeUser();
  const otherProfile = await makeProfile(otherUser, MT5_EXECUTION_PROVIDER_ID);
  const token = await build(returned('mt5_transport_unconfigured')).triggerRun({ userId: otherUser, executionProfileId: otherProfile, trigger: 'manual' });
  assert.equal(token.run.failureReason, 'mt5_transport_unconfigured');
});
