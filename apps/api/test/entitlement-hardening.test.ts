/**
 * READ-SIDE ENTITLEMENT HARDENING — the HTTP surface.
 *
 * Companion to `packages/core/test/entitlement-hardening.test.ts`, which pins
 * the resolver and every service reader. This file pins what a client actually
 * sees and what a checkout actually buys:
 *
 *  - `GET /api/billing/me` reports a provider-backed pending checkout as
 *    UNCONFIRMED and free, while a historical (`provider IS NULL`) paid
 *    subscription keeps every paid entitlement it already had;
 *  - a successful checkout initialization still creates exactly the same
 *    pricing lock as before — and buys nothing;
 *  - retries, provider failures, an unprovisioned customer and every
 *    `provider_state` value leave the entitlement at free: no state this build
 *    can observe is treated as payment confirmation;
 *  - the scanner health / runs / trigger gates and the scanner eligibility
 *    query refuse provider-backed owners;
 *  - strategy, setup, alert and backtest limits are the FREE limits for a
 *    provider-backed row and the paid limits for a historical one;
 *  - `canAccessAutomation` stays false for everyone.
 *
 * Nothing here adds a webhook, a verification call, a portal, a checkout
 * button or a payment confirmation, and nothing here changes pricing.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  BILLING_LIFECYCLE_STATES,
  TIMEFRAMES,
  billingStateDtoSchema,
  type Candle,
  type MarketDataProvider,
  type NormalizedInstrument,
  type RealtimeCandleStream,
  type RealtimeSubscription,
} from '@veltrixeye/contracts';
import { CandleStore, getEntitlements, verifyPricingSnapshot } from '@veltrixeye/core';
import { createPaystackProvider } from '@veltrixeye/provider-paystack';
import { buildApp, createAppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { paystackCustomerDirectory, paystackPlanDirectory } from '../src/billing-composition.js';
import {
  AS_OF, PRO_MONTHLY, activateSeededSubscription, deriveSnapshot, insertEpoch, insertUser,
  retireActiveEpochs, seedCommercialSubscription, seedPaymentEvidence, startBillingTestDb,
} from '../../../packages/core/test/helpers/billing-checkout.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let db: Awaited<ReturnType<typeof startBillingTestDb>>;
let ctx: ReturnType<typeof createAppContext>;
let app: Awaited<ReturnType<typeof buildApp>>;
let store: CandleStore;
let calls: Record<string, unknown>[];
/** Transport faults are injected per test; the adapter itself is never touched. */
let providerHttp: 'ok' | 'unavailable' = 'ok';

const HOUR = 3_600_000;
const DETECT_AS_OF = 1_700_000_000_000;
const SYMBOL = 'EURUSD';
const FREE_LIMITS = {
  maxStrategies: 100,
  maxBacktestsPerMonth: 100,
  maxAlertsPerMonth: 1000,
  maxSavedSetups: 1000,
  canAccessScanner: false,
  canAccessAdvancedStrategies: false,
  canAccessAdvancedAlerts: false,
  canAccessAutomation: false,
};
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];
const PROVIDER_STATES: (string | null)[] = [null, ...BILLING_LIFECYCLE_STATES];

