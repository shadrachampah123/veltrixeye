import { z } from 'zod';
import {
  BRIDGE_MUTATION_KINDS,
  BRIDGE_NORMALIZED_STATUSES,
  BRIDGE_RECONCILIATION_OUTCOMES,
  BRIDGE_TERMINAL_EVIDENCE,
  containsForbiddenAuditKey,
  normalizeProviderOrderStatus,
  type BridgeMutationKind,
  type BridgeNormalizedStatus,
  type BridgeReconciliationOutcome,
  type BridgeTerminalEvidence,
} from './mt5-bridge-protocol.js';

/**
 * M10 Gate 9 — durable provider-mutation persistence contract
 * (replacement authority for the unrecovered §22/§24/§31 persistence material).
 *
 * This module pins the VOCABULARY and the normalization/sanitization rules for
 * the durable submit ledger. It deliberately contains no transport, no
 * credential field and no live/broker behavior:
 *
 *  - an unresolved mutation is `uncertain`, never `rejected`;
 *  - a missing response is not evidence of anything;
 *  - a receipt is sanitized before it can be persisted, and credential-shaped
 *    keys are rejected (not redacted);
 *  - retry requires a resolved original plus a brand-new mutation identity.
 *
 * The database enforces the same vocabulary (migration `0029`), so a future
 * implementation cannot widen the contract in one place only.
 */

/* -------------------------------------------------------------------------- */
/* §3 Intent state machine                                                     */
/* -------------------------------------------------------------------------- */

export const PROVIDER_INTENT_STATES = [
  'prepared',
  'submitting',
  'confirmed',
  'rejected',
  'uncertain',
  'reconciled',
] as const;
export type ProviderIntentState = (typeof PROVIDER_INTENT_STATES)[number];

/**
 * The only transitions the durable ledger may perform.
 *
 * `submitting -> reconciled` exists for operator resolution of an intent that
 * crashed in flight (§8: such an intent is *unresolved*, and §14 allows an
 * explicitly authorized operator to resolve an unresolved mutation using
 * documented evidence). It can never produce a new submission.
 */
export const PROVIDER_INTENT_TRANSITIONS: Readonly<Record<ProviderIntentState, readonly ProviderIntentState[]>> = Object.freeze({
  prepared: ['submitting'],
  submitting: ['confirmed', 'rejected', 'uncertain', 'reconciled'],
  confirmed: [],
  rejected: [],
  uncertain: ['reconciled'],
  reconciled: [],
});

export function isProviderIntentTransitionAllowed(from: ProviderIntentState, to: ProviderIntentState): boolean {
  return (PROVIDER_INTENT_TRANSITIONS[from] ?? []).includes(to);
}

/** Terminal states cannot leave; `uncertain` is NOT terminal — it awaits resolution. */
export const PROVIDER_INTENT_TERMINAL_STATES: readonly ProviderIntentState[] = ['confirmed', 'rejected', 'reconciled'];

export function isProviderIntentTerminal(state: ProviderIntentState): boolean {
  return PROVIDER_INTENT_TERMINAL_STATES.includes(state);
}

/**
 * An unresolved intent is one whose provider outcome is not established.
 * `prepared` is included: submission was never authorized, so nothing may be
 * inferred from it — and nothing may be submitted through it either.
 */
export const PROVIDER_INTENT_UNRESOLVED_STATES: readonly ProviderIntentState[] = ['prepared', 'submitting', 'uncertain'];

export function isProviderIntentUnresolved(state: ProviderIntentState): boolean {
  return PROVIDER_INTENT_UNRESOLVED_STATES.includes(state);
}

/* -------------------------------------------------------------------------- */
/* §1 Mutation kinds — Gate 9 persists `submit` only                           */
/* -------------------------------------------------------------------------- */

export const PROVIDER_MUTATION_KINDS = BRIDGE_MUTATION_KINDS;
export type ProviderMutationKind = BridgeMutationKind;

/** The only kind Gate 9's durable ledger accepts. cancel/modify/close are out of scope. */
export const GATE9_PERSISTED_MUTATION_KINDS: readonly ProviderMutationKind[] = ['submit'];

