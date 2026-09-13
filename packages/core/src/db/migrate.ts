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

/** A `NNNN_name.sql` migration file shipped with this build. */
export interface MigrationFile {
  version: number;
  name: string;
  file: string;
}

/** Read-only view of how this build's migrations relate to a database. */
export interface MigrationStatus {
  /** Migration files shipped with this build. */
  expectedCount: number;
  /** Migrations recorded in `schema_migrations`. */
  appliedCount: number;
  /** File names present in the build but NOT recorded as applied. */
  pending: string[];
  /** File name of the highest applied migration, or null. */
  latestApplied: string | null;
  /**
   * false when an applied migration's file is missing from this build or its
   * checksum no longer matches the recorded one (drift).
   */
  checksumsMatch: boolean;
}

const MIGRATION_FILE_RE = /^(\d{4})_(.+)\.sql$/;

/**
 * Advisory-lock key that serialises migration runs across processes.
 * Any two instances (or a boot-time run racing an operator CLI run) that ask
 * for the same key queue behind each other instead of applying the same
 * migration twice. Arbitrary, but it must never change.
 */
const MIGRATION_LOCK_KEY = 611_231_007;
const MIGRATION_LOCK_WAIT_MS = 60_000;
const MIGRATION_LOCK_POLL_MS = 500;

/**
 * List the migration files in `migrationsDir` in apply order.
 * Throws on duplicate versions — two files claiming the same version would
 * make the order ambiguous.
 */
export async function listMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const migrations = entries
    .map((file): MigrationFile | null => {
      const match = MIGRATION_FILE_RE.exec(file);
      if (!match) return null;
      return { version: Number(match[1]), name: file, file: path.join(migrationsDir, file) };
    })
    .filter((m): m is MigrationFile => m !== null)
    .sort((a, b) => a.version - b.version);

  const seen = new Map<number, string>();
  for (const m of migrations) {
    const previous = seen.get(m.version);
    if (previous !== undefined) {
      throw new Error(`Duplicate migration version ${m.version}: ${previous} and ${m.name}`);
    }
    seen.set(m.version, m.name);
  }
  return migrations;
}

/**
 * Read-only migration/schema state, for health reporting and operator checks.
 * Never writes and never applies anything.
 */
export async function migrationStatus(pool: pg.Pool, migrationsDir: string): Promise<MigrationStatus> {
  const files = await listMigrationFiles(migrationsDir);

  // The table is created by runMigrations, so it may legitimately not exist
  // yet on a database that has never been migrated.
  const tableExists = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  const applied = tableExists.rows[0]?.present
    ? (
        await pool.query<MigrationRecord>(
          'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
        )
      ).rows
    : [];

  const appliedVersions = new Set(applied.map((row) => row.version));
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const pending = files.filter((file) => !appliedVersions.has(file.version)).map((file) => file.name);

  // Drift check: every applied migration must still exist in this build with
  // the same checksum. Mismatches mean the build and the database disagree
  // about the schema — exactly the case runMigrations refuses to continue on.
  const checksums = await Promise.all(
    applied.map(async (row) => {
      const file = byVersion.get(row.version);
      if (!file) return false;
      const sql = await readFile(file.file, 'utf8');
      return createHash('sha256').update(sql).digest('hex') === row.checksum;
    }),
  );

  return {
    expectedCount: files.length,
    appliedCount: applied.length,
    pending,
    latestApplied: applied.at(-1)?.name ?? null,
    checksumsMatch: checksums.every(Boolean),
  };
}

/**
 * Minimal, deterministic SQL migration runner.
 *
 * - Migrations are `NNNN_name.sql` files applied in filename order.
 * - Each migration runs inside a single transaction.
 * - Applied migrations are recorded in `schema_migrations` with a SHA-256
 *   checksum. If an already-applied migration's file changes, the runner
 *   REFUSES to continue (drift protection — migrations are immutable once
 *   applied; add a new migration instead).
 * - A Postgres advisory lock serialises concurrent runners, so boot-time
 *   migrations stay safe if more than one instance starts at the same time
 *   and when an operator runs `npm run db:migrate` alongside a deploy.
 * - Migrations are additive only: this runner never drops, truncates or
 *   rewrites data, and it has no "reset" path.
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<RunMigrationsResult> {
  const client = await pool.connect();
  let locked = false;
  try {
    await acquireMigrationLock(client);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrations = await listMigrationFiles(migrationsDir);

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
    if (locked) {
      // Advisory locks are session-scoped: release before the client goes
      // back to the pool, otherwise the lock would outlive this run.
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    client.release();
  }
}

/**
 * Take the migration advisory lock, waiting briefly for a concurrent runner.
 * A bounded wait means a stuck lock produces a clear error instead of a
 * process that silently never finishes booting.
 */
async function acquireMigrationLock(client: pg.PoolClient): Promise<void> {
  const deadline = Date.now() + MIGRATION_LOCK_WAIT_MS;
  for (;;) {
    const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
      MIGRATION_LOCK_KEY,
    ]);
    if (res.rows[0]?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        'Timed out waiting for the migration lock held by another process. ' +
          'Another deploy/instance is migrating this database — retry when it finishes.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_MS));
  }
}