const uniqueEmail = () => `entitlement_${randomUUID()}@example.test`;
const freshIp = () =>
  `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

const config = (overrides: Record<string, string> = {}): AppConfig => loadConfig({
  NODE_ENV: 'test', DATABASE_URL: db?.dbUrl ?? 'postgres://test:test@localhost/test',
  LOG_LEVEL: 'silent', COOKIE_SECURE: 'never', HOST: '127.0.0.1', PORT: '4994',
  DATABASE_SSL_MODE: 'disable', SESSION_COOKIE_NAME: 've_session',
  PUBLIC_APPLICATION_ORIGIN: 'https://app.example.test', ...overrides,
} as NodeJS.ProcessEnv);

/** Candles only; no realtime, no sessions — the scanner just needs a provider. */
class FixtureMarketDataProvider implements MarketDataProvider {
  readonly id = 'twelve-data';
  readonly name = 'Twelve Data (Fixture)';
  readonly capabilities = {
    historical: true, realtime: false, timeframes: TIMEFRAMES, maxLookbackDays: 2190,
  };

  async getSymbols() { return []; }

  async getHistoricalCandles(): Promise<Candle[]> {
    return Array.from({ length: 100 }, (_, i) => ({
      time: Date.now() - (100 - i) * 60_000,
      open: 100 + i * 0.1, high: 105 + i * 0.1, low: 95 + i * 0.1, close: 102 + i * 0.1,
      volume: 1000, state: 'closed' as const,
    }));
  }

  subscribeRealtime(_sub: RealtimeSubscription): RealtimeCandleStream {
    return {
      [Symbol.asyncIterator]: async function* () {},
      close: async () => {},
    } as unknown as RealtimeCandleStream;
  }

  async getTradingSessions() { return []; }

  async getMarketStatus(instrument: NormalizedInstrument) {
    return { instrument, state: 'open' as const };
  }
}

before(async () => {
  db = await startBillingTestDb(5494);
  const cfg = config();
  ctx = createAppContext(db.pool, cfg);
  ctx.billingProviders.register(createPaystackProvider({
    secretKey: 'sk_test_0123456789abcdef0123456789abcdef01234567', timeoutMs: 1000,
    customers: paystackCustomerDirectory(db.pool),
    plans: paystackPlanDirectory(db.pool),
    clock: () => AS_OF,
    fetchFn: async (_url, init) => {
      const body = JSON.parse((init?.body ?? '{}') as string) as Record<string, unknown>;
      if (providerHttp === 'unavailable') return { status: 503, json: async () => ({ status: false, message: 'Unavailable' }) };
      calls.push(body);
      return {
        status: 200,
        json: async () => ({
          status: true, message: 'Initialized',
          data: {
            authorization_url: 'https://checkout.example.test/authorize',
            access_code: 'test-code', reference: body.reference,
          },
        }),
      };
    },
  }));
  ctx.providerRegistry.register(new FixtureMarketDataProvider());
  app = await buildApp(cfg, ctx);
  await app.ready();
  store = new CandleStore(db.pool);
}, { timeout: 180_000 });

after(async () => { await app?.close(); await db?.stop(); });
beforeEach(async () => { calls = []; providerHttp = 'ok'; await retireActiveEpochs(db.pool); });

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A normally registered user. Model C: registration is identity only, so the
 * user has NO subscription row; the missing row IS the free fallback state.
 */
async function register(): Promise<{ cookie: string; userId: string }> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register', headers: { 'x-forwarded-for': freshIp() },
    payload: { email: uniqueEmail(), password: 'correct-horse-42', name: 'Entitlement Trader' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { cookie: cookieFrom(res), userId: res.json().user.id as string };
}

function cookieFrom(res: { headers: Record<string, string | number | string[] | undefined> }): string {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  for (const candidate of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const [pair] = String(candidate ?? '').split(';');
    const eq = pair?.indexOf('=') ?? -1;
    if (pair && eq > 0 && pair.slice(eq + 1).trim().length > 0) return pair;
  }
  return '';
}

/** A user with NO subscription row (the state a real checkout starts from). */
async function checkoutUser(customer = true): Promise<{ cookie: string; userId: string; email: string }> {
  const user = await insertUser(db.pool, customer);
  const session = await ctx.sessions.create(user.id, {});
  return { userId: user.id, email: user.email, cookie: `ve_session=${session.token}` };
}

/**
 * Give the user a historical, non-commercial subscription row (`provider IS
 * NULL`, `locked_pricing_snapshot_id NULL`). Since Model C registration creates
 * no row, the fixture seeds it; the row shape itself is unchanged and is what
 * `resolveEntitlements(plan, status, null)` has always resolved.
 */
async function makeHistorical(userId: string, plan: string, status: string): Promise<void> {
  await db.pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, provider, provider_state)
     VALUES ($1, $2, $3, NULL, NULL)
     ON CONFLICT (user_id) DO UPDATE
       SET plan = EXCLUDED.plan, status = EXCLUDED.status,
           provider = NULL, provider_state = NULL`,
    [userId, plan, status],
  );
}

/** Rewrite/seed an existing subscription row as a provider-backed checkout row. */
async function makeProviderBacked(
  userId: string, plan: string, status: string, providerState: string | null,
  options: { activated?: boolean } = {},
): Promise<void> {
  if (options.activated === true) {
    // The paid case is not a row shape: it is the whole Step-8 chain — a locked
    // commercial subscription, its verified sandbox evidence and the immutable
    // activation FACT. Only the fact authorizes the paid entitlement, so it is
    // seeded through the same coherent helpers the core suites use.
    assert.equal(status, 'active', 'a seeded activation is written on an active row');
    const commercial = await seedCommercialSubscription(db.pool, userId, {
      cataloguePlan: plan === 'premium' ? 'elite' : 'pro',
      interval: 'monthly',
      providerState,
    });
    const evidence = await seedPaymentEvidence(db.pool, userId, commercial);
    await activateSeededSubscription(db.pool, userId, commercial, evidence);
    return;
  }
  await db.pool.query(
    `INSERT INTO subscriptions (user_id, plan, status, provider, provider_state)
     VALUES ($1, $2, $3, 'paystack', $4)
     ON CONFLICT (user_id) DO UPDATE
       SET plan = EXCLUDED.plan, status = EXCLUDED.status,
           provider = 'paystack', provider_state = EXCLUDED.provider_state`,
    [userId, plan, status, providerState],
  );
}

async function billingMe(cookie: string): Promise<any> {
  const res = await app.inject({
    method: 'GET', url: '/api/billing/me', headers: { cookie, 'x-forwarded-for': freshIp() },
  });
  assert.equal(res.statusCode, 200, res.body);
  return billingStateDtoSchema.parse(res.json());
}

