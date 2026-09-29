#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:provision:live` — the LIVE PLAN-REGISTRATION AUTHORITY.
 *
 *   tsx scripts/billing/provision-live.ts --fx-rate-version <uuid> --by <operator-id> \
 *     --reason <text> --reference <dashboard/ticket label> \
 *     [--dry-run] [--amount <slot>=<GHS minor units>]
 *
 *   (or, instead of `--plan` flags, the four codes from the environment)
 *   PAYSTACK_LIVE_PLAN_CODES='{"pro-monthly":"PLN_…", …}' npm run billing:provision:live -- …
 *
 * The four LIVE Paystack plan codes are SUPPLIED AT RUN TIME — one per slot:
 * `pro-monthly`, `pro-annual`, `elite-monthly`, `elite-annual`. They are the
 * codes the Paystack dashboard issued for plans an operator already created
 * there; this build never creates, updates or reads a provider plan, and no
 * code is ever committed, defaulted or invented here. Supply all four as
 * `--plan <slot>=<PLN_…>` flags, or all four in `PAYSTACK_LIVE_PLAN_CODES`
 * (JSON); mixing the two sources is refused so the provenance of every code is
 * unambiguous.
 *
 * This CLI is a THIN wrapper over `BillingLivePlanRegistrationService`
 * (packages/core/src/billing/live-plan-registration.ts): it parses arguments,
 * checks the configuration, connects to the database, calls the service and
 * prints the outcome. It holds no authority of its own.
 *
 * WHY A CLI AND NOT AN ENDPOINT. Registering a live epoch is an operational
 * decision taken out of band by a named human with a stated reason — exactly
 * like `billing:activate`. There is deliberately no HTTP route, no admin role
 * and no operator token, so no user session can reach it. The database
 * connection is the whole trust boundary.
 *
 * WHAT IT NEVER DOES
 *  - it never calls Paystack or any provider: the plans already exist, the
 *    codes are opaque inputs, and the process holds no transport;
 *  - it never reads a key: the only configuration is `DATABASE_URL`, the
 *    explicit provider domain `PAYSTACK_MODE` (which must be exactly `live`)
 *    and the four supplied codes;
 *  - it never publishes an FX rate, retires an epoch, confirms a payment,
 *    activates a subscription or grants execution — `canAccessAutomation`
 *    stays false and `grantsExecution` stays false for every plan;
 *  - it never writes a live epoch without the transactional
 *    `billing.provider_plans_registered` audit event naming the operator and
 *    the reason: the four epochs and their audit record are one transaction.
 *
 * Exit codes: 0 on a registered batch (or a clean dry run), 1 on a typed
 * refusal (nothing was written), 2 on a usage or configuration error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@veltrixeye/core';
