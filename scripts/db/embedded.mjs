// Shared helper: boot a real PostgreSQL instance via the embedded-postgres
// npm package (native binary, no system install). Used by local dev and the
// test suites. The PRODUCT CODE NEVER depends on this — it only connects to
// a DATABASE_URL.
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgresDefault from 'embedded-postgres';

const EmbeddedPostgres = EmbeddedPostgresDefault;

/**
 * Start an embedded Postgres cluster + database.
 * @param {object} opts
 * @param {string} opts.dataDir  cluster data directory
 * @param {number} opts.port     TCP port
 * @param {string} opts.user     superuser name
 * @param {string} opts.password superuser password
 * @param {string} opts.database database name to create (if missing)
 * @returns {Promise<{db: any, dbUrl: string, stop: () => Promise<void>}>}
 */
export async function startEmbeddedPostgres({ dataDir, port, user, password, database }) {
  mkdirSync(dataDir, { recursive: true });
  const db = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user,
    password,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C.utf8'],
    onLog: () => {},
    onError: (m) => console.error('[embedded-pg]', m),
  });

  // initialise() only works on a fresh data dir.
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await db.initialise();
  }
  await db.start();

  // Wait until accepting connections.
  const admin = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'postgres' });
  let lastErr;
  for (let i = 0; i < 30; i++) {
    try {
      await admin.connect();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (lastErr) {
    await db.stop().catch(() => {});
    throw new Error(`embedded Postgres did not become ready: ${lastErr.message}`);
  }

  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE "${database}"`);
  }
  await admin.end();

  const dbUrl = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  return {
    db,
    dbUrl,
    stop: async () => {
      await db.stop().catch((err) => console.error('[embedded-pg] stop error', err));
    },
  };
}
