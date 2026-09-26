import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  BILLING_CREDENTIAL_SHAPED_RE,
  BILLING_PROVIDER,
  billingEventTypeSchema,
  providerEventReferenceSchema,
  providerReferenceSchema,
  sha256HexSchema,
  type BillingEventType,
  type BillingProviderId,
  type NormalizedBillingEvent,
} from '@veltrixeye/contracts';
import { billingCheckoutReference } from './checkout.js';
import {
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  type BillingProviderRawEvent,
  type BillingProviderRegistry,
} from './provider.js';

/**
 * Billing Step 5.2 — the SECURE WEBHOOK RECEIVER core.
 *
 * This module is the receiving half of the Step 5.1 event contract: it takes
 * ONE delivery — raw bytes, a signature header and a receipt instant — and
 * turns it into ONE durable `billing_provider_events` row (migration 0031),
 * or refuses it. It lives OUTSIDE `packages/providers/paystack` on purpose:
 * Step 5.1 pins that package free of any receiver, signature handling, raw
 * body, route or persistence (a test there asserts it), and this module must
 * never import the adapter — it reaches the provider exclusively through the
 * canonical `BillingProvider` seam.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES
 * ---------------------------------------------------------------------------
 *  - VERIFIES the delivery signature before anything else reads the body:
 *    `x-paystack-signature` is documented by the provider as the hex-encoded
 *    HMAC-SHA512 of the RAW request body keyed by the secret key, so the
 *    comparison runs over the exact received bytes, uses a constant-time
 *    compare, and never reports why it failed. A missing, malformed or wrong
 *    signature is one identical refusal.
 *  - RECORDS every signed delivery it can parse through the seam — a new
 *    idempotency key INSERTs one ledger row; a replayed or duplicated
 *    delivery collapses onto the existing row via migration 0031's UNIQUE
 *    `idempotency_key` (the provider documents retries: 3-minute intervals
 *    then hourly in live mode, hourly in test mode — replays are expected,
 *    never an error).
 *  - RECORDS signed deliveries it must refuse the same way: a body that is
 *    not parseable JSON, or a supported event whose payload the seam refuses
 *    (missing field, wrong type, self-contradiction, non-sandbox domain),
 *    becomes an `unrecognized` row carrying a safe `failure_reason` — the
 *    receiver asserts nothing about it and the provider's own retry schedule
 *    surfaces the refusal on the provider side.
 *  - RESOLVES the local subject BEFORE anything is persisted, against the
 *    local directories only: a provider subscription id onto `subscriptions`,
 *    a provider customer id/code onto `billing_customers`, and our own
 *    checkout reference (`ve-chk-…`) onto the subscription that locked the
 *    pricing snapshot the reference was derived from. Any disagreement
 *    between resolution paths binds NOTHING — the row is recorded with a
 *    fully-null subject instead of a guessed owner.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *  - It is NOT a payment confirmation. A recorded `payment.succeeded` row is
 *    a provider-reported receipt of one delivery: no transaction verification
 *    is performed, no subscription status moves, no entitlement changes and
 *    `paymentConfirmed` stays `false` — it is derived from the durable
 *    ACTIVATION FACT (Billing Step 8, migration 0034), and a webhook delivery
 *    is never one.
 *  - It never enables execution. `grantsExecution` is pinned `false` by the
 *    canonical contract, and nothing here touches a plan value, an
 *    entitlement or an execution gate.
 *  - It never persists a payload. Only canonical identity fields and a
 *    SHA-256 payload hash are stored (migration 0031's redaction posture);
 *    failure reasons are sanitized to one line, bounded to 600 characters
 *    and replaced whole when they are credential-shaped.
 *  - It never invents provider behaviour. There is no documented signature
 *    timestamp, so there is no freshness window here; replay safety is the
 *    ledger's idempotency, exactly as the provider contract records it.
 *  - It performs no transport and reads no environment: the secret key, the
 *    registry and the database are injected; rate limiting, the IP
 *    allow-list and raw-body capture belong to the route (apps/api).
 */

/**
 * The header the provider documents for webhook signatures. Named here (not
 * in the adapter package) because Step 5.1 pins that package free of any
 * receiver vocabulary; the billing seam has exactly one provider.
 */
