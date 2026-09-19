import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  transportContextSchema, transportSubmitSchema, transportCancelSchema,
  type ExecutionTransport, type ExecutionTransportEvent, type ExecutionTransportMode,
  type TransportAuthorization, type TransportCancelRequest, type TransportConnectionState,
  type TransportContext, type TransportErrorCode, type TransportHealth,
  type TransportOrderState, type TransportResult, type TransportSession, type TransportSubmitRequest,
} from '@veltrixeye/contracts';
import { consumeTransportAuthorization } from './authorization.js';
import { ExecutionTransportError, transportError } from './errors.js';
import type { ExecutionTransportConfig } from './config.js';

export interface SafeTransportOptions {
  timeoutMs?: number;
  /** No eviction: capacity exhaustion stops new identities rather than risking a replay. */
  maxExecutions?: number;
  now?: () => number;
  /** Receives only allowlisted, immutable events. Awaited before exchange; sync/async sink failures are sanitized. */
  audit?: (event: Readonly<ExecutionTransportEvent>) => void | Promise<void>;
}
type WireOperation = 'connect' | 'submit' | 'cancel';
type Request = TransportContext | TransportSubmitRequest | TransportCancelRequest;
const wireResultSchema = transportContextSchema.extend({
  state: z.enum(['acknowledged', 'rejected', 'cancelled']),
  orderId: z.string().regex(/^sim-[a-f0-9]{32}$/).nullable(),
}).strict();
class WireFailure {
  constructor(readonly code: TransportErrorCode) {}
}
interface Entry { fingerprint: string; result: Promise<TransportResult>; attempted: boolean }

