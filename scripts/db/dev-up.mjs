// Dev database: boot the embedded Postgres that `npm run dev` uses.
// Reads DATABASE_URL from the repo root .env (created by `npm run setup`).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgres } from './embedded.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envPath = path.join(root, '.env');

let envText = '';
try {
  envText = readFileSync(envPath, 'utf8');
} catch {
  console.error('[db] .env not found. Run `npm run setup` first.');
  process.exit(1);
}
const match = envText.match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
if (!match) {
  console.error('[db] DATABASE_URL not found in .env. Run `npm run setup`.');
  process.exit(1);
}
const url = new URL(match[1].trim());

const dataDir = path.join(root, '.dev', 'pg');
const { dbUrl, stop } = await startEmbeddedPostgres({
  dataDir,
  port: Number(url.port || 5433),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
});
console.info(`[db] embedded Postgres ready: ${dbUrl}`);
console.info('[db] migrations are applied automatically by the API at boot.');

const shutdown = async (signal) => {
  console.info(`[db] ${signal} received, stopping Postgres`);
  await stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Keep the process alive while Postgres runs.
await new Promise(() => {});