async function createPublishedVersion(cookie: string, config: any): Promise<{ strategyId: string; versionId: string }> {
  const created = await app.inject({
    method: 'POST', url: '/api/strategies', headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { name: `Entitlement strategy ${randomUUID().slice(0, 8)}`, version: config },
  });
  assert.equal(created.statusCode, 201, created.body);
  const strategy = created.json().strategy;
  const published = await app.inject({
    method: 'POST', url: `/api/strategies/${strategy.id}/versions/${strategy.versions[0].id}/publish`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
  });
  assert.equal(published.statusCode, 200, published.body);
  return { strategyId: strategy.id, versionId: strategy.versions[0].id };
}

/** A version whose required condition passes on the seeded bullish candles. */
function engulfConfig(symbol: string) {
  return {
    timeframes: { htf_bias: '1h', setup: '1h', entry: '1h' },
    marketScope: { mode: 'instruments', instruments: [{ assetClass: 'forex', symbol }] },
    sessionFilters: [],
    risk: {
      minRr: 2, stopLossMethod: 'fixed', stopLossBuffer: 1, stopLossBufferUnit: 'pips',
      takeProfitMethod: 'rr', tp1Rr: 1, tp2Rr: 2, tp3Rr: 3, minQualityScore: 0,
    },
    filters: [],
    ruleGroups: [{
      name: 'entry', logic: 'AND', position: 0,
      conditions: [{
        conditionType: 'engulfing_candle', classification: 'required', timeframeRole: 'setup',
        params: { direction: 'bullish' }, position: 0,
      }],
    }],
  };
}

async function seedBullishCandles(symbol: string, anchor: number): Promise<void> {
  const instrument = await store.resolveInstrument('forex', symbol);
  assert.ok(instrument, `${symbol} is part of the platform universe`);
  const shapes: [number, number, number, number][] = [
    ...Array.from({ length: 16 }, () => [100, 100.5, 99.5, 100] as [number, number, number, number]),
    [101, 101.2, 100, 100.2],
    [100, 101.5, 99.9, 101.3],
  ];
  await store.upsertCandles({
    instrumentId: instrument.id, timeframe: '1h', providerSlug: 'test-fixture',
    candles: shapes.map(([open, high, low, close], index) => ({
      time: anchor - (shapes.length - index) * HOUR, open, high, low, close, volume: null,
    })),
  });
}

async function detect(cookie: string, strategyId: string, versionId: string, asOf: number) {
  return app.inject({
    method: 'POST', url: `/api/strategies/${strategyId}/versions/${versionId}/detect`,
    headers: { cookie, 'x-forwarded-for': freshIp() },
    payload: { instrument: { assetClass: 'forex', symbol: SYMBOL }, direction: 'long', asOf },
  });
}

/** Bulk setups (and optionally one alert row each) straight into the tables. */
async function seedSetups(args: {
  userId: string; strategyId: string; versionId: string; count: number; withAlerts: boolean;
}): Promise<void> {
  const instrument = await store.resolveInstrument('forex', SYMBOL);
  assert.ok(instrument);
  await db.pool.query(
    `WITH seeded AS (
       INSERT INTO setups (strategy_version_id, instrument_id, state, direction, detected_at, as_of_ms)
       SELECT $2::uuid, $3::uuid, 'developing', 'long', now(), 1000000 + i
       FROM generate_series(1, $4::int) AS i
       RETURNING id
     )
     INSERT INTO alerts (user_id, setup_id, strategy_id, strategy_version_id, instrument_id,
                         direction, trigger_state, quality_score, min_quality_score, title, body)
     SELECT $1::uuid, seeded.id, $5::uuid, $2::uuid, $3::uuid, 'long', 'confirmed', 0, 0,
            'limit fixture', '{}'
     FROM seeded
     WHERE $6::boolean`,
    [args.userId, args.versionId, instrument.id, args.count, args.strategyId, args.withAlerts],
  );
}

/* -------------------------------------------------------------------------- */
/* 1. GET /api/billing/me                                                     */
/* -------------------------------------------------------------------------- */

