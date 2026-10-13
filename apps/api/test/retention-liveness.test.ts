import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { RetentionSweepObservation } from '@veltrixeye/core';
import {
  recordRetentionSweep,
  resetRetentionLivenessForTests,
  retentionLivenessSnapshot,
} from '../src/retention-liveness.js';

/**
 * These tests are deliberately DB-free: the module is pure process state, so
 * the suite runs in milliseconds and pins the two properties that matter for
 * production —
 *
 *   1. a sweep that deletes NOTHING is still provable from the unauthenticated
 *      `GET /api/health` (the whole point: a young ledger is guaranteed to
 *      delete nothing, so "no log line" used to be meaningless), and
 *   2. the block served unauthenticated can never carry an error message, a row
 *      id, SQL text or a credential.
 */

const ZERO_DELETE_SWEEP: RetentionSweepObservation = {
  outcome: 'completed',
  deleted: 0,
  retentionDays: 90,
  batches: 1,
  batchCeilingReached: false,
  durationMs: 4,
  sweptAtMs: 1_000_000,
};

beforeEach(() => {
  resetRetentionLivenessForTests();
});

describe('retention liveness — a fresh process tells the truth', () => {
  test('reports no sweep yet instead of a fake green', () => {
    const entry = retentionLivenessSnapshot().scannerRuns;
    assert.equal(entry.lastSweepAt, null);
    assert.equal(entry.sweepAgeMs, null);
    assert.equal(entry.lastSweepDeleted, null);
    assert.equal(entry.lastSweepRetentionDays, null);
    assert.equal(entry.lastSweepDurationMs, null);
    assert.equal(entry.lastSweepBatchCeilingReached, null);
    assert.equal(entry.sweeps, 0);
    assert.equal(entry.totalDeleted, 0);
    assert.equal(entry.failures, 0);
    assert.equal(entry.lastFailureAt, null);
    assert.equal(entry.lastFailureCode, null);
  });
});

describe('retention liveness — a zero-delete sweep is provable', () => {
  test('a sweep that deletes nothing still moves the timestamp and the counter', () => {
    recordRetentionSweep(ZERO_DELETE_SWEEP);

    const entry = retentionLivenessSnapshot(1_030_000).scannerRuns;
    assert.equal(entry.sweeps, 1, 'the attempt is counted even though nothing was eligible');
    assert.equal(entry.lastSweepAt, new Date(1_000_000).toISOString());
    assert.equal(entry.sweepAgeMs, 30_000, 'age is measured from the sweep clock');
    assert.equal(entry.lastSweepDeleted, 0);
    assert.equal(entry.lastSweepRetentionDays, 90, 'the applied window is observable');
    assert.equal(entry.lastSweepDurationMs, 4);
    assert.equal(entry.lastSweepBatchCeilingReached, false);
    assert.equal(entry.totalDeleted, 0);
    assert.equal(entry.failures, 0);
  });

  test('repeat sweeps accumulate: counters move, the latest window wins', () => {
    recordRetentionSweep(ZERO_DELETE_SWEEP);
    recordRetentionSweep({ ...ZERO_DELETE_SWEEP, deleted: 7, retentionDays: 30, sweptAtMs: 2_000_000 });

    const entry = retentionLivenessSnapshot(2_000_000).scannerRuns;
    assert.equal(entry.sweeps, 2);
    assert.equal(entry.totalDeleted, 7, 'deletions accumulate across sweeps');
    assert.equal(entry.lastSweepDeleted, 7);
    assert.equal(entry.lastSweepRetentionDays, 30);
    assert.equal(entry.sweepAgeMs, 0);
  });

  test('a backlog that hits the batch ceiling is visible', () => {
    recordRetentionSweep({ ...ZERO_DELETE_SWEEP, deleted: 10_000, batches: 20, batchCeilingReached: true });
    const entry = retentionLivenessSnapshot(1_000_000).scannerRuns;
    assert.equal(entry.lastSweepBatchCeilingReached, true);
    assert.equal(entry.lastSweepDeleted, 10_000);
  });
});

describe('retention liveness — failures are visible but never leak', () => {
  test('a failed sweep records a bounded machine code and preserves the last success', () => {
    recordRetentionSweep(ZERO_DELETE_SWEEP);
    const failure = Object.assign(new Error('relation "scanner_runs" does not exist'), { code: '42P01' });
    recordRetentionSweep(
      { outcome: 'failed', retentionDays: 90, durationMs: 2, sweptAtMs: 1_100_000, error: failure },
      1_100_000,
    );

    const entry = retentionLivenessSnapshot(1_100_000).scannerRuns;
    assert.equal(entry.failures, 1);
    assert.equal(entry.lastFailureCode, '42p01');
    assert.equal(entry.lastFailureAt, new Date(1_100_000).toISOString());
    assert.equal(entry.sweeps, 1, 'a failure is not counted as a completed sweep');
    assert.equal(entry.lastSweepAt, new Date(1_000_000).toISOString(), 'the last real success is preserved');
  });

  test('NEVER carries the error message, SQL text, row ids or a connection string', () => {
    const leaky = Object.assign(
      new Error('delete from scanner_runs failed for postgres://user:hunter2@db.host/veltrixeye at 8a1b2c3d'),
      { code: 'ECONNREFUSED' },
    );
    recordRetentionSweep({ outcome: 'failed', retentionDays: 90, durationMs: 1, sweptAtMs: 5, error: leaky });

    const serialized = JSON.stringify(retentionLivenessSnapshot(5));
    for (const forbidden of ['hunter2', 'postgres://', 'delete from', 'scanner_runs', 'db.host', '8a1b2c3d']) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, `must not expose "${forbidden}"`);
    }
    // The only failure detail is the bounded machine code.
    assert.equal(retentionLivenessSnapshot(5).scannerRuns.lastFailureCode, 'econnrefused');
  });

  test('an unrecognizable thrown value falls back to a constant code, never a message', () => {
    recordRetentionSweep({
      outcome: 'failed',
      retentionDays: 90,
      durationMs: 1,
      sweptAtMs: 9,
      error: { message: 'password=hunter2' },
    });
    const entry = retentionLivenessSnapshot(9).scannerRuns;
    assert.equal(entry.lastFailureCode, 'unknown');
    assert.equal(JSON.stringify(entry).includes('hunter2'), false);
  });

  test('the snapshot is a copy: mutating it cannot corrupt the registry', () => {
    recordRetentionSweep(ZERO_DELETE_SWEEP);
    const entry = retentionLivenessSnapshot(1_000_000).scannerRuns;
    entry.sweeps = 999;
    assert.equal(retentionLivenessSnapshot(1_000_000).scannerRuns.sweeps, 1);
  });
});
