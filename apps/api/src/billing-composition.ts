import type pg from 'pg';
import { BILLING_PROVIDER } from '@veltrixeye/contracts';
import {
  PaystackNotImplementedError,
  PaystackAdapterError,
  createPaystackProvider,
  type PaystackCustomerDirectory,
  type PaystackPlanDirectory,
} from '@veltrixeye/provider-paystack';
import {
  createBillingProviderRegistry,
  BillingCheckoutService,
  BillingSubscriptionSyncService,
  BillingWebhookReceiver,
  isBillingProviderPlanError,
  parseProviderPlan,
  type BillingProviderPlan,
  type BillingProviderRegistry,
} from '@veltrixeye/core';
import type { AppConfig } from './config.js';

/**
 * Billing PR3 composition — the ONLY place the Paystack adapter is bound to the
 * application, and the ONLY place billing provider code is allowed to reach the
 * database.
 *
 * TWO RULES GOVERN THIS FILE
 *
 *  1. REGISTER ONLY WHEN EVERY STABLE PREREQUISITE IS USABLE. With no sandbox
 *     secret key configured, nothing is registered: the registry stays empty,
 *     so a caller that reaches for the seam gets a loud "not implemented /
 *     not registered" failure instead of a half-configured provider.
 *
 *     Transient DATA (a fresh FX rate, an active plan epoch) deliberately does
 *     NOT gate registration: a rate that ages out after 15 minutes must not
 *     unregister the provider, and a database blip at boot must not decide
 *     whether billing exists. Data-dependent decisions are made per call and
 *     fail closed there — pricing refuses a stale rate, and the adapter refuses
 *     a plan mismatch or a missing epoch. Composition decides what EXISTS;
 *     data decides what may happen right now.
 *
 *  2. THE ADAPTER NEVER TOUCHES THE DATABASE. The two directories below are the
 *     adapter's only view of local state: it asks for a customer by user id and
 *     for an authorized plan epoch by provider plan id, and it receives
 *     validated, provider-neutral values. Reads are fail-closed: a row this
 *     build does not fully understand raises rather than degrading into a
 *     permissive default.
 *
 * PR-C also composes checkout orchestration. No webhook receiver, customer
 * provisioning or billing portal is introduced here.
 */

export interface BillingCompositionStatus {
  registered: boolean;
  /** Why registration did or did not happen (operator-facing, no secrets). */
  reason: string;
  provider: string;
  mode: 'test';
  /** Operator-safe adapter description when registered. */
  describe: Record<string, unknown> | null;
}

export interface BillingComposition {
  registry: BillingProviderRegistry;
  status: BillingCompositionStatus;
}

/**
 * Local record of a user's provider customer, read for the adapter. Only the
 * two facts the adapter needs are returned — no status, no reference, no
 * credential.
 */
