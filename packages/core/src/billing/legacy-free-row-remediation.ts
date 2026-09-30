/**
 * Billing — LEGACY FREE ROW REMEDIATION (the out-of-band operator path).
 *
 * The reported production symptom: a valid live checkout answers
 * `pricing_lock_required` (HTTP 409) on an account that has never bought
 * anything. The model is not broken — the row is. Accounts created before
 * Model C (migration 0014's backfill, or the removed eager registration
 * behaviour) carry a `subscriptions` row with `plan = 'free'`, no provider
 * identity and `locked_pricing_snapshot_id IS NULL`. Model C makes that lock
 * immutable at creation (0032), so such a row can never become commercial: the
 * only thing it can do is make the first checkout fail closed at
 * `checkout.ts` (`pricing_lock_required`). It is a placeholder for a sale that
 * never happened.
 *
 * WHY DELETION IS THE FIX, AND WHY IT CHANGES NOTHING ELSE. Since Model C the
 * free state IS the ABSENCE of a commercial record — `getBillingState` and
 * every entitlement reader resolve a missing row to the free answer
 * (`plan: 'free'`, `status: 'active'`, `paymentConfirmed: false`,
 * `FREE_ENTITLEMENTS`, `canAccessAutomation: false`, and `subscription.id = ''`
 * because nothing was ever sold, so there is no commercial identity to
 * report). A legacy `free`/`active`/provider-less row resolves to exactly the
 * same plan, status, period, cancellation and provider facts and the same
 * entitlements; the only reported difference after removal is that identity
 * field, which becomes the documented `''`. Removing the row is therefore
 * entitlement-neutral BY CONSTRUCTION: it restores the account to the
 * supported free state, after which the next checkout takes the normal
 * row-less path (active epoch → pinned FX pricing decision → snapshot + sold
 * subscription + immutable lock, atomically).
 *
 * WHY A CLI AND NOT A ROUTE, A MIGRATION OR A RUNAWAY JOB. `docs/billing.md`
 * is explicit: legacy NULL-lock rows "are handled by operators out of band",
 * there is "no remediation path, no migration, no backfill and no repair job",
 * and 0032's trigger must never be "fixed". This module is that out-of-band
 * handling and nothing more: an operator, a reason and one named account, run
 * through `scripts/billing/remediate-legacy-free-row.ts`. There is deliberately
 * no HTTP route, no admin role, no job and no automatic behaviour: nothing here
 * runs unless a named human runs it, so a deploy can never destroy a record.
 *
 * WHAT IT WILL NOT DO
 *  - it never weakens or bypasses the pricing lock: the lock column is only
 *    ever READ, never written, and the 0032 trigger is left alone (it is a
 *    BEFORE UPDATE guard, so a DELETE does not touch it);
 *  - it never UPDATEs anything — not the row, not `users.plan`, not an epoch,
 *    not FX. The tool's only write is one DELETE plus its audit event;
 *  - it never touches a sold row. A commercial row (provider-backed, locked),
 *    a paid `plan`, a row bound to a billing customer, a row with period or
 *    cancellation facts, a row some writer has synced, a row whose owning
 *    account claims a paid `users.plan` — every one of them is REFUSED and
 *    left for manual review;
 *  - it never deletes evidence. `billing_provider_events`,
 *    `billing_verified_transactions` and `billing_subscription_activations`
 *    all reference `subscriptions` ON DELETE CASCADE, so a DELETE could
 *    silently erase payment evidence. The eligibility predicate therefore
 *    requires ZERO rows in all three — on top of the database's own
 *    `billing_provider_events` retention trigger — and any evidence makes the
 *    whole operation refuse;
 *  - it reads no provider configuration, holds no transport and creates no
 *    secret: a placeholder row carries no provider domain, so the only
 *    configuration is `DATABASE_URL`.
 *
 * FAIL CLOSED, ALWAYS. Eligibility is asserted twice: as named boolean
 * predicates the operator can see (the refusal reports exactly which ones
 * failed), and again inside the DELETE's own WHERE clause, which is the
 * authority. If that DELETE does not remove exactly the one anticipated row,
 * the transaction rolls back and the tool refuses — a row that changed under
 * the operator's feet is never deleted on stale terms.
 *
 * AUDITED, TRANSACTIONALLY. Each removal writes exactly one
 * `billing.legacy_free_row_removed` audit event carrying the operator, the
 * reason and a snapshot of the deleted row's facts — on the SAME client, inside
 * the SAME transaction as the DELETE. There is therefore no such thing as an
 * unattributed removal: if the audit write fails, the row survives.
 */
