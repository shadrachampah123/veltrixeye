import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { DeliveryWorker } from '@veltrixeye/core';
import { startDeliveryWorkerTicker } from '../src/delivery-worker.js';
import { resetWorkerLivenessForTests, workerLivenessSnapshot } from '../src/worker-liveness.js';

const ZERO_BATCH = {
  claimed: 0,
  delivered: 0,
  retried: 0,
  failed: 0,
  unavailable: 0,
  recovered: 0,
  deadLettered: 0,
  requeued: 0,
};

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

beforeEach(() => resetWorkerLivenessForTests());

describe('notification ticker liveness', () => {
  test('a maintenance failure is visible and the skipped delivery batch is not a success', async () => {
    let resolveMaintenanceStarted!: () => void;
    const maintenanceStarted = new Promise<void>((resolve) => {
      resolveMaintenanceStarted = resolve;
    });
    let rejectMaintenance!: (error: Error) => void;
    const maintenance = new Promise<never>((_resolve, reject) => {
      rejectMaintenance = reject;
    });
    let runOnceCalls = 0;

    // The ticker needs only these two public methods; the remaining DeliveryWorker
    // behavior is covered by its core integration tests.
    const worker = {
      runMaintenance() {
        resolveMaintenanceStarted();
        return maintenance;
      },
      async runOnce() {
        runOnceCalls += 1;
        return ZERO_BATCH;
      },
    } as unknown as DeliveryWorker;

    const ticker = startDeliveryWorkerTicker(worker, {
      intervalMs: 60_000,
      batchSize: 5,
      maintenanceEveryRuns: 1,
      logger: SILENT_LOGGER,
    });

    try {
      await maintenanceStarted;
      assert.equal(workerLivenessSnapshot().notifications.inFlight, 1);
      rejectMaintenance(Object.assign(new Error('synthetic maintenance failure'), { code: 'ECONNRESET' }));
    } finally {
      rejectMaintenance(Object.assign(new Error('test cleanup'), { code: 'ECONNRESET' }));
      await ticker.stop();
    }

    const liveness = workerLivenessSnapshot().notifications;
    assert.equal(runOnceCalls, 0, 'delivery is skipped when its maintenance prerequisite fails');
    assert.equal(liveness.inFlight, 0);
    assert.equal(liveness.successes, 0);
    assert.equal(liveness.failures, 1);
    assert.equal(liveness.lastFailureCode, 'econnreset');
    assert.ok(liveness.lastFailureAt);
    assert.equal(liveness.lastSuccessAt, null);
  });

  test('a completed maintenance and delivery batch records one success', async () => {
    const worker = {
      async runMaintenance() {
        return { recovered: 0, deadLettered: 0, requeued: 0, deleted: 0, depth: {} };
      },
      async runOnce() {
        return ZERO_BATCH;
      },
    } as unknown as DeliveryWorker;

    const ticker = startDeliveryWorkerTicker(worker, {
      intervalMs: 60_000,
      batchSize: 5,
      maintenanceEveryRuns: 1,
      logger: SILENT_LOGGER,
    });
    await ticker.stop();

    const liveness = workerLivenessSnapshot().notifications;
    assert.equal(liveness.inFlight, 0);
    assert.equal(liveness.successes, 1);
    assert.equal(liveness.failures, 0);
    assert.ok(liveness.lastSuccessAt);
  });
});

test('a batch failure updates liveness and never records a completed batch as success', async () => {
  let resolveBatchStarted!: () => void;
  const batchStarted = new Promise<void>((resolve) => {
    resolveBatchStarted = resolve;
  });
  let rejectBatch!: (error: Error) => void;
  const batch = new Promise<never>((_resolve, reject) => {
    rejectBatch = reject;
  });
  const errorLogs: string[] = [];
  const worker = {
    async runMaintenance() {
      return { recovered: 0, deadLettered: 0, requeued: 0, deleted: 0, depth: {} };
    },
    runOnce() {
      resolveBatchStarted();
      return batch;
    },
  } as unknown as DeliveryWorker;
  const ticker = startDeliveryWorkerTicker(worker, {
    intervalMs: 60_000,
    batchSize: 5,
    maintenanceEveryRuns: 1,
    logger: {
      info() {},
      warn() {},
      error(_message, metadata) { errorLogs.push(JSON.stringify(metadata)); },
    },
  });

  try {
    await batchStarted;
    const duringBatch = workerLivenessSnapshot().notifications;
    assert.equal(duringBatch.inFlight, 1);
    assert.equal(duringBatch.successes, 0);
    assert.equal(duringBatch.lastSuccessAt, null);
    rejectBatch(Object.assign(new Error('synthetic SMTP_PASS=sensitive-example failure'), { code: 'ECONNRESET' }));
  } finally {
    // Ensure stop can always finish even if an earlier assertion fails.
    rejectBatch(Object.assign(new Error('test cleanup'), { code: 'ECONNRESET' }));
    await ticker.stop();
  }

  const afterBatch = workerLivenessSnapshot().notifications;
  assert.equal(afterBatch.inFlight, 0);
  assert.equal(afterBatch.successes, 0);
  assert.equal(afterBatch.failures, 1);
  assert.equal(afterBatch.lastFailureCode, 'econnreset');
  assert.equal(afterBatch.lastSuccessAt, null);
  assert.match(errorLogs[0] ?? '', /failureCode.*econnreset/i);
  assert.doesNotMatch(errorLogs.join('\n'), /sensitive-example|SMTP_PASS=/);
});

test('the ticker does not overlap and stop waits for the in-flight batch', async () => {
  let resolveBatchStarted!: () => void;
  const batchStarted = new Promise<void>((resolve) => {
    resolveBatchStarted = resolve;
  });
  let finishBatch!: () => void;
  const batch = new Promise<void>((resolve) => {
    finishBatch = resolve;
  });
  let calls = 0;
  const worker = {
    async runOnce() {
      calls += 1;
      resolveBatchStarted();
      await batch;
      return ZERO_BATCH;
    },
  } as unknown as DeliveryWorker;
  const ticker = startDeliveryWorkerTicker(worker, {
    intervalMs: 1_000,
    batchSize: 5,
    maintenanceEveryRuns: 10,
    logger: SILENT_LOGGER,
  });

  try {
    await batchStarted;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(calls, 1, 'timer ticks are ignored while a batch is in flight');
    assert.equal(workerLivenessSnapshot().notifications.inFlight, 1);
    let stopped = false;
    const stopping = ticker.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, 'shutdown waits rather than abandoning the in-flight batch');
    finishBatch();
    await stopping;
    assert.equal(stopped, true);
  } finally {
    finishBatch();
    await ticker.stop();
  }

  assert.equal(calls, 1);
  assert.equal(workerLivenessSnapshot().notifications.successes, 1);
  assert.equal(workerLivenessSnapshot().notifications.inFlight, 0);
});
