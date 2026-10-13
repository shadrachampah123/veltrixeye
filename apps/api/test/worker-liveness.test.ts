import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  drainNotificationOutbox,
  HEARTBEAT_MAX_BATCH,
  type NotificationBatchSummary,
} from '../src/notification-heartbeat.js';
import {
  failureCode,
  recordWorkerFailure,
  recordWorkerStart,
  recordWorkerSuccess,
  resetWorkerLivenessForTests,
  workerLivenessSnapshot,
} from '../src/worker-liveness.js';

/**
 * These tests are deliberately DB-free: both modules are pure process state and
 * pure orchestration, so the suite runs in milliseconds and pins the two
 * properties that matter for production —
 *
 *   1. the liveness snapshot served by the unauthenticated `GET /api/health`
 *      can never carry an error MESSAGE (only a bounded machine code), and
 *   2. the notification heartbeat can never throw, delay unboundedly, or
 *      request an unbounded batch, because it runs in front of a scan.
 */

const ZERO: NotificationBatchSummary = {
  claimed: 0,
  delivered: 0,
  retried: 0,
  failed: 0,
  unavailable: 0,
  recovered: 0,
  deadLettered: 0,
  requeued: 0,
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetWorkerLivenessForTests();
});

describe('failure code extraction (served unauthenticated)', () => {
  test('reduces a Postgres SQLSTATE to a bounded lowercase code', () => {
    const err = Object.assign(new Error('relation "notification_deliveries" does not exist'), {
      code: '42P01',
    });
    assert.equal(failureCode(err), '42p01');
  });

  test('reduces a Node network error code', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:25'), { code: 'ECONNREFUSED' });
    assert.equal(failureCode(err), 'econnrefused');
  });

  test('NEVER leaks the error message, even when it carries a connection string or row values', () => {
    const err = Object.assign(
      new Error('postgres://user:hunter2@db.internal:5432/prod failed for row alice@example.com'),
      { code: '28P01' },
    );
    const code = failureCode(err);
    assert.equal(code, '28p01');
    assert.equal(code.includes('hunter2'), false);
    assert.equal(code.includes('postgres://'), false);
    assert.equal(code.includes('@'), false);
  });

  test('falls back to a bounded name, then to "unknown" — never to message text', () => {
    assert.equal(failureCode(new TypeError('boom')), 'typeerror');
    assert.equal(failureCode(new Error('plain message with spaces')), 'error');
    assert.equal(failureCode(null), 'unknown');
    assert.equal(failureCode(undefined), 'unknown');
    assert.equal(failureCode({}), 'unknown');
    assert.equal(failureCode(12345), 'unknown');
    // An over-long or character-heavy "code" is refused rather than passed through.
    assert.equal(failureCode({ code: 'x'.repeat(200) }), 'unknown');
    assert.equal(failureCode({ code: 'leak me with spaces' }), 'unknown');
  });
});

describe('worker liveness registry', () => {
  test('tracks in-flight, successes, timestamps and staleness per worker', () => {
    recordWorkerStart('scanner');
    assert.equal(workerLivenessSnapshot().scanner.inFlight, 1);

    recordWorkerSuccess('scanner', 1_000);
    const afterSuccess = workerLivenessSnapshot(6_000).scanner;
    assert.equal(afterSuccess.inFlight, 0);
    assert.equal(afterSuccess.successes, 1);
    assert.equal(afterSuccess.failures, 0);
    assert.equal(afterSuccess.lastSuccessAt, new Date(1_000).toISOString());
    assert.equal(afterSuccess.successAgeMs, 5_000);

    // The two workers are independent: no scanner state leaks into notifications.
    const notifications = workerLivenessSnapshot(6_000).notifications;
    assert.equal(notifications.successes, 0);
    assert.equal(notifications.lastSuccessAt, null);
    assert.equal(notifications.successAgeMs, null);
  });

  test('a failure records the code and the timestamp without incrementing successes', () => {
    const err = Object.assign(new Error('secret-bearing message'), { code: 'ETIMEDOUT' });
    recordWorkerFailure('notifications', err, 2_000);

    const entry = workerLivenessSnapshot(3_000).notifications;
    assert.equal(entry.failures, 1);
    assert.equal(entry.successes, 0);
    assert.equal(entry.lastFailureCode, 'etimedout');
    assert.equal(entry.lastFailureAt, new Date(2_000).toISOString());
    // A failure is not a success: a scheduler that never succeeds must not look alive.
    assert.equal(entry.lastSuccessAt, null);
    assert.equal(entry.successAgeMs, null);
  });

  test('inFlight never goes negative when outcomes arrive without a start', () => {
    recordWorkerSuccess('scanner');
    assert.equal(workerLivenessSnapshot().scanner.inFlight, 0);
    recordWorkerFailure('scanner', new Error('x'));
    assert.equal(workerLivenessSnapshot().scanner.inFlight, 0);
  });
});

