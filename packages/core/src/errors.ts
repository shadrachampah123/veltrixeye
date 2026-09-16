import { ERROR_CODES, type ErrorCode } from '@veltrixeye/contracts';

/**
 * Domain error thrown by core services. The API layer maps `code` to an
 * HTTP status. `message` is user-safe; internal detail goes to `cause`.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DomainError';
    this.code = code;
  }
}

export const Errors = {
  invalidInput: (message: string) => new DomainError(ERROR_CODES.INVALID_INPUT, message),
  unauthorized: (message = 'Authentication required') => new DomainError(ERROR_CODES.UNAUTHORIZED, message),
  forbidden: (message = 'Permission denied') => new DomainError(ERROR_CODES.FORBIDDEN, message),
  notFound: (message = 'Resource not found') => new DomainError(ERROR_CODES.NOT_FOUND, message),
  conflict: (message: string) => new DomainError(ERROR_CODES.CONFLICT, message),
  immutable: (message: string) => new DomainError(ERROR_CODES.IMMUTABLE, message),
  rateLimited: (message: string) => new DomainError(ERROR_CODES.RATE_LIMITED, message),
  providerUnavailable: (message: string, cause?: unknown) =>
    new DomainError(ERROR_CODES.PROVIDER_UNAVAILABLE, message, { cause }),
  internal: (message: string, cause?: unknown) => new DomainError(ERROR_CODES.INTERNAL, message, { cause }),
};

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
