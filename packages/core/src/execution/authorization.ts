/**
 * B1 — authorization/composition layer.
 *
 * Server-issued, one-shot, TTL-bound execution authorization.
 *
 * This module provides the generic authorization service that the broker
 * (MT5) path and the composed paper path use. It is the B1 authorization
 * layer: after the execution gates pass with fresh reads, the composition
 * service mints an authorization here, bound to the complete immutable
 * execution context (principal, profile, provider, environment, account,
 * server, setup, risk decision) AND the exact mutation identity
 * (clientOrderId, idempotencyKey, symbol, side, quantity, assetClass,
 * orderType, stopLoss, takeProfit, requestedPrice), and hands the opaque
 * `authorizationId` to the submit path. The executor then consumes it
 * exactly once — a replay, a different mutation, a different execution
 * context, or an expired authorization is refused before any provider call.
 *
 * B1 remediation invariants (H1, M1):
 *
 *  H1 — consumption enforces the COMPLETE immutable execution context. The
 *       caller must present the expected context (userId,
 *       executionProfileId, providerSlug, environment, accountRef,
 *       brokerServerRef, setupId, riskDecisionId) and every field must match
 *       the stored authorization exactly, including null-vs-non-null
 *       semantics (a stored null only matches an expected null). An
 *       authorization minted for one account/server/profile/user/setup/risk
 *       can never authorize a mutation for another. Provider configuration
 *       alone is never consulted here — the expected context is supplied by
 *       the composition from its authoritative snapshot, and the provider
 *       instance binding is additionally enforced by the B2 boundary (F2).
 *
 *  M1 — no mutable internal state ever escapes. Mint/consume/peek return
 *       frozen defensive copies; the stored record is never handed out, so a
 *       caller cannot mutate the map through a returned reference. Creation
 *       validates finiteness (finite positive quantity, finite-or-null
 *       prices) and rejects NaN/non-finite/empty values before anything is
 *       stored.
 *
 * Properties:
 *  - in-memory only, never persisted (like paper's original map). Durable
 *    safety is Gate 9's `ProviderMutationLedger`; this layer is the
 *    composition-time authorization that precedes it.
 *  - single-use: consume removes it, second consume fails closed.
 *  - TTL-bound: expired authorizations are refused and cleaned.
 *  - exact binding: the request AND the execution context presented at
 *    consumption must match the stored authorization field-for-field
 *    (quantity with tolerance 1e-9, prices with same tolerance, strings and
 *    nulls exact). No partial match, no widening.
 *  - no credentials, no network, no secret-manager integration.
 *  - bounded map: max 1000 entries, expired entries purged on create and
 *    when size exceeds bound.
 */

import { randomUUID } from 'node:crypto';
import { ExecutionProviderError, type ExecutionSubmitOrderRequest } from '@veltrixeye/contracts';

export interface ExecutionAuthorization {
  readonly id: string;
  readonly userId: string;
  readonly executionProfileId: string;
  readonly clientOrderId: string;
  readonly idempotencyKey: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: number;
  readonly assetClass: string;
  readonly orderType: string;
  readonly stopLossPrice: number | null;
  readonly takeProfitPrice: number | null;
  readonly requestedPrice: number | null;
  readonly providerSlug: string;
  readonly environment: 'paper' | 'demo';
  readonly accountRef: string | null;
  readonly brokerServerRef: string | null;
  readonly riskDecisionId: string | null;
  readonly setupId: string | null;
  readonly createdMs: number;
  /** Always false on a live record: consumption deletes the record instead of mutating it. */
  readonly consumed: boolean;
}

/**
 * H1 — the complete immutable execution context an authorization is bound
 * to. The composition builds this from its authoritative snapshot (server
 * DB reads, never caller claims) and the consumer must present it exactly.
 */
export interface AuthorizationExecutionContext {
  readonly userId: string;
  readonly executionProfileId: string;
  readonly providerSlug: string;
  readonly environment: 'paper' | 'demo';
  readonly accountRef: string | null;
  readonly brokerServerRef: string | null;
  readonly setupId: string | null;
  readonly riskDecisionId: string | null;
}

