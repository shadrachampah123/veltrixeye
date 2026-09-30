import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { BILLING_CREDENTIAL_SHAPED_RE, USER_PLANS, type UserPlan } from '@veltrixeye/contracts';
import { recordAuditEvent } from '../audit.js';
import { resolvePaidTier } from './entitlement-resolution.js';

/**
 * NON-COMMERCIAL ENTITLEMENT GRANTS — the out-of-band operator authority that
 * lets a NAMED account hold a commercial entitlement tier without a purchase.
 *
 * WHY THIS EXISTS, PRECISELY
 *
 * The payment path is deliberately closed to any account that has not paid.
 * `BillingActivationService` (Billing Step 8) refuses with
 * `payment_evidence_not_found` unless a row exists in
 * `billing_verified_transactions` (0033), and the only writer of that table is
 * `BillingPaymentConfirmationService.confirm()`, which performs a REAL provider
 * read (`GET /transaction/verify/:reference`) and demands a successful
 * transaction that reconciles exactly against a locked pricing snapshot. A
 * granted account has, by definition, none of those — and manufacturing them
 * would be fabricating payment evidence.
 *
 * So the owner/super-admin benefit cannot be reached *through* the payment
 * path, and must not be. This module is the separate authority that reaches it:
 * a standing, operator-recorded, non-commercial concession.
 *
 * WHAT A GRANT IS
 *  - an explicit, out-of-band OPERATOR DECISION, taken by a named human with a
 *    stated reason, recorded as ONE immutable fact
 *    (`billing_entitlement_grants`, migration 0036);
 *  - a statement about an ACCOUNT, not about a sale — a granted account
 *    characteristically has no `subscriptions` row at all, which since Model C
 *    *is* the free state;
 *  - the only authority besides the activation fact that can move an
 *    entitlement above the free tier, and it is consulted through the same
 *    single resolver (`resolveEntitlements`).
 *
 * WHAT A GRANT IS NOT
 *  - NOT payment evidence and NOT a payment confirmation. The fact table has no
 *    `evidence_id`, `provider`, `provider_reference`, `provider_plan_id`,
 *    currency, amount, exponent, transaction id or `payment_confirmed` column —
 *    it is structurally incapable of representing a payment fact.
 *    `paymentConfirmed` on `GET /api/billing/me` stays derived from
 *    `billing_subscription_activations` alone and therefore stays `false` for a
 *    granted account, permanently and correctly.
 *  - NOT a subscription. Nothing here writes `subscriptions` or `users.plan`,
 *    creates a subscription row, locks a price or moves a lifecycle status. The
 *    granted tier is still gated by the authoritative lifecycle status through
 *    the existing `getEntitlements(plan, status)` matrix.
 *  - NOT reachable from HTTP. There is no grant route, no admin role, no
 *    operator endpoint and no grant token. The only writer is the
 *    DB-connected CLI (`scripts/billing/grant-entitlements.ts`).
 *  - NOT an execution grant. `canAccessAutomation` stays `false`; automation,
 *    live execution and broker execution stay OFF.
 *  - NOT reversible, by design. The fact is append-only (a re-grant or a tier
 *    change is a manual review, never a rewrite) and there is no revoke, so a
 *    grant made in error is reviewed out of band exactly like a mistaken
 *    activation fact.
 *
 * THE SERVICE GUARANTEES (in order)
 *  1. an explicit operator identity AND reason are required, bounded and
 *     credential-free;
 *  2. the account is located by email or uuid;
 *  3. the requested tier is a granted tier (`pro` / `premium`) — `free` and
 *     `starter` are refused;
 *  4. one client and one transaction;
 *  5. the account row is locked `FOR UPDATE`, so two concurrent grants
 *     serialize and the second replays;
 *  6. an existing grant is returned as an idempotent replay;
 *  7. a grant that would NARROW a higher tier the account already holds is
 *     refused (`would_narrow_paid_tier`) — a grant may only ADD;
 *  8. exactly one grant fact is inserted;
 *  9. the transactional `billing.entitlement_granted` audit event is inserted
 *     on the SAME transaction;
 * 10. both commit together;
 * 11. any failure rolls everything back, so a refusal leaves no trace;
 * 12. a dry run validates the whole operation — including the narrowing
 *     refusal — and writes NOTHING.
 *
 * WHAT IT NEVER DOES
 *  - it never calls Paystack or any provider — this module holds no provider, no
 *    transport and no credential, and it reads no key and no environment;
 *  - it never reads or writes `PAYSTACK_MODE`: a non-commercial grant belongs to
 *    no provider domain;
 *  - it never writes `subscriptions`, `users`, entitlements or execution state;
 *  - it never creates, registers, retires or touches a provider-plan epoch, a
 *    pricing snapshot, an FX version, a billing customer or any evidence row.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export const BILLING_ENTITLEMENT_GRANT_ERROR_REASONS = [
  /** Missing, oversized or credential-shaped operator identity or reason. */
  'invalid_operator_input',
  /** Malformed user reference or plan value. */
  'invalid_input',
  /** No user matches the given email or uuid. */
  'user_not_found',
  /** `free` is not a grantable tier, and `starter` has no enforced tier at all. */
  'forbidden_plan',
  /** The account already holds a grant. A re-grant is a manual review. */
  'grant_exists',
  /**
   * The account already holds a HIGHER provisioned tier, so granting this one
   * would narrow an entitlement it already has. A grant may only add.
   */
  'would_narrow_paid_tier',
  /** The database refused the row (constraint or append-only trigger). */
  'grant_refused',
] as const;
export type BillingEntitlementGrantErrorReason =
  (typeof BILLING_ENTITLEMENT_GRANT_ERROR_REASONS)[number];

