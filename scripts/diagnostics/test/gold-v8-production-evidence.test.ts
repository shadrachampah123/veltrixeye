/**
 * Security and reliability tests for the Gold v8 production diagnostic.
 *
 * These are the guarantees the review of PR #104 asked to be reproducible in CI:
 *
 *   1. read-only transaction initialisation      — real embedded Postgres
 *   2. query-guard enforcement                   — real `ReadOnlySession`
 *   3. rollback on success AND on failure        — real embedded Postgres
 *   4. TLS environment-variable refusals         — pure functions + the real CLI
 *   5. missing DATABASE_URL / missing --strategy — real CLI (subprocess)
 *   6. invalid connection-string parameters      — pure functions + real CLI
 *   7. `default_transaction_read_only` not 'on'  — real embedded Postgres
 *   8. secret redaction and output scrubbing     — pure functions + real CLI
 *   9. driver errors without leaking credentials — real CLI (refused socket)
 *  10. writable-role / superuser refusal         — real embedded Postgres
 *
 * Every database case runs against a throwaway embedded Postgres on a private
 * port with stub tables. Nothing here connects to production, and the CLI cases
 * never open a connection at all (they are refused before `pool.connect()`, or
 * they are pointed at a closed local port).
 *
 * The CLI itself always requires `verify-full` TLS, and the embedded server is
 * plaintext, so the database cases drive the exported safety primitives
 * (`ReadOnlySession`, `Q_CONNECTION`, `factsFromConnectionRow`, `evaluateSafety`)
 * against the real server rather than going through `main()`.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import tls from 'node:tls';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

import { startEmbeddedPostgres, stopEmbeddedPostgres } from '../../db/embedded.mjs';
import {
  ALLOWED_URL_PARAMS,
  Q_CONNECTION,
  REFUSED_CONNECTION_ENV_VARS,
  REFUSED_TLS_ENV_VARS,
  ReportWriteError,
  WRITE_PRIVILEGE_COLUMNS,
  ReadOnlySession,
  anyStringLeaks,
  chooseStrategy,
  chooseVersion,
  connectionTargetEnvProblem,
  connectionUrlProblem,
  errorCodeOf,
  existingReportProblem,
  mdCode,
  outputPathProblem,
  reportPaths,
  writeReport,
  evaluateSafety,
  factsFromConnectionRow,
  OptionError,
  isStrategyUuid,
  jsonBlock,
  isPooledEndpointHost,
  managedProviderFor,
  normaliseEndpointHost,
  readClientTlsState,
  tlsVerificationProblems,
  backendSslExplanation,
  summariseNotificationDeliveries,
  deliveryFailureHint,
  isFailedDeliveryStatus,
  FAILED_DELIVERY_STATUSES,
  mapStrings,
  mdCell,
  mdRow,
  mdText,
  parseOptions,
  renderMarkdown,
  versionAmbiguityMessage,
  redact,
  scrubSecrets,
  secretValuesFrom,
  tlsEnvProblem,
} from '../gold-v8-production-evidence.ts';

const SCRIPT = fileURLToPath(new URL('../gold-v8-production-evidence.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

// A recognisable stand-in for a leaked credential. It is not a real secret.
const MARKER = 'LEAKPROBE-7f3a9c';

// ---------------------------------------------------------------------------
// CLI harness
// ---------------------------------------------------------------------------

const workDirs: string[] = [];
after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
  outDir: string;
}

/**
 * Run the real CLI with a minimal environment. `env` is layered on top of a
 * clean base (PATH/HOME only), so an ambient DATABASE_URL or PGSSL* in the CI
 * runner can never change the outcome of a case.
 */
const DEFAULT_ARGS: readonly string[] = [
  '--strategy',
  'Gold Break & Retest Test Pro VI',
  '--version',
  '8',
  '--symbol',
  'XAUUSD',
  '--asset-class',
  'commodity',
];

function runCli(
  env: Record<string, string | undefined>,
  args: readonly string[] = DEFAULT_ARGS,
  existingOutDir?: string,
): CliRun {
  let outDir: string;
  if (existingOutDir === undefined) {
    outDir = mkdtempSync(join(tmpdir(), 'gold-diag-test-'));
    workDirs.push(outDir);
  } else {
    outDir = existingOutDir;
  }

  const baseEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? tmpdir(),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) baseEnv[key] = value;
  }

  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args, '--out', outDir], {
    env: baseEnv,
    encoding: 'utf8',
    timeout: 120_000,
    cwd: REPO_ROOT,
  });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', outDir };
}

/** The marker must not appear in stdout, stderr, or any generated file. */
function assertNoMarker(run: CliRun): void {
  assert.ok(!run.stdout.includes(MARKER), `marker found in stdout:\n${run.stdout}`);
  assert.ok(!run.stderr.includes(MARKER), `marker found in stderr:\n${run.stderr}`);
  for (const file of filesUnder(run.outDir)) {
    assert.ok(!readFileSync(file, 'utf8').includes(MARKER), `marker found in generated file ${file}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Invalid connection-string parameters (pure)
// ---------------------------------------------------------------------------

describe('connection URL parameters are allowlisted', () => {
  it('accepts a bare URL and sslmode=verify-full', () => {
    assert.equal(connectionUrlProblem('postgres://u:p@db.internal:5432/app'), null);
    assert.equal(connectionUrlProblem('postgres://u:p@db.internal:5432/app?sslmode=verify-full'), null);
    assert.deepEqual([...ALLOWED_URL_PARAMS], ['sslmode']);
  });

  const refused: Array<[string, string]> = [
    ['sslmode=disable (plaintext)', 'postgres://u:p@h:5432/db?sslmode=disable'],
    ['sslmode=prefer', 'postgres://u:p@h:5432/db?sslmode=prefer'],
    ['sslmode=require', 'postgres://u:p@h:5432/db?sslmode=require'],
    ['sslmode=no-verify', 'postgres://u:p@h:5432/db?sslmode=no-verify'],
    ['ssl=true', 'postgres://u:p@h:5432/db?ssl=true'],
    ['sslrootcert', 'postgres://u:p@h:5432/db?sslrootcert=/tmp/ca.pem'],
    ['sslcert', 'postgres://u:p@h:5432/db?sslcert=/tmp/c.pem'],
    ['sslkey', 'postgres://u:p@h:5432/db?sslkey=/tmp/k.pem'],
    ['uselibpqcompat', 'postgres://u:p@h:5432/db?uselibpqcompat=true'],
    // The review's M1: these override the explicit pool configuration in pg.
    ['options (read-only override)', 'postgres://u:p@h:5432/db?options=-c%20default_transaction_read_only=off'],
    ['host (redirect)', 'postgres://u:p@h:5432/db?host=attacker.invalid'],
    ['port', 'postgres://u:p@h:5432/db?port=6543'],
    ['user', 'postgres://u:p@h:5432/db?user=someone-else'],
    ['password', 'postgres://u:p@h:5432/db?password=other'],
    ['db', 'postgres://u:p@h:5432/db?db=other'],
    ['application_name', 'postgres://u:p@h:5432/db?application_name=spoof'],
    ['statement_timeout', 'postgres://u:p@h:5432/db?statement_timeout=0'],
    ['search_path', 'postgres://u:p@h:5432/db?search_path=public'],
    ['unknown parameter', 'postgres://u:p@h:5432/db?foo=bar'],
    ['repeated sslmode hides a weaker value', 'postgres://u:p@h:5432/db?sslmode=verify-full&sslmode=disable'],
  ];

  for (const [name, url] of refused) {
    it(`refuses ${name}`, () => {
      const problem = connectionUrlProblem(url);
      assert.notEqual(problem, null, `expected a refusal for ${name}`);
    });
  }

  it('refuses a duplicate sslmode even when every value is verify-full', () => {
    const problem = connectionUrlProblem('postgres://u:p@h:5432/db?sslmode=verify-full&sslmode=verify-full');
    assert.notEqual(problem, null);
    assert.match(problem!, /repeats a query parameter/);
  });

  it('refuses duplicates that differ only in case', () => {
    const problem = connectionUrlProblem('postgres://u:p@h:5432/db?sslmode=verify-full&SSLMode=verify-full');
    assert.notEqual(problem, null);
    assert.match(problem!, /repeats a query parameter/);
  });

  it('refuses a repeated parameter that is not allowlisted too', () => {
    // A disallowed key is refused before the duplicate rule can matter, but the
    // outcome must be a refusal either way — never a silently-taken last value.
    for (const url of [
      'postgres://u:p@h:5432/db?foo=1&foo=2',
      'postgres://u:p@h:5432/db?options=a&options=b',
      'postgres://u:p@h:5432/db?sslmode=verify-full&options=-c%20default_transaction_read_only=off',
    ]) {
      assert.notEqual(connectionUrlProblem(url), null, `expected a refusal for ${url}`);
    }
  });

  it('still accepts the single occurrence', () => {
    assert.equal(connectionUrlProblem('postgres://u:p@h:5432/db?sslmode=verify-full'), null);
  });

  it('never echoes a parameter name that carries credential material', () => {
    const problem = connectionUrlProblem(`postgres://u:p@h:5432/db?ssl${MARKER}=1`);
    assert.notEqual(problem, null);
    assert.ok(!problem!.includes(MARKER), 'the parameter name leaked into the message');
    assert.match(problem!, /not allowed|sslmode/i);
  });

  it('refuses an unparseable URL without echoing it', () => {
    const problem = connectionUrlProblem(`not-a-url-${MARKER}`);
    assert.notEqual(problem, null);
    assert.match(problem!, /could not be parsed/);
    assert.ok(!problem!.includes(MARKER), 'the URL text leaked into the message');
  });

  it('refuses a URL that does not name the role', () => {
    // Without a user, pg falls back to PGUSER or the operating-system user name.
    const problem = connectionUrlProblem('postgres://db.internal:5432/app');
    assert.notEqual(problem, null);
    assert.match(problem!, /does not name the connecting role/);
    // …and the message never echoes the URL or a user name: this URL names a
    // (marker) role but no database, so it is refused for the database only.
    const withUser = connectionUrlProblem(`postgres://${MARKER}@db.internal`);
    assert.match(withUser!, /does not name the database/);
    assert.ok(!withUser!.includes(MARKER), 'the role leaked into the message');
  });

  it('refuses a URL that does not name the database', () => {
    for (const url of [
      'postgres://u:p@db.internal:5432',
      'postgres://u:p@db.internal:5432/',
      'postgres://u:p@db.internal',
    ]) {
      const problem = connectionUrlProblem(url);
      assert.notEqual(problem, null, `expected a refusal for ${url}`);
      assert.match(problem!, /does not name the database/);
    }
  });

  it('accepts only a URL that names role, database and nothing else', () => {
    assert.equal(connectionUrlProblem('postgres://u:p@h:5432/db'), null);
    assert.equal(connectionUrlProblem('postgres://u:p@h:5432/db?sslmode=verify-full'), null);
    // A password is still optional in the URL (peer/`.pgpass`-style auth), but the
    // user and the database are not.
    assert.equal(connectionUrlProblem('postgres://u@h:5432/db'), null);
  });
});

// ---------------------------------------------------------------------------
// 5. Ambient libpq connection variables cannot retarget the connection (pure)
// ---------------------------------------------------------------------------

describe('libpq connection variables are refused', () => {
  it('accepts a clean environment', () => {
    assert.equal(connectionTargetEnvProblem({ PATH: '/usr/bin', HOME: '/root' }), null);
    assert.equal(connectionTargetEnvProblem({ DATABASE_URL: 'postgres://u:p@h/db' }), null);
  });

  it('refuses every variable that pg would fall back to', () => {
    for (const variable of REFUSED_CONNECTION_ENV_VARS) {
      const problem = connectionTargetEnvProblem({ [variable]: 'x' });
      assert.notEqual(problem, null, `expected a refusal for ${variable}`);
      assert.match(problem!, new RegExp(variable));
      assert.ok(!problem!.includes('x'), 'the variable value leaked into the message');
    }
  });

  it('names the five libpq fallbacks the review asked for', () => {
    for (const required of ['PGUSER', 'PGDATABASE', 'PGPASSWORD', 'PGHOST', 'PGPORT']) {
      assert.ok(
        REFUSED_CONNECTION_ENV_VARS.includes(required),
        `${required} must stay in REFUSED_CONNECTION_ENV_VARS`,
      );
    }
  });

  it('accepts an empty variable', () => {
    for (const variable of REFUSED_CONNECTION_ENV_VARS) {
      assert.equal(connectionTargetEnvProblem({ [variable]: '' }), null);
    }
  });

  it('never prints a credential-looking value', () => {
    const problem = connectionTargetEnvProblem({ PGPASSWORD: `${MARKER}-pw`, PGUSER: `${MARKER}-user` });
    assert.notEqual(problem, null);
    assert.ok(!problem!.includes(MARKER));
  });
});

// ---------------------------------------------------------------------------
// 4. TLS environment-variable refusals (pure)
// ---------------------------------------------------------------------------

