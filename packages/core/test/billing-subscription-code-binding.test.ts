/**
 * Billing Step 9b Part 2 — the provider subscription-code BINDING.
 *
 * The `subscription.created` delivery the webhook receiver has already
 * normalized and recorded carries the provider's own subscription identifier in
 * its subject. The receiver binds that identifier onto the EXISTING
 * `subscriptions.provider_subscription_code` column (migration 0031) onto the
 * row the delivery resolved to — an identity write, never a state write.
 *
 * These tests are pure: they drive the binder and the receiver against a
 * scripted fake pool, so every branch (bind, replay, conflict, race, refusal)
 * is exercised without a database. The database-backed behaviour — the partial
 * UNIQUE index, the CHECKs and the monotonic `state_version` trigger — is
 * migration 0031's own pinned behaviour and is asserted in
 * `billing-pr2-migrations.test.ts`; the SQL here only uses columns and
 * constraints that migration already created (asserted below: no migration is
 * added for this).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BILLING_PROVIDER, type NormalizedBillingEvent } from '@veltrixeye/contracts';
import {
  BILLING_SUBSCRIPTION_CODE_BINDINGS,
  BillingProviderEventStore,
  BillingWebhookReceiver,
  bindProviderSubscriptionCode,
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  createBillingProviderRegistry,
  createUnimplementedBillingProvider,
  type BillingProviderEventInsert,
  type BillingProviderRawEvent,
} from '../src/index.js';

const SECRET = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const RECEIVED_AT = new Date('2027-06-01T00:00:00.000Z');
const sign = (raw: string) => createHmac('sha512', SECRET).update(raw).digest('hex');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CODE = 'SUB_vsyqdmlzble3uii';

/* -------------------------------------------------------------------------- */
/* A scripted pool: one answer per statement, recorded                        */
/* -------------------------------------------------------------------------- */

interface RecordedQuery {
  text: string;
  values: unknown[];
}

type Answer =
  | { rows: Array<Record<string, unknown>>; rowCount?: number }
  | { throws: { code?: string; constraint?: string; message?: string } };

interface Script {
  /** The `SELECT id … provider_subscription_code = $2` ownership probe. */
  owners?: Answer;
  /** The guarded `UPDATE … RETURNING id`. */
  update?: Answer;
  /** The classification re-read of our own row. */
  current?: Answer;
}

function scriptedPool(script: Script) {
  const queries: RecordedQuery[] = [];
  const pool = {
    async query(text: string, values: unknown[]) {
      queries.push({ text, values });
      const answer: Answer = /^\s*SELECT id\b/im.test(text)
        ? (script.owners ?? { rows: [] })
        : /^\s*UPDATE/i.test(text)
          ? (script.update ?? { rows: [], rowCount: 0 })
          : (script.current ?? { rows: [] });
      if ('throws' in answer) {
        // pg surfaces its errors as Error instances carrying the SQLSTATE.
        const error = Object.assign(new Error(answer.throws.message ?? 'database error'), answer.throws);
        throw error;
      }
      return { rows: answer.rows, rowCount: answer.rowCount ?? answer.rows.length };
    },
  };
  return { pool: pool as never, queries };
}

const bind = (
  pool: ReturnType<typeof scriptedPool>['pool'],
  overrides: Partial<{ subscriptionId: string; userId: string; providerSubscriptionCode: string }> = {},
) =>
  bindProviderSubscriptionCode(pool, {
    subscriptionId: overrides.subscriptionId ?? SUBSCRIPTION_ID,
    userId: overrides.userId ?? USER_ID,
    providerSubscriptionCode: overrides.providerSubscriptionCode ?? CODE,
  });

/* ========================================================================== */
/* 1. The binder                                                             */
/* ========================================================================== */