describe('notification heartbeat drain', () => {
  test('requests a bounded batch even when asked for a large one', async () => {
    const seen: Array<number | undefined> = [];
    const outcome = await drainNotificationOutbox({
      batchSize: 500,
      worker: {
        async runOnce(batchSize?: number) {
          seen.push(batchSize);
          return ZERO;
        },
      },
    });

    assert.equal(outcome.ok, true);
    assert.deepEqual(seen, [HEARTBEAT_MAX_BATCH]);
    assert.equal(workerLivenessSnapshot().notifications.successes, 1);
  });

  test('returns ok:false and records the code on failure — it never throws', async () => {
    const outcome = await drainNotificationOutbox({
      worker: {
        async runOnce() {
          throw Object.assign(new Error('SMTP credentials rejected: hunter2'), { code: 'EAUTH' });
        },
      },
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error('unreachable');
    assert.equal(outcome.code, 'eauth');
    assert.equal(outcome.timedOut, false);

    const entry = workerLivenessSnapshot().notifications;
    assert.equal(entry.failures, 1);
    assert.equal(entry.lastFailureCode, 'eauth');
    assert.equal(entry.lastSuccessAt, null);
  });

  test('stops waiting after the timeout and reports it as a visible failure', async () => {
    let settledInBackground = false;
    const outcome = await drainNotificationOutbox({
      timeoutMs: 20,
      worker: {
        runOnce() {
          // A provider that hangs: the heartbeat must not wait for it.
          return new Promise<NotificationBatchSummary>((resolve) => {
            setTimeout(() => {
              settledInBackground = true;
              resolve(ZERO);
            }, 1_000);
          });
        },
      },
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error('unreachable');
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.code, 'notificationheartbeattimeout');

    const entry = workerLivenessSnapshot().notifications;
    assert.equal(entry.failures, 1);
    // The abandoned batch is still in flight in the background; it must not be
    // mistaken for a second, concurrent heartbeat.
    assert.equal(entry.inFlight, 0);
    assert.equal(settledInBackground, false);
  });

  test('a batch that rejects AFTER the timeout is swallowed (no unhandled rejection)', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const outcome = await drainNotificationOutbox({
        timeoutMs: 20,
        worker: {
          runOnce() {
            return new Promise<NotificationBatchSummary>((_resolve, reject) => {
              setTimeout(() => reject(Object.assign(new Error('late failure'), { code: 'ECONNRESET' })), 40);
            });
          },
        },
      });
      assert.equal(outcome.ok, false);

      // Let the late rejection fire.
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      await tick();
      assert.deepEqual(rejections, [], 'the abandoned batch must not surface an unhandled rejection');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a successful drain reports the counts for operator logs', async () => {
    const lines: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const outcome = await drainNotificationOutbox({
      worker: {
        async runOnce() {
          return { ...ZERO, claimed: 3, delivered: 2, failed: 1 };
        },
      },
      logger: {
        info: (message, meta) => lines.push({ message, meta }),
        warn: (message, meta) => lines.push({ message, meta }),
      },
    });

    assert.equal(outcome.ok, true);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.message, 'notification heartbeat batch');
    assert.equal(lines[0]?.meta?.claimed, 3);
    assert.equal(lines[0]?.meta?.delivered, 2);
  });
});
