#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:fx:publish` — the OPERATOR FX PUBLICATION CLI, DRY RUN BY
 * DEFAULT.
 *
 *   tsx scripts/billing/fx-publish.ts \
 *     --rate <decimal> --reference <text> --reason <text> \
 *     --by <executor-id> --approver <id> --approver <id> \
 *     --captured-at <iso8601-with-zone> [--effective-from <iso>] \
 *     [--epoch-registration-planned --registrant <id>] \
 *     [--drift-justification <text>] [--apply]
 *
 * WHAT IT IS. A THIN wrapper over `FxPublicationService`
 * (packages/core/src/billing/fx-publication.ts): it parses arguments, checks the
 * configuration, connects to the database, calls the service and prints the
 * outcome. It holds no authority of its own — every currency, precision,
 * timestamp-ordering, freshness, plausibility, drift, corroboration,
 * downstream-intent and two-person rule is enforced by the service.
 *
 *   - default (no flag) or `--dry-run` → the read-only assessment: the newest
 *     published version is read, all eight pre-publication checks run, and
 *     NOTHING is written — no version, no audit event, no other row.
 *   - `--apply` → the same checks, then ONE FX version row plus ONE
 *     `billing.fx_rate_published` audit event in a single transaction.
 *
 * WHY A CLI AND NOT AN ENDPOINT. Publishing a rate is an out-of-band
 * operational decision taken by a named human with a stated reason and two
 * distinct recorded approvers — like `billing:activate`, `billing:grant` and
 * `billing:provision:live`, it deliberately has no HTTP route and no operator
 * token; the database connection is the whole trust boundary.
 *
 * AUTHORIZATION IS EVIDENCE, NOT A ROLE. This build has NO application role
 * model, so this CLI cannot verify that an approver is entitled to approve —
 * it verifies only that two DIFFERENT named approvers, neither of whom is the
 * executor, were recorded, and it fails closed when that evidence is absent or
 * malformed. The remaining control is procedural: a documented roster of who
 * may hold publication-capable credentials, and a written approval record per
 * publication. Both are stated in docs/billing.md → FX publication policy, and
 * neither is enforced by this code.
 *
 * WHAT IT NEVER DOES
 *  - never fetches a rate: no network call, no provider import — the rate is
 *    operator-supplied evidence;
 *  - never publishes on behalf of the Bank of Ghana observation layer, and
 *    never reads an observation: observing a published figure is not approving
 *    it (see `./fx-source-probe.ts`, `billing:fx:source:probe`);
 *  - never creates, updates, retires or rotates a provider-plan epoch and never
 *    touches a Paystack plan or identifier: a customer-facing price changes
 *    only through a separately approved epoch rotation
 *    (`billing:provision:sandbox` / `billing:provision:live`);
 *  - never confirms a payment, activates a subscription or grants execution;
 *  - never updates or deletes an FX version: corrections are FORWARD-ONLY — a
 *    corrected rate is a new publication with a later `effective_from`;
 *  - never writes to a production, remote or unverified database: `--apply` is
 *    refused BEFORE the pool exists unless `DATABASE_URL` resolves to a
 *    verified local loopback target (the shared guard in
 *    `./local-db-guard.ts`). Dry runs are read-only and stay available.
 *
 * Exit codes: 0 on a clean dry run or a published version, 1 on a typed refusal
 * (nothing was written), 2 on a usage or configuration error.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@veltrixeye/core';
import {
  FX_PUBLICATION_AUDIT_ACTION,
  FX_PUBLICATION_CHECK_NAMES,
  FX_PUBLICATION_POLICY_VERSION,
  FxPublicationService,
  isFxPublicationError,
  type FxPublicationAssessment,
  type FxPublicationResult,
} from '@veltrixeye/core';
import { localDatabaseTargetRejection } from './local-db-guard.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT_NAME = 'billing:fx:publish';

