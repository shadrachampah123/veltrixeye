import type { FastifyInstance } from 'fastify';
import { changePasswordSchema, updateProfileSchema } from '@veltrixeye/contracts';
import type { AppContext } from '../app.js';
import type { AppConfig } from '../config.js';
import { sendZodError } from '../errors.js';
import {
  createSessionAuth,
  setSessionCookie,
  clearSessionCookie,
  type AuthenticatedRequest,
} from '../session-auth.js';
import { hashPassword, verifyPassword, Errors } from '@veltrixeye/core';

export async function userRoutes(app: FastifyInstance, ctx: AppContext, config: AppConfig): Promise<void> {
  const requireAuth = createSessionAuth(config, ctx);

  app.get('/api/users/me', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user, sessionToken } = req as AuthenticatedRequest;
    const sessions = await ctx.sessions.listForUser(user.id, sessionToken);
    return { user, sessions };
  });

  app.patch('/api/users/me', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    await ctx.users.updateName(user.id, parsed.data.name);
    const updated = await ctx.users.findById(user.id);
    if (!updated) throw Errors.notFound('User not found');
    return { user: ctx.users.toDto(updated) };
  });

  // Credential endpoint (verifies the current password): strictly limited
  // per IP like login/register so an abuser holding one session cannot
  // brute-force a password change. 5/min is far above any legitimate use.
  app.post(
    '/api/users/me/password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      sendZodError(reply, parsed.error, 'body');
      return;
    }
    const { user } = req as AuthenticatedRequest;
    const row = await ctx.users.findById(user.id);
    if (!row) throw Errors.notFound('User not found');
    const valid = await verifyPassword(row.password_hash, parsed.data.currentPassword);
    if (!valid) {
      await ctx.audit.log({
        userId: user.id,
        action: 'auth.password_change_failed',
        ip: req.ip,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'Current password is incorrect' },
      });
    }

    const newHash = await hashPassword(parsed.data.newPassword);
    await ctx.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, newHash]);
    // Security: invalidate every other session; rotate the current one.
    await ctx.sessions.revokeAllForUser(user.id);
    const { token } = await ctx.sessions.create(user.id, {
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    clearSessionCookie(reply, config);
    setSessionCookie(reply, config, token, config.SESSION_TTL_DAYS);
    await ctx.audit.log({
      userId: user.id,
      action: 'auth.password_changed',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  });

  app.delete('/api/users/me/sessions/:sessionId', async (req, reply) => {
    const ok = await requireAuth(req, reply);
    if (!ok) return;
    const { user, sessionToken } = req as AuthenticatedRequest;
    const { sessionId } = req.params as { sessionId: string };
    const sessions = await ctx.sessions.listForUser(user.id, sessionToken);
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) throw Errors.notFound('Session not found');
    if (target.current) {
      await ctx.sessions.revoke(sessionToken);
      clearSessionCookie(reply, config);
    } else {
      await ctx.pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2', [
        sessionId,
        user.id,
      ]);
    }
    await ctx.audit.log({
      userId: user.id,
      action: 'auth.session_revoked',
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
      metadata: { sessionId },
    });
    return { ok: true };
  });
}