describe('TLS environment overrides are refused', () => {
  it('accepts a clean environment', () => {
    assert.equal(tlsEnvProblem({ PATH: '/usr/bin', HOME: '/root' }), null);
    assert.equal(tlsEnvProblem({ NODE_TLS_REJECT_UNAUTHORIZED: '1' }), null);
  });

  // Driven from the exported constant, so a name added to the refusal list can
  // never be silently untested.
  for (const variable of REFUSED_TLS_ENV_VARS) {
    it(`refuses ${variable}`, () => {
      const value = variable === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : 'x';
      const problem = tlsEnvProblem({ [variable]: value });
      assert.notEqual(problem, null, `expected a refusal for ${variable}`);
      assert.match(problem!, new RegExp(variable));
    });
  }

  it('covers every libpq TLS override, including the password and CRL directory', () => {
    // Named explicitly: these two were missing from the hand-written matrix.
    for (const required of ['PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLPASSWORD', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGSSLNEGOTIATION', 'PGREQUIRESSL', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
      assert.ok(REFUSED_TLS_ENV_VARS.includes(required), `${required} must stay in REFUSED_TLS_ENV_VARS`);
    }
    assert.notEqual(tlsEnvProblem({ PGSSLPASSWORD: 'x' }), null);
    assert.notEqual(tlsEnvProblem({ PGSSLCRLDIR: '/tmp' }), null);
  });

  it('accepts these variables when they are empty', () => {
    for (const variable of REFUSED_TLS_ENV_VARS) {
      if (variable === 'NODE_TLS_REJECT_UNAUTHORIZED') continue;
      assert.equal(tlsEnvProblem({ [variable]: '' }), null, `an empty ${variable} is not an override`);
    }
  });
});

// ---------------------------------------------------------------------------
// 7 + 10. Safety verdict (pure, fail-closed)
// ---------------------------------------------------------------------------

/** Every canonical privilege answered with an explicit `false`. */
function allPrivilegesFalse(): Record<string, boolean | null> {
  const map: Record<string, boolean | null> = {};
  for (const label of Object.keys(WRITE_PRIVILEGE_COLUMNS)) map[label] = false;
  return map;
}

function safeFacts(): Parameters<typeof evaluateSafety>[0] {
  return {
    defaultTransactionReadOnly: 'on',
    transactionReadOnly: 'on',
    isSuperuser: 'off',
    writePrivileges: allPrivilegesFalse(),
  };
}

describe('evaluateSafety fails closed', () => {
  it('passes only when every fact is safe', () => {
    const verdict = evaluateSafety(safeFacts());
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.violations, []);
  });

  it("refuses a session whose default_transaction_read_only is not 'on'", () => {
    for (const value of ['off', '', 'unknown']) {
      const verdict = evaluateSafety({ ...safeFacts(), defaultTransactionReadOnly: value });
      assert.equal(verdict.ok, false, `expected a refusal for '${value}'`);
      assert.ok(verdict.violations.some((v) => v.includes('default_transaction_read_only')));
    }
  });

  it("refuses a transaction whose transaction_read_only is not 'on'", () => {
    const verdict = evaluateSafety({ ...safeFacts(), transactionReadOnly: 'off' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.violations.some((v) => v.includes('transaction_read_only')));
  });

  it('refuses a superuser role', () => {
    const verdict = evaluateSafety({ ...safeFacts(), isSuperuser: 'on' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.violations.some((v) => v.includes('superuser')));
  });

  it("accepts is_superuser only when it is exactly 'off'", () => {
    for (const value of ['', 'of', 'off ', 'unknown', 'null', 'undefined', 'false', '0', 'OFF ']) {
      const verdict = evaluateSafety({ ...safeFacts(), isSuperuser: value });
      assert.equal(verdict.ok, false, `is_superuser='${value}' must be refused`);
      assert.ok(
        verdict.violations.some((v) => v.includes('superuser status could not be established')),
        `expected an "unestablished superuser" violation for '${value}', got: ${verdict.violations.join('; ')}`,
      );
    }
    assert.equal(evaluateSafety({ ...safeFacts(), isSuperuser: 'off' }).ok, true);
  });

  it('refuses a null-derived is_superuser answer', () => {
    // factsFromConnectionRow maps a missing/non-string answer to ''.
    const facts = factsFromConnectionRow({ default_tx_read_only: 'on', tx_read_only: 'on' });
    assert.equal(facts.isSuperuser, '');
    assert.equal(evaluateSafety(facts).ok, false);
  });

  it('refuses every write privilege and names it', () => {
    for (const label of ['INSERT on setups', 'UPDATE on strategies', 'DELETE on setups']) {
      const verdict = evaluateSafety({ ...safeFacts(), writePrivileges: { [label]: true } });
      assert.equal(verdict.ok, false, `expected a refusal for ${label}`);
      assert.ok(verdict.violations.some((v) => v.includes(label)));
    }
  });

  it('refuses a privilege answered with null instead of an explicit false', () => {
    for (const label of Object.keys(WRITE_PRIVILEGE_COLUMNS)) {
      const facts = safeFacts();
      facts.writePrivileges[label] = null;
      const verdict = evaluateSafety(facts);
      assert.equal(verdict.ok, false, `null for '${label}' must be refused`);
      assert.ok(
        verdict.violations.some((v) => v.includes(label) && v.includes('not answered with an explicit false')),
        `expected a "not answered with an explicit false" violation naming '${label}', got: ${verdict.violations.join('; ')}`,
      );
    }
  });

  it('refuses a privilege whose answer is missing entirely (no vacuous pass)', () => {
    const facts = safeFacts();
    delete facts.writePrivileges['INSERT on setups'];
    const verdict = evaluateSafety(facts);
    assert.equal(verdict.ok, false, 'an absent privilege answer must not pass');
    assert.ok(verdict.violations.some((v) => v.includes('INSERT on setups') && v.includes('missing')));
  });

  it('refuses an undefined privilege answer', () => {
    const facts = safeFacts();
    facts.writePrivileges['UPDATE on strategies'] = undefined as unknown as null;
    const verdict = evaluateSafety(facts);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.violations.some((v) => v.includes('UPDATE on strategies') && v.includes('missing')));
  });

  it('refuses a non-boolean privilege answer', () => {
    const facts = safeFacts();
    facts.writePrivileges['DELETE on setups'] = 'false' as unknown as boolean;
    const verdict = evaluateSafety(facts);
    assert.equal(verdict.ok, false, "the string 'false' is not an explicit false");
    assert.ok(verdict.violations.some((v) => v.includes('DELETE on setups') && v.includes('string')));
  });

  it('refuses a whole privilege map that is missing', () => {
    const facts = safeFacts();
    delete (facts as { writePrivileges?: unknown }).writePrivileges;
    const verdict = evaluateSafety(facts);
    assert.equal(verdict.ok, false, 'a missing privilege map must not pass vacuously');
  });

  it('refuses an unrecognised privilege entry that is not false', () => {
    const facts = safeFacts();
    facts.writePrivileges['TRUNCATE on candles'] = true;
    const verdict = evaluateSafety(facts);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.violations.some((v) => v.includes('TRUNCATE on candles')));
  });
});

// ---------------------------------------------------------------------------
// M3. Unambiguous selection
// ---------------------------------------------------------------------------

const strategyRow = (id: string, name: string) => ({
  id,
  name,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  version_count: 8,
  match_reason: 'test',
});

