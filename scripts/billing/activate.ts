#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:activate` — the OUT-OF-BAND ACTIVATION AUTHORITY.
 *
 *   tsx scripts/billing/activate.ts --user <email|uuid> --by <operator-id> --reason <text>
 *   tsx scripts/billing/activate.ts --user <email|uuid> --by <operator-id> --reason <text> --evidence <uuid>
 *
 * This CLI is the ONLY way an activation fact is ever written. It is a THIN
 * wrapper over `BillingActivationService` (packages/core/src/billing/activation.ts):
 * it parses arguments, connects to the database, calls the service and prints
 * the outcome. It holds no authority of its own.
 *
 * WHY A CLI AND NOT AN ENDPOINT. Activation is an operator decision, taken out
 * of band, by a named human with a stated reason. There is deliberately no
 * HTTP route, no admin role, no operator endpoint and no activation token, so
 * no user session — however privileged — can reach it, and no client payload
 * can supply a payment confirmation. The database connection is the whole
 * trust boundary.
 *
 * WHAT IT NEVER DOES
 *  - it never calls Paystack or any provider (the service holds no provider);
 *  - it never writes `subscriptions`, `users`, entitlements or execution;
 *  - it never enables execution: `canAccessAutomation` stays false for every plan;
 *  - it reads no secret and creates none: the only configuration is
 *    `DATABASE_URL`, exactly like `npm run db:migrate`.
 *
 * Exit codes: 0 on a recorded or replayed activation, 1 on a typed refusal
 * (nothing was written), 2 on a usage error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@veltrixeye/core';
import {
  BillingActivationService,
  isBillingActivationError,
} from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = [
  'Usage:',
  '  npm run billing:activate -- --user <email|uuid> --by <operator-id> --reason <text> [--evidence <uuid>]',
  '',
  'Activates one commercial subscription after its payment evidence has been verified.',
  'Requires an explicit operator identity and reason; writes exactly one immutable',
  'activation fact plus its audit event, or replays the existing fact.',
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
  evidence?: string;
}

/** Minimal, explicit flag parser: no positional arguments, no defaults. */
function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const [flag, inlineValue] = token.startsWith('--') ? splitFlag(token) : [token, undefined];
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
      case '--evidence':
        args.evidence = value;
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
      if (error.message !== 'help') console.error(`[billing:activate] ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (args.user === undefined || args.by === undefined || args.reason === undefined) {
    console.info(USAGE);
    console.error('[billing:activate] --user, --by and --reason are all required.');
    return 2;
  }

  const databaseUrl = env('DATABASE_URL');
  if (!databaseUrl) {
    console.error(
      '[billing:activate] DATABASE_URL is not set.\n' +
        '        Provide it in the environment, or run `npm run setup` to create a local .env.\n' +
        '        See docs/environment.md.',
    );
    return 2;
  }

  const pool = createPool({ databaseUrl });
  try {
    const service = new BillingActivationService({ db: pool });
    const result = await service.activate({
      user: args.user,
      operatorId: args.by,
      reason: args.reason,
      evidenceId: args.evidence ?? null,
    });
    const { activation } = result;
    console.info(
      JSON.stringify(
        {
          outcome: result.outcome,
          replayed: result.replayed,
          activation: {
            id: activation.id,
            userId: activation.userId,
            subscriptionId: activation.subscriptionId,
            pricingSnapshotId: activation.pricingSnapshotId,
            evidenceId: activation.evidenceId,
            cataloguePlan: activation.cataloguePlan,
            billingInterval: activation.billingInterval,
            provider: activation.provider,
            providerReference: activation.providerReference,
            paymentCurrency: activation.paymentCurrency,
            paymentAmountMinor: activation.paymentAmountMinor,
            paymentAmountExponent: activation.paymentAmountExponent,
            evidenceHash: activation.evidenceHash,
            operatorId: activation.operatorId,
            activationReason: activation.activationReason,
            activatedAt: activation.activatedAt,
            idempotencyKey: activation.idempotencyKey,
          },
          paymentConfirmed: result.paymentConfirmed,
          grantsExecution: result.grantsExecution,
          planChanged: result.planChanged,
          entitlementsChanged: result.entitlementsChanged,
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    if (isBillingActivationError(error)) {
      console.error(
        `[billing:activate] refused (${error.reason}): ${error.message}\n` +
          '        Nothing was written: the activation, its audit event and every other',
      );
      console.error('        row are unchanged.');
      return 1;
    }
    console.error('[billing:activate] failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
