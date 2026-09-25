import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  BILLING_PROVIDER,
  billingCustomerIdentitySchema,
  billingCustomerProvisioningResultSchema,
  billingCustomerStatusSchema,
  type BillingCustomerIdentity,
  type BillingCustomerProvisioningOutcome,
  type BillingCustomerProvisioningResult,
} from '@veltrixeye/contracts';
import {
  billingCustomerCreateRequestSchema,
  billingCustomerQuerySchema,
  type BillingProviderRegistry,
} from './provider.js';

/**
 * Billing Step 6 (roadmap item 8a) — the CUSTOMER PROVISIONING flow.
 * SANDBOX ONLY.
 *
 * One call = "make sure the signed-in user has a usable local billing
 * customer". It is the first (and only) production writer of
 * `billing_customers` (migration 0031), and it exists so that checkout's
 * existing `requireExistingCustomer` requirement becomes reachable.
 *
 *   1. read the account email from `users` (the subject is ALWAYS the caller's
 *      own user id — the API passes the session user, never a request field);
 *   2. read the local `billing_customers` row:
 *        - `provisioned` with a provider customer code → done, NO provider
 *          call and NO write (`already_provisioned`);
 *        - `provisioned` without a code, `suspended`, `unavailable`, or an
 *          email that disagrees with the account → refused, nothing called,
 *          nothing written (operator review; never silently repaired);
 *        - absent or `unprovisioned` → continue;
 *   3. ask the provider — through the canonical seam only — whether it already
 *      has a customer for the account email (`findCustomer`), and only when it
 *      does not, create one (`createCustomer`). No DB lock is held across the
 *      network;
 *   4. validate the returned identity strictly (canonical contract, same user,
 *      same email, `provisioned`, carries a provider customer code);
 *   5. persist it in ONE conditional statement that can only move a row from
 *      absent/`unprovisioned` to `provisioned` — first writer wins; a
 *      concurrent loser re-reads and returns the winner's record.
 *
 * ---------------------------------------------------------------------------
 * CONCURRENCY / IDEMPOTENCY
 * ---------------------------------------------------------------------------
 *  - In-process single-flight: concurrent calls for the same user on one API
 *    instance share ONE provider round-trip.
 *  - Across instances, the 0031 unique indexes are the arbiter: one row per
 *    (provider, user) and no provider identifier shared by two users. The
 *    persisting statement is `INSERT … ON CONFLICT (provider, user_id) DO
 *    UPDATE … WHERE status = 'unprovisioned'`, so a provisioned row is never
 *    overwritten and a retry after success is a no-op read.
 *  - `findCustomer` runs before `createCustomer`, so a retry after a lost
 *    response links the customer the provider already has instead of creating
 *    a second one. Provider-side idempotency is never assumed.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT NEVER DOES
 * ---------------------------------------------------------------------------
 *  - It never touches `subscriptions`, `users`, entitlements, pricing,
 *    checkout, the webhook ledger or any execution gate. A provisioned
 *    customer is identity bookkeeping: it buys nothing and confirms nothing.
 *    The result pins `entitlementsChanged` and `grantsExecution` to `false`
 *    at the type level, and `resolveEntitlements` is unchanged (a
 *    provider-backed row still resolves to FREE).
 *  - It never writes on failure: a missing provider, a provider error or an
 *    unusable provider response leaves `billing_customers` exactly as it was.
 *  - It performs no transport and reads no environment or credential: the
 *    provider and the database are injected; the provider is reached through
 *    the seam only (the Paystack adapter enforces sandbox keys itself).
 *  - It never logs, and its error messages carry fixed, credential-free text;
 *    provider detail stays in `cause`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export const BILLING_CUSTOMER_PROVISIONING_ERROR_REASONS = [
  /** No billing provider is registered (no sandbox key configured). */
  'provider_not_registered',
  /** The account does not exist or carries no usable email. */
  'account_unavailable',
  /** The local customer is `suspended` or `unavailable` (operator state). */
  'customer_not_provisionable',
  /** A `provisioned` local row carries no provider customer code. */
  'customer_identity_incomplete',
  /** Local/provider identity disagreement, or a provider identity already bound to another user. */
  'customer_identity_conflict',
  /** The provider call failed (transport, refusal, ambiguous response). */
  'provider_unavailable',
  /** The provider answered, but not with an identity this build can use. */
  'provider_response_unusable',
] as const;
export type BillingCustomerProvisioningErrorReason =
  (typeof BILLING_CUSTOMER_PROVISIONING_ERROR_REASONS)[number];