export function paystackCustomerDirectory(db: pg.Pool): PaystackCustomerDirectory {
  return {
    async find(userId: string) {
      const { rows } = await db.query<{ email: string; provider_customer_code: string | null }>(
        `SELECT email, provider_customer_code
           FROM billing_customers
          WHERE provider = $1 AND user_id = $2`,
        [BILLING_PROVIDER, userId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return { email: row.email.toLowerCase(), providerCustomerCode: row.provider_customer_code };
    },
  };
}

/**
 * Authorized plan epochs, read for the adapter. A row is validated through the
 * canonical epoch contract FIRST: an unknown mode, status, plan, interval,
 * currency or exponent is a hard failure (never a permissive default), and the
 * adapter then compares the validated epoch against the authorized payment
 * before any recurring charge. The adapter never sees an unvalidated row.
 */
export function paystackPlanDirectory(db: pg.Pool): PaystackPlanDirectory {
  return {
    async find(providerPlanId: string): Promise<BillingProviderPlan | null> {
      // Explicit column list, matching the epoch contract exactly: `SELECT *`
      // would also return durable audit columns (created_at/updated_at/
      // catalogue_amount_minor) that the strict epoch parser refuses by design,
      // turning a valid epoch into a hard failure.
      const { rows } = await db.query(
        `SELECT id, provider, mode, catalogue_plan, billing_interval, payment_currency,
                payment_amount_minor, payment_amount_exponent, provider_plan_id,
                provider_plan_reference, fx_rate_version_id, pricing_policy_version,
                catalogue_version, status, valid_from, retired_at, retired_reason
           FROM billing_provider_plans
          WHERE provider = $1 AND provider_plan_id = $2`,
        [BILLING_PROVIDER, providerPlanId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      // Throws on anything this build does not fully understand.
      return parseProviderPlan(row);
    },
  };
}

/**
 * Build the billing provider composition.
 *
 * Registered ONLY when the configuration carries a usable sandbox key; the
 * adapter itself refuses any key that is not a `sk_test_` test key, so this
 * function cannot register a live provider even if it wanted to.
 */
export function composeBillingProvider(db: pg.Pool, config: AppConfig): BillingComposition {
  const registry = createBillingProviderRegistry();

  const secretKey = config.PAYSTACK_SECRET_KEY;
  if (secretKey === '') {
    return {
      registry,
      status: {
        registered: false,
        provider: BILLING_PROVIDER,
        mode: 'test',
        reason:
          'PAYSTACK_SECRET_KEY is not set — no billing provider is registered, so no customer can be ' +
          'provisioned and no payment can be initialized (fail closed).',
        describe: null,
      },
    };
  }

  const provider = createPaystackProvider({
    secretKey,
    timeoutMs: config.billing.timeoutMs,
    customers: paystackCustomerDirectory(db),
    plans: paystackPlanDirectory(db),
  });

  registry.register(provider);

  return {
    registry,
    status: {
      registered: true,
      provider: BILLING_PROVIDER,
      mode: 'test',
      reason: 'Paystack sandbox adapter registered (test mode; live credentials are refused).',
      describe: provider.describe(),
    },
  };
}

/** Re-exported so callers/tests can assert the fail-closed plan posture. */
export { PaystackNotImplementedError, isBillingProviderPlanError };

/** Fixed existing page: this is a return location, not a payment confirmation handler. */
export function billingCheckoutCallbackUrl(config: AppConfig): string | null {
  const origin = config.PUBLIC_APPLICATION_ORIGIN;
  if (!origin) return null;
  // Defense in depth for hand-built configurations; loadConfig validates at boot.
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return new URL('/settings', url.origin).toString();
  } catch { return null; }
}

/**
 * Billing Step 5.2 — compose the secure webhook receiver.
 *
 * Returns `null` (and the route simply does not exist) when no sandbox key is
 * configured: the same fail-closed posture as the provider registration
 * above. The receiver gets the SAME injected secret key the adapter was
 * registered with — signature verification and outbound authorization are
 * two uses of one credential — plus the registry (it reaches the adapter's
 * `normalizeEvent` only through the seam) and the database (ledger writes
 * and local subject resolution; the adapter itself still never touches it).
 */
export function composeBillingWebhookReceiver(
  db: pg.Pool, providers: BillingProviderRegistry, config: AppConfig,
): BillingWebhookReceiver | null {
  if (!config.billing.enabled || config.PAYSTACK_SECRET_KEY === '') return null;
  return new BillingWebhookReceiver({ db, providers, secretKey: config.PAYSTACK_SECRET_KEY });
}

export function composeBillingCheckout(
  db: pg.Pool, providers: BillingProviderRegistry, config: AppConfig,
): BillingCheckoutService {
  const customers = paystackCustomerDirectory(db);
  return new BillingCheckoutService({
    db, providers, callbackUrl: billingCheckoutCallbackUrl(config),
    async requireExistingCustomer(userId) {
      const customer = await customers.find(userId);
      if (!customer?.email || !customer.providerCustomerCode?.trim()) {
        throw new PaystackAdapterError('customer_not_provisioned',
          'Checkout refused: customer_not_provisioned. An existing local Paystack customer identity is required.');
      }
    },
  });
}

/**
 * Later-billing-PR #7 — compose subscription verification + synchronization.
 *
 * Always composed (like checkout): with no registered provider the service
 * refuses with `provider_not_registered` and writes nothing. It reaches the
 * adapter only through the seam's `verifySubscription` (the documented
 * transaction-verify read) and owns the database write itself; the adapter
 * still never touches the database. The webhook receiver does NOT use it —
 * receipt stays receipt-only.
 */
export function composeBillingSync(
  db: pg.Pool, providers: BillingProviderRegistry,
): BillingSubscriptionSyncService {
  return new BillingSubscriptionSyncService({ db, providers });
}
