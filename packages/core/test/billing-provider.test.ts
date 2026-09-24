/**
 * Billing PR2 — the provider seam (core).
 *
 * Pins the boundary and nothing else:
 *  - the seam declares the operations a later Paystack PR must implement and
 *    implements NONE of them: the placeholder fails closed on every one;
 *  - the registry starts empty — no Paystack provider is registered anywhere;
 *  - the seam module performs no I/O: its imports are `node:crypto`, `zod`,
 *    the contracts and the catalogue authority, and its source contains no
 *    HTTP client, no provider endpoint and no credential identifier;
 *  - prices are read from the authoritative catalogue and are NOT restated in
 *    the seam (no price literal appears in its source);
 *  - idempotency/payload hashing is deterministic and pure;
 *  - entitlements are untouched: `canAccessAutomation` stays `false` for every
 *    plan and status, and the entitlement module neither imports nor consults
 *    the seam or the catalogue;
 *  - no billing route beyond the pre-existing read-only `GET /api/billing/me`
 *    exists (no checkout, no portal, no webhook).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BILLING_CATALOGUE,
  BILLING_PROVIDER,
  BILLING_PROVIDER_OPERATIONS,
  COMMERCIAL_PLANS,
  USER_PLANS,
  billingPlanIdentity,
  commercialPlanPrice,
  internalPlanForCommercialPlan,
  sha256HexSchema,
  type BillingProviderOperation,
  type UserPlan,
} from '@veltrixeye/contracts';
import {
  BillingProviderNotImplementedError,
  BillingProviderRegistry,
  billingEventIdempotencyKey,
  billingEventPayloadHash,
  canonicalizeBillingPayload,
  createBillingProviderRegistry,
  createUnimplementedBillingProvider,
  isBillingProviderNotImplemented,
  parseNormalizedBillingEvent,
  seamAmountMinor,
  seamCataloguePriceMinor,
  seamPlanIdentity,
  billingCheckoutRequestSchema,
  billingCheckoutSessionSchema,
  billingCustomerCreateRequestSchema,
  billingCustomerQuerySchema,
  billingProviderRawEventSchema,
  billingSubscriptionCancelRequestSchema,
  billingSubscriptionQuerySchema,
  billingSubscriptionSyncRequestSchema,
  billingSubscriptionVerifyRequestSchema,
  type BillingProvider,
} from '../src/billing/provider.js';
import { SERVER_BILLING_CATALOGUE, cataloguePriceMinor, unmappedCommercialPlans } from '../src/billing/catalogue.js';
import { getEntitlements } from '../src/billing/entitlements.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE_SRC = path.resolve(HERE, '..', 'src');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SEAM_SOURCE = readFileSync(path.join(CORE_SRC, 'billing', 'provider.ts'), 'utf8');
const ENTITLEMENTS_SOURCE = readFileSync(path.join(CORE_SRC, 'billing', 'entitlements.ts'), 'utf8');

const NOW = '2026-09-21T12:00:00.000Z';
const LATER = '2026-10-21T12:00:00.000Z';
const KEY = 'a'.repeat(64);
const HASH = 'c'.repeat(64);
const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SUBSCRIPTION_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

/** Code only: drops full-line comments so prose cannot satisfy (or trip) a check. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^(?:\s*)(?:\/\/|\/\*|\*)/.test(line))
    .join('\n');
}

const SEAM_CODE = codeOnly(SEAM_SOURCE);

function importsOf(source: string): string[] {
  return [...codeOnly(source).matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]!);
}

describe('billing provider seam — the boundary only', () => {
  it('declares every operation a later Paystack PR must implement', () => {
    const provider = createUnimplementedBillingProvider();
    for (const operation of BILLING_PROVIDER_OPERATIONS) {
      assert.equal(typeof (provider as unknown as Record<string, unknown>)[operation], 'function', `${operation} exists on the seam`);
    }
    assert.equal(provider.id, 'paystack');
    assert.equal(provider.id, BILLING_PROVIDER);
    assert.equal(provider.implemented, false, 'PR2 implements nothing');
    assert.equal(provider.live, false, 'billing is never a live path');
  });

  it('fails closed on every operation: nothing is implemented, nothing is called', async () => {
    const provider = createUnimplementedBillingProvider();
    const calls: Array<[BillingProviderOperation, () => Promise<unknown>]> = [
      ['findCustomer', () => provider.findCustomer({ provider: 'paystack', userId: USER_ID, email: null })],
      ['createCustomer', () => provider.createCustomer({ provider: 'paystack', userId: USER_ID, email: 'trader@example.com', idempotencyKey: KEY, requestedAt: NOW })],
      ['initializeCheckout', () => provider.initializeCheckout({ provider: 'paystack', userId: USER_ID, plan: { cataloguePlan: 'pro', interval: 'monthly' }, reference: 'ref_1', idempotencyKey: KEY, callbackUrl: 'https://app.example.test/billing/return', requestedAt: NOW })],
      ['findSubscription', () => provider.findSubscription({ provider: 'paystack', userId: USER_ID, providerSubscriptionId: null })],
      ['verifySubscription', () => provider.verifySubscription({ provider: 'paystack', userId: USER_ID, providerSubscriptionId: 'sub_1', providerReference: null, idempotencyKey: KEY, requestedAt: NOW })],
      ['synchronizeSubscription', () => provider.synchronizeSubscription({ provider: 'paystack', userId: USER_ID, subscriptionId: SUBSCRIPTION_ID, eventIdempotencyKeys: [], source: 'webhook', requestedAt: NOW })],
      ['cancelSubscription', () => provider.cancelSubscription({ provider: 'paystack', userId: USER_ID, providerSubscriptionId: 'sub_1', immediate: false, reason: 'user', idempotencyKey: KEY, requestedAt: NOW })],
      ['normalizeEvent', () => provider.normalizeEvent({ provider: 'paystack', payload: { event: 'charge.success' }, providerEventId: 'evt_1', receivedAt: NOW })],
    ];
    assert.deepEqual(
      calls.map(([operation]) => operation).sort(),
      [...BILLING_PROVIDER_OPERATIONS].sort(),
      'the fail-closed placeholder covers exactly the declared operations',
    );
    for (const [operation, call] of calls) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof BillingProviderNotImplementedError, `${operation} rejects with the seam error`);
        assert.equal(isBillingProviderNotImplemented(error), true);
        assert.equal(error.code, 'billing_provider_not_implemented');
        assert.equal(error.provider, 'paystack');
        assert.equal(error.operation, operation);
        assert.match(error.message, /No Paystack API integration exists yet/, `${operation}: the error tells the truth`);
        assert.match(error.message, /no HTTP call/i, `${operation}: the error states there is no HTTP call`);
        return true;
      }, `${operation} must not be implemented in PR2`);
    }
  });

  it('describes itself without any credential material', () => {
    const description = createUnimplementedBillingProvider().describe();
    assert.equal(description.implemented, false);
    assert.equal(description.live, false);
    assert.equal(description.integration, 'none');
    assert.equal(description.catalogueVersion, BILLING_CATALOGUE.version);
    assert.equal(description.currency, 'USD');
    const rendered = JSON.stringify(description).toLowerCase();
    for (const forbidden of ['secret', 'key', 'token', 'password', 'authorization', 'http']) {
      assert.ok(!rendered.includes(forbidden), `describe() never mentions "${forbidden}"`);
    }
  });

  it('registers nothing by default and refuses a duplicate or live provider', () => {
    const registry = createBillingProviderRegistry();
    assert.ok(registry instanceof BillingProviderRegistry);
    assert.equal(registry.size, 0, 'no billing provider is registered in PR2');
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.get('paystack'), undefined, 'resolving paystack finds nothing');
    assert.deepEqual(registry.implementedProviders(), []);

    registry.register(createUnimplementedBillingProvider());
    assert.equal(registry.size, 1);
    assert.deepEqual(registry.list(), [{ id: 'paystack', name: 'paystack-unimplemented', implemented: false, live: false }]);
    assert.deepEqual(registry.implementedProviders(), [], 'a placeholder is not an implementation');
    assert.throws(
      () => registry.register(createUnimplementedBillingProvider()),
      /already registered/,
      'a provider cannot be registered twice',
    );

    // `live` is false by type; the registry also refuses it at runtime.
    const claiming = { ...createUnimplementedBillingProvider(), live: true } as unknown as BillingProvider;
    assert.throws(
      () => createBillingProviderRegistry().register(claiming),
      /cannot be registered as live/,
      'billing can never be wired as a live path',
    );
  });

  it('performs no I/O: the seam imports no transport and names no endpoint or credential', () => {
    assert.deepEqual(
      [...new Set(importsOf(SEAM_SOURCE))].sort(),
      ['./catalogue.js', '@veltrixeye/contracts', 'node:crypto', 'zod'],
      'the seam imports hashing, validation, contracts and the catalogue authority only',
    );
    for (const forbidden of [
      /fetch\s*\(/,
      /\bhttps?:\/\//i,
      /XMLHttpRequest/,
      /\b(?:axios|undici|node-fetch|superagent|ky)\b/i,
      /\bgot\s*\(/,
      /\bnode:(?:http|https|net|tls|dgram)\b/,
      /WebSocket/,
      /paystack\.co/i,
      /PAYSTACK_[A-Z_]+/,
      /\bapiKey\b/,
      /\bsecretKey\b/,
      /\bauthorizationHeader\b/i,
      /\bbearer\s/i,
      /x-paystack-signature/i,
      /process\.env/,
      /\bnew\s+WebSocket\b/,
    ]) {
      assert.doesNotMatch(SEAM_CODE, forbidden, `the seam contains no transport/credential material (${forbidden})`);
    }
    // The only thing the seam says about HTTP is that it makes none.
    assert.match(SEAM_CODE, /no HTTP call/, 'the seam states plainly that it makes no HTTP call');
  });

  it('duplicates no price, plan limit or commercial definition', () => {
    for (const price of ['1500', '15000', '3900', '39000', '9900', '99000', '$15', '$39', '$99']) {
      assert.ok(!SEAM_CODE.includes(price), `the seam does not restate the catalogue price ${price}`);
    }
    // Every amount the seam can produce is the catalogue's own.
    for (const plan of COMMERCIAL_PLANS) {
      for (const interval of ['monthly', 'annual'] as const) {
        const identity = seamPlanIdentity(plan, interval);
        assert.equal(seamAmountMinor(identity), commercialPlanPrice(plan, interval).amountMinor);
        assert.equal(seamAmountMinor(identity), cataloguePriceMinor(plan, interval));
        assert.equal(seamCataloguePriceMinor(plan, interval), cataloguePriceMinor(plan, interval));
        assert.equal(identity.internalPlan, internalPlanForCommercialPlan(plan));
        assert.deepEqual(billingPlanIdentity(plan, interval), identity);
      }
    }
    assert.equal(SERVER_BILLING_CATALOGUE, BILLING_CATALOGUE, 'the seam resolves the single authoritative catalogue');
    assert.equal(SERVER_BILLING_CATALOGUE.provider, BILLING_PROVIDER);
    assert.deepEqual(unmappedCommercialPlans(), ['starter'], 'Starter is still not sellable');
  });
});

describe('billing provider seam — request/result contracts', () => {
  it('validates canonical seam requests', () => {
    assert.equal(billingCustomerQuerySchema.safeParse({ provider: 'paystack', userId: USER_ID, email: null }).success, true);
    assert.equal(
      billingCustomerCreateRequestSchema.safeParse({ provider: 'paystack', userId: USER_ID, email: 'trader@example.com', idempotencyKey: KEY, requestedAt: NOW }).success,
      true,
    );
    assert.equal(billingSubscriptionQuerySchema.safeParse({ provider: 'paystack', userId: USER_ID, providerSubscriptionId: null }).success, true);
    assert.equal(
      billingSubscriptionVerifyRequestSchema.safeParse({ provider: 'paystack', userId: USER_ID, providerSubscriptionId: 'sub_1', providerReference: null, idempotencyKey: KEY, requestedAt: NOW }).success,
      true,
    );
    assert.equal(
      billingSubscriptionSyncRequestSchema.safeParse({ provider: 'paystack', userId: USER_ID, subscriptionId: SUBSCRIPTION_ID, eventIdempotencyKeys: [KEY], source: 'webhook', requestedAt: NOW }).success,
      true,
    );
    assert.equal(
      billingSubscriptionCancelRequestSchema.safeParse({ provider: 'paystack', userId: USER_ID, providerSubscriptionId: 'sub_1', immediate: false, reason: 'user', idempotencyKey: KEY, requestedAt: NOW }).success,
      true,
    );
    assert.equal(
      billingProviderRawEventSchema.safeParse({ provider: 'paystack', payload: { event: 'charge.success' }, providerEventId: 'evt_1', receivedAt: NOW }).success,
      true,
    );
  });

  it('rejects provider detail, credentials and stated amounts at the boundary', () => {
    const checkout = {
      provider: 'paystack',
      userId: USER_ID,
      plan: { cataloguePlan: 'pro', interval: 'monthly' },
      reference: 'ref_1',
      idempotencyKey: KEY,
      callbackUrl: 'https://app.example.test/billing/return',
      requestedAt: NOW,
    };
    assert.equal(billingCheckoutRequestSchema.safeParse(checkout).success, true);
    // A caller cannot state a price: the adapter resolves it from the catalogue.
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, amountMinor: 3900 }).success, false);
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, amount: 39 }).success, false);
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, provider: 'stripe' }).success, false);
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, plan: { cataloguePlan: 'starter', interval: 'weekly' } }).success, false);
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, idempotencyKey: 'key-1' }).success, false);
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, callbackUrl: 'not-a-url' }).success, false);
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, secretKey: 'sk_test_1' }).success, false);
    assert.equal(billingCheckoutRequestSchema.safeParse({ ...checkout, authorizationHeader: 'Bearer x' }).success, false);

    // A checkout session reports the catalogue amount and needs a URL only when initialized.
    const session = {
      provider: 'paystack',
      status: 'initialized',
      reference: 'ref_1',
      providerReference: 'paystack_ref_1',
      authorizationUrl: 'https://checkout.example.test/pay/1',
      amountMinor: 3900,
      currency: 'USD',
      idempotencyKey: KEY,
      initializedAt: NOW,
    };
    assert.equal(billingCheckoutSessionSchema.safeParse(session).success, true);
    assert.equal(billingCheckoutSessionSchema.safeParse({ ...session, status: 'unavailable' }).success, false, 'no URL unless initialized');
    assert.equal(billingCheckoutSessionSchema.safeParse({ ...session, authorizationUrl: null }).success, false, 'initialized needs a URL');
    assert.equal(billingCheckoutSessionSchema.safeParse({ ...session, amountMinor: 39.9 }).success, false, 'money is integer minor units');
    assert.equal(billingCheckoutSessionSchema.safeParse({ ...session, currency: 'NGN' }).success, false);

    // Customer creation requires a normalized email and an idempotency key.
    assert.equal(
      billingCustomerCreateRequestSchema.safeParse({ provider: 'paystack', userId: USER_ID, email: 'Trader@Example.com', idempotencyKey: KEY, requestedAt: NOW }).success,
      false,
    );
    assert.equal(
      billingCustomerCreateRequestSchema.safeParse({ provider: 'paystack', userId: USER_ID, email: 'trader@example.com', requestedAt: NOW }).success,
      false,
    );
    // Synchronization sources are the canonical ones; a raw provider field is not.
    assert.equal(
      billingSubscriptionSyncRequestSchema.safeParse({ provider: 'paystack', userId: USER_ID, subscriptionId: null, eventIdempotencyKeys: [], source: 'carrier-pigeon', requestedAt: NOW }).success,
      false,
    );
    assert.equal(
      billingProviderRawEventSchema.safeParse({ provider: 'paystack', payload: {}, receivedAt: NOW, signature: 'sha512=abc' }).success,
      false,
      'signature handling is not part of the PR2 seam',
    );
  });

  it('re-validates a normalized event before it may cross back over the seam', () => {
    const event = {
      identity: { provider: 'paystack', providerEventId: 'evt_1', eventType: 'payment.succeeded', occurredAt: NOW, payloadHash: HASH, idempotencyKey: KEY, receivedAt: LATER },
      category: 'payment',
      subject: { userId: USER_ID, subscriptionId: SUBSCRIPTION_ID, billingCustomerId: null, providerCustomerId: 'cus_1', providerSubscriptionId: null, providerReference: 'ref_1' },
      data: { cataloguePlan: null, interval: null, state: null, currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: null, cancellationReason: null, amountMinor: 3900, currency: 'USD', failureReason: null },
      grantsExecution: false,
    };
    assert.deepEqual(parseNormalizedBillingEvent(event), event);
    assert.throws(() => parseNormalizedBillingEvent({ ...event, grantsExecution: true }), /grantsExecution/);
    assert.throws(() => parseNormalizedBillingEvent({ ...event, rawBody: '{"event":"charge.success"}' }));
    assert.throws(() => parseNormalizedBillingEvent({ ...event, category: 'subscription' }));
  });
});

describe('billing provider seam — deterministic idempotency hashing', () => {
  const input = { provider: 'paystack' as const, providerEventId: 'evt_1', eventType: 'payment.succeeded' as const, occurredAt: NOW, payloadHash: HASH };

  it('derives a stable SHA-256 idempotency key', () => {
    const key = billingEventIdempotencyKey(input);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(sha256HexSchema.safeParse(key).success, true);
    assert.equal(billingEventIdempotencyKey(input), key, 'the same event always produces the same key');
    assert.equal(
      billingEventIdempotencyKey({ payloadHash: HASH, occurredAt: NOW, eventType: 'payment.succeeded', providerEventId: 'evt_1', provider: 'paystack' }),
      key,
      'field order is irrelevant',
    );
    for (const change of [
      { providerEventId: 'evt_2' },
      { eventType: 'payment.failed' as const },
      { occurredAt: LATER },
      { payloadHash: 'd'.repeat(64) },
      { providerEventId: null },
      { occurredAt: null },
    ]) {
      assert.notEqual(billingEventIdempotencyKey({ ...input, ...change }), key, `${JSON.stringify(change)} changes the key`);
    }
  });

  it('hashes payloads canonically and never leaks their content', () => {
    const payload = { event: 'charge.success', data: { id: 7, amount: 3900, customer: { email: 'trader@example.com' } } };
    const hash = billingEventPayloadHash(payload);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(billingEventPayloadHash(payload), hash);
    // Key order does not matter; values do.
    assert.equal(
      billingEventPayloadHash({ data: { customer: { email: 'trader@example.com' }, amount: 3900, id: 7 }, event: 'charge.success' }),
      hash,
    );
    assert.notEqual(billingEventPayloadHash({ ...payload, event: 'charge.failed' }), hash);
    assert.ok(!hash.includes('charge.success'), 'the hash is not the payload');
    assert.equal(billingEventPayloadHash(undefined), billingEventPayloadHash(undefined));
    assert.notEqual(billingEventPayloadHash({ a: 1 }), billingEventPayloadHash({ a: '1' }), 'types are preserved');

    const canonical = canonicalizeBillingPayload({ b: 1, a: [3, { z: 1, y: 2 }], u: undefined });
    assert.equal(canonical, '{"a":[3,{"y":2,"z":1}],"b":1}', 'keys are sorted, arrays keep order, undefined is dropped');
    assert.equal(canonicalizeBillingPayload(new Date(NOW)), `"${NOW}"`, 'dates canonicalize to ISO-8601');
    assert.equal(canonicalizeBillingPayload({ nested: { when: new Date(NOW) } }), `{"nested":{"when":"${NOW}"}}`);
  });
});

describe('billing PR2 — entitlement safety', () => {
  it('leaves canAccessAutomation false for every plan and status', () => {
    for (const plan of USER_PLANS) {
      for (const status of ['active', 'trialing', 'past_due', 'canceled', 'expired', 'anything-else']) {
        const entitlements = getEntitlements(plan as UserPlan, status);
        assert.equal(entitlements.canAccessAutomation, false, `${plan}/${status}: automation stays off`);
      }
    }
    assert.deepEqual(
      USER_PLANS.map((plan) => getEntitlements(plan as UserPlan, 'active').maxStrategies),
      [100, 500, 1000],
      'the enforced limits are unchanged',
    );
    // A provider-backed Elite subscription is still just `premium` to the enforcer.
    const elite = getEntitlements('premium', 'active');
    assert.equal(elite.canAccessAutomation, false);
    assert.equal(elite.canAccessScanner, true);
    const cancelledElite = getEntitlements('premium', 'canceled');
    assert.equal(cancelledElite.maxStrategies, 100, 'a cancelled subscription falls back to free');
    assert.equal(cancelledElite.canAccessAutomation, false);
  });

  it('keeps entitlement enforcement separate from the seam and the catalogue', () => {
    assert.deepEqual(
      importsOf(ENTITLEMENTS_SOURCE),
      ['@veltrixeye/contracts'],
      'entitlements read the internal plan vocabulary only',
    );
    assert.doesNotMatch(codeOnly(ENTITLEMENTS_SOURCE), /catalogue|provider|paystack|commercial/i, 'no catalogue or provider input reaches a limit');
    assert.doesNotMatch(SEAM_CODE, /getEntitlements|canAccessAutomation|FREE_ENTITLEMENTS/, 'the seam never touches entitlement enforcement');
    assert.ok(!SEAM_CODE.includes('entitlements.js'), 'the seam does not import the entitlement module');
  });

  it('permits only PR-C checkout, the PR #7 sync route and the Step 5.2 webhook receiver', () => {
    const routesDir = path.join(REPO_ROOT, 'apps', 'api', 'src', 'routes');
    const billingRoute = readFileSync(path.join(routesDir, 'billing.ts'), 'utf8');
    assert.match(billingRoute, /app\.get\('\/api\/billing\/me'/, 'GET /api/billing/me still exists');
    const writes = [...billingRoute.matchAll(/app\.(post|put|patch|delete)\s*\(\s*'([^']+)'/g)]
      .map((match) => [match[1], match[2]]);
    assert.deepEqual(
      writes,
      [['post', '/api/billing/checkout'], ['post', '/api/billing/sync']],
      'only PR-C checkout and the Later-billing-PR #7 sync route may write inline',
    );
    assert.doesNotMatch(billingRoute, /portal/i, 'the portal remains prohibited');
    // Billing Step 5.2: the webhook receiver is wired through exactly one
    // sanctioned composition call — never as a second inline billing route.
    assert.match(billingRoute, /registerBillingWebhookRoutes\(app, ctx, config\)/);

    const withBillingPath = readdirSync(routesDir).filter((file) => /\/api\/billing\//.test(readFileSync(path.join(routesDir, file), 'utf8')));
    assert.deepEqual(withBillingPath, ['billing.ts'], 'no other route file exposes a billing path');

    // The receiver route itself lives in the ONE place Step 5.2 allows, and
    // the route it registers is the documented webhook path — nothing else.
    const receiver = readFileSync(path.join(REPO_ROOT, 'apps', 'api', 'src', 'billing-webhook.ts'), 'utf8');
    assert.match(receiver, /'\/api\/billing\/webhook'/);
    assert.doesNotMatch(receiver, /\/api\/billing\/(portal|checkout|customer|callback)'/);
  });
});