export interface ExecutionAuthorizationServiceOptions {
  ttlMs?: number;
  maxEntries?: number;
  clock?: () => number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1000;
const QUANTITY_TOLERANCE = 1e-9;
const PRICE_TOLERANCE = 1e-9;

/**
 * H1 — exact execution-context comparison, including null-vs-non-null
 * semantics. Every field uses strict equality: a stored `null` matches only
 * an expected `null`, and a stored value matches only the identical value.
 * Returns the first mismatching field, or null when the context matches.
 */
export function diffAuthorizationContext(
  stored: Pick<
    ExecutionAuthorization,
    'userId' | 'executionProfileId' | 'providerSlug' | 'environment' | 'accountRef' | 'brokerServerRef' | 'setupId' | 'riskDecisionId'
  >,
  expected: AuthorizationExecutionContext,
): string | null {
  if (stored.userId !== expected.userId) return 'userId';
  if (stored.executionProfileId !== expected.executionProfileId) return 'executionProfileId';
  if (stored.providerSlug !== expected.providerSlug) return 'providerSlug';
  if (stored.environment !== expected.environment) return 'environment';
  if (stored.accountRef !== expected.accountRef) return 'accountRef';
  if (stored.brokerServerRef !== expected.brokerServerRef) return 'brokerServerRef';
  if (stored.setupId !== expected.setupId) return 'setupId';
  if (stored.riskDecisionId !== expected.riskDecisionId) return 'riskDecisionId';
  return null;
}

/**
 * H1 — throws a closed `validation` error unless the stored authorization
 * record matches the expected immutable execution context exactly. Shared by
 * the consuming path (consumeAuthorization), the pre-submit verification
 * path (final safety fence peek + compare), and the paper handoff, so all
 * three enforce the identical rule.
 */
export function assertAuthorizationContext(
  stored: Pick<
    ExecutionAuthorization,
    'userId' | 'executionProfileId' | 'providerSlug' | 'environment' | 'accountRef' | 'brokerServerRef' | 'setupId' | 'riskDecisionId'
  >,
  expected: AuthorizationExecutionContext,
): void {
  const mismatch = diffAuthorizationContext(stored, expected);
  if (mismatch) {
    throw new ExecutionProviderError(
      'validation',
      'execution authorization was not issued for this execution context',
    );
  }
}

export class ExecutionAuthorizationService {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly authorizations = new Map<string, ExecutionAuthorization>();

  constructor(options?: ExecutionAuthorizationServiceOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = options?.clock ?? (() => Date.now());
  }