const USAGE = [
  'Usage:',
  `  npm run ${SCRIPT_NAME} -- --rate <decimal> --reference <text> --reason <text> \\`,
  '    --by <executor-id> --approver <id> --approver <id> --captured-at <iso8601> [options]',
  '',
  'Validates — and with --apply publishes — ONE operator-approved USD→GHS rate version.',
  'Dry run by default: without --apply nothing is written at all.',
  '',
  'Required:',
  '  --rate <decimal>          Exact decimal GHS per 1 USD, e.g. 12.500000 (no exponent/sign/separator).',
  '  --reference <text>        Corroborating bulletin/document/ticket identifier. NOT a URL.',
  '  --reason <text>           Why this rate is being published (>= 10 characters).',
  '  --by <id>                 The named operator executing this publication.',
  '  --approver <id>           A named approver. Give it TWICE, with two DIFFERENT names.',
  '  --captured-at <iso8601>   The adoption/approval instant, WITH a timezone designator.',
  '                            This is when the rate was ADOPTED — never the publisher’s bulletin',
  '                            time, and never back-dated.',
  '',
  'Options:',
  '  --effective-from <iso8601>      When the rate becomes authoritative. Defaults to --captured-at.',
  '  --epoch-registration-planned    State that provider-plan epochs will be registered against it.',
  '  --registrant <id>               Who will register them (required with the flag above).',
  '  --drift-justification <text>    Required when the move exceeds the review threshold.',
  '  --apply                         Publish. Without it this is a read-only dry run.',
  '  --help                          Print this message.',
  '',
  'The 900-second freshness bound is enforced here: `captured-at` must be within 15 minutes of the',
  'publication instant, because the version must still be able to price a NEW chargeable epoch.',
  'Publishing a rate never changes a customer-facing price: that requires a separately approved',
  'epoch rotation.',
].join('\n');

class UsageError extends Error {}

interface Args {
  rate?: string;
  reference?: string;
  reason?: string;
  by?: string;
  approvers: string[];
  capturedAt?: string;
  effectiveFrom?: string;
  epochRegistrationPlanned: boolean;
  registrant?: string;
  driftJustification?: string;
  apply: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { approvers: [], epochRegistrationPlanned: false, apply: false };
  const assign = (current: string | undefined, flag: string): void => {
    if (current !== undefined) throw new UsageError(`--${flag} may only be given once.`);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    const take = (name: string): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`--${name} requires a value.`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case '--help':
      case '-h':
        throw new UsageError('help');
      case '--rate':
        assign(args.rate, 'rate');
        args.rate = take('rate');
        break;
      case '--reference':
        assign(args.reference, 'reference');
        args.reference = take('reference');
        break;
      case '--reason':
        assign(args.reason, 'reason');
        args.reason = take('reason');
        break;
      case '--by':
        assign(args.by, 'by');
        args.by = take('by');
        break;
      case '--approver':
        args.approvers.push(take('approver'));
        break;
      case '--captured-at':
        assign(args.capturedAt, 'captured-at');
        args.capturedAt = take('captured-at');
        break;
      case '--effective-from':
        assign(args.effectiveFrom, 'effective-from');
        args.effectiveFrom = take('effective-from');
        break;
      case '--epoch-registration-planned':
        args.epochRegistrationPlanned = true;
        break;
      case '--registrant':
        assign(args.registrant, 'registrant');
        args.registrant = take('registrant');
        break;
      case '--drift-justification':
        assign(args.driftJustification, 'drift-justification');
        args.driftJustification = take('drift-justification');
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        if (args.apply) throw new UsageError('--apply and --dry-run are mutually exclusive.');
        break;
      default:
        // Unknown arguments are refused, including any attempt to smuggle in a
        // publication shortcut this CLI does not have.
        throw new UsageError(`Unknown argument "${flag}".`);
    }
  }
  return args;
}

/** The evidence object the service validates. Assembled HERE, never invented. */
function publicationEvidence(args: Args): Record<string, unknown> {
  return {
    executorId: args.by,
    approvers: args.approvers,
    reason: args.reason,
    sourceReference: args.reference,
    rate: args.rate,
    capturedAt: args.capturedAt,
    ...(args.effectiveFrom !== undefined ? { effectiveFrom: args.effectiveFrom } : {}),
    ...(args.driftJustification !== undefined ? { driftJustification: args.driftJustification } : {}),
    downstream: {
      epochRegistrationPlanned: args.epochRegistrationPlanned,
      ...(args.registrant !== undefined ? { registrant: args.registrant } : {}),
    },
  };
}

function readEnvValue(key: string): string {
  const file = path.join(REPO_ROOT, '.env');
  try {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match?.[1] !== key) continue;
      return (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .env is not an error: the environment may carry everything.
  }
  return '';
}

function env(key: string): string {
  return process.env[key] ?? readEnvValue(key);
}

