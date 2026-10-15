#!/usr/bin/env -S npx tsx
/**
 * `npm run billing:fx:source:probe -- --dry-run`
 *
 * A READ-ONLY live probe of the approved FX publisher — the Bank of Ghana's
 * published daily interbank FX rates page. It reads the page ONCE, extracts the
 * USD→GHS row, validates it exactly as the observation layer would, prints what
 * it found, and writes nothing.
 *
 * WHY THIS EXISTS. The publisher's page shape cannot be verified from a
 * restricted build environment, and a schedule that silently records nothing is
 * worse than no schedule at all. This is the operator's evidence path: run it
 * from a machine that can reach the publisher, read the outcome, and only then
 * decide whether to enable the scheduled observation check. It is the only place
 * in the repository that performs a live outbound call outside the API process,
 * and it is deliberately the narrowest one.
 *
 * WHAT IT CANNOT DO — by construction, and pinned by tests:
 *  - No database. It imports no pool, reads no `DATABASE_URL` and writes no row:
 *    the observation is PRINTED, never recorded.
 *  - No publication. It holds no FX rate version store, and `--publish`,
 *    `--approve`, `--apply`, `--register`, `--live` and friends are refused as
 *    usage errors (not ignored). It can never bypass the `need_source`
 *    source-approval boundary; the decision it prints is ALWAYS `need_source`.
 *  - No pricing. It reads no price, no catalogue entry, no provider plan and no
 *    pricing epoch, and prices nothing.
 *  - No environment. It reads no setting: the publisher URL is a constant and the
 *    timeout is code, so a probe cannot be pointed at another host, and no
 *    deployment can change what it reads.
 *
 * Exit codes: 0 the published row was retrieved and validated (the decision is
 * still `need_source`); 1 the publisher could not be read or its row did not
 * validate (nothing was written, because nothing is ever written); 2 usage error.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FX_SOURCE_BANK_OF_GHANA } from '@veltrixeye/contracts';
import {
  FX_SOURCE_DECISION_REASON,
  FX_SOURCE_OBSERVATION_POLICY,
  analyzeFxSourceObservations,
  validateFxSourceRow,
  type FxSourceRetrieval,
  type FxSourceRetriever,
} from '@veltrixeye/core';
import { createBankOfGhanaUsdGhsSource } from '@veltrixeye/provider-bank-of-ghana';

/** Probe timeout (ms). A constant: no setting widens or shortens it. */
export const PROBE_TIMEOUT_MS = 15_000;

/** Flags that would turn a read-only probe into something else. */
export const PROBE_PROHIBITED_FLAGS: readonly string[] = Object.freeze([
  '--publish',
  '--published',
  '--approve',
  '--approved',
  '--approval',
  '--apply',
  '--confirm',
  '--write',
  '--register',
  '--live',
]);

export interface ProbeOutput {
  readonly status: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export interface ProbeDeps {
  /** The reader to probe. Defaults to the pinned Bank of Ghana reader. */
  readonly source?: FxSourceRetriever;
}

function usage(message: string, stdout: readonly string[] = []): ProbeOutput {
  return { status: 2, stdout: [...stdout], stderr: [message] };
}

/**
 * Run the probe with an injected reader (tests inject a stub, so the suite never
 * opens a socket) and return its exit status plus printed lines instead of
 * calling `process.exit`.
 */
export async function probeFxSource(
  argv: readonly string[],
  deps: ProbeDeps = {},
): Promise<ProbeOutput> {
  const stdout: string[] = [];

  const prohibited = argv.filter((arg) => PROBE_PROHIBITED_FLAGS.includes(arg));
  if (prohibited.length > 0) {
    return usage(
      `billing:fx:source:probe is read-only: ${prohibited.join(', ')} cannot be requested. It observes ` +
        'a published rate and never publishes or approves one; the decision stays need_source.',
    );
  }

  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    return usage(`Unknown argument(s): ${unknown.join(', ')}. Usage: --dry-run`);
  }
  if (!argv.includes('--dry-run')) {
    return usage(
      '--dry-run is required: this probe is read-only and has no other mode, so it must be requested explicitly.',
    );
  }