import { z } from 'zod';
import type { Pool } from 'pg';
import { BILLING_CREDENTIAL_SHAPED_RE } from '@veltrixeye/contracts';
import { recordAuditEvent } from '../audit.js';

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

export const BILLING_LEGACY_FREE_ROW_REMEDIATION_ERROR_REASONS = [
  /** `--by` / `--reason` missing, blank, oversized or credential-shaped. */
  'invalid_operator',
  /** The reference is neither a uuid nor a known account (uuid or email). */
  'unknown_user',
  /** The account has a `subscriptions` row that is NOT a legacy free placeholder. */
  'no_legacy_free_row',
  /** The row changed between the eligibility check and the DELETE. */
  'concurrent_change',
] as const;
export type BillingLegacyFreeRowRemediationErrorReason =
  (typeof BILLING_LEGACY_FREE_ROW_REMEDIATION_ERROR_REASONS)[number];

/**
 * A remediation refusal. NOTHING was written: the transaction is rolled back
 * before this is thrown, so the subscription row, the audit log and every
 * other row are exactly as they were.
 */
export class BillingLegacyFreeRowRemediationError extends Error {
  readonly code = 'billing_legacy_free_row_remediation_refused' as const;

  constructor(
    readonly reason: BillingLegacyFreeRowRemediationErrorReason,
    message: string,
    /** Which named predicates failed; present for row refusals. */
    readonly failedPredicates?: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BillingLegacyFreeRowRemediationError';
  }
}

export function isBillingLegacyFreeRowRemediationError(
  error: unknown,
): error is BillingLegacyFreeRowRemediationError {
  return error instanceof BillingLegacyFreeRowRemediationError;
}

/* -------------------------------------------------------------------------- */
/* The audit action                                                           */
/* -------------------------------------------------------------------------- */

/** The one audit action this tool writes, one row per removed placeholder. */
export const BILLING_LEGACY_FREE_ROW_REMEDIATION_AUDIT_ACTION =
  'billing.legacy_free_row_removed';

/* -------------------------------------------------------------------------- */
/* The eligibility predicate — ONE declared source, used three times          */
/* -------------------------------------------------------------------------- */

/**
 * Every condition a row must satisfy to be removable. The list is the single
 * source of truth: it renders the WHERE clause of the authoritative DELETE,
 * the boolean diagnostics reported on a refusal, and the documentation below.
 *
 * READ IT AS: "this row is the pre-Model-C free placeholder — nothing has ever
 * been sold, provided, priced, synced, cancelled or evidenced against it."
 */
