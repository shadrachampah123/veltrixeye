/**
 * Domain error codes shared by core and the API layer.
 * The core layer throws DomainError with these codes; the API maps codes
 * to HTTP status codes. Messages are user-safe (no internals leaked).
 */
export const ERROR_CODES = {
  INVALID_INPUT: 'invalid_input',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  IMMUTABLE: 'immutable',
  RATE_LIMITED: 'rate_limited',
  /** An upstream market-data provider failed (maps to HTTP 502). */
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  INTERNAL: 'internal',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface DomainErrorInfo {
  code: ErrorCode;
  message: string;
}