describe('GET /api/billing/me — historical subscriptions are preserved', () => {
  test('a fresh registration is free, has no subscription row and publishes no provider at all', async () => {
    const { cookie, userId } = await register();
    // Model C: registration creates identity + session only.
    assert.equal(
      (await db.pool.query('SELECT count(*)::int AS c FROM subscriptions WHERE user_id=$1', [userId])).rows[0]!.c,
      0, 'registration provisions no billing subscription',
    );
    const state = await billingMe(cookie);
    assert.deepEqual(state.entitlements, FREE_LIMITS);
    assert.deepEqual(state.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
    assert.equal(state.subscription.plan, 'free');
    assert.equal(state.subscription.status, 'active');
  });

  test('a historical paid subscription keeps every paid entitlement', async () => {
    for (const plan of ['pro', 'premium']) {
      for (const status of LIVE_STATUSES) {
        const { cookie, userId } = await register();
        await makeHistorical(userId, plan, status);
        const state = await billingMe(cookie);
        assert.equal(state.subscription.plan, plan);
        assert.equal(state.subscription.status, status);
        assert.equal(state.entitlements.canAccessScanner, true, `${plan}/${status} keeps the scanner`);
        assert.equal(state.entitlements.canAccessAdvancedStrategies, true);
        assert.equal(state.entitlements.canAccessAdvancedAlerts, true);
        assert.equal(
          state.entitlements.maxStrategies, plan === 'pro' ? 500 : 1000, `${plan}/${status}`,
        );
        assert.equal(state.entitlements.canAccessAutomation, false, 'automation stays off for everyone');
        assert.deepEqual(state.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
      }
    }
  });

  test('a historical lapsed subscription still falls back to free', async () => {
    for (const status of ['canceled', 'expired']) {
      const { cookie, userId } = await register();
      await makeHistorical(userId, 'premium', status);
      const state = await billingMe(cookie);
      assert.deepEqual(state.entitlements, FREE_LIMITS, status);
    }
  });
});

describe('GET /api/billing/me — provider-backed rows are never a confirmed subscription', () => {
  test('a pending paystack checkout is reported as unconfirmed and free', async () => {
    const { cookie, userId } = await register();
    await makeProviderBacked(userId, 'pro', 'active', 'pending');
    const state = await billingMe(cookie);
    assert.deepEqual(state.entitlements, FREE_LIMITS);
    assert.equal(state.entitlements.canAccessScanner, false);
    // The stored authoritative values are reported as they are, not rewritten…
    assert.equal(state.subscription.plan, 'pro');
    assert.equal(state.subscription.status, 'active');
    // …and the provider state is published as display information only.
    assert.deepEqual(state.providerStatus, {
      provider: 'paystack', providerState: 'pending', paymentConfirmed: false,
    });
  });

  test('no provider state escalates the entitlement', async () => {
    for (const plan of ['pro', 'premium']) {
      for (const providerState of PROVIDER_STATES) {
        const { cookie, userId } = await register();
        await makeProviderBacked(userId, plan, 'active', providerState);
        const state = await billingMe(cookie);
        assert.deepEqual(
          state.entitlements, FREE_LIMITS,
          `${plan}/provider_state=${providerState ?? 'NULL'} must stay free`,
        );
        assert.equal(state.entitlements.canAccessScanner, false);
        assert.equal(state.providerStatus.paymentConfirmed, false);
        assert.equal(state.providerStatus.providerState, providerState);
      }
    }
  });

  test('provider_state=active/trialing is display state, not payment confirmation', async () => {
    for (const providerState of ['active', 'trialing']) {
      const { cookie, userId } = await register();
      await makeProviderBacked(userId, 'premium', 'active', providerState);
      const state = await billingMe(cookie);
      assert.equal(state.providerStatus.providerState, providerState);
      assert.equal(state.providerStatus.paymentConfirmed, false);
      assert.deepEqual(state.entitlements, FREE_LIMITS);
      assert.notDeepEqual(state.entitlements, {
        ...FREE_LIMITS, canAccessScanner: true, maxStrategies: 1000,
      });
    }
  });

  test('paymentConfirmed is a derived boolean, not a client-supplied claim', async () => {
    // The field is a real boolean on the DTO: `true` is REPRESENTABLE, because
    // an operator-authorized activation fact is a legitimate state. What the
    // contract refuses is anything that is not a boolean — a client can never
    // hand the read side a confirmation.
    const shape = (paymentConfirmed: unknown) => billingStateDtoSchema.safeParse({
      subscription: {
        id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', plan: 'pro', status: 'active',
        currentPeriodEnd: null, cancelAtPeriodEnd: false,
      },
      entitlements: FREE_LIMITS,
      providerStatus: { provider: 'paystack', providerState: 'active', paymentConfirmed },
    });
    assert.equal(shape(true).success, true, 'a confirmed payment is representable');
    assert.equal(shape(false).success, true);
    assert.equal(shape('yes').success, false, 'a non-boolean is refused');
    assert.equal(shape(null).success, false, 'an absent confirmation is refused');
    assert.equal(shape(1).success, false);
  });

  test('an activation fact is the only thing that confirms a payment', async () => {
    for (const [plan, providerState] of [
      ['pro', 'pending'], ['pro', 'active'], ['premium', 'pending'], ['premium', 'active'],
    ] as const) {
      const { cookie, userId } = await register();
      await makeProviderBacked(userId, plan, 'active', providerState, { activated: true });
      const state = await billingMe(cookie);
      assert.equal(
        state.providerStatus.paymentConfirmed, true,
        `${plan}/provider_state=${providerState} is confirmed by its activation fact`,
      );
      // The paid entitlement is the plan matrix, resolved through the same
      // resolver every other reader uses — never a provider state.
      assert.deepEqual(state.entitlements, getEntitlements(plan, 'active'));
      assert.equal(state.entitlements.canAccessScanner, true);
      assert.notDeepEqual(state.entitlements, FREE_LIMITS);
      // Activation grants capability, never execution.
      assert.equal(state.entitlements.canAccessAutomation, false);
      // The stored values are still reported as they are.
      assert.equal(state.subscription.plan, plan);
      assert.equal(state.providerStatus.provider, 'paystack');
      assert.equal(state.providerStatus.providerState, providerState);
    }
  });

  test('the same row without the fact stays unconfirmed and free', async () => {
    // The control for the case above: identical row shape, identical provider
    // state, no activation fact — and therefore nothing above the free tier.
    for (const [plan, providerState] of [
      ['pro', 'pending'], ['pro', 'active'], ['premium', 'active'],
    ] as const) {
      const { cookie, userId } = await register();
      await makeProviderBacked(userId, plan, 'active', providerState);
      const state = await billingMe(cookie);
      assert.equal(state.providerStatus.paymentConfirmed, false);
      assert.deepEqual(state.entitlements, FREE_LIMITS);
    }
  });

  test('no HTTP route can activate a subscription or read its facts', async () => {
    // Activation is an out-of-band, DB-connected operator action (the
    // `billing:activate` CLI). There is deliberately no route, no admin role
    // and no operator endpoint: a client can never authorize a paid
    // entitlement, and never read who did.
    const { cookie } = await register();
    const probes: Array<[string, string]> = [
      ['post', '/api/billing/activate'],
      ['post', '/api/billing/activations'],
      ['post', '/api/billing/subscription/activate'],
      ['post', '/api/billing/subscriptions/activate'],
      ['put', '/api/billing/activate'],
      ['patch', '/api/billing/me/paymentConfirmed'],
      ['get', '/api/billing/activations'],
      ['get', '/api/billing/activation'],
    ];
    for (const [method, url] of probes) {
      const res = await app.inject({
        method: method as 'post', url, headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: method === 'get' ? undefined : { operatorId: 'ops', reason: 'please' },
      });
      assert.equal(res.statusCode, 404, `${method.toUpperCase()} ${url} must not exist`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Checkout initialization                                                 */
/* -------------------------------------------------------------------------- */

describe('POST /api/billing/checkout — initialization buys nothing', () => {
  test('a successful initialization still creates the same pricing lock and grants nothing', async () => {
    const facts = await insertEpoch(db.pool);
    const user = await checkoutUser();
    const res = await app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: PRO_MONTHLY,
    });
    assert.equal(res.statusCode, 200, res.body);
    const session = res.json();
    assert.equal(session.authorizationUrl, 'https://checkout.example.test/authorize');
    // Pricing behaviour is untouched: the exact epoch snapshot, verified.
    // `computedAt` is the composition's own clock; every priced fact must match.
    const expectedPricing = deriveSnapshot(facts);
    assert.deepEqual(
      { ...session.pricing, computedAt: expectedPricing.computedAt }, expectedPricing,
    );
    assert.deepEqual(verifyPricingSnapshot(session.pricing), session.pricing);
    assert.equal(calls.length, 1);

    const row = await db.pool.query(
      `SELECT status, plan, provider, provider_state, locked_pricing_snapshot_id, state_version
       FROM subscriptions WHERE user_id = $1`, [user.userId],
    );
    assert.deepEqual(row.rows[0], {
      status: 'active', plan: 'pro', provider: 'paystack', provider_state: 'pending',
      locked_pricing_snapshot_id: row.rows[0]!.locked_pricing_snapshot_id, state_version: 1,
    });
    assert.ok(row.rows[0]!.locked_pricing_snapshot_id, 'the pricing lock is still created');

    // And the initialized checkout is worth exactly nothing.
    const state = await billingMe(user.cookie);
    assert.deepEqual(state.entitlements, FREE_LIMITS);
    assert.equal(state.entitlements.canAccessScanner, false);
    assert.deepEqual(state.providerStatus, {
      provider: 'paystack', providerState: 'pending', paymentConfirmed: false,
    });
    const scanner = await app.inject({
      method: 'POST', url: '/api/scanner/trigger', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: { force: true },
    });
    assert.equal(scanner.statusCode, 403, scanner.body);
  });

  test('a retry returns the same reference and still escalates nothing', async () => {
    await insertEpoch(db.pool);
    const user = await checkoutUser();
    const post = () => app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: PRO_MONTHLY,
    });
    const first = await post();
    assert.equal(first.statusCode, 200, first.body);
    const rowAfterFirst = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.userId]);
    const stateAfterFirst = await billingMe(user.cookie);

    const second = await post();
    assert.equal(second.statusCode, 200, second.body);
    assert.deepEqual(second.json(), first.json(), 'the reference and pricing are stable');
    assert.equal(second.json().reference, first.json().reference);

    const rowAfterRetry = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.userId]);
    assert.deepEqual(rowAfterRetry.rows, rowAfterFirst.rows, 'a retry mutates nothing');
    assert.deepEqual(await billingMe(user.cookie), stateAfterFirst, 'and escalates nothing');
    assert.deepEqual((await billingMe(user.cookie)).entitlements, FREE_LIMITS);
  });

  test('an operator-written provider state never escalates a locked checkout', async () => {
    await insertEpoch(db.pool);
    const user = await checkoutUser();
    const res = await app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: PRO_MONTHLY,
    });
    assert.equal(res.statusCode, 200, res.body);
    for (const providerState of PROVIDER_STATES) {
      await db.pool.query('UPDATE subscriptions SET provider_state = $2 WHERE user_id = $1', [user.userId, providerState]);
      const state = await billingMe(user.cookie);
      assert.deepEqual(state.entitlements, FREE_LIMITS, `provider_state=${providerState ?? 'NULL'}`);
      assert.equal(state.providerStatus.paymentConfirmed, false);
    }
  });
});

