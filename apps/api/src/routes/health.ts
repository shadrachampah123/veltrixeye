import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';

export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/api/health/ready', async (_req, reply) => {
    try {
      await ctx.pool.query('SELECT 1');
      return { status: 'ready', database: 'up' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'down' });
    }
  });
}
