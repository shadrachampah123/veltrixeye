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
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

import { startEmbeddedPostgres, stopEmbeddedPostgres } from '../../db/embedded.mjs';
import {
  ALLOWED_URL_PARAMS,
  Q_CONNECTION,
  WRITE_PRIVILEGE_COLUMNS,
  ReadOnlySession,
  anyStringLeaks,
  chooseStrategy,
  chooseVersion,
  connectionUrlProblem,
  errorCodeOf,
  evaluateSafety,
  factsFromConnectionRow,
  OptionError,
  isStrategyUuid,
  jsonBlock,
  mapStrings,
  mdCell,
  mdRow,
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
function runCli(
  env: Record<string, string | undefined>,
  args: readonly string[] = [
    '--strategy',
    'Gold Break & Retest Test Pro VI',
    '--version',
    '8',
    '--symbol',
    'XAUUSD',
    '--asset-class',
    'commodity',
  ],
): CliRun {
  const outDir = mkdtempSync(join(tmpdir(), 'gold-diag-test-'));
  workDirs.push(outDir);

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
});

// ---------------------------------------------------------------------------
// 4. TLS environment-variable refusals (pure)
// ---------------------------------------------------------------------------

describe('TLS environment overrides are refused', () => {
  it('accepts a clean environment', () => {
    assert.equal(tlsEnvProblem({ PATH: '/usr/bin', HOME: '/root' }), null);
    assert.equal(tlsEnvProblem({ NODE_TLS_REJECT_UNAUTHORIZED: '1' }), null);
  });

  const refused: Array<[string, string]> = [
    ['NODE_TLS_REJECT_UNAUTHORIZED=0', 'NODE_TLS_REJECT_UNAUTHORIZED'],
    ['PGSSLMODE=disable', 'PGSSLMODE'],
    ['PGSSLROOTCERT', 'PGSSLROOTCERT'],
    ['PGSSLCERT', 'PGSSLCERT'],
    ['PGSSLKEY', 'PGSSLKEY'],
    ['PGSSLCRL', 'PGSSLCRL'],
    ['PGSSLNEGOTIATION', 'PGSSLNEGOTIATION'],
    ['PGREQUIRESSL', 'PGREQUIRESSL'],
  ];

  for (const [name, variable] of refused) {
    it(`refuses ${name}`, () => {
      const problem = tlsEnvProblem({ [variable]: variable === 'NODE_TLS_REJECT_UNAUTHORIZED' ? '0' : 'x' });
      assert.notEqual(problem, null, `expected a refusal for ${name}`);
      assert.match(problem!, new RegExp(variable));
    });
  }
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
    for (const value of ['abc', '9x', '0', '-3', '-0', '8.5', '', ' ', '1e3', '+8', '08x', '0x10', 'Infinity', 'NaN']) {
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
    assert.equal(parseOptions(['--strategy', 's']).version, 8);
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
      connection: null,
      migrations: [],
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

  it('escapes every dynamic cell in the strategy and version tables', () => {
    const md = renderMarkdown(evidenceWithHostileRows());
    const lines = md.split('\n');

    // A hostile value can neither open a fence nor add a table column/row.
    assert.equal(lines.filter((l) => l.startsWith('```')).length, 0, 'a fence was injected at line start');
    assert.ok(!md.includes('pipe|column'), 'an unescaped pipe reached the report');
    assert.ok(md.includes('pipe\\|column'), 'the pipe was not escaped');

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

  it('refuses an invalid --version with exit 2, before connecting', () => {
    for (const value of ['abc', '9x', '0', '-3', '8.5']) {
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