describe('Step 9b Part 2 — bindProviderSubscriptionCode', () => {
  it('binds the code onto the resolved row, and to that row only', async () => {
    const { pool, queries } = scriptedPool({ update: { rows: [{ id: SUBSCRIPTION_ID }], rowCount: 1 } });
    assert.equal(await bind(pool), 'bound');

    assert.equal(queries.length, 2, 'an ownership probe, then the write');
    const [probe, update] = queries;
    // The probe is by (provider, code) — never by email, customer or plan.
    assert.match(probe!.text, /provider = \$1 AND provider_subscription_code = \$2/);
    assert.deepEqual(probe!.values, [BILLING_PROVIDER, CODE]);

    // The write re-asserts the whole identity in its WHERE clause and moves
    // ONLY the code (+ the row version).
    assert.match(update!.text, /SET provider_subscription_code = \$3,\s*state_version = state_version \+ 1/);
    assert.doesNotMatch(update!.text, /status|catalogue_plan|billing_interval|provider_state|plan =/i);
    for (const guard of [
      /id = \$1/,
      /user_id = \$2/,
      /provider = \$4/,
      /provider_subscription_code IS NULL/,
      /\(provider_subscription_id IS NULL OR provider_subscription_id = \$3\)/,
    ]) {
      assert.match(update!.text, guard, `the guarded write must re-assert ${guard}`);
    }
    assert.deepEqual(update!.values, [SUBSCRIPTION_ID, USER_ID, CODE, BILLING_PROVIDER]);
  });

  it('never writes a subscription-code column that does not exist yet (no migration)', () => {
    const source = readFileSync(path.join(SRC, 'billing', 'webhook.ts'), 'utf8');
    // Exactly the column migration 0031 already created…
    assert.match(source, /provider_subscription_code/);
    // …and no statement invents one.
    for (const write of source.matchAll(/(?:INSERT INTO|UPDATE)\s+subscriptions[\s\S]*?;/gi)) {
      assert.doesNotMatch(
        write[0],
        /subscription_code\s*\(/i,
        'the binding must not create a new subscription-code field',
      );
    }
    // The column, its UNIQUE index and the monotonic version trigger all pre-date
    // this work: no migration is added for it.
    const migrations = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
    const billing = migrations.filter((name) => /_billing\.sql$/.test(name));
    assert.deepEqual(billing, ['0031_provider_billing.sql'], 'no billing migration was added');
    const migration0031 = readFileSync(path.join(MIGRATIONS, '0031_provider_billing.sql'), 'utf8');
    assert.match(migration0031, /ADD COLUMN IF NOT EXISTS provider_subscription_code text/);
    assert.match(migration0031, /subscriptions_provider_subscription_code_uniq/);
    assert.match(migration0031, /subscriptions_state_version_monotonic/);
  });

  it('is idempotent on a replay: the same code is already bound, nothing is written', async () => {
    const { pool, queries } = scriptedPool({
      owners: { rows: [{ id: SUBSCRIPTION_ID }] }, // our own row already holds it
      update: { rows: [], rowCount: 0 },
      current: { rows: [{ provider_subscription_code: CODE, provider_subscription_id: null }] },
    });
    assert.equal(await bind(pool), 'already_bound');
    assert.equal(queries.length, 1, 'the ownership probe answers it: no write at all');
    assert.equal(queries.filter((query) => /^\s*UPDATE/i.test(query.text)).length, 0);
  });

  it('refuses to move or overwrite a code another row already holds', async () => {
    const { pool, queries } = scriptedPool({
      owners: { rows: [{ id: '99999999-9999-4999-8999-999999999999' }] },
    });
    assert.equal(await bind(pool), 'conflict');
    assert.equal(queries.length, 1, 'it stops at the ownership probe: nothing is written');
  });

  it('refuses an ambiguous ownership read (more than one holder) without writing', async () => {
    const { pool, queries } = scriptedPool({
      owners: { rows: [{ id: SUBSCRIPTION_ID }, { id: '99999999-9999-4999-8999-999999999999' }] },
    });
    assert.equal(await bind(pool), 'conflict');
    assert.equal(queries.filter((query) => /^\s*UPDATE/i.test(query.text)).length, 0);
  });

  it('refuses a row that already carries a DIFFERENT code', async () => {
    const { pool, queries } = scriptedPool({
      update: { rows: [], rowCount: 0 },
      current: { rows: [{ provider_subscription_code: 'SUB_someoneelse000', provider_subscription_id: null }] },
    });
    assert.equal(await bind(pool), 'conflict');
    const reread = queries[queries.length - 1]!;
    assert.match(reread.text, /SELECT provider_subscription_code/);
    // The re-read is keyed by OUR row AND user: another user's row is never read.
    assert.deepEqual(reread.values, [SUBSCRIPTION_ID, USER_ID, BILLING_PROVIDER]);
  });

  it('refuses a row that already carries a different provider subscription id', async () => {
    const { pool } = scriptedPool({
      update: { rows: [], rowCount: 0 },
      current: { rows: [{ provider_subscription_code: null, provider_subscription_id: '292646' }] },
    });
    // The guarded UPDATE does not fire (the WHERE excludes it) and the
    // classification read shows a different provider identifier: a conflict,
    // because this build has no published relationship between the two.
    assert.equal(await bind(pool), 'conflict');
  });

  it('refuses when the subject points at no row of ours at all', async () => {
    const { pool } = scriptedPool({ update: { rows: [], rowCount: 0 }, current: { rows: [] } });
    assert.equal(await bind(pool), 'conflict');
  });

  it('treats a UNIQUE violation from a race as a conflict, never a failure', async () => {
    const { pool } = scriptedPool({
      owners: { rows: [] },
      update: { throws: { code: '23505', constraint: 'subscriptions_provider_subscription_code_uniq' } },
    });
    assert.equal(await bind(pool), 'conflict');
  });

  it('propagates an unrelated database error, so a failure is never hidden as a conflict', async () => {
    const { pool } = scriptedPool({
      owners: { rows: [] },
      update: { throws: { code: '23505', constraint: 'some_other_uniq_index' } },
    });
    await assert.rejects(
      () => bind(pool),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { constraint?: string }).constraint, 'some_other_uniq_index');
        return true;
      },
      'an unrelated database failure is never reported as an identity conflict',
    );
  });

  it('never accepts a non-canonical subject or a credential-shaped code', async () => {
    const { pool, queries } = scriptedPool({ update: { rows: [{ id: SUBSCRIPTION_ID }], rowCount: 1 } });
    for (const [label, overrides] of [
      ['a non-uuid subscription', { subscriptionId: 'not-a-uuid' }],
      ['a non-uuid user', { userId: 'not-a-uuid' }],
      ['a credential-shaped code', { providerSubscriptionCode: 'email_token:d7gofp6yppn3qz7' }],
      ['an empty code', { providerSubscriptionCode: '' }],
      ['an over-wide code', { providerSubscriptionCode: 'x'.repeat(129) }],
    ] as const) {
      await assert.rejects(() => bind(pool, overrides), `${label} must be refused`);
    }
    assert.equal(queries.length, 0, 'a non-canonical input never reaches SQL');
  });
});

