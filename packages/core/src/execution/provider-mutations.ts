import { createHash } from 'node:crypto';
import {
  canonicalizeMutationRequest,
  containsForbiddenAuditKey,
  isMutationIdentityHash,
  providerCredentialBindingSchema,
  PROVIDER_MUTATION_SECRET_MANAGER_INTEGRATED,
  PROVIDER_TERMINAL_EVIDENCE,
  normalizeSubmitOutcome,
  validateBridgeClientOrderId,
  PROVIDER_ACCEPTED_STATUSES,
  PROVIDER_REJECTED_STATUSES,
  type BridgeNormalizedStatus,
  type NormalizedSubmitOutcome,
  type ProviderIntentState,
  type ProviderMutationReservationState,
  type ProviderMutationOutcome,
  type ProviderResolution,
  type ProviderTerminalEvidence,
  type ProviderUncertaintyReason,
} from '@veltrixeye/contracts';
import type pg from 'pg';

/**
 * Node-specific sha-256 of the canonical mutation request (§2).
 * Moved out of `@veltrixeye/contracts` to keep the browser bundle free of
 * `node:crypto` (Vercel build regression). Semantics are preserved exactly.
 */
export function canonicalMutationRequestHash(request: unknown): string {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('canonicalMutationRequestHash requires an object request');
  }
  if (containsForbiddenAuditKey(request)) {
    throw new Error('canonicalMutationRequestHash refused a request carrying credential-shaped keys');
  }
  return createHash('sha256').update(canonicalizeMutationRequest(request), 'utf8').digest('hex');
}

/**
 * M10 Gate 9 — durable provider-mutation persistence (submit only).
 *
 * This is the durable ledger behind the Gate 9 persistence contract: it
 * commits the submit intent AND its mutation reservation **before** a provider
 * mutation call is permitted, and it records the outcome afterwards. It is the
 * only component that writes `execution_provider_intents`,
 * `execution_provider_mutation_reservations`, `execution_provider_receipts`,
 * `execution_provider_reconciliation_observations`,
 * `execution_provider_resolutions` and `execution_provider_mutation_events`.
 *
 * Boundaries this module never crosses:
 *
 *  - it never calls, configures or enables a broker/MT5/Exness transport; the
 *    provider call is an injected function and Gate 9 tests inject fakes;
 *  - it never retries, cancels, closes or repairs an order automatically;
 *  - it never infers "no stored response = rejected" or
 *    "reservation expired = mutation did not happen";
 *  - it never persists a credential, provider payload or provider error text.
 *
 * Transaction shape (§9) — no transaction is ever held open across a remote
 * call:
 *
 *   BEGIN → insert intent (prepared) + reservation → transition to submitting
 *         → COMMIT                       ← the pre-provider persistence barrier
 *   BEGIN → consume barrier (CAS on the exact state_version while submitting)
 *         → COMMIT                       ← the durable single-use provider gate
 *         → provider call                ← still no transaction is open
 *   BEGIN → insert receipt → COMMIT
 *   BEGIN → transition intent + reservation → COMMIT
 *
 * Provider-call authorization invariant (M2): a provider call for intent I may
 * occur only after a committed write advances `I.state_version` from exactly
 * `barrier.state_version` while `I.status = 'submitting'`. Because every UPDATE
 * advances `state_version` (0029 trigger), a given barrier value can authorize
 * at most one provider call — a stale, reused or forged barrier fails closed
 * with `barrier_not_consumable` and never reaches the provider.
 *
 * Structural duplicate-mutation and retry invariants (M3, Step 3c) — enforced
 * inside the `prepareSubmit` / `prepareRetry` transactions (advisory lock, read
 * and write in the SAME transaction) and mirrored by migration 0030:
 *
 *  - a managed order (`order_id`, scoped to its execution profile) carries at
 *    most one unresolved provider mutation (`prepared` / `submitting` /
 *    `uncertain`); a concurrent or later submission for the same order fails
 *    closed with `unresolved_order_mutation` until reconciliation or operator
 *    resolution resolves it. After an explicit `provider_absent` (or a
 *    rejected) resolution a new mutation for that order may proceed;
 *  - a provider-accepted intent (`confirmed`, or `reconciled` as
 *    `provider_accepted`) is never retried and never "started over" under the
 *    same order identity (`duplicate_mutation`) — another order after
 *    confirmation needs a distinct logical order identity;
 *  - a parent intent has at most one retry (`parent_already_superseded`), a
 *    retry always continues the newest lineage member (`stale_parent_intent`),
 *    a lineage never contains duplicate attempts, and a retry keeps its
 *    parent's provider/environment/account binding and managed order identity
 *    (`binding_mismatch`);
 *  - a retry requires a FRESH caller-supplied risk decision and execution
 *    authorization reference (`retry_requires_fresh_authorization`): the risk
 *    decision must exist, belong to the same user/profile and not already back
 *    another intent; the authorization id must not already have been consumed
 *    by a Gate 9 retry. Gate 9 never generates or approves either.
 *
 * When no `order_id` is supplied the pre-existing identity-based semantics
 * (client order id / idempotency key / request hash) apply unchanged.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const PROVIDER_MUTATION_ERROR_CODES = [
  'mutation_kind_out_of_scope',
  'invalid_mutation_identity',
  'invalid_binding',
  'duplicate_mutation',
  'pre_call_persistence_failed',
  'barrier_not_consumable',
  'intent_not_found',
  'intent_ownership_mismatch',
  'concurrent_state_change',
  'uncertainty_unresolved',
  'retry_identity_reuse',
  'retry_requires_fresh_authorization',
  'stale_reconciliation_observation',
  'operator_evidence_required',
  'resolution_requires_unresolved_intent',
  'invalid_observation',
  // M3 — structural duplicate-mutation and retry invariants.
  'unresolved_order_mutation',
  'parent_already_superseded',
  'stale_parent_intent',
  'binding_mismatch',
] as const;
export type ProviderMutationErrorCode = (typeof PROVIDER_MUTATION_ERROR_CODES)[number];

export class ProviderMutationError extends Error {
  readonly code: ProviderMutationErrorCode;
  readonly intentId?: string;

  constructor(code: ProviderMutationErrorCode, message: string, intentId?: string) {
    super(message);
    this.name = 'ProviderMutationError';
    this.code = code;
    if (intentId !== undefined) this.intentId = intentId;
  }
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export interface ProviderIntentRecord {
  id: string;
  userId: string;
  executionProfileId: string;
  orderId: string | null;
  mutationKind: string;
  clientOrderId: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  providerSlug: string;
  environment: string | null;
  accountRef: string | null;
  brokerServerRef: string | null;
  credentialRef: string | null;
  credentialFingerprint: string | null;
  status: ProviderIntentState;
  outcome: ProviderMutationOutcome | null;
  uncertaintyReason: ProviderUncertaintyReason | null;
  terminalEvidence: ProviderTerminalEvidence | null;
  resolution: ProviderResolution | null;
  parentIntentId: string | null;
  rootIntentId: string | null;
  supersededByIntentId: string | null;
  attempt: number;
  reconciliationRequired: boolean;
  reconciliationState: string;
  riskDecisionId: string | null;
  stateVersion: number;
  submittedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MutationReservationRecord {
  id: string;
  intentId: string;
  state: ProviderMutationReservationState;
  requiresReconciliation: boolean;
  riskReservationId: string | null;
  riskExpiresAt: Date | null;
  monetaryRisk: string;
  symbol: string | null;
  direction: string | null;
  version: number;
}

/**
 * Read-only projection of a durable provider receipt (`execution_provider_receipts`).
 * Added for the B2 canonical submit boundary: a duplicate resolution that
 * resolves onto a `confirmed` / `rejected` intent reports the REAL provider
 * order id from this row — never an internal intent id. `providerOrderId` is
 * `null` whenever the provider never produced one (e.g. a rejection without a
 * ticket); callers must not substitute another identifier.
 */
export interface ProviderReceiptRecord {
  id: string;
  intentId: string;
  providerOrderId: string | null;
  outcome: ProviderMutationOutcome;
  statusUncertain: boolean;
  identityVerified: boolean;
  evidence: string | null;
  observedAt: Date;
}

/** The durable proof that the pre-call barrier committed. */
export interface SubmitBarrier {
  intentId: string;
  clientOrderId: string;
  idempotencyKey: string;
  requestHash: string;
  attempt: number;
  /**
   * The intent version this barrier was minted at. `executeSubmit` CONSUMES the
   * barrier by compare-and-swapping this exact value in its own committed
   * transaction before the provider call; the consuming write advances
   * `state_version`, so the barrier authorizes at most one provider call. The
   * object itself is never trusted: every field is re-verified against the
   * durable row.
   */
  stateVersion: number;
  userId: string;
  executionProfileId: string;
  providerSlug: string;
  environment: string;
  accountRef: string | null;
  /** Always true: a barrier that exists was committed. Never mint one by hand. */
  providerCallPermitted: true;
}

export type PrepareSubmitResult =
  | { kind: 'authorized'; barrier: SubmitBarrier }
  | { kind: 'duplicate'; intent: ProviderIntentRecord; reason: 'identity' | 'concurrent' };

export type SubmitOnceResult =
  | { kind: 'submitted'; result: MutationExecutionResult }
  | { kind: 'duplicate'; intent: ProviderIntentRecord };

