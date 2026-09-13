// `npm run db:migrate` — apply the SQL migrations to DATABASE_URL.
//
// Migrations are also applied automatically by the API at boot (see
// apps/api/src/server.ts); this CLI exists for the cases where you want to
// migrate WITHOUT starting the service: CI jobs, provisioning a fresh
// production database, or inspecting migration state.
//
// Configuration comes from the real environment, falling back to the repo-root
// `.env` (the same file `npm run setup` writes and `npm run db:dev` reads).
// Real environment variables always win. Nothing here holds a default
// credential — a missing DATABASE_URL is a hard error.
//
// Usage:
//   npm run db:migrate              apply pending migrations
//   npm run db:migrate -- --status  list what is / is not applied (read-only)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations, MIGRATIONS_DIR } from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read a single KEY from the repo-root `.env`, if that file exists.
 * Deliberately tiny: it only has to understand the flat `KEY=value` format
 * that `scripts/setup.mjs` writes and `.env.example` documents.
 */
function readDotEnvValue(key: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return undefined; // no .env — the real environment must provide everything
  }
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'));
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  let value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/** Environment first, then `.env`. */
function env(key: string): string | undefined {
  return process.env[key] ?? readDotEnvValue(key);
}

async function main(): Promise<number> {
  const databaseUrl = env('DATABASE_URL');
  if (!databaseUrl) {
    console.error(
      '[migrate] DATABASE_URL is not set.\n' +
        '        Provide it in the environment, or run `npm run setup` to create a local .env.\n' +
        '        See docs/environment.md.',
    );
    return 1;
  }

  const sslModeRaw = env('DATABASE_SSL_MODE') ?? 'disable';
  if (sslModeRaw !== 'disable' && sslModeRaw !== 'require' && sslModeRaw !== 'verify-full') {
    console.error(
      `[migrate] invalid DATABASE_SSL_MODE "${sslModeRaw}" — expected disable | require | verify-full.`,
    );
    return 1;
  }

  const poolMax = Number(env('DATABASE_POOL_MAX') ?? '10');
  if (!Number.isInteger(poolMax) || poolMax <= 0 || poolMax > 50) {
    console.error(`[migrate] invalid DATABASE_POOL_MAX — expected an integer 1-50.`);
    return 1;
  }

  const statusOnly = process.argv.includes('--status');
  const pool = createPool({ databaseUrl, max: poolMax, sslMode: sslModeRaw });

  try {
    // Fail fast with a clear message instead of a raw connection error.
    await pool.query('SELECT 1');
  } catch (err) {
    console.error(`[migrate] cannot reach the database: ${(err as Error).message}`);
    await pool.end().catch(() => {});
    return 1;
  }

  try {
    // `schema_migrations` is created by runMigrations, so on a brand-new
    // database it does not exist yet — check before reading it.
    const tableExists = await pool.query<{ present: boolean }>(
      `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
    );
    const rows = tableExists.rows[0]?.present
      ? (
          await pool.query<{ version: number; name: string; applied_at: Date }>(
            'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
          )
        ).rows
      : [];

    if (statusOnly) {
      if (rows.length === 0) {
        console.info('[migrate] no migrations applied yet (schema_migrations is empty).');
      } else {
        console.info(`[migrate] ${rows.length} migration(s) applied:`);
        for (const row of rows) {
          console.info(`  ${String(row.version).padStart(4, '0')}  ${row.name}  (${row.applied_at.toISOString()})`);
        }
      }
      return 0;
    }

    const before = new Set(rows.map((r) => r.name));
    const result = await runMigrations(pool, MIGRATIONS_DIR);

    if (result.applied.length === 0) {
      console.info(
        `[migrate] schema is up to date — ${result.alreadyApplied.length} migration(s) already applied.`,
      );
      return 0;
    }

    console.info(`[migrate] applied ${result.applied.length} migration(s):`);
    for (const name of result.applied) console.info(`  + ${name}`);
    if (result.alreadyApplied.length > 0) {
      console.info(`[migrate] ${result.alreadyApplied.length} previously applied, skipped.`);
    }
    // `before` is informational only; surfaced so an operator can see at a
    // glance whether this run changed anything.
    console.info(
      `[migrate] done — database went from ${before.size} to ${before.size + result.applied.length} applied migration(s).`,
    );
    return 0;
  } catch (err) {
    console.error(`[migrate] failed: ${(err as Error).message}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error('[migrate] unexpected error:', err);
    process.exitCode = 1;
  });