/** Operational mechanics only. This class never decides whether execution is authorized. */
abstract class SafeExecutionTransport implements ExecutionTransport {
  readonly live = false as const;
  abstract readonly mode: ExecutionTransportMode;
  private state: TransportConnectionState = 'disconnected';
  private connecting: Promise<TransportHealth> | null = null;
  private connectionEpoch = 0;
  private readonly pending = new Set<AbortController>();
  private readonly submissions = new Map<string, Entry>();
  private readonly cancellations = new Map<string, Entry>();
  private readonly requests = new Map<string, string>();
  private readonly orders = new Map<string, TransportResult>();
  private readonly timeoutMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  constructor(private readonly options: SafeTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.capacity = options.maxExecutions ?? 10_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000
      || !Number.isInteger(this.capacity) || this.capacity < 1) throw new ExecutionTransportError('invalid_request');
  }
  /** The future MT5 boundary; M10 concrete adapters contain no network/terminal implementation. */
  protected abstract exchange(operation: WireOperation, request: Request, signal: AbortSignal): Promise<unknown>;

  private context(input: TransportContext): TransportContext {
    const parsed = transportContextSchema.safeParse(input);
    if (!parsed.success) throw new ExecutionTransportError('invalid_request');
    return parsed.data;
  }
  private stamp(context: TransportContext): TransportContext {
    return { requestId: context.requestId, executionId: context.executionId,
      correlationId: context.correlationId, timestamp: new Date(this.now()).toISOString() };
  }
  private async emit(context: TransportContext, operation: ExecutionTransportEvent['operation'],
    from: ExecutionTransportEvent['from'], to: ExecutionTransportEvent['to'],
    error: ExecutionTransportEvent['error'] = null): Promise<void> {
    const event = Object.freeze({ ...this.stamp(context), mode: this.mode, live: this.live, operation, from, to, error });
    try { await this.options.audit?.(event); } catch { throw new ExecutionTransportError('transport_failure'); }
  }
  private healthResult(context: TransportContext, error: TransportHealth['error'] = null): TransportHealth {
    return Object.freeze({ ...this.stamp(context), mode: this.mode, live: this.live, state: this.state,
      healthy: this.state === 'connected', error });
  }
  async health(input: TransportContext): Promise<TransportHealth> { return this.healthResult(this.context(input)); }
  async session(input: TransportContext): Promise<TransportSession> {
    const active = this.state === 'connected' && this.mode === 'dry-run';
    return Object.freeze({ ...this.stamp(this.context(input)), mode: this.mode, live: this.live,
      state: active ? 'simulated' : 'inactive', account: active ? 'simulated' : 'none', authenticated: false });
  }
  async connect(input: TransportContext): Promise<TransportHealth> {
    const context = this.context(input);
    if (this.state === 'connected') return this.healthResult(context);
    if (this.connecting) { await this.connecting; return this.healthResult(context); }
    const from = this.state;
    const epoch = this.connectionEpoch;
    // Reserve synchronously: awaiting an audit callback must not admit a second connect.
    this.state = 'connecting';
    this.connecting = Promise.resolve().then(async () => {
      try {
        await this.emit(context, 'connect', from, 'connecting');
        if (epoch !== this.connectionEpoch || this.state !== 'connecting') throw new WireFailure('unavailable');
        const raw = await this.deadline('connect', context);
        if (epoch !== this.connectionEpoch || this.state !== 'connecting') throw new WireFailure('unavailable');
        if (!z.object({ connected: z.literal(true) }).strict().safeParse(raw).success) throw new WireFailure('malformed_response');
        await this.emit(context, 'connect', this.state, 'connected');
        if (epoch !== this.connectionEpoch || this.state !== 'connecting') throw new WireFailure('unavailable');
        this.state = 'connected';
        return this.healthResult(context);
      } catch (error) {
        const detail = transportError(error instanceof WireFailure ? error.code : 'transport_failure');
        // Stop before awaiting the failure audit; a disconnect during audit stays stopped.
        if (epoch === this.connectionEpoch && this.state !== 'disconnected') {
          const failedFrom = this.state;
          this.state = 'unavailable';
          await this.emit(context, 'connect', failedFrom, 'unavailable', detail);
        }
        return this.healthResult(context, detail);
      }
    });
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async disconnect(input: TransportContext): Promise<TransportHealth> {
    const context = this.context(input);
    this.connectionEpoch++;
    for (const controller of this.pending) controller.abort();
    const from = this.state;
    this.state = 'disconnected';
    await this.emit(context, 'disconnect', from, 'disconnected');
    return this.healthResult(context);
  }
  private async deadline(operation: WireOperation, request: Request, onExchange?: () => void): Promise<unknown> {
    const controller = new AbortController();
    this.pending.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new WireFailure('unavailable'));
          controller.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => { reject(new WireFailure('timeout')); controller.abort(); }, this.timeoutMs);
        }),
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new WireFailure('unavailable');
          onExchange?.();
          return this.exchange(operation, request, controller.signal);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      this.pending.delete(controller);
    }
  }
  private result(context: TransportContext, operation: TransportResult['operation'], state: TransportOrderState,
    orderId: string | null, code?: TransportErrorCode, uncertain = false): TransportResult {
    return Object.freeze({ ...this.stamp(context), mode: this.mode, live: this.live, operation, state, orderId,
      error: code ? transportError(code, uncertain) : null });
  }
  private async refuse(context: TransportContext, operation: 'submit' | 'cancel', code: TransportErrorCode): Promise<TransportResult> {
    const result = this.result(context, operation, 'failed', null, code);
    await this.emit(context, operation, this.state, 'failed', result.error);
    return result;
  }
  async submit(input: TransportSubmitRequest, permit: TransportAuthorization): Promise<TransportResult> {
    const parsed = transportSubmitSchema.safeParse(input);
    if (!parsed.success) throw new ExecutionTransportError('invalid_request');
    const request = parsed.data;
    if (!consumeTransportAuthorization(permit, request, 'submit', this)) return this.refuse(request, 'submit', 'unauthorized');
    return this.once(request, 'submit', JSON.stringify(request.order));
  }
  async cancel(input: TransportCancelRequest, permit: TransportAuthorization): Promise<TransportResult> {
    const parsed = transportCancelSchema.safeParse(input);
    if (!parsed.success) throw new ExecutionTransportError('invalid_request');
    const request = parsed.data;
    if (!consumeTransportAuthorization(permit, request, 'cancel', this)) return this.refuse(request, 'cancel', 'unauthorized');
    return this.once(request, 'cancel', request.orderId);
  }
  private once(request: TransportSubmitRequest | TransportCancelRequest, operation: 'submit' | 'cancel', fingerprint: string): Promise<TransportResult> {
    const entries = operation === 'submit' ? this.submissions : this.cancellations;
    const identity = `${operation}:${request.executionId}:${fingerprint}`;
    const priorIdentity = this.requests.get(request.requestId);
    if (priorIdentity && priorIdentity !== identity) return this.refuse(request, operation, 'idempotency_conflict');
    const prior = entries.get(request.executionId);
    if (prior && prior.fingerprint !== fingerprint) return this.refuse(request, operation, 'idempotency_conflict');
    if (priorIdentity && prior) return prior.result;
    // Replay an attempted/reserved cancellation before inspecting current order state.
    // Known preflight failures do not claim the execution ID or consume ledger capacity.
    if (!prior && operation === 'cancel') {
      const failure = this.cancelPreflight(request as TransportCancelRequest);
      if (failure) return this.refuse(request, operation, failure);
    }
    if ((!prior && entries.size >= this.capacity) || this.requests.size >= this.capacity * 2) {
      return this.refuse(request, operation, 'capacity_exceeded');
    }
    // Reserve synchronously before audit/exchange. Submission failures and attempted cancellations stay cached.
    this.requests.set(request.requestId, identity);
    if (prior) return prior.result;
    const entry: Entry = {
      fingerprint, attempted: false,
      result: Promise.resolve().then(() => this.perform(request, operation, entry)).finally(() => {
        // Only cancellation reservations proven never to have reached exchange may be released.
        // Keep request-ID bindings (including aliases); never release a submission reservation.
        if (operation === 'cancel' && !entry.attempted && entries.get(request.executionId) === entry) {
          entries.delete(request.executionId);
        }
      }),
    };
    entries.set(request.executionId, entry);
    return entry.result;
  }
  private cancelPreflight(request: TransportCancelRequest): TransportErrorCode | null {
    if (this.state !== 'connected') return 'unavailable';
    const order = this.orders.get(request.executionId);
    return order?.state === 'acknowledged' && order.orderId === request.orderId ? null : 'not_found';
  }
  private async perform(request: TransportSubmitRequest | TransportCancelRequest, operation: 'submit' | 'cancel', entry: Entry): Promise<TransportResult> {
    if (this.state !== 'connected') return this.refuse(request, operation, 'unavailable');
    const prior = this.orders.get(request.executionId);
    if (operation === 'cancel' && (prior?.state !== 'acknowledged' || prior.orderId !== (request as TransportCancelRequest).orderId)) {
      return this.refuse(request, operation, 'not_found');
    }
    // The reservation survives asynchronous audit. A disconnect/reconnect during audit
    // invalidates this attempt rather than permitting exchange on a new connection.
    const epoch = this.connectionEpoch;
    await this.emit(request, operation, prior?.state ?? this.state, 'submitting');
    if (epoch !== this.connectionEpoch || this.state !== 'connected') return this.refuse(request, operation, 'unavailable');
    this.orders.set(request.executionId, this.result(request, operation, 'submitting', prior?.orderId ?? null));
    let result: TransportResult;
    try {
      const raw = await this.deadline(operation, request, () => { entry.attempted = true; });
      const parsed = wireResultSchema.safeParse(raw);
      if (!parsed.success) throw new WireFailure('malformed_response');
      const row = parsed.data;
      if (row.requestId !== request.requestId || row.executionId !== request.executionId || row.correlationId !== request.correlationId
        || (operation === 'submit' && row.state === 'cancelled') || (operation === 'cancel' && row.state === 'acknowledged')
        || (row.state !== 'rejected' && !row.orderId)
        || (row.state === 'rejected' && row.orderId !== null)
        || (operation === 'cancel' && row.state === 'cancelled' && row.orderId !== prior?.orderId)) {
        throw new WireFailure('malformed_response');
      }
      result = this.result(request, operation, row.state, row.orderId, row.state === 'rejected' ? 'rejected' : undefined);
    } catch (error) {
      result = this.result(request, operation, 'failed', prior?.orderId ?? null,
        error instanceof WireFailure ? error.code : 'transport_failure', entry.attempted);
    }
    // Rejection or a proven no-exchange cancellation leaves the order intact; uncertainty is visible.
    if (operation === 'cancel' && (!entry.attempted || result.state === 'rejected') && prior) this.orders.set(request.executionId, prior);
    else this.orders.set(request.executionId, result);
    await this.emit(request, operation, 'submitting', result.state, result.error);
    return result;
  }
  async orderStatus(input: TransportContext): Promise<TransportResult> {
    const context = this.context(input);
    const order = this.orders.get(context.executionId);
    if (!order) return this.result(context, 'status', 'failed', null, 'not_found');
    return Object.freeze({ ...order, ...this.stamp(context), operation: 'status' });
  }
}

