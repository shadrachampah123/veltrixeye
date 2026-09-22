/**
 * Paystack adapter failures.
 *
 * Every failure is TYPED and every message is bounded and redacted: a provider
 * message is provider-authored text, so it is truncated, stripped of any
 * credential shape and never accompanied by a raw payload. Nothing here is a
 * warning — an error means nothing was charged, or that the outcome is unknown
 * and must be resolved by a human.
 */

export type PaystackFailureReason =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'unauthorized_amount'
  | 'plan_not_registered'
  | 'plan_mismatch'
  | 'customer_not_provisioned'
  | 'not_implemented'
  | 'not_found'
  | 'ambiguous_not_found'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'unexpected_response'
  | 'reference_conflict'
  | 'response_conflict';

/** Message bound, mirroring the durable failure-reason bound (0031). */
export const PAYSTACK_ERROR_MESSAGE_MAX = 600;

/**
 * Credential-shaped material is stripped from any message this adapter
 * produces, mirroring the database posture (a failure reason must not carry a
 * credential). The secret key itself is redacted verbatim as well.
 */
const CREDENTIAL_SHAPED_ASSIGNMENT_RE =
  /\b(password|passwd|token|secret|api[_-]?key|authorization|private[_-]?key|credential|bearer)\b\s*[:=]\s*\S+/gi;

/**
 * Redact provider-authored text before it can appear in an error message: the
 * configured key is removed verbatim, key-shaped strings and bearer values are
 * replaced, and `field: value` credential assignments lose their value.
 *
 * Prose is preserved: a provider message that merely contains the WORD
 * "authorization" (for example "Invalid authorization") keeps its meaning, so
 * an operator can still diagnose the failure. The message is bounded to
 * `PAYSTACK_ERROR_MESSAGE_MAX` characters.
 */
export function redactPaystackMessage(message: string, secretKey?: string): string {
  let redacted = message;
  if (secretKey && secretKey !== '') {
    redacted = redacted.split(secretKey).join('[redacted]');
  }
  redacted = redacted.replace(/\b(sk|pk)_(test|live)_[A-Za-z0-9]+/g, '[redacted-key]');
  redacted = redacted.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
  redacted = redacted.replace(CREDENTIAL_SHAPED_ASSIGNMENT_RE, '$1: [redacted]');
  return redacted.length > PAYSTACK_ERROR_MESSAGE_MAX
    ? `${redacted.slice(0, PAYSTACK_ERROR_MESSAGE_MAX)}…`
    : redacted;
}

export class PaystackAdapterError extends Error {
  readonly code = 'paystack_adapter_error' as const;

  constructor(
    readonly reason: PaystackFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PaystackAdapterError';
  }
}

export function isPaystackAdapterError(error: unknown): error is PaystackAdapterError {
  return error instanceof PaystackAdapterError;
}

/** A configuration that could allow live traffic or a non-sandbox key. */
export function paystackConfigurationError(message: string): PaystackAdapterError {
  return new PaystackAdapterError('invalid_configuration', message);
}

/** The request violates the canonical seam contract (never charged). */
export function paystackInvalidRequest(message: string): PaystackAdapterError {
  return new PaystackAdapterError('invalid_request', message);
}

/** No authorized pricing snapshot: the adapter never prices, so nothing happens. */
export function paystackUnauthorizedAmount(message: string): PaystackAdapterError {
  return new PaystackAdapterError('unauthorized_amount', message);
}
