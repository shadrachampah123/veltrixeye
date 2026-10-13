import type { FastifyInstance } from 'fastify';
import { migrationStatus, MIGRATIONS_DIR, type MigrationStatus } from '@veltrixeye/core';
import type { AppContext } from '../app.js';
import { workerLivenessSnapshot } from '../worker-liveness.js';

/**
 * Health endpoints. Both are unauthenticated by design (load balancers and
 * uptime checks cannot hold a session) and expose no data beyond the state of
 * this process and its schema:
 *
 *  - `GET /api/health`        liveness — the process answers HTTP. Never
 *                             touches the database, so a database blip does
 *                             not restart a healthy process. It also reports
 *                             the in-memory worker liveness registry (last
 *                             success/failure per scheduled worker, counts and
 *                             a machine code only), which is the ONLY way to
 *                             confirm that an external scheduler is actually
 *                             executing the scanner and delivery workers
 *                             without holding a worker token.
 *  - `GET /api/health/ready`  readiness — database reachable AND the schema
 *                             this build expects is applied. 503 otherwise,
 *                             so a platform health check refuses to put an
 *                             unmigrated instance into service.
 *
 * Migration state is read-only (`migrationStatus`); nothing here can change
 * the schema. The worker snapshot is process-local state read from memory — it
 * never queries the database, so `GET /api/health` keeps its "never touches the
 * database" contract.
 */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    // Timestamps, counters and a short machine code per scheduled worker — no
    // tenant identifier, no queue contents, no provider text, no secret.
    workers: workerLivenessSnapshot(),
  }));

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
