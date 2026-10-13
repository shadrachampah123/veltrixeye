/**
 * Regression tests for the Gold v8 production diagnostic's output hygiene.
 *
 * These run the real script as a child process. Every case here is refused by
 * the TLS check, which runs before any connection is opened, so no database is
 * needed and nothing leaves the machine.
 *
 * The property under test: credential-like text placed in DATABASE_URL (in the
 * password, in a parameter NAME, or in a parameter VALUE) never appears in
 * stdout, stderr, or any file the script writes to its output directory.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = fileURLToPath(new URL('../gold-v8-production-evidence.ts', import.meta.url));

// A recognisable stand-in for a leaked credential. It is not a real secret.
const MARKER = 'LEAKPROBE-7f3a9c';

const workDirs: string[] = [];
after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

function runWithDatabaseUrl(databaseUrl: string): {
  status: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
} {
  const outDir = mkdtempSync(join(tmpdir(), 'gold-diag-test-'));
  workDirs.push(outDir);
  // A clean environment: only what the script needs, plus the URL under test.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? tmpdir(),
    DATABASE_URL: databaseUrl,
  };
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', SCRIPT, '--strategy', 'gold', '--version', '8', '--symbol', 'XAUUSD', '--asset-class', 'commodity', '--out', outDir],
    { env, encoding: 'utf8', timeout: 120_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    outDir,
  };
}

/** Assert the marker is absent from output and from every generated file. */
function assertNoMarker(run: ReturnType<typeof runWithDatabaseUrl>): void {
  assert.ok(!run.stdout.includes(MARKER), `marker found in stdout:\n${run.stdout}`);
  assert.ok(!run.stderr.includes(MARKER), `marker found in stderr:\n${run.stderr}`);
  for (const file of filesUnder(run.outDir)) {
    const contents = readFileSync(file, 'utf8');
    assert.ok(!contents.includes(MARKER), `marker found in generated file ${file}`);
  }
}

describe('diagnostic output never echoes DATABASE_URL credential text', () => {
  // Each case puts the marker where a hostile or mistaken URL could carry a
  // secret: a TLS parameter NAME (the case fixed by this change), an
  // uppercase or percent-encoded name, a parameter with no value, a value of
  // sslmode, a non-TLS parameter name, and the password.
  const cases: Array<{ name: string; url: string; expectedStatus: number }> = [
    {
      name: 'ssl* parameter name carrying the marker',
      url: `postgres://u:p@localhost:1/db?ssl${MARKER}=1`,
      expectedStatus: 2,
    },
    {
      name: 'uppercase ssl* parameter name carrying the marker',
      url: `postgres://u:p@localhost:1/db?SSL_${MARKER}=on`,
      expectedStatus: 2,
    },
    {
      name: 'percent-encoded ssl* parameter name carrying the marker',
      url: `postgres://u:p@localhost:1/db?%73sl${MARKER}=1`,
      expectedStatus: 2,
    },
    {
      name: 'ssl* parameter name with no value',
      url: `postgres://u:p@localhost:1/db?ssl${MARKER}`,
      expectedStatus: 2,
    },
    {
      name: 'uselibpqcompat parameter with the marker as its value',
      url: `postgres://u:p@localhost:1/db?uselibpqcompat=${MARKER}`,
      expectedStatus: 2,
    },
    {
      name: 'sslmode with a non-verify-full value carrying the marker',
      url: `postgres://u:p@localhost:1/db?sslmode=${MARKER}`,
      expectedStatus: 2,
    },
    {
      name: 'password carrying the marker plus a TLS parameter',
      url: `postgres://u:${MARKER}@localhost:1/db?sslrootcert=/tmp/${MARKER}.pem`,
      expectedStatus: 2,
    },
  ];

  for (const c of cases) {
    it(`refuses and does not echo: ${c.name}`, () => {
      const run = runWithDatabaseUrl(c.url);
      assert.equal(run.status, c.expectedStatus, `unexpected exit; stderr:\n${run.stderr}`);
      // The refusal ran (not some unrelated failure), and it is the fixed text.
      assert.match(run.stderr, /TLS|sslmode/, 'expected a TLS refusal message');
      assertNoMarker(run);
    });
  }

  it('a TLS-parameter refusal prints fixed text, not the parameter name', () => {
    const run = runWithDatabaseUrl(`postgres://u:p@localhost:1/db?ssl${MARKER}=1`);
    assert.match(run.stderr, /carries a TLS parameter \(an ssl\* setting or uselibpqcompat\)/);
    assert.ok(!run.stderr.includes(`ssl${MARKER}`));
  });
});