  /**
   * Mint a new authorization bound to the exact mutation identity AND the
   * complete immutable execution context.
   *
   * The caller must have already evaluated all gates with fresh reads and
   * must supply the context from its authoritative snapshot. M1: every value
   * is validated (finite positive quantity, finite-or-null prices, non-empty
   * identity strings) and the returned record is a frozen defensive copy —
   * mutating it cannot affect the stored authorization.
   */
  createAuthorization(input: {
    userId: string;
    executionProfileId: string;
    clientOrderId: string;
    idempotencyKey: string;
    symbol: string;
    side: 'buy' | 'sell';
    quantity: number;
    assetClass: string;
    orderType: string;
    stopLossPrice?: number | null;
    takeProfitPrice?: number | null;
    requestedPrice?: number | null;
    providerSlug: string;
    environment: 'paper' | 'demo';
    accountRef?: string | null;
    brokerServerRef?: string | null;
    riskDecisionId?: string | null;
    setupId?: string | null;
  }): ExecutionAuthorization {
    // M1 — validate BEFORE anything is stored. A NaN quantity, a
    // non-positive size, a non-finite price, or an empty identity string is a
    // caller bug and must fail closed here, never as a stored authorization.
    const nonEmpty = (
      value: unknown,
      field: string,
    ): void => {
      if (typeof value !== 'string' || value.length === 0) {
        throw new ExecutionProviderError('validation', `execution authorization requires a non-empty ${field}`);
      }
    };
    nonEmpty(input.userId, 'userId');
    nonEmpty(input.executionProfileId, 'executionProfileId');
    nonEmpty(input.clientOrderId, 'clientOrderId');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    nonEmpty(input.symbol, 'symbol');
    nonEmpty(input.assetClass, 'assetClass');
    nonEmpty(input.orderType, 'orderType');
    nonEmpty(input.providerSlug, 'providerSlug');
    if (input.side !== 'buy' && input.side !== 'sell') {
      throw new ExecutionProviderError('validation', 'execution authorization requires side buy or sell');
    }
    if (input.environment !== 'paper' && input.environment !== 'demo') {
      throw new ExecutionProviderError('validation', 'execution authorization requires environment paper or demo');
    }
    if (typeof input.quantity !== 'number' || !Number.isFinite(input.quantity) || !(input.quantity > 0)) {
      throw new ExecutionProviderError('validation', 'execution authorization requires a finite positive quantity');
    }
    const finiteOrNull = (value: number | null | undefined, field: string): number | null => {
      if (value === null || value === undefined) return null;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ExecutionProviderError('validation', `execution authorization requires a finite ${field}`);
      }
      return value;
    };
    const stopLossPrice = finiteOrNull(input.stopLossPrice, 'stopLossPrice');
    const takeProfitPrice = finiteOrNull(input.takeProfitPrice, 'takeProfitPrice');
    const requestedPrice = finiteOrNull(input.requestedPrice, 'requestedPrice');
    const nullableString = (value: string | null | undefined, field: string): string | null => {
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string' || value.length === 0) {
        throw new ExecutionProviderError('validation', `execution authorization requires a non-empty ${field}`);
      }
      return value;
    };

    this.purgeExpired();

    if (this.authorizations.size >= this.maxEntries) {
      // Evict oldest expired first, then oldest overall if still over.
      const now = this.clock();
      for (const [id, auth] of this.authorizations) {
        if (now - auth.createdMs > this.ttlMs) this.authorizations.delete(id);
        if (this.authorizations.size < this.maxEntries) break;
      }
      if (this.authorizations.size >= this.maxEntries) {
        // Remove oldest entry to bound memory; fail-closed for that old auth.
        const oldest = [...this.authorizations.entries()].sort((a, b) => a[1].createdMs - b[1].createdMs)[0];
        if (oldest) this.authorizations.delete(oldest[0]);
      }
    }

