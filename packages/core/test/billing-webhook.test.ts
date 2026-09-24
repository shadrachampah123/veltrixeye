import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  BILLING_PROVIDER,
  billingEventIdempotencyCanonicalString,
  type BillingEventIdempotencyInput,
  type NormalizedBillingEvent,
} from '@veltrixeye/contracts';
import {
  BILLING_WEBHOOK_SIGNATURE_HEADER,
  BILLING_WEBHOOK_WITHHELD_REASON,
  BillingProviderEventStore,
  BillingWebhookError,
  BillingWebhookReceiver,
  createBillingProviderRegistry,
  isBillingWebhookError,
  sanitizeBillingWebhookFailureReason,
  verifyBillingWebhookSignature,
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  createUnimplementedBillingProvider,
  type BillingProviderEventInsert,
  type BillingProviderRawEvent,
} from '../src/index.js';

/* ==========================================================================
   Billing Step 5.2 — the secure webhook receiver core (pure tests).

   These tests cover the transport-free half of the receiver: signature
   verification over raw bytes, failure-reason sanitization, the ledger
   store's insert/replay contract (against a recorded fake pool), and the
   receiver's order of operations against a stubbed seam provider. The
   database-backed half lives in billing-webhook-db.test.ts; the HTTP route
   lives in apps/api/test/billing-webhook.test.ts.
   ========================================================================== */

const SECRET = 'sk_test_0123456789abcdef0123456789abcdef01234567';

function sign(rawBody: string | Buffer, secret: string = SECRET): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

const RECEIVED_AT = new Date('2027-06-01T00:00:00.000Z');

describe('Step 5.2 — signature verification (HMAC-SHA512 over the RAW body)', () => {
  it('accepts the documented signature: hex HMAC-SHA512 of the raw bytes keyed by the secret key', () => {
    const raw = '{"event":"charge.success","data":{"domain":"test"}}';
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), sign(raw), SECRET), true);
    // A Uint8Array body (never re-serialized) verifies identically.
    assert.equal(verifyBillingWebhookSignature(new Uint8Array(Buffer.from(raw)), sign(raw), SECRET), true);
  });

  it('is a function of the EXACT bytes: whitespace and key order change the signature', () => {
    const a = '{"event":"x","data":{}}';
    const b = '{ "event": "x", "data": {} }'; // semantically identical JSON
    const signature = sign(a);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(a), signature, SECRET), true);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(b), signature, SECRET), false);
  });

  it('refuses one wrong signature, one missing signature and one wrong key identically', () => {
    const raw = '{"event":"charge.success"}';
    const good = sign(raw);
    const wrong = good.slice(0, -2) + (good.endsWith('00') ? '11' : '00');
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), wrong, SECRET), false);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), null, SECRET), false);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), undefined, SECRET), false);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), '', SECRET), false);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), good, 'sk_test_other'), false);
  });

  it('refuses malformed signatures without throwing', () => {
    const raw = '{"event":"charge.success"}';
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), 'zz'.repeat(64), SECRET), false);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), '0'.repeat(127), SECRET), false);
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), '0'.repeat(129), SECRET), false);
  });

  it('an empty secret verifies nothing (a half-configured receiver is unusable)', () => {
    const raw = '{"event":"charge.success"}';
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), sign(raw, ''), ''), false);
  });

  it('accepts case-insensitive hex of the same digest, never a different digest', () => {
    const raw = '{"event":"charge.success"}';
    assert.equal(verifyBillingWebhookSignature(Buffer.from(raw), sign(raw).toUpperCase(), SECRET), true);
  });

  it('the header name is the documented one', () => {
    assert.equal(BILLING_WEBHOOK_SIGNATURE_HEADER, 'x-paystack-signature');
  });
});

