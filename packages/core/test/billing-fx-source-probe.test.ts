/**
 * `billing:fx:source:probe` — the read-only live probe of the approved publisher.
 *
 * Pins why the probe exists and what it cannot do:
 *  - it reads the pinned publisher URL exactly once and prints what it found, so
 *    an operator has EVIDENCE before enabling a scheduled check;
 *  - it records NOTHING (no database, no write path) and publishes NOTHING: the
 *    decision it prints is always `need_source`;
 *  - publication and approval flags are refused as usage errors, and a run
 *    without `--dry-run` is refused: there is no other mode;
 *  - a publisher that cannot be read, or a page that cannot be parsed, exits
 *    non-zero and says so — it never infers a rate from an unrecognised page.
 *
 * The reader is injected here, so this suite opens no socket and depends on no
 * live site.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FX_SOURCE_BANK_OF_GHANA,
  FX_SOURCE_BANK_OF_GHANA_URL,
} from '@veltrixeye/contracts';
import { probeFxSource, PROBE_PROHIBITED_FLAGS, type ProbeDeps } from '../../../scripts/billing/fx-source-probe.js';
import type { FxSourceRetriever, FxSourceRetrieval } from '../src/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXED_NOW = new Date('2026-10-15T09:30:00.000Z');

const retrieved: FxSourceRetrieval = {
  outcome: 'retrieved',
  sourceId: FX_SOURCE_BANK_OF_GHANA,
  sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
  retrievedAt: FIXED_NOW,
  bodyDigest: 'a'.repeat(64),
  rowDigest: 'b'.repeat(64),
  row: {
    publishedOnText: '14 Oct 2026',
    currencyText: 'US Dollar',
    pairText: 'USDGHS',
    buyingText: '11.6692',
    sellingText: '11.6808',
    midText: '11.6750',
  },
};

function stubReader(result: FxSourceRetrieval): ProbeDeps & { calls: () => number } {
  let calls = 0;
  const source: FxSourceRetriever = {
    sourceId: FX_SOURCE_BANK_OF_GHANA,
    sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
    async retrieve() {
      calls += 1;
      return result;
    },
  };
  return { source, calls: () => calls };
}

describe('the probe reports what the publisher published', () => {
  test('a readable, consistent page exits 0 and prints the published figures', async () => {
    const deps = stubReader(retrieved);
    const result = await probeFxSource(['--dry-run'], deps);

    assert.equal(result.status, 0, result.stdout.join('\n'));
    assert.equal(deps.calls(), 1, 'exactly one read');
    const output = result.stdout.join('\n');
    assert.match(output, /outcome: retrieved/);
    assert.match(output, /publishedOn: 14 Oct 2026/);
    assert.match(output, /buying:\s+11\.6692/);
    assert.match(output, /selling:\s+11\.6808/);
    assert.match(output, /mid:\s+11\.6750/);
    assert.match(output, /validated: yes/);
    assert.match(output, /decision: need_source/);
    assert.match(output, /pricingPolicySatisfiable: false/);
    assert.equal(result.stderr.length, 0);
  });

  test('an unreadable publisher exits 1 and records nothing', async () => {
    const result = await probeFxSource(['--dry-run'], {
      source: {
        sourceId: FX_SOURCE_BANK_OF_GHANA,
        sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
        async retrieve(): Promise<FxSourceRetrieval> {
          return {
            outcome: 'unavailable',
            sourceId: FX_SOURCE_BANK_OF_GHANA,
            sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
            retrievedAt: FIXED_NOW,
            status: null,
            reason: 'network',
            detail: 'The source could not be reached.',
            bodyDigest: null,
          };
        },
      },
    });

    assert.equal(result.status, 1);
    const output = result.stdout.join('\n');
    assert.match(output, /outcome: unavailable/);
    assert.match(output, /reason:\s+network/);
    assert.match(output, /Nothing was recorded and nothing was published/);
    assert.match(output, /decision: need_source/);
  });

  test('an unrecognised page exits 1 rather than inferring a rate', async () => {
    const result = await probeFxSource(['--dry-run'], stubReader({
      outcome: 'unparseable',
      sourceId: FX_SOURCE_BANK_OF_GHANA,
      sourceUrl: FX_SOURCE_BANK_OF_GHANA_URL,
      retrievedAt: FIXED_NOW,
      status: 200,
      reason: 'no_usd_row',
      detail: 'The published page carried no "USDGHS" row.',
      bodyDigest: 'c'.repeat(64),
    }));
    assert.equal(result.status, 1);
    assert.match(result.stdout.join('\n'), /no_usd_row/);
  });

  test('a published row that does not validate exits 1 and explains why', async () => {
    const incoherent = {
      ...retrieved,
      row: { ...retrieved.row, buyingText: '11.9000' },
    } as FxSourceRetrieval;
    const result = await probeFxSource(['--dry-run'], stubReader(incoherent));
    assert.equal(result.status, 1);
    const output = result.stdout.join('\n');
    assert.match(output, /validated: no/);
    assert.match(output, /\[incoherent\]/);
    assert.match(output, /did not validate/);
    assert.match(output, /decision: need_source/);
  });
});

describe('the probe is read-only by construction', () => {
  test('publication and approval flags are refused, and nothing is fetched to refuse them', async () => {
    for (const flag of PROBE_PROHIBITED_FLAGS) {
      const deps = stubReader(retrieved);
      const result = await probeFxSource(['--dry-run', flag], deps);
      assert.equal(result.status, 2, flag);
      assert.equal(deps.calls(), 0, `${flag} must be refused before any read`);
      assert.match(result.stderr.join('\n'), /read-only/);
    }
  });

  test('a run without --dry-run is refused as a usage error', async () => {
    const deps = stubReader(retrieved);
    const result = await probeFxSource([], deps);
    assert.equal(result.status, 2);
    assert.equal(deps.calls(), 0);
    assert.match(result.stderr.join('\n'), /--dry-run is required/);
  });

  test('unknown arguments are refused', async () => {
    const deps = stubReader(retrieved);
    const result = await probeFxSource(['--dry-run', '--rate', '12.5'], deps);
    assert.equal(result.status, 2);
    assert.equal(deps.calls(), 0);
    assert.match(result.stderr.join('\n'), /Unknown argument/);
  });

  test('the CLI holds no database, no publication and no pricing path', () => {
    const source = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'billing', 'fx-source-probe.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /createPool|DATABASE_URL|billing_fx_source_observations/, 'no database');
    assert.doesNotMatch(source, /BillingFxRateVersionStore|\.publish\s*\(/, 'no publication path');
    assert.doesNotMatch(source, /process\.env/, 'no environment access');
    assert.doesNotMatch(source, /catalogue|Paystack|provider_plans|epoch/i, 'no pricing or provider path');
    // The probe's own decisions are reported, never taken: it prints the same
    // boundary the observation layer applies.
    assert.match(source, /need_source/);
  });
});