export const LEGACY_FREE_ROW_PREDICATES: ReadonlyArray<{
  readonly name: string;
  readonly sql: string;
}> = [
  // The sale facts. A sold row carries a catalogue plan, an interval and a
  // lock; a legacy placeholder carries none of them.
  { name: 'plan_is_free', sql: "s.plan = 'free'" },
  { name: 'status_is_active', sql: "s.status = 'active'" },
  { name: 'catalogue_plan_is_null', sql: 's.catalogue_plan IS NULL' },
  { name: 'billing_interval_is_null', sql: 's.billing_interval IS NULL' },
  { name: 'catalogue_version_is_null', sql: 's.catalogue_version IS NULL' },
  { name: 'provider_plan_id_is_null', sql: 's.provider_plan_id IS NULL' },
  // THE reported bug: the row Model C refuses. Required to be NULL — and, as
  // the row is provider-less, the database's own binding check guarantees the
  // seven provider-identity columns below are NULL too. They are asserted
  // anyway: the DELETE must state the whole fact, not rely on a side effect.
  { name: 'pricing_lock_is_null', sql: 's.locked_pricing_snapshot_id IS NULL' },
  { name: 'provider_is_null', sql: 's.provider IS NULL' },
  { name: 'provider_state_is_null', sql: 's.provider_state IS NULL' },
  { name: 'provider_customer_id_is_null', sql: 's.provider_customer_id IS NULL' },
  { name: 'provider_subscription_id_is_null', sql: 's.provider_subscription_id IS NULL' },
  { name: 'provider_subscription_code_is_null', sql: 's.provider_subscription_code IS NULL' },
  { name: 'provider_reference_is_null', sql: 's.provider_reference IS NULL' },
  // A row bound to a provisioning customer is commercial state, not a placeholder.
  { name: 'billing_customer_id_is_null', sql: 's.billing_customer_id IS NULL' },
  // Period and cancellation facts exist only on rows something sold or scheduled.
  { name: 'current_period_start_is_null', sql: 's.current_period_start IS NULL' },
  { name: 'current_period_end_is_null', sql: 's.current_period_end IS NULL' },
  { name: 'cancel_at_period_end_is_false', sql: 's.cancel_at_period_end = false' },
  { name: 'cancel_at_is_null', sql: 's.cancel_at IS NULL' },
  { name: 'cancelled_at_is_null', sql: 's.cancelled_at IS NULL' },
  { name: 'cancellation_reason_is_null', sql: 's.cancellation_reason IS NULL' },
  // Sync bookkeeping at its creation defaults only: anything else means a
  // provider-facing writer has touched this row.
  { name: 'sync_state_is_never_synced', sql: "s.sync_state = 'never_synced'" },
  { name: 'last_sync_source_is_none', sql: "s.last_sync_source = 'none'" },
  { name: 'last_synced_at_is_null', sql: 's.last_synced_at IS NULL' },
  { name: 'sync_required_is_false', sql: 's.sync_required = false' },
  { name: 'last_event_idempotency_key_is_null', sql: 's.last_event_idempotency_key IS NULL' },
  { name: 'state_version_is_initial', sql: 's.state_version = 1' },
  // The account's enforcement column (never written by any code path) must
  // still say free: a paid `users.plan` is an operator decision this tool
  // must not silently contradict.
  { name: 'account_plan_is_free', sql: "u.plan = 'free'" },
  // THE CASCADE GUARD. All three reference `subscriptions` ON DELETE CASCADE,
  // so deleting a referenced row would take evidence with it. Zero rows in
  // all three, or the tool refuses.
  {
    name: 'no_provider_events',
    sql: 'NOT EXISTS (SELECT 1 FROM billing_provider_events e WHERE e.subscription_id = s.id)',
  },
  {
    name: 'no_verified_transactions',
    sql:
      'NOT EXISTS (SELECT 1 FROM billing_verified_transactions t WHERE t.subscription_id = s.id)',
  },
  {
    name: 'no_activations',
    sql:
      'NOT EXISTS (SELECT 1 FROM billing_subscription_activations a WHERE a.subscription_id = s.id)',
  },
];

/** The predicate as SQL, for the authoritative DELETE and the diagnostics read. */
const PREDICATE_SQL = LEGACY_FREE_ROW_PREDICATES.map((p) => p.sql).join('\n    AND ');

/** The facts a removed row is reported (and audited) with. */
const ROW_FACTS_COLUMNS = `s.id, s.plan, s.status, s.provider, s.catalogue_plan,
  s.billing_interval, s.locked_pricing_snapshot_id, s.created_at, s.updated_at`;

