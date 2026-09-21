/**
 * B1 — authorization/composition layer.
 *
 * Server-issued, one-shot, TTL-bound execution authorization.
 *
 * This module provides the generic authorization service that both the paper
 * simulator and the broker (MT5) path use. It is the B1 authorization layer:
 * after the 18 execution gates pass with fresh DB reads, the composition
 * service mints an authorization here, binds it to the exact mutation
 * identity (clientOrderId, idempotencyKey, symbol, side, quantity,
 * assetClass, orderType, stopLoss, takeProfit, providerSlug, environment,
 * accountRef, brokerServerRef, userId, executionProfileId, setupId,
 * riskDecisionId), and hands the opaque `authorizationId` to the provider
 * boundary. The provider then consumes it exactly once — a replay, a
 * different mutation, or an expired authorization is refused before any
 * transport call.
 *
 * Properties:
 *  - in-memory only, never persisted (like paper's original map). Durable
 *    safety is Gate 9's `ProviderMutationLedger`; this layer is the
 *    composition-time authorization that precedes it.
 *  - single-use: consume removes it, second consume fails closed.
 *  - TTL-bound: expired authorizations are refused and cleaned.
 *  - exact binding: the request presented to the provider must match the
 *    stored authorization field-for-field (quantity with tolerance 1e-9,
 *    prices with same tolerance, strings exact). No partial match, no
 *    widening.
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
  consumed: boolean;
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
   * Mint a new authorization bound to the exact mutation identity.
   * The caller must have already evaluated all 18 gates with fresh reads.
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

    const auth: ExecutionAuthorization = {
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
      stopLossPrice: input.stopLossPrice ?? null,
      takeProfitPrice: input.takeProfitPrice ?? null,
      requestedPrice: input.requestedPrice ?? null,
      providerSlug: input.providerSlug,
      environment: input.environment,
      accountRef: input.accountRef ?? null,
      brokerServerRef: input.brokerServerRef ?? null,
      riskDecisionId: input.riskDecisionId ?? null,
      setupId: input.setupId ?? null,
      createdMs: this.clock(),
      consumed: false,
    };
    this.authorizations.set(auth.id, auth);
    return auth;
  }

  /**
   * Consume an authorization for a specific request.
   * Verifies exact binding, TTL, single-use. On success marks consumed and
   * removes it (one-shot). On failure throws ExecutionProviderError validation
   * and does NOT consume.
   */
  consumeAuthorization(
    authorizationId: string,
    request: ExecutionSubmitOrderRequest,
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
    if (Math.abs(auth.quantity - request.quantity) > QUANTITY_TOLERANCE) {
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

    // Mark consumed — one-shot, never reusable.
    auth.consumed = true;
    this.authorizations.delete(authorizationId);
    return auth;
  }

  /**
   * Read-only peek (for tests/composition verification). Does not consume.
   * Returns null if not found, consumed, or expired.
   */
  peekAuthorization(authorizationId: string): ExecutionAuthorization | null {
    const auth = this.authorizations.get(authorizationId);
    if (!auth || auth.consumed) return null;
    if (this.clock() - auth.createdMs > this.ttlMs) {
      this.authorizations.delete(authorizationId);
      return null;
    }
    return auth;
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