const ERROR_MESSAGES: Readonly<Record<BillingCustomerProvisioningErrorReason, string>> = Object.freeze({
  provider_not_registered:
    'Customer provisioning refused: no billing provider is registered. Nothing was changed.',
  account_unavailable:
    'Customer provisioning refused: the account has no usable email address. Nothing was changed.',
  customer_not_provisionable:
    'Customer provisioning refused: the billing customer is suspended or unavailable and requires operator review. Nothing was changed.',
  customer_identity_incomplete:
    'Customer provisioning refused: the provisioned billing customer has no provider customer code and requires operator review. Nothing was changed.',
  customer_identity_conflict:
    'Customer provisioning refused: the billing customer identity conflicts with existing records and requires operator review. Nothing was changed.',
  provider_unavailable:
    'Customer provisioning refused: the billing provider did not complete the request. Nothing was changed.',
  provider_response_unusable:
    'Customer provisioning refused: the billing provider returned an unusable customer identity. Nothing was changed.',
});

export class BillingCustomerProvisioningError extends Error {
  readonly code = 'billing_customer_provisioning_refused' as const;

  constructor(
    readonly reason: BillingCustomerProvisioningErrorReason,
    options?: { cause?: unknown },
  ) {
    super(ERROR_MESSAGES[reason], options);
    this.name = 'BillingCustomerProvisioningError';
  }
}

export function isBillingCustomerProvisioningError(error: unknown): error is BillingCustomerProvisioningError {
  return error instanceof BillingCustomerProvisioningError;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic idempotency key for one customer creation (provider, user,
 * email). A retry for the same account always presents the same key.
 */
export function billingCustomerCreateKey(userId: string, email: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['billing-customer-create/v1', BILLING_PROVIDER, userId, email]))
    .digest('hex');
}

/** The local columns this service reads (no `last_reference`: not needed). */
export interface BillingCustomerRow {
  id: string;
  user_id: string;
  provider: string;
  email: string;
  provider_customer_id: string | null;
  provider_customer_code: string | null;
  status: string;
  provisioned_at: Date | null;
}

const CUSTOMER_COLUMNS = `id, user_id, provider, email, provider_customer_id, provider_customer_code,
  status, provisioned_at`;

/**
 * Whether a local row satisfies checkout's existing-customer requirement
 * (`billing-composition.ts`: an email AND a non-blank provider customer
 * code) AND is `provisioned`. Pure.
 */
export function isCheckoutReadyBillingCustomer(row: BillingCustomerRow): boolean {
  return (
    row.status === 'provisioned' &&
    row.email.trim() !== '' &&
    typeof row.provider_customer_code === 'string' &&
    row.provider_customer_code.trim() !== '' &&
    row.provisioned_at instanceof Date
  );
}

type ExistingDecision =
  | { kind: 'ready' }
  | { kind: 'provision' }
  | { kind: 'refuse'; reason: BillingCustomerProvisioningErrorReason };

/**
 * Decide what an existing local row means, BEFORE any provider call. Pure.
 * The status vocabulary is the canonical one (0031 CHECK); anything this
 * build does not understand is refused, never treated as "provision again".
 */
export function decideExistingBillingCustomer(row: BillingCustomerRow, accountEmail: string): ExistingDecision {
  const status = billingCustomerStatusSchema.safeParse(row.status);
  if (!status.success || row.provider !== BILLING_PROVIDER) {
    return { kind: 'refuse', reason: 'customer_not_provisionable' };
  }
  switch (status.data) {
    case 'provisioned':
      return isCheckoutReadyBillingCustomer(row)
        ? { kind: 'ready' }
        : { kind: 'refuse', reason: 'customer_identity_incomplete' };
    case 'suspended':
    case 'unavailable':
      return { kind: 'refuse', reason: 'customer_not_provisionable' };
    case 'unprovisioned':
      // The adapter looks a customer up by the LOCAL row first. A placeholder
      // whose email disagrees with the account would link the wrong provider
      // customer, so it is refused for review rather than silently rewritten.
      return row.email === accountEmail
        ? { kind: 'provision' }
        : { kind: 'refuse', reason: 'customer_identity_conflict' };
  }
}

