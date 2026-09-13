import type { FastifyInstance } from 'fastify';
import { migrationStatus, MIGRATIONS_DIR, type MigrationStatus } from '@veltrixeye/core';
import type { AppContext } from '../app.js';

/**
 * Health endpoints. Both are unauthenticated by design (load balancers and
 * uptime checks cannot hold a session) and expose no data beyond the state of
 * this process and its schema:
 *
 *  - `GET /api/health`        liveness — the process answers HTTP. Never
 *                             touches the database, so a database blip does
 *                             not restart a healthy process.
 *  - `GET /api/health/ready`  readiness — database reachable AND the schema
 *                             this build expects is applied. 503 otherwise,
 *                             so a platform health check refuses to put an
 *                             unmigrated instance into service.
 *
 * Migration state is read-only (`migrationStatus`); nothing here can change
 * the schema.
 */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/api/health/ready', async (_req, reply) => {
    try {
      await ctx.pool.query('SELECT 1');
    } catch {
      return reply.code(503).send({ status: 'unavailable', database: 'down' });
    }

    let schema: MigrationStatus;
    try {
      schema = await migrationStatus(ctx.pool, MIGRATIONS_DIR);
    } catch {
      return reply.code(503).send({
        status: 'unavailable',
        database: 'up',
        schema: null,
        reason: 'migration state could not be read',
      });
    }

    const payload = {
      applied: schema.appliedCount,
      expected: schema.expectedCount,
      latest: schema.latestApplied,
      pending: schema.pending,
      checksumsMatch: schema.checksumsMatch,
    };

    if (schema.pending.length > 0) {
      return reply.code(503).send({
        status: 'unavailable',
        database: 'up',
        schema: payload,
        reason: 'pending migrations',
      });
    }
    if (!schema.checksumsMatch) {
      return reply.code(503).send({
        status: 'unavailable',
        database: 'up',
        schema: payload,
        reason: 'migration checksum mismatch',
      });
    }

    return { status: 'ready', database: 'up', schema: payload };
  });
}