    const stored: ExecutionAuthorization = Object.freeze({
      id: randomUUID(),
      userId: input.userId,
      executionProfileId: input.executionProfileId,
      clientOrderId: input.clientOrderId,
      idempotencyKey: input.idempotencyKey,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      assetClass: input.assetClass,
      orderType: input.orderType,
      stopLossPrice,
      takeProfitPrice,
      requestedPrice,
      providerSlug: input.providerSlug,
      environment: input.environment,
      accountRef: nullableString(input.accountRef, 'accountRef'),
      brokerServerRef: nullableString(input.brokerServerRef, 'brokerServerRef'),
      riskDecisionId: nullableString(input.riskDecisionId, 'riskDecisionId'),
      setupId: nullableString(input.setupId, 'setupId'),
      createdMs: this.clock(),
      consumed: false,
    });
    this.authorizations.set(stored.id, stored);
    // M1 — the caller receives a frozen copy, never the stored record.
    return Object.freeze({ ...stored });
  }

  /**
   * Consume an authorization for a specific request in a specific execution
   * context.
   *
   * Verifies single-use, TTL, exact request binding, AND (H1) exact
   * execution-context binding: the presented `expectedContext` must match
   * the stored authorization field-for-field, including null-vs-non-null.
   * On success marks consumed by deleting the record (one-shot) and returns
   * a frozen copy. On failure throws `ExecutionProviderError` validation and
   * does NOT consume.
   *
   * The `expectedContext` must come from the authoritative snapshot — never
   * from caller input — so a cross-context presentation is always refused.
   */
  consumeAuthorization(
    authorizationId: string,
    request: ExecutionSubmitOrderRequest,
    expectedContext: AuthorizationExecutionContext,
  ): ExecutionAuthorization {
    const auth = this.authorizations.get(authorizationId);
    if (!auth || auth.consumed) {
      throw new ExecutionProviderError(
        'validation',
        'no server-issued execution authorization for this order',
      );
    }
    const now = this.clock();
    if (now - auth.createdMs > this.ttlMs) {
      this.authorizations.delete(authorizationId);
      throw new ExecutionProviderError('validation', 'execution authorization has expired');
    }

    // Exact binding verification — every field that defines the mutation must match.
    if (
      auth.clientOrderId !== request.clientOrderId ||
      auth.idempotencyKey !== request.idempotencyKey ||
      auth.symbol !== request.symbol ||
      auth.side !== request.side ||
      auth.assetClass !== request.assetClass ||
      auth.orderType !== request.orderType
    ) {
      throw new ExecutionProviderError(
        'validation',
        'execution order request does not match its server-issued authorization',
      );
    }
    if (typeof request.quantity !== 'number' || Math.abs(auth.quantity - request.quantity) > QUANTITY_TOLERANCE) {
      throw new ExecutionProviderError(
        'validation',
        'execution order request does not match its server-issued authorization',
      );
    }
    // Prices: null must match null, numbers must be within tolerance.
    const priceMatches = (a: number | null, b: number | null): boolean => {
      if (a === null && b === null) return true;
      if (a === null || b === null) return false;
      return Math.abs(a - b) <= PRICE_TOLERANCE;
    };
    if (
      !priceMatches(auth.stopLossPrice, request.stopLossPrice ?? null) ||
      !priceMatches(auth.takeProfitPrice, request.takeProfitPrice ?? null) ||
      !priceMatches(auth.requestedPrice, request.requestedPrice ?? null)
    ) {
      throw new ExecutionProviderError(
        'validation',
        'execution order request does not match its server-issued authorization',
      );
    }

    // H1 — the complete immutable execution context must match exactly.
    // Without this, an authorization minted for one user/profile/account/
    // server/setup/risk could authorize a mutation for another.
    assertAuthorizationContext(auth, expectedContext);

    // Mark consumed — one-shot, never reusable. The record is deleted rather
    // than mutated (M1: stored records are frozen and never handed out).
    this.authorizations.delete(authorizationId);
    return Object.freeze({ ...auth, consumed: true });
  }

  /**
   * Read-only peek (for pre-submit verification). Does not consume.
   * Returns null if not found, consumed, or expired. M1: returns a frozen
   * defensive copy, never the stored record.
   */
  peekAuthorization(authorizationId: string): ExecutionAuthorization | null {
    const auth = this.authorizations.get(authorizationId);
    if (!auth || auth.consumed) return null;
    if (this.clock() - auth.createdMs > this.ttlMs) {
      this.authorizations.delete(authorizationId);
      return null;
    }
    return Object.freeze({ ...auth });
  }

  /**
   * Explicitly invalidate an authorization (final-fence cleanup, revocation).
   * Idempotent: returns true when a live record was removed.
   */
  revokeAuthorization(authorizationId: string): boolean {
    return this.authorizations.delete(authorizationId);
  }

  clearExpired(): number {
    const now = this.clock();
    let removed = 0;
    for (const [id, auth] of this.authorizations) {
      if (now - auth.createdMs > this.ttlMs) {
        this.authorizations.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private purgeExpired(): void {
    const now = this.clock();
    for (const [id, auth] of this.authorizations) {
      if (now - auth.createdMs > this.ttlMs) this.authorizations.delete(id);
    }
  }

  /** For tests: current size. */
  size(): number {
    return this.authorizations.size;
  }

  /** For tests: clear all. */
  clear(): void {
    this.authorizations.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* H1 — one-shot execution-context handoff for the shared provider instance     */
/* -------------------------------------------------------------------------- */

export interface AuthorizationContextHandoffOptions {
  ttlMs?: number;
  maxEntries?: number;
  clock?: () => number;
}

/**
 * H1 — the composition-side, one-shot execution-context handoff between the
 * composition service and the shared broker provider instance.
 *
 * The broker provider instance is shared across submissions, so the
 * composition cannot hand it the expected execution context through a
 * per-call argument (`ExecutionProvider.submitOrder` takes only the
 * request — that contracts boundary is unchanged). Instead, mirroring the
 * approved B2 F1 barrier-handoff pattern:
 *
 *   - `arm(authorizationId, context)` is called by the composition
 *     immediately after the final safety fence passes and immediately
 *     before the Gate 9 submit, with the context built from its
 *     authoritative snapshot.
 *   - `authorization.consumeAuthorization(authorizationId, request)` is the
 *     adapter wired into the MT5 provider's `authorization` option. It looks
 *     the armed context up by authorization id and REMOVES it on use
 *     (one-shot), then delegates to the authorization service, which
 *     enforces the exact context match. No armed context — no consumption.
 *   - `revoke(authorizationId)` disarms a pending entry (cleanup when the
 *     submit never reaches the provider, or an explicit revocation).
 *
 * This is NOT an authorization system: it stores no permissions and
 * authorizes nothing by itself. It is a single-process vault that makes an
 * expected context presentable to the provider boundary AT MOST ONCE, keyed
 * by the single-use authorization id. The durable single-use guarantee for
 * the mutation remains the Gate 9 ledger's CAS; the one-shot consumption
 * guarantee for the authorization remains this service's delete-on-consume.
 */
export interface AuthorizationContextHandoff {
  /** Arm the expected context for one authorization id (composition side). */
  readonly arm: (authorizationId: string, context: AuthorizationExecutionContext) => void;
  /** Disarm a pending entry; idempotent (cleanup / revocation). */
  readonly revoke: (authorizationId: string) => boolean;
  /** The adapter wired into the provider's `authorization` option. */
  readonly authorization: {
    consumeAuthorization(authorizationId: string, request: ExecutionSubmitOrderRequest): unknown;
  };
  /** For tests: current pending entries. */
  readonly size: () => number;
}

export function createAuthorizationContextHandoff(
  service: ExecutionAuthorizationService,
  options?: AuthorizationContextHandoffOptions,
): AuthorizationContextHandoff {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const clock = options?.clock ?? (() => Date.now());
  const armed = new Map<string, { context: AuthorizationExecutionContext; armedMs: number }>();

  const purge = (): void => {
    const now = clock();
    for (const [id, entry] of armed) {
      if (now - entry.armedMs > ttlMs) armed.delete(id);
    }
    while (armed.size > maxEntries) {
      const oldest = [...armed.entries()].sort((a, b) => a[1].armedMs - b[1].armedMs)[0];
      if (!oldest) break;
      armed.delete(oldest[0]);
    }
  };

  return {
    arm(authorizationId: string, context: AuthorizationExecutionContext): void {
      if (typeof authorizationId !== 'string' || authorizationId.length === 0) {
        throw new ExecutionProviderError('validation', 'cannot arm an execution context without an authorization id');
      }
      purge();
      // Store a frozen copy: later caller mutation of the passed object must
      // not alter the armed expectation.
      armed.set(authorizationId, {
        context: Object.freeze({ ...context }),
        armedMs: clock(),
      });
    },

    revoke(authorizationId: string): boolean {
      return armed.delete(authorizationId);
    },

    authorization: {
      consumeAuthorization(authorizationId: string, request: ExecutionSubmitOrderRequest): unknown {
        const entry = armed.get(authorizationId) ?? null;
        if (entry) armed.delete(authorizationId); // one-shot: never usable again
        if (!entry) {
          throw new ExecutionProviderError(
            'validation',
            'no armed execution context for this authorization; the provider call is refused',
          );
        }
        if (clock() - entry.armedMs > ttlMs) {
          throw new ExecutionProviderError(
            'validation',
            'armed execution context has expired; the provider call is refused',
          );
        }
        return service.consumeAuthorization(authorizationId, request, entry.context);
      },
    },

    size(): number {
      return armed.size;
    },
  };
}