export const BILLING_WEBHOOK_SIGNATURE_HEADER = 'x-paystack-signature';

/** sha256 digests render as 128 lowercase hex characters. */
const HMAC_SHA512_HEX_LENGTH = 128;

/**
 * Verify one delivery signature over the RAW body bytes.
 *
 * Pure and total: returns `false` for a missing header, a wrong length, a
 * non-hex value, an empty secret or any mismatch — one identical refusal in
 * every case. The comparison is constant-time (`timingSafeEqual`) over
 * equal-length byte buffers; an unequal length fails without comparing. The
 * HMAC is computed over the exact received bytes, so the caller MUST pass the
 * raw body, never a re-serialized or parsed form.
 */
export function verifyBillingWebhookSignature(
  rawBody: Buffer | Uint8Array,
  signatureHeader: string | null | undefined,
  secretKey: string,
): boolean {
  if (secretKey === '') return false;
  if (typeof signatureHeader !== 'string' || signatureHeader.length !== HMAC_SHA512_HEX_LENGTH) {
    return false;
  }
  if (!/^[0-9a-f]+$/i.test(signatureHeader)) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const expected = createHmac('sha512', secretKey).update(body).digest();
  const supplied = Buffer.from(signatureHeader.toLowerCase(), 'hex');
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(expected, supplied);
}

/* -------------------------------------------------------------------------- */
/* The ledger store (migration 0031 `billing_provider_events`)                */
/* -------------------------------------------------------------------------- */

/** One durable provider-event row, exactly as migration 0031 accepts it. */
export interface BillingProviderEventInsert {
  provider: BillingProviderId;
  /** Canonical event type — provider names never reach the database. */
  eventType: BillingEventType;
  /** The provider's own event id; Paystack publishes none, so normally null. */
  providerEventId: string | null;
  /** sha256(provider | providerEventId | eventType | occurredAt | payloadHash). */
  idempotencyKey: string;
  /** sha256 of the received payload. The payload itself is never stored. */
  payloadHash: string;
  /** Resolved local subject: both set or both null (0031 CHECK). */
  subscriptionId: string | null;
  userId: string | null;
  /** Provider references carried by the event (traceability / resolution). */
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  providerReference: string | null;
  /** Why a delivery was refused, when it was. Sanitized, ≤ 600 characters. */
  failureReason: string | null;
  occurredAt: string | null;
  receivedAt: string;
}

const isoDateTime = z.string().datetime();

const billingProviderEventInsertSchema = z
  .object({
    provider: z.literal(BILLING_PROVIDER),
    eventType: billingEventTypeSchema,
    providerEventId: providerEventReferenceSchema.nullable(),
    idempotencyKey: sha256HexSchema,
    payloadHash: sha256HexSchema,
    subscriptionId: z.string().uuid().nullable(),
    userId: z.string().uuid().nullable(),
    providerCustomerId: providerReferenceSchema.nullable(),
    providerSubscriptionId: providerReferenceSchema.nullable(),
    providerReference: providerEventReferenceSchema.nullable(),
    failureReason: z.string().min(1).max(600).nullable(),
    occurredAt: isoDateTime.nullable(),
    receivedAt: isoDateTime,
  })
  .strict()
  .superRefine((row, ctx) => {
    if ((row.subscriptionId === null) !== (row.userId === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subscriptionId and userId must both be set or both be null',
      });
    }
  });

/** The fixed phrase stored when a refusal reason is credential-shaped. */
export const BILLING_WEBHOOK_WITHHELD_REASON = 'delivery failure detail withheld';

/**
 * Make an error message safe for the durable `failure_reason` column: one
 * line, bounded to the 0031 limit, and replaced WHOLE when it is
 * credential-shaped (the column's CHECK rejects such text; the receiver must
 * never fail a write because of a refusal message).
 */
