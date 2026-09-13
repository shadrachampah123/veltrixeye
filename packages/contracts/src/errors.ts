/**
 * Domain error codes shared by core and the API layer.
 * The core layer throws DomainError with these codes; the API maps codes
 * to HTTP status codes. Messages are user-safe (no internals leaked).
 */
export const ERROR_CODES = {
  INVALID_INPUT: 'invalid_input',
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  IMMUTABLE: 'immutable',
  RATE_LIMITED: 'rate_limited',
  INTERNAL: 'internal',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface DomainErrorInfo {
  code: ErrorCode;
  message: string;
}