export function isGate9PersistedMutationKind(kind: unknown): kind is 'submit' {
  return kind === 'submit';
}

/* -------------------------------------------------------------------------- */
/* §5 Outcomes, §4 reservation states, uncertainty reasons                     */
/* -------------------------------------------------------------------------- */

export const PROVIDER_MUTATION_OUTCOMES = ['accepted', 'rejected', 'uncertain'] as const;
export type ProviderMutationOutcome = (typeof PROVIDER_MUTATION_OUTCOMES)[number];

export const PROVIDER_MUTATION_RESERVATION_STATES = ['reserved', 'known_completed', 'known_rejected', 'uncertain'] as const;
export type ProviderMutationReservationState = (typeof PROVIDER_MUTATION_RESERVATION_STATES)[number];

/** Reservation transition rules (§4): uncertainty and completion are one-way. */
export const PROVIDER_RESERVATION_TRANSITIONS: Readonly<Record<ProviderMutationReservationState, readonly ProviderMutationReservationState[]>> = Object.freeze({
  reserved: ['known_completed', 'known_rejected', 'uncertain'],
  known_completed: [],
  known_rejected: [],
  uncertain: ['known_completed', 'known_rejected'],
});

export function isProviderReservationTransitionAllowed(
  from: ProviderMutationReservationState,
  to: ProviderMutationReservationState,
): boolean {
  return (PROVIDER_RESERVATION_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Why a mutation could not be resolved. A closed vocabulary: provider text is
 * never persisted (§2, §11).
 */
export const PROVIDER_UNCERTAINTY_REASONS = [
  'timeout',
  'connection_failure',
  'lost_response',
  'malformed_response',
  'unknown_provider_status',
  'identity_verification_failed',
  'receipt_persistence_failure',
  'state_commit_failed',
  'process_restart',
  'crash_before_provider_call',
] as const;
export type ProviderUncertaintyReason = (typeof PROVIDER_UNCERTAINTY_REASONS)[number];

export const PROVIDER_TERMINAL_EVIDENCE = BRIDGE_TERMINAL_EVIDENCE;
export type ProviderTerminalEvidence = BridgeTerminalEvidence;

export const PROVIDER_RECONCILIATION_OUTCOMES = BRIDGE_RECONCILIATION_OUTCOMES;
export type ProviderReconciliationOutcome = BridgeReconciliationOutcome;

/**
 * How an uncertain mutation was finally resolved (§14). `provider_absent`
 * is the "verified absence" resolution: established through explicit operator
 * resolution (never through an automatic reconciliation transition), it resolves
 * the uncertainty WITHOUT claiming a rejection (`not_found` is a proven
 * observation, never an automatic state transition or rejection).
 */
export const PROVIDER_RESOLUTIONS = ['provider_accepted', 'provider_rejected', 'provider_absent'] as const;
export type ProviderResolution = (typeof PROVIDER_RESOLUTIONS)[number];

export const PROVIDER_RECONCILIATION_STATES = ['not_required', 'pending', 'resolved'] as const;
export type ProviderReconciliationState = (typeof PROVIDER_RECONCILIATION_STATES)[number];

/* -------------------------------------------------------------------------- */
/* §5 Sanitized provider receipt (allowlist only)                              */
/* -------------------------------------------------------------------------- */

const receiptTimestampSchema = z.string().datetime({ offset: true }).max(64);

/**
 * The ONLY shape a persisted provider receipt may take. Strict: no provider
 * payload is ever copied through, and every field is bounded.
 */
export const providerReceiptSchema = z
  .object({
    providerOrderId: z.string().min(1).max(128).nullable(),
    /** Normalized snapshot status; `null` + `statusUncertain` when unreadable (§18/B9). */
    providerStatus: z.enum(BRIDGE_NORMALIZED_STATUSES).nullable(),
    statusUncertain: z.boolean(),
    filledQuantity: z.number().finite().min(0).max(1_000_000).nullable(),
    averagePrice: z.number().finite().positive().max(1_000_000_000_000).nullable(),
    occurredAt: receiptTimestampSchema,
  })
  .strict();
export type ProviderReceipt = z.infer<typeof providerReceiptSchema>;

export const PROVIDER_RECEIPT_REJECTION_CODES = [
  'receipt_not_an_object',
  'receipt_forbidden_key',
  'receipt_field_invalid',
] as const;
export type ProviderReceiptRejectionCode = (typeof PROVIDER_RECEIPT_REJECTION_CODES)[number];

export interface ProviderReceiptSanitization {
  ok: boolean;
  code: ProviderReceiptRejectionCode | 'ok';
  receipt: ProviderReceipt | null;
}

const RECEIPT_ALLOWED_FIELDS = [
  'providerOrderId',
  'providerStatus',
  'statusUncertain',
  'filledQuantity',
  'averagePrice',
  'occurredAt',
] as const;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * Builds the persisted receipt from a provider response.
 *
 * Two rules make this fail closed rather than fail open:
 *
 *  1. credential-shaped keys are REJECTED, never redacted (§11/§24) — a
 *     provider response that carries `password`/`token`/`secret`/… cannot be
 *     persisted, so the mutation stays uncertain instead of being laundered
 *     into a "clean" record;
 *  2. only allowlisted, type-checked scalars are copied. An unexpected or
 *     invalid field is a rejection (`receipt_field_invalid`), never a
 *     best-effort projection.
 */
export function sanitizeProviderReceipt(raw: unknown, fallback?: { occurredAt?: string }): ProviderReceiptSanitization {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'receipt_not_an_object', receipt: null };
  }
  // Reject before copying: a redacted copy would still be a copy we chose to trust.
  if (containsForbiddenAuditKey(raw)) return { ok: false, code: 'receipt_forbidden_key', receipt: null };

  const source = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(source).filter((key) => !(RECEIPT_ALLOWED_FIELDS as readonly string[]).includes(key));

  const providerOrderId = source.providerOrderId === undefined ? null : source.providerOrderId;
  const providerStatus = source.providerStatus === undefined ? null : source.providerStatus;
  const statusUncertain = source.statusUncertain === undefined ? false : source.statusUncertain;
  const filledQuantity = source.filledQuantity === undefined ? null : source.filledQuantity;
  const averagePrice = source.averagePrice === undefined ? null : source.averagePrice;
  const occurredAt = source.occurredAt === undefined ? (fallback?.occurredAt ?? null) : source.occurredAt;

  if (unknownKeys.length > 0) return { ok: false, code: 'receipt_field_invalid', receipt: null };
  if (providerOrderId !== null && !isBoundedString(providerOrderId, 128)) return { ok: false, code: 'receipt_field_invalid', receipt: null };
  if (providerStatus !== null && !isNormalizedProviderStatus(providerStatus)) return { ok: false, code: 'receipt_field_invalid', receipt: null };
  if (typeof statusUncertain !== 'boolean') return { ok: false, code: 'receipt_field_invalid', receipt: null };
  if (filledQuantity !== null && !isFiniteNumber(filledQuantity)) return { ok: false, code: 'receipt_field_invalid', receipt: null };
  if (averagePrice !== null && !isFiniteNumber(averagePrice)) return { ok: false, code: 'receipt_field_invalid', receipt: null };
  if (occurredAt === null || !receiptTimestampSchema.safeParse(occurredAt).success) return { ok: false, code: 'receipt_field_invalid', receipt: null };

  const parsed = providerReceiptSchema.safeParse({
    providerOrderId,
    providerStatus,
    statusUncertain,
    filledQuantity,
    averagePrice,
    occurredAt,
  });
  if (!parsed.success) return { ok: false, code: 'receipt_field_invalid', receipt: null };
  return { ok: true, code: 'ok', receipt: Object.freeze(parsed.data) };
}

