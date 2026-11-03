import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import { ERROR_CODES, type ErrorCode } from '@veltrixeye/contracts';
import { isDomainError } from '@veltrixeye/core';
import { logErrorSafely } from './safe-error-log.js';

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    fields?: Record<string, string[]>;
  };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  [ERROR_CODES.INVALID_INPUT]: 400,
  [ERROR_CODES.UNAUTHORIZED]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.CONFLICT]: 409,
  [ERROR_CODES.IMMUTABLE]: 409,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.PROVIDER_UNAVAILABLE]: 502,
  [ERROR_CODES.INTERNAL]: 500,
};

export function domainErrorToStatus(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function sendDomainError(reply: FastifyReply, err: { code: ErrorCode; message: string }): void {
  void reply.code(domainErrorToStatus(err.code)).send({
    error: { code: err.code, message: err.message },
  } satisfies ApiErrorBody);
}

export function sendZodError(reply: FastifyReply, err: ZodError, body: string): void {
  const fields: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '(body)';
    (fields[key] ??= []).push(issue.message);
  }
  void reply.code(400).send({
    error: {
      code: ERROR_CODES.INVALID_INPUT,
      message: body === 'body' ? 'Invalid request body' : `Invalid ${body}`,
      fields,
    },
  } satisfies ApiErrorBody);
}

/**
 * Central error handler: maps domain/zod errors to safe HTTP responses.
 *
 * `secrets` are the deployment credentials the safe logger substitutes before
 * an unhandled error is written. It defaults to an empty list so the handler
 * stays usable in isolation (and in tests) without configuration, but the
 * server always passes `configuredSecrets(config)` — see `buildApp`.
 */
export function errorHandler(
  err: Error,
  req: FastifyRequest,
  reply: FastifyReply,
  secrets: readonly string[] = [],
): void {
  if (isDomainError(err)) {
    sendDomainError(reply, err);
    return;
  }
  // Rate limiting (the plugin throws the tagged error from its builder).
  if ((err as { statusCode?: number }).statusCode === 429) {
    void reply.code(429).send({
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: err.message || 'Rate limit exceeded',
      },
    } satisfies ApiErrorBody);
    return;
  }
  if (err.name === 'ZodError' && (err as { issues?: unknown }).issues) {
    sendZodError(reply, err as unknown as ZodError, 'request');
    return;
  }
  // Fastify payload-limit errors (bodyLimit exceeded): client errors, never
  // 500s — oversized requests must be rejected with a clean 413.
  if ((err as { statusCode?: number }).statusCode === 413) {
    void reply.code(413).send({
      error: { code: ERROR_CODES.INVALID_INPUT, message: 'Request payload is too large' },
    } satisfies ApiErrorBody);
    return;
  }
  // Fastify request-validation errors (schema / malformed JSON bodies).
  const withValidation = err as { validation?: unknown; statusCode?: number };
  if (withValidation.validation || withValidation.statusCode === 400) {
    void reply.code(400).send({
      error: {
        code: ERROR_CODES.INVALID_INPUT,
        message: 'Invalid request payload',
      },
    } satisfies ApiErrorBody);
    return;
  }
  // The error object is NEVER handed to the logger. An unhandled failure can
  // carry a database password, a provider key or a connection URL inside
  // `err.message`, and Pino's redaction list (see `LOGGER_REDACT_PATHS` in
  // app.ts) censors `err.stack` but not `err.message` — a raw pass would write
  // those credentials to the production sink. `logErrorSafely` projects the
  // error to { type, message, code } after substituting every configured
  // secret and truncating, so the diagnostic survives without the payload.
  //
  // Only the ROUTE PATTERN is logged, never `req.url`: the concrete URL can
  // carry a token or an identifier in its query string.
  logErrorSafely(
    req.log,
    err,
    'unhandled error',
    {
      route: typeof req.routeOptions?.url === 'string' ? req.routeOptions.url : undefined,
      method: req.method,
      requestId: req.id,
    },
    secrets,
  );
  void reply.code(500).send({
    error: {
      code: ERROR_CODES.INTERNAL,
      message: 'An unexpected error occurred',
    },
  } satisfies ApiErrorBody);
}