describe('strategy selection never picks the first match', () => {
  it('recognises a UUID', () => {
    assert.equal(isStrategyUuid('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), true);
    assert.equal(isStrategyUuid('gold'), false);
    assert.equal(isStrategyUuid('3f2504e0-4f89-11d3-9a0c'), false);
  });

  it('returns none for no match', () => {
    assert.deepEqual(chooseStrategy([], 'gold'), { kind: 'none' });
  });

  it('returns the single match', () => {
    const row = strategyRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gold Break & Retest Test Pro VI');
    const choice = chooseStrategy([row], 'Gold Break & Retest Test Pro VI');
    assert.equal(choice.kind, 'ok');
    if (choice.kind === 'ok') assert.equal(choice.row.id, row.id);
  });

  it('refuses when several strategies match, and lists them', () => {
    const rows = [
      strategyRow('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Gold Break & Retest Test Pro VI'),
      strategyRow('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Gold Break & Retest Test Pro VII'),
    ];
    const choice = chooseStrategy(rows, 'Gold Break & Retest');
    assert.equal(choice.kind, 'ambiguous');
    if (choice.kind === 'ambiguous') {
      assert.equal(choice.names.length, 2);
      assert.match(choice.names.join('\n'), /Gold Break & Retest Test Pro VI/);
    }
  });

  it('refuses duplicate version numbers instead of taking the first', () => {
    const versions = [
      { id: 'v1', strategy_id: 's', version_number: 8, status: 'published', published_at: null, changelog: null },
      { id: 'v2', strategy_id: 's', version_number: 8, status: 'draft', published_at: null, changelog: null },
    ];
    const choice = chooseVersion(versions, 8);
    assert.equal(choice.kind, 'ambiguous');
    if (choice.kind === 'ambiguous') assert.equal(choice.ids.length, 2);
  });

  it('returns none / ok for the normal cases', () => {
    assert.deepEqual(chooseVersion([], 8), { kind: 'none' });
    const single = [
      { id: 'v8', strategy_id: 's', version_number: 8, status: 'published', published_at: null, changelog: null },
    ];
    const choice = chooseVersion(single, 8);
    assert.equal(choice.kind, 'ok');
    if (choice.kind === 'ok') assert.equal(choice.version.id, 'v8');
  });

  it('has no implicit strategy default', () => {
    assert.equal(parseOptions([]).strategy, '');
    assert.equal(parseOptions(['--strategy', 'abc']).strategy, 'abc');
    assert.equal(parseOptions(['--strategy', 'abc', '--version', '8']).version, 8);
  });

  it('refuses every invalid --version instead of falling back to 8', () => {
    for (const value of [
      'abc',
      '9x',
      '0',
      '-3',
      '-0',
      '8.5',
      '',
      ' ',
      '1e3',
      '+8',
      '08x',
      '0x10',
      'Infinity',
      'NaN',
      // Digit-only, but not a safe JavaScript integer:
      String(Number.MAX_SAFE_INTEGER + 1), // 9007199254740992
      '99999999999999999999',
      '9'.repeat(400),
    ]) {
      assert.throws(
        () => parseOptions(['--strategy', 's', '--version', value]),
        OptionError,
        `--version '${value}' must be refused`,
      );
    }
    // A bare `--version` with no value is refused too.
    assert.throws(() => parseOptions(['--strategy', 's', '--version']), OptionError);
  });

  it('accepts a valid --version and still defaults when the flag is absent', () => {
    assert.equal(parseOptions(['--strategy', 's', '--version', '9']).version, 9);
    assert.equal(parseOptions(['--strategy', 's', '--version', '12']).version, 12);
    assert.equal(parseOptions(['--strategy', 's', '--version', '0012']).version, 12);
    // The largest safe integer is accepted; one more is not.
    assert.equal(
      parseOptions(['--strategy', 's', '--version', String(Number.MAX_SAFE_INTEGER)]).version,
      Number.MAX_SAFE_INTEGER,
    );
    assert.equal(parseOptions(['--strategy', 's']).version, 8);
  });

  it('every accepted version is a safe integer', () => {
    for (const value of ['1', '8', '12', String(Number.MAX_SAFE_INTEGER)]) {
      assert.ok(Number.isSafeInteger(parseOptions(['--strategy', 's', '--version', value]).version));
    }
  });
});

describe('the duplicate-version refusal is multiline', () => {
  it('puts each colliding version on its own line', () => {
    const ids = [
      'aaaa0000-0000-0000-0000-000000000001',
      'aaaa0000-0000-0000-0000-000000000002',
      'aaaa0000-0000-0000-0000-000000000003',
    ];
    const message = versionAmbiguityMessage('Gold Break & Retest Test Pro VI', 8, ids);
    const lines = message.split('\n');

    assert.equal(lines.length, ids.length + 2, `expected ${ids.length + 2} lines, got:\n${message}`);
    assert.match(lines[0]!, /has 3 versions numbered 8/);
    assert.equal(lines[1], `  - ${ids[0]}`);
    assert.equal(lines[2], `  - ${ids[1]}`);
    assert.equal(lines[3], `  - ${ids[2]}`);
    assert.match(lines[4]!, /select a version that is unique/);
    // No literal escape sequence survived (the defect this replaces).
    assert.ok(!message.includes('\\n'), 'the message still contains a literal backslash-n');
    assert.ok(!message.includes('\\'), 'the message still contains a literal backslash');
  });
});

// ---------------------------------------------------------------------------
// 8. Redaction and scrubbing (pure)
// ---------------------------------------------------------------------------

describe('redaction and output scrubbing', () => {
  it('removes connection strings, passwords, bearer tokens and e-mails', () => {
    const text = [
      'connect postgres://user:s3cret@db.internal:5432/app failed',
      'password=s3cret',
      'Authorization: Bearer abc.def.ghi',
      'contact ops@example.com',
    ].join(' | ');
    const cleaned = redact(text);
    assert.ok(!cleaned.includes('s3cret'));
    assert.ok(!cleaned.includes('postgres://'));
    assert.ok(!cleaned.includes('abc.def.ghi'));
    assert.ok(!cleaned.includes('ops@example.com'));
  });

  it('scrubs literal secret values, encoded and decoded', () => {
    const url = 'postgres://u:p%40ssw0rd@h:5432/db';
    const values = secretValuesFrom(url);
    assert.ok(values.includes(url));
    assert.ok(values.includes('p%40ssw0rd'));
    assert.ok(values.includes('p@ssw0rd'));
    const scrubbed = scrubSecrets(`boom ${url} and p@ssw0rd here`, values);
    assert.ok(!scrubbed.includes(url));
    assert.ok(!scrubbed.includes('p@ssw0rd'));
  });

  it('walks nested objects, arrays and keys', () => {
    const value = { a: [{ b: 'x' }], nested: { [`k${MARKER}`]: 'v' } };
    const mapped = mapStrings(value, (s) => s.replace(MARKER, 'GONE'));
    assert.ok(!JSON.stringify(mapped).includes(MARKER));
    const seen = mapStrings({ deep: [{ s: MARKER }] }, (s) => s);
    assert.equal(anyStringLeaks(seen, []), false, 'clean values with no secret list are not leaks');
    assert.equal(anyStringLeaks({ deep: [{ s: `x ${MARKER}` }] }, [MARKER]), true);
  });

  it('detects a leak nested inside the evidence structure', () => {
    const evidence = { setups: { latest: [{ note: `oops ${MARKER}` }] } };
    assert.equal(anyStringLeaks(evidence, [MARKER]), true);
    const cleaned = mapStrings(evidence, (s) => scrubSecrets(s, [MARKER]));
    assert.equal(anyStringLeaks(cleaned, [MARKER]), false);
  });
});

// ---------------------------------------------------------------------------
// 9. Driver errors never carry credential material
// ---------------------------------------------------------------------------

describe('driver errors are reduced to a code', () => {
  it('passes through short codes only', () => {
    assert.equal(errorCodeOf({ code: '28P01' }), '28P01');
    assert.equal(errorCodeOf({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
    assert.equal(errorCodeOf({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('reduces anything that could carry text to UNKNOWN', () => {
    for (const bad of [undefined, null, {}, { code: '' }, { code: 42 }, { code: 'postgres://u:p@h/db' }, { code: 'a'.repeat(64) }]) {
      assert.equal(errorCodeOf(bad), 'UNKNOWN');
    }
  });
});

// ---------------------------------------------------------------------------
// Additional hardening: Markdown injection
// ---------------------------------------------------------------------------

describe('report rendering resists fence and table injection', () => {
  const HOSTILE_SELECTOR = 'pipe|column';
  const HOSTILE_TEXT = 'row1\nrow2 ```json {"x":1} ``` `tick`';
  // Backslashes BEFORE the pipe are the interesting case: `\|` in the source
  // data must still end up as an escaped pipe (`\\\|`), never as an even
  // number of backslashes that would let the pipe act as a delimiter again.
  const HOSTILE_ROLE = 'entry|exit';
  const HOSTILE_TIMEFRAME = '4H\n```json `4H`';
  const HOSTILE_BACKSLASH_ROLE = 'entry\\|exit';
  const HOSTILE_BACKSLASH_TIMEFRAME = '4H\\\\|1H';

  /** A minimal but complete Evidence object with hostile DB text in both tables. */
  function evidenceWithHostileRows(): Parameters<typeof renderMarkdown>[0] {
    return {
      generatedAt: '2026-01-01T00:00:00.000Z',
      target: { strategy: HOSTILE_SELECTOR, version: 8, symbol: 'XAUUSD', assetClass: 'commodity', outDir: 'o' },
      safety: {
        connectionOpenedWithDefaultTransactionReadOnly: true,
        everyQueryRanInsideBeginReadOnly: true,
        secretsRedacted: true,
      },
      declaredNotVerified: { triggersNothing: ['no ScannerService'] },
      connection: {
        database: 'db',
        serverVersion: 'PostgreSQL 16',
        tlsRequestedMode: 'verify-full',
        tlsClient: {
          encrypted: true,
          authorized: true,
          authorizationError: null,
          protocol: 'TLSv1.3',
          cipher: 'TLS_AES_256_GCM_SHA384',
          servername: 'db.example.test',
          peerCertificateSha256: 'AA:BB',
          peerCertificateSubject: 'CN=db.example.test',
          peerCertificateIssuer: 'CN=test-ca',
          peerCertificateValidTo: 'Jan  1 00:00:00 2030 GMT',
        },
        tlsVerified: true,
        pooledEndpoint: false,
        tlsNote: null,
        ssl: true,
        defaultTransactionReadOnly: 'on',
        transactionReadOnly: 'on',
        isSuperuser: 'off',
        statementTimeout: '30s',
        privileges: { [HOSTILE_SELECTOR]: false, 'INSERT on setups': false },
      },
      migrations: [
        { version: 1, name: `0001|init\n\`\`\``, applied_at: '2026-01-01T00:00:00.000Z' },
        { version: 2, name: '0002\\|backslash', applied_at: '2026-01-02T00:00:00.000Z' },
      ],
      candidateStrategies: [
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          name: HOSTILE_TEXT,
          status: 'active',
          created_at: '2026-01-01T00:00:00.000Z',
          version_count: 1,
          match_reason: `matched by exact strategy name | ${HOSTILE_SELECTOR}`,
        },
      ],
      versions: [
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          strategy_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          version_number: 8,
          status: 'published',
          published_at: '2026-01-01T00:00:00.000Z',
          changelog: HOSTILE_TEXT,
        },
      ],
      v8: { found: true, id: 'v8-id', status: 'published', publishedAt: null, changelog: null },
      timeframes: [
        { role: HOSTILE_ROLE, timeframe: HOSTILE_TIMEFRAME },
        { role: HOSTILE_BACKSLASH_ROLE, timeframe: HOSTILE_BACKSLASH_TIMEFRAME },
        { role: 'entry', timeframe: '4H' },
      ],
      risk: null,
      marketScope: null,
      conditions: [],
      conditionRoleResolution: [
        {
          conditionId: 'c1',
          conditionType: `liquidity_sweep|sweep\n\`x\``,
          storedTimeframeRole: HOSTILE_ROLE,
          resolvedRole: 'entry',
          resolvedTimeframe: HOSTILE_TIMEFRAME,
          roleTimeframeRowPresent: true,
          is4h: false,
          storedAnchorOffsetCandles: { nested: 'a|b' },
          storedAnchorOffsetType: 'object',
          effectiveAnchorOffsetCandles: 3,
          classification: 'a|b',
          group: 'liquidity|group',
          groupLogic: 'AND|OR',
          params: null,
          lookbackCandles: 120,
          deepestDeclaredRead: 123,
          candlesStoredForRole: 500,
        },
      ],
      liquiditySweepFocus: { count: 0, entries: [] },
      sessionFilters: [],
      filters: [],
      instrument: null,
      candleCoverage: [
        {
          timeframe: HOSTILE_ROLE,
          candles: 500,
          first_ts: '1700000000000',
          last_ts: '1700003600000',
          last_fetched_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      setups: {
        total: 1,
        byState: [{ state: `active|waiting\n\`x\``, setups: 1 }],
        latest: [],
        scores: [],
        stateEvents: [],
      },
      alerts: [],
      alertDeliveries: [],
      notificationDeliveries: [],
      scannerRuns: [],
      scannerCursors: [],
      notes: [],
    } as unknown as Parameters<typeof renderMarkdown>[0];
  }

  /** Consecutive `|`-prefixed lines form one table block. */
  function tableBlocks(md: string): string[][] {
    const blocks: string[][] = [];
    let current: string[] = [];
    for (const line of md.split('\n')) {
      if (line.startsWith('|')) {
        current.push(line);
      } else if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
    }
    if (current.length > 0) blocks.push(current);
    return blocks;
  }

  /** A `\|` inside a cell is not a column separator. */
  const columnCount = (row: string): number => row.split(/(?<!\\)\|/).length - 1;

  /** The same shape, with benign values — the baseline for column counts. */
  function evidenceWithCleanRows(): Parameters<typeof renderMarkdown>[0] {
    return {
      generatedAt: '2026-01-01T00:00:00.000Z',
      target: { strategy: 'Gold Break & Retest Test Pro VI', version: 8, symbol: 'XAUUSD', assetClass: 'commodity', outDir: 'o' },
      safety: {
        connectionOpenedWithDefaultTransactionReadOnly: true,
        everyQueryRanInsideBeginReadOnly: true,
        secretsRedacted: true,
      },
      declaredNotVerified: { triggersNothing: ['no ScannerService'] },
      connection: {
        database: 'db',
        serverVersion: 'PostgreSQL 16',
        tlsRequestedMode: 'verify-full',
        tlsClient: {
          encrypted: true,
          authorized: true,
          authorizationError: null,
          protocol: 'TLSv1.3',
          cipher: 'TLS_AES_256_GCM_SHA384',
          servername: 'db.example.test',
          peerCertificateSha256: 'AA:BB',
          peerCertificateSubject: 'CN=db.example.test',
          peerCertificateIssuer: 'CN=test-ca',
          peerCertificateValidTo: 'Jan  1 00:00:00 2030 GMT',
        },
        tlsVerified: true,
        pooledEndpoint: false,
        tlsNote: null,
        ssl: true,
        defaultTransactionReadOnly: 'on',
        transactionReadOnly: 'on',
        isSuperuser: 'off',
        statementTimeout: '30s',
        privileges: { 'INSERT on setups': false, 'UPDATE on strategies': false },
      },
      migrations: [
        { version: 1, name: '0001_init', applied_at: '2026-01-01T00:00:00.000Z' },
        { version: 2, name: '0002_second', applied_at: '2026-01-02T00:00:00.000Z' },
      ],
      candidateStrategies: [
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          name: 'Gold Break & Retest Test Pro VI',
          status: 'active',
          created_at: '2026-01-01T00:00:00.000Z',
          version_count: 1,
          match_reason: 'matched by exact strategy name',
        },
      ],
      versions: [
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          strategy_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          version_number: 8,
          status: 'published',
          published_at: '2026-01-01T00:00:00.000Z',
          changelog: 'initial',
        },
      ],
      v8: { found: true, id: 'v8-id', status: 'published', publishedAt: null, changelog: null },
      timeframes: [
        { role: 'entry', timeframe: '4H' },
        { role: 'exit', timeframe: '1H' },
        { role: 'trend', timeframe: '1D' },
      ],
      risk: null,
      marketScope: null,
      conditions: [],
      conditionRoleResolution: [
        {
          conditionId: 'c1',
          conditionType: 'liquidity_sweep',
          storedTimeframeRole: 'entry',
          resolvedRole: 'entry',
          resolvedTimeframe: '4H',
          roleTimeframeRowPresent: true,
          is4h: true,
          storedAnchorOffsetCandles: 2,
          storedAnchorOffsetType: 'number',
          effectiveAnchorOffsetCandles: 2,
          classification: 'liquidity',
          group: 'group-1',
          groupLogic: 'AND',
          params: null,
          lookbackCandles: 120,
          deepestDeclaredRead: 122,
          candlesStoredForRole: 500,
        },
      ],
      liquiditySweepFocus: { count: 0, entries: [] },
      sessionFilters: [],
      filters: [],
      instrument: null,
      candleCoverage: [
        {
          timeframe: '4H',
          candles: 500,
          first_ts: '1700000000000',
          last_ts: '1700003600000',
          last_fetched_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      setups: {
        total: 1,
        byState: [{ state: 'active', setups: 1 }],
        latest: [],
        scores: [],
        stateEvents: [],
      },
      alerts: [],
      alertDeliveries: [],
      notificationDeliveries: [],
      scannerRuns: [],
      scannerCursors: [],
      notes: [],
    } as unknown as Parameters<typeof renderMarkdown>[0];
  }

  it('keeps every table rectangular and fence-free with hostile values', () => {
    const md = renderMarkdown(evidenceWithHostileRows());
    const blocks = tableBlocks(md);

    // 9 data/summary tables + the static status-semantics table (section 9).
    assert.equal(blocks.length, 10, `expected 10 tables, got ${blocks.length}`);
    for (const block of blocks) {
      const header = block[0]!;
      const expected = columnCount(header);
      assert.ok(expected >= 2, `table header has no columns: ${header}`);
      for (const row of block.slice(1)) {
        assert.equal(
          columnCount(row),
          expected,
          `table row does not match its ${expected}-column header: ${row}`,
        );
        assert.ok(!row.includes('```'), `a fence sequence survived in a row: ${row}`);
        assert.ok(!/[\r\n]/.test(row), `a raw newline survived in a row: ${row}`);
      }
    }

    // The hostile payload must not survive as a real fence anywhere; the only
    // fences in the report are the legitimate `jsonBlock` sections.
    assert.ok(!md.includes('```json {"x":1}'), 'the hostile fence payload survived');
    assert.ok(md.includes("'''json"), 'the hostile backticks were not neutralised');
    assert.equal(
      md.split('\n').filter((l) => /^```/.test(l)).length % 2,
      0,
      'fences must stay balanced',
    );
  });

  it('escapes pipes, newlines and backticks in the role -> timeframe table', () => {
    const md = renderMarkdown(evidenceWithHostileRows());
    const row = md.split('\n').find((l) => /^\| entry\\\|exit \|/.test(l));
    assert.ok(row, 'the role/timeframe row should still be rendered');

    assert.equal(columnCount(row!), 3, `expected 2 columns: ${row}`);
    assert.ok(row!.includes('entry\\|exit'), 'the role pipe was not escaped');
    assert.ok(!row!.includes('entry|exit'), 'an unescaped pipe reached the table');
    assert.ok(row!.includes("4H '''json"), 'the timeframe newline was not collapsed');
    assert.ok(!row!.includes('`4H`'), 'a code span survived in a cell');
    assert.ok(!row!.includes('```'), 'a fence sequence survived in a cell');
    assert.ok(!md.includes('entry|exit'), 'an unescaped pipe appears anywhere in the report');
  });

  it('escapes backslashes before pipes so a pipe can never become a delimiter', () => {
    // 0, 1, 2 and 3 literal backslashes in front of a pipe. Escaping `|` alone
    // turned `a\|b` into `a\\|b` — an EVEN count, where Markdown reads `\\` as
    // an escaped backslash and lets the pipe split the cell.
    const samples: Array<[number, string]> = [
      [0, 'a|b'],
      [1, 'a\\|b'],
      [2, 'a\\\\|b'],
      [3, 'a\\\\\\|b'],
    ];

    for (const [inputBackslashes, input] of samples) {
      const out = mdCell(input);
      const runs = [...out.matchAll(/\\*\|/g)];
      assert.equal(runs.length, 1, `expected exactly one pipe in ${JSON.stringify(out)}`);
      const beforePipe = runs[0]![0].length - 1;
      assert.equal(
        beforePipe,
        inputBackslashes * 2 + 1,
        `expected ${inputBackslashes * 2 + 1} backslashes before the pipe in ${JSON.stringify(out)}`,
      );
      assert.equal(beforePipe % 2, 1, `even backslash count lets the pipe delimit: ${JSON.stringify(out)}`);
      // Exactly one escape backslash per original backslash, plus the pipe escape.
      assert.equal(out, `a${'\\'.repeat(inputBackslashes * 2 + 1)}|b`);
    }

    // The reported case, verbatim.
    assert.equal(mdCell('a\\|b'), 'a\\\\\\|b');
    // And the other protections are unchanged.
    assert.equal(mdCell('a|b'), 'a\\|b');
    assert.equal(mdCell('x\ny'), 'x y');
    assert.equal(mdCell('`t`'), "'t'");
    // A backslash with no pipe is doubled too, so it renders literally.
    assert.equal(mdCell('C:\\path'), 'C:\\\\path');
  });

  it('hostile values never change the number of columns in any table', () => {
    const hostile = tableBlocks(renderMarkdown(evidenceWithHostileRows()));
    const clean = tableBlocks(renderMarkdown(evidenceWithCleanRows()));

    assert.equal(hostile.length, clean.length, 'the same tables must be rendered');
    hostile.forEach((block, index) => {
      assert.deepEqual(
        block.map((row) => columnCount(row)),
        clean[index]!.map((row) => columnCount(row)),
        `table ${index + 1} changed shape under hostile input`,
      );
    });
  });

  /**
   * The clean fixture with hostile text in every NON-table position: the
   * connection bullets, the inline code spans, the v8 bullets, the notes and the
   * declared-intent list. These are rendered as ordinary Markdown text, not as
   * table cells, so they were the remaining place a value could restructure the
   * report.
   */
  function evidenceWithInjectedText(): Parameters<typeof renderMarkdown>[0] {
    const injected = 'x`\n## 9. INJECTED SECTION\n# INJECTED HEADING\n```\n`y';
    const clean = evidenceWithCleanRows();
    return {
      ...clean,
      connection: {
        ...(clean.connection as NonNullable<Parameters<typeof renderMarkdown>[0]['connection']>),
        database: injected,
        serverVersion: `PostgreSQL 16 ${injected}`,
        statementTimeout: injected,
      },
      v8: { found: true, id: injected, status: injected, publishedAt: injected, changelog: null },
      notes: [`note ${injected}`],
      declaredNotVerified: { triggersNothing: [`intent ${injected}`] },
    } as unknown as Parameters<typeof renderMarkdown>[0];
  }

  it('database text cannot add a heading, a fence or a new line', () => {
    const clean = renderMarkdown(evidenceWithCleanRows());
    const hostile = renderMarkdown(evidenceWithInjectedText());

    const headings = (md: string): string[] => md.split('\n').filter((l) => /^#{1,6} /.test(l));
    const fences = (md: string): string[] => md.split('\n').filter((l) => /^`{3,}/.test(l));

    assert.deepEqual(headings(hostile), headings(clean), 'a database value added or removed a Markdown heading');
    assert.deepEqual(fences(hostile), fences(clean), 'a database value added or removed a fence');
    assert.equal(tableBlocks(hostile).length, tableBlocks(clean).length, 'a database value added a table');

    const lines = hostile.split('\n');
    // Fences are compared above; these two are the headings the value tried to
    // create. Neither may appear at the start of any line.
    for (const injectedLine of ['## 9. INJECTED SECTION', '# INJECTED HEADING']) {
      assert.ok(
        !lines.some((line) => line.startsWith(injectedLine)),
        `an injected value began a line with ${JSON.stringify(injectedLine)}`,
      );
    }
    // The value is still readable: the text survives, only the markup does not.
    assert.ok(
      hostile.includes("- Database: `x' ## 9. INJECTED SECTION"),
      'the database name stopped being readable after neutralisation',
    );
  });

  it('mdText neutralises backticks and newlines and keeps the value readable', () => {
    assert.equal(mdText('a`b'), "a'b");
    assert.equal(mdText('a\nb\r\nc'), 'a b c');
    assert.equal(mdText('```json\n{"x":1}\n```'), "'''json {\"x\":1} '''");
    assert.equal(mdText(null), '');
    assert.equal(mdText(undefined), '');
    assert.equal(mdText(0), '0');
    assert.equal(mdText('plain value'), 'plain value');
  });

  it('mdCode keeps code-span content literal while neutralising the span delimiters', () => {
    // Inside an inline code span HTML is not parsed and a pipe is not a separator,
    // so nothing else is escaped — the value stays exactly readable.
    assert.equal(mdCode('a`b'), "a'b");
    assert.equal(mdCode('a\nb\r\nc'), 'a b c');
    assert.equal(mdCode('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
    assert.equal(mdCode('A & B | C'), 'A & B | C');
    assert.equal(mdCode(null), '');
    assert.equal(mdCode(0), '0');
  });

  it('mdText and mdCell escape the three HTML-sensitive characters, ampersand first', () => {
    // Ampersand first, so the entities this inserts are not escaped again.
    assert.equal(mdText('a & b <c> d'), 'a &amp; b &lt;c&gt; d');
    assert.equal(mdText('&lt;'), '&amp;lt;');
    assert.equal(mdText('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    // Table cells escape HTML too, without losing the pipe/backslash guarantees.
    assert.equal(mdCell('<b>x</b> & y'), '&lt;b&gt;x&lt;/b&gt; &amp; y');
    assert.equal(mdCell('a|b'), 'a\\|b');
    assert.equal(mdCell('a\\|b'), 'a\\\\\\|b');
  });

  it('raw HTML in database text cannot become a live element', () => {
    // The benign twin has IDENTICAL shapes, so any structural difference between
    // the two renders comes from the hostile value and nothing else.
    const withValue = (v: string): Parameters<typeof renderMarkdown>[0] => {
      const clean = evidenceWithCleanRows();
      return {
        ...clean,
        connection: {
          ...(clean.connection as NonNullable<Parameters<typeof renderMarkdown>[0]['connection']>),
          database: v,
          serverVersion: `PostgreSQL ${v}`,
          statementTimeout: v,
        },
        v8: { found: true, id: v, status: v, publishedAt: v, changelog: null },
        notes: [`note ${v}`],
        declaredNotVerified: { triggersNothing: [`intent ${v}`] },
        migrations: [{ version: 1, name: v, applied_at: '2026-01-01T00:00:00.000Z' }],
        candidateStrategies: [
          {
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: v,
            status: v,
            created_at: '2026-01-01T00:00:00.000Z',
            version_count: 1,
            match_reason: v,
          },
        ],
        versions: [
          {
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            strategy_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            version_number: 8,
            status: v,
            published_at: v,
            changelog: v,
          },
        ],
      } as unknown as Parameters<typeof renderMarkdown>[0];
    };

    const hostileHtml = '<img src=x onerror=alert(1)>';
    const cleanMd = renderMarkdown(withValue('benign'));
    const md = renderMarkdown(withValue(hostileHtml));

    // Nowhere in the report may a raw element appear: table cells and ordinary
    // text are escaped; inline code spans keep the value literally, and a code
    // span is not HTML, so that is safe.
    const tableText = md.split('\n').filter((l) => l.startsWith('|')).join('\n');
    const nonCodeText = md
      .split('\n')
      .map((l) => (l.startsWith('|') ? '' : l.replace(/`[^`]*`/g, '')))
      .join('\n');
    assert.ok(!tableText.includes('<img'), 'a raw element survived in a table row');
    assert.ok(!nonCodeText.includes('<img'), 'a raw element survived in plain report text');
    assert.ok(md.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the value stopped being readable after escaping');
    assert.ok(md.includes('`<img src=x onerror=alert(1)>`'), 'a code span lost its literal value');

    // Structure is untouched: same headings, fences, tables and list items.
    const headings = (m: string): string[] => m.split('\n').filter((l) => /^#{1,6} /.test(l));
    const fences = (m: string): string[] => m.split('\n').filter((l) => /^`{3,}/.test(l));
    const bullets = (m: string): number => m.split('\n').filter((l) => /^[-*] /.test(l)).length;
    assert.deepEqual(headings(md), headings(cleanMd), 'a hostile HTML value changed the headings');
    assert.deepEqual(fences(md), fences(cleanMd), 'a hostile HTML value changed the fences');
    assert.equal(tableBlocks(md).length, tableBlocks(cleanMd).length, 'a hostile HTML value changed the tables');
    assert.equal(bullets(md), bullets(cleanMd), 'a hostile HTML value changed the bullet list');
  });

  it('mdText and mdCell neutralise Markdown links, images and emphasis', () => {
    // Links and images: the `[` and `]` are backslash-escaped, so nothing can
    // pair with `](` to form a link or an image — whatever the scheme.
    assert.equal(mdText('[label](https://example.com)'), '\\[label\\](https://example.com)');
    assert.equal(mdText('[label](javascript:alert(1))'), '\\[label\\](javascript:alert(1))');
    assert.equal(mdText('![image](https://example.com/image)'), '!\\[image\\](https://example.com/image)');
    // Emphasis, strong and GFM strikethrough.
    assert.equal(mdText('**bold text**'), '\\*\\*bold text\\*\\*');
    assert.equal(mdText('_italic text_'), '\\_italic text\\_');
    assert.equal(mdText('~~gone~~'), '\\~\\~gone\\~\\~');
    // Table cells are inline Markdown too.
    assert.equal(mdCell('[label](https://example.com)'), '\\[label\\](https://example.com)');
    assert.equal(mdCell('![image](https://example.com/image) **bold text** _italic text_'), '!\\[image\\](https://example.com/image) \\*\\*bold text\\*\\* \\_italic text\\_');
  });

  it('a stored backslash cannot cancel the Markdown escapes', () => {
    // The value ends in a backslash, which would otherwise pair with the one this
    // escaping inserts and un-escape the bracket again. Literal backslashes are
    // doubled first, so the rendered text is exactly what was stored.
    assert.equal(mdText('\\[x](y)'), '\\\\\\[x\\](y)');
    assert.equal(mdText('a\\*b'), 'a\\\\\\*b');
    // A value that is only backslashes stays literal.
    assert.equal(mdText('\\\\'), '\\\\\\\\');
    // Same guarantee in a table cell, where the pipe escape also applies.
    assert.equal(mdCell('\\[x](y)|z'), '\\\\\\[x\\](y)\\|z');
  });

  it('Markdown in database text cannot create a link, an image or emphasis', () => {
    // Every active inline construct the review named, plus HTML, a pipe, a
    // backtick and a newline, in one value.
    const payload =
      '[label](https://example.com) [js](javascript:alert(1)) ![image](https://example.com/image) ' +
      '**bold text** _italic text_ ~~strike~~ <b>tag</b> | pipe `tick`\nsecond line';

    const withValue = (v: string): Parameters<typeof renderMarkdown>[0] => {
      const clean = evidenceWithCleanRows();
      return {
        ...clean,
        connection: {
          ...(clean.connection as NonNullable<Parameters<typeof renderMarkdown>[0]['connection']>),
          database: v,
          serverVersion: `PostgreSQL ${v}`,
          statementTimeout: v,
        },
        v8: { found: true, id: v, status: v, publishedAt: v, changelog: null },
        notes: [`PAYLOAD ${v}`],
        declaredNotVerified: { triggersNothing: [`PAYLOAD ${v}`] },
        migrations: [{ version: 1, name: `PAYLOAD ${v}`, applied_at: '2026-01-01T00:00:00.000Z' }],
        candidateStrategies: [
          {
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            name: `PAYLOAD ${v}`,
            status: 'active',
            created_at: '2026-01-01T00:00:00.000Z',
            version_count: 1,
            match_reason: `PAYLOAD ${v}`,
          },
        ],
      } as unknown as Parameters<typeof renderMarkdown>[0];
    };

    const benign = renderMarkdown(withValue('benign value'));
    const md = renderMarkdown(withValue(payload));

    /** True when the character at `i` is escaped by an ODD run of backslashes. */
    const escapedAt = (text: string, i: number): boolean => {
      let n = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n += 1;
      return n % 2 === 1;
    };
    /** Every unescaped `[`, `]`, `*`, `_` or `~` in the given text. */
    const activeMarkup = (text: string): string[] => {
      const found: string[] = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (!'[]*_~'.includes(ch)) continue;
        if (!escapedAt(text, i)) found.push(`${ch} at ${i}: ${text.slice(Math.max(0, i - 20), i + 20)}`);
      }
      return found;
    };

    // Only the lines that carry the hostile value are inspected; the report's own
    // prose legitimately uses `**bold**` for measured booleans.
    const dataLines = md.split('\n').filter((l) => l.includes('PAYLOAD'));
    assert.ok(dataLines.length >= 4, `expected the payload on several lines, got ${dataLines.length}`);

    for (const line of dataLines) {
      // A code span is literal text: its content is not Markdown and is skipped.
      const outsideCodeSpans = line.replace(/`[^`]*`/g, '');
      assert.deepEqual(activeMarkup(outsideCodeSpans), [], `active Markdown survived in: ${line}`);
      assert.ok(!outsideCodeSpans.includes('<b>'), `raw HTML survived in: ${line}`);
    }

    // The values are still readable: the characters are there, only inert.
    assert.ok(md.includes('\\[label\\](https://example.com)'), 'the link text stopped being readable');
    assert.ok(md.includes('!\\[image\\](https://example.com/image)'), 'the image text stopped being readable');
    assert.ok(md.includes('\\*\\*bold text\\*\\*'), 'the emphasis text stopped being readable');
    assert.ok(md.includes('\\_italic text\\_'), 'the italic text stopped being readable');
    assert.ok(md.includes('&lt;b&gt;tag&lt;/b&gt;'), 'the HTML tag stopped being readable');
    // A code span (the database name is rendered in one) keeps the literal value.
    assert.ok(md.includes("`[label](https://example.com) [js](javascript:alert(1))"), 'a code span lost its literal value');

    // Structure is untouched: same headings, fences, tables and bullets.
    const headings = (m: string): string[] => m.split('\n').filter((l) => /^#{1,6} /.test(l));
    const fences = (m: string): string[] => m.split('\n').filter((l) => /^`{3,}/.test(l));
    assert.deepEqual(headings(md), headings(benign), 'the payload changed the headings');
    assert.deepEqual(fences(md), fences(benign), 'the payload changed the fences');
    assert.equal(tableBlocks(md).length, tableBlocks(benign).length, 'the payload changed the tables');
    assert.equal(
      md.split('\n').filter((l) => /^[-*] /.test(l)).length,
      benign.split('\n').filter((l) => /^[-*] /.test(l)).length,
      'the payload changed the bullet list',
    );
    // The pipe in the payload is still escaped inside the table it lands in.
    const tableLines = md.split('\n').filter((l) => l.startsWith('|')).join('\n');
    assert.ok(
      tableLines.includes("\\| pipe 'tick' second line"),
      'the pipe in the payload was not escaped inside the table',
    );
  });

  it('escapes the privileges, migrations, coverage and by-state tables too', () => {
    const md = renderMarkdown(evidenceWithHostileRows());
    // privileges: a hostile key, migrations: a hostile name, coverage: a hostile
    // timeframe, by-state: a hostile state — none may add a column or a fence.
    assert.ok(md.includes('pipe\\|column'), 'privilege key pipe not escaped');
    assert.ok(!md.includes('0001|init'), 'migration name pipe not escaped');
    assert.ok(!md.includes('`x`'), 'by-state backticks survived');
    assert.ok(!md.includes('active|waiting'), 'by-state pipe not escaped');
  });

  it('escapes every dynamic cell in the strategy and version tables', () => {
    const md = renderMarkdown(evidenceWithHostileRows());
    const lines = md.split('\n');

    // A hostile value can neither open a fence inside a table nor add a column.
    assert.equal(
      lines.filter((l) => l.startsWith('|') && l.includes('```')).length,
      0,
      'a fence was injected into a table row',
    );
    assert.ok(!md.includes('```json {"x":1}'), 'the hostile fence payload survived');
    // Table rows must never contain a raw separator. The same value also appears
    // in the Target line's inline code span, where a pipe is literal text and
    // cannot split anything, so the assertion is scoped to the tables.
    const tableLines = md.split('\n').filter((l) => l.startsWith('|')).join('\n');
    assert.ok(!tableLines.includes('pipe|column'), 'an unescaped pipe reached a table row');
    assert.ok(tableLines.includes('pipe\\|column'), 'the pipe was not escaped in the table');

    const strategyRow = lines.find((l) => l.includes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    const versionRow = lines.find((l) => l.includes('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
    assert.ok(strategyRow && versionRow, 'the hostile rows should still be rendered');

    // strategy table: 6 columns (7 separators); version table: 5 (6 separators).
    // A `\|` inside a cell is not a separator.
    const columns = (row: string): number => row.split(/(?<!\\)\|/).length - 1;
    assert.equal(columns(strategyRow!), 7, `strategy row should keep 6 columns, got: ${strategyRow}`);
    assert.equal(columns(versionRow!), 6, `version row should keep 5 columns, got: ${versionRow}`);

    for (const row of [strategyRow!, versionRow!]) {
      assert.ok(row.includes('row1 row2 '), 'the newline in the value was not collapsed');
      assert.ok(!row.includes('```'), 'a fence sequence survived in a cell');
      assert.ok(!row.includes('`tick`'), 'a code span survived in a cell');
    }
  });

  it('mdRow escapes pipes, newlines and backtick runs', () => {
    const row = mdRow(['a|b', 'line1\nline2', '```json', 8, null]);
    assert.equal(row.split(/(?<!\\)\|/).length - 1, 6, 'one separator per column boundary');
    assert.ok(!row.includes('\n'));
    assert.ok(row.includes('a\\|b'));
    assert.ok(row.includes("line1 line2"));
    assert.ok(!row.includes('```'));
    assert.ok(row.endsWith('|  |'), `null becomes an empty cell: ${row}`);
  });

  it('uses a fence longer than any backtick run in the payload', () => {
    const block = jsonBlock({ params: { note: '```json\n{"x":1}\n```' } });
    const lines = block.split('\n');
    assert.match(lines[0]!, /^`{4,}json$/);
    assert.equal(lines[lines.length - 1], '`'.repeat(lines[0]!.length - 4));
  });

  it('keeps a plain payload on a three-backtick fence', () => {
    assert.equal(jsonBlock({ a: 1 }).split('\n')[0], '```json');
  });

  it('escapes table cells', () => {
    assert.equal(mdCell('a|b'), 'a\\|b');
    assert.equal(mdCell('line1\nline2'), 'line1 line2');
    assert.equal(mdCell('`x`'), "'x'");
    assert.equal(mdCell(null), '');
  });
});

// ---------------------------------------------------------------------------
// An earlier report is never overwritten (a refused run cannot look successful)
// ---------------------------------------------------------------------------

/** A minimal but complete evidence object for the writer. */
function minimalEvidence(generatedAt: string): Parameters<typeof renderMarkdown>[0] {
  return {
    generatedAt,
    target: { strategy: 's', version: 8, symbol: 'XAUUSD', assetClass: 'commodity', outDir: 'o' },
    safety: {
      connectionOpenedWithDefaultTransactionReadOnly: true,
      everyQueryRanInsideBeginReadOnly: true,
      secretsRedacted: true,
    },
    declaredNotVerified: { triggersNothing: ['no ScannerService'] },
    connection: null,
    migrations: [],
    candidateStrategies: [],
    versions: [],
    v8: null,
    timeframes: [],
    risk: null,
    marketScope: null,
    conditions: [],
    conditionRoleResolution: [],
    liquiditySweepFocus: { count: 0, entries: [] },
    sessionFilters: [],
    filters: [],
    instrument: null,
    candleCoverage: [],
    setups: { total: 0, byState: [], latest: [], scores: [], stateEvents: [] },
    alerts: [],
    alertDeliveries: [],
    notificationDeliveries: [],
    scannerRuns: [],
    scannerCursors: [],
    notes: [],
  } as unknown as Parameters<typeof renderMarkdown>[0];
}

describe('an existing report is never overwritten', () => {
  it('finds nothing in an empty or missing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-empty-'));
    workDirs.push(dir);
    assert.equal(existingReportProblem(dir), null);
    assert.equal(existingReportProblem(join(dir, 'does-not-exist')), null);
  });

  it('names only the report files that are present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-partial-'));
    workDirs.push(dir);
    const { jsonPath, mdPath } = reportPaths(dir);
    writeFileSync(mdPath, 'old markdown\n');

    const problem = existingReportProblem(dir);
    assert.notEqual(problem, null);
    assert.ok(problem!.includes(mdPath), 'the existing file must be named');
    assert.ok(!problem!.includes(jsonPath), 'a file that is not there must not be named');
    assert.match(problem!, /already exists/);
    // The other file may still be written by a run that owns the directory.
    writeFileSync(jsonPath, 'old json\n');
    assert.ok(existingReportProblem(dir)!.includes(jsonPath));
  });

  it('writes once and then refuses, leaving the report byte-identical', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-write-'));
    workDirs.push(dir);
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me\n');

    const first = writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'));
    const jsonBefore = readFileSync(first.jsonPath, 'utf8');
    const mdBefore = readFileSync(first.mdPath, 'utf8');

    assert.throws(
      () => writeReport(dir, minimalEvidence('2026-02-02T00:00:00.000Z')),
      (err: unknown) => err instanceof ReportWriteError && err.stale === true,
    );
    assert.equal(readFileSync(first.jsonPath, 'utf8'), jsonBefore, 'the first report was overwritten');
    assert.equal(readFileSync(first.mdPath, 'utf8'), mdBefore, 'the first report was overwritten');
    assert.ok(!readFileSync(first.jsonPath, 'utf8').includes('2026-02-02'), 'the second run leaked into the report');
    assert.equal(readFileSync(join(dir, 'unrelated.txt'), 'utf8'), 'keep me\n', 'an unrelated file was touched');
  });

  it('refuses the CLI before connecting when a report already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-cli-stale-'));
    workDirs.push(dir);
    const seeded = writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'));
    const jsonBefore = readFileSync(seeded.jsonPath, 'utf8');

    // A perfectly acceptable configuration: the refusal must come from the
    // output guard, not from the credential or the socket.
    const run = runCli({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' }, DEFAULT_ARGS, dir);

    assert.equal(run.status, 2, `unexpected exit; stderr:\n${run.stderr}`);
    assert.match(run.stderr, /refusing to run/);
    assert.match(run.stderr, /already exists/);
    assert.ok(!/cannot reach the database|query failed/i.test(run.stderr), 'it must refuse before connecting');
    assert.equal(readFileSync(seeded.jsonPath, 'utf8'), jsonBefore, 'the earlier report was modified');
    assert.deepEqual(filesUnder(dir).sort(), [seeded.jsonPath, seeded.mdPath].sort(), 'the run created a file');
  });

  it('a successful run leaves a report that blocks the next run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-cli-stale2-'));
    workDirs.push(dir);
    const seeded = writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'));
    const mdBefore = readFileSync(seeded.mdPath, 'utf8');
    assert.match(readFileSync(seeded.jsonPath, 'utf8'), /2026-01-01T00:00:00\.000Z/);

    const second = runCli({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' }, DEFAULT_ARGS, dir);

    assert.equal(second.status, 2);
    // The old report still says it is the OLD one — the refused run changed nothing.
    assert.match(readFileSync(seeded.jsonPath, 'utf8'), /2026-01-01T00:00:00\.000Z/);
    assert.equal(readFileSync(seeded.mdPath, 'utf8'), mdBefore);
    assert.ok(second.stdout === '', 'a refused run prints nothing on stdout');
  });
});

// ---------------------------------------------------------------------------
// I2. An --out path that is not a directory is refused before any connection
// ---------------------------------------------------------------------------

describe('the output path must be a directory', () => {
  it('accepts a missing path and an existing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-outdir-'));
    workDirs.push(dir);
    assert.equal(outputPathProblem(dir), null);
    assert.equal(outputPathProblem(join(dir, 'not-created-yet')), null);
  });

  it('refuses a path that exists as a file, and names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-outfile-'));
    workDirs.push(dir);
    const file = join(dir, 'report.json');
    writeFileSync(file, 'not a directory\n');

    const problem = outputPathProblem(file);
    assert.notEqual(problem, null);
    assert.match(problem!, /is not a directory/);
    assert.ok(problem!.includes(file), 'the refusal must name the path');
    assert.equal(readFileSync(file, 'utf8'), 'not a directory\n', 'the existing file was modified');
  });

  it('the CLI refuses with exit 2 before connecting and leaves the file untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-outfile-cli-'));
    workDirs.push(dir);
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, 'keep me\n');

    // A perfectly acceptable credential: the refusal must come from --out.
    const run = runCli({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' }, DEFAULT_ARGS, file);

    assert.equal(run.status, 2, `unexpected exit; stderr:\n${run.stderr}`);
    assert.match(run.stderr, /refusing to run/);
    assert.match(run.stderr, /is not a directory/);
    assert.ok(!/cannot reach the database|query failed/i.test(run.stderr), 'it must refuse before connecting');
    assert.equal(readFileSync(file, 'utf8'), 'keep me\n', 'the existing file was modified');
    assert.deepEqual(readdirSync(dir), ['not-a-directory'], 'the run created something next to the file');
  });
});

// ---------------------------------------------------------------------------
// I3. A partially written report is cleaned up, and nothing else is deleted
// ---------------------------------------------------------------------------

describe('a partial report write is cleaned up', () => {
  /** Writes for real, but throws when the Markdown file is attempted. */
  function failingMarkdownWriter(seen: Array<{ file: string; options: unknown }>) {
    return (file: string, data: string, options: { encoding: 'utf8'; flag: 'wx' }): void => {
      seen.push({ file, options });
      if (file.endsWith('.md')) {
        throw Object.assign(new Error('simulated markdown failure'), { code: 'EIO' });
      }
      writeFileSync(file, data, options);
    };
  }

  it('removes the JSON this attempt created when the Markdown write fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-partial-'));
    workDirs.push(dir);
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me\n');

    const seen: Array<{ file: string; options: unknown }> = [];
    assert.throws(
      () => writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'), { writeFile: failingMarkdownWriter(seen) }),
      (err: unknown) => err instanceof ReportWriteError && err.stale === false,
    );

    // The JSON really was written and then really was removed: only the
    // unrelated file is left.
    assert.equal(seen.length, 2, 'both writes should have been attempted');
    assert.ok(seen[0]!.file.endsWith('gold-v8-production-evidence.json'));
    assert.ok(seen[1]!.file.endsWith('gold-v8-production-evidence.md'));
    assert.deepEqual(readdirSync(dir), ['unrelated.txt'], 'the partial report was left behind');
    assert.equal(readFileSync(join(dir, 'unrelated.txt'), 'utf8'), 'keep me\n', 'an unrelated file was deleted');
  });

  it('opens both files exclusively, so nothing is ever replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-flags-'));
    workDirs.push(dir);
    const seen: Array<{ file: string; options: unknown }> = [];
    writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'), {
      writeFile: (file, data, options) => {
        seen.push({ file, options });
        writeFileSync(file, data, options);
      },
    });
    assert.equal(seen.length, 2);
    for (const write of seen) {
      assert.deepEqual(write.options, { encoding: 'utf8', flag: 'wx' }, `${write.file} was not opened exclusively`);
    }
  });

  it('does not delete anything when the first (JSON) write fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-firstfail-'));
    workDirs.push(dir);
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me\n');
    const removed: string[] = [];

    assert.throws(
      () =>
        writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'), {
          writeFile: (file, data, options) => {
            if (file.endsWith('.json')) throw Object.assign(new Error('simulated json failure'), { code: 'EIO' });
            writeFileSync(file, data, options);
          },
          removeFile: (file) => removed.push(file),
        }),
      (err: unknown) => err instanceof ReportWriteError && err.stale === false,
    );

    assert.deepEqual(removed, [], 'a file that was never created must not be removed');
    assert.deepEqual(readdirSync(dir), ['unrelated.txt']);
  });

  it('says so when the partial JSON cannot be removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-cleanupfail-'));
    workDirs.push(dir);

    assert.throws(
      () =>
        writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'), {
          writeFile: failingMarkdownWriter([]),
          removeFile: () => {
            throw new Error('simulated unlink failure');
          },
        }),
      (err: unknown) => err instanceof ReportWriteError && /could not be removed/.test(err.message),
    );
  });

  it('still refuses a pre-existing report before writing anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-preflight-'));
    workDirs.push(dir);
    const seeded = writeReport(dir, minimalEvidence('2026-01-01T00:00:00.000Z'));
    const before = readFileSync(seeded.jsonPath, 'utf8');
    let writes = 0;

    assert.throws(
      () =>
        writeReport(dir, minimalEvidence('2026-02-02T00:00:00.000Z'), {
          writeFile: () => {
            writes += 1;
          },
        }),
      (err: unknown) => err instanceof ReportWriteError && err.stale === true,
    );
    assert.equal(writes, 0, 'a refused write must not touch the filesystem');
    assert.equal(readFileSync(seeded.jsonPath, 'utf8'), before);
  });
});

