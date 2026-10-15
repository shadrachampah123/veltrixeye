#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:provision:sandbox` — the SANDBOX PLAN-PROVISIONING
 * OPERATOR CLI (Billing Step 4's operator entry point), DRY RUN BY DEFAULT.
 *
 *   tsx scripts/billing/provision-sandbox.ts --fx-rate-version <uuid> --by <operator-id> \
 *     --reason <text> --evidence <json> [--apply]
 *
 * WHAT IT IS. A THIN wrapper over `BillingPlanProvisioningService`
 * (packages/core/src/billing/provisioning.ts): it parses arguments, checks the
 * configuration, connects to the database, calls the service and prints the
 * outcome. It holds no authority of its own.
 *  - default (no flag) or `--dry-run` → `validateSandboxPlanEpochs`: the
 *    read-only preparation phase. The selected FX row is read by id and the
 *    complete four-entry batch is validated; NOTHING is written — no epoch,
 *    no audit event, no other row.
 *  - `--apply` → `registerSandboxPlanEpochs`: the identical preparation, then
 *    the four epochs plus ONE transactional
 *    `billing.provider_plans_registered` audit event in a single transaction.
 *
 * EVIDENCE IS SUPPLIED, NEVER ASSEMBLED OR INVENTED HERE. The operator passes
 * the four Step 4 evidence entries as one JSON array, exactly as the runbook
 * in docs/billing.md specifies (`cataloguePlan`, `interval`, `providerInterval`,
 * `providerPlanId`, `paymentCurrency`, `paymentAmountMinor`,
 * `paymentAmountExponent`, `mode`, `paymentCountCap`, `evidenceReference`).
 * Every rule — the four-slot matrix, the exact catalogue × FX amounts, GHS,
 * exponent 2, the explicit interval mapping, uncapped payment counts, unique
 * genuine `PLN_…` codes, the excluded capability-evidence plan, the one shared
 * FX-version identity and the 900-second freshness window — is enforced by the
 * existing authoritative services; this file duplicates none of it.
 *
 * MODE IS A GATE, NEVER A SWITCH. `PAYSTACK_MODE` must be exactly `test`, or
 * the CLI refuses before it connects (exit 2). Live configuration is refused
 * loudly, mode values are never inferred or defaulted, and the service is
 * constructed with the literal `test` — never with a value derived from
 * arguments.
 *
 * FX IS AN INPUT, NEVER AN ACTION. The run names ONE already-published FX
 * version id from the durable authority and refuses anything else (`missing`,
 * `stale`, malformed, not-yet-effective …). This CLI has no publish, approve
 * or rate flag of any kind: FX-source approval stays the separate recorded
 * operator decision (the `need_source` gate) and publication stays a separate
 * approved operation, exactly as `billing:fx:validate` keeps it.
 *
 * WHY A CLI AND NOT AN ENDPOINT. Registering sandbox epochs is an
 * out-of-band operational decision taken by a named human with a stated
 * reason — like `billing:activate`, `billing:grant` and
 * `billing:provision:live`, it deliberately has no HTTP route and no operator
 * token; the database connection is the whole trust boundary.
 *
 * WHAT IT NEVER DOES
 *  - never calls Paystack or any provider: no transport, no credential and no
 *    provider import — the four sandbox plans already exist in the dashboard
 *    and their codes arrive verbatim inside the evidence;
 *  - never creates, updates or deletes a provider plan;
 *  - never publishes or approves an FX rate and never bypasses the
 *    approved-source gate;
 *  - never confirms a payment, activates a subscription or grants execution:
 *    a registered epoch makes the four combinations selectable by checkout
 *    and nothing else (`grantsExecution` / `paymentConfirmed` stay false);
 *  - never runs in a live domain: the mode gate refuses before the first
 *    connection, and no argument can change it.
 *
 * Exit codes: 0 on a clean dry run or a registered batch, 1 on a typed refusal
 * (nothing was written), 2 on a usage or configuration error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@veltrixeye/core';
import {
  BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
  BillingPlanProvisioningService,
  isBillingFxError,
  isBillingProviderPlanError,
  isBillingProvisioningError,
  providerIntervalForBillingInterval,
  type BillingProviderPlan,
  type ValidatedSandboxEpochRegistration,
  type ValidatedSandboxProvisioningBatch,
} from '@veltrixeye/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = [
  'Usage:',
  '  npm run billing:provision:sandbox -- --fx-rate-version <uuid> --by <operator-id> --reason <text> \\',
  '    --evidence <json> [--apply]',
  '',
  'Provisions the four sandbox provider-plan epochs (Pro/Elite × monthly/annual) from ONE',
  'already-published FX rate version and the four assembled Step 4 evidence entries, passed',
  'as one JSON array exactly as docs/billing.md → Sandbox plan provisioning (Step 4)',
  'specifies. The codes and amounts are operator observations; nothing is invented here.',
  '',
  'DRY RUN IS THE DEFAULT: without --apply the whole batch is validated against the durable',
  'FX authority and nothing is written — no epoch, no audit event. --apply registers the',
  'four epochs together with ONE transactional billing.provider_plans_registered audit event',
  'in a single transaction (rolled back together on any refusal or conflict).',
  '',
  'Requires PAYSTACK_MODE exactly "test" (live mode is refused before any connection) and',
  'DATABASE_URL. Never publishes or approves an FX rate, never calls a provider, never',
  'confirms a payment and never grants execution.',
  '',
  'Exit codes: 0 on a clean dry run or a registered batch; 1 on a typed refusal (nothing',
  'was written); 2 on a usage or configuration error.',
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
  evidence?: string;
  apply: boolean;
  /** Set when `--dry-run` was passed explicitly (the default is a dry run). */
  dryRunExplicit?: boolean;
}

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
    // Every value flag is single-use: a repeated flag is ambiguous input and
    // is refused rather than silently last-one-wins.
    const assign = (current: string | undefined, name: string): void => {
      if (current !== undefined) throw new UsageError(`${name} was supplied twice`);
    };
    switch (flag) {
      case '--fx-rate-version':
        assign(args.fxRateVersion, flag);
        args.fxRateVersion = value;
        break;
      case '--by':
        assign(args.by, flag);
        args.by = value;
        break;
      case '--reason':
        assign(args.reason, flag);
        args.reason = value;
        break;
      case '--evidence':
        assign(args.evidence, flag);
        args.evidence = value;
        break;
      default:
        // Unknown arguments are refused — including any attempt to smuggle in
        // a publish, approve, rate or mode flag this tool must never have.
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/** One plan entry of the printed outcome — identical for dry runs and applies. */
interface PlanOutputEntry {
  slot: string;
  cataloguePlan: string;
  billingInterval: string;
  providerInterval: string;
  providerPlanId: string;
  paymentCurrency: string;
  paymentAmountMinor: string;
  providerPlanReference: string | null;
  epochId: string | null;
  status: string | null;
}

function entryFromRegistration(registration: ValidatedSandboxEpochRegistration): PlanOutputEntry {
  return {
    slot: `${registration.cataloguePlan}-${registration.interval}`,
    cataloguePlan: registration.cataloguePlan,
    billingInterval: registration.interval,
    providerInterval: registration.providerInterval,
    providerPlanId: registration.providerPlanId,
    paymentCurrency: registration.paymentCurrency,
    paymentAmountMinor: registration.paymentAmountMinor.toString(),
    providerPlanReference: registration.evidenceReference,
    epochId: null,
    status: null,
  };
}

function entryFromEpoch(epoch: BillingProviderPlan): PlanOutputEntry {
  return {
    slot: `${epoch.cataloguePlan}-${epoch.interval}`,
    cataloguePlan: epoch.cataloguePlan,
    billingInterval: epoch.interval,
    // The explicit local→provider mapping, through the exported authority —
    // never a silent pass-through of the local word.
    providerInterval: providerIntervalForBillingInterval(epoch.interval),
    providerPlanId: epoch.providerPlanId,
    paymentCurrency: epoch.paymentCurrency,
    paymentAmountMinor: epoch.paymentAmountMinor.toString(),
    providerPlanReference: epoch.providerPlanReference,
    epochId: epoch.id,
    status: epoch.status,
  };
}

/** Stdout is exactly one JSON document; guidance goes to stderr. */
function printOutcome(outcome: {
  dryRun: boolean;
  fxRateVersionId: string;
  registeredAt: string;
  auditAction: string | null;
  plan: PlanOutputEntry[];
}): void {
  console.info(
    JSON.stringify(
      {
        outcome: outcome.dryRun ? 'dry_run' : 'registered',
        dryRun: outcome.dryRun,
        mode: 'test',
        providerCalls: 0,
        fxRateVersionId: outcome.fxRateVersionId,
        registeredAt: outcome.registeredAt,
        auditAction: outcome.auditAction,
        grantsExecution: false,
        paymentConfirmed: false,
        plan: outcome.plan,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.info(USAGE);
      if (error.message !== 'help') console.error(`[billing:provision:sandbox] ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (
    args.fxRateVersion === undefined ||
    args.by === undefined ||
    args.reason === undefined ||
    args.evidence === undefined
  ) {
    console.info(USAGE);
    console.error(
      '[billing:provision:sandbox] --fx-rate-version, --by, --reason and --evidence are all required.',
    );
    return 2;
  }
  if (
    args.fxRateVersion.trim() === '' ||
    args.by.trim() === '' ||
    args.reason.trim() === '' ||
    args.evidence.trim() === ''
  ) {
    console.info(USAGE);
    console.error(
      '[billing:provision:sandbox] blank values are refused: every required flag must carry a real value. ' +
        'Nothing was validated and nothing was written.',
    );
    return 2;
  }

  const databaseUrl = env('DATABASE_URL');
  if (!databaseUrl) {
    console.error(
      '[billing:provision:sandbox] DATABASE_URL is not set.\n' +
        '        Provide it in the environment, or run `npm run setup` to create a local .env.\n' +
        '        See docs/environment.md.',
    );
    return 2;
  }

  // The configured provider domain, validated fail-closed exactly like the
  // API's PAYSTACK_MODE. SANDBOX PROVISIONING REQUIRES an explicit `test`:
  // live configuration — and every other unreadable value — is refused before
  // the CLI connects to the database. The mode is a gate, never a switch.
  const modeRaw = env('PAYSTACK_MODE');
  if (modeRaw !== 'test') {
    console.error(
      `[billing:provision:sandbox] PAYSTACK_MODE must be exactly "test" to provision sandbox plans ` +
        `(got ${modeRaw === undefined ? 'nothing' : `"${modeRaw}"`}).\n` +
        '        This tool registers SANDBOX (test-domain) provider-plan epochs only. A live-mode\n' +
        '        deployment — or any value other than the explicit pin "test" — is refused outright:\n' +
        '        the mode is never inferred, defaulted or silently switched to make a run succeed.',
    );
    return 2;
  }

  let evidence: unknown;
  try {
    evidence = JSON.parse(args.evidence);
  } catch (error) {
    console.error(
      '[billing:provision:sandbox] --evidence is not valid JSON (a JSON array of the four Step 4 ' +
        `evidence entries is expected): ${error instanceof Error ? error.message : String(error)}\n` +
        '        Nothing was validated and nothing was written.',
    );
    return 2;
  }

  const pool = createPool({ databaseUrl });
  try {
    // Pinned literal: the gate above already refused anything that is not the
    // sandbox domain, and no argument can influence the service's mode.
    const service = new BillingPlanProvisioningService({ db: pool, mode: 'test' });
    const request = {
      fxRateVersionId: args.fxRateVersion,
      evidence,
      audit: { operatorId: args.by, reason: args.reason },
    };

    if (!args.apply) {
      // The safe default: the full authoritative preparation, zero writes.
      const batch: ValidatedSandboxProvisioningBatch =
        await service.validateSandboxPlanEpochs(request);
      printOutcome({
        dryRun: true,
        fxRateVersionId: batch.fxVersion.id,
        registeredAt: batch.registeredAt.toISOString(),
        auditAction: null,
        plan: batch.registrations.map(entryFromRegistration),
      });
      console.error(
        '\nDry run: the complete four-entry batch validated against the selected FX version.\n' +
          '        Nothing was written — no epoch and no audit event.\n' +
          '        Re-run with --apply to register the four epochs plus their audit event together.',
      );
      return 0;
    }

    const epochs = await service.registerSandboxPlanEpochs(request);
    printOutcome({
      dryRun: false,
      fxRateVersionId: epochs[0]!.fxRateVersionId,
      registeredAt: epochs[0]!.validFrom.toISOString(),
      auditAction: BILLING_PROVIDER_PLAN_REGISTRATION_AUDIT_ACTION,
      plan: epochs.map(entryFromEpoch),
    });
    return 0;
  } catch (error) {
    if (isBillingProvisioningError(error)) {
      console.error(
        `[billing:provision:sandbox] refused (${error.reason}): ${error.message}\n` +
          '        Nothing was written: no epoch, no audit event and no other row changed.',
      );
      return 1;
    }
    if (isBillingFxError(error)) {
      console.error(
        `[billing:provision:sandbox] refused (${error.reason}): ${error.message}\n` +
          '        Nothing was written: no epoch, no audit event and no other row changed.',
      );
      return 1;
    }
    if (isBillingProviderPlanError(error)) {
      console.error(
        `[billing:provision:sandbox] refused (${error.reason}): ${error.message}\n` +
          '        Nothing was written: the whole four-epoch batch rolls back together.',
      );
      return 1;
    }
    console.error('[billing:provision:sandbox] failed:', error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
