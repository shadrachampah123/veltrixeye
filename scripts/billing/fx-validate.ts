#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:fx:validate` — the DRY-RUN-ONLY FX EVIDENCE VALIDATOR.
 *
 *   npm run billing:fx:validate -- --dry-run \
 *     --rate <exact decimal GHS per 1 USD> \
 *     --source <claimed authoritative source> \
 *     --fx-source <db|ops|import|config> \
 *     --source-reference <provenance/reference> \
 *     --base-currency USD --quote-currency GHS \
 *     --captured-at <ISO 8601 with timezone> \
 *     --effective-from <ISO 8601 with timezone> \
 *     --by <operator-id> --reason <text> \
 *     [--as-of <ISO 8601 with timezone>]
 *
 * WHY THIS EXISTS. Publishing an FX rate version is the act that lets a
 * catalogue USD price become a GHS amount a customer is charged. Before any
 * such act can even be considered, an operator needs to know whether the
 * evidence for a candidate rate is complete, exact, fresh and unambiguous.
 * This CLI answers exactly that question — and nothing else. It is a THIN
 * wrapper over `validateFxRateCandidate`
 * (packages/core/src/billing/fx-validation.ts), which in turn delegates to
 * the existing FX authority (`fx-rate-versions.ts`). It holds no authority
 * of its own and creates no competing source of truth.
 *
 * THE DECISION IS ALWAYS `need_source`. No authoritative FX source has been
 * approved in code or policy, so even a fully consistent candidate stays at
 * `need_source` until an operator approval decision is taken and recorded
 * outside this tool. The historical 11.58 GHS/USD rate is not an approved
 * current rate and is not used, defaulted or referenced here.
 *
 * WHAT IT NEVER DOES
 *  - it never publishes an FX rate, approves a source, or writes any row:
 *    `--dry-run` is required, and publication/approval flags (`--publish`,
 *    `--approve`, `--apply`, …) are refused, not ignored;
 *  - it never opens a database connection (it imports no pool), calls an
 *    external service, reads a secret, or modifies a setting — so a dry run
 *    is side-effect free by construction, not by discipline;
 *  - it never alters a customer price or a Paystack plan mapping.
 *
 * KNOWN LIMITATION. A dry run performs no database read, so it cannot detect
 * a conflict with an already-published version effective at the same
 * instant; the durable authority's resolver must re-check that ambiguity
 * before any separately approved publication. This is printed on every run.
 *
 * Exit codes: 0 when the supplied evidence validates (the decision is still
 * `need_source`); 1 on a validation refusal (missing, invalid, stale or
 * prohibited evidence — nothing was written, because nothing is ever
 * written); 2 on a usage error.
 */
import {
  FX_VALIDATION_LIMITATIONS,
  validateFxRateCandidate,
  type FxRateCandidateInput,
} from '@veltrixeye/core';

const USAGE = [
  'Usage:',
  '  npm run billing:fx:validate -- --dry-run --rate <decimal> --source <source> \\',
  '    --fx-source <db|ops|import|config> --source-reference <reference> \\',
  '    --base-currency USD --quote-currency GHS \\',
  '    --captured-at <ISO 8601 with timezone> --effective-from <ISO 8601 with timezone> \\',
  '    --by <operator-id> --reason <text> [--as-of <ISO 8601 with timezone>]',
  '',
  'Validates candidate FX evidence in dry-run mode only. It writes nothing, calls',
  'nothing, publishes nothing and approves nothing: the decision is always',
  'need_source until an authoritative source is separately approved.',
].join('\n');

class UsageError extends Error {}

/** Flags that turn validation into publication/approval: refused, exit 1. */
const PROHIBITED_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  '--publish': 'publish',
  '--publish-rate': 'publishRate',
  '--approve': 'approve',
  '--approved': 'approved',
  '--approval': 'approval',
  '--apply': 'apply',
  '--confirm': 'confirm',
  '--confirmed': 'confirmed',
  '--write': 'write',
  '--register': 'register',
  '--live': 'live',
});