// ---------------------------------------------------------------------------
// 5 + 6. The real CLI: configuration refusals (no connection attempted)
// ---------------------------------------------------------------------------

describe('CLI refuses unsafe configuration before connecting', () => {
  const cases: Array<[string, Record<string, string>, number, RegExp]> = [
    ['missing DATABASE_URL', {}, 2, /DATABASE_URL/],
    [
      'DATABASE_SSL_MODE other than verify-full',
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', DATABASE_SSL_MODE: 'disable' },
      2,
      /DATABASE_SSL_MODE must be verify-full/,
    ],
    [
      'NODE_TLS_REJECT_UNAUTHORIZED=0',
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      2,
      /NODE_TLS_REJECT_UNAUTHORIZED=0/,
    ],
    [
      'PGSSLMODE=disable',
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', PGSSLMODE: 'disable' },
      2,
      /PGSSLMODE/,
    ],
    [
      'ssl* URL parameter',
      { DATABASE_URL: `postgres://u:p@127.0.0.1:1/db?ssl${MARKER}=1` },
      2,
      /not allowed|sslmode/i,
    ],
    [
      'options= URL parameter (would disable the read-only default)',
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db?options=-c%20default_transaction_read_only=off' },
      2,
      /not allowed/,
    ],
    [
      'host= URL parameter (would redirect the connection)',
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db?host=attacker.invalid' },
      2,
      /not allowed/,
    ],
    [
      'sslmode=disable',
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db?sslmode=disable' },
      2,
      /verify-full/,
    ],
    [
      'duplicate sslmode, both verify-full',
      { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db?sslmode=verify-full&sslmode=verify-full' },
      2,
      /repeats a query parameter/,
    ],
    // The target must come from DATABASE_URL alone: an ambient libpq variable
    // could otherwise redirect the connection to another role/database/host.
    ['PGUSER set', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', PGUSER: 'someone-else' }, 2, /PGUSER/],
    ['PGDATABASE set', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', PGDATABASE: 'other' }, 2, /PGDATABASE/],
    ['PGPASSWORD set', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', PGPASSWORD: 'other' }, 2, /PGPASSWORD/],
    ['PGHOST set', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', PGHOST: 'attacker.invalid' }, 2, /PGHOST/],
    ['PGPORT set', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', PGPORT: '6543' }, 2, /PGPORT/],
    [
      'URL that does not name the role',
      { DATABASE_URL: 'postgres://127.0.0.1:1/db' },
      2,
      /does not name the connecting role/,
    ],
    ['URL that does not name the database', { DATABASE_URL: 'postgres://u:p@127.0.0.1:1' }, 2, /does not name the database/],
  ];

  for (const [name, env, expectedStatus, message] of cases) {
    it(`refuses ${name}`, () => {
      const run = runCli(env);
      assert.equal(run.status, expectedStatus, `unexpected exit; stderr:\n${run.stderr}`);
      assert.match(run.stderr, message);
      assertNoMarker(run);
      assert.deepEqual(
        filesUnder(run.outDir),
        [],
        'a refused run must not write a report',
      );
    });
  }

  it('never prints the value of a refused libpq variable', () => {
    const run = runCli({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db', PGPASSWORD: MARKER, PGUSER: MARKER });
    assert.equal(run.status, 2, `unexpected exit; stderr:\n${run.stderr}`);
    assert.match(run.stderr, /PGUSER|PGPASSWORD/);
    assertNoMarker(run);
    assert.deepEqual(filesUnder(run.outDir), [], 'a refused run must not write a report');
  });

  it('refuses an invalid --version with exit 2, before connecting', () => {
    for (const value of ['abc', '9x', '0', '-3', '8.5', '9007199254740992', '99999999999999999999']) {
      const run = runCli({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' }, [
        '--strategy',
        'Gold Break & Retest Test Pro VI',
        '--version',
        value,
      ]);
      assert.equal(run.status, 2, `--version ${value} should exit 2; stderr:\n${run.stderr}`);
      assert.match(run.stderr, /--version must be a whole number greater than zero/);
      assert.ok(
        !/falling back|defaulting to|using (the )?default/i.test(run.stderr),
        'the refusal must not announce a fallback to the default version',
      );
      // Refused before the pool is created: no connection attempt is reported.
      assert.ok(
        !/cannot reach the database|query failed/i.test(run.stderr),
        'an invalid --version must be refused before any connection attempt',
      );
      assertNoMarker(run);
      assert.deepEqual(filesUnder(run.outDir), [], 'a refused run must not write a report');
    }
  });

  it('requires --strategy and has no default target', () => {
    const run = runCli({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db' }, []);
    assert.equal(run.status, 2, `unexpected exit; stderr:\n${run.stderr}`);
    assert.match(run.stderr, /--strategy is required/);
    assertNoMarker(run);
  });

  it('never prints the connection string when the driver refuses the socket', () => {
    const run = runCli({ DATABASE_URL: `postgres://u:${MARKER}@127.0.0.1:1/db` });
    assert.equal(run.status, 3, `unexpected exit; stderr:\n${run.stderr}`);
    assert.match(run.stderr, /cannot reach the database \(error code: [A-Z0-9_]+\)/);
    assertNoMarker(run);
    assert.deepEqual(filesUnder(run.outDir), []);
  });
});

// ---------------------------------------------------------------------------
// 1, 2, 3, 7, 10. Real database: the guarantees, against an embedded Postgres
// ---------------------------------------------------------------------------

const DB_PORT = 5587; // unique across the suite
const DB_USER = 'diag_super';
const DB_PASSWORD = 'diag_super_pw';
const DB_NAME = 'diag';
const RO_USER = 'diag_ro';
const RO_PASSWORD = 'diag_ro_pw';

interface DbHandle {
  dbUrl: string;
  stop: () => Promise<void>;
}

let handle: DbHandle | undefined;
let dataDir: string | undefined;

/** The stub tables Q_CONNECTION asks `has_table_privilege` about. */
const STUB_TABLES = [
  'setups',
  'alerts',
  'alert_deliveries',
  'notification_deliveries',
  'scanner_runs',
  'scanner_cursors',
  'strategies',
  'strategy_versions',
];

function clientConfig(overrides: Record<string, unknown> = {}): pg.ClientConfig {
  return {
    host: '127.0.0.1',
    port: DB_PORT,
    database: DB_NAME,
    user: RO_USER,
    password: RO_PASSWORD,
    ...overrides,
  } as pg.ClientConfig;
}

async function connect(overrides: Record<string, unknown> = {}): Promise<pg.Client> {
  const client = new pg.Client(clientConfig(overrides));
  await client.connect();
  return client;
}

/** Run the real Q_CONNECTION and the real mapping/verdict functions. */
async function safetyOf(client: pg.Client): Promise<ReturnType<typeof evaluateSafety>> {
  const res = await client.query<Record<string, unknown>>(Q_CONNECTION);
  return evaluateSafety(factsFromConnectionRow(res.rows[0] ?? {}));
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gold-diag-db-'));
  const started = (await startEmbeddedPostgres({
    dataDir,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
  })) as unknown as DbHandle;
  handle = started;

  const admin = await connect({ user: DB_USER, password: DB_PASSWORD });
  try {
    for (const table of STUB_TABLES) {
      await admin.query(`CREATE TABLE IF NOT EXISTS ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
    }
    await admin.query(`CREATE ROLE ${RO_USER} LOGIN PASSWORD '${RO_PASSWORD}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${RO_USER}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${RO_USER}`);
    for (const table of STUB_TABLES) {
      await admin.query(`GRANT SELECT ON ${table} TO ${RO_USER}`);
    }
  } finally {
    await admin.end();
  }
}, { timeout: 240_000 });

after(async () => {
  if (handle) await stopEmbeddedPostgres(handle as never).catch(() => {});
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('read-only session (real Postgres)', () => {
  it('opens BEGIN READ ONLY and the server reports the transaction as read-only', async () => {
    const client = await connect({ options: '-c default_transaction_read_only=on' });
    const ro = new ReadOnlySession(client);
    try {
      await ro.begin();
      const state = await ro.query<{ tx: string; def: string }>(
        "SELECT current_setting('transaction_read_only') AS tx, current_setting('default_transaction_read_only') AS def",
      );
      assert.equal(state.rows[0]?.tx, 'on');
      assert.equal(state.rows[0]?.def, 'on');
    } finally {
      await ro.end();
      await client.end();
    }
  });

  it('refuses a query issued before begin() and after end()', async () => {
    const client = await connect();
    const ro = new ReadOnlySession(client);
    try {
      await assert.rejects(() => ro.query('SELECT 1'), /outside the explicit read-only transaction/);
      await ro.begin();
      await ro.query('SELECT 1');
      await ro.end();
      await assert.rejects(() => ro.query('SELECT 1'), /outside the explicit read-only transaction/);
    } finally {
      await client.end();
    }
  });

  it('refuses to continue when the server reports a non-read-only transaction', async () => {
    // A fake client: BEGIN succeeds, then the server claims the transaction is
    // writable. begin() must fail closed rather than let the run continue.
    const statements: string[] = [];
    const fake = {
      async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>> {
        statements.push(text);
        const rows = text.includes('transaction_read_only') ? [{ v: 'off' }] : [];
        return { rows: rows as unknown as R[], rowCount: rows.length } as pg.QueryResult<R>;
      },
    };
    const ro = new ReadOnlySession(fake);
    await assert.rejects(() => ro.begin(), /did not open a read-only transaction/);
    assert.equal(statements[0], 'BEGIN READ ONLY');
    assert.equal(ro.allQueriesInsideReadOnly, false);
  });

  it('makes a write impossible: DDL and DML are rejected with 25006', async () => {
    const client = await connect();
    const ro = new ReadOnlySession(client);
    try {
      await ro.begin();
      await assert.rejects(
        () => ro.query('CREATE TABLE should_not_exist (id int)'),
        (err: unknown) => (err as { code?: string }).code === '25006',
      );
      // A failed statement aborts the transaction; roll back and prove the write
      // never landed by checking the catalogue from a fresh session.
      await ro.end().catch(() => {});
    } finally {
      await client.end();
    }
    const check = await connect({ user: DB_USER, password: DB_PASSWORD });
    try {
      const res = await check.query("SELECT to_regclass('public.should_not_exist') AS t");
      assert.equal(res.rows[0]?.t, null, 'the read-only transaction allowed a table to be created');
    } finally {
      await check.end();
    }
  });

  it('rolls back on the success path', async () => {
    const client = await connect();
    const ro = new ReadOnlySession(client);
    try {
      await ro.begin();
      await ro.query('SELECT 1');
      await ro.end();
      assert.equal(ro.allQueriesInsideReadOnly, true);
      // The session is usable and outside a transaction afterwards.
      const state = await client.query<{ tx: string }>(
        "SELECT coalesce(current_setting('transaction_read_only'), '') AS tx",
      );
      assert.equal(state.rows[0]?.tx, 'off');
    } finally {
      await client.end();
    }
  });

  it('rolls back on the failure path (as main() does in its catch)', async () => {
    const client = await connect();
    const ro = new ReadOnlySession(client);
    let failedCode: string | undefined;
    let stateAfterRollback: string | undefined;
    let usableAfterRollback: number | undefined;
    try {
      await ro.begin();
      await ro
        .query('SELECT * FROM definitely_not_a_table')
        .catch((err: unknown) => {
          failedCode = errorCodeOf(err);
          throw err;
        });
    } catch {
      // This is exactly what main() does in its catch block.
      await client.query('ROLLBACK');
      // Prove the transaction is GONE, not merely that ROLLBACK was sent: an
      // open transaction would report transaction_read_only='on'.
      const state = await client.query<{ tx: string }>(
        "SELECT coalesce(current_setting('transaction_read_only'), '') AS tx",
      );
      stateAfterRollback = state.rows[0]?.tx;
      // And prove the session is usable again, which it is not inside an
      // aborted transaction (SQLSTATE 25P02).
      const again = await client.query<{ one: number }>('SELECT 1::int AS one');
      usableAfterRollback = again.rows[0]?.one;
    } finally {
      await client.end();
    }
    assert.equal(failedCode, '42P01', 'the failing query should report undefined_table');
    assert.equal(stateAfterRollback, 'off', 'the failed transaction was not rolled back');
    assert.equal(usableAfterRollback, 1, 'the session stayed in the aborted transaction');
  });
});

describe('post-connect safety enforcement (real Postgres)', () => {
  it('a least-privilege read-only session passes', async () => {
    const client = await connect({ options: '-c default_transaction_read_only=on' });
    try {
      await client.query('BEGIN READ ONLY');
      const verdict = await safetyOf(client);
      assert.equal(verdict.ok, true, verdict.violations.join('; '));
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it("detects a session whose default_transaction_read_only is NOT 'on'", async () => {
    // Same role, same read-only transaction — only the session default differs.
    const client = await connect();
    try {
      const row = await client.query<{ def: string }>(
        "SELECT current_setting('default_transaction_read_only') AS def",
      );
      assert.equal(row.rows[0]?.def, 'off');
      await client.query('BEGIN READ ONLY');
      const verdict = await safetyOf(client);
      assert.equal(verdict.ok, false);
      assert.ok(verdict.violations.some((v) => v.includes('default_transaction_read_only')));
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('detects a writable (superuser) role', async () => {
    const client = await connect({ user: DB_USER, password: DB_PASSWORD, options: '-c default_transaction_read_only=on' });
    try {
      await client.query('BEGIN READ ONLY');
      const verdict = await safetyOf(client);
      assert.equal(verdict.ok, false);
      assert.ok(verdict.violations.some((v) => v.includes('superuser')));
      assert.ok(verdict.violations.some((v) => v.includes('INSERT on setups')));
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('detects a non-superuser role that holds one write privilege', async () => {
    const admin = await connect({ user: DB_USER, password: DB_PASSWORD });
    try {
      await admin.query(`GRANT UPDATE ON strategies TO ${RO_USER}`);
    } finally {
      await admin.end();
    }
    const client = await connect({ options: '-c default_transaction_read_only=on' });
    try {
      await client.query('BEGIN READ ONLY');
      const verdict = await safetyOf(client);
      assert.equal(verdict.ok, false);
      assert.ok(verdict.violations.some((v) => v.includes('UPDATE on strategies')));
      await client.query('ROLLBACK');
    } finally {
      await client.end();
      const cleanup = await connect({ user: DB_USER, password: DB_PASSWORD });
      await cleanup.query(`REVOKE UPDATE ON strategies FROM ${RO_USER}`);
      await cleanup.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 1 — TLS: what the client can prove, and what pg_stat_ssl means
// ---------------------------------------------------------------------------

describe('TLS observation (TLS-terminating front ends and fail-closed verification)', () => {
  it('refuses a plaintext session', async () => {
    // The embedded server speaks plaintext; a client that asks for no TLS must
    // never be describable as verified.
    const client = await connect();
    try {
      const state = readClientTlsState(
        (client as unknown as { connection?: { stream?: unknown } }).connection?.stream,
      );
      assert.equal(state.encrypted, null, 'a plain socket reported an encryption state');
      assert.equal(state.authorized, null);
      assert.equal(state.peerCertificateSha256, null);
      const problems = tlsVerificationProblems(state, 'localhost');
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /not encrypted/);
    } finally {
      await client.end();
    }
  });

  /**
   * Start a TLS-terminating proxy in front of the plaintext test server — the
   * shape of any endpoint that ends TLS before PostgreSQL (Neon's front proxy,
   * PgBouncer, a load balancer) — and hand `fn` a connected client plus the
   * throwaway certificate path.
   *
   * The proxy answers the PostgreSQL `SSLRequest` with `'S'` and destroys any
   * socket that does not speak TLS first, so a successful query proves the
   * connection really is the TLS one.
   *
   * Returns false (after skipping) when `openssl` is unavailable.
   */
  async function withTerminatingProxy(
    t: { skip: (message: string) => void },
    proxyPort: number,
    fn: (client: pg.Client, certPath: string) => Promise<void>,
  ): Promise<boolean> {
    const dir = mkdtempSync(join(tmpdir(), 'gold-diag-tls-'));
    workDirs.push(dir);
    const certPath = join(dir, 'cert.pem');
    const keyPath = join(dir, 'key.pem');
    const generated = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
        '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
      { encoding: 'utf8' },
    );
    if (generated.status !== 0) {
      t.skip('openssl is unavailable — cannot mint a throwaway certificate for this test');
      return false;
    }

    const secureContext = tls.createSecureContext({
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    });
    const sockets: net.Socket[] = [];
    const proxy = net.createServer((socket) => {
      sockets.push(socket);
      socket.once('data', (buf) => {
        // PostgreSQL SSLRequest: int32 length 8, int32 code 80877103.
        if (buf.length < 8 || buf.readInt32BE(4) !== 80877103) {
          socket.destroy();
          return;
        }
        socket.write('S');
        const tlsSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
        const upstream = net.connect(DB_PORT, '127.0.0.1');
        sockets.push(upstream);
        tlsSocket.pipe(upstream).pipe(tlsSocket);
        const kill = (): void => {
          upstream.destroy();
          tlsSocket.destroy();
        };
        tlsSocket.on('error', kill);
        upstream.on('error', kill);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));

    let client: pg.Client | undefined;
    try {
      client = new pg.Client(
        clientConfig({ host: 'localhost', port: proxyPort, ssl: { rejectUnauthorized: true, ca: readFileSync(certPath) } }),
      );
      await client.connect();
      await fn(client, certPath);
    } finally {
      await client?.end().catch(() => {});
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
    }
    return true;
  }

  it('a verified client session still reads ssl = false from pg_stat_ssl behind a TLS-terminating front end', async (t) => {
    // Reproduces what any TLS-terminating front end does to this observation
    // (Neon's front proxy does it for pooled AND direct hosts; PgBouncer does it
    // for pooled ones): the client session is encrypted and verified, the
    // backend's pg_stat_ssl row is not.
    await withTerminatingProxy(t, 5642, async (client) => {
      const state = readClientTlsState(
        (client as unknown as { connection?: { stream?: unknown } }).connection?.stream,
      );
      // THE CLIENT SESSION IS TLS AND VERIFIED.
      assert.equal(state.encrypted, true);
      assert.equal(state.authorized, true);
      assert.match(state.protocol ?? '', /^TLSv1\.[23]$/);
      assert.ok(state.cipher !== null);
      assert.equal(state.servername, 'localhost');
      assert.match(state.peerCertificateSha256 ?? '', /^[0-9A-F]{2}(:[0-9A-F]{2})+$/);
      assert.equal(state.peerCertificateSubject, 'CN=localhost');
      assert.deepEqual(tlsVerificationProblems(state, 'localhost'), []);

      // …AND THE SERVER STILL SAYS ITS BACKEND CONNECTION IS NOT TLS.
      const backend = await client.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
      );
      assert.equal(backend.rows[0]?.ssl, false, 'the terminating-proxy topology did not reproduce');

      // The pooled explanation describes the inner connection and separates the
      // measurement from the architecture; it never claims a downgrade.
      const note = backendSslExplanation({
        clientVerified: true,
        backendSsl: backend.rows[0]?.ssl ?? null,
        pooledEndpoint: isPooledEndpointHost('ep-x-123-pooler.eu-central-1.aws.neon.tech'),
        provider: managedProviderFor('ep-x-123-pooler.eu-central-1.aws.neon.tech'),
      });
      assert.ok(note !== null);
      assert.match(note!, /pooled endpoint/);
      assert.match(note!, /MEASURED by this run/);
      assert.match(note!, /Not a downgrade/);
    });
  });

  it('observes TLS on the same pg client whose queries are executed', async (t) => {
    // The TLS facts are only meaningful if they describe the socket that carries
    // the queries. This pins that down against a real connection:
    //  1. the inspected socket is the one dialled to the endpoint (remote port);
    //  2. pg has not replaced it between inspection and the queries;
    //  3. the queries that follow run on that same client;
    //  4. the backend row read afterwards belongs to the pid those queries see;
    //  5. a plaintext client cannot even reach the server through this endpoint.
    const proxyPort = 5643;
    await withTerminatingProxy(t, proxyPort, async (client) => {
      const connection = (client as unknown as {
        connection?: { stream?: net.Socket & { encrypted?: boolean } };
      }).connection;
      const inspected = connection?.stream;
      assert.ok(inspected, 'the client exposes no connection stream');

      // 1. same endpoint: this is the socket dialled to the proxy, not another.
      assert.equal(inspected!.remotePort, proxyPort);
      assert.equal(inspected!.encrypted, true);

      // 2. + 3. queries travel over that very socket; pg never reconnects.
      const pidRow = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = pidRow.rows[0]?.pid;
      assert.equal(connection?.stream, inspected, 'pg replaced the connection stream');
      assert.equal(connection?.stream?.encrypted, true);

      // 4. the backend whose ssl flag we read is the backend that answered.
      const backend = await client.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid = $1',
        [pid],
      );
      assert.equal(backend.rows[0]?.ssl, false);
      assert.equal(readClientTlsState(inspected).encrypted, true);

      // 5. the proxy rejects anything that is not TLS, so reaching the database
      //    above proves the inspected socket is the connection path.
      const plaintext = new pg.Client(clientConfig({ host: 'localhost', port: proxyPort }));
      try {
        await assert.rejects(() => plaintext.connect(), 'a plaintext client reached the server through the TLS endpoint');
      } finally {
        await plaintext.end().catch(() => {});
      }
    });
  });

  it('reads no TLS state from a socket that is not TLS at all', () => {
    const state = readClientTlsState({});
    assert.deepEqual(state, {
      encrypted: null,
      authorized: null,
      authorizationError: null,
      protocol: null,
      cipher: null,
      servername: null,
      peerCertificateSha256: null,
      peerCertificateSubject: null,
      peerCertificateIssuer: null,
      peerCertificateValidTo: null,
    });
    assert.equal(readClientTlsState(null).encrypted, null);
    assert.equal(readClientTlsState('not a socket').encrypted, null);
  });

  it('refuses every way a TLS promise can be weaker than verify-full', () => {
    const verified = {
      encrypted: true,
      authorized: true,
      authorizationError: null,
      protocol: 'TLSv1.3',
      cipher: 'TLS_AES_256_GCM_SHA384',
      servername: 'db.example.test',
      peerCertificateSha256: 'AA:BB',
      peerCertificateSubject: 'CN=db.example.test',
      peerCertificateIssuer: 'CN=ca',
      peerCertificateValidTo: 'Jan  1 00:00:00 2030 GMT',
    };

    // The good case has nothing to report.
    assert.deepEqual(tlsVerificationProblems(verified, 'db.example.test'), []);

    // Unaccepted chain: refused, with the reason.
    const untrusted = tlsVerificationProblems(
      { ...verified, authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' },
      'db.example.test',
    );
    assert.equal(untrusted.length, 1);
    assert.match(untrusted[0]!, /SELF_SIGNED_CERT_IN_CHAIN/);

    // No peer certificate: refused.
    assert.match(
      tlsVerificationProblems({ ...verified, peerCertificateSha256: null }, 'db.example.test')[0]!,
      /no peer certificate/,
    );

    // An IPv4 endpoint cannot be hostname-verified by this driver: refused.
    assert.match(tlsVerificationProblems(verified, '10.0.0.5')[0]!, /IPv4/);

    // An IPv6 literal must be refused EXPLICITLY, not left to a generic failure.
    // `net.isIP('[2001:db8::1]')` is 0, so the brackets have to be normalised
    // before the check or the guard silently misses it.
    const ipv6 = tlsVerificationProblems(verified, '[2001:db8::1]');
    assert.equal(ipv6.length, 1);
    assert.match(ipv6[0]!, /IP address literal \(IPv6\)/);
    assert.match(tlsVerificationProblems(verified, '::1')[0]!, /IPv6/);

    // An unreadable host is its own explicit error, not a silent pass.
    assert.match(
      tlsVerificationProblems(verified, '')[0]!,
      /endpoint host could not be read from DATABASE_URL/,
    );

    // The certificate must have been verified for the host in DATABASE_URL.
    assert.match(
      tlsVerificationProblems({ ...verified, servername: 'other.example.test' }, 'db.example.test')[0]!,
      /verified against "other\.example\.test" but DATABASE_URL names "db\.example\.test"/,
    );
    // Case and a trailing dot are not a mismatch.
    assert.deepEqual(tlsVerificationProblems({ ...verified, servername: 'DB.Example.Test.' }, 'db.example.test'), []);

    // No SNI: hostname verification cannot have happened.
    assert.match(
      tlsVerificationProblems({ ...verified, servername: null }, 'db.example.test')[0]!,
      /no SNI/,
    );

    // Plaintext short-circuits: nothing else is even considered.
    assert.deepEqual(tlsVerificationProblems({ ...verified, encrypted: false }, 'db.example.test'), [
      'the client socket is not encrypted — this session is plaintext, not TLS',
    ]);
  });

  it('recognises pooled endpoint names without ever relaxing a check', () => {
    assert.equal(isPooledEndpointHost('ep-cool-name-123456-pooler.eu-central-1.aws.neon.tech'), true);
    assert.equal(isPooledEndpointHost('ep-cool-name-123456.eu-central-1.aws.neon.tech'), false);
    assert.equal(isPooledEndpointHost('pgbouncer.internal'), true);
    assert.equal(isPooledEndpointHost('pooler.example.test'), true);
    assert.equal(isPooledEndpointHost('db.example.test'), false);
    assert.equal(isPooledEndpointHost(''), false);
  });

  it('explains the mismatch only when the client really verified the server', () => {
    // Client not verified → no comforting explanation.
    assert.equal(backendSslExplanation({ clientVerified: false, backendSsl: false, pooledEndpoint: true }), null);
    // Agreement → nothing to say.
    assert.equal(backendSslExplanation({ clientVerified: true, backendSsl: true, pooledEndpoint: true }), null);
    // Unreadable server-side view → unknown, not silence.
    assert.match(
      backendSslExplanation({ clientVerified: true, backendSsl: null, pooledEndpoint: true })!,
      /could not be read/,
    );
    // Pooled → the pooler explanation.
    assert.match(
      backendSslExplanation({ clientVerified: true, backendSsl: false, pooledEndpoint: true })!,
      /pooled endpoint/,
    );
    // Not pooled and not a known provider → do not blame a pooler never detected.
    const notPooled = backendSslExplanation({ clientVerified: true, backendSsl: false, pooledEndpoint: false })!;
    assert.match(notPooled, /not a recognised pooler or managed-provider name/);
    assert.ok(!notPooled.includes('pooled endpoint ('));
  });

  it('explains a DIRECT Neon endpoint by provider architecture, and says so is not measured', () => {
    const note = backendSslExplanation({
      clientVerified: true,
      backendSsl: false,
      pooledEndpoint: false,
      provider: 'neon',
    })!;
    // The provider explanation is present …
    assert.match(note, /PROVIDER ARCHITECTURE, not a measurement/);
    assert.match(note, /front proxy/);
    assert.match(note, /direct \(non-pooler\) hostname/);
    // … and it is fenced off from what the collector measured.
    assert.match(note, /MEASURED by this run/);
    assert.match(note, /NOT MEASURED/);
    assert.match(note, /cannot be observed from the client/);
    // A direct host must not be described as a pooler.
    assert.ok(!/pooled endpoint \(/.test(note));
    // Unknown provider + not pooled → the neutral explanation, never Neon's.
    const generic = backendSslExplanation({ clientVerified: true, backendSsl: false, pooledEndpoint: false, provider: null })!;
    assert.ok(!generic.includes('front proxy'));
  });

  it('recognises managed-provider hosts without treating look-alikes as Neon', () => {
    assert.equal(managedProviderFor('ep-long-voice-b2gw2tal.c-6.eu-central-1.aws.neon.tech'), 'neon');
    assert.equal(managedProviderFor('ep-x-123-pooler.eu-central-1.aws.neon.tech'), 'neon');
    assert.equal(managedProviderFor('NEON.TECH'), 'neon');
    assert.equal(managedProviderFor('neon.tech.'), 'neon');
    assert.equal(managedProviderFor('neon.tech.attacker.test'), null);
    assert.equal(managedProviderFor('notneon.tech'), null);
    assert.equal(managedProviderFor('db.example.test'), null);
    assert.equal(managedProviderFor(''), null);
  });

  it('normalises IPv6 brackets, case and a trailing dot before comparing hosts', () => {
    assert.equal(normaliseEndpointHost('[2001:db8::1]'), '2001:db8::1');
    assert.equal(normaliseEndpointHost('[::1]'), '::1');
    assert.equal(normaliseEndpointHost('DB.Example.Test.'), 'db.example.test');
    assert.equal(normaliseEndpointHost('  ep-x.eu-central-1.aws.neon.tech  '), 'ep-x.eu-central-1.aws.neon.tech');
    assert.equal(normaliseEndpointHost(''), '');
  });
});

// ---------------------------------------------------------------------------
// Documentation an operator copies verbatim (a dropped hyphen must not ship)
// ---------------------------------------------------------------------------

describe('documented strategy id', () => {
  const doc = readFileSync(
    join(REPO_ROOT, 'docs/diagnostics/gold-v8-production-evidence.md'),
    'utf8',
  );
  const GOLD_V8_ID = '92821cf1-5f28-459d-9ade-08f078b58134';

  it('quotes the Gold v8 id in canonical 8-4-4-4-12 form, everywhere it appears', () => {
    assert.ok(doc.includes(GOLD_V8_ID), 'the canonical strategy id is missing from the doc');
    // Every hex-and-dash cluster in the doc must be a well-formed UUID, so a
    // merged group (the `...-459d9ade-...` typo) fails here instead of at the
    // operator's prompt, where it would be rejected as "not a strategy id".
    const clusters = doc.match(/\b[0-9a-f]{8}(?:-[0-9a-f]+)+\b/gi) ?? [];
    assert.ok(clusters.length >= 4, `expected several id references, found ${clusters.length}`);
    for (const cluster of clusters) {
      assert.ok(isStrategyUuid(cluster), `malformed strategy id in the doc: ${cluster}`);
    }
    assert.ok(
      !doc.includes('92821cf1-5f28-459d9ade-08f078b58134'),
      'the 4-group typo (a dropped hyphen) is back in the doc',
    );
  });

  it('passes the id through the same validation the CLI applies to --strategy', () => {
    assert.equal(isStrategyUuid(GOLD_V8_ID), true);
    assert.equal(isStrategyUuid('92821cf1-5f28-459d9ade-08f078b58134'), false);
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — notification delivery evidence
// ---------------------------------------------------------------------------

describe('notification delivery evidence (counts, never recipients)', () => {
  /** The shape the staging snapshot reported: 5/5 attempts, timeouts, no reply. */
  const stagingRows = [
    {
      channel: 'email',
      provider: 'smtp',
      provider_response_code: null,
      status: 'failed',
      attempts: 5,
      max_attempts: 5,
      failure_category: 'timeout',
      delivered_at: null,
      alert_id: 'a',
    },
    {
      channel: 'email',
      provider: 'smtp',
      provider_response_code: null,
      status: 'failed',
      attempts: 5,
      max_attempts: 5,
      failure_category: 'timeout',
      delivered_at: null,
      alert_id: 'b',
    },
  ];

  it('summarises exhausted, reply-less failures without quoting a row', () => {
    const summary = summariseNotificationDeliveries(stagingRows);
    assert.equal(summary.total, 2);
    assert.equal(summary.delivered, 0);
    assert.equal(summary.neverDelivered, 2);
    assert.equal(summary.exhausted, 2);
    assert.equal(summary.failedWithoutProviderResponse, 2);
    assert.deepEqual(summary.byStatus, { failed: 2 });
    assert.deepEqual(summary.byCategory, { timeout: 2 });
    assert.deepEqual(summary.byProvider, { smtp: 2 });
    assert.deepEqual(summary.byChannel, { email: 2 });
  });

  it('turns the timeout signature into an actionable, non-sensitive hint', () => {
    const hint = deliveryFailureHint(summariseNotificationDeliveries(stagingRows));
    assert.ok(hint !== null);
    assert.match(hint!, /no complete provider response recorded/i);
    assert.match(hint!, /Render/);
    assert.match(hint!, /Resend/);
    // The evidence boundary: silence on the wire is not proof of non-delivery.
    assert.match(hint!, /LATE DELIVERY MAY ALREADY HAVE HAPPENED/);
    assert.match(hint!, /duplicate/);
    assert.ok(!/NO reply from the provider/i.test(hint!), 'the hint claims the provider never replied');
    assert.ok(!/Nothing was accepted/i.test(hint!), 'the hint claims nothing was accepted');
    assert.match(hint!, /does not prove the provider received nothing/);
    // No address, no credential, no provider message text.
    assert.ok(!hint!.includes('@'), 'the hint echoed something address-like');
  });

  it('distinguishes configuration, permanent and stale failures', () => {
    const config = deliveryFailureHint(
      summariseNotificationDeliveries([
        { ...stagingRows[0]!, provider: 'resend', provider_response_code: '401', failure_category: 'configuration', attempts: 1, max_attempts: 5 },
      ]),
    );
    assert.match(config!, /CONFIGURATION failure/);

    const permanent = deliveryFailureHint(
      summariseNotificationDeliveries([
        { ...stagingRows[0]!, provider_response_code: '550', failure_category: 'permanent', attempts: 1, max_attempts: 5 },
      ]),
    );
    assert.match(permanent!, /PERMANENT/);

    const stale = deliveryFailureHint(
      summariseNotificationDeliveries([
        { ...stagingRows[0]!, failure_category: 'stale', attempts: 2, max_attempts: 5 },
      ]),
    );
    assert.match(stale!, /UNKNOWN/);
  });

  it('says nothing when everything was delivered', () => {
    const summary = summariseNotificationDeliveries([
      {
        channel: 'email',
        provider: 'resend',
        provider_response_code: '200',
        status: 'delivered',
        attempts: 1,
        max_attempts: 5,
        failure_category: 'none',
        delivered_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    assert.equal(summary.delivered, 1);
    assert.equal(summary.exhausted, 0);
    assert.equal(deliveryFailureHint(summary), null);
    assert.equal(deliveryFailureHint(summariseNotificationDeliveries([])), null);
  });

  /**
   * Only the dead letter counts as failed. `pending`/`processing` are work in
   * flight, `unavailable` is parked until the channel is configured (and is
   * re-queued automatically), `delivered` succeeded. A reviewer caught the
   * earlier version counting in-flight rows: they carry a null response code and
   * a `timeout` category too, so the status is the only thing that separates
   * them from a real failure.
   */
  it('counts only dead-lettered rows as failed, never pending, processing or unavailable work', () => {
    const rows = [
      { channel: 'email', provider: 'smtp', provider_response_code: null, status: 'pending', attempts: 1, max_attempts: 5, failure_category: 'timeout', delivered_at: null },
      { channel: 'email', provider: 'smtp', provider_response_code: null, status: 'processing', attempts: 2, max_attempts: 5, failure_category: 'transient', delivered_at: null },
      { channel: 'email', provider: null, provider_response_code: null, status: 'unavailable', attempts: 0, max_attempts: 5, failure_category: 'configuration', delivered_at: null },
    ];
    const summary = summariseNotificationDeliveries(rows);
    assert.equal(summary.total, 3);
    assert.equal(summary.neverDelivered, 3, 'none of these is delivered');
    assert.equal(summary.failedWithoutProviderResponse, 0, 'in-flight rows were counted as failed');
    assert.equal(summary.exhausted, 0);
    assert.deepEqual(summary.byStatus, { pending: 1, processing: 1, unavailable: 1 });
    const hint = deliveryFailureHint(summary);
    // Nothing is dead-lettered, so the interpretation may only be the retry note.
    assert.ok(
      hint === null || /only a `failed` row is terminal/.test(hint),
      `in-flight work was described as a dead letter: ${hint}`,
    );
    assert.ok(!/CONFIGURATION failure/.test(hint ?? ''), 'a parked (`unavailable`) row is not a refusal');
  });

  it('counts a dead letter that exhausted its budget, and not a one-attempt rejection', () => {
    const summary = summariseNotificationDeliveries([
      // dead letter, budget exhausted, no response code ever recorded
      { ...stagingRows[0]! },
      // dead letter on the first attempt, provider answered 550
      { ...stagingRows[0]!, status: 'failed', attempts: 1, max_attempts: 5, failure_category: 'permanent', provider_response_code: '550' },
    ]);
    assert.equal(summary.failedWithoutProviderResponse, 1);
    assert.equal(summary.exhausted, 1);
    assert.deepEqual(summary.byStatus, { failed: 2 });
  });

  it('keeps a delivered row out of every failure count even with no response code', () => {
    const summary = summariseNotificationDeliveries([
      { channel: 'email', provider: 'smtp', provider_response_code: null, status: 'delivered', attempts: 3, max_attempts: 5, failure_category: 'none', delivered_at: '2026-01-01T00:00:00.000Z' },
    ]);
    assert.equal(summary.delivered, 1);
    assert.equal(summary.neverDelivered, 0);
    assert.equal(summary.failedWithoutProviderResponse, 0);
    assert.equal(summary.exhausted, 0);
    assert.equal(deliveryFailureHint(summary), null);
  });

  it('does not call an unfinished row terminal even at its last allowed attempt', () => {
    // `pending` at attempts = max_attempts cannot be claimed again, but it is not
    // a dead letter until the worker writes `failed`; it must not inflate the count.
    const summary = summariseNotificationDeliveries([
      { channel: 'email', provider: 'smtp', provider_response_code: null, status: 'pending', attempts: 5, max_attempts: 5, failure_category: 'timeout', delivered_at: null },
    ]);
    assert.equal(summary.exhausted, 0);
    assert.equal(summary.failedWithoutProviderResponse, 0);
  });

  it('names exactly one terminal failure status', () => {
    assert.deepEqual([...FAILED_DELIVERY_STATUSES], ['failed']);
    assert.equal(isFailedDeliveryStatus('failed'), true);
    for (const status of ['pending', 'processing', 'delivered', 'unavailable', 'unknown', '']) {
      assert.equal(isFailedDeliveryStatus(status), false, `${status || '(empty)'} must not count as failed`);
    }
  });

  /** Minimal complete Evidence, so this case does not depend on another block. */
  function minimalEvidence(): Parameters<typeof renderMarkdown>[0] {
    return {
      generatedAt: '2026-01-01T00:00:00.000Z',
      target: { strategy: 's', version: 8, symbol: 'XAUUSD', assetClass: 'commodity', outDir: 'o' },
      safety: {
        connectionOpenedWithDefaultTransactionReadOnly: true,
        everyQueryRanInsideBeginReadOnly: true,
        secretsRedacted: true,
      },
      declaredNotVerified: { triggersNothing: ['no ScannerService'] },
      connection: {
        database: 'db',
        serverVersion: 'PostgreSQL 16',
        tlsRequestedMode: 'verify-full',
        tlsClient: {
          encrypted: true,
          authorized: true,
          authorizationError: null,
          protocol: 'TLSv1.3',
          cipher: 'TLS_AES_256_GCM_SHA384',
          servername: 'db.example.test',
          peerCertificateSha256: 'AA:BB',
          peerCertificateSubject: 'CN=db.example.test',
          peerCertificateIssuer: 'CN=test-ca',
          peerCertificateValidTo: 'Jan  1 00:00:00 2030 GMT',
        },
        tlsVerified: true,
        pooledEndpoint: false,
        ssl: true,
        tlsNote: null,
        defaultTransactionReadOnly: 'on',
        transactionReadOnly: 'on',
        isSuperuser: 'off',
        statementTimeout: '30s',
        privileges: { 'INSERT on setups': false },
      },
      migrations: [],
      candidateStrategies: [],
      versions: [],
      v8: { found: false, id: null, status: null, publishedAt: null, changelog: null },
      timeframes: [],
      risk: null,
      marketScope: null,
      conditions: [],
      conditionRoleResolution: [],
      liquiditySweepFocus: { count: 0, entries: [] },
      sessionFilters: [],
      filters: [],
      instrument: null,
      candleCoverage: [],
      setups: { total: 0, byState: [], latest: [], scores: [], stateEvents: [] },
      alerts: [],
      alertDeliveries: [],
      notificationDeliveries: [],
      scannerRuns: [],
      scannerCursors: [],
      notes: [],
    } as unknown as Parameters<typeof renderMarkdown>[0];
  }

  it('renders the summary and the hint into the report without a recipient', () => {
    const base = minimalEvidence();
    const md = renderMarkdown({
      ...base,
      notificationDeliveries: stagingRows.map((r) => ({
        alert_id: r.alert_id,
        channel: r.channel,
        template: 'alert.confirmed.v1',
        provider: r.provider,
        provider_response_code: r.provider_response_code,
        status: r.status,
        attempts: r.attempts,
        max_attempts: r.max_attempts,
        failure_category: r.failure_category,
        last_error: 'Timeout',
        next_attempt_at: '2026-01-01T00:00:00.000Z',
        delivered_at: r.delivered_at,
        created_at: '2026-01-01T00:00:00.000Z',
      })),
    } as unknown as Parameters<typeof renderMarkdown>[0]);

    assert.match(md, /Delivery summary \(counts only\)/);
    assert.match(md, /\| attempts \| exhausted the attempt budget \| 2 \|/);
    assert.match(md, /Interpretation \(static text, derived from the counts above\)/);
    assert.match(md, /dead-lettered with no complete provider response recorded/);
    assert.match(md, /no complete provider response recorded/i);
    assert.ok(!/NO reply from the provider/i.test(md), 'the report claims the provider never replied');
    assert.ok(!/Nothing was accepted/i.test(md), 'the report claims nothing was accepted');
    assert.ok(!md.includes('@'), 'the report contains something address-like');
  });
});
