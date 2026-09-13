import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';
import { ERROR_CODES, type ErrorCode } from '@veltrixeye/contracts';
import { isDomainError } from '@veltrixeye/core';

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

/** Central error handler: maps domain/zod errors to safe HTTP responses. */
export function errorHandler(err: Error, req: FastifyRequest, reply: FastifyReply): void {
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
  req.log.error({ err }, 'unhandled error');
  void reply.code(500).send({
    error: {
      code: ERROR_CODES.INTERNAL,
      message: 'An unexpected error occurred',
    },
  } satisfies ApiErrorBody);
}