/** Deliberately unavailable MT5 adapter. No SDK, endpoint, credentials, or broker implementation. */
export class MT5ExecutionTransport extends SafeExecutionTransport {
  readonly mode = 'disabled' as const;
  protected async exchange(): Promise<never> { throw new WireFailure('unavailable'); }
}
export type DryRunScenario = 'acknowledge' | 'reject' | 'timeout' | 'failure' | 'malformed';
export interface DryRunTransportOptions extends SafeTransportOptions {
  scenarios?: Partial<Record<WireOperation, DryRunScenario>>;
}
/** Deterministic local simulation. Fault scenarios are test tools, never broker behavior. */
export class DryRunExecutionTransport extends SafeExecutionTransport {
  readonly mode = 'dry-run' as const;
  private readonly scenarios: Readonly<Partial<Record<WireOperation, DryRunScenario>>>;
  constructor(options: DryRunTransportOptions = {}) {
    super(options);
    this.scenarios = Object.freeze({ ...options.scenarios });
  }
  protected async exchange(operation: WireOperation, request: Request, signal: AbortSignal): Promise<unknown> {
    switch (this.scenarios[operation] ?? 'acknowledge') {
      case 'timeout': return new Promise((_, reject) => {
        if (signal.aborted) reject(new Error());
        else signal.addEventListener('abort', () => reject(new Error()), { once: true });
      });
      case 'failure': throw new Error('Simulated transport failure');
      case 'malformed': return { unexpected: true };
      case 'reject':
        if (operation === 'connect') throw new WireFailure('unavailable');
        return { ...transportContextSchema.parse(pickContext(request)), state: 'rejected', orderId: null };
    }
    if (operation === 'connect') return { connected: true };
    const orderId = operation === 'cancel' ? (request as TransportCancelRequest).orderId
      : `sim-${createHash('sha256').update(request.executionId).digest('hex').slice(0, 32)}`;
    return { ...pickContext(request), state: operation === 'submit' ? 'acknowledged' : 'cancelled', orderId };
  }
}
function pickContext(request: TransportContext): TransportContext {
  return { requestId: request.requestId, executionId: request.executionId,
    correlationId: request.correlationId, timestamp: request.timestamp };
}
export function createSafeExecutionTransport(config: ExecutionTransportConfig, options: SafeTransportOptions = {}): ExecutionTransport {
  // Runtime check as well as type-level prohibition: an unsafe cast/config cannot select a live implementation.
  if (config.live !== false || !['disabled', 'dry-run'].includes(config.mode)) throw new ExecutionTransportError('unavailable');
  const settings = { ...options, timeoutMs: config.timeoutMs };
  return config.mode === 'dry-run' ? new DryRunExecutionTransport(settings) : new MT5ExecutionTransport(settings);
}