describe('POST /api/billing/checkout — refusals assume no payment', () => {
  test('an unregistered plan fails closed and creates no subscription at all', async () => {
    const user = await checkoutUser();
    // Elite/annual is never registered in this suite, so the epoch lookup
    // fails with `not_found` rather than `retired`.
    const res = await app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: { cataloguePlan: 'elite', interval: 'annual' },
    });
    assert.equal(res.statusCode, 502, res.body);
    assert.match(res.json().error.message, /plan_not_registered/);
    assert.equal(calls.length, 0);
    assert.equal(
      (await db.pool.query('SELECT count(*)::int AS c FROM subscriptions WHERE user_id=$1', [user.userId])).rows[0]!.c,
      0, 'no row was created',
    );
    const state = await billingMe(user.cookie);
    assert.deepEqual(state.entitlements, FREE_LIMITS);
    assert.deepEqual(state.providerStatus, { provider: null, providerState: null, paymentConfirmed: false });
  });

  test('a customer that was never provisioned keeps its durable lock and stays free', async () => {
    await insertEpoch(db.pool);
    const user = await checkoutUser(false);
    const res = await app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: PRO_MONTHLY,
    });
    assert.equal(res.statusCode, 502, res.body);
    assert.match(res.json().error.message, /customer_not_provisioned/);
    assert.equal(calls.length, 0, 'the provider is never called');
    const row = await db.pool.query(
      'SELECT status, plan, provider, provider_state, locked_pricing_snapshot_id FROM subscriptions WHERE user_id=$1',
      [user.userId],
    );
    assert.equal(row.rows[0]!.provider, 'paystack');
    assert.equal(row.rows[0]!.provider_state, 'pending');
    assert.ok(row.rows[0]!.locked_pricing_snapshot_id, 'the lock survives the refusal');
    const before = await billingMe(user.cookie);
    const retried = await app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: PRO_MONTHLY,
    });
    assert.equal(retried.statusCode, 502, retried.body);
    assert.deepEqual(await billingMe(user.cookie), before, 'a failed checkout changes no entitlement');
    assert.deepEqual(before.entitlements, FREE_LIMITS);
    assert.equal(before.providerStatus.paymentConfirmed, false);
  });

  test('a provider outage leaves the subscription unchanged and unconfirmed', async () => {
    await insertEpoch(db.pool);
    const user = await checkoutUser();
    providerHttp = 'unavailable';
    const res = await app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie: user.cookie, 'x-forwarded-for': freshIp() },
      payload: PRO_MONTHLY,
    });
    // The adapter reports the outage as an unusable session rather than an
    // authorization: either way nothing was initialized and nothing is paid.
    assert.ok([200, 502].includes(res.statusCode), res.body);
    if (res.statusCode === 200) {
      assert.equal(res.json().status, 'unavailable');
      assert.equal(res.json().authorizationUrl, null);
    }
    assert.equal(calls.length, 0, 'no successful initialization was recorded');
    const row = await db.pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [user.userId]);
    assert.equal(row.rows[0]!.provider_state, 'pending');
    assert.ok(row.rows[0]!.locked_pricing_snapshot_id);
    const state = await billingMe(user.cookie);
    assert.deepEqual(state.entitlements, FREE_LIMITS, 'an unavailable provider confirms nothing');
    assert.equal(state.providerStatus.paymentConfirmed, false);
  });

  test('an existing free NULL lock is still refused and still free', async () => {
    await insertEpoch(db.pool);
    const { cookie, userId } = await register();
    // Model C: the LEGACY row (free/active, NULL lock) is seeded explicitly —
    // registration no longer produces it and checkout must never upgrade it.
    await db.pool.query(
      `INSERT INTO subscriptions (user_id, plan, status) VALUES ($1, 'free', 'active')`,
      [userId],
    );
    const res = await app.inject({
      method: 'POST', url: '/api/billing/checkout', headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: PRO_MONTHLY,
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.match(res.json().error.message, /pricing_lock_required/);
    const row = await db.pool.query('SELECT plan, provider, provider_state, locked_pricing_snapshot_id FROM subscriptions WHERE user_id=$1', [userId]);
    assert.deepEqual(row.rows[0], {
      plan: 'free', provider: null, provider_state: null, locked_pricing_snapshot_id: null,
    });
    assert.deepEqual((await billingMe(cookie)).entitlements, FREE_LIMITS);
    assert.equal(calls.length, 0, 'the provider is never called for a legacy NULL-lock row');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Scanner                                                                 */
/* -------------------------------------------------------------------------- */

describe('scanner gates — a provider-backed checkout cannot reach the scanner', () => {
  test('health, runs and trigger all refuse a provider-backed pro row', async () => {
    for (const providerState of ['pending', 'active', null]) {
      const { cookie, userId } = await register();
      await makeProviderBacked(userId, 'pro', 'active', providerState);
      const health = await app.inject({
        method: 'GET', url: '/api/scanner/health', headers: { cookie, 'x-forwarded-for': freshIp() },
      });
      assert.equal(health.statusCode, 403, `health provider_state=${providerState ?? 'NULL'}: ${health.body}`);
      const runs = await app.inject({
        method: 'GET', url: '/api/scanner/runs?limit=5', headers: { cookie, 'x-forwarded-for': freshIp() },
      });
      assert.equal(runs.statusCode, 403, `runs provider_state=${providerState ?? 'NULL'}: ${runs.body}`);
      const trigger = await app.inject({
        method: 'POST', url: '/api/scanner/trigger', headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { force: true },
      });
      assert.equal(trigger.statusCode, 403, `trigger provider_state=${providerState ?? 'NULL'}: ${trigger.body}`);
      assert.equal(trigger.json().error.code, 'forbidden');
    }
  });

  test('a provider-backed premium row is refused too', async () => {
    const { cookie, userId } = await register();
    await makeProviderBacked(userId, 'premium', 'active', 'pending');
    const health = await app.inject({
      method: 'GET', url: '/api/scanner/health', headers: { cookie, 'x-forwarded-for': freshIp() },
    });
    assert.equal(health.statusCode, 403, health.body);
  });

  test('historical pro and premium rows keep scanner access', async () => {
    for (const plan of ['pro', 'premium']) {
      const { cookie, userId } = await register();
      await makeHistorical(userId, plan, 'active');
      const health = await app.inject({
        method: 'GET', url: '/api/scanner/health', headers: { cookie, 'x-forwarded-for': freshIp() },
      });
      assert.equal(health.statusCode, 200, `${plan}: ${health.body}`);
      const runs = await app.inject({
        method: 'GET', url: '/api/scanner/runs?limit=5', headers: { cookie, 'x-forwarded-for': freshIp() },
      });
      assert.equal(runs.statusCode, 200, runs.body);
      const trigger = await app.inject({
        method: 'POST', url: '/api/scanner/trigger', headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { force: true },
      });
      assert.ok([200, 201].includes(trigger.statusCode), `${plan}: ${trigger.body}`);
    }
  });

  test('the eligibility query excludes provider-backed owners from a run', async () => {
    await seedBullishCandles(SYMBOL, DETECT_AS_OF);
    const results: Record<string, number> = {};
    for (const [label, prepare] of [
      ['historical', async (userId: string) => makeHistorical(userId, 'pro', 'active')],
      ['providerBacked', async (userId: string) => makeProviderBacked(userId, 'pro', 'active', 'pending')],
    ] as [string, (userId: string) => Promise<void>][]) {
      const { cookie, userId } = await register();
      // Register first (free), then upgrade: the version is created either way.
      const { strategyId } = await createPublishedVersion(cookie, engulfConfig(SYMBOL));
      // `strategies.status` defaults to 'draft'; the scanner only picks 'active'.
      await db.pool.query(`UPDATE strategies SET status = 'active' WHERE id = $1`, [strategyId]);
      await prepare(userId);
      const result = await ctx.scanner.triggerScan({ strategyId, force: true });
      results[label] = result.run.strategiesScanned;
    }
    assert.equal(results.historical, 1, 'a historical pro strategy is scanned');
    assert.equal(results.providerBacked, 0, 'a provider-backed pro strategy is never eligible');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Limits                                                                  */
/* -------------------------------------------------------------------------- */

describe('limits — a provider-backed checkout gets the existing FREE limits', () => {
  test('strategies: refused at the free limit, allowed for a historical pro row', async () => {
    for (const [plan, prepare, expected] of [
      ['provider-backed pro', async (id: string) => makeProviderBacked(id, 'pro', 'active', 'pending'), 403],
      ['provider-backed premium', async (id: string) => makeProviderBacked(id, 'premium', 'active', 'active'), 403],
      ['historical pro', async (id: string) => makeHistorical(id, 'pro', 'active'), 201],
    ] as [string, (userId: string) => Promise<void>, number][]) {
      const { cookie, userId } = await register();
      await db.pool.query(
        `INSERT INTO strategies (user_id, name, description)
         SELECT $1, 'Seeded ' || i, 'fixture' FROM generate_series(1, 100) i`, [userId],
      );
      await prepare(userId);
      const res = await app.inject({
        method: 'POST', url: '/api/strategies', headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { name: `Limit probe ${randomUUID().slice(0, 8)}` },
      });
      assert.equal(res.statusCode, expected, `${plan}: ${res.body}`);
      if (expected === 403) {
        assert.match(res.json().error.message, /up to 100 strategies/, plan);
      }
    }
  });

  test('setups: detection is refused at the free saved-setup limit', async () => {
    await seedBullishCandles(SYMBOL, DETECT_AS_OF);
    const { cookie, userId } = await register();
    const { strategyId, versionId } = await createPublishedVersion(cookie, engulfConfig(SYMBOL));
    await seedSetups({ userId, strategyId, versionId, count: 1000, withAlerts: false });
    await makeProviderBacked(userId, 'premium', 'active', 'pending');

    const refused = await detect(cookie, strategyId, versionId, DETECT_AS_OF);
    assert.equal(refused.statusCode, 403, refused.body);
    assert.match(refused.json().error.message, /up to 1000 saved setups/, 'the FREE limit, not 10000');

    // The same user with a historical row is allowed straight through.
    await makeHistorical(userId, 'premium', 'active');
    const allowed = await detect(cookie, strategyId, versionId, DETECT_AS_OF);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json().detections[0].qualified, true);
  });

  test('alerts: generation is refused at the free monthly alert limit', async () => {
    await seedBullishCandles(SYMBOL, DETECT_AS_OF + 48 * HOUR);
    const { cookie, userId } = await register();
    const { strategyId, versionId } = await createPublishedVersion(cookie, engulfConfig(SYMBOL));
    const detected = await detect(cookie, strategyId, versionId, DETECT_AS_OF + 48 * HOUR);
    assert.equal(detected.statusCode, 200, detected.body);
    const setupId = detected.json().detections[0].setup.id as string;

    const scored = await app.inject({
      method: 'POST', url: `/api/setups/${setupId}/score`, headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(scored.statusCode, 200, scored.body);
    // Fill the month to the FREE limit with unrelated setups/alerts.
    await seedSetups({ userId, strategyId, versionId, count: 1000, withAlerts: true });
    await makeProviderBacked(userId, 'premium', 'active', 'pending');
    const refused = await app.inject({
      method: 'POST', url: `/api/setups/${setupId}/alerts`, headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.match(refused.json().error.message, /up to 1000 alerts per month/, 'the FREE limit, not 10000');

    await makeHistorical(userId, 'premium', 'active');
    const allowed = await app.inject({
      method: 'POST', url: `/api/setups/${setupId}/alerts`, headers: { cookie, 'x-forwarded-for': freshIp() },
      payload: {},
    });
    assert.equal(allowed.statusCode, 201, allowed.body);
    assert.equal(allowed.json().created, true);
  });

  test('backtests: the route limit is the free monthly limit', async () => {
    await seedBullishCandles(SYMBOL, DETECT_AS_OF);
    const { cookie, userId } = await register();
    const { strategyId, versionId } = await createPublishedVersion(cookie, engulfConfig(SYMBOL));
    const instrument = await store.resolveInstrument('forex', SYMBOL);
    assert.ok(instrument);
    await db.pool.query(
      `INSERT INTO backtest_runs (user_id, strategy_id, strategy_version_id, instrument_id, direction,
         engine_version, from_ms, to_ms, exit_policy, cost_policy, config_hash, status)
       SELECT $1, $2, $3, $4, 'long', 'fixture-engine', 1000 + i, 2000 + i, '{}', '{}',
              md5('fixture' || i) || md5(i::text), 'completed'
       FROM generate_series(1, 100) AS i`,
      [userId, strategyId, versionId, instrument.id],
    );
    const payload = {
      strategyId, versionId, instrument: { assetClass: 'forex', symbol: SYMBOL },
      direction: 'long', from: DETECT_AS_OF - 20 * HOUR, to: DETECT_AS_OF,
    };

    await makeProviderBacked(userId, 'pro', 'active', 'pending');
    const refused = await app.inject({
      method: 'POST', url: '/api/backtests', headers: { cookie, 'x-forwarded-for': freshIp() }, payload,
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.match(refused.json().error.message, /up to 100 backtests per month/, 'the FREE limit, not 1000');

    await makeHistorical(userId, 'pro', 'active');
    const allowed = await app.inject({
      method: 'POST', url: '/api/backtests', headers: { cookie, 'x-forwarded-for': freshIp() }, payload,
    });
    assert.notEqual(allowed.statusCode, 403, `a historical pro row is not limit-refused: ${allowed.body}`);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Automation                                                              */
/* -------------------------------------------------------------------------- */

describe('automation — canAccessAutomation is unchanged for everyone', () => {
  test('historical premium and provider-backed premium both stay off', async () => {
    for (const prepare of [
      async (id: string) => makeHistorical(id, 'premium', 'active'),
      async (id: string) => makeProviderBacked(id, 'premium', 'active', 'active'),
    ]) {
      const { cookie, userId } = await register();
      await prepare(userId);
      const status = await app.inject({
        method: 'GET', url: '/api/execution/automation', headers: { cookie, 'x-forwarded-for': freshIp() },
      });
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(status.json().entitled, false);
      assert.equal(status.json().effective, false);
      assert.ok((status.json().reasons as string[]).includes('entitlement_not_granted'));

      const toggle = await app.inject({
        method: 'POST', url: '/api/execution/automation', headers: { cookie, 'x-forwarded-for': freshIp() },
        payload: { enabled: true },
      });
      assert.equal(toggle.statusCode, 403, toggle.body);
      const row = await db.pool.query('SELECT automation_enabled FROM users WHERE id=$1', [userId]);
      assert.equal(row.rows[0]!.automation_enabled, false, 'the switch never moved');
    }
  });
});
