/**
 * Request-URL logging — the invariant that keeps an INFO-level request log safe.
 *
 * Fastify writes its own `incoming request` line at INFO level and that line
 * carries the FULL request URL, query string included. `LOG_LEVEL` is `info` in
 * production (see `render.yaml`), so every request URL is logged.
 *
 * That is safe for exactly one reason: **no route reads a credential from the
 * query string.** A token, an authorization code or an API key passed as a
 * query parameter would therefore be written to the production log sink. This
 * is pre-existing framework behaviour and it is deliberately NOT changed here
 * — censoring `req.url` would make every request line useless for debugging.
 *
 * What this test pins is the invariant instead: if a future route starts
 * reading a credential-shaped query parameter, this fails. The error-log
 * tests cover exceptions; this covers the request line.
 *
 * NOTE: this is a static source scan, so it is a guard against a whole class
 * of mistake, not a claim that no value is ever sensitive at runtime.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SRC_DIR = new URL('../src/', import.meta.url).pathname;

/** Words that must never name a value read out of the query string. */
const CREDENTIAL_SHAPED =
  /\b(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|authorization|signature|credential|private[_-]?key)\b/i;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every request query-string read, with a little trailing context.
 *
 * Matches `.query` reached from a request object — `req.query` and the cast
 * form `(req as { query?: unknown }).query` — while deliberately NOT matching
 * `pool.query(...)` / `db.query(...)`, whose SQL text legitimately contains
 * words like `password`.
 */
function queryReads(source: string): string[] {
  const reads: string[] = [];
  const pattern = /\.query\b/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const before = source.slice(Math.max(0, match.index - 120), match.index);
    // Drop inline type casts so `(req as { … }).query` collapses to `(req)`.
    const stripped = before.replace(/as\s*\{[^}]*\}/g, '').replace(/\s+/g, '');
    const fromRequest =
      /\((?:req|request)\)$/.test(stripped) ||
      /(?:^|[^\w])(?:req|request)$/.test(stripped);

    if (fromRequest) {
      // Same statement only: stop at a newline or a semicolon.
      const rest = source.slice(match.index, match.index + 400);
      const cut = Math.min(
        ...[rest.indexOf('\n'), rest.indexOf(';')].filter((n) => n >= 0).concat(rest.length),
      );
      reads.push(rest.slice(0, cut));
    }
    match = pattern.exec(source);
  }
  return reads;
}

test('no API route reads a credential-shaped value from the query string', () => {
  const files = sourceFiles(SRC_DIR);
  assert.ok(files.length > 0, 'the source scan must find files');

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const read of queryReads(source)) {
      if (CREDENTIAL_SHAPED.test(read)) {
        offenders.push(`${file.replace(SRC_DIR, '')}: ${read.trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Fastify logs the full request URL at INFO level, so a credential read ' +
      'from the query string would be written to the production log. Pass it ' +
      'in a header or a body instead.',
  );
});