/* ========================================================================== */
/* 2. The receiver wiring                                                    */
/* ========================================================================== */

function subscriptionCreatedEvent(request: BillingProviderRawEvent): NormalizedBillingEvent {
  const payloadHash = billingEventPayloadHash(request.payload);
  const input = {
    provider: BILLING_PROVIDER,
    providerEventId: null,
    eventType: 'subscription.created' as const,
    occurredAt: '2026-09-24T10:34:57.000Z',
    payloadHash,
  };
  return {
    identity: { ...input, idempotencyKey: billingEventIdempotencyKey(input), receivedAt: request.receivedAt },
    category: 'subscription',
    subject: {
      userId: null,
      subscriptionId: null,
      billingCustomerId: null,
      providerCustomerId: 'CUS_fixture0000001',
      providerSubscriptionId: CODE, // the provider's own subscription_code
      providerReference: null,
    },
    data: null,
    grantsExecution: false,
  };
}

function receiverWith(options: {
  normalize: (request: BillingProviderRawEvent) => Promise<NormalizedBillingEvent>;
  script: Script;
  resolveSubject?: () => Promise<{ userId: string; subscriptionId: string | null; billingCustomerId: string | null } | null>;
}) {
  const registry = createBillingProviderRegistry();
  registry.register({ ...createUnimplementedBillingProvider(), normalizeEvent: options.normalize });
  const recorded: BillingProviderEventInsert[] = [];
  const store = new BillingProviderEventStore(scriptedPool({}).pool);
  (store as unknown as { record: (input: BillingProviderEventInsert) => Promise<unknown> }).record = async (input) => {
    recorded.push(input);
    return { id: 'row-id', outcome: 'recorded', idempotencyKey: input.idempotencyKey };
  };
  const { pool, queries } = scriptedPool(options.script);
  const receiver = new BillingWebhookReceiver({
    db: pool,
    providers: registry,
    secretKey: SECRET,
    store,
    resolveSubject: async () =>
      options.resolveSubject
        ? options.resolveSubject()
        : { userId: USER_ID, subscriptionId: SUBSCRIPTION_ID, billingCustomerId: null },
  });
  return { receiver, recorded, queries };
}

