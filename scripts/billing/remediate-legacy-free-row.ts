#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:remediate:legacy-free-row` — the OUT-OF-BAND OPERATOR
 * REMEDIATION for a legacy free placeholder row.
 *
 *   tsx scripts/billing/remediate-legacy-free-row.ts --user <email|uuid> --by <operator-id> --reason <text>
 *   tsx scripts/billing/remediate-legacy-free-row.ts --user <email|uuid> --by <operator-id> --reason <text> --apply
 *
 * WHY THIS EXISTS. Accounts created before Model C (the 0014 backfill, or the
 * removed eager registration path) carry a `free`/`active` `subscriptions` row
 * with `locked_pricing_snapshot_id IS NULL`. Migration 0032 makes the lock
 * immutable at creation, so such a row can never become commercial — it can
 * only make the first checkout fail closed with `pricing_lock_required`
 * (HTTP 409). `docs/billing.md` says those rows "are handled by operators out
 * of band"; this CLI is that handling, and it is the ONLY thing that performs
 * it. There is no HTTP route, no admin role, no job and no automatic
 * behaviour: a deployment never runs it, a user session can never reach it, and
 * the database connection is the whole trust boundary.
 *
 * It is a THIN wrapper over `BillingLegacyFreeRowRemediationService`
 * (packages/core/src/billing/legacy-free-row-remediation.ts): it parses
 * arguments, connects, calls the service and prints the outcome. It holds no
 * authority of its own.
 *
 * WHAT IT NEVER DOES
 *  - it never weakens, bypasses or edits the pricing lock (0032's trigger is
 *    untouched — it is a BEFORE UPDATE guard and this tool only DELETEs);
 *  - it never UPDATEs anything: not the row, not `users.plan`, not an epoch;
 *  - it never deletes a sold row or any payment evidence: only a placeholder
 *    with no provider identity, no lock, no period/cancellation/sync fact and
 *    ZERO rows in the three tables that reference `subscriptions` ON DELETE
 *    CASCADE is removable, and anything else refuses (exit 1);
 *  - it never calls Paystack or any provider, holds no transport and reads no
 *    key: a placeholder row carries no provider domain, so the only
 *    configuration is `DATABASE_URL` (no `PAYSTACK_MODE` is consulted, and
 *    none is needed);
 *  - it never enables execution or changes an entitlement: the removed row and
 *    no row resolve to the identical free state.
 *
 * SAFE BY DEFAULT. Without `--apply` this is a read-only dry run: the whole
 * operation is validated and nothing is written. `--apply` commits exactly one
 * DELETE plus its `billing.legacy_free_row_removed` audit event, in one
 * transaction — there is no unattributed removal.
 *
 * Exit codes: 0 on a dry run, a recorded removal, or an account that already
 * has no row (`absent` — the supported free state); 1 on a typed refusal
 * (nothing was written); 2 on a usage error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@veltrixeye/core';
import {
  BillingLegacyFreeRowRemediationService,
  isBillingLegacyFreeRowRemediationError,
} from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = [
  'Usage:',
  '  npm run billing:remediate:legacy-free-row -- --user <email|uuid> --by <operator-id> --reason <text> [--apply]',
  '',
  'Removes ONE legacy free placeholder subscription row (plan=free, provider-less,',
  'locked_pricing_snapshot_id IS NULL) so the account can check out again. The free',
  'state is the ABSENCE of a commercial record, so removal changes no entitlement.',
  '',
  'Without --apply this is a read-only dry run: everything is validated, nothing is',
  'written. --apply commits the DELETE and its audit event together.',
  '',
  'Refuses (writes nothing) unless the row is exactly that placeholder: a sold row,',
  'a provider-backed row, a locked row, a row with period/cancellation/sync facts or',
  'any payment evidence, and an account whose users.plan is not free, all refuse.',
].join('\n');

/** Read a single KEY from the repo-root `.env`, if that file exists. */
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