export interface MutationExecutionResult {
  /** True when the injected provider function was actually invoked. */
  providerCalled: boolean;
  outcome: ProviderMutationOutcome;
  intentId: string;
  clientOrderId: string;
  idempotencyKey: string;
  attempt: number;
  intentState: ProviderIntentState;
  reservationState: ProviderMutationReservationState | null;
  uncertaintyReason: ProviderUncertaintyReason | null;
  requiresReconciliation: boolean;
  receiptId: string | null;
  providerOrderId: string | null;
  evidence: ProviderTerminalEvidence | null;
  /** Set when the outcome could not be written durably after the provider call. */
  persistenceFailure: ProviderUncertaintyReason | null;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface SubmitIntentInput {
  userId: string;
  executionProfileId: string;
  orderId?: string | null;
  /** VeltrixEye-minted durable identity (`ve-…`). Never client-chosen. */
  clientOrderId: string;
  /** 64-hex idempotency identity; immutable for the lifetime of a mutation. */
  idempotencyKey: string;
  /** Canonical, secret-free request that is hashed into `request_hash`. */
  canonicalRequest: Record<string, unknown>;
  providerSlug: string;
  environment: 'paper' | 'demo';
  accountRef?: string | null;
  brokerServerRef?: string | null;
  /** Reference identifier only — never a credential value (§11). */
  credentialRef?: string | null;
  credentialFingerprint?: string | null;
  riskDecisionId?: string | null;
  riskReservationId?: string | null;
  symbol?: string | null;
  direction?: 'long' | 'short' | null;
  /** Exposure copy so a risk-TTL reclaim cannot erase mutation safety (§10). */
  monetaryRisk?: string | null;
  riskExpiresAt?: Date | null;
}

export interface RetryIntentInput extends Omit<SubmitIntentInput, 'clientOrderId' | 'idempotencyKey'> {
  /**
   * The resolved intent this retry continues. It must be the NEWEST member of
   * its lineage, not already superseded, and resolved as rejected /
   * `provider_rejected` / `provider_absent` (M3): a provider-accepted intent
   * is never retried. The retry keeps the parent's provider/environment/account
   * binding; when `orderId` is omitted it inherits the parent's managed order.
   */
  parentIntentId: string;
  /** A brand-new durable identity. Reusing an unresolved identity is refused. */
  clientOrderId: string;
  /** A brand-new idempotency identity. */
  idempotencyKey: string;
  /**
   * Fresh risk decision — a retry never inherits the original's approval. The
   * reference must name an existing `risk_decisions` row owned by the same
   * user/profile that no Gate 9 intent has consumed yet. Gate 9 never creates
   * or approves one.
   */
  riskDecisionId: string;
  /**
   * Fresh execution authorization id (server-issued, never a client boolean).
   * An authorization id already consumed by a Gate 9 retry is refused.
   */
  authorizationId: string;
}

export interface ReconciliationObservationInput {
  intentId: string;
  userId: string;
  executionProfileId: string;
  outcome: 'matched' | 'mismatched' | 'not_found' | 'uncertain';
  providerStatus: BridgeNormalizedStatus | null;
  statusUncertain: boolean;
  providerOrderId?: string | null;
  observedAt?: Date;
  actor?: string;
}

export interface ReconciliationObservationResult {
  intentId: string;
  observationId: string;
  stale: boolean;
  applied: boolean;
  intentState: ProviderIntentState;
  resolution: ProviderResolution | null;
  outcome: ProviderMutationOutcome | null;
  /** True when the observation could not resolve anything and an operator must. */
  requiresOperatorResolution: boolean;
}

export interface OperatorResolutionInput {
  intentId: string;
  userId: string;
  executionProfileId: string;
  actor: string;
  resolvedBy: string;
  resolution: ProviderResolution;
  /** Documented evidence. A finding marked "resolved" is not evidence (§14). */
  evidence: ProviderTerminalEvidence;
  evidenceReference: string;
  note?: string | null;
}

export interface ResolutionResult {
  intentId: string;
  fromStatus: ProviderIntentState;
  toStatus: ProviderIntentState;
  resolution: ProviderResolution;
  outcome: ProviderMutationOutcome | null;
  evidence: ProviderTerminalEvidence;
  reservationState: ProviderMutationReservationState | null;
  resolutionId: string;
}

/* -------------------------------------------------------------------------- */
/* Provider call boundary                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The provider response a submit adapter returns. Gate 9 has no live adapter:
 * production wiring is a separate, separately-reviewed step, and the tests
 * inject deterministic fakes.
 *
 * HIGH-2: `receipt` is intentionally NOT part of the provider response
 * contract. The persisted receipt is built from validated fields only
 * (providerOrderId, normalized status, etc.) through the closed allowlist
 * boundary, never copied from provider-controlled nested content. Any
 * response carrying a `receipt` field is treated as malformed (uncertain),
 * so hostile nested data cannot cross the normalization boundary.
 */
export interface ProviderSubmitResponse {
  clientOrderId?: unknown;
  idempotencyKey?: unknown;
  accountRef?: unknown;
  providerOrderId?: unknown;
  /** Raw provider status token; normalized through the closed vocabulary. */
  status?: unknown;
  /** Anything else is refused: an unknown field is an unreadable response. */
}

export type ProviderSubmitCall = (barrier: SubmitBarrier) => Promise<unknown>;

/* -------------------------------------------------------------------------- */
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

const INTENT_COLUMNS = `
  id, user_id, execution_profile_id, order_id, mutation_kind, client_order_id, idempotency_key,
  request_hash, provider_slug, environment, account_ref, broker_server_ref, credential_ref,
  credential_fingerprint, status, outcome, uncertainty_reason, terminal_evidence, resolution,
  parent_intent_id, root_intent_id, superseded_by_intent_id, attempt, reconciliation_required,
  reconciliation_state, risk_decision_id, state_version, submitted_at, resolved_at, created_at, updated_at`;

const RESERVATION_COLUMNS = `
  id, intent_id, state, requires_reconciliation, risk_reservation_id, risk_expires_at,
  monetary_risk, symbol, direction, version`;

export class ProviderMutationLedger {
  constructor(private readonly pool: pg.Pool) {}

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async getIntent(intentId: string): Promise<ProviderIntentRecord | null> {
    const { rows } = await this.pool.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_provider_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0] ? toIntentRecord(rows[0]) : null;
  }