import {
  BillingLivePlanRegistrationService,
  LIVE_PLAN_CODE_KEYS,
  isBillingFxError,
  isBillingLivePlanRegistrationError,
  isBillingProviderPlanError,
  isBillingProvisioningError,
  parseLivePlanCodesConfig,
  type LivePlanCodeKey,
} from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = [
  'Usage:',
  '  npm run billing:provision:live -- --fx-rate-version <uuid> --by <operator-id> --reason <text>',
  '    [--reference <label>] [--dry-run] [--amount <slot>=<minor>]...',
  '  npm run billing:provision:live -- --fx-rate-version <uuid> --by <operator-id> --reason <text> \\',
  '    --plan pro-monthly=PLN_… --plan pro-annual=PLN_… --plan elite-monthly=PLN_… --plan elite-annual=PLN_…',
  '',
  'Registers (or, with --dry-run, validates only) the four LIVE provider-plan epochs for',
  'Pro/Elite × monthly/annual from the four live Paystack plan codes supplied at run time.',
  'Requires PAYSTACK_MODE=live and DATABASE_URL, and writes the four epochs together with',
  'one billing.provider_plans_registered audit event in a single transaction.',
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

class UsageError extends Error {}

interface Args {
  fxRateVersion?: string;
  by?: string;
  reason?: string;
  reference?: string;
  plans: string[];
  amounts: string[];
  dryRun: boolean;
}

/** Minimal, explicit flag parser: no positional arguments, no defaults. */
function parseArgs(argv: string[]): Args {
  const args: Args = { plans: [], amounts: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    const [flag, inlineValue] = token.startsWith('--') ? splitFlag(token) : [token, undefined];
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`${flag} requires a value`);
    }
    switch (flag) {
      case '--fx-rate-version':
        args.fxRateVersion = value;
        break;
      case '--by':
        args.by = value;
        break;
      case '--reason':
        args.reason = value;
        break;
      case '--reference':
        args.reference = value;
        break;
      case '--plan':
        args.plans.push(value);
        break;
      case '--amount':
        args.amounts.push(value);
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

const isLivePlanCodeKey = (value: string): value is LivePlanCodeKey =>
  (LIVE_PLAN_CODE_KEYS as readonly string[]).includes(value);

/** `slot=value` pairs (used for `--plan` and `--amount`), refused on any doubt. */
function parseSlotPairs(entries: readonly string[], flag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const equals = entry.indexOf('=');
    if (equals <= 0) throw new UsageError(`${flag} expects <slot>=<value>, received "${entry}"`);
    const slot = entry.slice(0, equals).trim();
    const value = entry.slice(equals + 1).trim();
    if (!isLivePlanCodeKey(slot)) {
      throw new UsageError(
        `${flag}: unknown slot "${slot}" (accepted: ${LIVE_PLAN_CODE_KEYS.join(', ')})`,
      );
    }
    if (value === '') throw new UsageError(`${flag}: "${slot}" has an empty value`);
    if (result[slot] !== undefined) throw new UsageError(`${flag}: "${slot}" was supplied twice`);
    result[slot] = value;
  }
  return result;
}

/**
 * Resolve the four supplied plan codes: all four `--plan` flags, or all four
 * from `PAYSTACK_LIVE_PLAN_CODES`. Mixing the sources is refused so no code's
 * provenance is ambiguous.
 */
function resolvePlanCodes(args: Args): Record<LivePlanCodeKey, string> {
  const fromFlags = parseSlotPairs(args.plans, '--plan');
  const flagged = Object.keys(fromFlags).length;
  if (flagged > 0 && flagged < LIVE_PLAN_CODE_KEYS.length) {
    throw new UsageError(
      `--plan must supply all four slots (${LIVE_PLAN_CODE_KEYS.join(', ')}), or none when the codes ` +
        'come from PAYSTACK_LIVE_PLAN_CODES',
    );
  }
  if (flagged === LIVE_PLAN_CODE_KEYS.length) {
    return fromFlags as Record<LivePlanCodeKey, string>;
  }

  const configured = env('PAYSTACK_LIVE_PLAN_CODES');
  if (configured === undefined || configured.trim() === '') {
    throw new UsageError(
      'the four live plan codes are missing: supply --plan <slot>=<PLN_…> four times, or set ' +
        'PAYSTACK_LIVE_PLAN_CODES to a JSON object with the four slots. The codes are read from the ' +
        'environment at run time and are never committed to the repository.',
    );
  }
  return parseLivePlanCodesConfig(configured);
}

/** Absolute GHS minor units for `--amount` (admissible only as integers). */
function parseAmounts(args: Args): Record<string, number | string> {
  const pairs = parseSlotPairs(args.amounts, '--amount');
  for (const [slot, value] of Object.entries(pairs)) {
    if (!/^[0-9]+$/.test(value)) {
      throw new UsageError(
        `--amount ${slot}: expected an unsigned integer number of GHS minor units (pesewas), received "${value}"`,
      );
    }
  }
  return pairs;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.info(USAGE);
      if (error.message !== 'help') console.error(`[billing:provision:live] ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (args.fxRateVersion === undefined || args.by === undefined || args.reason === undefined) {
    console.info(USAGE);
    console.error('[billing:provision:live] --fx-rate-version, --by and --reason are all required.');
    return 2;
  }

  const databaseUrl = env('DATABASE_URL');
  if (!databaseUrl) {
    console.error(
      '[billing:provision:live] DATABASE_URL is not set.\n' +
        '        Provide it in the environment, or run `npm run setup` to create a local .env.\n' +
        '        See docs/environment.md.',
    );
    return 2;
  }

  // The configured provider domain, validated fail-closed exactly like the
  // API's PAYSTACK_MODE. LIVE REGISTRATION REQUIRES `live`: a test-mode
  // deployment can never create a live epoch, so the CLI refuses before it
  // connects to the database.
  const modeRaw = env('PAYSTACK_MODE');
  if (modeRaw !== 'live') {
    console.error(
      `[billing:provision:live] PAYSTACK_MODE must be exactly "live" to register live plan epochs ` +
        `(got ${modeRaw === undefined ? 'nothing' : `"${modeRaw}"`}).\n` +
        '        Live epochs are only ever written by a deployment explicitly configured for the live\n' +
        '        provider domain — never by a test-mode run, and never as a fallback.',
    );
    return 2;
  }

  let planCodes: Record<LivePlanCodeKey, string>;
  let observedAmounts: Record<string, number | string>;
  try {
    planCodes = resolvePlanCodes(args);
    observedAmounts = parseAmounts(args);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[billing:provision:live] ${error.message}`);
      return 2;
    }
    if (isBillingLivePlanRegistrationError(error) && error.reason === 'invalid_config') {
      console.error(`[billing:provision:live] ${error.message}`);
      return 2;
    }
    throw error;
  }

  const pool = createPool({ databaseUrl });
  try {
    const service = new BillingLivePlanRegistrationService({ db: pool, mode: 'live' });
    const result = await service.registerLivePlanEpochs({
      fxRateVersionId: args.fxRateVersion,
      planCodes,
      operatorId: args.by,
      reason: args.reason,
      evidenceReference: args.reference ?? `ops-live-plan-registration ${new Date().toISOString()}`,
      ...(Object.keys(observedAmounts).length > 0 ? { observedAmountsMinor: observedAmounts } : {}),
      dryRun: args.dryRun,
    });

    const epochsById = new Map(result.epochs.map((epoch) => [`${epoch.cataloguePlan}-${epoch.interval}`, epoch]));
    console.info(
      JSON.stringify(
        {
          outcome: result.dryRun ? 'dry_run' : 'registered',
          dryRun: result.dryRun,
          mode: result.mode,
          providerCalls: 0,
          fxRateVersionId: result.plan.fxRateVersionId,
          registeredAt: result.plan.registeredAt.toISOString(),
          auditAction: result.dryRun ? null : result.auditAction,
          grantsExecution: false,
          paymentConfirmed: false,
          plan: result.plan.entries.map((entry) => {
            const epoch = epochsById.get(entry.key);
            return {
              slot: entry.key,
              cataloguePlan: entry.cataloguePlan,
              billingInterval: entry.interval,
              providerInterval: entry.providerInterval,
              providerPlanId: entry.providerPlanId,
              paymentCurrency: entry.paymentCurrency,
              paymentAmountMinor: entry.paymentAmountMinor.toString(),
              catalogueAmountMinor: entry.catalogueAmountMinor,
              amountObserved: entry.amountObserved,
              epochId: epoch?.id ?? null,
              status: epoch?.status ?? null,
            };
          }),
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    if (isBillingLivePlanRegistrationError(error)) {
      console.error(
        `[billing:provision:live] refused (${error.reason}): ${error.message}\n` +
          '        Nothing was written: no epoch, no audit event and no other row changed.',
      );
      return 1;
    }
    if (
      isBillingProvisioningError(error) ||
      isBillingProviderPlanError(error) ||
      isBillingFxError(error)
    ) {
      console.error(
        `[billing:provision:live] refused (${error.reason}): ${error.message}\n` +
          '        Nothing was written: the whole four-epoch batch rolls back together.',
      );
      return 1;
    }
    console.error(
      '[billing:provision:live] failed:',
      error instanceof Error ? error.message : error,
    );
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