  const source: FxSourceRetriever =
    deps.source ?? createBankOfGhanaUsdGhsSource({ timeoutMs: PROBE_TIMEOUT_MS });
  const retrieval = (await source.retrieve()) as FxSourceRetrieval;

  stdout.push(`source:  ${source.sourceId}`);
  stdout.push(`url:     ${source.sourceUrl}`);
  stdout.push(`readAt:  ${retrieval.retrievedAt.toISOString()}`);
  stdout.push(`outcome: ${retrieval.outcome}`);

  if (retrieval.outcome !== 'retrieved') {
    stdout.push(`reason:  ${retrieval.reason}`);
    stdout.push(`detail:  ${retrieval.detail}`);
    stdout.push(`bodySha256: ${retrieval.bodyDigest ?? '(no body was read)'}`);
    stdout.push('');
    stdout.push('Nothing was recorded and nothing was published: the publisher could not be read, or');
    stdout.push('its page did not contain exactly one unambiguous USD→GHS row. This is the evidence an');
    stdout.push('operator needs before enabling the scheduled observation check.');
    stdout.push('decision: need_source');
    stdout.push(`reason:   ${FX_SOURCE_DECISION_REASON}`);
    return { status: 1, stdout, stderr: [] };
  }

  stdout.push(`bodySha256:  ${retrieval.bodyDigest}`);
  stdout.push(`rowSha256:   ${retrieval.rowDigest}`);
  stdout.push(`publishedOn: ${retrieval.row.publishedOnText}`);
  stdout.push(`currency:    ${retrieval.row.currencyText}`);
  stdout.push(`pair:        ${retrieval.row.pairText}`);
  stdout.push(`buying:      ${retrieval.row.buyingText}`);
  stdout.push(`selling:     ${retrieval.row.sellingText}`);
  stdout.push(`mid:         ${retrieval.row.midText}`);

  const validation = validateFxSourceRow(retrieval, {
    policy: FX_SOURCE_OBSERVATION_POLICY,
    retrievedBy: 'probe',
  });

  stdout.push('');
  stdout.push(`validated: ${validation.valid ? 'yes' : 'no'}`);
  for (const issue of validation.issues) {
    stdout.push(`  issue [${issue.code}] ${issue.field}: ${issue.message}`);
  }

  if (!validation.valid || validation.observation === null) {
    stdout.push('');
    stdout.push('Nothing was recorded and nothing was published: the published row did not validate.');
    stdout.push('decision: need_source');
    stdout.push(`reason:   ${FX_SOURCE_DECISION_REASON}`);
    return { status: 1, stdout, stderr: [] };
  }

  const observation = validation.observation;
  const report = analyzeFxSourceObservations({
    sourceId: FX_SOURCE_BANK_OF_GHANA,
    observations: [observation],
    asOf: retrieval.retrievedAt,
  });

  stdout.push(`observationKey: ${observation.observationKey}`);
  stdout.push(
    `midScaled:      ${observation.midRateScaled.toString()} @ scale ${observation.rateScale}`,
  );
  stdout.push(
    `staleness:      ${report.state} (age ${report.ageSeconds}s; warning at ${report.warningAfterSeconds}s, stale at ${report.staleAfterSeconds}s)`,
  );
  stdout.push(`pricingPolicySatisfiable: ${report.pricingPolicySatisfiable}`);
  stdout.push(`pricingPolicyNote: ${report.pricingPolicyReason}`);
  stdout.push('');
  stdout.push('Validated means the published row is internally consistent and was read from the approved');
  stdout.push('URL. It is NOT an approval and NOT a rate version: this probe opens no database, records');
  stdout.push('nothing, publishes nothing, and no payment can be priced from this output.');
  stdout.push('decision: need_source');
  stdout.push(`reason:   ${FX_SOURCE_DECISION_REASON}`);

  return { status: 0, stdout, stderr: [] };
}

/** True only when this file is the process entry point (never on import). */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return path.resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  const result = await probeFxSource(process.argv.slice(2));
  for (const line of result.stdout) console.info(line);
  for (const line of result.stderr) console.error(line);
  process.exit(result.status);
}
