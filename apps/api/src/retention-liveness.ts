/**
 * Process-local liveness for the scanner-run retention sweep (M7 audit F15).
 *
 * WHY THIS EXISTS. The sweep (`ScannerService.pruneTerminalRuns`, reached
 * through `runMaintenance`) used to leave exactly one trace: an info log
 * emitted ONLY when it deleted at least one row. That makes the two questions
 * an operator actually has unanswerable from outside the process —
 *
 *   1. "has the maintenance sweep run at all?" — `deleted > 0` was the only
 *      signal, and a young ledger (as in production today, where the oldest
 *      `scanner_runs` row is far inside the window) is GUARANTEED to delete
 *      nothing, so the absence of a log line proved nothing; and
 *   2. "which window did it apply, and is it keeping up?" — neither was
 *      observable without a worker token, dashboard access or SQL.
 *
 * This registry records every sweep ATTEMPT, including a zero-delete one and a
 * failed one, so the unauthenticated `GET /api/health` can answer both without
 * a credential, a log search or a production database session. Like
 * `worker-liveness.ts` it is deliberately trigger-free: reading the snapshot
 * never runs (or re-runs) a sweep, so an observer can never mutate production
 * data by looking.
 *
 * WHAT IT CARRIES: counts, timestamps, the applied retention window, a boolean
 * and a failure machine code.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: no row ids, no tenant/strategy/trigger
 * identifiers, no SQL text, no table contents, no connection string and no
 * error message — `failureCode()` reduces a thrown value to a short bounded
 * code derived only from `code`/`name`, exactly as the worker registry does.
 *
 * THE ONE CONFIGURATION VALUE, ON PURPOSE. The worker registry carries no
 * configuration value at all; this block makes a single, deliberate exception
 * for `retentionDays`. It is the effective window the sweep applied — a
 * bounded integer (1–3650) that is not a secret and that is otherwise
 * unverifiable from outside the platform, because the blueprint does not have
 * to set it and the app exposes no config route. It is exactly the fact an
 * auditor needs to confirm the documented policy is what is running.
 *
 * SCOPE. Process-local and intentionally not persisted, for the same reason as
 * the worker registry: it answers "has THIS process swept?", which is the
 * question that matters after a deploy or a sleep/wake. A restart resets the
 * counters and timestamps; the next sweep repopulates them. Historical
 * deletions are NOT erased by a restart — `pruneTerminalRuns` writes nothing to
 * the ledger when it prunes, so the only durable record of past sweeps is the
 * absence of expired rows, which is verified from the database, not here.
 */
import type { RetentionSweepObservation } from '@veltrixeye/core';
import { failureCode } from './worker-liveness.js';

interface ScannerRunRetentionRecord {
  sweeps: number;
  totalDeleted: number;
  lastSweepAtMs: number | null;
  lastDeleted: number | null;
  lastRetentionDays: number | null;
  lastDurationMs: number | null;
  lastBatchCeilingReached: boolean | null;
  failures: number;
  lastFailureAtMs: number | null;
  lastFailureCode: string | null;
}

/** Serializable view of the retention sweep state (safe to serve unauthenticated). */
export interface RetentionLivenessEntry {
  /** Completion time of the last sweep that finished, or null. */
  lastSweepAt: string | null;
  /** Milliseconds since the last completed sweep; null when this process has none. */
  sweepAgeMs: number | null;
  /** Rows deleted by the last completed sweep; 0 means nothing was eligible. */
  lastSweepDeleted: number | null;
  /** Effective retention window the last completed sweep applied, in days. */
  lastSweepRetentionDays: number | null;
  /** Duration of the last completed sweep, in milliseconds. */
  lastSweepDurationMs: number | null;
  /**
   * True when the last completed sweep stopped at its batch ceiling, meaning
   * eligible rows may remain for the next sweep. False means the ledger was
   * fully drained for the applied window.
   */
  lastSweepBatchCeilingReached: boolean | null;
  /** Completed sweeps observed by this process (a zero-delete sweep counts). */
  sweeps: number;
  /** Rows deleted by this process across all sweeps. */
  totalDeleted: number;
  /** Failed sweep attempts observed by this process. */
  failures: number;
  /** Time of the last failed attempt, or null. */
  lastFailureAt: string | null;
  /** Short machine code for the last failure. Never a message. */
  lastFailureCode: string | null;
}

export interface RetentionLivenessSnapshot {
  /** `scanner_runs` terminal-row retention (F15). */
  scannerRuns: RetentionLivenessEntry;
}

function emptyRecord(): ScannerRunRetentionRecord {
  return {
    sweeps: 0,
    totalDeleted: 0,
    lastSweepAtMs: null,
    lastDeleted: null,
    lastRetentionDays: null,
    lastDurationMs: null,
    lastBatchCeilingReached: null,
    failures: 0,
    lastFailureAtMs: null,
    lastFailureCode: null,
  };
}

/**
 * Module-level state. One API process per instance, and these counters describe
 * that process; persisting them would make "has the sweep run?" indistinguish-
 * able from "did it run before the last restart?".
 */
const record: ScannerRunRetentionRecord = emptyRecord();

/**
 * Record one sweep attempt. Called for EVERY outcome, which is the property
 * that makes a zero-delete sweep provable: `sweeps` increments and
 * `lastSweepAt` moves even when `deleted` is 0.
 *
 * A failed attempt records the failure ONLY — it never overwrites the
 * last-completed fields, so an operator always sees the last time the sweep
 * genuinely succeeded alongside the count of failures since.
 */
export function recordRetentionSweep(
  observation: RetentionSweepObservation,
  nowMs: number = Date.now(),
): void {
  if (observation.outcome === 'completed') {
    record.sweeps += 1;
    record.totalDeleted += observation.deleted;
    record.lastSweepAtMs = observation.sweptAtMs;
    record.lastDeleted = observation.deleted;
    record.lastRetentionDays = observation.retentionDays;
    record.lastDurationMs = observation.durationMs;
    record.lastBatchCeilingReached = observation.batchCeilingReached;
    return;
  }
  record.failures += 1;
  record.lastFailureAtMs = nowMs;
  record.lastFailureCode = failureCode(observation.error);
}

function toEntry(current: ScannerRunRetentionRecord, nowMs: number): RetentionLivenessEntry {
  return {
    lastSweepAt: current.lastSweepAtMs === null ? null : new Date(current.lastSweepAtMs).toISOString(),
    sweepAgeMs: current.lastSweepAtMs === null ? null : Math.max(0, nowMs - current.lastSweepAtMs),
    lastSweepDeleted: current.lastDeleted,
    lastSweepRetentionDays: current.lastRetentionDays,
    lastSweepDurationMs: current.lastDurationMs,
    lastSweepBatchCeilingReached: current.lastBatchCeilingReached,
    sweeps: current.sweeps,
    totalDeleted: current.totalDeleted,
    failures: current.failures,
    lastFailureAt: current.lastFailureAtMs === null ? null : new Date(current.lastFailureAtMs).toISOString(),
    lastFailureCode: current.lastFailureCode,
  };
}

/** Read-only snapshot for the health endpoint. Never triggers a sweep. */
export function retentionLivenessSnapshot(nowMs: number = Date.now()): RetentionLivenessSnapshot {
  return { scannerRuns: toEntry(record, nowMs) };
}

/** Test-only: clear the counters so a suite starts from a known state. */
export function resetRetentionLivenessForTests(): void {
  Object.assign(record, emptyRecord());
}
