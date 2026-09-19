import type { SanitizedTransportError, TransportErrorCode } from '@veltrixeye/contracts';

const messages: Record<TransportErrorCode, string> = {
  invalid_request: 'Invalid transport request',
  unauthorized: 'Execution authorization denied',
  unavailable: 'Non-live transport is unavailable',
  timeout: 'Transport operation timed out; do not automatically retry',
  transport_failure: 'Transport operation failed',
  malformed_response: 'Transport response failed validation',
  idempotency_conflict: 'Execution or request identity was reused with different parameters',
  capacity_exceeded: 'Transport idempotency capacity reached; submissions are stopped',
  not_found: 'Simulated order not found',
  rejected: 'Simulated order rejected',
};

/** Allowlist only: never copy upstream messages, stacks, causes, payloads or credentials. */
export function transportError(code: TransportErrorCode, outcomeUnknown = false): SanitizedTransportError {
  return Object.freeze({ code, message: messages[code], outcomeUnknown });
}
export class ExecutionTransportError extends Error {
  readonly detail: SanitizedTransportError;
  constructor(code: TransportErrorCode) {
    const detail = transportError(code);
    super(detail.message);
    this.name = 'ExecutionTransportError';
    this.detail = detail;
  }
}