export function sanitizeBillingWebhookFailureReason(message: unknown): string {
  const text = (typeof message === 'string' ? message : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  if (text === '') return BILLING_WEBHOOK_WITHHELD_REASON;
  // The SAME credential shape migration 0031's CHECK enforces (contracts
  // authority): such text is replaced whole, never stored, never reworded.
  if (BILLING_CREDENTIAL_SHAPED_RE.test(text)) {
    return BILLING_WEBHOOK_WITHHELD_REASON;
  }
  return text;
}

export type BillingProviderEventRecordOutcome = 'recorded' | 'replayed';

/**
 * Append-only writer for `billing_provider_events`. Replay-safe by
 * construction: the INSERT conflicts on the UNIQUE `idempotency_key` and does
 * nothing, so two deliveries of the same event collapse onto one row and the
 * second call reports `replayed` instead of inserting. Nothing here ever
 * updates or deletes a row — processing state transitions belong to
 * synchronization (`claimReceivedBillingProviderEvents` /
 * `settleBillingProviderEvents` below, called only by `./sync.ts`).
 */
export class BillingProviderEventStore {
  constructor(private readonly db: Pool) {}

  async record(input: BillingProviderEventInsert): Promise<{
    id: string | null;
    outcome: BillingProviderEventRecordOutcome;
    idempotencyKey: string;
  }> {
    const row = billingProviderEventInsertSchema.parse(input);
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO billing_provider_events (
         provider, event_type, provider_event_id, idempotency_key, payload_hash,
         subscription_id, user_id, provider_customer_id, provider_subscription_id,
         provider_reference, status, failure_reason, occurred_at, received_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'received', $11, $12, $13)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        row.provider,
        row.eventType,
        row.providerEventId,
        row.idempotencyKey,
        row.payloadHash,
        row.subscriptionId,
        row.userId,
        row.providerCustomerId,
        row.providerSubscriptionId,
        row.providerReference,
        row.failureReason,
        row.occurredAt,
        row.receivedAt,
      ],
    );
    const inserted = result.rows[0];
    return inserted === undefined
      ? { id: null, outcome: 'replayed', idempotencyKey: row.idempotencyKey }
      : { id: inserted.id, outcome: 'recorded', idempotencyKey: row.idempotencyKey };
  }
}

/* -------------------------------------------------------------------------- */
/* Ledger processing transitions (used by synchronization, never the receiver) */
/* -------------------------------------------------------------------------- */

/**
 * Later-billing-PR #7: the ONLY processing-state transitions of the ledger.
 *
 * The receiver above never calls these — receipt stays receipt-only and every
 * row it writes is `received`. `BillingSubscriptionSyncService`
 * (`./sync.ts`) claims the `received` rows bound to one subscription inside
 * its own transaction and settles them exactly once:
 *
 *   received → processed   the row's subject was covered by an applied,
 *                          verified synchronization;
 *   received → ignored     the row asserted nothing applicable (an
 *                          `unrecognized` row, or a verified state that
 *                          cannot be applied without review);
 *   received → failed      the verified provider view conflicted with the
 *                          local identity, so nothing was applied.
 *
 * Only the processing columns move (`status`, `processed_at`, and a
 * `failure_reason` when the row has none); migration 0031's trigger keeps every
 * identity column immutable, and a settled row is never re-settled (the
 * UPDATE is guarded on `status = 'received'`). No payload is read or written:
 * the ledger never had one.
 */
export const BILLING_PROVIDER_EVENT_CLAIM_LIMIT = 64;

export interface ClaimedBillingProviderEvent {
  id: string;
  idempotencyKey: string;
  eventType: BillingEventType;
}

export type SettledBillingProviderEventState = 'processed' | 'ignored' | 'failed';

/**
 * Lock (FOR UPDATE SKIP LOCKED) up to `BILLING_PROVIDER_EVENT_CLAIM_LIMIT`
 * `received` rows bound to one (subscription, user) pair, oldest first. MUST be
 * called inside the caller's transaction; a concurrent claimer skips rows
 * already locked instead of double-processing them.
 */