const delivery = (raw: string) => ({
  rawBody: Buffer.from(raw),
  signatureHeader: sign(raw),
  receivedAt: RECEIVED_AT,
});

const subscriptionCreateBody = JSON.stringify({
  event: 'subscription.create',
  data: { subscription_code: CODE },
});

describe('Step 9b Part 2 — the receiver binds a subscription.created code', () => {
  it('records the delivery, then binds its code onto the resolved row', async () => {
    const { receiver, recorded, queries } = receiverWith({
      normalize: async (request) => subscriptionCreatedEvent(request),
      script: { update: { rows: [{ id: SUBSCRIPTION_ID }], rowCount: 1 } },
    });
    const receipt = await receiver.receive(delivery(subscriptionCreateBody));

    assert.equal(receipt.eventType, 'subscription.created');
    assert.equal(receipt.subjectResolved, true);
    assert.equal(receipt.deliveryRefused, false);
    assert.equal(receipt.subscriptionCodeBinding, 'bound');
    // The evidence is durable BEFORE the identity write: the ledger row is
    // recorded either way.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.eventType, 'subscription.created');
    assert.equal(recorded[0]!.providerSubscriptionId, CODE);
    const write = queries.find((query) => /^\s*UPDATE/i.test(query.text));
    assert.ok(write, 'the guarded write ran');
    assert.deepEqual(write.values, [SUBSCRIPTION_ID, USER_ID, CODE, BILLING_PROVIDER]);
  });

  it('binds nothing when the delivery resolved no local owner', async () => {
    const { receiver, queries, recorded } = receiverWith({
      normalize: async (request) => subscriptionCreatedEvent(request),
      script: { update: { rows: [{ id: SUBSCRIPTION_ID }], rowCount: 1 } },
      resolveSubject: async () => null,
    });
    const receipt = await receiver.receive(delivery(subscriptionCreateBody));
    assert.equal(receipt.subjectResolved, false);
    assert.equal(receipt.subscriptionCodeBinding, 'unbound_subject');
    assert.equal(queries.length, 0, 'no binding query is even attempted');
    // The delivery is still recorded: evidence is never dropped.
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.subscriptionId, null);
  });

  it('binds nothing when the subject resolved a user but no subscription row', async () => {
    const { receiver, queries } = receiverWith({
      normalize: async (request) => subscriptionCreatedEvent(request),
      script: {},
      resolveSubject: async () => ({ userId: USER_ID, subscriptionId: null, billingCustomerId: null }),
    });
    const receipt = await receiver.receive(delivery(subscriptionCreateBody));
    assert.equal(receipt.subscriptionCodeBinding, 'unbound_subject');
    assert.equal(queries.length, 0);
  });

  it('reports a conflicting binding, and still records the delivery', async () => {
    const { receiver, recorded } = receiverWith({
      normalize: async (request) => subscriptionCreatedEvent(request),
      script: { owners: { rows: [{ id: '99999999-9999-4999-8999-999999999999' }] } },
    });
    const receipt = await receiver.receive(delivery(subscriptionCreateBody));
    assert.equal(receipt.subscriptionCodeBinding, 'conflict');
    assert.equal(receipt.subjectResolved, true, 'the delivery itself is not refused');
    assert.equal(recorded.length, 1);
  });

  it('does not bind from an event that is not a subscription creation', async () => {
    const { receiver, queries } = receiverWith({
      normalize: async (request) => {
        const event = subscriptionCreatedEvent(request);
        return {
          ...event,
          identity: { ...event.identity, eventType: 'payment.succeeded', idempotencyKey: 'a'.repeat(64) },
        };
      },
      script: { update: { rows: [{ id: SUBSCRIPTION_ID }], rowCount: 1 } },
    });
    const receipt = await receiver.receive(delivery(subscriptionCreateBody));
    assert.equal(receipt.subscriptionCodeBinding, 'not_applicable');
    assert.equal(queries.length, 0);
  });

  it('does not bind from a creation event that carries no subscription identity', async () => {
    const { receiver, queries } = receiverWith({
      normalize: async (request) => {
        const event = subscriptionCreatedEvent(request);
        return {
          ...event,
          subject: {
            userId: null,
            subscriptionId: null,
            billingCustomerId: null,
            providerCustomerId: 'CUS_fixture0000001',
            providerSubscriptionId: null, // the payload published no subscription code
            providerReference: null,
          },
        };
      },
      script: { update: { rows: [{ id: SUBSCRIPTION_ID }], rowCount: 1 } },
    });
    const receipt = await receiver.receive(delivery(subscriptionCreateBody));
    assert.equal(receipt.subscriptionCodeBinding, 'not_applicable');
    assert.equal(queries.length, 0);
  });

  it('never fails a recorded delivery because a binding could not be written', async () => {
    const { receiver, recorded } = receiverWith({
      normalize: async (request) => subscriptionCreatedEvent(request),
      script: { update: { throws: { code: '57014', message: 'statement timeout' } } },
    });
    const receipt = await receiver.receive(delivery(subscriptionCreateBody));
    assert.equal(receipt.subscriptionCodeBinding, 'failed');
    assert.equal(receipt.deliveryRefused, false);
    assert.equal(recorded.length, 1, 'the delivery stays recorded for review');
  });

  it('reports no binding for a refused or unparseable delivery', async () => {
    const refused = receiverWith({
      normalize: async () => {
        throw new Error('the payload is missing or malformed');
      },
      script: {},
    });
    const badBody = '{not json';
    const receipt = await refused.receiver.receive({
      rawBody: Buffer.from(badBody),
      signatureHeader: sign(badBody),
      receivedAt: RECEIVED_AT,
    });
    assert.equal(receipt.eventType, 'unrecognized');
    assert.equal(receipt.deliveryRefused, true);
    assert.equal(receipt.subscriptionCodeBinding, 'not_applicable');
    assert.equal(refused.queries.length, 0);
  });

  it('publishes every binding outcome it can report', () => {
    assert.deepEqual(
      [...BILLING_SUBSCRIPTION_CODE_BINDINGS].sort(),
      ['already_bound', 'bound', 'conflict', 'failed', 'not_applicable', 'unbound_subject'],
    );
  });
});

/* ========================================================================== */
/* 3. The column is not a second identity field                               */
/* ========================================================================== */

describe('Step 9b Part 2 — the binding adds no column and no credential', () => {
  it('writes no credential-shaped value and stores no provider payload', () => {
    const source = readFileSync(path.join(SRC, 'billing', 'webhook.ts'), 'utf8');
    const binder = /export async function bindProviderSubscriptionCode\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    assert.ok(binder.length > 0, 'the binder exists');
    // It takes a reference and writes a reference: no payload, no token, no
    // raw provider text of any kind.
    assert.doesNotMatch(binder, /email_token|payload|authorization/i);
    assert.doesNotMatch(binder, /INSERT INTO/i);
  });

  it('the migration that owns the column is unchanged on disk', () => {
    assert.ok(existsSync(MIGRATIONS));
    const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
    assert.ok(!files.some((name) => /subscription_code/i.test(name)), 'no migration file for this work exists');
  });
});