  /**
   * Resolves the durable intent for a repeated request (§6). A repeated request
   * with the same profile/account, mutation kind, client order id, idempotency
   * key and canonical request hash resolves onto the SAME intent — it never
   * authorizes a second provider mutation.
   */
  async resolveByIdentity(args: {
    executionProfileId: string;
    clientOrderId: string;
    idempotencyKey?: string | null;
    requestHash?: string | null;
  }): Promise<ProviderIntentRecord | null> {
    const { rows } = await this.pool.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_provider_intents
        WHERE execution_profile_id = $1
          AND mutation_kind = 'submit'
          AND (client_order_id = $2
               OR ($3::text IS NOT NULL AND idempotency_key = $3)
               OR ($4::text IS NOT NULL AND request_hash = $4))
        ORDER BY created_at ASC
        LIMIT 1`,
      [args.executionProfileId, args.clientOrderId, args.idempotencyKey ?? null, args.requestHash ?? null],
    );
    return rows[0] ? toIntentRecord(rows[0]) : null;
  }

  /** Intents whose provider outcome is not established (restart/operator view). */
  async listUnresolved(args: { executionProfileId?: string } = {}): Promise<ProviderIntentRecord[]> {
    const { rows } = await this.pool.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_provider_intents
        WHERE status IN ('prepared', 'submitting', 'uncertain')
          AND ($1::uuid IS NULL OR execution_profile_id = $1)
        ORDER BY created_at ASC`,
      [args.executionProfileId ?? null],
    );
    return rows.map(toIntentRecord);
  }

  /**
   * Durable exposure held by unresolved mutations (§10).
   *
   * The existing `risk_reservations` row may be reclaimed by its own 60-second
   * TTL; this figure is computed from the mutation ledger, which TTL expiry
   * cannot erase, so restart/cleanup can never authorize an unsafe duplicate.
   */
  async unresolvedMutationExposure(executionProfileId: string): Promise<{
    count: number;
    monetaryRisk: string;
    clientOrderIds: string[];
    intents: Array<{ intentId: string; clientOrderId: string; state: ProviderMutationReservationState }>;
  }> {
    const { rows } = await this.pool.query<{
      id: string;
      client_order_id: string;
      state: ProviderMutationReservationState;
      monetary_risk: string;
      total_risk: string;
    }>(
      `SELECT r.intent_id AS id, r.client_order_id, r.state, r.monetary_risk::text AS monetary_risk,
              COALESCE(SUM(r.monetary_risk) OVER (), 0)::text AS total_risk
         FROM execution_provider_mutation_reservations r
        WHERE r.execution_profile_id = $1
          AND r.state IN ('reserved', 'uncertain')
        ORDER BY r.created_at ASC`,
      [executionProfileId],
    );
    return {
      count: rows.length,
      // Summed by the database (numeric arithmetic), never by float drift.
      monetaryRisk: rows[0]?.total_risk ?? '0',
      clientOrderIds: rows.map((r) => r.client_order_id),
      intents: rows.map((r) => ({ intentId: r.id, clientOrderId: r.client_order_id, state: r.state })),
    };
  }

  async getReservation(intentId: string): Promise<MutationReservationRecord | null> {
    const { rows } = await this.pool.query<ReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM execution_provider_mutation_reservations WHERE intent_id = $1`,
      [intentId],
    );
    return rows[0] ? toReservationRecord(rows[0]) : null;
  }

  /**
   * Durable receipt for an intent (B2). Read-only: no state changes. Returns
   * the most recent receipt row for the intent, or `null` when none exists
   * (e.g. the outcome was never persisted durably).
   */
  async getReceipt(intentId: string): Promise<ProviderReceiptRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      intent_id: string;
      provider_order_id: string | null;
      outcome: ProviderMutationOutcome;
      status_uncertain: boolean;
      identity_verified: boolean;
      evidence: string | null;
      observed_at: Date;
    }>(
      `SELECT id, intent_id, provider_order_id, outcome, status_uncertain, identity_verified, evidence, observed_at
         FROM execution_provider_receipts
        WHERE intent_id = $1
        ORDER BY observed_at DESC
        LIMIT 1`,
      [intentId],
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      intentId: rows[0].intent_id,
      providerOrderId: rows[0].provider_order_id,
      outcome: rows[0].outcome,
      statusUncertain: rows[0].status_uncertain,
      identityVerified: rows[0].identity_verified,
      evidence: rows[0].evidence,
      observedAt: rows[0].observed_at,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* §9 Pre-provider persistence barrier                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Commits the durable intent + mutation reservation and returns the barrier
   * that authorizes exactly one provider call.
   *
   * If this method throws (or the transaction cannot commit), NO provider call
   * is permitted: the caller must treat the failure as fail-closed. A repeated
   * request resolves onto the existing intent and returns `duplicate` without a
   * provider call — including after a restart or under concurrency.
   */
  async prepareSubmit(input: SubmitIntentInput): Promise<PrepareSubmitResult> {
    const identity = assertSubmitIdentity(input);
    const binding = assertBinding(input);
    const orderId = input.orderId ?? null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // M3 — serialize every writer for the same managed order (scoped to the
      // execution profile) BEFORE the unresolved-order read below: the lock and
      // the read happen in the same transaction, so two concurrent submissions
      // for one order with different client order ids can never both pass.
      // Lock order is always order → identity (prepareRetry: lineage → order →
      // identity). Released by COMMIT/ROLLBACK, never held across the provider.
      if (orderId !== null) await acquireXactLock(client, orderLockKey(input.executionProfileId, orderId));
      // Serialize concurrent twins on the same mutation identity; the lock is
      // released by COMMIT/ROLLBACK, never held across the provider call.
      await acquireXactLock(client, identityLockKey(input.executionProfileId, identity.clientOrderId));

      const existing = await this.findByIdentityIn(client, input, identity.requestHash);
      if (existing) {
        await client.query('COMMIT');
        return { kind: 'duplicate', intent: existing, reason: 'identity' };
      }

      // M3 — at most one unresolved provider mutation per managed order, and
      // never a second mutation for an order whose submit was already
      // provider-accepted. Without an order id the identity semantics above
      // are the whole contract (no order-level invariant is invented).
      if (orderId !== null) {
        await this.assertOrderAcceptsNewMutationIn(client, input.executionProfileId, orderId);
      }

      const inserted = await client.query<{ id: string; state_version: number }>(
        `INSERT INTO execution_provider_intents
           (user_id, execution_profile_id, order_id, mutation_kind, client_order_id, idempotency_key,
            request_hash, provider_slug, environment, account_ref, broker_server_ref, credential_ref,
            credential_fingerprint, status, risk_decision_id, attempt)
         VALUES ($1,$2,$3,'submit',$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared',$13,1)
         RETURNING id, state_version`,
        [
          input.userId,
          input.executionProfileId,
          input.orderId ?? null,
          identity.clientOrderId,
          identity.idempotencyKey,
          identity.requestHash,
          input.providerSlug,
          binding.environment,
          binding.accountRef,
          input.brokerServerRef ?? null,
          input.credentialRef ?? null,
          input.credentialFingerprint ?? null,
          input.riskDecisionId ?? null,
        ],
      );
      const intentId = inserted.rows[0]!.id;

      // Authorize the submission in the SAME committed transaction (§9): the
      // durable state after commit is "submission authorized", and a crash
      // before the provider call leaves an unresolved intent, never a retry.
      const advanced = await client.query<{ state_version: number }>(
        `UPDATE execution_provider_intents
            SET status = 'submitting', submitted_at = now()
          WHERE id = $1 AND status = 'prepared' AND state_version = $2
        RETURNING state_version`,
        [intentId, inserted.rows[0]!.state_version],
      );
      if (advanced.rows.length === 0) throw new ProviderMutationError('concurrent_state_change', 'Submit intent changed while authorizing the submission');

      await this.insertReservation(client, {
        intentId,
        userId: input.userId,
        executionProfileId: input.executionProfileId,
        orderId: input.orderId ?? null,
        riskDecisionId: input.riskDecisionId ?? null,
        riskReservationId: input.riskReservationId ?? null,
        clientOrderId: identity.clientOrderId,
        idempotencyKey: identity.idempotencyKey,
        symbol: input.symbol ?? null,
        direction: input.direction ?? null,
        monetaryRisk: input.monetaryRisk ?? '0',
        riskExpiresAt: input.riskExpiresAt ?? null,
      });

      await insertEvent(client, {
        intentId,
        userId: input.userId,
        executionProfileId: input.executionProfileId,
        clientOrderId: identity.clientOrderId,
        idempotencyKey: identity.idempotencyKey,
        attempt: 1,
        fromState: null,
        toState: 'prepared',
        detail: { requestHash: identity.requestHash },
      });
      await insertEvent(client, {
        intentId,
        userId: input.userId,
        executionProfileId: input.executionProfileId,
        clientOrderId: identity.clientOrderId,
        idempotencyKey: identity.idempotencyKey,
        attempt: 1,
        fromState: 'prepared',
        toState: 'submitting',
        detail: { barrier: 'pre_provider_persistence_committed' },
      });

      await client.query('COMMIT');
      return {
        kind: 'authorized',
        barrier: Object.freeze({
          intentId,
          clientOrderId: identity.clientOrderId,
          idempotencyKey: identity.idempotencyKey,
          requestHash: identity.requestHash,
          attempt: 1,
          stateVersion: advanced.rows[0]!.state_version,
          userId: input.userId,
          executionProfileId: input.executionProfileId,
          providerSlug: input.providerSlug,
          environment: binding.environment,
          accountRef: binding.accountRef,
          providerCallPermitted: true as const,
        }),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(error)) {
        // 0030 defense-in-depth fired for the managed order: report the order
        // invariant, not a generic persistence failure.
        if (orderId !== null && violatedConstraint(error) === ORDER_LIVE_UNIQUE_INDEX) {
          throw await this.orderLiveViolation(input.executionProfileId, orderId);
        }
        const existing = await this.resolveByIdentity({
          executionProfileId: input.executionProfileId,
          clientOrderId: identity.clientOrderId,
          idempotencyKey: identity.idempotencyKey,
          requestHash: identity.requestHash,
        });
        if (existing) return { kind: 'duplicate', intent: existing, reason: 'concurrent' };
      }
      if (error instanceof ProviderMutationError) throw error;
      throw new ProviderMutationError('pre_call_persistence_failed', 'Durable pre-provider persistence failed; no provider call is permitted');
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* §5/§9 Provider call + outcome persistence                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Performs the provider call behind a durably CONSUMED single-use barrier and
   * records the normalized outcome.
   *
   * M2 — before the provider function may run, the barrier is consumed in its
   * own SHORT transaction: a compare-and-swap against the exact
   * `barrier.stateVersion` while the durable intent is still
   * `status = 'submitting'` and every identity field still matches the row.
   * The consumption write itself advances `state_version`, so a given barrier
   * value can authorize at most one provider call. Reuse after any
   * version-changing path — a confirmed, rejected or reconciled outcome, an
   * uncertain outcome, a `state_commit_failed`, restart recovery, operator
   * resolution, or a forged/stale barrier — matches zero rows and fails closed
   * with `barrier_not_consumable`; a database failure during consumption fails
   * closed with `pre_call_persistence_failed`. In neither case is the provider
   * function invoked.
   *
   * The provider call itself is the caller's injected function; it runs with
   * NO open transaction. Every failure mode that leaves the provider outcome
   * unknown resolves to `uncertain` and requires reconciliation — a missing
   * response is never a rejection.
   *
   * Throws (before any provider call) when the barrier cannot be consumed.
   */
  async executeSubmit(barrier: SubmitBarrier, call: ProviderSubmitCall): Promise<MutationExecutionResult> {
    // M2 — durable single-use barrier consumption. Nothing below runs unless
    // this committed: a failed or zero-row CAS must never call the provider.
    await this.consumeSubmitBarrier(barrier);

    let normalized: NormalizedSubmitOutcome;
    let providerCalled = false;
    try {
      const raw = await call(barrier);
      providerCalled = true;
      normalized = normalizeSubmitOutcome(barrier, raw);
    } catch (error) {
      providerCalled = true;
      normalized = {
        outcome: 'uncertain',
        uncertaintyReason: classifyTransportFailure(error),
        receipt: null,
        providerOrderId: null,
        providerStatus: null,
        statusUncertain: true,
      };
    }

    let receiptId: string | null = null;
    let persistenceFailure: ProviderUncertaintyReason | null = null;
    try {
      receiptId = await this.persistReceipt(barrier, normalized);
    } catch {
      // §9: if the receipt cannot be written after the provider call, the
      // mutation remains uncertain locally — including for a verified
      // acceptance or rejection (§8 crash table).
      persistenceFailure = 'receipt_persistence_failure';
      normalized = {
        outcome: 'uncertain',
        uncertaintyReason: 'receipt_persistence_failure',
        receipt: null,
        providerOrderId: null,
        providerStatus: null,
        statusUncertain: true,
      };
    }

    let intentState: ProviderIntentState;
    let reservationState: ProviderMutationReservationState | null = null;
    try {
      const applied = await this.applyOutcome(barrier, normalized);
      intentState = applied.intentState;
      reservationState = applied.reservationState;
    } catch {
      // The receipt is durable but the state change is not: the intent stays
      // `submitting` (unresolved) and still cannot be re-submitted.
      persistenceFailure = 'state_commit_failed';
      const current = await this.getIntent(barrier.intentId);
      intentState = current?.status ?? 'submitting';
      const reservation = await this.getReservation(barrier.intentId);
      reservationState = reservation?.state ?? null;
    }

    return {
      providerCalled,
      outcome: normalized.outcome,
      intentId: barrier.intentId,
      clientOrderId: barrier.clientOrderId,
      idempotencyKey: barrier.idempotencyKey,
      attempt: barrier.attempt,
      intentState,
      reservationState,
      uncertaintyReason: normalized.outcome === 'uncertain' ? normalized.uncertaintyReason : null,
      requiresReconciliation: isProviderIntentUnresolvedState(intentState),
      receiptId,
      providerOrderId: normalized.providerOrderId,
      evidence: normalized.outcome === 'uncertain' ? null : 'provider_response_verified',
      persistenceFailure,
    };
  }

  /**
   * Convenience: `prepareSubmit` + `executeSubmit`.
   *
   * A duplicate request (same mutation identity, including after a restart or
   * under concurrency) resolves onto the existing durable intent and the
   * provider function is never invoked a second time.
   */
  async submitOnce(input: SubmitIntentInput, call: ProviderSubmitCall): Promise<SubmitOnceResult> {
    const prepared = await this.prepareSubmit(input);
    if (prepared.kind === 'duplicate') return { kind: 'duplicate', intent: prepared.intent };
    return { kind: 'submitted', result: await this.executeSubmit(prepared.barrier, call) };
  }

  /* ---------------------------------------------------------------------- */
  /* M2 — durable single-use barrier consumption                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Consumes a submit barrier immediately before the provider call, in its own
   * SHORT transaction that is committed before the call starts and therefore
   * never held open across the provider.
   *
   * The compare-and-swap is scoped to the full durable intent identity and the
   * appropriate execution context — intent id, the exact `state_version`,
   * `status = 'submitting'`, tenant ownership (`user_id`, `execution_profile_id`),
   * mutation identity (`client_order_id`, `idempotency_key`, `request_hash`,
   * `attempt`) and binding (`provider_slug`, `environment`, `account_ref`). The
   * barrier object is untrusted input: every field must match the committed row
   * or the CAS matches zero rows.
   *
   * Because the 0029 trigger advances `state_version` on every UPDATE, this
   * consuming write is itself the version change that invalidates the barrier
   * value: a second consume against the same `stateVersion` can never match, so
   * a barrier succeeds exactly once — even when the first attempt ended in
   * `state_commit_failed`, restart recovery or operator resolution while the
   * intent remained (or later returned to) an unresolved state.
   *
   * Zero rows → `barrier_not_consumable` (fail closed). Any database failure →
   * `pre_call_persistence_failed` (fail closed). Neither may ever reach the
   * provider; on failure the transaction is rolled back and durable state is
   * left exactly as it was.
   */
  private async consumeSubmitBarrier(barrier: SubmitBarrier): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Same per-intent lock the outcome path uses: concurrent executions of
      // one barrier serialize here, and the loser's CAS matches zero rows.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`intent:${barrier.intentId}`]);

      const consumed = await client.query<{ state_version: number }>(
        `UPDATE execution_provider_intents
            SET updated_at = now()
          WHERE id = $1
            AND mutation_kind = 'submit'
            AND status = 'submitting'
            AND state_version = $2
            AND user_id = $3
            AND execution_profile_id = $4
            AND client_order_id = $5
            AND idempotency_key = $6
            AND attempt = $7
            AND request_hash = $8
            AND provider_slug = $9
            AND environment = $10
            AND account_ref IS NOT DISTINCT FROM $11
        RETURNING state_version`,
        [
          barrier.intentId,
          barrier.stateVersion,
          barrier.userId,
          barrier.executionProfileId,
          barrier.clientOrderId,
          barrier.idempotencyKey,
          barrier.attempt,
          barrier.requestHash,
          barrier.providerSlug,
          barrier.environment,
          barrier.accountRef,
        ],
      );
      if (consumed.rows.length === 0) {
        // Fail closed: the barrier was already consumed, superseded by newer
        // durable state, or never matched a real intent. No provider call is
        // permitted, and nothing durable changed (rolled back below).
        throw new ProviderMutationError(
          'barrier_not_consumable',
          'The submit barrier could not be consumed: it was already used, superseded, or never matched durable state; no provider call is permitted',
          barrier.intentId,
        );
      }

      // Append-only proof that THIS barrier value was consumed (exactly once):
      // a `submitting → submitting` event that carries no outcome claim.
      await insertEvent(client, {
        intentId: barrier.intentId,
        userId: barrier.userId,
        executionProfileId: barrier.executionProfileId,
        clientOrderId: barrier.clientOrderId,
        idempotencyKey: barrier.idempotencyKey,
        attempt: barrier.attempt,
        fromState: 'submitting',
        toState: 'submitting',
        actor: 'system:mutation-ledger',
        detail: {
          barrier: 'submit_barrier_consumed',
          consumedFromStateVersion: barrier.stateVersion,
        },
      });

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof ProviderMutationError) throw error;
      throw new ProviderMutationError(
        'pre_call_persistence_failed',
        'Durable barrier consumption failed; no provider call is permitted',
        barrier.intentId,
      );
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* §6 Retry                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates the durable barrier for a retry. Permitted ONLY when the original
   * mutation has been resolved according to the reconciliation/evidence rules,
   * and only with a brand-new mutation identity plus fresh risk/authorization
   * evidence. An unresolved (uncertain/in-flight) original is never retried.
   *
   * M3 — every verification runs INSIDE one transaction, after the lineage
   * lock (`executionProfileId` + root intent) is held and the parent has been
   * re-read, so two concurrent retries of one parent yield exactly one retry:
   *
   *  - parent exists and belongs to this user/profile;
   *  - parent is resolved (`uncertainty_unresolved` otherwise);
   *  - parent is not already superseded (`parent_already_superseded`) and is
   *    the newest attempt of its lineage (`stale_parent_intent`);
   *  - parent is eligible: `rejected`, or `reconciled` as `provider_rejected`
   *    / `provider_absent`. A provider-accepted parent (`confirmed`, or
   *    `reconciled` as `provider_accepted`) is never retried
   *    (`duplicate_mutation`);
   *  - the retry keeps the parent's provider/environment/account binding and
   *    managed order identity (`binding_mismatch`);
   *  - no lineage member is unresolved, and — when a managed order is bound —
   *    no other unresolved or provider-accepted mutation exists for that order
   *    (`unresolved_order_mutation` / `duplicate_mutation`);
   *  - the caller-supplied risk decision and authorization reference are fresh
   *    (`retry_requires_fresh_authorization`).
   *
   * Exactly one retry row is inserted and the parent is marked superseded by
   * a compare-and-swap in the same transaction. Migration 0030 mirrors the
   * lineage/order invariants as unique indexes (defense-in-depth).
   */
  async prepareRetry(input: RetryIntentInput): Promise<PrepareSubmitResult> {
    // Pure input validation first (no durable state involved; nothing written).
    const identity = assertSubmitIdentity(input);
    const binding = assertBinding(input);

    // Preliminary read: only to locate the lineage (root id never changes) and
    // fail fast on an unknown/foreign parent. Every decision below is made on
    // the parent RE-READ inside the locked transaction.
    const preliminary = await this.getIntent(input.parentIntentId);
    if (!preliminary) throw new ProviderMutationError('intent_not_found', 'Original mutation intent not found');
    assertIntentOwnership(preliminary, input.userId, input.executionProfileId);
    const rootIntentId = preliminary.rootIntentId ?? preliminary.id;

    const client = await this.pool.connect();
    let orderId: string | null = input.orderId ?? null;
    try {
      await client.query('BEGIN');
      // Lock order is always lineage → order → identity (prepareSubmit takes
      // order → identity), so the two preparers can never deadlock each other.
      await acquireXactLock(client, lineageLockKey(input.executionProfileId, rootIntentId));

      const parent = await this.getIntentIn(client, input.parentIntentId);
      if (!parent) throw new ProviderMutationError('intent_not_found', 'Original mutation intent not found');
      assertIntentOwnership(parent, input.userId, input.executionProfileId);
      if ((parent.rootIntentId ?? parent.id) !== rootIntentId) {
        throw new ProviderMutationError('concurrent_state_change', 'Original mutation intent changed lineage while the retry was being prepared', parent.id);
      }
      // A retry never escapes the order-level invariant by omitting the order:
      // it continues its parent's managed order unless the caller names one.
      // (A caller-supplied order that differs from the parent's is refused
      // below, after the lineage checks.)
      const requestedOrderId = orderId;
      orderId = orderId ?? parent.orderId;
      if (orderId !== null) await acquireXactLock(client, orderLockKey(input.executionProfileId, orderId));
      await acquireXactLock(client, identityLockKey(input.executionProfileId, identity.clientOrderId));

      if (isProviderIntentUnresolvedState(parent.status)) {
        throw new ProviderMutationError(
          'uncertainty_unresolved',
          'The original mutation is unresolved; a retry requires resolution through verified reconciliation or authorized operator resolution',
          parent.id,
        );
      }
      if (input.clientOrderId === parent.clientOrderId || input.idempotencyKey === parent.idempotencyKey) {
        throw new ProviderMutationError('retry_identity_reuse', 'A retry must carry a new mutation identity', parent.id);
      }
      if (!input.riskDecisionId?.trim() || !input.authorizationId?.trim()) {
        throw new ProviderMutationError('retry_requires_fresh_authorization', 'A retry requires a fresh risk decision and execution authorization', parent.id);
      }

      // The repository's existing duplicate semantics: a retry whose identity
      // already exists (e.g. a replayed retry request) resolves onto that
      // intent instead of minting another mutation.
      const clash = await this.findByIdentityIn(client, input, identity.requestHash);
      if (clash) {
        await client.query('COMMIT');
        return { kind: 'duplicate', intent: clash, reason: 'identity' };
      }

      // M3 — at most one retry per parent; a retry continues the newest attempt.
      if (parent.supersededByIntentId !== null) {
        throw new ProviderMutationError(
          'parent_already_superseded',
          'The original mutation intent was already superseded by a retry; a parent intent may have at most one retry',
          parent.id,
        );
      }
      const lineage = await this.lineageMembersIn(client, rootIntentId);
      const newest = lineage.reduce<LineageMember | null>((best, member) => (best === null || member.attempt > best.attempt ? member : best), null);
      if (!newest || newest.id !== parent.id) {
        throw new ProviderMutationError(
          'stale_parent_intent',
          `The original mutation intent is not the newest attempt of its lineage (newest attempt ${newest?.attempt ?? '?'}); a retry must continue the current lineage member`,
          parent.id,
        );
      }

      // M3 — a provider-accepted intent is never retried under the same order.
      if (isProviderAcceptedIntent(parent)) {
        throw new ProviderMutationError(
          'duplicate_mutation',
          'The original mutation was accepted by the provider; Gate 9 never retries a confirmed or provider-accepted intent — another order after confirmation needs a distinct logical order identity',
          parent.id,
        );
      }
      if (!isRetryEligibleResolution(parent)) {
        throw new ProviderMutationError('uncertainty_unresolved', 'The original mutation is not resolved as rejected or absent; it cannot be retried', parent.id);
      }

      // M3 — retry target binding must remain coherent with the parent.
      if (
        input.providerSlug !== parent.providerSlug
        || binding.environment !== parent.environment
        || (binding.accountRef ?? null) !== (parent.accountRef ?? null)
      ) {
        throw new ProviderMutationError(
          'binding_mismatch',
          'A retry must keep the provider, environment and account binding of the mutation it continues',
          parent.id,
        );
      }
      if (requestedOrderId !== null && parent.orderId !== null && requestedOrderId !== parent.orderId) {
        throw new ProviderMutationError('binding_mismatch', 'A retry must continue the managed order identity of the mutation it continues', parent.id);
      }

      // M3 — no unresolved member anywhere in the lineage.
      const unresolvedMember = lineage.find((member) => isProviderIntentUnresolvedState(member.status));
      if (unresolvedMember) {
        throw new ProviderMutationError(
          'uncertainty_unresolved',
          `Attempt ${unresolvedMember.attempt} of this lineage is unresolved; a retry requires every prior attempt to be resolved`,
          unresolvedMember.id,
        );
      }

      // M3 — order-level invariant, evaluated under the order lock taken above
      // (the same lock prepareSubmit takes for this managed order).
      if (orderId !== null) {
        await this.assertOrderAcceptsNewMutationIn(client, input.executionProfileId, orderId);
      }

      // M3 — fresh risk/authorization reference (structural checks only: Gate 9
      // neither generates nor approves risk decisions or authorizations).
      await this.assertFreshRetryAuthorizationIn(client, {
        parentId: parent.id,
        userId: input.userId,
        executionProfileId: input.executionProfileId,
        riskDecisionId: input.riskDecisionId,
        authorizationId: input.authorizationId,
      });

      const attempt = parent.attempt + 1;
      const inserted = await client.query<{ id: string; state_version: number }>(
        `INSERT INTO execution_provider_intents
           (user_id, execution_profile_id, order_id, mutation_kind, client_order_id, idempotency_key,
            request_hash, provider_slug, environment, account_ref, broker_server_ref, credential_ref,
            credential_fingerprint, status, risk_decision_id, parent_intent_id, root_intent_id, attempt)
         VALUES ($1,$2,$3,'submit',$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared',$13,$14,$15,$16)
         RETURNING id, state_version`,
        [
          input.userId,
          input.executionProfileId,
          orderId,
          identity.clientOrderId,
          identity.idempotencyKey,
          identity.requestHash,
          input.providerSlug,
          binding.environment,
          binding.accountRef,
          input.brokerServerRef ?? null,
          input.credentialRef ?? null,
          input.credentialFingerprint ?? null,
          input.riskDecisionId,
          parent.id,
          rootIntentId,
          attempt,
        ],
      );
      const intentId = inserted.rows[0]!.id;

      const advanced = await client.query<{ state_version: number }>(
        `UPDATE execution_provider_intents
            SET status = 'submitting', submitted_at = now()
          WHERE id = $1 AND status = 'prepared' AND state_version = $2
        RETURNING state_version`,
        [intentId, inserted.rows[0]!.state_version],
      );
      if (advanced.rows.length === 0) throw new ProviderMutationError('concurrent_state_change', 'Retry intent changed while authorizing the submission');

      await this.insertReservation(client, {
        intentId,
        userId: input.userId,
        executionProfileId: input.executionProfileId,
        orderId,
        riskDecisionId: input.riskDecisionId,
        riskReservationId: input.riskReservationId ?? null,
        clientOrderId: identity.clientOrderId,
        idempotencyKey: identity.idempotencyKey,
        symbol: input.symbol ?? null,
        direction: input.direction ?? null,
        monetaryRisk: input.monetaryRisk ?? '0',
        riskExpiresAt: input.riskExpiresAt ?? null,
      });

      // The resolved original is explicitly superseded — never deleted — by a
      // compare-and-swap on the exact parent row this transaction verified.
      const superseded = await client.query<{ id: string }>(
        `UPDATE execution_provider_intents
            SET superseded_by_intent_id = $2
          WHERE id = $1
            AND superseded_by_intent_id IS NULL
            AND state_version = $3
        RETURNING id`,
        [parent.id, intentId, parent.stateVersion],
      );
      if (superseded.rows.length === 0) {
        throw new ProviderMutationError('parent_already_superseded', 'The original mutation intent was superseded concurrently; the retry was refused', parent.id);
      }

      await insertEvent(client, {
        intentId,
        userId: input.userId,
        executionProfileId: input.executionProfileId,
        clientOrderId: identity.clientOrderId,
        idempotencyKey: identity.idempotencyKey,
        attempt,
        fromState: null,
        toState: 'prepared',
        detail: { requestHash: identity.requestHash, parentIntentId: parent.id, rootIntentId },
      });
      await insertEvent(client, {
        intentId,
        userId: input.userId,
        executionProfileId: input.executionProfileId,
        clientOrderId: identity.clientOrderId,
        idempotencyKey: identity.idempotencyKey,
        attempt,
        fromState: 'prepared',
        toState: 'submitting',
        detail: {
          barrier: 'pre_provider_persistence_committed',
          parentIntentId: parent.id,
          rootIntentId,
          authorizationId: input.authorizationId,
          riskDecisionId: input.riskDecisionId,
        },
      });

      await client.query('COMMIT');
      return {
        kind: 'authorized',
        barrier: Object.freeze({
          intentId,
          clientOrderId: identity.clientOrderId,
          idempotencyKey: identity.idempotencyKey,
          requestHash: identity.requestHash,
          attempt,
          stateVersion: advanced.rows[0]!.state_version,
          userId: input.userId,
          executionProfileId: input.executionProfileId,
          providerSlug: input.providerSlug,
          environment: binding.environment,
          accountRef: binding.accountRef,
          providerCallPermitted: true as const,
        }),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (isUniqueViolation(error)) {
        // 0030 defense-in-depth: report the lineage/order invariant that fired.
        const constraint = violatedConstraint(error);
        if (constraint === PARENT_UNIQUE_INDEX) {
          throw new ProviderMutationError('parent_already_superseded', 'The original mutation intent already has a retry; a parent intent may have at most one retry', input.parentIntentId);
        }
        if (constraint === LINEAGE_ATTEMPT_UNIQUE_INDEX) {
          throw new ProviderMutationError('stale_parent_intent', 'The lineage already contains this attempt; a retry must continue the current lineage member', input.parentIntentId);
        }
        if (orderId !== null && constraint === ORDER_LIVE_UNIQUE_INDEX) {
          throw await this.orderLiveViolation(input.executionProfileId, orderId);
        }
        const existing = await this.resolveByIdentity({
          executionProfileId: input.executionProfileId,
          clientOrderId: identity.clientOrderId,
          idempotencyKey: identity.idempotencyKey,
          requestHash: identity.requestHash,
        });
        if (existing) return { kind: 'duplicate', intent: existing, reason: 'concurrent' };
      }
      if (error instanceof ProviderMutationError) throw error;
      throw new ProviderMutationError('pre_call_persistence_failed', 'Durable retry persistence failed; no provider call is permitted');
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* §7 Reconciliation (observation only)                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Records a reconciliation observation and, when it is current and
   * identity-verified, resolves an unresolved intent.
   *
   * Never repairs, resubmits, cancels or closes anything. `not_found` is
   * recorded as a proven observation (`applied = false`); the intent remains
   * `uncertain` and requires operator resolution (`requiresOperatorResolution = true`).
   * There is no automatic `provider_absent` transition — provider absence becomes
   * durable only through explicit operator resolution. A stale observation
   * (a newer retry or a newer definitive outcome already exists) is recorded
   * but cannot move durable state.
   */
  async recordReconciliationObservation(input: ReconciliationObservationInput): Promise<ReconciliationObservationResult> {
    const intent = await this.requireIntent(input.intentId, input.userId, input.executionProfileId);
    validateObservation(input);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`intent:${intent.id}`]);

      const willApply = !isProviderIntentTerminalState(intent.status) && input.outcome === 'matched'
        && input.statusUncertain === false && input.providerStatus !== null
        && (PROVIDER_ACCEPTED_STATUSES.includes(input.providerStatus) || PROVIDER_REJECTED_STATUSES.includes(input.providerStatus));

      const inserted = await client.query<{ id: string; stale: boolean; applied: boolean }>(
        `INSERT INTO execution_provider_reconciliation_observations
           (intent_id, user_id, execution_profile_id, client_order_id, idempotency_key, provider_order_id,
            attempt, outcome, provider_status, status_uncertain, observed_at, applied, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, stale, applied`,
        [
          intent.id,
          intent.userId,
          intent.executionProfileId,
          intent.clientOrderId,
          intent.idempotencyKey,
          input.providerOrderId ?? null,
          intent.attempt,
          input.outcome,
          input.providerStatus,
          input.statusUncertain,
          input.observedAt ?? new Date(),
          willApply,
          willApply ? 'reconciliation_verified' : null,
        ],
      );
      const observation = inserted.rows[0]!;

      if (observation.stale || !willApply) {
        await client.query('COMMIT');
        return {
          intentId: intent.id,
          observationId: observation.id,
          stale: observation.stale,
          applied: false,
          intentState: intent.status,
          resolution: null,
          outcome: intent.outcome,
          requiresOperatorResolution: !isProviderIntentTerminalState(intent.status) && (!observation.stale || input.outcome !== 'uncertain'),
        };
      }

      const resolution: ProviderResolution = PROVIDER_ACCEPTED_STATUSES.includes(input.providerStatus as string)
        ? 'provider_accepted'
        : 'provider_rejected';
      const outcome: ProviderMutationOutcome = resolution === 'provider_accepted' ? 'accepted' : 'rejected';

      await this.transitionIntent(client, {
        intent,
        toState: 'reconciled',
        outcome,
        resolution,
        evidence: 'reconciliation_verified',
        uncertaintyReason: null,
        actor: input.actor ?? 'system:reconciliation',
        detail: { observationId: observation.id },
      });

      await client.query(
        `INSERT INTO execution_provider_resolutions
           (intent_id, user_id, execution_profile_id, client_order_id, idempotency_key, actor, resolved_by,
            resolution, evidence, evidence_reference, from_status, to_status)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,'reconciliation_verified',$8,$9,'reconciled')`,
        [
          intent.id,
          intent.userId,
          intent.executionProfileId,
          intent.clientOrderId,
          intent.idempotencyKey,
          input.actor ?? 'system:reconciliation',
          resolution,
          `reconciliation-observation:${observation.id}`,
          intent.status,
        ],
      );

      await client.query('COMMIT');
      return {
        intentId: intent.id,
        observationId: observation.id,
        stale: false,
        applied: true,
        intentState: 'reconciled',
        resolution,
        outcome,
        requiresOperatorResolution: false,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* §14 Operator resolution                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolves an unresolved mutation using documented evidence.
   *
   * The original mutation identity is preserved and recorded; the uncertain
   * record is never deleted. Marking a finding "resolved" is not evidence — an
   * operator resolution must carry an evidence reference, and
   * `secretManagerIntegrated` stays false unless a separately approved
   * implementation adds real secret-manager integration.
   */
  async resolveByOperator(input: OperatorResolutionInput): Promise<ResolutionResult> {
    const intent = await this.requireIntent(input.intentId, input.userId, input.executionProfileId);
    if (isProviderIntentTerminalState(intent.status)) {
      throw new ProviderMutationError('resolution_requires_unresolved_intent', 'Only an unresolved mutation may be resolved', intent.id);
    }
    if (!/^(operator|system):[A-Za-z0-9._:-]{1,96}$/.test(input.actor)) {
      throw new ProviderMutationError('operator_evidence_required', 'A resolution must identify who resolved it', intent.id);
    }
    if (!input.evidenceReference?.trim()) {
      throw new ProviderMutationError('operator_evidence_required', 'A resolution requires documented evidence', intent.id);
    }
    if (input.evidence === 'operator_resolution' && !input.resolvedBy?.trim()) {
      throw new ProviderMutationError('operator_evidence_required', 'An operator resolution must identify the operator', intent.id);
    }
    if (!(PROVIDER_TERMINAL_EVIDENCE as readonly string[]).includes(input.evidence)) {
      throw new ProviderMutationError('operator_evidence_required', 'Unsupported terminal evidence', intent.id);
    }

    const outcome: ProviderMutationOutcome | null =
      input.resolution === 'provider_accepted' ? 'accepted' : input.resolution === 'provider_rejected' ? 'rejected' : null;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`intent:${intent.id}`]);
      const applied = await this.transitionIntent(client, {
        intent,
        toState: 'reconciled',
        outcome,
        resolution: input.resolution,
        evidence: input.evidence,
        uncertaintyReason: null,
        actor: input.actor,
        detail: { evidenceReference: input.evidenceReference },
      });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO execution_provider_resolutions
           (intent_id, user_id, execution_profile_id, client_order_id, idempotency_key, actor, resolved_by,
            resolution, evidence, evidence_reference, note, from_status, to_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reconciled')
         RETURNING id`,
        [
          intent.id,
          intent.userId,
          intent.executionProfileId,
          intent.clientOrderId,
          intent.idempotencyKey,
          input.actor,
          input.evidence === 'operator_resolution' ? input.resolvedBy : null,
          input.resolution,
          input.evidence,
          input.evidenceReference,
          input.note ?? null,
          intent.status,
        ],
      );
      await client.query('COMMIT');
      return {
        intentId: intent.id,
        fromStatus: intent.status,
        toStatus: 'reconciled',
        resolution: input.resolution,
        outcome,
        evidence: input.evidence,
        reservationState: applied.reservationState,
        resolutionId: inserted.rows[0]!.id,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* §8 Restart recovery                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Marks in-flight (`submitting`) intents as uncertain after a restart.
   *
   * A process restart is never evidence that the provider mutation did not
   * happen, and it never creates a new submission: the intents simply become
   * unresolved and require reconciliation. Intents still owned by a live worker
   * can be excluded through `excludeIntentIds` (lease/heartbeat owners).
   */
  async recoverAfterRestart(args: { executionProfileId?: string; excludeIntentIds?: readonly string[] } = {}): Promise<ProviderIntentRecord[]> {
    const candidates = await this.listUnresolved(args.executionProfileId ? { executionProfileId: args.executionProfileId } : {});
    const excluded = new Set(args.excludeIntentIds ?? []);
    const recovered: ProviderIntentRecord[] = [];
    for (const intent of candidates) {
      if (intent.status !== 'submitting' || excluded.has(intent.id)) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`intent:${intent.id}`]);
        const fresh = await this.getIntent(intent.id);
        if (!fresh || fresh.status !== 'submitting') {
          await client.query('COMMIT');
          continue;
        }
        await this.transitionIntent(client, {
          intent: fresh,
          toState: 'uncertain',
          outcome: 'uncertain',
          resolution: null,
          evidence: null,
          uncertaintyReason: 'process_restart',
          actor: 'system:restart-recovery',
          detail: { recoveredFrom: 'submitting' },
        });
        await client.query('COMMIT');
        const after = await this.getIntent(intent.id);
        if (after) recovered.push(after);
      } catch {
        await client.query('ROLLBACK').catch(() => {});
      } finally {
        client.release();
      }
    }
    return recovered;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async requireIntent(intentId: string, userId: string, executionProfileId: string): Promise<ProviderIntentRecord> {
    const intent = await this.getIntent(intentId);
    if (!intent) throw new ProviderMutationError('intent_not_found', 'Mutation intent not found');
    if (intent.userId !== userId || intent.executionProfileId !== executionProfileId) {
      throw new ProviderMutationError('intent_ownership_mismatch', 'Mutation intent belongs to another account', intent.id);
    }
    return intent;
  }

  /** The intent as seen by the caller's open transaction (M3 re-read under lock). */
  private async getIntentIn(client: pg.PoolClient, intentId: string): Promise<ProviderIntentRecord | null> {
    const { rows } = await client.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_provider_intents WHERE id = $1`,
      [intentId],
    );
    return rows[0] ? toIntentRecord(rows[0]) : null;
  }

  /** Every attempt of a lineage (the root plus all retries), inside the transaction. */
  private async lineageMembersIn(client: pg.PoolClient, rootIntentId: string): Promise<LineageMember[]> {
    const { rows } = await client.query<LineageMember>(
      `SELECT id, attempt, status, superseded_by_intent_id AS "supersededByIntentId"
         FROM execution_provider_intents
        WHERE id = $1 OR root_intent_id = $1
        ORDER BY attempt ASC, created_at ASC`,
      [rootIntentId],
    );
    return rows;
  }

  /**
   * M3 — the managed-order invariant, evaluated inside the caller's transaction
   * while the order lock is held: at most one unresolved provider mutation per
   * order (`unresolved_order_mutation`), and no new mutation for an order whose
   * submit was already provider-accepted (`duplicate_mutation`). Any row for
   * the order counts — including a legacy row without a Gate 9 identity — so a
   * mutation of unknown provider state is never silently duplicated.
   */
  private async assertOrderAcceptsNewMutationIn(client: pg.PoolClient, executionProfileId: string, orderId: string): Promise<void> {
    const live = await findLiveOrderMutation(client, executionProfileId, orderId);
    if (live) throw liveOrderMutationError(live);
  }

  /** Classifies a 0030 order-index violation after the transaction rolled back. */
  private async orderLiveViolation(executionProfileId: string, orderId: string): Promise<ProviderMutationError> {
    const live = await findLiveOrderMutation(this.pool, executionProfileId, orderId).catch(() => null);
    if (live) return liveOrderMutationError(live);
    return new ProviderMutationError(
      'unresolved_order_mutation',
      'Another provider mutation for this managed order was committed concurrently; no provider call is permitted',
    );
  }

  /**
   * M3 — structural freshness of the caller-supplied risk/authorization
   * reference, checked inside the retry transaction. Gate 9 never generates,
   * evaluates or approves a risk decision or an authorization; it only refuses
   * a reference that is not a fresh one under the existing schema contract:
   *
   *  - the risk decision must exist and be owned by the same user and profile;
   *  - it must not already back another Gate 9 intent (a retry never inherits
   *    or shares an approval);
   *  - the authorization id must not already have been consumed by a retry.
   */
  private async assertFreshRetryAuthorizationIn(
    client: pg.PoolClient,
    args: { parentId: string; userId: string; executionProfileId: string; riskDecisionId: string; authorizationId: string },
  ): Promise<void> {
    const notFresh = (message: string): ProviderMutationError =>
      new ProviderMutationError('retry_requires_fresh_authorization', message, args.parentId);
    if (!UUID_RE.test(args.riskDecisionId)) throw notFresh('A retry requires a fresh risk decision reference');

    const decision = await client.query<{ user_id: string; execution_profile_id: string | null }>(
      `SELECT user_id, execution_profile_id FROM risk_decisions WHERE id = $1`,
      [args.riskDecisionId],
    );
    const owner = decision.rows[0];
    if (!owner) throw notFresh('A retry requires an existing risk decision reference');
    if (owner.user_id !== args.userId || owner.execution_profile_id !== args.executionProfileId) {
      throw notFresh('The risk decision cited by the retry belongs to another account or execution profile');
    }

    const consumed = await client.query<{ id: string; attempt: number }>(
      `SELECT id, attempt FROM execution_provider_intents
        WHERE execution_profile_id = $1 AND risk_decision_id = $2
        LIMIT 1`,
      [args.executionProfileId, args.riskDecisionId],
    );
    const consumer = consumed.rows[0];
    if (consumer) {
      throw notFresh(`The risk decision cited by the retry already backs mutation attempt ${consumer.attempt}; a retry requires a fresh risk decision`);
    }

    const authorizationUsed = await client.query<{ intent_id: string }>(
      `SELECT intent_id FROM execution_provider_mutation_events
        WHERE execution_profile_id = $1 AND detail->>'authorizationId' = $2
        LIMIT 1`,
      [args.executionProfileId, args.authorizationId],
    );
    if (authorizationUsed.rows[0]) {
      throw notFresh('The execution authorization cited by the retry was already consumed; a retry requires a fresh authorization');
    }
  }

  private async findByIdentityIn(
    client: pg.PoolClient,
    input: { executionProfileId: string; clientOrderId: string; idempotencyKey?: string | null },
    requestHash: string,
  ): Promise<ProviderIntentRecord | null> {
    const { rows } = await client.query<IntentRow>(
      `SELECT ${INTENT_COLUMNS} FROM execution_provider_intents
        WHERE execution_profile_id = $1
          AND mutation_kind = 'submit'
          AND (client_order_id = $2
               OR ($3::text IS NOT NULL AND idempotency_key = $3)
               OR request_hash = $4)
        ORDER BY created_at ASC
        LIMIT 1`,
      [input.executionProfileId, input.clientOrderId, input.idempotencyKey ?? null, requestHash],
    );
    return rows[0] ? toIntentRecord(rows[0]) : null;
  }

  private async insertReservation(
    client: pg.PoolClient,
    args: {
      intentId: string;
      userId: string;
      executionProfileId: string;
      orderId: string | null;
      riskDecisionId: string | null;
      riskReservationId: string | null;
      clientOrderId: string;
      idempotencyKey: string;
      symbol: string | null;
      direction: string | null;
      monetaryRisk: string;
      riskExpiresAt: Date | null;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO execution_provider_mutation_reservations
         (intent_id, user_id, execution_profile_id, order_id, risk_decision_id, risk_reservation_id,
          mutation_kind, client_order_id, idempotency_key, symbol, direction, monetary_risk, state,
          requires_reconciliation, risk_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'submit',$7,$8,$9,$10,$11,'reserved',false,$12)`,
      [
        args.intentId,
        args.userId,
        args.executionProfileId,
        args.orderId,
        args.riskDecisionId,
        args.riskReservationId,
        args.clientOrderId,
        args.idempotencyKey,
        args.symbol,
        args.direction,
        args.monetaryRisk,
        args.riskExpiresAt,
      ],
    );
  }

  private async persistReceipt(barrier: SubmitBarrier, outcome: NormalizedSubmitOutcome): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO execution_provider_receipts
         (intent_id, user_id, execution_profile_id, client_order_id, idempotency_key, provider_slug,
          provider_order_id, outcome, uncertainty_reason, provider_status, status_uncertain,
          identity_verified, evidence, receipt, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,now())
       RETURNING id`,
      [
        barrier.intentId,
        barrier.userId,
        barrier.executionProfileId,
        barrier.clientOrderId,
        barrier.idempotencyKey,
        barrier.providerSlug,
        outcome.providerOrderId,
        outcome.outcome,
        outcome.uncertaintyReason,
        outcome.providerStatus,
        outcome.statusUncertain,
        outcome.outcome === 'uncertain' ? false : true,
        outcome.outcome === 'uncertain' ? null : 'provider_response_verified',
        JSON.stringify(outcome.receipt ?? {}),
      ],
    );
    return rows[0]!.id;
  }

  private async applyOutcome(
    barrier: SubmitBarrier,
    outcome: NormalizedSubmitOutcome,
  ): Promise<{ intentState: ProviderIntentState; reservationState: ProviderMutationReservationState | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`intent:${barrier.intentId}`]);
      const intent = await this.getIntent(barrier.intentId);
      if (!intent) throw new ProviderMutationError('intent_not_found', 'Mutation intent disappeared', barrier.intentId);
      const applied = await this.transitionIntent(client, {
        intent,
        toState: outcome.outcome === 'accepted' ? 'confirmed' : outcome.outcome === 'rejected' ? 'rejected' : 'uncertain',
        outcome: outcome.outcome,
        resolution: null,
        evidence: outcome.outcome === 'uncertain' ? null : 'provider_response_verified',
        uncertaintyReason: outcome.outcome === 'uncertain' ? outcome.uncertaintyReason : null,
        actor: 'system:mutation-ledger',
        detail: { providerOrderId: outcome.providerOrderId },
      });
      await client.query('COMMIT');
      return applied;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async transitionIntent(
    client: pg.PoolClient,
    args: {
      intent: ProviderIntentRecord;
      toState: ProviderIntentState;
      outcome: ProviderMutationOutcome | null;
      resolution: ProviderResolution | null;
      evidence: ProviderTerminalEvidence | null;
      uncertaintyReason: ProviderUncertaintyReason | null;
      actor: string;
      detail: Record<string, unknown>;
    },
  ): Promise<{ intentState: ProviderIntentState; reservationState: ProviderMutationReservationState | null }> {
    const { intent, toState } = args;
    // A Gate 9 intent always carries its identity; a legacy row (pre-0029) has
    // none and can never be transitioned by this ledger.
    if (!intent.idempotencyKey) {
      throw new ProviderMutationError('invalid_mutation_identity', 'Mutation intent is missing its idempotency identity', intent.id);
    }
    const updated = await client.query<{ status: ProviderIntentState }>(
      `UPDATE execution_provider_intents
          SET status = $3,
              outcome = $4,
              uncertainty_reason = $5,
              terminal_evidence = $6,
              resolution = $7,
              reconciliation_required = $8,
              reconciliation_state = $9,
              resolved_at = CASE WHEN $3 IN ('confirmed','rejected','reconciled') THEN now() ELSE NULL END
        WHERE id = $1 AND state_version = $2
      RETURNING status`,
      [
        intent.id,
        intent.stateVersion,
        toState,
        args.outcome,
        args.uncertaintyReason,
        args.evidence,
        args.resolution,
        toState === 'uncertain',
        toState === 'uncertain' ? 'pending' : toState === 'reconciled' ? 'resolved' : 'not_required',
      ],
    );
    if (updated.rows.length === 0) {
      throw new ProviderMutationError('concurrent_state_change', 'Mutation intent changed concurrently; the write was refused', intent.id);
    }

    const reservationState: ProviderMutationReservationState =
      toState === 'confirmed' || args.outcome === 'accepted'
        ? 'known_completed'
        : toState === 'rejected' || args.resolution === 'provider_rejected'
          ? 'known_rejected'
          : toState === 'reconciled' && args.resolution === 'provider_absent'
            ? 'known_rejected'
            : toState === 'reconciled'
              ? 'known_completed'
              : 'uncertain';

    await client.query(
      `UPDATE execution_provider_mutation_reservations
          SET state = $3,
              requires_reconciliation = $4
        WHERE intent_id = $1 AND version = $2`,
      [intent.id, await this.reservationVersion(client, intent.id), reservationState, reservationState === 'uncertain'],
    );

    await insertEvent(client, {
      intentId: intent.id,
      userId: intent.userId,
      executionProfileId: intent.executionProfileId,
      clientOrderId: intent.clientOrderId,
      idempotencyKey: intent.idempotencyKey,
      attempt: intent.attempt,
      fromState: intent.status,
      toState,
      outcome: args.outcome,
      evidence: args.evidence,
      uncertaintyReason: args.uncertaintyReason,
      actor: args.actor,
      detail: args.detail,
    });

    return { intentState: updated.rows[0]!.status, reservationState };
  }

  private async reservationVersion(client: pg.PoolClient, intentId: string): Promise<number> {
    const { rows } = await client.query<{ version: number }>(
      `SELECT version FROM execution_provider_mutation_reservations WHERE intent_id = $1`,
      [intentId],
    );
    const version = rows[0]?.version;
    if (version === undefined) throw new ProviderMutationError('intent_not_found', 'Mutation reservation missing', intentId);
    return version;
  }
}

/* -------------------------------------------------------------------------- */
/* Normalization / helpers                                                     */
/* -------------------------------------------------------------------------- */

/** A transport failure after the barrier is always uncertainty, never rejection. */
export function classifyTransportFailure(error: unknown): ProviderUncertaintyReason {
  const code = (error as { code?: unknown; detail?: { code?: unknown } } | null)?.detail?.code
    ?? (error as { code?: unknown } | null)?.code;
  if (code === 'timeout') return 'timeout';
  return 'connection_failure';
}

function assertSubmitIdentity(input: { clientOrderId: string; idempotencyKey: string; canonicalRequest?: Record<string, unknown> }): {
  clientOrderId: string;
  idempotencyKey: string;
  requestHash: string;
} {
  const decision = validateBridgeClientOrderId(input.clientOrderId);
  if (!decision.ok) {
    throw new ProviderMutationError('invalid_mutation_identity', `Client order identity rejected (${decision.code})`);
  }
  if (!isMutationIdentityHash(input.idempotencyKey)) {
    throw new ProviderMutationError('invalid_mutation_identity', 'Idempotency identity must be a 64-hex sha-256 key');
  }
  let requestHash: string;
  try {
    requestHash = canonicalMutationRequestHash({
      clientOrderId: input.clientOrderId,
      idempotencyKey: input.idempotencyKey,
      canonicalRequest: input.canonicalRequest ?? {},
    });
  } catch {
    throw new ProviderMutationError('invalid_mutation_identity', 'Canonical request identity refused');
  }
  return { clientOrderId: input.clientOrderId, idempotencyKey: input.idempotencyKey, requestHash };
}

function assertBinding(input: SubmitIntentInput): { environment: 'paper' | 'demo'; accountRef: string | null } {
  const parsed = providerCredentialBindingSchema.safeParse({
    credentialRef: input.credentialRef ?? null,
    credentialFingerprint: input.credentialFingerprint ?? null,
    environment: input.environment,
    accountRef: input.accountRef ?? null,
    brokerServerRef: input.brokerServerRef ?? null,
    // Gate 9 keeps the reference-only attestation boundary: no secret manager
    // is wired, so the flag can only ever be false here.
    secretManagerIntegrated: PROVIDER_MUTATION_SECRET_MANAGER_INTEGRATED,
  });
  if (!parsed.success) throw new ProviderMutationError('invalid_binding', 'Provider binding rejected before persistence');
  return { environment: parsed.data.environment, accountRef: parsed.data.accountRef };
}

function validateObservation(input: ReconciliationObservationInput): void {
  if (!['matched', 'mismatched', 'not_found', 'uncertain'].includes(input.outcome)) {
    throw new ProviderMutationError('invalid_observation', 'Unsupported reconciliation outcome');
  }
  if (input.outcome === 'not_found' && (input.providerStatus !== null || input.statusUncertain !== false)) {
    throw new ProviderMutationError('invalid_observation', 'A proven not-found observation carries no provider status');
  }
  if (input.outcome === 'uncertain' && input.statusUncertain !== true) {
    throw new ProviderMutationError('invalid_observation', 'An uncertain observation must state its uncertainty');
  }
  if ((input.outcome === 'matched' || input.outcome === 'mismatched') && input.providerStatus === null) {
    throw new ProviderMutationError('invalid_observation', 'A matched or mismatched observation must state the observed provider status');
  }
}

function isProviderIntentUnresolvedState(state: ProviderIntentState): boolean {
  return state === 'prepared' || state === 'submitting' || state === 'uncertain';
}

function isProviderIntentTerminalState(state: ProviderIntentState): boolean {
  return state === 'confirmed' || state === 'rejected' || state === 'reconciled';
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/* -------------------------------------------------------------------------- */
/* M3 — structural duplicate-mutation / retry invariant helpers                */
/* -------------------------------------------------------------------------- */

/** Migration 0030 index names (defense-in-depth twins of the checks above). */
const PARENT_UNIQUE_INDEX = 'execution_provider_intents_parent_uniq';
const LINEAGE_ATTEMPT_UNIQUE_INDEX = 'execution_provider_intents_lineage_attempt_uniq';
const ORDER_LIVE_UNIQUE_INDEX = 'execution_provider_intents_order_live_uniq';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LineageMember {
  id: string;
  attempt: number;
  status: ProviderIntentState;
  supersededByIntentId: string | null;
}

interface LiveOrderMutation {
  id: string;
  status: ProviderIntentState;
  resolution: ProviderResolution | null;
  attempt: number;
  clientOrderId: string;
}

/** Transaction-scoped advisory lock; released by COMMIT/ROLLBACK only. */
async function acquireXactLock(client: pg.PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

/** Existing per-identity lock key (unchanged from M1/M2). */
function identityLockKey(executionProfileId: string, clientOrderId: string): string {
  return `${executionProfileId}:${clientOrderId}`;
}

/** M3 — one writer at a time per managed order inside an execution profile. */
function orderLockKey(executionProfileId: string, orderId: string): string {
  return `order:${executionProfileId}:${orderId}`;
}

/** M3 — one retry writer at a time per lineage inside an execution profile. */
function lineageLockKey(executionProfileId: string, rootIntentId: string): string {
  return `lineage:${executionProfileId}:${rootIntentId}`;
}

function violatedConstraint(error: unknown): string | null {
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  return typeof constraint === 'string' ? constraint : null;
}

function assertIntentOwnership(intent: ProviderIntentRecord, userId: string, executionProfileId: string): void {
  if (intent.userId !== userId || intent.executionProfileId !== executionProfileId) {
    throw new ProviderMutationError('intent_ownership_mismatch', 'Original mutation intent belongs to another account', intent.id);
  }
}

/** `confirmed`, or `reconciled` with a `provider_accepted` resolution. */
function isProviderAcceptedIntent(intent: { status: ProviderIntentState; resolution: ProviderResolution | null }): boolean {
  return intent.status === 'confirmed' || (intent.status === 'reconciled' && intent.resolution === 'provider_accepted');
}

/** A retry may only continue a verified rejection or an explicit absence. */
function isRetryEligibleResolution(intent: { status: ProviderIntentState; resolution: ProviderResolution | null }): boolean {
  return intent.status === 'rejected'
    || (intent.status === 'reconciled' && (intent.resolution === 'provider_rejected' || intent.resolution === 'provider_absent'));
}

/**
 * The "live" mutation for a managed order, if any: unresolved (`prepared`,
 * `submitting`, `uncertain`) or provider-accepted (`confirmed`, or `reconciled`
 * as `provider_accepted`). Scoped to the execution profile like every other
 * mutation identity lookup; the predicate is the application twin of the 0030
 * `execution_provider_intents_order_live_uniq` index (which additionally
 * excludes legacy rows without a Gate 9 identity — here they count, fail closed).
 */
async function findLiveOrderMutation(
  queryable: Pick<pg.PoolClient, 'query'>,
  executionProfileId: string,
  orderId: string,
): Promise<LiveOrderMutation | null> {
  const { rows } = await queryable.query<{
    id: string;
    status: ProviderIntentState;
    resolution: ProviderResolution | null;
    attempt: number;
    client_order_id: string;
  }>(
    `SELECT id, status, resolution, attempt, client_order_id
       FROM execution_provider_intents
      WHERE execution_profile_id = $1
        AND order_id = $2
        AND (
          status IN ('prepared', 'submitting', 'uncertain', 'confirmed')
          OR (status = 'reconciled' AND resolution = 'provider_accepted')
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [executionProfileId, orderId],
  );
  const row = rows[0];
  return row ? { id: row.id, status: row.status, resolution: row.resolution, attempt: row.attempt, clientOrderId: row.client_order_id } : null;
}

