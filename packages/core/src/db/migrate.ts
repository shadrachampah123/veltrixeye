import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Directory containing the packaged SQL migrations (works from tsx and from tsc output). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export interface MigrationRecord {
  version: number;
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

const MIGRATION_FILE_RE = /^(\d{4})_(.+)\.sql$/;

/**
 * Minimal, deterministic SQL migration runner.
 *
 * - Migrations are `NNNN_name.sql` files applied in filename order.
 * - Each migration runs inside a single transaction.
 * - Applied migrations are recorded in `schema_migrations` with a SHA-256
 *   checksum. If an already-applied migration's file changes, the runner
 *   REFUSES to continue (drift protection — migrations are immutable once
 *   applied; add a new migration instead).
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<RunMigrationsResult> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const entries = await readdir(migrationsDir);
    const migrations = entries
      .map((file) => {
        const match = MIGRATION_FILE_RE.exec(file);
        if (!match) return null;
        return { version: Number(match[1]), name: file, file: path.join(migrationsDir, file) };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => a.version - b.version);

    const seen = new Set<number>();
    for (const m of migrations) {
      if (seen.has(m.version)) {
        throw new Error(`Duplicate migration version ${m.version}`);
      }
      seen.add(m.version);
    }

    const result: RunMigrationsResult = { applied: [], alreadyApplied: [] };

    for (const m of migrations) {
      const sql = await readFile(m.file, 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');

      const existing = await client.query<MigrationRecord>(
        'SELECT version, name, checksum, applied_at FROM schema_migrations WHERE version = $1',
        [m.version],
      );
      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row && row.checksum !== checksum) {
          throw new Error(
            `Migration ${m.name} was already applied but its contents changed ` +
              `(expected checksum ${row.checksum.slice(0, 12)}…, got ${checksum.slice(0, 12)}…). ` +
              'Applied migrations are immutable — create a new migration instead.',
          );
        }
        result.alreadyApplied.push(m.name);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          checksum,
        ]);
        await client.query('COMMIT');
        result.applied.push(m.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }

    return result;
  } finally {
    client.release();
  }
}