function isNormalizedProviderStatus(value: unknown): value is BridgeNormalizedStatus {
  return typeof value === 'string' && (BRIDGE_NORMALIZED_STATUSES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* §6 Canonical request identity                                               */
/* -------------------------------------------------------------------------- */

const HEX64 = /^[0-9a-f]{64}$/;

export function isMutationIdentityHash(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

/** Stable JSON: keys sorted, arrays ordered, `undefined` dropped. */
export function canonicalizeMutationRequest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalizeMutationRequest).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeMutationRequest(v)}`).join(',')}}`;
}

/* -------------------------------------------------------------------------- */
/* §5 Identity verification of a provider response                             */
/* -------------------------------------------------------------------------- */

export const PROVIDER_IDENTITY_CODES = [
  'ok',
  'missing_client_order_id',
  'client_order_id_mismatch',
  'idempotency_key_mismatch',
  'account_binding_mismatch',
  'provider_order_id_missing',
] as const;
export type ProviderIdentityCode = (typeof PROVIDER_IDENTITY_CODES)[number];

export interface ProviderIdentityCheck {
  ok: boolean;
  code: ProviderIdentityCode;
}

/**
 * Identity verification (§5): an `accepted` claim is only evidence when it
 * names the VeltrixEye order it claims to have accepted, on the bound account.
 * A mismatch is uncertainty, never a silent rejection.
 */
