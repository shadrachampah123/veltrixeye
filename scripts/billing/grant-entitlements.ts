#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:grant` — the OUT-OF-BAND NON-COMMERCIAL GRANT AUTHORITY.
 *
 *   tsx scripts/billing/grant-entitlements.ts --user <email|uuid> --plan pro|premium \
 *       --by <operator-id> --reason <text> [--dry-run]
 *
 * WHY THIS EXISTS. The payment-confirmation authority (`npm run
 * billing:activate`) is deliberately unreachable for an account that has not
 * paid: it refuses with `payment_evidence_not_found` unless a row exists in
 * `billing_verified_transactions`, and the only writer of that table performs a
 * REAL provider read and demands a successful, exactly-reconciled transaction.
 * That is correct — and it means the designated owner/super-admin account, who
 * receives the commercial benefit without a purchase, cannot be reached through
 * it. Manufacturing the evidence to get around that would be fabricating
 * payment evidence.
 *
 * So this is a SEPARATE authority, not a shortcut through the payment one. It
 * writes exactly one immutable, non-commercial GRANT fact
 * (`billing_entitlement_grants`, migration 0036) plus its transactional
 * `billing.entitlement_granted` audit event. The fact table has no provider,
 * reference, currency, amount, transaction, evidence or `payment_confirmed`
 * column, so a grant is structurally incapable of being read as a payment.
 *
 * WHY A CLI AND NOT AN ENDPOINT. A grant is an operator decision, taken out of
 * band, by a named human with a stated reason. There is deliberately no HTTP
 * route, no admin role, no operator endpoint and no grant token, so no user
 * session — however privileged — can reach it, and no client payload can
 * manufacture a concession. The database connection is the whole trust
 * boundary, exactly as for `billing:activate`.
 *
 * SAFE BY DEFAULT. Without `--dry-run` the operation is validated and NOTHING
 * is written. With it, exactly one grant fact and one audit event commit
 * together in a single transaction. A replay is safe and returns the existing
 * fact (`already_granted`).
 *
 * WHAT IT NEVER DOES
 *  - it never calls Paystack or any provider (the service holds no provider);
 *  - it never writes `subscriptions`, `users.plan`, an entitlement, an
 *    activation, payment evidence, a pricing snapshot, an epoch or an FX rate;
 *  - it never confirms a payment: `paymentConfirmed` stays derived from the
 *    activation fact (0034) and therefore stays `false` for a granted account;
 *  - it never enables execution: `canAccessAutomation` stays `false` and
 *    automation / live / broker execution stay OFF;
 *  - it reads no secret and creates none: the only configuration is
 *    `DATABASE_URL`. It never reads `PAYSTACK_MODE` or a key — a non-commercial
 *    grant belongs to no provider domain.
 *
 * Exit codes: 0 on a dry run, a recorded grant, or a replay; 1 on a typed
 * refusal (nothing was written); 2 on a usage error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@veltrixeye/core';
import {
  BillingEntitlementGrantService,
  GRANTABLE_ENTITLEMENT_PLANS,
  isBillingEntitlementGrantError,
} from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = [
  'Usage:',
  '  npm run billing:grant -- --user <email|uuid> --plan pro|premium --by <operator-id> --reason <text> [--dry-run]',
  '',
  'Grants one account a commercial entitlement tier WITHOUT a purchase.',
  'Requires an explicit operator identity and reason; writes exactly one immutable',
  'non-commercial grant fact plus its audit event, or replays the existing fact.',
  '',
  'This is not a payment: nothing is charged, no provider is contacted, and the',
  `account still reports paymentConfirmed: false. Grantable tiers: ${GRANTABLE_ENTITLEMENT_PLANS.join(' | ')}.`,
  'Without --dry-run nothing is written; with it, the fact and its audit event commit together.',
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
  plan?: string;
  by?: string;
  reason?: string;
  dryRun?: boolean;
}

/** Minimal, explicit flag parser: no positional arguments, no defaults. */
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const [flag, inlineValue] = token.startsWith('--') ? splitFlag(token) : [token, undefined];
    // Boolean flags take no value.
    if (inlineValue === undefined && (flag === '--dry-run' || flag === '--apply')) {
      args.dryRun = flag === '--dry-run';
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
      case '--plan':
        args.plan = value;
        break;
      case '--by':
        args.by = value;
        break;
      case '--reason':
        args.reason = value;
        break;
      case '--help':
      case '-h':
        throw new UsageError('help');
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function splitFlag(token: string): [string, string | undefined] {
  const equals = token.indexOf('=');
  if (equals === -1) return [token, undefined];
  return [token.slice(0, equals), token.slice(equals + 1)];
}

class UsageError extends Error {}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.info(USAGE);
      if (error.message !== 'help') console.error(`[billing:grant] ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (args.user === undefined || args.plan === undefined || args.by === undefined || args.reason === undefined) {
    console.info(USAGE);
    console.error('[billing:grant] --user, --plan, --by and --reason are all required.');
    return 2;
  }

  const databaseUrl = env('DATABASE_URL');
  if (!databaseUrl) {
    console.error(
      '[billing:grant] DATABASE_URL is not set.\n' +
        '        Provide it in the environment, or run `npm run setup` to create a local .env.\n' +
        '        See docs/environment.md.',
    );
    return 2;
  }

  const pool = createPool({ databaseUrl });
  try {
    const service = new BillingEntitlementGrantService({ db: pool, dryRun: args.dryRun === true });
    const result = await service.grant({
      user: args.user,
      plan: args.plan,
      operatorId: args.by,
      reason: args.reason,
    });
    const { grant } = result;
    console.info(
      JSON.stringify(
        {
          outcome: result.outcome,
          dryRun: result.dryRun,
          grant: {
            id: grant.id,
            userId: grant.userId,
            userEmail: result.userEmail,
            plan: grant.plan,
            kind: grant.kind,
            operatorId: grant.operatorId,
            grantReason: grant.grantReason,
            grantedAt: grant.grantedAt,
            idempotencyKey: grant.idempotencyKey,
          },
          paymentConfirmed: result.paymentConfirmed,
          planChanged: result.planChanged,
          entitlementsChanged: result.entitlementsChanged,
          grantsExecution: result.grantsExecution,
          canAccessAutomation: result.canAccessAutomation,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    if (isBillingEntitlementGrantError(error)) {
      console.error(
        `[billing:grant] refused (${error.reason}): ${error.message}\n` +
          '        Nothing was written: the grant, its audit event and every other',
      );
      console.error('        row are unchanged.');
      return 1;
    }
    console.error('[billing:grant] failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