export async function claimReceivedBillingProviderEvents(
  client: PoolClient,
  subject: { subscriptionId: string; userId: string },
): Promise<ClaimedBillingProviderEvent[]> {
  const subscriptionId = z.string().uuid().parse(subject.subscriptionId);
  const userId = z.string().uuid().parse(subject.userId);
  const { rows } = await client.query<{ id: string; idempotency_key: string; event_type: string }>(
    `SELECT id, idempotency_key, event_type
       FROM billing_provider_events
      WHERE subscription_id = $1 AND user_id = $2 AND status = 'received'
      ORDER BY received_at ASC, created_at ASC
      LIMIT ${BILLING_PROVIDER_EVENT_CLAIM_LIMIT}
      FOR UPDATE SKIP LOCKED`,
    [subscriptionId, userId],
  );
  return rows.map((row) => ({
    id: row.id,
    idempotencyKey: sha256HexSchema.parse(row.idempotency_key),
    eventType: billingEventTypeSchema.parse(row.event_type),
  }));
}

/**
 * Settle claimed rows: `received → processed | ignored | failed`, stamped with
 * `processedAt`. A row that already carries a failure reason (a refused
 * delivery) keeps it; otherwise the supplied reason is stored, sanitized
 * exactly like receiver refusals. Returns the number of rows moved.
 */