function liveOrderMutationError(live: LiveOrderMutation): ProviderMutationError {
  if (isProviderIntentUnresolvedState(live.status)) {
    return new ProviderMutationError(
      'unresolved_order_mutation',
      `An unresolved provider mutation (attempt ${live.attempt}, status ${live.status}) already exists for this managed order; it must be resolved through reconciliation or operator resolution before another mutation is permitted`,
      live.id,
    );
  }
  return new ProviderMutationError(
    'duplicate_mutation',
    `The provider already accepted a submit mutation for this managed order (attempt ${live.attempt}); another order after confirmation needs a distinct logical order identity`,
    live.id,
  );
}

async function insertEvent(
  client: pg.PoolClient,
  args: {
    intentId: string;
    userId: string;
    executionProfileId: string;
    clientOrderId: string;
    idempotencyKey: string;
    attempt: number;
    fromState: ProviderIntentState | null;
    toState: ProviderIntentState;
    outcome?: ProviderMutationOutcome | null;
    evidence?: ProviderTerminalEvidence | null;
    uncertaintyReason?: ProviderUncertaintyReason | null;
    actor?: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO execution_provider_mutation_events
       (intent_id, user_id, execution_profile_id, client_order_id, idempotency_key, attempt,
        from_state, to_state, outcome, evidence, uncertainty_reason, actor, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [
      args.intentId,
      args.userId,
      args.executionProfileId,
      args.clientOrderId,
      args.idempotencyKey,
      args.attempt,
      args.fromState,
      args.toState,
      args.outcome ?? null,
      args.evidence ?? null,
      args.uncertaintyReason ?? null,
      args.actor ?? 'system:mutation-ledger',
      JSON.stringify(args.detail ?? {}),
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

interface IntentRow {
  id: string;
  user_id: string;
  execution_profile_id: string;
  order_id: string | null;
  mutation_kind: string;
  client_order_id: string;
  idempotency_key: string | null;
  request_hash: string | null;
  provider_slug: string;
  environment: string | null;
  account_ref: string | null;
  broker_server_ref: string | null;
  credential_ref: string | null;
  credential_fingerprint: string | null;
  status: ProviderIntentState;
  outcome: ProviderMutationOutcome | null;
  uncertainty_reason: ProviderUncertaintyReason | null;
  terminal_evidence: ProviderTerminalEvidence | null;
  resolution: ProviderResolution | null;
  parent_intent_id: string | null;
  root_intent_id: string | null;
  superseded_by_intent_id: string | null;
  attempt: number;
  reconciliation_required: boolean;
  reconciliation_state: string;
  risk_decision_id: string | null;
  state_version: number;
  submitted_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ReservationRow {
  id: string;
  intent_id: string;
  state: ProviderMutationReservationState;
  requires_reconciliation: boolean;
  risk_reservation_id: string | null;
  risk_expires_at: Date | null;
  monetary_risk: string;
  symbol: string | null;
  direction: string | null;
  version: number;
}

function toIntentRecord(row: IntentRow): ProviderIntentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    executionProfileId: row.execution_profile_id,
    orderId: row.order_id,
    mutationKind: row.mutation_kind,
    clientOrderId: row.client_order_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    providerSlug: row.provider_slug,
    environment: row.environment,
    accountRef: row.account_ref,
    brokerServerRef: row.broker_server_ref,
    credentialRef: row.credential_ref,
    credentialFingerprint: row.credential_fingerprint,
    status: row.status,
    outcome: row.outcome,
    uncertaintyReason: row.uncertainty_reason,
    terminalEvidence: row.terminal_evidence,
    resolution: row.resolution,
    parentIntentId: row.parent_intent_id,
    rootIntentId: row.root_intent_id,
    supersededByIntentId: row.superseded_by_intent_id,
    attempt: row.attempt,
    reconciliationRequired: row.reconciliation_required,
    reconciliationState: row.reconciliation_state,
    riskDecisionId: row.risk_decision_id,
    stateVersion: row.state_version,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toReservationRecord(row: ReservationRow): MutationReservationRecord {
  return {
    id: row.id,
    intentId: row.intent_id,
    state: row.state,
    requiresReconciliation: row.requires_reconciliation,
    riskReservationId: row.risk_reservation_id,
    riskExpiresAt: row.risk_expires_at,
    monetaryRisk: row.monetary_risk,
    symbol: row.symbol,
    direction: row.direction,
    version: row.version,
  };
}