function printAssessment(assessment: FxPublicationAssessment, label: string): void {
  console.info(`[${SCRIPT_NAME}] ${label}`);
  console.info(`[${SCRIPT_NAME}] policy ${FX_PUBLICATION_POLICY_VERSION} · audit action ${FX_PUBLICATION_AUDIT_ACTION}`);
  for (const check of assessment.checks) {
    console.info(`[${SCRIPT_NAME}]   ${check.status === 'pass' ? 'PASS' : 'FAIL'}  ${check.name}`);
  }
  for (const issue of assessment.issues) {
    console.error(`[${SCRIPT_NAME}]   - [${issue.check}] ${issue.field}: ${issue.message}`);
  }
  const candidate = assessment.candidate;
  if (candidate !== null) {
    console.info(
      `[${SCRIPT_NAME}]   rate ${candidate.rateDecimal} GHS/USD ` +
        `(scaled ${candidate.fxRateScaled}@${candidate.fxRateScale})`,
    );
    console.info(`[${SCRIPT_NAME}]   captured_at  ${candidate.capturedAt.toISOString()}`);
    console.info(`[${SCRIPT_NAME}]   effective_from ${candidate.effectiveFrom.toISOString()}`);
    console.info(`[${SCRIPT_NAME}]   executor ${candidate.executorId} · approvers ${candidate.approvers.join(', ')}`);
    console.info(
      `[${SCRIPT_NAME}]   drift ${
        candidate.driftBasisPoints === null ? 'n/a (first publication)' : `${candidate.driftBasisPoints} bp`
      }`,
    );
  }
  for (const limitation of assessment.limitations) {
    console.info(`[${SCRIPT_NAME}]   limitation: ${limitation}`);
  }
  if (FX_PUBLICATION_CHECK_NAMES.length !== assessment.checks.length) {
    console.info(`[${SCRIPT_NAME}]   (check count changed: ${assessment.checks.length})`);
  }
}

function printResult(result: FxPublicationResult): void {
  console.info(`[${SCRIPT_NAME}] published FX rate version ${result.version.id}`);
  console.info(
    `[${SCRIPT_NAME}]   rate ${result.version.fxRateScaled}@${result.version.fxRateScale} ` +
      `${result.version.baseCurrency}→${result.version.quoteCurrency}`,
  );
  console.info(`[${SCRIPT_NAME}]   source ${result.version.source} · reference ${result.version.sourceReference}`);
  console.info(`[${SCRIPT_NAME}]   created_by ${result.version.createdBy}`);
  console.info(`[${SCRIPT_NAME}]   captured_at ${result.version.capturedAt.toISOString()}`);
  console.info(`[${SCRIPT_NAME}]   effective_from ${result.version.effectiveFrom.toISOString()}`);
  console.info(`[${SCRIPT_NAME}] one ${FX_PUBLICATION_AUDIT_ACTION} audit event was written with it.`);
  console.info(
    `[${SCRIPT_NAME}] No customer-facing price, provider-plan epoch or Paystack plan changed: publishing a ` +
      'rate never moves a price.',
  );
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.info(USAGE);
      if (error.message !== 'help') console.error(`[${SCRIPT_NAME}] ${error.message}`);
      return 2;
    }
    throw error;
  }

  const databaseUrl = env('DATABASE_URL');

  /*
   * THE WRITE GATE. `--apply` may only write to a verified LOCAL (loopback)
   * database. The check runs BEFORE the pool is constructed, so a refusal
   * cannot have opened a connection, let alone written. The configured value is
   * never echoed: the refusal states the rule, not the target. Dry runs never
   * write, so they are unaffected by this gate.
   */
  if (args.apply) {
    const rejection = localDatabaseTargetRejection(databaseUrl);
    if (rejection !== null) {
      console.error(
        `[${SCRIPT_NAME}] refused: ${rejection}.\n` +
          '        FX publication writes are only permitted against a verified LOCAL (loopback) database.\n' +
          '        Anything else is production or unverified and is refused before a connection exists.\n' +
          '        Nothing was written. A deployed-database publication is a separate, explicitly\n' +
          '        approved change.',
      );
      return 2;
    }
  }

  if (databaseUrl === '') {
    console.error(
      `[${SCRIPT_NAME}] DATABASE_URL is required (the newest published version must be read to ` +
        'sanity-check the rate, its drift and its ordering). Nothing was written.',
    );
    return 2;
  }

  const service = new FxPublicationService(createPool({ databaseUrl }));
  const evidence = publicationEvidence(args);

  try {
    if (!args.apply) {
      const assessment = await service.assess(evidence);
      if (!assessment.valid) {
        printAssessment(assessment, 'dry run REFUSED: the evidence did not pass every check.');
        console.error(`[${SCRIPT_NAME}] Nothing was written: this was a dry run.`);
        return 1;
      }
      printAssessment(assessment, 'dry run: every check passed.');
      console.info(
        `[${SCRIPT_NAME}] Nothing was written. Re-run with --apply to publish this version, or run\n` +
          `[${SCRIPT_NAME}] billing:provision:sandbox within 900 seconds to register epochs against it.`,
      );
      return 0;
    }

    const result = await service.publish(evidence);
    printResult(result);
    return 0;
  } catch (error) {
    if (isFxPublicationError(error)) {
      console.error(`[${SCRIPT_NAME}] refused (${error.reason}): ${error.message}`);
      console.error(`[${SCRIPT_NAME}] Nothing was published.`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`[${SCRIPT_NAME}] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