export async function settleBillingProviderEvents(
  client: PoolClient,
  input: {
    ids: readonly string[];
    state: SettledBillingProviderEventState;
    processedAt: string;
    failureReason: string | null;
  },
): Promise<number> {
  if (input.ids.length === 0) return 0;
  const ids = z.array(z.string().uuid()).max(BILLING_PROVIDER_EVENT_CLAIM_LIMIT).parse(input.ids);
  const state = z.enum(['processed', 'ignored', 'failed']).parse(input.state);
  const processedAt = isoDateTime.parse(input.processedAt);
  const reason = input.failureReason === null ? null : sanitizeBillingWebhookFailureReason(input.failureReason);
  const result = await client.query(
    `UPDATE billing_provider_events
        SET status = $2,
            processed_at = $3,
            failure_reason = COALESCE(failure_reason, $4)
      WHERE id = ANY($1::uuid[]) AND status = 'received'`,
    [ids, state, processedAt, reason],
  );
  return result.rowCount ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Local subject resolution (always BEFORE any insert)                        */
/* -------------------------------------------------------------------------- */

/**
 * The local subject a delivery was resolved to. All-or-nothing at the ledger
 * boundary: when the paths disagree about the owner, resolution returns
 * `null` and the event is recorded unbound (manual review), never guessed.
 */
export interface ResolvedBillingEventSubject {
  userId: string;
  subscriptionId: string | null;
  billingCustomerId: string | null;
}

export type BillingEventSubjectResolver = (subject: {
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  providerReference: string | null;
}) => Promise<ResolvedBillingEventSubject | null>;

/** Our checkout references are `ve-chk-` + the sha256 of the lock identity. */
const CHECKOUT_REFERENCE_SHAPE = /^ve-chk-[0-9a-f]{64}$/;

/**
 * Bounded scan of provider-backed subscriptions when resolving by checkout
 * reference. The reference is a hash of (user, locked pricing snapshot), so
 * it cannot be inverted — each candidate row recomputes it through the SAME
 * `billingCheckoutReference` checkout uses. This build has no production
 * writer of `subscriptions.provider_reference`, so the scan is the interim
 * authority; subscription synchronization (step 7) persists provider
 * identifiers, after which lookups become indexed point reads.
 */
const REFERENCE_RESOLUTION_SCAN_LIMIT = 4096;

/**
 * The default subject resolver: local directories only, fail-safe on any
 * disagreement. It reads `billing_customers`, `subscriptions` and (for
 * checkout references) the locked pricing snapshots — and nothing else.
 */
export function createBillingEventSubjectResolver(db: Pool): BillingEventSubjectResolver {
  return async (subject) => {
    const userIds = new Set<string>();
    let subscriptionId: string | null = null;
    let billingCustomerId: string | null = null;

    const noteUser = (userId: string): boolean => {
      if (userIds.size > 0 && !userIds.has(userId)) return false;
      userIds.add(userId);
      return true;
    };
    const noteSubscription = (id: string): boolean => {
      if (subscriptionId !== null && subscriptionId !== id) return false;
      subscriptionId = id;
      return true;
    };
    const noteCustomer = (id: string): boolean => {
      if (billingCustomerId !== null && billingCustomerId !== id) return false;
      billingCustomerId = id;
      return true;
    };

    // 1. Provider subscription id → the authoritative subscription row.
    if (subject.providerSubscriptionId !== null) {
      const { rows } = await db.query<{ id: string; user_id: string; billing_customer_id: string | null }>(
        `SELECT id, user_id, billing_customer_id
           FROM subscriptions
          WHERE provider = $1 AND provider_subscription_id = $2`,
        [BILLING_PROVIDER, subject.providerSubscriptionId],
      );
      if (rows.length > 1) return null; // a provider identifier belongs to one row
      const row = rows[0];
      if (row !== undefined) {
        if (!noteUser(row.user_id)) return null;
        if (!noteSubscription(row.id)) return null;
        if (row.billing_customer_id !== null && !noteCustomer(row.billing_customer_id)) return null;
      }
    }

    // 2. Provider customer id/code → the local provider-customer row.
    if (subject.providerCustomerId !== null) {
      const { rows } = await db.query<{ id: string; user_id: string }>(
        `SELECT id, user_id
           FROM billing_customers
          WHERE provider = $1 AND (provider_customer_id = $2 OR provider_customer_code = $2)`,
        [BILLING_PROVIDER, subject.providerCustomerId],
      );
      if (rows.length > 1) return null; // a provider customer belongs to one user
      const row = rows[0];
      if (row !== undefined) {
        if (!noteUser(row.user_id)) return null;
        if (!noteCustomer(row.id)) return null;
      }
    }

    // 3. Our own checkout reference → the subscription that locked the
    //    snapshot the reference was derived from (bounded scan; see above).
    if (subject.providerReference !== null && CHECKOUT_REFERENCE_SHAPE.test(subject.providerReference)) {
      const { rows } = await db.query<{
        subscription_id: string;
        user_id: string;
        billing_customer_id: string | null;
        pricing_idempotency_key: string;
      }>(
        `SELECT s.id AS subscription_id, s.user_id, s.billing_customer_id,
                p.idempotency_key AS pricing_idempotency_key
           FROM subscriptions s
           JOIN billing_pricing_snapshots p ON p.id = s.locked_pricing_snapshot_id
          WHERE s.provider = $1
          LIMIT ${REFERENCE_RESOLUTION_SCAN_LIMIT}`,
        [BILLING_PROVIDER],
      );
      const matches = rows.filter(
        (row) => billingCheckoutReference(row.user_id, row.pricing_idempotency_key) === subject.providerReference,
      );
      if (matches.length > 1) return null; // a hash collision is an incident, not a choice
      const match = matches[0];
      if (match !== undefined) {
        if (!noteUser(match.user_id)) return null;
        if (!noteSubscription(match.subscription_id)) return null;
        if (match.billing_customer_id !== null && !noteCustomer(match.billing_customer_id)) return null;
      }
    }

    if (userIds.size !== 1) return null;
    const userId = [...userIds][0] as string;

    // Completion: the ledger binds a subject as the (subscription, user)
    // PAIR or not at all (0031 CHECK). When the paths resolved a user but no
    // subscription, the user's own row completes the pair — `subscriptions`
    // is UNIQUE per user, so "the user's subscription" is unambiguous, and a
    // provider event can only belong to a provider-backed row. A user with
    // no such row stays unbound: the ledger cannot store a user alone, and
    // the `provider_customer_id` column keeps the trace for review.
    if (subscriptionId === null) {
      const { rows } = await db.query<{ id: string; billing_customer_id: string | null }>(
        `SELECT id, billing_customer_id
           FROM subscriptions
          WHERE user_id = $1 AND provider = $2`,
        [userId, BILLING_PROVIDER],
      );
      if (rows.length === 1) {
        subscriptionId = rows[0]!.id;
        const boundCustomer = rows[0]!.billing_customer_id;
        if (boundCustomer !== null && !noteCustomer(boundCustomer)) return null;
      }
    }

    return { userId, subscriptionId, billingCustomerId };
  };
}

/* -------------------------------------------------------------------------- */
/* The receiver                                                               */
/* -------------------------------------------------------------------------- */

export const BILLING_WEBHOOK_ERROR_REASONS = [
  'provider_not_registered',
  'invalid_signature',
  'persistence_failed',
] as const;
export type BillingWebhookErrorReason = (typeof BILLING_WEBHOOK_ERROR_REASONS)[number];

/**
 * A receiver refusal that happens BEFORE or AROUND the ledger write. Refusals
 * of the delivery CONTENT (unparseable JSON, a payload the seam refuses) are
 * NOT errors: they are recorded as `unrecognized` rows and reported through
 * `deliveryRefused` on the receipt, so evidence is never dropped.
 */
export class BillingWebhookError extends Error {
  readonly code = 'billing_webhook_refused' as const;
  constructor(readonly reason: BillingWebhookErrorReason, message: string) {
    super(message);
    this.name = 'BillingWebhookError';
  }
}

export function isBillingWebhookError(error: unknown): error is BillingWebhookError {
  return error instanceof BillingWebhookError;
}

export interface BillingWebhookDelivery {
  /** The EXACT received body bytes. Never a re-serialized or parsed form. */
  rawBody: Buffer | Uint8Array;
  /** The `x-paystack-signature` header value, when present. */
  signatureHeader: string | null;
  /** The receipt instant, captured by the route before any processing. */
  receivedAt: Date;
}

export interface BillingWebhookReceipt {
  /** `recorded` = a new ledger row; `replayed` = collapsed onto one. */
  outcome: BillingProviderEventRecordOutcome;
  /** Canonical type of the recorded row (`unrecognized` for refusals). */
  eventType: BillingEventType;
  idempotencyKey: string;
  /** True when the local subject was bound before the insert. */
  subjectResolved: boolean;
  /**
   * True when the delivery itself was refused (unparseable body, or a payload
   * the seam refuses). The row exists for review; the provider is told the
   * delivery was not accepted, so its documented retry schedule surfaces it.
   */
  deliveryRefused: boolean;
}

export interface BillingWebhookReceiverOptions {
  db: Pool;
  providers: BillingProviderRegistry;
  /** The same sandbox secret key the adapter was registered with. Injected. */
  secretKey: string;
  /** Injectable for tests; defaults to the real ledger store / resolver. */
  store?: BillingProviderEventStore;
  resolveSubject?: BillingEventSubjectResolver;
}

/**
 * One delivery in, one durable ledger row out — or a typed refusal.
 *
 * Order of operations is security-relevant and fixed:
 *   1. a provider must be registered (otherwise nothing may be received);
 *   2. the signature is verified over the RAW bytes before the body is
 *      parsed, normalized, resolved or persisted;
 *   3. only a verified body is parsed and handed to the seam's
 *      `normalizeEvent`;
 *   4. the local subject is resolved against the local directories;
 *   5. exactly one ledger row is written (or the replay collapses).
 */
export class BillingWebhookReceiver {
  private readonly store: BillingProviderEventStore;
  private readonly resolveSubject: BillingEventSubjectResolver;

  constructor(private readonly options: BillingWebhookReceiverOptions) {
    this.store = options.store ?? new BillingProviderEventStore(options.db);
    this.resolveSubject = options.resolveSubject ?? createBillingEventSubjectResolver(options.db);
  }

  async receive(delivery: BillingWebhookDelivery): Promise<BillingWebhookReceipt> {
    const provider = this.options.providers.get(BILLING_PROVIDER);
    if (provider === undefined) {
      throw new BillingWebhookError(
        'provider_not_registered',
        'No billing provider is registered, so no delivery can be received (fail closed).',
      );
    }

    const receivedAt = delivery.receivedAt.toISOString();
    const body = Buffer.isBuffer(delivery.rawBody) ? delivery.rawBody : Buffer.from(delivery.rawBody);

    // 2. Signature first, always, over the raw bytes. One identical refusal
    // for every failing shape — nothing about the body is examined before it.
    if (!verifyBillingWebhookSignature(body, delivery.signatureHeader, this.options.secretKey)) {
      throw new BillingWebhookError('invalid_signature', 'The delivery signature could not be verified.');
    }

    // 3. Parse. A signed body that is not JSON is still evidence: record it
    // `unrecognized` (payload hash of the raw text) and refuse the delivery.
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      const payloadHash = billingEventPayloadHash(body.toString('utf8'));
      const idempotencyKey = billingEventIdempotencyKey({
        provider: BILLING_PROVIDER,
        providerEventId: null,
        eventType: 'unrecognized',
        occurredAt: null,
        payloadHash,
      });
      const stored = await this.safeRecord({
        provider: BILLING_PROVIDER,
        eventType: 'unrecognized',
        providerEventId: null,
        idempotencyKey,
        payloadHash,
        subscriptionId: null,
        userId: null,
        providerCustomerId: null,
        providerSubscriptionId: null,
        providerReference: null,
        failureReason: 'The signed delivery body was not parseable JSON and was recorded for review.',
        occurredAt: null,
        receivedAt,
      });
      return { ...stored, eventType: 'unrecognized', subjectResolved: false, deliveryRefused: true };
    }

    // 4. Normalize through the seam. A refusal here is a typed provider
    // error whose message is designed to be persistable (Step 5.1); the
    // receiver still sanitizes it before it becomes durable text.
    let normalized: NormalizedBillingEvent;
    try {
      const request: BillingProviderRawEvent = {
        provider: BILLING_PROVIDER,
        payload,
        providerEventId: null, // Paystack deliveries publish no event id.
        receivedAt,
      };
      normalized = await provider.normalizeEvent(request);
    } catch (error) {
      const payloadHash = billingEventPayloadHash(payload);
      const idempotencyKey = billingEventIdempotencyKey({
        provider: BILLING_PROVIDER,
        providerEventId: null,
        eventType: 'unrecognized',
        occurredAt: null,
        payloadHash,
      });
      const stored = await this.safeRecord({
        provider: BILLING_PROVIDER,
        eventType: 'unrecognized',
        providerEventId: null,
        idempotencyKey,
        payloadHash,
        subscriptionId: null,
        userId: null,
        providerCustomerId: null,
        providerSubscriptionId: null,
        providerReference: null,
        failureReason: sanitizeBillingWebhookFailureReason(
          error instanceof Error ? error.message : 'delivery refused',
        ),
        occurredAt: null,
        receivedAt,
      });
      return { ...stored, eventType: 'unrecognized', subjectResolved: false, deliveryRefused: true };
    }

    // 5. Resolve the local subject BEFORE anything is persisted. The
    // normalizer always reports local ids as null; resolution binds them
    // (or binds nothing — a disagreement is never resolved by guessing).
    const subject = normalized.subject;
    const resolved =
      subject === null
        ? null
        : await this.resolveSubject({
            providerCustomerId: subject.providerCustomerId,
            providerSubscriptionId: subject.providerSubscriptionId,
            providerReference: subject.providerReference,
          });
    // The ledger binds the (subscription, user) PAIR or nothing (0031 CHECK):
    // a user without a subscription row is recorded unbound (the provider
    // references below keep the trace), never half-bound.
    const bound = resolved !== null && resolved.subscriptionId !== null ? resolved : null;

    const stored = await this.safeRecord({
      provider: normalized.identity.provider,
      eventType: normalized.identity.eventType,
      providerEventId: normalized.identity.providerEventId,
      idempotencyKey: normalized.identity.idempotencyKey,
      payloadHash: normalized.identity.payloadHash,
      subscriptionId: bound?.subscriptionId ?? null,
      userId: bound?.userId ?? null,
      providerCustomerId: subject?.providerCustomerId ?? null,
      providerSubscriptionId: subject?.providerSubscriptionId ?? null,
      providerReference: subject?.providerReference ?? null,
      failureReason: null,
      occurredAt: normalized.identity.occurredAt,
      receivedAt,
    });
    return {
      ...stored,
      eventType: normalized.identity.eventType,
      subjectResolved: bound !== null,
      deliveryRefused: false,
    };
  }

  private async safeRecord(
    input: BillingProviderEventInsert,
  ): Promise<{ outcome: BillingProviderEventRecordOutcome; idempotencyKey: string }> {
    try {
      const stored = await this.store.record(input);
      return { outcome: stored.outcome, idempotencyKey: stored.idempotencyKey };
    } catch {
      throw new BillingWebhookError(
        'persistence_failed',
        'The verified delivery could not be recorded in the provider-event ledger.',
      );
    }
  }
}
