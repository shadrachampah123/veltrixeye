/**
 * `billing:fx:publish` — the operator publication CLI (D10).
 *
 * Pins the CLI's safety surface, statically and behaviourally:
 *
 *  - **dry run by default**: without `--apply` the CLI calls `assess()` only, and
 *    the source contains no unconditional `publish()` call;
 *  - **explicit apply authorization**: `--apply` is the only commit path, and no
 *    other flag (or environment value) can stand in for it;
 *  - **the loopback write gate runs BEFORE the pool exists** — a
 *    production/remote/unverified `DATABASE_URL` is refused with the pool
 *    unconstructed, so no connection and no write can occur, and the configured
 *    target is never echoed;
 *  - **every refusal states plainly that nothing was published**;
 *  - **the CLI holds no epoch, price or provider path**: it cannot register or
 *    rotate an epoch, touch a Paystack plan, or move a customer-facing price.
 *
 * The behavioural tests execute the real CLI as a subprocess. They are
 * deliberately constructed so that NO database is ever contacted: the
 * loopback-gate test supplies an unroutable remote URL that must be refused
 * before any connection is attempted, and the other paths exit during argument
 * or configuration handling.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'billing', 'fx-publish.ts');

/** The CLI source with comments stripped (matches the repo's source-pin style). */
function cliSource(): string {
  return readFileSync(CLI_PATH, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: readonly string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, ...args],
      { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('the CLI is dry-run by default (D10)', () => {
  test('the commit path exists only behind --apply', () => {
    const cli = cliSource();
    assert.match(cli, /--apply/, 'the commit path exists behind an explicit flag');
    assert.match(cli, /if \(!args\.apply\)/, 'the default branch is the dry run');
    assert.match(cli, /service\.assess\(/, 'the dry run goes through the read-only assessment');
    assert.match(cli, /service\.publish\(/, 'the apply path goes through the publishing service');
    // The publish call is reachable only after the apply branch.
    assert.ok(
      cli.indexOf('if (!args.apply)') < cli.indexOf('service.publish('),
      'the dry-run branch precedes the publish call',
    );
  });

  test('the dry run says plainly that nothing was written', () => {
    assert.match(cliSource(), /Nothing was written/);
    assert.match(cliSource(), /Nothing was published/);
  });

  test('--dry-run and --apply are mutually exclusive', () => {
    const cli = cliSource();
    assert.match(cli, /--apply and --dry-run are mutually exclusive/);
  });
});

describe('the loopback write gate precedes the pool (D10)', () => {
  test('the gate is evaluated BEFORE any pool is created, and only for --apply', () => {
    const cli = cliSource();
    assert.match(cli, /loopback/, 'the write gate is a verified-local (loopback) allowlist');
    assert.match(cli, /production or unverified/, 'the refusal states the rule, not the target');
    assert.ok(
      cli.indexOf('localDatabaseTargetRejection(databaseUrl)') < cli.indexOf('createPool({ databaseUrl })'),
      'the database-target gate precedes pool creation',
    );
    assert.match(cli, /if \(args\.apply\)/, 'the database gate belongs to --apply only');
  });

  test('a remote DATABASE_URL is refused before any connection, and never echoed', () => {
    const remote = 'postgres://user:sup3rsecret@db.production.example.com:5432/veltrixeye';
    const result = runCli(
      [
        '--rate', '12.550000',
        '--reference', 'BoG daily interbank FX, 2026-10-15; ticket FX-1042',
        '--reason', 'Re-adopt the corroborated USD to GHS rate for this business day.',
        '--by', 'operator-executor',
        '--approver', 'operator-approver-one',
        '--approver', 'operator-approver-two',
        '--captured-at', '2026-10-15T09:00:00.000Z',
        '--apply',
      ],
      { DATABASE_URL: remote },
    );
    assert.equal(result.status, 2, 'a non-loopback target is a configuration error');
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /loopback/i, 'the refusal states the rule');
    assert.doesNotMatch(output, /db\.production\.example\.com/, 'the configured target is never echoed');
    assert.doesNotMatch(output, /sup3rsecret/, 'no credential fragment is echoed');
    assert.match(output, /Nothing was written/, 'the refusal is explicit that nothing happened');
  });

  test('a missing DATABASE_URL is refused without connecting anywhere', () => {
    const result = runCli([
      '--rate', '12.550000',
      '--reference', 'BoG daily interbank FX, 2026-10-15; ticket FX-1042',
      '--reason', 'Re-adopt the corroborated USD to GHS rate for this business day.',
      '--by', 'operator-executor',
      '--approver', 'operator-approver-one',
      '--approver', 'operator-approver-two',
      '--captured-at', '2026-10-15T09:00:00.000Z',
    ]);
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}${result.stderr}`, /DATABASE_URL is required/);
  });
});

describe('argument handling fails closed', () => {
  test('--help prints the usage and exits 2 without touching anything', () => {
    const result = runCli(['--help']);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--apply/);
    assert.match(result.stdout, /two DIFFERENT names/i, 'the two-person rule is stated in the usage');
  });

  test('an unknown argument is refused', () => {
    const result = runCli(['--publish-now']);
    assert.equal(result.status, 2);
    assert.match(`${result.stdout}${result.stderr}`, /Unknown argument/);
  });

  test('the usage states the 900-second bound and the price-isolation guarantee', () => {
    const result = runCli(['--help']);
    assert.match(result.stdout, /900-second freshness bound/);
    assert.match(result.stdout, /never changes a customer-facing price/);
    assert.match(result.stdout, /separately approved/);
  });
});

describe('the CLI holds no epoch, price or provider path (D8, D9)', () => {
  test('it cannot register or rotate an epoch, or touch a Paystack plan', () => {
    const cli = cliSource();
    assert.doesNotMatch(cli, /BillingPlanProvisioningService/, 'no provisioning service');
    assert.doesNotMatch(cli, /registerSandboxPlanEpochs|registerLivePlanEpochs/, 'no epoch registration');
    assert.doesNotMatch(cli, /\.retire\s*\(/, 'no epoch retirement');
    assert.doesNotMatch(cli, /billing_provider_plans/, 'no epoch table');
    assert.doesNotMatch(cli, /UPDATE\s+billing_|DELETE\s+FROM/i, 'no update or delete statement');
  });

  test('it never fetches a rate and never reads a provider credential', () => {
    const cli = cliSource();
    assert.doesNotMatch(cli, /\bfetch\s*\(/, 'no external call: the rate is supplied evidence');
    assert.doesNotMatch(cli, /PAYSTACK_SECRET_KEY|sk_live_/, 'no provider credential');
  });

  test('the only environment value it reads is DATABASE_URL', () => {
    const cli = cliSource();
    const keys = [...cli.matchAll(/env\('([A-Z0-9_]+)'\)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(keys)], ['DATABASE_URL']);
  });
});

describe('the npm script is wired to the CLI', () => {
  test('billing:fx:publish runs this file', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts['billing:fx:publish'], 'tsx scripts/billing/fx-publish.ts');
  });

  test('the existing provisioning CLI keeps its own script and its loopback gate', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.equal(pkg.scripts['billing:provision:sandbox'], 'tsx scripts/billing/provision-sandbox.ts');
    // The shared guard was extracted, not duplicated: the provisioning CLI must
    // still consult it, and must still consult it before creating a pool.
    const provisioning = readFileSync(path.join(REPO_ROOT, 'scripts', 'billing', 'provision-sandbox.ts'), 'utf8');
    assert.match(provisioning, /localDatabaseTargetRejection\(databaseUrl\)/);
    assert.ok(
      provisioning.indexOf('localDatabaseTargetRejection(databaseUrl)') <
        provisioning.indexOf('createPool({ databaseUrl })'),
      'the provisioning gate still precedes its pool',
    );
    const guard = readFileSync(path.join(REPO_ROOT, 'scripts', 'billing', 'local-db-guard.ts'), 'utf8');
    assert.match(guard, /export function localDatabaseTargetRejection/);
  });
});