describe('Step 5.2 — failure-reason sanitization (0031 failure_reason posture)', () => {
  it('collapses to one line and bounds to the durable 600-character limit', () => {
    const reason = sanitizeBillingWebhookFailureReason('line one\nline\ttwo   '.repeat(80));
    assert.ok(reason.length <= 600);
    assert.ok(!reason.includes('\n'));
    assert.ok(!reason.includes('\t'));
  });

  it('replaces credential-shaped reasons WHOLE with the withheld phrase', () => {
    for (const message of [
      'refused: Bearer sk_test_something',
      'invalid api_key supplied',
      'authorization failed for token 123',
      'secret credential mismatch',
      'private_key rejected',
    ]) {
      assert.equal(sanitizeBillingWebhookFailureReason(message), BILLING_WEBHOOK_WITHHELD_REASON, message);
    }
  });

  it('preserves ordinary prose and survives non-string input', () => {
    assert.equal(
      sanitizeBillingWebhookFailureReason('The delivery reports a domain other than test.'),
      'The delivery reports a domain other than test.',
    );
    // Non-string / empty input keeps nothing of the input; the fixed phrase is
    // the only safe thing to persist.
    assert.equal(sanitizeBillingWebhookFailureReason(undefined), BILLING_WEBHOOK_WITHHELD_REASON);
    assert.equal(sanitizeBillingWebhookFailureReason('   '), BILLING_WEBHOOK_WITHHELD_REASON);
    assert.equal(sanitizeBillingWebhookFailureReason(42), BILLING_WEBHOOK_WITHHELD_REASON);
  });
});

/* -------------------------------------------------------------------------- */
/* The ledger store against a recorded fake pool                             */
/* -------------------------------------------------------------------------- */

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function fakePool(result: { id?: string } | 'conflict') {
  const queries: RecordedQuery[] = [];
  const pool = {
    async query(text: string, values: unknown[]) {
      queries.push({ text, values });
      return result === 'conflict' ? { rows: [] } : { rows: [result] };
    },
  };
  return { pool: pool as never, queries };
}