export function verifyProviderResponseIdentity(args: {
  clientOrderId: string;
  idempotencyKey: string;
  accountRef: string | null;
  response: {
    clientOrderId?: unknown;
    idempotencyKey?: unknown;
    accountRef?: unknown;
    providerOrderId?: unknown;
  };
}): ProviderIdentityCheck {
  const { response } = args;
  if (typeof response.clientOrderId !== 'string' || response.clientOrderId.length === 0) {
    return { ok: false, code: 'missing_client_order_id' };
  }
  if (response.clientOrderId !== args.clientOrderId) return { ok: false, code: 'client_order_id_mismatch' };
  if (response.idempotencyKey !== undefined && response.idempotencyKey !== args.idempotencyKey) {
    return { ok: false, code: 'idempotency_key_mismatch' };
  }
  if (response.accountRef !== undefined && response.accountRef !== null && response.accountRef !== args.accountRef) {
    return { ok: false, code: 'account_binding_mismatch' };
  }
  if (response.providerOrderId !== undefined && response.providerOrderId !== null
    && !isBoundedString(response.providerOrderId, 128)) {
    return { ok: false, code: 'provider_order_id_missing' };
  }
  return { ok: true, code: 'ok' };
}

/* -------------------------------------------------------------------------- */
/* §5 Outcome normalization (shared rule: the ledger and the DB agree)          */
/* -------------------------------------------------------------------------- */

/** Provider status tokens that mean "the provider accepted the submit". */
export const PROVIDER_ACCEPTED_STATUSES: readonly string[] = ['requested', 'placed', 'accepted', 'partial', 'filled'];
/** Provider status tokens that mean "the provider definitively did not accept". */
export const PROVIDER_REJECTED_STATUSES: readonly string[] = ['rejected', 'cancelled', 'canceled', 'expired'];

export interface NormalizedSubmitOutcome {
  outcome: ProviderMutationOutcome;
  uncertaintyReason: ProviderUncertaintyReason | null;
  receipt: ProviderReceipt | null;
  providerOrderId: string | null;
  providerStatus: BridgeNormalizedStatus | null;
  statusUncertain: boolean;
}

/** The identity a provider response must echo to be believed. */
export interface SubmitIdentityProbe {
  clientOrderId: string;
  idempotencyKey: string;
  accountRef: string | null;
}

/**
 * Maps a provider submit response onto the closed outcome vocabulary (§5).
 *
 * Everything that is not an identity-verified acceptance or rejection becomes
 * `uncertain`: a missing, lost, malformed or unreadable response is never a
 * rejection, and an identity mismatch after a mutation may already have
 * occurred is uncertainty, not a silent failure.
 */