/**
 * Paystack key-shaped material (`sk_test_…`, `pk_live_…`). The contract's
 * credential regex is keyword-based; this adds the provider's own key prefix
 * so a key can never be persisted as a customer identifier.
 */
const PROVIDER_KEY_SHAPED_RE = /^\s*[sp]k_(test|live)_/i;

/** A provider identity this build will persist (strictly validated). */
interface UsableIdentity {
  email: string;
  providerCustomerId: string | null;
  providerCustomerCode: string;
}

/**
 * Validate what the provider returned against the canonical identity contract
 * AND against the request: same provider, same user, same (lowercase) email,
 * `provisioned`, and a provider customer code (the identifier checkout's
 * existing-customer requirement depends on). Anything else is unusable.
 */
export function usableProviderCustomerIdentity(
  identity: unknown,
  expected: { userId: string; email: string },
): UsableIdentity {
  const parsed = billingCustomerIdentitySchema.safeParse(identity);
  if (!parsed.success) throw new BillingCustomerProvisioningError('provider_response_unusable', { cause: parsed.error });
  const value: BillingCustomerIdentity = parsed.data;
  if (
    value.provider !== BILLING_PROVIDER ||
    value.userId !== expected.userId ||
    value.status !== 'provisioned' ||
    value.providerCustomerCode === null ||
    PROVIDER_KEY_SHAPED_RE.test(value.providerCustomerCode) ||
    (value.providerCustomerId !== null && PROVIDER_KEY_SHAPED_RE.test(value.providerCustomerId))
  ) {
    throw new BillingCustomerProvisioningError('provider_response_unusable');
  }
  if (value.email !== expected.email) {
    throw new BillingCustomerProvisioningError('customer_identity_conflict');
  }
  return {
    email: value.email,
    providerCustomerId: value.providerCustomerId,
    providerCustomerCode: value.providerCustomerCode,
  };
}

const accountEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.string().email().min(3).max(254));

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export interface BillingCustomerServiceOptions {
  db: Pool;
  providers: BillingProviderRegistry;
  now?: () => Date;
}

/** 0031 unique indexes that bind a provider identifier to exactly one user. */
const PROVIDER_IDENTITY_CONSTRAINTS = new Set([
  'billing_customers_provider_customer_id_uniq',
  'billing_customers_provider_customer_code_uniq',
]);

export class BillingCustomerService {
  private readonly inflight = new Map<string, Promise<BillingCustomerProvisioningResult>>();

  constructor(private readonly options: BillingCustomerServiceOptions) {}

  /**
   * Ensure the user has a usable local billing customer (sandbox provider).
   *
   * Resolves with the canonical provisioning result; rejects with
   * `BillingCustomerProvisioningError` — with NOTHING written — on every
   * refusal. `userId` must be the authenticated caller's own id.
   */
  ensureCustomer(userId: string): Promise<BillingCustomerProvisioningResult> {
    const user = z.string().uuid().parse(userId);
    const existing = this.inflight.get(user);
    if (existing !== undefined) return existing;
    const pending = this.provision(user).finally(() => {
      this.inflight.delete(user);
    });
    this.inflight.set(user, pending);
    return pending;
  }

