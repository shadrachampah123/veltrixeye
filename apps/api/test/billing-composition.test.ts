/**
 * Billing PR3 — API configuration and provider composition.
 *
 * Pins the boot-time posture:
 *  - a SANDBOX (test-mode) key is the only accepted credential: a live key, a
 *    public key or anything else is refused when the configuration is loaded, so
 *    no deployment can move live money by setting a variable;
 *  - with no key, NOTHING is registered (the registry stays empty), so a caller
 *    that reaches for a billing provider fails loudly instead of reaching a
 *    half-configured integration;
 *  - with a test key, the adapter is registered and reports itself honestly
 *    (sandbox, not live, `implemented: false` while seam operations remain
 *    unimplemented) and never exposes the credential;
 *  - the composition-supplied directories are fail-closed: a row this build does
 *    not fully understand raises rather than degrading into a permissive
 *    default.
 *
 * No database and no network are involved: the pool is a double.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig, type AppConfig } from '../src/config.js';
import { composeBillingProvider, paystackCustomerDirectory, paystackPlanDirectory } from '../src/billing-composition.js';

const BASE = { NODE_ENV: 'test', DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test' };
const TEST_KEY = 'sk_test_0123456789abcdef0123456789abcdef01234567';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...BASE, ...overrides });
}

function poolDouble(rows: unknown[]): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } {
  return {
    query: async () => ({ rows }),
  };
}

describe('Billing PR3 — configuration', () => {
  test('billing defaults to disabled, sandbox-only and USD→GHS', () => {
    const cfg = config().billing;
    assert.deepEqual(cfg, {
      provider: 'paystack',
      sandbox: true,
      live: false,
      enabled: false,
      timeoutMs: 15_000,
      commercialCurrency: 'USD',
      paymentCurrency: 'GHS',
      fxMaxAgeSeconds: 900,
    });
  });

  test('a sandbox test key enables billing and is never echoed back from the config', () => {
    const loaded = config({ PAYSTACK_SECRET_KEY: TEST_KEY });
    assert.equal(loaded.billing.enabled, true);
    assert.equal(loaded.PAYSTACK_SECRET_KEY, TEST_KEY, 'the key stays in the server-side config only');
    assert.equal(loaded.billing.live, false);
  });

  test('a live key, a public key or a malformed key stops the boot', () => {
    for (const key of ['sk_live_0123456789abcdef', 'pk_test_0123456789abcdef', 'sk_0123456789', 'nonsense']) {
      assert.throws(
        () => config({ PAYSTACK_SECRET_KEY: key }),
        (error: unknown) => {
          const message = String((error as Error).message);
          assert.match(message, /PAYSTACK_SECRET_KEY/);
          assert.doesNotMatch(message, new RegExp(key), 'the rejected value is never echoed');
          return true;
        },
        `${key.slice(0, 8)}… must be refused`,
      );
    }
  });

  test('the timeout is bounded', () => {
    assert.throws(() => config({ PAYSTACK_TIMEOUT_MS: '10' }));
    assert.throws(() => config({ PAYSTACK_TIMEOUT_MS: '999999' }));
    assert.equal(config({ PAYSTACK_TIMEOUT_MS: '20000' }).billing.timeoutMs, 20_000);
  });
});

describe('Billing PR3 — composition fails closed', () => {
  test('with no key, no provider is registered', () => {
    const composition = composeBillingProvider(poolDouble([]) as never, config());
    assert.equal(composition.status.registered, false);
    assert.equal(composition.registry.size, 0);
    assert.equal(composition.registry.get('paystack'), undefined);
    assert.equal(composition.status.describe, null);
    assert.match(composition.status.reason, /PAYSTACK_SECRET_KEY is not set/);
  });

  test('with a sandbox key, the adapter is registered and reports honestly', () => {
    const composition = composeBillingProvider(poolDouble([]) as never, config({ PAYSTACK_SECRET_KEY: TEST_KEY }));
    assert.equal(composition.status.registered, true);
    assert.equal(composition.registry.size, 1);

    const listed = composition.registry.list();
    assert.deepEqual(listed, [{ id: 'paystack', name: 'paystack-sandbox', implemented: false, live: false }]);
    assert.deepEqual(composition.registry.implementedProviders(), []);
    assert.equal(JSON.stringify(composition.status.describe).includes(TEST_KEY), false);
    assert.equal(composition.status.describe?.live, false);
    assert.equal(composition.status.describe?.mode, 'test');
  });

  test('a live key cannot even reach the composition', () => {
    assert.throws(() => config({ PAYSTACK_SECRET_KEY: 'sk_live_deadbeefdeadbeef' }));
  });

  test('a misconfigured key cannot be smuggled in through a hand-built config', () => {
    const handBuilt = { ...config(), billing: { ...config().billing, enabled: true }, PAYSTACK_SECRET_KEY: 'sk_live_x' } as AppConfig;
    assert.throws(
      () => composeBillingProvider(poolDouble([]) as never, handBuilt),
      (error: unknown) => /sandbox \(test-mode\)/i.test(String((error as Error).message)),
    );
  });
});

describe('Billing PR3 — composition directories are fail-closed', () => {
  test('the customer directory returns the local record, normalized, or null', async () => {
    const found = paystackCustomerDirectory(
      poolDouble([{ email: 'Trader@Example.com', provider_customer_code: 'CUS_abc' }]) as never,
    );
    assert.deepEqual(await found.find(USER_ID), { email: 'trader@example.com', providerCustomerCode: 'CUS_abc' });

    const missing = paystackCustomerDirectory(poolDouble([]) as never);
    assert.equal(await missing.find(USER_ID), null);
  });

  test('the plan directory returns the validated epoch and refuses an unreadable one', async () => {
    const row = {
      id: '22222222-2222-4222-8222-222222222222',
      provider: 'paystack',
      mode: 'test',
      catalogue_plan: 'pro',
      billing_interval: 'monthly',
      payment_currency: 'GHS',
      payment_amount_minor: '48750',
      payment_amount_exponent: 2,
      provider_plan_id: 'PLN_pro_monthly',
      provider_plan_reference: null,
      fx_rate_version_id: '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01',
      pricing_policy_version: 'pr3-usd-ghs-v1',
      catalogue_version: 'billing-catalogue-1',
      status: 'active',
      valid_from: new Date('2026-09-22T09:00:00.000Z'),
      retired_at: null,
      retired_reason: null,
    };

    const active = paystackPlanDirectory(poolDouble([row]) as never);
    assert.deepEqual(await active.find('PLN_pro_monthly'), {
      id: '22222222-2222-4222-8222-222222222222',
      provider: 'paystack',
      mode: 'test',
      cataloguePlan: 'pro',
      interval: 'monthly',
      paymentCurrency: 'GHS',
      paymentAmountMinor: 48_750n,
      paymentAmountExponent: 2,
      providerPlanId: 'PLN_pro_monthly',
      providerPlanReference: null,
      fxRateVersionId: '3f7a6b0e-6b2f-4e58-9a1f-2c6d5b8e9a01',
      pricingPolicyVersion: 'pr3-usd-ghs-v1',
      catalogueVersion: 'billing-catalogue-1',
      status: 'active',
      validFrom: new Date('2026-09-22T09:00:00.000Z'),
      retiredAt: null,
    });

    // A retired epoch is returned as retired — the ADAPTER then refuses it.
    const retired = paystackPlanDirectory(
      poolDouble([{ ...row, status: 'retired', retired_at: new Date('2026-09-22T10:00:00.000Z'), retired_reason: 'replaced' }]) as never,
    );
    assert.equal((await retired.find('PLN_pro_monthly'))?.status, 'retired');

    // An unknown status, mode or plan is a hard failure, never a permissive
    // default: an epoch this build does not fully understand cannot charge.
    for (const broken of [{ ...row, status: 'pending' }, { ...row, mode: 'live' }, { ...row, catalogue_plan: 'starter' }]) {
      const directory = paystackPlanDirectory(poolDouble([broken]) as never);
      await assert.rejects(() => directory.find('PLN_pro_monthly'));
    }
    const missing = paystackPlanDirectory(poolDouble([]) as never);
    assert.equal(await missing.find('PLN_unknown'), null);
  });

  test('the epoch query selects the contract columns explicitly, never `SELECT *`', () => {
    // A `SELECT *` would drag durable audit columns (created_at, updated_at,
    // catalogue_amount_minor) into the strict epoch parser and turn a valid
    // epoch into a hard failure — the exact opposite of failing closed for the
    // right reason.
    const source = readFileSync(new URL('../src/billing-composition.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /SELECT\s+\*\s+FROM/i, 'no SELECT * against billing tables');
    assert.match(source, /FROM billing_provider_plans/);
    assert.match(source, /SELECT id, provider, mode, catalogue_plan, billing_interval, payment_currency,/);
  });
});