export function normalizeSubmitOutcome(barrier: SubmitIdentityProbe, raw: unknown): NormalizedSubmitOutcome {
  const uncertain = (reason: ProviderUncertaintyReason, status: BridgeNormalizedStatus | null = null): NormalizedSubmitOutcome => ({
    outcome: 'uncertain',
    uncertaintyReason: reason,
    receipt: null,
    providerOrderId: null,
    providerStatus: status ?? 'uncertain',
    statusUncertain: true,
  });

  // A lost response is not a rejection (§5).
  if (raw === null || raw === undefined) return uncertain('lost_response');
  if (typeof raw !== 'object' || Array.isArray(raw)) return uncertain('malformed_response');
  // A response carrying credential-shaped material is REFUSED, not redacted
  // (§11/§24): nothing from it is read, so nothing from it can be persisted.
  if (containsForbiddenAuditKey(raw)) return uncertain('malformed_response');

  const response = raw as Record<string, unknown>;
  // HIGH-2: `receipt` is intentionally NOT accepted from the provider response.
  // The persisted receipt is always built from validated fields (providerOrderId,
  // providerStatus, etc.) through `sanitizeProviderReceipt`, never copied from
  // provider-controlled `receipt`. Any provider response carrying `receipt`
  // (including nested credential-shaped or malformed content) is treated as
  // malformed and becomes `uncertain`, so hostile nested data can never cross
  // the normalization boundary or become persisted provider evidence.
  for (const key of Object.keys(response)) {
    if (!['clientOrderId', 'idempotencyKey', 'accountRef', 'providerOrderId', 'status'].includes(key)) {
      return uncertain('malformed_response');
    }
  }

  const identity = verifyProviderResponseIdentity({
    clientOrderId: barrier.clientOrderId,
    idempotencyKey: barrier.idempotencyKey,
    accountRef: barrier.accountRef,
    response,
  });
  if (!identity.ok) return uncertain('identity_verification_failed');

  const normalized = normalizeProviderOrderStatus(typeof response.status === 'string' ? response.status : null);
  if (normalized.statusUncertain || normalized.status === null) return uncertain('unknown_provider_status');

  const occurredAt = new Date().toISOString();
  const sanitized = sanitizeProviderReceipt(
    {
      providerOrderId: typeof response.providerOrderId === 'string' ? response.providerOrderId : null,
      providerStatus: normalized.snapshotStatus,
      statusUncertain: false,
      filledQuantity: null,
      averagePrice: null,
      occurredAt,
    },
    { occurredAt },
  );
  if (!sanitized.ok || !sanitized.receipt) return uncertain('malformed_response');

  const token = String(response.status);
  if (PROVIDER_ACCEPTED_STATUSES.includes(token)) {
    // An acceptance without a provider ticket cannot be identity-verified.
    if (typeof response.providerOrderId !== 'string' || response.providerOrderId.length === 0) {
      return uncertain('identity_verification_failed');
    }
    return {
      outcome: 'accepted',
      uncertaintyReason: null,
      receipt: sanitized.receipt,
      providerOrderId: response.providerOrderId,
      providerStatus: normalized.snapshotStatus,
      statusUncertain: false,
    };
  }
  if (PROVIDER_REJECTED_STATUSES.includes(token)) {
    return {
      outcome: 'rejected',
      uncertaintyReason: null,
      receipt: sanitized.receipt,
      providerOrderId: typeof response.providerOrderId === 'string' ? response.providerOrderId : null,
      providerStatus: normalized.snapshotStatus,
      statusUncertain: false,
    };
  }
  return uncertain('unknown_provider_status', normalized.snapshotStatus);
}

/* -------------------------------------------------------------------------- */
/* §11 Attestation boundary (declared, never wired by Gate 9)                  */
/* -------------------------------------------------------------------------- */

/**
 * Gate 9 preserves the reference-only credential-binding contract. Only
 * identifiers and a non-secret fingerprint may be persisted; the flag stays
 * `false` until a separately approved implementation adds a real secret-manager
 * integration.
 */
export const PROVIDER_MUTATION_SECRET_MANAGER_INTEGRATED = false;

export const providerCredentialBindingSchema = z
  .object({
    /** Reference identifier only (never a secret value). */
    credentialRef: z.string().min(1).max(128).nullable(),
    /** Non-secret identity fingerprint of the binding (64-hex when present). */
    credentialFingerprint: z.string().regex(HEX64).nullable(),
    environment: z.enum(['paper', 'demo']),
    accountRef: z.string().min(1).max(128).nullable(),
    brokerServerRef: z.string().min(1).max(128).nullable(),
    secretManagerIntegrated: z.literal(false),
  })
  .strict();
export type ProviderCredentialBinding = z.infer<typeof providerCredentialBindingSchema>;
