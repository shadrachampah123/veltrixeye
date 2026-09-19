import { z } from 'zod';

/** M10 is deliberately non-live. No credential or broker-login fields belong here. */
export type ExecutionTransportMode = 'disabled' | 'dry-run';
export type TransportConnectionState = 'disconnected' | 'connecting' | 'connected' | 'unavailable';
export type TransportOrderState = 'submitting' | 'acknowledged' | 'rejected' | 'failed' | 'cancelled';
export type ExecutionTransportState = TransportConnectionState | TransportOrderState;
export type TransportErrorCode =
  | 'invalid_request' | 'unauthorized' | 'unavailable' | 'timeout' | 'transport_failure'
  | 'malformed_response' | 'idempotency_conflict' | 'capacity_exceeded' | 'not_found' | 'rejected';
export interface SanitizedTransportError {
  code: TransportErrorCode;
  message: string;
  /** Never automatically retry an uncertain submission/cancellation. */
  outcomeUnknown: boolean;
}

export const transportContextSchema = z.object({
  requestId: z.string().uuid().transform((value) => value.toLowerCase()),
  executionId: z.string().uuid().transform((value) => value.toLowerCase()),
  correlationId: z.string().uuid().transform((value) => value.toLowerCase()),
  timestamp: z.string().datetime(),
}).strict();
export type TransportContext = z.infer<typeof transportContextSchema>;
export const transportOrderSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9._-]{1,32}$/),
  side: z.enum(['buy', 'sell']),
  orderType: z.enum(['market', 'limit', 'stop']),
  quantity: z.number().finite().positive(),
  price: z.number().finite().positive().nullable(),
  stopLoss: z.number().finite().positive(),
  takeProfit: z.number().finite().positive(),
}).strict();
export const transportSubmitSchema = transportContextSchema.extend({ order: transportOrderSchema }).strict();
export const transportCancelSchema = transportContextSchema.extend({
  orderId: z.string().regex(/^sim-[a-f0-9]{32}$/),
}).strict();
export type TransportSubmitRequest = z.infer<typeof transportSubmitSchema>;
export type TransportCancelRequest = z.infer<typeof transportCancelSchema>;

/** Opaque in-memory capability, issued only by the server-side dispatcher. */
declare const transportAuthorizationBrand: unique symbol;
export type TransportAuthorization = { readonly [transportAuthorizationBrand]: true };
export interface TransportResult extends TransportContext {
  mode: ExecutionTransportMode;
  live: false;
  operation: 'submit' | 'cancel' | 'status';
  state: TransportOrderState;
  orderId: string | null;
  error: SanitizedTransportError | null;
}
export interface TransportHealth extends TransportContext {
  mode: ExecutionTransportMode;
  live: false;
  state: TransportConnectionState;
  healthy: boolean;
  error: SanitizedTransportError | null;
}
export interface TransportSession extends TransportContext {
  mode: ExecutionTransportMode;
  live: false;
  state: 'inactive' | 'simulated';
  account: 'none' | 'simulated';
  authenticated: false;
}
export interface ExecutionTransportEvent extends TransportContext {
  mode: ExecutionTransportMode;
  live: false;
  operation: 'connect' | 'disconnect' | 'submit' | 'cancel' | 'status';
  from: ExecutionTransportState;
  to: ExecutionTransportState;
  error: SanitizedTransportError | null;
}
export interface ExecutionTransport {
  readonly mode: ExecutionTransportMode;
  readonly live: false;
  connect(context: TransportContext): Promise<TransportHealth>;
  disconnect(context: TransportContext): Promise<TransportHealth>;
  health(context: TransportContext): Promise<TransportHealth>;
  session(context: TransportContext): Promise<TransportSession>;
  submit(request: TransportSubmitRequest, authorization: TransportAuthorization): Promise<TransportResult>;
  cancel(request: TransportCancelRequest, authorization: TransportAuthorization): Promise<TransportResult>;
  orderStatus(context: TransportContext): Promise<TransportResult>;
}