  /** The user's local billing customer row, or null. Read-only. */
  async findLocalCustomer(userId: string): Promise<BillingCustomerRow | null> {
    const user = z.string().uuid().parse(userId);
    const { rows } = await this.options.db.query<BillingCustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM billing_customers
        WHERE provider = $1 AND user_id = $2`,
      [BILLING_PROVIDER, user],
    );
    return rows[0] ?? null;
  }

  private async provision(user: string): Promise<BillingCustomerProvisioningResult> {
    const email = await this.accountEmail(user);

    const local = await this.findLocalCustomer(user);
    if (local !== null) {
      const decision = decideExistingBillingCustomer(local, email);
      if (decision.kind === 'ready') return result(local, 'already_provisioned');
      if (decision.kind === 'refuse') throw new BillingCustomerProvisioningError(decision.reason);
    }

    const provider = this.options.providers.get(BILLING_PROVIDER);
    if (provider === undefined) throw new BillingCustomerProvisioningError('provider_not_registered');

    // Canonical requests are built (and validated) before any provider call.
    const query = billingCustomerQuerySchema.parse({ provider: BILLING_PROVIDER, userId: user, email });

    // Provider round-trip, outside any transaction. Any failure writes nothing.
    let returned: unknown;
    let outcome: Extract<BillingCustomerProvisioningOutcome, 'created' | 'linked'>;
    try {
      const found = await provider.findCustomer(query);
      if (found !== null) {
        returned = found;
        outcome = 'linked';
      } else {
        const create = billingCustomerCreateRequestSchema.parse({
          provider: BILLING_PROVIDER,
          userId: user,
          email,
          idempotencyKey: billingCustomerCreateKey(user, email),
          requestedAt: this.now().toISOString(),
        });
        returned = await provider.createCustomer(create);
        outcome = 'created';
      }
    } catch (error) {
      throw new BillingCustomerProvisioningError('provider_unavailable', { cause: error });
    }

    const identity = usableProviderCustomerIdentity(returned, { userId: user, email });
    return this.persist(user, identity, outcome);
  }

  /**
   * The ONLY write: absent/`unprovisioned` → `provisioned`, in one statement.
   * A row that is already provisioned (a concurrent winner), suspended or
   * unavailable is never overwritten.
   */
  private async persist(
    user: string,
    identity: UsableIdentity,
    outcome: Extract<BillingCustomerProvisioningOutcome, 'created' | 'linked'>,
  ): Promise<BillingCustomerProvisioningResult> {
    let written: BillingCustomerRow | undefined;
    let identityConflict: unknown = null;
    try {
      const { rows } = await this.options.db.query<BillingCustomerRow>(
        `INSERT INTO billing_customers
           (user_id, provider, email, provider_customer_id, provider_customer_code, status, provisioned_at)
         VALUES ($1, $2, $3, $4, $5, 'provisioned', $6)
         ON CONFLICT (provider, user_id) DO UPDATE
            SET email = EXCLUDED.email,
                provider_customer_id = EXCLUDED.provider_customer_id,
                provider_customer_code = EXCLUDED.provider_customer_code,
                status = 'provisioned',
                provisioned_at = EXCLUDED.provisioned_at
          WHERE billing_customers.status = 'unprovisioned'
            AND billing_customers.email = EXCLUDED.email
         RETURNING ${CUSTOMER_COLUMNS}`,
        [
          user,
          BILLING_PROVIDER,
          identity.email,
          identity.providerCustomerId,
          identity.providerCustomerCode,
          this.now(),
        ],
      );
      written = rows[0];
    } catch (error) {
      const constraint = (error as { code?: string; constraint?: string }) ?? {};
      if (constraint.code === '23505' && PROVIDER_IDENTITY_CONSTRAINTS.has(constraint.constraint ?? '')) {
        // Either another user already holds this provider identity, or a
        // concurrent request for THIS user won the race with the same
        // identity. The re-read below tells the two apart.
        identityConflict = error;
      } else {
        throw error;
      }
    }

    if (written !== undefined) return result(written, outcome);

    // Nothing of ours landed: re-read the (caller's own) row and report the
    // state that won. Never another user's row: the read is keyed by user.
    const current = await this.findLocalCustomer(user);
    if (current !== null && isCheckoutReadyBillingCustomer(current)) {
      return result(current, 'already_provisioned');
    }
    if (identityConflict !== null) {
      throw new BillingCustomerProvisioningError('customer_identity_conflict', { cause: identityConflict });
    }
    if (current !== null) {
      const decision = decideExistingBillingCustomer(current, identity.email);
      throw new BillingCustomerProvisioningError(
        decision.kind === 'refuse' ? decision.reason : 'customer_identity_conflict',
      );
    }
    throw new BillingCustomerProvisioningError('customer_identity_conflict');
  }

  private async accountEmail(user: string): Promise<string> {
    const { rows } = await this.options.db.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [user],
    );
    const parsed = accountEmailSchema.safeParse(rows[0]?.email);
    if (!parsed.success) throw new BillingCustomerProvisioningError('account_unavailable');
    return parsed.data;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}

function result(
  row: BillingCustomerRow,
  outcome: BillingCustomerProvisioningOutcome,
): BillingCustomerProvisioningResult {
  return billingCustomerProvisioningResultSchema.parse({
    provider: BILLING_PROVIDER,
    outcome,
    status: 'provisioned',
    email: row.email,
    provisionedAt: (row.provisioned_at as Date).toISOString(),
    checkoutReady: true,
    entitlementsChanged: false,
    grantsExecution: false,
  });
}
