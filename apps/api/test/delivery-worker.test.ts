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