interface RowFactsRow {
  id: string;
  plan: string;
  status: string;
  provider: string | null;
  catalogue_plan: string | null;
  billing_interval: string | null;
  locked_pricing_snapshot_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The durable facts of the removed placeholder — also the audit payload. */
export interface LegacyFreeRowFacts {
  subscriptionId: string;
  plan: string;
  status: string;
  provider: null;
  cataloguePlan: null;
  billingInterval: null;
  lockedPricingSnapshotId: null;
  createdAt: string;
  updatedAt: string;
}

function toRowFacts(row: RowFactsRow): LegacyFreeRowFacts {
  // Every nullable field of an eligible row IS null by predicate. Reported as
  // literal nulls: the record states what was verified, not what was read.
  return {
    subscriptionId: row.id,
    plan: row.plan,
    status: row.status,
    provider: null,
    cataloguePlan: null,
    billingInterval: null,
    lockedPricingSnapshotId: null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export interface BillingLegacyFreeRowRemediationOptions {
  db: Pool;
  /** Injected clock for the reported removal instant (tests pin it). */
  now?: () => Date;
}

export interface RemediateLegacyFreeRowInput {
  /** The account whose legacy placeholder is removed: uuid or email. */
  user: string;
  /** The named human performing the remediation (audited verbatim). */
  operatorId: string;
  /** Why it is being performed (audited verbatim). */
  reason: string;
  /**
   * `true` commits the removal (DELETE + audit event). The default — and the
   * only other accepted value — is `false`: a read-only dry run that validates
   * the whole operation and writes nothing.
   */
  apply?: boolean;
}

export type BillingLegacyFreeRowRemediationOutcome =
  /** Eligible, validated, nothing written (dry run). */
  | 'dry_run'
  /** The row was deleted and its audit event committed with it. */
  | 'removed'
  /** The account has no `subscriptions` row: the supported free state already. */
  | 'absent';

export interface BillingLegacyFreeRowRemediationResult {
  outcome: BillingLegacyFreeRowRemediationOutcome;
  /** True only for `removed`: the DELETE and its audit event were committed. */
  applied: boolean;
  userId: string;
  email: string;
  /** The removed/pending placeholder's facts; `null` when outcome is `absent`. */
  row: LegacyFreeRowFacts | null;
  /** The audit action written; `null` unless outcome is `removed`. */
  auditAction: string | null;
  /** The reported removal instant; `null` unless outcome is `removed`. */
  removedAt: string | null;
}

const OPERATOR_ID_MAX = 128;
const REASON_MAX = 500;

/**
 * Validate one piece of operator identity/justification text: present, within
 * its documented bound, and NEVER credential-shaped (the audit record names a
 * human and a reason — not a key, a token or a password).
 */
function operatorTextOrRefuse(kind: string, value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new BillingLegacyFreeRowRemediationError(
      'invalid_operator',
      `The ${kind} is required: a remediation names the operator (--by) and the reason (--reason). ` +
        'Nothing was written.',
    );
  }
  if (trimmed.length > max) {
    throw new BillingLegacyFreeRowRemediationError(
      'invalid_operator',
      `The ${kind} must be at most ${max} characters. Nothing was written.`,
    );
  }
  if (BILLING_CREDENTIAL_SHAPED_RE.test(trimmed)) {
    throw new BillingLegacyFreeRowRemediationError(
      'invalid_operator',
      `The ${kind} is credential-shaped and is refused: the remediation record names an operator ` +
        'and a reason, never key, token or password material. Nothing was written.',
    );
  }
  return trimmed;
}

export class BillingLegacyFreeRowRemediationService {
  constructor(private readonly options: BillingLegacyFreeRowRemediationOptions) {}

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  /**
   * Validate — and, with `apply: true`, perform — the removal of ONE legacy
   * free placeholder row.
   *
   * Refuses (throwing, with nothing written) when the reference is ambiguous,
   * when the account has a row that is not the placeholder, or when the row
   * changed between the check and the DELETE. Answers `absent` when there is
   * no row at all: `absent` is a finding, not a refusal — the account already
   * IS the supported free state.
   */
  async remediate(
    input: RemediateLegacyFreeRowInput,
  ): Promise<BillingLegacyFreeRowRemediationResult> {
    const reference = input.user.trim();
    if (reference === '') {
      throw new BillingLegacyFreeRowRemediationError(
        'unknown_user',
        'The account reference is required: pass the uuid or the email. Nothing was written.',
      );
    }
    const operatorId = operatorTextOrRefuse('operator id', input.operatorId, OPERATOR_ID_MAX);
    const reason = operatorTextOrRefuse('reason', input.reason, REASON_MAX);
    const apply = input.apply === true;

    const user = await this.readUser(reference);
    if (user === null) {
      throw new BillingLegacyFreeRowRemediationError(
        'unknown_user',
        `No account matches ${reference}: the reference must be an exact uuid or email. ` +
          'Nothing was written.',
      );
    }

    const client = await this.options.db.connect();
    try {
      await client.query('BEGIN');

      // 1. The row under remediation, locked while applying. Its absence IS the
      //    supported free state, so there is nothing to remediate.
      const selected = await client.query<RowFactsRow>(
        `SELECT ${ROW_FACTS_COLUMNS}
           FROM subscriptions s
           JOIN users u ON u.id = s.user_id
          WHERE s.user_id = $1${apply ? '\n          FOR UPDATE OF s' : ''}`,
        [user.id],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        await client.query('ROLLBACK');
        return {
          outcome: 'absent',
          applied: false,
          userId: user.id,
          email: user.email,
          row: null,
          auditAction: null,
          removedAt: null,
        };
      }

      // 2. The named predicates, evaluated by the database and reported by
      //    name. A single failure refuses the whole operation.
      const checked = await client.query<Record<string, boolean>>(
        `SELECT ${LEGACY_FREE_ROW_PREDICATES.map((p) => `${p.sql} AS ${p.name}`).join(',\n               ')}
           FROM subscriptions s
           JOIN users u ON u.id = s.user_id
          WHERE s.user_id = $1`,
        [user.id],
      );
      const evaluated = checked.rows[0];
      if (evaluated === undefined) {
        // The row vanished between the two reads: a concurrent writer owns it now.
        await client.query('ROLLBACK');
        throw new BillingLegacyFreeRowRemediationError(
          'concurrent_change',
          'The subscriptions row for this account changed during the check. Nothing was written; ' +
            're-run the tool.',
          ['row_present'],
        );
      }
      const failedPredicates = LEGACY_FREE_ROW_PREDICATES.filter(
        (p) => evaluated[p.name] !== true,
      ).map((p) => p.name);
      if (failedPredicates.length > 0) {
        await client.query('ROLLBACK');
        throw new BillingLegacyFreeRowRemediationError(
          'no_legacy_free_row',
          `Refused: the subscriptions row for ${user.email} is not a legacy free placeholder ` +
            `(failed: ${failedPredicates.join(', ')}). Nothing was written. This tool removes only ` +
            'the pre-Model-C free row that carries no sale, no provider identity, no pricing lock, ' +
            'no period or cancellation fact, no sync fact and no evidence; anything else is a ' +
            'commercial record and is left for manual review.',
          failedPredicates,
        );
      }

      // 3. A dry run stops here: fully validated, nothing written.
      if (!apply) {
        await client.query('ROLLBACK'); // read-only: nothing to commit
        return {
          outcome: 'dry_run',
          applied: false,
          userId: user.id,
          email: user.email,
          row: toRowFacts(row),
          auditAction: null,
          removedAt: null,
        };
      }

      // 4. The authoritative write: the SAME predicate is re-asserted in the
      //    DELETE's own WHERE clause, so a row that changed since step 2 is not
      //    deleted on stale terms. Exactly one row, or the whole thing refuses.
      const deleted = await client.query<RowFactsRow>(
        `DELETE FROM subscriptions s
               USING users u
               WHERE u.id = s.user_id
                 AND s.user_id = $1
                 AND ${PREDICATE_SQL}
             RETURNING ${ROW_FACTS_COLUMNS}`,
        [user.id],
      );
      const removed = deleted.rows[0];
      if (deleted.rowCount !== 1 || removed === undefined) {
        await client.query('ROLLBACK');
        throw new BillingLegacyFreeRowRemediationError(
          'concurrent_change',
          'Refused: the subscriptions row changed between the eligibility check and the DELETE, ' +
            'so nothing was deleted. Re-run the tool.',
          ['row_changed_before_delete'],
        );
      }

      // 5. The audit event, on the SAME client/transaction: the removal and the
      //    record of who authorized it commit together or not at all.
      const facts = toRowFacts(removed);
      const removedAt = this.now().toISOString();
      await recordAuditEvent(client, {
        userId: user.id,
        action: BILLING_LEGACY_FREE_ROW_REMEDIATION_AUDIT_ACTION,
        entityType: 'subscription',
        entityId: facts.subscriptionId,
        metadata: {
          operatorId,
          reason,
          source: 'operator_cli',
          removedSubscription: facts,
          removedAt,
          // The CASCADE guard, as verified facts: zero rows in each of the three
          // tables that reference `subscriptions` ON DELETE CASCADE.
          evidenceRowsRemoved: 0,
          guards: {
            providerEvents: 0,
            verifiedTransactions: 0,
            activations: 0,
          },
          // What the removal does and does not mean.
          entitlementEffect:
            'none: a free placeholder and no row resolve to the same entitlements, access and provider facts',
          checkoutEffect: 'the account is row-less again and its next checkout prices against the active epoch',
        },
      });
      await client.query('COMMIT');

      return {
        outcome: 'removed',
        applied: true,
        userId: user.id,
        email: user.email,
        row: facts,
        auditAction: BILLING_LEGACY_FREE_ROW_REMEDIATION_AUDIT_ACTION,
        removedAt,
      };
    } catch (error) {
      // A refusal already rolled back explicitly; a throw before any COMMIT is
      // rolled back here. Either way nothing from this attempt survives.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** An account is addressable by uuid or by email; nothing else is accepted. */
  private async readUser(
    reference: string,
  ): Promise<{ id: string; email: string } | null> {
    const asUuid = z.string().uuid().safeParse(reference);
    const { rows } = asUuid.success
      ? await this.options.db.query<{ id: string; email: string }>(
          'SELECT id, email FROM users WHERE id = $1',
          [reference],
        )
      : await this.options.db.query<{ id: string; email: string }>(
          'SELECT id, email FROM users WHERE email = $1',
          [reference.toLowerCase()],
        );
    return rows[0] ?? null;
  }
}
