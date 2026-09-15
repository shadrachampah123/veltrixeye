import { createHash } from 'node:crypto';
import type { AlertChannel, AlertDeliveryStatus } from '@veltrixeye/contracts';

/**
 * AlertSender — the single delivery boundary for M6 alerts (Phase 3).
 *
 * M6 ships exactly ONE implementation: {@link StubAlertSender}. It renders a
 * deterministic payload hash and reports `delivered` WITHOUT performing any
 * external I/O — no email, no webhook, no push, no vendor SDK, no network
 * call, no new credentials. The only durable record of a delivery is the
 * append-only `alert_deliveries` ledger row written by `AlertService` inside
 * the same transaction as the alert.
 *
 * Why an interface at all, if the stub does nothing?
 *  - It pins the *shape* of real delivery now: `send()` receives the persisted
 *    alert content (never raw candles), returns a status/attempt/payload hash,
 *    and is the only place a channel is chosen. A later milestone adds a real
 *    sender behind the same contract and the ledger schema already carries the
 *    `email` / `webhook` / `push` channel values — no migration needed.
 *  - It keeps the "no external delivery in M6" rule enforceable: the M6
 *    `AlertService` REFUSES any sender whose channel is not `stub`
 *    ({@link NonStubSenderError}), so an accidental real-sender wiring fails
 *    loudly at construction time instead of quietly sending email.
 *
 * Determinism: the payload hash is the same value every time for the same
 * persisted alert (`alertId` + `title` + `body`), so replaying generation can
 * never mint a second ledger row (the 0012 unique index
 * `(alert_id, channel, payload_hash)` collapses it) and the hash is stable
 * across processes and machines. There is no clock, no randomness and no
 * environment read anywhere in this module.
 */

/** sha256 hex — the format of `alert_deliveries.payload_hash` (0012 CHECK). */
export const ALERT_PAYLOAD_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * One delivery attempt request. `title` / `body` are the PERSISTED alert
 * values (read back from `alerts`), so the rendered payload is a pure function
 * of stored state — a replay after any upstream change still hashes to the
 * original value and collapses onto the original ledger row.
 */
export interface AlertSendRequest {
  alertId: string;
  userId: string;
  setupId: string;
  triggerState: string;
  /** Exact string stored in `alerts.title`. */
  title: string;
  /** Exact object stored in `alerts.body` (structured; never raw candles). */
  body: Record<string, unknown>;
}

/** Outcome of one attempt — persisted verbatim into `alert_deliveries`. */
export interface AlertSendResult {
  status: AlertDeliveryStatus;
  /** 1 for the first (and, in M6, only) attempt of an alert/channel pair. */
  attempt: number;
  payloadHash: string;
  error?: string | null;
  /**
   * The exact canonical JSON that was hashed. Never persisted and never
   * returned over HTTP — it exists so tests can prove the hash is not
   * accidentally over a differently-serialized payload.
   */
  canonicalJson?: string;
}

export interface AlertSender {
  /** The `alert_deliveries.channel` this sender writes. M6: `stub` only. */
  readonly channel: AlertChannel;
  send(request: AlertSendRequest): Promise<AlertSendResult>;
}

/** Thrown when M6 is asked to use a channel that would deliver externally. */
export class NonStubSenderError extends Error {
  constructor(channel: string) {
    super(
      `M6 only supports the local 'stub' alert sender (received '${channel}'). ` +
        'Real email/webhook/push delivery is a later milestone: it needs an ' +
        'outbox/worker, provider credentials and its own security review.',
    );
    this.name = 'NonStubSenderError';
  }
}

/**
 * Recursive canonicalization: sort object keys, preserve array order, keep
 * primitives (Dates become ISO strings). Mirrors the pinned M6.1
 * `canonical.ts` rule so payload hashes are stable everywhere.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

/**
 * Pinned M6 stub payload hash: `sha256(utf8(JSON.stringify(canonicalize({
 * alertId, title, body }))))`. Deliberately excludes clock/IP/user-agent so
 * the same stored alert always hashes identically.
 */
export function alertPayloadHash(args: {
  alertId: string;
  title: string;
  body: Record<string, unknown>;
}): { payloadHash: string; canonicalJson: string } {
  const canonicalJson = JSON.stringify(
    canonicalize({ alertId: args.alertId, title: args.title, body: args.body }),
  );
  const payloadHash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  if (!ALERT_PAYLOAD_HASH_RE.test(payloadHash)) {
    // Defensive: sha256 hex must always match; validated before persistence.
    throw new Error(`computed alert payload hash has invalid format: ${payloadHash}`);
  }
  return { payloadHash, canonicalJson };
}

/**
 * The M6 sender: fully local, deterministic, side-effect-free.
 *
 * "Sending" means computing the payload hash. Nothing is transmitted, nothing
 * is queued, no socket is opened; the returned result is written to the
 * `alert_deliveries` ledger by the caller. `attempt` is always 1 in M6 because
 * dedup by `(alert_id, channel, payload_hash)` means one row per logical
 * delivery.
 */
export class StubAlertSender implements AlertSender {
  readonly channel = 'stub' as const;

  async send(request: AlertSendRequest): Promise<AlertSendResult> {
    const { payloadHash, canonicalJson } = alertPayloadHash({
      alertId: request.alertId,
      title: request.title,
      body: request.body,
    });
    return { status: 'delivered', attempt: 1, payloadHash, canonicalJson, error: null };
  }
}