/**
 * A grant refusal. NOTHING was written: the transaction is rolled back before
 * this is thrown, so the grant table and the audit log are exactly as they were.
 */
export class BillingEntitlementGrantError extends Error {
  readonly code = 'billing_entitlement_grant_refused' as const;

  constructor(
    readonly reason: BillingEntitlementGrantErrorReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingEntitlementGrantError';
  }
}

export function isBillingEntitlementGrantError(
  error: unknown,
): error is BillingEntitlementGrantError {
  return error instanceof BillingEntitlementGrantError;
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** The closed kind vocabulary. Exactly one kind exists today. */
export const BILLING_ENTITLEMENT_GRANT_KINDS = ['owner'] as const;
export type BillingEntitlementGrantKind = (typeof BILLING_ENTITLEMENT_GRANT_KINDS)[number];

/**
 * The grant kinds that may be used. Today only the designated owner/super-admin
 * concession is supported; `starter` is never grantable because it has no
 * enforced entitlement tier (it would hand out the free limits under a paid
 * name), and `free` is not a grant because granting it is a no-op.
 */
export const GRANTABLE_ENTITLEMENT_PLANS = ['pro', 'premium'] as const satisfies readonly UserPlan[];
export type GrantableEntitlementPlan = (typeof GRANTABLE_ENTITLEMENT_PLANS)[number];

/** Narrows an internal plan value to a grantable tier, or `null`. */
export function grantableEntitlementPlan(plan: string): GrantableEntitlementPlan | null {
  return (GRANTABLE_ENTITLEMENT_PLANS as readonly string[]).includes(plan)
    ? (plan as GrantableEntitlementPlan)
    : null;
}

/**
 * Ascending commercial order of the internal plan values, read from the
 * existing `USER_PLANS` authority rather than restated here: it is declared
 * `free < pro < premium`, so the index IS the rank and adding a tier appends it
 * in the right place.
 */
const ENTITLEMENT_TIER_RANK: Readonly<Record<UserPlan, number>> = Object.freeze(
  Object.fromEntries(USER_PLANS.map((plan, index) => [plan, index])) as Record<UserPlan, number>,
);

/**
 * A grant may only ever ADD a tier. This refuses the one case that would take
 * an entitlement away: an account that already holds a HIGHER tier, resolved by
 * the same `resolvePaidTier` the read path uses, so the guard can never
 * disagree with what a reader will later see.
 *
 * The comparison is against the PROVISIONED tier (the plan on the row), not
 * against a status-adjusted one, and that is deliberate: the granted tier is
 * status-gated the same way, so a grant could only ever move an account UP in
 * practice. A lapsed higher-tier subscription is therefore still a manual
 * review rather than a silently accepted downgrade.
 */
export function grantNarrowsPaidTier(
  paidTier: UserPlan,
  grantedPlan: GrantableEntitlementPlan,
): boolean {
  return ENTITLEMENT_TIER_RANK[paidTier] > ENTITLEMENT_TIER_RANK[grantedPlan];
}

/* -------------------------------------------------------------------------- */
/* The grant fact                                                             */
/* -------------------------------------------------------------------------- */

export interface BillingEntitlementGrant {
  id: string;
  /** The account the grant was issued to. */
  userId: string;
  /** The internal plan value whose enforced tier is granted (`pro`/`premium`). */
  plan: UserPlan;
  /** What kind of grant this is. Closed vocabulary; today only `owner`. */
  kind: BillingEntitlementGrantKind;
  /** The operator who issued the grant, out of band. */
  operatorId: string;
  /** The operator-stated reason. */
  grantReason: string;
  grantedAt: string;
  idempotencyKey: string;
  createdAt: string;
}

/**
 * Canonical string the grant idempotency key is the SHA-256 of. It is derived
 * ONLY from fields no client can supply — the closed kind vocabulary, the
 * resolved account id and the granted tier — so the same grant always hashes to
 * the same key and a replay collapses onto the one existing row.
 */
export function billingEntitlementGrantIdempotencyCanonicalString(input: {
  kind: BillingEntitlementGrantKind;
  userId: string;
  plan: UserPlan;
}): string {
  return ['billing-entitlement-grant/v1', input.kind, input.userId, input.plan].join('|');
}

/** Deterministic idempotency key for one grant. */
export function billingEntitlementGrantIdempotencyKey(input: {
  kind: BillingEntitlementGrantKind;
  userId: string;
  plan: UserPlan;
}): string {
  return createHash('sha256')
    .update(billingEntitlementGrantIdempotencyCanonicalString(input))
    .digest('hex');
}

/** The transactional audit action a grant writes. */
export const BILLING_ENTITLEMENT_GRANT_AUDIT_ACTION = 'billing.entitlement_granted';

/* -------------------------------------------------------------------------- */
/* Row contract                                                               */
/* -------------------------------------------------------------------------- */

const isoDateTime = z.string().datetime();
const uuid = z.string().uuid();

const grantRowSchema = z
  .object({
    id: uuid,
    user_id: uuid,
    plan: z.enum(['pro', 'premium']),
    grant_kind: z.literal('owner'),
    operator_id: z.string().min(1).max(128),
    grant_reason: z.string().min(1).max(500),
    granted_at: z
      .union([z.date(), isoDateTime])
      .transform((value) => new Date(value).toISOString()),
    idempotency_key: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z
      .union([z.date(), isoDateTime])
      .transform((value) => new Date(value).toISOString()),
    updated_at: z
      .union([z.date(), isoDateTime])
      .transform((value) => new Date(value).toISOString()),
  })
  .strict();

function fromGrantRow(row: unknown): BillingEntitlementGrant {
  const parsed = grantRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new BillingEntitlementGrantError(
      'grant_refused',
      `The stored entitlement grant is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
      { cause: parsed.error },
    );
  }
  const r = parsed.data;
  const expectedKey = billingEntitlementGrantIdempotencyKey({
    kind: r.grant_kind,
    userId: r.user_id,
    plan: r.plan,
  });
  if (expectedKey !== r.idempotency_key) {
    throw new BillingEntitlementGrantError(
      'grant_refused',
      'The stored grant idempotency key does not verify against its identity.',
    );
  }
  return {
    id: r.id,
    userId: r.user_id,
    plan: r.plan,
    kind: r.grant_kind,
    operatorId: r.operator_id,
    grantReason: r.grant_reason,
    grantedAt: r.granted_at,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* The store — thin read access. Never writes.                                 */
/* -------------------------------------------------------------------------- */

export class BillingEntitlementGrantStore {
  constructor(private readonly db: Pick<Pool | PoolClient, 'query'>) {}

  /** The grant fact for an account, or `null`. */
  async findByUserId(userId: string): Promise<BillingEntitlementGrant | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM billing_entitlement_grants WHERE user_id = $1',
      [userId],
    );
    return rows[0] === undefined ? null : fromGrantRow(rows[0]);
  }

  async findById(id: string): Promise<BillingEntitlementGrant | null> {
    const { rows } = await this.db.query('SELECT * FROM billing_entitlement_grants WHERE id = $1', [
      id,
    ]);
    return rows[0] === undefined ? null : fromGrantRow(rows[0]);
  }

  /**
   * The granted tier for an account, or `null`.
   *
   * This is the read every entitlement reader uses. It is a narrow projection
   * of the ONE column the resolver needs: no operator, no reason, no id, no
   * timestamp, and above all no payment-shaped field — because the table has
   * none. `null` is the fail-closed answer, so a reader that forgets to call it
   * (or an account with no grant) resolves to the ordinary free path.
   */
  async grantedPlanFor(userId: string): Promise<UserPlan | null> {
    const { rows } = await this.db.query<{ plan: UserPlan }>(
      'SELECT plan FROM billing_entitlement_grants WHERE user_id = $1',
      [userId],
    );
    return rows[0]?.plan ?? null;
  }

  /** Whether an account holds a grant fact. */
  async hasGrant(userId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM billing_entitlement_grants WHERE user_id = $1',
      [userId],
    );
    return rows.length > 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Input validation (operator authorization is explicit, never inferred)      */
/* -------------------------------------------------------------------------- */

const OPERATOR_ID_MAX = 128;
const REASON_MAX = 500;
const USER_REF_MAX = 320;

/** Credential-shaped text is never an operator identity or a reason. */
const CREDENTIAL_SHAPE = BILLING_CREDENTIAL_SHAPED_RE;

export function assertEntitlementGrantOperatorId(operatorId: string): string {
  const value = operatorId.trim();
  if (value.length === 0 || value.length > OPERATOR_ID_MAX) {
    throw new BillingEntitlementGrantError(
      'invalid_operator_input',
      'Grant refused: an explicit operator identity is required (1-128 characters).',
    );
  }
  if (CREDENTIAL_SHAPE.test(value)) {
    throw new BillingEntitlementGrantError(
      'invalid_operator_input',
      'Grant refused: the operator identity must not be credential-shaped.',
    );
  }
  return value;
}

export function assertEntitlementGrantReason(reason: string): string {
  const value = reason.trim();
  if (value.length === 0 || value.length > REASON_MAX) {
    throw new BillingEntitlementGrantError(
      'invalid_operator_input',
      'Grant refused: an explicit grant reason is required (1-500 characters).',
    );
  }
  if (CREDENTIAL_SHAPE.test(value)) {
    throw new BillingEntitlementGrantError(
      'invalid_operator_input',
      'Grant refused: the grant reason must not be credential-shaped.',
    );
  }
  return value;
}

/**
 * The tier gate. `starter` is refused because it has no enforced entitlement
 * tier — granting it would hand out the free limits under a paid name — and
 * `free` is refused because granting the free tier is a no-op that would still
 * record a fact. The same `USER_PLANS` vocabulary the stored plan values use is
 * the only thing accepted, so no other spelling can reach the table.
 */
export function assertGrantableEntitlementPlan(plan: string): GrantableEntitlementPlan {
  if (plan === 'starter') {
    throw new BillingEntitlementGrantError(
      'forbidden_plan',
      'Grant refused: starter is a catalogue concept with no enforced entitlement tier, so it is not grantable.',
    );
  }
  const grantable = grantableEntitlementPlan(plan);
  if (grantable === null) {
    throw new BillingEntitlementGrantError(
      'forbidden_plan',
      `Grant refused: "${plan}" is not a grantable tier. Grantable tiers are ${GRANTABLE_ENTITLEMENT_PLANS.join(' and ')}.`,
    );
  }
  return grantable;
}

const grantInputSchema = z
  .object({
    /** The account to grant to: an email address or a user uuid. */
    user: z.string().trim().min(1).max(USER_REF_MAX),
    /** The internal tier to grant: `pro` (commercial Pro) or `premium` (Elite). */
    plan: z.string().trim(),
    /** The operator issuing the grant. Required, never inferred. */
    operatorId: z.string().trim(),
    /** Why the operator issued it. Required, never inferred. */
    reason: z.string().trim(),
    /** Optional explicit grant kind. Defaults to the only kind, `owner`. */
    kind: z.enum(BILLING_ENTITLEMENT_GRANT_KINDS).optional(),
    /** Optional explicit grant instant (tests/backfills only). */
    grantedAt: isoDateTime.optional(),
  })
  .strict();

export interface BillingEntitlementGrantRequest {
  user: string;
  plan: string;
  operatorId: string;
  reason: string;
  kind?: BillingEntitlementGrantKind;
  grantedAt?: string;
}

/* -------------------------------------------------------------------------- */
/* The result                                                                 */
/* -------------------------------------------------------------------------- */

export interface BillingEntitlementGrantResult {
  /** `granted` wrote the fact; `already_granted` replayed it; `dry_run` wrote nothing. */
  outcome: 'granted' | 'already_granted' | 'dry_run';
  /** True exactly when nothing was written. */
  dryRun: boolean;
  /** The grant fact (the existing one on a replay, the candidate on a dry run). */
  grant: BillingEntitlementGrant;
  /** The account the grant was issued to. */
  userId: string;
  /** The account's email, as stored. */
  userEmail: string;
  /**
   * Pinned false: a grant is not a payment, so it never confirms one.
   * `paymentConfirmed` is derived from the 0034 activation fact alone.
   */
  paymentConfirmed: false;
  /** Pinned false: a grant writes no plan column and moves no subscription. */
  planChanged: false;
  /** Pinned false: the read side is what widens, never the write. */
  entitlementsChanged: false;
  /** Pinned false: a grant never grants execution. */
  grantsExecution: false;
  /** Pinned false: `canAccessAutomation` stays false in every tier. */
  canAccessAutomation: false;
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export interface BillingEntitlementGrantOptions {
  db: Pool;
  now?: () => Date;
  /**
   * Validate the complete operation and write NOTHING — no grant fact, no
   * audit event. A dry run opens the same read-only work the real run performs
   * and reports the candidate fact it would have written.
   */
  dryRun?: boolean;
}

export class BillingEntitlementGrantService {
  private readonly now: () => Date;

  constructor(private readonly options: BillingEntitlementGrantOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Authorize a non-commercial entitlement grant for one account.
   *
   * Everything happens on ONE client inside ONE transaction: the account row is
   * locked `FOR UPDATE`, the grant fact and its audit event are inserted, and
   * both commit together. Any refusal rolls the whole thing back, so a failed
   * grant leaves no trace at all.
   */
  async grant(input: BillingEntitlementGrantRequest): Promise<BillingEntitlementGrantResult> {
    const parsed = grantInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BillingEntitlementGrantError(
        'invalid_input',
        `The grant request is not canonical: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        { cause: parsed.error },
      );
    }
    const request = parsed.data;

    // 1. Explicit operator + reason. Both required, bounded and credential-free;
    //    neither is ever inferred from a session.
    const operatorId = assertEntitlementGrantOperatorId(request.operatorId);
    const reason = assertEntitlementGrantReason(request.reason);

    // 3. The tier gate, before a single row is read.
    const plan = assertGrantableEntitlementPlan(request.plan);
    const kind = request.kind ?? 'owner';

    const client = await this.options.db.connect();
    try {
      if (this.options.dryRun) {
        // 11. A dry run reads exactly what the real run reads and writes
        //     nothing at all — no fact, no audit event.
        await client.query('BEGIN READ ONLY');
        try {
          const user = await this.readUser(client, request.user);
          if (user === null) {
            throw new BillingEntitlementGrantError(
              'user_not_found',
              'Grant refused: no user matches the given email or identifier.',
            );
          }
          const existing = await new BillingEntitlementGrantStore(client).findByUserId(user.id);
          if (existing !== null) {
            if (existing.plan !== plan) {
              throw new BillingEntitlementGrantError(
                'grant_exists',
                `Grant refused: the account already holds a "${existing.plan}" grant, and a grant is append-only. Changing the tier is a manual review, never a silent overwrite.`,
              );
            }
            await client.query('COMMIT');
            return replayResult(existing, user, true);
          }
          // 7. A grant may only ADD. A dry run reports the refusal the real
          //    run would raise, before it would have written anything.
          await this.assertGrantDoesNotNarrow(client, user.id, plan);
          const candidate = candidateGrant({
            userId: user.id,
            plan,
            kind,
            operatorId,
            reason,
            grantedAt: request.grantedAt ?? this.now().toISOString(),
          });
          await client.query('COMMIT');
          return dryRunResult(candidate, user);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }

      await client.query('BEGIN');
      try {
        // 2. Locate the account (email or uuid).
        const user = await this.readUser(client, request.user);
        if (user === null) {
          throw new BillingEntitlementGrantError(
            'user_not_found',
            'Grant refused: no user matches the given email or identifier.',
          );
        }

        // 5. Lock the account row for the whole transaction, so two concurrent
        //    grants serialize on it and the second replays.
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);

        // 6. Idempotent replay: an existing grant is returned as-is. A grant at
        //    a DIFFERENT tier is NOT a replay though — the operator asked for
        //    something this account does not hold, and handing back the old tier
        //    as a success would be a false "done". That is a manual review.
        const existing = await new BillingEntitlementGrantStore(client).findByUserId(user.id);
        if (existing !== null) {
          if (existing.plan !== plan) {
            throw new BillingEntitlementGrantError(
              'grant_exists',
              `Grant refused: the account already holds a "${existing.plan}" grant, and a grant is append-only. Changing the tier is a manual review, never a silent overwrite.`,
            );
          }
          await client.query('COMMIT');
          return replayResult(existing, user, false);
        }

        // 7. A grant may only ADD a tier. The account row is already locked,
        //    so the paid tier read here cannot change under us, and a
        //    narrowing grant is refused before a single fact is written.
        await this.assertGrantDoesNotNarrow(client, user.id, plan);

        const grant = candidateGrant({
          userId: user.id,
          plan,
          kind,
          operatorId,
          reason,
          grantedAt: request.grantedAt ?? this.now().toISOString(),
        });

        // 8. Exactly one grant fact.
        let inserted: BillingEntitlementGrant;
        try {
          const result = await client.query(
            `INSERT INTO billing_entitlement_grants (
               user_id, plan, grant_kind, operator_id, grant_reason, granted_at, idempotency_key
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
            [
              grant.userId,
              grant.plan,
              grant.kind,
              grant.operatorId,
              grant.grantReason,
              grant.grantedAt,
              grant.idempotencyKey,
            ],
          );
          if (result.rows[0] === undefined) {
            // Lost the race on the deterministic key: return the winner's fact
            // so a concurrent grant replays rather than duplicating.
            const winner = await new BillingEntitlementGrantStore(client).findByUserId(user.id);
            if (winner === null) {
              throw new BillingEntitlementGrantError(
                'grant_refused',
                'Grant refused: a conflicting grant fact already exists for this account.',
              );
            }
            await client.query('COMMIT');
            return replayResult(winner, user, false);
          }
          inserted = fromGrantRow(result.rows[0]);
        } catch (error) {
          if (isBillingEntitlementGrantError(error)) throw error;
          throw mapDatabaseRefusal(error, user.id);
        }

        // 9. The transactional audit event, on the SAME client/transaction.
        try {
          await recordAuditEvent(client, {
            userId: user.id,
            action: BILLING_ENTITLEMENT_GRANT_AUDIT_ACTION,
            entityType: 'user',
            entityId: user.id,
            metadata: {
              grantId: inserted.id,
              grantKind: inserted.kind,
              plan: inserted.plan,
              operatorId: inserted.operatorId,
              grantReason: inserted.grantReason,
              grantedAt: inserted.grantedAt,
              idempotencyKey: inserted.idempotencyKey,
              // Explicitly recorded so the audit trail can never be misread:
              // this fact is not a payment and confirms none.
              paymentConfirmed: false,
              grantsExecution: false,
            },
          });
        } catch (error) {
          if (isBillingEntitlementGrantError(error)) throw error;
          throw new BillingEntitlementGrantError(
            'grant_refused',
            'Grant refused: the audit event could not be written, so nothing was recorded.',
            { cause: error },
          );
        }

        // 10. Both commit together.
        await client.query('COMMIT');
        return grantedResult(inserted, user);
      } catch (error) {
        // 10. Any failure rolls everything back, so a refusal leaves no trace.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private async readUser(
    client: PoolClient,
    reference: string,
  ): Promise<{ id: string; email: string } | null> {
    const asUuid = z.string().uuid().safeParse(reference);
    const { rows } = asUuid.success
      ? await client.query<{ id: string; email: string }>(
          'SELECT id, email FROM users WHERE id = $1',
          [reference],
        )
      : await client.query<{ id: string; email: string }>(
          'SELECT id, email FROM users WHERE email = $1',
          [reference],
        );
    return rows[0] ?? null;
  }

  /**
   * The tier this account holds WITHOUT any operator grant, or `'free'`.
   *
   * Deliberately the same `users`-anchored LEFT JOIN every entitlement reader
   * uses (`getBillingState`, the scanner, the strategy/setup/alert readers), so
   * the guard and the readers observe one identical fact set. It is a read
   * only: it never writes, and `subscriptions` is UNIQUE on `user_id`, so there
   * is no row ambiguity to resolve.
   */
  private async readPaidTier(client: PoolClient, userId: string): Promise<UserPlan> {
    const { rows } = await client.query<{
      plan: string | null;
      provider: string | null;
      activated: boolean;
    }>(
      `SELECT sub.plan, sub.provider,
              EXISTS (SELECT 1 FROM billing_subscription_activations a
                       WHERE a.subscription_id = sub.id) AS activated
         FROM users u
         LEFT JOIN subscriptions sub ON sub.user_id = u.id
        WHERE u.id = $1`,
      [userId],
    );
    // A row-less account (the Model C free state, and the owner use case) has no
    // provider and no plan, which resolves to free — so the intended grant path
    // is untouched by this guard.
    const row = rows[0];
    if (row === undefined || row.plan === null) return 'free';
    return resolvePaidTier(
      row.plan as UserPlan,
      row.provider,
      row.activated === true,
    );
  }

  /**
   * Refuse a grant that would narrow what the account already holds. Called
   * inside the grant transaction, after the account row is locked, and in the
   * dry run too — so a dry run reports exactly what the real run would refuse.
   */
  private async assertGrantDoesNotNarrow(
    client: PoolClient,
    userId: string,
    plan: GrantableEntitlementPlan,
  ): Promise<void> {
    const paidTier = await this.readPaidTier(client, userId);
    if (!grantNarrowsPaidTier(paidTier, plan)) return;
    throw new BillingEntitlementGrantError(
      'would_narrow_paid_tier',
      `Grant refused: the account already holds a provisioned "${paidTier}" tier, and granting "${plan}" would narrow an entitlement it has. A grant may only add a tier the account does not already hold. This is a manual review, never a silent downgrade.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The fact a grant WOULD write, with the deterministic identity derived
 * server-side. The `id` is the zero uuid: only a committed INSERT produces a
 * real one, and a dry run must never present an id that does not exist.
 */
function candidateGrant(input: {
  userId: string;
  plan: GrantableEntitlementPlan;
  kind: BillingEntitlementGrantKind;
  operatorId: string;
  reason: string;
  grantedAt: string;
}): BillingEntitlementGrant {
  const zero = '00000000-0000-0000-0000-000000000000';
  return {
    id: zero,
    userId: input.userId,
    plan: input.plan,
    kind: input.kind,
    operatorId: input.operatorId,
    grantReason: input.reason,
    grantedAt: new Date(input.grantedAt).toISOString(),
    idempotencyKey: billingEntitlementGrantIdempotencyKey({
      kind: input.kind,
      userId: input.userId,
      plan: input.plan,
    }),
    createdAt: new Date(input.grantedAt).toISOString(),
  };
}

const NO_GRANT_EFFECT = {
  paymentConfirmed: false,
  planChanged: false,
  entitlementsChanged: false,
  grantsExecution: false,
  canAccessAutomation: false,
} as const;

function grantedResult(
  grant: BillingEntitlementGrant,
  user: { id: string; email: string },
): BillingEntitlementGrantResult {
  return { outcome: 'granted', dryRun: false, grant, userId: user.id, userEmail: user.email, ...NO_GRANT_EFFECT };
}

function replayResult(
  grant: BillingEntitlementGrant,
  user: { id: string; email: string },
  dryRun: boolean,
): BillingEntitlementGrantResult {
  return {
    outcome: 'already_granted',
    dryRun,
    grant,
    userId: user.id,
    userEmail: user.email,
    ...NO_GRANT_EFFECT,
  };
}

function dryRunResult(
  grant: BillingEntitlementGrant,
  user: { id: string; email: string },
): BillingEntitlementGrantResult {
  return { outcome: 'dry_run', dryRun: true, grant, userId: user.id, userEmail: user.email, ...NO_GRANT_EFFECT };
}

/**
 * Map a database refusal to a typed error. The database is the last line of
 * defence here: the `plan`/`grant_kind` CHECKs, the unique `user_id` index, the
 * credential-shape CHECK and the append-only trigger all refuse independently of
 * the service.
 */
function mapDatabaseRefusal(error: unknown, userId: string): BillingEntitlementGrantError {
  const code = (error as { code?: unknown } | null)?.code;
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  const name = typeof constraint === 'string' ? constraint : '';
  const message = error instanceof Error ? error.message : String(error);

  if (code === '23505') {
    // The unique user_id index: this account already holds a grant. Reported
    // as a refusal, never as a second row.
    return new BillingEntitlementGrantError(
      'grant_exists',
      'Grant refused: the account already holds an entitlement grant. A re-grant is a manual review, not a second fact.',
      { cause: error },
    );
  }
  if (code === '23514' || code === '27000') {
    return new BillingEntitlementGrantError(
      'grant_refused',
      `Grant refused by the database for this account (${name || 'constraint'}): ${message}`,
      { cause: error },
    );
  }
  if (code === '23503') {
    return new BillingEntitlementGrantError(
      'user_not_found',
      `Grant refused: the account ${userId} does not exist.`,
      { cause: error },
    );
  }
  return new BillingEntitlementGrantError('grant_refused', `Grant refused: ${message}`, {
    cause: error,
  });
}

/** Re-exported so callers can assert the stored plan vocabulary is unchanged. */
export const ENTITLEMENT_GRANT_PLAN_VOCABULARY = USER_PLANS;
