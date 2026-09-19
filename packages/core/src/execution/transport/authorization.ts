import {
  transportCancelSchema, transportSubmitSchema,
  type ExecutionTransport, type TransportAuthorization, type TransportCancelRequest,
  type TransportSubmitRequest,
} from '@veltrixeye/contracts';
import { evaluateExecutionGates, type ExecutionGateInput } from '../gates.js';
import { ExecutionTransportError } from './errors.js';

type Request = TransportSubmitRequest | TransportCancelRequest;
type Operation = 'submit' | 'cancel';
const permits = new WeakMap<TransportAuthorization, { request: string; operation: Operation; target: ExecutionTransport }>();

/** Consumes a one-use capability bound to the complete immutable request and adapter instance. */
export function consumeTransportAuthorization(
  permit: TransportAuthorization, request: Request, operation: Operation, target: ExecutionTransport,
): boolean {
  const record = permits.get(permit);
  permits.delete(permit);
  return record?.operation === operation && record.target === target && record.request === JSON.stringify(request);
}

export interface TransportExecutionAuthority {
  /** Must resolve current server-owned state, never accept an HTTP gate snapshot. */
  resolveGates(request: Readonly<Request>, operation: Operation): Promise<ExecutionGateInput>;
  /** Separate execution authorization, after strategy/risk/safety gates. Default/unknown = deny. */
  authorizeExecution(request: Readonly<Request>, operation: Operation): Promise<{ granted: boolean; authorizationId: string } | null>;
}

/** No production route/worker uses this foundation yet. All existing M8.7 gates stay authoritative. */
export function createTransportDispatcher(transport: ExecutionTransport, authority: TransportExecutionAuthority) {
  async function authorize(request: Request, operation: Operation): Promise<TransportAuthorization> {
    try {
      const gates = await authority.resolveGates(request, operation);
      if (!evaluateExecutionGates(gates).passed) throw new Error();
      const decision = await authority.authorizeExecution(request, operation);
      if (decision?.granted !== true || !decision.authorizationId?.trim()) throw new Error();
    } catch {
      // Never expose a resolver's error/credentials, nor manufacture approval on failure.
      throw new ExecutionTransportError('unauthorized');
    }
    const permit = Object.freeze({}) as TransportAuthorization;
    permits.set(permit, { request: JSON.stringify(request), operation, target: transport });
    return permit;
  }
  return {
    async submit(input: TransportSubmitRequest) {
      const parsed = transportSubmitSchema.safeParse(input);
      if (!parsed.success) throw new ExecutionTransportError('invalid_request');
      Object.freeze(parsed.data.order);
      const request = Object.freeze(parsed.data);
      return transport.submit(request, await authorize(request, 'submit'));
    },
    async cancel(input: TransportCancelRequest) {
      const parsed = transportCancelSchema.safeParse(input);
      if (!parsed.success) throw new ExecutionTransportError('invalid_request');
      const request = Object.freeze(parsed.data);
      return transport.cancel(request, await authorize(request, 'cancel'));
    },
  };
}
