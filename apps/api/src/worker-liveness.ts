/**
 * Process-local liveness for the two workers the platform runs on a schedule:
 * the live scanner (M7.5 / F3) and the notification-outbox delivery worker
 * (M7.3).
 *
 * WHY THIS EXISTS. The production API is a container a platform may stop at any
 * time (Render's free tier spins down after ~15 minutes idle). Both workers
 * therefore have two invocation paths — an in-process ticker while the instance
 * is awake, and a token-protected internal endpoint an external scheduler can
 * call after a spin-down. Until now the ONLY way to tell whether either path had
 * actually executed was to hold `SCANNER_WORKER_TOKEN` /
 * `NOTIFICATION_WORKER_TOKEN` and read the API log: a green cron run and a
 * running instance are both consistent with a scheduler that is reaching the
 * service but being refused (401), or one that is calling the wrong endpoint.
 * That is an observability gap, not a correctness one — and it is the gap that
 * makes "the scheduler is working" unverifiable from outside.
 *
 * This registry records the last success, the last failure and the counters for
 * each worker so `GET /api/health` can report them WITHOUT a credential.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: no tenant or strategy identifiers, no
 * alert or job identifiers, no recipient addresses, no provider response text,
 * no queue contents, no error message and no configuration value. The failure
 * field is a short machine code derived ONLY from an error's `code`/`name`
 * (e.g. a Postgres SQLSTATE or a Node `ETIMEDOUT`), never from `message`, whose
 * text can echo row values or a connection string.
 *
 * SCOPE. Process-local and intentionally not persisted: it answers "has THIS
 * process run the work?", which is exactly the question that matters after a
 * sleep/wake or a deploy. A restart resets the counters to zero and the
 * timestamps to null, and the next tick repopulates them.
 *
 * WHERE EACH WORKER IS RECORDED — the asymmetry is deliberate and is what makes
 * the snapshot diagnostic:
 *
 *  - `notifications` is recorded on BOTH delivery paths (the in-process ticker
 *    and the token-protected internal endpoint). A moving `lastSuccessAt`
 *    therefore answers "is delivery running at all?".
 *  - `scanner` is recorded ONLY on the external heartbeat endpoint
 *    (`POST /api/internal/scanner/run`), never by the in-process ticker. A
 *    moving `lastSuccessAt` therefore answers the different, harder question:
 *    "is an external scheduler reaching this API AND authenticating
 *    successfully?". A scheduler that is refused (401) or pointed at the wrong
 *    route leaves `successes` at 0 while the ticker keeps the instance
 *    otherwise healthy — which is exactly the failure that a green cron run
 *    cannot distinguish from success.
 */

export type BackgroundWorker = 'scanner' | 'notifications';

interface WorkerLivenessRecord {
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  lastFailureCode: string | null;
  successes: number;
  failures: number;
  inFlight: number;
}

/** Serializable view of one worker's liveness (safe to serve unauthenticated). */
export interface WorkerLivenessEntry {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Short machine code (SQLSTATE / Node error code / error name). Never a message. */
  lastFailureCode: string | null;
  successes: number;
  failures: number;
  /** 1 while an invocation is in flight, 0 otherwise. */
  inFlight: number;
  /** Milliseconds since the last success; null when this process has none yet. */
  successAgeMs: number | null;
}

export interface WorkerLivenessSnapshot {
  scanner: WorkerLivenessEntry;
  notifications: WorkerLivenessEntry;
}

function emptyRecord(): WorkerLivenessRecord {
  return {
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    lastFailureCode: null,
    successes: 0,
    failures: 0,
    inFlight: 0,
  };
}

/**
 * Module-level state. The API runs one process per instance and these counters
 * describe that process, so a plain object is the correct scope — persisting
 * them would make "has this worker run?" indistinguishable from "did it run
 * before the last restart?", which is the opposite of what an operator needs to
 * know after a spin-down.
 */
const records: Record<BackgroundWorker, WorkerLivenessRecord> = {
  scanner: emptyRecord(),
  notifications: emptyRecord(),
};

/** Mark an invocation as started (visible as `inFlight: 1`). */
export function recordWorkerStart(worker: BackgroundWorker): void {
  records[worker].inFlight += 1;
}

/** Mark an invocation as finished successfully. */
export function recordWorkerSuccess(worker: BackgroundWorker, nowMs: number = Date.now()): void {
  const record = records[worker];
  record.inFlight = Math.max(0, record.inFlight - 1);
  record.successes += 1;
  record.lastSuccessAtMs = nowMs;
}

/**
 * Mark an invocation as failed. `err` is reduced to a bounded machine code —
 * never a message or a stack — because this value is served unauthenticated.
 */
export function recordWorkerFailure(
  worker: BackgroundWorker,
  err: unknown,
  nowMs: number = Date.now(),
): void {
  const record = records[worker];
  record.inFlight = Math.max(0, record.inFlight - 1);
  record.failures += 1;
  record.lastFailureAtMs = nowMs;
  record.lastFailureCode = failureCode(err);
}

/**
 * Reduce an unknown error to a short, message-free machine code. Only `code`
 * (Postgres SQLSTATE, Node `ETIMEDOUT`/`ECONNREFUSED`, …) and `name` are read,
 * and both are bounded and character-filtered, so nothing derived from
 * `message` can reach the response.
 */
export function failureCode(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(code)) return code.toLowerCase();
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z]{1,32}$/.test(name)) return name.toLowerCase();
  }
  if (typeof err === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(err)) return err.toLowerCase();
  return 'unknown';
}

function toEntry(record: WorkerLivenessRecord, nowMs: number): WorkerLivenessEntry {
  return {
    lastSuccessAt: record.lastSuccessAtMs === null ? null : new Date(record.lastSuccessAtMs).toISOString(),
    lastFailureAt: record.lastFailureAtMs === null ? null : new Date(record.lastFailureAtMs).toISOString(),
    lastFailureCode: record.lastFailureCode,
    successes: record.successes,
    failures: record.failures,
    inFlight: record.inFlight,
    successAgeMs: record.lastSuccessAtMs === null ? null : Math.max(0, nowMs - record.lastSuccessAtMs),
  };
}

/** Read-only snapshot for the health endpoint. */
export function workerLivenessSnapshot(nowMs: number = Date.now()): WorkerLivenessSnapshot {
  return {
    scanner: toEntry(records.scanner, nowMs),
    notifications: toEntry(records.notifications, nowMs),
  };
}

/** Test-only: clear all counters so a suite starts from a known state. */
export function resetWorkerLivenessForTests(): void {
  records.scanner = emptyRecord();
  records.notifications = emptyRecord();
}