function validInsert(overrides: Partial<BillingProviderEventInsert> = {}): BillingProviderEventInsert {
  const payloadHash = billingEventPayloadHash({ event: 'charge.success', data: {} });
  const idempotencyInput: BillingEventIdempotencyInput = {
    provider: BILLING_PROVIDER,
    providerEventId: null,
    eventType: 'payment.succeeded',
    occurredAt: '2026-09-22T10:15:02.000Z',
    payloadHash,
  };
  return {
    provider: BILLING_PROVIDER,
    eventType: 'payment.succeeded',
    providerEventId: null,
    idempotencyKey: billingEventIdempotencyKey(idempotencyInput),
    payloadHash,
    subscriptionId: null,
    userId: null,
    providerCustomerId: 'CUS_fixture0000001',
    providerSubscriptionId: null,
    providerReference: null,
    failureReason: null,
    occurredAt: '2026-09-22T10:15:02.000Z',
    receivedAt: '2027-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Step 5.2 — BillingProviderEventStore (ledger insert/replay contract)', () => {
  it('inserts one received row and reports `recorded`', async () => {
    const { pool, queries } = fakePool({ id: '11111111-1111-4111-8111-111111111111' });
    const store = new BillingProviderEventStore(pool);
    const insert = validInsert();
    const stored = await store.record(insert);
    assert.equal(stored.outcome, 'recorded');
    assert.equal(stored.idempotencyKey, insert.idempotencyKey);
    assert.equal(queries.length, 1);
    const { text, values } = queries[0]!;
    // Replay safety is expressed in SQL, exactly as 0031's UNIQUE key intends.
    assert.match(text, /ON CONFLICT \(idempotency_key\) DO NOTHING/i);
    assert.match(text, /INSERT INTO billing_provider_events/i);
    // The payload itself is never a bound value: only canonical fields + hashes.
    assert.ok(!values.some((value) => typeof value === 'object' && value !== null));
    // The initial processing state is fixed in the statement itself.
    assert.match(text, /'received'/);
  });

  it('a conflicting idempotency key is a replay, never a second row', async () => {
    const { pool } = fakePool('conflict');
    const store = new BillingProviderEventStore(pool);
    const stored = await store.record(validInsert());
    assert.equal(stored.outcome, 'replayed');
    assert.equal(stored.id, null);
  });

  it('refuses a row whose subject is half-bound (both ids or neither)', async () => {
    const { pool } = fakePool({ id: 'x' });
    const store = new BillingProviderEventStore(pool);
    await assert.rejects(
      store.record(validInsert({ userId: '11111111-1111-4111-8111-111111111111' })),
      (error: unknown) => (error as Error).name === 'ZodError',
    );
  });

  it('refuses unknown event types, wrong-shaped hashes and out-of-bound text', async () => {
    const { pool } = fakePool({ id: 'x' });
    const store = new BillingProviderEventStore(pool);
    await assert.rejects(store.record(validInsert({ eventType: 'charge.success' as never })));
    await assert.rejects(store.record(validInsert({ payloadHash: 'not-a-hash' })));
    await assert.rejects(store.record(validInsert({ failureReason: 'x'.repeat(601) })));
    await assert.rejects(store.record(validInsert({ providerReference: null, providerCustomerId: 'x'.repeat(129) })));
  });
});

/* -------------------------------------------------------------------------- */
/* The receiver against a stubbed seam (order of operations)                  */
/* -------------------------------------------------------------------------- */

function canonicalEvent(request: BillingProviderRawEvent): NormalizedBillingEvent {
  const payloadHash = billingEventPayloadHash(request.payload);
  const input: BillingEventIdempotencyInput = {
    provider: BILLING_PROVIDER,
    providerEventId: null,
    eventType: 'payment.succeeded',
    occurredAt: '2026-09-22T10:15:02.000Z',
    payloadHash,
  };
  return {
    identity: {
      ...input,
      idempotencyKey: billingEventIdempotencyKey(input),
      receivedAt: request.receivedAt,
    },
    category: 'payment',
    subject: {
      userId: null,
      subscriptionId: null,
      billingCustomerId: null,
      providerCustomerId: 'CUS_fixture0000001',
      providerSubscriptionId: null,
      providerReference: null,
    },
    data: null,
    grantsExecution: false,
  };
}

function stubProvider(normalizeEvent: (request: BillingProviderRawEvent) => Promise<NormalizedBillingEvent>) {
  return { ...createUnimplementedBillingProvider(), normalizeEvent };
}

function receiverWith(options: {
  normalize?: (request: BillingProviderRawEvent) => Promise<NormalizedBillingEvent>;
  storeResults?: ('recorded' | 'replayed')[];
  resolveSubject?: () => Promise<{ userId: string; subscriptionId: string | null; billingCustomerId: string | null } | null>;
}) {
  const registry = createBillingProviderRegistry();
  registry.register(stubProvider(options.normalize ?? (async (request) => canonicalEvent(request))));
  const recorded: BillingProviderEventInsert[] = [];
  const outcomes = [...(options.storeResults ?? ['recorded'])];
  const store = new BillingProviderEventStore(fakePool({ id: 'x' }).pool);
  // Replace the transport with a recorder that honors the queued outcomes.
  (store as unknown as { record: (input: BillingProviderEventInsert) => Promise<unknown> }).record = async (input) => {
    recorded.push(input);
    const outcome = outcomes.shift() ?? 'replayed';
    return { id: outcome === 'recorded' ? 'row-id' : null, outcome, idempotencyKey: input.idempotencyKey };
  };
  const resolveCalls: unknown[] = [];
  const receiver = new BillingWebhookReceiver({
    db: fakePool({ id: 'x' }).pool,
    providers: registry,
    secretKey: SECRET,
    store,
    resolveSubject: async (subject) => {
      resolveCalls.push(subject);
      return options.resolveSubject ? options.resolveSubject() : null;
    },
  });
  return { receiver, recorded, resolveCalls };
}

describe('Step 5.2 — BillingWebhookReceiver order of operations', () => {
  it('refuses when no billing provider is registered (fail closed)', async () => {
    const receiver = new BillingWebhookReceiver({
      db: fakePool({ id: 'x' }).pool,
      providers: createBillingProviderRegistry(), // empty
      secretKey: SECRET,
    });
    const raw = JSON.stringify({ event: 'charge.success', data: {} });
    await assert.rejects(
      receiver.receive({
        rawBody: Buffer.from(raw),
        signatureHeader: sign(raw),
        receivedAt: RECEIVED_AT,
      }),
      (error: unknown) => isBillingWebhookError(error) && error.reason === 'provider_not_registered',
    );
  });

  it('verifies the signature BEFORE anything is parsed or recorded', async () => {
    const { receiver, recorded, resolveCalls } = receiverWith({});
    const raw = JSON.stringify({ event: 'charge.success', data: {} });
    await assert.rejects(
      receiver.receive({ rawBody: Buffer.from(raw), signatureHeader: '0'.repeat(128), receivedAt: RECEIVED_AT }),
      (error: unknown) => isBillingWebhookError(error) && error.reason === 'invalid_signature',
    );
    await assert.rejects(
      receiver.receive({ rawBody: Buffer.from(raw), signatureHeader: null, receivedAt: RECEIVED_AT }),
      (error: unknown) => error instanceof BillingWebhookError,
    );
    assert.equal(recorded.length, 0);
    assert.equal(resolveCalls.length, 0);
  });

  it('records a verified delivery with the seam identity and a resolved subject', async () => {
    const { receiver, recorded, resolveCalls } = receiverWith({
      resolveSubject: async () => ({
        userId: '11111111-1111-4111-8111-111111111111',
        subscriptionId: '22222222-2222-4222-8222-222222222222',
        billingCustomerId: '33333333-3333-4333-8333-333333333333',
      }),
    });
    const payload = { event: 'charge.success', data: { domain: 'test' } };
    const raw = JSON.stringify(payload);
    const receipt = await receiver.receive({
      rawBody: Buffer.from(raw),
      signatureHeader: sign(raw),
      receivedAt: RECEIVED_AT,
    });
    assert.equal(receipt.outcome, 'recorded');
    assert.equal(receipt.eventType, 'payment.succeeded');
    assert.equal(receipt.deliveryRefused, false);
    assert.equal(receipt.subjectResolved, true);
    assert.equal(receipt.idempotencyKey.length, 64);
    assert.equal(recorded.length, 1);
    const row = recorded[0]!;
    assert.equal(row.payloadHash, billingEventPayloadHash(payload));
    assert.equal(row.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(row.subscriptionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(row.receivedAt, RECEIVED_AT.toISOString());
    assert.equal(row.failureReason, null);
    // Subject resolution saw exactly the subject references the seam reported.
    assert.deepEqual(resolveCalls, [
      { providerCustomerId: 'CUS_fixture0000001', providerSubscriptionId: null, providerReference: null },
    ]);
  });

  it('a replay collapses onto the existing row (store says `replayed`)', async () => {
    const { receiver, recorded } = receiverWith({ storeResults: ['recorded', 'replayed'] });
    const raw = JSON.stringify({ event: 'charge.success', data: { domain: 'test' } });
    const delivery = { rawBody: Buffer.from(raw), signatureHeader: sign(raw), receivedAt: RECEIVED_AT };
    const first = await receiver.receive(delivery);
    const second = await receiver.receive(delivery);
    assert.equal(first.outcome, 'recorded');
    assert.equal(second.outcome, 'replayed');
    // Same payload ⇒ same deterministic key, both times.
    assert.equal(first.idempotencyKey, second.idempotencyKey);
    assert.equal(recorded.length, 2);
  });

  it('records a signed-but-unparseable body as unrecognized and refuses it', async () => {
    const { receiver, recorded } = receiverWith({});
    const raw = '{{ this is not JSON';
    const receipt = await receiver.receive({
      rawBody: Buffer.from(raw),
      signatureHeader: sign(raw),
      receivedAt: RECEIVED_AT,
    });
    assert.equal(receipt.deliveryRefused, true);
    assert.equal(receipt.eventType, 'unrecognized');
    assert.equal(recorded.length, 1);
    const row = recorded[0]!;
    assert.equal(row.eventType, 'unrecognized');
    assert.equal(row.payloadHash, billingEventPayloadHash(raw));
    assert.match(row.failureReason ?? '', /not parseable JSON/);
    // No subject is ever asserted for an unparseable delivery.
    assert.equal(row.userId, null);
    assert.equal(row.subscriptionId, null);
  });

  it('records a seam refusal as unrecognized with a sanitized, persistable reason', async () => {
    const { receiver, recorded } = receiverWith({
      normalize: async () => {
        throw new Error('The delivery reports a domain other than test (data.domain).');
      },
    });
    const raw = JSON.stringify({ event: 'charge.success', data: { domain: 'live' } });
    const receipt = await receiver.receive({
      rawBody: Buffer.from(raw),
      signatureHeader: sign(raw),
      receivedAt: RECEIVED_AT,
    });
    assert.equal(receipt.deliveryRefused, true);
    assert.equal(receipt.eventType, 'unrecognized');
    const row = recorded[0]!;
    assert.equal(row.eventType, 'unrecognized');
    assert.match(row.failureReason ?? '', /domain other than test/);
  });

  it('never stores a credential-shaped refusal reason', async () => {
    const { receiver, recorded } = receiverWith({
      normalize: async () => {
        throw new Error('invalid authorization Bearer sk_test_abcdef123456');
      },
    });
    const raw = JSON.stringify({ event: 'charge.success', data: {} });
    await receiver.receive({ rawBody: Buffer.from(raw), signatureHeader: sign(raw), receivedAt: RECEIVED_AT });
    assert.equal(recorded[0]!.failureReason, BILLING_WEBHOOK_WITHHELD_REASON);
  });

  it('an unresolved subject records the event unbound (never guessed)', async () => {
    const { receiver, recorded } = receiverWith({ resolveSubject: async () => null });
    const raw = JSON.stringify({ event: 'charge.success', data: { domain: 'test' } });
    const receipt = await receiver.receive({
      rawBody: Buffer.from(raw),
      signatureHeader: sign(raw),
      receivedAt: RECEIVED_AT,
    });
    assert.equal(receipt.subjectResolved, false);
    assert.equal(recorded[0]!.userId, null);
    assert.equal(recorded[0]!.subscriptionId, null);
  });

  it('the idempotency key follows the canonical derivation exactly', async () => {
    const { receiver } = receiverWith({});
    const payload = { event: 'charge.success', data: { domain: 'test' } };
    const raw = JSON.stringify(payload);
    const receipt = await receiver.receive({
      rawBody: Buffer.from(raw),
      signatureHeader: sign(raw),
      receivedAt: RECEIVED_AT,
    });
    const expected = billingEventIdempotencyKey({
      provider: BILLING_PROVIDER,
      providerEventId: null,
      eventType: 'payment.succeeded',
      occurredAt: '2026-09-22T10:15:02.000Z',
      payloadHash: billingEventPayloadHash(payload),
    });
    assert.equal(receipt.idempotencyKey, expected);
    assert.equal(
      billingEventIdempotencyCanonicalString({
        provider: BILLING_PROVIDER,
        providerEventId: null,
        eventType: 'payment.succeeded',
        occurredAt: '2026-09-22T10:15:02.000Z',
        payloadHash: billingEventPayloadHash(payload),
      }).includes('|'),
      true,
    );
  });
});

describe('Step 5.2 — the receiver module keeps the Step 5.1 boundary intact', () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'billing', 'webhook.ts'),
    'utf8',
  );

  it('imports nothing from the Paystack adapter and reads no environment', () => {
    assert.doesNotMatch(source, /@veltrixeye\/provider-paystack/);
    assert.doesNotMatch(source, /process\.env/);
    assert.doesNotMatch(source, /sk_test_[A-Za-z0-9]{12,}/);
    assert.doesNotMatch(source, /sk_live_[A-Za-z0-9]/);
  });

  it('verifies with HMAC-SHA512 and a constant-time compare over raw bytes', () => {
    assert.match(source, /createHmac\('sha512'/);
    assert.match(source, /timingSafeEqual/);
  });

  it('performs no outbound transport of any kind', () => {
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /api\.paystack/i);
    assert.doesNotMatch(source, /https?:\/\//);
  });
});
