import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startEmbeddedPostgres } from '../../../scripts/db/embedded.mjs';
import { createPool, listMigrationFiles, migrationStatus, MIGRATIONS_DIR, runMigrations } from '../src/index.js';

let db: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let freshDb: Awaited<ReturnType<typeof startEmbeddedPostgres>>;
let pool: ReturnType<typeof createPool>;
let freshPool: ReturnType<typeof createPool>;
let oldDir: string;
let fullDir: string;

function copyMigrations(destination: string, maxVersion: number | null): void {
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = /^(\d{4})_/.exec(file);
    if (match && (maxVersion === null || Number(match[1]) <= maxVersion)) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(destination, file));
  }
}

before(async () => {
  oldDir = mkdtempSync(path.join(os.tmpdir(), 've-m91-0022-'));
  fullDir = mkdtempSync(path.join(os.tmpdir(), 've-m91-fresh-'));
  copyMigrations(oldDir, 22);
  copyMigrations(fullDir, null);
  const migrationDataDir = path.join(os.tmpdir(), `ve-m91-migrations-pg-${process.pid}`);
  const freshDataDir = path.join(os.tmpdir(), `ve-m91-fresh-pg-${process.pid}`);
  rmSync(migrationDataDir, { recursive: true, force: true });
  rmSync(freshDataDir, { recursive: true, force: true });
  db = await startEmbeddedPostgres({ dataDir: migrationDataDir, port: 5457, user: 'test', password: 'm91', database: 'veltrixeye_m91_migrations' });
  pool = createPool({ databaseUrl: db.dbUrl });
  freshDb = await startEmbeddedPostgres({ dataDir: freshDataDir, port: 5458, user: 'test', password: 'm91', database: 'veltrixeye_m91_fresh' });
  freshPool = createPool({ databaseUrl: freshDb.dbUrl });
}, { timeout: 180_000 });

after(async () => { await pool?.end(); await freshPool?.end(); await db?.stop(); await freshDb?.stop(); rmSync(oldDir, { recursive: true, force: true }); rmSync(fullDir, { recursive: true, force: true }); });

test('M9.1 migrations upgrade an existing 0022 database and preserve email preference semantics', async () => {
  const before = await runMigrations(pool, oldDir);
  assert.equal(before.applied.length, 22);
  let status = await migrationStatus(pool, MIGRATIONS_DIR);
  assert.deepEqual(status.pending.slice(-2), ['0023_notification_preferences.sql', '0024_notification_routing.sql']);
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.startsWith('0023_') || file.startsWith('0024_'));
  for (const file of files) copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(oldDir, file));
  const upgraded = await runMigrations(pool, oldDir);
  assert.deepEqual(upgraded.applied, files.sort());
  status = await migrationStatus(pool, oldDir);
  assert.equal(status.pending.length, 0);
  assert.equal(status.checksumsMatch, true);
  const user = await pool.query<{ id: string }>("INSERT INTO users (email, password_hash, name) VALUES ('m91@example.com', 'x', 'M91') RETURNING id");
  const emailPreference = await pool.query("INSERT INTO notification_preferences (user_id, channel, enabled) VALUES ($1, 'email', false) RETURNING channel", [user.rows[0]!.id]);
  assert.equal(emailPreference.rows[0].channel, 'email');
  const other = await pool.query<{ id: string }>("INSERT INTO users (email, password_hash, name) VALUES ('other-m91@example.com', 'x', 'Other') RETURNING id");
  const strategy = await pool.query<{ id: string }>('INSERT INTO strategies (user_id, name) VALUES ($1, $2) RETURNING id', [user.rows[0]!.id, 'M91 Strategy']);
  await assert.rejects(
    () => pool.query('INSERT INTO strategy_notification_preferences (user_id, strategy_id) VALUES ($1, $2)', [other.rows[0]!.id, strategy.rows[0]!.id]),
    (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503',
  );
});

test('M9.1 migrations apply cleanly to a fresh database', async () => {
  const result = await runMigrations(freshPool, fullDir);
  const status = await migrationStatus(freshPool, fullDir);
  assert.equal(result.applied.length, 24);
  assert.equal(status.pending.length, 0);
  assert.equal(status.checksumsMatch, true);
  assert.ok((await listMigrationFiles(fullDir)).some((file) => file.name === '0024_notification_routing.sql'));
});