const VALUE_FLAGS: Readonly<Record<string, keyof FxRateCandidateInput | 'asOf'>> = Object.freeze({
  '--rate': 'rate',
  '--source': 'source',
  '--fx-source': 'fxSource',
  '--source-reference': 'sourceReference',
  '--base-currency': 'baseCurrency',
  '--quote-currency': 'quoteCurrency',
  '--captured-at': 'capturedAt',
  '--effective-from': 'effectiveFrom',
  '--by': 'operator',
  '--reason': 'reason',
  '--as-of': 'asOf',
});

interface ParsedArgs {
  candidate: FxRateCandidateInput & Record<string, unknown>;
  asOf?: string;
  dryRun: boolean;
  prohibited: string[];
}

function splitFlag(token: string): [string, string | undefined] {
  const equals = token.indexOf('=');
  if (equals === -1) return [token, undefined];
  return [token.slice(0, equals), token.slice(equals + 1)];
}

/** Minimal, explicit flag parser: no positional arguments, no defaults. */
function parseArgs(argv: string[]): ParsedArgs {
  const candidate: FxRateCandidateInput & Record<string, unknown> = {};
  const prohibited: string[] = [];
  let asOf: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const [flag, inlineValue] = token.startsWith('--') ? splitFlag(token) : [token, undefined];

    if (flag === '--help' || flag === '-h') throw new UsageError('help');
    if (flag === '--dry-run') {
      if (inlineValue !== undefined) throw new UsageError('--dry-run takes no value');
      dryRun = true;
      continue;
    }
    const prohibitedKey = PROHIBITED_FLAGS[flag];
    if (prohibitedKey !== undefined) {
      // Recorded (and any attached value consumed) so the validator's guard
      // reports it as a prohibited publication/approval instruction.
      prohibited.push(prohibitedKey);
      candidate[prohibitedKey] = true;
      if (inlineValue === undefined && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('--')) {
        index += 1;
      }
      continue;
    }
    const field = VALUE_FLAGS[flag];
    if (field === undefined) throw new UsageError(`unknown argument: ${flag}`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    if (field === 'asOf') asOf = value;
    else candidate[field] = value;
  }
  return { candidate, ...(asOf !== undefined ? { asOf } : {}), dryRun, prohibited };
}

function main(): number {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.info(USAGE);
      if (error.message !== 'help') console.error(`[billing:fx:validate] ${error.message}`);
      return error.message === 'help' ? 0 : 2;
    }
    throw error;
  }

  if (!parsed.dryRun) {
    console.info(USAGE);
    console.error(
      '[billing:fx:validate] --dry-run is required: this validator has no write mode, ' +
        'so a run without it is refused before any validation.',
    );
    return 2;
  }

  const result = validateFxRateCandidate(parsed.candidate, {
    ...(parsed.asOf !== undefined ? { asOf: parsed.asOf } : {}),
  });

  console.info(
    JSON.stringify(
      {
        outcome: result.valid ? 'validated' : 'refused',
        decision: result.decision,
        decisionReason: result.decisionReason,
        valid: result.valid,
        dryRun: result.dryRun,
        published: result.published,
        approved: result.approved,
        databaseWrites: result.databaseWrites,
        externalCalls: result.externalCalls,
        evaluatedAt: result.evaluatedAt,
        checks: result.checks,
        issues: result.issues,
        candidate: result.candidate,
        limitations: [...FX_VALIDATION_LIMITATIONS],
      },
      null,
      2,
    ),
  );

  if (!result.valid) {
    console.error(
      `[billing:fx:validate] refused: ${result.issues.map((issue) => `${issue.field}: ${issue.message}`).join(' ')} ` +
        'Nothing was written, published or approved.',
    );
    return 1;
  }
  return 0;
}

process.exit(main());