interface Args {
  user?: string;
  by?: string;
  reason?: string;
  apply: boolean;
  /** Set when `--dry-run` was passed explicitly (the default is a dry run). */
  dryRunExplicit?: boolean;
}

class UsageError extends Error {}

function splitFlag(token: string): [string, string | undefined] {
  const equals = token.indexOf('=');
  if (equals === -1) return [token, undefined];
  return [token.slice(0, equals), token.slice(equals + 1)];
}

/** Minimal, explicit flag parser: no positional arguments, no defaults. */
function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--help' || token === '-h') throw new UsageError('help');
    const [flag, inlineValue] = token.startsWith('--') ? splitFlag(token) : [token, undefined];
    // The one boolean flag pair: `--apply` commits; `--dry-run` is its explicit
    // (default) opposite. Both refuse an inline value.
    if (flag === '--apply' || flag === '--dry-run') {
      if (inlineValue !== undefined) throw new UsageError(`${flag} takes no value`);
      if (flag === '--apply') {
        if (args.dryRunExplicit) throw new UsageError('--apply and --dry-run are mutually exclusive');
        args.apply = true;
      } else {
        if (args.apply) throw new UsageError('--apply and --dry-run are mutually exclusive');
        args.dryRunExplicit = true;
      }
      continue;
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    switch (flag) {
      case '--user':
        args.user = value;
        break;
      case '--by':
        args.by = value;
        break;
      case '--reason':
        args.reason = value;
        break;
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }
  return args;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.info(USAGE);
      if (error.message !== 'help') console.error(`[billing:remediate:legacy-free-row] ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (args.user === undefined || args.by === undefined || args.reason === undefined) {
    console.info(USAGE);
    console.error(
      '[billing:remediate:legacy-free-row] --user, --by and --reason are all required.',
    );
    return 2;
  }

  const databaseUrl = env('DATABASE_URL');
  if (!databaseUrl) {
    console.error(
      '[billing:remediate:legacy-free-row] DATABASE_URL is not set.\n' +
        '        Provide it in the environment, or run `npm run setup` to create a local .env.\n' +
        '        See docs/environment.md.',
    );
    return 2;
  }

  const pool = createPool({ databaseUrl });
  try {
    const service = new BillingLegacyFreeRowRemediationService({ db: pool });
    const result = await service.remediate({
      user: args.user,
      operatorId: args.by,
      reason: args.reason,
      apply: args.apply,
    });
    console.info(
      JSON.stringify(
        {
          outcome: result.outcome,
          applied: result.applied,
          account: { userId: result.userId, email: result.email },
          removedSubscription: result.row,
          auditAction: result.auditAction,
          removedAt: result.removedAt,
        },
        null,
        2,
      ),
    );
    // Operator guidance goes to STDERR on purpose: stdout is exactly one JSON
    // document, so an operator's shell can parse it without stripping prose.
    if (result.outcome === 'dry_run') {
      console.error(
        '\nDry run: the row IS a removable legacy free placeholder. Nothing was written.\n' +
          'Re-run with --apply to remove it (one DELETE plus one audit event, together).',
      );
    } else if (result.outcome === 'absent') {
      console.error(
        '\nNothing to remediate: this account has no subscriptions row, which IS the\n' +
          'supported free state. A row-less checkout prices against the active epoch.',
      );
    }
    return 0;
  } catch (error) {
    if (isBillingLegacyFreeRowRemediationError(error)) {
      console.error(
        `[billing:remediate:legacy-free-row] refused (${error.reason}): ${error.message}`,
      );
      if (error.failedPredicates !== undefined && error.failedPredicates.length > 0) {
        console.error(`        failed predicates: ${error.failedPredicates.join(', ')}`);
      }
      console.error('        Nothing was written: the subscription row, the audit log and every');
      console.error('        other row are unchanged.');
      return 1;
    }
    console.error(
      '[billing:remediate:legacy-free-row] failed:',
      error instanceof Error ? error.message : error,
    );
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
