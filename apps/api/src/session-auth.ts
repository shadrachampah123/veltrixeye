import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { AppContext } from './app.js';
import { sendDomainError } from './errors.js';
import { Errors } from '@veltrixeye/core';
import type { UserDto } from '@veltrixeye/contracts';

export interface AuthenticatedRequest extends FastifyRequest {
  user: UserDto;
  /** Raw session token (from the cookie), for session revocation operations. */
  sessionToken: string;
}

/**
 * Session guard: validates the session cookie and attaches the user to the
 * request. Returns false (and sends 401) when authentication is missing or
 * invalid. All tenant-scoped routes MUST use this — user isolation depends
 * on request.user.id being the only identity the services ever see.
 */
export function createSessionAuth(
  config: AppConfig,
  ctx: AppContext,
): (request: FastifyRequest, reply: FastifyReply) => Promise<boolean> {
  return async (request, reply) => {
    const token = request.cookies[config.SESSION_COOKIE_NAME];
    if (!token || typeof token !== 'string' || token.length === 0) {
      sendDomainError(reply, Errors.unauthorized());
      return false;
    }
    const record = await ctx.sessions.findByToken(token);
    if (!record) {
      sendDomainError(reply, Errors.unauthorized());
      return false;
    }
    const user = await ctx.users.findById(record.userId);
    if (!user) {
      sendDomainError(reply, Errors.unauthorized());
      return false;
    }
    (request as AuthenticatedRequest).user = ctx.users.toDto(user);
    (request as AuthenticatedRequest).sessionToken = token;
    return true;
  };
}

export function setSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  ttlDays: number,
): void {
  const secure =
    config.COOKIE_SECURE === 'always' || (config.COOKIE_SECURE === 'auto' && config.NODE_ENV === 'production');
  reply.setCookie(config.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: ttlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.SESSION_COOKIE_NAME, { path: '/' });
}
