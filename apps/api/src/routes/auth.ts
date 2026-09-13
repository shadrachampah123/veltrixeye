import type { FastifyInstance } from 'fastify';
import { registerSchema, loginSchema } from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import { createSessionAuth, setSessionCookie, clearSessionCookie, type AuthenticatedRequest } from '../session-auth.js';
import { hashPassword, verifyPassword } from '@veltrixeye/core';

/**
 * Authentication routes.
 *
 * Security notes:
 *  - login failures always return the same generic message (no user
 *    enumeration) and always perform an Argon2 verify (timing parity)
 *  - the register route is rate-limited by IP (see app.ts)
 *  - sessions are server-side; the cookie is HttpOnly + SameSite=Strict
 */
export async function authRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  // Strict per-IP limit on registration to slow down bulk account creation.
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { email, password, name } = parsed.data;

    const existing = await ctx.users.findByEmail(email);
    if (existing) {
      return reply.code(409).send({
        error: { code: 'conflict', message: 'An account with this email already exists' },
      });
    }

    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await ctx.users.create({
        email,
        passwordHash,
        name: name ?? email.split('@')[0] ?? 'Trader',
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({
          error: { code: 'conflict', message: 'An account with this email already exists' },
        });
      }
      throw err;
    }

    const { token } = await ctx.sessions.create(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    setSessionCookie(reply, config, token, config.SESSION_TTL_DAYS);
    await ctx.audit.log({
      userId: user.id,
      action: 'auth.registered',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return reply.code(201).send({ user });
  });

  // Strict per-IP limit on login to slow down credential brute-forcing.
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { email, password } = parsed.data;

    const user = await ctx.users.findByEmail(email);
    const ok = user ? await verifyPassword(user.password_hash, password) : await dummyVerify(password);
    if (!user || !ok) {
      if (user) {
        await ctx.audit.log({
          userId: user.id,
          action: 'auth.login_failed',
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
          metadata: { reason: 'invalid_credentials' },
        });
      }
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'Invalid email or password' },
      });
    }

    const { token } = await ctx.sessions.create(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    setSessionCookie(reply, config, token, config.SESSION_TTL_DAYS);
    await ctx.audit.log({
      userId: user.id,
      action: 'auth.login',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { user: ctx.users.toDto(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user, sessionToken } = req as AuthenticatedRequest;
    await ctx.sessions.revoke(sessionToken);
    clearSessionCookie(reply, config);
    await ctx.audit.log({
      userId: user.id,
      action: 'auth.logout',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  });
}

/**
 * Timing parity: when the user does not exist we still run an Argon2 verify
 * against a precomputed dummy hash so login response time does not leak
 * whether the email is registered.
 */
let dummyHashPromise: Promise<string> | null = null;
async function dummyVerify(password: string): Promise<boolean> {
  dummyHashPromise ??= hashPassword('veltrixeye-dummy-hash-password');
  const hash = await dummyHashPromise;
  return verifyPassword(hash, password);
}
